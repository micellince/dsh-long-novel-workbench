/**
 * 注意力一等账本（attention.json）+ 第 11 角色「注意力设计师」+ 冷读评分 prompt + 8 条确定性检查。
 * 覆盖 docs/ATTENTION.md 的 P0 后端部分：账本、Agent 权重与迁移、提案采纳、checks、prompt、context。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import { defaultAgents, attentionGenreProfiles } from '../lib/defaults.js'
import { runChecks } from '../lib/checks.js'
import { apply, buildHandoffPrompt, prepareReviewSandbox } from '../index.js'
import { makeRoot } from './helpers.js'

/** 把 process.env.STORY_DESK_ROOT 指向临时根（novel_desk_* 工具用 env 找根）。 */
function useTempRoot(t, root) {
  const previous = process.env.STORY_DESK_ROOT
  process.env.STORY_DESK_ROOT = root
  t.after(() => {
    if (previous === undefined) delete process.env.STORY_DESK_ROOT
    else process.env.STORY_DESK_ROOT = previous
  })
}

function chapter(id, overrides = {}) {
  return { id, title: `第 ${id} 章`, content: '正文。', characters: [], ...overrides }
}

function attentionRecord(chapterNumber, overrides = {}) {
  return {
    id: `att-${String(chapterNumber).padStart(4, '0')}`,
    chapter: chapterNumber,
    type: 'event',
    score: 70,
    designScore: 72,
    verdict: '会',
    weakest: 'cliff',
    dropRisk: '第 9 段：回忆插叙',
    hook: '开篇抛出问题',
    tension: '主角被逼选择',
    payoff: '身份暗示兑现一半',
    cliff: '门外是谁',
    question: '门外站着谁？',
    detail: '详细说明……',
    status: 'verified',
    ...overrides,
  }
}

/** 取某前缀的检查项。 */
function checksWith(checks, prefix) {
  return checks.filter((item) => String(item.id).startsWith(prefix))
}

async function readAttentionFile(root, projectId) {
  return JSON.parse(await readFile(join(root, 'projects', projectId, 'attention.json'), 'utf8'))
}

// ── 账本与 Agent ─────────────────────────────────────────────

test('新作品：attention 是一等账本，自动建空文件并进 bundle/stats', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '新作' })
  const bundle = await store.getBundle(root, project.id)

  assert.ok(store.KINDS.includes('attention'), 'KINDS 应包含 attention')
  assert.equal(store.KIND_FILES.attention, 'attention.json', 'attention 应落 attention.json')
  assert.deepEqual(await readAttentionFile(root, project.id), [], '新作品应自动建空的 attention.json')
  assert.deepEqual(bundle.attention, [], 'getBundle.attention 应是空数组')
  assert.equal(bundle.stats.attention, 0, 'getBundle.stats.attention 应是 0')
})

test('defaultAgents：12 条，weight 按契约（总编 9 / 独立审稿人 8 / 注意力设计师 10 / 去AI化审稿人 7 / 其余 3）', () => {
  const agents = defaultAgents()
  assert.equal(agents.length, 12, '默认分工应有 12 条')
  const byName = new Map(agents.map((agent) => [agent.name, agent]))
  assert.equal(byName.get('总编').weight, 9)
  assert.equal(byName.get('独立审稿人').weight, 8)
  assert.equal(byName.get('独立审稿人').special, 'fresh-read')
  const designer = byName.get('注意力设计师')
  assert.equal(designer.id, 'agent-11')
  assert.equal(designer.order, 11)
  assert.equal(designer.weight, 10, '注意力设计师权重最高')
  assert.equal(designer.special, 'attention-designer')
  const deai = byName.get('去AI化审稿人')
  assert.equal(deai.id, 'agent-12')
  assert.equal(deai.special, 'deai-reviewer')
  assert.equal(deai.weight, 7, '去 AI 化审稿人权重应为 7')
  for (const agent of agents) {
    if (['总编', '独立审稿人', '注意力设计师', '去AI化审稿人'].includes(agent.name)) continue
    assert.equal(agent.weight, 3, `${agent.name} 的默认权重应为 3`)
  }
})

