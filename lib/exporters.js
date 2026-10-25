/**
 * 作品导出：TXT / Markdown / EPUB 3 / DOCX，全部零依赖（ZIP 走 lib/zip.js）。
 *
 * 输入是 store.exportBook() 给的 bundle：
 *   { project, chapters: [{ chapter, title, content, summary }], includeSummary }
 *
 * 两条硬约束（旧仓库踩过坑）：
 * 1. 正文是纯文本、`※` 是场景分隔；TXT 里保留 `※`，Markdown 里转成 `***`，
 *    EPUB / DOCX 里排成居中的分隔行。
 * 2. 导出成品是给读者 / 出版方看的，绝不能漏出写作期的 Markdown 标记
 *    （`##`、`**`、`> `、`- ` 之类曾被原样写进 EPUB，被判成「AI 流水线格式」），
 *    所以这里再做一次兜底剥离。
 */

import { createHash } from 'node:crypto'

import { toMarkdown } from './prose.js'
import { createZip } from './zip.js'

/** 支持的导出格式（顺序 = UI 顺序）。 */
export const EXPORT_FORMATS = ['txt', 'md', 'epub', 'docx']

/** 各格式的扩展名 / MIME / 说明（客户端直接用这份文案）。 */
export const EXPORT_META = {
  txt: {
    ext: 'txt',
    mime: 'text/plain; charset=utf-8',
    label: 'TXT 纯文本',
    desc: '按章分节，场景分隔保留 ※，任何编辑器都能开',
  },
  md: {
    ext: 'md',
    mime: 'text/markdown; charset=utf-8',
    label: 'Markdown',
    desc: '一级标题作品名、二级标题章名，场景分隔转为 ***',
  },
  epub: {
    ext: 'epub',
    mime: 'application/epub+zip',
    label: 'EPUB 电子书',
    desc: '带目录的 EPUB 3，手机 / 阅读器 / 微信读书可直接打开',
  },
  docx: {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'DOCX 文档',
    desc: 'Word 打开，标题与提要按样式排版，方便交稿',
  },
}

const FORMAT_ALIAS = { markdown: 'md', epub3: 'epub', word: 'docx', doc: 'docx', text: 'txt' }

/**
 * 归一化格式名。
 * @returns {'txt'|'md'|'epub'|'docx'}
 */
export function normalizeFormat(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return 'txt'
  const fmt = FORMAT_ALIAS[raw] || raw
  if (!EXPORT_FORMATS.includes(fmt)) {
    const error = new Error(`不支持的导出格式：${value || '(空)'}（可选 ${EXPORT_FORMATS.join(' / ')}）`)
    error.code = 'invalid'
    throw error
  }
  return fmt
}

/** 作品名 → 安全文件名（去掉路径分隔符与 Windows 非法字符）。 */
export function bookFilename(name, ext) {
  const safe = String(name ?? '')
    .trim()
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80)
  return `${safe || '未命名作品'}.${ext}`
}

function bookTitle(bundle = {}) {
  const project = bundle.project ?? {}
  return String(project.title ?? project.name ?? '').trim() || '未命名作品'
}

/** 章名：已有「第 N 章 / 第 N 回」就原样用，否则补一个章号，避免目录里全是光秃秃的标题。 */
export function chapterTitle(item, index = 0) {
  const raw = String(item?.title ?? '').trim()
  const n = Number(item?.chapter ?? item?.id) || index + 1
  if (!raw) return `第 ${n} 章`
  if (/^第\s*[0-9零一二三四五六七八九十百千两〇]+\s*[章回节卷部篇]/.test(raw)) return raw
  return `第 ${n} 章　${raw}`
}

function chapterSummary(item) {
  return String(item?.summary ?? '').trim()
}

function normalizeBundle(bundle = {}) {
  const chapters = Array.isArray(bundle.chapters) ? bundle.chapters.filter((row) => row && typeof row === 'object') : []
  return { project: bundle.project ?? {}, chapters, includeSummary: bundle.includeSummary === true }
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]))
}

/** 行内 Markdown → 纯文本：粗体/斜体/行内码/链接/列表符号。 */
function stripInlineMarkdown(text) {
  return String(text ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/^\s{0,3}[-*+]\s+/, '')
    .replace(/^\s{0,3}\d{1,3}[.)]\s+/, '')
    .trim()
}

const SCENE_LINE = /^[ \t]*(?:※|\*{3,}|-{3,}|_{3,})[ \t]*$/

/**
 * 章节正文 → 排版块。导出是给读者看的，顺带清掉写作期残留的 Markdown。
 * @returns {Array<{type:'h2'|'h3'|'quote'|'scene'|'p', text:string}>}
 */
