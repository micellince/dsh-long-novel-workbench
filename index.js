/**
 * dsh-long-novel-workbench 0.7.1 — 宿主层入口（ATTENTION IS ALL YOU NEED）。
 *
 * 职责（全部在这一层收口）：
 *   1) 路由 /novel-desk/api：鉴权 → RPC 分发（40 op：读 20 + 写 20）→ {ok,value|error}
 *   2) 7 个 Agent 工具：novel_desk_read / _dispatch / _propose / _write / _run / _map / _problems
 *   3) Web 客户端 boot 注入：window.__ND_BOOT__ = {apiUrl,...}
 *   4) 写盘唯一通道：AI 正文走 lib/gates.js 的闸门，失败不落盘
 *   5) app.open：用系统默认浏览器打开同一套工作台（复用宿主认证，见 browserUrl）
 *
 * 数据读写全部委托 lib/store.js；本文件不做文件格式实现。
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { mkdir as mkdirP, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import * as store from './lib/store.js'
import { normalizeProse } from './lib/prose.js'
import { writeChapterWithGates, formatGateLine, formatFailures } from './lib/gates.js'
import * as prompts from './lib/prompts.js'
import { estimateSessionCost, loadChatUsage, loadModelPrices } from './lib/usage.js'
import * as bookdb from './lib/bookdb.js'
import { buildIndex, splitTitle, splitParagraphs, findParagraphByQuote } from './lib/paras.js'
import { ROLES, ROLE_BY_ID, roleForSource } from './lib/roles.js'
import { issueTicket, requireTicket, dispatchPrompt } from './lib/dispatch.js'
import * as ledgerdb from './lib/ledgerdb.js'
import { scanChapterLocal } from './lib/localchecks.js'
import * as problems from './lib/problems.js'
import { exportManuscript, scanFactsCandidates } from './lib/review-doc.js'
import { readingPrompt, factsPrompt, revisePrompt, authorBriefPrompt } from './lib/problems-prompts.js'
import { applyMapPlan, parseMapPlan } from './lib/mapplan.js'
import { checkLatest, updateHint, installMode, installLatest, rollback } from './lib/update.js'

export const name = 'novel-desk'
export const inject = ['tools']

export const VERSION = '0.7.2'

/** 启动期错误（装配失败不拖垮 DSH，只记录并在诊断里显示）。 */
const bootErrors = []

/** API 前缀路由（客户端 fetch 相对路径）。 */
export const ROUTE = '/novel-desk/api'

/** 请求体上限：8MB（够一章 20 万字，也挡住误传整库）。 */
const MAX_BODY = 8 * 1024 * 1024

/** 回环 Host 白名单（兜底鉴权；正常路径由 connection.requestRejection 判定）。 */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|\[::ffff:127\.0\.0\.1\])(:\d+)?$/i

/** 读操作 20 个（export.book 只读数据、返回成品文件）。 */
export const READ_OPS = [
  'ping',
  'projects.list',
  'project.context',
  'preset.defaults',
  'chapter.list',
  'chapter.get',
  'chapter.history',
  'chapter.version',
  'chapter.search',
  'review.list',
  'proposal.list',
  'proposal.get',
  'run.get',
  'ledger.get',
  'ledger.sync',
  'align.status',
  'usage.summary',
  'settings.get',
  'chat.sessions',
  'export.book',
  'storage.status',
  'roles.list',
  'update.check',
  'update.install',
  'update.rollback',
  'migrate.titles',
  'diagnostics',
  'chapter.index',
  'checks.local',
  'coldRead.prepare',
  'coldRead.split',
  'coldRead.splitLocal',
  'opinions.list',
  'ledger.digest',
  'ledger.entities',
  'ledger.rebuildMentions',
  'outline.list',
  'ledger.unknown',
  'problems.list',
  'problems.reviews',
  'problems.factsScan',
]

/** 写操作 21 个（app.open = 在默认浏览器打开工作台，不写数据）。 */
export const WRITE_OPS = [
  'app.open',
  'project.create',
  'chapter.save',
  'chapter.delete',
  'review.add',
  'review.patch',
  'proposal.create',
  'proposal.update',
  'proposal.accept',
  'proposal.reject',
  'proposal.batch',
  'attention.merge',
  'ledger.upsert',
  'ledger.delete',
  'settings.save',
  'run.save',
  'run.reset',
  'chat.send',
  'map.background',
  'map.applyPlan',
  'import.scan',
  'import.run',
  'opinions.merge',
  'opinions.patch',
  'opinions.note',
  'opinions.relatedChapters',
  'opinions.accept',
  'opinions.reject',
  'ledger.confirm',
  'outline.upsert',
  'outline.delete',
  'problems.add',
  'problems.note',
  'problems.accept',
  'problems.ignore',
  'problems.restoreDraft',
  'problems.prepareReading',
  'problems.prepareFacts',
  'problems.prepareRevise',
  'problems.prepareBrief',
  'problems.chat',
  'problems.setReviewSession',
]

/** 全部 RPC op（测试与 boot 显示用；顺序 = 读在前写在后）。 */
export const RPC_OPS = [...READ_OPS, ...WRITE_OPS]

/** 全文动作类型：从头写 / 扩写 / 改写（改写再分 文风 / 逻辑与事实 / 结构节奏）。 */
export const RUN_KINDS = ['continue', 'expand', 'rewrite', 'rephrase']
export const RUN_VARIANTS = ['style', 'logic', 'structure']
export const RUN_KIND_LABEL = { continue: '从头写', expand: '扩写', rewrite: '改写', rephrase: '改写' }
export const RUN_VARIANT_LABEL = { style: '文风', logic: '逻辑与事实', structure: '结构与节奏' }

/** 老 run 的 kind/variant 归一：rephrase → rewrite+style；rewrite 缺 variant → logic。 */
export function normalizeRunKind(kind, variant) {
  const raw = String(kind ?? '').trim()
  if (raw === 'rephrase') return { kind: 'rewrite', variant: 'style', legacyKind: 'rephrase' }
  if (raw === 'expand') return { kind: 'expand', variant: '', legacyKind: '' }
  if (raw === 'continue') return { kind: 'continue', variant: '', legacyKind: '' }
  const id = raw === 'rewrite' ? 'rewrite' : raw
  const dial = String(variant ?? '').trim()
  const chosen = RUN_VARIANTS.includes(dial) ? dial : 'logic'
  return { kind: id === 'rewrite' ? 'rewrite' : id, variant: id === 'rewrite' ? chosen : '', legacyKind: '' }
}

/** 每种动作的阶段模板（kind 或 kind:variant）。 */
const RUN_STAGE_SETS = {
  continue: [
    { id: 'attention', title: '先定注意力设计' },
    { id: 'prepare', title: '读大纲与账本' },
    { id: 'plan', title: '规划本章场景' },
    { id: 'write', title: '逐章写作' },
    { id: 'gate', title: '闸门校验' },
    { id: 'review', title: '本章自检' },
  ],
  expand: [
    { id: 'attention', title: '先定注意力设计' },
    { id: 'prepare', title: '定位扩写点' },
    { id: 'plan', title: '生成扩写方案' },
    { id: 'write', title: '逐章扩写' },
    { id: 'gate', title: '闸门校验' },
  ],
  'rewrite:style': [
    { id: 'attention', title: '先定注意力设计' },
    { id: 'prepare', title: '文风校准' },
    { id: 'plan', title: '逐章改写' },
    { id: 'gate', title: '闸门校验' },
  ],
  'rewrite:logic': [
    { id: 'attention', title: '先定注意力设计' },
    { id: 'prepare', title: '通读与事实核对' },
    { id: 'plan', title: '生成改写方案' },
    { id: 'write', title: '逐章重写' },
    { id: 'gate', title: '闸门校验' },
  ],
  'rewrite:structure': [
    { id: 'attention', title: '先定注意力设计' },
    { id: 'prepare', title: '结构梳理' },
    { id: 'plan', title: '生成结构调整方案' },
    { id: 'write', title: '逐章重构' },
    { id: 'gate', title: '闸门校验' },
  ],
}

/** 取阶段模板；未知组合回退到「注意力设计 / 准备 / 写入 / 校验」。 */
export function runStageDefaults(kind, variant) {
  const normalized = normalizeRunKind(kind, variant)
  const key = normalized.kind === 'rewrite' ? `rewrite:${normalized.variant}` : normalized.kind
  const set = RUN_STAGE_SETS[key] ?? RUN_STAGE_SETS[normalized.kind] ?? [
    { id: 'attention', title: '先定注意力设计' },
    { id: 'prepare', title: '准备上下文' },
    { id: 'write', title: '逐章写入' },
    { id: 'gate', title: '闸门校验' },
  ]
  return set.map((stage) => ({ ...stage }))
}

// ── 错误与响应 ──────────────────────────────────────────────

class RpcError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RpcError'
    this.code = code
  }
}

function invalid(message) {
  return new RpcError('invalid', message)
}

function staleError(message) {
  return new RpcError('stale', message)
}

function nowIso() {
  return new Date().toISOString()
}

function need(payload, key, label) {
  const value = payload?.[key]
  if (value === undefined || value === null || String(value).trim() === '') {
    throw invalid(`缺少参数 ${label ?? key}`)
  }
  return value
}

function needNumber(payload, key, label) {
  const value = Number(payload?.[key])
  if (!Number.isFinite(value) || value <= 0) throw invalid(`缺少有效参数 ${label ?? key}`)
  return value
}

function omit(object, keys) {
  const out = {}
  for (const [key, value] of Object.entries(object ?? {})) if (!keys.includes(key)) out[key] = value
  return out
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function sendError(res, error) {
  if (error instanceof RpcError) {
    sendJson(res, 200, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, 200, { ok: false, error: { code: 'internal', message } })
}

// ── 鉴权 ────────────────────────────────────────────────────

function normalizeRejection(rejection) {
  if (rejection === undefined || rejection === null) return undefined
  if (typeof rejection === 'number') return rejection
  if (typeof rejection === 'object') {
    const status = Number(rejection.status ?? rejection.statusCode)
    if (Number.isFinite(status) && status >= 400) return status
    return 403
  }
  return 403
}

function fallbackGuard(req) {
  const headers = req?.headers ?? {}
  const host = String(headers.host ?? '').trim()
  if (!LOOPBACK_HOST.test(host)) return 403
  const site = String(headers['sec-fetch-site'] ?? '').trim().toLowerCase()
  // 浏览器跨源一律拒；无 sec-fetch-site（curl / 宿主内部 fetch）靠 Host 白名单兜底。
  if (site && site !== 'same-origin') return 403
  return undefined
}

/**
 * 鉴权：宿主 connection 优先（undefined = 放行），抛错/无 connection 落回环兜底。
 * @returns {number|undefined} 拒绝时的 HTTP 状态码
 */
export function guard(req, connection) {
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      const rejection = connection.requestRejection({ headers: req?.headers ?? {} })
      if (rejection !== undefined) return normalizeRejection(rejection)
      return undefined
    } catch {
      // 宿主鉴权服务异常：落到回环兜底，不放行任意来源
    }
  }
  return fallbackGuard(req)
}

// ── boot 注入 ───────────────────────────────────────────────

function safeSerialize(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => ({
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  }[char]))
}

/**
 * 把 window.__ND_BOOT__ 插到 </head> 前（幂等；HTML/JS 字符串转义，防脚本截断）。
 * @param {string} html index.html
 * @param {{apiUrl?:string}} [options]
 */
export function injectBoot(html, options = {}) {
  const source = String(html ?? '')
  if (source.includes('window.__ND_BOOT__')) return source
  const boot = { apiUrl: String(options.apiUrl ?? ROUTE), name, version: VERSION }
  const tag = `<script>window.__ND_BOOT__=${safeSerialize(boot)}</script>`
  if (/<\/head\s*>/i.test(source)) return source.replace(/<\/head\s*>/i, `${tag}</head>`)
  return `${tag}${source}`
}

// ── 请求体 ──────────────────────────────────────────────────

