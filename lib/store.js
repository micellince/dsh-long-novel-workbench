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

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { computeAlignment, runChecks } from './checks.js'
import { defaultAgents, defaultPresets } from './defaults.js'

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
  const allowed = ['name', 'genre', 'logline', 'description', 'pov', 'tense', 'language', 'targetChapters', 'targetWords']
  for (const key of allowed) {
    if (patch[key] !== undefined) project[key] = patch[key]
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

/** 保存章节（id 为空则追加）。 */
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
  await writeFile(join(dir, `${chapterId}.md`), serializeChapter(meta, content), 'utf8')
  const project = await readJson(join(projectDir(root, projectId), 'project.json'), null)
  if (project) {
    project.updatedAt = nowIso()
    await writeJson(join(projectDir(root, projectId), 'project.json'), project)
  }
  return { ...meta, content, words: countWords(content) }
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

/** 确保根目录存在并返回之。 */
export async function ensureRoot(root = defaultRoot()) {
  await mkdir(join(root, 'projects'), { recursive: true })
  if (!existsSync(join(root, 'library.json'))) await saveLibrary(root, [])
  return root
}

// ── 提案（AI 生成、人工采纳）──────────────────────────────────

const ENTITY_KINDS = new Set(['events', 'facts', 'characters', 'foreshadow', 'highlights', 'presets', 'reviews'])

async function backupChapterFile(root, projectId, chapterId) {
  const source = join(projectDir(root, projectId), 'chapters', `${chapterId}.md`)
  const text = await readTextIfExistsLocal(source)
  if (text === null) return null
  const dir = join(projectDir(root, projectId), '.backups')
  await mkdir(dir, { recursive: true })
  const target = join(dir, `${chapterId}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
  await writeFile(target, text, 'utf8')
  return target
}

async function readTextIfExistsLocal(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * 采纳一条提案，把内容写进对应的账本/章节。
 * @returns {Promise<{proposal:object, applied:object}>}
 */
export async function acceptProposal(root, projectId, proposalId) {
  const proposals = await readKind(root, projectId, 'proposals')
  const proposal = proposals.find((p) => p.id === proposalId)
  if (!proposal) throw new Error(`提案不存在：${proposalId}`)
  if (proposal.status !== 'pending') throw new Error('该提案已处理过')
  const data = proposal.data ?? {}
  const applied = { events: 0, facts: 0, characters: 0, foreshadow: 0, highlights: 0, chapter: null, backup: null }

  if (proposal.kind === 'chapter') {
    const chapterId = String(proposal.chapter ?? data.chapter ?? '').padStart(4, '0')
    const backup = await backupChapterFile(root, projectId, chapterId)
    applied.backup = backup
    await saveChapter(root, projectId, {
      id: chapterId,
      title: data.title ?? proposal.title,
      status: 'draft',
      summary: data.summary ?? proposal.summary ?? '',
      content: data.content ?? '',
      characters: data.characters ?? [],
      storyTime: data.storyTime ?? '',
      location: data.location ?? '',
    })
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
    for (const item of proposal.items ?? data.items ?? []) {
      await upsertEntity(root, projectId, proposal.kind, item)
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

/** 把某套预设的计划章数与总字数应用为作品目标（不覆盖类型/视角，预设本身仍会被 AI 读取）。 */
export async function applyPreset(root, projectId, presetId) {
  const list = await readKind(root, projectId, 'presets')
  const preset = list.find((p) => p.id === presetId)
  if (!preset) throw new Error(`预设不存在：${presetId}`)
  return updateProject(root, projectId, {
    ...(Number(preset.plannedChapters) ? { targetChapters: Number(preset.plannedChapters) } : {}),
    ...(Number(preset.totalWords) ? { targetWords: Number(preset.totalWords) } : {}),
  })
}
