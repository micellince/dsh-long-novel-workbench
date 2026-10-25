/**
 * 全文改动（Revision）引擎契约层。
 *
 * 核心判断：全文改动不是一个操作，而是四层不同危险等级的操作。
 * 文风改动（L1）每章独立重写即可；价值观改动（L3）是全局约束，
 * 逐章独立改必然自相矛盾——这是本模块存在的理由。
 *
 * 本文件只放纯函数（分层、契约校验、批次规划、影响面、闸门策略），
 * 不碰文件系统，便于测试与在 prompt / UI / 检查中复用。
 */

/** 改动分层：mutable=允许动，frozen=必须冻结。 */
export const REVISION_TIERS = [
  {
    id: 'L1',
    name: '语域层（文风 / 叙述声音）',
    summary: '每章重写一遍，情节一个字不动。',
    mutable: ['句式与句长', '用词与语域', '比喻与意象', '描写顺序', '情绪抒写的表达方式'],
    frozen: ['事件', '人物动作与结果', '对白信息量', '专名', '数字', '章末钩子', '事实账本'],
    frozenKeys: ['event', 'action-result', 'dialogue-info', 'proper-noun', 'number', 'hook', 'fact-ledger'],
    automation: 'auto',
    dependency: 'per-chapter',
    authorConfirm: 'sample',
    gates: ['fidelity-anchors', 'style-cards'],
    risk: 'low',
  },
  {
    id: 'L2',
    name: '侧写层（场景 / 对白细节）',
    summary: '可以增删场景细节与对白措辞，但事件与结果不变。',
    mutable: ['场景增减', '对白措辞', '配角戏份', '细节密度'],
    frozen: ['事件与结果', '因果链', '人物关系变化', '章末钩子', '事实账本'],
    frozenKeys: ['event', 'action-result', 'causal-chain', 'relationship-change', 'hook', 'fact-ledger'],
    automation: 'auto-with-review',
    dependency: 'per-chapter-light',
    authorConfirm: 'batch',
    gates: ['fidelity-anchors', 'continuity'],
    risk: 'medium',
  },
  {
    id: 'L3',
    name: '语义层（价值观 / 动机 / 主题）',
    summary: '改人物立场、动机与叙述者的价值判断。',
    mutable: ['人物立场与动机', '叙述者的价值判断', '主题走向', '人物的道德选择'],
    frozen: ['世界设定', '时代/地理/门派规则', '已发生事件的外部结果（可重解读，不可抹除）'],
    frozenKeys: ['world-setting', 'era-geo-rules', 'event-outcome-permanent'],
    automation: 'manual-by-chapter',
    dependency: 'global-first',
    authorConfirm: 'every-chapter',
    gates: ['value-charter', 'impact-map', 'consistency'],
    risk: 'high',
    notes: '价值观是全局约束。逐章独立改必然自相矛盾：第 10 章改了立场，第 30 章还按旧立场写。必须先写「价值变更书」，算影响面，先改设定层（人物卡/预设/主题），再逐章级联。',
  },
  {
    id: 'L4',
    name: '结构层（情节 / 结局）',
    summary: '改事件本身、人物生死、结局走向。',
    mutable: ['事件本身', '结局', '人物生死'],
    frozen: ['世界规则'],
    frozenKeys: ['world-rule'],
    automation: 'outline-gate',
    dependency: 'outline',
    authorConfirm: 'outline-then-chapter',
    gates: ['outline-gate', 'fidelity-anchors'],
    risk: 'critical',
    notes: '这不是「改动」而是重写，应走扩写/大纲闸门；本引擎只承接 L1–L3，L4 一律拒绝。',
  },
]

/**
 * 停顿方式：批次与批次之间要不要停下等作者。
 * 批次大小只决定「检查点密度」，每章仍是一次独立改写；
 * 一次全改 = 1 批，不等于一次模型调用写 52 章。
 */
