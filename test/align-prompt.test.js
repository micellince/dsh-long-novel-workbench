/**
 * 版本对齐的宿主层：align-ledgers 清单 prompt、novel_desk_align 工具、
 * bundle(kind=alignment) 里「计划对齐 → 版本对齐」的输出顺序。
 * 契约见 docs/ALIGNMENT-VERSION.md。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as store from '../lib/store.js'
import { apply, buildHandoffPrompt } from '../index.js'
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

/** 捕获 apply() 注册的全部工具。 */
function captureTools() {
  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {}, get: () => undefined })
  return tools
}

test('buildHandoffPrompt：align-ledgers 清单项包含版本对齐 5 步与 mark 要求', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '对齐 prompt 作品' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '正文一。' })
  const bundle = await store.getBundle(root, project.id)
  const prompt = buildHandoffPrompt(bundle, {
    items: [
      { kind: 'task', id: 'align-ledgers', task: 'align-ledgers', title: '对齐账本到当前稿', detail: '落后：人物 v1→v2；未追踪：时间线' },
    ],
  })

  assert.match(prompt, /novel_desk_bundle\(\{ kind: "alignment" \}\)/, '第 1 步应先读版本对齐')
  assert.match(prompt, /changedChapters/, '应指出读变更章节')
  assert.match(prompt, /gaps/, '应指出补缺口')
  assert.match(prompt, /novel_desk_propose/, '第 3 步应提交提案')
  assert.match(prompt, /不要直接改账本，也不要改正文/, '必须明确不改账本、不改正文')
  assert.match(prompt, /characters\/facts\/events\/locations\/world\/highlights\/foreshadow\/conflicts\/attention\/outlines/, '应列全账本 kind')
  assert.match(prompt, /novel_desk_align\(\{ op: "mark"/, '第 4 步应调用 novel_desk_align mark')
  assert.match(prompt, /只标实际完成的域/, '部分完成只标实际完成的域')
  assert.match(prompt, /工作台只负责展示和验收/, '统一结尾不能被破坏')
  assert.match(prompt, /1\. 先调用[\s\S]*5\. 汇报/, '应给出 1-5 步流程')
})

test('novel_desk_align：status 读版本对齐，mark 只标记指定域', async (t) => {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name: '对齐工具作品' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '正文一。' })

  const tools = captureTools()
  const alignTool = tools.find((tool) => tool.name === 'novel_desk_align')
  assert.ok(alignTool, '应注册 novel_desk_align 工具')
  assert.equal(alignTool.parameters.properties.op.enum.join('/'), 'status/mark', 'op 枚举应为 status/mark')

  const status = await alignTool.execute({ project: project.id, op: 'status' })
  assert.match(status, /## 版本对齐/, 'status 应返回版本对齐 Markdown')
  assert.match(status, /稿本 v\d+/, 'status 应显示稿本版本')

  const marked = await alignTool.execute({ project: project.id, op: 'mark', kinds: ['characters'], note: '测试标记' })
  assert.match(marked, /已标记 1 个域对齐到稿本 v\d+：characters/, 'mark 应只标记实际传入的域')
  assert.ok(!marked.includes('facts'), 'mark 文本不应出现未标记的域')

  const after = await store.getBundle(root, project.id)
  const characters = after.alignment.version.domains.find((domain) => domain.id === 'characters')
  assert.equal(characters.status, 'aligned', '标记后人物域应已对齐')
  const facts = after.alignment.version.domains.find((domain) => domain.id === 'facts')
  assert.notEqual(facts.status, 'aligned', '未标记的事实域不应被顺带标成已对齐')

  await assert.rejects(() => alignTool.execute({ project: project.id, op: 'nope' }), /未知操作/, '未知 op 应报错')
})

test('novel_desk_bundle(kind=alignment)：计划对齐在前，版本对齐在后', async (t) => {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name: '对齐输出作品' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '正文一。' })

  const tools = captureTools()
  const bundleTool = tools.find((tool) => tool.name === 'novel_desk_bundle')
  const text = await bundleTool.execute({ project: project.id, kind: 'alignment' })

  const plannedAt = text.indexOf('## 计划对齐')
  const versionAt = text.indexOf('## 版本对齐')
  assert.ok(plannedAt >= 0, '应保留计划对齐小节')
  assert.ok(versionAt > plannedAt, '版本对齐应追加在计划对齐之后')
  assert.match(text, /稿本 v\d+/, '版本对齐应带稿本版本')
})
