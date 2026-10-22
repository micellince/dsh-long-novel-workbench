/**
 * lib/importer.js（扫描/导入 Markdown）与 lib/exporters.js（md/epub/docx 导出）。
 * 覆盖契约 §3.3（导入）与 §3.4–3.5（导出、ZIP 结构）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import { loadModule, makeRoot, needFn, readZip, zipText, crc32 } from './helpers.js'

/** 写一个 Markdown 小说目录：带 frontmatter 的 #、##、无标题文件、空文件。 */
async function makeMarkdownDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'storydesk-md-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const book = join(dir, 'book')
  await mkdir(book, { recursive: true })
  await writeFile(
    join(book, 'a-01.md'),
    '---\ntitle: 被忽略的 frontmatter\n---\n\n# 第一章 初见\n\n山门初开，少年提剑。\n',
    'utf8',
  )
  await writeFile(join(book, 'a-02.md'), '## 第二章 重逢\n\n三年之后，故人重逢。\n', 'utf8')
  await writeFile(join(book, 'b-03.md'), '剑光如雪，照见旧伤。\n', 'utf8')
  await writeFile(join(book, 'b-04.md'), '# 第三章 夜雨\n\n夜雨敲窗，灯火将尽。\n', 'utf8')
  await writeFile(join(book, 'c-05.md'), '', 'utf8')
  // 契约 §3.3：跳过隐藏目录、node_modules、.git，递归最大深度 5
  await mkdir(join(dir, '.hidden'), { recursive: true })
  await writeFile(join(dir, '.hidden', 'h-01.md'), '# 隐藏章\n\n不该被导入。\n', 'utf8')
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(dir, 'node_modules', 'pkg', 'n-01.md'), '# 依赖章\n\n不该被导入。\n', 'utf8')
  await mkdir(join(dir, 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true })
  await writeFile(join(dir, 'a', 'b', 'c', 'd', 'e', 'f', 'deep.md'), '# 深层章\n\n超出最大深度，不该被导入。\n', 'utf8')
  return dir
}

async function loadImporter() {
  return requireImporter(await loadModule('../lib/importer.js'))
}

function requireImporter(loaded) {
  if (loaded.error) throw new Error(`实现未完成：无法加载 lib/importer.js（${loaded.error.message}）`)
  return loaded.module
}

async function loadExporters() {
  const loaded = await loadModule('../lib/exporters.js')
  const exporters = loaded.error ? {} : loaded.module
  return exporters
}

/** exportBook 可能落在 lib/exporters.js（契约 §3.5）；旧版 markdown 导出在 lib/store.js，做兼容查找。 */
async function getExportBook() {
  const exporters = await loadExporters()
  const fn = exporters.exportBook ?? store.exportBook
  if (typeof fn !== 'function') {
    throw new Error('实现未完成：lib/exporters.js（或 lib/store.js）未导出 exportBook(root, projectId, format)')
  }
  return fn
}

async function makeExportProject(t) {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '导出测试书' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章 初见', content: '山门初开，少年提剑。' })
  await store.saveChapter(root, project.id, { id: '0002', title: '第二章 重逢', content: '三年之后，故人重逢。' })
  return { root, project }
}

// ── 导入 ──────────────────────────────────────────────────────

