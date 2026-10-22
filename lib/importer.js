/**
 * 导入现有作品：识别「作品包」，导入章节 + 人物卡 + 大纲 + 追踪 + 写作规范。
 *
 * 作品包识别：
 *   正文/ 或 chapters/       → 章节
 *   wiki/entities/、entities/、人物/、characters/ → 人物卡
 *   大纲.md、wiki/raw/大纲.md → 章节大纲
 *   追踪.md、wiki/raw/追踪.md → 时间线 / 事实 / 伏笔 / 章节元信息
 *   章回体写作规范.md、写作规范.md → 预设
 *   故事线.md → 冲突
 *
 * 章节切分（split）：
 *   auto（默认）：一个文件一章；整本单文件含多个 # 标题时按 # 切
 *   file：严格一个文件一章
 *   h1：按一级标题切
 *   ## 小节永远留在正文里。
 *
 * 其他：递归深度 5、跳过隐藏目录/node_modules/.git；按文件名里的中文/阿拉伯章号排序；
 * H1 作章节标题；忽略 frontmatter；空章节跳过；append 模式续号不覆盖。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  addPresetFromTemplate,
  appendImportRecord,
  countWords,
  createProject,
  getBundle,
  listProjects,
  saveChapter,
  updateChapterMeta,
  upsertEntity,
} from './store.js'

const MAX_DEPTH = 5
const SKIP_DIRS = new Set(['node_modules', '.git'])
const ASSET_DIRS = new Set(['wiki', '设定', 'entities', '人物', 'characters', 'character', '.obsidian', '.trash'])
const ASSET_FILES = new Set(['大纲.md', 'outline.md', 'outlines.md', '追踪.md', 'tracking.md', '写作规范.md', '章回体写作规范.md', '故事线.md'])
const CHAPTER_DIR_NAMES = ['正文', 'chapters', '章节', '正文目录']
const CHARACTER_DIRS = ['wiki/entities', 'entities', '人物', 'characters', 'character', '设定/人物']
const OUTLINE_FILES = ['wiki/raw/大纲.md', '大纲.md', 'outline.md', '设定/大纲.md', 'outlines.md']
const TRACKING_FILES = ['wiki/raw/追踪.md', '追踪.md', '设定/追踪.md', 'tracking.md']
const RULES_FILES = ['wiki/raw/章回体写作规范.md', 'wiki/raw/写作规范.md', '写作规范.md', '设定/写作规范.md']
const STORYLINE_FILES = ['wiki/raw/故事线.md', '故事线.md', '设定/故事线.md']

// ── 基础工具 ──────────────────────────────────────────────────

function normalize(text) {
  return String(text ?? '').replace(/\r\n/g, '\n')
}

/** 去掉文首 YAML frontmatter。 */
function stripFrontmatter(text) {
  const source = normalize(text)
  const match = /^---\n[\s\S]*?\n---\n?/.exec(source)
  return match ? source.slice(match[0].length) : source
}

/** 解析 frontmatter 的 title / tags（够用即可）。 */
function parseFrontmatter(text) {
  const source = normalize(text)
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source)
  if (!match) return { meta: {}, body: source }
  const meta = {}
  let currentKey = null
  for (const line of match[1].split('\n')) {
    const item = /^\s*-\s+(.+)$/.exec(line)
    if (item && currentKey) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = []
      meta[currentKey].push(item[1].trim())
      continue
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) {
      currentKey = kv[1]
      const raw = kv[2].trim()
      if (raw === '') meta[currentKey] = []
      else if (/^\[.*\]$/.test(raw)) meta[currentKey] = raw.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      else meta[currentKey] = raw.replace(/^["']|["']$/g, '')
    }
  }
  return { meta, body: source.slice(match[0].length) }
}

function fileTitle(file) {
  return basename(file).replace(/\.(md|markdown)$/i, '')
}

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 }

function cnToNumber(input) {
  const s = String(input ?? '').trim()
  if (/^\d+$/.test(s)) return Number(s)
  let section = 0
  let number = 0
  let seen = false
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch]
      seen = true
    } else if (ch in CN_UNITS) {
      if (number === 0) number = 1
      section += number * CN_UNITS[ch]
      number = 0
      seen = true
    } else {
      return null
    }
  }
  return seen ? section + number : null
}