export function contentBlocks(text) {
  const blocks = []
  for (const rawLine of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (SCENE_LINE.test(line)) {
      blocks.push({ type: 'scene', text: '' })
      continue
    }
    const heading = /^(#{1,6})\s*(.+)$/.exec(line)
    if (heading) {
      blocks.push({ type: heading[1].length <= 2 ? 'h2' : 'h3', text: stripInlineMarkdown(heading[2]) })
      continue
    }
    const quote = /^>\s*(.+)$/.exec(line)
    if (quote) {
      blocks.push({ type: 'quote', text: stripInlineMarkdown(quote[1]) })
      continue
    }
    // 整行加粗（如「**【七律·少年下山】**」）按小标题排
    const boldOnly = /^\*\*([^*]+)\*\*$/.exec(line)
    if (boldOnly) {
      blocks.push({ type: 'h3', text: boldOnly[1].trim() })
      continue
    }
    blocks.push({ type: 'p', text: stripInlineMarkdown(line) })
  }
  return blocks
}

// ── TXT ───────────────────────────────────────────────────────

/**
 * 纯文本全文：作品名 + 逐章「章名 / 正文」，段落之间空一行。
 * @returns {string}
 */
export function buildBookText(bundle = {}) {
  const { chapters, includeSummary } = normalizeBundle(bundle)
  const out = [bookTitle(bundle), '']
  for (const [index, item] of chapters.entries()) {
    out.push(chapterTitle(item, index), '')
    if (includeSummary) {
      const summary = chapterSummary(item)
      if (summary) out.push(`【提要】${summary}`, '')
    }
    const blocks = contentBlocks(item.content)
    if (blocks.length === 0) out.push('（本章暂无正文）', '')
    for (const block of blocks) {
      if (block.type === 'scene') out.push('※', '')
      else if (block.type === 'quote') out.push(`　　${block.text}`, '')
      else out.push(block.text, '')
    }
  }
  return out.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '')
}

// ── Markdown ──────────────────────────────────────────────────

/**
 * Markdown 合集：`# 作品名`、`## 章名`，正文走 prose.toMarkdown（※ → ***）。
 * @returns {string}
 */
export function buildBookMarkdown(bundle = {}) {
  const { project, chapters, includeSummary } = normalizeBundle(bundle)
  const lines = [`# ${bookTitle(bundle)}`, '']
  const logline = String(project.logline ?? project.desc ?? '').trim()
  if (logline) lines.push(`> ${logline}`, '')
  for (const [index, item] of chapters.entries()) {
    lines.push(`## ${chapterTitle(item, index)}`, '')
    if (includeSummary) {
      const summary = chapterSummary(item)
      if (summary) lines.push(`> 提要：${summary}`, '')
    }
    const blocks = contentBlocks(item.content)
    if (blocks.length === 0) lines.push('（本章暂无正文）', '')
    for (const block of blocks) {
      if (block.type === 'scene') lines.push('***', '')
      else if (block.type === 'quote') lines.push(`> ${block.text}`, '')
      else if (block.type === 'h2') lines.push(`### ${block.text}`, '')
      else if (block.type === 'h3') lines.push(`#### ${block.text}`, '')
      else lines.push(block.text, '')
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '')
}

// ── EPUB 3 ────────────────────────────────────────────────────

/** 语言标签：中文作品默认 zh-CN，显式语言能当 BCP-47 用就用。 */
function languageTag(project = {}) {
  const raw = String(project.language ?? '').trim()
  if (raw && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(raw)) return raw
  if (/繁體|繁体|正體/.test(raw)) return 'zh-TW'
  return 'zh-CN'
}

/** 稳定的书籍标识：同一部作品每次导出 UUID 不变，阅读器不会当成两本书。 */
function bookIdentifier(bundle = {}) {
  const project = bundle.project ?? {}
  const seed = String(project.id ?? '').trim() || bookTitle(bundle)
  const digest = createHash('sha1').update(`novel-desk:${seed}`).digest('hex')
  return `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

function safeId(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || 'x'
}

function xhtmlPage(title, body, lang) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head>
<meta charset="utf-8"/>
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>
`
}

function chapterBody(item) {
  const blocks = contentBlocks(item.content)
  const body = []
  if (blocks.length === 0) body.push('<p class="nd-empty">（本章暂无正文）</p>')
  for (const block of blocks) {
    const text = escapeXml(block.text)
    if (block.type === 'scene') body.push('<p class="nd-scene">※</p>')
    else if (block.type === 'h2') body.push(`<h2>${text}</h2>`)
    else if (block.type === 'h3') body.push(`<h3>${text}</h3>`)
    else if (block.type === 'quote') body.push(`<blockquote><p>${text}</p></blockquote>`)
    else body.push(`<p>${text}</p>`)
  }
  return body
}

const EPUB_CSS = `body { font-family: serif; line-height: 1.7; margin: 1em; }
h1 { font-size: 1.4em; margin: 1.2em 0 0.8em; }
h2 { font-size: 1.15em; margin: 1em 0 0.6em; }
h3 { font-size: 1.05em; margin: 0.8em 0 0.5em; }
p { text-indent: 2em; margin: 0.4em 0; }
p.nd-scene { text-indent: 0; text-align: center; margin: 1.2em 0; letter-spacing: 0.4em; }
p.nd-empty { text-indent: 0; color: #666; }
blockquote { margin: 0.8em 1.5em; color: #555; }
blockquote p { text-indent: 0; }
`

/**
 * 生成 EPUB 3（mimetype 不压缩且排第一，符合规范）。
 * @returns {Buffer}
 */
export function buildEpub(bundle = {}) {
  const { project, chapters, includeSummary } = normalizeBundle(bundle)
  const title = bookTitle(bundle)
  const lang = languageTag(project)
  const identifier = bookIdentifier(bundle)
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  const items = (chapters.length ? chapters : [{ title: '（暂无正文）', content: '' }]).map((item, index) => ({
    id: `chap-${safeId(item.chapter ?? item.id ?? index + 1)}`,
    href: `chap-${safeId(item.chapter ?? item.id ?? index + 1)}.xhtml`,
    title: chapterTitle(item, index),
    content: item.content,
    summary: includeSummary ? chapterSummary(item) : '',
  }))
  // 章节级 id 可能重复（导入脏数据）：兜底补序号，避免 manifest / spine 撞车
  const seen = new Set()
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) {
      item.id = `chap-x${index + 1}`
      item.href = `chap-x${index + 1}.xhtml`
    }
    seen.add(item.id)
  }

  const entries = [{ name: 'mimetype', data: 'application/epub+zip', store: true }]
  entries.push({
    name: 'META-INF/container.xml',
    data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`,
  })

  for (const item of items) {
    const page = [`<h1>${escapeXml(item.title)}</h1>`]
    if (item.summary) page.push(`<p class="nd-summary">提要：${escapeXml(item.summary)}</p>`)
    page.push(...chapterBody(item))
    entries.push({ name: `OEBPS/${item.href}`, data: xhtmlPage(item.title, page.join('\n'), lang) })
  }

  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="style" href="style.css" media-type="text/css"/>',
    ...items.map((item) => `<item id="${item.id}" href="${item.href}" media-type="application/xhtml+xml"/>`),
  ]
  const spine = items.map((item) => `<itemref idref="${item.id}"/>`)
  const creator = String(project.author ?? '').trim()
  const publisher = String(project.publisher ?? '').trim()

  entries.push({
    name: 'OEBPS/content.opf',
    data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${lang}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${escapeXml(lang)}</dc:language>
    ${creator ? `<dc:creator>${escapeXml(creator)}</dc:creator>` : ''}
    ${publisher ? `<dc:publisher>${escapeXml(publisher)}</dc:publisher>` : ''}
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine>
    ${spine.join('\n    ')}
  </spine>
</package>
`,
  })

  const navItems = items.map((item) => `<li><a href="${item.href}">${escapeXml(item.title)}</a></li>`)
  entries.push({
    name: 'OEBPS/nav.xhtml',
    data: xhtmlPage('目录', `<nav epub:type="toc" id="toc">
<h1>${escapeXml(title)}</h1>
<ol>
${navItems.join('\n')}
</ol>
</nav>`, lang),
  })

  entries.push({ name: 'OEBPS/style.css', data: EPUB_CSS })

  return createZip(entries)
}

