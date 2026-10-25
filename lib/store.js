/**
 * 数据层：项目 / 章节 / 审阅 / 注意力 / 提案 / run / 账本 / 设置。
 *
 * 契约见 docs/REBUILD-CONTRACT.md §4、§12（0.5.x 实测兼容）。
 * - 数据目录：~/StoryDesk（可用 STORY_DESK_ROOT 覆盖）
 * - 章节双格式：旧 chapters/NNNN.md（YAML frontmatter，原地写回，未知键不动）
 *            新 chapters/NNNN.txt + chapters/NNNN.meta.json
 * - saveChapter 是唯一正文落盘函数：写前备份 .backups/<n>/<ts>-<hash>.md
 * - 本文件不写死任何测试路径；测试一律传 mkdtemp 根目录。
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { scoreOf } from './attention.js'
import { normalizeProse } from './prose.js'
import { EXPORT_META, bookFilename, buildBookMarkdown, buildBookText, buildDocx, buildEpub, normalizeFormat } from './exporters.js'
import * as bookdb from './bookdb.js'

// ---------------------------------------------------------------- 常量

const FOUR_SOURCES = ['logic', 'attention', 'ai-style', 'reader']
const SEVERITIES = ['blocker', 'major', 'minor', 'suggestion']
const PROPOSAL_KINDS = new Set(['patch-paragraph', 'rewrite-chapter', 'ledger-fix', 'book-fix'])
/** 注意力主类型（与 lib/attention.js / prompts.js 口径一致）。 */
const ATTENTION_TYPES = new Set(['event', 'emotion', 'language', 'mystery', 'relationship'])
const RUN_STATUS = new Set(['idle', 'planning', 'ready', 'running', 'paused', 'done', 'aborted', 'stuck', 'failed'])
const BACKUP_LIMIT = 100

/** 统一时间戳（全库唯一来源；0.5.x 兼容文件里也用它）。 */
function nowIso() {
  return new Date().toISOString()
}

const DIMENSION_BY_SOURCE = {
  logic: '逻辑',
  attention: '注意力',
  'ai-style': 'AI 味',
  reader: '读者',
}

const KIND_FILES = {
  facts: 'facts.json',
  characters: 'characters.json',
  events: 'events.json',
  foreshadow: 'foreshadow.json',
  conflicts: 'conflicts.json',
  locations: 'locations.json',
  highlights: 'highlights.json',
  outlines: 'outlines.json',
  presets: 'presets.json',
}

/** 账本同步状态文件：pending = 正文改动信号；full = 正文写完后的「全书分批同步」计划。 */
const LEDGER_SYNC_FILE = 'ledger-sync.json'
/** 全书同步每批默认章数 / 上限：太小多绕几轮，太大一批塞不进上下文。 */
const FULL_SYNC_BATCH = 6
const FULL_SYNC_BATCH_MAX = 20

/**
 * 默认预设（新建作品时写一份完整预设库，不依赖旧仓库）。
 * 字段说明见 docs/PRESET-TEMPLATE.md：预设只是「写作约定」，改预设不会改正文。
 */
// ---------------------------------------------------------------- 基础工具

/** 数据根：默认 ~/StoryDesk，可用 STORY_DESK_ROOT 覆盖（测试/副本）。 */
export function defaultRoot() {
  const fromEnv = String(process.env.STORY_DESK_ROOT || '').trim()
  return fromEnv ? resolve(fromEnv) : join(homedir(), 'StoryDesk')
}

function fail(message, code = 'invalid', extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function isBlank(value) {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** 去掉 undefined / 函数 / 空对象里无意义的字段（账本与 meta 共用）。 */
function cleanPatch(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => cleanPatch(item, depth + 1))
  if (depth > 6) return value
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (raw === undefined || typeof raw === 'function' || typeof raw === 'symbol') continue
    out[key] = cleanPatch(raw, depth + 1)
  }
  return out
}

/** 章节正文哈希（sha1，与 0.5.x 侧写入的 contentHash 口径一致）。 */
function contentHash(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 12)
}

/** 字数：中日韩字符按字计 + 其他语言按词计（0.5.x 的 words 口径）。 */
function countWords(text) {
  const value = String(text ?? '')
  const cjk = value.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g)
  const rest = value.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
  const words = rest.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)
  return (cjk ? cjk.length : 0) + (words ? words.length : 0)
}

async function readJson(path, fallback = null) {
  try {
    const raw = await readFile(path, 'utf8')
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    if (!text.trim()) return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 原子写 JSON：先写临时文件再 rename，避免半截文件。 */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

async function writeFileAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  await writeFile(tmp, String(text ?? ''), 'utf8')
  await rename(tmp, path)
}

const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function libraryPath(root) {
  return join(root, 'library.json')
}

/** 确保数据根存在（library.json 只在缺失时初始化，绝不覆盖已有数据）。 */
export async function ensureRoot(root = defaultRoot()) {
  const wanted = resolve(root)
  await mkdir(join(wanted, 'projects'), { recursive: true })
  // macOS 的 /var → /private/var 之类软链：统一用 realpath 做后续越界判断的基准。
  const real = await realpath(wanted)
  const lib = libraryPath(real)
  if (!(await exists(lib))) await writeJson(lib, { version: 1, projects: [] })
  return real
}

/**
 * 作品目录解析：
 * - id 必须匹配 PROJECT_ID_RE（挡 ../ 之类）
 * - 目录必须落在 <root>/projects 之下的 realpath 内（挡软链逃逸）
 * - create=false 时不存在直接 not-found
 */
async function pdir(root, projectId, opts = {}) {
  const realRoot = resolve(await ensureRoot(root))
  const id = String(projectId ?? '').trim()
  if (!PROJECT_ID_RE.test(id)) throw fail(`作品 id 不合法：${id || '（空）'}`, 'bad-project-id')
  const dir = join(realRoot, 'projects', id)
  const inside = (candidate) => candidate === realRoot || candidate.startsWith(realRoot + sep)
  if (!inside(resolve(dir))) throw fail('作品目录越界，已拒绝', 'outside-root')
  if (opts.create) {
    await mkdir(dir, { recursive: true })
    const realDir = await realpath(dir)
    if (!inside(realDir)) throw fail('作品目录越界，已拒绝', 'outside-root')
    return dir
  }
  if (!(await exists(dir))) throw fail(`作品不存在：${id}`, 'not-found')
  const realDir = await realpath(dir)
  if (!inside(realDir)) throw fail('作品目录越界，已拒绝', 'outside-root')
  return dir
}

/** 作品数据目录（供宿主层/数据库层复用，不改变内部实现）。 */
export async function projectDir(root = defaultRoot(), projectId) {
  return pdir(root, projectId)
}

function shortId() {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

/** library.json 索引只存最少字段，真正的设定在 project.json。 */
async function updateLibrary(root, project) {
  const real = resolve(await ensureRoot(root))
  const lib = (await readJson(libraryPath(real), null)) || { version: 1, projects: [] }
  const rows = Array.isArray(lib.projects) ? lib.projects : []
  const id = String(project?.id ?? '')
  if (!id) return
  const entry = {
    id,
    name: String(project.title ?? project.name ?? '未命名作品'),
    genre: String(project.genre ?? ''),
    updatedAt: String(project.updatedAt ?? nowIso()),
  }
  const index = rows.findIndex((row) => String(row?.id ?? '') === id)
  if (index >= 0) rows[index] = { ...rows[index], ...entry }
  else rows.push(entry)
  rows.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) || String(a.id).localeCompare(String(b.id)))
  await writeJson(libraryPath(real), { ...lib, version: lib.version ?? 1, projects: rows })
}

/** 作品列表（library.json 为主，project.json 为准；不读章节，保持轻量）。 */
export async function listProjects(root = defaultRoot()) {
  const real = resolve(await ensureRoot(root))
  const lib = (await readJson(libraryPath(real), null)) || { version: 1, projects: [] }
  const rows = Array.isArray(lib.projects) ? lib.projects : []
  const out = []
  for (const row of rows) {
    const id = String(row?.id ?? '')
    if (!PROJECT_ID_RE.test(id)) continue
    const dir = join(real, 'projects', id)
    if (!(await exists(dir))) continue
    const project = (await readJson(join(dir, 'project.json'), null)) || {}
    let chapters = 0
    let words = 0
    try {
      const files = await readdir(join(dir, 'chapters'))
      for (const file of files) {
        const hit = /^(\d{4})\.(md|txt)$/.exec(file)
        if (!hit) continue
        chapters += 1
        const n = Number(hit[1])
        const meta = await readJson(join(dir, 'chapters', `${hit[1]}.meta.json`), null)
        words += Number(meta && meta.words) || 0
        if (!meta && hit[2] === 'md') {
          try {
            words += countWords((await readChapter(real, id, n)).text)
          } catch {
            // 读不到就按 0 计，列表不该因为一章坏文件整体失败
          }
        }
      }
    } catch {
      chapters = 0
    }
    out.push({
      id,
      name: String(project.title ?? project.name ?? row.name ?? '未命名作品'),
      title: String(project.title ?? project.name ?? row.name ?? '未命名作品'),
      genre: String(project.genre ?? row.genre ?? ''),
      pov: String(project.pov ?? ''),
      activePresetId: project.activePresetId ?? null,
      chapters,
      words,
      updatedAt: String(project.updatedAt ?? row.updatedAt ?? ''),
    })
  }
  return out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) || a.id.localeCompare(b.id))
}


export function defaultPresets() {
  const at = nowIso()
  const base = {
    pov: '第三人称限知',
    tense: '过去时',
    language: '中文',
    createdAt: at,
    updatedAt: at,
  }
  return [
    {
      ...base,
      id: 'preset-classic-long',
      name: '标准长篇',
      desc: '稳的通用长篇骨架：三幕推进、每章一个钩子，适合 60–120 章。',
      genre: '通用',
      plannedChapters: 80,
      chapterWords: 3000,
      totalWords: 240000,
      pacing: { openingChapters: 6, escalationEvery: 8, midpointRatio: 0.5, climaxRatio: 0.9 },
      styleRules: [
        '句子长短交错，避免连续同构句',
        '情绪用动作与物件承载，不直说感受',
        '对白带人物声口，不同角色说话方式可区分',
        '每章至少一个具体钩子（问题/悬念/决断），章末留牵引',
        '场景中至少一个可感的物理细节（温度、声音、气味）',
      ],
      taboo: ['套话式总结', '现代网络用语', '直抒情绪', 'Markdown 强调与标题', '连续三段以上纯心理描写'],
      reviewFocus: ['事实与连续性', '注意力四拍（钩子/张力/回报/章末牵引）', '去 AI 味（机器痕迹、套话、节奏单一）', '读者第一反应'],
      characters: {
        protagonist: '目标明确但有一个致命缺陷；前 10 章必须让读者看见这个缺陷的代价',
        antagonist: '压力持续升级，不能只出现一次',
        supporting: '每人一个功能：提供信息 / 制造阻力 / 情感锚点',
      },
      notes: '默认骨架；作者可按题材复制后改写。',
    },
    {
      ...base,
      id: 'preset-suspense-cold',
      name: '冷峻悬疑',
      desc: '短句、低情绪、证据链优先；适合都市/刑侦/心理悬疑。',
      genre: '悬疑',
      plannedChapters: 36,
      chapterWords: 2800,
      totalWords: 100000,
      pov: '第一人称限知',
      tense: '过去时',
      pacing: { openingChapters: 2, escalationEvery: 3, midpointRatio: 0.45, climaxRatio: 0.92 },
      styleRules: [
        '短句为主，少形容词；不解释情绪，只写动作与物件',
        '每个推断必须落到可核验的细节（时间、地点、物证、证词）',
        '信息差是主要张力来源：读者知道多少、角色知道多少，要清楚',
        '对话不超过四轮不加叙述，避免问答式推进',
        '每章结尾留一个未闭合的问题，而不是总结',
      ],
      taboo: ['“不知为何”“心里一紧”等廉价心理描写', '巧合推动关键情节', '凶手视角提前泄露', '比喻堆砌', 'Markdown 语法'],
      reviewFocus: ['证据链是否闭合', '人物动机是否可信', '注意力四拍中的张力与章末牵引', 'AI 味中的套话与解释腔'],
      characters: {
        protagonist: '有职业缺陷（执念/创伤/越界），调查越深代价越大',
        antagonist: '前中期只给痕迹不给脸，动机要在最后一幕才成立',
        supporting: '至少一个不可靠叙述者或信息不完整者',
      },
      notes: '冷峻悬疑的验收标准：删掉任何一段解释，读者能不能自己推出来。',
    },
    {
      ...base,
      id: 'preset-wuxia-historical',
      name: '家国武侠',
      desc: '唐/宋背景的长篇武侠：个人恩仇挂在家国变局上，重视地名与时间线。',
      genre: '武侠',
      plannedChapters: 60,
      chapterWords: 3200,
      totalWords: 190000,
      pov: '第三人称多视角',
      tense: '过去时',
      pacing: { openingChapters: 4, escalationEvery: 6, midpointRatio: 0.5, climaxRatio: 0.88 },
      styleRules: [
        '打斗写「势」与「代价」，不写成招式清单',
        '每场戏至少落到一个具体地名与时间（季节/节气/时辰）',
        '人物称谓符合身份与场合，不同阶层用词不同',
        '历史事件只做背景压力，不替角色做决定',
        '每章结尾推进一个具体处境变化（得到/失去/暴露）',
      ],
      taboo: ['现代口语与网络梗', '穿越式历史解释', '外挂式武功突破', '地图位置自相矛盾', 'Markdown 语法'],
      reviewFocus: ['地理与时间线是否自洽', '人物称谓与身份是否一致', '注意力四拍与战斗节奏', 'AI 味（空泛抒情、排比堆砌）'],
      characters: {
        protagonist: '起点低、有师承牵挂；成长必须伴随失去',
        antagonist: '不是纯恶：有自己的家国逻辑',
        supporting: '至少一位亦敌亦友者，立场随局势变化',
      },
      notes: '世界地图页签用来核对地点坐标与行程速度；账本时间线要能对上战役节点。',
    },
    {
      ...base,
      id: 'preset-literary-real',
      name: '文学现实',
      desc: '生活流、克制叙事；适合家族史、都市情感、成长题材。',
      genre: '现实',
      plannedChapters: 40,
      chapterWords: 2600,
      totalWords: 104000,
      pov: '第一人称限知',
      tense: '过去时',
      pacing: { openingChapters: 3, escalationEvery: 5, midpointRatio: 0.55, climaxRatio: 0.9 },
      styleRules: [
        '不写结论，只写场景与细节，让读者自己得出结论',
        '时间在物件上留下痕迹：用旧物、气味、声音写时间',
        '对话允许断裂与沉默，不必句句推进情节',
        '每个主要人物有一个反复出现的动作习惯',
        '避免“意义”“救赎”“和解”这类总结词',
      ],
      taboo: ['抒情式排比结尾', '金句式总结', '把人物当观点代言人', '网络流行语', 'Markdown 语法'],
      reviewFocus: ['细节是否具体可感', '人物是否像活人（而非功能）', '节奏是否拖沓', 'AI 味（四字套话、对仗排比）'],
      characters: {
        protagonist: '不完美、有回避的问题；成长不必完成',
        antagonist: '常常是处境与时间，而不是某个人',
        supporting: '关系网要有温度：互相亏欠、互相照料',
      },
      notes: '验收标准：任意抽一段，能说出具体的地点、时间、动作，而不是情绪总结。',
    },
    {
      ...base,
      id: 'preset-custom',
      name: '自定义（从模板开始）',
      desc: '空预设：照 docs/PRESET-TEMPLATE.md 的「绝对模板」逐项填写，适合固定自己的写作约定。',
      genre: '',
      plannedChapters: 60,
      chapterWords: 3000,
      totalWords: 180000,
      pacing: { openingChapters: 0, escalationEvery: 0, midpointRatio: 0.5, climaxRatio: 0.9 },
      styleRules: [],
      taboo: [],
      reviewFocus: [],
      characters: { protagonist: '', antagonist: '', supporting: '' },
      notes: '复制后填：先写死禁忌与风格，再写四拍目标，最后写人物功能。',
    },
  ]
}