test('scanImport：递归扫描、默认一文件一章、H1 作标题、按章号排序、空章节跳过', async (t) => {
  const root = await makeRoot(t)
  const dir = await makeMarkdownDir(t)
  const importer = await loadImporter()
  const scanImport = needFn(importer, 'scanImport', 'lib/importer.js')

  const scan = await scanImport(root, dir)
  assert.equal(scan.path, dir, 'scanImport 应回显被扫描目录')
  assert.ok(Array.isArray(scan.files) && scan.files.length >= 4, `应扫描到至少 4 个 md 文件，实际 ${scan.files?.length}`)
  assert.ok(scan.files.some((f) => f.relPath.endsWith('a-01.md')), 'files 应包含相对路径 a-01.md')
  assert.ok(
    !scan.files.some((f) => f.relPath.includes('.hidden') || f.relPath.includes('node_modules')),
    '契约 §3.3：扫描应跳过隐藏目录与 node_modules',
  )

  assert.equal(scan.chapters.length, 4, '4 个非空文件默认一文件一章（空文件跳过）')
  const titles = scan.chapters.map((c) => c.title)
  assert.equal(titles[0], '第一章 初见', '# 一级标题应作为章节标题，且 frontmatter 被忽略')
  assert.equal(titles[1], 'a-02', '没有 H1 的文件以文件名为标题，## 留在正文里')
  assert.match(titles[2], /^b-03(\.md)?$/, '无标题文件应以文件名为标题')
  assert.equal(titles[3], '第三章 夜雨', '多文件时按文件名顺序切章')
  for (const row of scan.chapters) {
    assert.equal(typeof row.index, 'number', '章节应带数字 index')
    assert.ok(row.words > 0, `章节「${row.title}」应有字数`)
    assert.match(String(row.source), /\.md$/, '章节应记录来源文件')
  }

  const sumChapters = scan.chapters.reduce((n, c) => n + c.words, 0)
  const sumFiles = scan.files.reduce((n, f) => n + f.words, 0)
  assert.ok(
    scan.totalWords === sumChapters || scan.totalWords === sumFiles,
    `scanImport.totalWords 应等于章节字数合计（${sumChapters}）或文件字数合计（${sumFiles}），实际 ${scan.totalWords}`,
  )
})

