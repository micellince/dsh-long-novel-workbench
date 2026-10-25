/**
 * 复核落审稿：novel_desk_review 支持多章/全书级/来源标记/去重与重新打开，
 * 以及「复测读出的问题没落审稿」检查规则。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../lib/store.js'
import { runChecks } from '../lib/checks.js'
import { apply } from '../index.js'
import { makeRoot } from './helpers.js'

function useTempRoot(t, root) {
  const previous = process.env.STORY_DESK_ROOT
  process.env.STORY_DESK_ROOT = root
  t.after(() => {
    if (previous === undefined) delete process.env.STORY_DESK_ROOT
    else process.env.STORY_DESK_ROOT = previous
  })
}

function reviewTools() {
  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {}, get: () => undefined })
  return tools
}

async function seeded(t) {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name: '复核落审稿' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '正文一。' })
  await store.saveChapter(root, project.id, { id: '0002', title: '第二章', content: '正文二。' })
  return { root, project }
}

test('novel_desk_review：一次可写多章 + 全书级，来源标 origin', async (t) => {
  const { root, project } = await seeded(t)
  const tool = reviewTools().find((row) => row.name === 'novel_desk_review')
  assert.ok(tool, 'apply 应注册 novel_desk_review')

  const text = await tool.execute({
    project: project.id,
    origin: 'recheck',
    reviews: [
      { chapter: 1, dimension: '节奏', severity: 'major', issue: '中段连续三段解释', suggestion: '换成动作与对话', quote: '正文一。' },
      { chapter: 2, dimension: '人物', severity: 'minor', issue: '配角动机没交代', suggestion: '补一句他为什么帮她' },
      { chapter: 0, dimension: '情节', severity: 'major', issue: '开头两章都在铺设定', suggestion: '把设定拆到后面章节' },
    ],
  })
  assert.match(text, /新增 3 条/)
  assert.match(text, /全书/)
  assert.match(text, /加入清单/)
  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.reviews.length, 3)
  assert.deepEqual(bundle.reviews.map((row) => Number(row.chapter)).sort((a, b) => a - b), [0, 1, 2])
  assert.ok(bundle.reviews.every((row) => row.origin === 'recheck'), '复核来源应写进审稿条目')
  assert.ok(bundle.reviews.every((row) => row.status === 'open'))
  assert.equal(bundle.reviews.find((row) => Number(row.chapter) === 1).quote, '正文一。')
})

test('novel_desk_review：同章同维度同题去重，已归档的自动重新打开', async (t) => {
  const { root, project } = await seeded(t)
  const tool = reviewTools().find((row) => row.name === 'novel_desk_review')
  const base = { chapter: 1, dimension: '节奏', severity: 'major', issue: '中段连续三段解释', suggestion: '换成动作' }

  await tool.execute({ project: project.id, origin: 'recheck', reviews: [base] })
  const second = await tool.execute({ project: project.id, origin: 'recheck', reviews: [base] })
  assert.match(second, /跳过重复 1 条/)
  let bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.reviews.length, 1, '重复条目不应新增')

  const existing = bundle.reviews[0]
  await store.upsertEntity(root, project.id, 'reviews', { ...existing, status: 'fixed', fixedAt: new Date().toISOString() })
  const third = await tool.execute({ project: project.id, origin: 'recheck', reviews: [base] })
  assert.match(third, /重新打开 1 条/)
  bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.reviews[0].status, 'open', '已归档的问题再次出现应重新打开')
  assert.equal(bundle.reviews[0].reopenCount, 1)
  assert.equal(bundle.reviews[0].reopenFrom, 'fixed')
})

test('novel_desk_review：缺章号 / 章节不存在 / 空数组都报中文错误', async (t) => {
  const { project } = await seeded(t)
  const tool = reviewTools().find((row) => row.name === 'novel_desk_review')
  await assert.rejects(() => tool.execute({ project: project.id, reviews: [] }), /reviews 不能为空/)
  await assert.rejects(
    () => tool.execute({ project: project.id, reviews: [{ dimension: '节奏', issue: '太慢' }] }),
    /没写章号/,
  )
  await assert.rejects(
    () => tool.execute({ project: project.id, reviews: [{ chapter: 99, dimension: '节奏', issue: '太慢' }] }),
    /第 99 章不存在/,
  )
  await assert.rejects(
    () => tool.execute({ project: project.id, origin: 'from-nowhere', reviews: [{ chapter: 1, issue: '太慢' }] }),
    /origin 不认识/,
  )
  await assert.rejects(
    () => tool.execute({ project: project.id, reviews: [{ chapter: 1, issue: '太慢', severity: '致命' }] }),
    /severity 不认识/,
  )
})

test('novel_desk_review：参数声明支持 chapter=0、origin、reviews 为唯一必填', () => {
  const tool = reviewTools().find((row) => row.name === 'novel_desk_review')
  assert.deepEqual(tool.parameters.required, ['reviews'])
  assert.equal(tool.parameters.properties.chapter.minimum, 0)
  assert.deepEqual(tool.parameters.properties.origin.enum, ['cold-read', 'recheck', 'review', 'manual', 'deai'])
  assert.match(tool.description, /复测|复核/)
})

test('checks：复测过且分数仍低，却没写 recheck 来源审稿 → 提示落审稿', () => {
  const attention = [{
    chapter: 1,
    score: 70,
    breakdown: { hook: 18, tension: 16, payoff: 17, cliff: 10 },
    lastRecheckAt: '2026-10-24T03:00:00.000Z',
  }]
  const bare = runChecks({ chapters: [{ id: '0001', title: '第一章', content: '正文一。' }], attention, reviews: [] })
  const hit = bare.filter((check) => String(check.id).startsWith('attention-recheck-no-review:'))
  assert.equal(hit.length, 1)
  assert.equal(hit[0].level, 'info')
  assert.match(hit[0].detail, /novel_desk_review/)
  assert.match(hit[0].detail, /章末 仍 < 13/)

  const covered = runChecks({
    chapters: [{ id: '0001', title: '第一章', content: '正文一。' }],
    attention,
    reviews: [{ id: 'r1', chapter: 1, origin: 'recheck', status: 'open', issue: '章末太弱' }],
  })
  assert.equal(covered.filter((check) => String(check.id).startsWith('attention-recheck-no-review:')).length, 0)
})