class BodyTooLarge extends Error {}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new BodyTooLarge('请求体超过 8MB')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    throw new Error('请求体必须是 JSON 对象')
  } catch (error) {
    if (error instanceof RpcError) throw error
    throw invalid(`请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── 小工具 ──────────────────────────────────────────────────

function chapterNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function textOf(value, limit = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function listOf(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.items)) return value.items
  return []
}

function filterRows(rows, filter) {
  const list = listOf(rows)
  if (!filter || typeof filter !== 'object') return rows
  let out = list
  if (filter.source) out = out.filter((row) => String(row?.source ?? '') === String(filter.source))
  if (filter.status) out = out.filter((row) => String(row?.status ?? '') === String(filter.status))
  if (filter.chapter !== undefined && filter.chapter !== null) out = out.filter((row) => Number(row?.chapter) === Number(filter.chapter))
  return out
}

function normalizeBodyText(text) {
  try {
    const result = normalizeProse(String(text ?? ''))
    return String(result?.text ?? text ?? '')
  } catch {
    return String(text ?? '')
  }
}

function normalizeProposalPayload(raw) {
  const proposal = raw && typeof raw === 'object' ? { ...raw } : {}
  const data = proposal.data && typeof proposal.data === 'object' ? { ...proposal.data } : {}
  if (typeof data.content === 'string') data.content = normalizeBodyText(data.content)
  if (Array.isArray(data.patches)) {
    data.patches = data.patches.map((patch) => {
      const next = patch && typeof patch === 'object' ? { ...patch } : {}
      if (typeof next.after === 'string') next.after = normalizeBodyText(next.after)
      return next
    })
  }
  if (Array.isArray(data.items)) {
    data.items = data.items.map((item) => {
      const next = item && typeof item === 'object' ? { ...item } : {}
      if (typeof next.after === 'string') next.after = normalizeBodyText(next.after)
      if (typeof next.content === 'string') next.content = normalizeBodyText(next.content)
      return next
    })
  }
  // book-fix 统一落成契约写法 data.patches（兼容 items）+ opinion 当纯文本
  if (String(proposal.kind ?? proposal.action ?? '') === 'book-fix') {
    if (typeof data.opinion === 'string') data.opinion = normalizeBodyText(data.opinion)
    if (!Array.isArray(data.patches) && Array.isArray(data.items)) {
      data.patches = data.items.map((item) => (item && typeof item === 'object' ? { ...item } : {}))
      delete data.items
    }
  }
  // ledger-fix 统一落成契约写法 data.ledgerFixes（兼容 items / data.kind 两种历史写法）
  if (String(proposal.kind ?? proposal.action ?? '') === 'ledger-fix') {
    const fixes = store.ledgerFixesOf(data)
    if (fixes.length > 0) {
      data.ledgerFixes = fixes
      delete data.items
    }
  }
  proposal.data = data
  if (proposal.chapter !== undefined) proposal.chapter = chapterNumber(proposal.chapter)
  return proposal
}

async function resolveProject(s, root, nameOrId) {
  const projects = listOf(await s.listProjects(root))
  if (projects.length === 0) throw invalid('作品库为空：请先在工作台新建作品')
  if (!nameOrId) {
    if (projects.length === 1) return projects[0]
    const hint = projects.slice(0, 6).map((row) => `${row?.name ?? row?.title ?? '?'}=${row?.id ?? '?'}`).join('、')
    throw invalid(`当前有 ${projects.length} 部作品，请提供 projectId（${hint}）`)
  }
  const key = String(nameOrId).trim()
  const hit = projects.find((row) => String(row?.id ?? '') === key || String(row?.name ?? '') === key || String(row?.title ?? '') === key)
  if (!hit) throw invalid(`找不到作品「${key}」`)
  return hit
}

// ── 0.7.1 问题 / 修改稿：审稿、采纳、地址刷新 ─────────────────

function normalizeReviewScope(value) {
  const scope = String(value ?? 'chapter')
  if (!['chapter', 'cross', 'global'].includes(scope)) throw invalid('审稿范围只能是 chapter / cross / global')
  return scope
}

function projectDisplayName(project, fallbackId) {
  const row = project && typeof project === 'object'
    ? (project.project && typeof project.project === 'object' ? project.project : project)
    : {}
  return String(row.title ?? row.name ?? fallbackId ?? '未命名')
}

/** 按范围取要审的章节正文（TXT 导出与问题落地址都用它）。 */
async function loadReviewChapters(s, root, projectId, rawScope, chapterList) {
  const scope = normalizeReviewScope(rawScope)
  const all = listOf(await s.listChapters(root, projectId)).map((row) => Number(row.chapter ?? row.id)).filter((n) => n > 0)
  let nums = []
  if (scope === 'global') {
    nums = all.slice()
  } else {
    const wanted = [...new Set((Array.isArray(chapterList) ? chapterList : []).map(Number).filter((n) => n > 0))]
    if (wanted.length === 0) throw invalid('请先选择要审的章节')
    nums = wanted
    if (scope === 'chapter' && nums.length !== 1) throw invalid('单章审稿只能选一章')
    if (scope === 'cross' && nums.length < 2) throw invalid('跨章审稿至少选两章')
  }
  const missing = nums.filter((n) => !all.includes(n))
  if (missing.length > 0) throw invalid(`章节不存在：第 ${missing.join('、')} 章`)
  const rows = []
  for (const chapter of nums) {
    const doc = await s.readChapter(root, projectId, chapter)
    rows.push({ chapter, title: String(doc.meta?.title ?? ''), text: String(doc.text ?? ''), meta: doc.meta ?? {} })
  }
  return { scope, nums, rows }
}

/** 把 AI 交的问题地址归一：限定在单章；para/hash 由服务端按当前正文重算。 */
async function resolveProblemAddress(s, root, projectId, row = {}) {
  const chapters = [...new Set((Array.isArray(row.chapters) ? row.chapters : []).map(Number).filter((n) => n > 0))]
  let chapter = Number(row.chapter) || chapters[0] || 0
  const scope = normalizeReviewScope(row.scope ?? (chapters.length > 1 ? 'cross' : 'chapter'))
  if (scope === 'global') {
    chapter = 0
    if (chapters.length === 0) {
      const all = listOf(await s.listChapters(root, projectId)).map((item) => Number(item.chapter ?? item.id)).filter((n) => n > 0)
      chapters.push(...all)
    }
  } else if (!chapter) {
    throw invalid('这条问题缺少章号')
  }
  let para = row.para === undefined || row.para === null || row.para === '' ? null : Number(row.para)
  const quote = String(row.quote ?? '').trim()
  let paraHash = ''
  if (scope === 'chapter' && chapter) {
    const doc = await s.readChapter(root, projectId, chapter)
    const hint = String(doc.meta?.title ?? '')
    const index = buildIndex(doc.text, chapter, hint)
    const body = splitTitle(doc.text, hint).body
    if ((para === null || !Number.isInteger(para)) && quote) {
      const at = findParagraphByQuote({ ...index, body }, quote)
      if (at >= 0) para = at
    }
    if (Number.isInteger(para) && para >= 0) paraHash = index.paras[para]?.hash || ''
    else para = null
  } else {
    para = null
  }
  if (chapter && chapters.length === 0) chapters.push(chapter)
  return { scope, chapters, chapter, para: Number.isInteger(para) && para >= 0 ? para : null, paraHash, quote }
}

/** 一条问题下的稿全部采完 → accepted；还有 pending → open。 */
function finalizeProblemStatus(db, problemId) {
  const drafts = problems.listDrafts(db, { problemId })
  const pending = drafts.filter((row) => row.status === 'pending').length
  const accepted = drafts.filter((row) => row.status === 'accepted').length
  const status = pending > 0 ? 'open' : accepted > 0 ? 'accepted' : 'open'
  return problems.patchProblem(db, problemId, { status })
}

/** 保存正文后：本章其它问题按 hash/引文跟随；跟不上的标「原文已变」并作废其稿。 */
async function refreshChapterProblems(s, root, projectId, dir, chapter) {
  const { db } = await bookdb.openBook(dir)
  const doc = await s.readChapter(root, projectId, chapter)
  const hint = String(doc.meta?.title ?? '')
  const raw = String(doc.text ?? '')
  const index = buildIndex(raw, chapter, hint)
  const body = splitTitle(raw, hint).body
  const open = problems.listProblems(db, { chapter, status: 'open' })
  let moved = 0
  let outdated = 0
  for (const problem of open) {
    if (problem.scope !== 'chapter' || problem.para === null || problem.para === undefined) continue
    const at = Number(problem.para)
    if (index.paras[at] && index.paras[at].hash === problem.paraHash) continue
    const found = problem.paraHash ? index.paras.findIndex((item) => item.hash === problem.paraHash) : -1
    if (found >= 0) {
      problems.patchProblem(db, problem.id, { para: found, para_hash: index.paras[found]?.hash || problem.paraHash })
      moved += 1
      continue
    }
    const quoteAt = problem.quote ? findParagraphByQuote({ ...index, body }, problem.quote) : -1
    if (quoteAt >= 0) {
      problems.patchProblem(db, problem.id, { para: quoteAt, para_hash: index.paras[quoteAt]?.hash || '' })
      moved += 1
      continue
    }
    problems.patchProblem(db, problem.id, { status: 'outdated' })
    problems.supersedePendingDrafts(db, problem.id)
    outdated += 1
  }
  return { moved, outdated }
}

/** 高光直接进账本（同章同引文同评论去重）。 */
async function addHighlightRow(db, item = {}) {
  const chapter = Number(item.chapter) || 0
  const quote = String(item.quote ?? '').trim()
  const comment = String(item.comment ?? '').trim()
  if (!chapter || !comment) return false
  const exists = db.prepare(
    "SELECT id FROM highlights WHERE chapter = ? AND COALESCE(quote,'') = ? AND COALESCE(comment,'') = ? LIMIT 1",
  ).get(chapter, quote, comment)
  if (exists) return false
  await ledgerdb.addHighlight(db, {
    chapter,
    para: item.para === undefined || item.para === null ? null : Number(item.para),
    quote,
    comment,
    sourceOpinionId: null,
  })
  return true
}

/**
 * 采纳一条修改稿：段级稿只替换该段区间（不重排整章）；整章稿整章替换。
 * 失败不落盘；原文变了就作废该稿并把问题标为「原文已变」，让作者去继续改。
 */
async function acceptProblemDraft(s, root, projectId, dir, draftId) {
  const { db } = await bookdb.openBook(dir)
  const draft = problems.getDraft(db, String(draftId))
  if (!draft) throw invalid('这条改法不存在')
  if (draft.status !== 'pending') throw invalid('这条改法已经处理过了')
  const problem = problems.getProblem(db, draft.problemId)
  if (!problem) throw invalid('问题不存在')
  if (problem.status === 'ignored') throw invalid('这条问题已被忽略：先点「撤销忽略」再采纳')
  const chapter = Number(draft.chapter || problem.chapter) || 0
  if (!chapter) throw invalid('这条改法缺少章号')
  const doc = await s.readChapter(root, projectId, chapter)
  const hint = String(doc.meta?.title ?? '')
  const raw = String(doc.text ?? '')
  const baseHash = String(doc.meta?.contentHash ?? '')

  if (draft.kind === 'chapter') {
    const text = String(draft.text ?? '').trim()
    if (!text) throw invalid('整章改法为空')
    const nextText = text.endsWith('\n') ? text : `${text}\n`
    await s.saveChapter(root, projectId, chapter, nextText, {}, { baseHash, source: 'problem-accept-chapter' })
    problems.patchDraft(db, draft.id, { status: 'accepted' })
    finalizeProblemStatus(db, problem.id)
    const others = problems.listProblems(db, { chapter, status: 'open' }).filter((row) => row.id !== problem.id)
    for (const other of others) {
      problems.patchProblem(db, other.id, { status: 'outdated' })
      problems.supersedePendingDrafts(db, other.id)
    }
    return { ok: true, chapter, kind: 'chapter', message: `已用整章改法替换第 ${chapter} 章${others.length ? `（本章 ${others.length} 条其它问题已标为「原文已变」）` : ''}` }
  }

  const { title, body } = splitTitle(raw, hint)
  const paragraphs = splitParagraphs(body)
  const draftHash = String(draft.paraHash || '')
  let at = Number(draft.para === undefined || draft.para === null ? problem.para : draft.para)
  // 新稿带「出稿时该段的指纹」；旧稿没有，就只在「段号没变」时参考问题创建时的指纹。
  let pinHash = draftHash || (Number(draft.chapter) === Number(problem.chapter) && Number(at) === Number(problem.para) ? String(problem.paraHash || '') : '')
  const failOutdated = (reason) => {
    // 保住 AI 已经出的方案：只把问题标成「原文已变」，稿不删、不 supersede，作者还能看
    problems.patchProblem(db, problem.id, { status: 'outdated' })
    throw invalid(reason)
  }
  if (!Number.isInteger(at) || at < 0 || !paragraphs[at]) {
    failOutdated(`原文已变（第 ${chapter} 章第 ${Number.isInteger(at) ? at + 1 : '?'} 段已不存在）。改法已保留，点「继续改」让 AI 按新原文重出稿。`)
  }
  if (pinHash && paragraphs[at].hash !== pinHash) {
    const index = buildIndex(raw, chapter, hint)
    const moved = index.paras.findIndex((item) => item.hash === pinHash)
    if (moved >= 0) {
      // 段落只是挪了位置（前面插/删了段），跟着走，不报失效
      at = moved
    } else {
      const quoteAt = problem.quote ? findParagraphByQuote({ ...index, body }, problem.quote) : -1
      if (quoteAt >= 0) {
        at = quoteAt
      } else if (draftHash) {
        // 新稿有「出稿时指纹」却对不上：原文确实在出稿后被改过；稿保留，只标问题失效
        failOutdated(`原文已变（第 ${chapter} 章第 ${at + 1} 段和出稿时不一致）。改法已保留，点「继续改」重新出稿。`)
      }
      // 旧稿没有稿级指纹：可能只是之前采纳改过这一段，信任 AI 指到的段继续替换
    }
  }
  const replacement = String(draft.text ?? '').trim()
  if (!replacement) throw invalid('这条改法为空')
  if (/\n[ \t]*\n/.test(replacement)) throw invalid('段级改法里不能有空行分段；要改整章请用整章改写稿')
  const start = Number(paragraphs[at].start)
  const end = Number(paragraphs[at].end)
  const nextBody = body.slice(0, start) + replacement + body.slice(end)
  const nextText = title ? `${title}\n\n${nextBody}\n` : `${nextBody}\n`
  await s.saveChapter(root, projectId, chapter, nextText, {}, { baseHash, source: 'problem-accept-paragraph' })
  problems.patchDraft(db, draft.id, { status: 'accepted' })
  finalizeProblemStatus(db, problem.id)
  const refresh = await refreshChapterProblems(s, root, projectId, dir, chapter)
  return {
    ok: true,
    chapter,
    kind: 'paragraph',
    para: at,
    message: `已替换第 ${chapter} 章第 ${at + 1} 段${refresh.moved ? `；${refresh.moved} 条问题地址已跟随` : ''}${refresh.outdated ? `；${refresh.outdated} 条问题标为「原文已变」` : ''}`,
  }
}

// ── align.status 派生（不进 store） ─────────────────────────

function attentionStats(attention) {
  const rows = listOf(attention)
  const scored = rows.filter((row) => Number.isFinite(Number(row?.score)) && row?.score !== null && row?.score !== undefined)
  const total = scored.reduce((sum, row) => sum + Number(row.score), 0)
  return {
    chapters: rows.length,
    scored: scored.length,
    unscored: Math.max(0, rows.length - scored.length),
    avg: scored.length > 0 ? Math.round(total / scored.length) : null,
  }
}

/**
 * 版本对齐简报：纯读派生，不改盘。
 * @returns {{chapters:number,words:number,openReviews:number,pendingProposals:number,attentionAvg:number|null,ledgerCounts:object}}
 */
async function alignStatus(s, root, projectId) {
  const [context, chapters, reviews, proposals, attention] = await Promise.all([
    s.getContext(root, projectId),
    s.listChapters(root, projectId),
    s.getReviews(root, projectId),
    s.listProposals(root, projectId),
    s.getAttention(root, projectId).catch(() => []),
  ])
  const chapterRows = listOf(chapters)
  const words = chapterRows.reduce((sum, row) => sum + (Number(row?.words ?? row?.wordCount ?? 0) || 0), 0)
  const openReviews = listOf(reviews).filter((row) => ['open', 'proposed', '', 'undefined', 'null'].includes(String(row?.status ?? 'open')))
  const pendingProposals = listOf(proposals).filter((row) => String(row?.status ?? 'pending') === 'pending')
  const map = context ?? {}
  const counts = (key) => (Array.isArray(map[key]) ? map[key].length : 0)
  return {
    projectId,
    project: textOf(map.project?.title ?? map.project?.name ?? '', 60),
    chapters: chapterRows.length,
    words,
    openReviews: openReviews.length,
    pendingProposals: pendingProposals.length,
    attentionAvg: attentionStats(attention).avg,
    attention: attentionStats(attention),
    ledgerCounts: {
      facts: counts('facts'),
      characters: counts('characters'),
      events: counts('events'),
      foreshadow: counts('foreshadow'),
      conflicts: counts('conflicts'),
      locations: counts('locations'),
      world: map.world ? 1 : 0,
    },
    updatedAt: map.project?.updatedAt ?? null,
  }
}

// ── chat.send（宿主会话服务，最小实现） ─────────────────────

function buildChatPrompt(context, payload) {
  const project = context?.project ?? {}
  const name = project.title || project.name || project.id || '未命名'
  const lines = [
    prompts.ATTENTION_PRINCIPLE,
    '',
    ...prompts.attentionBriefLines({ attention: context?.attention }),
    '',
    `【工作台转交】项目《${name}》${project.id ? ` projectId=${project.id}` : ''}`,
    '',
    payload?.action ? `任务：${textOf(payload.action, 120)}` : '作者从工作台发起一次对话，请结合当前作品回答。',
  ]
  const characters = listOf(context?.characters)
  if (characters.length > 0) lines.push(`人物：${characters.slice(0, 8).map((row) => row?.name).filter(Boolean).join('、')}`)
  const recent = listOf(context?.recent)
  if (recent.length > 0) lines.push(`最近章节：${recent.slice(-3).map((row) => `第${row?.chapter ?? '?'}章`).join('、')}`)
  lines.push('', '需要正文/账本时用 novel_desk_read 读，不要凭空编造。')
  return lines.join('\n')
}

// ── 地图底图：按地点/路线/水线生成一版可看的示意底图（确定性，可换 seed） ──
const MAP_PALETTES = [
  { id: 'ink', name: '水墨绢本', paper: '#f6f1e6', ink: '#8b8378', water: '#c3dbe0', ridge: '#d8cdb8', accent: '#b45309' },
  { id: 'ochre', name: '赭石古卷', paper: '#f3ead9', ink: '#7c6f5c', water: '#b9d2cd', ridge: '#cdb894', accent: '#9a3412' },
  { id: 'jade', name: '青绿山河', paper: '#f1f4ec', ink: '#6f7c6b', water: '#a9cfd6', ridge: '#bfd0b4', accent: '#0f766e' },
  { id: 'sepia', name: '羊皮纸', paper: '#efe2c9', ink: '#6d5c44', water: '#c9d3c0', ridge: '#c9b28b', accent: '#8a5a12' },
  { id: 'steel', name: '冷灰史诗', paper: '#e8eaec', ink: '#5b636b', water: '#aebfca', ridge: '#b8bcc0', accent: '#38556b' },
  { id: 'wine', name: '暗红纪事', paper: '#ede4d8', ink: '#6b5650', water: '#c2cbd0', ridge: '#c9ad9c', accent: '#7f1d1d' },
]

/** 地形分类词表：中英文都收，作者用哪种类型都能识别；也可在 world.terrain 里自己加。 */
const WATER_TYPES = ['waterside', 'pier', 'port', 'harbor', 'harbour', 'dock', 'river', 'lake', 'sea', 'ocean', 'canal', 'ford', 'bridge', 'stream', 'marsh', 'swamp', '渡口', '码头', '江', '河', '湖', '海', '溪', '川', '湾', '港', '泽']
const RIDGE_TYPES = ['mountain', 'peak', 'ridge', 'pass', 'valley', 'cave', 'gorge', 'hill', 'cliff', 'ruin', '山', '峰', '岭', '关', '谷', '崖', '岩', '峡', '洞', '丘', '隘']
const WATER_HINTS = /江|河|湖|海|溪|川|渡|湾|港|泉|泽|洲|滩|岸|瀑布|river|lake|sea|ocean|canal|ford|bridge|port|harbor|harbour|dock|stream|marsh|swamp/i
const RIDGE_HINTS = /山|峰|岭|关|谷|崖|岩|峡|洞|丘|隘|石门|mountain|peak|ridge|pass|valley|cave|gorge|hill|cliff|gate/i

function seededRandom(seed) {
  let state = (Number(seed) || 1) >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4294967296
  }
}

function coordOfRow(row) {
  const raw = row?.coords
  if (raw && Number.isFinite(Number(raw.x)) && Number.isFinite(Number(raw.y))) return { x: Number(raw.x), y: Number(raw.y) }
  const x = Number(row?.x ?? row?.mapX)
  const y = Number(row?.y ?? row?.mapY)
  if (Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0)) return { x, y }
  return null
}

function terrainConfig(world) {
  const raw = world && typeof world === 'object' ? world.terrain : null
  const water = Array.isArray(raw?.waterTypes) ? raw.waterTypes.map(String) : []
  const ridge = Array.isArray(raw?.ridgeTypes) ? raw.ridgeTypes.map(String) : []
  return {
    waterTypes: new Set([...WATER_TYPES, ...water.map((item) => item.toLowerCase())]),
    ridgeTypes: new Set([...RIDGE_TYPES, ...ridge.map((item) => item.toLowerCase())]),
    waterNames: new Set(Array.isArray(raw?.water) ? raw.water.map(String) : []),
    ridgeNames: new Set(Array.isArray(raw?.ridges) ? raw.ridges.map(String) : []),
  }
}

function isWaterLocation(row, config) {
  const type = String(row?.type ?? '').toLowerCase().trim()
  const name = String(row?.name ?? '')
  if (config.waterNames.has(name)) return true
  if (config.ridgeNames.has(name)) return false
  if (type && config.waterTypes.has(type)) return true
  return WATER_HINTS.test(name)
}

function isRidgeLocation(row, config) {
  const type = String(row?.type ?? '').toLowerCase().trim()
  const name = String(row?.name ?? '')
  if (config.ridgeNames.has(name)) return true
  if (config.waterNames.has(name)) return false
  if (type && config.ridgeTypes.has(type)) return true
  return RIDGE_HINTS.test(name)
}

/**
 * 从作者自己的地点里串水系：只看 `type`/`name` 的地貌词与坐标，
 * 按最近邻把相邻水点连成折线；没有水点就返回空（不硬塞某本书的河）。
 */
function waterChains(locations, config) {
  const points = []
  for (const row of locations) {
    if (!isWaterLocation(row, config)) continue
    const point = coordOfRow(row)
    if (point) points.push({ x: point.x, y: point.y, name: String(row.name ?? '') })
  }
  if (points.length < 2) return []
  const remaining = points.slice().sort((a, b) => a.x - b.x || a.y - b.y)
  const chains = []
  const maxLink = 380
  while (remaining.length > 0) {
    const chain = [remaining.shift()]
    let grew = true
    while (grew) {
      grew = false
      const last = chain[chain.length - 1]
      let bestIndex = -1
      let bestDistance = maxLink
      for (let i = 0; i < remaining.length; i += 1) {
        const distance = Math.hypot(remaining[i].x - last.x, remaining[i].y - last.y)
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = i
        }
      }
      if (bestIndex >= 0) {
        chain.push(remaining.splice(bestIndex, 1)[0])
        grew = true
      }
    }
    if (chain.length >= 2) chains.push(chain)
  }
  return chains.map((chain, index) => ({
    label: `水系 ${index + 1}（按地点推测）`,
    points: chain.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })),
  }))
}

function ridgeAnchors(locations, config) {
  const out = []
  for (const row of locations) {
    if (!isRidgeLocation(row, config)) continue
    const point = coordOfRow(row)
    if (!point) continue
    const type = String(row.type ?? '').toLowerCase().trim()
    const pass = type === 'pass' || type === '关' || /关|隘|gate/i.test(String(row.name ?? ''))
    out.push({ x: point.x, y: point.y, size: pass ? 0.8 : 1 })
  }
  return out
}

function generateTerrain(ledger, seed, options = {}) {
  const rand = seededRandom(seed)
  const wanted = String(options.palette ?? '').trim()
  const picked = wanted ? MAP_PALETTES.find((row) => row.id === wanted || row.name === wanted) : null
  const palette = picked || MAP_PALETTES[Number(seed) % MAP_PALETTES.length]
  const world = ledger.world && typeof ledger.world === 'object' ? ledger.world : {}
  const config = terrainConfig(world)
  const locations = Array.isArray(ledger.locations) ? ledger.locations : []
  const rivers = waterChains(locations, config)
  const anchors = ridgeAnchors(locations, config)
  const ridges = anchors.map((row, index) => ({
    x: row.x + (rand() - 0.5) * 18,
    y: row.y + (rand() - 0.5) * 12,
    size: Math.round((7 + rand() * 5) * row.size * 10) / 10,
    skew: Math.round((rand() - 0.5) * 40) / 100,
    id: `ridge-${index}`,
  }))
  // 再撒一层低密度山形，避开已有锚点附近，模拟地形走势
  const scattered = 16
  for (let i = 0; i < scattered; i += 1) {
    const x = Math.round(30 + rand() * 940)
    const y = Math.round(30 + rand() * 760)
    const tooClose = ridges.some((row) => Math.hypot(row.x - x, row.y - y) < 46)
    if (tooClose) continue
    ridges.push({ x, y, size: Math.round((4.5 + rand() * 5) * 10) / 10, skew: Math.round((rand() - 0.5) * 50) / 100, id: `ridge-s${i}` })
  }
  return {
    seed: Number(seed) || 1,
    palette: palette.id,
    paletteName: palette.name,
    paletteColors: palette,
    rivers,
    ridges,
    generatedAt: new Date().toISOString(),
  }
}

async function generateMapBackground(s, root, payload) {
  const projectId = String(need(payload, 'projectId'))
  const ledger = await s.getLedger(root, projectId)
  const current = ledger.world?.mapStyle
  const seed = Number.isFinite(Number(payload?.seed)) && Number(payload.seed) > 0 ? Number(payload.seed) : Math.floor(Math.random() * 9000) + 1
  const style = generateTerrain(ledger, seed, { palette: payload?.palette })
  const world = await s.upsertLedgerItem(root, projectId, 'world', { mapStyle: style, mapStyleUpdatedAt: style.generatedAt })
  return { style, mapStyle: world?.mapStyle ?? style, seed, locationCount: Array.isArray(ledger.locations) ? ledger.locations.length : 0 }
}

/** 目录名安全化：去掉路径分隔符/控制字符，留给工作区目录。 */
function safeWorkspaceName(raw, fallback) {
  const text = String(raw ?? '').trim() || fallback
  return text.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+|\.+$/g, '').trim().slice(0, 60) || fallback
}

/**
 * 确保作品有独立的 DSH 工作区（侧栏里能看到的那个「项目」）。
 * 新书创建时就要建，否则 chat.send 只能把工作单塞进别的对话里。
 * 宿主没提供 workspaceRegistry 时原样返回（测试 / 无工作区环境）。
 */
async function ensureProjectWorkspace(ctx, s, root, project, titleOverride = '') {
  const registry = ctx?.get?.('workspaceRegistry')
  if (!registry || typeof registry.resolveByPath !== 'function' || typeof registry.create !== 'function') return project
  const row = project?.project ?? project ?? {}
  const projectId = String(row?.id ?? '').trim()
  if (!projectId) return project
  const desiredTitle = String(titleOverride || row.workspaceTitle || row.name || row.title || `作品-${projectId}`).trim() || `作品-${projectId}`
  let baseDir = ''
  try {
    const list = typeof registry.list === 'function' ? registry.list() : []
    const fallback = (Array.isArray(list) ? list : []).find((item) => item?.title === 'default-workspace' || basename(String(item?.path ?? '')) === 'default-workspace')
    if (fallback?.path) baseDir = String(fallback.path)
  } catch { /* ignore */ }
  if (!baseDir) baseDir = join(homedir(), 'dsh-workspaces')
  await mkdirP(baseDir, { recursive: true })
  const safeName = safeWorkspaceName(desiredTitle, `作品-${projectId}`)
  let dir = join(baseDir, safeName)
  let workspace = null
  try { workspace = await registry.resolveByPath(dir) } catch { workspace = null }
  if (!workspace) {
    let exists = true
    try { statSync(dir) } catch { exists = false }
    if (exists) dir = join(baseDir, `${safeName}-${projectId.slice(-4)}`)
    await mkdirP(dir, { recursive: true })
    workspace = await registry.create(dir, desiredTitle)
  } else if (typeof workspace.setTitle === 'function' && workspace.title !== desiredTitle) {
    try { await workspace.setTitle(desiredTitle) } catch { /* ignore */ }
  }
  if (!workspace?.id) return project
  const patch = { workspaceId: String(workspace.id), workspacePath: String(workspace.path ?? dir), workspaceTitle: desiredTitle }
  if (row.workspaceId === patch.workspaceId && row.workspacePath === patch.workspacePath && row.workspaceTitle === patch.workspaceTitle) return project
  return s.updateProject(root, projectId, patch)
}

async function chatSessions(ctx, root, payload) {
  const controller = ctx?.get?.('sessionController')
  if (!controller || typeof controller.list !== 'function') return { sessions: [], usable: false }
  const projectId = String(payload?.projectId ?? '').trim()
  let workspacePath = ''
  if (projectId) {
    const bundle = await store.getProject(root, projectId).catch(() => null)
    const data = bundle?.project ?? bundle ?? {}
    const row = data?.project && typeof data.project === 'object' ? data.project : data
    workspacePath = String(row?.workspacePath ?? row?.rootPath ?? '')
  }
  const listed = await controller.list({}, AbortSignal.timeout(15000)).catch(() => null)
  const items = listOf(listed).filter((row) => Boolean(row) && row.origin !== 'subagent' && !row.parentSessionId && row.agentAvailable !== false)
  if (!workspacePath) {
    if (projectId) {
      return { usable: false, workspacePath: '', sessions: [], reason: '这个作品还没有登记工作区目录（workspacePath），没法确定该发到哪组对话。' }
    }
    return { usable: true, workspacePath: '', sessions: items.slice(0, 30).map((row) => ({ sessionId: String(row?.sessionId ?? ''), updatedAt: row?.updatedAt ?? null, running: Boolean(row?.running), blank: Boolean(row?.blank), sameProject: false })) }
  }
  const sameCwd = items.filter((row) => String(row?.cwd ?? '') === workspacePath)
  const pool = sameCwd.slice()
  pool.sort((a, b) => String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? '')))
  return {
    usable: true,
    workspacePath,
    sessions: pool.slice(0, 30).map((row) => ({
      sessionId: String(row?.sessionId ?? ''),
      updatedAt: row?.updatedAt ?? null,
      running: Boolean(row?.running),
      blank: Boolean(row?.blank),
      sameProject: Boolean(workspacePath) && String(row?.cwd ?? '') === workspacePath,
    })),
  }
}

async function chatSend(ctx, s, root, payload) {
  const projectId = String(payload?.projectId ?? '').trim()
  let project = null
  let context = null
  if (projectId) {
    project = await s.getProject(root, projectId).catch(() => null)
    context = await s.getContext(root, projectId).catch(() => null)
  }
  const data = project?.project ?? project ?? {}
  let projectRow = data?.project && typeof data.project === 'object' ? data.project : data
  // 工作区被重建/改名后，project.json 里的 workspaceId 可能过期（宿主报 workspace not found）。
  // 发消息前先校验；不存在就按路径找回/补建，并写回 project.json 自愈。
  if (projectRow?.id) {
    const wantedWorkspaceId = String(projectRow.workspaceId ?? '').trim()
    const registry = ctx?.get?.('workspaceRegistry')
    let workspaceAlive = Boolean(wantedWorkspaceId)
    if (wantedWorkspaceId && registry && typeof registry.list === 'function') {
      try {
        const rows = registry.list()
        workspaceAlive = (Array.isArray(rows) ? rows : []).some((row) => String(row?.id ?? '') === wantedWorkspaceId)
      } catch {
        workspaceAlive = true // 查不到注册表时不要乱改
      }
    }
    if (!workspaceAlive) {
      const ensured = await ensureProjectWorkspace(ctx, s, root, projectRow).catch(() => projectRow)
      if (ensured?.workspaceId) {
        projectRow = ensured
        project = { ...(project && typeof project === 'object' ? project : {}), project: ensured }
      }
    }
  }
  const workspacePath = String(projectRow?.workspacePath ?? projectRow?.rootPath ?? '')
  let prompt = String(payload?.prompt ?? '').trim()
  if (!prompt) {
    if (payload?.workorder && typeof prompts[payload.workorder] === 'function') {
      const outlineRows = Array.isArray(payload?.outline)
        ? payload.outline
        : (projectId ? ((await s.getLedger(root, projectId).catch(() => ({})))?.outlines || []) : [])
      // 允许 UI 传 {workorder:'attentionRecheckWorkorder', ...} 走工作单
      // 范围只认用户选择：显式 chapters；scope='book' 才展开全书；绝不默认最近 3 章
      let workorderChapters = Array.isArray(payload?.chapters) ? payload.chapters : []
      if (workorderChapters.length === 0 && String(payload?.scope ?? '') === 'book' && projectId) {
        workorderChapters = listOf(await s.listChapters(root, projectId).catch(() => []))
      }
      const fn = prompts[payload.workorder]
      prompt = String(
        fn({
          project: projectRow,
          chapters: workorderChapters,
          groups: payload.groups,
          scope: payload.scope,
          attention: payload.attention ?? context?.attention ?? [],
          outline: outlineRows,
          items: payload.items,
          chapter: payload.chapter,
          reviews: payload.reviews,
          run: payload.run,
          sources: payload.sources,
          roleOverride: payload.roleOverride,
          focus: payload.focus,
          world: payload.world,
          locations: payload.locations,
          path: payload.path,
          brief: payload.brief,
          preset: payload.preset,
        }) ?? '',
      )
    } else {
      prompt = buildChatPrompt(context, payload)
    }
  }
  if (!prompt) throw invalid('缺少 prompt：无法投递空消息')
  if (payload?.dryRun) return { dryRun: true, prompt, workspacePath, projectId: projectId || null }

  const controller = ctx?.get?.('sessionController')
  if (!controller || (typeof controller.list !== 'function' && typeof controller.create !== 'function')) {
    throw invalid('宿主未提供会话服务（sessionController），无法发送到对话')
  }
  let sessionId = String(payload?.sessionId ?? '').trim()
  let created = false
  const createSession = async () => {
    if (typeof controller.create !== 'function') return ''
    const workspaceId = String(projectRow?.workspaceId ?? '').trim()
    if (!workspaceId) throw invalid('作品还没有注册工作区（workspaceId），无法新建会话')
    try {
      const made = await controller.create({ workspaceId })
      created = true
      return String(made?.sessionId ?? '')
    } catch (error) {
      // 宿主报 workspace not found（工作区被重建/改名后 id 过期）：按路径解析并写回，再重试一次
      const ensured = await ensureProjectWorkspace(ctx, s, root, projectRow).catch(() => projectRow)
      const nextWorkspaceId = String(ensured?.workspaceId ?? '').trim()
      if (!nextWorkspaceId || nextWorkspaceId === workspaceId) throw error
      projectRow = ensured
      project = { ...(project && typeof project === 'object' ? project : {}), project: ensured }
      const made = await controller.create({ workspaceId: nextWorkspaceId })
      created = true
      return String(made?.sessionId ?? '')
    }
  }
  // 子代理会话不能投递（会报 owned by subagent routing），只挑普通会话
  const isDeliveryTarget = (row) => Boolean(row) && row.origin !== 'subagent' && !row.parentSessionId && row.agentAvailable !== false
  const sortRecent = (rows) => rows.slice().sort((a, b) => String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? '')))
  let candidates = []
  if (sessionId && typeof controller.list === 'function') {
    const listed = await controller.list({}, AbortSignal.timeout(15000)).catch(() => null)
    const items = listOf(listed)
    const wanted = items.find((row) => String(row?.sessionId ?? '') === sessionId)
    if (wanted && !isDeliveryTarget(wanted)) throw invalid('目标会话是子代理会话，不能投递；请换一个普通会话，或勾选「新建会话」。')
    const wantedCwd = String(wanted?.cwd ?? '')
    if (workspacePath && wantedCwd && wantedCwd !== workspacePath) {
      throw invalid(`这个会话属于别的工作区（${wantedCwd}），不能把本作品的工作单发过去；请选本作品工作区里的对话，或「新开一个对话」。`)
    }
  }
  if (!sessionId && payload?.newSession) sessionId = await createSession()
  if (!sessionId && typeof controller.list === 'function') {
    const listed = await controller.list({}, AbortSignal.timeout(15000))
    const items = listOf(listed)
    const deliverable = items.filter(isDeliveryTarget)
    const sameCwd = workspacePath ? deliverable.filter((row) => String(row?.cwd ?? '') === workspacePath) : []
    if (payload?.preferContext && workspacePath) {
      // 优先发给「有全文的对话」以吃前缀缓存；没有就新开，不回落到最近的当前对话
      const pool = sameCwd.length ? sameCwd : []
      const ids = pool.map((row) => String(row?.sessionId ?? '')).filter(Boolean)
      const usage = ids.length ? await loadChatUsage(workspacePath, { limit: 50, sessionIds: ids }).catch(() => null) : null
      const weights = new Map((usage?.sessions || []).map((row) => [String(row.id), row]))
      // 有「全局工单」历史的对话（全文动作/全文提案/全局修改/全书同步/开新书底座），按最近使用优先
      const eligible = pool
        .map((row) => ({ row, stat: weights.get(String(row.sessionId)) }))
        .filter((item) => item.stat && item.stat.hasGlobalWorkorder)
        .sort((a, b) => String(b.row?.updatedAt ?? '').localeCompare(String(a.row?.updatedAt ?? '')))
      if (eligible.length > 0) {
        sessionId = String(eligible[0].row.sessionId)
        candidates = eligible.slice(1).map((item) => String(item.row.sessionId))
      } else {
        // 明确要求：没有全文对话就新开，不要用当前/最近会话
        sessionId = ''
        candidates = []
        if (typeof controller.create === 'function') sessionId = await createSession()
      }
    } else if (workspacePath && sameCwd.length === 0) {
      candidates = []
      sessionId = ''
    } else {
      candidates = sortRecent(sameCwd.length > 0 ? sameCwd : deliverable).map((row) => String(row?.sessionId ?? '')).filter(Boolean)
      sessionId = candidates[0] ?? ''
    }
  }
  if (!sessionId) sessionId = await createSession()
  if (!sessionId) throw invalid('宿主里没有可用会话（现有会话都是子代理会话），且无法新建会话')
  if (typeof controller.prompt !== 'function') throw invalid('宿主会话服务不支持 prompt()')
  const requestId = globalThis.crypto?.randomUUID?.() ?? `nd-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const deliver = (target) => controller.prompt({
    requestId,
    sessionId: target,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
    clientTimeZone: 'Asia/Shanghai',
  }, AbortSignal.timeout(20000))
  const failures = []
  const queue = [sessionId, ...candidates.filter((id) => id !== sessionId)]
  for (const target of queue) {
    try {
      await deliver(target)
      return { sent: true, sessionId: target, created, workspacePath, projectId: projectId || null }
    } catch (error) {
      failures.push(`${target}：${error?.message ?? error}`)
      console.error('[novel-desk] chat.send 投递失败', target, error)
    }
  }
  // 现有会话都投不进去时，新建一个再试
  const fresh = await createSession().catch(() => '')
  if (fresh) {
    try {
      await deliver(fresh)
      return { sent: true, sessionId: fresh, created: true, workspacePath, projectId: projectId || null }
    } catch (error) {
      failures.push(`${fresh}：${error?.message ?? error}`)
    }
  }
  throw invalid(`没有可以投递的普通会话。可点「复制」把工作单贴到 DSH 对话框，或先在 DSH 里新建一个会话再发。尝试记录：${failures.slice(0, 3).join('；')}`)
  return { sent: true, sessionId, created, workspacePath, projectId: projectId || null }
}

// ── 用量汇总（0.5 口径：工作台调用 + 本书工作区里的 DSH 会话日志） ──

/**
 * 汇总一个作品的 AI 用量。
 *
 * 0.5 的「准」来自读 DSH 会话日志（~/.dsh/sessions/<编码 cwd>/session.v*.jsonl.zstd 里的
 * data.usage）；0.6 重建时只保留了 usage.json 汇总，但已没有代码写 usage.json，所以数字
 * 一直是 0 / 旧值。这里恢复两条通道：
 *   1) chat：本书工作区（workspacePath）下的 DSH 会话（含子代理会话族），按会话日志计价；
 *   2) workbench：工作台内一次性调用的 usage.json 旧记录（0.5.x 原样兼容）。
 *
 * 返回形状对客户端保持兼容（顶层 calls/tokens/inputTokens/.../costCNY/lastAt/byTask），
 * 另加 chat / workbench 明细。计价拿不到价格时 costCNY 记 null 并在 unpriced 里报数。
 */
export async function summarizeUsage(ctx, s, root, projectId) {
  const legacy = await s.usageSummary(root, projectId).catch(() => null)
  const out = {
    calls: Number(legacy?.calls) || 0,
    tokens: Number(legacy?.tokens) || 0,
    inputTokens: Number(legacy?.inputTokens) || 0,
    outputTokens: Number(legacy?.outputTokens) || 0,
    cacheReadTokens: Number(legacy?.cacheReadTokens) || 0,
    cacheWriteTokens: Number(legacy?.cacheWriteTokens) || 0,
    costCNY: Number(legacy?.costCNY) || 0,
    lastAt: legacy?.lastAt ?? null,
    byTask: legacy?.byTask ?? {},
    workbench: {
      calls: Number(legacy?.calls) || 0,
      tokens: Number(legacy?.tokens) || 0,
      costCNY: Number(legacy?.costCNY) || 0,
    },
    chat: { cwd: '', sessions: [], totalTokens: 0, costCNY: 0, unpriced: 0, note: '', subagents: 0 },
  }
  const id = String(projectId ?? '').trim()
  if (!id) {
    out.chat.note = '没有指定作品：只统计工作台内的调用记录。'
    return out
  }
  const bundle = await s.getProject(root, id).catch(() => null)
  const rawRow = bundle?.project ?? bundle ?? {}
  const project = rawRow?.project && typeof rawRow.project === 'object' ? rawRow.project : rawRow
  const workspacePath = String(project?.workspacePath ?? project?.rootPath ?? '')
  out.chat.cwd = workspacePath
  if (!workspacePath) {
    out.chat.note = '这个作品还没有登记工作区目录，读不到对话用量。'
    return out
  }

  const controller = ctx?.get?.('sessionController')
  let items = []
  if (controller && typeof controller.list === 'function') {
    const listed = await controller.list({}, AbortSignal.timeout(15000)).catch(() => null)
    items = listOf(listed)
  }
  const isRoot = (row) => Boolean(row) && !row.parentSessionId && row.origin !== 'subagent' && !row.blank
  const roots = items.filter((row) => String(row?.cwd ?? '') === workspacePath && isRoot(row))
  const byParent = new Map()
  for (const row of items) {
    const parent = String(row?.parentSessionId ?? '')
    if (!parent) continue
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent).push(String(row?.sessionId ?? ''))
  }
  const descendant = new Set()
  let frontier = new Set(roots.map((row) => String(row?.sessionId ?? '')))
  while (frontier.size > 0) {
    const next = new Set()
    for (const parentId of frontier) {
      for (const childId of byParent.get(parentId) ?? []) {
        if (descendant.has(childId)) continue
        descendant.add(childId)
        next.add(childId)
      }
    }
    frontier = next
  }
  out.chat.subagents = descendant.size

  let loaded = []
  try {
    if (roots.length > 0) {
      const part = await loadChatUsage(workspacePath, { sessionIds: [...roots.map((row) => String(row.sessionId)), ...descendant] })
      loaded = part.sessions ?? []
    } else {
      const part = await loadChatUsage(workspacePath)
      loaded = (part.sessions ?? []).filter((session) => !session.cwd || session.cwd === workspacePath)
    }
  } catch {
    loaded = []
  }
  if (loaded.length === 0) {
    out.chat.note = '本书工作区下还没有对话记录（或 DSH 会话目录不可读）。'
    return out
  }

  const prices = await loadModelPrices().catch(() => null)
  const sessions = []
  for (const session of loaded) {
    const cost = estimateSessionCost(session, prices)
    const row = {
      id: session.id,
      createdAt: session.createdAt || null,
      lastAt: session.lastAt || null,
      messages: Number(session.messages) || 0,
      inputTokens: Number(session.inputTokens) || 0,
      outputTokens: Number(session.outputTokens) || 0,
      cacheReadTokens: Number(session.cacheReadTokens) || 0,
      cacheWriteTokens: Number(session.cacheWriteTokens) || 0,
      totalTokens: Number(session.totalTokens) || 0,
      model: session.model || '',
      provider: session.provider || '',
      isSubagent: descendant.has(String(session.id)),
      costCNY: cost ? Math.round(cost.cny * 10000) / 10000 : null,
    }
    if (!cost) out.chat.unpriced += 1
    sessions.push(row)
  }
  sessions.sort((a, b) => Number(b.lastAt || 0) - Number(a.lastAt || 0))
  out.chat.sessions = sessions
  out.chat.totalTokens = sessions.reduce((sum, row) => sum + row.totalTokens, 0)
  out.chat.costCNY = Math.round(sessions.reduce((sum, row) => sum + (row.costCNY || 0), 0) * 10000) / 10000

  out.calls += sessions.reduce((sum, row) => sum + row.messages, 0)
  out.tokens += out.chat.totalTokens
  out.inputTokens += sessions.reduce((sum, row) => sum + row.inputTokens, 0)
  out.outputTokens += sessions.reduce((sum, row) => sum + row.outputTokens, 0)
  out.cacheReadTokens += sessions.reduce((sum, row) => sum + row.cacheReadTokens, 0)
  out.cacheWriteTokens += sessions.reduce((sum, row) => sum + row.cacheWriteTokens, 0)
  out.costCNY = Math.round((out.costCNY + out.chat.costCNY) * 10000) / 10000
  const latest = sessions.map((row) => Number(row.lastAt || 0)).sort((a, b) => b - a)[0]
  if (latest) {
    const iso = new Date(latest).toISOString()
    if (!out.lastAt || iso > String(out.lastAt)) out.lastAt = iso
  }
  return out
}