function chapterNumberFromText(text) {
  const m = /第\s*([0-9〇零一二三四五六七八九十百千两]+)\s*[章回节卷]/.exec(String(text ?? ''))
  if (!m) return null
  return cnToNumber(m[1])
}

function chapterNumberFromName(file) {
  return chapterNumberFromText(fileTitle(file))
}

function compareFiles(a, b) {
  const na = chapterNumberFromName(a)
  const nb = chapterNumberFromName(b)
  if (na !== null && nb !== null && na !== nb) return na - nb
  if (na !== null && nb === null) return -1
  if (na === null && nb !== null) return 1
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
}

async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function walkMarkdown(dir, depth, files, root = dir) {
  if (depth > MAX_DEPTH) return
  const entries = await listDir(dir)
  entries.sort((a, b) => compareFiles(a.name, b.name))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      // 根目录递归时跳过资产目录（wiki/、设定/、人物/ 等），避免把设定当正文
      if (dir === root && ASSET_DIRS.has(entry.name)) continue
      await walkMarkdown(full, depth + 1, files, root)
    } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
      if (dir === root && ASSET_FILES.has(entry.name)) continue
      files.push(full)
    }
  }
}

async function firstExistingFile(baseDir, candidates) {
  for (const rel of candidates) {
    const full = join(baseDir, rel)
    try {
      const info = await stat(full)
      if (info.isFile()) return full
    } catch {
      /* continue */
    }
  }
  return null
}

async function firstExistingDir(baseDir, candidates) {
  for (const rel of candidates) {
    const full = join(baseDir, rel)
    try {
      const info = await stat(full)
      if (info.isDirectory()) return full
    } catch {
      /* continue */
    }
  }
  return null
}

// ── 章节切分 ──────────────────────────────────────────────────

/**
 * 把一个 Markdown 文件切成章节片段。
 * @param {string} text
 * @param {string} fallbackTitle
 * @param {'auto'|'file'|'h1'} splitMode
 */
function splitFile(text, fallbackTitle, splitMode = 'auto') {
  const source = stripFrontmatter(text)
  const lines = source.split('\n')
  const h1 = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^#[ \t]+(.+?)[ \t#]*$/.exec(lines[i])
    if (m) h1.push({ index: i, title: m[1].trim() })
  }

  const oneFile = () => {
    if (h1.length === 0) return [{ title: fallbackTitle, content: source.trim() }]
    const first = h1[0]
    const before = lines.slice(0, first.index).join('\n')
    const after = lines.slice(first.index + 1).join('\n')
    return [{ title: first.title || fallbackTitle, content: `${before}\n${after}`.trim() }]
  }

  const splitByH1 = () => {
    if (h1.length === 0) return oneFile()
    const out = []
    const preface = lines.slice(0, h1[0].index).join('\n').trim()
    for (let k = 0; k < h1.length; k += 1) {
      const start = h1[k].index + 1
      const end = k + 1 < h1.length ? h1[k + 1].index : lines.length
      let content = lines.slice(start, end).join('\n').trim()
      if (k === 0 && preface) content = preface + '\n\n' + content
      out.push({ title: h1[k].title || `${fallbackTitle} ${k + 1}`, content })
    }
    return out
  }

  if (splitMode === 'file') return oneFile()
  if (splitMode === 'h1') return splitByH1()
  return h1.length >= 2 ? splitByH1() : oneFile()
}

// ── 作品包识别 ────────────────────────────────────────────────

async function detectPackage(inputPath) {
  const raw = String(inputPath ?? '').trim()
  if (!raw) throw new Error('缺少导入路径')
  const target = resolve(raw)
  let info
  try {
    info = await stat(target)
  } catch {
    throw new Error(`路径不存在：${target}`)
  }

  if (info.isFile()) {
    return {
      target,
      root: dirname(target),
      chapterDir: null,
      singleFile: target,
      characterDirs: [],
      outlineFile: null,
      trackingFile: null,
      rulesFile: null,
      storylineFile: null,
    }
  }
  if (!info.isDirectory()) throw new Error(`不是 Markdown 文件或目录：${target}`)

  let root = target
  let chapterDir = null
  if (CHAPTER_DIR_NAMES.includes(basename(target))) {
    root = dirname(target)
    chapterDir = target
  } else {
    chapterDir = await firstExistingDir(root, CHAPTER_DIR_NAMES)
  }

  const characterDirs = []
  for (const rel of CHARACTER_DIRS) {
    const dir = join(root, rel)
    try {
      if ((await stat(dir)).isDirectory()) characterDirs.push(dir)
    } catch {
      /* continue */
    }
  }

  return {
    target,
    root,
    chapterDir: chapterDir ?? root,
    singleFile: null,
    characterDirs,
    outlineFile: await firstExistingFile(root, OUTLINE_FILES),
    trackingFile: await firstExistingFile(root, TRACKING_FILES),
    rulesFile: await firstExistingFile(root, RULES_FILES),
    storylineFile: await firstExistingFile(root, STORYLINE_FILES),
  }
}

