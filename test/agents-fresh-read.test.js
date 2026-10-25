/**
 * 第 10 个角色「独立审稿人（零上下文首读）」+ fresh-read 最小 prompt。
 * 覆盖：默认分工 10 条、老作品幂等迁移、buildHandoffPrompt 零上下文输出、
 * 多 Agent 派单过滤，以及 bundle/context 里「勿带账本」标注。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import { defaultAgents } from '../lib/defaults.js'
import { apply, buildHandoffPrompt, prepareReviewSandbox } from '../index.js'
import { makeRoot } from './helpers.js'

const FRESH_READ_NAME = '独立审稿人'

/** 把 process.env.STORY_DESK_ROOT 指向临时根（novel_desk_* 工具用 env 找根）。 */
function useTempRoot(t, root) {
  const previous = process.env.STORY_DESK_ROOT
  process.env.STORY_DESK_ROOT = root
  t.after(() => {
    if (previous === undefined) delete process.env.STORY_DESK_ROOT
    else process.env.STORY_DESK_ROOT = previous
  })
}

/** 手工写一份老作品的 agents.json（模拟升级前只有 9 条）。 */
async function writeLegacyAgents(root, projectId, agents) {
  const path = join(root, 'projects', projectId, 'agents.json')
  await writeFile(path, JSON.stringify(agents, null, 2), 'utf8')
  return path
}

async function readAgentsFile(root, projectId) {
  return JSON.parse(await readFile(join(root, 'projects', projectId, 'agents.json'), 'utf8'))
}

/** 9 条手工分工：故意带自定义字段、自定义 order、禁用项，验证迁移不覆盖。 */
function legacyAgents() {
  return Array.from({ length: 9 }, (_, i) => ({
    id: `legacy-${i + 1}`,
    order: (i + 1) * 10, // 故意不是 1..9，验证不重排
    name: `旧角色${i + 1}`,
    duty: `旧职责${i + 1}`,
    inputs: '作者自己的输入口径',
    outputs: '作者自己的输出口径',
    enabled: i !== 2,
    作者备注: `别动我 ${i + 1}`,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-02-02T00:00:00.000Z',
  }))
}

test('defaultAgents：默认 12 条，第 10 条是 special=fresh-read 的独立审稿人，第 11 条是注意力设计师，第 12 条是去 AI 化审稿人', () => {
  const agents = defaultAgents()
  assert.equal(agents.length, 12, '默认分工应有 12 条')
  assert.deepEqual(agents.slice(0, 9).map((a) => a.special), Array(9).fill(undefined), '前 9 个角色不应带 special')
  const freshRead = agents[9]
  assert.equal(freshRead.id, 'agent-10')
  assert.equal(freshRead.order, 10)
  assert.equal(freshRead.name, FRESH_READ_NAME)
  assert.equal(freshRead.special, 'fresh-read', 'UI 高亮与派单过滤依赖 special=fresh-read')
  assert.equal(freshRead.weight, 8, '独立审稿人权重应为 8')
  assert.equal(freshRead.enabled, true)
  assert.equal(freshRead.inputs, '单章正文（不带任何其他上下文）')
  assert.match(freshRead.outputs, /首读审稿/)
  const designer = agents[10]
  assert.equal(designer.id, 'agent-11')
  assert.equal(designer.order, 11)
  assert.equal(designer.name, '注意力设计师')
  assert.equal(designer.special, 'attention-designer')
  assert.equal(designer.weight, 10, '注意力设计师权重最高，应为 10')
  const deai = agents[11]
  assert.equal(deai.id, 'agent-12')
  assert.equal(deai.order, 12)
  assert.equal(deai.name, '去AI化审稿人')
  assert.equal(deai.special, 'deai-reviewer', 'UI 派单与审计联动依赖 special=deai-reviewer')
  assert.equal(deai.weight, 7, '去 AI 化审稿人权重应为 7')
})

