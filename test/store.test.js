import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'

import * as store from '../lib/store.js'
import { runMigration, verifyProject } from '../scripts/migrate.js'

/** 每个测试独立的临时数据根（绝不写 ~/StoryDesk）。 */
async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-nd-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const projectPath = (root, id, ...parts) => join(root, 'projects', id, ...parts)

test('项目：创建 / 列表 / 读取 / 更新（未知字段保留）', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '测试书', genre: '武侠' })
  assert.match(project.id, /^pm/)
  assert.equal(project.title, '测试书')
  assert.equal(project.schemaVersion, '0.6.0')
  assert.deepEqual(project.readingPosition, { chapter: 1, offset: 0 })

  const list = await store.listProjects(root)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, project.id)
  assert.equal(list[0].title, '测试书')
  assert.equal(list[0].genre, '武侠')
  assert.equal(list[0].chapters, 0)

  const updated = await store.updateProject(root, project.id, { logline: '一句话简介', customField: { a: 1 } })
  assert.equal(updated.logline, '一句话简介')
  assert.deepEqual(updated.customField, { a: 1 })

  const renamed = await store.updateProject(root, project.id, { title: '改名后' })
  assert.equal(renamed.title, '改名后')
  assert.equal(renamed.name, '改名后')

  const ctx = await store.getContext(root, project.id)
  assert.equal(ctx.project.id, project.id)
  assert.ok(Array.isArray(ctx.presets) && ctx.presets.length >= 1)
  assert.deepEqual(ctx.recent, [])
})

test('章节 txt：读 / 写 / 备份 / 历史 / stale / 搜索', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: 'txt 书' })
  const first = await store.saveChapter(root, project.id, 1, '第一段。\n\n第二段。', { title: '第一章' })
  assert.equal(first.format, 'txt')
  assert.equal(first.backup, null)
  assert.ok(first.words > 0)
  assert.match(first.contentHash, /^[0-9a-f]{12}$/)

  const read = await store.readChapter(root, project.id, 1)
  assert.equal(read.format, 'txt')
  assert.equal(read.text, '第一段。\n\n第二段。')
  assert.equal(read.meta.title, '第一章')
  assert.equal(read.meta.contentHash, first.contentHash)

  const listed = await store.listChapters(root, project.id)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].chapter, 1)
  assert.equal(listed[0].title, '第一章')

  await assert.rejects(store.saveChapter(root, project.id, 1, '新正文', {}, { baseHash: '000000000000' }), (error) => {
    assert.equal(error.code, 'stale')
    assert.equal(error.currentHash, first.contentHash)
    return true
  })
  await assert.rejects(store.saveChapter(root, project.id, 2, '   ', {}), (error) => error.code === 'empty')

  const second = await store.saveChapter(root, project.id, 1, '新正文。', {}, { baseHash: first.contentHash })
  assert.ok(second.backup)
  assert.equal(second.format, 'txt')

  const history = await store.listChapterHistory(root, project.id, 1)
  assert.equal(history.length, 1)
  assert.equal(history[0].source, '0.6')
  const version = await store.readChapterVersion(root, project.id, 1, history[0].version)
  assert.equal(version.text, '第一段。\n\n第二段。')

  const search = await store.searchChapter(root, project.id, '新正文')
  assert.equal(search.length, 1)
  assert.equal(search[0].chapter, 1)
  assert.equal(search[0].offset, 0)
  assert.ok(search[0].snippet.includes('新正文'))
})

test('章节 md：原地写回 frontmatter（未知键保留）+ 旁路 meta.json', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: 'md 书' })
  await mkdir(projectPath(root, project.id, 'chapters'), { recursive: true })
  const md = [
    '---',
    'id: "0002"',
    'title: "旧章"',
    'status: "final"',
    'summary: ""',
    'location: ""',
    'storyTime: ""',
    'characters: ["林默"]',
    'pov: "第三人称"',
    '---',
    '',
    '旧正文第一段。',
  ].join('\n')
  await writeFile(projectPath(root, project.id, 'chapters', '0002.md'), md)

  const read = await store.readChapter(root, project.id, 2)
  assert.equal(read.format, 'md')
  assert.equal(read.meta.title, '旧章')
  assert.equal(read.meta.status, 'final')
  assert.equal(read.meta.pov, '第三人称')
  assert.deepEqual(read.meta.characters, ['林默'])
  assert.equal(read.text, '旧正文第一段。')

  const gate = { prose: { normalized: true, removed: {} }, fidelity: 'pass', residue: 'pass', aistyle: { score: 8, pass: true } }
  const saved = await store.saveChapter(root, project.id, 2, '新正文。', { title: '新标题', gate })
  assert.equal(saved.format, 'md')

  const raw = await readFile(projectPath(root, project.id, 'chapters', '0002.md'), 'utf8')
  assert.ok(raw.includes('pov: "第三人称"'), '未知 frontmatter 键应原样保留')
  assert.ok(raw.includes('title: "新标题"'))
  assert.ok(raw.includes('新正文。'))
  assert.equal(raw.includes('旧正文第一段。'), false)

  const sidecar = JSON.parse(await readFile(projectPath(root, project.id, 'chapters', '0002.meta.json'), 'utf8'))
  assert.deepEqual(sidecar.gate, gate)

  const again = await store.readChapter(root, project.id, 2)
  assert.equal(again.format, 'md')
  assert.equal(again.meta.title, '新标题')
  assert.equal(again.meta.pov, '第三人称')
  assert.deepEqual(again.meta.gate, gate)

  await writeFile(projectPath(root, project.id, 'chapters', '0002.md.bak-20261022202745'), '旧备份')
  const listed = await store.listChapters(root, project.id)
  assert.equal(listed.length, 1, '旧备份 0002.md.bak-* 必须被忽略')
})

test('审阅：quote 逐字命中（空白/引号归一）、去重、四路 source 派生', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '审阅书' })
  await store.saveChapter(root, project.id, 1, '林默推开门，屋里没有人。\n\n桌上有一封信。', { title: '第一章' })
  await writeFile(
    projectPath(root, project.id, 'reviews.json'),
    JSON.stringify([
      { id: 'old1', chapter: 1, dimension: '连续性', severity: 'major', issue: '时间线冲突', suggestion: '', status: 'open', source: 'ai', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]),
  )

  const outcome = await store.addReviews(root, project.id, [
    { chapter: 1, source: 'logic', quote: '林默推开门', issue: '开门描写重复', suggestion: '删一处', severity: 'minor' },
    { chapter: 1, source: 'logic', quote: '林默 推开门', issue: '归一后与上一条重复', severity: 'minor' },
    { chapter: 1, source: 'ai-style', quote: '林默', issue: '太短', severity: 'minor' },
    { chapter: 1, source: 'ai-style', quote: '赵四出现', issue: '不在正文里', severity: 'minor' },
    { chapter: 0, source: 'reader', issue: '全书节奏问题', suggestion: '加钩子' },
  ])
  assert.deepEqual(outcome, { added: 2, skipped: 3 })

  const reviews = await store.getReviews(root, project.id)
  assert.equal(reviews.length, 3)
  const legacy = reviews.find((item) => item.id === 'old1')
  assert.equal(legacy.source, 'logic')
  assert.equal(legacy.legacySource, 'ai')
  assert.equal(legacy.dimension, '连续性')
  const added = reviews.filter((item) => item.id !== 'old1')
  assert.ok(added.some((item) => item.source === 'logic' && item.dimension === '逻辑' && item.quote === '林默推开门'))
  const global = added.find((item) => item.chapter === 0)
  assert.equal(global.source, 'reader')

  const again = await store.addReviews(root, project.id, [{ chapter: 1, source: 'logic', quote: '林默推开门', issue: '重复', severity: 'minor' }])
  assert.deepEqual(again, { added: 0, skipped: 1 })

  const patched = await store.patchReviews(root, project.id, [added.find((item) => item.chapter === 0).id], { status: 'fixed' })
  assert.equal(patched.updated, 1)
  const after = await store.getReviews(root, project.id)
  assert.equal(after.find((item) => item.chapter === 0).status, 'fixed')
  assert.ok(after.find((item) => item.chapter === 0).fixedAt)
})

