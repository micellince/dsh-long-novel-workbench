/**
 * 故事工作台 · 数据层
 *
 * 全部是普通文件，放在 ~/StoryDesk（可用 STORY_DESK_ROOT 覆盖）：
 *   library.json                 作品库索引
 *   projects/<id>/project.json   作品元信息
 *   projects/<id>/chapters/*.md  章节（frontmatter + 正文）
 *   projects/<id>/facts.json     事实账本
 *   projects/<id>/events.json    事件（时间线）
 *   projects/<id>/foreshadow.json 伏笔
 *   projects/<id>/conflicts.json 冲突
 *   projects/<id>/characters.json 人物
 *   projects/<id>/highlights.json 高光
 *   projects/<id>/presets.json   写作预设
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { computeAlignment, runChecks } from './checks.js'
import { defaultAgents, defaultPresets } from './defaults.js'
import { buildDocx, buildEpub } from './exporters.js'

/** 工作台数据根目录。 */
export function defaultRoot() {
  return process.env.STORY_DESK_ROOT || join(homedir(), 'StoryDesk')
}

/** 结构化数据种类 → 文件名。 */
export const KIND_FILES = {
  facts: 'facts.json',
  events: 'events.json',
  foreshadow: 'foreshadow.json',
  conflicts: 'conflicts.json',
  characters: 'characters.json',
  highlights: 'highlights.json',
  presets: 'presets.json',
  outlines: 'outlines.json',
  reviews: 'reviews.json',
  proposals: 'proposals.json',
  agents: 'agents.json',
}

export const KINDS = Object.keys(KIND_FILES)

function nowIso() {
  return new Date().toISOString()
}

function shortId() {
  return randomUUID().replace(/-/g, '').slice(0, 10)
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, path)
}

/** 原子写文本：先写临时文件再 rename，避免半截文件。 */
async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

function projectDir(root, id) {
  return join(root, 'projects', id)
}