test('新建作品：agents 落盘 12 条，第 10 条带 special=fresh-read，第 11 条注意力设计师，第 12 条去 AI 化审稿人', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '新作品' })
  const bundle = await store.getBundle(root, project.id)

  assert.equal(bundle.agents.length, 12, '新建作品应有 12 个 Agent')
  const freshRead = bundle.agents[9]
  assert.equal(freshRead.id, 'agent-10')
  assert.equal(freshRead.order, 10)
  assert.equal(freshRead.name, FRESH_READ_NAME)
  assert.equal(freshRead.special, 'fresh-read')
  assert.equal(freshRead.enabled, true)
  assert.ok(!Number.isNaN(Date.parse(freshRead.createdAt)), '迁移项应带可解析的 createdAt')
  assert.ok(!Number.isNaN(Date.parse(freshRead.updatedAt)), '迁移项应带可解析的 updatedAt')
  const designer = bundle.agents[10]
  assert.equal(designer.id, 'agent-11')
  assert.equal(designer.order, 11)
  assert.equal(designer.name, '注意力设计师')
  assert.equal(designer.special, 'attention-designer')
  assert.equal(designer.weight, 10)
  const last = bundle.agents.at(-1)
  assert.equal(last.id, 'agent-12')
  assert.equal(last.order, 12)
  assert.equal(last.special, 'deai-reviewer')
  assert.equal(last.weight, 7)
  assert.ok(!Number.isNaN(Date.parse(last.createdAt)), '第 12 角色应带可解析的 createdAt')
  assert.ok(!Number.isNaN(Date.parse(last.updatedAt)), '第 12 角色应带可解析的 updatedAt')
})

test('老作品迁移：只有 9 条时自动补第 10、11、12 条，不改已有内容、不重排、幂等', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '老作品' })
  const legacy = legacyAgents()
  await writeLegacyAgents(root, project.id, legacy)

  const first = await store.getBundle(root, project.id)
  assert.equal(first.agents.length, 12, '老作品应被补到 12 条')
  assert.deepEqual(first.agents.slice(0, 9), legacy, '已有 9 条必须原样保留（字段、order、作者备注都不动）')
  const added = first.agents.slice(9)
  assert.deepEqual(added.map((agent) => agent.special), ['fresh-read', 'attention-designer', 'deai-reviewer'], '新增的依次是独立审稿人、注意力设计师与去 AI 化审稿人')
  assert.equal(added[0].id, 'agent-10')
  assert.equal(added[1].id, 'agent-11')
  assert.equal(added[1].weight, 10)
  assert.equal(added[2].id, 'agent-12')
  assert.equal(added[2].weight, 7)

  // 重复调用不重复追加
  const second = await store.getBundle(root, project.id)
  assert.equal(second.agents.length, 12, '重复 ensureProjectSkeleton/getBundle 不应重复追加')
  assert.deepEqual(second.agents.slice(0, 9), legacy, '重复迁移不应改写已有条目')
  assert.deepEqual(await readAgentsFile(root, project.id), second.agents, '落盘结果应与读取结果一致')
})

test('老作品迁移：已有同名或已有 special 记录时不追加', async (t) => {
  const root = await makeRoot(t)

  // 情形一：作者自己建过同名「独立审稿人」，但没有 special 标记 → 保留作者版本
  const byName = await store.createProject(root, { name: '作者自建同名' })
  const custom = [...legacyAgents(), { id: 'custom-reader', order: 99, name: FRESH_READ_NAME, duty: '作者自己写的首读口径', enabled: true }]
  await writeLegacyAgents(root, byName.id, custom)
  const bundleByName = await store.getBundle(root, byName.id)
  assert.equal(bundleByName.agents.length, 12, '已有同名记录时只补注意力设计师与去 AI 化审稿人')
  assert.deepEqual(bundleByName.agents[9], custom.at(-1), '作者自己写的同角色记录不应被覆盖')
  assert.deepEqual(bundleByName.agents.slice(10).map((agent) => agent.special), ['attention-designer', 'deai-reviewer'], '仍应补第 11、12 角色')

  // 情形二：已有 special=fresh-read（名字被作者改过）→ 也不重复追加
  const bySpecial = await store.createProject(root, { name: '已有标记' })
  const marked = [...legacyAgents(), { id: 'reader-x', order: 88, name: '冷读员', duty: '首读', special: 'fresh-read', enabled: true }]
  await writeLegacyAgents(root, bySpecial.id, marked)
  const bundleBySpecial = await store.getBundle(root, bySpecial.id)
  assert.equal(bundleBySpecial.agents.length, 12, '已有 special=fresh-read 时只补注意力设计师与去 AI 化审稿人')
  assert.equal(bundleBySpecial.agents[9].id, 'reader-x', '已有标记的角色应保留')
  assert.deepEqual(bundleBySpecial.agents.slice(10).map((agent) => agent.special), ['attention-designer', 'deai-reviewer'])
})