// ── 资产解析 ──────────────────────────────────────────────────

function mapRole(tags) {
  const list = Array.isArray(tags) ? tags : []
  if (list.includes('protagonist')) return 'protagonist'
  if (list.includes('antagonist')) return 'antagonist'
  if (list.includes('supporting')) return 'supporting'
  if (list.includes('minor')) return 'minor'
  return 'supporting'
}

function parseCharacterCard(text, file) {
  const { meta, body } = parseFrontmatter(text)
  const titleMatch = /^#{1,3}[ \t]+(.+?)[ \t#]*$/m.exec(body)
  const name = String(meta.title ?? titleMatch?.[1] ?? fileTitle(file)).trim()
  const sections = {}
  let current = null
  for (const line of body.split('\n')) {
    const h = /^#{2,4}[ \t]+(.+?)[ \t#]*$/.exec(line)
    if (h) {
      current = h[1].trim()
      sections[current] = []
    } else if (current) {
      sections[current].push(line)
    }
  }
  const pick = (names) => {
    for (const key of names) {
      if (sections[key] && sections[key].length > 0) return sections[key].join('\n').trim()
    }
    return ''
  }
  const tags = Array.isArray(meta.tags) ? meta.tags : []
  const identity = pick(['身份', '背景'])
  const personality = pick(['性格', '性格特点'])
  const appearance = pick(['外貌', '容貌'])
  const arc = pick(['人物弧光', '弧光'])
  const martial = pick(['武学', '武功'])
  const known = [identity, personality, appearance, arc, martial].filter(Boolean).join('\n')
  return {
    name,
    role: mapRole(tags),
    personality: personality.slice(0, 1200),
    appearance: appearance.slice(0, 800),
    arc: arc.slice(0, 1200),
    note: (identity || known || body).slice(0, 800),
    tags,
    source: 'import',
  }
}

function parseOutlines(text) {
  const lines = stripFrontmatter(text).split('\n')
  const out = []
  let current = null
  for (const line of lines) {
    const m = /^-\s*第\s*([0-9〇零一二三四五六七八九十百千两]+)\s*回\s*[：:]\s*(.+)$/.exec(line)
    if (m) {
      current = { chapter: cnToNumber(m[1]), title: m[2].trim(), summary: '' }
      out.push(current)
      continue
    }
    if (/^第\s*[一二三四五六七八九十百]+\s*卷/.test(line.trim())) {
      current = null
      continue
    }
    if (current && line.trim()) current.summary += line.replace(/^\s*-\s*/, '').trim() + '\n'
  }
  return out.filter((item) => Number.isFinite(item.chapter)).map((item) => ({
    chapter: item.chapter,
    title: item.title,
    summary: item.summary.trim(),
    status: 'planned',
    source: 'import',
  }))
}

function parsePeopleLine(line) {
  const entries = []
  const re = /([^、，,（）()]+)[（(]([^）)]*)[）)]/g
  let m
  while ((m = re.exec(String(line ?? ''))) !== null) {
    entries.push({ name: m[1].trim(), detail: m[2].trim() })
  }
  return entries.filter((entry) => entry.name)
}

function factsFromPerson(entry, chapter) {
  const facts = []
  for (const part of entry.detail.split(/[，,]/).map((s) => s.trim()).filter(Boolean)) {
    if (/岁/.test(part)) facts.push({ subject: entry.name, attribute: '年龄', value: part, chapter, source: 'import' })
    else if (/派|门|寺|帮|教|家/.test(part)) facts.push({ subject: entry.name, attribute: '门派/身份', value: part, chapter, source: 'import' })
    else if (/佩|持|带|怀/.test(part)) facts.push({ subject: entry.name, attribute: '随身物品', value: part, chapter, source: 'import' })
  }
  return facts
}

