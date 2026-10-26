/**
 * 工作单 prompt：四路审阅 / 提案 / 全文动作 / 注意力 / 读者批注。
 *
 * 约定：
 * - 共享硬要求只写一份 `HARD_RULES`，各工作单末尾统一拼接，禁止在各 prompt 里重复抄原则长文。
 * - 工作单只给「要做什么 + 提交格式 + 材料路径」，正文大块不内联（让 Agent 自己 read）。
 * - 提案/正文 payload 一律纯文本：禁 Markdown，场景分隔用 ※。
 * - 写正文/改写类工作单第一行必须是 `ATTENTION_PRINCIPLE`（ATTENTION IS ALL YOU NEED）；
 *   冷读复测（attentionRecheckWorkorder）例外：保持读者视角纯净，不注入任何原则。
 */

import { BEAT_LABEL, BEATS, byChapter, deficitsOf, designGap, stats, weakActions } from './attention.js'

/** 审阅隔离（硬性边界，所有审阅类工作单共用）。 */
const ISOLATION = [
  '## 审阅隔离（硬性边界，违反任何一条本次审阅作废）',
  '1. 只读本工作单列出的章节：按章节清单里的路径 read，或调用 novel_desk_read(op="chapter", chapter=N)。如果工作单明确要求「判断是否影响全文/跨章」，允许额外只读相关章节做确认（不得把它们当成本次审阅范围）；禁止读其他作品、旧基线、历史报告。',
  '2. 禁止跨作品对比：不得把其他作品当「人类对照」，输出里不得出现其他书名或人物名。',
  '3. 只提交审阅/提案/打分，不改正文文件；拿不到材料就停下来问作者。',
]

/** 四路来源的中文口径（与 store 派生规则一致，写新条目时 source 用这四路）。 */
import { roleForSource, roleBriefLines, ROLE_BY_ID } from './roles.js'

export const SOURCE_LABEL = {
  logic: '逻辑（情节因果 / 人物动机 / 连续性 / 事实自洽）',
  attention: '注意力（钩子 / 张力 / 回报 / 章末牵引 / 弃读点）',
  'ai-style': 'AI 味（机器痕迹 / 套话 / 节奏单一 / 文笔）',
  reader: '读者（普通读者第一反应；只由作者批注产生）',
}

export const SOURCE_ORDER = ['logic', 'ai-style', 'reader']

/** 四拍口径（与 lib/attention.js 一致，数值满分 20/20/30/30）。 */
export const BEAT_RULE = '四拍满分：钩子 hook 20 ｜ 张力 tension 20 ｜ 回报 payoff 30 ｜ 章末牵引 cliff 30；四拍文字设计写在 hook/tension/payoff/cliff 字段，数值写进 breakdown，score = sum(breakdown)。'

/** 注意力主类型（每章一个主类型；同类型不连续超过 3 章）。 */
export const ATTENTION_TYPES = ['event', 'emotion', 'language', 'mystery', 'relationship']

/** 主类型中文名。 */
export const ATTENTION_TYPE_LABEL = {
  event: '事件（外部冲突/变故）',
  emotion: '情绪（关系与内心）',
  language: '语言（文风与叙述）',
  mystery: '悬念（未解之谜）',
  relationship: '关系（人物互动）',
}

/**
 * 创作一号原则：所有「写正文 / 改写」类工作单的第一行。
 * 冷读复测（attentionRecheckWorkorder）禁止注入，保持读者视角纯净。
 */
export const ATTENTION_PRINCIPLE = '> ATTENTION IS ALL YOU NEED——怎么吸引读者怎么来，一切为读者服务；事实自洽是底线，不是目标。动笔前先写一句本章的注意力目标：这一章靠什么把读者拽着往下读。'

/**
 * 唯一一份共享硬要求。所有工作单用 `withRules(lines)` 拼接，禁止各 prompt 重抄。
 */
export const HARD_RULES = [
  '## 硬性要求（所有提交都适用）',
  '1. 结论只走工具：审阅用 novel_desk_review，提案用 novel_desk_propose，正文用 novel_desk_write；不要直接改任何文件。',
  '2. 参数 projectId 与 chapter：下文已给出就直接用；只有一部作品时可省略 projectId。',
  '3. 审阅 source 只能是 logic / attention / ai-style / reader 之一；quote 必须逐字摘自当前正文（≥4 字，且在该章只出现一次）。',
  '4. 提案正文 payload 必须是纯文本：禁止 Markdown 语法（# ** - > 反引号 表格），段落之间空行，场景分隔用 ※。',
  '5. 拿不到材料（章节文件/正文）就停下说明缺什么，不要自己编造正文内容。',
].join('\n')

/** 作品一行摘要。 */
function projectLine(project) {
  const p = project ?? {}
  const name = p.title || p.name || p.id || '未命名'
  return `# 作品：${name}${p.id ? `（projectId=${p.id}）` : ''}`
}

/** 章节清单行（有路径给路径，没有就说明章号）。 */
function chapterLines(chapters) {
  const rows = Array.isArray(chapters) ? chapters : []
  if (rows.length === 0) return ['（未提供章节清单）']
  return rows.map((row, index) => {
    const chapter = Number(row?.chapter ?? row?.id ?? row?.chapterNumber ?? index + 1)
    const title = String(row?.title ?? '')
    const words = Number(row?.words ?? row?.wordCount ?? 0) || 0
    const path = String(row?.path ?? row?.file ?? '').trim()
    return `- 第${chapter}章${title ? `《${title}》` : ''}${words > 0 ? ` ｜ ${words} 字` : ''}${path ? ` ｜ ${path}` : ''}`
  })
}

/** 章节正文路径：优先条目自带 path/file；否则按作品工作区推导 chapters/NNNN.txt。 */
function chapterPathOf(project, row) {
  const given = String(row?.path ?? row?.file ?? '').trim()
  if (given) return given
  const workspacePath = String(project?.workspacePath ?? project?.rootPath ?? '').trim()
  if (!workspacePath) return ''
  const chapter = Number(row?.chapter ?? row?.id ?? row?.chapterNumber ?? 0)
  if (!Number.isInteger(chapter) || chapter < 1) return ''
  return `${workspacePath.replace(/[\\/]+$/, '')}/chapters/${String(chapter).padStart(4, '0')}.txt`
}

/** 给章节清单补 path：工作单不内联正文，Agent 必须知道去哪读。 */
function withChapterPaths(project, chapters) {
  const rows = Array.isArray(chapters) ? chapters : []
  return rows.map((row) => {
    const item = row && typeof row === 'object' ? row : { chapter: row }
    return { ...item, path: chapterPathOf(project, item) }
  })
}

/** 统一拼接：标题 → 正文 → 硬性要求。 */
function withRules(lines) {
  return [...lines, '', HARD_RULES].join('\n')
}

/** 从章节/注意力条目里取数值四拍（兼容 0.5.x attention.json 数组形状与本轮上下文对象）。 */
function beatNumbers(record) {
  const breakdown = record?.breakdown && typeof record.breakdown === 'object' ? record.breakdown : null
  if (breakdown) {
    return ['hook', 'tension', 'payoff', 'cliff'].map((key) => `${key} ${Number(breakdown[key]) || 0}`).join(' / ')
  }
  return ''
}

function attentionLine(record) {
  if (!record) return '- 本章还没有注意力记录（先设计，再打分）'
  const textBeats = ['hook', 'tension', 'payoff', 'cliff']
    .map((key) => `${key}：${String(record[key] ?? '未写').slice(0, 60)}`)
    .join(' ｜ ')
  const numbers = beatNumbers(record)
  const score = record.score === null || record.score === undefined ? '未测' : `${record.score} 分`
  const design = record.designScore === null || record.designScore === undefined ? '未评' : `${record.designScore} 分`
  const extra = [
    record.weakest ? `最弱 ${record.weakest}` : '',
    record.verdict ? `弃读判断 ${record.verdict}` : '',
    record.recheckPending ? '待复测' : '',
  ].filter(Boolean).join(' ｜ ')
  return `- 实测 ${score} ｜ 设计 ${design}${numbers ? ` ｜ breakdown ${numbers}` : ''}${extra ? ` ｜ ${extra}` : ''}\n  · 文字四拍：${textBeats}`
}

/** 取数值；空/非数返回 null（只用于展示与目标分推算）。 */
function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 分数展示。 */
function scoreText(value) {
  const n = numOrNull(value)
  return n === null ? '未测' : `${Math.round(n)}分`
}