test('注意力：数组形状、空值不擦除、breakdown 合并、自动 scoreHistory', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '注意力书' })
  await store.saveChapter(root, project.id, 1, '正文内容。', { title: '第一章' })

  const first = await store.mergeAttention(root, project.id, 1, {
    hook: '开场悬念',
    tension: '',
    note: null,
    measuredScore: 66,
    score: 99,
    designScore: 92,
    breakdown: { hook: 18, tension: 16 },
  })
  assert.equal(first.score, 34)
  assert.equal(first.hook, '开场悬念')
  assert.equal(first.tension, '')
  assert.equal(first.note, '')
  assert.equal('measuredScore' in first, false, 'measuredScore 是幽灵字段，必须丢弃')
  assert.equal(first.breakdown.tension, 16)
  assert.equal(first.scoreHistory.length, 1)
  assert.equal(first.scoreHistory[0].source, 'cold-read')
  assert.equal(first.scoreHistory[0].from, null)
  assert.equal(first.scoreHistory[0].to, 34)
  assert.ok(first.scoredAt)
  assert.match(first.scoredHash, /^[0-9a-f]{12}$/)

  const raw = JSON.parse(await readFile(projectPath(root, project.id, 'attention.json'), 'utf8'))
  assert.ok(Array.isArray(raw), 'attention.json 必须是数组')

  const second = await store.mergeAttention(root, project.id, 1, { breakdown: { payoff: 28, cliff: 27 }, note: '补完' })
  assert.equal(second.score, 89)
  assert.equal(second.breakdown.hook, 18, '合并而非覆盖')
  assert.equal(second.scoreHistory.length, 2)
  assert.equal(second.scoreHistory[1].source, 'recheck')
  assert.equal(second.scoreHistory[1].delta, 55)

  const blankOnly = await store.mergeAttention(root, project.id, 1, { hook: '', tension: null, note: '' })
  assert.equal(blankOnly.score, 89)
  assert.equal(blankOnly.scoreHistory.length, 2)

  const partial = await store.mergeAttention(root, project.id, 1, { hook: '新钩子', note: '' })
  assert.equal(partial.hook, '新钩子')
  assert.equal(partial.note, '补完')
  assert.equal(partial.scoreHistory.length, 2, '不传分数/拆解时不追加历史')

  const legacy = await store.getAttention(root, project.id)
  assert.equal(legacy.length, 1)
  await writeFile(projectPath(root, project.id, 'attention.json'), JSON.stringify({ chapters: { 2: [{ chapter: 2, hook: '旧' }] } }))
  const compat = await store.getAttention(root, project.id)
  assert.equal(compat.length, 1)
  assert.equal(compat[0].chapter, 2)
})

test('提案：去重 / 段落补丁过闸门 / 审阅联动 / 过期 / 改写 / 账本修复 / 旧 kind 只读', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '提案书' })
  const initial = '林默推开门，屋里没有人。\n\n桌上有一封信。'
  const saved = await store.saveChapter(root, project.id, 1, initial, { title: '第一章' })
  const added = await store.addReviews(root, project.id, [{ chapter: 1, source: 'logic', quote: '林默推开门', issue: '描写重复', suggestion: '改' }])
  assert.equal(added.added, 1)
  const review = (await store.getReviews(root, project.id))[0]

  const create = (data) =>
    store.createProposal(root, project.id, {
      chapter: 1,
      kind: 'patch-paragraph',
      title: '改开头',
      summary: '更直接',
      source: 'review',
      reviewIds: [review.id],
      data,
    })
  const proposal = await create({ patches: [{ before: '林默推开门', after: '林默一脚踹开门', why: '更有力', reviewIds: [review.id] }] })
  assert.match(proposal.id, /^pp_/)
  assert.equal(proposal.status, 'pending')
  assert.equal(proposal.baseHash, saved.contentHash)

  const duplicate = await create({ patches: [{ before: '林默推开门', after: '林默一脚踹开门', why: '更有力', reviewIds: [review.id] }] })
  assert.equal(duplicate.id, proposal.id, '同章同 kind 同 data 的 pending 提案应去重')

  const stub = async ({ root: r, projectId, chapter, text }) => ({ ok: true, chapter: await store.saveChapter(r, projectId, chapter, text), gates: { prose: { normalized: true } } })
  const accepted = await store.acceptProposal(root, project.id, proposal.id, { writeGates: stub })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.proposal.status, 'accepted')
  const chapter = await store.readChapter(root, project.id, 1)
  assert.ok(chapter.text.includes('林默一脚踹开门'))
  assert.equal(chapter.meta.title, '第一章', '闸门写入不应丢 meta')
  const fixed = (await store.getReviews(root, project.id)).find((item) => item.id === review.id)
  assert.equal(fixed.status, 'fixed')
  assert.equal(fixed.proposalId, proposal.id)

  // 过期：生成后正文又变了
  const stale = await store.createProposal(root, project.id, {
    chapter: 1,
    kind: 'patch-paragraph',
    title: '改第二段',
    data: { patches: [{ before: '桌上有一封信', after: '桌上放着一封未拆的信', why: '细' }] },
  })
  await store.saveChapter(root, project.id, 1, '林默一脚踹开门。\n\n桌上有一封信。')
  const staleOutcome = await store.acceptProposal(root, project.id, stale.id, { writeGates: stub })
  assert.equal(staleOutcome.ok, false)
  assert.equal(staleOutcome.code, 'stale')
  assert.equal((await store.getProposal(root, project.id, stale.id)).status, 'stale')
  await store.rejectProposal(root, project.id, stale.id, '过期')
  assert.equal((await store.getProposal(root, project.id, stale.id)).status, 'rejected')

  // 找不到补丁原文 → needs-fix，不落盘
  const before = (await store.readChapter(root, project.id, 1)).text
  const bad = await store.createProposal(root, project.id, {
    chapter: 1,
    kind: 'patch-paragraph',
    title: '找不到',
    data: { patches: [{ before: '根本不存在的句子', after: 'x', why: 'x' }] },
  })
  const badOutcome = await store.acceptProposal(root, project.id, bad.id, { writeGates: stub })
  assert.equal(badOutcome.ok, false)
  assert.equal((await store.getProposal(root, project.id, bad.id)).status, 'needs-fix')
  assert.equal((await store.readChapter(root, project.id, 1)).text, before)

  // 整章改写
  const rewrite = await store.createProposal(root, project.id, { chapter: 1, kind: 'rewrite-chapter', title: '重写', data: { content: '全新正文。' } })
  const rewriteOutcome = await store.acceptProposal(root, project.id, rewrite.id, { writeGates: stub })
  assert.equal(rewriteOutcome.ok, true)
  assert.equal((await store.readChapter(root, project.id, 1)).text, '全新正文。')

  // 账本修复
  const ledgerFix = await store.createProposal(root, project.id, {
    kind: 'ledger-fix',
    title: '补事实',
    data: { ledgerFixes: [{ kind: 'facts', patch: { id: 'f1', text: '林默是捕快' } }] },
  })
  const ledgerOutcome = await store.acceptProposal(root, project.id, ledgerFix.id)
  assert.equal(ledgerOutcome.ok, true)
  const facts = (await store.getLedger(root, project.id)).facts
  assert.equal(facts.length, 1)
  assert.equal(facts[0].text, '林默是捕快')

  // 账本修复：propose 工具 items 写法（data.items = [{kind,id,patch}]）也必须能批准
  const itemFix = await store.createProposal(root, project.id, {
    kind: 'ledger-fix',
    title: '补人物（items 写法）',
    data: { items: [{ kind: 'characters', id: 'c9', patch: { id: 'c9', name: '沈砚', role: '仵作' } }] },
  })
  const itemFixOutcome = await store.acceptProposal(root, project.id, itemFix.id)
  assert.equal(itemFixOutcome.ok, true, JSON.stringify(itemFixOutcome))
  assert.equal((await store.getLedger(root, project.id)).characters.find((row) => row.id === 'c9')?.name, '沈砚')

  // 账本修复：0.5 风格 data.kind + 裸 patch items 仍兼容
  const legacyShape = await store.createProposal(root, project.id, {
    kind: 'ledger-fix',
    title: '补事件（旧写法）',
    data: { kind: 'events', items: [{ id: 'e9', title: '雨夜验尸' }] },
  })
  const legacyShapeOutcome = await store.acceptProposal(root, project.id, legacyShape.id)
  assert.equal(legacyShapeOutcome.ok, true, JSON.stringify(legacyShapeOutcome))
  assert.equal((await store.getLedger(root, project.id)).events.find((row) => row.id === 'e9')?.title, '雨夜验尸')

  // 空修订项 / 非法账本类型：批准前就拒绝，且一条都不写
  const emptyFix = await store.createProposal(root, project.id, { kind: 'ledger-fix', title: '空修订', data: { items: [] } })
  await assert.rejects(store.acceptProposal(root, project.id, emptyFix.id), /没有账本修订项/)
  const badKindFix = await store.createProposal(root, project.id, {
    kind: 'ledger-fix',
    title: '非法类型',
    data: { items: [{ kind: 'facts', patch: { id: 'f2', text: '先写的' } }, { kind: 'nope', patch: { id: 'x1' } }] },
  })
  await assert.rejects(store.acceptProposal(root, project.id, badKindFix.id), /账本类型不支持/)
  assert.equal((await store.getLedger(root, project.id)).facts.some((row) => row.id === 'f2'), false)

  // 批量驳回
  const r1 = await store.createProposal(root, project.id, { chapter: 1, kind: 'rewrite-chapter', title: 'A', data: { content: 'A。' } })
  const r2 = await store.createProposal(root, project.id, { chapter: 1, kind: 'rewrite-chapter', title: 'B', data: { content: 'B。' } })
  const batch = await store.batchProposals(root, project.id, [r1.id, r2.id], 'reject')
  assert.deepEqual(batch.rejected, [r1.id, r2.id])
  assert.equal(batch.failed.length, 0)

  // 批量驳回可带原因：原因要写到每一条提案上
  const r3 = await store.createProposal(root, project.id, { chapter: 1, kind: 'rewrite-chapter', title: 'C', data: { content: 'C。' } })
  const r4 = await store.createProposal(root, project.id, { chapter: 1, kind: 'rewrite-chapter', title: 'D', data: { content: 'D。' } })
  const rejectWithReason = await store.batchProposals(root, project.id, [r3.id, r4.id], 'reject', { reason: '节奏太慢，先不合' })
  assert.deepEqual(rejectWithReason.rejected, [r3.id, r4.id])
  assert.equal((await store.getProposal(root, project.id, r3.id)).rejectReason, '节奏太慢，先不合')
  assert.equal((await store.getProposal(root, project.id, r4.id)).rejectReason, '节奏太慢，先不合')

  // 旧 kind：默认不展示、只读、不能批准
  const path = projectPath(root, project.id, 'proposals.json')
  const rows = JSON.parse(await readFile(path, 'utf8'))
  rows.push({ id: 'legacy_1', kind: 'plan', chapter: 1, title: '旧方案', status: 'pending', createdAt: '2025-01-01T00:00:00.000Z' })
  await writeFile(path, JSON.stringify(rows))
  const visible = await store.listProposals(root, project.id)
  assert.equal(visible.some((item) => item.id === 'legacy_1'), false)
  const withLegacy = await store.listProposals(root, project.id, { includeLegacy: true })
  assert.equal(withLegacy.find((item) => item.id === 'legacy_1').legacy, true)
  assert.equal(withLegacy.find((item) => item.id === 'legacy_1').readOnly, true)
  await assert.rejects(store.acceptProposal(root, project.id, 'legacy_1'), (error) => error.code === 'legacy-proposal')
})

