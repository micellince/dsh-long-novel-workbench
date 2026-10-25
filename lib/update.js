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
