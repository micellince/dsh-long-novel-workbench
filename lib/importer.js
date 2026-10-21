/**
 * 导入现有 Markdown 作品：扫描目录、按标题切章、写入作品库。
 *
 * - 递归最大深度 5，跳过隐藏目录 / node_modules / .git
 * - 优先按一级/二级标题（# / ##）切章；没有标题则一个文件一章，标题取文件名
 * - 忽略 YAML frontmatter，空章节跳过
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

/**
 * 把一个 Markdown 文件切成章节片段。
 * @returns {Array<{title:string, content:string}>}
 */
function splitChapters(text, fallbackTitle) {
  const source = stripFrontmatter(text)
  const sections = []
  const preamble = []
  let current = null
  for (const line of source.split('\n')) {
    const heading = /^(#{1,2})[ \t]+(.+?)[ \t#]*$/.exec(line)
    if (heading) {
      current = { title: heading[2].trim(), lines: [] }
      sections.push(current)
    } else if (current) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
  }
  if (sections.length === 0) {
    return [{ title: fallbackTitle, content: source.trim() }]
  }
  const out = []
  const preface = preamble.join('\n').trim()
  if (preface) out.push({ title: fallbackTitle, content: preface })
  for (const section of sections) {
    out.push({ title: section.title || fallbackTitle, content: section.lines.join('\n').trim() })
  }
  return out
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
async function readImportDir(dirPath) {
  const raw = String(dirPath ?? '').trim()
  if (!raw) throw new Error('缺少导入目录')
  const target = resolve(raw)
  let info
  try {
    info = await stat(target)
  } catch {
    throw new Error(`目录不存在：${target}`)
  }
  if (!info.isDirectory()) throw new Error(`不是目录：${target}`)

  const filePaths = []
  await walkMarkdown(target, 0, filePaths)

  const files = []
  const chapters = []
  const skipped = []
  for (const file of filePaths) {
    const text = await readFile(file, 'utf8')
    const relPath = relative(target, file) || basename(file)
    files.push({ file, relPath, words: countWords(stripFrontmatter(text)) })
    for (const piece of splitChapters(text, fileTitle(file))) {
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
export async function scanImport(root, dirPath) {
  void root // 预览只读用户给的目录，不需要数据根
  const { path, files, chapters } = await readImportDir(dirPath)
  return {
    path,
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
  const parsed = await readImportDir(input.path)
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
