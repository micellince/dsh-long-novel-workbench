/**
 * 导入现有 Markdown 作品：扫描目录/单文件、切章、写入作品库。
 *
 * 切章策略（split）：
 * - `auto`（默认）：一个文件一章；整本书的单文件里有多个一级标题时按 `#` 切章
 * - `file`：严格一个文件一章
 * - `h1`：按一级标题 `#` 切章（适合整本单文件）
 * 二级标题 `##` 永远留在正文里，不单独成章。
 *
 * 其他：
 * - 递归最大深度 5，跳过隐藏目录 / node_modules / .git
 * - 文件名里的「第X章/回/节/卷」（中文或阿拉伯数字）用于排序
 * - H1 作为章节标题，正文里去掉这一行；忽略 YAML frontmatter；空章节跳过
 * - append 模式从现有最大章号续号，不覆盖已有章节
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { countWords, createProject, getBundle, listProjects, saveChapter } from './store.js'

const MAX_DEPTH = 5
const SKIP_DIRS = new Set(['node_modules', '.git'])

/** 去掉文首 YAML frontmatter。 */
function stripFrontmatter(text) {
  const source = String(text ?? '').replace(/\r\n/g, '\n')
  const match = /^---\n[\s\S]*?\n---\n?/.exec(source)
  return match ? source.slice(match[0].length) : source
}

function fileTitle(file) {
  return basename(file).replace(/\.(md|markdown)$/i, '')
}

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 }

/** 中文/阿拉伯数字 → number（仅用于文件名排序，1–999 足够）。 */
function cnToNumber(input) {
  const s = String(input ?? '').trim()
  if (/^\d+$/.test(s)) return Number(s)
  let section = 0
  let number = 0
  let seen = false
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch]
      seen = true
    } else if (ch in CN_UNITS) {
      if (number === 0) number = 1
      section += number * CN_UNITS[ch]
      number = 0
      seen = true
    } else {
      return null
    }
  }
  return seen ? section + number : null
}

/** 从文件名提取章/回/节/卷号；没有则 null。 */
function chapterNumberFromName(file) {
  const base = fileTitle(file)
  const m = /第\s*([0-9〇零一二三四五六七八九十百千两]+)\s*[章回节卷]/.exec(base)
  if (!m) return null
  return cnToNumber(m[1])
}

/** 排序：先按文件名里的章号，再按自然顺序。 */
function compareFiles(a, b) {
  const na = chapterNumberFromName(a)
  const nb = chapterNumberFromName(b)
  if (na !== null && nb !== null && na !== nb) return na - nb
  if (na !== null && nb === null) return -1
  if (na === null && nb !== null) return 1
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
}

/**
 * 把一个 Markdown 文件切成章节片段。
 * @param {string} text
 * @param {string} fallbackTitle
 * @param {'auto'|'file'|'h1'} splitMode
 * @returns {Array<{title:string, content:string}>}
 */
function splitFile(text, fallbackTitle, splitMode = 'auto') {
  const source = stripFrontmatter(text).replace(/\r\n/g, '\n')
  const lines = source.split('\n')
  const h1 = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^#[ \t]+(.+?)[ \t#]*$/.exec(lines[i])
    if (m) h1.push({ index: i, title: m[1].trim() })
  }

  const oneFile = () => {
    if (h1.length === 0) return [{ title: fallbackTitle, content: source.trim() }]
    // 只有一个 H1：用它作标题，正文去掉这一行
    const first = h1[0]
    const before = lines.slice(0, first.index).join('\n')
    const after = lines.slice(first.index + 1).join('\n')
    return [{ title: first.title || fallbackTitle, content: `${before}\n${after}`.trim() }]
  }

  const splitByH1 = () => {
    if (h1.length === 0) return oneFile()
    const out = []
    const preface = lines.slice(0, h1[0].index).join('\n').trim()
    for (let k = 0; k < h1.length; k += 1) {
      const start = h1[k].index + 1
      const end = k + 1 < h1.length ? h1[k + 1].index : lines.length
      let content = lines.slice(start, end).join('\n').trim()
      if (k === 0 && preface) content = preface + '\n\n' + content
      out.push({ title: h1[k].title || `${fallbackTitle} ${k + 1}`, content })
    }
    return out
  }

  if (splitMode === 'file') return oneFile()
  if (splitMode === 'h1') return splitByH1()
  // auto：一个文件一章；单文件里有多个 H1 才按 H1 切
  return h1.length >= 2 ? splitByH1() : oneFile()
}

