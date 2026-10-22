/**
 * 注意力一号原则（task-12）：
 * plan 提案硬校验、plan 工作单置顶 + 强制补强、context 注意力前置、
 * 交接 prompt 第一优先级、旧一键 AI（lib/ai.js）补齐、章节采纳注意力合并/告警。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../lib/store.js'
import { apply, buildHandoffPrompt, ATTENTION_FIRST_PRINCIPLE } from '../index.js'
import { buildAiContext, TASK_SPECS } from '../lib/ai.js'
import { makeRoot } from './helpers.js'

function useTempRoot(t, root) {
  const previous = process.env.STORY_DESK_ROOT
  process.env.STORY_DESK_ROOT = root
  t.after(() => {
    if (previous === undefined) delete process.env.STORY_DESK_ROOT
    else process.env.STORY_DESK_ROOT = previous
  })
}

function attentionRecord(chapter, overrides = {}) {
  return {
    id: `att-${String(chapter).padStart(4, '0')}`,
    chapter,
    type: 'event',
    score: 70,
    designScore: 72,
    verdict: '会',
    weakest: 'tension',
    dropRisk: '第 9 段',
    hook: '开篇钩子',
    tension: '承压点',
    payoff: '兑现',
    cliff: '章末未决',
    question: '读者想知道什么？',
    detail: '详细说明',
    status: 'verified',
    ...overrides,
  }
}

function captureTools() {
  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {}, get: () => undefined })
  return tools
}

/** 建一个带章节（和可选 attention/世界/地点）的作品，并把 STORY_DESK_ROOT 指向临时根。 */
async function makeProject(t, { name = '一号原则作品', chapters = 3, attention = [], world = null, locations = [] } = {}) {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name, genre: '武侠' })
  for (let index = 1; index <= chapters; index += 1) {
    await store.saveChapter(root, project.id, { id: String(index).padStart(4, '0'), title: `第${index}章`, content: `第 ${index} 章正文。` })
  }
  for (const row of attention) await store.upsertEntity(root, project.id, 'attention', row)
  if (world) await store.saveWorld(root, project.id, world)
  for (const location of locations) await store.upsertEntity(root, project.id, 'locations', location)
  return { root, project }
}

// ── 1. plan 提案硬校验 ───────────────────────────────────────

test('plan 提案硬校验：缺 data.attention 或字段不合法都抛错', async (t) => {
  const { root, project } = await makeProject(t)
  const valid = { type: 'event', hook: '钩子', tension: '张力', payoff: '回报', cliff: '章末', question: '问题', designScore: 80 }

  const reject = async (data) => assert.rejects(
    () => store.createProposal(root, project.id, { kind: 'plan', title: '方案', chapter: 1, data }),
    /plan 提案必须带注意力设计（ATTENTION IS ALL YOU NEED）：data\.attention 需包含 type\/hook\/tension\/payoff\/cliff\/designScore/,
  )

  await reject({ title: '缺 attention' })
  await reject({ title: 'attention 不是对象', attention: '无' })
  await reject({ title: '缺 cliff', attention: { ...valid, cliff: '' } })
  await reject({ title: '缺 hook', attention: { ...valid, hook: '   ' } })
  await reject({ title: '缺 designScore', attention: { ...valid, designScore: undefined } })
  await reject({ title: 'type 非法', attention: { ...valid, type: 'battle' } })
  await reject({ title: 'designScore 越界', attention: { ...valid, designScore: 101 } })
  await reject({ title: 'designScore 负数', attention: { ...valid, designScore: -1 } })
  await reject({ title: 'designScore 非数字', attention: { ...valid, designScore: 'abc' } })

  const accepted = await store.createProposal(root, project.id, { kind: 'plan', title: '合格方案', chapter: 1, data: { title: '第 1 章', attention: valid } })
  assert.equal(accepted.kind, 'plan')
  assert.equal(accepted.status, 'pending')
})

// ── 2. plan 工作单：一号原则 + 注意力置顶 ────────────────────

