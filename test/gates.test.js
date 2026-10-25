import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as store from '../lib/store.js'
import { gateChapterText, gatePatchText, writeChapterWithGates, AISTYLE_MAX } from '../lib/gates.js'
import { auditAiStyle } from '../lib/aistyle.js'

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-nd-gates-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

/** 造一段旧插件风格（AI 味重）的正文：整章闸门会拦，但补丁闸门不该被它拖累。 */
function aiHeavyText() {
  const parts = []
  for (let i = 0; i < 12; i += 1) {
    parts.push(`林默停了停，看了看门口，走了半步，又看了一眼窗外。`)
  }
  return `${parts.join('')}\n\n桌上有一封信。`
}

test('整章闸门：纯文本通过；Markdown 残留与 AI 味重会被拦', async () => {
  const clean = await gateChapterText({ text: '林默推开门，屋里没有人。\n\n桌上有一封信。' })
  assert.deepEqual(clean.failures, [])
  assert.equal(clean.gates.aistyle.pass, true)

  // 安全的 Markdown 标记会被规范化掉（不拦），并记录 removed 供展示
  const markdown = await gateChapterText({ text: '**林默**推开门，[链接](https://example.com)。' })
  assert.equal(markdown.gates.prose.normalized, true)
  assert.ok(Object.keys(markdown.gates.prose.removed).length > 0)
  assert.equal(markdown.text.includes('**'), false)

  const heavy = aiHeavyText()
  assert.ok(auditAiStyle(heavy).score > AISTYLE_MAX, 'fixture 必须超过阈值')
  const blocked = await gateChapterText({ text: heavy })
  assert.ok(blocked.failures.some((item) => item.code === 'aistyle-too-ai'))
})

test('整章闸门：保真拦删除专名（上一版有人名时）', async () => {
  const previous = '陈默走进院子，数了三步。'
  const outcome = await gateChapterText({ text: '他走进院子，数了数。', previousText: previous, meta: { characters: ['陈默'] } })
  assert.ok(outcome.failures.some((item) => item.code === 'fidelity-lost'))
})

test('补丁闸门：只测补丁新增段落，不被旧章 AI 味拖累', async () => {
  const previous = aiHeavyText()
  const next = previous.replace('桌上有一封信。', '桌上放着一封已经拆开的信。')
  const outcome = await gatePatchText({ previousText: previous, nextText: next, deltaText: '桌上放着一封已经拆开的信。' })
  assert.deepEqual(outcome.failures, [], `补丁本身干净就该过：${JSON.stringify(outcome.failures)}`)
  assert.equal(outcome.gates.scope, 'patch')
  assert.equal(outcome.gates.aistyle.pass, true)
})

test('补丁闸门：补丁自己 AI 味重 / 带无法处理结构 → needs-fix', async () => {
  const heavyDelta = await gatePatchText({
    previousText: '桌上有一封信。',
    nextText: '桌上有一封信。他停了停，看了看门口，走了半步。',
    deltaText: '他停了停，看了看门口，走了半步，又看了一眼窗外，停了停，看了看门口。',
  })
  assert.ok(heavyDelta.failures.some((item) => item.code === 'aistyle-too-ai'))

  const markdownDelta = await gatePatchText({
    previousText: '桌上有一封信。',
    nextText: '桌上有一封信。\n\n| 人物 | 关系 |',
    deltaText: '| 人物 | 关系 |\n| --- | --- |',
  })
  assert.ok(markdownDelta.failures.length > 0)
})

test('写入闸门：补丁只动补丁处，旧章其余字节原样保留', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '闸门书' })
  const original = `开头的旧句子。\n\n中间保持不动。\n\n结尾也保持不动。`
  await store.saveChapter(root, project.id, 1, original, { title: '第一章' })
  const patched = original.replace('开头的旧句子。', '开头的旧句子，现在改了。')
  const outcome = await writeChapterWithGates(store, {
    root,
    projectId: project.id,
    chapter: 1,
    text: patched,
    source: 'review',
    patch: { deltaText: '开头的旧句子，现在改了。' },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.gates.scope, 'patch')
  const chapter = await store.readChapter(root, project.id, 1)
  assert.equal(chapter.text, patched)
  assert.equal(chapter.meta.title, '第一章')
})