test('老作品迁移：补第 11 角色 + 按 id 补 weight，幂等且不改已有字段/order', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '老作品' })
  const defaults = defaultAgents()
  // 模拟升级前的 10 条：无 weight、自定义 order 与作者备注
  const legacy = defaults.slice(0, 10).map((agent, index) => {
    const { weight, createdAt, updatedAt, ...rest } = agent
    return { ...rest, order: (index + 1) * 10, note: `作者备注 ${index + 1}` }
  })
  legacy[0].weight = 42 // 作者手工设过权重 → 迁移不得覆盖
  await writeFile(join(root, 'projects', project.id, 'agents.json'), JSON.stringify(legacy, null, 2), 'utf8')

  const first = await store.getBundle(root, project.id)
  assert.equal(first.agents.length, 12, '老作品应补到 12 条')
  for (let i = 0; i < 10; i += 1) {
    const row = first.agents[i]
    assert.equal(row.order, (i + 1) * 10, `第 ${i + 1} 条 order 不应被重排`)
    assert.equal(row.name, defaults[i].name, '已有角色名不应被改')
    assert.equal(row.duty, defaults[i].duty, '已有职责不应被改')
    assert.equal(row.note, `作者备注 ${i + 1}`, '作者备注应原样保留')
    assert.equal(row.weight, i === 0 ? 42 : defaults[i].weight, `第 ${i + 1} 条 weight 应补齐且不覆盖已有值`)
  }
  const designer = first.agents[10]
  assert.equal(designer.id, 'agent-11')
  assert.equal(designer.special, 'attention-designer')
  assert.equal(designer.order, 11)
  assert.equal(designer.weight, 10)
  const deai = first.agents.at(-1)
  assert.equal(deai.id, 'agent-12')
  assert.equal(deai.special, 'deai-reviewer')
  assert.equal(deai.order, 12)
  assert.equal(deai.weight, 7)

  // 幂等：重复 getBundle 不再追加、不改写
  const second = await store.getBundle(root, project.id)
  assert.equal(second.agents.length, 12, '重复迁移不应重复追加第 12 角色')
  assert.deepEqual(second.agents, first.agents, '重复迁移不应改写已有条目')
  assert.deepEqual(JSON.parse(await readFile(join(root, 'projects', project.id, 'agents.json'), 'utf8')), second.agents, '落盘应与读取一致')
})

test('attention 提案采纳：items 逐条写进 attention.json，返回 applied.attention', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '冷读作品' })
  const items = [
    { id: 'att-0001', chapter: 1, type: 'mystery', score: 72, designScore: 80, verdict: '会', weakest: 'tension', dropRisk: '第 9 段', hook: '钩子', tension: '张力', payoff: '回报', cliff: '章末问题', question: '谁在门外？', detail: '四拍体检……', status: 'verified', note: '' },
    { chapter: 2, type: 'emotion', score: 58, designScore: 62, verdict: '犹豫', weakest: 'payoff', dropRisk: '第 6 段', hook: '钩子', tension: '张力', payoff: '回报', cliff: '章末问题', question: '她会回头吗？', detail: '四拍体检……', status: 'verified', note: '' },
  ]
  const proposal = await store.createProposal(root, project.id, { kind: 'attention', title: '冷读评分', items })
  const result = await store.acceptProposal(root, project.id, proposal.id)

  assert.equal(result.applied.attention, 2, 'applied.attention 应等于采纳条数')
  assert.equal(result.proposal.status, 'accepted')
  const onDisk = await readAttentionFile(root, project.id)
  assert.equal(onDisk.length, 2, '两条 attention 记录应落账本')
  const first = onDisk.find((row) => row.id === 'att-0001')
  assert.equal(first.chapter, 1)
  assert.equal(first.type, 'mystery')
  assert.equal(first.score, 72)
  assert.equal(first.designScore, 80)
  assert.equal(first.weakest, 'tension')
  assert.ok(first.updatedAt, 'upsert 应补 updatedAt')
  const second = onDisk.find((row) => Number(row.chapter) === 2)
  assert.ok(second.id, '没有 id 的条目应由 upsert 生成 id')
})

