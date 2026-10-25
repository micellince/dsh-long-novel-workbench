#!/usr/bin/env node
/**
 * 界面冒烟：用真实数据造 fixtures，用无头 Chrome 渲染 8 个页面并截图。
 *
 * 关键点：**先把 StoryDesk 复制到临时目录再写 fixtures**，绝不往真实数据里写审阅/提案。
 *
 * 用法：
 *   node scripts/ui-smoke.mjs                       # 自动挑第一部作品
 *   node scripts/ui-smoke.mjs --project pmXXX       # 指定作品
 *   node scripts/ui-smoke.mjs --out /tmp/snaps      # 截图输出目录
 *   node scripts/ui-smoke.mjs --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
 */

import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleRpc } from '../index.js'

const PAGES = ['read', 'reviews', 'proposals', 'run', 'ledger', 'ledger?tab=characters', 'ledger?tab=events', 'ledger?tab=map', 'ledger?tab=map&open=1', 'ledger?tab=outlines', 'overview', 'settings']
const CHROME_DEFAULT = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const outDir = arg('out', join(tmpdir(), 'nd-ui-smoke'))
const chrome = arg('chrome', CHROME_DEFAULT)
const size = arg('size', '1680x1000')
const windowSize = size.replace('x', ',')
const work = outDir
const root = join(work, 'data')

