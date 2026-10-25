/**
 * 0.6.2 注意力一号原则回归（ATTENTION IS ALL YOU NEED）：
 * 所有写/改工作单第一行注入原则；写前必须先有注意力设计；run 第一步是注意力设计；
 * AI 自定义方案必须带注意力总设计；大纲每章必须带四拍设计；冷读复测保持纯净。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TOOLS } from '../index.js'
import * as store from '../lib/store.js'
import {
  ATTENTION_PRINCIPLE,
  attentionDesignWorkorder,
  attentionRecheckWorkorder,
  chapterRewriteWorkorder,
  fullBookProposalWorkorder,
  newBookWorkorder,
  runGoalPrompt,
} from '../lib/prompts.js'

const project = { id: 'p1', title: '夜雨将明', genre: '悬疑' }
const chapter = { chapter: 4, title: '雨夜来客', path: 'chapters/0004.txt', words: 230 }
const tool = (name) => {
  const found = TOOLS.find((row) => row.name === name)
  assert.ok(found, `缺少工具 ${name}`)
  return found
}
const textOf = (out) => (typeof out === 'string' ? out : JSON.stringify(out))

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'nd-attention-first-'))
  const previous = process.env.STORY_DESK_ROOT
  process.env.STORY_DESK_ROOT = root
  t.after(async () => {
    if (previous === undefined) delete process.env.STORY_DESK_ROOT
    else process.env.STORY_DESK_ROOT = previous
    await rm(root, { recursive: true, force: true })
  })
  return root
}

test('写/改类工作单第一行就是 ATTENTION IS ALL YOU NEED', () => {
  const prompts = [
    runGoalPrompt({ project, run: { kind: 'continue', scope: 'book' } }),
    runGoalPrompt({ project, run: { kind: 'expand', scope: 'range', chapter: 1, endChapter: 3 } }),
    runGoalPrompt({ project, run: { kind: 'rewrite', variant: 'style', scope: 'book' } }),
    runGoalPrompt({ project, run: { kind: 'rewrite', variant: 'logic', scope: 'book' } }),
    chapterRewriteWorkorder({ project, chapter: 4, text: '雨从黄昏就开始下。' }),
    fullBookProposalWorkorder({ project, chapters: [chapter] }),
    newBookWorkorder({ project, preset: { id: 'preset-ai-custom', name: '自定义（让 AI 定）', custom: true }, brief: '失忆仵作追凶' }),
    attentionDesignWorkorder({ project, chapters: [chapter] }),
  ]
  for (const prompt of prompts) {
    assert.ok(prompt.startsWith(ATTENTION_PRINCIPLE), `第一行必须是原则：${prompt.slice(0, 40)}`)
    assert.match(prompt, /ATTENTION IS ALL YOU NEED/)
  }
  // 冷读复测保持零上下文纯净，不注入原则
  const recheck = attentionRecheckWorkorder({ project, chapters: [chapter] })
  assert.equal(recheck.includes(ATTENTION_PRINCIPLE), false, '复测不得注入原则')
})

test('run 工作单带全局注意力块：曲线、疲劳、目标分、强制补强', () => {
  const prompt = runGoalPrompt({
    project,
    run: { kind: 'continue', scope: 'book' },
    attention: [
      { chapter: 1, type: 'mystery', score: 72, designScore: 78, breakdown: { hook: 15, tension: 15, payoff: 25, cliff: 17 } },
      { chapter: 2, type: 'event', score: 75, designScore: 80, breakdown: { hook: 16, tension: 16, payoff: 26, cliff: 17 } },
      { chapter: 3, type: 'language', score: 55, designScore: 80, breakdown: { hook: 20, tension: 20, payoff: 10, cliff: 5 } },
    ],
  })
  assert.match(prompt, /## 第一优先级：注意力（ATTENTION IS ALL YOU NEED）/)
  assert.match(prompt, /最近 6 章注意力曲线/)
  assert.match(prompt, /第3章 55分\/language（设计 80，实测-设计 -25）/)
  assert.match(prompt, /本章目标分：designScore 建议/)
  assert.match(prompt, /## 补强要求（强制）/)
  assert.match(prompt, /差 25 分（≥20）/)
  assert.match(prompt, /上一章最弱一环：章末牵引（cliff）/)
  assert.match(prompt, /## 四拍要求/)
  // 第 0 步先设计，再读材料、再写
  const stepIndex = prompt.indexOf('第 0 步')
  const readIndex = prompt.indexOf('read 工具读 novel_desk_read')
  assert.ok(stepIndex > 0, '缺「第 0 步」注意力设计')
  assert.ok(readIndex < 0 || stepIndex < readIndex, '注意力设计必须排在读材料之前')
})

test('注意力设计工具：缺四拍或 designScore 直接拒绝', async (t) => {
  const root = await tempRoot(t)
  const made = await store.createProject(root, { title: '注意力测试书' })
  const projectId = made.id
  const attention = tool('novel_desk_attention')
  await assert.rejects(
    () => attention.execute({ projectId, op: 'design', items: [{ chapter: 1, type: 'mystery', hook: '门口多了一双鞋', tension: '', payoff: '真相', cliff: '谁在屋里', designScore: 80 }] }),
    /注意力设计未通过.*tension/,
  )
  await assert.rejects(
    () => attention.execute({ projectId, op: 'design', items: [{ chapter: 1, type: 'mystery', hook: '门口多了一双鞋', tension: '时限', payoff: '真相', cliff: '谁在屋里', designScore: 120 }] }),
    /designScore/,
  )
  const ok = textOf(await attention.execute({
    projectId,
    op: 'design',
    items: [{ chapter: 1, type: 'mystery', hook: '门口多了一双鞋', tension: '雨停前必须离开', payoff: '翻出旧案卷', cliff: '谁在屋里', designScore: 82 }],
  }))
  assert.match(ok, /已合并 1 章注意力/)
  const rows = await store.getAttention(root, projectId)
  assert.equal(rows[0].status, 'planned')
  assert.equal(rows[0].designScore, 82)
})

test('写正文时没有注意力设计会提醒；run 开工带全局提醒', async (t) => {
  const root = await tempRoot(t)
  const made = await store.createProject(root, { title: '写作提醒书' })
  const projectId = made.id
  const write = tool('novel_desk_write')
  const run = tool('novel_desk_run')

  const wrote = textOf(await write.execute({ projectId, chapter: 1, text: '陈默走了三步，停在门口。\n\n※\n\n门外没有动静。' }))
  assert.match(wrote, /已写入第1章/)
  assert.match(wrote, /注意力提醒：第1章没有注意力设计记录（ATTENTION IS ALL YOU NEED）/)

  const started = textOf(await run.execute({ projectId, op: 'start', kind: 'continue', scope: 'book' }))
  assert.match(started, /全局提醒（ATTENTION IS ALL YOU NEED）：本书还没有任何注意力设计/)
  assert.match(started, /第 1 步必须是注意力设计|第一步必须是注意力设计/)

  const attention = tool('novel_desk_attention')
  await attention.execute({
    projectId,
    op: 'design',
    items: [{ chapter: 1, type: 'event', hook: '门口多了一双鞋', tension: '雨停前必须离开', payoff: '翻出旧案卷', cliff: '谁在屋里', designScore: 80 }],
  })
  const restarted = textOf(await run.execute({ projectId, op: 'start', kind: 'continue', scope: 'book' }))
  assert.match(restarted, /已有 1 章设计/)
})

test('账本提案硬校验：AI 自定义方案缺 attentionPlan 拒绝；大纲缺 attention 拒绝', async (t) => {
  const root = await tempRoot(t)
  const made = await store.createProject(root, { title: '提案校验书' })
  const projectId = made.id
  const base = { kind: 'ledger-fix', title: 'AI 自定义方案' }
  await assert.rejects(
    () => store.createProposal(root, projectId, {
      ...base,
      data: { ledgerFixes: [{ kind: 'presets', patch: { id: 'preset-ai-custom', name: 'AI 自定义方案' } }] },
    }),
    /AI 自定义方案必须带注意力总设计（ATTENTION IS ALL YOU NEED）/,
  )
  const preset = await store.createProposal(root, projectId, {
    ...base,
    data: {
      ledgerFixes: [{
        kind: 'presets',
        patch: {
          id: 'preset-ai-custom',
          name: 'AI 自定义方案',
          attentionPlan: {
            principle: 'ATTENTION IS ALL YOU NEED',
            targetAvg: 80,
            openingHooks: '第一章 300 字内出现反常现场。',
            mainTypeRotation: ['mystery', 'event', 'emotion'],
            payoffCadence: '每 3 章一次小兑现。',
            cliffRule: '每章末留具体未决问题。',
          },
        },
      }],
    },
  })
  assert.equal(preset.status, 'pending')

  await assert.rejects(
    () => store.createProposal(root, projectId, {
      kind: 'ledger-fix',
      title: '大纲',
      data: { ledgerFixes: [{ kind: 'outlines', patch: { chapter: 1, title: '雨夜', beats: ['a', 'b'] } }] },
    }),
    /大纲提案必须带每章注意力设计/,
  )
  const outline = await store.createProposal(root, projectId, {
    kind: 'ledger-fix',
    title: '大纲',
    data: {
      ledgerFixes: [{
        kind: 'outlines',
        patch: {
          chapter: 1,
          title: '雨夜',
          beats: ['a', 'b'],
          attention: { type: 'mystery', hook: '门口多了一双鞋', tension: '雨停前必须离开', payoff: '翻出旧案卷', cliff: '谁在屋里', question: '谁进过屋', designScore: 80 },
        },
      }],
    },
  })
  assert.equal(outline.status, 'pending')
  const acceptedOutline = await store.acceptProposal(root, projectId, outline.id)
  assert.equal(acceptedOutline.ok, true)
  const designed = (await store.getAttention(root, projectId)).find((row) => Number(row.chapter) === 1)
  assert.equal(designed.designScore, 80)
  assert.equal(designed.status, 'planned')

  // 已有大纲条目（带 id）属于维护性修订，不强制重交四拍；否则账本同步会被整单卡死。
  const outlineFix = await store.createProposal(root, projectId, {
    kind: 'ledger-fix',
    title: '大纲维护',
    data: { ledgerFixes: [{ kind: 'outlines', patch: { id: 'ol_1', chapter: 1, summary: '补一句过场说明' } }] },
  })
  assert.equal(outlineFix.status, 'pending')
})

test('普通正文提案不受注意力硬校验影响（保持三种 kind 契约）', async (t) => {
  const root = await tempRoot(t)
  const made = await store.createProject(root, { title: '普通提案书' })
  const projectId = made.id
  const proposal = await store.createProposal(root, projectId, {
    kind: 'patch-paragraph',
    chapter: 1,
    title: '补一句',
    data: { patches: [{ before: '门外没有动静。', after: '门外还是没有动静。' }] },
  })
  assert.equal(proposal.kind, 'patch-paragraph')
  assert.equal(proposal.status, 'pending')
})
