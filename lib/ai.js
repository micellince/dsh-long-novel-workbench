/**
 * AI 能力：让工作台里的内容可以由 DeepSeek 直接生成/审稿，
 * 结果先进入「提案」或「审稿」，人工对比后再采纳。
 *
 * 使用宿主 LLM 路由（不额外配置 key）。
 */

import { resolveActivePreset } from './defaults.js'

function fmtList(items, render, empty = '（空）') {
  return items.length > 0 ? items.map(render).join('\n') : empty
}

function attentionNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 旧一键 AI 的注意力段（第一优先级）：最近曲线、平均分、未标数、上一章诊断。 */
function aiAttentionLines(bundle) {
  const rows = [...(bundle.attention ?? [])].sort((a, b) => (Number(a.chapter) || 0) - (Number(b.chapter) || 0))
  const scored = rows.filter((row) => attentionNumber(row.score) !== null)
  const average = scored.length > 0
    ? Math.round(scored.reduce((sum, row) => sum + attentionNumber(row.score), 0) / scored.length)
    : null
  const labeled = new Set(rows.map((row) => Number(row.chapter)))
  const missing = (bundle.chapters ?? []).filter((chapter) => String(chapter.content ?? '').trim() && !labeled.has(Number(chapter.id))).length
  const lines = [
    '原则：ATTENTION IS ALL YOU NEED——怎么吸引读者怎么来，一切为读者服务；事实自洽是底线，不是目标。',
    `平均分：${average ?? '暂无'} ｜ 有实测分：${scored.length} 章 ｜ 未标：${missing} 章已写`,
  ]
  if (rows.length > 0) {
    const recent = rows.slice(-6)
    lines.push(`最近 ${recent.length} 章：${recent.map((row) => `第${Number(row.chapter)}章 ${attentionNumber(row.score) ?? '未标'}分/${row.type ?? '未分型'}`).join('；')}`)
    const last = rows[rows.length - 1]
    lines.push(`上一章：第${Number(last.chapter)}章 实测 ${attentionNumber(last.score) ?? '未标'} 分 / 设计 ${attentionNumber(last.designScore) ?? '未标'}；最弱一环：${last.weakest ?? '—'}；章末问题：${last.cliff ?? '—'}`)
  } else {
    lines.push('最近注意力：暂无（先给本章做四拍设计）')
  }
  return lines
}

/** 旧一键 AI 的世界观段：world 摘要 + 地点清单 + 最近章节地点。 */
function aiWorldLines(bundle) {
  const world = bundle.world ?? {}
  const locations = Array.isArray(bundle.locations) ? bundle.locations : []
  const lines = [
    `世界：${bundle.worldSaved ? (world.name || '未命名') : '未建'} ｜ 尺度：${world.scale ?? '—'} ｜ 类型：${world.kind ?? '—'} ｜ 时代：${world.era ?? '—'}`,
  ]
  if (locations.length > 0) {
    lines.push(`地点（${locations.length}）：${locations.map((location) => {
      const connections = Array.isArray(location.connections) ? location.connections.length : 0
      return `${location.name ?? location.id}（${location.type ?? 'other'}，坐标 ${location.coords?.x ?? '?'},${location.coords?.y ?? '?'}，连接 ${connections}）`
    }).join('；')}`)
  } else {
    lines.push('地点：暂无（可用 world-build / world-infer 补齐）')
  }
  const recentLocated = (bundle.chapters ?? []).filter((chapter) => String(chapter.location ?? '').trim()).slice(-6)
  if (recentLocated.length > 0) lines.push(`最近章节地点：${recentLocated.map((chapter) => `第${Number(chapter.id)}章 ${chapter.location}`).join(' → ')}`)
  return lines
}

