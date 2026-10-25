/**
 * 注意力提分闭环的 prompt 层（docs/ATTENTION-FIX.md）：工作单 / 复测单 / 看板 / 交接分支 / context·plan 提分行。
 * 纯文本契约测试，不碰 AI 调用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import {
  apply,
  attentionFixWorkorder,
  attentionRecheckWorkorder,
  attentionScoreboardText,
  buildHandoffPrompt,
  prepareReviewSandbox,
  TASK_LABEL,
} from '../index.js'
import { makeRoot } from './helpers.js'

/** 审阅隔离区里的章节文件路径（v0.5.2 起所有审阅 prompt 只给隔离区副本）。 */
function chapterFile(root, bundle, id, chapterNumbers = null) {
  return join(prepareReviewSandbox(root, bundle, chapterNumbers).dir, 'chapters', String(id).padStart(4, '0') + '.md')
}

function useTempRoot(t, root) {
  const previous = process.env.STORY_DESK_ROOT
  process.env.STORY_DESK_ROOT = root
  t.after(() => {
    if (previous === undefined) delete process.env.STORY_DESK_ROOT
    else process.env.STORY_DESK_ROOT = previous
  })
}

const BODY_A = [
  '雪落了一夜，林砚在破庙里等一封不会有人送来的信。',
  '他把信纸折好塞进怀里，没有点火，也没有出门。',
  '门外传来两短一长的敲门声，他握着刀没有起身。',
].join('\n\n')

const BODY_B = [
  '城门口盘查忽然紧了，沈照把刀藏在柴捆底下。',
  '守城的老卒看了他三眼，挥手让他过去。',
  '他走出十步，背后有人叫出了他十年前的旧名。',
].join('\n\n')

function attentionRecord(chapter, overrides = {}) {
  return {
    id: 'att-' + String(chapter).padStart(4, '0'),
    chapter,
    type: 'mystery',
    score: 66,
    designScore: 80,
    verdict: '犹豫',
    weakest: 'cliff',
    hook: '破庙等信',
    tension: '留信不出门',
    payoff: '信的内容',
    cliff: '敲门声',
    detail: '中段太静',
    breakdown: { hook: 16, tension: 13, payoff: 15, cliff: 9 },
    dropPoints: [{ quote: '他把信纸折好塞进怀里', why: '刚说不能留信，读者会出戏' }],
    status: 'verified',
    ...overrides,
  }
}

async function seededRoot(t) {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '提分作品', genre: '武侠' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章 破庙', content: BODY_A })
  await store.saveChapter(root, project.id, { id: '0002', title: '第二章 城门', content: BODY_B })
  await store.upsertEntity(root, project.id, 'attention', attentionRecord(1))
  await store.upsertEntity(root, project.id, 'attention', attentionRecord(2, { score: 74, designScore: 78, weakest: 'tension', breakdown: { hook: 17, tension: 11, payoff: 16, cliff: 15 }, dropPoints: [] }))
  return { root, project }
}