/** 新建作品。input.presetId 选择预设（缺省/未知则用第一套）；title/genre/style/idea 等可由创建向导带入。 */
export async function createProject(root = defaultRoot(), input = {}) {
  await ensureRoot(root)
  const title = String(input.title ?? input.name ?? '').trim() || '未命名作品'
  const id = `pm${shortId()}`
  const dir = await pdir(root, id, { create: true })
  const presets = defaultPresets()
  const requestedPreset = String(input.presetId ?? '').trim()
  const preset = presets.find((p) => p.id === requestedPreset) || presets[0]
  const chapters = Math.max(0, Number(input.targetChapters) || Number(input.chapters) || 0) || preset.plannedChapters
  const wordsPerChapter = Math.max(0, Number(input.wordsPerChapter) || Number(input.chapterWords) || 0) || preset.chapterWords
  const totalWords = Math.max(0, Number(input.targetWords) || 0) || chapters * wordsPerChapter
  const idea = String(input.idea ?? input.prompt ?? '').trim()
  const at = nowIso()
  const project = {
    id,
    name: title,
    title,
    genre: String(input.genre ?? preset.genre ?? ''),
    style: String(input.style ?? ''),
    logline: String(input.logline ?? idea).trim(),
    description: String(input.description ?? idea).trim(),
    pov: String(input.pov ?? preset.pov ?? ''),
    tense: String(input.tense ?? preset.tense ?? ''),
    language: String(input.language ?? preset.language ?? '中文'),
    targetChapters: chapters,
    wordsPerChapter,
    targetWords: totalWords,
    activePresetId: preset.id,
    schemaVersion: '0.6.0',
    readingPosition: { chapter: 1, offset: 0 },
    createdAt: at,
    updatedAt: at,
  }
  await mkdir(join(dir, 'chapters'), { recursive: true })
  await mkdir(join(dir, '.backups'), { recursive: true })
  await writeJson(join(dir, 'project.json'), project)
  await writeJson(join(dir, 'presets.json'), presets)
  for (const name of ['facts', 'characters', 'events', 'foreshadow', 'conflicts', 'locations']) {
    await writeJson(join(dir, `${name}.json`), [])
  }
  await writeJson(join(dir, 'world.json'), {})
  await writeJson(join(dir, 'attention.json'), [])
  await writeJson(join(dir, 'reviews.json'), [])
  await writeJson(join(dir, 'proposals.json'), [])
  await updateLibrary(root, project)
  return project
}

/** 读取作品设定。 */
export async function getProject(root = defaultRoot(), projectId) {
  const dir = await pdir(root, projectId, { create: false })
  const project = await readJson(join(dir, 'project.json'), null)
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw fail(`作品不存在：${projectId}`, 'not-found')
  }
  return project
}

/** 更新作品设定（未知字段保留）。 */
export async function updateProject(root = defaultRoot(), projectId, patch = {}) {
  const dir = await pdir(root, projectId)
  const project = await getProject(root, projectId)
  const values = cleanPatch(patch)
  const next = { ...project, ...values, updatedAt: nowIso() }
  if (values.title != null && values.name == null) next.name = String(values.title)
  if (patch.title !== undefined) {
    next.name = String(patch.title)
    next.title = String(patch.title)
  } else if (patch.name !== undefined) {
    next.name = String(patch.name)
    if (!next.title) next.title = next.name
  }
  await writeJson(join(dir, 'project.json'), next)
  await updateLibrary(root, next)
  return next
}

/** 写作上下文：作品 + 预设 + 账本 + 注意力 + run + 最近章节。 */
export async function getContext(root = defaultRoot(), projectId) {
  const project = await getProject(root, projectId)
  const ledger = await getLedger(root, projectId)
  const chapters = await listChapters(root, projectId)
  const recent = []
  for (const item of chapters.slice(-3)) {
    try {
      const chapter = await readChapter(root, projectId, item.chapter)
      recent.push({
        chapter: item.chapter,
        title: item.title,
        status: item.status,
        words: item.words,
        summary: chapter.meta.summary ?? '',
        excerpt: chapter.text.slice(-500),
      })
    } catch {
      // 单章读取失败不影响上下文
    }
  }
  return {
    project,
    presets: ledger.presets.length ? ledger.presets : defaultPresets(),
    characters: ledger.characters,
    facts: ledger.facts,
    events: ledger.events,
    foreshadow: ledger.foreshadow,
    conflicts: ledger.conflicts,
    locations: ledger.locations,
    world: ledger.world,
    attention: await getAttention(root, projectId),
    runs: await getRun(root, projectId),
    recent,
  }
}

// ---------------------------------------------------------------- 章节：格式与解析

const KNOWN_META_KEYS = ['id', 'title', 'status', 'summary', 'location', 'storyTime', 'characters']

function chapterNumber(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw fail(`章号非法：${value}`, 'bad-chapter')
  return n
}

function pad4(n) {
  return String(chapterNumber(n)).padStart(4, '0')
}

/** 解析 frontmatter 的一行取值。 */
function parseScalar(raw) {
  const value = raw.trim()
  if (!value) return ''
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** 解析 .md 章节（frontmatter + 正文；未知键放进 meta 以便只读展示）。 */
function parseChapterMd(raw) {
  const text = String(raw ?? '')
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { meta: {}, body: text.replace(/^\r?\n+/, '') }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (!/^[A-Za-z_][\w-]*$/.test(key)) continue
    if (key === 'characters') {
      const parsed = parseScalar(line.slice(index + 1))
      meta.characters = Array.isArray(parsed)
        ? parsed.map(String)
        : String(parsed || '').split(/[、,，]/).map((s) => s.trim()).filter(Boolean)
    } else {
      meta[key] = parseScalar(line.slice(index + 1))
    }
  }
  const body = text.slice(match[0].length).replace(/^\r?\n+/, '')
  return { meta, body }
}

/** frontmatter 取值的序列化（与 0.5.x 保持一致）。 */
function formatFrontmatterValue(key, value) {
  if (key === 'characters') return JSON.stringify(Array.isArray(value) ? value.map(String) : [])
  if (value === null || value === undefined) return JSON.stringify('')
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  return JSON.stringify(String(value))
}

/** 写回 .md：只改已知键，未知行原样保留；正文替换。 */
function serializeChapterMd(previousRaw, meta, body) {
  const known = new Set(KNOWN_META_KEYS)
  let lines = []
  if (previousRaw) {
    const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(previousRaw))
    if (match) lines = match[1].split(/\r?\n/)
  }
  const written = new Set()
  const output = []
  for (const line of lines) {
    const index = line.indexOf(':')
    const key = index > 0 ? line.slice(0, index).trim() : ''
    if (known.has(key)) {
      output.push(`${key}: ${formatFrontmatterValue(key, meta[key])}`)
      written.add(key)
    } else {
      output.push(line)
    }
  }
  for (const key of KNOWN_META_KEYS) {
    if (!written.has(key)) output.push(`${key}: ${formatFrontmatterValue(key, meta[key])}`)
  }
  return `---\n${output.join('\n')}\n---\n\n${body}`
}

/** 定位某章的格式与文件路径（txt 优先；都不存在时默认新建 txt）。 */
async function planChapter(dir, n, opts = {}) {
  const id = pad4(n)
  const chapters = join(dir, 'chapters')
  const txt = join(chapters, `${id}.txt`)
  const md = join(chapters, `${id}.md`)
  const hasTxt = await exists(txt)
  const hasMd = await exists(md)
  let format = opts.format === 'md' || opts.format === 'txt' ? opts.format : hasTxt ? 'txt' : hasMd ? 'md' : 'txt'
  return {
    id,
    format,
    path: format === 'txt' ? txt : md,
    txt,
    md,
    metaPath: join(chapters, `${id}.meta.json`),
    hasTxt,
    hasMd,
  }
}

// ---------------------------------------------------------------- 章节：读

/** 读章节正文与元数据。 */
export async function readChapter(root = defaultRoot(), projectId, n) {
  const chapter = chapterNumber(n)
  const dir = await pdir(root, projectId, { create: false })
  const plan = await planChapter(dir, chapter)
  if (!plan.hasTxt && !plan.hasMd) throw fail(`章节不存在：第 ${chapter} 章`, 'not-found')
  const sidecar = await readJson(plan.metaPath, null)
  const side = sidecar && typeof sidecar === 'object' && !Array.isArray(sidecar) ? sidecar : {}
  if (plan.format === 'md') {
    const raw = await readFile(plan.md, 'utf8')
    const { meta, body } = parseChapterMd(raw)
    const merged = { ...side, ...meta, chapter, contentHash: contentHash(body), words: countWords(body) }
    if (!merged.title) merged.title = `第 ${chapter} 章`
    if (!merged.status) merged.status = 'draft'
    if (!merged.updatedAt) merged.updatedAt = null
    return { chapter, text: body, meta: merged, format: 'md' }
  }
  const text = await readFile(plan.txt, 'utf8')
  const meta = {
    ...side,
    chapter,
    contentHash: contentHash(text),
    words: countWords(text),
    title: side.title || `第 ${chapter} 章`,
    status: side.status || 'draft',
  }
  return { chapter, text, meta, format: 'txt' }
}

/** 列出全部章节（只认 NNNN.md / NNNN.txt；旧 .bak-* 备份会被忽略）。 */
export async function listChapters(root = defaultRoot(), projectId) {
  const dir = await pdir(root, projectId, { create: false })
  const chaptersDir = join(dir, 'chapters')
  let names = []
  try {
    names = await readdir(chaptersDir)
  } catch {
    return []
  }
  const plans = new Map()
  for (const name of names) {
    const match = /^(\d{4})\.(md|txt)$/.exec(name)
    if (!match) continue
    const n = Number(match[1])
    const current = plans.get(n)
    if (!current || match[2] === 'txt') plans.set(n, { chapter: n, format: match[2] })
  }
  const attention = await getAttention(root, projectId)
  const attentionMap = new Map(attention.map((item) => [Number(item.chapter), item]))
  const rows = []
  for (const n of [...plans.keys()].sort((a, b) => a - b)) {
    try {
      const chapter = await readChapter(root, projectId, n)
      const record = attentionMap.get(n)
      rows.push({
        chapter: n,
        title: chapter.meta.title || `第 ${n} 章`,
        words: chapter.meta.words ?? countWords(chapter.text),
        status: chapter.meta.status || 'draft',
        attention: record && record.score !== null && record.score !== undefined ? Number(record.score) : null,
        gate: chapter.meta.gate ?? null,
      })
    } catch {
      // 单章损坏跳过
    }
  }
  return rows
}

