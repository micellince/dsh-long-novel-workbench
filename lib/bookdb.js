/**
 * 作品数据库编排层：一个作品一个库（novel.db），段落索引落盘，账本/意见同步。
 *
 * 当前阶段（0.7 M1）：库放在作品数据目录 `projects/<id>/novel.db`；
 * 等「一本书=一个工作区」迁移时，整个数据目录一起搬，库跟着走。
 *
 * 重要约束：
 *  - SQLite 不可用时降级：段落索引仍然写成 chapters/NNNN.index.json，账本/意见不可用并在界面提示；
 *  - 所有同步都包在 try/catch 里，失败绝不阻断正文保存；
 *  - 账本日常同步零 AI 成本：只做本地匹配与计数。
 */

import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { probeSqlite, openDb, DbUnavailableError } from './db.js'
import { buildIndex, splitTitle, findParagraphByQuote } from './paras.js'
import * as opinions from './opinions.js'
import * as ledgerdb from './ledgerdb.js'

const dbCache = new Map()
let sqliteState = null

/** 启动自检结果（进程内缓存）。 */
export async function sqliteStatus() {
  if (!sqliteState) sqliteState = await probeSqlite()
  return sqliteState
}

export function dbFile(dir) {
  return join(dir, 'novel.db')
}

