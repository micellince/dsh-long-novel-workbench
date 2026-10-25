/**
 * 故事工作台 · 整本快照（版本系统）
 *
 * 逐章备份（.backups/）只记「改动前的正文」，回答不了「回到开工前那一刻的整本书」。
 * 这里做整本快照：把全部章节 + 全部 json 账本一次性拷进 .snapshots/<id>/，
 * 附 manifest（每文件 sha256 + 计数 + 触发点），回滚时先自动打一份「回滚前」快照，
 * 再按 manifest 覆盖、删掉快照之后新增的文件，做到整本状态精确匹配。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { backupChapterNow, countWords } from './store.js'

export const SNAPSHOT_DIR = '.snapshots'
/** 保留最近 40 份快照；手动快照不会被自动清理挤掉（除非超出上限很多）。 */
export const SNAPSHOT_LIMIT = 40
const MANIFEST = 'manifest.json'

/** 快照覆盖的 json 账本（项目根目录下的文件名）。 */
export const MANAGED_JSON = [
  'project.json',
  'facts.json',
  'events.json',
  'foreshadow.json',
  'conflicts.json',
  'characters.json',
  'highlights.json',
  'attention.json',
  'world.json',
  'locations.json',
  'presets.json',
  'outlines.json',
  'reviews.json',
  'proposals.json',
  'agents.json',
  'imports.json',
  'pipeline.json',
  'expansion.json',
  'revision.json',
]

export const SNAPSHOT_TRIGGERS = {
  manual: '手动快照',
  'pre-restore': '回滚前自动',
  'run-start': '开工前自动',
  'restore-chapter': '单章回滚前',
}

function projectDir(root, projectId) {
  const id = String(projectId ?? '').trim()
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) throw new Error('projectId 不合法')
  return join(root, 'projects', id)
}

function snapshotsDir(root, projectId) {
  return join(projectDir(root, projectId), SNAPSHOT_DIR)
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function snapshotIdOk(id) {
  return /^snap-[A-Za-z0-9._-]+$/.test(String(id ?? '')) && !String(id).includes('..')
}

async function readIfExists(path) {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

async function writeAtomic(path, buf) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, buf)
  await rename(tmp, path)
}

/** 去掉 frontmatter，只数正文。 */
function bodyWords(buf) {
  const text = buf.toString('utf8')
  return countWords(text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''))
}

/**
 * 收集当前受管文件：chapters/*.md + MANAGED_JSON。
 * @returns {Promise<{rel:string, abs:string, buf:Buffer}[]>}
 */
async function collectManaged(root, projectId) {
  const dir = projectDir(root, projectId)
  const out = []
  let names = []
  try {
    names = await readdir(join(dir, 'chapters'))
  } catch {
    names = []
  }
  for (const name of names.filter((item) => item.endsWith('.md')).sort()) {
    const abs = join(dir, 'chapters', name)
    const buf = await readIfExists(abs)
    if (buf) out.push({ rel: `chapters/${name}`, abs, buf })
  }
  for (const name of MANAGED_JSON) {
    const abs = join(dir, name)
    const buf = await readIfExists(abs)
    if (buf) out.push({ rel: name, abs, buf })
  }
  return out
}

