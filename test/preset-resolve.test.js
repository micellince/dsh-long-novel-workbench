/**
 * 预设解析口径回归：所有读预设的链路必须命中「当前生效预设」，
 * 不能各自取 presets[0]。历史上 lib/ai.js 取 presets[0]，导致作者选中的
 * 风格预设被「标准长篇方案」静默顶替，整本书的文风指令从未进入生成 prompt。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveActivePreset } from '../lib/defaults.js'
import { buildAiContext } from '../lib/ai.js'

const standard = { id: 'preset-standard', name: '标准长篇方案', tone: '克制、有画面感', styleRules: ['少用抽象总结'] }
const liang = { id: 'style-liangyusheng', name: '梁羽生风格', source: 'builtin', tone: '典雅清正', styleRules: ['对话文白相融'] }
const imported = { id: 'imp', name: '导入规范', source: 'import', tone: '', styleRules: ['回目对仗'] }

function bundle(project = {}, presets = []) {
  return { project: { name: '测试', ...project }, presets, chapters: [], attention: [], facts: [], events: [], foreshadow: [], conflicts: [], characters: [], agents: [], outlines: [], locations: [] }
}

test('预设解析：activePresetId 优先于数组顺序', () => {
  const hit = resolveActivePreset(bundle({ activePresetId: 'style-liangyusheng' }, [standard, liang]))
  assert.equal(hit.id, 'style-liangyusheng')
})

test('预设解析：未设 activePresetId 时回落到导入预设', () => {
  const hit = resolveActivePreset(bundle({}, [standard, imported, liang]))
  assert.equal(hit.id, 'imp')
})

test('预设解析：都没有时取第一条，空集返回空对象', () => {
  assert.equal(resolveActivePreset(bundle({}, [standard, liang])).id, 'preset-standard')
  assert.deepEqual(resolveActivePreset(bundle({}, [])), {})
})

test('生成上下文必须带上生效预设的 tone 与 styleRules（回归：不能是 presets[0]）', () => {
  const ctx = buildAiContext(bundle({ activePresetId: 'style-liangyusheng' }, [standard, liang]), null)
  assert.match(ctx, /预设名：梁羽生风格/)
  assert.match(ctx, /风格规则：对话文白相融/)
  assert.doesNotMatch(ctx, /克制、有画面感/)
})