/** 中英文混合字数：CJK 按字，拉丁按词。 */
export function countWords(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length
  const latin = (s.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length
  return cjk + latin
}

// ── 作品库 ────────────────────────────────────────────────────

/** 读取作品库索引。 */
export async function listProjects(root = defaultRoot()) {
  const lib = await readJson(join(root, 'library.json'), { projects: [] })
  if (!Array.isArray(lib.projects)) return []
  return lib.projects
}

async function saveLibrary(root, projects) {
  await writeJson(join(root, 'library.json'), { version: 1, projects })
}

async function ensureProjectSkeleton(root, id) {
  const dir = projectDir(root, id)
  await mkdir(join(dir, 'chapters'), { recursive: true })
  for (const kind of KINDS) {
    const path = join(dir, KIND_FILES[kind])
    const current = await readJson(path, null)
    if (!Array.isArray(current)) await writeJson(path, [])
  }
  // 内置默认：写作方案 + 9 个 Agent 分工（仅当为空时写入，不覆盖作者改动）
  const presetPath = join(dir, KIND_FILES.presets)
  const existingPresets = await readJson(presetPath, [])
  if (existingPresets.length === 0) {
    const presets = defaultPresets().map((p) => ({ ...p, createdAt: nowIso(), updatedAt: nowIso() }))
    await writeJson(presetPath, presets)
  } else {
    // 老数据迁移：补齐计划章数 / 每章字数 / 总字数 / 结构 / 审稿重点
    const meta = await readJson(join(dir, 'project.json'), {})
    let changed = false
    for (const preset of existingPresets) {
      if (!Number(preset.plannedChapters)) {
        preset.plannedChapters = Number(meta.targetChapters) || 80
        changed = true
      }
      if (!Number(preset.totalWords)) {
        preset.totalWords = Number(meta.targetWords) || preset.plannedChapters * 3000
        changed = true
      }
      if (!Number(preset.chapterWords)) {
        preset.chapterWords = Math.max(500, Math.round(preset.totalWords / Math.max(1, preset.plannedChapters)))
        changed = true
      }
      if (!preset.structure) {
        preset.structure = '三幕 + 起承转合：建置 / 升级 / 高潮与余韵'
        changed = true
      }
      if (!Array.isArray(preset.reviewFocus) || preset.reviewFocus.length === 0) {
        preset.reviewFocus = ['情节因果', '人物动机', '连续性', '节奏', '对话', '文笔']
        changed = true
      }
    }
    if (changed) await writeJson(presetPath, existingPresets)
  }
  const agentPath = join(dir, KIND_FILES.agents)
  if ((await readJson(agentPath, [])).length === 0) {
    const agents = defaultAgents().map((a) => ({ ...a, createdAt: nowIso(), updatedAt: nowIso() }))
    await writeJson(agentPath, agents)
  }
}

/** 新建作品。 */
export async function createProject(root, input = {}) {
  const name = String(input.name ?? '').trim() || '未命名作品'
  const id = `p${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
  const dir = projectDir(root, id)
  const project = {
    id,
    name,
    genre: String(input.genre ?? '').trim(),
    logline: String(input.logline ?? '').trim(),
    description: String(input.description ?? '').trim(),
    pov: String(input.pov ?? '第三人称限知'),
    tense: String(input.tense ?? '过去时'),
    language: String(input.language ?? '中文'),
    targetChapters: Number(input.targetChapters) || 0,
    targetWords: Number(input.targetWords) || 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  await mkdir(dir, { recursive: true })
  await ensureProjectSkeleton(root, id)
  await writeJson(join(dir, 'project.json'), project)
  const projects = await listProjects(root)
  projects.push({ id, name, genre: project.genre, updatedAt: project.updatedAt })
  await saveLibrary(root, projects)
  return project
}

/** 更新作品元信息。 */
export async function updateProject(root, id, patch = {}) {
  const project = await readJson(join(projectDir(root, id), 'project.json'), null)
  if (!project) throw new Error(`作品不存在：${id}`)
  const allowed = ['name', 'genre', 'logline', 'description', 'pov', 'tense', 'language', 'targetChapters', 'targetWords', 'activePresetId']
  for (const key of allowed) {
    if (patch[key] === undefined) continue
    if (key === 'activePresetId') {
      const value = String(patch[key] ?? '').trim()
      // 空字符串表示取消「当前预设」，字段本身可选，不落空值
      if (value) project.activePresetId = value
      else delete project.activePresetId
      continue
    }
    project[key] = patch[key]
  }
  project.updatedAt = nowIso()
  await writeJson(join(projectDir(root, id), 'project.json'), project)
  const projects = await listProjects(root)
  const row = projects.find((p) => p.id === id)
  if (row) {
    row.name = project.name
    row.genre = project.genre
    row.updatedAt = project.updatedAt
  }
  await saveLibrary(root, projects)
  return project
}

/** 删除作品（连同全部数据）。 */
export async function deleteProject(root, id) {
  await rm(projectDir(root, id), { recursive: true, force: true })
  const projects = (await listProjects(root)).filter((p) => p.id !== id)
  await saveLibrary(root, projects)
  return { deleted: id }
}

// ── 章节 ──────────────────────────────────────────────────────

function parseChapter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const meta = { id: '', title: '', status: 'draft', summary: '', location: '', storyTime: '' }
  meta.characters = []
  let content = text
  if (m) {
    content = text.slice(m[0].length)
    for (const line of m[1].split('\n')) {
      const idx = line.indexOf(':')
      if (idx < 0) continue
      const key = line.slice(0, idx).trim()
      const raw = line.slice(idx + 1).trim()
      if (!(key in meta)) continue
      if (key === 'characters') {
        try {
          meta.characters = JSON.parse(raw)
        } catch {
          meta.characters = raw ? raw.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : []
        }
      } else if (key === 'id') {
        meta.id = raw.replace(/^"|"$/g, '')
      } else {
        meta[key] = raw.replace(/^"|"$/g, '')
      }
    }
  }
  return { meta, content: content.replace(/^\n+/, '') }
}

function serializeChapter(meta, content) {
  const order = ['id', 'title', 'status', 'summary', 'location', 'storyTime', 'characters']
  const lines = ['---']
  for (const key of order) {
    const value = meta[key]
    if (key === 'characters') lines.push(`characters: ${JSON.stringify(Array.isArray(value) ? value : [])}`)
    else lines.push(`${key}: ${JSON.stringify(String(value ?? ''))}`)
  }
  lines.push('---', '')
  return lines.join('\n') + String(content ?? '')
}

/** 列出某作品的章节（含正文）。 */
export async function listChapters(root, id) {
  const dir = join(projectDir(root, id), 'chapters')
  let files = []
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  const chapters = []
  for (const file of files.sort()) {
    const text = await readFile(join(dir, file), 'utf8')
    const { meta, content } = parseChapter(text)
    const chapterId = meta.id || file.replace(/\.md$/, '')
    chapters.push({
      id: chapterId,
      title: meta.title || chapterId,
      status: meta.status || 'draft',
      summary: meta.summary || '',
      location: meta.location || '',
      storyTime: meta.storyTime || '',
      characters: Array.isArray(meta.characters) ? meta.characters : [],
      content,
      words: countWords(content),
    })
  }
  return chapters.sort((a, b) => a.id.localeCompare(b.id))
}

// ── 章节版本（.backups/）────────────────────────────────────

const CHAPTER_HISTORY_LIMIT = 100

function backupsDir(root, projectId) {
  return join(projectDir(root, projectId), '.backups')
}

/** ISO 时间戳去掉冒号/点，作为备份文件名后缀。 */
function backupStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** 从备份文件名还原 savedAt；解析不出来时返回 null。 */
function savedAtFromName(file, chapterId) {
  const prefix = `${chapterId}-`
  if (!file.startsWith(prefix) || !file.endsWith('.md')) return null
  const rest = file.slice(prefix.length, -'.md'.length)
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-\d+)?$/.exec(rest)
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : null
}

/** 列出某章的全部备份（按时间倒序）。 */
async function listBackupEntries(root, projectId, chapterId) {
  const dir = backupsDir(root, projectId)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const prefix = `${chapterId}-`
  const entries = []
  for (const file of names) {
    if (!file.startsWith(prefix) || !file.endsWith('.md')) continue
    const path = join(dir, file)
    let info
    try {
      info = await stat(path)
    } catch {
      continue
    }
    entries.push({
      file,
      path,
      savedAt: savedAtFromName(file, chapterId) ?? info.mtime.toISOString(),
      bytes: info.size,
    })
  }
  entries.sort((a, b) => (a.savedAt === b.savedAt ? b.file.localeCompare(a.file) : b.savedAt.localeCompare(a.savedAt)))
  return entries
}

/** 每章最多保留最近 100 份备份，删除最旧的。 */
async function pruneChapterHistory(root, projectId, chapterId) {
  const entries = await listBackupEntries(root, projectId, chapterId)
  for (const entry of entries.slice(CHAPTER_HISTORY_LIMIT)) {
    await rm(entry.path, { force: true })
  }
}

/**
 * 把章节旧原文写进 .backups/，返回备份文件的完整路径。
 * 备份文件名：<chapterId>-<ISO时间戳去冒号>.md（同一毫秒重复时追加序号）。
 */
async function backupChapterFile(root, projectId, chapterId, text) {
  const dir = backupsDir(root, projectId)
  await mkdir(dir, { recursive: true })
  const expected = `${chapterId}-${backupStamp()}.md`
  let file = expected
  let target = join(dir, file)
  let seq = 1
  while (existsSync(target)) {
    file = expected.replace(/\.md$/, `-${seq}.md`)
    target = join(dir, file)
    seq += 1
  }
  await writeText(target, text)
  await pruneChapterHistory(root, projectId, chapterId)
  return target
}

async function readTextIfExists(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** 定位并校验备份文件：只允许本章 .backups/ 下的纯文件名，防目录穿越。 */
async function resolveBackupFile(root, projectId, chapterId, file) {
  const raw = String(file ?? '').trim()
  const name = basename(raw)
  if (!raw || name !== raw) throw new Error('章节备份文件名不合法')
  if (!name.startsWith(`${chapterId}-`) || !name.endsWith('.md')) throw new Error(`备份不属于第 ${chapterId} 章：${name}`)
  const path = join(backupsDir(root, projectId), name)
  const text = await readTextIfExists(path)
  if (text === null) throw new Error(`章节备份不存在：${name}`)
  return { name, path, text }
}

/**
 * 列出某章的历史版本（按保存时间倒序，最多 100 条）。
 * @returns {Promise<Array<{file:string, savedAt:string, bytes:number}>>}
 */
export async function listChapterHistory(root, projectId, chapterId) {
  const entries = await listBackupEntries(root, projectId, String(chapterId))
  return entries.slice(0, CHAPTER_HISTORY_LIMIT).map((entry) => ({ file: entry.file, savedAt: entry.savedAt, bytes: entry.bytes }))
}

/**
 * 读取某章某个历史版本的正文。
 * @returns {Promise<{file:string, savedAt:string, content:string}>}
 */
export async function readChapterHistoryVersion(root, projectId, chapterId, file) {
  const target = await resolveBackupFile(root, projectId, String(chapterId), file)
  let savedAt = savedAtFromName(target.name, String(chapterId))
  if (!savedAt) {
    try {
      savedAt = (await stat(target.path)).mtime.toISOString()
    } catch {
      savedAt = new Date().toISOString()
    }
  }
  return { file: target.name, savedAt, content: target.text }
}

/**
 * 恢复某章历史版本：先把当前正文备份，再把指定备份写回 chapters/<id>.md。
 * @returns {Promise<{chapter:object, backup:string|null}>}
 */
export async function restoreChapterVersion(root, projectId, chapterId, file) {
  const id = String(chapterId)
  const target = await resolveBackupFile(root, projectId, id, file)
  const chapterPath = join(projectDir(root, projectId), 'chapters', `${id}.md`)
  const current = await readTextIfExists(chapterPath)
  const backup = current === null ? null : await backupChapterFile(root, projectId, id, current)
  await writeText(chapterPath, target.text)
  const { meta, content } = parseChapter(target.text)
  return {
    chapter: {
      id: meta.id || id,
      title: meta.title || `第 ${Number(id) || id} 章`,
      status: meta.status || 'draft',
      summary: meta.summary || '',
      location: meta.location || '',
      storyTime: meta.storyTime || '',
      characters: Array.isArray(meta.characters) ? meta.characters : [],
      content,
      words: countWords(content),
    },
    backup,
  }
}

/** 保存章节（id 为空则追加）。覆盖已有章节且内容变化时自动备份旧稿。 */
export async function saveChapter(root, projectId, input = {}) {
  const dir = join(projectDir(root, projectId), 'chapters')
  await mkdir(dir, { recursive: true })
  let chapterId = String(input.id ?? '').trim()
  if (!chapterId) {
    const existing = await listChapters(root, projectId)
    const max = existing.reduce((n, c) => Math.max(n, Number(c.id) || 0), 0)
    chapterId = String(max + 1).padStart(4, '0')
  }
  const meta = {
    id: chapterId,
    title: String(input.title ?? '').trim() || `第 ${Number(chapterId) || chapterId} 章`,
    status: String(input.status ?? 'draft'),
    summary: String(input.summary ?? ''),
    location: String(input.location ?? ''),
    storyTime: String(input.storyTime ?? ''),
    characters: Array.isArray(input.characters)
      ? input.characters
      : String(input.characters ?? '')
          .split(/[、,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
  }
  const content = String(input.content ?? '')
  const text = serializeChapter(meta, content)
  const path = join(dir, `${chapterId}.md`)
  const previous = await readTextIfExists(path)
  // 内容没变就不产生备份
  const backup = previous !== null && previous !== text ? await backupChapterFile(root, projectId, chapterId, previous) : null
  await writeText(path, text)
  const project = await readJson(join(projectDir(root, projectId), 'project.json'), null)
  if (project) {
    project.updatedAt = nowIso()
    await writeJson(join(projectDir(root, projectId), 'project.json'), project)
  }
  return { ...meta, content, words: countWords(content), backup }
}

/** 删除章节。 */
export async function deleteChapter(root, projectId, chapterId) {
  await rm(join(projectDir(root, projectId), 'chapters', `${chapterId}.md`), { force: true })
  return { deleted: chapterId }
}

// ── 结构化数据 ────────────────────────────────────────────────

async function readKind(root, projectId, kind) {
  const file = KIND_FILES[kind]
  if (!file) throw new Error(`未知数据类型：${kind}`)
  const value = await readJson(join(projectDir(root, projectId), file), [])
  return Array.isArray(value) ? value : []
}

/** 读取某一类结构化数据。 */
export async function getEntities(root, projectId, kind) {
  return readKind(root, projectId, kind)
}

/** 新增或更新一条结构化数据。 */
export async function upsertEntity(root, projectId, kind, item = {}) {
  const file = KIND_FILES[kind]
  if (!file) throw new Error(`未知数据类型：${kind}`)
  const list = await readKind(root, projectId, kind)
  const id = String(item.id ?? '').trim() || shortId()
  const next = { ...item, id, updatedAt: nowIso() }
  if (!next.createdAt) next.createdAt = next.updatedAt
  const index = list.findIndex((x) => x.id === id)
  if (index >= 0) list[index] = { ...list[index], ...next }
  else list.push(next)
  await writeJson(join(projectDir(root, projectId), file), list)
  return next
}

/** 删除一条结构化数据。 */
export async function deleteEntity(root, projectId, kind, entityId) {
  const list = await readKind(root, projectId, kind)
  const next = list.filter((x) => x.id !== entityId)
  await writeJson(join(projectDir(root, projectId), KIND_FILES[kind]), next)
  return { deleted: entityId }
}

// ── 汇总 ──────────────────────────────────────────────────────

/** 读取一个作品的完整数据包（供 UI 与工具使用）。 */
export async function getBundle(root, projectId) {
  const dir = projectDir(root, projectId)
  const project = await readJson(join(dir, 'project.json'), null)
  if (!project) throw new Error(`作品不存在：${projectId}`)
  await ensureProjectSkeleton(root, projectId)
  const chapters = await listChapters(root, projectId)
  const bundle = { root, project, chapters }
  for (const kind of KINDS) bundle[kind] = await readKind(root, projectId, kind)
  bundle.checks = runChecks(bundle)
  bundle.alignment = computeAlignment(bundle)
  bundle.stats = {
    chapters: chapters.length,
    words: chapters.reduce((n, c) => n + c.words, 0),
    characters: bundle.characters.length,
    outlines: bundle.outlines.length,
    facts: bundle.facts.length,
    events: bundle.events.length,
    foreshadow: bundle.foreshadow.length,
    conflicts: bundle.conflicts.length,
    highlights: bundle.highlights.length,
    presets: bundle.presets.length,
    openForeshadow: bundle.foreshadow.filter((f) => f.status !== 'paid' && f.status !== 'dropped').length,
    activeConflicts: bundle.conflicts.filter((c) => c.status === 'active').length,
    pendingProposals: bundle.proposals.filter((p) => p.status === 'pending').length,
    openReviews: bundle.reviews.filter((r) => r.status !== 'fixed' && r.status !== 'wontfix').length,
  }
  return bundle
}

/** 作品库概览（每个作品的统计）。 */
export async function getLibrary(root) {
  const projects = await listProjects(root)
  const rows = []
  for (const p of projects) {
    try {
      const chapters = await listChapters(root, p.id)
      rows.push({
        ...p,
        chapters: chapters.length,
        words: chapters.reduce((n, c) => n + c.words, 0),
      })
    } catch {
      rows.push({ ...p, chapters: 0, words: 0 })
    }
  }
  return { root, projects: rows }
}

/** 导出作品为可读 Markdown 合集。 */
export async function exportMarkdown(root, projectId) {
  const bundle = await getBundle(root, projectId)
  const lines = [`# ${bundle.project.name}`, '', bundle.project.logline ? `> ${bundle.project.logline}` : '', '']
  for (const chapter of bundle.chapters) {
    lines.push(`## ${chapter.title}`, '')
    if (chapter.summary) lines.push(`> 摘要：${chapter.summary}`, '')
    lines.push(chapter.content.trim(), '')
  }
  return { filename: `${bundle.project.name}.md`, markdown: lines.join('\n') }
}

function bookFilename(name, extension) {
  const safe = String(name ?? '').trim().replace(/[/\\:*?"<>|]/g, '_') || '未命名作品'
  return `${safe}.${extension}`
}

/**
 * 导出作品。format: 'md' | 'epub' | 'docx'
 * md 返回 { filename, mime, markdown }；epub/docx 返回 { filename, mime, base64 }。
 */
export async function exportBook(root, projectId, format = 'md') {
  const fmt = String(format ?? 'md').trim().toLowerCase() || 'md'
  if (fmt === 'md' || fmt === 'markdown') {
    const markdown = await exportMarkdown(root, projectId)
    return { ...markdown, mime: 'text/markdown' }
  }
  const bundle = await getBundle(root, projectId)
  if (fmt === 'epub') {
    return {
      filename: bookFilename(bundle.project.name, 'epub'),
      mime: 'application/epub+zip',
      base64: buildEpub(bundle).toString('base64'),
    }
  }
  if (fmt === 'docx') {
    return {
      filename: bookFilename(bundle.project.name, 'docx'),
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      base64: buildDocx(bundle).toString('base64'),
    }
  }
  throw new Error(`不支持的导出格式：${format}（可选 md / epub / docx）`)
}

/** 确保根目录存在并返回之。 */
export async function ensureRoot(root = defaultRoot()) {
  await mkdir(join(root, 'projects'), { recursive: true })
  if (!existsSync(join(root, 'library.json'))) await saveLibrary(root, [])
  return root
}

// ── 提案（AI 生成、人工采纳）──────────────────────────────────

const ENTITY_KINDS = new Set(['events', 'facts', 'characters', 'foreshadow', 'highlights', 'presets', 'reviews', 'outlines'])

/**
 * 采纳一条提案，把内容写进对应的账本/章节。
 * @returns {Promise<{proposal:object, applied:object}>}
 */
export async function acceptProposal(root, projectId, proposalId, options = {}) {
  const proposals = await readKind(root, projectId, 'proposals')
  const proposal = proposals.find((p) => p.id === proposalId)
  if (!proposal) throw new Error(`提案不存在：${proposalId}`)
  if (proposal.status !== 'pending') throw new Error('该提案已处理过')
  const data = proposal.data ?? {}
  const applied = { events: 0, facts: 0, characters: 0, foreshadow: 0, highlights: 0, outlines: 0, chapter: null, backup: null }

  // 决策提案：用户在多个选项里选一条路
  if (proposal.kind === 'decision') {
    const choices = Array.isArray(data.options) ? data.options : []
    const chosen = choices.find((option) => option.id === options.optionId) ?? choices[0]
    if (!chosen) throw new Error('决策提案没有可选项')
    if (data.conflictType === 'fact') {
      const facts = await readKind(root, projectId, 'facts')
      const targetIds = new Set((data.facts ?? []).map((fact) => fact.id))
      for (const fact of facts) {
        if (!targetIds.has(fact.id)) continue
        fact.canonical = fact.id === chosen.factId
        fact.superseded = fact.id !== chosen.factId
      }
      await writeJson(join(projectDir(root, projectId), KIND_FILES.facts), facts)
      applied.facts = targetIds.size
    } else if (data.conflictType === 'review') {
      const reviews = await readKind(root, projectId, 'reviews')
      const review = reviews.find((row) => row.id === data.reviewId)
      if (review) {
        review.status = chosen.mark ?? 'fixed'
        review.decision = chosen.label
        review.decidedAt = nowIso()
        await writeJson(join(projectDir(root, projectId), KIND_FILES.reviews), reviews)
        applied.reviews = 1
      }
    }
    const next = proposals.map((row) => (row.id === proposalId
      ? { ...row, status: 'accepted', acceptedAt: nowIso(), chosenOptionId: chosen.id, chosenOption: chosen.label }
      : row))
    await writeJson(join(projectDir(root, projectId), KIND_FILES.proposals), next)
    return { proposal: next.find((row) => row.id === proposalId), applied }
  }

  if (proposal.kind === 'chapter') {
    const chapterId = String(proposal.chapter ?? data.chapter ?? '').padStart(4, '0')
    // saveChapter 内部复用统一备份函数，覆盖前自动快照旧稿
    const saved = await saveChapter(root, projectId, {
      id: chapterId,
      title: data.title ?? proposal.title,
      status: 'draft',
      summary: data.summary ?? proposal.summary ?? '',
      content: data.content ?? '',
      characters: data.characters ?? [],
      storyTime: data.storyTime ?? '',
      location: data.location ?? '',
    })
    applied.backup = saved.backup ?? null
    applied.chapter = chapterId
  } else if (proposal.kind === 'plan') {
    const chapterId = String(proposal.chapter ?? data.chapter ?? '').padStart(4, '0')
    const existing = (await listChapters(root, projectId)).find((c) => c.id === chapterId)
    if (!existing) {
      await saveChapter(root, projectId, {
        id: chapterId,
        title: data.title ?? proposal.title ?? `第 ${chapterId} 章`,
        status: 'draft',
        summary: data.summary ?? proposal.summary ?? '',
        content: '',
        storyTime: data.storyTime ?? '',
        location: data.location ?? '',
        characters: data.characters ?? [],
      })
      applied.chapter = chapterId
    }
    for (const kind of ['events', 'facts', 'foreshadow', 'characters']) {
      for (const item of data[kind] ?? []) {
        await upsertEntity(root, projectId, kind, item)
        applied[kind] += 1
      }
    }
  } else if (ENTITY_KINDS.has(proposal.kind)) {
    const existing = proposal.kind === 'characters' || proposal.kind === 'outlines' ? await readKind(root, projectId, proposal.kind) : []
    for (const item of proposal.items ?? data.items ?? []) {
      let id = item.id
      if (!id && proposal.kind === 'characters') {
        id = existing.find((row) => row.name === item.name)?.id
      }
      if (!id && proposal.kind === 'outlines') {
        id = existing.find((row) => Number(row.chapter) === Number(item.chapter))?.id
      }
      await upsertEntity(root, projectId, proposal.kind, id ? { ...item, id } : item)
      applied[proposal.kind] += 1
    }
  }

  const next = proposals.map((p) => (p.id === proposalId ? { ...p, status: 'accepted', acceptedAt: nowIso() } : p))
  await writeJson(join(projectDir(root, projectId), KIND_FILES.proposals), next)
  return { proposal: next.find((p) => p.id === proposalId), applied }
}

/** 驳回一条提案。 */
export async function rejectProposal(root, projectId, proposalId) {
  const proposals = await readKind(root, projectId, 'proposals')
  if (!proposals.some((p) => p.id === proposalId)) throw new Error(`提案不存在：${proposalId}`)
  const next = proposals.map((p) => (p.id === proposalId ? { ...p, status: 'rejected', rejectedAt: nowIso() } : p))
  await writeJson(join(projectDir(root, projectId), KIND_FILES.proposals), next)
  return { rejected: proposalId }
}

/**
 * 批量采纳提案：单条失败不影响其他条。
 * @returns {Promise<{accepted:Array<{id:string,applied:object}>, failed:Array<{id:string,error:string}>}>}
 */
export async function batchAcceptProposals(root, projectId, ids = []) {
  const accepted = []
  const failed = []
  const proposals = await readKind(root, projectId, 'proposals')
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw)
    try {
      if (proposals.find((row) => row.id === id)?.kind === 'decision') throw new Error('决策提案需要逐条选择选项，不能批量采纳')
      const result = await acceptProposal(root, projectId, id)
      accepted.push({ id, applied: result.applied })
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { accepted, failed }
}

/**
 * 批量驳回提案：单条失败不影响其他条。
 * @returns {Promise<{rejected:string[], failed:Array<{id:string,error:string}>}>}
 */
export async function batchRejectProposals(root, projectId, ids = []) {
  const rejected = []
  const failed = []
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw)
    try {
      await rejectProposal(root, projectId, id)
      rejected.push(id)
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { rejected, failed }
}

/**
 * 批量更新审稿状态。只允许改 status（open | fixed | wontfix），其他字段忽略。
 * @returns {Promise<{updated:number, missing:string[]}>}
 */
export async function batchUpdateReviews(root, projectId, ids = [], patch = {}) {
  const status = String(patch?.status ?? '').trim()
  if (!['open', 'fixed', 'wontfix'].includes(status)) throw new Error(`审稿状态不合法：${status || '(空)'}（可选 open / fixed / wontfix）`)
  const list = await readKind(root, projectId, 'reviews')
  const wanted = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)))
  const missing = []
  let updated = 0
  const next = list.map((review) => {
    if (!wanted.has(String(review.id))) return review
    updated += 1
    return { ...review, status, updatedAt: nowIso() }
  })
  for (const id of wanted) {
    if (!list.some((review) => String(review.id) === id)) missing.push(id)
  }
  if (updated > 0) await writeJson(join(projectDir(root, projectId), KIND_FILES.reviews), next)
  return { updated, missing }
}

