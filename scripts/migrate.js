#!/usr/bin/env node
/**
 * 0.5.x → 0.6.0 迁移脚本。
 *
 * 行为：
 * - 默认 dry-run（只读、只打印计划，不写任何文件）
 * - `--apply` 才写盘；写前把整个项目目录备份到 <root>/.pre-0.6.0/<项目>-<时间>/
 * - 幂等：重复执行不会重复转换章节、不会重复加审阅
 * - 项目里有 running 的 pipeline/expansion/revision 时，拒绝 --apply（dry-run 只报告）
 *
 * 用法：
 *   node scripts/migrate.js                  # dry-run 全库
 *   node scripts/migrate.js --apply          # 执行
 *   node scripts/migrate.js --project pmxxx  # 只处理一个项目
 *   node scripts/migrate.js --root /path/to/StoryDesk
 */

import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { scanResidue } from '../lib/prose.js'
import { addReviews, defaultRoot, ensureRoot, readChapter, saveChapter, updateProject } from '../lib/store.js'

const RUNNING = new Set(['running'])
const LEGACY_FILES = ['pipeline.json', 'expansion.json', 'revision.json']
const ATTENTION_REQUIRED = ['chapter', 'hook', 'tension', 'payoff', 'cliff']
const PRE_BACKUP = '.pre-0.6.0'
const MIGRATION_REPORT = 'migration-report.json'

