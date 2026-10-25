/**
 * 端到端：真实 store + 真实 HTTP handler，跑通「写 → 审 → 提案 → 改 → 历史」闭环。
 *
 * 只在 mkdtemp 临时根目录里跑，绝不写 ~/StoryDesk。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHandler } from '../index.js'
import * as store from '../lib/store.js'

async function withServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function caller(port) {
  return async function call(op, payload = {}) {
    const res = await fetch(`http://127.0.0.1:${port}/novel-desk/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, payload }),
    })
    const body = await res.json()
    return { status: res.status, ok: body.ok, value: body.value, error: body.error }
  }
}

test('闭环：保存正文 → 实测注意力 → 读者批注 → 提案 → 采纳改正文 → 历史可回看', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nd-e2e-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = await store.createProject(root, { title: '端到端测试书' })
  const projectId = project.id
  const handler = createHandler({}, { root })

  await withServer(handler, async (port) => {
    const call = caller(port)

    // 1) 写正文（纯文本格式）
    const first = await call('chapter.save', { projectId, chapter: 1, text: '陈默数了三下。\n\n他推门出去。', meta: { title: '夜行' } })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.value.format, 'txt')
    assert.ok(first.value.contentHash, '保存后应返回 contentHash')

    // 2) 再改一版：旧内容进历史
    const second = await call('chapter.save', { projectId, chapter: 1, text: '陈默数了三下。\n\n他推门往外走。', baseHash: first.value.contentHash })
    assert.equal(second.ok, true, JSON.stringify(second))
    const history = await call('chapter.history', { projectId, chapter: 1 })
    assert.equal(history.ok, true, JSON.stringify(history))
    assert.ok(history.value.length >= 1, '第二次保存应产生历史备份')
    const version = await call('chapter.version', { projectId, chapter: 1, version: history.value[0].version })
    assert.equal(version.ok, true, JSON.stringify(version))
    assert.match(version.value.text, /他推门出去/)

    // 3) 过期写入被拒（baseHash 不符 → stale）
    const stale = await call('chapter.save', { projectId, chapter: 1, text: '过期的稿', baseHash: 'deadbeefdead' })
    assert.equal(stale.ok, false)
    assert.equal(stale.error.code, 'stale')

    // 4) 注意力实测分：四拍合计 18+16+22+20 = 76
    const merged = await call('attention.merge', { projectId, chapter: 1, patch: { breakdown: { hook: 18, tension: 16, payoff: 22, cliff: 20 }, verdict: '会', weakest: '张力' } })
    assert.equal(merged.ok, true, JSON.stringify(merged))
    assert.equal(merged.value.score, 76)
    assert.equal(merged.value.breakdown.hook, 18)
    assert.ok(Array.isArray(merged.value.scoreHistory) && merged.value.scoreHistory.length >= 1, '分数变化应写 scoreHistory')

    // 5) 读者批注：逐字命中正文，只记审阅、不改正文
    const note = await call('review.add', {
      projectId,
      chapter: 1,
      reviews: [{ chapter: 1, source: 'reader', dimension: '读者', severity: 'minor', quote: '他推门往外走', issue: '这个动作有点平', suggestion: '给个声音' }],
    })
    assert.equal(note.ok, true, JSON.stringify(note))
    assert.equal(note.value.added, 1)
    const inbox = await call('review.list', { projectId, filter: { source: 'reader' } })
    assert.equal(inbox.value.length, 1)

    // 6) 从审阅生成段落补丁提案（人工批准前不动正文）
    const created = await call('proposal.create', {
      projectId,
      kind: 'patch-paragraph',
      chapter: 1,
      title: '给推门加个声音',
      summary: '读者批注：动作平',
      reviewIds: [inbox.value[0].id],
      data: { patches: [{ before: '他推门往外走。', after: '他推门往外走，门轴吱呀一声。', why: '读者批注：动作平' }] },
    })
    assert.equal(created.ok, true, JSON.stringify(created))
    const proposalId = created.value.id
    const before = await call('chapter.get', { projectId, chapter: 1 })
    assert.doesNotMatch(before.value.text, /门轴/)

    // 7) 批准：过闸门 → 落盘 → 关联审阅置 fixed
    const accepted = await call('proposal.accept', { projectId, proposalId })
    assert.equal(accepted.ok, true, JSON.stringify(accepted))
    assert.equal(accepted.value.ok, true, JSON.stringify(accepted.value))
    const after = await call('chapter.get', { projectId, chapter: 1 })
    assert.match(after.value.text, /门轴吱呀一声/)
    assert.equal(after.value.meta.contentHash !== before.value.meta.contentHash, true)
    const fixed = await call('review.list', { projectId })
    assert.equal(fixed.value.find((row) => row.id === inbox.value[0].id).status, 'fixed')

    // 8) 闸门失败：整章重写丢锚点（人名/数字）→ needs-fix，正文不落盘
    await call('chapter.save', { projectId, chapter: 2, text: '陈默走了三步，停在门口。' })
    const bad = await call('proposal.create', {
      projectId,
      kind: 'rewrite-chapter',
      chapter: 2,
      title: '整章重写丢锚点',
      data: { content: '他推门走了出去。' },
    })
    const rejected = await call('proposal.accept', { projectId, proposalId: bad.value.id })
    assert.equal(rejected.ok, true)
    assert.equal(rejected.value.ok, false)
    assert.equal(rejected.value.proposal.status, 'needs-fix')
    assert.ok(Array.isArray(rejected.value.failures) && rejected.value.failures.length > 0)
    const kept = await call('chapter.get', { projectId, chapter: 2 })
    assert.match(kept.value.text, /陈默走了三步/)
  })
})