test('run / 账本 / 设置 / 用量', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '杂项书' })

  const idle = await store.getRun(root, project.id)
  assert.equal(idle.status, 'idle')

  const running = await store.saveRun(root, project.id, {
    action: 'rewrite',
    status: 'running',
    budget: { usedTokens: 100 },
    stages: [{ id: 's1', title: '准备', status: 'running' }],
    notes: '开始',
  })
  assert.equal(running.kind, 'rewrite')
  assert.equal(running.budget.maxTokens, 200000)
  assert.equal(running.budget.usedTokens, 100)
  assert.ok(running.startedAt)
  const withNote = await store.saveRun(root, project.id, { status: 'paused', notes: '暂停一下' })
  assert.equal(withNote.notes.length, 2)
  await assert.rejects(store.saveRun(root, project.id, { status: 'bogus' }), (error) => error.code === 'bad-status')
  const reset = await store.resetRun(root, project.id)
  assert.equal(reset.status, 'idle')
  assert.equal((await store.getRun(root, project.id)).status, 'idle')

  const ledger = await store.getLedger(root, project.id)
  for (const kind of ['facts', 'characters', 'events', 'foreshadow', 'conflicts', 'locations', 'presets']) {
    assert.ok(Array.isArray(ledger[kind]), `${kind} 应为数组`)
  }
  assert.equal(typeof ledger.world, 'object')

  const fact = await store.upsertLedgerItem(root, project.id, 'facts', { id: 'f1', text: '林默是捕快' })
  assert.equal(fact.id, 'f1')
  const fact2 = await store.upsertLedgerItem(root, project.id, 'facts', { id: 'f1', text: '林默是名捕' })
  assert.equal(fact2.createdAt, fact.createdAt)
  assert.equal((await store.getLedger(root, project.id)).facts.length, 1)

  await store.upsertLedgerItem(root, project.id, 'locations', { name: '破庙' })
  await store.upsertLedgerItem(root, project.id, 'locations', { name: '破庙', detail: '城西' })
  const locations = (await store.getLedger(root, project.id)).locations
  assert.equal(locations.length, 1, '地点无 id 时按 name 对齐')
  assert.equal(locations[0].detail, '城西')

  const world = await store.upsertLedgerItem(root, project.id, 'world', { mapSize: '小城' })
  assert.equal(world.mapSize, '小城')

  const deleted = await store.deleteLedgerItem(root, project.id, 'facts', 'f1')
  assert.equal(deleted.deleted, true)
  assert.equal((await store.deleteLedgerItem(root, project.id, 'facts', 'nope')).deleted, false)

  const settings = await store.getSettings(root, project.id)
  assert.equal(settings.budget.maxTokens, 200000)
  assert.ok(settings.presets.length >= 1)
  const saved = await store.saveSettings(root, project.id, { budget: { maxTokens: 1000 }, project: { logline: '改设置' } })
  assert.equal(saved.budget.maxTokens, 1000)
  assert.equal(saved.project.logline, '改设置')
  const presets = await store.saveSettings(root, project.id, { presets: [{ id: 'p2', name: '简版' }] })
  assert.equal(presets.presets.length, 1)
  assert.equal(presets.presets[0].name, '简版')

  await writeFile(
    projectPath(root, project.id, 'usage.json'),
    JSON.stringify([
      { at: '2026-01-01T00:00:00.000Z', task: 'write', inputTokens: 10, outputTokens: 5, totalTokens: 15, costCNY: 0.01 },
      { at: '2026-01-02T00:00:00.000Z', task: 'review', inputTokens: 20, outputTokens: 0, totalTokens: 20, costCNY: 0.02 },
    ]),
  )
  const usage = await store.usageSummary(root, project.id)
  assert.equal(usage.calls, 2)
  assert.equal(usage.tokens, 35)
  assert.equal(usage.costCNY, 0.03)
  assert.equal(usage.lastAt, '2026-01-02T00:00:00.000Z')
  assert.equal(usage.byTask.write.calls, 1)
  assert.equal(usage.byTask.review.tokens, 20)
})

