#!/usr/bin/env node
/**
 * 0.7 标题迁移：把 meta.json 里的回目标题写进正文 .txt 首行。
 *
 * 规则（作者定的）：
 *  - 正文 .txt 是可直接发人的成品，标题必须属于正文；
 *  - 默认 dry-run，只打印计划；写盘必须显式 --apply；
 *  - 逐章走唯一的 saveChapter（自动备份 + 重算 hash/字数 + 刷新索引/账本/意见地址）；
 *  - 只处理 .txt；旧 .md 先用 scripts/migrate.js 转成 .txt 再迁移。
 *
 * 用法：
 *   node scripts/migrate-titles.mjs --dry-run
 *   node scripts/migrate-titles.mjs --apply
 *   node scripts/migrate-titles.mjs --project pmxxx --apply
 */

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import * as store from '../lib/store.js'
import { splitTitle } from '../lib/paras.js'

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
  const list = (Array.isArray(projects) ? projects : projects.projects || [])
    .filter((row) => !onlyProject || String(row.id) === onlyProject)
  let planned = 0
  let done = 0
  let skipped = 0
  for (const project of list) {
    const projectId = String(project.id)
    const chapters = await store.listChapters(root, projectId)
    if (!chapters.length) continue
    console.log(`\n== 作品 ${project.name || project.title || projectId}（${chapters.length} 章）`)
    for (const row of chapters) {
      const chapter = Number(row.chapter)
      let doc
      try {
        doc = await store.readChapter(root, projectId, chapter)
      } catch {
        continue
      }
      const text = String(doc.text || '')
      if (doc.format !== 'txt') {
        skipped += 1
        console.log(`- 第${chapter}章：${doc.format} 格式，跳过（先跑 scripts/migrate.js）`)
        continue
      }
      const parsed = splitTitle(text)
      if (parsed.title) continue
      const title = String(doc.meta?.title || '').trim()
      if (!title) {
        skipped += 1
        console.log(`- 第${chapter}章：没有可用标题，跳过`)
        continue
      }
      planned += 1
      console.log(`- 第${chapter}章：首行插入「${title}」`)
      if (!apply) continue
      const nextText = `${title}\n\n${text.replace(/^\n+/, '')}`
      await store.saveChapter(root, projectId, chapter, nextText, {}, { baseHash: doc.meta?.contentHash, source: 'title-migration' })
      done += 1
    }
  }
  console.log(`\n${apply ? `已迁移 ${done} 章` : `计划迁移 ${planned} 章（dry-run，未写盘）`}；跳过 ${skipped} 章。`)
  if (!apply && planned > 0) console.log('确认无误后加 --apply 执行；写盘前每章会自动备份。')
}

main().catch((error) => {
  console.error(error?.message || error)
  process.exitCode = 1
})
