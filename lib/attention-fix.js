/**
 * 注意力提分闭环：确定性诊断 + 段落级补丁校验。
 * 契约见 docs/ATTENTION-FIX.md。本模块不读写磁盘（除 hash 计算），纯函数，方便测试与复用。
 */
import { createHash } from 'node:crypto'

/** 四拍（满分 25）。顺序也是卡片/工作单的展示顺序。 */
export const ATTENTION_BEATS = ['hook', 'tension', 'payoff', 'cliff']
export const ATTENTION_BEAT_LABEL = { hook: '钩子', tension: '张力', payoff: '兑现', cliff: '章末' }
export const ATTENTION_BEAT_MAX = 25
/** 单拍低于这个分数视为“明显偏弱”，是提分方案的第一目标。 */
export const ATTENTION_BEAT_WEAK = 13
/** 单拍低于这个分数视为“次弱”，可以顺带补一条。 */
export const ATTENTION_BEAT_LOW = 12
/** 设计分与实测分相差到这个程度，说明设计没兑现（设计再漂亮也没用）。 */
export const ATTENTION_DESIGN_GAP = 20
/** 高于这个分的章节不再排进提分队列（边际收益低）。 */
export const ATTENTION_GOOD_SCORE = 88
export const ATTENTION_FIX_TARGETS = ['hook', 'tension', 'payoff', 'cliff', 'type', 'language']
export const ATTENTION_FIX_MIN_ITEMS = 3
export const ATTENTION_FIX_MAX_ITEMS = 12
export const ATTENTION_GAIN_MIN = 1
export const ATTENTION_GAIN_MAX = 15
export const ATTENTION_FIX_MAX_TOTAL = 40
export const ATTENTION_BEFORE_MIN = 4
export const ATTENTION_BEFORE_MAX = 600
export const ATTENTION_FIX_LOG_LIMIT = 12
export const ATTENTION_SCORE_HISTORY_LIMIT = 10

/** 正文指纹：分数绑定的是哪一版正文。前 12 位足够区分。 */
export function contentHash(content) {
  return createHash('sha1').update(String(content ?? ''), 'utf8').digest('hex').slice(0, 12)
}