function parseTracking(text) {
  const source = stripFrontmatter(text)
  const lines = source.split('\n')
  const sections = []
  let current = null
  for (const line of lines) {
    const h = /^##\s*第\s*([0-9〇零一二三四五六七八九十百千两]+)\s*回(?:\s+(.*))?$/.exec(line)
    if (h) {
      current = { chapter: cnToNumber(h[1]), title: (h[2] ?? '').trim(), fields: {}, bullets: {} }
      sections.push(current)
      continue
    }
    if (!current) continue
    const f = /^(时间|地点|人物|事件|物品|伏笔|人物路线)\s*[：:]\s*(.*)$/.exec(line.trim())
    if (f) {
      current.fields[f[1]] = f[2].trim()
      continue
    }
    const b = /^[-*]\s+(.+)$/.exec(line.trim())
    if (b) {
      const lastField = Object.keys(current.fields).at(-1)
      if (lastField) {
        if (!current.bullets[lastField]) current.bullets[lastField] = []
        current.bullets[lastField].push(b[1].trim())
      }
    }
  }

  const events = []
  const facts = []
  const foreshadow = []
  const chapterMeta = {}
  for (const section of sections) {
    const { chapter, title } = section
    if (!Number.isFinite(chapter)) continue
    const storyTime = section.fields['时间'] ?? ''
    const location = section.fields['地点'] ?? ''
    const peopleRaw = String(section.fields['人物'] ?? '')
    const peopleEntries = parsePeopleLine(peopleRaw)
    const people = peopleEntries.length > 0
      ? peopleEntries.map((entry) => entry.name)
      : peopleRaw.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)
    chapterMeta[chapter] = {
      storyTime: storyTime.split(/[；;]/)[0].slice(0, 80),
      location: location.slice(0, 80),
      characters: people,
    }

    const eventBullets = section.bullets['事件'] ?? []
    if (eventBullets.length > 0) {
      for (const bullet of eventBullets) {
        events.push({
          title: bullet.slice(0, 40),
          chapter,
          storyTime,
          location,
          participants: people,
          summary: bullet,
          source: 'import',
        })
      }
    } else if (title) {
      events.push({ title, chapter, storyTime, location, participants: people, summary: '', source: 'import' })
    }

    for (const bullet of section.bullets['伏笔'] ?? []) {
      foreshadow.push({ title: bullet.slice(0, 60), setupChapter: chapter, payoffChapter: 0, status: 'open', note: bullet, source: 'import' })
    }

    for (const entry of parsePeopleLine(section.fields['人物'])) {
      facts.push(...factsFromPerson(entry, chapter))
    }
    for (const item of String(section.fields['物品'] ?? '').split(/[、,，]/).map((s) => s.trim()).filter(Boolean)) {
      facts.push({ subject: item, attribute: '首次出现', value: `第${chapter}回`, chapter, source: 'import' })
    }
  }
  return { events, facts, foreshadow, chapterMeta }
}

function parseRulesPreset(text) {
  const body = stripFrontmatter(text)
  const bullets = body.split('\n').map((line) => line.trim()).filter((line) => /^[-*]\s+/.test(line)).map((line) => line.replace(/^[-*]\s+/, ''))
  const taboo = bullets.filter((item) => /禁止|避免|不要|忌/.test(item)).slice(0, 10)
  const styleRules = bullets.filter((item) => !taboo.includes(item)).slice(0, 12)
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
  return {
    name: `导入预设 · ${title || '写作规范'}`,
    genre: '章回体',
    pov: '第三人称全知',
    tense: '过去时',
    tone: '',
    structure: '章回体：回目对仗、开篇七律、3–4 节、回末套语',
    styleRules,
    taboo,
    reviewFocus: ['回目', '七律', '分节', '回末', '文风', '史实'],
    source: 'import',
  }
}

function parseStorylineConflicts(text) {
  const body = stripFrontmatter(text)
  const out = []
  let current = null
  for (const line of body.split('\n')) {
    const h = /^#{2,3}\s+(.+)$/.exec(line)
    if (h) {
      current = { title: h[1].trim(), type: 'society', status: 'active', stakes: '', escalation: '', source: 'import' }
      out.push(current)
      continue
    }
    if (current && line.trim()) current.escalation += line.trim() + '\n'
  }
  return out.map((item) => ({ ...item, escalation: item.escalation.trim().slice(0, 500) }))
}

