/**
 * lib/alignment.js · 版本对齐（稿本版本 vs 各标签账本同步版本）与 lib/store.js 钩子。
 * 契约见 docs/ALIGNMENT-VERSION.md。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import {
  ALIGN_KINDS,
  ALIGN_STATUS_LABEL,
  DRAFT_LOG_LIMIT,
  bumpDraft,
  computeVersionAlignment,
  formatVersionAlignment,
  getDraftState,
  getLedgerSync,
  markLedgerKindsAligned,
  normalizeAlignKinds,
  touchLedgerKinds,
} from '../lib/alignment.js'
import { makeRoot, needFn, delay } from './helpers.js'

// ── 纯函数 ───────────────────────────────────────────────────

test('旧数据：getDraftState / getLedgerSync 缺字段时给出安全缺省值', () => {
  const project = { name: '老作品' }
  const draft = getDraftState(project)
  assert.equal(draft.version, 0, '没有 draft 时稿本版本应为 0')
  assert.equal(draft.updatedAt, null, '没有 draft 时 updatedAt 应为 null')
  assert.deepEqual(draft.log, [], '没有 draft 时日志应为空数组')
  const sync = getLedgerSync(project)
  assert.deepEqual(Object.keys(sync).sort(), [...ALIGN_KINDS].sort(), 'ledgerSync 应覆盖全部 10 个对齐域')
  assert.equal(sync.characters.alignedVersion, null, '未追踪的账本 alignedVersion 应为 null')
  assert.equal(sync.characters.touchedVersion, null, '未追踪的账本 touchedVersion 应为 null')
})

test('正常数据：getDraftState 原样返回，不复制脏数据', () => {
  const project = {
    draft: { version: 7, updatedAt: '2026-01-01T00:00:00.000Z', log: [{ version: 7, at: 'x', kind: 'chapter-save' }] },
    ledgerSync: { characters: { touchedVersion: 5, alignedVersion: 3, note: '补人物' } },
  }
  const draft = getDraftState(project)
  assert.equal(draft.version, 7, '应读回 draft.version')
  assert.equal(draft.updatedAt, '2026-01-01T00:00:00.000Z', '应读回 draft.updatedAt')
  assert.equal(draft.log.length, 1, '应读回 draft.log')
  const sync = getLedgerSync(project)
  assert.equal(sync.characters.touchedVersion, 5, '应读回 touchedVersion')
  assert.equal(sync.characters.alignedVersion, 3, '应读回 alignedVersion')
  assert.equal(sync.characters.note, '补人物', '应读回 note')
  assert.equal(sync.facts.alignedVersion, null, '未写入过的域仍是未追踪')
})

test('bumpDraft：版本 +1、日志追加，超过上限只保留最近条目', () => {
  const project = { draft: { version: 0, updatedAt: null, log: [] } }
  const first = bumpDraft(project, { kind: 'chapter-create', chapter: '0001', title: '第一章', at: '2026-02-01T00:00:00.000Z' })
  assert.equal(first.version, 1, '首条日志 version 应为 1')
  assert.equal(first.kind, 'chapter-create', '日志应记录 kind')
  assert.equal(first.chapter, 1, '日志应记录章节号（存成数字）')
  assert.equal(project.draft.version, 1, 'bumpDraft 应直接改传入的 project')
  assert.equal(project.draft.updatedAt, '2026-02-01T00:00:00.000Z', 'bumpDraft 应更新 updatedAt')

  for (let i = 0; i < DRAFT_LOG_LIMIT + 20; i += 1) {
    bumpDraft(project, { kind: 'chapter-save', note: `第 ${i} 次`, at: `2026-02-02T00:00:${String(i % 60).padStart(2, '0')}.000Z` })
  }
  assert.equal(project.draft.version, 1 + DRAFT_LOG_LIMIT + 20, '版本号应连续递增')
  assert.equal(project.draft.log.length, DRAFT_LOG_LIMIT, `日志最多保留 ${DRAFT_LOG_LIMIT} 条`)
  assert.equal(project.draft.log[project.draft.log.length - 1].version, project.draft.version, '最后一条日志应是刚写入的版本')
})

test('touchLedgerKinds / markLedgerKindsAligned：同版本去重、不能标到未来版本', () => {
  const project = { draft: { version: 4, updatedAt: 'x', log: [] }, ledgerSync: {} }
  const touched = touchLedgerKinds(project, ['characters', 'facts'], 'now')
  assert.deepEqual(touched, ['characters', 'facts'], '首次 touch 应返回实际更新的域')
  assert.equal(project.ledgerSync.characters.touchedVersion, 4, 'touchedVersion 应记成当前稿本版本')
  const again = touchLedgerKinds(project, ['characters'], 'later')
  assert.deepEqual(again, [], '同一稿本版本内重复 touch 不产生变化')

  const marked = markLedgerKindsAligned(project, ['characters'], { version: 3, note: '补到 v3', at: 'now' })
  assert.deepEqual(marked, ['characters'], 'mark 应返回实际标记的域')
  assert.equal(project.ledgerSync.characters.alignedVersion, 3, 'alignedVersion 应记成指定版本')
  assert.equal(project.ledgerSync.characters.note, '补到 v3', 'mark 应写入 note')
  assert.throws(() => markLedgerKindsAligned(project, ['characters'], { version: 99 }), /未来的稿本版本/u, '标记到未来版本应报错')

  assert.deepEqual(normalizeAlignKinds(['characters', 'reviews', 'characters', '']), ['characters'], 'normalize 应过滤非法 kind 并去重')
})

/** 最小 bundle：只放 computeVersionAlignment 用得到的字段。 */
function makeBundle(overrides = {}) {
  return {
    project: { name: '版本对齐测试', draft: { version: 0, updatedAt: null, log: [] }, ledgerSync: {} },
    chapters: [],
    facts: [],
    events: [],
    foreshadow: [],
    conflicts: [],
    characters: [],
    highlights: [],
    attention: [],
    locations: [],
    outlines: [],
    worldSaved: false,
    proposals: [],
    ...overrides,
  }
}

