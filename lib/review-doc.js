/**
 * 审稿材料：导出 TXT + 事实/逻辑自动扫库候选（0 AI）。
 *
 * 设计（与 docs/0.7-PROBLEM-WORKFLOW.md v2、0.7.1 实施契约 §3 一致）：
 *  - 两档审稿都要求「一份 TXT、一个 AI 从头读到尾」，所以导出的 TXT 是唯一材料：
 *    每章前固定 `===== 第N章 标题 =====` 分隔，不许 AI 拆章、不许分章转交子 agent。
 *  - 各章正文首行若是回目，会被提升到分隔行里（正文只留段落），这样 TXT 里的正文段落序号
 *    与库内 para（从 0 开始、不含标题）严格一致，AI 给的 para/quote 才能直接落到问题单。
 *  - 扫库候选只复用 lib/localchecks.js 的确定性检查（0 AI），只取 kind==='logic'；
 *    deai 类候选属于通读档，不在这里出现。
 *
 * 本模块只写 <作品目录>/manuscripts/ 下的 TXT，不碰正文与数据库。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { scanChapterLocal } from './localchecks.js'
import { buildIndex, splitTitle } from './paras.js'

/** 首行像回目：第X回/章/节/卷/部/篇，或 序章/楔子/引子/尾声/终章/番外。 */
const TITLE_START_RE = /^(第\s*[0-9零〇一二三四五六七八九十百千两]{1,8}\s*[回章节卷部篇]|序章|楔子|引子|尾声|终章|番外)/

/** 统一换行（与 lib/paras.js 同口径）。 */
function normalizeText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n')
}

/** 范围归一：chapter / cross / global（兼容 range、book 之类旧叫法）。 */
function normalizeScope(scope) {
  const raw = String(scope ?? '').trim().toLowerCase()
  if (raw === 'chapter') return 'chapter'
  if (raw === 'cross' || raw === 'range' || raw === 'chapters') return 'cross'
  return 'global'
}

/** 去重、升序、只留正整数章号。 */
function sortedChapters(values) {
  const out = []
  for (const value of Array.isArray(values) ? values : []) {
    const chapter = Number(value)
    if (Number.isInteger(chapter) && chapter > 0 && !out.includes(chapter)) out.push(chapter)
  }
  return out.sort((a, b) => a - b)
}

/**
 * 文件名里的范围标签：chapter=第N章 / cross=第x-y章（不连续则列章）/ global=全书。
 * 跨章列章最多列 8 个，避免文件名过长。
 */
function scopeLabelOf(scope, chapters) {
  const rows = sortedChapters(chapters)
  if (scope === 'chapter') return rows.length > 0 ? `第${rows[0]}章` : '单章'
  if (scope === 'cross') {
    if (rows.length === 0) return '跨章'
    const contiguous = rows.every((chapter, index) => index === 0 || chapter === rows[index - 1] + 1)
    if (rows.length >= 2 && contiguous) return `第${rows[0]}-${rows[rows.length - 1]}章`
    const head = rows.slice(0, 8)
    return rows.length > head.length ? `第${head.join('、')}章等${rows.length}章` : `第${rows.join('、')}章`
  }
  return '全书'
}

