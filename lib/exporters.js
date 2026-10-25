/**
 * 书籍导出：EPUB 3 与 DOCX 3（Office Open XML），全部零依赖。
 *
 * 输入是 getBundle() 的返回值（project/chapters/...），输出 Buffer。
 */

import { createHash } from 'node:crypto'
import { createZip } from './zip.js'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function escapeXml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]))
}

/** 正文按空行/换行拆段，去掉纯空白段。 */
function splitParagraphs(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 行内 Markdown → 纯文本：粗体/斜体/行内码/链接/列表符号。 */
function stripInlineMarkdown(text) {
  return String(text ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*+]\s+/, '')
    .trim()
}

/**
 * 章节正文 → 排版块。导出是给读者看的，不能漏出写作期的 Markdown 标记
 * （##、**、>、--- 都曾被原样写进 EPUB/DOCX，被当成「AI 痕迹」）。
 * 返回 [{ type: 'h2'|'h3'|'quote'|'p', text }]。
 */
export function contentBlocks(text) {
  const blocks = []
  for (const raw of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^[-*_]\s*[-*_\s]{2,}$/.test(line) && !/[^\s\-*_]/.test(line)) continue // 分隔线
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

function bookTitle(bundle) {
  return String(bundle?.project?.name ?? '').trim() || '未命名作品'
}

/** 语言标签：中文项目落成 zh-CN，其余能当 BCP-47 用就用。 */
function languageTag(project = {}) {
  const raw = String(project.language ?? '').trim()
  if (raw && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(raw)) return raw
  if (/繁體|繁体|正體/.test(raw)) return 'zh-TW'
  return 'zh-CN'
}

function bookIdentifier(bundle) {
  const seed = String(bundle?.project?.id ?? '') || bookTitle(bundle)
  const digest = createHash('sha1').update(`novel-desk:${seed}`).digest('hex')
  return `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

function safeId(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || 'x'
}

function atLeastOne(list, fallback = '全') {
  return list.length > 0 ? list : [fallback]
}

// ── EPUB 3 ────────────────────────────────────────────────────

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

function chapterPage(chapter) {
  const blocks = contentBlocks(chapter.content)
  const body = [`<h1>${escapeXml(chapter.title ?? '')}</h1>`]
  if (blocks.length === 0) body.push('<p>（本章暂无正文）</p>')
  else {
    for (const block of blocks) {
      const text = escapeXml(block.text)
      if (block.type === 'h2') body.push(`<h2>${text}</h2>`)
      else if (block.type === 'h3') body.push(`<h3>${text}</h3>`)
      else if (block.type === 'quote') body.push(`<blockquote><p>${text}</p></blockquote>`)
      else body.push(`<p>${text}</p>`)
    }
  }
  return body.join('\n')
}

/**
 * 生成 EPUB 3。
 * @param {object} bundle getBundle 返回值
 * @returns {Buffer}
 */
export function buildEpub(bundle = {}) {
  const project = bundle.project ?? {}
  const chapters = Array.isArray(bundle.chapters) ? bundle.chapters : []
  const title = bookTitle(bundle)
  const lang = languageTag(project)
  const identifier = bookIdentifier(bundle)
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

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

  const chapterItems = chapters.map((chapter, index) => ({
    id: `chap-${safeId(chapter.id ?? index + 1)}`,
    href: `chap-${safeId(chapter.id ?? index + 1)}.xhtml`,
    title: String(chapter.title ?? '').trim() || `第 ${index + 1} 章`,
    content: chapter.content,
  }))
  for (const item of chapterItems) {
    entries.push({
      name: `OEBPS/${item.href}`,
      data: xhtmlPage(item.title, chapterPage({ title: item.title, content: item.content }), lang),
    })
  }

  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="style" href="style.css" media-type="text/css"/>',
    ...chapterItems.map((item) => `<item id="${item.id}" href="${item.href}" media-type="application/xhtml+xml"/>`),
  ]
  const spine = chapterItems.map((item) => `<itemref idref="${item.id}"/>`)
  const creator = String(project.author ?? '').trim()
  entries.push({
    name: 'OEBPS/content.opf',
    data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${lang}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${escapeXml(lang)}</dc:language>
    ${creator ? `<dc:creator>${escapeXml(creator)}</dc:creator>` : ''}
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

  const navItems = atLeastOne(
    chapterItems.map((item) => `<li><a href="${item.href}">${escapeXml(item.title)}</a></li>`),
    '<li><span>（暂无章节）</span></li>',
  )
  entries.push({
    name: 'OEBPS/nav.xhtml',
    data: xhtmlPage(
      '目录',
      `<nav epub:type="toc" id="toc">
<h1>目录</h1>
<ol>
${navItems.join('\n')}
</ol>
</nav>`,
      lang,
    ),
  })

  entries.push({
    name: 'OEBPS/style.css',
    data: `body { font-family: serif; line-height: 1.7; margin: 1em; }
h1 { font-size: 1.4em; margin: 1.2em 0 0.8em; }
h2 { font-size: 1.15em; margin: 1em 0 0.6em; }
h3 { font-size: 1.05em; margin: 0.8em 0 0.5em; }
p { text-indent: 2em; margin: 0.4em 0; }
blockquote { margin: 0.8em 1.5em; color: #555; }
blockquote p { text-indent: 0; }
`,
  })

  return createZip(entries)
}

// ── DOCX ──────────────────────────────────────────────────────

function docxParagraph(text, styleId) {
  const pPr = styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : ''
  if (!text) return `<w:p>${pPr}</w:p>`
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

/**
 * 生成 DOCX（WordprocessingML）。
 * @param {object} bundle getBundle 返回值
 * @returns {Buffer}
 */
export function buildDocx(bundle = {}) {
  const project = bundle.project ?? {}
  const chapters = Array.isArray(bundle.chapters) ? bundle.chapters : []
  const title = bookTitle(bundle)
  const paragraphs = [docxParagraph(title, 'Title')]
  if (String(project.logline ?? '').trim()) paragraphs.push(docxParagraph(String(project.logline).trim(), 'Subtitle'))
  paragraphs.push(docxParagraph(''))
  for (const chapter of chapters) {
    const chapterTitle = String(chapter.title ?? '').trim() || `第 ${Number(chapter.id) || chapter.id || '?'} 章`
    paragraphs.push(docxParagraph(chapterTitle, 'Heading1'))
    const blocks = contentBlocks(chapter.content)
    if (blocks.length === 0) paragraphs.push(docxParagraph('（本章暂无正文）'))
    else {
      for (const block of blocks) {
        if (block.type === 'h2') paragraphs.push(docxParagraph(block.text, 'Heading2'))
        else if (block.type === 'h3') paragraphs.push(docxParagraph(block.text, 'Heading3'))
        else if (block.type === 'quote') paragraphs.push(docxParagraph(block.text, 'Quote'))
        else paragraphs.push(docxParagraph(block.text))
      }
    }
    if (splitParagraphs(chapter.summary).length > 0) {
      paragraphs.push(docxParagraph(''))
      paragraphs.push(docxParagraph(`摘要：${chapter.summary}`, 'Quote'))
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

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
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
</w:styles>
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
    { name: 'word/styles.xml', data: styles },
    { name: 'word/_rels/document.xml.rels', data: documentRels },
  ])
}

export { DOCX_MIME }
