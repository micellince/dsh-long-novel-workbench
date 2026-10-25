/**
 * client.js 静态与装配测试。
 *
 * 不启动浏览器、不连宿主、不写 ~/StoryDesk：只读源码 + 在假的 window/document 环境里
 * 跑一次 __ModuleLoader__ 装配，验证 7 页、34 op 白名单、装配入口、样式注入与安全约定。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')
const indexSource = readFileSync(join(root, 'index.js'), 'utf8')

function parseOps() {
  const out = new Set()
  for (const name of ['READ_OPS', 'WRITE_OPS']) {
    const match = indexSource.match(new RegExp('export const ' + name + ' = \\[([\\s\\S]*?)\\]'))
    assert.ok(match, `index.js 缺少 ${name}`)
    for (const hit of match[1].matchAll(/'([a-z][a-z.]*)'/g)) out.add(hit[1])
  }
  return out
}

const CONTRACT_OPS = parseOps()
const USED_OPS = [...new Set([...source.matchAll(/api\('([a-z][a-z.]*)'/g)].map((m) => m[1]))]

function loadModule() {
  let manifest = null
  const appended = []
  const document = {
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild: (el) => appended.push(el) },
  }
  const window = {
    __ModuleLoader__: { load: (m) => { manifest = m } },
    __ND_BOOT__: { apiUrl: '/novel-desk/api', name: 'novel-desk', version: '0.6.1' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    getSelection: () => null,
    innerWidth: 1280,
    innerHeight: 800,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    confirm: () => true,
  }
  const react = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === '__esModule') return true
        return () => null
      },
    },
  )
  const require = (name) => {
    if (name === 'react') return react
    throw new Error(`client.js 不应 require 其他模块：${name}`)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'require', source)
  run(window, document, require)
  return { manifest, appended, require }
}

test('client.js 体积与入口', () => {
  const lines = source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length
  // 0.7 版把地图渲染改成「AI 方案 → 世界坐标直绘」，多了纯函数模型层；0.6.3 加全书账本同步 UI；0.6.4 加章节选择器 / 分章提案 / 全局修改 / 提案编辑，上限再放宽
  assert.ok(lines <= 6500, `client.js 超过 6500 行：${lines}`)
  assert.ok(source.includes('window.__ModuleLoader__.load('))
  assert.ok(source.includes("id: 'dsh-long-novel-workbench'"))
})

test('DSH Remote / 手机不被工作台覆盖：只有显式链接才自动展开', () => {
  assert.ok(source.includes('const IS_STANDALONE_TAB'), '要有显式链接标记判断')
  assert.ok(source.includes('novel-desk=1(?:&|$)'), '标记解析为 novel-desk=1（兼容 #page?novel-desk=1 形态）')
  assert.ok(source.includes('hasMarker(locate.hash) || hasMarker(locate.search)'), 'hash 标记优先，兼容旧 query 标记')
  assert.ok(!source.includes('(!IS_MOBILE || FORCE_OPEN_FOR_TEST)'), '显式链接不应再被手机/窄屏条件挡掉')
  const overlayReg = source.indexOf("name: 'shell.overlay', id: 'novel-desk'")
  const overlayTail = overlayReg >= 0 ? source.slice(overlayReg, overlayReg + 620) : ''
  assert.ok(overlayTail.includes('if (IS_STANDALONE_TAB) setOpen(true)'), '显式链接在桌面和手机都自动铺开')
  assert.ok(source.includes('nd-mobile-close'), '手机要有兜底关闭按钮')
  assert.ok(source.includes('@media (max-width: 900px)'), '要有窄屏响应式样式')
  assert.ok(source.includes("style.textContent = CSS + CSS_EXTRA + PAPER_CSS + MAP_CSS + MOBILE_CSS"), '手机样式要拼接进页面')
})

test('沉浸模式：只留阅读 / 编辑 / 审阅 + 退出，正文接近全屏', () => {
  assert.ok(source.includes("immersive: 'nd.immersive'"), '沉浸开关要持久化在 localStorage')
  assert.ok(source.includes("const [immersive, setImmersive] = useState(() => lsGet(LS.immersive, '0') === '1')"), '工作台持有沉浸状态')
  assert.ok(source.includes('const immersiveNow = immersive && page === \'read\''), '沉浸只在正文页生效')
  assert.ok(source.includes('nd-immersive'), '外壳要挂沉浸类名')
  assert.ok(source.includes('if (immersiveNow) return'), '沉浸里的 Esc 先退沉浸，不关工作台')
  assert.ok(source.includes('nd-im-exit'), '沉浸模式要留着退出入口')
  assert.ok(source.includes('nd-im-toggle'), '非沉浸模式要有进入入口')
  assert.ok(source.includes('e.stopImmediatePropagation()'), '正文页自己处理沉浸 Esc')
  // CSS：外壳收起 + 三颗按钮居中 + 正文铺满
  assert.ok(source.includes('.nd-immersive .nd-top,.nd-immersive .nd-principle-bar,.nd-immersive .nd-nav{display:none}'), '沉浸要收起顶栏/原则条/左导航')
  assert.ok(source.includes('.nd-immersive .nd-toc,.nd-immersive .nd-side,.nd-immersive .nd-mobile-close{display:none}'), '沉浸要收起目录/右栏/手机兜底关闭')
  assert.ok(source.includes('grid-template-columns:minmax(0,1fr) auto minmax(0,1fr)'), '三颗按钮居中')
  // 沉浸里的字号 −/+ 在顶栏（不能再贴底挡字）：只改 CSS 字号，不引入字体文件或网络字体
  assert.ok(source.includes('nd-im-left') && source.includes('nd-im-size-btn'), '沉浸顶栏要有字号 −/+ 控件')
  assert.ok(!source.includes('nd-im-sizer'), '不要再有贴底的字号胶囊')
  assert.ok(source.includes("bumpPref('size', -1, 13, 28)") && source.includes("bumpPref('size', 1, 13, 28)"), '字号 − / + 要接到现有偏好（上限 28px）')
  assert.ok(source.includes('touch-action:manipulation'), '手机点按不要 300ms 延迟')
  assert.ok(source.includes("grid-template-areas:'left exit' 'seg seg'"), '窄屏顶栏两行排布，字号控件始终在顶部')
  assert.ok(!/fonts\.googleapis|@font-face|\.woff2?/i.test(source), '不加载任何网络/打包字体')
})

test('仿纸正文底：阅读与编辑器共用同一张纸', () => {
  assert.ok(source.includes('const PAPER_CSS'), '仿纸样式要单独成段')
  assert.ok(source.includes('--nd-paper:#f7f2e6'), '要有纸色')
  assert.ok(source.includes('--nd-paper-ink:#3b352a'), '要有墨色（纸面文字不能跟主题走）')
  assert.ok(source.includes('.nd-reader-scroll{background-color:var(--nd-paper)'), '阅读区要用纸底')
  assert.ok(source.includes('.nd-editor{max-width:800px'), '编辑器要像阅读页一样居中成页')
  assert.ok(source.includes('style: { fontSize: `${prefs.size}px`, lineHeight: prefs.lead }'), '编辑器与阅读共用字号/行距')
  assert.ok(source.includes('font-family:inherit'), '编辑器不再用等宽字体')
  // 窄屏也要是纸底：移动端只调边距，不改背景
  assert.ok(source.includes('.nd-immersive .nd-reader-body{padding:18px 16px 76px}'), '窄屏沉浸正文边距')
  // 手机上点 +/− 只改数字不改字：窄屏 CSS 曾用 !important 把字号钉死
  assert.ok(!source.includes('font-size:15px!important'), '窄屏不能 !important 钉死字号，否则 −/+ 无效')
  assert.ok(source.includes('.nd-reader-body{padding:18px 16px 64px}'), '窄屏只调边距，字号/行距交给偏好')
})

test('手机审阅：长按选字只发 selectionchange，不能只靠 mouseup', () => {
  assert.ok(source.includes('const pickReaderSelection'), '鼠标 / 触屏共用同一个取选区入口')
  assert.ok(source.includes('document.addEventListener(\'selectionchange\', onSelectionChange)'), '要监听 selectionchange（iOS / Android 长按选字）')
  assert.ok(source.includes("document.addEventListener('touchend', onTouchEnd, { passive: true })"), '手指抬起后再兜一次')
  assert.ok(source.includes('if (cur && cur.quote === quote && cur.chapter === chapter) return'), '同一段别把作者刚输入的批注冲掉')
  assert.ok(source.includes('user-select:text'), '显式允许选中正文（宿主可能设了 user-select:none）')
  assert.ok(source.includes('审阅：选中文字 → 加批注'), '沉浸模式切到审阅要告诉作者怎么用')
  assert.ok(source.includes("window.innerWidth <= 900"), '窄屏批注框改成贴底面板')
})

test('阅读进度在 阅读 / 编辑 / 审阅 之间同步（不用从头找）', () => {
  assert.ok(source.includes('const readParagraphAnchor'), '要能从滚动位置算「正在读的段落」')
  assert.ok(source.includes('const scrollReaderToAnchor'), '要能把正文滚回某一段')
  assert.ok(source.includes('caretOffsetTop'), 'textarea 光标定位要能自己量纵向位置（固定浮层里浏览器不滚）')
  assert.ok(source.includes('pendingEditAnchor') && source.includes('pendingReadAnchor'), '模式切换要带位置锚点')
  assert.ok(source.includes('${LS.pos + projectId}.para'), '段落锚点要持久化（重开页面也回到同一段）')
  assert.ok(source.includes('const onScroll = useCallback'), '滚动时要更新锚点')
  assert.ok(source.includes('modeRef.current === \'edit\''), '切模式的瞬间不能让过渡滚动把锚点写歪')
  assert.ok(source.includes("spans[idx] ? spans[idx].start : 0"), '编辑器光标按段落起点落位')
})

test('7 个页面齐全（世界地图并入账本页签）', () => {
  const expected = [
    ['read', '正文'],
    ['reviews', '审阅'],
    ['proposals', '提案'],
    ['run', '全文动作'],
    ['ledger', '账本'],
    ['overview', '总览'],
    ['settings', '设置'],
  ]
  for (const [id, label] of expected) {
    assert.ok(source.includes(`id: '${id}'`), `缺少页面 ${id}`)
    assert.ok(source.includes(`label: '${label}'`), `缺少页面文案 ${label}`)
  }
  assert.ok(source.includes("lsGet(LS.page, 'read')"), '默认页应为正文')
})

test('只调用契约内的 41 个 op', () => {
  assert.equal(CONTRACT_OPS.size, 41, `契约 op 数应为 41，实际 ${CONTRACT_OPS.size}`)
  const unknown = USED_OPS.filter((op) => !CONTRACT_OPS.has(op))
  assert.deepEqual(unknown, [], `调用了契约外 op：${unknown.join(', ')}`)
  assert.ok(USED_OPS.length >= 20, `使用的 op 过少：${USED_OPS.length}`)
})

test('全文动作：从头写 / 扩写 / 改写细分 + 开工入口', () => {
  assert.match(source, /continue:\s*'从头写'/)
  assert.match(source, /RUN_VARIANT = \{ style: '文风'/)
  assert.ok(source.includes('从头写下一章'), '正文页要能直接开「从头写下一章」')
  assert.ok(source.includes('开工（发工作单）'), '全文动作页要有把 workorder 发进对话的入口')
  assert.ok(source.includes("workorder: 'runGoalPrompt'"), '开工会发 runGoalPrompt 工作单')
  assert.ok(source.includes('runStageTitles'), '阶段要按 kind/variant 取默认值')
  // 章号用数字输入（空书也能指定新章号），不再只靠 toc 下拉
  assert.ok(source.includes('例如 ${lastWritten + 1}') || source.includes('例如 '), '应支持手填章号')
})

test('章节删除：目录与正文页都有入口', () => {
  assert.ok(source.includes("api('chapter.delete'"), '要调用 chapter.delete')
  assert.ok(source.includes('删除本章'), '正文页要有删除本章')
  assert.ok(source.includes('nd-toc-del'), '目录行要有删除按钮')
  assert.ok(source.includes('deletingChapter'), '删除要有进行中状态，避免重复点')
})

test('导入：与导出并列，接受目录或单文件', () => {
  assert.ok(source.includes('📥 导入旧稿'), '设置页导入卡存在')
  assert.ok(source.includes('不要求 0001.md'), '导入文案要说明不挑命名')
  assert.ok(source.includes("'⬆ 导入'"), '顶栏要有导入入口')
  // 导入卡必须在导出卡之后、数据位置之前
  const exportIdx = source.indexOf('📤 导出正文')
  const importIdx = source.indexOf('📥 导入旧稿')
  const dataIdx = source.indexOf('📁 数据位置')
  assert.ok(exportIdx > 0 && importIdx > exportIdx, '导入应在导出之后')
  assert.ok(dataIdx > importIdx, '导入不应再沉到数据位置之后')
})

test('纯文本渲染，无危险注入', () => {
  assert.equal(/dangerouslySetInnerHTML/.test(source), false)
  assert.equal(/\.innerHTML\s*=/.test(source), false)
  assert.equal(/document\.write/.test(source), false)
  assert.equal(/\beval\(/.test(source), false)
})

test('提案页账本修订解析与 store 同口径（items 写法也能显示）', () => {
  const start = source.indexOf('const LEDGER_FIX_KINDS')
  const end = source.indexOf('const RUN_KIND')
  assert.ok(start > 0 && end > start, 'client.js 缺少 LEDGER_FIX_KINDS / proposalLedgerFixes 区块')
  const block = source.slice(start, end)
  const factory = new Function(`${block}\nreturn { proposalLedgerFixes, ledgerFixSummary }`)
  const { proposalLedgerFixes, ledgerFixSummary } = factory()

  // items=[{kind,id,patch}]（propose 工具写法）
  assert.deepEqual(proposalLedgerFixes({ items: [{ kind: 'characters', id: 'c1', patch: { name: '陈默' } }] }), [
    { kind: 'characters', id: 'c1', patch: { name: '陈默' } },
  ])
  // 规范写法 data.ledgerFixes
  assert.deepEqual(proposalLedgerFixes({ ledgerFixes: [{ kind: 'facts', patch: { text: 'x' } }] }), [{ kind: 'facts', patch: { text: 'x' } }])
  // 0.5 风格 data.kind + 裸 patch 列表
  assert.deepEqual(proposalLedgerFixes({ kind: 'events', items: [{ id: 'e1', title: '雨夜' }] }), [{ kind: 'events', patch: { id: 'e1', title: '雨夜' } }])
  // 空 / 非法输入
  assert.deepEqual(proposalLedgerFixes({ items: [] }), [])
  assert.deepEqual(proposalLedgerFixes(null), [])
  // 摘要：带类型与 id，正文截断
  assert.match(ledgerFixSummary({ kind: 'characters', id: 'c1', patch: { name: '陈默' } }), /^characters · c1 → /)
  assert.equal(ledgerFixSummary({ kind: 'facts', patch: { text: 'x'.repeat(400) } }).length < 300, true)
})


test('唯一网络入口与 boot 注入', () => {
  assert.equal((source.match(/fetch\(/g) || []).length, 1)
  assert.ok(source.includes("method: 'POST'"))
  assert.ok(source.includes('JSON.stringify({ op, payload'))
  assert.ok(source.includes('window.__ND_BOOT__'))
  assert.equal(/127\.0\.0\.1|localhost:\d+/.test(source), false, '不要写死宿主地址')
})

test('样式使用契约 token', () => {
  assert.ok((source.match(/var\(--dsw-alias-/g) || []).length > 50)
  assert.equal(/<style/.test(source), false, '应通过 document 注入样式，不要用内联 <style> 字符串')
})

test('装配：inject slots + 注册两个入口 + 样式注入', () => {
  const { manifest, appended, require } = loadModule()
  assert.ok(manifest, '__ModuleLoader__.load 未被调用')
  assert.equal(manifest.id, 'dsh-long-novel-workbench')
  assert.equal(typeof manifest.factory, 'function')
  const mod = manifest.factory(require)
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')

  const registered = []
  const effects = []
  const ctx = {
    effect: (fn, label) => {
      const cleanup = fn()
      effects.push([label, typeof cleanup])
      return cleanup
    },
    slots: {
      inject: (_name, cb) => cb(),
      register: (spec, comp) => registered.push({ name: spec.name, id: spec.id, order: spec.order, comp }),
    },
  }
  mod.apply(ctx)

  assert.equal(appended.length, 1)
  assert.ok(appended[0].textContent.length > 5000)
  assert.ok(appended[0].textContent.includes('.nd-read{'))
  // 2026-10 起：DSH 桌面壳里只留一个「在默认浏览器打开」的入口；浮层只在浏览器标签里挂。
  assert.deepEqual(registered.map((r) => r.name), ['sidebar.footer.action'])
  assert.deepEqual(registered.map((r) => r.id), ['novel-desk'])
  for (const entry of registered) assert.equal(typeof entry.comp, 'function', `${entry.name} 组件应为函数`)
  assert.equal(effects.length, 1)
})

test('空态与错误态文案', () => {
  for (const text of ['还没有', '加载', '失败', '重新加载', '删除']) {
    assert.ok(source.includes(text), `缺少文案：${text}`)
  }
})

// ── 0.6.4：审阅工作流回归（截断 / 确定性提案 / 章节选择 / 全书修改） ──

test('审阅列表不再只显示 5 条：filtered 不做 slice 截断', () => {
  // 旧实现把待处理审阅展示截到 5 条，导致 13 章里的多数审阅在界面上“消失”
  assert.equal(/filtered\.slice\(0, *\d+\)/.test(source), false, '审阅列表不能截断 filtered')
  assert.match(source, /filtered\.map\(\(rv\)/, '审阅列表必须全量渲染 filtered')
  assert.match(source, /这个筛选下没有审阅条目/, '空态仍要保留')
})

test('不再由界面确定性地生成提案：before 不得取 quote、after 不得取 suggestion', () => {
  // 旧实现直接 createProposals(before: review.quote, after: review.suggestion)，
  // 把「问题引文」当正文原文、把「修改建议」当成稿正文，提案必被闸门驳回。
  assert.equal(/createProposals/.test(source), false, '界面不能自己拼确定性提案')
  assert.equal(/(?:before\s*:\s*[A-Za-z_$][\w$.]*\.quote)/.test(source), false, 'before 不能直接取审阅 quote')
  assert.equal(/(?:after\s*:\s*[A-Za-z_$][\w$.]*\.suggestion)/.test(source), false, 'after 不能直接取审阅 suggestion')
  // 改法应来自 AI 工作单（界面只是发工作单 + 等提案）
  assert.match(source, /workorder: 'proposalGroupsWorkorder'/)
  assert.match(source, /workorder: 'globalFixWorkorder'/)
})

test('章节选择器：ChapterPicker 支持用户选任意章（含 13 章全选），不再默认 5 章', () => {
  assert.match(source, /function ChapterPicker\(/, '缺少 ChapterPicker 组件')
  assert.match(source, /h\(ChapterPicker, \{[^}]*chapters: allChapters/, '工作单弹窗要用章节选择器')
  // 组件内部按用户的 value 全量展示，不截断；全选/清空都基于完整章节列表
  const start = source.indexOf('function ChapterPicker(')
  const body = source.slice(start, start + 4000)
  assert.equal(/chapters\.slice\(0, *\d+\)/.test(body), false, '章节选择器不能截断可选章节')
  assert.match(body, /chapters\.map\(/, '章节选择器必须遍历全部章节')
  assert.match(body, /const picked = new Set\(value\)/, '选中集合来自用户选择')
  assert.match(body, /toggleChapter/, '支持逐章勾选 / 取消')
})

test('审阅页入口：生成修改提案 / 全局修改意见 / AI 审阅工作单 / 注意力复测', () => {
  for (const label of ['生成修改提案', '全局修改意见', 'AI 审阅工作单', '注意力复测']) {
    assert.ok(source.includes(label), `缺少入口「${label}」`)
  }
  // 审阅筛选包含 proposed（已进提案），否则提案中的条目会从列表消失
  assert.match(source, /value: 'proposed', label: '已进提案'/)
  assert.match(source, /proposed: '已进提案'/)
})

test('提案页契约：PROPOSAL_KIND 含 book-fix、支持 proposal.update 改法、注意力复测工作单', () => {
  assert.match(source, /const PROPOSAL_KIND = \{[^}]*'book-fix': '全书修改'/)
  assert.match(source, /api\('proposal\.update'/)
  // 勾选的书目级（chapter=0）条目不能只提示「先勾选」：生成修改提案要自动并进全局修改意见
  assert.match(source, /const global = picked\.filter\(\(rv\) => chapterNo\(rv\) === 0\)/)
  assert.match(source, /workorder: 'globalFixWorkorder', chapters: allChapters, reviews: global\.map\(cleanReview\)/)
  assert.match(source, /payload: \{ prompt: text \}/, '混合勾选时两条工作单要拼成一段 prompt 一起发')
  assert.match(source, /全书级 \$\{selectedGlobalCount\} 条/)
  assert.doesNotMatch(source, /全书级条目请用「全局修改意见」。/, '不能再让勾了全书级条目的人看到「先勾选」')
  // 保存改法后状态回到待批准
  assert.match(source, /状态回到待批准/)
  // 注意力复测走 chat.send dryRun 工作单，而不是只给最近 3 章
  assert.match(source, /workorder: 'attentionRecheckWorkorder'/)
  // 冷读打分说明不能丢：payload 必须把 launcher.focus 一起发出去
  assert.match(source, /workorder: 'attentionRecheckWorkorder', chapters, focus:/)
  assert.match(source, /冷读打分工作单（\$\{chapters\.length\} 章）/)
})
