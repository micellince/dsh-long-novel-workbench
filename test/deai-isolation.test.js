/**
 * 去 AI 化审阅隔离：只给本书章节副本、prompt 写死边界、审稿拒绝跨作品引用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import { prepareDeaiWorkspace, startDeaiReview, writeReviewBatch, DEAI_AUDIT_URL, apply } from '../index.js'
import { makeRoot } from './helpers.js'

function useTempRoot(t, root) {
  const previous = process.env.STORY_DESK_ROOT
  process.env.STORY_DESK_ROOT = root
  t.after(() => {
    if (previous === undefined) delete process.env.STORY_DESK_ROOT
    else process.env.STORY_DESK_ROOT = previous
  })
}

function deaiTools() {
  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {}, get: () => undefined })
  return tools
}

async function seeded(t, name = '本书甲') {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '他把信纸折好塞进怀里，转身出门。' })
  await store.saveChapter(root, project.id, { id: '0002', title: '第二章', content: '雪落下来，他没有回头。' })
  const bundle = await store.getBundle(root, project.id)
  if (bundle.presets?.[0]) await store.updateProject(root, project.id, { activePresetId: bundle.presets[0].id })
  return { root, project }
}

test('prepareDeaiWorkspace：隔离目录只含本书章节正文副本，没有任何历史文件', async (t) => {
  const { root, project } = await seeded(t)
  await store.createProject(root, { name: '鱼龙舞' })
  const bundle = await store.getBundle(root, project.id)
  const workspace = await prepareDeaiWorkspace(root, bundle)

  assert.match(workspace.dir, /\.review-workspaces/)
  assert.deepEqual(await readdir(workspace.dir), ['chapters'])
  assert.deepEqual(await readdir(join(workspace.dir, 'chapters')), ['0001.md', '0002.md'])
  assert.equal(await readFile(join(workspace.dir, 'chapters', '0001.md'), 'utf8'), '他把信纸折好塞进怀里，转身出门。')
  assert.equal(await readFile(join(workspace.dir, 'chapters', '0002.md'), 'utf8'), '雪落下来，他没有回头。')
  assert.equal(workspace.chapterFiles.length, 2)
  assert.ok(workspace.chapterFiles.every((row) => row.path.startsWith(workspace.dir)))
})

test('startDeaiReview(dryRun)：prompt 带硬边界、只读清单、本书路径，且不出现其他作品名', async (t) => {
  const { root, project } = await seeded(t)
  await store.createProject(root, { name: '鱼龙舞' })
  const result = await startDeaiReview(root, project.id, null, { dryRun: true })

  assert.equal(result.chapterCount, 2)
  assert.match(result.workspacePath, /\.review-workspaces/)
  assert.match(result.prompt, /独立会话 · 零上下文 · 只审本书/)
  assert.match(result.prompt, /绝对禁止跨作品对比/)
  assert.match(result.prompt, /读取清单以外的任何文件/)
  assert.match(result.prompt, /第1章《第一章》｜\d+ 字｜/)
  assert.ok(result.prompt.includes(result.workspacePath), 'prompt 里的路径必须指向隔离工作区')
  assert.match(result.prompt, /origin="deai"/)
  assert.ok(result.prompt.includes(DEAI_AUDIT_URL))
  assert.ok(!result.prompt.includes('鱼龙舞'), '去 AI 化工作单不应出现其他作品名')
})

test('writeReviewBatch：deai 审稿 quote 必须逐字来自本章正文', async (t) => {
  const { root, project } = await seeded(t)
  await assert.rejects(
    () => writeReviewBatch(root, project.id, { origin: 'deai', reviews: [{ chapter: 1, issue: '句子太像模型', suggestion: '改成动作' }] }),
    /没带 quote/,
  )
  await assert.rejects(
    () => writeReviewBatch(root, project.id, { origin: 'deai', reviews: [{ chapter: 1, issue: '句子太像模型', suggestion: '改成动作', quote: '这句原文根本不存在' }] }),
    /quote 不在第 1 章正文里/,
  )
  const text = await writeReviewBatch(root, project.id, { origin: 'deai', reviews: [{ chapter: 1, issue: '句子太像模型', suggestion: '改成动作', quote: '他把信纸折好塞进怀里' }] })
  assert.match(text, /新增 1 条/)
  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.reviews[0].origin, 'deai')
})

test('writeReviewBatch：审稿提到其他作品名直接拒收（禁止跨作品对比）', async (t) => {
  const { root, project } = await seeded(t)
  await store.createProject(root, { name: '鱼龙舞' })
  await assert.rejects(
    () => writeReviewBatch(root, project.id, { origin: 'deai', reviews: [{ chapter: 1, issue: '比《鱼龙舞》差远了', suggestion: '照它改', quote: '他把信纸折好塞进怀里' }] }),
    /提到了其他作品「鱼龙舞」/,
  )
  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.reviews.length, 0, '被拒的审稿不应写进账本')
})

test('novel_desk_deai_review：工具已注册，workorder 返回隔离工作单，start 没有隔离工作区就报错', async (t) => {
  const { root, project } = await seeded(t)
  const tool = deaiTools().find((row) => row.name === 'novel_desk_deai_review')
  assert.ok(tool, 'apply 应注册 novel_desk_deai_review')
  assert.deepEqual(tool.parameters.properties.op.enum, ['start', 'workorder'])
  assert.match(tool.description, /独立/)

  const prompt = await tool.execute({ project: project.id, op: 'workorder' })
  assert.match(prompt, /硬性边界/)
  assert.match(prompt, /origin="deai"/)
  await assert.rejects(() => tool.execute({ project: project.id, op: 'start' }), /隔离工作区/)
})