test('安全：非法项目 id / 不存在 / 非法章号', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '安全书' })
  await assert.rejects(store.getProject(root, '../evil'), (error) => error.code === 'bad-project-id')
  await assert.rejects(store.getProject(root, 'not-exist'), (error) => error.code === 'not-found')
  await assert.rejects(store.saveChapter(root, project.id, 0, '正文'), (error) => error.code === 'bad-chapter')
  await assert.rejects(store.getProject(root, project.id.replace(/^pm/, 'pm/../../')), (error) => error.code === 'bad-project-id')
})

test('迁移：dry-run 不写盘、running 拒绝 apply、--apply 转换且幂等', async (t) => {
  const root = await tempRoot(t)
  const dir = join(root, 'projects', 'legacy1')
  await mkdir(join(dir, 'chapters'), { recursive: true })
  await writeFile(join(dir, 'project.json'), JSON.stringify({ id: 'legacy1', name: '旧书', schemaVersion: '0.5.0' }))
  const md = ['---', 'title: "旧章"', 'status: "final"', 'characters: ["林默"]', '---', '', '这是**重点**内容', '', '第二段。'].join('\n')
  await writeFile(join(dir, 'chapters', '0001.md'), md)
  await writeFile(join(dir, 'pipeline.json'), JSON.stringify({ status: 'running' }))
  await writeFile(join(dir, 'attention.json'), JSON.stringify({ chapters: { 1: [{ chapter: 1, hook: '旧钩子', breakdown: { hook: 10 } }] } }))

  const before = await readdir(dir)
  const dry = await runMigration({ root, apply: false, log: () => {} })
  assert.equal(dry.ok, true)
  assert.equal(dry.projects[0].running.length, 1)
  assert.deepEqual(dry.projects[0].plan.chapters, [1])
  assert.equal(dry.projects[0].plan.reviews, 1)
  assert.equal(dry.projects[0].plan.attention, 'object')
  assert.deepEqual(dry.projects[0].plan.legacy, ['pipeline.json'])
  assert.deepEqual(await readdir(dir), before, 'dry-run 不得写任何文件')
  await assert.rejects(readdir(join(root, '.pre-0.6.0')))

  const blocked = await runMigration({ root, apply: true, log: () => {} })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.blocked, true)
  assert.deepEqual(await readdir(dir), before, 'running 时 apply 不得写任何文件')

  await writeFile(join(dir, 'pipeline.json'), JSON.stringify({ status: 'done' }))
  const applied = await runMigration({ root, apply: true, log: () => {} })
  assert.equal(applied.ok, true)
  const result = applied.projects[0]
  assert.equal(result.counts.chaptersConverted, 1)
  assert.equal(result.counts.reviewsAdded, 1)
  assert.equal(result.counts.attentionNormalized, 1)
  assert.equal(result.counts.legacyArchived, 1)
  assert.ok(result.counts.backup)

  const names = await readdir(join(dir, 'chapters'))
  assert.ok(names.includes('0001.txt'))
  assert.equal(names.includes('0001.md'), false)
  assert.ok(names.includes('0001.meta.json'))
  const txt = await readFile(join(dir, 'chapters', '0001.txt'), 'utf8')
  assert.ok(txt.includes('这是**重点**内容'))

  const migrated = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
  assert.equal(migrated.schemaVersion, '0.6.0')
  assert.deepEqual(migrated.readingPosition, { chapter: 1, offset: 0 })

  assert.equal((await readdir(join(root, '.pre-0.6.0'))).length, 1)
  assert.ok((await readdir(join(dir, 'legacy'))).includes('pipeline.json'))
  assert.ok((await readdir(dir)).includes('runs.json'))
  assert.ok(Array.isArray(JSON.parse(await readFile(join(dir, 'attention.json'), 'utf8'))))

  const reviews = await store.getReviews(root, 'legacy1')
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].source, 'ai-style')
  assert.ok(reviews[0].quote.includes('**重点**'))

  // 逐字校验：迁移报告 + --verify
  const reportFile = JSON.parse(await readFile(join(dir, 'migration-report.json'), 'utf8'))
  assert.equal(reportFile.ok, true)
  assert.equal(reportFile.chapters.length, 1)
  assert.equal(reportFile.chapters[0].equal, true)
  assert.equal(reportFile.chapters[0].removedMd, true)
  assert.equal(typeof reportFile.chapters[0].newSha256, 'string')
  assert.equal(reportFile.chapters[0].newSha256.length, 64)
  const verified = await verifyProject(root, 'legacy1')
  assert.equal(verified.ok, true)
  assert.equal(verified.checked, 1)

  // 改一个字 → 复核必须报出来
  await writeFile(join(dir, 'chapters', '0001.txt'), txt + '\n多出来的一段\n')
  const tampered = await verifyProject(root, 'legacy1')
  assert.equal(tampered.ok, false)
  assert.equal(tampered.mismatched.length, 1)
  await writeFile(join(dir, 'chapters', '0001.txt'), txt)

  const second = await runMigration({ root, apply: true, log: () => {} })
  assert.equal(second.ok, true)
  assert.deepEqual(second.projects[0].steps, ['无需迁移（已是 0.6.0 结构）'])
  assert.equal((await readdir(join(root, '.pre-0.6.0'))).length, 1, '幂等：不重复备份')
  assert.equal((await store.getReviews(root, 'legacy1')).length, 1, '幂等：不重复加审阅')
})

test('开新书：按预设落库章数/字数/视角/类型，并把作者想法写进简介', async (t) => {
  const root = await tempRoot(t)
  const presets = store.defaultPresets()
  const target = presets.find((row) => row.id === 'preset-suspense-cold') || presets[1]
  const project = await store.createProject(root, {
    title: '预设书',
    presetId: target.id,
    targetChapters: 30,
    wordsPerChapter: 2500,
    idea: '失忆仵作追查连环命案',
    genre: '悬疑',
  })
  assert.equal(project.activePresetId, target.id)
  assert.equal(project.targetChapters, 30)
  assert.equal(project.wordsPerChapter, 2500)
  assert.equal(project.targetWords, 75000)
  assert.equal(project.pov, target.pov)
  assert.equal(project.tense, target.tense)
  assert.equal(project.genre, '悬疑')
  assert.equal(project.logline, '失忆仵作追查连环命案')
  assert.equal(project.description, '失忆仵作追查连环命案')

  // 未知预设回退第一套；不传章数时用预设章数
  const fallback = await store.createProject(root, { title: '回退书', presetId: 'preset-does-not-exist' })
  assert.equal(fallback.activePresetId, presets[0].id)
  assert.equal(fallback.targetChapters, presets[0].plannedChapters)
})

test('自定义方案：批准「预设」修订提案后自动套用到作品', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '自定义书', idea: '失忆仵作追凶' })
  const proposal = await store.createProposal(root, project.id, {
    kind: 'ledger-fix',
    title: 'AI 自定义方案',
    summary: '按作者想法定的方案',
    data: {
      ledgerFixes: [{
        kind: 'presets',
        patch: {
          id: 'preset-ai-custom',
          name: 'AI 自定义方案',
          desc: '悬疑 · 冷峻',
          genre: '悬疑',
          tone: '冷峻',
          pov: '第三人称限知',
          tense: '过去时',
          plannedChapters: 24,
          chapterWords: 2200,
          totalWords: 52800,
          styleRules: ['短句为主', '不写内心独白'],
          attentionPlan: {
            principle: 'ATTENTION IS ALL YOU NEED',
            targetAvg: 82,
            openingHooks: '前三章各留一个未解问题，第一章 300 字内出现尸体与错判。',
            mainTypeRotation: ['mystery', 'event', 'emotion', 'mystery', 'relationship'],
            payoffCadence: '每 3 章一次小兑现，第 12 章大兑现。',
            cliffRule: '每章末留一个具体未决问题，不用总结句收尾。',
            fatigueRule: '同类型不连续超过 2 章。',
          },
        },
      }],
    },
  })
  const accepted = await store.acceptProposal(root, project.id, proposal.id)
  assert.equal(accepted.ok, true)
  const after = await store.getProject(root, project.id)
  assert.equal(after.activePresetId, 'preset-ai-custom')
  assert.equal(after.targetChapters, 24)
  assert.equal(after.targetWords, 52800)
  assert.equal(after.pov, '第三人称限知')
  assert.equal(after.tense, '过去时')
  assert.equal(after.genre, '悬疑')
  assert.equal(after.style, '短句为主；不写内心独白')
  const presets = await store.getContext(root, project.id)
  const saved = (presets.presets ?? []).find((row) => row.id === 'preset-ai-custom')
  assert.ok(saved, '预设写进 presets.json')
})

