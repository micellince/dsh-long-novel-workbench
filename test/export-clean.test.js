/**
 * 导出洁净度：EPUB / DOCX / Markdown 都是给读者或出版方看的，
 * 不得漏出写作期的 Markdown 标记（##、**、>、---）。
 * 背景：导出的 EPUB 里曾残留大量 md 标识符，被出版方当成「AI 生成痕迹」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { contentBlocks, buildEpub, buildDocx } from '../lib/exporters.js'
import { readZip } from './helpers.js'

const sample = {
  project: { id: 'p1', name: '测试书', language: '中文' },
  chapters: [{
    id: '0001',
    title: '第一回 剑影迷踪寻旧事，终南少年初出山',
    content: [
      '**【七律·少年下山】**',
      '',
      '终南云隐十年深，剑气横磨待知音。',
      '',
      '---',
      '',
      '## 第一节 云隐村清晨',
      '',
      '雾从谷底漫上来，先没了溪。',
      '',
      '> 这是引用。',
      '',
      '- 带 **粗体** 的条目',
    ].join('\n'),
    summary: '测试摘要',
  }],
}

test('contentBlocks：剥掉标题、分隔线、引用、粗体与列表符', () => {
  const blocks = contentBlocks(sample.chapters[0].content)
  const types = blocks.map((b) => b.type)
  assert.ok(blocks.length > 0)
  assert.equal(types.filter((t) => t === 'h3').length, 1, '整行加粗（**【七律】**）应转为 h3')
  assert.ok(blocks.some((b) => b.type === 'h2' && b.text === '第一节 云隐村清晨'))
  assert.ok(blocks.some((b) => b.type === 'quote' && b.text === '这是引用。'))
  for (const block of blocks) {
    assert.doesNotMatch(block.text, /\*\*|^#|^>|^---/, `块里不应残留 md 标记：${block.text}`)
  }
})

test('EPUB：XHTML 中不出现 Markdown 标记', () => {
  const buffer = buildEpub(sample)
  const entries = readZip(buffer)
  const pages = entries.filter((e) => e.name.endsWith('.xhtml') && e.name.includes('chap-'))
  assert.equal(pages.length, 1)
  const html = pages[0].data.toString('utf8')
  assert.doesNotMatch(html, /##\s*第/ )
  assert.doesNotMatch(html, /\*\*/)
  assert.doesNotMatch(html, /<p>---<\/p>/)
  assert.match(html, /<h2>第一节 云隐村清晨<\/h2>/)
})

test('DOCX：document.xml 中不出现 Markdown 标记', () => {
  const buffer = buildDocx(sample)
  const entries = readZip(buffer)
  const doc = entries.find((e) => e.name === 'word/document.xml').data.toString('utf8')
  assert.doesNotMatch(doc, /\*\*/)
  assert.doesNotMatch(doc, /&gt; 摘要：/)
  assert.match(doc, /第一节 云隐村清晨/)
})
