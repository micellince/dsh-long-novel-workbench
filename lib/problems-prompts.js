/**
 * 0.7.1 审稿工作单：通读档 / 事实与逻辑档 / 继续改。
 *
 * 约定（与 docs/0.7-PROBLEM-WORKFLOW.md v2、0.7.1 实施契约 §4 一致）：
 *  - 一次审稿 = 一份 TXT + 一个 AI 从头读到尾：禁止派子 agent、禁止分章转交、禁止拆文件；
 *  - 产出只有「问题 + 修改稿」（通读档另有每章注意力分、全书结论、高光）；
 *  - 每条问题必须带类型 / 范围 / 严重度 / 位置 / 说明 / 修改稿；给不出稿的严重度必须 critical；
 *  - 最后只调用一次 novel_desk_problems（submit / revise）；
 *  - 不许改正文，不许调 novel_desk_review / novel_desk_attention / novel_desk_cold_split / novel_desk_propose。
 *
 * 本模块只拼字符串：不读文件、不碰数据库、不调用工具。
 */

/** 问题类型中文名（与 PROBLEM_TYPES 对应）。 */
const TYPE_LABEL = {
  'ai-style': 'AI 化',
  'logic-fact': '逻辑与事实',
  style: '文风漂移·较差',
  other: '其他',
}

/** 问题范围中文名。 */
const SCOPE_LABEL = { chapter: '单章', cross: '跨章', global: '全局' }

/** 严重度中文名。 */
const SEVERITY_LABEL = { critical: '最严重', major: '严重', minor: '一般', note: '提醒' }

/** 修改稿粒度中文名。 */
const DRAFT_LABEL = { paragraph: '段级稿', chapter: '整章稿' }

/** 两档审稿共用的铁律（写死，不许省略）。 */
const ISOLATION_LINES = [
  '## 铁律（违反任何一条，本次审稿作废）',
  '1. **只读工作单给的这一份 TXT**：不许 read 别的文件、不许 novel_desk_read、不许查账本 / 历史报告 / 旧意见 / 提案。',
  '2. **一个 AI 从头读到尾**：不许派子 agent、不许 novel_desk_dispatch、不许分章转交给多个 AI、不许自己把 TXT 拆成几份再合并——跨章 / 全局问题只有一次读完才看得出来。',
  '3. **全量记录（重要）**：本档位只是「首要目标」；既然已经全文读完，读到的其它类型问题也要一并提交（按性质给 `type`），绝不要因为不是本档目标就丢掉——丢掉等于让作者再读一遍、再花一次 token。',
  '4. **不许改正文**：不写任何文件、不调 novel_desk_write / novel_desk_run / novel_desk_propose；本工作单只产出问题与修改稿。',
  '5. 旧链路已停用：不许调 novel_desk_review / novel_desk_attention / novel_desk_cold_split。',
  '6. 最后只调用一次 `novel_desk_problems`；除了「读这一份 TXT」和这唯一一次调用，不要调用任何其他工具。',
  '7. 读不完 / 拿不到 TXT 就停下说明缺什么，不要凭记忆编正文。',
]

function projectText(projectName) {
  return String(projectName ?? '').trim() || '未命名作品'
}

function projectArg(projectId) {
  const id = String(projectId ?? '').trim()
  return id ? `projectId: ${JSON.stringify(id)},` : ''
}

function reviewArg(reviewId) {
  const id = String(reviewId ?? '').trim()
  return id ? `reviewId: ${JSON.stringify(id)},` : ''
}

/** 工具调用示例里真正给出的参数字行（没给就不写占位符，避免 AI 照抄占位符）。 */
function argLines({ projectId, reviewId } = {}) {
  const lines = []
  const project = projectArg(projectId)
  if (project) lines.push(`  ${project}`)
  const review = reviewArg(reviewId)
  if (review) lines.push(`  ${review}`)
  return lines
}