test('runImport：作品包深度导入（章节 + 人物卡 + 大纲 + 追踪 + 规范）', async (t) => {
  const root = await makeRoot(t)
  const dir = await mkdtemp(join(tmpdir(), 'storydesk-pack-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, '正文'), { recursive: true })
  await mkdir(join(dir, 'wiki', 'entities'), { recursive: true })
  await mkdir(join(dir, 'wiki', 'raw'), { recursive: true })

  await writeFile(join(dir, '正文', '第一章正文.md'), '# 第一回 少年下山\n\n## 第一节 辞别\n\n山门初开。\n', 'utf8')
  await writeFile(join(dir, '正文', '第二章正文.md'), '# 第二回 驿道相逢\n\n## 第一节 茶棚\n\n故人重逢。\n', 'utf8')
  await writeFile(join(dir, 'wiki', 'entities', 'hua.md'), `---
title: 华羽生
tags:
  - protagonist
---

## 身份

终南派弟子。

## 性格

内敛沉稳。
`, 'utf8')
  await writeFile(join(dir, 'wiki', 'raw', '大纲.md'), '- 第一回：少年下山\n  - 辞别师父，下山遇乱\n- 第二回：驿道相逢\n  - 茶棚遇李墨白\n', 'utf8')
  await writeFile(join(dir, 'wiki', 'raw', '追踪.md'), `## 第一回 少年下山

时间：天宝十四载冬
地点：终南山云隐村

人物：华羽生（16岁，终南派，颈佩雄玉佩）、公孙子丘（师父）

事件：
- 华羽生辞别师父下山
- 小蝶送药囊

物品：雄玉佩、药囊

伏笔：
- 身世与二十年前惨案有关

---
`, 'utf8')
  await writeFile(join(dir, 'wiki', 'raw', '章回体写作规范.md'), '# 写作规范\n\n- 禁止心理独白\n- 回目要对仗\n- 每回分三节\n', 'utf8')

  const importer = await loadImporter()
  const scanImport = needFn(importer, 'scanImport', 'lib/importer.js')
  const scan = await scanImport(root, dir)
  assert.equal(scan.counts.chapters, 2)
  assert.equal(scan.counts.characters, 1)
  assert.equal(scan.counts.outlines, 2)
  assert.ok(scan.counts.events >= 2, '追踪的事件应被解析')
  assert.ok(scan.counts.facts >= 2, '追踪的人物信息应转成事实')
  assert.ok(scan.counts.foreshadow >= 1)
  assert.equal(scan.counts.presets, 1)
  assert.equal(scan.detected.characters, true)

  const runImport = needFn(importer, 'runImport', 'lib/importer.js')
  const result = await runImport(root, { path: dir, projectName: '作品包测试' })
  assert.equal(result.counts.chapters, 2)
  assert.equal(result.counts.characters, 1)
  assert.equal(result.counts.outlines, 2)

  const bundle = await store.getBundle(root, result.projectId)
  assert.equal(bundle.characters.length, 1)
  assert.equal(bundle.characters[0].name, '华羽生')
  assert.equal(bundle.characters[0].role, 'protagonist')
  assert.equal(bundle.outlines.length, 2)
  assert.equal(bundle.outlines[0].chapter, 1)
  assert.equal(bundle.events.length >= 2, true)
  assert.equal(bundle.facts.length >= 2, true)
  assert.equal(bundle.foreshadow.length >= 1, true)
  assert.ok(bundle.presets.some((preset) => /导入预设/.test(preset.name)), '应导入写作规范预设')
  assert.ok(bundle.presets.length >= 1)
  assert.equal(bundle.chapters[0].storyTime, '天宝十四载冬')
  assert.equal(bundle.chapters[0].location, '终南山云隐村')
  assert.ok(bundle.chapters[0].characters.includes('华羽生'))
  const records = await store.listImportRecords(root, result.projectId)
  assert.equal(records.length, 1)
  assert.equal(records[0].counts.chapters, 2)
})

test('runImport：中文数字文件名排序，一个文件一章，## 小节保留在正文里', async (t) => {
  const root = await makeRoot(t)
  const dir = await mkdtemp(join(tmpdir(), 'storydesk-cn-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const book = join(dir, '正文')
  await mkdir(book, { recursive: true })
  await writeFile(join(book, '第一章正文.md'), '# 第一回 剑影迷踪\n\n**【七律·少年下山】**\n\n诗。\n\n## 第一节 出山\n\n正文一。\n\n## 第二节 送别\n\n正文二。\n', 'utf8')
  await writeFile(join(book, '第二章正文.md'), '# 第二回 驿道相逢\n\n## 第一节 茶棚\n\n正文三。\n', 'utf8')
  await writeFile(join(book, '第七章正文.md'), '# 第七回 灵武即位\n\n## 第一节 安葬\n\n正文七。\n', 'utf8')

  const importer = await loadImporter()
  const scanImport = needFn(importer, 'scanImport', 'lib/importer.js')
  const scan = await scanImport(root, book)
  assert.equal(scan.chapters.length, 3, '3 个文件应为 3 章，不按 ## 小节切碎')
  assert.deepEqual(scan.chapters.map((c) => c.title), ['第一回 剑影迷踪', '第二回 驿道相逢', '第七回 灵武即位'], '应按中文数字章号排序')

  const runImport = needFn(importer, 'runImport', 'lib/importer.js')
  const result = await runImport(root, { path: book, projectName: '章回体导入' })
  const chapters = await store.listChapters(root, result.projectId)
  assert.equal(chapters.length, 3)
  assert.match(chapters[0].content, /## 第一节 出山/, '## 小节应保留在正文里')
  assert.match(chapters[0].content, /## 第二节 送别/)
  assert.equal(chapters[1].title, '第二回 驿道相逢')
  assert.equal(chapters[2].title, '第七回 灵武即位')
})

test('runImport：单个整本 Markdown 文件按 # 自动切章，split=file 时切成一章', async (t) => {
  const root = await makeRoot(t)
  const dir = await mkdtemp(join(tmpdir(), 'storydesk-single-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const file = join(dir, '全书.md')
  await writeFile(file, '# 第一章 初见\n\n正文一。\n\n# 第二章 重逢\n\n正文二。\n', 'utf8')

  const importer = await loadImporter()
  const scanImport = needFn(importer, 'scanImport', 'lib/importer.js')
  const runImport = needFn(importer, 'runImport', 'lib/importer.js')

  const scan = await scanImport(root, file)
  assert.equal(scan.chapters.length, 2, '单文件多 H1 应自动切 2 章')
  assert.deepEqual(scan.chapters.map((c) => c.title), ['第一章 初见', '第二章 重逢'])

  const asOne = await runImport(root, { path: file, projectName: '整本一章', split: 'file' })
  const oneChapter = await store.listChapters(root, asOne.projectId)
  assert.equal(oneChapter.length, 1, 'split=file 时整本文件应只导入一章')
  assert.match(oneChapter[0].content, /# 第二章 重逢/, '未切章时后续 H1 留在正文里')
})

test('runImport（new）：新建作品并写入章节，字数与 listChapters 一致', async (t) => {
  const root = await makeRoot(t)
  const dir = await makeMarkdownDir(t)
  const importer = await loadImporter()
  const runImport = needFn(importer, 'runImport', 'lib/importer.js')

  const result = await runImport(root, { path: dir, projectName: '导入测试作品' })
  assert.ok(result.projectId, 'runImport 应返回新作品 id')
  assert.equal(result.projectName, '导入测试作品', 'runImport 应回显作品名')
  assert.ok(Array.isArray(result.skipped), 'runImport 应返回 skipped 数组')
  assert.equal(result.chapters.length, 4, '应导入 4 章')
  assert.deepEqual(result.chapters.map((c) => c.id), ['0001', '0002', '0003', '0004'], '新作品章节号应从 0001 连续编号')

  const library = await store.listProjects(root)
  assert.ok(library.some((p) => p.id === result.projectId && p.name === '导入测试作品'), '作品库中应出现新作品')

  const chapters = await store.listChapters(root, result.projectId)
  assert.equal(chapters.length, 4, '落盘章节数应与导入结果一致')
  assert.deepEqual(
    result.chapters.map((c) => c.words),
    chapters.map((c) => c.words),
    '导入结果的字数应与 listChapters 计算的字数一致',
  )
  assert.equal(chapters[0].title, '第一章 初见', '第一章标题应保留')
  assert.match(chapters[0].content, /山门初开/, '第一章正文应保留')

  const bundle = await store.getBundle(root, result.projectId)
  assert.equal(bundle.stats.chapters, 4, 'getBundle 统计的章节数应为 4')
})

test('runImport（append）：续章号且不改动已有章节', async (t) => {
  const root = await makeRoot(t)
  const dir = await makeMarkdownDir(t)
  const importer = await loadImporter()
  const runImport = needFn(importer, 'runImport', 'lib/importer.js')

  const project = await store.createProject(root, { name: '追加测试作品' })
  await store.saveChapter(root, project.id, { id: '0001', title: '原有第一章', content: '原有正文一。' })
  await store.saveChapter(root, project.id, { id: '0002', title: '原有第二章', content: '原有正文二。' })

  const result = await runImport(root, { path: dir, projectId: project.id, mode: 'append' })
  assert.equal(result.projectId, project.id, 'append 模式应写回指定作品')
  assert.deepEqual(
    result.chapters.map((c) => c.id),
    ['0003', '0004', '0005', '0006'],
    'append 模式下章节号应从现有最大章号续号（0003 起）',
  )

  const chapters = await store.listChapters(root, project.id)
  assert.equal(chapters.length, 6, '追加后应有 6 章')
  assert.equal(chapters[0].title, '原有第一章', '已有章节标题不能被改动')
  assert.equal(chapters[0].content, '原有正文一。', '已有章节正文不能被改动')
  assert.equal(chapters[1].content, '原有正文二。', '已有第二章正文不能被改动')
})

// ── 导出 ──────────────────────────────────────────────────────

test('exportBook(md)：返回 Markdown 合集', async (t) => {
  const { root, project } = await makeExportProject(t)
  const exportBook = await getExportBook()

  const out = await exportBook(root, project.id, 'md')
  assert.equal(out.filename, '导出测试书.md', 'md 导出的文件名应为「书名.md」')
  assert.equal(out.mime, 'text/markdown', 'md 导出的 mime 应为 text/markdown')
  assert.equal(typeof out.markdown, 'string', 'md 导出应返回 markdown 字段')
  assert.match(out.markdown, /^# 导出测试书/m, 'markdown 应以书名一级标题开头')
  assert.ok(out.markdown.includes('第一章 初见'), 'markdown 应包含章节标题')
  assert.ok(out.markdown.includes('山门初开'), 'markdown 应包含章节正文')
})

test('exportBook(epub)：ZIP 结构合法，mimetype 首条且未压缩，必需文件齐全', async (t) => {
  const { root, project } = await makeExportProject(t)
  const exportBook = await getExportBook()

  const out = await exportBook(root, project.id, 'epub')
  assert.equal(out.filename, '导出测试书.epub', 'EPUB 文件名应为「书名.epub」')
  assert.equal(out.mime, 'application/epub+zip', 'EPUB 的 mime 应为 application/epub+zip')
  assert.equal(typeof out.base64, 'string', 'EPUB 导出应返回 base64 字段')
  assert.ok(!('markdown' in out) || out.markdown === undefined, 'EPUB 导出不应再带 markdown 字段')

  const buffer = Buffer.from(out.base64, 'base64')
  assert.deepEqual(
    [...buffer.subarray(0, 4)],
    [0x50, 0x4b, 0x03, 0x04],
    'EPUB 应以 ZIP 签名 PK\\x03\\x04 开头',
  )

  const entries = readZip(buffer)
  const names = entries.map((e) => e.name)
  assert.equal(names[0], 'mimetype', 'EPUB 的第一个条目必须是 mimetype')
  assert.equal(entries[0].method, 0, 'mimetype 必须以 store 方式（不压缩）存储')
  assert.equal(entries[0].data.toString('utf8'), 'application/epub+zip', 'mimetype 内容必须是 application/epub+zip')
  assert.equal(entries[0].localOffset, 0, 'mimetype 必须位于 ZIP 文件最前面')

  for (const required of ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml']) {
    assert.ok(names.includes(required), `EPUB 缺少必需文件：${required}`)
  }
  for (const chapterId of ['0001', '0002']) {
    assert.ok(names.includes(`OEBPS/chap-${chapterId}.xhtml`), `EPUB 缺少章节文件：OEBPS/chap-${chapterId}.xhtml`)
  }

  const opf = zipText(entries, 'OEBPS/content.opf')
  assert.match(opf, /dc:title/, 'content.opf 应包含 dc:title')
  assert.match(opf, /dc:language/, 'content.opf 应包含 dc:language')
  assert.match(opf, /dc:identifier/, 'content.opf 应包含 dc:identifier')
  assert.ok(opf.includes('导出测试书'), 'content.opf 的 dc:title 应是书名')
  assert.ok(zipText(entries, 'OEBPS/nav.xhtml').includes('第一章 初见'), 'nav.xhtml 应包含章节标题')
  assert.ok(zipText(entries, 'OEBPS/chap-0001.xhtml').includes('山门初开'), '章节 xhtml 应包含正文')

  for (const entry of entries) {
    assert.equal(entry.crc, crc32(entry.data), `ZIP 条目「${entry.name}」的 CRC32 校验失败`)
  }
})

test('exportBook(docx)：document.xml 含章节标题，必需部件齐全', async (t) => {
  const { root, project } = await makeExportProject(t)
  const exportBook = await getExportBook()

  const out = await exportBook(root, project.id, 'docx')
  assert.equal(out.filename, '导出测试书.docx', 'DOCX 文件名应为「书名.docx」')
  assert.equal(
    out.mime,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'DOCX 的 mime 应为 wordprocessingml',
  )
  assert.equal(typeof out.base64, 'string', 'DOCX 导出应返回 base64 字段')

  const buffer = Buffer.from(out.base64, 'base64')
  assert.deepEqual(
    [...buffer.subarray(0, 4)],
    [0x50, 0x4b, 0x03, 0x04],
    'DOCX 应以 ZIP 签名 PK\\x03\\x04 开头',
  )

  const entries = readZip(buffer)
  const names = entries.map((e) => e.name)
  for (const required of [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/styles.xml',
    'word/_rels/document.xml.rels',
  ]) {
    assert.ok(names.includes(required), `DOCX 缺少必需部件：${required}`)
  }

  const document = zipText(entries, 'word/document.xml')
  assert.ok(document.includes('第一章 初见'), 'word/document.xml 应包含章节标题文本')
  assert.ok(document.includes('第二章 重逢'), 'word/document.xml 应包含全部章节标题')
  assert.ok(document.includes('山门初开'), 'word/document.xml 应包含章节正文')
  assert.match(document, /Heading1/, '章节标题应使用 Heading1 样式')

  for (const entry of entries) {
    assert.equal(entry.crc, crc32(entry.data), `ZIP 条目「${entry.name}」的 CRC32 校验失败`)
  }
})