// ── import（外部稿本目录 → 新作品；薄实现） ─────────────────

function splitFrontmatter(raw) {
  let text = String(raw ?? '')
  const meta = {}
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end > 0) {
      const head = text.slice(3, end)
      text = text.slice(end + 4).replace(/^\r?\n/, '')
      for (const line of head.split(/\r?\n/)) {
        const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
        if (match) meta[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
      }
    }
  }
  return { meta, body: text }
}

function assertImportTarget(rawPath) {
  const path = String(rawPath ?? '').trim()
  if (!path) throw invalid('缺少稿本路径：请传 rootPath（也接受 path / dir），可以是目录，也可以是单个 .md/.txt 文件')
  const target = resolve(path)
  if (!existsSync(target)) throw invalid(`路径不存在：${target}`)
  return target
}

/** 中文或阿拉伯章号 → 数字。 */
function parseChapterNumber(token) {
  const raw = String(token ?? '').trim()
  if (/^\d+$/.test(raw)) return Number(raw)
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const units = { 十: 10, 百: 100, 千: 1000 }
  let total = 0
  let number = 0
  for (const ch of raw) {
    if (ch in digits) {
      number = digits[ch]
      continue
    }
    if (ch in units) {
      if (number === 0) number = 1
      total += number * units[ch]
      number = 0
      continue
    }
    return null
  }
  return total + number
}

const CHAPTER_HEADING = /^(?:#{1,3}\s*)?第\s*([0-9０-９一二三四五六七八九十百千零〇两]+)\s*[章回节篇卷]\s*[:：、.．\s]*(.*)$/
const TEXT_FILE = /\.(md|txt)$/i

/** 单文件里若存在 ≥2 个「第X章」标题，就按标题拆章。 */
function splitByChapterHeadings(text) {
  const chunks = []
  let current = null
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = CHAPTER_HEADING.exec(line.trim())
    if (match) {
      if (current) chunks.push(current)
      current = { chapter: parseChapterNumber(match[1]), title: match[2].trim(), lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) chunks.push(current)
  // 第一个标题之前的前言不属于任何章，丢弃（它在 current 为空时已被跳过）
  return chunks.length >= 2 ? chunks : []
}

function listTextFiles(dir, depth = 0, out = []) {
  if (depth > 4) return out
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.backups') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listTextFiles(full, depth + 1, out)
    else if (entry.isFile() && TEXT_FILE.test(entry.name)) out.push(full)
  }
  return out
}

/** 自然序：2.md < 10.md。 */
function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
}

function titleFromBody(body, fallback) {
  const trimmed = String(body ?? '').trimStart()
  const heading = /^#{1,3}\s+(.+)$/m.exec(trimmed.split(/\r?\n/)[0] ?? '')
  const firstLine = (trimmed.split(/\r?\n/)[0] ?? '').trim()
  if (heading) return heading[1].trim()
  if (firstLine && firstLine.length <= 40 && !/[。！？…]$/.test(firstLine)) return firstLine
  return fallback
}

/**
 * 扫描外部稿本：目录或单个文件都行，不限 0001.md 命名。
 *   - 目录：递归找 .md/.txt（深度 ≤4，跳过隐藏目录 / node_modules / .backups）；
 *     有 chapters/ 子目录就只读它（避免与正文副本重复）。
 *   - 文件：先看「第X章」标题，≥2 个就拆章；否则整篇作为一章。
 * 章号：优先文件名前缀数字，冲突或没有时按自然序 1..N。
 */
function scanSource(rawPath) {
  const target = assertImportTarget(rawPath)
  const stat = statSync(target)
  const chaptersDir = join(target, 'chapters')
  const baseDir = stat.isDirectory() && existsSync(chaptersDir) && statSync(chaptersDir).isDirectory() ? chaptersDir : target

  let project = null
  if (stat.isDirectory() && existsSync(join(target, 'project.json'))) {
    try {
      project = JSON.parse(readFileSync(join(target, 'project.json'), 'utf8'))
    } catch {
      project = null
    }
  }

  const paths = stat.isFile() ? [target] : listTextFiles(baseDir).sort(naturalCompare)
  if (paths.length === 0) {
    throw invalid(stat.isFile() ? `不是可导入的 .md/.txt 文件：${target}` : `这个目录（含子目录）里没有 .md/.txt：${target}`)
  }

  const rows = []
  for (const path of paths) {
    const { meta, body } = splitFrontmatter(readFileSync(path, 'utf8'))
    const name = basename(path)
    const stem = name.replace(TEXT_FILE, '')
    const prefixMatch = /^(\d{1,4})(?:[.\-_ ]|$)/.exec(stem)
    const chunks = splitByChapterHeadings(body)
    if (chunks.length >= 2) {
      for (const chunk of chunks) {
        rows.push({
          path,
          name,
          chapter: chunk.chapter ?? null,
          title: chunk.title || titleFromBody(chunk.lines.join('\n'), stem),
          format: TEXT_FILE.exec(name)?.[1]?.toLowerCase() === 'md' ? 'md' : 'txt',
          meta: { ...meta },
          body: chunk.lines.join('\n').trim(),
          fromSplit: true,
        })
      }
      continue
    }
    rows.push({
      path,
      name,
      chapter: prefixMatch ? Number(prefixMatch[1]) : null,
      title: String(meta.title ?? meta.name ?? '').trim() || titleFromBody(body, stem),
      format: name.toLowerCase().endsWith('.md') ? 'md' : 'txt',
      meta: { ...meta },
      body,
      fromSplit: false,
    })
  }

  // 章号分配：前缀数字都唯一且非 0 就用它，否则按自然序 1..N
  const prefixes = rows.map((row) => row.chapter)
  const usable = prefixes.every((value) => Number.isInteger(value) && value > 0) && new Set(prefixes).size === prefixes.length
  const files = rows
    .map((row, index) => ({
      name: row.name,
      chapter: usable ? row.chapter : index + 1,
      title: row.title || `第${usable ? row.chapter : index + 1}章`,
      words: row.body.replace(/\s+/g, '').length,
      format: row.format,
      meta: { ...row.meta, title: row.title || `第${usable ? row.chapter : index + 1}章` },
      body: row.body,
      path: row.path,
      fromSplit: row.fromSplit,
    }))
    .filter((row) => row.body.trim().length > 0)

  return {
    kind: stat.isFile() ? 'file' : 'dir',
    rootPath: stat.isFile() ? resolve(target) : target,
    project,
    files,
    totalWords: files.reduce((sum, file) => sum + file.words, 0),
  }
}

function describeScan(scan) {
  const chapters = scan.files.length
  const words = scan.totalWords
  const prefix = scan.kind === 'file' ? '单文件' : '目录'
  const title = scan.project?.title ?? scan.project?.name ?? ''
  return `${prefix}「${basename(scan.rootPath)}」可导入 ${chapters} 章、约 ${words} 字${title ? `，作品名建议「${title}」` : ''}`
}

async function importScan(payload) {
  const scan = scanSource(payload?.rootPath ?? payload?.path ?? payload?.dir)
  return {
    kind: scan.kind,
    rootPath: scan.rootPath,
    description: describeScan(scan),
    project: scan.project ? { id: scan.project.id ?? null, title: scan.project.title ?? scan.project.name ?? null } : null,
    files: scan.files.map((file) => ({ name: file.name, chapter: file.chapter, title: file.title, words: file.words, format: file.format, fromSplit: file.fromSplit })),
    totalWords: scan.totalWords,
  }
}

async function importRun(s, root, payload) {
  const scan = scanSource(payload?.rootPath ?? payload?.path ?? payload?.dir)
  if (scan.files.length === 0) throw invalid(`没有可导入的正文：${scan.rootPath}`)
  const fallback = basename(scan.rootPath).replace(TEXT_FILE, '')
  const title = String(payload?.title ?? scan.project?.title ?? scan.project?.name ?? '').trim() || fallback
  const seed = scan.project && typeof scan.project === 'object' ? { ...scan.project } : {}
  delete seed.id
  delete seed.chapters
  delete seed.words
  const created = await s.createProject(root, { ...seed, ...(payload?.project ?? {}), title, name: title })
  const projectId = String(created?.id ?? created?.project?.id ?? '')
  if (!projectId) throw invalid('创建作品失败：store.createProject 未返回 id')
  let words = 0
  let chapters = 0
  for (const file of scan.files) {
    await s.saveChapter(root, projectId, file.chapter, file.body, { ...file.meta, title: file.meta.title ?? file.title }, { source: 'import' })
    words += file.words
    chapters += 1
  }
  return { projectId, title, chapters, words, description: describeScan(scan) }
}

