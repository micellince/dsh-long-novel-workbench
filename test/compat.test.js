/**
 * 0.5.x 兼容回归：真实旧项目里章节是 `chapters/NNNN.md` + YAML frontmatter。
 * 这里锁三件事：
 *   1. 新 store 读旧 .md 正确（正文不含 frontmatter）。
 *   2. 原地写回仍是 .md，frontmatter 的七个已知键 + 未知键都不丢。
 *   3. 旧插件的扁平备份名（`NNNN-<stamp>.md`）仍能被 listChapterHistory 看到。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as store from '../lib/store.js'

const OLD_MD = [
  '---',
  'id: "0007"',
  'title: "第七回 旧稿"',
  'status: "draft"',
  'summary: "旧项目原样。"',
  'location: "长安"',
  'storyTime: "天宝十四载"',
  'characters: ["华羽生","柳含烟"]',
  'customKey: "未知字段要保留"',
  '---',
  '',
  '第一段正文。',
  '',
  '第二段正文。',
  '',
].join('\n')

test('旧 .md 读得来、写得回、未知 frontmatter 键不丢', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nd-compat-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const project = await store.createProject(root, { title: '旧格式书' })
  const projectId = project.id
  const chaptersDir = join(root, 'projects', projectId, 'chapters')
  await mkdir(chaptersDir, { recursive: true })
  await writeFile(join(chaptersDir, '0007.md'), OLD_MD, 'utf8')

  const chapter = await store.readChapter(root, projectId, 7)
  assert.equal(chapter.format, 'md')
  assert.equal(chapter.text, '第一段正文。\n\n第二段正文。\n')
  assert.equal(chapter.meta.title, '第七回 旧稿')
  assert.deepEqual(chapter.meta.characters, ['华羽生', '柳含烟'])
  assert.equal(chapter.meta.customKey, '未知字段要保留')

  // 原地写回：仍是 .md，没有新建 .txt
  const saved = await store.saveChapter(root, projectId, 7, `${chapter.text}\n第三段新增。\n`, {}, {
    baseHash: chapter.meta.contentHash,
    format: 'md',
    source: 'test',
  })
  assert.equal(saved.format, 'md')
  assert.ok(saved.backup, '覆盖旧正文前应先备份上一版')
  assert.match(saved.backup, /\.backups\/0007\//)

  const files = (await readdir(chaptersDir)).sort()
  assert.ok(files.includes('0007.md'))
  assert.equal(files.includes('0007.txt'), false, '不要在 md 章节旁新建 txt')
  assert.ok(saved.contentHash)

  const raw = await readFile(join(chaptersDir, '0007.md'), 'utf8')
  assert.match(raw, /customKey: "未知字段要保留"/)
  for (const key of ['id', 'title', 'status', 'summary', 'location', 'storyTime', 'characters']) {
    assert.match(raw, new RegExp(`^${key}:`, 'm'), `frontmatter 缺 ${key}`)
  }
  assert.match(raw, /第三段新增。/)

  const reread = await store.readChapter(root, projectId, 7)
  assert.match(reread.text, /第三段新增。/)
  assert.equal(reread.format, 'md')
})

test('旧插件的扁平备份名仍可见，新备份在子目录里', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nd-compat-hist-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const project = await store.createProject(root, { title: '备份兼容书' })
  const projectId = project.id
  const chaptersDir = join(root, 'projects', projectId, 'chapters')
  await mkdir(chaptersDir, { recursive: true })
  await writeFile(join(chaptersDir, '0001.md'), OLD_MD.replace('0007', '0001'), 'utf8')

  // 旧插件命名：.backups/0001-2026-01-02T03-04-05-678Z.md
  const backupsDir = join(root, 'projects', projectId, '.backups')
  await mkdir(backupsDir, { recursive: true })
  await writeFile(join(backupsDir, '0001-2026-01-02T03-04-05-678Z.md'), OLD_MD.replace('0007', '0001'), 'utf8')

  // 新 store 存一次 → 产生子目录备份
  const chapter = await store.readChapter(root, projectId, 1)
  await store.saveChapter(root, projectId, 1, '改过的正文。\n', {}, { baseHash: chapter.meta.contentHash, format: 'md', source: 'test' })

  const history = await store.listChapterHistory(root, projectId, 1)
  const sources = new Set(history.map((row) => row.source))
  assert.ok(sources.has('0.5'), `应能列出旧扁平备份，实际 source=${[...sources]}`)
  assert.ok(sources.has('0.6'), `应能列出新备份，实际 source=${[...sources]}`)
  const version = await store.readChapterVersion(root, projectId, 1, history[0].version)
  assert.ok(version.text.length > 0)
})

test('旧 .md 章节也能走「审阅 → 提案 → 批准」并过闸门', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nd-compat-accept-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const project = await store.createProject(root, { title: 'md 提案书' })
  const projectId = project.id
  const chaptersDir = join(root, 'projects', projectId, 'chapters')
  await mkdir(chaptersDir, { recursive: true })
  const body = '华羽生把剑横在膝上，听窗外雨声。\n\n※\n\n门外有人来。\n'
  await writeFile(join(chaptersDir, '0001.md'), `---\nid: "0001"\ntitle: "旧章"\nstatus: "draft"\n---\n\n${body}`, 'utf8')

  const chapter = await store.readChapter(root, projectId, 1)
  const quote = '门外有人来。'
  assert.ok(chapter.text.includes(quote))

  await store.addReviews(root, projectId, [{ chapter: 1, source: 'logic', severity: 'major', quote, issue: '来的是谁没说', suggestion: '点明来人' }])
  const reviews = await store.getReviews(root, projectId)
  const review = (Array.isArray(reviews) ? reviews : reviews.reviews ?? []).find((row) => row.quote === quote)
  assert.ok(review, '审阅应写入')

  const proposal = await store.createProposal(root, projectId, {
    kind: 'patch-paragraph',
    chapter: 1,
    title: '点明来人',
    data: { patches: [{ before: quote, after: '门外有人来，是柳含烟。', why: '点明来人', reviewIds: [review.id] }] },
  })
  const result = await store.acceptProposal(root, projectId, proposal.id)
  assert.equal(result?.ok, true)
  assert.equal(result?.proposal?.status, 'accepted')
  assert.ok(result?.gates, '应返回闸门结果')

  const after = await store.readChapter(root, projectId, 1)
  assert.equal(after.format, 'md')
  assert.match(after.text, /是柳含烟/)
  const raw = await readFile(join(chaptersDir, '0001.md'), 'utf8')
  assert.match(raw, /^---\n[\s\S]*title: "旧章"[\s\S]*\n---\n/, 'frontmatter 应完整保留')

  const reviews2 = await store.getReviews(root, projectId)
  const fixed = (Array.isArray(reviews2) ? reviews2 : reviews2.reviews ?? []).find((row) => row.id === review.id)
  assert.equal(fixed.status, 'fixed')
})
