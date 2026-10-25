/**
 * 纯文本正文的入站规范化（契约 §3 / 设计稿 §3.8）。
 *
 * 只有一个方向：AI 输出可能带 Markdown，落盘前必须洗成纯文本。
 * - normalizeProse：规范化并留痕（幂等；只处理 ASCII Markdown 标记）
 * - scanResidue：扫描残留的 Markdown 片段（空数组=干净）
 * - toMarkdown：仅导出使用（段落空行 + 场景分隔 ※ → ***）
 *
 * 绝不改动中文标点与专名：「」『』、……、——、全角＊、数字。
 */

/** 无法安全自动处理的结构（needsFix 文案）。 */
const NEED = {
  table: '表格（|…|）',
  fenceUnclosed: '未闭合的代码围栏 ```',
  fenceMultiParagraph: '代码块内出现多段正文',
  inlineUnclosed: '未闭合的行内 Markdown 标记',
}

/** 统计替换次数。 */
function countOf(re, text) {
  const m = text.match(re)
  return m ? m.length : 0
}

/** 把一次替换记入 removed（次数为 0 的键不写）。 */
function bump(removed, key, n) {
  if (n > 0) removed[key] = (removed[key] ?? 0) + n
}

/** 删除开头 YAML frontmatter（只在文首、且形如 --- 包裹时生效）。 */
function stripFrontmatter(text, removed) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return text
  bump(removed, 'frontmatter', 1)
  return text.slice(m[0].length)
}

/** 去掉代码围栏标记，保留围栏内文字（不处理围栏内的多段正文，只标记 needsFix）。 */
function stripFences(text, removed, needsFix) {
  const fenceCount = countOf(/^[ \t]*```[^\n]*$/gm, text)
  if (!fenceCount) return text
  // 围栏内出现空行 = 多段正文，不能安全合并
  const blockRe = /^[ \t]*```[^\n]*\r?\n([\s\S]*?)^[ \t]*```[^\n]*$/gm
  let block
  while ((block = blockRe.exec(text)) !== null) {
    if (/\n[ \t]*\r?\n/.test(block[1])) needsFix.add(NEED.fenceMultiParagraph)
  }
  if (fenceCount % 2 === 1) needsFix.add(NEED.fenceUnclosed)
  bump(removed, 'fence', fenceCount)
  return text.replace(/^[ \t]*```[^\n]*$/gm, '')
}

/** 行首块级标记：标题、引用、列表；分隔线单独处理。 */
function stripBlockMarks(text, removed) {
  let out = text
  const heading = countOf(/^[ \t]{0,3}#{1,6}[ \t]+/gm, out)
  if (heading) {
    out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    bump(removed, 'heading', heading)
  }
  // --- / *** / ___ 独占行 → 场景分隔 ※（先于列表处理）
  const hr = countOf(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, out)
  if (hr) {
    out = out.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '※')
    bump(removed, 'hr', hr)
  }
  const quote = countOf(/^[ \t]*>[ \t]?/gm, out)
  if (quote) {
    out = out.replace(/^[ \t]*>[ \t]?/gm, '')
    bump(removed, 'quote', quote)
  }
  const list = countOf(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/gm, out)
  if (list) {
    out = out.replace(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/gm, '')
    bump(removed, 'list', list)
  }
  return out
}

/** 行内标记：强调、删除线、行内代码、链接、图片、HTML。 */
function stripInlineMarks(text, removed) {
  let out = text
  // 图片先于链接（![alt](url) 是链接的超集）
  const image = countOf(/!\[[^\]\n]{0,200}\]\([^)\n]{0,300}\)/g, out)
  if (image) {
    out = out.replace(/!\[[^\]\n]{0,200}\]\([^)\n]{0,300}\)/g, '')
    bump(removed, 'image', image)
  }
  const link = countOf(/\[[^\]\n]{0,200}\]\([^)\n]{0,300}\)/g, out)
  if (link) {
    out = out.replace(/\[([^\]\n]{0,200})\]\([^)\n]{0,300}\)/g, '$1')
    bump(removed, 'link', link)
  }
  const html = countOf(/<\/?[a-zA-Z][^>\n]{0,80}>/g, out)
  if (html) {
    out = out.replace(/<\/?[a-zA-Z][^>\n]{0,80}>/g, '')
    bump(removed, 'html', html)
  }
  const bold = countOf(/\*\*([^*\n]+)\*\*/g, out) + countOf(/__([^_\n]+)__/g, out)
  if (bold) {
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
    bump(removed, 'bold', bold)
  }
  const strike = countOf(/~~([^~\n]+)~~/g, out)
  if (strike) {
    out = out.replace(/~~([^~\n]+)~~/g, '$1')
    bump(removed, 'strike', strike)
  }
  const italic = countOf(/(?<![*\\])\*([^*\n]+)\*(?!\*)/g, out) + countOf(/(?<![_\w])_([^_\n]+)_(?![\w_])/g, out)
  if (italic) {
    out = out.replace(/(?<![*\\])\*([^*\n]+)\*(?!\*)/g, '$1').replace(/(?<![_\w])_([^_\n]+)_(?![\w_])/g, '$1')
    bump(removed, 'italic', italic)
  }
  const code = countOf(/`([^`\n]+)`/g, out)
  if (code) {
    out = out.replace(/`([^`\n]+)`/g, '$1')
    bump(removed, 'code', code)
  }
  return out
}