/** 备份文件名解析出 savedAt。 */
function savedAtFromTimestamp(stamp) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp)
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : null
}

/** 写前备份旧正文（.backups/<n>/<ts>-<hash>.md，保留最近 100 份）。 */
async function backupChapterBody(dir, chapter, body) {
  const sub = join(dir, '.backups', pad4(chapter))
  await mkdir(sub, { recursive: true })
  const stamp = nowIso().replace(/[:.]/g, '-')
  const hash = contentHash(body)
  const file = join(sub, `${stamp}-${hash}.md`)
  if (await exists(file)) return file
  await writeFileAtomic(file, String(body))
  try {
    const names = (await readdir(sub)).filter((name) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]+\.md$/.test(name))
    names.sort()
    for (const old of names.slice(0, Math.max(0, names.length - BACKUP_LIMIT))) await rm(join(sub, old), { force: true })
  } catch {
    // 清理失败不影响写入
  }
  return file
}

/** 列出章节历史（0.6 子目录备份 + 0.5.x 平铺备份；按时间倒序）。 */
export async function listChapterHistory(root = defaultRoot(), projectId, n) {
  const chapter = chapterNumber(n)
  const dir = await pdir(root, projectId, { create: false })
  const id = pad4(chapter)
  const base = join(dir, '.backups')
  const entries = []
  const sub = join(base, id)
  try {
    for (const file of await readdir(sub)) {
      const stamp = file.replace(/\.md$/, '').split('-').slice(0, 6).join('-')
      const match = /^(.+)-[0-9a-f]+\.md$/.exec(file)
      const savedAt = match ? savedAtFromTimestamp(match[1]) : null
      if (!savedAt) continue
      const info = await stat(join(sub, file))
      entries.push({ version: savedAt, file: join(id, file), savedAt, bytes: info.size, hash: (/-([0-9a-f]+)\.md$/.exec(file) ?? [])[1] ?? '', source: '0.6' })
    }
  } catch {
    // 无子目录备份
  }
  try {
    const prefix = `${id}-`
    for (const file of await readdir(base)) {
      if (!file.startsWith(prefix) || !file.endsWith('.md')) continue
      const rest = file.slice(prefix.length, -3).replace(/-\d+$/, '')
      const savedAt = savedAtFromTimestamp(rest)
      if (!savedAt) continue
      const info = await stat(join(base, file))
      entries.push({ version: savedAt, file, savedAt, bytes: info.size, hash: '', source: '0.5' })
    }
  } catch {
    // 无平铺备份
  }
  return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

/** 读某个历史版本（version 可为 savedAt / 文件名 / 0 基下标）。 */
export async function readChapterVersion(root = defaultRoot(), projectId, n, version) {
  const chapter = chapterNumber(n)
  const dir = await pdir(root, projectId, { create: false })
  const entries = await listChapterHistory(root, projectId, chapter)
  let entry = entries.find((item) => item.version === version || item.file === version || basename(item.file) === version)
  if (!entry && Number.isInteger(Number(version)) && version !== '') {
    const index = Number(version)
    entry = entries[index] ?? entries[index - 1]
  }
  if (!entry) throw fail(`历史版本不存在：${version}`, 'not-found')
  const file = join(dir, '.backups', entry.file)
  const raw = await readFile(file, 'utf8')
  if (/^---[ \t]*\r?\n/.test(raw)) {
    const { meta, body } = parseChapterMd(raw)
    if (!meta.title) meta.title = `第 ${chapter} 章`
    return { chapter, version: entry.version, savedAt: entry.savedAt, source: entry.source, format: 'md', text: body, meta }
  }
  return { chapter, version: entry.version, savedAt: entry.savedAt, source: entry.source, format: 'txt', text: raw, meta: null }
}

// ---------------------------------------------------------------- 章节：写

/**
 * 写正文章节（唯一正文落盘函数）。
 * @param {object} [meta] 元数据增量（合并；未知字段保留）
 * @param {{ baseHash?: string|null, format?: 'md'|'txt', allowEmpty?: boolean, source?: string }} [opts]
 *   baseHash 与当前 contentHash 不一致时抛 code='stale'（供 host 映射 stale 错误）
 */
export async function saveChapter(root = defaultRoot(), projectId, n, text, meta = {}, opts = {}) {
  const chapter = chapterNumber(n)
  const dir = await pdir(root, projectId)
  const plan = await planChapter(dir, chapter, { format: opts.format })
  const body = String(text ?? '').replace(/\r\n?/g, '\n')
  if (!body.trim() && !opts.allowEmpty) throw fail('正文为空，拒绝写入', 'empty')

  let previous = null
  try {
    previous = await readChapter(root, projectId, chapter)
  } catch {
    previous = null
  }
  const currentHash = previous?.meta?.contentHash ?? null
  const baseHash = opts.baseHash === undefined || opts.baseHash === null || opts.baseHash === '' ? null : String(opts.baseHash)
  if (baseHash && baseHash !== currentHash) {
    throw fail('章节已在别处修改，请刷新后重试', 'stale', { currentHash })
  }

  let backup = null
  if (previous && String(previous.text ?? '').trim() && previous.text !== body) {
    backup = await backupChapterBody(dir, chapter, previous.text)
  }

  const hash = contentHash(body)
  const words = countWords(body)
  const updatedAt = nowIso()
  const patch = cleanPatch(meta)
  const merged = { ...(previous?.meta ?? {}), ...patch, chapter, contentHash: hash, words, updatedAt }
  delete merged.measuredScore
  if (!merged.title) merged.title = `第 ${chapter} 章`
  if (!merged.status) merged.status = 'draft'

  let metaOut = merged
  if (plan.format === 'md') {
    const raw = plan.hasMd ? await readFile(plan.md, 'utf8') : null
    await writeFileAtomic(plan.md, serializeChapterMd(raw, merged, body))
    // 旧格式正文写 .md；gate/hash 等 0.6 元数据放旁路 meta.json（旧插件不读、不受影响）
    metaOut = { ...merged }
    await writeJson(plan.metaPath, metaOut)
  } else {
    await writeFileAtomic(plan.txt, body)
    metaOut = { ...merged }
    await writeJson(plan.metaPath, metaOut)
  }

  // 只更新作品时间，不动 draft/版本（避免与正在跑的旧 Agent 抢写）
  const projectPath = join(dir, 'project.json')
  const project = await readJson(projectPath, null)
  if (project && typeof project === 'object' && !Array.isArray(project)) {
    await writeJson(projectPath, { ...project, updatedAt })
    await updateLibrary(root, { ...project, updatedAt })
  }

  // 复测队列的真实来源：正文变了就让本章进入待复测（失败不影响保存）
  if (!previous || previous.text !== body) {
    try {
      await mergeAttention(root, projectId, chapter, { recheckPending: true })
    } catch {
      // attention 是辅助信息，写失败不影响正文落盘
    }
  }

  // 0.7：重建段落索引、账本增量同步、意见重定位（失败不影响保存）
  let indexSummary = null
  try {
    indexSummary = await bookdb.onChapterSaved({
      dir,
      chapter,
      text: body,
      previousText: previous?.text ?? '',
      words,
    })
  } catch {
    indexSummary = null
  }

  return {
    chapter,
    format: plan.format,
    title: metaOut.title,
    words,
    contentHash: hash,
    updatedAt,
    backup,
    meta: metaOut,
    index: indexSummary,
  }
}

/**
 * 删除一章：正文（.md/.txt）+ 旁路 meta + 本章审阅 / 注意力 / 待批准提案。
 *
 * 删除是「真删」但可救：正文在写前备份里还有历史版本（.backups/NNNN/）。
 * 删掉的章号不复用、不重排（章节文件就是章号）。本章的待批准提案一并清掉，
 * 否则之后重写同一章会看到上一版的修订；已采纳/已驳回的提案留作历史。
 */
export async function deleteChapter(root = defaultRoot(), projectId, n) {
  const chapter = chapterNumber(n)
  const dir = await pdir(root, projectId, { create: false })
  const plan = await planChapter(dir, chapter)
  if (!plan.hasTxt && !plan.hasMd) throw fail(`章节不存在：第 ${chapter} 章`, 'not-found')
  let info = null
  try {
    info = await readChapter(root, projectId, chapter)
  } catch {
    info = null
  }
  const removed = { text: false, md: false, meta: false, attention: 0, reviews: 0, proposals: 0 }
  if (plan.hasTxt) {
    await rm(plan.txt, { force: true })
    removed.text = true
  }
  if (plan.hasMd) {
    await rm(plan.md, { force: true })
    removed.md = true
  }
  try {
    await rm(plan.metaPath, { force: true })
    removed.meta = true
  } catch {
    removed.meta = false
  }

  const cleanList = async (file) => {
    const path = join(dir, file)
    const list = await readJson(path, [])
    if (!Array.isArray(list) || list.length === 0) return 0
    const kept = list.filter((row) => Number(row?.chapter) !== chapter)
    const dropped = list.length - kept.length
    if (dropped > 0) await writeJson(path, kept)
    return dropped
  }
  removed.attention = await (async () => {
    const path = join(dir, 'attention.json')
    const raw = await readJson(path, [])
    if (Array.isArray(raw) && raw.length > 0) {
      const kept = raw.filter((row) => Number(row?.chapter) !== chapter)
      const dropped = raw.length - kept.length
      if (dropped > 0) await writeJson(path, kept)
      return dropped
    }
    if (raw && typeof raw === 'object' && raw.chapters && typeof raw.chapters === 'object') {
      let dropped = 0
      const chapters = {}
      for (const [key, value] of Object.entries(raw.chapters)) {
        if (!Array.isArray(value)) {
          chapters[key] = value
          continue
        }
        const kept = value.filter((row) => Number(row?.chapter) !== chapter)
        dropped += value.length - kept.length
        if (kept.length > 0) chapters[key] = kept
      }
      if (dropped > 0) await writeJson(path, { ...raw, chapters })
      return dropped
    }
    return 0
  })()
  removed.reviews = await cleanList('reviews.json')
  {
    const path = join(dir, 'proposals.json')
    const list = await readJson(path, [])
    if (Array.isArray(list) && list.length > 0) {
      const kept = list.filter((row) => {
        if (Number(row?.chapter) !== chapter) return true
        return !['pending', 'needs-fix', 'stale'].includes(String(row?.status ?? 'pending'))
      })
      removed.proposals = list.length - kept.length
      if (removed.proposals > 0) await writeJson(path, kept)
    }
  }

  const projectPath = join(dir, 'project.json')
  const project = await readJson(projectPath, null)
  if (project && typeof project === 'object' && !Array.isArray(project)) {
    const updatedAt = nowIso()
    await writeJson(projectPath, { ...project, updatedAt })
    await updateLibrary(root, { ...project, updatedAt })
  }
  return {
    ok: true,
    chapter,
    title: info?.meta?.title ?? `第 ${chapter} 章`,
    words: info?.meta?.words ?? 0,
    removed,
  }
}

/** 全文搜索（命中章号/偏移/上下文片段，最多 100 条）。 */
export async function searchChapter(root = defaultRoot(), projectId, query) {
  const q = String(query ?? '').trim()
  if (!q) return []
  const needle = q.toLowerCase()
  const results = []
  for (const row of await listChapters(root, projectId)) {
    let chapter
    try {
      chapter = await readChapter(root, projectId, row.chapter)
    } catch {
      continue
    }
    const haystack = chapter.text.toLowerCase()
    let from = 0
    let hits = 0
    while (hits < 5) {
      const index = haystack.indexOf(needle, from)
      if (index < 0) break
      const start = Math.max(0, index - 40)
      const end = Math.min(chapter.text.length, index + q.length + 60)
      const snippet = `${start > 0 ? '…' : ''}${chapter.text.slice(start, end).replace(/\s+/g, ' ')}${end < chapter.text.length ? '…' : ''}`
      results.push({ chapter: row.chapter, offset: index, snippet })
      hits += 1
      from = index + needle.length
      if (results.length >= 100) return results
    }
  }
  return results
}

// ---------------------------------------------------------------- 审阅

/** 由 dimension（中文）派生四路 source。 */
function deriveSource(entry) {
  const raw = String(entry?.source ?? '')
  if (FOUR_SOURCES.includes(raw)) return raw
  if (raw === 'reader') return 'reader'
  const dimension = String(entry?.dimension ?? '')
  if (/连续|逻辑|事实|情节/.test(dimension)) return 'logic'
  if (/注意力|节奏|钩子/.test(dimension)) return 'attention'
  if (/AI|文笔|语言/.test(dimension)) return 'ai-style'
  return 'logic'
}

/** 读审阅（0.5.x 旧条目派生四路 source，不改盘）。 */
export async function getReviews(root = defaultRoot(), projectId) {
  const dir = await pdir(root, projectId, { create: false })
  const list = await readJson(join(dir, 'reviews.json'), [])
  if (!Array.isArray(list)) return []
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry
    const source = deriveSource(entry)
    const out = { ...entry, source }
    if (entry.source && entry.source !== source) out.legacySource = entry.source
    return out
  })
}

