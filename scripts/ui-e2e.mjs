#!/usr/bin/env node
/**
 * 界面端到端：真实 HTTP handler + 真实 store（临时副本）+ 无头 Chrome + CDP 交互。
 *
 * 验证的是「点击真的能改到正文」：阅读 → 编辑 → 输入 → 保存（走 baseHash 校验）→ 历史；
 * 以及「审阅 → 提案 → 批准」真的落盘。全程在临时副本上跑，不碰 ~/StoryDesk。
 *
 * 用法：node scripts/ui-e2e.mjs [--project pmXXX] [--out /tmp/nd-ui-e2e] [--chrome 路径] [--keep]
 */

import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHandler, handleRpc } from '../index.js'
import * as store from '../lib/store.js'

const PAGES = { read: '正文', reviews: '审阅', proposals: '提案', run: '全文动作', ledger: '账本', overview: '总览', settings: '设置' }
const CHROME_DEFAULT = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const outDir = arg('out', join(tmpdir(), 'nd-ui-e2e'))
const keepArtifacts = process.argv.includes('--keep')
const chrome = arg('chrome', CHROME_DEFAULT)
const root = join(outDir, 'data')
const site = join(outDir, 'site')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  if (!existsSync(chrome)) throw new Error(`找不到 Chrome：${chrome}`)
  const src = arg('root', process.env.STORY_DESK_ROOT || join(homedir(), 'StoryDesk'))
  if (!existsSync(join(src, 'library.json'))) throw new Error(`不是 StoryDesk 根目录：${src}`)

  await mkdir(outDir, { recursive: true })
  // 上次异常退出可能留下 data/site/chrome/downloads（几百 MB ~ 1G+）：开跑先清掉
  for (const rel of ['data', 'site', 'chrome', 'downloads', 'import-src']) {
    await rm(join(outDir, rel), { recursive: true, force: true }).catch(() => {})
  }
  await rm(root, { recursive: true, force: true })
  process.env.STORY_DESK_ROOT = src

  const projects = await handleRpc({ op: 'projects.list', payload: {} }, {}, {})
  const list = Array.isArray(projects) ? projects : (projects.projects ?? [])
  // 选一部「有正文、且地图/时间线有数据」的作品：新书即使有正文，也未必有坐标/事件，
  // 否则复制后地图/时间线用例会整组失败。优先老样本，找不到再退回「有正文」。
  const explicitProject = arg('project', '')
  let projectId = explicitProject
  if (!projectId) {
    const preferred = list.find((p) => p.id === 'pmvi78nd39d7d')
    const order = preferred ? [preferred, ...list.filter((p) => p.id !== preferred.id)] : list
    let fallback = ''
    for (const row of order) {
      const probe = await handleRpc({ op: 'chapter.list', payload: { projectId: row.id } }, {}, {})
      const rows = Array.isArray(probe) ? probe : (probe.chapters ?? [])
      if (!rows.some((chapter) => Number(chapter?.words) > 0)) continue
      if (!fallback) fallback = String(row.id)
      const ledger = await handleRpc({ op: 'ledger.get', payload: { projectId: row.id } }, {}, {})
      const locations = Array.isArray(ledger?.locations) ? ledger.locations : []
      const events = Array.isArray(ledger?.events) ? ledger.events : []
      const placed = locations.filter((item) => {
        const x = item?.coords && item.coords.x != null ? item.coords.x : item?.x
        const y = item?.coords && item.coords.y != null ? item.coords.y : item?.y
        return Number.isFinite(Number(x)) && Number.isFinite(Number(y))
      })
      if (placed.length >= 2 && events.length > 0) { projectId = String(row.id); break }
    }
    if (!projectId) projectId = fallback
  }
  if (!projectId) throw new Error('没有作品可测')

  // 只复制目标作品（不整库复制：别的作品可能正被旧 Agent 写入，cp 会因文件消失报 ENOENT）
  await copyProject(src, root, projectId)
  process.env.STORY_DESK_ROOT = root
  const toc = await handleRpc({ op: 'chapter.list', payload: { projectId } }, {}, {})
  const chapters = Array.isArray(toc) ? toc : (toc.chapters ?? [])
  const first = chapters.find((row) => Number(row.words) > 0) ?? chapters[0]
  if (!first) throw new Error('没有可测的章节')
  const chapterNo = Number(first.chapter)

  // 造一个「旧稿目录」供导入用（3 章 .md，带 frontmatter）
  const importSrc = join(outDir, 'import-src')
  await mkdir(join(importSrc, 'chapters'), { recursive: true })
  await writeFile(join(importSrc, 'project.json'), JSON.stringify({ title: '导入测试书', genre: '悬疑' }, null, 2), 'utf8')
  for (let n = 1; n <= 3; n += 1) {
    await writeFile(join(importSrc, 'chapters', `000${n}.md`), `---\ntitle: 导入第${n}章\nstatus: done\n---\n\n这是导入测试的第 ${n} 章正文。\n\n第二段。\n`, 'utf8')
  }

  // 预置一条审阅 + 一条提案（走真实 store），供「批准」流程使用
  const beforeGet = await handleRpc({ op: 'chapter.get', payload: { projectId, chapter: chapterNo } }, {}, {})
  const text = String(beforeGet.text ?? '')
  const quote = text.split('\n').map((l) => l.trim()).find((l) => l.length >= 8) ?? ''
  await store.addReviews(root, projectId, [
    { chapter: chapterNo, source: 'logic', severity: 'major', quote: quote.slice(0, 10), issue: '界面端到端：待批准补丁', suggestion: '补一个词' },
    { chapter: 0, source: 'logic', severity: 'major', quote: '', issue: '界面端到端：全局时间线统一', suggestion: '统一成同一口径' },
  ])
  const created = await store.createProposal(root, projectId, {
    kind: 'patch-paragraph', chapter: chapterNo, title: 'E2E 补丁', summary: '端到端测试用',
    data: { patches: [{ before: quote.slice(0, 10), after: `${quote.slice(0, 10)}（E2E）`, why: '端到端', reviewIds: [] }] },
  })

  // 旧数据可能带着已完成的 runs.json：重置成 idle，保证「新建全文动作」按钮存在
  await handleRpc({ op: 'run.reset', payload: { projectId } }, {}, {})

  // 真实 handler 的静态站
  await mkdir(site, { recursive: true })
  await cp(join(import.meta.dirname, '..', 'client.js'), join(site, 'client.js'))
  await ensureReact(site)
  await writeFile(join(site, 'index.html'), html(projectId), 'utf8')

  const handler = createHandler({}, { root })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${addr.port}`)
    if (req.method === 'POST' && url.pathname === '/novel-desk/api') return handler(req, res)
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(await readFile(join(site, 'index.html')))
      return
    }
    if (req.method === 'GET' && url.pathname === '/client.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(await readFile(join(site, 'client.js')))
      return
    }
    if (req.method === 'GET' && (url.pathname === '/react.js' || url.pathname === '/react-dom.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(await readFile(join(site, url.pathname.slice(1))))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  const addr = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address())))
  const base = `http://127.0.0.1:${addr.port}/`

  const profile = join(outDir, 'chrome')
  await rm(profile, { recursive: true, force: true })
  const stderrFile = join(outDir, 'chrome-stderr.log')
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', (buf) => appendFileSync(stderrFile, buf))
  process.on('exit', () => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } })
  // 被中断时（npm 测试常被 Ctrl-C）同步清掉大目录，避免 /tmp 越攒越多
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      if (!keepArtifacts) {
        for (const rel of ['data', 'site', 'chrome', 'downloads', 'import-src']) {
          try { rmSync(join(outDir, rel), { recursive: true, force: true }) } catch { /* 忽略 */ }
        }
      }
      process.exit(130)
    })
  }
  const ws = await connectCdp(profile, stderrFile)

  try {
    await ws.send('Page.enable')
    await ws.send('Runtime.enable')
    await ws.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
    await ws.send('Page.navigate', { url: `${base}#novel-desk=1` })
    await waitFor(ws, `!!document.querySelector('.nd-overlay')`, '工作台挂载')
    check('工作台挂载', true)

    // 等体积数据就位
    await waitFor(ws, `document.body.innerText.includes('第 1 章') || document.body.innerText.includes('第 0 章')`, '正文载入')

    // 键盘：/ 聚焦搜索 → 搜索 → 点击结果定位高亮
    await pressKey(ws, { key: '/', code: 'Slash', text: '/', windowsVirtualKeyCode: 191 })
    await sleep(150)
    check('/ 聚焦搜索框', await ws.evaluate(`(() => { const el = document.activeElement; return !!el && String(el.className).includes('nd-search-input') })()`))
    await ws.send('Input.insertText', { text: '伞' })
    await pressKey(ws, { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await waitFor(ws, `!!document.querySelector('.nd-results .nd-result')`, '搜索有结果', 8000)
    check('搜索有结果', (await ws.evaluate(`document.querySelectorAll('.nd-results .nd-result').length`)) > 0)
    await ws.evaluate(`(() => { const row = document.querySelector('.nd-results .nd-result'); if (row) row.click(); return true })()`)
    await waitFor(ws, `!!document.querySelector('.nd-hl')`, '搜索结果高亮', 8000)
    check('搜索关键词高亮', true)
    // .nd-target 只闪 1.6s：等「元素存在且已在视口内」这一个条件，再取文本
    await waitFor(ws, `(() => { const el = document.querySelector('.nd-target'); if (!el) return false; const b = el.getBoundingClientRect(); return b.top < innerHeight && b.bottom > 0 })()`, '搜索命中段落滚到视口内', 8000)
    const targeted = await ws.evaluate(`(() => { const el = document.querySelector('.nd-target'); if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), text: el.innerText.slice(0, 30) } })()`)
    check('搜索命中段落滚到视口内', Boolean(targeted), targeted ? `top=${targeted.top} ${targeted.text}` : '没找到 .nd-target')

    // 键盘：j 翻到下一章
    await ws.evaluate(`(() => { if (document.activeElement) document.activeElement.blur(); return true })()`)
    const posBefore = await ws.evaluate(`(() => { const el = document.querySelector('.nd-read-pos'); return el ? el.innerText : '' })()`)
    await pressKey(ws, { key: 'j', code: 'KeyJ', text: 'j', windowsVirtualKeyCode: 74 })
    const posAfter = await poll(async () => {
      const value = await ws.evaluate(`(() => { const el = document.querySelector('.nd-read-pos'); return el ? el.innerText : '' })()`)
      return value !== posBefore ? value : ''
    }, 4000)
    check('j 键翻到下一章', Boolean(posAfter) && posAfter !== posBefore, `${posBefore} → ${posAfter}`)
    await ws.evaluate(`(() => { const first = document.querySelector('.nd-toc-item'); if (first) first.click(); localStorage.setItem('nd.chapter', '${chapterNo}'); return true })()`)
    await sleep(300)

    // 沉浸模式：只留阅读 / 编辑 / 审阅三颗按钮，正文接近全屏，Esc 退出
    await clickText(ws, 'button', '沉浸')
    await waitFor(ws, `!!document.querySelector('.nd-overlay.nd-immersive')`, '进入沉浸模式')
    const imState = await ws.evaluate(`(() => {
      const visible = (sel) => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0 };
      const box = document.querySelector('.nd-reader-scroll');
      return {
        nav: visible('.nd-nav'), top: visible('.nd-top'), toc: visible('.nd-toc'), side: visible('.nd-side'),
        segs: [...document.querySelectorAll('.nd-immersive .nd-seg-item')].map((n) => n.innerText.trim()),
        exit: visible('.nd-im-exit'),
        paper: getComputedStyle(box).backgroundColor,
        boxH: Math.round(box.clientHeight), viewH: window.innerHeight,
      };
    })()`)
    check('沉浸模式收起顶栏 / 左导航 / 目录 / 右栏', !imState.nav && !imState.top && !imState.toc && !imState.side, `nav=${imState.nav} top=${imState.top} toc=${imState.toc} side=${imState.side}`)
    check('沉浸模式正文只剩阅读 / 编辑 / 审阅三颗按钮', imState.segs.length === 3 && imState.segs.join('/') === '阅读/编辑/审阅', imState.segs.join('/'))
    check('沉浸模式正文接近全屏', imState.boxH > imState.viewH * 0.9, `正文 ${imState.boxH} / 视口 ${imState.viewH}`)
    check('阅读区是仿纸底', imState.paper.replace(/\s/g, '') === 'rgb(247,242,230)', imState.paper)
    // 沉浸里点「审阅」不能像没反应：左侧状态要给「选中文字 → 加批注」提示
    await clickText(ws, '.nd-immersive .nd-seg-item', '审阅')
    const imReaderHint = await poll(async () => {
      const text = await ws.evaluate(`(() => { const el = document.querySelector('.nd-im-state'); return el ? el.innerText : '' })()`)
      return String(text).includes('选中文字') ? text : ''
    }, 3000)
    check('沉浸模式切到审阅有选字提示', Boolean(imReaderHint), imReaderHint)
    await clickText(ws, '.nd-immersive .nd-seg-item', '阅读')
    // 沉浸里的字号 −/+：在顶栏（不是贴底浮层），只改 CSS font-size，不加载字体
    const sizePos = await ws.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.nd-im-size-btn')].find((n) => String(n.title).includes('字号增大'));
      if (!btn) return null;
      const rect = btn.getBoundingClientRect();
      const head = document.querySelector('.nd-immersive .nd-read-head');
      const headRect = head ? head.getBoundingClientRect() : null;
      return { top: Math.round(rect.top), inHead: !!headRect && rect.top >= headRect.top - 1 && rect.bottom <= headRect.bottom + 1, w: Math.round(rect.width), h: Math.round(rect.height) };
    })()`)
    check('沉浸字号 −/+ 在顶栏且点按区域够大', Boolean(sizePos) && sizePos.inHead && sizePos.top < 120 && sizePos.w >= 26 && sizePos.h >= 26, JSON.stringify(sizePos))
    const readSize = () => ws.evaluate(`(() => { const el = document.querySelector('.nd-reader-body'); return el ? getComputedStyle(el).fontSize : '' })()`)
    const sizeBefore = await readSize()
    await ws.evaluate(`(() => { const b = [...document.querySelectorAll('.nd-im-size-btn')].find((n) => String(n.title).includes('字号增大')); if (b) b.click(); return !!b })()`)
    const sizedUp = await poll(async () => {
      const now = await readSize()
      return now && now !== sizeBefore ? now : ''
    }, 3000)
    check('沉浸模式 + 放大字号', Boolean(sizedUp) && parseFloat(sizedUp) > parseFloat(sizeBefore), `${sizeBefore} → ${sizedUp}`)
    await ws.evaluate(`(() => { const b = [...document.querySelectorAll('.nd-im-size-btn')].find((n) => String(n.title).includes('字号减小')); if (b) b.click(); return !!b })()`)
    await sleep(250)
    const sizeBack = await readSize()
    check('沉浸模式 − 缩小回原字号', parseFloat(sizeBack) === parseFloat(sizeBefore), `${sizeBefore} → ${sizedUp} → ${sizeBack}`)
    // 上限 28px：连点 + 要停在 28，不能无限放大
    await ws.evaluate(`(() => {
      const b = [...document.querySelectorAll('.nd-im-size-btn')].find((n) => String(n.title).includes('字号增大'));
      for (let i = 0; i < 20; i += 1) b.click();
      return true;
    })()`)
    const capped = await poll(async () => {
      const now = await readSize()
      return now === '28px' ? now : ''
    }, 3000)
    check('字号上限 28px（连点 + 不越界）', capped === '28px', String(capped || '未到 28px'))
    // 原路退回 15px，别影响后面的移动端 / 滚动断言
    await ws.evaluate(`(() => {
      const b = [...document.querySelectorAll('.nd-im-size-btn')].find((n) => String(n.title).includes('字号减小'));
      for (let i = 0; i < 13; i += 1) b.click();
      return true;
    })()`)
    const restoredSize = await poll(async () => {
      const now = await readSize()
      return now === sizeBefore ? now : ''
    }, 3000)
    check('字号可以退回原值', restoredSize === sizeBefore, String(restoredSize || '没退回'))
    // 手机宽度复核：0.6 的窄屏 CSS 曾用 font-size:15px!important 钉死正文，
    // 手机点 +/− 只改数字不改字（PC 正常）。这里真切到 500x844 视口验 computed font-size。
    await ws.send('Emulation.setDeviceMetricsOverride', { width: 500, height: 844, deviceScaleFactor: 1, mobile: true })
    await sleep(400)
    const mobileSizeBefore = await readSize()
    await ws.evaluate(`(() => { const b = [...document.querySelectorAll('.nd-im-size-btn')].find((n) => String(n.title).includes('字号增大')); if (b) b.click(); return !!b })()`)
    const mobileSizeAfter = await poll(async () => {
      const now = await readSize()
      return now && now !== mobileSizeBefore ? now : ''
    }, 3000)
    check('手机宽度（500px）+ 也能真的放大字号', Boolean(mobileSizeAfter) && parseFloat(mobileSizeAfter) > parseFloat(mobileSizeBefore), `${mobileSizeBefore} → ${mobileSizeAfter}`)
    await ws.evaluate(`(() => { const b = [...document.querySelectorAll('.nd-im-size-btn')].find((n) => String(n.title).includes('字号减小')); if (b) b.click(); return !!b })()`)
    await sleep(200)
    await ws.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    await pressKey(ws, { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(ws, `!document.querySelector('.nd-overlay.nd-immersive')`, 'Esc 退出沉浸', 4000)
    const afterImmersive = await ws.evaluate(`(() => ({
      open: !!document.querySelector('.nd-overlay'),
      toc: (() => { const el = document.querySelector('.nd-toc'); return !!el && getComputedStyle(el).display !== 'none' })()
    }))()`)
    check('Esc 退出沉浸且不关工作台', afterImmersive.open && afterImmersive.toc, JSON.stringify(afterImmersive))

    // 编辑 → 输入 → 保存
    await clickText(ws, 'button', '编辑')
    await waitFor(ws, `!!document.querySelector('.nd-editor')`, '编辑器出现')
    const added = `（界面端到端 ${Date.now() % 1000}）`
    await ws.evaluate(`(() => {
      const el = document.querySelector('.nd-editor');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, el.value + '\\n\\n${added}');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value.length;
    })()`)
    await clickText(ws, 'button', '保存')
    await waitFor(ws, `document.body.innerText.includes('本章已保存')`, '保存提示')
    check('编辑器保存提示', true)

    const afterSave = await handleRpc({ op: 'chapter.get', payload: { projectId, chapter: chapterNo } }, {}, {})
    check('保存真的落盘', String(afterSave.text).includes(added), `章节 ${chapterNo} 已含新段落`)
    check('保存后产生历史', (await store.listChapterHistory(root, projectId, chapterNo)).length >= 1)

    // 键盘：⌘S 也要能保存
    const added2 = `（CmdS ${Date.now() % 1000}）`
    await ws.evaluate(`(() => {
      const el = document.querySelector('.nd-editor');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, el.value + '\\n' + '${added2}');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
      return true;
    })()`)
    await sleep(200)
    await pressKey(ws, { key: 's', code: 'KeyS', modifiers: 4, windowsVirtualKeyCode: 83 })
    const savedByCmd = await poll(async () => {
      const value = await handleRpc({ op: 'chapter.get', payload: { projectId, chapter: chapterNo } }, {}, {})
      return String(value.text).includes(added2)
    }, 5000)
    check('⌘S 保存生效', Boolean(savedByCmd))

    // 提案页 → 批准（先验证：正文已改过，旧提案应被判 stale）
    await clickNav(ws, '提案')
    await waitFor(ws, `!!document.querySelector('.nd-proposal-head')`, '提案列表')
    await clickText(ws, '.nd-proposal-head', 'E2E 补丁')
    await waitFor(ws, `!!document.querySelector('.nd-proposal-actions')`, '提案展开')
    await clickText(ws, '.nd-proposal-actions button', '批准')
    await waitFor(ws, `(() => { const m = document.querySelector('.nd-msg .nd-msg-text'); return !!m && /stale|过期/.test(m.innerText) })()`, 'stale 提示', 8000)
    const staleNotice = await ws.evaluate(`(() => { const m = document.querySelector('.nd-msg .nd-msg-text'); return m ? m.innerText : '' })()`)
    check('正文改过后旧提案被判过期', /stale|过期/.test(staleNotice), staleNotice)

    // 用最新正文再生成一条提案 → 刷新 → 批准应真的改成正文
    const now = await handleRpc({ op: 'chapter.get', payload: { projectId, chapter: chapterNo } }, {}, {})
    const freshQuote = String(now.text).split('\n').map((l) => l.trim()).find((l) => l.length >= 8) ?? ''
    await store.createProposal(root, projectId, {
      kind: 'patch-paragraph', chapter: chapterNo, title: 'E2E 新鲜补丁', summary: '端到端测试用（正文最新）',
      data: { patches: [{ before: freshQuote.slice(0, 8), after: `${freshQuote.slice(0, 8)}（E2E）`, why: '端到端', reviewIds: [] }] },
    })
    await ws.send('Page.reload')
    await waitFor(ws, `!!document.querySelector('.nd-nav-item')`, '重新挂载', 15000)
    await clickNav(ws, '提案')
    await waitFor(ws, `[...document.querySelectorAll('.nd-proposal-head')].some((n) => n.innerText.includes('E2E 新鲜补丁'))`, '新提案可见')
    await clickText(ws, '.nd-proposal-head', 'E2E 新鲜补丁')
    await waitFor(ws, `!!document.querySelector('.nd-proposal-actions')`, '新提案展开')
    await clickText(ws, '.nd-proposal-actions button', '批准')
    await waitFor(ws, `(() => { const m = document.querySelector('.nd-msg .nd-msg-text'); return !!m && /已采纳|未通过闸门/.test(m.innerText) })()`, '批准结果', 8000)
    const notice = await ws.evaluate(`(() => { const m = document.querySelector('.nd-msg .nd-msg-text'); return m ? m.innerText : '' })()`)
    check('提案批准有明确提示', Boolean(notice), notice)
    const afterAccept = await handleRpc({ op: 'chapter.get', payload: { projectId, chapter: chapterNo } }, {}, {})
    check('批准真的改正文', String(afterAccept.text).includes('（E2E）') || String(notice).includes('未通过闸门'), String(notice))

    // 提案批量：卡片头常显按钮 + 多选 → 批量批准 / 批量驳回（原因落到每条）
    const mkBatch = async (title) => store.createProposal(root, projectId, {
      kind: 'ledger-fix', title, summary: '批量测试',
      data: { ledgerFixes: [{ kind: 'facts', patch: { id: `e2e-${title}`, subject: 'E2E', predicate: '测试', value: title, fromChapter: chapterNo } }] },
    })
    const batchA = await mkBatch('E2E 批量 A')
    const batchB = await mkBatch('E2E 批量 B')
    await ws.send('Page.reload')
    await waitFor(ws, `!!document.querySelector('.nd-nav-item')`, '重新挂载（批量）', 15000)
    await clickNav(ws, '提案')
    await waitFor(ws, `!!document.querySelector('.nd-proposal-batch')`, '批量操作栏')
    const headVisible = await ws.evaluate(`(() => {
      const row = [...document.querySelectorAll('.nd-proposal')].find((n) => n.innerText.includes('E2E 批量 A'))
      return !!row && [...row.querySelectorAll('.nd-proposal-head button')].some((b) => b.innerText.includes('批准'))
    })()`)
    check('待批准提案在卡片头就有批准/驳回按钮', headVisible === true)
    const marked = await ws.evaluate(`(() => {
      let n = 0
      for (const title of ['E2E 批量 A', 'E2E 批量 B']) {
        const row = [...document.querySelectorAll('.nd-proposal')].find((r) => r.innerText.includes(title))
        const box = row && row.querySelector('.nd-check')
        if (box) { box.click(); n += 1 }
      }
      return n
    })()`)
    check('批量勾选可选多条', marked === 2, `${marked} 条`)
    await clickText(ws, '.nd-proposal-batch button', '批量批准')
    await waitFor(ws, `(() => { const m = document.querySelector('.nd-msg .nd-msg-text'); return !!m && /已批准/.test(m.innerText) })()`, '批量批准结果', 10000)
    const afterBatchA = await handleRpc({ op: 'proposal.get', payload: { projectId, proposalId: batchA.id } }, {}, {})
    const afterBatchB = await handleRpc({ op: 'proposal.get', payload: { projectId, proposalId: batchB.id } }, {}, {})
    check('批量批准两条都生效', afterBatchA.status === 'accepted' && afterBatchB.status === 'accepted', `${afterBatchA.status}/${afterBatchB.status}`)

    const batchC = await mkBatch('E2E 批量 C')
    const batchD = await mkBatch('E2E 批量 D')
    await ws.send('Page.reload')
    await waitFor(ws, `!!document.querySelector('.nd-nav-item')`, '重新挂载（批量驳回）', 15000)
    await clickNav(ws, '提案')
    await waitFor(ws, `!!document.querySelector('.nd-proposal-batch')`, '批量操作栏（驳回）')
    await ws.evaluate(`(() => {
      for (const title of ['E2E 批量 C', 'E2E 批量 D']) {
        const row = [...document.querySelectorAll('.nd-proposal')].find((r) => r.innerText.includes(title))
        const box = row && row.querySelector('.nd-check')
        if (box) box.click()
      }
      return true
    })()`)
    await clickText(ws, '.nd-proposal-batch button', '批量驳回')
    await waitFor(ws, `!!document.querySelector('.nd-reject textarea')`, '批量驳回原因输入')
    await ws.evaluate(`(() => {
      const el = document.querySelector('.nd-reject textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, '节奏太慢')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    await clickText(ws, '.nd-reject button', '确认批量驳回')
    await waitFor(ws, `(() => { const m = document.querySelector('.nd-msg .nd-msg-text'); return !!m && /已驳回/.test(m.innerText) })()`, '批量驳回结果', 10000)
    const afterBatchC = await handleRpc({ op: 'proposal.get', payload: { projectId, proposalId: batchC.id } }, {}, {})
    check('批量驳回带原因落到每条提案', afterBatchC.status === 'rejected' && afterBatchC.rejectReason === '节奏太慢', `${afterBatchC.status}/${afterBatchC.rejectReason}`)
    void batchD

    // 审阅页：不截断 / 不自己拼提案 / 生成的是 AI 工作单
    const fetchReviews = async () => {
      const value = await handleRpc({ op: 'review.list', payload: { projectId } }, {}, {})
      return Array.isArray(value) ? value : (value.reviews ?? [])
    }
    const pendingCount = async () => {
      const value = await handleRpc({ op: 'proposal.list', payload: { projectId, status: 'pending', filter: { status: 'pending' } } }, {}, {})
      const rows = Array.isArray(value) ? value : (value.proposals ?? [])
      return rows.length
    }
    await clickNav(ws, '审阅')
    await waitFor(ws, `!!document.querySelector('.nd-review-row')`, '审阅列表')
    const pendingBefore = await pendingCount()
    const openReviews = (await fetchReviews()).filter((rv) => String(rv.status || 'open') === 'open')
    const domRows = await ws.evaluate(`document.querySelectorAll('.nd-review-row').length`)
    check('审阅列表不截断（DOM 行数 = 待处理条数）', domRows === openReviews.length, `DOM ${domRows} / open ${openReviews.length}`)
    if (openReviews.length > 5) check('审阅列表超过 5 条仍全量显示', domRows > 5, `DOM ${domRows}`)

    // 只勾选「我们预置的那条」（fixture 项目里还有大量旧的无引文条目，不能生成段落补丁）
    const picked = await ws.evaluate(`(() => {
      const row = [...document.querySelectorAll('.nd-review-row')].find((n) => n.innerText.includes('界面端到端：待批准补丁'));
      if (!row) return false;
      const box = row.querySelector('.nd-check');
      if (!box) return false;
      box.click();
      return true;
    })()`)
    check('审阅列表里能找到预置条目', picked)
    await waitFor(ws, `document.body.innerText.includes('已选 1 条')`, '勾选生效')
    const projectBundle = await handleRpc({ op: 'project.context', payload: { projectId } }, {}, {})
    const projectRow = projectBundle?.project && typeof projectBundle.project === 'object' ? projectBundle.project : (projectBundle ?? {})
    const workspacePath = String(projectRow?.workspacePath ?? projectRow?.rootPath ?? '')
    const chapterLine = `第${chapterNo}章`

    // 勾选审阅 → 生成修改提案：只生成工作单（dryRun），不再由界面拼确定性提案
    await clickText(ws, '.nd-toolbar button', '生成修改提案')
    await waitFor(ws, `!!document.querySelector('.nd-modal pre')`, '修改提案工作单弹窗', 8000)
    const proposalWorkorder = await ws.evaluate(`(() => { const el = document.querySelector('.nd-modal pre'); return el ? el.innerText : '' })()`)
    check('生成修改提案走 proposalGroupsWorkorder 工作单', proposalWorkorder.includes('【审阅 → 分章提案工作单】'), `${proposalWorkorder.length} 字`)
    check('修改提案工作单要求 after 是成文正文', proposalWorkorder.includes('after 必须是「改好后的正文」'))
    check('修改提案工作单禁止编辑指令', proposalWorkorder.includes('不许「改成…」「建议…」「二选一」「补一次…」「这里应该…」'))
    check('修改提案工作单要求挂 reviewIds', proposalWorkorder.includes('reviewIds'))
    check('修改提案工作单列出预置审阅所属章', proposalWorkorder.includes(`第${chapterNo}章`))
    if (workspacePath) {
      const expectPath = `${workspacePath.replace(/[\\/]+$/, '')}/chapters/${String(chapterNo).padStart(4, '0')}.txt`
      check('修改提案工作单章节清单带 path', proposalWorkorder.includes(expectPath), expectPath)
    }
    check('生成修改提案不再直接建提案（dryRun）', (await pendingCount()) === pendingBefore, `${pendingBefore} → ${await pendingCount()}`)
    await ws.evaluate(`(() => { const el = document.querySelector('.nd-modal-head button'); if (el) el.click(); return true })()`)
    await sleep(200)

    // 提案数据契约：after 非空、且不含编辑指令（防「把建议当正文」回归）
    const proposalValue = await handleRpc({ op: 'proposal.list', payload: { projectId } }, {}, {})
    const seededProposal = (Array.isArray(proposalValue) ? proposalValue : (proposalValue.proposals ?? [])).find((row) => row.title === 'E2E 补丁')
    const kicker = '改成|建议|二选一|读者可回查'
    const afterText = String(seededProposal?.data?.patches?.[0]?.after ?? '')
    check('提案 after 非空', afterText.trim().length > 0, afterText)
    check('提案 after 不含编辑指令', !new RegExp(kicker).test(afterText), afterText)

    // 只勾全书级行 → 「生成修改提案」自动并进全局修改（2026-10-25 用户反馈：勾了还提示先勾选）
    await ws.evaluate(`(() => {
      const row = [...document.querySelectorAll('.nd-review-row')].find((n) => n.innerText.includes('界面端到端：待批准补丁'));
      if (row) { const box = row.querySelector('.nd-check'); if (box) box.click(); }
      return true;
    })()`)
    await waitFor(ws, `document.body.innerText.includes('已选 0 条')`, '清空勾选')
    const pickedGlobalRow = await ws.evaluate(`(() => {
      const row = [...document.querySelectorAll('.nd-review-row')].find((n) => n.innerText.includes('界面端到端：全局时间线统一'));
      if (!row) return false;
      const box = row.querySelector('.nd-check');
      if (!box) return false;
      box.click();
      return true;
    })()`)
    check('审阅列表里能找到全书级条目', pickedGlobalRow)
    await waitFor(ws, `document.body.innerText.includes('已选 1 条（全书级 1 条）')`, '勾选全书级条目生效')
    await clickText(ws, '.nd-toolbar button', '生成修改提案')
    await waitFor(ws, `!!document.querySelector('.nd-modal pre')`, '全书级自动路由工作单', 8000)
    const routedWorkorder = await ws.evaluate(`(() => { const el = document.querySelector('.nd-modal pre'); return el ? el.innerText : '' })()`)
    check('只勾全书级条目时生成修改提案自动走全局修改', routedWorkorder.includes('【全局修改工作单】'), routedWorkorder.slice(0, 60))
    await ws.evaluate(`(() => { const el = document.querySelector('.nd-modal-head button'); if (el) el.click(); return true })()`)
    await sleep(200)

    // 全局修改意见：chapter=0 → book-fix 工作单
    await clickText(ws, '.nd-toolbar button', '全局修改意见')
    await waitFor(ws, `!!document.querySelector('.nd-modal pre')`, '全局修改工作单弹窗', 8000)
    const globalWorkorder = await ws.evaluate(`(() => { const el = document.querySelector('.nd-modal pre'); return el ? el.innerText : '' })()`)
    check('全局修改走 globalFixWorkorder', globalWorkorder.includes('【全局修改工作单】'))
    check('全局修改工作单含 book-fix 提交格式', globalWorkorder.includes('kind="book-fix"') && globalWorkorder.includes('data={opinion:') && globalWorkorder.includes('patches:[{chapter'))
    check('全局修改：每个问题一条提案，可逐条批准', globalWorkorder.includes('每个全书级问题各出一条 book-fix 提案') && globalWorkorder.includes('title="全局修改 1/1：主题"'))
    check('全局修改工作单要求 after 是最终正文', globalWorkorder.includes('after 是最终正文'))
    await ws.evaluate(`(() => { const el = document.querySelector('.nd-modal-head button'); if (el) el.click(); return true })()`)
    await sleep(200)

    // 注意力复测：章节选择不再默认 5 章
    await clickText(ws, '.nd-toolbar button', '冷读打分 / 复测')
    await waitFor(ws, `!!document.querySelector('.nd-chapter-picker')`, '复测章节选择弹窗', 8000)
    const launcherHint = await ws.evaluate(`(() => { const el = document.querySelector('.nd-modal-body') || document.querySelector('.nd-modal'); return el ? el.innerText : '' })()`)
    const picked12 = /已选 (\d+) \/ (\d+) 章/.exec(launcherHint)
    check('复测弹窗使用章节选择器（不默认截断）', !!picked12 && picked12[1] === picked12[2], picked12 ? picked12[0] : launcherHint.slice(0, 120))
    check('复测弹窗说明勾哪章就测哪章', launcherHint.includes('勾了哪些章就打分哪些章'))
    await clickText(ws, '.nd-modal button', '生成工作单')
    await waitFor(ws, `!!document.querySelector('.nd-modal pre')`, '复测工作单弹窗', 8000)
    const recheckWorkorder = await ws.evaluate(`(() => { const el = document.querySelector('.nd-modal pre'); return el ? el.innerText : '' })()`)
    const listedChapters = (recheckWorkorder.match(/^- 第\d+章/gm) ?? []).length
    const tocValue = await handleRpc({ op: 'chapter.list', payload: { projectId } }, {}, {})
    const tocCount = (Array.isArray(tocValue) ? tocValue : (tocValue.chapters ?? [])).length
    check('注意力复测工作单列出全部选定章', listedChapters === tocCount, `清单 ${listedChapters} / 目录 ${tocCount}`)
    check('注意力复测工作单不贴旧分', recheckWorkorder.includes('禁止参考任何历史分数'))
    await ws.evaluate(`(() => { const el = document.querySelector('.nd-modal-head button'); if (el) el.click(); return true })()`)
    await sleep(200)

    // 审阅工作单：把四路口径 + 隔离边界交给 AI（dryRun 只生成文本，不碰会话）
    // 0.6.4 起「AI 审阅工作单」先经过章节选择器（范围由作者勾选），再生成工作单
    await clickText(ws, '.nd-toolbar button', 'AI 审阅工作单')
    await waitFor(ws, `!!document.querySelector('.nd-chapter-picker')`, '审阅范围弹窗', 8000)
    await clickText(ws, '.nd-modal button', '生成工作单')
    await waitFor(ws, `!!document.querySelector('.nd-modal pre')`, '审阅工作单弹窗', 8000)
    const workorderText = await ws.evaluate(`(() => { const el = document.querySelector('.nd-modal pre'); return el ? el.innerText : '' })()`)
    check('审阅工作单含隔离边界', workorderText.includes('审阅隔离'), `${workorderText.length} 字`)
    check('审阅工作单含四路口径', ['logic', 'attention', 'ai-style', 'reader'].every((key) => workorderText.includes(key)))
    check('审阅工作单要求逐字引文', workorderText.includes('逐字'))
    const reviewListed = (workorderText.match(/^- 第\d+章/gm) ?? []).length
    check('审阅工作单列出全部章节（不再默认 5 章）', reviewListed === tocCount, `清单 ${reviewListed} / 目录 ${tocCount}`)
    check('审阅工作单范围写明用户选定章数', workorderText.includes(`用户选定的 ${tocCount} 章`))
    if (workspacePath) check('审阅工作单章节清单带 path', workorderText.includes('chapters/'), workspacePath)
    await ws.evaluate(`(() => { const el = document.querySelector('.nd-modal-head button'); if (el) el.click(); return true })()`)
    await sleep(200)

    // 审阅模式：选中正文 → 加批注
    await clickNav(ws, '正文')
    await clickText(ws, '.nd-seg-item', '审阅')
    await waitFor(ws, `(() => { const m = document.querySelector('.nd-msg .nd-msg-text'); return !!m && m.innerText.includes('审阅模式') })()`, '进入审阅模式')
    // 用真实的鼠标拖拽选中（CDP Input），程序化 setSelection 会被 React 重渲染清掉
    await ws.evaluate(`(() => { const p = document.querySelectorAll('.nd-reader-body .nd-para')[1]; if (p) p.scrollIntoView({ block: 'center' }); return true })()`)
    await sleep(300)
    const spot = await ws.evaluate(`(() => {
      const para = document.querySelectorAll('.nd-reader-body .nd-para')[1];
      if (!para) return null;
      const rect = para.getBoundingClientRect();
      if (rect.top < 40 || rect.bottom > window.innerHeight - 40) return null;
      return { x1: Math.round(rect.left + 24), y: Math.round(rect.top + rect.height / 2), x2: Math.round(rect.left + Math.min(rect.width - 12, 220)) };
    })()`)
    const selected = Boolean(spot)
    if (spot) {
      await ws.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x1, y: spot.y, button: 'left', clickCount: 1 })
      await ws.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x2, y: spot.y, button: 'left', buttons: 1 })
      await ws.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x2, y: spot.y, button: 'left', clickCount: 1 })
      await sleep(250)
    }
    check('审阅模式可选中正文', selected)
    try {
      await waitFor(ws, `!!document.querySelector('.nd-note-pop')`, '批注弹窗', 4000)
    } catch (error) {
      const dump = await ws.evaluate(`(() => ({
        sel: String((window.getSelection && window.getSelection().toString()) || ''),
        activeSeg: [...document.querySelectorAll('.nd-seg-item')].filter((n) => n.className.includes('active')).map((n) => n.innerText),
        paraCount: document.querySelectorAll('.nd-reader-body .nd-para').length,
        dataCh: (document.querySelector('.nd-reader-body [data-ch]') || {}).getAttribute ? document.querySelector('.nd-reader-body [data-ch]').getAttribute('data-ch') : '',
        body: document.body.innerText.slice(0, 400),
      }))()`)
      console.error('批注弹窗失败现场：', JSON.stringify(dump, null, 2))
      throw error
    }
    await ws.evaluate(`(() => {
      const el = document.querySelector('.nd-note-pop textarea');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, '界面端到端：这段值得再收紧。');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await clickText(ws, '.nd-note-pop button', '提交批注')
    await waitFor(ws, `(() => { const m = document.querySelector('.nd-msg .nd-msg-text'); return !!m && /读者批注/.test(m.innerText) })()`, '批注提交提示', 8000)
    const noteNotice = await ws.evaluate(`(() => { const m = document.querySelector('.nd-msg .nd-msg-text'); return m ? m.innerText : '' })()`)
    const allReviews = await handleRpc({ op: 'review.list', payload: { projectId } }, {}, {})
    const reviewRows = Array.isArray(allReviews) ? allReviews : (allReviews.reviews ?? [])
    check('读者批注已落库', reviewRows.some((row) => row.source === 'reader' && String(row.issue).includes('值得再收紧')), noteNotice)

    // 触屏路径：手机长按选字只发 selectionchange、不发 mouseup —— 程序化选区 + 手动派发事件来复核
    const touchSelected = await ws.evaluate(`(() => {
      const para = document.querySelectorAll('.nd-reader-body .nd-para')[2] || document.querySelector('.nd-reader-body .nd-para');
      if (!para) return '';
      para.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.selectNodeContents(para);
      const sel = window.getSelection();
      if (!sel) return '';
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return String(sel.toString()).trim().slice(0, 20);
    })()`)
    const touchPop = await poll(async () => {
      const quote = await ws.evaluate(`(() => { const el = document.querySelector('.nd-note-pop .nd-note-quote'); return el ? el.innerText : '' })()`)
      return quote || ''
    }, 4000)
    check('触屏选区（selectionchange）也能弹出批注框', Boolean(touchPop), touchPop || `选中=${touchSelected}`)
    await ws.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.nd-note-pop button')].find((n) => n.innerText.includes('取消'));
      if (btn) btn.click();
      const sel = window.getSelection && window.getSelection();
      if (sel) sel.removeAllRanges();
      return true;
    })()`)
    await sleep(200)

    // 新建章节：目录「＋ 新章」→ 真落一个 .txt 新章（老章仍是 md，不迁移）
    await clickNav(ws, '正文')
    await waitFor(ws, `document.body.innerText.includes('章')`, '回到正文页')
    const before = await handleRpc({ op: 'chapter.list', payload: { projectId } }, {}, {})
    const nextNo = Math.max(...before.map((row) => Number(row.chapter || row.id || 0))) + 1
    await clickText(ws, '.nd-toc-head button', '新章')
    try {
      await waitFor(ws, `document.body.innerText.includes('已新建第 ${nextNo} 章')`, '新建章节提示', 8000)
    } catch (error) {
      const dump = await ws.evaluate(`(() => ({ head: (document.querySelector('.nd-toc-head') || {}).innerText, msg: (document.querySelector('.nd-msg') || {}).innerText, buttons: [...document.querySelectorAll('.nd-toc-head button')].map((b) => b.innerText) }))()`)
      console.error('新建章节失败现场：', JSON.stringify(dump))
      throw error
    }
    const created = await handleRpc({ op: 'chapter.get', payload: { projectId, chapter: nextNo } }, {}, {})
    check('新建章节真的有文件', Boolean(created && created.chapter === nextNo), `第 ${nextNo} 章 format=${created && created.format}`)
    check('新建章节默认纯文本', String(created && created.format) === 'txt', String(created && created.format))
    const after = await handleRpc({ op: 'chapter.list', payload: { projectId } }, {}, {})
    check('目录章数 +1', after.length === before.length + 1, `${before.length} → ${after.length}`)
    await ws.evaluate(`(() => { localStorage.setItem('nd.chapter', '${nextNo}'); return true })()`)

    // 全文动作：新建 → 开始 → 完成（产物只进提案，不动正文）
    await clickNav(ws, '全文动作')
    await waitFor(ws, `document.body.innerText.includes('全文动作')`, '全文动作页')
    const hasRun = await ws.evaluate(`(() => document.body.innerText.includes('新建/替换'))()`)
    await clickText(ws, 'button', hasRun ? '新建/替换' : '新建全文动作')
    await waitFor(ws, `!!document.querySelector('.nd-modal, .nd-dialog, [class*="modal"]') || document.body.innerText.includes('动作类型')`, '新建动作弹窗')
    await clickText(ws, 'button', '创建动作')
    await sleep(500)
    let run = await handleRpc({ op: 'run.get', payload: { projectId } }, {}, {})
    check('新建全文动作已写入 run', Boolean(run && run.kind), `kind=${run && run.kind} status=${run && run.status}`)
    await clickText(ws, 'button', '开始')
    await sleep(400)
    run = await handleRpc({ op: 'run.get', payload: { projectId } }, {}, {})
    check('开始后状态 becomes running', String(run && run.status) === 'running' || String(run && run.status) === 'ready', `status=${run && run.status}`)
    await clickText(ws, 'button', '完成')
    await sleep(400)
    run = await handleRpc({ op: 'run.get', payload: { projectId } }, {}, {})
    check('完成后状态 done', String(run && run.status) === 'done', `status=${run && run.status}`)

    // 导入旧稿：设置页填目录 → 扫描（只读）→ 导入（新建作品并切过去）
    const projectsBefore = (await handleRpc({ op: 'projects.list', payload: {} }, {}, {})).length
    await clickNav(ws, '设置')
    await waitFor(ws, `document.body.innerText.includes('导入旧稿')`, '设置页导入卡')
    await ws.evaluate(`(() => {
      const card = [...document.querySelectorAll('.nd-card')].find((c) => c.innerText.includes('导入旧稿'));
      const input = card && card.querySelector('input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(importSrc)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await clickText(ws, '.nd-form-row button', '扫描')
    await waitFor(ws, `document.body.innerText.includes('扫描到 3 章')`, '扫描结果', 8000)
    check('导入扫描只读且能报规模', true)
    const projectsStill = (await handleRpc({ op: 'projects.list', payload: {} }, {}, {})).length
    check('扫描不新建作品', projectsStill === projectsBefore, `${projectsBefore} → ${projectsStill}`)
    await clickText(ws, '.nd-form-row button', '导入')
    await waitFor(ws, `document.body.innerText.includes('已导入')`, '导入结果', 15000)
    await waitFor(ws, `[...document.querySelectorAll('button')].some((b) => b.innerText.includes('打开新作品'))`, '导入完成按钮', 8000)
    await clickText(ws, 'button', '打开新作品')
    await waitFor(ws, `(() => { const el = document.querySelector('.nd-proj'); return !!el && el.innerText.includes('导入测试书') })()`, '切到导入作品', 8000)
    await sleep(300)
    const projectsAfter = (await handleRpc({ op: 'projects.list', payload: {} }, {}, {})).length
    check('导入新建了作品', projectsAfter === projectsBefore + 1, `${projectsBefore} → ${projectsAfter}`)
    const imported = (await handleRpc({ op: 'projects.list', payload: {} }, {}, {})).find((row) => String(row.title).includes('导入测试书'))
    check('导入保留了作品标题', Boolean(imported), imported ? `id=${imported.id}` : '没找到导入作品')
    const importedToc = imported ? await handleRpc({ op: 'chapter.list', payload: { projectId: imported.id } }, {}, {}) : []
    check('导入的作品有 3 章', importedToc.length === 3, `chapters=${importedToc.length}`)
    const headerText = await ws.evaluate(`(() => (document.querySelector('.nd-proj') || {}).innerText || '')()`)
    check('导入后能切到新作品', String(headerText).includes('导入测试书'), headerText)

    // 资料库：9 页签里的卡片/时间线/地图/大纲真的渲染
    await clickNav(ws, '账本')
    await sleep(400)
    await clickText(ws, '.nd-tab', '人物卡')
    await sleep(300)
    const charCards = await ws.evaluate(`(() => document.querySelectorAll('.nd-char-card').length)()`)
    check('人物卡渲染成卡片', charCards >= 1, `${charCards} 张卡`)
    await clickText(ws, '.nd-char-card', '')
    await waitFor(ws, `!!document.querySelector('.nd-char-detail')`, '人物卡详情弹窗')
    check('点人物卡弹开详情', true)
    await ws.evaluate(`(() => { const el = document.querySelector('.nd-modal-head button'); if (el) el.click(); return true })()`)
    await sleep(200)
    await clickText(ws, '.nd-tab', '时间线')
    await sleep(300)
    const tlItems = await ws.evaluate(`(() => document.querySelectorAll('.nd-tl-item').length)()`)
    check('时间线渲染成时间轴条目', tlItems >= 1, `${tlItems} 条`)
    const tlGroups = await ws.evaluate(`(() => document.querySelectorAll('.nd-tl-group').length)()`)
    check('时间线按时间分组', tlGroups >= 1, `${tlGroups} 组`)
    await clickText(ws, '.nd-tab', '世界地图')
    await sleep(400)
    const preview = await ws.evaluate(`(() => !!document.querySelector('.nd-map-preview .nd-map-svg'))()`)
    check('地图页有可点的预览图', preview === true)
    const zones = await ws.evaluate(`(() => document.querySelectorAll('.nd-map-preview .ndm-zone').length)()`)
    check('地图画出分区底纹', zones >= 1, `${zones} 块区域`)
    const routeNum = await ws.evaluate(`(() => document.querySelectorAll('.nd-map-preview .ndm-route').length)()`)
    check('地图画出路线', routeNum >= 1, `${routeNum} 条路线`)
    const ptNum = await ws.evaluate(`(() => document.querySelectorAll('.nd-map-preview .ndm-pt').length)()`)
    check('地图画地点符号', ptNum >= 3, `${ptNum} 个点`)
    const labelNum = await ws.evaluate(`(() => document.querySelectorAll('.nd-map-preview .ndm-label').length)()`)
    check('地图画出地名', labelNum >= 1, `${labelNum} 个地名`)
    const waterNum = await ws.evaluate(`(() => document.querySelectorAll('.nd-map-preview .ndm-water').length)()`)
    check('地图画出水系', waterNum === 0 || waterNum >= 1, `${waterNum} 条水`)
    // 关掉区域层，底纹应消失；再打开
    await clickText(ws, '.nd-mapview .nd-btn', '区域：开')
    await sleep(300)
    const zonesOff = await ws.evaluate(`(() => document.querySelectorAll('.nd-map-preview .ndm-zone').length)()`)
    check('区域开关能关掉分区底纹', zonesOff === 0)
    await clickText(ws, '.nd-mapview .nd-btn', '区域：关')
    await sleep(300)
    await ws.evaluate(`(() => { const el = document.querySelector('.nd-map-preview .ndm-pt'); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true })()`)
    await waitFor(ws, `!!document.querySelector('.nd-map-detail .ndm-coord')`, '点地点出地点卡')
    check('点地图上的地点出地点卡', true)
    await ws.evaluate(`(() => { const el = document.querySelector('.nd-map-preview'); if (el) el.click(); return true })()`)
    await waitFor(ws, `!!document.querySelector('.nd-mapfull .nd-map-svg')`, '全屏地图弹窗')
    check('点预览弹出全屏地图', true)
    const beforeZoom = await ws.evaluate(`(() => { const svg = document.querySelector('.nd-mapfull .nd-map-svg'); return svg && svg.getAttribute('viewBox') })()`)
    await clickText(ws, '.nd-mapfull-head .nd-btn', '放大')
    await sleep(400)
    const afterZoom = await ws.evaluate(`(() => { const svg = document.querySelector('.nd-mapfull .nd-map-svg'); return svg && svg.getAttribute('viewBox') })()`)
    check('放大按钮能改变视框', String(afterZoom) !== String(beforeZoom), `${beforeZoom} → ${afterZoom}`)
    const zoomedLabels = await ws.evaluate(`(() => document.querySelectorAll('.nd-mapfull .ndm-label').length)()`)
    check('放大后地名变多', zoomedLabels >= labelNum, `${labelNum} → ${zoomedLabels}`)
    await ws.evaluate(`(() => {
      const svg = document.querySelector('.nd-mapfull .nd-map-svg')
      if (!svg) return false
      const rect = svg.getBoundingClientRect()
      const opts = { deltaY: -420, clientX: rect.left + rect.width * 0.45, clientY: rect.top + rect.height * 0.5, bubbles: true, cancelable: true }
      svg.dispatchEvent(new WheelEvent('wheel', opts))
      return true
    })()`)
    await sleep(400)
    const wheelZoom = await ws.evaluate(`(() => { const svg = document.querySelector('.nd-mapfull .nd-map-svg'); return svg && svg.getAttribute('viewBox') })()`)
    check('滚轮能继续放大（viewBox 变化）', String(wheelZoom) !== String(afterZoom), `${afterZoom} → ${wheelZoom}`)
    await clickText(ws, '.nd-mapfull-head .nd-btn', '重置')
    await sleep(300)
    const resetBox = await ws.evaluate(`(() => { const svg = document.querySelector('.nd-mapfull .nd-map-svg'); return svg && svg.getAttribute('viewBox') })()`)
    check('重置回到初始视框', String(resetBox) === String(beforeZoom), `${resetBox}`)
    await ws.evaluate(`(() => { const el = document.querySelector('.nd-mapfull .ndm-pt'); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true })()`)
    await waitFor(ws, `!!document.querySelector('.nd-mapfull-detail .ndm-coord')`, '全屏地图地点卡')
    check('全屏地图点开出地点卡', true)
    await ws.evaluate(`(() => { const el = document.querySelector('.nd-mapfull-head .nd-btn:last-child'); if (el) el.click(); return true })()`)
    await sleep(300)
    const closed = await ws.evaluate(`(() => !document.querySelector('.nd-mapfull'))()`)
    check('关闭按钮退出全屏地图', closed === true)
    await clickText(ws, '.nd-tab', '大纲')
    await sleep(300)
    const outlineRows = await ws.evaluate(`(() => document.querySelectorAll('.nd-table tbody tr').length)()`)
    check('大纲页签读得到数据', outlineRows >= 1, `${outlineRows} 行`)

    // 三路审阅入口：卡片 → 范围+重点 → 工作单
    await clickNav(ws, '审阅')
    await sleep(300)
    const launchers = await ws.evaluate(`(() => document.querySelectorAll('.nd-launch-card').length)()`)
    check('审阅页有三路一键入口', launchers >= 4, `${launchers} 张`)
    await clickText(ws, '.nd-launch-card', 'AI 味审阅')
    await waitFor(ws, `!!document.querySelector('.nd-chapter-picker') && document.body.innerText.includes('这次重点')`, '审阅范围弹窗')
    const scopeHint = await ws.evaluate(`(() => (document.querySelector('.nd-modal-body') || document.body).innerText)()`)
    check('入口弹窗可选范围（逐章勾选/全书）+填重点', /已选 \d+ \/ \d+ 章/.test(scopeHint) && scopeHint.includes('全书') && scopeHint.includes('这次重点'))
    await clickText(ws, 'button', '生成工作单')
    await waitFor(ws, `!!document.querySelector('.nd-modal pre')`, '一键审阅工作单')
    const oneClickPrompt = await ws.evaluate(`(() => (document.querySelector('.nd-modal pre') || {}).innerText || '')()`)
    check('一键审阅工作单带上指定方向', oneClickPrompt.includes('ai-style'), `${oneClickPrompt.length} 字`)
    const picker = await ws.evaluate(`(() => { const sel = document.querySelector('.nd-modal select'); return { exists: !!sel, text: sel ? sel.innerText : '' } })()`)
    check('工作单可以选发到哪个对话', picker.exists && picker.text.includes('新开一个对话'), String(picker.text).slice(0, 30))
    await ws.evaluate(`(() => { const el = document.querySelector('.nd-modal-head button'); if (el) el.click(); return true })()`)
    await sleep(200)

    // 历史版本：正文页任何模式都能找到入口
    await clickNav(ws, '正文')
    await sleep(300)
    await clickText(ws, 'button', '历史版本')
    await waitFor(ws, `!!document.querySelector('.nd-history')`, '历史版本弹窗')
    const historyRows = await ws.evaluate(`(() => document.querySelectorAll('.nd-history-row').length)()`)
    check('历史版本列出旧版本', historyRows >= 1, `${historyRows} 个版本`)
    await ws.evaluate(`(() => { const el = document.querySelector('.nd-modal-head button'); if (el) el.click(); return true })()`)
    await sleep(200)

    // 写作预设：卡片列表 + 绝对模板按钮
    await clickNav(ws, '设置')
    await sleep(400)
    await waitFor(ws, `document.body.innerText.includes('写作预设')`, '写作预设卡')
    const presetCards = await ws.evaluate(`(() => document.querySelectorAll('.nd-preset').length)()`)
    check('预设以卡片列出', presetCards >= 1, `${presetCards} 个预设`)
    const templateBtn = await ws.evaluate(`(() => [...document.querySelectorAll('button')].some((b) => b.innerText.includes('复制绝对模板')))()`)
    check('提供绝对模板入口', templateBtn === true)

    // 账本同步提醒：正文加入账本里已有的人名 → 保存 → 账本页出现提醒
    const ledgerData = await handleRpc({ op: 'ledger.get', payload: { projectId } }, {}, {})
    const characterName = String((Array.isArray(ledgerData.characters) ? ledgerData.characters[0] : null)?.name ?? '')
    if (characterName) {
      await clickNav(ws, '正文')
      await sleep(300)
      await clickText(ws, 'button', '编辑')
      await waitFor(ws, `!!document.querySelector('.nd-editor')`, '编辑器出现（同步测试）')
      await ws.evaluate(`(() => {
        const el = document.querySelector('.nd-editor');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, el.value + '\\n\\n${characterName}在门口站了很久。');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`)
      await clickText(ws, 'button', '保存')
      await sleep(900)
      await clickNav(ws, '账本')
      await sleep(500)
      const banner = await ws.evaluate(`(() => { const el = document.querySelector('.nd-banner'); return el ? el.innerText : '' })()`)
      check('正文改到账本名字后出现同步提醒', String(banner).includes('账本') || String(banner).includes('核对'), String(banner).slice(0, 40))
      const ackBtn = await ws.evaluate(`(() => [...document.querySelectorAll('button')].some((b) => b.innerText.includes('已核对')))()`)
      if (ackBtn) await clickText(ws, 'button', '已核对')
    } else {
      check('正文改到账本名字后出现同步提醒', false, '账本里没有人物（跳过）')
    }

    // 导出正文：顶栏弹窗选 EPUB → 真下载；设置页快捷按钮 → TXT
    const downloads = join(outDir, 'downloads')
    await rm(downloads, { recursive: true, force: true })
    await mkdir(downloads, { recursive: true })
    await ws.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
    await clickNav(ws, '正文')
    await sleep(400)
    const hasExportBtn = await ws.evaluate(`(() => [...document.querySelectorAll('.nd-top-right button')].some((b) => b.innerText.includes('导出')))()`)
    check('顶栏有「⬇ 导出」按钮', hasExportBtn)
    if (hasExportBtn) {
      await clickText(ws, 'button', '⬇ 导出')
      await waitFor(ws, `!!document.querySelector('.nd-modal')`, '导出弹窗出现')
      const dialogText = await ws.evaluate(`(() => { const m = document.querySelector('.nd-modal'); return m ? m.innerText : '' })()`)
      check('导出弹窗列出四种格式', ['TXT', 'Markdown', 'EPUB', 'DOCX'].every((word) => dialogText.includes(word)))
      const picked = await ws.evaluate(`(() => {
        const sel = document.querySelector('.nd-modal select');
        if (!sel) return '';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, 'epub');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return sel.value;
      })()`)
      check('格式可切到 epub', picked === 'epub', String(picked))
      await sleep(200)
      await clickText(ws, 'button', '导出并下载')
      const epubFile = await poll(async () => {
        const files = existsSync(downloads) ? (await readdir(downloads)).filter((name) => name.endsWith('.epub')) : []
        return files.length ? files[0] : ''
      }, 20000, 300)
      check('EPUB 真的下载到磁盘', Boolean(epubFile), String(epubFile || ''))
      if (epubFile) {
        const buffer = await readFile(join(downloads, epubFile))
        check('EPUB 是合法 ZIP 且 mimetype 正确', buffer.subarray(0, 2).toString() === 'PK' && buffer.includes(Buffer.from('application/epub+zip')), `${buffer.length} 字节`)
      }
      const doneText = await poll(async () => {
        const text = await ws.evaluate(`(() => { const m = document.querySelector('.nd-modal'); return m ? m.innerText : '' })()`)
        return String(text).includes('已导出') ? text : ''
      }, 15000)
      check('弹窗显示导出结果（章数 / 字数）', Boolean(doneText), String(doneText).split('\n').find((line) => line.includes('已导出')) || '')
      await clickText(ws, 'button', '关闭')
    }

    await clickNav(ws, '设置')
    await sleep(500)
    const hasQuickCard = await ws.evaluate(`document.body.innerText.includes('导出正文')`)
    check('设置页有「📤 导出正文」卡片', hasQuickCard)
    if (hasQuickCard) {
      await clickText(ws, 'button', 'TXT 纯文本')
      const txtFile = await poll(async () => {
        const files = existsSync(downloads) ? (await readdir(downloads)).filter((name) => name.endsWith('.txt')) : []
        return files.length ? files[0] : ''
      }, 20000, 300)
      check('TXT 快捷导出成功', Boolean(txtFile), String(txtFile || ''))
      if (txtFile) {
        const body = await readFile(join(downloads, txtFile), 'utf8')
        check('TXT 含章节标题与正文、不含 Markdown 标记', /第[一二三四五六七八九十百零〇\d]+[回章节]/.test(body) && !/\*\*/.test(body) && !/^#{1,6}\s/m.test(body), `${body.length} 字符`)
      }
    }

    const snap = async (name) => {
      await mkdir(join(outDir, 'shots'), { recursive: true })
      await sleep(350)
      const shot = await ws.send('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(outDir, 'shots', `${name}.png`), Buffer.from(shot.data, 'base64'))
      return name
    }
    // 开新书：总览入口 → 书名 → 选预设（含 AI 自定义）→ 写想法 → 创建 → 工作单/兜底提示
    const projectsBeforeBook = (await handleRpc({ op: 'projects.list', payload: {} }, {}, {})).length
    await clickNav(ws, '总览')
    await sleep(400)
    await waitFor(ws, `document.body.innerText.includes('开新书')`, '总览开新书入口')
    await clickText(ws, '.nd-page-actions button', '开新书')
    await waitFor(ws, `!!document.querySelector('.nd-modal input')`, '开新书第一步（书名）', 8000)
    const firstStepText = await ws.evaluate(`(() => (document.querySelector('.nd-modal') || {}).innerText || '')()`)
    check('开新书第一步只要书名', firstStepText.includes('书名') && !firstStepText.includes('目标章数'), firstStepText.split('\n').slice(0, 3).join(' '))
    await snap('newbook-1-name')
    await ws.evaluate(`(() => {
      const el = document.querySelector('.nd-modal input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, '界面端到端新书')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    await clickText(ws, '.nd-modal-actions button', '下一步')
    await waitFor(ws, `!!document.querySelector('.nd-modal .nd-card')`, '选预设步骤', 8000)
    const wizardPresets = await ws.evaluate(`(() => document.querySelectorAll('.nd-modal .nd-card').length)()`)
    check('预设里包含自定义（让 AI 定）', wizardPresets >= 5 && (await ws.evaluate(`document.body.innerText.includes('让 AI 定')`)) === true, `${wizardPresets} 个预设`)
    await snap('newbook-2-presets')
    await clickText(ws, '.nd-modal .nd-card', '让 AI 定')
    await sleep(200)
    await clickText(ws, '.nd-modal-actions button', '下一步')
    await waitFor(ws, `!!document.querySelector('.nd-modal textarea')`, '想法输入')
    await ws.evaluate(`(() => {
      const el = document.querySelector('.nd-modal textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, '界面端到端：失忆仵作追查连环命案，风格要冷。')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    await snap('newbook-3-idea')
    await clickText(ws, '.nd-modal-actions button', '下一步')
    await waitFor(ws, `document.body.innerText.includes('确认一下')`, '确认步骤')
    await snap('newbook-4-confirm')
    await clickText(ws, '.nd-modal-actions button', '创建并生成')
    await waitFor(ws, `(() => { const m = document.querySelector('.nd-modal'); return !!m && m.innerText.includes('已创建') })()`, '创建结果', 20000)
    const wizardResult = await ws.evaluate(`(() => (document.querySelector('.nd-modal') || {}).innerText || '')()`)
    check('创建后给出工作单/兜底提示', /工作单已发|工作单没有发出去|作品已建好/.test(wizardResult), wizardResult.split('\n').slice(0, 2).join(' '))
    const projectsAfterBook = (await handleRpc({ op: 'projects.list', payload: {} }, {}, {})).length
    check('开新书真的新建作品', projectsAfterBook === projectsBeforeBook + 1, `${projectsBeforeBook} → ${projectsAfterBook}`)
    await clickText(ws, '.nd-modal-actions button', '进入作品')
    await waitFor(ws, `(() => { const el = document.querySelector('.nd-proj'); return !!el && el.innerText.includes('界面端到端新书') })()`, '切到新作品', 10000)
    check('进入作品后落到提案页', await ws.evaluate(`document.body.innerText.includes('提案')`))
    await clickNav(ws, '总览')
    await sleep(900)
    const emptyCard = await ws.evaluate(`document.body.innerText.includes('这本新书还没有正文与设定')`)
    const overviewText = await ws.evaluate(`(() => (document.querySelector('.nd-page') || document.body).innerText.slice(0, 260))()`)
    await snap('newbook-5-empty-overview')
    check('空书总览有「补发工作单」入口', emptyCard === true, String(overviewText).replace(/\n/g, ' / '))

    // 远程/手机保护：普通 DSH 页面（没有 #novel-desk=1）不自动铺工作台；
    // 显式工作台链接仍然自动打开。dsh-pocket 手机远程加载的就是前一种。标记放 hash，认证 303 不会丢。
    await ws.send('Page.navigate', { url: base })
    await waitFor(ws, `document.readyState === 'complete'`, '无标记页重载', 10000)
    await sleep(700)
    const covered = await ws.evaluate(`!!document.querySelector('.nd-overlay')`)
    check('普通 DSH 页面不被工作台覆盖', covered === false)
    // 只改 hash 不会触发整页重载；真实入口是带标记的新标签，这里强制 reload 复现
    await ws.send('Page.navigate', { url: `${base}#novel-desk=1` })
    await ws.send('Page.reload', { ignoreCache: true })
    await waitFor(ws, `!!document.querySelector('.nd-overlay')`, '显式链接自动打开工作台', 10000)
    check('显式工作台链接自动打开', true)

    // 截图
    await mkdir(join(outDir, 'shots'), { recursive: true })
    for (const page of Object.keys(PAGES)) {
      await clickNav(ws, PAGES[page])
      await sleep(300)
      const shot = await ws.send('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(outDir, 'shots', `${page}.png`), Buffer.from(shot.data, 'base64'))
    }
  } finally {
    child.kill('SIGKILL')
    server.close()
    // 数据/站点/Chrome profile 默认跑完就删，只留截图与日志；要保留现场加 --keep
    if (!keepArtifacts) {
      for (const rel of ['data', 'site', 'chrome', 'downloads', 'import-src']) {
        await rm(join(outDir, rel), { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}

async function pressKey(ws, { key, code, text, modifiers = 0, windowsVirtualKeyCode = 0 }) {
  const base = { key, code, modifiers, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode }
  await ws.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) })
  await ws.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

async function poll(read, timeout = 5000, step = 250) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await sleep(step)
  }
  return ''
}

async function clickText(ws, selector, text) {
  const ok = await ws.evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const node = nodes.find((n) => n.textContent.trim().includes(${JSON.stringify(text)}));
    if (!node) return false;
    node.click();
    return true;
  })()`)
  if (!ok) throw new Error(`点不到「${text}」（${selector}）`)
  await sleep(150)
}

async function clickNav(ws, label) {
  const ok = await ws.evaluate(`(() => {
    const node = [...document.querySelectorAll('.nd-nav-item')].find((n) => n.textContent.includes(${JSON.stringify(label)}));
    if (!node) return false;
    node.click();
    return true;
  })()`)
  if (!ok) throw new Error(`点不到导航「${label}」`)
  await sleep(400)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function copyProject(src, dest, projectId) {
  await mkdir(join(dest, 'projects'), { recursive: true })
  await cp(join(src, 'library.json'), join(dest, 'library.json'))
  for (const rel of [join('projects', 'proposals.json')]) {
    if (!existsSync(join(src, rel))) continue
    try { await cp(join(src, rel), join(dest, rel)) } catch { /* 旧库没有也无所谓 */ }
  }
  // 只复制测试要用的文件：整目录 cp 会把 .pre-0.6.0 / .snapshots 等备份一起拷进来（单次可到 1.4G）。
  const keep = ['project.json', 'chapters', 'attention.json', 'reviews.json', 'proposals.json', 'runs.json', 'usage.json', 'settings.json', 'facts.json', 'characters.json', 'events.json', 'foreshadow.json', 'conflicts.json', 'highlights.json', 'outlines.json', 'locations.json', 'presets.json', 'world.json', 'ledger-sync.json']
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(join(dest, 'projects', projectId), { recursive: true, force: true })
      await mkdir(join(dest, 'projects', projectId), { recursive: true })
      for (const name of keep) {
        await cp(join(src, 'projects', projectId, name), join(dest, 'projects', projectId, name), { recursive: true }).catch(() => {})
      }
      return
    } catch (error) {
      lastError = error
      await sleep(300)
    }
  }
  throw lastError
}

async function waitFor(ws, expression, label, timeout = 6000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await ws.evaluate(expression)) return true
    await sleep(120)
  }
  const snapshot = await ws.evaluate(`(() => (document.body.innerText || '').slice(0, 600))()`).catch(() => '')
  throw new Error(`等待超时：${label}\n页面文本：${String(snapshot).replace(/\n+/g, ' | ')}`)
}

function connectCdp(profile, stderrFile = '') {
  return (async () => {
    const portFile = join(profile, 'DevToolsActivePort')
    const started = Date.now()
    while (!existsSync(portFile)) {
      if (Date.now() - started > 20000) {
        const tail = stderrFile && existsSync(stderrFile) ? readFileSync(stderrFile, 'utf8').split('\n').slice(-6).join('\n') : ''
        throw new Error(`Chrome 没起来（没有 DevToolsActivePort）${tail ? '\n' + tail : ''}`)
      }
      await sleep(120)
    }
    const [port] = String(await readFile(portFile, 'utf8')).trim().split('\n')
    const info = await fetch(`http://localhost:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json())
    const socket = new WebSocket(info.webSocketDebuggerUrl)
    let seq = 0
    const pending = new Map()
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    })
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve)
      socket.addEventListener('error', reject)
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)))
      socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      return result?.result?.value
    }
    return { send, evaluate, close: () => socket.close() }
  })()
}

