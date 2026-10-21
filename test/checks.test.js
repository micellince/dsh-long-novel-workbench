/**
 * lib/checks.js · runChecks 确定性检查。
 * 覆盖契约 §2.1（事实时间维度）与 §5-1（伏笔超期、未建卡人物）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { runChecks } from '../lib/checks.js'

function chapter(id, overrides = {}) {
  return { id, title: `第 ${id} 章`, content: '正文。', characters: [], ...overrides }
}

/** 只取事实冲突类问题。 */
function factConflicts(checks) {
  return checks.filter((c) => String(c.id).startsWith('fact-conflict:'))
}

test('事实区间：生效区间重叠且取值不同 → 报 error（含边界相接）', () => {
  const checks = runChecks({
    chapters: [],
    facts: [
      { subject: '甲', attribute: '修为', value: '炼气', validFrom: 1, validTo: 5 },
      { subject: '甲', attribute: '修为', value: '筑基', validFrom: 5, validTo: 9 },
    ],
  })
  const conflicts = factConflicts(checks)
  assert.equal(conflicts.length, 1, '区间 [1,5] 与 [5,9] 按闭区间相接即重叠，应报 1 条事实冲突')
  assert.equal(conflicts[0].level, 'error', '事实冲突应为 error 级别')
  assert.match(conflicts[0].detail, /炼气/, '冲突详情应列出不同取值')
})

test('事实区间：完全不重叠 → 不报冲突', () => {
  const checks = runChecks({
    chapters: [],
    facts: [
      { subject: '甲', attribute: '修为', value: '炼气', validFrom: 1, validTo: 5 },
      { subject: '甲', attribute: '修为', value: '筑基', validFrom: 6, validTo: 9 },
    ],
  })
  assert.deepEqual(factConflicts(checks), [], '区间 [1,5] 与 [6,9] 不重叠，不应报事实冲突')
})

test('事实区间：缺省 validFrom/validTo 视为全程有效', () => {
  const checks = runChecks({
    chapters: [],
    facts: [
      { subject: '乙', attribute: '身份', value: '书生' },
      { subject: '乙', attribute: '身份', value: '剑客', validFrom: 100, validTo: 200 },
    ],
  })
  assert.equal(factConflicts(checks).length, 1, '缺省 = 从第 1 章到永远，与 [100,200] 必然重叠，应报冲突')
})

test('事实区间：缺省 validTo 视为一直有效（Infinity）', () => {
  const checks = runChecks({
    chapters: [],
    facts: [
      { subject: '丙', attribute: '居所', value: '山门', validFrom: 1 },
      { subject: '丙', attribute: '居所', value: '京城', validFrom: 50 },
    ],
  })
  assert.equal(factConflicts(checks).length, 1, '缺省 validTo 是无穷大，两条记录必然重叠，应报冲突')
})

test('事实区间：取值相同即使区间重叠也不报', () => {
  const checks = runChecks({
    chapters: [],
    facts: [
      { subject: '丁', attribute: '门派', value: '青云门', validFrom: 1, validTo: 10 },
      { subject: '丁', attribute: '门派', value: '青云门', validFrom: 5, validTo: 20 },
    ],
  })
  assert.deepEqual(factConflicts(checks), [], '同一 subject+attribute 取值相同不构成冲突')
})

test('伏笔超期：计划回收章已写到仍未回收 → error；已回收不报', () => {
  const checks = runChecks({
    chapters: [chapter('0001'), chapter('0002'), chapter('0003'), chapter('0004')],
    foreshadow: [
      { id: 'f-overdue', title: '断剑的下落', setupChapter: 1, payoffChapter: 3, status: 'open' },
      { id: 'f-paid', title: '玉佩来历', setupChapter: 1, payoffChapter: 3, status: 'paid' },
    ],
  })
  const overdue = checks.filter((c) => String(c.id).startsWith('foreshadow-overdue:'))
  assert.equal(overdue.length, 1, '只有未回收且已过计划回收章的伏笔才报超期')
  assert.equal(overdue[0].id, 'foreshadow-overdue:f-overdue', '超期检查应指向未回收的 f-overdue')
  assert.equal(overdue[0].level, 'error', '伏笔超期应为 error 级别')
})

test('章节引用未建卡人物 → warn', () => {
  const checks = runChecks({
    chapters: [chapter('0001', { characters: ['张三', '李四'] })],
    characters: [{ id: 'c1', name: '张三' }],
  })
  const missing = checks.filter((c) => String(c.id).startsWith('char-missing:'))
  assert.equal(missing.length, 1, '只应对未建卡的「李四」报一条，已建卡的「张三」不报')
  assert.equal(missing[0].id, 'char-missing:0001:李四')
  assert.equal(missing[0].level, 'warn', '人物未建卡应为 warn 级别')
})