// ── RPC 分发（40 op，几乎全部委托 store） ──────────────────

/**
 * 执行一个 RPC。返回 value；失败抛 RpcError（由 HTTP 层转 {ok:false,error}）。
 * @param {{op:string,payload?:object}} body
 * @param {object} ctx 宿主 context（chat.send / app.open 用）
 * @param {{root?:string, store?:object, connection?:object, webServer?:object}} [options] 测试注入
 */
export async function handleRpc(body, ctx = {}, options = {}) {
  const op = String(body?.op ?? '')
  const payload = (body?.payload && typeof body.payload === 'object') ? body.payload : {}
  if (!RPC_OPS.includes(op)) throw invalid(`未知操作：${op || '(空)'}`)
  const s = options.store ?? store
  const root = options.root ?? s.defaultRoot()
  await s.ensureRoot(root)

  switch (op) {
    // ── 读 ──────────────────────────────────────────────
    case 'ping': {
      const projects = listOf(await s.listProjects(root).catch(() => []))
      return { name, version: VERSION, root, projectCount: projects.length, ops: RPC_OPS.length }
    }
    case 'projects.list':
      return s.listProjects(root)
    case 'project.context':
      return s.getContext(root, String(need(payload, 'projectId')))
    case 'preset.defaults':
      return s.defaultPresets()
    case 'chapter.list':
      return s.listChapters(root, String(need(payload, 'projectId')))
    case 'chapter.get': {
      const projectId = String(need(payload, 'projectId'))
      return s.readChapter(root, projectId, needNumber(payload, 'chapter'))
    }
    case 'chapter.history': {
      const projectId = String(need(payload, 'projectId'))
      return s.listChapterHistory(root, projectId, needNumber(payload, 'chapter'))
    }
    case 'chapter.version': {
      const projectId = String(need(payload, 'projectId'))
      const version = payload.version ?? payload.versionId
      if (version === undefined || version === null || String(version).trim() === '') throw invalid('缺少参数 version')
      return s.readChapterVersion(root, projectId, needNumber(payload, 'chapter'), String(version))
    }
    case 'update.check': {
      const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
      const dir = fileURLToPath(new URL('.', import.meta.url))
      const info = await checkLatest({ installed: String(pkg.version ?? ''), force: Boolean(payload.force) })
      return { ...info, current: String(pkg.version ?? ''), hint: updateHint(), mode: await installMode(dir), pluginDir: dir }
    }
    case 'update.install': {
      const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
      const dir = fileURLToPath(new URL('.', import.meta.url))
      return installLatest({ dir, installed: String(pkg.version ?? ''), force: Boolean(payload.force) })
    }
    case 'update.rollback': {
      const dir = fileURLToPath(new URL('.', import.meta.url))
      return rollback(dir)
    }
    case 'diagnostics': {
      const info = await bookdb.storageStatus('')
      return {
        plugin: { name, version: VERSION },
        node: process.versions?.node || '',
        boot: bootErrors.slice(-20),
        storage: info,
        roles: ROLES.length,
      }
    }
    case 'roles.list':
      return { roles: ROLES }
    case 'storage.status': {
      const projectId = String(payload.projectId ?? '').trim()
      const dir = projectId ? await s.projectDir(root, projectId) : ''
      return bookdb.storageStatus(dir)
    }
    case 'coldRead.prepare': {
      const projectId = String(need(payload, 'projectId'))
      const scope = String(payload.scope ?? 'book') === 'chapter' ? 'chapter' : 'book'
      const chapter = Number(payload.chapter) || 0
      const chapters = listOf(await s.listChapters(root, projectId))
      const picked = scope === 'chapter'
        ? chapters.filter((row) => Number(row.chapter) === chapter)
        : chapters
      if (picked.length === 0) throw invalid('没有可冷读的章节')
      const dir = await s.projectDir(root, projectId)
      const manuscriptDir = join(dir, 'manuscripts')
      await mkdirP(manuscriptDir, { recursive: true })
      const parts = []
      for (const row of picked) {
        const doc = await s.readChapter(root, projectId, Number(row.chapter))
        const text = String(doc.text ?? '').trim()
        if (!text) continue
        parts.push(text)
      }
      if (parts.length === 0) throw invalid('选中的章节正文都是空的')
      const project = await s.getProject(root, projectId)
      const name = String(project.title ?? project.name ?? projectId)
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const fileName = scope === 'chapter' ? `冷读-${name}-第${chapter}章-${stamp}.txt` : `冷读-${name}-全文.txt`
      const filePath = join(manuscriptDir, fileName)
      await writeFile(filePath, `${name}\n\n${parts.join('\n\n')}\n`, 'utf8')
      const range = scope === 'chapter' ? `第 ${chapter} 章` : `第 ${picked[0].chapter}–${picked[picked.length - 1].chapter} 章`
      const prompt = [
        '你是一个独立审稿人，同时是出版社编辑。',
        `这是一本新投稿的书（${name}，${range}，约 ${parts.reduce((sum, text) => sum + text.length, 0)} 字）。`,
        `全文在：${filePath}`,
        '请用 read 工具直接读这个 txt，一次读完，不要再拆章节、不要调用其他工具。',
        '',
        '读完后直接回答三件事（不要客套、不要分段复述剧情）：',
        '1. 评分：0–100 的读者吸引力分；',
        '2. 接纳与否：建议接纳 / 退修 / 拒稿，并给一句理由；',
        '3. 不足：哪里不足，**每行以「第N章：」开头**，写到章和段（能指出具体句子更好），每条约 1–2 句，最多 10 条；可分「硬伤」和「观感」。',
        '4. 高光：真有写得极好的地方，单独一两行「高光：第N章……」，这类会自动进高光账本，不需要作者处理。',
        '',
        '回答完以后，只调用一次极简工具上报结果：novel_desk_attention(op="measured", dispatchId, score, verdict, notes=[{chapter, kind:"weakness"|"highlight", comment, quote, after?}])。高光必须 kind="highlight" 且带 quote（逐字原文），否则不会入高光账本；弱点要带 after 才能一键采纳。',
      ].join('\n')
      return { filePath, fileName, scope, chapters: picked.map((row) => Number(row.chapter)), words: parts.reduce((sum, text) => sum + text.length, 0), prompt }
    }
    case 'coldRead.splitLocal': {
      const projectId = String(need(payload, 'projectId'))
      const parentId = String(need(payload, 'id'))
      const items = Array.isArray(payload.items) ? payload.items : []
      const dir = await s.projectDir(root, projectId)
      const result = await bookdb.addColdReadChildren({ dir, parentId, items })
      return result
    }
    case 'coldRead.split': {
      const projectId = String(need(payload, 'projectId'))
      const parentId = String(need(payload, 'id'))
      const dir = await s.projectDir(root, projectId)
      const parent = await bookdb.getOpinion(dir, parentId)
      if (!parent) throw invalid('冷读意见不存在')
      const chapters = listOf(await s.listChapters(root, projectId)).map((row) => ({
        chapter: Number(row.chapter), title: String(row.title ?? ''), words: Number(row.words) || 0, path: row.path || '',
      }))
      const prompt = prompts.coldReadSplitWorkorder({ project: await s.getProject(root, projectId).catch(() => null), coldRead: parent.text, chapters })
      const hint = '先调 novel_desk_dispatch(projectId=' + JSON.stringify(projectId) + ', role="cold-reader", task="拆分冷读意见") 拿 dispatchId，再调 novel_desk_cold_split(projectId, dispatchId, parentId=' + JSON.stringify(parentId) + ', items=[...])。'
      return { prompt: prompt + '\n\n## 派单\n' + hint, parentId }
    }
    case 'checks.local': {
      const projectId = String(need(payload, 'projectId'))
      const limit = Math.max(1, Math.min(200, Number(payload.limit) || 200))
      const chapters = listOf(await s.listChapters(root, projectId)).slice(0, limit)
      const dir = await s.projectDir(root, projectId)
      const { db } = await bookdb.openBook(dir)
      const aliases = ledgerdb.aliasIndex(db)
      const facts = db.prepare('SELECT subject, attribute, value FROM facts').all()
      const items = []
      let scanned = 0
      for (const row of chapters) {
        const chapter = Number(row?.chapter ?? row?.id ?? 0)
        if (!chapter) continue
        let doc
        try { doc = await s.readChapter(root, projectId, chapter) } catch { continue }
        const index = buildIndex(doc.text, chapter, String(doc.meta?.title ?? ''))
        const body = splitTitle(doc.text, String(doc.meta?.title ?? '')).body
        // 未登记专名启发式噪音大：只由作者/AI 确认后入账，不在本地检查里刷候选
        items.push(...scanChapterLocal({ chapter, text: doc.text, index: { ...index, body }, unknownNames: [], facts }))
        scanned += 1
      }
      const counts = { logic: 0, deai: 0 }
      for (const item of items) counts[item.kind] = (counts[item.kind] || 0) + 1
      return { scanned, counts, items: items.slice(0, 300) }
    }
    case 'chapter.index': {
      const projectId = String(need(payload, 'projectId'))
      const chapter = needNumber(payload, 'chapter')
      const doc = await s.readChapter(root, projectId, chapter)
      const index = buildIndex(doc.text, chapter, String(doc.meta?.title ?? ''))
      return { index, title: index.title, bodyHash: index.bodyHash }
    }
    // ── 0.7.1 问题 / 修改稿 ─────────────────────────────
    case 'problems.list': {
      const projectId = String(need(payload, 'projectId'))
      const dir = await s.projectDir(root, projectId)
      const { db } = await bookdb.openBook(dir)
      const reviewCache = new Map()
      const rows = problems.listProblems(db, {}).map((problem) => {
        let reviewKind = ''
        let reviewSessionId = ''
        if (problem.reviewId) {
          if (!reviewCache.has(problem.reviewId)) reviewCache.set(problem.reviewId, problems.getReview(db, problem.reviewId))
          const review = reviewCache.get(problem.reviewId)
          reviewKind = String(review?.kind || '')
          reviewSessionId = String(review?.sessionId || '')
        }
        return {
          ...problem,
          drafts: problems.listDrafts(db, { problemId: problem.id }),
          reviewKind,
          reviewSessionId,
        }
      })
      return { rows, counts: problems.problemCounts(db) }
    }
    case 'problems.reviews': {
      const projectId = String(need(payload, 'projectId'))
      const dir = await s.projectDir(root, projectId)
      const { db } = await bookdb.openBook(dir)
      const limit = Math.max(1, Math.min(50, Number(payload.limit) || 20))
      return { rows: problems.listReviews(db, { limit }) }
    }
    case 'problems.factsScan': {
      const projectId = String(need(payload, 'projectId'))
      const built = await loadReviewChapters(s, root, projectId, payload.scope, payload.chapters)
      const dir = await s.projectDir(root, projectId)
      const { db } = await bookdb.openBook(dir)
      const facts = db.prepare('SELECT subject, attribute, value FROM facts').all()
      const candidates = scanFactsCandidates({ chapters: built.rows, facts })
      const review = problems.createReview(db, {
        kind: 'facts-scan', scope: built.scope, chapters: built.nums, candidates, status: 'prepared',
      })
      return { reviewId: review.id, scanned: built.rows.length, chapters: built.nums, candidates }
    }
    case 'problems.prepareReading': {
      const projectId = String(need(payload, 'projectId'))
      const built = await loadReviewChapters(s, root, projectId, payload.scope, payload.chapters)
      const dir = await s.projectDir(root, projectId)
      const project = await s.getProject(root, projectId).catch(() => null)
      const projectName = projectDisplayName(project, projectId)
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const manuscript = await exportManuscript({ dir, projectName, scope: built.scope, chapters: built.rows, stamp })
      const { db } = await bookdb.openBook(dir)
      const review = problems.createReview(db, {
        kind: 'reading', scope: built.scope, chapters: built.nums, manuscriptPath: manuscript.filePath, status: 'prepared',
      })
      const prompt = readingPrompt({
        projectName, projectId, scope: built.scope, chapters: built.rows, filePath: manuscript.filePath, reviewId: review.id, words: manuscript.words,
      })
      return { reviewId: review.id, prompt, filePath: manuscript.filePath, fileName: manuscript.fileName, words: manuscript.words, chapters: built.nums }
    }
    case 'problems.prepareFacts': {
      const projectId = String(need(payload, 'projectId'))
      const built = await loadReviewChapters(s, root, projectId, payload.scope, payload.chapters)
      const dir = await s.projectDir(root, projectId)
      const project = await s.getProject(root, projectId).catch(() => null)
      const projectName = projectDisplayName(project, projectId)
      const { db } = await bookdb.openBook(dir)
      const facts = db.prepare('SELECT subject, attribute, value FROM facts').all()
      const candidates = scanFactsCandidates({ chapters: built.rows, facts })
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const manuscript = await exportManuscript({ dir, projectName, scope: built.scope, chapters: built.rows, stamp })
      const review = problems.createReview(db, {
        kind: 'facts-ai', scope: built.scope, chapters: built.nums, manuscriptPath: manuscript.filePath, candidates, status: 'prepared',
      })
      const prompt = factsPrompt({
        projectName, projectId, scope: built.scope, chapters: built.rows, filePath: manuscript.filePath, reviewId: review.id, words: manuscript.words, candidates,
      })
      return {
        reviewId: review.id, prompt, filePath: manuscript.filePath, fileName: manuscript.fileName, words: manuscript.words, chapters: built.nums, candidates,
      }
    }
    case 'problems.prepareRevise': {
      const projectId = String(need(payload, 'projectId'))
      const ids = [...new Set((Array.isArray(payload.problemIds) ? payload.problemIds : [payload.problemId]).map(String).filter(Boolean))]
      if (ids.length === 0) throw invalid('请先选择要改的问题')
      if (ids.length > 40) throw invalid('一次最多 40 条问题：请按你勾选的范围分批，不按固定章数自动切')
      const dir = await s.projectDir(root, projectId)
      const { db } = await bookdb.openBook(dir)
      const rows = []
      let sessionId = ''
      for (const id of ids) {
        const problem = problems.getProblem(db, id)
        if (!problem) throw invalid(`问题不存在：${id}`)
        if (problem.status === 'ignored') throw invalid(`问题 ${id} 已被忽略：先撤销忽略再继续改`)
        rows.push({ ...problem, drafts: problems.listDrafts(db, { problemId: id }) })
        if (!sessionId && problem.reviewId) {
          const review = problems.getReview(db, problem.reviewId)
          if (review?.sessionId) sessionId = review.sessionId
        }
      }
      const project = await s.getProject(root, projectId).catch(() => null)
      const prompt = revisePrompt({
        projectName: projectDisplayName(project, projectId),
        projectId,
        problems: rows,
        requirement: String(payload.requirement ?? ''),
        batch: ids.length > 1,
      })
      return { prompt, problemCount: rows.length, sessionId }
    }
    case 'problems.prepareBrief': {
      // 作者宏观提议：一个问题绑定一条 author-brief 审阅记录，用于绑定对话、支持多轮继续聊。
      const projectId = String(need(payload, 'projectId'))
      const problemId = String(need(payload, 'problemId'))
      const dir = await s.projectDir(root, projectId)
      const { db } = await bookdb.openBook(dir)
      const problem = problems.getProblem(db, problemId)
      if (!problem) throw invalid('问题不存在')
      if (problem.status === 'ignored') throw invalid('这条问题已被忽略：先撤销忽略')
      let review = problem.reviewId ? problems.getReview(db, problem.reviewId) : null
      if (!review || review.kind !== 'author-brief') {
        review = problems.createReview(db, {
          kind: 'author-brief',
          scope: problem.scope,
          chapters: problem.chapters,
          status: 'prepared',
        })
        problems.patchProblem(db, problem.id, { reviewId: review.id })
      }
      const project = await s.getProject(root, projectId).catch(() => null)
      const prompt = authorBriefPrompt({
        projectName: projectDisplayName(project, projectId),
        problem: { ...problem, reviewId: review.id },
        projectId,
      })
      return { reviewId: review.id, prompt, sessionId: String(review.sessionId || '') }
    }
    case 'problems.chat': {
      // 多轮沟通：把作者补充想法发进这条提议绑定的对话（不生成工作单、不改正文）。
      const projectId = String(need(payload, 'projectId'))
      const problemId = String(need(payload, 'problemId'))
      const message = String(payload.message ?? '').trim()
      if (!message) throw invalid('先写要跟 AI 说的话')
      const dir = await s.projectDir(root, projectId)
      const { db } = await bookdb.openBook(dir)
      const problem = problems.getProblem(db, problemId)
      if (!problem) throw invalid('问题不存在')
      if (!problem.reviewId) throw invalid('这条问题还没有绑定对话：先发一次「宏观提议工作单」')
      const review = problems.getReview(db, problem.reviewId)
      const sessionId = String(review?.sessionId || '')
      if (!sessionId) throw invalid('这条问题还没有绑定对话：先发一次「宏观提议工作单」')
      const prompt = [
        '【作者补充想法（继续讨论）】',
        message,
        '',
        `继续按「作者宏观提议」的约定：先讨论/确认，谈定后用 novel_desk_problems(op="revise", projectId=${JSON.stringify(projectId)}, revisions=[{problemId:${JSON.stringify(problemId)}, drafts:[...]}]) 提交修改稿；不改正文、不新增问题、不改范围外内容。`,
      ].join('\n')
      const sent = await chatSend(ctx, s, root, { projectId, sessionId, prompt })
      return { ok: true, sessionId: String(sent?.sessionId || sessionId) }
    }
    case 'problems.setReviewSession': {
      const projectId = String(need(payload, 'projectId'))
      const dir = await s.projectDir(root, projectId)
      const { db } = await bookdb.openBook(dir)
      const sessionId = String(payload.sessionId ?? '').trim()
      if (!sessionId) throw invalid('缺少 sessionId')
      const review = problems.updateReview(db, String(need(payload, 'reviewId')), { session_id: sessionId })
      if (!review) throw invalid('审稿记录不存在')
      return { ok: true }
    }
    case 'problems.add': {
      const projectId = String(need(payload, 'projectId'))
      const text = String(payload.text ?? '').trim()
      if (!text) throw invalid('请先写问题内容')
      const type = problems.PROBLEM_TYPES.includes(String(payload.type ?? '')) ? String(payload.type) : 'other'
      const severity = problems.PROBLEM_SEVERITIES.includes(String(payload.severity ?? '')) ? String(payload.severity) : 'major'
      // 作者提问题：单章 / 跨章（明确章号）/ 全局；可选段号或引文定位。
      const wantedChapters = [...new Set((Array.isArray(payload.chapters) ? payload.chapters : [payload.chapter])
        .map(Number).filter((number) => number > 0))]
      const rawScope = String(payload.scope ?? '').trim()
      const scope = ['chapter', 'cross', 'global'].includes(rawScope)
        ? rawScope
        : (wantedChapters.length > 1 ? 'cross' : 'chapter')
      let chapter = Number(payload.chapter) || wantedChapters[0] || 0
      if (scope === 'global') chapter = 0
      if (scope !== 'global' && !chapter) throw invalid('请选择章节')
      if (scope === 'cross' && wantedChapters.length < 2) throw invalid('跨章问题至少要选两章')
      if (scope === 'chapter' && wantedChapters.length > 1) throw invalid('单章问题只能选一章')
      const chapterList = scope === 'global' ? [] : (wantedChapters.length ? wantedChapters : [chapter])
      const dir = await s.projectDir(root, projectId)
      const addr = await resolveProblemAddress(s, root, projectId, {
        scope, chapters: chapterList, chapter: scope === 'global' ? 0 : chapter,
        para: payload.para, quote: payload.quote,
      })
      const { db } = await bookdb.openBook(dir)
      const row = problems.addProblem(db, {
        reviewId: '',
        type,
        scope: addr.scope,
        chapters: addr.chapters,
        chapter: addr.chapter,
        para: addr.para,
        paraHash: addr.paraHash,
        quote: addr.quote,
        severity,
        text,
        source: 'author',
        authorNote: String(payload.authorNote ?? payload.note ?? payload.requirement ?? '').trim(),
      })
      return { ok: true, id: row.id, chapter: addr.chapter, para: addr.para, scope: addr.scope, chapters: addr.chapters }
    }
    case 'problems.note': {
      const projectId = String(need(payload, 'projectId'))
      const dir = await s.projectDir(root, projectId)
      const { db } = await bookdb.openBook(dir)
      const row = problems.patchProblem(db, String(need(payload, 'problemId')), { author_note: String(payload.note ?? '') })
      if (!row) throw invalid('问题不存在')
      return { ok: true }
    }
    case 'problems.ignore': {
      const projectId = String(need(payload, 'projectId'))
      const problemId = String(need(payload, 'problemId'))
      const ignored = payload.ignored !== false
      const dir = await s.projectDir(root, projectId)
      const { db } = await bookdb.openBook(dir)
      const current = problems.getProblem(db, problemId)
      if (!current) throw invalid('问题不存在')
      if (current.status === 'accepted') throw invalid('这条问题已采纳，不能再忽略')
      const row = problems.patchProblem(db, problemId, { status: ignored ? 'ignored' : 'open' })
      return { ok: true, id: row?.id || problemId, status: row?.status || (ignored ? 'ignored' : 'open') }
    }
    case 'problems.restoreDraft': {
      const projectId = String(need(payload, 'projectId'))
      const draftId = String(need(payload, 'draftId'))
      const dir = await s.projectDir(root, projectId)
      const { db } = await bookdb.openBook(dir)
      const draft = problems.getDraft(db, draftId)
      if (!draft) throw invalid('改法不存在')
      const problem = problems.getProblem(db, draft.problemId)
      if (!problem) throw invalid('问题不存在')
      if (problem.status === 'accepted') throw invalid('这条问题已采纳，不能恢复旧稿')
      if (draft.status === 'pending') return { ok: true, id: draftId, status: 'pending' }
      problems.patchDraft(db, draftId, { status: 'pending' })
      if (problem.status === 'ignored') throw invalid('这条问题已被忽略：先撤销忽略')
      problems.patchProblem(db, problem.id, { status: problem.status === 'outdated' ? 'open' : problem.status })
      return { ok: true, id: draftId, status: 'pending' }
    }
    case 'problems.accept': {
      const projectId = String(need(payload, 'projectId'))
      const draftId = String(need(payload, 'draftId'))
      const dir = await s.projectDir(root, projectId)
      return acceptProblemDraft(s, root, projectId, dir, draftId)
    }
    case 'opinions.list': {
      const projectId = String(need(payload, 'projectId'))
      const dir = await s.projectDir(root, projectId)
      return bookdb.listOpinions(dir, {
        chapter: payload.chapter == null || payload.chapter === '' ? null : Number(payload.chapter),
        status: payload.status ? String(payload.status) : null,
      })
    }
    case 'outline.list': {
      const projectId = String(need(payload, 'projectId'))
      const dir = await s.projectDir(root, projectId)
      return { outlines: await bookdb.listOutlines(dir) }
    }
    case 'ledger.rebuildMentions': {
      const projectId = String(need(payload, 'projectId'))
      const dir = await s.projectDir(root, projectId)
      return bookdb.rebuildAllMentions(dir)
    }
    case 'ledger.entities': {
      const projectId = String(need(payload, 'projectId'))
      const dir = await s.projectDir(root, projectId)
      const items = await bookdb.entityCounts(dir).catch(() => [])
      const status = await bookdb.storageStatus(dir).catch(() => null)
      return { items, stats: status && status.ledger ? status.ledger : null }
    }
    case 'ledger.digest': {
      const projectId = String(need(payload, 'projectId'))
      const dir = await s.projectDir(root, projectId)
      return bookdb.ledgerDigest(dir)
    }
    case 'ledger.unknown': {
      const projectId = String(need(payload, 'projectId'))
      const dir = await s.projectDir(root, projectId)
      const { db } = await bookdb.openBook(dir)
      const { listUnknown } = await import('./lib/ledgerdb.js')
      return { items: listUnknown(db, { status: String(payload.status ?? 'pending') }) }
    }
    case 'chapter.search': {
      const projectId = String(need(payload, 'projectId'))
      const query = String(need(payload, 'query')).trim()
      return s.searchChapter(root, projectId, query, payload.options ?? {})
    }
    case 'review.list': {
      const projectId = String(need(payload, 'projectId'))
      return filterRows(await s.getReviews(root, projectId), payload.filter)
    }
    case 'proposal.list': {
      const projectId = String(need(payload, 'projectId'))
      return filterRows(await s.listProposals(root, projectId), payload.filter)
    }
    case 'proposal.get': {
      const projectId = String(need(payload, 'projectId'))
      return s.getProposal(root, projectId, String(need(payload, 'proposalId')))
    }
    case 'run.get': {
      const projectId = String(need(payload, 'projectId'))
      return s.getRun(root, projectId)
    }
    case 'ledger.get': {
      const projectId = String(need(payload, 'projectId'))
      return s.getLedger(root, projectId)
    }
    case 'align.status': {
      const projectId = String(need(payload, 'projectId'))
      return alignStatus(s, root, projectId)
    }
    case 'usage.summary': {
      const projectId = payload.projectId ? String(payload.projectId) : undefined
      return summarizeUsage(ctx, s, root, projectId)
    }
    case 'settings.get': {
      const projectId = String(need(payload, 'projectId'))
      return s.getSettings(root, projectId)
    }
    case 'export.book': {
      const projectId = String(need(payload, 'projectId'))
      const format = String(payload.format ?? 'txt').trim() || 'txt'
      return s.exportBook(root, projectId, format, { includeSummary: payload.includeSummary === true })
    }

    // ── 写 ──────────────────────────────────────────────
    case 'chapter.save': {
      const projectId = String(need(payload, 'projectId'))
      const chapter = needNumber(payload, 'chapter')
      const text = String(payload.text ?? '')
      const create = payload.create === true
      if (!text.trim() && !create) throw invalid('正文为空，拒绝保存')
      const baseHash = String(payload.baseHash ?? '').trim()
      let current = null
      try {
        current = await s.readChapter(root, projectId, chapter)
      } catch {
        current = null
      }
      const exists = Boolean(current && (typeof current === 'object'))
      if (create && exists) throw invalid(`第 ${chapter} 章已存在，不能重复新建`)
      if (exists) {
        const currentHash = String(current?.meta?.contentHash ?? '').trim()
        if (!baseHash) throw invalid('缺少 baseHash：保存正文必须带当前版本 contentHash（先 chapter.get）')
        if (currentHash && baseHash !== currentHash) {
          throw staleError(`正文已在别处修改（当前 ${currentHash.slice(0, 12)}，提交 ${baseHash.slice(0, 12)}），请重新加载本章`)
        }
      } else if (baseHash) {
        throw staleError('章节不存在或已被删除，请重新加载目录')
      }
      const saved = await s.saveChapter(root, projectId, chapter, text, payload.meta ?? {}, {
        source: payload.source ?? 'editor',
        allowEmpty: create && !exists,
      })
      // 改动碰到了账本里的名字/数字才记「待同步」；纯文笔改动不打扰作者。
      if (typeof s.noteChapterChange === 'function') {
        try {
          const beforeText = exists ? String(current?.text ?? '') : ''
          const noted = await s.noteChapterChange(root, projectId, chapter, beforeText, text)
          if (noted && saved && typeof saved === 'object') saved.ledgerSync = noted
        } catch {
          // 同步状态是辅助信息，失败不影响保存
        }
      }
      return saved
    }
    case 'chapter.delete': {
      const projectId = String(need(payload, 'projectId'))
      const chapter = needNumber(payload, 'chapter')
      return s.deleteChapter(root, projectId, chapter)
    }
    case 'opinions.merge': {
      const projectId = String(need(payload, 'projectId'))
      const ids = Array.isArray(payload.ids) ? payload.ids : [payload.ids]
      if (!ids.filter(Boolean).length) throw invalid('缺少 ids')
      const dir = await s.projectDir(root, projectId)
      return bookdb.mergeOpinions(dir, ids.filter(Boolean), {
        text: String(payload.text ?? ''),
        after: String(payload.after ?? ''),
        role: String(payload.role ?? ''),
      })
    }
    case 'opinions.relatedChapters': {
      const projectId = String(need(payload, 'projectId'))
      const id = String(need(payload, 'id'))
      const dir = await s.projectDir(root, projectId)
      const opinion = await bookdb.getOpinion(dir, id)
      if (!opinion) throw invalid('意见不存在')
      return { chapters: await bookdb.relatedChaptersForOpinion(dir, opinion) }
    }
    case 'opinions.note': {
      const projectId = String(need(payload, 'projectId'))
      const id = String(need(payload, 'id'))
      const dir = await s.projectDir(root, projectId)
      return bookdb.patchOpinion(dir, id, { authorNote: String(payload.note ?? '') })
    }
    case 'opinions.patch': {
      const projectId = String(need(payload, 'projectId'))
      const id = String(need(payload, 'id'))
      const dir = await s.projectDir(root, projectId)
      return bookdb.patchOpinion(dir, id, payload.patch ?? omit(payload, ['projectId', 'id']))
    }
    case 'migrate.titles': {
      const projectId = String(need(payload, 'projectId'))
      const apply = Boolean(payload.apply)
      const chapters = listOf(await s.listChapters(root, projectId))
      const planned = []
      let done = 0
      for (const row of chapters) {
        const chapter = Number(row?.chapter ?? row?.id ?? 0)
        if (!chapter) continue
        let doc
        try { doc = await s.readChapter(root, projectId, chapter) } catch { continue }
        if (doc.format !== 'txt') continue
        const parsed = splitTitle(String(doc.text ?? ''))
        if (parsed.title) continue
        const title = String(doc.meta?.title ?? '').trim()
        if (!title) continue
        planned.push({ chapter, title })
        if (!apply) continue
        const nextText = `${title}\n\n${String(doc.text ?? '').replace(/^\n+/, '')}`
        await s.saveChapter(root, projectId, chapter, nextText, {}, { baseHash: doc.meta?.contentHash, source: 'title-migration' })
        done += 1
      }
      return { apply, planned: planned.length, done, items: planned.slice(0, 200) }
    }
    case 'outline.upsert': {
      const projectId = String(need(payload, 'projectId'))
      const item = payload.item && typeof payload.item === 'object' ? payload.item : omit(payload, ['projectId', 'item'])
      if (!Number(item.chapter)) throw invalid('大纲缺少章号 chapter')
      await s.upsertLedgerItem(root, projectId, 'outlines', item)
      const dir = await s.projectDir(root, projectId)
      return { outlines: await bookdb.listOutlines(dir) }
    }
    case 'outline.delete': {
      const projectId = String(need(payload, 'projectId'))
      const chapter = needNumber(payload, 'chapter')
      const ledger = await s.getLedger(root, projectId)
      const row = (Array.isArray(ledger.outlines) ? ledger.outlines : []).find((item) => Number(item.chapter) === chapter)
      if (row && row.id) await s.deleteLedgerItem(root, projectId, 'outlines', row.id)
      const dir = await s.projectDir(root, projectId)
      await bookdb.deleteOutline(dir, chapter).catch(() => {})
      return { outlines: await bookdb.listOutlines(dir) }
    }
    case 'opinions.accept': {
      const projectId = String(need(payload, 'projectId'))
      const id = String(need(payload, 'id'))
      const dir = await s.projectDir(root, projectId)
      const opinion = await bookdb.getOpinion(dir, id)
      if (!opinion) throw invalid('意见不存在')
      if (opinion.kind !== 'highlight' && Number(opinion.chapter) === 0 && String(opinion.after || '').trim()) {
        // 全书级意见：按 after 在书中自动定位最相似的一段，定位到就直接替换
        const afterText = String(opinion.after).trim()
        const mentioned = [...String(opinion.text || '').matchAll(/第\s*([0-9]+(?:\s*[、，,和\/]\s*[0-9]+)*)/g)]
          .flatMap((hit) => (hit[1].match(/[0-9]+/g) || []).map((num) => Number(num)))
          .filter((n) => n > 0)
        const allChapters = listOf(await s.listChapters(root, projectId)).map((row) => Number(row.chapter)).filter((n) => n > 0)
        const candidates = mentioned.length ? [...new Set(mentioned)] : allChapters
        const bigrams = (text) => {
          const clean = String(text || '').replace(/\s+/g, '')
          const map = new Map()
          for (let i = 0; i < clean.length - 1; i += 1) {
            const key = clean.slice(i, i + 2)
            map.set(key, (map.get(key) || 0) + 1)
          }
          return map
        }
        const dice = (a, b) => {
          const A = bigrams(a); const B = bigrams(b)
          let inter = 0; let na = 0; let nb = 0
          for (const value of A.values()) na += value
          for (const value of B.values()) nb += value
          for (const [key, value] of A) if (B.has(key)) inter += Math.min(value, B.get(key))
          return na + nb ? (2 * inter) / (na + nb) : 0
        }
        let best = { score: 0, chapter: 0, para: -1, text: '' }
        for (const chapterNo of candidates) {
          let doc
          try { doc = await s.readChapter(root, projectId, chapterNo) } catch { continue }
          const titleHint = String(doc.meta?.title ?? '')
          const parsed = splitTitle(doc.text, titleHint)
          const paragraphs = splitParagraphs(parsed.body)
          paragraphs.forEach((para, index) => {
            const score = dice(afterText, para.text)
            if (score > best.score) best = { score, chapter: chapterNo, para: index, text: para.text, raw: doc.text, parsed, paragraphs }
          })
        }
        if (!best.raw || best.score < 0.55) throw invalid('这条全书级意见定位不到对应段落（相似度不足），请让它按章给出带地址的意见')
        const nextBody = best.paragraphs.map((row, index) => (index === best.para ? afterText : row.text)).join('\n\n')
        const nextText = best.parsed.title ? `${best.parsed.title}\n\n${nextBody}\n` : `${nextBody}\n`
        await s.saveChapter(root, projectId, best.chapter, nextText, {}, { source: 'opinion-accept-global' })
        const resolved = await bookdb.resolveRelatedOpinions(dir, { sourceId: id, text: opinion.text, chapters: candidates })
        return { ok: true, applied: { chapter: best.chapter, para: best.para, score: Math.round(best.score * 100) }, resolved: resolved.resolved, opinion: await bookdb.patchOpinion(dir, id, { status: 'accepted' }) }
      }
      if (opinion.kind === 'highlight') {
        await bookdb.addHighlight(dir, {
          chapter: opinion.chapter,
          para: opinion.para,
          quote: '',
          comment: opinion.text,
          sourceOpinionId: opinion.id,
        })
        return bookdb.patchOpinion(dir, id, { status: 'accepted' })
      }
      if (!String(opinion.after || '').trim()) {
        throw invalid('这条意见只有问题、没有改法（after），不能直接采纳。请先点「让 AI 出改法」或补充你的建议。')
      }
      const doc = await s.readChapter(root, projectId, opinion.chapter)
      const raw = String(doc.text ?? '')
      const titleHint = String(doc.meta?.title ?? '')
      const { title, body } = splitTitle(raw, titleHint)
      const paragraphs = splitParagraphs(body)
      const at = Number(opinion.para)
      if (!(at >= 0) || !paragraphs[at]) throw invalid('意见地址已失效，请重新定位后再采纳')
      const index = buildIndex(raw, opinion.chapter, titleHint)
      if (opinion.paraHash && index.paras[at] && index.paras[at].hash !== opinion.paraHash) {
        await bookdb.patchOpinion(dir, id, { status: 'stale', staleReason: '正文已改动，段落指纹不一致' })
        throw invalid('正文已改动，这条意见地址失效，已标记为失效（stale）')
      }
      const nextBody = paragraphs.map((row, i) => (i === at ? String(opinion.after).trim() : row.text)).join('\n\n')
      const nextText = title ? `${title}\n\n${nextBody}\n` : `${nextBody}\n`
      await s.saveChapter(root, projectId, opinion.chapter, nextText, {}, { baseHash: doc.meta && doc.meta.contentHash, source: 'opinion-accept' })
      const resolved = await bookdb.resolveRelatedOpinions(dir, { sourceId: id, chapter: opinion.chapter, para: opinion.para, text: opinion.text, chapters: [opinion.chapter] })
      return { ok: true, resolved: resolved.resolved, opinion: await bookdb.patchOpinion(dir, id, { status: 'accepted' }) }
    }
    case 'opinions.reject': {
      const projectId = String(need(payload, 'projectId'))
      const id = String(need(payload, 'id'))
      const dir = await s.projectDir(root, projectId)
      return bookdb.patchOpinion(dir, id, { status: 'rejected' })
    }
    case 'ledger.confirm': {
      const projectId = String(need(payload, 'projectId'))
      const name = String(need(payload, 'name'))
      const dir = await s.projectDir(root, projectId)
      return bookdb.confirmUnknown(dir, name, {
        kind: String(payload.kind ?? 'character'),
        entityId: payload.entityId ? String(payload.entityId) : null,
        aliasOf: payload.aliasOf ? String(payload.aliasOf) : null,
        chapter: payload.chapter ?? null,
      })
    }
    case 'review.add': {
      const projectId = String(need(payload, 'projectId'))
      const items = payload.items ?? payload.reviews
      if (!Array.isArray(items) || items.length === 0) throw invalid('缺少 reviews（非空数组）')
      return s.addReviews(root, projectId, items)
    }
    case 'review.patch': {
      const projectId = String(need(payload, 'projectId'))
      const ids = Array.isArray(payload.ids) ? payload.ids : [payload.id ?? need(payload, 'reviewId')]
      return s.patchReviews(root, projectId, ids, payload.patch ?? { status: payload.status, note: payload.note })
    }
    case 'proposal.create': {
      const projectId = String(need(payload, 'projectId'))
      const proposal = payload.proposal && typeof payload.proposal === 'object' ? payload.proposal : omit(payload, ['projectId'])
      return s.createProposal(root, projectId, normalizeProposalPayload(proposal))
    }
    case 'proposal.update': {
      const projectId = String(need(payload, 'projectId'))
      const proposalId = String(need(payload, 'proposalId'))
      return s.updateProposal(root, projectId, proposalId, payload.patch ?? omit(payload, ['projectId', 'proposalId']))
    }
    case 'proposal.accept': {
      const projectId = String(need(payload, 'projectId'))
      return s.acceptProposal(root, projectId, String(need(payload, 'proposalId')))
    }
    case 'proposal.reject': {
      const projectId = String(need(payload, 'projectId'))
      return s.rejectProposal(root, projectId, String(need(payload, 'proposalId')), String(payload.reason ?? ''))
    }
    case 'proposal.batch': {
      const projectId = String(need(payload, 'projectId'))
      const ids = payload.ids
      if (!Array.isArray(ids) || ids.length === 0) throw invalid('缺少 ids（非空数组）')
      return s.batchProposals(root, projectId, ids, String(payload.action ?? 'accept'), { reason: String(payload.reason ?? '') })
    }
    case 'attention.merge': {
      const projectId = String(need(payload, 'projectId'))
      const chapter = needNumber(payload, 'chapter')
      const patch = payload.patch ?? payload.data ?? omit(payload, ['projectId', 'chapter'])
      return s.mergeAttention(root, projectId, chapter, patch)
    }
    case 'ledger.upsert': {
      const projectId = String(need(payload, 'projectId'))
      const kind = String(need(payload, 'kind'))
      return s.upsertLedgerItem(root, projectId, kind, payload.item ?? payload.data ?? omit(payload, ['projectId', 'kind']))
    }
    case 'ledger.sync': {
      const projectId = String(need(payload, 'projectId'))
      const action = String(payload.action ?? 'status').trim()
      if (action === 'ack') return s.ackLedgerSync(root, projectId, payload.chapters)
      // 全书同步：plan 建批 / batch-done 记进度 / reset 清计划 / workorder(mode=full) 发下一批
      if (action === 'plan') {
        return s.planLedgerSync(root, projectId, {
          from: payload.from,
          to: payload.to,
          batchSize: payload.batchSize,
        })
      }
      if (action === 'batch-done') return s.completeLedgerSyncBatch(root, projectId, { batch: payload.batch })
      if (action === 'reset') return s.resetLedgerSync(root, projectId)
      if (action === 'workorder') {
        const status = await s.getLedgerSync(root, projectId)
        const project = await s.getProject(root, projectId).catch(() => null)
        const data = project?.project && typeof project.project === 'object' ? project.project : project || {}
        if (String(payload.mode ?? '').trim() === 'full') {
          if (!status.full) throw invalid('还没有全书同步计划，请先建立计划（action=plan）')
          const full = status.full
          const wanted = Math.floor(Number(payload.batch) || 0)
          const batch = wanted > 0 ? full.batches[wanted - 1] : full.batches.find((row) => row.status !== 'done')
          if (!batch) return { prompt: '', done: true, full, chapters: status.chapters, pending: status.pending }
          const rows = await s.listChapters(root, projectId)
          const byChapter = new Map(rows.map((row) => [Number(row.chapter), row]))
          const batchChapters = batch.chapters.map((chapter) => byChapter.get(Number(chapter)) ?? { chapter: Number(chapter), title: '', words: 0 })
          const ledger = await s.getLedger(root, projectId).catch(() => ({}))
          const prompt = prompts.fullLedgerSyncWorkorder({
            project: data,
            ledger,
            batch: { ...batch, chapters: batchChapters, total: full.total },
            full: { from: full.from, to: full.to, done: full.done, total: full.total, chapters: status.chapters },
          })
          return { prompt, batch, full, chapters: status.chapters, pending: status.pending }
        }
        const chapters = Array.isArray(payload.chapters) && payload.chapters.length
          ? status.pending.filter((row) => payload.chapters.map(Number).includes(Number(row.chapter)))
          : status.pending
        return {
          prompt: prompts.ledgerSyncWorkorder({ project: data, chapters }),
          pending: status.pending,
          full: status.full,
          chapters: status.chapters,
        }
      }
      if (action !== 'status') throw invalid(`ledger.sync 不支持 action=${action}`)
      return s.getLedgerSync(root, projectId)
    }
    case 'ledger.delete': {
      const projectId = String(need(payload, 'projectId'))
      const kind = String(need(payload, 'kind'))
      const itemId = payload.itemId ?? payload.id
      if (itemId === undefined || itemId === null) throw invalid('缺少参数 itemId')
      return s.deleteLedgerItem(root, projectId, kind, String(itemId))
    }
    case 'settings.save': {
      const projectId = String(need(payload, 'projectId'))
      return s.saveSettings(root, projectId, payload.patch ?? payload.settings ?? omit(payload, ['projectId']))
    }
    case 'run.save': {
      const projectId = String(need(payload, 'projectId'))
      const patch = { ...(payload.run ?? payload.patch ?? omit(payload, ['projectId'])) }
      // 新建/替换动作：先重置旧 run，避免继承旧备注/开始时间/结束时间。
      if (payload.replace === true) await s.resetRun(root, projectId)
      if (patch.kind !== undefined) {
        const normalized = normalizeRunKind(patch.kind, patch.variant)
        patch.kind = normalized.kind
        patch.variant = normalized.variant
        if (['rewrite', 'expand'].includes(normalized.kind) && String(patch.scope ?? '') === 'chapter') {
          throw invalid('单章改写请回正文页「重写本章」走整章改写稿（可采纳/继续改）；全文动作用于整书/区间改写。')
        }
      }
      // 新建 run 时补阶段模板：创建（ready）全部 pending，开工（running）才把第一阶段置 running。
      if (patch.kind && (!Array.isArray(patch.stages) || patch.stages.length === 0)) {
        const stages = runStageDefaults(patch.kind, patch.variant).map((stage, index) => ({
          ...stage,
          status: patch.status === 'running' && index === 0 ? 'running' : 'pending',
        }))
        patch.stages = stages
        patch.currentStage = patch.status === 'running' ? (stages[0]?.id ?? '') : ''
      }
      return s.saveRun(root, projectId, patch)
    }
    case 'run.reset': {
      const projectId = String(need(payload, 'projectId'))
      return s.resetRun(root, projectId)
    }
    case 'chat.send':
      return chatSend(ctx, s, root, payload)
    case 'chat.sessions':
      return chatSessions(ctx, root, payload)
    case 'map.background':
      return generateMapBackground(s, root, payload)
    case 'map.applyPlan': {
      const projectId = String(need(payload, 'projectId'))
      return applyMapPlan({ store: s, root, projectId, text: String(payload.text ?? ''), savedAt: String(payload.savedAt ?? '') })
    }
    case 'app.open':
      return openInBrowser(ctx, options)
    case 'project.create': {
      const title = String(payload.title ?? payload.name ?? '').trim()
      const presetId = String(payload.presetId ?? '').trim()
      const chapters = Math.max(0, Number(payload.targetChapters) || Number(payload.chapters) || 0)
      const wordsPerChapter = Math.max(0, Number(payload.wordsPerChapter) || Number(payload.chapterWords) || 0)
      const targetWords = Math.max(0, Number(payload.targetWords) || 0) || (chapters > 0 && wordsPerChapter > 0 ? chapters * wordsPerChapter : 0)
      const created = await s.createProject(root, {
        title,
        name: title,
        genre: String(payload.genre ?? ''),
        style: String(payload.style ?? ''),
        presetId,
        logline: String(payload.logline ?? payload.idea ?? '').trim(),
        description: String(payload.description ?? payload.prompt ?? '').trim(),
        targetChapters: chapters,
        targetWords,
        idea: String(payload.idea ?? payload.prompt ?? '').trim(),
      })
      const project = created?.project ?? created
      // 新书要立刻有独立工作区：否则工作单只能投进别的会话（作者会看到工作单出现在当前对话里）
      const withWorkspace = await ensureProjectWorkspace(ctx, s, root, project, title).catch((error) => {
        console.error('[novel-desk] 创建工作区失败', error)
        return project
      })
      const at = String(withWorkspace?.updatedAt ?? project?.updatedAt ?? '')
      return {
        project: withWorkspace,
        projectId: String(withWorkspace?.id ?? project?.id ?? ''),
        workspaceId: String(withWorkspace?.workspaceId ?? ''),
        workspacePath: String(withWorkspace?.workspacePath ?? ''),
        createdAt: at,
      }
    }
    case 'import.scan':
      return importScan(payload)
    case 'import.run':
      return importRun(s, root, payload)
    default:
      throw invalid(`未知操作：${op}`)
  }
}

