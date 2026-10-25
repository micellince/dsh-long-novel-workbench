/**
 * 正文写入闸门：所有 AI 产出正文/提案正文都走这里，失败不落盘。
 *
 * 五步（任一失败即停，返回未改盘）：
 *   0) normalizeProse   规范化 Markdown → 纯文本；无法安全处理的结构（表格/未闭合）判 fail
 *   1) 保真 extractAnchors / evaluateFidelity   上一版正文里的数字与专名必须还在
 *   2) 残留 scanResidue  规范化后仍有 Markdown 片段 → fail
 *   3) 去 AI 味 auditAiStyle  分数 > AISTYLE_MAX → fail
 *   4) store.saveChapter 落盘（内部备份 + contentHash + words）
 */

import { normalizeProse, scanResidue } from './prose.js'
import { auditAiStyle } from './aistyle.js'

/** 去 AI 味阈值：0–100，越低越干净；> 30 判 fail（与 aistyle.AISTYLE_PASS_MAX 一致）。 */
export const AISTYLE_MAX = 30

/** 数字锚点：中文量词/时间单位前的数字（沿用旧 revision.js 口径）。 */
const NUMBER_TOKEN = /(?:[0-9]+|[一二三四五六七八九十百千两半几]+)(?=步|寸|分|尺|丈|里|年|月|日|天|次|个|块|张|支|只|匹|碗|斤|两|人|句|回|章)/g

/** 对白条数：中英文引号都算。 */
const QUOTE_TOKEN = /[“"]([^”"]{1,300})[”"]/g

/** 数字保留率下限（旧 evaluateFidelity 口径）。 */
export const NUMBER_KEEP_RATIO = 0.8

function sampleOf(text, re, limit = 8) {
  re.lastIndex = 0
  const out = []
  for (const match of String(text ?? '').matchAll(new RegExp(re.source, 'g'))) {
    out.push(String(match[0]))
    if (out.length >= limit) break
  }
  return out
}

function countQuotes(text) {
  return (String(text ?? '').match(QUOTE_TOKEN) ?? []).length
}

function cjkBigrams(text) {
  const clean = String(text ?? '').replace(/[^\u3400-\u9fff]/g, '')
  const out = new Set()
  for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2))
  return out
}