async function main() {
  if (!existsSync(chrome)) throw new Error(`找不到 Chrome：${chrome}（用 --chrome 指定）`)
  const src = arg('root', process.env.STORY_DESK_ROOT || join(homedir(), 'StoryDesk'))
  if (!existsSync(join(src, 'library.json'))) throw new Error(`不是 StoryDesk 根目录：${src}`)

  // 1. 复制一份数据（fixtures 要写入审阅/提案，不能污染原库）
  await mkdir(work, { recursive: true })
  // 整库复制会带上 .pre-0.6.0 / .snapshots（几十 MB × 多份 → 塞满 /tmp），只复制渲染需要的东西
  await mkdir(root, { recursive: true })
  await cp(join(src, 'library.json'), join(root, 'library.json'))
  await cp(join(src, 'projects', 'proposals.json'), join(root, 'projects', 'proposals.json')).catch(() => {})
  const keep = ['project.json', 'attention.json', 'reviews.json', 'proposals.json', 'runs.json', 'usage.json', 'settings.json', 'facts.json', 'characters.json', 'events.json', 'foreshadow.json', 'conflicts.json', 'highlights.json', 'outlines.json', 'locations.json', 'presets.json', 'world.json']
  const { readdir } = await import('node:fs/promises')
  for (const id of await readdir(join(src, 'projects'))) {
    if (id === 'proposals.json') continue
    await mkdir(join(root, 'projects', id), { recursive: true })
    for (const name of keep) {
      await cp(join(src, 'projects', id, name), join(root, 'projects', id, name)).catch(() => {})
    }
  }

  // 2. 造 fixtures（走真实 RPC，形状与线上一致）
  process.env.STORY_DESK_ROOT = root
  const projects = await handleRpc({ op: 'projects.list', payload: {} })
  const list = Array.isArray(projects) ? projects : (projects.projects ?? [])
  const projectId = arg('project', String(list[0]?.id ?? ''))
  if (!projectId) throw new Error('没有作品可渲染')
  // 只复制目标作品的 chapters（目录要 recursive；全库复制会让每次冒烟多拷几十 MB）
  await cp(join(src, 'projects', projectId, 'chapters'), join(root, 'projects', projectId, 'chapters'), { recursive: true }).catch(() => {})

  const call = (op, payload = {}) => handleRpc({ op, payload }, {}, {})
  const toc = await call('chapter.list', { projectId })
  const chapters = Array.isArray(toc) ? toc : (toc.chapters ?? [])
  const first = chapters.find((row) => Number(row.words) > 0) ?? chapters[0]
  const chapterGet = {}
  for (const row of chapters.slice(0, 3)) {
    if (!row?.chapter) continue
    chapterGet[row.chapter] = await call('chapter.get', { projectId, chapter: row.chapter })
  }
  const body = String(chapterGet[first?.chapter]?.text ?? '')
  const quote = body.split('\n').map((line) => line.trim()).find((line) => line.length >= 6) ?? ''
  if (quote) {
    const store = await import('../lib/store.js')
    await store.addReviews(root, projectId, [
      { chapter: Number(first.chapter), source: 'logic', severity: 'major', quote: quote.slice(0, 12), issue: '界面冒烟：引文是否显示', suggestion: '冒烟用，不改正文' },
      { chapter: 0, source: 'reader', severity: 'suggestion', quote: '', issue: '界面冒烟：全书级读者意见', suggestion: '冒烟用' },
    ])
    await store.mergeAttention(root, projectId, Number(first.chapter), {
      breakdown: { hook: 18, tension: 16, payoff: 24, cliff: 26 }, verdict: '会', weakest: '张力',
    })
    await store.createProposal(root, projectId, {
      kind: 'patch-paragraph', chapter: Number(first.chapter), title: '界面冒烟提案', summary: '只在临时副本里创建',
      data: { patches: [{ before: quote.slice(0, 12), after: `${quote.slice(0, 12)}（冒烟）`, why: '冒烟', reviewIds: [] }] },
    })
  }

  await call('map.background', { projectId, seed: 7 }).catch(() => {})
  const fixtures = {}
  for (const [op, payload] of [
    ['projects.list', {}], ['project.context', { projectId }], ['chapter.list', { projectId }],
    ['review.list', { projectId }], ['proposal.list', { projectId }], ['run.get', { projectId }],
    ['ledger.get', { projectId }], ['usage.summary', { projectId }], ['align.status', { projectId }],
    ['settings.get', { projectId }], ['chapter.search', { projectId, query: '剑' }],
    ['ledger.sync', { projectId, action: 'status' }],
    ['ledger.sync', { projectId, action: 'workorder' }],
  ]) fixtures[op] = await call(op, payload)
  fixtures.chapterGet = chapterGet

  // 3. 组装静态页
  const site = join(work, 'site')
  await mkdir(site, { recursive: true })
  await cp(join(import.meta.dirname, '..', 'client.js'), join(site, 'client.js'))
  await ensureReact(site)
  await writeFile(join(site, 'index.html'), html(fixtures, projectId), 'utf8')

  // 4. 逐页截图：所有页面共用一个 Chrome profile（每页新建 profile 会留几十 MB 垃圾）
  const profile = join(work, 'chrome')
  await rm(profile, { recursive: true, force: true })
  await mkdir(join(outDir, 'shots'), { recursive: true })
  const failures = []
  for (const page of PAGES) {
    const shot = join(outDir, 'shots', `${page.replace(/[?=]/g, '-')}.png`)
    // 显式工作台标记必须放 hash：DSH 认证的 303 跳转会把 query 丢掉。
    const pageHash = page.includes('?') ? `${page}&novel-desk=1` : `${page}?novel-desk=1`
    const dom = execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
      '--virtual-time-budget=6000', `--window-size=${windowSize}`, '--dump-dom',
      `file://${join(site, 'index.html')}#${pageHash}`,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    const debug = /<pre id="debug"[^>]*>([\s\S]*?)<\/pre>/.exec(dom)?.[1] ?? ''
    const mark = (/mount: (.*)/.exec(debug)?.[1] ?? '').trim()
    const bad = (/errors: (.*)/.exec(debug)?.[1] ?? '').trim()
    if (!mark.startsWith('mounted') || bad) failures.push(`${page}: ${mark} ${bad ?? ''}`)
    execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
      '--virtual-time-budget=6000', `--window-size=${windowSize}`, `--screenshot=${shot}`,
      `file://${join(site, 'index.html')}#${pageHash}`,
    ], { maxBuffer: 64 * 1024 * 1024, stdio: 'ignore' })
    console.log(`- ${page}: ${mark || '(无状态)'}${bad ? ` 错误=${bad}` : ''} -> ${shot}`)
  }
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  if (failures.length) {
    console.error('\n失败页面：\n' + failures.map((f) => '  ' + f).join('\n'))
    process.exitCode = 1
  } else {
    console.log(`\n页面全部挂载成功；截图在 ${join(outDir, 'shots')}`)
  }
}

