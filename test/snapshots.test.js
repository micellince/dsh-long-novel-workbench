/**
 * 整本快照（.snapshots/）与 json 账本版本（.backups/json/）：
 * 开工前自动快照 → 改坏 → 整本回滚必须精确匹配；改动执行中禁止回滚。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import {
  createSnapshot,
  listSnapshots,
  getSnapshot,
  diffSnapshot,
  restoreSnapshot,
  restoreSnapshotChapter,
  deleteSnapshot,
} from '../lib/snapshots.js'
import { planRevisionRun, startRevisionRun, applyRevisionChapter } from '../index.js'
import { makeRoot } from './helpers.js'

function useTempRoot(t, root) {
  const previous = process.env.STORY_DESK_ROOT
  process.env.STORY_DESK_ROOT = root
  t.after(() => {
    if (previous === undefined) delete process.env.STORY_DESK_ROOT
    else process.env.STORY_DESK_ROOT = previous
  })
}

function makeCtx() {
  const prompts = []
  const controller = {
    async list() { return { items: [] } },
    async create() { return { sessionId: `sess-${prompts.length + 1}` } },
    async prompt(payload) { prompts.push(payload); return { accepted: true } },
  }
  return { ctx: { get: (name) => (name === 'sessionController' ? controller : undefined), inject: () => {}, tools: { register: () => {} } }, prompts }
}

const ORIGINAL = '第一章：华羽生看了看桌上，停了一停。\n\n“我走了。”'

async function makeProject(t, { chapters = 2 } = {}) {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name: '快照作品', genre: '武侠' })
  await store.updateProject(root, project.id, { workspaceId: 'ws-test' })
  await store.applyPreset(root, project.id, 'preset-standard')
  for (let index = 1; index <= chapters; index += 1) {
    await store.saveChapter(root, project.id, {
      id: String(index).padStart(4, '0'),
      title: `第${index}章`,
      content: index === 1 ? ORIGINAL : '第二章正文。华羽生离开。',
      characters: ['华羽生'],
    })
  }
  return { root, project }
}

test('createSnapshot：覆盖全部章节 + 账本，manifest 计数与 sha256 齐全', async (t) => {
  const { root, project } = await makeProject(t)
  const manifest = await createSnapshot(root, project.id, { label: '开工前', trigger: 'manual' })
  assert.ok(manifest.id.startsWith('snap-'))
  assert.equal(manifest.counts.chapters, 2)
  assert.ok(manifest.files.some((file) => file.path === 'project.json'))
  assert.ok(manifest.files.some((file) => file.path === 'chapters/0001.md'))
  assert.ok(manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)))
  const rows = await listSnapshots(root, project.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, '开工前')
  assert.equal(rows[0].trigger, 'manual')
  assert.equal(rows[0].files, undefined, '列表不返回文件明细')
  assert.equal((await getSnapshot(root, project.id, manifest.id)).counts.files, manifest.counts.files)
})

test('diffSnapshot：改章 / 新增章 / 删除章三类都能识别', async (t) => {
  const { root, project } = await makeProject(t)
  const manifest = await createSnapshot(root, project.id, { label: '基线' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第1章', content: '改过的正文。' })
  await store.saveChapter(root, project.id, { id: '0003', title: '第3章', content: '新增一章。' })
  await store.deleteChapter(root, project.id, '0002')
  const diff = await diffSnapshot(root, project.id, manifest.id)
  assert.ok(diff.changed.some((row) => row.path === 'chapters/0001.md'))
  assert.ok(diff.newSince.some((row) => row.path === 'chapters/0003.md'))
  assert.ok(diff.missingNow.some((row) => row.path === 'chapters/0002.md'))
  assert.equal(diff.counts.changed + diff.counts.missingNow + diff.counts.newSince, diff.counts.total)
  assert.ok(diff.counts.changed >= 1 && diff.counts.missingNow >= 1 && diff.counts.newSince >= 1)
})

test('restoreSnapshot：整本精确回到快照，新增文件被删除，并留下回滚前快照', async (t) => {
  const { root, project } = await makeProject(t)
  const manifest = await createSnapshot(root, project.id, { label: '回滚目标' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第1章', content: '被改坏的第一章。' })
  await store.saveChapter(root, project.id, { id: '0003', title: '第3章', content: '快照之后新增。' })
  await store.deleteChapter(root, project.id, '0002')
  const result = await restoreSnapshot(root, project.id, manifest.id)
  assert.equal(result.restored, manifest.files.length)
  assert.deepEqual(result.removed.sort(), ['chapters/0003.md'])
  const chapters = await store.listChapters(root, project.id)
  assert.deepEqual(chapters.map((chapter) => chapter.id), ['0001', '0002'])
  assert.equal(chapters[0].content, ORIGINAL)
  const rows = await listSnapshots(root, project.id)
  assert.equal(rows.length, 2, '回滚前自动快照必须存在')
  const safety = rows.find((row) => row.id === result.safetySnapshotId)
  assert.equal(safety.trigger, 'pre-restore')
  assert.equal((await diffSnapshot(root, project.id, manifest.id)).counts.total, 0, '回滚后与快照完全一致')
})

test('restoreSnapshot：改动执行中拒绝回滚', async (t) => {
  const { root, project } = await makeProject(t)
  const manifest = await createSnapshot(root, project.id, { label: '基线' })
  await store.saveRevision(root, project.id, { status: 'running', runId: 'rev-test' })
  await assert.rejects(() => restoreSnapshot(root, project.id, manifest.id), /改动正在执行/)
  await store.saveRevision(root, project.id, { status: 'paused' })
  assert.equal((await restoreSnapshot(root, project.id, manifest.id)).snapshotId, manifest.id)
})

test('restoreSnapshotChapter：只回滚一章，回滚前正文进 .backups', async (t) => {
  const { root, project } = await makeProject(t)
  const manifest = await createSnapshot(root, project.id, { label: '基线' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第1章', content: '改坏的第一章。' })
  const result = await restoreSnapshotChapter(root, project.id, manifest.id, '0001')
  assert.ok(result.content.endsWith(ORIGINAL), '快照里存的是整章文件（含 frontmatter）')
  const chapters = await store.listChapters(root, project.id)
  assert.equal(chapters[0].content, ORIGINAL)
  const history = await store.listChapterHistory(root, project.id, '0001')
  assert.ok(history.length >= 2, '单章回滚前自动快照 + saveChapter 备份')
})

test('deleteSnapshot：只删快照，不动当前正文', async (t) => {
  const { root, project } = await makeProject(t)
  const manifest = await createSnapshot(root, project.id, { label: '临时' })
  await deleteSnapshot(root, project.id, manifest.id)
  assert.equal((await listSnapshots(root, project.id)).length, 0)
  assert.equal((await store.listChapters(root, project.id)).length, 2)
  await assert.rejects(() => getSnapshot(root, project.id, manifest.id), /快照不存在/)
})

test('开工前自动快照 + 单章 apply 后整本回滚：正文精确匹配', async (t) => {
  const { root, project } = await makeProject(t)
  const { ctx } = makeCtx()
  const planned = await planRevisionRun(root, project.id, { tier: 'L1', chapters: ['0001', '0002'], goal: '改文风', batchSize: 5 })
  assert.equal(planned.revision.status, 'plan-ready')
  await startRevisionRun(root, project.id, ctx)
  const rows = await listSnapshots(root, project.id)
  const auto = rows.find((row) => row.trigger === 'run-start')
  assert.ok(auto, '启动改动必须自动打开工前快照')
  assert.equal(auto.counts.chapters, 2)
  await applyRevisionChapter(root, project.id, { chapter: '0001', content: ORIGINAL + '\n\n他停了一停，又退后三步。' })
  assert.notEqual((await store.listChapters(root, project.id))[0].content, ORIGINAL)
  await store.saveRevision(root, project.id, { status: 'paused' })
  await restoreSnapshot(root, project.id, auto.id)
  assert.equal((await store.listChapters(root, project.id))[0].content, ORIGINAL)
})

test('json 账本：写入前自动留旧内容，可列出版本并回滚', async (t) => {
  const { root, project } = await makeProject(t)
  await store.updateProject(root, project.id, { name: '改名前' })
  await store.updateProject(root, project.id, { name: '改名后' })
  const rows = await store.listJsonHistory(root, project.id, 'project.json')
  assert.ok(rows.length >= 1)
  const version = await store.readJsonHistoryVersion(root, project.id, 'project.json', rows[0].file)
  assert.equal(version.data.name, '改名前')
  assert.match(version.savedAt, /^\d{4}-\d{2}-\d{2}T/)
  await store.restoreJsonHistory(root, project.id, 'project.json', rows[0].file)
  assert.equal((await store.getBundle(root, project.id)).project.name, '改名前')
  const files = await readdir(join(root, 'projects', project.id, '.backups', 'json'))
  assert.ok(files.some((file) => file.startsWith('project-')))
  await assert.rejects(() => store.listJsonHistory(root, project.id, 'library.json'), /不支持版本化/)
  await assert.rejects(() => store.readJsonHistoryVersion(root, project.id, 'project.json', '../project.json'), /不合法|不属于/)
})

test('json 账本：首次写入没有旧内容，不产生备份', async (t) => {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const fresh = await store.createProject(root, { name: '空白作品' })
  assert.deepEqual(await store.listJsonHistory(root, fresh.id, 'project.json'), [], '首次写入无旧内容')
  await store.updateProject(root, fresh.id, { name: '改一次' })
  assert.equal((await store.listJsonHistory(root, fresh.id, 'project.json')).length, 1)
})