/**
 * 注意力提醒（写正文/改写工作单共用）：只给冷读曲线与一句目标，不给四拍要求。
 * 唯一标准：ATTENTION IS ALL YOU NEED —— 这一章靠什么把读者拽着往下读。
 */
export function attentionBriefLines({ attention, chapters } = {}) {
  const rows = byChapter(attention ?? [])
  const info = stats(rows)
  const chapterRows = Array.isArray(chapters) ? chapters : []
  const chapterNumbers = chapterRows
    .map((row) => Number(row?.chapter ?? row?.id ?? 0))
    .filter((n) => n > 0)
  const recorded = new Set(rows.map((row) => Number(row.chapter)))
  const unscored = chapterNumbers.filter((n) => !recorded.has(n)).length
  const lines = ['## 第一优先级：注意力（ATTENTION IS ALL YOU NEED）']
  lines.push('读者第一：动笔之前先写一句本章的注意力目标——这一章靠什么把读者拽着往下读。不要求四拍、不要求设计分；注意力唯一的验收是冷读分数。')
  if (rows.length === 0) {
    lines.push('- 全书还没有注意力记录：先给要写的章节写一句抓人目标（具体到一个画面、一个问题或一次兑现），再动笔。')
    return lines
  }
  const avgText = info.avg === null ? '—' : `${info.avg} 分`
  lines.push(`- 全书注意力（冷读）：平均 ${avgText}（${info.scored} 章已测 / ${rows.length} 章有记录${chapterNumbers.length ? ` / 待写 ${chapterNumbers.length} 章中 ${unscored} 章未测` : ''}）`)
  const recent = rows.slice(-6)
  lines.push('- 最近 6 章冷读分数：' + recent.map((row) => `第${Number(row.chapter)}章 ${scoreText(row.score)}`).join(' ｜ '))
  const last = rows[rows.length - 1]
  const lastScore = numOrNull(last?.score)
  const prevScore = numOrNull(rows[rows.length - 2]?.score)
  const lastType = String(last?.type ?? '')
  const tail = rows.slice(-4)
  let same = 1
  if (lastType) {
    for (let i = tail.length - 2; i >= 0; i -= 1) {
      if (String(tail[i]?.type ?? '') !== lastType) break
      same += 1
    }
  }
  if (same >= 3) {
    lines.push(`- 疲劳预警：最近 ${same} 章主类型都是「${lastType}」，本章换一种抓人方式。`)
  }
  if (lastScore !== null && prevScore !== null && prevScore - lastScore >= 15) {
    lines.push(`- 疲劳预警：冷读从 ${Math.round(prevScore)} 掉到 ${Math.round(lastScore)}（骤降 ${Math.round(prevScore - lastScore)}），本章先止跌再谈铺垫。`)
  }
  const base = numOrNull(info.avg) ?? 70
  if (lastScore !== null && lastScore < base - 10) {
    lines.push(`- 补强：上一章冷读 ${Math.round(lastScore)} 分，低于全书均值 ${Math.round(base)} 分超过 10 分，本章先把读者拽回来。`)
    if (last?.points && Array.isArray(last.points)) {
      const weak = last.points.filter((point) => point.kind === 'weakness').slice(0, 2)
      for (const point of weak) lines.push(`  · 上章不足：${String(point.comment || '').slice(0, 60)}`)
    }
  }
  return lines
}

// ── ① 四路审阅工作单 ─────────────────────────────────────────

/**
 * 四路审阅工作单（可指定 source 子集；可带作者写的「本次重点」，空则忽略）。
 * scope='book' 表示用户选了整本书；其余情况一律以传入的 chapters 为准（系统不预设章数）。
 * @param {{project:object, chapters:Array, sources?:string[], focus?:string, scope?:string}} input
 */
export function reviewWorkorder({ project, chapters, sources, focus, scope } = {}) {
  const picked = (Array.isArray(sources) && sources.length > 0 ? sources : SOURCE_ORDER)
    .map((source) => String(source))
    .filter((source) => SOURCE_LABEL[source])
  const rows = withChapterPaths(project, chapters)
  const scopeLine = rows.length > 0
    ? `本次范围：用户选定的 ${rows.length} 章（不是系统默认章数；只审下面清单里的章节）`
    : String(scope ?? '') === 'book'
      ? '本次范围：整本书（用户选定全文；逐章读，不要自行按固定章数截取）'
      : '本次范围：未指定章节（先让作者选一章或全文，不要自定义默认章数）'
  const lines = [
    '【AI 意见工作单】独立会话 · 零上下文 · 只审这一本书（注意力走冷读，不在审阅里做）',
    '',
    projectLine(project),
    scopeLine,
    `共 ${rows.length} 章待审。`,
    '',
    '## 先判断范围（重要）',
    '工作单给出的章节只是「本次要处理的起点」，不是判断边界。先判断这条问题是本段 / 本章 / 跨章 / 全书级：',
    '- 如果只是本段的问题：只改本段；',
    '- 如果是跨章/全局问题（人物已死又出现、时间线矛盾、设定前后冲突、主线因果断裂）：允许用 novel_desk_read 读本次范围外的章节**只做确认**，不要顺手审全书；然后提交 **chapter=0 的全书级摘要**（after 留空），并给每个受影响段落各提交一条带地址的按章意见；',
    '- 不要因为工作单只给一章，就把全局问题硬塞进这一章的段里。',
    '',
    ...ISOLATION,
    '',
    '## 本次审阅的路（每路口径不同，分开看、分开提交）',
    ...picked.map((source, index) => `${index + 1}. source=${source}：${SOURCE_LABEL[source]} → 子 agent：${roleForSource(source).name}`),
    '',
    '## 派单（强制，先拿票据再派子 agent）',
    '- 先调 novel_desk_dispatch(projectId, role=对应角色, task=本路审阅任务) 拿 dispatchId；把返回的派单提示交给子 agent。',
    '- 子 agent 的 novel_desk_review 必须带 dispatchId；主对话不要自己提交意见。',
    '',
    '- 按上面的对应关系，把每一路单独派给子 agent；每个子 agent 只拿自己那一路需要的材料，不要把所有路塞进同一个子 agent。',
    '- 同一章不要被多个子 agent 重复整章通读：事实逻辑只拿可疑点，文笔/去 AI 化只拿选中段落；只有冷读（attention 路）整章读。',
    '- 子 agent 返回后，主对话只检查：地址（para/quote）是否合法、after 是否是整段成文、是否超条数/字数；不合格退回重出，不自己改写。',
    '- 主对话不要重读整章：需要核对地址时只 novel_desk_read 读所指那一段（或让子 agent 复核），不要长篇判断要不要读。',
    '',
    ...(picked.length === 1 ? roleBriefLines(roleForSource(picked[0]), { task: `按 source=${picked[0]} 口径审阅清单里的章节` }) : []),
    ...(picked.length === 1 ? [''] : []),
    ...(String(focus ?? '').trim()
      ? ['## 本次重点（作者指定，每条意见都要能回答它；但四路口径照旧，不要只看重点漏掉硬伤）', String(focus).trim().slice(0, 800), '']
      : ['## 本次重点', '作者没指定重点：按四路口径完整审，先硬伤后观感。', '']),
    '## 章节清单',
    ...chapterLines(rows),
    '',
    '## 读法',
    '用 novel_desk_read(op="chapter", chapter=N) 逐章读正文（工作单不内联正文）；也可以直接 read 章节清单里的路径。读不完就停下说明，不要跳过、不要自行缩小范围。',
    '',
    '## 审阅方法（AI 审阅 = 审阅 + 改法，一次交付）',
    '- 逐章读完再提意见；每条意见必须带**地址**：para（正文段号，从 0 开始；标题意见用 anchor="title"）或 quote（该段逐字原文，≥4 字）。',
    '- 每条审阅提交：chapter、source、severity、para 或 quote、issue（问题是什么，≤80 字）、after（**替换后的整段成文**；需要改正文时必填，整段给出，不要只给建议）；不需要改正文（例如纯提示）才留空 after。',
    '- after 必须是能直接替换原文的成文正文：纯文本、禁 Markdown、场景分隔 ※；只改指到的那一段，不要动别的段落。',
    '- 跨章共性问题：chapter=0 只提交摘要（**不要带 after**）；每个受影响段落单独提交一条 chapter>0 + para/quote + after，作者才能直接采纳替换。',
    '- 先提 blocker，再 major；同一段多处问题请合并成一条完整意见（一次改一段，避免同一段被多轮改乱）。',
    '',
    '## 提交格式（每次 1–5 条，分多次调用；别把几十条塞进一个 JSON）',
    'novel_desk_review(projectId, reviews=[{chapter, source, severity, para:5, quote:"该段原文", issue:"问题", after:"替换后的整段成文"}])',
    '- 一次 1–5 条即可：小说文本长，几十条拼一个大 JSON 容易解析失败，整轮会作废。',
    '- 作者在「意见库」逐条看：采纳即替换该段；驳回不写盘。',
  ]
  return withRules(lines)
}