/** 空白与引号归一（quote 命中校验用）。 */
function normalizeForMatch(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/[“”‘’「」『』"']/g, '')
}

/** 去重键：chapter + source + 归一化 quote；全书级无 quote 时用 issue。 */
function reviewKey(entry) {
  const chapter = Number(entry?.chapter) || 0
  const source = deriveSource(entry)
  const quote = normalizeForMatch(entry?.quote)
  const issue = normalizeForMatch(entry?.issue)
  return `${chapter}|${source}|${quote || issue}`
}

/**
 * 新增审阅。
 *
 * 硬规矩（作者定的）：**审阅是用户提交的内容，任何情况都不许丢弃。**
 * 引文能不能在正文里逐字命中、是否唯一，只用来打 `quoteMatch` 标记供事后核对，
 * 不再作为写入前提；重复条目也不拒绝，存下来并标 `duplicateOf`。
 * 只有「既没写意见也没选引文」的空提交才不落盘。
 */
export async function addReviews(root = defaultRoot(), projectId, items = []) {
  const dir = await pdir(root, projectId)
  const existing = await readJson(join(dir, 'reviews.json'), [])
  const list = Array.isArray(existing) ? existing : []
  const priorKeys = new Map()
  for (const entry of list) {
    const key = reviewKey(entry)
    const status = String(entry?.status ?? 'open')
    if (!priorKeys.has(key)) priorKeys.set(key, [])
    priorKeys.get(key).push({ id: entry?.id ?? null, status })
  }
  const textCache = new Map()
  const chapterText = async (chapter) => {
    if (!textCache.has(chapter)) {
      let text = null
      try {
        text = (await readChapter(root, projectId, chapter)).text
      } catch {
        text = null
      }
      textCache.set(chapter, text)
    }
    return textCache.get(chapter)
  }
  let added = 0
  let skipped = 0
  const skippedReasons = []
  const now = nowIso()
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') {
      skipped += 1
      skippedReasons.push('提交内容不是对象')
      continue
    }
    // 章号不合法也不丢弃：能落到全书级就落到全书级
    let chapter = Number(item.chapter)
    if (!Number.isInteger(chapter) || chapter < 0) chapter = 0
    const issue = String(item.issue ?? '').trim()
    const quote = String(item.quote ?? '').trim()
    if (!issue && !quote) {
      skipped += 1
      skippedReasons.push('空提交：既没有意见也没有引文')
      continue
    }
    const source = FOUR_SOURCES.includes(item.source) ? item.source : deriveSource(item)
    // 引文定位只打标记，不拦截落盘
    let quoteMatch = 'ok'
    if (chapter > 0 && quote) {
      const text = await chapterText(chapter)
      const flat = normalizeForMatch(text || '')
      const quoteNorm = normalizeForMatch(quote)
      if (!text) quoteMatch = 'no-chapter'
      else if (!flat.includes(quoteNorm)) quoteMatch = 'miss'
      else if (countOccurrences(flat, quoteNorm) > 1) quoteMatch = 'multi'
    }
    const entry = {
      ...item,
      id: item.id ? String(item.id) : `rv_${shortId()}`,
      chapter,
      source,
      dimension: String(item.dimension ?? DIMENSION_BY_SOURCE[source] ?? '逻辑'),
      severity: SEVERITIES.includes(item.severity) ? item.severity : 'major',
      quote,
      issue,
      suggestion: String(item.suggestion ?? ''),
      status: String(item.status ?? 'open'),
      origin: item.origin ?? (source === 'reader' ? 'human' : 'ai'),
      createdAt: item.createdAt ?? now,
      updatedAt: now,
      fixedAt: null,
      proposalId: item.proposalId ?? null,
      runId: item.runId ?? null,
      quoteMatch,
    }
    const key = reviewKey(entry)
    const prior = priorKeys.get(key) ?? []
    // 重复也存：挂一个 duplicateOf，让人自己判断，不替他扔
    const dup = prior.find((row) => row && ['open', 'proposed'].includes(String(row.status)))
    if (dup && dup.id) entry.duplicateOf = String(dup.id)
    priorKeys.set(key, [...prior, { id: entry.id, status: String(entry.status) }])
    list.push(entry)
    addedEntries.push(entry)
    added += 1
  }
  if (added) {
    await backupReviewsBeforeWrite(dir)
    await writeJson(join(dir, 'reviews.json'), list)
    // 意见库（SQLite）过渡期双写：失败不影响审阅落盘
    try {
      const byChapter = new Map()
      for (const entry of addedEntries) {
        const ch = Number(entry.chapter) || 0
        if (!ch) continue
        if (!byChapter.has(ch)) byChapter.set(ch, [])
        byChapter.get(ch).push(entry)
      }
      for (const [ch, entries] of byChapter) {
        const text = (await chapterText(ch)) || ''
        await bookdb.syncReviewOpinions({ dir, chapter: ch, text, reviews: entries })
      }
    } catch {
      /* 意见库是辅助数据，失败不影响审阅本身 */
    }
  }
  return skippedReasons.length ? { added, skipped, skippedReasons } : { added, skipped }
}

/** 写 reviews.json 前把旧内容存一份到 .backups/review-history/（最多 200 份；失败不阻断写入）。 */
async function backupReviewsBeforeWrite(dir) {
  try {
    const file = join(dir, 'reviews.json')
    const raw = await readFile(file, 'utf8')
    if (!raw || !raw.trim()) return
    const target = join(dir, '.backups', 'review-history')
    await mkdir(target, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await writeFile(join(target, `reviews-${stamp}.json`), raw, 'utf8')
    const files = (await readdir(target)).filter((f) => f.startsWith('reviews-')).sort()
    const extra = files.slice(0, Math.max(0, files.length - 200))
    for (const old of extra) await rm(join(target, old), { force: true })
  } catch {
    /* 备份失败不阻断写入 */
  }
}

/** 修改审阅（状态流转、挂提案等）。 */
export async function patchReviews(root = defaultRoot(), projectId, ids, patch = {}) {
  const dir = await pdir(root, projectId)
  const list = await readJson(join(dir, 'reviews.json'), [])
  const wanted = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String))
  const values = cleanPatch(patch)
  const now = nowIso()
  let updated = 0
  const rows = (Array.isArray(list) ? list : []).map((entry) => {
    if (!entry || !wanted.has(String(entry.id))) return entry
    updated += 1
    const next = { ...entry, ...values, updatedAt: now }
    if (values.status === 'fixed' || values.status === 'done') {
      next.fixedAt = values.fixedAt ?? now
      if (next.status === 'done') next.status = 'fixed'
    }
    if (values.status === 'open') next.fixedAt = null
    return next
  })
  if (updated) {
    await writeJson(join(dir, 'reviews.json'), rows)
    try {
      const changed = rows.filter((entry) => entry && wanted.has(String(entry.id)))
      const byChapter = new Map()
      for (const entry of changed) {
        const ch = Number(entry.chapter) || 0
        if (!ch) continue
        if (!byChapter.has(ch)) byChapter.set(ch, [])
        byChapter.get(ch).push(entry)
      }
      for (const [ch, entries] of byChapter) {
        const text = (await readChapter(root, projectId, ch)).text || ''
        await bookdb.syncReviewOpinions({ dir, chapter: ch, text, reviews: entries })
      }
    } catch {
      /* 意见库同步失败不影响审阅状态 */
    }
  }
  return { updated }
}

// ---------------------------------------------------------------- 注意力

