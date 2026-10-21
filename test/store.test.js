/**
 * lib/store.js：作品/章节落盘、章节版本备份/历史/恢复。
 * 覆盖契约 §2.2（自动备份、100 份上限、内容不变不备份）与 §3.1（历史 API）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import * as store from '../lib/store.js'
import { makeRoot, needFn, delay } from './helpers.js'

async function newProject(t, name = '测试作品') {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name, genre: '玄幻' })
  return { root, project }
}

test('createProject → saveChapter：作品与章节落盘', async (t) => {
  const { root, project } = await newProject(t)
  assert.ok(project.id, 'createProject 应返回作品 id')
  assert.equal(project.name, '测试作品', '作品名应保存为传入值')

  const saved = await store.saveChapter(root, project.id, { title: '第一章 启程', content: '少年走出山村。' })
  assert.equal(saved.id, '0001', '空 id 保存时章号应从 0001 开始')
  assert.equal(saved.words, store.countWords('少年走出山村。'), '返回的字数应按 countWords 计算')
  assert.equal(saved.backup, null, '首次保存没有旧文件，返回值 backup 应为 null')

  const chapters = await store.listChapters(root, project.id)
  assert.equal(chapters.length, 1, '应列出 1 章')
  assert.equal(chapters[0].title, '第一章 启程', '标题应落盘并可读回')
  assert.equal(chapters[0].content, '少年走出山村。', '正文应落盘并可读回')

  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.project.name, '测试作品', 'getBundle 应能读到作品')
  assert.equal(bundle.stats.chapters, 1, 'getBundle.stats.chapters 应为 1')
  assert.equal(bundle.stats.words, saved.words, 'getBundle.stats.words 应等于章节字数合计')
})

test('saveChapter 覆盖已有章节：自动备份旧文件，历史可读', async (t) => {
  const { root, project } = await newProject(t)
  const listHistory = needFn(store, 'listChapterHistory', 'lib/store.js')
  const readVersion = needFn(store, 'readChapterHistoryVersion', 'lib/store.js')

  const first = await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '旧稿正文。' })
  assert.equal(first.backup, null, '首次保存没有旧文件，saveChapter 返回的 backup 应为 null')
  assert.deepEqual(await listHistory(root, project.id, '0001'), [], '首次保存没有旧文件，不应产生备份')

  const changed = await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '新稿正文。' })
  assert.equal(typeof changed.backup, 'string', '覆盖保存且内容变化时，saveChapter 应返回备份文件路径')
  assert.match(changed.backup, /\.backups[\\/]/, '备份路径应落在作品的 .backups/ 目录')
  assert.match(await readFile(changed.backup, 'utf8'), /旧稿正文/, 'saveChapter 返回的备份文件应是覆盖前的旧稿')
  const history = await listHistory(root, project.id, '0001')
  assert.equal(history.length, 1, '覆盖保存且内容变化时应产生 1 条历史备份')
  assert.equal(basename(changed.backup), history[0].file, 'saveChapter 返回的 backup 应与 history 最新条目指向同一文件')

  const entry = history[0]
  assert.equal(typeof entry.file, 'string', '历史条目应包含 file 字段')
  assert.match(entry.file, /\.md$/, '历史备份应是 Markdown 文件')
  assert.ok(entry.bytes > 0, '历史条目应记录备份字节数')
  assert.ok(!Number.isNaN(Date.parse(entry.savedAt)), `历史条目应包含可解析的 savedAt，实际 ${entry.savedAt}`)

  const version = await readVersion(root, project.id, '0001', entry.file)
  assert.equal(version.file, entry.file, 'readChapterHistoryVersion 应回显对应备份文件名')
  assert.match(version.content, /旧稿正文/, '读到的是覆盖前的旧稿内容')
  assert.match(version.content, /^---/, '备份应是完整章节文件（含 frontmatter）')
  assert.ok(!version.content.includes('新稿正文'), '备份内容不应包含覆盖后的新稿')
})

test('listChapterHistory 按保存时间倒序（最新在前）', async (t) => {
  const { root, project } = await newProject(t)
  const listHistory = needFn(store, 'listChapterHistory', 'lib/store.js')
  const readVersion = needFn(store, 'readChapterHistoryVersion', 'lib/store.js')

  await store.saveChapter(root, project.id, { id: '0001', content: '第 1 版' })
  await delay()
  await store.saveChapter(root, project.id, { id: '0001', content: '第 2 版' })
  await delay()
  await store.saveChapter(root, project.id, { id: '0001', content: '第 3 版' })

  const history = await listHistory(root, project.id, '0001')
  assert.equal(history.length, 2, '三次保存应产生两条备份（第 1 版、第 2 版）')
  assert.ok(history[0].savedAt >= history[1].savedAt, '历史列表应按 savedAt 从新到旧排列')
  assert.match((await readVersion(root, project.id, '0001', history[0].file)).content, /第 2 版/, '第一条应是最近一次备份（第 2 版）')
  assert.match((await readVersion(root, project.id, '0001', history[1].file)).content, /第 1 版/, '第二条应是更早的备份（第 1 版）')
})

test('restoreChapterVersion：恢复旧稿，且恢复前先备份当前正文', async (t) => {
  const { root, project } = await newProject(t)
  const listHistory = needFn(store, 'listChapterHistory', 'lib/store.js')
  const restore = needFn(store, 'restoreChapterVersion', 'lib/store.js')

  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '旧稿正文。' })
  await delay()
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '新稿正文。' })
  const history = await listHistory(root, project.id, '0001')
  const oldVersion = history[0]

  await delay()
  const result = await restore(root, project.id, '0001', oldVersion.file)
  assert.ok(result, 'restoreChapterVersion 应返回 { chapter, backup }')
  assert.ok(result.backup, '恢复前应返回当前正文的备份路径')
  assert.equal(result.chapter?.content, '旧稿正文。', 'restoreChapterVersion 返回的 chapter 应是被恢复的旧稿内容')

  const chapters = await store.listChapters(root, project.id)
  assert.equal(chapters[0].content, '旧稿正文。', '恢复后章节正文应回到旧稿')

  const backupText = await readFile(result.backup, 'utf8')
  assert.match(backupText, /新稿正文/, '恢复前应把「新稿正文」备份下来')

  const historyAfter = await listHistory(root, project.id, '0001')
  assert.equal(historyAfter.length, 2, '恢复前应再备份一次当前正文，历史应有 2 条')
})

test('内容没变时重复保存不新增备份，内容变化才备份', async (t) => {
  const { root, project } = await newProject(t)
  const listHistory = needFn(store, 'listChapterHistory', 'lib/store.js')

  const input = { id: '0001', title: '稳定章', content: '一模一样的正文。' }
  const first = await store.saveChapter(root, project.id, input)
  assert.equal(first.backup, null, '首次保存 backup 应为 null')
  await delay()
  const again = await store.saveChapter(root, project.id, input)
  assert.equal(again.backup, null, '内容没变时 saveChapter 的 backup 应为 null')
  assert.deepEqual(await listHistory(root, project.id, '0001'), [], '序列化文本相同 → 不产生备份')

  await delay()
  const changed = await store.saveChapter(root, project.id, { ...input, content: '改过的正文。' })
  assert.equal(typeof changed.backup, 'string', '内容确实变化时 saveChapter 应返回 backup 路径')
  assert.equal((await listHistory(root, project.id, '0001')).length, 1, '内容确实变化后才产生 1 条备份')
})

test('章节备份上限：最多保留最近 100 份', async (t) => {
  const { root, project } = await newProject(t)
  const listHistory = needFn(store, 'listChapterHistory', 'lib/store.js')

  await store.saveChapter(root, project.id, { id: '0001', content: '第 0 版' })
  for (let i = 1; i <= 105; i += 1) {
    await store.saveChapter(root, project.id, { id: '0001', content: `第 ${i} 版` })
    await delay(2)
  }

  const history = await listHistory(root, project.id, '0001')
  assert.ok(history.length <= 100, `章节备份最多保留 100 份，实际 ${history.length} 份`)
  assert.ok(history.length > 0, '连续覆盖保存应至少保留 1 份备份')
  assert.equal(new Set(history.map((h) => h.file)).size, history.length, '历史备份文件名不应重复')
})
