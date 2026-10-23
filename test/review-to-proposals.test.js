/**
 * 审稿 → 修订提案（review-to-proposals）。
 * 覆盖：只带选中审稿、逐条列出问题/建议、要求 chapter 提案 + reviewIds、错误兜底，
 * 以及不能混进常规交接 prompt 的分角色审阅规范。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../lib/store.js'
import { buildHandoffPrompt } from '../index.js'
import { makeRoot } from './helpers.js'

async function seed(t) {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '审稿提案' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '正文一。' })
  await store.saveChapter(root, project.id, { id: '0003', title: '第三章', content: '正文三。' })
  const r1 = await store.upsertEntity(root, project.id, 'reviews', {
    chapter: 1, dimension: '连续性', severity: 'blocker', issue: '年龄矛盾', suggestion: '统一为十二年',
  })
  const r2 = await store.upsertEntity(root, project.id, 'reviews', {
    chapter: 3, dimension: '人物', severity: 'major', issue: '太子即位传言', suggestion: '改成讹传',
  })
  const bundle = await store.getBundle(root, project.id)
  return { root, project, bundle, r1, r2 }
}

test('review-to-proposals：只列选中的审稿，要求逐条出 chapter 提案', async (t) => {
  const { bundle, r1 } = await seed(t)
  const prompt = buildHandoffPrompt(bundle, { task: 'review-to-proposals', reviewIds: [r1.id] })

  assert.match(prompt.split('\n')[0], /【按审稿出提案】/)
  assert.ok(prompt.includes('下面 1 条'), '应写明本次要处理几条')
  assert.ok(prompt.includes('年龄矛盾'), '应带审稿问题')
  assert.ok(prompt.includes('统一为十二年'), '应带修改建议')
  assert.ok(prompt.includes(`审稿 id=${r1.id}`), '应带审稿 id，方便回写关联')
  assert.ok(prompt.includes('第1章'), '应带章号')
  assert.ok(!prompt.includes('太子即位传言'), '未选中的审稿不能混进来')
  assert.ok(prompt.includes('novel_desk_propose'), '必须要求走提案')
  assert.ok(prompt.includes('reviewIds=[审稿 id]'), '提案里要带 reviewIds')
  assert.ok(prompt.includes('不要直接改正文'), '必须禁止直改正文')
  for (const polluted of ['工作台交接', '分角色审阅规范', '写作预设', '禁忌']) {
    assert.ok(!prompt.includes(polluted), `不能出现「${polluted}」，否则模型会去写审稿而不是提案`)
  }
})

test('review-to-proposals：多条按清单顺序列出，条数正确', async (t) => {
  const { bundle, r1, r2 } = await seed(t)
  const prompt = buildHandoffPrompt(bundle, { task: 'review-to-proposals', reviewIds: [r1.id, r2.id] })

  assert.ok(prompt.includes('下面 2 条'))
  assert.ok(prompt.indexOf('年龄矛盾') < prompt.indexOf('太子即位传言'), '应按传入顺序排列')
  assert.match(prompt, /1\. 第1章.*blocker/)
  assert.match(prompt, /2\. 第3章.*major/)
})

test('review-to-proposals：没选中/选到不存在的审稿时报清楚错误', async (t) => {
  const { bundle } = await seed(t)
  assert.throws(() => buildHandoffPrompt(bundle, { task: 'review-to-proposals', reviewIds: [] }), /没有选择要处理的审稿意见/)
  assert.throws(() => buildHandoffPrompt(bundle, { task: 'review-to-proposals', reviewIds: ['not-a-review'] }), /没有选择要处理的审稿意见/)
  assert.throws(() => buildHandoffPrompt(bundle, { task: 'review-to-proposals' }), /没有选择要处理的审稿意见/)
})

test('acceptProposal：带 reviewIds 的章节提案采纳后自动把对应审阅标记 fixed', async (t) => {
  const { root, project, r1 } = await seed(t)
  const proposal = await store.createProposal(root, project.id, {
    kind: 'chapter',
    chapter: 1,
    title: '按审稿修订第一章',
    data: { title: '第一章（修订）', content: '修订后的正文。', reviewIds: [r1.id] },
  })
  const result = await store.acceptProposal(root, project.id, proposal.id)
  assert.equal(result.applied.reviews, 1, '采纳时应把关联审阅标记为已修')
  const bundle = await store.getBundle(root, project.id)
  const review = bundle.reviews.find((row) => row.id === r1.id)
  assert.equal(review.status, 'fixed')
  assert.equal(review.fixedByProposalId, proposal.id)
})

test('reconcileReviewsFromAcceptedProposals：历史「提案已采纳但审阅未归档」可幂等回填', async (t) => {
  const { root, project, r1 } = await seed(t)
  const proposal = await store.createProposal(root, project.id, {
    kind: 'chapter',
    chapter: 1,
    title: '历史修订',
    data: { title: '第一章（历史）', content: '历史正文。', reviewIds: [r1.id] },
  })
  await store.upsertEntity(root, project.id, 'proposals', {
    ...proposal,
    status: 'accepted',
    acceptedAt: new Date().toISOString(),
  })
  const first = await store.reconcileReviewsFromAcceptedProposals(root, project.id)
  assert.equal(first.updated, 1)
  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.reviews.find((row) => row.id === r1.id).status, 'fixed')
  const second = await store.reconcileReviewsFromAcceptedProposals(root, project.id)
  assert.equal(second.updated, 0, '幂等：第二次不应再改')
})

test('review-to-proposals：从清单 items 里取审稿 id（清单是唯一 AI 入口）', async (t) => {
  const { bundle, r1, r2 } = await seed(t)
  const items = [
    { kind: 'review', id: r1.id, chapter: 1, title: '年龄矛盾' },
    { kind: 'review', id: r2.id, chapter: 3, title: '太子即位传言' },
  ]
  const prompt = buildHandoffPrompt(bundle, { task: 'review-to-proposals', items })
  assert.ok(prompt.includes('下面 2 条'))
  assert.ok(prompt.includes('年龄矛盾') && prompt.includes('太子即位传言'))
  assert.ok(prompt.indexOf('年龄矛盾') < prompt.indexOf('太子即位传言'), '按清单顺序')
  // 清单里混着其它类型时，只取审稿项
  const mixed = buildHandoffPrompt(bundle, { task: 'review-to-proposals', items: [...items, { kind: 'proposal', id: 'p1' }] })
  assert.ok(mixed.includes('下面 2 条'), '非审稿项不计入')
})