// ── 8 条确定性检查 ───────────────────────────────────────────

test('checks：已写章节缺 attention 记录 → warn，只报有正文的章节', () => {
  const checks = runChecks({
    chapters: [chapter('0001'), chapter('0002', { content: '   ' })],
    attention: [],
  })
  const missing = checksWith(checks, 'attention-missing:')
  assert.equal(missing.length, 1, '只有第 1 章有正文，应只报一条')
  assert.equal(missing[0].id, 'attention-missing:0001')
  assert.equal(missing[0].level, 'warn')
  assert.match(missing[0].detail, /第 1 章/)
})

test('checks：attention 记录 cliff 为空 → warn；有 cliff 不报', () => {
  const bad = runChecks({
    chapters: [chapter('0001')],
    attention: [attentionRecord(1, { cliff: '' })],
  })
  assert.equal(checksWith(bad, 'attention-cliff:').length, 1, 'cliff 为空应报')
  const good = runChecks({
    chapters: [chapter('0001')],
    attention: [attentionRecord(1)],
  })
  assert.equal(checksWith(good, 'attention-cliff:').length, 0, 'cliff 有内容不应误报')
})

test('checks：同一 type 连续 >3 章 → warn；恰好 3 章不报', () => {
  const run = (count) => runChecks({
    chapters: Array.from({ length: count }, (_, i) => chapter(String(i + 1).padStart(4, '0'))),
    attention: Array.from({ length: count }, (_, i) => attentionRecord(i + 1, { type: 'emotion', designScore: 70 })),
  })
  const four = checksWith(run(4), 'attention-fatigue:')
  assert.equal(four.length, 1, '连续 4 章同类型应报一条疲劳')
  assert.equal(four[0].id, 'attention-fatigue:emotion:1-4')
  assert.equal(four[0].level, 'warn')
  assert.equal(checksWith(run(3), 'attention-fatigue:').length, 0, '恰好 3 章同类型不应报警')
})

test('checks：相邻章 score 下降 ≥15 → warn；降 14 分不报', () => {
  const run = (scores) => runChecks({
    chapters: scores.map((_, i) => chapter(String(i + 1).padStart(4, '0'))),
    attention: scores.map((score, i) => attentionRecord(i + 1, { score, designScore: score })),
  })
  const drop = checksWith(run([80, 60]), 'attention-drop:')
  assert.equal(drop.length, 1, '80 → 60 下降 20 分应报骤降')
  assert.equal(drop[0].id, 'attention-drop:1-2')
  assert.equal(checksWith(run([80, 66]), 'attention-drop:').length, 0, '80 → 66 只降 14 分不应报警')
})

test('checks：designScore 与 score 相差 ≥20 → warn；差 19 不报', () => {
  const run = (designScore) => runChecks({
    chapters: [chapter('0001')],
    attention: [attentionRecord(1, { score: 60, designScore })],
  })
  const gap = checksWith(run(80), 'attention-design-gap:')
  assert.equal(gap.length, 1, '设计 80 / 实测 60 应报设计未兑现')
  assert.equal(gap[0].id, 'attention-design-gap:1')
  assert.equal(checksWith(run(79), 'attention-design-gap:').length, 0, '相差 19 分不应报警')
})

test('checks：开篇前 3 章没有 event/mystery 型 → warn；有 event 不报', () => {
  const types = (list) => runChecks({
    chapters: list.map((_, i) => chapter(String(i + 1).padStart(4, '0'))),
    attention: list.map((type, i) => attentionRecord(i + 1, { type, designScore: 70 })),
  })
  const bad = checksWith(types(['emotion', 'language', 'relationship']), 'attention-opening')
  assert.equal(bad.length, 1, '开篇 3 章全是非事件/悬念型应报警')
  assert.equal(bad[0].level, 'warn')
  assert.equal(checksWith(types(['emotion', 'event', 'language']), 'attention-opening').length, 0, '开篇有 event 型不应报警')
})

