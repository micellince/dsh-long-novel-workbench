/**
 * 导出正文（TXT / Markdown / EPUB / DOCX）测试。
 *
 * 覆盖三层：导出器纯函数（无 IO）→ store.exportBook（临时数据根）→ handleRpc 分发。
 * EPUB / DOCX 用内置的最小 ZIP 解析器读回，确认结构合法、章节齐全、没有 Markdown 残留。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

import { handleRpc, READ_OPS, RPC_OPS } from '../index.js'
import * as store from '../lib/store.js'
import {
  EXPORT_FORMATS,
  EXPORT_META,
  bookFilename,
  buildBookMarkdown,
  buildBookText,
  buildDocx,
  buildEpub,
  chapterTitle,
  contentBlocks,
  normalizeFormat,
} from '../lib/exporters.js'

// ── 测试夹具 ────────────────────────────────────────────────

const PROJECT = { id: 'pm1', title: '山河旧梦', logline: '一个说书人捡到半张残破的舆图。' }

function bundle(overrides = {}) {
  return {
    project: PROJECT,
    chapters: [
      {
        chapter: 1,
        title: '雨夜',
        content: '雨落在瓦上，像有人在外面数铜钱。\n\n※\n\n林默推门进来，抖了抖伞。',
        summary: '林默雨夜入店。',
      },
      {
        chapter: 2,
        title: '第一章　旧图',
        content: '## 残页\n\n他把残页摊在灯下，**三处**墨迹未干。\n\n> 图上有山，山后有门。',
        summary: '发现舆图。',
      },
    ],
    includeSummary: false,
    ...overrides,
  }
}

/** 最小 ZIP 读取器：解析中央目录，返回 { 文件名: { method, data } }。 */
function readZip(buffer) {
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  assert.ok(eocd >= 0, '缺少 ZIP EOCD')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = {}
  const order = []
  for (let n = 0; n < count; n += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, '中央目录签名错误')
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const raw = buffer.subarray(start, start + compressedSize)
    entries[name] = { method, data: method === 0 ? raw : inflateRawSync(raw) }
    order.push(name)
    offset += 46 + nameLen + extraLen + commentLen
  }
  return { entries, order }
}

/** 二进制缓冲区里的每个条目都必须是 UTF-8 合法文本（防止乱码/截断）。 */
function text(entries, name) {
  const entry = entries[name]
  assert.ok(entry, `缺少 ZIP 条目 ${name}`)
  return entry.data.toString('utf8')
}