test('fresh-read prompt：只给单章正文文件路径与指令，不含正文/交接/账本/预设污染', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '首读测试' })
  const firstContent = '第一章正文：少年推门。\n门外落雪，风把灯笼吹得直晃。'
  const secondContent = '第二章正文：他回头，看见雪地里一排脚印。'
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章 推门', content: firstContent })
  await store.saveChapter(root, project.id, { id: '0002', title: '第二章 回头', content: secondContent })
  const bundle = await store.getBundle(root, project.id)

  const prompt = buildHandoffPrompt(bundle, { task: 'fresh-read', chapter: 1 }, '/不该出现的工作区')
  const lines = prompt.split('\n')
  const dir = join(prepareReviewSandbox(root, bundle, [1]).dir, 'chapters')
  assert.equal(lines[0], '零上下文首读：只读这一章正文（自己用 read 工具读章节文件，不要读工作台、不要查设定/大纲/人物卡）。', '第一行应是固定的零上下文指令')
  assert.ok(prompt.includes(join(dir, '0001.md')), '应给出目标章正文文件的绝对路径')
  assert.ok(!prompt.includes(firstContent), 'prompt 不应内联正文（让 AI 自己 read）')
  assert.ok(!prompt.includes(secondContent), 'prompt 不应带其他章节正文')
  assert.ok(prompt.includes('project=' + project.id + ', chapter=1, dimension=首读'), '审稿指令应带 project/chapter/dimension')
  assert.ok(prompt.includes('第 1 章《第一章 推门》'), '正文前应有章号与标题')
  assert.ok(prompt.endsWith(join(dir, '0001.md')), 'prompt 应以正文文件路径结束，不再追加任何工作台说明')

  for (const polluted of ['工作台交接', '事实', '进度', 'Agent', '写作预设', '风格规则', '禁忌', '待处理提案', '/不该出现的工作区']) {
    assert.ok(!prompt.includes(polluted), `零上下文 prompt 不应出现污染词「${polluted}」`)
  }
})

test('fresh-read：未指定章号取最大章号；章节不存在或无章节时报清楚错误', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '多章作品' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '一' })
  await store.saveChapter(root, project.id, { id: '0003', title: '第三章', content: '三' })
  await store.saveChapter(root, project.id, { id: '0002', title: '第二章', content: '二' })
  const bundle = await store.getBundle(root, project.id)

  const prompt = buildHandoffPrompt(bundle, { task: 'fresh-read' })
  assert.ok(prompt.includes('第 3 章《第三章》'), '未指定章号应取最大章号')
  const sandbox = prepareReviewSandbox(root, bundle, [3])
  assert.ok(prompt.includes(join(sandbox.dir, 'chapters', '0003.md')), '应给最大章正文文件路径')

  assert.throws(() => buildHandoffPrompt(bundle, { task: 'fresh-read', chapter: 9 }), /没有可首读的章节/, '指定不存在的章应报清楚错误')

  const empty = await store.createProject(root, { name: '空作品' })
  const emptyBundle = await store.getBundle(root, empty.id)
  assert.throws(() => buildHandoffPrompt(emptyBundle, { task: 'fresh-read' }), /没有可首读的章节/, '没有章节时应报清楚错误')
})

test('多 Agent 派单：过滤独立审稿人、按权重降序、注意力设计师排最前', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '派单作品' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '正文。' })
  const bundle = await store.getBundle(root, project.id)

  const prompt = buildHandoffPrompt(bundle, { task: 'full-review', multiAgent: true })
  assert.ok(prompt.includes('本项目启用多 Agent 分工（11 个角色，按权重降序）'), '12 个角色里派单应只列 11 个（独立审稿人除外）')
  assert.ok(prompt.includes('独立审稿人只做零上下文首读，不带账本上下文，不在本批次派单。'), '应补一行不派单说明')
  const numbered = prompt.split('\n').filter((line) => /^\d+\. /.test(line))
  assert.ok(numbered.length >= 11, '应有 11 个派单角色')
  assert.ok(!numbered.some((line) => line.includes(FRESH_READ_NAME)), '派单编号列表里不应出现独立审稿人')
  assert.match(prompt, /1\. 注意力设计师（权重 10）：/, '权重最高的注意力设计师应排在第 1 位')
  assert.match(prompt, /2\. 总编（权重 9）：/, '总编权重 9 应排第 2')
})

test('novel_desk_bundle / novel_desk_context：保留第 10 角色并标注「勿带账本」，上下文带权重', async (t) => {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name: '标注作品' })

  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {}, get: () => undefined })
  const bundleTool = tools.find((tool) => tool.name === 'novel_desk_bundle')
  const contextTool = tools.find((tool) => tool.name === 'novel_desk_context')
  assert.ok(bundleTool && contextTool, 'apply 应注册 bundle/context 工具')

  const agentsText = await bundleTool.execute({ project: project.id, kind: 'agents' })
  assert.match(agentsText, /Agent 分工（12）/, 'bundle(kind=agents) 应列出 12 个角色')
  assert.match(agentsText, /独立审稿人：.*（零上下文首读，勿带账本）/, '第 10 角色行末应有勿带账本标注')

  const contextText = await contextTool.execute({ project: project.id, recent: 0 })
  assert.match(contextText, /独立审稿人（权重 8）：.*（零上下文首读，勿带账本）/, 'novel_desk_context 的 Agent 分工应保留并标注第 10 角色')
  assert.match(contextText, /注意力设计师（权重 10）：/, '上下文 Agent 分工应带权重文字')
  assert.match(contextTool.description, /12 个 Agent 分工/, 'novel_desk_context 描述应改为 12 个 Agent')
})