// ── 用默认浏览器打开工作台（app.open） ─────────────────────

/**
 * 在 URL 上加「显式打开工作台」标记：`#novel-desk=1`。
 *
 * 为什么放 hash 而不是 query：浏览器首次打开 app.open 的链接时，宿主会把
 * `/?token=...` 用 303 重定向到干净目录 `./`，**query 会被整个丢掉**；hash 不会
 * 发给服务端，且按规范会随重定向继承（Location 没有 fragment 时沿用原 fragment），
 * 所以只有 hash 标记能活着到客户端。
 *
 * 只有带这个标记的浏览器标签才会自动铺开工作台。DSH Remote（dsh-pocket）把同一套
 * DSH 页面交给手机浏览器，页面里没有这个标记；如果仍按「非 Electron 即自动展开」，
 * 手机一进远程就会被全屏工作台盖住。
 */
function withStandaloneMarker(url) {
  const text = String(url ?? '')
  if (!text) return text
  const hashAt = text.indexOf('#')
  const base = hashAt >= 0 ? text.slice(0, hashAt) : text
  const hash = hashAt >= 0 ? text.slice(hashAt + 1) : ''
  const query = base.includes('?') ? base.slice(base.indexOf('?') + 1) : ''
  const marked = (raw) => /(?:^|[?&#])novel-desk=1(?:&|$)/.test(String(raw ?? ''))
  if (marked(hash) || marked(query)) return text
  return `${base}${hash ? `#${hash}&novel-desk=1` : '#novel-desk=1'}`
}

/**
 * 计算「在默认浏览器打开工作台」的 URL。
 *
 * 页面就是宿主自己的 index 页（本插件的客户端模块已注入其中），所以：
 *   - 认证复用宿主：connection.authenticatedUrl 给普通 Web URL 加上一次性进程 token，
 *     浏览器首次访问时由宿主换成 cookie，之后就是正常的 DSH Web 会话；
 *   - 客户端只在带 `#novel-desk=1` 标记的浏览器标签里自动展开全屏工作台
 *     （client.js 的 IS_STANDALONE_TAB；DSH Remote 的手机页面不带标记，不会被盖住）；
 *   - 关闭 DSH 后宿主 Web 服务随之停止，页面自然失效（符合「关 dsh 自动关闭」）。
 *
 * @returns {string} 可直接交给系统浏览器打开的 URL
 */
export function browserUrl(ctx = {}, options = {}) {
  const webServer = options.webServer ?? ctx?.get?.('webServer') ?? null
  const connection = options.connection ?? ctx?.get?.('connection') ?? null
  let origin = ''
  try {
    origin = String(webServer?.getOrigin?.() ?? '').trim()
  } catch {
    origin = ''
  }
  if (!origin) throw invalid('宿主还没有启动 Web 服务，无法在浏览器打开')
  const clean = origin.replace(/\/+$/, '') + '/'
  try {
    const authed = connection?.authenticatedUrl?.(clean)
    if (authed) return withStandaloneMarker(String(authed))
  } catch {
    // 拿不到 token 就退回干净 URL（浏览器里可能落到 401 页，但至少链接可复制）
  }
  return withStandaloneMarker(clean)
}

/** 调系统默认浏览器打开 URL。返回是否成功发起（不等待、不抛错）。 */
function launchBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on?.('error', () => {})
    child.unref?.()
    return true
  } catch {
    return false
  }
}