/**
 * 账本同步工作单：核对「改过的章节」与账本（人物卡/时间线/地点/事实/伏笔/冲突/大纲）是否还对得上。
 * 只在正文改动确实碰到账本内容时由界面触发（store.ledgerSignals 判定）。
 * @param {{project:object, chapters:Array}} input
 */
export function ledgerSyncWorkorder({ project, chapters } = {}) {
  const rows = Array.isArray(chapters) ? chapters : []
  const lines = [
    '【账本同步工作单】核对正文改动是否让账本过期',
    '',
    projectLine(project),
    `本次要核对的章：${rows.map((row) => `第${Number(row?.chapter) || 0}章`).join('、') || '（无）'}`,
    '',
    '## 改动信号（系统按「账本里的名字/数字是否变化」粗筛出来的）',
    ...(rows.length > 0
      ? rows.map((row, index) => `${index + 1}. 第${Number(row?.chapter) || 0}章${row?.title ? `《${row.title}》` : ''}：${(Array.isArray(row?.reasons) ? row.reasons : []).join('；') || '（无细节）'}`)
      : ['（没有待同步章节）']),
    '',
    '## 怎么做',
    '- 先 novel_desk_read(op="chapter", chapter=N) 读改动后的正文，再 read(op="ledger") 读账本。',
    '- 逐个判断信号：账本条目是「需要改」「需要新增」还是「只是看起来像、其实无关」。',
    '- 只提真的有依据的改动；没有把握的写成审阅条目（source="logic"），不要硬造事实。',
    '- 不要改正文；账本改动只走提案。',
    '',
    '## 提交格式',
    '- 账本要改 → novel_desk_propose(projectId, kind="ledger-fix", title, summary, items=[{kind:"facts|characters|events|locations|foreshadow|conflicts|outlines|highlights", id, patch}])（新增时 id 留空）。',
    '- 无法自动改 → novel_desk_review(projectId, reviews=[{chapter, source:"logic", severity, quote, issue, suggestion}])。',
    '- 核对完没问题也要回一句「已核对，无需改动」，不要静默。',
  ]
  return withRules(lines)
}

// ── 全书账本同步（正文写完以后） ─────────────────────────────

/** 账本每个 kind 的中文名 + 条目数，一行看完家底。 */
function ledgerCountLine(ledger) {
  const l = ledger && typeof ledger === 'object' ? ledger : {}
  const count = (key) => (Array.isArray(l[key]) ? l[key].length : 0)
  return [
    `人物 ${count('characters')}`,
    `地点 ${count('locations')}`,
    `事实 ${count('facts')}`,
    `事件 ${count('events')}`,
    `伏笔 ${count('foreshadow')}`,
    `冲突 ${count('conflicts')}`,
    `高光 ${count('highlights')}`,
    `大纲 ${count('outlines')}`,
  ].join(' · ')
}

/** 从账本里取若干「已有条目」的名字，避免 AI 重复造轮子。 */
function ledgerExistingLines(ledger) {
  const l = ledger && typeof ledger === 'object' ? ledger : {}
  const names = (key, pick, limit) => {
    const rows = Array.isArray(l[key]) ? l[key] : []
    return rows.map((row) => String(pick(row) ?? '').trim()).filter(Boolean).slice(0, limit)
  }
  const characters = names('characters', (row) => row?.name, 20)
  const locations = names('locations', (row) => row?.name, 15)
  const facts = names('facts', (row) => (row?.subject && row?.attribute ? `${row.subject}·${row.attribute}` : row?.subject), 20)
  const events = (Array.isArray(l.events) ? l.events : [])
    .map((row) => ({ chapter: Number(row?.chapter) || 0, text: String(row?.title ?? row?.event ?? row?.summary ?? '').slice(0, 40) }))
    .filter((row) => row.text)
    .sort((a, b) => a.chapter - b.chapter)
    .slice(-5)
  const lines = []
  if (characters.length) lines.push(`- 已有的人物：${characters.join('、')}${Array.isArray(l.characters) && l.characters.length > characters.length ? ` …共 ${l.characters.length}` : ''}`)
  if (locations.length) lines.push(`- 已有的地点：${locations.join('、')}${Array.isArray(l.locations) && l.locations.length > locations.length ? ` …共 ${l.locations.length}` : ''}`)
  if (facts.length) lines.push(`- 已有的事实（主体·属性）：${facts.join('、')}${Array.isArray(l.facts) && l.facts.length > facts.length ? ` …共 ${l.facts.length}` : ''}`)
  if (events.length) lines.push(`- 最近的事件：${events.map((row) => `${row.chapter ? `第${row.chapter}章` : '（无章号）'}${row.text}`).join('；')}`)
  return lines.length > 0 ? lines : ['（账本还是空的：这一批要负责把基础的人物/地点/时间线建起来）']
}

/**
 * 全书账本同步工作单（分批）：正文已经写完，账本可能停在写作中途。
 * 一批只读一段正文，把事实补进账本；进度由 ledger-sync.json 的 full.batches 记录。
 * @param {{project:object, ledger:object, batch:object, full:object}} input
 */
export function fullLedgerSyncWorkorder({ project, ledger, batch, full } = {}) {
  const b = batch && typeof batch === 'object' ? batch : {}
  const f = full && typeof full === 'object' ? full : {}
  const chapters = Array.isArray(b.chapters) ? b.chapters : []
  const from = Number(b.from) || Number(chapters[0]?.chapter) || 0
  const to = Number(b.to) || Number(chapters[chapters.length - 1]?.chapter) || from
  const label = from === to ? `第${from}章` : `第${from}–${to}章`
  const index = Number(b.index) || 1
  const total = Number(b.total ?? f.total) || 1
  const words = Number(b.words) || 0
  const lines = [
    `【全书账本同步工作单】第 ${index}/${total} 批 · ${label}`,
    '（正文已经写完，账本可能停在写作中途。这一批只做一件事：把正文里的事实补进账本，让账本追上正文。）',
    '',
    projectLine(project),
    `全书：共 ${Number(f.chapters) || chapters.length} 章，本批 ${chapters.length} 章${words > 0 ? `（约 ${words} 字）` : ''}；全书进度：已完成 ${Number(f.done) || 0}/${total} 批`,
    `账本现状：${ledgerCountLine(ledger)}`,
    '',
    '## 本批章节',
    ...chapterLines(chapters),
    '',
    '## 账本现有条目（先看，别重复造）',
    ...ledgerExistingLines(ledger),
    '',
    '## 怎么做',
    '1. 先 novel_desk_read(op="ledger") 读一遍账本，按名字/id 记住已有条目。',
    '2. 逐章 novel_desk_read(op="chapter", chapter=N) 通读本批正文；长章分段读，不要跳读、不要只读开头。',
    '3. 边读边记这些（有正文依据才记，没有就空着）：',
    '   - events：发生了什么、在哪、谁在场、大致时间；patch 至少带 chapter。',
    '   - characters：首次登场 / 身份、关系、能力变化。',
    '   - facts：设定、规则、物件、称谓、数字（年龄 / 距离 / 期限）。',
    '   - locations：新地名、地形、势力范围；world 只在大设定变化时改。',
    '   - foreshadow：埋下的伏笔 / 已回收的伏笔（记 status）。',
    '   - conflicts：正面冲突、阵营变化。',
    '   - highlights：确实写得好的段落（供回看，别滥收）。',
    '   - outlines：正文和原大纲不一致时，改大纲条目对齐正文；新建大纲必须带四拍（type/hook/tension/payoff/cliff）+ designScore。',
    '4. 已有条目与正文矛盾 → 带 id 提交 patch 修正；新增条目 id 留空。',
    '5. 只提有正文依据的改动；拿不准的提审阅条目（source="logic"，quote 必须逐字），不要硬造设定。',
    '',
    '## 提交格式（一批可以多次调用，但别一次塞几百条）',
    `novel_desk_propose(projectId, kind="ledger-fix", title="全书同步 · ${label}", summary="补时间线/人物/地点…", items=[{kind:"events", id:"", patch:{...}}])`,
    '- 能直接改账本就别再提审阅；只有无法自动修的才提 novel_desk_review。',
    '- 不要改正文、不要提正文提案；账本改动只走 ledger-fix 提案。',
    '',
    '## 收尾',
    `- 回一句：${label}的账本已补完，共 N 条改动；并提醒作者批准提案后点「本批已同步」，再发第 ${index + 1} 批（如还有）。`,
  ]
  return withRules(lines)
}

