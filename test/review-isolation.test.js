/**
 * 所有审阅硬隔离（v0.5.2，未发布）：零上下文首读 / 提分工作单 / 复测单 / 全文重新审阅 / 按审稿出提案
 * 都必须只读本书隔离区副本，prompt 带统一硬边界，且绝不出现其他作品。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import {
  REVIEW_ISOLATION_LINES,
  REVIEW_ISOLATION_NOTICE_LINES,
  attentionFixWorkorder,
  attentionRecheckWorkorder,
  buildFullBookReviewPrompt,
  buildHandoffPrompt,
  prepareReviewSandbox,
  startFullBookReview,
} from '../index.js'
import { makeRoot } from './helpers.js'

const BODY_A = '雪落了一夜，林砚在破庙里等一封不会有人送来的信。\n\n他把信纸折好塞进怀里，没有点火，也没有出门。'
const BODY_B = '城门口盘查忽然紧了，沈照把刀藏在柴捆底下。\n\n他走出十步，背后有人叫出了他十年前的旧名。'
const OTHER_BOOK_BODY = '鱼龙舞：妖刀记前传，洛阳城中一盏不灭的灯。'

function useTempRoot(t, root) {
  const previous = process.env.STORY_DESK_ROOT
  process.env.STORY_DESK_ROOT = root
  t.after(() => {
    if (previous === undefined) delete process.env.STORY_DESK_ROOT
    else process.env.STORY_DESK_ROOT = previous
  })
}

async function seeded(t) {
  const root = await makeRoot(t)
  useTempRoot(t, root)
  const project = await store.createProject(root, { name: '隔离作品', genre: '武侠' })
  await store.saveChapter(root, project.id, { id: '0001', title: '第一章 破庙', content: BODY_A })
  await store.saveChapter(root, project.id, { id: '0002', title: '第二章 城门', content: BODY_B })
  // 同一 root 下再放一本别的书，任何审阅 prompt 都不能碰到它
  const other = await store.createProject(root, { name: '鱼龙舞' })
  await store.saveChapter(root, other.id, { id: '0001', title: '第一回', content: OTHER_BOOK_BODY })
  return { root, project }
}

function attentionRecord(chapter, overrides = {}) {
  return {
    id: 'att-' + String(chapter).padStart(4, '0'),
    chapter,
    type: 'mystery',
    score: 66,
    designScore: 80,
    verdict: '犹豫',
    weakest: 'cliff',
    breakdown: { hook: 16, tension: 13, payoff: 15, cliff: 9 },
    dropPoints: [{ quote: '他把信纸折好塞进怀里', why: '刚说不能留信，读者会出戏' }],
    status: 'verified',
    ...overrides,
  }
}

/** 统一断言：有硬边界、路径只在隔离区、绝不出现别的书名。 */
function assertIsolated(prompt, root) {
  assert.ok(prompt.includes(REVIEW_ISOLATION_LINES[0]), 'prompt 必须带统一的「审阅隔离」标题')
  assert.ok(prompt.includes('绝对禁止跨作品对比'), 'prompt 必须写死禁止跨作品对比')
  assert.ok(prompt.includes(join(root, '.review-workspaces')), '给 AI 的路径必须指向隔离区')
  assert.ok(!prompt.includes(join(root, 'projects')), 'prompt 里不能出现作品原始目录（那里能看到整本书的账本与别的书）')
  assert.ok(!prompt.includes('鱼龙舞'), 'prompt 不能出现其他作品名')
  assert.ok(!prompt.includes(OTHER_BOOK_BODY), 'prompt 不能出现其他作品正文')
}

test('prepareReviewSandbox：隔离区只有本书章节副本，绝不带别的书与历史文件', async (t) => {
  const { root, project } = await seeded(t)
  const bundle = await store.getBundle(root, project.id)
  const sandbox = prepareReviewSandbox(root, bundle, null)

  assert.match(sandbox.dir, /\.review-workspaces/)
  assert.equal(sandbox.chapterFiles.length, 2)
  assert.deepEqual(await readdir(sandbox.dir), ['chapters'])
  assert.deepEqual(await readdir(join(sandbox.dir, 'chapters')), ['0001.md', '0002.md'])
  assert.equal(await readFile(join(sandbox.dir, 'chapters', '0001.md'), 'utf8'), BODY_A)
  assert.ok(sandbox.chapterFiles.every((row) => row.path.startsWith(sandbox.dir)))
  const allBody = (await Promise.all(sandbox.chapterFiles.map((row) => readFile(row.path, 'utf8')))).join('\n')
  assert.ok(!allBody.includes(OTHER_BOOK_BODY), '隔离区副本里不能混进别的书')

  const partial = prepareReviewSandbox(root, bundle, [2])
  assert.deepEqual(await readdir(join(partial.dir, 'chapters')), ['0002.md'], '指定章号时只复制这些章')
})

test('buildFullBookReviewPrompt：通读全书的 prompt 也只给隔离区清单', async (t) => {
  const { root, project } = await seeded(t)
  const bundle = await store.getBundle(root, project.id)
  const sandbox = prepareReviewSandbox(root, bundle, null)
  const prompt = buildFullBookReviewPrompt(bundle, { focus: ['节奏'], sandbox })

  assertIsolated(prompt, root)
  assert.match(prompt, /章节文件清单（唯一允许读取的文件）/, '通读也必须给只读清单')
  assert.ok(prompt.includes(join(sandbox.dir, 'chapters', '0001.md')))
  assert.ok(prompt.includes(join(sandbox.dir, 'chapters', '0002.md')))
  assert.ok(!prompt.includes(BODY_A), '通读也不把正文贴进 prompt')
})

