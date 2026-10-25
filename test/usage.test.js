import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import {
  encodeCwd,
  parseSessionJsonl,
  zstdDecompressAll,
  loadChatUsage,
  loadModelPrices,
  estimateSessionCost,
} from '../lib/usage.js'

/** 相对误差比较（金额是浮点累加，不用 equal）。 */
function near(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≉ ${expected}`)
}

// 北京时间（UTC+8）锚点：isPeakTime 先 +8h 再读 UTC 字段。
const MON_10_BJ = Date.UTC(2026, 9, 26, 2, 0, 0) // 周一 10:00 峰时
const MON_13_BJ = Date.UTC(2026, 9, 26, 5, 0, 0) // 周一 13:00 非峰
const MON_14_30_BJ = Date.UTC(2026, 9, 26, 6, 30, 0) // 周一 14:30 峰时
const SAT_10_BJ = Date.UTC(2026, 9, 24, 2, 0, 0) // 周六 10:00 非峰
const TUE_10_BJ = Date.UTC(2026, 9, 27, 2, 0, 0) // 周二 10:00 峰时

const usageEvent = (time, usage) => JSON.stringify({ type: 'message/usage', time, data: { usage } })

test('encodeCwd：cwd → session 目录名', () => {
  assert.equal(encodeCwd('/Users/micellince/proj'), '--Users-micellince-proj--')
  // 首尾斜杠先剥离，再统一换连字符
  assert.equal(encodeCwd('/Users/micellince/proj/'), '--Users-micellince-proj--')
  assert.equal(encodeCwd('//a//b//'), '--a--b--')
  // Windows 风格也走同一套分隔符替换
  assert.equal(encodeCwd('C:\\work\\book'), '--C~003A-work-book--')
  // 中文 / 空格等非 [A-Za-z0-9._-] 字符按 DSH 规则转义成 ~XXXX
  assert.equal(encodeCwd('/Users/x/default-workspace/暂定'), '--Users-x-default-workspace-~6682~5B9A--')
  assert.equal(encodeCwd('/Users/x/测试 epub'), '--Users-x-~6D4B~8BD5~0020epub--')
  // 空值退化成纯包裹连字符（保持 0.5.2 行为）
  assert.equal(encodeCwd(''), '----')
  assert.equal(encodeCwd(undefined), '----')
  assert.equal(encodeCwd(null), '----')
})

test('parseSessionJsonl：会话头 / 请求头 / 用量事件 / 按日分桶', () => {
  const text = [
    JSON.stringify({ type: 'session', id: 'sess-abc', cwd: '/work/book', createdAt: 1_700_000_000_000 }),
    JSON.stringify({
      type: 'request/header',
      data: { header: { config: { model: 'deepseek-flash', provider: 'deepseek-official' } } },
    }),
    usageEvent(MON_10_BJ, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 50, totalTokens: 4250 }),
    '',
    'this line is not json',
    // 没有 totalTokens：用四项之和兜底
    usageEvent(MON_10_BJ + 1000, { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    // 换一天，验证分桶按 UTC 日期（isPeakTime 之外，分桶本身不做时区换算）
    usageEvent(TUE_10_BJ, { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10 }),
    '   ',
  ].join('\n')

  const parsed = parseSessionJsonl(text)
  assert.equal(parsed.id, 'sess-abc')
  assert.equal(parsed.cwd, '/work/book')
  assert.equal(parsed.createdAt, 1_700_000_000_000)
  assert.equal(parsed.model, 'deepseek-flash')
  assert.equal(parsed.provider, 'deepseek-official')

  assert.equal(parsed.messages, 3)
  assert.equal(parsed.inputTokens, 1507)
  assert.equal(parsed.outputTokens, 303)
  assert.equal(parsed.cacheReadTokens, 3000)
  assert.equal(parsed.cacheWriteTokens, 50)
  assert.equal(parsed.totalTokens, 4250 + 600 + 10)
  assert.equal(parsed.lastAt, TUE_10_BJ)

  assert.equal(parsed.events.length, 3)
  assert.deepEqual(parsed.events[0], { time: MON_10_BJ, inputTokens: 1000, cacheReadTokens: 3000, cacheWriteTokens: 50, outputTokens: 200 })

  const mon = new Date(MON_10_BJ).toISOString().slice(0, 10)
  const tue = new Date(TUE_10_BJ).toISOString().slice(0, 10)
  assert.notEqual(mon, tue)
  assert.deepEqual(parsed.days[mon], { tokens: 4250 + 600, messages: 2 })
  assert.deepEqual(parsed.days[tue], { tokens: 10, messages: 1 })
  assert.equal(Object.keys(parsed.days).length, 2)
})

test('parseSessionJsonl：空文本 / 脏输入返回零值汇总', () => {
  for (const input of ['', '   ', '\n\n', null, undefined, 'not json at all']) {
    const parsed = parseSessionJsonl(input)
    assert.equal(parsed.messages, 0)
    assert.equal(parsed.totalTokens, 0)
    assert.equal(parsed.lastAt, 0)
    assert.deepEqual(parsed.events, [])
    assert.deepEqual(parsed.days, {})
  }
})

test('zstdDecompressAll：多帧 zstd 拼接解压', (t) => {
  if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') {
    t.skip('当前 Node 没有 zstdCompressSync / zstdDecompressSync')
    return
  }
  const first = JSON.stringify({ type: 'session', id: 'sess-zstd', cwd: '/work/zstd', createdAt: 1 }) + '\n'
  const second = usageEvent(MON_10_BJ, { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, totalTokens: 110 }) + '\n'
  const frameA = zlib.zstdCompressSync(Buffer.from(first, 'utf8'))
  const frameB = zlib.zstdCompressSync(Buffer.from(second, 'utf8'))

  // 单帧：直通
  assert.equal(zstdDecompressAll(frameA), first)

  // 多帧（DSH 的 session.v*.jsonl.zstd 就是这个形状）：必须逐帧拼接
  const multi = Buffer.concat([frameA, frameB])
  assert.equal(zstdDecompressAll(multi), first + second)

  // 解出来的文本可以继续喂给解析器
  const parsed = parseSessionJsonl(zstdDecompressAll(multi))
  assert.equal(parsed.id, 'sess-zstd')
  assert.equal(parsed.totalTokens, 110)
})

test('estimateSessionCost：内置 DeepSeek 兜底价 + 峰时 ×2', async (t) => {
  // 断网：loadModelPrices 必须回退到内置价格表
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('offline in test')
  })
  const prices = await loadModelPrices()

  // 内置兜底价（models.dev 不可得时生效），单位 USD / 1M tokens
  assert.deepEqual(prices.deepseek.models['deepseek-flash'], { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0.15 })
  assert.deepEqual(prices.deepseek.models['deepseek-v4-flash'], { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0.15 })

  // 峰时：周一 10:00 与 14:30 都算；非峰：周一 13:00、周六 10:00
  const peak = estimateSessionCost({ provider: 'deepseek', model: 'deepseek-flash', events: [{ time: MON_10_BJ, inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }] }, prices)
  assert.equal(peak.usd, 0.3) // 0.15 × 2
  near(peak.cny, 2) // 0.3 / 0.15
  assert.equal(peak.model, 'deepseek-flash')
  assert.equal(peak.provider, 'deepseek')
  assert.deepEqual(peak.price, prices.deepseek.models['deepseek-flash'])

  const peakLate = estimateSessionCost({ provider: 'deepseek', model: 'deepseek-flash', events: [{ time: MON_14_30_BJ, inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }] }, prices)
  assert.equal(peakLate.usd, 0.3)

  const offPeak = estimateSessionCost({ provider: 'deepseek', model: 'deepseek-flash', events: [{ time: MON_13_BJ, inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }] }, prices)
  assert.equal(offPeak.usd, 0.15)
  assert.equal(peak.usd, offPeak.usd * 2)

  const weekend = estimateSessionCost({ provider: 'deepseek', model: 'deepseek-flash', events: [{ time: SAT_10_BJ, inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }] }, prices)
  assert.equal(weekend.usd, 0.15)

  // 四种计价字段各走一遍：cache_read 0.003，cache_write 0.15，output 0.6
  const mixed = estimateSessionCost({
    provider: 'deepseek-official', // 别名 → deepseek
    model: 'deepseek-flash',
    events: [
      { time: MON_10_BJ, inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, // 0.15 × 2
      { time: MON_13_BJ, inputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 0 }, // 0.003
      { time: SAT_10_BJ, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000, outputTokens: 0 }, // 0.15
      { time: SAT_10_BJ, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 }, // 0.6
    ],
  }, prices)
  near(mixed.usd, 0.3 + 0.003 + 0.15 + 0.6)
  near(mixed.cny, (0.3 + 0.003 + 0.15 + 0.6) / 0.15)
  assert.equal(mixed.provider, 'deepseek-official')

  // 没见过的模型 → 无法定价
  const unknown = estimateSessionCost({ provider: 'deepseek', model: 'totally-unknown-model', events: [{ time: MON_10_BJ, inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }] }, prices)
  assert.equal(unknown, null)

  // 没有 provider 也没有匹配模型时同样返回 null（prices 里没有空串 provider）
  assert.equal(estimateSessionCost({ model: 'totally-unknown-model', events: [] }, prices), null)
})

test('loadChatUsage：不存在的 cwd 返回空 sessions；无 cwd 返回提示', async () => {
  const cwd = `/no/such/workspace/${Date.now()}-${Math.random().toString(16).slice(2)}`
  const empty = await loadChatUsage(cwd)
  assert.equal(empty.cwd, cwd)
  assert.deepEqual(empty.sessions, [])
  assert.equal(empty.totalTokens, 0)

  const noCwd = await loadChatUsage('')
  assert.equal(noCwd.cwd, '')
  assert.deepEqual(noCwd.sessions, [])
  assert.equal(noCwd.totalTokens, 0)
  assert.equal(typeof noCwd.note, 'string')
  assert.ok(noCwd.note.length > 0)
})
