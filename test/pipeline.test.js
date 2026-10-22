/**
 * 生成整本书流水线（pipeline.json 单例 + goal 会话 + 自动采纳 + 预算）。
 * 覆盖 task-15：idle/prepare/markPrepared/startRun/prompt/advance/resume/MCP/estimate/预算/自动采纳。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import {
  apply,
  preparePipeline,
  markPipelinePrepared,
  startPipelineRun,
  advancePipeline,
  pausePipeline,
  resumePipeline,
  estimatePipeline,
  buildPipelineGoalPrompt,
  buildPipelinePreparePrompt,
  pipelineSummaryText,
} from '../index.js'
import { makeRoot } from './helpers.js'

function useTempRoot(t, root) {
  const previous = process.env.STORY_DESK_ROOT
  process.env.STORY_DESK_ROOT = root
  t.after(() => {
    if (previous === undefined) delete process.env.STORY_DESK_ROOT
    else process.env.STORY_DESK_ROOT = previous
  })
}

/** 假会话服务：记录 create/prompt，足以验证 prepare/startRun/resume。 */
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

async function makeProject(t, { name = '流水线作品', targetChapters = 0, chapters = 0, outlines = [] } = {}) {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name, genre: '武侠', targetChapters })
  await store.updateProject(root, project.id, { workspaceId: 'ws-test', workspacePath: join(root, 'ws') })
  for (let index = 1; index <= chapters; index += 1) {
    await store.saveChapter(root, project.id, { id: String(index).padStart(4, '0'), title: `第${index}章`, content: `第 ${index} 章正文。` })
  }
  for (const outline of outlines) await store.upsertEntity(root, project.id, 'outlines', outline)
  return { root, project }
}

function pipelineFile(root, projectId) {
  return join(root, 'projects', projectId, 'pipeline.json')
}

// ── 1. idle 默认 ────────────────────────────────────────────

test('idle：默认流水线不落盘，bundle.pipeline 为 idle', async (t) => {
  const { root, project } = await makeProject(t)
  const pipeline = await store.getPipeline(root, project.id)
  assert.equal(pipeline.id, 'pipeline')
  assert.equal(pipeline.status, 'idle')
  assert.deepEqual(pipeline.stages, [])
  assert.deepEqual(pipeline.prepared, { blueprint: false, outline: false })
  await assert.rejects(() => readFile(pipelineFile(root, project.id), 'utf8'), '未启动时不应写 pipeline.json')

  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.pipeline.status, 'idle', 'getBundle 应带 pipeline')
})

// ── 2. 准备阶段 ─────────────────────────────────────────────

test('prepare：进入 preparing，生成 prep/卷/总审阶段，新会话并投递准备 prompt', async (t) => {
  const { root, project } = await makeProject(t, { targetChapters: 10 })
  const { ctx, prompts } = makeCtx()
  const result = await preparePipeline(root, project.id, {
    base: { premise: '雪夜复仇', genre: '武侠', chaptersPerVolume: 5, wordsPerChapter: 3000 },
    budget: { maxTokens: 1_000_000, maxCostCNY: 100 },
  }, ctx)

  assert.equal(result.pipeline.status, 'preparing')
  assert.equal(result.sessionId, 'sess-1')
  assert.equal(result.pipeline.sessionId, 'sess-1')
  assert.equal(result.pipeline.currentStage, 'prep-blueprint')
  assert.equal(result.pipeline.base.premise, '雪夜复仇')
  assert.equal(result.pipeline.base.chaptersPerVolume, 5)
  assert.equal(result.pipeline.budget.maxTokens, 1_000_000)
  const stageIds = result.pipeline.stages.map((stage) => stage.id)
  assert.deepEqual(stageIds.slice(0, 2), ['prep-blueprint', 'prep-outline'], '前两个阶段应是准备')
  assert.ok(stageIds.includes('write-1') && stageIds.includes('review-1') && stageIds.includes('fix-1'))
  assert.ok(stageIds.includes('write-2'))
  assert.deepEqual(stageIds.slice(-2), ['final-review', 'final-fix'])
  const write1 = result.pipeline.stages.find((stage) => stage.id === 'write-1')
  assert.deepEqual({ from: write1.chapterFrom, to: write1.chapterTo }, { from: 1, to: 5 })
  const write2 = result.pipeline.stages.find((stage) => stage.id === 'write-2')
  assert.deepEqual({ from: write2.chapterFrom, to: write2.chapterTo }, { from: 6, to: 10 })

  assert.equal(prompts.length, 1, 'prepare 应新建会话并投递一条 prompt')
  assert.equal(prompts[0].sessionId, 'sess-1')
  assert.match(prompts[0].content[0].text, /准备阶段/)
  for (const part of ['注意力蓝图', '全书大纲', 'attention planned', 'novel_desk_propose', '不要写正文', 'kind=attention']) {
    assert.ok(result.prompt.includes(part), `准备 prompt 应包含「${part}」`)
  }
  const onDisk = JSON.parse(await readFile(pipelineFile(root, project.id), 'utf8'))
  assert.equal(onDisk.status, 'preparing')
})