/** 组装写作上下文（给模型的紧凑版）。 */
export function buildAiContext(bundle, chapter) {
  const p = bundle.project ?? {}
  const preset = resolveActivePreset(bundle)
  const chapters = bundle.chapters ?? []
  const recent = chapters.slice(-3)
  const lines = [
    `# 作品`,
    `书名：${p.name ?? ''} ｜ 类型：${p.genre ?? ''} ｜ 视角：${p.pov ?? ''} ｜ 时态：${p.tense ?? ''}`,
    `一句话：${p.logline ?? ''}`,
    p.description ? `梗概：${p.description}` : '',
    ``,
    `# 写作预设`,
    `预设名：${preset.name ?? '未设置'}`,
    `计划章数：${preset.plannedChapters ?? p.targetChapters ?? '未设置'} ｜ 每章字数：${preset.chapterWords ?? '未设置'} ｜ 总字数：${preset.totalWords ?? p.targetWords ?? '未设置'}`,
    `结构：${preset.structure ?? '未设置'}`,
    `风格规则：${Array.isArray(preset.styleRules) ? preset.styleRules.join('；') : preset.styleRules ?? ''}`,
    `禁忌：${Array.isArray(preset.taboo) ? preset.taboo.join('；') : preset.taboo ?? ''}`,
    `审稿重点：${Array.isArray(preset.reviewFocus) ? preset.reviewFocus.join('；') : preset.reviewFocus ?? ''}`,
    ``,
    `# 注意力（第一优先级）`,
    ...aiAttentionLines(bundle),
    ``,
    `# 世界与地点`,
    ...aiWorldLines(bundle),
    ``,
    `# 已写章节（共 ${chapters.length} 章）`,
    `${fmtList(chapters, (c) => `- 第${c.id}章《${c.title}》${c.words}字｜${c.status}｜${c.summary ?? ''}`)}`,
    ``,
    `# 最近章节摘要`,
    `${fmtList(recent, (c) => `## 第${c.id}章《${c.title}》\n${c.summary ?? ''}${c.storyTime ? `\n时间：${c.storyTime}` : ''}${c.location ? ` ｜ 地点：${c.location}` : ''}`)}`,
    ``,
    `# 章节大纲（${(bundle.outlines ?? []).length}）`,
    `${fmtList((bundle.outlines ?? []).slice(0, 60), (o) => `- 第${o.chapter}章 ${o.title}${o.summary ? `：${String(o.summary).slice(0, 120)}` : ''}`)}`,
    ``,
    `# 事实账本（${bundle.facts.length}）`,
    `${fmtList(bundle.facts, (f) => `- ${f.subject}·${f.attribute}=${f.value}（第${f.chapter ?? '?'}章）`)}`,
    ``,
    `# 时间线（${bundle.events.length}）`,
    `${fmtList(bundle.events, (e) => `- [第${e.chapter ?? '?'}章｜${e.storyTime ?? '时间未填'}] ${e.title}：${e.summary ?? ''}`)}`,
    ``,
    `# 未回收伏笔`,
    `${fmtList((bundle.foreshadow ?? []).filter((f) => f.status !== 'paid' && f.status !== 'dropped'), (f) => `- ${f.title}（第${f.setupChapter ?? '?'}章埋，第${f.payoffChapter ?? '?'}章收）：${f.note ?? ''}`)}`,
    ``,
    `# 进行中的冲突`,
    `${fmtList((bundle.conflicts ?? []).filter((c) => c.status === 'active'), (c) => `- ${c.title}（${c.type ?? ''}）：赌注=${c.stakes ?? ''}；升级=${c.escalation ?? ''}`)}`,
    ``,
    `# 人物`,
    `${fmtList(bundle.characters ?? [], (c) => `- ${c.name}（${c.role ?? ''}）：目标=${c.goal ?? ''}；动机=${c.motivation ?? ''}；缺陷=${c.flaw ?? ''}；弧光=${c.arc ?? ''}`)}`,
    ``,
    `# Agent 分工`,
    `${fmtList(bundle.agents ?? [], (a) => `- ${a.name}：${a.duty}`)}`,
  ]
  if (chapter) {
    const hit = chapters.find((c) => Number(c.id) === Number(chapter))
    if (hit) {
      lines.push('', `# 目标章节全文（第${hit.id}章《${hit.title}》）`, hit.content ?? '')
    }
  }
  return lines.filter((x) => x !== undefined).join('\n')
}