export function indexPath(dir, chapter) {
  return join(dir, 'chapters', `${String(Number(chapter) || 0).padStart(4, '0')}.index.json`)
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/** 读全量账本 JSON（用于首次建账）。 */
async function readLedgerJson(dir) {
  const names = ['characters', 'locations', 'facts', 'events', 'foreshadow', 'conflicts', 'highlights', 'outlines']
  const out = {}
  for (const name of names) {
    const value = await readJson(join(dir, `${name}.json`), null)
    out[name] = Array.isArray(value) ? value : []
  }
  return out
}

/** 打开（或复用）作品库；SQLite 不可用时抛 DbUnavailableError。 */
export async function openBook(dir) {
  const key = String(dir)
  if (dbCache.has(key)) return dbCache.get(key)
  const state = await sqliteStatus()
  if (!state.ok) throw new DbUnavailableError(state.reason || '当前环境不支持 SQLite')
  const db = await openDb(dbFile(dir))
  const ledger = await readLedgerJson(dir)
  try {
    ledgerdb.importLedger(db, ledger)
    importLedgerItems(db, ledger)
    importOutlines(db, ledger.outlines)
  } catch {
    /* 建账失败不阻断打开（下次再试） */
  }
  const book = { db, dir }
  dbCache.set(key, book)
  return book
}

/** 只读状态：给设置页 / 诊断用。永不抛错。 */
export async function storageStatus(dir = '') {
  const state = await sqliteStatus()
  const out = {
    engine: state.ok ? 'sqlite' : 'json',
    node: state.node,
    reason: state.reason || '',
    dbPath: dir ? dbFile(dir) : '',
    opinions: 0,
    ledger: null,
    indexFiles: 0,
  }
  if (!dir) return out
  if (!state.ok) return out
  try { await ensureReviewSync(dir) } catch { /* 同步失败不影响状态 */ }
  try {
    const { db } = await openBook(dir)
    out.opinions = opinions.statusCounts(db)
    out.ledger = ledgerdb.ledgerStats(db)
  } catch (error) {
    out.engine = 'json'
    out.reason = error?.message || String(error)
  }
  return out
}

/** 读章节索引文件（没有就返回 null）。 */
export async function getChapterIndex(dir, chapter) {
  return readJson(indexPath(dir, chapter), null)
}

/**
 * 正文保存后：重建索引文件 + 段落表 + 提及表 + 意见重定位。
 * @returns {{ index: object, dbOk: boolean, moved: number, stale: number, mentions: number, reason?: string }}
 */
export async function onChapterSaved({ dir, chapter, text, previousText = '', words = 0, titleHint = '' }) {
  const index = buildIndex(text, chapter, titleHint)
  // 先取旧索引（用于意见重定位），再覆盖写新索引
  const previous = await getChapterIndex(dir, chapter).catch(() => null)
  const prev = previous && previous.chapter === Number(chapter) ? previous : (previousText ? buildIndex(previousText, chapter, titleHint) : null)
  try {
    await writeJsonAtomic(indexPath(dir, chapter), index)
  } catch {
    /* 索引写失败不影响正文 */
  }
  const summary = { index, dbOk: false, moved: 0, stale: 0, mentions: 0, unknown: 0, reason: '' }
  // 数据库部分：任何失败都只降级，不阻断保存
  try {
    const { db } = await openBook(dir)
    const body = splitTitle(text).body
    db.prepare(`
      INSERT INTO chapters (chapter, body_hash, words, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(chapter) DO UPDATE SET body_hash = excluded.body_hash, words = excluded.words, updated_at = excluded.updated_at
    `).run(Number(chapter), index.bodyHash, Number(words) || 0, new Date().toISOString())
    db.prepare('DELETE FROM paras WHERE chapter = ?').run(Number(chapter))
    const insertPara = db.prepare('INSERT INTO paras (chapter, i, pid, hash, head, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const para of index.paras) {
      insertPara.run(Number(chapter), para.i, para.pid, para.hash, para.head, para.start, para.end)
    }
    const aliases = ledgerdb.aliasIndex(db)
    summary.mentions = ledgerdb.rebuildChapterMentions(db, chapter, index, body, aliases).mentions
    const resolved = opinions.resolveChapterOpinions(db, chapter, { prev, next: index })
    summary.moved = resolved.moved
    summary.stale = resolved.stale
    // 未登记专名不再自动入队（启发式噪音大）：只留给本地检查展示 / 作者手动确认
    summary.dbOk = true
  } catch (error) {
    summary.reason = error?.message || String(error)
  }
  return summary
}

/** 把旧 reviews.json 的条目同步为意见（过渡期双写）。 */
export async function syncReviewOpinions({ dir, chapter, text, reviews }) {
  try {
    const { db } = await openBook(dir)
    const stored = await getChapterIndex(dir, chapter)
    const index = stored && stored.chapter === Number(chapter) ? stored : buildIndex(text || '', chapter)
    const withBody = { ...index, body: splitTitle(text || '').body }
    return opinions.syncReviewOpinions(db, reviews, { index: withBody })
  } catch {
    return { synced: 0 }
  }
}

/** 账本摘要（给 AI 用）。 */
export async function ledgerDigest(dir) {
  const { db } = await openBook(dir)
  return { digest: ledgerdb.digest(db), stats: ledgerdb.ledgerStats(db) }
}

export async function entityCounts(dir) {
  const { db } = await openBook(dir)
  return ledgerdb.entityCounts(db)
}

async function readChapterText(dir, chapter) {
  const base = join(dir, 'chapters', String(Number(chapter) || 0).padStart(4, '0'))
  for (const ext of ['txt', 'md']) {
    try {
      const raw = await readFile(`${base}.${ext}`, 'utf8')
      if (ext === 'md') {
        const m = /^---\n[\s\S]*?\n---\n?/.exec(raw)
        return m ? raw.slice(m[0].length) : raw
      }
      return raw
    } catch {
      /* 试下一个格式 */
    }
  }
  return ''
}

/** 首次打开作品时，把 reviews.json 里尚未进意见库的旧审阅（含用户批注）一次性同步进来。 */
export async function ensureReviewSync(dir) {
  const state = await sqliteStatus()
  if (!state.ok) return { synced: 0, reason: state.reason || 'sqlite unavailable' }
  try {
    const { db } = await openBook(dir)
    const marker = db.prepare("SELECT value FROM meta WHERE key = 'reviews_synced_v2'").get()
    if (marker && marker.value === '1') return { synced: 0, cached: true }
    const raw = await readFile(join(dir, 'reviews.json'), 'utf8').catch(() => '[]')
    const reviews = JSON.parse(raw)
    if (!Array.isArray(reviews) || reviews.length === 0) {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('reviews_synced_v2', '1')").run()
      return { synced: 0 }
    }
    const existing = opinions.existingReviewIds(db)
    const missing = reviews.filter((row) => row && row.id && !existing.has(String(row.id)))
    const indexCache = new Map()
    let synced = 0
    for (const review of missing) {
      const chapter = Number(review.chapter) || 0
      let index = null
      if (chapter > 0) {
        if (!indexCache.has(chapter)) {
          const text = await readChapterText(dir, chapter)
          indexCache.set(chapter, text ? { ...buildIndex(text, chapter), body: splitTitle(text).body } : null)
        }
        index = indexCache.get(chapter)
      }
      opinions.syncReviewOpinions(db, [review], { index })
      synced += 1
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('reviews_synced_v2', '1')").run()
    return { synced, total: reviews.length }
  } catch (error) {
    return { synced: 0, reason: error?.message || String(error) }
  }
}

export async function removeChapterData(dir, chapter) {
  try {
    const { db } = await openBook(dir)
    const now = new Date().toISOString()
    db.prepare('DELETE FROM paras WHERE chapter = ?').run(Number(chapter))
    db.prepare('DELETE FROM mentions WHERE chapter = ?').run(Number(chapter))
    db.prepare('DELETE FROM chapters WHERE chapter = ?').run(Number(chapter))
    // 意见不删：章节没了就标 stale，保留原文与作者输入
    db.prepare("UPDATE opinions SET status = 'stale', stale_reason = '章节已删除', updated_at = ? WHERE chapter = ? AND status IN ('open','stale')").run(now, Number(chapter))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) }
  }
}

