import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BEAT_RULE,
  HARD_RULES,
  SOURCE_LABEL,
  SOURCE_ORDER,
  attentionDesignWorkorder,
  attentionRecheckWorkorder,
  chapterRewriteWorkorder,
  fullBookProposalWorkorder,
  fullLedgerSyncWorkorder,
  newBookWorkorder,
  globalFixWorkorder,
  proposalFromReviewsWorkorder,
  proposalGroupsWorkorder,
  readerNotePrompt,
  reviewWorkorder,
  runGoalPrompt,
} from '../lib/prompts.js'

const project = { id: 'p1', title: '夜雨将明', genre: '悬疑' }
const chapter = { chapter: 1, title: '雨夜来客', path: 'chapters/0001.txt', words: 230 }
const reviews = [
  { id: 'r1', chapter: 1, source: 'logic', severity: 'major', issue: '动机跳跃', suggestion: '补一个动作', quote: '雨从黄昏就开始下' },
]

/** 所有工作单共有的提交契约。 */
test('每份工作单都带且只带一份 HARD_RULES', () => {
  const prompts = [
    reviewWorkorder({ project, chapters: [chapter] }),
    proposalFromReviewsWorkorder({ project, chapter: 1, reviews }),
    fullBookProposalWorkorder({ project, chapters: [chapter] }),
    runGoalPrompt({ project, run: { kind: 'rewrite', scope: 'book' } }),
    chapterRewriteWorkorder({ project, chapter: 1, text: '雨从黄昏就开始下。' }),
    attentionDesignWorkorder({ project, chapters: [chapter] }),
    attentionRecheckWorkorder({ project, chapters: [chapter] }),
    readerNotePrompt({ project, chapter: 1, notes: [{ quote: '雨从黄昏就开始下', note: '这里好' }] }),
    newBookWorkorder({ project, preset: { name: '冷峻悬疑', genre: '悬疑', plannedChapters: 30, chapterWords: 2600 }, brief: '失忆仵作追凶' }),
    fullLedgerSyncWorkorder({
      project,
      ledger: { characters: [{ name: '林默' }], facts: [{ subject: '元末' }], events: [{ chapter: 3, title: '破城' }] },
      batch: { index: 1, total: 2, from: 1, to: 3, chapters: [{ chapter: 1, title: '雨夜', words: 900 }, { chapter: 2, title: '来客', words: 800 }], words: 1700 },
      full: { from: 1, to: 5, done: 0, total: 2, chapters: 5 },
    }),
  ]
  for (const prompt of prompts) {
    assert.equal(prompt.split(HARD_RULES).length - 1, 1, 'HARD_RULES 必须恰好出现一次（禁止各 prompt 重抄原则）')
    assert.match(prompt, /结论只走工具/)
    assert.match(prompt, /纯文本/)
  }
})

test('审阅类工作单带隔离边界，且四路口径齐全', () => {
  const prompt = reviewWorkorder({ project, chapters: [chapter], sources: SOURCE_ORDER })
  assert.match(prompt, /审阅隔离（硬性边界/)
  assert.match(prompt, /禁止跨作品对比/)
  for (const source of SOURCE_ORDER) assert.ok(prompt.includes(SOURCE_LABEL[source]), `缺少 ${source} 的口径`)
  assert.match(prompt, /novel_desk_review/)
  assert.match(prompt, /quote 必须逐字摘自当前正文/)
  // novel_desk_write 只允许在共享 HARD_RULES 里被提及一次（那是全局规则，不是本单任务）
  assert.equal((prompt.match(/novel_desk_write/g) || []).length, 1, '审阅工作单本身不该让 AI 改正文')
})

test('提案工作单要求 before 逐字命中、且不内联大段正文', () => {
  const prompt = proposalFromReviewsWorkorder({ project, chapter: 1, reviews })
  assert.match(prompt, /patch-paragraph/)
  assert.match(prompt, /novel_desk_propose/)
  assert.match(prompt, /逐字/)
  assert.ok(prompt.includes('雨从黄昏就开始下'), '给定的审阅 quote 应作为材料出现')
  assert.ok(prompt.length < 6000, '工作单不应把正文大段内联进来')
})

test('全文动作工作单限定 6 个工具里的 write/run，并禁止直接改文件', () => {
  const prompt = runGoalPrompt({ project, run: { kind: 'rewrite', scope: 'book', runId: 'r-1' } })
  assert.match(prompt, /novel_desk_write/)
  assert.match(prompt, /novel_desk_run/)
  assert.match(prompt, /不要直接改任何文件/)
  assert.match(prompt, /※/, '场景分隔必须写死 ※（纯文本）')
})