export function openInBrowser(ctx = {}, options = {}) {
  const url = browserUrl(ctx, options)
  const opened = launchBrowser(url)
  return {
    url,
    opened,
    hint: opened
      ? '已在默认浏览器打开：关掉 DSH 后这个页面会随宿主一起失效'
      : '自动打开失败，请手动复制链接到浏览器',
  }
}

// ── HTTP handler ────────────────────────────────────────────

/**
 * 生成 API handler（mountRoute 与测试共用）。
 * @param {object} ctx
 * @param {{root?:string, store?:object, connection?:object, webServer?:object}} [options]
 */
export function createHandler(ctx = {}, options = {}) {
  return async function handler(req, res) {
    const connection = options.connection ?? ctx?.get?.('connection')
    const rejection = guard(req, connection)
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname.replace(/\/+$/, '').endsWith('/ping')) {
      try {
        sendJson(res, 200, { ok: true, value: await handleRpc({ op: 'ping' }, ctx, options) })
      } catch (error) {
        sendError(res, error)
      }
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { code: 'invalid', message: '只支持 POST /novel-desk/api（GET /ping 除外）' } })
      return
    }
    const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      sendJson(res, 415, { ok: false, error: { code: 'invalid', message: 'content-type 必须是 application/json' } })
      return
    }
    try {
      const body = await readBody(req)
      const value = await handleRpc(body, ctx, options)
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        sendJson(res, 413, { ok: false, error: { code: 'invalid', message: error.message } })
        return
      }
      sendError(res, error)
    }
  }
}

/**
 * 挂路由 + boot 注入（在 apply 中调用一次）。
 */
export function mountRoute(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (c) => {
    try {
    const webServer = c?.webServer
    if (!webServer || typeof webServer.register !== 'function') return
    const connection = c.get?.('connection')
    // UI 跑在 DSH index 页面内，已带 cookie：相对路径最稳；authenticatedUrl 只在拿不到相对路径时兜底。
    let apiUrl = ROUTE
    try {
      if (!apiUrl) {
        const origin = String(webServer.getOrigin?.() ?? '')
        const authed = origin ? connection?.authenticatedUrl?.(origin + ROUTE) : ''
        if (authed) apiUrl = String(authed)
      }
    } catch {
      apiUrl = ROUTE
    }
    const disposers = []
    const disposeApi = webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: createHandler(ctx, { connection, webServer }),
    })
    if (typeof disposeApi === 'function') disposers.push(disposeApi)
    if (typeof webServer.tapIndex === 'function') {
      const disposeTap = webServer.tapIndex((html) => injectBoot(html, { apiUrl }))
      if (typeof disposeTap === 'function') disposers.push(disposeTap)
    }
    const effect = c.effect ?? ctx.effect
    if (typeof effect === 'function') {
      effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 已清理 */
          }
        }
      }, 'novel-desk: api + boot')
    }
    } catch (error) {
      bootErrors.push({ at: 'webServer', message: error?.message || String(error) })
    }
  })
}

// ── 工具输出与格式化 ────────────────────────────────────────

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

function formatProjects(projects) {
  const rows = listOf(projects)
  if (rows.length === 0) return '作品库为空：请先在工作台新建作品。'
  return [
    `# 作品库（${rows.length} 部）`,
    ...rows.map((row) => `- ${row?.name ?? row?.title ?? '未命名'}｜id=${row?.id ?? '?'}｜${Number(row?.chapters ?? 0) || 0} 章｜${Number(row?.words ?? 0) || 0} 字${row?.updatedAt ? `｜更新 ${row.updatedAt}` : ''}`),
  ].join('\n')
}

function formatContext(context) {
  if (!context || typeof context !== 'object') return '（没有上下文）'
  const project = context.project ?? {}
  const lines = [
    `# 《${project.title || project.name || '未命名'}》 id=${project.id ?? '?'}`,
    `类型：${project.genre ?? '—'}｜风格：${textOf(project.style ?? project.presets?.style ?? '—', 60)}｜计划 ${project.targetChapters ?? '—'} 章`,
    '',
    prompts.ATTENTION_PRINCIPLE,
    '',
    ...prompts.attentionBriefLines({ attention: context.attention }),
  ]
  const characters = listOf(context.characters)
  if (characters.length > 0) {
    lines.push(`## 人物（${characters.length}）`)
    for (const row of characters.slice(0, 15)) lines.push(`- ${row?.name ?? '?'}${row?.role ? `（${row.role}）` : ''}：${textOf(row?.summary ?? row?.note ?? '', 50)}`)
  }
  for (const [key, label] of [['facts', '事实'], ['foreshadow', '伏笔'], ['conflicts', '冲突'], ['events', '事件'], ['locations', '地点']]) {
    const rows = listOf(context[key])
    if (rows.length > 0) lines.push(`${label}（${rows.length}）：${rows.slice(0, 5).map((row) => textOf(row?.title ?? row?.name ?? row?.content ?? row?.summary ?? '?', 30)).join('；')}`)
  }
  const recent = listOf(context.recent)
  if (recent.length > 0) lines.push(`最近章节：${recent.slice(-5).map((row) => `第${row?.chapter ?? '?'}章`).join('、')}`)
  return lines.join('\n')
}

function formatToc(chapters, attention) {
  const rows = listOf(chapters)
  if (rows.length === 0) return '还没有章节。'
  const attentionMap = new Map(listOf(attention).map((row) => [Number(row?.chapter), row]))
  const lines = [`# 目录（${rows.length} 章）`]
  for (const row of rows) {
    const number = Number(row?.chapter ?? row?.id ?? 0)
    const record = attentionMap.get(number)
    const score = record?.score === null || record?.score === undefined ? '—' : record.score
    lines.push(`- 第${number}章《${row?.title ?? ''}》｜${Number(row?.words ?? 0) || 0} 字｜${row?.status ?? '—'}｜注意力 ${score}`)
  }
  return lines.join('\n')
}

/** 章节标签：0 表示全书级问题。 */
function chapterLabel(number) {
  const n = Number(number)
  if (!Number.isFinite(n)) return '章节?'
  return n === 0 ? '全书' : `第${n}章`
}

function formatReviews(reviews) {
  const rows = listOf(reviews)
  if (rows.length === 0) return '审阅收件箱为空。'
  const open = rows.filter((row) => !['resolved', 'done', 'closed', 'archived'].includes(String(row?.status ?? 'open')))
  const lines = [`# 审阅收件箱（未处理 ${open.length} / 共 ${rows.length}）`]
  for (const row of open.slice(0, 60)) {
    lines.push(`- [${row?.id ?? '?'}] ${chapterLabel(row?.chapter)}｜${row?.source ?? 'logic'}｜${row?.severity ?? 'minor'}｜${textOf(row?.issue ?? '', 100)}${row?.quote ? `\n  原文：「${textOf(row.quote, 80)}」` : ''}`)
  }
  return lines.join('\n')
}

function formatProposals(proposals) {
  const rows = listOf(proposals)
  if (rows.length === 0) return '没有提案。'
  const pending = rows.filter((row) => String(row?.status ?? 'pending') === 'pending')
  const lines = [`# 提案（pending ${pending.length} / 共 ${rows.length}）`]
  for (const row of pending.slice(0, 60)) {
    lines.push(`- [${row?.id ?? '?'}] ${chapterLabel(row?.chapter)}｜${row?.kind ?? '?'}｜${textOf(row?.title ?? '', 80)}${row?.summary ? `：${textOf(row.summary, 80)}` : ''}`)
  }
  return lines.join('\n')
}

function formatRun(run) {
  if (!run || typeof run !== 'object' || Object.keys(run).length === 0) return '当前没有全文动作 run。'
  const data = run.run && typeof run.run === 'object' ? run.run : run
  const stages = listOf(data.stages)
  const normalized = normalizeRunKind(data.kind, data.variant)
  const label = `${RUN_KIND_LABEL[normalized.kind] ?? data.kind ?? '—'}${normalized.variant ? `（${RUN_VARIANT_LABEL[normalized.variant] ?? normalized.variant}）` : ''}`
  const scopeText = data.scope === 'book'
    ? '全书'
    : data.scope === 'range'
      ? `第${data.chapter}–${data.endChapter ?? data.chapter}章`
      : data.chapter
        ? `第${data.chapter}章`
        : '—'
  return [
    `# 全文动作 run：${label} ｜ scope=${scopeText} ｜ 状态=${data.status ?? '—'}`,
    normalized.kind === 'continue' ? '目标：按大纲从下一章起继续写新章（写正文，会直接落盘）。' : '',
    data.chapter && data.scope === 'range' ? `范围：第${data.chapter}–${data.endChapter ?? data.chapter}章` : '',
    data.variant && normalized.kind === 'rewrite' && normalized.variant === 'style' ? '强调：只动语言层，事实/专名/数字/对白条数冻结。' : '',
    data.variant && normalized.kind === 'rewrite' && normalized.variant === 'logic' ? '强调：允许改事件顺序与因果，但要保住设定与人物动机。' : '',
    `预算：token ${data.budget?.maxTokens ?? 0}（0=不限）｜费用 ¥${data.budget?.maxCostCNY ?? 0}（0=不限）`,
    stages.length > 0 ? `阶段：${stages.map((stage) => `${stage.title ?? stage.id ?? '?'}=${stage.status ?? 'pending'}`).join(' → ')}` : '阶段：未分阶段',
    data.note ? `备注：${textOf(data.note, 200)}` : '',
  ].filter(Boolean).join('\n')
}

function formatLedger(ledger) {
  if (!ledger || typeof ledger !== 'object') return '（没有账本）'
  const lines = ['# 账本']
  for (const [key, value] of Object.entries(ledger)) {
    if (Array.isArray(value)) lines.push(`- ${key}（${value.length}）：${value.slice(0, 5).map((row) => textOf(row?.title ?? row?.name ?? row?.content ?? row?.summary ?? '?', 40)).join('；')}`)
    else if (value && typeof value === 'object') lines.push(`- ${key}：${textOf(value.title ?? value.name ?? '已设置', 40)}`)
  }
  return lines.join('\n')
}

function formatSearch(hits) {
  const rows = listOf(hits)
  if (rows.length === 0) return '没有命中。'
  return [`# 搜索结果（${rows.length}）`, ...rows.slice(0, 80).map((row) => `- 第${row?.chapter ?? '?'}章${row?.title ? `《${row.title}》` : ''}：${textOf(row?.snippet ?? row?.text ?? '', 120)}`)].join('\n')
}

function formatAlign(status) {
  return [
    `# 对齐简报：${status.project || status.projectId}`,
    `- 章节 ${status.chapters} 章 / ${status.words} 字`,
    `- 待处理审阅 ${status.openReviews} 条｜待采纳提案 ${status.pendingProposals} 条`,
    `- 注意力均分：${status.attentionAvg === null ? '未打分' : `${status.attentionAvg} 分`}（已测 ${status.attention.avg === null ? 0 : status.attention.scored} 章 / 未测 ${status.attention.unscored} 章）`,
    `- 账本：${Object.entries(status.ledgerCounts).map(([key, count]) => `${key} ${count}`).join('、')}`,
  ].join('\n')
}

// ── 6 个 Agent 工具 ─────────────────────────────────────────

const readTool = {
  name: 'novel_desk_read',
  description: '读小说工作台：projects=作品列表 / context=设定与账本摘要 / toc=目录 / chapter=单章正文 / inbox=审阅收件箱 / proposals=提案 / run=全文动作 / ledger=账本 / search=全文搜索 / align=对齐简报。',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['projects', 'context', 'toc', 'chapter', 'inbox', 'proposals', 'run', 'ledger', 'search', 'align'], description: '读取类型' },
      projectId: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      chapter: { type: 'number', description: '章号（op=chapter 用）' },
      query: { type: 'string', description: '搜索词（op=search 用）' },
    },
    required: ['op'],
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args = {}) {
    const s = store
    const root = s.defaultRoot()
    await s.ensureRoot(root)
    const op = String(args.op ?? '')
    if (op === 'projects') return formatProjects(await s.listProjects(root))
    const project = await resolveProject(s, root, args.projectId)
    const projectId = String(project.id)
    switch (op) {
      case 'context':
        return formatContext(await s.getContext(root, projectId))
      case 'toc': {
        const [chapters, attention] = await Promise.all([s.listChapters(root, projectId), s.getAttention(root, projectId).catch(() => [])])
        return formatToc(chapters, attention)
      }
      case 'chapter': {
        const number = needNumber(args, 'chapter')
        const chapter = await s.readChapter(root, projectId, number)
        const text = String(chapter?.text ?? '')
        return [`# 第${number}章《${chapter?.title ?? ''}》（${text.length} 字）`, '', text].join('\n')
      }
      case 'inbox':
        return formatReviews(await s.getReviews(root, projectId))
      case 'proposals':
        return formatProposals(await s.listProposals(root, projectId))
      case 'run':
        return formatRun(await s.getRun(root, projectId))
      case 'ledger':
        return formatLedger(await s.getLedger(root, projectId))
      case 'search': {
        const query = String(need(args, 'query')).trim()
        return formatSearch(await s.searchChapter(root, projectId, query))
      }
      case 'align':
        return formatAlign(await alignStatus(s, root, projectId))
      default:
        throw new Error(`未知 op：${op || '(空)'}`)
    }
  },
}

const reviewTool = {
  name: 'novel_desk_review',
  description: '提交审阅意见：source 四路 logic/attention/ai-style/reader，每条必须带章号、severity、逐字 quote（≥4 字）、issue、suggestion；全书级问题 chapter=0。',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      dispatchId: { type: 'string', description: '派单票据（先 novel_desk_dispatch）' },
      origin: { type: 'string', description: '来源标记，如 review/cold-read/recheck/ai' },
      reviews: {
        type: 'array',
        description: '审阅条目数组',
        items: {
          type: 'object',
          properties: {
            chapter: { type: 'number', description: '章号；0=全书级' },
            source: { type: 'string', enum: ['logic', 'attention', 'ai-style', 'reader'] },
            severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'suggestion'] },
            quote: { type: 'string', description: '逐字原文（尽量照抄；对不上只标记，不丢）' },
            para: { type: 'number', description: '段号（正文段落，从 0 开始；标题意见用 anchor=title）' },
            anchor: { type: 'string', enum: ['paragraph', 'title', 'chapter', 'quote'], description: '地址类型' },
            after: { type: 'string', description: '该段替换成文（整段）；有改法就写，采纳即替换' },
            issue: { type: 'string' },
            suggestion: { type: 'string' },
            dimension: { type: 'string', description: '中文维度标签（可省略，服务端按 source 派生）' },
          },
          required: ['chapter', 'source', 'issue'],
          additionalProperties: true,
        },
      },
    },
    required: ['dispatchId', 'reviews'],
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args = {}) {
    const s = store
    const root = s.defaultRoot()
    await s.ensureRoot(root)
    const project = await resolveProject(s, root, args.projectId)
    const reviews = Array.isArray(args.reviews) ? args.reviews : []
    if (reviews.length === 0) throw new Error('reviews 不能为空')
    const ticket = requireTicket(args.dispatchId, { projectId: project.id })
    const GENERAL_ROLES = ['author', 'editor', 'publisher']
    for (const row of reviews) {
      const needRole = roleForSource(row?.source).id
      if (ticket.role !== needRole && !GENERAL_ROLES.includes(ticket.role)) {
        throw new Error(`票据角色 ${ticket.role} 与意见来源 ${row?.source} 需要的角色 ${needRole} 不符：每条路请单独 dispatch。`)
      }
    }
    if (reviews.length > 5) throw new Error(`一次最多提交 5 条意见（收到 ${reviews.length} 条）：分多次调用，避免一个大 JSON 解析失败。`)
    for (const row of reviews) {
      if (Number(row?.chapter) === 0 && String(row?.after ?? '').trim()) {
        throw new Error('全书级意见不能带 after：请拆成按章意见，每个受影响段落一条（chapter>0 + para/quote + after）。')
      }
      if (String(row?.issue ?? '').length > 200) throw new Error('issue 超过 200 字：写清问题即可，不要长篇分析。')
      if (String(row?.after ?? '').length > 4000) throw new Error('after 超过 4000 字：只替换指到的那一段，整段成文即可。')
      if (String(row?.quote ?? '').length > 400) throw new Error('quote 超过 400 字：只引指到的那一段/一句。')
    }
    const items = reviews.map((row) => ({
      ...row,
      chapter: Number(row?.chapter) || 0,
      source: String(row?.source ?? 'logic'),
      origin: String(row?.origin ?? args.origin ?? 'review'),
    }))
    const patchItems = reviews.filter((row) => String(row?.opinionId ?? '').trim())
    const addItems = reviews.filter((row) => !String(row?.opinionId ?? '').trim())
    let patched = 0
    if (patchItems.length) {
      const dir = await s.projectDir(root, String(project.id))
      for (const row of patchItems) {
        const after = String(row?.after ?? '').trim()
        if (!after) throw new Error(`意见 ${row.opinionId} 没有 after：批量改法每条都必须给整段替换。`)
        await bookdb.patchOpinion(dir, String(row.opinionId).trim(), { after, status: 'open' })
        patched += 1
      }
    }
    const result = addItems.length ? await s.addReviews(root, String(project.id), addItems) : { added: 0 }
    requireTicket(args.dispatchId, { projectId: project.id, consume: true })
    const count = Number(result?.added) || 0
    const skipped = Number(result?.skipped) || 0
    const reasons = Array.isArray(result?.skippedReasons) ? result.skippedReasons : []
    if (count === 0 && patched === 0) {
      throw new Error(`没有写入任何审阅（${skipped} 条被跳过）${reasons.length > 0 ? `：${reasons.slice(0, 3).join('；')}` : ''}；chapter>0 时 quote 必须 ≥4 字、逐字出现在该章正文里且只出现一次；全书级问题用 chapter=0。`)
    }
    const tail = skipped > 0
      ? `，跳过 ${skipped} 条（引文未逐字命中、无法唯一定位或重复${reasons.length > 0 ? `：${reasons.slice(0, 3).join('；')}` : ''}）`
      : ''
    return patched
      ? `已为 ${patched} 条意见生成整段改法${count ? `，另外新增 ${count} 条审阅` : ''}（作品《${project.name ?? project.title ?? project.id}》）。作者在「意见」页逐条采纳即可替换。`
      : `已提交 ${count} 条审阅${tail}（作品《${project.name ?? project.title ?? project.id}》）。作者在「意见」页逐条处理。`
  },
}