/** 调用参数说明：projectId 用当前作品；有 reviewId 就绑定本工作单的那条 review。 */
function paramHintLines({ projectId, reviewId } = {}) {
  const lines = ['## 调用参数']
  const id = String(projectId ?? '').trim()
  lines.push(id
    ? `- projectId 用本工作单绑定的作品：${JSON.stringify(id)}。`
    : '- projectId 用当前作品（工作单已绑定；只有一部作品时可省略）。')
  const review = String(reviewId ?? '').trim()
  if (review) lines.push(`- reviewId 用本工作单给出的 ${JSON.stringify(review)}；不要自己新建 review。`)
  return lines
}

/** 范围归一：chapter / cross / global（兼容 range、book 之类旧叫法）。 */
function scopeKey(scope) {
  const raw = String(scope ?? '').trim().toLowerCase()
  if (raw === 'chapter') return 'chapter'
  if (raw === 'cross' || raw === 'range' || raw === 'chapters') return 'cross'
  return 'global'
}

/** 章节入参可能是章号数组，也可能是 {chapter,title} 数组；统一成去重升序章号。 */
function normalizeChapterNumbers(chapters) {
  const out = []
  for (const row of Array.isArray(chapters) ? chapters : []) {
    const raw = row && typeof row === 'object' ? row.chapter ?? row.id : row
    const chapter = Number(raw)
    if (Number.isInteger(chapter) && chapter > 0 && !out.includes(chapter)) out.push(chapter)
  }
  return out.sort((a, b) => a - b)
}

/** 本次范围一行。 */
function rangeLines(key, numbers) {
  if (key === 'chapter') {
    const chapter = numbers[0] || 0
    return [chapter > 0 ? `本次范围：单章（第 ${chapter} 章）` : '本次范围：单章（章号见 TXT）']
  }
  if (key === 'cross') {
    return [`本次范围：跨章（作者明确指定第 ${numbers.join('、') || '?'} 章，共 ${numbers.length || '?'} 章；不是系统按固定章数分批）`]
  }
  return [numbers.length > 0
    ? `本次范围：全局（全书，共 ${numbers.length} 章，第 ${numbers[0]}–${numbers[numbers.length - 1]} 章）`
    : '本次范围：全局（全书）']
}

/** TXT 内含章节一行（章多时只列前 16 个）。 */
function chapterListLine(key, numbers) {
  if (numbers.length === 0) return ''
  if (key === 'global') return `TXT 内含全书 ${numbers.length} 章（第 ${numbers[0]}–${numbers[numbers.length - 1]} 章）。`
  const head = numbers.length > 16 ? numbers.slice(0, 16) : numbers
  const tail = numbers.length > 16 ? ` 等 ${numbers.length} 章` : ''
  return `TXT 内含章节：第 ${head.join('、')} 章${tail}。`
}

/** 材料与读法（唯一材料那一份 TXT）。 */
function manuscriptLines({ filePath, words } = {}) {
  const path = String(filePath ?? '').trim()
  const total = Number(words) || 0
  const lines = [
    '## 材料（唯一材料：一份 TXT，一个 AI 从头读到尾）',
    `- TXT 路径：${path || '（工作单没给 filePath：停下问作者，不要自己找文件）'}`,
    total > 0 ? `- 篇幅：约 ${total} 字。` : '',
    '- 文件结构：每章以 `===== 第N章 标题 =====` 开头，分隔行下面直接是正文段落；场景分隔符 `※` 单独成行。',
    '- 读法：用 read 工具从这个 TXT 的第一行读到最后一个字（文件长就按 offset 继续读，直到读完）；这是本工作单唯一允许读的文件。',
    '- **段号规则**：`para` 从 0 开始数正文段落；`===== 第N章 标题 =====` 是章节分隔，不是段落。',
  ]
  return lines.filter((line) => line !== '')
}