/** 给提案追加一条人工修改意见。 */
export async function addProposalFeedback(root, projectId, proposalId, text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) throw new Error('修改意见不能为空')
  const list = await readKind(root, projectId, 'proposals')
  const proposal = list.find((p) => p.id === proposalId)
  if (!proposal) throw new Error(`提案不存在：${proposalId}`)
  if (!Array.isArray(proposal.feedback)) proposal.feedback = []
  proposal.feedback.push({ id: shortId(), text: trimmed, createdAt: nowIso() })
  proposal.updatedAt = nowIso()
  await writeJson(join(projectDir(root, projectId), KIND_FILES.proposals), list)
  return proposal
}

/** 把旧提案标记为「已按意见修订」，并关联新提案。 */
export async function markProposalRevised(root, projectId, oldId, newId) {
  const list = await readKind(root, projectId, 'proposals')
  const next = list.map((p) => {
    if (p.id === oldId) return { ...p, status: 'revised', revisedTo: newId, updatedAt: nowIso() }
    if (p.id === newId) return { ...p, revisedFrom: oldId, updatedAt: nowIso() }
    return p
  })
  await writeJson(join(projectDir(root, projectId), KIND_FILES.proposals), next)
  return next.find((p) => p.id === newId)
}

/** 新增提案。 */
export async function createProposal(root, projectId, input = {}) {
  const list = await readKind(root, projectId, 'proposals')
  const proposal = {
    id: shortId(),
    kind: String(input.kind ?? 'custom'),
    title: String(input.title ?? '未命名提案'),
    summary: String(input.summary ?? ''),
    chapter: input.chapter ?? null,
    data: input.data ?? null,
    items: Array.isArray(input.items) ? input.items : [],
    rationale: String(input.rationale ?? ''),
    source: String(input.source ?? 'ai'),
    priority: Number(input.priority) || 3,
    reviewId: input.reviewId ?? null,
    status: 'pending',
    feedback: [],
    revisedFrom: input.revisedFrom ?? null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  list.push(proposal)
  await writeJson(join(projectDir(root, projectId), KIND_FILES.proposals), list)
  return proposal
}

// ── 预设模板 ──────────────────────────────────────────────────

/** 从内置模板添加一套预设（同名已存在则直接返回）。 */
export async function addPresetFromTemplate(root, projectId, template) {
  const list = await readKind(root, projectId, 'presets')
  const existing = list.find((p) => p.name === template.name)
  if (existing) return existing
  const item = { ...template, id: shortId(), source: template.source ?? 'builtin', createdAt: nowIso(), updatedAt: nowIso() }
  list.push(item)
  await writeJson(join(projectDir(root, projectId), KIND_FILES.presets), list)
  return item
}

/** 只更新章节元信息（标题/状态/摘要/时间/地点/人物），保留正文。 */
export async function updateChapterMeta(root, projectId, chapterId, patch = {}) {
  const chapters = await listChapters(root, projectId)
  const hit = chapters.find((c) => String(c.id) === String(chapterId))
  if (!hit) return null
  return saveChapter(root, projectId, {
    id: hit.id,
    title: patch.title ?? hit.title,
    status: patch.status ?? hit.status,
    summary: patch.summary ?? hit.summary,
    location: patch.location ?? hit.location,
    storyTime: patch.storyTime ?? hit.storyTime,
    characters: patch.characters ?? hit.characters,
    content: hit.content,
  })
}

/** 追加一条导入记录（imports.json，供导入报告与回滚使用）。 */
export async function appendImportRecord(root, projectId, record = {}) {
  const path = join(projectDir(root, projectId), 'imports.json')
  const list = await readJson(path, [])
  const entry = { id: shortId(), createdAt: nowIso(), ...record }
  list.push(entry)
  await writeJson(path, list)
  return entry
}

/** 读取导入历史。 */
export async function listImportRecords(root, projectId) {
  return readJson(join(projectDir(root, projectId), 'imports.json'), [])
}

/** 把某套预设的计划章数与总字数应用为作品目标（不覆盖类型/视角，预设本身仍会被 AI 读取）。 */
export async function applyPreset(root, projectId, presetId) {
  const list = await readKind(root, projectId, 'presets')
  const preset = list.find((p) => p.id === presetId)
  if (!preset) throw new Error(`预设不存在：${presetId}`)
  return updateProject(root, projectId, {
    ...(Number(preset.plannedChapters) ? { targetChapters: Number(preset.plannedChapters) } : {}),
    ...(Number(preset.totalWords) ? { targetWords: Number(preset.totalWords) } : {}),
    activePresetId: presetId,
  })
}