test('computeVersionAlignment：没有正文且零版本 → 全部 idle，不需要对齐', () => {
  const report = computeVersionAlignment(makeBundle())
  assert.equal(report.manuscript.version, 0, '空作品稿本版本应为 0')
  assert.equal(report.manuscript.chapters, 0, '空作品章数应为 0')
  assert.equal(report.summary.total, ALIGN_KINDS.length, 'summary.total 应等于对齐域数量')
  assert.equal(report.domains.length, ALIGN_KINDS.length, '每个对齐域都应出现在报告里')
  assert.ok(report.domains.every((d) => d.status === 'idle'), '空作品所有域都应是 idle')
  assert.equal(report.summary.needsAlign, false, '空作品不需要对齐')
  assert.equal(ALIGN_STATUS_LABEL.idle, '未开始', 'idle 应显示「未开始」')
})

test('computeVersionAlignment：有正文但账本未追踪 → untracked，并列出变更日志', () => {
  const report = computeVersionAlignment(makeBundle({
    project: {
      name: '版本对齐测试',
      draft: {
        version: 3,
        updatedAt: '2026-03-01T00:00:00.000Z',
        log: [
          { version: 1, at: '2026-03-01T00:00:00.000Z', kind: 'chapter-create', chapter: '0001', title: '第一章' },
          { version: 2, at: '2026-03-01T00:10:00.000Z', kind: 'chapter-save', chapter: '0001', title: '第一章' },
          { version: 3, at: '2026-03-01T00:20:00.000Z', kind: 'chapter-save', chapter: '0002', title: '第二章' },
        ],
      },
      ledgerSync: {},
    },
    chapters: [
      { id: '0001', title: '第一章', words: 2000, characters: [], location: '' },
      { id: '0002', title: '第二章', words: 2200, characters: [], location: '' },
    ],
  }))
  assert.equal(report.manuscript.version, 3, '稿本版本应为 3')
  assert.equal(report.summary.untracked, ALIGN_KINDS.length, '未追踪的域应全部计入 untracked')
  assert.equal(report.summary.needsAlign, true, '有未追踪账本就需要对齐')
  const characters = report.domains.find((d) => d.id === 'characters')
  assert.equal(characters.status, 'untracked', '人物域应为 untracked')
  assert.equal(characters.changes.length, 3, '未追踪时应把全部稿本日志当成变更')
  assert.equal(characters.changes.at(-1).version, 3, '变更按版本升序，最后一条是最近一次')
  assert.ok(characters.changedChapters.some((c) => c.id === 2), '变更章节应包含第二章')
})