/** 每条问题必须带全的字段。 */
function problemFieldLines({ onlyLogic = false } = {}) {
  const typeLine = onlyLogic
    ? '- `type`：本档重点是 `logic-fact`（逻辑与事实）；**全文读完顺手发现的 AI 化 / 文风 / 其他问题也要按对应 type 一并提交**，不要因为不是本档目标就丢掉（重复段落 / 重复文字按 `style` 或 `other` 报）。'
    : '- `type`：三选一 —— `ai-style`（AI 化）/ `style`（文风漂移·较差）/ `other`（其他可落成稿的毛病）。'
  return [
    '## 每条问题必须带全（少字段会被服务端拒收，或作者没法采纳）',
    typeLine,
    '- `scope`：`chapter`（单章）/ `cross`（跨章，chapters 至少 2 个明确章号）/ `global`（全书）。',
    '- `chapters`：问题涉及的全部章号数组，如 `[2]` / `[2,15]`；`global` 用 `[]`（若只牵动某几章，就改用 `cross` 列出这几章）。',
    '- `chapter`：主章号（最该改的那一章）；`global` 用 `0`。',
    '- `para`：正文段号（从 0 开始，**不含标题**）；能精确到段就写，拿不准就省略、改用整章稿。',
    '- `quote`：该段逐字原文（≥4 字，标点照抄），用来核对地址；跨章 / 全局问题也要给逐字引文。',
    '- `severity`：`critical`（最严重）/ `major`（严重）/ `minor`（一般）/ `note`（提醒）。',
    '- `text`：一句话说清读者卡在哪（≤200 字），要具体到「哪里、为什么」，不要复述剧情。',
    '- `drafts`：修改稿数组（0..N 份，见下面「修改稿粒度」）；一条问题下的多份稿按章各一份。',
  ]
}

/** 修改稿粒度标准（作者定，写死进两档 prompt）。 */
function granularityLines() {
  return [
    '## 修改稿粒度（按问题决定，不按固定章数切）',
    '- 单点、局部、一段内能解决 → **段级稿** `{kind:"paragraph", chapter:N, para:M, text:"替换后的整段成文"}`（一段换一段）。',
    '- 单章内问题多、或问题严重 → **整章改写稿** `{kind:"chapter", chapter:N, text:"第N章 标题\\n\\n整章正文……"}`（整章改写比一段段修更省 token，也更自洽）。',
    '- 跨章 / 全局问题先看每章改动大小：每章只是小改（改称呼、改数字、删重复句、换一句）→ 涉及章各一份**段级稿**（每份必须带 `chapter` + `para`（或该章逐字 `quote`））；修几段解决不了 → 涉及章各一份**整章稿**。都放进同一条问题的 `drafts` 数组。',
    '- 全局问题但只是分散小毛病 → 多份段级稿（每份指到章 + 段）。',
    '- 全局问题、严重、牵动多章 → 多份整章稿。',
    '- 段级稿「一段换一段」：**不许增删段落、不许出现空行**；整章稿允许段数变化，但第一行必须是本章标题。',
    '- 一条问题下的多份稿不要重复指同一章同一段。',
    '- **给不出能直接替换的成文**：可以不写 draft，但这条问题的 `severity` 必须是 `critical`，并在 `text` 里写清缺什么材料 / 需要作者裁定什么。',
  ]
}

/** 修改稿写法（会直接顶替正文）。 */
function draftLines() {
  return [
    '## 修改稿写法（作者点「采纳」就直接落盘）',
    '- 纯文本：禁止 Markdown（#、**、-、>、反引号、表格）；对白用「」或“”；场景分隔 `※` 单独成行。',
    '- 段级稿：给**改完后的整段**（不是只给改动的句子），不得含空行，不得把别的段落并进来。',
    '- 整章稿：第一行 `第N章 标题`（标题文本照抄 TXT 分隔行），空行后是整章正文；不许改章号 / 标题。',
    '- 保真：不许无故删人物、改专名、改数字、改已发生的事件；删对白要克制（数字 / 专名 / 对白条数是采纳时的校验锚点）。',
    '- 去 AI 味是目标，但不许为了「像人」硬加脏话 / 网络梗；保持这本书原有的文风。',
    '- 每份稿都要能给读者独立读懂：只替换指到的段落 / 章，不能靠你脑内的上下文。',
  ]
}