function attentionEntry(chapter) {
  return {
    chapter,
    type: '',
    hook: '',
    tension: '',
    payoff: '',
    cliff: '',
    question: '',
    emotion: '',
    note: '',
    designScore: null,
    score: null,
    breakdown: null,
    weakest: '',
    dropRisk: '',
    verdict: '',
    dropPoints: [],
    status: 'planned',
    scoreHistory: [],
    scoredAt: null,
    scoredHash: '',
    recheckPending: false,
    lastFixAt: null,
    fixLog: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

/** 读注意力（0.6 为数组；兼容旧 {chapters:{}} 只读形状）。 */
export async function getAttention(root = defaultRoot(), projectId) {
  const dir = await pdir(root, projectId, { create: false })
  const raw = await readJson(join(dir, 'attention.json'), [])
  if (Array.isArray(raw)) {
    return raw.filter((item) => item && Number.isFinite(Number(item.chapter)))
  }
  if (raw && typeof raw === 'object' && raw.chapters && typeof raw.chapters === 'object') {
    return Object.values(raw.chapters).flat().filter((item) => item && Number.isFinite(Number(item.chapter)))
  }
  return []
}

/** 合并注意力（空值不擦除、合并而非覆盖、自动 append scoreHistory、绝不写 measuredScore）。 */
export async function mergeAttention(root = defaultRoot(), projectId, chapter, patch = {}) {
  const n = chapterNumber(chapter)
  const dir = await pdir(root, projectId)
  const list = await getAttention(root, projectId)
  const index = list.findIndex((item) => Number(item.chapter) === n)
  const existing = index >= 0 ? list[index] : null
  const patchKeys = Object.keys(cleanPatch(patch)).filter((key) => key !== 'chapter' && key !== 'measuredScore')
  const isBlankOnly = patchKeys.every((key) => isBlank(patch[key]))
  if (existing && isBlankOnly) return existing

  const clean = {}
  for (const key of patchKeys) {
    if (isBlank(patch[key]) && key !== 'recheckPending') continue
    clean[key] = patch[key]
  }
  delete clean.scoreHistory
  if (clean.breakdown && typeof clean.breakdown === 'object' && existing?.breakdown && typeof existing.breakdown === 'object') {
    clean.breakdown = { ...existing.breakdown, ...clean.breakdown }
  }

  const base = existing ? { ...existing } : attentionEntry(n)
  const next = { ...base, ...clean, chapter: n }
  delete next.measuredScore

  const prevScore = Number.isFinite(Number(base.score)) && base.score !== null && base.score !== '' ? Number(base.score) : null
  let nextScore = Number.isFinite(Number(next.score)) && next.score !== null && next.score !== '' ? Number(next.score) : null
  if (clean.breakdown && typeof clean.breakdown === 'object') {
    const computed = scoreOf(next.breakdown)
    if (computed !== null) nextScore = computed
  }
  if (nextScore !== null) nextScore = Math.max(0, Math.min(100, Math.round(nextScore)))
  next.score = nextScore

  const now = nowIso()
  if (prevScore !== nextScore && (clean.score !== undefined || clean.breakdown !== undefined)) {
    let scoredHash = ''
    try {
      scoredHash = (await readChapter(root, projectId, n)).meta.contentHash
    } catch {
      scoredHash = ''
    }
    const history = Array.isArray(base.scoreHistory) ? [...base.scoreHistory] : []
    history.push({
      at: now,
      from: prevScore,
      to: nextScore,
      delta: prevScore === null || nextScore === null ? null : nextScore - prevScore,
      designScore: Number.isFinite(Number(next.designScore)) ? Number(next.designScore) : null,
      source: prevScore === null ? 'cold-read' : 'recheck',
    })
    next.scoreHistory = history.slice(-10)
    next.scoredAt = now
    next.scoredHash = scoredHash
    next.recheckPending = false
  }
  next.updatedAt = now
  if (!next.id) next.id = shortId()

  if (index >= 0) list[index] = next
  else list.push(next)
  list.sort((a, b) => Number(a.chapter) - Number(b.chapter))
  await writeJson(join(dir, 'attention.json'), list)
  return next
}

// ---------------------------------------------------------------- 提案

function proposalFile(root, projectId) {
  return join(root, 'projects', projectId, 'proposals.json')
}

/** 读提案原始数组（本项目优先；缺文件时只读兜底 projects/proposals.json）。 */
async function readProposalsRaw(root, projectId) {
  const dir = await pdir(root, projectId, { create: false })
  const own = join(dir, 'proposals.json')
  if (await exists(own)) {
    const list = await readJson(own, [])
    return { list: Array.isArray(list) ? list : [], readOnly: false }
  }
  const fallback = join(root, 'projects', 'proposals.json')
  const list = await readJson(fallback, [])
  return { list: Array.isArray(list) ? list : [], readOnly: true }
}

function decorateProposal(proposal, readOnly) {
  const kind = proposal?.kind ?? proposal?.action ?? ''
  const legacy = !PROPOSAL_KINDS.has(kind)
  return { ...proposal, kind, legacy, readOnly: Boolean(readOnly) || legacy }
}

/** 列表提案（默认只展示 0.6 三种 kind；旧 0.5.x kind 原样保留、只读）。 */
export async function listProposals(root = defaultRoot(), projectId, filter = {}) {
  const { list, readOnly } = await readProposalsRaw(root, projectId)
  let rows = list.map((proposal) => decorateProposal(proposal, readOnly))
  if (!filter?.includeLegacy && !filter?.legacy) rows = rows.filter((proposal) => !proposal.legacy)
  if (filter?.status) {
    const status = new Set((Array.isArray(filter.status) ? filter.status : [filter.status]).map(String))
    rows = rows.filter((proposal) => status.has(String(proposal.status ?? '')))
  }
  if (filter?.kind) {
    const kind = new Set((Array.isArray(filter.kind) ? filter.kind : [filter.kind]).map(String))
    rows = rows.filter((proposal) => kind.has(String(proposal.kind ?? '')))
  }
  if (filter?.chapter !== undefined && filter?.chapter !== null) {
    rows = rows.filter((proposal) => Number(proposal.chapter) === Number(filter.chapter))
  }
  return rows.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
}

/** 读单条提案。 */
export async function getProposal(root = defaultRoot(), projectId, proposalId) {
  const { list, readOnly } = await readProposalsRaw(root, projectId)
  const found = list.find((proposal) => String(proposal?.id) === String(proposalId))
  if (!found) throw fail(`提案不存在：${proposalId}`, 'not-found')
  return decorateProposal(found, readOnly)
}

function proposalPayloadKey(kind, chapter, data) {
  return contentHash(`${kind}|${chapter ?? ''}|${JSON.stringify(data ?? {})}`)
}

/**
 * 注意力硬约束（ATTENTION IS ALL YOU NEED）：新提交的账本提案里，
 * - AI 自定义方案（preset-ai-custom）必须带全书注意力总设计 attentionPlan；
 * - 大纲（outlines）每章必须带四拍设计 attention（type/hook/tension/payoff/cliff/designScore）。
 * 只校验新提案；旧数据与界面直接编辑账本不受影响。
 */
function assertAttentionDesign(kind, data) {
  if (kind !== 'ledger-fix') return
  for (const fix of ledgerFixesOf(data)) {
    const patch = fix?.patch && typeof fix.patch === 'object' ? fix.patch : {}
    if (fix?.kind === 'presets' && String(patch.id ?? '') === 'preset-ai-custom') {
      const plan = patch.attentionPlan && typeof patch.attentionPlan === 'object' ? patch.attentionPlan : null
      const missing = []
      if (!plan) {
        missing.push('attentionPlan')
      } else {
        if (!String(plan.principle ?? '').trim()) missing.push('principle')
        const target = Number(plan.targetAvg)
        if (!Number.isFinite(target) || target < 0 || target > 100) missing.push('targetAvg（0–100）')
        for (const key of ['openingHooks', 'payoffCadence', 'cliffRule']) {
          if (!String(plan[key] ?? '').trim()) missing.push(key)
        }
        if (!Array.isArray(plan.mainTypeRotation) || plan.mainTypeRotation.length === 0) missing.push('mainTypeRotation')
      }
      if (missing.length > 0) {
        throw fail(`AI 自定义方案必须带注意力总设计（ATTENTION IS ALL YOU NEED）：patch.attentionPlan 缺 ${missing.join('、')}`, 'bad-proposal')
      }
    }
    if (fix?.kind === 'outlines') {
      // 已有大纲条目（带 id）是维护性修订，不强制重交四拍；新建/重写整章大纲（id 为空）必须带设计，
      // 否则开新书的 outlines 提案可以绕开「每章先设计」。
      if (String(patch.id ?? '').trim()) continue
      const attention = patch.attention && typeof patch.attention === 'object' ? patch.attention : null
      const missing = []
      if (!attention) {
        missing.push('attention')
      } else {
        if (!ATTENTION_TYPES.has(String(attention.type ?? ''))) missing.push('type（event/emotion/language/mystery/relationship）')
        for (const key of ['hook', 'tension', 'payoff', 'cliff']) {
          if (!String(attention[key] ?? '').trim()) missing.push(key)
        }
        const score = Number(attention.designScore)
        if (!Number.isFinite(score) || score < 0 || score > 100) missing.push('designScore（0–100）')
      }
      if (missing.length > 0) {
        throw fail(`大纲提案必须带每章注意力设计（ATTENTION IS ALL YOU NEED）：第${patch.chapter ?? '?'}章 patch.attention 缺 ${missing.join('、')}`, 'bad-proposal')
      }
    }
  }
}

/** 新建提案（生成 id、按 chapter+kind+payloadKey 对 pending 去重）。 */
/** book-fix 提案 data 校验：必须带全局修改意见 + 可逐字定位的跨章补丁。 */
function assertBookFix(data) {
  const opinion = String(data?.opinion ?? '').trim()
  if (!opinion) throw fail('book-fix 提案缺少全局修改意见：data.opinion 不能为空', 'bad-proposal')
  const patches = Array.isArray(data?.patches) ? data.patches : []
  if (!patches.length) throw fail('book-fix 提案没有跨章补丁：data.patches 不能为空', 'bad-proposal')
  patches.forEach((patch, index) => {
    const chapter = Number(patch?.chapter)
    if (!Number.isInteger(chapter) || chapter < 1) {
      throw fail(`book-fix 补丁 #${index + 1} 章号非法：${patch?.chapter}`, 'bad-chapter')
    }
    const before = String(patch?.before ?? '').trim()
    if (before.length < 4) throw fail(`book-fix 补丁 #${index + 1}（第${chapter}章）的 before 至少 4 字`, 'bad-proposal')
    if (typeof patch?.after !== 'string') throw fail(`book-fix 补丁 #${index + 1} 的 after 必须是字符串`, 'bad-proposal')
  })
}

/** 记录 book-fix 涉及章节的正文指纹（批准时逐章做 staleness 检查）。 */
async function collectBookHashes(root, projectId, patches) {
  const hashes = {}
  for (const patch of Array.isArray(patches) ? patches : []) {
    const chapter = Number(patch?.chapter)
    if (!Number.isInteger(chapter) || chapter < 1) continue
    if (hashes[chapter] !== undefined) continue
    try {
      hashes[chapter] = (await readChapter(root, projectId, chapter)).meta.contentHash
    } catch {
      hashes[chapter] = null
    }
  }
  return hashes
}

export async function createProposal(root = defaultRoot(), projectId, proposal = {}) {
  const dir = await pdir(root, projectId)
  const kind = String(proposal.kind ?? proposal.action ?? '')
  if (!PROPOSAL_KINDS.has(kind)) throw fail(`提案 kind 不合法：${kind || '(空)'}`, 'bad-kind')
  let chapter = proposal.chapter === null || proposal.chapter === undefined ? null : Number(proposal.chapter)
  if (chapter !== null && (!Number.isInteger(chapter) || chapter < 0)) throw fail(`提案章号非法：${proposal.chapter}`, 'bad-chapter')
  if (kind === 'book-fix') {
    if (chapter !== null && chapter !== 0) throw fail('book-fix 是全书级提案，chapter 必须为 0', 'bad-chapter')
    chapter = 0
  }
  const title = String(proposal.title ?? '').trim()
  if (!title) throw fail('提案标题不能为空', 'bad-proposal')
  const data = proposal.data ?? proposal.payload ?? {}
  assertAttentionDesign(kind, data)
  if (kind === 'book-fix') assertBookFix(data)
  const key = proposalPayloadKey(kind, chapter, data)

  const list = await readJson(join(dir, 'proposals.json'), [])
  const rows = Array.isArray(list) ? list : []
  const duplicate = rows.find(
    (item) =>
      String(item?.status) === 'pending' &&
      String(item?.kind ?? item?.action) === kind &&
      Number(item?.chapter ?? -1) === Number(chapter ?? -1) &&
      proposalPayloadKey(item?.kind ?? item?.action, item?.chapter, item?.data ?? item?.payload) === key,
  )
  if (duplicate) {
    // 重复提案也算「已提交」：审阅挂到 proposed，避免同一条意见反复出提案
    await markReviewsStatus(dir, reviewIdsOf(duplicate), 'proposed', duplicate.id)
    return decorateProposal(duplicate, false)
  }

  let baseHash = proposal.baseHash ?? null
  if (!baseHash && chapter && chapter > 0) {
    try {
      baseHash = (await readChapter(root, projectId, chapter)).meta.contentHash
    } catch {
      baseHash = null
    }
  }
  // 全书提案：记下每个目标章的正文指纹，批准时逐章过期检查
  if (kind === 'book-fix') data.baseHashes = await collectBookHashes(root, projectId, data.patches)
  const entry = {
    ...proposal,
    id: proposal.id ? String(proposal.id) : `pp_${shortId()}`,
    kind,
    chapter,
    title,
    summary: String(proposal.summary ?? ''),
    status: 'pending',
    source: proposal.source ?? 'manual',
    runId: proposal.runId ?? null,
    reviewIds: Array.isArray(proposal.reviewIds) ? proposal.reviewIds : [],
    data,
    gates: proposal.gates ?? {},
    baseHash,
    createdAt: proposal.createdAt ?? nowIso(),
    decidedAt: null,
  }
  delete entry.action
  delete entry.payload
  rows.push(entry)
  await writeJson(join(dir, 'proposals.json'), rows)
  // 提案已提交：关联审阅进入 proposed（不再算待处理，也不再被重复提案命中）
  await markReviewsStatus(dir, reviewIdsOf(entry), 'proposed', entry.id)
  return decorateProposal(entry, false)
}

/** 定位提案在项目文件里的原始数组与下标（只读兜底时抛错）。 */
async function locateProposal(root, projectId, proposalId) {
  const dir = await pdir(root, projectId)
  const path = join(dir, 'proposals.json')
  const list = await readJson(path, [])
  const rows = Array.isArray(list) ? list : []
  const index = rows.findIndex((proposal) => String(proposal?.id) === String(proposalId))
  if (index < 0) {
    const fallback = await readJson(join(root, 'projects', 'proposals.json'), [])
    if (Array.isArray(fallback) && fallback.some((proposal) => String(proposal?.id) === String(proposalId))) {
      throw fail('该提案来自旧库兜底文件，只读', 'read-only')
    }
    throw fail(`提案不存在：${proposalId}`, 'not-found')
  }
  return { dir, path, rows, index, proposal: rows[index] }
}

/** 统计 needle 在 text 中出现的次数（不重叠；精确匹配）。 */
function countOccurrences(text, needle) {
  const hay = String(text ?? '')
  const pin = String(needle ?? '')
  if (!pin) return 0
  let count = 0
  let from = 0
  while (from <= hay.length) {
    const at = hay.indexOf(pin, from)
    if (at < 0) break
    count += 1
    from = at + pin.length
  }
  return count
}

/**
 * 找 quote 在正文中的位置；精确优先，失败后退化为空白/引号归一匹配。
 * 同一位置出现多次无法唯一定位时返回 { ambiguous: true, count }（绝不打错位置）。
 */
function findQuoteSpan(text, quote) {
  const body = String(text ?? '')
  const raw = String(quote ?? '')
  if (raw.length < 4) return null
  const exactCount = countOccurrences(body, raw)
  if (exactCount > 1) return { ambiguous: true, count: exactCount }
  if (exactCount === 1) {
    const exact = body.indexOf(raw)
    return { start: exact, end: exact + raw.length }
  }
  const quoteNorm = normalizeForMatch(raw)
  if (!quoteNorm) return null
  const chars = []
  const index = []
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (/\s/.test(ch) || /[“”‘’「」『』"']/.test(ch)) continue
    chars.push(ch)
    index.push(i)
  }
  const flat = chars.join('')
  const normCount = countOccurrences(flat, quoteNorm)
  if (normCount > 1) return { ambiguous: true, count: normCount }
  if (normCount < 1) return null
  const startNorm = flat.indexOf(quoteNorm)
  const endNorm = startNorm + quoteNorm.length - 1
  return { start: index[startNorm], end: index[endNorm] + 1 }
}

/** 应用段落补丁（逐字定位；重叠/找不到时失败）。 */
function applyPatches(text, patches) {
  const spans = []
  for (const patch of Array.isArray(patches) ? patches : []) {
    const before = String(patch?.before ?? '')
    const after = String(patch?.after ?? '')
    const span = findQuoteSpan(text, before)
    if (!span) return { ok: false, failures: [`找不到补丁原文：${before.slice(0, 40)}`] }
    if (span.ambiguous) {
      return { ok: false, failures: [`补丁原文在正文出现 ${span.count} 次，无法唯一定位：${before.slice(0, 40)}`] }
    }
    if (before === after) continue
    spans.push({ ...span, after })
  }
  if (!spans.length) return { ok: false, failures: ['补丁为空或没有实际改动'] }
  spans.sort((a, b) => a.start - b.start)
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].start < spans[i - 1].end) return { ok: false, failures: ['补丁区间重叠'] }
  }
  let out = text
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    out = out.slice(0, spans[i].start) + spans[i].after + out.slice(spans[i].end)
  }
  return { ok: true, text: out, applied: spans.length }
}

/** 过闸门写正文（host 的 lib/gates.js；测试可用 options.writeGates 注入）。 */
async function runChapterGates(root, projectId, chapter, text, source, options = {}) {
  if (typeof options.writeGates === 'function') {
    return options.writeGates({ root, projectId, chapter, text, source })
  }
  const gates = await import('./gates.js')
  if (typeof gates.writeChapterWithGates !== 'function') throw fail('lib/gates.js 未提供 writeChapterWithGates', 'gates-unavailable')
  const store = await import('./store.js')
  return gates.writeChapterWithGates(store, { root, projectId, chapter, text, source, patch: options.patch })
}

/** 提案关联的审阅 id：proposal.reviewIds + data.patches[].reviewIds（去重）。 */
function reviewIdsOf(proposal) {
  const ids = [
    ...(Array.isArray(proposal?.reviewIds) ? proposal.reviewIds : []),
    ...(Array.isArray(proposal?.data?.patches) ? proposal.data.patches.flatMap((patch) => patch?.reviewIds ?? []) : []),
  ]
  return [...new Set(ids.filter(Boolean).map(String))]
}