/**
 * 冷读统一意见：一次冷读只落「1 条」作者可见的冷读意见（不进待处理），
 * 之后由作者点「拆分」按章生成子意见（走正常 AI 意见流程）。
 */
export async function addColdReadSummary({ dir, score = null, verdict = '', text = '', chapters = [] } = {}) {
  const { db } = await openBook(dir)
  const body = [String(text || '').trim(), score != null ? `冷读评分：${Number(score)}/100` : '', verdict ? `结论：${verdict}` : ''].filter(Boolean).join('\n')
  const opinion = opinions.addOpinion(db, {
    chapter: 0,
    anchor: 'chapter',
    kind: 'issue',
    origin: 'ai',
    role: '冷读审稿人',
    text: body || '冷读意见',
    status: 'accepted',
  })
  return { id: opinion.id, chapters: chapters.length ? chapters.length : 0 }
}

/** 冷读统一意见的子意见：按章拆给正常 AI 意见流程（这里只登记来源）。 */
export async function addColdReadChildren({ dir, parentId = '', items = [] } = {}) {
  const { db } = await openBook(dir)
  let added = 0
  for (const item of Array.isArray(items) ? items : []) {
    if (!String(item?.text ?? '').trim()) continue
    opinions.addOpinion(db, {
      chapter: Number(item.chapter) || 0,
      para: null,
      anchor: 'chapter',
      kind: 'issue',
      origin: 'ai',
      role: '冷读审稿人',
      text: String(item.text),
      after: String(item.after ?? ''),
      status: 'open',
      sourceReviewId: parentId ? `cold:${parentId}` : null,
    })
    added += 1
  }
  return { added }
}

export async function addColdReadOpinions({ dir, chapter, points = [], index = null }) {
  const { db } = await openBook(dir)
  let added = 0
  for (const point of Array.isArray(points) ? points : []) {
    if (!point || !String(point.comment ?? '').trim()) continue
    let anchor = 'paragraph'
    let para = null
    let paraHash = ''
    if (point.anchor === 'title') {
      anchor = 'title'
      paraHash = index?.titleHash || ''
    } else if (index && Number.isInteger(Number(point.para)) && Number(point.para) >= 0) {
      para = Number(point.para)
      paraHash = index.paras[para]?.hash || ''
    } else if (index && point.quote) {
      const at = findParagraphByQuote(index, point.quote)
      if (at === -2) { anchor = 'title'; paraHash = index.titleHash || '' }
      else if (at >= 0) { para = at; paraHash = index.paras[at]?.hash || '' }
      else anchor = 'quote'
    }
    opinions.addOpinion(db, {
      chapter,
      para,
      paraHash,
      anchor,
      kind: point.kind === 'highlight' ? 'highlight' : 'issue',
      origin: 'ai',
      role: '冷读审稿人',
      text: String(point.comment ?? ''),
      after: String(point.after ?? ''),
      status: 'open',
    })
    added += 1
  }
  return { added }
}

function importOutlines(db, rows) {
  const count = Number(db.prepare('SELECT COUNT(*) AS n FROM outlines').get()?.n) || 0
  if (count > 0) return { imported: false }
  const stmt = db.prepare('INSERT OR IGNORE INTO outlines (chapter, title, summary, status, goal, updated_at, attrs) VALUES (?, ?, ?, ?, ?, ?, ?)')
  let n = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    const chapter = Number(row?.chapter ?? 0)
    if (!chapter) continue
    stmt.run(chapter, String(row.title ?? ''), String(row.summary ?? ''), String(row.status ?? ''), String(row.goal ?? ''), String(row.updatedAt ?? new Date().toISOString()), JSON.stringify(row))
    n += 1
  }
  return { imported: true, count: n }
}