// ── 地图底图方案 ─────────────────────────────────────────────

/**
 * 地图底图工作单：让 AI 结合世界观、地点分布与主角行走路径，给出一版可直接绘制的底图方案。
 * 产出建议写入世界地图的「底图备注」（world.note），不要编造不存在的地形。
 * @param {{project:object, world:object, locations:Array, path:Array}} input
 */
export function mapBackgroundWorkorder({ project, world, locations, path } = {}) {
  const w = world && typeof world === 'object' ? world : {}
  const spots = Array.isArray(locations) ? locations.slice(0, 60) : []
  const walk = Array.isArray(path) ? path.slice(0, 60) : []
  const lines = [
    '【地图底图工作单】给这部书的地图起一版底图方案（供人工照着画/照着填）',
    '',
    projectLine(project),
    `地图范围：${w.name || '未命名世界'}${w.era ? ` · ${w.era}` : ''}（坐标 ${Number(w.mapSize?.w) || 1000} × ${Number(w.mapSize?.h) || 1000}）`,
    `交通：徒步 ${Number(w.travelModel?.walkKmPerDay) || 30} km/日，骑马 ${Number(w.travelModel?.horseKmPerDay) || 80} km/日，舟船 ${Number(w.travelModel?.boatKmPerDay) || 60} km/日`,
    '',
    '## 已有地点（名称｜类型｜区域｜坐标）',
    ...(spots.length > 0
      ? spots.map((loc) => `- ${loc.name || '未命名'}｜${loc.type || '—'}｜${loc.region || '—'}｜${loc.coords ? `${Math.round(Number(loc.coords.x) || 0)},${Math.round(Number(loc.coords.y) || 0)}` : '无坐标'}`)
      : ['（还没有带坐标的地点）']),
    '',
    '## 主角走过的路线（按章节顺序）',
    ...(walk.length > 1
      ? walk.map((row, index) => `${index + 1}. ${row.name || '未命名'}${row.chapter ? `（第${row.chapter}章起）` : ''}`)
      : ['（事件里还没有连成路线）']),
    '',
    '## 要做的事',
    '1. 按坐标把地图划分成 3–6 个地理区域（例如：关中平原、河东山地、江淮水网），给出每条区域的名字、大致范围（用坐标描述）与地貌。',
    '2. 标出主角路线穿过的地形：山、河、关隘、渡口；说明哪几条是必经之路、哪几条是支线。',
    '3. **给每个已有地点一个坐标**（x / y，范围 0–1000；左上为 0,0）：按正文里的相对方位、距离、地形关系估，不要漏地点；账本里没有但正文反复出现的重要地点也要给坐标（工具会直接建新地点）。',
    '4. 给出「底图绘制提示词」：一段中文描述，包含画风（例如水墨/古地图/羊皮纸）、色调、地形要素与标注习惯，足够让另一个人照着画。',
    '5. 只用已有地点与路线里出现过的信息；要补地形就明确写「推测」，不要编造具体史实。',
    '',
    '## 输出格式（纯文本，四段，严格按段名）',
    '【区域】一行一个：区域名｜x1–x2｜y1–y2｜地貌',
    '【路线】一行一段：起点→终点｜地形｜备注',
    '【坐标】一行一个：地点名｜x｜y｜类型｜区域（覆盖上面列出的每个地点；正文里的重要地点也可新增，工具会建账）',
    '【绘制提示词】一段话（≤200 字）',
    '',
    '## 落库（必做，不要只回复文本）',
    '输出完成后立刻调用 novel_desk_map(projectId, op="save", aiPlan="<上面的完整方案文本>")；工具会把【坐标】直接写进地点、把方案存进 world。',
  ]
  return withRules(lines)
}

// ── ② 从审阅条目生成提案 ─────────────────────────────────────

/**
 * 把一批审阅意见转成可采纳提案（段落级 before/after）。
 * @param {{project:object, chapter:object, reviews:Array}} input
 */
export function proposalFromReviewsWorkorder({ project, chapter, reviews } = {}) {
  const chapterRow = chapter && typeof chapter === 'object' ? chapter : { chapter: Number(chapter) || 0 }
  const chapterNumber = Number(chapterRow?.chapter ?? chapterRow?.id ?? 0)
  const chapterPath = chapterPathOf(project, chapterRow)
  const rows = Array.isArray(reviews) ? reviews : []
  const lines = [
    '【审阅 → 提案 工作单】把已确认的审阅意见改成可逐段采纳的补丁提案',
    '',
    projectLine(project),
    `目标：第${chapterNumber}章${chapterRow?.title ? `《${chapterRow.title}》` : ''}，共 ${rows.length} 条审阅意见。`,
    chapterPath ? `正文路径：${chapterPath}` : '',
    '',
    '## 待处理审阅（逐条对账，不许漏）',
    ...(rows.length > 0
      ? rows.map((row, index) => {
        const quote = String(row?.quote ?? '').slice(0, 160)
        return `${index + 1}. [${row?.id ?? '审阅'}] ${row?.source ?? 'logic'} / ${row?.severity ?? 'major'}：${String(row?.issue ?? '').slice(0, 200)}${quote ? `\n   原文：「${quote}」` : ''}${row?.suggestion ? `\n   建议：${String(row.suggestion).slice(0, 200)}` : ''}`
      })
      : ['（没有待处理审阅）']),
    '',
    '## 改法要求',
    '- 只改被点名的段落：before 必须逐字复制当前正文（4–600 字、不带省略号、在该章只出现一次），after 是同一位置改写后的文本。',
    '- 一条 patch 对应用一组 reviewIds（上面方括号里的 id）；不要整章重写，除非每条意见都涉及全章。',
    '- 改完的正文必须是纯文本：没有 Markdown、没有「修改说明」、没有省略号占位；场景分隔用 ※。',
    '',
    '## 提交格式',
    'novel_desk_propose(projectId, kind="patch-paragraph", chapter=' + chapterNumber + ', title="第' + chapterNumber + '章 审阅补丁", summary="对应 N 条审阅的段落补丁", items=[{before, after, why, reviewIds}])',
  ].filter((line) => line !== '')
  return withRules(lines)
}

// ── ②b 审阅 → 分章提案 / 全局修改工作单 ─────────────────────

/**
 * 审阅 → 分章提案工作单：一章提交一条 patch-paragraph（同章多条意见合并进一个提案的多个 patch）。
 * @param {{project:object, chapters?:Array, groups?:Array, focus?:string}} input
 *   groups = [{chapter, title, path, reviews:[审阅条目]}]
 */