test('注意力工作单带四拍满分口径，复测不透露旧分', () => {
  const design = attentionDesignWorkorder({ project, chapters: [chapter] })
  assert.ok(design.includes(BEAT_RULE))
  assert.match(design, /一次只交 1 章，用扁平参数/)
  assert.match(design, /op="design", chapter=章号/)
  assert.match(design, /novel_desk_attention/)
  const recheck = attentionRecheckWorkorder({ project, chapters: [chapter] })
  assert.match(recheck, /复测/)
  assert.doesNotMatch(recheck, /上次得分|旧分/, '复测工作单不得透露旧分，避免凑分')
})

test('冷读打分工作单：零上下文 + 只给章节路径 + 作者填的打分说明必须进 prompt', () => {
  const blank = attentionRecheckWorkorder({ project, chapters: [chapter] })
  // 冷读边界：独立会话、零上下文、只给指定章节地址
  assert.match(blank, /独立会话 · 零上下文/)
  assert.match(blank, /只给你「指定章节的路径」和「作者的打分说明」/)
  assert.match(blank, /不提供剧情梗概、前文、历史分数、修改记录、账本或大纲/)
  assert.match(blank, /chapters\/0001\.txt/, '章节清单必须带可读路径')
  // 没填说明时给默认口径，不假装作者写过
  assert.match(blank, /作者没指定额外说明：按四拍口径完整冷读打分。/)
  // user 填的打分说明必须原样出现在 prompt 里
  const note = '只看读者会不会追下去；别管文笔，重点记下弃读点。'
  const withFocus = attentionRecheckWorkorder({ project, chapters: [chapter], focus: note })
  assert.ok(withFocus.includes(note), '作者填写的打分说明不能丢')
  assert.match(withFocus, /## 本次打分说明（作者指定/)
  assert.match(withFocus, /四拍口径不变/)
  // 说明里出现「旧分」字样也不影响零上下文规则本身
  assert.match(withFocus, /禁止参考任何历史分数或历史补丁/)
  // 提交格式：每章一次扁平调用，防多章嵌套 JSON 解析失败（2026-10-25 真实事故）
  assert.match(withFocus, /每打完一章立刻提交一次；一次只交 1 章/)
  assert.match(withFocus, /op="measured", chapter=章号, score=73, breakdown=\{hook:15/)
  assert.match(withFocus, /多章拼成一个大的嵌套 JSON 很容易解析失败、整轮作废/)
})

test('工作单是纯函数：同样输入两次生成同样文本', () => {
  const a = reviewWorkorder({ project, chapters: [chapter] })
  const b = reviewWorkorder({ project, chapters: [chapter] })
  assert.equal(a, b)
})

test('开新书工作单：世界/人物/大纲都走 ledger-fix 提案，带上作者原话与预设口径', () => {
  const prompt = newBookWorkorder({
    project: { id: 'p1', title: '夜雨将明', genre: '悬疑' },
    preset: { name: '冷峻悬疑', genre: '悬疑', plannedChapters: 30, chapterWords: 2600, pov: '第一人称限知', tone: '冷峻' },
    brief: '失忆仵作追查连环命案，风格要冷',
  })
  assert.match(prompt, /ledger-fix/)
  assert.match(prompt, /失忆仵作追查连环命案，风格要冷/)
  assert.match(prompt, /冷峻悬疑/)
  assert.match(prompt, /30 章/)
  assert.match(prompt, /不写正文/)
  for (const kind of ['world', 'locations', 'characters', 'facts', 'foreshadow', 'conflicts', 'outlines']) {
    assert.match(prompt, new RegExp(kind))
  }
})

test('自定义方案工作单：先出方案（presets 提案），再生成设定与大纲', () => {
  const prompt = newBookWorkorder({
    project: { id: 'p2', title: '雾城' },
    preset: { id: 'preset-ai-custom', name: '自定义（让 AI 定）', custom: true },
    brief: '民国雾城，一名女法医追查连环失踪案',
  })
  assert.match(prompt, /自定义/)
  assert.match(prompt, /"presets"/)
  assert.match(prompt, /AI 自定义方案/)
  assert.match(prompt, /24|章数|篇幅/)
  assert.match(prompt, /ledger-fix/)
  assert.match(prompt, /不写正文/)
  assert.equal(prompt.split(HARD_RULES).length - 1, 1)
})

test('全书账本同步工作单：批次进度、账本现状、防重复造条目、只提账本提案', () => {
  const prompt = fullLedgerSyncWorkorder({
    project,
    ledger: {
      characters: [{ name: '林默' }, { name: '沈怀瑾' }],
      locations: [{ name: '泉州' }],
      facts: [{ subject: '元末', attribute: '年代' }],
      events: [{ chapter: 3, title: '破城' }],
      outlines: [],
      highlights: [],
      foreshadow: [],
      conflicts: [],
    },
    batch: {
      index: 2,
      total: 5,
      from: 7,
      to: 12,
      chapters: [{ chapter: 7, title: '雨夜', words: 2400 }, { chapter: 8, title: '来客', words: 2300 }],
      words: 4700,
    },
    full: { from: 1, to: 40, done: 1, total: 5, chapters: 40 },
  })
  assert.match(prompt, /【全书账本同步工作单】第 2\/5 批 · 第7–12章/)
  assert.match(prompt, /全书：共 40 章/)
  assert.match(prompt, /约 4700 字/)
  assert.match(prompt, /人物 2/)
  assert.match(prompt, /最近的事件：第3章破城/)
  assert.match(prompt, /林默/)
  assert.match(prompt, /第7章《雨夜》/)
  assert.match(prompt, /ledger-fix/)
  for (const kind of ['events', 'characters', 'facts', 'locations', 'foreshadow', 'conflicts', 'highlights', 'outlines']) {
    assert.match(prompt, new RegExp(kind))
  }
  assert.match(prompt, /本批已同步/)
  assert.match(prompt, /不要改正文/)

  // 空账本：明确告诉 AI 这批要负责把基础条目建起来
  const empty = fullLedgerSyncWorkorder({
    project,
    ledger: {},
    batch: { index: 1, total: 1, from: 1, to: 3, chapters: [{ chapter: 1, title: '', words: 900 }] },
    full: { chapters: 3, done: 0, total: 1 },
  })
  assert.match(empty, /账本还是空的/)
})

// ── 0.6.4：章节选择全量列出 / 分章提案 / 全局修改 ─────────────

const chapters13 = Array.from({ length: 13 }, (_, i) => ({
  chapter: i + 1,
  title: `第${i + 1}章标题`,
  words: 2000 + i,
  path: `chapters/${String(i + 1).padStart(4, '0')}.txt`,
}))

test('reviewWorkorder：用户选定的 13 章全部列出（不截断）且每行带可读路径', () => {
  const prompt = reviewWorkorder({ project, chapters: chapters13 })
  assert.match(prompt, /用户选定的 13 章（不是系统默认章数；只审下面清单里的章节）/)
  assert.match(prompt, /共 13 章待审/)
  const listed = prompt.split('\n').filter((line) => /^- 第\d+章《/.test(line))
  assert.equal(listed.length, 13, `13 章必须全部列出，实际 ${listed.length} 行：\n${listed.join('\n')}`)
  for (const row of chapters13) {
    const line = listed.find((text) => text.startsWith(`- 第${row.chapter}章《${row.title}》`))
    assert.ok(line, `缺少第${row.chapter}章清单行`)
    assert.ok(line.includes(row.path), `第${row.chapter}章清单行缺路径：${line}`)
  }
  // 旧界面默认只审 5 章；工作单必须明确禁止 Agent 自行缩范围
  assert.match(prompt, /不要自行缩小范围/)
  assert.match(prompt, /novel_desk_read\(op="chapter", chapter=N\)/)
})

test('reviewWorkorder：没选章节时明确让作者选，不悄悄默认 5 章', () => {
  const prompt = reviewWorkorder({ project, chapters: [] })
  assert.match(prompt, /未指定章节/)
  assert.match(prompt, /不要自定义默认章数/)
  // scope=book 时才走整本
  assert.match(reviewWorkorder({ project, chapters: [], scope: 'book' }), /整本书（用户选定全文/)
})

const groupReviews = [
  { id: 'r1', chapter: 1, source: 'logic', severity: 'major', issue: '动机跳跃', suggestion: '补一个动作', quote: '雨从黄昏就开始下' },
  { id: 'r2', chapter: 1, source: 'reader', severity: 'minor', issue: '这里容易弃读', suggestion: '提前抛线索', quote: '门外没有动静' },
  { id: 'r9', chapter: 3, source: 'attention', severity: 'major', issue: '章末没有钩子', suggestion: '加一句悬念', quote: '城门在夜里开了' },
]

test('proposalGroupsWorkorder：一章一条 patch-paragraph，after 必须是成文正文且禁编辑指令', () => {
  const groups = [
    { chapter: 1, title: '雨夜来客', path: 'chapters/0001.txt', reviews: groupReviews.slice(0, 2) },
    { chapter: 3, title: '城门', path: 'chapters/0003.txt', reviews: groupReviews.slice(2) },
  ]
  const prompt = proposalGroupsWorkorder({ project, groups, focus: '动机要更狠' })
  assert.match(prompt, /【审阅 → 分章提案工作单】/)
  assert.match(prompt, /本次处理 2 章、共 3 条审阅意见：第1章、第3章/)
  assert.match(prompt, /### 第1章《雨夜来客》 ｜ chapters\/0001\.txt/)
  assert.match(prompt, /### 第3章《城门》 ｜ chapters\/0003\.txt/)
  for (const id of ['r1', 'r2', 'r9']) assert.match(prompt, new RegExp(`\\[${id}\\]`), `缺审阅 ${id}`)
  assert.match(prompt, /本次重点（作者指定）\n动机要更狠/)
  // after 是成稿正文，不是“建议怎么改”
  assert.match(prompt, /after 必须是「改好后的正文」/)
  assert.match(prompt, /禁止在 after\/why 里写编辑指令或说明文字/)
  assert.match(prompt, /不许「改成…」「建议…」「二选一」「补一次…」「这里应该…」/)
  assert.match(prompt, /要改就直接给出改后的句子/)
  // 每条 patch 挂 reviewIds；每章只提交一条提案
  assert.match(prompt, /一条 patch 必须挂对应审阅的 reviewIds/)
  assert.match(prompt, /每一章提交一条 kind="patch-paragraph"/)
  assert.match(prompt, /data=\{patches:\[\{before, after, why, reviewIds\}\]\}/)
  assert.match(prompt, /before 必须逐字复制当前正文（4–600 字/)
})

test('proposalGroupsWorkorder：空组时给出空态，不编造章节', () => {
  const prompt = proposalGroupsWorkorder({ project, groups: [] })
  assert.match(prompt, /本次处理 0 章、共 0 条审阅意见/)
  assert.match(prompt, /（没有待处理审阅）/)
})

test('globalFixWorkorder：先 opinion 再跨章 book-fix 补丁，章节清单带路径', () => {
  const globalReviews = [
    { id: 'g1', chapter: 0, source: 'logic', severity: 'blocker', issue: '全书时间线错位：十年前与元末对不上', suggestion: '统一成元末十年前' },
    { id: 'g2', chapter: 0, source: 'reader', severity: 'major', issue: '每章开头都在复述上章结尾', suggestion: '删复述直接进场景' },
  ]
  const prompt = globalFixWorkorder({ project, chapters: chapters13, reviews: globalReviews, focus: '时间线与章首' })
  assert.match(prompt, /【全局修改工作单】/)
  assert.match(prompt, /全书共 13 章；本次选中的全局审阅 2 条/)
  assert.match(prompt, /审阅隔离（硬性边界/)
  assert.match(prompt, /本次重点（作者指定）\n时间线与章首/)
  // 13 章全列、每行带 path
  for (const row of chapters13) {
    assert.ok(prompt.includes(`第${row.chapter}章《${row.title}》 ｜ ${row.words} 字 ｜ ${row.path}`), `缺第${row.chapter}章清单行`)
  }
  // 每个全局问题一条 book-fix 提案（作者可逐条批准），不是合成一条大提案
  assert.match(prompt, /每个全书级问题各出一条 book-fix 提案，分别批准、分别改/)
  assert.match(prompt, /一条全局审阅至少提交一条 kind="book-fix" 提案/)
  assert.match(prompt, /本次 2 条审阅 → 通常 2 条提案/)
  assert.match(prompt, /title="全局修改 1\/2：主题"/)
  assert.match(prompt, /同一处原文只能出现在一条提案里/)
  assert.match(prompt, /已并入 <提案标题>/)
  assert.match(prompt, /不要提交 patches 为空的提案/)
  assert.match(prompt, /kind="book-fix"、chapter=0：data=\{opinion, patches:\[\{chapter, before, after, why, reviewIds\}\]\}/)
  assert.match(prompt, /patches 不能为空/)
  assert.match(prompt, /after 是最终正文/)
  assert.match(prompt, /禁止「改成…」「建议…」「二选一」「补一次…」这类编辑指令或说明文字/)
  assert.match(prompt, /reviewIds 必须挂上它回应的全局审阅 id/)
  assert.match(prompt, /novel_desk_propose\(projectId, kind="book-fix", chapter=0, title="全局修改 1\/2：主题"/)
  for (const id of ['g1', 'g2']) assert.match(prompt, new RegExp(`\\[${id}\\]`), `缺全局审阅 ${id}`)
})