test('删除章节：正文/元数据/审阅/注意力清掉，已采纳提案留历史', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '删除书' })
  await store.saveChapter(root, project.id, 1, '第一章正文。', { title: '第一章' })
  await store.saveChapter(root, project.id, 2, '第二章正文。', { title: '第二章' })
  await store.saveChapter(root, project.id, 3, '第三章正文。', { title: '第三章' })
  await store.addReviews(root, project.id, [
    { chapter: 2, source: 'logic', quote: '第二章正文', issue: '这句有问题', severity: 'minor' },
    { chapter: 1, source: 'logic', quote: '第一章正文', issue: '这句也有问题', severity: 'minor' },
  ])
  await store.mergeAttention(root, project.id, 2, { design: { summary: '第二章设计' } })
  const pending = await store.createProposal(root, project.id, { kind: 'rewrite-chapter', chapter: 2, title: '改写第二章', data: { content: '新的第二章正文。' } })
  const accepted = await store.createProposal(root, project.id, { kind: 'ledger-fix', chapter: null, title: '账本修订', data: { ledgerFixes: [{ kind: 'facts', patch: { text: '元末，泉州。' } }] } })
  const acceptedOutcome = await store.acceptProposal(root, project.id, accepted.id)
  assert.equal(acceptedOutcome.ok, true, JSON.stringify(acceptedOutcome))

  const outcome = await store.deleteChapter(root, project.id, 2)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.chapter, 2)
  assert.equal(outcome.title, '第二章')
  assert.equal(outcome.removed.text, true)
  assert.equal(outcome.removed.reviews, 1)
  assert.equal(outcome.removed.attention, 1)
  assert.equal(outcome.removed.proposals, 1)

  await assert.rejects(() => store.readChapter(root, project.id, 2), /章节不存在/)
  const toc = await store.listChapters(root, project.id)
  assert.deepEqual(toc.map((row) => Number(row.chapter)), [1, 3])
  const reviews = await store.getReviews(root, project.id)
  assert.equal(reviews.length, 1)
  assert.equal(Number(reviews[0].chapter), 1)
  const attention = await store.getAttention(root, project.id)
  // 0.6.4 起：saveChapter 正文变化会给该章打 recheckPending（复测信号），删除章节只清被删章
  assert.equal(attention.some((row) => Number(row.chapter) === 2), false, '被删章节的注意力记录要清掉')
  const survivors = attention.filter((row) => [1, 3].includes(Number(row.chapter)))
  assert.deepEqual(survivors.map((row) => Number(row.chapter)).sort(), [1, 3])
  assert.ok(survivors.every((row) => row.recheckPending === true), '存活章保留正文变化后的待复测标记')
  const proposals = await store.listProposals(root, project.id, { all: true })
  assert.equal(proposals.some((row) => row.id === pending.id), false, '本章 pending 提案应随章节删除')
  assert.equal(proposals.some((row) => row.id === accepted.id), true, '已采纳提案要留作历史')
  // 已采纳的账本修订还在
  const ledger = await store.getLedger(root, project.id)
  assert.equal(ledger.facts.some((row) => String(row.text).includes('元末')), true)

  await assert.rejects(() => store.deleteChapter(root, project.id, 99), /章节不存在/)
})

// ── 账本同步：正文改动的待核对信号 ──────────────────────────

test('账本同步信号：账本里的名字从正文里消失才记 pending，同一章不重复，核对后清空', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '信号书' })
  await store.upsertLedgerItem(root, project.id, 'characters', { name: '林默' })

  const signal = await store.noteChapterChange(root, project.id, 1, '林默推开门，屋里没有人。', '门开着，屋里没有人。')
  assert.ok(signal, '名字消失必须产生信号')
  assert.ok(signal.reasons.some((reason) => reason.includes('林默')), JSON.stringify(signal.reasons))

  const status = await store.getLedgerSync(root, project.id)
  assert.equal(status.pending.length, 1)
  assert.equal(status.pending[0].chapter, 1)
  assert.equal(status.full, null)
  assert.equal(status.chapters, 0, '还没有正文章节')

  // 同一章再改一次：只更新不重复
  await store.noteChapterChange(root, project.id, 1, '林默站在门口。', '门开着。')
  assert.equal((await store.getLedgerSync(root, project.id)).pending.length, 1)

  // 没碰到账本内容就不打扰作者
  assert.equal(await store.noteChapterChange(root, project.id, 7, '天亮了下雨。', '天亮了，雨停了。'), null)
  assert.equal((await store.getLedgerSync(root, project.id)).pending.length, 1)

  const acked = await store.ackLedgerSync(root, project.id)
  assert.equal(acked.cleared, 1)
  assert.equal((await store.getLedgerSync(root, project.id)).pending.length, 0)
})

// ── 全书账本同步：分批计划 / 进度 / 重建 / 清除 ──────────────

test('全书同步：按范围切批、记进度、重建保留已完成批、清除计划', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '全书同步书' })
  for (let n = 1; n <= 5; n += 1) {
    await store.saveChapter(root, project.id, n, `第${n}章正文，写了一点事。`, { title: `第${n}章` })
  }

  const plan = await store.planLedgerSync(root, project.id, { batchSize: 2 })
  assert.equal(plan.chapters, 5)
  assert.equal(plan.full.from, 1)
  assert.equal(plan.full.to, 5)
  assert.equal(plan.full.batchSize, 2)
  assert.equal(plan.full.total, 3)
  assert.equal(plan.full.done, 0)
  assert.deepEqual(plan.full.batches.map((batch) => batch.chapters), [[1, 2], [3, 4], [5]])
  assert.deepEqual(plan.full.batches.map((batch) => [batch.from, batch.to]), [[1, 2], [3, 4], [5, 5]])
  assert.ok(plan.full.batches[0].words > 0, '批次要带字数')
  assert.deepEqual(plan.full.uncovered, [])

  // 默认完成第一个未完成批；也可以显式指定
  const firstDone = await store.completeLedgerSyncBatch(root, project.id)
  assert.equal(firstDone.full.done, 1)
  assert.equal(firstDone.full.batches[0].status, 'done')
  assert.ok(firstDone.full.batches[0].doneAt)
  const secondDone = await store.completeLedgerSyncBatch(root, project.id, { batch: 2 })
  assert.equal(secondDone.full.done, 2)
  assert.equal(secondDone.full.batches[1].status, 'done')

  // 重建计划（每批章数不变）：已完成批按「章号完全相同」复用，进度不倒退
  const replanned = await store.planLedgerSync(root, project.id, { batchSize: 2 })
  assert.equal(replanned.full.done, 2)

  // 改每批章数：批次变了，进度重来
  const resized = await store.planLedgerSync(root, project.id, { batchSize: 4 })
  assert.equal(resized.full.total, 2)
  assert.equal(resized.full.done, 0)

  // 只同步一段范围
  const ranged = await store.planLedgerSync(root, project.id, { from: 3, to: 5, batchSize: 2 })
  assert.deepEqual(ranged.full.batches.map((batch) => batch.chapters), [[3, 4], [5]])
  assert.equal(ranged.full.done, 0)

  // 建计划之后新写的章不在任何批次里：报成 uncovered
  await store.saveChapter(root, project.id, 6, '第六章正文，新写的。', { title: '第六章' })
  const withNew = await store.getLedgerSync(root, project.id)
  assert.deepEqual(withNew.full.uncovered, [6])

  // 全部完成后没有待同步批
  await store.completeLedgerSyncBatch(root, project.id, { batch: 1 })
  const allDone = await store.completeLedgerSyncBatch(root, project.id, { batch: 2 })
  assert.equal(allDone.full.done, 2)
  await assert.rejects(
    store.completeLedgerSyncBatch(root, project.id, { batch: 3 }),
    (error) => error.code === 'invalid' && /没有待同步的批次/.test(error.message),
  )

  // 清除计划：待核对信号保留，计划没了
  await store.noteChapterChange(root, project.id, 3, '第3章正文里有人。', '换成了别人。')
  const reset = await store.resetLedgerSync(root, project.id)
  assert.equal(reset.full, null)
  assert.equal(reset.pending.length, 1)
})

