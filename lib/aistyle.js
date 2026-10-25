/**
 * 去 AI 化度量：把「读起来像机器写的」拆成可计算的指标。
 *
 * 设计原则：审稿人必须能测量，否则只是另一种意见。
 * 全部指标都是确定性计算（不调模型），可逐章跑、可比对改前改后。
 *
 * 指标分三类：
 *  1) 节拍类：微动作帧密度、模板集中度、步长量化密度
 *  2) 节奏类：句长均值/长句占比、全书句长变异系数（有没有换挡）
 *  3) 语域类：对话文言度、白话标记、情绪词、明喻
 */


/**
 * Markdown 残留扫描——去 AI 化的第一优先级。
 * 成品正文里出现 ## / ** / --- / > / 列表符 / HTML 标签，是「这是生成稿」最直接、最廉价的证据，
 * 而且它对读者毫无意义，任何一条都必须清掉。
 */
export const MARKDOWN_ARTIFACTS = [
  { key: 'heading', label: 'Markdown 标题（#）', re: /^#{1,6}\s+.+$/gm },
  { key: 'bold', label: '粗体标记（**）', re: /\*\*[^*\n]{1,200}\*\*/g },
  { key: 'hr', label: '分隔线（---/***/___）', re: /^\s*[-*_]{3,}\s*$/gm },
  { key: 'quote', label: '引用块（>）', re: /^\s*>\s+.+$/gm },
  { key: 'code', label: '代码标记（反引号/围栏）', re: /```|`[^`\n]{1,120}`/g },
  { key: 'list', label: '列表符（- * + / 1.）', re: /^\s*(?:[-*+]|\d+\.)\s+/gm },
  { key: 'link', label: '链接 / 图片语法', re: /!?\[[^\]\n]{0,120}\]\([^)\n]{0,200}\)/g },
  { key: 'html', label: 'HTML 标签', re: /<\/?[a-zA-Z][^>\n]{0,80}>/g },
]

/** 扫一章正文里的 Markdown 残留，返回逐类计数与命中样例。 */
export function scanMarkdownArtifacts(raw) {
  const text = String(raw ?? '')
  const byKind = {}
  const samples = []
  let total = 0
  for (const item of MARKDOWN_ARTIFACTS) {
    item.re.lastIndex = 0
    const matches = text.match(item.re) ?? []
    if (matches.length === 0) continue
    byKind[item.key] = matches.length
    total += matches.length
    if (samples.length < 12) for (const hit of matches.slice(0, 2)) samples.push({ kind: item.key, text: String(hit).trim().slice(0, 60) })
  }
  return { total, byKind, samples }
}

/** 高频微动作帧：AI 在「极简白描」提示下最容易收敛到的一组动作。 */
const MICRO_FRAME = /看了看|看了一眼|停了一停|顿了顿|顿了一顿|停了一下|想了想|按了按|点了点|摇了摇头|擦了擦|摸了摸/g

/** 装饰性步长量化：「退后三步」「离半寸」这类纯填充的物理参数。 */
const STEP_QUANT = /[一二三四五六七八九十两半]+(?:步|寸)/g

/** 情绪词：衡量「冷」到什么程度。 */
const EMOTION = /[悲痛怒喜泪愁恨怜惊惧哀]/g

/** 明喻标记。 */
const SIMILE = /如[同]?|似[乎]?|仿佛|宛如|犹如|好似|好像/g

/** 对话中的文言固定语。 */
const CLASSICAL = /焉能|岂敢|何故|安得|岂有此理|何足|焉知|恕难|失礼|有劳|岂不|莫非/g

/** 对话中的白话标记。 */
const VERNACULAR = /[吗呢吧么啊啦]|的话/g

const QUOTE = /[“"]([^”"]{1,300})[”"]/g
const POEM_BLOCK = /\*\*【[^*]*】\*\*[\s\S]{0,260}?\n\n/

function per10k(count, chars) {
  return chars > 0 ? (count / chars) * 10000 : 0
}

function countMatches(text, re) {
  return (text.match(re) ?? []).length
}

/** 去掉回前诗与 YAML frontmatter，只量正文。 */
export function stripDecorations(raw) {
  let text = String(raw ?? '')
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end > 0) text = text.slice(end + 4)
  }
  return text.replace(POEM_BLOCK, '\n')
}