test('plan 工作单：原则置顶，「第一优先级：注意力」在大纲/事实之前，含曲线/疲劳/目标分/四拍', async (t) => {
  const { root, project } = await makeProject(t, {
    chapters: 3,
    attention: [
      attentionRecord(1, { score: 72, designScore: 80 }),
      attentionRecord(2, { type: 'emotion', score: 68, designScore: 75 }),
      attentionRecord(3, { type: 'language', score: 75, designScore: 76 }),
    ],
  })
  await store.upsertEntity(root, project.id, 'outlines', { chapter: 4, title: '第四章大纲', summary: '大纲摘要' })
  const tools = captureTools()
  const planTool = tools.find((tool) => tool.name === 'novel_desk_plan')
  const planText = await planTool.execute({ project: project.id, chapter: 4 })

  assert.ok(planText.startsWith('# 工作单 · 第 4 章'), '工单标题应在最前')
  assert.ok(planText.includes(ATTENTION_FIRST_PRINCIPLE), '工作单应注入一号原则')
  assert.ok(planText.indexOf(ATTENTION_FIRST_PRINCIPLE) < planText.indexOf('## 第一优先级：注意力（ATTENTION IS ALL YOU NEED）'), '原则先于注意力段')
  const firstPriorityIndex = planText.indexOf('## 第一优先级：注意力（ATTENTION IS ALL YOU NEED）')
  assert.ok(firstPriorityIndex > 0)
  assert.ok(firstPriorityIndex < planText.indexOf('## 本章大纲'), '注意力段应在大纲之前')
  assert.ok(firstPriorityIndex < planText.indexOf('## 必须延续的既有事实'), '注意力段应在既有事实之前')
  assert.ok(firstPriorityIndex < planText.indexOf('## 时间线（最近）'))
  assert.ok(firstPriorityIndex < planText.indexOf('## 未回收伏笔'))
  assert.ok(firstPriorityIndex < planText.indexOf('## 进行中的冲突'))
  assert.ok(firstPriorityIndex < planText.indexOf('## 地点与移动'))
  assert.ok(planText.includes('最近 6 章注意力曲线'))
  assert.ok(planText.includes('第1章 72分/event（设计 80，实测-设计 -8）'), '曲线要含 designScore 与实测差')
  assert.match(planText, /疲劳预警：/)
  assert.ok(planText.includes('本章目标分：designScore 建议'))
  assert.ok(planText.includes('主类型建议：'))
  for (const beat of ['- hook：', '- tension：', '- payoff：', '- cliff：', '- question：']) {
    assert.ok(planText.includes(beat), `四拍要求应包含「${beat}」`)
  }
  assert.match(planText, /上一章注意力：第3章 75分\/language/)
  assert.ok(planText.includes('data.attention'), '仍要求 plan 提案带 attention 设计')
})

test('plan 强制补强：上一章 designScore-score ≥20 或低于均值-10 时输出，数据不足不输出', async (t) => {
  const tools = captureTools()
  const planTool = tools.find((tool) => tool.name === 'novel_desk_plan')

  // 情形一：设计没兑现（80 - 55 = 25 ≥ 20）
  const gapCase = await makeProject(t, {
    chapters: 1,
    attention: [attentionRecord(1, { score: 55, designScore: 80, weakest: 'tension' })],
  })
  const gapPlan = await planTool.execute({ project: gapCase.project.id, chapter: 2 })
  assert.ok(gapPlan.includes('## 补强要求（强制）'), '设计未兑现应输出强制补强段')
  assert.ok(gapPlan.includes('差 25 分'))
  assert.ok(gapPlan.includes('上一章最弱一环：张力（tension）'))
  assert.ok(gapPlan.includes('本章张力必须落在主角失去什么上'))
  assert.ok(gapPlan.indexOf('## 补强要求（强制）') < gapPlan.indexOf('## 必须延续的既有事实'), '补强段也应在既有事实之前')

  // 情形二：低于全书均值 10 分以上（均值 70，上一章 50）
  const avgCase = await makeProject(t, {
    chapters: 2,
    attention: [
      attentionRecord(1, { score: 90, designScore: 90, weakest: 'payoff' }),
      attentionRecord(2, { score: 50, designScore: 55, weakest: 'cliff' }),
    ],
  })
  const avgPlan = await planTool.execute({ project: avgCase.project.id, chapter: 3 })
  assert.ok(avgPlan.includes('## 补强要求（强制）'), '低于均值 10 分应输出强制补强')
  assert.ok(avgPlan.includes('低于全书均值 70 分超过 10 分'))
  assert.ok(avgPlan.includes('上一章最弱一环：章末牵引（cliff）'))

  // 情形三：数据不足（没有任何注意力记录）→ 不输出
  const emptyCase = await makeProject(t, { chapters: 1 })
  const emptyPlan = await planTool.execute({ project: emptyCase.project.id, chapter: 2 })
  assert.ok(!emptyPlan.includes('## 补强要求（强制）'), '数据不足不应输出强制补强')
  assert.ok(emptyPlan.includes('## 第一优先级：注意力'))
})

// ── 3. context 前置 ─────────────────────────────────────────