test('computeVersionAlignment：已对齐 / 落后 / 待验收 三种状态', () => {
  const bundle = makeBundle({
    project: {
      name: '版本对齐测试',
      draft: {
        version: 5,
        updatedAt: '2026-03-02T00:00:00.000Z',
        log: [
          { version: 4, at: '2026-03-02T00:00:00.000Z', kind: 'chapter-save', chapter: '0001', title: '第一章' },
          { version: 5, at: '2026-03-02T00:10:00.000Z', kind: 'chapter-save', chapter: '0002', title: '第二章' },
        ],
      },
      ledgerSync: {
        characters: { touchedVersion: 4, touchedAt: 'x', alignedVersion: 5, alignedAt: 'x', note: '' },
        facts: { touchedVersion: 5, touchedAt: 'x', alignedVersion: 3, alignedAt: 'x', note: '' },
        highlights: { touchedVersion: 5, touchedAt: 'x', alignedVersion: 5, alignedAt: 'x', note: '' },
      },
    },
    chapters: [
      { id: '0001', title: '第一章', words: 2000, characters: [], location: '' },
      { id: '0002', title: '第二章', words: 2000, characters: [], location: '' },
    ],
    proposals: [{ id: 'p1', kind: 'highlights', status: 'pending' }],
  })
  const report = computeVersionAlignment(bundle)
  const byId = new Map(report.domains.map((d) => [d.id, d]))
  assert.equal(byId.get('characters').status, 'aligned', 'alignedVersion 追平稿本版本应为已对齐')
  assert.equal(byId.get('facts').status, 'behind', 'alignedVersion 落后稿本版本应为落后')
  assert.equal(byId.get('facts').behind, 2, '落后版本数应为 5 - 3 = 2')
  assert.equal(byId.get('facts').touchedVersion, 5, '应回传 touchedVersion 供页面提示账本被改过')
  assert.equal(byId.get('highlights').status, 'pending', '存在待验收提案时状态应为待验收')
  assert.equal(byId.get('highlights').pendingProposals, 1, '待验收提案数应为 1')
  assert.equal(report.summary.aligned, 1, 'summary.aligned 只统计已对齐域')
  assert.equal(report.summary.behind, 1, 'summary.behind 统计落后域')
  assert.equal(report.summary.pending, 1, 'summary.pending 统计待验收域')
  assert.equal(report.summary.pendingProposals, 1, 'summary.pendingProposals 汇总待验收提案数')
})

test('computeVersionAlignment：覆盖缺口（缺高光 / 缺大纲 / 引用人物未建卡 / 地点未登记 / 世界未建）', () => {
  const report = computeVersionAlignment(makeBundle({
    project: {
      name: '缺口测试',
      draft: {
        version: 2,
        updatedAt: '2026-03-03T00:00:00.000Z',
        log: [{ version: 2, at: '2026-03-03T00:00:00.000Z', kind: 'chapter-save', chapter: '0001', title: '第一章' }],
      },
      ledgerSync: { characters: { alignedVersion: 2 }, highlights: { alignedVersion: 2 }, outlines: { alignedVersion: 2 }, locations: { alignedVersion: 2 } },
    },
    chapters: [{ id: '0001', title: '第一章', words: 1800, characters: ['林昭', '沈砚'], location: '青云山' }],
    characters: [{ id: 'c1', name: '林昭', aliases: [] }],
    worldSaved: false,
  }))
  const byId = new Map(report.domains.map((d) => [d.id, d]))
  const charGap = byId.get('characters').gaps.find((gap) => gap.id === 'characters-missing')
  assert.ok(charGap, '正文引用了没建卡的人物应产生缺口')
  assert.match(charGap.label, /沈砚/u, '缺口应点名未建卡的人物')
  const highlightGap = byId.get('highlights').gaps.find((gap) => gap.id === 'highlights-missing')
  assert.ok(highlightGap, '已写章节没有高光记录应产生缺口')
  assert.deepEqual(highlightGap.chapters, [1], '缺口应带出缺记录的章节号')
  assert.ok(byId.get('outlines').gaps.some((gap) => gap.id === 'outlines-missing'), '缺大纲应产生缺口')
  const locationGap = byId.get('locations').gaps.find((gap) => gap.id === 'locations-missing')
  assert.ok(locationGap, '章节写了地点但地图未登记应产生缺口')
  assert.match(locationGap.label, /青云山/u, '地点缺口应点名地点')
  assert.ok(byId.get('world').gaps.some((gap) => gap.id === 'world-missing'), '世界未创建应产生缺口')
  assert.ok(report.summary.gaps >= 4, 'summary.gaps 应汇总至少 4 条缺口')
  assert.equal(byId.get('foreshadow').gaps.length, 0, '伏笔不统计覆盖缺口')
})

