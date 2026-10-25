/**
 * 插件内更新检查（只读 npm registry，不自动安装）。
 *
 * 设计（作者定的）：
 *  - DSH / Node 升级后插件必须能跟着升级，而不是「DSH 一升级插件就废、只能卸载」；
 *  - 设置页显示：已装版本 / npm 最新版 / 更新方式；
 *  - 默认每天最多检查一次，可关；不静默自动升级（避免写作中被替换）。
 */

const PKG = 'dsh-long-novel-workbench'
const CACHE_MS = 6 * 60 * 60 * 1000

let cache = { at: 0, value: null }

export function currentVersion(pkg = {}) {
  return String(pkg.version ?? '').trim() || '0.0.0'
}

function compare(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** 检查 npm 最新版；网络失败返回 error 字段，不抛错。 */
export async function checkLatest({ installed = '', timeoutMs = 4000, force = false } = {}) {
  const now = Date.now()
  if (!force && cache.value && now - cache.at < CACHE_MS) {
    return { ...cache.value, installed }
  }
  const url = `https://registry.npmjs.org/${PKG}/latest`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`registry ${res.status}`)
    const data = await res.json()
    const latest = String(data?.version ?? '').trim()
    const value = {
      package: PKG,
      latest,
      outdated: latest ? compare(installed, latest) < 0 : false,
      url: `https://www.npmjs.com/package/${PKG}`,
      checkedAt: new Date().toISOString(),
      error: '',
    }
    cache = { at: now, value }
    return { ...value, installed }
  } catch (error) {
    const value = {
      package: PKG,
      latest: '',
      outdated: false,
      url: `https://www.npmjs.com/package/${PKG}`,
      checkedAt: new Date().toISOString(),
      error: error?.name === 'AbortError' ? '检查超时（可稍后再试）' : (error?.message || String(error)),
    }
    cache = { at: now, value }
    return { ...value, installed }
  } finally {
    clearTimeout(timer)
  }
}

/** 更新方式文本（给设置页复制）。 */
export function updateHint() {
  return [
    '在 DSH 的插件管理里更新本插件到最新版；或命令行：',
    `dsh plugin --profile <你的 profile> update ${PKG}`,
    '更新后：重载插件（Host 代码）+ 刷新 DSH 页面（客户端）。',
  ].join('\n')
}

// ── 自更新：下载 npm tarball → 校验 → 解包到临时目录 → 原子替换 ──
// 只对「非 git 源码副本」（正常 npm 安装）启用；git 开发副本只给 `git pull` 提示，不覆盖作者工作。

import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** 极简 tar 解析：只支持普通文件与目录（npm 包够用），拒绝越界路径。 */
export function parseTarFiles(buffer) {
  const files = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = readCString(header, 0, 100)
    const size = Number.parseInt(readCString(header, 124, 12).trim() || '0', 8) || 0
    const type = String.fromCharCode(header[156] || 48)
    const prefix = readCString(header, 345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    const junk = path.split('/').some((part) => part === '__MACOSX' || part.startsWith('._'))
    if (!junk) {
      if (type === '0' || type === '') files.push({ path, data: buffer.subarray(dataStart, dataEnd) })
      else if (type === '5') files.push({ path: path.replace(/\/$/, ''), dir: true })
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return files
}

function readCString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length)
  const end = slice.indexOf(0)
  return (end < 0 ? slice : slice.subarray(0, end)).toString('utf8')
}

function safeJoin(base, relative) {
  const clean = String(relative).replace(/\\/g, '/').replace(/^package\//, '').replace(/^\/+/, '')
  if (!clean || clean.split('/').includes('..')) return ''
  const target = resolve(base, clean)
  const root = resolve(base)
  return target === root || target.startsWith(root + '/') ? target : ''
}

async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

/** 判断插件目录形态：git 开发副本 / npm 安装副本。 */
export async function installMode(dir) {
  if (await exists(join(dir, '.git'))) return 'git'
  return 'tarball'
}

/**
 * 下载并安装最新版到 dir。
 * @param {{dir:string, installed:string, force?:boolean}} input
 */
export async function installLatest({ dir, installed = '', force = false } = {}) {
  const root = resolve(String(dir || ''))
  if (!root) throw new Error('缺少插件目录')
  const mode = await installMode(root)
  if (mode === 'git') {
    return {
      ok: false,
      mode,
      reason: '当前是 git 源码副本，不做自动覆盖。请先 commit 本地改动，再 `git pull`，然后重载插件。',
    }
  }
  const metaRes = await fetch(`https://registry.npmjs.org/${PKG}/latest`, { headers: { accept: 'application/json' } })
  if (!metaRes.ok) throw new Error(`获取最新版失败：${metaRes.status}`)
  const meta = await metaRes.json()
  const version = String(meta?.version || '')
  const tarball = String(meta?.dist?.tarball || '')
  const integrity = String(meta?.dist?.integrity || '')
  if (!tarball) throw new Error('最新版没有 tarball 地址')
  if (!force && version && compare(installed, version) >= 0) {
    return { ok: true, mode, version, reason: '已是最新版本', changed: false }
  }
  const res = await fetch(tarball)
  if (!res.ok) throw new Error(`下载安装包失败：${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  if (integrity.startsWith('sha512-')) {
    const expect = createHash('sha512').update(buffer).digest('base64')
    if (expect !== integrity.slice('sha512-'.length)) throw new Error('安装包校验失败（sha512 不一致）')
  }
  const files = parseTarFiles(gunzipSync(buffer))
  const manifest = files.find((file) => file.path.replace(/^package\//, '') === 'package.json')
  if (!manifest) throw new Error('安装包里没有 package.json')
  const pkg = JSON.parse(manifest.data.toString('utf8'))
  if (pkg.name !== PKG) throw new Error(`安装包包名不符：${pkg.name}`)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const staging = `${root}.new-${stamp}`
  await mkdir(staging, { recursive: true })
  for (const file of files) {
    const target = safeJoin(staging, file.path)
    if (!target) continue
    if (file.dir) { await mkdir(target, { recursive: true }); continue }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.data)
  }
  const backup = `${root}.old-${stamp}`
  await rename(root, backup)
  try {
    await rename(staging, root)
  } catch (error) {
    await rename(backup, root).catch(() => {})
    throw error
  }
  return {
    ok: true,
    mode,
    version: String(pkg.version || version),
    previous: installed,
    backup,
    changed: true,
    restartRequired: true,
    reason: '已替换插件文件；请重载插件并刷新 DSH 页面；如需回退调用 update.rollback。',
  }
}

/** 回退到最近一次 .old-* 备份。 */
export async function rollback(dir) {
  const root = resolve(String(dir || ''))
  const parent = dirname(root)
  const base = root.split('/').pop()
  let entries = []
  try { entries = await readdir(parent) } catch { entries = [] }
  const backups = entries
    .filter((name) => name.startsWith(`${base}.old-`))
    .sort()
    .reverse()
  if (!backups.length) return { ok: false, reason: '没有可回退的备份' }
  const backup = join(parent, backups[0])
  const current = `${root}.rollback-${Date.now()}`
  await rename(root, current).catch(() => {})
  await rename(backup, root)
  return { ok: true, restoredFrom: backup, previousCurrent: current, restartRequired: true }
}