export const REVISION_STOP_MODES = [
  { id: 'per-batch', name: '每批停下确认', description: '每批改完停下，等作者看过再继续。最稳，但要点很多次。' },
  { id: 'fix-only', name: '只在出问题时停', description: '一直跑；某章两次修不过闸门、或撞到冻结项时才停。' },
  { id: 'run-to-end', name: '一路跑到底', description: '不停，全部改完再汇报；每章仍过保真 + Markdown 闸门，预算到顶自动停。' },
]

export const DEFAULT_STOP_MODE = 'per-batch'

export function findStopMode(id) {
  const key = String(id ?? '').trim()
  return REVISION_STOP_MODES.find((mode) => mode.id === key) ?? null
}

/** 基线保护项：任何分层组合都不能放开。 */
export const BASELINE_PROTECTED = ['world-setting', 'era-geo-rules']

/** 规范化冻结键 → 中文标签（组合时按键求交集，避免措辞差异把约束抹掉）。 */
export const FROZEN_LABELS = {
  event: '事件',
  'action-result': '人物动作与结果',
  'dialogue-info': '对白信息量',
  'proper-noun': '专名',
  number: '数字',
  hook: '章末钩子',
  'fact-ledger': '事实账本',
  'causal-chain': '因果链',
  'relationship-change': '人物关系变化',
  'world-setting': '世界设定',
  'era-geo-rules': '时代/地理/门派规则',
  'event-outcome-permanent': '已发生事件的外部结果',
  'world-rule': '世界规则',
}

export function findRevisionTier(id) {
  const key = String(id ?? '').trim().toUpperCase()
  return REVISION_TIERS.find((tier) => tier.id === key) ?? null
}

const RISK_ORDER = { low: 0, medium: 1, high: 2, critical: 3 }
const AUTOMATION_ORDER = { auto: 0, 'auto-with-review': 1, 'manual-by-chapter': 2, 'outline-gate': 3 }
const CONFIRM_ORDER = { sample: 0, batch: 1, 'every-chapter': 2, 'outline-then-chapter': 3 }

/** 把 "L1+L2" / ['L1','L2'] / 'l1、l2' 统一成 ['L1','L2']。 */
export function normalizeTierIds(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[+、,，\s]+/)
  return [...new Set(raw.map((item) => String(item ?? '').trim().toUpperCase()).filter(Boolean))]
}

function strictest(values, order) {
  return values.reduce((best, value) => (order[value] > order[best] ? value : best), values[0])
}

/**
 * 组合多个层级：可动取并集，冻结取交集，风险/自动化/确认按最严的那一层。
 * 这样 L1+L2 才说得清：既要换语域，也允许动场景细节，但事件与钩子仍然冻结。
 */
export function composeTiers(input) {
  const ids = normalizeTierIds(input)
  const tiers = ids.map(findRevisionTier).filter(Boolean)
  if (tiers.length === 0) return null
  if (tiers.length === 1) return { ...tiers[0], members: [tiers[0].id] }
  return {
    id: tiers.map((tier) => tier.id).join('+'),
    name: tiers.map((tier) => tier.name).join(' + '),
    summary: tiers.map((tier) => `${tier.id}：${tier.summary}`).join('；'),
    members: tiers.map((tier) => tier.id),
    mutable: [...new Set(tiers.flatMap((tier) => tier.mutable))],
    // 冻结 = 所有层级都不许动的键；另外世界设定属于基线，任何层级都没有放开它。
    frozenKeys: [...new Set([
      ...tiers[0].frozenKeys.filter((key) => tiers.every((tier) => (tier.frozenKeys ?? []).includes(key))),
      ...BASELINE_PROTECTED,
    ])],
    frozen: [...new Set([
      ...tiers[0].frozenKeys.filter((key) => tiers.every((tier) => (tier.frozenKeys ?? []).includes(key))),
      ...BASELINE_PROTECTED,
    ])].map((key) => FROZEN_LABELS[key] ?? key),
    risk: strictest(tiers.map((tier) => tier.risk), RISK_ORDER),
    automation: strictest(tiers.map((tier) => tier.automation), AUTOMATION_ORDER),
    authorConfirm: strictest(tiers.map((tier) => tier.authorConfirm), CONFIRM_ORDER),
    dependency: tiers.some((tier) => tier.dependency === 'global-first') ? 'global-first' : 'per-chapter',
    gates: [...new Set(tiers.flatMap((tier) => tier.gates))],
    notes: tiers.filter((tier) => tier.notes).map((tier) => `${tier.id}：${tier.notes}`).join('\n'),
  }
}

