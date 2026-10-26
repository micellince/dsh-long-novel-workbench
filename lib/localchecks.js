/**
 * 本地确定性检查（零 AI 成本）：先把能程序判的挑出来，只把可疑点交给 AI。
 * 目前覆盖：
 *  - 逻辑/事实：未登记专名、同章重复段落、Markdown 残留、账本数字在本章缺失
 *  - 去 AI 化：套话/模板化微动作密度、超长段落、长句过多
 * 输出只是「候选点」，不是结论；作者可决定是否让 AI 判。
 */

const AI_PHRASES = /(看了看|顿了顿|停了一停|深吸一口气|缓缓|轻轻|微微|淡淡|嘴角|眼神|心中一动|不由得|忍不住|仿佛|似乎|就像是)/g
const MARKDOWN = /(^#{1,6}\s|\*\*|^---+$|^>\s|```)/

function sentences(paragraph) {
  return String(paragraph || '').split(/[。！？!?…]+/).map((row) => row.trim()).filter(Boolean)
}

function parasContaining(index, needle, limit = 5) {
  const flat = String(needle || '').replace(/\s+/g, '')
  if (!flat) return []
  const out = []
  for (const para of index.paras) {
    const text = (index.body || '').slice(para.start, para.end).replace(/\s+/g, '')
    if (text.includes(flat)) out.push(para.i)
    if (out.length >= limit) break
  }
  return out
}

function attachPara(index, needle) {
  if (!needle) return 0
  const flat = String(needle).replace(/\s+/g, '')
  for (const para of index.paras) {
    const text = (index.body || '').slice(para.start, para.end).replace(/\s+/g, '')
    if (text.includes(flat.slice(0, 8))) return para.i
  }
  return 0
}

/**
 * @param {{chapter:number, text:string, index:object, unknownNames:Array<{name:string,count:number}>, facts:Array<object>}} input
 */
export function scanChapterLocal({ chapter, text, index, unknownNames = [], facts = [] } = {}) {
  const items = []
  const body = index?.body ?? ''
  const paras = Array.isArray(index?.paras) ? index.paras : []
  const seenHash = new Map()
  for (const para of paras) {
    const paraText = body.slice(para.start, para.end)
    const short = paraText.slice(0, 40)
    // 跳过场景分隔/标记/极短行，避免把 ※、【本回完】当成重复段落
    const meaningful = paraText.trim().length >= 20
    if (meaningful && seenHash.has(para.hash)) {
      items.push({ chapter, para: para.i, paras: [seenHash.get(para.hash), para.i], kind: 'logic', rule: 'duplicate-paragraph', quote: short, message: `与第 ${seenHash.get(para.hash) + 1} 段完全重复` })
    } else if (meaningful) {
      seenHash.set(para.hash, para.i)
    }
    if (MARKDOWN.test(paraText)) {
      items.push({ chapter, para: para.i, kind: 'logic', rule: 'markdown', quote: short, message: '段落里有 Markdown 残留（# / ** / --- / > / 反引号）' })
    }
    if (paraText.length > 1500) {
      items.push({ chapter, para: para.i, kind: 'deai', rule: 'long-paragraph', quote: short, message: `段落 ${paraText.length} 字，过长，读者容易在这里弃读` })
    }
    const hits = (paraText.match(AI_PHRASES) || []).length
    if (hits >= 2) {
      items.push({ chapter, para: para.i, kind: 'deai', rule: 'ai-phrases', quote: short, message: `模板化动作/套话密度 ${hits} 处（看了看/顿了顿/缓缓/仿佛…）` })
    }
    const list = sentences(paraText)
    if (list.length >= 3) {
      const avg = list.reduce((sum, row) => sum + row.length, 0) / list.length
      if (avg > 55) items.push({ chapter, para: para.i, kind: 'deai', rule: 'long-sentences', quote: short, message: `平均句长 ${Math.round(avg)} 字，长句过多` })
    }
  }
  for (const row of Array.isArray(unknownNames) ? unknownNames : []) {
    const name = String(row?.name || '')
    if (!name || !text.includes(name)) continue
    items.push({
      chapter,
      para: attachPara(index, name),
      kind: 'logic',
      rule: 'unknown-name',
      quote: name,
      message: `「${name}」出现 ${row.count || 1} 次，但账本里没有这个人物/地点（先确认是否新设定）`,
    })
  }
  const numeric = (Array.isArray(facts) ? facts : []).filter((row) => /^-?\d+(\.\d+)?$/.test(String(row?.value ?? '').trim()))
  for (const fact of numeric.slice(0, 60)) {
    const subject = String(fact.subject || '')
    if (!subject || !text.includes(subject)) continue
    const value = String(fact.value).trim()
    if (text.includes(value)) continue
    items.push({
      chapter,
      para: attachPara(index, subject),
      paras: parasContaining(index, subject),
      kind: 'logic',
      rule: 'fact-number-missing',
      quote: subject,
      message: `正文提到「${subject}」，账本记 ${fact.attribute || '数值'}=${value}，本章没有出现该值（请核对是否为有意省略/改设定）`,
    })
  }
  return items
}