test('markPrepared：准备阶段收尾 → ready，prepared.blueprint/outline=true', async (t) => {
  const { root, project } = await makeProject(t, { targetChapters: 6 })
  const { ctx } = makeCtx()
  await preparePipeline(root, project.id, { base: { chaptersPerVolume: 3 } }, ctx)

  const ready = await markPipelinePrepared(root, project.id)
  assert.equal(ready.status, 'ready')
  assert.deepEqual(ready.prepared, { blueprint: true, outline: true })
  assert.equal(ready.stages.find((stage) => stage.id === 'prep-blueprint').status, 'done')
  assert.equal(ready.stages.find((stage) => stage.id === 'prep-outline').status, 'done')
  assert.equal(ready.currentStage, 'write-1')
})

// ── 3. startRun ─────────────────────────────────────────────

test('startRun：新书未验收准备阶段 → 拒绝', async (t) => {
  const { root, project } = await makeProject(t, { targetChapters: 10 })
  const { ctx } = makeCtx()
  await assert.rejects(() => startPipelineRun(root, project.id, { mode: 'book' }, ctx), /新书必须先完成准备阶段/)
})

test('startRun(book)：阶段范围/runId/sessionId/target 正确，投递 goal prompt', async (t) => {
  const { root, project } = await makeProject(t, { targetChapters: 10 })
  const { ctx, prompts } = makeCtx()
  await preparePipeline(root, project.id, { base: { chaptersPerVolume: 5 } }, ctx)
  await markPipelinePrepared(root, project.id)

  const result = await startPipelineRun(root, project.id, { mode: 'book' }, ctx)
  assert.equal(result.pipeline.status, 'running')
  assert.match(result.pipeline.runId, /^run-/)
  assert.equal(result.sessionId, 'sess-2', 'startRun 应新开会话')
  assert.equal(result.pipeline.sessionId, 'sess-2')
  assert.equal(result.pipeline.mode, 'book')
  assert.equal(result.pipeline.targetChapter, 10)
  assert.equal(result.pipeline.currentStage, 'write-1')
  assert.deepEqual(result.pipeline.prepared, { blueprint: true, outline: true })
  assert.ok(result.pipeline.stages.filter((stage) => stage.kind.startsWith('prep-')).every((stage) => stage.status === 'done'), '准备阶段应标记 done')
  const write2 = result.pipeline.stages.find((stage) => stage.id === 'write-2')
  assert.deepEqual({ from: write2.chapterFrom, to: write2.chapterTo }, { from: 6, to: 10 })
  assert.ok(result.pipeline.budget.baseline && typeof result.pipeline.budget.baseline.tokens === 'number', 'startRun 应记录用量 baseline')

  assert.equal(prompts.length, 2, 'prepare + startRun 各一条 prompt')
  const goalPrompt = prompts[1].content[0].text
  assert.equal(goalPrompt, result.prompt)
  assert.ok(goalPrompt.startsWith('> ATTENTION IS ALL YOU NEED'), 'goal prompt 首行是原则')
  for (const part of ['create_goal', 'max_goal_rounds', 'subagent', '不要问作者', '不要中途停', 'novel_desk_pipeline', `data.pipelineRunId="${result.pipeline.runId}"`, '停止条件', '平均注意力', '独立审稿人', '每卷']) {
    assert.ok(goalPrompt.includes(part), `goal prompt 应包含「${part}」`)
  }
  assert.match(goalPrompt, /max_goal_rounds 至少 50/, '目标 10 章时 max_goal_rounds 至少 50')
})