/** 正文全文 sha256（迁移前后逐字校验用；不用 store 的短 contentHash，那个只有 12 位）。 */
function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** 原子写 JSON。 */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 列出数据根下的项目目录（不存在时返回空，不创建）。 */
async function listProjectDirs(root) {
  try {
    const entries = await readdir(join(root, 'projects'), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

/** 解析 .md 章节（与 store 内部规则一致：frontmatter + 正文）。 */
function parseMd(raw) {
  const text = String(raw ?? '')
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { body: text.replace(/^\r?\n+/, '') }
  return { body: text.slice(match[0].length).replace(/^\r?\n+/, '') }
}

/** 收集某章的 Markdown 残留（每处残留转成一条审阅）。 */
function residueReviews(chapter, body) {
  const residue = scanResidue(body)
  if (!residue.length) return []
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const reviews = []
  const seen = new Set()
  for (const item of residue) {
    // 找第一条包含该残留写法的原文行作为逐字 quote
    const line = lines.find((candidate) => candidate.includes(item)) ?? lines.find((candidate) => candidate.length >= 4)
    if (!line || line.length < 4 || seen.has(line)) continue
    seen.add(line)
    reviews.push({
      chapter,
      source: 'ai-style',
      severity: 'minor',
      quote: line.slice(0, 120),
      issue: `正文残留 Markdown 写法：${item}`,
      suggestion: '按 0.6 纯文本规则清理（去掉标记/围栏/表格，场景分隔用 ※）。',
      origin: 'migration',
    })
    if (reviews.length >= 20) break
  }
  return reviews
}

/** 生成单项目的迁移计划（只读）。 */
async function planProject(root, id) {
  const dir = join(root, 'projects', id)
  const raw = await readJson(join(dir, 'project.json'), null)
  const plan = {
    id,
    dir,
    title: raw?.name ?? raw?.title ?? id,
    skip: false,
    reason: '',
    running: [],
    chapters: [],
    attention: null,
    legacy: [],
    project: raw,
    reviews: [],
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    plan.skip = true
    plan.reason = '缺少 project.json'
    return plan
  }
  for (const name of LEGACY_FILES) {
    const file = join(dir, name)
    if (!(await fileExists(file))) continue
    plan.legacy.push(name)
    const data = await readJson(file, null)
    const status = String(data?.status ?? data?.run?.status ?? '')
    if (RUNNING.has(status)) plan.running.push(`${name}(${status})`)
  }
  const chaptersDir = join(dir, 'chapters')
  let names = []
  try {
    names = await readdir(chaptersDir)
  } catch {
    names = []
  }
  for (const name of names) {
    const match = /^(\d{4})\.md$/.exec(name)
    if (!match) continue
    const chapter = Number(match[1])
    const txt = join(chaptersDir, `${match[1]}.txt`)
    if (await fileExists(txt)) continue // 已有 0.6 文本，不覆盖
    const body = parseMd(await readFile(join(chaptersDir, name), 'utf8')).body
    plan.chapters.push({ chapter, md: join(chaptersDir, name), body, sha256: sha256(body) })
    plan.reviews.push(...residueReviews(chapter, body))
  }
  const attentionPath = join(dir, 'attention.json')
  if (await fileExists(attentionPath)) {
    const data = await readJson(attentionPath, null)
    if (Array.isArray(data)) plan.attention = { shape: 'array', count: data.length }
    else if (data && typeof data === 'object' && data.chapters && typeof data.chapters === 'object') {
      const rows = Object.values(data.chapters).flat().filter((item) => item && typeof item === 'object')
      plan.attention = { shape: 'object', count: rows.length }
    } else plan.attention = { shape: 'unknown', count: 0 }
  }
  plan.needs =
    plan.chapters.length > 0 ||
    plan.attention?.shape === 'object' ||
    plan.legacy.length > 0 ||
    String(raw.schemaVersion ?? '') !== '0.6.0' ||
    !raw.readingPosition
  return plan
}

/** 备份整个项目目录。 */
async function backupProject(root, id) {
  const from = join(root, 'projects', id)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const to = join(root, PRE_BACKUP, `${id}-${stamp}`)
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { recursive: true })
  return to
}

/** 把旧流水线文件移到 legacy/。 */
async function archiveLegacy(dir, files) {
  const archived = []
  if (!files.length) return archived
  const legacyDir = join(dir, 'legacy')
  await mkdir(legacyDir, { recursive: true })
  for (const name of files) {
    if (await fileExists(join(legacyDir, name))) continue
    await rename(join(dir, name), join(legacyDir, name))
    archived.push(name)
  }
  return archived
}

/** attention.json 旧对象形状 → 数组（只改形状，字段原样保留）。 */
async function normalizeAttention(dir) {
  const path = join(dir, 'attention.json')
  if (!(await fileExists(path))) return 0
  const data = await readJson(path, null)
  if (Array.isArray(data)) return 0
  if (!data || typeof data !== 'object' || !data.chapters || typeof data.chapters !== 'object') return 0
  const rows = Object.values(data.chapters).flat().filter((item) => item && typeof item === 'object')
  await writeJson(path, rows)
  return rows.length
}

/** 用旧 pipeline/expansion/revision 生成 runs.json（已有则不动）。 */
async function seedRun(root, id, dir, files) {
  if (!files.length || (await fileExists(join(dir, 'runs.json')))) return false
  let source = null
  for (const name of ['pipeline.json', 'expansion.json', 'revision.json']) {
    if (!files.includes(name)) continue
    source = { name, data: await readJson(join(dir, name), null) }
    break
  }
  if (!source?.data) return false
  const status = String(source.data.status ?? 'idle')
  const mapped = ['running', 'paused', 'done', 'failed', 'ready', 'idle'].includes(status) ? status : 'idle'
  const run = {
    id: `run_${Date.now().toString(36)}`,
    kind: source.name === 'expansion.json' ? 'expand' : 'rewrite',
    status: mapped,
    scope: 'book',
    chapter: null,
    sessionId: null,
    budget: { maxTokens: 200000, maxCostCNY: 20, usedTokens: 0, usedCostCNY: 0 },
    stages: Array.isArray(source.data.stages) ? source.data.stages : [],
    notes: [`由 0.5.x ${source.name} 迁移归档`],
    startedAt: source.data.startedAt ?? null,
    finishedAt: source.data.finishedAt ?? null,
    createdAt: source.data.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await writeJson(join(dir, 'runs.json'), run)
  return true
}

/** 执行单个项目的迁移。 */
async function applyProject(root, plan) {
  const result = {
    id: plan.id,
    title: plan.title,
    ok: true,
    steps: [],
    counts: { chaptersConverted: 0, reviewsAdded: 0, reviewsSkipped: 0, attentionNormalized: 0, legacyArchived: 0, runsSeeded: false, backup: null },
  }
  if (!plan.needs) {
    result.steps.push('无需迁移（已是 0.6.0 结构）')
    return result
  }
  await ensureRoot(root)
  result.counts.backup = await backupProject(root, plan.id)
  result.steps.push(`备份到 ${result.counts.backup}`)

  result.chapters = []
  for (const item of plan.chapters) {
    const chapter = await readChapter(root, plan.id, item.chapter)
    await saveChapter(root, plan.id, item.chapter, chapter.text, chapter.meta, { format: 'txt', allowEmpty: true })
    // 写回后逐字校验：只有 sha256 与源 .md 正文一致，才删旧文件
    const written = await readChapter(root, plan.id, item.chapter)
    const newSha = sha256(written.text)
    const equal = newSha === item.sha256
    const row = { chapter: item.chapter, source: item.md, sourceSha256: item.sha256, newSha256: newSha, equal, removedMd: false }
    if (equal) {
      await rm(item.md, { force: true })
      row.removedMd = true
      result.counts.chaptersConverted += 1
      result.steps.push(`第 ${item.chapter} 章 .md → .txt + .meta.json（sha256 一致）`)
    } else {
      result.ok = false
      result.steps.push(`[失败] 第 ${item.chapter} 章写回后与源 .md 不一致，已保留 .md（可回滚）`)
    }
    result.chapters.push(row)
  }
  if (plan.reviews.length) {
    const outcome = await addReviews(root, plan.id, plan.reviews)
    result.counts.reviewsAdded = outcome.added
    result.counts.reviewsSkipped = outcome.skipped
    result.steps.push(`Markdown 残留转审阅：新增 ${outcome.added}，跳过 ${outcome.skipped}`)
  }
  const normalized = await normalizeAttention(plan.dir)
  if (normalized) {
    result.counts.attentionNormalized = normalized
    result.steps.push(`attention.json 对象形状 → 数组（${normalized} 条，字段原样保留）`)
  }
  // 先由旧流水线生成 runs.json，再归档文件（顺序不能反）
  result.counts.runsSeeded = await seedRun(root, plan.id, plan.dir, plan.legacy)
  if (result.counts.runsSeeded) result.steps.push('旧 pipeline/expansion/revision → runs.json')
  const archived = await archiveLegacy(plan.dir, plan.legacy)
  if (archived.length) {
    result.counts.legacyArchived = archived.length
    result.steps.push(`旧流水线归档 legacy/：${archived.join('、')}`)
  }

  const reportPath = join(plan.dir, MIGRATION_REPORT)
  await writeJson(reportPath, {
    projectId: plan.id,
    title: plan.title,
    migratedAt: new Date().toISOString(),
    root,
    ok: result.ok,
    backup: result.counts.backup,
    counts: result.counts,
    chapters: result.chapters ?? [],
  })
  result.counts.report = reportPath
  result.steps.push(`迁移报告：${MIGRATION_REPORT}（含逐章 sha256，可 --verify 复核）`)

  const patch = { schemaVersion: '0.6.0', migratedAt: new Date().toISOString() }
  if (!plan.project.readingPosition) patch.readingPosition = { chapter: 1, offset: 0 }
  await updateProject(root, plan.id, patch)
  result.steps.push('project.json 标记 schemaVersion 0.6.0')
  return result
}

/**
 * 迁移后复核：按 migration-report.json 里的 sha256 重算当前正文。
 * @returns {{id:string, ok:boolean, checked:number, mismatched:Object[], missing:number[], missingReport:boolean}}
 */
export async function verifyProject(root, id) {
  const dir = join(resolve(root), 'projects', id)
  const out = { id, ok: true, checked: 0, mismatched: [], missing: [], missingReport: false }
  const report = await readJson(join(dir, MIGRATION_REPORT), null)
  if (!report) {
    out.ok = false
    out.missingReport = true
    return out
  }
  for (const row of report.chapters ?? []) {
    let chapter
    try {
      chapter = await readChapter(root, id, row.chapter)
    } catch {
      out.missing.push(row.chapter)
      continue
    }
    out.checked += 1
    const actual = sha256(chapter.text)
    if (actual !== row.newSha256) out.mismatched.push({ chapter: row.chapter, expected: row.newSha256, actual })
  }
  out.ok = !out.missingReport && out.mismatched.length === 0 && out.missing.length === 0
  return out
}

/**
 * 迁移入口（供 CLI 与测试调用）。
 * @param {{ root?: string, apply?: boolean, projectId?: string|null, log?: (line: string) => void }} [options]
 */
export async function runMigration(options = {}) {
  const root = resolve(options.root ?? defaultRoot())
  const apply = Boolean(options.apply)
  const only = options.projectId ? String(options.projectId) : null
  const log = typeof options.log === 'function' ? options.log : console.log
  const report = { root, apply, ok: true, blocked: false, projects: [], startedAt: new Date().toISOString() }

  const ids = (await listProjectDirs(root)).filter((id) => !only || id === only)

  if (options.verify) {
    log(`复核迁移结果：${root}`)
    for (const id of ids) {
      const result = await verifyProject(root, id)
      report.projects.push({ id, verify: result })
      if (result.missingReport) {
        report.ok = false
        log(`- ${id}：没有 ${MIGRATION_REPORT}（还没迁移过，或报告被删了）`)
        continue
      }
      if (result.ok) log(`- ${id}：✓ ${result.checked} 章 sha256 全部一致`)
      else {
        report.ok = false
        for (const row of result.mismatched) log(`- ${id}：✗ 第 ${row.chapter} 章内容变了（报告 ${row.expected.slice(0, 12)}…，现在 ${row.actual.slice(0, 12)}…）`)
        for (const chapter of result.missing) log(`- ${id}：✗ 第 ${chapter} 章读不到`)
      }
    }
    log(report.ok ? '结论：迁移后的正文与迁移时逐字一致。' : '结论：有章节与迁移时不一致（可能是后来正常编辑过；确认无意外丢失即可）。')
    return report
  }

  const plans = []
  for (const id of ids) plans.push(await planProject(root, id))

  if (!plans.length) {
    log(`没有找到可迁移的项目：${root}/projects`)
    return report
  }

  // 计划先全部算完；apply 前统一检查 running
  const running = plans.filter((plan) => plan.running.length)
  if (apply && running.length) {
    report.ok = false
    report.blocked = true
    for (const plan of running) {
      report.projects.push({ id: plan.id, title: plan.title, ok: false, reason: `旧流水线正在运行：${plan.running.join('、')}` })
      log(`[拒绝] ${plan.id} ${plan.title}：旧流水线正在运行（${plan.running.join('、')}），请等它结束后再 --apply`)
    }
    log('已拒绝 --apply：存在 running 的旧流水线，未写入任何文件。')
    return report
  }

  for (const plan of plans) {
    if (plan.skip) {
      report.projects.push({ id: plan.id, title: plan.title, ok: true, skipped: true, reason: plan.reason })
      log(`[跳过] ${plan.id}：${plan.reason}`)
      continue
    }
    if (!plan.needs) {
      report.projects.push({ id: plan.id, title: plan.title, ok: true, steps: ['无需迁移（已是 0.6.0 结构）'], counts: {} })
      log(`[完成] ${plan.id} ${plan.title}：无需迁移`)
      continue
    }
    if (plan.running.length) log(`[警告] ${plan.id}：旧流水线 running（${plan.running.join('、')}），dry-run 会把它列入计划`)
    if (!apply) {
      log(`[计划] ${plan.id} ${plan.title}`)
      if (plan.chapters.length) {
        log(`  - 转换章节 ${plan.chapters.length} 个：${plan.chapters.map((item) => item.chapter).join('、')}`)
      }
      if (plan.reviews.length) log(`  - Markdown 残留转审阅 ${plan.reviews.length} 条（source=ai-style，不自动改字）`)
      if (plan.attention?.shape === 'object') log(`  - attention.json 对象形状 → 数组（${plan.attention.count} 条）`)
      if (plan.legacy.length) log(`  - 旧流水线文件归档 legacy/：${plan.legacy.join('、')}`)
      log('  - project.json 标记 schemaVersion 0.6.0，读取位置补默认值')
      report.projects.push({
        id: plan.id,
        title: plan.title,
        ok: true,
        running: plan.running,
        plan: {
          chapters: plan.chapters.map((item) => item.chapter),
          reviews: plan.reviews.length,
          attention: plan.attention?.shape ?? null,
          legacy: plan.legacy,
        },
      })
      continue
    }
    const result = await applyProject(root, plan)
    for (const step of result.steps) log(`  · ${result.id}: ${step}`)
    log(`[完成] ${result.id} ${result.title}`)
    report.projects.push(result)
  }
  if (!apply) {
    log('迁移会逐章校验 sha256（不一致就保留 .md）、写 migration-report.json；迁完可用 --verify 复核。')
    log('以上为 dry-run 计划；加 --apply 才会写盘。')
  }
  return report
}

/** 解析 CLI 参数（--apply / --dry-run / --root <p> / --project <id> / --help）。 */
export function parseArgs(argv = []) {
  const options = { apply: false, verify: false, root: null, projectId: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--verify') options.verify = true
    else if (arg === '--apply') options.apply = true
    else if (arg === '--dry-run') options.apply = false
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--root') options.root = argv[++i] ?? null
    else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length)
    else if (arg === '--project') options.projectId = argv[++i] ?? null
    else if (arg.startsWith('--project=')) options.projectId = arg.slice('--project='.length)
    else if (!arg.startsWith('-')) options.projectId = arg
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('用法：node scripts/migrate.js [--apply|--dry-run|--verify] [--root <数据根>] [--project <项目id>]')
    return
  }
  const report = await runMigration(options)
  if (!report.ok) process.exitCode = 1
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    console.error(`迁移失败：${error?.message ?? error}`)
    process.exitCode = 1
  })
}