test('formatVersionAlignment：输出 Markdown 概览与落后行', () => {
  const report = computeVersionAlignment(makeBundle({
    project: {
      name: '格式测试',
      draft: {
        version: 4,
        updatedAt: '2026-03-04T00:00:00.000Z',
        log: [{ version: 4, at: '2026-03-04T00:00:00.000Z', kind: 'chapter-save', chapter: '0001', title: '第一章' }],
      },
      ledgerSync: { characters: { alignedVersion: 2, touchedVersion: 4 }, facts: { alignedVersion: 4 } },
    },
    chapters: [{ id: '0001', title: '第一章', words: 1500, characters: [], location: '' }],
  }))
  const text = formatVersionAlignment(report)
  assert.match(text, /## 版本对齐/u, '应有「版本对齐」小节标题')
  assert.match(text, /稿本 v4/u, '应显示稿本版本')
  assert.match(text, /人物/u, '应列出落后域')
  assert.match(text, /账本 v2 → 稿本 v4/u, '应显示账本版本到稿本版本')
})

// ── store 集成 ───────────────────────────────────────────────

function projectJsonPath(root, project) {
  return join(root, 'projects', project.id, 'project.json')
}

async function readProject(root, project) {
  return JSON.parse(await readFile(projectJsonPath(root, project), 'utf8'))
}

async function writeProject(root, project, data) {
  await writeFile(projectJsonPath(root, project), JSON.stringify(data, null, 2), 'utf8')
}

async function newProject(t, name = '版本对齐作品') {
  const root = await makeRoot(t)
  const project = await store.createProject(root, { name, genre: '玄幻' })
  return { root, project }
}

test('createProject：新作品带 draft 与 ledgerSync 初始字段', async (t) => {
  const { root, project } = await newProject(t)
  const saved = await readProject(root, project)
  assert.equal(saved.draft.version, 0, '新作品稿本版本应为 0')
  assert.deepEqual(saved.draft.log, [], '新作品稿本日志应为空')
  assert.ok(saved.ledgerSync && typeof saved.ledgerSync === 'object', '新作品应带 ledgerSync 对象')
  assert.deepEqual(saved.ledgerSync, {}, '新作品 ledgerSync 应为空对象（各域默认未追踪）')
})

test('saveChapter：新建 / 覆盖推进稿本版本，内容没变不刷版本号', async (t) => {
  const { root, project } = await newProject(t)
  await store.saveChapter(root, project.id, { title: '第一章', content: '少年走出山村。' })
  let saved = await readProject(root, project)
  assert.equal(saved.draft.version, 1, '首次保存新建章节应升到 v1')
  assert.equal(saved.draft.log.at(-1).kind, 'chapter-create', '首条日志 kind 应为 chapter-create')
  const firstAt = saved.draft.updatedAt

  await delay(10)
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '少年走出山村。' })
  saved = await readProject(root, project)
  assert.equal(saved.draft.version, 1, '内容完全相同的重复保存不应推进版本')
  assert.equal(saved.draft.updatedAt, firstAt, '内容没变时不应改动 draft.updatedAt')

  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '少年走出山村，回头看了一眼。' })
  saved = await readProject(root, project)
  assert.equal(saved.draft.version, 2, '正文变化应升到 v2')
  assert.equal(saved.draft.log.at(-1).kind, 'chapter-save', '覆盖保存日志 kind 应为 chapter-save')
  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.alignment.version.manuscript.version, 2, 'getBundle 里应带版本对齐报告')
})

test('upsertEntity：账本改动 → touchedVersion 跟上，页面能看到落后', async (t) => {
  const { root, project } = await newProject(t)
  await store.saveChapter(root, project.id, { title: '第一章', content: '少年走出山村。' })
  const entity = await store.upsertEntity(root, project.id, 'characters', { name: '林昭' })
  let saved = await readProject(root, project)
  assert.equal(saved.ledgerSync.characters.touchedVersion, 1, '写人物后 touchedVersion 应记成当前稿本版本')
  assert.ok(saved.ledgerSync.characters.alignedVersion == null, '没有标记过对齐时 alignedVersion 仍应为空')

  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '少年走出山村。风起了。' })
  await store.upsertEntity(root, project.id, 'characters', { id: entity.id, name: '林昭' })
  saved = await readProject(root, project)
  assert.equal(saved.draft.version, 2, '改正文后稿本应到 v2')
  assert.equal(saved.ledgerSync.characters.touchedVersion, 2, '再次改人物后 touchedVersion 应跟到 v2')

  await store.markLedgersAligned(root, project.id, ['characters'], { note: '补人物卡' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '少年走出山村。风起了。天色暗了。' })
  await store.upsertEntity(root, project.id, 'characters', { id: entity.id, name: '林昭' })
  const bundle = await store.getBundle(root, project.id)
  const characters = bundle.alignment.version.domains.find((d) => d.id === 'characters')
  assert.equal(characters.status, 'behind', '稿本继续前进、人物又改过之后应为落后')
  assert.equal(characters.behind, 1, '落后版本数应为 1')
})