test('零上下文首读（单章 / 全书）：prompt 同样硬隔离', async (t) => {
  const { root, project } = await seeded(t)
  const bundle = await store.getBundle(root, project.id)

  const single = buildHandoffPrompt(bundle, { task: 'fresh-read', chapter: 1 }, root)
  assertIsolated(single, root)
  assert.ok(single.includes(join(root, '.review-workspaces')))

  const book = buildHandoffPrompt(bundle, { task: 'fresh-read', scope: 'book' }, root)
  assertIsolated(book, root)
  assert.ok(book.includes(join(root, '.review-workspaces')))
})

test('提分工作单 / 复测单：也走隔离区，禁止翻账本与别的书', async (t) => {
  const { root, project } = await seeded(t)
  await store.upsertEntity(root, project.id, 'attention', attentionRecord(1, { recheckPending: true }))
  await store.upsertEntity(root, project.id, 'attention', attentionRecord(2))
  const bundle = await store.getBundle(root, project.id)

  const workorder = attentionFixWorkorder(bundle, {}, root)
  assertIsolated(workorder, root)
  assert.ok(workorder.includes(join(root, '.review-workspaces')))

  const batch = attentionFixWorkorder(bundle, { all: true }, root)
  assertIsolated(batch, root)

  const recheck = attentionRecheckWorkorder(bundle, {}, root)
  assertIsolated(recheck, root)
  assert.ok(recheck.includes(join(root, '.review-workspaces')))
})

test('按审稿出提案：先给的章节文件也是隔离区副本', async (t) => {
  const { root, project } = await seeded(t)
  await store.upsertEntity(root, project.id, 'reviews', {
    id: 'rev-1', chapter: 1, dimension: '文笔', severity: 'major', issue: '句子太整', suggestion: '改成动作',
  })
  const bundle = await store.getBundle(root, project.id)
  const prompt = buildHandoffPrompt(bundle, { task: 'review-to-proposals', reviewIds: ['rev-1'] }, root)

  assertIsolated(prompt, root)
  assert.match(prompt, /涉及章节的正文文件（唯一允许读取的文件）/, '必须告诉 AI 只读哪些文件')
  assert.ok(prompt.includes(join(root, '.review-workspaces')))
})

test('带上下文的审阅任务（全文审阅/导入审阅/单章审阅/按审稿修改）也带隔离边界', async (t) => {
  const { root, project } = await seeded(t)
  const bundle = await store.getBundle(root, project.id)

  for (const task of ['full-review', 'import-review', 'review-chapter', 'review-fix']) {
    const prompt = buildHandoffPrompt(bundle, { task, chapter: 1 }, root)
    assert.ok(prompt.includes(REVIEW_ISOLATION_NOTICE_LINES[0]), task + ' 必须带审阅隔离标题')
    assert.ok(prompt.includes('只审当前这一本书'), task + ' 必须限定只审本书')
    assert.ok(prompt.includes('绝对禁止跨作品对比'), task + ' 必须禁止跨作品对比')
    assert.ok(!prompt.includes('鱼龙舞'), task + ' prompt 不能出现其他作品名')
    assert.ok(!prompt.includes(OTHER_BOOK_BODY), task + ' prompt 不能出现其他作品正文')
    assert.ok(!prompt.includes('只能读下面列出的章节文件'), task + ' 带上下文的审阅不该要求只读章节清单')
  }

  const writing = buildHandoffPrompt(bundle, { task: 'continue-chapter', chapter: 1 }, root)
  assert.ok(!writing.includes(REVIEW_ISOLATION_NOTICE_LINES[0]), '写作任务不加审阅隔离边界')
})

test('startFullBookReview：新建会话的 workspace 就是隔离区', async (t) => {
  const { root, project } = await seeded(t)
  const before = await store.getBundle(root, project.id)
  if (before.presets?.[0]) await store.updateProject(root, project.id, { activePresetId: before.presets[0].id })
  const created = []
  const prompts = []
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          async resolveByPath() { return null },
          async create(dir, title) { created.push({ dir, title }); return { id: 'ws-iso' } },
        }
      }
      if (name === 'sessionController') {
        return {
          async create(options) { created.push({ session: options }); return { sessionId: 'sess-1' } },
          async prompt(request) { prompts.push(request) },
        }
      }
      return undefined
    },
  }
  const result = await startFullBookReview(root, project.id, { focus: '节奏' }, ctx)

  assert.equal(result.sessionId, 'sess-1')
  assert.equal(result.chapterCount, 2)
  assert.match(result.workspacePath, /\.review-workspaces/)
  assert.equal(created[0].dir, result.workspacePath, '必须为隔离区注册 workspace')
  assert.match(created[0].title, /隔离作品/, 'workspace 标题带作品名')
  assert.equal(created[1].session.workspaceId, 'ws-iso', '新会话必须开在隔离区 workspace 里')
  assert.equal(prompts.length, 1)
  assertIsolated(prompts[0].content[0].text, root)
})