function splitSentences(text) {
  return text.split(/[。！？…]+/).map((s) => s.trim()).filter((s) => s.length > 3)
}

function mean(values) {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

function stdev(values) {
  if (values.length < 2) return 0
  const m = mean(values)
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length)
}

/** 单章指标。 */
export function analyzeChapterText(raw) {
  const text = stripDecorations(raw)
  const quotes = []
  for (const match of text.matchAll(QUOTE)) quotes.push(match[1])
  const dialogue = quotes.join('\n')
  const narration = text.replace(QUOTE, '')
  const chars = text.length || 1
  const sentences = splitSentences(text)
  const lengths = sentences.map((s) => s.length)
  const footers = countMatches(text, MICRO_FRAME)

  return {
    chars: text.length,
    sentences: lengths.length,
    microFrames: footers,
    microFramesPer10k: Number(per10k(footers, chars).toFixed(2)),
    stepQuant: countMatches(text, STEP_QUANT),
    stepQuantPer10k: Number(per10k(countMatches(text, STEP_QUANT), chars).toFixed(2)),
    emotionPer10k: Number(per10k(countMatches(text, EMOTION), chars).toFixed(2)),
    similePer10k: Number(per10k(countMatches(narration, SIMILE), chars).toFixed(2)),
    sentenceMean: Number(mean(lengths).toFixed(2)),
    sentenceStdev: Number(stdev(lengths).toFixed(2)),
    longSentenceRatio: Number((lengths.filter((n) => n > 35).length / Math.max(1, lengths.length)).toFixed(4)),
    dialogueChars: dialogue.length,
    dialogueRatio: Number((dialogue.length / chars).toFixed(4)),
    dialogueClauseMean: Number(mean(splitSentences(dialogue).map((s) => s.length)).toFixed(2)),
    dialogueClassicalPer10k: Number(per10k(countMatches(dialogue, CLASSICAL), dialogue.length || 1).toFixed(2)),
    dialogueVernacularPer10k: Number(per10k(countMatches(dialogue, VERNACULAR), dialogue.length || 1).toFixed(2)),
  }
}

/** 默认阈值：给「传统章回体 + 文白相间」这类风格用；可由预设 styleCards 覆盖。 */
export const DEFAULT_THRESHOLDS = {
  microFramesPer10k: 1.5,
  stepQuantPer10k: 10,
  emotionPer10kMin: 10,
  longSentenceRatioMin: 0.04,
  dialogueClassicalPer10kMin: 2,
  dialogueVernacularPer10kMax: 60,
  sentenceMeanCvMin: 0.15,
  topFrameShareMax: 0.5,
}

const FLAG_LABELS = {
  microFramesPer10k: '微动作帧过密（看了看/停了一停）',
  stepQuantPer10k: '装饰性步长量化过多',
  emotionPer10kMin: '情绪词过少（文风偏冷）',
  longSentenceRatioMin: '长句太少（节奏均匀，没有换挡）',
  dialogueClassicalPer10kMin: '对话文言度过低',
  dialogueVernacularPer10kMax: '对话白话标记过多',
  sentenceMeanCvMin: '全书句长变异系数过低（单一节奏档位）',
  topFrameShareMax: '微动作模板集中度过高',
}

/**
 * 全书审计。
 * @param {Array<{id:any,title?:string,content:string}>} chapters
 * @param {{thresholds?:object, topFrames?:string[]}} options
 */
