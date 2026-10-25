/**
 * 0.6.4 审阅 → 全量章节工作单 / book-fix 全书修改 / 提案编辑 / 工作单透传的端到端测试。
 * 真实 store，根目录指向 mkdtemp 临时目录（STORY_DESK_ROOT），绝不碰 ~/StoryDesk。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TOOLS, handleRpc } from '../index.js'
import * as store from '../lib/store.js'

const tool = (name) => {
  const found = TOOLS.find((row) => row.name === name)
  assert.ok(found, `缺少工具 ${name}`)
  return found
}

const textOf = (out) => (typeof out === 'string' ? out : JSON.stringify(out))

async function env(t) {
  const root = await mkdtemp(join(tmpdir(), 'nd-review-flow-'))
  const previous = process.env.STORY_DESK_ROOT
  process.env.STORY_DESK_ROOT = root
  t.after(async () => {
    if (previous === undefined) delete process.env.STORY_DESK_ROOT
    else process.env.STORY_DESK_ROOT = previous
    await rm(root, { recursive: true, force: true })
  })
  const project = await store.createProject(root, { title: '工作单测试书' })
  return { root, project }
}

const ctx = { get: () => undefined }

const lineNumbers = (text, prefix) => text
  .split('\n')
  .map((line) => new RegExp(`^${prefix}第(\\d+)章`).exec(line))
  .filter(Boolean)
  .map((match) => Number(match[1]))

const twoChapters = async (root, projectId) => {
  await store.saveChapter(root, projectId, 1, '雨从黄昏就开始下。林默推开门，屋里没有人。', { title: '雨夜来客' })
  await store.saveChapter(root, projectId, 2, '城门在夜里开了。林默回头看了一眼。', { title: '城门' })
}

test('novel_desk_attention：不传 chapters 默认全量（13 章），显式 chapters / limit 才收窄', async (t) => {
  const { root, project } = await env(t)
  const projectId = project.id
  await store.updateProject(root, projectId, { workspacePath: '/tmp/nd-attn-ws' })
  for (let n = 1; n <= 13; n += 1) {
    await store.saveChapter(root, projectId, n, `第${n}章正文。门外没有动静，林默推开门。`)
  }
  const attention = tool('novel_desk_attention')

  // 默认：整本书 13 章全部进工作单（绝不默认截 3 章）
  const full = textOf(await attention.execute({ projectId, op: 'workorder' }))
  assert.deepEqual(lineNumbers(full, '### '), Array.from({ length: 13 }, (_, i) => i + 1))
  assert.equal(full.includes('### 第14章'), false)

  // 用户显式选章：只审选中的章
  const picked = textOf(await attention.execute({ projectId, op: 'workorder', chapters: [2, 5, 9] }))
  assert.deepEqual(lineNumbers(picked, '### '), [2, 5, 9])
  assert.equal(picked.includes('### 第1章'), false)
  assert.equal(picked.includes('### 第3章'), false)

  // 显式 limit 才截断（limit=3）
  const limited = textOf(await attention.execute({ projectId, op: 'workorder', limit: 3 }))
  assert.equal(lineNumbers(limited, '### ').length, 3)

  // op=recheck 无 chapters：只取 recheckPending 的章
  for (const row of await store.getAttention(root, projectId)) {
    await store.mergeAttention(root, projectId, row.chapter, {
      score: 60 + Number(row.chapter),
      breakdown: { hook: 15, tension: 15, payoff: 15, cliff: 15 },
    })
  }
  // 第 5、7 章正文又改了一次 → 重新进复测队列
  await store.saveChapter(root, projectId, 5, '第5章正文修改。门外没有动静，林默推开门。')
  await store.saveChapter(root, projectId, 7, '第7章正文修改。门外没有动静，林默推开门。')
  const recheck = textOf(await attention.execute({ projectId, op: 'recheck' }))
  assert.deepEqual(lineNumbers(recheck, '- '), [5, 7])
  // 复测清单每行都必须带可读路径（project.workspacePath 兜底）
  // 冷读只带正文地址，不塞标题/字数等上下文
  assert.match(recheck, /^- 第5章 ｜ \/tmp\/nd-attn-ws\/chapters\/0005\.txt$/m)
  assert.match(recheck, /^- 第7章 ｜ \/tmp\/nd-attn-ws\/chapters\/0007\.txt$/m)
  // 复测工作单不贴旧分（零上下文重打）
  assert.match(recheck, /禁止参考任何历史分数或历史补丁/)
  for (const line of recheck.split('\n').filter((row) => /^- 第\d+章/.test(row))) {
    assert.equal(/\d+ 分/.test(line), false, `复测清单不能出现旧分：${line}`)
  }

  // 复测 + 显式 chapters：用户选择优先于待复测队列
  const recheckPicked = textOf(await attention.execute({ projectId, op: 'recheck', chapters: [3] }))
  assert.deepEqual(lineNumbers(recheckPicked, '- '), [3])

  // 冷读打分说明：工具参数 focus 必须写进工作单（且不引入旧分）
  const focusNote = '重点看第 3 章读者会不会在第二段弃读。'
  const recheckFocused = textOf(await attention.execute({ projectId, op: 'recheck', chapters: [3], focus: focusNote }))
  assert.ok(recheckFocused.includes(focusNote), 'focus 没有写进冷读打分工作单')
  assert.match(recheckFocused, /## 本次打分说明（作者指定/)
  assert.doesNotMatch(recheckFocused, /\d+ 分/, '冷读打分工作单不得出现旧分')

  // 待复测清空后 recheck 回到全书，而不是空单
  for (const chapter of [5, 7]) {
    await store.mergeAttention(root, projectId, chapter, {
      score: 70 + chapter,
      breakdown: { hook: 17, tension: 17, payoff: 18, cliff: 18 },
    })
  }
  const recheckAll = textOf(await attention.execute({ projectId, op: 'recheck' }))
  assert.equal(lineNumbers(recheckAll, '- ').length, 13)
})

test('novel_desk_propose：kind="book-fix" 用 items 提交也落成 data.patches + baseHashes', async (t) => {
  const { root, project } = await env(t)
  const projectId = project.id
  await twoChapters(root, projectId)
  const reviewTool = tool('novel_desk_review')
  const propose = tool('novel_desk_propose')

  assert.match(textOf(await reviewTool.execute({
    projectId,
    reviews: [{ chapter: 0, source: 'logic', severity: 'major', quote: '全书时间线', issue: '时间线错位' }],
  })), /已提交 1 条审阅/)
  const review = (await store.getReviews(root, projectId))[0]

  const proposed = textOf(await propose.execute({
    projectId,
    kind: 'book-fix',
    chapter: 0,
    title: '全局修改：统一时间线',
    summary: '午后下雨、傍晚开城门',
    data: { opinion: '全书统一成午后下雨、傍晚开城门' },
    items: [
      { chapter: 1, before: '雨从黄昏就开始下。', after: '雨从午后就开始下。', reviewIds: [review.id] },
      { chapter: 2, before: '城门在夜里开了。', after: '城门在傍晚开了。', reviewIds: [review.id] },
    ],
  }))
  assert.match(proposed, /已提交提案/)
  assert.match(proposed, /book-fix/)

  const pending = await store.listProposals(root, projectId, { status: 'pending' })
  const proposal = pending.find((row) => row.kind === 'book-fix')
  assert.ok(proposal, 'book-fix 提案应已写入')
  assert.equal(Number(proposal.chapter), 0)
  assert.equal(proposal.data.opinion, '全书统一成午后下雨、傍晚开城门')
  assert.equal(proposal.data.items, undefined, 'items 必须规范成 data.patches')
  assert.equal(proposal.data.patches.length, 2)
  assert.deepEqual(Object.keys(proposal.data.baseHashes).sort(), ['1', '2'])
  assert.equal(proposal.data.baseHashes['1'], (await store.readChapter(root, projectId, 1)).meta.contentHash)
  const reviews = await store.getReviews(root, projectId)
  assert.equal(reviews.find((row) => String(row.id) === String(review.id)).status, 'proposed')

  // 提案可在提案页原样改（updateProposal 契约）
  const updated = await store.updateProposal(root, projectId, proposal.id, { data: { ...proposal.data, opinion: '改成只统一雨的时间' } })
  assert.equal(updated.status, 'pending')
  assert.equal(updated.data.opinion, '改成只统一雨的时间')
})

test('novel_desk_review：同一引文出现 2 次无法唯一定位，报错文案点名原因', async (t) => {
  const { root, project } = await env(t)
  const projectId = project.id
  await store.saveChapter(root, projectId, 1, '屋里没有人。林默推开门。\n\n屋里没有人。')
  const reviewTool = tool('novel_desk_review')

  // 只有重复引文：一条都写不进 → 整次调用失败，并说明无法唯一定位
  await assert.rejects(
    () => reviewTool.execute({
      projectId,
      reviews: [{ chapter: 1, source: 'logic', severity: 'minor', quote: '屋里没有人。', issue: '重复句' }],
    }),
    (error) => /没有写入任何审阅/.test(error.message) && /无法唯一定位/.test(error.message),
  )
  assert.equal((await store.getReviews(root, projectId)).length, 0)

  // 部分成功：唯一引文写入，重复引文跳过并带原因
  const partial = textOf(await reviewTool.execute({
    projectId,
    reviews: [
      { chapter: 1, source: 'logic', severity: 'minor', quote: '林默推开门', issue: '动作太快' },
      { chapter: 1, source: 'logic', severity: 'minor', quote: '屋里没有人。', issue: '重复句' },
    ],
  }))
  assert.match(partial, /已提交 1 条审阅/)
  assert.match(partial, /跳过 1 条/)
  assert.match(partial, /该引文在第1章出现2次，无法唯一定位/)
  const reviews = await store.getReviews(root, projectId)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].quote, '林默推开门')
})

test('chat.send dryRun：proposalGroupsWorkorder 透传 groups / chapters / focus', async (t) => {
  const { root, project } = await env(t)
  const projectId = project.id
  const groups = [
    {
      chapter: 1,
      title: '雨夜来客',
      path: 'chapters/0001.txt',
      reviews: [{ id: 'r1', source: 'logic', severity: 'major', quote: '雨从黄昏就开始下', issue: '动机跳跃', suggestion: '补一个动作' }],
    },
    {
      chapter: 3,
      title: '城门',
      path: 'chapters/0003.txt',
      reviews: [{ id: 'r9', source: 'attention', severity: 'major', quote: '城门在夜里开了', issue: '章末没有钩子' }],
    },
  ]
  const result = await handleRpc({
    op: 'chat.send',
    payload: {
      projectId,
      workorder: 'proposalGroupsWorkorder',
      groups,
      focus: '动机要更狠',
      dryRun: true,
    },
  }, ctx, { root })
  assert.equal(result.dryRun, true)
  assert.equal(result.projectId, projectId)
  const prompt = String(result.prompt)
  assert.match(prompt, /【审阅 → 分章提案工作单】/)
  assert.match(prompt, /本次处理 2 章、共 2 条审阅意见：第1章、第3章/)
  assert.match(prompt, /### 第1章《雨夜来客》 ｜ chapters\/0001\.txt/)
  assert.match(prompt, /### 第3章《城门》 ｜ chapters\/0003\.txt/)
  assert.match(prompt, /动机跳跃/)
  assert.match(prompt, /章末没有钩子/)
  assert.match(prompt, /本次重点（作者指定）\n动机要更狠/)
  assert.match(prompt, /after 必须是「改好后的正文」/)
  assert.match(prompt, /不许「改成…」「建议…」「二选一」「补一次…」「这里应该…」/)
  assert.match(prompt, /reviewIds/)
})

test('chat.send dryRun：globalFixWorkorder 输出 book-fix 两步格式，13 章全列且带 path', async (t) => {
  const { root, project } = await env(t)
  const projectId = project.id
  const chapters = Array.from({ length: 13 }, (_, i) => ({
    chapter: i + 1,
    title: `第${i + 1}章`,
    words: 2000 + i,
    path: `chapters/${String(i + 1).padStart(4, '0')}.txt`,
  }))
  const reviews = [
    { id: 'g1', chapter: 0, source: 'logic', severity: 'blocker', issue: '全书时间线错位', suggestion: '统一口径' },
  ]
  const result = await handleRpc({
    op: 'chat.send',
    payload: { projectId, workorder: 'globalFixWorkorder', chapters, reviews, focus: '时间线', dryRun: true },
  }, ctx, { root })
  assert.equal(result.dryRun, true)
  const prompt = String(result.prompt)
  assert.match(prompt, /【全局修改工作单】/)
  assert.match(prompt, /全书共 13 章；本次选中的全局审阅 1 条/)
  for (const row of chapters) {
    assert.ok(prompt.includes(`- 第${row.chapter}章《${row.title}》 ｜ ${row.words} 字 ｜ ${row.path}`), `缺第${row.chapter}章清单行`)
  }
  assert.match(prompt, /kind="book-fix"、chapter=0：data=\{opinion, patches:\[\{chapter, before, after, why, reviewIds\}\]\}/)
  assert.match(prompt, /after 是最终正文/)
  assert.match(prompt, /每个全书级问题各出一条 book-fix 提案/)
  assert.match(prompt, /novel_desk_propose\(projectId, kind="book-fix", chapter=0, title="全局修改 1\/1：主题"/)
  assert.match(prompt, /\[g1\]/)
})

test('RPC proposal.update：patch.data 改法落盘、needs-fix 回 pending、已处理提案拒绝', async (t) => {
  const { root, project } = await env(t)
  const projectId = project.id
  await twoChapters(root, projectId)
  const proposal = await store.createProposal(root, projectId, {
    kind: 'patch-paragraph',
    chapter: 1,
    title: '段落补丁',
    data: { patches: [{ before: '雨从黄昏就开始下。', after: '雨从午后就开始下。' }] },
  })

  const updated = await handleRpc({
    op: 'proposal.update',
    payload: {
      projectId,
      proposalId: proposal.id,
      patch: { title: '段落补丁（改法二）', data: { patches: [{ before: '林默推开门，屋里没有人。', after: '林默推开门，屋里空无一人。' }] } },
    },
  }, ctx, { root })
  assert.equal(String(updated.id), String(proposal.id))
  assert.equal(updated.title, '段落补丁（改法二）')
  assert.equal(updated.status, 'pending')
  assert.equal(updated.data.patches[0].before, '林默推开门，屋里没有人。')
  const stored = await store.getProposal(root, projectId, proposal.id)
  assert.equal(stored.title, '段落补丁（改法二）')

  // 没有 patch 字段时：payload 剩余字段就是 patch（兼容旧客户端）
  const updated2 = await handleRpc({
    op: 'proposal.update',
    payload: { projectId, proposalId: proposal.id, summary: '直接传字段' },
  }, ctx, { root })
  assert.equal(updated2.summary, '直接传字段')

  // 已采纳的提案不能再改
  await store.acceptProposal(root, projectId, proposal.id, {
    writeGates: async ({ root: r, projectId: pid, chapter, text }) => ({
      ok: true,
      chapter: await store.saveChapter(r, pid, chapter, text, { title: `第${chapter}章` }),
    }),
  })
  await assert.rejects(
    () => handleRpc({ op: 'proposal.update', payload: { projectId, proposalId: proposal.id, patch: { title: 'x' } } }, ctx, { root }),
    /提案已处理：accepted，不能修改/,
  )
})

test('novel_desk_attention：design/measured 支持单章扁平参数（防多对象嵌套 JSON 解析失败）', async (t) => {
  const { root, project } = await env(t)
  const projectId = project.id
  await twoChapters(root, projectId)
  const attention = tool('novel_desk_attention')

  // design：一次一章，扁平字段
  const designOut = textOf(await attention.execute({
    projectId,
    op: 'design',
    chapter: 1,
    type: 'mystery',
    hook: '雨夜来客',
    tension: '门后有动静',
    payoff: '看清来客',
    cliff: '门外脚步声',
    question: '谁在门外',
    designScore: 88,
  }))
  assert.match(designOut, /已合并 1 章注意力/)
  const row1 = (await store.getAttention(root, projectId)).find((row) => Number(row.chapter) === 1)
  assert.equal(row1.designScore, 88)
  assert.equal(row1.type, 'mystery')

  // measured：一次一章，扁平字段；breakdown 合计即 score
  const measuredOut = textOf(await attention.execute({
    projectId,
    op: 'measured',
    chapter: 1,
    score: 71,
    breakdown: { hook: 15, tension: 16, payoff: 20, cliff: 20 },
    verdict: '会',
    weakest: 'hook',
    detail: '冷读打分说明',
    dropPoints: [{ quote: '雨从黄昏就开始下', why: '开篇略慢' }],
  }))
  assert.match(measuredOut, /已合并 1 章注意力/)
  const rowAfter = (await store.getAttention(root, projectId)).find((row) => Number(row.chapter) === 1)
  assert.equal(rowAfter.score, 71)
  assert.equal(rowAfter.breakdown.hook, 15)
  assert.equal(rowAfter.verdict, '会')

  // 扁平写法同样跑完整校验：design 缺项必须拒绝
  await assert.rejects(
    () => attention.execute({ projectId, op: 'design', chapter: 2, type: 'event', hook: '只有钩子' }),
    /注意力设计未通过/,
  )
  // score 与 breakdown 合计不一致也要拒绝
  await assert.rejects(
    () => attention.execute({ projectId, op: 'measured', chapter: 2, score: 90, breakdown: { hook: 10, tension: 10, payoff: 10, cliff: 10 } }),
    /与 breakdown 合计/,
  )
})
