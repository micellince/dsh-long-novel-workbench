/**
 * 问题单数据层：审阅（review）→ 问题（problem）→ 修改稿（draft）。
 *
 * 0.7.1 契约（docs/0.7.1-BUILD-CONTRACT.md §2）：
 *  - 纯 SQLite 访问，不碰文件系统；全部同步函数，入参 db 为 node:sqlite 的 DatabaseSync；
 *  - 三张表 problem_reviews / problems / problem_drafts 由 lib/db.js v7 建；
 *  - 问题永不物理删除；原文变了只标 outdated，不丢数据；
 *  - 一条问题可有多份待选修改稿：paragraph（一段换一段）/ chapter（整章替换）；
 *  - JSON 字段（chapters / scores / candidates）读写都做 parse/stringify 兜错，坏数据不炸；
 *  - 返回对象一律 camelCase，界面直接可用。
 */

import { randomUUID } from 'node:crypto'

export const PROBLEM_TYPES = ['ai-style', 'logic-fact', 'style', 'other']
export const PROBLEM_SCOPES = ['chapter', 'cross', 'global']
export const PROBLEM_SEVERITIES = ['critical', 'major', 'minor', 'note']
export const PROBLEM_STATUS = ['open', 'accepted', 'outdated', 'ignored']
export const DRAFT_KINDS = ['paragraph', 'chapter']
export const DRAFT_STATUS = ['pending', 'accepted', 'superseded']

/** 审阅类型：通读档 / 扫库 / 事实档 AI。表注释同源，不对外导出。 */
const REVIEW_KINDS = ['reading', 'facts-scan', 'facts-ai', 'author-brief']
/** 审阅状态：工作单已生成 / AI 已提交。 */
const REVIEW_STATUS = ['prepared', 'submitted']
/** 问题来源：AI 审阅 / 作者批注 / 自动扫库。 */
const PROBLEM_SOURCES = ['ai', 'author', 'scan']

function nowIso() {
  return new Date().toISOString()
}