// ── DOCX ──────────────────────────────────────────────────────

function docxParagraph(text, styleId) {
  const pPr = styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : ''
  if (!text) return `<w:p>${pPr}</w:p>`
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
  <w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="SimSun"/><w:sz w:val="24"/></w:rPr></w:rPrDefault>
  <w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="90"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="420"/></w:pPr><w:rPr><w:i/><w:color w:val="666666"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Scene"><w:name w:val="Scene Break"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="120" w:after="120"/><w:jc w:val="center"/></w:pPr></w:style>
</w:styles>
`

/**
 * 生成 DOCX（WordprocessingML），零依赖。
 * @returns {Buffer}
 */
export function buildDocx(bundle = {}) {
  const { project, chapters, includeSummary } = normalizeBundle(bundle)
  const title = bookTitle(bundle)
  const paragraphs = [docxParagraph(title, 'Title')]
  const logline = String(project.logline ?? project.desc ?? '').trim()
  if (logline) paragraphs.push(docxParagraph(logline, 'Subtitle'))
  paragraphs.push(docxParagraph(''))

  for (const [index, item] of chapters.entries()) {
    paragraphs.push(docxParagraph(chapterTitle(item, index), 'Heading1'))
    if (includeSummary) {
      const summary = chapterSummary(item)
      if (summary) paragraphs.push(docxParagraph(`提要：${summary}`, 'Quote'))
    }
    const blocks = contentBlocks(item.content)
    if (blocks.length === 0) paragraphs.push(docxParagraph('（本章暂无正文）'))
    for (const block of blocks) {
      if (block.type === 'scene') paragraphs.push(docxParagraph('※', 'Scene'))
      else if (block.type === 'h2') paragraphs.push(docxParagraph(block.text, 'Heading2'))
      else if (block.type === 'h3') paragraphs.push(docxParagraph(block.text, 'Heading3'))
      else if (block.type === 'quote') paragraphs.push(docxParagraph(block.text, 'Quote'))
      else paragraphs.push(docxParagraph(block.text))
    }
    paragraphs.push(docxParagraph(''))
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${paragraphs.join('\n')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>
</w:body>
</w:document>
`

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>
`

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`

  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
`

  return createZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: DOCX_STYLES },
    { name: 'word/_rels/document.xml.rels', data: documentRels },
  ])
}
