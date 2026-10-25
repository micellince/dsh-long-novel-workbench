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

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
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
export async function onChapterSaved({ dir, chapter, text, previousText = '', words = 0 }) {
  const index = buildIndex(text, chapter)
  // 先取旧索引（用于意见重定位），再覆盖写新索引
  const previous = await getChapterIndex(dir, chapter).catch(() => null)
  const prev = previous && previous.chapter === Number(chapter) ? previous : (previousText ? buildIndex(previousText, chapter) : null)
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
    const candidates = ledgerdb.unknownCandidates(body, aliases)
    if (candidates.length) summary.unknown = ledgerdb.queueUnknown(db, chapter, candidates).queued
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

export async function getOpinion(dir, id) {
  const { db } = await openBook(dir)
  return opinions.getOpinion(db, id)
}

export async function listOpinions(dir, query = {}) {
  const { db } = await openBook(dir)
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

export async function addHighlight(dir, item) {
  const { db } = await openBook(dir)
  return ledgerdb.addHighlight(db, item)
}
