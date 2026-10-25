#!/usr/bin/env node
/**
 * 修复「审阅 → 提案」历史 bug 造成的稿件污染。
 *
 * 0.6.3 及更早版本里，「生成提案」把审阅的 suggestion（写作建议）直接当成 after 写进
 * 章节，采纳后建议句被插进正文。本脚本把已采纳的 patch-paragraph 提案逐条反向应用：
 * 在正文中找到补丁的 after 文本（必须唯一定位），替换回 before 原文。
 *
 * 用法：
 *   node scripts/repair-polluted-chapters.mjs --project pm03b6046ccc24            # 预演（只读）
 *   node scripts/repair-polluted-chapters.mjs --project pm03b6046ccc24 --apply    # 落盘（会先备份当前正文）
 *
 * 选项：
 *   --root <dir>        StoryDesk 根目录，默认 ~/StoryDesk
 *   --project <id>      作品 id，必填
 *   --chapters 1-5      只处理这些章（默认全部有已采纳补丁的章）
 *   --apply             真正写回（默认只预演）
 *
 * 安全：每一章先校验每条 after 在正文中恰好出现一次；任何一条 0 次或多次都跳过该章并报原因，
 * 不做部分修改。落盘走 store.saveChapter（会先备份当前正文，可再回滚）。
 */
import os from 'node:os'
import path from 'node:path'
import * as store from '../lib/store.js'

function parseArgs(argv) {
  const out = { root: path.join(os.homedir(), 'StoryDesk'), project: '', chapters: null, apply: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') out.root = path.resolve(argv[++i])
    else if (arg === '--project') out.project = String(argv[++i] || '')
    else if (arg === '--chapters') out.chapters = parseChapters(argv[++i])
    else if (arg === '--apply') out.apply = true
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/repair-polluted-chapters.mjs --project <id> [--chapters 1-5] [--root ~/StoryDesk] [--apply]')
      process.exit(0)
    } else {
      console.error(`未知参数：${arg}`)
      process.exit(2)
    }
  }
  if (!out.project) {
    console.error('缺少 --project <作品 id>')
    process.exit(2)
  }
  return out
}

function parseChapters(value) {
  if (!value) return null
  const set = new Set()
  for (const part of String(value).split(',')) {
    const chunk = part.trim()
    if (!chunk) continue
    const [a, b] = chunk.split('-')
    const start = Number(a)
    const end = b ? Number(b) : start
    if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) {
      console.error(`章号范围无法解析：${chunk}`)
      process.exit(2)
    }
    for (let n = start; n <= end; n += 1) set.add(n)
  }
  return set
}

function countOccurrences(text, needle) {
  if (!needle) return 0
  let count = 0
  let at = 0
  while (true) {
    const hit = text.indexOf(needle, at)
    if (hit < 0) return count
    count += 1
    at = hit + needle.length
  }
}

function normalizeForMatch(text) {
  return String(text || '').replace(/[\s“”‘’「」『』"']+/g, '')
}

/** 在正文里定位 after：先逐字找，再在「去空白与引号」后的映射上找，返回 {start,end,exact} 或 null */
function locate(text, needle) {
  const exact = countOccurrences(text, needle)
  if (exact > 1) return { error: `出现 ${exact} 次（逐字）` }
  if (exact === 1) {
    const start = text.indexOf(needle)
    return { start, end: start + needle.length, exact: true }
  }
  // 归一化映射：把可忽略字符删掉后重建原串下标
  const keep = []
  const map = []
  for (let i = 0; i < text.length; i += 1) {
    if (!/[\s“”‘’「」『』"']/.test(text[i])) {
      keep.push(text[i])
      map.push(i)
    }
  }
  const hay = keep.join('')
  const want = normalizeForMatch(needle)
  if (!want) return { error: '补丁 after 为空' }
  const first = hay.indexOf(want)
  if (first < 0) return { error: '正文里找不到这段文字' }
  if (hay.indexOf(want, first + want.length) >= 0) return { error: '归一化后出现多次' }
  const start = map[first]
  const end = map[first + want.length - 1] + 1
  return { start, end, exact: false }
}

function patchesOf(proposal) {
  const data = proposal && proposal.data ? proposal.data : {}
  const list = Array.isArray(data.patches) ? data.patches : []
  return list
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = args.root
  const project = await store.getProject(root, args.project)
  if (!project) {
    console.error(`找不到作品：${args.project}（root=${root}）`)
    process.exit(1)
  }
  const proposals = (await store.listProposals(root, args.project, {})) || []
  const accepted = (Array.isArray(proposals) ? proposals : proposals.items || []).filter(
    (row) => row && row.kind === 'patch-paragraph' && String(row.status) === 'accepted',
  )
  const byChapter = new Map()
  for (const proposal of accepted) {
    for (const patch of patchesOf(proposal)) {
      const chapter = Number(patch.chapter || proposal.chapter)
      if (!Number.isInteger(chapter) || chapter <= 0) continue
      if (args.chapters && !args.chapters.has(chapter)) continue
      if (!patch.before || !patch.after) continue
      if (!byChapter.has(chapter)) byChapter.set(chapter, [])
      byChapter.get(chapter).push({ proposalId: proposal.id, before: String(patch.before), after: String(patch.after) })
    }
  }
  if (byChapter.size === 0) {
    console.log('没有可反向应用的已采纳段落补丁（可能已经修过，或没有审阅类提案）。')
    return
  }
  console.log(`作品《${project.title || project.name || args.project}》 ${args.apply ? '落盘' : '预演'}：${byChapter.size} 章`)
  let changedChapters = 0
  for (const chapter of [...byChapter.keys()].sort((a, b) => a - b)) {
    let current
    try {
      current = await store.readChapter(root, args.project, chapter)
    } catch (err) {
      console.log(`第 ${chapter} 章：读正文失败，跳过（${err.message}）`)
      continue
    }
    let text = String((current && current.text) || '')
    let touched = 0
    const problems = []
    for (const patch of byChapter.get(chapter)) {
      const hit = locate(text, patch.after)
      if (hit.error) {
        problems.push(`提案 ${patch.proposalId}：${hit.error}`)
        continue
      }
      text = text.slice(0, hit.start) + patch.before + text.slice(hit.end)
      touched += 1
    }
    if (problems.length) {
      console.log(`第 ${chapter} 章：跳过（${touched} 条可反向，${problems.length} 条定位失败）`)
      for (const line of problems) console.log(`  - ${line}`)
      continue
    }
    console.log(`第 ${chapter} 章：反向应用 ${touched} 条，字数 ${String(current.text || '').length} → ${text.length}`)
    if (args.apply) {
      await store.saveChapter(root, args.project, chapter, text, {}, {})
      changedChapters += 1
    }
  }
  if (!args.apply) {
    console.log('\n预演完成，未写盘。确认无误后加 --apply 落盘（会先备份当前正文）。')
  } else {
    console.log(`\n已写回 ${changedChapters} 章（旧正文在 chapters/.backups/ 下，可回滚）。`)
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err))
  process.exit(1)
})