test('写入闸门：调用方 meta（章节标题/状态）必须落库，不能被闸门丢掉', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '落库书' })
  const outcome = await writeChapterWithGates(store, {
    root,
    projectId: project.id,
    chapter: 1,
    text: '破城那日，城门从里面闩上。\n\n沈怀瑾站在雨里，看见门缝里透出一点灯。',
    source: 'run',
    meta: { title: '破城之日', status: 'draft', summary: '第一卷开篇' },
  })
  assert.equal(outcome.ok, true, JSON.stringify(outcome.failures ?? []))
  const chapter = await store.readChapter(root, project.id, 1)
  assert.equal(chapter.meta.title, '破城之日')
  assert.equal(chapter.meta.status, 'draft')
  assert.equal(chapter.meta.summary, '第一卷开篇')

  // 补丁路径同样不能丢 meta
  const patched = await writeChapterWithGates(store, {
    root,
    projectId: project.id,
    chapter: 1,
    text: chapter.text.replace('一点灯。', '一盏灯。'),
    source: 'review',
    meta: { title: '破城之日（修订）' },
    patch: { deltaText: '一盏灯。' },
  })
  assert.equal(patched.ok, true, JSON.stringify(patched.failures ?? []))
  const after = await store.readChapter(root, project.id, 1)
  assert.equal(after.meta.title, '破城之日（修订）')
})

test('验收回归：旧 AI 味重的章节里，干净补丁也能批准（之前整章重测会永远 needs-fix）', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '旧章书' })
  const legacy = aiHeavyText()
  await store.saveChapter(root, project.id, 1, legacy, { title: '第一章' })
  const proposal = await store.createProposal(root, project.id, {
    chapter: 1,
    kind: 'patch-paragraph',
    title: '改最后一句',
    data: { patches: [{ before: '桌上有一封信。', after: '桌上放着一封已经拆开的信。', why: '更具体' }] },
  })
  const outcome = await store.acceptProposal(root, project.id, proposal.id)
  assert.equal(outcome.ok, true, `干净补丁应能批准：${JSON.stringify(outcome.failures ?? [])}`)
  const chapter = await store.readChapter(root, project.id, 1)
  assert.ok(chapter.text.includes('桌上放着一封已经拆开的信。'))
  assert.ok(chapter.text.includes('林默停了停'), '补丁没有改动旧段落')
  assert.equal((await store.getProposal(root, project.id, proposal.id)).status, 'accepted')
})

test('写入闸门：AI / run 写章也会记「账本待同步」，不再只有手改才记', async (t) => {
  const root = await tempRoot(t)
  const project = await store.createProject(root, { title: '账本联动书' })
  await store.upsertLedgerItem(root, project.id, 'characters', { name: '沈怀瑾' })
  await store.saveChapter(root, project.id, 1, '沈怀瑾站在雨里。\n\n城门从里面闩上。', { title: '第一章' })

  // 以前这里（run / 提案写正文）完全不产生待同步信号，全书写完账本还是旧的
  const outcome = await writeChapterWithGates(store, {
    root,
    projectId: project.id,
    chapter: 1,
    text: '有人站在雨里。\n\n城门从里面闩上。',
    source: 'run',
  })
  assert.equal(outcome.ok, true, JSON.stringify(outcome.failures ?? []))
  const sync = await store.getLedgerSync(root, project.id)
  assert.equal(sync.pending.length, 1)
  assert.equal(sync.pending[0].chapter, 1)
  assert.ok(sync.pending[0].reasons.some((reason) => reason.includes('沈怀瑾')), JSON.stringify(sync.pending[0].reasons))

  // 没动到账本内容的新章不打扰作者
  const quiet = await writeChapterWithGates(store, {
    root,
    projectId: project.id,
    chapter: 2,
    text: '天亮了下雨。\n\n雨停了。',
    source: 'run',
  })
  assert.equal(quiet.ok, true, JSON.stringify(quiet.failures ?? []))
  assert.equal((await store.getLedgerSync(root, project.id)).pending.length, 1)
})