const LEDGER_KINDS = ['facts', 'characters', 'events', 'foreshadow', 'conflicts', 'locations', 'highlights']

function importLedgerItems(db, ledger) {
  const count = Number(db.prepare('SELECT COUNT(*) AS n FROM ledger_items').get()?.n) || 0
  if (count > 0) return { imported: false }
  const stmt = db.prepare('INSERT OR IGNORE INTO ledger_items (kind, id, data, updated_at) VALUES (?, ?, ?, ?)')
  let n = 0
  for (const kind of LEDGER_KINDS) {
    for (const row of Array.isArray(ledger?.[kind]) ? ledger[kind] : []) {
      if (!row || typeof row !== 'object') continue
      const id = String(row.id || `${kind}_${Math.random().toString(36).slice(2, 10)}`)
      stmt.run(kind, id, JSON.stringify({ ...row, id }), String(row.updatedAt || new Date().toISOString()))
      n += 1
    }
  }
  return { imported: true, count: n }
}

export async function listLedgerItems(dir, kind) {
  const { db } = await openBook(dir)
  return db.prepare('SELECT data FROM ledger_items WHERE kind = ? ORDER BY rowid ASC').all(String(kind))
    .map((row) => { try { return JSON.parse(row.data) } catch { return null } })
    .filter(Boolean)
}

