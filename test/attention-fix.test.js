/**
 * 注意力提分闭环（docs/ATTENTION-FIX.md）：确定性诊断 + 段落级 before/after 补丁 + 采纳打补丁 + 复测 Δ 回填。
 * 纯函数（lib/attention-fix.js）与 store/checks 集成各测一半。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../lib/store.js'
import { runChecks } from '../lib/checks.js'
import {
  attentionDeficits,
  attentionFixCandidates,
  attentionFixStats,
  attentionMinFixes,
  applyAttentionFixes,
  assertAttentionFixPayload,
  contentHash,
  locateAttentionFixSpans,
} from '../lib/attention-fix.js'
import { makeRoot } from './helpers.js'

const PARAGRAPHS = [
  '雨下了三天，林砚在破庙里等一封不会来的信。',
  '他把信纸撕成两半，却还是把信封折好塞进怀里。',
  '门外忽然传来两短一长的敲门声，他握着刀没有起身。',
]
const CONTENT = PARAGRAPHS.join('\n\n')

function record(overrides = {}) {
  return {
    id: 'att-0004',
    chapter: 4,
    type: 'mystery',
    score: 66,
    designScore: 80,
    verdict: '犹豫',
    weakest: 'cliff',
    hook: '破庙等信',
    tension: '撕信与留信',
    payoff: '信是谁写的',
    cliff: '敲门声',
    detail: '中段回忆偏多',
    breakdown: { hook: 16, tension: 14, payoff: 15, cliff: 9 },
    dropPoints: [{ quote: '他把信纸撕成两半', why: '前一章刚说完这封信不能撕，读者会出戏' }],
    ...overrides,
  }
}

function fixItems() {
  return [
    { target: 'hook', weak: 'hook', expectedGain: 5, before: PARAGRAPHS[0], after: '雨下了三天，林砚在破庙里等的不是信，是来收尸的人。', why: '开头悬念从「等信」换成「等收尸」，钩子更硬' },
    { target: 'cliff', weak: 'cliff', expectedGain: 6, before: PARAGRAPHS[2], after: '门外忽然传来两短一长的敲门声——那是他给自己人定的暗号。他握着刀，没有起身。', why: '章末从「有人敲门」升级成「来的是自己人」，未决问题更强' },
    { target: 'payoff', weak: 'payoff', expectedGain: 4, before: PARAGRAPHS[1], after: '他把信纸撕成两半，却在碎片里认出母亲的笔迹，于是把每一片都收进怀里。', why: '兑现「信是谁写的」这条线索' },
  ]
}

function checksWith(checks, prefix) {
  return checks.filter((check) => String(check.id).startsWith(prefix))
}

function chapter(id, overrides = {}) {
  return { id, title: `第 ${id} 章`, content: '正文。', characters: [], ...overrides }
}

// ── 诊断（纯函数）─────────────────────────────────────────────

test('attentionDeficits：没实测分 → 先冷读，不再给别的诊断', () => {
  const deficits = attentionDeficits({ chapter: 1, score: null })
  assert.equal(deficits.length, 1)
  assert.equal(deficits[0].id, 'need-cold-read')
  assert.ok(deficits[0].prescribe.includes('冷读'))
})

test('attentionDeficits：设计差≥20 + 最弱拍低分 + 弃读点 → 3 条严重项，最少 5 条方案', () => {
  const deficits = attentionDeficits(record({ designScore: 88 }))
  const ids = deficits.map((d) => d.id)
  assert.ok(ids.includes('design-gap'), '设计 80 / 实测 66 应报 design-gap')
  assert.ok(ids.includes('weak-cliff'), 'cliff 9/25 是最弱拍，应报 weak-cliff')
  assert.ok(ids.includes('drop-point'), '有弃读点应报 drop-point')
  assert.equal(deficits[0].severity, 3, '严重项排前面')
  assert.ok(deficits.every((d) => d.prescribe), '每条都要给处方')
  assert.equal(attentionMinFixes(deficits), 5, '3 个严重项 → 至少 5 条')
  assert.ok(attentionMinFixes(attentionDeficits(record({ designScore: 70, dropPoints: [], breakdown: { hook: 17, tension: 16, payoff: 17, cliff: 15 } }))) >= 3, '没有严重项也要 ≥3 条')
})

test('attentionDeficits：缺 breakdown → need-breakdown；次弱拍单独给一条', () => {
  const noBreakdown = attentionDeficits(record({ breakdown: undefined }))
  assert.ok(noBreakdown.some((d) => d.id === 'need-breakdown'))
  const second = attentionDeficits(record({ weakest: 'cliff', breakdown: { hook: 18, tension: 9, payoff: 17, cliff: 16 } }))
  assert.ok(second.some((d) => d.id === 'second-weak-tension'), '次弱拍 tension 9 应报 second-weak-tension')
})

test('attentionFixCandidates：按提分空间降序，排除未打分与 ≥88 分章节', () => {
  const bundle = {
    chapters: [chapter('0001', { content: 'A' }), chapter('0002', { content: 'B' }), chapter('0003', { content: 'C' }), chapter('0004', { content: 'D' })],
    attention: [
      record({ chapter: 1, score: 60, designScore: 80, dropPoints: [] }),
      record({ chapter: 2, score: 70, designScore: 80, breakdown: { hook: 18, tension: 17, payoff: 18, cliff: 17 }, dropPoints: [] }),
      record({ chapter: 3, score: 90, designScore: 80, dropPoints: [] }),
      { chapter: 4, score: null },
    ],
    proposals: [],
  }
  const rows = attentionFixCandidates(bundle)
  assert.deepEqual(rows.map((row) => row.chapter), [1, 2], '只留 60/70 两章，按空间降序')
  assert.ok(rows[0].potential > rows[1].potential)
  assert.equal(rows[0].minFixes >= 3, true)
})

test('attentionFixCandidates：正文改过（scoredHash 不匹配）→ stale；有 pending 提案 → pendingFixes', () => {
  const chapterContent = '改过的正文。'
  const bundle = {
    chapters: [chapter('0001', { content: chapterContent })],
    attention: [record({ chapter: 1, score: 70, designScore: 80, scoredHash: contentHash('旧正文'), dropPoints: [] })],
    proposals: [{ id: 'p1', kind: 'attention-fix', status: 'pending', chapter: 1 }],
  }
  const [row] = attentionFixCandidates(bundle)
  assert.equal(row.stale, true)
  assert.equal(row.pendingFixes, 1)
})

// ── 段落级补丁（纯函数）──────────────────────────────────────

test('applyAttentionFixes：只替换 before 段，其余原文一字不动', () => {
  const result = applyAttentionFixes(CONTENT, fixItems())
  assert.equal(result.applied.length, 3)
  assert.ok(!result.content.includes(PARAGRAPHS[0]), '被替换的原文不应残留')
  assert.ok(result.content.includes('来收尸的人'))
  assert.ok(result.content.includes('认出母亲的笔迹'))
  assert.ok(result.content.includes('给自己人定的暗号'))
  assert.equal(result.content.split('\n\n').length, 3, '段落数不变（没有删段/并段）')
})

test('applyAttentionFixes：before 找不到 / after 与 before 相同 / 片段重复 / 重叠 → 中文报错', () => {
  assert.throws(() => applyAttentionFixes(CONTENT, [
    { target: 'hook', before: '这句话根本不在正文里啊啊', after: '随便改改', expectedGain: 3 },
    { target: 'cliff', before: PARAGRAPHS[2], after: '换个结尾', expectedGain: 3 },
    { target: 'payoff', before: PARAGRAPHS[1], after: '再改一处', expectedGain: 3 },
  ]), /before 在正文里找不到/)
  assert.throws(() => applyAttentionFixes(CONTENT, [
    { target: 'hook', before: PARAGRAPHS[0], after: PARAGRAPHS[0], expectedGain: 3 },
    { target: 'cliff', before: PARAGRAPHS[2], after: '换个结尾', expectedGain: 3 },
    { target: 'payoff', before: PARAGRAPHS[1], after: '再改一处', expectedGain: 3 },
  ]), /after 和 before 一样/)
  assert.throws(() => applyAttentionFixes(CONTENT + '\n\n' + PARAGRAPHS[0], fixItems()), /出现多次/)
  assert.throws(() => applyAttentionFixes(CONTENT, [
    { target: 'hook', before: PARAGRAPHS[0].slice(0, 10), after: '改成别的开头钩子', expectedGain: 3 },
    { target: 'cliff', before: PARAGRAPHS[0], after: '又改一次同一段', expectedGain: 3 },
    { target: 'payoff', before: PARAGRAPHS[1], after: '再改一处', expectedGain: 3 },
  ]), /重叠/)
})

test('locateAttentionFixSpans：返回按位置排序的片段，条号对得上', () => {
  const spans = locateAttentionFixSpans(CONTENT, fixItems())
  assert.equal(spans.length, 3)
  assert.deepEqual(spans.map((span) => span.item.target), ['hook', 'payoff', 'cliff'], '按正文位置排序，不是按提交顺序')
  assert.ok(spans[0].at < spans[1].at && spans[1].at < spans[2].at)
})

test('assertAttentionFixPayload：条数/目标/增益/合计逐条硬校验', () => {
  const ok = assertAttentionFixPayload({ chapter: 4, items: fixItems() }, CONTENT)
  assert.equal(ok.total, 15)
  assert.deepEqual(ok.targets.sort(), ['cliff', 'hook', 'payoff'])
  assert.throws(() => assertAttentionFixPayload({ items: fixItems().slice(0, 2) }, CONTENT), /至少要 3 条/)
  assert.throws(() => assertAttentionFixPayload({ items: fixItems().map((item) => ({ ...item, target: 'hook' })) }, CONTENT), /至少覆盖 2 个不同 target/)
  assert.throws(() => assertAttentionFixPayload({ items: fixItems().map((item) => ({ ...item, expectedGain: 15 })) }, CONTENT), /超过一章上限/)
  assert.throws(() => assertAttentionFixPayload({ items: fixItems().map((item) => ({ ...item, expectedGain: 0 })) }, CONTENT), /expectedGain 必须是/)
  assert.throws(() => assertAttentionFixPayload({ items: fixItems().map((item) => ({ ...item, why: '' })) }, CONTENT), /缺 why/)
})

// ── 提案：校验 → 采纳打补丁 → 标记待复测 ─────────────────────

test('createProposal(attention-fix)：章节不存在 / 条数不够 / before 不在正文 → 拒绝入库', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '提分作品' })
  await store.saveChapter(root, project.id, { id: '0004', title: '第四章', content: CONTENT })
  const base = { kind: 'attention-fix', chapter: 4, title: '第四章提分', data: { chapter: 4, items: fixItems() } }
  const created = await store.createProposal(root, project.id, base)
  assert.equal(created.kind, 'attention-fix')
  assert.equal(created.data.expectedGainTotal, 15, '合计预期应自动补齐')
  await assert.rejects(() => store.createProposal(root, project.id, { ...base, chapter: 9, data: { chapter: 9, items: fixItems() } }), /已存在的章节/)
  await assert.rejects(() => store.createProposal(root, project.id, { ...base, data: { chapter: 4, items: fixItems().slice(0, 2) } }), /至少要 3 条/)
  await assert.rejects(() => store.createProposal(root, project.id, {
    ...base,
    data: { chapter: 4, items: fixItems().map((item) => ({ ...item, before: '这句不在正文里哦哦哦' })) },
  }), /找不到/)
})

test('acceptProposal(attention-fix)：只改补丁段、保留章节元信息、自动备份、记录 fixLog/待复测', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '采纳提分' })
  await store.saveChapter(root, project.id, { id: '0004', title: '第四章：雨夜', status: 'draft', summary: '主角等信', content: CONTENT, location: '破庙', storyTime: '第三日夜' })
  const proposal = await store.createProposal(root, project.id, { kind: 'attention-fix', chapter: 4, title: '第四章提分', data: { chapter: 4, items: fixItems() } })
  const { applied } = await store.acceptProposal(root, project.id, proposal.id)

  assert.equal(applied.chapter, '0004')
  assert.equal(applied.fixes, 3)
  assert.ok(applied.backup, '采纳前应自动备份旧稿')
  const bundle = await store.getBundle(root, project.id)
  const saved = bundle.chapters.find((row) => String(row.id) === '0004')
  assert.ok(saved.content.includes('来收尸的人'))
  assert.equal(saved.title, '第四章：雨夜', '标题不能被覆盖')
  assert.equal(saved.summary, '主角等信')
  assert.equal(saved.location, '破庙')
  const attention = bundle.attention.find((row) => Number(row.chapter) === 4)
  assert.equal(attention.recheckPending, true, '改完应标记待复测')
  assert.equal(attention.fixLog.length, 3)
  assert.equal(attention.fixPlan.expectedGainTotal, 15)
  assert.ok(attention.lastFixAt)
})

// ── 复测：分数历史与 Δ 回填 ──────────────────────────────────

test('applyAttentionItems：首次打分 from=null（cold-read），复测写 delta 并清「待复测」', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '复测作品' })
  await store.saveChapter(root, project.id, { id: '0004', title: '第四章', content: CONTENT })

  const first = await store.createProposal(root, project.id, {
    kind: 'attention',
    title: '冷读实测',
    items: [{ chapter: 4, score: 66, breakdown: { hook: 16, tension: 14, payoff: 15, cliff: 9 }, weakest: 'cliff' }],
  })
  await store.acceptProposal(root, project.id, first.id)
  let row = (await store.getBundle(root, project.id)).attention.find((r) => Number(r.chapter) === 4)
  assert.equal(row.scoreHistory.length, 1)
  assert.equal(row.scoreHistory[0].source, 'cold-read')
  assert.equal(row.scoreHistory[0].from, null)
  assert.equal(row.scoredHash, contentHash(CONTENT), '分数应绑定当前正文指纹')

  const fix = await store.createProposal(root, project.id, { kind: 'attention-fix', chapter: 4, title: '提分', data: { chapter: 4, items: fixItems() } })
  await store.acceptProposal(root, project.id, fix.id)
  const recheck = await store.createProposal(root, project.id, {
    kind: 'attention',
    title: '复测',
    items: [{ chapter: 4, score: 74, breakdown: { hook: 19, tension: 15, payoff: 18, cliff: 16 }, weakest: 'tension' }],
  })
  await store.acceptProposal(root, project.id, recheck.id)
  row = (await store.getBundle(root, project.id)).attention.find((r) => Number(r.chapter) === 4)
  assert.equal(row.scoreHistory.length, 2)
  assert.equal(row.scoreHistory[1].source, 'recheck')
  assert.equal(row.scoreHistory[1].from, 66)
  assert.equal(row.scoreHistory[1].to, 74)
  assert.equal(row.scoreHistory[1].delta, 8)
  assert.equal(row.recheckPending, false, '复测后应清待复测')
  assert.equal(row.lastRecheckDelta, 8)
  assert.equal(row.weakest, 'tension', '复测可以改变最弱一环')
  assert.equal(row.breakdown.cliff, 16)
})

test('attentionFixStats：待复测/已复测/平均 Δ/没提分章节计数', () => {
  const stats = attentionFixStats({
    attention: [
      { chapter: 1, recheckPending: true, fixLog: [{}, {}] },
      { chapter: 2, fixLog: [{}], lastRecheckDelta: 7, scoreHistory: [{ source: 'recheck', delta: 7 }] },
      { chapter: 3, fixLog: [{}], lastRecheckDelta: -2, scoreHistory: [{ source: 'recheck', delta: -2 }] },
    ],
    proposals: [
      { kind: 'attention-fix', status: 'pending' },
      { kind: 'attention-fix', status: 'pending' },
      { kind: 'attention-fix', status: 'accepted' },
    ],
  })
  assert.equal(stats.pendingRecheck, 1)
  assert.equal(stats.verified, 2)
  assert.equal(stats.fixCount, 4)
  assert.equal(stats.noGain, 1)
  assert.equal(stats.pendingFixProposals, 2)
  assert.equal(stats.avgDelta, 2.5)
  assert.equal(stats.bestDelta, 7)
  assert.equal(stats.worstDelta, -2)
})

// ── 新检查规则 ───────────────────────────────────────────────

test('checks 9.9：待复测 / 分数对应旧稿 / 改了没提分 / 有空间没方案', () => {
  const pending = runChecks({
    chapters: [chapter('0001', { content: CONTENT })],
    attention: [record({ chapter: 1, fixLog: [{}], recheckPending: true, fixPlan: { expectedGainTotal: 11 } })],
  })
  const pendingRule = checksWith(pending, 'attention-recheck-pending:')
  assert.equal(pendingRule.length, 1)
  assert.equal(pendingRule[0].level, 'warn')
  assert.match(pendingRule[0].detail, /预期 \+11/)

  const stale = runChecks({
    chapters: [chapter('0001', { content: CONTENT })],
    attention: [record({ chapter: 1, scoredHash: contentHash('老版本正文'), designScore: 70, dropPoints: [] })],
  })
  assert.equal(checksWith(stale, 'attention-score-stale:').length, 1)
  assert.equal(checksWith(stale, 'attention-score-stale:')[0].level, 'info')

  const noGain = runChecks({
    chapters: [chapter('0001', { content: CONTENT })],
    attention: [record({ chapter: 1, fixLog: [{}, {}], lastRecheckDelta: -3, fixPlan: { expectedGainTotal: 12 }, designScore: 70, dropPoints: [] })],
  })
  assert.equal(checksWith(noGain, 'attention-fix-no-gain:').length, 1)

  const noPlan = runChecks({
    chapters: [chapter('0001', { content: CONTENT })],
    attention: [record({ chapter: 1, designScore: 88, score: 66, dropPoints: [] })],
  })
  assert.equal(checksWith(noPlan, 'attention-gap-no-plan:').length, 1)
  const withPlan = runChecks({
    chapters: [chapter('0001', { content: CONTENT })],
    attention: [record({ chapter: 1, designScore: 88, score: 66, dropPoints: [] })],
    proposals: [{ kind: 'attention-fix', status: 'pending', chapter: 1 }],
  })
  assert.equal(checksWith(withPlan, 'attention-gap-no-plan:').length, 0, '已有待采纳方案时不重复报警')
})