/** 0-100 分数：空/非法值 = 未打分（null）。 */
export function attentionScoreOf(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 四拍分数：只取 0-25 的合法数字，缺失返回 null。 */
export function attentionBeatScore(breakdown, beat) {
  if (!breakdown || typeof breakdown !== 'object') return null
  const n = Number(breakdown[beat])
  if (!Number.isFinite(n)) return null
  return Math.min(ATTENTION_BEAT_MAX, Math.max(0, n))
}

/** 按章号索引注意力记录（同章多条时以最后一条为准）。 */
export function attentionByChapter(list) {
  const map = new Map()
  for (const record of Array.isArray(list) ? list : []) {
    const n = Number(record?.chapter)
    if (!Number.isFinite(n) || n <= 0) continue
    map.set(n, record)
  }
  return new Map([...map.entries()].sort((a, b) => a[0] - b[0]))
}

/**
 * 诊断一章的提分空间：返回 [{id,target,gap,severity,evidence,prescribe,suggestGain}]，按严重度降序。
 * severity 3 = 必须改；2 = 建议改；1 = 锦上添花。
 */
export function attentionDeficits(record) {
  const deficits = []
  if (!record || typeof record !== 'object') return deficits
  const score = attentionScoreOf(record.score)
  if (score === null) {
    return [{
      id: 'need-cold-read',
      target: 'score',
      gap: null,
      severity: 3,
      evidence: '还没有实测分，无法定位最弱一环',
      prescribe: '先做一次零上下文冷读打分（novel_desk_attention_fix op=recheck 或冷读任务）',
      suggestGain: null,
    }]
  }
  const designScore = attentionScoreOf(record.designScore)
  const gap = designScore === null ? null : designScore - score
  if (gap !== null && gap >= ATTENTION_DESIGN_GAP) {
    deficits.push({
      id: 'design-gap',
      target: 'overall',
      gap,
      severity: 3,
      evidence: `设计目标 ${designScore} 分，实测只有 ${score} 分，差 ${Math.round(gap)} 分`,
      prescribe: `重点补${ATTENTION_BEAT_LABEL[String(record.weakest ?? '')] ? `最弱拍「${ATTENTION_BEAT_LABEL[record.weakest]}」` : '最弱一环'}：设计里的钩子/张力/兑现必须在正文里落地`,
      suggestGain: Math.min(12, Math.max(4, Math.round(gap / 2))),
    })
  }
  const breakdown = record.breakdown && typeof record.breakdown === 'object' ? record.breakdown : null
  const weakest = String(record.weakest ?? '').trim()
  if (!breakdown) {
    deficits.push({
      id: 'need-breakdown',
      target: 'overall',
      gap: null,
      severity: 2,
      evidence: '没有四拍分（breakdown），只能按最弱一环笼统补',
      prescribe: '下次复测时补 breakdown（hook/tension/payoff/cliff 各 0-25），才能指定每条方案补哪一拍',
      suggestGain: 3,
    })
  }
  for (const beat of ATTENTION_BEATS) {
    const beatScore = attentionBeatScore(breakdown, beat)
    const textEmpty = !String(record[beat] ?? '').trim()
    if (beat === weakest && (textEmpty || (beatScore !== null && beatScore < ATTENTION_BEAT_WEAK))) {
      const pointGap = beatScore === null ? 8 : ATTENTION_BEAT_WEAK - beatScore
      deficits.push({
        id: `weak-${beat}`,
        target: beat,
        gap: pointGap,
        severity: 3,
        evidence: textEmpty
          ? `最弱一环是${ATTENTION_BEAT_LABEL[beat]}，但记录里这一拍是空的`
          : `最弱一环是${ATTENTION_BEAT_LABEL[beat]}，只有 ${beatScore}/${ATTENTION_BEAT_MAX} 分`,
        prescribe: `至少两条方案直接补${ATTENTION_BEAT_LABEL[beat]}：把${ATTENTION_BEAT_LABEL[beat]}从「有」改成「强」`,
        suggestGain: Math.min(10, Math.max(4, pointGap + 2)),
      })
      continue
    }
    if (beat !== weakest && beatScore !== null && beatScore < ATTENTION_BEAT_LOW) {
      deficits.push({
        id: `second-weak-${beat}`,
        target: beat,
        gap: ATTENTION_BEAT_LOW - beatScore,
        severity: 2,
        evidence: `${ATTENTION_BEAT_LABEL[beat]}只有 ${beatScore}/${ATTENTION_BEAT_MAX} 分（次弱）`,
        prescribe: `顺带补一条${ATTENTION_BEAT_LABEL[beat]}（局部加一句/一个动作即可，不必重写）`,
        suggestGain: Math.min(6, Math.max(2, ATTENTION_BEAT_LOW - beatScore)),
      })
    }
  }
  const dropPoints = Array.isArray(record.dropPoints) ? record.dropPoints.filter((p) => p && String(p.quote ?? '').trim()) : []
  if (dropPoints.length > 0) {
    const first = dropPoints[0]
    deficits.push({
      id: 'drop-point',
      target: 'drop-point',
      gap: dropPoints.length * 4,
      severity: 3,
      evidence: `冷读标记了 ${dropPoints.length} 个弃读点，第一个在「${String(first.quote).slice(0, 60)}」`,
      prescribe: '必须有一条方案直接改这几处原文（before 就抄弃读点那句），弃读点不除，补什么都白搭',
      suggestGain: Math.min(10, 4 + dropPoints.length * 2),
    })
  }
  const type = String(record.type ?? '').trim()
  if (!type) {
    deficits.push({
      id: 'need-type',
      target: 'type',
      gap: null,
      severity: 1,
      evidence: '没有注意力类型（event/emotion/language/mystery/relationship）',
      prescribe: '补一条 type 设计，并确认和第 n-1、n-2 章不是同一型（同型连续 >3 章会疲劳）',
      suggestGain: 2,
    })
  }
  return deficits.sort((a, b) => b.severity - a.severity)
}

/**
 * 提分工作单最少几条：严重项越多要求越多，但至少 3 条、最多 6 条。
 * @param {Array} deficits attentionDeficits 的结果
 */
export function attentionMinFixes(deficits) {
  const severe = (Array.isArray(deficits) ? deficits : []).filter((d) => d && d.severity >= 3).length
  return Math.max(ATTENTION_FIX_MIN_ITEMS, Math.min(6, 2 + severe))
}

/** 全书已打分章节的平均分（没有已打分章节返回 null）。 */
export function attentionAverageScore(attentionList) {
  const scores = (Array.isArray(attentionList) ? attentionList : [])
    .map((record) => attentionScoreOf(record?.score))
    .filter((n) => n !== null)
  if (scores.length === 0) return null
  return Math.round((scores.reduce((sum, n) => sum + n, 0) / scores.length) * 10) / 10
}

/** 没有任何实测分的已写章节（提分前必须先冷读）。 */
export function attentionUnscoredChapters(bundle) {
  const map = attentionByChapter(bundle?.attention)
  const out = []
  for (const chapter of Array.isArray(bundle?.chapters) ? bundle.chapters : []) {
    const n = Number(chapter?.id)
    if (!Number.isFinite(n)) continue
    if (!String(chapter?.content ?? '').trim()) continue
    const record = map.get(n)
    if (attentionScoreOf(record?.score) === null) out.push(n)
  }
  return out.sort((a, b) => a - b)
}

/**
 * 提分候选章节：按“提分空间”降序。
 * potential = (设计分 ?? 全书均值+8 ?? 80) - 实测分 + design-gap(≥20) 5 分 + 有弃读点 3 分
 * 排除未打分与已达标（≥88）章节。
 */
export function attentionFixCandidates(bundle) {
  const attentionList = Array.isArray(bundle?.attention) ? bundle.attention : []
  const map = attentionByChapter(attentionList)
  const average = attentionAverageScore(attentionList)
  const defaultTarget = average === null ? 80 : Math.min(95, Math.round(average + 8))
  const pendingFix = new Map()
  for (const proposal of Array.isArray(bundle?.proposals) ? bundle.proposals : []) {
    if (proposal?.status !== 'pending' || proposal?.kind !== 'attention-fix') continue
    const n = Number(proposal.chapter ?? proposal.data?.chapter)
    if (!Number.isFinite(n)) continue
    pendingFix.set(n, (pendingFix.get(n) ?? 0) + 1)
  }
  const chapters = Array.isArray(bundle?.chapters) ? bundle.chapters : []
  const contentByChapter = new Map()
  for (const chapter of chapters) {
    const n = Number(chapter?.id)
    if (Number.isFinite(n)) contentByChapter.set(n, String(chapter?.content ?? ''))
  }
  const rows = []
  for (const [n, record] of map) {
    const score = attentionScoreOf(record.score)
    if (score === null || score >= ATTENTION_GOOD_SCORE) continue
    const designScore = attentionScoreOf(record.designScore)
    const target = designScore ?? defaultTarget
    const designGap = designScore === null ? 0 : designScore - score
    const dropPoints = Array.isArray(record.dropPoints) ? record.dropPoints.filter((p) => p && String(p.quote ?? '').trim()).length : 0
    const potential = Math.round(target - score + (designGap >= ATTENTION_DESIGN_GAP ? 5 : 0) + (dropPoints > 0 ? 3 : 0))
    const deficits = attentionDeficits(record)
    const scoredHash = String(record.scoredHash ?? '').trim()
    const content = contentByChapter.get(n) ?? ''
    const recheckPending = record.recheckPending === true
    rows.push({
      chapter: n,
      record,
      score,
      designScore,
      target,
      potential,
      weakest: String(record.weakest ?? '').trim(),
      dropPointCount: dropPoints,
      deficits,
      minFixes: attentionMinFixes(deficits),
      recheckPending,
      pendingFixes: pendingFix.get(n) ?? 0,
      fixCount: Array.isArray(record.fixLog) ? record.fixLog.length : 0,
      lastDelta: attentionScoreOf(record.lastRecheckDelta),
      stale: Boolean(scoredHash) && !recheckPending && Boolean(content) && contentHash(content) !== scoredHash,
    })
  }
  return rows.sort((a, b) => b.potential - a.potential || a.chapter - b.chapter)
}

/** 提分闭环统计（界面/工具/上下文共用）。 */
export function attentionFixStats(bundle) {
  const records = (Array.isArray(bundle?.attention) ? bundle.attention : []).filter((r) => r && typeof r === 'object')
  let pendingRecheck = 0
  let verified = 0
  let fixCount = 0
  let noGain = 0
  const deltas = []
  for (const record of records) {
    if (record.recheckPending === true) pendingRecheck += 1
    fixCount += Array.isArray(record.fixLog) ? record.fixLog.length : 0
    const rechecks = (Array.isArray(record.scoreHistory) ? record.scoreHistory : [])
      .filter((entry) => entry && entry.source === 'recheck' && Number.isFinite(Number(entry.delta)))
    if (rechecks.length > 0) {
      verified += 1
      for (const entry of rechecks) deltas.push(Number(entry.delta))
      const last = rechecks[rechecks.length - 1]
      if (Number(last.delta) <= 0 && Array.isArray(record.fixLog) && record.fixLog.length > 0) noGain += 1
    }
  }
  const sum = deltas.reduce((acc, n) => acc + n, 0)
  const pendingFixProposals = (Array.isArray(bundle?.proposals) ? bundle.proposals : [])
    .filter((p) => p?.status === 'pending' && p?.kind === 'attention-fix').length
  return {
    pendingRecheck,
    verified,
    fixCount,
    noGain,
    pendingFixProposals,
    avgDelta: deltas.length > 0 ? Math.round((sum / deltas.length) * 10) / 10 : null,
    bestDelta: deltas.length > 0 ? Math.max(...deltas) : null,
    worstDelta: deltas.length > 0 ? Math.min(...deltas) : null,
  }
}

function attentionFixError(message) {
  return new Error(`提分方案不合格：${message}`)
}

/**
 * 定位 before 片段：每条必须逐字唯一命中，且互不重叠。
 * @returns {Array<{index:number, at:number, end:number, item:object, after:string}>}
 */
export function locateAttentionFixSpans(content, items) {
  const text = String(content ?? '')
  if (!text.trim()) throw attentionFixError('该章还没有正文，无法按段落提分（先写正文）')
  if (!Array.isArray(items) || items.length === 0) {
    throw attentionFixError(`至少要 ${ATTENTION_FIX_MIN_ITEMS} 条 before/after 补丁（现在 0 条）`)
  }
  const spans = []
  items.forEach((raw, index) => {
    const no = index + 1
    const item = raw && typeof raw === 'object' ? raw : {}
    const before = String(item.before ?? '')
    const after = String(item.after ?? '')
    if (before.trim().length < ATTENTION_BEFORE_MIN) throw attentionFixError(`第 ${no} 条 before 太短（至少 ${ATTENTION_BEFORE_MIN} 字），要抄完整一句/一段原文`)
    if (before.length > ATTENTION_BEFORE_MAX) throw attentionFixError(`第 ${no} 条 before 太长（>${ATTENTION_BEFORE_MAX} 字），只抄要改的那一段`)
    if (!after.trim()) throw attentionFixError(`第 ${no} 条缺 after（改写后的文字）`)
    if (after.trim() === before.trim()) throw attentionFixError(`第 ${no} 条 after 和 before 一样，等于没改`)
    const at = text.indexOf(before)
    if (at < 0) throw attentionFixError(`第 ${no} 条 before 在正文里找不到——before 必须逐字复制该章原文（不要改写、不要加省略号）`)
    if (text.indexOf(before, at + 1) >= 0) throw attentionFixError(`第 ${no} 条 before 在正文里出现多次，带上前一句或后一句让它唯一`)
    spans.push({ index, no, at, end: at + before.length, item, after })
  })
  spans.sort((a, b) => a.at - b.at)
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].at < spans[i - 1].end) {
      throw attentionFixError(`第 ${spans[i - 1].no} 条和第 ${spans[i].no} 条的 before 有重叠，把重叠部分只留在一个片段里`)
    }
  }
  return spans
}