test('checks：有实测分的章节平均 <60 → error；平均 ≥60 不报', () => {
  const run = (scores) => runChecks({
    chapters: scores.map((_, i) => chapter(String(i + 1).padStart(4, '0'))),
    attention: scores.map((score, i) => attentionRecord(i + 1, { score, designScore: score })),
  })
  const low = checksWith(run([50, 55]), 'attention-average-low')
  assert.equal(low.length, 1, '平均 52.5 分应报 error')
  assert.equal(low[0].level, 'error')
  assert.match(low[0].detail, /平均 52\.5/)
  assert.equal(checksWith(run([70, 80]), 'attention-average-low').length, 0, '平均 75 分不应报警')
  assert.equal(checksWith(run([null, null]), 'attention-average-low').length, 0, '没有实测分不应报平均分')
})

test('checks：冷读跑过但 score 为空 → info；planned 不算', () => {
  const run = (status) => runChecks({
    chapters: [chapter('0001')],
    attention: [attentionRecord(1, { score: null, status })],
  })
  assert.equal(checksWith(run('verified'), 'attention-unscored:').length, 1, 'verified 但无实测分应 info 提醒回填')
  assert.equal(checksWith(run('planned'), 'attention-unscored:').length, 0, 'planned 设计记录没有实测分是正常的')
})

test('checks：干净账本不误报任何 attention-* 规则', () => {
  const checks = runChecks({
    chapters: [chapter('0001'), chapter('0002'), chapter('0003')],
    attention: [
      attentionRecord(1, { type: 'event', score: 72, designScore: 74 }),
      attentionRecord(2, { type: 'mystery', score: 68, designScore: 70 }),
      attentionRecord(3, { type: 'event', score: 75, designScore: 74 }),
    ],
  })
  assert.deepEqual(checksWith(checks, 'attention-'), [], '合法账本不应触犯任何注意力规则')
})

// ── 冷读 prompt / 下一章工作单 / 上下文 ──────────────────────

test('fresh-read 单章 prompt：含类型化 0-100 评分与 kind=attention，只提交实测字段且零账本污染', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '武侠首读', genre: '武侠' })
  const content = '第一章正文：雪夜，少年推门。\n门外落雪，风把灯笼吹得直晃。'
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章 推门', content })
  // 账本里放一条敏感 detail，验证零上下文 prompt 不会把它带进去
  await store.upsertEntity(root, project.id, 'attention', {
    chapter: 1, type: 'mystery', score: 88, detail: '账本里的详细说明', question: '账本问题', status: 'verified',
  })
  const bundle = await store.getBundle(root, project.id)
  const prompt = buildHandoffPrompt(bundle, { task: 'fresh-read', chapter: 1 })

  assert.equal(prompt.split('\n')[0], '零上下文首读：只读这一章正文（自己用 read 工具读章节文件，不要读工作台、不要查设定/大纲/人物卡）。')
  assert.match(prompt, /本作类型：武侠/, '应按 project.genre 写类型')
  assert.match(prompt, /0-100/, '应要求 0-100 总分')
  assert.match(prompt, /kind=attention/, '应要求用 kind=attention 提交')
  assert.match(prompt, /爽感兑现/, '应带武侠类型读者预期')
  for (const part of ['chapter/score/breakdown/dropPoints/verdict/weakest/dropRisk/detail', '会不会读下一章 verdict（会/犹豫/不会）', '一个弃读点（段落位置）', 'kind=attention-fix', '四拍分数 breakdown']) {
    assert.ok(prompt.includes(part), `评分要求应包含「${part}」`)
  }
  assert.ok(!prompt.includes('chapter/type/score'), '冷读只提交实测字段，不应包含 type')
  assert.match(prompt, /钩子\/张力\/回报\/章末牵引的设计归注意力设计师/, '应写明设计字段归注意力设计师')
  assert.match(prompt, /不要写这些字段/, '应明确禁止写设计字段')
  const dir = join(prepareReviewSandbox(root, bundle, [1]).dir, 'chapters')
  assert.ok(prompt.includes(join(dir, '0001.md')), '应给正文文件路径')
  assert.ok(!prompt.includes(content), '不应内联正文（让 AI 自己 read）')
  assert.ok(prompt.endsWith(join(dir, '0001.md')), 'prompt 应以正文文件路径结束')
  for (const polluted of ['工作台交接', '进度：', 'attention.json', '账本里的详细说明', '账本问题', '待处理提案', '写作预设']) {
    assert.ok(!prompt.includes(polluted), `零上下文 prompt 不应出现污染「${polluted}」`)
  }
})