test('全书同步：待核对信号与全书计划互不覆盖，完成批次会连带清掉这批章的信号', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '共存书' })
  await store.upsertLedgerItem(root, project.id, 'characters', { name: '沈怀瑾' })
  for (let n = 1; n <= 3; n += 1) {
    await store.saveChapter(root, project.id, n, `第${n}章，沈怀瑾出场。`, { title: `第${n}章` })
  }
  await store.planLedgerSync(root, project.id, { batchSize: 2 })

  // 计划建立后再改正文：pending 写入，但不能把 full 冲掉
  await store.noteChapterChange(root, project.id, 1, '沈怀瑾出场。', '门开了。')
  const kept = await store.getLedgerSync(root, project.id)
  assert.ok(kept.full, '改动信号不能覆盖全书计划')
  assert.equal(kept.pending.length, 1)

  // 完成这批（第 1–2 章）：这批的待核对信号一起清掉，计划还在
  const done = await store.completeLedgerSyncBatch(root, project.id)
  assert.equal(done.pending.length, 0)
  assert.equal(done.full.done, 1)

  // ack 不影响计划
  const acked = await store.ackLedgerSync(root, project.id)
  assert.equal(acked.pending.length, 0)
  assert.ok((await store.getLedgerSync(root, project.id)).full)
})

test('全书同步：没有正文 / 范围越界 / 没有计划都要报清楚', async (t) => {
  const root = await tempRoot(t)
  const empty = await store.createProject(root, { title: '空书' })
  await assert.rejects(store.planLedgerSync(root, empty.id), /还没有正文章节/)
  await assert.rejects(store.completeLedgerSyncBatch(root, empty.id), /还没有全书同步计划/)

  const project = await store.createProject(root, { title: '一本正经书' })
  for (let n = 1; n <= 3; n += 1) {
    await store.saveChapter(root, project.id, n, `第${n}章正文。`, { title: `第${n}章` })
  }
  await assert.rejects(
    store.planLedgerSync(root, project.id, { from: 90, to: 99 }),
    (error) => error.code === 'invalid' && /还没有正文/.test(error.message),
  )
  // 每批章数会被夹到 1..20
  const clamped = await store.planLedgerSync(root, project.id, { batchSize: 99 })
  assert.equal(clamped.full.batchSize, 20)
})

// ── 0.6.4：book-fix 全书修改提案 / updateProposal / 审阅去重 / 空备份 ──

const bookFixChapters = async (root, projectId) => {
  await store.saveChapter(root, projectId, 1, '雨从黄昏就开始下。林默推开门，屋里没有人。', { title: '第一章' })
  await store.saveChapter(root, projectId, 2, '城门在夜里开了。林默回头看了一眼。', { title: '第二章' })
}

const globalReview = async (root, projectId) => {
  await store.addReviews(root, projectId, [
    { chapter: 0, source: 'logic', quote: '全书时间线', issue: '全书时间线错位', severity: 'major', suggestion: '统一口径' },
  ])
  const reviews = await store.getReviews(root, projectId)
  return reviews.find((row) => String(row.status) === 'open' || String(row.status) === 'proposed') ?? reviews[0]
}

const bookFixProposal = async (root, projectId, reviewId, extra = {}) => store.createProposal(root, projectId, {
  kind: 'book-fix',
  chapter: 0,
  title: '全局修改：统一时间线',
  data: {
    opinion: '全书统一成「午后下雨、傍晚开城门」的时间线口径',
    patches: [
      { chapter: 1, before: '雨从黄昏就开始下。', after: '雨从午后就开始下。', why: '统一时间线', reviewIds: [reviewId] },
      { chapter: 2, before: '城门在夜里开了。', after: '城门在傍晚开了。', why: '统一时间线', reviewIds: [reviewId] },
    ],
    ...extra,
  },
})

const gateStub = (written, overrides = {}) => async ({ root: r, projectId, chapter, text }) => {
  written.push(chapter)
  const result = overrides[chapter]
  if (result) return result
  return { ok: true, chapter: await store.saveChapter(r, projectId, chapter, text, { title: `第${chapter}章` }), gates: {} }
}

test('book-fix 创建：chapter 强制 0、记录每章 baseHashes、关联审阅转 proposed', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '全书修改书' })
  await bookFixChapters(root, project.id)
  const review = await globalReview(root, project.id)
  assert.equal(review.status, 'open')

  const proposal = await bookFixProposal(root, project.id, review.id)
  assert.equal(proposal.kind, 'book-fix')
  assert.equal(Number(proposal.chapter), 0)
  assert.equal(proposal.status, 'pending')
  assert.deepEqual(Object.keys(proposal.data.baseHashes).sort(), ['1', '2'])
  const hash1 = (await store.readChapter(root, project.id, 1)).meta.contentHash
  assert.equal(proposal.data.baseHashes['1'], hash1, 'baseHash 必须记录生成时正文指纹')

  const reviews = await store.getReviews(root, project.id)
  const stored = reviews.find((row) => String(row.id) === String(review.id))
  assert.equal(stored.status, 'proposed', '提案提交后关联审阅进入 proposed')
  assert.equal(String(stored.proposalId), String(proposal.id))
})

test('book-fix 创建：chapter 非 0、缺 opinion / patches、before 太短都拒绝', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '校验书' })
  await bookFixChapters(root, project.id)
  const base = {
    kind: 'book-fix',
    title: '全局修改',
    data: { opinion: '统一口径', patches: [{ chapter: 1, before: '雨从黄昏就开始下。', after: '雨从午后就开始下。' }] },
  }
  await assert.rejects(
    () => store.createProposal(root, project.id, { ...base, chapter: 1 }),
    /book-fix 是全书级提案，chapter 必须为 0/,
  )
  await assert.rejects(
    () => store.createProposal(root, project.id, { ...base, chapter: 0, data: { ...base.data, opinion: '   ' } }),
    /opinion 不能为空/,
  )
  await assert.rejects(
    () => store.createProposal(root, project.id, { ...base, chapter: 0, data: { ...base.data, patches: [] } }),
    /patches 不能为空/,
  )
  await assert.rejects(
    () => store.createProposal(root, project.id, { ...base, chapter: 0, data: { ...base.data, patches: [{ chapter: 1, before: '雨从', after: '雨从午后。' }] } }),
    /before 至少 4 字/,
  )
  await assert.rejects(
    () => store.createProposal(root, project.id, { ...base, chapter: 0, data: { ...base.data, patches: [{ chapter: 1, before: '雨从黄昏就开始下。', after: 42 }] } }),
    /after 必须是字符串/,
  )
})

test('book-fix 采纳：跨章补丁过闸门写盘，审阅 fixed、提案 accepted', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '跨章采纳书' })
  await bookFixChapters(root, project.id)
  const review = await globalReview(root, project.id)
  const proposal = await bookFixProposal(root, project.id, review.id)

  const written = []
  const outcome = await store.acceptProposal(root, project.id, proposal.id, { writeGates: gateStub(written) })
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.deepEqual([...outcome.chapters].sort((a, b) => a - b), [1, 2])
  assert.deepEqual([...written].sort((a, b) => a - b), [1, 2], '两章都要过闸门写盘')

  assert.match((await store.readChapter(root, project.id, 1)).text, /雨从午后就开始下/)
  assert.match((await store.readChapter(root, project.id, 2)).text, /城门在傍晚开了/)
  const stored = await store.getProposal(root, project.id, proposal.id)
  assert.equal(stored.status, 'accepted')
  assert.deepEqual([...stored.appliedChapters].sort((a, b) => a - b), [1, 2])
  assert.ok(stored.decidedAt)
  const reviews = await store.getReviews(root, project.id)
  assert.equal(reviews.find((row) => String(row.id) === String(review.id)).status, 'fixed')
})