/**
 * 校验并应用段落级补丁（只改 before→after，其余原样保留）。
 * @returns {{content:string, applied:Array<object>}}
 */
export function applyAttentionFixes(content, items) {
  const text = String(content ?? '')
  const spans = locateAttentionFixSpans(text, items)
  let out = ''
  let cursor = 0
  const applied = []
  for (const span of spans) {
    out += text.slice(cursor, span.at) + span.after
    cursor = span.end
    const item = span.item
    applied.push({
      index: span.no,
      target: String(item.target ?? '').trim(),
      weak: String(item.weak ?? '').trim(),
      expectedGain: Number(item.expectedGain) || 0,
      why: String(item.why ?? '').trim(),
      beforeLength: span.end - span.at,
      afterLength: span.after.length,
    })
  }
  out += text.slice(cursor)
  return { content: out, applied }
}

/**
 * 提案硬校验（createProposal 调用）：条数 / 目标覆盖 / 增益上限 / before 必须来自正文。
 * 不合规直接抛中文错误，让 AI 能看懂缺什么。
 */
export function assertAttentionFixPayload(data, chapterContent) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw attentionFixError('data 必须是对象，含 chapter / items / expectedGainTotal')
  const items = data.items
  if (!Array.isArray(items)) throw attentionFixError('data.items 必须是数组')
  if (items.length < ATTENTION_FIX_MIN_ITEMS) {
    throw attentionFixError(`data.items 只有 ${items.length} 条，至少要 ${ATTENTION_FIX_MIN_ITEMS} 条（哪章都不止一个问题）`)
  }
  if (items.length > ATTENTION_FIX_MAX_ITEMS) throw attentionFixError(`data.items 有 ${items.length} 条，超过 ${ATTENTION_FIX_MAX_ITEMS} 条，拆成多次提案或删掉边角补丁`)
  const targets = new Set()
  let total = 0
  items.forEach((raw, index) => {
    const no = index + 1
    const item = raw && typeof raw === 'object' ? raw : {}
    const target = String(item.target ?? '').trim()
    if (!ATTENTION_FIX_TARGETS.includes(target)) {
      throw attentionFixError(`第 ${no} 条 target 是「${target || '空'}」，只能是 ${ATTENTION_FIX_TARGETS.join('/')}`)
    }
    targets.add(target)
    const gain = Number(item.expectedGain)
    if (!Number.isInteger(gain) || gain < ATTENTION_GAIN_MIN || gain > ATTENTION_GAIN_MAX) {
      throw attentionFixError(`第 ${no} 条 expectedGain 必须是 ${ATTENTION_GAIN_MIN}-${ATTENTION_GAIN_MAX} 的整数（现在 ${item.expectedGain ?? '空'}）`)
    }
    total += gain
    if (!String(item.why ?? '').trim()) throw attentionFixError(`第 ${no} 条缺 why（为什么这样改能提分，引用四拍分或弃读点）`)
  })
  if (targets.size < 2) throw attentionFixError(`${items.length} 条补丁都只补「${[...targets][0] ?? '同一处'}」，至少覆盖 2 个不同 target（最弱拍 + 弃读点/次弱拍）`)
  if (total > ATTENTION_FIX_MAX_TOTAL) throw attentionFixError(`预计提分合计 ${total} 分，超过一章上限 ${ATTENTION_FIX_MAX_TOTAL} 分；估值虚高，按每条 3-8 分重估`)
  // 最后做逐字定位（会同时校验唯一性与重叠）
  locateAttentionFixSpans(chapterContent, items)
  return { items, total, targets: [...targets] }
}
