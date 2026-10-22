/**
 * lib/ebook.js：TXT / EPUB 整本导入与章节切分。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createZip } from '../lib/zip.js'
import { runImport, scanImport } from '../lib/importer.js'
import * as store from '../lib/store.js'
import { makeRoot } from './helpers.js'

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'storydesk-ebook-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

test('TXT 整本导入：按「第X章」切成章节', async (t) => {
  const root = await makeRoot(t)
  const dir = await tempDir(t)
  const file = join(dir, '全本.txt')
  await writeFile(file, '第一章 初见\n\n山门初开。\n\n第二章 重逢\n\n三年之后。\n', 'utf8')
  const scan = await scanImport(root, file)
  assert.equal(scan.chapters.length, 2)
  assert.deepEqual(scan.chapters.map((c) => c.title), ['第一章 初见', '第二章 重逢'])
  const result = await runImport(root, { path: file, projectName: 'TXT 测试' })
  const chapters = await store.listChapters(root, result.projectId)
  assert.match(chapters[0].content, /山门初开/)
})

test('EPUB 整本导入：按 spine 读出 XHTML 章节', async (t) => {
  const root = await makeRoot(t)
  const dir = await tempDir(t)
  const file = join(dir, '全本.epub')
  const zip = createZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
    { name: 'OEBPS/content.opf', data: `<?xml version="1.0"?><package><metadata><dc:title>碧血青霜缘</dc:title></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>` },
    { name: 'OEBPS/ch1.xhtml', data: '<html><head><title>第一章 出山</title></head><body><h1>第一章 出山</h1><p>山门初开。</p></body></html>' },
    { name: 'OEBPS/ch2.xhtml', data: '<html><head><title>第二章 重逢</title></head><body><h1>第二章 重逢</h1><p>三年之后。</p></body></html>' },
  ])
  await writeFile(file, zip)
  const scan = await scanImport(root, file)
  assert.equal(scan.chapters.length, 2)
  assert.equal(scan.chapters[0].title, '第一章 出山')
  const result = await runImport(root, { path: file, projectName: 'EPUB 测试' })
  const chapters = await store.listChapters(root, result.projectId)
  assert.match(chapters[1].content, /三年之后/)
})

function makeMobi(text, title = '测试书') {
  const titleBuf = Buffer.from(title, 'utf8')
  const raw = Buffer.from(text, 'utf8')
  const compressed = Buffer.alloc(raw.length * 2)
  for (let i = 0; i < raw.length; i += 1) {
    compressed[i * 2] = 0x01
    compressed[i * 2 + 1] = raw[i]
  }
  const record0 = Buffer.alloc(232 + titleBuf.length)
  record0.writeUInt16BE(2, 0) // PalmDOC 压缩
  record0.writeUInt32BE(raw.length, 4)
  record0.writeUInt16BE(1, 8)
  record0.writeUInt16BE(4096, 10)
  record0.writeUInt16BE(0, 12)
  record0.write('MOBI', 16, 'ascii')
  record0.writeUInt32BE(232, 20)
  record0.writeUInt32BE(65001, 28)
  record0.writeUInt32BE(232, 84)
  record0.writeUInt32BE(titleBuf.length, 88)
  titleBuf.copy(record0, 232)

  const header = Buffer.alloc(94)
  header.write('BOOKMOBI', 60, 'ascii')
  header.writeUInt16BE(2, 76)
  header.writeUInt32BE(94, 78)
  header.writeUInt32BE(94 + record0.length, 86)
  return Buffer.concat([header, record0, compressed])
}

test('MOBI 整本导入：PalmDOC 解压 + 按章节切分', async (t) => {
  const root = await makeRoot(t)
  const dir = await tempDir(t)
  const file = join(dir, '全本.mobi')
  await writeFile(file, makeMobi('<html><body><h1>第一章 初见</h1><p>山门初开。</p><h1>第二章 重逢</h1><p>三年之后。</p></body></html>'))
  const scan = await scanImport(root, file)
  assert.equal(scan.chapters.length, 2)
  assert.deepEqual(scan.chapters.map((c) => c.title), ['第一章 初见', '第二章 重逢'])
  const result = await runImport(root, { path: file, projectName: 'MOBI 测试' })
  const chapters = await store.listChapters(root, result.projectId)
  assert.match(chapters[0].content, /山门初开/)
})
