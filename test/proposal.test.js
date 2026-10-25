/**
 * lib/store.js：提案单条/批量采纳与驳回、失败隔离、章节采纳前备份、修订回链。
 * 覆盖契约 §2.2（统一备份）、§3.2（批量 API）与现有 markProposalRevised 行为回归。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as store from '../lib/store.js'
import { makeRoot, needFn } from './helpers.js'

async function newProject(t, name = '提案测试') {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name })
  return { root, project }
}

test('createProposal → acceptProposal：事实提案采纳后写入账本', async (t) => {
  const { root, project } = await newProject(t)
  const proposal = await store.createProposal(root, project.id, {
    kind: 'facts',
    title: '第 1 章事实',
    items: [{ subject: '甲', attribute: '年龄', value: '20' }],
  })
  assert.ok(proposal.id, 'createProposal 应返回提案 id')
  assert.equal(proposal.status, 'pending', '新提案状态应为 pending')

  const result = await store.acceptProposal(root, project.id, proposal.id)
  assert.equal(result.proposal.status, 'accepted', '采纳后提案状态应为 accepted')
  assert.equal(result.applied.facts, 1, '采纳事实提案应写入 1 条事实')

  const facts = await store.getEntities(root, project.id, 'facts')
  assert.equal(facts.length, 1, '事实账本应有 1 条记录')
  assert.equal(facts[0].value, '20', '写入的事实取值应与提案一致')

  await assert.rejects(
    () => store.acceptProposal(root, project.id, proposal.id),
    /已处理/,
    '重复采纳同一提案应报「已处理」错误',
  )
})

test('rejectProposal：标记 rejected 且不改动账本', async (t) => {
  const { root, project } = await newProject(t)
  const proposal = await store.createProposal(root, project.id, {
    kind: 'facts',
    title: '待驳回',
    items: [{ subject: '乙', attribute: '身份', value: '书生' }],
  })
  const result = await store.rejectProposal(root, project.id, proposal.id)
  assert.equal(result.rejected, proposal.id, '驳回应返回被驳回的提案 id')

  const proposals = await store.getEntities(root, project.id, 'proposals')
  assert.equal(proposals.find((p) => p.id === proposal.id).status, 'rejected', '提案状态应变为 rejected')
  assert.deepEqual(await store.getEntities(root, project.id, 'facts'), [], '驳回提案不应写入账本')
})

test('章节提案采纳前：先备份旧稿再写入新正文', async (t) => {
  const { root, project } = await newProject(t)
  await store.saveChapter(root, project.id, { id: '0002', title: '第二章', content: '旧稿正文。' })

  const proposal = await store.createProposal(root, project.id, {
    kind: 'chapter',
    chapter: 2,
    title: '第二章（AI 重写）',
    data: { title: '第二章（AI 重写）', content: '新稿正文。' },
  })
  const result = await store.acceptProposal(root, project.id, proposal.id)
  assert.equal(result.applied.chapter, '0002', '章节提案应写入第 0002 章')
  assert.ok(result.applied.backup, '章节采纳前必须备份旧稿')
  assert.match(result.applied.backup, /\.backups[\\/]/, '采纳备份路径应落在作品的 .backups/ 目录')

  const backupText = await readFile(result.applied.backup, 'utf8')
  assert.match(backupText, /旧稿正文/, '备份文件应是采纳前的旧稿')

  const chapters = await store.listChapters(root, project.id)
  assert.equal(chapters[0].content, '新稿正文。', '采纳后章节正文应更新为新稿')
  assert.equal(chapters[0].title, '第二章（AI 重写）', '采纳后章节标题应更新')
})

test('batchAcceptProposals：成功与失败隔离（不存在的 id、已处理提案）', async (t) => {
  const { root, project } = await newProject(t)
  const batchAccept = needFn(store, 'batchAcceptProposals', 'lib/store.js')

  const p1 = await store.createProposal(root, project.id, {
    kind: 'facts',
    title: '批量一',
    items: [{ subject: '甲', attribute: '年龄', value: '20' }],
  })
  const p2 = await store.createProposal(root, project.id, {
    kind: 'events',
    title: '批量二',
    items: [{ title: '入门', chapter: 1, storyTime: '第一年春' }],
  })
  const handled = await store.createProposal(root, project.id, { kind: 'custom', title: '已驳回' })
  await store.rejectProposal(root, project.id, handled.id)

  const result = await batchAccept(root, project.id, [p1.id, 'no-such-id', handled.id, p2.id])
  assert.equal(result.accepted.length, 2, '两个有效提案应被采纳，失败项不影响其他项')
  assert.deepEqual(
    result.accepted.map((row) => row.id).sort(),
    [p1.id, p2.id].sort(),
    'accepted 应恰好包含两个有效提案 id',
  )
  assert.equal(result.failed.length, 2, '不存在 id 与已处理提案应各自进入 failed')
  assert.ok(result.failed.some((row) => row.id === 'no-such-id' && typeof row.error === 'string'), '不存在 id 应在 failed 中带 error')
  assert.ok(result.failed.some((row) => row.id === handled.id && typeof row.error === 'string'), '已处理提案应在 failed 中带 error')

  assert.equal((await store.getEntities(root, project.id, 'facts')).length, 1, '失败隔离：有效的事实提案照常写入')
  assert.equal((await store.getEntities(root, project.id, 'events')).length, 1, '失败隔离：有效的事件提案照常写入')
})

test('batchRejectProposals：成功与失败隔离', async (t) => {
  const { root, project } = await newProject(t)
  const batchReject = needFn(store, 'batchRejectProposals', 'lib/store.js')

  const p1 = await store.createProposal(root, project.id, { kind: 'custom', title: '驳回一' })
  const p2 = await store.createProposal(root, project.id, { kind: 'custom', title: '驳回二' })
  const result = await batchReject(root, project.id, [p1.id, 'no-such-id', p2.id])

  assert.deepEqual(result.rejected.slice().sort(), [p1.id, p2.id].sort(), 'rejected 应包含两个有效提案 id')
  assert.equal(result.failed.length, 1, '不存在的 id 应进入 failed')
  assert.equal(result.failed[0].id, 'no-such-id', 'failed 应记录不存在的 id')
  assert.equal(typeof result.failed[0].error, 'string', 'failed 应带可读 error')

  const proposals = await store.getEntities(root, project.id, 'proposals')
  for (const id of [p1.id, p2.id]) {
    assert.equal(proposals.find((p) => p.id === id).status, 'rejected', `提案 ${id} 应被驳回`)
  }
})

test('batchUpdateReviews：只改 status，其他字段忽略，缺失 id 单独报告', async (t) => {
  const { root, project } = await newProject(t)
  const batchUpdate = needFn(store, 'batchUpdateReviews', 'lib/store.js')

  const r1 = await store.upsertEntity(root, project.id, 'reviews', { chapter: 1, issue: '问题一', rarity: 'x', status: 'open' })
  const r2 = await store.upsertEntity(root, project.id, 'reviews', { chapter: 2, issue: '问题二', status: 'open' })

  const result = await batchUpdate(root, project.id, [r1.id, 'no-such-id', r2.id], { status: 'fixed', issue: '不该被改' })
  assert.equal(result.updated, 2, '两条存在的审稿应被更新')
  assert.deepEqual(result.missing, ['no-such-id'], '缺失的审稿 id 应单独报告')

  const reviews = await store.getEntities(root, project.id, 'reviews')
  const updated = reviews.find((row) => row.id === r1.id)
  assert.equal(updated.status, 'fixed', '审稿 status 应被分批更新')
  assert.equal(updated.issue, '问题一', 'batchUpdateReviews 只允许改 status，其他字段应忽略')
})

test('markProposalRevised：旧提案标记 revised，新提案回链 revisedFrom（回归）', async (t) => {
  const { root, project } = await newProject(t)
  const mark = needFn(store, 'markProposalRevised', 'lib/store.js')

  const old = await store.createProposal(root, project.id, { kind: 'custom', title: '原始提案' })
  const next = await store.createProposal(root, project.id, { kind: 'custom', title: '修订提案' })
  const marked = await mark(root, project.id, old.id, next.id)

  assert.equal(marked.id, next.id, 'markProposalRevised 应返回新提案')
  assert.equal(marked.revisedFrom, old.id, '新提案应带 revisedFrom 回链')

  const proposals = await store.getEntities(root, project.id, 'proposals')
  const oldRow = proposals.find((p) => p.id === old.id)
  assert.equal(oldRow.status, 'revised', '旧提案状态应变为 revised')
  assert.equal(oldRow.revisedTo, next.id, '旧提案应带 revisedTo 指向新提案')
})

test('reopenProposal：已驳回/已修订的提案可以重新打开为待处理', async (t) => {
  const { root, project } = await newProject(t)
  const rejected = await store.createProposal(root, project.id, { kind: 'facts', title: '会被驳回', items: [] })
  await store.rejectProposal(root, project.id, rejected.id)
  const reopened = await store.reopenProposal(root, project.id, rejected.id)
  assert.equal(reopened.status, 'pending', '驳回后应能重新打开')

  const old = await store.createProposal(root, project.id, { kind: 'decision', title: '原决策' })
  const next = await store.createProposal(root, project.id, {
    kind: 'facts',
    title: '按决策产生的修改',
    items: [{ subject: '甲', attribute: '年龄', value: '30' }],
    resolvesProposalId: old.id,
  })
  let proposals = await store.getEntities(root, project.id, 'proposals')
  assert.equal(proposals.find((p) => p.id === old.id).status, 'pending', '新提案创建时原决策应保持 pending')
  await store.acceptProposal(root, project.id, next.id)
  proposals = await store.getEntities(root, project.id, 'proposals')
  assert.equal(proposals.find((p) => p.id === old.id).status, 'revised', '新提案被采纳后原决策才标记 revised')
  const reopenedOld = await store.reopenProposal(root, project.id, old.id)
  assert.equal(reopenedOld.status, 'pending', '已修订的原决策也应能重新打开')
})

// ── 待采纳提案去重：AI 重试/复测重打分不应并排出现两张卡 ─────────────

test('createProposal：同章同内容的 pending 提案重复提交 → 复用旧卡，不新增', async (t) => {
  const { root, project } = await newProject(t)
  const payload = {
    kind: 'attention',
    chapter: 3,
    title: '第 3 章冷读',
    items: [{ chapter: 3, score: 66, breakdown: { hook: 16, tension: 13, payoff: 15, cliff: 9 } }],
  }
  const first = await store.createProposal(root, project.id, payload)
  const second = await store.createProposal(root, project.id, payload)
  assert.equal(second.id, first.id, '完全相同的重复提交应返回同一张提案卡')
  const pending = (await store.getEntities(root, project.id, 'proposals')).filter((p) => p.status === 'pending')
  assert.equal(pending.length, 1, '重复提交不应留下两张待采纳卡')
})

test('createProposal：同章 attention 重打分 → 原地覆盖旧 pending，保留 id', async (t) => {
  const { root, project } = await newProject(t)
  const first = await store.createProposal(root, project.id, {
    kind: 'attention',
    chapter: 11,
    title: '第 11 章冷读 87',
    rationale: '初评',
    items: [{ chapter: 11, score: 87, breakdown: { hook: 20, tension: 23, payoff: 23, cliff: 21 } }],
  })
  const second = await store.createProposal(root, project.id, {
    kind: 'attention',
    chapter: 11,
    title: '第 11 章复测 83',
    rationale: '重打分说明：初评 87 偏高',
    items: [{ chapter: 11, score: 83, breakdown: { hook: 18, tension: 22, payoff: 22, cliff: 21 } }],
  })
  assert.equal(second.id, first.id, '同章同角色的重打分应覆盖旧卡而不是新增')
  const pending = (await store.getEntities(root, project.id, 'proposals')).filter((p) => p.status === 'pending')
  assert.equal(pending.length, 1, '第 11 章只应有一张待采纳注意力卡')
  assert.equal(pending[0].items[0].score, 83, '保留的是最新一次复测分数')
  assert.match(pending[0].rationale, /重打分说明/, '覆盖后应带最新说明')
})

test('createProposal：同章 design 与 measured 两种注意力角色可以并存', async (t) => {
  const { root, project } = await newProject(t)
  await store.createProposal(root, project.id, {
    kind: 'attention',
    chapter: 5,
    title: '第 5 章写作前设计',
    items: [{ chapter: 5, designScore: 86, hook: '钩子', tension: '张力', payoff: '回报', cliff: '章末' }],
  })
  await store.createProposal(root, project.id, {
    kind: 'attention',
    chapter: 5,
    title: '第 5 章实测',
    items: [{ chapter: 5, score: 70, breakdown: { hook: 15, tension: 16, payoff: 18, cliff: 21 } }],
  })
  const pending = (await store.getEntities(root, project.id, 'proposals')).filter((p) => p.status === 'pending')
  assert.equal(pending.length, 2, '设计稿与实测稿是两种角色，应各留一张')
})

test('createProposal：不同章的 attention 互不覆盖；非 pending 不被覆盖', async (t) => {
  const { root, project } = await newProject(t)
  const first = await store.createProposal(root, project.id, {
    kind: 'attention', chapter: 7, title: '第 7 章', items: [{ chapter: 7, score: 60, breakdown: { hook: 10 } }],
  })
  await store.createProposal(root, project.id, {
    kind: 'attention', chapter: 8, title: '第 8 章', items: [{ chapter: 8, score: 62, breakdown: { hook: 11 } }],
  })
  await store.acceptProposal(root, project.id, first.id)
  const third = await store.createProposal(root, project.id, {
    kind: 'attention', chapter: 7, title: '第 7 章重新打分', items: [{ chapter: 7, score: 64, breakdown: { hook: 12 } }],
  })
  assert.notEqual(third.id, first.id, '已采纳的卡片不应被覆盖，应生成新卡')
  const pending = (await store.getEntities(root, project.id, 'proposals')).filter((p) => p.status === 'pending')
  assert.equal(pending.length, 2, '第 7 章（新卡）与第 8 章各一张待采纳')
})

