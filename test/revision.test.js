/**
 * 全文改动的分层契约：L1 语域 / L2 侧写 / L3 语义（价值观）/ L4 结构。
 * 重点验证四个判断：
 *  1) 文风改动可批量并行，契约简单；
 *  2) 价值观改动必须先有「价值变更书」，否则拒绝；
 *  3) 价值观改动的批次规划是「先设定层、再逐章级联」，且逐章停；
 *  4) L4 不属于本引擎。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REVISION_TIERS,
  findRevisionTier,
  validateRevisionContract,
  planRevisionBatches,
  revisionGatePolicy,
  impactMap,
  describeRevisionTier,
  composeTiers,
  normalizeTierIds,
} from '../lib/revision.js'

const chapters = ['0001', '0002', '0003', '0004']

test('分层：四层齐全，L1 低风险可自动，L3 高风险逐章', () => {
  assert.deepEqual(REVISION_TIERS.map((t) => t.id), ['L1', 'L2', 'L3', 'L4'])
  const l1 = findRevisionTier('l1')
  assert.equal(l1.risk, 'low')
  assert.equal(l1.dependency, 'per-chapter')
  const l3 = findRevisionTier('L3')
  assert.equal(l3.risk, 'high')
  assert.equal(l3.dependency, 'global-first')
  assert.match(l3.notes, /全局约束/)
})

test('L1 文风改动：只要章节 + 目标就能成立，不需要价值变更书', () => {
  const result = validateRevisionContract({ tier: 'L1', chapters, goal: '叙述改回文白相间' })
  assert.equal(result.ok, true, result.errors.join('；'))
})

test('L1 缺章节或缺目标时拒绝', () => {
  assert.equal(validateRevisionContract({ tier: 'L1', chapters: [], goal: 'x' }).ok, false)
  assert.equal(validateRevisionContract({ tier: 'L1', chapters, goal: '  ' }).ok, false)
})

test('L3 价值观改动：没有价值变更书必须拒绝', () => {
  const noCharter = validateRevisionContract({ tier: 'L3', chapters, goal: '主角不再复仇' })
  assert.equal(noCharter.ok, false)
  assert.ok(noCharter.errors.some((e) => /旧立场/.test(e)))

  const partial = validateRevisionContract({
    tier: 'L3', chapters, goal: '主角不再复仇',
    charter: { oldValue: '复仇到底', newValue: '复仇到底', affectedCharacters: ['华羽生'] },
  })
  assert.equal(partial.ok, false)
  assert.ok(partial.errors.some((e) => /无意义/.test(e)))

  const noChars = validateRevisionContract({
    tier: 'L3', chapters, goal: '主角不再复仇',
    charter: { oldValue: '复仇到底', newValue: '放下仇恨', affectedCharacters: [] },
  })
  assert.equal(noChars.ok, false)
  assert.ok(noChars.errors.some((e) => /受影响人物/.test(e)))
})

test('L3 合格契约：四要素齐备才通过', () => {
  const result = validateRevisionContract({
    tier: 'L3', chapters, goal: '把复仇改成为生民请命',
    charter: { oldValue: '为父报仇', newValue: '为生民立命', affectedCharacters: ['华羽生', '柳含烟'] },
  })
  assert.equal(result.ok, true, result.errors.join('；'))
})

test('L4 结构层：本引擎一律拒绝，指向大纲闸门', () => {
  const result = validateRevisionContract({ tier: 'L4', chapters, goal: '改结局' })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => /大纲闸门/.test(e)))
})

test('批次：L1 按 batchSize 切批且并行；L3 先设定层再逐章、每批都停', () => {
  const l1 = planRevisionBatches({ tier: 'L1', chapters, goal: '改文风' }, { batchSize: 2 })
  assert.equal(l1.length, 2)
  assert.deepEqual(l1[0].chapters, ['0001', '0002'])
  assert.equal(l1[0].parallel, true)
  assert.equal(l1[0].requiresAuthorConfirm, true, '第一批即样张，需要确认')
  assert.equal(l1[1].requiresAuthorConfirm, false, '样张确认后其余可自动')

  const l3 = planRevisionBatches({
    tier: 'L3', chapters, goal: '改价值观',
    charter: { oldValue: 'a', newValue: 'b', affectedCharacters: ['华羽生'] },
  })
  assert.equal(l3[0].kind, 'settings')
  assert.equal(l3.length, chapters.length + 1)
  assert.ok(l3.slice(1).every((batch) => batch.requiresAuthorConfirm && batch.parallel === false))
})

test('批次：一次全改 + 一路跑到底 = 1 批且不停', () => {
  const all = planRevisionBatches({ tier: 'L1', chapters, goal: '改文风', batchSize: 'all', stopMode: 'run-to-end' }, { batchSize: 'all' })
  assert.equal(all.length, 1, '一次全改只应规划 1 个批次')
  assert.deepEqual(all[0].chapters, chapters)
  assert.equal(all[0].requiresAuthorConfirm, false, '一路跑到底不应要求逐批确认')

  const fixOnly = planRevisionBatches({ tiers: ['L1', 'L2'], chapters, goal: 'x', stopMode: 'fix-only' }, { batchSize: 2 })
  assert.ok(fixOnly.every((batch) => batch.requiresAuthorConfirm === false), '只在出问题时停：批次不必逐批停')

  // 显式选「每批停」时，连 L1 也不再走「只停样张」的默认
  const perBatch = planRevisionBatches({ tier: 'L1', chapters, goal: 'x', stopMode: 'per-batch' }, { batchSize: 2 })
  assert.ok(perBatch.every((batch) => batch.requiresAuthorConfirm), '作者选每批停，L1 也要每批停')
})

test('批次：L3 的批次大小与停顿同样由作者选（逐章 / 5 章 / 整本一批；每批停 / 跑到底）', () => {
  const charter = { oldValue: 'a', newValue: 'b', affectedCharacters: ['华羽生'] }
  const runToEnd = planRevisionBatches(
    { tier: 'L3', chapters, goal: '改价值观', stopMode: 'run-to-end', charter },
    { batchSize: 'all' },
  )
  assert.equal(runToEnd.length, 2, 'L3 = 设定层 1 批 + 正文 1 批')
  assert.equal(runToEnd[0].kind, 'settings')
  assert.deepEqual(runToEnd[1].chapters, chapters)
  assert.ok(runToEnd.every((batch) => batch.requiresAuthorConfirm === false), 'L3 选了一路跑到底就不停批')

  const perBatchFive = planRevisionBatches(
    { tier: 'L3', chapters, goal: '改价值观', stopMode: 'per-batch', charter },
    { batchSize: 2 },
  )
  assert.equal(perBatchFive.length, 1 + Math.ceil(chapters.length / 2))
  assert.deepEqual(perBatchFive[1].chapters, ['0001', '0002'])
  assert.ok(perBatchFive.every((batch) => batch.requiresAuthorConfirm), '作者选每批停：设定层与正文批都停')

  const auto = planRevisionBatches({ tier: 'L3', chapters, goal: '改价值观', charter })
  assert.equal(auto.length, chapters.length + 1, '没显式指定时 L3 默认逐章')
  assert.ok(auto.slice(1).every((batch) => batch.chapters.length === 1))
})

test('闸门策略：L1 允许整批自动，L3 必须逐章确认', () => {
  const l1 = revisionGatePolicy('L1')
  assert.equal(l1.allowBatchAuto, true)
  assert.equal(l1.needsValueCharter, false)
  const l3 = revisionGatePolicy('L3')
  assert.equal(l3.allowBatchAuto, false)
  assert.equal(l3.needsValueCharter, true)
  assert.equal(l3.needsAuthorConfirmEachChapter, true)
  assert.ok(l3.frozen.includes('世界设定'))
  // 停顿方式是作者的选择：L3 也能选不停批，L1 也能选每批停
  const l3RunToEnd = revisionGatePolicy('L3', { stopMode: 'run-to-end' })
  assert.equal(l3RunToEnd.needsAuthorConfirmEachChapter, false)
  assert.equal(l3RunToEnd.stopAfterEachBatch, false)
  const l1PerBatch = revisionGatePolicy('L1', { stopMode: 'per-batch' })
  assert.equal(l1PerBatch.stopAfterEachBatch, true)
})

test('影响面：按人物名扫出受牵连章节，不遗漏', () => {
  const book = [
    { id: '0001', title: '一', content: '华羽生提剑出门。' },
    { id: '0002', title: '二', content: '柳含烟在船头。' },
    { id: '0003', title: '三', content: '华羽生与柳含烟对饮。' },
    { id: '0004', title: '四', content: '张三在打铁。' },
  ]
  const map = impactMap(book, { affectedCharacters: ['华羽生', '柳含烟'] })
  assert.deepEqual(map.chapters.map((row) => row.chapter), ['0003', '0001', '0002'])
  assert.equal(map.uncovered, 1)
  assert.deepEqual(impactMap(book, {}).keywords, [])
})

test('人话说明：能被 UI 直接展示', () => {
  const text = describeRevisionTier('L3')
  assert.match(text, /L3 · 语义层/)
  assert.match(text, /可动：/)
  assert.match(text, /冻结：/)
})

test('多选分层：L1+L2 可动取并集、冻结取交集、风险按最严', () => {
  const composed = composeTiers(['L1', 'L2'])
  assert.equal(composed.id, 'L1+L2')
  assert.deepEqual(composed.members, ['L1', 'L2'])
  assert.equal(composed.risk, 'medium', 'L2 的 medium 应盖过 L1 的 low')
  assert.ok(composed.mutable.includes('句式与句长'), '应包含 L1 的可动项')
  assert.ok(composed.mutable.includes('场景增减'), '应包含 L2 的可动项')
  assert.ok(composed.frozen.includes('事件'), '事件两层都冻结')
  assert.ok(composed.frozen.includes('章末钩子'), '钩子两层都冻结')
  assert.ok(composed.frozen.includes('世界设定'), '世界设定属于基线保护')
  assert.ok(!composed.frozen.includes('对白信息量'), 'L2 允许改对白措辞，故不再冻结信息量')
})

test('多选分层：L1+L2+L3 只保留基线冻结项，风险 high', () => {
  const composed = composeTiers('L1+L2+L3')
  assert.equal(composed.risk, 'high')
  assert.equal(composed.dependency, 'global-first', '含 L3 必须全局先行')
  assert.deepEqual(composed.frozen, ['世界设定', '时代/地理/门派规则'])
  assert.equal(composed.authorConfirm, 'every-chapter')
})

test('normalizeTierIds：接受数组/加号/顿号/逗号', () => {
  assert.deepEqual(normalizeTierIds('L1+L2'), ['L1', 'L2'])
  assert.deepEqual(normalizeTierIds(['l1', 'L2']), ['L1', 'L2'])
  assert.deepEqual(normalizeTierIds('L1、L2，L3'), ['L1', 'L2', 'L3'])
  assert.deepEqual(normalizeTierIds('L1+L1'), ['L1'])
})

test('多选契约：空选择拒绝，L4 混入拒绝，L3 混入仍要价值变更书', () => {
  const empty = validateRevisionContract({ tiers: [], chapters, goal: 'x' })
  assert.equal(empty.ok, false)
  assert.ok(empty.errors.some((e) => /至少要选一个/.test(e)))

  const withL4 = validateRevisionContract({ tiers: ['L1', 'L4'], chapters, goal: 'x' })
  assert.equal(withL4.ok, false)
  assert.ok(withL4.errors.some((e) => /大纲闸门/.test(e)))

  const withL3 = validateRevisionContract({ tiers: ['L1', 'L3'], chapters, goal: 'x', charter: { oldValue: 'a', newValue: 'b', affectedCharacters: [] } })
  assert.equal(withL3.ok, false)
  assert.ok(withL3.errors.some((e) => /受影响人物/.test(e)))

  const good = validateRevisionContract({ tiers: ['L1', 'L2'], chapters, goal: '改文风并补细节' })
  assert.equal(good.ok, true, good.errors.join('；'))
  assert.equal(good.tier.id, 'L1+L2')
})

test('目标来源：可以来自预设，也可以自己填，也可以两者', () => {
  const presetOnly = validateRevisionContract({ tiers: ['L1'], chapters, goalMode: 'preset', presetId: 'p1' })
  assert.equal(presetOnly.ok, true, '引用预设时允许不写 goal')
  const presetMissing = validateRevisionContract({ tiers: ['L1'], chapters, goalMode: 'preset' })
  assert.equal(presetMissing.ok, false)
  assert.ok(presetMissing.errors.some((e) => /presetId/.test(e)))
  const custom = validateRevisionContract({ tiers: ['L1'], chapters, goalMode: 'custom', goal: '改文风' })
  assert.equal(custom.ok, true)
  const customMissing = validateRevisionContract({ tiers: ['L1'], chapters, goalMode: 'custom' })
  assert.equal(customMissing.ok, false)
})

test('多选批次：L1+L2 可并行判定按最严（L2 需批末审，故不并行）', () => {
  const batches = planRevisionBatches({ tiers: ['L1', 'L2'], chapters, goal: 'x' }, { batchSize: 2 })
  assert.equal(batches.length, 2)
  assert.equal(batches[0].parallel, false, '含 L2 时不应整批并行')
  assert.equal(revisionGatePolicy('L1+L2').allowBatchAuto, false)
  assert.equal(revisionGatePolicy('L1').allowBatchAuto, true)
})
