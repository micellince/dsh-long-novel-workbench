import test from 'node:test'
import assert from 'node:assert/strict'
import { handleRpc } from '../index.js'

function fakeCtx(rows, options = {}) {
  const sent = []
  const created = []
  const controller = {
    list: async () => ({ items: rows }),
    prompt: async (request) => {
      const row = rows.find((item) => item.sessionId === request.sessionId)
      if (row?.failPrompt) throw new Error('session is owned by subagent routing')
      sent.push(request.sessionId)
      return { accepted: true }
    },
    create: async () => {
      const made = { sessionId: `new-${created.length + 1}` }
      created.push(made.sessionId)
      rows.push({ sessionId: made.sessionId, updatedAt: '2026-10-24T12:00:00Z', agentAvailable: true, cwd: '/w' })
      return made
    },
  }
  const ctx = { get: (name) => (name === 'sessionController' ? controller : undefined) }
  return { ctx, sent, created, rows }
}

const base = (over) => ({ op: 'chat.send', payload: { prompt: '测试工作单', ...over } })

test('chat.send 跳过子代理会话，选普通会话', async () => {
  const { ctx, sent } = fakeCtx([
    { sessionId: 'sub-1', origin: 'subagent', updatedAt: '2026-10-24T11:00:00Z', agentAvailable: true, cwd: '/w' },
    { sessionId: 'main-1', updatedAt: '2026-10-24T10:00:00Z', agentAvailable: true, cwd: '/w' },
  ])
  const result = await handleRpc(base({}), ctx, { root: '/tmp/nd-chat-test' })
  assert.equal(result.sent, true)
  assert.equal(result.sessionId, 'main-1')
  assert.deepEqual(sent, ['main-1'])
})

test('chat.send 首选会话投递失败时自动换下一个', async () => {
  const { ctx, sent } = fakeCtx([
    { sessionId: 'main-busy', updatedAt: '2026-10-24T11:00:00Z', agentAvailable: true, cwd: '/w', failPrompt: true },
    { sessionId: 'main-ok', updatedAt: '2026-10-24T09:00:00Z', agentAvailable: true, cwd: '/w' },
  ])
  const result = await handleRpc(base({}), ctx, { root: '/tmp/nd-chat-test' })
  assert.equal(result.sessionId, 'main-ok')
  assert.deepEqual(sent, ['main-ok'])
})

test('chat.send 指定子代理会话会给出可操作提示', async () => {
  const { ctx } = fakeCtx([
    { sessionId: 'sub-9', origin: 'subagent', updatedAt: '2026-10-24T11:00:00Z', agentAvailable: true },
  ])
  await assert.rejects(
    () => handleRpc(base({ sessionId: 'sub-9' }), ctx, { root: '/tmp/nd-chat-test' }),
    (error) => {
      assert.equal(error.code, 'invalid')
      assert.match(error.message, /子代理会话/)
      return true
    },
  )
})

test('chat.send 没有普通会话且无法新建时给出可操作提示', async () => {
  const { ctx } = fakeCtx([
    { sessionId: 'sub-only', origin: 'subagent', updatedAt: '2026-10-24T11:00:00Z', agentAvailable: true },
  ])
  await assert.rejects(
    () => handleRpc(base({}), ctx, { root: '/tmp/nd-chat-test' }),
    (error) => {
      assert.equal(error.code, 'invalid')
      assert.match(error.message, /工作区|普通会话/)
      return true
    },
  )
})

test('chat.sessions 只返回普通会话（过滤子代理）', async () => {
  const { ctx } = fakeCtx([
    { sessionId: 'sub-1', origin: 'subagent', updatedAt: '2026-10-24T11:00:00Z', agentAvailable: true, cwd: '/w' },
    { sessionId: 'main-2', updatedAt: '2026-10-24T10:00:00Z', agentAvailable: true, cwd: '/w', running: true },
  ])
  const result = await handleRpc({ op: 'chat.sessions', payload: {} }, ctx, { root: '/tmp/nd-chat-test' })
  assert.equal(result.usable, true)
  assert.deepEqual(result.sessions.map((row) => row.sessionId), ['main-2'])
  assert.equal(result.sessions[0].running, true)
})

test('chat.send 指定别的工作区的会话会被拒绝', async () => {
  const os = await import('node:os')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const store = await import('../lib/store.js')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-chat-ws-'))
  const created = await store.createProject(root, { title: '工作区测试' })
  const projectId = created.id
  await store.updateProject(root, projectId, { workspacePath: '/w/this-book', workspaceId: 'ws-1' })
  const { ctx } = fakeCtx([
    { sessionId: 'other-1', updatedAt: '2026-10-24T10:00:00Z', agentAvailable: true, cwd: '/w/other-book' },
    { sessionId: 'mine-1', updatedAt: '2026-10-24T09:00:00Z', agentAvailable: true, cwd: '/w/this-book' },
  ])
  await assert.rejects(
    () => handleRpc({ op: 'chat.send', payload: { projectId, prompt: '工作单', sessionId: 'other-1' } }, ctx, { root }),
    (error) => {
      assert.equal(error.code, 'invalid')
      assert.match(error.message, /别的工作区/)
      return true
    },
  )
  const result = await handleRpc({ op: 'chat.send', payload: { projectId, prompt: '工作单' } }, ctx, { root })
  assert.equal(result.sessionId, 'mine-1')
})

test('chat.sessions 只列本作品工作区的会话', async () => {
  const os = await import('node:os')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const store = await import('../lib/store.js')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-chat-ws2-'))
  const created = await store.createProject(root, { title: '工作区测试 2' })
  const projectId = created.id
  await store.updateProject(root, projectId, { workspacePath: '/w/this-book' })
  const { ctx } = fakeCtx([
    { sessionId: 'other-1', updatedAt: '2026-10-24T10:00:00Z', agentAvailable: true, cwd: '/w/other-book' },
    { sessionId: 'mine-1', updatedAt: '2026-10-24T09:00:00Z', agentAvailable: true, cwd: '/w/this-book' },
  ])
  const result = await handleRpc({ op: 'chat.sessions', payload: { projectId } }, ctx, { root })
  assert.equal(result.usable, true)
  assert.equal(result.workspacePath, '/w/this-book')
  assert.deepEqual(result.sessions.map((row) => row.sessionId), ['mine-1'])
})