test('startRun(chapters)：半成品自动 prepared，目标=当前最大章+count，阶段覆盖新增章', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 2 })
  const { ctx } = makeCtx()
  await assert.rejects(() => startPipelineRun(root, project.id, { mode: 'chapters', count: 0 }, ctx), /count > 0/)
  const result = await startPipelineRun(root, project.id, { mode: 'chapters', count: 3 }, ctx)

  assert.equal(result.pipeline.mode, 'chapters')
  assert.equal(result.pipeline.count, 3)
  assert.equal(result.pipeline.targetChapter, 5, 'chapters 模式目标 = 当前最大章 2 + 3')
  assert.deepEqual(result.pipeline.prepared, { blueprint: true, outline: true }, '半成品自动视为已准备')
  const write1 = result.pipeline.stages.find((stage) => stage.id === 'write-1')
  assert.deepEqual({ from: write1.chapterFrom, to: write1.chapterTo }, { from: 3, to: 5 })
  assert.ok(result.prompt.includes('再写 3 章'), '停止条件应写明本批章数')
})

test('startRun(book)：半成品无目标章数时可用「生成设置」显式指定 targetChapter', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 2 })
  const { ctx } = makeCtx()

  // 没有 targetChapters / 没有大纲 / 没有历史 target → 无法推断目标，给清晰报错
  await assert.rejects(
    () => startPipelineRun(root, project.id, { mode: 'book' }, ctx),
    /目标章数（未设置）不大于当前进度（2 章）/,
    '无目标时应提示去生成设置里填目标章数',
  )

  // 显式指定目标章数即可从第 3 章开始续写到第 6 章
  const result = await startPipelineRun(root, project.id, { mode: 'book', targetChapter: 6 }, ctx)
  assert.equal(result.pipeline.targetChapter, 6)
  assert.equal(result.pipeline.mode, 'book')
  const write1 = result.pipeline.stages.find((stage) => stage.id === 'write-1')
  assert.deepEqual({ from: write1.chapterFrom, to: write1.chapterTo }, { from: 3, to: 6 })
  assert.ok(result.prompt.includes('第 3–6 章') || result.prompt.includes('第 3-6 章') || result.prompt.includes('第 3'), 'goal prompt 应写明续写范围')
})

test('buildPipelineGoalPrompt / buildPipelinePreparePrompt 可直接调用', async (t) => {
  const { root, project } = await makeProject(t, { targetChapters: 12, chapters: 1 })
  const bundle = await store.getBundle(root, project.id)
  const pipeline = {
    runId: 'run-test',
    mode: 'book',
    targetChapter: 12,
    base: { chaptersPerVolume: 6, wordsPerChapter: 3000 },
    stages: [{ id: 'write-1', name: '第1卷写作', status: 'pending', chapterFrom: 2, chapterTo: 7 }],
    budget: { maxTokens: 0, maxCostCNY: 0 },
  }
  const goal = buildPipelineGoalPrompt(bundle, pipeline)
  assert.ok(goal.startsWith('> ATTENTION IS ALL YOU NEED'))
  assert.ok(goal.includes('runId=run-test'))
  assert.ok(goal.includes('第 2–12 章'))
  assert.ok(goal.includes('data.pipelineRunId="run-test"'))
  const prepare = buildPipelinePreparePrompt(bundle, { ...pipeline, targetChapter: 12, base: { chaptersPerVolume: 6, wordsPerChapter: 3000 } })
  for (const part of ['注意力蓝图', '每章一个 item', 'kind=attention', 'kind=world', 'kind=locations', 'kind=outlines', '不要写正文']) {
    assert.ok(prepare.includes(part), `准备 prompt 应包含「${part}」`)
  }
})

// ── 4. advance / resume ────────────────────────────────────

test('advance：running/done 状态流转、currentStage 指针、notes 记录，全部完成 → done', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 1 })
  const { ctx } = makeCtx()
  const started = await startPipelineRun(root, project.id, { mode: 'chapters', count: 2 }, ctx)
  const pendingIds = started.pipeline.stages.filter((stage) => stage.status === 'pending').map((stage) => stage.id)
  assert.ok(pendingIds.length >= 3)

  let result = await advancePipeline(root, project.id, { stageId: 'write-1', status: 'running', note: '开始写第一卷' })
  assert.equal(result.pipeline.currentStage, 'write-1')
  assert.equal(result.pipeline.stages.find((stage) => stage.id === 'write-1').status, 'running')
  assert.ok(result.pipeline.notes.at(-1).text.includes('开始写第一卷'))

  result = await advancePipeline(root, project.id, { stageId: 'write-1', status: 'done', note: '写完' })
  assert.equal(result.pipeline.stages.find((stage) => stage.id === 'write-1').status, 'done')
  assert.equal(result.pipeline.currentStage, 'review-1')

  for (const stageId of pendingIds.slice(1)) {
    result = await advancePipeline(root, project.id, { stageId, status: 'done' })
  }
  assert.equal(result.pipeline.status, 'done', '全部阶段完成后流水线应为 done')
  assert.equal(result.pipeline.currentStage, null)
  assert.ok(result.pipeline.notes.some((note) => note.text.includes('全部阶段完成')))

  await assert.rejects(() => advancePipeline(root, project.id, { stageId: 'no-such-stage', status: 'done' }), /没有这个阶段/)
})