export function auditAiStyle(chapters = [], options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) }
  const rows = chapters
    .filter((chapter) => String(chapter?.content ?? '').trim())
    .map((chapter) => ({
      id: chapter.id,
      title: chapter.title ?? '',
      ...analyzeChapterText(chapter.content),
      md: scanMarkdownArtifacts(chapter.content),
    }))

  const mdTotal = rows.reduce((sum, row) => sum + (row.md?.total ?? 0), 0)
  const mdByKind = {}
  for (const row of rows) {
    for (const [kind, count] of Object.entries(row.md?.byKind ?? {})) mdByKind[kind] = (mdByKind[kind] ?? 0) + count
  }
  const mdChapters = rows
    .filter((row) => (row.md?.total ?? 0) > 0)
    .map((row) => ({ chapter: row.id, title: row.title, total: row.md.total, byKind: row.md.byKind, samples: row.md.samples }))

  const overall = {
    chapters: rows.length,
    chars: rows.reduce((sum, row) => sum + row.chars, 0),
    mdArtifacts: mdTotal,
    mdByKind,
    mdChapters: mdChapters.length,
    microFramesPer10k: Number(mean(rows.map((r) => r.microFramesPer10k)).toFixed(2)),
    stepQuantPer10k: Number(mean(rows.map((r) => r.stepQuantPer10k)).toFixed(2)),
    emotionPer10k: Number(mean(rows.map((r) => r.emotionPer10k)).toFixed(2)),
    similePer10k: Number(mean(rows.map((r) => r.similePer10k)).toFixed(2)),
    longSentenceRatio: Number(mean(rows.map((r) => r.longSentenceRatio)).toFixed(4)),
    sentenceMean: Number(mean(rows.map((r) => r.sentenceMean)).toFixed(2)),
    dialogueClassicalPer10k: Number(mean(rows.map((r) => r.dialogueClassicalPer10k)).toFixed(2)),
    dialogueVernacularPer10k: Number(mean(rows.map((r) => r.dialogueVernacularPer10k)).toFixed(2)),
  }

  const means = rows.map((r) => r.sentenceMean).filter((n) => n > 0)
  overall.sentenceMeanCv = means.length > 1 && mean(means) > 0
    ? Number((stdev(means) / mean(means)).toFixed(3))
    : 0

  // 模板集中度：高频帧在全部帧里的占比
  const topFrames = Array.isArray(options.topFrames) && options.topFrames.length > 0
    ? options.topFrames
    : ['看了看', '看了一眼', '停了一停']
  const totalFrames = overall.microFramesPer10k * overall.chars / 10000
  const topCount = chapters.reduce((sum, chapter) => {
    const text = stripDecorations(chapter.content)
    return sum + topFrames.reduce((n, frame) => n + (text.split(frame).length - 1), 0)
  }, 0)
  overall.topFrameShare = totalFrames > 0 ? Number((topCount / totalFrames).toFixed(3)) : 0
  overall.topFrames = topFrames

  const flags = []
  // 第一优先级：Markdown 残留。它不需要阈值——有一条就是错。
  if (mdTotal > 0) {
    flags.push({
      key: 'mdArtifacts',
      label: `Markdown 残留（${MARKDOWN_ARTIFACTS.filter((item) => mdByKind[item.key]).map((item) => item.key + ' ' + mdByKind[item.key]).join('、')}）`,
      value: mdTotal,
      threshold: 0,
      severity: 'blocker',
      chapters: mdChapters.length,
    })
  }
  const push = (key, value, threshold, severity, chapter) => flags.push({
    key,
    label: FLAG_LABELS[key] ?? key,
    value,
    threshold,
    severity,
    ...(chapter ? { chapter } : {}),
  })

  if (overall.microFramesPer10k > thresholds.microFramesPer10k) push('microFramesPer10k', overall.microFramesPer10k, thresholds.microFramesPer10k, 'major')
  if (overall.stepQuantPer10k > thresholds.stepQuantPer10k) push('stepQuantPer10k', overall.stepQuantPer10k, thresholds.stepQuantPer10k, 'major')
  if (overall.emotionPer10k < thresholds.emotionPer10kMin) push('emotionPer10kMin', overall.emotionPer10k, thresholds.emotionPer10kMin, 'blocker')
  if (overall.longSentenceRatio < thresholds.longSentenceRatioMin) push('longSentenceRatioMin', overall.longSentenceRatio, thresholds.longSentenceRatioMin, 'major')
  if (overall.dialogueClassicalPer10k < thresholds.dialogueClassicalPer10kMin) push('dialogueClassicalPer10kMin', overall.dialogueClassicalPer10k, thresholds.dialogueClassicalPer10kMin, 'major')
  if (overall.dialogueVernacularPer10k > thresholds.dialogueVernacularPer10kMax) push('dialogueVernacularPer10kMax', overall.dialogueVernacularPer10k, thresholds.dialogueVernacularPer10kMax, 'major')
  if (rows.length > 1 && overall.sentenceMeanCv < thresholds.sentenceMeanCvMin) push('sentenceMeanCvMin', overall.sentenceMeanCv, thresholds.sentenceMeanCvMin, 'major')
  if (overall.topFrameShare > thresholds.topFrameShareMax) push('topFrameShareMax', overall.topFrameShare, thresholds.topFrameShareMax, 'major')

  // 逐章偏差：按各指标离阈值的距离排序，给改动引擎当工作单
  const chapterFlags = []
  for (const row of rows) {
    const local = []
    if (row.microFramesPer10k > thresholds.microFramesPer10k) local.push({ key: 'microFramesPer10k', value: row.microFramesPer10k })
    if (row.stepQuantPer10k > thresholds.stepQuantPer10k) local.push({ key: 'stepQuantPer10k', value: row.stepQuantPer10k })
    if (row.longSentenceRatio < thresholds.longSentenceRatioMin) local.push({ key: 'longSentenceRatioMin', value: row.longSentenceRatio })
    if (row.dialogueClassicalPer10k < thresholds.dialogueClassicalPer10kMin) local.push({ key: 'dialogueClassicalPer10kMin', value: row.dialogueClassicalPer10k })
    if (local.length > 0) chapterFlags.push({ chapter: row.id, title: row.title, hits: local })
  }

  return { overall, chapters: rows, flags, chapterFlags, mdChapters, thresholds }
}

