/**
 * lib/checks.js · computeAlignment + lib/store.js 当前预设联动。
 * 覆盖契约 §2.3（activePresetId）与 §2.4（多卷预设、缺省回退）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeAlignment } from '../lib/checks.js'
import * as store from '../lib/store.js'
import { makeRoot, needFn } from './helpers.js'

function bundle(overrides = {}) {
  return {
    project: { name: '对齐测试', targetChapters: 0, targetWords: 0 },
    chapters: [],
    presets: [],
    events: [],
    facts: [],
    reviews: [],
    proposals: [],
    ...overrides,
  }
}

const P80 = { id: 'p80', name: '八十章方案', plannedChapters: 80, chapterWords: 3000, totalWords: 240000 }
const P20 = { id: 'p20', name: '二十章方案', plannedChapters: 20, chapterWords: 2500, totalWords: 50000 }

test('computeAlignment：project.activePresetId 命中预设时使用该预设', () => {
  const a = computeAlignment(bundle({ project: { name: '对齐测试', activePresetId: 'p20' }, presets: [P80, P20] }))
  assert.equal(a.presetId, 'p20', 'activePresetId 命中时 alignment.presetId 应是该预设 id')
  assert.equal(a.presetName, '二十章方案', 'activePresetId 命中时 alignment.presetName 应回显预设名')
  assert.equal(a.plannedChapters, 20, 'activePresetId=p20 时应采用第二套预设的计划章数 20')
  assert.equal(a.chapterWords, 2500, 'activePresetId=p20 时应采用第二套预设的每章字数 2500')
  assert.equal(a.totalWords, 50000, 'activePresetId=p20 时应采用第二套预设的总字数 50000')
})

test('computeAlignment：无 activePresetId 时按分卷预设汇总（max chapterTo / Σ totalWords）', () => {
  const volumes = [
    { id: 'v1', name: '第一卷', chapterFrom: 1, chapterTo: 40, plannedChapters: 40, totalWords: 120000 },
    { id: 'v2', name: '第二卷', chapterFrom: 41, chapterTo: 80, plannedChapters: 40, totalWords: 150000 },
  ]
  const a = computeAlignment(bundle({ presets: volumes }))
  assert.equal(a.presetId, 'multi-volume', '多卷方案应回传合成预设 id multi-volume')
  assert.equal(a.presetName, '分卷方案（2 卷）', '多卷方案应回传「分卷方案（N 卷）」作为预设名')
  assert.equal(a.plannedChapters, 80, '多卷方案的计划章数应取 max(chapterTo) = 80')
  assert.equal(a.totalWords, 270000, '多卷方案的总字数应汇总各卷 totalWords：120000 + 150000 = 270000')
  assert.equal(a.chapterWords, 3375, '多卷方案的每章字数应 round(270000 / 80) = 3375')
})

test('computeAlignment：无 activePresetId 且无分卷字段时回退第一个预设（旧行为）', () => {
  const a = computeAlignment(bundle({ presets: [P80, P20] }))
  assert.equal(a.presetId, 'p80', '回退第一个预设时 alignment.presetId 应是第一个预设 id')
  assert.equal(a.presetName, '八十章方案', '回退第一个预设时 alignment.presetName 应回显第一个预设名')
  assert.equal(a.plannedChapters, 80, '没有 activePresetId 时应回退第一个预设的计划章数 80')
  assert.equal(a.totalWords, 240000, '没有 activePresetId 时应回退第一个预设的总字数')
  assert.equal(a.chapterWords, 3000, '没有 activePresetId 时应回退第一个预设的每章字数')
})

test('computeAlignment：activePresetId 指向不存在的预设时回退', () => {
  const a = computeAlignment(bundle({ project: { name: '对齐测试', activePresetId: 'not-exist' }, presets: [P80, P20] }))
  assert.equal(a.presetId, 'p80', 'activePresetId 未命中时应回退第一个预设（presetId 也应是它）')
  assert.equal(a.plannedChapters, 80, 'activePresetId 未命中任何预设时应回退第一个预设')
})

test('applyPreset：写入 activePresetId，对齐随之切换', async (t) => {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name: '预设联动测试' })
  const addPreset = needFn(store, 'addPresetFromTemplate', 'lib/store.js')
  const applyPreset = needFn(store, 'applyPreset', 'lib/store.js')

  const second = await addPreset(root, project.id, {
    id: 'second',
    name: '第二套方案',
    plannedChapters: 20,
    chapterWords: 2000,
    totalWords: 40000,
  })
  const applied = await applyPreset(root, project.id, second.id)
  assert.equal(applied.activePresetId, second.id, 'applyPreset 应把 activePresetId 写成被应用的预设')

  const after = await store.getBundle(root, project.id)
  assert.equal(after.project.targetChapters, 20, 'applyPreset 仍应写入 targetChapters = 预设计划章数')
  assert.equal(after.alignment.presetId, second.id, '对齐 presetId 应是 applyPreset 设置的当前预设')
  assert.equal(after.alignment.presetName, '第二套方案', '对齐 presetName 应回显当前预设名')
  assert.equal(after.alignment.plannedChapters, 20, '对齐应使用 activePresetId 命中的第二套方案')
  assert.equal(after.alignment.chapterWords, 2000, '对齐的每章字数应来自第二套方案')

  // 回退：activePresetId 指向不存在的预设 → 回到第一个预设
  const updateProject = needFn(store, 'updateProject', 'lib/store.js')
  await updateProject(root, project.id, { activePresetId: 'not-exist' })
  const fallback = await store.getBundle(root, project.id)
  const firstPreset = fallback.presets[0]
  assert.equal(fallback.alignment.presetId, firstPreset.id, 'activePresetId 未命中时 presetId 应回退到第一个预设')
  assert.equal(fallback.alignment.presetName, firstPreset.name, 'activePresetId 未命中时 presetName 应回退到第一个预设')
  assert.equal(
    fallback.alignment.plannedChapters,
    Number(firstPreset.plannedChapters),
    'activePresetId 未命中时应回退到第一个预设的计划章数',
  )
})
