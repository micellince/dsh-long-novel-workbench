/**
 * 意见（审阅）数据层：用户批注与 AI 意见同库、按段组织。
 *
 * 作者定的规则：
 *  - 意见永不丢弃；地址定位不了只标 stale，不删除；
 *  - 同段多条问题可以合并成一条完整意见，由用户确认或改写后发回 AI 重出；
 *  - AI 意见必须带「替换成文」（after），同意即替换，不再走第二次提案链路。
 */

import { randomUUID } from 'node:crypto'
import { transaction } from './db.js'
import { reanchor, findParagraphByQuote } from './paras.js'

export const OPINION_STATUS = ['open', 'accepted', 'rejected', 'merged', 'stale']
const ANCHORS = ['paragraph', 'title', 'chapter', 'quote']

function nowIso() {
  return new Date().toISOString()
}

function newId() {
  return `op_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function rowToOpinion(row) {
  if (!row) return null
  return {
    id: row.id,
    chapter: Number(row.chapter) || 0,
    para: row.para_i == null ? null : Number(row.para_i),
    paraHash: row.para_hash ?? '',
    anchor: row.anchor ?? 'paragraph',
    kind: row.kind ?? 'issue',
    origin: row.origin ?? 'user',
    role: row.role ?? '',
    text: row.text ?? '',
    after: row.after ?? '',
    status: row.status ?? 'open',
    mergedInto: row.merged_into ?? null,
    staleReason: row.stale_reason ?? '',
    authorNote: row.author_note ?? '',
    sourceReviewId: row.source_review_id ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

/** 新增一条意见。 */
export function addOpinion(db, item = {}) {
  const id = String(item.id || newId())
  const now = nowIso()
  const row = {
    id,
    chapter: Number(item.chapter) || 0,
    para_i: item.para == null || item.para === '' ? null : Number(item.para),
    para_hash: String(item.paraHash ?? ''),
    anchor: ANCHORS.includes(item.anchor) ? item.anchor : 'paragraph',
    kind: item.kind === 'highlight' ? 'highlight' : 'issue',
    origin: item.origin === 'ai' ? 'ai' : 'user',
    role: String(item.role ?? ''),
    text: String(item.text ?? ''),
    after: String(item.after ?? ''),
    status: OPINION_STATUS.includes(item.status) ? item.status : 'open',
    merged_into: item.mergedInto ?? null,
    stale_reason: String(item.staleReason ?? ''),
    source_review_id: item.sourceReviewId ?? null,
    created_at: item.createdAt ?? now,
    updated_at: now,
  }
  db.prepare(`
    INSERT INTO opinions (id, chapter, para_i, para_hash, anchor, kind, origin, role, text, after, status, merged_into, stale_reason, source_review_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      chapter = excluded.chapter, para_i = excluded.para_i, para_hash = excluded.para_hash,
      anchor = excluded.anchor, kind = excluded.kind, origin = excluded.origin, role = excluded.role,
      text = excluded.text, after = excluded.after, status = excluded.status,
      merged_into = excluded.merged_into, stale_reason = excluded.stale_reason,
      source_review_id = excluded.source_review_id, updated_at = excluded.updated_at
  `).run(
    row.id, row.chapter, row.para_i, row.para_hash, row.anchor, row.kind, row.origin, row.role,
    row.text, row.after, row.status, row.merged_into, row.stale_reason, row.source_review_id,
    row.created_at, row.updated_at,
  )
  return getOpinion(db, id)
}

export function getOpinion(db, id) {
  return rowToOpinion(db.prepare('SELECT * FROM opinions WHERE id = ?').get(String(id)))
}

/** 列表：默认全部状态；可按章、按状态过滤。 */
export function listOpinions(db, { chapter = null, status = null, limit = 500 } = {}) {
  const where = []
  const args = []
  if (chapter != null) {
    where.push('chapter = ?')
    args.push(Number(chapter))
  }
  if (status) {
    const list = Array.isArray(status) ? status : [status]
    where.push(`status IN (${list.map(() => '?').join(',')})`)
    args.push(...list.map(String))
  }
  const sql = `SELECT * FROM opinions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY chapter ASC, para_i ASC, created_at ASC LIMIT ?`
  return db.prepare(sql).all(...args, Number(limit) || 500).map(rowToOpinion)
}

/** 按段分组（给界面用）。 */
export function groupByParagraph(rows) {
  const map = new Map()
  for (const row of rows) {
    if (row.status === 'merged') continue
    const key = `${row.chapter}:${row.para == null ? 'x' : row.para}`
    if (!map.has(key)) {
      map.set(key, { chapter: row.chapter, para: row.para, opinions: [] })
    }
    map.get(key).opinions.push(row)
  }
  return [...map.values()]
}

/** 局部更新（状态、after、text）。 */
export function patchOpinion(db, id, patch = {}) {
  const current = getOpinion(db, id)
  if (!current) return null
  const next = {
    status: OPINION_STATUS.includes(patch.status) ? patch.status : current.status,
    text: patch.text != null ? String(patch.text) : current.text,
    after: patch.after != null ? String(patch.after) : current.after,
    stale_reason: patch.staleReason != null ? String(patch.staleReason) : current.staleReason,
    authorNote: patch.authorNote != null ? String(patch.authorNote) : (current.authorNote || ''),
  }
  db.prepare('UPDATE opinions SET status = ?, text = ?, after = ?, stale_reason = ?, author_note = ?, updated_at = ? WHERE id = ?')
    .run(next.status, next.text, next.after, next.stale_reason, next.authorNote, nowIso(), String(id))
  return getOpinion(db, id)
}

/**
 * 同段合并：把同章同段的多条意见收成一条完整意见（可带 after）。
 * 原意见保留，状态置 merged 并指向新意见——永远不删。
 */
export function mergeOpinions(db, ids, { text = '', after = '', role = '', origin = 'user' } = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).map((id) => getOpinion(db, id)).filter(Boolean)
  if (list.length < 2) throw Object.assign(new Error('至少要选两条意见才能合并'), { code: 'invalid' })
  const chapter = list[0].chapter
  const para = list[0].para
  if (list.some((row) => row.chapter !== chapter)) throw Object.assign(new Error('只能合并同一章的意见'), { code: 'invalid' })
  if (list.some((row) => row.para !== para)) throw Object.assign(new Error('只能合并同一段落的意见'), { code: 'invalid' })
  const mergedText = String(text || list.map((row) => `· ${row.text}`).join('\n'))
  const mergedAfter = String(after || list.map((row) => row.after).filter(Boolean).join('\n\n'))
  return transaction(db, () => {
    const merged = addOpinion(db, {
      chapter,
      para,
      paraHash: list[0].paraHash,
      anchor: list[0].anchor,
      kind: list[0].kind,
      origin,
      role,
      text: mergedText,
      after: mergedAfter,
      status: 'open',
    })
    const stmt = db.prepare('UPDATE opinions SET status = ?, merged_into = ?, updated_at = ? WHERE id = ?')
    for (const row of list) stmt.run('merged', merged.id, nowIso(), row.id)
    return { merged, sources: list.map((row) => row.id) }
  })
}

/**
 * 正文改动后，对本章未决意见做重定位：
 *  - same / moved → 更新 para 与 hash（静默跟随）
 *  - guess → 标 stale，保留候选信息
 *  - lost → 标 stale，绝不删除
 */
export function resolveChapterOpinions(db, chapter, { prev, next } = {}) {
  const rows = db.prepare(
    "SELECT * FROM opinions WHERE chapter = ? AND status IN ('open','stale') AND para_hash != ''",
  ).all(Number(chapter)).map(rowToOpinion)
  let moved = 0
  let stale = 0
  const stmt = db.prepare('UPDATE opinions SET para_i = ?, para_hash = ?, stale_reason = ?, status = ?, updated_at = ? WHERE id = ?')
  for (const row of rows) {
    const target = reanchor(prev, next, { i: row.para, hash: row.paraHash })
    if (target.status === 'same' || target.status === 'moved') {
      if (target.i !== row.para) {
        stmt.run(target.i, row.paraHash, '', 'open', nowIso(), row.id)
        moved += 1
      }
      continue
    }
    if (target.status === 'lost') {
      // 作者定的规则：意见永不丢、不进孤儿箱——段落定位不了就上调为「章级意见」
      db.prepare("UPDATE opinions SET anchor = 'chapter', para_i = NULL, para_hash = '', status = 'open', stale_reason = '原文段落已删除/大改，已上调为章级意见', updated_at = ? WHERE id = ?")
        .run(nowIso(), row.id)
      stale += 1
      continue
    }
    const reason = `段落疑似移动（候选第 ${Number(target.i) + 1} 段），请确认`
    stmt.run(row.para, row.paraHash, reason, 'stale', nowIso(), row.id)
    stale += 1
  }
  return { checked: rows.length, moved, stale }
}

/**
 * 把旧 reviews.json 的条目镜像进 opinions（过渡期双写）。
 * 地址判定：章节级 / 标题 / 引文命中段落 / 引文未命中 → 标 stale。
 */
export function syncReviewOpinions(db, reviews, { index = null } = {}) {
  const list = Array.isArray(reviews) ? reviews : []
  let synced = 0
  for (const review of list) {
    if (!review || !review.id) continue
    const chapter = Number(review.chapter) || 0
    let anchor = 'quote'
    let para = null
    let paraHash = ''
    let staleReason = ''
    if (review.anchor === 'chapter' || chapter === 0) {
      anchor = 'chapter'
    } else if (review.anchor === 'title') {
      anchor = 'title'
      paraHash = index?.titleHash ?? ''
    } else if (index && review.anchor === 'paragraph' && review.para != null) {
      anchor = 'paragraph'
      para = Number(review.para)
      paraHash = index.paras[para]?.hash || ''
    } else if (index && review.quote) {
      // 见 findParagraphByQuote：-2 = 命中标题，>=0 = 命中段落
      const at = findParagraphByQuote(index, review.quote)
      if (at === -2) {
        anchor = 'title'
        paraHash = index.titleHash || ''
      } else if (at >= 0) {
        anchor = 'paragraph'
        para = at
        paraHash = index.paras[at]?.hash ?? ''
      } else {
        staleReason = '引文未在当前正文逐字命中，地址失效'
      }
    } else if (!review.quote) {
      anchor = 'chapter'
    }
    const statusMap = { fixed: 'accepted', wontfix: 'rejected', archived: 'accepted', proposed: 'open' }
    addOpinion(db, {
      id: `op_${review.id}`,
      chapter,
      para,
      paraHash,
      anchor,
      kind: review.kind === 'highlight' ? 'highlight' : 'issue',
      origin: review.source === 'reader' ? 'user' : 'ai',
      role: String(review.role ?? review.source ?? ''),
      text: String(review.issue ?? ''),
      after: String(review.after ?? ''),
      status: statusMap[String(review.status ?? 'open')] || 'open',
      staleReason,
      sourceReviewId: String(review.id),
      createdAt: review.createdAt,
    })
    synced += 1
  }
  return { synced }
}

export function existingReviewIds(db) {
  const rows = db.prepare("SELECT source_review_id FROM opinions WHERE source_review_id IS NOT NULL AND source_review_id != ''").all()
  return new Set(rows.map((row) => String(row.source_review_id)))
}

export function statusCounts(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM opinions GROUP BY status').all()
  const out = {}
  for (const row of rows) out[row.status] = Number(row.n)
  return out
}