test('context：一号原则在最前，注意力段在人物卡/事实之前，含「读者第一」', async (t) => {
  const { root, project } = await makeProject(t, {
    chapters: 2,
    attention: [attentionRecord(1, { score: 72, designScore: 80, question: '门外是谁' })],
  })
  await store.upsertEntity(root, project.id, 'characters', { name: '甲', role: '主角' })
  await store.upsertEntity(root, project.id, 'facts', { subject: '甲', attribute: '年龄', value: '20', chapter: 1 })

  const tools = captureTools()
  const contextTool = tools.find((tool) => tool.name === 'novel_desk_context')
  const text = await contextTool.execute({ project: project.id, recent: 0 })

  assert.ok(text.includes(ATTENTION_FIRST_PRINCIPLE), 'context 必须含一号原则')
  assert.ok(text.indexOf(ATTENTION_FIRST_PRINCIPLE) < text.indexOf('## 作品设定'), '原则应在作品设定之前')
  const attentionIndex = text.indexOf('## 注意力（100 分制）')
  assert.ok(attentionIndex > 0)
  assert.ok(attentionIndex < text.indexOf('## 人物卡'), '注意力段应在人物卡之前')
  assert.ok(attentionIndex < text.indexOf('## 事实账本'), '注意力段应在事实账本之前')
  assert.ok(text.includes('读者第一：先看每章是否抓人，再看自洽'))
})

// ── 4. 交接 prompt 第一优先级 ────────────────────────────────

test('交接 prompt：常规交接原则置顶；next-chapter-plan/continue-chapter 第一优先级在交接头之前', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 2, attention: [attentionRecord(1)] })
  const bundle = await store.getBundle(root, project.id)

  const fullReview = buildHandoffPrompt(bundle, { task: 'full-review' })
  assert.ok(fullReview.startsWith(`> ${ATTENTION_FIRST_PRINCIPLE}`), '常规交接第一行应是一号原则')
  assert.ok(fullReview.includes('【工作台交接】'))

  const nextPlan = buildHandoffPrompt(bundle, { task: 'next-chapter-plan' })
  const nextPriority = nextPlan.indexOf('## 第一优先级：注意力（ATTENTION IS ALL YOU NEED）')
  assert.ok(nextPriority > 0)
  assert.ok(nextPriority < nextPlan.indexOf('【工作台交接】'), '第一优先级应在交接头之前')
  assert.ok(nextPlan.includes('attention 设计（planned）'))
  assert.ok(nextPlan.includes('正文必须按四拍落地'))

  const continueChapter = buildHandoffPrompt(bundle, { task: 'continue-chapter' })
  const continuePriority = continueChapter.indexOf('## 第一优先级：注意力（ATTENTION IS ALL YOU NEED）')
  assert.ok(continuePriority > 0)
  assert.ok(continuePriority < continueChapter.indexOf('【工作台交接】'))
  assert.ok(continueChapter.includes('正文必须按四拍落地，章末必须留未决问题'))

  const multiAgent = buildHandoffPrompt(bundle, { task: 'full-review', multiAgent: true })
  assert.ok(multiAgent.includes('注意力设计师权重最高（10），先出设计'), 'multiAgent 派单应要求注意力设计师先出设计')
})

test('交接 prompt：零上下文 fresh-read 绝不注入一号原则（单章 + 全书内联）', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 2, attention: [attentionRecord(1)] })
  const bundle = await store.getBundle(root, project.id)

  for (const body of [{ task: 'fresh-read', chapter: 1 }, { task: 'fresh-read', scope: 'book' }]) {
    const prompt = buildHandoffPrompt(bundle, body)
    assert.ok(!prompt.includes('ATTENTION IS ALL YOU NEED'), 'fresh-read prompt 不得含一号原则')
    assert.ok(!prompt.includes('创作第一原则'), 'fresh-read prompt 不得含原则文案')
    assert.match(prompt.split('\n')[0], /^零上下文首读/, 'fresh-read 仍应以零上下文指令开头')
  }
})

// ── 5. 旧一键 AI（lib/ai.js）补齐 ───────────────────────────