test('markLedgersAligned：可只标指定域，也可全部标记，未来版本报错', async (t) => {
  const { root, project } = await newProject(t)
  await store.saveChapter(root, project.id, { title: '第一章', content: '少年走出山村。' })

  const partial = await store.markLedgersAligned(root, project.id, ['characters', 'reviews'], { note: '只补人物' })
  assert.deepEqual(partial.kinds, ['characters'], '非对齐域应被过滤掉')
  assert.equal(partial.version, 1, '缺省标记到当前稿本版本')
  let saved = await readProject(root, project)
  assert.equal(saved.ledgerSync.characters.alignedVersion, 1, '人物域应标成 v1 已对齐')
  assert.equal(saved.ledgerSync.characters.note, '只补人物', '应保存对齐备注')

  const all = await store.markLedgersAligned(root, project.id, [], { note: '全部补齐' })
  assert.equal(all.kinds.length, ALIGN_KINDS.length, '空数组应当作全部对齐域')
  saved = await readProject(root, project)
  for (const kind of ALIGN_KINDS) {
    assert.equal(saved.ledgerSync[kind].alignedVersion, 1, `${kind} 应标成已对齐`)
  }
  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.alignment.version.summary.needsAlign, false, '全部标记后不需要再对齐')
  assert.equal(bundle.alignment.version.summary.aligned, ALIGN_KINDS.length, '全部域都应是已对齐')

  await assert.rejects(
    () => store.markLedgersAligned(root, project.id, ['characters'], { version: bundle.alignment.version.manuscript.version + 5 }),
    /未来的稿本版本/u,
    '标记到未来版本应报错',
  )
})

test('deleteChapter：删除已有章节推进稿本版本', async (t) => {
  const { root, project } = await newProject(t)
  await store.saveChapter(root, project.id, { title: '第一章', content: '一。' })
  await store.saveChapter(root, project.id, { title: '第二章', content: '二。' })
  let saved = await readProject(root, project)
  assert.equal(saved.draft.version, 2, '两章建好后应为 v2')

  await store.deleteChapter(root, project.id, '0002')
  saved = await readProject(root, project)
  assert.equal(saved.draft.version, 3, '删章应升到 v3')
  assert.equal(saved.draft.log.at(-1).kind, 'chapter-delete', '日志 kind 应为 chapter-delete')
  assert.equal(saved.draft.log.at(-1).chapter, 2, '日志应记录被删章号（存成数字）')

  await store.deleteChapter(root, project.id, '0099')
  saved = await readProject(root, project)
  assert.equal(saved.draft.version, 3, '删除不存在的章不应推进版本')
})

test('ensureDraftCurrent：老数据没有 draft 时建立基线', async (t) => {
  const { root, project } = await newProject(t)
  await store.saveChapter(root, project.id, { title: '第一章', content: '少年走出山村。' })
  // 模拟老版本数据：project.json 里没有 draft / ledgerSync
  const saved = await readProject(root, project)
  delete saved.draft
  delete saved.ledgerSync
  await writeProject(root, project, saved)

  const bundleBefore = await store.getBundle(root, project.id)
  assert.equal(bundleBefore.alignment.version.manuscript.version, 0, '老数据在没有 ensureDraftCurrent 前版本为 0')
  assert.equal(bundleBefore.alignment.version.domains.every((d) => d.status === 'untracked'), true, '老数据有正文但没版本时显示未追踪')

  const result = await store.ensureDraftCurrent(root, project.id)
  assert.equal(result.baseline, true, '老数据有正文时应建立基线')
  assert.equal(result.version, 1, '基线版本应为 1')
  const after = await readProject(root, project)
  assert.equal(after.draft.log.at(-1).kind, 'baseline', '日志 kind 应为 baseline')

  const again = await store.ensureDraftCurrent(root, project.id)
  assert.equal(again.version, 1, '再次调用不应重复建立基线')
  assert.deepEqual(again.changed, [], '没有外部改动时 changed 应为空')
})

