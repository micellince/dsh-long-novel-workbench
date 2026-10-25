/**
 * 段落索引：0.7 所有「地址」的唯一来源。
 *
 * 设计（作者定的）：
 *  - 正文 .txt 首行是回目标题，标题属于正文、可被选中；
 *  - 段落是不可再分的地址单位：pid = c<章>p<段号>，hash = 段落文本指纹；
 *  - bodyHash 只算正文、不含标题行：改标题不影响注意力分数与账本；
 *  - 大改后靠「段落 hash 精确 → 同 hash 移动 → 前缀/相似度」三级重定位，找不到标 stale，绝不删除。
 *
 * 本模块是纯函数，不碰文件系统。
 */

import { createHash } from 'node:crypto'

/** 回目标题识别：第X回/章/节 或 序章/楔子/引子/尾声/终章/番外。 */
const TITLE_RE = /^(第\s*[0-9零〇一二三四五六七八九十百千两]{1,8}\s*[回章节卷部篇]|序章|楔子|引子|尾声|终章|番外)/

/** 正文摘要前缀长度（用于重定位与 UI 预览）。 */
const HEAD_LEN = 16

/** 12 位 sha1：和旧 contentHash 同口径、够短。 */
export function sha12(value) {
  return createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 12)
}

/** 统一换行。 */
export function newline(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n')
}

/**
 * 拆出「首行标题 + 正文」。
 * 只有首行像回目、且不超过 60 字时才认作标题；否则整篇都是正文（兼容 0.6 旧章）。
 */
export function splitTitle(text, titleHint = '') {
  const value = newline(text)
  const lines = value.split('\n')
  let i = 0
  while (i < lines.length && !lines[i].trim()) i += 1
  if (i >= lines.length) return { title: '', body: '' }
  const first = lines[i].trim()
  const hint = String(titleHint ?? '').trim()
  // 认标题：标准回目格式，或与 meta.title 逐字相同（非「第X回」的短标题如「破城之日」也能认）
  if (first.length <= 60 && (TITLE_RE.test(first) || (hint && first === hint))) {
    const body = lines.slice(i + 1).join('\n').replace(/^\n+/, '')
    return { title: first, body }
  }
  return { title: '', body: value }
}

/**
 * 按空行切段，同时记录段落在正文里的字符区间。
 * 单换行保留在段内（保持作者排版）。
 */
export function splitParagraphs(body) {
  const value = newline(body)
  const out = []
  let cursor = 0
  for (const chunk of value.split(/\n[ \t]*\n/)) {
    const at = value.indexOf(chunk, cursor)
    const start = at < 0 ? cursor : at
    const end = start + chunk.length
    cursor = end
    const text = chunk.replace(/^\n+|\n+$/g, '')
    if (!text.trim()) continue
    out.push({ i: out.length, text, start, end })
  }
  return out
}

/** 构建章节索引（纯计算）。 */
export function buildIndex(text, chapter, titleHint = '') {
  const n = Number(chapter) || 0
  const { title, body } = splitTitle(text, titleHint)
  const paras = splitParagraphs(body).map((p) => ({
    i: p.i,
    pid: `c${n}p${p.i}`,
    hash: sha12(p.text),
    head: p.text.slice(0, HEAD_LEN),
    start: p.start,
    end: p.end,
  }))
  return {
    chapter: n,
    title,
    titleHash: sha12(title),
    bodyHash: sha12(body),
    paras,
    builtAt: new Date().toISOString(),
  }
}

/** 段落文本（索引里不存全文，按需从正文切）。 */
export function paragraphText(body, para) {
  if (!para || !Number.isFinite(para.start)) return ''
  return newline(body).slice(para.start, para.end)
}

/** 归一化：空白与引号不影响匹配。 */
export function squash(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/[“”‘’「」『』"']/g, '')
}

/** 按引文找段落；找不到返回 -1；命中标题返回 -2（title 不是段落）。 */
export function findParagraphByQuote(index, quote) {
  if (!index || !quote) return -1
  const needle = squash(quote)
  if (!needle) return -1
  if (index.title && squash(index.title).includes(needle)) return -2
  for (const para of index.paras) {
    if (squash(paraTextOf(index, para)).includes(needle)) return para.i
  }
  return -1
}

// 索引本身不存全文时，调用方用 paragraphText(body, para)；这里留一个钩子给带文本的索引。
function paraTextOf(index, para) {
  if (para && typeof para.text === 'string') return para.text
  return index && typeof index.body === 'string' ? paragraphText(index.body, para) : ''
}

/** 给索引补全文（只在需要引文定位时调用）。 */
export function withBody(index, text) {
  const { body } = splitTitle(text)
  return { ...index, body }
}

/**
 * 段落级 diff：只报「变了什么」，供账本增量同步与意见重定位用。
 * 返回 { changed:[段号], added:[段号], removed:[段号], moved:[{from,to}] }
 */
export function diffIndex(prev, next) {
  const before = Array.isArray(prev?.paras) ? prev.paras : []
  const after = Array.isArray(next?.paras) ? next.paras : []
  const changed = []
  const added = []
  const removed = []
  const moved = []
  const beforeByHash = new Map()
  before.forEach((p) => {
    const list = beforeByHash.get(p.hash) || []
    list.push(p.i)
    beforeByHash.set(p.hash, list)
  })
  const used = new Set()
  after.forEach((p) => {
    if (p.i < before.length && before[p.i] && before[p.i].hash === p.hash) {
      used.add(p.i)
      return
    }
    const pool = beforeByHash.get(p.hash)
    const from = pool && pool.find((i) => !used.has(i))
    if (from != null) {
      used.add(from)
      if (from !== p.i) moved.push({ from, to: p.i })
      return
    }
    if (p.i < before.length && before[p.i]) changed.push(p.i)
    else added.push(p.i)
  })
  before.forEach((p) => {
    if (!used.has(p.i) && !after.some((q) => q.i === p.i && q.hash !== p.hash)) removed.push(p.i)
  })
  return { changed, added, removed, moved }
}

/**
 * 单条地址重定位：同一段没变 → same；同 hash 挪了位置 → moved；找不到 → lost。
 * @param {{i?:number,pid?:string,hash?:string}} pin
 */
export function reanchor(prev, next, pin) {
  const hash = String(pin?.hash ?? '')
  const i = Number(pin?.i ?? (String(pin?.pid ?? '').match(/p(\d+)$/)?.[1] ?? -1))
  const after = Array.isArray(next?.paras) ? next.paras : []
  if (!hash) return { status: 'lost', reason: '缺少段落指纹' }
  if (i >= 0 && after[i] && after[i].hash === hash) {
    return { status: 'same', i, pid: after[i].pid }
  }
  const found = after.findIndex((p) => p.hash === hash)
  if (found >= 0) return { status: 'moved', i: found, pid: after[found].pid }
  // 前缀近似：段首 8 字相同且只命中一段 → 视为「疑似同段」（只给候选，不自动改）
  const head = String(pin?.head ?? '').slice(0, 8)
  if (head) {
    const guess = after.filter((p) => p.head.startsWith(head))
    if (guess.length === 1) return { status: 'guess', i: guess[0].i, pid: guess[0].pid }
  }
  return { status: 'lost' }
}