export function proposalGroupsWorkorder({ project, chapters, groups, focus } = {}) {
  const source = (Array.isArray(groups) && groups.length > 0 ? groups : Array.isArray(chapters) ? chapters : [])
  const rows = source.map((group, index) => {
    const chapter = Number(group?.chapter ?? group?.id ?? group?.chapterNumber ?? index + 1)
    return {
      chapter,
      title: String(group?.title ?? ''),
      path: chapterPathOf(project, { ...(group ?? {}), chapter }),
      reviews: Array.isArray(group?.reviews) ? group.reviews : [],
    }
  })
  const total = rows.reduce((sum, row) => sum + row.reviews.length, 0)
  const lines = [
    '【审阅 → 分章提案工作单】把已确认的审阅意见改成一章一条可逐段采纳的补丁提案',
    '',
    projectLine(project),
    `本次处理 ${rows.length} 章、共 ${total} 条审阅意见：${rows.map((row) => `第${row.chapter}章`).join('、') || '（未指定章节）'}`,
    '',
    ...(String(focus ?? '').trim() ? ['## 本次重点（作者指定）', String(focus).trim().slice(0, 800), ''] : []),
    '## 待处理审阅（逐条对账，不许漏）',
    ...(rows.length > 0
      ? rows.flatMap((row) => [
        `### 第${row.chapter}章${row.title ? `《${row.title}》` : ''}${row.path ? ` ｜ ${row.path}` : ''}`,
        ...(row.reviews.length > 0
          ? row.reviews.map((review, index) => {
            const quote = String(review?.quote ?? '').slice(0, 160)
            return `${index + 1}. [${review?.id ?? '审阅'}] ${review?.source ?? 'logic'} / ${review?.severity ?? 'major'}：${String(review?.issue ?? '').slice(0, 200)}${quote ? `\n   原文：「${quote}」` : ''}${review?.suggestion ? `\n   建议：${String(review.suggestion).slice(0, 200)}` : ''}`
          })
          : ['（本章没有待处理审阅）']),
      ])
      : ['（没有待处理审阅）']),
    '',
    '## 硬性要求（照做，否则提案会被驳回）',
    '1. after 必须是「改好后的正文」：逐字替换 before 所在位置，读起来就是成稿正文。',
    '2. 禁止在 after/why 里写编辑指令或说明文字：不许「改成…」「建议…」「二选一」「补一次…」「这里应该…」；要改就直接给出改后的句子。',
    '3. 一条 patch 必须挂对应审阅的 reviewIds（上面方括号里的 id），不许漏；一条意见都没处理就不算完成。',
    '4. before 必须逐字复制当前正文（4–600 字、不带省略号、在该章只出现一次）；不同 patch 不许重叠。',
    '5. 正文/补丁一律纯文本：没有 Markdown、没有「修改说明」、没有省略号占位；场景分隔用 ※。',
    '6. 每一章提交一条 kind="patch-paragraph" 提案（同一章的多个意见合并进同一个提案，提案里放多个 patch），不要一章拆成多个提案。',
    '',
    '## 提交格式（每章一条工具调用）',
    'novel_desk_propose(projectId, kind="patch-paragraph", chapter=章号, title="第N章 审阅补丁", summary="对应 M 条审阅的段落补丁", data={patches:[{before, after, why, reviewIds}]})',
  ]
  return withRules(lines)
}

/**
 * 全局修改工作单：处理 chapter=0 的全局问题——先归纳「全局修改意见」，再提跨章 book-fix 提案。
 * @param {{project:object, chapters:Array, reviews:Array, focus?:string}} input
 */
export function globalFixWorkorder({ project, chapters, reviews, focus } = {}) {
  const rows = withChapterPaths(project, chapters)
  const items = Array.isArray(reviews) ? reviews : []
  const lines = [
    '【全局修改工作单】每个全书级问题各出一条 book-fix 提案，分别批准、分别改',
    '',
    projectLine(project),
    `全书共 ${rows.length} 章；本次选中的全局审阅 ${items.length} 条。`,
    '',
    ...ISOLATION,
    '',
    '## 全书章节清单（通读受影响章；路径在行尾）',
    ...chapterLines(rows),
    '',
    ...(String(focus ?? '').trim() ? ['## 本次重点（作者指定）', String(focus).trim().slice(0, 800), ''] : []),
    '## 选中的全局审阅（chapter=0，逐条对账，不许漏）',
    ...(items.length > 0
      ? items.map((row, index) => {
        const quote = String(row?.quote ?? '').slice(0, 160)
        return `${index + 1}. [${row?.id ?? '审阅'}] ${row?.source ?? 'logic'} / ${row?.severity ?? 'major'}：${String(row?.issue ?? '').slice(0, 300)}${quote ? `\n   原文：「${quote}」` : ''}${row?.suggestion ? `\n   建议：${String(row.suggestion).slice(0, 200)}` : ''}`
      })
      : ['（没有选中全局审阅）']),
    '',
    '## 怎么做（每个问题一条提案，先归纳后动手）',
    '1. 逐条处理上面的全局审阅：每一条都归纳成一段可执行的「全局修改意见」（改什么、改成什么口径、哪些章适用），写进该条提案的 opinion；不要写成问题复述。',
    '2. 再通读所有受影响章节，找出每一处需要照这条意见改的原文，给出回应这条问题的跨章补丁 patches。',
    `3. 一条全局审阅至少提交一条 kind="book-fix" 提案（本次 ${items.length} 条审阅 → 通常 ${items.length} 条提案），作者会在提案页逐条批准 / 驳回。`,
    '',
    '## 硬性要求',
    '- 提交 kind="book-fix"、chapter=0：data={opinion, patches:[{chapter, before, after, why, reviewIds}]}；patches 不能为空。',
    '- 一条补丁只回应一个问题；同一处原文只能出现在一条提案里。若一处同时涉及多个问题，放进最相关的那条提案，并在其它提案的 opinion 里写明「已并入 <提案标题>」，不要重复改。',
    '- 若某条全局审阅已完全被其它提案覆盖、确实没有独立补丁，可以不单独提交，但最终汇报必须说明它并入了哪条提案（不要提交 patches 为空的提案，会被拒绝）。',
    '- after 是最终正文（逐字替换 before 位置），不是修改建议：禁止「改成…」「建议…」「二选一」「补一次…」这类编辑指令或说明文字。',
    '- 每条 patch 的 reviewIds 必须挂上它回应的全局审阅 id，不许漏；覆盖所有受影响章，同一处原文只改一次。',
    '- before 必须逐字复制当前正文（4–600 字、不带省略号、在该章只出现一次）；纯文本，禁 Markdown，场景分隔 ※。',
    '',
    '## 提交格式（每条全局审阅调用一次）',
    `novel_desk_propose(projectId, kind="book-fix", chapter=0, title="全局修改 1/${items.length}：主题", summary="回应 [审阅id] 的全局改法", data={opinion:"这条问题的全局修改意见", patches:[{chapter, before, after, why, reviewIds}]})`,
    '- 提交后继续下一条，全部交完再汇报每条提案 id 与它回应了哪个审阅 id。',
  ]
  return withRules(lines)
}

// ── ③ 全书提案工作单 ─────────────────────────────────────────

/**
 * 全书级提案工作单（一次通读，产出章节重写/账本修订提案）。
 * @param {{project:object, chapters:Array, source?:string}} input
 */
export function fullBookProposalWorkorder({ project, chapters, source, attention } = {}) {
  const sourceKey = SOURCE_LABEL[String(source ?? '')] ? String(source) : 'logic'
  const rows = Array.isArray(chapters) ? chapters : []
  const lines = [
    ATTENTION_PRINCIPLE,
    '',
    ...attentionBriefLines({ attention, chapters: rows }),
    '',
    '【全文提案工作单】通读全书 → 产出可逐条采纳的提案（正文只进提案，不直接落盘）',
    '',
    projectLine(project),
    `共 ${rows.length} 章。本次主要来源：source=${sourceKey}（${SOURCE_LABEL[sourceKey]}）`,
    '',
    ...ISOLATION,
    '',
    '## 章节清单（用 read 工具逐章读，长章分段读）',
    ...chapterLines(rows),
    '',
    '## 产出什么',
    '- 先注意力后正文：每章提案前先核对该章注意力设计；没有设计或设计分低于目标分，先用 novel_desk_attention op="design" 补齐，再产出提案。',
    '- 结构性问题（章节目标不清、因果断裂、节奏塌陷）：提交 kind="rewrite-chapter"，data.content 给整章新正文。',
    '- 局部问题（开头钩子、某段对白、章末牵引）：提交 kind="patch-paragraph"，data.patches 给逐段 before/after。',
    '- 账本与正文矛盾：提交 kind="ledger-fix"，data.ledgerFixes 给 [{kind,id,patch}]。',
    '- 同一章不要同时提 rewrite-chapter 与 patch-paragraph；优先级 rewrite-chapter。',
    '',
    '## 正文口径',
    '- 纯文本，禁 Markdown；段落之间空行；场景分隔 ※；不要写「本章完」「修改说明」。',
    '- 保持原章的人物、数字、专名与关键事实；改写不得删情节。',
    '',
    '## 提交格式',
    'novel_desk_propose(projectId, kind="patch-paragraph"|"rewrite-chapter"|"ledger-fix", chapter=N, title, summary, items=[...])',
    '每章提交后汇报：章号 / kind / 预期效果；全部做完停下等作者采纳。',
  ]
  return withRules(lines)
}