/** 自动扫库候选清单（事实档专用）。 */
function candidateLines(candidates) {
  const rows = Array.isArray(candidates) ? candidates : []
  if (rows.length === 0) return ['（本次自动扫库没有候选：仍然把 TXT 一次读完，按正文找逻辑 / 事实问题。）']
  const limit = 120
  const shown = rows.slice(0, limit)
  const lines = shown.map((row, index) => {
    const chapter = Number(row?.chapter) || 0
    const para = row?.para === null || row?.para === undefined ? '' : ` ｜ 段号 para=${Number(row.para)}`
    const paras = Array.isArray(row?.paras) && row.paras.length > 1
      ? ` ｜ 涉及段号 ${row.paras.map((value) => Number(value)).join('、')}`
      : ''
    const quote = String(row?.quote ?? '').slice(0, 80)
    const message = String(row?.message ?? '').slice(0, 160)
    return `- 候选#${index + 1} ｜ 第${chapter}章${para}${paras} ｜ 规则 ${String(row?.rule ?? '')} ｜ 疑点：${message}${quote ? ` ｜ 引文：${quote}` : ''}`
  })
  if (rows.length > limit) lines.push(`- （候选共 ${rows.length} 条，这里只列前 ${limit} 条；其余同样逐条判，最后在汇报里给总数。）`)
  return lines
}

/** 范围中文描述（继续改用）。 */
function scopeText(row) {
  const raw = String(row?.scope ?? '')
  const chapters = Array.isArray(row?.chapters)
    ? row.chapters.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
    : []
  if (raw === 'global') return '全局（全书）'
  if (chapters.length > 0) return `${SCOPE_LABEL[raw] || '单章'}（第 ${chapters.join('、')} 章）`
  const chapter = Number(row?.chapter) || 0
  return chapter > 0 ? `${SCOPE_LABEL[raw] || '单章'}（第 ${chapter} 章）` : SCOPE_LABEL[raw] || '单章'
}

/** 问题位置一行（继续改用）。 */
function locationText(row) {
  const scope = String(row?.scope ?? '')
  const chapter = Number(row?.chapter) || 0
  const para = row?.para === null || row?.para === undefined || row?.para === '' ? null : Number(row.para)
  if (scope === 'global' || chapter <= 0) return '全局（全书）'
  if (Number.isInteger(para) && para >= 0) return `第 ${chapter} 章 · 段号 para=${para}（从 0 开始）`
  return `第 ${chapter} 章 · 整章`
}

/** 最近一版稿（优先 pending；没有就取最后一份）。 */
function latestDraft(row) {
  const drafts = (Array.isArray(row?.drafts) ? row.drafts : [])
    .filter((draft) => draft && String(draft.text ?? '').trim())
  if (drafts.length === 0) return null
  for (let index = drafts.length - 1; index >= 0; index -= 1) {
    if (String(drafts[index].status ?? '') === 'pending') return drafts[index]
  }
  return drafts[drafts.length - 1]
}

/** 继续改：问题清单（id / 类型 / 位置 / 原稿 / 上一版稿）。 */
function problemListLines(problems) {
  const rows = Array.isArray(problems) ? problems : []
  if (rows.length === 0) return ['（没有选中问题：先让作者在问题页勾选问题后再发起「继续改」。）']
  const lines = []
  rows.forEach((row, index) => {
    const id = String(row?.id ?? '').trim() || `（缺 id，第 ${index + 1} 条）`
    const type = TYPE_LABEL[String(row?.type ?? '')] || String(row?.type ?? '其他')
    const severity = SEVERITY_LABEL[String(row?.severity ?? '')] || String(row?.severity ?? '一般')
    const quote = String(row?.quote ?? '').replace(/\s+/g, ' ').slice(0, 200)
    const text = String(row?.text ?? '').replace(/\s+/g, ' ').slice(0, 240)
    const draft = latestDraft(row)
    if (index > 0) lines.push('')
    lines.push(`### 第 ${index + 1} 条 · problemId=\`${id}\``)
    lines.push(`- 类型：${type} ｜ 范围：${scopeText(row)} ｜ 严重度：${severity}`)
    lines.push(`- 位置：${locationText(row)}`)
    if (quote) lines.push(`- 原文（逐字引文，定位用）：「${quote}」`)
    if (text) lines.push(`- 问题：${text}`)
    if (draft) {
      const kind = String(draft.kind ?? '')
      const target = kind === 'chapter'
        ? `第${Number(draft.chapter) || 0}章 整章`
        : `第${Number(draft.chapter) || 0}章 第${Number(draft.para) || 0} 段（para）`
      const full = String(draft.text ?? '').replace(/\s+/g, ' ')
      lines.push(`- 上一版稿（${DRAFT_LABEL[kind] || kind || '稿'} · ${target}）：${full.slice(0, 300)}${full.length > 300 ? '……（后面略；本轮按正文与作者要求重写，不必逐字沿用旧稿）' : ''}`)
    } else {
      lines.push('- 上一版稿：无（首次出稿，按正文与问题说明写）')
    }
  })
  return lines
}