test('pause / resume：暂停保留现场；恢复向同一 sessionId 发续跑 prompt', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 1 })
  const { ctx, prompts } = makeCtx()
  const started = await startPipelineRun(root, project.id, { mode: 'chapters', count: 1 }, ctx)
  const sessionId = started.sessionId

  const paused = await pausePipeline(root, project.id)
  assert.equal(paused.status, 'paused')
  await assert.rejects(() => resumePipeline(root, project.id, { get: () => undefined }), /无法发送续跑 prompt|没有会话/)

  const resumed = await resumePipeline(root, project.id, ctx)
  assert.equal(resumed.pipeline.status, 'running')
  assert.equal(resumed.sessionId, sessionId, '恢复应使用同一 sessionId')
  assert.equal(prompts.length, 2, 'startRun + resume 各一条')
  assert.match(prompts[1].content[0].text, /续跑/)
  assert.match(prompts[1].content[0].text, new RegExp(`runId=${started.pipeline.runId}`))
  await assert.rejects(() => resumePipeline(root, project.id, ctx), /只有 paused\/stuck/)
})

// ── 5. 自动采纳 ────────────────────────────────────────────

test('自动采纳：runId 匹配且 running 的 chapter 提案立即 accepted + 写入正文', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 1 })
  const { ctx } = makeCtx()
  const started = await startPipelineRun(root, project.id, { mode: 'chapters', count: 1 }, ctx)
  const runId = started.pipeline.runId

  const auto = await store.createProposal(root, project.id, {
    kind: 'chapter',
    chapter: 2,
    title: '第 2 章',
    data: { title: '第 2 章', content: '自动采纳的正文。', pipelineRunId: runId, reviewIds: ['review-1'] },
  })
  assert.equal(auto.status, 'accepted', 'runId 匹配的章节修订应自动采纳')
  assert.equal(auto.autoAccepted, true)
  const chapters = await store.listChapters(root, project.id)
  const savedChapter = chapters.find((chapter) => Number(chapter.id) === 2)
  assert.equal(savedChapter.content, '自动采纳的正文。', '自动采纳应写入正文')

  // runId 不匹配 → 留 pending
  const mismatch = await store.createProposal(root, project.id, {
    kind: 'chapter',
    chapter: 3,
    title: '第 3 章',
    data: { content: '不匹配。', pipelineRunId: 'run-other' },
  })
  assert.equal(mismatch.status, 'pending')

  // 非 chapter（attention）→ 不自动采纳
  const attentionProposal = await store.createProposal(root, project.id, {
    kind: 'attention',
    title: '注意力实测',
    data: { pipelineRunId: runId },
    items: [{ chapter: 1, score: 80, verdict: '会' }],
  })
  assert.equal(attentionProposal.status, 'pending')

  // paused 状态下不自动采纳
  await pausePipeline(root, project.id)
  const pausedCase = await store.createProposal(root, project.id, {
    kind: 'chapter',
    chapter: 3,
    title: '第 3 章',
    data: { content: '暂停后不自动采纳。', pipelineRunId: runId },
  })
  assert.equal(pausedCase.status, 'pending')
})

// ── 6. MCP 工具 ────────────────────────────────────────────

