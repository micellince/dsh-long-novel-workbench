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
  const raw = String(cwd ?? '').replace(/^\/+|\/+$/g, '').replace(/[\\/]/g, '-')
  // DSH 的会话目录名里，非 [A-Za-z0-9._-] 的字符逐个转义成 ~XXXX（大写十六进制），
  // 例如 .../default-workspace/暂定 → --...-default-workspace-~6682~5B9A--
  let out = ''
  for (const ch of raw) {
    out += /^[A-Za-z0-9._-]$/.test(ch) ? ch : '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
  }
  return '--' + out + '--'
}

/** 解析一个 session.jsonl 文本，返回会话头与用量汇总（纯函数，便于测试）。 */
export function parseSessionJsonl(text) {
  const out = { id: '', cwd: '', createdAt: 0, messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, lastAt: 0, days: {}, events: [], model: '', provider: '' }
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
    if (event.type === 'request/header') {
      const config = event?.data?.header?.config
      if (config && typeof config === 'object') {
        if (typeof config.model === 'string') out.model = config.model
        if (typeof config.provider === 'string') out.provider = config.provider
      }
    }
    const usage = event?.data?.usage
    if (usage && typeof usage === 'object') {
      out.messages += 1
      const inputTokens = Number(usage.inputTokens) || 0
      const cacheReadTokens = Number(usage.cacheReadTokens) || 0
      const cacheWriteTokens = Number(usage.cacheWriteTokens) || 0
      const outputTokens = Number(usage.outputTokens) || 0
      const time = Number(event.time) || 0
      out.events.push({ time, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens })
      out.inputTokens += inputTokens
      out.outputTokens += Number(usage.outputTokens) || 0
      out.cacheReadTokens += Number(usage.cacheReadTokens) || 0
      out.cacheWriteTokens += Number(usage.cacheWriteTokens) || 0
      const rowTokens = Number(usage.totalTokens) || (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0)
      out.totalTokens += rowTokens
      if (time > out.lastAt) out.lastAt = time
      if (time) {
        const day = new Date(time).toISOString().slice(0, 10)
        if (!out.days[day]) out.days[day] = { tokens: 0, messages: 0 }
        out.days[day].tokens += rowTokens
        out.days[day].messages += 1
      }
    }
  }
  if (!out.totalTokens) out.totalTokens = out.inputTokens + out.outputTokens + out.cacheReadTokens + out.cacheWriteTokens
  out.hasFullText = out.totalTokens >= 150000 && out.messages >= 5
  out.hasGlobalWorkorder = /【全文动作 goal】|【全文提案工作单】|【全局修改工作单】|【全书账本同步工作单】|【开新书底座工作单】/.test(String(text ?? ''))
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
export async function loadChatUsage(cwd, { limit = 5, sessionIds = null } = {}) {
  const key = String(cwd ?? '')
  if (!key) return { cwd: '', sessions: [], totalTokens: 0, note: '作品没有关联工作区目录，无法读取对话用量。' }
  const cacheKey = key + '|' + (Array.isArray(sessionIds) ? sessionIds.join(',') : 'all')
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

  let dirs = await listSessionDirs(key)
  if (Array.isArray(sessionIds)) dirs = dirs.filter((row) => sessionIds.includes(row.id))
  else dirs = dirs.slice(0, limit)
  const sessions = []
  for (const row of dirs) {
    const parsed = await readSession(row.dir)
    if (!parsed) continue
    sessions.push({ ...parsed, id: parsed.id || row.id, mtime: row.mtime })
  }
  const totalTokens = sessions.reduce((sum, session) => sum + session.totalTokens, 0)
  const value = { cwd: key, sessions, totalTokens }
  cache.set(cacheKey, { at: Date.now(), value })
  return value
}


// ── 价格估算（models.dev，带缓存与内置 DeepSeek 兜底） ─────────────

const PROVIDER_ALIAS = { 'deepseek-official': 'deepseek', 'deepseek-account': 'deepseek', 'kimi-coding': 'moonshotai', 'minimax-cn': 'minimax', 'zai-coding-cn': 'zhipuai' }
const FALLBACK_PRICES = {
  deepseek: {
    models: {
      'deepseek-flash': { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0.15 },
      'deepseek-v4-flash': { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0.15 },
    },
  },
}
let priceCache = null
let priceCacheAt = 0

/** 拉取 models.dev 的模型价格（6 小时缓存；失败回退内置 DeepSeek Flash 价格）。 */
export async function loadModelPrices() {
  if (priceCache && Date.now() - priceCacheAt < 6 * 3600_000) return priceCache
  try {
    const response = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error(`models.dev ${response.status}`)
    const data = await response.json()
    const prices = {}
    for (const [providerId, provider] of Object.entries(data ?? {})) {
      const models = {}
      for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
        const cost = model?.cost
        if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') continue
        models[modelId] = {
          input: cost.input,
          output: cost.output,
          cache_read: typeof cost.cache_read === 'number' ? cost.cache_read : cost.input,
          cache_write: typeof cost.cache_write === 'number' ? cost.cache_write : cost.input,
        }
      }
      if (Object.keys(models).length > 0) prices[providerId] = { models }
    }
    priceCache = Object.keys(prices).length > 0 ? prices : FALLBACK_PRICES
  } catch {
    priceCache = priceCache ?? FALLBACK_PRICES
  }
  priceCacheAt = Date.now()
  return priceCache
}

function modelPrice(prices, provider, model) {
  const id = PROVIDER_ALIAS[provider] ?? provider ?? 'deepseek'
  const models = prices?.[id]?.models
  if (!models) return null
  if (models[model]) return models[model]
  const hit = Object.keys(models).find((key) => model && (model.startsWith(key) || key.startsWith(model)))
  return hit ? models[hit] : null
}

function isPeakTime(ms) {
  const beijing = new Date(Number(ms) + 8 * 3600_000)
  const day = beijing.getUTCDay()
  const hour = beijing.getUTCHours()
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
}

/** 按用量事件估算一个会话的费用（USD）；模型价格不可得时返回 null。 */
export function estimateSessionCost(session, prices) {
  const price = modelPrice(prices, session.provider, session.model || 'deepseek-flash')
  if (!price) return null
  let usd = 0
  for (const event of session.events ?? []) {
    const multiplier = isPeakTime(event.time) ? 2 : 1
    const perMillion = (event.inputTokens * price.input + event.cacheReadTokens * price.cache_read + event.cacheWriteTokens * price.cache_write + event.outputTokens * price.output) / 1_000_000
    usd += perMillion * multiplier
  }
  return { usd, cny: usd / 0.15, price, model: session.model, provider: session.provider }
}
