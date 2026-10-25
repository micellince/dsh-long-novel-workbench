/**
 * 去 AI 味确定性审计：把「读起来像机器写的」拆成可计算的指标。
 *
 * 适配自 0.5.2 `lib/aistyle.js`（阈值与信号表沿用旧实现），0.6.0 只输出
 * `score`（0–100，越低越干净）+ `signals`，不再输出四档 severity。
 *
 * 全部指标确定性计算（不调模型），可逐章跑、可比对改前改后：
 *  1) 残留类：Markdown 成品痕迹（## / ** / 列表符 / HTML）
 *  2) 节拍类：微动作帧密度、模板集中度、装饰性步长量化密度
 *  3) 节奏类：句长均值、长句占比（有没有换挡）
 *  4) 语域类：对话文言度、白话标记、情绪词、明喻
 */

import { normalizeProse } from './prose.js'

/** 去 AI 味分数阈值（0–100 越低越干净；> 30 判 fail）。gates.js 的 AISTYLE_MAX 与此保持一致。 */
export const AISTYLE_PASS_MAX = 30

/**
 * Markdown 残留表——去 AI 化的第一优先级。
 * 成品正文里出现 ## / ** / --- / > / 列表符 / HTML 标签，是「这是生成稿」最直接、最廉价的证据，
 * 而且它对读者毫无意义，任何一条都必须清掉。
 */
export const MARKDOWN_ARTIFACTS = [
  { id: 'heading', label: 'Markdown 标题（#）', re: /^#{1,6}\s+.+$/gm },
  { id: 'bold', label: '粗体标记（**）', re: /\*\*[^*\n]{1,200}\*\*/g },
  { id: 'hr', label: '分隔线（---/***/___）', re: /^\s*[-*_]{3,}\s*$/gm },
  { id: 'quote', label: '引用块（>）', re: /^\s*>\s+.+$/gm },
  { id: 'code', label: '代码标记（反引号/围栏）', re: /```|`[^`\n]{1,120}`/g },
  { id: 'list', label: '列表符（- * + / 1.）', re: /^\s*(?:[-*+]|\d+\.)\s+/gm },
  { id: 'link', label: '链接 / 图片语法', re: /!?\[[^\]\n]{0,120}\]\([^)\n]{0,200}\)/g },
  { id: 'html', label: 'HTML 标签', re: /<\/?[a-zA-Z][^>\n]{0,80}>/g },
]

/** 高频微动作帧：AI 在「极简白描」提示下最容易收敛到的一组动作。 */
const MICRO_FRAME = /看了看|看了一眼|停了一停|顿了顿|顿了一顿|停了一下|想了想|按了按|点了点|摇了摇头|擦了擦|摸了摸/g

/** 模板集中度统计的默认前三个高帧（沿用旧实现）。 */
const DEFAULT_TOP_FRAMES = ['看了看', '看了一眼', '停了一停']

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

/**
 * 默认阈值（沿用旧实现，口径为「传统章回体 + 文白相间」）。
 * 只作为打分基线，不再出现在输出里做四档分级。
 */
export const DEFAULT_THRESHOLDS = {
  microFramesPer10k: 1.5,
  stepQuantPer10k: 10,
  emotionPer10kMin: 10,
  longSentenceRatioMin: 0.04,
  dialogueClassicalPer10kMin: 2,
  dialogueVernacularPer10kMax: 60,
  topFrameShareMax: 0.5,
}

/** 单条信号的封顶分与权重（权重 = 超阈值 1 倍时的扣分，封顶见每项）。 */
const SIGNAL_WEIGHT = {
  markdown: 8, // 每处 8 分，封顶 40：有一条就是错
  microFrames: 12, // 封顶 22
  stepQuant: 8, // 封顶 14
  emotion: 10, // 封顶 16
  longSentence: 10, // 封顶 16
  dialogueClassical: 8, // 封顶 12
  dialogueVernacular: 6, // 封顶 10
  topFrameShare: 8, // 封顶 10
}

