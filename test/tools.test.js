/**
 * 7 个 Agent 工具的端到端测试：真实 store，但根目录指向 mkdtemp 临时目录
 * （通过 STORY_DESK_ROOT 覆盖 defaultRoot），绝不碰 ~/StoryDesk。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TOOLS } from '../index.js'
import * as store from '../lib/store.js'

const tool = (name) => {
  const found = TOOLS.find((row) => row.name === name)
  assert.ok(found, `缺少工具 ${name}`)
  return found
}

const textOf = (out) => (typeof out === 'string' ? out : JSON.stringify(out))

test('7 个工具在临时作品上跑通读/审/注意力/提案/写/run/地图', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nd-tools-'))
  const previous = process.env.STORY_DESK_ROOT
  process.env.STORY_DESK_ROOT = root
  t.after(async () => {
    if (previous === undefined) delete process.env.STORY_DESK_ROOT
    else process.env.STORY_DESK_ROOT = previous
    await rm(root, { recursive: true, force: true })
  })

  const project = await store.createProject(root, { title: '工具测试书' })
  const projectId = project.id

  const read = tool('novel_desk_read')
  const review = tool('novel_desk_review')
  const attention = tool('novel_desk_attention')
  const propose = tool('novel_desk_propose')
  const write = tool('novel_desk_write')
  const run = tool('novel_desk_run')
  const mapTool = tool('novel_desk_map')

  // 作品库与空态
  const projects = textOf(await read.execute({ op: 'projects' }))
  assert.match(projects, /工具测试书/)
  assert.match(textOf(await read.execute({ op: 'toc', projectId })), /还没有章节/)
  assert.match(textOf(await read.execute({ op: 'inbox', projectId })), /收件箱为空/)

  // 写工具（首次写入，无上一版锚点）
  const wrote = textOf(await write.execute({ projectId, chapter: 1, text: '陈默走了三步，停在门口。\n\n※\n\n门外没有动静。' }))
  assert.match(wrote, /已写入第1章/)
  assert.match(wrote, /保真/)

  // 读单章 / 目录
  const chapter = textOf(await read.execute({ op: 'chapter', projectId, chapter: 1 }))
  assert.match(chapter, /陈默走了三步/)
  assert.match(textOf(await read.execute({ op: 'toc', projectId })), /第1章/)

  // 审阅工具（逐字 quote）
  const reviewed = textOf(
    await review.execute({
      projectId,
      origin: 'cold-read',
      reviews: [{ chapter: 1, source: 'logic', severity: 'major', quote: '门外没有动静', issue: '场景缺时间锚', suggestion: '补一句夜色' }],
    }),
  )
  assert.match(reviewed, /已提交 1 条审阅/)
  assert.match(textOf(await read.execute({ op: 'inbox', projectId })), /场景缺时间锚/)
  // 逐字不命中要失败
  await assert.rejects(
    () => review.execute({ projectId, reviews: [{ chapter: 1, source: 'logic', quote: '正文里没有这句', issue: 'x' }] }),
    /逐字|命中|引文/,
  )

  // 注意力：实测分（四拍合计）+ 工作单
  assert.match(textOf(await attention.execute({ projectId, op: 'measured', items: [{ chapter: 1, breakdown: { hook: 20, tension: 18, payoff: 20, cliff: 20 }, verdict: '会' }] })), /已合并 1 章注意力/)
  const workorder = textOf(await attention.execute({ projectId, op: 'workorder', chapter: 1 }))
  assert.match(workorder, /第1章/)
  assert.equal((textOf(await read.execute({ op: 'align', projectId }))).includes('注意力均分：78'), true)

  // 提案工具：段落补丁
  const proposed = textOf(
    await propose.execute({
      projectId,
      kind: 'patch-paragraph',
      chapter: 1,
      title: '门外补夜色',
      items: [{ before: '门外没有动静。', after: '门外没有动静，夜色压在屋檐上。', why: '审阅：补时间锚' }],
    }),
  )
  assert.match(proposed, /已提交提案/)
  assert.match(textOf(await read.execute({ op: 'proposals', projectId })), /门外补夜色/)

  // 提案工具：账本修订（items=[{kind,id,patch}]）——提交时规范成 data.ledgerFixes，作者点批准能落账本
  const proposedFix = textOf(
    await propose.execute({
      projectId,
      kind: 'ledger-fix',
      title: '补人物卡',
      summary: '工具链路回归',
      items: [{ kind: 'characters', id: 'c1', patch: { id: 'c1', name: '陈默', role: '捕快' } }],
    }),
  )
  assert.match(proposedFix, /已提交提案/)
  const pending = await store.listProposals(root, projectId, { status: 'pending' })
  const fixProposal = pending.find((row) => row.kind === 'ledger-fix' && row.title === '补人物卡')
  assert.ok(fixProposal, '提案应已写入')
  assert.deepEqual(fixProposal.data.ledgerFixes, [{ kind: 'characters', id: 'c1', patch: { id: 'c1', name: '陈默', role: '捕快' } }])
  assert.equal(fixProposal.data.items, undefined)
  const fixOutcome = await store.acceptProposal(root, projectId, fixProposal.id)
  assert.equal(fixOutcome.ok, true, JSON.stringify(fixOutcome))
  assert.equal((await store.getLedger(root, projectId)).characters.find((row) => row.id === 'c1')?.name, '陈默')

  // 账本修订：没有修订项时提交就失败，不留一条批不了的提案
  await assert.rejects(
    () => propose.execute({ projectId, kind: 'ledger-fix', title: '空提案', items: [] }),
    /缺少账本修订项/,
  )

  // 写工具被闸门拦下：整章重写丢数字锚点（三步）
  await assert.rejects(
    () => write.execute({ projectId, chapter: 1, text: '他推门出去。' }),
    /闸门未通过|保真/,
  )
  // 正文没被改
  assert.match(textOf(await read.execute({ op: 'chapter', projectId, chapter: 1 })), /走了三步/)

  // run 生命周期：rephrase 归一成 改写（文风）
  assert.match(textOf(await run.execute({ projectId, op: 'start', kind: 'rephrase', scope: 'book' })), /状态=(running|idle)/)
  const running = textOf(await run.execute({ projectId, op: 'status' }))
  assert.match(running, /改写（文风）/)
  assert.match(running, /先定注意力设计=running/)
  assert.match(running, /running/)
  assert.match(textOf(await run.execute({ projectId, op: 'advance', stageId: 'attention' })), /先定注意力设计=done/)
  assert.match(textOf(await run.execute({ projectId, op: 'pause' })), /paused/)
  assert.match(textOf(await run.execute({ projectId, op: 'resume' })), /running/)
  assert.match(textOf(await run.execute({ projectId, op: 'finish' })), /done|完成/)

  // 从头写：kind=continue 是唯一会写新章的全文动作
  const cont = textOf(await run.execute({ projectId, op: 'start', kind: 'continue', scope: 'range', chapter: 2, endChapter: 3 }))
  assert.match(cont, /从头写/)
  assert.match(cont, /第2–3章/)
  assert.match(cont, /先定注意力设计=running/)
  // 改写侧重非法值 → invalid
  await assert.rejects(
    () => run.execute({ projectId, op: 'start', kind: 'rewrite', variant: 'xxx' }),
    /variant|侧重/,
  )

  // 地图工具：plan 看候选，save 直接写回 world.json（AI 不用人复制粘贴）
  await store.upsertLedgerItem(root, projectId, 'locations', { name: '雾港', type: 'port', coords: { x: 200, y: 300 } })
  await store.upsertLedgerItem(root, projectId, 'locations', { name: '铁峰', type: 'mountain', coords: { x: 500, y: 120 } })
  const planned = textOf(await mapTool.execute({ op: 'plan', projectId }))
  assert.match(planned, /地形候选/)
  assert.match(planned, /水墨绢本/)
  const saved = textOf(await mapTool.execute({ op: 'save', projectId, aiPlan: '区域一｜雾海｜海岸\n路线：雾港→铁峰｜山道\n绘制提示词：冷灰水彩', palette: 'steel' }))
  assert.match(saved, /已把地图方案存进/)
  const ledger = await store.getLedger(root, projectId)
  assert.equal(ledger.world.mapStyle.aiPlan.source, 'ai')
  assert.match(ledger.world.mapStyle.aiPlan.text, /雾港→铁峰/)
  assert.equal(ledger.world.mapStyle.paletteName, '冷灰史诗')
  await assert.rejects(() => mapTool.execute({ op: 'save', projectId }), (error) => error.code === 'invalid')
  await assert.rejects(() => mapTool.execute({ op: '乱写', projectId }), (error) => error.code === 'invalid')
})