async function ensureReact(dir) {
  const local = join(import.meta.dirname, '..', '.ui-cache')
  await mkdir(local, { recursive: true })
  const files = [
    ['react.js', 'https://unpkg.com/react@18.3.1/umd/react.production.min.js'],
    ['react-dom.js', 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js'],
  ]
  for (const [name, url] of files) {
    const dest = join(dir, name)
    if (existsSync(join(local, name))) {
      await cp(join(local, name), dest)
      continue
    }
    if (existsSync(dest)) continue
    const res = await fetch(url)
    if (!res.ok) throw new Error(`下载 ${name} 失败（${res.status}）`)
    const text = await res.text()
    await writeFile(join(local, name), text, 'utf8')
    await writeFile(dest, text, 'utf8')
  }
}

function html(fixtures, projectId) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>novel-desk UI smoke</title>
<style>html,body{margin:0;padding:0;background:#fff;font-family:system-ui,sans-serif}#root{min-height:100vh}</style></head>
<body><div id="root"></div><pre id="debug" style="position:fixed;bottom:0;left:0;right:0;max-height:30vh;overflow:auto;background:#fee;color:#900;font-size:11px;z-index:9999;margin:0;white-space:pre-wrap"></pre>
<script src="react.js"></script><script src="react-dom.js"></script>
<script>
const FIX = ${JSON.stringify(fixtures)};
const mounts = {};
const response = (value) => ({ status: 200, ok: true, json: async () => ({ ok: true, value }) });
window.__mockErrors = [];
window.fetch = async (url, init) => {
  const op = JSON.parse((init && init.body) || '{}').op;
  if (op === 'chapter.get') return response(FIX.chapterGet[Number(JSON.parse(init.body).chapter)] || null);
  if (op === 'app.open') return response({ url: 'http://127.0.0.1:64615/', opened: true });
  if (Object.prototype.hasOwnProperty.call(FIX, op)) return response(FIX[op]);
  window.__mockErrors.push('未 mock 的 op: ' + op);
  return response({});
};
window.__ModuleLoader__ = { load({ id, factory }) {
  const require = (name) => (name === 'react' ? window.React : name === 'react-dom' ? window.ReactDOM : (() => { throw new Error('unknown module ' + name) })());
  try { mounts[id] = factory(require); } catch (error) { window.__mountError = String(error && error.stack || error); }
} };
window.onerror = (msg, src, line, col) => { window.__mockErrors.push('onerror: ' + msg + ' @' + line + ':' + col); };
window.addEventListener('unhandledrejection', (e) => { window.__mockErrors.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)); });
try { localStorage.setItem('nd.project', ${JSON.stringify(projectId)}); } catch (e) {}
if (location.hash.length > 1) { try {
  var hashParts = location.hash.slice(1).split('?');
  localStorage.setItem('nd.page', hashParts[0]);
  if (hashParts[1]) {
    var q = hashParts[1].split('&');
    for (var i = 0; i < q.length; i += 1) {
      if (q[i].indexOf('tab=') === 0) localStorage.setItem('nd.ledgerTab', q[i].slice(4));
      if (q[i].indexOf('open=') === 0) localStorage.setItem('nd.mapOpen', q[i].slice(5));
    }
  }
} catch (e) {} }
</script>
<script src="client.js"></script>
<script>
const mod = mounts['dsh-long-novel-workbench'];
const registered = [];
const ctx = {
  slots: { inject(name, cb) { try { cb(); } catch (e) { window.__mockErrors.push('inject ' + name + ': ' + e.message); } }, register(spec, Component) { registered.push({ spec, Component }); return () => {}; } },
  effect(fn) { try { fn(); } catch (e) {} return () => {}; },
  get() { return undefined; },
};
let status = 'module not loaded';
try { mod.apply(ctx); const overlay = registered.find((r) => r.spec.name === 'shell.overlay');
  if (!overlay) status = 'no shell.overlay';
  else { window.ReactDOM.createRoot(document.getElementById('root')).render(window.React.createElement(overlay.Component)); status = 'mounted: ' + registered.map((r) => r.spec.name).join(', '); }
} catch (error) { status = 'apply failed: ' + error.message; }
setTimeout(() => {
  const lines = ['mount: ' + status];
  if (window.__mountError) lines.push('mountError: ' + window.__mountError.split('\\n').slice(0, 4).join(' | '));
  if (window.__mockErrors.length) lines.push('errors: ' + window.__mockErrors.slice(0, 8).join(' || '));
  document.getElementById('debug').textContent = lines.join('\\n');
}, 800);
</script></body></html>`
}

await main()