/** 大纲摘要行（写作/改写的输入；以数据库 outlines 为准）。 */
export function outlineLines(outline, { limit = 80 } = {}) {
  const rows = (Array.isArray(outline) ? outline : [])
    .map((row) => ({ chapter: Number(row?.chapter ?? 0), title: String(row?.title ?? ''), summary: String(row?.summary ?? '') }))
    .filter((row) => row.chapter > 0)
    .sort((a, b) => a.chapter - b.chapter)
  if (!rows.length) return []
  return [
    '## 大纲（本次写作/改写的输入；改大纲只能走 ledger-fix 提案或作者手动改）',
    ...rows.slice(0, limit).map((row) => `- 第${row.chapter}章${row.title ? `《${row.title}》` : ''}：${row.summary.replace(/\s+/g, ' ').slice(0, 160)}`),
  ]
}

// ── ④ 全文动作 goal prompt ──────────────────────────────────

/**
 * 全文动作（continue / expand / rewrite / rephrase）goal prompt。
 * @param {{project:object, run:object}} input
 */
export function runGoalPrompt({ project, run, attention, outline } = {}) {
  const rawKind = String(run?.kind ?? 'rewrite')
  const kind = rawKind === 'rephrase' ? 'rewrite' : rawKind
  const dial = rawKind === 'rephrase'
    ? 'style'
    : ['style', 'logic', 'structure'].includes(String(run?.variant ?? ''))
      ? String(run.variant)
      : ''
  const scope = String(run?.scope ?? 'book')
  const chapter = run?.chapter === null || run?.chapter === undefined ? '' : Number(run.chapter)
  const endChapter = Number(run?.endChapter) || chapter || 0
  const scopeLine = scope === 'book'
    ? '全书'
    : scope === 'range'
      ? `第${chapter}–${endChapter}章`
      : chapter
        ? `第${chapter}章`
        : '—'
  const budget = run?.budget ?? {}
  const targetChapters = Number(project?.targetChapters) || 0
  const wordsPerChapter = Number(project?.wordsPerChapter ?? project?.chapterWords) || 0

  const kindLine = {
    continue: '从头写：按大纲与账本规划新章，从现有最大章号的下一章开始逐章写正文；写一章落盘一章，不许重写已有章。',
    expand: '扩写：在不改变既有事实与结局的前提下补足场景、动作、对白，把章节写满到目标字数。',
    rewrite: {
      style: '改写（文风）：只改语言层（句式/用词/叙述节奏/去 AI 味），事件、专名、数字、对白条数全部冻结。',
      logic: '改写（逻辑与事实）：允许调整场景顺序、因果链与铺垫，修逻辑漏洞、人称视角漂移、前后矛盾；人物动机与设定要守住。',
      structure: '改写（结构与节奏）：重排章节内部的场景顺序、详略与断点，调整节奏与悬念钩子；不新增事实、不改结局。',
    }[dial] ?? '改写：保留原章事实与情节骨架，重写叙述与对白，去 AI 味、提注意力。',
  }[kind] ?? '按 run.kind 执行。'

  const flow = kind === 'continue'
    ? [
        '1. 第 0 步（先于读任何材料）：写一句本章的注意力目标——这一章靠什么把读者拽着往下读（例如「章末必须让读者追问玉佩是谁的」）。不要求四拍、不要求 designScore；四拍只是旧的规划方式，不再是写作门槛。',
        '2. 再 novel_desk_read op=context 取上下文、op=toc 取章节清单（注意最大章号）；',
        `3. 从${chapter ? `第${chapter}章` : '现有最大章号+1'}开始：先列出本章场景清单（谁 / 在哪 / 想要什么 / 阻碍 / 转折 / 章末钩子），确认这一章能兑现那句注意力目标，再动笔；若这一章已经有正文，从它后面一章接着写，绝不覆盖已有章；每开新的一章，先补该章注意力设计；`,
        '4. 每章写完用 novel_desk_write 提交（source="run"，章节号递增）；正文**首行写回目标题**（第X回 …），标题属于正文，不放进 meta；闸门失败按失败项改到通过，不要绕过；',
        '5. 每章完成用 novel_desk_run op=advance 上报进度（stageId/note）；预算将满或需要作者决策时 op=pause；全书目标章数写够后 op=finish。',
      ]
    : [
        '1. 第 0 步（先于读正文）：给本次范围每批写一句注意力目标（这一批靠什么让读者继续读）；不要求四拍、不要求 designScore。注意力唯一的验收是冷读分数，不是设计表。',
        '2. 再 novel_desk_read op=context 取上下文、op=toc 取章节清单；',
        '3. 逐章处理：读章节正文 → 对照该章注意力设计（四拍是否兑现、弱在哪）→ 产出新正文 → novel_desk_write 提交（source="run"，必须过闸门）；闸门失败按失败项改到通过，不要绕过；',
        '4. 每章完成用 novel_desk_run op=advance 上报进度（stageId/note），阶段变化用 op=status 自查；',
        '5. 预算将满或需要作者决策时 op=pause 停下汇报；全部完成 op=finish。',
      ]

  const fidelity = kind === 'continue'
    ? [
        '- 与账本一致：人物年龄 / 官衔 / 地名 / 时间线 / 已发生事件按账本与硬事实写，不得与前面章节矛盾；需要新设定就在正文里自然带出，不要另开提案。',
        `- 目标篇幅：每章约 ${wordsPerChapter || 3000} 字${targetChapters ? `，全书目标 ${targetChapters} 章` : ''}；写到目标章数就停。`,
      ]
    : [
        '- 保真：上一版正文里的数字与专名必须保留；对白条数不要大起大落。',
        dial === 'style' ? '- 本轮只许改语言：事件、人物行动顺序、对白条数、数字与专名一律冻结。' : '',
        dial === 'logic' ? '- 本轮可以改因果与场景顺序，但改写后要能自圆其说：设定、人物动机、结局不变。' : '',
        dial === 'structure' ? '- 本轮可以重排场景与详略，但不得新增事实、不得改结局与人物关系。' : '',
      ].filter(Boolean)

  const lines = [
    ATTENTION_PRINCIPLE,
    '',
    ...attentionBriefLines({ attention }),
    '',
    `【全文动作 goal】kind=${kind}${dial ? `+${dial}` : ''} ｜ scope=${scope} ｜ ${scopeLine}`,
    '',
    projectLine(project),
    ...outlineLines(outline),
    `目标：${kindLine}`,
    `预算：token 上限 ${Number(budget.maxTokens) || 0}（0=不限）｜ 费用上限 ¥${Number(budget.maxCostCNY) || 0}（0=不限）。`,
    '',
    ...roleBriefLines(ROLE_BY_ID.publisher, { task: '先给本次全文动作定调（题材/读者/爽点密度/商业定位），只输出 ≤300 字简报' }),
    '',
    ...roleBriefLines(ROLE_BY_ID.author, { task: '按出版人定调与注意力设计执行本次全文动作' }),
    '',
    '## 执行流程',
    ...flow,
    '',
    '## 阶段',
    ...(Array.isArray(run?.stages) && run.stages.length > 0
      ? run.stages.map((stage, index) => `${index + 1}. ${stage.title ?? stage.id}（${stage.status ?? 'pending'}）`)
      : ['（run 尚未分阶段：按章号顺序推进，用 novel_desk_run op=advance 自报阶段）']),
    '',
    '## 硬性输出口径',
    '- novel_desk_write 的 text 必须是纯文本：禁 Markdown、禁修改说明，段落空行、场景分隔 ※。',
    '- 正文必须逐拍兑现该章注意力设计：开篇钩子、当场张力、一次可感知兑现、章末未决问题；对不上设计就不许交稿。',
    ...fidelity,
    '- 每章提交后检查返回值：ok=false 时按 failures 修正后重交，不要跳过。',
  ]
  return withRules(lines)
}

// ── ⑤ 单章重写工作单 ─────────────────────────────────────────

/**
 * 单章重写工作单（当前正文内联给出）。
 * @param {{project:object, chapter:object, text:string}} input
 */
