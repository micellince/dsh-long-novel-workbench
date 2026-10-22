/**
 * AI 用量与上下文统计。
 *
 * 两条通道：
 * - workbench：工作台内的一次性 AI 调用（runAi），每次独立、不进入对话历史；
 * - chat：DSH 对话（agent session），日志在 ~/.dsh/sessions/<编码 cwd>/<session>/session.v*.jsonl.zstd。
 *
 * 工作台调用由本插件写 projects/<id>/usage.json；
 * 对话用量从 session 日志的 data.usage 读取，按 cwd 关联到作品。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const SESSION_ROOT = join(homedir(), '.dsh', 'sessions')
const CACHE_TTL_MS = 30_000
const cache = new Map()

/** DSH 的 cwd → session 目录名。 */
export function encodeCwd(cwd) {
  return '--' + String(cwd ?? '').replace(/^\/+|\/+$/g, '').replace(/[\\/]/g, '-') + '--'
}

/** 解析一个 session.jsonl 文本，返回会话头与用量汇总（纯函数，便于测试）。 */
export function parseSessionJsonl(text) {
  const out = { id: '', cwd: '', createdAt: 0, messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, lastAt: 0 }
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event.type === 'session') {
      out.id = event.id ?? out.id
      out.cwd = event.cwd ?? out.cwd
      out.createdAt = Number(event.createdAt) || out.createdAt
    }
    const usage = event?.data?.usage
    if (usage && typeof usage === 'object') {
      out.messages += 1
      out.inputTokens += Number(usage.inputTokens) || 0
      out.outputTokens += Number(usage.outputTokens) || 0
      out.cacheReadTokens += Number(usage.cacheReadTokens) || 0
      out.cacheWriteTokens += Number(usage.cacheWriteTokens) || 0
      out.totalTokens += Number(usage.totalTokens) || 0
      if (Number(event.time) > out.lastAt) out.lastAt = Number(event.time)
    }
  }
  if (!out.totalTokens) out.totalTokens = out.inputTokens + out.outputTokens + out.cacheReadTokens + out.cacheWriteTokens
  return out
}

async function listSessionDirs(cwd) {
  const dir = join(SESSION_ROOT, encodeCwd(cwd))
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    let info
    try {
      info = await stat(full)
    } catch {
      continue
    }
    rows.push({ id: entry.name, dir: full, mtime: info.mtimeMs })
  }
  rows.sort((a, b) => b.mtime - a.mtime)
  return rows
}

/** DSH 的 session.v*.jsonl.zstd 是多帧拼接，Node 的 zstd 只解第一帧；按 magic 拆分逐帧解压。 */
export function zstdDecompressAll(buf) {
  const magic = [0x28, 0xb5, 0x2f, 0xfd]
  const starts = []
  for (let i = 0; i <= buf.length - 4; i += 1) {
    if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) starts.push(i)
  }
  if (starts.length === 0) return zlib.zstdDecompressSync(buf).toString('utf8')
  const parts = []
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8'))
    } catch {
      // 压缩数据里恰好出现 magic 的情况，跳过这一帧
    }
  }
  return parts.join('')
}

async function readSession(sessionDir) {
  let files = []
  try {
    files = (await readdir(sessionDir)).filter((name) => /^session\.v\d+\.jsonl\.zstd$/.test(name))
  } catch {
    return null
  }
  if (files.length === 0) return null
  const file = join(sessionDir, files[0])
  let buf
  try {
    buf = await readFile(file)
  } catch {
    return null
  }
  let text
  try {
    text = zstdDecompressAll(buf)
  } catch {
    return null
  }
  return parseSessionJsonl(text)
}

/** 读取某个工作区目录的 DSH 对话用量（最近 5 个会话，30 秒缓存）。 */
export async function loadChatUsage(cwd, { limit = 5 } = {}) {
  const key = String(cwd ?? '')
  if (!key) return { cwd: '', sessions: [], totalTokens: 0, note: '作品没有关联工作区目录，无法读取对话用量。' }
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

  const dirs = (await listSessionDirs(key)).slice(0, limit)
  const sessions = []
  for (const row of dirs) {
    const parsed = await readSession(row.dir)
    if (!parsed) continue
    sessions.push({ ...parsed, id: parsed.id || row.id, mtime: row.mtime })
  }
  const totalTokens = sessions.reduce((sum, session) => sum + session.totalTokens, 0)
  const value = { cwd: key, sessions, totalTokens }
  cache.set(key, { at: Date.now(), value })
  return value
}