const SIGNAL_LABEL = {
  markdown: 'Markdown 残留',
  microFrames: '微动作帧过密（看了看/停了一停）',
  stepQuant: '装饰性步长量化过多',
  emotion: '情绪词过少（文风偏冷）',
  longSentence: '长句太少（节奏均匀，没有换挡）',
  dialogueClassical: '对话文言度过低',
  dialogueVernacular: '对话白话标记过多',
  topFrameShare: '微动作模板集中度过高',
}

/** 把 normalizeProse 无法自动清理的残留也算进来（需求之外的兜底）。 */
function normalizeResidueCount(text) {
  try {
    const result = normalizeProse(text)
    if (!result || result.changed === false) return 0
    const removed = Object.values(result.removed ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0)
    return removed
  } catch {
    return 0
  }
}

function per10k(count, chars) {
  return chars > 0 ? (count / chars) * 10000 : 0
}

function countMatches(text, re) {
  re.lastIndex = 0
  return (text.match(re) ?? []).length
}

function sampleMatches(text, re, limit = 3) {
  const flag = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const copy = new RegExp(re.source, flag)
  const out = []
  for (const match of text.matchAll(copy)) {
    const hit = String(match[0] ?? '').trim()
    if (hit) out.push(hit.slice(0, 60))
    if (out.length >= limit) break
  }
  return out
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

/**
 * 扫一章正文里的 Markdown 残留。
 * @returns {{ count: number, artifacts: Array<{id:string,label:string,count:number,samples:string[]}> }}
 */
export function scanMarkdownArtifacts(raw) {
  const text = String(raw ?? '')
  const artifacts = []
  let count = 0
  for (const item of MARKDOWN_ARTIFACTS) {
    const re = new RegExp(item.re.source, item.re.flags.includes('g') ? item.re.flags : `${item.re.flags}g`)
    const hits = text.match(re) ?? []
    if (hits.length === 0) continue
    count += hits.length
    artifacts.push({
      id: item.id,
      label: item.label,
      count: hits.length,
      samples: hits.slice(0, 3).map((hit) => String(hit).trim().slice(0, 60)),
    })
  }
  return { count, artifacts }
}

/** 单篇文本的原始指标（旧 `analyzeChapterText` 的 0.6 版）。 */
export function analyzeText(raw) {
  const text = stripDecorations(raw)
  const quotes = []
  for (const match of text.matchAll(new RegExp(QUOTE.source, 'g'))) quotes.push(match[1])
  const dialogue = quotes.join('\n')
  const narration = text.replace(new RegExp(QUOTE.source, 'g'), '')
  const chars = text.length || 1
  const sentences = splitSentences(text)
  const lengths = sentences.map((s) => s.length)
  const microFrames = countMatches(text, MICRO_FRAME)
  const topFrames = DEFAULT_TOP_FRAMES
  const topCount = topFrames.reduce((sum, frame) => sum + (text.split(frame).length - 1), 0)
  return {
    chars: text.length,
    sentences: lengths.length,
    microFrames,
    microFramesPer10k: Number(per10k(microFrames, chars).toFixed(2)),
    topFrameShare: microFrames > 0 ? Number((topCount / microFrames).toFixed(3)) : 0,
    stepQuant: countMatches(text, STEP_QUANT),
    stepQuantPer10k: Number(per10k(countMatches(text, STEP_QUANT), chars).toFixed(2)),
    emotion: countMatches(text, EMOTION),
    emotionPer10k: Number(per10k(countMatches(text, EMOTION), chars).toFixed(2)),
    similePer10k: Number(per10k(countMatches(narration, SIMILE), chars).toFixed(2)),
    sentenceMean: Number(mean(lengths).toFixed(2)),
    longSentenceRatio: Number((lengths.filter((n) => n > 35).length / Math.max(1, lengths.length)).toFixed(4)),
    dialogueChars: dialogue.length,
    dialogueRatio: Number((dialogue.length / chars).toFixed(4)),
    dialogueClassicalPer10k: Number(per10k(countMatches(dialogue, CLASSICAL), dialogue.length || 1).toFixed(2)),
    dialogueVernacularPer10k: Number(per10k(countMatches(dialogue, VERNACULAR), dialogue.length || 1).toFixed(2)),
  }
}

/** 「越大越糟」的扣分：超过阈值多少倍，线性扣到封顶。 */
function overScore(value, threshold, weight, cap) {
  if (!(threshold > 0) || !(value > threshold)) return 0
  return Math.min(cap, (value / threshold - 1) * weight)
}

/** 「越小越糟」的扣分：低于阈值多少比例，线性扣到封顶。 */
function underScore(value, threshold, weight, cap) {
  if (!(threshold > 0) || value >= threshold) return 0
  return Math.min(cap, (1 - value / threshold) * weight)
}

function roundScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/**
 * 单篇正文的去 AI 味审计（章级闸门用）。
 * @param {string} raw 正文（可带 frontmatter，内部会剥）
 * @param {{thresholds?:object, topFrames?:string[]}} [options]
 * @returns {{ score:number, signals:Array<{id:string,label:string,count:number,samples:string[],value:number,threshold:number}>, pass:boolean, chars:number }}
 */
export function auditAiStyle(raw, options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) }
  const text = stripDecorations(raw)
  const stats = analyzeText(raw)
  const md = scanMarkdownArtifacts(text)
  const residue = normalizeResidueCount(text)
  const mdCount = md.count + residue
  const shortText = text.length < 500 // 短文本（摘要/大纲）只信「残留 + 模板」类信号
  const signals = []
  let score = 0

  if (mdCount > 0) {
    const contribution = Math.min(40, mdCount * SIGNAL_WEIGHT.markdown)
    score += contribution
    signals.push({
      id: 'markdown',
      label: SIGNAL_LABEL.markdown,
      count: mdCount,
      samples: md.artifacts.flatMap((item) => item.samples).slice(0, 3),
      value: mdCount,
      threshold: 0,
      score: Math.round(contribution),
    })
  }

  if (stats.microFramesPer10k > thresholds.microFramesPer10k) {
    const contribution = overScore(stats.microFramesPer10k, thresholds.microFramesPer10k, SIGNAL_WEIGHT.microFrames, 22)
    score += contribution
    signals.push({
      id: 'micro-frames',
      label: SIGNAL_LABEL.microFrames,
      count: stats.microFrames,
      samples: sampleMatches(text, MICRO_FRAME).slice(0, 3),
      value: stats.microFramesPer10k,
      threshold: thresholds.microFramesPer10k,
      score: Math.round(contribution),
    })
  }

  if (stats.stepQuantPer10k > thresholds.stepQuantPer10k) {
    const contribution = overScore(stats.stepQuantPer10k, thresholds.stepQuantPer10k, SIGNAL_WEIGHT.stepQuant, 14)
    score += contribution
    signals.push({
      id: 'step-quant',
      label: SIGNAL_LABEL.stepQuant,
      count: stats.stepQuant,
      samples: sampleMatches(text, STEP_QUANT).slice(0, 3),
      value: stats.stepQuantPer10k,
      threshold: thresholds.stepQuantPer10k,
      score: Math.round(contribution),
    })
  }

  if (!shortText) {
    if (stats.emotionPer10k < thresholds.emotionPer10kMin) {
      const contribution = underScore(stats.emotionPer10k, thresholds.emotionPer10kMin, SIGNAL_WEIGHT.emotion, 16)
      score += contribution
      signals.push({
        id: 'emotion-sparse',
        label: SIGNAL_LABEL.emotion,
        count: stats.emotion,
        samples: [],
        value: stats.emotionPer10k,
        threshold: thresholds.emotionPer10kMin,
        score: Math.round(contribution),
      })
    }
    if (stats.sentences >= 8 && stats.longSentenceRatio < thresholds.longSentenceRatioMin) {
      const contribution = underScore(stats.longSentenceRatio, thresholds.longSentenceRatioMin, SIGNAL_WEIGHT.longSentence, 16)
      score += contribution
      signals.push({
        id: 'long-sentence',
        label: SIGNAL_LABEL.longSentence,
        count: Math.round(stats.longSentenceRatio * Math.max(1, stats.sentences)),
        samples: [],
        value: stats.longSentenceRatio,
        threshold: thresholds.longSentenceRatioMin,
        score: Math.round(contribution),
      })
    }
    if (stats.dialogueChars >= 100) {
      if (stats.dialogueClassicalPer10k < thresholds.dialogueClassicalPer10kMin) {
        const contribution = underScore(stats.dialogueClassicalPer10k, thresholds.dialogueClassicalPer10kMin, SIGNAL_WEIGHT.dialogueClassical, 12)
        score += contribution
        signals.push({
          id: 'dialogue-classical',
          label: SIGNAL_LABEL.dialogueClassical,
          count: 0,
          samples: [],
          value: stats.dialogueClassicalPer10k,
          threshold: thresholds.dialogueClassicalPer10kMin,
          score: Math.round(contribution),
        })
      }
      if (stats.dialogueVernacularPer10k > thresholds.dialogueVernacularPer10kMax) {
        const contribution = overScore(stats.dialogueVernacularPer10k, thresholds.dialogueVernacularPer10kMax, SIGNAL_WEIGHT.dialogueVernacular, 10)
        score += contribution
        signals.push({
          id: 'dialogue-vernacular',
          label: SIGNAL_LABEL.dialogueVernacular,
          count: 0,
          samples: [],
          value: stats.dialogueVernacularPer10k,
          threshold: thresholds.dialogueVernacularPer10kMax,
          score: Math.round(contribution),
        })
      }
    }
  }

  if (stats.microFrames >= 6 && stats.topFrameShare > thresholds.topFrameShareMax) {
    const contribution = overScore(stats.topFrameShare, thresholds.topFrameShareMax, SIGNAL_WEIGHT.topFrameShare, 10)
    score += contribution
    signals.push({
      id: 'top-frame-share',
      label: SIGNAL_LABEL.topFrameShare,
      count: Math.round(stats.topFrameShare * stats.microFrames),
      samples: (options.topFrames ?? DEFAULT_TOP_FRAMES).slice(0, 3),
      value: stats.topFrameShare,
      threshold: thresholds.topFrameShareMax,
      score: Math.round(contribution),
    })
  }

  const total = roundScore(score)
  return { score: total, signals, pass: total <= AISTYLE_PASS_MAX, chars: text.length }
}

/**
 * 摘要/标题本身是否有 AI 味（章级 meta 的 summary、提案 summary 用）。
 * @param {object|string} meta 章节 meta（含 summary）或直接给字符串
 * @returns {{ score:number, signals:Array, pass:boolean, chars:number, text:string }}
 */
export function auditSummaryText(meta) {
  const text = typeof meta === 'string'
    ? meta
    : String(meta?.summary ?? meta?.excerpt ?? meta?.text ?? '')
  const result = auditAiStyle(text)
  return { ...result, text }
}

/** 一句话结论（页面提示 / 工具输出用）。 */
export function auditSummaryTextLine(audit) {
  const result = audit && typeof audit === 'object' ? audit : auditSummaryText(audit)
  const top = result.signals.slice(0, 3).map((signal) => `${signal.label}（${signal.count}）`).join('、')
  return `去 AI 味：${result.score} 分（${result.pass ? '通过' : `超过 ${AISTYLE_PASS_MAX} 分阈值`}）${top ? `；主要信号：${top}` : '；未发现明显机器痕迹'}`
}
