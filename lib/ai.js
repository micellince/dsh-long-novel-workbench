/**
 * AI 能力：让工作台里的内容可以由 DeepSeek 直接生成/审稿，
 * 结果先进入「提案」或「审稿」，人工对比后再采纳。
 *
 * 使用宿主 LLM 路由（不额外配置 key）。
 */

function fmtList(items, render, empty = '（空）') {
  return items.length > 0 ? items.map(render).join('\n') : empty
}

/** 组装写作上下文（给模型的紧凑版）。 */
export function buildAiContext(bundle, chapter) {
  const p = bundle.project ?? {}
  const preset = (bundle.presets ?? [])[0] ?? {}
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
    `# 已写章节（共 ${chapters.length} 章）`,
    `${fmtList(chapters, (c) => `- 第${c.id}章《${c.title}》${c.words}字｜${c.status}｜${c.summary ?? ''}`)}`,
    ``,
    `# 最近章节摘要`,
    `${fmtList(recent, (c) => `## 第${c.id}章《${c.title}》\n${c.summary ?? ''}${c.storyTime ? `\n时间：${c.storyTime}` : ''}${c.location ? ` ｜ 地点：${c.location}` : ''}`)}`,
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

const TASK_SPECS = {
  'next-chapter-plan': {
    maxTokens: 5000,
    instruction: (chapter) => `任务：为第 ${chapter} 章生成可直接落地的章节方案。要求：
1. 必须延续已有时间线、事实账本、未回收伏笔与进行中的冲突；
2. 不得与已写章节的事实矛盾；
3. 章数、字数目标参考写作预设；
4. 只输出 JSON。`,
    schema: (chapter) => `{
  "title": "本章标题",
  "summary": "一句话摘要",
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
    instruction: (chapter) => `任务：写第 ${chapter} 章完整正文。要求：
1. 严格遵守写作预设（视角、时态、风格规则、禁忌）；
2. 承接上一章结尾；
3. 不得与事实账本、时间线矛盾；
4. 字数接近预设的每章字数（±20%）；
5. 只输出 JSON，content 用 \\n 分段。`,
    schema: `{"title":"","summary":"","storyTime":"","location":"","characters":[],"content":"完整正文","facts":[],"events":[]}`,
  },
  custom: {
    maxTokens: 2500,
    instruction: () => '任务：按作者指令处理。只输出 JSON。',
    schema: `{"answer":"给作者的说明","proposals":[{"kind":"events|facts|foreshadow|characters|highlights|chapter|plan|custom","title":"","summary":"","chapter":0,"data":{},"items":[]}]}`,
  },
}

/** 按原提案类型生成「按意见修订」的任务规格。 */
function reviseSpec(kind) {
  const itemSchema = `{"items":[{"字段与原提案条目一致"}]}`
  const specs = {
    plan: { maxTokens: 5000, schema: TASK_SPECS['next-chapter-plan'].schema, instruction: () => '任务：按作者意见修订这份章节方案。保留未被意见涉及的部分，只输出修订后的完整方案 JSON。' },
    chapter: { maxTokens: 8000, schema: TASK_SPECS['continue-chapter'].schema, instruction: () => '任务：按作者意见修订章节正文。保留未被意见涉及的部分，保持原有风格与事实，只输出修订后的完整章节 JSON。' },
    events: { maxTokens: 4000, schema: itemSchema, instruction: () => '任务：按作者意见修订时间线事件条目。输出修订后的完整事件数组 JSON。' },
    facts: { maxTokens: 4000, schema: itemSchema, instruction: () => '任务：按作者意见修订事实账本条目。输出修订后的完整条目数组 JSON。' },
    characters: { maxTokens: 4000, schema: itemSchema, instruction: () => '任务：按作者意见修订人物条目。输出修订后的完整条目数组 JSON。' },
    foreshadow: { maxTokens: 4000, schema: itemSchema, instruction: () => '任务：按作者意见修订伏笔条目。输出修订后的完整条目数组 JSON。' },
    highlights: { maxTokens: 3000, schema: itemSchema, instruction: () => '任务：按作者意见修订高光条目。输出修订后的完整条目数组 JSON。' },
    custom: { maxTokens: 4000, schema: '{"answer":"修订后的回答"}', instruction: () => '任务：按作者意见修订这份内容。只输出 JSON。' },
  }
  return specs[kind] ?? specs.custom
}

/**
 * 调用宿主模型。
 * @param {any} ctx 插件上下文（含 llm 服务）
 * @param {object} options
 * @returns {Promise<{json:any, raw:string, task:string}>}
 */
export async function runAi(ctx, { task, bundle, chapter, instruction, proposal, feedback, signal }) {
  const spec = task === 'revise-proposal' ? reviseSpec(proposal?.kind) : TASK_SPECS[task]
  if (!spec) throw new Error(`未知 AI 任务：${task}`)
  const llm = ctx.get?.('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主未提供 LLM 服务，无法调用 AI。')
  const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? {}
  const provider = selection.provider ?? 'deepseek-official'
  const model = selection.model ?? 'deepseek-flash'
  const target = Number(chapter) || (bundle.chapters.length > 0 ? Math.max(...bundle.chapters.map((c) => Number(c.id) || 0)) + 1 : 1)
  const wantsFullText = task === 'review-chapter' || task === 'extract-facts' || task === 'continue-chapter' || (task === 'revise-proposal' && (proposal?.kind === 'chapter'))
  let context = buildAiContext(bundle, wantsFullText ? target : null)
  if (proposal) {
    const payload = proposal.data && Object.keys(proposal.data).length > 0 ? proposal.data : { items: proposal.items ?? [] }
    context += `\n\n# 待修订的原提案\nkind: ${proposal.kind}\ntitle: ${proposal.title}\n${JSON.stringify(payload, null, 2).slice(0, 12000)}`
  }
  const feedbackText = feedback ?? instruction
  const schema = typeof spec.schema === 'function' ? spec.schema(target) : spec.schema
  const user = `${context}\n\n# 输出格式（必须严格是这一个 JSON，不要代码块、不要解释）\n${schema}\n\n${spec.instruction(target)}${feedbackText ? `\n\n作者修改意见（必须逐条落实）：${feedbackText}` : ''}`
  const system = '你是资深中文长篇小说编辑与写作者。你只输出严格 JSON，不输出 Markdown 代码块、不输出任何解释文字。所有内容使用简体中文。'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 240000)
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })
  let raw = ''
  try {
    const stream = llm.stream({
      provider,
      model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      system,
      maxTokens: spec.maxTokens,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += chunk.text
      else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message ?? '模型调用失败')
      else if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') throw new Error('模型调用被取消')
      else if (chunk.type === 'finish' && chunk.reason?.kind === 'max-tokens') raw += '\n/*TRUNCATED*/'
    }
  } finally {
    clearTimeout(timer)
  }
  return { json: parseJsonLoose(raw), raw, task }
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