/**
 * 档 A 通读（冷读 + 去 AI 化合并）：每章注意力分 + 全书结论 + 三类问题 + 高光。
 *
 * @param {{projectName?:string, scope?:string, chapters?:Array, filePath?:string, reviewId?:string, words?:number, projectId?:string}} input
 * @returns {string} 中文纯文本工作单
 */
export function readingPrompt({ projectName, scope, chapters, filePath, reviewId, words, projectId } = {}) {
  const key = scopeKey(scope)
  const numbers = normalizeChapterNumbers(chapters)
  return [
    '【审稿工作单 · 通读档】冷读 + 去 AI 化合并：评分、问题（AI 化 / 文风 / 其他）、高光',
    '',
    `# 作品：${projectText(projectName)}`,
    ...rangeLines(key, numbers),
    chapterListLine(key, numbers),
    '',
    ...manuscriptLines({ filePath, words }),
    '',
    ...ISOLATION_LINES,
    '',
    '## 这一档要产出什么（三样，去处不同）',
    '1. **注意力评分**：本次范围内每一章一个 0–100 整数分（`scores=[{chapter,score}]`），外加一句全书 / 本次范围的结论（写在 `verdict`）。',
    '2. **问题**：只分三类 —— `ai-style`（AI 化）/ `style`（文风漂移·较差）/ `other`（其他可落成稿的毛病）；**逻辑与事实不在这档**。',
    '3. **高光**：写得好的地方，直接进高光账本，不是问题。',
    '',
    '## 评分口径（ATTENTION IS ALL YOU NEED）',
    '- 只回答一个问题：读者会不会顺着这一章往下读。分数低不是问题，评分本身不进问题单。',
    '- `verdict` 先给 `会` / `犹豫` / `不会`，再接一句结论（≤80 字），例如 `犹豫：主线抓人，但第 3–5 章节奏明显拖`。',
    '- 每章都要有分，不允许漏章、不允许一章多条；分差要拉开，不要全部 75 分。',
    '',
    '## 问题口径（本档重点是这三类；其它类型发现即报）',
    '- `ai-style`：机器味、套话、模板化微动作、节奏单一、解释性旁白压过场景。',
    '- `style`：文风漂移、语感变差、对白不像人物说话、叙述腔调前后不一。',
    '- `other`：具体会让人弃读或看不懂的毛病（长段无推进、重复信息、场景跳切、人物称呼混乱等）。',
    '- **非本档目标也要记**：本档重点是评分 + 上面三类；但既然已经全文读完，顺手发现的逻辑 / 事实问题（时间线、因果、人物状态、设定冲突、数字专名对不上）也要一并提交，`type:"logic-fact"`，按把握标 severity；不要只提醒作者另开事实档，更不要丢掉。',
    '- 不同类不合并：同一段既 AI 化又有文风问题，就分别是两条问题，各自出稿。',
    '',
    ...problemFieldLines(),
    '',
    ...granularityLines(),
    '',
    ...draftLines(),
    '',
    '## 高光（直接进账本，不是问题）',
    '- `highlights=[{chapter, para?, quote, comment}]`：`quote` 必须逐字摘自正文（≥4 字），`comment` ≤80 字说清好在哪。',
    '- 只报读者会记住、会回看、会截图转发的段落；拿不准就不报；没有就给 `highlights=[]`。',
    '',
    '## 定位规则（作者点「采纳」要靠它）',
    '- `para` 从 0 开始数正文段落；TXT 里的 `===== 第N章 标题 =====` 分隔行不是段落。',
    '- `quote` 必须能在该段里逐字找到（标点照抄，不改写、不省略）；段级稿的 `problem.para` 必须和 `quote` 对得上。',
    '- 段号拿不准、或这一章问题多 / 严重 → 不要硬猜 `para`，直接给整章稿（`kind:"chapter"`），问题 `para` 可省略。',
    '',
    '## 提交（本工作单唯一一次工具调用）',
    ...paramHintLines({ projectId, reviewId }),
    '',
    'novel_desk_problems(',
    '  op="submit",',
    ...argLines({ projectId, reviewId }),
    '  verdict="犹豫：主线清楚，但第 3–5 章节奏拖",',
    '  scores=[{chapter:1, score:82}, {chapter:2, score:64}],',
    '  problems=[',
    '    {',
    '      type:"ai-style", scope:"chapter", chapters:[2], chapter:2, para:7,',
    '      quote:"……逐字原文……", severity:"major",',
    '      text:"这一段连着三处同款微动作，读者会立刻闻到 AI 味。",',
    '      drafts:[{kind:"paragraph", chapter:2, para:7, text:"整段替换成文（一段换一段，不含空行）"}]',
    '    },',
    '    {',
    '      type:"style", scope:"cross", chapters:[2,15], chapter:15,',
    '      quote:"……逐字原文……", severity:"major",',
    '      text:"第 2 章与第 15 章对同一场雨的叙述腔调像两个人写的。",',
    '      drafts:[',
    '        {kind:"chapter", chapter:2, text:"第2章 标题（照抄 TXT 分隔行里的标题）\\n\\n整章正文……"},',
    '        {kind:"chapter", chapter:15, text:"第15章 标题\\n\\n整章正文……"}',
    '      ]',
    '    }',
    '  ],',
    '  highlights=[{chapter:3, para:12, quote:"……逐字原文……", comment:"这一段的收束很好，读者会记住"}]',
    ')',
    '',
    '## 调用前自检（逐条打勾）',
    '- 范围内每一章都有且只有一个 score；`verdict` 给了结论；',
    '- 每条问题 type / scope / chapters / chapter / severity / text 都在，段级问题还带 para + quote；',
    '- 每个段级稿不含空行、是整段替换；每个整章稿第一行是本章标题；',
    '- 给不出稿的问题已经标 `severity:"critical"`；',
    '- 只调用一次，没有分批多次 submit；JSON 只包一层、末尾 `}` 收好。',
  ].join('\n')
}