// ── 扫描 / 导入 ───────────────────────────────────────────────

async function readPackage(inputPath, splitMode) {
  const pkg = await detectPackage(inputPath)
  const filePaths = []
  if (pkg.singleFile) {
    filePaths.push(pkg.singleFile)
  } else {
    await walkMarkdown(pkg.chapterDir, 0, filePaths, pkg.chapterDir)
  }
  filePaths.sort(compareFiles)

  const files = []
  const chapters = []
  const skipped = []
  for (const file of filePaths) {
    const text = await readFile(file, 'utf8')
    const relPath = relative(pkg.root, file) || basename(file)
    files.push({ file, relPath, words: countWords(stripFrontmatter(text)) })
    for (const piece of splitFile(text, fileTitle(file), splitMode)) {
      const words = countWords(piece.content)
      if (words === 0) {
        skipped.push({ title: piece.title, source: relPath, reason: '空章节' })
        continue
      }
      chapters.push({ title: piece.title, content: piece.content, words, source: relPath })
    }
  }

  const characters = []
  for (const dir of pkg.characterDirs) {
    const entries = await listDir(dir)
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(md|markdown)$/i.test(entry.name)) continue
      const file = join(dir, entry.name)
      const card = parseCharacterCard(await readFile(file, 'utf8'), file)
      if (card.name) characters.push({ ...card, sourceFile: relative(pkg.root, file) })
    }
  }

  const outlines = pkg.outlineFile ? parseOutlines(await readFile(pkg.outlineFile, 'utf8')) : []
  const tracking = pkg.trackingFile
    ? parseTracking(await readFile(pkg.trackingFile, 'utf8'))
    : { events: [], facts: [], foreshadow: [], chapterMeta: {} }
  const preset = pkg.rulesFile ? parseRulesPreset(await readFile(pkg.rulesFile, 'utf8')) : null
  const conflicts = pkg.storylineFile ? parseStorylineConflicts(await readFile(pkg.storylineFile, 'utf8')) : []

  return {
    path: pkg.target,
    root: pkg.root,
    chapterDir: pkg.chapterDir,
    split: splitMode,
    isFile: Boolean(pkg.singleFile),
    files,
    chapters,
    skipped,
    characters,
    outlines,
    events: tracking.events,
    facts: tracking.facts,
    foreshadow: tracking.foreshadow,
    chapterMeta: tracking.chapterMeta,
    preset,
    conflicts,
    detected: {
      chapters: chapters.length > 0,
      characters: pkg.characterDirs.length > 0,
      outlines: Boolean(pkg.outlineFile),
      tracking: Boolean(pkg.trackingFile),
      rules: Boolean(pkg.rulesFile),
      storylines: Boolean(pkg.storylineFile),
    },
    totalWords: chapters.reduce((sum, chapter) => sum + chapter.words, 0),
  }
}

/** 扫描目录/文件，返回导入预览（不写任何数据）。 */
export async function scanImport(root, dirPath, options = {}) {
  void root
  const splitMode = ['auto', 'file', 'h1'].includes(options.split) ? options.split : 'auto'
  const parsed = await readPackage(dirPath, splitMode)
  return {
    path: parsed.path,
    root: parsed.root,
    chapterDir: parsed.chapterDir,
    split: parsed.split,
    isFile: parsed.isFile,
    files: parsed.files,
    chapters: parsed.chapters.map((chapter, index) => ({
      index: index + 1,
      title: chapter.title,
      words: chapter.words,
      source: chapter.source,
    })),
    characters: parsed.characters.map((character) => ({ name: character.name, role: character.role, sourceFile: character.sourceFile })),
    outlines: parsed.outlines.map((outline) => ({ chapter: outline.chapter, title: outline.title })),
    events: parsed.events.length,
    facts: parsed.facts.length,
    foreshadow: parsed.foreshadow.length,
    preset: parsed.preset ? parsed.preset.name : null,
    conflicts: parsed.conflicts.length,
    detected: parsed.detected,
    totalWords: parsed.totalWords,
    counts: {
      chapters: parsed.chapters.length,
      characters: parsed.characters.length,
      outlines: parsed.outlines.length,
      events: parsed.events.length,
      facts: parsed.facts.length,
      foreshadow: parsed.foreshadow.length,
      presets: parsed.preset ? 1 : 0,
      conflicts: parsed.conflicts.length,
    },
    skipped: parsed.skipped,
  }
}