/**
 * 改动契约校验。
 * contract = { tier, chapters:[], goal, keywords?:[], charter?:{oldValue,newValue,affectedCharacters?:[]} }
 * @returns {{ok:boolean, errors:string[], tier?:object}}
 */
export function validateRevisionContract(contract = {}) {
  const errors = []
  const requested = normalizeTierIds(contract.tiers ?? contract.tier)
  const unknown = requested.filter((id) => !findRevisionTier(id))
  if (unknown.length > 0) errors.push(`未知改动层级：${unknown.join('、')}（可选 L1/L2/L3；L4 请走扩写）`)
  if (requested.includes('L4')) {
    errors.push('L4（结构层）不属于改动引擎：它会改事件与结局，请走大纲闸门/扩写流程。')
    return { ok: false, errors, tier: null, members: requested }
  }
  const tier = composeTiers(requested)
  if (!tier) {
    errors.push('至少要选一个改动层级（L1 / L2 / L3，可多选）。')
    return { ok: false, errors, tier: null, members: requested }
  }
  const chapters = Array.isArray(contract.chapters) ? contract.chapters.map(String).filter(Boolean) : []
  if (chapters.length === 0) errors.push('必须指定要改的章节（chapters 不能为空）。')
  const goalMode = String(contract.goalMode ?? 'custom').trim() || 'custom'
  const goalText = String(contract.goal ?? '').trim()
  if (!goalText && goalMode !== 'preset') errors.push('必须写改动目标（goal）：要改成什么样，用一句可判定的话；或把目标来源切到「引用预设」。')
  if (goalMode === 'preset' && !String(contract.presetId ?? '').trim()) errors.push('目标来源选了「引用预设」，但没有指定 presetId。')

  if (tier.members.includes('L3')) {
    const charter = contract.charter ?? {}
    if (!String(charter.oldValue ?? '').trim()) errors.push('L3 必须写「价值变更书」的旧立场（charter.oldValue）。')
    if (!String(charter.newValue ?? '').trim()) errors.push('L3 必须写「价值变更书」的新立场（charter.newValue）。')
    if (String(charter.oldValue ?? '').trim() && String(charter.oldValue ?? '').trim() === String(charter.newValue ?? '').trim()) {
      errors.push('L3 的旧立场与新立场相同，本次改动无意义。')
    }
    const chars = Array.isArray(charter.affectedCharacters) ? charter.affectedCharacters.filter(Boolean) : []
    if (chars.length === 0) errors.push('L3 必须列出受影响人物（charter.affectedCharacters）：价值观改动一定牵连人物。')
  }
  return { ok: errors.length === 0, errors, tier, members: tier.members }
}

/**
 * 批次规划。批次大小与停顿方式都是作者的选择，L1–L3 一样可选：
 * - 一次一章 / 每几章 / 整本一批（batchSize: 1、N、'all'）；
 * - 每批停 / 只在出问题时停 / 一路跑到底（stopMode）。
 * L3 只在**顺序**上强制「设定层先行」（批次 0 是 settings），不再强制逐章停。
 * 未显式指定时：L1/L2 默认 5 章、L3 默认 1 章；停顿按分层默认（L1 只停首批，L2/L3 每批停）。
 * 任何情况下 L4 都不会被规划。
 */