export function chapterRewriteWorkorder({ project, chapter, text, attention, outline } = {}) {
  const chapterNumber = Number(chapter?.chapter ?? chapter?.id ?? 0)
  const body = String(text ?? '')
  const lines = [
    ATTENTION_PRINCIPLE,
    '',
    ...attentionBriefLines({ attention, chapters: chapter ? [chapter] : [] }),
    '',
    '【单章重写工作单】',
    '',
    projectLine(project),
    ...outlineLines(outline, { limit: 5 }),
    `目标：第${chapterNumber}章${chapter?.title ? `《${chapter.title}》` : ''}，当前 ${body.length} 字。正文见下，直接在当前对话里改，不要读其他文件。`,
    '',
    ...roleBriefLines(ROLE_BY_ID.author, { task: '按注意力设计重写本章；语言层可交给文笔文风优化师复核' }),
    '',
    '',
    '## 当前正文（纯文本）',
    '<<<',
    body,
    '>>>',
    '',
    '## 改写要求',
    '- 先想清楚再改：用一句话写清本章靠什么抓人（开头怎么抓、章末留什么未决问题），再交重写提案；不需要四拍设计。',
    '- 保留：人物、地点、数字、关键事实、本章结局；对白条数不要增减超过 20%。',
    '- 提升：开篇 3 行内抛钩子；张力落在主角失去什么；至少一次可感知兑现；章末留未决问题。',
    '- 语言：删套话与模板化微动作（看了看/顿了顿/停了一停），长短句换挡，对话文白相间。',
    '- 输出纯文本：禁 Markdown、禁「修改说明」、禁省略号占位；段落空行，场景分隔 ※。',
    '',
    '## 提交格式',
    'novel_desk_propose(projectId, kind="rewrite-chapter", chapter=' + chapterNumber + ', title="第' + chapterNumber + '章重写", summary="…", items=[{content:"整章新正文"}])',
    '提交后停下汇报改动要点；不要直接调用 novel_desk_write（那是 run 的通道）。',
  ]
  return withRules(lines)
}

// ── ⑥ 注意力设计工作单 ───────────────────────────────────────

/**
 * 注意力设计工作单（四拍文字设计 + 设计分，不写实测分）。
 * @param {{project:object, chapters:Array}} input
 */
export function attentionDesignWorkorder({ project, chapters, attention } = {}) {
  const rows = withChapterPaths(project, chapters)
  const lines = [
    ATTENTION_PRINCIPLE,
    '',
    '【注意力设计工作单】先设计，再写正文；设计字段与实测字段分开写',
    '',
    projectLine(project),
    '',
    ...attentionBriefLines({ attention, chapters: rows }),
    '',
    BEAT_RULE,
    '设计只写：type / hook / tension / payoff / cliff / question / designScore（0–100）/ status="planned"；不要写 score、breakdown、dropPoints（那是实测）。',
    '',
    '## 待设计章节',
    ...(rows.length > 0
      ? rows.map((row, index) => {
        const chapterNumber = Number(row?.chapter ?? row?.id ?? index + 1)
        const path = String(row?.path ?? row?.file ?? '').trim()
        const words = Number(row?.words ?? 0) || 0
        const head = `### 第${chapterNumber}章${row?.title ? `《${row.title}》` : ''}${words > 0 ? ` ｜ ${words} 字` : ''}${path ? ` ｜ ${path}` : ''}`
        return `${head}\n${attentionLine(row?.attention ?? row?.record ?? row)}\n- 现有摘要：${String(row?.summary ?? '—').slice(0, 120)}`
      })
      : ['（未提供章节）']),
    '',
    '## 设计口径',
    '- 每章四拍都要具体到「读者会看到什么」（事件/画面/问题），不写形容词。',
    '- 章末 cliff 必须是一句能说清「接下来读者最想知道什么」的未决问题。',
    '- 同一注意力类型不要连续超过 3 章；设计分 designScore 按 0–100 自评。',
    '',
    '## 提交格式（一次只交 1 章，用扁平参数；别把多章塞进 items）',
    'novel_desk_attention(projectId, op="design", chapter=章号, type="event|emotion|language|mystery|relationship", hook="读者看到什么", tension="…", payoff="…", cliff="…", question="…", designScore=85, status="planned")',
    '- 一章一次工具调用，交完再交下一章；JSON 只包一层对象、结尾只有一个 }，不要把参数再包进 data/params/args。',
  ]
  return withRules(lines)
}

// ── ⑦ 注意力复测工作单（不透露旧分） ─────────────────────────

/**
 * 注意力复测（冷读打分）工作单：零上下文重读重打分；**不出现任何旧分数**（避免凑分）。
 * 作者可以在 focus 里写「这次打分说明」，只影响打分视角，不引入上下文。
 * @param {{project:object, chapters:Array, focus?:string}} input
 */
export function attentionRecheckWorkorder({ project, chapters, focus } = {}) {
  const rows = withChapterPaths(project, chapters)
  const note = String(focus ?? '').trim().slice(0, 800)
  const lines = [
    '【冷读工作单 = 注意力】独立会话 · 零上下文 · 只回答一个问题：读者会不会顺着往下读',
    '',
    projectLine(project),
    '读法：这是独立会话。工作单只给你章节路径和作者的打分说明；不提供剧情梗概、前文、历史分数、修改记录、账本或大纲。用清单里的路径（或 novel_desk_read(op="chapter", chapter=N)）读正文；读完一章立刻打分并提交，再读下一章。',
    '',
    ...roleBriefLines(ROLE_BY_ID['cold-reader'], { task: '逐章冷读，只给分数与地址评价' }),
    '提交前先 novel_desk_dispatch(projectId, role="cold-reader", task="逐章冷读") 拿 dispatchId；novel_desk_attention op="measured" 必须带 dispatchId。',
    '',
    '禁止参考任何历史分数；内容没变好就打低分，不许为了「有进步」凑分。',
    '',
    ...(note
      ? ['## 本次打分说明（作者指定；打分要回应它，但仍保持零上下文）', note, '']
      : []),
    '## 待冷读章节',
    ...(rows.length > 0
      ? rows.map((row, index) => {
        const chapterNumber = Number(row?.chapter ?? row?.id ?? index + 1)
        const path = String(row?.path ?? row?.file ?? '').trim()
        if (path) return `- 第${chapterNumber}章 ｜ ${path}`
        const words = Number(row?.words ?? 0) || 0
        return `- 第${chapterNumber}章${row?.title ? `《${row.title}》` : ''}${words > 0 ? ` ｜ ${words} 字` : ''}`
      })
      : ['（未提供章节）']),
    '',
    '## 标准（只有一条）',
    'ATTENTION IS ALL YOU NEED：每一句是不是都在把读者往下一句拽？只按这个打一个 0–100 的总分，不拆四拍、不做文学评论。',
    '',
    '## 输出：分数 + 指定地址的评价',
    '- score（0–100）：唯一的注意力分数。',
    '- verdict：会 / 犹豫 / 不会（读者读完这一章会不会继续读下一章）。',
    '- points：值得写下来的评价，数量不限，按重要性排序。每条必须带地址：',
    '  - para：段号（从 0 开始，标题是第 0 段；只算正文里的段落）。',
    '  - quote：该段逐字原文（≥4 字，用于核对地址）。',
    '  - kind：highlight 或 weakness。',
    '  - comment：≤80 字，说清楚为什么。',
    '  - after：仅 weakness 需要，给出该段的**替换成文**（整段）；highlight 不写 after。',
    '- 亮点门槛极高：只有读者会记住、会回看、会截图转发的段落才算 highlight；拿不准就不写。没有就 points=[]。',
    '- 不要写 detail 长文、不要写四拍、不要写设计字段。',
    '',
    '## 提交格式（一次一章，扁平参数）',
    'novel_desk_attention(projectId, op="measured", chapter=章号, score=73, verdict="会", points=[{para:5, quote="逐字原文", kind="weakness", comment="这一段松了", after="替换后的整段成文"}])',
    '- 一次只交 1 章；JSON 只包一层对象、结尾一个 }。',
    '- 提交成功后自动在意见库生成审阅：weakness 带改法；highlight 由作者决定是否收进高光。',
  ]
  return withRules(lines)
}

// ── ⑧ 读者批注 prompt ───────────────────────────────────────

/**
 * 作者/读者批注 → AI 处理工作单。
 * @param {{project:object, chapter:object, notes:Array}} input
 */