/**
 * 批量流转审阅状态（跳过已 fixed/done/dismissed 的条目）。
 * - proposed：提案已提交，作者采纳/驳回前不再重复出提案
 * - open：提案被驳回，回到待处理（清 fixedAt）
 * - fixed：提案被采纳（写 fixedAt）
 */
async function markReviewsStatus(dir, ids, status, proposalId) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).filter(Boolean).map(String))
  if (!wanted.size) return 0
  const path = join(dir, 'reviews.json')
  const list = await readJson(path, [])
  if (!Array.isArray(list)) return 0
  const now = nowIso()
  let updated = 0
  const rows = list.map((entry) => {
    if (!entry || !wanted.has(String(entry.id))) return entry
    if (['fixed', 'done', 'dismissed'].includes(String(entry.status))) return entry
    updated += 1
    const next = { ...entry, status, updatedAt: now }
    if (proposalId !== undefined && proposalId !== null) next.proposalId = proposalId
    if (status === 'fixed') next.fixedAt = now
    if (status === 'open') next.fixedAt = null
    return next
  })
  if (updated) await writeJson(path, rows)
  return updated
}

/** 提案通过后回写关联审阅状态。 */
async function markReviewsFixed(dir, proposal) {
  return markReviewsStatus(dir, reviewIdsOf(proposal), 'fixed', proposal.id)
}

const LEDGER_KINDS = new Set(['world', ...Object.keys(KIND_FILES)])

/** 账本类型规范化：只认账本支持的类型（world/facts/characters/…），其他返回空串。 */
export function ledgerKindOf(value) {
  const kind = String(value ?? '').trim()
  return LEDGER_KINDS.has(kind) ? kind : ''
}

/**
 * 取 ledger-fix 提案的修订项，兼容三种写法（0.6.1 修复：propose 工具 items 写法此前批准必失败）：
 * - data.ledgerFixes = [{kind,id,patch}]（契约写法，账本核对工作单也这么提）
 * - data.items = [{kind,id,patch}]（novel_desk_propose 的 items 参数照原样落进 data.items）
 * - data.kind + data.items = [裸 patch]（0.5 风格：一个提案只改一种账本）
 * 返回统一形状 [{kind,id?,patch}]。
 */
export function ledgerFixesOf(data) {
  const payload = data && typeof data === 'object' ? data : {}
  const declared = ledgerKindOf(payload.kind)
  const rows = Array.isArray(payload.ledgerFixes)
    ? payload.ledgerFixes
    : Array.isArray(payload.items)
      ? payload.items
      : []
  const asPatch = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null)
  if (rows.length === 0) {
    // 单条：data = {kind:'facts', patch:{…}} 或 {kind:'facts', item:{…}}
    if (declared && asPatch(payload.patch)) return [{ kind: declared, patch: asPatch(payload.patch) }]
    if (declared && asPatch(payload.item)) return [{ kind: declared, patch: asPatch(payload.item) }]
    return []
  }
  // data.kind 是账本类型、且 items 里是裸 patch（没有 patch/item 包装）→ 0.5 风格
  const bare = Boolean(declared) && rows.every((row) => !(asPatch(row) && (asPatch(row.patch) || asPatch(row.item))))
  return rows.map((row) => {
    const item = asPatch(row) ?? {}
    if (bare) return { kind: declared, patch: item }
    const kind = ledgerKindOf(item.kind) || String(item.kind ?? '').trim()
    const patch = asPatch(item.patch) ?? asPatch(item.item)
    if (patch) return { ...item, kind, patch }
    // 没有 patch 包装：整条（去掉 kind）当 patch
    const { kind: _ignored, ...rest } = item
    return { kind, patch: rest }
  })
}

/** 批准提案：patch-paragraph / rewrite-chapter 过闸门落盘，ledger-fix 直接改账本。 */
export async function acceptProposal(root = defaultRoot(), projectId, proposalId, options = {}) {
  const { dir, path, rows, index, proposal } = await locateProposal(root, projectId, proposalId)
  const kind = String(proposal.kind ?? proposal.action ?? '')
  if (!PROPOSAL_KINDS.has(kind)) throw fail('旧 kind 提案只读，不能批准', 'legacy-proposal')
  if (!['pending', 'needs-fix'].includes(String(proposal.status))) throw fail(`提案已处理：${proposal.status}`, 'already-decided')
  const chapter = Number(proposal.chapter)
  const data = proposal.data ?? proposal.payload ?? {}
  const now = nowIso()

  // 过期检查：生成时的正文指纹与当前不一致 → stale，不套用
  if (proposal.baseHash && Number.isInteger(chapter) && chapter > 0) {
    let currentHash = null
    try {
      currentHash = (await readChapter(root, projectId, chapter)).meta.contentHash
    } catch {
      currentHash = null
    }
    if (currentHash !== proposal.baseHash) {
      proposal.status = 'stale'
      proposal.decidedAt = now
      rows[index] = proposal
      await writeJson(path, rows)
      return { ok: false, proposal: decorateProposal(proposal, false), code: 'stale', message: '正文已变化，提案过期，需要重新生成' }
    }
  }

  if (kind === 'ledger-fix') {
    const fixes = ledgerFixesOf(data)
    if (!fixes.length) throw fail('ledger-fix 提案没有账本修订项：data.ledgerFixes 或 items 必须是 [{kind,id,patch}]', 'bad-proposal')
    // 先整体校验类型再逐条写入：一条 kind 非法时不能把前面几条先写进账本
    const badKind = fixes.find((fix) => !ledgerKindOf(fix.kind))
    if (badKind) {
      throw fail(`账本类型不支持：${String(badKind.kind ?? '') || '(空)'}（可用：${[...LEDGER_KINDS].join('、')}）`, 'bad-kind')
    }
    let appliedPreset = null
    for (const fix of fixes) {
      const entry = await upsertLedgerItem(root, projectId, fix.kind, fix.patch ?? fix.item ?? {})
      if (String(fix.kind ?? '') === 'presets' && entry && entry.id) appliedPreset = entry
      // 大纲里的四拍设计不是摆设：批准时同步进 attention.json（status=planned），
      // 这样开新书提案一批准，总览 hero / 曲线 / run 简报立刻能看到设计记录。
      if (String(fix.kind ?? '') === 'outlines') {
        const patch = fix.patch ?? fix.item ?? {}
        const attention = patch.attention && typeof patch.attention === 'object' ? patch.attention : null
        const outlineChapter = Number(patch.chapter)
        if (attention && Number.isInteger(outlineChapter) && outlineChapter > 0) {
          await mergeAttention(root, projectId, outlineChapter, { ...attention, status: attention.status ?? 'planned' })
        }
      }
    }
    // 批准「预设」修订后自动套用：AI 自定义方案要能直接生效，否则作者还得去设置页再点一次
    if (appliedPreset) {
      const planned = Number(appliedPreset.plannedChapters) || 0
      const perChapter = Number(appliedPreset.chapterWords) || 0
      const total = Number(appliedPreset.totalWords) || (planned > 0 && perChapter > 0 ? planned * perChapter : 0)
      const patch = { activePresetId: String(appliedPreset.id) }
      if (planned > 0) patch.targetChapters = planned
      if (total > 0) patch.targetWords = total
      if (appliedPreset.pov) patch.pov = String(appliedPreset.pov)
      if (appliedPreset.tense) patch.tense = String(appliedPreset.tense)
      if (appliedPreset.genre) patch.genre = String(appliedPreset.genre)
      if (Array.isArray(appliedPreset.styleRules) && appliedPreset.styleRules.length) patch.style = appliedPreset.styleRules.join('；')
      await updateProject(root, projectId, patch)
    }
    proposal.status = 'accepted'
    proposal.decidedAt = now
    proposal.updatedAt = now
    rows[index] = proposal
    await writeJson(path, rows)
    await markReviewsFixed(dir, proposal)
    return { ok: true, proposal: decorateProposal(proposal, false) }
  }

  if (kind === 'book-fix') {
    const patches = (Array.isArray(data.patches) ? data.patches : []).map((patch) => ({
      ...patch,
      after: normalizeProse(String(patch?.after ?? '')).text,
    }))
    if (!patches.length) throw fail('book-fix 提案没有跨章补丁：data.patches 不能为空', 'bad-proposal')
    const groups = new Map()
    for (const patch of patches) {
      const target = Number(patch?.chapter)
      if (!Number.isInteger(target) || target < 1) throw fail(`book-fix 补丁章号非法：${patch?.chapter}`, 'bad-chapter')
      if (!groups.has(target)) groups.set(target, [])
      groups.get(target).push(patch)
    }
    // 第一轮：逐章定位校验，全部通过才动第一笔（避免改到一半留下半成品）。
    // 0.6.8 起不再按 baseHashes 一律判 stale：每个全局问题一条提案，逐条批准时前一提案
    // 会改到同一章，只要本条补丁的 before 仍能在当前正文里唯一定位，就该能继续采纳。
    const planned = []
    for (const [target, list] of groups) {
      let current = null
      try {
        current = await readChapter(root, projectId, target)
      } catch {
        current = null
      }
      if (!current) {
        proposal.status = 'needs-fix'
        proposal.gates = { failures: [`第${target}章正文不存在，无法应用补丁`] }
        proposal.updatedAt = now
        rows[index] = proposal
        await writeJson(path, rows)
        return { ok: false, proposal: decorateProposal(proposal, false), failures: [`第${target}章正文不存在，无法应用补丁`] }
      }
      const result = applyPatches(current.text, list)
      if (!result.ok) {
        proposal.status = 'needs-fix'
        proposal.gates = { failures: result.failures }
        proposal.updatedAt = now
        rows[index] = proposal
        await writeJson(path, rows)
        return { ok: false, proposal: decorateProposal(proposal, false), failures: result.failures }
      }
      planned.push({ chapter: target, text: result.text, deltaText: list.map((item) => String(item?.after ?? '')).join('\n\n') })
    }
    // 第二轮：逐章过闸门写盘；任一章失败就停，已写入的章记进 appliedChapters（都有备份）
    const appliedChapters = []
    for (const item of planned) {
      const gate = await runChapterGates(root, projectId, item.chapter, item.text, proposal.source ?? 'review', {
        ...options,
        patch: { deltaText: item.deltaText },
      })
      if (gate?.ok === false) {
        const failures = Array.isArray(gate.failures) ? gate.failures : []
        proposal.status = 'needs-fix'
        proposal.gates = { failures: [{ chapter: item.chapter, failures }] }
        proposal.appliedChapters = appliedChapters
        proposal.updatedAt = now
        rows[index] = proposal
        await writeJson(path, rows)
        return { ok: false, proposal: decorateProposal(proposal, false), failures, appliedChapters }
      }
      appliedChapters.push(Number(gate?.chapter?.chapter ?? item.chapter))
    }
    proposal.status = 'accepted'
    proposal.decidedAt = now
    proposal.updatedAt = now
    proposal.gates = {}
    proposal.appliedChapters = appliedChapters
    rows[index] = proposal
    await writeJson(path, rows)
    await markReviewsFixed(dir, proposal)
    return { ok: true, proposal: decorateProposal(proposal, false), chapters: appliedChapters }
  }

  if (!Number.isInteger(chapter) || chapter < 1) throw fail('该提案缺少章号', 'bad-proposal')
  let text
  let patchScope = null
  if (kind === 'patch-paragraph') {
    const current = await readChapter(root, projectId, chapter)
    // 补丁文本先规范化（出站只改补丁段落，旧章其余字节原样保留）
    const patches = (Array.isArray(data.patches) ? data.patches : []).map((patch) => ({
      ...patch,
      after: normalizeProse(String(patch?.after ?? '')).text,
    }))
    const result = applyPatches(current.text, patches)
    if (!result.ok) {
      proposal.status = 'needs-fix'
      proposal.gates = { failures: result.failures }
      proposal.updatedAt = now
      rows[index] = proposal
      await writeJson(path, rows)
      return { ok: false, proposal: decorateProposal(proposal, false), failures: result.failures }
    }
    text = result.text
    // 闸门按补丁范围校验：AI 味/规范化只看补丁新增文本，保真看整章
    patchScope = { deltaText: patches.map((patch) => String(patch?.after ?? '')).join('\n\n') }
  } else {
    text = String(data.content ?? data.text ?? '')
  }
  if (!text.trim()) throw fail('提案正文为空', 'empty')

  const gate = await runChapterGates(root, projectId, chapter, text, proposal.source ?? 'review', { ...options, patch: patchScope ?? undefined })
  if (gate?.ok === false) {
    proposal.status = 'needs-fix'
    proposal.gates = gate.gates ?? gate
    proposal.updatedAt = now
    rows[index] = proposal
    await writeJson(path, rows)
    return { ok: false, proposal: decorateProposal(proposal, false), failures: gate.failures ?? [] }
  }
  proposal.status = 'accepted'
  proposal.decidedAt = now
  proposal.updatedAt = now
  proposal.gates = gate?.gates ?? gate ?? {}
  rows[index] = proposal
  await writeJson(path, rows)
  await markReviewsFixed(dir, proposal)
  return { ok: true, proposal: decorateProposal(proposal, false), chapter: gate?.chapter ?? null, gates: proposal.gates }
}

