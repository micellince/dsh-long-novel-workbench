/**
 * 小说工作台 0.6 · 客户端
 *
 * 全屏工作台：左侧导航（正文 / 意见 / 提案 / 全文动作 / 账本 / 总览 / 设置）。
 * React 由浏览器模块表提供，无构建、无外部依赖；正文一律纯文本渲染，禁止 Markdown 解析。
 * 所有数据走同源 RPC：POST /novel-desk/api，body { op, payload }。
 */

window.__ModuleLoader__.load({
  id: 'dsh-long-novel-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback, memo } = React
    const Fragment = React.Fragment

    // ── 常量 ──────────────────────────────────────────────────
    const LS = {
      project: 'nd.project',
      page: 'nd.page',
      mode: 'nd.mode',
      pos: 'nd.pos.',
      tocWidth: 'nd.toc',
      immersive: 'nd.immersive',
    }

    const PAGES = [
      { id: 'read', label: '正文', icon: '📖', group: '正文' },
      { id: 'outlines', label: '大纲', icon: '🧭', group: '正文' },
      { id: 'reviews', label: '意见', icon: '📝', group: '正文' },
      { id: 'proposals', label: '提案', icon: '📋', group: '正文' },
      { id: 'run', label: '全文动作', icon: '🛠️', group: '正文' },
      { id: 'ledger', label: '账本', icon: '🗂️', group: '资料' },
      { id: 'overview', label: '总览', icon: '📊', group: '系统' },
      { id: 'settings', label: '设置', icon: '⚙️', group: '系统' },
    ]
    const PAGE_LABEL = Object.fromEntries(PAGES.map((p) => [p.id, p.label]))

    const MODES = [
      { id: 'read', label: '阅读' },
      { id: 'edit', label: '编辑' },
      { id: 'reader', label: '批注' },
    ]

    const ROUTES = [
      { id: 'logic', label: '逻辑', icon: '🧩' },
      { id: 'attention', label: '注意力', icon: '⚡' },
      { id: 'ai-style', label: 'AI 味', icon: '🤖' },
      { id: 'reader', label: '读者', icon: '👀' },
    ]
    const ROUTE_LABEL = Object.fromEntries(ROUTES.map((r) => [r.id, r.label]))

    const SEVERITIES = [
      { id: 'blocker', label: '阻断', tone: 'error' },
      { id: 'major', label: '严重', tone: 'warn' },
      { id: 'minor', label: '轻微', tone: 'muted' },
      { id: 'suggestion', label: '建议', tone: 'muted' },
    ]
    const SEV_LABEL = Object.fromEntries(SEVERITIES.map((s) => [s.id, s.label]))
    const SEV_TONE = Object.fromEntries(SEVERITIES.map((s) => [s.id, s.tone]))

    const REVIEW_STATUS = { open: '待处理', fixed: '已修复', wontfix: '不修', archived: '已归档', proposed: '已进提案' }
    const PROPOSAL_KIND = { 'patch-paragraph': '段落补丁', 'rewrite-chapter': '整章重写', 'ledger-fix': '账本修订', 'book-fix': '全书修改' }
    const PROPOSAL_KINDS = Object.keys(PROPOSAL_KIND)
    const PROPOSAL_STATUS = { pending: '待批准', accepted: '已采纳', rejected: '已驳回', revised: '已修订', 'needs-fix': '未通过闸门' }
    // 账本修订项：与 lib/store.js 的 ledgerFixesOf 同口径，兼容 data.ledgerFixes / data.items / data.kind+items
    const LEDGER_FIX_KINDS = ['world', 'facts', 'characters', 'events', 'locations', 'foreshadow', 'conflicts', 'highlights', 'outlines', 'presets']
    function proposalLedgerFixes(data) {
      const payload = data && typeof data === 'object' ? data : {}
      const declared = LEDGER_FIX_KINDS.includes(String(payload.kind || '')) ? String(payload.kind) : ''
      const rows = Array.isArray(payload.ledgerFixes) ? payload.ledgerFixes : Array.isArray(payload.items) ? payload.items : []
      const patchOf = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null)
      if (rows.length === 0) {
        if (declared && patchOf(payload.patch)) return [{ kind: declared, patch: patchOf(payload.patch) }]
        return []
      }
      const bare = Boolean(declared) && rows.every((row) => !(patchOf(row) && (patchOf(row.patch) || patchOf(row.item))))
      return rows.map((row) => {
        const item = patchOf(row) || {}
        if (bare) return { kind: declared, patch: item }
        const kind = String(item.kind || '')
        const patch = patchOf(item.patch) || patchOf(item.item)
        if (patch) return { ...item, kind, patch }
        const rest = { ...item }
        delete rest.kind
        return { kind, patch: rest }
      })
    }
    function ledgerFixSummary(fix) {
      const text = JSON.stringify(fix.patch || {})
      const label = fix.id || fix.patch?.id || fix.patch?.name || fix.patch?.title || fix.patch?.subject || ''
      return `${fix.kind || '?'}${label ? ` · ${label}` : ''} → ${text.length > 240 ? `${text.slice(0, 240)}…` : text}`
    }
    const RUN_KIND = { continue: '从头写', expand: '扩写', rewrite: '改写', rephrase: '改写' }
    const RUN_VARIANT = { style: '文风', logic: '逻辑与事实', structure: '结构与节奏' }
    const RUN_STATUS = { idle: '未开始', preparing: '准备中', ready: '已就绪', running: '进行中', paused: '已暂停', done: '已完成', failed: '失败' }
    const RUN_STATUS_TONE = { idle: 'muted', preparing: 'brand', ready: 'brand', running: 'ok', paused: 'warn', done: 'ok', failed: 'error' }
    const DEFAULT_STAGES = {
      continue: ['先定注意力设计', '读大纲与账本', '规划本章场景', '逐章写作', '闸门校验', '本章自检'],
      expand: ['先定注意力设计', '定位扩写点', '生成扩写方案', '逐章扩写', '闸门校验'],
      'rewrite:style': ['先定注意力设计', '文风校准', '逐章改写', '闸门校验'],
      'rewrite:logic': ['先定注意力设计', '通读与事实核对', '生成改写方案', '逐章重写', '闸门校验'],
      'rewrite:structure': ['先定注意力设计', '结构梳理', '生成结构调整方案', '逐章重构', '闸门校验'],
      rewrite: ['先定注意力设计', '通读与事实核对', '生成改写方案', '逐章重写', '闸门校验'],
    }
    const runKindLabel = (run) => {
      const kind = String(run?.kind ?? 'rewrite')
      const dial = kind === 'rephrase' ? 'style' : String(run?.variant ?? '')
      return `${RUN_KIND[kind] ?? kind}${dial ? `（${RUN_VARIANT[dial] ?? dial}）` : ''}`
    }
    const runScopeLabel = (run) => {
      const scope = String(run?.scope ?? 'book')
      if (scope === 'book') return '全书'
      if (scope === 'range') return `第${run?.chapter ?? '?'}–${run?.endChapter ?? run?.chapter ?? '?'}章`
      return run?.chapter ? `第${run.chapter}章` : '—'
    }
    const runStageTitles = (run) => {
      const kind = String(run?.kind ?? 'rewrite')
      const dial = kind === 'rephrase' ? 'style' : String(run?.variant ?? '')
      return DEFAULT_STAGES[kind === 'rewrite' && dial ? `rewrite:${dial}` : kind] ?? DEFAULT_STAGES.rewrite
    }
    const ATTENTION_BEATS = [
      { id: 'hook', label: '钩子', max: 20 },
      { id: 'tension', label: '张力', max: 20 },
      { id: 'payoff', label: '回报', max: 30 },
      { id: 'cliff', label: '章末牵引', max: 30 },
    ]
    const LOCATION_TYPES = [
      ['capital', '都城'], ['city', '城市'], ['town', '城镇'], ['village', '村庄'],
      ['pass', '关隘'], ['temple', '寺庙'], ['mountain', '山岭'], ['river', '河流'], ['sea', '海域'], ['other', '其他'],
    ]
    const LOCATION_TYPE_LABEL = Object.fromEntries(LOCATION_TYPES)
    const CHAPTER_STATUS = { draft: '草稿', written: '已写', reviewed: '已审', revised: '已改', done: '定稿', final: '定稿' }
    const CHAPTER_STATUS_TONE = { draft: 'muted', written: 'brand', reviewed: 'ok', revised: 'warn', done: 'ok' }

    // 账本六类实体的表格列与编辑字段（字段沿用 0.5.x，旧数据原样兼容）
    const LEDGER_KINDS = ['facts', 'characters', 'events', 'foreshadow', 'conflicts', 'locations', 'highlights', 'outlines']
    const LEDGER_META = {
      facts: {
        title: '事实', icon: '⚖️',
        cols: [
          { k: 'subject', t: '主体' }, { k: 'attribute', t: '属性' },
          { k: 'value', t: '取值' }, { k: 'chapter', t: '章', w: '60px' },
        ],
        fields: [
          { k: 'subject', t: '主体', type: 'text', required: true, ph: '人物 / 地点 / 组织 / 物品' },
          { k: 'attribute', t: '属性', type: 'text', required: true, ph: '年龄 / 身份 / 持有物 / 所在地' },
          { k: 'value', t: '取值', type: 'text', required: true },
          { k: 'chapter', t: '首次出现章', type: 'number' },
          { k: 'validFrom', t: '生效章', type: 'number' },
          { k: 'validTo', t: '失效章', type: 'number' },
          { k: 'note', t: '备注', type: 'textarea', rows: 2 },
        ],
      },
      characters: {
        title: '人物', icon: '👤',
        cols: [{ k: 'name', t: '姓名' }, { k: 'role', t: '定位', w: '90px' }, { k: 'goal', t: '目标' }, { k: 'flaw', t: '缺陷' }],
        fields: [
          { k: 'name', t: '姓名', type: 'text', required: true },
          { k: 'role', t: '定位', type: 'select', options: [['protagonist', '主角'], ['antagonist', '反派'], ['supporting', '配角'], ['minor', '龙套']] },
          { k: 'age', t: '年龄', type: 'text' },
          { k: 'gender', t: '性别', type: 'text' },
          { k: 'appearance', t: '外貌', type: 'textarea', rows: 2 },
          { k: 'personality', t: '性格', type: 'textarea', rows: 2 },
          { k: 'goal', t: '目标', type: 'text' },
          { k: 'motivation', t: '动机', type: 'textarea', rows: 2 },
          { k: 'flaw', t: '缺陷', type: 'text' },
          { k: 'arc', t: '人物弧光', type: 'textarea', rows: 3 },
          { k: 'relationships', t: '关系', type: 'tags', ph: '用「、」分隔' },
        ],
      },
      events: {
        title: '事件', icon: '🕰️',
        cols: [{ k: 'chapter', t: '章', w: '60px' }, { k: 'storyTime', t: '故事时间' }, { k: 'title', t: '事件' }, { k: 'location', t: '地点' }],
        fields: [
          { k: 'title', t: '事件', type: 'text', required: true },
          { k: 'chapter', t: '章号', type: 'number' },
          { k: 'storyTime', t: '故事内时间', type: 'text', ph: '如 天宝十五载六月 / 第三日清晨' },
          { k: 'location', t: '地点', type: 'text' },
          { k: 'participants', t: '参与人物', type: 'tags', ph: '用「、」分隔' },
          { k: 'summary', t: '经过', type: 'textarea', rows: 3 },
          { k: 'consequences', t: '后果', type: 'textarea', rows: 2 },
          { k: 'importance', t: '重要度', type: 'select', options: [['normal', '一般'], ['major', '关键'], ['climax', '高潮']] },
        ],
      },
      foreshadow: {
        title: '伏笔', icon: '🧩',
        cols: [{ k: 'title', t: '伏笔' }, { k: 'setupChapter', t: '埋设', w: '70px' }, { k: 'payoffChapter', t: '回收', w: '70px' }, { k: 'status', t: '状态', w: '90px' }],
        fields: [
          { k: 'title', t: '伏笔', type: 'text', required: true },
          { k: 'setupChapter', t: '埋设章', type: 'number' },
          { k: 'payoffChapter', t: '计划回收章', type: 'number' },
          { k: 'status', t: '状态', type: 'select', options: [['open', '未回收'], ['paid', '已回收'], ['dropped', '已放弃']] },
          { k: 'plantedText', t: '埋设原文', type: 'textarea', rows: 2 },
          { k: 'note', t: '备注', type: 'textarea', rows: 2 },
        ],
      },
      conflicts: {
        title: '冲突', icon: '⚔️',
        cols: [{ k: 'title', t: '冲突' }, { k: 'type', t: '类型', w: '90px' }, { k: 'status', t: '状态', w: '90px' }, { k: 'stakes', t: '赌注' }],
        fields: [
          { k: 'title', t: '冲突', type: 'text', required: true },
          { k: 'type', t: '类型', type: 'select', options: [['internal', '内心'], ['interpersonal', '人际'], ['society', '社会'], ['environment', '环境']] },
          { k: 'parties', t: '相关方', type: 'tags', ph: '用「、」分隔' },
          { k: 'stakes', t: '赌注', type: 'text', ph: '失败会失去什么' },
          { k: 'escalation', t: '升级方式', type: 'textarea', rows: 2 },
          { k: 'status', t: '状态', type: 'select', options: [['active', '进行中'], ['resolved', '已解决'], ['dormant', '潜伏']] },
          { k: 'resolveChapter', t: '计划解决章', type: 'number' },
          { k: 'note', t: '备注', type: 'textarea', rows: 2 },
        ],
      },
      locations: {
        title: '地点', icon: '🏙️',
        cols: [
          { k: 'name', t: '地点' },
          { k: 'type', t: '类型', w: '90px', options: LOCATION_TYPES },
          { k: 'region', t: '区域' },
          { k: 'coords', t: '坐标', w: '100px', format: (v) => (v && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y)) ? `${Math.round(Number(v.x))}, ${Math.round(Number(v.y))}` : '—') },
          { k: 'firstChapter', t: '首现章', w: '70px' },
        ],
        fields: [
          { k: 'name', t: '名称', type: 'text', required: true },
          { k: 'aliases', t: '别名', type: 'tags', ph: '用「、」分隔' },
          { k: 'type', t: '类型', type: 'select', options: LOCATION_TYPES },
          { k: 'region', t: '区域', type: 'text', ph: '如 关内道 / 北境' },
          { k: 'coords.x', t: '地图 X（0–1000）', type: 'number' },
          { k: 'coords.y', t: '地图 Y（0–1000）', type: 'number' },
          { k: 'firstChapter', t: '首现章', type: 'number' },
          { k: 'note', t: '备注', type: 'textarea', rows: 2 },
        ],
      },
      highlights: {
        title: '高光', icon: '✨',
        cols: [
          { k: 'chapter', t: '章', w: '60px' }, { k: 'type', t: '类型', w: '90px' },
          { k: 'title', t: '高光' }, { k: 'text', t: '原文' },
        ],
        fields: [
          { k: 'title', t: '标题', type: 'text', required: true },
          { k: 'chapter', t: '章号', type: 'number' },
          { k: 'type', t: '类型', type: 'select', options: [['description', '描写'], ['dialogue', '对白'], ['action', '动作'], ['emotion', '情绪'], ['idea', '立意']] },
          { k: 'text', t: '原文', type: 'textarea', rows: 3 },
          { k: 'quote', t: '逐字引文', type: 'textarea', rows: 2 },
          { k: 'why', t: '为什么好', type: 'textarea', rows: 2 },
        ],
      },
      outlines: {
        title: '大纲', icon: '🧭',
        cols: [
          { k: 'chapter', t: '章', w: '60px' }, { k: 'title', t: '标题' },
          { k: 'summary', t: '梗概' }, { k: 'status', t: '状态', w: '90px' },
        ],
        fields: [
          { k: 'chapter', t: '章号', type: 'number' },
          { k: 'title', t: '标题', type: 'text', required: true },
          { k: 'summary', t: '梗概', type: 'textarea', rows: 4 },
          { k: 'status', t: '状态', type: 'select', options: [['planned', '计划'], ['draft', '草稿'], ['done', '完成'], ['cut', '已砍']] },
          { k: 'source', t: '来源', type: 'text', ph: 'import / ai / author' },
        ],
      },
    }

    // ── 小工具 ────────────────────────────────────────────────
    function lsGet(key, fallback = '') {
      try {
        const value = window.localStorage.getItem(key)
        return value == null ? fallback : value
      } catch {
        return fallback
      }
    }
    function lsSet(key, value) {
      try {
        window.localStorage.setItem(key, String(value))
      } catch {
        // 隐私模式 / 配额满：不影响阅读
      }
    }
    function apiBase() {
      const boot = window.__ND_BOOT__
      return (boot && boot.apiUrl) || '/novel-desk/api'
    }
    async function api(op, payload = {}) {
      let res
      try {
        res = await fetch(apiBase(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, payload, ...payload }),
        })
      } catch {
        const err = new Error('无法连接小说工作台接口，请确认插件已启用')
        err.code = 'network'
        throw err
      }
      const data = await res.json().catch(() => null)
      if (!data || data.ok !== true) {
        const err = new Error((data && data.error && data.error.message) || `请求失败（${res.status}）`)
        err.code = (data && data.error && data.error.code) || ''
        err.status = res.status
        throw err
      }
      return data.value
    }

    // ── 导出正文（TXT / Markdown / EPUB / DOCX）───────────────
    // 格式清单是服务端 lib/exporters.js EXPORT_META 的镜像：客户端不能 import Node 模块。
    const EXPORT_CHOICES = [
      { format: 'txt', label: 'TXT 纯文本', desc: '按章分节，场景分隔保留 ※，任何编辑器都能开' },
      { format: 'md', label: 'Markdown', desc: '一级标题作品名、二级标题章名，场景分隔转为 ***' },
      { format: 'epub', label: 'EPUB 电子书', desc: '带目录的 EPUB 3，手机 / 阅读器 / 微信读书可直接打开' },
      { format: 'docx', label: 'DOCX 文档', desc: 'Word 打开，标题与提要按样式排版，方便交稿' },
    ]

    /** 把 export.book 的返回值变成浏览器下载（文本走 text，二进制走 base64）。 */
    function triggerDownload(value) {
      if (!value) throw new Error('导出返回为空')
      let blob
      if (value.base64) {
        const binary = window.atob(value.base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
        blob = new Blob([bytes], { type: value.mime || 'application/octet-stream' })
      } else {
        blob = new Blob([value.text ?? ''], { type: value.mime || 'text/plain;charset=utf-8' })
      }
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = value.filename || 'export'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    }

    /** 导出并触发浏览器下载；返回服务端的 { filename, chapters, words, ... }。 */
    async function downloadExport(projectId, format, includeSummary) {
      const value = await api('export.book', { projectId, format, includeSummary: includeSummary === true })
      triggerDownload(value)
      return value
    }

    // 发工作单到 DSH 对话：支持指定目标会话；成功后自动跳回那个对话
    async function sendToChat(projectId, payload, target) {
      const extra = typeof targetPayload === 'function' ? targetPayload(target) : {}
      let value
      try {
        value = await api('chat.send', { projectId, ...payload, ...extra })
      } catch (error) {
        const text = String(error?.message || '')
        if (!extra.newSession && /子代理|普通会话|可投递/.test(text)) {
          value = await api('chat.send', { projectId, ...payload, newSession: true })
        } else {
          throw error
        }
      }
      if (value?.sessionId && openDshSession(value.sessionId)) {
        closeDesk()
        return { ...value, jumped: true }
      }
      return value
    }

    // 是不是真·浏览器标签（DSH 桌面端基于 Electron → false）。决定「开网页」还是「开浮层」。
    const IS_BROWSER_TAB = (() => {
      try {
        const ua = String((window.navigator && window.navigator.userAgent) || '')
        if (!ua) return false
        return !/Electron/i.test(ua)
      } catch {
        return false
      }
    })()

    // 只有显式工作台链接（app.open 加了 #novel-desk=1）才自动铺开。
    // 标记在 hash 里，因为宿主认证的 303 跳转会把 query 丢掉；hash 会随跳转保留。
    // 兼容旧链接/脚本里的 ?novel-desk=1。DSH Remote（dsh-pocket）的页面不带标记，
    // 仍显示 DSH；手机点和桌面点显式链接都直接进工作台，手机靠右下角 ✕ 关闭。
    const IS_STANDALONE_TAB = (() => {
      try {
        const hasMarker = (raw) => /(?:^|[?&#])novel-desk=1(?:&|$)/.test(String(raw || ''))
        const locate = window.location || {}
        return hasMarker(locate.hash) || hasMarker(locate.search)
      } catch {
        return false
      }
    })()

    /**
     * 让宿主用系统默认浏览器打开同一套工作台（宿主生成带 token 的 URL 并调 `open`）。
     * 返回 null 表示宿主不可用 → 调用方退回当前窗口浮层，入口永远不空转。
     */
    async function openInBrowser() {
      try {
        const value = await api('app.open')
        if (value && value.opened === false && value.url) {
          try {
            window.prompt && window.prompt('自动打开失败，请复制链接到浏览器：', value.url)
          } catch {
            /* 无 prompt 环境忽略 */
          }
        }
        return value || null
      } catch {
        return null
      }
    }

    // 作品/章号参数命名同时兼容 host 的两种写法（projectId / id、chapter / n）。
    // 复制到剪贴板：优先 clipboard API，失败退回临时 textarea（DSH 内嵌 webview 有时没有权限）
    async function copyText(text) {
      const value = String(text ?? '')
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch (err) {
        /* 落到下面的兜底 */
      }
      try {
        const area = document.createElement('textarea')
        area.value = value
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch (err) {
        return false
      }
    }
    function scope(projectId, extra = {}) {
      return { projectId, id: projectId, ...extra }
    }
    function chapterArgs(projectId, chapter, extra = {}) {
      const n = Number(chapter) || 0
      return { projectId, id: projectId, chapter: n, n, ...extra }
    }
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }
    function fmtInt(value) {
      const n = Number(value)
      return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—'
    }
    function fmtWords(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')} 万`
      return String(n)
    }
    function fmtClock(iso) {
      const ms = Date.parse(iso || '')
      if (!Number.isFinite(ms)) return ''
      const d = new Date(ms)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    function fmtAgo(value) {
      const ms = Date.parse(value || '')
      if (!Number.isFinite(ms)) return ''
      const diff = Math.max(0, Date.now() - ms)
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`
      if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`
      return `${Math.round(diff / 86400000)} 天前`
    }
    function countWords(text) {
      return String(text || '').replace(/\s+/g, '').length
    }
    function toList(value, key) {
      if (Array.isArray(value)) return value
      if (value && Array.isArray(value[key])) return value[key]
      if (value && Array.isArray(value.items)) return value.items
      return []
    }
    function toNumber(value, fallback = 0) {
      const n = Number(value)
      return Number.isFinite(n) ? n : fallback
    }
    function chapterNo(row) {
      return toNumber(row && (row.chapter != null ? row.chapter : row.index != null ? row.index : row.id), 0)
    }
    function chapterTitle(row) {
      const title = row && row.title != null ? String(row.title) : ''
      return title || '未命名'
    }
    function projectTitle(project) {
      if (!project) return ''
      return String(project.title || project.name || project.id || '')
    }
    function docText(doc) {
      if (!doc) return ''
      if (typeof doc === 'string') return doc
      if (typeof doc.text === 'string') return doc.text
      return ''
    }
    function docHash(doc) {
      if (!doc) return ''
      return String((doc.meta && (doc.meta.contentHash || doc.meta.hash)) || doc.contentHash || doc.hash || '')
    }
    function normalRoute(rv) {
      const source = String((rv && rv.source) || '')
      if (source === 'reader') return 'reader'
      if (ROUTE_LABEL[source]) return source
      const dimension = String((rv && rv.dimension) || '')
      if (/连续|逻辑|事实|情节/.test(dimension)) return 'logic'
      if (/注意力|节奏|钩子|张力/.test(dimension)) return 'attention'
      if (/AI|文笔|语言|首读|世界观/i.test(dimension)) return 'ai-style'
      return 'logic'
    }
    function attentionList(raw) {
      if (Array.isArray(raw)) return raw
      if (raw && raw.chapters && typeof raw.chapters === 'object') {
        return Object.entries(raw.chapters).map(([chapter, row]) => ({ chapter: toNumber(chapter), ...(row || {}) }))
      }
      return []
    }
    function attentionOf(raw, chapter) {
      const n = Number(chapter)
      return attentionList(raw).find((row) => toNumber(row.chapter) === n) || null
    }
    function attentionBeats(row) {
      if (!row || typeof row !== 'object') return {}
      if (row.breakdown && typeof row.breakdown === 'object') return row.breakdown
      if (row.beats && typeof row.beats === 'object') return row.beats
      return {}
    }
    function attentionScore(row) {
      if (!row || typeof row !== 'object') return null
      if (row.score != null && row.score !== '') return toNumber(row.score)
      const beats = attentionBeats(row)
      const sum = ATTENTION_BEATS.reduce((acc, beat) => acc + toNumber(beats[beat.id], 0), 0)
      return sum > 0 ? sum : null
    }
    function hasCoords(location) {
      if (!location || !location.coords) return false
      return Number.isFinite(Number(location.coords.x)) && Number.isFinite(Number(location.coords.y))
    }
    function splitParagraphs(text) {
      const value = String(text || '').replace(/\r\n?/g, '\n').trim()
      if (!value) return []
      return value.split(/\n{2,}/).map((p) => p.replace(/\n+$/, '')).filter((p) => p.length > 0)
    }
    // 回目标题识别与拆行：正文 .txt 首行就是标题（0.7 起）；旧章没有标题行时走 meta 只读兜底。
    const CHAPTER_TITLE_RE = /^(第\s*[0-9零〇一二三四五六七八九十百千两]{1,8}\s*[回章节卷部篇]|序章|楔子|引子|尾声|终章|番外)/
    function splitChapterText(text, titleHint = '') {
      const value = String(text || '').replace(/\r\n?/g, '\n')
      const lines = value.split('\n')
      let i = 0
      while (i < lines.length && !lines[i].trim()) i += 1
      const first = (lines[i] || '').trim()
      const hint = String(titleHint || '').trim()
      if (first && first.length <= 60 && (CHAPTER_TITLE_RE.test(first) || (hint && first === hint))) {
        const body = lines.slice(i + 1).join('\n').replace(/^\n+/, '')
        const at = body ? value.indexOf(body) : value.length
        return { title: first, body, bodyStart: at < 0 ? value.length : at }
      }
      return { title: '', body: value, bodyStart: 0 }
    }

    // 段落起点/终点（与 splitParagraphs 对齐），用于「搜索结果精确跳到那一段」
    function paragraphSpans(text) {
      const value = String(text || '').replace(/\r\n?/g, '\n').trim()
      const spans = []
      const re = /[^\n]+(?:\n(?!\n)[^\n]*)*/g
      let m = re.exec(value)
      while (m) {
        const raw = m[0].replace(/\n+$/, '')
        spans.push({ start: m.index, end: m.index + raw.length })
        m = re.exec(value)
      }
      return spans
    }
    // textarea 里某个字符在「内容坐标」里的纵向位置：用镜像 div 量，focus+setSelectionRange
    // 在固定浮层里不一定会把光标滚进视口（实测 Chrome 不滚），所以自己算 scrollTop。
    function caretOffsetTop(el, at) {
      try {
        const cs = window.getComputedStyle(el)
        const mirror = document.createElement('div')
        mirror.style.position = 'absolute'
        mirror.style.left = '-99999px'
        mirror.style.top = '0'
        mirror.style.visibility = 'hidden'
        mirror.style.margin = '0'
        mirror.style.padding = '0'
        mirror.style.whiteSpace = 'pre-wrap'
        mirror.style.wordWrap = 'break-word'
        mirror.style.overflowWrap = 'break-word'
        mirror.style.fontFamily = cs.fontFamily
        mirror.style.fontSize = cs.fontSize
        mirror.style.fontWeight = cs.fontWeight
        mirror.style.fontStyle = cs.fontStyle
        mirror.style.lineHeight = cs.lineHeight
        mirror.style.letterSpacing = cs.letterSpacing
        mirror.style.boxSizing = 'border-box'
        mirror.style.width = `${Math.max(0, el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth))}px`
        mirror.textContent = String(el.value || '').slice(0, Math.max(0, at))
        const marker = document.createElement('span')
        marker.textContent = '\u200b'
        mirror.appendChild(marker)
        document.body.appendChild(mirror)
        const top = marker.offsetTop
        mirror.remove()
        return top
      } catch {
        return 0
      }
    }
    function fmtBytes(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
      if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
      return String(n)
    }
    function getPath(item, path) {
      const parts = String(path).split('.')
      let cur = item
      for (const part of parts) {
        if (cur == null) return undefined
        cur = cur[part]
      }
      return cur
    }
    function setPath(item, path, value) {
      const parts = String(path).split('.')
      const next = { ...(item || {}) }
      let cur = next
      for (let i = 0; i < parts.length - 1; i += 1) {
        const key = parts[i]
        cur[key] = { ...(cur[key] && typeof cur[key] === 'object' ? cur[key] : {}) }
        cur = cur[key]
      }
      cur[parts[parts.length - 1]] = value
      return next
    }
    function friendlyError(error) {
      const code = error && error.code
      const message = String((error && error.message) || error || '')
      if (code === 'stale' || /stale|已在别处|别处修改/.test(message)) return '正文已在别处修改，重新加载'
      return message || '请求失败'
    }
    function tagsText(value) {
      if (Array.isArray(value)) return value.filter(Boolean).join('、')
      return value == null ? '' : String(value)
    }
    function parseTags(text) {
      return String(text || '')
        .split(/[,，、;；]/)
        .map((s) => s.trim())
        .filter(Boolean)
    }
    function sortChapters(list) {
      return [...list].sort((a, b) => chapterNo(a) - chapterNo(b))
    }

    // ── 通用 hooks ────────────────────────────────────────────
    function useAsync(loader, deps = []) {
      const [state, setState] = useState({ data: null, error: '', loading: true })
      const [tick, setTick] = useState(0)
      const loaderRef = useRef(loader)
      loaderRef.current = loader
      useEffect(() => {
        let cancelled = false
        setState((prev) => ({ ...prev, loading: true, error: '' }))
        Promise.resolve()
          .then(() => loaderRef.current())
          .then(
            (data) => {
              if (!cancelled) setState({ data, error: '', loading: false })
            },
            (error) => {
              if (!cancelled) setState({ data: null, error: friendlyError(error), loading: false })
            },
          )
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [...deps, tick])
      return { ...state, reload: () => setTick((x) => x + 1) }
    }

    // ── 宿主会话：跳回对话 / 选目标对话 ───────────────────────
    let hostCtx = null
    function hostService(name) {
      try {
        return hostCtx?.get?.(name) ?? null
      } catch {
        return null
      }
    }
    function dshSessionRows() {
      try {
        const state = hostService('sessions')?.list?.getSnapshot?.() ?? null
        const raw = state?.byId ? Object.values(state.byId) : Array.isArray(state?.items) ? state.items : []
        return raw
          .filter((row) => row && !row.parentSessionId && row.origin !== 'subagent' && row.agentAvailable !== false)
          .map((row) => ({
            id: String(row.id ?? row.sessionId ?? ''),
            title: String(row.title ?? row.projections?.title ?? ''),
            updatedAt: row.updatedAt ?? null,
            running: Boolean(row.running),
            blank: Boolean(row.blank),
          }))
          .filter((row) => row.id)
          .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      } catch {
        return []
      }
    }
    function openDshSession(sessionId) {
      if (!sessionId) return false
      try {
        const workspace = hostService('uiWorkspace')
        if (workspace?.openSession && workspace.openSession(sessionId)) {
          return true
        }
      } catch (error) {
        console.warn('[novel-desk] 打开会话失败', error)
      }
      return false
    }
    function closeDesk() {
      setOpen(false)
    }
    function lastSessionHint(sessionId) {
      return sessionId ? `（会话 ${String(sessionId).slice(0, 8)}）` : ''
    }

    /** 发到对话的目标选择：auto=最近在用，new=新开，其它=指定会话 */
    function TargetPicker({ projectId, value, onChange }) {
      const [rows, setRows] = useState([])
      const [wsp, setWsp] = useState('')
      useEffect(() => {
        let alive = true
        api('chat.sessions', { projectId })
          .then((result) => {
            if (!alive) return
            setRows(Array.isArray(result?.sessions) ? result.sessions : [])
            setWsp(String(result?.workspacePath || ''))
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [projectId])
      const titles = useMemo(() => {
        const map = new Map()
        for (const row of dshSessionRows()) map.set(row.id, row.title)
        return map
      }, [rows.length])
      return h(
        'label',
        { className: 'nd-field-row' },
        h('span', { className: 'nd-field-label' }, '发到'),
        h(
          'select',
          { className: 'nd-input', value: value || 'auto', onChange: (event) => onChange(event.target.value) },
          [
            h('option', { key: 'auto', value: 'auto' }, '自动（最近在用的对话）'),
            h('option', { key: 'new', value: 'new' }, '新开一个对话'),
            ...rows.map((row) => {
              const title = titles.get(row.sessionId) || ''
              const label = title ? `「${title}」${row.running ? '（进行中）' : ''}` : `${String(row.sessionId).slice(0, 8)}${row.running ? '（进行中）' : ''}`
              return h('option', { key: row.sessionId, value: row.sessionId }, label)
            }),
          ],
        ),
      )
    }
    function targetPayload(target) {
      if (!target || target === 'auto') return {}
      if (target === 'new') return { newSession: true }
      return { sessionId: target }
    }

    // ── 基础控件 ──────────────────────────────────────────────
    function Btn({ children, onClick, kind, small, title, disabled, type, className }) {
      return h(
        'button',
        {
          type: type || 'button',
          className: `nd-btn${kind ? ' nd-btn-' + kind : ''}${small ? ' nd-btn-sm' : ''}${className ? ' ' + className : ''}`,
          onClick,
          title,
          disabled,
        },
        children,
      )
    }
    function IconBtn({ children, onClick, title, disabled, className }) {
      const classes = ['nd-iconbtn', className].filter(Boolean).join(' ')
      return h('button', { type: 'button', className: classes, onClick, title, disabled }, children)
    }
    function Field({ label, hint, children }) {
      return h('label', { className: 'nd-field' },
        h('span', { className: 'nd-label' }, label),
        hint ? h('span', { className: 'nd-hint' }, hint) : null,
        children,
      )
    }
    function TextInput({ value, onChange, placeholder, type, min, max, disabled }) {
      return h('input', {
        className: 'nd-input',
        type: type || 'text',
        value: value == null ? '' : value,
        min,
        max,
        disabled,
        placeholder: placeholder || '',
        onChange: (e) => onChange(e.target.value),
      })
    }
    function TextArea({ value, onChange, rows, placeholder, className }) {
      return h('textarea', {
        className: `nd-input nd-textarea${className ? ' ' + className : ''}`,
        rows: rows || 3,
        value: value == null ? '' : value,
        placeholder: placeholder || '',
        onChange: (e) => onChange(e.target.value),
      })
    }
    function Select({ value, onChange, options, disabled }) {
      return h('select', { className: 'nd-input nd-select', value: value == null ? '' : value, disabled, onChange: (e) => onChange(e.target.value) },
        options.map((opt) => h('option', { key: String(opt.value), value: String(opt.value) }, opt.label)),
      )
    }
    // 标题迁移：把 meta.json 的标题写进 .txt 首行（标题属于正文、可被选中批注）
    function TitleMigrationCard({ projectId }) {
      const [state, setState] = useState({ busy: '', result: null, error: '' })
      const run = async (apply) => {
        if (apply && !window.confirm('把标题写进正文首行？会逐章备份，之后标题可被选中批注。')) return
        setState({ busy: apply ? 'apply' : 'dry', result: null, error: '' })
        try {
          const result = await api('migrate.titles', scope(projectId, { apply }))
          setState({ busy: '', result: { ...result, apply }, error: '' })
        } catch (error) {
          setState({ busy: '', result: null, error: friendlyError(error) })
        }
      }
      return h('section', { className: 'nd-card' },
        h('div', { className: 'nd-card-head' }, h('h3', null, '📝 标题进正文')),
        h('p', { className: 'nd-hint' }, '0.7 起正文 .txt 首行就是回目标题（可直接发人、可被选中批注）。旧章标题还在 meta.json 里，先预演再应用；逐章自动备份。'),
        state.result ? h('p', { className: 'nd-hint' }, state.result.apply ? `已迁移 ${state.result.done} 章。` : `计划迁移 ${state.result.planned} 章（dry-run，未写盘）。${state.result.items && state.result.items.length ? '例如：' + state.result.items.slice(0, 3).map((row) => `第${row.chapter}章「${row.title}」`).join('、') : ''}`) : null,
        state.error ? h(Msg, { tone: 'error' }, state.error) : null,
        h('div', { className: 'nd-actions' },
          h(Btn, { small: true, onClick: () => run(false), disabled: Boolean(state.busy) }, state.busy === 'dry' ? '预演中…' : '预演（不写盘）'),
          h(Btn, { small: true, kind: 'primary', onClick: () => run(true), disabled: Boolean(state.busy) }, state.busy === 'apply' ? '迁移中…' : '把标题写进正文'),
        ),
      )
    }

    // 插件更新卡：检查 npm +（非 git 副本时）一键安装/回退；不静默升级
    function UpdateCard() {
      const [state, setState] = useState({ loading: false, installing: false, data: null, error: '' })
      const run = async (op, payload) => {
        setState((prev) => ({ ...prev, loading: true, error: '' }))
        try {
          const data = await api(op, payload).catch((error) => ({ ok: false, reason: friendlyError(error) }))
          setState((prev) => ({ ...prev, loading: false, data: { ...(prev.data || {}), ...data }, error: '' }))
        } catch (error) {
          setState((prev) => ({ ...prev, loading: false, error: friendlyError(error) }))
        }
        if (op === 'update.check') {
          setState((prev) => ({ ...prev, loading: false }))
        }
      }
      const check = () => { setState((prev) => ({ ...prev, loading: true, error: '' })); api('update.check', { force: true }).then((data) => setState({ loading: false, installing: false, data, error: '' }), (error) => setState((prev) => ({ ...prev, loading: false, error: friendlyError(error) }))) }
      const install = async () => {
        setState((prev) => ({ ...prev, loading: true, installing: true, error: '' }))
        const data = await api('update.install', {}).catch((error) => ({ ok: false, reason: friendlyError(error) }))
        setState((prev) => ({ ...prev, loading: false, installing: false, data: { ...(prev.data || {}), installResult: data }, error: '' }))
      }
      const rollbackNow = async () => {
        setState((prev) => ({ ...prev, loading: true, error: '' }))
        const data = await api('update.rollback', {}).catch((error) => ({ ok: false, reason: friendlyError(error) }))
        setState((prev) => ({ ...prev, loading: false, data: { ...(prev.data || {}), rollbackResult: data }, error: '' }))
      }
      const copy = () => {
        const text = String((state.data && state.data.hint) || '')
        try { navigator.clipboard.writeText(text) } catch { /* 无剪贴板权限 */ }
      }
      const data = state.data || {}
      const result = data.installResult || data.rollbackResult
      return h('section', { className: 'nd-card' },
        h('div', { className: 'nd-card-head' }, h('h3', null, '🔄 插件更新')),
        h('p', { className: 'nd-hint' }, `已装版本：${data.current || '—'}${data.latest ? ` ｜ npm 最新：${data.latest}` : ''}${data.mode ? ` ｜ 安装形态：${data.mode === 'git' ? 'git 源码副本' : 'npm 包副本'}` : ''}`),
        data.error ? h(Msg, { tone: 'error' }, `检查失败：${data.error}`) : null,
        data.latest && data.outdated ? h(Msg, { tone: 'warn' }, '有新版本可用。') : null,
        data.latest && !data.outdated ? h(Msg, { tone: 'ok' }, '已是最新版本（本地开发版可能比 npm 新）。') : null,
        data.mode === 'git' ? h('p', { className: 'nd-hint' }, '当前是 git 源码副本：更新用 git pull，这里不会覆盖你的工作区。') : null,
        result ? h(Msg, { tone: result.ok ? 'ok' : 'error' }, result.reason || (result.ok ? '完成' : '失败')) : null,
        result && result.restartRequired ? h('p', { className: 'nd-hint' }, '需要：重载插件（Host）+ 刷新 DSH 页面（客户端）。') : null,
        data.hint ? h('pre', { className: 'nd-pre' }, data.hint) : null,
        state.error ? h(Msg, { tone: 'error' }, state.error) : null,
        h('div', { className: 'nd-actions' },
          h(Btn, { small: true, kind: 'primary', onClick: check, disabled: state.loading }, state.loading ? '处理中…' : '检查更新'),
          data.outdated && data.mode === 'tarball' ? h(Btn, { small: true, kind: 'primary', onClick: install, disabled: state.installing }, state.installing ? '安装中…' : `一键更新到 ${data.latest}`) : null,
          data.hint ? h(Btn, { small: true, onClick: copy }, '复制更新方式') : null,
          h(Btn, { small: true, onClick: rollbackNow, disabled: state.loading }, '回退上一版'),
        ),
      )
    }

    function Tag({ children, tone }) {
      return h('span', { className: `nd-tag${tone ? ' nd-tag-' + tone : ''}` }, children)
    }
    function Dot({ tone }) {
      return h('span', { className: `nd-dot${tone ? ' nd-dot-' + tone : ''}` })
    }
    function Empty({ children, action }) {
      return h('div', { className: 'nd-empty' }, h('div', null, children), action || null)
    }
    function Loading({ children }) {
      return h('div', { className: 'nd-loading' }, h('span', { className: 'nd-spinner' }), children || '加载中…')
    }
    function ErrorBox({ error, onRetry }) {
      return h('div', { className: 'nd-errorbox' },
        h('span', { className: 'nd-errorbox-icon' }, '⚠'),
        h('span', { className: 'nd-errorbox-text' }, error || '请求失败'),
        onRetry ? h(Btn, { small: true, onClick: onRetry }, '重试') : null,
      )
    }
    function Msg({ tone, children, onClose }) {
      if (!children) return null
      return h('div', { className: `nd-msg nd-msg-${tone || 'info'}` },
        h('span', { className: 'nd-msg-text' }, children),
        onClose ? h(IconBtn, { onClick: onClose, title: '关闭' }, '✕') : null,
      )
    }
    function Modal({ title, children, onClose, footer, wide }) {
      return h('div', { className: 'nd-mask', onMouseDown: (e) => { if (e.target === e.currentTarget && onClose) onClose() } },
        h('div', { className: `nd-modal${wide ? ' nd-modal-wide' : ''}` },
          h('div', { className: 'nd-modal-head' },
            h('strong', { className: 'nd-modal-title' }, title),
            h(IconBtn, { onClick: onClose, title: '关闭' }, '✕'),
          ),
          h('div', { className: 'nd-modal-body' }, children),
          footer ? h('div', { className: 'nd-modal-foot' }, footer) : null,
        ),
      )
    }
    // ── 导出 UI：弹窗（顶栏）与快捷按钮（设置页）──────────────
    /** 导出弹窗：选格式 + 可选附提要，成功后自动下载。 */
    function ExportDialog({ projectId, project, onClose }) {
      const [format, setFormat] = useState('txt')
      const [includeSummary, setIncludeSummary] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [done, setDone] = useState('')
      const current = EXPORT_CHOICES.find((row) => row.format === format) || EXPORT_CHOICES[0]
      const doExport = async () => {
        if (!projectId) return
        setBusy(true)
        setError('')
        setDone('')
        try {
          const value = await downloadExport(projectId, format, includeSummary)
          setDone(`已导出 ${value.filename}（${value.chapters} 章 / ${value.words} 字）`)
        } catch (err) {
          setError(`导出失败：${friendlyError(err)}`)
        } finally {
          setBusy(false)
        }
      }
      const title = (project && (project.title || project.name)) || '未命名作品'
      return h(Modal, {
        title: '📤 导出正文',
        onClose,
        footer: h('div', { className: 'nd-modal-actions' },
          h(Btn, { onClick: onClose }, '关闭'),
          h(Btn, { kind: 'primary', onClick: doExport, disabled: busy || !projectId }, busy ? '导出中…' : '导出并下载'),
        ),
      },
        h('p', { className: 'nd-hint' }, `把《${title}》的全部章节导出成一个成品文件；正文是纯文本，导出时不会再出现 ##、** 之类写作期标记。`),
        h(Field, { label: '导出格式', hint: current.desc },
          h(Select, {
            value: format,
            onChange: setFormat,
            options: EXPORT_CHOICES.map((row) => ({ value: row.format, label: row.label })),
          }),
        ),
        h('label', { className: 'nd-form-row', style: { cursor: 'pointer' } },
          h(Check, { checked: includeSummary, onChange: setIncludeSummary, title: '附章节提要' }),
          h('span', { className: 'nd-hint' }, '附章节提要（写作期的剧情摘要，交稿前一般不要）'),
        ),
        error ? h(Msg, { tone: 'error', onClose: () => setError('') }, error) : null,
        done ? h(Msg, { tone: 'ok', onClose: () => setDone('') }, done) : null,
      )
    }

    /** 设置页的快捷导出：四格式各一个按钮，一键下载。 */
    function ExportQuick({ projectId }) {
      const [busy, setBusy] = useState('')
      const [info, setInfo] = useState('')
      const run = async (format) => {
        if (!projectId || busy) return
        setBusy(format)
        setInfo('')
        try {
          const value = await downloadExport(projectId, format, false)
          setInfo(`已导出 ${value.filename}（${value.chapters} 章 / ${value.words} 字）`)
        } catch (err) {
          setInfo(`导出失败：${friendlyError(err)}`)
        } finally {
          setBusy('')
        }
      }
      return h(Fragment, null,
        h('div', { className: 'nd-form-row', style: { flexWrap: 'wrap' } },
          EXPORT_CHOICES.map((row) => h(Btn, {
            key: row.format,
            small: true,
            kind: row.format === 'epub' ? 'primary' : undefined,
            onClick: () => run(row.format),
            disabled: !projectId || !!busy,
            title: row.desc,
          }, busy === row.format ? '导出中…' : row.label)),
        ),
        info ? h('p', { className: 'nd-hint' }, info) : null,
      )
    }

    // ── 开新书向导：书名 → 预设（含「自定义：让 AI 定」）→ 说想法 → 确认 → 创建并让 AI 生成 ──
    const AI_CUSTOM_PRESET = {
      id: 'preset-ai-custom',
      name: '自定义（让 AI 定）',
      desc: '只给书名和想法：类型、基调、篇幅、结构、风格规则先由 AI 出方案；方案必须带「读者牵引」思路，再按方案生成世界/人物/大纲（大纲每章写一句抓人目标）。',
      custom: true,
      genre: '',
      plannedChapters: 0,
      chapterWords: 0,
    }

    function NewBookDialog({ onClose, onCreated }) {
      const [step, setStep] = useState(1)
      const [presets, setPresets] = useState([])
      const [presetId, setPresetId] = useState('')
      const [form, setForm] = useState({ title: '', genre: '', era: '', idea: '', chapters: '', wordsPerChapter: '', generate: true })
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [result, setResult] = useState(null)
      const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

      useEffect(() => {
        let alive = true
        api('preset.defaults')
          .then((value) => {
            if (!alive) return
            const rows = Array.isArray(value) ? value : []
            setPresets(rows)
            if (rows.length) setPresetId(String(rows[0].id || ''))
          })
          .catch((err) => { if (alive) setError(`读取预设失败：${friendlyError(err)}`) })
        return () => { alive = false }
      }, [])

      const isCustom = presetId === AI_CUSTOM_PRESET.id
      const preset = isCustom ? AI_CUSTOM_PRESET : presets.find((row) => String(row.id) === presetId) || null
      // 向导里只留「有明确口径的预设 + 自定义（让 AI 定）」；空模板（preset-custom）留给设置页手填
      const options = presets.filter((row) => String(row.id) !== 'preset-custom').concat(presets.length ? [AI_CUSTOM_PRESET] : [])
      const pickPreset = (row) => {
        setPresetId(String(row.id))
        if (row.custom) {
          setForm((prev) => ({ ...prev, genre: '', chapters: '', wordsPerChapter: '' }))
          return
        }
        setForm((prev) => ({
          ...prev,
          genre: String(row.genre || ''),
          chapters: String(row.plannedChapters || ''),
          wordsPerChapter: String(row.chapterWords || ''),
        }))
      }
      const chapters = toNumber(form.chapters, 0)
      const perChapter = toNumber(form.wordsPerChapter, 0)
      const estimate = chapters > 0 && perChapter > 0 ? chapters * perChapter : 0
      const ideaText = [form.idea.trim(), form.era.trim() ? `时代/背景：${form.era.trim()}` : ''].filter(Boolean).join('\n')

      const submit = async () => {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          const created = await api('project.create', {
            title: form.title.trim(),
            genre: isCustom ? '' : form.genre.trim(),
            style: preset && !isCustom ? String(preset.tone || '') : '',
            presetId: isCustom ? 'preset-custom' : presetId || undefined,
            idea: ideaText,
            description: ideaText,
            targetChapters: isCustom ? 0 : chapters,
            wordsPerChapter: isCustom ? 0 : perChapter,
          })
          const projectId = String(created?.projectId || created?.project?.id || '')
          if (!projectId) throw new Error('创建作品失败：没有拿到 projectId')
          let warning = ''
          let sessionId = ''
          if (form.generate) {
            try {
              const sent = await api('chat.send', {
                projectId,
                workorder: 'newBookWorkorder',
                brief: ideaText,
                preset: isCustom ? AI_CUSTOM_PRESET : preset,
                // 新书的工作单必须进「这本书自己的工作区」里新开的对话，不能塞进作者当前在聊的会话
                newSession: true,
              })
              sessionId = String(sent?.sessionId || '')
            } catch (err) {
              warning = friendlyError(err)
            }
          }
          const workspacePath = String(created?.workspacePath || '')
          setResult({ projectId, title: form.title.trim() || '未命名作品', warning, generated: form.generate && !warning, custom: isCustom, sessionId, workspacePath })
          setStep(5)
        } catch (err) {
          setError(`创建失败：${friendlyError(err)}`)
        } finally {
          setBusy(false)
        }
      }

      const presetCard = (row) => {
        const active = String(row.id) === presetId
        const total = toNumber(row.plannedChapters, 0) * toNumber(row.chapterWords, 0)
        const meta = row.custom
          ? '类型 / 篇幅 / 结构 / 风格 由 AI 出方案'
          : `${row.genre || '通用'} ｜ ${row.pov || '—'} ｜ ${row.plannedChapters || '—'} 章 × ${row.chapterWords || '—'} 字${total > 0 ? `（${fmtWords(total)} 字）` : ''}`
        return h('button', {
          key: row.id,
          type: 'button',
          className: 'nd-card',
          onClick: () => pickPreset(row),
          style: {
            textAlign: 'left',
            cursor: 'pointer',
            padding: '10px 12px',
            border: `2px solid ${active ? 'var(--dsw-alias-brand,#2563eb)' : 'var(--dsw-alias-border,#e5e7eb)'}`,
            background: active ? 'var(--dsw-alias-brand-weak,rgba(59,130,246,.10))' : 'var(--dsw-alias-bg,#fff)',
          },
        },
          h('div', { className: 'nd-form-row', style: { justifyContent: 'space-between' } },
            h('strong', null, row.name || row.id),
            active ? h(Tag, { tone: 'brand' }, '已选') : (row.custom ? h(Tag, { tone: 'muted' }, 'AI 定') : null),
          ),
          h('p', { className: 'nd-hint', style: { margin: '4px 0' } }, row.desc || ''),
          h('p', { className: 'nd-hint', style: { margin: 0 } }, meta),
        )
      }

      let body = null
      if (step === 1) {
        body = h(Fragment, null,
          h('p', { className: 'nd-hint' }, '先起个名——它既是书名，也是这部作品的「工作区名」；目录由系统按 id 自动建，不用你管。'),
          h(Field, { label: '书名 / 工作区名 *', hint: '之后还能在新作品的「设置」里改。' },
            h(TextInput, { value: form.title, onChange: (value) => set('title', value), placeholder: '如：长安十二时辰' })),
        )
      } else if (step === 2) {
        body = h(Fragment, null,
          h('p', { className: 'nd-hint' }, '再选写作口径：章数、字数、视角、风格规则、禁忌、审稿重点都会写进预设，AI 生成与审稿都按它来。没想好就选「自定义（让 AI 定）」。勾住读者的标准只有一条：读者会不会继续读；写完由冷读独立打分。之后还能在「设置」里改。'),
          presets.length === 0
            ? (error ? null : h(Loading, null, '正在读取预设…'))
            : h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } }, options.map(presetCard)),
        )
      } else if (step === 3) {
        body = h(Fragment, null,
          h('p', { className: 'nd-hint' }, isCustom
            ? '写你想看的故事。选了「自定义」：AI 会先给你一套方案（类型/篇幅/结构/风格规则），再按这套方案生成世界、人物与全书大纲。'
            : '写你想看的那个故事：主角是谁、想要什么、最怕什么、有什么必须出现的场面。越具体，AI 生成的设定与大纲越不套路。'),
          h(Field, { label: '作者的想法（一段话）*' },
            h(TextArea, { value: form.idea, onChange: (value) => set('idea', value), rows: 6, placeholder: '如：唐末长安，一名失忆的仵作追查连环命案，牵出二十年前的宫变；他想不起自己是谁，但每次验尸都会流泪。风格要冷、克制，不要爽文。' })),
          h('div', { className: 'nd-form-grid' },
            h(Field, { label: '类型' }, h(TextInput, { value: form.genre, onChange: (value) => set('genre', value), placeholder: isCustom ? '（可空，交给 AI 定）' : '武侠 / 科幻 / 悬疑…' })),
            h(Field, { label: '时代 / 背景（可选）' }, h(TextInput, { value: form.era, onChange: (value) => set('era', value), placeholder: '如：唐·天宝年间 / 架空蒸汽时代' })),
            isCustom ? null : h(Field, { label: '目标章数' }, h(TextInput, { value: form.chapters, type: 'number', min: 1, onChange: (value) => set('chapters', value) })),
            isCustom ? null : h(Field, { label: '每章字数' }, h(TextInput, { value: form.wordsPerChapter, type: 'number', min: 100, onChange: (value) => set('wordsPerChapter', value) })),
          ),
          isCustom
            ? h('p', { className: 'nd-hint' }, '篇幅与结构由 AI 在方案里给出；批准那条「方案」提案后自动成为本书的当前预设。')
            : estimate > 0
              ? h('p', { className: 'nd-hint' }, `规模：${chapters} 章 × ${perChapter} 字 ≈ ${fmtWords(estimate)} 字`)
              : null,
          h('label', { className: 'nd-form-row', style: { cursor: 'pointer', marginTop: 6 } },
            h(Check, { checked: form.generate, onChange: (value) => set('generate', value), title: '创建后自动生成方案/设定/大纲' }),
            h('span', { className: 'nd-hint' }, isCustom
              ? '创建后把工作单发到左侧对话：AI 先出「AI 自定义方案」，再提交世界/人物/大纲，全部以提案提交，你到「提案」页批量批准'
              : '创建后自动把「生成世界 + 地点 + 人物 + 全书大纲 + 伏笔」的工作单发到左侧对话，AI 以提案提交，你到「提案」页批量批准后才进账本'),
          ),
        )
      } else if (step === 4) {
        body = h(Fragment, null,
          h('p', { className: 'nd-hint' }, '确认一下，点「创建并生成」后会：'),
          h('ul', { className: 'nd-ul', style: { margin: '4px 0 10px', paddingLeft: 18, fontSize: 13, lineHeight: 1.9 } },
            h('li', null, `新建作品「${form.title.trim() || '未命名作品'}」`),
            isCustom
              ? h('li', null, '预设：自定义 —— AI 先提交一份方案提案，批准后自动成为本书当前预设')
              : h('li', null, `套用预设「${preset?.name || '默认'}」：${preset?.genre || form.genre || '通用'} ｜ ${chapters || '—'} 章 × ${perChapter || '—'} 字`),
            h('li', null, form.generate
              ? (isCustom ? '建一个这本书专属的工作区，并在里面新开对话发工作单：AI 出方案 + 世界/人物/大纲，提案待你批准' : '建一个这本书专属的工作区，并在里面新开对话发工作单：AI 生成世界/人物/大纲，提案待你批准')
              : '只创建作品（工作区照样建好），不自动生成'),
          ),
          ideaText ? h('p', { className: 'nd-hint', style: { whiteSpace: 'pre-wrap' } }, `想法：${ideaText.slice(0, 300)}`) : null,
        )
      } else {
        body = h(Fragment, null,
          h(Msg, { tone: 'ok' }, `已创建《${result?.title}》。`),
          result?.generated
            ? h(Fragment, null,
                h(Msg, { tone: 'ok' }, `工作单已发到新工作区「${result?.title}」里新开的对话。`),
                result?.workspacePath ? h('p', { className: 'nd-hint' }, `工作区目录：${result.workspacePath}`) : null,
                h('p', { className: 'nd-hint' }, result?.custom
                  ? '侧栏切到这本新书的工作区就能看到那个对话：AI 会先提交「AI 自定义方案」，再提交世界、地点、人物、全书大纲与伏笔。生成完成后到「提案」页批量批准；方案那条批准后会直接成为本书的当前预设。'
                  : '侧栏切到这本新书的工作区就能看到那个对话：AI 会以提案提交世界、地点、人物、全书大纲与伏笔。生成完成后到「提案」页批量批准。'))

            : result?.warning
              ? h(Msg, { tone: 'error' }, `工作单没有发出去（${result.warning}）。作品已经建好，你可以在对话里说「给新书写世界观与大纲」，或到「提案」页手动创建。`)
              : h('p', { className: 'nd-hint' }, '作品已建好，还没有生成设定。可以在对话里让 AI 生成，或直接去「正文」页开始写。'),
          error ? h(Msg, { tone: 'error' }, error) : null,
        )
      }

      const canNext = step === 1 ? Boolean(form.title.trim()) : step === 3 ? Boolean(form.idea.trim()) : true
      const footer = step === 5
        ? h('div', { className: 'nd-modal-actions' },
            h(Btn, { onClick: onClose }, '关闭'),
            h(Btn, { kind: 'primary', onClick: () => { onCreated?.(result?.projectId); onClose() } }, '进入作品'),
          )
        : h('div', { className: 'nd-modal-actions' },
            h(Btn, { onClick: onClose, disabled: busy }, '取消'),
            step > 1 ? h(Btn, { onClick: () => setStep(step - 1), disabled: busy }, '上一步') : null,
            step < 4
              ? h(Btn, { kind: 'primary', onClick: () => setStep(step + 1), disabled: busy || !canNext }, '下一步')
              : h(Btn, { kind: 'primary', onClick: submit, disabled: busy || !canNext }, busy ? '创建中…' : '创建并生成'),
          )

      return h(Modal, { title: '🆕 开新书', onClose: busy ? () => {} : onClose, footer, wide: true },
        h('div', { className: 'nd-form-row', style: { gap: 6, marginBottom: 10 } },
          ['书名', '选预设', '说想法', '确认', '完成'].map((label, index) => h(Tag, { key: label, tone: step >= index + 1 ? 'brand' : 'muted' }, `${index + 1}. ${label}`)),
        ),
        body,
        step === 4 && error ? null : error ? h(Msg, { tone: 'error', onClose: () => setError('') }, error) : null,
      )
    }

    function Tabs({ value, onChange, items }) {
      return h('div', { className: 'nd-tabs' },
        items.map((item) =>
          h(
            'button',
            {
              key: item.value,
              type: 'button',
              className: `nd-tab${value === item.value ? ' nd-tab-active' : ''}`,
              onClick: () => onChange(item.value),
            },
            item.label,
            item.badge ? h('span', { className: 'nd-tab-badge' }, item.badge) : null,
          ),
        ),
      )
    }
    function Check({ checked, onChange, title }) {
      return h('input', { type: 'checkbox', className: 'nd-check', checked: !!checked, title, onChange: (e) => onChange(e.target.checked) })
    }
    function Bar({ value, max, tone }) {
      const ratio = max > 0 ? clamp((Number(value) || 0) / Number(max), 0, 1) : 0
      return h('div', { className: 'nd-bar' }, h('div', { className: `nd-bar-fill${tone ? ' nd-bar-' + tone : ''}`, style: { width: `${Math.round(ratio * 100)}%` } }))
    }
    function Seg({ value, onChange, items }) {
      return h('div', { className: 'nd-seg' },
        items.map((item) =>
          h('button', { key: item.value, type: 'button', className: `nd-seg-item${value === item.value ? ' nd-seg-active' : ''}`, onClick: () => onChange(item.value) },
            item.label,
          ),
        ),
      )
    }
    // 纯文本渲染：只按空行分段，不解析任何 Markdown 语法。
    function PlainText({ text, className }) {
      const paragraphs = useMemo(() => splitParagraphs(text), [text])
      if (paragraphs.length === 0) return h('div', { className: className || 'nd-plain' }, '（空）')
      return h('div', { className: className || 'nd-plain' }, paragraphs.map((p, i) => h('p', { key: i }, p)))
    }
    function renderSegments(text, query) {
      const value = String(text || '')
      if (!query) return [value]
      const parts = []
      let from = 0
      let count = 0
      while (count < 300) {
        const idx = value.indexOf(query, from)
        if (idx < 0) break
        if (idx > from) parts.push(value.slice(from, idx))
        parts.push(h('mark', { className: 'nd-hl', key: `m${count}` }, query))
        from = idx + query.length
        count += 1
      }
      if (from < value.length) parts.push(value.slice(from))
      return parts.length ? parts : [value]
    }

    // ── 侧栏入口 ──────────────────────────────────────────────
    function SidebarEntry({ wide }) {
      // 只有一个入口：在默认浏览器打开网页后台（DSH 里不再套一层浮层）。
      const launch = () => {
        if (IS_BROWSER_TAB) {
          setOpen(true)
          return
        }
        void openInBrowser().then((value) => {
          if (!value) window.alert('没能拉起默认浏览器。请确认 DSH 以 Web 模式运行，或手动复制地址打开。')
        })
      }
      return h(
        'button',
        {
          type: 'button',
          className: 'nd-entry',
          title: '在默认浏览器打开小说工作台',
          onClick: launch,
        },
        h('span', { className: 'nd-entry-icon' }, '📖'),
        wide ? h('span', { className: 'nd-entry-label' }, '小说工作台') : null,
      )
    }

    // ── 全局开合状态（侧栏入口 / 命令面板都可打开工作台）──────
    let openState = false
    const openListeners = new Set()
    function setOpen(value) {
      openState = !!value
      openListeners.forEach((fn) => fn(openState))
    }
    function useOpen() {
      const [open, setLocal] = useState(openState)
      useEffect(() => {
        const listener = (value) => setLocal(value)
        openListeners.add(listener)
        return () => openListeners.delete(listener)
      }, [])
      return open
    }

    // ── 工作台外壳 ────────────────────────────────────────────
    function Workbench() {
      const open = useOpen()
      const [page, setPage] = useState(() => {
        const saved = lsGet(LS.page, 'read')
        if (saved === 'map') return 'ledger'
        return PAGE_LABEL[saved] ? saved : 'read'
      })
      const [pageArg, setPageArg] = useState(null)
      const [projectId, setProjectId] = useState(() => lsGet(LS.project, ''))
      // 沉浸模式：只在正文页生效，顶栏 / 左导航 / 目录 / 右栏全收掉，只留阅读 / 编辑 / 审阅。
      const [immersive, setImmersive] = useState(() => lsGet(LS.immersive, '0') === '1')
      const immersiveNow = immersive && page === 'read'
      const toggleImmersive = useCallback((next) => {
        const value = next !== false
        setImmersive(value)
        lsSet(LS.immersive, value ? '1' : '0')
      }, [])
      const [exportOpen, setExportOpen] = useState(false)
      const [newBookOpen, setNewBookOpen] = useState(false)
      // 刚创建/刚导入的作品：列表刷新有延迟，校验 effect 不能把它当成非法 id 切回第一部
      const pendingProjectRef = useRef({ id: '', at: 0 })

      const projects = useAsync(() => api('projects.list'), [])
      const projectList = useMemo(() => toList(projects.data, 'projects'), [projects.data])
      const storage = useAsync(() => (projectId ? api('storage.status', scope(projectId)) : Promise.resolve(null)), [projectId])

      useEffect(() => {
        if (!projectList.length) return
        const pending = pendingProjectRef.current
        const valid = projectList.some((p) => String(p.id) === projectId)
        if (valid) {
          if (pending.id === projectId) pendingProjectRef.current = { id: '', at: 0 }
          return
        }
        // 刚创建的作品还没出现在列表里：等它（最多 8 秒），别急着切走
        if (pending.id && pending.id === projectId && Date.now() - pending.at < 8000) return
        pendingProjectRef.current = { id: '', at: 0 }
        const first = String(projectList[0].id || '')
        if (first) {
          setProjectId(first)
          lsSet(LS.project, first)
        }
      }, [projectList, projectId, projects.loading])

      const contextRes = useAsync(
        () => (projectId ? api('project.context', scope(projectId)) : Promise.resolve(null)),
        [projectId],
      )
      const tocRes = useAsync(
        () => (projectId ? api('chapter.list', scope(projectId)) : Promise.resolve([])),
        [projectId],
      )
      const toc = useMemo(() => sortChapters(toList(tocRes.data, 'chapters')), [tocRes.data])
      const context = contextRes.data || null
      const project = (context && context.project) || projectList.find((p) => String(p.id) === projectId) || null

      const go = useCallback((next, arg) => {
        setPage(next)
        setPageArg(arg || null)
        lsSet(LS.page, next)
      }, [])
      const openChapter = useCallback(
        (chapter) => {
          go('read', { chapter: Number(chapter) })
        },
        [go],
      )
      // 定位到「第几段」：阅读页会滚到该段并高亮
      const openChapterAt = useCallback(
        (chapter, para, mark = null) => {
          const n = Number(chapter)
          const p = para == null ? null : Number(para)
          const arg = { chapter: n, ...(Number.isInteger(p) && p >= 0 ? { para: p } : {}) }
          if (mark) arg.marks = [{ chapter: n, para: p, quote: String(mark.quote || ''), kind: String(mark.kind || ''), message: String(mark.message || '') }]
          go('read', arg)
        },
        [go],
      )

      useEffect(() => {
        if (!open) return undefined
        const onKey = (e) => {
          if (e.key !== 'Escape') return
          // 沉浸模式里的 Esc 归正文页：先退出沉浸，不顺手把整个工作台关掉。
          if (immersiveNow) return
          const target = e.target
          const tag = (target && target.tagName) || ''
          if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (target && target.isContentEditable)) return
          if (document.querySelector('.nd-mask')) return
          setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, immersiveNow])

      if (!open) return null

      const totalWords = toc.reduce((sum, row) => sum + toNumber(row.words, 0), 0)
      const switchProject = (nextId) => {
        setProjectId(nextId)
        lsSet(LS.project, nextId)
        setPage('read')
        setPageArg(null)
        lsSet(LS.page, 'read')
        // 导入后切过来时，作品列表可能还没包含新作品：刷新一次，否则顶部下拉看不到它
        if (nextId && !projectList.some((row) => row.id === nextId)) projects.reload()
      }
      // 开新书成功后：切到新作品并落到「提案」页，方便批量批准 AI 生成的设定/大纲
      const enterNewBook = (nextId) => {
        if (!nextId) return
        pendingProjectRef.current = { id: String(nextId), at: Date.now() }
        setProjectId(nextId)
        lsSet(LS.project, nextId)
        projects.reload()
        setPage('proposals')
        setPageArg(null)
        lsSet(LS.page, 'proposals')
      }
      const openNewBook = () => setNewBookOpen(true)

      let body
      if (projects.loading && !projects.data) {
        body = h(Loading, null, '正在读取作品列表…')
      } else if (projects.error) {
        body = h(ErrorBox, { error: projects.error, onRetry: projects.reload })
      } else if (projectList.length === 0) {
        body = h('div', { className: 'nd-welcome' },
          h('div', { className: 'nd-welcome-icon' }, '📚'),
          h('h2', null, '还没有作品'),
          h('p', { className: 'nd-hint' }, '开一本新书：选预设、写一段想法，AI 会把世界、人物与全书大纲生成提案交给你批准。也可以让 AI 在对话里新建，或使用导入动作把旧稿接进来。'),
          h(Btn, { kind: 'primary', onClick: () => setNewBookOpen(true) }, '＋ 开新书'),
          h('p', { className: 'nd-code-hint' }, '~/.dsh/data/dsh-long-novel-workbench/'),
        )
      } else if (!projectId) {
        body = h(Loading, null, '正在选择作品…')
      } else {
        const common = {
          projectId,
          project,
          context,
          toc,
          pageArg,
          go,
          openChapter,
          openChapterAt,
          onChanged: tocRes.reload,
          refreshContext: contextRes.reload,
          openProject: switchProject,
          onNewBook: openNewBook,
          immersive,
          setImmersive: toggleImmersive,
        }
        let pageNode
        if (page === 'read') pageNode = h(ReadingTab, { ...common, key: `read:${projectId}` })
        else if (page === 'outlines') pageNode = h(OutlinesPage, { ...common, key: `outlines:${projectId}` })
        else if (page === 'reviews') pageNode = h(OpinionsPage, { ...common, key: `opinions:${projectId}` })
        else if (page === 'proposals') pageNode = h(ProposalsTab, { ...common, key: `proposals:${projectId}` })
        else if (page === 'run') pageNode = h(RunTab, { ...common, key: `run:${projectId}` })
        else if (page === 'ledger') pageNode = h(LedgerTab, { ...common, key: `ledger:${projectId}` })
        else if (page === 'overview') pageNode = h(OverviewTab, { ...common, key: `overview:${projectId}` })
        else pageNode = h(SettingsTab, { ...common, key: `settings:${projectId}` })
        body = h(Fragment, null, h('div', { className: 'nd-body' }, h(Nav, { page, go }), h('main', { className: 'nd-main' }, pageNode)))
      }

      return h('div', { className: `nd-overlay${IS_BROWSER_TAB ? ' nd-standalone' : ''}${immersiveNow ? ' nd-immersive' : ''}` },
        h('div', { className: 'nd-panel' },
          h('header', { className: 'nd-top' },
            h('div', { className: 'nd-brand' }, h('span', { className: 'nd-brand-icon' }, '📖'), h('strong', null, '小说工作台')),
            h('div', { className: 'nd-proj' },
              h('span', { className: 'nd-proj-label' }, '作品'),
              projectList.length
                ? h(Select, {
                    value: projectId,
                    onChange: switchProject,
                    options: projectList.map((p) => ({ value: String(p.id), label: projectTitle(p) || String(p.id) })),
                  })
                : h('span', { className: 'nd-hint' }, '无作品'),
            ),
            h('div', { className: 'nd-top-mid' }, h('span', { className: 'nd-page-name' }, PAGE_LABEL[page] || '')),
            h('div', { className: 'nd-top-right' },
              toc.length ? h('span', { className: 'nd-top-meta' }, `${toc.length} 章 · ${fmtWords(totalWords)} 字`) : null,
              h(Btn, { small: true, onClick: () => setExportOpen(true), disabled: !projectId, title: '导出正文：TXT / Markdown / EPUB / DOCX' }, '⬇ 导出'),
              h(Btn, { small: true, onClick: () => go('settings'), title: '导入旧稿：设置页「📥 导入旧稿」可填目录或单个 .md/.txt' }, '⬆ 导入'),
              IS_BROWSER_TAB
                ? null
                : h(IconBtn, { onClick: () => { void openInBrowser() }, title: '在默认浏览器打开' }, '🌐'),
              h(IconBtn, { onClick: () => setOpen(false), title: '关闭（Esc）', className: 'nd-top-close' }, '✕'),
            ),
          ),
          h('div', { className: 'nd-principle-bar', title: '创作第一原则：所有写/改正文的工作单首行都注入它' },
            h('span', { className: 'nd-principle-slogan' }, '⚡ ATTENTION IS ALL YOU NEED'),
            h('span', { className: 'nd-principle-text' }, '怎么吸引读者怎么来，一切为读者服务；事实自洽是底线，不是目标。写/改正文前先写一句本章的注意力目标：这一章靠什么把读者拽着往下读。注意力唯一的验收是冷读。'),
          ),
          storage.data && storage.data.engine && storage.data.engine !== 'sqlite'
            ? h('div', { className: 'nd-storage-warn', title: '存储降级提示：可在设置页查看详情' },
                `⚠ 当前环境不支持 SQLite（${storage.data.reason || '未知原因'}），账本与意见已降级为 JSON。升级 DSH/Node 后可恢复。`)
            : null,
          body,
          // 手机兜底关闭：顶栏溢出/被裁时也一定能退出工作台回到 DSH。
          h('button', { type: 'button', className: 'nd-mobile-close', onClick: () => setOpen(false), title: '关闭工作台', 'aria-label': '关闭工作台' }, '✕'),
          exportOpen ? h(ExportDialog, { projectId, project, onClose: () => setExportOpen(false) }) : null,
          newBookOpen ? h(NewBookDialog, { onClose: () => setNewBookOpen(false), onCreated: enterNewBook }) : null,
        ),
      )
    }

    function Nav({ page, go }) {
      const STATUS_LABEL = { open: '待处理', accepted: '已采纳', rejected: '已驳回', merged: '已合并', stale: '失效', resolved: '已处理' }
      const groups = []
      for (const item of PAGES) {
        let group = groups.find((g) => g.name === item.group)
        if (!group) {
          group = { name: item.group, items: [] }
          groups.push(group)
        }
        group.items.push(item)
      }
      return h('nav', { className: 'nd-nav' },
        groups.map((group) =>
          h('div', { className: 'nd-nav-group', key: group.name },
            h('div', { className: 'nd-nav-title' }, group.name),
            group.items.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: `nd-nav-item${page === item.id ? ' nd-nav-active' : ''}`,
                  onClick: () => go(item.id),
                },
                h('span', { className: 'nd-nav-icon' }, item.icon),
                h('span', null, item.label),
              ),
            ),
          ),
        ),
      )
    }

    // ── 正文页 ────────────────────────────────────────────────
    const READ_BATCH = 4

    function ReadingTab({ projectId, context, toc, pageArg, go, openChapter, onChanged, immersive, setImmersive }) {
      const chapters = toc
      const tocNums = useMemo(() => chapters.map(chapterNo).filter((n) => n > 0), [chapters])
      const tocKey = tocNums.join(',')

      const [docs, setDocs] = useState([])
      const [docsLoading, setDocsLoading] = useState(false)
      const [docsError, setDocsError] = useState('')
      const [active, setActive] = useState(() => {
        const fromArg = Number(pageArg && pageArg.chapter)
        if (fromArg > 0) return fromArg
        return toNumber(lsGet(LS.pos + projectId, '0'), 0)
      })
      const [mode, setMode] = useState(() => {
        const saved = lsGet(LS.mode, 'read')
        return MODES.some((m) => m.id === saved) ? saved : 'read'
      })
      const [tocFilter, setTocFilter] = useState('')
      const [creating, setCreating] = useState(false)
      const createChapter = async () => {
        if (creating) return
        setCreating(true)
        try {
          const nums = chapters.map((row) => chapterNo(row)).filter((n) => n > 0)
          const next = (nums.length ? Math.max(...nums) : 0) + 1
          await api('chapter.save', { projectId, chapter: next, text: '', create: true, baseHash: null, meta: { title: `第 ${next} 章`, status: 'draft' } })
          await onChanged(); setActive(next); if (mode === 'edit') openEdit(next)
          setNotice(`已新建第 ${next} 章，可以直接开始写`)
        } catch (err) { setNotice(`新建章节失败：${friendlyError(err)}`) } finally { setCreating(false) }
      }
      const [deletingChapter, setDeletingChapter] = useState(false)
      const deleteActiveChapter = async (chapter) => {
        if (!chapter || deletingChapter) return
        if (!window.confirm(`删除第 ${chapter} 章？正文会进回收站（.backups 里仍保留历史版本），本章的意见与待批准提案一并清除。已采纳/已驳回的提案留作历史。`)) return
        setDeletingChapter(true)
        try {
          await api('chapter.delete', scope(projectId, { chapter }))
          const rest = tocNums.filter((n) => n !== chapter)
          setActive(rest.length ? Math.max(...rest) : 0)
          setNotice(`已删除第 ${chapter} 章`)
          await onChanged()
        } catch (err) {
          setNotice(`删除失败：${friendlyError(err)}`)
        } finally {
          setDeletingChapter(false)
        }
      }
      const [search, setSearch] = useState('')
      const [results, setResults] = useState(null)
      const [searching, setSearching] = useState(false)
      const [searchError, setSearchError] = useState('')
      const [highlight, setHighlight] = useState('')
      const [jumpOffset, setJumpOffset] = useState(null) // { chapter, offset } 搜索结果精确落点
      const focusRef = useRef(null)
      const [notice, setNotice] = useState('')
      const [pop, setPop] = useState(null)
      const [runDialog, setRunDialog] = useState(null)
      const [historyChapter, setHistoryChapter] = useState(0)
      const [prefs, setPrefs] = useState(() => ({ size: toNumber(lsGet('nd.fontSize', '15'), 15), lead: toNumber(lsGet('nd.lineHeight', '1.95'), 1.95) }))
      const [edit, setEdit] = useState({
        chapter: 0, text: '', baseHash: '', meta: {},
        dirty: false, saving: false, savedAt: '', error: '', stale: false,
      })

      const scrollRef = useRef(null)
      const secRefs = useRef({})
      const rafRef = useRef(0)
      const restoredFor = useRef('')
      const searchRef = useRef(null)
      const popRef = useRef(pop)
      popRef.current = pop
      const editorRef = useRef(null)
      const editorMarkRef = useRef(null)
      const [editorWidth, setEditorWidth] = useState(0)
      const modeRef = useRef(mode)
      modeRef.current = mode
      // 模式切换的位置同步：读到哪里 → 编辑器光标也放到那一段 → 切回来还落回那一段
      const pendingEditAnchor = useRef(null)
      const pendingReadAnchor = useRef(null)
      const anchorTimer = useRef(0)
      const editRef = useRef(edit)
      editRef.current = edit
      const activeRef = useRef(active)
      activeRef.current = active
      const saveTimer = useRef(null)

      const reviews = useAsync(
        () => (projectId ? api('review.list', scope(projectId)) : Promise.resolve([])),
        [projectId],
      )
      const proposals = useAsync(
        () => (projectId ? api('proposal.list', scope(projectId, { status: 'pending', filter: { status: 'pending' } })) : Promise.resolve([])),
        [projectId],
      )

      // 全本正文：分批拉取，边到边渲染（打开就能读到全文）。
      useEffect(() => {
        if (!projectId || tocNums.length === 0) {
          setDocs([])
          return undefined
        }
        let cancelled = false
        const list = tocNums
        const acc = []
        setDocs([])
        setDocsError('')
        setDocsLoading(true)
        ;(async () => {
          try {
            for (let i = 0; i < list.length; i += READ_BATCH) {
              const batch = list.slice(i, i + READ_BATCH)
              const rows = await Promise.all(
                batch.map(async (chapter) => {
                  try {
                    const value = await api('chapter.get', chapterArgs(projectId, chapter))
                    return {
                      chapter,
                      text: docText(value),
                      meta: (value && value.meta) || {},
                      hash: docHash(value && value.meta ? { meta: value.meta } : value),
                      error: '',
                    }
                  } catch (err) {
                    return { chapter, text: '', meta: {}, hash: '', error: friendlyError(err) }
                  }
                }),
              )
              if (cancelled) return
              rows.forEach((row) => acc.push(row))
              setDocs(acc.slice())
            }
          } catch (err) {
            if (!cancelled) setDocsError(friendlyError(err))
          } finally {
            if (!cancelled) setDocsLoading(false)
          }
        })()
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [projectId, tocKey])

      // 当前章必须存在
      useEffect(() => {
        if (tocNums.length === 0) return
        if (!tocNums.includes(active)) setActive(tocNums[0])
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tocKey, active])

      useEffect(() => {
        if (active > 0) lsSet(LS.pos + projectId, active)
      }, [active, projectId])

      // 章节节点相对滚动容器的真实偏移：offsetTop 跟 offsetParent 走（这里是 .nd-overlay），
      // 沉浸模式切换后外壳高度会变，只有用 rect + scrollTop 算才不会被顶栏/原则条带偏。
      const nodeTopInScroll = useCallback((node) => {
        const box = scrollRef.current
        if (!box || !node) return 0
        return node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
      }, [])

      const scrollToChapter = useCallback(
        (chapter, smooth = true) => {
          const n = Number(chapter)
          if (!n) return
          setActive(n)
          lsSet(LS.pos + projectId, n)
          requestAnimationFrame(() => {
            const box = scrollRef.current
            const node = secRefs.current[n]
            if (!box || !node) return
            const top = Math.max(0, nodeTopInScroll(node) - 8)
            if (typeof box.scrollTo === 'function') box.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
            else box.scrollTop = top
          })
        },
        [projectId, nodeTopInScroll],
      )

      // ── 阅读 / 编辑 / 审阅 之间的位置同步 ──────────────────────
      // 现在的「正在读的那一段」：先按滚动位置找章，再找视口里第一个还没滚出去的段落。
      const readParagraphAnchor = useCallback(() => {
        const chapter = activeRef.current
        const box = scrollRef.current
        if (!box) return { chapter, para: 0 }
        const boxTop = box.getBoundingClientRect().top
        let section = secRefs.current[chapter] || null
        for (const doc of docs) {
          const node = secRefs.current[doc.chapter]
          if (!node || !node.isConnected) continue
          if (node.getBoundingClientRect().top - boxTop <= 40) section = node
          else break
        }
        if (!section) return { chapter, para: 0 }
        const n = Number(section.getAttribute('data-ch')) || chapter
        const paras = section.querySelectorAll('.nd-para')
        let para = 0
        for (let i = 0; i < paras.length; i += 1) {
          const rect = paras[i].getBoundingClientRect()
          // 取「已经露到视口里超过半段」的第一段：段落只露一条尾巴时算下一段
          if (rect.bottom - boxTop > Math.min(rect.height, 200) * 0.5) { para = i; break }
          para = i
        }
        return { chapter: n, para }
      }, [docs])

      const saveAnchor = useCallback((anchor) => {
        if (!anchor) return
        lsSet(LS.pos + projectId, anchor.chapter)
        lsSet(`${LS.pos + projectId}.para`, String(anchor.para || 0))
      }, [projectId])

      // 把正文滚到某个段落（段落 0 = 章首，露章标题；其它段落贴视口顶部）。
      const scrollReaderToAnchor = useCallback((anchor, maxTries = 12) => {
        if (!anchor) return
        let tries = 0
        const step = () => {
          const box = scrollRef.current
          const section = secRefs.current[anchor.chapter]
          if (!box || !section || !section.isConnected) {
            if (tries < maxTries) { tries += 1; window.setTimeout(step, 120) }
            return
          }
          const paras = section.querySelectorAll('.nd-para')
          const para = Math.max(0, Number(anchor.para) || 0)
          const target = para > 0 ? (paras[Math.min(para, paras.length - 1)] || section) : section
          const top = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 8
          if (typeof box.scrollTo === 'function') box.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
          else box.scrollTop = Math.max(0, top)
          activeRef.current = anchor.chapter
          setActive(anchor.chapter)
          saveAnchor(anchor)
        }
        requestAnimationFrame(step)
      }, [saveAnchor])

      // 首次渲染完成后恢复上次阅读位置（章 + 段）
      useEffect(() => {
        if (docs.length === 0) return
        const marker = `${projectId}:${tocKey}`
        if (restoredFor.current === marker) return
        restoredFor.current = marker
        const saved = toNumber(lsGet(LS.pos + projectId, '0'), 0) || Number(docs[0] && docs[0].chapter) || 0
        const savedPara = toNumber(lsGet(`${LS.pos + projectId}.para`, '0'), 0)
        scrollReaderToAnchor({ chapter: saved, para: savedPara }, 40)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [docs, tocKey, projectId])

      // 进编辑：等本章正文进 textarea 后，把光标放到正在读的那一段（浏览器会把光标滚进视口）。
      useEffect(() => {
        if (mode !== 'edit') return
        const anchor = pendingEditAnchor.current
        const el = editorRef.current
        if (!anchor || !el || !edit.text) return
        if (anchor.chapter !== edit.chapter) { pendingEditAnchor.current = null; return }
        pendingEditAnchor.current = null
        requestAnimationFrame(() => {
          const spans = paragraphSpans(edit.text)
          const idx = Math.min(anchor.para || 0, Math.max(0, spans.length - 1))
          const at = spans[idx] ? spans[idx].start : 0
          try {
            el.focus()
            el.setSelectionRange(at, at)
            // focus + setSelectionRange 在固定浮层里不会把光标滚进视口，自己按镜像位置滚；
            // 手机弹出键盘后 textarea 会变矮，再补两次。
            const apply = () => { try { el.scrollTop = Math.max(0, caretOffsetTop(el, at) - 12) } catch { /* 忽略 */ } }
            apply()
            window.setTimeout(apply, 180)
            window.setTimeout(apply, 420)
          } catch {
            // 个别 WebView 不支持 focus + setSelectionRange 组合：忽略，正文仍可继续编辑
          }
        })
      }, [mode, edit.chapter, edit.text])

      // 出编辑：切回阅读 / 审阅后落回刚编辑的那一段，而不是书首 / 章首。
      useEffect(() => {
        if (mode === 'edit') return
        const anchor = pendingReadAnchor.current
        if (!anchor) return
        pendingReadAnchor.current = null
        scrollReaderToAnchor(anchor)
      }, [mode, scrollReaderToAnchor])

      // 进出沉浸模式外壳高度/正文宽度都会变：按「当前正在读的那一段」重新落位，
      // 不要退回章首（否则沉浸切一下就把段落位置丢了）。
      const wasImmersive = useRef(immersive)
      useEffect(() => {
        if (wasImmersive.current === immersive) return
        wasImmersive.current = immersive
        if (mode === 'edit') return
        requestAnimationFrame(() => {
          pendingReadAnchor.current = null
          scrollReaderToAnchor(readParagraphAnchor())
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [immersive, mode])

      // pageArg 指定章号（来自地图 / 总览 / 意见跳转）
      useEffect(() => {
        const n = Number(pageArg && pageArg.chapter)
        if (n > 0 && docs.length > 0 && mode !== 'edit') scrollToChapter(n)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pageArg])

      // pageArg.para：定位到该章第几段（本地检查/意见「定位」用）
      useEffect(() => {
        const n = Number(pageArg && pageArg.chapter)
        const p = Number(pageArg && pageArg.para)
        if (!n || !Number.isInteger(p) || p < 0 || docs.length === 0 || mode === 'edit') return
        const doc = docs.find((row) => Number(row.chapter) === n)
        if (!doc) return
        const parsed = splitChapterText(doc.text, doc.meta && doc.meta.title ? String(doc.meta.title) : '')
        const spans = paragraphSpans(parsed.body)
        const span = spans[p]
        if (!span) return
        setJumpOffset({ chapter: n, offset: parsed.bodyStart + span.start })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pageArg, docs])

      // 搜索结果落到具体段落：目录跳到章首后，再把那一段滚到视口中间并高亮 1.4s
      useEffect(() => {
        if (!jumpOffset) return undefined
        let tries = 0
        let timer = 0
        const step = () => {
          const el = focusRef.current
          const box = scrollRef.current
          if (el && box) {
            // 直接算 scrollTop：正文可能还在分批加载，scrollIntoView 会被后续布局挤走
            const elBox = el.getBoundingClientRect()
            const boxRect = box.getBoundingClientRect()
            const delta = elBox.top - boxRect.top - box.clientHeight / 2 + elBox.height / 2
            if (box.style.scrollBehavior !== 'auto') box.style.scrollBehavior = 'auto' // CSS 里是 smooth，会跟重试打架
            box.scrollTop = Math.max(0, box.scrollTop + delta)
            const after = el.getBoundingClientRect()
            if (after.top > boxRect.top && after.bottom < boxRect.bottom) {
              focusRef.current = null
              timer = setTimeout(() => setJumpOffset(null), 1600)
              return
            }
          }
          tries += 1
          if (tries < 20) timer = setTimeout(step, 180)
        }
        timer = setTimeout(step, 240)
        return () => clearTimeout(timer)
      }, [jumpOffset])
      const onScroll = useCallback(() => {
        if (modeRef.current === 'edit') return
        if (rafRef.current) return
        rafRef.current = window.requestAnimationFrame(() => {
          rafRef.current = 0
          const box = scrollRef.current
          if (!box) return
          const marker = box.scrollTop + 120
          let current = Number(docs[0] && docs[0].chapter) || 0
          for (const doc of docs) {
            const node = secRefs.current[doc.chapter]
            if (!node) continue
            if (nodeTopInScroll(node) <= marker) current = doc.chapter
            else break
          }
          if (current && current !== activeRef.current) {
            activeRef.current = current
            setActive(current)
            lsSet(LS.pos + projectId, current)
          }
          // 滚动停 300ms 后记住读到的段落：切模式 / 下次打开都回到这一段
          if (anchorTimer.current) window.clearTimeout(anchorTimer.current)
          anchorTimer.current = window.setTimeout(() => {
            anchorTimer.current = 0
            if (modeRef.current === 'edit') return
            saveAnchor(readParagraphAnchor())
          }, 300)
        })
      }, [docs, mode, projectId, nodeTopInScroll, saveAnchor, readParagraphAnchor])

      useEffect(() => () => {
        if (rafRef.current) window.cancelAnimationFrame(rafRef.current)
        if (anchorTimer.current) window.clearTimeout(anchorTimer.current)
      }, [])

      // 键盘：j/k 翻章、/ 聚焦搜索；输入框内不拦截；沉浸模式里 Esc 先退沉浸
      useEffect(() => {
        const onKey = (e) => {
          const target = e.target
          const tag = (target && target.tagName) || ''
          if (e.key === 'Escape' && immersive) {
            e.preventDefault()
            e.stopImmediatePropagation()
            if (target && target.blur) target.blur()
            setImmersive(false)
            return
          }
          if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (target && target.isContentEditable)) return
          if (pop || runDialog) return
          if (e.key === 'j' || e.key === 'k') {
            const idx = tocNums.indexOf(activeRef.current)
            if (idx < 0) return
            const next = e.key === 'j' ? tocNums[idx + 1] : tocNums[idx - 1]
            if (next) {
              e.preventDefault()
              scrollToChapter(next)
            }
          } else if (e.key === '/') {
            e.preventDefault()
            if (searchRef.current) searchRef.current.focus()
          } else if (e.key === 'Escape') {
            if (results) {
              setResults(null)
              setSearch('')
            }
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tocKey, pop, runDialog, results, scrollToChapter, immersive, setImmersive])

      const doSearch = async () => {
        const q = search.trim()
        if (!q) {
          setResults(null)
          setHighlight('')
          return
        }
        setSearching(true)
        setSearchError('')
        try {
          const value = await api('chapter.search', scope(projectId, { query: q, q }))
          const list = Array.isArray(value) ? value : (value && (value.results || value.hits)) || []
          setResults(list)
          setHighlight(q)
        } catch (err) {
          setSearchError(friendlyError(err))
          setResults([])
        } finally {
          setSearching(false)
        }
      }

      const jumpToResult = (row) => {
        const chapter = chapterNo(row) || toNumber(row && row.chapter, 0)
        const offset = row && row.offset != null ? toNumber(row.offset, -1) : -1
        if (chapter) scrollToChapter(chapter)
        setJumpOffset(chapter ? { chapter, offset } : null)
        setResults(null)
      }

      const openEdit = async (chapter) => {
        const n = Number(chapter)
        const doc = docs.find((d) => d.chapter === n)
        if (doc) {
          setEdit({
            chapter: n, text: doc.text || '', baseHash: doc.hash || '', meta: doc.meta || {},
            dirty: false, saving: false, savedAt: '', error: '', stale: false,
          })
          return
        }
        setEdit({ chapter: n, text: '', baseHash: '', meta: {}, dirty: false, saving: false, savedAt: '', error: '', stale: false })
        try {
          const value = await api('chapter.get', chapterArgs(projectId, n))
          setEdit((cur) => (cur.chapter !== n ? cur : {
            ...cur, text: docText(value), meta: (value && value.meta) || {},
            baseHash: docHash(value && value.meta ? { meta: value.meta } : value), error: '',
          }))
        } catch (err) {
          setEdit((cur) => (cur.chapter !== n ? cur : { ...cur, error: `正文读取失败：${friendlyError(err)}` }))
        }
      }

      const saveNow = useCallback(async () => {
        const cur = editRef.current
        if (!cur || !cur.chapter || cur.saving) return
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current)
          saveTimer.current = null
        }
        setEdit((state) => ({ ...state, saving: true, error: '' }))
        try {
          const value = await api('chapter.save', chapterArgs(projectId, cur.chapter, {
            text: cur.text,
            baseHash: cur.baseHash,
            meta: cur.meta && cur.meta.title ? { title: cur.meta.title } : {},
            opts: { baseHash: cur.baseHash },
          }))
          const nextHash =
            (value && (value.contentHash || (value.meta && value.meta.contentHash))) ||
            docHash(value && value.meta ? { meta: value.meta } : value) ||
            (cur.baseHash || '')
          const nextMeta = value && value.meta && typeof value.meta === 'object' ? value.meta : cur.meta
          const words = countWords(cur.text)
          setEdit((state) => (state.chapter !== cur.chapter ? state : {
            ...state, saving: false, dirty: false, baseHash: nextHash, meta: nextMeta || {},
            savedAt: new Date().toISOString(), error: '', stale: false,
          }))
          setDocs((prev) => prev.map((doc) => (doc.chapter === cur.chapter ? { ...doc, text: cur.text, meta: { ...(nextMeta || doc.meta), words }, hash: nextHash || doc.hash } : doc)))
          setNotice('本章已保存')
          if (onChanged) onChanged()
        } catch (err) {
          const stale = err && (err.code === 'stale' || /stale|已在别处|别处修改/.test(String(err.message || '')))
          setEdit((state) => (state.chapter !== cur.chapter ? state : {
            ...state, saving: false, error: stale ? '' : friendlyError(err), stale,
          }))
          if (stale) setNotice('正文已在别处修改，重新加载')
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [projectId, onChanged])

      // 编辑模式：2 秒防抖自动保存
      useEffect(() => {
        if (mode !== 'edit' || !edit.dirty) return undefined
        if (saveTimer.current) window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(() => {
          saveTimer.current = null
          saveNow()
        }, 2000)
        return () => {
          if (saveTimer.current) {
            window.clearTimeout(saveTimer.current)
            saveTimer.current = null
          }
        }
      }, [edit.text, edit.dirty, mode, saveNow])

      useEffect(() => {
        if (mode === 'edit' && editRef.current.chapter === 0 && docs.length > 0) openEdit(activeRef.current)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [mode, docs.length])

      const switchMode = (next) => {
        if (next === mode) return
        modeRef.current = next
        if (mode === 'edit' && editRef.current.dirty) saveNow()
        // 位置同步：阅读/审阅 → 编辑时记住当前段；编辑 → 阅读/审阅时按 textarea 光标换算回段落
        if (next === 'edit') {
          const anchor = readParagraphAnchor()
          pendingEditAnchor.current = anchor
          saveAnchor(anchor)
          setActive(anchor.chapter)
          openEdit(anchor.chapter)
        } else if (mode === 'edit') {
          const cur = editRef.current
          const el = editorRef.current
          let para = 0
          if (el && cur.text) {
            const at = Number(el.selectionStart) || 0
            const spans = paragraphSpans(cur.text)
            const idx = spans.findIndex((span) => at >= span.start && at < span.end)
            para = idx < 0 ? Math.max(0, spans.length - 1) : idx
          }
          pendingReadAnchor.current = { chapter: cur.chapter || activeRef.current, para }
          saveAnchor(pendingReadAnchor.current)
        }
        setMode(next)
        lsSet(LS.mode, next)
        if (next === 'reader') setNotice('批注模式：选中正文文字即可提交作者意见（不改正文）')
        if (next === 'read') setNotice('')
      }

      const reloadEdit = async () => {
        const n = editRef.current.chapter
        if (!n) return
        try {
          const value = await api('chapter.get', chapterArgs(projectId, n))
          const text = docText(value)
          const meta = (value && value.meta) || {}
          setEdit({ chapter: n, text, baseHash: docHash({ meta }), meta, dirty: false, saving: false, savedAt: '', error: '', stale: false })
          setDocs((prev) => prev.map((doc) => (doc.chapter === n ? { ...doc, text, meta, hash: docHash({ meta }) } : doc)))
          setNotice('已重新加载本章')
        } catch (err) {
          setNotice(`重新加载失败：${friendlyError(err)}`)
        }
      }

      // 从当前选区取出「章号 + 逐字引文 + 弹窗落点」。
      // 手机长按选中不会触发 mouseup（iOS / Android 都不发），所以鼠标拖动和
      // selectionchange / touchend 都走这一个入口，不能只挂在 onMouseUp 上。
      const pickReaderSelection = (sourceEl) => {
        if (mode !== 'reader') return
        if (sourceEl && sourceEl.closest && sourceEl.closest('.nd-note-pop')) return
        const sel = window.getSelection && window.getSelection()
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
        const quote = String(sel.toString ? sel.toString() : '').trim()
        if (quote.length < 4) return
        const range = sel.getRangeAt(0)
        const start = range.startContainer
        const el = start && (start.nodeType === 1 ? start : start.parentElement)
        if (el && el.closest && el.closest('.nd-note-pop')) return
        const section = el && el.closest ? el.closest('[data-ch]') : null
        if (!section) return
        const chapter = Number(section.getAttribute('data-ch')) || activeRef.current
        const cur = popRef.current
        // 同一段已经在写批注：别把作者刚输入的内容冲掉
        if (cur && cur.quote === quote && cur.chapter === chapter) return
        const rect = range.getBoundingClientRect()
        setPop({
          quote,
          chapter,
          x: clamp(rect.left, 12, Math.max(12, window.innerWidth - 320)),
          y: clamp(rect.bottom + 8, 12, Math.max(12, window.innerHeight - 260)),
          issue: '',
          severity: 'minor',
          saving: false,
          error: '',
        })
      }

      const onReaderMouseUp = (e) => pickReaderSelection(e.target)

      // 触屏兜底：选区变化 / 手指抬起后 260ms 再看一次（等系统选字手柄稳定）。
      useEffect(() => {
        if (mode !== 'reader') return undefined
        let timer = 0
        const schedule = () => {
          if (timer) window.clearTimeout(timer)
          timer = window.setTimeout(() => {
            timer = 0
            pickReaderSelection(null)
          }, 260)
        }
        const onSelectionChange = () => {
          const sel = window.getSelection && window.getSelection()
          if (!sel || sel.isCollapsed) return
          schedule()
        }
        // 只有手指落在正文里才算选字，避免点顶栏字号 −/+ 也去取一次选区
        const onTouchEnd = (event) => {
          const el = event && event.target
          if (!el || !el.closest || !el.closest('.nd-reader-body')) return
          schedule()
        }
        document.addEventListener('selectionchange', onSelectionChange)
        document.addEventListener('touchend', onTouchEnd, { passive: true })
        return () => {
          document.removeEventListener('selectionchange', onSelectionChange)
          document.removeEventListener('touchend', onTouchEnd)
          if (timer) window.clearTimeout(timer)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [mode])

      const submitNote = async () => {
        const cur = pop
        if (!cur) return
        if (!cur.issue.trim()) {
          setPop((p) => (p ? { ...p, error: '请先写批注内容' } : p))
          return
        }
        setPop({ ...cur, saving: true, error: '' })
        const item = {
          chapter: cur.chapter,
          source: 'reader',
          dimension: '读者',
          severity: cur.severity,
          quote: cur.quote,
          anchor: cur.anchor === 'chapter' ? 'chapter' : (cur.anchor === 'title' ? 'title' : 'paragraph'),
          issue: cur.issue.trim(),
          suggestion: '',
          status: 'open',
        }
        try {
          const value = await api('review.add', scope(projectId, { chapter: cur.chapter, reviews: [item], items: [item] }))
          const added = value && typeof value.added === 'number' ? value.added : 1
          if (added > 0) {
            // 提交成功才关弹窗；批注一律落盘，引文能否定位只做事后标记
            setPop(null)
            if (window.getSelection) window.getSelection().removeAllRanges()
            reviews.reload()
            setNotice(value && value.added ? (item.anchor === 'chapter' ? '已提交整章意见' : '已提交作者意见') : '已提交')
          } else {
            // 没落盘就不许丢输入：保留弹窗与已写的内容，把原因写在弹窗里
            const why = value && Array.isArray(value.skippedReasons) && value.skippedReasons.length
              ? value.skippedReasons.join('；')
              : '存储失败'
            setPop((p) => (p ? { ...p, saving: false, error: `未写入：${why}` } : p))
            reviews.reload()
          }
        } catch (err) {
          // 网络 / 服务端错误同样保留输入，作者可以直接再点一次提交
          setPop((p) => (p ? { ...p, saving: false, error: `提交失败（内容已保留）：${friendlyError(err)}` } : p))
        }
      }

      // 整章意见：不需要选中文字，直接对本章提一条意见
      const openChapterOpinion = () => {
        if (!(Number(active) > 0)) return
        setPop({
          quote: '',
          chapter: Number(active),
          anchor: 'chapter',
          x: Math.max(12, Math.round((window.innerWidth || 1200) / 2 - 160)),
          y: Math.max(12, Math.round((window.innerHeight || 800) / 2 - 160)),
          issue: '',
          severity: 'minor',
          saving: false,
          error: '',
        })
      }

      // 派生数据
      const reviewsList = useMemo(
        () => toList(reviews.data, 'reviews').map((rv) => ({ ...rv, route: normalRoute(rv) })),
        [reviews.data],
      )
      const proposalsList = useMemo(
        () => toList(proposals.data, 'proposals').filter((p) => PROPOSAL_KINDS.includes(p.kind) && (!p.status || p.status === 'pending')),
        [proposals.data],
      )
      const chapterReviews = useMemo(() => reviewsList.filter((rv) => chapterNo(rv) === active), [reviewsList, active])
      const chapterProposals = useMemo(() => proposalsList.filter((p) => chapterNo(p) === active), [proposalsList, active])
      const readerNotes = chapterReviews.filter((rv) => rv.route === 'reader' && (!rv.status || rv.status === 'open'))
      const routeCounts = useMemo(() => {
        const counts = {}
        for (const route of ROUTES) counts[route.id] = 0
        for (const rv of chapterReviews) {
          if (rv.status && rv.status !== 'open') continue
          if (counts[rv.route] == null) counts[rv.route] = 0
          counts[rv.route] += 1
        }
        return counts
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [chapterReviews])

      const activeInfo = chapters.find((row) => chapterNo(row) === active) || null
      const activeAtt = attentionOf(context && context.attention, active)
      const activeTitle = activeInfo ? chapterTitle(activeInfo) : ''
      const tocRows = useMemo(() => {
        const q = tocFilter.trim()
        if (!q) return chapters
        return chapters.filter((row) => String(chapterNo(row)).includes(q) || chapterTitle(row).includes(q))
      }, [chapters, tocFilter])

      const registerRef = useCallback((chapter, el) => {
        if (el) secRefs.current[chapter] = el
      }, [])

      const tocByChapter = useMemo(() => {
        const map = {}
        for (const row of chapters) map[chapterNo(row)] = row
        return map
      }, [chapters])

      const editStateText = edit.saving
        ? '保存中…'
        : edit.dirty
          ? '未保存 · 2 秒后自动保存'
          : edit.savedAt
            ? `已保存 ${fmtClock(edit.savedAt)}`
            : '尚无改动'

      // textarea 有滚动条/内边距，镜像层必须用同一个内容宽度，否则换行位置不同 → 高亮会越来越偏
      useEffect(() => {
        const el = editorRef.current
        if (!el || typeof ResizeObserver === 'undefined') return undefined
        const update = () => setEditorWidth(el.clientWidth)
        update()
        const ro = new ResizeObserver(update)
        ro.observe(el)
        window.addEventListener('resize', update)
        return () => { ro.disconnect(); window.removeEventListener('resize', update) }
      }, [edit.chapter, mode, prefs.size, prefs.lead])

      // 编辑模式高亮：textarea 上叠一层文字透明的镜像层，只显示本地检查的段落底色与引文
      const editMarks = useMemo(
        () => (Array.isArray(pageArg && pageArg.marks) ? pageArg.marks : []).filter((m) => Number(m.chapter) === Number(edit.chapter)),
        [pageArg, edit.chapter],
      )
      const editorOverlay = useMemo(() => {
        const parsed = splitChapterText(edit.text, edit.meta && edit.meta.title ? String(edit.meta.title) : '')
        const spans = paragraphSpans(parsed.body)
        const byPara = new Map()
        for (const mark of editMarks) {
          if (mark && Number.isInteger(Number(mark.para))) byPara.set(Number(mark.para), mark)
        }
        const out = [edit.text.slice(0, parsed.bodyStart)]
        let cursor = 0
        spans.forEach((span, index) => {
          out.push(parsed.body.slice(cursor, span.start))
          const text = parsed.body.slice(span.start, span.end)
          const mark = byPara.get(index)
          if (!mark) {
            out.push(text)
          } else {
            const cls = `nd-edit-mark nd-edit-mark-${mark.kind === 'deai' ? 'deai' : 'logic'}`
            const quote = String(mark.quote || '')
            if (quote && text.includes(quote)) {
              const at = text.indexOf(quote)
              if (at > 0) out.push(h('span', { className: cls, key: `s${index}` }, text.slice(0, at)))
              out.push(h('mark', { className: 'nd-edit-hl', key: `q${index}` }, quote))
              if (at + quote.length < text.length) out.push(h('span', { className: cls, key: `e${index}` }, text.slice(at + quote.length)))
            } else {
              out.push(h('span', { className: cls, key: `s${index}` }, text))
            }
          }
          cursor = span.end
        })
        out.push(parsed.body.slice(cursor))
        return out
      }, [edit.text, edit.meta, editMarks])

      const selectEditMark = (mark) => {
        const el = editorRef.current
        if (!el || !mark) return
        const parsed = splitChapterText(edit.text, edit.meta && edit.meta.title ? String(edit.meta.title) : '')
        const spans = paragraphSpans(parsed.body)
        const para = Number(mark.para)
        const span = spans[para]
        if (!span) return
        let start = parsed.bodyStart + span.start
        let end = parsed.bodyStart + span.end
        const quote = String(mark.quote || '')
        if (quote) {
          const at = edit.text.indexOf(quote, start)
          if (at >= 0 && at < end) { start = at; end = at + quote.length }
        }
        el.focus()
        el.setSelectionRange(start, end)
      }
      const editMarkBar = editMarks.length
        ? h('div', { className: 'nd-edit-markbar' },
            h('span', { className: 'nd-hint' }, `本章问题 ${editMarks.length} 处（点段落号在编辑器中选中）：`),
            editMarks.map((mark, index) => h('button', {
              key: `${mark.para}-${index}`,
              type: 'button',
              className: `nd-edit-markchip ${mark.kind === 'deai' ? 'nd-edit-markchip-deai' : 'nd-edit-markchip-logic'}`,
              onClick: () => selectEditMark(mark),
              title: String(mark.message || ''),
            }, `第 ${Number(mark.para) + 1} 段`)),
          )
        : null

      const editorPane = h('div', { className: 'nd-edit' },
        immersive
          ? null
          : h('div', { className: 'nd-edit-bar' },
              h('strong', null, edit.chapter ? `第 ${edit.chapter} 章` : '选择章节'),
              h('span', { className: 'nd-hint nd-edit-title' }, edit.chapter ? chapterTitle(edit.meta) : ''),
              h('span', { className: 'nd-edit-state' }, editStateText),
              h('span', { className: 'nd-edit-words' }, `${fmtInt(countWords(edit.text))} 字`),
              h(Btn, { small: true, kind: 'primary', onClick: saveNow, disabled: edit.saving || !edit.dirty }, '保存（⌘S）'),
              h(Btn, { small: true, onClick: () => setHistoryChapter(edit.chapter), disabled: !edit.chapter }, '历史'),
            ),
        edit.stale
          ? h('div', { className: 'nd-banner nd-banner-warn' },
              h('span', null, '正文已在别处修改，重新加载后再编辑'),
              h(Btn, { small: true, onClick: reloadEdit }, '重新加载'),
            )
          : null,
        edit.error ? h(Msg, { tone: 'error' }, edit.error) : null,
        editMarkBar,
        h('div', { className: 'nd-editor-wrap' },
          h('div', { className: 'nd-editor-marks', ref: editorMarkRef, 'aria-hidden': true, style: { fontSize: `${prefs.size}px`, lineHeight: prefs.lead, ...(editorWidth ? { width: `${editorWidth}px`, right: 'auto' } : {}) } }, editorOverlay),
        h('textarea', {
          className: 'nd-editor',
          ref: editorRef,
          value: edit.text,
          spellCheck: false,
          placeholder: '本章还没有正文',
          style: { fontSize: `${prefs.size}px`, lineHeight: prefs.lead },
          onScroll: (e) => { if (editorMarkRef.current) editorMarkRef.current.scrollTop = e.target.scrollTop },
          onChange: (e) => {
            const value = e.target.value
            setEdit((state) => ({ ...state, text: value, dirty: true, error: '' }))
          },
          onKeyDown: (e) => {
            if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 's') {
              e.preventDefault()
              saveNow()
            }
          },
        }),
        ),
      )

      const bumpPref = (key, delta, min, max) =>
        setPrefs((prev) => {
          const next = { ...prev, [key]: Math.min(max, Math.max(min, Math.round((prev[key] + delta) * 100) / 100)) }
          lsSet(key === 'size' ? 'nd.fontSize' : 'nd.lineHeight', String(next[key]))
          return next
        })

      const pageMarks = Array.isArray(pageArg && pageArg.marks) ? pageArg.marks : []
      const readerBody = h('div', { className: 'nd-reader-body', onMouseUp: onReaderMouseUp, style: { fontSize: `${prefs.size}px`, lineHeight: prefs.lead } },
        pageMarks.length
          ? h('div', { className: 'nd-banner nd-banner-warn nd-mark-banner' },
              h('span', null, `已高亮本地检查 ${pageMarks.length} 处：黄＝去 AI 化，红＝事实逻辑；点「定位」会跳到对应段落`),
              h(Btn, { small: true, onClick: () => go('read', { chapter: active }) }, '清除高亮'),
            )
          : null,
        docs.length === 0 && docsLoading ? h(Loading, null, '正在加载全书正文…') : null,
        docsError ? h(ErrorBox, { error: docsError }) : null,
        docs.length === 0 && !docsLoading && !docsError
          ? h(Empty, null, '这本书还没有正文。可以让 AI 先写第一章。')
          : null,
        docs.map((doc) =>
          h(ChapterBlock, {
            key: doc.chapter,
            doc,
            info: tocByChapter[doc.chapter] || null,
            attention: context && context.attention,
            highlight,
            registerRef,
            focusOffset: jumpOffset && jumpOffset.chapter === doc.chapter && jumpOffset.offset >= 0 ? jumpOffset.offset : null,
            focusRef,
            marks: (Array.isArray(pageArg && pageArg.marks) ? pageArg.marks : []).filter((m) => Number(m.chapter) === Number(doc.chapter)),
          }),
        ),
        docs.length > 0 && docsLoading ? h('div', { className: 'nd-loading-more' }, `正在加载其余章节…（${docs.length}/${tocNums.length}）`) : null,
      )

      return h('div', { className: 'nd-read' },
        h('aside', { className: 'nd-toc' },
          h('div', { className: 'nd-toc-head' },
            h('div', { className: 'nd-toc-headline' },
              h('strong', null, '目录'), h('span', { className: 'nd-hint' }, `${chapters.length} 章`),
              h(Btn, { small: true, kind: 'ghost', onClick: createChapter, disabled: creating, title: '在最后新建一章（纯文本）' }, creating ? '新建中…' : '＋ 新章'),
            ),
          ),
          h(TextInput, { value: tocFilter, onChange: setTocFilter, placeholder: '过滤章节 / 标题' }),
          h('div', { className: 'nd-toc-list' },
            tocRows.length === 0
              ? h('p', { className: 'nd-muted' }, chapters.length ? '没有匹配的章节' : '还没有章节')
              : tocRows.map((row) => {
                  const n = chapterNo(row)
                  const att = attentionOf(context && context.attention, n)
                  const score = attentionScore(att)
                  const status = row.status || ''
                  return h('div', { key: n, className: `nd-toc-row${n === active ? ' nd-toc-active-row' : ''}` },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: `nd-toc-item${n === active ? ' nd-toc-active' : ''}`,
                        onClick: () => {
                          if (mode === 'edit') {
                            if (editRef.current.dirty) saveNow()
                            setActive(n)
                            openEdit(n)
                          } else {
                            scrollToChapter(n)
                          }
                        },
                      },
                      h('span', { className: 'nd-toc-no' }, String(n).padStart(2, '0')),
                      h('span', { className: 'nd-toc-main' }, h('span', { className: 'nd-toc-title' }, chapterTitle(row)), h('span', { className: 'nd-toc-sub' }, `${fmtWords(row.words)} 字`)),
                      h('span', { className: 'nd-toc-right' },
                        status ? h(Dot, { tone: CHAPTER_STATUS_TONE[status] || 'muted' }) : null,
                        score != null ? h('span', { className: `nd-score${score >= 70 ? ' nd-score-ok' : score >= 50 ? '' : ' nd-score-warn'}` }, score) : null,
                      ),
                    ),
                    h('button', { type: 'button', className: 'nd-toc-del', title: `删除第 ${n} 章`, onClick: (event) => { event.stopPropagation(); deleteActiveChapter(n) } }, '✕'),
                  )
                }),
          ),
          h('div', { className: 'nd-toc-foot' }, 'j / k 翻章 · / 搜索'),
        ),
        h('section', { className: 'nd-read-main' },
          h('div', { className: 'nd-read-head' },
            h('div', { className: 'nd-read-row' },
              immersive
                ? h('div', { className: 'nd-im-left' },
                    h('span', { className: 'nd-im-state' },
                      mode === 'edit'
                        ? (edit.saving ? '保存中…' : edit.dirty ? '未保存 · 自动保存中' : edit.savedAt ? `已保存 ${fmtClock(edit.savedAt)}` : '尚无改动')
                        : mode === 'reader'
                          ? '批注：选中文字 → 提交作者意见'
                          : active > 0 ? `第 ${active} 章 / ${chapters.length}` : ''),
                    h('span', { className: 'nd-im-size', role: 'group', 'aria-label': '字号' },
                      h('button', { type: 'button', className: 'nd-im-size-btn', title: '字号减小（A−）', onClick: () => bumpPref('size', -1, 13, 28) }, '−'),
                      h('span', { className: 'nd-im-size-val' }, String(prefs.size)),
                      h('button', { type: 'button', className: 'nd-im-size-btn', title: '字号增大（A+）', onClick: () => bumpPref('size', 1, 13, 28) }, '+'),
                    ),
                  )
                : null,
              h(Seg, { value: mode, onChange: switchMode, items: MODES.map((m) => ({ value: m.id, label: m.label })) }),
              mode === 'edit' ? null : h('span', { className: 'nd-read-prefs' },
                h(Btn, { small: true, onClick: () => bumpPref('size', -1, 13, 28) }, 'A−'),
                h(Btn, { small: true, onClick: () => bumpPref('size', 1, 13, 28) }, 'A+'),
                h(Btn, { small: true, onClick: () => bumpPref('lead', 0.15, 1.6, 2.4) }, '行距'),
              ),
              h(Btn, { small: true, onClick: openChapterOpinion, title: '整章意见：不用选中文字，直接对本章提意见' }, '📄 整章意见'),
              h(Btn, { small: true, onClick: () => active > 0 && setHistoryChapter(active) }, '历史版本'),
              immersive
                ? null
                : h(Btn, { small: true, className: 'nd-im-toggle', onClick: () => setImmersive(true), title: '沉浸模式：只留阅读 / 编辑 / 批注三个按钮，正文接近全屏（Esc 退出）' }, '⛶ 沉浸'),
              h('span', { className: 'nd-read-pos' }, active > 0 ? `第 ${active} 章 / ${chapters.length}` : ''),
              h('span', { className: 'nd-hint nd-mode-legend' },
                mode === 'read'
                  ? '阅读＝纯读，不会改正文 · j/k 翻章 · / 搜索'
                  : mode === 'reader'
                    ? '批注＝选中正文文字提交作者意见，不改正文'
                    : '编辑＝直接修改正文 · 2 秒自动保存 · ⌘S 立即保存'),
              immersive
                ? h('button', { type: 'button', className: 'nd-im-exit', onClick: () => setImmersive(false), title: '退出沉浸（Esc）' },
                    h('span', { className: 'nd-im-exit-icon' }, '⤢'),
                    h('span', { className: 'nd-im-exit-text' }, '退出沉浸'),
                  )
                : null,
            ),
            mode !== 'edit'
              ? h('div', { className: 'nd-search' },
                  h('input', {
                    ref: searchRef,
                    className: 'nd-input nd-search-input',
                    value: search,
                    placeholder: '全文搜索…（Enter 搜索）',
                    onChange: (e) => setSearch(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') doSearch()
                      if (e.key === 'Escape') {
                        setResults(null)
                        setSearch('')
                      }
                    },
                  }),
                  h(Btn, { small: true, onClick: doSearch, disabled: searching }, searching ? '搜索中…' : '搜索'),
                  highlight ? h('button', { type: 'button', className: 'nd-linkbtn', onClick: () => { setHighlight(''); setSearch(''); setResults(null) } }, '清除高亮') : null,
                  results
                    ? h('div', { className: 'nd-results' },
                        searchError ? h(Msg, { tone: 'error' }, searchError) : null,
                        !searchError && results.length === 0 ? h('p', { className: 'nd-muted' }, '没有找到匹配段落') : null,
                        results.slice(0, 60).map((row, index) =>
                          h('button', { key: index, type: 'button', className: 'nd-result', onClick: () => jumpToResult(row) },
                            h('span', { className: 'nd-result-ch' }, `第 ${chapterNo(row) || row.chapter || '?'} 章`),
                            h('span', { className: 'nd-result-text' }, String(row.snippet || row.text || row.quote || '')),
                          ),
                        ),
                      )
                    : null,
                )
              : null,
            notice ? h(Msg, { tone: highlight ? 'info' : 'info', onClose: () => setNotice('') }, notice) : null,
          ),
          h('div', { className: 'nd-reader-scroll', ref: scrollRef, onScroll }, mode === 'edit' ? editorPane : readerBody),
        ),
        h('aside', { className: 'nd-side' },
          h(
            SideSection,
            { title: '本章' },
            h('div', { className: 'nd-side-titleline' }, h('strong', null, active > 0 ? `第 ${active} 章` : '未选择'), h('span', null, activeTitle)),
            h('div', { className: 'nd-kv' },
              h('span', null, '状态'), h('span', null, activeInfo && activeInfo.status ? (CHAPTER_STATUS[activeInfo.status] || activeInfo.status) : '—'),
              h('span', null, '字数'), h('span', null, activeInfo ? fmtInt(activeInfo.words) : '—'),
              h('span', null, '更新时间'), h('span', null, activeInfo ? fmtAgo(activeInfo.updatedAt) : '—'),
            ),
            h(AttentionBars, { row: activeAtt, chapter: active, projectId, onSaved: onChanged }),
            h('div', { className: 'nd-actions', style: { flexWrap: 'wrap' } },
              h(Btn, { small: true, onClick: () => go('reviews', { coldChapter: active }) }, '❄️ 冷读本章'),
              h(Btn, { small: true, onClick: () => go('reviews', { ask: 'logic', chapter: active }) }, '⚖️ 逻辑审核本章'),
              h(Btn, { small: true, onClick: () => go('reviews', { ask: 'ai-style', chapter: active }) }, '🤖 去 AI 化本章'),
            ),
          ),
          h(
            SideSection,
            { title: '意见统计', extra: h('span', { className: 'nd-hint' }, `${chapterReviews.filter((r) => !r.status || r.status === 'open').length} 条待处理`) },
            h('div', { className: 'nd-routes' },
              ROUTES.map((route) =>
                h('button', { key: route.id, type: 'button', className: 'nd-route-row', onClick: () => go('reviews', { source: route.id, chapter: active }) },
                  h('span', { className: 'nd-route-name' }, `${route.icon} ${route.label}`),
                  h('span', { className: `nd-route-count${routeCounts[route.id] ? ' nd-route-hot' : ''}` }, routeCounts[route.id] || 0),
                ),
              ),
            ),
            readerNotes.length
              ? h('div', { className: 'nd-notes' },
                  h('div', { className: 'nd-side-sub' }, '作者意见'),
                  readerNotes.slice(0, 3).map((note) => h('div', { key: note.id, className: 'nd-note' }, h('div', { className: 'nd-note-quote' }, String(note.quote || '').slice(0, 60)), h('div', null, String(note.issue || '')))),
                )
              : null,
          ),
          h(
            SideSection,
            { title: '待批准提案', extra: h('span', { className: 'nd-hint' }, `${chapterProposals.length} 条`) },
            chapterProposals.length === 0
              ? h('p', { className: 'nd-muted' }, '本章没有待批准提案。')
              : chapterProposals.slice(0, 5).map((p) =>
                  h('button', { key: p.id, type: 'button', className: 'nd-proposal-mini', onClick: () => go('proposals') },
                    h('span', { className: 'nd-proposal-mini-title' }, String(p.title || '未命名提案')),
                    h(Tag, null, PROPOSAL_KIND[p.kind] || p.kind),
                  ),
                ),
          ),
          h(
            SideSection,
            { title: '动作' },
            h('div', { className: 'nd-actions' },
              h(Btn, { small: true, kind: 'primary', onClick: () => setRunDialog({ kind: 'continue', scope: 'chapter', chapter: (tocNums.length ? Math.max(...tocNums) : 0) + 1, title: `从头写第 ${(tocNums.length ? Math.max(...tocNums) : 0) + 1} 章` }) }, '从头写下一章'),
              h(Btn, { small: true, onClick: () => setRunDialog({ kind: 'expand', scope: 'chapter', chapter: active, title: `续写第 ${active} 章` }) }, '续写本章'),
              h(Btn, { small: true, onClick: () => setRunDialog({ kind: 'rewrite', variant: 'logic', scope: 'chapter', chapter: active, title: `重写第 ${active} 章` }) }, '重写本章'),
              active > 0
                ? h(Btn, { small: true, kind: 'danger', disabled: deletingChapter, onClick: () => deleteActiveChapter(active) }, deletingChapter ? '删除中…' : '删除本章')
                : null,
            ),
            h('p', { className: 'nd-hint' }, '「从头写下一章」会直接让 AI 写新章并落盘（过闸门）；续写/重写只创建全文动作，产物进提案。'),
          ),
        ),
        pop
          ? h('div', {
              className: 'nd-note-pop',
              // 手机上贴着底边当成批注面板（内联样式优先于媒体查询里的 left/right/bottom）
              style: typeof window !== 'undefined' && window.innerWidth <= 900
                ? { left: '10px', right: '10px', bottom: 'calc(10px + env(safe-area-inset-bottom,0px))', top: 'auto', width: 'auto' }
                : { left: `${pop.x}px`, top: `${pop.y}px` },
            },
              h('div', { className: 'nd-note-pop-head' }, `第 ${pop.chapter} 章 · ${pop.anchor === 'chapter' ? '整章意见' : '加批注'}`),
              pop.quote ? h('div', { className: 'nd-note-quote' }, String(pop.quote).slice(0, 90)) : null,
              h(TextArea, {
                value: pop.issue,
                rows: 3,
                placeholder: '这条批注想说什么？',
                onChange: (value) => setPop((p) => (p ? { ...p, issue: value } : p)),
              }),
              h(Select, {
                value: pop.severity,
                onChange: (value) => setPop((p) => (p ? { ...p, severity: value } : p)),
                options: SEVERITIES.map((s) => ({ value: s.id, label: s.label })),
              }),
              pop.error ? h(Msg, { tone: 'error' }, pop.error) : null,
              h('div', { className: 'nd-note-actions' },
                h(Btn, { small: true, onClick: () => setPop(null) }, '取消'),
                h(Btn, { small: true, kind: 'primary', onClick: submitNote, disabled: pop.saving }, pop.saving ? '提交中…' : '提交批注'),
              ),
            )
          : null,
        runDialog
          ? h(RunDialog, {
              projectId,
              toc,
              defaults: runDialog,
              onClose: () => setRunDialog(null),
              onCreated: () => {
                setRunDialog(null)
                go('run')
              },
            })
          : null,
        historyChapter
          ? h(HistoryDialog, {
              projectId,
              chapter: historyChapter,
              onClose: () => setHistoryChapter(0),
              onLoad: (text) => {
                setHistoryChapter(0)
                setEdit((state) => ({ ...state, text, dirty: true, error: '', stale: false }))
                setNotice('已载入历史版本；保存后会写入正文，当前内容会先进入历史。')
              },
            })
          : null,
      )
    }

    function SideSection({ title, extra, children }) {
      return h('section', { className: 'nd-side-sec' },
        h('div', { className: 'nd-side-head' }, h('span', { className: 'nd-side-title' }, title), extra || null),
        children,
      )
    }

    function AttentionBars({ row, chapter, projectId, onSaved }) {
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState({})
      const [verdict, setVerdict] = useState('')
      const [weakest, setWeakest] = useState('')
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const beats = attentionBeats(row)
      const score = attentionScore(row)
      const canEdit = !!(projectId && chapter)
      const startEdit = () => {
        // 冷读只记一个分数：四拍不再是评价标准
        setDraft({ score: String(score == null ? '' : score) })
        setVerdict(String((row && row.verdict) || ''))
        setWeakest('')
        setError('')
        setEditing(true)
      }
      const save = async () => {
        if (!canEdit) return
        setSaving(true)
        setError('')
        try {
          await api('attention.merge', scope(projectId, { chapter, patch: { score: clamp(toNumber(draft.score, 0), 0, 100), verdict: verdict.trim() } }))
          setEditing(false)
          if (onSaved) onSaved()
        } catch (err) {
          setError(friendlyError(err))
        } finally {
          setSaving(false)
        }
      }

      if (editing) {
        return h('div', { className: 'nd-att' },
          h('div', { className: 'nd-att-row' },
            h('span', { className: 'nd-att-label' }, '注意力'),
            h(TextInput, {
              type: 'number',
              value: draft.score,
              onChange: (value) => setDraft({ score: value }),
            }),
            h('span', { className: 'nd-att-val' }, '/ 100'),
          ),
          h(TextInput, { value: verdict, placeholder: '下一章意愿：会 / 犹豫 / 不会', onChange: setVerdict }),
          h('p', { className: 'nd-hint' }, '冷读只记一个分数 + 地址评价；四拍不再评价正文。'),
          error ? h(Msg, { tone: 'error' }, error) : null,
          h('div', { className: 'nd-actions' },
            h(Btn, { small: true, kind: 'primary', onClick: save, disabled: saving }, saving ? '保存中…' : '保存实测'),
            h(Btn, { small: true, onClick: () => setEditing(false) }, '取消'),
          ),
        )
      }

      return h('div', { className: 'nd-att' },
        row
          ? h(
              Fragment,
              null,
              h('div', { className: 'nd-att-score' },
                h('strong', null, score == null ? '—' : score),
                h('span', null, '/ 100 注意力（冷读）'),
              ),
              row.verdict ? h('p', { className: 'nd-hint' }, `下一章意愿：${row.verdict}`) : null,
              Array.isArray(row.points) && row.points.length
                ? h('div', { className: 'nd-att-points' },
                    row.points.map((point, index) => h('div', { className: 'nd-att-point', key: index },
                      h(Tag, { tone: point.kind === 'highlight' ? 'ok' : 'warn' }, point.kind === 'highlight' ? '高光' : '不足'),
                      h('span', { className: 'nd-hint' }, point.para == null ? '' : `第 ${Number(point.para) + 1} 段`),
                      h('p', { className: 'nd-att-point-text' }, String(point.comment || '')),
                      point.quote ? h('p', { className: 'nd-hint' }, `原文：${String(point.quote).slice(0, 40)}`) : null,
                    )),
                  )
                : h('p', { className: 'nd-hint' }, '还没有地址评价（冷读只给分数与亮点/不足）。'),
            )
          : h('p', { className: 'nd-muted nd-att-empty' }, '本章还没有注意力记录'),
        canEdit ? h('div', { className: 'nd-actions' }, h(Btn, { small: true, onClick: startEdit }, row ? '改实测分' : '记录实测分')) : null,
      )
    }

    // 全本连续渲染：memo 避免滚动切换当前章时重渲染所有章节
    const ChapterBlock = memo(function ChapterBlock({ doc, info, attention, highlight, registerRef, focusOffset, focusRef, marks }) {
      // 0.7：编辑器只渲染 .txt 原文。首行标题原样显示；不再由代码拼「第 N 章」、状态、注意力、字数。
      const meta = doc.meta || {}
      const metaTitle = (info && chapterTitle(info)) || (meta.title ? String(meta.title) : '')
      const parsed = useMemo(() => splitChapterText(doc.text, metaTitle), [doc.text, metaTitle])
      const paragraphs = useMemo(() => splitParagraphs(parsed.body), [parsed.body])
      const spans = useMemo(() => paragraphSpans(parsed.body), [parsed.body])
      const localOffset = focusOffset == null ? -1 : Number(focusOffset) - parsed.bodyStart
      const target = localOffset < 0 ? -1 : spans.findIndex((span) => localOffset >= span.start && localOffset < span.end)
      const markByPara = new Map()
      for (const mark of Array.isArray(marks) ? marks : []) {
        if (mark && Number.isInteger(Number(mark.para))) markByPara.set(Number(mark.para), mark)
      }
      return h(
        'section',
        {
          className: 'nd-chapter',
          'data-ch': String(doc.chapter),
          ref: (el) => registerRef(doc.chapter, el),
        },
        parsed.title
          ? h('h3', { className: 'nd-ch-title nd-ch-title-text' }, parsed.title)
          : (metaTitle ? h('h3', { className: 'nd-ch-title nd-ch-title-meta', title: '标题尚未写入正文（迁移后可直接选中批注）', style: { userSelect: 'none' } }, metaTitle) : null),
        doc.error ? h('div', { className: 'nd-errorline' }, `正文读取失败：${doc.error}`) : null,
        paragraphs.length === 0 && !doc.error ? h('p', { className: 'nd-muted' }, '（本章暂无正文）') : null,
        paragraphs.map((paragraph, index) => {
          const mark = markByPara.get(index)
          const className = `nd-para${index === target ? ' nd-target' : ''}${mark ? ` nd-mark nd-mark-${mark.kind === 'deai' ? 'deai' : 'logic'}` : ''}`
          return h('p', {
            className,
            key: index,
            title: mark ? String(mark.message || '') : undefined,
            ref: index === target && focusRef ? (el) => { focusRef.current = el } : undefined,
          }, ...renderSegments(paragraph, mark && mark.quote ? String(mark.quote) : highlight))
        }),
      )
    })

    // 章节历史：列出备份版本、预览、载入编辑器（写入仍走唯一的 saveChapter 闸门）
    function HistoryDialog({ projectId, chapter, onClose, onLoad }) {
      const history = useAsync(() => api('chapter.history', scope(projectId, { chapter })), [projectId, chapter])
      const [preview, setPreview] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const rows = toList(history.data, 'versions')

      const load = async (row) => {
        setBusy(String(row.version))
        setError('')
        try {
          const value = await api('chapter.version', scope(projectId, { chapter, version: row.version }))
          setPreview({ version: row.version, savedAt: row.savedAt, text: docText(value) })
        } catch (err) {
          setError(friendlyError(err))
        } finally {
          setBusy('')
        }
      }

      return h(
        Modal,
        {
          title: `第 ${chapter} 章 · 历史版本`,
          onClose,
          wide: true,
          footer: h(Fragment, null,
            h(Btn, { onClick: onClose }, '关闭'),
            preview ? h(Btn, { kind: 'primary', onClick: () => onLoad(preview.text) }, '载入编辑器') : null,
          ),
        },
        error ? h(Msg, { tone: 'error' }, error) : null,
        history.loading && !history.data ? h(Loading, null, '正在读取历史…') : null,
        history.error ? h(ErrorBox, { error: history.error, onRetry: history.reload }) : null,
        !history.loading && !history.error && rows.length === 0
          ? h(Empty, null, '还没有历史版本。每次保存时若正文有变化，会自动备份上一版。')
          : null,
        rows.length ? h('div', { className: 'nd-history' }, rows.map((row) => h('button', {
          key: String(row.version), type: 'button', disabled: busy === String(row.version),
          className: `nd-history-row${preview && preview.version === row.version ? ' nd-history-active' : ''}`,
          onClick: () => { void load(row) },
        },
          h('span', { className: 'nd-history-time' }, fmtClock(row.savedAt) || String(row.savedAt || row.version)),
          h('span', { className: 'nd-history-meta' }, `${fmtBytes(row.bytes)} · ${row.source === '0.5' ? '旧插件备份' : '0.6 备份'}`),
          h('span', { className: 'nd-hint' }, fmtAgo(row.savedAt)),
        ))) : null,
        preview
          ? h('div', { className: 'nd-diff-col' },
              h('div', { className: 'nd-diff-head' }, `预览 ${fmtClock(preview.savedAt) || ''}`),
              h('pre', { className: 'nd-pre nd-pre-tall' }, String(preview.text || '（空）')),
            )
          : null,
      )
    }

    // 章节勾选器：审阅/复测范围一律由用户自己选，不预设章数
    function ChapterPicker({ chapters, stats, value, onChange }) {
      const picked = new Set(value)
      const toggleChapter = (n) => onChange(picked.has(n) ? value.filter((x) => x !== n) : [...value, n].sort((a, b) => a - b))
      if (!chapters.length) return h('p', { className: 'nd-hint' }, '这本书还没有章节：先写正文，再回来审。')
      return h('div', { className: 'nd-chapter-picker', style: { maxHeight: '260px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' } },
        chapters.map((row) => {
          const stat = stats.get(row.chapter)
          const mark = stat && stat.open ? ` ｜ ${stat.open} 条待处理` : stat ? ' ｜ 已审' : ' ｜ 未审'
          return h('label', { key: row.chapter, className: 'nd-form-row nd-picker-row' },
            h(Check, { checked: picked.has(row.chapter), onChange: () => toggleChapter(row.chapter) }),
            h('span', null, `第 ${row.chapter} 章${row.title ? ` · ${row.title}` : ''}`),
            h('span', { className: 'nd-hint' }, `${Number(row.words) || 0} 字${mark}`),
          )
        }),
      )
    }

    // ── 意见页 ────────────────────────────────────────────────
    // ── 大纲页：用户可改；AI 通过 ledger-fix 提案改，批准后入库 ──
    function OutlinesPage({ projectId, onChanged }) {
      const res = useAsync(() => api('outline.list', scope(projectId)), [projectId])
      const rows = res.data && Array.isArray(res.data.outlines) ? res.data.outlines : []
      const [form, setForm] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const save = async () => {
        if (!form || busy) return
        setBusy(true); setNotice(null)
        try {
          await api('outline.upsert', scope(projectId, { item: form }))
          setForm(null)
          res.reload()
          if (onChanged) onChanged()
          setNotice({ tone: 'ok', text: '大纲已保存' })
        } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }) }
        finally { setBusy(false) }
      }
      const remove = async (chapter) => {
        if (!window.confirm(`删除第 ${chapter} 章大纲？正文不受影响。`)) return
        setNotice(null)
        try { await api('outline.delete', scope(projectId, { chapter })); res.reload(); if (onChanged) onChanged(); setNotice({ tone: 'ok', text: '已删除' }) }
        catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }) }
      }
      const nextChapter = () => {
        const used = new Set(rows.map((row) => Number(row.chapter)))
        let n = 1
        while (used.has(n)) n += 1
        return n
      }
      return h('div', { className: 'nd-page' },
        h('div', { className: 'nd-page-head' },
          h('div', null,
            h('h2', null, '大纲'),
            h('p', { className: 'nd-hint' }, '大纲存在数据库里，是全文写作、章节写作、章节改写、全文改写的输入。你可以直接改；AI 只能通过账本修订（ledger-fix）提案改，批准后才入库。')),
          h('div', { className: 'nd-page-actions' },
            h(Btn, { small: true, onClick: res.reload, disabled: res.loading }, '刷新'),
            h(Btn, { small: true, kind: 'primary', onClick: () => setForm({ chapter: nextChapter(), title: '', summary: '', status: 'planned' }) }, '＋ 新增大纲'),
          ),
        ),
        notice ? h(Msg, { tone: notice.tone, onClose: () => setNotice(null) }, notice.text) : null,
        res.error ? h(ErrorBox, { error: res.error, onRetry: res.reload }) : null,
        !rows.length && !res.loading ? h('p', { className: 'nd-hint' }, '还没有大纲。可以手写一行，或在「账本 → 全书同步」让 AI 根据正文补；新书生成的大纲也会落到这里。') : null,
        h('div', { className: 'nd-outline-list' },
          rows.map((row) => h('div', { className: 'nd-outline-row', key: row.chapter },
            h('div', { className: 'nd-outline-head' },
              h('strong', null, `第 ${row.chapter} 章`),
              h('span', { className: 'nd-outline-title' }, row.title || '（未命名）'),
              h(Tag, { tone: 'muted' }, row.status || '—'),
              h(Btn, { small: true, onClick: () => setForm({ ...row }) }, '编辑'),
              h(Btn, { small: true, onClick: () => remove(row.chapter) }, '删除'),
            ),
            row.summary ? h('p', { className: 'nd-hint nd-outline-summary' }, row.summary) : null,
          )),
        ),
        form ? h(Modal, {
          title: form.chapter ? `第 ${form.chapter} 章大纲` : '新增大纲',
          onClose: () => setForm(null),
          footer: h(Fragment, null,
            h(Btn, { onClick: () => setForm(null) }, '取消'),
            h(Btn, { kind: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          ),
        },
          h(Field, { label: '章号' }, h(TextInput, { type: 'number', value: form.chapter, onChange: (v) => setForm({ ...form, chapter: toNumber(v, 0) }) })),
          h(Field, { label: '标题' }, h(TextInput, { value: form.title, onChange: (v) => setForm({ ...form, title: v }) })),
          h(Field, { label: '状态' }, h(TextInput, { value: form.status, onChange: (v) => setForm({ ...form, status: v }), placeholder: 'planned / draft / done' })),
          h(Field, { label: '摘要' }, h(TextArea, { rows: 5, value: form.summary, onChange: (v) => setForm({ ...form, summary: v }) })),
        ) : null,
      )
    }

    // ── 意见页：AI 意见 / 作者意见 分开；AI 意见分 去AI化 / 事实逻辑 / 注意力（冷读）──
    function OpinionsPage({ projectId, toc, pageArg, openChapter, openChapterAt, go, onChanged }) {
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState('')
      const [who, setWho] = useState('ai')
      const [cat, setCat] = useState('all')
      const [status, setStatus] = useState('all')
      const [picked, setPicked] = useState([])
      const [noteFor, setNoteFor] = useState('')
      const [noteText, setNoteText] = useState('')
      const [suggestFor, setSuggestFor] = useState('')
      const [suggestRole, setSuggestRole] = useState('')
      const [suggestText, setSuggestText] = useState('')
      const [suggestScope, setSuggestScope] = useState('ai')
      const [suggestDecision, setSuggestDecision] = useState('')
      const [coldOpen, setColdOpen] = useState(Boolean(pageArg && pageArg.recheck))
      const [coldFocus, setColdFocus] = useState('')
      const [workorder, setWorkorder] = useState(null)
      const [target, setTarget] = useState('')
      const res = useAsync(() => api('opinions.list', scope(projectId)), [projectId])
      // 本地检查只在作者点「扫描」时跑；结果按作品缓存到 localStorage，切页/重进不用重扫
      const LOCAL_CACHE_VERSION = 2
      const localCacheKey = `nd.localChecks.${projectId}`
      const readLocalCache = () => {
        try {
          const raw = lsGet(localCacheKey, '')
          const value = raw ? JSON.parse(raw) : null
          return value && value.version === LOCAL_CACHE_VERSION && Array.isArray(value.items) ? value : null
        } catch { return null }
      }
      const [localChecks, setLocalChecks] = useState(readLocalCache)
      const [localScanning, setLocalScanning] = useState(false)
      const localFormatAt = (value) => {
        const stamp = value && value.scannedAt ? new Date(value.scannedAt) : null
        return stamp && !Number.isNaN(stamp.getTime()) ? stamp.toLocaleString() : ''
      }
      const [localAt, setLocalAt] = useState(() => localFormatAt(readLocalCache()))
      const rows = res.data && Array.isArray(res.data.rows) ? res.data.rows : []
      const counts = (res.data && res.data.counts) || {}
      const titleOf = (chapter) => {
        const row = (toc || []).find((item) => chapterNo(item) === Number(chapter))
        return row ? chapterTitle(row) : ''
      }
      const categoryOf = (row) => {
        const role = String(row.role || '')
        if (role === 'ai-style' || role === 'AI 味' || role === '去AI化') return 'ai-style'
        if (role === 'logic' || role === '事实逻辑' || role === '逻辑') return 'logic'
        if (role === '冷读审稿人' || role === 'attention' || role === '注意力') return 'attention'
        if (row.kind === 'highlight') return 'attention'
        return 'ai-style'
      }
      const sourceRows = rows.filter((row) => (who === 'author' ? row.origin === 'user' : row.origin !== 'user'))
      const filtered = sourceRows.filter((row) => {
        if (who === 'ai' && cat !== 'all' && categoryOf(row) !== cat) return false
        if (status !== 'all' && String(row.status) !== status) return false
        return true
      })
      const STATUS_LABEL = { open: '待处理', accepted: '已采纳', rejected: '已驳回', merged: '已合并', stale: '失效', resolved: '已处理' }
      const groups = []
      const map = new Map()
      for (const row of filtered) {
        const key = `${row.chapter}:${row.para == null ? 'x' : row.para}`
        if (!map.has(key)) {
          map.set(key, { key, chapter: row.chapter, para: row.para, opinions: [] })
          groups.push(map.get(key))
        }
        map.get(key).opinions.push(row)
      }
      const reload = () => { res.reload(); if (onChanged) onChanged() }
      const itemParas = (row) => (Array.isArray(row?.paras) && row.paras.length ? row.paras : [row?.para]).filter((p) => Number.isInteger(Number(p))).map(Number)
      const itemMarks = (row) => itemParas(row).map((para) => ({ chapter: row.chapter, para, quote: row.quote, kind: row.kind, message: row.message }))
      const scanLocal = async () => {
        if (!projectId || localScanning) return
        setLocalScanning(true); setNotice(null)
        try {
          const value = await api('checks.local', scope(projectId))
          const saved = { ...(value || { items: [], counts: {} }), version: LOCAL_CACHE_VERSION, scannedAt: new Date().toISOString() }
          setLocalChecks(saved)
          setLocalAt(localFormatAt(saved))
          try { lsSet(localCacheKey, JSON.stringify(saved)) } catch { /* 存不下就只留内存 */ }
        } catch (error) {
          setNotice({ tone: 'error', text: friendlyError(error) })
        } finally { setLocalScanning(false) }
      }
      const toggle = (id) => setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
      const accept = async (id) => {
        setBusy(id); setNotice(null)
        try {
          const value = await api('opinions.accept', scope(projectId, { id }))
          if (value && value.applied) setNotice({ tone: 'ok', text: `已定位第 ${value.applied.chapter} 章第 ${Number(value.applied.para) + 1} 段并替换（相似度 ${value.applied.score}%）${value.resolved ? `；同时把 ${value.resolved} 条相关意见标为已处理` : ''}` })
          else setNotice({ tone: 'ok', text: `已采纳${value && value.resolved ? `；同时把 ${value.resolved} 条相关意见标为已处理` : ''}` })
          reload()
        }
        catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }); reload() }
        finally { setBusy('') }
      }
      const reject = async (id) => {
        setBusy(id); setNotice(null)
        try { await api('opinions.reject', scope(projectId, { id })); setNotice({ tone: 'ok', text: '已驳回' }); reload() }
        catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }) }
        finally { setBusy('') }
      }
      const mergePicked = async (group) => {
        const ids = group.opinions.filter((row) => picked.includes(row.id)).map((row) => row.id)
        if (ids.length < 2) return
        const text = window.prompt('合并后的意见（可修改）：', group.opinions.filter((row) => ids.includes(row.id)).map((row) => `· ${row.text}`).join('\n'))
        if (text == null) return
        setBusy('merge'); setNotice(null)
        try { await api('opinions.merge', scope(projectId, { ids, text })); setPicked([]); setNotice({ tone: 'ok', text: '已合并成一条意见' }); reload() }
        catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }) }
        finally { setBusy('') }
      }
      const chaptersForWorkorder = () => (toc || []).map((row) => ({ chapter: chapterNo(row), title: chapterTitle(row), words: Number(row.words) || 0, path: row.path || row.file || '' })).filter((row) => row.chapter > 0)
      const makeColdWorkorder = async () => {
        if (busy) return
        setBusy('cold'); setNotice(null)
        try {
          const value = await api('coldRead.prepare', scope(projectId, { scope: 'book' }))
          const sent = await sendToChat(projectId, { prompt: String(value.prompt || ''), preferContext: true })
          setColdOpen(false)
          setNotice({
            tone: 'ok',
            text: `已导出全文稿（${value.words} 字）并发给对话：${value.filePath}${sent && sent.created ? '（新开对话）' : ''}。AI 会一次读完并直接回答评分/接纳/不足。`,
          })
        } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }) }
        finally { setBusy('') }
      }
      const coldReadChapter = async (chapter) => {
        if (!projectId || busy) return
        setBusy(`cold-${chapter}`); setNotice(null)
        try {
          const value = await api('coldRead.prepare', scope(projectId, { scope: 'chapter', chapter }))
          const sent = await sendToChat(projectId, { prompt: String(value.prompt || '') })
          setNotice({ tone: 'ok', text: `已导出第 ${chapter} 章（${value.words} 字）并发给对话${sent && sent.created ? '（新开对话）' : ''}。` })
        } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }) }
        finally { setBusy('') }
      }
      const splitColdReadLocal = async (row) => {
        if (!projectId || busy) return
        const lines = String(row.text || '').split('\n').map((line) => line.trim()).filter(Boolean)
        const items = []
        for (const line of lines) {
          const hit = line.match(/^第\s*(\d+)\s*章[:：]\s*(.+)$/)
          if (!hit) continue
          items.push({ chapter: Number(hit[1]), text: hit[2].slice(0, 200) })
        }
        if (!items.length) { setNotice({ tone: 'warn', text: '这条冷读没有带章号的条目，先点「按章拆分」让 AI 拆。' }); return }
        setBusy(`splitlocal-${row.id}`); setNotice(null)
        try {
          const value = await api('coldRead.splitLocal', scope(projectId, { id: row.id, items }))
          setNotice({ tone: 'ok', text: `已拆出 ${value.added} 条按章子意见，进待处理。` })
          res.reload()
        } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }) }
        finally { setBusy('') }
      }
      const splitColdRead = async (row) => {
        if (!projectId || busy) return
        setBusy(`split-${row.id}`); setNotice(null)
        try {
          const value = await api('coldRead.split', scope(projectId, { id: row.id }))
          const prompt = String(value.prompt || '')
          setWorkorder({ title: '冷读意见 · 按章拆分工作单', text: prompt, sending: false })
          await sendToChat(projectId, { prompt, preferContext: true }).catch(() => {})
          setNotice({ tone: 'ok', text: '已把拆分工作单发到对话：AI 会按章拆成子意见，进意见页待处理。' })
        } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }) }
        finally { setBusy('') }
      }
      const sendWorkorder = async () => {
        if (!workorder) return
        setWorkorder((prev) => (prev ? { ...prev, sending: true } : prev))
        try {
          await sendToChat(projectId, { prompt: workorder.text }, target)
          const parentId = workorder.parentId
          setWorkorder(null)
          if (parentId) {
            await api('opinions.patch', scope(projectId, { id: parentId, patch: { status: 'resolved' } })).catch(() => null)
            setNotice({ tone: 'ok', text: '已发到对话；原意见转出为「已随处理」，新建议会进待处理。' })
          } else {
            setNotice({ tone: 'ok', text: '冷读工作单已发到对话' })
          }
        } catch (error) {
          setWorkorder((prev) => (prev ? { ...prev, sending: false } : prev))
          setNotice({ tone: 'error', text: friendlyError(error) })
        }
      }
      const makeReviewWorkorder = async (source, chapterList = [], focus = '') => {
        if (!projectId || busy) return
        setBusy(`review-${source}`)
        setNotice(null)
        try {
          const allRows = chaptersForWorkorder()
          const rows = Array.isArray(chapterList) && chapterList.length
            ? allRows.filter((row) => chapterList.map(Number).includes(row.chapter))
            : allRows
          if (!rows.length) { setNotice({ tone: 'warn', text: '没有可审核的章节' }); return }
          const value = await api('chat.send', { projectId, workorder: 'reviewWorkorder', chapters: rows, sources: [source], focus: focus || undefined, dryRun: true })
          const label = source === 'logic' ? '逻辑审核' : source === 'ai-style' ? '去 AI 化' : '审核'
          const scopeLabel = Array.isArray(chapterList) && chapterList.length ? `第 ${chapterList.map(Number).join('、')} 章` : `全文（${rows.length} 章）`
          setWorkorder({ title: `${scopeLabel} ${label}工作单`, text: String(value.prompt || ''), sending: false, parentId: row.id })
        } catch (error) {
          setNotice({ tone: 'error', text: friendlyError(error) })
        } finally {
          setBusy('')
        }
      }

      const saveNote = async (id) => {
        setBusy(`note-${id}`); setNotice(null)
        try {
          await api('opinions.note', scope(projectId, { id, note: noteText }))
          setNoteFor(''); setNoteText('')
          setNotice({ tone: 'ok', text: '已保存你的建议' })
          res.reload()
        } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }) }
        finally { setBusy('') }
      }
      const ROLE_TO_SOURCE = { continuity: 'logic', 'ai-auditor': 'ai-style', 'cold-reader': 'attention', stylist: 'reader' }
      const SUGGEST_ROLES = [
        { id: 'author', name: '作者', hint: '从人物/剧情意图出发，给出具体改法' },
        { id: 'editor', name: '责任编辑', hint: '判断值不值得改、改哪、怎么改' },
        { id: 'continuity', name: '事实逻辑设计师', hint: '因果 / 动机 / 连续性 / 设定矛盾' },
        { id: 'ai-auditor', name: '审核 AI 化的 AI', hint: 'AI 味 / 套话 / 文笔机械' },
        { id: 'cold-reader', name: '冷读审稿人', hint: '读者会不会继续读 / 哪里弃读' },
        { id: 'stylist', name: '文笔文风优化师', hint: '语感 / 节奏 / 用词' },
      ]
      const scopeOf = (row) => (Number(row.chapter) === 0 ? 'book' : row.para == null ? 'chapter' : 'paragraph')
      const openSuggest = (row) => {
        setSuggestFor(row.id)
        setSuggestRole('')
        setSuggestScope(scopeOf(row))
        setSuggestDecision('')
        setSuggestText(String(row.authorNote || ''))
      }
      const submitSuggest = async () => {
        const row = rows.find((item) => item.id === suggestFor)
        if (!row) return
        if (!suggestRole) { setNotice({ tone: 'warn', text: '先选一个子 agent（这次交给谁出建议）' }); return }
        if (busy) return
        const source = ROLE_TO_SOURCE[suggestRole] || (categoryOf(row) === 'logic' ? 'logic' : categoryOf(row) === 'attention' ? 'attention' : 'ai-style')
        const roleName = (SUGGEST_ROLES.find((item) => item.id === suggestRole) || {}).name || suggestRole
        const allRows = chaptersForWorkorder()
        const chapterNumbers = new Set([Number(row.chapter)])
        if (suggestScope === 'related') {
          const related = await api('opinions.relatedChapters', scope(projectId, { id: row.id })).catch(() => null)
          for (const item of (related && related.chapters) || []) chapterNumbers.add(Number(item.chapter))
        }
        const useAll = suggestScope === 'ai' || suggestScope === 'book'
        const rowsForChapter = useAll ? allRows.filter((item) => item.chapter > 0) : allRows.filter((item) => chapterNumbers.has(item.chapter))
        if (!rowsForChapter.length) { setNotice({ tone: 'warn', text: '这一章找不到正文' }); return }
        if (suggestScope === 'paragraph') { chapterNumbers.clear(); chapterNumbers.add(Number(row.chapter)) }
        const scopeRule = suggestScope === 'paragraph'
          ? `范围：仅第${row.chapter}章第${Number(row.para) + 1}段；只改这一段，不要重审本章其它段。`
          : suggestScope === 'ai'
          ? '范围由你判断：先判断这条问题是本段 / 本章 / 跨章 / 全书级；允许用 novel_desk_read 读其他章节确认，但不要顺手审全书；跨章/全局问题提交 chapter=0 全书级意见并列出涉及章号。'
          : suggestScope === 'related'
            ? `范围：相关章节（${[...chapterNumbers].sort((a, b) => a - b).join('、')}），可读范围内章节确认；若判断是全书级问题，提交 chapter=0 并列出涉及章号。`
            : suggestScope === 'book'
              ? '范围：全书；允许读任意章节确认，但只处理这一条问题。'
              : '范围：仅本条所在章。如果你判断其实是跨章/全书问题，请明确说出并列出涉及章号，不要硬塞进本章。'
        const focus = [
          `只针对这一条已有意见给出建议/改法，不要重审全章、不要找新问题；交给「${roleName}」判断。`,
          String(suggestDecision || '').trim() ? `## 作者裁定（最高优先级，直接执行，不要讨论/不要比较/不要反问）\n${String(suggestDecision).trim()}` : '',
          `- 第${row.chapter}章 第${Number(row.para) + 1}段`,
          `- 问题：${row.text}`,
          row.after ? `- AI 原改法：${row.after}` : '',
          String(suggestText || '').trim() ? `- 作者建议（必须遵守）：${String(suggestText).trim()}` : '',
          scopeRule,
          '输出：1 条 AI 意见；如果能给整段替换就带 after，只给判断也可以。',
        ].filter(Boolean).join('\n')
        setBusy(`suggest-${row.id}`); setNotice(null)
        try {
          const value = await api('chat.send', { projectId, workorder: 'reviewWorkorder', chapters: rowsForChapter, sources: [source], roleOverride: suggestRole, focus, dryRun: true })
          setWorkorder({ title: `第 ${row.chapter} 章 · 生成建议（${roleName}）`, text: String(value.prompt || ''), sending: false })
          setSuggestFor('')
        } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }) }
        finally { setBusy('') }
      }

      const makeLocalWorkorder = async () => {
        if (busy) return
        setBusy('local'); setNotice(null)
        try {
          const items = (localChecks && Array.isArray(localChecks.items)) ? localChecks.items : []
          if (!items.length) return
          const chapters = [...new Set(items.map((row) => Number(row.chapter)))].filter((n) => n > 0)
          const rowsFor = (toc || []).filter((row) => chapters.includes(chapterNo(row))).map((row) => ({ chapter: chapterNo(row), title: chapterTitle(row), words: Number(row.words) || 0, path: row.path || row.file || '' }))
          const focus = ['本地检查发现这些可疑点，请只判这些点并给改法（不要通读全文找新问题）：', ...items.slice(0, 40).map((row) => `- 第${row.chapter}章 第${Number(row.para) + 1}段 [${row.kind === 'deai' ? '去AI化' : '事实逻辑'}] ${row.message}`)].join('\n')
          const value = await api('chat.send', { projectId, workorder: 'reviewWorkorder', chapters: rowsFor, sources: ['logic', 'ai-style'], focus, dryRun: true })
          setWorkorder({ title: `本地检查工作单（${chapters.length} 章 / ${items.length} 个可疑点）`, text: String(value.prompt || ''), sending: false })
        } catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }) }
        finally { setBusy('') }
      }
      const chip = (key, label, value, onClick) => h(Btn, { small: true, kind: value === key ? 'primary' : undefined, onClick: () => onClick(key) }, label)
      const askRef = useRef(false)
      useEffect(() => {
        if (askRef.current) return
        if (!pageArg) return
        if (pageArg.coldChapter) { askRef.current = true; coldReadChapter(Number(pageArg.coldChapter)); return }
        if (!pageArg.ask) return
        askRef.current = true
        const chapter = Number(pageArg.chapter) || 0
        makeReviewWorkorder(String(pageArg.ask), chapter ? [chapter] : [])
      }, [pageArg])

      const cats = [
        { id: 'all', label: `全部 ${sourceRows.length}` },
        { id: 'ai-style', label: `去 AI 化 ${sourceRows.filter((row) => categoryOf(row) === 'ai-style').length}` },
        { id: 'logic', label: `事实逻辑 ${sourceRows.filter((row) => categoryOf(row) === 'logic').length}` },
        { id: 'attention', label: `注意力 ${sourceRows.filter((row) => categoryOf(row) === 'attention').length}` },
      ]
      return h('div', { className: 'nd-page nd-opinions' },
        h('div', { className: 'nd-page-head' },
          h('div', null,
            h('h2', null, '意见'),
            h('p', { className: 'nd-hint' }, '作者意见与 AI 意见分开。AI 意见只分三类：去 AI 化 / 事实逻辑 / 注意力（冷读）；AI 意见带地址和改法，采纳即替换该段。')),
          h('div', { className: 'nd-page-actions' },
            h(Btn, { small: true, onClick: reload, disabled: res.loading }, '刷新'),
            h(Btn, { small: true, kind: 'primary', onClick: () => { setColdOpen(true); setColdFocus('') } }, '❄️ 全文冷读（注意力）'),
            h(Btn, { small: true, onClick: () => makeReviewWorkorder('ai-style', []), disabled: Boolean(busy) }, '🤖 全文去 AI 化'),
            h(Btn, { small: true, onClick: () => makeReviewWorkorder('logic', []), disabled: Boolean(busy) }, '⚖️ 全文逻辑审核'),
          ),
        ),
        notice ? h(Msg, { tone: notice.tone, onClose: () => setNotice(null) }, notice.text) : null,
        h('div', { className: 'nd-toolbar' },
          chip('ai', `AI 意见 ${rows.filter((row) => row.origin !== 'user').length}`, who, setWho),
          chip('author', `作者意见 ${rows.filter((row) => row.origin === 'user').length}`, who, setWho),
          h('span', { className: 'nd-hint' }, ' ｜ '),
          chip('open', `待处理 ${counts.open || 0}`, status, setStatus),
          chip('stale', `失效 ${counts.stale || 0}`, status, setStatus),
          chip('resolved', `已随处理 ${counts.resolved || 0}`, status, setStatus),
          chip('accepted', `已采纳 ${counts.accepted || 0}`, status, setStatus),
          chip('rejected', `已驳回 ${counts.rejected || 0}`, status, setStatus),
          chip('all', `全部 ${rows.length}`, status, setStatus),
        ),
        who === 'ai' ? h('div', { className: 'nd-toolbar' }, cats.map((item) => chip(item.id, item.label, cat, setCat))) : null,
        res.error ? h(ErrorBox, { error: res.error, onRetry: res.reload }) : null,
        res.loading && !rows.length ? h(Loading, null, '读取意见…') : null,
        !res.loading && !groups.length ? h('p', { className: 'nd-hint' }, who === 'author' ? '还没有作者意见：正文页切到「批注」，选中文字或点「整章意见」提交。' : '这个分类下还没有 AI 意见。去 AI 化的入口在正文选区里；事实逻辑先跑「全书同步」或让它出意见；注意力用右上角冷读。') : null,
        h('section', { className: 'nd-card' },
          h('div', { className: 'nd-card-head' },
            h('h3', null, '🧪 本地检查（0 AI 成本）'),
            localChecks ? h('span', { className: 'nd-hint' }, `事实逻辑 ${localChecks.counts?.logic || 0} ｜ 去 AI 化 ${localChecks.counts?.deai || 0}${localAt ? ` ｜ 上次扫描 ${localAt}` : ''}（正文改过再点重新扫描）`) : h('span', { className: 'nd-hint' }, '只在点「扫描」时跑；结果会保留，切页回来不用重扫'),
            h(Btn, { small: true, kind: localChecks ? undefined : 'primary', onClick: scanLocal, disabled: localScanning }, localScanning ? '扫描中…' : localChecks ? '重新扫描' : '扫描全文'),
            localChecks && localChecks.items && localChecks.items.length && go ? h(Btn, { small: true, onClick: () => go('read', { chapter: Number(localChecks.items[0].chapter), marks: localChecks.items.flatMap((row) => itemMarks(row)) }) }, '全部高亮') : null,
            localChecks && localChecks.items && localChecks.items.length ? h(Btn, { small: true, kind: 'primary', onClick: makeLocalWorkorder, disabled: busy === 'local' }, busy === 'local' ? '生成中…' : '让 AI 判这些点') : null,
          ),
          localChecks
            ? h('p', { className: 'nd-hint' }, localChecks.items && localChecks.items.length
              ? '每条都给到「第几章·第几段」+ 原文；点「定位」直接跳到正文那一段，作者可以自己改。'
              : '扫完了，没发现明显问题。')
            : h('p', { className: 'nd-hint' }, '扫描全书，找 Markdown 残留、重复段、超长段、AI 套话密度、长句过多、账本数字缺口。点一次扫一次。'),
          localChecks && localChecks.items && localChecks.items.length
            ? h('div', { className: 'nd-local-list' },
                localChecks.items.slice(0, 20).map((row, index) => h('div', { className: 'nd-local-item', key: index },
                  h(Tag, { tone: row.kind === 'deai' ? 'warn' : 'muted' }, row.kind === 'deai' ? '去 AI 化' : '事实逻辑'),
                  h('span', { className: 'nd-hint' }, `第 ${row.chapter} 章 · 第 ${itemParas(row).map((p) => Number(p) + 1).join('、')} 段`),
                  h('span', null, row.message),
                  row.quote ? h('span', { className: 'nd-hint' }, `「${String(row.quote).slice(0, 40)}」`) : null,
                  go ? h(Btn, { small: true, onClick: () => go('read', { chapter: Number(row.chapter), para: itemParas(row)[0], marks: itemMarks(row) }) }, '定位') : null,
                )),
                localChecks.items.length > 20 ? h('p', { className: 'nd-hint' }, `还有 ${localChecks.items.length - 20} 条；点「让 AI 判这些点」会全部带上。`) : null,
              )
            : null,
        ),
        groups.map((group) => {
          const pickedHere = group.opinions.filter((row) => picked.includes(row.id))
          const head = Number(group.chapter) === 0 ? '全书级' : `第 ${group.chapter} 章${group.para == null ? ' · 章级' : ` · 第 ${Number(group.para) + 1} 段`}`
          return h('section', { className: 'nd-card', key: group.key },
            h('div', { className: 'nd-card-head' },
              h('h3', null, head),
              h('span', { className: 'nd-hint' }, titleOf(group.chapter)),
              group.para != null && openChapterAt ? h(Btn, { small: true, onClick: () => openChapterAt(group.chapter, group.para) }, '定位正文') : (group.para == null && openChapter ? h(Btn, { small: true, onClick: () => openChapter(group.chapter) }, '看正文') : null),
              group.opinions.length >= 2 ? h('span', { className: 'nd-hint' }, `本段 ${group.opinions.length} 条，建议合并成一条完整意见`) : null,
              pickedHere.length >= 2 ? h(Btn, { small: true, kind: 'primary', disabled: busy === 'merge', onClick: () => mergePicked(group) }, `合并所选 ${pickedHere.length}`) : null,
            ),
            group.opinions.map((row) => h('div', { className: `nd-opinion nd-opinion-${row.status}`, key: row.id },
              h('div', { className: 'nd-opinion-head' },
                h('input', { type: 'checkbox', checked: picked.includes(row.id), onChange: () => toggle(row.id), title: '选择以合并' }),
                h(Tag, { tone: row.status === 'stale' ? 'error' : row.status === 'accepted' ? 'ok' : row.status === 'rejected' || row.status === 'resolved' ? 'muted' : 'warn' }, row.status === 'resolved' ? '已随处理' : row.status || 'open'),
                row.origin === 'user' ? h(Tag, { tone: 'brand' }, '作者意见') : h(Tag, { tone: 'muted' }, `AI · ${categoryOf(row) === 'ai-style' ? '去 AI 化' : categoryOf(row) === 'logic' ? '事实逻辑' : '注意力'}`),
                h(Tag, { tone: 'muted' }, Number(row.chapter) === 0 ? '全文' : row.para == null ? `第${row.chapter}章` : `第${row.chapter}章·第${Number(row.para) + 1}段`),
                row.kind === 'highlight' ? h(Tag, { tone: 'ok' }, '高光') : null,
                h('span', { className: 'nd-opinion-when' }, row.createdAt ? String(row.createdAt).slice(0, 10) : ''),
              ),
              h('p', { className: 'nd-opinion-text' }, row.text),
              row.authorNote ? h('p', { className: 'nd-opinion-author-note' }, `我的建议：${row.authorNote}`) : null,
              row.after ? h('div', { className: 'nd-opinion-after' }, h('div', { className: 'nd-diff-head' }, '改为'), h('pre', { className: 'nd-pre' }, row.after)) : null,
              row.status === 'stale' ? h('p', { className: 'nd-hint nd-opinion-stale' }, `地址失效：${row.staleReason || '正文已改动'}（保留原文，可在正文重新批注）`) : null,
              row.status === 'resolved' ? h('p', { className: 'nd-hint' }, '这条问题已随另一条意见的采纳一起处理，保留记录，不再待办。') : null,
              noteFor === row.id
                ? h('div', { className: 'nd-opinion-note-edit' },
                    h('textarea', { className: 'nd-input nd-textarea', rows: 3, value: noteText, placeholder: '你的建议（例：这段别删，改成更冷的写法；或：按这个人物的性格不该示弱）', onChange: (e) => setNoteText(e.target.value) }),
                    h('div', { className: 'nd-actions' },
                      h(Btn, { small: true, kind: 'primary', onClick: () => saveNote(row.id), disabled: busy === `note-${row.id}` }, '保存建议'),
                      h(Btn, { small: true, onClick: () => setNoteFor('') }, '取消'),
                      h(Btn, { small: true, onClick: () => { setNoteFor(''); setSuggestFor(row.id); setSuggestRole(''); setSuggestText(noteText) }, disabled: Boolean(busy) }, '按我的建议生成'),
                    ),
                  )
                : null,
              h('div', { className: 'nd-opinion-actions' },
                row.status === 'open' && row.after ? h(Btn, { small: true, kind: 'primary', disabled: busy === row.id, onClick: () => accept(row.id) }, Number(row.chapter) === 0 ? '采纳并替换（自动定位）' : '采纳并替换') : null,
                row.status === 'open' ? h(Btn, { small: true, kind: row.after ? undefined : 'primary', disabled: Boolean(busy), onClick: () => openSuggest(row) }, row.after ? '我的建议重新生成' : '我的建议') : null,
                row.status === 'open' ? h(Btn, { small: true, disabled: busy === row.id, onClick: () => reject(row.id) }, '驳回') : null,
                (String(row.role || '') === '冷读审稿人' || String(row.role || '') === 'attention') && Number(row.chapter) === 0
                  ? h(Btn, { small: true, kind: 'primary', disabled: Boolean(busy), onClick: () => splitColdReadLocal(row) }, '按章拆分')
                  : null,
                (String(row.role || '') === '冷读审稿人' || String(row.role || '') === 'attention') && Number(row.chapter) === 0
                  ? h(Btn, { small: true, disabled: Boolean(busy), onClick: () => splitColdRead(row) }, '让 AI 拆')
                  : null,
                row.status === 'rejected' ? h(Btn, { small: true, onClick: async () => {
                  setBusy(`reopen-${row.id}`); setNotice(null)
                  try { await api('opinions.patch', scope(projectId, { id: row.id, patch: { status: 'open' } })); setNotice({ tone: 'ok', text: '已撤销驳回，重新放回待处理' }); res.reload() }
                  catch (error) { setNotice({ tone: 'error', text: friendlyError(error) }) }
                  finally { setBusy('') }
                }, disabled: busy === `reopen-${row.id}` }, '撤销驳回') : null,
              ),
            )),
          )
        }),
        suggestFor ? h(Modal, {
          title: '我的建议 / 生成改动',
          onClose: () => setSuggestFor(''),
          footer: h(Fragment, null,
            h(Btn, { onClick: () => setSuggestFor('') }, '取消'),
            h(Btn, { kind: 'primary', onClick: submitSuggest, disabled: Boolean(busy) }, busy ? '生成中…' : '生成改动'),
          ),
        },
          h('p', { className: 'nd-hint' }, '这次让哪个子 agent 出建议？不默认，由你选；逻辑 bug 选「事实逻辑设计师」，AI 味选「审核 AI 化的 AI」，弃读/节奏选「冷读审稿人」，语感选「文笔文风优化师」。'),
          h(Field, { label: '子 agent' },
            h(Select, {
              value: suggestRole,
              onChange: setSuggestRole,
              options: [{ value: '', label: '请选择' }].concat(SUGGEST_ROLES.map((role) => ({ value: role.id, label: `${role.name}（${role.hint}）` }))),
            }),
          ),
          h(Field, { label: '范围' },
            h(Select, {
              value: suggestScope,
              onChange: setSuggestScope,
              options: [
                { value: 'ai', label: 'AI 判断（推荐）：局部还是全局由 AI 先判断' },
                { value: 'paragraph', label: '仅本段（AI 判断出的段落）' },
                { value: 'chapter', label: '仅本条所在章' },
                { value: 'related', label: '相关章节（按人物/地点出现范围）' },
                { value: 'book', label: '全书' },
              ],
            }),
          ),
          h(Field, { label: '作者裁定（可选，最高优先级：已定的结论，AI 直接照改）', hint: '例：年龄以 72 为准，把 73 全改成 72；不要论证，不要做生辰推演。' },
            h(TextArea, { rows: 2, value: suggestDecision, onChange: setSuggestDecision, placeholder: '例：年龄以 72 为准；只改数字，不分析“九十年”设定。' }),
          ),
          h(Field, { label: '我的建议（可留空）' },
            h(TextArea, { rows: 4, value: suggestText, onChange: setSuggestText, placeholder: '例：这里死了人下一章却像没事发生，逻辑不成立；让事实逻辑设计师判断。' }),
          ),
        ) : null,
        coldOpen ? h(Modal, {
          title: '冷读（注意力）',
          onClose: () => setColdOpen(false),
          footer: h(Fragment, null,
            h(Btn, { onClick: () => setColdOpen(false) }, '取消'),
            h(Btn, { kind: 'primary', onClick: makeColdWorkorder, disabled: busy === 'cold' }, busy === 'cold' ? '生成中…' : '生成冷读工作单'),
          ),
        },
          h('p', { className: 'nd-hint' }, '把全文导出成一份 txt 交给 AI（独立审稿人/出版社编辑），一次读完直接回答：评分、接纳与否、哪里不足。结果落成 1 条冷读意见，可再按章拆分。'),
          h('div', { className: 'nd-field' },
            h('span', { className: 'nd-label' }, '本次关注（可留空）'),
            h('textarea', { className: 'nd-input nd-textarea', rows: 3, value: coldFocus, placeholder: '例：重点看第 12–20 章有没有让人想继续读。', onChange: (e) => setColdFocus(e.target.value) }),
          ),
        ) : null,
        workorder ? h(Modal, {
          title: workorder.title,
          wide: true,
          onClose: () => setWorkorder(null),
          footer: h(Fragment, null,
            h(Btn, { onClick: () => copyText(workorder.text) }, '复制'),
            h(Btn, { kind: 'primary', disabled: workorder.sending, onClick: sendWorkorder }, workorder.sending ? '发送中…' : '发送到对话'),
          ),
        },
          h(TargetPicker, { projectId, value: target, onChange: setTarget }),
          h('p', { className: 'nd-hint' }, '会话建议：冷读/复测新开会话（零上下文）；同章定点修可沿用该章上次会话；全文动作沿用同一个 run 会话。选择权在你。'),
          h('pre', { className: 'nd-pre nd-pre-tall' }, workorder.text),
        ) : null,
      )
    }

    function ProposalsTab({ projectId, openChapter, go, onChanged }) {
      const [status, setStatus] = useState('pending')
      const [openId, setOpenId] = useState('')
      const [notice, setNotice] = useState(null)
      const [busyId, setBusyId] = useState('')
      const [rejectId, setRejectId] = useState('')
      const [reason, setReason] = useState('')
      const [selected, setSelected] = useState([])
      const [batchBusy, setBatchBusy] = useState(false)
      const [batchReject, setBatchReject] = useState(false)
      const [batchReason, setBatchReason] = useState('')
      const [edit, setEdit] = useState(null) // 编辑改法：{ id, data, busy }

      useEffect(() => { setSelected([]); setBatchReject(false); setBatchReason('') }, [projectId, status])

      const proposals = useAsync(
        () => (projectId ? api('proposal.list', scope(projectId, { status, filter: { status } })) : Promise.resolve([])),
        [projectId, status],
      )
      const list = useMemo(
        () => toList(proposals.data, 'proposals').filter((p) => PROPOSAL_KINDS.includes(p.kind)),
        [proposals.data],
      )

      const startEdit = (proposal) => {
        const data = JSON.parse(JSON.stringify(proposal.data || {}))
        setEdit({ id: proposal.id, data, busy: false })
        setOpenId(proposal.id)
        setNotice(null)
      }
      const updateEditPatch = (index, after) => setEdit((prev) => {
        if (!prev) return prev
        const patches = Array.isArray(prev.data.patches) ? prev.data.patches.slice() : []
        patches[index] = { ...patches[index], after }
        return { ...prev, data: { ...prev.data, patches } }
      })
      const updateEditContent = (content) => setEdit((prev) => (prev ? { ...prev, data: { ...prev.data, content } } : prev))
      const saveEdit = async (proposal) => {
        if (!projectId || !edit || edit.busy) return
        setEdit((prev) => (prev ? { ...prev, busy: true } : prev))
        try {
          await api('proposal.update', scope(projectId, { proposalId: proposal.id, patch: { data: edit.data } }))
          setNotice({ tone: 'ok', text: `改法已保存：${proposal.title || proposal.id}（状态回到待批准）` })
          setEdit(null)
          setOpenId('')
          proposals.reload()
          if (onChanged) onChanged()
        } catch (err) {
          setEdit((prev) => (prev ? { ...prev, busy: false } : prev))
          setNotice({ tone: 'error', text: `保存改法失败：${friendlyError(err)}` })
        }
      }

      const accept = async (proposal) => {
        setBusyId(proposal.id)
        setNotice(null)
        try {
          const value = await api('proposal.accept', scope(projectId, { proposalId: proposal.id }))
          const updated = (value && value.proposal) || null
          const ok = !value || value.ok !== false
          if (ok) {
            setNotice({ tone: 'ok', text: `已采纳：${proposal.title || proposal.id}（正文已按补丁更新）` })
            setOpenId('')
          } else if (value && value.code === 'stale') {
            setNotice({ tone: 'warn', text: '正文已变化，提案过期（stale）：请刷新后在意见页重新处理。' })
          } else {
            setNotice({ tone: 'warn', text: `未通过闸门（needs-fix）：${proposalReasons(updated || proposal)}` })
          }
          proposals.reload()
          if (onChanged) onChanged()
        } catch (err) {
          setNotice({ tone: 'error', text: `采纳失败：${friendlyError(err)}` })
        } finally {
          setBusyId('')
        }
      }

      const reject = async (proposal) => {
        if (!reason.trim()) {
          setNotice({ tone: 'warn', text: '请填写驳回原因。' })
          return
        }
        setBusyId(proposal.id)
        try {
          await api('proposal.reject', scope(projectId, { proposalId: proposal.id, reason: reason.trim() }))
          setNotice({ tone: 'ok', text: `已驳回：${proposal.title || proposal.id}` })
          setOpenId('')
          setRejectId('')
          setReason('')
          proposals.reload()
        } catch (err) {
          setNotice({ tone: 'error', text: `驳回失败：${friendlyError(err)}` })
        } finally {
          setBusyId('')
        }
      }

      const openProposal = (proposal) => {
        setOpenId((prev) => (prev === proposal.id ? '' : proposal.id))
        setRejectId('')
        setReason('')
      }

      const pendingIds = list.filter((p) => (p.status || 'pending') === 'pending').map((p) => p.id)
      const selectedPending = selected.filter((id) => pendingIds.includes(id))
      const allSelected = pendingIds.length > 0 && selectedPending.length === pendingIds.length
      const toggleSelect = (id) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
      const toggleSelectAll = () => setSelected(allSelected ? [] : pendingIds)

      const runBatch = async (action) => {
        const ids = selectedPending
        if (ids.length === 0) {
          setNotice({ tone: 'warn', text: '先勾选要处理的提案。' })
          return
        }
        if (action === 'reject' && !batchReason.trim()) {
          setBatchReject(true)
          setNotice({ tone: 'warn', text: '批量驳回需要填写原因。' })
          return
        }
        setBatchBusy(true)
        setNotice(null)
        try {
          const value = await api('proposal.batch', scope(projectId, { ids, action, reason: batchReason.trim() }))
          const accepted = Array.isArray(value?.accepted) ? value.accepted.length : 0
          const rejected = Array.isArray(value?.rejected) ? value.rejected.length : 0
          const failed = Array.isArray(value?.failed) ? value.failed : []
          const doneText = action === 'reject' ? `已驳回 ${rejected} 条` : `已批准 ${accepted} 条`
          const failText = failed.length ? `；${failed.length} 条未处理（${failed.map((row) => row.message || row.id).slice(0, 3).join('；')}）` : ''
          setNotice({ tone: failed.length ? 'warn' : 'ok', text: `${doneText}${failText}` })
          setSelected([])
          setBatchReject(false)
          setBatchReason('')
          proposals.reload()
          if (onChanged) onChanged()
        } catch (err) {
          setNotice({ tone: 'error', text: `批量处理失败：${friendlyError(err)}` })
        } finally {
          setBatchBusy(false)
        }
      }

      return h('div', { className: 'nd-page' },
        h('div', { className: 'nd-pagehead' },
          h('h2', null, '提案'),
          h('span', { className: 'nd-hint' }, '支持 patch-paragraph / rewrite-chapter / ledger-fix / book-fix 四种提案；「改为」可以直接编辑，再批准落盘。旧格式提案原样保留、不在此处理。'),
        ),
        h(Tabs, {
          value: status,
          onChange: setStatus,
          items: [
            { value: 'pending', label: '待批准' },
            { value: 'needs-fix', label: '未过闸门' },
            { value: 'accepted', label: '已采纳' },
            { value: 'rejected', label: '已驳回' },
            { value: 'revised', label: '已修订' },
          ],
        }),
        notice ? h(Msg, { tone: notice.tone, onClose: () => setNotice(null) }, notice.text) : null,
        status === 'pending' && list.length > 0
          ? h('div', { className: 'nd-toolbar nd-proposal-batch' },
              h('label', { className: 'nd-form-row', title: '全选本页待批准提案' },
                h(Check, { checked: allSelected, onChange: toggleSelectAll, title: '全选' }),
                h('span', { className: 'nd-hint' }, allSelected ? '取消全选' : '全选'),
              ),
              h('span', { className: 'nd-hint' }, `已选 ${selectedPending.length} / ${pendingIds.length} 条`),
              h(Btn, { small: true, kind: 'primary', disabled: batchBusy || selectedPending.length === 0, onClick: () => runBatch('accept') }, batchBusy ? '处理中…' : '批量批准'),
              h(Btn, { small: true, disabled: batchBusy || selectedPending.length === 0, onClick: () => setBatchReject((prev) => !prev) }, '批量驳回'),
            )
          : null,
        batchReject && status === 'pending' && list.length > 0
          ? h('div', { className: 'nd-reject' },
              h(TextArea, { value: batchReason, rows: 2, placeholder: '批量驳回原因（必填，会写到每一条提案）', onChange: setBatchReason }),
              h(Btn, { small: true, kind: 'danger', disabled: batchBusy || selectedPending.length === 0, onClick: () => runBatch('reject') }, batchBusy ? '处理中…' : '确认批量驳回'),
              h(Btn, { small: true, disabled: batchBusy, onClick: () => { setBatchReject(false); setBatchReason('') } }, '取消'),
            )
          : null,
        proposals.loading && !proposals.data
          ? h(Loading, null, '正在读取提案…')
          : proposals.error
            ? h(ErrorBox, { error: proposals.error, onRetry: proposals.reload })
            : list.length === 0
              ? h(Empty, null, status === 'pending' ? '没有待批准提案。在意见页由 AI 产出可采纳意见；旧提案仅作历史。' : '这个状态下没有提案。')
              : h('div', { className: 'nd-proposals' },
                  list.map((proposal) => {
                    const data = proposal.data || {}
                    const patches = Array.isArray(data.patches) ? data.patches : []
                    const patchChapters = new Set(patches.map((patch) => Number(patch?.chapter) || 0).filter((n) => n > 0)).size
                    const fixes = proposal.kind === 'ledger-fix' ? proposalLedgerFixes(data) : []
                    const expanded = openId === proposal.id
                    const pending = (proposal.status || 'pending') === 'pending'
                    const editable = pending || proposal.status === 'needs-fix'
                    const editing = Boolean(edit && edit.id === proposal.id)
                    return h('article', { key: proposal.id, className: `nd-proposal${expanded ? ' nd-proposal-open' : ''}` },
                      h('div', { className: 'nd-proposal-head', role: 'button', tabIndex: 0, onClick: () => openProposal(proposal), onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProposal(proposal) } } },
                        pending ? h('span', { className: 'nd-form-row', onClick: (e) => e.stopPropagation() },
                          h(Check, { checked: selected.includes(proposal.id), title: '选择这条提案', onChange: () => toggleSelect(proposal.id) })) : null,
                        h('span', { className: 'nd-proposal-arrow' }, expanded ? '▾' : '▸'),
                        h('span', { className: 'nd-proposal-title' }, String(proposal.title || proposal.id)),
                        h(Tag, { tone: 'brand' }, PROPOSAL_KIND[proposal.kind] || proposal.kind),
                        patches.length ? h(Tag, { tone: 'muted' }, `${patches.length} 条补丁${patchChapters > 1 ? ` / ${patchChapters} 章` : ''}`) : null,
                        chapterNo(proposal) ? h(Tag, null, `第 ${chapterNo(proposal)} 章`) : proposal.kind === 'book-fix' ? h(Tag, { tone: 'brand' }, '全书') : null,
                        h(Tag, { tone: proposal.status === 'needs-fix' ? 'warn' : proposal.status === 'accepted' ? 'ok' : proposal.status === 'rejected' ? 'error' : 'muted' }, PROPOSAL_STATUS[proposal.status || 'pending'] || proposal.status),
                        h('span', { className: 'nd-hint nd-proposal-when' }, fmtAgo(proposal.createdAt)),
                        pending
                          ? h('span', { className: 'nd-proposal-actions', style: { marginLeft: 'auto' }, onClick: (e) => e.stopPropagation() },
                              h(Btn, { small: true, kind: 'primary', disabled: busyId === proposal.id, onClick: () => accept(proposal) }, busyId === proposal.id ? '批准中…' : '批准'),
                              h(Btn, { small: true, disabled: busyId === proposal.id, onClick: () => { setRejectId(proposal.id); setReason('') } }, '驳回'),
                            )
                          : null,
                      ),
                      expanded
                        ? h('div', { className: 'nd-proposal-body' },
                            proposal.summary ? h('p', { className: 'nd-proposal-summary' }, String(proposal.summary)) : null,
                            proposal.status === 'needs-fix' ? h(Msg, { tone: 'warn' }, `未通过闸门：${proposalReasons(proposal)}`) : null,
                            proposal.kind === 'book-fix' && data.opinion
                              ? h('div', { className: 'nd-field' },
                                  h('div', { className: 'nd-side-sub' }, '全局修改意见'),
                                  editing
                                    ? h(TextArea, { value: String(data.opinion), rows: 6, onChange: (next) => setEdit((prev) => (prev ? { ...prev, data: { ...prev.data, opinion: next } } : prev)) })
                                    : h('p', { className: 'nd-proposal-summary' }, String(data.opinion)),
                                )
                              : null,
                            patches.length
                              ? h('div', { className: 'nd-side-sub' }, `补丁（${patches.length} 条${patchChapters > 1 ? `，跨 ${patchChapters} 章` : ''}）${pending || proposal.status === 'needs-fix' ? ' · 可在下方直接编辑「改为」' : ''}`)
                              : null,
                            patches.length
                              ? h('div', { className: 'nd-diffs' }, patches.map((patch, index) =>
                                  h('div', { className: 'nd-diff', key: index },
                                    h('div', { className: 'nd-diff-col' },
                                      h('div', { className: 'nd-diff-head' }, `${proposal.kind === 'book-fix' && patch.chapter ? `第 ${patch.chapter} 章 · ` : ''}原文 ${index + 1}`),
                                      h('pre', { className: 'nd-pre' }, String(patch.before || '—')),
                                    ),
                                    h('div', { className: 'nd-diff-col' },
                                      h('div', { className: 'nd-diff-head' }, '改为'),
                                      editing
                                        ? h(TextArea, { value: String(patch.after || ''), rows: 4, onChange: (next) => updateEditPatch(index, next) })
                                        : h('pre', { className: 'nd-pre' }, String(patch.after || '（留空 = 删除该段）')),
                                    ),
                                    patch.why ? h('div', { className: 'nd-diff-why' }, `理由：${patch.why}`) : null,
                                    Array.isArray(patch.reviewIds) && patch.reviewIds.length ? h('div', { className: 'nd-hint' }, `来源意见：${patch.reviewIds.join('、')}`) : null,
                                  ),
                                ))
                              : null,
                            data.content ? h('div', { className: 'nd-diff-col' },
                              h('div', { className: 'nd-diff-head' }, '整章新正文（纯文本）'),
                              editing ? h(TextArea, { value: String(data.content), rows: 12, onChange: updateEditContent }) : h('pre', { className: 'nd-pre nd-pre-tall' }, String(data.content)),
                            ) : null,
                            fixes.length
                              ? h('div', { className: 'nd-fixes' },
                                  h('div', { className: 'nd-side-sub' }, `账本修订（${fixes.length} 条）`),
                                  fixes.map((fix, index) => h('div', { className: 'nd-fix', key: index }, ledgerFixSummary(fix))),
                                )
                              : null,
                            h(GatesView, { gates: proposal.gates }),
                            editing
                              ? h('div', { className: 'nd-proposal-actions' },
                                  h(Btn, { small: true, kind: 'primary', onClick: () => saveEdit(proposal), disabled: Boolean(edit && edit.busy) }, edit && edit.busy ? '保存中…' : '保存改法'),
                                  h(Btn, { small: true, onClick: () => setEdit(null), disabled: Boolean(edit && edit.busy) }, '取消编辑'),
                                )
                              : editable
                                ? h('div', { className: 'nd-proposal-actions' },
                                    h(Btn, { small: true, onClick: () => startEdit(proposal) }, '编辑「改为」'),
                                    pending ? h(Btn, { small: true, kind: 'primary', onClick: () => accept(proposal), disabled: busyId === proposal.id }, busyId === proposal.id ? '批准中…' : '批准') : null,
                                    pending ? h(Btn, { small: true, onClick: () => { setRejectId(proposal.id); setReason('') } }, '驳回') : null,
                                    chapterNo(proposal) ? h(Btn, { small: true, onClick: () => openChapter(chapterNo(proposal)) }, '看该章') : null,
                                  )
                                : null,
                            rejectId === proposal.id
                              ? h('div', { className: 'nd-reject' },
                                  h(TextArea, { value: reason, rows: 2, placeholder: '驳回原因（必填）', onChange: setReason }),
                                  h(Btn, { small: true, onClick: () => reject(proposal), disabled: busyId === proposal.id }, '确认驳回'),
                                  h(Btn, { small: true, onClick: () => setRejectId('') }, '取消'),
                                )
                              : null,
                          )
                        : null,
                    )
                  }),
                ),
      )
    }

    // ── 全文动作：新建对话框 + 页面 ────────────────────────────
    function RunDialog({ projectId, toc, defaults, onClose, onCreated }) {
      const first = chapterNo(toc[0] || {}) || 1
      const lastWritten = sortChapters(toc).reduce((max, row) => Math.max(max, chapterNo(row) || 0), 0)
      const initialKind = (defaults && defaults.kind === 'rephrase') ? 'rewrite' : ((defaults && defaults.kind) || 'rewrite')
      const [kind, setKind] = useState(initialKind)
      const [variant, setVariant] = useState((defaults && defaults.kind === 'rephrase') ? 'style' : ((defaults && defaults.variant) || 'logic'))
      const [scopeMode, setScopeMode] = useState((defaults && defaults.scope) || 'book')
      const [chapter, setChapter] = useState(String((defaults && defaults.chapter) || (initialKind === 'continue' ? lastWritten + 1 : first)))
      const [endChapter, setEndChapter] = useState(String((defaults && defaults.endChapter) || (initialKind === 'continue' ? Math.max(lastWritten + 1, Number(defaults && defaults.chapter) || lastWritten + 1) : first)))
      const [maxTokens, setMaxTokens] = useState('200000')
      const [maxCost, setMaxCost] = useState('20')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const submit = async () => {
        setBusy(true)
        setError('')
        try {
          const budget = {
            maxTokens: Math.max(0, toNumber(maxTokens, 200000)),
            maxCostCNY: Math.max(0, toNumber(maxCost, 20)),
            usedTokens: 0,
            usedCostCNY: 0,
          }
          const start = Math.max(1, toNumber(chapter, first))
          const patch = {
            kind,
            variant: kind === 'rewrite' ? variant : '',
            scope: scopeMode,
            chapter: scopeMode === 'book' ? null : start,
            endChapter: scopeMode === 'range' ? Math.max(start, toNumber(endChapter, start)) : null,
            budget,
            status: 'ready',
          }
          await api('run.save', scope(projectId, { patch, run: patch, ...patch }))
          onCreated()
        } catch (err) {
          setError(friendlyError(err))
        } finally {
          setBusy(false)
        }
      }

      const hint = kind === 'continue'
        ? '从头写会把新章直接写进正文（过闸门后落盘）；其余动作的产物只进提案，不会直接改正文。已有动作会被新动作替换。'
        : '产物只进提案，不会直接改正文。已有动作会被新动作替换。'

      return h(
        Modal,
        {
          title: (defaults && defaults.title) || '新建全文动作',
          onClose,
          footer: h(Fragment, null,
            h(Btn, { onClick: onClose }, '取消'),
            h(Btn, { kind: 'primary', onClick: submit, disabled: busy }, busy ? '创建中…' : '创建动作'),
          ),
        },
        h('p', { className: 'nd-hint' }, hint),
        h(Field, { label: '动作类型' },
          h(Select, {
            value: kind,
            onChange: (value) => { setKind(value); if (value === 'continue') { setScopeMode('book') } },
            options: [
              { value: 'continue', label: '从头写（从下一章开始写新章）' },
              { value: 'expand', label: '扩写（把已有章节写足）' },
              { value: 'rewrite', label: '改写（重写已有章节）' },
            ],
          }),
        ),
        kind === 'rewrite'
          ? h(Field, { label: '改写侧重' },
              h(Select, {
                value: variant,
                onChange: setVariant,
                options: [
                  { value: 'style', label: '文风：只动语言层，事实/专名/数字/对白条数冻结' },
                  { value: 'logic', label: '逻辑与事实：可调因果与顺序，修漏洞与矛盾' },
                  { value: 'structure', label: '结构与节奏：重排场景、详略与钩子' },
                ],
              }),
            )
          : null,
        h(Field, { label: '范围' },
          h(Select, {
            value: scopeMode,
            onChange: setScopeMode,
            options: [
              { value: 'book', label: '全书' },
              { value: 'chapter', label: '单章' },
              { value: 'range', label: '章节区间' },
            ],
          }),
        ),
        scopeMode !== 'book'
          ? h('div', { className: 'nd-form-row' },
              h(Field, { label: kind === 'continue' ? '起始章（可手填）' : '目标章' },
                h(TextInput, { value: chapter, onChange: setChapter, type: 'number', min: 1, placeholder: `例如 ${lastWritten + 1}` }),
              ),
              scopeMode === 'range'
                ? h(Field, { label: '结束章' }, h(TextInput, { value: endChapter, onChange: setEndChapter, type: 'number', min: 1 }))
                : null,
            )
          : null,
        scopeMode !== 'book' && toc.length === 0
          ? h('p', { className: 'nd-hint' }, '这本书还没有章节：直接填章号（从头写默认从第 1 章开始）。')
          : null,
        h('div', { className: 'nd-form-row' },
          h(Field, { label: '预算 tokens' }, h(TextInput, { value: maxTokens, onChange: setMaxTokens, type: 'number', min: 0 })),
          h(Field, { label: '预算（元）' }, h(TextInput, { value: maxCost, onChange: setMaxCost, type: 'number', min: 0 })),
        ),
        error ? h(Msg, { tone: 'error' }, error) : null,
      )
    }

    function RunTab({ projectId, toc, onChanged }) {
      const [dialog, setDialog] = useState(false)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState('')
      const runRes = useAsync(() => (projectId ? api('run.get', scope(projectId)) : Promise.resolve(null)), [projectId])
      const run = useMemo(() => {
        const value = runRes.data
        if (!value || typeof value !== 'object') return null
        if (value.run && typeof value.run === 'object') return value.run
        return value.id ? value : null
      }, [runRes.data])
      const runStatus = run && run.status ? run.status : ''

      useEffect(() => {
        if (runStatus !== 'running') return undefined
        const timer = window.setInterval(() => runRes.reload(), 4000)
        return () => window.clearInterval(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [runStatus])

      const saveRun = async (patch, label) => {
        setBusy(label)
        setNotice(null)
        try {
          await api('run.save', scope(projectId, { patch, run: patch, ...patch }))
          setNotice({ tone: 'ok', text: `已${label}` })
          runRes.reload()
          if (onChanged) onChanged()
        } catch (err) {
          setNotice({ tone: 'error', text: `${label}失败：${friendlyError(err)}` })
        } finally {
          setBusy('')
        }
      }
      const resetRun = async () => {
        if (!window.confirm('重置全文动作会清空当前进度，确定？')) return
        setBusy('重置')
        try {
          await api('run.reset', scope(projectId))
          setNotice({ tone: 'ok', text: '已重置全文动作' })
          runRes.reload()
        } catch (err) {
          setNotice({ tone: 'error', text: `重置失败：${friendlyError(err)}` })
        } finally {
          setBusy('')
        }
      }
      // 开工：把当前 run 的 goal 工作单发进本书对话（0.6 之前只有状态，没有真正派活入口）。
      const sendWorkorder = async () => {
        if (!run) return
        setBusy('开工')
        setNotice(null)
        try {
          const res = await api('chat.send', scope(projectId, { workorder: 'runGoalPrompt', run, newSession: false }))
          const patch = { status: 'running', startedAt: run.startedAt || new Date().toISOString(), updatedAt: new Date().toISOString() }
          await api('run.save', scope(projectId, { patch, run: { ...run, ...patch }, ...patch }))
          const session = res && res.sessionId ? String(res.sessionId).slice(0, 8) : '当前会话'
          setNotice({ tone: 'ok', text: `工作单已发进对话（${session}），AI 会按阶段推进；进度用「刷新」看。` })
          runRes.reload()
          if (onChanged) onChanged()
        } catch (err) {
          setNotice({ tone: 'error', text: `开工失败：${friendlyError(err)}` })
        } finally {
          setBusy('')
        }
      }

      const stages = useMemo(() => {
        if (run && Array.isArray(run.stages) && run.stages.length) return run.stages
        return runStageTitles(run).map((title, index) => ({ id: `s${index}`, title, status: 'pending' }))
      }, [run])
      const doneStages = stages.filter((stage) => stage.status === 'done').length
      const budget = (run && run.budget) || {}
      const notes = run && Array.isArray(run.notes) ? run.notes : []

      let content
      if (!run) {
        content = h(Empty, { action: h(Btn, { kind: 'primary', onClick: () => setDialog(true) }, '新建全文动作') },
          '还没有全文动作。从头写新章 / 扩写 / 改写整本书；只有「从头写」会把新章直接写进正文，其余产物只进提案。',
        )
      } else {
        content = h(
          Fragment,
          null,
          h('div', { className: 'nd-run-head' },
            h('div', { className: 'nd-run-title' },
              h('strong', null, runKindLabel(run)),
              h(Tag, { tone: RUN_STATUS_TONE[run.status] || 'muted' }, RUN_STATUS[run.status] || run.status || '—'),
              h('span', { className: 'nd-hint' }, runScopeLabel(run)),
            ),
            h('div', { className: 'nd-run-meta' },
              h('span', null, `开始 ${run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : '—'}`),
              h('span', null, `结束 ${run.finishedAt ? new Date(run.finishedAt).toLocaleString('zh-CN') : '—'}`),
              h('span', null, `更新 ${fmtAgo(run.updatedAt)}`),
            ),
          ),
          h('div', { className: 'nd-run-actions' },
            h(Btn, { small: true, kind: 'primary', onClick: sendWorkorder, disabled: !!busy }, busy === '开工' ? '发送中…' : '开工（发工作单）'),
            (run.status === 'idle' || run.status === 'ready' || !run.status)
              ? h(Btn, { small: true, onClick: () => saveRun({ status: 'running', startedAt: new Date().toISOString() }, '开始'), disabled: !!busy }, '开始')
              : null,
            run.status === 'running' ? h(Btn, { small: true, onClick: () => saveRun({ status: 'paused' }, '暂停'), disabled: !!busy }, '暂停') : null,
            run.status === 'paused' ? h(Btn, { small: true, kind: 'primary', onClick: () => saveRun({ status: 'running' }, '继续'), disabled: !!busy }, '继续') : null,
            (run.status === 'running' || run.status === 'paused')
              ? h(Btn, { small: true, onClick: () => saveRun({ status: 'done', finishedAt: new Date().toISOString() }, '完成'), disabled: !!busy }, '完成')
              : null,
            (run.status === 'running' || run.status === 'paused' || run.status === 'ready')
              ? h(Btn, { small: true, onClick: () => { if (window.confirm('确定中止这个全文动作？')) saveRun({ status: 'failed', finishedAt: new Date().toISOString() }, '中止') }, disabled: !!busy }, '中止')
              : null,
            h(Btn, { small: true, onClick: () => setDialog(true), disabled: !!busy }, '新建/替换'),
            h(Btn, { small: true, onClick: resetRun, disabled: !!busy }, '重置'),
            h(Btn, { small: true, onClick: runRes.reload }, '刷新'),
          ),
          (run.status === 'running' || run.status === 'paused')
            ? h('div', { className: 'nd-banner nd-banner-warn' },
                h('span', null, '⚠ 工作台的「暂停 / 完成 / 中止」只更新工作台状态，**不会停止左侧对话里正在跑的 AI**。要真正停止，请到对话里中断/停止该会话，或关闭 DSH 页面；否则 AI 会继续跑并继续产生费用。'),
              )
            : null,
          notice ? h(Msg, { tone: notice.tone, onClose: () => setNotice(null) }, notice.text) : null,
          h('div', { className: 'nd-run-grid' },
            h('section', { className: 'nd-card' },
              h('div', { className: 'nd-card-head' }, h('strong', null, '阶段进度'), h('span', { className: 'nd-hint' }, `${doneStages}/${stages.length}`)),
              h(Bar, { value: doneStages, max: stages.length || 1, tone: 'ok' }),
              stages.length === 0
                ? h('p', { className: 'nd-muted' }, '还没有阶段。')
                : h('ol', { className: 'nd-stages' }, stages.map((stage) => h('li', { key: stage.id, className: `nd-stage nd-stage-${stage.status || 'pending'}` },
                    h('span', { className: 'nd-stage-dot' }, stage.status === 'done' ? '✓' : stage.status === 'running' ? '●' : stage.status === 'skipped' ? '–' : '○'),
                    h('span', { className: 'nd-stage-title' }, String(stage.title || stage.id || '')),
                    stage.note ? h('span', { className: 'nd-hint' }, String(stage.note)) : null,
                  ))),
              h('p', { className: 'nd-hint' }, '阶段由宿主推进；这里只用 run.save 改状态。'),
            ),
            h('section', { className: 'nd-card' },
              h('div', { className: 'nd-card-head' }, h('strong', null, '预算')),
              h('div', { className: 'nd-budget' },
                h('div', { className: 'nd-budget-row' }, h('span', null, 'tokens'), h('span', null, `${fmtInt(budget.usedTokens)} / ${fmtInt(budget.maxTokens)}`), h(Bar, { value: budget.usedTokens, max: budget.maxTokens, tone: 'brand' })),
                h('div', { className: 'nd-budget-row' }, h('span', null, '费用（元）'), h('span', null, `${toNumber(budget.usedCostCNY, 0).toFixed(2)} / ${toNumber(budget.maxCostCNY, 0).toFixed(2)}`), h(Bar, { value: budget.usedCostCNY, max: budget.maxCostCNY, tone: 'warn' })),
              ),
              h('p', { className: 'nd-hint' }, run && run.kind === 'continue' ? '点「开工」把工作单发进对话后，AI 会按大纲逐章写新章（过闸门直接落盘）。' : '点「开工」把工作单发进对话后，AI 会按阶段推进；产物只进提案。'),
            ),
          ),
          h('section', { className: 'nd-card' },
            h('div', { className: 'nd-card-head' }, h('strong', null, '备注') ),
            notes.length === 0
              ? h('p', { className: 'nd-muted' }, '暂无备注。')
              : h('ul', { className: 'nd-notes-list' }, notes.map((note, index) => h('li', { key: index }, typeof note === 'string' ? note : String(note.text || note.message || JSON.stringify(note))))),
          ),
        )
      }

      return h('div', { className: 'nd-page' },
        h('div', { className: 'nd-pagehead' },
          h('h2', null, '全文动作'),
          h('span', { className: 'nd-hint' }, '整本书级动作只有一份状态（run 单例）。产物只进提案，不会直接改正文。'),
        ),
        h('div', { className: 'nd-attention-note' },
          h('strong', null, '⚡ 第一步永远是注意力设计'),
          h('span', null, '开工前先写一句本章的注意力目标（靠什么把读者拽着往下读）；不要求四拍。写完后冷读独立打分。'),
        ),
        notice && !run ? h(Msg, { tone: notice.tone, onClose: () => setNotice(null) }, notice.text) : null,
        runRes.loading && !runRes.data ? h(Loading, null, '正在读取全文动作…') : runRes.error ? h(ErrorBox, { error: runRes.error, onRetry: runRes.reload }) : content,
        dialog ? h(RunDialog, { projectId, toc, onClose: () => setDialog(false), onCreated: () => { setDialog(false); runRes.reload() } }) : null,
      )
    }

    // ── 世界地图（世界坐标直绘：区域 / 山水 / 路线 / 地点共用一套坐标） ──
    // 设计要点：
    //  1. 不再把地点 bbox 拉伸到画布，也不做「疏密自适应」——直接画世界坐标，
    //     所以山水、区域、路线、地名永远在同一套坐标系里，放大缩小都对得上。
    //  2. AI 方案（mapStyle.aiPlan）里的【区域】【路线】会被解析成真实图元；
    //     没有方案时退化成按 region/type 推导，绝不再画 24 个模糊泡泡。
    //  3. 纯函数区（map-model start/end 之间）不许引用外部变量，测试直接切出来跑。
    /* @novel-desk:map-model start */
    const MAP_PALETTES = [
      { id: 'ink', name: '水墨绢本', paper: '#f6f1e6', ink: '#8b8378', label: '#4f473c', water: '#9dc0cc', ridge: '#cbbfa3', accent: '#b45309' },
      { id: 'ochre', name: '赭石古卷', paper: '#f3ead9', ink: '#7c6f5c', label: '#4a3f2e', water: '#93bdb6', ridge: '#c8b18a', accent: '#9a3412' },
      { id: 'jade', name: '青绿山河', paper: '#f1f4ec', ink: '#6f7c6b', label: '#3f4b3c', water: '#8fc0c9', ridge: '#b7cbb0', accent: '#0f766e' },
      { id: 'sepia', name: '羊皮纸', paper: '#efe2c9', ink: '#6d5c44', label: '#463726', water: '#b3c4ac', ridge: '#c6ab80', accent: '#8a5a12' },
      { id: 'steel', name: '冷灰史诗', paper: '#e8eaec', ink: '#5b636b', label: '#39414a', water: '#9db4c2', ridge: '#b0b6bb', accent: '#38556b' },
      { id: 'wine', name: '暗红纪事', paper: '#ede4d8', ink: '#6b5650', label: '#42302a', water: '#b9c4cb', ridge: '#c9ad9c', accent: '#7f1d1d' },
    ]
    const MAP_LEGEND = [
      { glyph: 'capital', label: '都城' },
      { glyph: 'city', label: '州府' },
      { glyph: 'town', label: '城镇' },
      { glyph: 'pass', label: '关隘' },
      { glyph: 'temple', label: '寺观' },
      { glyph: 'water', label: '津渡' },
      { glyph: 'site', label: '遗迹' },
    ]
    const MAP_HILL_WORDS = /山|峰|岭|谷|崖|峡|陇|坂|陵/
    const MAP_PASS_WORDS = /关$|关|隘|津|渡$/
    const MAP_TEMPLE_WORDS = /寺|观|庙|祠|庵|阁$/
    const MAP_WATER_WORDS = /河|江|湖|海|渠|溪|水$|渡|津|码头|浦|湾/
    const MAP_WATER_NAME = /([\u4e00-\u9fa5]{1,3}(?:河|江|湖|渠|溪|水))/
    function mapNum(value, fallback) {
      const n = Number(value)
      return Number.isFinite(n) ? n : fallback
    }
    function mapClamp(value, min, max) {
      if (max < min) return (min + max) / 2
      return Math.min(max, Math.max(min, value))
    }
    function mapRound(value, digits) {
      const base = Math.pow(10, digits === undefined ? 1 : digits)
      return Math.round(value * base) / base
    }
    function mapSize(world) {
      const w = mapNum(world && world.mapSize && world.mapSize.w, 0)
      const h = mapNum(world && world.mapSize && world.mapSize.h, 0)
      return { w: w > 0 ? w : 1000, h: h > 0 ? h : 1000 }
    }
    function mapRandom(seed) {
      let state = (Math.floor(mapNum(seed, 1)) || 1) >>> 0
      return () => {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        state >>>= 0
        return state / 4294967296
      }
    }
    function mapPalette(world) {
      const id = String((world && world.mapStyle && world.mapStyle.palette) || 'ink')
      return MAP_PALETTES.find((row) => row.id === id) || MAP_PALETTES[0]
    }
    function mapPlanRaw(world) {
      const raw = world && world.mapStyle && world.mapStyle.aiPlan
      if (!raw) return null
      if (typeof raw === 'string') return { text: raw.trim(), savedAt: '' }
      return { text: String(raw.text || '').trim(), savedAt: String(raw.savedAt || '') }
    }
    function mapPlanSection(text, name) {
      const hit = String(text || '').match(new RegExp('【' + name + '】([\\s\\S]*?)(?=【|$)'))
      return hit ? hit[1].trim() : ''
    }
    function mapShort(text, max) {
      const raw = String(text || '').trim()
      if (!raw) return '未名'
      const parts = raw.split(/[·・]/).filter(Boolean)
      const tail = parts.length > 1 ? parts[parts.length - 1] : raw
      const limit = max || 9
      return tail.length > limit ? tail.slice(0, limit) : tail
    }
    function mapGlyphOf(row) {
      const type = String((row && row.type) || '').toLowerCase()
      const name = String((row && row.name) || '')
      if (type === 'capital') return 'capital'
      if (type === 'city' || type === 'prefecture') return 'city'
      if (type === 'pass') return 'pass'
      if (type === 'temple') return 'temple'
      if (type === 'pier' || type === 'port' || type === 'waterside' || type === 'ford' || type === 'bridge') return 'water'
      if (type === 'road') return 'road'
      if (type === 'town') return 'town'
      if (type === 'village' || type === 'dwelling' || type === 'building' || type === 'shop' || type === 'rest' || type === 'inn') return 'village'
      if (MAP_HILL_WORDS.test(name)) return 'mountain'
      if (MAP_PASS_WORDS.test(name)) return 'pass'
      if (MAP_TEMPLE_WORDS.test(name)) return 'temple'
      if (MAP_WATER_WORDS.test(name)) return 'water'
      return 'site'
    }
    function mapPriorityOf(row, glyph) {
      if (glyph === 'capital') return 0
      if (glyph === 'city' || glyph === 'pass') return 1
      if (glyph === 'temple' || glyph === 'town') return 2
      if (glyph === 'village' || glyph === 'water') return 3
      if (glyph === 'mountain') return 4
      return 5
    }
    function mapPoints(locations, size) {
      const out = []
      const seen = new Set()
      for (const row of Array.isArray(locations) ? locations : []) {
        if (!row || !row.coords) continue
        const x = mapNum(row.coords.x, NaN)
        const y = mapNum(row.coords.y, NaN)
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        const point = {
          id: String(row.id === undefined || row.id === null ? out.length : row.id),
          fullName: String(row.name || '').trim() || '未名地点',
          type: String(row.type || ''),
          region: String(row.region || ''),
          glyph: '',
          priority: 9,
          aliases: (Array.isArray(row.aliases) ? row.aliases : []).map((item) => String(item || '').trim()).filter(Boolean),
          x: mapClamp(x, 0, size.w),
          y: mapClamp(y, 0, size.h),
        }
        point.glyph = mapGlyphOf(row)
        point.priority = mapPriorityOf(row, point.glyph)
        const key = point.fullName + '|' + Math.round(point.x) + '|' + Math.round(point.y)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(point)
      }
      return out
    }
    function mapWaterChains(points) {
      const spots = points.filter((point) => point.glyph === 'water')
      const rest = spots.slice()
      const used = new Set()
      const chains = []
      const limit = 150
      const nearest = (from) => {
        let best = null
        let bestDistance = limit
        for (const spot of rest) {
          if (used.has(spot.id)) continue
          const distance = Math.hypot(spot.x - from.x, spot.y - from.y)
          if (distance < bestDistance) {
            best = spot
            bestDistance = distance
          }
        }
        return best
      }
      for (const spot of spots) {
        if (used.has(spot.id)) continue
        used.add(spot.id)
        const chain = [{ x: spot.x, y: spot.y, name: spot.fullName }]
        let head = chain[0]
        for (;;) {
          const next = nearest(head)
          if (!next) break
          used.add(next.id)
          chain.push({ x: next.x, y: next.y, name: next.fullName })
          head = chain[chain.length - 1]
        }
        let tail = chain[0]
        for (;;) {
          const next = nearest(tail)
          if (!next) break
          used.add(next.id)
          chain.unshift({ x: next.x, y: next.y, name: next.fullName })
          tail = chain[0]
        }
        if (chain.length >= 2) chains.push(chain)
      }
      // 只有 2 个点、又贴得很近的水点，多半是「同一条河上的两个点位」：沿走向补长成一个河段
      return chains.map((chain) => {
        const a = chain[0]
        const b = chain[chain.length - 1]
        const span = Math.hypot(b.x - a.x, b.y - a.y)
        const text = chain.map((row) => row.name).join(' ')
        const name = mapWaterName(text) || '水系'
        if (span >= 90) return { points: chain, name, kind: /运河|渠|漕/.test(text) ? 'canal' : 'river' }
        const dx = b.x - a.x
        const dy = b.y - a.y
        const norm = span > 0.5 ? span : 1
        const extra = (170 - span) / 2
        const head = { x: a.x - (dx / norm) * extra, y: a.y - (dy / norm) * extra }
        const tail = { x: b.x + (dx / norm) * extra, y: b.y + (dy / norm) * extra }
        return { points: [head, ...chain, tail], name, kind: /运河|渠|漕/.test(text) ? 'canal' : 'river' }
      })
    }
    function mapPlanRivers(world, regions) {
      const text = mapPlanRaw(world) ? mapPlanRaw(world).text : ''
      if (!text) return []
      const out = []
      for (const region of regions) {
        if (!region || !region.desc) continue
        const hint = region.desc.match(/y\s*[≈~=]?\s*(\d{3})/)
        if (!hint) continue
        const waterName = mapWaterName(region.desc)
        if (!waterName) continue
        const baseY = mapNum(hint[1], NaN)
        if (!Number.isFinite(baseY)) continue
        const x1 = region.bounds.x1 + (region.bounds.x2 - region.bounds.x1) * 0.08
        const x2 = region.bounds.x2 - (region.bounds.x2 - region.bounds.x1) * 0.08
        const span = x2 - x1
        const steps = Math.max(3, Math.round(span / 46))
        const points = []
        for (let index = 0; index <= steps; index += 1) {
          const t = index / steps
          points.push({
            x: mapRound(x1 + span * t, 1),
            y: mapRound(baseY + Math.sin(t * Math.PI * 2.1 + baseY) * 4, 1),
          })
        }
        out.push({ points, name: waterName, kind: /运河|渠/.test(waterName) ? 'canal' : 'river' })
      }
      return out
    }
    function mapPlanRegions(world, size) {
      const raw = mapPlanRaw(world)
      if (!raw) return []
      const body = mapPlanSection(raw.text, '区域')
      if (!body) return []
      const out = []
      for (const line of body.split(/\n+/)) {
        const parts = line.split(/[｜|]/).map((item) => item.trim())
        if (parts.length < 2) continue
        const range = parts[1]
        const mx = range.match(/[xX]\s*(\d+(?:\.\d+)?)\s*[–—\-~～至到]\s*(\d+(?:\.\d+)?)/)
        const my = range.match(/[yY]\s*(\d+(?:\.\d+)?)\s*[–—\-~～至到]\s*(\d+(?:\.\d+)?)/)
        if (!mx || !my) continue
        const x1 = mapClamp(Math.min(mapNum(mx[1], 0), mapNum(mx[2], 0)), 0, size.w)
        const x2 = mapClamp(Math.max(mapNum(mx[1], 0), mapNum(mx[2], 0)), 0, size.w)
        const y1 = mapClamp(Math.min(mapNum(my[1], 0), mapNum(my[2], 0)), 0, size.h)
        const y2 = mapClamp(Math.max(mapNum(my[1], 0), mapNum(my[2], 0)), 0, size.h)
        if (x2 - x1 < 20 || y2 - y1 < 20) continue
        out.push({
          fullName: parts[0],
          desc: parts.slice(2).join('｜'),
          bounds: { x1, y1, x2, y2 },
          source: 'aiPlan',
        })
      }
      return out
    }
    function mapDerivedRegions(points, size) {
      const buckets = new Map()
      for (const point of points) {
        const key = String(point.region || '').split(/[·・]/)[0].trim() || '未分区'
        if (!buckets.has(key)) buckets.set(key, [])
        buckets.get(key).push(point)
      }
      const out = []
      for (const [name, rows] of buckets) {
        const xs = rows.map((row) => row.x)
        const ys = rows.map((row) => row.y)
        const pad = 55
        const x1 = mapClamp(Math.min.apply(null, xs) - pad, 0, size.w)
        const x2 = mapClamp(Math.max.apply(null, xs) + pad, 0, size.w)
        const y1 = mapClamp(Math.min.apply(null, ys) - pad, 0, size.h)
        const y2 = mapClamp(Math.max.apply(null, ys) + pad, 0, size.h)
        out.push({
          fullName: name,
          desc: rows.length + ' 个地点',
          bounds: {
            x1,
            x2: Math.max(x2, x1 + 120),
            y1,
            y2: Math.max(y2, y1 + 90),
          },
          source: 'derived',
        })
      }
      return out.sort((a, b) => b.bounds.x2 - b.bounds.x1 - (a.bounds.x2 - a.bounds.x1))
    }
    function mapBoxDistance(box, x, y) {
      const dx = x < box.x1 ? box.x1 - x : x > box.x2 ? x - box.x2 : 0
      const dy = y < box.y1 ? box.y1 - y : y > box.y2 ? y - box.y2 : 0
      return Math.hypot(dx, dy)
    }
    function mapRegionLabel(text) {
      const raw = String(text || '').trim()
      if (!raw) return '未名'
      return raw.replace(/(地区|区域|区)$/, '') || raw
    }
    function mapWaterName(text) {
      const raw = String(text || '')
      const suffixes = ['河', '江', '渠', '溪', '水']
      for (let index = 0; index < raw.length; index += 1) {
        if (suffixes.indexOf(raw[index]) < 0) continue
        for (const take of [2, 3, 1]) {
          const start = index - take + 1
          if (start < 0) continue
          const name = raw.slice(start, index + 1)
          if (!/^[\u4e00-\u9fa5]{2,3}$/.test(name)) continue
          // 连接词、方位词、「水域/水名」这类普通词都不该被当成河名
          if (/[与和及自之的在从到经沿向于对由]/.test(name[0])) continue
          if (/[有的一是了内外中上下东西南北前后左右的个该此其名位量平面流注汇口为]/.test(name)) continue
          return name
        }
      }
      return ''
    }
    function mapHits(box, list) {
      return list.some((other) => !(box.x2 < other.x1 || box.x1 > other.x2 || box.y2 < other.y1 || box.y1 > other.y2))
    }
    function mapInside(box, x, y, margin) {
      const pad = margin || 0
      return x >= box.x1 - pad && x <= box.x2 + pad && y >= box.y1 - pad && y <= box.y2 + pad
    }
    function mapRanges(regions, points, rivers, seed) {
      const rand = mapRandom(seed * 7919 + 13)
      const out = []
      const tooClose = (x, y, gaps) => {
        if (gaps.points && points.some((point) => Math.hypot(point.x - x, point.y - y) < gaps.points)) return true
        if (gaps.rivers && rivers.some((river) => river.points.some((point) => Math.hypot(point.x - x, point.y - y) < gaps.rivers))) return true
        if (gaps.ranges && out.some((range) => range.points.some((point) => Math.hypot(point.x - x, point.y - y) < gaps.ranges))) return true
        return false
      }
      const makeChain = (cx, cy) => {
        const angle = rand() * Math.PI * 2
        const length = 55 + rand() * 65
        const size = 7 + rand() * 4.5
        const wobble = (rand() - 0.5) * 18
        const dx = Math.cos(angle)
        const dy = Math.sin(angle)
        const midX = cx + dx * length * 0.5 - dy * wobble * 0.4
        const midY = cy + dy * length * 0.5 + dx * wobble * 0.4
        return {
          size,
          points: [
            { x: cx - dx * length * 0.5, y: cy - dy * length * 0.5 },
            { x: midX, y: midY },
            { x: cx + dx * length * 0.5, y: cy + dy * length * 0.5 },
          ],
        }
      }
      // ① 关隘/山地类地点：就地长出一道山脊（关隘本来就在山口上）
      const anchors = points.filter((point) => point.glyph === 'mountain' || point.glyph === 'pass')
      for (const anchor of anchors) {
        if (out.length >= 22) break
        const near = out.some((range) => Math.hypot(range.points[1].x - anchor.x, range.points[1].y - anchor.y) < 60)
        if (near) continue
        out.push(Object.assign(makeChain(anchor.x, anchor.y), { name: mapShort(anchor.fullName, 4), tone: 'anchor' }))
      }
      // ② 区域描述里点了名的山：在区域内撒一两道，避开地点与水系
      for (const region of regions) {
        if (out.length >= 26) break
        if (!region.desc || !/山|岭|峡|谷|峰|崖|丘陵|塬/.test(region.desc)) continue
        const width = region.bounds.x2 - region.bounds.x1
        const height = region.bounds.y2 - region.bounds.y1
        const area = width * height
        const count = Math.max(1, Math.min(3, Math.round(area / 52000)))
        for (let index = 0; index < count; index += 1) {
          for (let attempt = 0; attempt < 14; attempt += 1) {
            const x = region.bounds.x1 + width * (0.12 + rand() * 0.76)
            const y = region.bounds.y1 + height * (0.12 + rand() * 0.76)
            if (tooClose(x, y, { points: 42, rivers: 26, ranges: 78 })) continue
            out.push(Object.assign(makeChain(x, y), { name: '', tone: 'fill' }))
            break
          }
        }
      }
      return out
    }
    function mapResolveName(text, points) {
      const raw = String(text || '').trim()
      if (!raw) return null
      const clean = raw.replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '')
      if (!clean) return null
      return points.find((point) => point.fullName === raw)
        || points.find((point) => point.fullName === clean)
        || points.find((point) => point.aliases.indexOf(clean) >= 0)
        || points.find((point) => clean.length >= 3 && point.fullName.length >= 3 && point.fullName.indexOf(clean) >= 0)
        || points.find((point) => clean.length >= 3 && point.fullName.length >= 3 && clean.indexOf(point.fullName) >= 0)
        || null
    }
    function mapPlanRoutes(world, points) {
      const raw = mapPlanRaw(world)
      if (!raw) return []
      const body = mapPlanSection(raw.text, '路线')
      if (!body) return []
      const out = []
      for (const line of body.split(/\n+/)) {
        const parts = line.split(/[｜|]/).map((item) => item.trim())
        if (!parts[0]) continue
        const candidates = [parts[0].split(/→|->|\u2192/)]
        if (parts[1]) candidates.push(parts[1].split(/[—–\-~～]|至/))
        let best = null
        for (const candidate of candidates) {
          const names = candidate.map((item) => item.trim()).filter(Boolean)
          const resolved = []
          for (const name of names) {
            const point = mapResolveName(name, points)
            if (!point) continue
            const last = resolved[resolved.length - 1]
            if (last && last.id === point.id) continue
            resolved.push(point)
          }
          if (resolved.length >= 2 && (!best || resolved.length > best.length)) best = resolved
        }
        if (!best) continue
        const text = parts.join(' ')
        out.push({
          id: 'r' + out.length,
          name: parts[0],
          terrain: parts[1] || '',
          note: parts[2] || '',
          kind: /舟|船|水|江|河|运|渡|津/.test(text) ? 'water' : 'road',
          stops: best.map((point) => ({ id: point.id, name: point.fullName, x: point.x, y: point.y })),
        })
      }
      return out
    }
    function mapTrailRoutes(events, points) {
      const rows = (Array.isArray(events) ? events : [])
        .map((event, index) => ({ event, index }))
        .sort((a, b) => mapNum(a.event && a.event.chapter, 99999) - mapNum(b.event && b.event.chapter, 99999) || a.index - b.index)
      const stops = []
      for (const row of rows) {
        const name = String((row.event && row.event.location) || '').trim()
        if (!name) continue
        const point = mapResolveName(name, points)
        if (!point) continue
        const last = stops[stops.length - 1]
        if (last && last.id === point.id) continue
        stops.push({ id: point.id, name: point.fullName, x: point.x, y: point.y })
      }
      if (stops.length < 2) return []
      return [{ id: 'trail', name: '行程（按事件顺序）', terrain: '', note: '', kind: 'trail', stops }]
    }
    function mapLabelLayout(points) {
      const boxes = []
      const glyphBoxes = points.map((point) => ({ x1: point.x - 5.5, y1: point.y - 5.5, x2: point.x + 5.5, y2: point.y + 5.5 }))
      const hits = (box, list) => list.some((other) => !(box.x2 < other.x1 || box.x1 > other.x2 || box.y2 < other.y1 || box.y1 > other.y2))
      const order = points.slice().sort((a, b) => a.priority - b.priority || a.y - b.y || a.x - b.x)
      const labels = []
      const fs = 11
      const gap = 9
      for (const point of order) {
        const name = mapShort(point.fullName, 10)
        const width = Math.max(22, name.length * fs + 6)
        const height = fs + 5
        const candidates = [
          [gap, -height / 2, 'start'],
          [-gap - width, -height / 2, 'start'],
          [-width / 2, -gap - height, 'start'],
          [-width / 2, gap, 'start'],
          [gap, -gap - height, 'start'],
          [-gap - width, -gap - height, 'start'],
          [gap, gap, 'start'],
          [-gap - width, gap, 'start'],
          [gap, gap * 3, 'start'],
          [-gap - width, gap * 3, 'start'],
          [gap, -gap * 3 - height, 'start'],
          [-gap - width, -gap * 3 - height, 'start'],
          [gap * 2.4, -height / 2, 'start'],
          [-gap * 2.4 - width, -height / 2, 'start'],
          [-width / 2, -gap * 2.4 - height, 'start'],
          [-width / 2, gap * 2.4, 'start'],
          [gap * 2.4, -gap * 2.4 - height, 'start'],
          [-gap * 2.4 - width, gap * 2.4, 'start'],
        ]
        let placed = null
        for (const candidate of candidates) {
          const box = {
            x1: point.x + candidate[0],
            y1: point.y + candidate[1],
            x2: point.x + candidate[0] + width,
            y2: point.y + candidate[1] + height,
          }
          if (hits(box, boxes) || hits(box, glyphBoxes)) continue
          placed = { box, candidate }
          break
        }
        if (placed) {
          boxes.push(placed.box)
          labels.push({
            id: point.id,
            name,
            x: mapRound(placed.box.x1, 1),
            y: mapRound(placed.box.y1 + height / 2, 1),
            zoom: point.priority <= 2 ? 1 : point.priority === 3 ? 1.2 : 1.5,
            leader: false,
          })
        } else {
          labels.push({
            id: point.id,
            name,
            x: mapRound(point.x + gap, 1),
            y: mapRound(point.y - gap - height / 2, 1),
            zoom: 1.55,
            leader: true,
            anchorX: point.x,
            anchorY: point.y,
          })
        }
      }
      return labels
    }
    function mapViewBox(points, regions, labels, size) {
      let x1 = Infinity
      let y1 = Infinity
      let x2 = -Infinity
      let y2 = -Infinity
      const take = (x, y) => {
        if (x < x1) x1 = x
        if (y < y1) y1 = y
        if (x > x2) x2 = x
        if (y > y2) y2 = y
      }
      for (const point of points) take(point.x, point.y)
      for (const label of labels || []) {
        take(label.x - 4, label.y - 9)
        take(label.x + label.name.length * 10 + 6, label.y + 9)
      }
      if (x1 === Infinity) {
        return { x: 0, y: 0, w: size.w, h: size.h }
      }
      const pad = Math.max(34, Math.max(size.w, size.h) * 0.045)
      // 不夹到 mapSize：地名可能落在边界外一点，宁可让纸面多出一点，也不要裁掉字
      x1 = Math.max(-40, x1 - pad)
      y1 = Math.max(-40, y1 - pad)
      x2 = Math.min(size.w + 60, x2 + pad)
      y2 = Math.min(size.h + 60, y2 + pad)
      void regions
      return { x: mapRound(x1, 1), y: mapRound(y1, 1), w: mapRound(Math.max(120, x2 - x1), 1), h: mapRound(Math.max(120, y2 - y1), 1) }
    }
    function buildWorldMapScene(input) {
      const source = input || {}
      const world = source.world && typeof source.world === 'object' ? source.world : {}
      const size = mapSize(world)
      const palette = mapPalette(world)
      const seed = mapNum(world && world.mapStyle && world.mapStyle.seed, 1)
      const planRaw = mapPlanRaw(world)
      const points = mapPoints(source.locations, size)
      let regionRows = mapPlanRegions(world, size)
      let regionSource = 'aiPlan'
      if (regionRows.length < 2) {
        regionRows = mapDerivedRegions(points, size)
        regionSource = 'derived'
      }
      const regions = regionRows.map((row, index) => ({
        id: 'z' + index,
        name: mapRegionLabel(row.fullName),
        fullName: row.fullName,
        desc: row.desc || '',
        bounds: row.bounds,
        source: row.source,
        cx: (row.bounds.x1 + row.bounds.x2) / 2,
        cy: (row.bounds.y1 + row.bounds.y2) / 2,
      }))
      const planRivers = mapPlanRivers(world, regions)
      const chainRivers = mapWaterChains(points)
      const rivers = planRivers.concat(chainRivers)
      const ranges = mapRanges(regions, points, rivers, seed)
      let routes = mapPlanRoutes(world, points)
      let routeSource = 'aiPlan'
      if (routes.length === 0) {
        routes = mapTrailRoutes(source.events, points)
        routeSource = routes.length > 0 ? 'events' : 'none'
      }
      const labels = mapLabelLayout(points)
      // 区域名、河名要避开地点符号与地名，否则「京畿关内」会压在「长安」上
      const taken = points.map((point) => ({ x1: point.x - 7, y1: point.y - 7, x2: point.x + 7, y2: point.y + 7 }))
      for (const label of labels) taken.push({ x1: label.x, y1: label.y - 8, x2: label.x + label.name.length * 11, y2: label.y + 8 })
      for (const region of regions) {
        const box = region.bounds
        const width = Math.max(44, region.name.length * 12 + 12)
        const height = 18
        const options = [
          { x: region.cx, y: box.y1 + 18, anchor: 'middle' },
          { x: region.cx, y: box.y2 - 14, anchor: 'middle' },
          { x: box.x1 + 14, y: box.y2 - 14, anchor: 'start' },
          { x: box.x2 - 14, y: box.y2 - 14, anchor: 'end' },
          { x: box.x1 + 14, y: box.y1 + 20, anchor: 'start' },
          { x: region.cx, y: region.cy, anchor: 'middle' },
        ]
        let placed = null
        for (const option of options) {
          const x1 = option.anchor === 'middle' ? option.x - width / 2 : option.anchor === 'end' ? option.x - width : option.x
          const rect = { x1, y1: option.y - height / 2, x2: x1 + width, y2: option.y + height / 2 }
          if (mapHits(rect, taken)) continue
          placed = { rect, option }
          break
        }
        if (placed) {
          taken.push(placed.rect)
          region.labelX = placed.option.x
          region.labelY = placed.option.y
          region.labelAnchor = placed.option.anchor
        } else {
          region.labelX = region.cx
          region.labelY = box.y1 + 18
          region.labelAnchor = 'middle'
          region.labelFaint = true
        }
      }
      for (const river of rivers) {
        if (!river.name || river.points.length < 2) continue
        const width = Math.max(30, river.name.length * 11 + 8)
        const height = 14
        const options = []
        const fracs = [0.5, 0.34, 0.66, 0.2, 0.8, 0.08, 0.92]
        for (const frac of fracs) {
          const at = river.points[Math.min(river.points.length - 1, Math.round((river.points.length - 1) * frac))]
          if (!at) continue
          options.push({ x: at.x, y: at.y - 16, anchor: 'middle' })
          options.push({ x: at.x, y: at.y + 20, anchor: 'middle' })
          options.push({ x: at.x + 15, y: at.y + 7, anchor: 'start' })
          options.push({ x: at.x - 15, y: at.y + 7, anchor: 'end' })
          options.push({ x: at.x + 15, y: at.y - 20, anchor: 'start' })
          options.push({ x: at.x - 15, y: at.y - 20, anchor: 'end' })
        }
        let placed = null
        for (const option of options) {
          const x1 = option.anchor === 'middle' ? option.x - width / 2 : option.anchor === 'end' ? option.x - width : option.x
          const rect = { x1, y1: option.y - height / 2, x2: x1 + width, y2: option.y + height / 2 }
          if (mapHits(rect, taken)) continue
          placed = { rect, option }
          break
        }
        // 实在挤不下就不画河名：宁可少一个字，也不要压在地名上
        if (!placed) continue
        taken.push(placed.rect)
        river.labelX = placed.option.x
        river.labelY = placed.option.y
        river.labelAnchor = placed.option.anchor
      }
      return {
        name: String(world.name || '').trim() || '世界地图',
        era: String(world.era || '').trim(),
        palette,
        mapSize: size,
        seed,
        viewBox: mapViewBox(points, regions, labels, size),
        points,
        regions,
        rivers,
        ranges,
        routes,
        labels,
        planText: planRaw ? planRaw.text : '',
        planSavedAt: planRaw ? planRaw.savedAt : '',
        regionSource,
        routeSource,
        warnings: [],
      }
    }
    function mapSpline(rows) {
      const pts = (Array.isArray(rows) ? rows : []).filter((row) => row && Number.isFinite(row.x) && Number.isFinite(row.y))
      if (pts.length === 0) return ''
      if (pts.length === 1) return 'M' + mapRound(pts[0].x, 1) + ',' + mapRound(pts[0].y, 1)
      if (pts.length === 2) return 'M' + mapRound(pts[0].x, 1) + ',' + mapRound(pts[0].y, 1) + 'L' + mapRound(pts[1].x, 1) + ',' + mapRound(pts[1].y, 1)
      let path = 'M' + mapRound(pts[0].x, 1) + ',' + mapRound(pts[0].y, 1)
      for (let index = 0; index < pts.length - 1; index += 1) {
        const p0 = pts[Math.max(0, index - 1)]
        const p1 = pts[index]
        const p2 = pts[index + 1]
        const p3 = pts[Math.min(pts.length - 1, index + 2)]
        const c1x = p1.x + (p2.x - p0.x) / 6
        const c1y = p1.y + (p2.y - p0.y) / 6
        const c2x = p2.x - (p3.x - p1.x) / 6
        const c2y = p2.y - (p3.y - p1.y) / 6
        path += 'C' + mapRound(c1x, 1) + ',' + mapRound(c1y, 1) + ' ' + mapRound(c2x, 1) + ',' + mapRound(c2y, 1) + ' ' + mapRound(p2.x, 1) + ',' + mapRound(p2.y, 1)
      }
      return path
    }
    function mapPointAt(rows, ratio) {
      const pts = Array.isArray(rows) ? rows : []
      if (pts.length === 0) return null
      if (pts.length === 1) return pts[0]
      const clamped = Math.max(0, Math.min(1, ratio))
      const total = pts.length - 1
      const scaled = clamped * total
      const index = Math.min(total - 1, Math.floor(scaled))
      const t = scaled - index
      return {
        x: pts[index].x + (pts[index + 1].x - pts[index].x) * t,
        y: pts[index].y + (pts[index + 1].y - pts[index].y) * t,
      }
    }
    function mapRangeLength(rows) {
      let total = 0
      for (let index = 1; index < rows.length; index += 1) {
        total += Math.hypot(rows[index].x - rows[index - 1].x, rows[index].y - rows[index - 1].y)
      }
      return total
    }
    function mapGlyphShapes(glyph, size, palette) {
      const s = size / 9
      const ink = palette.label
      const paper = palette.paper
      if (glyph === 'capital') {
        return [
          { t: 'rect', a: { x: -4.6 * s, y: -4.6 * s, width: 9.2 * s, height: 9.2 * s, fill: paper, stroke: ink, strokeWidth: 1.7 } },
          { t: 'rect', a: { x: -2 * s, y: -2 * s, width: 4 * s, height: 4 * s, fill: ink } },
        ]
      }
      if (glyph === 'city') {
        return [{ t: 'rect', a: { x: -3.7 * s, y: -3.7 * s, width: 7.4 * s, height: 7.4 * s, fill: paper, stroke: ink, strokeWidth: 1.5 } }]
      }
      if (glyph === 'town') {
        return [{ t: 'circle', a: { cx: 0, cy: 0, r: 2.9 * s, fill: ink, fillOpacity: 0.88 } }]
      }
      if (glyph === 'village') {
        return [{ t: 'circle', a: { cx: 0, cy: 0, r: 2.1 * s, fill: ink, fillOpacity: 0.72 } }]
      }
      if (glyph === 'pass') {
        return [{ t: 'path', a: { d: 'M' + (-5.2 * s) + ' ' + (4.2 * s) + 'V' + (-1.6 * s) + 'L0 ' + (-5 * s) + 'L' + (5.2 * s) + ' ' + (-1.6 * s) + 'V' + (4.2 * s), fill: 'none', stroke: ink, strokeWidth: 1.5, strokeLinejoin: 'round' } }]
      }
      if (glyph === 'temple') {
        return [
          { t: 'path', a: { d: 'M' + (-5 * s) + ' ' + (0.4 * s) + 'L0 ' + (-4.6 * s) + 'L' + (5 * s) + ' ' + (0.4 * s) + 'Z', fill: palette.ridge, stroke: ink, strokeWidth: 1.2, strokeLinejoin: 'round' } },
          { t: 'path', a: { d: 'M0 ' + (0.4 * s) + 'V' + (4.2 * s), fill: 'none', stroke: ink, strokeWidth: 1.2 } },
        ]
      }
      if (glyph === 'water') {
        return [{ t: 'path', a: { d: 'M0 ' + (-3.7 * s) + 'L' + (3.7 * s) + ' 0L0 ' + (3.7 * s) + 'L' + (-3.7 * s) + ' 0Z', fill: palette.water, stroke: ink, strokeWidth: 1 } }]
      }
      if (glyph === 'road') {
        return [
          { t: 'path', a: { d: 'M' + (-4.6 * s) + ' ' + (-2.6 * s) + 'L' + (4.6 * s) + ' ' + (2.6 * s), fill: 'none', stroke: ink, strokeWidth: 1.5 } },
          { t: 'path', a: { d: 'M' + (4.6 * s) + ' ' + (-2.6 * s) + 'L' + (-4.6 * s) + ' ' + (2.6 * s), fill: 'none', stroke: ink, strokeWidth: 1.5, strokeOpacity: 0.5 } },
        ]
      }
      if (glyph === 'mountain') {
        return [{ t: 'path', a: { d: 'M' + (-4.8 * s) + ' ' + (3.2 * s) + 'L0 ' + (-3.4 * s) + 'L' + (4.8 * s) + ' ' + (3.2 * s), fill: 'none', stroke: ink, strokeWidth: 1.4, strokeLinejoin: 'round' } }]
      }
      return [{ t: 'circle', a: { cx: 0, cy: 0, r: 1.9 * s, fill: ink, fillOpacity: 0.6 } }]
    }
    function mapNode(tag, attrs, children, key) {
      return { t: tag, a: attrs || {}, c: children === undefined ? null : children, k: key }
    }
    function mapSceneLayers(scene, view, options) {
      const opts = options || {}
      const box = view || scene.viewBox
      const scale = mapNum(opts.scale, 1) || 1
      const thin = 1 / scale
      const show = Object.assign({ regions: true, terrain: true, routes: true, labels: true }, opts.show || {})
      const palette = scene.palette
      const picked = opts.pickedId ? String(opts.pickedId) : ''
      const layers = { view: box, paper: [], regions: [], water: [], ranges: [], routes: [], points: [], labels: [] }
      layers.paper.push(mapNode('rect', { x: box.x, y: box.y, width: box.w, height: box.h, fill: palette.paper }, null, 'paper'))
      const inset = 9 * thin
      layers.paper.push(mapNode('rect', {
        x: box.x + inset,
        y: box.y + inset,
        width: Math.max(1, box.w - inset * 2),
        height: Math.max(1, box.h - inset * 2),
        fill: 'none',
        stroke: palette.ink,
        strokeWidth: 1.2 * thin,
        strokeOpacity: 0.28,
      }, null, 'frame'))
      if (show.regions) {
        for (const region of scene.regions) {
          const box2 = region.bounds
          layers.regions.push(mapNode('rect', {
            x: box2.x1,
            y: box2.y1,
            width: Math.max(1, box2.x2 - box2.x1),
            height: Math.max(1, box2.y2 - box2.y1),
            rx: 7 * thin,
            ry: 7 * thin,
            fill: palette.ink,
            fillOpacity: 0.05,
            stroke: palette.ink,
            strokeOpacity: 0.24,
            strokeWidth: 1 * thin,
            strokeDasharray: (7 * thin) + ' ' + (8 * thin),
            className: 'ndm-zone',
          }, null, region.id))
          layers.regions.push(mapNode('text', {
            x: region.labelX === undefined ? region.cx : region.labelX,
            y: region.labelY === undefined ? box2.y1 + 18 : region.labelY,
            className: 'ndm-zone-label',
            fontSize: 12 * thin,
            letterSpacing: (2.6 * thin) + 'px',
            fill: palette.label,
            fillOpacity: region.labelFaint ? 0.34 : 0.46,
            textAnchor: region.labelAnchor || 'middle',
            dominantBaseline: 'middle',
            paintOrder: 'stroke',
            stroke: palette.paper,
            strokeWidth: 3.2 * thin,
            strokeOpacity: 0.85,
          }, region.name, region.id + '-label'))
        }
      }
      if (show.terrain) {
        for (const river of scene.rivers) {
          const path = mapSpline(river.points)
          layers.water.push(mapNode('path', {
            d: path,
            fill: 'none',
            stroke: palette.water,
            strokeWidth: 6.5 * thin,
            strokeOpacity: 0.55,
            strokeLinecap: 'round',
            className: 'ndm-water',
          }, null, 'w' + layers.water.length))
          layers.water.push(mapNode('path', {
            d: path,
            fill: 'none',
            stroke: palette.water,
            strokeWidth: 1.5 * thin,
            strokeOpacity: 0.95,
            strokeLinecap: 'round',
            strokeDasharray: river.kind === 'canal' ? (3 * thin) + ' ' + (5 * thin) : undefined,
            className: 'ndm-water-line',
          }, null, 'wl' + layers.water.length))
          if (river.name && river.labelX !== undefined) {
            layers.water.push(mapNode('text', {
              x: river.labelX,
              y: river.labelY,
              className: 'ndm-water-label',
              fontSize: 10 * thin,
              letterSpacing: (1.2 * thin) + 'px',
              fill: palette.label,
              fillOpacity: 0.62,
              textAnchor: river.labelAnchor || 'middle',
              dominantBaseline: 'middle',
              paintOrder: 'stroke',
              stroke: palette.paper,
              strokeWidth: 3 * thin,
              strokeOpacity: 0.8,
              fontStyle: 'italic',
            }, river.name, 'wn' + layers.water.length))
          }
        }
        for (const range of scene.ranges) {
          const length = mapRangeLength(range.points)
          const count = Math.max(2, Math.round(length / (range.size * 1.45)))
          for (let index = 0; index <= count; index += 1) {
            const point = mapPointAt(range.points, index / count)
            if (!point) continue
            const size = range.size * (0.82 + ((index * 37) % 7) / 5.5)
            const half = size * 0.72
            layers.ranges.push(mapNode('path', {
              d: 'M' + mapRound(point.x - half, 1) + ' ' + mapRound(point.y + size * 0.5, 1)
                + 'L' + mapRound(point.x, 1) + ' ' + mapRound(point.y - size * 0.62, 1)
                + 'L' + mapRound(point.x + half, 1) + ' ' + mapRound(point.y + size * 0.5, 1),
              fill: palette.ridge,
              fillOpacity: 0.42,
              stroke: palette.ink,
              strokeOpacity: 0.5,
              strokeWidth: 1 * thin,
              strokeLinejoin: 'round',
              className: 'ndm-hill',
            }, null, 'h' + layers.ranges.length))
          }
        }
      }
      if (show.routes) {
        for (const route of scene.routes) {
          const rows = route.stops.map((stop) => ({ x: stop.x, y: stop.y }))
          const path = rows.length > 2 ? mapSpline(rows) : mapSpline(rows)
          const isTrail = route.kind === 'trail'
          layers.routes.push(mapNode('path', {
            d: path,
            fill: 'none',
            stroke: isTrail ? palette.ink : route.kind === 'water' ? palette.water : palette.accent,
            strokeWidth: (isTrail ? 1.2 : 1.5) * thin,
            strokeOpacity: route.kind === 'water' ? 0.75 : 0.55,
            strokeDasharray: route.kind === 'water' ? (2 * thin) + ' ' + (5 * thin) : (7 * thin) + ' ' + (5 * thin),
            strokeLinecap: 'round',
            className: 'ndm-route',
          }, null, 'r' + route.id))
        }
      }
      for (const point of scene.points) {
        const chosen = picked && picked === point.id
        const size = (point.glyph === 'capital' ? 12 : point.glyph === 'city' || point.glyph === 'pass' ? 10.5 : 8.5) * thin
        const group = mapNode('g', { transform: 'translate(' + mapRound(point.x, 1) + ',' + mapRound(point.y, 1) + ')', className: 'ndm-pt' }, null, 'p' + point.id)
        const children = []
        if (chosen) {
          children.push(mapNode('circle', { cx: 0, cy: 0, r: 12 * thin, fill: 'none', stroke: palette.accent, strokeWidth: 2 * thin, strokeOpacity: 0.8 }, null, 'ring'))
        }
        for (const shape of mapGlyphShapes(point.glyph, size, palette)) {
          children.push(mapNode(shape.t, shape.a, null, 'g' + children.length))
        }
        children.push(mapNode('circle', { cx: 0, cy: 0, r: 7.5 * thin, fill: 'transparent', pointerEvents: 'all' }, null, 'hit'))
        group.children = children
        group.pick = point.id
        group.title = point.fullName
        layers.points.push(group)
      }
      if (show.labels) {
        for (const label of scene.labels) {
          if (scale + 0.001 < mapNum(label.zoom, 1) && picked !== label.id) continue
          if (label.leader) {
            layers.labels.push(mapNode('line', {
              x1: label.anchorX,
              y1: label.anchorY,
              x2: label.x,
              y2: label.y,
              stroke: palette.ink,
              strokeOpacity: 0.4,
              strokeWidth: 0.8 * thin,
              className: 'ndm-leader',
            }, null, 'll' + label.id))
          }
          layers.labels.push(mapNode('text', {
            x: label.x,
            y: label.y,
            className: 'ndm-label',
            fontSize: 11 * thin,
            fill: palette.label,
            textAnchor: 'start',
            dominantBaseline: 'middle',
            paintOrder: 'stroke',
            stroke: palette.paper,
            strokeWidth: 3 * thin,
            strokeOpacity: 0.9,
          }, label.name, 'lt' + label.id))
        }
      }
      return layers
    }
    function mapSceneToSvg(scene, view, options) {
      const layers = mapSceneLayers(scene, view, options)
      const box = layers.view
      const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + box.x + ' ' + box.y + ' ' + box.w + ' ' + box.h + '" preserveAspectRatio="xMidYMid meet">'
      return head + layers.paper.map((node) => mapNodeMarkup(node)).join('') + layers.regions.map((node) => mapNodeMarkup(node)).join('')
        + layers.water.map((node) => mapNodeMarkup(node)).join('') + layers.ranges.map((node) => mapNodeMarkup(node)).join('')
        + layers.routes.map((node) => mapNodeMarkup(node)).join('') + layers.points.map((node) => mapNodeMarkup(node)).join('')
        + layers.labels.map((node) => mapNodeMarkup(node)).join('') + '</svg>'
    }
    function mapAttrName(key) {
      const map = {
        className: 'class',
        strokeWidth: 'stroke-width',
        strokeOpacity: 'stroke-opacity',
        strokeDasharray: 'stroke-dasharray',
        strokeLinecap: 'stroke-linecap',
        strokeLinejoin: 'stroke-linejoin',
        fillOpacity: 'fill-opacity',
        fontSize: 'font-size',
        textAnchor: 'text-anchor',
        dominantBaseline: 'dominant-baseline',
        letterSpacing: 'letter-spacing',
        paintOrder: 'paint-order',
        pointerEvents: 'pointer-events',
      }
      return map[key] || key
    }
    function mapNodeMarkup(node) {
      const attrs = Object.keys(node.a || {}).map((key) => {
        const value = node.a[key]
        if (value === undefined || value === null) return ''
        return ' ' + mapAttrName(key) + '="' + String(value).replace(/"/g, '&quot;') + '"'
      }).join('')
      if (node.children) return '<' + node.t + attrs + '>' + node.children.map((child) => mapNodeMarkup(child)).join('') + '</' + node.t + '>'
      if (node.c === null || node.c === undefined) return '<' + node.t + attrs + '/>'
      const text = String(node.c).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return '<' + node.t + attrs + '>' + text + '</' + node.t + '>'
    }
    /* @novel-desk:map-model end */
    function mapSvgNodes(nodes, onPick) {
      return (nodes || []).map((node) => {
        const props = Object.assign({ key: node.k }, node.a)
        if (node.pick) {
          props.onClick = (event) => {
            if (event && event.stopPropagation) event.stopPropagation()
            if (onPick) onPick(node.pick)
          }
          props.style = { cursor: 'pointer' }
        }
        if (node.title) props['aria-label'] = node.title
        if (node.children) return h(node.t, props, mapSvgNodes(node.children, onPick))
        if (node.c === null || node.c === undefined) return h(node.t, props)
        return h(node.t, props, node.c)
      })
    }
    function MapCanvas({ scene, view, scale, show, pickedId, onPick, svgRef, onWheel, onPointerDown, onPointerMove, onPointerUp, onPointerLeave, style, className }) {
      const layers = useMemo(() => mapSceneLayers(scene, view, { scale, show, pickedId }), [scene, view, scale, show, pickedId])
      const handlers = { onWheel, onPointerDown, onPointerMove, onPointerUp, onPointerLeave }
      return h('svg', Object.assign({
        ref: svgRef,
        className: className || 'nd-map-svg',
        viewBox: [layers.view.x, layers.view.y, layers.view.w, layers.view.h].join(' '),
        preserveAspectRatio: 'xMidYMid meet',
        style,
      }, handlers),
        h('g', { className: 'ndm-paper' }, mapSvgNodes(layers.paper, onPick)),
        h('g', { className: 'ndm-zones' }, mapSvgNodes(layers.regions, onPick)),
        h('g', { className: 'ndm-water-layer' }, mapSvgNodes(layers.water, onPick)),
        h('g', { className: 'ndm-hills' }, mapSvgNodes(layers.ranges, onPick)),
        h('g', { className: 'ndm-routes' }, mapSvgNodes(layers.routes, onPick)),
        h('g', { className: 'ndm-points' }, mapSvgNodes(layers.points, onPick)),
        h('g', { className: 'ndm-labels' }, mapSvgNodes(layers.labels, onPick)),
      )
    }
    function MapLegend({ palette, scene }) {
      return h('div', { className: 'ndm-legend' },
        h('div', { className: 'ndm-legend-row' }, MAP_LEGEND.map((row) => h('span', { className: 'ndm-legend-item', key: row.glyph },
          h('svg', { className: 'ndm-legend-glyph', viewBox: '-9 -9 18 18' }, mapSvgNodes(mapGlyphShapes(row.glyph, 11, palette).map((shape, index) => Object.assign({ k: 'g' + index }, shape)))),
          h('span', null, row.label),
        ))),
        h('div', { className: 'ndm-legend-foot' },
          `区域 ${scene.regions.length} · 山水 ${scene.rivers.length + scene.ranges.length} · 路线 ${scene.routes.length} · 地点 ${scene.points.length}`,
        ),
      )
    }
    function mapCartouche(scene) {
      return h('div', { className: 'ndm-cartouche' },
        h('div', { className: 'ndm-cartouche-title' }, scene.name),
        scene.era ? h('div', { className: 'ndm-cartouche-era' }, scene.era) : null,
        h('div', { className: 'ndm-cartouche-note' }, '据地点坐标与方案绘制 · 非实测比例'),
      )
    }
    function MapCartouche({ scene }) {
      return mapCartouche(scene)
    }
    function MapFull({ scene, picked, onPick, onClose, palette, show }) {
      const [view, setView] = useState(() => ({ x: scene.viewBox.x, y: scene.viewBox.y, w: scene.viewBox.w, h: scene.viewBox.h, scale: 1 }))
      const [drag, setDrag] = useState(null)
      const svgRef = useRef(null)
      const baseView = scene.viewBox
      const move = (next) => {
        const width = baseView.w / next.scale
        const height = baseView.h / next.scale
        const cx = mapClamp(next.cx, Math.min(baseView.x + width / 2, baseView.x + baseView.w / 2), Math.max(baseView.x + baseView.w - width / 2, baseView.x + baseView.w / 2))
        const cy = mapClamp(next.cy, Math.min(baseView.y + height / 2, baseView.y + baseView.h / 2), Math.max(baseView.y + baseView.h - height / 2, baseView.y + baseView.h / 2))
        setView({ scale: next.scale, w: width, h: height, x: cx - width / 2, y: cy - height / 2 })
      }
      const currentCenter = () => ({ cx: view.x + view.w / 2, cy: view.y + view.h / 2 })
      const zoomAt = (factor, sx, sy) => {
        const nextScale = mapClamp(view.scale * factor, 1, 8)
        const rect = svgRef.current ? svgRef.current.getBoundingClientRect() : { width: baseView.w, height: baseView.h, left: 0, top: 0 }
        const px = mapNum(sx, rect.width / 2) / Math.max(1, rect.width)
        const py = mapNum(sy, rect.height / 2) / Math.max(1, rect.height)
        const center = currentCenter()
        const focusX = view.x + view.w * px
        const focusY = view.y + view.h * py
        const nextW = baseView.w / nextScale
        const nextH = baseView.h / nextScale
        move({ scale: nextScale, cx: focusX + (center.cx - view.x - view.w / 2) - nextW * (px - 0.5), cy: focusY + (center.cy - view.y - view.h / 2) - nextH * (py - 0.5) })
      }
      const onWheel = (event) => {
        if (event.preventDefault) event.preventDefault()
        const rect = svgRef.current ? svgRef.current.getBoundingClientRect() : null
        const sx = rect && event.clientX ? event.clientX - rect.left : null
        const sy = rect && event.clientY ? event.clientY - rect.top : null
        zoomAt(event.deltaY > 0 ? 0.86 : 1.16, sx, sy)
      }
      const onPointerDown = (event) => {
        setDrag({ x: event.clientX, y: event.clientY, vx: view.x, vy: view.y })
      }
      const onPointerMove = (event) => {
        if (!drag) return
        const rect = svgRef.current ? svgRef.current.getBoundingClientRect() : { width: 1, height: 1 }
        const dx = event.clientX - drag.x
        const dy = event.clientY - drag.y
        move({ scale: view.scale, cx: drag.vx + view.w / 2 - (dx / Math.max(1, rect.width)) * view.w, cy: drag.vy + view.h / 2 - (dy / Math.max(1, rect.height)) * view.h })
      }
      const onPointerUp = () => setDrag(null)
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', { className: 'nd-mapfull' },
        h('div', { className: 'nd-mapfull-panel' },
          h('div', { className: 'nd-mapfull-head' },
            h('strong', null, scene.name),
            h('span', { className: 'nd-hint' }, `${scene.era || ''} ${scene.points.length} 个地点`),
            h('div', { className: 'nd-actions' },
              h(Btn, { small: true, onClick: () => setView({ x: baseView.x, y: baseView.y, w: baseView.w, h: baseView.h, scale: 1 }) }, '重置'),
              h(Btn, { small: true, onClick: () => zoomAt(1.35, null, null) }, '放大'),
              h(Btn, { small: true, onClick: () => zoomAt(0.74, null, null) }, '缩小'),
              h(Btn, { small: true, onClick: onClose }, '关闭'),
            ),
          ),
          h('div', { className: 'nd-mapfull-canvas' },
            h(MapCanvas, {
              scene,
              view: { x: view.x, y: view.y, w: view.w, h: view.h },
              scale: view.scale,
              show,
              pickedId: picked ? String(picked.id) : '',
              onPick,
              svgRef,
              onWheel,
              onPointerDown,
              onPointerMove,
              onPointerUp,
              onPointerLeave: onPointerUp,
              className: 'nd-map-svg',
            }),
            h('div', { className: 'nd-mapfull-tip nd-hint' }, '滚轮对准地名放大，拖动平移；点一个点看地点卡。'),
            picked ? h('div', { className: 'nd-map-detail nd-mapfull-detail' },
              h('strong', null, picked.name),
              h('div', { className: 'nd-hint' }, `${picked.type || '地点'}${picked.region ? ` · ${picked.region}` : ''}`),
              h('div', { className: 'ndm-coord' }, `坐标 ${Math.round(picked.coords ? Number(picked.coords.x) || 0 : 0)} , ${Math.round(picked.coords ? Number(picked.coords.y) || 0 : 0)}`),
              picked.note ? h('p', { className: 'nd-map-note' }, String(picked.note)) : null,
            ) : null,
            h(MapCartouche, { scene }),
            h(MapLegend, { scene, palette }),
          ),
        ),
      )
    }

    function MapView({ projectId, data, openChapter, go, pageArg, onRefresh }) {
      const locations = Array.isArray(data && data.locations) ? data.locations : []
      const events = Array.isArray(data && data.events) ? data.events : []
      const world = (data && data.world) || {}
      const [pickedId, setPickedId] = useState('')
      const [open, setOpen] = useState(() => (pageArg && String(pageArg.open) === '1') || lsGet('nd.mapOpen', '') === '1')
      const [showTerrain, setShowTerrain] = useState(() => lsGet('nd.mapTerrain', '1') !== '0')
      const [showRegions, setShowRegions] = useState(() => lsGet('nd.mapRegions', '1') !== '0')
      const [showRoutes, setShowRoutes] = useState(() => lsGet('nd.mapRoutes', '1') !== '0')
      const [showLabels, setShowLabels] = useState(() => lsGet('nd.mapLabels', '1') !== '0')
      const [mapBusy, setMapBusy] = useState('')
      const [mapError, setMapError] = useState('')
      const [mapNotice, setMapNotice] = useState('')
      const genBackground = async () => {
        if (mapBusy) return
        setMapBusy('bg'); setMapError(''); setMapNotice('')
        try {
          await api('map.background', scope(projectId, { seed: Math.floor(Math.random() * 9000) + 1 }))
          if (onRefresh) onRefresh()
        } catch (error) { setMapError(friendlyError(error)) }
        finally { setMapBusy('') }
      }
      const generateMapPlan = async () => {
        if (mapBusy) return
        setMapBusy('plan'); setMapError(''); setMapNotice('')
        try {
          const value = await api('chat.send', { projectId, workorder: 'mapBackgroundWorkorder', world, locations, path: scene.routes, dryRun: true })
          const prompt = String(value.prompt || '')
          if (!prompt) throw new Error('没生成出工作单')
          await sendToChat(projectId, { prompt })
          setMapNotice('已直接发到对话：AI 会生成区域 / 路线 / 坐标 / 绘制提示词，并调用 novel_desk_map(op=save) 把坐标直接写进地点；完成后回来刷新地图即可。')
        } catch (error) { setMapError(friendlyError(error)) }
        finally { setMapBusy('') }
      }
      const withCoords = locations.filter(hasCoords)
      const scene = useMemo(() => buildWorldMapScene({ world, locations, events }), [world, locations, events])
      const show = useMemo(
        () => ({ regions: showRegions, terrain: showTerrain, routes: showRoutes, labels: showLabels }),
        [showRegions, showTerrain, showRoutes, showLabels],
      )
      const picked = locations.find((loc) => String(loc.id) === pickedId) || null
      const pickedInfo = useMemo(() => {
        if (!picked) return null
        const name = String(picked.name || '')
        const hits = events.filter((event) => {
          const text = String((event && event.location) || '').trim()
          return text && (text === name || text.indexOf(name) >= 0 || name.indexOf(text) >= 0)
        })
        const chapters = hits.map((event) => toNumber(event.chapter, 0)).filter((value) => value > 0)
        return {
          count: hits.length,
          first: chapters.length > 0 ? Math.min.apply(null, chapters) : 0,
          last: chapters.length > 0 ? Math.max.apply(null, chapters) : 0,
          routes: scene.routes.filter((route) => route.stops.some((stop) => stop.id === String(picked.id))).map((route) => route.name),
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [picked, events, scene.routes])
      const toggle = (key, value, setter) => {
        lsSet(key, value ? '0' : '1')
        setter(!value)
      }
      const sourceHint = [
        scene.regionSource === 'aiPlan' ? '分区按已存方案' : '分区按地点归属推导',
        scene.routeSource === 'aiPlan' ? '路线按已存方案' : scene.routeSource === 'events' ? '路线按事件顺序推导' : '还没有路线',
      ].join(' · ')
      return h('div', { className: 'nd-mapview' },
        h('div', { className: 'nd-map-toolbar' },
          h('span', { className: 'nd-hint' },
            `${locations.length} 个地点 · ${withCoords.length} 个有坐标 · 区域 ${scene.regions.length} · 路线 ${scene.routes.length}`),
          h(Btn, { small: true, kind: 'brand', onClick: () => setOpen(true) }, '🗺 打开全屏地图'),
          h(Btn, { small: true, onClick: genBackground, disabled: mapBusy === 'bg' }, mapBusy === 'bg' ? '生成中…' : '🎨 生成底图'),
          h(Btn, { small: true, kind: 'primary', onClick: generateMapPlan, disabled: mapBusy === 'plan' }, mapBusy === 'plan' ? '发送中…' : '🧭 生成地图方案（直接入库）'),
          h(Btn, { small: true, onClick: () => go('ledger', { tab: 'locations' }) }, '编辑坐标'),
        ),
        mapError ? h('p', { className: 'nd-hint', style: { color: '#b45309' } }, `地图操作失败：${mapError}`) : null,
        mapNotice ? h('p', { className: 'nd-hint' }, mapNotice) : null,
        h('div', { className: 'ndm-toggles' },
          h(Btn, { small: true, onClick: () => toggle('nd.mapRegions', showRegions, setShowRegions) }, `区域：${showRegions ? '开' : '关'}`),
          h(Btn, { small: true, onClick: () => toggle('nd.mapTerrain', showTerrain, setShowTerrain) }, `山水：${showTerrain ? '开' : '关'}`),
          h(Btn, { small: true, onClick: () => toggle('nd.mapRoutes', showRoutes, setShowRoutes) }, `路线：${showRoutes ? '开' : '关'}`),
          h(Btn, { small: true, onClick: () => toggle('nd.mapLabels', showLabels, setShowLabels) }, `地名：${showLabels ? '开' : '关'}`),
          h('span', { className: 'nd-hint ndm-source' }, sourceHint),
        ),
        withCoords.length === 0
          ? h('div', { className: 'nd-map-empty' }, '地点都还没有坐标。到「地点」页签编辑 X/Y（0–1000）后，这里会出现地图。')
          : h('div', { className: `nd-map-layout${picked ? ' nd-map-with-detail' : ''}` },
            h('button', { type: 'button', className: 'nd-map-preview', onClick: () => setOpen(true), title: '点一下全屏看' },
              h(MapCanvas, { scene, scale: 1, show, pickedId, onPick: setPickedId }),
              h('span', { className: 'nd-map-preview-hint' }, '点卡片全屏打开 · 滚轮对准地名缩放'),
              h(MapCartouche, { scene }),
            ),
            picked ? h('div', { className: 'nd-map-detail' },
              h('strong', null, picked.name),
              h('div', { className: 'nd-hint' }, `${picked.type || '地点'}${picked.region ? ` · ${picked.region}` : ''}`),
              h('div', { className: 'ndm-coord' }, `坐标 ${Math.round(toNumber(picked.coords && picked.coords.x, 0))} , ${Math.round(toNumber(picked.coords && picked.coords.y, 0))}`),
              pickedInfo && pickedInfo.count > 0
                ? h('div', { className: 'nd-hint' }, `事件 ${pickedInfo.count} 条 · 第 ${pickedInfo.first}–${pickedInfo.last} 章`)
                : h('div', { className: 'nd-hint' }, '事件里还没点名这里'),
              pickedInfo && pickedInfo.routes.length > 0
                ? h('div', { className: 'nd-hint' }, `经过路线：${pickedInfo.routes.slice(0, 3).join(' / ')}`)
                : null,
              picked.note ? h('p', { className: 'nd-map-note' }, String(picked.note)) : null,
              h('div', { className: 'nd-actions' },
                h(Btn, { small: true, onClick: () => go('ledger', { tab: 'locations', focus: String(picked.id) }) }, '改坐标'),
                h(Btn, { small: true, onClick: () => setPickedId('') }, '收起'),
              ),
            ) : null,
          ),
        open
          ? h(MapFull, {
              scene,
              picked,
              palette: scene.palette,
              show,
              onPick: setPickedId,
              onClose: () => setOpen(false),
            })
          : null,
      )
    }


    // ── 人物卡 ────────────────────────────────────────────────
    const ROLE_LABEL = { protagonist: '主角', antagonist: '反派', supporting: '配角', minor: '龙套' }
    const ROLE_ORDER = ['protagonist', 'antagonist', 'supporting', 'minor']
    function CharacterCards({ rows, onEdit, onNew }) {
      const [openId, setOpenId] = useState('')
      const openRow = rows.find((row) => (ledgerRowKey(row) || String(row.name || '')) === openId) || null
      if (rows.length === 0) {
        return h(Empty, { action: h(Btn, { small: true, onClick: onNew }, '新增第一张人物卡') }, '人物卡还是空的。人物卡是写作前最常被读取的资料，建议先补主要人物。')
      }
      const groups = ROLE_ORDER.map((role) => ({ role, list: rows.filter((row) => (row.role || 'minor') === role) })).filter((group) => group.list.length > 0)
      const others = rows.filter((row) => !ROLE_ORDER.includes(row.role || 'minor'))
      if (others.length > 0) groups.push({ role: 'minor', list: others })
      const card = (row) => {
        const name = String(row.name || '未命名')
        const role = row.role || 'minor'
        const key = ledgerRowKey(row) || name
        return h('button', { key, type: 'button', className: `nd-char-card nd-char-${role}${openId === key ? ' nd-char-open' : ''}`, onClick: () => setOpenId(key) },
          h('span', { className: 'nd-char-face' },
            h('span', { className: 'nd-char-avatar' }, name.slice(0, 1)),
            h('span', { className: 'nd-char-face-main' },
              h('strong', { className: 'nd-char-name' }, name),
              h('span', { className: 'nd-char-role' }, ROLE_LABEL[role] || role),
            ),
          ),
          h('span', { className: 'nd-char-line-clamp' }, String(row.identity || row.goal || row.flaw || row.note || '点开看详情')),
        )
      }
      return h('div', { className: 'nd-char-groups' },
        groups.map((group) =>
          h('section', { key: group.role, className: `nd-char-group nd-char-group-${group.role}` },
            h('div', { className: 'nd-char-group-head' }, h('span', { className: `nd-tag nd-tag-${group.role === 'antagonist' ? 'error' : group.role === 'protagonist' ? 'brand' : 'muted'}` }, ROLE_LABEL[group.role] || group.role), h('span', { className: 'nd-hint' }, `${group.list.length} 人`)),
            h('div', { className: 'nd-char-grid' }, group.list.map(card)),
          ),
        ),
        openRow
          ? h(Modal, {
              title: String(openRow.name || '人物'), wide: true, onClose: () => setOpenId(''),
              footer: h('div', { className: 'nd-actions' }, h(Btn, { small: true, onClick: () => { setOpenId(''); onEdit(openRow) } }, '编辑')),
            },
              h('div', { className: 'nd-char-detail' },
                h('div', { className: 'nd-char-detail-head' },
                  h('span', { className: `nd-char-avatar nd-char-avatar-big nd-char-avatar-${openRow.role || 'minor'}` }, String(openRow.name || '人').slice(0, 1)),
                  h('div', null,
                    h('strong', { className: 'nd-char-name-lg' }, String(openRow.name || '未命名')),
                    h('div', { className: 'nd-hint' }, [ROLE_LABEL[openRow.role] || openRow.role, openRow.age, openRow.gender, openRow.identity].filter(Boolean).join(' · ') || '—'),
                  ),
                ),
                h('div', { className: 'nd-kv nd-kv-block' },
                  h('span', null, '目标'), h('span', null, String(openRow.goal || '—')),
                  h('span', null, '缺陷'), h('span', null, String(openRow.flaw || '—')),
                  h('span', null, '弧光'), h('span', null, String(openRow.arc || '—')),
                  h('span', null, '关系'), h('span', null, tagsText(openRow.relationships) || '—'),
                  h('span', null, '首次出现'), h('span', null, toNumber(openRow.firstChapter, 0) > 0 ? `第 ${openRow.firstChapter} 章` : '—'),
                  openRow.note ? h('span', null, '备注') : null, openRow.note ? h('span', null, String(openRow.note)) : null,
                ),
              ),
            )
          : null,
      )
    }

    // ── 时间线 ────────────────────────────────────────────────
    const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
    const MONTH_LABEL = { 正: 1, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 冬: 11, 腊: 12 }
    function cnInt(text) {
      if (!text) return 0
      if (/^\d+$/.test(text)) return Number(text)
      let total = 0
      let current = 0
      for (const ch of String(text)) {
        if (ch === '十') { current = (current || 1) * 10; total += current; current = 0 }
        else if (ch === '百') { current = (current || 1) * 100; total += current; current = 0 }
        else if (CN_DIGIT[ch] !== undefined) current = CN_DIGIT[ch]
      }
      return total + current
    }
    function timeParts(ev) {
      const raw = String((ev && ev.storyTime) || '')
      const era = (raw.match(/([\u4e00-\u9fa5]{2})(?:元|[一二三四五六七八九十\d]+)载/) || [])[1] || ''
      const numericYear = Number((raw.match(/(\d{3,4})\s*年/) || [])[1] || 0)
      const eraYear = cnInt((raw.match(/(?:^|[^\d])(元|[一二三四五六七八九十]+)载/) || [])[1] || '')
      const monthMatch = raw.match(/(正|十二|十一|十|九|八|七|六|五|四|三|二|一|冬|腊)月/)
      const month = monthMatch ? MONTH_LABEL[monthMatch[1]] : 0
      const day = cnInt((raw.match(/([一二三四五六七八九十\d]+)[日号]/) || [])[1] || '')
      return { era, year: numericYear || eraYear, month, day, hasTime: Boolean(era || numericYear || eraYear || month || raw), raw }
    }
    function TimelineView({ rows, openChapter, onEdit }) {
      const ordered = useMemo(() => {
        const list = rows.map((ev, index) => ({ ev, index, parts: timeParts(ev) }))
        list.sort((a, b) => toNumber(a.ev.chapter, 99999) - toNumber(b.ev.chapter, 99999) || a.index - b.index)
        // 以章节顺序为叙事骨架，缺年份的条目沿用上一条的年份；月份回跳则视为跨年
        let year = 0
        let month = 0
        for (const item of list) {
          const p = item.parts
          if (p.year > 0) year = p.year
          if (p.month > 0) {
            if (month > 0 && p.month < month) year += 1
            month = p.month
          }
          p.sortYear = p.year > 0 ? p.year : year
          p.sortMonth = p.month > 0 ? p.month : month
        }
        list.sort((a, b) => {
          const pa = a.parts
          const pb = b.parts
          if (pa.sortYear !== pb.sortYear) return pa.sortYear - pb.sortYear
          if (pa.sortMonth !== pb.sortMonth) return pa.sortMonth - pb.sortMonth
          if (pa.day !== pb.day) return pa.day - pb.day
          return toNumber(a.ev.chapter, 99999) - toNumber(b.ev.chapter, 99999) || a.index - b.index
        })
        return list
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [rows])
      if (ordered.length === 0) return h(Empty, null, '时间线还是空的。事件账本里新增条目后，这里会按故事时间排出时间轴。')
      const labelOf = (p) => {
        if (p.sortYear <= 0 && p.sortMonth <= 0) return '时间未标'
        const year = p.sortYear > 0 ? `${p.sortYear}年` : ''
        const month = p.sortMonth > 0 ? `${p.sortMonth}月` : ''
        return `${year}${month}` || '时间未标'
      }
      const STATUS_LABEL = { open: '待处理', accepted: '已采纳', rejected: '已驳回', merged: '已合并', stale: '失效', resolved: '已处理' }
      const groups = []
      for (const item of ordered) {
        const p = item.parts
        const key = `${p.sortYear}-${p.sortMonth}`
        if (groups.length === 0 || groups[groups.length - 1].key !== key) groups.push({ key, items: [] })
        groups[groups.length - 1].items.push(item)
      }
      const groupLabel = (items) => {
        for (const item of items) {
          const raw = String(item.parts.raw || '')
          const hit = raw.match(/^(.{1,20}?月)/)
          if (hit) return hit[1]
        }
        const p = items[0].parts
        if (p.sortYear > 0) return `${p.sortYear}年${p.sortMonth > 0 ? `${p.sortMonth}月` : ''}`
        return '时间未标'
      }
      const nodes = []
      for (const group of groups) {
        nodes.push(h('div', { key: `g-${group.key}-${nodes.length}`, className: 'nd-tl-group' }, h('span', { className: 'nd-tl-group-label' }, groupLabel(group.items))))
        for (const item of group.items) {
          const ev = item.ev
          nodes.push(h('div', { key: ledgerRowKey(ev) || String(item.index), className: `nd-tl-item${ev.importance === 'climax' ? ' nd-tl-climax' : ev.importance === 'major' ? ' nd-tl-major' : ''}` },
            h('span', { className: 'nd-tl-dot' }),
            h('div', { className: 'nd-tl-body' },
              h('div', { className: 'nd-tl-meta' },
                item.parts.raw ? h('span', { className: 'nd-tag nd-tag-brand' }, item.parts.raw) : h('span', { className: 'nd-tag nd-tag-muted' }, '时间未标'),
                chapterNo(ev) > 0 ? h('button', { type: 'button', className: 'nd-linkbtn', onClick: () => openChapter(chapterNo(ev)) }, `第 ${chapterNo(ev)} 章`) : null,
                ev.location ? h('span', { className: 'nd-tag' }, `📍 ${ev.location}`) : null,
                ev.importance === 'climax' ? h('span', { className: 'nd-tag nd-tag-error' }, '高潮') : ev.importance === 'major' ? h('span', { className: 'nd-tag nd-tag-warn' }, '关键') : null,
                h('span', { className: 'nd-tl-title' }, String(ev.title || '未命名事件')),
                h('span', { className: 'nd-tl-edit' }, h(Btn, { small: true, onClick: () => onEdit(ev) }, '编辑')),
              ),
              tagsText(ev.participants) ? h('div', { className: 'nd-hint' }, `参与：${tagsText(ev.participants)}`) : null,
              ev.summary ? h('p', { className: 'nd-tl-summary' }, String(ev.summary)) : null,
              ev.consequences ? h('p', { className: 'nd-hint' }, `后果：${String(ev.consequences)}`) : null,
            ),
          ))
        }
      }
      return h('div', { className: 'nd-timeline' }, nodes)
    }

    // ── 页 7：账本（资料库） ─────────────────────────────────
    const LEDGER_TABS = [
      { id: 'facts', label: '⚖️ 事实库' },
      { id: 'characters', label: '👤 人物卡' },
      { id: 'events', label: '🕰️ 时间线' },
      { id: 'locations', label: '🏙️ 地点' },
      { id: 'map', label: '🗺️ 世界地图' },
      { id: 'highlights', label: '✨ 高光' },
      { id: 'conflicts', label: '⚔️ 冲突' },
      { id: 'foreshadow', label: '🧩 伏笔' },
    ]
    function LedgerTab({ projectId, go, openChapter, pageArg, onChanged }) {
      const ledgerRes = useAsync(() => api('ledger.get', scope(projectId)), [projectId])
      const data = ledgerRes.data && typeof ledgerRes.data === 'object' ? ledgerRes.data : null
      const [kind, setKind] = useState(() => {
        const wanted = (pageArg && pageArg.tab) || lsGet('nd.ledgerTab', '')
        return LEDGER_TABS.some((row) => row.id === wanted) ? wanted : 'facts'
      })
      const [form, setForm] = useState(null)
      const [confirmKey, setConfirmKey] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [syncDialog, setSyncDialog] = useState(null)
      const syncRes = useAsync(() => (projectId ? api('ledger.sync', scope(projectId)) : Promise.resolve({ pending: [] })), [projectId])
      const dbRes = useAsync(() => (projectId ? api('ledger.entities', scope(projectId)) : Promise.resolve(null)), [projectId])
      const pending = syncRes.data && Array.isArray(syncRes.data.pending) ? syncRes.data.pending : []
      const full = syncRes.data && syncRes.data.full ? syncRes.data.full : null
      const chapters = (syncRes.data && syncRes.data.chapters) || 0
      const [fullDialog, setFullDialog] = useState(false)
      const [fullPrompt, setFullPrompt] = useState(null)
      const [fullBatchSize, setFullBatchSize] = useState(6)
      const [fullReplan, setFullReplan] = useState(false)
      const [fullSent, setFullSent] = useState(null)
      const meta = LEDGER_META[kind]
      const isTable = kind !== 'map' && kind !== 'characters' && kind !== 'events'
      const rows = useMemo(() => {
        const value = data && data[kind]
        return Array.isArray(value) ? value : []
      }, [data, kind])

      const refresh = () => {
        ledgerRes.reload()
        syncRes.reload()
        if (onChanged) onChanged()
      }
      const remove = async (row) => {
        setBusy('del')
        try {
          await api('ledger.delete', scope(projectId, { kind, id: row.id, item: row }))
          setConfirmKey('')
          setNotice({ tone: 'ok', text: `已删除：${ledgerRowLabel(kind, row)}` })
          refresh()
        } catch (err) {
          setNotice({ tone: 'error', text: `删除失败：${friendlyError(err)}` })
        } finally {
          setBusy('')
        }
      }
      const submit = async (draft) => {
        setBusy('save')
        try {
          await api('ledger.upsert', scope(projectId, { kind, item: draft, patch: draft, row: draft }))
          setForm(null)
          setNotice({ tone: 'ok', text: '已保存到账本' })
          refresh()
        } catch (err) {
          setNotice({ tone: 'error', text: `保存失败：${friendlyError(err)}` })
        } finally {
          setBusy('')
        }
      }
      const rebuildMentions = async () => {
        setBusy('mentions')
        setNotice(null)
        try {
          const value = await api('ledger.rebuildMentions', scope(projectId))
          setNotice({ tone: 'ok', text: `已重建提及：${value.chapters || 0} 章 / ${value.mentions || 0} 条` })
          dbRes.reload()
        } catch (err) {
          setNotice({ tone: 'error', text: `重建提及失败：${friendlyError(err)}` })
        } finally {
          setBusy('')
        }
      }
      const openSync = async () => {
        setBusy('sync')
        setNotice(null)
        try {
          const value = await api('ledger.sync', scope(projectId, { action: 'workorder' }))
          setSyncDialog({ text: String((value && value.prompt) || ''), sending: false, confirming: false, target: '' })
        } catch (err) {
          setNotice({ tone: 'error', text: `生成同步工作单失败：${friendlyError(err)}` })
        } finally {
          setBusy('')
        }
      }
      const sendSync = async () => {
        if (!syncDialog) return
        setSyncDialog((prev) => (prev ? { ...prev, sending: true } : prev))
        try {
          await sendToChat(projectId, { prompt: syncDialog.text }, syncDialog.target)
          setSyncDialog(null)
          setNotice({ tone: 'ok', text: '已发到宿主对话（在 DSH 侧栏最近的会话里找它）：AI 会核对改动并提 ledger-fix 提案。' })
        } catch (err) {
          setSyncDialog((prev) => (prev ? { ...prev, sending: false } : prev))
          setNotice({ tone: 'error', text: `发不出去：${friendlyError(err)}。可以复制工作单自己粘过去。` })
        }
      }
      const ackSync = async () => {
        setBusy('ack')
        try {
          await api('ledger.sync', scope(projectId, { action: 'ack' }))
          setNotice({ tone: 'ok', text: '已标记为核对过；下次正文再动到这些名字/数字会重新提醒。' })
          refresh()
        } catch (err) {
          setNotice({ tone: 'error', text: `标记失败：${friendlyError(err)}` })
        } finally {
          setBusy('')
        }
      }
      const openFullSync = () => {
        setNotice(null)
        setFullReplan(false)
        setFullDialog(true)
      }
      const closeFull = () => setFullDialog(false)
      const planFull = async () => {
        setBusy('fullPlan')
        try {
          await api('ledger.sync', scope(projectId, { action: 'plan', batchSize: fullBatchSize }))
          setFullReplan(false)
          refresh()
        } catch (err) {
          setNotice({ tone: 'error', text: `制定计划失败：${friendlyError(err)}` })
        } finally {
          setBusy('')
        }
      }
      const buildAllOnce = async () => {
        if (busy) return
        setBusy('fullOnce')
        setNotice(null)
        try {
          const size = Math.max(1, Number(chapters) || 1)
          await api('ledger.sync', scope(projectId, { action: 'plan', from: 1, to: size, batchSize: size }))
          const value = await api('ledger.sync', scope(projectId, { action: 'workorder', mode: 'full' }))
          if (!value || !value.prompt) throw new Error('没有可建账的章节')
          setFullPrompt({ text: String(value.prompt), batchIndex: 1, total: 1, sending: false, confirming: false, target: '' })
          setFullDialog(false)
          syncRes.reload()
        } catch (err) {
          setNotice({ tone: 'error', text: `一次性建账失败：${friendlyError(err)}` })
        } finally {
          setBusy('')
        }
      }
      const openFullOrder = async () => {
        setBusy('fullWork')
        try {
          const value = await api('ledger.sync', scope(projectId, { action: 'workorder', mode: 'full' }))
          if (value && value.done) {
            setFullDialog(false)
            setNotice({ tone: 'ok', text: '全部批次已同步完成 🎉' })
            refresh()
            return
          }
          const batch = (value && value.batch) || {}
          setFullPrompt({ text: String((value && value.prompt) || ''), batchIndex: batch.index || 1, batchLabel: `第 ${batch.from}–${batch.to} 章`, total: (full && full.total) || 0, confirming: false, sending: false, target: '' })
        } catch (err) {
          setNotice({ tone: 'error', text: `生成工作单失败：${friendlyError(err)}` })
        } finally {
          setBusy('')
        }
      }
      const sendFullOrder = async () => {
        if (!fullPrompt) return
        setFullPrompt((prev) => (prev ? { ...prev, sending: true } : prev))
        try {
          await sendToChat(projectId, { prompt: fullPrompt.text }, fullPrompt.target)
          setFullPrompt(null)
          setFullSent(fullPrompt.batchIndex)
          setNotice({ tone: 'ok', text: `已发给 AI：它会读完${fullPrompt.batchLabel}再提账本提案。批准提案后回来点「本批已同步」。` })
          refresh()
        } catch (err) {
          setFullPrompt((prev) => (prev ? { ...prev, sending: false } : prev))
          setNotice({ tone: 'error', text: `发不出去：${friendlyError(err)}。可以复制工作单自己粘过去。` })
        }
      }
      const doneFullBatch = async () => {
        setBusy('fullDone')
        try {
          await api('ledger.sync', scope(projectId, { action: 'batch-done', batch: fullSent || undefined }))
          setFullSent(null)
          setNotice({ tone: 'ok', text: '已标记本批已同步' })
          refresh()
        } catch (err) {
          setNotice({ tone: 'error', text: `标记失败：${friendlyError(err)}` })
        } finally {
          setBusy('')
        }
      }
      const resetFull = async () => {
        setBusy('fullReset')
        try {
          await api('ledger.sync', scope(projectId, { action: 'reset' }))
          closeFull()
          setNotice({ tone: 'ok', text: '已清除全书同步计划；正文改动提醒不受影响。' })
          refresh()
        } catch (err) {
          setNotice({ tone: 'error', text: `清除失败：${friendlyError(err)}` })
        } finally {
          setBusy('')
        }
      }
      const tabItems = LEDGER_TABS.map((row) => {
        const value = row.id === 'map' ? (data && Array.isArray(data.locations) ? data.locations.length : 0) : data && Array.isArray(data[row.id]) ? data[row.id].length : 0
        return { value: row.id, label: row.label, badge: String(value) }
      })
      const addLabel = kind === 'characters' ? '+ 新增人物卡' : kind === 'outlines' ? '+ 新增大纲条目' : `+ 新增${meta ? meta.title : '条目'}`

      let body
      if (ledgerRes.loading && !ledgerRes.data) body = h(Loading, null, '正在读取账本…')
      else if (ledgerRes.error) body = h(ErrorBox, { error: ledgerRes.error, onRetry: () => ledgerRes.reload() })
      else if (kind === 'map') body = h(MapView, { projectId, data, go, openChapter, onRefresh: refresh, pageArg: pageArg && pageArg.tabMap ? pageArg : pageArg })
      else if (kind === 'characters') body = h(CharacterCards, { rows, onEdit: (row) => setForm({ kind, item: row, editing: true }), onNew: () => setForm({ kind, item: {}, editing: false }) })
      else if (kind === 'events') body = h(TimelineView, { rows, openChapter, onEdit: (row) => setForm({ kind, item: row, editing: true }) })
      else if (rows.length === 0) body = h(Empty, null, `${meta.title}账本还是空的`)
      else body = h('div', { className: 'nd-table-wrap' },
        h('table', { className: 'nd-table' },
          h('thead', null, h('tr', null, meta.cols.map((col) => h('th', { key: col.k, style: col.w ? { width: col.w } : undefined }, col.t)), h('th', { style: { width: '160px' } }, '操作'))),
          h('tbody', null, rows.map((row, index) => {
            const key = ledgerRowKey(row) || String(index)
            return h('tr', { key },
              meta.cols.map((col) => h('td', { key: col.k, className: col.k === 'note' ? 'nd-cell-clip' : undefined }, ledgerCellText(row, col))),
              h('td', null, h('div', { className: 'nd-row-actions' },
                h(Btn, { small: true, onClick: () => setForm({ kind, item: row, editing: true }) }, '编辑'),
                confirmKey === key
                  ? h(Fragment, null, h(Btn, { small: true, kind: 'danger', onClick: () => remove(row), disabled: busy === 'del' }, '确认删除'), h(Btn, { small: true, onClick: () => setConfirmKey('') }, '取消'))
                  : h(Btn, { small: true, onClick: () => setConfirmKey(key) }, '删除'),
              )),
            )
          })),
        ),
      )

      return h('div', { className: 'nd-page nd-ledger' },
        h('div', { className: 'nd-page-head' },
          h('div', null,
            h('h2', null, '账本 · 资料库'),
            h('p', { className: 'nd-hint' }, '事实库 / 人物卡 / 时间线 / 地点 / 世界地图 / 高光 / 冲突 / 伏笔 / 大纲。写作前 AI 会读这里；正文改到人名、地点、数字时，顶部会提醒同步。'),
          ),
          h('div', { className: 'nd-page-actions' },
            h(Btn, { small: true, onClick: () => { ledgerRes.reload(); syncRes.reload() }, disabled: ledgerRes.loading }, '刷新'),
            h(Btn, { small: true, onClick: openFullSync }, '📚 全书同步'),
            isTable ? h(Btn, { small: true, kind: 'primary', onClick: () => setForm({ kind, item: {}, editing: false }) }, addLabel) : null,
            kind === 'characters' ? h(Btn, { small: true, kind: 'primary', onClick: () => setForm({ kind, item: {}, editing: false }) }, addLabel) : null,
          ),
        ),
        notice ? h(Msg, { tone: notice.tone, onClose: () => setNotice(null) }, notice.text) : null,
        dbRes.data && dbRes.data.stats
          ? h('div', { className: 'nd-card nd-ledger-db' },
              h('div', { className: 'nd-card-head' },
                h('h3', null, '🗄️ 账本数据库'),
                h(Btn, { small: true, onClick: () => dbRes.reload() }, '刷新'),
                h(Btn, { small: true, onClick: rebuildMentions, disabled: busy === 'mentions' }, busy === 'mentions' ? '重建中…' : '重建提及'),
                h(Btn, { small: true, kind: 'primary', onClick: openFullSync }, '首次建账 / 全书同步'),
              ),
              h('p', { className: 'nd-hint' }, `实体 ${dbRes.data.stats.entities} ｜ 提及 ${dbRes.data.stats.mentions} ｜ 事实 ${dbRes.data.stats.facts} ｜ 事件 ${dbRes.data.stats.events} ｜ 高光 ${dbRes.data.stats.highlights} ｜ 待确认专名 ${dbRes.data.stats.unknown}`),
              (() => {
                const located = (Array.isArray(dbRes.data.items) ? dbRes.data.items : []).filter((item) => Number(item.mentions) > 0)
                if (located.length) {
                  return h('div', { className: 'nd-db-entities' },
                    located.slice(0, 18).map((item) => h('span', { className: 'nd-db-entity', key: `${item.kind}:${item.entityId}` }, `${item.name}×${item.mentions}`)),
                  )
                }
                if (Number(dbRes.data.stats.entities) > 0) {
                  return h('p', { className: 'nd-hint' }, `实体已入账，但正文提及还没建立（${dbRes.data.stats.entities} 个实体当前都是 0 次）。点「重建提及」本地扫一遍正文即可；不扫也不会影响正文。`)
                }
                return h('p', { className: 'nd-hint' }, '数据库还没有实体：先跑一次「一次性全书建账」，之后改正文只做本地增量同步。')
              })(),
            )
          : null,
        pending.length > 0
          ? h('div', { className: 'nd-banner nd-banner-warn' },
              h('span', null, `⚠ 第 ${pending.map((row) => row.chapter).join('、')} 章正文改到了账本里的名字/数字，可能需要同步`),
              h('span', { className: 'nd-hint' }, pending.map((row) => (row.reasons || []).slice(0, 3).join('、')).filter(Boolean).join(' ｜ ')),
              h(Btn, { small: true, onClick: openSync, disabled: busy === 'sync' }, busy === 'sync' ? '生成中…' : '让 AI 核对'),
              h(Btn, { small: true, onClick: ackSync, disabled: busy === 'ack' }, '已核对，忽略'),
            )
          : null,
        full && full.done < full.total
          ? h('div', { className: 'nd-banner' },
              h('span', null, `📚 全书账本同步进行中：已完成 ${full.done}/${full.total} 批（共 ${full.from}–${full.to} 章）`),
              h(Btn, { small: true, onClick: openFullSync }, '继续'),
            )
          : !full && chapters >= 5
            ? h('div', { className: 'nd-banner' },
                h('span', null, '📄 正文已经写完？全书账本还是旧的，可以让 AI 分批核对一遍'),
                h(Btn, { small: true, onClick: openFullSync }, '全书同步'),
              )
            : null,
        h(Tabs, { value: kind, onChange: (next) => { setKind(next); setConfirmKey(''); setNotice(null); lsSet('nd.ledgerTab', next) }, items: tabItems }),
        h('div', { className: 'nd-panel-box' },
          body,
        ),
        form
          ? h(LedgerForm, {
              key: `${form.kind}:${(form.item && form.item.id) || 'new'}`,
              meta: LEDGER_META[form.kind],
              initial: form.item || {},
              editing: !!form.editing,
              busy: busy === 'save',
              onCancel: () => setForm(null),
              onSubmit: submit,
            })
          : null,
        syncDialog
          ? h(Modal, {
              title: '账本同步工作单',
              wide: true,
              onClose: () => setSyncDialog(null),
              footer: h(Fragment, null,
                h(Btn, { onClick: async () => {
                  const ok = await copyText(syncDialog.text)
                  setNotice({ tone: ok ? 'ok' : 'warn', text: ok ? '工作单已复制' : '复制失败：请手动全选复制' })
                } }, '复制'),
                syncDialog.confirming ? h(Btn, { onClick: () => setSyncDialog((prev) => (prev ? { ...prev, confirming: false } : prev)) }, '返回改内容') : null,
                h(Btn, {
                  kind: 'primary',
                  disabled: syncDialog.sending,
                  onClick: () => (syncDialog.confirming ? sendSync() : setSyncDialog((prev) => (prev ? { ...prev, confirming: true } : prev))),
                }, syncDialog.sending ? '发送中…' : syncDialog.confirming ? '确定发送' : '下一步：确认发送'),
              ),
            },
              h('p', { className: 'nd-hint' }, 'AI 会读改动后的正文和账本，只提有依据的 ledger-fix 提案；核对完不打算改就点「已核对，忽略」。'),
              h('div', { className: syncDialog.confirming ? 'nd-send-confirm' : '' },
                syncDialog.confirming ? h('p', { className: 'nd-hint' }, '最后一步：确认发给谁。点「确定发送」才会真的发出去。') : null,
                h(TargetPicker, { projectId, value: syncDialog.target, onChange: (next) => setSyncDialog((prev) => (prev ? { ...prev, target: next } : prev)) }),
              ),
              h('pre', { className: 'nd-pre nd-pre-tall' }, syncDialog.text),
            )
          : null,
        fullDialog
          ? h(Modal, {
              title: '全书账本同步',
              wide: true,
              onClose: closeFull,
              footer: !full || fullReplan
                ? h(Fragment, null,
                    h(Btn, { onClick: full && fullReplan ? () => setFullReplan(false) : closeFull }, '取消'),
                    h(Btn, { kind: 'primary', onClick: buildAllOnce, disabled: busy === 'fullOnce' }, busy === 'fullOnce' ? '生成中…' : '一次性全书建账（不分批）'),
                    h(Btn, { onClick: planFull, disabled: busy === 'fullPlan' }, busy === 'fullPlan' ? '制定中…' : full && fullReplan ? '重建计划' : '分批同步计划'),
                  )
                : h(Fragment, null,
                    h(Btn, { small: true, onClick: resetFull, disabled: busy === 'fullReset' }, '清除计划'),
                    h(Btn, { small: true, onClick: () => setFullReplan(true), disabled: !!busy }, '重新制定计划'),
                    h(Btn, { small: true, onClick: buildAllOnce, disabled: busy === 'fullOnce' }, busy === 'fullOnce' ? '生成中…' : '一次性全书建账'),
                    h(Btn, { small: true, onClick: doneFullBatch, disabled: busy === 'fullDone' || full.done >= full.total }, fullSent ? `第 ${fullSent} 批已同步` : '本批已同步'),
                    h(Btn, { onClick: closeFull }, '关闭'),
                    full.done < full.total ? h(Btn, { kind: 'primary', onClick: openFullOrder, disabled: busy === 'fullWork' }, busy === 'fullWork' ? '生成中…' : '发送下一批工作单') : null,
                  ),
            },
              !full || fullReplan
                ? h(Fragment, null,
                    h('p', { className: 'nd-hint' }, '**首次建账必须全书统一做一次**：点「一次性全书建账」，AI 一次读完所有正文、统一建立人物/地点/事实/事件/伏笔；之后的日常同步才分批（每批让 AI 只读改动过的章节，提 ledger-fix 提案，批准后点「本批已同步」）。'),
                    h(Field, { label: '每批章数', hint: '批越大，AI 一次读的正文越多：省轮次，但也更容易看漏。' },
                      h(Select, { value: String(fullBatchSize), onChange: (value) => setFullBatchSize(Number(value) || 6), options: [4, 6, 8, 10].map((n) => ({ value: String(n), label: `每批 ${n} 章` })) }),
                    ),
                    full && fullReplan ? h('p', { className: 'nd-hint' }, `现有计划每批 ${full.batchSize} 章、已完成 ${full.done}/${full.total} 批；重建时会保留「章号范围完全相同」的已完成批，改每批章数则进度重来。`) : null,
                  )
                : h(Fragment, null,
                    h('p', { className: 'nd-hint' }, `已完成 ${full.done}/${full.total} 批 · 第 ${full.from}–${full.to} 章 · 每批 ${full.batchSize} 章`),
                    full.uncovered && full.uncovered.length > 0 ? h('p', { className: 'nd-hint' }, `计划未覆盖第 ${full.uncovered.join('、')} 章，可点「重新制定计划」`) : null,
                    h('div', { className: 'nd-hint', style: { display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '6px' } },
                      (full.batches || []).map((b) => h('span', { key: b.index }, `第 ${b.index} 批 · 第 ${b.from}–${b.to} 章 · ${b.count} 章 · 约 ${b.words} 字 · ${b.status === 'done' ? '已同步' : '待同步'}`)),
                    ),
                  ),
            )
          : null,
        fullPrompt
          ? h(Modal, {
              title: `全书账本同步 · 第 ${fullPrompt.batchIndex}/${fullPrompt.total} 批`,
              wide: true,
              onClose: () => setFullPrompt(null),
              footer: h(Fragment, null,
                h(Btn, { onClick: async () => { const ok = await copyText(fullPrompt.text); setNotice({ tone: ok ? 'ok' : 'warn', text: ok ? '工作单已复制' : '复制失败：请手动全选复制' }) } }, '复制'),
                fullPrompt.confirming ? h(Btn, { onClick: () => setFullPrompt((prev) => (prev ? { ...prev, confirming: false } : prev)) }, '返回改内容') : null,
                h(Btn, { kind: 'primary', disabled: fullPrompt.sending, onClick: () => (fullPrompt.confirming ? sendFullOrder() : setFullPrompt((prev) => (prev ? { ...prev, confirming: true } : prev))) },
                  fullPrompt.sending ? '发送中…' : fullPrompt.confirming ? '确定发送' : '下一步：确认发送'),
              ),
            },
              h('p', { className: 'nd-hint' }, 'AI 只读正文、补账本，不改正文；会提 ledger-fix 提案，你逐条批准。'),
              h('div', { className: fullPrompt.confirming ? 'nd-send-confirm' : '' },
                fullPrompt.confirming ? h('p', { className: 'nd-hint' }, '最后一步：确认发给谁。点「确定发送」才会真的发出去。') : null,
                h(TargetPicker, { projectId, value: fullPrompt.target, onChange: (next) => setFullPrompt((prev) => (prev ? { ...prev, target: next } : prev)) }),
              ),
              h('pre', { className: 'nd-pre nd-pre-tall' }, fullPrompt.text),
            )
          : null,
      )
    }

    // ── 页 7：账本 ────────────────────────────────────────────
    function ledgerRowKey(row) {
      if (!row) return ''
      return String(row.id || row.name || row.title || row.subject || '')
    }
    function ledgerRowLabel(kind, row) {
      if (!row) return '条目'
      if (kind === 'facts') return `${row.subject || ''}·${row.attribute || ''}`
      return row.name || row.title || row.id || '条目'
    }
    function ledgerCellText(row, col) {
      const value = getPath(row, col.k)
      if (typeof col.format === 'function') {
        try {
          return col.format(value)
        } catch {
          return '—'
        }
      }
      if (col.options) {
        const pair = col.options.find((opt) => opt[0] === value)
        if (pair) return pair[1]
      }
      if (Array.isArray(value)) return value.filter(Boolean).join('、') || '—'
      if (value && typeof value === 'object') return JSON.stringify(value).slice(0, 80)
      return value == null || value === '' ? '—' : String(value)
    }

    function LedgerForm({ meta, initial, editing, busy, onCancel, onSubmit }) {
      const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(initial || {})))
      const [error, setError] = useState('')
      const set = (path, value) => setDraft((cur) => setPath(cur, path, value))
      const submit = () => {
        for (const field of meta.fields) {
          if (field.required && !String(getPath(draft, field.k) == null ? '' : getPath(draft, field.k)).trim()) {
            setError(`请填写「${field.t}」`)
            return
          }
        }
        setError('')
        onSubmit(draft)
      }
      const fields = meta.fields.map((field) => {
        const value = getPath(draft, field.k)
        let control
        if (field.type === 'select') {
          const options = [{ value: '', label: '—' }].concat(
            (field.options || []).map((opt) => (Array.isArray(opt) ? { value: opt[0], label: opt[1] } : opt)),
          )
          control = h(Select, { value: value == null ? '' : value, onChange: (v) => set(field.k, v), options })
        } else if (field.type === 'textarea') {
          control = h(TextArea, { value: value == null ? '' : value, rows: field.rows || 3, onChange: (v) => set(field.k, v) })
        } else if (field.type === 'tags') {
          control = h(TextInput, { value: tagsText(value), placeholder: field.ph || '用「、」分隔', onChange: (v) => set(field.k, parseTags(v)) })
        } else if (field.type === 'number') {
          control = h(TextInput, { type: 'number', value: value == null ? '' : value, onChange: (v) => set(field.k, v === '' ? undefined : toNumber(v, 0)) })
        } else {
          control = h(TextInput, { value: value == null ? '' : value, placeholder: field.ph || '', onChange: (v) => set(field.k, v) })
        }
        return h(Field, { key: field.k, label: `${field.t}${field.required ? ' *' : ''}` }, control)
      })
      return h(
        Modal,
        {
          title: `${editing ? '编辑' : '新增'}${meta.title}`,
          wide: true,
          onClose: onCancel,
          footer: h('div', { className: 'nd-modal-actions' },
            h(Btn, { onClick: onCancel }, '取消'),
            h(Btn, { kind: 'primary', onClick: submit, disabled: busy }, busy ? '保存中…' : '保存'),
          ),
        },
        error ? h(Msg, { tone: 'error' }, error) : null,
        h('div', { className: 'nd-form-grid' }, fields),
      )
    }
    // ── 页 8：总览 ────────────────────────────────────────────
    function fmtScalar(value) {
      if (value == null || value === '') return '—'
      if (typeof value === 'number') return Number.isInteger(value) ? fmtInt(value) : String(Math.round(value * 100) / 100)
      if (typeof value === 'boolean') return value ? '是' : '否'
      if (typeof value === 'string') return value
      if (Array.isArray(value)) {
        const text = value.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v))).join('、')
        return text ? text.slice(0, 240) : '—'
      }
      return JSON.stringify(value).slice(0, 240)
    }
    function KeyValue({ rows, emptyText }) {
      if (!rows || rows.length === 0) return h('p', { className: 'nd-muted' }, emptyText || '暂无数据')
      return h('div', { className: 'nd-kv' },
        rows.map((row) => h('div', { className: 'nd-kv-row', key: row.key }, h('span', { className: 'nd-kv-k' }, row.key), h('span', { className: 'nd-kv-v' }, row.text))),
      )
    }

    function OverviewTab({ projectId, project, context, toc, go, onNewBook, onChanged }) {
      const [baseBusy, setBaseBusy] = useState(false)
      const [baseNotice, setBaseNotice] = useState(null)
      const reviewsRes = useAsync(() => api('review.list', scope(projectId)), [projectId])
      const proposalsRes = useAsync(() => api('proposal.list', scope(projectId, { status: 'pending', filter: { status: 'pending' } })), [projectId])
      const usageRes = useAsync(() => api('usage.summary', scope(projectId)), [projectId])
      const alignRes = useAsync(() => api('align.status', scope(projectId)), [projectId])

      const reviews = toList(reviewsRes.data, 'reviews')
      const proposals = toList(proposalsRes.data, 'proposals')
      const openReviews = reviews.filter((rv) => !rv.status || rv.status === 'open' || rv.status === 'proposed')
      const pendingProposals = proposals.filter((p) => PROPOSAL_KINDS.includes(p.kind) && (!p.status || p.status === 'pending'))
      const attention = context && Array.isArray(context.attention) ? context.attention : []
      const scored = attention
        .map((row) => ({ chapter: toNumber(row.chapter, 0), score: attentionScore(row) }))
        .filter((row) => row.chapter > 0 && row.score != null)
        .sort((a, b) => a.chapter - b.chapter)
      const avgScore = scored.length ? Math.round(scored.reduce((sum, row) => sum + row.score, 0) / scored.length) : null
      const unscoredCount = Math.max(0, toc.length - scored.length)
      const totalWords = toc.reduce((sum, row) => sum + (toNumber(row.words, 0) || toNumber(row.meta && row.meta.words, 0)), 0)
      const writtenCount = toc.filter((row) => ['written', 'reviewed', 'revised', 'done', 'final', '定稿'].includes(row.status)).length
      const ledgerCount = ['characters', 'facts', 'events', 'foreshadow', 'conflicts', 'locations'].reduce((sum, k) => {
        const arr = context && Array.isArray(context[k]) ? context[k] : []
        return sum + arr.length
      }, 0)
      const routeCounts = ROUTES.map((route) => ({
        ...route,
        count: openReviews.filter((rv) => normalRoute(rv) === route.id).length,
      }))
      const weakest = scored.slice().sort((a, b) => a.score - b.score).slice(0, 4)

      const curveRows = scored.slice(-40)
      let curve = null
      if (curveRows.length >= 2) {
        const w = 620
        const hgt = 180
        const padLeft = 34
        const padRight = 12
        const padTop = 12
        const padBottom = 26
        const pts = curveRows.map((row, i) => ({
          x: Math.round(padLeft + (i / (curveRows.length - 1)) * (w - padLeft - padRight)),
          y: Math.round(padTop + (1 - clamp(row.score / 100, 0, 1)) * (hgt - padTop - padBottom)),
          chapter: row.chapter,
          score: row.score,
        }))
        curve = { w, h: hgt, pts, padLeft, padRight, padTop, padBottom }
      }

      const align = alignRes.data && typeof alignRes.data === 'object' ? alignRes.data : null
      const counts = (align && align.ledgerCounts) || {}
      const alignRows = align
        ? [
            { key: '章节 / 字数', text: `${fmtInt(align.chapters)} 章 · ${fmtInt(align.words)} 字` },
            { key: '待处理意见', text: fmtInt(align.openReviews) },
            { key: '待批准提案', text: fmtInt(align.pendingProposals) },
            { key: '平均注意力', text: align.attentionAvg == null ? '暂无评分' : `${align.attentionAvg} 分` },
            { key: '注意力覆盖', text: `${fmtInt(align.attention && align.attention.scored)} / ${fmtInt(align.chapters)} 章` },
            { key: '账本条目', text: `${LEDGER_KINDS.reduce((sum, kind) => sum + toNumber(counts[kind], 0), 0)} 条` },
          ]
        : []

      const usage = usageRes.data && typeof usageRes.data === 'object' ? usageRes.data : null
      const usageRows = usage && (toNumber(usage.calls, 0) || toNumber(usage.tokens, 0))
        ? [
            { key: '调用次数', text: fmtInt(usage.calls) },
            { key: '总 tokens', text: fmtInt(usage.tokens) },
            { key: '输入 / 输出', text: `${fmtInt(usage.inputTokens)} / ${fmtInt(usage.outputTokens)}` },
            { key: '缓存读 / 写', text: `${fmtInt(usage.cacheReadTokens)} / ${fmtInt(usage.cacheWriteTokens)}` },
            { key: '花费', text: `¥${toNumber(usage.costCNY, 0).toFixed(2)}` },
            { key: '最近一次', text: usage.lastAt ? fmtAgo(usage.lastAt) : '—' },
          ]
        : []

      // 空书底座：老作品 / 旧版本建的书可能还没有工作区，也没有设定与大纲；这里一键补发工作单
      const presets = context && Array.isArray(context.presets) ? context.presets : []
      const activePreset = presets.find((row) => String(row.id) === String(project && project.activePresetId)) || null
      const customPreset = !activePreset || ['preset-custom', 'preset-ai-custom'].includes(String(project && project.activePresetId))
      const sendBase = async () => {
        if (baseBusy) return
        setBaseBusy(true)
        setBaseNotice(null)
        try {
          const sent = await api('chat.send', {
            projectId,
            workorder: 'newBookWorkorder',
            brief: String((project && (project.description || project.logline)) || ''),
            preset: customPreset ? { id: 'preset-ai-custom', name: '自定义（让 AI 定）', custom: true } : activePreset,
            newSession: true,
          })
          setBaseNotice({ tone: 'ok', text: sent && sent.workspacePath ? `工作单已发到这本书的工作区（${sent.workspacePath}）里新开的对话。` : '工作单已发到这本书工作区里的新对话。' })
          if (typeof onChanged === 'function') onChanged()
        } catch (error) {
          setBaseNotice({ tone: 'warn', text: `工作单没有发出去：${friendlyError(error)}` })
        } finally {
          setBaseBusy(false)
        }
      }

      const statCard = (label, value, hint) =>
        h('div', { className: 'nd-stat', key: label }, h('span', { className: 'nd-stat-label' }, label), h('strong', { className: 'nd-stat-value' }, value), hint ? h('span', { className: 'nd-stat-hint' }, hint) : null)

      return h('div', { className: 'nd-page nd-overview' },
        h('div', { className: 'nd-page-head' },
          h(
            'div',
            null,
            h('h2', null, (project && project.title) || '总览'),
            h('p', { className: 'nd-hint' }, `只读统计 · ${project && project.genre ? project.genre + ' · ' : ''}${toc.length} 章 · 写作请到「正文 / 意见 / 提案」页`),
          ),
          h('div', { className: 'nd-page-actions' },
            onNewBook ? h(Btn, { small: true, kind: 'primary', onClick: onNewBook, title: '选预设、写一段想法，创建新作品并让 AI 生成世界/人物/大纲' }, '＋ 开新书') : null,
            h(
              Btn,
              {
                small: true,
                onClick: () => {
                  reviewsRes.reload()
                  proposalsRes.reload()
                  usageRes.reload()
                  alignRes.reload()
                },
                disabled: reviewsRes.loading || proposalsRes.loading,
              },
              '刷新',
            ),
            h(Btn, { small: true, onClick: () => go('read') }, '去写正文'),
          ),
        ),
        h('section', { className: 'nd-hero' },
          h('div', { className: 'nd-hero-main' },
            h('div', { className: 'nd-hero-slogan' }, '⚡ ATTENTION IS ALL YOU NEED'),
            h('p', { className: 'nd-hero-sub' }, '每章先定注意力（钩子 / 张力 / 回报 / 章末牵引），再写正文；事实自洽是底线，不是目标。'),
          ),
          h('div', { className: 'nd-hero-stats' },
            h('div', { className: 'nd-hero-stat' }, h('span', null, '平均注意力'), h('strong', null, avgScore == null ? '—' : `${avgScore} 分`)),
            h('div', { className: 'nd-hero-stat' }, h('span', null, '最低三章'), h('strong', null, weakest.length ? weakest.slice(0, 3).map((row) => `第${row.chapter}章`).join(' / ') : '—')),
            h('div', { className: 'nd-hero-stat' }, h('span', null, '未测章数'), h('strong', null, String(unscoredCount))),
          ),
        ),
        toc.length === 0
          ? h('div', { className: 'nd-card', style: { marginBottom: 12 } },
              h('div', { className: 'nd-card-head' }, h('strong', null, '这本新书还没有正文与设定')),
              h('p', { className: 'nd-hint' }, '点下面的按钮，会在「这本书自己的工作区」里新开一个对话，把开新书底座工作单发过去：AI 提交方案（自定义时）与世界 / 地点 / 人物 / 全书大纲 / 伏笔，全部进提案，你批准后才写进账本。'),
              h('div', { className: 'nd-form-row', style: { gap: 8 } },
                h(Btn, { kind: 'primary', onClick: sendBase, disabled: baseBusy }, baseBusy ? '正在发…' : '发工作单：生成设定与大纲'),
                customPreset ? h('span', { className: 'nd-hint' }, '当前是「自定义」口径：AI 会先出方案提案') : null,
              ),
              baseNotice ? h(Msg, { tone: baseNotice.tone, onClose: () => setBaseNotice(null) }, baseNotice.text) : null,
            )
          : null,
        h('div', { className: 'nd-stat-grid' },
          statCard('章节总数', fmtInt(toc.length), `${writtenCount} 章已成稿`),
          statCard('全书字数', fmtWords(totalWords), `约 ${fmtInt(totalWords)} 字`),
          statCard('待处理意见', fmtInt(openReviews.length), 'AI 意见与作者意见合计'),
          statCard('待批准提案', fmtInt(pendingProposals.length), '采纳前不会改正文'),
          statCard('平均注意力', avgScore == null ? '—' : String(avgScore), scored.length ? `${scored.length} 章有评分` : '尚无评分'),
          statCard('设定条目', fmtInt(ledgerCount), '人物 / 事实 / 事件 / 伏笔 / 冲突 / 地点'),
        ),
        h('div', { className: 'nd-two-col' },
          h('section', { className: 'nd-card' },
            h('div', { className: 'nd-card-head' }, h('h3', null, '📈 注意力曲线'), h('span', { className: 'nd-hint' }, `最近 ${Math.min(scored.length, 40)} 章`), h(Btn, { small: true, onClick: () => go('reviews', { source: 'all', recheck: 1 }) }, '冷读打分')),
            curve
              ? h('svg', { className: 'nd-curve', viewBox: `0 0 ${curve.w} ${curve.h}`, preserveAspectRatio: 'xMidYMid meet' },
                  [0, 25, 50, 75, 100].map((level) => {
                    const y = Math.round(curve.padTop + (1 - level / 100) * (curve.h - curve.padTop - curve.padBottom))
                    return h(Fragment, { key: `g${level}` },
                      h('line', { x1: curve.padLeft, x2: curve.w - curve.padRight, y1: y, y2: y, className: 'nd-curve-grid' }),
                      h('text', { x: curve.padLeft - 6, y: y + 3, textAnchor: 'end', className: 'nd-curve-axis-label' }, String(level)),
                    )
                  }),
                  h('line', { x1: curve.padLeft, x2: curve.padLeft, y1: curve.padTop, y2: curve.h - curve.padBottom, className: 'nd-curve-axis' }),
                  h('line', { x1: curve.padLeft, x2: curve.w - curve.padRight, y1: curve.h - curve.padBottom, y2: curve.h - curve.padBottom, className: 'nd-curve-axis' }),
                  h('text', { x: 10, y: curve.padTop + 4, className: 'nd-curve-axis-label' }, '分'),
                  h('polyline', { points: curve.pts.map((p) => `${p.x},${p.y}`).join(' '), className: 'nd-curve-line', fill: 'none' }),
                  curve.pts.map((p) => h('circle', { key: `p${p.chapter}`, cx: p.x, cy: p.y, r: 3, className: 'nd-curve-dot' },
                    h('title', null, `第 ${p.chapter} 章 · ${p.score} 分`),
                  )),
                  (() => {
                    const step = Math.max(1, Math.ceil(curve.pts.length / 8))
                    return curve.pts.filter((_, index) => index % step === 0 || index === curve.pts.length - 1).map((p) =>
                      h('text', { key: `x${p.chapter}`, x: p.x, y: curve.h - 8, textAnchor: 'middle', className: 'nd-curve-axis-label' }, String(p.chapter)),
                    )
                  })(),
                  h('text', { x: curve.w - curve.padRight, y: curve.h - 8, textAnchor: 'end', className: 'nd-curve-axis-label' }, '章'),
                )
              : h(Empty, null, '注意力数据不足两章，暂时画不出曲线：点上方「冷读打分」让 AI 零上下文通读打分，或在正文页侧栏手动记实测分。'),
            weakest.length
              ? h('div', { className: 'nd-weak-list' },
                  h('span', { className: 'nd-hint' }, '最弱章节：'),
                  weakest.map((row) =>
                    h('button', { key: `w${row.chapter}`, type: 'button', className: 'nd-linkbtn', onClick: () => go('read', { chapter: row.chapter }) },
                      `第 ${row.chapter} 章 · ${row.score} 分`,
                    ),
                  ),
                )
              : null,
          ),
          h('section', { className: 'nd-card' },
            h('div', { className: 'nd-card-head' }, h('h3', null, '🔎 待办')),
            h('div', { className: 'nd-todo-group' }, h('span', { className: 'nd-hint' }, `待处理意见 ${openReviews.length} 条`)),
            openReviews.length
              ? openReviews.slice(0, 6).map((rv, i) =>
                  h(
                    'button',
                    {
                      key: rv.id || `r${i}`,
                      type: 'button',
                      className: 'nd-todo-item',
                      onClick: () => go('reviews', { chapter: chapterNo(rv) || 0 }),
                    },
                    h(Tag, { tone: SEV_TONE[rv.severity] || 'muted' }, SEV_LABEL[rv.severity] || rv.severity || '意见'),
                    h('span', { className: 'nd-todo-text' }, `第 ${chapterNo(rv) || '全书'} 章 · ${String(rv.issue || '').slice(0, 40)}`),
                  ),
                )
              : h('p', { className: 'nd-muted' }, '没有待处理意见'),
            h('div', { className: 'nd-todo-group' }, h('span', { className: 'nd-hint' }, `待批准提案 ${pendingProposals.length} 条`)),
            pendingProposals.length
              ? pendingProposals.slice(0, 6).map((p) =>
                  h('button', { key: p.id, type: 'button', className: 'nd-todo-item', onClick: () => go('proposals') },
                    h(Tag, { tone: 'brand' }, PROPOSAL_KIND[p.kind] || p.kind),
                    h('span', { className: 'nd-todo-text' }, `第 ${chapterNo(p) || '全书'} 章 · ${p.title || p.summary || '提案'}`),
                  ),
                )
              : h('p', { className: 'nd-muted' }, '没有待批准提案'),
            h('div', { className: 'nd-route-bars' },
              routeCounts.map((route) =>
                h('div', { className: 'nd-route-row', key: route.id },
                  h('span', { className: 'nd-route-label' }, `${route.icon} ${route.label}`),
                  h(Bar, { value: route.count, max: Math.max(1, ...routeCounts.map((r) => r.count)) }),
                  h('span', { className: 'nd-route-count' }, String(route.count)),
                ),
              ),
            ),
          ),
        ),
        h('div', { className: 'nd-two-col' },
          h('section', { className: 'nd-card' },
            h('div', { className: 'nd-card-head' }, h('h3', null, '💳 用量'), usageRes.loading ? h('span', { className: 'nd-hint' }, '读取中…') : null),
            usageRes.error ? h(ErrorBox, { error: usageRes.error, onRetry: () => usageRes.reload() }) : h(KeyValue, { rows: usageRows, emptyText: '还没有用量记录' }),
          ),
          h('section', { className: 'nd-card' },
            h('div', { className: 'nd-card-head' }, h('h3', null, '🧭 版本对齐'), alignRes.loading ? h('span', { className: 'nd-hint' }, '读取中…') : null),
            alignRes.error ? h(ErrorBox, { error: alignRes.error, onRetry: () => alignRes.reload() }) : h(KeyValue, { rows: alignRows, emptyText: '还没有对齐记录' }),
          ),
        ),
      )
    }
    // ── 页 9：设置 ────────────────────────────────────────────
    // 预设 = 写作约定（改预设不改正文）。这里是「绝对模板」：照着填就能自定义。
    const PRESET_TEMPLATE = `{
  // ── 身份 ─────────────────────────────────────────
  "id": "preset-my-own",          // 唯一 id：小写英文/数字/-，不要重复
  "name": "我的预设",              // 界面上显示的名字
  "desc": "一句话说明这个预设适合什么题材", // 显示在预设卡片上

  // ── 规模 ─────────────────────────────────────────
  "genre": "悬疑",                // 题材标签（可空）
  "plannedChapters": 60,          // 计划章数（写作工作单会参考）
  "chapterWords": 3000,           // 每章目标字数
  "totalWords": 180000,           // 全书目标字数（plannedChapters × chapterWords）

  // ── 叙事视角与节奏 ───────────────────────────────
  "pov": "第三人称限知",           // 第一人称限知 / 第三人称限知 / 第三人称全知
  "tense": "过去时",
  "pacing": {
    "openingChapters": 4,          // 开头几章完成入场
    "escalationEvery": 6,          // 每几章升一次压力
    "midpointRatio": 0.5,          // 中点转折在全书的位置（0–1）
    "climaxRatio": 0.9             // 高潮位置（0–1）
  },

  // ── 风格规则（会被拼进 AI 工作单） ────────────────
  "styleRules": [
    "短句为主，少形容词；不解释情绪，只写动作与物件",
    "每章至少一个具体钩子，章末留牵引"
  ],

  // ── 禁忌（AI 写了就要被判 AI 味 / 退回） ──────────
  "taboo": ["套话式总结", "现代网络用语", "Markdown 强调与标题"],

  // ── 审阅重点（四路审阅时优先看什么） ──────────────
  "reviewFocus": ["事实与连续性", "读者牵引（冷读）", "去 AI 味", "读者体验"],

  // ── 人物功能（不是人物卡，是「这类角色必须承担什么」） ──
  "characters": {
    "protagonist": "目标明确但有一个致命缺陷；前十章要看见缺陷的代价",
    "antagonist": "压力持续升级，不能只出现一次",
    "supporting": "每人一个功能：给信息 / 制造阻力 / 情感锚点"
  },

  // ── 备注 ─────────────────────────────────────────
  "notes": "自定义预设的验收口径写在这里"
}`
    function PresetDialog({ title, initial, busy, onCancel, onSubmit }) {
      const [draft, setDraft] = useState(() => ({
        id: String((initial && initial.id) || `preset-custom-${Date.now().toString(36)}`),
        name: String((initial && initial.name) || ''),
        desc: String((initial && initial.desc) || ''),
        genre: String((initial && initial.genre) || ''),
        plannedChapters: toNumber(initial && initial.plannedChapters, 0),
        chapterWords: toNumber(initial && initial.chapterWords, 0),
        pov: String((initial && initial.pov) || '第三人称限知'),
        tense: String((initial && initial.tense) || '过去时'),
        styleRules: (Array.isArray(initial && initial.styleRules) ? initial.styleRules : []).join('\n'),
        taboo: (Array.isArray(initial && initial.taboo) ? initial.taboo : []).join('\n'),
        reviewFocus: (Array.isArray(initial && initial.reviewFocus) ? initial.reviewFocus : []).join('\n'),
        protagonist: String((initial && initial.characters && initial.characters.protagonist) || ''),
        antagonist: String((initial && initial.characters && initial.characters.antagonist) || ''),
        supporting: String((initial && initial.characters && initial.characters.supporting) || ''),
        notes: String((initial && initial.notes) || ''),
      }))
      const set = (key, value) => setDraft((cur) => ({ ...cur, [key]: value }))
      const lines = (value) => String(value || '').split('\n').map((line) => line.trim()).filter(Boolean)
      const submit = () => {
        if (!String(draft.name).trim()) return
        onSubmit({
          ...draft,
          name: String(draft.name).trim(),
          totalWords: toNumber(draft.plannedChapters, 0) * toNumber(draft.chapterWords, 0),
          styleRules: lines(draft.styleRules),
          taboo: lines(draft.taboo),
          reviewFocus: lines(draft.reviewFocus),
          characters: { protagonist: draft.protagonist, antagonist: draft.antagonist, supporting: draft.supporting },
        })
      }
      return h(Modal, {
        title,
        wide: true,
        onClose: onCancel,
        footer: h(Fragment, null,
          h(Btn, { onClick: onCancel }, '取消'),
          h(Btn, { kind: 'primary', onClick: submit, disabled: busy || !String(draft.name).trim() }, busy ? '保存中…' : '保存预设'),
        ),
      },
        h('div', { className: 'nd-form-grid' },
          h(Field, { label: '预设名称（必填）' }, h(TextInput, { value: draft.name, onChange: (v) => set('name', v), placeholder: '例：冷峻悬疑' })),
          h(Field, { label: '题材标签' }, h(TextInput, { value: draft.genre, onChange: (v) => set('genre', v), placeholder: '悬疑 / 武侠 / 现实' })),
          h(Field, { label: '计划章数' }, h(TextInput, { type: 'number', value: draft.plannedChapters, onChange: (v) => set('plannedChapters', toNumber(v, 0)) })),
          h(Field, { label: '每章目标字数' }, h(TextInput, { type: 'number', value: draft.chapterWords, onChange: (v) => set('chapterWords', toNumber(v, 0)) })),
          h(Field, { label: '视角' }, h(TextInput, { value: draft.pov, onChange: (v) => set('pov', v) })),
          h(Field, { label: '时态' }, h(TextInput, { value: draft.tense, onChange: (v) => set('tense', v) })),
        ),
        h(Field, { label: '一句话说明' }, h(TextInput, { value: draft.desc, onChange: (v) => set('desc', v), placeholder: '这个预设适合什么题材、解决什么写作问题' })),
        h(Field, { label: '风格规则（每行一条）', hint: '会被拼进 AI 工作单' }, h(TextArea, { value: draft.styleRules, rows: 4, onChange: (v) => set('styleRules', v) })),
        h(Field, { label: '禁忌（每行一条）', hint: 'AI 写了就要退回重写' }, h(TextArea, { value: draft.taboo, rows: 3, onChange: (v) => set('taboo', v) })),
        h(Field, { label: 'AI 意见重点（每行一条）' }, h(TextArea, { value: draft.reviewFocus, rows: 2, onChange: (v) => set('reviewFocus', v) })),
        h(Field, { label: '主角必须承担什么' }, h(TextInput, { value: draft.protagonist, onChange: (v) => set('protagonist', v) })),
        h(Field, { label: '反派/压力必须怎么升级' }, h(TextInput, { value: draft.antagonist, onChange: (v) => set('antagonist', v) })),
        h(Field, { label: '配角各自的功能' }, h(TextInput, { value: draft.supporting, onChange: (v) => set('supporting', v) })),
        h(Field, { label: '验收口径 / 备注' }, h(TextArea, { value: draft.notes, rows: 2, onChange: (v) => set('notes', v) })),
      )
    }

    function SettingsTab({ projectId, project, context, toc, refreshContext, openProject }) {
      const settingsRes = useAsync(() => api('settings.get', scope(projectId)), [projectId])
      const [form, setForm] = useState(null)
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState(null)
      const [importPath, setImportPath] = useState('')
      const [importing, setImporting] = useState(false)
      const [importInfo, setImportInfo] = useState('')
      const [importedId, setImportedId] = useState('')
      const [presetDialog, setPresetDialog] = useState(null) // { initial, title }
      const [presetBusy, setPresetBusy] = useState(false)

      // 导入旧稿：只读扫描 → 明确点「导入」才写（新建一部作品，原目录不动）
      const runImport = async (apply) => {
        const rootPath = importPath.trim()
        if (!rootPath) return setImportInfo('先填一个目录：它下面要有 chapters/0001.md（或 .txt）')
        setImporting(true)
        setImportInfo('')
        try {
          if (!apply) {
            const scan = await api('import.scan', { rootPath })
            setImportInfo(`扫描到 ${scan.files.length} 章、${scan.totalWords} 字${scan.project && scan.project.title ? `，作品名《${scan.project.title}》` : ''}`)
            return
          }
          const done = await api('import.run', { rootPath })
          setImportInfo(`已导入《${done.title}》：${done.chapters} 章 / ${done.words} 字`)
          setImportedId(done.projectId)
        } catch (err) {
          setImportInfo(`导入失败：${friendlyError(err)}`)
        } finally {
          setImporting(false)
        }
      }

      const presetList = useMemo(() => {
        const fromSettings = settingsRes.data && Array.isArray(settingsRes.data.presets) ? settingsRes.data.presets : null
        const fromContext = context && Array.isArray(context.presets) ? context.presets : null
        return (fromSettings || fromContext || []).filter((row) => row && typeof row === 'object')
      }, [settingsRes.data, context])
      const activePresetId = (settingsRes.data && settingsRes.data.project && settingsRes.data.project.activePresetId) || (project && project.activePresetId) || ''
      const savePresets = async (list) => {
        await api('settings.save', { projectId, presets: list })
        settingsRes.reload()
        return true
      }
      const applyPreset = async (preset) => {
        setPresetBusy(true)
        setNotice(null)
        try {
          await api('settings.save', {
            projectId,
            presets: presetList,
            project: {
              activePresetId: preset.id,
              plannedChapters: toNumber(preset.plannedChapters, 0),
              chapterWords: toNumber(preset.chapterWords, 0),
              pov: preset.pov ? String(preset.pov) : undefined,
              tense: preset.tense ? String(preset.tense) : undefined,
              style: Array.isArray(preset.styleRules) ? preset.styleRules.join('；') : undefined,
            },
          })
          settingsRes.reload()
          setForm(null)
          if (refreshContext) refreshContext()
          setNotice({ tone: 'ok', text: `已应用预设：${preset.name || preset.id}（不动正文，只改写作约定）` })
        } catch (err) {
          setNotice({ tone: 'error', text: `应用预设失败：${friendlyError(err)}` })
        } finally {
          setPresetBusy(false)
        }
      }
      const savePresetDraft = async (draft) => {
        setPresetBusy(true)
        setNotice(null)
        try {
          const existing = presetList.findIndex((row) => String(row.id) === String(draft.id))
          const now = new Date().toISOString()
          const next = presetList.slice()
          if (existing >= 0) next[existing] = { ...next[existing], ...draft, updatedAt: now }
          else next.push({ ...draft, createdAt: now, updatedAt: now })
          await savePresets(next)
          setPresetDialog(null)
          setNotice({ tone: 'ok', text: `预设已保存：${draft.name}` })
        } catch (err) {
          setNotice({ tone: 'error', text: `保存预设失败：${friendlyError(err)}` })
        } finally {
          setPresetBusy(false)
        }
      }

      useEffect(() => {
        if (form) return
        const value = settingsRes.data
        if (!value && !context && !project) return
        const src = value && typeof value === 'object' ? value : {}
        const proj = (src.project && typeof src.project === 'object' ? src.project : null) || (context && context.project) || project || {}
        const presetList =
          (Array.isArray(src.presets) ? src.presets : null) ||
          (context && Array.isArray(context.presets) ? context.presets : null) ||
          []
        const preset = presetList[0] && typeof presetList[0] === 'object' ? presetList[0] : {}
        const budget = (src.budget && typeof src.budget === 'object' ? src.budget : null) || (proj.budget && typeof proj.budget === 'object' ? proj.budget : {})
        const styleText =
          typeof proj.style === 'string'
            ? proj.style
            : Array.isArray(preset.styleRules)
              ? preset.styleRules.join('；')
              : ''
        setForm({
          title: String(proj.title != null ? proj.title : proj.name != null ? proj.name : ''),
          genre: String(proj.genre || ''),
          style: styleText,
          chapterWords: toNumber(preset.chapterWords != null ? preset.chapterWords : proj.chapterWords, 0),
          plannedChapters: toNumber(preset.plannedChapters != null ? preset.plannedChapters : proj.plannedChapters, 0),
          budget: { maxTokens: toNumber(budget.maxTokens, 0), maxCostCNY: toNumber(budget.maxCostCNY, 0) },
        })
      }, [form, settingsRes.data, context, project])

      const set = (path, value) => setForm((cur) => (cur ? setPath(cur, path, value) : cur))
      const save = async () => {
        if (!form) return
        setSaving(true)
        setNotice(null)
        try {
          const data = settingsRes.data && typeof settingsRes.data === 'object' ? settingsRes.data : {}
          const presetList =
            (Array.isArray(data.presets) ? data.presets : null) ||
            (context && Array.isArray(context.presets) ? context.presets : null) ||
            []
          const base = presetList[0] && typeof presetList[0] === 'object' ? presetList[0] : null
          const presets = base ? [{ ...base, plannedChapters: form.plannedChapters, chapterWords: form.chapterWords }] : null
          const payload = {
            project: { title: form.title, genre: form.genre, style: form.style },
            budget: form.budget,
          }
          if (presets) payload.presets = presets
          await api('settings.save', scope(projectId, payload))
          settingsRes.reload()
          if (refreshContext) refreshContext()
          setNotice({ tone: 'ok', text: '设置已保存' })
        } catch (err) {
          setNotice({ tone: 'error', text: `保存失败：${friendlyError(err)}` })
        } finally {
          setSaving(false)
        }
      }

      const storageRes = useAsync(() => (projectId ? api('storage.status', scope(projectId)) : Promise.resolve(null)), [projectId])
      const rolesRes = useAsync(() => api('roles.list'), [])
      const unknownRes = useAsync(() => (projectId ? api('ledger.unknown', scope(projectId)) : Promise.resolve({ items: [] })), [projectId])

      const pluginRoot = (settingsRes.data && settingsRes.data.dataRoot) || '~/.dsh/data/dsh-long-novel-workbench'
      const rootValue = (settingsRes.data && settingsRes.data.projectDir) || (project && (project.dataDir || project.root)) || ''
      const realProject = (settingsRes.data && settingsRes.data.project) || project || null
      const projectRows = realProject
        ? [
            { key: '作品 id', text: String(realProject.id || projectId) },
            { key: '作品数据目录（书工作区）', text: String(rootValue) },
            { key: '插件私有数据根', text: String(pluginRoot) },
            { key: '章节数', text: `${toc.length} 章` },
            { key: '创建时间', text: realProject.createdAt ? String(realProject.createdAt) : '—' },
          ]
        : []

      return h('div', { className: 'nd-page nd-settings' },
        h('div', { className: 'nd-page-head' },
          h('div', null, h('h2', null, '设置'), h('p', { className: 'nd-hint' }, '作品级写作参数；预算只约束 AI 动作的上限。')),
          h('div', { className: 'nd-page-actions' }, h(Btn, { small: true, kind: 'primary', onClick: save, disabled: saving || !form }, saving ? '保存中…' : '保存设置')),
        ),
        notice ? h(Msg, { tone: notice.tone, onClose: () => setNotice(null) }, notice.text) : null,
        settingsRes.error ? h(ErrorBox, { error: settingsRes.error, onRetry: () => settingsRes.reload() }) : null,
        h(TitleMigrationCard, { projectId }),
        storageRes.data
          ? h('section', { className: 'nd-card' },
              h('div', { className: 'nd-card-head' }, h('h3', null, '🧾 账本数据库')),
              h('p', { className: 'nd-hint' }, storageRes.data.ledger
                ? `实体 ${storageRes.data.ledger.entities} ｜ 提及 ${storageRes.data.ledger.mentions} ｜ 事实 ${storageRes.data.ledger.facts} ｜ 事件 ${storageRes.data.ledger.events} ｜ 高光 ${storageRes.data.ledger.highlights} ｜ 待确认专名 ${storageRes.data.ledger.unknown}`
                : '账本数据库尚未建立。'),
              h('p', { className: 'nd-hint' }, '首次建账：账本页跑一次「全书同步」，AI 会把人物/地点/事实/事件落库；之后改正文只做本地增量同步，不再花 AI。'),
              unknownRes.data && Array.isArray(unknownRes.data.items) && unknownRes.data.items.length
                ? h('div', { className: 'nd-unknown-list' },
                    h('p', { className: 'nd-hint' }, '未登记专名（确认后记入别名，之后自动匹配）：'),
                    unknownRes.data.items.slice(0, 30).map((item) => h('div', { className: 'nd-unknown', key: `${item.chapter}:${item.name}` },
                      h('span', null, `${item.name}（第 ${item.chapter} 章 ×${item.count}）`),
                      h(Btn, { small: true, onClick: async () => { try { await api('ledger.confirm', scope(projectId, { name: item.name, kind: 'character', chapter: item.chapter })); unknownRes.reload(); storageRes.reload() } catch (err) { /* 下一步再显示错误 */ } } }, '确认人物'),
                      h(Btn, { small: true, onClick: async () => { try { await api('ledger.confirm', scope(projectId, { name: item.name, kind: 'location', chapter: item.chapter })); unknownRes.reload(); storageRes.reload() } catch (err) { /* 同上 */ } } }, '确认地点'),
                    )),
                  )
                : null,
            )
          : null,
        h(UpdateCard, null),
        rolesRes.data && Array.isArray(rolesRes.data.roles)
          ? h('section', { className: 'nd-card' },
              h('div', { className: 'nd-card-head' }, h('h3', null, '🧑‍🤝‍🧑 分工（7 角色）')),
              h('p', { className: 'nd-hint' }, '每次派单指定一个角色、由子 agent 完成；主对话（编辑）只验收地址与格式，不重读正文。'),
              h('div', { className: 'nd-role-list' },
                rolesRes.data.roles.map((role) => h('div', { className: 'nd-role', key: role.id },
                  h('strong', null, role.name),
                  h('span', { className: 'nd-hint' }, ` ｜ ${role.when} ｜ 输出上限：${role.limit}`),
                  h('p', { className: 'nd-hint' }, role.duty),
                )),
              ),
            )
          : null,
        storageRes.data
          ? h('section', { className: 'nd-card' },
              h('div', { className: 'nd-card-head' }, h('h3', null, '🗄️ 数据存储')),
              h('p', { className: 'nd-hint' },
                storageRes.data.engine === 'sqlite'
                  ? `SQLite（Node ${storageRes.data.node}）：账本、意见、段落索引按库查询；正文保存后本地增量同步，不消耗 AI。`
                  : `当前环境不支持 SQLite，已降级为 JSON（${storageRes.data.reason || '原因未知'}）。功能可用，账本同步变慢；可升级 DSH/Node 恢复。`),
              h('p', { className: 'nd-hint' },
                `库文件：${storageRes.data.dbPath || '—'} ｜ 意见：${Object.entries(storageRes.data.opinions || {}).map(([k, v]) => `${k} ${v}`).join('，') || '暂无'} ｜ 账本：${storageRes.data.ledger ? `实体 ${storageRes.data.ledger.entities} / 提及 ${storageRes.data.ledger.mentions} / 待确认 ${storageRes.data.ledger.unknown}` : '—'}`),
            )
          : null,
        !form && settingsRes.loading ? h(Loading, null, '正在读取设置…') : null,
        form
          ? h('div', { className: 'nd-two-col' },
              h('section', { className: 'nd-card' },
                h('div', { className: 'nd-card-head' }, h('h3', null, '✍️ 作品参数')),
                h(Field, { label: '作品标题' }, h(TextInput, { value: form.title, onChange: (v) => set('title', v), placeholder: '作品标题' })),
                h(Field, { label: '类型' }, h(TextInput, { value: form.genre, onChange: (v) => set('genre', v), placeholder: '如 古代言情 / 都市悬疑' })),
                h(Field, { label: '风格要求', hint: '会作为写作预设的一部分传给 AI' }, h(TextArea, { value: form.style, rows: 4, onChange: (v) => set('style', v) })),
                h(Field, { label: '计划章数' }, h(TextInput, { type: 'number', value: form.plannedChapters, onChange: (v) => set('plannedChapters', toNumber(v, 0)) })),
                h(Field, { label: '每章目标字数' }, h(TextInput, { type: 'number', value: form.chapterWords, onChange: (v) => set('chapterWords', toNumber(v, 0)) })),
              ),
              h(
                'div',
                null,
                h('section', { className: 'nd-card' },
                  h('div', { className: 'nd-card-head' }, h('h3', null, '📤 导出正文')),
                  h('p', { className: 'nd-hint' }, '把全部章节导出成成品：TXT / Markdown / EPUB / DOCX。正文纯文本，成品不会漏出写作期的 Markdown 标记。'),
                  h(ExportQuick, { projectId }),
                ),
                h('section', { className: 'nd-card' },
                  h('div', { className: 'nd-card-head' }, h('h3', null, '📥 导入旧稿')),
                  h('p', { className: 'nd-hint' }, '任何作品都能导入：给一个目录或单个 .md / .txt 文件即可，不要求 0001.md 这种命名。目录会按自然顺序每个文件当一章；单文件可以按「第X章」标题自动拆章。扫描只读，导入会新建一部作品，原目录不动。'),
                  h('div', { className: 'nd-form-row' },
                    h(TextInput, { value: importPath, onChange: setImportPath, placeholder: '/path/to/旧稿目录 或 一本书.md' }),
                    h(Btn, { small: true, onClick: () => runImport(false), disabled: importing }, '扫描'),
                    h(Btn, { small: true, kind: 'primary', onClick: () => runImport(true), disabled: importing }, importing ? '导入中…' : '导入'),
                  ),
                  importInfo ? h('p', { className: 'nd-hint' }, importInfo) : null,
                  importedId && openProject ? h(Btn, { small: true, onClick: () => openProject(importedId) }, '打开新作品') : null,
                ),
                h('section', { className: 'nd-card' },
                  h('div', { className: 'nd-card-head' }, h('h3', null, '💰 预算上限')),
                  h('p', { className: 'nd-hint' },
                    '预算只用于全文动作（从头写 / 扩写 / 改写）；正文页的动作按单章预算走。',
                  ),
                  h(Field, { label: '最大 tokens' }, h(TextInput, { type: 'number', value: form.budget && form.budget.maxTokens, onChange: (v) => set('budget.maxTokens', toNumber(v, 0)) })),
                  h(Field, { label: '最大花费（元）' }, h(TextInput, { type: 'number', value: form.budget && form.budget.maxCostCNY, onChange: (v) => set('budget.maxCostCNY', toNumber(v, 0)) })),
                ),
                h('section', { className: 'nd-card' },
                  h('div', { className: 'nd-card-head' },
                    h('h3', null, '📚 写作预设'),
                    h('div', { className: 'nd-row-actions' },
                      h(Btn, { small: true, onClick: () => setPresetDialog({ initial: null, title: '新建预设' }) }, '＋ 新建'),
                      h(Btn, { small: true, onClick: async () => {
                        const ok = await copyText(PRESET_TEMPLATE)
                        setNotice({ tone: ok ? 'ok' : 'warn', text: ok ? '绝对模板已复制：照字段填好，再点「＋ 新建」粘贴成预设。' : '复制失败：可以打开 docs/PRESET-TEMPLATE.md 手抄。' })
                      } }, '复制绝对模板'),
                    ),
                  ),
                  h('p', { className: 'nd-hint' }, '预设是写作约定（视角/节奏/风格/禁忌/AI 意见重点）；换预设不会改正文。应用后新建的 AI 工作单会带上它。'),
                  h('div', { className: 'nd-preset-list' },
                    presetList.map((preset) => {
                      const active = String(preset.id) === String(activePresetId)
                      return h('div', { key: String(preset.id), className: `nd-preset${active ? ' nd-preset-active' : ''}` },
                        h('div', { className: 'nd-preset-main' },
                          h('div', { className: 'nd-preset-title' }, h('strong', null, String(preset.name || preset.id)), active ? h(Tag, { tone: 'brand' }, '当前') : null),
                          preset.desc ? h('p', { className: 'nd-hint' }, String(preset.desc)) : null,
                          h('div', { className: 'nd-preset-meta' },
                            h(Tag, null, `${toNumber(preset.plannedChapters, 0)} 章`),
                            h(Tag, null, `每章 ${toNumber(preset.chapterWords, 0)} 字`),
                            preset.pov ? h(Tag, null, String(preset.pov)) : null,
                            Array.isArray(preset.taboo) && preset.taboo.length ? h(Tag, null, `禁忌 ${preset.taboo.length} 条`) : null,
                            Array.isArray(preset.reviewFocus) && preset.reviewFocus.length ? h(Tag, null, `AI 意见重点 ${preset.reviewFocus.length} 条`) : null,
                          ),
                        ),
                        h('div', { className: 'nd-preset-actions' },
                          h(Btn, { small: true, kind: active ? 'default' : 'primary', onClick: () => applyPreset(preset), disabled: presetBusy }, active ? '重新应用' : '应用'),
                          h(Btn, { small: true, onClick: () => setPresetDialog({ initial: preset, title: `编辑预设：${preset.name || preset.id}` }) }, '编辑'),
                          preset.id !== 'preset-custom' && preset.id !== 'preset-classic-long' && preset.id !== 'preset-suspense-cold' && preset.id !== 'preset-wuxia-historical' && preset.id !== 'preset-literary-real'
                            ? h(Btn, { small: true, onClick: async () => {
                                try {
                                  await savePresets(presetList.filter((row) => String(row.id) !== String(preset.id)))
                                  setNotice({ tone: 'ok', text: `已删除预设：${preset.name || preset.id}` })
                                } catch (err) {
                                  setNotice({ tone: 'error', text: `删除失败：${friendlyError(err)}` })
                                }
                              } }, '删除')
                            : null,
                        ),
                      )
                    }),
                  ),
                ),
                h('section', { className: 'nd-card' },
                  h('div', { className: 'nd-card-head' }, h('h3', null, '📁 数据位置（只读）')),
                  h(KeyValue, { rows: projectRows, emptyText: '还没有读取到作品信息' }),
                  h('p', { className: 'nd-hint' }, '作品数据在自己的书工作区（普通 Markdown / JSON 文件）；插件私有索引在 ~/.dsh/data/dsh-long-novel-workbench，与小说工作区隔离。'),
                ),
              ),
            )
          : null,
        presetDialog
          ? h(PresetDialog, {
              title: presetDialog.title,
              initial: presetDialog.initial,
              busy: presetBusy,
              onCancel: () => setPresetDialog(null),
              onSubmit: savePresetDraft,
            })
          : null,
      )
    }
    // ── 样式 ──────────────────────────────────────────────────
    const CSS = `
.nd-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--dsw-alias-scrim,rgba(0,0,0,.45))}.nd-panel{width:100%;height:calc(100vh - 40px);max-width:1680px;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:14px;background:var(--dsw-alias-bg,#fff);color:var(--dsw-alias-fg,#111827);box-shadow:0 24px 64px rgba(0,0,0,.28)}.nd-top{display:flex;align-items:center;gap:14px;padding:9px 16px;border-bottom:1px solid var(--dsw-alias-border,#e5e7eb);background:var(--dsw-alias-bg-elevated,#fafafa);flex:none}.nd-brand{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600}.nd-brand-icon{font-size:18px}.nd-top-meta{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-top-right{margin-left:auto;display:flex;align-items:center;gap:10px}.nd-proj{display:flex;align-items:center;gap:6px}.nd-proj-label{font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-body{flex:1;display:flex;min-height:0}.nd-nav{width:176px;flex:none;display:flex;flex-direction:column;gap:2px;padding:10px 8px;border-right:1px solid var(--dsw-alias-border,#e5e7eb);background:var(--dsw-alias-bg-elevated,#fafafa);overflow-y:auto}.nd-nav-group{padding:10px 8px 4px;font-size:11px;letter-spacing:.06em;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-nav-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font-size:13px;text-align:left;cursor:pointer}.nd-nav-item:hover{background:var(--dsw-alias-bg-hover,rgba(0,0,0,.05))}.nd-nav-item.nd-nav-active{background:var(--dsw-alias-brand-weak,rgba(59,130,246,.14));color:var(--dsw-alias-brand,#2563eb);font-weight:600}.nd-nav-icon{width:16px;text-align:center}.nd-nav-title{flex:1}.nd-main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}.nd-page{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;padding:16px 18px;overflow-y:auto}.nd-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.nd-page-head h2{margin:0;font-size:18px}.nd-page-actions{display:flex;align-items:center;gap:8px;flex:none}.nd-hint{margin:0;font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-muted{font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg,#fff);color:inherit;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}.nd-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand,#2563eb)}.nd-btn:disabled{opacity:.5;cursor:not-allowed}.nd-btn-sm{padding:3px 9px;font-size:12px}.nd-btn-primary{background:var(--dsw-alias-brand,#2563eb);border-color:var(--dsw-alias-brand,#2563eb);color:var(--dsw-alias-brand-fg,#fff)}.nd-btn-danger{color:var(--dsw-alias-error,#dc2626);border-color:var(--dsw-alias-error,#dc2626)}.nd-linkbtn{border:0;background:transparent;color:var(--dsw-alias-brand,#2563eb);font-size:12px;cursor:pointer;padding:2px 4px;border-radius:6px}.nd-linkbtn:hover{text-decoration:underline}.nd-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.nd-iconbtn:hover{background:var(--dsw-alias-bg-hover,rgba(0,0,0,.06))}.nd-input{width:100%;box-sizing:border-box;padding:6px 9px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg,#fff);color:inherit;font:inherit;font-size:13px}.nd-input:focus{outline:2px solid var(--dsw-alias-brand-weak,rgba(59,130,246,.35));outline-offset:0;border-color:var(--dsw-alias-brand,#2563eb)}.nd-textarea{resize:vertical;line-height:1.7}.nd-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}.nd-label{font-size:12px;font-weight:600}.nd-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}.nd-form-grid .nd-field:last-child{grid-column:1/-1}.nd-form-row{display:flex;gap:10px;align-items:center}.nd-check{width:14px;height:14px;accent-color:var(--dsw-alias-brand,#2563eb);cursor:pointer}.nd-tag{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;background:var(--dsw-alias-bg-elevated,#f3f4f6);color:var(--dsw-alias-fg-muted,#4b5563);white-space:nowrap}.nd-tag-brand{background:var(--dsw-alias-brand-weak,rgba(59,130,246,.14));color:var(--dsw-alias-brand,#2563eb)}.nd-tag-ok{background:rgba(22,163,74,.14);color:#15803d}.nd-tag-warn{background:rgba(217,119,6,.16);color:#b45309}.nd-tag-error{background:rgba(220,38,38,.14);color:#b91c1c}.nd-tag-muted{background:var(--dsw-alias-bg-elevated,#f3f4f6);color:var(--dsw-alias-fg-muted,#6b7280)}.nd-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-fg-muted,#9ca3af)}.nd-dot-brand{background:var(--dsw-alias-brand,#2563eb)}.nd-dot-ok{background:#16a34a}.nd-dot-warn{background:#d97706}.nd-dot-error{background:#dc2626}.nd-tabs{display:flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-elevated,#f3f4f6);width:fit-content;flex:none}.nd-tab{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}.nd-tab.nd-tab-active{background:var(--dsw-alias-bg,#fff);color:var(--dsw-alias-brand,#2563eb);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.12)}.nd-tab-badge{font-size:10px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-brand-weak,rgba(59,130,246,.16));color:var(--dsw-alias-brand,#2563eb)}.nd-seg{display:flex;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:8px;overflow:hidden;flex:none}.nd-seg-item{padding:4px 10px;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}.nd-seg-item+.nd-seg-item{border-left:1px solid var(--dsw-alias-border,#e5e7eb)}.nd-seg-item.nd-seg-active{background:var(--dsw-alias-brand,#2563eb);color:var(--dsw-alias-brand-fg,#fff)}.nd-msg{display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:8px;font-size:12px;flex:none}.nd-msg-info{background:var(--dsw-alias-brand-weak,rgba(59,130,246,.12));color:var(--dsw-alias-brand,#1d4ed8)}.nd-msg-ok{background:rgba(22,163,74,.12);color:#15803d}.nd-msg-error{background:rgba(220,38,38,.12);color:#b91c1c}.nd-msg-text{flex:1}.nd-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:44px 16px;border:1px dashed var(--dsw-alias-border,#e5e7eb);border-radius:12px;font-size:13px;color:var(--dsw-alias-fg-muted,#6b7280);text-align:center}.nd-loading{display:flex;align-items:center;gap:8px;padding:20px;font-size:13px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-spinner{width:14px;height:14px;border:2px solid var(--dsw-alias-border,#e5e7eb);border-top-color:var(--dsw-alias-brand,#2563eb);border-radius:50%;animation:nd-spin .8s linear infinite}@keyframes nd-spin{to{transform:rotate(360deg)}}.nd-errorbox{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;background:rgba(220,38,38,.1);color:#b91c1c;font-size:12px}.nd-errorbox-icon{font-size:14px}.nd-errorbox-text{flex:1}.nd-mask{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45)}.nd-modal{width:520px;max-width:100%;max-height:82vh;display:flex;flex-direction:column;border-radius:14px;background:var(--dsw-alias-bg,#fff);color:var(--dsw-alias-fg,#111827);box-shadow:0 24px 64px rgba(0,0,0,.3)}.nd-modal-wide{width:760px}.nd-modal-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border,#e5e7eb)}.nd-modal-title{font-size:14px}.nd-modal-body{padding:14px 16px;overflow-y:auto}.nd-modal-foot{display:flex;justify-content:flex-end;padding:12px 16px;border-top:1px solid var(--dsw-alias-border,#e5e7eb)}.nd-modal-actions{display:flex;gap:8px}
.nd-bar{position:relative;height:6px;border-radius:999px;background:var(--dsw-alias-bg-elevated,#eef0f3);overflow:hidden;flex:1;min-width:40px}.nd-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand,#2563eb);transition:width .2s}.nd-bar-ok{background:#16a34a}.nd-bar-warn{background:#d97706}.nd-bar-error{background:#dc2626}.nd-table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:10px}.nd-table{width:100%;border-collapse:collapse;font-size:12px}.nd-table th,.nd-table td{padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border,#f0f1f3);text-align:left;vertical-align:top}.nd-table th{background:var(--dsw-alias-bg-elevated,#fafafa);font-weight:600;position:sticky;top:0}.nd-table tr:last-child td{border-bottom:0}.nd-cell-clip{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nd-row-actions{display:flex;gap:6px;flex-wrap:wrap}.nd-panel-box{display:flex;flex-direction:column;gap:10px;flex:1;min-height:0}.nd-ledger-note{font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.nd-stat{display:flex;flex-direction:column;gap:3px;padding:12px 14px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-elevated,#fafafa)}.nd-stat-label{font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-stat-value{font-size:20px}.nd-stat-hint{font-size:11px;color:var(--dsw-alias-fg-muted,#9ca3af)}.nd-two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}.nd-card{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg,#fff)}.nd-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.nd-card-head h3{margin:0;font-size:14px}.nd-kv{display:flex;flex-direction:column;gap:4px;font-size:12px}.nd-kv-row{display:flex;gap:10px}.nd-kv-k{flex:none;min-width:96px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-kv-v{flex:1;word-break:break-word}.nd-todo-group{margin-top:6px;font-size:12px}.nd-todo-item{display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}.nd-todo-item:hover{background:var(--dsw-alias-bg-hover,rgba(0,0,0,.05))}.nd-todo-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nd-route-bars{display:flex;flex-direction:column;gap:6px;margin-top:8px}.nd-route-row{display:grid;grid-template-columns:76px 1fr 26px;align-items:center;gap:8px;font-size:12px}.nd-route-label{white-space:nowrap}.nd-route-count{text-align:right;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-route-name{flex:1}.nd-route-hot{color:var(--dsw-alias-error,#dc2626);font-weight:600}.nd-curve{width:100%;height:170px}.nd-curve-grid{stroke:var(--dsw-alias-border,#e5e7eb);stroke-width:1;stroke-dasharray:3 4}.nd-curve-line{stroke:var(--dsw-alias-brand,#2563eb);stroke-width:2;stroke-linejoin:round}.nd-curve-dot{fill:var(--dsw-alias-brand,#2563eb)}.nd-weak-list{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px}.nd-welcome{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:40px;text-align:center}.nd-welcome-icon{font-size:40px}.nd-welcome h2{margin:0}.nd-code-hint{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-pre-note{margin:6px 0 0}.nd-read{flex:1;min-height:0;display:grid;grid-template-columns:260px minmax(0,1fr) 320px;gap:0}.nd-toc{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border,#e5e7eb);background:var(--dsw-alias-bg-elevated,#fafafa)}.nd-toc-head{padding:10px 12px 6px;display:flex;flex-direction:column;gap:6px;border-bottom:1px solid var(--dsw-alias-border,#f0f1f3)}.nd-toc-headline{display:flex;align-items:center;gap:8px}.nd-toc-headline .nd-hint{margin-right:auto}.nd-toc-list{flex:1;overflow-y:auto;padding:6px}.nd-toc-item{display:block;width:100%;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.nd-toc-item:hover{background:var(--dsw-alias-bg-hover,rgba(0,0,0,.05))}.nd-toc-item.nd-toc-active{background:var(--dsw-alias-brand-weak,rgba(59,130,246,.14))}.nd-toc-main{display:flex;align-items:center;gap:6px}.nd-toc-no{font-size:11px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-toc-title{flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nd-toc-sub{display:flex;align-items:center;gap:6px;margin-top:3px}.nd-toc-right{display:flex;align-items:center;gap:6px}.nd-toc-foot{padding:8px 12px;border-top:1px solid var(--dsw-alias-border,#f0f1f3);font-size:11px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-read-main{display:flex;flex-direction:column;min-width:0;min-height:0}.nd-read-head{display:flex;flex-direction:column;gap:8px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border,#e5e7eb);background:var(--dsw-alias-bg,#fff);position:relative;z-index:2}.nd-read-row{display:flex;align-items:center;gap:10px}.nd-read-pos{font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280);margin-left:auto}.nd-read-prefs{display:flex;gap:4px;align-items:center}.nd-read-prefs .nd-btn{padding:2px 7px;font-size:11px}
.nd-reader-scroll{flex:1;min-height:0;overflow-y:auto;scroll-behavior:smooth}.nd-reader-body{max-width:720px;margin:0 auto;padding:26px 30px 80px;line-height:1.95;font-size:15px}.nd-chapter{padding-bottom:30px;margin-bottom:26px;border-bottom:1px solid var(--dsw-alias-border,#e5e7eb)}.nd-chapter:last-child{border-bottom:0}.nd-chapter-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:16px}.nd-ch-num{font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-ch-title{margin:0 0 14px;font-size:19px;line-height:1.5}.nd-ch-title-text{}.nd-ch-title-meta{margin:0 0 14px;font-size:19px;line-height:1.5;border-bottom:1px dashed currentColor;opacity:.72}.nd-ch-words{font-size:11px;color:var(--dsw-alias-fg-muted,#9ca3af);margin-left:auto}.nd-para{margin:0 0 1.05em;text-indent:2em}.nd-hl{background:rgba(250,204,21,.45);border-radius:3px;color:inherit}.nd-plain p{margin:0 0 .9em}.nd-loading-more{padding:16px;text-align:center;font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-search{display:flex;align-items:center;gap:8px;position:relative}.nd-search-input{flex:1}.nd-results{position:absolute;top:34px;left:0;right:0;z-index:5;max-height:300px;overflow-y:auto;padding:6px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg,#fff);box-shadow:0 12px 32px rgba(0,0,0,.18)}.nd-result{display:flex;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}.nd-result:hover{background:var(--dsw-alias-bg-hover,rgba(0,0,0,.05))}.nd-result-ch{flex:none;color:var(--dsw-alias-brand,#2563eb)}.nd-result-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nd-side{display:flex;flex-direction:column;gap:0;min-height:0;overflow-y:auto;border-left:1px solid var(--dsw-alias-border,#e5e7eb);background:var(--dsw-alias-bg-elevated,#fafafa)}.nd-side-sec{padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border,#f0f1f3);font-size:12px}.nd-side-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.nd-side-title{font-size:12px;font-weight:600}.nd-side-sub{display:flex;justify-content:space-between;padding:3px 0;font-size:12px}.nd-side-titleline{display:flex;align-items:center;gap:6px}.nd-actions{display:flex;gap:8px;flex-wrap:wrap}.nd-att{display:flex;flex-direction:column;gap:6px}.nd-att-score{display:flex;align-items:baseline;gap:6px;font-size:12px}.nd-att-score strong{font-size:20px}.nd-att-row{display:grid;grid-template-columns:60px 1fr 48px;align-items:center;gap:8px}.nd-att-label{font-size:11px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-att-val{text-align:right;font-size:11px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-att-empty{font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-edit{display:flex;flex-direction:column;gap:8px;height:100%;padding:12px 18px;box-sizing:border-box}.nd-edit-bar{display:flex;align-items:center;gap:10px;font-size:12px}.nd-edit-title{font-size:13px}.nd-edit-state{color:var(--dsw-alias-fg-muted,#6b7280)}.nd-edit-words{color:var(--dsw-alias-fg-muted,#6b7280)}.nd-editor{flex:1;min-height:420px;width:100%;box-sizing:border-box;padding:16px 18px;overflow-wrap:break-word;word-break:normal;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg,#fff);color:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;line-height:1.9;resize:none}.nd-editor:focus{outline:2px solid var(--dsw-alias-brand-weak,rgba(59,130,246,.35))}
.nd-editor-wrap{position:relative;flex:1;min-height:420px;display:flex;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg,#fff)}
.nd-editor-wrap .nd-editor{flex:1;min-height:0;border:0;border-radius:0;background:transparent;position:relative;z-index:1}
.nd-editor-wrap .nd-editor:focus{outline:0}
.nd-editor-marks{position:absolute;top:0;left:0;bottom:0;right:0;box-sizing:border-box;padding:16px 18px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:break-word;word-break:normal;letter-spacing:normal;tab-size:8;color:transparent;pointer-events:none;overflow:hidden;z-index:0}
.nd-edit-mark-logic{background:rgba(220,38,38,.13);border-radius:3px}
.nd-edit-mark-deai{background:rgba(217,119,6,.15);border-radius:3px}
.nd-edit-hl{background:rgba(250,204,21,.5);color:transparent;border-radius:2px}
.nd-edit-markbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-elevated,#fafafa);border:1px solid var(--dsw-alias-border,#e5e7eb);font-size:12px}
.nd-edit-markchip{border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:999px;padding:2px 8px;background:var(--dsw-alias-bg,#fff);color:inherit;font:inherit;font-size:11px;cursor:pointer}
.nd-edit-markchip-logic{border-color:rgba(220,38,38,.55);box-shadow:inset 0 0 0 1px rgba(220,38,38,.15)}
.nd-edit-markchip-deai{border-color:rgba(217,119,6,.6);box-shadow:inset 0 0 0 1px rgba(217,119,6,.15)}.nd-banner{display:flex;align-items:center;gap:10px;padding:7px 12px;border-radius:8px;font-size:12px}.nd-banner-warn{background:rgba(217,119,6,.14);color:#92400e}.nd-note-pop{position:fixed;z-index:90;width:320px;display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg,#fff);box-shadow:0 18px 48px rgba(0,0,0,.28)}.nd-note-pop-head{font-size:12px;font-weight:600}.nd-note-quote{max-height:64px;overflow-y:auto;padding:6px 8px;border-left:3px solid var(--dsw-alias-brand,#2563eb);background:var(--dsw-alias-bg-elevated,#fafafa);font-size:11px;color:var(--dsw-alias-fg-muted,#4b5563);white-space:pre-wrap}.nd-note-actions{display:flex;justify-content:flex-end;gap:8px}.nd-notes-list{display:flex;flex-direction:column;gap:6px}.nd-note{padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg,#fff);border:1px solid var(--dsw-alias-border,#f0f1f3)}.nd-routes{display:flex;gap:10px;flex-wrap:wrap}.nd-review-list{display:flex;flex-direction:column;gap:10px}.nd-review-row{display:flex;gap:10px;padding:11px 13px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg,#fff);flex:0 0 auto}.nd-review-main{flex:1;display:flex;flex-direction:column;gap:5px;min-width:0}.nd-review-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}.nd-review-issue{font-size:13px}.nd-review-advice{font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-quote{padding:6px 10px;border-left:3px solid var(--dsw-alias-border,#d1d5db);background:var(--dsw-alias-bg-elevated,#fafafa);font-size:12px;color:var(--dsw-alias-fg-muted,#4b5563);white-space:pre-wrap;max-height:120px;overflow-y:auto}.nd-review-actions{display:flex;flex-direction:column;gap:6px;flex:none;align-items:flex-end;position:sticky;top:8px}.nd-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.nd-proposals{display:flex;flex-direction:column;gap:10px}.nd-proposal{flex:0 0 auto;min-width:0}.nd-proposal{border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg,#fff);overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.04)}.nd-proposal-open{border-color:var(--dsw-alias-brand,#2563eb)}.nd-proposal-head{display:flex;align-items:flex-start;gap:8px;padding:11px 14px;cursor:pointer;flex-wrap:wrap}.nd-proposal-title{flex:1 1 220px;min-width:0;font-size:13px;font-weight:600;line-height:1.5;overflow-wrap:anywhere}.nd-proposal-summary{font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280);flex:1;min-width:180px}.nd-proposal-when{font-size:11px;color:var(--dsw-alias-fg-muted,#9ca3af)}.nd-proposal-arrow{color:var(--dsw-alias-fg-muted,#9ca3af)}.nd-proposal-body{display:flex;flex-direction:column;gap:10px;padding:12px 14px 14px;border-top:1px solid var(--dsw-alias-border,#f0f1f3);min-height:0}.nd-proposal-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.nd-diffs{display:flex;flex-direction:column;gap:10px;max-height:min(62vh,680px);overflow-y:auto;padding-right:6px;overscroll-behavior:contain}.nd-diff{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;padding:10px;border-radius:10px;background:var(--dsw-alias-bg-elevated,#fafafa);flex:0 0 auto;border:1px solid var(--dsw-alias-border,#f0f1f3)}.nd-diff-col{display:flex;flex-direction:column;gap:4px;min-width:0}.nd-diff-head{font-size:11px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-diff-why{grid-column:1/-1;font-size:11px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-pre{margin:0;padding:9px 11px;max-height:260px;overflow:auto;border-radius:6px;background:var(--dsw-alias-bg,#fff);border:1px solid var(--dsw-alias-border,#f0f1f3);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word}.nd-gates{display:flex;flex-direction:column;gap:4px}.nd-gate-row{display:flex;align-items:center;gap:8px;font-size:12px}.nd-fixes{display:flex;flex-direction:column;gap:6px}.nd-fix{font-size:12px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-elevated,#fafafa)}.nd-reject{display:flex;gap:6px;align-items:center}.nd-result{padding:8px 10px;border-radius:8px;font-size:12px}.nd-result-ok{background:rgba(22,163,74,.12);color:#15803d}.nd-result-bad{background:rgba(220,38,38,.12);color:#b91c1c}.nd-run-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.nd-run-title{font-size:15px;font-weight:600}.nd-run-meta{font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280);display:flex;gap:10px;flex-wrap:wrap}.nd-run-actions{display:flex;gap:8px;flex-wrap:wrap}.nd-run-grid{display:grid;grid-template-columns:1fr 320px;gap:12px;align-items:start}.nd-budget{display:flex;flex-direction:column;gap:8px;font-size:12px}.nd-budget-row{display:flex;flex-direction:column;gap:4px}.nd-stages{display:flex;flex-direction:column;gap:2px}.nd-stage{display:flex;align-items:center;gap:10px;padding:8px 6px;border-bottom:1px solid var(--dsw-alias-border,#f0f1f3);font-size:12px}.nd-stage:last-child{border-bottom:0}.nd-stage-dot{width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-fg-muted,#d1d5db);flex:none}.nd-stage-done .nd-stage-dot{background:#16a34a}.nd-stage-running .nd-stage-dot{background:var(--dsw-alias-brand,#2563eb);box-shadow:0 0 0 3px var(--dsw-alias-brand-weak,rgba(59,130,246,.25))}.nd-stage-failed .nd-stage-dot{background:#dc2626}.nd-stage-title{flex:1}.nd-entry{display:flex;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:10px}.nd-entry-icon{font-size:18px}.nd-entry-label{font-size:13px;font-weight:600}.nd-entry-meta{font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-map-wrap{display:grid;grid-template-columns:1fr;gap:12px;min-height:0}.nd-map-wrap.nd-map-with-detail{grid-template-columns:minmax(0,1fr) 320px}.nd-map-canvas{position:relative;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-elevated,#fafafa);overflow:hidden}.nd-map-svg{width:100%;height:auto;display:block}.nd-map-bg{fill:var(--dsw-alias-bg,#fff)}.nd-map-line{stroke:var(--dsw-alias-border,#cbd5e1);stroke-width:1.5;stroke-dasharray:5 5}.nd-map-point{fill:var(--dsw-alias-brand,#2563eb);stroke:#fff;stroke-width:2;cursor:pointer}.nd-map-active{fill:#f59e0b}.nd-map-label{font-size:11px;fill:var(--dsw-alias-fg,#111827);pointer-events:none}.nd-map-detail{padding:12px 14px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg,#fff);display:flex;flex-direction:column;gap:8px;font-size:12px;max-height:640px;overflow-y:auto}.nd-map-detail-head{display:flex;align-items:center;gap:8px}.nd-map-note{color:var(--dsw-alias-fg-muted,#6b7280);line-height:1.7}.nd-map-event{display:flex;gap:6px;align-items:center}.nd-map-empty{font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280)}.nd-map-group{display:flex;flex-direction:column;gap:6px}.nd-loc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px}.nd-loc-card{display:flex;flex-direction:column;gap:4px;padding:9px 11px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg,#fff);cursor:pointer;text-align:left;color:inherit;font:inherit}.nd-loc-card:hover{border-color:var(--dsw-alias-brand,#2563eb)}.nd-loc-card.nd-loc-active{border-color:var(--dsw-alias-brand,#2563eb);background:var(--dsw-alias-brand-weak,rgba(59,130,246,.1))}.nd-loc-name{font-size:13px;font-weight:600}.nd-score{font-size:11px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-elevated,#f3f4f6);color:var(--dsw-alias-fg-muted,#4b5563)}.nd-score-ok{background:rgba(22,163,74,.14);color:#15803d}.nd-score-warn{background:rgba(217,119,6,.16);color:#b45309}.nd-errorline{padding:8px 10px;border-radius:8px;background:rgba(220,38,38,.1);color:#b91c1c;font-size:12px}.nd-run-grid .nd-card{min-width:0}
`
    // 独立网页模式：占满整个浏览器视口（不要浮层的留白 / 圆角 / 阴影）。
    const MAP_CSS = `
.nd-mapview .nd-map-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.ndm-toggles{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.ndm-source{margin-left:auto;opacity:.66}
.nd-map-svg{display:block;width:100%;height:auto;max-height:74vh;touch-action:none}
.nd-map-svg text{user-select:none;-webkit-user-select:none}
.nd-map-preview{position:relative;display:block;width:100%;padding:0;border:1px solid rgba(0,0,0,.10);border-radius:10px;background:transparent;overflow:hidden;cursor:zoom-in}
.ndm-zones .ndm-zone{pointer-events:none}
.ndm-pt{cursor:pointer}
.ndm-pt:hover .ndm-pt-hit{opacity:.16}
.ndm-route{pointer-events:none}
.ndm-label,.ndm-zone-label,.ndm-water-label{pointer-events:none}
.ndm-cartouche{position:absolute;left:18px;bottom:16px;max-width:44%;padding:6px 10px;border-radius:6px;background:rgba(255,255,255,.62);box-shadow:0 1px 6px rgba(0,0,0,.06);pointer-events:none}
.ndm-cartouche-title{font-size:15px;font-weight:600;letter-spacing:.04em;line-height:1.25}
.ndm-cartouche-era{font-size:11px;opacity:.72;margin-top:2px;letter-spacing:.02em}
.ndm-cartouche-note{font-size:10px;opacity:.5;margin-top:3px;letter-spacing:.02em}
.ndm-legend{position:absolute;right:18px;bottom:16px;padding:7px 10px;border-radius:6px;background:rgba(255,255,255,.62);box-shadow:0 1px 6px rgba(0,0,0,.06);pointer-events:none;max-width:38%}
.ndm-legend-row{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}
.ndm-legend-item{display:inline-flex;align-items:center;gap:4px;font-size:11px;opacity:.82}
.ndm-legend-glyph{width:13px;height:13px;flex:0 0 auto}
.ndm-legend-foot{font-size:10px;opacity:.55;margin-top:4px;letter-spacing:.02em}
.ndm-coord{font-variant-numeric:tabular-nums;font-size:12px;opacity:.8}
.nd-mapfull-canvas{position:relative}
.nd-mapfull-canvas .nd-map-svg{max-height:none;height:calc(100vh - 190px);cursor:grab}
.nd-mapfull-canvas .nd-map-svg:active{cursor:grabbing}
.nd-mapfull-detail{position:absolute;right:14px;top:14px;max-width:270px}
@media (max-width:900px){.ndm-cartouche,.ndm-legend{position:static;max-width:none;margin-top:8px}}
`

const CSS_EXTRA = `
.nd-proj-label{white-space:nowrap}.nd-proj .nd-select{width:auto;min-width:150px;max-width:280px}
.nd-principle-bar{display:flex;align-items:center;gap:10px;padding:5px 16px;flex:none;border-bottom:1px solid rgba(180,83,9,.22);background:linear-gradient(90deg,rgba(251,191,36,.16),rgba(251,191,36,.05));font-size:12px;color:#92400e;white-space:nowrap;overflow:hidden}
.nd-principle-slogan{font-weight:700;letter-spacing:.02em;color:#b45309}
.nd-principle-text{opacity:.86;overflow:hidden;text-overflow:ellipsis}.nd-outline-list{display:flex;flex-direction:column;gap:6px}.nd-outline-row{padding:8px 10px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg,#fff)}.nd-outline-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.nd-outline-title{font-weight:600}.nd-outline-summary{margin:4px 0 0}.nd-local-list{display:flex;flex-direction:column;gap:4px;margin-top:6px}.nd-local-item{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}.nd-db-entities{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.nd-db-entity{font-size:12px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-elevated,#f3f4f6);color:var(--dsw-alias-fg-muted,#4b5563)}.nd-unknown-list{margin-top:8px}.nd-unknown{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;padding:4px 0}.nd-role-list{display:flex;flex-direction:column;gap:6px;margin-top:6px}.nd-role{font-size:12px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-elevated,#fafafa)}.nd-role p{margin:2px 0 0}.nd-att-points{display:flex;flex-direction:column;gap:6px;margin-top:6px}.nd-att-point{padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-elevated,#fafafa)}.nd-att-point-text{margin:2px 0;font-size:12px}.nd-opinions .nd-card{margin-bottom:12px}.nd-opinion{padding:10px 12px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:10px;margin-bottom:8px;background:var(--dsw-alias-bg,#fff)}.nd-opinion-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;margin-bottom:6px}.nd-opinion-when{color:var(--dsw-alias-fg-muted,#6b7280);margin-left:auto;font-size:11px}.nd-opinion-text{margin:0 0 6px;font-size:13px;white-space:pre-wrap}.nd-opinion-after .nd-pre{max-height:160px}.nd-opinion-actions{display:flex;gap:8px;justify-content:flex-end}.nd-opinion-stale{color:#b45309}.nd-opinion-author-note{margin:4px 0;padding:6px 8px;border-radius:8px;background:rgba(37,99,235,.06);font-size:12px;color:#1d4ed8}.nd-opinion-note-edit{margin:6px 0}.nd-opinion-note-edit .nd-textarea{width:100%}.nd-storage-warn{flex:none;padding:5px 16px;font-size:12px;color:#92400e;background:rgba(217,119,6,.14);border-bottom:1px solid rgba(180,83,9,.22);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nd-hero{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:16px 18px;border:1px solid rgba(180,83,9,.25);border-radius:14px;background:linear-gradient(120deg,rgba(251,191,36,.14),rgba(251,191,36,.03) 55%,rgba(37,99,235,.06));margin-bottom:12px}
.nd-hero-slogan{font-size:17px;font-weight:800;letter-spacing:.03em;color:#b45309}
.nd-hero-sub{margin:6px 0 0;font-size:12px;line-height:1.7;color:var(--dsw-alias-fg-muted,#6b7280);max-width:640px}
.nd-hero-stats{display:flex;gap:18px;flex-wrap:wrap;align-items:center}
.nd-hero-stat{display:flex;flex-direction:column;gap:2px;min-width:76px}
.nd-hero-stat span{font-size:11px;color:var(--dsw-alias-fg-muted,#6b7280)}
.nd-hero-stat strong{font-size:15px}
.nd-attention-note{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid rgba(180,83,9,.28);border-radius:10px;background:rgba(251,191,36,.1);font-size:12px;color:#92400e;flex:none}
.nd-attention-note strong{white-space:nowrap}
.nd-entry-wrap{display:flex;align-items:center;gap:4px}.nd-overlay.nd-standalone{padding:0;background:var(--dsw-alias-bg,#fff)}.nd-overlay.nd-standalone .nd-panel{max-width:none;height:100vh;border:0;border-radius:0;box-shadow:none}.nd-history{display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto;margin-bottom:10px}
.nd-history-row{display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}.nd-history-row:hover{border-color:var(--dsw-alias-brand,#2563eb)}.nd-history-active{border-color:var(--dsw-alias-brand,#2563eb);background:var(--dsw-alias-brand-weak,rgba(59,130,246,.1))}.nd-history-time{font-weight:600;min-width:64px}.nd-history-meta{color:var(--dsw-alias-fg-muted,#6b7280);flex:1}.nd-att .nd-input{max-width:120px}.nd-target{background:rgba(250,204,21,.2);box-shadow:0 0 0 6px rgba(250,204,21,.12);border-radius:6px;transition:background .5s,box-shadow .5s}
.nd-mode-legend{font-size:11px}
.nd-pre-tall{max-height:56vh}
.nd-review-launchers{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
.nd-launch-card{display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg,#fff);color:inherit;font:inherit;text-align:left;cursor:pointer}.nd-launch-card:hover{border-color:var(--dsw-alias-brand,#2563eb);box-shadow:0 4px 14px rgba(37,99,235,.12)}.nd-launch-card:disabled{opacity:.55;cursor:not-allowed}.nd-launch-icon{font-size:20px}.nd-launch-main{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}.nd-launch-main strong{font-size:13px}.nd-launch-go{font-size:12px;color:var(--dsw-alias-brand,#2563eb);white-space:nowrap}

.nd-map-gridline{fill:none;stroke:var(--dsw-alias-border,#e5e7eb);stroke-width:1;opacity:.7}
.nd-map-point{fill:#b91c1c;stroke:#fff;stroke-width:2;cursor:pointer}
.nd-map-point.nd-map-active{fill:#f59e0b}
.nd-map-label{font-size:11px;fill:var(--dsw-alias-fg,#111827);paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-linejoin:round;pointer-events:none}
.nd-map-label.nd-map-label-active{fill:#b45309;font-weight:600}
.nd-map-detail.nd-map-detail-empty{color:var(--dsw-alias-fg-muted,#6b7280)}
.nd-char-groups{display:flex;flex-direction:column;gap:18px}
.nd-char-group-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.nd-field-row{display:flex;align-items:center;gap:8px;margin:8px 0}
.nd-field-row .nd-field-label{font-size:12px;color:var(--dsw-alias-fg-muted,#6b7280);white-space:nowrap}.nd-field-row .nd-input{flex:1;min-width:0}.nd-char-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.nd-char-card{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-left-width:4px;border-radius:10px;background:var(--dsw-alias-bg,#fff);cursor:pointer;text-align:left;color:inherit;font:inherit}
.nd-char-card:hover{border-color:var(--dsw-alias-brand,#2563eb)}
.nd-char-protagonist{border-left-color:#2563eb;background:linear-gradient(180deg,rgba(37,99,235,.07),transparent 60%)}
.nd-char-antagonist{border-left-color:#dc2626;background:linear-gradient(180deg,rgba(220,38,38,.07),transparent 60%)}
.nd-char-supporting{border-left-color:#16a34a;background:linear-gradient(180deg,rgba(22,163,74,.07),transparent 60%)}
.nd-char-minor{border-left-color:#9ca3af}
.nd-char-face{display:flex;align-items:center;gap:8px;min-width:0}
.nd-char-face-main{display:flex;flex-direction:column;gap:1px;min-width:0}
.nd-char-name{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nd-char-role{font-size:11px;color:var(--dsw-alias-fg-muted,#6b7280)}
.nd-char-avatar{width:32px;height:32px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(37,99,235,.14);color:#1d4ed8;font-size:15px;font-weight:600}
.nd-char-avatar-big{width:48px;height:48px;font-size:20px}
.nd-char-avatar-antagonist{background:rgba(220,38,38,.14);color:#b91c1c}
.nd-char-avatar-supporting{background:rgba(22,163,74,.14);color:#15803d}
.nd-char-avatar-minor{background:rgba(107,114,128,.16);color:#4b5563}
.nd-char-line-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;color:var(--dsw-alias-fg-muted,#4b5563);line-height:1.6}
.nd-char-detail{display:flex;flex-direction:column;gap:12px}
.nd-char-detail-head{display:flex;align-items:center;gap:10px}
.nd-char-name-lg{font-size:16px}
.nd-kv-block{display:grid;grid-template-columns:64px 1fr;gap:6px 10px;font-size:13px;line-height:1.7}
.nd-tl-group{display:flex;align-items:center;gap:8px;margin:14px 0 2px;padding-left:2px}
.nd-tl-group:first-child{margin-top:0}
.nd-tl-group-label{font-size:12px;font-weight:600;color:var(--dsw-alias-fg-muted,#4b5563);letter-spacing:.04em}
.nd-tl-group::after{content:'';flex:1;height:1px;background:var(--dsw-alias-border,#f0f1f3)}
.nd-mapview{display:flex;flex-direction:column;gap:10px}.nd-map-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.nd-map-zoom{margin-left:auto;display:flex;align-items:center;gap:6px}.nd-map-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}.nd-map-layout.nd-map-with-detail{grid-template-columns:minmax(0,1fr) 300px}.nd-map-scroll{flex:1;min-height:0;height:70vh;overflow:auto;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-elevated,#fafafa)}.nd-map-scroll .nd-map-svg{display:block;max-width:none}.nd-map-foot{display:flex;justify-content:flex-end}.nd-map-region{filter:blur(5px)}.nd-map-region-label{font-size:10px;fill:#b3aa9b;letter-spacing:.24em;opacity:.55;pointer-events:none}.nd-map-path{fill:none;stroke:#b45309;stroke-width:1.6;stroke-dasharray:7 6;opacity:.62}.nd-map-waypoint{fill:#b45309;opacity:.95}.nd-map-scroll{background:linear-gradient(180deg,#fbfaf7,#f4f1ea)}.nd-map-detail{max-height:none}.nd-mapfull{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;padding:2vh 2vw;background:rgba(15,23,42,.55);backdrop-filter:blur(2px)}.nd-mapfull-panel{display:flex;flex-direction:column;width:min(96vw,1500px);height:94vh;background:var(--dsw-alias-bg,#fff);border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.4);overflow:hidden}.nd-mapfull-head{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border,#e5e7eb)}.nd-mapfull-head .nd-actions{margin-left:auto}.nd-mapfull-canvas{position:relative;flex:1;min-height:0;overflow:hidden;background:linear-gradient(180deg,#fbfaf7,#f2eee5)}.nd-mapfull-canvas .nd-map-svg{width:100%;height:100%;display:block}.nd-mapfull-grab{position:absolute;inset:0;cursor:grab}.nd-mapfull-grab:active{cursor:grabbing}.nd-mapfull-detail{position:absolute;right:14px;top:14px;width:300px;max-height:70%;box-shadow:0 12px 40px rgba(0,0,0,.22)}.nd-mapfull-tip{position:absolute;left:14px;bottom:12px}.nd-map-preview{position:relative;display:block;width:100%;padding:0;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:12px;background:linear-gradient(180deg,#fbfaf7,#f2eee5);cursor:zoom-in;overflow:hidden}.nd-map-preview .nd-map-svg{width:100%;height:auto;display:block}.nd-send-confirm{border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:10px;padding:8px 10px;margin:6px 0;background:var(--dsw-alias-bg-elevated,#fafafa)}
.nd-map-preview{display:block;position:relative;width:100%;padding:0;border:0;background:none;cursor:zoom-in}
.nd-map-preview .nd-map-svg{display:block;width:100%;height:70vh;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-elevated,#fafafa)}
.nd-map-preview-hint{position:absolute;right:12px;bottom:10px;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.85);color:#6b7280;font-size:11px}
.nd-char-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}.nd-char-card{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg,#fff)}.nd-char-card:hover{border-color:var(--dsw-alias-brand,#2563eb)}.nd-char-head{display:flex;align-items:center;gap:10px}.nd-char-avatar{width:38px;height:38px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:50%;background:var(--dsw-alias-brand-weak,rgba(59,130,246,.14));color:var(--dsw-alias-brand,#2563eb);font-size:16px;font-weight:600}.nd-char-namebox{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}.nd-char-line{display:flex;gap:8px;font-size:12px}.nd-char-arc{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.nd-preset-list{display:flex;flex-direction:column;gap:8px}.nd-preset{display:flex;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg,#fff)}.nd-preset-active{border-color:var(--dsw-alias-brand,#2563eb);background:var(--dsw-alias-brand-weak,rgba(59,130,246,.07))}.nd-preset-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}.nd-preset-title{display:flex;align-items:center;gap:8px;font-size:13px}.nd-preset-meta{display:flex;gap:6px;flex-wrap:wrap}.nd-preset-actions{display:flex;flex-direction:column;gap:6px;flex:none}.nd-curve-axis{stroke:var(--dsw-alias-border,#d1d5db);stroke-width:1}.nd-curve-axis-label{fill:var(--dsw-alias-fg-muted,#6b7280);font-size:10px}
.nd-timeline{position:relative;display:flex;flex-direction:column;gap:2px;padding-left:6px}.nd-tl-item{display:flex;gap:12px;padding:10px 4px 10px 0}.nd-tl-dot{position:relative;flex:none;width:11px;height:11px;margin-top:5px;border-radius:50%;background:var(--dsw-alias-border,#cbd5e1);box-shadow:0 0 0 3px var(--dsw-alias-bg,#fff)}.nd-tl-item:not(:last-child) .nd-tl-dot::after{content:'';position:absolute;left:50%;top:14px;width:2px;height:calc(100% + 14px);transform:translateX(-50%);background:var(--dsw-alias-border,#e5e7eb)}.nd-tl-major .nd-tl-dot{background:#d97706}.nd-tl-climax .nd-tl-dot{background:#dc2626}.nd-tl-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}.nd-tl-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}.nd-tl-title{font-weight:600;font-size:13px}.nd-tl-edit{margin-left:auto}.nd-tl-summary{margin:0;font-size:13px;line-height:1.7}
.nd-toc-row{display:flex;align-items:stretch;gap:2px;border-radius:8px}
.nd-toc-row:hover{background:var(--dsw-alias-bg-hover,rgba(0,0,0,.05))}
.nd-toc-row .nd-toc-item{flex:1;min-width:0}
.nd-toc-row:hover .nd-toc-item{background:transparent}
.nd-toc-del{flex:none;padding:0 6px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-fg-muted,#9ca3af);font-size:11px;cursor:pointer;opacity:0;transition:opacity .12s}
.nd-toc-row:hover .nd-toc-del{opacity:1}
.nd-toc-del:hover{color:#dc2626;background:rgba(220,38,38,.12)}
.nd-toc-active-row{background:var(--dsw-alias-brand-weak,rgba(59,130,246,.14))}
.nd-toc-active-row .nd-toc-item{background:transparent}
`
    // 仿纸正文底（0.6.10）：阅读区和正文编辑器共用同一张纸，宽屏窄屏一致。
    // 纸色/墨色都写死成暖色，不跟 DSH 明暗主题走——翻到哪一屏都是「纸上的正文」。
    const PAPER_CSS = `
.nd-overlay{
  --nd-paper:#f7f2e6;
  --nd-paper-ink:#3b352a;
  --nd-paper-muted:#8a7b61;
  --nd-paper-line:rgba(122,98,60,.18);
  --nd-paper-img:radial-gradient(130% 95% at 12% -25%,rgba(255,255,255,.9),rgba(255,255,255,0) 58%),radial-gradient(90% 80% at 104% 6%,rgba(222,199,157,.22),rgba(222,199,157,0) 60%),radial-gradient(70% 55% at 16% 106%,rgba(200,172,124,.16),rgba(200,172,124,0) 62%),repeating-linear-gradient(92deg,rgba(122,98,60,.022) 0 1px,rgba(122,98,60,0) 1px 7px),repeating-linear-gradient(6deg,rgba(122,98,60,.012) 0 1px,rgba(122,98,60,0) 1px 11px)
}
.nd-reader-scroll{background-color:var(--nd-paper);background-image:var(--nd-paper-img);color:var(--nd-paper-ink);box-shadow:inset 0 0 64px rgba(120,96,58,.06)}
/* 审阅要在手机上长按选字：显式允许选中正文（宿主可能给容器设了 user-select:none） */
.nd-reader-body,.nd-reader-body .nd-para{user-select:text;-webkit-user-select:text}
.nd-reader-body .nd-chapter{border-bottom-color:var(--nd-paper-line)}
.nd-reader-body .nd-ch-num,.nd-reader-body .nd-ch-words,.nd-reader-body .nd-muted,.nd-reader-body .nd-loading-more{color:var(--nd-paper-muted)}
.nd-reader-body .nd-hl{background:rgba(214,168,42,.30)}
.nd-reader-body .nd-target{background:rgba(214,168,42,.18);box-shadow:0 0 0 6px rgba(214,168,42,.10)}
.nd-mark-logic{background:rgba(220,38,38,.10);box-shadow:inset 3px 0 0 rgba(220,38,38,.75);border-radius:4px}
.nd-mark-deai{background:rgba(217,119,6,.13);box-shadow:inset 3px 0 0 rgba(217,119,6,.8);border-radius:4px}
.nd-mark-banner{position:sticky;top:0;z-index:3;justify-content:space-between}
.nd-mark .nd-hl{background:rgba(250,204,21,.55)}
.nd-reader-scroll .nd-empty{border-color:var(--nd-paper-line);color:var(--nd-paper-muted)}
.nd-reader-scroll .nd-tag{background:rgba(122,98,60,.10);color:#6f6149}
.nd-reader-scroll .nd-tag-brand{background:rgba(180,83,9,.14);color:#9a3412}
.nd-reader-scroll .nd-tag-ok{background:rgba(22,163,74,.14);color:#15803d}
.nd-reader-scroll .nd-tag-warn{background:rgba(217,119,6,.16);color:#b45309}
.nd-reader-scroll .nd-tag-error{background:rgba(220,38,38,.13);color:#b91c1c}
.nd-edit-bar{color:var(--nd-paper-ink)}
.nd-edit-bar .nd-hint,.nd-edit-bar .nd-edit-state,.nd-edit-bar .nd-edit-words{color:var(--nd-paper-muted)}
.nd-edit-bar .nd-btn:not(.nd-btn-primary){background:rgba(255,255,255,.52);border-color:var(--nd-paper-line);color:var(--nd-paper-ink)}
.nd-edit-bar .nd-btn:not(.nd-btn-primary):hover:not(:disabled){border-color:#8a6f3a}
.nd-editor{max-width:800px;margin:0 auto;padding:14px 34px 30px;background:transparent;border-color:transparent;border-radius:0;color:var(--nd-paper-ink);caret-color:#3b352a;font-family:inherit;resize:none}
.nd-editor:focus{outline:2px solid rgba(122,98,60,.26);outline-offset:-2px}
.nd-editor::placeholder{color:#a99a80}
/* 沉浸模式：正文只留阅读 / 编辑 / 审阅 + 退出，其余外壳全收掉，接近全屏。 */
.nd-overlay.nd-immersive{padding:0;background:var(--dsw-alias-bg,#fff)}
.nd-overlay.nd-immersive .nd-panel{max-width:none;height:100vh;height:100dvh;border:0;border-radius:0;box-shadow:none}
.nd-immersive .nd-top,.nd-immersive .nd-principle-bar,.nd-immersive .nd-nav{display:none}
.nd-immersive .nd-read{display:flex;flex-direction:column}
.nd-immersive .nd-read-main{flex:1;min-height:0}
.nd-immersive .nd-toc,.nd-immersive .nd-side,.nd-immersive .nd-mobile-close{display:none}
.nd-immersive .nd-read-head{padding:6px 12px;background-color:var(--nd-paper);border-bottom:1px solid var(--nd-paper-line)}
.nd-immersive .nd-read-row{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:10px}
.nd-immersive .nd-read-prefs,.nd-immersive .nd-mode-legend,.nd-immersive .nd-read-pos,.nd-immersive .nd-im-toggle,.nd-immersive .nd-read-row .nd-btn{display:none}
.nd-immersive .nd-read-head .nd-search,.nd-immersive .nd-read-head .nd-msg{display:none}
.nd-immersive .nd-im-state{font-size:11px;color:var(--nd-paper-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nd-immersive .nd-seg{justify-self:center;border:1px solid rgba(122,98,60,.30);border-radius:999px;overflow:hidden;background:rgba(255,255,255,.45)}
.nd-immersive .nd-seg-item{color:#4b4334;font-size:13px;padding:5px 18px}
.nd-immersive .nd-seg-item+.nd-seg-item{border-left:1px solid rgba(122,98,60,.22)}
.nd-immersive .nd-seg-item.nd-seg-active{background:#3b352a;color:#f7f2e6}
.nd-im-exit{justify-self:end;display:inline-flex;align-items:center;gap:4px;padding:4px 11px;border:1px solid rgba(122,98,60,.30);border-radius:999px;background:rgba(255,255,255,.5);color:#4b4334;font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.nd-im-exit:hover{background:#3b352a;border-color:#3b352a;color:#f7f2e6}
/* 沉浸模式顶栏左侧：章位 / 保存状态 + 字号 −/+（纯 CSS 字号，不加载字体） */
.nd-im-left{display:flex;align-items:center;gap:10px;min-width:0;justify-self:start}
.nd-im-state{min-width:0}
.nd-im-size{display:inline-flex;align-items:center;gap:2px;flex:none}
.nd-im-size-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid rgba(122,98,60,.30);border-radius:999px;background:rgba(255,255,255,.55);color:#4b4334;font:inherit;font-size:15px;line-height:1;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
.nd-im-size-btn:hover{background:#3b352a;border-color:#3b352a;color:#f7f2e6}
.nd-im-size-btn:active{transform:translateY(1px)}
.nd-im-size-val{min-width:20px;text-align:center;font-size:11px;color:#8a7b61;font-variant-numeric:tabular-nums}
.nd-immersive .nd-reader-body{max-width:820px;padding:30px 36px 100px}
.nd-immersive .nd-edit{padding:0}
.nd-immersive .nd-edit .nd-banner,.nd-immersive .nd-edit .nd-msg{margin:8px 14px 0}
.nd-immersive .nd-editor{max-width:820px;padding:26px 36px 90px}
`
    // 手机 / 窄屏：DSH Remote（dsh-pocket）与本地窄窗口都要能用、能关，
    // 不能因为顶栏溢出把关闭入口裁到屏幕外。
    const MOBILE_CSS = `
.nd-mobile-close{display:none}
@media (max-width: 900px){
  .nd-overlay{padding:0;background:var(--dsw-alias-bg,#fff)}
  .nd-overlay .nd-panel{height:100vh;height:100dvh;max-width:none;border:0;border-radius:0;box-shadow:none}
  .nd-top{flex-wrap:wrap;gap:6px 8px;padding:8px 12px;padding-top:calc(8px + env(safe-area-inset-top,0px))}
  .nd-top-close{display:none}
  .nd-page-name,.nd-top-meta{display:none}
  .nd-brand{gap:6px}.nd-brand strong{font-size:13px}
  .nd-proj{order:3;width:100%}.nd-proj .nd-select{width:100%;min-width:0;max-width:none}
  .nd-top-right{margin-left:auto;gap:4px}.nd-top-right .nd-btn{padding:4px 7px;font-size:11px}
  .nd-principle-bar{white-space:normal;flex-direction:column;align-items:flex-start;gap:3px;padding:6px 12px;font-size:11px;line-height:1.5}
  .nd-principle-slogan{white-space:nowrap}
  .nd-mode-legend{display:none}
  .nd-principle-text{white-space:normal;overflow:visible;text-overflow:clip}
  .nd-body{flex-direction:column}
  .nd-nav{width:100%;flex:none;flex-direction:row;align-items:center;gap:2px;overflow-x:auto;overflow-y:hidden;border-right:0;border-bottom:1px solid var(--dsw-alias-border,#e5e7eb);padding:6px 8px;background:var(--dsw-alias-bg,#fff)}
  .nd-nav-group{display:contents}
  .nd-nav-group > .nd-nav-title{display:none}
  .nd-nav-item{width:auto;flex:none;white-space:nowrap;padding:6px 9px;font-size:12px}
  .nd-main{width:100%}
  .nd-page{padding:10px 12px;gap:10px}
  .nd-page-head{flex-wrap:wrap;gap:8px}
  .nd-page-head h2{font-size:16px}
  .nd-toolbar{gap:6px}
  .nd-read{display:flex;flex-direction:column}
  .nd-toc{flex:none;max-height:138px;border-right:0;border-bottom:1px solid var(--dsw-alias-border,#e5e7eb)}
  .nd-toc-head{padding:6px 10px}.nd-toc-list{display:flex;gap:4px;overflow-x:auto;overflow-y:hidden;padding:4px 6px}
  .nd-toc-item{flex:none;min-width:148px;max-width:230px;padding:6px 8px}
  .nd-toc-foot{display:none}
  .nd-side{display:none}
  .nd-read-head{padding:8px 12px}
  .nd-read-row{flex-wrap:wrap;gap:6px 8px}
  .nd-reader-scroll{flex:1}
  .nd-reader-body{padding:18px 16px 64px}
  .nd-edit{padding:8px 12px}
  .nd-editor{min-height:320px;padding:14px 8px 30px;font-size:14px}
  .nd-immersive .nd-read-head{padding:6px 8px;padding-top:calc(6px + env(safe-area-inset-top,0px))}
  .nd-immersive .nd-read-row{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:'left exit' 'seg seg';gap:6px 8px}
  .nd-immersive .nd-im-left{grid-area:left;justify-self:stretch;gap:8px}
  .nd-immersive .nd-im-state{font-size:10px}
  .nd-immersive .nd-seg{grid-area:seg;justify-self:center}
  .nd-immersive .nd-im-exit{grid-area:exit}
  .nd-immersive .nd-seg-item{padding:5px 13px;font-size:12px}
  .nd-immersive .nd-im-exit{padding:4px 8px}
  .nd-immersive .nd-im-exit-text{display:none}
  .nd-im-size-btn{width:30px;height:30px;font-size:17px}
  .nd-im-size-val{min-width:18px;font-size:10px}
  .nd-immersive .nd-reader-body{padding:18px 16px 76px}
  .nd-immersive .nd-edit{padding:0}
  .nd-immersive .nd-editor{padding:16px 14px 70px}
  .nd-two-col,.nd-run-grid,.nd-map-wrap,.nd-map-layout,.nd-map-layout.nd-map-with-detail,.nd-map-wrap.nd-map-with-detail{grid-template-columns:minmax(0,1fr)}
  .nd-map-scroll{height:52vh}
  .nd-map-preview .nd-map-svg{height:52vh}
  .nd-modal,.nd-modal-wide{width:calc(100vw - 20px);max-height:88dvh}
  .nd-form-grid{grid-template-columns:minmax(0,1fr)}
  .nd-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .nd-hero{padding:12px 14px}
  .nd-hero-stats{gap:10px 16px}.nd-hero-stat{min-width:64px}
  .nd-diff{grid-template-columns:minmax(0,1fr)}
  .nd-mapfull{padding:0}.nd-mapfull-panel{width:100vw;height:100dvh;border-radius:0}
  .nd-mapfull-detail{right:8px;top:8px;width:min(280px,72vw);max-height:56%}
  .nd-note-pop{position:fixed;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));width:auto;max-height:72dvh;overflow-y:auto;z-index:200}
  .nd-mobile-close{display:flex;position:fixed;right:calc(12px + env(safe-area-inset-right,0px));bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:70;width:42px;height:42px;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border,#e5e7eb);border-radius:50%;background:var(--dsw-alias-bg,#fff);color:inherit;box-shadow:0 6px 20px rgba(0,0,0,.22);font-size:17px;cursor:pointer}
}
`
    // ── 注册 ──────────────────────────────────────────────────
    return {
      inject: ['slots'],
      apply(ctx) {
        hostCtx = ctx
        const style = document.createElement('style')
        style.dataset.novelDesk = '1'
        style.textContent = CSS + CSS_EXTRA + PAPER_CSS + MAP_CSS + MOBILE_CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'novel-desk: styles')
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register({ name: 'sidebar.footer.action', id: 'novel-desk', order: 40, label: '小说工作台' }, SidebarEntry),
        )
        // 浏览器标签里注册浮层；只有「显式工作台链接」才自动展开（桌面/手机一致）。
        // DSH Remote 的手机页面没有 #novel-desk=1，保持 DSH 原样，用户点侧栏入口才打开。
        if (IS_BROWSER_TAB) {
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register({ name: 'shell.overlay', id: 'novel-desk', order: 60, label: '小说工作台' }, Workbench),
          )
          if (IS_STANDALONE_TAB) setOpen(true)
        }
      },
    }
  },
})