export async function upsertLedgerItem(dir, kind, item) {
  const { db } = await openBook(dir)
  const id = String(item?.id || '')
  if (!id) throw new Error('账本条目缺少 id')
  db.prepare(`INSERT INTO ledger_items (kind, id, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .run(String(kind), id, JSON.stringify(item), new Date().toISOString())
  // 人物/地点：同步实体与别名，保证提及/搜索跟着更新
  if (kind === 'characters' || kind === 'locations') {
    const entityKind = kind === 'characters' ? 'character' : 'location'
    const name = String(item.name || '').trim()
    if (name) {
      db.prepare(`INSERT INTO entities (id, kind, name, first_chapter, attrs) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, first_chapter = excluded.first_chapter, attrs = excluded.attrs`)
        .run(id, entityKind, name, Number(item.firstChapter) || null, JSON.stringify(item))
      db.prepare('DELETE FROM aliases WHERE entity_id = ?').run(id)
      const aliases = new Set([name, ...(Array.isArray(item.aliases) ? item.aliases.map(String) : [])])
      const aliasStmt = db.prepare('INSERT OR IGNORE INTO aliases (alias, entity_id, source) VALUES (?, ?, ?)')
      for (const alias of aliases) if (alias) aliasStmt.run(alias, id, 'ledger')
    }
  }
  return { kind, id }
}

export async function deleteLedgerItem(dir, kind, id) {
  const { db } = await openBook(dir)
  db.prepare('DELETE FROM ledger_items WHERE kind = ? AND id = ?').run(String(kind), String(id))
  if (kind === 'characters' || kind === 'locations') {
    db.prepare('DELETE FROM entities WHERE id = ?').run(String(id))
  }
  return { kind, id }
}

export async function relatedChaptersForOpinion(dir, opinion, { limit = 30 } = {}) {
  const { db } = await openBook(dir)
  const chapter = Number(opinion?.chapter) || 0
  const para = opinion?.para
  if (!chapter) return []
  const rows = para == null
    ? db.prepare('SELECT entity_id FROM mentions WHERE chapter = ?').all(chapter)
    : db.prepare('SELECT entity_id FROM mentions WHERE chapter = ? AND para_i = ?').all(chapter, Number(para))
  const ids = [...new Set(rows.map((row) => row.entity_id))]
  if (ids.length === 0) return [{ chapter, count: 1 }]
  const placeholders = ids.map(() => '?').join(',')
  const chapters = db.prepare(`SELECT chapter, COUNT(*) AS n FROM mentions WHERE entity_id IN (${placeholders}) GROUP BY chapter ORDER BY chapter ASC LIMIT ?`)
    .all(...ids, Number(limit) || 30)
  return chapters.map((row) => ({ chapter: Number(row.chapter), count: Number(row.n) || 0 }))
}

export async function rebuildAllMentions(dir) {
  const { db } = await openBook(dir)
  const aliases = ledgerdb.aliasIndex(db)
  const chapterDir = join(dir, 'chapters')
  let files = []
  try { files = (await readdir(chapterDir)).filter((file) => /^\d{4}\.txt$/.test(file)) } catch { files = [] }
  let chapters = 0
  let mentions = 0
  for (const file of files) {
    const chapter = Number(file.slice(0, 4))
    let text = ''
    let meta = {}
    try { text = await readFile(join(chapterDir, file), 'utf8') } catch { continue }
    try { meta = JSON.parse(await readFile(join(chapterDir, file.replace(/\.txt$/, '.meta.json')), 'utf8')) } catch { meta = {} }
    const index = buildIndex(text, chapter, String(meta?.title ?? ''))
    const body = splitTitle(text, String(meta?.title ?? '')).body
    ledgerdb.rebuildChapterMentions(db, chapter, index, body, aliases)
    chapters += 1
    mentions += Number(db.prepare('SELECT COUNT(*) AS n FROM mentions WHERE chapter = ?').get(chapter)?.n) || 0
  }
  return { chapters, mentions }
}

export async function listOutlines(dir) {
  const { db } = await openBook(dir)
  return db.prepare('SELECT * FROM outlines ORDER BY chapter ASC').all().map((row) => {
    let extra = {}
    try { extra = row.attrs ? JSON.parse(row.attrs) : {} } catch { extra = {} }
    return { ...extra, chapter: Number(row.chapter), title: row.title || '', summary: row.summary || '', status: row.status || '', goal: row.goal || '', updatedAt: row.updated_at || '' }
  })
}

export async function upsertOutline(dir, item = {}) {
  const { db } = await openBook(dir)
  const chapter = Number(item.chapter)
  if (!chapter) throw new Error('大纲缺少章号')
  const existing = db.prepare('SELECT attrs FROM outlines WHERE chapter = ?').get(chapter)
  let merged = {}
  try { merged = existing?.attrs ? JSON.parse(existing.attrs) : {} } catch { merged = {} }
  merged = { ...merged, ...item, chapter }
  db.prepare(`INSERT INTO outlines (chapter, title, summary, status, goal, updated_at, attrs) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chapter) DO UPDATE SET title=excluded.title, summary=excluded.summary, status=excluded.status, goal=excluded.goal, updated_at=excluded.updated_at, attrs=excluded.attrs`)
    .run(chapter, String(merged.title ?? ''), String(merged.summary ?? ''), String(merged.status ?? ''), String(merged.goal ?? ''), new Date().toISOString(), JSON.stringify(merged))
  return { chapter }
}

export async function deleteOutline(dir, chapter) {
  const { db } = await openBook(dir)
  db.prepare('DELETE FROM outlines WHERE chapter = ?').run(Number(chapter))
  return { chapter: Number(chapter) }
}

export async function getOpinion(dir, id) {
  const { db } = await openBook(dir)
  return opinions.getOpinion(db, id)
}

export async function listOpinions(dir, query = {}) {
  const { db } = await openBook(dir)
  await ensureReviewSync(dir).catch(() => {})
  return { rows: opinions.listOpinions(db, query), groups: opinions.groupByParagraph(opinions.listOpinions(db, query)), counts: opinions.statusCounts(db) }
}

export async function mergeOpinions(dir, ids, patch = {}) {
  const { db } = await openBook(dir)
  return opinions.mergeOpinions(db, ids, patch)
}

export async function patchOpinion(dir, id, patch = {}) {
  const { db } = await openBook(dir)
  return opinions.patchOpinion(db, id, patch)
}

export async function confirmUnknown(dir, name, options = {}) {
  const { db } = await openBook(dir)
  return ledgerdb.confirmUnknown(db, name, options)
}

export async function resolveRelatedOpinions(dir, payload = {}) {
  try {
    const { db } = await openBook(dir)
    return opinions.resolveRelatedOpinions(db, payload)
  } catch {
    return { resolved: 0 }
  }
}

export async function addHighlight(dir, item) {
  const { db } = await openBook(dir)
  return ledgerdb.addHighlight(db, item)
}
