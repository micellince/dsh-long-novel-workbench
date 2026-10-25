#!/usr/bin/env node
/**
 * 体检：只读检查，不安装、不写 ~/StoryDesk。
 *
 *   node scripts/preflight.mjs
 *
 * 输出四块：① 插件是否已安装（以及有没有残留试装名） ② 是否有项目还在跑流水线
 * ③ 数据格式（还有多少章是旧 .md，是否需要迁移） ④ 本包自检（node --check + node --test）。
 * 退出码：0 = 健康（已切换或可以切换）；1 = 有阻塞问题。
 */

import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const profileDir = join(homedir(), '.dsh', 'profiles', 'desktop')
const storyRoot = process.env.STORY_DESK_ROOT || join(homedir(), 'StoryDesk')

const lines = []
const problems = []

async function profilePackages() {
  try {
    const raw = await readFile(join(profileDir, 'package.json'), 'utf8')
    return JSON.parse(raw)?.dependencies ?? {}
  } catch {
    return null
  }
}

async function runningRuns() {
  const out = []
  let projects = []
  try {
    const index = JSON.parse(await readFile(join(storyRoot, 'library.json'), 'utf8'))
    projects = (index?.projects ?? []).map((row) => ({ id: row.id, name: row.name ?? row.title ?? row.id }))
  } catch {
    return out
  }
  for (const project of projects) {
    const dir = join(storyRoot, 'projects', project.id)
    for (const file of ['revision.json', 'pipeline.json', 'expansion.json']) {
      try {
        const data = JSON.parse(await readFile(join(dir, file), 'utf8'))
        if (data?.status === 'running') out.push(`${project.name}（${project.id}）：${file} status=running runId=${data.runId ?? '—'}`)
      } catch {
        // 没这个文件就是没跑
      }
    }
    try {
      const chaptersDir = join(dir, 'chapters')
      const files = (await readdir(chaptersDir)).filter((f) => f.endsWith('.md') || f.endsWith('.txt'))
      let latest = 0
      for (const file of files) {
        const info = await stat(join(chaptersDir, file))
        if (info.mtimeMs > latest) latest = info.mtimeMs
      }
      if (latest && Date.now() - latest < 3 * 60 * 1000) out.push(`${project.name}：最近 3 分钟内有章节文件变动（${new Date(latest).toLocaleTimeString()}）`)
    } catch {
      // 没 chapters 目录
    }
  }
  return out
}

const deps = await profilePackages()
lines.push('## 插件安装状态')
if (deps === null) {
  lines.push(`- 读不到 profile：${profileDir}`)
  problems.push('profile 不可读')
} else {
  const installed = deps['dsh-long-novel-workbench']
  const staleDesk = deps['dsh-novel-desk']
  lines.push(`- 插件 dsh-long-novel-workbench：${installed ? `已安装（${installed}）` : '未安装'}`)
  if (staleDesk) {
    lines.push(`- ⚠️ 还残留旧试装名 dsh-novel-desk：${staleDesk}`)
    problems.push('残留 dsh-novel-desk 依赖，先 remove_bundle 再装本目录')
  }
}

lines.push('', '## 流水线是否在跑（在跑不能切换）')
const running = await runningRuns()
if (running.length === 0) lines.push('- 没有 running 的 revision / pipeline / expansion')
else {
  for (const row of running) lines.push(`- ⚠️ ${row}`)
  problems.push('有流水线在跑')
}

// ③ 数据格式：旧 .md 章还剩多少（新插件双读，迁移是可选的）
lines.push('', '## 数据格式（旧 .md 可直读；迁移可选）')
let mdChapters = 0
let txtChapters = 0
let projectCount = 0
try {
  const index = JSON.parse(await readFile(join(storyRoot, 'library.json'), 'utf8'))
  const projects = index?.projects ?? []
  projectCount = projects.length
  for (const project of projects) {
    const dir = join(storyRoot, 'projects', project.id, 'chapters')
    let files = []
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (/\.md$/.test(file)) mdChapters += 1
      else if (/\.txt$/.test(file)) txtChapters += 1
    }
  }
  lines.push(`- ${projectCount} 部作品：.md ${mdChapters} 章 / .txt ${txtChapters} 章`)
  lines.push(mdChapters > 0 ? '- 还有旧 .md 章：不迁移也能读写；要统一成纯文本可跑 `node scripts/migrate.js --apply`（先备份 + 逐章 sha256 校验）' : '- 全部是 .txt，无需迁移')
} catch {
  lines.push(`- 读不到 ${storyRoot}/library.json`)
}

lines.push('', '## 自检')
try {
  await run(process.execPath, ['--check', join(pkgRoot, 'index.js')])
  await run(process.execPath, ['--check', join(pkgRoot, 'client.js')])
  lines.push('- node --check：通过')
} catch (error) {
  lines.push(`- node --check：失败（${error.message.split('\n')[0]}）`)
  problems.push('语法检查失败')
}
try {
  const { stdout } = await run(process.execPath, ['--test', 'test/*.test.js'], { cwd: pkgRoot })
  const pass = /# pass (\d+)/.exec(stdout)?.[1]
  const fail = /# fail (\d+)/.exec(stdout)?.[1]
  lines.push(`- node --test：pass ${pass ?? '?'} / fail ${fail ?? '?'}`)
  if (fail !== '0') problems.push('测试未全绿')
} catch (error) {
  lines.push(`- node --test：失败（${(error.stdout ?? error.message).toString().split('\n').slice(-3).join(' ')}）`)
  problems.push('测试未全绿')
}

console.log(lines.join('\n'))

const installed = Boolean(deps?.['dsh-long-novel-workbench'])

if (problems.length > 0) {
  console.log(`\n结论：有阻塞问题 —— ${problems.join('；')}`)
  process.exitCode = 1
} else if (installed) {
  let pkgVersion = '0.6.2'
  try {
    pkgVersion = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8')).version || pkgVersion
  } catch {
    // 读不到就用兜底版本
  }
  console.log(`\n结论：已安装（${pkgVersion}）。刷新或重启 DSH 页面 → 侧栏 📖 打开网页后台；需要旧项目纯文本化时再跑迁移。`)
} else {
  console.log('\n结论：未安装。用 install_bundle 装本目录（/Users/micellince/Documents/deepseek-harness/dsh-long-novel-workbench）→ 刷新页面。')
  process.exitCode = 1
}