function lastSentence(text) {
  const parts = String(text ?? '').split(/[。！？…\n]+/).map((s) => s.trim()).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

/**
 * 从上一版正文抽取「改后必须还在」的锚点。
 * @param {string|{text?:string, content?:string, characters?:string[]}} source 正文或章节对象
 * @param {{characterNames?:string[]}} [options]
 * @returns {{ names:string[], numbers:string[], dialogueCount:number, hook:string, chars:number }}
 */
export function extractAnchors(source, options = {}) {
  let text = ''
  let cast = []
  if (typeof source === 'string') text = source
  else if (source && typeof source === 'object') {
    text = String(source.text ?? source.content ?? '')
    cast = Array.isArray(source.characters) ? source.characters.map(String) : []
  }
  const known = Array.isArray(options.characterNames) ? options.characterNames.map(String) : []
  const names = [...new Set([
    ...cast.filter((name) => name && text.includes(name)),
    ...known.filter((name) => name && text.includes(name)),
  ])]
  return {
    names,
    numbers: [...new Set(text.match(NUMBER_TOKEN) ?? [])],
    dialogueCount: countQuotes(text),
    hook: lastSentence(text),
    chars: text.length,
  }
}

/**
 * 保真评估：专名逐个必须还在；数字保留率 ≥ 0.8；对白条数变化 ≤ ±20%；章末钩子需有承接。
 * 前两项是 pass/fail 的硬条件，后两项只作证据（避免合理改写被误杀）。
 * @returns {{ pass:boolean, hit:number, total:number, missing:Array<{type:string,value:string}>, notes:Array }}
 */
export function evaluateFidelity(previousText, nextText, anchors = null) {
  const text = String(nextText ?? '')
  const source = anchors ?? extractAnchors(previousText)
  const missing = []
  const notes = []
  let hit = 0
  let total = 0

  for (const name of source.names ?? []) {
    total += 1
    if (text.includes(name)) hit += 1
    else missing.push({ type: 'name', value: name })
  }

  const numbers = source.numbers ?? []
  if (numbers.length > 0) {
    total += 1
    const kept = numbers.filter((token) => text.includes(token)).length
    if (kept / numbers.length >= NUMBER_KEEP_RATIO) hit += 1
    else missing.push({ type: 'numbers', value: `保留 ${kept}/${numbers.length}` })
  }

  const before = Number(source.dialogueCount) || 0
  if (before > 0) {
    const after = countQuotes(text)
    const drift = Math.abs(after - before) / before
    if (drift > 0.2) notes.push({ type: 'dialogue', value: `对白 ${before} → ${after}（超出 ±20%，仅提示）` })
  }

  const hook = String(source.hook ?? '').trim()
  if (hook.length > 0) {
    const grams = cjkBigrams(hook)
    const tail = cjkBigrams(text.slice(-120))
    let overlap = 0
    for (const gram of grams) if (tail.has(gram)) overlap += 1
    const ratio = grams.size > 0 ? overlap / grams.size : 1
    if (ratio < 0.3) notes.push({ type: 'hook', value: `章末钩子承接 ${(ratio * 100).toFixed(0)}%（仅提示）` })
  }

  return { pass: total > 0 ? hit / total >= 1 : true, hit, total, missing, notes }
}

function failure(step, code, message, extra = {}) {
  return { step, code, message, ...extra }
}

/**
 * 章级闸门（纯函数 + normalize/audit，不写盘）。
 * @param {{text:string, previousText?:string, meta?:object}} input
 * @returns {Promise<{text:string, gates:object, failures:Array}>}
 */
export async function gateChapterText({ text, previousText, meta } = {}) {
  const raw = String(text ?? '')
  const gates = {
    prose: { normalized: false, removed: {}, needsFix: [] },
    fidelity: 'pass',
    residue: 'pass',
    aistyle: { score: null, pass: null, signals: [] },
  }
  const failures = []

  // 0) 规范化：Markdown → 纯文本
  const normalized = normalizeProse(raw, meta?.proseOptions ?? {})
  const normalizedText = String(normalized?.text ?? raw)
  gates.prose = {
    normalized: Boolean(normalized?.changed),
    removed: normalized?.removed ?? {},
    needsFix: Array.isArray(normalized?.needsFix) ? normalized.needsFix : [],
  }
  if (gates.prose.needsFix.length > 0) {
    failures.push(failure('prose', 'prose-needs-fix', `存在无法安全自动处理的结构：${gates.prose.needsFix.join('；')}`, { needsFix: gates.prose.needsFix }))
    return { text: normalizedText, gates, failures }
  }

  // 1) 保真：上一版正文的数字/专名必须还在
  if (previousText !== null && previousText !== undefined && String(previousText).trim() !== '') {
    const cast = Array.isArray(meta?.characters) ? meta.characters : []
    const anchors = extractAnchors(String(previousText), { characterNames: cast })
    const fidelity = evaluateFidelity(String(previousText), normalizedText, anchors)
    gates.fidelity = fidelity.pass ? 'pass' : 'fail'
    gates.fidelityDetail = fidelity
    if (!fidelity.pass) {
      const detail = fidelity.missing.map((item) => (item.type === 'name' ? `专名「${item.value}」` : `数字${item.value}`)).join('、')
      failures.push(failure('fidelity', 'fidelity-lost', `保真失败，缺失锚点：${detail}`, { missing: fidelity.missing }))
      return { text: normalizedText, gates, failures }
    }
  }

  // 2) 残留：规范化后仍有 Markdown 片段
  const residue = scanResidue(normalizedText)
  const residueList = Array.isArray(residue) ? residue : []
  gates.residue = residueList.length === 0 ? 'pass' : 'fail'
  gates.residueDetail = residueList.slice(0, 20)
  if (residueList.length > 0) {
    failures.push(failure('residue', 'residue-left', `正文仍有 Markdown 残留：${residueList.slice(0, 10).join('、')}`, { residue: residueList }))
    return { text: normalizedText, gates, failures }
  }

  // 3) 去 AI 味
  const style = auditAiStyle(normalizedText)
  gates.aistyle = { score: style.score, pass: style.pass, signals: style.signals }
  if (style.score > AISTYLE_MAX) {
    const top = style.signals.slice(0, 3).map((signal) => `${signal.label}(${signal.count})`).join('、')
    failures.push(failure('aistyle', 'aistyle-too-ai', `去 AI 味 ${style.score} 分，超过阈值 ${AISTYLE_MAX}${top ? `；主要信号：${top}` : ''}`, { score: style.score, signals: style.signals }))
    return { text: normalizedText, gates, failures }
  }

  return { text: normalizedText, gates, failures }
}

/**
 * 段落补丁闸门（只用于 patch-paragraph 提案）。
 *
 * 与整章闸门的区别：AI 味与 Markdown 规范化只针对**补丁新增的段落**，不针对整章。
 * 理由：旧章正文可能本来就是 AI 写的（或还没迁移成纯文本），整章重测会让任何补丁都永远批不过；
 * 补丁的作者只对「这次改出来的句子」负责。保真仍按整章校验（补丁不能删掉既有锚点）。
 * @param {{previousText:string, nextText:string, deltaText:string, meta?:object}} input
 * @returns {Promise<{gates:object, failures:Array}>}
 */
export async function gatePatchText({ previousText, nextText, deltaText, meta } = {}) {
  const gates = {
    scope: 'patch',
    prose: { normalized: false, removed: {}, needsFix: [] },
    fidelity: 'pass',
    residue: 'pass',
    aistyle: { score: null, pass: null, signals: [] },
  }
  const failures = []

  // 0) 只规范化补丁新增文本
  const delta = normalizeProse(String(deltaText ?? ''))
  const deltaTextOk = String(delta?.text ?? '')
  gates.prose = {
    normalized: Boolean(delta?.changed),
    removed: delta?.removed ?? {},
    needsFix: Array.isArray(delta?.needsFix) ? delta.needsFix : [],
  }
  if (gates.prose.needsFix.length > 0) {
    failures.push(failure('prose', 'prose-needs-fix', `补丁文本存在无法安全自动处理的结构：${gates.prose.needsFix.join('；')}`, { needsFix: gates.prose.needsFix }))
    return { gates, failures }
  }

  // 1) 保真：整章既有锚点不能被补丁删掉
  if (previousText !== null && previousText !== undefined && String(previousText).trim() !== '') {
    const cast = Array.isArray(meta?.characters) ? meta.characters : []
    const anchors = extractAnchors(String(previousText), { characterNames: cast })
    const fidelity = evaluateFidelity(String(previousText), String(nextText ?? ''), anchors)
    gates.fidelity = fidelity.pass ? 'pass' : 'fail'
    gates.fidelityDetail = fidelity
    if (!fidelity.pass) {
      const detail = fidelity.missing.map((item) => (item.type === 'name' ? `专名「${item.value}」` : `数字${item.value}`)).join('、')
      failures.push(failure('fidelity', 'fidelity-lost', `保真失败，缺失锚点：${detail}`, { missing: fidelity.missing }))
      return { gates, failures }
    }
  }

  // 2) 残留：补丁文本里还有 Markdown
  const residue = scanResidue(deltaTextOk)
  const residueList = Array.isArray(residue) ? residue : []
  gates.residue = residueList.length === 0 ? 'pass' : 'fail'
  gates.residueDetail = residueList.slice(0, 20)
  if (residueList.length > 0) {
    failures.push(failure('residue', 'residue-left', `补丁仍有 Markdown 残留：${residueList.slice(0, 10).join('、')}`, { residue: residueList }))
    return { gates, failures }
  }

  // 3) 去 AI 味：只测补丁新增段落
  const style = auditAiStyle(deltaTextOk)
  gates.aistyle = { score: style.score, pass: style.pass, signals: style.signals }
  if (style.score > AISTYLE_MAX) {
    const top = style.signals.slice(0, 3).map((signal) => `${signal.label}(${signal.count})`).join('、')
    failures.push(failure('aistyle', 'aistyle-too-ai', `补丁去 AI 味 ${style.score} 分，超过阈值 ${AISTYLE_MAX}${top ? `；主要信号：${top}` : ''}`, { score: style.score, signals: style.signals }))
    return { gates, failures }
  }

  return { gates, failures }
}

/**
 * 过闸门后写章（唯一写正文入口）：失败时返回 failures，绝不落盘。
 * @param {object} storeApi lib/store.js 模块（可注入测试替身）；需 readChapter / saveChapter
 * @param {{root:string, projectId:string, chapter:number, text:string, source?:string, meta?:object}} input
 * @returns {Promise<{ok:true, chapter:object, gates:object} | {ok:false, failures:Array, gates:object, proposalStatus:'needs-fix'}>}
 */
export async function writeChapterWithGates(storeApi, { root, projectId, chapter, text, source = 'run', meta, patch } = {}) {
  if (!storeApi || typeof storeApi.readChapter !== 'function' || typeof storeApi.saveChapter !== 'function') {
    throw new Error('writeChapterWithGates 需要注入 store（readChapter/saveChapter）')
  }
  const chapterNumber = Number(chapter)
  if (!Number.isFinite(chapterNumber) || chapterNumber <= 0) throw new Error('缺少有效章号')
  if (!String(projectId ?? '').trim()) throw new Error('缺少 projectId')

  let previousText = ''
  let currentMeta = {}
  try {
    const current = await storeApi.readChapter(root, projectId, chapterNumber)
    previousText = String(current?.text ?? '')
    currentMeta = current?.meta && typeof current.meta === 'object' ? current.meta : {}
  } catch {
    // 新章：没有上一版，跳过保真
    previousText = ''
    currentMeta = {}
  }

  const gateMeta = {
    ...currentMeta,
    ...(meta && typeof meta === 'object' ? meta : {}),
    characters: Array.isArray(meta?.characters) ? meta.characters : (currentMeta.characters ?? []),
  }
  if (patch && typeof patch === 'object') {
    const patchGate = await gatePatchText({
      previousText,
      nextText: text,
      deltaText: String(patch.deltaText ?? ''),
      meta: gateMeta,
    })
    if (patchGate.failures.length > 0) {
      return { ok: false, failures: patchGate.failures, gates: patchGate.gates, proposalStatus: 'needs-fix' }
    }
    const savedPatch = await storeApi.saveChapter(root, projectId, chapterNumber, String(text), { ...gateMeta, gate: patchGate.gates }, { source })
    await noteLedgerSync(storeApi, root, projectId, chapterNumber, previousText, String(text))
    return { ok: true, chapter: savedPatch ?? { chapter: chapterNumber }, gates: patchGate.gates }
  }

  const result = await gateChapterText({ text, previousText, meta: gateMeta })
  if (result.failures.length > 0) {
    return { ok: false, failures: result.failures, gates: result.gates, proposalStatus: 'needs-fix' }
  }

  // 修复：之前只写回 currentMeta，调用方传入的 meta（title/status/summary 等）被整段丢弃，
  // 导致 AI 写的新章标题永远落不了库（目录只能显示「第 N 章」）。
  const nextMeta = { ...gateMeta, gate: result.gates }
  const saved = await storeApi.saveChapter(root, projectId, chapterNumber, result.text, nextMeta, { source })
  await noteLedgerSync(storeApi, root, projectId, chapterNumber, previousText, result.text)
  return { ok: true, chapter: saved ?? { chapter: chapterNumber }, gates: result.gates }
}

/**
 * AI 写/改正文同样要落「账本待同步」信号：以前只有作者手改（chapter.save）走 noteChapterChange，
 * run 写完整本书账本却还是旧的。这里统一补上（写正文的唯一入口 = 这里），失败不影响写入。
 */
async function noteLedgerSync(storeApi, root, projectId, chapter, beforeText, afterText) {
  if (!storeApi || typeof storeApi.noteChapterChange !== 'function') return null
  try {
    return await storeApi.noteChapterChange(root, projectId, chapter, beforeText, afterText)
  } catch {
    return null
  }
}

/** 供工具输出用的一行闸门摘要。 */
export function formatGateLine(gates) {
  if (!gates) return '闸门：未执行'
  const prose = gates.prose?.normalized ? `规范化${Object.values(gates.prose.removed ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0)}处` : '规范化无改动'
  const style = gates.aistyle?.score === null || gates.aistyle?.score === undefined ? '去AI味未测' : `去AI味${gates.aistyle.score}分(${gates.aistyle.pass ? 'pass' : 'fail'})`
  return `闸门：${prose} ｜ 保真${gates.fidelity ?? '—'} ｜ 残留${gates.residue ?? '—'} ｜ ${style}`
}

/** 失败清单转人话（工具返回 / 提案 needs-fix 用）。 */
export function formatFailures(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return ''
  return failures.map((item, index) => `${index + 1}. [${item.step}] ${item.message}`).join('\n')
}