async function readRunState(root, projectId) {
  const buf = await readIfExists(join(projectDir(root, projectId), 'revision.json'))
  if (!buf) return null
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * 创建整本快照。
 * @returns {Promise<object>} manifest
 */
export async function createSnapshot(root, projectId, options = {}) {
  const dir = snapshotsDir(root, projectId)
  await mkdir(dir, { recursive: true })
  const createdAt = new Date().toISOString()
  const id = `snap-${stamp(new Date(createdAt))}-${Math.random().toString(36).slice(2, 6)}`
  const target = join(dir, id)
  const runState = await readRunState(root, projectId)
  const files = []
  let words = 0
  let bytes = 0
  for (const item of await collectManaged(root, projectId)) {
    const dest = join(target, item.rel)
    await writeAtomic(dest, item.buf)
    files.push({ path: item.rel, bytes: item.buf.length, sha256: sha256(item.buf) })
    bytes += item.buf.length
    if (item.rel.endsWith('.md')) words += bodyWords(item.buf)
  }
  const manifest = {
    id,
    projectId: String(projectId),
    createdAt,
    label: String(options.label ?? '').trim(),
    trigger: String(options.trigger ?? 'manual'),
    runId: String(options.runId ?? runState?.runId ?? ''),
    runStatus: String(runState?.status ?? ''),
    tier: String(runState?.tier ?? ''),
    note: String(options.note ?? ''),
    counts: {
      chapters: files.filter((file) => file.path.startsWith('chapters/')).length,
      files: files.length,
      words,
      bytes,
    },
    files,
  }
  // manifest 最后写：没有 manifest 的目录视为未完成的快照，列表里跳过。
  await writeAtomic(join(target, MANIFEST), Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
  await pruneSnapshots(root, projectId)
  return manifest
}

/** 读取某份快照的 manifest。 */
export async function getSnapshot(root, projectId, snapshotId) {
  if (!snapshotIdOk(snapshotId)) throw new Error('快照 id 不合法')
  const buf = await readIfExists(join(snapshotsDir(root, projectId), String(snapshotId), MANIFEST))
  if (!buf) throw new Error(`快照不存在：${snapshotId}`)
  return JSON.parse(buf.toString('utf8'))
}

/** 列出全部快照（按时间倒序，不含 files 明细）。 */
export async function listSnapshots(root, projectId) {
  const dir = snapshotsDir(root, projectId)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const rows = []
  for (const name of names) {
    if (!snapshotIdOk(name)) continue
    try {
      const manifest = await getSnapshot(root, projectId, name)
      const { files, ...rest } = manifest
      rows.push(rest)
    } catch {
      // 未完成或损坏的快照：跳过，不影响其余版本
    }
  }
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return rows
}

/** 对比快照与当前状态：哪些改了、哪些快照里有但现在没有、哪些现在多出来。 */
export async function diffSnapshot(root, projectId, snapshotId) {
  const manifest = await getSnapshot(root, projectId, snapshotId)
  const current = await collectManaged(root, projectId)
  const currentMap = new Map(current.map((item) => [item.rel, sha256(item.buf)]))
  const snapshotMap = new Map((manifest.files ?? []).map((item) => [item.path, item.sha256]))
  const changed = []
  const missingNow = []
  const newSince = []
  for (const [path, hash] of snapshotMap) {
    if (!currentMap.has(path)) missingNow.push({ path })
    else if (currentMap.get(path) !== hash) changed.push({ path })
  }
  for (const path of currentMap.keys()) {
    if (!snapshotMap.has(path)) newSince.push({ path })
  }
  const byPath = (a, b) => a.path.localeCompare(b.path)
  changed.sort(byPath)
  missingNow.sort(byPath)
  newSince.sort(byPath)
  return {
    snapshotId: manifest.id,
    createdAt: manifest.createdAt,
    counts: {
      changed: changed.length,
      missingNow: missingNow.length,
      newSince: newSince.length,
      total: changed.length + missingNow.length + newSince.length,
    },
    changed,
    missingNow,
    newSince,
  }
}

/** 校验快照文件完整性：任意文件 hash 不符就拒绝回滚。 */
async function verifySnapshot(root, projectId, manifest) {
  const dir = join(snapshotsDir(root, projectId), manifest.id)
  for (const file of manifest.files ?? []) {
    const buf = await readIfExists(join(dir, file.path))
    if (!buf) throw new Error(`快照缺少文件：${file.path}`)
    if (sha256(buf) !== file.sha256) throw new Error(`快照文件已损坏：${file.path}`)
  }
}

/** 任何自动改动正在执行时，禁止回滚（避免和会话抢文件）。 */
async function assertNotRunning(root, projectId) {
  const dir = projectDir(root, projectId)
  for (const [file, label] of [['revision.json', '全文改动'], ['pipeline.json', '生成整本书'], ['expansion.json', '扩写']]) {
    const buf = await readIfExists(join(dir, file))
    if (!buf) continue
    try {
      if (JSON.parse(buf.toString('utf8'))?.status === 'running') {
        throw new Error(`${label}正在执行，先暂停或等它跑完再回滚（开工前快照已保存，不会丢）`)
      }
    } catch (error) {
      if (error instanceof Error && /正在执行/.test(error.message)) throw error
    }
  }
}

/**
 * 整本回滚：先自动打一份「回滚前」快照，再按 manifest 覆盖，并删掉快照之后新增的受管文件。
 */
export async function restoreSnapshot(root, projectId, snapshotId) {
  await assertNotRunning(root, projectId)
  const manifest = await getSnapshot(root, projectId, snapshotId)
  await verifySnapshot(root, projectId, manifest)
  const safety = await createSnapshot(root, projectId, {
    label: `回滚到 ${manifest.createdAt} 之前`,
    trigger: 'pre-restore',
    note: `restore:${manifest.id}`,
  })
  const dir = join(snapshotsDir(root, projectId), manifest.id)
  const dirProject = projectDir(root, projectId)
  for (const file of manifest.files ?? []) {
    await writeAtomic(join(dirProject, file.path), await readFile(join(dir, file.path)))
  }
  const keep = new Set((manifest.files ?? []).map((file) => file.path))
  const removed = []
  for (const item of await collectManaged(root, projectId)) {
    if (keep.has(item.rel)) continue
    await rm(item.abs, { force: true })
    removed.push(item.rel)
  }
  return { restored: (manifest.files ?? []).length, removed, safetySnapshotId: safety.id, snapshotId: manifest.id }
}

/** 从快照里读一章（预览用）。 */
export async function readSnapshotChapter(root, projectId, snapshotId, chapterId) {
  const manifest = await getSnapshot(root, projectId, snapshotId)
  const id = String(chapterId ?? '').trim()
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('chapterId 不合法')
  const rel = `chapters/${id}.md`
  if (!(manifest.files ?? []).some((file) => file.path === rel)) throw new Error(`快照里没有第 ${id} 章`)
  const buf = await readIfExists(join(snapshotsDir(root, projectId), manifest.id, rel))
  if (!buf) throw new Error(`快照缺少第 ${id} 章`)
  return { file: rel, content: buf.toString('utf8') }
}

/** 只回滚一章：先备份当前正文，再写回快照版本。 */
export async function restoreSnapshotChapter(root, projectId, snapshotId, chapterId) {
  await assertNotRunning(root, projectId)
  const manifest = await getSnapshot(root, projectId, snapshotId)
  await verifySnapshot(root, projectId, manifest)
  const { file: rel, content } = await readSnapshotChapter(root, projectId, snapshotId, chapterId)
  const abs = join(projectDir(root, projectId), rel)
  const current = await readIfExists(abs)
  if (current) {
    // 当前正文进 .backups/（单章历史），再留一份整本快照，防止「回滚的回滚」无路可走
    await backupChapterNow(root, projectId, String(chapterId), current.toString('utf8'))
    await createSnapshot(root, projectId, {
      label: `单章回滚前 · 第 ${String(chapterId)} 章`,
      trigger: 'restore-chapter',
      note: `restore-chapter:${manifest.id}:${String(chapterId)}`,
    })
  }
  await writeAtomic(abs, Buffer.from(content, 'utf8'))
  return { file: rel, content, previous: current ? current.toString('utf8') : null }
}

/** 删除快照目录（不动当前正文）。 */
export async function deleteSnapshot(root, projectId, snapshotId) {
  const manifest = await getSnapshot(root, projectId, snapshotId)
  await rm(join(snapshotsDir(root, projectId), manifest.id), { recursive: true, force: true })
  return { deleted: true, snapshotId: manifest.id }
}

/** 超出上限时删最旧的自动快照；手动快照最后才动，且至少保留一份。 */
export async function pruneSnapshots(root, projectId) {
  const rows = await listSnapshots(root, projectId)
  if (rows.length <= SNAPSHOT_LIMIT) return []
  const oldestFirst = rows.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  const removed = []
  for (const manualPass of [false, true]) {
    for (const row of oldestFirst) {
      if (rows.length - removed.length <= SNAPSHOT_LIMIT) break
      if ((row.trigger === 'manual') !== manualPass) continue
      await rm(join(snapshotsDir(root, projectId), row.id), { recursive: true, force: true })
      removed.push(row.id)
    }
  }
  return removed
}