export const TASK_SPECS = {
  'next-chapter-plan': {
    maxTokens: 5000,
    instruction: (chapter) => `任务：为第 ${chapter} 章生成可直接落地的章节方案。第一优先级是注意力/读者：ATTENTION IS ALL YOU NEED，怎么吸引读者怎么来，事实自洽是底线、不是目标。要求：
1. 先定注意力设计（type/hook/tension/payoff/cliff/question/designScore），四拍必须具体、可核对，再写情节；
2. 必须延续已有时间线、事实账本、未回收伏笔与进行中的冲突；
3. 不得与已写章节的事实矛盾；
4. 章数、字数目标参考写作预设；
5. 只输出 JSON。`,
    schema: (chapter) => `{
  "title": "本章标题",
  "summary": "一句话摘要",
  "attention": {"type":"event|emotion|language|mystery|relationship","hook":"开篇钩子","tension":"本章承压点","payoff":"本章兑现","cliff":"章末未决问题","question":"读者最想知道的一句话","designScore":0},
  "storyTime": "故事内时间",
  "location": "地点",
  "characters": ["出场人物"],
  "beats": ["节拍1", "节拍2", "节拍3", "节拍4"],
  "events": [{"title":"事件","chapter":${chapter},"storyTime":"","location":"","participants":[],"summary":"","consequences":"","importance":"normal|major|climax"}],
  "facts": [{"subject":"","attribute":"","value":"","chapter":${chapter},"note":""}],
  "foreshadow": [{"title":"","setupChapter":${chapter},"payoffChapter":0,"status":"open","note":""}]
}`,
  },
  'generate-timeline': {
    maxTokens: 4000,
    instruction: (chapter) => `任务：为第 ${chapter} 章补全时间线事件。要求事件按故事内时间排序、参与人必须是已有或本章新建人物、因果清晰。只输出 JSON。`,
    schema: (chapter) => `{"events":[{"title":"","chapter":${chapter},"storyTime":"","location":"","participants":[],"summary":"","consequences":"","importance":"normal|major|climax"}]}`,
  },
  'extract-facts': {
    maxTokens: 4000,
    instruction: (chapter) => `任务：从第 ${chapter} 章正文中抽取事实账本条目与人物卡。事实必须是可核对的客观信息（年龄、身份、地点、物品归属、伤势、日期等）。只输出 JSON。`,
    schema: (chapter) => `{"facts":[{"subject":"","attribute":"","value":"","chapter":${chapter},"note":""}],"characters":[{"name":"","role":"supporting","goal":"","flaw":""}]}`,
  },
  'review-chapter': {
    maxTokens: 6000,
    instruction: (chapter) => `任务：以责编身份审第 ${chapter} 章。按写作预设的审稿重点逐项检查，问题要定位到具体句子或段落，给出可执行的修改建议。严重度 blocker/major/minor/suggestion。只输出 JSON。`,
    schema: `{"reviews":[{"dimension":"情节|人物|文笔|连续性|节奏|对话|世界观|主题","severity":"blocker|major|minor|suggestion","issue":"问题（引用原文）","suggestion":"修改建议"}],"overall":"总体判断","highlights":[{"text":"值得保留的句子","note":"为什么好"}]}`,
  },
  'continue-chapter': {
    maxTokens: 8000,
    instruction: (chapter) => `任务：写第 ${chapter} 章完整正文。第一优先级是注意力/读者：ATTENTION IS ALL YOU NEED，怎么吸引读者怎么来，事实自洽是底线、不是目标；正文必须按四拍（hook/tension/payoff/cliff）落地，章末必须留未决问题。要求：
1. 严格遵守写作预设（视角、时态、风格规则、禁忌）；
2. 承接上一章结尾；
3. 不得与事实账本、时间线矛盾；
4. 字数接近预设的每章字数（±20%）；
5. 只输出 JSON，content 用 \\n 分段。`,
    schema: `{"title":"","summary":"","attention":{"type":"event|emotion|language|mystery|relationship","hook":"","tension":"","payoff":"","cliff":"","question":"","designScore":0},"storyTime":"","location":"","characters":[],"content":"完整正文","facts":[],"events":[]}`,
  },
  'import-fill-characters': {
    maxTokens: 7000,
    instruction: () =>
      '任务：根据正文补齐缺失的人物卡。只输出正文里出现、但已有清单中没有的人物；不要重复已有名字。只输出 JSON。',
    schema: `{"characters":[{"name":"","role":"protagonist|antagonist|supporting|minor","goal":"","motivation":"","flaw":"","personality":"","arc":""}]}`,
  },
  'import-fill-events': {
    maxTokens: 9000,
    instruction: () =>
      '任务：为缺少时间线事件的章节补充事件。只为已有事件章节之外的章节输出；事件按故事时间排序，participants 用正文里的名字。只输出 JSON。',
    schema: `{"events":[{"title":"","chapter":1,"storyTime":"","location":"","participants":[],"summary":"","consequences":"","importance":"normal|major|climax"}]}`,
  },
  'import-fill-outlines': {
    maxTokens: 9000,
    instruction: () =>
      '任务：为缺少大纲的已写章节补充章节大纲。只为已有大纲章节之外的章节输出，title 用该章标题，summary 概括本章，beats 给 3–5 个节拍。只输出 JSON。',
    schema: `{"outlines":[{"chapter":1,"title":"","summary":"","beats":["节拍"],"status":"drafted"}]}`,
  },
  'import-conflicts': {
    maxTokens: 14000,
    instruction: () =>
      `任务：核查正文与已有设定之间的冲突。逐条对照人物卡、时间线、事实账本、大纲，找出：
- 设定冲突（年龄/身份/物品/地点前后不一致）
- 时间线矛盾（故事时间、事件顺序）
- 人物行为与人物卡不符
- 正文与大纲不符
每条定位到具体章节，issue 引用原文或设定，suggestion 给可执行修改建议。没有把握的不要编。只输出 JSON。`,
    schema: `{"conflicts":[{"chapter":1,"dimension":"连续性|人物|事实|时间线|大纲","severity":"blocker|major|minor","issue":"","suggestion":"","against":"人物卡/追踪/大纲/正文"}]}`,
  },
  'review-fix': {
    maxTokens: 14000,
    instruction: (chapter) =>
      `任务：按一条审稿意见修改第 ${chapter} 章。只改必要处，其余保持原样；不要改变剧情走向和设定，除非审稿意见明确要求。输出修改后的完整章节 JSON。`,
    schema: `{"title":"章节标题","summary":"一句话摘要","content":"修改后的完整正文"}`,
  },
  custom: {
    maxTokens: 2500,
    instruction: () => '任务：按作者指令处理。只输出 JSON。',
    schema: `{"answer":"给作者的说明","proposals":[{"kind":"events|facts|foreshadow|characters|highlights|chapter|plan|custom","title":"","summary":"","chapter":0,"data":{},"items":[]}]}`,
  },
}