/** 驳回提案（关联审阅回到 open，可重新出提案）。 */
export async function rejectProposal(root = defaultRoot(), projectId, proposalId, reason = '') {
  const { dir, path, rows, index, proposal } = await locateProposal(root, projectId, proposalId)
  const kind = String(proposal.kind ?? proposal.action ?? '')
  if (!PROPOSAL_KINDS.has(kind)) throw fail('旧 kind 提案只读，不能驳回', 'legacy-proposal')
  if (!['pending', 'needs-fix', 'stale'].includes(String(proposal.status))) throw fail(`提案已处理：${proposal.status}`, 'already-decided')
  proposal.status = 'rejected'
  proposal.decidedAt = nowIso()
  proposal.updatedAt = proposal.decidedAt
  proposal.rejectReason = String(reason ?? '')
  rows[index] = proposal
  await writeJson(path, rows)
  await markReviewsStatus(dir, reviewIdsOf(proposal), 'open')
  return { ok: true, proposal: decorateProposal(proposal, false) }
}

/**
 * 修改提案（仅 pending / needs-fix 可改；kind/source 不可变）。
 * 主要用途：needs-fix 提案补 data 后重新提交；book-fix 的 opinion + patches 可一起改。
 */
export async function updateProposal(root = defaultRoot(), projectId, proposalId, patch = {}) {
  const { path, rows, index, proposal } = await locateProposal(root, projectId, proposalId)
  const kind = String(proposal.kind ?? proposal.action ?? '')
  if (!PROPOSAL_KINDS.has(kind)) throw fail('旧 kind 提案只读，不能修改', 'legacy-proposal')
  const status = String(proposal.status)
  if (!['pending', 'needs-fix'].includes(status)) throw fail(`提案已处理：${status}，不能修改`, 'already-decided')
  const src = patch ?? {}
  const next = { ...proposal }
  if (src.title !== undefined) {
    const title = String(src.title ?? '').trim()
    if (!title) throw fail('提案标题不能为空', 'bad-proposal')
    next.title = title
  }
  if (src.summary !== undefined) next.summary = String(src.summary ?? '')
  let chapter = next.chapter === null || next.chapter === undefined ? null : Number(next.chapter)
  if (src.chapter !== undefined) {
    chapter = src.chapter === null || src.chapter === undefined ? null : Number(src.chapter)
    if (chapter !== null && (!Number.isInteger(chapter) || chapter < 0)) throw fail(`提案章号非法：${src.chapter}`, 'bad-chapter')
    next.chapter = chapter
  }
  if (kind === 'book-fix') {
    if (chapter !== null && chapter !== 0) throw fail('book-fix 是全书级提案，chapter 必须为 0', 'bad-chapter')
    chapter = 0
    next.chapter = 0
  }
  if (src.data !== undefined) {
    if (!src.data || typeof src.data !== 'object' || Array.isArray(src.data)) throw fail('提案 data 必须是对象', 'bad-proposal')
    next.data = src.data
  }
  if (kind === 'book-fix') assertBookFix(next.data)
  // 正文指纹重算：chapter>0 的提案按章重算；book-fix 按每个目标章
  if (kind === 'book-fix') {
    next.baseHash = null
    next.data = { ...(next.data ?? {}), baseHashes: await collectBookHashes(root, projectId, next.data?.patches) }
  } else if (chapter && chapter > 0) {
    try {
      next.baseHash = (await readChapter(root, projectId, chapter)).meta.contentHash
    } catch {
      next.baseHash = null
    }
  }
  next.updatedAt = nowIso()
  if (status === 'needs-fix') {
    // 补完内容回到待批准；旧的闸门失败记录清零
    next.status = 'pending'
    const gates = next.gates && typeof next.gates === 'object' ? { ...next.gates } : {}
    delete gates.failures
    next.gates = gates
  }
  rows[index] = next
  await writeJson(path, rows)
  return decorateProposal(next, false)
}

/** 批量批准/驳回（逐条独立，失败进 failed）。options.reason 用于批量驳回时写入每条提案。 */
export async function batchProposals(root = defaultRoot(), projectId, ids = [], action = 'accept', options = {}) {
  const result = { accepted: [], rejected: [], failed: [] }
  const rejectReason = String(options?.reason ?? '')
  for (const id of Array.isArray(ids) ? ids : []) {
    try {
      if (action === 'reject') {
        await rejectProposal(root, projectId, id, rejectReason)
        result.rejected.push(id)
      } else {
        const outcome = await acceptProposal(root, projectId, id)
        if (outcome.ok) result.accepted.push(id)
        else result.failed.push({ id, message: outcome.message ?? (outcome.failures ?? []).join('；') ?? '闸门未通过' })
      }
    } catch (error) {
      result.failed.push({ id, message: error?.message ?? String(error) })
    }
  }
  return result
}

// ---------------------------------------------------------------- run（全文动作单例）

function emptyRun() {
  return {
    id: null,
    kind: null,
    status: 'idle',
    scope: 'book',
    chapter: null,
    sessionId: null,
    budget: { maxTokens: 200000, maxCostCNY: 20, usedTokens: 0, usedCostCNY: 0 },
    stages: [],
    notes: [],
    startedAt: null,
    finishedAt: null,
    createdAt: null,
    updatedAt: null,
  }
}

/** 读当前 run（缺失时返回 idle 空实例）。 */
export async function getRun(root = defaultRoot(), projectId) {
  const dir = await pdir(root, projectId, { create: false })
  const raw = await readJson(join(dir, 'runs.json'), null)
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...emptyRun(), ...raw }
  return emptyRun()
}

/** 更新 run（合并；stages/notes 传数组则替换，notes 传字符串则追加）。 */
export async function saveRun(root = defaultRoot(), projectId, patch = {}) {
  const dir = await pdir(root, projectId)
  const current = await getRun(root, projectId)
  const values = cleanPatch(patch)
  if (values.action !== undefined && values.kind === undefined) values.kind = values.action
  delete values.action
  if (values.status !== undefined && !RUN_STATUS.has(String(values.status))) {
    throw fail(`run 状态不合法：${values.status}`, 'bad-status')
  }
  const next = { ...current, ...values, updatedAt: nowIso() }
  if (!next.id) next.id = `run_${shortId()}`
  if (!next.createdAt) next.createdAt = next.updatedAt
  if (patch.budget && typeof patch.budget === 'object') next.budget = { ...current.budget, ...cleanPatch(patch.budget) }
  if (Array.isArray(patch.stages)) next.stages = patch.stages
  if (Array.isArray(patch.notes)) next.notes = patch.notes
  else if (typeof patch.notes === 'string' && patch.notes.trim()) next.notes = [...(current.notes ?? []), patch.notes.trim()]
  if (next.status === 'running' && !next.startedAt) next.startedAt = next.updatedAt
  if (['done', 'failed', 'aborted'].includes(String(next.status)) && !next.finishedAt) next.finishedAt = next.updatedAt
  if (next.status === 'idle') next.finishedAt = null
  await writeJson(join(dir, 'runs.json'), next)
  return next
}

/** 重置 run（回到 idle 空实例）。 */
export async function resetRun(root = defaultRoot(), projectId) {
  const dir = await pdir(root, projectId)
  const run = { ...emptyRun(), id: `run_${shortId()}`, createdAt: nowIso(), updatedAt: nowIso() }
  await writeJson(join(dir, 'runs.json'), run)
  return run
}

// ---------------------------------------------------------------- 账本

/** 读全部账本（world/presets 为单例与数组特例）。 */
export async function getLedger(root = defaultRoot(), projectId) {
  const dir = await pdir(root, projectId, { create: false })
  const ledger = {}
  for (const [kind, file] of Object.entries(KIND_FILES)) {
    const value = await readJson(join(dir, file), kind === 'presets' ? [] : [])
    ledger[kind] = Array.isArray(value) ? value : kind === 'presets' ? [] : value
  }
  const world = await readJson(join(dir, 'world.json'), {})
  ledger.world = world && typeof world === 'object' && !Array.isArray(world) ? world : {}
  return ledger
}

/** 新增或更新一条账本条目（按 id；地点缺 id 时按 name/aliases 对齐）。 */
export async function upsertLedgerItem(root = defaultRoot(), projectId, kind, item = {}) {
  const dir = await pdir(root, projectId)
  if (kind === 'world') {
    const current = (await getLedger(root, projectId)).world
    const next = { ...current, ...cleanPatch(item) }
    await writeJson(join(dir, 'world.json'), next)
    return next
  }
  const file = KIND_FILES[kind]
  if (!file) throw fail(`账本类型不支持：${kind}`, 'bad-kind')
  const path = join(dir, file)
  const list = await readJson(path, [])
  const rows = Array.isArray(list) ? list : []
  const values = cleanPatch(item)
  const now = nowIso()
  let index = values.id ? rows.findIndex((row) => String(row?.id) === String(values.id)) : -1
  if (index < 0 && kind === 'locations' && !values.id) {
    const name = String(values.name ?? '').trim()
    const aliases = Array.isArray(values.aliases) ? values.aliases.map(String) : []
    index = rows.findIndex((row) => {
      if (!row) return false
      const rowAliases = Array.isArray(row.aliases) ? row.aliases.map(String) : []
      return (name && row.name === name) || aliases.some((alias) => row.name === alias || rowAliases.includes(alias))
    })
  }
  const entry = {
    ...(index >= 0 ? rows[index] : {}),
    ...values,
    id: values.id ? String(values.id) : index >= 0 ? rows[index].id : shortId(),
    createdAt: index >= 0 ? rows[index]?.createdAt ?? now : now,
    updatedAt: now,
  }
  if (index >= 0) rows[index] = entry
  else rows.push(entry)
  await writeJson(path, rows)
  return entry
}

/** 删除一条账本条目。 */
export async function deleteLedgerItem(root = defaultRoot(), projectId, kind, itemId) {
  const dir = await pdir(root, projectId)
  const file = KIND_FILES[kind]
  if (!file) throw fail(`账本类型不支持：${kind}`, 'bad-kind')
  const path = join(dir, file)
  const list = await readJson(path, [])
  const rows = Array.isArray(list) ? list : []
  const next = rows.filter((row) => String(row?.id) !== String(itemId))
  if (next.length === rows.length) return { deleted: false, id: itemId }
  await writeJson(path, next)
  return { deleted: true, id: itemId }
}

// ---------------------------------------------------------------- 账本同步

const NUMBER_RE = /[0-9]+(?:\.[0-9]+)?/g

function tokenSet(text, pattern) {
  const out = new Set()
  const source = String(text ?? '')
  let match
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  while ((match = re.exec(source))) {
    if (match[0]) out.add(match[0])
    if (!re.lastIndex) break
  }
  return out
}

/**
 * 判断一次正文改动是否「碰到了账本关心的东西」。
 * 只做保守启发式：账本里出现过的人物/地点名是否新增或消失、数字（年龄/时间/数量）有没有变。
 * 不命中就什么都不记——没碰事实的改动不该打扰作者。
 * @returns {Promise<string[]>} 命中的原因列表（空数组 = 不需要同步）
 */
export async function ledgerSignals(root = defaultRoot(), projectId, beforeText, afterText) {
  const ledger = await getLedger(root, projectId)
  const before = String(beforeText ?? '')
  const after = String(afterText ?? '')
  if (before === after) return []
  const reasons = []
  const names = new Set()
  for (const row of Array.isArray(ledger.characters) ? ledger.characters : []) {
    if (row && row.name) names.add(String(row.name))
  }
  for (const row of Array.isArray(ledger.locations) ? ledger.locations : []) {
    if (row && row.name) names.add(String(row.name))
    if (row && Array.isArray(row.aliases)) row.aliases.forEach((alias) => alias && names.add(String(alias)))
  }
  for (const row of Array.isArray(ledger.facts) ? ledger.facts : []) {
    if (row && row.subject) names.add(String(row.subject))
  }
  for (const name of names) {
    if (!name || name.length < 2) continue
    const was = before.includes(name)
    const now = after.includes(name)
    if (was !== now) reasons.push(`账本里的「${name}」${now ? '新出现在' : '不再出现在'}正文里`)
  }
  const beforeNumbers = tokenSet(before, NUMBER_RE)
  const afterNumbers = tokenSet(after, NUMBER_RE)
  const added = [...afterNumbers].filter((n) => !beforeNumbers.has(n)).slice(0, 4)
  const removed = [...beforeNumbers].filter((n) => !afterNumbers.has(n)).slice(0, 4)
  if (added.length || removed.length) {
    reasons.push(`数字有变：${added.length ? `新增 ${added.join('、')}` : ''}${added.length && removed.length ? '；' : ''}${removed.length ? `消失 ${removed.join('、')}` : ''}`)
  }
  return reasons.slice(0, 6)
}

/** 读写账本同步状态：pending（改动信号）和 full（全书同步计划）互不覆盖。 */
async function readLedgerSyncFile(root, projectId) {
  const dir = await pdir(root, projectId, { create: false })
  const data = await readJson(join(dir, LEDGER_SYNC_FILE), { pending: [] })
  return {
    pending: Array.isArray(data?.pending) ? data.pending : [],
    full: data?.full && typeof data.full === 'object' ? data.full : null,
  }
}

