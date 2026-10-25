/**
 * 账本数据库：实体 / 别名 / 提及 / 事实 / 事件 / 伏笔 / 冲突 / 高光。
 *
 * 作者定的规则：
 *  - 账本只同步两次：导入或写完一次（AI 建账）、之后用户手动要求时一次；
 *  - 日常改动由程序增量同步：正文改 → 段落 diff → 提及与计数自动增删，零 AI 成本；
 *  - 大纲不入库（没法量化）；
 *  - 手工查看通过工作台账本页（查库），不再看散落 JSON。
 */

import { transaction } from './db.js'

const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍却璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公'

const STOP_WORDS = new Set([
  '自己', '他们', '我们', '你们', '什么', '怎么', '这个', '那个', '一个', '两个', '三个', '时候', '现在',
  '知道', '看见', '说道', '心中', '身上', '手中', '眼前', '背后', '脚步', '声音', '事情', '地方', '东西',
  '一起', '之后', '之前', '突然', '忽然', '缓缓', '轻轻', '终于', '依然', '只是', '于是', '但是', '因为',
  '所以', '已经', '还是', '不是', '如果', '虽然', '然后', '这里', '那里', '哪里', '别人', '大家', '有人',
  '没有', '不能', '不会', '可以', '应该', '一边', '一面', '一样', '片刻', '半晌', '半响', '此时', '当时',
])

function nowIso() {
  return new Date().toISOString()
}

function json(value) {
  return JSON.stringify(value ?? null)
}

/** 首次建账：把已有 JSON 账本导入数据库（只在 entities 为空时做）。 */
export function importLedger(db, ledger = {}) {
  const count = Number(db.prepare('SELECT COUNT(*) AS n FROM entities').get()?.n) || 0
  if (count > 0) return { imported: false, entities: count }
  const characters = Array.isArray(ledger.characters) ? ledger.characters : []
  const locations = Array.isArray(ledger.locations) ? ledger.locations : []
  let entities = 0
  let aliases = 0
  transaction(db, () => {
    const entityStmt = db.prepare('INSERT OR IGNORE INTO entities (id, kind, name, first_chapter, attrs) VALUES (?, ?, ?, ?, ?)')
    const aliasStmt = db.prepare('INSERT OR IGNORE INTO aliases (alias, entity_id, source) VALUES (?, ?, ?)')
    for (const row of characters) {
      const id = String(row.id || `char_${row.name}`)
      if (!row.name) continue
      entityStmt.run(id, 'character', String(row.name), Number(row.firstChapter) || null, json(row))
      aliasStmt.run(String(row.name), id, 'import')
      for (const alias of Array.isArray(row.aliases) ? row.aliases : []) {
        if (alias) aliasStmt.run(String(alias), id, 'import')
      }
      entities += 1
      aliases += 1
    }
    for (const row of locations) {
      const id = String(row.id || `loc_${row.name}`)
      if (!row.name) continue
      entityStmt.run(id, 'location', String(row.name), Number(row.firstChapter) || null, json(row))
      aliasStmt.run(String(row.name), id, 'import')
      for (const alias of Array.isArray(row.aliases) ? row.aliases : []) {
        if (alias) aliasStmt.run(String(alias), id, 'import')
      }
      entities += 1
      aliases += 1
    }
    const factStmt = db.prepare('INSERT OR IGNORE INTO facts (id, subject, attribute, value, unit, from_chapter, mention_id, attrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const row of Array.isArray(ledger.facts) ? ledger.facts : []) {
      factStmt.run(String(row.id || `fact_${row.subject}_${row.attribute}_${row.chapter}`), String(row.subject ?? ''), String(row.attribute ?? ''), String(row.value ?? ''), String(row.unit ?? ''), Number(row.chapter) || null, null, json(row))
    }
    const eventStmt = db.prepare('INSERT OR IGNORE INTO events (id, chapter, para_i, story_time, participants, location, summary) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const row of Array.isArray(ledger.events) ? ledger.events : []) {
      eventStmt.run(String(row.id || `event_${row.chapter}_${row.title}`), Number(row.chapter) || null, null, String(row.storyTime ?? ''), json(row.participants ?? []), String(row.location ?? ''), String(row.summary ?? row.title ?? ''))
    }
    const foreStmt = db.prepare('INSERT OR IGNORE INTO foreshadows (id, planted_chapter, planted_para, payoff_chapter, payoff_para, status) VALUES (?, ?, ?, ?, ?, ?)')
    for (const row of Array.isArray(ledger.foreshadow) ? ledger.foreshadow : []) {
      foreStmt.run(String(row.id || `fore_${row.title}`), Number(row.setupChapter) || null, null, Number(row.payoffChapter) || null, null, String(row.status ?? ''))
    }
    const conflictStmt = db.prepare('INSERT OR IGNORE INTO conflicts (id, parties, chapters, status) VALUES (?, ?, ?, ?)')
    for (const row of Array.isArray(ledger.conflicts) ? ledger.conflicts : []) {
      conflictStmt.run(String(row.id || `conflict_${row.title}`), json(row.parties ?? []), json({ from: row.fromChapter ?? null, to: row.resolveChapter ?? null }), String(row.status ?? ''))
    }
    const highlightStmt = db.prepare('INSERT OR IGNORE INTO highlights (id, chapter, para_i, quote, comment, source_opinion_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const row of Array.isArray(ledger.highlights) ? ledger.highlights : []) {
      highlightStmt.run(String(row.id || `hl_${row.chapter}_${row.quote}`), Number(row.chapter) || null, null, String(row.quote ?? ''), String(row.why ?? row.note ?? row.title ?? ''), null, row.createdAt ?? nowIso())
    }
  })
  return { imported: true, entities, aliases }
}