test('book-fix 采纳：生成后正文又改过、但补丁仍能唯一定位 → 照常采纳（支持逐条批准后续提案）', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '继续采纳书' })
  await bookFixChapters(root, project.id)
  const review = await globalReview(root, project.id)
  const proposal = await bookFixProposal(root, project.id, review.id)

  // 生成提案后作者改了第 2 章别处，但补丁 before 仍然唯一 → 不应再一律 stale
  await store.saveChapter(root, project.id, 2, '城门在夜里开了。林默回头看了很久。', { title: '第二章' })
  const written = []
  const outcome = await store.acceptProposal(root, project.id, proposal.id, { writeGates: gateStub(written) })
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.deepEqual([...written].sort((a, b) => a - b), [1, 2])
  assert.match((await store.readChapter(root, project.id, 2)).text, /城门在傍晚开了/)
  assert.match((await store.readChapter(root, project.id, 2)).text, /林默回头看了很久/, '别处改动保留')
  assert.equal((await store.getProposal(root, project.id, proposal.id)).status, 'accepted')
})

test('book-fix 采纳：补丁原文在改动后的正文里找不到 → needs-fix，一章都不写', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '找不到原文书' })
  await bookFixChapters(root, project.id)
  const review = await globalReview(root, project.id)
  const proposal = await bookFixProposal(root, project.id, review.id)

  // 第 2 章的补丁 before 被作者改掉了 → 无法定位
  await store.saveChapter(root, project.id, 2, '城门已经关了。林默回头看了一眼。', { title: '第二章' })
  const written = []
  const outcome = await store.acceptProposal(root, project.id, proposal.id, { writeGates: gateStub(written) })
  assert.equal(outcome.ok, false)
  assert.match(String((outcome.failures ?? []).join('')), /找不到补丁原文/)
  assert.equal(written.length, 0, '定位失败时一章都不能写')
  assert.equal((await store.getProposal(root, project.id, proposal.id)).status, 'needs-fix')
  assert.equal((await store.readChapter(root, project.id, 1)).text.includes('午后'), false)
})

test('book-fix 逐条批准：两条提案改同一章不同补丁，先后采纳都成功（不再因前一条改过而 stale）', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '逐条批准书' })
  await store.saveChapter(root, project.id, 1, '雨从黄昏就开始下。林默推开门。', { title: '第一章' })
  const review = await globalReview(root, project.id)
  const first = await store.createProposal(root, project.id, {
    kind: 'book-fix',
    chapter: 0,
    title: '全局修改 1/2：雨的时辰',
    data: { opinion: '统一下雨时间', patches: [{ chapter: 1, before: '雨从黄昏就开始下。', after: '雨从午后就开始下。', reviewIds: [review.id] }] },
  })
  const second = await store.createProposal(root, project.id, {
    kind: 'book-fix',
    chapter: 0,
    title: '全局修改 2/2：开门动作',
    data: { opinion: '开门写成进屋', patches: [{ chapter: 1, before: '林默推开门。', after: '林默推门进去。', reviewIds: [review.id] }] },
  })
  const written = []
  const a = await store.acceptProposal(root, project.id, first.id, { writeGates: gateStub(written) })
  assert.equal(a.ok, true, JSON.stringify(a))
  // 第一条采纳后正文已变，但第二条补丁的 before 仍唯一可定位 → 必须还能采纳
  const b = await store.acceptProposal(root, project.id, second.id, { writeGates: gateStub(written) })
  assert.equal(b.ok, true, JSON.stringify(b))
  const text = (await store.readChapter(root, project.id, 1)).text
  assert.match(text, /雨从午后就开始下/)
  assert.match(text, /林默推门进去/)
  assert.equal((await store.getProposal(root, project.id, first.id)).status, 'accepted')
  assert.equal((await store.getProposal(root, project.id, second.id)).status, 'accepted')
})

test('book-fix 采纳：重复引文无法唯一定位 → needs-fix，正文不动', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '歧义书' })
  await store.saveChapter(root, project.id, 1, '雨从黄昏就开始下。\n\n林默推开门。\n\n雨从黄昏就开始下。', { title: '第一章' })
  const review = await globalReview(root, project.id)
  const proposal = await store.createProposal(root, project.id, {
    kind: 'book-fix',
    chapter: 0,
    title: '全局修改：重复引文',
    data: {
      opinion: '统一雨的时间',
      patches: [{ chapter: 1, before: '雨从黄昏就开始下。', after: '雨从午后就开始下。', reviewIds: [review.id] }],
    },
  })

  const written = []
  const outcome = await store.acceptProposal(root, project.id, proposal.id, { writeGates: gateStub(written) })
  assert.equal(outcome.ok, false)
  assert.match(String((outcome.failures ?? []).join('')), /出现 2 次，无法唯一定位/)
  assert.equal(written.length, 0)
  const stored = await store.getProposal(root, project.id, proposal.id)
  assert.equal(stored.status, 'needs-fix')
  assert.ok(Array.isArray(stored.gates?.failures) && stored.gates.failures.length > 0)
  const text = (await store.readChapter(root, project.id, 1)).text
  assert.equal(text.includes('午后'), false)
  assert.equal((text.match(/雨从黄昏就开始下。/g) ?? []).length, 2, '失败时正文原样保留')
})

test('updateProposal：needs-fix 改 data 回 pending、重算 baseHashes、保留 reviewIds，再采纳成功', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '修订提案书' })
  await store.saveChapter(root, project.id, 1, '雨从黄昏就开始下。\n\n林默推开门。\n\n雨从黄昏就开始下。', { title: '第一章' })
  const review = await globalReview(root, project.id)
  const proposal = await store.createProposal(root, project.id, {
    kind: 'book-fix',
    chapter: 0,
    title: '全局修改：重复引文',
    data: {
      opinion: '统一雨的时间',
      patches: [{ chapter: 1, before: '雨从黄昏就开始下。', after: '雨从午后就开始下。', reviewIds: [review.id] }],
    },
  })
  const failed = await store.acceptProposal(root, project.id, proposal.id, { writeGates: gateStub([]) })
  assert.equal(failed.ok, false)
  assert.equal((await store.getProposal(root, project.id, proposal.id)).status, 'needs-fix')

  const updated = await store.updateProposal(root, project.id, proposal.id, {
    title: '全局修改：改成唯一一句',
    data: {
      opinion: '只改第一处雨的时间，第二处保留',
      patches: [{ chapter: 1, before: '林默推开门。', after: '林默推开门，屋里没有人。', reviewIds: [review.id] }],
    },
  })
  assert.equal(updated.status, 'pending', 'needs-fix 修改后回 pending 重新等采纳')
  assert.equal(updated.title, '全局修改：改成唯一一句')
  assert.deepEqual(updated.data.baseHashes, { 1: (await store.readChapter(root, project.id, 1)).meta.contentHash }, '改 data 后重算 baseHashes')
  assert.equal(updated.gates?.failures, undefined, '修改后清掉旧失败项')
  assert.deepEqual(updated.reviewIds, [], '顶层 reviewIds 保留（此处为空）')
  assert.equal(updated.data.patches[0].reviewIds[0], review.id, 'patch 上的 reviewIds 必须保留')

  const written = []
  const outcome = await store.acceptProposal(root, project.id, proposal.id, { writeGates: gateStub(written) })
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.match((await store.readChapter(root, project.id, 1)).text, /林默推开门，屋里没有人。/)
  const reviews = await store.getReviews(root, project.id)
  assert.equal(reviews.find((row) => String(row.id) === String(review.id)).status, 'fixed')
})