test('attentionFixWorkorder：按提分空间选章，带四拍/弃读点诊断/正文/提交格式', async (t) => {
  const { root, project } = await seededRoot(t)
  const bundle = await store.getBundle(root, project.id)
  const text = attentionFixWorkorder(bundle, {})

  assert.match(text, /【注意力提分方案】/, '应输出提分工作单头')
  assert.match(text, /实测 66 分 \/ 设计 80 分 \/ 目标 80 分 \/ 提分空间 \+\d+/, '应写实测/设计/目标/空间')
  assert.match(text, /四拍（满分 25，< 13 算明显偏弱）：钩子 16 \/ 张力 13 \/ 兑现 15 \/ 章末 9/, '应列四拍分')
  assert.match(text, /最弱一环：章末/, '应写最弱一环中文名')
  assert.match(text, /弃读点（提分方案必须直接改这几处原文）/, '应带弃读点引文')
  assert.match(text, /他把信纸折好塞进怀里/, '弃读点应带原文引文')
  assert.match(text, /确定性诊断（按优先级，方案要逐条对上）/, '应给确定性诊断')
  assert.match(text, /\[必改\]|\[建议\]|\[可选\]/, '诊断应带优先级标签')
  assert.match(text, /本章最少 \d+ 条补丁/, '应给最少补丁条数')
  assert.ok(text.includes(chapterFile(root, bundle, 1)), '应给第一章正文文件路径')
  assert.ok(text.includes(chapterFile(root, bundle, 2)), 'limit 默认 3 应包含第二低分章的文件路径')
  assert.ok(!text.includes(BODY_A), '不应把正文贴进 prompt')
  assert.ok(!text.includes(BODY_B), '不应把正文贴进 prompt')
  assert.match(text, /用 read 工具自己读/, '应要求 AI 自己 read 正文')
  assert.match(text, /novel_desk_propose\(kind="attention-fix", chapter=N/, '应给 attention-fix 提交模板')
  assert.match(text, /before 必须逐字复制该章正文/, '应复述 before 硬校验')
  assert.match(text, /只替换补丁段/, '应说明采纳后只替换补丁段')

  const first = await attentionFixWorkorder(bundle, { limit: 1 })
  assert.ok(first.includes('第一章 破庙'), 'limit=1 应只含提分空间最大的章')
  assert.ok(!first.includes('第二章 城门'), 'limit=1 不应含第二低分章')

  const onlySecond = await attentionFixWorkorder(bundle, { chapter: 2 })
  assert.ok(onlySecond.includes('第二章 城门'), 'chapter=2 应输出指定章')
  assert.ok(!onlySecond.includes('第一章 破庙'), 'chapter=2 不应带别的章')
})

test('attentionFixWorkorder：任何章节都不贴正文，只给文件路径与 read 指引', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '长章作品' })
  const long = '雪'.repeat(20000)
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: long })
  await store.upsertEntity(root, project.id, 'attention', attentionRecord(1))
  const bundle = await store.getBundle(root, project.id)
  const text = attentionFixWorkorder(bundle, { chapter: 1 }, root)

  assert.match(text, /正文不内联，20000 字。正文文件：/, '应给字数与文件路径')
  assert.ok(text.includes(chapterFile(root, bundle, 1)), '应给可读的章节文件绝对路径')
  assert.ok(!text.includes(long), '不应把 2 万字正文塞进 prompt')
  assert.match(text, /offset\/limit 分段读/, '长章应提示分段读')
})

test('attentionFixWorkorder：没打分/没正文时的错误说明下一步', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '未冷读作品' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '正文一。' })
  const bundle = await store.getBundle(root, project.id)
  assert.throws(() => attentionFixWorkorder(bundle, {}), /先做零上下文首读打分/, '未打分应提示先冷读')
  assert.throws(() => attentionFixWorkorder(bundle, { chapter: 1 }), /还没有注意力记录/, '指定章无记录应报错')
})

test('attentionRecheckWorkorder：只列待复测章、不透露旧分、要求零上下文重打四拍', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '复测作品', genre: '悬疑' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: BODY_A })
  await store.saveChapter(root, project.id, { id: '0002', title: '第二章', content: BODY_B })
  const emptyBundle = await store.getBundle(root, project.id)
  assert.throws(() => attentionRecheckWorkorder(emptyBundle, {}), /没有标记「待复测」的章节/, '无待复测章应提示先采纳提分方案')
  await store.upsertEntity(root, project.id, 'attention', attentionRecord(1, { recheckPending: true, fixLog: [{ proposalId: 'p1', at: '2026-01-01T00:00:00.000Z', target: 'cliff', expectedGain: 6 }] }))
  await store.upsertEntity(root, project.id, 'attention', attentionRecord(2, { score: 74 }))
  const bundle = await store.getBundle(root, project.id)
  const text = attentionRecheckWorkorder(bundle, {})

  assert.match(text, /【注意力复测】/, '应输出复测单头')
  assert.match(text, /需要一次【零上下文】复测/, '应要求零上下文')
  assert.ok(text.includes('第一章'), '应包含待复测章')
  assert.ok(!text.includes('第二章'), '不在待复测里的章不应出现在复测单')
  assert.ok(!text.includes('66 分'), '复测单不应透露旧分，避免凑分')
  assert.match(text, /本作类型：悬疑/, '应带类型校准')
  assert.ok(text.includes(chapterFile(root, bundle, 1, [1])), '应给待复测章正文文件路径')
  assert.ok(!text.includes(BODY_A), '复测单也不应贴正文，让 AI 自己 read')
  assert.match(text, /novel_desk_propose\(kind="attention", chapter=N/, '应给 attention 实测提交模板')
  assert.match(text, /breakdown/, '复测也必须拆四拍')
  assert.match(text, /dropPoints/, '复测也要给弃读点')
  assert.match(text, /写回分数历史/, '应说明服务端写回 Δ')
  assert.match(text, /仍低于 75 分/, '复测仍低分要再出提分方案')
  assert.match(text, /复核发现的问题要落成审稿/, '复测读到的新问题必须落成审稿条目')
  assert.ok(text.includes(`novel_desk_review(project="${project.id}", origin="recheck"`), '审稿调用要带 origin=recheck')
  assert.match(text, /chapter=0/, '全书级/跨章共性问题要落到 chapter=0')
  assert.match(text, /勾选 →「加入清单」→ 生成改动提案/, '要说明审稿页的后续动作')
})