/**
 * 档 B 事实与逻辑：TXT + 自动扫库候选 → 只出逻辑与事实问题。
 *
 * @param {{projectName?:string, scope?:string, chapters?:Array, filePath?:string, reviewId?:string, words?:number, candidates?:Array, projectId?:string}} input
 * @returns {string} 中文纯文本工作单
 */
export function factsPrompt({ projectName, scope, chapters, filePath, reviewId, words, candidates, projectId } = {}) {
  const key = scopeKey(scope)
  const numbers = normalizeChapterNumbers(chapters)
  const rows = Array.isArray(candidates) ? candidates : []
  return [
    '【审稿工作单 · 事实与逻辑档】一份 TXT + 自动扫库候选，一个 AI 读完：只出逻辑与事实问题',
    '',
    `# 作品：${projectText(projectName)}`,
    ...rangeLines(key, numbers),
    chapterListLine(key, numbers),
    `自动扫库候选：${rows.length} 条（0 AI 的本地检查结果，只是「可疑点」，不是结论）。`,
    '',
    ...manuscriptLines({ filePath, words }),
    '',
    ...ISOLATION_LINES,
    '',
    '## 这一档要产出什么（只有一样：逻辑与事实问题）',
    '1. **先逐条判自动扫库候选**：每一条都要判「确认」或「否定」，不许跳。',
    '2. **再找跨章连锁**：候选覆盖不到的时间线、人物状态、因果关系、设定规则、数字专名矛盾，靠这次一次读完找出来。',
    '3. 本档重点是 `type:"logic-fact"`；全文读完顺手发现的 AI 化 / 文风 / 其他问题也要按对应 type 一并提交（重复段落 / 重复文字按 `style` 或 `other` 报）。本档不评分、不报高光。',
    '',
    '## 自动扫库候选（逐条判）',
    ...candidateLines(rows),
    '',
    '## 怎么判候选',
    '- **确认**：候选确实是问题 → 提交一条 `logic-fact` 问题，`text` 开头标 `候选#i 确认：`，按粒度给整段 / 整章稿；候选的 `para` / `quote` 用来定位。',
    '- **否定**：候选是误报 → 不提交，不要为了「有产出」硬凑；读完在工具调用前用一段话汇报（候选共 N 条：确认 x、否定 y，一句理由），再调工具。',
    '- 同一处问题只报一条；多条候选指向同一个问题就合并成一条，并在 `text` 里列出候选号。',
    '- 候选只是线索：判真假以 TXT 正文和它给的事实为准；扫库规则名（如 `fact-number-missing`）只解释疑点来源，不构成结论。',
    '',
    '## 跨章连锁（这一档的重点，只有一次读完才看得出来）',
    '- 重点找：时间线对不上（同一事件两种时序）、人物状态矛盾（已死 / 已离开又出现、关系承诺前后不一）、因果断裂（结果先于原因、动机消失）、设定规则被瞬间打破、数字与专名前后不一致。',
    '- 涉及多章 → `scope:"cross"` + `chapters:[涉及章号]`；全书性规则 / 设定矛盾 → `scope:"global"` + `chapter:0`。',
    '- 处理粒度：每章只是小改 → 涉及章各一份段级稿（每份带 `chapter` + `para`/`quote`）；修几段解决不了 → 涉及章各一份整章稿。都放在同一条问题的 `drafts` 里。',
    '',
    ...problemFieldLines({ onlyLogic: true }),
    '',
    ...granularityLines(),
    '',
    ...draftLines(),
    '',
    '## 提交（本工作单唯一一次工具调用；事实档不提交评分与高光）',
    ...paramHintLines({ projectId, reviewId }),
    '',
    'novel_desk_problems(',
    '  op="submit",',
    ...argLines({ projectId, reviewId }),
    '  problems=[',
    '    {',
    '      type:"logic-fact", scope:"chapter", chapters:[3], chapter:3, para:11,',
    '      quote:"……逐字原文……", severity:"critical",',
    '      text:"候选#2 确认：第 3 章说主角左手受伤，这一段却用左手拔剑。",',
    '      drafts:[{kind:"paragraph", chapter:3, para:11, text:"整段替换成文（只改左右手，其余不动）"}]',
    '    },',
    '    {',
    '      type:"logic-fact", scope:"cross", chapters:[2,15], chapter:15,',
    '      quote:"……逐字原文……", severity:"major",',
    '      text:"第 2 章与第 15 章对同一场雨的时间写法互相打架。",',
    '      drafts:[',
    '        {kind:"chapter", chapter:2, text:"第2章 标题\\n\\n整章正文……"},',
    '        {kind:"chapter", chapter:15, text:"第15章 标题\\n\\n整章正文……"}',
    '      ]',
    '    }',
    '  ]',
    ')',
    '- 本次一条确认的问题都没有：也要调用一次，传 `problems=[]`，不要静默结束。',
    '',
    '## 调用前自检（逐条打勾）',
    '- 候选每一条都判过：确认的进了问题单，否定的在汇报里说得清；',
    '- 只提交 `logic-fact`，没有 AI 化 / 文风 / 其他，也没有 score / highlight；',
    '- 每条问题字段齐全；段级稿 para + quote 对得上；整章稿第一行是标题；',
    '- 给不出稿的问题标了 `severity:"critical"`；',
    '- 只调用一次，JSON 只包一层、末尾 `}` 收好。',
  ].join('\n')
}