/** 断言成品里没有任何写作期 Markdown 标记。 */
function assertClean(label, body) {
  assert.equal(/^#{1,6}\s/m.test(body), false, `${label} 泄漏了标题标记：${body.slice(0, 80)}`)
  assert.equal(/\*\*/.test(body), false, `${label} 泄漏了加粗标记`)
  assert.equal(/^>\s/m.test(body), false, `${label} 泄漏了引用标记`)
  assert.equal(/^(\s*)[-*+]\s+/m.test(body), false, `${label} 泄漏了列表标记`)
  assert.equal(/`/.test(body), false, `${label} 泄漏了行内代码标记`)
}

// ── ① 格式清单与参数归一 ────────────────────────────────────

test('格式清单：四种格式 + 元信息齐全', () => {
  assert.deepEqual(EXPORT_FORMATS, ['txt', 'md', 'epub', 'docx'])
  for (const format of EXPORT_FORMATS) {
    const meta = EXPORT_META[format]
    assert.ok(meta, `缺少 ${format} 的元信息`)
    assert.ok(meta.ext && meta.mime && meta.label && meta.desc, `${format} 元信息不完整`)
  }
  assert.equal(EXPORT_META.txt.mime.startsWith('text/plain'), true)
  assert.equal(EXPORT_META.epub.mime, 'application/epub+zip')
  assert.match(EXPORT_META.docx.mime, /wordprocessingml/)
})

test('normalizeFormat：别名归一，非法值报错', () => {
  assert.equal(normalizeFormat('TXT'), 'txt')
  assert.equal(normalizeFormat('markdown'), 'md')
  assert.equal(normalizeFormat('epub3'), 'epub')
  assert.equal(normalizeFormat('word'), 'docx')
  assert.equal(normalizeFormat('doc'), 'docx')
  assert.equal(normalizeFormat(''), 'txt')
  assert.equal(normalizeFormat(undefined), 'txt')
  assert.throws(() => normalizeFormat('pdf'), (error) => error.code === 'invalid' && /pdf/.test(error.message))
})

test('bookFilename：非法字符替换、超长截断、空标题兜底', () => {
  assert.equal(bookFilename('山河旧梦', 'epub'), '山河旧梦.epub')
  assert.equal(bookFilename('a/b:c*d?', 'txt'), 'a_b_c_d_.txt', '非法字符应替换为下划线')
  assert.equal(bookFilename('', 'md'), '未命名作品.md')
  assert.equal(bookFilename('   ', 'md'), '未命名作品.md')
  const long = bookFilename('长'.repeat(200), 'txt')
  assert.ok(long.length <= 80 + '.txt'.length)
})

test('chapterTitle：已有章节名原样用，否则补「第 N 章」', () => {
  assert.equal(chapterTitle({ chapter: 1, title: '雨夜' }, 0), '第 1 章　雨夜')
  assert.equal(chapterTitle({ chapter: 3, title: '第三章　旧图' }, 2), '第三章　旧图')
  assert.equal(chapterTitle({ chapter: 4, title: '第十回 风雪' }, 3), '第十回 风雪')
  assert.equal(chapterTitle({ chapter: 5, title: '' }, 4), '第 5 章')
})

test('contentBlocks：场景分隔 / 引用 / 残余标记剥离', () => {
  const blocks = contentBlocks('## 残页\n\n他把**残页**摊在灯下。\n\n※\n\n> 图上有山。\n\n- 第一\n- 第二')
  const types = blocks.map((block) => block.type)
  assert.ok(types.includes('h2'))
  assert.ok(types.includes('scene'))
  assert.ok(types.includes('quote'))
  assert.equal(types.includes('h2'), true)
  const flattened = blocks.map((block) => block.text).join('\n')
  assert.equal(/#/.test(flattened.replace(/^残页$/, '')), false, '残留了 #')
  assert.equal(/\*\*/.test(flattened), false, '残留了 **')
  // `***` / `---` / `___` 都算场景分隔
  assert.ok(contentBlocks('a\n\n***\n\nb').some((block) => block.type === 'scene'))
  assert.ok(contentBlocks('a\n\n---\n\nb').some((block) => block.type === 'scene'))
})

// ── ② TXT / Markdown 成品 ───────────────────────────────────

test('txt：作品名 + 章名 + 正文，场景保留 ※，无 Markdown 标记', () => {
  const body = buildBookText(bundle())
  assert.ok(body.includes('山河旧梦'))
  assert.ok(body.includes('林默推门进来，抖了抖伞。'))
  assert.ok(body.includes('※'), 'txt 应保留 ※ 场景分隔')
  assert.ok(body.includes('图上有山，山后有门。'))
  assert.ok(body.includes('图上有山'))
  // 章节按章号顺序出现
  assert.ok(body.indexOf('雨夜') < body.indexOf('旧图'))
  assertClean('txt', body)
})

test('md：一级标题作品名 + 二级标题章名，场景转为 ***', () => {
  const body = buildBookMarkdown(bundle())
  assert.match(body, /^# 山河旧梦/m)
  assert.match(body, /^## /m)
  assert.match(body, /^\*\*\*$/m, '场景分隔应转为 ***')
  assert.ok(body.includes('林默推门进来，抖了抖伞。'))
  assert.equal(/\*\*[^*]+\*\*/.test(body.replace(/^\*\*\*$/gm, '')), false, 'md 应清洗掉加粗残留')
})

test('空书：TXT / MD 不塌，给一句提示', () => {
  const empty = { project: { title: '空书' }, chapters: [], includeSummary: false }
  const body = buildBookText(empty)
  assert.ok(body.includes('空书'))
  assert.equal(chapterTitle({ chapter: 1, title: 'x' }), '第 1 章　x')
  assert.ok(typeof buildBookMarkdown(empty) === 'string')
})

// ── ③ EPUB 结构 ─────────────────────────────────────────────

test('epub：ZIP 合法、mimetype 首条且不压缩、nav/opf 齐全、章节齐全', () => {
  const buffer = buildEpub(bundle())
  assert.ok(Buffer.isBuffer(buffer))
  const { entries, order } = readZip(buffer)

  assert.equal(order[0], 'mimetype', 'mimetype 必须是第一条')
  assert.equal(entries.mimetype.method, 0, 'mimetype 必须不压缩')
  assert.equal(entries.mimetype.data.toString(), 'application/epub+zip')
  assert.ok(entries['META-INF/container.xml'], '缺少 container.xml')
  assert.match(text(entries, 'META-INF/container.xml'), /OEBPS\/content\.opf/)

  const opfName = order.find((name) => name.endsWith('content.opf'))
  const opf = text(entries, opfName)
  assert.match(opf, /<dc:title>山河旧梦<\/dc:title>/)
  assert.match(opf, /<dc:identifier[^>]*>urn:uuid:/)
  assert.match(opf, /dcterms:modified/)
  assert.equal((opf.match(/<itemref /g) || []).length, 2, '两章应有两个 itemref')
  assert.ok(opf.includes('nav.xhtml'))

  const navName = order.find((name) => name.endsWith('nav.xhtml'))
  const nav = text(entries, navName)
  assert.match(nav, /山河旧梦/)
  assert.equal(/<a href="[^"]*"/.test(nav), true)

  // 章节正文：两页，且清洗过 Markdown
  const pages = order.filter((name) => /^OEBPS\/chap-[^/]+\.xhtml$/.test(name))
  assert.equal(pages.length, 2, `章节文件数不对：${order.join(', ')}`)
  const joined = pages.map((name) => text(entries, name)).join('\n')
  assert.ok(joined.includes('林默推门进来'))
  assert.ok(joined.includes('图上有山'))
  assertClean('epub', joined.replace(/<[^>]+>/g, ''))
})

test('epub：空书不塌（至少一页），重复章号不致命', () => {
  const emptyZip = readZip(buildEpub({ project: { title: '空书' }, chapters: [] }))
  assert.ok(emptyZip.entries['mimetype'])
  const dupZip = readZip(buildEpub({
    project: { title: '重复' },
    chapters: [
      { chapter: 1, title: 'A', content: '甲' },
      { chapter: 1, title: 'B', content: '乙' },
    ],
  }))
  const ids = dupZip.order.filter((name) => /\.xhtml$/.test(name) && !/nav/.test(name))
  assert.equal(new Set(ids).size, ids.length, '章节文件名必须唯一')
})

// ── ④ DOCX 结构 ─────────────────────────────────────────────

test('docx：OOXML 必备部件齐全，正文含章节文字且无 Markdown 标记', () => {
  const buffer = buildDocx(bundle())
  const { entries } = readZip(buffer)
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels']) {
    assert.ok(entries[name], `缺少 DOCX 部件 ${name}`)
  }
  assert.match(text(entries, '[Content_Types].xml'), /wordprocessingml\.document\.main\+xml/)
  const document = text(entries, 'word/document.xml')
  assert.ok(document.includes('山河旧梦'))
  assert.ok(document.includes('林默推门进来'))
  assert.ok(document.includes('图上有山'))
  assert.match(document, /w:val="Heading1"/, '章名应用 Heading1 样式')
  assert.match(text(entries, 'word/styles.xml'), /Heading1/)
  assertClean('docx', document.replace(/<[^>]+>/g, ''))
})

// ── ⑤ store.exportBook（真实目录）───────────────────────────

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-nd-export-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function seededProject(root) {
  const project = await store.createProject(root, { title: '山河旧梦', logline: '一句话' })
  await store.saveChapter(root, project.id, 1, '雨落在瓦上。\n\n※\n\n林默推门进来。', { title: '雨夜', summary: '入店' })
  await store.saveChapter(root, project.id, 2, '残页摊在灯下。', { title: '旧图' })
  return project
}

test('store.exportBook：txt / md 返回文本，epub / docx 返回 base64', async (t) => {
  const root = await tempRoot(t)
  const project = await seededProject(root)

  const txt = await store.exportBook(root, project.id, 'txt')
  assert.equal(txt.format, 'txt')
  assert.equal(txt.filename, '山河旧梦.txt')
  assert.equal(txt.mime, 'text/plain; charset=utf-8')
  assert.equal(txt.chapters, 2)
  assert.ok(txt.words > 0)
  assert.ok(txt.text.includes('林默推门进来'))
  assert.equal(txt.base64, undefined)

  const md = await store.exportBook(root, project.id, 'markdown')
  assert.equal(md.format, 'md')
  assert.match(md.text, /^# 山河旧梦/m)
  assert.equal(md.filename, '山河旧梦.md')

  for (const format of ['epub', 'docx']) {
    const value = await store.exportBook(root, project.id, format)
    assert.equal(value.format, format)
    assert.equal(value.filename, `山河旧梦.${EXPORT_META[format].ext}`)
    assert.equal(value.text, undefined)
    const buffer = Buffer.from(value.base64, 'base64')
    assert.ok(buffer.length > 200, `${format} 成品过小`)
    const { entries } = readZip(buffer)
    if (format === 'epub') assert.ok(entries['mimetype'], 'epub 缺 mimetype')
    else assert.ok(entries['word/document.xml'], 'docx 缺 document.xml')
  }
})

test('store.exportBook：附提要时才含 summary 字段内容', async (t) => {
  const root = await tempRoot(t)
  const project = await seededProject(root)
  const plain = await store.exportBook(root, project.id, 'txt')
  assert.equal(plain.includeSummary, false)
  const withSummary = await store.exportBook(root, project.id, 'md', { includeSummary: true })
  assert.equal(withSummary.includeSummary, true)
})

test('store.exportBook：未知作品/非法格式报错', async (t) => {
  const root = await tempRoot(t)
  const project = await seededProject(root)
  await assert.rejects(store.exportBook(root, 'nope', 'txt'))
  await assert.rejects(store.exportBook(root, project.id, 'pdf'), (error) => error.code === 'invalid')
})

// ── ⑥ RPC 分发 ──────────────────────────────────────────────

test('RPC：export.book 进契约，分发到 store 并透传参数', async () => {
  assert.ok(READ_OPS.includes('export.book'))
  assert.ok(RPC_OPS.includes('export.book'))

  const calls = []
  const fakeStore = {
    ensureRoot: async () => {},
    exportBook: async (root, projectId, format, options) => {
      calls.push({ root, projectId, format, options })
      return { filename: `x.${format}`, mime: 'text/plain', format, chapters: 1, words: 2, text: '正文' }
    },
  }
  const value = await handleRpc(
    { op: 'export.book', payload: { projectId: 'p1', format: 'epub', includeSummary: true } },
    {},
    { store: fakeStore, root: '/tmp/nd-export-root' },
  )
  assert.equal(value.filename, 'x.epub')
  assert.deepEqual(calls, [{ root: '/tmp/nd-export-root', projectId: 'p1', format: 'epub', options: { includeSummary: true } }])

  // 缺 format 默认 txt
  await handleRpc({ op: 'export.book', payload: { projectId: 'p1' } }, {}, { store: fakeStore, root: '/tmp/nd-export-root' })
  assert.equal(calls[1].format, 'txt')

  // 缺 projectId 报 invalid
  await assert.rejects(
    handleRpc({ op: 'export.book', payload: {} }, {}, { store: fakeStore, root: '/tmp/nd-export-root' }),
    (error) => error.code === 'invalid',
  )
})

test('RPC：非法格式由 store 抛 invalid（错误码透传）', async () => {
  const fakeStore = {
    ensureRoot: async () => {},
    exportBook: async () => {
      const error = new Error('不支持的导出格式：pdf（可选 txt / md / epub / docx）')
      error.code = 'invalid'
      throw error
    },
  }
  await assert.rejects(
    handleRpc({ op: 'export.book', payload: { projectId: 'p1', format: 'pdf' } }, {}, { store: fakeStore, root: '/tmp/nd-export-root' }),
    (error) => error.code === 'invalid' && /pdf/.test(error.message),
  )
})