test('MCP novel_desk_pipeline：status/stage/finish/stuck', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 1 })
  const { ctx } = makeCtx()
  const started = await startPipelineRun(root, project.id, { mode: 'chapters', count: 2 }, ctx)
  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {}, get: () => undefined })
  const tool = tools.find((row) => row.name === 'novel_desk_pipeline')
  assert.ok(tool, 'apply 应注册 novel_desk_pipeline 工具')

  const statusText = await tool.execute({ project: project.id, op: 'status' })
  assert.match(statusText, /生成整本书流水线/)
  assert.match(statusText, /状态：running/)
  assert.ok(statusText.includes(started.pipeline.runId))

  const stageText = await tool.execute({ project: project.id, op: 'stage', stageId: 'write-1', status: 'done', note: '写完第一卷' })
  assert.match(stageText, /进度：/)
  const advanced = await store.getPipeline(root, project.id)
  assert.equal(advanced.stages.find((stage) => stage.id === 'write-1').status, 'done')
  assert.equal(advanced.currentStage, 'review-1')

  const finishText = await tool.execute({ project: project.id, op: 'finish', note: '全书完成' })
  assert.match(finishText, /状态：done/)
  assert.equal((await store.getPipeline(root, project.id)).status, 'done')

  const stuckText = await tool.execute({ project: project.id, op: 'stuck', reason: '会话掉线' })
  assert.match(stuckText, /状态：stuck/)
  assert.ok(stuckText.includes('会话掉线'))
  await assert.rejects(() => tool.execute({ project: project.id, op: 'nope' }), /未知操作/)
})

// ── 7. 估算 / 预算 / reset ─────────────────────────────────

test('estimatePipeline：随章数增长，含 token 与费用数量级', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 1 })
  const bundle = await store.getBundle(root, project.id)
  const small = estimatePipeline(bundle, { mode: 'chapters', count: 2, base: { wordsPerChapter: 3000 } })
  const big = estimatePipeline(bundle, { mode: 'chapters', count: 10, base: { wordsPerChapter: 3000 } })
  assert.ok(big.totalTokens > small.totalTokens, '章数越多估算 token 越大')
  assert.ok(small.totalTokens > 0 && small.costCNY > 0)
  assert.match(small.note, /估算不准/)
})

test('预算：超过 80% 返回 warning，超过 100% 自动 paused', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 1 })
  const { ctx } = makeCtx()
  const started = await startPipelineRun(root, project.id, { mode: 'chapters', count: 2, budget: { maxTokens: 1000 } }, ctx)
  assert.equal(started.pipeline.budget.maxTokens, 1000)

  await store.appendUsageRecord(root, project.id, { at: new Date().toISOString(), provider: 'deepseek-official', model: 'deepseek-flash', totalTokens: 800, inputTokens: 800 })
  let result = await advancePipeline(root, project.id, { stageId: 'write-1', status: 'done' })
  assert.equal(result.warning, true, '80% 应返回 warning')
  assert.equal(result.pipeline.status, 'running')
  assert.ok(result.pipeline.budget.usedTokens >= 800)

  await store.appendUsageRecord(root, project.id, { at: new Date().toISOString(), provider: 'deepseek-official', model: 'deepseek-flash', totalTokens: 400, inputTokens: 400 })
  result = await advancePipeline(root, project.id, { stageId: 'review-1', status: 'done' })
  assert.equal(result.pipeline.status, 'paused', '超过 100% 应自动暂停')
  assert.ok(result.pipeline.notes.some((note) => note.text.includes('预算超限')))
})

test('resetPipeline：回到 idle、删除 pipeline.json，正文/账本保留', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 1 })
  const { ctx } = makeCtx()
  await startPipelineRun(root, project.id, { mode: 'chapters', count: 1 }, ctx)
  await assert.doesNotReject(() => readFile(pipelineFile(root, project.id), 'utf8'))

  const reset = await store.resetPipeline(root, project.id)
  assert.equal(reset.status, 'idle')
  await assert.rejects(() => readFile(pipelineFile(root, project.id), 'utf8'), 'reset 应删除 pipeline.json')
  assert.equal((await store.listChapters(root, project.id)).length, 1, 'reset 不应删除正文')
})

test('pipelineSummaryText：摘要含状态/阶段/runId', async (t) => {
  const { root, project } = await makeProject(t, { chapters: 1 })
  const { ctx } = makeCtx()
  const started = await startPipelineRun(root, project.id, { mode: 'chapters', count: 1 }, ctx)
  const text = pipelineSummaryText(started.pipeline)
  assert.match(text, /状态：running/)
  assert.ok(text.includes(started.pipeline.runId))
  assert.ok(text.includes('write-1'))
})

test('index.js：pipeline.* RPC 分支存在', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  for (const op of ['pipeline.get', 'pipeline.prepare', 'pipeline.markPrepared', 'pipeline.startRun', 'pipeline.advance', 'pipeline.pause', 'pipeline.resume', 'pipeline.reset', 'pipeline.usage']) {
    assert.ok(source.includes(`'${op}'`), `index.js 缺少 RPC 分支：${op}`)
  }
})