export function readerNotePrompt({ project, chapter, notes } = {}) {
  const chapterNumber = Number(chapter?.chapter ?? chapter?.id ?? 0)
  const rows = Array.isArray(notes) ? notes : []
  const lines = [
    '【读者批注处理工作单】把批注变成可采纳的改动提案',
    '',
    projectLine(project),
    `目标：第${chapterNumber}章${chapter?.title ? `《${chapter.title}》` : ''}，共 ${rows.length} 条批注。`,
    String(chapter?.path ?? '').trim() ? `正文路径：${chapter.path}` : '',
    '',
    '## 批注（quote 是读者选中的原文，note 是读者的话）',
    ...(rows.length > 0
      ? rows.map((row, index) => `${index + 1}. 原文：「${String(row?.quote ?? '').slice(0, 200)}」\n   读者：${String(row?.note ?? row?.issue ?? '').slice(0, 200)}${row?.suggestion ? `\n   建议：${String(row.suggestion).slice(0, 160)}` : ''}`)
      : ['（没有批注）']),
    '',
    '## 处理要求',
    '- 每条批注都要回应：采纳（给 before/after 补丁）/ 不采纳（说明原因，转成审阅条目 source="reader"）/ 需要作者补充信息。',
    '- 采纳的改动只改批注指到的段落，before 逐字复制正文（该章只出现一次）。',
    '- 不要删人物、改结局；改动后正文仍是纯文本（禁 Markdown，场景分隔 ※）。',
    '',
    '## 提交格式',
    '采纳 → novel_desk_propose(projectId, kind="patch-paragraph", chapter=' + chapterNumber + ', title, summary, items=[{before, after, why, reviewIds:[]}])',
    '不采纳 → novel_desk_review(projectId, reviews=[{chapter, source:"reader", severity:"suggestion", quote, issue, suggestion}])',
  ].filter((line) => line !== '')
  return withRules(lines)
}

// ── ⑨ 开新书：从一句想法生成世界/人物/大纲底座 ────────────────

/**
 * 开新书工作单：刚创建的空作品 → 按预设 + 作者想法生成世界/地点/人物/大纲/冲突/伏笔的提案。
 * @param {{project:object, preset?:object, brief?:string}} input
 */
export function newBookWorkorder({ project, preset, brief } = {}) {
  const p = preset ?? {}
  const custom = Boolean(p.custom) || String(p.id ?? '') === 'preset-ai-custom'
  const idea = String(brief ?? '').trim() || String(project?.description ?? '').trim() || '（作者没写想法：按书名与预设类型自由发挥，但要具体、可用）'
  const planned = Number(p.plannedChapters) || Number(project?.targetChapters) || 0
  const perChapter = Number(p.chapterWords) || 0
  const styleRules = Array.isArray(p.styleRules) ? p.styleRules : []
  const taboo = Array.isArray(p.taboo) ? p.taboo : []
  const reviewFocus = Array.isArray(p.reviewFocus) ? p.reviewFocus : []
  const outlineHint = custom
    ? '先把前 12 章写全，再按 3–5 章一批补到方案里定的章数（方案没定就补到第 30 章）'
    : planned > 0
      ? `先把前 12 章写全，再按 3–5 章一批补到第 ${Math.min(planned, 60)} 章`
      : '先把前 12 章写全，再按 3–5 章一批补到第 30 章'
  const presetLines = custom
    ? [
        '## 本书方案（作者选了「自定义：让 AI 定」，方案先由你出）',
        '- 根据作者想法定下：类型/子类型、基调、视角、时态、目标章数、每章字数、全书结构、风格规则 3–5 条、禁忌 2–4 条、审稿重点 3–6 条；',
        '- 用 kind="presets" 提交一条提案：patch={id:"preset-ai-custom", name:"AI 自定义方案", desc, genre, tone, pov, tense, plannedChapters, chapterWords, totalWords, structure, styleRules, taboo, reviewFocus, attentionPlan}；批准后会自动成为本书的当前预设（章数/字数/视角一起生效）；',
        '- 之后的设定与大纲必须严格按这套方案产出（类型和篇幅不要和方案打架）。',
      ]
    : [
        '## 本书预设（写作口径，和作者谈好的）',
        p.name ? `- 预设：${p.name}` : '',
        `- 类型：${p.genre || '—'} ｜ 视角：${p.pov || '—'} ｜ 时态：${p.tense || '—'}`,
        `- 规模：${planned || '—'} 章 × ${perChapter || '—'} 字${p.totalWords ? `（约 ${p.totalWords} 字）` : ''}`,
        p.tone ? `- 基调：${p.tone}` : '',
        p.structure ? `- 结构：${p.structure}` : '',
        styleRules.length ? `- 风格规则：\n${styleRules.map((rule) => `  · ${rule}`).join('\n')}` : '',
        taboo.length ? `- 禁忌：\n${taboo.map((rule) => `  · ${rule}`).join('\n')}` : '',
        reviewFocus.length ? `- 审稿重点：${reviewFocus.join('、')}` : '',
      ]
  const produceLines = [
    '## 你要产出（全部走 novel_desk_propose，kind="ledger-fix"，一次可提交多条 fix）',
    custom ? '- 本书方案：kind="presets"，patch 见上（先提交这一条）' : '',
    '- 世界：kind="world"，patch={name, scale, genre, era, description}；',
    '- 地点 8–15 个：kind="locations"，patch={name, type, description}；',
    '- 人物 5–12 个（主角/反派/关键配角）：kind="characters"，patch={name, role, goal, motive, flaw, arc, relations}；',
    `- 全书大纲：kind="outlines"，patch={chapter, title, summary, beats, attention:{type, hook, tension, payoff, cliff, question, designScore}}；${outlineHint}；summary 1–2 行，beats 3–5 个，章末留钩子；每章必须先有四拍设计（type 用 event/emotion/language/mystery/relationship，designScore 0–100，服务端会校验）；`,
    '- 主线冲突 1–3 条：kind="conflicts"，patch={name, stake, escalation}；',
    '- 伏笔 5–10 条：kind="foreshadow"，patch={name, setupChapter, payoffChapter, status:"planned"}；',
    '- 硬事实 5–10 条：kind="facts"，patch={subject, predicate, value, fromChapter}。',
  ]
  const lines = [
    ATTENTION_PRINCIPLE,
    '',
    '【开新书底座工作单】给刚创建的空作品生成「世界 + 地点 + 人物 + 全书大纲 + 冲突 + 伏笔」，全部以提案提交，不写正文。',
    '',
    projectLine(project),
    `作者的想法（必须扣住，不要写成通用模板）：${idea.slice(0, 800)}`,
    '',
    '## 本书注意力总设计（第一优先级，先于世界/人物/大纲）',
    '- 先定全书注意力打法：核心钩子是什么、前 3 章各用什么钩子留人、主类型如何轮换（event/emotion/language/mystery/relationship，同类型不连续超过 3 章）、爽点/兑现节奏（每 2–3 章至少一次）、每章章末 cliff 的统一规则；',
    custom
      ? '- 这条总设计必须写进方案提案 patch.attentionPlan（服务端会校验，缺了直接拒绝）：{principle:"ATTENTION IS ALL YOU NEED", targetAvg:80, openingHooks:"前三章各自留人的钩子", mainTypeRotation:["event","mystery",…], payoffCadence:"每2–3章一次可感知兑现", cliffRule:"每章末留一个具体未决问题", fatigueRule:"同类型不连续超过3章"}；'
      : '- 预设已定，但每章大纲仍必须先有四拍设计；总设计直接落到大纲的 attention 字段里。',
    '- 大纲的 attention 必须逐章写清四拍（读者会看到什么），不是写「加强悬念」这种空话。',
    '',
    ...presetLines,
    '',
    ...produceLines,
    '',
    '## 规则',
    '- 先世界和人物，再大纲；大纲必须能回答：主线是什么、赌注是什么、怎么升级、结局往哪收。',
    custom ? '- 服务端会校验：方案缺 attentionPlan、大纲条目缺 attention（type + designScore）会整条拒绝；一次写全再提交。' : '- 服务端会校验：大纲条目缺 attention（type + designScore）会整条拒绝；一次写全再提交。',
    custom ? '- 方案里的风格规则/禁忌要能直接用来审稿；不要写成空话（如「文笔好」）。' : '',
    '- 人物名、地名、专有名词要具体、有辨识度；类型不能跑偏（武侠不要写成科幻）。',
    '- 本工作单只产出设定与大纲，不写正文；正文要等作者批准提案并显式开工后再写。',
    custom ? '- 提交后先汇报这套方案（类型/篇幅/结构），再汇报世界/地点/人物/大纲/冲突/伏笔各提交了多少条。' : '',
    '- 提交后向作者汇报：世界/地点/人物/大纲/冲突/伏笔各提交了多少条，并提醒到「提案」页批量批准。',
  ].filter((line) => line !== '')
  return withRules(lines)
}
