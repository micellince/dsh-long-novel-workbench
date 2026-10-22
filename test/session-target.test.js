/**
 * 清单发送目标：显式会话 > 同工作区运行中 > 同工作区最近；显式会话必须属于本书工作区。
 * 背景：之前用「同工作区最新会话」冒充「当前对话」，独立审稿人新开会话后会把清单抢走。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickHandoffTarget } from '../index.js'

const WS = '/books/碧血青霜缘'
const items = [
  { sessionId: 'old', cwd: WS, updatedAt: '2026-10-22T01:00:00.000Z' },
  { sessionId: 'other-book', cwd: '/books/other', updatedAt: '2026-10-22T02:00:00.000Z' },
  { sessionId: 'blank', cwd: WS, blank: true },
  { sessionId: 'sub', cwd: WS, parentSessionId: 'old' },
  { sessionId: 'running', cwd: WS, running: true, updatedAt: '2026-10-22T00:00:00.000Z' },
]

test('显式选中的会话优先，且属于本书工作区', () => {
  const picked = pickHandoffTarget(items, { sessionId: 'old', workspacePath: WS })
  assert.equal(picked.preferred?.sessionId, 'old')
  assert.equal(picked.explicit?.sessionId, 'old')
  assert.equal(picked.rejectedSessionId, false)
})

test('显式会话属于别的工作区：拒绝并回退到同工作区运行中', () => {
  const picked = pickHandoffTarget(items, { sessionId: 'other-book', workspacePath: WS })
  assert.equal(picked.explicit, null)
  assert.equal(picked.rejectedSessionId, true)
  assert.equal(picked.preferred?.sessionId, 'running')
})

test('没有显式选择：优先同工作区运行中，其次最近；过滤空白/子会话/别书', () => {
  const picked = pickHandoffTarget(items, { workspacePath: WS })
  assert.equal(picked.preferred?.sessionId, 'running')
  assert.deepEqual(picked.candidates.map((item) => item.sessionId), ['old', 'running'])
})

test('最近排序由调用方负责：candidates 保持传入顺序，取不到时为 null', () => {
  const picked = pickHandoffTarget([{ sessionId: 'x', cwd: '/books/other' }], { workspacePath: WS })
  assert.equal(picked.preferred, null)
  assert.deepEqual(picked.candidates, [])
})

test('没有工作区路径时不过滤 cwd，但依然排除空白/子会话', () => {
  const picked = pickHandoffTarget(items, {})
  assert.equal(picked.candidates[0]?.sessionId, 'old')
  assert.ok(!picked.candidates.some((item) => item.sessionId === 'blank' || item.sessionId === 'sub'))
})