test('fresh-read 未知类型：用通用 5 条读者预期；全书模式要求逐章「第N章 78」', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '玄幻作品', genre: '玄幻' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '一。' })
  await store.saveChapter(root, project.id, { id: '0002', title: '第二章', content: '二。' })
  const bundle = await store.getBundle(root, project.id)

  const single = buildHandoffPrompt(bundle, { task: 'fresh-read', chapter: 1 })
  assert.match(single, /本作类型：玄幻/)
  assert.match(single, /开篇是否快速抛出钩子/, '未知类型应使用通用读者预期')
  assert.doesNotMatch(single, /爽感兑现/, '未知类型不应套用武侠预期')

  const book = buildHandoffPrompt(bundle, { task: 'fresh-read', scope: 'book' })
  assert.match(book, /0-100/, '全书模式应要求 0-100 分')
  assert.ok(book.includes('「第N章 78」'), '全书模式应规定「第N章 78」格式')
  assert.match(book, /kind=attention/, '全书模式应要求提交 attention 提案')
  assert.ok(book.includes('只写实测字段：chapter/score/breakdown/dropPoints/verdict/weakest/dropRisk/detail'), '全书模式只提交实测字段')
  assert.ok(book.includes('kind=attention-fix'), '全书模式应在打分后直接产提分方案（段落补丁）')
  assert.ok(!book.includes('chapter/type/score'), '全书模式不应要求提交 type')
  assert.match(book, /设计归注意力设计师/, '全书模式应写明设计归设计师')
  assert.match(book, /12 行内全书综合意见/, '原有全书综合意见要求应保留')
})

test('fresh-read 分批模式：子 Agent 返回每章分数+理由，主会话汇总 attention 提案', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '大部头', genre: '推理' })
  const big = '雪'.repeat(60000)
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: big })
  await store.saveChapter(root, project.id, { id: '0002', title: '第二章', content: big })
  const bundle = await store.getBundle(root, project.id)
  const prompt = buildHandoffPrompt(bundle, { task: 'fresh-read', scope: 'book' })

  assert.match(prompt, /一次读不完，按下面的章节清单分批读/)
  assert.match(prompt, /本作类型：推理/)
  assert.match(prompt, /谜面能否勾住读者/, '应带推理类型读者预期')
  assert.match(prompt, /每个子 Agent 除首读意见外/, '应要求子 Agent 返回每章分数')
  assert.match(prompt, /0-100/)
  assert.match(prompt, /一句理由/)
  assert.match(prompt, /kind=attention/)
  assert.ok(prompt.includes('只写实测字段：chapter/score/breakdown/dropPoints/verdict/weakest/dropRisk/detail'), '分批模式只提交实测字段')
  assert.ok(prompt.includes('kind=attention-fix'), '分批模式应要求主会话汇总后产出提分方案')
  assert.match(prompt, /设计归注意力设计师/, '分批模式应写明设计归设计师')
  assert.ok(!prompt.includes(big), '分批工作单不应塞正文')
  assert.ok(prompt.length < 5000, `分批工作单应保持简短，实际 ${prompt.length} 字符`)
})