/** 导入后的补全/冲突核查上下文：正文节选 + 已有条目清单。 */
function buildImportContext(bundle) {
  const base = buildAiContext(bundle, null)
  const chapterBlocks = (bundle.chapters ?? []).slice(0, 12).map((c) => `## 第${c.id}章《${c.title}》\n${String(c.content ?? '').slice(0, 1600)}`).join('\n\n')
  const existing = [
    `已有 ${bundle.characters.length} 人物卡：${bundle.characters.map((c) => c.name).join('、') || '（无）'}`,
    `已有事件的章节：${[...new Set(bundle.events.map((e) => e.chapter))].join('、') || '（无）'}`,
    `已有大纲的章节：${bundle.outlines.map((o) => o.chapter).join('、') || '（无）'}`,
    `已有事实 ${bundle.facts.length} 条，伏笔 ${bundle.foreshadow.length} 条`,
  ].join('\n')
  return `${base}\n\n# 导入正文节选\n${chapterBlocks || '（无正文）'}\n\n# 已有条目清单\n${existing}`
}

/** 按原提案类型生成「按意见修订」的任务规格。 */
function reviseSpec(kind) {
  const itemSchema = `{"items":[{"字段与原提案条目一致"}]}`
  const specs = {
    plan: { maxTokens: 6000, schema: TASK_SPECS['next-chapter-plan'].schema, instruction: () => '任务：按作者意见修订这份章节方案。保留未被意见涉及的部分，只输出修订后的完整方案 JSON。' },
    chapter: { maxTokens: 12000, schema: TASK_SPECS['continue-chapter'].schema, instruction: () => '任务：按作者意见修订章节正文。保留未被意见涉及的部分，保持原有风格与事实，只输出修订后的完整章节 JSON。' },
    events: { maxTokens: 4000, schema: itemSchema, instruction: () => '任务：按作者意见修订时间线事件条目。输出修订后的完整事件数组 JSON。' },
    facts: { maxTokens: 4000, schema: itemSchema, instruction: () => '任务：按作者意见修订事实账本条目。输出修订后的完整条目数组 JSON。' },
    characters: { maxTokens: 4000, schema: itemSchema, instruction: () => '任务：按作者意见修订人物条目。输出修订后的完整条目数组 JSON。' },
    foreshadow: { maxTokens: 4000, schema: itemSchema, instruction: () => '任务：按作者意见修订伏笔条目。输出修订后的完整条目数组 JSON。' },
    highlights: { maxTokens: 3000, schema: itemSchema, instruction: () => '任务：按作者意见修订高光条目。输出修订后的完整条目数组 JSON。' },
    custom: { maxTokens: 6000, schema: '{"answer":"修订后的回答（不超过 1200 字）"}', instruction: () => '任务：按作者意见修订这份内容。只输出 JSON，回答要简洁。' },
    decision: {
      maxTokens: 5000,
      schema: '{"title":"修订后的决策标题","summary":"一句话说明","options":[{"id":"text","label":"以正文为准（改设定/大纲）"},{"id":"setting","label":"以设定为准（改正文）"},{"id":"custom","label":"其他处理方式"}],"recommended":"text","answer":"不超过 300 字的裁定说明"}',
      instruction: () => '任务：这是一条冲突决策提案。按作者意见调整决策选项与裁定说明；选项要具体、可执行，不要长篇分析。只输出 JSON。',
    },
  }
  return specs[kind] ?? specs.custom
}