/**
 * 执行导入：章节 + 人物卡 + 大纲 + 事件/事实/伏笔 + 预设 + 冲突。
 */
export async function runImport(root, input = {}) {
  const mode = String(input.mode ?? 'new').trim() === 'append' ? 'append' : 'new'
  const splitMode = ['auto', 'file', 'h1'].includes(input.split) ? input.split : 'auto'
  const parsed = await readPackage(input.path, splitMode)
  if (parsed.chapters.length === 0) throw new Error('没有找到可导入的章节（目录里没有 Markdown 文件或章节为空）')

  let project
  let existing = []
  if (mode === 'append') {
    let projectId = String(input.projectId ?? '').trim()
    if (!projectId) {
      const key = String(input.projectName ?? '').trim()
      if (key) {
        const hit = (await listProjects(root)).find((p) => p.id === key || p.name === key)
        if (hit) projectId = hit.id
      }
    }
    if (!projectId) throw new Error('追加导入需要指定 projectId')
    const bundle = await getBundle(root, projectId)
    project = bundle.project
    existing = bundle.chapters
  } else {
    const fallbackName = basename(parsed.root) || '导入作品'
    project = await createProject(root, {
      name: String(input.projectName ?? '').trim() || fallbackName,
      genre: String(input.genre ?? '').trim(),
      description: `从 ${parsed.root} 导入的作品包`,
      rootPath: parsed.root,
    })
  }

  let next = existing.reduce((max, chapter) => Math.max(max, Number(chapter.id) || 0), 0) + 1
  const imported = []
  const chapterIdByNumber = new Map()
  for (const chapter of parsed.chapters) {
    const id = String(next).padStart(4, '0')
    const saved = await saveChapter(root, project.id, {
      id,
      title: chapter.title,
      status: 'draft',
      summary: '',
      content: chapter.content,
    })
    imported.push({ id: saved.id, title: saved.title, words: saved.words })
    const number = chapterNumberFromText(chapter.title) ?? (next - existing.length)
    chapterIdByNumber.set(number, saved.id)
    next += 1
  }

  let metaUpdated = 0
  for (const [number, meta] of Object.entries(parsed.chapterMeta)) {
    const id = chapterIdByNumber.get(Number(number))
    if (!id) continue
    await updateChapterMeta(root, project.id, id, meta)
    metaUpdated += 1
  }

  const counts = { characters: 0, outlines: 0, events: 0, facts: 0, foreshadow: 0, conflicts: 0, presets: 0 }
  for (const character of parsed.characters) {
    await upsertEntity(root, project.id, 'characters', character)
    counts.characters += 1
  }
  for (const outline of parsed.outlines) {
    await upsertEntity(root, project.id, 'outlines', outline)
    counts.outlines += 1
  }
  for (const event of parsed.events) {
    await upsertEntity(root, project.id, 'events', event)
    counts.events += 1
  }
  for (const fact of parsed.facts) {
    await upsertEntity(root, project.id, 'facts', fact)
    counts.facts += 1
  }
  for (const item of parsed.foreshadow) {
    await upsertEntity(root, project.id, 'foreshadow', item)
    counts.foreshadow += 1
  }
  for (const conflict of parsed.conflicts) {
    await upsertEntity(root, project.id, 'conflicts', conflict)
    counts.conflicts += 1
  }
  if (parsed.preset) {
    await addPresetFromTemplate(root, project.id, parsed.preset)
    counts.presets = 1
  }

  const record = await appendImportRecord(root, project.id, {
    path: parsed.path,
    root: parsed.root,
    split: splitMode,
    mode,
    counts: { ...counts, chapters: imported.length, chapterMeta: metaUpdated },
    detected: parsed.detected,
  })

  return {
    projectId: project.id,
    projectName: project.name,
    chapters: imported,
    skipped: parsed.skipped,
    counts: { ...counts, chapters: imported.length, chapterMeta: metaUpdated },
    detected: parsed.detected,
    importId: record.id,
  }
}