async function walkMarkdown(dir, depth, files) {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      await walkMarkdown(full, depth + 1, files)
    } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
      files.push(full)
    }
  }
}

/**
 * 读目录并解析成待导入章节（内部用，含正文）。
 */
async function readImportDir(dirPath, splitMode = 'auto') {
  const raw = String(dirPath ?? '').trim()
  if (!raw) throw new Error('缺少导入路径')
  const target = resolve(raw)
  let info
  try {
    info = await stat(target)
  } catch {
    throw new Error(`路径不存在：${target}`)
  }

  let filePaths = []
  let baseDir = target
  if (info.isDirectory()) {
    await walkMarkdown(target, 0, filePaths)
    filePaths.sort(compareFiles)
  } else if (info.isFile() && /\.(md|markdown)$/i.test(target)) {
    filePaths = [target]
    baseDir = resolve(target, '..')
  } else {
    throw new Error(`不是 Markdown 文件或目录：${target}`)
  }

  const files = []
  const chapters = []
  const skipped = []
  for (const file of filePaths) {
    const text = await readFile(file, 'utf8')
    const relPath = relative(baseDir, file) || basename(file)
    files.push({ file, relPath, words: countWords(stripFrontmatter(text)) })
    for (const piece of splitFile(text, fileTitle(file), splitMode)) {
      const words = countWords(piece.content)
      if (words === 0) {
        skipped.push({ title: piece.title, source: relPath, reason: '空章节' })
        continue
      }
      chapters.push({ title: piece.title, content: piece.content, words, source: relPath })
    }
  }
  return { path: target, files, chapters, skipped }
}

/**
 * 扫描目录，返回导入预览（不写任何数据）。
 * @returns {Promise<{path:string, files:Array, chapters:Array, totalWords:number}>}
 */
export async function scanImport(root, dirPath, options = {}) {
  void root // 预览只读用户给的路径，不需要数据根
  const splitMode = ['auto', 'file', 'h1'].includes(options.split) ? options.split : 'auto'
  const { path, files, chapters } = await readImportDir(dirPath, splitMode)
  return {
    path,
    split: splitMode,
    isFile: files.length === 1 && files[0].relPath === basename(path),
    files,
    chapters: chapters.map((chapter, index) => ({
      index: index + 1,
      title: chapter.title,
      words: chapter.words,
      source: chapter.source,
    })),
    totalWords: chapters.reduce((sum, chapter) => sum + chapter.words, 0),
  }
}

/**
 * 执行导入。
 * @param {string} root 数据根
 * @param {object} input { path, projectName?, genre?, mode?: 'new'|'append', projectId? }
 * @returns {Promise<{projectId:string, projectName:string, chapters:Array, skipped:Array}>}
 */
export async function runImport(root, input = {}) {
  const mode = String(input.mode ?? 'new').trim() === 'append' ? 'append' : 'new'
  const splitMode = ['auto', 'file', 'h1'].includes(input.split) ? input.split : 'auto'
  const parsed = await readImportDir(input.path, splitMode)
  if (parsed.chapters.length === 0) throw new Error('没有找到可导入的章节（目录里没有 Markdown 文件或章节为空）')

  let project
  let existing = []
  if (mode === 'append') {
    let projectId = String(input.projectId ?? '').trim()
    // 兼容只给作品名的情况：按 id 或名称找已有作品
    if (!projectId) {
      const key = String(input.projectName ?? '').trim()
      if (key) {
        const hit = (await listProjects(root)).find((p) => p.id === key || p.name === key)
        if (hit) projectId = hit.id
      }
    }
    if (!projectId) throw new Error('追加导入需要指定 projectId')
    const bundle = await getBundle(root, projectId)
    project = bundle.project
    existing = bundle.chapters
  } else {
    const fallbackName = basename(parsed.path) || '导入作品'
    project = await createProject(root, {
      name: String(input.projectName ?? '').trim() || fallbackName,
      genre: String(input.genre ?? '').trim(),
      description: `从 ${parsed.path} 导入的 Markdown 作品`,
    })
  }

  let next = existing.reduce((max, chapter) => Math.max(max, Number(chapter.id) || 0), 0) + 1
  const imported = []
  for (const chapter of parsed.chapters) {
    const id = String(next).padStart(4, '0')
    const saved = await saveChapter(root, project.id, {
      id,
      title: chapter.title,
      status: 'draft',
      summary: '',
      content: chapter.content,
    })
    imported.push({ id: saved.id, title: saved.title, words: saved.words })
    next += 1
  }

  return {
    projectId: project.id,
    projectName: project.name,
    chapters: imported,
    skipped: parsed.skipped,
  }
}