test('ensureDraftCurrent：章节文件被外部改动时记一条 external-change', async (t) => {
  const { root, project } = await newProject(t)
  await store.saveChapter(root, project.id, { title: '第一章', content: '少年走出山村。' })
  const before = await readProject(root, project)

  // 直接改文件（绕开 saveChapter），并把 mtime 推到未来，模拟外部编辑/同步
  const chapterPath = join(root, 'projects', project.id, 'chapters', '0001.md')
  const raw = await readFile(chapterPath, 'utf8')
  await writeFile(chapterPath, raw.replace('少年走出山村。', '少年走出山村，背着剑。'), 'utf8')
  const future = new Date(Date.now() + 60_000)
  await utimes(chapterPath, future, future)

  const result = await store.ensureDraftCurrent(root, project.id)
  assert.equal(result.version, before.draft.version + 1, '外部改动应推进一个版本')
  assert.equal(result.changed.length, 1, '应报告 1 个被外部改动的章节')
  assert.equal(result.changed[0].chapter, 1, '应报告被改的章号（数字）')
  const after = await readProject(root, project)
  assert.equal(after.draft.log.at(-1).kind, 'external-change', '日志 kind 应为 external-change')
  const bundle = await store.getBundle(root, project.id)
  assert.ok(bundle.alignment.version.domains.every((d) => d.status === 'untracked'), '版本推进后各账本应为未追踪')
})

test('markSnapshotRestored：整本回滚后推进版本并把账本全部标记已对齐', async (t) => {
  const { root, project } = await newProject(t)
  await store.saveChapter(root, project.id, { title: '第一章', content: '少年走出山村。' })
  await store.markLedgersAligned(root, project.id, ['characters'])

  const result = await store.markSnapshotRestored(root, project.id, '回滚到快照 abc123')
  assert.equal(result.version, 2, '回滚应推进一个稿本版本')
  assert.equal(result.kinds.length, ALIGN_KINDS.length, '回滚后应把全部账本标记为已对齐')
  const saved = await readProject(root, project)
  assert.equal(saved.draft.log.at(-1).kind, 'snapshot-restore', '日志 kind 应为 snapshot-restore')
  assert.match(saved.draft.log.at(-1).note, /abc123/u, '日志备注应带上快照 id')
  const bundle = await store.getBundle(root, project.id)
  assert.equal(bundle.alignment.version.summary.needsAlign, false, '回滚后版本对齐应全部就绪')
})

test('markLedgerTouched：外部恢复账本历史后该域变落后', async (t) => {
  const { root, project } = await newProject(t)
  await store.saveChapter(root, project.id, { title: '第一章', content: '少年走出山村。' })
  await store.markLedgersAligned(root, project.id, [])
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章', content: '少年走出山村。风起了。' })

  const touched = await store.markLedgerTouched(root, project.id, ['events', 'reviews'])
  assert.deepEqual(touched.kinds, ['events'], '非对齐域应被过滤掉')
  const bundle = await store.getBundle(root, project.id)
  const events = bundle.alignment.version.domains.find((d) => d.id === 'events')
  assert.equal(events.status, 'behind', '恢复时间线历史后时间线域应显示落后')
  const characters = bundle.alignment.version.domains.find((d) => d.id === 'characters')
  assert.equal(characters.status, 'behind', '稿本前进后所有账本名义上都落后（未被标记）')
})

test('getBundle：原有计划对齐字段保持不变，只多出 version 子报告', async (t) => {
  const { root, project } = await newProject(t)
  await store.saveChapter(root, project.id, { title: '第一章', content: '少年走出山村。' })
  const bundle = await store.getBundle(root, project.id)
  assert.ok('presetId' in bundle.alignment, '原计划对齐字段 presetId 仍应存在')
  assert.ok('perChapter' in bundle.alignment, '原计划对齐字段 perChapter 仍应存在')
  assert.ok(bundle.alignment.version, '新版本对齐报告应挂在 alignment.version 下')
  assert.ok(Array.isArray(bundle.alignment.version.domains), '版本对齐报告应带 domains 数组')
  assert.equal(typeof needFn(store, 'ensureDraftCurrent', 'lib/store.js'), 'function', 'store 应导出 ensureDraftCurrent')
})
