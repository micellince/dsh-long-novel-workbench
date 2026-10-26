#!/usr/bin/env node
/**
 * 把一本 0.6 作品迁移成 0.7 形态：
 *   - 新开一个 DSH 工作区目录（一本书=一个工作区），数据与 novel.db 都放进去
 *   - 旧工作区打标记（保留原样，不删）
 *   - 正文/标题/账本/大纲/旧意见/冷读记录迁移入库
 *   - 事实账本逐条无损：库里的 attrs 保存原始 JSON，并逐条对比
 *
 * 默认 dry-run；写盘必须 --apply。迁移只读旧数据，旧作品目录不动。
 *
 * 用法：
 *   node scripts/migrate-book-0.7.mjs --project pmviujtkm6d0d
 *   node scripts/migrate-book-0.7.mjs --project pmviujtkm6d0d --apply
 *   node scripts/migrate-book-0.7.mjs --project pmviujtkm6d0d --apply --workspace-name "碧血青霜缘·0.7"
 */

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import * as store from '../lib/store.js'
import * as bookdb from '../lib/bookdb.js'
import { DatabaseSync } from 'node:sqlite'

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const apply = process.argv.includes('--apply')
const root = arg('root', process.env.STORY_DESK_ROOT || store.defaultRoot())
const sourceId = arg('project', '')
const workspaceName = arg('workspace-name', '')
const oldTitleSuffix = '（旧·0.6，已迁移）'

