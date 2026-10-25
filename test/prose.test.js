import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeProse, scanResidue, toMarkdown } from '../lib/prose.js'

const SAMPLE = [
  '---',
  'title: 测试',
  '---',
  '',
  '# 第一章',
  '',
  '**粗体**和*斜体*，还有~~删除~~与`代码`。',
  '',
  '> 引用一句',
  '',
  '- 列表一',
  '- 列表二',
  '',
  '[链接文字](https://example.com) 和 ![图片](x.png)',
  '',
  '<em>html</em>',
  '',
  '---',
  '',
  '尾声。',
].join('\n')

test('normalizeProse：清掉 ASCII Markdown 并留痕', () => {
  const result = normalizeProse(SAMPLE)
  assert.equal(result.changed, true)
  assert.equal(result.needsFix.length, 0)
  for (const mark of ['**', '~~', '`', '](', '<em>', '# ', '> ', '![', '\n---\n']) {
    assert.equal(result.text.includes(mark), false, `不应残留 ${JSON.stringify(mark)}`)
  }
  for (const keep of ['第一章', '粗体和斜体', '引用一句', '列表一', '列表二', '链接文字 和', 'html', '※', '尾声。']) {
    assert.ok(result.text.includes(keep), `应保留 ${keep}`)
  }
  assert.equal(result.removed.frontmatter, 1)
  assert.equal(result.removed.bold, 1)
  assert.equal(result.removed.italic, 1)
  assert.equal(result.removed.strike, 1)
  assert.equal(result.removed.code, 1)
  assert.equal(result.removed.heading, 1)
  assert.equal(result.removed.list, 2)
  assert.equal(result.removed.link, 1)
  assert.equal(result.removed.image, 1)
  assert.equal(result.removed.html, 2)
  assert.equal(result.removed.hr, 1)
  assert.equal(result.removed.quote, 1)
})

test('normalizeProse：幂等（设计稿 §13）', () => {
  const once = normalizeProse(SAMPLE)
  const twice = normalizeProse(once.text)
  assert.equal(twice.text, once.text)
  assert.equal(twice.changed, false)
  assert.deepEqual(twice.needsFix, [])
})

test('normalizeProse：不碰中文标点、全角符号与数字', () => {
  const text = '他说：「走吧」……——＊全角＊ 第 3 章 2026 年'
  const result = normalizeProse(text)
  assert.equal(result.text, text)
  assert.equal(result.changed, false)
})

test('normalizeProse：表格只登记 needsFix，不自动改', () => {
  const result = normalizeProse('| 列一 | 列二 |\n| --- | --- |\n\n正文段落。')
  assert.ok(result.needsFix.includes('表格（|…|）'))
  assert.ok(result.text.includes('| 列一 |'))
})

test('normalizeProse：代码围栏问题只登记 needsFix', () => {
  const unclosed = normalizeProse('```\n第一段\n正文\n')
  assert.ok(unclosed.needsFix.includes('未闭合的代码围栏 ```'))
  assert.equal(unclosed.text.includes('```'), false)
  assert.ok(unclosed.text.includes('第一段'))

  const multi = normalizeProse('```\n第一段\n\n第二段\n```')
  assert.ok(multi.needsFix.includes('代码块内出现多段正文'))
})

test('scanResidue：干净正文返回空数组，脏正文返回片段', () => {
  assert.deepEqual(scanResidue('纯文本，没有标记。'), [])
  const dirty = scanResidue('# 标题\n\n**粗体**\n\n- 列表')
  assert.ok(dirty.length >= 3)
  assert.ok(dirty.some((item) => item.includes('粗体')))
  const normalized = normalizeProse(SAMPLE)
  assert.deepEqual(scanResidue(normalized.text), [])
})

test('toMarkdown：段落空行 + ※ → ***', () => {
  const md = toMarkdown('第一段。\n\n※\n\n第二段。')
  assert.equal(md, '第一段。\n\n***\n\n第二段。')
})