test('novel_desk_context：注意力段（最近 6 章/未标数/平均分）与角色权重', async (t) => {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name: '上下文作品', genre: '悬疑' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '正文一。' })
  await store.saveChapter(root, project.id, { id: '0002', title: '第二章', content: '正文二。' })
  await store.saveChapter(root, project.id, { id: '0003', title: '第三章', content: '正文三。' })
  await store.upsertEntity(root, project.id, 'attention', {
    chapter: 1, type: 'mystery', score: 72, designScore: 80, verdict: '会', weakest: 'cliff', cliff: '门外是谁', question: '门外站着谁？', status: 'verified',
  })
  await store.upsertEntity(root, project.id, 'attention', {
    chapter: 2, type: 'emotion', score: 58, designScore: 62, verdict: '犹豫', weakest: 'tension', cliff: '她在想什么', detail: '详细说明。', status: 'verified',
  })

  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {}, get: () => undefined })
  const contextTool = tools.find((tool) => tool.name === 'novel_desk_context')
  const bundleTool = tools.find((tool) => tool.name === 'novel_desk_bundle')
  const planTool = tools.find((tool) => tool.name === 'novel_desk_plan')
  const proposeTool = tools.find((tool) => tool.name === 'novel_desk_propose')
  const upsertTool = tools.find((tool) => tool.name === 'novel_desk_upsert')
  assert.ok(contextTool && bundleTool && planTool && proposeTool && upsertTool, 'apply 应注册相关工具')

  const contextText = await contextTool.execute({ project: project.id, recent: 0 })
  assert.match(contextText, /## 注意力（100 分制）/, 'novel_desk_context 应输出注意力段')
  assert.match(contextText, /全书平均分：65（2 章有实测分）/, '应输出 100 分制全书平均分')
  assert.match(contextText, /未标注意力：1 章已写章节/, '第 3 章有正文但未标，应计 1 章')
  assert.match(contextText, /第1章 72分\/mystery｜门外站着谁？/, '最近章应带分数/类型/一句话')
  assert.match(contextText, /第2章 58分\/emotion/, '应列出已有记录')
  assert.match(contextText, /注意力设计师（权重 10）：/, 'Agent 列表应带权重文字')

  const attentionText = await bundleTool.execute({ project: project.id, kind: 'attention' })
  assert.match(attentionText, /## 注意力（2）/, 'bundle(kind=attention) 应列出 2 条记录')
  assert.match(attentionText, /实测 72 \/ 设计 80/, '注意力列表应显示实测分与设计分')
  assert.match(proposeTool.description, /设计师写 design 字段、独立审稿人写实测字段，按 chapter 合并/, 'propose 工具描述应写清职责拆分')

  for (const tool of [bundleTool, proposeTool, upsertTool]) {
    assert.ok(tool.parameters.properties.kind.enum.includes('attention'), `${tool.name} 的 kind 枚举应包含 attention`)
  }
})

test('novel_desk_plan：工作单要求先定本章注意力设计（四拍 + designScore），plan JSON 带 data.attention', async (t) => {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name: '工作单作品' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '正文。' })
  await store.upsertEntity(root, project.id, 'attention', attentionRecord(1, { weakest: 'payoff' }))

  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {}, get: () => undefined })
  const planTool = tools.find((tool) => tool.name === 'novel_desk_plan')
  const planText = await planTool.execute({ project: project.id, chapter: 2 })

  assert.match(planText, /先定本章注意力设计：type\/hook\/tension\/payoff\/cliff\/question\/designScore，再写情节节拍/)
  assert.match(planText, /上一章注意力：第1章 70分\/event；最弱一环：payoff/)
  assert.match(planText, /kind="attention"/, '应给出 attention 提案提交方式')
  assert.match(planText, /data\.attention/, '应要求 plan 提案里也带 attention 设计')
  assert.match(planText, /"attention":\{"type":"","hook":"","tension":"","payoff":"","cliff":"","question":"","designScore":0/, '工作单 JSON 模板应包含 attention 设计对象')
})