function nowIso() { return new Date().toISOString() }

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}
async function writeJson(file, value) {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function workspaceRegistryPath() {
  return join(homedir(), '.dsh', 'storages', 'workspace.json')
}

async function main() {
  if (!sourceId) throw new Error('缺少 --project（旧作品 id）')
  const projects = await store.listProjects(root)
  const list = Array.isArray(projects) ? projects : projects.projects || []
  const sourceRow = list.find((row) => String(row.id) === String(sourceId))
  if (!sourceRow) throw new Error(`找不到作品 ${sourceId}`)
  const sourceDir = await store.projectDir(root, sourceId)
  const sourceProject = await store.getProject(root, sourceId)
  const oldWorkspace = String(sourceProject.workspacePath || '').trim()
  const title = String(sourceRow.name || sourceRow.title || sourceId).trim()
  const newName = String(workspaceName || `${title}·0.7`).trim()
  const baseDir = join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace')
  const targetDir = join(baseDir, newName)

  const chapters = await store.listChapters(root, sourceId)
  const txtChapters = chapters.filter((row) => row.format !== 'md')
  const ledgerFiles = ['facts', 'characters', 'locations', 'events', 'foreshadow', 'conflicts', 'highlights', 'outlines', 'world', 'presets', 'attention', 'reviews']
  const present = []
  for (const name of ledgerFiles) {
    if (existsSync(join(sourceDir, `${name}.json`))) present.push(`${name}.json`)
  }

  console.log(`迁移计划：${title}（${sourceId}）`)
  console.log(`- 旧数据目录：${sourceDir}`)
  console.log(`- 旧工作区：${oldWorkspace || '(未登记)'}`)
  console.log(`- 新工作区：${targetDir}`)
  console.log(`- 章节：${chapters.length}（txt ${txtChapters.length}）`)
  console.log(`- 迁移文件：${present.join('、')}`)
  if (!apply) {
    console.log('\n这是 dry-run：不写任何文件。确认后加 --apply。')
    return
  }
  if (existsSync(targetDir)) throw new Error(`目标工作区已存在：${targetDir}（先改名或删除后再迁移）`)

  // 备份：library / workspace registry / 旧 project.json
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(homedir(), 'StoryDesk', `.migration-backup-${stamp}`)
  await mkdir(backupDir, { recursive: true })
  for (const [name, file] of [
    ['library.json', join(resolve(root), 'library.json')],
    ['workspace.json', workspaceRegistryPath()],
    ['old-project.json', join(sourceDir, 'project.json')],
  ]) {
    if (existsSync(file)) await copyFile(file, join(backupDir, name))
  }
  console.log(`- 备份：${backupDir}`)

  // 1) 新工作区目录 + 新作品（dataDir 指向工作区）
  await mkdir(targetDir, { recursive: true })
  await mkdir(join(targetDir, '.dsh-notes'), { recursive: true })
  const createdProject = await store.createProject(root, { title, genre: sourceRow.genre || '', dataDir: targetDir })
  const newId = String(createdProject.id)
  const newDir = await store.projectDir(root, newId)
  console.log(`- 新作品 id：${newId}`)

  // 2) 复制正文与账本/大纲/意见/冷读
  await mkdir(join(newDir, 'chapters'), { recursive: true })
  let copied = 0
  for (const file of await readdir(join(sourceDir, 'chapters'))) {
    if (/^\d{4}\.(txt|meta\.json)$/.test(file)) {
      await copyFile(join(sourceDir, 'chapters', file), join(newDir, 'chapters', file))
      copied += 1
    }
  }
  for (const name of present) await copyFile(join(sourceDir, name), join(newDir, name))
  console.log(`- 复制章节文件 ${copied} 个、账本/大纲文件 ${present.length} 个`)

  // 3) 新 project.json：工作区/数据目录 + 原设定
  const newProject = await readJson(join(newDir, 'project.json'), {})
  const mergedProject = {
    ...sourceProject,
    ...newProject,
    id: newId,
    title,
    name: title,
    dataDir: newDir,
    workspacePath: targetDir,
    workspaceTitle: newName,
    workspaceId: '',
    schemaVersion: '0.7.0',
    updatedAt: nowIso(),
  }
  await writeJson(join(newDir, 'project.json'), mergedProject)
  await readJson(join(sourceDir, 'project.json'), {})

  // 4) 标题进正文 + 建索引/DB（逐章）
  let titled = 0
  for (const row of txtChapters) {
    const chapter = Number(row.chapter)
    const doc = await store.readChapter(root, newId, chapter)
    const metaTitle = String(doc.meta?.title ?? '').trim()
    const first = String(doc.text || '').split('\n').map((line) => line.trim()).find((line) => line) || ''
    if (!metaTitle || first === metaTitle) continue
    const nextText = `${metaTitle}\n\n${String(doc.text || '').replace(/^\n+/, '')}`
    await store.saveChapter(root, newId, chapter, nextText, {}, { baseHash: doc.meta?.contentHash, source: 'migration-0.7' })
    titled += 1
  }
  console.log(`- 标题进正文：${titled} 章`)

  // 5) 旧意见 → opinions；大纲自动入 DB
  const dir = await store.projectDir(root, newId)
  const reviewSync = await bookdb.ensureReviewSync(dir)
  const outlines = await bookdb.listOutlines(dir)
  console.log(`- 旧意见同步：${reviewSync.synced ?? 0} 条；大纲入库：${outlines.length} 条`)

  // 6) 事实账本无损核对
  const { db } = await bookdb.openBook(dir)
  const factsRows = db.prepare('SELECT COUNT(*) n FROM facts').get().n
  const sourceFacts = await readJson(join(sourceDir, 'facts.json'), [])
  let factsOk = 0
  const factStmt = db.prepare('SELECT attrs FROM facts WHERE id = ?')
  for (const fact of Array.isArray(sourceFacts) ? sourceFacts : []) {
    const row = factStmt.get(String(fact.id))
    if (!row?.attrs) continue
    const saved = JSON.parse(row.attrs)
    if (JSON.stringify(saved) === JSON.stringify(fact)) factsOk += 1
  }
  const counts = bookdbCounts(db)
  db.close()
  console.log(`- 事实账本：源 ${Array.isArray(sourceFacts) ? sourceFacts.length : 0} 条 / 库 ${factsRows} 条 / 逐字段一致 ${factsOk} 条`)
  console.log(`- 库：${JSON.stringify(counts)}`)

  // 7) 旧工作区标记
  if (oldWorkspace && existsSync(oldWorkspace)) {
    await writeFile(join(oldWorkspace, '_已迁移到-0.7.md'), [
      `# 本工作区已迁移`,
      '',
      `- 迁移时间：${nowIso()}`,
      `- 新工作区：${targetDir}`,
      `- 新作品 id：${newId}`,
      `- 旧作品 id：${sourceId}`,
      '',
      '本目录保留原样（正文备份与旧会话记录）；新的写作请到新工作区，避免 Agent 在新旧目录之间读混。',
    ].join('\n'), 'utf8')
  }

  // 8) 旧作品在 library 里改名标记；注册新工作区
  const libPath = join(resolve(root), 'library.json')
  const lib = await readJson(libPath, { version: 1, projects: [] })
  const rows = Array.isArray(lib.projects) ? lib.projects : []
  for (const row of rows) {
    if (String(row.id) === String(sourceId) && !String(row.name).includes('旧')) {
      row.name = `${row.name}${oldTitleSuffix}`
    }
  }
  const newRow = rows.find((row) => String(row.id) === newId)
  if (newRow) {
    newRow.dataDir = newDir
    newRow.name = title
  }
  await writeJson(libPath, { ...lib, projects: rows })

  const regPath = workspaceRegistryPath()
  const reg = await readJson(regPath, null)
  if (reg && reg.tables && reg.tables.workspaces && reg.global) {
    const wsId = randomUUID()
    const now = nowIso()
    reg.tables.workspaces[wsId] = { path: targetDir, title: newName, sessionIds: [], createdAt: now, updatedAt: now }
    if (!Array.isArray(reg.global.workspaceIds)) reg.global.workspaceIds = []
    reg.global.workspaceIds.push(wsId)
    for (const ws of Object.values(reg.tables.workspaces)) {
      if (ws && String(ws.path) === oldWorkspace && !String(ws.title).includes('旧')) {
        ws.title = `${ws.title}${oldTitleSuffix}`
        ws.updatedAt = now
      }
    }
    await writeJson(regPath, reg)
    // 回填新作品 workspaceId
    mergedProject.workspaceId = wsId
    await writeJson(join(newDir, 'project.json'), mergedProject)
    console.log(`- 已注册 DSH 工作区 ${wsId}（需重启 DSH 才会出现在侧栏）`)
  } else {
    console.log('- 未找到 workspace 注册表：工作区目录已建好，打开工作台时会自动登记')
  }

  console.log('\n迁移完成。旧作品未删除；旧工作区已写 _已迁移到-0.7.md 标记。')
}

function bookdbCounts(db) {
  const one = (table) => Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n) || 0
  return {
    chapters: one('chapters'), paras: one('paras'), entities: one('entities'), mentions: one('mentions'),
    facts: one('facts'), events: one('events'), foreshadows: one('foreshadows'), conflicts: one('conflicts'),
    highlights: one('highlights'), outlines: one('outlines'), opinions: one('opinions'),
  }
}

main().catch((error) => {
  console.error(error?.message || error)
  process.exitCode = 1
})