/**
 * 调用宿主模型。
 * @param {any} ctx 插件上下文（含 llm 服务）
 * @param {object} options
 * @returns {Promise<{json:any, raw:string, task:string}>}
 */
export async function runAi(ctx, { task, bundle, chapter, instruction, proposal, feedback, review, signal }) {
  const startedAt = Date.now()
  const spec = task === 'revise-proposal' ? reviseSpec(proposal?.kind) : TASK_SPECS[task]
  if (!spec) throw new Error(`未知 AI 任务：${task}`)
  const llm = ctx.get?.('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主未提供 LLM 服务，无法调用 AI。')
  const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? {}
  const provider = selection.provider ?? 'deepseek-official'
  const model = selection.model ?? 'deepseek-flash'
  const target = Number(chapter) || (bundle.chapters.length > 0 ? Math.max(...bundle.chapters.map((c) => Number(c.id) || 0)) + 1 : 1)
  const wantsFullText = task === 'review-chapter' || task === 'extract-facts' || task === 'continue-chapter' || task === 'review-fix' || (task === 'revise-proposal' && (proposal?.kind === 'chapter'))
  let context = task.startsWith('import-') ? buildImportContext(bundle) : buildAiContext(bundle, wantsFullText ? target : null)
  if (proposal) {
    const payload = proposal.data && Object.keys(proposal.data).length > 0 ? proposal.data : { items: proposal.items ?? [] }
    context += `\n\n# 待修订的原提案\nkind: ${proposal.kind}\ntitle: ${proposal.title}\n${JSON.stringify(payload, null, 2).slice(0, 12000)}`
  }
  if (review) {
    context += `\n\n# 要处理的审稿意见\n- 维度：${review.dimension ?? ''}\n- 严重度：${review.severity ?? ''}\n- 问题：${review.issue ?? ''}\n- 建议：${review.suggestion ?? ''}`
  }
  const feedbackText = feedback ?? instruction
  const schema = typeof spec.schema === 'function' ? spec.schema(target) : spec.schema
  const user = `${context}\n\n# 输出格式（必须严格是这一个 JSON，不要代码块、不要解释）\n${schema}\n\n${spec.instruction(target)}${feedbackText ? `\n\n作者修改意见（必须逐条落实）：${feedbackText}` : ''}`
  const system = '你是资深中文长篇小说编辑与写作者。你只输出严格 JSON，不输出 Markdown 代码块、不输出任何解释文字。所有内容使用简体中文。'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 240000)
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })
  let raw = ''
  let usage = null
  try {
    const stream = llm.stream({
      provider,
      model,
      ...(task.startsWith('import-') || task === 'review-fix' || task === 'revise-proposal'
        ? { reasoningEffort: 'off' }
        : selection.reasoningEffort
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      system,
      maxTokens: spec.maxTokens,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message ?? '模型调用失败')
      else if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') throw new Error('模型调用被取消')
      else if (chunk.type === 'finish' && chunk.reason?.kind === 'max-tokens') raw += '\n/*TRUNCATED*/'
    }
  } finally {
    clearTimeout(timer)
  }
  if (raw.includes('/*TRUNCATED*/')) {
    throw new Error(`AI 输出超过 token 上限被截断（任务 ${task}）。请把修改意见写短一些，或拆成多次修改；章节正文可以改用「审稿 → AI 修改」。`)
  }
  return { json: parseJsonLoose(raw), raw, task, usage, model, provider, durationMs: Date.now() - startedAt }
}