/** 别名表：alias → {entityId, kind, name}；按首字分组加速扫描。 */
export function aliasIndex(db) {
  const rows = db.prepare('SELECT a.alias AS alias, e.id AS id, e.kind AS kind, e.name AS name FROM aliases a JOIN entities e ON e.id = a.entity_id').all()
  const byFirst = new Map()
  const all = []
  for (const row of rows) {
    const alias = String(row.alias || '')
    if (!alias) continue
    const item = { alias, entityId: String(row.id), kind: String(row.kind), name: String(row.name) }
    all.push(item)
    const key = alias[0]
    if (!byFirst.has(key)) byFirst.set(key, [])
    byFirst.get(key).push(item)
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.alias.length - a.alias.length)
  return { all, byFirst }
}

/** 在一段文本里扫出实体提及。 */
export function scanMentions(text, index) {
  const value = String(text ?? '')
  const out = []
  if (!index || !index.byFirst) return out
  let i = 0
  while (i < value.length) {
    const candidates = index.byFirst.get(value[i])
    let hit = null
    if (candidates) {
      for (const item of candidates) {
        if (value.startsWith(item.alias, i)) { hit = item; break }
      }
    }
    if (hit) {
      out.push({ entityId: hit.entityId, kind: hit.kind, name: hit.name, start: i, end: i + hit.alias.length, quote: value.slice(i, i + hit.alias.length) })
      i += hit.alias.length
    } else {
      i += 1
    }
  }
  return out
}

/**
 * 重建某一章的提及表（保存正文后调用）。
 * @param {object} index 段落索引（含 paras 的 start/end）
 * @param {string} body 正文（不含标题）
 */
export function rebuildChapterMentions(db, chapter, index, body, aliases) {
  const paras = Array.isArray(index?.paras) ? index.paras : []
  return transaction(db, () => {
    db.prepare('DELETE FROM mentions WHERE chapter = ?').run(Number(chapter))
    const stmt = db.prepare('INSERT INTO mentions (entity_id, chapter, para_i, start_offset, end_offset, quote) VALUES (?, ?, ?, ?, ?, ?)')
    let inserted = 0
    for (const para of paras) {
      const text = String(body ?? '').slice(para.start, para.end)
      for (const hit of scanMentions(text, aliases)) {
        stmt.run(hit.entityId, Number(chapter), para.i, para.start + hit.start, para.start + hit.end, hit.quote)
        inserted += 1
      }
    }
    return { chapter: Number(chapter), mentions: inserted }
  })
}

/** 未登记专名候选：姓氏 + 1~2 字、章内出现 ≥2 次、不在别名表、不是常用词。 */
export function unknownCandidates(body, aliases, { limit = 20 } = {}) {
  const known = new Set((aliases?.all || []).map((item) => item.alias))
  const text = String(body ?? '')
  const counts = new Map()
  for (let i = 0; i < text.length; i += 1) {
    const first = text[i]
    if (!SURNAMES.includes(first)) continue
    for (const size of [3, 2]) {
      const name = text.slice(i, i + size)
      if (name.length < size) continue
      if (!/^[\u4e00-\u9fa5]+$/.test(name)) continue
      if (known.has(name) || STOP_WORDS.has(name)) continue
      counts.set(name, (counts.get(name) || 0) + 1)
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }))
}

/** 候选进队列，等作者/AI 批量确认。 */
export function queueUnknown(db, chapter, candidates) {
  const stmt = db.prepare(`
    INSERT INTO unknown_entities (name, chapter, para_i, count, status, note)
    VALUES (?, ?, NULL, ?, 'pending', NULL)
    ON CONFLICT(name, chapter) DO UPDATE SET count = excluded.count
  `)
  let queued = 0
  transaction(db, () => {
    for (const item of Array.isArray(candidates) ? candidates : []) {
      stmt.run(String(item.name), Number(chapter), Number(item.count) || 1)
      queued += 1
    }
  })
  return { queued }
}

