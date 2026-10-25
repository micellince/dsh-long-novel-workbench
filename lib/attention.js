/**
 * 注意力纯函数（契约 §5）。
 *
 * 0.6 的 attention.json 是**数组**：每章一条记录；
 * 四拍 hook/tension/payoff/cliff 是文字设计，数值在 breakdown（满分 20/20/30/30），
 * score = sum(breakdown)，designScore 是独立的设计分（0–100）。
 * 本文件只做纯计算，不读写磁盘。
 */

/** 四拍满分（数值唯一来源）。 */
export const BEAT_MAX = { hook: 20, tension: 20, payoff: 30, cliff: 30 }

/** 四拍中文名。 */
export const BEAT_LABEL = { hook: '钩子', tension: '张力', payoff: '回报', cliff: '章末牵引' }

/** 四拍固定顺序。 */
export const BEATS = ['hook', 'tension', 'payoff', 'cliff']

/** 取数值；空/非数返回 null。 */
function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 四拍数值加总并夹紧到 0–100；一个有效拍都没有时返回 null。 */
export function scoreOf(beats) {
  let sum = 0
  let any = false
  for (const key of BEATS) {
    const n = num(beats?.[key])
    if (n === null) continue
    any = true
    sum += n
  }
  return any ? Math.max(0, Math.min(100, Math.round(sum))) : null
}

/** 低于 0.6 × 满分的环节（按弱到强排序）。 */
export function deficitsOf(beats) {
  const rows = []
  for (const key of BEATS) {
    const max = BEAT_MAX[key]
    const n = num(beats?.[key])
    const ratio = n === null ? 0 : n / max
    if (ratio < 0.6) rows.push({ key, ratio })
  }
  return rows.sort((a, b) => a.ratio - b.ratio).map((row) => row.key)
}

/**
 * 设计分与实测分之差（正数=实测低于设计）。
 * @param {number|object} design 设计分，或含 designScore / score 的记录
 * @param {number} [score] 实测分（省略时尝试从 design.measured.score / design.score 取）
 */
export function designGap(design, score) {
  const d = num(typeof design === 'object' && design !== null ? design.designScore ?? design.design?.score ?? design.score : design)
  const s = num(score) ?? (typeof design === 'object' && design !== null ? num(design.measured?.score ?? design.score) : null)
  if (d === null || s === null) return null
  return d - s
}

/** 把数组形状（或旧 {chapters:{}} 形状）统一成按章号升序的数组。 */
export function byChapter(attention) {
  let list = []
  if (Array.isArray(attention)) list = attention
  else if (attention && typeof attention === 'object') list = Object.values(attention.chapters ?? {}).flat()
  const rows = list.filter((item) => item && Number.isFinite(Number(item.chapter)))
  return rows.sort((a, b) => Number(a.chapter) - Number(b.chapter))
}

/** 注意力统计：平均分 / 已打分章数 / 未打分章数 / 最弱环节（无数据时 weakest=null）。 */
export function stats(attention) {
  const rows = byChapter(attention)
  const scored = rows.filter((item) => num(item.score) !== null)
  const avg = scored.length
    ? Math.round((scored.reduce((sum, item) => sum + num(item.score), 0) / scored.length) * 10) / 10
    : null
  const totals = { hook: 0, tension: 0, payoff: 0, cliff: 0 }
  let beats = 0
  for (const item of scored) {
    if (!item.breakdown || typeof item.breakdown !== 'object') continue
    beats += 1
    for (const key of BEATS) totals[key] += num(item.breakdown[key]) ?? 0
  }
  let weakest = null
  if (beats) {
    let low = Infinity
    for (const key of BEATS) {
      const ratio = totals[key] / (beats * BEAT_MAX[key])
      if (ratio < low) {
        low = ratio
        weakest = key
      }
    }
  }
  return { avg, scored: scored.length, unscored: rows.length - scored.length, weakest }
}

/** 每个弱环节对应的补强动作（具体、可执行；未知环节给通用句）。 */
const WEAK_ACTION = {
  hook: '补钩子：开篇 100 字内抛出一个具体悬念或反常画面（物件、动作、未答问句），不要先交代背景。',
  tension: '补张力：给主角一个当场对抗的人或时限，让压力在第一屏内可见，而不是靠旁白说明危险。',
  payoff: '补回报：把本章承诺的爽点（反转、打脸、答案）当场兑现，至少落在一个动作或一句可复述的台词上。',
  cliff: '补章末牵引：结尾留一个具体、非读下一章不可的理由（新线索/威胁/决定），不要用总结式收束。',
}

/** 由 deficitsOf 的结果生成补强文案（去重，保持输入顺序）。 */
export function weakActions(deficits) {
  const keys = (Array.isArray(deficits) ? deficits : [deficits])
    .map((item) => (typeof item === 'string' ? item : item?.key ?? item?.beat ?? item?.target))
    .filter(Boolean)
  const out = []
  const seen = new Set()
  for (const key of keys) {
    if (seen.has(key)) continue
    seen.add(key)
    out.push(WEAK_ACTION[key] ?? `补「${BEAT_LABEL[key] ?? key}」：本章这一拍偏弱，按四拍拆解后补一个具体动作或冲突。`)
  }
  return out
}