/** 一句话结论（页面提示 / MCP status 用）。 */
export function auditSummaryText(audit) {
  const { overall, flags } = audit ?? {}
  if (!overall) return '去 AI 化审计：暂无数据'
  const mdLines = (audit.mdChapters ?? []).slice(0, 5).map((row) => {
    const kinds = Object.entries(row.byKind ?? {}).map(([key, count]) => `${key} ${count}`).join('、')
    return `  · 第${row.chapter}章《${row.title ?? ''}》：${row.total} 处（${kinds}）`
  })
  const lines = [
    '# 去 AI 化审计',
    `**第一优先级 · Markdown 残留：${overall.mdArtifacts ?? 0} 处${(audit.mdChapters ?? []).length > 0 ? `（${audit.mdChapters.length} 章）` : ''}**`,
    ...mdLines,
    `覆盖 ${overall.chapters} 章 / ${overall.chars} 字符`,
    `微动作帧 ${overall.microFramesPer10k}/万字 ｜ 步长量化 ${overall.stepQuantPer10k}/万字 ｜ 情绪词 ${overall.emotionPer10k}/万字`,
    `长句占比 ${(overall.longSentenceRatio * 100).toFixed(1)}% ｜ 句长均值 ${overall.sentenceMean} ｜ 章间句长 CV ${overall.sentenceMeanCv}`,
    `对话文言 ${overall.dialogueClassicalPer10k}/万字 ｜ 对话白话 ${overall.dialogueVernacularPer10k}/万字`,
  ]
  if (flags.length === 0) lines.push('结论：未发现明显机器痕迹。')
  else {
    lines.push('结论：')
    for (const flag of flags.sort((a, b) => (a.severity === 'blocker' ? -1 : 1)).slice(0, 8)) {
      lines.push(`- [${flag.severity}] ${flag.label}：实测 ${flag.value}（阈值 ${flag.threshold}）`)
    }
  }
  return lines.join('\n')
}