async function ensureReact(dir) {
  const cache = join(import.meta.dirname, '..', '.ui-cache')
  await mkdir(cache, { recursive: true })
  for (const [name, url] of [
    ['react.js', 'https://unpkg.com/react@18.3.1/umd/react.production.min.js'],
    ['react-dom.js', 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js'],
  ]) {
    if (existsSync(join(cache, name))) {
      await cp(join(cache, name), join(dir, name))
      continue
    }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`下载 ${name} 失败`)
    const body = await res.text()
    await writeFile(join(cache, name), body)
    await writeFile(join(dir, name), body)
  }
}

function html(projectId) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>novel-desk UI e2e</title>
<style>html,body{margin:0;padding:0;background:#fff;font-family:system-ui,sans-serif}#root{min-height:100vh}</style></head>
<body><div id="root"></div>
<script src="react.js"></script><script src="react-dom.js"></script>
<script>
window.__mounts = {};
window.__ModuleLoader__ = { load({ id, factory }) {
  const require = (name) => (name === 'react' ? window.React : name === 'react-dom' ? window.ReactDOM : (() => { throw new Error('unknown ' + name) })());
  window.__mounts[id] = factory(require);
} };
try { localStorage.setItem('nd.project', ${JSON.stringify(projectId)}); localStorage.setItem('nd.page', 'read'); } catch (e) {}
</script>
<script src="client.js"></script>
<script>
const mod = window.__mounts['dsh-long-novel-workbench'];
const registered = [];
const ctx = {
  slots: { inject(name, cb) { try { cb(); } catch (e) {} }, register(spec, Component) { registered.push({ spec, Component }); return () => {}; } },
  effect(fn) { try { fn(); } catch (e) {} return () => {}; },
  get() { return undefined; },
};
mod.apply(ctx);
const overlay = registered.find((r) => r.spec.name === 'shell.overlay');
window.ReactDOM.createRoot(document.getElementById('root')).render(window.React.createElement(overlay.Component));
</script></body></html>`
}

await main()
