/**
 * 扩写（expansion.json 单例 + 宏观方案 + 大纲闸门 + 自动采纳带备份 + MCP）。
 * 覆盖 task-17：目标字数必填、book/chapter 两模式、plan/confirmPlan/start、两套 prompt、
 * 大纲确认闸门、自动采纳与旧稿备份、advance/pause/resume/reset、MCP、estimate、预算。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import {
  apply,
  planExpansion,
  confirmExpansionPlan,
  startExpansion,
  approveExpansionOutline,
  advanceExpansion,
  pauseExpansion,
  resumeExpansion,
  estimateExpansion,
  buildExpansionPlanPrompt,
  buildExpansionGoalPrompt,
  expansionSummaryText,
} from '../index.js'
import { defaultExpansion } from '../lib/defaults.js'
import { runChecks } from '../lib/checks.js'
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
  const created = []
  const controller = {
    prompts,
    created,
    async list() { return { items: [] } },
    async create({ workspaceId }) {
      const sessionId = `sess-${created.length + 1}`
      created.push({ workspaceId, sessionId })
      return { sessionId }
    },
    async prompt(payload) {
      prompts.push(payload)
      return { accepted: true }
    },
  }
  const ctx = {
    get: (name) => (name === 'sessionController' ? controller : undefined),
    inject: () => {},
    tools: { register: () => {} },
  }
  return { ctx, controller, prompts, created }
}

async function makeProject(t, { name = '扩写作品', chapters = 2, outlines = [] } = {}) {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name, genre: '武侠' })
  await store.updateProject(root, project.id, { workspaceId: 'ws-test', workspacePath: join(root, 'ws') })
  for (let index = 1; index <= chapters; index += 1) {
    await store.saveChapter(root, project.id, { id: String(index).padStart(4, '0'), title: `第${index}章`, content: `第 ${index} 章正文，原稿内容。` })
  }
  for (const outline of outlines) await store.upsertEntity(root, project.id, 'outlines', outline)
  return { root, project }
}

function expansionFile(root, projectId) {
  return join(root, 'projects', projectId, 'expansion.json')
}

async function prepareReadyExpansion(t, { targetWords = 2000, mode = 'book', scope, plan, chapterTargets } = {}) {
  const { root, project } = await makeProject(t)
  const { ctx, prompts } = makeCtx()
  const planned = await planExpansion(root, project.id, { mode, targetWords, scope, budget: { maxTokens: 1_000_000 } }, ctx)
  const ready = await confirmExpansionPlan(root, project.id, { plan, chapterTargets })
  return { root, project, ctx, prompts, planned, ready }
}

// ── 1. idle / 目标字数必填 ──────────────────────────────────

test('idle：默认扩写不落盘，bundle.expansion 为 idle', async (t) => {
  const { root, project } = await makeProject(t)
  const expansion = await store.getExpansion(root, project.id)
  assert.deepEqual(expansion, defaultExpansion())
  assert.equal(expansion.status, 'idle')
  assert.equal(expansion.targetWords, 0, '目标字数没有默认值')
  await assert.rejects(() => readFile(expansionFile(root, project.id), 'utf8'), '未启动时不应写 expansion.json')
  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.expansion.status, 'idle')
})

test('目标字数必填：缺失/0/负数 → plan 报错「请填写目标字数」', async (t) => {
  const { root, project } = await makeProject(t)
  const { ctx, prompts } = makeCtx()
  for (const targetWords of [undefined, 0, -5, 'abc']) {
    await assert.rejects(() => planExpansion(root, project.id, { mode: 'book', targetWords }, ctx), /请填写目标字数/)
  }
  assert.equal(prompts.length, 0, '校验失败不应新建会话')
  await assert.rejects(() => readFile(expansionFile(root, project.id), 'utf8'))
})

// ── 2. plan ────────────────────────────────────────────────

test('plan(book)：planning + runId + sessionId，prompt 含目标/容量评估/逐章方案/大纲变更/禁止写正文', async (t) => {
  const { root, project } = await makeProject(t)
  const { ctx, prompts } = makeCtx()
  const result = await planExpansion(root, project.id, {
    mode: 'book',
    targetWords: 2500,
    budget: { maxTokens: 500_000, maxCostCNY: 50 },
  }, ctx)

  assert.equal(result.expansion.status, 'planning')
  assert.match(result.expansion.runId, /^exp-/)
  assert.equal(result.expansion.targetWords, 2500)
  assert.deepEqual(result.expansion.scope, { type: 'book', chapters: [] })
  assert.equal(result.sessionId, 'sess-1')
  assert.equal(result.expansion.sessionId, 'sess-1')
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].content[0].text, /目标字数/)
  for (const part of ['容量评估', '逐章方案', '大纲变更', '禁止写正文', 'novel_desk_expansion', '本阶段禁止写正文']) {
    assert.ok(result.prompt.includes(part), `plan prompt 应包含「${part}」`)
  }
  const onDisk = JSON.parse(await readFile(expansionFile(root, project.id), 'utf8'))
  assert.equal(onDisk.status, 'planning')
  assert.equal(onDisk.targetWords, 2500)
})

test('plan(chapter)：scope 锁定单章，prompt 标明单章范围', async (t) => {
  const { root, project } = await makeProject(t)
  const { ctx } = makeCtx()
  const result = await planExpansion(root, project.id, {
    mode: 'chapter',
    targetWords: 1800,
    scope: { type: 'chapter', chapters: [2, 3] },
  }, ctx)
  assert.equal(result.expansion.mode, 'chapter')
  assert.deepEqual(result.expansion.scope, { type: 'chapter', chapters: [2] }, '单章模式只保留一章')
  assert.match(result.prompt, /扩写本章/)
  assert.match(result.prompt, /第 2 章/)
})

test('confirmPlan：plan-ready，用户编辑的 chapterTargets 按白名单保存', async (t) => {
  const { root, project } = await makeProject(t)
  const { ctx } = makeCtx()
  await planExpansion(root, project.id, { mode: 'book', targetWords: 2000 }, ctx)
  const ready = await confirmExpansionPlan(root, project.id, {
    plan: { diagnosis: [{ chapter: 1, currentWords: 100, targetWords: 2000 }], capacity: [{ chapter: 1, maxWords: 1600, status: '超出容量' }], outlineChanges: [], notes: ['样张建议第 1 章'] },
    chapterTargets: [
      { chapter: 1, targetWords: 1800, type: 'scene', additions: ['雨夜追车'], outlineChangeIds: [], 恶意字段: '丢弃' },
      { chapter: 2, targetWords: 2200, type: 'structure', additions: [], outlineChangeIds: ['c1'] },
    ],
  })
  assert.equal(ready.status, 'plan-ready')
  assert.equal(ready.planConfirmed, true, '确认方案后应标记 planConfirmed（前端按钮状态）')
  assert.equal(ready.plan.diagnosis.length, 1)
  assert.equal(ready.plan.capacity[0].status, '超出容量')
  assert.equal(ready.chapterTargets.length, 2)
  assert.equal(ready.chapterTargets[0].targetWords, 1800, '单章覆盖全局目标')
  assert.deepEqual(Object.keys(ready.chapterTargets[0]).sort(), ['additions', 'chapter', 'outlineChangeIds', 'targetWords', 'type'].sort(), '白名单之外字段不落盘')
  assert.equal(ready.chapterTargets[1].type, 'structure')
})

// ── 3. start / goal prompt ─────────────────────────────────

test('start 需要 plan-ready；未确认方案直接开始 → 拒绝', async (t) => {
  const { root, project } = await makeProject(t)
  const { ctx } = makeCtx()
  await planExpansion(root, project.id, { mode: 'book', targetWords: 2000 }, ctx)
  await assert.rejects(() => startExpansion(root, project.id, ctx), /请先确认扩写方案/)
})

test('start(book)：新会话 + goal prompt 含大纲锁定/未批准内容/expansionRunId/目标字数/审修/大纲闸门', async (t) => {
  const { root, project } = await makeProject(t, {
    outlines: [{ chapter: 1, title: '第1章', summary: '摘要', beats: ['节拍A', '节拍B'] }],
  })
  const { ctx, prompts } = makeCtx()
  await planExpansion(root, project.id, { mode: 'book', targetWords: 2000 }, ctx)
  await confirmExpansionPlan(root, project.id, {
    chapterTargets: [{ chapter: 1, targetWords: 2500, type: 'scene', additions: ['雨夜'], outlineChangeIds: [] }],
  })
  const started = await startExpansion(root, project.id, ctx)
  assert.equal(started.expansion.status, 'running', '无大纲变更 → 直接 running')
  assert.equal(started.sessionId, 'sess-2', 'start 应新建会话（不复用方案会话）')
  assert.ok(started.expansion.budget.baseline && typeof started.expansion.budget.baseline.tokens === 'number')
  assert.equal(started.expansion.chapterTargets[0].targetWords, 2500)
  assert.equal(prompts.length, 2)

  const goal = started.prompt
  assert.ok(goal.startsWith('> ATTENTION IS ALL YOU NEED'), 'goal prompt 首行是原则')
  for (const part of [
    'create_goal',
    'subagent',
    '大纲节拍锁定',
    '不得引入',
    '主线',
    '章末钩子',
    '目标字数',
    '无容差',
    '禁止注水',
    '冷读分不得低于扩写前',
    '审一次',
    '修一次',
    `data.expansionRunId="${started.expansion.runId}"`,
    'data.expansion',
    '大纲闸门',
    'wait-outline',
    'op="finish"',
  ]) {
    assert.ok(goal.includes(part), `goal prompt 应包含「${part}」`)
  }
})

test('start：方案里带 outlineChanges → structuring（先补地基/等大纲确认）', async (t) => {
  const { root, project } = await makeProject(t)
  const { ctx } = makeCtx()
  await planExpansion(root, project.id, { mode: 'book', targetWords: 2000 }, ctx)
  await confirmExpansionPlan(root, project.id, {
    plan: { outlineChanges: [{ chapter: 1, title: '新增节拍', summary: '需要用户确认' }] },
  })
  const started = await startExpansion(root, project.id, ctx)
  assert.equal(started.expansion.status, 'structuring')
  assert.match(started.prompt, /待确认的大纲变更/)
})

test('start(chapter)：单章模式 prompt 标明只改该章', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 3 })
  const { ctx } = makeCtx()
  await planExpansion(root, project.id, { mode: 'chapter', targetWords: 1600, scope: { type: 'chapter', chapters: [2] } }, ctx)
  await confirmExpansionPlan(root, project.id, {})
  const started = await startExpansion(root, project.id, ctx)
  assert.equal(started.expansion.mode, 'chapter')
  assert.match(started.prompt, /单章扩写/)
  assert.match(started.prompt, /只改第 2 章/)
})

test('buildExpansionPlanPrompt / buildExpansionGoalPrompt 可直接调用', async (t) => {
  const { root, project } = await makeProject(t, { outlines: [{ chapter: 1, title: '第1章', beats: ['节拍A'] }] })
  const bundle = await store.getBundle(root, project.id)
  const expansion = { ...defaultExpansion(), mode: 'book', targetWords: 3000, runId: 'exp-test', scope: { type: 'book', chapters: [] } }
  const planPrompt = buildExpansionPlanPrompt(bundle, expansion)
  assert.match(planPrompt, /目标字数（用户必填，不得改动）：每章 3000 字/)
  assert.ok(planPrompt.includes('节拍A'))
  assert.match(planPrompt, /禁止写正文/)
  const goalPrompt = buildExpansionGoalPrompt(bundle, { ...expansion, status: 'running' })
  assert.match(goalPrompt, /runId=exp-test/)
  assert.match(goalPrompt, /现有大纲节拍锁定/)
})

// ── 4. 自动采纳 + 旧稿备份 ─────────────────────────────────

test('自动采纳：expansionRunId 匹配且 running → chapter 提案立即 accepted + 旧稿历史备份', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 1 })
  await store.saveExpansion(root, project.id, { status: 'running', runId: 'exp-auto', sessionId: 'sess-1', targetWords: 3000, mode: 'book' })

  const auto = await store.createProposal(root, project.id, {
    kind: 'chapter',
    chapter: 1,
    title: '第 1 章扩写',
    data: {
      title: '第 1 章（扩写）',
      content: '扩写后的新正文，保留原有的关键场景，并增加了雨夜追车与人物选择。',
      expansionRunId: 'exp-auto',
      expansion: { targetWords: 3000, delta: 2000, addedScenes: ['雨夜追车'], subplotIds: [], beatsPreserved: true },
    },
  })
  assert.equal(auto.status, 'accepted')
  assert.equal(auto.autoAccepted, true)
  const chapters = await store.listChapters(root, project.id)
  assert.match(chapters.find((chapter) => Number(chapter.id) === 1).content, /扩写后的新正文/)

  const history = await store.listChapterHistory(root, project.id, '0001')
  assert.equal(history.length, 1, '自动采纳前应备份旧稿（章节历史）')
  const version = await store.readChapterHistoryVersion(root, project.id, '0001', history[0].file)
  assert.match(version.content, /原稿内容/, '备份里应是扩写前的旧稿，可回滚')

  // runId 不匹配 → pending
  const mismatch = await store.createProposal(root, project.id, {
    kind: 'chapter', chapter: 2, title: '第 2 章扩写',
    data: { content: '不匹配', expansionRunId: 'exp-other' },
  })
  assert.equal(mismatch.status, 'pending')

  // 非 chapter → 不自动采纳
  const attentionProposal = await store.createProposal(root, project.id, {
    kind: 'attention', title: '注意力实测', data: { expansionRunId: 'exp-auto' }, items: [{ chapter: 1, score: 80 }],
  })
  assert.equal(attentionProposal.status, 'pending')

  // paused 状态 → 不自动采纳
  await pauseExpansion(root, project.id)
  const pausedCase = await store.createProposal(root, project.id, {
    kind: 'chapter', chapter: 2, title: '第 2 章扩写',
    data: { content: '暂停后', expansionRunId: 'exp-auto' },
  })
  assert.equal(pausedCase.status, 'pending')
})

// ── 5. 大纲闸门 approveOutline ────────────────────────────

test('approveOutline：采纳该 runId 的 pending outlines → approvedOutlineChanges、running、续跑 prompt', async (t) => {
  const { root, project } = await makeProject(t)
  const { ctx, prompts } = makeCtx()
  await store.saveExpansion(root, project.id, {
    status: 'structuring',
    runId: 'exp-outline',
    sessionId: 'sess-outline',
    targetWords: 2000,
    mode: 'book',
    chapterTargets: [{ chapter: 1, targetWords: 2000, type: 'structure', additions: [], outlineChangeIds: ['c1'] }],
  })
  const proposal = await store.createProposal(root, project.id, {
    kind: 'outlines',
    chapter: 1,
    title: '扩写大纲变更（待确认）',
    summary: '为扩写增加一个新节拍',
    items: [{ chapter: 1, title: '新增雨夜追车节拍', summary: '扩写需要', beats: ['雨夜追车', '旧节拍'] }],
    data: { expansionRunId: 'exp-outline' },
  })
  await store.saveExpansion(root, project.id, { status: 'waiting-outline' })

  const approved = await approveExpansionOutline(root, project.id, ctx)
  assert.equal(approved.accepted.length, 1)
  assert.equal(approved.accepted[0].proposalId, proposal.id)
  assert.equal(approved.expansion.status, 'running')
  assert.equal(approved.expansion.approvedOutlineChanges.length, 1)
  assert.equal((await store.getEntities(root, project.id, 'proposals')).find((row) => row.id === proposal.id).status, 'accepted')
  assert.ok((await store.getEntities(root, project.id, 'outlines')).some((row) => String(row.title).includes('雨夜追车')), '大纲应写入账本')
  assert.equal(prompts.length, 1, '确认后应向同一会话发续跑 prompt')
  assert.equal(prompts[0].sessionId, 'sess-outline')
  assert.match(prompts[0].content[0].text, /续跑/)
})

// ── 6. advance / pause / resume / reset ───────────────────

test('advance/pause/resume/reset：状态流转、notes、恢复发续跑 prompt、reset 保留正文', async (t) => {
  const { root, project } = await makeProject(t)
  const { ctx, prompts } = makeCtx()
  const { ctx: planCtx } = makeCtx()
  await planExpansion(root, project.id, { mode: 'book', targetWords: 2000 }, planCtx)
  await confirmExpansionPlan(root, project.id, {})
  const started = await startExpansion(root, project.id, planCtx)
  assert.equal(started.expansion.status, 'running')
  const sessionId = started.sessionId

  let result = await advanceExpansion(root, project.id, { stageId: 'batch-1', status: 'running', note: '开始扩写第 1 批' })
  assert.equal(result.expansion.status, 'running')
  assert.ok(result.expansion.notes.some((note) => note.text.includes('开始扩写第 1 批')))

  const paused = await pauseExpansion(root, project.id)
  assert.equal(paused.status, 'paused')
  const resumed = await resumeExpansion(root, project.id, ctx)
  assert.equal(resumed.expansion.status, 'running')
  assert.equal(resumed.sessionId, sessionId, '恢复应使用同一 sessionId')
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].content[0].text, /续跑/)
  await assert.rejects(() => resumeExpansion(root, project.id, ctx), /只有 paused\/stuck/)

  await assert.doesNotReject(() => readFile(expansionFile(root, project.id), 'utf8'))
  const reset = await store.resetExpansion(root, project.id)
  assert.equal(reset.status, 'idle')
  await assert.rejects(() => readFile(expansionFile(root, project.id), 'utf8'))
  assert.ok((await store.listChapters(root, project.id)).length >= 1, 'reset 不应删除正文')
})

// ── 7. MCP 工具 ────────────────────────────────────────────

test('MCP novel_desk_expansion：status/plan/outline-change/wait-outline/stage/finish/stuck', async (t) => {
  const { root, project } = await makeProject(t)
  const { ctx } = makeCtx()
  await planExpansion(root, project.id, { mode: 'book', targetWords: 2000 }, ctx)
  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {}, get: () => undefined })
  const tool = tools.find((row) => row.name === 'novel_desk_expansion')
  assert.ok(tool, 'apply 应注册 novel_desk_expansion 工具')

  const statusText = await tool.execute({ project: project.id, op: 'status' })
  assert.match(statusText, /# 扩写/)
  assert.match(statusText, /状态：planning/)

  const planText = await tool.execute({
    project: project.id,
    op: 'plan',
    data: {
      diagnosis: [{ chapter: 1, currentWords: 100, targetWords: 2000 }],
      capacity: [{ chapter: 1, maxWords: 1800, status: '超出容量' }],
      chapterTargets: [{ chapter: 1, targetWords: 2000, type: 'scene', additions: ['雨夜'], outlineChangeIds: [] }],
      outlineChanges: [],
      notes: ['样张：第 1 章'],
    },
  })
  assert.match(planText, /状态：plan-ready/)
  const afterPlan = await store.getExpansion(root, project.id)
  assert.equal(afterPlan.plan.diagnosis.length, 1)
  assert.equal(afterPlan.chapterTargets[0].targetWords, 2000)

  const outlineText = await tool.execute({
    project: project.id,
    op: 'outline-change',
    items: [{ chapter: 1, title: '新增节拍', summary: '等待确认', beats: ['新节拍'] }],
  })
  assert.match(outlineText, /waiting-outline/)
  assert.equal((await store.getExpansion(root, project.id)).status, 'waiting-outline')

  const waitText = await tool.execute({ project: project.id, op: 'wait-outline', reason: '需要用户确认' })
  assert.match(waitText, /状态：waiting-outline/)
  assert.ok(waitText.includes('需要用户确认'))

  const stageText = await tool.execute({ project: project.id, op: 'stage', status: 'running', note: '继续扩写' })
  assert.match(stageText, /状态：running/)
  assert.equal((await store.getExpansion(root, project.id)).status, 'running')

  const finishText = await tool.execute({ project: project.id, op: 'finish', note: '全部扩写完成' })
  assert.match(finishText, /状态：done/)
  const afterFinish = await store.getExpansion(root, project.id)
  assert.ok(afterFinish.report && typeof afterFinish.report === 'object', 'finish 应写 report')
  assert.ok(afterFinish.report.totalWords > 0, 'report 应含总字数')
  assert.equal(afterFinish.report.chapters, 2)
  assert.ok(Array.isArray(afterFinish.report.additions) && afterFinish.report.additions.some((item) => item.includes('雨夜')), 'report 应汇总新增内容')
  const stuckText = await tool.execute({ project: project.id, op: 'stuck', reason: '会话掉线' })
  assert.match(stuckText, /状态：stuck/)
  await assert.rejects(() => tool.execute({ project: project.id, op: 'nope' }), /未知操作/)
})

test('plan：允许新增/上限/样张写入 options，plan 与 goal prompt 都带约束', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 1 })
  const { ctx } = makeCtx()
  const result = await planExpansion(root, project.id, {
    mode: 'book',
    targetWords: 2000,
    additions: { subplots: true, characters: false },
    additionLimit: 2,
    sampleChapters: 1,
    allowOutlineChanges: false,
  }, ctx)
  const saved = await store.getExpansion(root, project.id)
  assert.deepEqual(saved.options.additions, { subplots: true, characters: false })
  assert.equal(saved.options.additionLimit, 2)
  assert.equal(saved.options.sampleChapters, 1)
  assert.match(result.prompt, /允许新增：旁线/)
  assert.match(result.prompt, /每类最多 2 项/)
  assert.match(result.prompt, /先扩 1 章样张/)
  const goal = buildExpansionGoalPrompt(await store.getBundle(root, project.id), saved)
  assert.match(goal, /允许新增：旁线/)
  assert.match(goal, /样张：先扩前 1 章/)
})

test('checks：扩写目标缺失 / 未达目标 / 大纲变更待确认', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 2 })
  await store.saveExpansion(root, project.id, { status: 'running', targetWords: 0 })
  assert.ok(runChecks(await store.getBundle(root, project.id)).some((check) => check.id === 'expansion-target-missing'))

  await store.saveExpansion(root, project.id, {
    targetWords: 2000,
    chapterTargets: [{ chapter: 1, targetWords: 2000 }, { chapter: 2, targetWords: 2000 }],
  })
  const under = runChecks(await store.getBundle(root, project.id)).find((check) => check.id === 'expansion-under-target')
  assert.ok(under, '应报扩写未达目标')
  assert.equal(under.level, 'warn')

  await store.saveExpansion(root, project.id, { outlineChanges: [{ chapter: 2, title: '新节拍' }], approvedOutlineChanges: [] })
  const outline = runChecks(await store.getBundle(root, project.id)).find((check) => check.id === 'expansion-outline-pending')
  assert.ok(outline, '应报大纲变更待确认')
  assert.equal(outline.level, 'warn')
})

test('checks：扩写超出方案/未批准旁线/主线节拍/冷读下降/跨章重复', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 2 })
  const repeatedSentence = '雪落无声剑光如练少年推门而入看见故人站在灯下手里握着一封没有署名的信。'
  await store.saveChapter(root, project.id, { id: '0002', title: '第2章', content: `${repeatedSentence}${repeatedSentence}` })
  await store.saveChapter(root, project.id, { id: '0001', title: '第1章', content: repeatedSentence })
  await store.saveExpansion(root, project.id, {
    status: 'done',
    targetWords: 2000,
    runId: 'exp-check',
    chapterTargets: [{ chapter: 1, targetWords: 2000, additions: [] }],
    approvedOutlineChanges: [],
  })
  await store.upsertEntity(root, project.id, 'proposals', {
    id: 'prop-exp-1', kind: 'chapter', status: 'accepted', chapter: 1, title: '扩写第1章',
    data: {
      expansionRunId: 'exp-check',
      expansion: {
        addedScenes: ['雨夜追车'],
        subplotIds: ['sub-not-approved'],
        beatsPreserved: false,
        scoreBefore: 72,
        scoreAfter: 64,
      },
    },
  })
  const bundle = await store.getBundle(root, project.id)
  const ids = new Set(runChecks(bundle).map((check) => check.id))
  for (const id of ['expansion-scene-unplanned', 'expansion-subplot-unapproved', 'expansion-beats-unpreserved', 'expansion-attention-drop', 'duplicate-passages']) {
    assert.ok(ids.has(id), `应报 ${id}`)
  }

  await store.saveExpansion(root, project.id, {
    approvedOutlineChanges: [{ id: 'chg-1', title: '新增旁线', subplotId: 'sub-not-approved' }],
    chapterTargets: [{ chapter: 1, targetWords: 2000, additions: ['雨夜追车'] }],
  })
  const after = new Set(runChecks(await store.getBundle(root, project.id)).map((check) => check.id))
  assert.ok(!after.has('expansion-scene-unplanned'), '已确认的新增场景不应再报')
  assert.ok(!after.has('expansion-subplot-unapproved'), '已批准的旁线不应再报')
})

// ── 8. estimate / 预算 ────────────────────────────────────

test('estimateExpansion：目标越高/差距越大估算越大，含 token 与费用', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 2 })
  const bundle = await store.getBundle(root, project.id)
  const low = estimateExpansion(bundle, { mode: 'book', targetWords: 1000, chapterTargets: [{ chapter: 1, targetWords: 1000 }, { chapter: 2, targetWords: 1000 }] })
  const high = estimateExpansion(bundle, { mode: 'book', targetWords: 4000, chapterTargets: [{ chapter: 1, targetWords: 4000 }, { chapter: 2, targetWords: 4000 }] })
  assert.ok(high.deltaWords > low.deltaWords)
  assert.ok(high.totalTokens > low.totalTokens)
  assert.ok(low.totalTokens > 0 && low.costCNY > 0)
  assert.match(low.note, /估算不准/)
})

test('预算：80% warning、100% 自动 paused', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 1 })
  const { ctx: planCtx } = makeCtx()
  await planExpansion(root, project.id, { mode: 'book', targetWords: 2000, budget: { maxTokens: 1000 } }, planCtx)
  await confirmExpansionPlan(root, project.id, {})
  const started = await startExpansion(root, project.id, planCtx)
  assert.equal(started.expansion.budget.maxTokens, 1000)

  await store.appendUsageRecord(root, project.id, { at: new Date().toISOString(), provider: 'deepseek-official', model: 'deepseek-flash', totalTokens: 800, inputTokens: 800 })
  let result = await advanceExpansion(root, project.id, { note: '第 1 批进度' })
  assert.equal(result.warning, true)
  assert.equal(result.expansion.status, 'running')

  await store.appendUsageRecord(root, project.id, { at: new Date().toISOString(), provider: 'deepseek-official', model: 'deepseek-flash', totalTokens: 400, inputTokens: 400 })
  result = await advanceExpansion(root, project.id, { note: '第 2 批进度' })
  assert.equal(result.expansion.status, 'paused', '超过 100% 应自动暂停')
  assert.ok(result.expansion.notes.some((note) => note.text.includes('预算超限')))
})

test('expansionSummaryText：摘要含状态/模式/目标/预算', async (t) => {
  const { root, project } = await makeProject(t)
  const { ctx } = makeCtx()
  await planExpansion(root, project.id, { mode: 'book', targetWords: 2000 }, ctx)
  const expansion = await store.getExpansion(root, project.id)
  const text = expansionSummaryText(expansion)
  assert.match(text, /状态：planning/)
  assert.match(text, /目标字数/)
  assert.ok(text.includes(expansion.runId ?? ''))
})

test('index.js：expansion.* RPC 分支存在', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  for (const op of ['expansion.get', 'expansion.plan', 'expansion.confirmPlan', 'expansion.start', 'expansion.approveOutline', 'expansion.advance', 'expansion.pause', 'expansion.resume', 'expansion.reset', 'expansion.usage']) {
    assert.ok(source.includes(`'${op}'`), `index.js 缺少 RPC 分支：${op}`)
  }
})