export function planRevisionBatches(contract = {}, { batchSize } = {}) {
  const { ok, errors, tier } = validateRevisionContract(contract)
  if (!ok) throw new Error(`改动契约不成立：${errors.join('；')}`)
  const chapters = contract.chapters.map(String)
  const hasL3 = tier.members.includes('L3')
  // 'all' 或 >= 章数 = 一批全改；未指定（auto）= L3 逐章、L1/L2 每 5 章。
  const defaultSize = hasL3 ? 1 : 5
  const size = batchSize === 'all'
    ? Math.max(1, chapters.length)
    : Math.min(Math.max(1, Number(batchSize) || defaultSize), Math.max(1, chapters.length))
  const stopMode = findStopMode(contract.stopMode)?.id ?? ''
  // 显式选择了停顿方式就按作者的选择；没选才回落到分层的默认。
  const confirmFor = (index) => {
    if (stopMode === 'fix-only' || stopMode === 'run-to-end') return false
    if (stopMode === 'per-batch') return true
    if (tier.authorConfirm === 'sample') return index === 0
    return true
  }

  const batches = []
  if (hasL3) {
    batches.push({
      index: 0,
      kind: 'settings',
      label: '设定层：价值基准、人物立场、主题',
      chapters: [],
      parallel: false,
      requiresAuthorConfirm: confirmFor(0),
      batchSize: size,
    })
  }
  for (let i = 0; i < chapters.length; i += size) {
    const slice = chapters.slice(i, i + size)
    batches.push({
      index: batches.length,
      kind: 'chapter',
      label: hasL3 ? `第 ${slice.join('、')} 章（级联）` : `第 ${slice.join('、')} 章`,
      chapters: slice,
      parallel: !hasL3 && tier.members.every((id) => findRevisionTier(id)?.automation === 'auto'),
      requiresAuthorConfirm: confirmFor(batches.length),
      batchSize: size,
    })
  }
  return batches
}

/**
 * 改动闸门策略：给执行端（prompt / UI / 检查）看的硬约束。
 * 停顿方式由作者选（options.stopMode），没选才按分层默认。
 */
export function revisionGatePolicy(tierId, options = {}) {
  const tier = (tierId && typeof tierId === 'object') ? (tierId.members ? tierId : composeTiers(tierId.tiers ?? tierId.tier)) : composeTiers(tierId)
  if (!tier) throw new Error(`未知改动层级：${tierId}`)
  const stopMode = findStopMode(options.stopMode)?.id ?? ''
  const stopAfterEachBatch = stopMode === 'per-batch'
    ? true
    : (stopMode === 'fix-only' || stopMode === 'run-to-end' ? false : tier.authorConfirm !== 'sample')
  return {
    tier: tier.id,
    members: tier.members,
    risk: tier.risk,
    stopMode: stopMode || 'default',
    needsValueCharter: tier.members.includes('L3'),
    needsOutlineGate: tier.members.includes('L4'),
    needsAuthorConfirmEachChapter: stopMode === 'per-batch' ? true : (stopMode === 'fix-only' || stopMode === 'run-to-end' ? false : tier.authorConfirm === 'every-chapter'),
    // 只有全部成员都可自动时才允许整批自动跑
    allowBatchAuto: tier.members.every((id) => findRevisionTier(id)?.automation === 'auto'),
    stopAfterEachBatch,
    gates: tier.gates,
    frozen: tier.frozen,
    mutable: tier.mutable,
  }
}

/**
 * 影响面分析：价值观改动前，先找出正文里哪些章命中受影响的立场/人物。
 * 只是关键词扫描；它不判断对错，只负责「别漏章」。
 */
export function impactMap(chapters = [], charter = {}) {
  const keywords = [
    ...(Array.isArray(charter.keywords) ? charter.keywords : []),
    ...(Array.isArray(charter.affectedCharacters) ? charter.affectedCharacters : []),
  ].map((k) => String(k ?? '').trim()).filter(Boolean)

  if (keywords.length === 0) return { keywords, chapters: [], uncovered: chapters.length }

  const hits = []
  for (const chapter of chapters) {
    const text = String(chapter?.content ?? '')
    if (!text) continue
    const matched = keywords.filter((keyword) => text.includes(keyword))
    if (matched.length > 0) hits.push({ chapter: chapter.id, title: chapter.title ?? '', matched })
  }
  return {
    keywords,
    chapters: hits.sort((a, b) => (matchedCount(b) - matchedCount(a))),
    uncovered: chapters.length - hits.length,
  }
}