const proposeTool = {
  name: 'novel_desk_propose',
  description: '提交提案（不改正文）：kind=patch-paragraph（逐段 before/after）/ rewrite-chapter（整章 content）/ ledger-fix（账本修订）/ book-fix（全书修改，跨章补丁）。正文纯文本，场景分隔用 ※。',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      kind: { type: 'string', enum: ['patch-paragraph', 'rewrite-chapter', 'ledger-fix', 'book-fix'] },
      chapter: { type: 'number', description: '章号（整书级提案可省略；book-fix 必须为 0）' },
      title: { type: 'string' },
      summary: { type: 'string' },
      items: { type: 'array', description: 'patch-paragraph: [{before,after,why,reviewIds}]；rewrite-chapter: [{content}]；ledger-fix: [{kind,id,patch}]；book-fix: [{chapter,before,after,why,reviewIds}]', items: { type: 'object' } },
      data: { type: 'object', description: '完整 data（与 items 二选一，data 优先）' },
    },
    required: ['kind', 'title'],
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args = {}) {
    const s = store
    const root = s.defaultRoot()
    await s.ensureRoot(root)
    const project = await resolveProject(s, root, args.projectId)
    const kind = String(args.kind ?? '')
    const items = Array.isArray(args.items) ? args.items : []
    const data = args.data && typeof args.data === 'object' ? { ...args.data } : {}
    if (!data.content && !data.patches && !data.items && !data.ledgerFixes && items.length > 0) {
      if (kind === 'patch-paragraph') data.patches = items
      else if (kind === 'rewrite-chapter') data.content = String(items[0]?.content ?? '')
      else data.items = items
    }
    // ledger-fix 在提交时就把形状卡死：否则等作者点批准才发现没有账本修订项
    if (kind === 'ledger-fix' && store.ledgerFixesOf(data).length === 0) {
      throw invalid('ledger-fix 提案缺少账本修订项：items=[{kind,id,patch}]（或 data.ledgerFixes）；kind 用 world/facts/characters/events/locations/foreshadow/conflicts/outlines/highlights/presets')
    }
    const proposal = normalizeProposalPayload({
      kind,
      chapter: chapterNumber(args.chapter),
      title: String(args.title ?? ''),
      summary: String(args.summary ?? ''),
      data,
      source: 'agent',
    })
    const created = await s.createProposal(root, String(project.id), proposal)
    return `已提交提案 ${created?.id ?? ''}（${kind}${proposal.chapter ? ` / 第${proposal.chapter}章` : ''}）。作者在「提案」页采纳后才会落盘。`
  },
}

const dispatchTool = {
  name: 'novel_desk_dispatch',
  description: '派单票据：主对话必须先调用本工具，拿到 dispatchId，再起子 agent 执行；子 agent 提交 AI 意见/冷读时必须带 dispatchId。角色：editor/publisher/author/stylist/continuity/cold-reader/ai-auditor。',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      role: { type: 'string', enum: ROLES.map((role) => role.id), description: '派给哪个角色（子 agent）' },
      task: { type: 'string', description: '本子 agent 要做的事（一句话）' },
      materials: { type: 'string', description: '只给它哪些材料（段落切片/整章路径/可疑点）；不要贴全书' },
    },
    required: ['role', 'task'],
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args = {}) {
    const s = store
    const root = s.defaultRoot()
    await s.ensureRoot(root)
    const project = await resolveProject(s, root, args.projectId)
    const role = String(args.role ?? '')
    const roleInfo = ROLE_BY_ID[role]
    if (!roleInfo) throw new Error(`未知角色：${role || '(空)'}；可选：${ROLES.map((row) => row.id).join(' / ')}`)
    const ticket = issueTicket({ role, projectId: String(project.id), task: String(args.task ?? '') })
    return dispatchPrompt({ ticket, roleInfo, task: String(args.task ?? ''), materials: String(args.materials ?? '') })
  },
}

const attentionTool = {
  name: 'novel_desk_attention',
  description: '注意力=冷读：measured=提交冷读结果（score + points 指定地址的评价，亮点/不足）；recheck=冷读工作单；design=写前设计（可选，不进评价）。标准只有一条：ATTENTION IS ALL YOU NEED。一次只交 1 章。',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      dispatchId: { type: 'string', description: '冷读必须带派单票据（先 novel_desk_dispatch role=cold-reader）' },
      op: { type: 'string', enum: ['design', 'measured', 'workorder', 'recheck'] },
      chapter: { type: 'number', description: 'design/measured：要提交的章号（推荐单章扁平写法）' },
      chapters: { type: 'array', items: { type: 'number' }, description: '章号数组（workorder/recheck 用）' },
      items: { type: 'array', items: { type: 'object' }, description: 'design/measured 的兼容写法：一次最多 1–5 条，推荐改用扁平参数' },
      type: { type: 'string', description: 'design：event/emotion/language/mystery/relationship' },
      hook: { type: 'string', description: 'design：钩子设计（读者会看到什么）' },
      tension: { type: 'string', description: 'design：张力设计' },
      payoff: { type: 'string', description: 'design：回报设计' },
      cliff: { type: 'string', description: 'design：章末牵引设计' },
      question: { type: 'string', description: 'design：章末未决问题' },
      designScore: { type: 'number', description: 'design：设计分 0–100' },
      status: { type: 'string', description: 'design：默认 planned（可选）' },
      score: { type: 'number', description: 'measured：实测总分 0–100（= breakdown 四项合计）' },
      breakdown: {
        type: 'object',
        description: 'measured：四拍实测分（hook/tension/payoff/cliff，满分 20/20/30/30，score 必须等于合计）',
        properties: {
          hook: { type: 'number' },
          tension: { type: 'number' },
          payoff: { type: 'number' },
          cliff: { type: 'number' },
        },
      },
      notes: {
        type: 'array',
        description: 'measured：冷读的不足/亮点（可选），每项 {chapter, comment, after?}',
        items: {
          type: 'object',
          properties: {
            chapter: { type: 'number' },
            comment: { type: 'string' },
            after: { type: 'string', description: 'weakness：整段替换成文（可选）' },
            quote: { type: 'string', description: 'highlight：这类设为高光，会直接进高光账本' },
            kind: { type: 'string', enum: ['highlight', 'weakness'] },
          },
          required: ['chapter', 'comment'],
          additionalProperties: false,
        },
      },
      points: {
        type: 'array',
        description: 'measured：指定地址的评价（数量不限）。每条 para 段号（正文段落，从 0 开始）、quote 逐字引文、kind=highlight|weakness、comment≤80字、weakness 必须带 after（整段替换成文）',
        items: {
          type: 'object',
          properties: {
            para: { type: 'number', description: '正文段号，从 0 开始（标题不算段）' },
            quote: { type: 'string', description: '该段逐字原文，用于核对地址' },
            kind: { type: 'string', enum: ['highlight', 'weakness'] },
            comment: { type: 'string', description: '≤80 字：为什么' },
            after: { type: 'string', description: 'weakness：该段替换成文（整段）；highlight 不写' },
          },
        },
      },
      verdict: { type: 'string', description: 'measured：会/犹豫/不会' },
      weakest: { type: 'string', description: 'measured：四拍最弱项（hook/tension/payoff/cliff）' },
      detail: { type: 'string', description: 'measured：一段打分说明' },
      limit: { type: 'number', description: '可选：仅显式传参时截断章数（默认不截断，取用户选定/待复测/全书）' },
      focus: { type: 'string', description: '可选：冷读打分的「本次打分说明」（作者指定视角/关注点；不引入上下文）' },
    },
    required: ['op'],
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args = {}) {
    const s = store
    const root = s.defaultRoot()
    await s.ensureRoot(root)
    const project = await resolveProject(s, root, args.projectId)
    const projectId = String(project.id)
    const op = String(args.op ?? '')
    const projectRow = { id: projectId, name: project.name ?? project.title ?? '' }
    if (op === 'measured') {
      const ticket = requireTicket(args.dispatchId, { projectId })
      if (ticket.role !== 'cold-reader') throw new Error('冷读必须由冷读审稿人子 agent 提交：请 novel_desk_dispatch(role="cold-reader") 拿 dispatchId。')
      // 极简口径：一次冷读 = 一个总分 + 一段结论；统一落成「1 条冷读意见」，不进待处理
      if (args.score !== undefined || Array.isArray(args.notes)) {
        const score = Number(args.score)
        if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error('score 必须是 0–100')
        const notes = (Array.isArray(args.notes) ? args.notes : []).map((row) => {
          const chapter = Number(row?.chapter) || 0
          const raw = String(row?.comment ?? row?.text ?? row?.note ?? '').trim()
          const explicitKind = String(row?.kind ?? row?.type ?? '').toLowerCase()
          const isHighlight = explicitKind === 'highlight' || /^高光[:：]/.test(raw)
          const comment = raw.replace(/^高光[:：]\s*/, '').trim()
          const quote = String(row?.quote ?? '').trim() || (raw.match(/[“"「]([^”"」]{2,80})[”"」]/)?.[1] ?? '')
          return { chapter, comment, kind: isHighlight ? 'highlight' : 'weakness', quote, after: String(row?.after ?? '') }
        }).filter((row) => row.chapter > 0 && row.comment).slice(0, 30)
        const textLines = notes.length ? notes.map((row) => `第${Number(row.chapter) || 0}章：${String(row.comment).slice(0, 200)}`) : []
        const dir = await s.projectDir(root, projectId)
        const summary = await bookdb.addColdReadSummary({
          dir,
          score,
          verdict: String(args.verdict ?? ''),
          text: [String(args.detail ?? '').trim(), ...textLines].filter(Boolean).join('\n'),
          chapters: [...new Set(notes.map((row) => Number(row.chapter)).filter((n) => n > 0))],
          highlights: notes.filter((row) => row.kind === 'highlight'),
          notes,
        })
        requireTicket(args.dispatchId, { projectId, consume: true })
        return `已记录冷读：${score}/100${args.verdict ? `｜${String(args.verdict)}` : ''}。统一意见 id=${summary.id}；逐章意见 ${summary.notes ?? 0} 条；高光 ${summary.highlights} 条已入高光账本。`
      }
    }
    if (op === 'design' || op === 'measured') {
      const flatKeys = ['type', 'hook', 'tension', 'payoff', 'cliff', 'question', 'designScore', 'status', 'score', 'breakdown', 'dropPoints', 'points', 'verdict', 'weakest', 'detail']
      let items = Array.isArray(args.items) ? args.items.filter((item) => item && typeof item === 'object') : []
      // 推荐写法：一次一章，chapter + 扁平字段（比多对象嵌套 JSON 更不容易解析失败）
      if (items.length === 0 && chapterNumber(args.chapter)) {
        const flat = { chapter: chapterNumber(args.chapter) }
        for (const key of flatKeys) if (args[key] !== undefined) flat[key] = args[key]
        items = [flat]
      }
      if (items.length === 0) throw new Error('items 不能为空；也可以直接用 chapter + score/breakdown（measured）或 chapter + type/hook/tension/payoff/cliff/designScore（design）单章提交')
      const merged = []
      for (const item of items) {
        const chapter = chapterNumber(item?.chapter ?? args.chapter)
        if (!chapter) throw new Error('每条 items 都需要 chapter')
        let patch = omit(item, ['chapter'])
        if (op === 'design') {
          patch = { ...patch, status: patch.status ?? 'planned' }
          const missing = []
          if (!prompts.ATTENTION_TYPES.includes(String(patch.type ?? ''))) missing.push('type（event/emotion/language/mystery/relationship）')
          for (const key of ['hook', 'tension', 'payoff', 'cliff']) {
            if (!String(patch[key] ?? '').trim()) missing.push(key)
          }
          const designScore = Number(patch.designScore)
          if (!Number.isFinite(designScore) || designScore < 0 || designScore > 100) missing.push('designScore（0–100）')
          if (missing.length > 0) {
            throw new Error(`注意力设计未通过（ATTENTION IS ALL YOU NEED）：第${chapter}章缺 ${missing.join('、')}；四拍文字 + designScore 写全后再提交。`)
          }
        } else {
          patch = omit(patch, ['measuredScore'])
          const breakdown = patch.breakdown && typeof patch.breakdown === 'object' ? patch.breakdown : null
          if (breakdown) {
            const sum = ['hook', 'tension', 'payoff', 'cliff'].reduce((total, key) => total + (Number(breakdown[key]) || 0), 0)
            if (patch.score === undefined || patch.score === null) patch.score = sum
            else if (Math.abs(Number(patch.score) - sum) > 2) throw new Error(`第${chapter}章 score=${patch.score} 与 breakdown 合计 ${sum} 不一致（差值需 ≤2）`)
          }
        }
        merged.push(await s.mergeAttention(root, projectId, chapter, patch))
        // 冷读的地址评价 → 自动生成意见（weakness 带改法；highlight 等作者决定是否入高光）
        const points = Array.isArray(patch.points) ? patch.points.filter((point) => point && String(point.comment ?? '').trim()) : []
        if (points.length > 20) throw new Error('冷读 points 最多 20 条：只写值得写下来的。')
        for (const point of points) {
          if (String(point.comment ?? '').length > 120) throw new Error('point.comment 超过 120 字：写清为什么即可（目标 ≤80 字）。')
          if (String(point.after ?? '').length > 4000) throw new Error('point.after 超过 4000 字：只给指到的那一段成文。')
        }
        if (op === 'measured' && points.length) {
          try {
            const dir = await s.projectDir(root, projectId)
            const doc = await s.readChapter(root, projectId, chapter)
            const index = buildIndex(doc.text, chapter)
            const withBody = { ...index, body: splitTitle(doc.text).body }
            await bookdb.addColdReadOpinions({ dir, chapter, points, index: withBody })
          } catch {
            /* 意见生成失败不影响分数落库 */
          }
        }
      }
      if (op === 'measured') requireTicket(args.dispatchId, { projectId, consume: true })
      return `已合并 ${merged.length} 章注意力（op=${op}）。`
    }
    const chapterRows = listOf(await s.listChapters(root, projectId))
    const attentionRows = listOf(await s.getAttention(root, projectId).catch(() => []))
    const attentionMap = new Map(attentionRows.map((row) => [Number(row?.chapter), row]))
    const requested = Array.isArray(args.chapters) && args.chapters.length > 0
      ? args.chapters.map(Number).filter((number) => number > 0)
      : (chapterNumber(args.chapter) ? [chapterNumber(args.chapter)] : [])
    // 范围只认用户显式选择：requested 优先；recheck 先取待复测章；否则全部章节（绝不默认 3 章）
    let picked = chapterRows
    if (requested.length > 0) {
      picked = chapterRows.filter((row) => requested.includes(Number(row?.chapter ?? row?.id)))
    } else if (op === 'recheck') {
      const pending = chapterRows.filter((row) => attentionMap.get(Number(row?.chapter ?? row?.id))?.recheckPending === true)
      if (pending.length > 0) picked = pending
    }
    const explicitLimit = Number(args.limit) > 0 ? Math.max(1, Math.floor(Number(args.limit))) : 0
    if (explicitLimit > 0) picked = picked.slice(0, explicitLimit)
    // rows 一定带 path：优先章节自己的路径，其次 project.workspacePath + chapters/NNNN.txt
    const fullProject = await s.getProject(root, projectId).catch(() => null)
    const projectData = fullProject?.project && typeof fullProject.project === 'object' ? fullProject.project : (fullProject ?? project)
    const workspacePath = String(projectData?.workspacePath ?? projectData?.rootPath ?? '')
    const rows = picked.map((row) => {
      const chapter = Number(row?.chapter ?? row?.id ?? 0)
      const record = attentionMap.get(chapter) ?? null
      const fallbackPath = workspacePath && Number.isInteger(chapter) && chapter > 0
        ? `${workspacePath.replace(/[\\/]+$/, '')}/chapters/${String(chapter).padStart(4, '0')}.txt`
        : ''
      return {
        chapter,
        title: row?.title ?? '',
        words: Number(row?.words ?? 0) || 0,
        path: String(row?.path ?? row?.file ?? record?.path ?? '') || fallbackPath,
        summary: row?.summary ?? '',
        attention: record,
      }
    })
    const promptProject = { ...projectRow, workspacePath: workspacePath || projectData?.workspacePath || '' }
    const prompt = op === 'recheck'
      ? prompts.attentionRecheckWorkorder({ project: promptProject, chapters: rows, focus: args.focus })
      : prompts.attentionDesignWorkorder({ project: promptProject, chapters: rows, attention: attentionRows })
    return prompt
  },
}

const writeTool = {
  name: 'novel_desk_write',
  description: '用闸门写入章正文（规范化/保真/残留/去AI味），失败不落盘并返回失败项；纯文本、禁 Markdown、场景分隔 ※；首行必须是回目标题（第X回 …），标题属于正文。',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      chapter: { type: 'number' },
      text: { type: 'string', description: '整章正文（纯文本）' },
      source: { type: 'string', description: '来源，默认 run' },
      meta: { type: 'object', description: '章节 meta 增量（title/status/summary/characters 等）' },
    },
    required: ['chapter', 'text'],
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args = {}) {
    const s = store
    const root = s.defaultRoot()
    await s.ensureRoot(root)
    const project = await resolveProject(s, root, args.projectId)
    const projectId = String(project.id)
    const chapter = Number(args.chapter)
    const result = await writeChapterWithGates(s, {
      root,
      projectId,
      chapter,
      text: String(args.text ?? ''),
      source: String(args.source ?? 'run'),
      meta: args.meta && typeof args.meta === 'object' ? args.meta : undefined,
    })
    if (!result.ok) {
      throw new Error(`闸门未通过，正文未落盘（proposalStatus=needs-fix）：\n${formatFailures(result.failures)}\n${formatGateLine(result.gates)}`)
    }
    const attentionRows = listOf(await s.getAttention(root, projectId).catch(() => []))
    const record = attentionRows.find((row) => Number(row?.chapter) === chapter) ?? null
    const designed = Boolean(record) && String(record.type ?? '').trim() !== '' && String(record.hook ?? '').trim() !== '' && Number.isFinite(Number(record.designScore))
    const hint = designed
      ? ''
      : `\n⚠ 注意力提醒：第${chapter}章还没有注意力记录（ATTENTION IS ALL YOU NEED）。动笔前先写一句本章靠什么抓人（开头怎么抓、章末留什么未决问题）；冷读会独立打分。`
    return `已写入第${chapter}章。${formatGateLine(result.gates)}${hint}`
  },
}

const runTool = {
  name: 'novel_desk_run',
  description: '全文动作 run：start=开始（kind: continue 从头写新章 / expand 扩写 / rewrite 改写+variant style|logic|structure；scope: book|range；单章改写请走问题页整章改写稿）/ status=进度 / advance / pause / resume / finish / abort。continue 写新章并落盘；rewrite/expand 需作者两次确认（confirmed=true）后直接覆盖正文，覆盖前自动备份、可从章节历史版本找回。',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      op: { type: 'string', enum: ['start', 'status', 'advance', 'pause', 'resume', 'finish', 'abort'] },
      kind: { type: 'string', enum: ['continue', 'expand', 'rewrite', 'rephrase'], description: 'op=start；rephrase 等价于 rewrite+style（兼容旧值）' },
      variant: { type: 'string', enum: ['style', 'logic', 'structure'], description: 'kind=rewrite 时细分：文风 / 逻辑与事实 / 结构与节奏' },
      scope: { type: 'string', enum: ['book', 'chapter', 'range'], description: 'op=start；continue 一般用 book 或 range' },
      chapter: { type: 'number', description: 'op=start & scope=chapter|range 的起始章' },
      endChapter: { type: 'number', description: 'op=start & scope=range 的结束章（包含）' },
      confirmed: { type: 'boolean', description: 'rewrite/expand 必须传 true：作者已在工作台两次确认会直接覆盖正文（覆盖前自动备份，可从章节历史版本找回）。' },
      budget: { type: 'object', description: '{maxTokens,maxCostCNY}' },
      stageId: { type: 'string', description: 'op=advance 目标阶段' },
      note: { type: 'string', description: '进度说明' },
    },
    required: ['op'],
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args = {}) {
    const s = store
    const root = s.defaultRoot()
    await s.ensureRoot(root)
    const project = await resolveProject(s, root, args.projectId)
    const projectId = String(project.id)
    const op = String(args.op ?? '')
    const current = await s.getRun(root, projectId).catch(() => null)
    const base = current?.run && typeof current.run === 'object' ? current.run : (current ?? {})
    if (op === 'status') return formatRun(current)
    let patch
    if (op === 'start') {
      const rawKind = String(args.kind ?? base.kind ?? 'rewrite').trim()
      if (!RUN_KINDS.includes(rawKind)) {
        throw new Error(`未知动作类型：${rawKind || '(空)'}（可用：continue / expand / rewrite / rephrase）`)
      }
      const rawVariant = String(args.variant ?? base.variant ?? '').trim()
      if (rawVariant && rawKind === 'rewrite' && !RUN_VARIANTS.includes(rawVariant)) {
        throw new Error(`改写侧重不支持：${rawVariant}（可用：style / logic / structure）`)
      }
      const normalized = normalizeRunKind(rawKind, rawVariant)
      const scope = ['book', 'chapter', 'range'].includes(String(args.scope ?? '')) ? String(args.scope) : 'book'
      const overwriting = normalized.kind === 'rewrite' || normalized.kind === 'expand'
      if (overwriting && args.confirmed !== true) {
        throw new Error('改写/扩写会直接覆盖正文，需要作者两次确认（工作台创建时勾选 + 开工确认）；确认后调用请传 confirmed=true。')
      }
      if (normalized.kind === 'rewrite' && scope === 'chapter') {
        throw new Error('单章重写请回正文页「重写本章」走整章改写稿（可采纳/继续改）；run 只用于整书/区间改写。')
      }
      const chapter = args.chapter ?? base.chapter ?? (scope === 'chapter' || scope === 'range' ? 1 : null)
      const endChapter = args.endChapter ?? base.endChapter ?? (scope === 'range' ? chapter : null)
      const stages = runStageDefaults(normalized.kind, normalized.variant).map((stage, index) => ({
        ...stage,
        status: index === 0 ? 'running' : 'pending',
      }))
      patch = {
        ...omit(base, []),
        kind: normalized.kind,
        variant: normalized.variant,
        scope,
        chapter: chapter ? Number(chapter) : null,
        endChapter: endChapter ? Number(endChapter) : null,
        budget: args.budget && typeof args.budget === 'object' ? args.budget : (base.budget ?? {}),
        status: 'running',
        currentStage: stages[0]?.id ?? 'prepare',
        stages,
        startedAt: nowIso(),
        updatedAt: nowIso(),
        note: String(args.note ?? ''),
      }
      delete patch.run
    } else if (op === 'advance') {
      const stageId = String(args.stageId ?? '')
      const stages = listOf(base.stages).map((stage) => (stage?.id === stageId ? { ...stage, status: 'done' } : stage))
      patch = { ...base, stages, currentStage: stageId || base.currentStage, updatedAt: nowIso(), note: String(args.note ?? base.note ?? '') }
    } else if (op === 'pause') {
      patch = { ...base, status: 'paused', updatedAt: nowIso(), note: String(args.note ?? base.note ?? '') }
    } else if (op === 'resume') {
      patch = { ...base, status: 'running', updatedAt: nowIso(), note: String(args.note ?? base.note ?? '') }
    } else if (op === 'finish') {
      patch = { ...base, status: 'done', currentStage: 'done', updatedAt: nowIso(), finishedAt: nowIso(), note: String(args.note ?? base.note ?? '') }
    } else if (op === 'abort') {
      patch = { ...base, status: 'aborted', updatedAt: nowIso(), note: String(args.note ?? base.note ?? '') }
    } else {
      throw new Error(`未知 op：${op || '(空)'}`)
    }
    delete patch.run
    const saved = await s.saveRun(root, projectId, patch)
    const text = formatRun(saved ?? patch)
    if (op !== 'start') return text
    const attentionRows = listOf(await s.getAttention(root, projectId).catch(() => []))
    const designed = attentionRows.filter((row) => String(row?.type ?? '').trim() !== '' && String(row?.hook ?? '').trim() !== '' && Number.isFinite(Number(row?.designScore)))
    const reminder = designed.length === 0
      ? '⚠ 全局提醒（ATTENTION IS ALL YOU NEED）：本书还没有注意力记录。本 run 每章动笔前先写一句抓人目标；不需要四拍，注意力由冷读独立打分。'
      : `注意力提醒（ATTENTION IS ALL YOU NEED）：已有 ${designed.length} 章设计。开工前先给本次范围补齐注意力设计（novel_desk_attention op="design"），再写/改正文。`
    return `${text}\n\n${reminder}`
  },
}

