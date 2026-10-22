/**
 * 电子书导入：TXT / EPUB 原生解析，PDF 借 pdftotext，MOBI/AZW3 借 Calibre。
 *
 * 输出统一的章节数组；完整作品也能拆成可编辑章节。
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import { unzip } from './unzip.js'
import { htmlToText } from './htmltext.js'
import { parseMobi } from './mobi.js'

const execFileAsync = promisify(execFile)

export const EBOOK_EXTENSIONS = ['.txt', '.epub', '.pdf', '.mobi', '.azw', '.azw3']

export function isEbookFile(file) {
  return EBOOK_EXTENSIONS.includes(extname(String(file ?? '')).toLowerCase())
}

function decodeText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8.replace(/^\uFEFF/, '')
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8
  }
}

const HEADING = /^(第\s*[0-9〇零一二三四五六七八九十百千两]+\s*[章回节卷](?:[ \t：:、.．])?.{0,50}|楔子|序章|序言|引子|尾声|后记|番外(?:篇)?(?:\s|$).{0,30}|chapter\s+([0-9]+|[ivxlcdm]+)(?:[.:\s].{0,50})?)$/iu

/** PDF 常把中文拆成带空格的字符；只去掉汉字之间的空格，保留章节标题可读性。 */
function collapseCjkSpaces(text) {
  let out = String(text ?? '')
  let previous = ''
  while (out !== previous) {
    previous = out
    out = out.replace(/([\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])/g, '$1')
  }
  return out
}

function headingLines(lines) {
  const rows = []
  lines.forEach((line, index) => {
    const text = line.trim()
    if (!text || text.length > 60) return
    if (!HEADING.test(text)) return
    rows.push({ index, title: text })
  })
  return rows
}

/** 把整本纯文本切成章节；没有标题时按约 6000 字一段。 */
export function splitTextBook(text, fallbackTitle = '正文', { chunk = true } = {}) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!source) return []
  const lines = source.split('\n')
  const headings = headingLines(lines)
  const chapters = []

  if (headings.length >= 2) {
    const preface = lines.slice(0, headings[0].index).join('\n').trim()
    headings.forEach((heading, index) => {
      const start = heading.index + 1
      const end = index + 1 < headings.length ? headings[index + 1].index : lines.length
      let content = lines.slice(start, end).join('\n').trim()
      if (index === 0 && preface) content = `${preface}\n\n${content}`.trim()
      if (content) chapters.push({ title: heading.title, content })
    })
    return chapters
  }

  if (!chunk) return [{ title: fallbackTitle, content: source }]

  const paragraphs = source.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
  if (paragraphs.length === 0) return [{ title: fallbackTitle, content: source }]
  let current = ''
  let index = 1
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > 6000) {
      chapters.push({ title: `第 ${index} 章`, content: current })
      index += 1
      current = ''
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph
  }
  if (current) chapters.push({ title: index === 1 ? fallbackTitle : `第 ${index} 章`, content: current })
  return chapters
}

function resolveInside(base, href) {
  const clean = String(href ?? '').split('#')[0].replace(/\\/g, '/')
  return normalize(join(base || '.', clean)).replace(/\\/g, '/')
}

function readEpub(buffer, fallbackTitle) {
  const entries = unzip(buffer)
  const readText = (name) => {
    const data = entries.get(name)
    return data ? decodeText(data) : ''
  }
  const container = readText('META-INF/container.xml')
  const rootfile = /<rootfile[^>]*full-path=["']([^"']+)["']/i.exec(container)?.[1]
  if (!rootfile) throw new Error('EPUB 缺少 OPF 目录（META-INF/container.xml）')
  const opf = readText(rootfile)
  const opfDir = dirname(rootfile)
  const title = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1]?.trim() || fallbackTitle

  const manifest = new Map()
  for (const match of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = match[0]
    const id = /\bid=["']([^"']+)["']/i.exec(tag)?.[1]
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1]
    const media = /\bmedia-type=["']([^"']+)["']/i.exec(tag)?.[1] ?? ''
    if (id && href) manifest.set(id, { href, media })
  }

  const spine = [...opf.matchAll(/<itemref\b[^>]*idref=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1])
  const ids = spine.length > 0 ? spine : [...manifest.keys()]
  const docs = ids.map((id) => manifest.get(id)).filter((item) => item && /html|xml/i.test(item.media))
  const chapters = []
  for (const item of docs) {
    const name = resolveInside(opfDir, item.href)
    const html = readText(name)
    if (!html) continue
    const text = htmlToText(html)
    if (!text) continue
    const docTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim()
      || /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, '').trim()
      || basename(name).replace(/\.[^.]+$/, '')
    const pieces = splitTextBook(text, docTitle, { chunk: false })
    chapters.push(...pieces)
  }
  return { title, chapters }
}

async function readPdf(file, fallbackTitle) {
  let stdout
  try {
    const result = await execFileAsync('pdftotext', ['-layout', file, '-'], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 })
    stdout = result.stdout
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('导入 PDF 需要系统装有 pdftotext（macOS: brew install poppler；Ubuntu: apt install poppler-utils）')
    throw new Error(`PDF 解析失败：${error.message}`)
  }
  return { title: fallbackTitle, chapters: splitTextBook(collapseCjkSpaces(stdout), fallbackTitle) }
}

async function readMobi(file, fallbackTitle) {
  try {
    const book = parseMobi(await readFile(file), fallbackTitle)
    return { title: book.title, chapters: splitTextBook(book.text, book.title || fallbackTitle) }
  } catch (error) {
    if (error?.code !== 'HUFF') throw error
    // HUFF/CDIC 压缩才需要 Calibre
    const dir = await mkdtemp(join(tmpdir(), 'storydesk-mobi-'))
    const target = join(dir, 'book.txt')
    try {
      await execFileAsync('ebook-convert', [file, target], { maxBuffer: 64 * 1024 * 1024, timeout: 180000 })
      const text = decodeText(await readFile(target))
      return { title: fallbackTitle, chapters: splitTextBook(text, fallbackTitle) }
    } catch (fallbackError) {
      if (fallbackError?.code === 'ENOENT') throw new Error('这个 MOBI 使用 HUFF/CDIC 压缩，需要系统装有 Calibre 的 ebook-convert；也可以先转成 EPUB/TXT')
      throw new Error(`MOBI 解析失败：${fallbackError.message}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

/** 读取一本书（TXT/EPUB/PDF/MOBI）为 { title, chapters }。 */
export async function readEbook(file, fallbackTitle = basename(file).replace(/\.[^.]+$/, '')) {
  const ext = extname(file).toLowerCase()
  if (ext === '.txt') {
    const text = decodeText(await readFile(file))
    return { title: fallbackTitle, chapters: splitTextBook(text, fallbackTitle) }
  }
  if (ext === '.epub') return readEpub(await readFile(file), fallbackTitle)
  if (ext === '.pdf') return readPdf(file, fallbackTitle)
  if (['.mobi', '.azw', '.azw3'].includes(ext)) return readMobi(file, fallbackTitle)
  throw new Error(`不支持的电子书格式：${ext || '未知'}`)
}