test('ai.buildAiContext：注意力段与世界观段都在「已写章节」之前，含平均/未标/上一章诊断', async (t) => {
  const { root, project } = await makeProject(t, {
    chapters: 3,
    attention: [
      attentionRecord(1, { type: 'mystery', score: 72, designScore: 80 }),
      attentionRecord(2, { type: 'emotion', score: 64, designScore: 70 }),
      attentionRecord(3, { weakest: 'cliff', cliff: '门外是谁' }),
    ],
    world: { name: '大唐江湖', scale: 'realm', kind: 'mixed', era: '天宝' },
    locations: [
      { id: 'loc-changan', name: '长安', type: 'capital', coords: { x: 420, y: 380 }, connections: [{ to: 'loc-luoyang', distanceKm: 380 }] },
      { id: 'loc-luoyang', name: '洛阳', type: 'city', coords: { x: 620, y: 380 }, connections: [] },
    ],
  })
  await store.saveChapter(root, project.id, { id: '0003', title: '第3章', content: '正文。', location: '洛阳' })
  const bundle = await store.getBundle(root, project.id)
  const text = buildAiContext(bundle, null)

  assert.ok(text.includes('# 注意力（第一优先级）'), '旧 AI 上下文应含注意力段')
  assert.ok(text.includes('# 世界与地点'), '旧 AI 上下文应含世界观段')
  assert.ok(text.indexOf('# 注意力（第一优先级）') < text.indexOf('# 已写章节'), '注意力段应在已写章节之前')
  assert.ok(text.indexOf('# 世界与地点') < text.indexOf('# 已写章节'), '世界观段应在已写章节之前')
  assert.match(text, /平均分：69/)
  assert.match(text, /未标：0 章已写/)
  assert.match(text, /上一章：第3章/)
  assert.ok(text.includes('最弱一环：cliff'))
  assert.ok(text.includes('大唐江湖'))
  assert.ok(text.includes('长安（capital'))
  assert.ok(text.includes('最近章节地点：第3章 洛阳'))
})

test('ai.TASK_SPECS：next-chapter-plan / continue-chapter 的 instruction 含注意力，schema 含 attention', () => {
  const planSpec = TASK_SPECS['next-chapter-plan']
  assert.match(planSpec.instruction(2), /注意力/)
  assert.match(planSpec.instruction(2), /ATTENTION IS ALL YOU NEED|事实自洽是底线/)
  assert.match(planSpec.schema(2), /"attention"/)
  assert.match(planSpec.schema(2), /designScore/)

  const continueSpec = TASK_SPECS['continue-chapter']
  assert.match(continueSpec.instruction(2), /注意力/)
  assert.match(continueSpec.instruction(2), /正文必须按四拍/)
  assert.match(continueSpec.instruction(2), /章末必须留未决问题/)
  assert.match(continueSpec.schema, /"attention"/)
  assert.match(continueSpec.schema, /designScore/)
})

// ── 6. 章节采纳：注意力合并 / attentionWarning ──────────────

test('章节采纳：带 data.attention 合并到已有设计记录；既无记录又无设计返回 attentionWarning', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 2 })
  // 第 1 章已有设计（设计师产出）
  await store.upsertEntity(root, project.id, 'attention', {
    chapter: 1, type: 'mystery', hook: '旧钩子', tension: '旧张力', payoff: '旧回报', cliff: '旧章末', designScore: 80, status: 'planned',
  })

  // 带 data.attention：合并设计字段，不新增记录
  const withAttention = await store.createProposal(root, project.id, {
    kind: 'chapter',
    chapter: 1,
    title: '第 1 章正文',
    data: { title: '第 1 章', content: '新正文。', attention: { hook: '新钩子', tension: '新张力', designScore: 88 } },
  })
  const merged = await store.acceptProposal(root, project.id, withAttention.id)
  assert.equal(merged.applied.attention, 1, '章节提案里的 attention 设计应合并进账本')
  assert.ok(!merged.attentionWarning, '带设计时不应告警')
  let rows = await store.getEntities(root, project.id, 'attention')
  assert.equal(rows.length, 1, '合并后仍只有一条记录')
  assert.equal(rows[0].hook, '新钩子')
  assert.equal(rows[0].tension, '新张力')
  assert.equal(rows[0].designScore, 88)
  assert.equal(rows[0].type, 'mystery', '未给的 type 应保留')

  // 无记录且无 data.attention：写入正文但返回 attentionWarning，不伪造设计
  const withoutAttention = await store.createProposal(root, project.id, {
    kind: 'chapter',
    chapter: 2,
    title: '第 2 章正文',
    data: { title: '第 2 章', content: '第二章正文。' },
  })
  const warned = await store.acceptProposal(root, project.id, withoutAttention.id)
  assert.equal(warned.applied.chapter, '0002')
  assert.equal(warned.attentionWarning, true, '无设计记录时采纳章节应返回 attentionWarning')
  rows = await store.getEntities(root, project.id, 'attention')
  assert.equal(rows.length, 1, '不得伪造 attention 记录')

  // 已有记录但提案不带设计：不告警
  const existingNoDesign = await store.createProposal(root, project.id, {
    kind: 'chapter',
    chapter: 1,
    title: '第 1 章修订',
    data: { title: '第 1 章', content: '再改一版。' },
  })
  const noWarn = await store.acceptProposal(root, project.id, existingNoDesign.id)
  assert.ok(!noWarn.attentionWarning, '已有设计记录时不应告警')
})