/** 六个 Agent 工具（api.test.js 核对数量与名字）。 */

// ⑦ 地图：让 AI 自己把「区域 / 路线 / 画风」方案存进世界，不用人再复制粘贴
const mapTool = {
  name: 'novel_desk_map',
  description: '世界地图方案：plan=看现有地形候选与画风；save=把 AI 方案的区域/路线/坐标/绘制提示词存进 world（mapStyle.aiPlan），并直接把【坐标】段写进地点的 x/y。',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      op: { type: 'string', enum: ['plan', 'save'] },
      aiPlan: { type: 'string', description: 'op=save：完整方案文本，必须包含【区域】【路线】【坐标】【绘制提示词】四段' },
      palette: { type: 'string', description: 'op=save：画风 id 或名称（ink 水墨绢本 / ochre 赭石古卷 / jade 青绿山河 / sepia 羊皮纸 / steel 冷灰史诗 / wine 暗红纪事）' },
      seed: { type: 'number', description: 'op=save：底图种子；想换一版就换个正整数' },
    },
    required: ['op'],
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args = {}) {
    const s = store
    const root = s.defaultRoot()
    await s.ensureRoot(root)
    const project = await resolveProject(s, root, args.projectId)
    const projectId = String(project.id)
    const op = String(args.op ?? '')
    const ledger = await s.getLedger(root, projectId)
    const world = ledger.world && typeof ledger.world === 'object' ? ledger.world : {}
    const style = world.mapStyle && typeof world.mapStyle === 'object' ? world.mapStyle : null
    if (op === 'plan') {
      const locations = Array.isArray(ledger.locations) ? ledger.locations : []
      const config = terrainConfig(world)
      const withCoords = locations.filter((row) => Boolean(coordOfRow(row))).length
      const waterCount = locations.filter((row) => isWaterLocation(row, config)).length
      const ridgeCount = locations.filter((row) => isRidgeLocation(row, config)).length
      const aiPlan = style?.aiPlan?.text ? String(style.aiPlan.text) : ''
      return [
        `# 世界地图 · ${String(world.name || project.title || project.name || '未命名')}`,
        `- 地点：${withCoords}/${locations.length} 个有坐标`,
        `- 地形候选：水点 ${waterCount} 个、山点 ${ridgeCount} 个（作者可在 world.json 的 terrain.waterTypes / ridgeTypes 补词表）`,
        `- 可选画风：${MAP_PALETTES.map((row) => `${row.id}=${row.name}`).join(' / ')}`,
        style ? `- 现有底图：${String(style.paletteName || style.palette || '?')}｜种子 ${Number(style.seed) || 0}｜水系 ${Array.isArray(style.rivers) ? style.rivers.length : 0} 条｜山形 ${Array.isArray(style.ridges) ? style.ridges.length : 0} 个` : '- 现有底图：无',
        aiPlan ? `- 已存 AI 方案：${aiPlan.length} 字（save 会覆盖）` : '- 已存 AI 方案：无',
        '',
        '下一步：把「区域 / 路线 / 绘制提示词」写成文本，调 op=save 存进来（可选 palette / seed 顺带重画底图）。',
      ].join('\n')
    }
    if (op !== 'save') throw invalid(`不认识的 op：${op}（只能用 plan / save）`)
    const text = String(args.aiPlan ?? '').trim()
    if (!text) throw invalid('op=save 需要 aiPlan：把写好的「区域 / 路线 / 绘制提示词」整段放进来')
    const savedAt = new Date().toISOString()
    const seedRaw = Number(args.seed)
    const seed = Number.isFinite(seedRaw) && seedRaw > 0 ? Math.floor(seedRaw) : (Number(style?.seed) || Math.floor(Math.random() * 9000) + 1)
    const palette = String(args.palette ?? '').trim()
    const baseStyle = palette || args.seed ? generateTerrain(ledger, seed, { palette: palette || undefined }) : (style || {})
    const nextStyle = { ...baseStyle, aiPlan: { text, savedAt, source: 'ai' } }
    const applied = await applyMapPlan({ store: s, root, projectId, text, savedAt, baseMapStyle: nextStyle })
    const redraw = palette ? `，底图已换成「${nextStyle.paletteName || nextStyle.palette}」` : ''
    const coordLine = applied.total
      ? `坐标已入库：更新 ${applied.updated.length} 个、新建 ${applied.created.length} 个${applied.missing.length ? `；未匹配：${applied.missing.slice(0, 5).join('、')}` : ''}`
      : '方案里没有【坐标】段：地点坐标未更新（下次请按格式给每个地点 x/y）'
    return `已把地图方案存进《${project.title || project.name || projectId}》（${text.length} 字）${redraw}。${coordLine}。用户打开 账本 → 世界地图 会直接看到地点。`
  },
}

// ⑧ 冷读统一意见的按章拆分（子意见进正常 AI 意见流程；不需要再读全文）
const coldSplitTool = {
  name: 'novel_desk_cold_split',
  description: '把一条冷读统一意见拆成按章子意见（作者在意见页点「按章拆分」后由你执行）：你只需按已知内容分章，不必重读全文。',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      dispatchId: { type: 'string', description: '派单票据（role=cold-reader 或 continuity 皆可）' },
      parentId: { type: 'string', description: '冷读统一意见 id' },
      items: {
        type: 'array',
        description: '按章拆出的子意见',
        items: {
          type: 'object',
          properties: {
            chapter: { type: 'number' },
            text: { type: 'string', description: '这一章要改什么（≤200 字）' },
            after: { type: 'string', description: '可选：能直接替换的整段成文' },
          },
          required: ['chapter', 'text'],
          additionalProperties: false,
        },
      },
    },
    required: ['dispatchId', 'parentId', 'items'],
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args = {}) {
    const s = store
    const root = s.defaultRoot()
    await s.ensureRoot(root)
    const project = await resolveProject(s, root, args.projectId)
    const ticket = requireTicket(args.dispatchId, { projectId: project.id })
    if (!['cold-reader', 'continuity'].includes(ticket.role)) throw new Error('拆分派单角色需为 cold-reader 或 continuity')
    const items = Array.isArray(args.items) ? args.items.filter((row) => row && Number(row.chapter) > 0 && String(row.text ?? '').trim()) : []
    if (!items.length) throw new Error('items 不能为空')
    const dir = await s.projectDir(root, project.id)
    const result = await bookdb.addColdReadChildren({ dir, parentId: String(args.parentId), items })
    requireTicket(args.dispatchId, { projectId: project.id, consume: true })
    return `已拆出 ${result.added} 条按章子意见（进了意见页待处理，可逐条采纳；不会自动改正文）。`
  },
}

// ── 0.7.1 工具：审稿结果 / 修改稿提交 ─────────────────────────

const NL = String.fromCharCode(10)

async function problemDraftInput(s, root, projectId, problemId, draft, addr) {
  const kind = String(draft?.kind ?? 'paragraph')
  if (!problems.DRAFT_KINDS.includes(kind)) throw new Error(`修改稿类型不对：${kind}（只能是 paragraph / chapter）`)
  const text = String(draft?.text ?? '').trim()
  if (!text) throw new Error('修改稿 text 不能为空')
  const fallbackChapter = Number(addr.chapter) || Number(addr.chapters?.[0]) || 0
  if (kind === 'chapter') {
    const chapter = Number(draft?.chapter) || fallbackChapter
    if (!chapter) throw new Error('整章改写稿缺少 chapter')
    if (text.length < 50) throw new Error('整章改写稿太短：整章替换文本不能少于 50 字')
    if (text.length > 200000) throw new Error('整章改写稿过长')
    return { problemId, kind, chapter, para: null, paraHash: '', text }
  }
  if (text.split(NL).some((line) => line.trim() === '')) throw new Error('段级修改稿不能包含空行分段：一段换一段；要改整章请用 kind="chapter"')
  if (text.length > 4000) throw new Error('段级修改稿超过 4000 字：只替换指到的那一段')
  const chapter = Number(draft?.chapter) || fallbackChapter
  if (!chapter) throw new Error('段级修改稿缺少章号（跨章/全局问题每份段级稿都要写 chapter）')
  const doc = await s.readChapter(root, projectId, chapter)
  const hint = String(doc.meta?.title ?? '')
  const index = buildIndex(doc.text, chapter, hint)
  const body = splitTitle(doc.text, hint).body
  let para = draft?.para === undefined || draft?.para === null || draft?.para === '' ? null : Number(draft.para)
  if (para === null && String(draft?.quote ?? '').trim()) {
    const at = findParagraphByQuote({ ...index, body }, String(draft.quote).trim())
    if (at >= 0) para = at
  }
  if (para === null && addr.scope === 'chapter' && chapter === Number(addr.chapter)) para = addr.para
  if (!Number.isInteger(para) || para < 0) throw new Error(`段级修改稿缺少段号（第 ${chapter} 章）：请给 para，或给该段逐字 quote`)
  if (!index.paras[para]) throw new Error(`第 ${chapter} 章没有第 ${para} 段（para 从 0 开始，标题不算段）`)
  return { problemId, kind, chapter, para, paraHash: index.paras[para]?.hash || '', text }
}

async function submitProblemsTool(args) {
  const s = store
  const root = s.defaultRoot()
  await s.ensureRoot(root)
  const project = await resolveProject(s, root, args.projectId)
  const projectId = String(project.id)
  const dir = await s.projectDir(root, projectId)
  const { db } = await bookdb.openBook(dir)
  const rows = Array.isArray(args.problems) ? args.problems : []
  if (rows.length > 60) throw new Error('一次最多 60 条问题：分多次提交（先提 blocker/最严重的）')
  const reviewId = String(args.reviewId ?? '').trim()
  let review = reviewId ? problems.getReview(db, reviewId) : null
  if (reviewId && !review) throw new Error(`审稿记录不存在：${reviewId}；请让作者从工作台重新发起审稿`)
  let reviewCreated = false
  if (!review && rows.length > 0) {
    // AI 漏带 reviewId 时的兜底：先建审稿记录，问题都挂到它下面
    review = problems.createReview(db, { kind: 'reading', scope: 'chapter', chapters: [], status: 'prepared' })
    reviewCreated = true
  }
  let added = 0
  let draftCount = 0
  let noDraft = 0
  const scopeSet = new Set()
  const chapterSet = new Set()
  for (const raw of rows) {
    const type = String(raw?.type ?? 'other')
    if (!problems.PROBLEM_TYPES.includes(type)) throw new Error(`问题类型不对：${type}（只能是 ai-style / logic-fact / style / other）`)
    const severity = String(raw?.severity ?? 'major')
    if (!problems.PROBLEM_SEVERITIES.includes(severity)) throw new Error(`严重度不对：${severity}（critical/major/minor/note）`)
    const text = String(raw?.text ?? '').trim()
    if (!text) throw new Error('每条问题都必须有 text（一句话说清读者卡在哪）')
    if (text.length > 400) throw new Error('问题说明超过 400 字：写清问题即可')
    const addr = await resolveProblemAddress(s, root, projectId, raw)
    scopeSet.add(addr.scope)
    if (addr.chapter) chapterSet.add(addr.chapter)
    const problem = problems.addProblem(db, {
      reviewId: review ? review.id : '',
      type, scope: addr.scope, chapters: addr.chapters, chapter: addr.chapter,
      para: addr.para, paraHash: addr.paraHash, quote: addr.quote,
      severity, text, source: 'ai',
    })
    added += 1
    const drafts = Array.isArray(raw?.drafts) ? raw.drafts : (raw?.draft ? [raw.draft] : [])
    if (drafts.length > 10) throw new Error(`问题 ${problem.id} 的修改稿超过 10 份`)
    if (drafts.length === 0) noDraft += 1
    for (const draft of drafts) {
      const row = await problemDraftInput(s, root, projectId, problem.id, draft, addr)
      problems.addDraft(db, row)
      draftCount += 1
    }
  }
  const verdict = String(args.verdict ?? '').trim()
  const scores = Array.isArray(args.scores) ? args.scores : []
  let scored = 0
  for (const row of scores.slice(0, 200)) {
    const chapter = Number(row?.chapter)
    const score = Number(row?.score)
    if (!Number.isInteger(chapter) || chapter <= 0) continue
    if (!Number.isFinite(score) || score < 0 || score > 100) continue
    try {
      await s.mergeAttention(root, projectId, chapter, { score, verdict })
      scored += 1
    } catch { /* 评分落库失败不影响问题 */ }
  }
  const finalScope = scopeSet.has('global') ? 'global' : scopeSet.has('cross') ? 'cross' : 'chapter'
  if (review && reviewCreated) {
    problems.createReview(db, {
      id: review.id,
      kind: 'reading',
      scope: finalScope,
      chapters: [...chapterSet],
      verdict,
      scores,
      status: 'submitted',
    })
  } else if (review) {
    problems.updateReview(db, review.id, { status: 'submitted', verdict, scores })
  }
  const highlights = Array.isArray(args.highlights) ? args.highlights : []
  let highlightAdded = 0
  for (const item of highlights.slice(0, 30)) {
    try { if (await addHighlightRow(db, item)) highlightAdded += 1 } catch { /* 高光失败不影响问题 */ }
  }
  return `已记录审稿：问题 ${added} 条（修改稿 ${draftCount} 份${noDraft ? `，${noDraft} 条暂无稿` : ''}）；高光 ${highlightAdded} 条已进账本；注意力评分 ${scored} 章。作者在「问题」页采纳或继续改。`
}

async function reviseProblemsTool(args) {
  const s = store
  const root = s.defaultRoot()
  await s.ensureRoot(root)
  const project = await resolveProject(s, root, args.projectId)
  const projectId = String(project.id)
  const dir = await s.projectDir(root, projectId)
  const { db } = await bookdb.openBook(dir)
  const revisions = Array.isArray(args.revisions) ? args.revisions : []
  if (revisions.length === 0) throw new Error('revisions 不能为空')
  if (revisions.length > 40) throw new Error('一次最多回写 40 条问题的修改稿')
  let updated = 0
  for (const row of revisions) {
    const problemId = String(row?.problemId ?? '').trim()
    if (!problemId) throw new Error('revision 缺少 problemId')
    const problem = problems.getProblem(db, problemId)
    if (!problem) throw new Error(`问题不存在：${problemId}`)
    const drafts = Array.isArray(row?.drafts) ? row.drafts : (row?.draft ? [row.draft] : [])
    if (drafts.length === 0) throw new Error(`问题 ${problemId} 没有新修改稿`)
    const addr = {
      scope: problem.scope,
      chapters: problem.chapters,
      chapter: problem.chapter,
      para: problem.para,
      paraHash: problem.paraHash,
      quote: problem.quote,
    }
    problems.supersedePendingDrafts(db, problemId)
    for (const draft of drafts) {
      problems.addDraft(db, await problemDraftInput(s, root, projectId, problemId, draft, addr))
    }
    problems.patchProblem(db, problemId, { status: 'open' })
    updated += 1
  }
  return `已为 ${updated} 条问题写入新修改稿（旧稿作废），作者可在「问题」页采纳或继续改。`
}

const problemsTool = {
  name: 'novel_desk_problems',
  description: '0.7.1 审稿/改稿提交：op=submit 提交一次审稿（评分 + 四类问题 + 高光）；op=revise 回写继续改的新修改稿。一次审稿只由一个 AI 读工作台给定的 TXT 全文后提交：不要派子 agent、不要分章转交、不要在对话里改正文。问题类型 ai-style/logic-fact/style/other；每条尽量带修改稿（paragraph=一段换一段；chapter=整章替换；跨章问题可按章给多份稿：段级稿每份带 chapter+para/quote，严重到修不了才整章稿）。**任何一档读到的问题都要提交（按性质给 type），不要因为不是本次档位目标就丢掉。** 高光只进账本，不是问题。',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      reviewId: { type: 'string', description: '工作台发审稿工作单时给的 reviewId；提交时必须原样带回' },
      op: { type: 'string', enum: ['submit', 'revise'], description: 'submit=交审稿结果；revise=继续改回写新稿' },
      verdict: { type: 'string', description: 'op=submit：全书/本次范围的结论（≤80 字）' },
      scores: {
        type: 'array',
        description: 'op=submit：注意力评分，每章一条',
        items: { type: 'object', properties: { chapter: { type: 'number' }, score: { type: 'number' } }, required: ['chapter', 'score'] },
      },
      problems: {
        type: 'array',
        description: 'op=submit：问题清单（四类分开、不合并）。每条带 type/scope/severity/text；能定位就带 chapter/para/quote；能改就给 drafts。',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            type: { type: 'string', enum: ['ai-style', 'logic-fact', 'style', 'other'] },
            scope: { type: 'string', enum: ['chapter', 'cross', 'global'] },
            chapters: { type: 'array', items: { type: 'number' } },
            chapter: { type: 'number' },
            para: { type: 'number', description: '正文段号，从 0 开始（标题不算段）' },
            quote: { type: 'string', description: '该段逐字原文（用于核对地址）' },
            severity: { type: 'string', enum: ['critical', 'major', 'minor', 'note'] },
            text: { type: 'string', description: '问题说明（≤400 字）' },
            drafts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  kind: { type: 'string', enum: ['paragraph', 'chapter'] },
                  chapter: { type: 'number' },
                  para: { type: 'number' },
                  quote: { type: 'string', description: '段级稿在该章的逐字原文（跨章/全局问题用来定位段号）' },
                  text: { type: 'string', description: '整段替换成文 / 整章替换成文' },
                },
                required: ['kind', 'text'],
              },
            },
          },
          required: ['type', 'scope', 'severity', 'text'],
        },
      },
      highlights: {
        type: 'array',
        description: 'op=submit：高光（直接进账本，不是问题）',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            chapter: { type: 'number' },
            para: { type: 'number' },
            quote: { type: 'string' },
            comment: { type: 'string' },
          },
          required: ['chapter', 'comment'],
        },
      },
      revisions: {
        type: 'array',
        description: 'op=revise：逐条回写新修改稿',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            problemId: { type: 'string' },
            drafts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  kind: { type: 'string', enum: ['paragraph', 'chapter'] },
                  chapter: { type: 'number' },
                  para: { type: 'number' },
                  quote: { type: 'string', description: '段级稿在该章的逐字原文（用来定位段号）' },
                  text: { type: 'string' },
                },
                required: ['kind', 'text'],
              },
            },
          },
          required: ['problemId', 'drafts'],
        },
      },
    },
    required: ['op'],
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args = {}) {
    const op = String(args.op ?? 'submit')
    if (op === 'submit') return submitProblemsTool(args)
    if (op === 'revise') return reviseProblemsTool(args)
    throw new Error('op 只能是 submit 或 revise')
  },
}

export const TOOLS = [readTool, dispatchTool, proposeTool, writeTool, runTool, mapTool, problemsTool]

// ── 入口 ────────────────────────────────────────────────────

export function apply(ctx) {
  // 装配期任何异常都不能冒出去拖垮 DSH：记录到诊断，其余能力继续注册。
  try {
    mountRoute(ctx)
  } catch (error) {
    bootErrors.push({ at: 'mountRoute', message: error?.message || String(error) })
  }
  const tools = ctx?.tools
  if (tools && typeof tools.register === 'function') {
    for (const tool of TOOLS) {
      try {
        tools.register(tool)
      } catch (error) {
        bootErrors.push({ at: `register:${tool?.name || '?'}`, message: error?.message || String(error) })
      }
    }
  }
}