test('采纳 plan 提案时 data.attention 自动补进注意力账本', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '方案带设计' })
  const proposal = await store.createProposal(root, project.id, {
    kind: 'plan',
    chapter: 2,
    title: '第二章方案',
    data: {
      title: '第二章',
      summary: '本章摘要',
      attention: { chapter: 2, type: 'mystery', hook: '雪地脚印', tension: '被追踪', payoff: '认出仇人', cliff: '谁在背后', question: '谁在追踪他？', designScore: 78, status: 'planned' },
      events: [],
      facts: [],
      foreshadow: [],
      characters: [],
    },
  })
  const result = await store.acceptProposal(root, project.id, proposal.id)
  assert.equal(result.applied.attention, 1, 'plan 提案里的 attention 设计应被采纳')
  const rows = await store.getEntities(root, project.id, 'attention')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].chapter, 2)
  assert.equal(rows[0].type, 'mystery')
  assert.equal(rows[0].designScore, 78)
})

// ── 职责拆分：设计师出设计 / 独立审稿人只出实测，按 chapter 合并 ──

test('attention 提案按 chapter 合并：设计 + 实测两次采纳只留一条，字段互补', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '合并作品' })
  const design = await store.createProposal(root, project.id, {
    kind: 'attention',
    title: '注意力设计',
    items: [{ chapter: 3, type: 'mystery', hook: '开篇抛出信物', tension: '主角被逼选边', payoff: '身份暗示兑现一半', cliff: '门外是谁', question: '门外站着谁？', designScore: 80, status: 'planned' }],
  })
  const first = await store.acceptProposal(root, project.id, design.id)
  assert.equal(first.applied.attention, 1)
  let rows = await store.getEntities(root, project.id, 'attention')
  assert.equal(rows.length, 1)
  const designId = rows[0].id
  assert.ok(designId, '设计记录应由 upsert 生成 id')

  const measured = await store.createProposal(root, project.id, {
    kind: 'attention',
    title: '冷读实测',
    items: [{ chapter: 3, score: 72, verdict: '会', weakest: 'tension', dropRisk: '第 9 段回忆插叙', detail: '四拍体检……', status: 'verified' }],
  })
  const second = await store.acceptProposal(root, project.id, measured.id)
  assert.equal(second.applied.attention, 1)
  rows = await store.getEntities(root, project.id, 'attention')
  assert.equal(rows.length, 1, '同 chapter 的设计与实测应合并成同一条记录')
  const row = rows[0]
  assert.equal(row.id, designId, '实测没有 id 时应按 chapter 复用设计记录的 id')
  for (const [key, value] of Object.entries({ score: 72, verdict: '会', weakest: 'tension', detail: '四拍体检……' })) {
    assert.equal(row[key], value, `实测字段 ${key} 应写入`)
  }
  for (const [key, value] of Object.entries({ type: 'mystery', hook: '开篇抛出信物', tension: '主角被逼选边', payoff: '身份暗示兑现一半', cliff: '门外是谁', question: '门外站着谁？', designScore: 80 })) {
    assert.equal(row[key], value, `设计字段 ${key} 不应被实测覆盖`)
  }
})

test('attention 合并：实测里的空字符串/null 字段被忽略，不清空已有设计', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '空字段合并' })
  await store.upsertEntity(root, project.id, 'attention', {
    chapter: 2, type: 'mystery', hook: '原有钩子', tension: '原有张力', payoff: '原有回报', cliff: '原有章末问题', question: '原有问题', designScore: 80, detail: '原有详细说明', status: 'planned',
  })
  const proposal = await store.createProposal(root, project.id, {
    kind: 'attention',
    title: '冷读实测（带空字段）',
    items: [{ chapter: 2, score: 61, verdict: '犹豫', type: '', hook: null, designScore: null, detail: '', weakest: 'payoff' }],
  })
  await store.acceptProposal(root, project.id, proposal.id)
  const rows = await store.getEntities(root, project.id, 'attention')
  assert.equal(rows.length, 1, '同 chapter 不应新增记录')
  const row = rows[0]
  assert.equal(row.score, 61, '实测分应写入')
  assert.equal(row.verdict, '犹豫')
  assert.equal(row.weakest, 'payoff')
  assert.equal(row.type, 'mystery', '空字符串 type 不应清空已有设计类型')
  assert.equal(row.hook, '原有钩子', 'null hook 不应清空已有设计')
  assert.equal(row.designScore, 80, 'null designScore 不应清空已有设计分')
  assert.equal(row.detail, '原有详细说明', '空字符串 detail 不应清空已有说明')
})

