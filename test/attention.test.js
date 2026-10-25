import test from 'node:test'
import assert from 'node:assert/strict'

import { BEAT_LABEL, BEAT_MAX, byChapter, deficitsOf, designGap, scoreOf, stats, weakActions } from '../lib/attention.js'

test('BEAT_MAX：四拍满分合计 100', () => {
  const sum = Object.values(BEAT_MAX).reduce((total, value) => total + value, 0)
  assert.equal(sum, 100)
  assert.equal(BEAT_MAX.hook, 20)
  assert.equal(BEAT_MAX.tension, 20)
  assert.equal(BEAT_MAX.payoff, 30)
  assert.equal(BEAT_MAX.cliff, 30)
  assert.equal(BEAT_LABEL.hook, '钩子')
})

test('scoreOf：加总、夹紧、空值', () => {
  assert.equal(scoreOf({ hook: 20, tension: 20, payoff: 30, cliff: 30 }), 100)
  assert.equal(scoreOf({ hook: 10, tension: 10, payoff: 10, cliff: 10 }), 40)
  assert.equal(scoreOf({ hook: 120, tension: 20, payoff: 30, cliff: 30 }), 100)
  assert.equal(scoreOf({ hook: -5 }), 0)
  assert.equal(scoreOf({}), null)
  assert.equal(scoreOf({ hook: null, tension: '' }), null)
  assert.equal(scoreOf({ hook: '18' }), 18)
  assert.equal(scoreOf(null), null)
})

test('deficitsOf：低于 0.6 × 满分，按弱到强排序', () => {
  assert.deepEqual(deficitsOf({ hook: 12, tension: 20, payoff: 18, cliff: 30 }), [])
  assert.deepEqual(deficitsOf({ hook: 11, tension: 20, payoff: 15, cliff: 30 }), ['payoff', 'hook'])
  assert.deepEqual(deficitsOf(null), ['hook', 'tension', 'payoff', 'cliff'])
})

test('designGap：正数=实测低于设计', () => {
  assert.equal(designGap(92, 78), 14)
  assert.equal(designGap({ designScore: 92, score: 78 }), 14)
  assert.equal(designGap(78, 92), -14)
  assert.equal(designGap(null, 50), null)
  assert.equal(designGap({}, 50), null)
})

test('byChapter：数组与旧 {chapters:{}} 形状都按章号升序', () => {
  const array = byChapter([{ chapter: 3 }, { chapter: 1 }, { chapter: 2 }])
  assert.deepEqual(array.map((item) => item.chapter), [1, 2, 3])

  const legacy = byChapter({ chapters: { 1: [{ chapter: 2 }, { chapter: 1 }], 2: { chapter: 3 } } })
  assert.deepEqual(legacy.map((item) => item.chapter), [1, 2, 3])
  assert.deepEqual(byChapter(null), [])
})

test('stats：平均分 / 已打分 / 未打分 / 最弱环节', () => {
  const result = stats([
    { chapter: 1, score: 80, breakdown: { hook: 12, tension: 20, payoff: 28, cliff: 20 } },
    { chapter: 2, score: 90, breakdown: { hook: 18, tension: 20, payoff: 30, cliff: 22 } },
    { chapter: 3 },
  ])
  assert.equal(result.avg, 85)
  assert.equal(result.scored, 2)
  assert.equal(result.unscored, 1)
  assert.equal(result.weakest, 'cliff')
  assert.equal(stats([]).avg, null)
  assert.equal(stats([]).weakest, null)
})

test('weakActions：按环节给具体补强句，重复环节去重', () => {
  const actions = weakActions(['hook', 'hook', 'cliff', 'unknown-beat'])
  assert.equal(actions.length, 3)
  assert.ok(actions[0].includes('钩子'))
  assert.ok(actions[1].includes('章末牵引'))
  assert.ok(actions[2].includes('unknown-beat'))
  assert.deepEqual(weakActions([]), [])
})
