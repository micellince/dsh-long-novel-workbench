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