/** 文件名片段：去掉路径分隔符/空白/控制字符，避免 Windows 合法性问题。 */
function safeSegment(value, fallback) {
  const clean = String(value ?? '')
    .replace(/[\\/:*?"<>|\s]+/g, '')
    .replace(/^\.+$/, '')
    .trim()
  return clean || fallback
}

/** 与 coldRead.prepare 同口径的时间戳（14 位）。 */
function defaultStamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

/**
 * 章节分隔行：`===== 第N章 标题 =====`。
 * - 无标题（或 listChapters 的「第 N 章」回落标题）→ 只写章号，避免「第1章 第 1 章」；
 * - 标题本身已带「第X回/章…」→ 直接用作分隔行，不再叠加「第N章」。
 */
function headingOf(chapter, title) {
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return `===== 第${chapter}章 =====`
  if (new RegExp(`^第\\s*${chapter}\\s*[回章节卷部篇]?$`).test(clean)) return `===== 第${chapter}章 =====`
  if (TITLE_START_RE.test(clean)) return `===== ${clean} =====`
  return `===== 第${chapter}章 ${clean} =====`
}

/**
 * 导出审稿 TXT（档 A 通读 / 档 B 事实与逻辑共用）。
 *
 * @param {{dir:string, projectName:string, scope:'chapter'|'cross'|'global', chapters:Array<{chapter:number,title?:string,text:string}>, stamp?:string}} input
 * @returns {Promise<{filePath:string, fileName:string, words:number}>}
 */
export async function exportManuscript({ dir, projectName, scope, chapters, stamp } = {}) {
  const baseDir = String(dir ?? '').trim()
  if (!baseDir) throw new Error('缺少作品目录 dir：无法导出审稿 TXT')

  const rows = []
  for (const row of Array.isArray(chapters) ? chapters : []) {
    const chapter = Number(row?.chapter ?? row?.id)
    if (!Number.isInteger(chapter) || chapter <= 0) continue
    const text = normalizeText(row?.text)
    if (!text.trim()) continue
    const hint = String(row?.title ?? '').trim()
    const parsed = splitTitle(text, hint)
    // 正文只留段落：首行回目提到分隔行里（与库内 para 编号保持一致）。
    const body = String(parsed.body ?? '').replace(/^\n+|\n+$/g, '')
    if (!body.trim()) continue
    rows.push({ chapter, title: parsed.title || hint, body })
  }
  if (rows.length === 0) throw new Error('选中的章节正文都是空的，无法导出审稿 TXT')
  rows.sort((a, b) => a.chapter - b.chapter)

  const scopeKey = normalizeScope(scope)
  const label = scopeLabelOf(scopeKey, rows.map((row) => row.chapter))
  const name = String(projectName ?? '').trim() || '未命名作品'
  const stampText = safeSegment(stamp, '') || defaultStamp()
  const fileName = `审稿-${safeSegment(name, '未命名作品')}-${label}-${stampText}.txt`
  const manuscriptDir = join(baseDir, 'manuscripts')
  const filePath = join(manuscriptDir, fileName)

  const blocks = rows.map((row) => `${headingOf(row.chapter, row.title)}\n\n${row.body}`)
  const content = `${name}\n\n${blocks.join('\n\n')}\n`
  const words = rows.reduce((sum, row) => sum + row.body.length, 0)

  await mkdir(manuscriptDir, { recursive: true })
  await writeFile(filePath, content, 'utf8')

  return { filePath, fileName, words }
}

/**
 * 自动扫库候选：账本数字缺口 / 重复段 / Markdown 残留等确定性检查。
 * 只返回 kind==='logic' 的项，结构为 {chapter,para,paras,quote,message,rule}。
 *
 * @param {{chapters:Array<{chapter:number,text:string,meta?:object}>, facts:Array<{subject:string,attribute?:string,value:string}>}} input
 */
export function scanFactsCandidates({ chapters, facts } = {}) {
  const factRows = Array.isArray(facts) ? facts : []
  const candidates = []
  for (const row of Array.isArray(chapters) ? chapters : []) {
    const chapter = Number(row?.chapter ?? row?.id)
    if (!Number.isInteger(chapter) || chapter <= 0) continue
    const text = normalizeText(row?.text)
    if (!text.trim()) continue
    const meta = row?.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? row.meta : {}
    const titleHint = String(meta.title ?? row?.title ?? '')
    const index = buildIndex(text, chapter, titleHint)
    const body = splitTitle(text, titleHint).body
    // 与 index.js 的 checks.local 完全一致：unknownNames 传 []（启发式噪音大，只由作者/AI 确认后入账）。
    const items = scanChapterLocal({ chapter, text, index: { ...index, body }, unknownNames: [], facts: factRows })
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || item.kind !== 'logic') continue
      const para = Number(item.para)
      candidates.push({
        chapter: Number(item.chapter) || chapter,
        para: Number.isFinite(para) ? para : 0,
        paras: (Array.isArray(item.paras) ? item.paras : [])
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value)),
        quote: String(item.quote ?? ''),
        message: String(item.message ?? ''),
        rule: String(item.rule ?? ''),
      })
    }
  }
  return candidates
}