async function writeLedgerSyncFile(root, projectId, next = {}) {
  const dir = await pdir(root, projectId)
  const pending = Array.isArray(next.pending) ? next.pending : []
  const full = next.full && typeof next.full === 'object' ? next.full : null
  await writeJson(join(dir, LEDGER_SYNC_FILE), full ? { pending, full } : { pending })
}

function batchChaptersOf(batch) {
  return Array.isArray(batch?.chapters) ? batch.chapters.map(Number).filter((n) => n > 0) : []
}

function batchKey(chapters) {
  return batchChaptersOf({ chapters }).join(',')
}

/** 把存盘的批次算成界面/工作单要的样子（章数、字数、完成状态、章节清单）。 */
function fullSyncView(full, chapterRows) {
  if (!full || !Array.isArray(full.batches) || full.batches.length === 0) return null
  const wordMap = new Map()
  for (const row of chapterRows) wordMap.set(Number(row.chapter), Number(row.words) || 0)
  const numbers = chapterRows.map((row) => Number(row.chapter)).filter((n) => n > 0)
  const batches = full.batches.map((batch, index) => {
    const chapters = batchChaptersOf(batch)
    const words = chapters.reduce((sum, n) => sum + (wordMap.get(n) || 0), 0)
    // 空批（章被删了）不算待同步，否则计划永远走不完
    const status = String(batch?.status ?? 'pending') === 'done' || chapters.length === 0 ? 'done' : 'pending'
    return {
      index: index + 1,
      chapters,
      from: chapters[0] ?? 0,
      to: chapters[chapters.length - 1] ?? 0,
      count: chapters.length,
      words,
      status,
      doneAt: batch?.doneAt ?? null,
    }
  })
  const covered = new Set(batches.flatMap((batch) => batch.chapters))
  const done = batches.filter((batch) => batch.status === 'done').length
  return {
    from: Number(full.from) || 0,
    to: Number(full.to) || 0,
    batchSize: Number(full.batchSize) || FULL_SYNC_BATCH,
    createdAt: full.createdAt ?? null,
    updatedAt: full.updatedAt ?? null,
    done,
    total: batches.length,
    // 计划建立后新写的章（或范围内被删的章）不在任何批次里：单独报出来，提示作者重建计划。
    // 计划起点之前的章是作者主动排除的，不算漏。
    uncovered: numbers.filter((n) => !covered.has(n) && n >= (Number(full.from) || 0)),
    batches,
  }
}

/** 记录「这一章改过、可能需要同步账本」。没有信号就直接返回 null，不改盘。 */
export async function noteChapterChange(root = defaultRoot(), projectId, chapter, beforeText, afterText) {
  const reasons = await ledgerSignals(root, projectId, beforeText, afterText)
  if (reasons.length === 0) return null
  const current = await readLedgerSyncFile(root, projectId)
  const number = Number(chapter) || 0
  const pending = current.pending.filter((row) => Number(row?.chapter) !== number)
  pending.push({ chapter: number, reasons, at: new Date().toISOString() })
  pending.sort((a, b) => Number(a.chapter) - Number(b.chapter))
  await writeLedgerSyncFile(root, projectId, { pending, full: current.full })
  return { chapter: number, reasons }
}

/**
 * 读账本同步状态：pending 待核对章 + full 全书同步进度 + chapters 章数。
 * @returns {Promise<{pending:Array, full:null|object, chapters:number}>}
 */
export async function getLedgerSync(root = defaultRoot(), projectId) {
  const data = await readLedgerSyncFile(root, projectId)
  let rows = []
  try {
    rows = await listChapters(root, projectId)
  } catch {
    rows = []
  }
  const titles = {}
  for (const row of rows) titles[Number(row.chapter)] = row.title
  return {
    pending: data.pending.map((row) => ({ ...row, title: titles[Number(row.chapter)] ?? '' })),
    full: fullSyncView(data.full, rows),
    chapters: rows.length,
  }
}

/** 标记这些章已核对（从待同步清单移除）；不传 chapters 就全部清空。 */
export async function ackLedgerSync(root = defaultRoot(), projectId, chapters) {
  const current = await readLedgerSyncFile(root, projectId)
  const drop = Array.isArray(chapters) && chapters.length > 0 ? new Set(chapters.map((n) => Number(n))) : null
  const next = drop ? current.pending.filter((row) => !drop.has(Number(row?.chapter))) : []
  await writeLedgerSyncFile(root, projectId, { pending: next, full: current.full })
  return { pending: next, cleared: current.pending.length - next.length }
}

/**
 * 建立/重建全书同步计划：把范围内的章节按 batchSize 切批，存进 ledger-sync.json。
 * 重算时按「批内章号完全相同」复用已完成状态，所以重建计划不会把已同步的批打回待同步。
 * @param {{from?:number,to?:number,batchSize?:number}} [options]
 */
export async function planLedgerSync(root = defaultRoot(), projectId, options = {}) {
  const rows = await listChapters(root, projectId)
  const numbers = rows.map((row) => Number(row.chapter)).filter((n) => n > 0).sort((a, b) => a - b)
  if (numbers.length === 0) throw fail('作品还没有正文章节，没法建立全书同步计划')
  const from = Number(options.from) > 0 ? Math.floor(Number(options.from)) : numbers[0]
  const to = Number(options.to) > 0 ? Math.floor(Number(options.to)) : numbers[numbers.length - 1]
  const batchSize = Math.min(FULL_SYNC_BATCH_MAX, Math.max(1, Math.round(Number(options.batchSize) || FULL_SYNC_BATCH)))
  const inRange = numbers.filter((n) => n >= from && n <= to)
  if (inRange.length === 0) throw fail(`第 ${from}–${to} 章之间还没有正文，没法建立同步计划`)
  const current = await readLedgerSyncFile(root, projectId)
  const previous = new Map()
  for (const batch of Array.isArray(current.full?.batches) ? current.full.batches : []) {
    if (String(batch?.status ?? '') === 'done') previous.set(batchKey(batch.chapters), batch.doneAt ?? null)
  }
  const batches = []
  for (let offset = 0; offset < inRange.length; offset += batchSize) {
    const chapters = inRange.slice(offset, offset + batchSize)
    const key = batchKey(chapters)
    const done = previous.has(key)
    batches.push({ chapters, status: done ? 'done' : 'pending', doneAt: done ? previous.get(key) : null })
  }
  const now = nowIso()
  await writeLedgerSyncFile(root, projectId, {
    pending: current.pending,
    full: { from, to, batchSize, createdAt: current.full?.createdAt ?? now, updatedAt: now, batches },
  })
  return getLedgerSync(root, projectId)
}

/** 标记某一批（默认第一个未完成批）已同步；顺手把这批章节从待核对清单里去掉。 */
export async function completeLedgerSyncBatch(root = defaultRoot(), projectId, options = {}) {
  const current = await readLedgerSyncFile(root, projectId)
  if (!current.full) throw fail('还没有全书同步计划，请先建立计划（action=plan）')
  const batches = Array.isArray(current.full.batches) ? current.full.batches : []
  const wanted = Math.floor(Number(options.batch) || 0)
  const index = wanted > 0 ? wanted - 1 : batches.findIndex((batch) => String(batch?.status ?? 'pending') !== 'done')
  if (index < 0 || index >= batches.length) throw fail('没有待同步的批次（可能已经全部同步）')
  const now = nowIso()
  const next = batches.map((batch, i) => (i === index ? { ...batch, status: 'done', doneAt: now } : batch))
  const synced = new Set(batchChaptersOf(batches[index]))
  const pending = current.pending.filter((row) => !synced.has(Number(row?.chapter)))
  await writeLedgerSyncFile(root, projectId, { pending, full: { ...current.full, updatedAt: now, batches: next } })
  return getLedgerSync(root, projectId)
}

/** 清掉全书同步计划（待核对的改动信号保留）。 */
export async function resetLedgerSync(root = defaultRoot(), projectId) {
  const current = await readLedgerSyncFile(root, projectId)
  await writeLedgerSyncFile(root, projectId, { pending: current.pending, full: null })
  return getLedgerSync(root, projectId)
}

// ---------------------------------------------------------------- 导出（正文成品）

/**
 * 收集导出用的 bundle：作品 + 全部章节正文（按章号升序，读不到的章节跳过）。
 * @param {string} root
 * @param {string} projectId
 * @param {{ includeSummary?: boolean }} [options]
 * @returns {Promise<{project: object, chapters: Array<{chapter:number,title:string,content:string,summary:string}>, includeSummary:boolean}>}
 */
export async function exportBundle(root = defaultRoot(), projectId, options = {}) {
  const project = await getProject(root, projectId)
  const list = await listChapters(root, projectId)
  const chapters = []
  for (const row of list) {
    try {
      const chapter = await readChapter(root, projectId, row.chapter)
      chapters.push({
        chapter: row.chapter,
        title: String(chapter.meta.title || row.title || '').trim(),
        content: String(chapter.text ?? ''),
        summary: String(chapter.meta.summary ?? ''),
      })
    } catch {
      // 单章损坏不拖垮整本导出
    }
  }
  return { project, chapters, includeSummary: options.includeSummary === true }
}

/**
 * 导出正文成品。format: 'txt' | 'md' | 'epub' | 'docx'。
 *
 * 返回值统一带 { filename, mime, format, chapters, words, includeSummary }：
 * - txt / md 是可直接读的文本，放在 `text`；
 * - epub / docx 是二进制，放在 `base64`（JSON 通道无法原样传 Buffer）。
 *
 * @returns {Promise<{filename:string,mime:string,format:string,chapters:number,words:number,text?:string,base64?:string}>}
 */
export async function exportBook(root = defaultRoot(), projectId, format = 'txt', options = {}) {
  const fmt = normalizeFormat(format)
  const bundle = await exportBundle(root, projectId, options)
  const project = bundle.project ?? {}
  const meta = EXPORT_META[fmt]
  const words = bundle.chapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0)
  const base = {
    filename: bookFilename(project.title ?? project.name, meta.ext),
    mime: meta.mime,
    format: fmt,
    chapters: bundle.chapters.length,
    words,
    includeSummary: bundle.includeSummary,
  }
  if (fmt === 'txt') return { ...base, text: buildBookText(bundle) }
  if (fmt === 'md') return { ...base, text: buildBookMarkdown(bundle) }
  const buffer = fmt === 'epub' ? buildEpub(bundle) : buildDocx(bundle)
  return { ...base, base64: buffer.toString('base64') }
}

// ---------------------------------------------------------------- 设置 / 用量

/** 读设置：作品 + 预设 + 预算 + 数据目录。 */
export async function getSettings(root = defaultRoot(), projectId) {
  const project = await getProject(root, projectId)
  const ledger = await getLedger(root, projectId)
  const budget = {
    maxTokens: Number(project.budget?.maxTokens) || 200000,
    maxCostCNY: Number(project.budget?.maxCostCNY) || 20,
  }
  return {
    project,
    presets: ledger.presets.length ? ledger.presets : defaultPresets(),
    budget,
    dataRoot: root,
    projectDir: join(root, 'projects', projectId),
  }
}

/** 写设置：{ project?, presets?, budget? } 或直接给作品字段。 */
export async function saveSettings(root = defaultRoot(), projectId, patch = {}) {
  const dir = await pdir(root, projectId)
  const values = cleanPatch(patch)
  const projectPatch = values.project && typeof values.project === 'object' ? values.project : {}
  const direct = Object.fromEntries(Object.entries(values).filter(([key]) => !['project', 'presets', 'budget'].includes(key)))
  let project = await updateProject(root, projectId, { ...direct, ...projectPatch })
  if (values.budget && typeof values.budget === 'object') {
    project = await updateProject(root, projectId, { budget: { ...(project.budget ?? {}), ...cleanPatch(values.budget) } })
  }
  if (Array.isArray(values.presets)) await writeJson(join(dir, 'presets.json'), values.presets)
  return getSettings(root, projectId)
}

/** 用量汇总（usage.json；0.5.x 记录原样兼容）。 */
export async function usageSummary(root = defaultRoot(), projectId) {
  const dir = await pdir(root, projectId, { create: false })
  const list = await readJson(join(dir, 'usage.json'), [])
  const rows = Array.isArray(list) ? list : []
  const out = {
    calls: rows.length,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costCNY: 0,
    lastAt: null,
    byTask: {},
  }
  for (const row of rows) {
    const input = Number(row?.inputTokens) || 0
    const output = Number(row?.outputTokens) || 0
    const cacheRead = Number(row?.cacheReadTokens) || 0
    const cacheWrite = Number(row?.cacheWriteTokens) || 0
    const total = Number(row?.totalTokens) || input + output + cacheRead + cacheWrite
    out.inputTokens += input
    out.outputTokens += output
    out.cacheReadTokens += cacheRead
    out.cacheWriteTokens += cacheWrite
    out.tokens += total
    out.costCNY += Number(row?.costCNY) || 0
    if (row?.at && (!out.lastAt || String(row.at) > out.lastAt)) out.lastAt = String(row.at)
    const task = String(row?.task ?? 'other')
    if (!out.byTask[task]) out.byTask[task] = { calls: 0, tokens: 0 }
    out.byTask[task].calls += 1
    out.byTask[task].tokens += total
  }
  out.costCNY = Math.round(out.costCNY * 10000) / 10000
  return out
}
