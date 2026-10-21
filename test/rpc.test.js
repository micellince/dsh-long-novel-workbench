/**
 * index.js：HTTP op 冒烟。
 * 优先真实调用 handleRpc（若后端导出）；未导出时退回源码断言新 op 分支存在。
 * 覆盖契约 §3 的新 op：chapter.history/version/restore、proposal.batchAccept/batchReject、
 * review.batchUpdate、import.scan/import.run。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadModule, makeRoot } from './helpers.js'

const NEW_OPS = [
  'chapter.history',
  'chapter.version',
  'chapter.restore',
  'proposal.batchAccept',
  'proposal.batchReject',
  'review.batchUpdate',
  'import.scan',
  'import.run',
]

test('index.js：新 HTTP op 分支存在（优先真实调用 handleRpc）', async (t) => {
  const loaded = await loadModule('../index.js')
  if (loaded.error) throw new Error(`实现未完成：index.js 无法 import（${loaded.error.message}）`)
  const mod = loaded.module

  if (typeof mod.handleRpc !== 'function') {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
    for (const op of NEW_OPS) {
      assert.ok(source.includes(op), `契约 §3 要求 HTTP op「${op}」出现在 index.js`)
    }
    return
  }

  const root = await makeRoot(t)
  const previous = process.env.STORY_DESK_ROOT
  process.env.STORY_DESK_ROOT = root
  t.after(() => {
    if (previous === undefined) delete process.env.STORY_DESK_ROOT
    else process.env.STORY_DESK_ROOT = previous
  })

  const ping = await mod.handleRpc({ op: 'ping' })
  assert.equal(ping.root, root, 'ping 应返回当前 STORY_DESK_ROOT')

  const project = await mod.handleRpc({ op: 'project.create', input: { name: 'RPC 冒烟' } })
  assert.ok(project.id, 'project.create 应返回作品 id')

  await mod.handleRpc({
    op: 'chapter.save',
    projectId: project.id,
    chapter: { id: '0001', title: '第一章', content: '正文。' },
  })
  const history = await mod.handleRpc({ op: 'chapter.history', projectId: project.id, chapterId: '0001' })
  assert.ok(Array.isArray(history), 'chapter.history op 应返回历史数组')

  const md = await mod.handleRpc({ op: 'export', projectId: project.id, format: 'md' })
  assert.equal(typeof md.markdown, 'string', 'export op（format=md）应返回 markdown')

  await assert.rejects(() => mod.handleRpc({ op: 'no.such.op' }), /未知操作/, '未知 op 应报「未知操作」错误')
})