/** 生成短 id：`${prefix}_${12位}`（与 opinions 一致，纯字符串，不依赖库）。 */
export function newId(prefix = 'id') {
  const head = String(prefix || 'id')
  return `${head}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/** JSON 字段兜错：空值/坏数据返回 fallback，绝不抛。 */
function parseJson(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string') return value
  try {
    const parsed = JSON.parse(value)
    return parsed == null ? fallback : parsed
  } catch {
    return fallback
  }
}

/** 写 JSON 字段：不能序列化时退回 fallback，不抛。 */
function toJson(value, fallback = null) {
  if (value == null) return fallback
  try {
    return JSON.stringify(value)
  } catch {
    return fallback
  }
}

/** 章号数组：接受数组 / JSON 字符串 / 单个值；只保留正整数，保序去重。 */
function normalizeChapters(value) {
  let list = value
  if (value == null) {
    list = []
  } else if (typeof value === 'string') {
    const parsed = parseJson(value, null)
    list = Array.isArray(parsed) ? parsed : value.split(/[\s,，、]+/)
  } else if (!Array.isArray(value)) {
    list = [value]
  }
  const out = []
  for (const item of list) {
    const n = Number(item)
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

/** 读库里的 chapters JSON 文本 → 正整数数组（坏数据返回 []）。 */
function readChapters(value) {
  return normalizeChapters(parseJson(value, []))
}

function numberOf(value, fallback = 0) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function numberOrNull(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function nullableText(value) {
  if (value == null) return null
  const text = String(value)
  return text === '' ? null : text
}

function hasKey(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

// ---------------------------------------------------------------------------
// 审阅（problem_reviews）
// ---------------------------------------------------------------------------

function rowToReview(row) {
  if (!row) return null
  return {
    id: row.id,
    kind: row.kind ?? 'reading',
    scope: row.scope ?? 'chapter',
    chapters: readChapters(row.chapters),
    manuscriptPath: row.manuscript_path ?? null,
    sessionId: row.session_id ?? null,
    verdict: row.verdict ?? null,
    scores: parseJson(row.scores, null),
    candidates: parseJson(row.candidates, null),
    status: row.status ?? 'prepared',
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

/**
 * 新建（或按 id 覆盖）一条审阅记录。
 * row: {kind, scope, chapters, sessionId?, verdict?, scores?, candidates?, manuscriptPath?}
 */
export function createReview(db, row = {}) {
  const id = String(row.id || newId('rv'))
  const now = nowIso()
  const kind = REVIEW_KINDS.includes(row.kind) ? row.kind : 'reading'
  const scope = PROBLEM_SCOPES.includes(row.scope) ? row.scope : 'chapter'
  const chapters = normalizeChapters(row.chapters)
  const status = REVIEW_STATUS.includes(row.status) ? row.status : 'prepared'
  db.prepare(`
    INSERT INTO problem_reviews (id, kind, scope, chapters, manuscript_path, session_id, verdict, scores, candidates, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind, scope = excluded.scope, chapters = excluded.chapters,
      manuscript_path = excluded.manuscript_path, session_id = excluded.session_id,
      verdict = excluded.verdict, scores = excluded.scores, candidates = excluded.candidates,
      status = excluded.status, updated_at = excluded.updated_at
  `).run(
    id, kind, scope, JSON.stringify(chapters), nullableText(row.manuscriptPath),
    nullableText(row.sessionId), nullableText(row.verdict), toJson(row.scores), toJson(row.candidates),
    status, row.createdAt ?? now, now,
  )
  return getReview(db, id)
}

/**
 * 局部更新审阅：白名单字段 session_id / verdict / scores / candidates / status / manuscript_path。
 * 兼容 camelCase 入参（sessionId / manuscriptPath）。找不到返回 null。
 */
export function updateReview(db, id, patch = {}) {
  const current = getReview(db, id)
  if (!current) return null
  const sets = []
  const args = []
  const put = (column, value) => {
    sets.push(`${column} = ?`)
    args.push(value)
  }
  if (hasKey(patch, 'sessionId') || hasKey(patch, 'session_id')) {
    put('session_id', nullableText(hasKey(patch, 'sessionId') ? patch.sessionId : patch.session_id))
  }
  if (hasKey(patch, 'verdict')) put('verdict', nullableText(patch.verdict))
  if (hasKey(patch, 'scores')) put('scores', toJson(patch.scores))
  if (hasKey(patch, 'candidates')) put('candidates', toJson(patch.candidates))
  if (hasKey(patch, 'status') && REVIEW_STATUS.includes(patch.status)) put('status', patch.status)
  if (hasKey(patch, 'manuscriptPath') || hasKey(patch, 'manuscript_path')) {
    put('manuscript_path', nullableText(hasKey(patch, 'manuscriptPath') ? patch.manuscriptPath : patch.manuscript_path))
  }
  if (!sets.length) return current
  put('updated_at', nowIso())
  db.prepare(`UPDATE problem_reviews SET ${sets.join(', ')} WHERE id = ?`).run(...args, String(id))
  return getReview(db, id)
}

export function getReview(db, id) {
  return rowToReview(db.prepare('SELECT * FROM problem_reviews WHERE id = ?').get(String(id)))
}

/** 最近审阅记录（界面展示最近 3–5 条），按创建时间倒序。 */
export function listReviews(db, { limit = 20 } = {}) {
  const n = Number(limit) > 0 ? Math.trunc(Number(limit)) : 20
  return db.prepare('SELECT * FROM problem_reviews ORDER BY created_at DESC LIMIT ?').all(n).map(rowToReview)
}

// ---------------------------------------------------------------------------
// 问题（problems）
// ---------------------------------------------------------------------------

function rowToProblem(row) {
  if (!row) return null
  return {
    id: row.id,
    reviewId: row.review_id ?? null,
    type: row.type ?? 'other',
    scope: row.scope ?? 'chapter',
    chapters: readChapters(row.chapters),
    chapter: Number(row.chapter) || 0,
    para: row.para == null ? null : Number(row.para),
    paraHash: row.para_hash ?? '',
    quote: row.quote ?? '',
    severity: row.severity ?? 'minor',
    text: row.text ?? '',
    source: row.source ?? 'ai',
    status: row.status ?? 'open',
    authorNote: row.author_note ?? '',
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

/**
 * 新增一条问题。
 * row: {reviewId?, type, scope, chapters, chapter?, para?, paraHash?, quote?, severity, text, source?}
 */
export function addProblem(db, row = {}) {
  const id = String(row.id || newId('pb'))
  const now = nowIso()
  const type = PROBLEM_TYPES.includes(row.type) ? row.type : 'other'
  const scope = PROBLEM_SCOPES.includes(row.scope) ? row.scope : 'chapter'
  const givenChapter = numberOrNull(row.chapter)
  let chapters = normalizeChapters(row.chapters)
  const chapter = givenChapter == null ? (chapters[0] ?? 0) : Math.trunc(givenChapter)
  // 章级问题只给 chapter 没给 chapters 时，自动补一个章号，保证地址完整
  if (!chapters.length && scope === 'chapter' && chapter > 0) chapters = [chapter]
  const severity = PROBLEM_SEVERITIES.includes(row.severity) ? row.severity : 'minor'
  const source = PROBLEM_SOURCES.includes(row.source) ? row.source : 'ai'
  const status = PROBLEM_STATUS.includes(row.status) ? row.status : 'open'
  db.prepare(`
    INSERT INTO problems (id, review_id, type, scope, chapters, chapter, para, para_hash, quote, severity, text, source, status, author_note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      review_id = excluded.review_id, type = excluded.type, scope = excluded.scope,
      chapters = excluded.chapters, chapter = excluded.chapter, para = excluded.para,
      para_hash = excluded.para_hash, quote = excluded.quote, severity = excluded.severity,
      text = excluded.text, source = excluded.source, status = excluded.status,
      author_note = excluded.author_note, updated_at = excluded.updated_at
  `).run(
    id, nullableText(row.reviewId), type, scope, JSON.stringify(chapters), chapter,
    numberOrNull(row.para), nullableText(row.paraHash), nullableText(row.quote), severity,
    String(row.text ?? ''), source, status, nullableText(row.authorNote), row.createdAt ?? now, now,
  )
  return getProblem(db, id)
}

/**
 * 问题列表：按 severity（critical→note）、chapter、created_at 排序。
 * chapter 过滤同时命中「主章 = N」与「chapters 含 N」（跨章问题也能被本章筛出）。
 */
export function listProblems(db, { status, type, scope, chapter, limit = 2000 } = {}) {
  const where = []
  const args = []
  const addIn = (column, value) => {
    const list = (Array.isArray(value) ? value : [value]).map(String)
    if (!list.length) return
    where.push(`${column} IN (${list.map(() => '?').join(',')})`)
    args.push(...list)
  }
  if (status) addIn('status', status)
  if (type) addIn('type', type)
  if (scope) addIn('scope', scope)
  const sql = `SELECT * FROM problems${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE severity
      WHEN 'critical' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END ASC,
      COALESCE(chapter, 0) ASC, created_at ASC`
  let rows = db.prepare(sql).all(...args)
  if (chapter != null && chapter !== '') {
    const n = Number(chapter)
    rows = rows.filter((row) => Number(row.chapter) === n || readChapters(row.chapters).includes(n))
  }
  const max = Number(limit) > 0 ? Math.trunc(Number(limit)) : 2000
  return rows.slice(0, max).map(rowToProblem)
}

export function getProblem(db, id) {
  return rowToProblem(db.prepare('SELECT * FROM problems WHERE id = ?').get(String(id)))
}

/**
 * 局部更新问题：白名单字段 status / author_note / para / para_hash / chapter / chapters。
 * 兼容 camelCase（authorNote / paraHash）。找不到返回 null。
 */
export function patchProblem(db, id, patch = {}) {
  const current = getProblem(db, id)
  if (!current) return null
  const sets = []
  const args = []
  const put = (column, value) => {
    sets.push(`${column} = ?`)
    args.push(value)
  }
  if (hasKey(patch, 'status') && PROBLEM_STATUS.includes(patch.status)) put('status', patch.status)
  if (hasKey(patch, 'authorNote')) put('author_note', nullableText(patch.authorNote))
  else if (hasKey(patch, 'author_note')) put('author_note', nullableText(patch.author_note))
  if (hasKey(patch, 'para')) put('para', numberOrNull(patch.para))
  if (hasKey(patch, 'paraHash')) put('para_hash', nullableText(patch.paraHash))
  else if (hasKey(patch, 'para_hash')) put('para_hash', nullableText(patch.para_hash))
  if (hasKey(patch, 'chapter')) {
    const n = numberOrNull(patch.chapter)
    put('chapter', n == null ? 0 : Math.trunc(n))
  }
  if (hasKey(patch, 'chapters')) put('chapters', JSON.stringify(normalizeChapters(patch.chapters)))
  if (hasKey(patch, 'reviewId')) put('review_id', nullableText(patch.reviewId))
  else if (hasKey(patch, 'review_id')) put('review_id', nullableText(patch.review_id))
  if (!sets.length) return current
  put('updated_at', nowIso())
  db.prepare(`UPDATE problems SET ${sets.join(', ')} WHERE id = ?`).run(...args, String(id))
  return getProblem(db, id)
}

// ---------------------------------------------------------------------------
// 修改稿（problem_drafts）
// ---------------------------------------------------------------------------

function rowToDraft(row) {
  if (!row) return null
  return {
    id: row.id,
    problemId: row.problem_id,
    kind: row.kind ?? 'paragraph',
    chapter: Number(row.chapter) || 0,
    para: row.para == null ? null : Number(row.para),
    paraHash: row.para_hash ?? '',
    text: row.text ?? '',
    status: row.status ?? 'pending',
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

/** 某条问题（或某状态）下的修改稿，按创建时间正序。 */
export function listDrafts(db, { problemId, status } = {}) {
  const where = []
  const args = []
  if (problemId != null && problemId !== '') {
    where.push('problem_id = ?')
    args.push(String(problemId))
  }
  if (status) {
    const list = (Array.isArray(status) ? status : [status]).map(String)
    where.push(`status IN (${list.map(() => '?').join(',')})`)
    args.push(...list)
  }
  const sql = `SELECT * FROM problem_drafts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC`
  return db.prepare(sql).all(...args).map(rowToDraft)
}

/** 新增一份修改稿：{problemId, kind, chapter, para?, paraHash?, text}。 */
export function addDraft(db, row = {}) {
  const id = String(row.id || newId('pd'))
  const now = nowIso()
  const kind = DRAFT_KINDS.includes(row.kind) ? row.kind : 'paragraph'
  const status = DRAFT_STATUS.includes(row.status) ? row.status : 'pending'
  const chapter = Math.trunc(numberOf(row.chapter, 0))
  db.prepare(`
    INSERT INTO problem_drafts (id, problem_id, kind, chapter, para, para_hash, text, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      problem_id = excluded.problem_id, kind = excluded.kind, chapter = excluded.chapter,
      para = excluded.para, para_hash = excluded.para_hash, text = excluded.text,
      status = excluded.status, updated_at = excluded.updated_at
  `).run(
    id, String(row.problemId ?? row.problem_id ?? ''), kind, chapter,
    numberOrNull(row.para), nullableText(row.paraHash ?? row.para_hash), String(row.text ?? ''), status, row.createdAt ?? now, now,
  )
  return getDraft(db, id)
}

export function getDraft(db, id) {
  return rowToDraft(db.prepare('SELECT * FROM problem_drafts WHERE id = ?').get(String(id)))
}

/** 局部更新修改稿：白名单只有 status（pending | accepted | superseded）。 */
export function patchDraft(db, id, patch = {}) {
  const current = getDraft(db, id)
  if (!current) return null
  if (!hasKey(patch, 'status') || !DRAFT_STATUS.includes(patch.status)) return current
  db.prepare('UPDATE problem_drafts SET status = ?, updated_at = ? WHERE id = ?')
    .run(patch.status, nowIso(), String(id))
  return getDraft(db, id)
}

/** 让某条问题的所有 pending 稿作废（新稿到达 / 整章替换后调用），不删除。 */
export function supersedePendingDrafts(db, problemId) {
  const result = db.prepare(
    "UPDATE problem_drafts SET status = 'superseded', updated_at = ? WHERE problem_id = ? AND status = 'pending'",
  ).run(nowIso(), String(problemId))
  return { updated: Number(result?.changes) || 0 }
}

// ---------------------------------------------------------------------------
// 统计与失效
// ---------------------------------------------------------------------------

/** 问题计数：按状态 + 按类型（类型键固定给全，未知类型也保留）。 */
export function problemCounts(db) {
  const rows = db.prepare('SELECT status, type, COUNT(*) AS n FROM problems GROUP BY status, type').all()
  const byType = {}
  for (const type of PROBLEM_TYPES) byType[type] = 0
  const counts = { open: 0, accepted: 0, outdated: 0, ignored: 0, total: 0, byType }
  for (const row of rows) {
    const n = Number(row.n) || 0
    const status = String(row.status ?? '')
    if (status === 'open' || status === 'accepted' || status === 'outdated' || status === 'ignored') counts[status] += n
    counts.total += n
    const type = String(row.type ?? 'other')
    byType[type] = (byType[type] || 0) + n
  }
  return counts
}

/**
 * 本章正文整体变了：把与本章相关的 open 问题标 outdated（永不删除）。
 * 相关 = 主章等于本章，或 chapters 数组含本章（跨章问题也随本章失效）。
 * exceptProblemId 用于「正在采纳的这条问题」跳过自己。
 */
export function markChapterOutdated(db, chapter, { exceptProblemId = '' } = {}) {
  const target = Math.trunc(numberOf(chapter, 0))
  if (!(target > 0)) return { updated: 0 }
  const rows = db.prepare("SELECT id, chapter, chapters FROM problems WHERE status = 'open'").all()
  const stmt = db.prepare("UPDATE problems SET status = 'outdated', updated_at = ? WHERE id = ?")
  const now = nowIso()
  let updated = 0
  for (const row of rows) {
    if (exceptProblemId && String(row.id) === String(exceptProblemId)) continue
    const related = Number(row.chapter) === target || readChapters(row.chapters).includes(target)
    if (!related) continue
    stmt.run(now, String(row.id))
    updated += 1
  }
  return { updated }
}