/** 空白收尾：去行尾空格、3+ 连续空行归一为一个空行、去首尾空行。 */
function tidyBlank(text) {
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

/**
 * 规范化正文（幂等）。
 * @param {string} text 原始正文
 * @param {{ keepFrontmatter?: boolean }} [opts] 预留：导入 md 时可选保留正文前内容（默认删）
 * @returns {{ text: string, removed: Record<string, number>, changed: boolean, needsFix: string[] }}
 */
export function normalizeProse(text, opts = {}) {
  const original = String(text ?? '').replace(/\r\n?/g, '\n')
  const removed = {}
  const needsFix = new Set()

  // 表格不自动处理，只登记；后续规则不碰表格行（用占位符保护）
  const tableLines = []
  const tableRe = /^[ \t]*\|.*\|[ \t]*$/gm
  const tableCount = countOf(tableRe, original)
  if (tableCount) needsFix.add(NEED.table)
  const source = tableCount
    ? original.replace(tableRe, (line) => {
        tableLines.push(line)
        return `\u0000TABLE${tableLines.length - 1}\u0000`
      })
    : original

  let out = opts.keepFrontmatter ? source : stripFrontmatter(source, removed)
  out = stripFences(out, removed, needsFix)
  out = stripBlockMarks(out, removed)
  out = stripInlineMarks(out, removed)
  out = tidyBlank(out)

  // 还原表格行，保证「不自动处理」
  if (tableLines.length) {
    out = out.replace(/\u0000TABLE(\d+)\u0000/g, (_, i) => tableLines[Number(i)])
  }

  // 未闭合的行内标记：只标记，不再动文本
  if (/\*\*|__|~~/.test(out) || countOf(/`/g, out) % 2 === 1) needsFix.add(NEED.inlineUnclosed)

  return {
    text: out,
    removed,
    changed: out !== original,
    needsFix: [...needsFix],
  }
}

/** 段落之间空行、场景分隔 ※ → ***（仅导出用，不加任何强调）。 */
export function toMarkdown(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^[ \t]*※[ \t]*$/gm, '***')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

/** 单条残留规则（片段会被原样返回）。 */
const RESIDUE_PATTERNS = [
  /^[ \t]{0,3}#{1,6}[ \t]+[^\n]*$/gm, // 标题
  /^[ \t]*\|.*\|[ \t]*$/gm, // 表格
  /^[ \t]*```[^\n]*$/gm, // 围栏
  /`[^`\n]+`/g, // 行内代码
  /\*\*[^*\n]{1,200}\*\*/g, // 粗体
  /__[^_\n]{1,200}__/g,
  /(?<![*\\])\*[^*\n]{1,200}\*(?!\*)/g, // 斜体
  /~~[^~\n]{1,200}~~/g, // 删除线
  /!?\[[^\]\n]{0,200}\]\([^)\n]{0,300}\)/g, // 链接/图片
  /<\/?[a-zA-Z][^>\n]{0,80}>/g, // HTML
  /^[ \t]*>[ \t]?/gm, // 引用
  /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/gm, // 列表
  /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, // 分隔线
]

/**
 * 扫描正文里的 Markdown 残留（空数组=干净）。
 * @returns {string[]} 片段（去重、按出现顺序、最多 50 条）
 */
export function scanResidue(text) {
  const source = String(text ?? '')
  const seen = new Set()
  const out = []
  for (const re of RESIDUE_PATTERNS) {
    const global = re.global ? re : new RegExp(re.source, re.flags + 'g')
    let m
    while ((m = global.exec(source)) !== null) {
      // 行首标记类只返回标记本身，截断到 60 字足够判定
      const snippet = String(m[0]).slice(0, 60)
      if (!snippet || seen.has(snippet)) continue
      seen.add(snippet)
      out.push(snippet)
      if (out.length >= 50) return out
    }
  }
  return out
}