test('scope=book 且整本不大：prompt 带章目与文件路径，不内联正文', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '短篇全集' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '开头第一段。' })
  await store.saveChapter(root, project.id, { id: '0002', title: '第二章', content: '结尾第二段。' })
  const bundle = await store.getBundle(root, project.id)

  const prompt = buildHandoffPrompt(bundle, { task: 'fresh-read', scope: 'book' })
  const dir = join(prepareReviewSandbox(root, bundle, null).dir, 'chapters')
  assert.match(prompt.split('\n')[0], /零上下文首读（全书）/, '全书首读应有自己的首行')
  assert.ok(prompt.indexOf(join(dir, '0001.md')) < prompt.indexOf(join(dir, '0002.md')), '章节文件应按章号顺序排列')
  assert.ok(prompt.includes('第 1 章《第一章》'))
  assert.ok(prompt.includes('第 2 章《第二章》'))
  assert.ok(!prompt.includes('开头第一段。'), '不应内联正文（让 AI 自己 read 文件）')
  assert.ok(!prompt.includes('结尾第二段。'), '不应内联正文（让 AI 自己 read 文件）')
  assert.match(prompt, /按章号顺序逐章 read/, '整本不大时应要求逐章 read 文件')
  assert.ok(prompt.includes('12 行内全书综合意见'), '应要求全书综合意见')
  for (const polluted of ['工作台交接', '进度：', 'Agent', '写作预设', '待处理提案']) {
    assert.ok(!prompt.includes(polluted), '全书首读 prompt 不应出现污染词「' + polluted + '」')
  }
})

test('scope=book 且整本太大：改成分批工作单，只给章目与文件路径，不塞正文', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '大部头' })
  const big = '雪'.repeat(60000) // 60,000 字/章 × 2 超过 4 万字分批阈值
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: big })
  await store.saveChapter(root, project.id, { id: '0002', title: '第二章', content: big })
  const bundle = await store.getBundle(root, project.id)

  const prompt = buildHandoffPrompt(bundle, { task: 'fresh-read', scope: 'book' })
  assert.match(prompt, /一次读不完，按下面的章节清单分批读/, '超长全书应转成分批工作单')
  assert.ok(!prompt.includes(big), '不应把 6 万字正文整段塞进工作单')
  assert.ok(prompt.length < 4000, `工作单应保持简短，实际 ${prompt.length} 字符`)
  const dir = join(prepareReviewSandbox(root, bundle, null).dir, 'chapters')
  assert.ok(prompt.includes(join(dir, '0001.md')), '应给出第 1 章正文文件的绝对路径')
  assert.ok(prompt.includes(join(dir, '0002.md')), '应给出第 2 章正文文件的绝对路径')
  assert.match(prompt, /第 1 章《第一章》｜60000 字/, '章目应带章号、标题与字数')
  assert.match(prompt, /subagent/, '应指示用子 Agent 分批读')
  assert.match(prompt, /不要读事实账本/, '应明确不许读账本')
  assert.doesNotMatch(prompt, /工作台交接/, '工作单里不能再出现常规交接头')
})

test('scope 缺省=chapter；非法 scope 也退回单章，不报错', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '默认单章' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '正文。' })
  const bundle = await store.getBundle(root, project.id)

  for (const body of [{ task: 'fresh-read' }, { task: 'fresh-read', scope: 'nonsense' }]) {
    const prompt = buildHandoffPrompt(bundle, body)
    assert.match(prompt.split('\n')[0], /^零上下文首读：只读这一章正文/, '缺省/非法 scope 应走单章')
    const dir = join(prepareReviewSandbox(root, bundle, [1]).dir, 'chapters')
    assert.ok(prompt.includes(join(dir, '0001.md')), '应给正文文件路径')
    assert.ok(!prompt.includes('\n正文。'), '不应内联正文（让 AI 自己 read）')
    assert.ok(prompt.endsWith(join(dir, '0001.md')), 'prompt 应以正文文件路径结束')
  }
})
