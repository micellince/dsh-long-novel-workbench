#!/usr/bin/env node
/**
 * 0.7 新数据库导入：把已有作品的正文/账本/旧意见导入 novel.db（不改正文）。
 *
 * 流程（逐章，本地、零 AI、不动 .txt）：
 *   1) 生成 chapters/NNNN.index.json（段落地址）
 *   2) 写入 chapters / paras 表
 *   3) 从账本 JSON 首次建库（实体/别名/事实/事件/伏笔/冲突/高光）
 *   4) 重建本章 mentions（出现位置/计数）
 *   5) 把 reviews.json 里尚未进意见库的条目同步为 opinions
 *
 * 用法：
 *   node scripts/import-to-db.mjs --project pm03b6046ccc24 --dry-run
 *   node scripts/import-to-db.mjs --project pm03b6046ccc24 --apply
 */

import { existsSync } from 'node:fs'

import * as store from '../lib/store.js'
import * as bookdb from '../lib/bookdb.js'
import { buildIndex } from '../lib/paras.js'

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const apply = process.argv.includes('--apply')
const root = arg('root', process.env.STORY_DESK_ROOT || store.defaultRoot())
const onlyProject = arg('project', '')

async function main() {
  if (!existsSync(root)) throw new Error(`数据根不存在：${root}`)
  const projects = await store.listProjects(root)
  const list = (Array.isArray(projects) ? projects : projects.projects || []).filter((row) => !onlyProject || String(row.id) === onlyProject)
  if (!list.length) throw new Error(onlyProject ? `没有找到作品 ${onlyProject}` : '没有作品可导入')
  for (const project of list) {
    const projectId = String(project.id)
    const dir = await store.projectDir(root, projectId)
    const chapters = await store.listChapters(root, projectId)
    const txChapters = chapters.filter((row) => row.format !== 'md')
    console.log(`\n== ${project.name || project.title || projectId}（${chapters.length} 章，其中 txt ${txChapters.length}）`)
    if (!apply) {
      console.log(`- dry-run：将生成 index.json 并写入 novel.db；计划处理 ${txChapters.length} 章`)
      console.log(`- 数据库目标：${bookdb.dbFile(dir)}`)
      continue
    }
    const status = await bookdb.sqliteStatus()
    if (!status.ok) throw new Error(`当前环境不支持 SQLite：${status.reason}`)
    let done = 0
    for (const row of txChapters) {
      const chapter = Number(row.chapter)
      let doc
      try { doc = await store.readChapter(root, projectId, chapter) } catch { continue }
      const summary = await bookdb.onChapterSaved({ dir, chapter, text: doc.text, words: Number(doc.meta?.words) || 0 })
      if (summary.dbOk) done += 1
      if (done % 10 === 0) console.log(`  · 已导入 ${done}/${txChapters.length} 章`)
    }
    const reviews = await bookdb.ensureReviewSync(dir)
    const stats = await bookdb.storageStatus(dir)
    console.log(`- 完成：章节 ${done} ｜ 旧意见同步 ${reviews.synced ?? 0}`)
    console.log(`- 库状态：${JSON.stringify(stats.ledger)} ｜ 意见：${JSON.stringify(stats.opinions)}`)
  }
  if (!apply) console.log('\n确认无误后加 --apply 执行（只新增 index.json 与 novel.db，不改正文）。')
}

main().catch((error) => {
  console.error(error?.message || error)
  process.exitCode = 1
})