function matchedCount(row) {
  return row.matched.length
}

/** 人话版说明（UI 提示 / MCP status 用）。 */
export function describeRevisionTier(tierId) {
  const tier = (tierId && typeof tierId === 'object')
    ? (tierId.members ? tierId : composeTiers(tierId.tiers ?? tierId.tier))
    : composeTiers(tierId)
  if (!tier) return `未知改动层级：${JSON.stringify(tierId)}`
  return [
    `${tier.id} · ${tier.name}`,
    `做法：${tier.summary}`,
    `可动：${tier.mutable.join('、')}`,
    `冻结：${tier.frozen.join('、')}`,
    `自动化：${tier.automation} ｜ 依赖：${tier.dependency} ｜ 风险：${tier.risk}`,
    ...(tier.notes ? [`注意：${tier.notes}`] : []),
  ].join('\n')
}

// ── 引擎：锚点 / 保真 / 影响面 / 方案 ─────────────────────────

const NUMBER_TOKEN = /(?:d+|[一二三四五六七八九十百千两半几]+)(?=步|寸|分|尺|丈|里|年|月|日|天|次|个|块|张|支|只|匹|碗|斤|两|人|句|回|章)/g

function cjkBigrams(text) {
  const clean = String(text ?? '').replace(/[^\u3400-\u9fff]/g, '')
  const out = new Set()
  for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2))
  return out
}