/** 估算当前项目上下文（默认档）的体积，并拆成区块。 */
export function estimateContext(bundle) {
  const text = buildAiContext(bundle, null)
  const chars = text.length
  const tokens = Math.ceil(chars / 1.6)
  const parts = []
  const chunks = text.split(/\n(?=# )/)
  for (const chunk of chunks) {
    const title = chunk.startsWith('# ') ? chunk.slice(2, chunk.indexOf('\n') === -1 ? undefined : chunk.indexOf('\n')).trim() : '前言'
    const size = chunk.length
    parts.push({ title: title || '前言', chars: size, tokens: Math.ceil(size / 1.6) })
  }
  return { chars, tokens, parts }
}

/** 把字符串内未转义的控制字符转义（模型常直接输出换行）。 */
function repairJson(s) {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of s) {
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue }
      if (ch === '\\') { out += ch; escaped = true; continue }
      if (ch === '"') { out += ch; inString = false; continue }
      const code = ch.codePointAt(0)
      if (code < 0x20) { out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`; continue }
      out += ch
    } else {
      if (ch === '"') inString = true
      out += ch
    }
  }
  return out
}

/** 宽容解析：去代码块围栏、截取 JSON、修复字符串内控制字符。 */
export function parseJsonLoose(text) {
  let s = String(text ?? '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) s = s.slice(start, end + 1)
  s = s.replace(/\n\/\*TRUNCATED\*\//g, '')
  try {
    return JSON.parse(s)
  } catch (first) {
    try {
      return JSON.parse(repairJson(s))
    } catch (second) {
      const truncated = String(text).includes('TRUNCATED')
      throw new Error(`AI 返回的不是合法 JSON${truncated ? '（输出被 token 上限截断）' : ''}：${second.message}\n原始输出前 500 字：${String(text).slice(0, 500)}`)
    }
  }
}
