/**
 * 世界模型 P1+P2：world.json 单例 / locations.json 一等账本 / proposals / MCP 工具 /
 * 生成与反推任务 prompt / 6 条空间自洽 checks / 只读 HTML 视图（world·timeline·map）。
 * 契约见 docs/WORLD-MODEL.md 与 task-10。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import { runChecks } from '../lib/checks.js'
import { apply, buildHandoffPrompt, renderWorldHtml, renderTimelineHtml, renderChapterMapHtml, renderAttentionHtml, renderViewHtml } from '../index.js'
import { makeRoot } from './helpers.js'

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

function location(id, overrides = {}) {
  return {
    id,
    name: id,
    aliases: [],
    type: 'city',
    coords: { x: 100, y: 100 },
    region: '',
    firstChapter: 1,
    connections: [],
    note: '',
    source: 'manual',
    ...overrides,
  }
}

function checksWith(checks, prefix) {
  return checks.filter((item) => String(item.id).startsWith(prefix))
}

async function newProjectWithWorld(t, name = '世界作品') {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name, genre: '武侠' })
  return { root, project }
}

// ── 数据层：world / locations ────────────────────────────────

test('world：未生成时返回默认单例，不落盘；saveWorld 合并写入并补 updatedAt', async (t) => {
  const { root, project } = await newProjectWithWorld(t)
  const path = join(root, 'projects', project.id, 'world.json')

  const defaults = await store.getWorld(root, project.id)
  assert.equal(defaults.id, 'world', '默认 world id 固定为 world')
  assert.equal(defaults.scale, 'region')
  assert.equal(defaults.kind, 'fictional')
  assert.deepEqual(defaults.mapSize, { w: 1000, h: 1000 })
  assert.deepEqual(defaults.travelModel, { walkKmPerDay: 30, horseKmPerDay: 80, boatKmPerDay: 60 })
  assert.equal(defaults.updatedAt, null, '默认值不应带 updatedAt')
  const bundleBefore = await store.getBundle(root, project.id)
  assert.equal(bundleBefore.stats.world, false, '未保存时 stats.world 应为 false')
  await assert.rejects(() => readFile(path, 'utf8'), '默认 world 不应写盘')

  const saved = await store.saveWorld(root, project.id, { name: '大唐天宝', scale: 'realm', kind: 'historical', era: '唐·天宝年间', travelModel: { boatKmPerDay: 50 } })
  assert.equal(saved.id, 'world')
  assert.equal(saved.name, '大唐天宝')
  assert.equal(saved.scale, 'realm')
  assert.equal(saved.travelModel.boatKmPerDay, 50, 'travelModel 应做浅合并')
  assert.equal(saved.travelModel.walkKmPerDay, 30, '未给的 travelModel 字段保留默认')
  assert.equal(saved.mapSize.w, 1000)
  assert.ok(!Number.isNaN(Date.parse(saved.updatedAt)), '写入应补可解析 updatedAt')

  const again = await store.getWorld(root, project.id)
  assert.equal(again.name, '大唐天宝')
  const bundleAfter = await store.getBundle(root, project.id)
  assert.equal(bundleAfter.stats.world, true, '保存后 stats.world 应为 true')
  assert.equal(bundleAfter.world.name, '大唐天宝')
})

test('locations：一等账本自动建空数组，upsert / delete / bundle 计数', async (t) => {
  const { root, project } = await newProjectWithWorld(t)
  assert.ok(store.KINDS.includes('locations'))
  assert.equal(store.KIND_FILES.locations, 'locations.json')
  assert.deepEqual(JSON.parse(await readFile(join(root, 'projects', project.id, 'locations.json'), 'utf8')), [])

  const saved = await store.upsertEntity(root, project.id, 'locations', location('loc-changan', { name: '长安', aliases: ['京兆府', '西京'], type: 'capital', coords: { x: 420, y: 380 }, region: '关内道' }))
  assert.equal(saved.name, '长安')
  assert.ok(saved.id)
  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.stats.locations, 1)
  assert.equal(bundle.locations[0].name, '长安')
  assert.deepEqual(bundle.locations[0].aliases, ['京兆府', '西京'])
})

test('提案采纳：world 单例合并覆盖；locations 无 id 时按 name 去重', async (t) => {
  const { root, project } = await newProjectWithWorld(t)

  const worldProposal = await store.createProposal(root, project.id, {
    kind: 'world',
    title: 'AI 世界',
    data: { name: '九州', scale: 'continent', kind: 'fictional', era: '架空', generatedBy: 'ai' },
  })
  const worldResult = await store.acceptProposal(root, project.id, worldProposal.id)
  assert.equal(worldResult.applied.world, 1)
  assert.equal((await store.getWorld(root, project.id)).name, '九州')

  const secondWorld = await store.createProposal(root, project.id, {
    kind: 'world',
    title: '世界补全',
    data: { name: '九州大陆', note: '作者确认' },
  })
  await store.acceptProposal(root, project.id, secondWorld.id)
  const world = await store.getWorld(root, project.id)
  assert.equal(world.name, '九州大陆', 'world 单例应是覆盖合并')
  assert.equal(world.scale, 'continent', '未在第二条提案里给的字段应保留')
  assert.equal(world.note, '作者确认')
  assert.equal(world.id, 'world')

  const locs = await store.createProposal(root, project.id, {
    kind: 'locations',
    title: '地点清单',
    items: [
      location('', { id: undefined, name: '长安', type: 'capital', coords: { x: 420, y: 380 } }),
      { name: '长安', note: '重复条目应合并', aliases: ['京兆府'] },
      { name: '洛阳', type: 'city', coords: { x: 620, y: 380 } },
    ],
  })
  const locResult = await store.acceptProposal(root, project.id, locs.id)
  assert.equal(locResult.applied.locations, 3)
  let bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.locations.length, 2, '同名「长安」应合并成一条，不能重复入库')
  const changan = bundle.locations.find((row) => row.name === '长安')
  assert.equal(changan.note, '重复条目应合并')
  assert.deepEqual(changan.aliases, ['京兆府'])

  // 再来一条同名提案：应更新原记录而不是新增
  const update = await store.createProposal(root, project.id, {
    kind: 'locations',
    title: '地点补充',
    items: [{ name: '长安', firstChapter: 3 }],
  })
  await store.acceptProposal(root, project.id, update.id)
  bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.locations.length, 2)
  assert.equal(bundle.locations.find((row) => row.name === '长安').firstChapter, 3)
})

// ── MCP 工具 ─────────────────────────────────────────────────

function captureTools() {
  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) }, inject: () => {}, get: () => undefined })
  return tools
}

test('MCP：bundle(kind=world/locations) 与 upsert(locations) 支持新账本', async (t) => {
  const { root, project } = await newProjectWithWorld(t, '工具作品')
  useTempRoot(t, root)
  await store.saveWorld(root, project.id, { name: '大唐', scale: 'realm', kind: 'historical', era: '天宝' })
  await store.upsertEntity(root, project.id, 'locations', location('loc-changan', { name: '长安', type: 'capital', coords: { x: 420, y: 380 }, aliases: ['京兆府'], connections: [{ to: 'loc-luoyang', distanceKm: 380, days: 5, mode: 'horse', bearing: 'east' }] }))
  await store.upsertEntity(root, project.id, 'locations', location('loc-luoyang', { name: '洛阳', coords: { x: 620, y: 380 } }))

  const tools = captureTools()
  const bundleTool = tools.find((tool) => tool.name === 'novel_desk_bundle')
  const upsertTool = tools.find((tool) => tool.name === 'novel_desk_upsert')
  const contextTool = tools.find((tool) => tool.name === 'novel_desk_context')
  const proposeTool = tools.find((tool) => tool.name === 'novel_desk_propose')
  assert.ok(bundleTool && upsertTool && contextTool && proposeTool)
  assert.ok(bundleTool.parameters.properties.kind.enum.includes('world'))
  assert.ok(bundleTool.parameters.properties.kind.enum.includes('locations'))
  assert.ok(upsertTool.parameters.properties.kind.enum.includes('locations'))
  assert.ok(proposeTool.parameters.properties.kind.enum.includes('world'))
  assert.ok(proposeTool.parameters.properties.kind.enum.includes('locations'))

  const worldText = await bundleTool.execute({ project: project.id, kind: 'world' })
  assert.match(worldText, /## 世界/)
  assert.match(worldText, /名称：大唐/)
  assert.match(worldText, /尺度：realm/)
  assert.match(worldText, /时代：天宝/)

  const locationsText = await bundleTool.execute({ project: project.id, kind: 'locations' })
  assert.match(locationsText, /## 地点（2）/)
  assert.match(locationsText, /长安 ｜ capital ｜ \(420, 380\) ｜ 连接 1/)
  assert.match(locationsText, /别名：京兆府/)

  const contextText = await contextTool.execute({ project: project.id, recent: 0 })
  assert.match(contextText, /## 世界与地点/)
  assert.match(contextText, /本作类型：武侠/)
  assert.match(contextText, /地点 2 个/)
  assert.match(contextText, /长安（capital）/)
  assert.match(proposeTool.description, /kind=world：单例/)
  assert.match(proposeTool.description, /kind=locations：条目数组/)
})

test('MCP：upsert 地点有 id 更新、无 id 新增', async (t) => {
  const { root, project } = await newProjectWithWorld(t, 'upsert 作品')
  useTempRoot(t, root)
  const tools = captureTools()
  const upsertTool = tools.find((tool) => tool.name === 'novel_desk_upsert')
  await upsertTool.execute({ project: project.id, kind: 'locations', item: location('loc-a', { name: '甲城', coords: { x: 10, y: 10 } }) })
  await upsertTool.execute({ project: project.id, kind: 'locations', item: location('loc-a', { name: '甲城', note: '更新' }) })
  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.locations.length, 1)
  assert.equal(bundle.locations[0].note, '更新')
})

// ── 任务 prompt ──────────────────────────────────────────────

test('world-build prompt：world + 8–20 地点、坐标/连接/双向/提案要求，且不改正文', async (t) => {
  const { root, project } = await newProjectWithWorld(t, '生成世界')
  const bundle = await store.getBundle(root, project.id)

  const direct = buildHandoffPrompt(bundle, { task: 'world-build' })
  for (const part of [
    '任务：生成世界地图',
    'AI 生成世界地图',
    '8–20 个地点',
    'novel_desk_propose(kind="world", data=world)',
    'novel_desk_propose(kind="locations", items=[...])',
    'name/scale',
    'kind(historical|fictional|mixed)',
    'era',
    'mapSize',
    'travelModel',
    'coords（0–1000，分布均匀）',
    'connections',
    'distanceKm',
    'days',
    'mode',
    'bearing',
    '两个方向都要写',
    '不要改正文',
  ]) {
    assert.ok(direct.includes(part), `world-build prompt 应包含「${part}」`)
  }

  const viaItem = buildHandoffPrompt(bundle, { items: [{ kind: 'task', id: 'world-build', task: 'world-build', title: 'AI 生成世界地图' }] })
  assert.ok(viaItem.includes('任务：生成世界地图'), '清单任务项也应触发生成世界段')
  assert.ok(viaItem.includes('AI 生成世界地图'))
})

test('world-infer prompt：从 events/chapters location 与 facts 反推地点，聚类去重', async (t) => {
  const { root, project } = await newProjectWithWorld(t, '反推地点')
  const bundle = await store.getBundle(root, project.id)

  const direct = buildHandoffPrompt(bundle, { task: 'world-infer' })
  for (const part of [
    '任务：从已有内容反推地点',
    'AI 反推地点',
    'events 与 chapters 的 location',
    'facts 里地点类 subject',
    '聚类去重',
    '别名',
    'novel_desk_propose(kind="world", data=world)',
    'novel_desk_propose(kind="locations", items=[...])',
    '双向',
    '不要改正文',
  ]) {
    assert.ok(direct.includes(part), `world-infer prompt 应包含「${part}」`)
  }
  assert.ok(buildHandoffPrompt(bundle, { items: [{ kind: 'task', task: 'world-infer', id: 'world-infer' }] }).includes('任务：从已有内容反推地点'))
})

test('plan / import-review：要求移动优先用已登记地点与连接，不出现地图外地点', async (t) => {
  const { root, project } = await newProjectWithWorld(t, '移动约束')
  useTempRoot(t, root)
  await store.upsertEntity(root, project.id, 'locations', location('loc-changan', { name: '长安', coords: { x: 420, y: 380 } }))
  await store.saveWorld(root, project.id, { name: '大唐', mapSize: { w: 1000, h: 1000 } })
  const bundle = await store.getBundle(root, project.id)

  const tools = captureTools()
  const planTool = tools.find((tool) => tool.name === 'novel_desk_plan')
  const planText = await planTool.execute({ project: project.id, chapter: 1 })
  assert.match(planText, /## 地点与移动/)
  assert.match(planText, /已登记地点：长安/)
  assert.ok(planText.includes('不要出现地图外地点'))
  assert.ok(planText.includes('优先使用已登记的地点与 connections'))

  const importPrompt = buildHandoffPrompt(bundle, { task: 'import-review' })
  assert.ok(importPrompt.includes('不要出现地图外地点'))
})

// ── 6 条空间 checks ─────────────────────────────────────────

const baseWorld = { id: 'world', name: '大唐', mapSize: { w: 1000, h: 1000 }, travelModel: { walkKmPerDay: 30 }, updatedAt: '2026-01-01T00:00:00.000Z' }

test('checks：有已写章节但没有 world → world-missing info；有 world 不报', () => {
  const missing = runChecks({ chapters: [chapter('0001')], locations: [] })
  const worldMissing = checksWith(missing, 'world-missing')
  assert.equal(worldMissing.length, 1)
  assert.equal(worldMissing[0].level, 'info')

  const present = runChecks({ chapters: [chapter('0001')], world: baseWorld, locations: [] })
  assert.equal(checksWith(present, 'world-missing').length, 0)

  const noChapters = runChecks({ chapters: [], locations: [] })
  assert.equal(checksWith(noChapters, 'world-missing').length, 0, '没有已写章节不报 world-missing')
})

test('checks：章节/事件地点匹配不到地点库 → location-unknown warn；地点库为空不刷屏', () => {
  const bundle = {
    world: baseWorld,
    chapters: [chapter('0001', { location: '长安' }), chapter('0002', { location: '洛阳' })],
    events: [{ id: 'e1', title: '夜袭', chapter: 3, location: '洛阳' }],
    locations: [location('loc-changan', { name: '长安', aliases: ['京兆府'] })],
  }
  const checks = runChecks(bundle)
  const unknown = checksWith(checks, 'location-unknown:')
  assert.equal(unknown.length, 1, '只有「洛阳」未登记；长安按名称、别名匹配不报')
  assert.equal(unknown[0].id, 'location-unknown:洛阳')
  assert.equal(unknown[0].level, 'warn')
  assert.match(unknown[0].detail, /第 2 章/)
  assert.match(unknown[0].detail, /第 3 章事件/)

  const noLocations = runChecks({ world: baseWorld, chapters: [chapter('0001', { location: '洛阳' })], locations: [] })
  assert.equal(checksWith(noLocations, 'location-unknown:').length, 0, '地点库为空时应跳过，避免老书刷屏')
})

test('checks：相邻两章地点不同但没有 connection → location-route-missing warn；有连接不报', () => {
  const changan = location('loc-changan', { name: '长安', coords: { x: 420, y: 380 } })
  const luoyang = location('loc-luoyang', { name: '洛阳', coords: { x: 620, y: 380 } })
  const base = {
    world: baseWorld,
    chapters: [chapter('0001', { location: '长安' }), chapter('0002', { location: '洛阳' })],
    locations: [changan, luoyang],
  }
  const missing = checksWith(runChecks(base), 'location-route-missing:')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].id, 'location-route-missing:长安-洛阳')
  assert.equal(missing[0].level, 'warn')

  const connected = { ...base, locations: [{ ...changan, connections: [{ to: 'loc-luoyang', distanceKm: 380 }] }, luoyang] }
  assert.equal(checksWith(runChecks(connected), 'location-route-missing:').length, 0, '有直接 connection 不应报警')
  const samePlace = { ...base, chapters: [chapter('0001', { location: '长安' }), chapter('0002', { location: '京兆府' })], locations: [{ ...changan, aliases: ['京兆府'] }, luoyang] }
  assert.equal(checksWith(runChecks(samePlace), 'location-route-missing:').length, 0, '别名视为同一地点，不报路线缺失')
})

test('checks：坐标非数字或超出 mapSize → location-coords-bad error', () => {
  const checks = runChecks({
    world: baseWorld,
    chapters: [],
    locations: [
      location('loc-ok', { name: '正常城', coords: { x: 500, y: 500 } }),
      location('loc-over', { name: '越界城', coords: { x: 1200, y: 500 } }),
      location('loc-nan', { name: '坏坐标城', coords: { x: 'x', y: 10 } }),
    ],
  })
  const bad = checksWith(checks, 'location-coords-bad:')
  assert.equal(bad.length, 2, '越界与非法坐标各报一条，正常坐标不报')
  assert.deepEqual(bad.map((row) => row.id).sort(), ['location-coords-bad:loc-nan', 'location-coords-bad:loc-over'])
  assert.ok(bad.every((row) => row.level === 'error'))
})

test('checks：两地点坐标距离 <10 → location-coords-close warn；距离正常不报', () => {
  const close = runChecks({
    world: baseWorld,
    chapters: [],
    locations: [
      location('loc-a', { name: '甲城', coords: { x: 100, y: 100 } }),
      location('loc-b', { name: '乙城', coords: { x: 105, y: 100 } }),
    ],
  })
  const closeWarnings = checksWith(close, 'location-coords-close:')
  assert.equal(closeWarnings.length, 1)
  assert.equal(closeWarnings[0].id, 'location-coords-close:甲城/乙城')
  assert.equal(closeWarnings[0].level, 'warn')

  const apart = runChecks({
    world: baseWorld,
    chapters: [],
    locations: [
      location('loc-a', { name: '甲城', coords: { x: 100, y: 100 } }),
      location('loc-b', { name: '乙城', coords: { x: 200, y: 100 } }),
    ],
  })
  assert.equal(checksWith(apart, 'location-coords-close:').length, 0)
})

test('checks：地点 firstChapter 晚于首次被引用章 → location-first-chapter warn；不晚不报', () => {
  const late = runChecks({
    world: baseWorld,
    chapters: [chapter('0002', { location: '长安' })],
    events: [{ id: 'e1', title: '入城', chapter: 1, location: '长安' }],
    locations: [location('loc-changan', { name: '长安', firstChapter: 5 })],
  })
  const warns = checksWith(late, 'location-first-chapter')
  assert.equal(warns.length, 1)
  assert.equal(warns[0].id, 'location-first-chapter:loc-changan')
  assert.equal(warns[0].level, 'warn')
  assert.match(warns[0].detail, /第 5 章/)
  assert.match(warns[0].detail, /第 1 章/)

  const correct = runChecks({
    world: baseWorld,
    chapters: [chapter('0002', { location: '长安' })],
    locations: [location('loc-changan', { name: '长安', firstChapter: 2 })],
  })
  assert.equal(checksWith(correct, 'location-first-chapter').length, 0)
})

test('checks：干净的世界/地点账本不误报任何 world-/location- 规则', () => {
  const checks = runChecks({
    world: baseWorld,
    chapters: [chapter('0001', { location: '长安' }), chapter('0002', { location: '洛阳' })],
    locations: [
      location('loc-changan', { name: '长安', aliases: ['京兆府'], firstChapter: 1, coords: { x: 420, y: 380 }, connections: [{ to: 'loc-luoyang', distanceKm: 380, days: 5, mode: 'horse', bearing: 'east' }] }),
      location('loc-luoyang', { name: '洛阳', firstChapter: 2, coords: { x: 620, y: 380 }, connections: [{ to: 'loc-changan', distanceKm: 380, days: 5, mode: 'horse', bearing: 'west' }] }),
    ],
  })
  assert.deepEqual(checksWith(checks, 'world-'), [])
  assert.deepEqual(checksWith(checks, 'location-'), [])
})

// ── 只读 HTML 视图 ──────────────────────────────────────────

async function sampleBundle(t) {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '鱼龙舞', genre: '武侠' })
  await useTempRoot(t, root)
  await store.saveWorld(root, project.id, {
    name: '大唐江湖', scale: 'realm', kind: 'mixed', era: '天宝年间',
    mapSize: { w: 1000, h: 1000 }, travelModel: { walkKmPerDay: 30, horseKmPerDay: 80, boatKmPerDay: 60 }, generatedBy: 'ai',
  })
  await store.upsertEntity(root, project.id, 'locations', location('loc-changan', {
    name: '长安', aliases: ['京兆府'], type: 'capital', coords: { x: 420, y: 380 }, region: '关内道', firstChapter: 1,
    connections: [{ to: 'loc-luoyang', distanceKm: 380, days: 5, mode: 'horse', bearing: 'east' }],
  }))
  await store.upsertEntity(root, project.id, 'locations', location('loc-luoyang', {
    name: '洛阳', type: 'city', coords: { x: 620, y: 380 }, region: '都畿道', firstChapter: 2,
    connections: [{ to: 'loc-changan', distanceKm: 380, days: 5, mode: 'horse', bearing: 'west' }],
  }))
  await store.saveChapter(root, project.id, { id: '0001', title: '雪夜入长安', content: '雪夜，少年推门。', status: 'final', location: '长安' })
  await store.saveChapter(root, project.id, { id: '0002', title: '洛阳来信', content: '他策马东去。', status: 'draft', location: '洛阳' })
  await store.upsertEntity(root, project.id, 'events', { id: 'event-1', title: '夜袭', chapter: 1, storyTime: '第一年冬', location: '长安' })
  await store.upsertEntity(root, project.id, 'foreshadow', { id: 'fs-1', title: '断剑', setupChapter: 1, payoffChapter: 2, status: 'paid' })
  await store.upsertEntity(root, project.id, 'conflicts', { id: 'cf-1', title: '夺嫡', status: 'resolved', resolveChapter: 2 })
  await store.upsertEntity(root, project.id, 'highlights', { id: 'hl-1', title: '雪中对视', chapter: 1, text: '雪落无声。' })
  await store.upsertEntity(root, project.id, 'attention', { id: 'att-0001', chapter: 1, type: 'mystery', score: 82, designScore: 80, verdict: '会', weakest: 'cliff', cliff: '门外是谁', status: 'verified' })
  return { root, project, bundle: await store.getBundle(root, project.id) }
}

test('HTML world 视图：自包含（内联样式/SVG）、含地点与连接、有打印按钮与页脚', async (t) => {
  const { bundle } = await sampleBundle(t)
  const html = renderWorldHtml(bundle)
  assert.match(html, /^<!doctype html>/)
  assert.ok(html.includes('<svg'), '应内联 SVG 坐标地图')
  assert.ok(html.includes('长安') && html.includes('洛阳'))
  assert.ok(html.includes('380km'), '连接线上应标距离')
  assert.ok(html.includes('window.print()'), '应有打印按钮')
  assert.ok(html.includes('《鱼龙舞》 · 长篇中文小说工作台'), '页脚应标作品名')
  assert.ok(!html.includes('http://') && !html.includes('https://'), '不应引用任何外部资源')
  assert.equal(renderViewHtml(bundle, 'world'), html)
  assert.equal(renderViewHtml(bundle, 'nonsense'), null)
})

test('HTML attention 视图：原则口号 / 曲线 / 分数 / 诊断 / 打印', async (t) => {
  const { bundle } = await sampleBundle(t)
  const html = renderAttentionHtml(bundle)
  assert.match(html, /^<!doctype html>/)
  assert.ok(html.includes('ATTENTION IS ALL YOU NEED'), '应带一号原则')
  assert.ok(html.includes('<svg'), '应有注意力曲线 SVG')
  assert.ok(html.includes('82'), '应显示实测分')
  assert.ok(html.includes('门外是谁'), '应显示章末牵引')
  assert.ok(html.includes('window.print()'), '应有打印按钮')
  assert.ok(!html.includes('http://') && !html.includes('https://'), '不应引用外部资源')
  assert.equal(renderViewHtml(bundle, 'attention'), html)
})

test('HTML timeline 视图：按章全景含事件/伏笔埋收/冲突/高光/注意力与打印按钮', async (t) => {
  const { bundle } = await sampleBundle(t)
  const html = renderTimelineHtml(bundle)
  assert.match(html, /^<!doctype html>/)
  assert.ok(html.includes('时间线全景'))
  assert.ok(html.includes('第 1 章《雪夜入长安》'))
  assert.ok(html.includes('事件：夜袭'))
  assert.ok(html.includes('伏笔埋：断剑') && html.includes('伏笔收：断剑'))
  assert.ok(html.includes('冲突解：夺嫡'))
  assert.ok(html.includes('高光：雪中对视'))
  assert.ok(html.includes('注意力 82/mystery'))
  assert.ok(html.includes('window.print()'))
  assert.ok(html.includes('每 20 章') || html.includes('第 1–2 章'), '应按 20 章或分卷分组')
})

test('HTML map 视图：蛇形章节节点、状态/注意力分档/角标、打印按钮', async (t) => {
  const { bundle } = await sampleBundle(t)
  const html = renderChapterMapHtml(bundle)
  assert.match(html, /^<!doctype html>/)
  assert.ok(html.includes('章节地图'))
  assert.ok(html.includes('snake-row'), '章节节点应按蛇形行排列')
  assert.ok(html.includes('status-final'))
  assert.ok(html.includes('tier-high'), '82 分应落强吸引档')
  assert.ok(html.includes('<b>E1</b>'), '第 1 章应有事件角标')
  assert.ok(html.includes('<b>F1</b>'), '第 1 章应有伏笔角标')
  assert.ok(html.includes('<b>C1</b>'), '第 2 章应有冲突角标')
  assert.ok(html.includes('<b>H1</b>'), '第 1 章应有高光角标')
  assert.ok(html.includes('window.print()'))
})

test('HTML 视图路由：/novel-desk/view/world 返回 200 text/html；参数错误降级为提示页', async (t) => {
  const { root, project } = await sampleBundle(t)
  const routes = []
  const media = () => {
    const state = { status: 0, headers: {}, body: '' }
    return {
      state,
      writeHead(status, headers) { state.status = status; state.headers = headers ?? {} },
      end(body) { state.body = body ?? '' },
    }
  }
  const fakeCtx = {
    tools: { register: () => {} },
    inject: (_deps, callback) => callback({
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      get: () => undefined,
      effect: () => {},
    }),
    get: () => undefined,
  }
  apply(fakeCtx)
  const viewRoute = routes.find((route) => route.path === '/novel-desk/view')
  assert.ok(viewRoute, 'apply 应注册 /novel-desk/view 前缀路由')

  const request = (url, method = 'GET') => ({ method, url, headers: { host: '127.0.0.1:57313' } })

  const worldRes = media()
  await viewRoute.handler(request(`/novel-desk/view/world?projectId=${project.id}`), worldRes)
  assert.equal(worldRes.state.status, 200)
  assert.match(String(worldRes.state.headers['content-type']), /text\/html/)
  assert.ok(worldRes.state.body.includes('世界地图'))
  assert.ok(worldRes.state.body.includes('长安'))

  const timelineRes = media()
  await viewRoute.handler(request(`/novel-desk/view/timeline?projectId=${project.id}`), timelineRes)
  assert.equal(timelineRes.state.status, 200)
  assert.ok(timelineRes.state.body.includes('时间线全景'))

  const mapRes = media()
  await viewRoute.handler(request(`/novel-desk/view/map?projectId=${project.id}`), mapRes)
  assert.equal(mapRes.state.status, 200)
  assert.ok(mapRes.state.body.includes('章节地图'))

  const missingProjectRes = media()
  await viewRoute.handler(request('/novel-desk/view/world'), missingProjectRes)
  assert.equal(missingProjectRes.state.status, 400)

  const badProjectRes = media()
  await viewRoute.handler(request('/novel-desk/view/world?projectId=no-such-project'), badProjectRes)
  assert.equal(badProjectRes.state.status, 404)
  assert.ok(badProjectRes.state.body.includes('无法打开视图'))

  const badViewRes = media()
  await viewRoute.handler(request(`/novel-desk/view/nope?projectId=${project.id}`), badViewRes)
  assert.equal(badViewRes.state.status, 404)

  const postRes = media()
  await viewRoute.handler(request(`/novel-desk/view/world?projectId=${project.id}`, 'POST'), postRes)
  assert.equal(postRes.state.status, 405)

  // 非回环 Host 应被 guard 拦下
  const forbiddenRes = media()
  await viewRoute.handler({ method: 'GET', url: `/novel-desk/view/world?projectId=${project.id}`, headers: { host: 'evil.example.com' } }, forbiddenRes)
  assert.equal(forbiddenRes.state.status, 403)
})

test('index.js：world.get / world.save RPC 分支存在', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(source.includes("'world.get'") || source.includes("case 'world.get'"))
  assert.ok(source.includes("'world.save'") || source.includes("case 'world.save'"))
})

test('locations：entity.upsert 无 id 时按 name / 别名对齐，避免重复地点', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '地点去重' })
  const first = await store.upsertEntity(root, project.id, 'locations', { name: '长安', aliases: ['京兆府'], type: 'capital', coords: { x: 1, y: 2 } })
  const byName = await store.upsertEntity(root, project.id, 'locations', { name: '长安', coords: { x: 5, y: 6 } })
  const byAlias = await store.upsertEntity(root, project.id, 'locations', { name: '京兆府', coords: { x: 7, y: 8 } })
  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.locations.length, 1, '同名/别名地点不应重复创建')
  assert.equal(byName.id, first.id)
  assert.equal(byAlias.id, first.id)
  assert.deepEqual(bundle.locations[0].coords, { x: 7, y: 8 })
})
