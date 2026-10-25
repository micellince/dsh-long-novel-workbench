/**
 * 全文改动执行链路：状态单例 → 契约校验 → 影响面 → 出方案 → 开始 → 单章 apply（双闸门 + 备份）。
 * 分层纯函数已在 revision.test.js 覆盖，这里只测「接线」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import {
  previewRevision,
  planRevisionRun,
  startRevisionRun,
  applyRevisionChapter,
  advanceRevision,
  rebatchRevision,
  revisionSummaryText,
  buildRevisionGoalPrompt,
} from '../index.js'
import { auditAiStyle, auditSummaryText } from '../lib/aistyle.js'
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
    async list() { return { items: [] } },
    async create({ workspaceId }) {
      const sessionId = `sess-${created.length + 1}`
      created.push({ workspaceId, sessionId })
      return { sessionId }
    },
    async prompt(payload) { prompts.push(payload); return { accepted: true } },
  }
  return {
    ctx: { get: (name) => (name === 'sessionController' ? controller : undefined), inject: () => {}, tools: { register: () => {} } },
    prompts,
    created,
  }
}

const COLD = `他看了看桌上，停了一停。退后三步，站住。
“我走了。”
“是。”
华羽生把剑背上，出了门。`

const WARM = `他看了看桌上，停了一停。退后三步，站住。
“贤弟此去，万望保重。”
“兄长放心，此去必回。”
华羽生把剑背上，出了门。`

async function makeProject(t, { chapters = 2 } = {}) {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name: '改动作品', genre: '武侠' })
  await store.updateProject(root, project.id, { workspaceId: 'ws-test', workspacePath: join(root, 'ws') })
  await store.applyPreset(root, project.id, 'preset-standard')
  for (let index = 1; index <= chapters; index += 1) {
    await store.saveChapter(root, project.id, {
      id: String(index).padStart(4, '0'),
      title: `第${index}章`,
      content: index === 1 ? COLD : '第二章正文。华羽生离开。',
      characters: ['华羽生'],
    })
  }
  await store.upsertEntity(root, project.id, 'characters', { name: '华羽生', role: 'protagonist', goal: '查身世', relationships: ['柳含烟(知己)'] })
  return { root, project }
}

test('revision.get：未开始时是 idle 默认值，不落盘', async (t) => {
  const { root, project } = await makeProject(t)
  const revision = await store.getRevision(root, project.id)
  assert.equal(revision.status, 'idle')
  assert.equal(revision.id, 'revision')
  assert.deepEqual(revision.batches, [])
  const audit = auditAiStyle((await store.getBundle(root, project.id)).chapters)
  assert.ok(auditSummaryText(audit).includes('去 AI 化审计'))
})

test('preview：L3 缺价值变更书时报错且不落盘', async (t) => {
  const { root, project } = await makeProject(t)
  const bundle = await store.getBundle(root, project.id)
  const result = previewRevision(bundle, { tier: 'L3', chapters: ['0001'], goal: '改价值观' })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => /旧立场/.test(e)))
  assert.equal((await store.getRevision(root, project.id)).status, 'idle')
})

test('preview：L1 契约生成批次，影响面用现有人物与章节数据', async (t) => {
  const { root, project } = await makeProject(t)
  const bundle = await store.getBundle(root, project.id)
  const result = previewRevision(bundle, { tier: 'L1', chapters: ['0001', '0002'], goal: '改文风', batchSize: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.tier.id, 'L1')
  assert.equal(result.batches.length, 2)
  assert.equal(result.batches[0].parallel, true)
  const l3 = previewRevision(bundle, { tier: 'L3', chapters: ['0001'], goal: '改价值观', charter: { oldValue: '复仇', newValue: '放下', affectedCharacters: ['华羽生'] } })
  assert.equal(l3.ok, true)
  assert.ok(l3.impact.chapters.some((row) => String(row.chapter) === '0001'), '出场章应被识别')
})

test('plan：契约成立则落盘 plan-ready，批次全部 pending', async (t) => {
  const { root, project } = await makeProject(t)
  const result = await planRevisionRun(root, project.id, { tier: 'L1', chapters: ['0001', '0002'], goal: '改文风', batchSize: 5 })
  assert.equal(result.revision.status, 'plan-ready')
  assert.equal(result.revision.tier, 'L1')
  assert.ok(result.revision.runId.startsWith('rev-'))
  assert.ok(result.revision.batches.every((batch) => batch.status === 'pending'))
  const saved = await store.getRevision(root, project.id)
  assert.equal(saved.status, 'plan-ready')
  assert.ok(saved.notes.length >= 1)
})

test('plan：一次全改 + 一路跑到底落盘并写进工作单', async (t) => {
  const { root, project } = await makeProject(t)
  const result = await planRevisionRun(root, project.id, {
    tiers: ['L1', 'L2'],
    chapters: ['0001', '0002'],
    goal: '改文风并补场景细节',
    batchSize: 'all',
    stopMode: 'run-to-end',
  })
  assert.equal(result.batchCount, 1, '一次全改只规划 1 批')
  assert.equal(result.revision.contract.batchSize, 'all')
  assert.equal(result.revision.contract.stopMode, 'run-to-end')
  assert.ok(result.prompt.includes('一路跑到底'), '工作单应写明停顿方式')
  assert.ok(result.prompt.includes('不要中途停下'), '一路跑到底应明确要求不停下')
  const saved = await store.getRevision(root, project.id)
  assert.equal(saved.batches.length, 1)
})

test('plan：没有当前预设时必须拒绝（改动同样依赖文风规格）', async (t) => {
  const { root, project } = await makeProject(t)
  await store.updateProject(root, project.id, { activePresetId: '' })
  await assert.rejects(
    () => planRevisionRun(root, project.id, { tier: 'L1', chapters: ['0001'], goal: '改文风' }),
    /预设/,
  )
})

test('start：没出方案不能开始；出方案后建会话并投递工作单', async (t) => {
  const { root, project } = await makeProject(t)
  const { ctx, prompts } = makeCtx()
  await assert.rejects(() => startRevisionRun(root, project.id, ctx), /请先出方案/)

  await planRevisionRun(root, project.id, { tier: 'L1', chapters: ['0001'], goal: '改成文白相间', batchSize: 5 })
  const started = await startRevisionRun(root, project.id, ctx)
  assert.equal(started.revision.status, 'running')
  assert.ok(started.sessionId)
  assert.equal(prompts.length, 1)
  assert.match(started.prompt, /全文改动执行者/)
  assert.match(started.prompt, /保真闸门/)
})

test('prompt：L3 工作单必须写清价值基准与执行顺序', async (t) => {
  const { root, project } = await makeProject(t)
  await planRevisionRun(root, project.id, {
    tier: 'L3', chapters: ['0001'], goal: '把复仇改成放下',
    charter: { oldValue: '为父报仇', newValue: '放下仇恨', affectedCharacters: ['华羽生'] },
  })
  const bundle = await store.getBundle(root, project.id)
  const prompt = buildRevisionGoalPrompt(bundle, await store.getRevision(root, project.id))
  assert.match(prompt, /价值变更书/)
  assert.match(prompt, /为父报仇/)
  assert.match(prompt, /先做批次 0/)
})

test('plan：L3 也能选整本一批 + 一路跑到底，设定层批仍在最前', async (t) => {
  const { root, project } = await makeProject(t)
  const result = await planRevisionRun(root, project.id, {
    tier: 'L3', chapters: ['0001', '0002'], goal: '把复仇改成放下',
    batchSize: 'all', stopMode: 'run-to-end',
    charter: { oldValue: '为父报仇', newValue: '放下仇恨', affectedCharacters: ['华羽生'] },
  })
  assert.equal(result.batchCount, 2, 'L3 整本一批 = 设定层 1 批 + 正文 1 批')
  assert.equal(result.revision.batches[0].kind, 'settings')
  assert.deepEqual(result.revision.batches[1].chapters, ['0001', '0002'])
  assert.ok(result.revision.batches.every((batch) => batch.requiresAuthorConfirm === false), '一路跑到底不停批')
  assert.ok(result.prompt.includes('一路跑到底'), '工作单应写明停顿方式')
})

test('start：开始时选「一次全改 + 一路跑到底」会重排批次，并按章保留已完成进度', async (t) => {
  const { root, project } = await makeProject(t)
  const { ctx, prompts } = makeCtx()
  await planRevisionRun(root, project.id, { tier: 'L1', chapters: ['0001', '0002'], goal: '改文风', batchSize: 1, stopMode: 'per-batch' })
  await advanceRevision(root, project.id, { batchIndex: 0, status: 'done' })
  let saved = await store.getRevision(root, project.id)
  assert.equal(saved.batches.length, 2, '方案里是逐章 2 批')

  const started = await startRevisionRun(root, project.id, ctx, { batchSize: 'all', stopMode: 'run-to-end' })
  saved = await store.getRevision(root, project.id)
  assert.equal(saved.status, 'running')
  assert.equal(started.rebatched, true)
  assert.equal(saved.contract.batchSize, 'all')
  assert.equal(saved.contract.stopMode, 'run-to-end')
  assert.equal(saved.batches.length, 1, '开始前重排为整本一批')
  assert.equal(saved.batches[0].status, 'pending', '只有 1 章完成，整本一批不算完成')
  assert.match(started.prompt, /一路跑到底/)
  assert.ok((saved.notes ?? []).some((note) => /重排/.test(note.text)), '应记录开始时的重排')
  assert.equal(prompts.length, 1)
})

test('rebatchRevision：重新切批时全 done 的章沿用 done；没给设置就不重排', async (t) => {
  const { root, project } = await makeProject(t)
  await planRevisionRun(root, project.id, { tier: 'L1', chapters: ['0001', '0002'], goal: '改文风', batchSize: 1 })
  await advanceRevision(root, project.id, { batchIndex: 0, status: 'done' })
  await advanceRevision(root, project.id, { batchIndex: 1, status: 'done' })
  const revision = await store.getRevision(root, project.id)
  const bundle = await store.getBundle(root, project.id)

  const result = rebatchRevision(bundle, revision, { batchSize: 'all' })
  assert.equal(result.changed, true)
  assert.equal(result.batches.length, 1)
  assert.equal(result.batches[0].status, 'done', '两章都完成 → 整本一批也应是 done')

  const same = rebatchRevision(bundle, revision, {})
  assert.equal(same.changed, false, '没传设置时沿用方案，不重排')
})

test('applyChapter：写正文、留备份、跑双闸门并回写批次', async (t) => {
  const { root, project } = await makeProject(t)
  await planRevisionRun(root, project.id, { tier: 'L1', chapters: ['0001', '0002'], goal: '改文风', batchSize: 1 })
  const result = await applyRevisionChapter(root, project.id, { chapter: '0001', content: WARM })

  const saved = await store.getBundle(root, project.id)
  const chapter = saved.chapters.find((c) => String(c.id) === '0001')
  assert.match(chapter.content, /贤弟此去/)
  assert.ok(result.backup, '改写必须留原稿备份')
  assert.equal(result.fidelity.total > 0, true)
  assert.ok(['done', 'needs-fix'].includes(result.revision.batches[0].status))
  assert.equal(result.revision.batches[1].status, 'pending', '未改的批次不应被推进')

  const history = await store.listChapterHistory(root, project.id, '0001')
  assert.ok(history.length >= 1, '章节历史里应有原稿')
})

test('applyChapter：缺章或缺正文时报错', async (t) => {
  const { root, project } = await makeProject(t)
  await assert.rejects(() => applyRevisionChapter(root, project.id, { chapter: '9999', content: 'x' }), /章节不存在/)
  await assert.rejects(() => applyRevisionChapter(root, project.id, { chapter: '0001', content: '  ' }), /缺少 content/)
})

test('advance + summary：批次全 done 时整体 done', async (t) => {
  const { root, project } = await makeProject(t)
  await planRevisionRun(root, project.id, { tier: 'L1', chapters: ['0001', '0002'], goal: '改文风', batchSize: 1 })
  await advanceRevision(root, project.id, { batchIndex: 0, status: 'done' })
  const final = await advanceRevision(root, project.id, { batchIndex: 1, status: 'done' })
  assert.equal(final.status, 'done')
  const text = revisionSummaryText(final)
  assert.match(text, /全文改动/)
  assert.match(text, /进度：2\/2 批/)
})

test('RPC 与 MCP：revision 的 op 分支与工具都已接线', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  for (const op of ['revision.get', 'revision.preview', 'revision.plan', 'revision.start', 'revision.advance', 'revision.applyChapter', 'revision.pause', 'revision.resume', 'revision.reset']) {
    assert.ok(source.includes(`case '${op}'`), `缺少 RPC 分支：${op}`)
  }
  assert.ok(source.includes("name: 'novel_desk_revision'"), '应注册 novel_desk_revision 工具')
  assert.ok(source.includes('createRevisionTool(ctx)'), '应在 apply 里注册改动工具')
})

test('applyChapter：改写稿仍有 Markdown 残留时批次标 needs-fix', async (t) => {
  const { root, project } = await makeProject(t)
  await planRevisionRun(root, project.id, { tier: 'L1', chapters: ['0001'], goal: '改文风' })
  const dirty = '## 第一节 出门\n**华羽生**把剑背上。\n---\n他出了门。'
  const result = await applyRevisionChapter(root, project.id, { chapter: '0001', content: dirty })
  assert.ok(result.md.total >= 3, '应扫出至少 3 处 Markdown 残留')
  assert.equal(result.revision.batches[0].status, 'needs-fix')
  assert.equal(result.revision.batches[0].md.total, result.md.total)
  assert.match(result.revision.notes.at(-1).text, /Markdown 残留/)
})

test('applyChapter：干净稿通过双闸门，批次 done', async (t) => {
  const { root, project } = await makeProject(t)
  await planRevisionRun(root, project.id, { tier: 'L1', chapters: ['0001'], goal: '改文风' })
  const result = await applyRevisionChapter(root, project.id, { chapter: '0001', content: WARM })
  assert.equal(result.md.total, 0)
  assert.equal(result.fidelity.pass, true)
  assert.equal(result.revision.batches[0].status, 'done')
})

test('plan：多选 L1+L2 落盘为组合层级，批次按组合规则', async (t) => {
  const { root, project } = await makeProject(t)
  const result = await planRevisionRun(root, project.id, { tiers: ['L1', 'L2'], chapters: ['0001', '0002'], goal: '改文风并补场景细节', batchSize: 1 })
  assert.equal(result.revision.tier, 'L1+L2')
  assert.deepEqual(result.revision.contract.tiers, ['L1', 'L2'])
  assert.equal(result.revision.batches.length, 2)
  assert.equal(result.revision.batches[0].parallel, false)
})

test('plan：目标来源选预设时，未手写目标也能出方案并写进 goal', async (t) => {
  const { root, project } = await makeProject(t)
  const result = await planRevisionRun(root, project.id, {
    tiers: ['L1'],
    chapters: ['0001'],
    goalMode: 'preset',
    presetId: 'preset-standard',
  })
  assert.equal(result.revision.status, 'plan-ready')
  assert.match(result.revision.contract.goal, /按预设/)
  const prompt = buildRevisionGoalPrompt(await store.getBundle(root, project.id), await store.getRevision(root, project.id))
  assert.match(prompt, /文风规格来源：预设/)
  assert.match(prompt, /风格规则/)
})

test('plan：预设 + 手写目标（两者）都在工作单里', async (t) => {
  const { root, project } = await makeProject(t)
  await planRevisionRun(root, project.id, {
    tiers: ['L1', 'L2'],
    chapters: ['0001'],
    goalMode: 'both',
    presetId: 'preset-standard',
    goal: '文白相间，并清掉全部 Markdown 符号',
  })
  const prompt = buildRevisionGoalPrompt(await store.getBundle(root, project.id), await store.getRevision(root, project.id))
  assert.match(prompt, /文白相间，并清掉全部 Markdown 符号/)
  assert.match(prompt, /文风规格来源：预设/)
})

test('planRevisionRun：返回 prompt / impact / batchCount，前端可一次性渲染清单', async (t) => {
  const { root, project } = await makeProject(t)
  const result = await planRevisionRun(root, project.id, {
    tiers: ['L1', 'L2'],
    chapters: ['0001', '0002'],
    goalMode: 'custom',
    goal: '改文风',
    batchSize: 1,
  })
  assert.equal(result.batchCount, 2)
  assert.equal(result.revision.batches.length, 2)
  assert.equal(result.revision.contract.tier, 'L1+L2', 'contract.tier 应写组合层级')
  assert.ok(result.prompt.includes('L1+L2'), 'prompt 里应是组合层级')
  assert.ok(result.impact, '应返回影响面')
})
