/**
 * 数据层 · SQLite（Node 内置 node:sqlite，零依赖）。
 *
 * 设计约束（作者定的）：
 *  1. 只在本文件 import 'node:sqlite'：Node / DSH 升级导致 API 变化时，只改这里；
 *  2. 启动先自检 probeSqlite()，失败由上层降级为 JSON 存储并在界面提示；
 *  3. schema 版本化：PRAGMA user_version，逐版迁移，不破坏旧数据；
 *  4. 所有写入走事务；WAL 模式，崩溃可恢复。
 */

export const DB_SCHEMA_VERSION = 5

/** 可预期的「当前环境不支持 SQLite」错误，调用方据此降级。 */
export class DbUnavailableError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'DbUnavailableError'
    this.code = 'db-unavailable'
    if (cause) this.cause = cause
  }
}

let sqliteModule = null

/** 懒加载 node:sqlite：避免在不支持的环境里启动即崩。 */
async function loadSqlite() {
  if (sqliteModule) return sqliteModule
  try {
    sqliteModule = await import('node:sqlite')
  } catch (error) {
    throw new DbUnavailableError(`当前 Node 不支持 node:sqlite（需要 22.13+ 或 24+）：${error.message}`, error)
  }
  if (!sqliteModule?.DatabaseSync) {
    throw new DbUnavailableError('node:sqlite 存在但缺少 DatabaseSync（API 可能已变化）')
  }
  return sqliteModule
}

/**
 * 能力自检：开内存库 → 建表 → 插入 → 读回 → 事务。
 * 返回 { ok, engine, node, reason }，永不抛错。
 */
export async function probeSqlite() {
  const node = process.versions?.node || ''
  try {
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE TABLE probe (a INTEGER)')
      db.prepare('INSERT INTO probe (a) VALUES (?)').run(1)
      const row = db.prepare('SELECT a FROM probe').get()
      db.exec('BEGIN IMMEDIATE')
      db.exec('ROLLBACK')
      if (Number(row?.a) !== 1) throw new Error('读写结果不一致')
      return { ok: true, engine: 'sqlite', node, reason: '' }
    } finally {
      try { db.close() } catch { /* 忽略 */ }
    }
  } catch (error) {
    return { ok: false, engine: 'json', node, reason: error?.message || String(error) }
  }
}

/** 打开（必要时创建）一个库文件。 */
export async function openDb(file) {
  const { DatabaseSync } = await loadSqlite()
  let db
  try {
    db = new DatabaseSync(file)
  } catch (error) {
    throw new DbUnavailableError(`打不开数据库 ${file}：${error.message}`, error)
  }
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}

/** 事务包装：失败回滚并抛出。 */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
    throw error
  }
}

/** schema 迁移：按 user_version 逐版升级。 */
export function migrate(db) {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version) || 0
  if (current >= DB_SCHEMA_VERSION) return current
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- 章节：只存版本与统计，正文仍在 chapters/NNNN.txt
    CREATE TABLE IF NOT EXISTS chapters (
      chapter INTEGER PRIMARY KEY,
      body_hash TEXT NOT NULL,
      words INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );

    -- 段落索引：所有地址的锚点
    CREATE TABLE IF NOT EXISTS paras (
      chapter INTEGER NOT NULL,
      i INTEGER NOT NULL,
      pid TEXT NOT NULL,
      hash TEXT NOT NULL,
      head TEXT,
      start_offset INTEGER,
      end_offset INTEGER,
      PRIMARY KEY (chapter, i)
    );
    CREATE INDEX IF NOT EXISTS idx_paras_pid ON paras (pid);
    CREATE INDEX IF NOT EXISTS idx_paras_hash ON paras (hash);

    -- 账本：实体与别名
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      first_chapter INTEGER,
      attrs TEXT
    );
    CREATE TABLE IF NOT EXISTS aliases (
      alias TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      source TEXT
    );

    -- 提及：出现位置（计数全部由此派生）
    CREATE TABLE IF NOT EXISTS mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      chapter INTEGER NOT NULL,
      para_i INTEGER NOT NULL,
      start_offset INTEGER,
      end_offset INTEGER,
      quote TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions (entity_id);
    CREATE INDEX IF NOT EXISTS idx_mentions_chapter ON mentions (chapter);

    -- 事实：值 + 来源提及
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      subject TEXT,
      attribute TEXT,
      value TEXT,
      unit TEXT,
      from_chapter INTEGER,
      mention_id INTEGER,
      attrs TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts (subject);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      chapter INTEGER,
      para_i INTEGER,
      story_time TEXT,
      participants TEXT,
      location TEXT,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS foreshadows (
      id TEXT PRIMARY KEY,
      planted_chapter INTEGER,
      planted_para INTEGER,
      payoff_chapter INTEGER,
      payoff_para INTEGER,
      status TEXT
    );

    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY,
      parties TEXT,
      chapters TEXT,
      status TEXT
    );

    -- 高光：冷读亮点经作者同意后入账
    CREATE TABLE IF NOT EXISTS highlights (
      id TEXT PRIMARY KEY,
      chapter INTEGER NOT NULL,
      para_i INTEGER,
      quote TEXT,
      comment TEXT,
      source_opinion_id TEXT,
      created_at TEXT
    );

    -- 意见：用户批注与 AI 意见同库，按段分组
    CREATE TABLE IF NOT EXISTS opinions (
      id TEXT PRIMARY KEY,
      chapter INTEGER NOT NULL,
      para_i INTEGER,
      para_hash TEXT,
      anchor TEXT NOT NULL DEFAULT 'paragraph',
      kind TEXT NOT NULL DEFAULT 'issue',
      origin TEXT NOT NULL DEFAULT 'user',
      role TEXT,
      text TEXT NOT NULL,
      after TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      merged_into TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_opinions_chapter ON opinions (chapter, para_i);
    CREATE INDEX IF NOT EXISTS idx_opinions_status ON opinions (status);
  `)
  // v2：未登记专名队列 + 设置 + 意见回指旧审阅
  db.exec(`
    CREATE TABLE IF NOT EXISTS unknown_entities (
      name TEXT NOT NULL,
      chapter INTEGER,
      para_i INTEGER,
      count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      PRIMARY KEY (name, chapter)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `)
  // v4：账本通用条目表（页面/写作读它；JSON 仍保留作备份与兼容）
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_items (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (kind, id)
    );
  `)
  // v3：大纲入库（写作/改写的输入，用户可改、AI 可通过 ledger-fix 提案改）
  db.exec(`
    CREATE TABLE IF NOT EXISTS outlines (
      chapter INTEGER PRIMARY KEY,
      title TEXT,
      summary TEXT,
      status TEXT,
      goal TEXT,
      updated_at TEXT
    );
  `)
  const opinionCols = db.prepare('PRAGMA table_info(opinions)').all().map((row) => row.name)
  if (!opinionCols.includes('author_note')) db.exec("ALTER TABLE opinions ADD COLUMN author_note TEXT DEFAULT ''")
  if (!opinionCols.includes('source_review_id')) {
    db.exec('ALTER TABLE opinions ADD COLUMN source_review_id TEXT')
  }
  if (!opinionCols.includes('stale_reason')) {
    db.exec('ALTER TABLE opinions ADD COLUMN stale_reason TEXT')
  }
  db.exec(`PRAGMA user_version = ${DB_SCHEMA_VERSION}`)
  return DB_SCHEMA_VERSION
}