function lastSentence(text) {
  const parts = String(text ?? '').split(/[。！？…\n]+/).map((s) => s.trim()).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

function countQuotes(text) {
  const matches = String(text ?? '').match(/[“"][^”"]{1,300}[”"]/g)
  return matches ? matches.length : 0
}

/** 从原章抽取「改后必须还在」的锚点。 */
export function extractAnchors(chapter = {}, options = {}) {
  const content = String(chapter.content ?? '')
  const cast = Array.isArray(chapter.characters) ? chapter.characters.map(String) : []
  const known = Array.isArray(options.characterNames) ? options.characterNames.map(String) : []
  const names = [...new Set([
    ...cast.filter((name) => name && content.includes(name)),
    ...known.filter((name) => name && content.includes(name)),
  ])]
  const numbers = [...new Set(content.match(NUMBER_TOKEN) ?? [])]
  return {
    names,
    numbers,
    dialogueCount: countQuotes(content),
    hook: lastSentence(content),
    chars: content.length,
  }
}

/**
 * 保真闸门：专名不得丢失；数字保留率 ≥ 0.8；对白条数变化 ≤ ±20%；章末钩子须有承接。
 * @returns {{hit:number,total:number,missing:Array,pass:boolean}}
 */
export function evaluateFidelity(original = {}, revised = {}, anchors = null) {
  const source = anchors ?? extractAnchors(original)
  const text = String(revised?.content ?? revised ?? '')
  const missing = []
  let hit = 0
  let total = 0

  for (const name of source.names ?? []) {
    total += 1
    if (text.includes(name)) hit += 1
    else missing.push({ type: 'name', value: name })
  }

  const numbers = source.numbers ?? []
  if (numbers.length > 0) {
    total += 1
    const kept = numbers.filter((token) => text.includes(token)).length
    if (kept / numbers.length >= 0.8) hit += 1
    else missing.push({ type: 'numbers', value: `保留 ${kept}/${numbers.length}` })
  }

  const before = Number(source.dialogueCount) || 0
  if (before > 0) {
    total += 1
    const after = countQuotes(text)
    if (Math.abs(after - before) / before <= 0.2) hit += 1
    else missing.push({ type: 'dialogue', value: `${before} → ${after}` })
  }

  const hook = String(source.hook ?? '').trim()
  if (hook.length > 0) {
    total += 1
    const grams = cjkBigrams(hook)
    const tail = cjkBigrams(String(text).slice(-120))
    let overlap = 0
    for (const gram of grams) if (tail.has(gram)) overlap += 1
    const ratio = grams.size > 0 ? overlap / grams.size : 1
    if (ratio >= 0.3) hit += 1
    else missing.push({ type: 'hook', value: `承接 ${(ratio * 100).toFixed(0)}%` })
  }

  return { hit, total, missing, pass: total > 0 ? hit / total >= 0.75 : true }
}

/** 关系传导：把「张三(师徒)」解析成 { from, relation, to }。 */
export function parseRelationships(characters = []) {
  const edges = []
  for (const character of characters) {
    const from = String(character?.name ?? '').trim()
    if (!from) continue
    for (const raw of Array.isArray(character.relationships) ? character.relationships : []) {
      const text = String(raw ?? '').trim()
      if (!text) continue
      const match = /^(.+?)[（(]([^（）()]*)[)）]$/.exec(text)
      if (match) edges.push({ from, to: match[1].trim(), relation: match[2].trim() })
      else edges.push({ from, to: text, relation: '' })
    }
  }
  return edges
}

/**
 * 影响面：出场章（直接）+ 关系传导（间接）+ 事件参与（补漏）。
 * 只用工作台已有数据：chapters[].characters / characters[].relationships / events[].participants。
 */
export function buildImpactFromBundle(bundle = {}, contract = {}) {
  const charter = contract.charter ?? {}
  const affected = (Array.isArray(charter.affectedCharacters) ? charter.affectedCharacters : []).map(String).filter(Boolean)
  const keywords = [...new Set([
    ...(Array.isArray(charter.keywords) ? charter.keywords : []),
    ...affected,
  ].map(String).filter(Boolean))]
  if (keywords.length === 0) return { keywords: [], chapters: [], uncovered: (bundle.chapters ?? []).length }

  const edges = parseRelationships(bundle.characters ?? [])
  const related = new Map()
  for (const name of affected) {
    for (const edge of edges) {
      if (edge.from === name) related.set(edge.to, edge.relation || '相关')
      if (edge.to === name) related.set(edge.from, edge.relation || '相关')
    }
  }

  const rows = new Map()
  const touch = (id, title, reason) => {
    const key = String(id)
    const row = rows.get(key) ?? { chapter: key, title: title ?? '', matched: [] }
    if (!row.matched.includes(reason)) row.matched.push(reason)
    rows.set(key, row)
  }

  for (const chapter of bundle.chapters ?? []) {
    if (!String(chapter?.content ?? '').trim()) continue
    const cast = Array.isArray(chapter.characters) ? chapter.characters.map(String) : []
    for (const name of affected) {
      if (cast.includes(name) || String(chapter.content).includes(name)) touch(chapter.id, chapter.title, name)
    }
    for (const [name, relation] of related) {
      if (cast.includes(name)) touch(chapter.id, chapter.title, `${name}(${relation})`)
    }
  }

  for (const event of bundle.events ?? []) {
    const participants = (Array.isArray(event?.participants) ? event.participants : []).map(String)
    if (!participants.some((name) => affected.includes(name))) continue
    if (!event?.chapter) continue
    const chapter = (bundle.chapters ?? []).find((c) => String(c.id) === String(event.chapter))
    touch(event.chapter, chapter?.title, `事件:${event.title ?? ''}`)
  }

  const chapters = [...rows.values()]
    .map((row) => ({ ...row, direct: row.matched.some((m) => affected.includes(m)) }))
    .sort((a, b) => Number(b.direct) - Number(a.direct) || b.matched.length - a.matched.length)
  return { keywords, chapters, uncovered: (bundle.chapters ?? []).length - chapters.length }
}

/** 契约 + 影响面 → 批次计划（纯函数；持久化由调用端负责）。 */
export function planRevisionForBundle(bundle = {}, contract = {}, options = {}) {
  const validation = validateRevisionContract(contract)
  if (!validation.ok) return { ok: false, errors: validation.errors }
  const impact = buildImpactFromBundle(bundle, contract)
  const batches = planRevisionBatches(contract, options)
  return {
    ok: true,
    errors: [],
    tier: validation.tier,
    policy: revisionGatePolicy(validation.tier, { stopMode: contract.stopMode }),
    impact,
    batches,
    gates: validation.tier.gates,
  }
}