test('attentionScoreboardText：看板汇总闭环统计与每章状态', async (t) => {
  const { root, project } = await seededRoot(t)
  await store.upsertEntity(root, project.id, 'attention', attentionRecord(2, { score: 74, designScore: 78, weakest: 'tension', recheckPending: true }))
  const proposal = await store.createProposal(root, project.id, { kind: 'attention', title: '复测分', items: [{ chapter: 1, score: 72 }] })
  await store.acceptProposal(root, project.id, proposal.id)
  const bundle = await store.getBundle(root, project.id)
  const text = attentionScoreboardText(bundle)

  assert.match(text, /# 注意力提分看板/, '应有看板标题')
  assert.match(text, /提分闭环：待复测 1 章/, '应统计待复测章数')
  assert.match(text, /已复测 1 章/, '应统计已复测章数')
  assert.match(text, /待提分章节（按提分空间降序）/, '应列待提分章')
  assert.match(text, /待复测/, '应有待复测状态徽章')
  assert.match(text, /已复测 Δ\+6/, '应显示上次复测 Δ')
  assert.match(text, /下一步：novel_desk_attention_fix\(op="workorder"\)/, '应给下一步操作')
})

test('TASK_LABEL 与 buildHandoffPrompt：attention-fix / attention-recheck 两个任务接通', async (t) => {
  const { root, project } = await seededRoot(t)
  await store.upsertEntity(root, project.id, 'attention', attentionRecord(2, { score: 74, designScore: 78, recheckPending: true }))
  const bundle = await store.getBundle(root, project.id)

  assert.equal(TASK_LABEL['attention-fix'], '生成注意力提分方案')
  assert.equal(TASK_LABEL['attention-recheck'], '复测提分效果')

  const fixPrompt = buildHandoffPrompt(bundle, { task: 'attention-fix', chapter: 1 }, root)
  assert.match(fixPrompt, /【注意力提分方案】/, 'task=attention-fix 应走提分工作单')
  const recheckPrompt = buildHandoffPrompt(bundle, { task: 'attention-recheck' }, root)
  assert.match(recheckPrompt, /【注意力复测】/, 'task=attention-recheck 应走复测单')
  assert.ok(recheckPrompt.includes('第二章'), '待复测的第二章应出现在复测单里')
})

test('novel_desk_attention_fix 工具：workorder / recheck / scoreboard / 未知操作', async (t) => {
  const { root, project } = await seededRoot(t)
  useTempRoot(t, root)
  await store.upsertEntity(root, project.id, 'attention', attentionRecord(2, { score: 74, designScore: 78, recheckPending: true }))
  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {}, get: () => undefined })
  const tool = tools.find((row) => row.name === 'novel_desk_attention_fix')
  assert.ok(tool, 'apply 应注册 novel_desk_attention_fix')
  assert.deepEqual(tool.parameters.properties.op.enum, ['workorder', 'recheck', 'scoreboard'])

  const workorder = await tool.execute({ project: project.id })
  assert.match(workorder, /【注意力提分方案】/, '默认 op=workorder')
  const recheck = await tool.execute({ project: project.id, op: 'recheck' })
  assert.match(recheck, /【注意力复测】/, 'op=recheck 应出复测单')
  const board = await tool.execute({ project: project.id, op: 'scoreboard' })
  assert.match(board, /# 注意力提分看板/, 'op=scoreboard 应出看板')
  await assert.rejects(() => tool.execute({ project: project.id, op: 'nope' }), /未知操作：nope/, '未知操作应报错')
})