/**
 * 继续改：按作者要求给选中的问题重新出稿（不新增问题、不改别的段落）。
 *
 * @param {{projectName?:string, problems?:Array, requirement?:string, batch?:boolean|number, projectId?:string}} input
 * @returns {string} 中文纯文本工作单
 */
export function revisePrompt({ projectName, problems, requirement, batch, projectId } = {}) {
  const rows = Array.isArray(problems) ? problems.filter((row) => row && String(row.id ?? '').trim()) : []
  const total = rows.length
  const chapters = []
  for (const row of rows) {
    const list = Array.isArray(row?.chapters) ? row.chapters : [row?.chapter]
    for (const value of list) {
      const chapter = Number(value)
      if (Number.isInteger(chapter) && chapter > 0 && !chapters.includes(chapter)) chapters.push(chapter)
    }
  }
  chapters.sort((a, b) => a - b)
  const wanted = String(requirement ?? '').trim()
  const batchFlag = Boolean(batch) || total > 1
  return [
    `【继续改工作单${batchFlag ? ' · 批量' : ''}】按作者要求，给选中的问题重新出修改稿`,
    '',
    `# 作品：${projectText(projectName)}`,
    `本次共 ${total} 条问题${chapters.length > 0 ? `，涉及第 ${chapters.join('、')} 章` : ''}。**逐条都要有新稿**：不许只做前几条、不许只挑好改的做。`,
    '',
    '## 作者要求（本轮修改方向，必须逐条落实）',
    wanted || '（作者没写额外要求：按每条问题的说明与下面的粒度标准出稿。）',
    '',
    '## 读法（只读涉及章，不重审）',
    `- 只读上面列出的章：用 novel_desk_read(op="chapter", chapter=N) 或章节文件路径；不要通读全书、不要读别的作品。`,
    '- 这是「返工」不是「重审」：以问题给定的位置 / 原文为锚点，不新增问题、不顺手指摘别的段落。',
    '',
    '## 问题清单（逐条处理，一条不许漏）',
    ...problemListLines(rows),
    '',
    '## 出稿要求（与首轮同一套标准，作者点「采纳」就直接落盘）',
    '- 粒度：沿用这条问题原来的粒度；作者要求改粒度时按作者要求（「拆成段稿」→ paragraph；「整章重写」→ chapter）。',
    '- 段级稿：一段换一段，不增删段落，**不得含空行**；给整段替换成文，不是只给改动的句子。',
    '- 整章稿：第一行 `第N章 标题`（照抄本章标题），空行后是整章正文；允许段数变化。',
    '- 纯文本：禁止 Markdown（#、**、-、>、反引号、表格）；对白用「」或“”；场景分隔 `※` 单独成行。',
    '- 保真：不许无故删人物、改专名 / 数字 / 已发生的事件，删对白要克制。',
    '- 每条问题至少 1 份稿；跨章问题涉及章各一份整章稿。',
    '- 作者要求可能只针对其中一部分问题：适用的按作者要求改，不适用的按原问题说明出稿，并在最终回复里说清哪几条按作者要求改、哪几条按原问题改。',
    '',
    '## 提交（只调这一次工具）',
    ...paramHintLines({ projectId }),
    '',
    'novel_desk_problems(',
    '  op="revise",',
    ...argLines({ projectId }),
    '  revisions=[',
    '    {problemId:"pr_xxx", drafts:[{kind:"paragraph", chapter:2, para:7, text:"替换后的整段成文（无空行）"}]},',
    '    {problemId:"pr_yyy", drafts:[{kind:"chapter", chapter:15, text:"第15章 标题\\n\\n整章正文……"}]}',
    '  ]',
    ')',
    '- `revisions` 必须覆盖上面每一条 `problemId`，一条一条对应；只放 `problemId` + `drafts`，不要带 type / scope / severity / text（那些不改）。',
    '- 一次提交；如果稿太长 JSON 过大，最多分 2–3 次按问题分批，**同一条问题只提交一次**。',
    '',
    '## 铁律',
    '- 不许派子 agent、不许 novel_desk_dispatch、不许分章转交给多个 AI。',
    '- 不许改正文文件；不许调 novel_desk_write / novel_desk_run / novel_desk_propose / novel_desk_review / novel_desk_attention / novel_desk_cold_split。',
    '- 不许调 `op="submit"` 新增问题；不许顺手改别的段落；不许把「继续改」做成新一轮审稿。',
    '- 拿不到正文 / 问题就停下说明缺什么，不要凭记忆编。',
    '',
    '## 提交前自检（逐条打勾）',
    '- 上面每条 problemId 都出现在 `revisions` 里，且每条至少 1 份稿；',
    '- 段级稿无空行、para 与问题位置一致；整章稿第一行标题正确；',
    '- 没有新增问题、没有改别的段落；只用了这一个工具。',
  ].join('\n')
}
