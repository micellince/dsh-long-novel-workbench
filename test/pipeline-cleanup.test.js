/**
 * 整本书收尾（task-19）：final-cleanup 阶段、收尾 prompt、finalize 清理、
 * finish/advance 自动收尾、final-cleanup 阶段自动采纳账本提案。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import {
  apply,
  finalizePipelineCleanup,
  finishPipeline,
  advancePipeline,
  buildPipelineGoalPrompt,
  buildPipelineCleanupPrompt,
  backfillPipeline,
  pipelineSummaryText,
} from '../index.js'
import { defaultPipeline } from '../lib/defaults.js'
import { makeRoot } from './helpers.js'

function useTempRoot(t, root) {
  const previous = process.env.STORY_DESK_ROOT
  process.env.STORY_DESK_ROOT = root
  t.after(() => {
    if (previous === undefined) delete process.env.STORY_DESK_ROOT
    else process.env.STORY_DESK_ROOT = previous
  })
}

async function makeProject(t, { name = '收尾作品', chapters = 2 } = {}) {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name, genre: '武侠' })
  for (let index = 1; index <= chapters; index += 1) {
    await store.saveChapter(root, project.id, { id: String(index).padStart(4, '0'), title: `第${index}章`, content: `第 ${index} 章成品正文。` })
  }
  return { root, project }
}

function makeCtx() {
  const prompts = []
  const created = []
  const controller = {
    prompts,
    created,
    async list() { return { items: [] } },
    async create({ workspaceId }) {
      const sessionId = `sess-backfill-${created.length + 1}`
      created.push({ workspaceId, sessionId })
      return { sessionId }
    },
    async prompt(payload) { prompts.push(payload) },
  }
  const ctx = { get: (name) => (name === 'sessionController' ? controller : undefined), inject: () => {}, tools: { register: () => {} } }
  return { ctx, prompts, created }
}

async function makePendingProposals(root, projectId) {
  const attention = await store.createProposal(root, projectId, {
    kind: 'attention',
    title: '注意力实测',
    data: { pipelineRunId: 'run-clean' },
    items: [{ chapter: 1, score: 80, verdict: '会', weakest: 'cliff', dropRisk: '第 3 段', detail: '四拍体检' }],
  })
  const facts = await store.createProposal(root, projectId, {
    kind: 'facts',
    title: '事实补齐',
    items: [{ subject: '甲', attribute: '年龄', value: '二十', chapter: 1 }],
  })
  const characters = await store.createProposal(root, projectId, {
    kind: 'characters',
    title: '人物补齐',
    items: [{ name: '甲', role: 'protagonist', goal: '复仇' }],
  })
  const expiredChapter = await store.createProposal(root, projectId, {
    kind: 'chapter',
    chapter: 1,
    title: '过期章节稿',
    data: { title: '第1章（旧）', content: '过期稿件，不应覆盖成品。', pipelineRunId: 'run-clean' },
  })
  return { attention, facts, characters, expiredChapter }
}

async function makeOpenReviews(root, projectId) {
  const open = await store.upsertEntity(root, projectId, 'reviews', { chapter: 1, dimension: '节奏', severity: 'major', issue: '中段拖沓', suggestion: '压缩', status: 'open' })
  const fixed = await store.upsertEntity(root, projectId, 'reviews', { chapter: 2, dimension: '文笔', severity: 'minor', issue: '已修', suggestion: '保留', status: 'fixed' })
  return { open, fixed }
}

test('backfill：已完成 run 可补跑收尾（新会话 + final-cleanup 阶段 + 账本提案自动采纳）', async (t) => {
  const { root, project } = await makeProject(t)
  await store.updateProject(root, project.id, { workspaceId: 'ws-test', workspacePath: join(root, 'ws') })
  await store.savePipeline(root, project.id, {
    status: 'done',
    runId: 'run-old',
    mode: 'book',
    targetChapter: 2,
    stages: [
      { id: 'write-1', kind: 'volume-write', name: '第一卷写作', status: 'done', chapterFrom: 1, chapterTo: 2 },
      { id: 'final-review', kind: 'final-review', name: '全书总审', status: 'done' },
      { id: 'final-fix', kind: 'final-fix', name: '全书总修', status: 'done' },
    ],
  })
  const { ctx, created } = makeCtx()
  const result = await backfillPipeline(root, project.id, ctx)
  assert.equal(result.pipeline.status, 'running')
  assert.equal(result.pipeline.currentStage, 'final-cleanup')
  assert.ok(result.pipeline.stages.some((stage) => stage.id === 'final-cleanup' && stage.status === 'running'))
  assert.equal(created.length, 1, '补跑收尾应新开会话')
  assert.match(result.prompt, /补齐账本/)
  assert.match(result.prompt, /novel_desk_pipeline\(op="finish"/)
  const prompt = buildPipelineCleanupPrompt(await store.getBundle(root, project.id), result.pipeline)
  assert.ok(prompt.includes('注意力实测'))

  const proposal = await store.createProposal(root, project.id, {
    kind: 'facts',
    title: '补齐事实',
    data: { pipelineRunId: result.pipeline.runId },
    items: [{ subject: '主角', attribute: '身份', value: '捕快', chapter: 1 }],
  })
  assert.equal(proposal.status, 'accepted', 'final-cleanup 阶段账本提案应自动采纳')
})

// ── 1. 阶段 & prompt ────────────────────────────────────────

test('buildPipelineStages：final-fix 之后追加 final-cleanup 收尾阶段', () => {
  const stages = store.buildPipelineStages({ chaptersPerVolume: 5 }, 'book', 0, 10, 1)
  const ids = stages.map((stage) => stage.id)
  assert.equal(ids.at(-1), 'final-cleanup', '最后一个阶段应是 final-cleanup')
  assert.equal(ids.at(-2), 'final-fix')
  const cleanup = stages.at(-1)
  assert.equal(cleanup.kind, 'cleanup')
  assert.ok(cleanup.name.includes('补齐账本'))
})

test('goal prompt：阶段清单含 final-cleanup，收尾段含补齐清单与 finish 说明', () => {
  const pipeline = { ...defaultPipeline(), runId: 'run-clean', mode: 'book', targetChapter: 10, stages: store.buildPipelineStages({ chaptersPerVolume: 5 }, 'book', 0, 10, 1) }
  const prompt = buildPipelineGoalPrompt({ project: { id: 'p1', name: '书' }, chapters: [{ id: '0001', title: '第一章', content: '正文' }], stats: { words: 2 } }, pipeline)
  assert.ok(prompt.includes('final-cleanup'), '阶段清单应含 final-cleanup')
  assert.ok(prompt.includes('收尾阶段 final-cleanup'), '应有收尾段')
  for (const part of ['人物', '事实', '事件', '时间线', '高光', '伏笔', '冲突', '地点', '大纲', '注意力实测', '世界']) {
    assert.ok(prompt.includes(part), `收尾清单应包含「${part}」`)
  }
  assert.ok(prompt.includes('data.pipelineRunId="run-clean"'), '补齐账本提案要带 runId')
  assert.ok(prompt.includes('op="finish"'), '补完后应调用 finish 触发收尾')
  assert.ok(prompt.includes('novel_desk_propose'), '全部用提案，不直接 upsert')
})

// ── 2. finalize 清理 ──────────────────────────────────────

test('finalize(all)：采纳非章节提案、驳回过期章节、归档审阅、写 cleanup 报告与 notes', async (t) => {
  const { root, project } = await makeProject(t)
  const created = await makePendingProposals(root, project.id)
  const reviews = await makeOpenReviews(root, project.id)
  await store.savePipeline(root, project.id, { status: 'running', runId: 'run-clean', currentStage: 'final-cleanup' })

  const report = await finalizePipelineCleanup(root, project.id, { scope: 'all' })
  assert.equal(report.scope, 'all')
  assert.equal(report.acceptedProposals, 3, 'attention/facts/characters 应被采纳')
  assert.equal(report.rejectedChapter, 1, '过期章节提案应被驳回')
  assert.equal(report.closedReviews, 1, '只归档未处理审阅（fixed 不动）')
  assert.deepEqual(report.failed, [])

  const bundle = await store.getBundle(root, project.id)
  const proposals = new Map(bundle.proposals.map((row) => [row.id, row]))
  assert.equal(proposals.get(created.attention.id).status, 'accepted')
  assert.equal(proposals.get(created.facts.id).status, 'accepted')
  assert.equal(proposals.get(created.characters.id).status, 'accepted')
  assert.equal(proposals.get(created.expiredChapter.id).status, 'rejected')
  assert.equal(bundle.attention.length, 1, '注意力实测应落账本')
  assert.equal(bundle.facts.length, 1)
  assert.equal(bundle.characters.length, 1)
  assert.equal(bundle.chapters.find((chapter) => Number(chapter.id) === 1).content, '第 1 章成品正文。', '过期章节提案不得覆盖成品正文')
  assert.equal(bundle.reviews.find((review) => review.id === reviews.open.id).status, 'wontfix')
  assert.equal(bundle.reviews.find((review) => review.id === reviews.fixed.id).status, 'fixed')

  const pipeline = await store.getPipeline(root, project.id)
  assert.equal(pipeline.status, 'done', 'running 的流水线收尾后应置 done')
  assert.equal(pipeline.cleanup.acceptedProposals, 3)
  assert.equal(pipeline.cleanup.rejectedChapter, 1)
  assert.equal(pipeline.cleanup.closedReviews, 1)
  assert.ok(pipeline.notes.some((note) => /收尾：采纳 3 条提案、驳回 1 条过期章节提案、归档 1 条审阅/.test(note.text)))
  assert.match(pipelineSummaryText(pipeline), /收尾报告：采纳 3 条提案/)
})

test('finalize(scope=run)：只处理本 run 的 pending 提案，其他项目提案保留', async (t) => {
  const { root, project } = await makeProject(t)
  const inRun = await store.createProposal(root, project.id, {
    kind: 'facts', title: '本 run 事实', data: { pipelineRunId: 'run-clean' }, items: [{ subject: '乙', attribute: '身份', value: '剑客', chapter: 1 }],
  })
  const otherRun = await store.createProposal(root, project.id, {
    kind: 'facts', title: '其他 run 事实', data: { pipelineRunId: 'run-other' }, items: [{ subject: '丙', attribute: '身份', value: '书生', chapter: 1 }],
  })
  const noRun = await store.createProposal(root, project.id, { kind: 'facts', title: '无 run 事实', items: [{ subject: '丁', attribute: '身份', value: '商人', chapter: 1 }] })
  await store.savePipeline(root, project.id, { status: 'running', runId: 'run-clean', currentStage: 'final-cleanup' })

  const report = await finalizePipelineCleanup(root, project.id, { scope: 'run' })
  assert.equal(report.scope, 'run')
  assert.equal(report.acceptedProposals, 1)
  const proposals = new Map((await store.getBundle(root, project.id)).proposals.map((row) => [row.id, row]))
  assert.equal(proposals.get(inRun.id).status, 'accepted')
  assert.equal(proposals.get(otherRun.id).status, 'pending', '其他 run 的提案不应被处理')
  assert.equal(proposals.get(noRun.id).status, 'pending', '没有 runId 的提案不应被 run 范围处理')
})

// ── 3. finish / advance 自动收尾 ──────────────────────────

test('finishPipeline：先自动清理（采纳账本/驳回章节/归档审阅）再置 done', async (t) => {
  const { root, project } = await makeProject(t)
  const created = await makePendingProposals(root, project.id)
  const reviews = await makeOpenReviews(root, project.id)
  await store.savePipeline(root, project.id, { status: 'running', runId: 'run-clean', currentStage: 'final-review' })

  const finished = await finishPipeline(root, project.id, '全书完成')
  assert.equal(finished.status, 'done')
  assert.ok(finished.cleanup, 'finish 应写入 cleanup 报告')
  assert.equal(finished.cleanup.acceptedProposals, 3)
  assert.equal(finished.cleanup.rejectedChapter, 1)
  assert.equal(finished.cleanup.closedReviews, 1)
  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.facts.length, 1)
  assert.equal(bundle.reviews.find((review) => review.id === reviews.open.id).status, 'wontfix')
  assert.equal(bundle.proposals.find((row) => row.id === created.expiredChapter.id).status, 'rejected')
})

test('advancePipeline：最后一个阶段完成时自动收尾（cleanup 返回值 + done）', async (t) => {
  const { root, project } = await makeProject(t)
  await store.createProposal(root, project.id, {
    kind: 'facts', title: '收尾事实', data: { pipelineRunId: 'run-clean' }, items: [{ subject: '戊', attribute: '年龄', value: '三十', chapter: 2 }],
  })
  await makeOpenReviews(root, project.id)
  await store.savePipeline(root, project.id, {
    status: 'running',
    runId: 'run-clean',
    currentStage: 'final-cleanup',
    stages: [
      { id: 'final-fix', kind: 'final-fix', name: '全书总修', status: 'done', chapterFrom: 1, chapterTo: 2 },
      { id: 'final-cleanup', kind: 'cleanup', name: '收尾：补齐账本 + 清理残留', status: 'pending', chapterFrom: 1, chapterTo: 2 },
    ],
  })

  const result = await advancePipeline(root, project.id, { stageId: 'final-cleanup', status: 'done', note: '账本补齐' })
  assert.equal(result.pipeline.status, 'done')
  assert.ok(result.cleanup, '完成最后阶段应返回 cleanup 报告')
  assert.equal(result.cleanup.acceptedProposals, 1)
  assert.equal(result.cleanup.closedReviews, 1)
  assert.equal((await store.getPipeline(root, project.id)).cleanup.acceptedProposals, 1)
})

// ── 4. final-cleanup 阶段自动采纳账本提案 ─────────────────

test('自动采纳扩展：final-cleanup 阶段账本提案立即 accepted；其他阶段只自动采纳 chapter', async (t) => {
  const { root, project } = await makeProject(t)
  await store.savePipeline(root, project.id, { status: 'running', runId: 'run-clean', currentStage: 'final-cleanup' })

  const facts = await store.createProposal(root, project.id, {
    kind: 'facts', title: '补齐事实', data: { pipelineRunId: 'run-clean' }, items: [{ subject: '己', attribute: '身份', value: '掌门', chapter: 1 }],
  })
  assert.equal(facts.status, 'accepted', 'final-cleanup 阶段的 facts 提案应自动采纳')
  assert.equal(facts.autoAccepted, true)
  const attention = await store.createProposal(root, project.id, {
    kind: 'attention', title: '补齐注意力', data: { pipelineRunId: 'run-clean' },
    items: [{ chapter: 2, score: 76, verdict: '会', weakest: 'hook' }],
  })
  assert.equal(attention.status, 'accepted', 'final-cleanup 阶段的 attention 提案应自动采纳')
  const characters = await store.createProposal(root, project.id, {
    kind: 'characters', title: '补齐人物', data: { pipelineRunId: 'run-clean' }, items: [{ name: '庚' }],
  })
  assert.equal(characters.status, 'accepted')
  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.facts.length, 1)
  assert.equal(bundle.attention.length, 1)
  assert.equal(bundle.characters.length, 1)

  // 非 cleanup 阶段：账本提案不自动采纳（留 pending），chapter 仍自动采纳
  await store.savePipeline(root, project.id, { currentStage: 'write-2' })
  const pendingFacts = await store.createProposal(root, project.id, {
    kind: 'facts', title: '普通阶段事实', data: { pipelineRunId: 'run-clean' }, items: [{ subject: '辛', attribute: '年龄', value: '四十', chapter: 1 }],
  })
  assert.equal(pendingFacts.status, 'pending', '非 cleanup 阶段不应自动采纳账本提案')
  const chapter = await store.createProposal(root, project.id, {
    kind: 'chapter', chapter: 2, title: '章节修订',
    data: { title: '第 2 章（修订）', content: '修订后的成品正文。', pipelineRunId: 'run-clean' },
  })
  assert.equal(chapter.status, 'accepted', 'chapter 提案在各阶段都保持自动采纳')

  // 非本 run 的账本提案在 cleanup 阶段也不自动采纳
  await store.savePipeline(root, project.id, { currentStage: 'final-cleanup' })
  const otherRun = await store.createProposal(root, project.id, {
    kind: 'facts', title: '其他 run', data: { pipelineRunId: 'run-other' }, items: [{ subject: '壬', attribute: '身份', value: '客' }],
  })
  assert.equal(otherRun.status, 'pending')
})

// ── 5. MCP / RPC ─────────────────────────────────────────

test('MCP novel_desk_pipeline：新增 finalize op 与收尾报告；status 显示 cleanup', async (t) => {
  const { root, project } = await makeProject(t)
  await makePendingProposals(root, project.id)
  await makeOpenReviews(root, project.id)
  await store.savePipeline(root, project.id, { status: 'running', runId: 'run-clean', currentStage: 'final-cleanup' })
  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {}, get: () => undefined })
  const tool = tools.find((row) => row.name === 'novel_desk_pipeline')
  assert.ok(tool)
  assert.ok(tool.parameters.properties.op.enum.includes('finalize'), 'op 枚举应含 finalize')

  const text = await tool.execute({ project: project.id, op: 'finalize', scope: 'all' })
  assert.match(text, /## 收尾报告/)
  assert.match(text, /采纳提案：3 条/)
  assert.match(text, /驳回过期章节提案：1 条/)
  assert.match(text, /归档审阅：1 条/)

  const statusText = await tool.execute({ project: project.id, op: 'status' })
  assert.match(statusText, /收尾报告：采纳 3 条提案/)

  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(source.includes("'pipeline.finalize'"), 'index.js 应有 pipeline.finalize RPC 分支')
})