test('novel_desk_context / novel_desk_plan：待复测与提分空间进入工作流提示', async (t) => {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name: '闭环上下文' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: BODY_A })
  await store.upsertEntity(root, project.id, 'attention', attentionRecord(1, { recheckPending: true }))
  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {}, get: () => undefined })
  const contextTool = tools.find((row) => row.name === 'novel_desk_context')
  const planTool = tools.find((row) => row.name === 'novel_desk_plan')

  const contextText = await contextTool.execute({ project: project.id, recent: 0 })
  assert.match(contextText, /提分闭环：待复测 1 章/, 'context 应带提分闭环统计')
  assert.match(contextText, /还没复测：先跑 novel_desk_attention_fix\(op="recheck"\)/, 'context 应提示先复测')
  assert.match(contextText, /提分空间最大：第1章 \+\d+/, 'context 应给提分空间最大的章')

  const planText = await planTool.execute({ project: project.id, chapter: 2 })
  assert.match(planText, /## 提分待办（先处理，再写新章）/, 'plan 应先提示提分待办')
  assert.match(planText, /待复测 1 章（1）/, 'plan 应列待复测章号')
})

async function seededWideRoot(t, chapterCount = 4) {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '批量作品', genre: '武侠' })
  for (let chapter = 1; chapter <= chapterCount; chapter += 1) {
    await store.saveChapter(root, project.id, { id: String(chapter).padStart(4, '0'), title: `第${chapter}章 标题${chapter}`, content: `第${chapter}章正文：雪落了一夜，林砚在破庙里等信。\n\n他把信纸折好塞进怀里，没有点火。` })
    await store.upsertEntity(root, project.id, 'attention', attentionRecord(chapter, {
      score: 60 + chapter,
      designScore: 80,
      weakest: 'cliff',
      breakdown: { hook: 16, tension: 12, payoff: 15, cliff: 9 },
    }))
  }
  return { root, project }
}