test('attention-design 清单任务：只补 design 字段、明确禁止打分和改正文', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '补设计作品' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '正文。' })
  const bundle = await store.getBundle(root, project.id)

  // 清单入口（client.js 的「AI 补齐注意力机制」任务项）
  const prompt = buildHandoffPrompt(bundle, {
    items: [{ kind: 'task', id: 'attention-design', task: 'attention-design', title: 'AI 补齐注意力机制（逐章设计）' }],
  })
  for (const part of [
    '为已写章节补「注意力设计」（不是打分）',
    'chapter/type/hook/tension/payoff/cliff/question/designScore/status="planned"',
    '读正文 + outlines + foreshadow/conflicts/highlights 作为素材',
    '章末必须给出未决问题',
    '同类型不要连续超 3 章',
    'subagent 分批',
    '不要打 score（留给独立审稿人）',
    '不要改正文',
  ]) {
    assert.ok(prompt.includes(part), `attention-design prompt 应包含「${part}」`)
  }
  assert.ok(prompt.includes('kind=attention'), '应要求提交 attention 提案')
  assert.ok(prompt.includes('AI 补齐注意力机制（逐章设计）'), '应带清单任务标题')

  // 直接 task 入口（便于以后加按钮）
  const direct = buildHandoffPrompt(bundle, { task: 'attention-design' })
  assert.ok(direct.includes('为已写章节补「注意力设计」（不是打分）'), '直接 task 也应产出设计任务段')
  assert.ok(direct.includes('不要打 score（留给独立审稿人）'))
  assert.ok(direct.includes('AI 补齐注意力机制（逐章设计）'), '直接 task 应带 TASK_LABEL 文案')
})

test('生成流程：enrich-outlines / import-review / next-chapter-plan 都要求先产注意力设计', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '生成流程' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '正文。' })
  const bundle = await store.getBundle(root, project.id)

  const enrich = buildHandoffPrompt(bundle, {
    items: [{ kind: 'task', id: 'enrich-outlines-1', task: 'enrich-outlines', title: 'AI 补全章节大纲' }],
  })
  assert.ok(enrich.includes('每章大纲同时给 attention 设计'), 'enrich-outlines 应要求同时给注意力设计')
  assert.match(enrich, /type\/hook\/tension\/payoff\/cliff\/question\/designScore/)
  assert.ok(enrich.includes('kind=attention'))

  const importReviewDirect = buildHandoffPrompt(bundle, { task: 'import-review' })
  assert.ok(importReviewDirect.includes('补齐注意力设计'), 'import-review（直接 task）应要求补齐注意力设计')
  const importReviewItem = buildHandoffPrompt(bundle, {
    items: [{ kind: 'task', id: 'import-review-1', task: 'import-review', title: '导入后审阅' }],
  })
  assert.ok(importReviewItem.includes('补齐注意力设计'), 'import-review（清单项）应要求补齐注意力设计')

  const nextPlan = buildHandoffPrompt(bundle, { task: 'next-chapter-plan' })
  assert.ok(nextPlan.includes('第一优先级：读取大纲和最近章节，先提交本章 attention 设计（planned'), '下一章方案应先提交 attention 设计')
  const continueChapter = buildHandoffPrompt(bundle, { task: 'continue-chapter' })
  assert.ok(continueChapter.includes('第一优先级：先提交本章 attention 设计（planned'), '续写章节应先提交 attention 设计')
})

test('attentionGenreProfiles：六套类型 + 通用，每套 4-6 条', () => {
  const profiles = attentionGenreProfiles()
  for (const genre of ['武侠', '推理', '科幻', '言情', '文学', '悬疑']) {
    assert.ok(Array.isArray(profiles[genre]), `应内置「${genre}」类型`)
    assert.ok(profiles[genre].length >= 4 && profiles[genre].length <= 6, `${genre} 应有 4-6 条读者预期`)
  }
  assert.equal(profiles['通用'].length, 5, '通用兜底应为 5 条')
})