export function listUnknown(db, { status = 'pending', limit = 100 } = {}) {
  return db.prepare('SELECT * FROM unknown_entities WHERE status = ? ORDER BY chapter ASC, count DESC LIMIT ?').all(String(status), Number(limit) || 100)
}

/** 确认一个专名：登记成实体与别名，之后扫描自动命中。 */
export function confirmUnknown(db, name, { chapter = null, kind = 'character', entityId = null, aliasOf = null } = {}) {
  return transaction(db, () => {
    let id = entityId || aliasOf
    if (!id) {
      id = `auto_${kind}_${name}`
      db.prepare('INSERT OR IGNORE INTO entities (id, kind, name, first_chapter, attrs) VALUES (?, ?, ?, ?, ?)')
        .run(id, String(kind), String(name), chapter == null ? null : Number(chapter), null)
    }
    db.prepare('INSERT OR IGNORE INTO aliases (alias, entity_id, source) VALUES (?, ?, ?)').run(String(name), id, 'confirm')
    db.prepare("UPDATE unknown_entities SET status = 'confirmed' WHERE name = ?").run(String(name))
    return { entityId: id, alias: String(name) }
  })
}

/** 账本页用：每个实体的出现次数与最近出现章。 */
export function entityCounts(db, { limit = 500 } = {}) {
  return db.prepare(`
    SELECT e.id AS entityId, e.kind AS kind, e.name AS name,
           COUNT(m.id) AS mentions,
           MIN(m.chapter) AS firstChapter, MAX(m.chapter) AS lastChapter
    FROM entities e
    LEFT JOIN mentions m ON m.entity_id = e.id
    GROUP BY e.id
    ORDER BY e.kind ASC, mentions DESC
    LIMIT ?
  `).all(Number(limit) || 500).map((row) => ({
    entityId: row.entityId, kind: row.kind, name: row.name,
    mentions: Number(row.mentions) || 0,
    firstChapter: row.firstChapter == null ? null : Number(row.firstChapter),
    lastChapter: row.lastChapter == null ? null : Number(row.lastChapter),
  }))
}

/** 高光入账（冷读亮点经作者同意后）。 */
export function addHighlight(db, { chapter, para = null, quote = '', comment = '', sourceOpinionId = null }) {
  const id = `hl_${chapter}_${Date.now().toString(36)}`
  db.prepare('INSERT INTO highlights (id, chapter, para_i, quote, comment, source_opinion_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, Number(chapter), para == null ? null : Number(para), String(quote ?? ''), String(comment ?? ''), sourceOpinionId ? String(sourceOpinionId) : null, nowIso())
  return { id }
}

/** 给 AI 的精简事实摘要（比整本账本便宜一个数量级）。 */
export function digest(db, { maxEntities = 24, maxFacts = 20, maxEvents = 16 } = {}) {
  const lines = []
  const counts = entityCounts(db, { limit: 200 })
  const characters = counts.filter((row) => row.kind === 'character').slice(0, maxEntities)
  const locations = counts.filter((row) => row.kind === 'location').slice(0, maxEntities)
  if (characters.length) lines.push(`人物（出现次数）：${characters.map((row) => `${row.name}×${row.mentions}`).join('、')}`)
  if (locations.length) lines.push(`地点：${locations.map((row) => `${row.name}×${row.mentions}`).join('、')}`)
  const facts = db.prepare('SELECT subject, attribute, value, from_chapter FROM facts ORDER BY from_chapter DESC LIMIT ?').all(maxFacts)
  if (facts.length) lines.push(`事实（最近 ${facts.length} 条）：${facts.map((row) => `${row.subject}·${row.attribute}=${row.value}`).join('；')}`)
  const events = db.prepare("SELECT chapter, story_time, summary FROM events WHERE summary <> '' ORDER BY chapter DESC LIMIT ?").all(maxEvents)
  if (events.length) lines.push(`事件（最近 ${events.length} 条）：${events.map((row) => `第${row.chapter}章 ${row.story_time ? `${row.story_time} ` : ''}${String(row.summary).slice(0, 40)}`).join('；')}`)
  return lines.join('\n') || '（账本为空）'
}

export function ledgerStats(db) {
  const one = (sql) => Number(db.prepare(sql).get()?.n) || 0
  return {
    entities: one('SELECT COUNT(*) AS n FROM entities'),
    aliases: one('SELECT COUNT(*) AS n FROM aliases'),
    mentions: one('SELECT COUNT(*) AS n FROM mentions'),
    facts: one('SELECT COUNT(*) AS n FROM facts'),
    events: one('SELECT COUNT(*) AS n FROM events'),
    foreshadows: one('SELECT COUNT(*) AS n FROM foreshadows'),
    conflicts: one('SELECT COUNT(*) AS n FROM conflicts'),
    highlights: one('SELECT COUNT(*) AS n FROM highlights'),
    unknown: one("SELECT COUNT(*) AS n FROM unknown_entities WHERE status = 'pending'"),
  }
}