test('attentionFixWorkorder：all=true 全书出批量工作单，不内联正文、给文件路径与逐章协议', async (t) => {
  const { root, project } = await seededWideRoot(t, 4)
  const bundle = await store.getBundle(root, project.id)
  const text = attentionFixWorkorder(bundle, { all: true }, root)

  assert.match(text, /【注意力提分方案 · 批量】/, '全书多章应出批量工作单')
  assert.match(text, /全书 4 章/, '应标明覆盖全书 4 章')
  assert.match(text, /正文不内联/, '批量模式应说明不内联正文')
  assert.match(text, /## 待处理章节（按提分空间降序）/, '应给章节清单')
  assert.match(text, /## 每章要改什么/, '应给每章诊断')
  assert.match(text, /## 执行协议/, '应给逐章执行协议')
  assert.ok(text.includes(chapterFile(root, bundle, 1)), '应给第一章正文文件绝对路径')
  assert.ok(text.includes(chapterFile(root, bundle, 4)), '应给第四章正文文件绝对路径')
  assert.ok(!text.includes('第1章正文：雪落了一夜'), '批量模式不应把正文塞进 prompt')
  assert.match(text, /novel_desk_propose\(kind="attention-fix"/, '批量模式也要给提交模板')
  assert.match(text, /before 必须逐字复制该章正文/, '批量模式也要复述 before 硬校验')
  assert.match(text, /chapters=\[/, '执行协议应提示用 chapters 分批取详细单')

  const viaZeroLimit = attentionFixWorkorder(bundle, { limit: 0 }, root)
  assert.match(viaZeroLimit, /全书 4 章/, 'limit=0 等价于全部')

  const selectedBatch = attentionFixWorkorder(bundle, { chapters: [3, 1, 2, 4] }, root)
  assert.match(selectedBatch, /自选 4 章/, '自选超过 3 章也走批量工作单')
})

test('attentionFixWorkorder：chapters=[...] 自选章节，只处理选中的章', async (t) => {
  const { root, project } = await seededWideRoot(t, 4)
  const bundle = await store.getBundle(root, project.id)
  const text = attentionFixWorkorder(bundle, { chapters: [2, 1] }, root)

  assert.match(text, /【注意力提分方案】/, '自选少量章仍出详细工作单')
  assert.match(text, /自选 2 章/, '应标明自选 2 章')
  assert.ok(text.includes(chapterFile(root, bundle, 1, [1, 2])), '应给第一章正文文件路径')
  assert.ok(text.includes(chapterFile(root, bundle, 2, [1, 2])), '应给第二章正文文件路径')
  assert.ok(!text.includes('第1章正文'), '不应把正文贴进 prompt')
  assert.ok(!text.includes('第2章正文'), '不应把正文贴进 prompt')
  assert.ok(!text.includes('第3章 标题3'), '不应带未选中的第三章')
  assert.ok(!text.includes('第4章 标题4'), '不应带未选中的第四章')

  assert.throws(() => attentionFixWorkorder(bundle, { chapters: [9] }, root), /第 9 章还没有注意力记录/, '选中不存在的章要报错')
})

test('attentionRecheckWorkorder：all=true 全部待复测走批量复测单，不透露旧分', async (t) => {
  const { root, project } = await seededWideRoot(t, 4)
  for (let chapter = 1; chapter <= 4; chapter += 1) {
    await store.upsertEntity(root, project.id, 'attention', attentionRecord(chapter, { score: 60 + chapter, designScore: 80, weakest: 'cliff', breakdown: { hook: 16, tension: 12, payoff: 15, cliff: 9 }, recheckPending: true }))
  }
  const bundle = await store.getBundle(root, project.id)
  const text = attentionRecheckWorkorder(bundle, { all: true }, root)

  assert.match(text, /【注意力复测 · 批量】/, '全部待复测应出批量复测单')
  assert.match(text, /全书待复测 4 章/, '应标明全部 4 章')
  assert.match(text, /正文不内联/, '批量复测不内联正文')
  assert.ok(text.includes(chapterFile(root, bundle, 4)), '应给正文文件路径')
  assert.ok(!text.includes('第1章正文：雪落了一夜'), '批量复测不应内联正文')
  assert.match(text, /novel_desk_propose\(kind="attention"/, '应给 attention 提交模板')
  assert.match(text, /写回分数历史/, '应说明服务端写回 Δ')
})

test('buildHandoffPrompt：scope=all / scope=selected 接到书/自选工作单', async (t) => {
  const { root, project } = await seededWideRoot(t, 4)
  const bundle = await store.getBundle(root, project.id)

  const allPrompt = buildHandoffPrompt(bundle, { task: 'attention-fix', scope: 'all' }, root)
  assert.match(allPrompt, /【注意力提分方案 · 批量】/, 'scope=all 应走全书批量工作单')

  const selectedPrompt = buildHandoffPrompt(bundle, { task: 'attention-fix', scope: 'selected', chapters: [3] }, root)
  assert.match(selectedPrompt, /自选 1 章/, 'scope=selected 应走自选工作单')
  assert.ok(selectedPrompt.includes(chapterFile(root, bundle, 3, [3])), '自选章应给正文文件路径')
  assert.ok(!selectedPrompt.includes('第3章正文'), '自选章也不贴正文')
  assert.ok(!selectedPrompt.includes('第1章 标题1'), '不应带未选中的章')

  await store.upsertEntity(root, project.id, 'attention', attentionRecord(1, { recheckPending: true }))
  await store.upsertEntity(root, project.id, 'attention', attentionRecord(2, { recheckPending: true }))
  const recheckBundle = await store.getBundle(root, project.id)
  const recheckAll = buildHandoffPrompt(recheckBundle, { task: 'attention-recheck', scope: 'all' }, root)
  assert.match(recheckAll, /【注意力复测】/, 'scope=all 复测单应正常出')
  assert.ok(recheckAll.includes('第一章') || recheckAll.includes('第 1 章'), '应包含待复测章')
})

test('novel_desk_attention_fix 工具：chapters / all 参数与 limit=0', async (t) => {
  const { root, project } = await seededWideRoot(t, 4)
  const bundle = await store.getBundle(root, project.id)
  useTempRoot(t, root)
  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {}, get: () => undefined })
  const tool = tools.find((row) => row.name === 'novel_desk_attention_fix')
  assert.equal(tool.parameters.properties.chapters.type, 'array', '应支持 chapters 数组')
  assert.equal(tool.parameters.properties.chapters.items.type, 'integer', 'chapters 应是整数数组')
  assert.equal(tool.parameters.properties.all.type, 'boolean', '应支持 all 布尔参数')
  assert.equal(tool.parameters.properties.limit.minimum, 0, 'limit 允许 0（全部）')

  const allText = await tool.execute({ project: project.id, all: true })
  assert.match(allText, /全书 4 章/, 'all=true 应出全书批量工作单')
  const selectedText = await tool.execute({ project: project.id, chapters: [2, 1] })
  assert.match(selectedText, /自选 2 章/, 'chapters 自选应生效')
  assert.ok(selectedText.includes(chapterFile(root, bundle, 2, [2, 1])), '自选章应给正文文件路径')
  assert.ok(!selectedText.includes('第2章正文'), '自选章也不贴正文')
  const zeroLimit = await tool.execute({ project: project.id, limit: 0 })
  assert.match(zeroLimit, /全书 4 章/, 'limit=0 应等价全部')
})