test('updateProposal：只有 pending/needs-fix 能改；正文变了重算非全书提案的 baseHash', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '提案编辑书' })
  await store.saveChapter(root, project.id, 1, '雨从黄昏就开始下。林默推开门。', { title: '第一章' })
  const proposal = await store.createProposal(root, project.id, {
    kind: 'patch-paragraph',
    chapter: 1,
    title: '段落补丁',
    data: { patches: [{ before: '雨从黄昏就开始下。', after: '雨从午后就开始下。' }] },
  })
  const oldHash = proposal.baseHash
  await store.saveChapter(root, project.id, 1, '雨从黄昏就开始下。林默推开门，屋里没有人。', { title: '第一章' })

  const updated = await store.updateProposal(root, project.id, proposal.id, {
    data: { patches: [{ before: '林默推开门，屋里没有人。', after: '林默推开门，屋里空无一人。' }] },
  })
  assert.equal(updated.status, 'pending')
  assert.notEqual(updated.baseHash, oldHash, '正文已变，编辑提案时必须重算 baseHash')
  assert.equal(updated.baseHash, (await store.readChapter(root, project.id, 1)).meta.contentHash)

  // 已采纳的不能改
  await store.acceptProposal(root, project.id, proposal.id, { writeGates: gateStub([]) })
  await assert.rejects(
    () => store.updateProposal(root, project.id, proposal.id, { title: '再改' }),
    /提案已处理：accepted，不能修改/,
  )
  await assert.rejects(
    () => store.updateProposal(root, project.id, proposal.id, { title: '   ' }),
    /提案已处理：accepted/,
  )
})

test('rejectProposal：book-fix 被驳回后关联审阅回到 open', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '驳回书' })
  await bookFixChapters(root, project.id)
  const review = await globalReview(root, project.id)
  const proposal = await bookFixProposal(root, project.id, review.id)
  assert.equal((await store.getReviews(root, project.id)).find((row) => String(row.id) === String(review.id)).status, 'proposed')

  const rejected = await store.rejectProposal(root, project.id, proposal.id, '不改了')
  assert.equal(rejected.ok, true)
  assert.equal(rejected.proposal.status, 'rejected')
  const back = (await store.getReviews(root, project.id)).find((row) => String(row.id) === String(review.id))
  assert.equal(back.status, 'open', '驳回提案要让审阅回到待处理')
  assert.equal(back.fixedAt, null)
})

test('addReviews：未处理时重复提交跳过；fixed/wontfix 后允许重新提交同一引文', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '去重书' })
  await store.saveChapter(root, project.id, 1, '雨从黄昏就开始下。林默推开门，屋里没有人。', { title: '第一章' })
  const item = { chapter: 1, source: 'logic', quote: '雨从黄昏就开始下', issue: '动机跳跃', severity: 'major' }
  const first = await store.addReviews(root, project.id, [item])
  assert.equal(first.added, 1)
  const second = await store.addReviews(root, project.id, [item])
  assert.equal(second.added, 0)
  assert.equal(second.skipped, 1, '同一章+来源+引文+问题且仍未处理 → 跳过')
  const again = await store.addReviews(root, project.id, [{ ...item, issue: '换个说法但不放行同一条' }])
  assert.equal(again.added, 0, '归一后同一引文+同一问题仍算重复')

  const review = (await store.getReviews(root, project.id))[0]
  await store.patchReviews(root, project.id, [review.id], { status: 'fixed' })
  const retry = await store.addReviews(root, project.id, [item])
  assert.equal(retry.added, 1, '旧条目已 fixed，同一条意见可以重新提')

  await store.patchReviews(root, project.id, [(await store.getReviews(root, project.id)).find((row) => String(row.id) !== String(review.id)).id], { status: 'wontfix' })
  const third = await store.addReviews(root, project.id, [item])
  assert.equal(third.added, 1, 'wontfix 也放行重新提交')
})

test('addReviews：同一引文在正文出现 2 次 → skipped，原因写明无法唯一定位', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '唯一引文书' })
  await store.saveChapter(root, project.id, 1, '屋里没有人。林默推开门。\n\n屋里没有人。', { title: '第一章' })
  const result = await store.addReviews(root, project.id, [
    { chapter: 1, source: 'logic', quote: '屋里没有人。', issue: '重复句', severity: 'minor' },
    { chapter: 1, source: 'logic', quote: '林默推开门', issue: '动作太快', severity: 'minor' },
  ])
  assert.equal(result.added, 1, '唯一引文照常写入')
  assert.equal(result.skipped, 1)
  assert.ok(Array.isArray(result.skippedReasons) && result.skippedReasons.length >= 1)
  assert.match(result.skippedReasons[0], /该引文在第1章出现2次，无法唯一定位/)
  const reviews = await store.getReviews(root, project.id)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].quote, '林默推开门')
})

test('saveChapter 空正文：不产生 0 字节备份；正文变化才备份旧稿', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '备份书' })
  const backupsOf = async (chapter) => {
    try {
      return await readdir(projectPath(root, project.id, '.backups', String(chapter).padStart(4, '0')))
    } catch {
      return []
    }
  }
  // 新建空章（chapter.save 允许 create 时空正文）不备份
  const created = await store.saveChapter(root, project.id, 1, '   ', {}, { allowEmpty: true })
  assert.equal(created.backup, null)
  assert.deepEqual(await backupsOf(1), [])
  // 空正文再存一次也不备份
  const emptyAgain = await store.saveChapter(root, project.id, 1, '', {}, { allowEmpty: true })
  assert.equal(emptyAgain.backup, null)
  assert.deepEqual(await backupsOf(1), [], '空正文不能产生 0 字节备份')
  // 空 → 有正文：旧稿是空的，不备份
  const filled = await store.saveChapter(root, project.id, 1, '第一章正文。', { title: '第一章' })
  assert.equal(filled.backup, null)
  assert.deepEqual(await backupsOf(1), [])
  // 有正文 → 改正文：备份旧稿，且文件非 0 字节
  const changed = await store.saveChapter(root, project.id, 1, '第一章改写后的正文。')
  assert.ok(changed.backup, '正文发生变化必须备份旧稿')
  const files = await backupsOf(1)
  assert.ok(files.length >= 1)
  for (const file of files) {
    const stat = await (await import('node:fs/promises')).stat(projectPath(root, project.id, '.backups', '0001', file))
    assert.ok(stat.size > 0, `备份不能是 0 字节：${file}`)
  }
  // 正文没变：不重复备份
  const same = await store.saveChapter(root, project.id, 1, '第一章改写后的正文。')
  assert.equal(same.backup, null)
})

test('saveChapter 正文变化：该章 attention.recheckPending=true，复测合并后清除', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '复测信号书' })
  const pendingOf = async (chapter) => {
    const attention = await store.getAttention(root, project.id)
    const row = attention.find((item) => Number(item.chapter) === chapter)
    return row ? row.recheckPending : undefined
  }
  await store.saveChapter(root, project.id, 1, '第一章正文。', { title: '第一章' })
  assert.equal(await pendingOf(1), true, '落正文后该章应进复测队列')
  // 同样正文再存：内容和指纹不变，不制造新的待复测
  await store.saveChapter(root, project.id, 1, '第一章正文。')
  assert.equal(await pendingOf(1), true)
  // 合并复测结果（分数变化）后清掉标记
  await store.mergeAttention(root, project.id, 1, { score: 82, breakdown: { hook: 20, tension: 21, payoff: 22, cliff: 19 }, source: 'recheck' })
  assert.equal(await pendingOf(1), false, '复测合并后清掉 recheckPending')
  // 再改正文 → 重新进队列
  await store.saveChapter(root, project.id, 1, '第一章改写正文。')
  assert.equal(await pendingOf(1), true, '再次改正文要重新打复测标记')
  assert.equal((await store.getAttention(root, project.id)).length, 1, '不因保存正文造出重复注意力条目')
})
