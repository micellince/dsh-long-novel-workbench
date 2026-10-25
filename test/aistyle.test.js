/**
 * 去 AI 化审计：确定性指标（不调模型）。
 * 覆盖节拍类 / 节奏类 / 语域类三组指标，以及对阈值偏差的 flag 化。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeChapterText, auditAiStyle, auditSummaryText, scanMarkdownArtifacts, DEFAULT_THRESHOLDS } from '../lib/aistyle.js'
import { buildAiStyleReviewPrompt, buildFullBookReviewPrompt } from '../index.js'

const cold = [
  '## 第一节 某处',
  '',
  '他看了看桌上，停了一停。',
  '退后三步，站住。',
  '她又看了一眼窗，停了一下。',
  '“上头这几张，先吃。”',
  '“我走了。”',
  '“是。”',
].join('\n')

const warm = [
  '**“贤弟此言差矣。”他抚须一笑，眉间似有远山。**',
  '',
  '山风忽然紧了，卷着雪沫扑面而来。他心中一惊，几乎握不住剑，',
  '想起那年冬夜炭火噼啪、她缝一针呵一口气的模样，不禁黯然。',
  '“既如此，在下便领受了——来日必有厚报。”',
].join('\n')

test('analyzeChapterText：能数出微动作帧与步长量化', () => {
  const m = analyzeChapterText(cold)
  assert.ok(m.microFrames >= 3, '看了看/停了一停/停了一下 至少 3 处')
  assert.ok(m.stepQuant >= 1, '退后三步 应计入步长量化')
  assert.ok(m.dialogueChars > 0, '应识别出对话')
})

test('auditAiStyle：冷叙述稿应报出机器痕迹', () => {
  const chapters = Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1).padStart(4, '0'), title: `第${i + 1}章`, content: cold }))
  const audit = auditAiStyle(chapters)
  const keys = audit.flags.map((f) => f.key)
  assert.ok(keys.includes('emotionPer10kMin'), '情绪词过低必须报 blocker')
  assert.ok(keys.includes('microFramesPer10k'), '微动作帧过密必须报出')
  assert.ok(audit.overall.emotionPer10k < DEFAULT_THRESHOLDS.emotionPer10kMin)
})

test('auditAiStyle：暖叙述稿不应报情绪类问题', () => {
  const chapters = Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1).padStart(4, '0'), title: `第${i + 1}章`, content: warm }))
  const audit = auditAiStyle(chapters)
  const keys = audit.flags.map((f) => f.key)
  assert.ok(!keys.includes('emotionPer10kMin'), '有情绪词就不该报冷')
})

test('auditAiStyle：阈值可覆盖（预设 styleCards 的落点）', () => {
  const chapters = Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1), content: cold }))
  const strict = auditAiStyle(chapters, { thresholds: { microFramesPer10k: 0 } })
  const loose = auditAiStyle(chapters, { thresholds: { microFramesPer10k: 999 } })
  assert.ok(strict.flags.some((f) => f.key === 'microFramesPer10k'))
  assert.ok(!loose.flags.some((f) => f.key === 'microFramesPer10k'))
})

test('auditSummaryText：给出可读结论', () => {
  const chapters = [{ id: '0001', title: '第1章', content: cold }]
  const text = auditSummaryText(auditAiStyle(chapters))
  assert.match(text, /去 AI 化审计/)
  assert.match(text, /微动作帧/)
})

test('scanMarkdownArtifacts：各类 Markdown 残留都能识别', () => {
  const text = [
    '## 第一节 标题',
    '**粗体**与**七律**',
    '---',
    '> 引用行',
    '- 列表项',
    '`行内码`',
    '[链接](http://x)',
    '<p>html</p>',
    '正文没有标记。',
  ].join('\n')
  const scan = scanMarkdownArtifacts(text)
  assert.ok(scan.total >= 8, '应识别出至少 8 处，实际 ' + scan.total)
  for (const key of ['heading', 'bold', 'hr', 'quote', 'list', 'code', 'link', 'html']) {
    assert.ok(scan.byKind[key] >= 1, '缺少类别：' + key)
  }
  assert.ok(scan.samples.length > 0)
})

test('audit：有 Markdown 残留时第一优先报 blocker', () => {
  const audit = auditAiStyle([{ id: '0001', title: '第1章', content: '## 第一节\n**粗**\n---\n正文。' }])
  const first = audit.flags[0]
  assert.equal(first.key, 'mdArtifacts')
  assert.equal(first.severity, 'blocker')
  assert.equal(first.threshold, 0)
  assert.equal(audit.overall.mdArtifacts, 3)
  assert.equal(audit.mdChapters.length, 1)
  assert.match(auditSummaryText(audit), /第一优先级 · Markdown 残留：3 处/)
})

test('buildAiStyleReviewPrompt：把 Markdown 清理放在最前并给处理规则', () => {
  const audit = auditAiStyle([{ id: '0001', title: '第1章', content: '## 第一节\n**粗**\n正文。' }])
  const prompt = buildAiStyleReviewPrompt({ project: { name: '测试' }, chapters: [{ id: '0001', content: '## 第一节' }] }, audit)
  assert.match(prompt, /第一优先级：Markdown 残留/)
  assert.match(prompt, /## 标题改成纯文本/)
  assert.ok(prompt.indexOf('Markdown 残留') < prompt.indexOf('微动作帧密度'))
})

test('buildAiStyleReviewPrompt：写死隔离边界、只读章节清单与 origin=deai', () => {
  const audit = auditAiStyle([{ id: '0001', title: '第1章', content: '## 第一节\n**粗**\n正文。' }])
  const prompt = buildAiStyleReviewPrompt(
    { project: { name: '测试', id: 'p1' }, chapters: [{ id: '0001', content: '## 第一节' }], root: '/tmp/root' },
    audit,
    { chapterFiles: [{ id: '0001', title: '第1章', words: 1234, path: '/tmp/root/.review-workspaces/测试-p1/chapters/0001.md' }] },
  )
  assert.match(prompt, /独立会话 · 零上下文 · 只审本书/)
  assert.match(prompt, /绝对禁止跨作品对比/)
  assert.match(prompt, /读取清单以外的任何文件/)
  assert.match(prompt, /人类对照/)
  assert.match(prompt, /\/tmp\/root\/\.review-workspaces\/测试-p1\/chapters\/0001\.md/)
  assert.match(prompt, /第1章《第1章》｜1234 字/)
  assert.match(prompt, /origin="deai"/)
  assert.match(prompt, /提交前自查/)
  assert.match(prompt, /matrix\.tencent\.com\/ai-detect/)
  assert.ok(!prompt.includes('projects/p1/chapters'), '有了隔离副本后不应再指向项目原目录')
})

test('buildFullBookReviewPrompt：作者填的重点逐条进 prompt', () => {
  const prompt = buildFullBookReviewPrompt({ project: { name: '测试' }, chapters: [{}, {}] }, { focus: ['节奏是否均匀', '对白是否千篇一律'] })
  assert.match(prompt, /全文重新审阅/)
  assert.match(prompt, /1\. 节奏是否均匀/)
  assert.match(prompt, /2\. 对白是否千篇一律/)
  const empty = buildFullBookReviewPrompt({ project: { name: '测试' }, chapters: [] }, {})
  assert.match(empty, /未指定重点/)
})
