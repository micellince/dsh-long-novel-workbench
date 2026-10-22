/**
 * 长篇中文小说工作台 · 客户端
 *
 * 侧栏入口 + 全屏工作台。React 由浏览器模块表提供，无需构建。
 * 结构与数据全部通过同源 /story-desk/api 读写。
 */

window.__ModuleLoader__.load({
  id: 'dsh-long-novel-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    // ── 全局开关 ──────────────────────────────────────────────
    let clientCtx = null
    const ui = { open: false, listeners: new Set() }
    function setOpen(value) {
      ui.open = value
      for (const fn of ui.listeners) fn()
    }
    function useOpen() {
      const [, force] = React.useReducer((x) => x + 1, 0)
      useEffect(() => {
        ui.listeners.add(force)
        return () => ui.listeners.delete(force)
      }, [])
      return ui.open
    }

    // ── 工作台 → 对话 交接 ───────────────────────────────────
    async function sendToChat(payload) {
      const target = payload.newSession === true
      const value = await api('chat.send', { ...payload, newSession: target })
      setOpen(false)
      if ((target || value?.newSession) && value?.sessionId) {
        try {
          clientCtx?.get?.('uiWorkspace')?.openSession(value.sessionId)
        } catch {
          // 新会话已创建并收到消息；打不开视图也不丢
        }
      }
      return value
    }

    // ── 会话目标：清单发到哪个对话 ────────────────────────────
    // DSH 的「当前会话」= 主视图 retain 的那个（宿主自己的 DocumentTitle 也这么判断）
    function sessionSnapshot() {
      try {
        return clientCtx?.get?.('sessions')?.list?.getSnapshot?.() ?? null
      } catch {
        return null
      }
    }
    function sessionTitleOf(sessionId, fromRpc = '') {
      if (fromRpc) return fromRpc
      const state = sessionSnapshot()
      return (sessionId && state?.byId?.[sessionId]?.title) || ''
    }
    function currentMainSessionId() {
      const state = sessionSnapshot()
      const rows = Object.values(state?.byId ?? {}).filter((row) => (row?.retainedBy?.mainView ?? 0) > 0)
      if (rows.length === 0) return ''
      rows.sort((a, b) => (Date.parse(b.updatedAt ?? 0) || 0) - (Date.parse(a.updatedAt ?? 0) || 0))
      return rows[0]?.id ?? ''
    }
    function relativeTime(value) {
      const ms = Date.parse(value ?? '')
      if (!Number.isFinite(ms)) return ''
      const diff = Math.max(0, Date.now() - ms)
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`
      if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`
      return `${Math.round(diff / 86400000)} 天前`
    }

    // ── API ───────────────────────────────────────────────────
    async function api(op, payload = {}) {
      const res = await fetch('/novel-desk/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, ...payload }),
      })
      const data = await res.json().catch(() => null)
      if (!data || data.ok !== true) throw new Error(data?.error?.message || `请求失败（${res.status}）`)
      return data.value
    }

    // ── 基础控件 ──────────────────────────────────────────────
    function Btn({ children, onClick, kind, small, title, disabled, type }) {
      return h(
        'button',
        {
          type: type || 'button',
          className: `sd-btn${kind ? ' sd-btn-' + kind : ''}${small ? ' sd-btn-sm' : ''}`,
          onClick,
          title,
          disabled,
        },
        children,
      )
    }
    function IconBtn({ children, onClick, title }) {
      return h('button', { type: 'button', className: 'sd-iconbtn', onClick, title }, children)
    }
    function Field({ label, hint, children }) {
      return h('label', { className: 'sd-field' }, h('span', { className: 'sd-label' }, label), hint ? h('span', { className: 'sd-hint' }, hint) : null, children)
    }
    function TextInput({ value, onChange, placeholder, type, min, max }) {
      return h('input', {
        className: 'sd-input',
        type: type || 'text',
        value: value ?? '',
        min,
        max,
        placeholder: placeholder || '',
        onChange: (e) => onChange(e.target.value),
      })
    }
    function TextArea({ value, onChange, rows, placeholder }) {
      return h('textarea', {
        className: 'sd-input sd-textarea',
        rows: rows || 3,
        value: value ?? '',
        placeholder: placeholder || '',
        onChange: (e) => onChange(e.target.value),
      })
    }
    function Select({ value, onChange, options }) {
      return h(
        'select',
        { className: 'sd-input', value: value ?? '', onChange: (e) => onChange(e.target.value) },
        options.map((o) => h('option', { key: o.value, value: o.value }, o.label)),
      )
    }
    function Tag({ children, tone }) {
      return h('span', { className: `sd-tag${tone ? ' sd-tag-' + tone : ''}` }, children)
    }
    function Empty({ children }) {
      return h('div', { className: 'sd-empty' }, children)
    }

    // ── 世界 / 地点常量（契约见 docs/WORLD-MODEL.md）───────────
    const WORLD_SCALE_OPTIONS = [
      ['city', '一座城'],
      ['region', '一个地区'],
      ['continent', '一整块大陆'],
      ['realm', '多界 / 天下'],
    ]
    const WORLD_KIND_OPTIONS = [
      ['historical', '现实历史'],
      ['fictional', '架空'],
      ['mixed', '混合'],
    ]
    const LOCATION_TYPES = [
      ['capital', '都城'],
      ['city', '城市'],
      ['town', '城镇'],
      ['village', '村庄'],
      ['pass', '关隘'],
      ['temple', '寺庙'],
      ['mountain', '山岭'],
      ['river', '河流'],
      ['sea', '海域'],
      ['other', '其他'],
    ]
    const LOCATION_TYPE_LABEL = Object.fromEntries(LOCATION_TYPES)
    const LOCATION_TYPE_CLASS = Object.fromEntries(LOCATION_TYPES.map(([value]) => [value, `sd-loc-type-${value}`]))
    const LOCATION_MODE_OPTIONS = [['walk', '步行'], ['horse', '骑马'], ['boat', '行船']]
    const LOCATION_MODE_LABEL = Object.fromEntries(LOCATION_MODE_OPTIONS)
    // 清单一律是 AI 唯一入口：世界页的两个 AI 动作都只「加入清单」。
    const WORLD_CART = {
      build: { kind: 'task', id: 'world-build', task: 'world-build', title: 'AI 生成世界地图' },
      infer: { kind: 'task', id: 'world-infer', task: 'world-infer', title: 'AI 反推地点清单' },
    }
    // 新建作品向导的世界设定选项（城市日常不是 world.kind 契约值，只用于发给 AI 的指令）。
    const CREATE_WORLD_KINDS = [['historical', '现实历史'], ['fictional', '架空'], ['mixed', '混合'], ['urban', '城市日常']]
    const CREATE_WORLD_SCALES = [['city', '城市'], ['region', '地区'], ['continent', '大陆']]

    // ── 注意力（⚡ ATTENTION）常量 ────────────────────────────
    // 每章一条：主类型 + 0–100 总分（冷读实测）+ 目标分 + 四拍 + 弃读点。
    // 伏笔 / 冲突 / 高光不改数据，注意力页按章号实时聚合。
    const ATTENTION_TYPES = [
      ['event', '事件'],
      ['emotion', '情感'],
      ['language', '语言'],
      ['mystery', '悬念'],
      ['relationship', '关系'],
    ]
    const ATTENTION_TYPE_LABEL = Object.fromEntries(ATTENTION_TYPES)
    const ATTENTION_TYPE_CLASS = Object.fromEntries(ATTENTION_TYPES.map(([value]) => [value, `sd-att-c-${value}`]))
    const ATTENTION_VERDICT_OPTIONS = [['会', '会'], ['犹豫', '犹豫'], ['不会', '不会']]
    const ATTENTION_VERDICT_TONE = { 会: 'success', 犹豫: 'warn', 不会: 'error' }
    const ATTENTION_WEAKEST_OPTIONS = [['hook', '钩子'], ['tension', '张力'], ['payoff', '回报'], ['cliff', '章末牵引']]
    const ATTENTION_WEAKEST_LABEL = Object.fromEntries(ATTENTION_WEAKEST_OPTIONS)
    const ATTENTION_STATUS_OPTIONS = [['planned', '计划'], ['drafted', '已写'], ['verified', '已验证']]
    const ATTENTION_STATUS_LABEL = Object.fromEntries(ATTENTION_STATUS_OPTIONS)
    // 四拍：钩子 → 张力 → 回报 → 章末牵引（卡片展示；emotion 是补充字段）
    const ATTENTION_BEATS = [
      ['hook', '钩子', '开篇 3 行内抛出的问题 / 画面'],
      ['tension', '张力', '本章承压点：主角失去 / 被逼什么'],
      ['payoff', '回报', '本章兑现了什么：爽点 / 揭示 / 情绪释放'],
      ['cliff', '章末牵引', '章末留下的未决问题'],
    ]
    // 职责拆分：设计（类型/四拍/读者问题/目标分）由注意力设计师产出，总分由独立审稿人冷读。
    // 老作品补齐设计统一走清单任务（清单是唯一 AI 入口），不直接发对话。
    const ATTENTION_DESIGN_CART = { kind: 'task', id: 'attention-design', task: 'attention-design', title: 'AI 补齐注意力机制（逐章设计）' }
    // 判断「有设计」只看设计字段：type / hook / tension / payoff / cliff 至少两项非空。
    const ATTENTION_DESIGN_FIELDS = ['type', 'hook', 'tension', 'payoff', 'cliff']
    // 一号原则（工作台常驻条 / 总览 hero / 注意力页 / 分工页共用文案）
    const PRINCIPLE_SLOGAN = '⚡ ATTENTION IS ALL YOU NEED'
    const PRINCIPLE_SUB = '怎么吸引读者怎么来 · 一切为读者服务'
    const PRINCIPLE_HINT = '先抓人，再自洽：每章必须有核心注意力；事实自洽是底线，不是目标。'
    const PRINCIPLE_REVIEW_HINT = '评的是读者会不会读下去，不是文笔好不好；低分不是错，是下一章要补强的地方。'
    const PRINCIPLE_AGENTS_LINE = '注意力设计师权重最高（10）：每章先出注意力设计，再谈情节。'

    // ── 整本书流水线（FULLBOOK PIPELINE）常量 ─────────────────
    const PIPELINE_STATUS_META = {
      idle: { label: '未开始', tone: 'muted' },
      preparing: { label: '准备中', tone: 'brand' },
      ready: { label: '已就绪', tone: 'brand' },
      running: { label: '生成中', tone: 'success' },
      paused: { label: '已暂停', tone: 'warn' },
      done: { label: '已完成', tone: 'success' },
      aborted: { label: '已停止', tone: 'error' },
      stuck: { label: '流程卡住', tone: 'warn' },
    }
    const PIPELINE_STAGE_STATUS_META = {
      pending: { icon: '○', label: '待开始', tone: 'muted' },
      running: { icon: '◐', label: '进行中', tone: 'brand' },
      done: { icon: '✓', label: '完成', tone: 'success' },
      failed: { icon: '✕', label: '失败', tone: 'error' },
      skipped: { icon: '−', label: '跳过', tone: 'muted' },
    }
    const PIPELINE_POLL_MS = 10000
    // 收尾阶段：老 pipeline 可能只给 id/kind，没有 name，前端补中文名。
    const PIPELINE_STAGE_NAME = {
      'final-cleanup': '收尾：补齐账本 + 清理残留',
      cleanup: '收尾：补齐账本 + 清理残留',
    }

    // ── 扩写（EXPANSION）常量 ─────────────────────────────────
    const EXPANSION_STATUS_META = {
      idle: { label: '未开始', tone: 'muted' },
      planning: { label: 'AI 出方案中', tone: 'brand' },
      'plan-ready': { label: '方案待确认', tone: 'brand' },
      'waiting-outline': { label: '等待确认大纲', tone: 'warn' },
      structuring: { label: '补地基中', tone: 'brand' },
      running: { label: '扩写中', tone: 'success' },
      paused: { label: '已暂停', tone: 'warn' },
      done: { label: '已完成', tone: 'success' },
      stuck: { label: '流程卡住', tone: 'warn' },
    }
    const EXPANSION_MODE_OPTIONS = [['book', '全部扩写'], ['chapter', '扩写本章']]
    const EXPANSION_ADDITION_OPTIONS = [
      ['subplot', '旁线'],
      ['person', '新人物'],
      ['place', '新地点'],
      ['foreshadow', '新伏笔'],
      ['conflict', '新冲突'],
    ]
    const EXPANSION_POLL_MS = 10000

    // ── 数据类型定义 ──────────────────────────────────────────
    const KIND_META = {
      facts: {
        title: '事实账本',
        icon: '⚖️',
        desc: '记录“谁·什么属性·什么值·从哪一章开始”，同一属性的不同取值会被自动标为冲突。',
        columns: [
          { k: 'subject', t: '主体' },
          { k: 'attribute', t: '属性' },
          { k: 'value', t: '取值' },
          { k: 'chapter', t: '章', w: '60px' },
          { k: 'validFrom', t: '生效区间', w: '96px', format: (v, item) => formatFactRange(item.validFrom, item.validTo) },
        ],
        fields: [
          { k: 'subject', t: '主体', type: 'text', required: true, ph: '人物 / 地点 / 组织 / 物品' },
          { k: 'attribute', t: '属性', type: 'text', required: true, ph: '年龄 / 身份 / 持有物 / 所在地' },
          { k: 'value', t: '取值', type: 'text', required: true },
          { k: 'chapter', t: '首次出现章', type: 'number' },
          { k: 'validFrom', t: '生效章（可选）', type: 'number', ph: '从第几章起有效，空 = 第 1 章' },
          { k: 'validTo', t: '失效章（可选）', type: 'number', ph: '到第几章为止，空 = 一直有效' },
          { k: 'note', t: '备注', type: 'textarea', rows: 2 },
          { k: 'tags', t: '标签', type: 'tags', ph: '逗号分隔' },
        ],
      },
      events: {
        title: '时间线',
        icon: '🕰️',
        desc: '按章推进的事件；故事内时间用于排序，参与人物用于一致性检查。',
        columns: [
          { k: 'chapter', t: '章', w: '60px' },
          { k: 'storyTime', t: '故事时间' },
          { k: 'title', t: '事件' },
          { k: 'location', t: '地点' },
        ],
        fields: [
          { k: 'title', t: '事件', type: 'text', required: true },
          { k: 'chapter', t: '章号', type: 'number' },
          { k: 'storyTime', t: '故事内时间', type: 'text', ph: '如 天宝十五载六月 / 第三日清晨' },
          { k: 'location', t: '地点', type: 'text' },
          { k: 'participants', t: '参与人物', type: 'tags' },
          { k: 'volume', t: '卷（可选）', type: 'text', ph: '如 1 / 第一卷；有值时泳道按卷分道' },
          { k: 'summary', t: '经过', type: 'textarea', rows: 3 },
          { k: 'consequences', t: '后果', type: 'textarea', rows: 2 },
          { k: 'importance', t: '重要度', type: 'select', options: [['normal', '一般'], ['major', '关键'], ['climax', '高潮']] },
        ],
      },
      foreshadow: {
        title: '伏笔',
        icon: '🧩',
        desc: '埋设章 → 回收章。超过计划回收章仍未标为“已回收”会报警。',
        columns: [
          { k: 'title', t: '伏笔' },
          { k: 'setupChapter', t: '埋设', w: '60px' },
          { k: 'payoffChapter', t: '回收', w: '60px' },
          { k: 'status', t: '状态', w: '80px' },
        ],
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
        title: '冲突',
        icon: '⚔️',
        desc: '故事里的核心矛盾：谁和谁、赌注是什么、如何升级、计划何时解决。',
        columns: [
          { k: 'title', t: '冲突' },
          { k: 'type', t: '类型', w: '90px' },
          { k: 'status', t: '状态', w: '80px' },
          { k: 'stakes', t: '赌注' },
        ],
        fields: [
          { k: 'title', t: '冲突', type: 'text', required: true },
          { k: 'type', t: '类型', type: 'select', options: [['internal', '内心'], ['interpersonal', '人际'], ['society', '社会'], ['environment', '环境']] },
          { k: 'parties', t: '相关方', type: 'tags' },
          { k: 'stakes', t: '赌注', type: 'text', ph: '失败会失去什么' },
          { k: 'escalation', t: '升级方式', type: 'textarea', rows: 2 },
          { k: 'status', t: '状态', type: 'select', options: [['active', '进行中'], ['resolved', '已解决'], ['dormant', '潜伏']] },
          { k: 'resolveChapter', t: '计划解决章', type: 'number' },
          { k: 'note', t: '备注', type: 'textarea', rows: 2 },
        ],
      },
      characters: {
        title: '人物',
        icon: '👤',
        desc: '人物卡：目标、动机、缺陷、弧光、关系。人物列表与卡片按重要性排序（主角 > 反派 > 配角 > 龙套，再按出场章数 / 冲突数）；章节里引用但未建卡的人物会被提示。',
        columns: [
          { k: 'name', t: '姓名' },
          { k: 'role', t: '定位', w: '100px' },
          { k: 'goal', t: '目标' },
          { k: 'flaw', t: '缺陷' },
        ],
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
          { k: 'relationships', t: '关系', type: 'tags', ph: '如 华羽生(师徒)、柳含烟(恋人)' },
          { k: 'tags', t: '标签', type: 'tags' },
        ],
      },
      locations: {
        title: '地点',
        icon: '🏙️',
        desc: '世界里的地点：名称 / 别名 / 类型 / 坐标 / 区域 / 首现章 / 连接道路。世界页使用专用地图编辑器（拖拽坐标与连接编辑），这里供其他入口复用简版列表与表单。',
        columns: [
          { k: 'name', t: '地点' },
          { k: 'type', t: '类型', w: '90px', format: (v) => LOCATION_TYPE_LABEL[v] ?? v ?? '其他' },
          { k: 'coords', t: '坐标', w: '96px', format: (v) => (v && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y)) ? `${Number(v.x)}, ${Number(v.y)}` : '—') },
          { k: 'region', t: '区域' },
          { k: 'firstChapter', t: '首现章', w: '70px' },
        ],
        fields: [
          { k: 'name', t: '名称', type: 'text', required: true },
          { k: 'aliases', t: '别名', type: 'tags', ph: '如 京兆府、西京' },
          { k: 'type', t: '类型', type: 'select', options: LOCATION_TYPES },
          { k: 'region', t: '区域', type: 'text', ph: '如 关内道 / 北境' },
          { k: 'firstChapter', t: '首现章', type: 'number' },
          { k: 'note', t: '备注', type: 'textarea', rows: 2 },
        ],
      },
      highlights: {
        title: '高光',
        icon: '✨',
        desc: '收集值得保留的段落：好对白、名场面、反转、情绪爆点。',
        columns: [
          { k: 'chapter', t: '章', w: '60px' },
          { k: 'type', t: '类型', w: '90px' },
          { k: 'text', t: '原文' },
        ],
        fields: [
          { k: 'chapter', t: '章号', type: 'number' },
          { k: 'type', t: '类型', type: 'select', options: [['dialogue', '对白'], ['description', '描写'], ['twist', '反转'], ['emotion', '情绪'], ['action', '动作']] },
          { k: 'text', t: '原文', type: 'textarea', rows: 4, required: true },
          { k: 'note', t: '为什么好', type: 'textarea', rows: 2 },
        ],
      },
      attention: {
        title: '注意力',
        icon: '⚡',
        desc: '每章一条注意力记录：设计（主类型、四拍、读者问题、目标分）由注意力设计师产出（写大纲 / 下一章方案时自动带，老作品用清单补齐）；0–100 总分与详细说明由独立审稿人冷读。伏笔 / 冲突 / 高光按章号自动聚合。',
        columns: [
          { k: 'chapter', t: '章', w: '56px' },
          { k: 'type', t: '类型', w: '76px', format: (v) => ATTENTION_TYPE_LABEL[v] ?? v ?? '—' },
          { k: 'score', t: '总分', w: '60px', format: (v) => (v === '' || v === null || v === undefined ? '—' : String(v)) },
          { k: 'designScore', t: '目标分', w: '64px', format: (v) => (v === '' || v === null || v === undefined ? '—' : String(v)) },
          { k: 'verdict', t: '下一章意愿', w: '84px' },
        ],
        fields: [
          { k: 'chapter', t: '章号', type: 'number', required: true },
          { k: 'type', t: '类型', type: 'select', options: ATTENTION_TYPES },
          { k: 'score', t: '总分（0–100）', type: 'number', ph: '冷读实测；没读过就留空' },
          { k: 'designScore', t: '目标分（0–100）', type: 'number', ph: '设计时定下的目标分' },
          { k: 'verdict', t: '下一章意愿', type: 'select', options: ATTENTION_VERDICT_OPTIONS },
          { k: 'weakest', t: '最弱一环', type: 'select', options: ATTENTION_WEAKEST_OPTIONS },
          { k: 'hook', t: '钩子', type: 'textarea', rows: 2, ph: '开篇 3 行内抛出的问题 / 画面' },
          { k: 'tension', t: '张力', type: 'textarea', rows: 2, ph: '本章承压点：主角失去 / 被逼什么' },
          { k: 'payoff', t: '回报', type: 'textarea', rows: 2, ph: '本章兑现了什么：爽点 / 揭示 / 情绪释放' },
          { k: 'cliff', t: '章末牵引', type: 'textarea', rows: 2, ph: '章末留下的未决问题' },
          { k: 'emotion', t: '情绪（补充）', type: 'textarea', rows: 2, ph: '本章主情绪 / 情绪走向' },
          { k: 'question', t: '读者最想知道', type: 'text', ph: '读到这里，读者最想知道的一句话' },
          { k: 'dropRisk', t: '弃读点（位置 + 原因）', type: 'textarea', rows: 2, ph: '如：第 9 段回忆插叙约 600 字，与当下无关' },
          { k: 'detail', t: '详细说明', type: 'textarea', rows: 6, ph: '四拍逐条给依据、引用原文；最弱一环；弃读点；下一章意愿' },
          { k: 'status', t: '状态', type: 'select', options: ATTENTION_STATUS_OPTIONS },
          { k: 'note', t: '备注', type: 'textarea', rows: 2 },
        ],
      },
      reviews: {
        title: '审稿',
        icon: '📝',
        desc: '人工或 AI 的审稿意见：维度、严重度、问题、建议、状态。可以只处理 blocker/major。',
        columns: [
          { k: 'chapter', t: '章', w: '56px' },
          { k: 'dimension', t: '维度', w: '90px' },
          { k: 'severity', t: '严重度', w: '80px', format: (v) => ({ blocker: '阻断', major: '严重', minor: '一般', suggestion: '建议' }[v] ?? v ?? '—') },
          { k: 'issue', t: '问题' },
          { k: 'status', t: '状态', w: '80px', format: (v) => ({ open: '待处理', fixed: '已修', wontfix: '忽略' }[v] ?? v ?? '待处理') },
        ],
        fields: [
          { k: 'chapter', t: '章号', type: 'number' },
          { k: 'dimension', t: '维度', type: 'select', options: [['情节', '情节'], ['人物', '人物'], ['文笔', '文笔'], ['连续性', '连续性'], ['节奏', '节奏'], ['对话', '对话'], ['世界观', '世界观'], ['主题', '主题'], ['首读', '首读']] },
          { k: 'severity', t: '严重度', type: 'select', options: [['blocker', '阻断'], ['major', '严重'], ['minor', '一般'], ['suggestion', '建议']] },
          { k: 'issue', t: '问题（引用原文）', type: 'textarea', rows: 3, required: true },
          { k: 'suggestion', t: '修改建议', type: 'textarea', rows: 3 },
          { k: 'status', t: '状态', type: 'select', options: [['open', '待处理'], ['fixed', '已修'], ['wontfix', '忽略']] },
          { k: 'source', t: '来源', type: 'text', ph: 'manual / ai' },
        ],
      },
      agents: {
        title: 'Agent 分工',
        icon: '🤖',
        desc: '11 个角色的职责与输入输出。总编派单，各角色按契约产出，审稿与写作上下文都会带上这份分工（含零上下文独立审稿人、权重最高的注意力设计师）。注意力设计师权重最高（10）：每章先出注意力设计，再谈情节。',
        columns: [
          { k: 'order', t: '#', w: '40px' },
          { k: 'weight', t: '权重', w: '56px', render: (item) => agentWeightCell(item.weight) },
          { k: 'name', t: '角色', w: '120px' },
          { k: 'duty', t: '职责' },
          { k: 'outputs', t: '产出' },
        ],
        fields: [
          { k: 'order', t: '顺序', type: 'number' },
          { k: 'name', t: '角色名', type: 'text', required: true },
          { k: 'duty', t: '职责', type: 'textarea', rows: 2 },
          { k: 'inputs', t: '输入', type: 'text' },
          { k: 'outputs', t: '产出', type: 'text' },
        ],
      },
      outlines: {
        title: '章节大纲',
        icon: '🗂️',
        desc: '这本书的章节骨架：每章标题、摘要、节拍、状态。AI 写下一章方案时会优先读这里。',
        columns: [
          { k: 'chapter', t: '章', w: '56px' },
          { k: 'title', t: '标题' },
          { k: 'summary', t: '摘要' },
          { k: 'status', t: '状态', w: '80px', format: (v) => ({ planned: '计划', drafted: '已写', done: '完成' }[v] ?? v ?? '计划') },
        ],
        fields: [
          { k: 'chapter', t: '章号', type: 'number' },
          { k: 'title', t: '标题', type: 'text', required: true },
          { k: 'summary', t: '摘要', type: 'textarea', rows: 3 },
          { k: 'beats', t: '节拍', type: 'lines', ph: '每行一个节拍' },
          { k: 'status', t: '状态', type: 'select', options: [['planned', '计划'], ['drafted', '已写'], ['done', '完成']] },
        ],
      },
      presets: {
        title: '写作预设',
        icon: '🎛️',
        desc: '写作方案：类型、视角、时态、基调、计划章数、每章字数、总字数、结构、风格规则、禁忌、审稿重点。Agent 写作与审稿都会读取。',
        columns: [
          { k: 'name', t: '预设' },
          { k: 'genre', t: '类型' },
          { k: 'pov', t: '视角' },
          { k: 'tone', t: '基调' },
          { k: 'plannedChapters', t: '计划章数', w: '80px' },
        ],
        fields: [
          { k: 'name', t: '预设名称', type: 'text', required: true },
          { k: 'genre', t: '类型', type: 'text', ph: '武侠 / 科幻 / 悬疑 / 言情…' },
          { k: 'pov', t: '视角', type: 'text', ph: '第一人称 / 第三人称限知 / 全知' },
          { k: 'tense', t: '时态', type: 'text', ph: '过去时 / 现在时' },
          { k: 'tone', t: '基调', type: 'text', ph: '冷峻 / 幽默 / 典雅…' },
          { k: 'plannedChapters', t: '计划章数', type: 'number', ph: '如 80' },
          { k: 'chapterWords', t: '每章字数', type: 'number', ph: '如 3000' },
          { k: 'totalWords', t: '总字数', type: 'number', ph: '如 240000' },
          { k: 'structure', t: '结构模板', type: 'textarea', rows: 3, ph: '三幕 + 起承转合：第一幕 20%…' },
          { k: 'reviewFocus', t: '审稿重点', type: 'lines', ph: '每行一条：情节因果 / 人物动机 / 连续性…' },
          { k: 'styleRules', t: '风格规则', type: 'lines', ph: '每行一条，如：禁止心理独白' },
          { k: 'taboo', t: '禁忌', type: 'lines', ph: '每行一条' },
          { k: 'exampleText', t: '示例文本', type: 'textarea', rows: 4 },
        ],
      },
    }

    // 侧边栏分组：页签一个都不删，只重排 + 加组标题（组标题不可点）。
    // 顺序：总览（独立）→ 注意力 → 正文 → 验收 → 工具。
    const NAV_GROUPS = [
      {
        id: 'home',
        label: '',
        tabs: [{ id: 'overview', label: '总览', icon: '📊' }],
      },
      {
        id: 'attention',
        label: '注意力',
        tabs: [
          { id: 'attention', label: '注意力', icon: '⚡' },
          { id: 'foreshadow', label: '伏笔', icon: '🧩' },
          { id: 'conflicts', label: '冲突', icon: '⚔️' },
          { id: 'highlights', label: '高光', icon: '✨' },
        ],
      },
      {
        id: 'body',
        label: '正文',
        tabs: [
          { id: 'chapters', label: '章节', icon: '📄' },
          { id: 'map', label: '地图', icon: '🗺️' },
          { id: 'world', label: '世界', icon: '🌍' },
          { id: 'characters', label: '人物', icon: '👤' },
          { id: 'timeline', label: '时间线', icon: '🕰️' },
          { id: 'facts', label: '事实账本', icon: '⚖️' },
        ],
      },
      {
        id: 'acceptance',
        label: '验收',
        tabs: [
          { id: 'reviews', label: '审稿', icon: '📝' },
          { id: 'proposals', label: '提案', icon: '📥' },
          { id: 'alignment', label: '对齐', icon: '🎯' },
        ],
      },
      {
        id: 'tools',
        label: '工具',
        tabs: [
          { id: 'dashboard', label: '仪表盘', icon: '📈' },
          { id: 'pipeline', label: '整本书', icon: '📚' },
          { id: 'agents', label: '分工', icon: '🤖' },
          { id: 'presets', label: '预设', icon: '🎛️' },
          { id: 'settings', label: '设置', icon: '⚙️' },
        ],
      },
    ]

    // 扁平页签表：保留原有 `TABS` 形状，供需要全量页签的地方使用。
    const TABS = NAV_GROUPS.flatMap((group) => group.tabs)

    /** 侧栏导航：按 NAV_GROUPS 渲染，组标题 `.sd-nav-group` 是分隔行（不可点）。 */
    function Nav({ tab, onPick }) {
      return h('nav', { className: 'sd-nav' }, NAV_GROUPS.map((group, groupIndex) => h(
        React.Fragment,
        { key: group.id || `group-${groupIndex}` },
        group.label ? h('div', { className: 'sd-nav-group' }, group.label) : null,
        group.tabs.map((t) => h('button', {
          key: t.id,
          type: 'button',
          className: `sd-nav-item${tab === t.id ? ' sd-nav-active' : ''}`,
          onClick: () => onPick(t.id),
        }, h('span', { className: 'sd-nav-icon' }, t.icon), h('span', null, t.label))),
      )))
    }

    const STATUS_LABEL = { draft: '草稿', revised: '修订', final: '定稿' }
    const ROLE_LABEL = { protagonist: '主角', antagonist: '反派', supporting: '配角', minor: '龙套' }
    const FOCUS_LABEL = { open: '未回收', paid: '已回收', dropped: '已放弃' }
    const CONFLICT_STATUS = { active: '进行中', resolved: '已解决', dormant: '潜伏' }
    const EVENT_IMPORTANCE = { normal: '一般', major: '关键', climax: '高潮' }

    function displayValue(key, value) {
      if (value === undefined || value === null || value === '') return '—'
      if (Array.isArray(value)) return value.join('、')
      const maps = { status: { ...STATUS_LABEL, ...FOCUS_LABEL, ...CONFLICT_STATUS }, role: ROLE_LABEL, importance: EVENT_IMPORTANCE, type: { internal: '内心', interpersonal: '人际', society: '社会', environment: '环境', dialogue: '对白', description: '描写', twist: '反转', emotion: '情绪', action: '动作' } }
      return maps[key]?.[value] ?? String(value)
    }

    // ── 注意力：取数与统计（纯前端算，不改数据）─────────────────
    function attentionRows(bundle) {
      return (bundle?.attention ?? [])
        .filter((row) => row && Number.isFinite(Number(row.chapter)))
        .slice()
        .sort((a, b) => Number(a.chapter) - Number(b.chapter))
    }
    function attentionHasScore(row) {
      return !!row && row.score !== '' && row.score !== null && row.score !== undefined && Number.isFinite(Number(row.score))
    }
    function attentionHasDesign(row) {
      return !!row && row.designScore !== '' && row.designScore !== null && row.designScore !== undefined && Number.isFinite(Number(row.designScore))
    }
    /** 设计字段是否已填：type/hook/tension/payoff/cliff 至少两项非空。 */
    function attentionHasDesignContent(row) {
      if (!row) return false
      return ATTENTION_DESIGN_FIELDS.filter((key) => String(row[key] ?? '').trim() !== '').length >= 2
    }
    /**
     * 设计 / 实测闭环状态（任务 6 规则）：
     * - 设计 + 实测 → 已闭环（绿）
     * - 只有设计 → 待冷读（蓝）
     * - 只有实测 → 缺设计（黄）
     * - 都没有 → 空白（灰）
     */
    function attentionStatusOf(row) {
      const hasDesign = attentionHasDesignContent(row)
      const hasScore = attentionHasScore(row)
      if (hasDesign && hasScore) return { key: 'closed', label: '已闭环' }
      if (hasDesign) return { key: 'waiting', label: '待冷读' }
      if (hasScore) return { key: 'nodesign', label: '缺设计' }
      return { key: 'blank', label: '空白' }
    }
    function attentionAverage(rows) {
      const values = rows.filter(attentionHasScore).map((row) => Number(row.score))
      if (values.length === 0) return null
      return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    }
    function attentionLowest(rows, count = 3) {
      return rows
        .filter(attentionHasScore)
        .slice()
        .sort((a, b) => Number(a.score) - Number(b.score) || Number(a.chapter) - Number(b.chapter))
        .slice(0, count)
    }
    /** 有正文（content 非空）但还没有 attention 记录的章节，按章号升序。 */
    function attentionUnmarkedChapters(bundle) {
      const marked = new Set(attentionRows(bundle).map((row) => Number(row.chapter)))
      return [...(bundle?.chapters ?? [])]
        .filter((chapter) => String(chapter.content ?? '').trim().length > 0 && !marked.has(Number(chapter.id)))
        .sort((a, b) => Number(a.id) - Number(b.id))
    }
    /**
     * 疲劳 / 骤降预警（不花 token 的纯前端规则）：
     * - 同一主类型连续 > 3 章（章号必须连续）
     * - 相邻章总分下降 ≥ 15
     */
    function attentionWarnings(rows) {
      const list = []
      let runType = ''
      let runLength = 0
      let runStart = null
      let prevChapter = null
      for (const row of rows) {
        const chapter = Number(row.chapter)
        const type = row.type || ''
        const sameRun = !!type && type === runType && prevChapter !== null && chapter === prevChapter + 1
        if (sameRun) runLength += 1
        else {
          runType = type
          runLength = type ? 1 : 0
          runStart = chapter
        }
        prevChapter = chapter
        if (runLength === 4) {
          list.push({ kind: 'fatigue', text: `第 ${runStart}–${chapter} 章连续 ${runLength} 章都是「${ATTENTION_TYPE_LABEL[runType] ?? runType}」型，换一换主类型` })
        }
      }
      for (let index = 1; index < rows.length; index += 1) {
        const prev = rows[index - 1]
        const curr = rows[index]
        if (Number(curr.chapter) !== Number(prev.chapter) + 1) continue
        if (!attentionHasScore(prev) || !attentionHasScore(curr)) continue
        const drop = Number(prev.score) - Number(curr.score)
        if (drop >= 15) list.push({ kind: 'drop', text: `第 ${prev.chapter} → ${curr.chapter} 章骤降 ${drop} 分（${prev.score} → ${curr.score}）` })
      }
      return list
    }
    function attentionStats(bundle) {
      const rows = attentionRows(bundle)
      return {
        rows,
        scored: rows.filter(attentionHasScore),
        average: attentionAverage(rows),
        lowest: attentionLowest(rows, 3),
        unmarked: attentionUnmarkedChapters(bundle),
        warnings: attentionWarnings(rows),
      }
    }
    /** 按章号聚合子项：伏笔（埋 / 收）、冲突（本章引爆）、高光（本章）。 */
    function attentionSubItems(bundle, chapter) {
      const target = Number(chapter)
      const isChapter = (value) => value !== undefined && value !== null && value !== '' && Number(value) === target
      const foreshadow = bundle?.foreshadow ?? []
      return {
        plants: foreshadow.filter((row) => isChapter(row.setupChapter)),
        payoffs: foreshadow.filter((row) => isChapter(row.payoffChapter)),
        conflicts: (bundle?.conflicts ?? []).filter((row) => isChapter(row.resolveChapter)),
        highlights: (bundle?.highlights ?? []).filter((row) => isChapter(row.chapter)),
      }
    }
    /** 分数分档配色：0–39 读不下去 / 40–59 平淡 / 60–79 合格 / 80–100 强吸引。 */
    function attentionScoreTone(score) {
      if (score === null || score === undefined || !Number.isFinite(Number(score))) return ''
      const value = Number(score)
      if (value < 40) return ' sd-att-tone-low'
      if (value < 60) return ' sd-att-tone-mid'
      if (value < 80) return ' sd-att-tone-ok'
      return ' sd-att-tone-top'
    }
    /** 分工页「权重」单元格：weight=10 用品牌色小徽章标出。 */
    function agentWeightCell(weight) {
      const empty = weight === undefined || weight === null || weight === ''
      const value = empty ? null : Number(weight)
      if (value === 10) return h('span', { className: 'sd-weight sd-weight-hi', title: '最高权重角色（注意力设计师）· 第一优先级' }, '10')
      return h('span', { className: 'sd-weight', title: '权重越高，派单与汇总越靠前' }, empty || !Number.isFinite(value) ? '—' : String(value))
    }

    // ── 编辑器 ────────────────────────────────────────────────
    function EntityEditor({ kind, item, projectId, onClose, onSaved }) {
      const meta = KIND_META[kind]
      const [form, setForm] = useState(() => ({ ...item }))
      const [busy, setBusy] = useState(false)
      const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

      const save = async () => {
        const missing = meta.fields.filter((f) => f.required && !String(form[f.k] ?? '').trim())
        if (missing.length > 0) {
          window.alert(`请填写：${missing.map((f) => f.t).join('、')}`)
          return
        }
        setBusy(true)
        try {
          await api('entity.upsert', { projectId, kind, item: cleanEntityPayload(kind, form) })
          onSaved()
          onClose()
        } catch (error) {
          window.alert(error.message)
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'sd-modal-mask', onClick: (e) => e.target === e.currentTarget && onClose() },
        h(
          'div',
          { className: 'sd-modal' },
          h('div', { className: 'sd-modal-head' }, h('strong', null, `${item.id ? '编辑' : '新增'} · ${meta.title}`), h(IconBtn, { onClick: onClose, title: '关闭' }, '✕')),
          h(
            'div',
            { className: 'sd-modal-body' },
            h('div', { className: 'sd-form' }, meta.fields.map((f) => h(Field, { key: f.k, label: f.t + (f.required ? ' *' : '') }, renderInput(f, form, set)))),
          ),
          h('div', { className: 'sd-modal-foot' }, h(Btn, { onClick: onClose }, '取消'), h(Btn, { kind: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存')),
        ),
      )
    }

    function renderInput(field, form, set) {
      const value = form[field.k]
      if (field.type === 'textarea') return h(TextArea, { value, rows: field.rows || 3, placeholder: field.ph, onChange: (v) => set(field.k, v) })
      if (field.type === 'select') {
        const options = field.options.map(([v, label]) => ({ value: v, label }))
        return h(Select, { value: value || field.options[0][0], options, onChange: (v) => set(field.k, v) })
      }
      if (field.type === 'tags') {
        const text = Array.isArray(value) ? value.join('、') : value ?? ''
        return h(TextInput, { value: text, placeholder: field.ph, onChange: (v) => set(field.k, v.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)) })
      }
      if (field.type === 'lines') {
        const text = Array.isArray(value) ? value.join('\n') : value ?? ''
        return h(TextArea, { value: text, rows: 3, placeholder: field.ph, onChange: (v) => set(field.k, v.split('\n').map((s) => s.trim()).filter(Boolean)) })
      }
      if (field.type === 'number') return h(TextInput, { value, type: 'number', placeholder: field.ph, onChange: (v) => set(field.k, v === '' ? '' : Number(v)) })
      return h(TextInput, { value, placeholder: field.ph, onChange: (v) => set(field.k, v) })
    }

    // ── 零上下文首读（第 10 个角色：独立审稿人）───────────────
    function sortedChapterRows(bundle) {
      return [...(bundle?.chapters ?? [])].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
    }

    /**
     * 独立审稿人高亮卡：不依赖 agents 记录是否存在，任何情况下都显示。
     * compact = true 时是总览页的紧凑入口（单章固定最后一章，另给「全书」按钮）。
     * 发送后由 sendToChat 负责关面板/开新会话；这里只拼 payload，不拼 prompt。
     */
    function FreshReadCard({ bundle, projectId, compact = false }) {
      const chapters = sortedChapterRows(bundle)
      const last = chapters.length > 0 ? chapters[chapters.length - 1] : null
      const lastId = last ? String(last.id) : ''
      const [picked, setPicked] = useState(lastId)
      const [scope, setScope] = useState('chapter')
      const [busy, setBusy] = useState(false)
      useEffect(() => setPicked(lastId), [lastId])
      const totalChars = chapters.reduce((n, c) => n + String(c.content ?? '').length, 0)
      const isBook = scope === 'book'
      const target = compact ? lastId : picked
      const label = (chapter) => `第 ${Number(chapter.id)} 章 · ${chapter.title || '未命名'}`
      const rangeText = chapters.length === 0
        ? '这本书还没有章节'
        : `全书 ${chapters.length} 章 · ${(totalChars / 10000).toFixed(1)} 万字`
      const bookHint = totalChars > 100000 ? '，会拆成多批由子 Agent 分别读，耗时与费用更高' : ''
      const send = async (nextScope) => {
        const useBook = nextScope === 'book'
        if (!useBook && !target) return
        if (useBook && chapters.length === 0) return
        setBusy(true)
        try {
          await sendToChat({
            projectId,
            task: 'fresh-read',
            scope: useBook ? 'book' : 'chapter',
            ...(useBook ? {} : { chapter: Number(target) }),
            newSession: true,
          })
        } catch (error) {
          window.alert(`带正文进新会话失败：${error.message}`)
        } finally {
          setBusy(false)
        }
      }
      const options = chapters.map((c) => ({ value: String(c.id), label: label(c) }))
      if (compact) {
        return h('div', { className: 'sd-fresh sd-fresh-compact sd-mt' },
          h('span', { className: 'sd-fresh-badge' }, '零上下文'),
          h('div', { className: 'sd-fresh-compact-text' },
            h('strong', null, '零上下文首读'),
            h('span', { className: 'sd-hint' }, last ? '不读账本/大纲/人物卡，只拿正文，模拟第一次读到它的读者。' : '这本书还没有章节，写完第 1 章就能发首读。')),
          h(Btn, {
            small: true,
            disabled: !last || busy,
            onClick: () => send('chapter'),
            title: last ? `${label(last)}` : '还没有章节',
          }, busy ? '发送中…' : '首读最后一章'),
          h(Btn, {
            kind: 'primary',
            small: true,
            disabled: chapters.length === 0 || busy,
            onClick: () => send('book'),
            title: rangeText,
          }, busy ? '发送中…' : '首读全书'))
      }
      return h('div', { className: 'sd-fresh' },
        h('div', { className: 'sd-fresh-head' },
          h('span', { className: 'sd-fresh-badge' }, '零上下文'),
          h('strong', { className: 'sd-fresh-title' }, '独立审稿人 · 零上下文首读'),
          h('span', { className: 'sd-fresh-rank' }, '分工表第 10 位')),
        h('p', { className: 'sd-fresh-desc' }, '不读账本 / 预设 / 大纲 / 人物卡，只拿正文，模拟第一次读到的读者，给综合意见；可分岔路 / 弃读点。单章看这一章抓不抓人，全书看整体能不能读下去。'),
        h('div', { className: 'sd-fresh-actions' },
          h(ViewToggle, {
            value: scope,
            onChange: setScope,
            options: [{ value: 'chapter', label: '读一章' }, { value: 'book', label: '读全书' }],
          }),
          isBook
            ? h('span', { className: 'sd-fresh-pick-label' }, rangeText + bookHint)
            : h('label', { className: 'sd-fresh-pick' },
                h('span', { className: 'sd-fresh-pick-label' }, '选一章'),
                h('select', {
                  className: 'sd-input sd-fresh-select',
                  value: picked,
                  disabled: chapters.length === 0,
                  title: chapters.length === 0 ? '还没有章节' : '选择要首读的章节',
                  onChange: (e) => setPicked(e.target.value),
                }, options.map((o) => h('option', { key: o.value, value: o.value }, o.label)))),
          h(Btn, { kind: 'primary', disabled: chapters.length === 0 || busy, onClick: () => send(scope) },
            busy ? '发送中…' : isBook ? '带全书进新会话 ▸' : '带这章进新会话 ▸'),
          chapters.length === 0 ? h('span', { className: 'sd-hint' }, '这本书还没有章节，先写完第 1 章再发首读。') : null),
      )
    }

    // ── 通用数据页 ─────────────────────────────────────────────
    function EntityTab({ kind, bundle, projectId, onChanged, onAddCart }) {
      const meta = KIND_META[kind]
      const [editing, setEditing] = useState(null)
      const [mode, setMode] = useState('list')
      const [detailId, setDetailId] = useState(null)
      const items = bundle[kind] ?? []
      const isCharacters = kind === 'characters'
      const listItems = isCharacters ? sortCharactersByImportance(items, bundle) : items
      const detail = isCharacters && detailId !== null ? items.find((item) => String(item.id) === String(detailId)) : null
      const grid = meta.columns.map((c) => c.w || '1fr').join(' ') + (isCharacters ? ' 136px' : ' 96px')

      const remove = async (item) => {
        if (!window.confirm(`删除这条${meta.title}？\n${item.title || item.name || item.id}`)) return
        try {
          await api('entity.delete', { projectId, kind, entityId: item.id })
          onChanged()
        } catch (error) {
          window.alert(error.message)
        }
      }

      return h(
        'div',
        { className: 'sd-page' },
        h(
          'div',
          { className: 'sd-pagehead' },
          h('div', null, h('h2', { className: 'sd-h2' }, meta.icon + ' ' + meta.title), h('p', { className: 'sd-desc' }, meta.desc)),
          h(
            'div',
            { className: 'sd-pagehead-actions' },
            isCharacters
              ? h(ViewToggle, { value: mode, onChange: setMode, options: [{ value: 'list', label: '列表' }, { value: 'card', label: '卡片' }, { value: 'graph', label: '关系图' }] })
              : kind === 'facts'
                ? h(ViewToggle, { value: mode, onChange: setMode, options: [{ value: 'list', label: '平表' }, { value: 'subject', label: '按主体' }] })
                : kind === 'conflicts'
                  ? h(ViewToggle, { value: mode, onChange: setMode, options: [{ value: 'list', label: '平表' }, { value: 'party', label: '按参与方' }] })
                  : kind === 'foreshadow'
                    ? h(ViewToggle, { value: mode, onChange: setMode, options: [{ value: 'list', label: '平表' }, { value: 'arc', label: '按回收段' }] })
                    : null,
            onAddCart && ['characters', 'foreshadow', 'highlights', 'facts', 'events', 'conflicts', 'outlines'].includes(kind)
              ? h(Btn, { onClick: () => onAddCart({ kind: 'task', id: `enrich-${kind}`, task: `enrich-${kind}`, title: `AI 丰富${meta.title}` }) }, `＋ 加入清单：AI 丰富${meta.title}`)
              : null,
            h(Btn, { kind: 'primary', onClick: () => setEditing({}) }, '＋ 新增'),
          ),
        ),
        kind === 'agents'
          ? h('p', { className: 'sd-principle-inline' },
              h('strong', null, PRINCIPLE_SLOGAN),
              h('span', null, PRINCIPLE_AGENTS_LINE))
          : null,
        kind === 'agents' ? h(FreshReadCard, { bundle, projectId }) : null,
        kind === 'facts' && mode === 'subject'
          ? h(FactsBySubject, { bundle, projectId, onChanged })
          : kind === 'conflicts' && mode === 'party'
          ? h(ConflictsByParty, { bundle, projectId, onChanged })
          : kind === 'foreshadow' && mode === 'arc'
          ? h(ForeshadowByArc, { bundle, projectId, onChanged })
          : isCharacters && mode === 'card'
          ? h(CharacterCards, { characters: items, bundle, onOpenDetail: (character) => setDetailId(character.id) })
          : isCharacters && mode === 'graph'
          ? h(RelationshipGraph, { characters: items, onEdit: (item) => setEditing(item), onCreate: (name) => setEditing({ name }) })
          : listItems.length === 0
          ? h(Empty, null, `还没有${meta.title}记录。点右上角「新增」开始。`)
          : h(
              'div',
              { className: 'sd-table' },
              h('div', { className: 'sd-row sd-row-head', style: { gridTemplateColumns: grid } }, meta.columns.map((c) => h('div', { key: c.k }, c.t)), h('div', { className: 'sd-actions-col' }, '操作')),
              listItems.map((item) =>
                h(
                  'div',
                  { key: item.id, className: `sd-row${kind === 'agents' && Number(item.weight) >= 10 ? ' sd-row-hi' : ''}`, style: { gridTemplateColumns: grid } },
                  meta.columns.map((c) => {
                    if (c.render) return h('div', { key: c.k, className: 'sd-cell' }, c.render(item))
                    const text = c.format ? String(c.format(item[c.k], item)) : displayValue(c.k, item[c.k])
                    return h('div', { key: c.k, className: 'sd-cell', title: text }, text)
                  }),
                  h(
                    'div',
                    { className: 'sd-row-actions' },
                    isCharacters ? h(Btn, { small: true, onClick: () => setDetailId(item.id) }, '详情') : null,
                    h(Btn, { small: true, onClick: () => setEditing(item) }, '编辑'),
                    h(Btn, { small: true, kind: 'danger', onClick: () => remove(item) }, '删除'),
                  ),
                ),
              ),
            ),
        detail ? h(CharacterDetail, { character: detail, bundle, projectId, onClose: () => setDetailId(null), onSaved: onChanged }) : null,
        editing !== null ? h(EntityEditor, { kind, item: editing, projectId, onClose: () => setEditing(null), onSaved: onChanged }) : null,
      )
    }

    // ── 事实账本：按主体合并（避免几十条事实散成一张平表）────────
    /** 纯函数：把事实按主体分组；query 命中主体/属性/取值。 */
    function groupFactsBySubject(facts, query = '') {
      const keyword = String(query ?? '').trim().toLowerCase()
      const groups = new Map()
      for (const fact of facts ?? []) {
        const subject = String(fact.subject ?? '').trim() || '未署名'
        const attribute = String(fact.attribute ?? '').trim() || '未署名属性'
        const haystack = `${subject} ${attribute} ${fact.value ?? ''} ${fact.note ?? ''}`.toLowerCase()
        if (keyword && !haystack.includes(keyword)) continue
        if (!groups.has(subject)) groups.set(subject, { subject, attributes: new Map(), count: 0, latestChapter: 0 })
        const group = groups.get(subject)
        if (!group.attributes.has(attribute)) group.attributes.set(attribute, [])
        group.attributes.get(attribute).push(fact)
        group.count += 1
        group.latestChapter = Math.max(group.latestChapter, Number(fact.chapter) || Number(fact.validFrom) || 0)
      }
      return [...groups.values()].sort((a, b) => b.latestChapter - a.latestChapter || b.count - a.count || a.subject.localeCompare(b.subject, 'zh'))
    }

    function FactsBySubject({ bundle, projectId, onChanged }) {
      const [query, setQuery] = useState('')
      const [open, setOpen] = useState(() => new Set())
      const [editing, setEditing] = useState(null)
      const facts = bundle.facts ?? []
      const groups = groupFactsBySubject(facts, query)
      const conflictKeys = new Set((bundle.checks ?? [])
        .filter((check) => String(check.id || '').startsWith('fact-conflict:'))
        .map((check) => String(check.id).slice('fact-conflict:'.length)))
      const subjectConflicts = (group) => [...group.attributes.keys()].some((attribute) => conflictKeys.has(`${group.subject}::${attribute}`))
      const toggle = (subject) => setOpen((prev) => {
        const next = new Set(prev)
        if (next.has(subject)) next.delete(subject)
        else next.add(subject)
        return next
      })
      const allOpen = groups.length > 0 && groups.every((group) => open.has(group.subject))
      const toggleAll = () => setOpen(allOpen ? new Set() : new Set(groups.map((group) => group.subject)))
      const remove = async (fact) => {
        if (!window.confirm(`删除这条事实？
${fact.subject ?? ''} · ${fact.attribute ?? ''} = ${fact.value ?? ''}`)) return
        try {
          await api('entity.delete', { projectId, kind: 'facts', entityId: fact.id })
          onChanged()
        } catch (error) {
          window.alert(error.message)
        }
      }
      const renderFactRow = (fact) => h('div', { key: fact.id, className: 'sd-facts-row' },
        h('div', { className: 'sd-facts-value' }, String(fact.value ?? '—')),
        h('div', { className: 'sd-facts-chapter' }, fact.chapter ? `第 ${fact.chapter} 章` : '—'),
        h('div', { className: 'sd-facts-range' }, formatFactRange(fact.validFrom, fact.validTo)),
        h('div', { className: 'sd-facts-note', title: fact.note ?? '' }, String(fact.note ?? '')),
        h('div', { className: 'sd-facts-actions' },
          h(Btn, { small: true, onClick: () => setEditing(fact) }, '编辑'),
          h(Btn, { small: true, kind: 'danger', onClick: () => remove(fact) }, '删除')))
      if (facts.length === 0) return h(Empty, null, '还没有事实记录。点右上角「新增」或「加入清单：AI 丰富事实账本」。')
      return h('div', { className: 'sd-facts-wrap' },
        h('div', { className: 'sd-facts-toolbar' },
          h('input', { className: 'sd-input sd-facts-search', value: query, placeholder: '搜索主体 / 属性 / 取值…', onChange: (e) => setQuery(e.target.value) }),
          h('span', { className: 'sd-hint' }, `${facts.length} 条事实 · ${groups.length} 个主体`),
          h('div', { className: 'sd-facts-toolbar-actions' },
            h(Btn, { small: true, onClick: toggleAll }, allOpen ? '收起全部' : '展开全部'),
            h(Btn, { small: true, kind: 'primary', onClick: () => setEditing({}) }, '＋ 新增'))),
        groups.length === 0
          ? h(Empty, null, '没有匹配的事实。')
          : groups.map((group) => {
              const isOpen = open.has(group.subject)
              const hasConflict = subjectConflicts(group)
              return h('div', { key: group.subject, className: `sd-facts-group${hasConflict ? ' sd-facts-group-conflict' : ''}` },
                h('button', { type: 'button', className: 'sd-facts-head', onClick: () => toggle(group.subject) },
                  h('span', { className: 'sd-facts-caret' }, isOpen ? '▾' : '▸'),
                  h('span', { className: 'sd-facts-subject' }, group.subject),
                  h(Tag, { tone: 'muted' }, `${group.count} 条`),
                  group.attributes.size > 1 ? h(Tag, { tone: 'muted' }, `${group.attributes.size} 个属性`) : null,
                  group.latestChapter > 0 ? h(Tag, { tone: 'brand' }, `最近第 ${group.latestChapter} 章`) : null,
                  hasConflict ? h(Tag, { tone: 'error' }, '有冲突') : null,
                  h('span', { className: 'sd-facts-head-hint' }, isOpen ? '收起' : '展开')),
                isOpen ? h('div', { className: 'sd-facts-body' },
                  [...group.attributes.entries()].map(([attribute, rows]) => h('div', { key: attribute, className: 'sd-facts-attr' },
                    h('div', { className: 'sd-facts-attr-head' },
                      h('span', { className: 'sd-facts-attr-name' }, attribute),
                      conflictKeys.has(`${group.subject}::${attribute}`) ? h(Tag, { tone: 'error' }, '取值冲突') : null),
                    h('div', { className: 'sd-facts-rows' }, rows.map(renderFactRow)),
                    h(Btn, { small: true, kind: 'primary', onClick: () => setEditing({ subject: group.subject, attribute }) }, '＋ 加一条'))),
                  h('div', { className: 'sd-facts-group-actions' },
                    h(Btn, { small: true, onClick: () => setEditing({ subject: group.subject }) }, `＋ 新增「${group.subject}」的事实`)))
                  : null)
            }),
        editing !== null ? h(EntityEditor, { kind: 'facts', item: editing, projectId, onClose: () => setEditing(null), onSaved: onChanged }) : null,
      )
    }

    // ── 人物：重要性排序 / 角色配色 / 数据聚合 ─────────────────
    const ROLE_IMPORTANCE = { protagonist: 4, antagonist: 3, supporting: 2, minor: 1 }
    function characterRoleKey(role) {
      return Object.prototype.hasOwnProperty.call(ROLE_IMPORTANCE, role) ? role : 'other'
    }
    /** 出场章节：章节元数据 characters 优先；无命中回退 events.participants。 */
    function characterAppearanceChapters(character, bundle) {
      const name = String(character?.name ?? '').trim()
      const chapters = [...(bundle?.chapters ?? [])].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
      const chapterById = new Map(chapters.map((chapter) => [Number(chapter.id), chapter]))
      const byMeta = name === '' ? [] : chapters.filter((chapter) => relationshipList(chapter.characters).includes(name))
      const byEvents = name === '' ? [] : [...new Set((bundle?.events ?? [])
        .filter((event) => relationshipList(event.participants).includes(name))
        .map((event) => Number(event.chapter))
        .filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b)
      const source = byMeta.length > 0 ? 'chapters' : byEvents.length > 0 ? 'events' : 'none'
      const list = byMeta.length > 0
        ? byMeta.map((chapter) => ({ chapter: Number(chapter.id), title: chapter.title || '' }))
        : byEvents.map((chapter) => ({ chapter, title: chapterById.get(chapter)?.title || '' }))
      return { list, source }
    }
    function characterRelatedFacts(character, bundle) {
      const name = String(character?.name ?? '').trim()
      if (name === '') return []
      return (bundle?.facts ?? []).filter((fact) => String(fact.subject ?? '').trim() === name)
    }
    function characterRelatedConflicts(character, bundle) {
      const name = String(character?.name ?? '').trim()
      if (name === '') return []
      return (bundle?.conflicts ?? []).filter((conflict) => relationshipList(conflict.parties).includes(name))
    }
    function characterRelatedHighlights(character, bundle, appearanceChapters) {
      const name = String(character?.name ?? '').trim()
      if (name === '') return []
      const chapters = appearanceChapters ?? new Set(characterAppearanceChapters(character, bundle).list.map((item) => item.chapter))
      return (bundle?.highlights ?? [])
        .filter((highlight) => chapters.has(Number(highlight.chapter)) && String(highlight.quote ?? highlight.text ?? '').includes(name))
        .slice(0, 5)
    }
    /** 注意力均分：该人物出场章里 bundle.attention 的 score 平均（整数，无则 null）。 */
    function characterAttentionAverage(character, bundle) {
      const chapters = new Set(characterAppearanceChapters(character, bundle).list.map((item) => item.chapter))
      if (chapters.size === 0) return null
      const scores = attentionRows(bundle)
        .filter((row) => chapters.has(Number(row.chapter)) && attentionHasScore(row))
        .map((row) => Number(row.score))
      if (scores.length === 0) return null
      return Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length)
    }
    /**
     * 重要性排序：role 权重（主角 4 > 反派 3 > 配角 2 > 龙套 1 > 其他 0）
     * → 出场章数降序 → 参与冲突数降序 → 名字 zh 排序。
     */
    function characterImportance(character, bundle) {
      return {
        role: ROLE_IMPORTANCE[character?.role] ?? 0,
        appearances: characterAppearanceChapters(character, bundle).list.length,
        conflicts: characterRelatedConflicts(character, bundle).length,
      }
    }
    function sortCharactersByImportance(items, bundle) {
      return [...(items ?? [])].sort((a, b) => {
        const left = characterImportance(a, bundle)
        const right = characterImportance(b, bundle)
        return right.role - left.role
          || right.appearances - left.appearances
          || right.conflicts - left.conflicts
          || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-CN')
      })
    }

    // ── 人物：详情卡 ──────────────────────────────────────────
    const CHARACTER_BASIC_FIELDS = [
      ['goal', '目标'],
      ['motivation', '动机'],
      ['flaw', '缺陷'],
      ['personality', '性格'],
      ['arc', '人物弧光'],
      ['appearance', '外貌'],
      ['age', '年龄'],
      ['gender', '性别'],
      ['note', '备注'],
    ]
    // 详情卡左栏只放这六张字段卡；年龄 / 性别 / 备注在头部 meta 行展示。
    const CHARACTER_CORE_FIELDS = CHARACTER_BASIC_FIELDS.filter(([key]) => ['goal', 'motivation', 'flaw', 'personality', 'arc', 'appearance'].includes(key))

    function CharacterDetail({ character, bundle, projectId, onClose, onSaved }) {
      const [editing, setEditing] = useState(null)
      const name = String(character.name ?? '').trim()
      const roleKey = characterRoleKey(character.role)
      const roleLabel = ROLE_LABEL[character.role] ?? character.role ?? '未定位'
      const appearance = characterAppearanceChapters(character, bundle)
      const appearances = appearance.list
      const appearanceChapters = new Set(appearances.map((item) => item.chapter))
      const relationships = relationshipList(character.relationships)
      const tags = relationshipList(character.tags)
      const facts = characterRelatedFacts(character, bundle)
      const factGroups = new Map()
      for (const fact of facts) {
        const attribute = String(fact.attribute ?? '').trim() || '未署名属性'
        if (!factGroups.has(attribute)) factGroups.set(attribute, [])
        factGroups.get(attribute).push(fact)
      }
      const conflicts = characterRelatedConflicts(character, bundle)
      const highlights = characterRelatedHighlights(character, bundle, appearanceChapters)
      const attentionAverage = characterAttentionAverage(character, bundle)
      const extraMeta = [['年龄', character.age], ['性别', character.gender], ['备注', character.note]]
        .filter(([, value]) => String(value ?? '').trim() !== '')
      const numbers = [
        ['出场章节', String(appearances.length), '章'],
        ['参与冲突', String(conflicts.length), '条'],
        ['相关事实', String(facts.length), '条'],
        ['相关高光', String(highlights.length), '条'],
        ['注意力均分', attentionAverage === null ? '—' : String(attentionAverage), attentionAverage === null ? '' : '/100'],
      ]
      return h('div', { className: 'sd-modal-mask', onClick: (e) => e.target === e.currentTarget && onClose() },
        h('div', { className: 'sd-modal sd-modal-wide sd-char-detail' },
          h('div', { className: `sd-char-detail-head sd-char-role-${roleKey}` },
            h('div', { className: 'sd-char-avatar-lg' }, name.slice(0, 1) || '?'),
            h('div', { className: 'sd-char-detail-ident' },
              h('div', { className: 'sd-char-detail-name' }, name || '未命名人物'),
              h('div', { className: 'sd-char-detail-badges' },
                h('span', { className: 'sd-char-role-badge' }, roleLabel),
                tags.map((value, index) => h(Tag, { key: `${value}-${index}`, tone: 'muted' }, value))),
              extraMeta.length > 0
                ? h('div', { className: 'sd-char-detail-meta' }, extraMeta.map(([label, value]) => h('span', { key: label, className: 'sd-char-detail-meta-item' }, `${label}：${value}`)))
                : null),
            h('div', { className: 'sd-char-detail-actions' },
              h(Btn, { small: true, onClick: () => setEditing(character) }, '编辑'),
              h(IconBtn, { onClick: onClose, title: '关闭' }, '✕'))),
          h('div', { className: 'sd-char-numbers' }, numbers.map(([label, value, unit]) => h('div', { key: label, className: 'sd-char-number' },
            h('div', { className: 'sd-char-number-value' }, value, unit ? h('span', { className: 'sd-char-number-unit' }, unit) : null),
            h('div', { className: 'sd-char-number-label' }, label)))),
          h('div', { className: 'sd-modal-body sd-char-body' },
            h('div', { className: 'sd-char-detail-cols' },
              h('div', { className: 'sd-char-col' },
                h('h3', { className: 'sd-char-section-title' }, '基础'),
                CHARACTER_CORE_FIELDS.map(([key, label]) => h('div', { key, className: 'sd-char-field sd-char-basic-field' },
                  h('div', { className: 'sd-char-field-label' }, label),
                  h('div', { className: 'sd-char-field-value' }, String(character[key] ?? '').trim() || '—')))),
              h('div', { className: 'sd-char-col' },
                h('section', { className: 'sd-char-section' },
                  h('h3', { className: 'sd-char-section-title' }, `关系（${relationships.length}）`),
                  relationships.length === 0
                    ? h('div', { className: 'sd-hint' }, '—')
                    : h('div', { className: 'sd-char-tags' }, relationships.map((value, index) => h(Tag, { key: `${value}-${index}`, tone: 'muted' }, value)))),
                h('section', { className: 'sd-char-section' },
                  h('h3', { className: 'sd-char-section-title' }, `出场章节（${appearances.length}）`),
                  appearances.length === 0
                    ? h('div', { className: 'sd-hint' }, '—')
                    : h('div', { className: 'sd-char-chips' }, appearances.map((item) => h('span', { key: item.chapter, className: 'sd-char-chip', title: item.title || '' },
                        `第 ${item.chapter} 章${item.title ? ` · ${item.title}` : ''}`))),
                  appearance.source === 'events' ? h('div', { className: 'sd-hint' }, '章节元数据没有引用这个名字，以上章号来自事件参与人。') : null),
                h('section', { className: 'sd-char-section' },
                  h('h3', { className: 'sd-char-section-title' }, `相关事实（${facts.length}）`),
                  facts.length === 0
                    ? h('div', { className: 'sd-hint' }, '—')
                    : [...factGroups.entries()].map(([attribute, rows]) => h('div', { key: attribute, className: 'sd-char-fact-group' },
                        h('div', { className: 'sd-char-fact-head' }, attribute, h(Tag, { tone: 'muted' }, `${rows.length} 条`)),
                        rows.map((fact) => h('div', { key: fact.id, className: 'sd-char-fact-row' },
                          h('span', { className: 'sd-char-fact-value' }, String(fact.value ?? '—')),
                          h('span', { className: 'sd-char-fact-meta' }, [
                            fact.chapter ? `第 ${fact.chapter} 章` : '',
                            formatFactRange(fact.validFrom, fact.validTo),
                          ].filter(Boolean).join(' · '))))))),
                h('section', { className: 'sd-char-section' },
                  h('h3', { className: 'sd-char-section-title' }, `相关冲突（${conflicts.length}）`),
                  conflicts.length === 0
                    ? h('div', { className: 'sd-hint' }, '—')
                    : conflicts.map((conflict) => h('div', { key: conflict.id, className: 'sd-char-row' },
                        h('span', { className: 'sd-char-row-main' }, conflict.title || '未命名冲突'),
                        h('span', { className: 'sd-char-row-meta' }, [
                          CONFLICT_STATUS[conflict.status] ?? conflict.status ?? '',
                          displayValue('type', conflict.type),
                          conflict.resolveChapter ? `第 ${conflict.resolveChapter} 章解决` : '',
                        ].filter((value) => value && value !== '—').join(' · '))))),
                h('section', { className: 'sd-char-section' },
                  h('h3', { className: 'sd-char-section-title' }, `相关高光（${highlights.length}）`),
                  highlights.length === 0
                    ? h('div', { className: 'sd-hint' }, '—')
                    : highlights.map((highlight) => h('div', { key: highlight.id, className: 'sd-char-row' },
                        h('span', { className: 'sd-char-row-main' }, String(highlight.quote ?? highlight.text ?? '')),
                        h('span', { className: 'sd-char-row-meta' }, [
                          `第 ${highlight.chapter} 章`,
                          displayValue('type', highlight.type),
                        ].filter((value) => value && value !== '—').join(' · ')))))))),
        ),
        editing !== null ? h(EntityEditor, { kind: 'characters', item: editing, projectId, onClose: () => setEditing(null), onSaved }) : null,
      )
    }

    /** 卡片视图：按重要性排序的游戏风人物卡网格。 */
    function CharacterCards({ characters, bundle, onOpenDetail }) {
      const sorted = sortCharactersByImportance(characters, bundle)
      if (sorted.length === 0) return h(Empty, null, '还没有人物。点右上角「＋ 新增」开始。')
      return h('div', { className: 'sd-charcards' }, sorted.map((character) => {
        const name = String(character.name ?? '').trim()
        const roleKey = characterRoleKey(character.role)
        const relationships = relationshipList(character.relationships).slice(0, 3)
        const tags = relationshipList(character.tags)
        const appearances = characterAppearanceChapters(character, bundle).list.length
        const conflicts = characterRelatedConflicts(character, bundle).length
        const facts = characterRelatedFacts(character, bundle).length
        const attention = characterAttentionAverage(character, bundle)
        return h('button', {
          key: character.id,
          type: 'button',
          className: `sd-char-card sd-char-role-${roleKey}`,
          title: `打开 ${name || '未命名人物'} 的人物卡`,
          onClick: () => onOpenDetail(character),
        },
          h('span', { className: 'sd-char-card-head' },
            h('span', { className: 'sd-char-card-avatar' }, name.slice(0, 1) || '?'),
            h('span', { className: 'sd-char-card-ident' },
              h('span', { className: 'sd-char-card-name' }, name || '未命名人物'),
              h('span', { className: 'sd-char-card-role' }, ROLE_LABEL[character.role] ?? character.role ?? '未定位')),
            h('span', { className: `sd-char-card-att${attention === null ? ' sd-char-card-att-empty' : ''}` }, attention === null ? '⚡ —' : `⚡ ${attention}`)),
          tags.length > 0
            ? h('span', { className: 'sd-char-card-tags' }, tags.map((value, index) => h(Tag, { key: `${value}-${index}`, tone: 'muted' }, value)))
            : null,
          h('span', { className: 'sd-char-card-stats' },
            h('span', null, `出场 ${appearances} 章`),
            h('span', null, `冲突 ${conflicts}`),
            h('span', null, `事实 ${facts}`)),
          relationships.length > 0
            ? h('span', { className: 'sd-char-card-rel' },
                h('span', { className: 'sd-char-card-rel-label' }, '关系'),
                relationships.map((value, index) => h(Tag, { key: `${value}-${index}`, tone: 'muted' }, value)))
            : h('span', { className: 'sd-char-card-rel sd-hint' }, '暂无关系'))
      }))
    }

    // ── 冲突：按参与方合并（平表之外的合并视图）──────────────────
    /** 纯函数：按 parties 组合分组；parties 排序后 join('×')，空值归「未署名参与方」。 */
    function groupConflictsByParty(conflicts, query = '') {
      const keyword = String(query ?? '').trim().toLowerCase()
      const groups = new Map()
      for (const conflict of conflicts ?? []) {
        const parties = relationshipList(conflict.parties).sort((a, b) => a.localeCompare(b, 'zh-CN'))
        const key = parties.length > 0 ? parties.join('×') : '未署名参与方'
        const haystack = [
          conflict.title,
          parties.join(' '),
          displayValue('type', conflict.type),
          conflict.stakes,
          conflict.escalation,
          conflict.note,
        ].filter(Boolean).join(' ').toLowerCase()
        if (keyword && !haystack.includes(keyword)) continue
        if (!groups.has(key)) groups.set(key, { key, parties, items: [] })
        groups.get(key).items.push(conflict)
      }
      return [...groups.values()].sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key, 'zh-CN'))
    }

    function ConflictsByParty({ bundle, projectId, onChanged }) {
      const [query, setQuery] = useState('')
      const [open, setOpen] = useState(() => new Set())
      const [editing, setEditing] = useState(null)
      const conflicts = bundle.conflicts ?? []
      const groups = groupConflictsByParty(conflicts, query)
      const activeOf = (items) => items.filter((item) => item.status === 'active').length
      const resolvedOf = (items) => items.filter((item) => item.status === 'resolved').length
      const toggle = (key) => setOpen((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      const allOpen = groups.length > 0 && groups.every((group) => open.has(group.key))
      const toggleAll = () => setOpen(allOpen ? new Set() : new Set(groups.map((group) => group.key)))
      const remove = async (conflict) => {
        if (!window.confirm(`删除这条冲突？\n${conflict.title || conflict.id}`)) return
        try {
          await api('entity.delete', { projectId, kind: 'conflicts', entityId: conflict.id })
          onChanged()
        } catch (error) {
          window.alert(error.message)
        }
      }
      const renderRow = (conflict) => h('div', { key: conflict.id, className: 'sd-conf-row' },
        h('div', { className: 'sd-conf-row-head' },
          h('strong', { className: 'sd-conf-title' }, conflict.title || '未命名冲突'),
          h(Tag, { tone: 'muted' }, displayValue('type', conflict.type)),
          h(Tag, { tone: conflict.status === 'active' ? 'brand' : 'muted' }, CONFLICT_STATUS[conflict.status] ?? conflict.status ?? '—'),
          conflict.resolveChapter ? h(Tag, { tone: 'muted' }, `第 ${conflict.resolveChapter} 章解决`) : null,
          h('div', { className: 'sd-conf-actions' },
            h(Btn, { small: true, onClick: () => setEditing(conflict) }, '编辑'),
            h(Btn, { small: true, kind: 'danger', onClick: () => remove(conflict) }, '删除'))),
        conflict.stakes ? h('div', { className: 'sd-conf-line' }, h('span', null, '赌注'), String(conflict.stakes)) : null,
        conflict.escalation ? h('div', { className: 'sd-conf-line' }, h('span', null, '升级'), String(conflict.escalation)) : null,
        conflict.note ? h('div', { className: 'sd-conf-line sd-conf-line-note' }, h('span', null, '备注'), String(conflict.note)) : null)
      if (conflicts.length === 0) return h(Empty, null, '还没有冲突记录。点「＋ 新增」或去平表添加。')
      return h('div', { className: 'sd-conf-wrap' },
        h('div', { className: 'sd-conf-toolbar' },
          h('input', { className: 'sd-input sd-conf-search', value: query, placeholder: '搜索标题 / 参与方 / 类型 / 赌注…', onChange: (e) => setQuery(e.target.value) }),
          h('span', { className: 'sd-hint' }, `${conflicts.length} 条冲突 · ${groups.length} 组参与方`),
          h('div', { className: 'sd-conf-toolbar-actions' },
            h(Btn, { small: true, onClick: toggleAll }, allOpen ? '收起全部' : '展开全部'),
            h(Btn, { small: true, kind: 'primary', onClick: () => setEditing({}) }, '＋ 新增'))),
        groups.length === 0
          ? h(Empty, null, '没有匹配的冲突。')
          : groups.map((group) => {
              const isOpen = open.has(group.key)
              return h('div', { key: group.key, className: 'sd-conf-group' },
                h('button', { type: 'button', className: 'sd-conf-head', onClick: () => toggle(group.key) },
                  h('span', { className: 'sd-conf-caret' }, isOpen ? '▾' : '▸'),
                  h('span', { className: 'sd-conf-parties' }, group.key),
                  h(Tag, { tone: 'muted' }, `${group.items.length} 条`),
                  activeOf(group.items) > 0 ? h(Tag, { tone: 'brand' }, `进行中 ${activeOf(group.items)}`) : null,
                  resolvedOf(group.items) > 0 ? h(Tag, { tone: 'muted' }, `已解决 ${resolvedOf(group.items)}`) : null,
                  h('span', { className: 'sd-conf-head-hint' }, isOpen ? '收起' : '展开')),
                isOpen ? h('div', { className: 'sd-conf-body' }, group.items.map(renderRow)) : null)
            }),
        editing !== null ? h(EntityEditor, { kind: 'conflicts', item: editing, projectId, onClose: () => setEditing(null), onSaved: onChanged }) : null,
      )
    }

    // ── 伏笔：按回收段合并（每 10 章一段）──────────────────────
    const FORESHADOW_ARC_SIZE = 10
    function foreshadowArcRange(payoffChapter) {
      const chapter = Number(payoffChapter)
      if (!Number.isFinite(chapter) || chapter <= 0) return null
      const start = Math.floor((chapter - 1) / FORESHADOW_ARC_SIZE) * FORESHADOW_ARC_SIZE + 1
      return { start, end: start + FORESHADOW_ARC_SIZE - 1 }
    }
    /** 纯函数：按回收章所在 10 章段分组；无效/0 归「未定回收」排最后。 */
    function groupForeshadowByArc(items, query = '') {
      const keyword = String(query ?? '').trim().toLowerCase()
      const groups = new Map()
      for (const item of items ?? []) {
        const haystack = `${item.title ?? ''} ${item.plantedText ?? ''} ${item.note ?? ''}`.toLowerCase()
        if (keyword && !haystack.includes(keyword)) continue
        const range = foreshadowArcRange(item.payoffChapter)
        const key = range ? `arc-${range.start}` : 'undecided'
        if (!groups.has(key)) groups.set(key, { key, start: range ? range.start : null, end: range ? range.end : null, items: [] })
        groups.get(key).items.push(item)
      }
      const list = [...groups.values()]
      const decided = list.filter((group) => group.start !== null).sort((a, b) => a.start - b.start)
      const undecided = list.filter((group) => group.start === null)
      return [...decided, ...undecided]
    }

    function ForeshadowByArc({ bundle, projectId, onChanged }) {
      const [query, setQuery] = useState('')
      const [open, setOpen] = useState(() => new Set())
      const [editing, setEditing] = useState(null)
      const foreshadow = bundle.foreshadow ?? []
      const groups = groupForeshadowByArc(foreshadow, query)
      const paidOf = (items) => items.filter((item) => item.status === 'paid').length
      const toggle = (key) => setOpen((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      const allOpen = groups.length > 0 && groups.every((group) => open.has(group.key))
      const toggleAll = () => setOpen(allOpen ? new Set() : new Set(groups.map((group) => group.key)))
      const remove = async (item) => {
        if (!window.confirm(`删除这条伏笔？\n${item.title || item.id}`)) return
        try {
          await api('entity.delete', { projectId, kind: 'foreshadow', entityId: item.id })
          onChanged()
        } catch (error) {
          window.alert(error.message)
        }
      }
      const renderRow = (item) => h('div', { key: item.id, className: 'sd-fore-row' },
        h('div', { className: 'sd-fore-row-head' },
          h('strong', { className: 'sd-fore-title' }, item.title || '未命名伏笔'),
          h(Tag, { tone: item.status === 'paid' ? 'success' : item.status === 'dropped' ? 'muted' : 'brand' }, FOCUS_LABEL[item.status] ?? item.status ?? '未回收'),
          h('span', { className: 'sd-fore-meta' }, [
            item.setupChapter ? `第 ${item.setupChapter} 章` : '未定埋设',
            '→',
            item.payoffChapter ? `第 ${item.payoffChapter} 章` : '未定回收',
          ].join(' ')),
          h('div', { className: 'sd-fore-actions' },
            h(Btn, { small: true, onClick: () => setEditing(item) }, '编辑'),
            h(Btn, { small: true, kind: 'danger', onClick: () => remove(item) }, '删除'))),
        String(item.plantedText ?? '').trim() ? h('div', { className: 'sd-fore-text', title: String(item.plantedText) }, String(item.plantedText)) : null,
        String(item.note ?? '').trim() ? h('div', { className: 'sd-fore-note', title: String(item.note) }, String(item.note)) : null)
      if (foreshadow.length === 0) return h(Empty, null, '还没有伏笔记录。点「＋ 新增」或去平表添加。')
      return h('div', { className: 'sd-fore-wrap' },
        h('div', { className: 'sd-fore-toolbar' },
          h('input', { className: 'sd-input sd-fore-search', value: query, placeholder: '搜索伏笔 / 埋设原文 / 备注…', onChange: (e) => setQuery(e.target.value) }),
          h('span', { className: 'sd-hint' }, `${foreshadow.length} 条伏笔 · ${groups.length} 个回收段`),
          h('div', { className: 'sd-fore-toolbar-actions' },
            h(Btn, { small: true, onClick: toggleAll }, allOpen ? '收起全部' : '展开全部'),
            h(Btn, { small: true, kind: 'primary', onClick: () => setEditing({}) }, '＋ 新增'))),
        groups.length === 0
          ? h(Empty, null, '没有匹配的伏笔。')
          : groups.map((group) => {
              const isOpen = open.has(group.key)
              const paid = paidOf(group.items)
              return h('div', { key: group.key, className: 'sd-fore-group' },
                h('button', { type: 'button', className: 'sd-fore-head', onClick: () => toggle(group.key) },
                  h('span', { className: 'sd-fore-caret' }, isOpen ? '▾' : '▸'),
                  h('span', { className: 'sd-fore-arc' }, group.start === null ? '未定回收' : `第 ${group.start}–${group.end} 章回收`),
                  h(Tag, { tone: 'muted' }, `${group.items.length} 条`),
                  h(Tag, { tone: 'success' }, `已回收 ${paid}`),
                  h(Tag, { tone: 'muted' }, `未回收 ${group.items.length - paid}`),
                  h('span', { className: 'sd-fore-head-hint' }, isOpen ? '收起' : '展开')),
                isOpen ? h('div', { className: 'sd-fore-body' }, group.items.map(renderRow)) : null)
            }),
        editing !== null ? h(EntityEditor, { kind: 'foreshadow', item: editing, projectId, onClose: () => setEditing(null), onSaved: onChanged }) : null,
      )
    }

    // ── 章节页 ────────────────────────────────────────────────
    function DashboardTab({ bundle, projectId }) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const load = useCallback(async () => {
        setBusy(true)
        try {
          const value = await api('usage.summary', { projectId })
          setData(value)
          setError('')
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }, [projectId])
      useEffect(() => { load() }, [load])
      const fmt = (n) => {
        const value = Number(n) || 0
        if (value >= 1000000) return (value / 1000000).toFixed(2) + 'M'
        if (value >= 1000) return (value / 1000).toFixed(1) + 'k'
        return String(value)
      }
      const pct = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0)
      const copySnapshot = async () => {
        const openForeshadow = (bundle.foreshadow ?? []).filter((f) => f.status !== 'paid' && f.status !== 'dropped').length
        const last = (bundle.chapters ?? []).slice(-1)[0]
        const text = [
          `【作品】《${bundle.project.name}》（projectId: ${bundle.project.id}）`,
          `【进度】${bundle.chapters.length} 章 / ${bundle.stats.words} 字`,
          `【账本】人物 ${bundle.characters.length} ｜ 大纲 ${bundle.outlines.length} ｜ 事件 ${bundle.events.length} ｜ 事实 ${bundle.facts.length} ｜ 伏笔 ${bundle.foreshadow.length}（未回收 ${openForeshadow}）`,
          `【待处理】提案 ${bundle.stats.pendingProposals} ｜ 审稿 ${bundle.stats.openReviews}`,
          last ? `【最近一章】第 ${last.id} 章《${last.title}》` : '【最近一章】（还没有章节）',
          '',
          '请用 novel_desk_* 工具读取/操作这个作品；需要写入正文或账本时，先用提案/审稿，等我确认。',
        ].join('\n')
        try {
          await navigator.clipboard.writeText(text)
          window.alert('项目快照已复制。到左侧对话里粘贴，就能带着同一份上下文继续聊。')
        } catch {
          window.prompt('复制下面的项目快照，粘贴到左侧对话：', text)
        }
      }
      const wb = data?.workbench
      const chat = data?.chat
      return h('div', { className: 'sd-page' },
        h('div', { className: 'sd-pagehead' },
          h('div', null, h('h2', { className: 'sd-h2' }, '📊 仪表盘'), h('p', { className: 'sd-desc' }, '这个项目的上下文、两条 AI 通道和 token 消耗。工作台调用是「一次性」，对话是「多轮会话」，两边不共享历史。')),
          h('div', { className: 'sd-pagehead-actions' },
            h(Btn, { onClick: copySnapshot }, '复制项目快照到对话'),
            h(Btn, { onClick: load, disabled: busy }, busy ? '刷新中…' : '刷新'))),
        error ? h('div', { className: 'sd-error sd-error-inline' }, `读取失败：${error}`) : null,
        data ? h('div', null,
          h(WriterStats, { data }),
          h('div', { className: 'sd-hint', style: { marginTop: 6 } }, `当前上下文约 ${fmt(data.context.tokens)} token（${data.context.chars} 字符，${data.context.parts.length} 个区块）`),
          h('div', { className: 'sd-dash-grid' },
            h('div', { className: 'sd-section' },
              h('h3', { className: 'sd-h3' }, '上下文构成'),
              h('div', { className: 'sd-table' },
                h('div', { className: 'sd-row sd-row-head', style: { gridTemplateColumns: '1.4fr 1fr 1fr' } }, h('div', null, '区块'), h('div', null, '字符'), h('div', null, '估算 token')),
                data.context.parts.map((part, i) => h('div', { key: i, className: 'sd-row', style: { gridTemplateColumns: '1.4fr 1fr 1fr' } },
                  h('div', { className: 'sd-cell' }, part.title),
                  h('div', { className: 'sd-cell' }, String(part.chars)),
                  h('div', { className: 'sd-cell' }, fmt(part.tokens)))))),
            h('div', { className: 'sd-section' },
              h('h3', { className: 'sd-h3' }, '工作台消耗 · 按任务'),
              wb.byTask.length === 0 ? h('p', { className: 'sd-hint' }, '还没有工作台 AI 调用记录。生成方案、审阅、按意见修改后这里会出现。') : h('div', { className: 'sd-table' },
                h('div', { className: 'sd-row sd-row-head', style: { gridTemplateColumns: '1.4fr 60px 90px 80px' } }, h('div', null, '任务'), h('div', null, '次数'), h('div', null, 'token'), h('div', null, '耗时')),
                wb.byTask.map((row) => h('div', { key: row.task, className: 'sd-row', style: { gridTemplateColumns: '1.4fr 60px 90px 80px' } },
                  h('div', { className: 'sd-cell' }, row.task),
                  h('div', { className: 'sd-cell' }, String(row.calls)),
                  h('div', { className: 'sd-cell' }, fmt(row.totalTokens)),
                  h('div', { className: 'sd-cell' }, `${(row.durationMs / 1000).toFixed(1)}s`)))))),
          h('div', { className: 'sd-section' },
            h('h3', { className: 'sd-h3' }, '最近工作台调用'),
            wb.recent.length === 0 ? h('p', { className: 'sd-hint' }, '暂无记录。') : h('div', { className: 'sd-table' },
              h('div', { className: 'sd-row sd-row-head', style: { gridTemplateColumns: '110px 1.2fr 90px 90px 70px 60px' } }, h('div', null, '时间'), h('div', null, '任务'), h('div', null, '输入'), h('div', null, '输出'), h('div', null, '耗时'), h('div', null, '状态')),
              wb.recent.map((row) => h('div', { key: row.id, className: 'sd-row', style: { gridTemplateColumns: '110px 1.2fr 90px 90px 70px 60px' } },
                h('div', { className: 'sd-cell' }, new Date(row.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })),
                h('div', { className: 'sd-cell' }, `${row.task}${row.chapter ? ` · 第${row.chapter}章` : ''}`),
                h('div', { className: 'sd-cell' }, fmt(row.inputTokens)),
                h('div', { className: 'sd-cell' }, fmt(row.outputTokens)),
                h('div', { className: 'sd-cell' }, `${(row.durationMs / 1000).toFixed(1)}s`),
                h('div', { className: 'sd-cell' }, row.ok ? '✅' : '❌'))))),
          h('div', { className: 'sd-section' },
            h('h3', { className: 'sd-h3' }, `对话消耗 · ${chat.cwd || '未关联工作区'}`),
            chat.sessions.length === 0 ? h('p', { className: 'sd-hint' }, chat.note || '没有找到这个工作区目录的 DSH 会话日志。') : h('div', { className: 'sd-table' },
              h('div', { className: 'sd-row sd-row-head', style: { gridTemplateColumns: '1.2fr 70px 90px 80px 90px' } }, h('div', null, '会话'), h('div', null, '轮次'), h('div', null, 'token'), h('div', null, '费用'), h('div', null, '最近')),
              chat.sessions.map((session) => h('div', { key: session.id, className: 'sd-row', style: { gridTemplateColumns: '1.2fr 70px 90px 80px 90px' } },
                h('div', { className: 'sd-cell', title: session.id }, session.id.slice(0, 18) + '…'),
                h('div', { className: 'sd-cell' }, String(session.messages)),
                h('div', { className: 'sd-cell', title: `本体 ${session.totalTokens} token` }, fmt(session.familyTokens ?? session.totalTokens)),
                h('div', { className: 'sd-cell', title: `${session.model ?? ''} · 本体 ¥${(session.costCNY ?? 0).toFixed(2)}，含子 Agent` }, (session.familyCostCNY ?? session.costCNY) == null ? '—' : `¥${(session.familyCostCNY ?? session.costCNY).toFixed(2)}`),
                h('div', { className: 'sd-cell' }, session.lastAt ? new Date(session.lastAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'))),
              chat.subagents && chat.subagents.count > 0 ? h('div', { className: 'sd-row', style: { gridTemplateColumns: '1.2fr 70px 90px 80px 90px' } },
                h('div', { className: 'sd-cell' }, `子 Agent × ${chat.subagents.count}`),
                h('div', { className: 'sd-cell' }, '—'),
                h('div', { className: 'sd-cell' }, fmt(chat.subagents.totalTokens)),
                h('div', { className: 'sd-cell' }, `¥${(chat.subagents.costCNY ?? 0).toFixed(2)}`),
                h('div', { className: 'sd-cell' }, '已计入总费用')) : null)),
          h('div', { className: 'sd-dash-note' },
            h('strong', null, '两条通道怎么配合：'),
            h('div', null, '① 工作台 AI：点按钮 → 一次独立调用，上下文由项目拼装，适合「改这一段 / 审这一章 / 补一条账本」，结果进提案。'),
            h('div', null, '② DSH 对话：左侧多轮会话，适合「把整本书的问题一次分析完」，可以调 novel_desk_* 工具读写项目。'),
            h('div', null, '③ 往返方式：工作台「复制项目快照到对话」→ 对话里继续分析 → 让 Agent 用 novel_desk_propose 写回提案 → 回工作台采纳。'),
            h('div', { className: 'sd-hint' }, '费用按 models.dev 挂牌价估算：DeepSeek 工作日 09:00–12:00、14:00–18:00 全价，其余半价；根会话单独列；子 Agent 是独立子会话，token 和费用已计入总额。'),
          ),
        ) : h(Empty, null, busy ? '正在读取用量…' : '暂无仪表盘数据。'),
      )
    }

    function ChaptersTab({ bundle, projectId, onChanged, onExpandChapter, initialView = 'chapters' }) {
      const [view, setView] = useState(initialView)
      const [editing, setEditing] = useState(null)
      const [outlineEditing, setOutlineEditing] = useState(null)
      const chapters = bundle.chapters ?? []
      const outlines = [...(bundle.outlines ?? [])].sort((a, b) => Number(a.chapter) - Number(b.chapter))

      const removeChapter = async (chapter) => {
        if (!window.confirm(`删除第 ${chapter.id} 章《${chapter.title}》？`)) return
        try {
          await api('chapter.delete', { projectId, chapterId: chapter.id })
          onChanged()
        } catch (error) {
          window.alert(error.message)
        }
      }
      const removeOutline = async (outline) => {
        if (!window.confirm(`删除第 ${outline.chapter} 章大纲？`)) return
        try {
          await api('entity.delete', { projectId, kind: 'outlines', entityId: outline.id })
          onChanged()
        } catch (error) {
          window.alert(error.message)
        }
      }

      return h('div', { className: 'sd-page' },
        h('div', { className: 'sd-pagehead' },
          h('div', null,
            h('h2', { className: 'sd-h2' }, view === 'chapters' ? '📄 章节' : '🗂️ 章节大纲'),
            h('p', { className: 'sd-desc' }, view === 'chapters'
              ? `共 ${chapters.length} 章，${bundle.stats.words} 字。章节正文保存为 projects/<id>/chapters/NNNN.md。`
              : `共 ${outlines.length} 章大纲。写下一章方案时 AI 会优先读这里。`)),
          h('div', { className: 'sd-pagehead-actions' },
            h('div', { className: 'sd-segmented' },
              h('button', { type: 'button', className: view === 'chapters' ? 'sd-seg-active' : '', onClick: () => setView('chapters') }, '章节'),
              h('button', { type: 'button', className: view === 'outlines' ? 'sd-seg-active' : '', onClick: () => setView('outlines') }, '大纲')),
            view === 'chapters'
              ? h(Btn, { kind: 'primary', onClick: () => setEditing({}) }, '＋ 新建章节')
              : h(Btn, { kind: 'primary', onClick: () => setOutlineEditing({}) }, '＋ 新增大纲'))),
        view === 'chapters'
          ? (chapters.length === 0
              ? h(Empty, null, '还没有章节。新建一章，或让 Agent 调用 novel_desk_upsert 前先建章节。')
              : h('div', { className: 'sd-chapter-list' },
                  chapters.map((chapter) => h('div', { key: chapter.id, className: 'sd-chapter' },
                    h('div', { className: 'sd-chapter-id' }, chapter.id),
                    h('div', { className: 'sd-chapter-main', onClick: () => setEditing(chapter) },
                      h('div', { className: 'sd-chapter-title' }, chapter.title),
                      h('div', { className: 'sd-chapter-meta' }, `${chapter.words} 字 ｜ ${STATUS_LABEL[chapter.status] || chapter.status}${chapter.storyTime ? ' ｜ ' + chapter.storyTime : ''}${chapter.summary ? ' ｜ ' + chapter.summary : ''}`)),
                    h('div', { className: 'sd-chapter-actions' },
                      h(Btn, { small: true, onClick: () => setEditing(chapter) }, '打开'),
                      onExpandChapter ? h(Btn, { small: true, onClick: () => onExpandChapter(Number(chapter.id)) }, '扩写本章') : null,
                      h(Btn, { small: true, kind: 'danger', onClick: () => removeChapter(chapter) }, '删除'))))))
          : (outlines.length === 0
              ? h(Empty, null, '还没有章节大纲。可以手动新增，也可以在导入作品包时从 大纲.md 自动导入。')
              : h('div', { className: 'sd-table' },
                  h('div', { className: 'sd-row sd-row-head', style: { gridTemplateColumns: '56px 1fr 1.4fr 80px 96px' } },
                    h('div', null, '章'), h('div', null, '标题'), h('div', null, '摘要'), h('div', null, '状态'), h('div', { className: 'sd-actions-col' }, '操作')),
                  outlines.map((outline) => h('div', { key: outline.id ?? outline.chapter, className: 'sd-row', style: { gridTemplateColumns: '56px 1fr 1.4fr 80px 96px' } },
                    h('div', { className: 'sd-cell' }, String(outline.chapter)),
                    h('div', { className: 'sd-cell', title: outline.title }, outline.title),
                    h('div', { className: 'sd-cell', title: outline.summary }, outline.summary || '—'),
                    h('div', { className: 'sd-cell' }, { planned: '计划', drafted: '已写', done: '完成' }[outline.status] ?? '计划'),
                    h('div', { className: 'sd-row-actions' },
                      h(Btn, { small: true, onClick: () => setOutlineEditing(outline) }, '编辑'),
                      h(Btn, { small: true, kind: 'danger', onClick: () => removeOutline(outline) }, '删除')))))),
        editing !== null ? h(ChapterEditor, { chapter: editing, projectId, onExpandChapter, onClose: () => setEditing(null), onSaved: onChanged }) : null,
        outlineEditing !== null ? h(EntityEditor, { kind: 'outlines', item: outlineEditing, projectId, onClose: () => setOutlineEditing(null), onSaved: onChanged }) : null,
      )
    }

    function ChapterEditor({ chapter, projectId, onClose, onSaved, onExpandChapter }) {
      const [form, setForm] = useState(() => ({ ...chapter }))
      const [busy, setBusy] = useState(false)
      const [autoState, setAutoState] = useState('')
      const [historyOpen, setHistoryOpen] = useState(false)
      const [notice, setNotice] = useState('')
      const formRef = useRef(form)
      formRef.current = form
      const lastSavedRef = useRef(JSON.stringify({ ...chapter }))
      const timerRef = useRef(null)
      const onSavedRef = useRef(onSaved)
      onSavedRef.current = onSaved
      const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))
      const words = React.useMemo(() => {
        const text = String(form.content ?? '')
        const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length
        const latin = (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length
        return cjk + latin
      }, [form.content])
      const dirty = JSON.stringify(form) !== lastSavedRef.current

      // 内容改动后 5 秒防抖自动保存（只对已存在的章节；新章节首次保存仍走手动）
      useEffect(() => {
        if (!form.id) return undefined
        if (JSON.stringify(formRef.current) === lastSavedRef.current) {
          setAutoState('')
          return undefined
        }
        setAutoState('未保存…')
        clearTimeout(timerRef.current)
        timerRef.current = setTimeout(async () => {
          const payload = formRef.current
          if (!payload.id || JSON.stringify(payload) === lastSavedRef.current) return
          setAutoState('保存中…')
          try {
            await api('chapter.save', { projectId, chapter: payload })
            lastSavedRef.current = JSON.stringify(payload)
            setAutoState(`已自动保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`)
            onSavedRef.current?.()
          } catch (error) {
            setAutoState('自动保存失败')
            window.alert('自动保存失败：' + error.message)
          }
        }, 5000)
        return () => clearTimeout(timerRef.current)
      }, [form, projectId])

      const requestClose = () => {
        clearTimeout(timerRef.current)
        if (dirty && !window.confirm('还有未保存的改动，确定关闭？')) return
        onClose()
      }

      const save = async () => {
        setBusy(true)
        clearTimeout(timerRef.current)
        const payload = { ...form, status: form.status || 'draft' }
        try {
          await api('chapter.save', { projectId, chapter: payload })
          lastSavedRef.current = JSON.stringify(payload)
          setAutoState('')
          onSaved()
          onClose()
        } catch (error) {
          window.alert(error.message)
        } finally {
          setBusy(false)
        }
      }

      const expandChapter = async () => {
        if (!form.id || !onExpandChapter) return
        clearTimeout(timerRef.current)
        if (dirty) {
          try {
            const payload = { ...form, status: form.status || 'draft' }
            await api('chapter.save', { projectId, chapter: payload })
            lastSavedRef.current = JSON.stringify(payload)
            onSavedRef.current?.()
          } catch (error) {
            window.alert('保存失败，未能进入扩写：' + error.message)
            return
          }
        }
        onExpandChapter(Number(form.id))
      }

      const handleRestored = (restored) => {
        if (restored && typeof restored === 'object' && Object.keys(restored).length > 0) {
          const next = { ...formRef.current, ...restored }
          setForm(next)
          lastSavedRef.current = JSON.stringify(next)
        }
        setAutoState('')
        setNotice('已恢复历史版本，编辑器内容已同步。')
        onSavedRef.current?.()
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'sd-modal-mask', onClick: (e) => e.target === e.currentTarget && requestClose() },
          h(
            'div',
            { className: 'sd-modal sd-modal-wide' },
            h(
              'div',
              { className: 'sd-modal-head' },
              h('strong', null, form.id ? `编辑 · 第 ${form.id} 章` : '新建章节'),
              autoState ? h('span', { className: 'sd-hint sd-autosave' }, autoState) : null,
              h('span', { className: 'sd-hint' }, `${words} 字`),
              form.id ? h(Btn, { small: true, onClick: () => setHistoryOpen(true) }, '历史版本') : null,
              form.id && onExpandChapter ? h(Btn, { small: true, onClick: expandChapter, disabled: busy }, '扩写本章') : null,
              h(IconBtn, { onClick: requestClose, title: '关闭' }, '✕'),
            ),
            h(
              'div',
              { className: 'sd-modal-body' },
              notice ? h('div', { className: 'sd-notice' }, notice) : null,
              h(
                'div',
                { className: 'sd-form sd-form-2' },
                h(Field, { label: '标题' }, h(TextInput, { value: form.title, onChange: (v) => set('title', v), placeholder: '章节标题' })),
                h(Field, { label: '状态' }, h(Select, { value: form.status || 'draft', options: [['draft', '草稿'], ['revised', '修订'], ['final', '定稿']], onChange: (v) => set('status', v) })),
                h(Field, { label: '故事内时间' }, h(TextInput, { value: form.storyTime, onChange: (v) => set('storyTime', v) })),
                h(Field, { label: '地点' }, h(TextInput, { value: form.location, onChange: (v) => set('location', v) })),
                h(Field, { label: '出场人物', hint: '逗号分隔' }, h(TextInput, { value: Array.isArray(form.characters) ? form.characters.join('、') : form.characters ?? '', onChange: (v) => set('characters', v.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)) })),
                h(Field, { label: '摘要' }, h(TextInput, { value: form.summary, onChange: (v) => set('summary', v), placeholder: '一句话概括本章' })),
              ),
              h(Field, { label: '正文', hint: form.id ? '改动后 5 秒自动保存；关闭前若仍有未保存改动会提示' : '新章节请点「保存」' }, h(TextArea, { value: form.content, rows: 20, placeholder: '在这里写正文，或让 Agent 生成后提交。', onChange: (v) => set('content', v) })),
            ),
            h('div', { className: 'sd-modal-foot' }, h(Btn, { onClick: requestClose }, '取消'), h(Btn, { kind: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存')),
          ),
        ),
        historyOpen && form.id
          ? h(ChapterHistoryDialog, { projectId, chapterId: String(form.id), currentContent: form.content, onClose: () => setHistoryOpen(false), onRestored: (restored) => { setHistoryOpen(false); handleRestored(restored) } })
          : null,
      )
    }

    // ── 时间线页 ──────────────────────────────────────────────
    // ── 章节地图（只读进度地图）────────────────────────────────
    const MAP_STATUS_LABEL = { draft: '草稿', revised: '修订', final: '定稿', planned: '计划' }
    const MAP_LEGEND_STATUS = [
      ['draft', '草稿'],
      ['revised', '修订'],
      ['final', '定稿'],
      ['planned', '计划章（虚线）'],
    ]

    function chapterMapIsWritten(chapter) {
      const content = chapter?.content
      if (content === undefined || content === null) return Number(chapter?.words) > 0
      return String(content).trim().length > 0
    }

    function chapterMapStatusKey(entry) {
      if (entry.planned) return 'planned'
      return MAP_STATUS_LABEL[entry.status] ? entry.status : 'draft'
    }

    function formatMapWords(words) {
      const value = Number(words) || 0
      if (value >= 10000) return (value / 10000).toFixed(1) + ' 万'
      if (value >= 1000) return (value / 1000).toFixed(1) + 'k'
      return String(value)
    }

    function chapterMapAttentionTone(attention) {
      if (!attention) return 'none'
      if (!attentionHasScore(attention)) return 'untested'
      const score = Number(attention.score)
      if (score < 60) return 'low'
      if (score < 80) return 'mid'
      return 'high'
    }

    /**
     * 纯函数：把 chapters / outlines / attention / events / conflicts(收束章) /
     * foreshadow(埋收章) / highlights 按章号聚合成地图节点（章号升序）。
     * 节点集合只来自 chapters + outlines；找不到所属章的素材不生成节点（仍计入统计条覆盖数）。
     */
    function buildChapterMapEntries(bundle) {
      const entryMap = new Map()
      const ensure = (chapterNumber) => {
        const number = Number(chapterNumber)
        if (!Number.isFinite(number) || number <= 0) return null
        if (!entryMap.has(number)) {
          entryMap.set(number, {
            chapter: number,
            title: '',
            status: 'draft',
            words: 0,
            summary: '',
            outlineSummary: '',
            location: '',
            written: false,
            hasChapter: false,
            hasOutline: false,
            outline: null,
            planned: false,
            attention: null,
            events: [],
            conflicts: [],
            plants: [],
            payoffs: [],
            highlights: [],
          })
        }
        return entryMap.get(number)
      }
      for (const chapter of bundle?.chapters ?? []) {
        const entry = ensure(chapter?.id)
        if (!entry) continue
        entry.hasChapter = true
        entry.written = chapterMapIsWritten(chapter)
        entry.status = MAP_STATUS_LABEL[chapter.status] ? chapter.status : 'draft'
        entry.title = String(chapter.title ?? '').trim() || entry.title
        entry.words = Number(chapter.words) || 0
        entry.summary = String(chapter.summary ?? '')
        entry.location = String(chapter.location ?? '').trim()
      }
      for (const outline of bundle?.outlines ?? []) {
        const entry = ensure(outline?.chapter)
        if (!entry) continue
        entry.hasOutline = true
        entry.outline = outline
        entry.title = entry.title || String(outline.title ?? '').trim()
        entry.outlineSummary = String(outline.summary ?? '')
      }
      for (const entry of entryMap.values()) entry.planned = entry.hasOutline && !entry.written
      const attach = (chapterNumber, key, value) => {
        const entry = entryMap.get(Number(chapterNumber))
        if (entry) entry[key].push(value)
      }
      for (const event of bundle?.events ?? []) attach(event.chapter, 'events', event)
      for (const conflict of bundle?.conflicts ?? []) attach(conflict.resolveChapter, 'conflicts', conflict)
      for (const item of bundle?.foreshadow ?? []) {
        attach(item.setupChapter, 'plants', item)
        attach(item.payoffChapter, 'payoffs', item)
      }
      for (const highlight of bundle?.highlights ?? []) attach(highlight.chapter, 'highlights', highlight)
      for (const record of attentionRows(bundle)) {
        const entry = entryMap.get(Number(record.chapter))
        if (entry) entry.attention = record
      }
      // 章节没有 location 时回退到本章第一个带地点的事件
      for (const entry of entryMap.values()) {
        if (!entry.location) {
          const eventWithLocation = entry.events.find((event) => String(event.location ?? '').trim() !== '')
          entry.location = String(eventWithLocation?.location ?? '').trim()
        }
      }
      return [...entryMap.values()].sort((a, b) => a.chapter - b.chapter)
    }

    function chapterMapStats(bundle, entries) {
      const chapters = bundle?.chapters ?? []
      const target = Number(bundle?.project?.targetChapters) || 0
      const written = chapters.filter(chapterMapIsWritten).length
      const planned = entries.filter((entry) => entry.planned).length
      const words = chapters.reduce((sum, chapter) => sum + (Number(chapter.words) || 0), 0)
      const attention = attentionAverage(attentionRows(bundle))
      return {
        written,
        totalChapters: chapters.length,
        planned,
        target,
        words,
        attention,
        attentionCount: attentionRows(bundle).filter(attentionHasScore).length,
        events: (bundle?.events ?? []).length,
        conflicts: (bundle?.conflicts ?? []).filter((conflict) => Number(conflict.resolveChapter) > 0).length,
        foreshadow: (bundle?.foreshadow ?? []).filter((item) => Number(item.setupChapter) > 0 || Number(item.payoffChapter) > 0).length,
        highlights: (bundle?.highlights ?? []).length,
      }
    }

    /** 蛇形分页：按 rowSize 切行，奇数行交给 CSS 反向（direction:rtl）。 */
    function chunkChapterMapRows(entries, rowSize) {
      const size = Math.max(1, Number(rowSize) || 12)
      const rows = []
      for (let index = 0; index < entries.length; index += size) rows.push(entries.slice(index, index + size))
      return rows
    }

    function useMapColumns() {
      const readColumns = () => (typeof window !== 'undefined' && Number(window.innerWidth) > 0 && Number(window.innerWidth) <= 900 ? 6 : 12)
      const [columns, setColumns] = useState(readColumns)
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const update = () => setColumns(readColumns())
        window.addEventListener('resize', update)
        return () => window.removeEventListener('resize', update)
      }, [])
      return columns
    }

    function ChapterMapDetail({ entry, onClose, onGoTab, locations, onFocusLocation }) {
      const statusKey = chapterMapStatusKey(entry)
      const record = entry.attention
      const matchedLocation = findLocationByName(locations, entry.location)
      const section = (title, content) => h('section', { className: 'sd-map-section' },
        h('h3', { className: 'sd-map-section-title' }, title),
        content)
      const rowLine = (main, meta, key) => h('div', { key, className: 'sd-map-rowline' },
        h('span', { className: 'sd-map-rowline-main' }, main),
        meta ? h('span', { className: 'sd-map-rowline-meta' }, meta) : null)
      const empty = () => h('div', { className: 'sd-map-empty' }, '—')
      const verdict = record?.verdict ?? ''
      const designScore = record && record.designScore !== '' && record.designScore !== null && record.designScore !== undefined ? String(record.designScore) : ''
      return h('div', { className: 'sd-modal-mask', onClick: (e) => e.target === e.currentTarget && onClose() },
        h('div', { className: 'sd-modal sd-modal-wide sd-map-detail' },
          h('div', { className: 'sd-modal-head sd-map-detail-head' },
            h('strong', { className: 'sd-map-detail-title' }, `第 ${entry.chapter} 章${entry.title ? `《${entry.title}》` : ''}`),
            h(Tag, { tone: statusKey === 'planned' ? 'muted' : 'brand' }, MAP_STATUS_LABEL[statusKey]),
            entry.written ? h(Tag, { tone: 'muted' }, `${formatMapWords(entry.words)} 字`) : null,
            h('div', { className: 'sd-map-detail-actions' },
              matchedLocation && onFocusLocation ? h(Btn, { small: true, onClick: () => onFocusLocation(matchedLocation.name) }, '在世界地图中查看') : null,
              onGoTab ? h(Btn, { small: true, kind: 'primary', onClick: () => onGoTab('chapters') }, '打开章节页') : null,
              h(Btn, { small: true, onClick: onClose }, '关闭'))),
          h('div', { className: 'sd-modal-body sd-map-detail-body' },
            section('章节信息', h('div', { className: 'sd-map-detail-meta' }, [
              `状态：${MAP_STATUS_LABEL[statusKey]}`,
              `字数：${entry.written ? formatMapWords(entry.words) + ' 字' : '—'}`,
              entry.hasOutline ? '有大纲' : '无大纲',
              `地点：${entry.location || '—'}`,
            ].join(' · '))),
            section('章节摘要', entry.summary ? h('div', { className: 'sd-map-text' }, entry.summary) : empty()),
            entry.hasOutline ? section('大纲摘要', entry.outlineSummary ? h('div', { className: 'sd-map-text' }, entry.outlineSummary) : empty()) : null,
            section('注意力', record
              ? h('div', { className: 'sd-map-att' },
                  h('div', { className: 'sd-map-att-head' },
                    h('span', { className: `sd-map-att-score${attentionHasScore(record) ? ' sd-map-att-score-' + chapterMapAttentionTone(record) : ''}` }, attentionHasScore(record) ? `${Number(record.score)} 分` : '未测'),
                    h('span', { className: 'sd-map-att-meta' }, [
                      ATTENTION_TYPE_LABEL[record.type] ?? '未分型',
                      verdict ? `下一章：${verdict}` : '',
                      designScore ? `目标 ${designScore}` : '',
                    ].filter(Boolean).join(' · '))),
                  rowLine('最弱一环', record.weakest ? ATTENTION_WEAKEST_LABEL[record.weakest] ?? record.weakest : '—'),
                  rowLine('章末牵引', String(record.cliff ?? '').trim() || '—'),
                  record.dropRisk ? rowLine('弃读点', record.dropRisk) : null)
              : h('div', { className: 'sd-map-empty' }, '未标注意力（冷读后回填 score，或在编辑器里手动补一条）。')),
            section(`本章事件（${entry.events.length}）`, entry.events.length === 0
              ? empty()
              : entry.events.map((event, index) => rowLine(event.title || event.id || '未命名事件', event.storyTime || '', event.id ?? `event-${index}`))),
            section(`本章冲突（${entry.conflicts.length}）`, entry.conflicts.length === 0
              ? empty()
              : entry.conflicts.map((conflict, index) => rowLine(conflict.title || '未命名冲突', CONFLICT_STATUS[conflict.status] ?? conflict.status ?? '', conflict.id ?? `conflict-${index}`))),
            section(`本章伏笔（埋 ${entry.plants.length} / 收 ${entry.payoffs.length}）`, entry.plants.length + entry.payoffs.length === 0
              ? empty()
              : h('div', null,
                  entry.plants.map((item, index) => rowLine(`埋：${item.title ?? '未命名'}`, Number(item.payoffChapter) > 0 ? `→ 第 ${item.payoffChapter} 章回收` : '→ 未定回收', `plant-${item.id ?? index}`)),
                  entry.payoffs.map((item) => rowLine(`收：${item.title ?? '未命名'}`, Number(item.setupChapter) > 0 ? `第 ${item.setupChapter} 章 →` : '未定埋设 →')))),
            section(`本章高光（${entry.highlights.length}）`, entry.highlights.length === 0
              ? empty()
              : entry.highlights.map((highlight, index) => rowLine(highlight.title || highlight.quote || highlight.text || '未命名高光', displayValue('type', highlight.type) === '—' ? '' : displayValue('type', highlight.type), highlight.id ?? `highlight-${index}`))),
          ),
        ),
      )
    }

    function ChapterMapTab({ bundle, projectId, onGoTab, onFocusLocation }) {
      const [detailChapter, setDetailChapter] = useState(null)
      const [viewOpen, setViewOpen] = useState(false)
      const entries = buildChapterMapEntries(bundle)
      const stats = chapterMapStats(bundle, entries)
      const columns = useMapColumns()
      const rows = chunkChapterMapRows(entries, columns)
      const detail = detailChapter === null ? null : entries.find((entry) => entry.chapter === Number(detailChapter)) ?? null
      const nodeTitle = (entry) => {
        const attention = entry.attention
        const attentionText = attention ? (attentionHasScore(attention) ? `${Number(attention.score)} 分` : '未测') : '未标'
        const parts = [
          `第 ${entry.chapter} 章${entry.title ? `《${entry.title}》` : ''}`,
          MAP_STATUS_LABEL[chapterMapStatusKey(entry)],
          `注意力 ${attentionText}`,
        ]
        if (entry.events.length) parts.push(`事件 ${entry.events.length}`)
        if (entry.conflicts.length) parts.push(`冲突收束 ${entry.conflicts.length}`)
        if (entry.plants.length + entry.payoffs.length) parts.push(`伏笔 ${entry.plants.length + entry.payoffs.length}`)
        if (entry.highlights.length) parts.push(`高光 ${entry.highlights.length}`)
        if (entry.words) parts.push(`${formatMapWords(entry.words)} 字`)
        return parts.join(' · ')
      }
      if (entries.length === 0) {
        return h('div', { className: 'sd-page' },
          h('div', { className: 'sd-pagehead' },
            h('div', null, h('h2', { className: 'sd-h2' }, '🗺️ 地图'), h('p', { className: 'sd-desc' }, '章节地图：按章号排成蛇形进度地图，节点汇总状态、注意力分与事件 / 冲突 / 伏笔 / 高光。只读，AI 入口仍在清单。')),
            h('div', { className: 'sd-pagehead-actions' },
              h(Btn, { onClick: () => setViewOpen(true) }, '只读视图'))),
          h(Empty, null, '还没有章节。先在章节页写第 1 章，或让 AI 生成大纲。'),
          viewOpen ? h(HtmlViewDialog, { title: '🗺️ 章节地图 · 只读视图', path: novelDeskViewPath('map', projectId), onClose: () => setViewOpen(false) }) : null)
      }
      const statusSwatch = (statusKey) => h('span', { className: `sd-map-swatch sd-map-swatch-${statusKey}` })
      const attentionSwatch = (tone) => h('span', { className: `sd-map-swatch sd-map-swatch-att-${tone}` })
      return h('div', { className: 'sd-page sd-map-page' },
        h('div', { className: 'sd-pagehead' },
          h('div', null,
            h('h2', { className: 'sd-h2' }, '🗺️ 地图'),
            h('p', { className: 'sd-desc' }, `章节地图：按章号排成蛇形进度地图（${entries.length} 个节点），节点汇总状态、注意力分与事件 / 冲突 / 伏笔 / 高光。只读；写作与 AI 入口仍在章节页与清单。`)),
          h('div', { className: 'sd-pagehead-actions' },
            h(Btn, { onClick: () => setViewOpen(true) }, '只读视图'),
            onGoTab ? h(Btn, { onClick: () => onGoTab('chapters') }, '去章节页写下一章') : null)),
        h('div', { className: 'sd-map-stats' },
          h('div', { className: 'sd-map-stat' },
            h('div', { className: 'sd-map-stat-label' }, '已写章节'),
            h('div', { className: 'sd-map-stat-big' }, String(stats.written)),
            h('div', { className: 'sd-map-stat-hint' }, `章节记录 ${stats.totalChapters} 章`)),
          h('div', { className: 'sd-map-stat' },
            h('div', { className: 'sd-map-stat-label' }, '计划章节'),
            h('div', { className: 'sd-map-stat-big' }, String(stats.planned)),
            h('div', { className: 'sd-map-stat-hint' }, stats.target > 0 ? `目标 ${stats.target} 章` : '来自大纲')),
          h('div', { className: 'sd-map-stat' },
            h('div', { className: 'sd-map-stat-label' }, '总字数'),
            h('div', { className: 'sd-map-stat-big' }, formatMapWords(stats.words)),
            h('div', { className: 'sd-map-stat-hint' }, '正文累计')),
          h('div', { className: 'sd-map-stat' },
            h('div', { className: 'sd-map-stat-label' }, '平均注意力分'),
            h('div', { className: `sd-map-stat-big${attentionScoreTone(stats.attention)}` }, stats.attention === null ? '—' : String(stats.attention)),
            h('div', { className: 'sd-map-stat-hint' }, `${stats.attentionCount} 章有实测分`)),
          h('div', { className: 'sd-map-stat sd-map-stat-cover' },
            h('div', { className: 'sd-map-stat-label' }, '素材覆盖'),
            h('div', { className: 'sd-map-cover' },
              h('span', null, `事件 ${stats.events}`),
              h('span', null, `冲突收束 ${stats.conflicts}`),
              h('span', null, `伏笔埋收 ${stats.foreshadow}`),
              h('span', null, `高光 ${stats.highlights}`)))),
        h('div', { className: 'sd-map-legend' },
          h('span', { className: 'sd-map-legend-title' }, '状态'),
          MAP_LEGEND_STATUS.map(([key, label]) => h('span', { key, className: 'sd-map-legend-item' }, statusSwatch(key), label)),
          h('span', { className: 'sd-map-legend-sep' }, '·'),
          h('span', { className: 'sd-map-legend-title' }, '注意力'),
          h('span', { className: 'sd-map-legend-item' }, attentionSwatch('low'), '<60 红'),
          h('span', { className: 'sd-map-legend-item' }, attentionSwatch('mid'), '60–79 黄'),
          h('span', { className: 'sd-map-legend-item' }, attentionSwatch('high'), '≥80 绿'),
          h('span', { className: 'sd-map-legend-item' }, attentionSwatch('untested'), '未测'),
          h('span', { className: 'sd-map-legend-item' }, attentionSwatch('none'), '未标')),
        h('div', { className: 'sd-map-board' }, rows.map((row, rowIndex) => h('div', { key: `row-${rowIndex}`, className: `sd-map-row${rowIndex % 2 === 1 ? ' sd-map-row-rev' : ''}` },
          row.map((entry) => {
            const statusKey = chapterMapStatusKey(entry)
            const attention = entry.attention
            const tone = chapterMapAttentionTone(attention)
            const attentionLabel = attention
              ? (attentionHasScore(attention) ? String(Number(attention.score)) : '未测')
              : '未标'
            const badges = [
              entry.events.length ? { key: 'event', label: '事', count: entry.events.length, title: `事件 ${entry.events.length} 条：${entry.events.map((item) => item.title ?? '未命名').join('、')}` } : null,
              entry.conflicts.length ? { key: 'conflict', label: '冲', count: entry.conflicts.length, title: `冲突收束 ${entry.conflicts.length} 条：${entry.conflicts.map((item) => item.title ?? '未命名').join('、')}` } : null,
              entry.plants.length + entry.payoffs.length ? { key: 'foreshadow', label: '伏', count: entry.plants.length + entry.payoffs.length, title: `伏笔 埋 ${entry.plants.length} / 收 ${entry.payoffs.length}` } : null,
              entry.highlights.length ? { key: 'highlight', label: '高', count: entry.highlights.length, title: `高光 ${entry.highlights.length} 条` } : null,
            ].filter(Boolean)
            return h('button', {
              key: entry.chapter,
              type: 'button',
              className: `sd-mapnode sd-mapnode-status-${statusKey}`,
              title: nodeTitle(entry),
              onClick: () => setDetailChapter(entry.chapter),
            },
              h('span', { className: 'sd-mapnode-top' },
                h('span', { className: 'sd-mapnode-chapter' }, String(entry.chapter)),
                h('span', { className: `sd-mapnode-att sd-mapnode-att-${tone}` }, attentionLabel)),
              h('span', { className: 'sd-mapnode-title', title: entry.title || '' }, entry.title || '未命名'),
              h('span', { className: 'sd-mapnode-meta' },
                h('span', { className: 'sd-mapnode-status' }, MAP_STATUS_LABEL[statusKey]),
                h('span', { className: 'sd-mapnode-words' }, entry.words ? `${formatMapWords(entry.words)} 字` : '—')),
              badges.length > 0
                ? h('span', { className: 'sd-mapnode-badges' }, badges.map((badge) => h('span', { key: badge.key, className: `sd-mapnode-badge sd-mapnode-badge-${badge.key}`, title: badge.title }, `${badge.label}${badge.count}`)))
                : null)
          })))),
        detail ? h(ChapterMapDetail, { entry: detail, onClose: () => setDetailChapter(null), onGoTab, locations: bundle.locations ?? [], onFocusLocation }) : null,
        viewOpen ? h(HtmlViewDialog, { title: '🗺️ 章节地图 · 只读视图', path: novelDeskViewPath('map', projectId), onClose: () => setViewOpen(false) }) : null,
      )
    }

    // ── 世界 / 地点：辅助函数 + 世界页 + 地点编辑器 + 只读视图 ─────
    function novelDeskViewPath(view, projectId) {
      return `/novel-desk/view/${view}?projectId=${encodeURIComponent(String(projectId ?? ''))}`
    }

    function worldMapSize(world) {
      const w = Number(world?.mapSize?.w)
      const h = Number(world?.mapSize?.h)
      return {
        w: Number.isFinite(w) && w > 0 ? w : 1000,
        h: Number.isFinite(h) && h > 0 ? h : 1000,
      }
    }

    function clampWorldCoord(value, max) {
      const n = Number(value)
      if (!Number.isFinite(n)) return 0
      const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : 1000
      return Math.min(limit, Math.max(0, n))
    }

    function locationCoords(location, world) {
      const size = worldMapSize(world)
      return {
        x: clampWorldCoord(location?.coords?.x, size.w),
        y: clampWorldCoord(location?.coords?.y, size.h),
      }
    }

    /** 地点名 / 别名匹配（章节、事件里的 location 文本 → locations 实体）。 */
    function findLocationByName(locations, name) {
      const target = String(name ?? '').trim()
      if (target === '') return null
      return (locations ?? []).find((location) => {
        if (String(location?.name ?? '').trim() === target) return true
        return relationshipList(location?.aliases).includes(target)
      }) ?? null
    }

    /** 连接双向只画一次：按 id 排序去重，避免 A→B / B→A 两条线重叠。 */
    function buildWorldEdges(locations) {
      const byId = new Map((locations ?? []).map((location) => [String(location.id), location]))
      const seen = new Set()
      const edges = []
      for (const location of locations ?? []) {
        for (const connection of location.connections ?? []) {
          const fromId = String(location.id)
          const toId = String(connection?.to ?? '')
          if (!byId.has(toId) || fromId === toId) continue
          const key = [fromId, toId].sort().join('|')
          if (seen.has(key)) continue
          seen.add(key)
          edges.push({ id: key, from: location, to: byId.get(toId), connection })
        }
      }
      return edges
    }

    function normalizeWorldForm(world) {
      const size = worldMapSize(world)
      const travel = world?.travelModel ?? {}
      return {
        id: world?.id ?? 'world',
        name: String(world?.name ?? ''),
        scale: WORLD_SCALE_OPTIONS.some(([value]) => value === world?.scale) ? world.scale : 'region',
        kind: WORLD_KIND_OPTIONS.some(([value]) => value === world?.kind) ? world.kind : 'mixed',
        era: String(world?.era ?? ''),
        mapSize: size,
        travelModel: {
          walkKmPerDay: Number(travel.walkKmPerDay) || 30,
          horseKmPerDay: Number(travel.horseKmPerDay) || 80,
          boatKmPerDay: Number(travel.boatKmPerDay) || 60,
        },
        locked: world?.locked === true,
        note: String(world?.note ?? ''),
      }
    }

    function worldBuildInstruction(kind, scale, era) {
      const kindLabel = CREATE_WORLD_KINDS.find(([value]) => value === kind)?.[1] ?? '混合'
      const scaleLabel = CREATE_WORLD_SCALES.find(([value]) => value === scale)?.[1] ?? '地区'
      const eraText = String(era ?? '').trim() || '未指定'
      return `背景：${kindLabel}；尺度：${scaleLabel}；时代：${eraText}`
    }

    function HtmlViewDialog({ title, path, onClose }) {
      return h('div', { className: 'sd-modal-mask', onClick: (e) => e.target === e.currentTarget && onClose() },
        h('div', { className: 'sd-modal sd-modal-wide sd-htmlview' },
          h('div', { className: 'sd-modal-head' },
            h('strong', null, title || '只读视图'),
            h(IconBtn, { onClick: onClose, title: '关闭' }, '✕')),
          h('div', { className: 'sd-htmlview-body' },
            h('iframe', { className: 'sd-htmlview-frame', src: path, title: title || '只读视图' })),
          h('div', { className: 'sd-modal-foot sd-htmlview-foot' },
            h('span', { className: 'sd-hint' }, '同源只读 HTML，可直接用浏览器打印。'),
            h(Btn, { onClick: onClose }, '关闭'))),
      )
    }

    function LocationEditor({ location, locations, world, projectId, onClose, onSaved }) {
      const size = worldMapSize(world)
      const otherLocations = (locations ?? []).filter((item) => String(item.id) !== String(location?.id ?? ''))
      const [form, setForm] = useState(() => ({
        name: String(location?.name ?? ''),
        aliases: relationshipList(location?.aliases),
        type: LOCATION_TYPE_LABEL[location?.type] ? location.type : 'other',
        coords: locationCoords(location, world),
        region: String(location?.region ?? ''),
        firstChapter: location?.firstChapter === 0 || location?.firstChapter ? String(location.firstChapter) : '',
        note: String(location?.note ?? ''),
        connections: (location?.connections ?? []).map((connection) => ({
          to: String(connection?.to ?? ''),
          distanceKm: connection?.distanceKm === undefined || connection?.distanceKm === null ? '' : String(connection.distanceKm),
          days: connection?.days === undefined || connection?.days === null ? '' : String(connection.days),
          mode: LOCATION_MODE_LABEL[connection?.mode] ? connection.mode : 'walk',
          bearing: String(connection?.bearing ?? ''),
        })),
      }))
      const [busy, setBusy] = useState(false)
      const setFormField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))
      const setCoord = (key, value) => setForm((prev) => ({ ...prev, coords: { ...prev.coords, [key]: value } }))
      const setConnection = (index, key, value) => setForm((prev) => ({
        ...prev,
        connections: prev.connections.map((connection, position) => (position === index ? { ...connection, [key]: value } : connection)),
      }))
      const addConnection = () => setForm((prev) => ({
        ...prev,
        connections: [...prev.connections, { to: otherLocations[0]?.id ? String(otherLocations[0].id) : '', distanceKm: '', days: '', mode: 'walk', bearing: '' }],
      }))
      const removeConnection = (index) => setForm((prev) => ({ ...prev, connections: prev.connections.filter((connection, position) => position !== index) }))
      const aliasesText = relationshipList(form.aliases).join('、')
      const save = async () => {
        if (!String(form.name).trim()) {
          window.alert('请填写地点名称')
          return
        }
        setBusy(true)
        try {
          const item = {
            ...(location ?? {}),
            name: String(form.name).trim(),
            aliases: relationshipList(form.aliases),
            type: form.type,
            coords: {
              x: clampWorldCoord(form.coords.x, size.w),
              y: clampWorldCoord(form.coords.y, size.h),
            },
            region: String(form.region ?? '').trim(),
            firstChapter: String(form.firstChapter ?? '').trim() === '' ? null : Number(form.firstChapter) || 0,
            note: String(form.note ?? ''),
            connections: form.connections
              .filter((connection) => connection.to)
              .map((connection) => ({
                to: connection.to,
                distanceKm: Number(connection.distanceKm) || 0,
                days: Number(connection.days) || 0,
                mode: connection.mode,
                bearing: String(connection.bearing ?? '').trim(),
              })),
          }
          await api('entity.upsert', { projectId, kind: 'locations', item })
          onSaved()
          onClose()
        } catch (error) {
          window.alert(error.message)
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'sd-modal-mask', onClick: (e) => e.target === e.currentTarget && onClose() },
        h('div', { className: 'sd-modal sd-modal-wide sd-loc-editor' },
          h('div', { className: 'sd-modal-head' },
            h('strong', null, location?.id ? `编辑地点 · ${location.name || ''}` : '新增地点'),
            h(IconBtn, { onClick: onClose, title: '关闭' }, '✕')),
          h('div', { className: 'sd-modal-body sd-loc-editor-body' },
            h('div', { className: 'sd-loc-form-grid' },
              h(Field, { label: '名称 *' }, h(TextInput, { value: form.name, onChange: (value) => setFormField('name', value), placeholder: '如：长安' })),
              h(Field, { label: '别名', hint: '逗号 / 顿号分隔' }, h(TextInput, { value: aliasesText, onChange: (value) => setFormField('aliases', value.split(/[、,，]/).map((part) => part.trim()).filter(Boolean)), placeholder: '如 京兆府、西京' })),
              h(Field, { label: '类型' }, h(Select, { value: form.type, onChange: (value) => setFormField('type', value), options: LOCATION_TYPES.map(([value, label]) => ({ value, label })) })),
              h(Field, { label: '区域' }, h(TextInput, { value: form.region, onChange: (value) => setFormField('region', value), placeholder: '如 关内道 / 北境' })),
              h(Field, { label: '首现章' }, h(TextInput, { value: form.firstChapter, type: 'number', onChange: (value) => setFormField('firstChapter', value) })),
              h(Field, { label: '坐标 X', hint: `0–${size.w}` }, h(TextInput, { value: form.coords.x, type: 'number', onChange: (value) => setCoord('x', value) })),
              h(Field, { label: '坐标 Y', hint: `0–${size.h}` }, h(TextInput, { value: form.coords.y, type: 'number', onChange: (value) => setCoord('y', value) })),
              h(Field, { label: '备注' }, h(TextArea, { value: form.note, rows: 2, onChange: (value) => setFormField('note', value) }))),
            h('div', { className: 'sd-loc-conn-head' },
              h('h3', { className: 'sd-h3' }, `连接道路（${form.connections.length}）`),
              h(Btn, { small: true, onClick: addConnection, disabled: otherLocations.length === 0 }, '＋ 添加连接')),
            otherLocations.length === 0
              ? h('div', { className: 'sd-hint' }, '至少再有一个地点才能建立连接。')
              : form.connections.length === 0
                ? h('div', { className: 'sd-hint' }, '还没有连接。添加后地图会画线并标注距离 / 天数。')
                : h('div', { className: 'sd-loc-conn-list' }, form.connections.map((connection, index) => h('div', { key: index, className: 'sd-loc-conn-row' },
                    h('select', { className: 'sd-input sd-loc-conn-select', value: connection.to, onChange: (e) => setConnection(index, 'to', e.target.value) },
                      h('option', { value: '' }, '（选择地点）'),
                      otherLocations.map((item) => h('option', { key: item.id, value: item.id }, item.name || item.id))),
                    h('input', { className: 'sd-input', type: 'number', value: connection.distanceKm, placeholder: '距离 km', title: '距离 km', onChange: (e) => setConnection(index, 'distanceKm', e.target.value) }),
                    h('input', { className: 'sd-input', type: 'number', value: connection.days, placeholder: '天数', title: '行程天数', onChange: (e) => setConnection(index, 'days', e.target.value) }),
                    h('select', { className: 'sd-input sd-loc-conn-mode', value: connection.mode, onChange: (e) => setConnection(index, 'mode', e.target.value) },
                      LOCATION_MODE_OPTIONS.map(([value, label]) => h('option', { key: value, value }, label))),
                    h('input', { className: 'sd-input', value: connection.bearing, placeholder: '方位 east…', title: '方位（east / west / north / south…）', onChange: (e) => setConnection(index, 'bearing', e.target.value) }),
                    h(IconBtn, { onClick: () => removeConnection(index), title: '删除这条连接' }, '✕')))),
          ),
          h('div', { className: 'sd-modal-foot' },
            h(Btn, { onClick: onClose }, '取消'),
            h(Btn, { kind: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存地点'))),
      )
    }

    function WorldTab({ bundle, projectId, onChanged, onAddCart, focusLocation }) {
      const locations = [...(bundle.locations ?? [])].sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-CN'))
      const worldSignature = JSON.stringify(bundle.world ?? null)
      const [worldForm, setWorldForm] = useState(() => normalizeWorldForm(bundle.world))
      const [busy, setBusy] = useState(false)
      const [viewOpen, setViewOpen] = useState(false)
      const [locEditing, setLocEditing] = useState(null)
      const [focusId, setFocusId] = useState(null)
      const [focusTip, setFocusTip] = useState('')
      const [hoverId, setHoverId] = useState(null)
      const [drag, setDrag] = useState(null)
      const svgRef = useRef(null)
      const mapRef = useRef(null)
      const suppressClickRef = useRef(false)
      useEffect(() => setWorldForm(normalizeWorldForm(bundle.world)), [worldSignature])
      useEffect(() => {
        if (!focusLocation) return
        const name = typeof focusLocation === 'string' ? focusLocation : focusLocation.name
        const target = findLocationByName(locations, name)
        if (target) {
          setFocusId(String(target.id))
          setFocusTip('')
          try {
            mapRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
          } catch {
            /* 区块不可滚动时忽略 */
          }
        } else {
          setFocusTip(`世界地图里还没有「${String(name ?? '')}」：可以先添加地点或让 AI 反推地点。`)
        }
      }, [focusLocation, bundle.locations])
      const size = worldMapSize(worldForm)
      const edges = buildWorldEdges(locations)
      const activeId = hoverId !== null ? String(hoverId) : focusId !== null ? String(focusId) : null
      const neighborIds = new Set()
      if (activeId !== null) {
        for (const edge of edges) {
          if (String(edge.from.id) === activeId) neighborIds.add(String(edge.to.id))
          if (String(edge.to.id) === activeId) neighborIds.add(String(edge.from.id))
        }
      }
      const coordsOf = (location) => {
        if (drag && String(drag.id) === String(location.id)) return { x: drag.x, y: drag.y }
        return locationCoords(location, worldForm)
      }
      const hasWorld = !!bundle.world && (String(bundle.world.name ?? '').trim() !== '' || locations.length > 0)
      const focusLocationRow = focusId === null ? null : locations.find((location) => String(location.id) === String(focusId)) ?? null
      const saveWorld = async () => {
        setBusy(true)
        try {
          await api('world.save', { projectId, world: { ...worldForm, id: worldForm.id || 'world' } })
          onChanged()
        } catch (error) {
          window.alert(`保存世界失败：${error.message}`)
        } finally {
          setBusy(false)
        }
      }
      const setWorldField = (key, value) => setWorldForm((prev) => ({ ...prev, [key]: value }))
      const setTravelField = (key, value) => setWorldForm((prev) => ({ ...prev, travelModel: { ...prev.travelModel, [key]: Number(value) || 0 } }))
      const mapPointOf = (event) => {
        const svg = svgRef.current
        if (!svg) return null
        // 优先用 SVG 坐标变换，正确处理 viewBox 等比缩放产生的留白；失败再退回矩形比例。
        if (typeof svg.createSVGPoint === 'function' && typeof svg.getScreenCTM === 'function') {
          try {
            const matrix = svg.getScreenCTM()
            if (matrix) {
              const point = svg.createSVGPoint()
              point.x = Number(event.clientX) || 0
              point.y = Number(event.clientY) || 0
              const local = point.matrixTransform(matrix.inverse())
              return { x: clampWorldCoord(local.x, size.w), y: clampWorldCoord(local.y, size.h) }
            }
          } catch {
            /* 退回矩形比例 */
          }
        }
        if (typeof svg.getBoundingClientRect !== 'function') return null
        const rect = svg.getBoundingClientRect()
        if (!rect.width || !rect.height) return null
        return {
          x: clampWorldCoord(((Number(event.clientX) || 0) - rect.left) / rect.width * size.w, size.w),
          y: clampWorldCoord(((Number(event.clientY) || 0) - rect.top) / rect.height * size.h, size.h),
        }
      }
      const startDrag = (event, location) => {
        if (event?.button !== undefined && event.button !== 0) return
        const coords = locationCoords(location, worldForm)
        setDrag({ id: String(location.id), startClientX: Number(event?.clientX) || 0, startClientY: Number(event?.clientY) || 0, x: coords.x, y: coords.y, moved: false })
        event?.preventDefault?.()
        event?.stopPropagation?.()
      }
      const moveDrag = (event) => {
        if (!drag) return
        const point = mapPointOf(event)
        if (!point) return
        const moved = drag.moved || Math.abs((Number(event.clientX) || 0) - drag.startClientX) > 3 || Math.abs((Number(event.clientY) || 0) - drag.startClientY) > 3
        setDrag({ ...drag, x: point.x, y: point.y, moved })
      }
      const endDrag = async () => {
        if (!drag) return
        const current = drag
        setDrag(null)
        if (!current.moved) return
        suppressClickRef.current = true
        const location = locations.find((item) => String(item.id) === current.id)
        if (!location) return
        try {
          await api('entity.upsert', {
            projectId,
            kind: 'locations',
            item: { ...location, coords: { x: clampWorldCoord(current.x, size.w), y: clampWorldCoord(current.y, size.h) } },
          })
          onChanged()
        } catch (error) {
          window.alert(`保存坐标失败：${error.message}`)
        }
      }
      const locateLocation = (location) => {
        setFocusId(String(location.id))
        setFocusTip('')
        try {
          mapRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
        } catch {
          /* ignore */
        }
      }
      const removeLocation = async (location) => {
        if (!window.confirm(`删除地点「${location.name || location.id}」？`)) return
        try {
          await api('entity.delete', { projectId, kind: 'locations', entityId: location.id })
          onChanged()
        } catch (error) {
          window.alert(error.message)
        }
      }
      const typeLabel = (value) => LOCATION_TYPE_LABEL[value] ?? value ?? '其他'
      return h('div', { className: 'sd-page sd-world-page' },
        h('div', { className: 'sd-pagehead' },
          h('div', null,
            h('h2', { className: 'sd-h2' }, '🌍 世界'),
            h('p', { className: 'sd-desc' }, '世界设定与坐标地图：地点按类型着色、连接线标距离 / 天数，拖拽节点松手即保存；AI 只通过清单入口生成或反推地点。')),
          h('div', { className: 'sd-pagehead-actions' },
            h(Btn, { onClick: () => setLocEditing({}) }, '＋ 地点'),
            onAddCart ? h(Btn, { onClick: () => onAddCart(WORLD_CART.build) }, '＋ 加入清单：AI 生成世界') : null,
            onAddCart ? h(Btn, { onClick: () => onAddCart(WORLD_CART.infer) }, '＋ 加入清单：AI 反推地点') : null,
            h(Btn, { onClick: () => setViewOpen(true) }, '只读视图'))),
        !hasWorld
          ? h('div', { className: 'sd-world-guide' },
              h('div', null,
                h('strong', null, '还没有世界设定'),
                h('p', { className: 'sd-hint' }, '先填写下面的名称 / 尺度 / 类型 / 时代，或加入清单让 AI 生成 8–20 个核心地点与连接；生成后可以在地图上拖拽校准。')),
              onAddCart ? h(Btn, { kind: 'primary', onClick: () => onAddCart(WORLD_CART.build) }, '＋ 加入清单：AI 生成世界地图') : null)
          : null,
        h('section', { className: 'sd-section sd-world-settings' },
          h('div', { className: 'sd-world-settings-head' },
            h('h3', { className: 'sd-h3' }, '世界设定'),
            h('span', { className: 'sd-hint' }, hasWorld ? '修改后点保存；坐标 0–1000 归一化。' : '还没有生成，可先让 AI 生成或手动填写。')),
          h('div', { className: 'sd-world-settings-grid' },
            h(Field, { label: '世界名称' }, h(TextInput, { value: worldForm.name, onChange: (value) => setWorldField('name', value), placeholder: '如：大唐天宝' })),
            h(Field, { label: '尺度' }, h(Select, { value: worldForm.scale, onChange: (value) => setWorldField('scale', value), options: WORLD_SCALE_OPTIONS.map(([value, label]) => ({ value, label })) })),
            h(Field, { label: '背景类型' }, h(Select, { value: worldForm.kind, onChange: (value) => setWorldField('kind', value), options: WORLD_KIND_OPTIONS.map(([value, label]) => ({ value, label })) })),
            h(Field, { label: '时代' }, h(TextInput, { value: worldForm.era, onChange: (value) => setWorldField('era', value), placeholder: '如：唐·天宝年间' })),
            h(Field, { label: '步行 km/日' }, h(TextInput, { value: worldForm.travelModel.walkKmPerDay, type: 'number', onChange: (value) => setTravelField('walkKmPerDay', value) })),
            h(Field, { label: '骑马 km/日' }, h(TextInput, { value: worldForm.travelModel.horseKmPerDay, type: 'number', onChange: (value) => setTravelField('horseKmPerDay', value) })),
            h(Field, { label: '行船 km/日' }, h(TextInput, { value: worldForm.travelModel.boatKmPerDay, type: 'number', onChange: (value) => setTravelField('boatKmPerDay', value) }))),
          h('div', { className: 'sd-world-settings-actions' },
            h(Btn, { kind: 'primary', onClick: saveWorld, disabled: busy }, busy ? '保存中…' : '保存世界'),
            h('span', { className: 'sd-hint' }, '行程以 connections 的 distanceKm / days 为准；地图坐标只用于相对方位。'))),
        h('section', { className: 'sd-world-map', ref: mapRef },
          h('div', { className: 'sd-world-map-head' },
            h('h3', { className: 'sd-h3' }, '🗺️ 世界地图'),
            h('span', { className: 'sd-hint' }, `${locations.length} 个地点 · ${edges.length} 条连接 · 拖拽节点松手保存坐标`)),
          focusTip ? h('div', { className: 'sd-world-focus-banner sd-world-focus-banner-warn' }, focusTip) : null,
          focusLocationRow ? h('div', { className: 'sd-world-focus-banner' },
            h('span', null, `正在查看：${focusLocationRow.name}`),
            h(Btn, { small: true, onClick: () => { setFocusId(null); setFocusTip('') } }, '取消高亮')) : null,
          h('div', { className: 'sd-world-map-scroll' }, locations.length === 0
            ? h('div', { className: 'sd-world-map-empty' }, '还没有地点：点「＋ 地点」手动添加，或加入清单让 AI 生成世界地图。')
            : h('svg', {
                ref: svgRef,
                className: 'sd-world-svg',
                viewBox: `0 0 ${size.w} ${size.h}`,
                role: 'img',
                'aria-label': '世界坐标地图',
                onMouseMove: moveDrag,
                onMouseUp: endDrag,
                onMouseLeave: endDrag,
              },
              h('rect', { className: 'sd-world-map-bg', x: 0, y: 0, width: size.w, height: size.h }),
              edges.map((edge) => {
                const from = coordsOf(edge.from)
                const to = coordsOf(edge.to)
                const hot = activeId !== null && (String(edge.from.id) === activeId || String(edge.to.id) === activeId)
                const distance = Number(edge.connection.distanceKm) || 0
                const days = Number(edge.connection.days) || 0
                const label = [distance ? `${distance} km` : '', days ? `${days} 天` : ''].filter(Boolean).join(' / ')
                return h('g', {
                  key: edge.id,
                  className: `sd-world-edge${hot ? ' sd-world-edge-hot' : ''}${activeId !== null && !hot ? ' sd-world-edge-dim' : ''}`,
                },
                  h('line', { className: 'sd-world-edge-line', x1: from.x, y1: from.y, x2: to.x, y2: to.y }),
                  label ? h('text', { className: 'sd-world-edge-label', x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 5, textAnchor: 'middle' }, label) : null,
                  h('title', null, `${edge.from.name} ↔ ${edge.to.name}${label ? '：' + label : ''}`))
              }),
              locations.map((location) => {
                const coords = coordsOf(location)
                const id = String(location.id)
                const hot = activeId === id
                const adjacent = neighborIds.has(id)
                const className = [
                  'sd-world-node',
                  LOCATION_TYPE_CLASS[location.type] ?? 'sd-loc-type-other',
                  hot ? 'sd-world-node-hot' : '',
                  adjacent ? 'sd-world-node-adj' : '',
                  String(focusId) === id ? 'sd-world-node-focus' : '',
                  drag && String(drag.id) === id ? 'sd-world-node-drag' : '',
                ].filter(Boolean).join(' ')
                return h('g', {
                  key: id,
                  className,
                  onMouseDown: (event) => startDrag(event, location),
                  onMouseEnter: () => setHoverId(id),
                  onMouseLeave: () => setHoverId(null),
                  onClick: () => {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false
                      return
                    }
                    setLocEditing(location)
                  },
                },
                  h('circle', { className: 'sd-world-node-circle', cx: coords.x, cy: coords.y, r: 11 }),
                  h('text', { className: 'sd-world-node-label', x: coords.x, y: coords.y + 25, textAnchor: 'middle' }, location.name || '未命名'),
                  h('title', null, `${location.name || '未命名'}（${typeLabel(location.type)}）${location.region ? ' · ' + location.region : ''} · 连接 ${(location.connections ?? []).length} 条${location.firstChapter ? ' · 首现第 ' + location.firstChapter + ' 章' : ''}`))
              }))),
          h('div', { className: 'sd-world-legend' }, LOCATION_TYPES.map(([value, label]) => h('span', { key: value, className: 'sd-world-legend-item' },
            h('span', { className: `sd-world-legend-swatch ${LOCATION_TYPE_CLASS[value]}` }), label)))),
        h('section', { className: 'sd-section sd-world-locations' },
          h('div', { className: 'sd-world-locations-head' },
            h('h3', { className: 'sd-h3' }, `地点（${locations.length}）`),
            h('span', { className: 'sd-hint' }, '点名称在地图上定位；编辑里可改坐标与连接道路。')),
          locations.length === 0
            ? h(Empty, null, '还没有地点。点右上角「＋ 地点」开始。')
            : h('div', { className: 'sd-loc-table' },
                h('div', { className: 'sd-loc-row sd-loc-row-head' },
                  h('div', null, '名称'),
                  h('div', null, '类型'),
                  h('div', null, '坐标'),
                  h('div', null, '连接'),
                  h('div', null, '首现章'),
                  h('div', { className: 'sd-loc-actions' }, '操作')),
                locations.map((location) => h('div', {
                  key: location.id,
                  className: `sd-loc-row${String(focusId) === String(location.id) ? ' sd-loc-row-focus' : ''}`,
                },
                  h('button', { type: 'button', className: 'sd-loc-name', onClick: () => locateLocation(location) }, location.name || '未命名'),
                  h('span', { className: 'sd-loc-type' }, h('span', { className: `sd-loc-dot ${LOCATION_TYPE_CLASS[location.type] ?? 'sd-loc-type-other'}` }), typeLabel(location.type)),
                  h('span', { className: 'sd-loc-coords' }, `${locationCoords(location, worldForm).x}, ${locationCoords(location, worldForm).y}`),
                  h('span', { className: 'sd-loc-connections' }, String((location.connections ?? []).length)),
                  h('span', { className: 'sd-loc-first' }, location.firstChapter ? `第 ${location.firstChapter} 章` : '—'),
                  h('div', { className: 'sd-loc-actions' },
                    h(Btn, { small: true, onClick: () => setLocEditing(location) }, '编辑'),
                    h(Btn, { small: true, kind: 'danger', onClick: () => removeLocation(location) }, '删除')))))),
        locEditing !== null
          ? h(LocationEditor, { location: locEditing?.id ? locEditing : {}, locations: bundle.locations ?? [], world: worldForm, projectId, onClose: () => setLocEditing(null), onSaved: onChanged })
          : null,
        viewOpen ? h(HtmlViewDialog, { title: '🌍 世界 · 只读视图', path: novelDeskViewPath('world', projectId), onClose: () => setViewOpen(false) }) : null,
      )
    }

    // ── 整本书流水线：数据归一化 + 向导 + 页面 + 总览卡 ─────────
    function normalizePipeline(input) {
      const raw = input && typeof input === 'object' ? input : {}
      const base = raw.base && typeof raw.base === 'object' ? raw.base : {}
      const budget = raw.budget && typeof raw.budget === 'object' ? raw.budget : {}
      const prepared = raw.prepared && typeof raw.prepared === 'object' ? raw.prepared : {}
      const status = PIPELINE_STATUS_META[raw.status] ? raw.status : 'idle'
      const stages = (Array.isArray(raw.stages) ? raw.stages : []).map((stage, index) => ({
        id: String(stage?.id ?? `stage-${index + 1}`),
        kind: String(stage?.kind ?? ''),
        name: String(stage?.name ?? PIPELINE_STAGE_NAME[stage?.id] ?? PIPELINE_STAGE_NAME[stage?.kind] ?? stage?.id ?? `阶段 ${index + 1}`),
        status: PIPELINE_STAGE_STATUS_META[stage?.status] ? stage.status : 'pending',
        chapterFrom: Number(stage?.chapterFrom) || 0,
        chapterTo: Number(stage?.chapterTo) || 0,
      }))
      return {
        status,
        mode: raw.mode === 'chapters' ? 'chapters' : 'book',
        count: Number(raw.count) || 0,
        runId: String(raw.runId ?? ''),
        sessionId: String(raw.sessionId ?? ''),
        targetChapter: Number(raw.targetChapter) || 0,
        base: {
          premise: String(base.premise ?? ''),
          genre: String(base.genre ?? ''),
          style: String(base.style ?? ''),
          era: String(base.era ?? ''),
          locations: String(base.locations ?? ''),
          characters: String(base.characters ?? ''),
          volumes: Number(base.volumes) || 3,
          chaptersPerVolume: Number(base.chaptersPerVolume) || 10,
          wordsPerChapter: Number(base.wordsPerChapter) || 3000,
        },
        budget: {
          maxTokens: Number(budget.maxTokens) || 0,
          maxCostCNY: Number(budget.maxCostCNY) || 0,
          usedTokens: Number(budget.usedTokens) || 0,
          usedCostCNY: Number(budget.usedCostCNY) || 0,
        },
        stages,
        currentStage: String(raw.currentStage ?? ''),
        prepared: { blueprint: prepared.blueprint === true, outline: prepared.outline === true },
        cleanup: normalizePipelineCleanup(raw.cleanup),
        notes: (Array.isArray(raw.notes) ? raw.notes : []).map((note, index) => ({
          key: index,
          at: String(note?.at ?? ''),
          text: String(note?.text ?? ''),
        })),
        updatedAt: String(raw.updatedAt ?? ''),
      }
    }

    function pipelineStageInfo(pipeline) {
      const stages = pipeline.stages ?? []
      const done = stages.filter((stage) => stage.status === 'done').length
      const total = stages.length
      const current = stages.find((stage) => stage.id === pipeline.currentStage) || stages.find((stage) => stage.status === 'running') || null
      return { done, total, current, percent: total > 0 ? Math.round((done / total) * 100) : pipeline.status === 'done' ? 100 : 0 }
    }

    function pipelineBudgetInfo(pipeline) {
      const budget = pipeline.budget ?? {}
      const tokenPercent = budget.maxTokens > 0 ? (budget.usedTokens / budget.maxTokens) * 100 : null
      const costPercent = budget.maxCostCNY > 0 ? (budget.usedCostCNY / budget.maxCostCNY) * 100 : null
      const percents = [tokenPercent, costPercent].filter((value) => value !== null)
      return { tokenPercent, costPercent, percent: percents.length > 0 ? Math.max(...percents) : null }
    }

    function pipelinePrepared(pipeline) {
      return pipeline.prepared?.blueprint === true && pipeline.prepared?.outline === true
    }

    function pipelineStatusMeta(pipeline) {
      return PIPELINE_STATUS_META[pipeline.status] ?? PIPELINE_STATUS_META.idle
    }

    /** 收尾报告（pipeline.cleanup）：不存在时返回 null（老 run 未收尾）。 */
    function normalizePipelineCleanup(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return null
      return {
        scope: String(input.scope ?? 'all'),
        acceptedProposals: Number(input.acceptedProposals) || 0,
        rejectedChapter: Number(input.rejectedChapter) || 0,
        closedReviews: Number(input.closedReviews) || 0,
        failed: Array.isArray(input.failed) ? input.failed : [],
        at: String(input.at ?? ''),
      }
    }

    /** 总览/整本书页共用：待采纳提案、未处理审阅、收尾报告。 */
    function pipelineCleanupStats(bundle) {
      const proposals = Array.isArray(bundle?.proposals) ? bundle.proposals : null
      const reviews = Array.isArray(bundle?.reviews) ? bundle.reviews : null
      const pendingProposals = proposals
        ? proposals.filter((proposal) => proposal?.status === 'pending').length
        : Number(bundle?.stats?.pendingProposals) || 0
      const openReviews = reviews
        ? reviews.filter((review) => review?.status !== 'fixed' && review?.status !== 'wontfix').length
        : Number(bundle?.stats?.openReviews) || 0
      return {
        pendingProposals,
        openReviews,
        cleanup: normalizePipelineCleanup(bundle?.pipeline?.cleanup),
      }
    }

    function pipelineInFinalCleanup(pipeline, stageInfo) {
      if (pipeline.currentStage === 'final-cleanup') return true
      const current = stageInfo?.current ?? null
      return Boolean(current && (current.id === 'final-cleanup' || current.kind === 'cleanup'))
    }

    function formatPipelineTokens(value) {
      const n = Number(value) || 0
      if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M'
      if (n >= 10000) return (n / 10000).toFixed(1) + ' 万'
      return String(n)
    }

    function formatPipelineMoney(value) {
      return '¥' + (Number(value) || 0).toFixed(2)
    }

    function pipelineWizardEstimate(form) {
      const chapters = Math.max(0, (Number(form.volumes) || 0) * (Number(form.chaptersPerVolume) || 0))
      const wordsPerChapter = Math.max(0, Number(form.wordsPerChapter) || 0)
      return { chapters, words: chapters * wordsPerChapter, tokens: Math.round(chapters * wordsPerChapter * 3.6) }
    }

    function PipelineWizard({ bundle, projectId, prefill, onClose, onFinished }) {
      const pipeline = normalizePipeline(bundle.pipeline)
      const project = bundle.project ?? {}
      const hasChapters = (bundle.chapters ?? []).length > 0
      const prepared = pipelinePrepared(pipeline)
      const currentMaxChapter = Math.max(0, ...(bundle.chapters ?? []).map((chapter) => Number(chapter.id) || 0))
      const outlineMaxChapter = Math.max(0, ...(bundle.outlines ?? []).map((outline) => Number(outline.chapter) || 0))
      const suggestedTarget = pipeline.targetChapter || Number(project.targetChapters) || outlineMaxChapter || (currentMaxChapter + 30)
      const [form, setForm] = useState(() => ({
        mode: pipeline.mode === 'chapters' ? 'chapters' : 'book',
        count: pipeline.count || 10,
        premise: prefill?.premise || prefill?.name || pipeline.base.premise || project.logline || project.name || '',
        genre: prefill?.genre || pipeline.base.genre || project.genre || '',
        style: pipeline.base.style,
        era: pipeline.base.era,
        locations: pipeline.base.locations,
        characters: pipeline.base.characters,
        volumes: pipeline.base.volumes || 3,
        chaptersPerVolume: pipeline.base.chaptersPerVolume || 10,
        wordsPerChapter: pipeline.base.wordsPerChapter || 3000,
        maxTokens: pipeline.budget.maxTokens || 0,
        maxCostCNY: pipeline.budget.maxCostCNY || 0,
        targetChapter: suggestedTarget,
      }))
      const [busy, setBusy] = useState('')
      const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))
      const estimate = pipelineWizardEstimate(form)
      const canStart = prepared || hasChapters
      const basePayload = () => ({
        premise: String(form.premise ?? '').trim(),
        genre: String(form.genre ?? '').trim(),
        style: String(form.style ?? '').trim(),
        era: String(form.era ?? '').trim(),
        locations: String(form.locations ?? '').trim(),
        characters: String(form.characters ?? '').trim(),
        volumes: Math.max(1, Number(form.volumes) || 3),
        chaptersPerVolume: Math.max(1, Number(form.chaptersPerVolume) || 10),
        wordsPerChapter: Math.max(100, Number(form.wordsPerChapter) || 3000),
      })
      const run = async (label, action) => {
        if (busy) return
        if (label === 'prepare' && !String(form.premise ?? '').trim()) {
          window.alert('请先填写一句话设定')
          return
        }
        setBusy(label)
        try {
          const value = await action()
          onFinished?.(value)
        } catch (error) {
          window.alert(error.message)
        } finally {
          setBusy('')
        }
      }
      const prepare = () => run('prepare', () => api('pipeline.prepare', {
        projectId,
        base: basePayload(),
        budget: { maxTokens: Math.max(0, Number(form.maxTokens) || 0), maxCostCNY: Math.max(0, Number(form.maxCostCNY) || 0) },
      }))
      const start = () => run('start', () => api('pipeline.startRun', {
        projectId,
        mode: form.mode,
        count: form.mode === 'chapters' ? Math.max(1, Number(form.count) || 10) : 0,
        targetChapter: form.mode === 'book' ? Math.max(0, Number(form.targetChapter) || 0) : 0,
        base: basePayload(),
        budget: { maxTokens: Math.max(0, Number(form.maxTokens) || 0), maxCostCNY: Math.max(0, Number(form.maxCostCNY) || 0) },
      }))
      const statusMeta = pipelineStatusMeta(pipeline)
      return h('div', { className: 'sd-modal-mask', onClick: (e) => e.target === e.currentTarget && onClose() },
        h('div', { className: 'sd-modal sd-modal-wide sd-pipe-wizard' },
          h('div', { className: 'sd-modal-head' },
            h('strong', null, '📚 生成整本书'),
            h(Tag, { tone: statusMeta.tone }, statusMeta.label),
            h(IconBtn, { onClick: onClose, title: '关闭' }, '✕')),
          h('div', { className: 'sd-modal-body sd-pipe-wizard-body' },
            h('section', { className: 'sd-pipe-wizard-section' },
              h('h3', { className: 'sd-h3' }, '生成模式'),
              h(ViewToggle, {
                value: form.mode,
                onChange: (value) => set('mode', value),
                options: [{ value: 'book', label: '生成全文' }, { value: 'chapters', label: '按 N 章生成' }],
              }),
              form.mode === 'chapters'
                ? h(Field, { label: '生成章数 N', hint: '本次只生成接下来 N 章，写完审一次、修一次后停。' },
                    h(TextInput, { value: form.count, type: 'number', min: 1, onChange: (value) => set('count', value) }))
                : h(Field, { label: '目标章数（写到第几章完结）', hint: `当前已写到第 ${currentMaxChapter} 章；留空或小于当前进度会启动失败。` },
                    h(TextInput, { value: form.targetChapter, type: 'number', min: currentMaxChapter + 1, onChange: (value) => set('targetChapter', value) }))),
            h('section', { className: 'sd-pipe-wizard-section' },
              h('h3', { className: 'sd-h3' }, '基础设定'),
              h('div', { className: 'sd-pipe-wizard-grid' },
                h(Field, { label: '一句话设定 *' }, h(TextArea, { value: form.premise, rows: 2, placeholder: '如：唐末长安，一名失忆的仵作追查连环命案，牵出二十年前的宫变。', onChange: (value) => set('premise', value) })),
                h(Field, { label: '类型' }, h(TextInput, { value: form.genre, placeholder: '武侠 / 科幻 / 悬疑 / 言情…', onChange: (value) => set('genre', value) })),
                h(Field, { label: '风格' }, h(TextInput, { value: form.style, placeholder: '冷峻 / 幽默 / 典雅…', onChange: (value) => set('style', value) })),
                h(Field, { label: '时代' }, h(TextInput, { value: form.era, placeholder: '如：唐·天宝年间 / 架空蒸汽时代', onChange: (value) => set('era', value) })),
                h(Field, { label: '地点' }, h(TextInput, { value: form.locations, placeholder: '如：长安、潼关、洛阳', onChange: (value) => set('locations', value) })),
                h(Field, { label: '关键人物' }, h(TextInput, { value: form.characters, placeholder: '如：沈砚、柳七、裴无咎', onChange: (value) => set('characters', value) }))),
              hasChapters ? h('p', { className: 'sd-hint' }, '已有正文：可以跳过准备直接生成；现有蓝图 / 大纲将作为依据。') : null),
            h('section', { className: 'sd-pipe-wizard-section' },
              h('h3', { className: 'sd-h3' }, '规模'),
              h('div', { className: 'sd-pipe-wizard-grid' },
                h(Field, { label: '卷数' }, h(TextInput, { value: form.volumes, type: 'number', min: 1, onChange: (value) => set('volumes', value) })),
                h(Field, { label: '每卷章数' }, h(TextInput, { value: form.chaptersPerVolume, type: 'number', min: 1, onChange: (value) => set('chaptersPerVolume', value) })),
                h(Field, { label: '每章字数' }, h(TextInput, { value: form.wordsPerChapter, type: 'number', min: 100, onChange: (value) => set('wordsPerChapter', value) }))),
              h('div', { className: 'sd-pipe-wizard-total' },
                h('span', null, `共 ${estimate.chapters} 章`),
                h('span', null, `预计 ${formatPipelineTokens(estimate.words)} 字`),
                estimate.tokens > 0 ? h('span', { className: 'sd-hint' }, `粗估 ${formatPipelineTokens(estimate.tokens)} token`) : null)),
            h('section', { className: 'sd-pipe-wizard-section' },
              h('h3', { className: 'sd-h3' }, '预算（0 = 不限）'),
              h('div', { className: 'sd-pipe-wizard-grid' },
                h(Field, { label: 'token 上限' }, h(TextInput, { value: form.maxTokens, type: 'number', min: 0, onChange: (value) => set('maxTokens', value) })),
                h(Field, { label: '费用上限（¥）' }, h(TextInput, { value: form.maxCostCNY, type: 'number', min: 0, onChange: (value) => set('maxCostCNY', value) }))),
              h('p', { className: 'sd-pipe-wizard-warn' }, '⚠ 估算不准，仅作参考：实际用量会受上下文、审阅与修订影响，明显更高。')),
            h('div', { className: 'sd-pipe-wizard-state' },
              h('span', { className: 'sd-hint' }, `蓝图：${pipeline.prepared.blueprint ? '已验收' : '未验收'} · 大纲：${pipeline.prepared.outline ? '已验收' : '未验收'} · 当前状态：${statusMeta.label}`),
              pipeline.status === 'preparing' ? h('span', { className: 'sd-hint' }, '准备阶段进行中：完成后在工作台验收，再回来点②。') : null)),
          h('div', { className: 'sd-modal-foot sd-pipe-wizard-actions' },
            h(Btn, { onClick: onClose }, '取消'),
            h(Btn, {
              onClick: prepare,
              disabled: !!busy || pipeline.status === 'running',
            }, busy === 'prepare' ? '准备中…' : '① 准备蓝图与大纲'),
            h(Btn, {
              kind: 'primary',
              onClick: start,
              disabled: !!busy || !canStart || pipeline.status === 'preparing' || pipeline.status === 'running',
              title: canStart ? '' : '需要先完成准备并验收蓝图与大纲（或已有正文）',
            }, busy === 'start' ? '启动中…' : form.mode === 'chapters' ? `② 生成接下来 ${Math.max(1, Number(form.count) || 10)} 章` : '② 生成全文')),
        ),
      )
    }

    function PipelineRunPanel({ bundle, projectId, onChanged, onGoTab, onOpenWizard }) {
      const [live, setLive] = useState(null)
      const [busy, setBusy] = useState('')
      const pipeline = normalizePipeline(live?.pipeline ?? bundle.pipeline)
      const stageInfo = pipelineStageInfo(pipeline)
      const budgetInfo = pipelineBudgetInfo(pipeline)
      const statusMeta = pipelineStatusMeta(pipeline)
      const prepared = pipelinePrepared(pipeline)
      const hasChapters = (bundle.chapters ?? []).length > 0
      const active = pipeline.status === 'preparing' || pipeline.status === 'running'
      const load = useCallback(async () => {
        try {
          const value = await api('pipeline.get', { projectId })
          setLive({ pipeline: value?.pipeline ?? value ?? null, usage: value?.usage ?? null })
        } catch {
          /* 后端可能尚未实现 pipeline.get：静默降级为 bundle.pipeline */
        }
      }, [projectId])
      useEffect(() => { load() }, [load])
      useEffect(() => {
        if (!active) return undefined
        const timer = setInterval(() => { load() }, PIPELINE_POLL_MS)
        return () => clearInterval(timer)
      }, [active, load])
      const run = async (label, action) => {
        if (busy) return
        setBusy(label)
        try {
          await action()
          await load()
          onChanged?.()
        } catch (error) {
          window.alert(error.message)
        } finally {
          setBusy('')
        }
      }
      const markPrepared = () => run('prepared', () => api('pipeline.markPrepared', { projectId }))
      const startRun = (mode) => run('start', () => api('pipeline.startRun', { projectId, mode, count: mode === 'chapters' ? pipeline.count || 10 : 0 }))
      const pause = () => run('pause', () => api('pipeline.pause', { projectId }))
      const resume = () => run('resume', () => api('pipeline.resume', { projectId }))
      const stop = () => {
        if (!window.confirm('停止本次流程？会清除运行状态与阶段进度，正文与账本保留。')) return
        run('stop', () => api('pipeline.reset', { projectId }))
      }
      const restart = () => {
        if (!window.confirm('重新开始会新建一次 runId 并回到未开始状态；正文、账本与提案都保留。继续？')) return
        run('restart', () => api('pipeline.reset', { projectId }))
      }
      const stuckResume = () => {
        if (!window.confirm('流程卡住时手动恢复：由后端重新推动会话，继续本次生成。继续？')) return
        resume()
      }
      const openSession = () => {
        if (!pipeline.sessionId) {
          window.alert('还没有生成会话：先完成准备并启动一次生成。')
          return
        }
        try {
          const workspace = clientCtx?.get?.('uiWorkspace')
          const opened = workspace?.openSession?.(pipeline.sessionId)
          if (!opened) throw new Error('无法打开会话')
        } catch {
          window.alert(`请到工作区会话列表打开该会话（ID：${pipeline.sessionId}）。`)
        }
      }
      const cleanupStats = pipelineCleanupStats(bundle)
      const cleanup = cleanupStats.cleanup
      const hasResidual = cleanupStats.pendingProposals > 0 || cleanupStats.openReviews > 0
      const inFinalCleanup = pipelineInFinalCleanup(pipeline, stageInfo)
      const finalizeCleanup = () => {
        if (busy) return
        if (!window.confirm('收尾清理会采纳非章节类待处理提案、驳回过期章节提案、归档未处理审阅；不可撤销，但正文与历史都会保留。继续？')) return
        run('cleanup', () => api('pipeline.finalize', { projectId, scope: 'all' }))
      }
      const cleanupButton = (kind) => h(Btn, { key: 'cleanup', kind, disabled: !!busy, onClick: finalizeCleanup }, busy === 'cleanup' ? '收尾中…' : '收尾清理')
      const backfillCleanup = () => {
        if (busy) return
        if (!window.confirm('补跑收尾会让 AI 通读全书、补齐人物/事实/事件/高光/伏笔/冲突/地点/大纲/注意力账本（只提案、不改正文），完成后自动清理残留与归档审阅。可能花费较多 token，继续？')) return
        run('backfill', () => api('pipeline.backfill', { projectId }))
      }
      const backfillButton = (kind) => h(Btn, { key: 'backfill', kind, disabled: !!busy, onClick: backfillCleanup }, busy === 'backfill' ? '启动中…' : '补跑收尾（补齐账本）')
      const cleanupStat = (label, value) => h('div', { key: label, className: 'sd-pipe-cleanup-stat' },
        h('div', { className: 'sd-pipe-cleanup-value' }, String(value)),
        h('div', { className: 'sd-pipe-cleanup-label' }, label))
      const cleanupCard = cleanup
        ? h('section', { className: 'sd-pipe-cleanup' },
            h('div', { className: 'sd-pipe-section-head' },
              h('h3', { className: 'sd-h3' }, '✅ 收尾完成'),
              h('span', { className: 'sd-hint' }, cleanup.at ? formatDateTime(cleanup.at) : '')),
            h('div', { className: 'sd-pipe-cleanup-grid' },
              cleanupStat('采纳提案', cleanup.acceptedProposals),
              cleanupStat('驳回过期章节提案', cleanup.rejectedChapter),
              cleanupStat('归档审阅', cleanup.closedReviews),
              cleanupStat('失败', cleanup.failed.length)),
            cleanup.failed.length > 0
              ? h('details', { className: 'sd-pipe-cleanup-failed' },
                  h('summary', null, `失败 ${cleanup.failed.length} 条（可手动处理）`),
                  h('div', { className: 'sd-pipe-cleanup-failed-list' }, cleanup.failed.map((item, index) => h('div', { key: index, className: 'sd-pipe-cleanup-failed-item' }, typeof item === 'string' ? item : JSON.stringify(item)))))
              : null,
            h('p', { className: 'sd-pipe-cleanup-hint' }, '工作区已清理，可以开始读稿或发起第二次审阅。'),
            hasResidual ? h('div', { className: 'sd-pipe-cleanup-actions' }, cleanupButton(undefined)) : null)
        : null
      const actions = []
      if (pipeline.status === 'preparing') {
        actions.push(h(Btn, { key: 'prepared', kind: 'primary', disabled: !!busy, onClick: markPrepared }, busy === 'prepared' ? '标记中…' : '我验收完了：蓝图与大纲'))
        actions.push(h(Btn, { key: 'pause', onClick: pause, disabled: !!busy }, '暂停'))
      } else if (pipeline.status === 'running') {
        actions.push(h(Btn, { key: 'pause', onClick: pause, disabled: !!busy }, busy === 'pause' ? '暂停中…' : '暂停'))
        actions.push(h(Btn, { key: 'stop', kind: 'danger', onClick: stop, disabled: !!busy }, '停止'))
      } else if (pipeline.status === 'paused') {
        actions.push(h(Btn, { key: 'resume', kind: 'primary', onClick: resume, disabled: !!busy }, busy === 'resume' ? '恢复中…' : '恢复'))
        actions.push(h(Btn, { key: 'stop', kind: 'danger', onClick: stop, disabled: !!busy }, '停止'))
      } else if (pipeline.status === 'stuck') {
        actions.push(h(Btn, { key: 'resume', kind: 'primary', onClick: stuckResume, disabled: !!busy }, '手动继续'))
        actions.push(h(Btn, { key: 'stop', kind: 'danger', onClick: stop, disabled: !!busy }, '停止'))
      } else if (pipeline.status === 'done') {
        actions.push(h(Btn, { key: 'agents', kind: 'primary', onClick: () => onGoTab?.('agents') }, '交给独立审稿人'))
        actions.push(h(Btn, { key: 'attention', onClick: () => onGoTab?.('attention') }, '打开注意力页冷读'))
        actions.push(backfillButton())
        if (hasResidual) actions.push(cleanupButton())
        actions.push(h(Btn, { key: 'restart', onClick: restart, disabled: !!busy }, '重新开始'))
      } else {
        actions.push(h(Btn, { key: 'wizard', kind: pipeline.status === 'idle' ? 'primary' : undefined, onClick: onOpenWizard }, '准备蓝图与大纲'))
        if (prepared || hasChapters) {
          actions.push(h(Btn, { key: 'book', kind: 'primary', onClick: () => startRun('book'), disabled: !!busy }, busy === 'start' ? '启动中…' : '生成全文'))
          actions.push(h(Btn, { key: 'chapters', onClick: () => startRun('chapters'), disabled: !!busy }, `生成接下来 ${pipeline.count || 10} 章`))
        }
        if (pipeline.status === 'aborted') actions.push(h(Btn, { key: 'restart', onClick: restart, disabled: !!busy }, '重新开始'))
      }
      if (pipeline.sessionId) actions.push(h(Btn, { key: 'session', onClick: openSession }, '去对话查看'))
      if (onOpenWizard) actions.push(h(Btn, { key: 'settings', small: true, onClick: onOpenWizard }, '生成设置'))
      const refreshUsage = live?.usage ?? null
      const budgetPercent = budgetInfo.percent
      const budgetClass = budgetPercent === null ? '' : budgetPercent > 100 ? ' sd-pipe-budget-danger' : budgetPercent > 80 ? ' sd-pipe-budget-warn' : ''
      return h(React.Fragment, null,
        h('div', { className: 'sd-pagehead' },
          h('div', null,
            h('h2', { className: 'sd-h2' }, '📚 整本书'),
            h('p', { className: 'sd-desc' }, '全自动长流程：准备 → 作者验收蓝图与大纲 → 生成（按卷写作 / 审阅 / 修订）→ 总审 → 交给独立审稿人。流程由后端新会话的 goal + subagent 自动推进，工作台不发「继续」消息。')),
          h('div', { className: 'sd-pagehead-actions' },
            h(Btn, { onClick: onOpenWizard }, '生成设置'),
            h(Btn, { onClick: () => { load(); onChanged?.() } }, '刷新'))),
        h('section', { className: 'sd-pipe-status-card' },
          h('div', { className: 'sd-pipe-status-head' },
            h('span', { className: `sd-pipe-status-chip sd-pipe-status-${pipeline.status}` }, statusMeta.label),
            h('span', { className: 'sd-pipe-status-mode' }, pipeline.mode === 'chapters' ? `按 ${pipeline.count || 10} 章生成` : '生成全文'),
            h('span', { className: 'sd-pipe-status-target' }, pipeline.targetChapter > 0 ? `目标第 ${pipeline.targetChapter} 章` : '目标章数未定'),
            h('span', { className: 'sd-pipe-status-session' }, `会话：${pipeline.sessionId ? pipeline.sessionId.slice(0, 12) + '…' : '—'}`)),
          h('div', { className: 'sd-pipe-status-meta' },
            h('span', null, stageInfo.current ? `当前阶段：${stageInfo.current.name}（${Math.min(stageInfo.done + 1, stageInfo.total)}/${stageInfo.total}）` : '当前阶段：未开始'),
            h('span', null, pipeline.runId ? `runId：${pipeline.runId}` : 'runId：—')),
          h('div', { className: 'sd-pipe-actions' }, actions),
          h('div', { className: 'sd-pipe-progress' },
            h('div', { className: 'sd-pipe-progress-head' },
              h('span', null, `阶段进度 ${stageInfo.done}/${stageInfo.total}`),
              h('span', null, `${stageInfo.percent}%`)),
            h('div', { className: 'sd-pipe-progress-bar' }, h('div', { className: 'sd-pipe-progress-fill', style: { width: `${stageInfo.percent}%` } })))),
        pipeline.status === 'done'
          ? h(React.Fragment, null,
              h('div', { className: 'sd-pipe-banner sd-pipe-banner-done' }, '🎉 全书完成：随时把整本书交给独立审稿人冷读，检查每章注意力分与最低章。'),
              cleanupCard,
              !cleanup && hasResidual
                ? h('div', { className: 'sd-pipe-banner sd-pipe-banner-warn sd-pipe-cleanup-banner' },
                    h('span', null, `生成完成但未收尾：还有 ${cleanupStats.pendingProposals} 条待采纳提案 / ${cleanupStats.openReviews} 条未处理审阅`),
                    backfillButton('primary'),
                    cleanupButton())
                : null)
          : null,
        (pipeline.status === 'running' || pipeline.status === 'structuring') && inFinalCleanup
          ? h('div', { className: 'sd-pipe-banner sd-pipe-banner-info' }, '🧹 收尾中：补齐账本 + 清理残留（人物 / 事实 / 高光 / 伏笔 / 审阅）')
          : null,
        pipeline.status === 'stuck' ? h('div', { className: 'sd-pipe-banner sd-pipe-banner-warn' }, '⚠ 流程卡住：会话可能已停止推进。可先「去对话查看」，必要时点「手动继续」让后端恢复（默认不会自动发送）。') : null,
        budgetPercent !== null && budgetPercent > 100 ? h('div', { className: 'sd-pipe-banner sd-pipe-banner-danger' }, '⚠ 预算已超过上限：建议暂停并在生成设置里调高预算，或停止本次流程。') : null,
        h('section', { className: 'sd-pipe-budget' },
          h('div', { className: 'sd-pipe-section-head' }, h('h3', { className: 'sd-h3' }, '预算'), h('span', { className: 'sd-hint' }, '⚠ 估算不准，仅作参考；0 = 不限')),
          h('div', { className: 'sd-pipe-budget-row' },
            h('span', { className: 'sd-pipe-budget-label' }, 'token'),
            h('span', { className: 'sd-pipe-budget-value' }, `${formatPipelineTokens(pipeline.budget.usedTokens)} / ${pipeline.budget.maxTokens > 0 ? formatPipelineTokens(pipeline.budget.maxTokens) : '不限'}`),
            h('div', { className: 'sd-pipe-budget-bar' }, h('div', {
              className: `sd-pipe-budget-fill${budgetInfo.tokenPercent !== null && budgetInfo.tokenPercent > 100 ? ' sd-pipe-budget-danger' : budgetInfo.tokenPercent !== null && budgetInfo.tokenPercent > 80 ? ' sd-pipe-budget-warn' : ''}`,
              style: { width: `${Math.min(100, budgetInfo.tokenPercent ?? 0)}%` },
            }))),
          h('div', { className: 'sd-pipe-budget-row' },
            h('span', { className: 'sd-pipe-budget-label' }, '费用'),
            h('span', { className: 'sd-pipe-budget-value' }, `${formatPipelineMoney(pipeline.budget.usedCostCNY)} / ${pipeline.budget.maxCostCNY > 0 ? formatPipelineMoney(pipeline.budget.maxCostCNY) : '不限'}`),
            h('div', { className: 'sd-pipe-budget-bar' }, h('div', {
              className: `sd-pipe-budget-fill${budgetInfo.costPercent !== null && budgetInfo.costPercent > 100 ? ' sd-pipe-budget-danger' : budgetInfo.costPercent !== null && budgetInfo.costPercent > 80 ? ' sd-pipe-budget-warn' : ''}`,
              style: { width: `${Math.min(100, budgetInfo.costPercent ?? 0)}%` },
            }))),
          refreshUsage ? h('p', { className: 'sd-hint' }, `本次会话用量参考：${formatPipelineTokens(refreshUsage.tokens)} token · ${formatPipelineMoney(refreshUsage.costCNY)}（${budgetPercent === null ? '未设总预算' : `总预算已用 ${Math.round(budgetPercent)}%`}）`) : null,
          h('div', { className: `sd-pipe-budget-summary${budgetClass}` }, budgetPercent === null ? '总预算：未设上限（可在生成设置里填写 token / 费用上限）' : `总预算使用 ${Math.round(budgetPercent)}%`)),
        h('section', { className: 'sd-pipe-stages' },
          h('div', { className: 'sd-pipe-section-head' }, h('h3', { className: 'sd-h3' }, `阶段（${stageInfo.done}/${stageInfo.total}）`), h('span', { className: 'sd-hint' }, '阶段由 AI 通过工作台工具上报')),
          pipeline.stages.length === 0
            ? h('p', { className: 'sd-pipe-empty' }, '阶段还没生成：准备完成后由后端写入准备 / 各卷 / 总审阶段。')
            : h('div', { className: 'sd-pipe-stage-list' }, pipeline.stages.map((stage, index) => {
                const stageMeta = PIPELINE_STAGE_STATUS_META[stage.status] ?? PIPELINE_STAGE_STATUS_META.pending
                const current = String(pipeline.currentStage) === String(stage.id)
                return h('div', { key: stage.id, className: `sd-pipe-stage${current ? ' sd-pipe-stage-current' : ''} sd-pipe-stage-${stage.status}` },
                  h('span', { className: 'sd-pipe-stage-icon' }, stageMeta.icon),
                  h('span', { className: 'sd-pipe-stage-name' }, `${index + 1}. ${stage.name}`),
                  h('span', { className: 'sd-pipe-stage-range' }, stage.chapterFrom && stage.chapterTo ? `第 ${stage.chapterFrom}–${stage.chapterTo} 章` : stage.chapterFrom ? `第 ${stage.chapterFrom} 章起` : ''),
                  h(Tag, { tone: stageMeta.tone }, stageMeta.label))
              }))),
        h('section', { className: 'sd-pipe-notes' },
          h('div', { className: 'sd-pipe-section-head' }, h('h3', { className: 'sd-h3' }, `进度提示（${pipeline.notes.length}）`)),
          pipeline.notes.length === 0
            ? h('p', { className: 'sd-pipe-empty' }, '还没有进度提示。运行中 AI 会通过工作台工具写回。')
            : h('div', { className: 'sd-pipe-note-list' }, pipeline.notes.slice(-20).reverse().map((note) => h('div', { key: note.key, className: 'sd-pipe-note' },
                h('span', { className: 'sd-pipe-note-time' }, note.at ? formatDateTime(note.at) : '—'),
                h('span', { className: 'sd-pipe-note-text' }, note.text))))),
        prepared ? h('p', { className: 'sd-pipe-prepared-hint' }, '✓ 蓝图与大纲已验收，可以生成。') : h('p', { className: 'sd-pipe-prepared-hint' }, '准备完成后请先在工作台验收蓝图与大纲（提案页），再回来点「我验收完了」。'),
      )
    }

    // ── 扩写：数据归一化 + 方案辅助 ───────────────────────────
    function normalizeExpansion(input) {
      const raw = input && typeof input === 'object' ? input : {}
      const scope = raw.scope && typeof raw.scope === 'object' ? raw.scope : {}
      const plan = raw.plan && typeof raw.plan === 'object' ? raw.plan : {}
      const budget = raw.budget && typeof raw.budget === 'object' ? raw.budget : {}
      const status = EXPANSION_STATUS_META[raw.status] ? raw.status : 'idle'
      const toArray = (value) => (Array.isArray(value) ? value : [])
      return {
        status,
        mode: raw.mode === 'chapter' ? 'chapter' : 'book',
        scope: {
          type: scope.type === 'chapter' ? 'chapter' : 'book',
          chapters: toArray(scope.chapters).map((value) => Number(value)).filter((value) => value > 0),
        },
        targetWords: Number(raw.targetWords) || 0,
        chapterTargets: toArray(raw.chapterTargets).map((item) => ({
          chapter: Number(item?.chapter) || 0,
          targetWords: Number(item?.targetWords) || 0,
          type: String(item?.type ?? ''),
          additions: toArray(item?.additions).map(String),
          outlineChangeIds: toArray(item?.outlineChangeIds).map(String),
        })).filter((item) => item.chapter > 0),
        plan: {
          diagnosis: toArray(plan.diagnosis),
          capacity: toArray(plan.capacity),
          outlineChanges: toArray(plan.outlineChanges),
          confirmations: toArray(plan.confirmations),
          notes: toArray(plan.notes),
        },
        outlineChanges: toArray(raw.outlineChanges),
        approvedOutlineChanges: toArray(raw.approvedOutlineChanges),
        runId: String(raw.runId ?? ''),
        sessionId: String(raw.sessionId ?? ''),
        budget: {
          maxTokens: Number(budget.maxTokens) || 0,
          maxCostCNY: Number(budget.maxCostCNY) || 0,
          usedTokens: Number(budget.usedTokens) || 0,
          usedCostCNY: Number(budget.usedCostCNY) || 0,
        },
        notes: toArray(raw.notes).map((note, index) => ({ key: index, at: String(note?.at ?? ''), text: String(note?.text ?? '') })),
        report: raw.report ?? raw.result ?? null,
        planConfirmed: raw.planConfirmed === true || raw.confirmed === true,
        updatedAt: String(raw.updatedAt ?? ''),
      }
    }

    function expansionBudgetInfo(expansion) {
      const budget = expansion.budget ?? {}
      const tokenPercent = budget.maxTokens > 0 ? (budget.usedTokens / budget.maxTokens) * 100 : null
      const costPercent = budget.maxCostCNY > 0 ? (budget.usedCostCNY / budget.maxCostCNY) * 100 : null
      const percents = [tokenPercent, costPercent].filter((value) => value !== null)
      return { tokenPercent, costPercent, percent: percents.length > 0 ? Math.max(...percents) : null }
    }

    function expansionEntryText(entry) {
      if (entry === null || entry === undefined) return ''
      if (typeof entry === 'string' || typeof entry === 'number') return String(entry)
      if (typeof entry === 'object') {
        const chapter = Number(entry.chapter) > 0 ? `第 ${entry.chapter} 章：` : ''
        const candidate = entry.text ?? entry.message ?? entry.note ?? entry.title ?? entry.name ?? entry.diagnosis
        if (candidate !== undefined && candidate !== null) return chapter + String(candidate)
        try { return JSON.stringify(entry) } catch { return String(entry) }
      }
      return String(entry)
    }

    function expansionCapacityRows(expansion, bundle) {
      const chapters = bundle?.chapters ?? []
      const chapterWords = new Map(chapters.map((chapter) => [Number(chapter.id), Number(chapter.words) || String(chapter.content ?? '').length]))
      const outlines = bundle?.outlines ?? []
      const beatCounts = new Map(outlines.map((outline) => [Number(outline.chapter), Array.isArray(outline.beats) ? outline.beats.length : 0]))
      const targetByChapter = new Map(expansion.chapterTargets.map((item) => [Number(item.chapter), item.targetWords]))
      const rawRows = expansion.plan.capacity.length > 0 ? expansion.plan.capacity : expansion.chapterTargets
      return rawRows.map((entry, index) => {
        if (!entry || typeof entry !== 'object') return null
        const chapter = Number(entry.chapter ?? entry.id ?? expansion.chapterTargets[index]?.chapter) || 0
        if (!chapter) return null
        return {
          chapter,
          currentWords: Number(entry.currentWords ?? entry.current ?? entry.words ?? chapterWords.get(chapter)) || 0,
          beats: Number(entry.beats ?? entry.beatCount ?? beatCounts.get(chapter)) || 0,
          maxWords: entry.maxWords ?? entry.max ?? entry.capacity ?? null,
          targetWords: Number(entry.targetWords ?? entry.target ?? targetByChapter.get(chapter)) || 0,
          level: String(entry.level ?? entry.status ?? ''),
        }
      }).filter(Boolean)
    }

    function expansionReportData(expansion, bundle) {
      const chapters = bundle?.chapters ?? []
      const chapterWords = new Map(chapters.map((chapter) => [Number(chapter.id), Number(chapter.words) || String(chapter.content ?? '').length]))
      const report = expansion.report && typeof expansion.report === 'object' ? expansion.report : {}
      const achievements = expansion.chapterTargets.map((item) => {
        const currentWords = Number(chapterWords.get(Number(item.chapter))) || 0
        return { ...item, currentWords, achieved: item.targetWords > 0 && currentWords >= item.targetWords }
      })
      const totalWords = Number(report.totalWords) || chapters.reduce((sum, chapter) => sum + (Number(chapter.words) || 0), 0)
      const targetTotal = expansion.chapterTargets.reduce((sum, item) => sum + item.targetWords, 0) || expansion.targetWords * (expansion.mode === 'chapter' ? 1 : Math.max(1, chapters.length))
      const attention = report.attention ?? report.coldRead ?? null
      return {
        totalWords,
        targetTotal,
        achievements,
        achievedCount: achievements.filter((item) => item.achieved).length,
        additions: Array.isArray(report.additions) ? report.additions : [],
        attention,
        outlineChanges: expansion.approvedOutlineChanges.length > 0 ? expansion.approvedOutlineChanges : expansion.outlineChanges,
        notes: expansion.notes,
      }
    }

    function expansionOutlineKey(change, index) {
      return String(change?.id ?? change?.title ?? `outline-change-${index}`)
    }

    function expansionApprovedChangeKeys(expansion) {
      const keys = new Set()
      for (const change of expansion.approvedOutlineChanges ?? []) {
        for (const candidate of [change?.id, change?.title, change?.proposalId]) {
          if (candidate !== undefined && candidate !== null && String(candidate)) keys.add(String(candidate))
        }
      }
      return keys
    }

    function expansionOutlineIsApproved(expansion, change, index) {
      const keys = expansionApprovedChangeKeys(expansion)
      return [change?.id, change?.title, change?.proposalId, expansionOutlineKey(change, index)]
        .filter((value) => value !== undefined && value !== null && String(value))
        .some((value) => keys.has(String(value)))
    }

    function expansionConfirmationNotes(expansion) {
      const keywords = ['待作者批准', '需确认', '请确认', '待确认', '请拍板']
      return (expansion.plan.notes ?? []).filter((note) => {
        const text = typeof note === 'string' ? note : expansionEntryText(note)
        return keywords.some((keyword) => text.includes(keyword))
      })
    }

    function openChatSessionById(sessionId) {
      if (!sessionId) {
        window.alert('还没有生成会话：先开始一次生成或扩写。')
        return
      }
      try {
        const workspace = clientCtx?.get?.('uiWorkspace')
        const opened = workspace?.openSession?.(sessionId)
        if (!opened) throw new Error('无法打开会话')
      } catch {
        window.alert(`请到工作区会话列表打开该会话（ID：${sessionId}）。`)
      }
    }

    // ── 扩写子模块：配置 / 方案 / 大纲闸门 / 执行 / 报告 ─────────
    function ExpansionPanel({ bundle, projectId, intent, onChanged, onStatusChange }) {
      const chapters = bundle.chapters ?? []
      const maxChapter = chapters.reduce((max, chapter) => Math.max(max, Number(chapter.id) || 0), 0) || Number(bundle.project?.targetChapters) || 1
      const [live, setLive] = useState(null)
      const [busy, setBusy] = useState('')
      const [planConfirmed, setPlanConfirmed] = useState(false)
      const [targets, setTargets] = useState(null)
      const [outlineApproved, setOutlineApproved] = useState([])
      const intentTokenRef = useRef(null)
      const expansion = normalizeExpansion(live?.expansion ?? bundle.expansion)
      const statusMeta = EXPANSION_STATUS_META[expansion.status] ?? EXPANSION_STATUS_META.idle
      const budgetInfo = expansionBudgetInfo(expansion)
      const active = expansion.status === 'planning' || expansion.status === 'structuring' || expansion.status === 'running'
      const hasChapters = chapters.length > 0
      const outlineChangeList = expansion.plan.outlineChanges.length > 0 ? expansion.plan.outlineChanges : expansion.outlineChanges
      const outlineChangeSignature = JSON.stringify(outlineChangeList.map((change, index) => expansionOutlineKey(change, index)))
      const approvedOutlineSignature = JSON.stringify((expansion.approvedOutlineChanges ?? []).map((change) => [change?.id ?? '', change?.title ?? '', change?.proposalId ?? '']))
      const confirmations = expansion.plan.confirmations
      const fallbackNotes = expansionConfirmationNotes(expansion)
      const confirmationCount = confirmations.length > 0 ? confirmations.length : fallbackNotes.length
      const outlineApprovedCount = outlineChangeList.filter((change, index) => outlineApproved.includes(expansionOutlineKey(change, index))).length
      const allOutlineApproved = outlineChangeList.length > 0 && outlineApprovedCount >= outlineChangeList.length
      const [form, setForm] = useState(() => ({
        mode: intent?.mode === 'chapter' ? 'chapter' : 'book',
        chapter: Number(intent?.chapter) || maxChapter,
        targetWords: '',
        allowOutlineChanges: false,
        additions: { subplot: false, person: false, place: false, foreshadow: false, conflict: false },
        additionLimit: 0,
        sampleChapters: 0,
        maxTokens: 0,
        maxCostCNY: 0,
      }))
      const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))
      const setAddition = (key, value) => setForm((prev) => ({ ...prev, additions: { ...prev.additions, [key]: value } }))
      const load = useCallback(async () => {
        try {
          const value = await api('expansion.get', { projectId })
          setLive({ expansion: value?.expansion ?? value ?? null, usage: value?.usage ?? null })
        } catch {
          /* 后端可能尚未实现 expansion.get：静默降级为 bundle.expansion */
        }
      }, [projectId])
      useEffect(() => { load() }, [load])
      useEffect(() => {
        if (!active) return undefined
        const timer = setInterval(() => { load() }, EXPANSION_POLL_MS)
        return () => clearInterval(timer)
      }, [active, load])
      useEffect(() => {
        if (!intent) return
        const token = String(intent.token ?? '')
        if (intentTokenRef.current === token) return
        intentTokenRef.current = token
        setForm((prev) => ({
          ...prev,
          mode: intent.mode === 'chapter' ? 'chapter' : 'book',
          chapter: Number(intent.chapter) || prev.chapter,
          targetWords: '',
        }))
      }, [intent])
      const targetsSignature = JSON.stringify(expansion.chapterTargets)
      useEffect(() => {
        if (expansion.status !== 'plan-ready') return
        const fallback = expansion.mode === 'chapter'
          ? [{ chapter: Number(form.chapter) || maxChapter, targetWords: Number(form.targetWords) || 0, type: 'enrich', additions: [], outlineChangeIds: [] }]
          : chapters.map((chapter) => ({ chapter: Number(chapter.id), targetWords: Number(expansion.targetWords) || Number(form.targetWords) || 0, type: 'enrich', additions: [], outlineChangeIds: [] }))
        setTargets(expansion.chapterTargets.length > 0 ? expansion.chapterTargets.map((item) => ({ ...item })) : fallback)
        setPlanConfirmed(expansion.planConfirmed === true)
      }, [expansion.status, targetsSignature])
      useEffect(() => {
        onStatusChange?.(expansion.status)
      }, [expansion.status, onStatusChange])
      useEffect(() => {
        if (expansion.status !== 'plan-ready') return
        const approvedKeys = expansionApprovedChangeKeys(expansion)
        const defaults = []
        outlineChangeList.forEach((change, index) => {
          const aliases = [change?.id, change?.title, change?.proposalId, expansionOutlineKey(change, index)]
            .filter((value) => value !== undefined && value !== null && String(value))
            .map(String)
          if (aliases.some((alias) => approvedKeys.has(alias))) defaults.push(expansionOutlineKey(change, index))
        })
        setOutlineApproved(defaults)
      }, [expansion.status, outlineChangeSignature, approvedOutlineSignature])
      const toggleOutlineChange = (key) => setOutlineApproved((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]))
      const approveAllOutline = () => setOutlineApproved(outlineChangeList.map((change, index) => expansionOutlineKey(change, index)))
      const clearAllOutline = () => setOutlineApproved([])
      const run = async (label, action) => {
        if (busy) return
        setBusy(label)
        try {
          await action()
          await load()
          onChanged?.()
        } catch (error) {
          window.alert(error.message)
        } finally {
          setBusy('')
        }
      }
      const plan = () => {
        if (!(Number(form.targetWords) > 0)) {
          window.alert('请先填写目标字数（必填，无默认值）')
          return
        }
        run('plan', () => api('expansion.plan', {
          projectId,
          mode: form.mode,
          targetWords: Number(form.targetWords),
          scope: form.mode === 'chapter' ? { type: 'chapter', chapters: [Number(form.chapter) || maxChapter] } : { type: 'book', chapters: [] },
          allowOutlineChanges: form.allowOutlineChanges === true,
          additions: form.additions,
          additionLimit: Math.max(0, Number(form.additionLimit) || 0),
          sampleChapters: Math.max(0, Number(form.sampleChapters) || 0),
          budget: { maxTokens: Math.max(0, Number(form.maxTokens) || 0), maxCostCNY: Math.max(0, Number(form.maxCostCNY) || 0) },
        }))
      }
      const confirmPlan = async () => {
        if (busy) return
        const list = (targets ?? expansion.chapterTargets).filter((item) => Number(item.chapter) > 0)
        if (list.length === 0) {
          window.alert('方案里没有可确认的逐章目标')
          return
        }
        setBusy('confirm')
        try {
          await api('expansion.confirmPlan', {
            projectId,
            approvedOutlineIds: outlineApproved.slice(),
            chapterTargets: list.map((item) => ({
              chapter: Number(item.chapter),
              targetWords: Number(item.targetWords) || 0,
              type: item.type || 'enrich',
              additions: Array.isArray(item.additions) ? item.additions : [],
            })),
          })
          setPlanConfirmed(true)
          await load()
          onChanged?.()
        } catch (error) {
          window.alert(error.message)
        } finally {
          setBusy('')
        }
      }
      const start = () => run('start', () => api('expansion.start', { projectId }))
      const approveOutline = () => {
        if (!window.confirm('确认大纲变更并继续扩写？确认后 AI 会按新的大纲结构执行，主线节拍会保留。')) return
        run('approve', () => api('expansion.approveOutline', { projectId }))
      }
      const pause = () => run('pause', () => api('expansion.pause', { projectId }))
      const resume = () => run('resume', () => api('expansion.resume', { projectId }))
      const stop = () => {
        if (!window.confirm('停止本次扩写？会清除本次运行状态，已扩写的正文与备份保留。')) return
        run('stop', () => api('expansion.reset', { projectId }))
      }
      const stuckResume = () => {
        if (!window.confirm('扩写流程卡住时手动恢复：由后端重新推动会话继续本次扩写。继续？')) return
        resume()
      }
      const again = () => {
        if (!window.confirm('再次扩写会新建一次 runId 并回到未开始配置；已扩写的正文与历史备份保留。继续？')) return
        run('again', () => api('expansion.reset', { projectId }))
      }
      const openSession = () => openChatSessionById(expansion.sessionId)
      const section = (title, content, extra) => h('section', { className: 'sd-exp-section' },
        h('div', { className: 'sd-exp-section-head' }, h('h3', { className: 'sd-h3' }, title), extra ?? null),
        content)
      const list = (entries, emptyText) => {
        const items = (entries ?? []).map(expansionEntryText).filter(Boolean)
        return items.length > 0
          ? h('div', { className: 'sd-exp-list' }, items.map((text, index) => h('div', { key: index, className: 'sd-exp-li' }, text)))
          : h('p', { className: 'sd-exp-empty' }, emptyText)
      }
      const budgetBlock = () => h('section', { className: 'sd-exp-budget' },
        h('div', { className: 'sd-exp-section-head' }, h('h3', { className: 'sd-h3' }, '预算'), h('span', { className: 'sd-hint' }, '⚠ 估算不准，仅作参考；0 = 不限')),
        h('div', { className: 'sd-exp-budget-row' },
          h('span', { className: 'sd-exp-budget-label' }, 'token'),
          h('span', { className: 'sd-exp-budget-value' }, `${formatPipelineTokens(expansion.budget.usedTokens)} / ${expansion.budget.maxTokens > 0 ? formatPipelineTokens(expansion.budget.maxTokens) : '不限'}`),
          h('div', { className: 'sd-exp-budget-bar' }, h('div', {
            className: `sd-exp-budget-fill${budgetInfo.tokenPercent !== null && budgetInfo.tokenPercent > 100 ? ' sd-exp-budget-danger' : budgetInfo.tokenPercent !== null && budgetInfo.tokenPercent > 80 ? ' sd-exp-budget-warn' : ''}`,
            style: { width: `${Math.min(100, budgetInfo.tokenPercent ?? 0)}%` },
          }))),
        h('div', { className: 'sd-exp-budget-row' },
          h('span', { className: 'sd-exp-budget-label' }, '费用'),
          h('span', { className: 'sd-exp-budget-value' }, `${formatPipelineMoney(expansion.budget.usedCostCNY)} / ${expansion.budget.maxCostCNY > 0 ? formatPipelineMoney(expansion.budget.maxCostCNY) : '不限'}`),
          h('div', { className: 'sd-exp-budget-bar' }, h('div', {
            className: `sd-exp-budget-fill${budgetInfo.costPercent !== null && budgetInfo.costPercent > 100 ? ' sd-exp-budget-danger' : budgetInfo.costPercent !== null && budgetInfo.costPercent > 80 ? ' sd-exp-budget-warn' : ''}`,
            style: { width: `${Math.min(100, budgetInfo.costPercent ?? 0)}%` },
          }))),
        budgetInfo.percent === null
          ? h('p', { className: 'sd-exp-budget-hint' }, '未设置预算上限（可在配置里填写 token / 费用上限）')
          : h('p', { className: `sd-exp-budget-hint${budgetInfo.percent > 100 ? ' sd-exp-budget-danger' : budgetInfo.percent > 80 ? ' sd-exp-budget-warn' : ''}` }, `总预算使用 ${Math.round(budgetInfo.percent)}%`))
      const notesBlock = (title) => {
        const usage = live?.usage ?? null
        return section(title ?? `进度提示（${expansion.notes.length}）`,
          expansion.notes.length === 0
            ? h('p', { className: 'sd-exp-empty' }, '还没有进度提示。')
            : h('div', { className: 'sd-exp-note-list' }, expansion.notes.slice(-20).reverse().map((note) => h('div', { key: note.key, className: 'sd-exp-note' },
                h('span', { className: 'sd-exp-note-time' }, note.at ? formatDateTime(note.at) : '—'),
                h('span', { className: 'sd-exp-note-text' }, note.text)))),
          usage ? h('span', { className: 'sd-hint' }, `${formatPipelineTokens(usage.tokens)} token · ${formatPipelineMoney(usage.costCNY)}`) : null)
      }
      const renderConfirmationItem = (item, index) => {
        if (item === null || item === undefined) return null
        if (typeof item === 'string' || typeof item === 'number') {
          return h('div', { key: `confirmation-${index}`, className: 'sd-exp-confirm-item' },
            h('div', { className: 'sd-exp-confirm-question' }, String(item)))
        }
        const question = item.question ?? item.title ?? item.text ?? `待确认事项 ${index + 1}`
        const impact = item.impact ?? item.reason ?? item.note ?? ''
        const options = Array.isArray(item.options) ? item.options : []
        return h('div', { key: item.id ?? `confirmation-${index}`, className: 'sd-exp-confirm-item' },
          h('div', { className: 'sd-exp-confirm-question' }, String(question)),
          impact ? h('div', { className: 'sd-exp-confirm-impact' }, `影响：${String(impact)}`) : null,
          options.length > 0
            ? h('div', { className: 'sd-exp-confirm-options' }, options.map((option, position) => {
                const label = typeof option === 'string' ? option : option?.label ?? option?.text ?? option?.title ?? JSON.stringify(option)
                return h(Tag, { key: position, tone: 'muted' }, String(label))
              }))
            : null)
      }
      const confirmationsBlock = h('section', { className: 'sd-exp-confirm' },
        h('div', { className: 'sd-exp-confirm-head' },
          h('h3', { className: 'sd-h3' }, `⚠ 需要你确认（${confirmationCount}）`),
          h('span', { className: 'sd-hint' }, confirmations.length > 0 ? 'AI 把需要你拍板的事项列在这里' : fallbackNotes.length > 0 ? '来自方案备注' : '')),
        confirmations.length > 0
          ? h('div', { className: 'sd-exp-confirm-list' }, confirmations.map(renderConfirmationItem))
          : fallbackNotes.length > 0
            ? h('div', { className: 'sd-exp-confirm-list' }, fallbackNotes.map((note, index) => h('div', { key: index, className: 'sd-exp-confirm-item sd-exp-confirm-fallback' },
                h('div', { className: 'sd-exp-confirm-question' }, expansionEntryText(note)),
                h('div', { className: 'sd-exp-confirm-impact' }, '方案备注里提到需要你确认（AI 没有单列 confirmations）'))))
            : h('p', { className: 'sd-exp-confirm-empty' }, '无待确认事项'))
      const outlineChangeTitle = (change, index) => {
        if (typeof change === 'string') return change
        return String(change?.title ?? change?.note ?? change?.change ?? `大纲变更 ${index + 1}`)
      }
      const outlineChangeMeta = (change) => {
        if (!change || typeof change !== 'object') return []
        const meta = []
        if (change.priority) meta.push(`优先级：${change.priority}`)
        if (change.kind) meta.push(`类型：${change.kind}`)
        const chaptersValue = Array.isArray(change.chapters) && change.chapters.length > 0 ? change.chapters.join('、') : change.chapter
        if (chaptersValue) meta.push(`章：${chaptersValue}`)
        if (change.change) meta.push(String(change.change))
        if (change.note && change.note !== change.change) meta.push(String(change.note))
        if (change.reason) meta.push(`原因：${change.reason}`)
        if (change.affects) meta.push(`影响：${Array.isArray(change.affects) ? change.affects.join('、') : String(change.affects)}`)
        if (Array.isArray(change.newElements) && change.newElements.length > 0) meta.push(`新增元素：${change.newElements.map((item) => (typeof item === 'string' ? item : item?.title ?? item?.name ?? JSON.stringify(item))).join('、')}`)
        return meta
      }
      const outlineConfirmBlock = outlineChangeList.length === 0
        ? null
        : h('section', { className: 'sd-exp-outline-confirm' },
            h('div', { className: 'sd-exp-outline-confirm-head' },
              h('h3', { className: 'sd-h3' }, `大纲变更清单（${outlineApprovedCount}/${outlineChangeList.length} 已勾选）`),
              h('div', { className: 'sd-exp-outline-bulk' },
                h(Btn, { small: true, onClick: approveAllOutline, disabled: !!busy }, '全部同意'),
                h(Btn, { small: true, onClick: clearAllOutline, disabled: !!busy }, '全部取消'))),
            h('div', { className: 'sd-exp-outline-list' }, outlineChangeList.map((change, index) => {
              const key = expansionOutlineKey(change, index)
              const checked = outlineApproved.includes(key)
              const already = expansionOutlineIsApproved(expansion, change, index)
              const meta = outlineChangeMeta(change)
              return h('label', { key, className: `sd-exp-outline-row${already ? ' sd-exp-outline-row-approved' : ''}` },
                h('input', { type: 'checkbox', checked, onChange: () => toggleOutlineChange(key) }),
                h('div', { className: 'sd-exp-outline-main' },
                  h('div', { className: 'sd-exp-outline-title' }, outlineChangeTitle(change, index), already ? h(Tag, { tone: 'success' }, '已批准') : null),
                  meta.length > 0 ? h('div', { className: 'sd-exp-outline-meta' }, meta.join(' ｜ ')) : null))
            })),
            h('p', { className: 'sd-exp-confirm-footer' },
              `已批准 ${outlineApprovedCount} / 共 ${outlineChangeList.length} 条大纲变更`,
              !allOutlineApproved ? '；仍有未批准的条目，执行时会被闸门拦住，AI 不会使用' : ''))
      const waitingOutlineList = (changes) => h('div', { className: 'sd-exp-outline-list' }, changes.map((change, index) => {
        const already = expansionOutlineIsApproved(expansion, change, index)
        const meta = outlineChangeMeta(change)
        return h('div', { key: `${expansionOutlineKey(change, index)}-${index}`, className: `sd-exp-outline-row sd-exp-outline-row-readonly${already ? ' sd-exp-outline-row-approved' : ''}` },
          h('span', { className: 'sd-exp-outline-checkmark' }, already ? '✓' : '○'),
          h('div', { className: 'sd-exp-outline-main' },
            h('div', { className: 'sd-exp-outline-title' }, outlineChangeTitle(change, index)),
            meta.length > 0 ? h('div', { className: 'sd-exp-outline-meta' }, meta.join(' ｜ ')) : null),
          h(Tag, { tone: already ? 'success' : 'warn' }, already ? '已确认' : '待确认'))
      }))
      const statusHint = h('div', { className: 'sd-exp-head' },
        h('div', null,
          h('h3', { className: 'sd-h3' }, '✍️ 扩写'),
          h('p', { className: 'sd-desc' }, '把已有正文按你设定的目标字数写厚：目标字数必填、无默认值；大纲是硬边界，动大纲必须先确认。执行全自动，扩写结果自动采纳并保留原稿备份。')),
        h('span', { className: `sd-exp-status sd-exp-status-${expansion.status}` }, statusMeta.label))
      const sessionButton = expansion.sessionId ? h(Btn, { small: true, onClick: openSession }, '去对话查看') : null
      const budgetBars = budgetBlock()
      const stats = expansionReportData(expansion, bundle)

      if (expansion.status === 'idle') {
        return h('div', { className: 'sd-exp-panel' },
          statusHint,
          !hasChapters ? h('p', { className: 'sd-exp-banner sd-exp-banner-warn' }, '还没有正文可扩写：请先在章节页写第 1 章。') : null,
          h('section', { className: 'sd-exp-config' },
            section('模式', h('div', { className: 'sd-exp-mode' },
              h(ViewToggle, { value: form.mode, onChange: (value) => set('mode', value), options: EXPANSION_MODE_OPTIONS.map(([value, label]) => ({ value, label })) }),
              form.mode === 'chapter'
                ? h('label', { className: 'sd-exp-chapter-pick' },
                    h('span', { className: 'sd-hint' }, '选择章节'),
                    h('select', { className: 'sd-input sd-select-inline', value: String(form.chapter), onChange: (e) => set('chapter', Number(e.target.value) || maxChapter) },
                      chapters.length === 0
                        ? h('option', { value: '' }, '还没有章节')
                        : chapters.map((chapter) => h('option', { key: chapter.id, value: String(chapter.id) }, `第 ${Number(chapter.id)} 章 · ${chapter.title || '未命名'}`))))
                : null)),
            section('目标字数（必填，无默认值）', h('div', { className: 'sd-exp-target-row' },
              h(TextInput, { value: form.targetWords, type: 'number', min: 1, placeholder: '请输入目标字数，例如 2000', onChange: (value) => set('targetWords', value) }),
              h('span', { className: 'sd-hint' }, form.mode === 'chapter' ? '本章目标字数' : '每章目标字数（方案出来后逐章可改）')),
              !(Number(form.targetWords) > 0) ? h('p', { className: 'sd-exp-required' }, '⚠ 目标字数必填：填写后才能生成扩写方案。') : null),
            section('允许新增（默认关）', h('div', { className: 'sd-exp-additions' },
              EXPANSION_ADDITION_OPTIONS.map(([key, label]) => h('label', { key, className: 'sd-cb' },
                h('input', { type: 'checkbox', checked: form.additions[key] === true, onChange: (e) => setAddition(key, e.target.checked) }), label)),
              h('label', { className: 'sd-exp-additions-limit' },
                h('span', { className: 'sd-hint' }, '上限'),
                h(TextInput, { value: form.additionLimit, type: 'number', min: 0, onChange: (value) => set('additionLimit', value) }))),
              h('label', { className: 'sd-cb sd-exp-outline-toggle' },
                h('input', { type: 'checkbox', checked: form.allowOutlineChanges === true, onChange: (e) => set('allowOutlineChanges', e.target.checked) }),
                '允许修改大纲（执行时仍需逐项确认）')),
            section('样张与预算', h('div', { className: 'sd-exp-config-grid' },
              h(Field, { label: '样张章数', hint: '先扩 1–3 章确认风格；0 = 不抽样' }, h(TextInput, { value: form.sampleChapters, type: 'number', min: 0, onChange: (value) => set('sampleChapters', value) })),
              h(Field, { label: 'token 上限', hint: '0 = 不限' }, h(TextInput, { value: form.maxTokens, type: 'number', min: 0, onChange: (value) => set('maxTokens', value) })),
              h(Field, { label: '费用上限（¥）', hint: '0 = 不限' }, h(TextInput, { value: form.maxCostCNY, type: 'number', min: 0, onChange: (value) => set('maxCostCNY', value) }))),
              h('p', { className: 'sd-exp-budget-hint' }, '⚠ 估算不准，仅作参考；实际用量会受上下文、审阅与修订影响。'))),
          h('div', { className: 'sd-exp-actions' },
            h(Btn, { kind: 'primary', onClick: plan, disabled: !!busy || !(Number(form.targetWords) > 0) || !hasChapters }, busy === 'plan' ? '正在生成方案…' : '生成扩写方案')),
        )
      }
      if (expansion.status === 'planning') {
        return h('div', { className: 'sd-exp-panel' },
          statusHint,
          h('div', { className: 'sd-exp-banner sd-exp-banner-info' }, 'AI 正在分析大纲与字数，生成扩写方案…（每 10 秒自动刷新）'),
          h('div', { className: 'sd-exp-actions' }, sessionButton),
          budgetBars,
          notesBlock())
      }
      if (expansion.status === 'plan-ready') {
        const capacityRows = expansionCapacityRows(expansion, bundle)
        const fallbackRows = expansion.mode === 'chapter'
          ? [{ chapter: Number(form.chapter) || maxChapter, targetWords: Number(form.targetWords) || 0, type: 'enrich', additions: [], outlineChangeIds: [] }]
          : chapters.map((chapter) => ({ chapter: Number(chapter.id), targetWords: Number(expansion.targetWords) || Number(form.targetWords) || 0, type: 'enrich', additions: [], outlineChangeIds: [] }))
        const targetRows = targets ?? (expansion.chapterTargets.length > 0 ? expansion.chapterTargets : fallbackRows)
        const metaRow = h('div', { className: 'sd-exp-meta-row' },
          h(Tag, { tone: 'brand' }, expansion.mode === 'chapter' ? '扩写本章' : '全部扩写'),
          h('span', null, `目标字数：${expansion.targetWords}`),
          h('span', null, `逐章目标：${expansion.chapterTargets.length} 章`),
          expansion.scope.chapters.length ? h('span', null, `范围：第 ${expansion.scope.chapters.join('、')} 章`) : null)
        const capacityTable = capacityRows.length === 0
          ? h('p', { className: 'sd-exp-empty' }, '方案没有提供容量评估。')
          : h('div', { className: 'sd-exp-table' },
              h('div', { className: 'sd-exp-tr sd-exp-tr-head' },
                h('span', null, '章'), h('span', null, '当前字数'), h('span', null, '大纲节拍'), h('span', null, '最多可到'), h('span', null, '目标')),
              capacityRows.map((row) => h('div', { key: row.chapter, className: 'sd-exp-tr' },
                h('span', null, `第 ${row.chapter} 章`),
                h('span', null, String(row.currentWords)),
                h('span', null, String(row.beats)),
                h('span', null, row.maxWords === null ? '—' : String(row.maxWords)),
                h('span', null, String(row.targetWords)))))
        const targetTable = targetRows.length === 0
          ? h('p', { className: 'sd-exp-empty' }, '方案没有提供逐章目标。')
          : h('div', { className: 'sd-exp-table' },
              h('div', { className: 'sd-exp-tr sd-exp-tr-head' },
                h('span', null, '章'), h('span', null, '类型'), h('span', null, '新增'), h('span', null, '目标字数')),
              targetRows.map((row, index) => h('div', { key: `${row.chapter}-${index}`, className: 'sd-exp-tr' },
                h('span', null, `第 ${row.chapter} 章`),
                h('span', null, row.type || '—'),
                h('span', null, Array.isArray(row.additions) && row.additions.length ? row.additions.join('、') : '—'),
                h('input', {
                  className: 'sd-input sd-exp-target-input',
                  type: 'number',
                  min: 1,
                  value: row.targetWords,
                  onChange: (e) => setTargets(targetRows.map((item, position) => (position === index ? { ...item, targetWords: e.target.value } : item))),
                }))))
        const planActions = h('div', { className: 'sd-exp-actions' },
          !planConfirmed
            ? h(Btn, { kind: 'primary', onClick: confirmPlan, disabled: !!busy || targetRows.length === 0 }, busy === 'confirm' ? '确认中…' : '确认方案')
            : h(React.Fragment, null,
                h(Tag, { tone: 'success' }, outlineChangeList.length > 0 ? `方案已确认 · 已批准 ${outlineApprovedCount}/${outlineChangeList.length} 条` : '方案已确认'),
                h(Btn, { kind: 'primary', onClick: start, disabled: !!busy }, busy === 'start' ? '启动中…' : expansion.mode === 'chapter' ? '扩写本章' : '全部扩写'),
                sessionButton))
        return h('div', { className: 'sd-exp-panel' },
          statusHint,
          section('方案概览', metaRow),
          confirmationsBlock,
          outlineConfirmBlock,
          section('诊断', list(expansion.plan.diagnosis, '方案没有提供诊断。')),
          section('每章容量', capacityTable),
          section('逐章目标（可修改）', targetTable),
          section('方案备注', list(expansion.plan.notes, '无')),
          planActions)
      }
      if (expansion.status === 'waiting-outline') {
        const changes = expansion.outlineChanges.length > 0 ? expansion.outlineChanges : expansion.plan.outlineChanges
        return h('div', { className: 'sd-exp-panel' },
          statusHint,
          h('div', { className: 'sd-exp-banner sd-exp-banner-warn' }, '⚠ 执行中发现需要动大纲，等你确认：确认后 AI 才会按新的结构继续扩写；不确认则只按大纲内可容纳的字数执行。'),
          confirmationsBlock,
          section('待确认的大纲变更', changes.length > 0 ? waitingOutlineList(changes) : h('p', { className: 'sd-exp-empty' }, '没有大纲变更条目。')),
          h('div', { className: 'sd-exp-actions' },
            h(Btn, { kind: 'primary', onClick: approveOutline, disabled: !!busy }, busy === 'approve' ? '确认中…' : '确认大纲变更并继续'),
            sessionButton),
          budgetBars,
          notesBlock())
      }
      if (expansion.status === 'structuring' || expansion.status === 'running') {
        const targetTotal = stats.achievements.length
        const percent = targetTotal > 0 ? Math.round((stats.achievedCount / targetTotal) * 100) : 0
        return h('div', { className: 'sd-exp-panel' },
          statusHint,
          h('div', { className: 'sd-exp-progress' },
            h('div', { className: 'sd-exp-progress-head' }, h('span', null, `逐章达成 ${stats.achievedCount}/${targetTotal}`), h('span', null, `${percent}%`)),
            h('div', { className: 'sd-exp-progress-bar' }, h('div', { className: 'sd-exp-progress-fill', style: { width: `${percent}%` } }))),
          budgetBars,
          notesBlock(),
          h('div', { className: 'sd-exp-actions' },
            h(Btn, { onClick: pause, disabled: !!busy }, busy === 'pause' ? '暂停中…' : '暂停'),
            h(Btn, { kind: 'danger', onClick: stop, disabled: !!busy }, '停止'),
            sessionButton))
      }
      if (expansion.status === 'paused') {
        return h('div', { className: 'sd-exp-panel' },
          statusHint,
          h('div', { className: 'sd-exp-banner' }, '扩写已暂停：恢复后由后端继续推动本次 run。'),
          budgetBars,
          notesBlock(),
          h('div', { className: 'sd-exp-actions' },
            h(Btn, { kind: 'primary', onClick: resume, disabled: !!busy }, busy === 'resume' ? '恢复中…' : '恢复'),
            h(Btn, { kind: 'danger', onClick: stop, disabled: !!busy }, '停止'),
            sessionButton))
      }
      if (expansion.status === 'stuck') {
        return h('div', { className: 'sd-exp-panel' },
          statusHint,
          h('div', { className: 'sd-exp-banner sd-exp-banner-warn' }, '⚠ 扩写流程卡住：会话可能已停止推进。可先「去对话查看」，必要时点「手动继续」让后端恢复。'),
          notesBlock(),
          h('div', { className: 'sd-exp-actions' },
            h(Btn, { kind: 'primary', onClick: stuckResume, disabled: !!busy }, '手动继续'),
            h(Btn, { kind: 'danger', onClick: stop, disabled: !!busy }, '停止'),
            sessionButton))
      }
      // done
      return h('div', { className: 'sd-exp-panel' },
        statusHint,
        h('div', { className: 'sd-exp-banner sd-exp-banner-done' }, '🎉 扩写完成：结果已自动采纳并保留原稿备份；建议把整本书交给独立审稿人复核冷读分。'),
        section('扩写报告', h('div', { className: 'sd-exp-report' },
          h('div', { className: 'sd-exp-report-stat' }, h('span', { className: 'sd-exp-report-label' }, '总字数'), h('span', { className: 'sd-exp-report-value' }, formatPipelineTokens(stats.totalWords))),
          h('div', { className: 'sd-exp-report-stat' }, h('span', { className: 'sd-exp-report-label' }, '逐章达成'), h('span', { className: 'sd-exp-report-value' }, `${stats.achievedCount}/${stats.achievements.length}`)),
          h('div', { className: 'sd-exp-report-stat' }, h('span', { className: 'sd-exp-report-label' }, '目标总字数'), h('span', { className: 'sd-exp-report-value' }, formatPipelineTokens(stats.targetTotal))),
          h('div', { className: 'sd-exp-report-stat' }, h('span', { className: 'sd-exp-report-label' }, '冷读变化'), h('span', { className: 'sd-exp-report-value' }, stats.attention === null ? '—' : String(stats.attention))))),
        stats.achievements.length > 0 ? section('逐章达成', h('div', { className: 'sd-exp-table' },
          h('div', { className: 'sd-exp-tr sd-exp-tr-head' }, h('span', null, '章'), h('span', null, '当前字数'), h('span', null, '目标'), h('span', null, '达成')),
          stats.achievements.map((item) => h('div', { key: item.chapter, className: 'sd-exp-tr' },
            h('span', null, `第 ${item.chapter} 章`),
            h('span', null, String(item.currentWords)),
            h('span', null, String(item.targetWords)),
            h('span', null, item.achieved ? '✓' : '—'))))) : null,
        section('新增内容摘要', stats.additions.length > 0 ? list(stats.additions, '无') : h('p', { className: 'sd-exp-empty' }, expansion.notes.length > 0 ? expansionEntryText(expansion.notes[expansion.notes.length - 1]) : '无')),
        section('大纲变更记录', list(stats.outlineChanges, '无')),
        h('div', { className: 'sd-exp-actions' },
          h(Btn, { onClick: again, disabled: !!busy }, '再次扩写'),
          sessionButton),
        budgetBars)
    }

    // ── 整本书页：子导航（生成整本书 / 扩写）──────────────────
    function PipelineTab({ bundle, projectId, onChanged, onGoTab, onOpenWizard, expansionIntent, onExpansionConsumed }) {
      const [section, setSection] = useState('pipeline')
      const [pendingIntent, setPendingIntent] = useState(expansionIntent ?? null)
      const [expansionStatus, setExpansionStatus] = useState(() => normalizeExpansion(bundle.expansion).status)
      useEffect(() => {
        setExpansionStatus(normalizeExpansion(bundle.expansion).status)
      }, [bundle.expansion])
      useEffect(() => {
        if (!expansionIntent) return
        setPendingIntent(expansionIntent)
        setSection('expansion')
        onExpansionConsumed?.()
      }, [expansionIntent])
      const needsExpansionConfirm = expansionStatus === 'plan-ready' || expansionStatus === 'waiting-outline'
      return h('div', { className: 'sd-page sd-pipe-page' },
        h('div', { className: 'sd-pipe-subnav' },
          h('button', {
            type: 'button',
            className: `sd-pipe-subtab${section === 'pipeline' ? ' sd-pipe-subtab-active' : ''}`,
            onClick: () => setSection('pipeline'),
          }, '📚 生成整本书'),
          h('button', {
            type: 'button',
            className: `sd-pipe-subtab${section === 'expansion' ? ' sd-pipe-subtab-active' : ''}`,
            onClick: () => { setPendingIntent(null); setSection('expansion') },
          }, '✍️ 扩写', needsExpansionConfirm ? h('span', { className: 'sd-exp-badge' }, '待确认') : null)),
        section === 'expansion'
          ? h(ExpansionPanel, { bundle, projectId, intent: pendingIntent, onChanged, onGoTab, onStatusChange: setExpansionStatus })
          : h(PipelineRunPanel, { bundle, projectId, onChanged, onGoTab, onOpenWizard }))
    }

    function PipelineOverviewCard({ bundle, onGoTab }) {
      const pipeline = normalizePipeline(bundle.pipeline)
      if (pipeline.status === 'idle' && pipeline.stages.length === 0) return null
      const stageInfo = pipelineStageInfo(pipeline)
      const budgetInfo = pipelineBudgetInfo(pipeline)
      const statusMeta = pipelineStatusMeta(pipeline)
      const cleanupStats = pipelineCleanupStats(bundle)
      const needsCleanup = pipeline.status === 'done' && (cleanupStats.pendingProposals > 0 || cleanupStats.openReviews > 0)
      return h('section', { className: 'sd-section sd-pipe-overview' },
        h('div', { className: 'sd-pipe-overview-head' },
          h('h3', { className: 'sd-h3' }, '📚 整本书'),
          h(Tag, { tone: statusMeta.tone }, statusMeta.label),
          needsCleanup ? h(Tag, { tone: 'warn' }, '待收尾') : null,
          onGoTab ? h(Btn, { small: true, onClick: () => onGoTab('pipeline') }, needsCleanup ? '去收尾 ▸' : '查看整本书 ▸') : null),
        h('div', { className: 'sd-pipe-overview-metrics' },
          h('span', null, stageInfo.current ? `第 ${Math.min(stageInfo.done + 1, stageInfo.total)}/${stageInfo.total} 步 · ${stageInfo.current.name}` : '阶段未开始'),
          h('span', null, `阶段 ${stageInfo.done}/${stageInfo.total}`),
          h('span', null, budgetInfo.percent === null ? '预算未设上限' : `预算 ${Math.round(budgetInfo.percent)}%`)),
        h('div', { className: 'sd-pipe-progress-bar' }, h('div', { className: `sd-pipe-progress-fill${budgetInfo.percent !== null && budgetInfo.percent > 100 ? ' sd-pipe-progress-danger' : ''}`, style: { width: `${stageInfo.percent}%` } })))
    }

    function TimelineTab({ bundle, projectId, onChanged, onGoTab }) {
      const [editing, setEditing] = useState(null)
      const [mode, setMode] = useState('list')
      const [viewOpen, setViewOpen] = useState(false)
      const events = [...(bundle.events ?? [])].sort((a, b) => (Number(a.chapter) || 0) - (Number(b.chapter) || 0))
      return h(
        'div',
        { className: 'sd-page' },
        h(
          'div',
          { className: 'sd-pagehead' },
          h('div', null, h('h2', { className: 'sd-h2' }, '🕰️ 时间线'), h('p', { className: 'sd-desc' }, '按章排列的事件流。故事内时间用于排序与检查；泳道视图按卷或每 20 章分道并画伏笔弧线；全景视图按章聚合事件 / 伏笔埋收 / 冲突 / 高光 / 注意力。')),
          h(
            'div',
            { className: 'sd-pagehead-actions' },
            h(ViewToggle, { value: mode, onChange: setMode, options: [{ value: 'list', label: '列表' }, { value: 'lane', label: '泳道' }, { value: 'pano', label: '全景' }] }),
            h(Btn, { onClick: () => setViewOpen(true) }, '只读视图'),
            h(Btn, { kind: 'primary', onClick: () => setEditing({}) }, '＋ 新增事件'),
          ),
        ),
        mode === 'pano'
          ? h(TimelinePanorama, { bundle, onGoTab })
          : mode === 'lane'
          ? h(TimelineLanes, { events, foreshadow: bundle.foreshadow ?? [], onEdit: (item) => setEditing(item) })
          : events.length === 0
          ? h(Empty, null, '还没有事件。把关键剧情点记进来，时间线会自动成列。')
          : h(
              'div',
              { className: 'sd-timeline' },
              events.map((event) =>
                h(
                  'div',
                  { key: event.id, className: 'sd-tl-item' },
                  h('div', { className: 'sd-tl-badge' }, event.chapter ? `第 ${event.chapter} 章` : '未标章'),
                  h(
                    'div',
                    { className: 'sd-tl-card', onClick: () => setEditing(event) },
                    h('div', { className: 'sd-tl-head' }, h('strong', null, event.title || event.id), h(Tag, { tone: 'muted' }, EVENT_IMPORTANCE[event.importance] || '一般'), event.storyTime ? h(Tag, { tone: 'brand' }, event.storyTime) : null),
                    event.volume !== undefined && event.volume !== null && event.volume !== '' ? h(Tag, { tone: 'brand' }, String(event.volume).includes('卷') ? String(event.volume) : `第 ${event.volume} 卷`) : null,
                    event.location ? h('div', { className: 'sd-tl-meta' }, '📍 ' + event.location) : null,
                    event.summary ? h('div', { className: 'sd-tl-text' }, event.summary) : null,
                    Array.isArray(event.participants) && event.participants.length > 0 ? h('div', { className: 'sd-tl-meta' }, '👥 ' + event.participants.join('、')) : null,
                    event.consequences ? h('div', { className: 'sd-tl-meta' }, '➜ ' + event.consequences) : null,
                  ),
                ),
              ),
            ),
        editing !== null ? h(EntityEditor, { kind: 'events', item: editing, projectId, onClose: () => setEditing(null), onSaved: onChanged }) : null,
        viewOpen ? h(HtmlViewDialog, { title: '🕰️ 时间线 · 只读视图', path: novelDeskViewPath('timeline', projectId), onClose: () => setViewOpen(false) }) : null,
      )
    }

    // ── 时间线全景：按章聚合所有素材 ──────────────────────────
    const PANO_SECTIONS = [
      ['events', '事件'],
      ['plant', '伏笔埋设'],
      ['payoff', '伏笔回收'],
      ['conflicts', '冲突'],
      ['highlights', '高光'],
      ['attention', '注意力'],
    ]

    function TimelinePanorama({ bundle, onGoTab }) {
      const [filters, setFilters] = useState({ events: true, plant: true, payoff: true, conflicts: true, highlights: true, attention: true })
      const [locationFilter, setLocationFilter] = useState('all')
      const toggleFilter = (key) => setFilters((prev) => ({ ...prev, [key]: !prev[key] }))
      const chapters = bundle.chapters ?? []
      const titleOf = (chapter) => String(chapters.find((item) => Number(item.id) === Number(chapter))?.title ?? '').trim()
      const chapterLocation = new Map(chapters.map((chapter) => [Number(chapter.id), String(chapter.location ?? '').trim()]))
      const truncate = (text, size = 40) => {
        const value = String(text ?? '').trim()
        return value.length > size ? value.slice(0, size) + '…' : value
      }
      const byChapter = new Map()
      const ensure = (chapter) => {
        const number = Number(chapter)
        if (!Number.isFinite(number) || number <= 0) return null
        if (!byChapter.has(number)) byChapter.set(number, { chapter: number, location: '', events: [], plants: [], payoffs: [], conflicts: [], highlights: [] })
        return byChapter.get(number)
      }
      for (const event of bundle.events ?? []) ensure(event.chapter)?.events.push(event)
      for (const item of bundle.foreshadow ?? []) {
        if (Number(item.setupChapter) > 0) ensure(item.setupChapter)?.plants.push(item)
        if (Number(item.payoffChapter) > 0) ensure(item.payoffChapter)?.payoffs.push(item)
      }
      for (const conflict of bundle.conflicts ?? []) ensure(conflict.resolveChapter)?.conflicts.push(conflict)
      for (const highlight of bundle.highlights ?? []) ensure(highlight.chapter)?.highlights.push(highlight)
      const attentionByChapter = new Map(attentionRows(bundle).map((row) => [Number(row.chapter), row]))
      for (const chapter of attentionByChapter.keys()) ensure(chapter)
      const all = [...byChapter.values()].sort((a, b) => a.chapter - b.chapter)
      // 本章地点：chapter.location 优先，缺则取本章第一个 events.location
      for (const entry of all) {
        entry.location = chapterLocation.get(entry.chapter) || String(entry.events.find((event) => String(event.location ?? '').trim() !== '')?.location ?? '').trim()
      }
      if (all.length === 0) return h(Empty, null, '还没有可展示的素材。先写事件 / 伏笔 / 冲突 / 高光，或给章节标注意力。')
      const locationValues = [...new Set(all.map((entry) => entry.location).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
      const visibleAll = all.filter((entry) => (locationFilter === 'all' ? true : locationFilter === '__none__' ? !entry.location : entry.location === locationFilter))
      const cards = []
      for (const entry of visibleAll) {
        const sections = []
        if (filters.events && entry.events.length > 0) {
          sections.push(['事件', entry.events.map((event) => ({
            key: `event-${event.id}`,
            main: event.title || event.id || '未命名事件',
            meta: [event.storyTime, event.location ? '📍 ' + event.location : ''].filter(Boolean).join(' · '),
          }))])
        }
        if (filters.plant && entry.plants.length > 0) {
          sections.push(['伏笔·埋', entry.plants.map((item) => ({
            key: `plant-${item.id}`,
            main: item.title || '未命名伏笔',
            meta: Number(item.payoffChapter) > 0 ? `→ 计划第 ${item.payoffChapter} 章回收` : '→ 未定回收',
          }))])
        }
        if (filters.payoff && entry.payoffs.length > 0) {
          sections.push(['伏笔·收', entry.payoffs.map((item) => ({
            key: `payoff-${item.id}`,
            main: item.title || '未命名伏笔',
            meta: Number(item.setupChapter) > 0 ? `第 ${item.setupChapter} 章 →` : '未定埋设 →',
          }))])
        }
        if (filters.conflicts && entry.conflicts.length > 0) {
          sections.push(['冲突', entry.conflicts.map((conflict) => ({
            key: `conflict-${conflict.id}`,
            main: conflict.title || '未命名冲突',
            meta: [CONFLICT_STATUS[conflict.status] ?? conflict.status ?? '', displayValue('type', conflict.type)].filter((value) => value && value !== '—').join(' / '),
          }))])
        }
        if (filters.highlights && entry.highlights.length > 0) {
          sections.push(['高光', entry.highlights.map((highlight) => ({
            key: `highlight-${highlight.id}`,
            main: truncate(highlight.title || highlight.quote || highlight.text || '未命名高光'),
            meta: displayValue('type', highlight.type) === '—' ? '' : displayValue('type', highlight.type),
          }))])
        }
        const attention = attentionByChapter.get(entry.chapter) ?? null
        if (sections.length === 0 && !(filters.attention && attention)) continue
        cards.push({ entry, sections, attention })
      }
      const attentionText = (attention) => {
        if (!attention) return '未标注意力'
        return ['⚡', attentionHasScore(attention) ? `${Number(attention.score)} 分` : '未测', ATTENTION_TYPE_LABEL[attention.type] ?? '', attention.verdict ?? '']
          .filter(Boolean).join(' · ')
      }
      const renderRow = (row) => h('div', { key: row.key, className: 'sd-pano-row' },
        h('span', { className: 'sd-pano-row-main' }, row.main),
        row.meta ? h('span', { className: 'sd-pano-row-meta' }, row.meta) : null)
      const renderSection = ([label, rows]) => h('div', { key: label, className: 'sd-pano-sec' },
        h('div', { className: 'sd-pano-sec-label' }, label),
        rows.map(renderRow))
      const renderCard = ({ entry, sections, attention }) => h('section', { key: entry.chapter, className: 'sd-pano-card' },
        h('div', { className: 'sd-pano-head' },
          h('button', { type: 'button', className: 'sd-pano-title', title: onGoTab ? '去章节页' : '章节', onClick: () => onGoTab && onGoTab('chapters') },
            `第 ${entry.chapter} 章${titleOf(entry.chapter) ? `《${titleOf(entry.chapter)}》` : ''}`),
          filters.attention
            ? h('span', { className: `sd-pano-att${attention ? '' : ' sd-pano-att-empty'}` }, attentionText(attention))
            : null,
          entry.location ? h('span', { className: 'sd-pano-loc', title: '本章地点' }, `📍 ${entry.location}`) : null),
        sections.map(renderSection))
      return h('div', { className: 'sd-pano-wrap' },
        h('div', { className: 'sd-pano-toolbar' },
          PANO_SECTIONS.map(([key, label]) => h('label', { key, className: 'sd-cb sd-pano-filter' },
            h('input', { type: 'checkbox', checked: filters[key], onChange: () => toggleFilter(key) }), label)),
          h('label', { className: 'sd-pano-location' },
            h('span', { className: 'sd-hint' }, '地点'),
            h('select', {
              className: 'sd-input sd-select-inline sd-pano-location-select',
              value: locationFilter,
              onChange: (e) => setLocationFilter(e.target.value),
            },
              h('option', { value: 'all' }, '全部地点'),
              locationValues.map((location) => h('option', { key: location, value: location }, location)),
              h('option', { value: '__none__' }, '未标地点'))),
          h('span', { className: 'sd-hint sd-pano-count' }, `${cards.length} 章有素材`)),
        cards.length === 0
          ? h(Empty, null, '当前过滤条件下没有可展示的素材，请至少打开一个开关。')
          : h('div', { className: 'sd-pano-cards' }, cards.map(renderCard)),
      )
    }

    // ── 总览页 ────────────────────────────────────────────────
    function WriterStats({ data }) {
      if (!data) return h('div', { className: 'sd-hint' }, '正在统计写作数据…')
      const m = data.metrics ?? {}
      const wb = data.workbench ?? {}
      const chat = data.chat ?? {}
      const fmt = (n) => {
        const value = Number(n) || 0
        if (value >= 1000000) return (value / 1000000).toFixed(2) + 'M'
        if (value >= 10000) return (value / 10000).toFixed(1) + ' 万'
        return String(value)
      }
      const cards = [
        ['总字数', fmt(m.words), '✍️'],
        ['修改次数', String(m.edits ?? 0), '🩹'],
        ['审稿', `${m.reviews ?? 0}`, `待处理 ${m.openReviews ?? 0}`],
        ['提案采纳', String(m.acceptedProposals ?? 0), `待处理 ${m.pendingProposals ?? 0}`],
        ['工作台 AI', fmt(wb.total?.totalTokens), `${m.aiCalls ?? 0} 次`],
        ['对话 token', fmt(chat.totalTokens), `${m.sessionCount ?? chat.sessions?.length ?? 0} 会话 + ${m.subagentCount ?? 0} 子 Agent`],
        ['AI 协作', `${m.chatHours ?? 0}h`, `生成 ${m.aiMinutes ?? 0} 分钟`],
        ['预估费用', `¥${Number(m.totalCostCNY ?? 0).toFixed(2)}`, `$${Number(m.totalCostUSD ?? 0).toFixed(2)}`],
        ['活跃天数', String(m.activeDays ?? 0), '最近 14 天'],
      ]
      const activity = data.activity ?? []
      const max = Math.max(1, ...activity.map((day) => (day.workbenchTokens ?? 0) + (day.chatTokens ?? 0)))
      return h('div', { className: 'sd-writer-dash' },
        h('div', { className: 'sd-cards sd-writer-cards' }, cards.map(([label, value, icon]) => h('div', { key: label, className: 'sd-card' },
          h('div', { className: 'sd-card-icon' }, icon),
          h('div', { className: 'sd-card-value' }, String(value)),
          h('div', { className: 'sd-card-label' }, label)))),
        activity.length > 0 ? h('div', { className: 'sd-activity' },
          h('div', { className: 'sd-hint' }, '最近 14 天 AI 协作量'),
          h('div', { className: 'sd-activity-bars' }, activity.map((day) => {
            const total = (day.workbenchTokens ?? 0) + (day.chatTokens ?? 0)
            return h('div', { key: day.date, className: 'sd-activity-col', title: `${day.date}：工作台 ${day.workbenchTokens ?? 0} / 对话 ${day.chatTokens ?? 0} token` },
              h('div', { className: 'sd-activity-bar', style: { height: `${Math.max(4, Math.round((total / max) * 100))}%` } }),
              h('span', null, day.date.slice(5)))
          }))) : null,
      )
    }

    // ── 一号原则：总览页 hero（口号 + 注意力三指标 + 去注意力页）──
    function PrincipleHero({ bundle, onGoTab }) {
      const stats = attentionStats(bundle)
      const hasScores = stats.scored.length > 0
      const statCell = (label, value, unit, hint) => h('div', { key: label, className: 'sd-principle-hero-stat' },
        h('div', { className: 'sd-principle-hero-label' }, label),
        h('div', { className: `sd-principle-hero-value${value === '—' ? ' sd-principle-hero-value-empty' : ''}` },
          value, unit ? h('span', { className: 'sd-principle-hero-unit' }, unit) : null),
        hint ? h('div', { className: 'sd-principle-hero-stat-hint' }, hint) : null)
      return h('section', { className: 'sd-principle-hero' },
        h('div', { className: 'sd-principle-hero-main' },
          h('h2', { className: 'sd-principle-hero-slogan' }, PRINCIPLE_SLOGAN),
          h('p', { className: 'sd-principle-hero-sub' }, PRINCIPLE_SUB),
          h('p', { className: 'sd-principle-hero-hint' }, hasScores
            ? PRINCIPLE_HINT
            : '还没有注意力记录：去分工页让独立审稿人冷读，或写下一章方案时让 AI 自动带设计。')),
        h('div', { className: 'sd-principle-hero-stats' },
          statCell('平均注意力', stats.average === null ? '—' : String(stats.average), stats.average === null ? '' : '/100', hasScores ? `${stats.scored.length} 章有实测分` : '暂无实测分'),
          h('div', { className: 'sd-principle-hero-stat' },
            h('div', { className: 'sd-principle-hero-label' }, '最低三章'),
            stats.lowest.length === 0
              ? h('div', { className: 'sd-principle-hero-value sd-principle-hero-value-empty' }, '—')
              : h('div', { className: 'sd-principle-hero-list' }, stats.lowest.map((row) => h('span', { key: row.id ?? `hero-low-${row.chapter}`, className: 'sd-principle-hero-list-item' }, `第 ${Number(row.chapter)} 章 · ${Number(row.score)}`))),
            stats.lowest.length === 0 ? h('div', { className: 'sd-principle-hero-stat-hint' }, '暂无实测分') : null),
          statCell('未标注意力', String(stats.unmarked.length), '章', '有正文但无注意力记录')),
        h('div', { className: 'sd-principle-hero-actions' },
          onGoTab ? h(Btn, { kind: 'primary', onClick: () => onGoTab('attention') }, '打开注意力页') : null,
          onGoTab ? h(Btn, { onClick: () => onGoTab('agents') }, '去分工页冷读') : null),
      )
    }

    function OverviewTab({ bundle, projectId, onChanged, onAddCart, cartCount = 0, onOpenCart, onGoTab }) {
      const [form, setForm] = useState(() => ({ ...bundle.project }))
      const [busy, setBusy] = useState(false)
      const [dash, setDash] = useState(null)
      useEffect(() => setForm({ ...bundle.project }), [bundle.project.id])
      useEffect(() => {
        let alive = true
        api('usage.summary', { projectId }).then((value) => { if (alive) setDash(value) }).catch(() => {})
        return () => { alive = false }
      }, [projectId])
      const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))
      const save = async () => {
        setBusy(true)
        try {
          await api('project.update', { projectId, patch: form })
          onChanged()
        } catch (error) {
          window.alert(error.message)
        } finally {
          setBusy(false)
        }
      }
      const stats = bundle.stats
      const cards = [
        ['章节', stats.chapters, '📄'],
        ['字数', stats.words, '✍️'],
        ['大纲', stats.outlines ?? 0, '🗂️'],
        ['人物', stats.characters, '👤'],
        ['事实', stats.facts, '⚖️'],
        ['未回收伏笔', stats.openForeshadow, '🧩'],
        ['进行中冲突', stats.activeConflicts, '⚔️'],
        ['高光', stats.highlights, '✨'],
        ['预设', stats.presets, '🎛️'],
      ]
      return h(
        'div',
        { className: 'sd-page' },
        h(PrincipleHero, { bundle, onGoTab }),
        h('div', { className: 'sd-pagehead' },
          h('div', null, h('h2', { className: 'sd-h2' }, '📖 ' + bundle.project.name), h('p', { className: 'sd-desc' }, bundle.project.logline || '还没有一句话简介。')),
          h('div', { className: 'sd-pagehead-actions' },
            h(Btn, { kind: 'primary', onClick: () => onAddCart({ kind: 'task', id: 'full-review', title: '从头审阅整个项目', task: 'full-review' }) }, '＋ 加入清单：从头审阅'))),
        h('div', { className: 'sd-cart-banner' },
          h('strong', null, `🧺 清单 ${cartCount} 项`),
          onOpenCart ? h(Btn, { small: true, kind: 'primary', onClick: onOpenCart }, '打开清单') : null),
        h('section', { className: 'sd-section sd-mt' }, h('h3', { className: 'sd-h3' }, '写作仪表盘'), h(WriterStats, { data: dash })),
        h('div', { className: 'sd-cards sd-mt' }, cards.map(([label, value, icon]) => h('div', { key: label, className: 'sd-card' }, h('div', { className: 'sd-card-icon' }, icon), h('div', { className: 'sd-card-value' }, String(value)), h('div', { className: 'sd-card-label' }, label)))),
        h(AttentionOverviewCard, { bundle, onGoTab, onAddCart }),
        h(PipelineOverviewCard, { bundle, onGoTab }),
        h(FreshReadCard, { bundle, projectId, compact: true }),
        h('div', { className: 'sd-two-col' },
          h('section', { className: 'sd-section' },
            h('h3', { className: 'sd-h3' }, '作品设定'),
            h('div', { className: 'sd-form sd-form-2' },
              h(Field, { label: '书名' }, h(TextInput, { value: form.name, onChange: (v) => set('name', v) })),
              h(Field, { label: '类型' }, h(TextInput, { value: form.genre, onChange: (v) => set('genre', v), placeholder: '武侠 / 科幻 / 悬疑…' })),
              h(Field, { label: '视角' }, h(TextInput, { value: form.pov, onChange: (v) => set('pov', v) })),
              h(Field, { label: '时态' }, h(TextInput, { value: form.tense, onChange: (v) => set('tense', v) })),
              h(Field, { label: '目标章数' }, h(TextInput, { value: form.targetChapters, type: 'number', onChange: (v) => set('targetChapters', Number(v) || 0) })),
              h(Field, { label: '目标字数' }, h(TextInput, { value: form.targetWords, type: 'number', onChange: (v) => set('targetWords', Number(v) || 0) })),
              h(Field, { label: '来源目录（可选）', hint: '仅记录导入来源；每本书的聊天工作区自动建在 ~/StoryDesk/projects/<id>' }, h(TextInput, { value: form.rootPath ?? '', placeholder: '/Users/you/你的小说', onChange: (v) => set('rootPath', v) })),
            ),
            h(Field, { label: '一句话简介' }, h(TextArea, { value: form.logline, rows: 2, onChange: (v) => set('logline', v) })),
            h(Field, { label: '故事梗概' }, h(TextArea, { value: form.description, rows: 5, onChange: (v) => set('description', v) })),
            h('div', { className: 'sd-form-actions' }, h(Btn, { kind: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存设定')),
          ),
          h('section', { className: 'sd-section' },
            h('h3', { className: 'sd-h3' }, `一致性检查（${bundle.checks.length}）`),
            bundle.checks.length === 0
              ? h(Empty, null, '没有发现问题。')
              : h('div', { className: 'sd-checks' }, bundle.checks.map((check) => h('div', { key: check.id, className: `sd-check sd-check-${check.level}` },
                  h('div', { className: 'sd-check-main' }, h('div', { className: 'sd-check-title' }, check.title), h('div', { className: 'sd-check-detail' }, check.detail)),
                  onAddCart ? h(Btn, { small: true, onClick: () => onAddCart({ kind: 'check', id: check.id, chapter: check.chapter, title: check.title, detail: check.detail }) }, '加入清单') : null))),
            h('h3', { className: 'sd-h3 sd-mt' }, '最近章节'),
            bundle.chapters.length === 0
              ? h(Empty, null, '还没有章节。')
              : h('div', { className: 'sd-mini-list' }, bundle.chapters.slice(-5).reverse().map((c) => h('div', { key: c.id, className: 'sd-mini-row' }, h(Tag, { tone: 'muted' }, c.id), h('span', { className: 'sd-mini-title' }, c.title), h('span', { className: 'sd-mini-meta' }, `${c.words} 字`)))),
          ),
        ),
      )
    }

    // ── 设置页 ────────────────────────────────────────────────
    function SettingsTab({ bundle, projectId, onChanged, onProjectDeleted }) {
      const [busy, setBusy] = useState(false)
      const exportAs = async (format) => {
        setBusy(true)
        try {
          await downloadExport(projectId, format)
        } catch (error) {
          window.alert(error.message)
        } finally {
          setBusy(false)
        }
      }
      const removeProject = async () => {
        if (!window.confirm(`删除作品《${bundle.project.name}》及其全部章节、设定？此操作不可撤销。`)) return
        setBusy(true)
        try {
          await api('project.delete', { projectId })
          onProjectDeleted()
        } catch (error) {
          window.alert(error.message)
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'sd-page' },
        h('div', { className: 'sd-pagehead' }, h('div', null, h('h2', { className: 'sd-h2' }, '⚙️ 设置'), h('p', { className: 'sd-desc' }, '工作台数据全部是普通文件，可直接备份、进 Git、用别的编辑器打开。'))),
        h('section', { className: 'sd-section' },
          h('h3', { className: 'sd-h3' }, '数据位置'),
          h('div', { className: 'sd-code' }, bundle.root || '~/StoryDesk'),
          h('p', { className: 'sd-hint' }, `作品工作区：${bundle.project.workspacePath || '（刷新后自动创建）'}`),
          h('p', { className: 'sd-hint' }, '每个作品一个目录：project.json、chapters/*.md、facts.json、events.json、foreshadow.json、conflicts.json、characters.json、highlights.json、presets.json。'),
          h('h3', { className: 'sd-h3 sd-mt' }, '导出与维护'),
          h('div', { className: 'sd-form-actions' },
            h(Btn, { onClick: () => exportAs('md'), disabled: busy }, '导出 Markdown 合集'),
            h(Btn, { onClick: () => exportAs('epub'), disabled: busy }, '导出 EPUB'),
            h(Btn, { onClick: () => exportAs('docx'), disabled: busy }, '导出 DOCX'),
          ),
          h('h3', { className: 'sd-h3 sd-mt' }, '危险操作'),
          h('div', { className: 'sd-form-actions' }, h(Btn, { kind: 'danger', onClick: removeProject, disabled: busy }, '删除本作品')),
        ),
      )
    }

    // ── 新建作品 ──────────────────────────────────────────────
    function CreateProjectDialog({ onClose, onCreated }) {
      const [form, setForm] = useState({
        name: '',
        genre: '',
        logline: '',
        targetChapters: 0,
        targetWords: 0,
        worldKind: 'mixed',
        worldScale: 'region',
        worldEra: '',
        generateWorld: true,
        openPipeline: false,
      })
      const [busy, setBusy] = useState(false)
      const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))
      const save = async () => {
        if (!String(form.name).trim()) {
          window.alert('请填写作品名')
          return
        }
        setBusy(true)
        let project = null
        try {
          // 世界设定不进 project 字段：仅作为 world-build 任务 instruction（契约见 docs/WORLD-MODEL.md）。
          project = await api('project.create', {
            input: {
              name: form.name,
              genre: form.genre,
              logline: form.logline,
              targetChapters: form.targetChapters,
              targetWords: form.targetWords,
            },
          })
          onCreated(
            project.id,
            form.openPipeline === true
              ? { openPipeline: true, prefill: { name: form.name, premise: form.logline || '', genre: form.genre || '' } }
              : null,
          )
          onClose()
        } catch (error) {
          window.alert(error.message)
          setBusy(false)
          return
        }
        setBusy(false)
        // 唯一允许直接发对话的入口：创建后立刻让 AI 生成世界（与导入后立即审阅同模式）。
        // 勾选「创建后进入整本书」时不再额外发 world-build：准备阶段会一起出蓝图/大纲，避免两个会话打架。
        if (form.generateWorld !== false && form.openPipeline !== true && project?.id) {
          try {
            await sendToChat({
              projectId: project.id,
              task: 'world-build',
              newSession: true,
              instruction: worldBuildInstruction(form.worldKind, form.worldScale, form.worldEra),
            })
          } catch (error) {
            window.alert(`作品已创建，但发送世界生成任务失败：${error.message}`)
          }
        }
      }
      return h(
        'div',
        { className: 'sd-modal-mask', onClick: (e) => e.target === e.currentTarget && onClose() },
        h('div', { className: 'sd-modal sd-modal-wide' },
          h('div', { className: 'sd-modal-head' }, h('strong', null, '新建作品'), h(IconBtn, { onClick: onClose, title: '关闭' }, '✕')),
          h('div', { className: 'sd-modal-body' }, h('div', { className: 'sd-form' },
            h(Field, { label: '作品名 *' }, h(TextInput, { value: form.name, onChange: (v) => set('name', v), placeholder: '如：长夜将明' })),
            h(Field, { label: '类型' }, h(TextInput, { value: form.genre, onChange: (v) => set('genre', v), placeholder: '武侠 / 科幻 / 悬疑 / 言情…' })),
            h(Field, { label: '一句话简介' }, h(TextArea, { value: form.logline, rows: 2, onChange: (v) => set('logline', v) })),
            h(Field, { label: '目标章数' }, h(TextInput, { value: form.targetChapters, type: 'number', onChange: (v) => set('targetChapters', Number(v) || 0) })),
            h(Field, { label: '目标字数' }, h(TextInput, { value: form.targetWords, type: 'number', onChange: (v) => set('targetWords', Number(v) || 0) })),
            h('div', { className: 'sd-create-world' },
              h('h3', { className: 'sd-h3' }, '🌍 世界设定（可选）'),
              h('div', { className: 'sd-create-world-grid' },
                h(Field, { label: '背景类型' }, h(Select, {
                  value: form.worldKind,
                  onChange: (v) => set('worldKind', v),
                  options: CREATE_WORLD_KINDS.map(([value, label]) => ({ value, label })),
                })),
                h(Field, { label: '尺度' }, h(Select, {
                  value: form.worldScale,
                  onChange: (v) => set('worldScale', v),
                  options: CREATE_WORLD_SCALES.map(([value, label]) => ({ value, label })),
                })),
                h(Field, { label: '时代' }, h(TextInput, { value: form.worldEra, onChange: (v) => set('worldEra', v), placeholder: '如：唐·天宝年间 / 架空蒸汽时代' }))),
              h('label', { className: 'sd-cb sd-create-world-toggle' },
                h('input', { type: 'checkbox', checked: form.generateWorld !== false, onChange: (e) => set('generateWorld', e.target.checked) }),
                '创建后让 AI 生成世界地图（8–20 个地点 + 连接）'),
              h('p', { className: 'sd-hint sd-create-world-hint' }, form.generateWorld !== false
                ? '创建后会新建会话并发送 world-build 任务，产出世界设定与地点提案；作者可在「🌍 世界」页拖拽校准。'
                : '只创建作品；之后可在「🌍 世界」页通过清单生成世界地图。'),
              h('label', { className: 'sd-cb sd-create-world-toggle' },
                h('input', { type: 'checkbox', checked: form.openPipeline === true, onChange: (e) => set('openPipeline', e.target.checked) }),
                '创建后进入「整本书」：先生成蓝图与大纲'),
              h('p', { className: 'sd-hint sd-create-world-hint' }, form.openPipeline === true
                ? '创建成功后会切到「📚 整本书」页并打开生成向导（可先准备蓝图与大纲，验收后再生成）。'
                : '不勾选则创建后停在总览页。')))),
          h('div', { className: 'sd-modal-foot' }, h(Btn, { onClick: onClose }, '取消'), h(Btn, { kind: 'primary', onClick: save, disabled: busy }, busy ? '创建中…' : '创建')),
        ),
      )
    }

    // ── 提案页（AI 结果对比 + 采纳）────────────────────────────
    const PROPOSAL_KIND = { plan: '章节方案', chapter: '章节正文', events: '时间线', facts: '事实', characters: '人物', foreshadow: '伏笔', highlights: '高光', decision: '冲突决策', outlines: '章节大纲', custom: '自由' }

    /** 去掉章节文件 frontmatter，只留正文：历史版本存的是完整文件，和编辑器里的正文对比时要先剥掉。 */
    function stripChapterFrontmatter(text) {
      const raw = String(text ?? '')
      const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw)
      return match ? raw.slice(match[0].length) : raw
    }

    function diffLines(aText, bText) {
      const A = String(aText ?? '').split('\n')
      const B = String(bText ?? '').split('\n')
      const n = A.length
      const m = B.length
      if (n > 400 || m > 400) {
        return [...A.map((text) => ({ type: 'del', text })), ...B.map((text) => ({ type: 'add', text }))]
      }
      const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
        }
      }
      const out = []
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (A[i] === B[j]) { out.push({ type: 'same', text: A[i] }); i += 1; j += 1 }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i] }); i += 1 }
        else { out.push({ type: 'add', text: B[j] }); j += 1 }
      }
      while (i < n) { out.push({ type: 'del', text: A[i] }); i += 1 }
      while (j < m) { out.push({ type: 'add', text: B[j] }); j += 1 }
      return out
    }

    function ProposalTab({ bundle, projectId, onChanged, onAskAi, onAddCart, onGoTab }) {
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [feedbackFor, setFeedbackFor] = useState('')
      const [feedbackText, setFeedbackText] = useState('')
      const [showDone, setShowDone] = useState(false)
      const [reopenSelected, setReopenSelected] = useState([])
      const [selected, setSelected] = useState([])
      const [kindFilter, setKindFilter] = useState('all')
      const [bulkBusy, setBulkBusy] = useState(false)
      const [choices, setChoices] = useState({})
      const [authorOpinions, setAuthorOpinions] = useState({})
      const [decisionModes, setDecisionModes] = useState({})
      const priorityRank = (p) => Number(p.priority) || 3
      const pendingAll = (bundle.proposals ?? []).filter((p) => p.status === 'pending').sort((a, b) => priorityRank(a) - priorityRank(b))
      const pendingKinds = [...new Set(pendingAll.map((p) => p.kind))]
      const pending = pendingAll.filter((p) => kindFilter === 'all' || p.kind === kindFilter)
      const selectedPending = pendingAll.filter((p) => selected.includes(p.id))
      const done = (bundle.proposals ?? []).filter((p) => p.status !== 'pending')
      const toggle = (id) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
      const allSelected = pending.length > 0 && pending.every((p) => selected.includes(p.id))
      const toggleAll = () => {
        if (allSelected) setSelected((prev) => prev.filter((id) => !pending.some((p) => p.id === id)))
        else setSelected((prev) => [...new Set([...prev, ...pending.map((p) => p.id)])])
      }
      const bulkAct = async (action) => {
        const ids = selectedPending.map((p) => p.id)
        if (ids.length === 0) {
          window.alert('请先勾选要处理的提案')
          return
        }
        if (!window.confirm(`批量${action === 'accept' ? '采纳' : '驳回'} ${ids.length} 条提案？`)) return
        setBulkBusy(true)
        setNotice(`正在${action === 'accept' ? '采纳' : '驳回'} ${ids.length} 条提案…`)
        try {
          const value = await api(action === 'accept' ? 'proposal.batchAccept' : 'proposal.batchReject', { projectId, ids })
          const failed = value?.failed ?? []
          const okCount = action === 'accept' ? (value?.accepted?.length ?? 0) : (value?.rejected?.length ?? 0)
          const kinds = [...new Set(selectedPending.map((p) => p.kind))]
          const kindSummary = kinds.map((kind) => `${PROPOSAL_KIND[kind] ?? kind} ${selectedPending.filter((p) => p.kind === kind).length}`).join(' · ')
          setNotice(`${action === 'accept' ? '已采纳' : '已驳回'} ${okCount} 条${kindSummary ? `（${kindSummary}）` : ''}${failed.length > 0 ? `，失败 ${failed.length} 条` : ''}`)
          if (failed.length > 0) {
            window.alert(`成功 ${okCount} 条，失败 ${failed.length} 条：\n${failed.map((f) => `${f.id}：${f.error ?? '未知错误'}`).join('\n')}`)
          }
          setSelected([])
          await onChanged()
          if (action === 'accept' && (kinds.includes('world') || kinds.includes('locations'))) {
            if (window.confirm('世界与地点已更新。现在去 🌍 世界页看看地图？')) onGoTab?.('world')
          }
        } catch (error) {
          setNotice('')
          window.alert(`批量${action === 'accept' ? '采纳' : '驳回'}失败：${error.message}`)
        } finally {
          setBulkBusy(false)
        }
      }
      const act = async (p, action, optionId) => {
        if (!window.confirm(`${action === 'accept' ? '采纳' : '驳回'}提案「${p.title}」？`)) return
        setBusy(p.id)
        setNotice(`正在${action === 'accept' ? '采纳' : '驳回'}「${p.title}」…`)
        try {
          await api(action === 'accept' ? 'proposal.accept' : 'proposal.reject', { projectId, proposalId: p.id, optionId })
          setNotice(`${action === 'accept' ? '已采纳' : '已驳回'}「${p.title}」`)
          await onChanged()
          if (action === 'accept' && (p.kind === 'world' || p.kind === 'locations')) {
            if (window.confirm('世界与地点已更新。现在去 🌍 世界页看看地图？')) onGoTab?.('world')
          }
        } catch (error) {
          window.alert(error.message)
        } finally {
          setBusy('')
        }
      }
      const toggleReopen = (id) => setReopenSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
      const batchReopen = async (ids) => {
        if (ids.length === 0) { window.alert('请先勾选要重新打开的提案'); return }
        setBusy('batch-reopen')
        try {
          const value = await api('proposal.batchReopen', { projectId, ids })
          window.alert(`已重新打开 ${value?.reopened ?? 0} 条${value?.missing?.length ? `，${value.missing.length} 条未找到` : ''}`)
          setReopenSelected([])
          onChanged()
        } catch (error) {
          window.alert(`批量重新打开失败：${error.message}`)
        } finally {
          setBusy('')
        }
      }
      const reopen = async (p) => {
        setBusy(p.id)
        try {
          await api('proposal.reopen', { projectId, proposalId: p.id })
          onChanged()
        } catch (error) {
          window.alert(`重新打开失败：${error.message}`)
        } finally {
          setBusy('')
        }
      }
      const submitFeedback = async (p) => {
        const text = feedbackText.trim()
        if (!text) { window.alert('请先写修改意见'); return }
        setBusy(p.id)
        try {
          await api('proposal.feedback', { projectId, proposalId: p.id, text })
          setFeedbackText('')
          setFeedbackFor('')
          onChanged()
        } catch (error) { window.alert(error.message) } finally { setBusy('') }
      }
      const revise = async (p) => {
        const feedback = (p.feedback ?? []).map((item) => item.text).join('\n')
        if (!feedback.trim()) { window.alert('请先写修改意见'); return }
        setBusy(p.id)
        try {
          await sendToChat({ projectId, task: 'revise-proposal', proposalId: p.id, chapter: p.chapter, feedback })
        } catch (error) { window.alert(`发送到对话失败：${error.message}`) } finally { setBusy('') }
      }
      const renderBody = (p) => {
        const data = p.data ?? {}
        if (p.kind === 'decision') {
          const aiSuggestion = data.aiSuggestion ?? data.suggestion ?? data.answer ?? ''
          const valueOptions = (data.options ?? []).filter((option) => option.factId || option.value)
          if (valueOptions.length > 0) {
            const chosen = choices[p.id] ?? data.recommendedOptionId ?? valueOptions[0].id
            return h('div', { className: 'sd-proposal-body' },
              h('div', { className: 'sd-decision-issue' }, data.reviewIssue ?? data.summary ?? p.summary ?? ''),
              valueOptions[0].value !== undefined ? h('div', { className: 'sd-hint' }, `「${data.subject ?? ''}」的「${data.attribute ?? ''}」有 ${valueOptions.length} 个取值，选一个作为正史：`) : null,
              h('div', { className: 'sd-decision-options' },
                valueOptions.map((option) => h('label', { key: option.id, className: 'sd-decision-option' },
                  h('input', { type: 'radio', name: `decision-${p.id}`, checked: chosen === option.id, onChange: () => setChoices((prev) => ({ ...prev, [p.id]: option.id })) }),
                  h('span', null, option.label),
                  option.id === data.recommendedOptionId ? h(Tag, { tone: 'brand' }, 'AI 推荐') : null))),
              h(Field, { label: '作者补充意见（可选）' }, h(TextArea, { value: authorOpinions[p.id] ?? '', rows: 2, placeholder: '例如：选第 1 回，但把第 5 回的表述改成回忆…', onChange: (value) => setAuthorOpinions((prev) => ({ ...prev, [p.id]: value })) })),
              h('div', { className: 'sd-hint' }, '选好值后加入清单；发到对话会按你的选择和补充意见落成具体修改提案。'))
          }
          const mode = decisionModes[p.id] ?? 'ai'
          return h('div', { className: 'sd-proposal-body' },
            h('div', { className: 'sd-decision-issue' }, data.reviewIssue ?? data.summary ?? p.summary ?? ''),
            h('div', { className: 'sd-decision-options' },
              h('label', { className: 'sd-decision-option' },
                h('input', { type: 'radio', name: `mode-${p.id}`, checked: mode === 'ai', onChange: () => setDecisionModes((prev) => ({ ...prev, [p.id]: 'ai' })) }),
                h('span', null, aiSuggestion ? `同意 AI 建议：${aiSuggestion}` : '同意 AI 建议')),
              h('label', { className: 'sd-decision-option' },
                h('input', { type: 'radio', name: `mode-${p.id}`, checked: mode === 'author', onChange: () => setDecisionModes((prev) => ({ ...prev, [p.id]: 'author' })) }),
                h('span', null, '按作者意见处理'))),
            mode === 'author'
              ? h(Field, { label: '作者意见 *' }, h(TextArea, { value: authorOpinions[p.id] ?? '', rows: 2, placeholder: '写清楚你希望怎么处理…', onChange: (value) => setAuthorOpinions((prev) => ({ ...prev, [p.id]: value })) }))
              : null,
            h('div', { className: 'sd-hint' }, '加入清单后，这条意见会随清单一起发给对话。'))
        }
        if (p.kind === 'chapter') {
          const existing = (bundle.chapters ?? []).find((c) => String(Number(c.id)) === String(Number(p.chapter)))
          const diff = diffLines(existing?.content ?? '', data.content ?? '')
          const changed = diff.filter((d) => d.type !== 'same').length
          return h('div', null,
            h('div', { className: 'sd-hint' }, `与现有第 ${p.chapter ?? '?'} 章对比：${changed} 行有变化 ｜ 新稿 ${String(data.content ?? '').length} 字符`),
            h('div', { className: 'sd-diff' }, diff.slice(0, 160).map((d, idx) => h('div', { key: idx, className: `sd-diff-${d.type}` }, `${d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' '} ${d.text}`))),
          )
        }
        if (p.kind === 'plan') {
          return h('div', { className: 'sd-proposal-body' },
            data.beats?.length ? h('div', null, h('strong', null, '节拍：'), h('ul', { className: 'sd-ul' }, data.beats.map((b, i) => h('li', { key: i }, b)))) : null,
            data.events?.length ? h('div', null, h('strong', null, `事件（${data.events.length}）：`), h('ul', { className: 'sd-ul' }, data.events.map((e, i) => h('li', { key: i }, `第${e.chapter ?? p.chapter}章 · ${e.title ?? ''}：${e.summary ?? ''}`)))) : null,
            data.facts?.length ? h('div', null, h('strong', null, `事实（${data.facts.length}）：`), h('ul', { className: 'sd-ul' }, data.facts.map((f, i) => h('li', { key: i }, `${f.subject} · ${f.attribute} = ${f.value}`)))) : null,
            data.foreshadow?.length ? h('div', null, h('strong', null, `伏笔（${data.foreshadow.length}）：`), h('ul', { className: 'sd-ul' }, data.foreshadow.map((f, i) => h('li', { key: i }, `${f.title}（第${f.setupChapter}章埋 → 第${f.payoffChapter}章收）`)))) : null,
          )
        }
        if (p.kind === 'custom') {
          return h('div', { className: 'sd-proposal-text' }, data.answer ?? p.summary ?? JSON.stringify(data, null, 2))
        }
        const items = p.items ?? data.items ?? []
        return h('div', { className: 'sd-proposal-body' }, items.slice(0, 20).map((item, i) => h('div', { key: i, className: 'sd-proposal-item' }, JSON.stringify(item))))
      }
      return h('div', { className: 'sd-page' },
        h('div', { className: 'sd-pagehead' },
          h('div', null, h('h2', { className: 'sd-h2' }, '📥 提案'), h('p', { className: 'sd-desc' }, 'AI 或 Agent 生成的内容先停在这里。同意就加入本次清单，和清单一起交给对话处理；不同意就驳回。工作台不直接改正文。')),

        ),
        pendingAll.length > 0 ? h('div', { className: 'sd-bulkbar' },
          h('label', { className: 'sd-cb' }, h('input', { type: 'checkbox', checked: allSelected, onChange: toggleAll }), '全选'),
          h('span', { className: 'sd-hint' }, `待采纳 ${pendingAll.length} 条，已选 ${selectedPending.length} 条`),
          h('select', { className: 'sd-input sd-select-inline', value: kindFilter, onChange: (e) => setKindFilter(e.target.value) },
            h('option', { value: 'all' }, '全部类型'),
            pendingKinds.map((kind) => h('option', { key: kind, value: kind }, PROPOSAL_KIND[kind] ?? kind))),
          h('div', { className: 'sd-bulkbar-actions' },
            h(Btn, { small: true, kind: 'primary', disabled: bulkBusy || selectedPending.length === 0, onClick: () => bulkAct('accept') }, bulkBusy ? '处理中…' : `批量采纳（${selectedPending.length}）`),
            h(Btn, { small: true, disabled: bulkBusy || selectedPending.length === 0, onClick: () => bulkAct('reject') }, '批量驳回'),
          ),
        ) : null,
        notice ? h('div', { className: 'sd-notice' }, notice) : null,
        pendingAll.length === 0 ? h(Empty, null, '没有待处理提案。可以加入清单「从头审阅」，或让对话里的 AI 生成后回到这里。') : pending.length === 0 ? h(Empty, null, '当前筛选下没有待采纳的提案。换个类型看看。') : pending.map((p) => h('div', { key: p.id, className: 'sd-proposal' },
          h('div', { className: 'sd-proposal-head' },
            h('label', { className: 'sd-cb sd-cb-only', title: '选择该提案' }, h('input', { type: 'checkbox', checked: selected.includes(p.id), onChange: () => toggle(p.id) })),
            h(Tag, { tone: 'brand' }, PROPOSAL_KIND[p.kind] ?? p.kind),
            p.priority && p.priority <= 2 ? h(Tag, { tone: 'muted' }, p.priority === 1 ? '阻断' : '严重') : null,
            h(Tag, { tone: 'muted' }, p.chapter ? `第 ${p.chapter} 章` : '全书'),
            h('strong', { className: 'sd-proposal-title' }, p.title),
            h('span', { className: 'sd-hint' }, p.source === 'agent' ? 'Agent 提交' : 'AI 生成'),
          ),
          p.summary ? h('div', { className: 'sd-proposal-summary' }, p.summary) : null,
          p.rationale ? h('div', { className: 'sd-hint' }, p.rationale) : null,
          renderBody(p),
          Array.isArray(p.feedback) && p.feedback.length > 0 ? h('div', { className: 'sd-feedback-list' },
            h('div', { className: 'sd-hint' }, `修改意见（${p.feedback.length}）`),
            p.feedback.map((f, i) => h('div', { key: f.id ?? i, className: 'sd-feedback-item' }, f.text)),
          ) : null,
          feedbackFor === p.id ? h('div', { className: 'sd-feedback-editor' },
            h(TextArea, { value: feedbackText, rows: 3, placeholder: '写清楚要改什么：保留什么、删掉什么、朝哪个方向改…', onChange: setFeedbackText }),
            h('div', { className: 'sd-form-actions' },
              h(Btn, { kind: 'primary', onClick: () => submitFeedback(p), disabled: busy === p.id }, '保存意见'),
              h(Btn, { onClick: () => { setFeedbackFor(''); setFeedbackText('') } }, '取消'),
            ),
          ) : null,
          p.kind !== 'decision' ? h(Field, { label: '作者意见（可选）' }, h(TextArea, { value: authorOpinions[p.id] ?? '', rows: 2, placeholder: '对这份提案的补充要求，会随清单一起发给对话…', onChange: (value) => setAuthorOpinions((prev) => ({ ...prev, [p.id]: value })) })) : null,
          p.kind === 'decision'
            ? h('div', { className: 'sd-proposal-actions' },
                onAddCart ? h(Btn, { kind: 'primary', onClick: () => {
                  const valueOptions = (p.data?.options ?? []).filter((option) => option.factId || option.value)
                  const aiSuggestion = p.data?.aiSuggestion ?? p.data?.suggestion ?? p.data?.answer ?? ''
                  const authorOpinion = (authorOpinions[p.id] ?? '').trim()
                  if (valueOptions.length > 0) {
                    const chosenId = choices[p.id] ?? p.data?.recommendedOptionId ?? valueOptions[0]?.id
                    const chosen = valueOptions.find((option) => option.id === chosenId)
                    onAddCart({ kind: 'proposal', id: p.id, chapter: p.chapter, title: p.title, proposalKind: 'decision', aiSuggestion, choice: chosen?.label ?? '', authorOpinion, detail: p.summary ?? '' })
                    return
                  }
                  const mode = decisionModes[p.id] ?? 'ai'
                  if (mode === 'author' && !authorOpinion) { window.alert('选了「按作者意见处理」，请先写作者意见'); return }
                  onAddCart({ kind: 'proposal', id: p.id, chapter: p.chapter, title: p.title, proposalKind: 'decision', aiSuggestion, choice: mode === 'ai' ? '同意 AI 建议' : '按作者意见处理', authorOpinion, detail: p.summary ?? '' })
                } }, '加入清单') : null,
                h(Btn, { onClick: () => act(p, 'reject'), disabled: busy === p.id }, '驳回'),
              )
            : h('div', { className: 'sd-proposal-actions' },
                onAddCart ? h(Btn, { kind: 'primary', onClick: () => onAddCart({
                  kind: 'proposal',
                  id: p.id,
                  chapter: p.chapter,
                  title: p.title,
                  proposalKind: p.kind,
                  approved: true,
                  authorOpinion: (authorOpinions[p.id] ?? '').trim(),
                  detail: [p.summary, ...(p.feedback ?? []).map((item) => `作者意见：${item.text}`)].filter(Boolean).join('；'),
                }) }, '同意并加入清单') : null,
                h(Btn, { onClick: () => act(p, 'reject'), disabled: busy === p.id }, '驳回'),
              ),
        )),
        done.length > 0 ? h('div', { className: 'sd-section' },
          h('div', { className: 'sd-pagehead' },
            h('div', null, h('h3', { className: 'sd-h3' }, `已处理 / 待确认（${done.length}）`), h('p', { className: 'sd-hint' }, '「已修订」表示生成了替代提案；替代提案采纳前不算处理完，可勾选后批量重新打开。')),
            h('div', { className: 'sd-form-actions' },
              h(Btn, { small: true, onClick: () => setShowDone(!showDone) }, showDone ? '收起' : '展开'),
              h(Btn, { small: true, disabled: busy === 'batch-reopen' || !done.some((p) => reopenSelected.includes(p.id)), onClick: () => batchReopen(done.filter((p) => reopenSelected.includes(p.id)).map((p) => p.id)) }, `重新打开所选（${done.filter((p) => reopenSelected.includes(p.id)).length}）`))),
          showDone ? h('div', { className: 'sd-mini-list' }, done.slice(-30).reverse().map((p) => h('div', { key: p.id, className: 'sd-mini-row' },
            h('input', { type: 'checkbox', checked: reopenSelected.includes(p.id), onChange: () => toggleReopen(p.id) }),
            h(Tag, { tone: 'muted' }, { accepted: '已采纳', rejected: '已驳回', revised: '已修订', superseded: '已替代' }[p.status] ?? p.status),
            h('span', { className: 'sd-mini-title' }, p.title),
            h(Btn, { small: true, onClick: () => reopen(p), disabled: busy === p.id }, busy === p.id ? '处理中…' : '重新打开')))) : null,
        ) : null,
      )
    }

    // ── 对齐页 ────────────────────────────────────────────────
    function AlignmentTab({ bundle }) {
      const a = bundle.alignment
      if (!a) return h(Empty, null, '暂无对齐数据。')
      const presets = bundle.presets ?? []
      const activeId = bundle.project?.activePresetId
      const activePreset = presets.find((p) => p.id === activeId)
      const presetName = activePreset?.name || (activeId ? '未找到当前预设（可能已删除）' : a.presetName || presets[0]?.name || '未设置')
      const presetHint = activeId ? '来自「预设」页的当前预设' : '未设置当前预设，默认使用第一套'
      const bar = (pct) => h('div', { className: 'sd-progress' }, h('div', { className: 'sd-progress-fill', style: { width: `${pct ?? 0}%` } }))
      return h('div', { className: 'sd-page' },
        h('div', { className: 'sd-pagehead' }, h('div', null, h('h2', { className: 'sd-h2' }, '🎯 计划对齐'), h('p', { className: 'sd-desc' }, `当前预设：${presetName}。预设计划 vs 实际产出，目标来自「预设」页的写作方案。`))),
        h('div', { className: 'sd-align-cards' },
          h('div', { className: 'sd-align-card' }, h('div', { className: 'sd-align-label' }, '当前预设'), h('div', { className: 'sd-align-value sd-align-value-sm', title: presetName }, presetName), h('div', { className: 'sd-hint' }, presetHint)),
          h('div', { className: 'sd-align-card' }, h('div', { className: 'sd-align-label' }, '章节进度'), h('div', { className: 'sd-align-value' }, `${a.actualChapters} / ${a.plannedChapters || '—'}`), bar(a.chapterProgress)),
          h('div', { className: 'sd-align-card' }, h('div', { className: 'sd-align-label' }, '字数进度'), h('div', { className: 'sd-align-value' }, `${a.actualWords} / ${a.totalWords || '—'}`), bar(a.wordProgress)),
          h('div', { className: 'sd-align-card' }, h('div', { className: 'sd-align-label' }, '每章目标'), h('div', { className: 'sd-align-value' }, a.chapterWords ? `${a.chapterWords} 字` : '未设置'), h('div', { className: 'sd-hint' }, '在「预设」里设置')),
          h('div', { className: 'sd-align-card' }, h('div', { className: 'sd-align-label' }, '待处理'), h('div', { className: 'sd-align-value' }, `${a.pendingProposals} 提案 / ${a.openReviews} 审稿`), h('div', { className: 'sd-hint' }, '提案和审稿都要人处理')),
        ),
        a.perChapter.length === 0 ? h(Empty, null, '还没有章节。') : h('div', { className: 'sd-table' },
          h('div', { className: 'sd-row sd-row-head', style: { gridTemplateColumns: '56px 1fr 90px 110px 70px 70px 70px 70px' } },
            h('div', null, '章'), h('div', null, '标题'), h('div', null, '字数'), h('div', null, '偏离目标'), h('div', null, '事件'), h('div', null, '事实'), h('div', null, '待审'), h('div', null, '提案')),
          a.perChapter.map((row) => h('div', { key: row.id, className: 'sd-row', style: { gridTemplateColumns: '56px 1fr 90px 110px 70px 70px 70px 70px' } },
            h('div', { className: 'sd-cell' }, row.id),
            h('div', { className: 'sd-cell', title: row.title }, row.title),
            h('div', { className: 'sd-cell' }, String(row.words)),
            h('div', { className: 'sd-cell', style: { color: row.delta === null ? 'inherit' : row.delta < 0 ? 'var(--dsw-alias-state-warn-primary,#d68910)' : 'var(--dsw-alias-state-success-primary,#1e8449)' } }, row.delta === null ? '—' : `${row.delta >= 0 ? '+' : ''}${row.delta}`),
            h('div', { className: 'sd-cell' }, String(row.events)),
            h('div', { className: 'sd-cell' }, String(row.facts)),
            h('div', { className: 'sd-cell' }, String(row.openReviews)),
            h('div', { className: 'sd-cell' }, String(row.proposals)),
          )),
        ),
      )
    }

    // ── AI 对话框 ─────────────────────────────────────────────
    const AI_TASKS = [
      ['next-chapter-plan', '生成下一章方案', '产出标题、摘要、节拍、事件、事实、伏笔 → 进入提案'],
      ['continue-chapter', '续写下一章正文', '按写作预设写完整一章 → 进入提案，采纳前不动正文'],
      ['review-chapter', 'AI 审稿', '按预设的审稿重点逐项检查 → 写入「审稿」'],
      ['generate-timeline', '补全时间线', '为指定章节生成事件 → 进入提案'],
      ['extract-facts', '抽取事实与人物', '从指定章节抽取账本条目 → 进入提案'],
      ['custom', '自由指令', '描述你要 AI 做什么，结果进入提案'],
    ]

    function AiDialog({ bundle, projectId, initialTask, initialChapter, onClose, onChanged }) {
      const nextChapter = bundle.chapters.length > 0 ? Math.max(...bundle.chapters.map((c) => Number(c.id) || 0)) + 1 : 1
      const [task, setTask] = useState(initialTask || 'next-chapter-plan')
      const [chapter, setChapter] = useState(initialChapter || nextChapter)
      const [instruction, setInstruction] = useState('')
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState('')
      const run = async () => {
        setBusy(true)
        setResult('')
        try {
          await sendToChat({ projectId, task, chapter: Number(chapter), instruction })
        } catch (error) {
          setResult(`❌ ${error.message}`)
          setBusy(false)
        }
      }
      return h('div', { className: 'sd-modal-mask', onClick: (e) => e.target === e.currentTarget && !busy && onClose() },
        h('div', { className: 'sd-modal sd-modal-wide' },
          h('div', { className: 'sd-modal-head' }, h('strong', null, '🤖 发到对话执行'), h('span', { className: 'sd-hint' }, '工作台只负责验收；AI 动作全部在左侧对话里跑'), h(IconBtn, { onClick: () => !busy && onClose(), title: '关闭' }, '✕')),
          h('div', { className: 'sd-modal-body' },
            h('p', { className: 'sd-desc' }, '选好任务后会直接发送到左侧对话，由对话里的 Agent 调工具执行；结果以提案/审稿回到工作台。'),
            h('div', { className: 'sd-form sd-form-2' },
              h(Field, { label: '任务' }, h(Select, { value: task, options: AI_TASKS.map(([v, label]) => ({ value: v, label })), onChange: setTask })),
              h(Field, { label: '章号' }, h(TextInput, { value: chapter, type: 'number', onChange: (v) => setChapter(Number(v) || 1) })),
            ),
            h('div', { className: 'sd-hint', style: { marginBottom: 8 } }, (AI_TASKS.find((t) => t[0] === task) ?? [])[2] ?? ''),
            h(Field, { label: '补充指令（可选）' }, h(TextArea, { value: instruction, rows: 3, placeholder: '例如：这一章要让母亲露出破绽；或：重点检查时间线矛盾', onChange: setInstruction })),
            result ? h('pre', { className: 'sd-ai-result' }, result) : null,
            busy ? h('div', { className: 'sd-ai-busy' }, 'AI 正在生成，可能需要 30–120 秒…') : null,
          ),
          h('div', { className: 'sd-modal-foot' }, h(Btn, { onClick: () => !busy && onClose() }, '关闭'), h(Btn, { kind: 'primary', onClick: run, disabled: busy }, busy ? '发送中…' : '发送到对话')),
        ),
      )
    }


    // ── 预设页（作品预设 + 名家风格库）──────────────────────────
    function PresetCard({ preset, mode, busy, current, onEdit, onApply, onDelete, onAdd }) {
      const total = preset.plannedChapters && preset.chapterWords ? preset.plannedChapters * preset.chapterWords : preset.totalWords
      const actions = mode === 'builtin'
        ? [h(Btn, { key: 'add', kind: 'primary', small: true, disabled: busy, onClick: onAdd }, busy ? '添加中…' : '添加到作品')]
        : [
            h(Btn, { key: 'edit', small: true, onClick: onEdit }, '编辑'),
            h(Btn, { key: 'apply', small: true, kind: current ? undefined : 'primary', onClick: onApply }, current ? '重新应用目标' : '设为当前'),
            h(Btn, { key: 'del', small: true, kind: 'danger', onClick: onDelete }, '删除'),
          ]
      return h('div', { className: 'sd-preset-card' + (current ? ' sd-preset-current' : '') },
        h('div', { className: 'sd-preset-head' },
          h('strong', null, preset.name),
          current ? h(Tag, { tone: 'brand' }, '✓ 当前预设') : null,
          preset.authorStyle ? h(Tag, { tone: 'brand' }, preset.authorStyle) : null,
          preset.source === 'builtin' ? h(Tag, { tone: 'muted' }, '内置') : null),
        h('div', { className: 'sd-preset-meta' },
          `${preset.genre || '—'} ｜ ${preset.pov || '—'} ｜ ${preset.tense || '—'} ｜ ${preset.plannedChapters || '—'} 章 × ${preset.chapterWords || '—'} 字${total ? ` = ${total} 字` : ''}`),
        preset.tone ? h('div', { className: 'sd-hint' }, `基调：${preset.tone}`) : null,
        preset.description ? h('div', { className: 'sd-preset-desc' }, preset.description) : null,
        preset.styleRules?.length ? h('div', { className: 'sd-preset-block' }, h('div', { className: 'sd-hint' }, '风格规则'), h('ul', { className: 'sd-ul' }, preset.styleRules.map((r, i) => h('li', { key: i }, r)))) : null,
        preset.taboo?.length ? h('div', { className: 'sd-preset-block' }, h('div', { className: 'sd-hint' }, '禁忌'), h('ul', { className: 'sd-ul' }, preset.taboo.map((r, i) => h('li', { key: i }, r)))) : null,
        preset.reviewFocus?.length ? h('div', { className: 'sd-hint' }, `审稿重点：${preset.reviewFocus.join('、')}`) : null,
        h('div', { className: 'sd-proposal-actions' }, actions),
      )
    }

    function PresetsTab({ bundle, projectId, onChanged }) {
      const [templates, setTemplates] = useState([])
      const [busy, setBusy] = useState('')
      const [editing, setEditing] = useState(null)
      useEffect(() => {
        let alive = true
        api('preset.builtin').then((value) => { if (alive) setTemplates(value) }).catch(() => {})
        return () => { alive = false }
      }, [])
      const addTemplate = async (template) => {
        setBusy(template.id)
        try {
          await api('preset.add', { projectId, templateId: template.id })
          onChanged()
        } catch (error) { window.alert(error.message) } finally { setBusy('') }
      }
      const apply = async (preset) => {
        if (!window.confirm(`把「${preset.name}」设为当前预设？会同时把章数/字数/类型/视角应用为作品目标。`)) return
        setBusy(preset.id)
        try {
          await api('preset.apply', { projectId, presetId: preset.id })
          onChanged()
        } catch (error) { window.alert(error.message) } finally { setBusy('') }
      }
      const remove = async (preset) => {
        if (!window.confirm(`删除预设「${preset.name}」？`)) return
        try {
          await api('entity.delete', { projectId, kind: 'presets', entityId: preset.id })
          onChanged()
        } catch (error) { window.alert(error.message) }
      }
      const has = (template) => (bundle.presets ?? []).some((p) => p.name === template.name)
      return h('div', { className: 'sd-page' },
        h('div', { className: 'sd-pagehead' },
          h('div', null, h('h2', { className: 'sd-h2' }, '🎛️ 写作预设'), h('p', { className: 'sd-desc' }, '作品可以挂多套预设。预设里的计划章数/每章字数/总字数/结构/风格规则/禁忌/审稿重点，AI 写作与审稿都会读取。')),
          h(Btn, { kind: 'primary', onClick: () => setEditing({}) }, '＋ 自定义预设')),
        h('h3', { className: 'sd-h3' }, `当前作品预设（${(bundle.presets ?? []).length}）`),
        (bundle.presets ?? []).length > 0 ? h('p', { className: 'sd-desc' }, `当前预设：${(bundle.presets ?? []).find((p) => p.id === bundle.project?.activePresetId)?.name || (bundle.project?.activePresetId ? '未找到（可能已删除）' : '未设置（对齐默认用第一套）')}。点「设为当前」会把该预设写为当前并应用章数/字数目标。`) : null,
        (bundle.presets ?? []).length === 0
          ? h(Empty, null, '还没有预设。从下面的名家风格库里添加一套，或自定义。')
          : h('div', { className: 'sd-preset-grid' }, (bundle.presets ?? []).map((preset) => h(PresetCard, {
              key: preset.id, preset, mode: 'current', busy: busy === preset.id, current: preset.id === bundle.project?.activePresetId,
              onEdit: () => setEditing(preset), onApply: () => apply(preset), onDelete: () => remove(preset),
            }))),
        h('h3', { className: 'sd-h3 sd-mt' }, `名家风格库（${templates.length}）`),
        h('p', { className: 'sd-desc' }, '内置风格模板：金庸、古龙、梁羽生、柯南·道尔、阿加莎·克里斯蒂、东野圭吾、刘慈欣、村上春树。添加后可再改。'),
        h('div', { className: 'sd-preset-grid' }, templates.map((template) => h(PresetCard, {
          key: template.id, preset: template, mode: 'builtin',
          busy: busy === template.id || has(template),
          onAdd: () => addTemplate(template),
        }))),
        editing !== null ? h(EntityEditor, { kind: 'presets', item: editing, projectId, onClose: () => setEditing(null), onSaved: onChanged }) : null,
      )
    }

    // ══ v0.4 新增：工具函数 ═══════════════════════════════════
    function pad2(n) {
      return String(n).padStart(2, '0')
    }

    function formatDateTime(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    // 事实生效区间文案：第3章起 / 第3–10章 / 全程；无值时返回空串（列表里不显示）
    function formatFactRange(from, to) {
      const hasFrom = from !== undefined && from !== null && from !== '' && Number.isFinite(Number(from))
      const hasTo = to !== undefined && to !== null && to !== '' && Number.isFinite(Number(to))
      if (!hasFrom && !hasTo) return ''
      if (!hasFrom) return `至第${Number(to)}章`
      if (!hasTo) return Number(from) <= 1 ? '全程' : `第${Number(from)}章起`
      if (Number(from) === Number(to)) return `第${Number(from)}章`
      return `第${Number(from)}–${Number(to)}章`
    }

    // 事实的生效区间：清空时发 null（后端 merge 写入 null，checks 把 null 当缺省），避免旧值残留
    function cleanEntityPayload(kind, form) {
      const item = { ...form }
      if (kind === 'facts') {
        for (const key of ['validFrom', 'validTo']) {
          if (item[key] === '' || item[key] === null || item[key] === undefined) item[key] = null
          else if (Number.isFinite(Number(item[key]))) item[key] = Number(item[key])
        }
      }
      if (kind === 'events' && (item.volume === '' || item.volume === undefined)) item.volume = null
      return item
    }

    function relationshipList(value) {
      if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean)
      if (typeof value === 'string' && value.trim()) return value.split(/[、,，;；\n]/).map((s) => s.trim()).filter(Boolean)
      return []
    }

    // 关系条目：名字(关系) / 名字（关系） / 名字:关系 / 名字：关系
    function parseRelationship(text) {
      const raw = String(text ?? '').trim()
      if (!raw) return null
      const paren = raw.match(/^(.+?)[（(]([^（）()]*)[)）]$/)
      if (paren) return { name: paren[1].trim(), relation: paren[2].trim() }
      const colon = raw.match(/^([^:：]+)[:：](.+)$/)
      if (colon) return { name: colon[1].trim(), relation: colon[2].trim() }
      return { name: raw, relation: '' }
    }

    // 确定性伪随机：让关系图每次布局一致
    function mulberry32(seed) {
      let a = seed >>> 0
      return function nextRandom() {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    // 解析人物关系 -> 节点 + 边；目标不在人物库时生成虚线幽灵节点
    function buildRelationshipGraph(characters) {
      const nodes = []
      const byName = new Map()
      const ghosts = new Map()
      const edges = []
      const seen = new Set()
      for (const character of characters ?? []) {
        const name = String(character.name ?? '').trim()
        if (!name) continue
        const node = { id: 'c:' + String(character.id ?? name), name, role: character.role || 'minor', character, ghost: false }
        nodes.push(node)
        byName.set(name, node)
      }
      for (const character of characters ?? []) {
        const source = byName.get(String(character.name ?? '').trim())
        if (!source) continue
        for (const raw of relationshipList(character.relationships)) {
          const parsed = parseRelationship(raw)
          if (!parsed || !parsed.name) continue
          let target = byName.get(parsed.name) || byName.get(parsed.name.replace(/[（(].*$/, '').trim())
          if (!target) {
            const key = 'g:' + parsed.name
            if (!ghosts.has(key)) {
              const ghost = { id: key, name: parsed.name, role: 'ghost', character: null, ghost: true }
              ghosts.set(key, ghost)
              nodes.push(ghost)
            }
            target = ghosts.get(key)
          }
          if (!target || target.id === source.id) continue
          const edgeKey = `${source.id}→${target.id}|${parsed.relation || ''}`
          if (seen.has(edgeKey)) continue
          seen.add(edgeKey)
          edges.push({ id: edgeKey, source: source.id, target: target.id, relation: parsed.relation })
        }
      }
      return { nodes, edges }
    }

    // 力导向布局：圆环确定性初值 + 约 80 次迭代
    function layoutGraph(nodes, edges, width, height) {
      const n = nodes.length
      if (n === 0) return []
      const index = new Map(nodes.map((node, i) => [node.id, i]))
      const random = mulberry32(20261022)
      const pos = nodes.map((node, i) => {
        const angle = (i / n) * Math.PI * 2
        const radius = Math.min(width, height) * 0.32
        return {
          id: node.id,
          x: width / 2 + Math.cos(angle) * radius + (random() - 0.5) * 8,
          y: height / 2 + Math.sin(angle) * radius + (random() - 0.5) * 8,
        }
      })
      const k = Math.sqrt((width * height) / n) * 0.9
      let temperature = Math.min(width, height) * 0.09
      for (let iter = 0; iter < 80; iter += 1) {
        const disp = pos.map(() => ({ x: 0, y: 0 }))
        for (let i = 0; i < n; i += 1) {
          for (let j = i + 1; j < n; j += 1) {
            let dx = pos[i].x - pos[j].x
            let dy = pos[i].y - pos[j].y
            let d = Math.hypot(dx, dy)
            if (d < 0.01) {
              dx = (random() - 0.5) * 0.02
              dy = (random() - 0.5) * 0.02
              d = 0.01
            }
            const force = (k * k) / d
            const ux = dx / d
            const uy = dy / d
            disp[i].x += ux * force
            disp[i].y += uy * force
            disp[j].x -= ux * force
            disp[j].y -= uy * force
          }
        }
        for (const edge of edges) {
          const a = index.get(edge.source)
          const b = index.get(edge.target)
          if (a === undefined || b === undefined) continue
          const dx = pos[a].x - pos[b].x
          const dy = pos[a].y - pos[b].y
          const d = Math.max(0.01, Math.hypot(dx, dy))
          const force = (d * d) / k
          const ux = dx / d
          const uy = dy / d
          disp[a].x -= ux * force
          disp[a].y -= uy * force
          disp[b].x += ux * force
          disp[b].y += uy * force
        }
        for (let i = 0; i < n; i += 1) {
          disp[i].x += (width / 2 - pos[i].x) * 0.06
          disp[i].y += (height / 2 - pos[i].y) * 0.06
          const d = Math.max(0.01, Math.hypot(disp[i].x, disp[i].y))
          const stepLength = Math.min(d, temperature)
          pos[i].x += (disp[i].x / d) * stepLength
          pos[i].y += (disp[i].y / d) * stepLength
          pos[i].x = Math.max(52, Math.min(width - 52, pos[i].x))
          pos[i].y = Math.max(40, Math.min(height - 40, pos[i].y))
        }
        temperature *= 0.94
      }
      return pos
    }

    function triggerDownload(value) {
      if (!value) throw new Error('导出返回为空')
      let blob
      if (value.base64) {
        const binary = window.atob(value.base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
        blob = new Blob([bytes], { type: value.mime || 'application/octet-stream' })
      } else {
        blob = new Blob([value.markdown ?? ''], { type: value.mime || 'text/markdown;charset=utf-8' })
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

    async function downloadExport(projectId, format) {
      const value = await api('export', { projectId, format })
      triggerDownload(value)
      return value
    }

    function ViewToggle({ value, onChange, options }) {
      return h('div', { className: 'sd-toggle' }, options.map((option) =>
        h('button', {
          key: option.value,
          type: 'button',
          className: `sd-toggle-btn${value === option.value ? ' sd-toggle-active' : ''}`,
          onClick: () => onChange(option.value),
        }, option.label),
      ))
    }

    // ══ v0.4 新增：人物关系图 ═════════════════════════════════
    const GRAPH_W = 900
    const GRAPH_H = 540
    const GRAPH_ROLE = { protagonist: '主角', antagonist: '反派', supporting: '配角', minor: '龙套' }

    function RelationshipGraph({ characters, onEdit, onCreate }) {
      const graph = React.useMemo(() => buildRelationshipGraph(characters), [JSON.stringify(characters ?? [])])
      const [pos, setPos] = useState(() => layoutGraph(graph.nodes, graph.edges, GRAPH_W, GRAPH_H))
      const [hover, setHover] = useState('')
      const [drag, setDrag] = useState(null)
      const svgRef = useRef(null)
      const movedRef = useRef(false)

      useEffect(() => {
        setPos(layoutGraph(graph.nodes, graph.edges, GRAPH_W, GRAPH_H))
        setHover('')
        setDrag(null)
      }, [graph])

      const toSvg = (event) => {
        const rect = svgRef.current?.getBoundingClientRect()
        if (!rect || !rect.width) return { x: 0, y: 0 }
        return { x: ((event.clientX - rect.left) / rect.width) * GRAPH_W, y: ((event.clientY - rect.top) / rect.height) * GRAPH_H }
      }

      useEffect(() => {
        if (!drag) return undefined
        const onMove = (event) => {
          if (Math.hypot(event.clientX - drag.cx, event.clientY - drag.cy) > 3) movedRef.current = true
          const point = toSvg(event)
          setPos((prev) => prev.map((item) => (item.id === drag.id
            ? { id: item.id, x: Math.max(46, Math.min(GRAPH_W - 46, point.x + drag.dx)), y: Math.max(36, Math.min(GRAPH_H - 36, point.y + drag.dy)) }
            : item)))
        }
        const onUp = () => setDrag(null)
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        return () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
      }, [drag])

      if ((characters ?? []).length === 0) {
        return h(Empty, null, '还没有人物卡。先在「列表」里新建人物，再回来看关系图。')
      }

      const posById = new Map(pos.map((item) => [item.id, item]))
      const neighborIds = new Set()
      if (hover) {
        neighborIds.add(hover)
        for (const edge of graph.edges) {
          if (edge.source === hover) neighborIds.add(edge.target)
          if (edge.target === hover) neighborIds.add(edge.source)
        }
      }

      const edgeEls = graph.edges.map((edge) => {
        const a = posById.get(edge.source)
        const b = posById.get(edge.target)
        if (!a || !b) return null
        const active = Boolean(hover && (edge.source === hover || edge.target === hover))
        const dim = Boolean(hover && !active)
        return h(
          'g',
          { key: edge.id, style: { opacity: dim ? 0.18 : 1 } },
          h('line', { className: 'sd-graph-edge' + (active ? ' sd-graph-edge-hot' : ''), x1: a.x, y1: a.y, x2: b.x, y2: b.y }),
          edge.relation ? h('text', { className: 'sd-graph-edge-label', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 4 }, edge.relation) : null,
        )
      })

      const nodeEls = graph.nodes.map((node) => {
        const point = posById.get(node.id)
        if (!point) return null
        const dim = Boolean(hover && !neighborIds.has(node.id))
        const roleClass = node.ghost ? 'sd-graph-role-ghost' : 'sd-graph-role-' + (node.role || 'minor')
        return h(
          'g',
          {
            key: node.id,
            className: `sd-graph-node ${roleClass}${node.ghost ? ' sd-graph-node-ghost' : ''}${hover === node.id ? ' sd-graph-node-hot' : ''}`,
            style: { opacity: dim ? 0.28 : 1 },
            transform: `translate(${point.x},${point.y})`,
            onMouseEnter: () => setHover(node.id),
            onMouseLeave: () => setHover(''),
            onMouseDown: (event) => {
              event.preventDefault()
              movedRef.current = false
              const point2 = toSvg(event)
              setDrag({ id: node.id, dx: point.x - point2.x, dy: point.y - point2.y, cx: event.clientX, cy: event.clientY })
            },
            onClick: () => {
              if (movedRef.current) {
                movedRef.current = false
                return
              }
              if (node.ghost) onCreate(node.name)
              else onEdit(node.character)
            },
          },
          h('circle', { r: node.ghost ? 15 : 17 }),
          h('text', { y: 30 }, node.name),
          node.ghost ? h('text', { className: 'sd-graph-ghost-tip', y: 44 }, '待建卡') : null,
        )
      })

      return h(
        'div',
        { className: 'sd-graph' },
        h(
          'div',
          { className: 'sd-graph-legend' },
          h('span', { className: 'sd-graph-legend-title' }, `人物 ${graph.nodes.filter((node) => !node.ghost).length} · 关系 ${graph.edges.length}`),
          ['protagonist', 'antagonist', 'supporting', 'minor'].map((role) => h('span', { key: role }, h('i', { className: 'sd-dot sd-dot-' + role }), GRAPH_ROLE[role])),
          h('span', null, h('i', { className: 'sd-dot sd-dot-ghost' }), '幽灵节点（人物库未建卡）'),
          graph.edges.length === 0 ? h('span', { className: 'sd-hint' }, '在人物卡的「关系」里填「华羽生(师徒)」这样的条目即可连线') : null,
        ),
        h(
          'div',
          { className: 'sd-graph-wrap' },
          h('svg', { ref: svgRef, viewBox: `0 0 ${GRAPH_W} ${GRAPH_H}`, className: 'sd-graph-svg' },
            h('g', null, edgeEls),
            h('g', null, nodeEls),
          ),
        ),
        h('div', { className: 'sd-hint' }, '拖拽节点可调整位置；悬停高亮相邻节点；点击节点打开人物编辑卡，点击虚线幽灵节点可直接新建人物卡。'),
      )
    }

    // ══ v0.4 新增：时间线泳道图 ═══════════════════════════════
    const LANE_IMPORTANCE = { normal: '一般', major: '关键', climax: '高潮' }

    function TimelineLanes({ events, foreshadow, onEdit }) {
      const [zoom, setZoom] = useState(1)
      const list = [...(events ?? [])].sort((a, b) => (Number(a.chapter) || 0) - (Number(b.chapter) || 0))
      const arcs = (foreshadow ?? []).filter((item) => Number(item.setupChapter) > 0 && Number(item.payoffChapter) > 0)
      const chapterOf = (item) => {
        const n = Number(item.chapter)
        return Number.isFinite(n) && n > 0 ? n : 0
      }
      const volumeOf = (item) => {
        const value = item.volume
        if (value === undefined || value === null || String(value).trim() === '') return ''
        const text = String(value).trim()
        if (/^\d+$/.test(text)) return `第 ${text} 卷`
        return text
      }
      const hasVolume = list.some((item) => volumeOf(item))
      const maxChapter = Math.max(
        1,
        ...list.map(chapterOf),
        ...arcs.map((item) => Number(item.setupChapter) || 0),
        ...arcs.map((item) => Number(item.payoffChapter) || 0),
      )
      const lanes = []
      const laneIndexByKey = new Map()
      const ensureLane = (key, label) => {
        if (!laneIndexByKey.has(key)) {
          laneIndexByKey.set(key, lanes.length)
          lanes.push({ key, label })
        }
        return laneIndexByKey.get(key)
      }
      if (hasVolume) {
        const volumes = [...new Set(list.map(volumeOf))].filter(Boolean)
        volumes.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })).forEach((volume) => ensureLane('v:' + volume, volume))
        if (list.some((item) => !volumeOf(item))) ensureLane('v:', '未标卷')
      } else {
        const addChapterLane = (chapter) => {
          if (!Number.isFinite(chapter) || chapter <= 0) return
          const index = Math.floor((chapter - 1) / 20)
          ensureLane('c:' + index, `第 ${index * 20 + 1}–${index * 20 + 20} 章`)
        }
        list.forEach((item) => addChapterLane(chapterOf(item)))
        if (list.some((item) => !chapterOf(item))) ensureLane('c:', '未标章')
        // 伏笔埋收章所在泳道也要有，跨泳道弧线才画得准
        arcs.forEach((item) => {
          addChapterLane(Number(item.setupChapter))
          addChapterLane(Number(item.payoffChapter))
        })
      }
      if (lanes.length === 0 && arcs.length > 0) {
        const maxArcChapter = Math.max(1, ...arcs.map((item) => Number(item.payoffChapter) || 1))
        for (let index = 0; index <= Math.floor((maxArcChapter - 1) / 20); index += 1) {
          ensureLane('c:' + index, `第 ${index * 20 + 1}–${index * 20 + 20} 章`)
        }
      }
      if (lanes.length === 0) return h(Empty, null, '还没有事件，也没有可画的伏笔。先添加事件或伏笔，再回来看泳道。')

      const laneForChapter = (chapter) => {
        const n = Number(chapter)
        if (!Number.isFinite(n) || n <= 0) return hasVolume ? (laneIndexByKey.get('v:') ?? 0) : (laneIndexByKey.get('c:') ?? 0)
        if (hasVolume) {
          const owner = list.find((item) => chapterOf(item) === n && volumeOf(item))
          if (owner) return laneIndexByKey.get('v:' + volumeOf(owner)) ?? 0
          return 0
        }
        return laneIndexByKey.get('c:' + Math.floor((n - 1) / 20)) ?? 0
      }

      const cardW = Math.max(56, Math.round(120 * zoom))
      // 步长至少要比卡片宽，否则章节少时事件卡片会叠在一起
      const step = Math.max(16, Math.round(36 * zoom), cardW + 12)
      const cardH = Math.max(20, Math.round(34 * zoom))
      const laneH = Math.max(46, Math.round(72 * zoom))
      const padLeft = 104
      // 顶部留出伏笔弧线的空间，否则跨章弧线会被裁掉
      const padTop = 88
      const width = padLeft + step * maxChapter + 60
      const height = padTop + lanes.length * laneH + 16
      const xOf = (chapter) => padLeft + (Math.max(1, Math.min(maxChapter, Number(chapter) || 1)) - 1) * step + step / 2
      const laneTop = (index) => padTop + index * laneH

      const groups = new Map()
      for (const event of list) {
        const laneKey = hasVolume
          ? (volumeOf(event) ? 'v:' + volumeOf(event) : 'v:')
          : (chapterOf(event) ? 'c:' + Math.floor((chapterOf(event) - 1) / 20) : 'c:')
        const lane = laneIndexByKey.get(laneKey)
        if (lane === undefined) continue
        const key = `${lane}|${chapterOf(event)}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(event)
      }
      const placed = new Map()
      for (const [key, group] of groups) {
        const [lane, chapter] = key.split('|').map(Number)
        const count = group.length
        const spread = count > 1 ? (laneH - cardH - 10) / (count - 1) : 0
        group.forEach((event, index) => {
          const offset = count > 1 ? (index - (count - 1) / 2) * Math.min(spread, cardH + 6) : 0
          placed.set(event.id, { lane, chapter, offset })
        })
      }

      const laneEls = lanes.map((lane, index) => h(
        'g',
        { key: lane.key },
        h('rect', { className: 'sd-lane-band' + (index % 2 ? ' sd-lane-band-alt' : ''), x: 0, y: laneTop(index), width, height: laneH }),
        h('text', { className: 'sd-lane-label', x: 10, y: laneTop(index) + laneH / 2 + 4 }, lane.label),
      ))

      const tickStep = step >= 56 ? 5 : 10
      const tickEls = []
      for (let chapter = 1; chapter <= maxChapter; chapter += tickStep) {
        const x = xOf(chapter)
        tickEls.push(h('line', { key: 'tick-' + chapter, className: 'sd-lane-tick', x1: x, y1: padTop, x2: x, y2: height - 8 }))
        tickEls.push(h('text', { key: 'tick-label-' + chapter, className: 'sd-lane-tick-label', x, y: 14, textAnchor: 'middle' }, `第${chapter}章`))
      }

      const arcEls = arcs.map((item, index) => {
        const laneA = laneForChapter(item.setupChapter)
        const laneB = laneForChapter(item.payoffChapter)
        const x1 = xOf(item.setupChapter)
        const x2 = xOf(item.payoffChapter)
        const y1 = laneTop(laneA) + laneH / 2
        const y2 = laneTop(laneB) + laneH / 2
        const paid = item.status === 'paid'
        const lift = Math.max(26, Math.min(70, Math.abs(x2 - x1) * 0.12))
        const path = `M ${x1} ${y1} C ${x1} ${Math.min(y1, y2) - lift}, ${x2} ${Math.min(y1, y2) - lift}, ${x2} ${y2}`
        return h(
          'g',
          { key: 'arc-' + (item.id ?? index) },
          h('path', { className: 'sd-lane-arc' + (paid ? ' sd-lane-arc-paid' : ''), d: path }),
          h('title', null, `${item.title || '伏笔'}：第 ${item.setupChapter} 章埋 → 第 ${item.payoffChapter} 章${paid ? '收（已回收）' : '计划回收'}`),
        )
      })

      const eventEls = list.map((event) => {
        const spot = placed.get(event.id)
        if (!spot) return null
        const centerX = xOf(spot.chapter)
        const laneCenter = laneTop(spot.lane) + laneH / 2
        const x = centerX - cardW / 2
        const y = laneCenter - cardH / 2 + spot.offset
        const importance = LANE_IMPORTANCE[event.importance] ? event.importance : 'normal'
        const label = String(event.title || '未命名事件')
        const maxChars = Math.max(2, Math.floor((cardW - 12) / 12))
        return h(
          'g',
          { key: event.id, onClick: () => onEdit(event) },
          h('rect', { className: `sd-lane-ev sd-lane-ev-${importance}`, x, y, width: cardW, height: cardH, rx: 6 }),
          cardW >= 66 ? h('text', { className: 'sd-lane-ev-text', x: centerX, y: y + cardH / 2 + 4, textAnchor: 'middle' }, label.length > maxChars ? label.slice(0, maxChars) + '…' : label) : null,
          h('title', null, `${label}${spot.chapter ? `（第 ${spot.chapter} 章）` : '（未标章）'}${event.storyTime ? ' · ' + event.storyTime : ''}`),
        )
      })

      return h(
        'div',
        { className: 'sd-lane' },
        h(
          'div',
          { className: 'sd-lane-tools' },
          h('span', { className: 'sd-hint' }, '缩放'),
          h('input', { type: 'range', min: 0.5, max: 3, step: 0.1, value: zoom, className: 'sd-zoom', onChange: (e) => setZoom(Number(e.target.value)) }),
          h('span', { className: 'sd-hint sd-zoom-value' }, `${zoom.toFixed(1)}x`),
          h('span', { className: 'sd-hint' }, '事件：'),
          Object.keys(LANE_IMPORTANCE).map((key) => h('span', { key, className: 'sd-lane-legend' }, h('i', { className: 'sd-lane-swatch sd-lane-ev-' + key }), LANE_IMPORTANCE[key])),
          h('span', { className: 'sd-hint' }, '弧线：实线 = 未回收，灰色虚线 = 已回收'),
        ),
        h(
          'div',
          { className: 'sd-lane-scroll' },
          h('svg', { className: 'sd-lane-svg', width, height, viewBox: `0 0 ${width} ${height}` },
            h('g', null, laneEls),
            h('g', null, tickEls),
            h('g', null, arcEls),
            h('g', null, eventEls),
          ),
        ),
      )
    }

    // ══ v0.4 新增：批量审稿 ═══════════════════════════════════
    function ReviewsTab({ bundle, projectId, onChanged, onAddCart }) {
      const meta = KIND_META.reviews
      const [editing, setEditing] = useState(null)
      const [selected, setSelected] = useState([])
      const [severityFilter, setSeverityFilter] = useState('all')
      const [bulkBusy, setBulkBusy] = useState(false)
      const [showDone, setShowDone] = useState(false)
      const all = bundle.reviews ?? []
      const isDone = (review) => review.status === 'fixed' || review.status === 'wontfix'
      const severityRank = { blocker: 0, major: 1, minor: 2, suggestion: 3 }
      const bySeverity = (a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) || (Number(a.chapter) || 0) - (Number(b.chapter) || 0)
      const pendingAll = all.filter((review) => !isDone(review))
      const pending = pendingAll.filter((review) => severityFilter === 'all' || review.severity === severityFilter).sort(bySeverity)
      const done = all.filter(isDone).sort((a, b) => (Number(b.chapter) || 0) - (Number(a.chapter) || 0))
      const selectedRows = all.filter((review) => selected.includes(review.id))
      const selectedPending = selectedRows.filter((review) => !isDone(review))
      const selectedDone = selectedRows.filter((review) => isDone(review))
      const grid = '30px ' + meta.columns.map((c) => c.w || '1fr').join(' ') + ' 148px'
      const toggle = (id) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
      const allPendingSelected = pending.length > 0 && pending.every((review) => selected.includes(review.id))
      const toggleAllPending = () => {
        if (allPendingSelected) setSelected((prev) => prev.filter((id) => !pending.some((review) => review.id === id)))
        else setSelected((prev) => [...new Set([...prev, ...pending.map((review) => review.id)])])
      }
      const remove = async (review) => {
        if (!window.confirm(`删除这条审稿意见？\n${review.issue || review.id}`)) return
        try {
          await api('entity.delete', { projectId, kind: 'reviews', entityId: review.id })
          onChanged()
        } catch (error) {
          window.alert(error.message)
        }
      }
      const batchStatus = async (status, rows) => {
        const list = (rows ?? []).filter((review) => review && review.id)
        if (list.length === 0) {
          window.alert('请先勾选审稿意见')
          return
        }
        const label = { fixed: '已修', wontfix: '忽略', open: '待处理' }[status] ?? status
        if (!window.confirm(`把 ${list.length} 条审稿标记为「${label}」？`)) return
        setBulkBusy(true)
        try {
          const value = await api('review.batchUpdate', { projectId, ids: list.map((review) => review.id), status })
          const missing = value?.missing ?? []
          if (missing.length > 0) window.alert(`已更新 ${value?.updated ?? 0} 条，${missing.length} 条未找到：${missing.join('、')}`)
          setSelected([])
          onChanged()
        } catch (error) {
          window.alert(`批量更新失败：${error.message}`)
        } finally {
          setBulkBusy(false)
        }
      }
      // 审稿不直接发对话：先加入清单（清单是唯一 AI 入口），在清单里批量生成修订提案
      const addToCart = (rows) => {
        const list = (rows ?? []).filter((review) => review && review.id)
        if (list.length === 0) {
          window.alert('请先勾选审稿意见')
          return
        }
        if (!onAddCart) return
        onAddCart(list.map((review) => ({
          kind: 'review',
          id: review.id,
          chapter: review.chapter,
          title: (review.issue ?? '').slice(0, 50),
          detail: [review.issue, review.suggestion ? `建议：${review.suggestion}` : ''].filter(Boolean).join('；'),
        })))
        setSelected([])
      }
      const renderRows = (rows) => h('div', { className: 'sd-table' },
        h('div', { className: 'sd-row sd-row-head', style: { gridTemplateColumns: grid } },
          h('div', null),
          meta.columns.map((c) => h('div', { key: c.k }, c.t)),
          h('div', { className: 'sd-actions-col' }, '操作')),
        rows.map((review) => h('div', { key: review.id, className: 'sd-row' + (isDone(review) ? ' sd-row-done' : ''), style: { gridTemplateColumns: grid } },
          h('div', { className: 'sd-row-cb' }, h('input', { type: 'checkbox', checked: selected.includes(review.id), onChange: () => toggle(review.id) })),
          meta.columns.map((c) => {
            const text = c.format ? String(c.format(review[c.k], review)) : displayValue(c.k, review[c.k])
            return h('div', { key: c.k, className: 'sd-cell', title: text }, text)
          }),
          h('div', { className: 'sd-row-actions' },
            !isDone(review) && onAddCart ? h(Btn, { small: true, kind: 'primary', onClick: () => addToCart([review]) }, '加入清单') : null,
            isDone(review) ? h(Btn, { small: true, disabled: bulkBusy, onClick: () => batchStatus('open', [review]) }, '重新打开') : null,
            h(Btn, { small: true, onClick: () => setEditing(review) }, '编辑'),
            h(Btn, { small: true, kind: 'danger', onClick: () => remove(review) }, '删除'),
          ))))
      if (all.length === 0) {
        return h('div', { className: 'sd-page' },
          h('div', { className: 'sd-pagehead' },
            h('div', null, h('h2', { className: 'sd-h2' }, meta.icon + ' ' + meta.title), h('p', { className: 'sd-desc' }, meta.desc)),
            h('div', { className: 'sd-pagehead-actions' },
              h(Btn, { onClick: () => onAddCart({ kind: 'task', id: 'full-review', title: '从头审阅整个项目', task: 'full-review' }) }, '＋ 加入清单：从头审阅'),
              h(Btn, { kind: 'primary', onClick: () => setEditing({}) }, '＋ 新增'))),
          h(Empty, null, '还没有审稿意见。AI 审稿或手动新增都会出现在这里。'),
          editing !== null ? h(EntityEditor, { kind: 'reviews', item: editing, projectId, onClose: () => setEditing(null), onSaved: onChanged }) : null,
        )
      }
      return h('div', { className: 'sd-page' },
        h('div', { className: 'sd-pagehead' },
          h('div', null, h('h2', { className: 'sd-h2' }, meta.icon + ' ' + meta.title), h('p', { className: 'sd-desc' }, meta.desc + ' 待处理勾选后加入清单（清单里批量生成修订提案）；已处理默认折叠归档，可重新打开。')),
          h('div', { className: 'sd-pagehead-actions' },
            h(Btn, { onClick: () => onAddCart({ kind: 'task', id: 'full-review', title: '从头审阅整个项目', task: 'full-review' }) }, '＋ 加入清单：从头审阅'),
            h(Btn, { kind: 'primary', onClick: () => setEditing({}) }, '＋ 新增'))),
        h('div', { className: 'sd-bulkbar' },
          h('label', { className: 'sd-cb' }, h('input', { type: 'checkbox', checked: allPendingSelected, onChange: toggleAllPending }), '全选待处理'),
          h('span', { className: 'sd-hint' }, `待处理 ${pendingAll.length} 条，当前显示 ${pending.length} 条，已选 ${selectedPending.length} 条`),
          h('select', { className: 'sd-input sd-select-inline', value: severityFilter, onChange: (e) => setSeverityFilter(e.target.value) },
            h('option', { value: 'all' }, '全部严重度'),
            [['blocker', '阻断'], ['major', '严重'], ['minor', '一般'], ['suggestion', '建议']].map(([value, label]) => h('option', { key: value, value }, label))),
          h('div', { className: 'sd-bulkbar-actions' },
            h(Btn, { small: true, kind: 'primary', disabled: selectedPending.length === 0 || !onAddCart, onClick: () => addToCart(selectedPending) }, `加入清单（${selectedPending.length}）`),
            h(Btn, { small: true, disabled: bulkBusy || selectedPending.length === 0, onClick: () => batchStatus('fixed', selectedPending) }, `标记已修（${selectedPending.length}）`),
            h(Btn, { small: true, disabled: bulkBusy || selectedPending.length === 0, onClick: () => batchStatus('wontfix', selectedPending) }, '忽略'))),
        pending.length > 0
          ? renderRows(pending)
          : h('div', { className: 'sd-empty' }, pendingAll.length === 0 ? '待处理审稿已清空 🎉' : '当前严重度筛选下没有待处理审稿。'),
        done.length > 0 ? h('div', { className: 'sd-section sd-mt' },
          h('div', { className: 'sd-bulkbar' },
            h('span', { className: 'sd-hint' }, `已处理（${done.length}）：已修 + 忽略，默认归档收起`),
            h('div', { className: 'sd-bulkbar-actions' },
              h(Btn, { small: true, disabled: bulkBusy || selectedDone.length === 0, onClick: () => batchStatus('open', selectedDone) }, `重新打开所选（${selectedDone.length}）`),
              h(Btn, { small: true, onClick: () => setShowDone(!showDone) }, showDone ? '收起' : '展开'))),
          showDone ? h('div', { className: 'sd-mini-list' }, done.map((review) => h('div', { key: review.id, className: 'sd-mini-row' },
            h('input', { type: 'checkbox', checked: selected.includes(review.id), onChange: () => toggle(review.id) }),
            h(Tag, { tone: 'muted' }, review.status === 'fixed' ? '已修' : '忽略'),
            h('span', { className: 'sd-mini-title' }, `第${review.chapter}章 · ${review.dimension ?? ''} · ${(review.issue ?? '').slice(0, 70)}`),
            h(Btn, { small: true, disabled: bulkBusy, onClick: () => batchStatus('open', [review]) }, '重新打开')))) : null,
        ) : null,
        editing !== null ? h(EntityEditor, { kind: 'reviews', item: editing, projectId, onClose: () => setEditing(null), onSaved: onChanged }) : null,
      )
    }

    // ══ v0.6 新增：⚡ 注意力页 ══════════════════════════════════
    // X 轴按章号等距；宽度随章数增长（133 章 ≈ 2050px，容器横向滚动），高度固定 236px。
    const ATT_CHART = { minWidth: 640, height: 236, top: 16, bottom: 30, left: 36, right: 16, step: 15 }

    function attentionFocusCard(chapter) {
      try {
        const target = document.getElementById(`sd-att-card-${Number(chapter)}`)
        if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } catch {
        /* 滚动失败不影响阅读 */
      }
    }

    function AttentionChart({ rows }) {
      const axisRows = rows.filter((row) => attentionHasScore(row) || attentionHasDesign(row))
      if (axisRows.length === 0) {
        return h(Empty, null, '还没有可画的分数：先在分工页冷读回填 score，或在「＋ 新增」里填目标分 designScore。')
      }
      const count = axisRows.length
      const width = Math.max(ATT_CHART.minWidth, count * ATT_CHART.step + ATT_CHART.left + ATT_CHART.right)
      const plotWidth = width - ATT_CHART.left - ATT_CHART.right
      const plotHeight = ATT_CHART.height - ATT_CHART.top - ATT_CHART.bottom
      const xAt = (index) => ATT_CHART.left + (count === 1 ? plotWidth / 2 : (plotWidth * index) / (count - 1))
      const yAt = (score) => ATT_CHART.top + plotHeight * (1 - Math.max(0, Math.min(100, Number(score))) / 100)
      const buildPath = (pick) => {
        const parts = []
        let prevIndex = null
        axisRows.forEach((row, index) => {
          const value = pick(row)
          if (value === null) return
          // 缺数据的章断开折线，不假装插值
          const command = prevIndex === null || index !== prevIndex + 1 ? 'M' : 'L'
          parts.push(`${command}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`)
          prevIndex = index
        })
        return parts.join(' ')
      }
      const scorePath = buildPath((row) => (attentionHasScore(row) ? Number(row.score) : null))
      const designPath = buildPath((row) => (attentionHasDesign(row) ? Number(row.designScore) : null))
      const labelStep = Math.max(1, Math.ceil(count / 14))
      return h('div', { className: 'sd-att-chart' },
        h('div', { className: 'sd-att-legend' },
          ATTENTION_TYPES.map(([value, label]) => h('span', { key: value, className: 'sd-att-legend-item' },
            h('span', { className: `sd-att-swatch ${ATTENTION_TYPE_CLASS[value]}` }), label)),
          h('span', { className: 'sd-att-legend-item' }, h('span', { className: 'sd-att-legend-dash' }), '虚线 = 目标分'),
          h('span', { className: 'sd-att-legend-item' }, h('span', { className: 'sd-att-legend-risk' }), '红圈 = 弃读点')),
        h('div', { className: 'sd-att-chart-scroll' },
          h('svg', {
            className: 'sd-att-chart-svg',
            width,
            height: ATT_CHART.height,
            viewBox: `0 0 ${width} ${ATT_CHART.height}`,
            role: 'img',
            'aria-label': '注意力分数曲线（X 轴章号，Y 轴 0–100）',
          },
          [0, 20, 40, 60, 80, 100].map((tick) => h(React.Fragment, { key: `tick-${tick}` },
            h('line', { className: 'sd-att-grid', x1: ATT_CHART.left, x2: width - ATT_CHART.right, y1: yAt(tick), y2: yAt(tick) }),
            h('text', { className: 'sd-att-axis-label', x: ATT_CHART.left - 8, y: yAt(tick) + 3, textAnchor: 'end' }, String(tick)))),
          axisRows.map((row, index) => (index % labelStep === 0 || index === count - 1)
            ? h('text', { key: `x-${index}`, className: 'sd-att-axis-label', x: xAt(index), y: ATT_CHART.height - 8, textAnchor: 'middle' }, String(Number(row.chapter)))
            : null),
          designPath ? h('path', { className: 'sd-att-design-line', d: designPath }) : null,
          scorePath ? h('path', { className: 'sd-att-score-line', d: scorePath }) : null,
          axisRows.map((row, index) => (attentionHasDesign(row)
            ? h('circle', { key: `design-${index}`, className: 'sd-att-design-dot', cx: xAt(index), cy: yAt(row.designScore), r: 2.6 },
                h('title', null, `第 ${Number(row.chapter)} 章 · 目标分 ${Number(row.designScore)}`))
            : null)),
          axisRows.map((row, index) => (attentionHasScore(row)
            ? h('circle', {
                key: `score-${index}`,
                className: `sd-att-dot ${ATTENTION_TYPE_CLASS[row.type] ?? ''}${row.dropRisk ? ' sd-att-dot-risk' : ''}`,
                cx: xAt(index),
                cy: yAt(row.score),
                r: row.dropRisk ? 5 : 4.2,
                onClick: () => attentionFocusCard(row.chapter),
              },
              h('title', null, `第 ${Number(row.chapter)} 章 · ${ATTENTION_TYPE_LABEL[row.type] ?? '未分型'} · ${Number(row.score)} 分${row.dropRisk ? ` · 弃读点：${row.dropRisk}` : ''}`))
            : null)),
          ),
        ),
      )
    }

    function AttentionStatsBar({ stats }) {
      return h(React.Fragment, null,
        h('div', { className: 'sd-att-stats' },
          h('div', { className: 'sd-att-stat' },
            h('div', { className: 'sd-att-stat-label' }, '全书平均分'),
            h('div', { className: `sd-att-stat-big${attentionScoreTone(stats.average)}` }, stats.average === null ? '—' : String(stats.average)),
            h('div', { className: 'sd-hint' }, `${stats.scored.length} 章有实测分`)),
          h('div', { className: 'sd-att-stat' },
            h('div', { className: 'sd-att-stat-label' }, '最低三章'),
            stats.lowest.length === 0
              ? h('div', { className: 'sd-hint' }, '还没有实测分')
              : h('div', { className: 'sd-att-stat-list' }, stats.lowest.map((row) => h('div', { key: row.id ?? `low-${row.chapter}`, className: 'sd-att-lowrow' },
                  h('span', null, `第 ${Number(row.chapter)} 章`),
                  h('span', { className: `sd-att-lowscore${attentionScoreTone(row.score)}` }, `${Number(row.score)} 分`))))),
          h('div', { className: 'sd-att-stat' },
            h('div', { className: 'sd-att-stat-label' }, '未标章数'),
            h('div', { className: 'sd-att-stat-big' }, String(stats.unmarked.length)),
            h('div', { className: 'sd-hint' }, '有正文但无注意力记录')),
          h('div', { className: 'sd-att-stat' },
            h('div', { className: `sd-att-stat-label` }, '疲劳 / 骤降预警'),
            h('div', { className: `sd-att-stat-big${stats.warnings.length > 0 ? ' sd-att-tone-mid' : ''}` }, String(stats.warnings.length)),
            h('div', { className: 'sd-hint' }, '同类型连续 >3 章、相邻章降 ≥15'))),
        stats.warnings.length > 0
          ? h('div', { className: 'sd-att-warns' }, stats.warnings.map((warning, index) => h('div', { key: `warn-${index}`, className: 'sd-att-warn' }, `⚠ ${warning.text}`)))
          : null,
      )
    }

    function AttentionCard({ row, bundle, onEdit, onGoTab }) {
      const chapter = Number(row.chapter)
      const subs = attentionSubItems(bundle, chapter)
      const score = attentionHasScore(row) ? Number(row.score) : null
      const design = attentionHasDesign(row) ? Number(row.designScore) : null
      const gap = score !== null && design !== null ? score - design : null
      const chapterTitle = (bundle.chapters ?? []).find((item) => Number(item.id) === chapter)?.title
      const verdictTone = ATTENTION_VERDICT_TONE[row.verdict] ?? ''
      const state = attentionStatusOf(row)
      const needsDesign = state.key === 'nodesign' || state.key === 'blank'
      const aggRow = (key, title, meta) => h('div', { key, className: 'sd-att-agg-row' },
        h('span', { className: 'sd-att-agg-title', title }, title),
        meta ? h('span', { className: 'sd-att-agg-meta' }, meta) : null)
      return h('article', { id: `sd-att-card-${chapter}`, className: 'sd-att-card' },
        h('div', { className: 'sd-att-card-head' },
          h('div', { className: 'sd-att-chapter' },
            `第 ${chapter} 章`,
            chapterTitle ? h('span', { className: 'sd-att-chapter-title' }, chapterTitle) : null),
          h('span', { className: `sd-att-type ${ATTENTION_TYPE_CLASS[row.type] ?? ''}` },
            h('span', { className: 'sd-att-swatch' }),
            ATTENTION_TYPE_LABEL[row.type] ?? '未分型'),
          h('span', { className: `sd-att-state sd-att-state-${state.key}`, title: '已闭环 = 设计 + 实测都有；待冷读 = 有设计没实测；缺设计 = 有实测没设计；空白 = 都没有' }, state.label),
          needsDesign ? h('span', { className: 'sd-att-design-hint' }, '补设计：点页面顶部「＋ 加入清单：AI 补齐注意力机制」') : null,
          score !== null
            ? h('span', { className: `sd-att-score${attentionScoreTone(score)}` }, String(score), h('span', { className: 'sd-att-score-unit' }, '/100'))
            : h('span', { className: 'sd-att-score sd-att-tone-missing' }, '未测'),
          design !== null ? h('span', { className: 'sd-att-design', title: '设计时定下的目标分' }, `目标 ${design}`) : null,
          gap !== null && Math.abs(gap) >= 20
            ? h('span', { className: `sd-att-gap${gap < 0 ? ' sd-att-gap-bad' : ''}`, title: '目标分与实测分差 ≥20：设计可能没兑现，值得复读这一章' }, `Δ ${gap > 0 ? '+' : ''}${gap}`)
            : null,
          row.verdict ? h(Tag, { tone: verdictTone }, `下一章：${row.verdict}`) : null,
          row.weakest ? h('span', { className: 'sd-att-meta' }, `最弱：${ATTENTION_WEAKEST_LABEL[row.weakest] ?? row.weakest}`) : null,
          row.status ? h(Tag, { tone: 'muted' }, ATTENTION_STATUS_LABEL[row.status] ?? row.status) : null,
          h('div', { className: 'sd-att-card-actions' }, h(Btn, { small: true, onClick: () => onEdit(row) }, '编辑'))),
        row.dropRisk ? h('div', { className: 'sd-att-drop' }, h('strong', null, '弃读点'), h('span', null, row.dropRisk)) : null,
        h('div', { className: 'sd-att-beats' }, ATTENTION_BEATS.map(([key, label, placeholder]) => h('div', { key, className: 'sd-att-beat' },
          h('div', { className: 'sd-att-beat-label' }, label),
          h('div', { className: `sd-att-beat-text${String(row[key] ?? '').trim() ? '' : ' sd-att-beat-empty'}` }, String(row[key] ?? '').trim() || placeholder)))),
        String(row.emotion ?? '').trim() ? h('div', { className: 'sd-att-emotion' }, h('strong', null, '情绪'), h('span', null, row.emotion)) : null,
        String(row.question ?? '').trim() ? h('div', { className: 'sd-att-question' }, h('strong', null, '读者最想知道'), h('span', null, row.question)) : null,
        String(row.detail ?? '').trim()
          ? h('details', { className: 'sd-att-detail' },
              h('summary', null, '详细说明'),
              h('div', { className: 'sd-att-detail-body' }, row.detail))
          : null,
        h('div', { className: 'sd-att-aggs' },
          h('details', { className: 'sd-att-agg' },
            h('summary', null, `🧩 本章伏笔 · 埋 ${subs.plants.length} / 收 ${subs.payoffs.length}`),
            h('div', { className: 'sd-att-agg-body' },
              subs.plants.map((item, index) => aggRow(`plant-${index}`, `埋：${item.title ?? '未命名'}`, item.status === 'paid' ? '已回收' : '未回收')),
              subs.payoffs.map((item, index) => aggRow(`payoff-${index}`, `收：${item.title ?? '未命名'}`, item.status === 'paid' ? '已回收' : '计划回收')),
              subs.plants.length + subs.payoffs.length === 0 ? h('div', { className: 'sd-hint' }, '本章没有埋设或回收伏笔') : null,
              onGoTab ? h('div', { className: 'sd-att-agg-actions' }, h(Btn, { small: true, onClick: () => onGoTab('foreshadow') }, '去伏笔页维护')) : null)),
          h('details', { className: 'sd-att-agg' },
            h('summary', null, `⚔️ 本章冲突 · 引爆 ${subs.conflicts.length}`),
            h('div', { className: 'sd-att-agg-body' },
              subs.conflicts.map((item, index) => aggRow(`conflict-${index}`, item.title ?? '未命名', CONFLICT_STATUS[item.status] ?? item.status ?? '—')),
              subs.conflicts.length === 0 ? h('div', { className: 'sd-hint' }, '本章没有计划引爆 / 解决的冲突') : null,
              onGoTab ? h('div', { className: 'sd-att-agg-actions' }, h(Btn, { small: true, onClick: () => onGoTab('conflicts') }, '去冲突页维护')) : null)),
          h('details', { className: 'sd-att-agg' },
            h('summary', null, `✨ 本章高光 · ${subs.highlights.length} 条`),
            h('div', { className: 'sd-att-agg-body' },
              subs.highlights.map((item, index) => aggRow(`highlight-${index}`, String(item.text ?? '未命名').slice(0, 120), displayValue('type', item.type))),
              subs.highlights.length === 0 ? h('div', { className: 'sd-hint' }, '本章还没有记录高光') : null,
              onGoTab ? h('div', { className: 'sd-att-agg-actions' }, h(Btn, { small: true, onClick: () => onGoTab('highlights') }, '去高光页维护')) : null))),
      )
    }

    function AttentionUnmarkedCard({ chapter, onEdit }) {
      return h('div', { id: `sd-att-card-${Number(chapter.id)}`, className: 'sd-att-unmarked' },
        h('div', { className: 'sd-att-unmarked-main' },
          h('span', { className: 'sd-att-unmarked-ch' }, `第 ${Number(chapter.id)} 章`),
          h('span', { className: 'sd-att-unmarked-title' }, chapter.title || '未命名'),
          h('span', { className: 'sd-att-unmarked-tag' }, '未标注意力')),
        h(Btn, { small: true, onClick: () => onEdit({ chapter: Number(chapter.id) }) }, '编辑'))
    }

    function AttentionTab({ bundle, projectId, onChanged, onGoTab, onAddCart }) {
      const meta = KIND_META.attention
      const [editing, setEditing] = useState(null)
      const stats = attentionStats(bundle)
      const rows = stats.rows
      const ordered = rows.slice().reverse() // 最新章在前
      const unmarked = stats.unmarked
      const hasChapters = (bundle.chapters ?? []).length > 0
      const emptyCopy = hasChapters
        ? `还没有注意力记录：点上方「＋ 加入清单：AI 补齐注意力机制」，或写下一章方案时让 AI 自动带设计。${unmarked.length > 0 ? ` 当前还有 ${unmarked.length} 章有正文但未标注意力。` : ''}`
        : '还没有注意力记录，也还没有章节：写大纲 / 下一章时会自动生成设计；冷读打分在分工页的独立审稿人卡片。'
      return h('div', { className: 'sd-page' },
        h('div', { className: 'sd-pagehead' },
          h('div', null,
            h('h2', { className: 'sd-h2' }, meta.icon + ' ' + meta.title),
            h('p', { className: 'sd-principle-inline' },
              h('strong', null, PRINCIPLE_SLOGAN),
              h('span', null, PRINCIPLE_REVIEW_HINT)),
            h('p', { className: 'sd-desc' }, meta.desc),
            h('p', { className: 'sd-att-guide' }, '设计（类型 / 四拍 / 读者问题 / 目标分）由注意力设计师产出：写大纲 / 下一章方案时自动带，老作品点「＋ 加入清单：AI 补齐注意力机制」补齐；0–100 实测分由分工页的独立审稿人冷读（清单是唯一 AI 入口）。')),
          h('div', { className: 'sd-pagehead-actions' },
            onAddCart ? h(Btn, { onClick: () => onAddCart(ATTENTION_DESIGN_CART) }, '＋ 加入清单：AI 补齐注意力机制') : null,
            onGoTab ? h(Btn, { onClick: () => onGoTab('agents') }, '去分工页冷读') : null,
            h(Btn, { kind: 'primary', onClick: () => setEditing({}) }, '＋ 新增'))),
        h(AttentionStatsBar, { stats }),
        h(AttentionChart, { rows }),
        rows.length === 0
          ? h(Empty, null, emptyCopy)
          : h('section', { className: 'sd-att-cards' },
              h('h3', { className: 'sd-h3' }, `章节诊断（${rows.length}）· 最新章在前`),
              ordered.map((row) => h(AttentionCard, { key: row.id ?? `att-${row.chapter}`, row, bundle, onEdit: setEditing, onGoTab }))),
        unmarked.length > 0
          ? h('section', { className: 'sd-section sd-mt' },
              h('h3', { className: 'sd-h3' }, `未标注意力的章节（${unmarked.length}）`),
              h('p', { className: 'sd-hint' }, '这些章有正文但还没有 attention 记录：点「编辑」直接新建，章号已预填。'),
              h('div', { className: 'sd-att-unmarked-grid' }, unmarked.slice().reverse().map((chapter) => h(AttentionUnmarkedCard, { key: chapter.id, chapter, onEdit: setEditing }))))
          : null,
        editing !== null ? h(EntityEditor, { kind: 'attention', item: editing, projectId, onClose: () => setEditing(null), onSaved: onChanged }) : null,
      )
    }

    /** 总览页的注意力卡：平均分（大字）+ 最低三章 + 未标章数 + 预警数 + 补齐设计入口。 */
    function AttentionOverviewCard({ bundle, onGoTab, onAddCart }) {
      const stats = attentionStats(bundle)
      const hasAny = stats.rows.length > 0
      return h('section', { className: 'sd-section sd-mt' },
        h('div', { className: 'sd-att-ov-head' },
          h('h3', { className: 'sd-h3 sd-att-ov-title' }, '⚡ 注意力'),
          h('div', { className: 'sd-att-ov-actions' },
            onAddCart ? h(Btn, { small: true, onClick: () => onAddCart(ATTENTION_DESIGN_CART) }, '＋ 加入清单：AI 补齐注意力机制') : null,
            hasAny && onGoTab ? h(Btn, { small: true, onClick: () => onGoTab('attention') }, '查看完整曲线与诊断 ▸') : null)),
        hasAny
          ? h('div', { className: 'sd-att-ov' },
              h('div', { className: 'sd-att-ov-bigwrap' },
                h('div', { className: `sd-att-ov-big${attentionScoreTone(stats.average)}` }, stats.average === null ? '—' : String(stats.average)),
                h('div', { className: 'sd-att-ov-label' }, '全书平均分')),
              h('div', { className: 'sd-att-ov-mini' },
                h('div', { className: 'sd-att-ov-mini-label' }, '最低三章'),
                stats.lowest.length === 0
                  ? h('div', { className: 'sd-hint' }, '还没有实测分')
                  : stats.lowest.map((row) => h('div', { key: row.id ?? `ov-low-${row.chapter}`, className: 'sd-att-ov-row' },
                      h('span', null, `第 ${Number(row.chapter)} 章`),
                      h('span', { className: `sd-att-lowscore${attentionScoreTone(row.score)}` }, `${Number(row.score)} 分`)))),
              h('div', { className: 'sd-att-ov-mini' },
                h('div', { className: 'sd-att-ov-mini-label' }, '未标章数'),
                h('div', { className: 'sd-att-ov-num' }, String(stats.unmarked.length)),
                h('div', { className: 'sd-hint' }, '有正文但没标')),
              h('div', { className: 'sd-att-ov-mini' },
                h('div', { className: 'sd-att-ov-mini-label' }, '疲劳 / 骤降预警'),
                h('div', { className: `sd-att-ov-num${stats.warnings.length > 0 ? ' sd-att-tone-mid' : ''}` }, String(stats.warnings.length)),
                stats.warnings.length > 0
                  ? h('div', { className: 'sd-hint', title: stats.warnings.map((warning) => warning.text).join('\n') }, stats.warnings[0].text)
                  : h('div', { className: 'sd-hint' }, '暂无')))
          : h('p', { className: 'sd-desc' }, '还没有注意力记录：老作品点上方「＋ 加入清单：AI 补齐注意力机制」补齐，写下一章方案时 AI 也会自动带设计；冷读打分在分工页的独立审稿人卡片。有了分数，这里会显示平均分、最低三章、未标章数和疲劳 / 骤降预警。'),
      )
    }

    // ══ v0.4 新增：章节历史版本 ═══════════════════════════════
    function ChapterHistoryDialog({ projectId, chapterId, currentContent, onClose, onRestored }) {
      const [versions, setVersions] = useState(null)
      const [error, setError] = useState('')
      const [selectedFile, setSelectedFile] = useState('')
      const [version, setVersion] = useState(null)
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let alive = true
        setVersions(null)
        setError('')
        setSelectedFile('')
        setVersion(null)
        api('chapter.history', { projectId, chapterId }).then((value) => {
          if (!alive) return
          setVersions(Array.isArray(value) ? value : (value?.versions ?? []))
        }).catch((err) => {
          if (!alive) return
          setVersions([])
          setError(err.message)
          window.alert(`读取历史版本列表失败：${err.message}`)
        })
        return () => { alive = false }
      }, [projectId, chapterId])

      const openVersion = async (file) => {
        setSelectedFile(file)
        setVersion(null)
        try {
          const value = await api('chapter.version', { projectId, chapterId, file })
          setVersion(value && typeof value === 'object' ? value : null)
        } catch (err) {
          window.alert(`读取历史版本失败：${err.message}`)
        }
      }

      const restore = async () => {
        if (!version) return
        if (!window.confirm(`用 ${formatDateTime(version.savedAt) || version.file} 的版本覆盖当前正文？覆盖前会自动备份当前正文。`)) return
        setBusy(true)
        try {
          const value = await api('chapter.restore', { projectId, chapterId, file: selectedFile })
          const chapter = value?.chapter && typeof value.chapter === 'object' ? value.chapter : {}
          if (typeof chapter.content !== 'string' && typeof version.content === 'string') chapter.content = version.content
          window.alert('已恢复所选版本，恢复前的正文已自动备份。')
          onRestored(chapter)
        } catch (err) {
          window.alert(`恢复失败：${err.message}`)
        } finally {
          setBusy(false)
        }
      }

      const diff = React.useMemo(() => (version ? diffLines(currentContent ?? '', stripChapterFrontmatter(version.content)) : []), [version, currentContent])
      const changed = diff.filter((line) => line.type !== 'same').length

      return h(
        'div',
        { className: 'sd-modal-mask', onClick: (e) => e.target === e.currentTarget && onClose() },
        h(
          'div',
          { className: 'sd-modal sd-modal-wide' },
          h('div', { className: 'sd-modal-head' },
            h('strong', null, `历史版本 · 第 ${chapterId} 章`),
            h('span', { className: 'sd-hint' }, versions ? `${versions.length} 个备份` : '读取中…'),
            h(IconBtn, { onClick: onClose, title: '关闭' }, '✕')),
          h(
            'div',
            { className: 'sd-modal-body' },
            error ? h('div', { className: 'sd-error sd-error-inline' }, `读取历史失败：${error}`) : null,
            versions === null
              ? h('p', { className: 'sd-hint' }, '读取中…')
              : versions.length === 0 && !error
                ? h(Empty, null, '还没有历史版本。往后再保存已有章节且正文有变化时，旧正文会自动备份到 .backups/。')
                : h('div', { className: 'sd-history' },
                    h('div', { className: 'sd-history-list' }, versions.map((item) => h('button', {
                      key: item.file,
                      type: 'button',
                      className: `sd-history-item${selectedFile === item.file ? ' sd-history-item-active' : ''}`,
                      onClick: () => openVersion(item.file),
                    },
                      h('div', null, formatDateTime(item.savedAt) || item.file),
                      h('div', { className: 'sd-hint' }, `${item.bytes ?? '?'} 字节`)),
                    )),
                    h('div', { className: 'sd-history-diff' },
                      version
                        ? h('div', null,
                            h('div', { className: 'sd-hint' }, `${formatDateTime(version.savedAt) || version.file} ｜ 与当前正文对比：${changed} 行不同`),
                            h('div', { className: 'sd-diff' }, diff.slice(0, 220).map((line, index) => h('div', { key: index, className: `sd-diff-${line.type}` }, `${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '} ${line.text}`))),
                          )
                        : h('p', { className: 'sd-hint' }, '点左侧某个版本查看 diff。'),
                    ),
                  ),
          ),
          h('div', { className: 'sd-modal-foot' },
            h(Btn, { onClick: onClose }, '关闭'),
            h(Btn, { kind: 'primary', onClick: restore, disabled: !version || busy }, busy ? '恢复中…' : '恢复此版本')),
        ),
      )
    }

    // ══ v0.4 新增：导入 Markdown ══════════════════════════════
    function PathPickerDialog({ initialPath, onPick, onClose }) {
      const [path, setPath] = useState(initialPath || '')
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const load = useCallback(async (target) => {
        setBusy(true)
        try {
          const value = await api('import.browse', { path: target })
          setData(value)
          setPath(value.path)
          setError('')
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }, [])
      useEffect(() => { load(initialPath) }, [initialPath, load])
      return h('div', { className: 'sd-modal-mask', onClick: (e) => e.target === e.currentTarget && onClose() },
        h('div', { className: 'sd-modal sd-modal-wide' },
          h('div', { className: 'sd-modal-head' },
            h('strong', null, '📁 选择文件或目录'),
            h('span', { className: 'sd-hint' }, '支持 .md .txt .epub .pdf .mobi'),
            h(IconBtn, { onClick: onClose, title: '关闭' }, '✕')),
          h('div', { className: 'sd-modal-body' },
            h('div', { className: 'sd-inline-row' },
              h(TextInput, { value: path, onChange: setPath }),
              h(Btn, { onClick: () => load(path), disabled: busy }, busy ? '读取中…' : '转到'),
              h(Btn, { onClick: () => data && load(data.parent), disabled: !data?.parent }, '上一级')),
            error ? h('div', { className: 'sd-error sd-error-inline' }, error) : null,
            h('div', { className: 'sd-picker-list' },
              (data?.entries ?? []).map((entry) => h('button', {
                key: entry.path,
                type: 'button',
                className: `sd-picker-row${entry.dir ? ' sd-picker-dir' : ''}`,
                onClick: () => (entry.dir ? load(entry.path) : onPick(entry.path)),
              }, h('span', { className: 'sd-picker-icon' }, entry.dir ? '📁' : '📄'), h('span', { className: 'sd-picker-name' }, entry.name)))),
            (data?.entries ?? []).length === 0 && !busy ? h('p', { className: 'sd-hint' }, '这个目录里没有可导入的文件。') : null,
          ),
          h('div', { className: 'sd-modal-foot' },
            h(Btn, { onClick: onClose }, '取消'),
            h(Btn, { kind: 'primary', disabled: !data?.path, onClick: () => onPick(data.path) }, '用这个目录'))),
      )
    }

    function CartDialog({ items, projectId, workspacePath = '', sending, onRemove, onNote, onClose, onSend, defaultTarget = 'current' }) {
      const [allowContinue, setAllowContinue] = useState(false)
      const [target, setTarget] = useState('')
      const [targets, setTargets] = useState([])
      const [currentSession, setCurrentSession] = useState('')
      const [multiAgent, setMultiAgent] = useState(true)
      const [preview, setPreview] = useState('')
      const [busy, setBusy] = useState(false)
      // 清单里全是审稿项时，可整批「生成修订提案」（逐条出 chapter 提案，不直改正文）
      const [reviewMode, setReviewMode] = useState('proposals')
      const reviewOnly = items.length > 0 && items.every((item) => item.kind === 'review' && item.id)
      const toProposals = reviewOnly && reviewMode === 'proposals'
      const isNewTarget = !target || target === '__new__'
      const buildPayload = () => ({
        projectId,
        ...(toProposals ? { task: 'review-to-proposals', items } : { items, allowContinue, multiAgent }),
        ...(isNewTarget ? { newSession: true } : { sessionId: target }),
      })
      const targetLabel = (session) => sessionTitleOf(session?.sessionId, session?.title) || (session?.sessionId ? `会话 ${session.sessionId.slice(0, 8)}` : '')
      const chosenTarget = targets.find((session) => session.sessionId === target)
      const chosenLabel = chosenTarget ? targetLabel(chosenTarget) : ''
      useEffect(() => {
        let alive = true
        api('chat.sessions').then((value) => {
          if (!alive) return
          const rows = (value?.items ?? [])
            .filter((item) => !item.blank && !item.parentSessionId && !item.origin && (!workspacePath || item.cwd === workspacePath))
            .sort((a, b) => (Date.parse(b.updatedAt ?? 0) || 0) - (Date.parse(a.updatedAt ?? 0) || 0))
          const ids = new Set(rows.map((row) => row.sessionId))
          const main = currentMainSessionId()
          const saved = window.localStorage.getItem(`sd.cartSession.${projectId}`) || ''
          const preferred = (main && ids.has(main) && main) || (saved && ids.has(saved) && saved) || rows[0]?.sessionId || ''
          setTargets(rows)
          setCurrentSession(main && ids.has(main) ? main : '')
          setTarget((prev) => prev || (defaultTarget === 'new' ? '__new__' : preferred || '__new__'))
        }).catch(() => {
          if (alive) setTarget((prev) => prev || '__new__')
        })
        return () => { alive = false }
      }, [projectId, workspacePath])
      const showPreview = async () => {
        setBusy(true)
        try {
          const value = await api('chat.send', { ...buildPayload(), dryRun: true })
          setPreview(value.prompt)
        } catch (error) {
          window.alert(`生成预览失败：${error.message}`)
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'sd-modal-mask', onClick: (e) => e.target === e.currentTarget && !sending && onClose() },
        h('div', { className: 'sd-modal sd-modal-wide' },
          h('div', { className: 'sd-modal-head' },
            h('strong', null, `🧺 本次处理清单（${items.length}）`),
            h('span', { className: 'sd-hint' }, '勾进来的问题会一次性发到左侧对话，由 Agent 逐项处理并写回提案/审稿'),
            h(IconBtn, { onClick: () => !sending && onClose(), title: '关闭' }, '✕')),
          h('div', { className: 'sd-modal-body' },
            items.length === 0
              ? h(Empty, null, '清单是空的。去审稿/提案/总览检查里点「加入清单」。')
              : h('div', { className: 'sd-cart-list' },
                  items.map((item) => h('div', { key: `${item.kind}:${item.id}`, className: 'sd-cart-row' },
                    h('div', { className: 'sd-cart-item' },
                      h(Tag, { tone: 'brand' }, { review: '审稿', proposal: '提案', check: '检查', chapter: '章节', task: '任务' }[item.kind] ?? item.kind),
                      item.approved ? h(Tag, { tone: 'muted' }, '已同意') : null,
                      h('span', { className: 'sd-cart-title' }, `${item.chapter ? `第${item.chapter}章 · ` : ''}${item.title || item.detail || item.id}`),
                      h(Btn, { small: true, onClick: () => onRemove(item), disabled: sending }, '移除')),
                    h(TextArea, { value: item.note ?? '', rows: 2, placeholder: '清单补充（可选；会随清单发给 AI，和提案卡上的作者意见分开）…', onChange: (value) => onNote(item, value) })))),
            h('div', { className: 'sd-send-options' },
              h('label', { className: 'sd-target-row' }, h('span', { className: 'sd-hint' }, '发送到'),
                h('select', { className: 'sd-input sd-select-inline sd-target-select', value: target || '__new__', onChange: (e) => setTarget(e.target.value) },
                  targets.map((session) => h('option', { key: session.sessionId, value: session.sessionId },
                    `${session.sessionId === currentSession ? '🌀 当前 · ' : ''}${targetLabel(session)} · ${relativeTime(session.updatedAt)}${session.running ? ' · 运行中' : ''}`)),
                  h('option', { value: '__new__' }, '＋ 在本工作区新开对话'))),
              h('p', { className: 'sd-hint' }, isNewTarget ? '会新开一个对话并在里面执行，不影响你正在用的对话。' : `会发到你选中的「${chosenLabel || '会话'}」，不会改到别的对话。`),
              reviewOnly ? h('div', null,
                h('label', { className: 'sd-cb' }, h('input', { type: 'radio', name: 'review-mode', checked: reviewMode === 'proposals', onChange: () => setReviewMode('proposals') }), '这批审稿项：批量生成修订提案（逐条出一个 chapter 提案，正文不直接改）'),
                h('label', { className: 'sd-cb' }, h('input', { type: 'radio', name: 'review-mode', checked: reviewMode === 'generic', onChange: () => setReviewMode('generic') }), '按普通清单处理（交对话逐项处理）')) : null,
              toProposals ? h('span', { className: 'sd-hint' }, '提案会进「提案」页等你验收；这条链路不做多 Agent 派单。') : h('div', null,
                h('label', { className: 'sd-cb' }, h('input', { type: 'checkbox', checked: allowContinue, onChange: (e) => setAllowContinue(e.target.checked) }), '允许 AI 连续执行下一步（明确的小步不用每步都问）'),
                h('label', { className: 'sd-cb' }, h('input', { type: 'checkbox', checked: multiAgent, onChange: (e) => setMultiAgent(e.target.checked) }), '按分工派子 Agent（总编拆单 / 多角色执行）'))),
            h('div', { className: 'sd-form-actions' },
              h(Btn, { onClick: showPreview, disabled: busy || items.length === 0 }, busy ? '生成中…' : '预览发过去的 Prompt')),
            preview ? h('pre', { className: 'sd-ai-result' }, preview) : null,
          ),
          h('div', { className: 'sd-modal-foot' },
            h(Btn, { onClick: () => !sending && onClose() }, '取消'),
            h(Btn, { kind: 'primary', onClick: () => onSend(allowContinue, target, multiAgent, reviewOnly ? reviewMode : 'generic'), disabled: sending || items.length === 0 }, sending ? '发送中…' : (isNewTarget ? `新开对话并发送 ${items.length} 项` : `发送 ${items.length} 项到「${chosenLabel || '会话'}」`)))),
      )
    }

    function ImportDialog({ onClose, onImported, onGo, onAddCart, onOpenCart }) {
      const [path, setPath] = useState('')
      const [split, setSplit] = useState('auto')
      const [scan, setScan] = useState(null)
      const [name, setName] = useState('')
      const [workspaceTitle, setWorkspaceTitle] = useState('')
      const [genre, setGenre] = useState('')
      const [autoReview, setAutoReview] = useState(true)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [report, setReport] = useState(null)
      const [reviewing, setReviewing] = useState(false)
      const [review, setReview] = useState(null)
      const [picking, setPicking] = useState(false)

      const doScan = async () => {
        const dir = path.trim()
        if (!dir) {
          window.alert('请填写本机作品目录或 .md 文件路径')
          return
        }
        setBusy('scan')
        setError('')
        try {
          const value = await api('import.scan', { path: dir, split })
          setScan(value)
          if (!name.trim() && value.bookTitle) setName(value.bookTitle)
        } catch (err) {
          setScan(null)
          setError(err.message)
          window.alert(`扫描失败：${err.message}`)
        } finally {
          setBusy('')
        }
      }

      const doImport = async () => {
        if (!scan) {
          window.alert('请先点「扫描预览」')
          return
        }
        if (!name.trim()) {
          window.alert('请填写作品名')
          return
        }
        const c = scan.counts ?? {}
        if (!window.confirm(`导入《${name.trim()}》？\n工作区：${workspaceTitle.trim() || name.trim()}\n章节 ${c.chapters ?? 0} ｜ 人物 ${c.characters ?? 0} ｜ 大纲 ${c.outlines ?? 0} ｜ 事件 ${c.events ?? 0} ｜ 事实 ${c.facts ?? 0} ｜ 伏笔 ${c.foreshadow ?? 0} ｜ 预设 ${c.presets ?? 0}`)) return
        setBusy('run')
        try {
          const value = await api('import.run', { path: path.trim(), projectName: name.trim(), workspaceTitle: workspaceTitle.trim(), genre: genre.trim(), mode: 'new', split })
          if (!value?.projectId) throw new Error('导入没有返回作品 id')
          onImported(value.projectId)
          if (autoReview) {
            await sendToChat({ projectId: value.projectId, task: 'import-review', newSession: true })
            return
          }
          setReport(value)
        } catch (err) {
          window.alert(`导入失败：${err.message}`)
        } finally {
          setBusy('')
        }
      }

      const startReview = async () => {
        if (!report) return
        setReviewing(true)
        try {
          await sendToChat({ projectId: report.projectId, task: 'import-review' })
        } catch (err) {
          window.alert(`发送到对话失败：${err.message}`)
        } finally {
          setReviewing(false)
        }
      }

      const counts = report?.counts ?? {}
      const scanCounts = scan?.counts ?? {}

      const reportBody = report ? h('div', { className: 'sd-import-report' },
        h('div', { className: 'sd-import-counts' },
          [['章节', counts.chapters], ['人物', counts.characters], ['大纲', counts.outlines], ['事件', counts.events], ['事实', counts.facts], ['伏笔', counts.foreshadow], ['预设', counts.presets], ['冲突', counts.conflicts]]
            .map(([label, value]) => h('div', { key: label, className: 'sd-import-count' }, h('strong', null, String(value ?? 0)), h('span', null, label)))),
        h('p', { className: 'sd-desc' }, report.detected?.characters && report.detected?.outlines
          ? '已从作品包里识别并导入人物卡、大纲、追踪与写作规范。'
          : '没有找到完整的人物卡/大纲/追踪文件，AI 可以按正文补全。'),
        report.workspacePath ? h('div', { className: 'sd-hint' }, `独立工作区：${report.workspacePath}（首次使用请点「新开对话」）`) : null,
        review
          ? h('div', { className: 'sd-import-review' },
              h('h3', { className: 'sd-h3' }, '审阅完成'),
              h('div', { className: 'sd-check sd-check-info' }, `已生成 ${review.proposalIds?.length ?? 0} 个补全提案，写入 ${review.reviews ?? 0} 条冲突审稿意见。`),
              h('p', { className: 'sd-desc' }, '补全内容在「提案」页，冲突在「审稿」页；采纳/处理前不会改动正文和账本。'),
              h('div', { className: 'sd-form-actions' },
                h(Btn, { kind: 'primary', onClick: () => onGo('proposals') }, '去提案页'),
                h(Btn, { onClick: () => onGo('reviews') }, '去审稿页'),
                h(Btn, { onClick: onClose }, '完成')))
          : h('div', { className: 'sd-import-review' },
              h('p', { className: 'sd-desc' }, '「开始审阅」会做两件事：① 找齐/补齐人物卡、时间线、大纲；② 核查正文与设定、追踪、大纲之间的冲突。结果只进提案与审稿，不会直接改正文。'),
              h('div', { className: 'sd-form-actions' },
                h(Btn, { kind: 'primary', onClick: startReview, disabled: reviewing }, reviewing ? '发送中…' : '开始审阅（发送到对话）'),
                h(Btn, { onClick: onClose, disabled: reviewing }, '暂不审阅，先看看'))),
      ) : null

      const formBody = !report ? h('div', null,
        h(Field, { label: '本机路径 *', hint: '作品根目录，或整本书文件（.md/.txt/.epub/.pdf/.mobi）' },
          h('div', { className: 'sd-inline-row' },
            h(TextInput, { value: path, placeholder: '/Users/you/Documents/我的小说 或 /书/全本.epub', onChange: setPath }),
            h(Btn, { onClick: () => setPicking(true) }, '浏览…'),
            h(Btn, { onClick: doScan, disabled: busy === 'scan' }, busy === 'scan' ? '扫描中…' : '扫描预览'))),
        h(Field, { label: '切章方式', hint: '默认：一个文件一章；整本书单文件含多个 # 标题时自动按 # 切' },
          h(Select, { value: split, options: [
            { value: 'auto', label: '自动（推荐）' },
            { value: 'file', label: '一个文件一章' },
            { value: 'h1', label: '按一级标题 # 切章' },
          ], onChange: setSplit })),
        error ? h('div', { className: 'sd-error sd-error-inline' }, `扫描失败：${error}`) : null,
        scan ? h('div', { className: 'sd-import-preview' },
          h('div', null, h('strong', null, '识别结果：'),
            `章节 ${scanCounts.chapters ?? 0} ｜ 人物 ${scanCounts.characters ?? 0} ｜ 大纲 ${scanCounts.outlines ?? 0} ｜ 事件 ${scanCounts.events ?? 0} ｜ 事实 ${scanCounts.facts ?? 0} ｜ 伏笔 ${scanCounts.foreshadow ?? 0} ｜ 预设 ${scanCounts.presets ?? 0}`),
          h('div', { className: 'sd-hint' }, `根目录：${scan.root || scan.path}`),
          !scan.detected?.characters ? h('div', { className: 'sd-hint' }, '⚠ 没找到人物卡目录（wiki/entities、人物/、characters/），导入后可用 AI 补全') : null,
          !scan.detected?.outlines ? h('div', { className: 'sd-hint' }, '⚠ 没找到大纲文件（大纲.md、wiki/raw/大纲.md），导入后可用 AI 补全') : null,
          (scan.chapters ?? []).slice(0, 12).map((chapter, index) => h('div', { key: index, className: 'sd-import-chapter' },
            `第 ${chapter.index ?? index + 1} 章 · ${chapter.title || '（无标题）'}${chapter.words ? ` · ${chapter.words} 字` : ''}`)),
          (scanCounts.chapters ?? 0) > 12 ? h('div', { className: 'sd-hint' }, `… 另有 ${scanCounts.chapters - 12} 章`) : null,
          (scan.characters ?? []).length > 0 ? h('div', { className: 'sd-hint' }, `人物：${scan.characters.slice(0, 8).map((c) => c.name).join('、')}${scan.characters.length > 8 ? '…' : ''}`) : null,
          (scan.outlines ?? []).length > 0 ? h('div', { className: 'sd-hint' }, `大纲：第 ${scan.outlines[0].chapter}–${scan.outlines[scan.outlines.length - 1].chapter} 章，共 ${scan.outlines.length} 条`) : null,
        ) : null,
        h('div', { className: 'sd-form sd-form-2' },
          h(Field, { label: '作品名 *' }, h(TextInput, { value: name, placeholder: '导入后的作品名', onChange: setName })),
          h(Field, { label: '工作区名称（可选）', hint: '默认同作品名；会建在 DSH 默认工作区下' }, h(TextInput, { value: workspaceTitle, placeholder: '默认同作品名', onChange: setWorkspaceTitle })),
          h(Field, { label: '类型（可选）' }, h(TextInput, { value: genre, placeholder: '武侠 / 科幻 / 悬疑…', onChange: setGenre }))),
        h('label', { className: 'sd-cb' }, h('input', { type: 'checkbox', checked: autoReview, onChange: (e) => setAutoReview(e.target.checked) }), '导入完成后立即在新工作区开始审阅'),
      ) : null

      if (picking) return h(PathPickerDialog, {
        initialPath: path.trim(),
        onClose: () => setPicking(false),
        onPick: (selected) => { setPath(selected); setPicking(false); setScan(null) },
      })

      return h(
        'div',
        { className: 'sd-modal-mask', onClick: (e) => e.target === e.currentTarget && busy !== 'run' && !reviewing && onClose() },
        h('div', { className: 'sd-modal sd-modal-wide' },
          h('div', { className: 'sd-modal-head' },
            h('strong', null, report ? '✅ 导入完成' : '⬆ 导入作品 / 作品包'),
            h('span', { className: 'sd-hint' }, report ? '检查导入结果，然后开始 AI 审阅' : '支持目录或整本书：md / txt / epub / pdf / mobi'),
            h(IconBtn, { onClick: () => busy !== 'run' && !reviewing && onClose(), title: '关闭' }, '✕')),
          h('div', { className: 'sd-modal-body' }, report ? reportBody : formBody),
          h('div', { className: 'sd-modal-foot' },
            report
              ? h(Btn, { onClick: onClose }, review ? '完成' : '稍后处理')
              : [h(Btn, { key: 'cancel', onClick: () => busy !== 'run' && onClose() }, '取消'),
                 h(Btn, { key: 'run', kind: 'primary', onClick: doImport, disabled: busy === 'run' || !scan }, busy === 'run' ? '导入中…' : (autoReview ? '导入并开始审阅' : '导入并查看报告'))]),
        ),
      )
    }

    // ── 工作台主壳 ────────────────────────────────────────────
    /** 合并清单条目：去重（kind+id），支持一次传多条；纯函数，便于测试。 */
    function mergeCartItems(prev, items) {
      const next = Array.isArray(prev) ? [...prev] : []
      for (const row of Array.isArray(items) ? items : [items]) {
        if (!row?.id) continue
        if (!next.some((existing) => existing.kind === row.kind && existing.id === row.id)) next.push(row)
      }
      return next
    }

    function Workbench() {
      const open = useOpen()
      const [tab, setTab] = useState('overview')
      const [library, setLibrary] = useState(null)
      const [projectId, setProjectId] = useState(() => window.localStorage.getItem('story-desk/project') || '')
      const [bundle, setBundle] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [creating, setCreating] = useState(false)
      const [importing, setImporting] = useState(false)
      const [ai, setAi] = useState(null)
      const [cart, setCart] = useState([])
      const [cartOpen, setCartOpen] = useState(false)
      const [sendingCart, setSendingCart] = useState(false)
      const [focusLocation, setFocusLocation] = useState(null)
      const [pipelineWizard, setPipelineWizard] = useState(null)
      const [expansionIntent, setExpansionIntent] = useState(null)
      const cartKey = projectId ? `story-desk/cart/${projectId}` : ''
      const saveCart = (next) => setCart(next)
      // 支持一次加入多条（审阅页全选批量加入）：用函数式更新合并，避免同一轮多次调用互相覆盖。
      const addCart = (item) => {
        const items = (Array.isArray(item) ? item : [item]).filter((row) => row?.id)
        if (items.length === 0) return
        setCart((prev) => mergeCartItems(prev, items))
      }
      const removeCart = (item) => saveCart(cart.filter((row) => !(row.kind === item.kind && row.id === item.id)))
      const noteCart = (item, note) => saveCart(cart.map((row) => (row.kind === item.kind && row.id === item.id ? { ...row, note } : row)))
      // 章节页 → 整本书「扩写」子页：带 token 的意图，重复点同一章也能重新预填。
      const expandChapter = (chapterNumber) => {
        setExpansionIntent({ mode: 'chapter', chapter: Number(chapterNumber) || 0, token: Date.now() })
        setTab('pipeline')
      }
      // 章节地图 → 世界页联动：切页 + 带 token 的 focusLocation，重复点同一地点也能重新高亮。
      const focusWorldLocation = (name) => {
        setFocusLocation({ name: String(name ?? ''), token: Date.now() })
        setTab('world')
      }
      const sendCart = async (allowContinue, target = '__new__', multiAgent = true, reviewMode = 'generic') => {
        if (cart.length === 0) return
        const reviewOnly = cart.every((item) => item.kind === 'review' && item.id)
        const toProposals = reviewOnly && reviewMode === 'proposals'
        const isNewTarget = !target || target === '__new__'
        const targetPayload = isNewTarget ? { newSession: true } : { sessionId: target }
        setSendingCart(true)
        try {
          await sendToChat(toProposals
            ? { projectId, task: 'review-to-proposals', items: cart, ...targetPayload }
            : { projectId, items: cart, allowContinue, multiAgent, ...targetPayload })
          if (!isNewTarget) window.localStorage.setItem(`sd.cartSession.${projectId}`, target)
          saveCart([])
          setCartOpen(false)
        } catch (error) {
          window.alert(`发送到对话失败：${error.message}`)
        } finally {
          setSendingCart(false)
        }
      }
      const [exportFormat, setExportFormat] = useState('md')
      const [exporting, setExporting] = useState(false)

      const [cartLoadedKey, setCartLoadedKey] = useState('')
      useEffect(() => {
        setCartLoadedKey('')
        if (!cartKey) {
          setCart([])
          return
        }
        try {
          const raw = window.localStorage.getItem(cartKey)
          setCart(raw ? JSON.parse(raw) : [])
        } catch {
          setCart([])
        }
        setCartLoadedKey(cartKey)
      }, [cartKey])
      useEffect(() => {
        if (!cartKey || cartLoadedKey !== cartKey) return
        try {
          window.localStorage.setItem(cartKey, JSON.stringify(cart))
        } catch {
          /* ignore */
        }
      }, [cart, cartKey, cartLoadedKey])

      const refresh = useCallback(async (preferred) => {
        setBusy(true)
        try {
          const lib = await api('library')
          setLibrary(lib)
          const wanted = preferred ?? projectId
          const nextId = lib.projects.some((p) => p.id === wanted) ? wanted : lib.projects[0]?.id ?? ''
          if (nextId !== projectId) setProjectId(nextId)
          if (nextId) {
            const data = await api('bundle', { projectId: nextId })
            setBundle(data)
            window.localStorage.setItem('story-desk/project', nextId)
          } else {
            setBundle(null)
          }
          setError('')
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }, [projectId])

      useEffect(() => {
        if (open) refresh()
      }, [open])

      useEffect(() => {
        if (!open) return
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      if (!open) return null

      const changeProject = (id) => {
        setProjectId(id)
        refresh(id)
      }

      const doExport = async () => {
        if (!projectId) return
        setExporting(true)
        try {
          await downloadExport(projectId, exportFormat)
        } catch (error) {
          window.alert(`导出失败：${error.message}`)
        } finally {
          setExporting(false)
        }
      }

      return h(
        'div',
        { className: 'sd-backdrop', onClick: (e) => e.target === e.currentTarget && setOpen(false) },
        h('div', { className: 'sd-panel' },
          h('header', { className: 'sd-head' },
            h('div', { className: 'sd-brand' }, h('span', { className: 'sd-brand-icon' }, '📖'), h('span', null, '长篇中文小说工作台')),
            library && library.projects.length > 0
              ? h('select', { className: 'sd-input sd-project-select', value: projectId, onChange: (e) => changeProject(e.target.value) }, library.projects.map((p) => h('option', { key: p.id, value: p.id }, p.name)))
              : null,
            h('div', { className: 'sd-head-actions' },
              busy ? h('span', { className: 'sd-hint' }, '同步中…') : null,
              h(Btn, { small: true, onClick: () => setImporting(true) }, '⬆ 导入 Markdown'),
              h(Btn, { kind: 'primary', disabled: !bundle, title: '把提案/审稿/检查加进清单，统一发送到对话', onClick: () => setCartOpen(true) }, `🧺 清单${cart.length ? ` (${cart.length})` : ''}`),
              bundle
                ? h('select', { className: 'sd-input sd-export-select', value: exportFormat, title: '导出格式', onChange: (e) => setExportFormat(e.target.value) },
                    h('option', { value: 'md' }, 'Markdown'),
                    h('option', { value: 'epub' }, 'EPUB'),
                    h('option', { value: 'docx' }, 'DOCX'))
                : null,
              h(Btn, { small: true, disabled: !bundle || exporting, onClick: doExport }, exporting ? '导出中…' : '⬇ 导出'),
              h(Btn, { onClick: () => setCreating(true) }, '＋ 新建作品'),
              h(Btn, { onClick: () => refresh() }, '刷新'),
              h(IconBtn, { onClick: () => setOpen(false), title: '关闭（Esc）' }, '✕'),
            ),
          ),
          error ? h('div', { className: 'sd-error' }, error) : null,
          !bundle
            ? h('div', { className: 'sd-welcome' },
                h('h2', null, '还没有作品'),
                h('p', null, '工作台把作品数据存成普通文件（Markdown + JSON），可直接备份、进 Git。也可以把已有的 Markdown 小说目录导入成新作品。'),
                h('div', { className: 'sd-form-actions' },
                  h(Btn, { kind: 'primary', onClick: () => setCreating(true) }, '创建第一部作品'),
                  h(Btn, { onClick: () => setImporting(true) }, '⬆ 导入 Markdown'),
                ),
              )
            : h(React.Fragment, null,
                h('div', { className: 'sd-principle-bar' },
                  h('div', { className: 'sd-principle-main' },
                    h('span', { className: 'sd-principle-slogan' }, PRINCIPLE_SLOGAN),
                    h('span', { className: 'sd-principle-sub' }, PRINCIPLE_SUB)),
                  h('span', { className: 'sd-principle-hint' }, PRINCIPLE_HINT)),
                h('div', { className: 'sd-body' },
                h(Nav, { tab, onPick: setTab }),
                h('main', { className: 'sd-main' },
                  tab === 'overview' ? h(OverviewTab, { bundle, projectId, onChanged: () => refresh(projectId), onAddCart: addCart, cartCount: cart.length, onOpenCart: () => setCartOpen(true), onGoTab: setTab }) : null,
                  tab === 'attention' ? h(AttentionTab, { bundle, projectId, onChanged: () => refresh(projectId), onGoTab: setTab, onAddCart: addCart }) : null,
                  tab === 'dashboard' ? h(DashboardTab, { bundle, projectId }) : null,
                  tab === 'pipeline' ? h(PipelineTab, { bundle, projectId, onChanged: () => refresh(projectId), onGoTab: setTab, onOpenWizard: () => setPipelineWizard({}), expansionIntent, onExpansionConsumed: () => setExpansionIntent(null) }) : null,
                  tab === 'chapters' ? h(ChaptersTab, { bundle, projectId, onChanged: () => refresh(projectId), onExpandChapter: expandChapter }) : null,
                  tab === 'map' ? h(ChapterMapTab, { bundle, projectId, onGoTab: setTab, onFocusLocation: focusWorldLocation }) : null,
                  tab === 'world' ? h(WorldTab, { bundle, projectId, onChanged: () => refresh(projectId), onAddCart: addCart, focusLocation }) : null,
                  tab === 'timeline' ? h(TimelineTab, { bundle, projectId, onChanged: () => refresh(projectId), onGoTab: setTab }) : null,
                  ['facts', 'foreshadow', 'conflicts', 'characters', 'highlights', 'agents'].includes(tab)
                    ? h(EntityTab, { key: tab, kind: tab, bundle, projectId, onChanged: () => refresh(projectId), onAddCart: addCart })
                    : null,
                  tab === 'reviews' ? h(ReviewsTab, { bundle, projectId, onChanged: () => refresh(projectId), onAddCart: addCart }) : null,
                  tab === 'presets' ? h(PresetsTab, { bundle, projectId, onChanged: () => refresh(projectId) }) : null,
                  tab === 'proposals' ? h(ProposalTab, { bundle, projectId, onChanged: () => refresh(projectId), onAddCart: addCart, onGoTab: setTab, onAskAi: (task) => setAi({ task, chapter: bundle.chapters.length > 0 ? Math.max(...bundle.chapters.map((c) => Number(c.id) || 0)) + 1 : 1 }) }) : null,
                  tab === 'alignment' ? h(AlignmentTab, { bundle, projectId, onChanged: () => refresh(projectId), onAskAi: (task) => setAi({ task, chapter: bundle.chapters.length > 0 ? Math.max(...bundle.chapters.map((c) => Number(c.id) || 0)) + 1 : 1 }) }) : null,
                  tab === 'settings' ? h(SettingsTab, { bundle, projectId, onChanged: () => refresh(projectId), onProjectDeleted: () => { setProjectId(''); refresh('') } }) : null,
                ),
              ),
              ),
          creating ? h(CreateProjectDialog, {
            onClose: () => setCreating(false),
            onCreated: (id, options) => {
              setTab(options?.openPipeline ? 'pipeline' : 'overview')
              refresh(id)
              if (options?.openPipeline) setPipelineWizard({ prefill: options.prefill ?? null, projectId: id })
            },
          }) : null,
          pipelineWizard && (!pipelineWizard.projectId || String(bundle?.project?.id ?? '') === String(pipelineWizard.projectId))
            ? h(PipelineWizard, {
                bundle,
                projectId,
                prefill: pipelineWizard.prefill ?? null,
                onClose: () => setPipelineWizard(null),
                onFinished: () => { setPipelineWizard(null); refresh(projectId) },
              })
            : null,
          cartOpen ? h(CartDialog, { items: cart, projectId, workspacePath: bundle?.project?.workspacePath || '', sending: sendingCart, onRemove: removeCart, onNote: noteCart, defaultTarget: 'current', onClose: () => setCartOpen(false), onSend: sendCart }) : null,
          importing ? h(ImportDialog, { onClose: () => setImporting(false), onGo: (nextTab) => { setImporting(false); if (nextTab) setTab(nextTab) }, onImported: (id) => { setTab('overview'); changeProject(id) }, onAddCart: addCart, onOpenCart: () => setCartOpen(true) }) : null,
        ),
      )
    }

    // ── 侧栏入口 ──────────────────────────────────────────────
    function SidebarEntry({ wide }) {
      return h(
        'button',
        { type: 'button', className: 'sd-entry', title: '长篇中文小说工作台', onClick: () => setOpen(true) },
        h('span', { className: 'sd-entry-icon' }, '📖'),
        wide ? h('span', { className: 'sd-entry-label' }, '长篇中文小说工作台') : null,
      )
    }

    // ── 样式 ──────────────────────────────────────────────────
    const CSS = `
.sd-entry{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#555);border-radius:8px;cursor:pointer;font:inherit;font-size:12px}
.sd-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}
.sd-entry-icon{font-size:16px;line-height:1}
.sd-entry-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-backdrop{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;background:rgba(15,20,30,.45);pointer-events:auto}
.sd-panel{width:min(1280px,96vw);height:min(900px,92vh);display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.4);font-size:13px}
.sd-head{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#e5e5e5);flex:0 0 auto}
.sd-brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px;white-space:nowrap}
.sd-brand-icon{font-size:18px}
.sd-project-select{width:auto;min-width:160px;max-width:260px}
.sd-head-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.sd-body{display:flex;flex:1;min-height:0}
.sd-nav{width:168px;flex:0 0 auto;display:flex;flex-direction:column;gap:2px;padding:10px 8px;border-right:1px solid var(--dsw-alias-border-l2,#e5e5e5);background:var(--dsw-alias-bg-layer-1,#fafafa);overflow-y:auto}
.sd-nav-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#555);border-radius:8px;cursor:pointer;font:inherit;font-size:12.5px;text-align:left}
.sd-nav-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#111)}
.sd-nav-active{background:var(--dsw-alias-interactive-bg-selected,rgba(36,123,191,.12));color:var(--dsw-alias-brand-primary,#247bbf);font-weight:600}
.sd-nav-icon{font-size:14px;line-height:1}
.sd-main{flex:1;min-width:0;overflow-y:auto;padding:20px 24px 40px}
.sd-page{display:flex;flex-direction:column;gap:14px}
.sd-pagehead{display:flex;align-items:flex-start;gap:16px}
.sd-pagehead > div{flex:1;min-width:0}
.sd-h2{margin:0 0 4px;font-size:18px;font-weight:600}
.sd-h3{margin:4px 0 8px;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#222)}
.sd-mt{margin-top:18px}
.sd-desc{margin:0;color:var(--dsw-alias-label-secondary,#666);font-size:12px;line-height:1.6}
.sd-hint{color:var(--dsw-alias-label-tertiary,#888);font-size:11px;font-weight:400}
.sd-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#d8d8d8);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#222);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.sd-btn:hover{border-color:var(--dsw-alias-brand-primary,#247bbf);color:var(--dsw-alias-brand-primary,#247bbf)}
.sd-btn:disabled{opacity:.5;cursor:default}
.sd-btn-primary{background:var(--dsw-alias-button-primary-fill,#247bbf);border-color:transparent;color:#fff}
.sd-btn-primary:hover{color:#fff;opacity:.9}
.sd-btn-danger{color:var(--dsw-alias-state-error-primary,#c0392b);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 35%,transparent)}
.sd-btn-sm{padding:3px 8px;font-size:11px;border-radius:6px}
.sd-iconbtn{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#666);border-radius:6px;cursor:pointer;font-size:14px}
.sd-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}
.sd-input{width:100%;box-sizing:border-box;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2,#d5d5d5);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#222);font:inherit;font-size:12.5px;outline:none}
.sd-input:focus{border-color:var(--dsw-alias-brand-primary,#247bbf)}
.sd-textarea{resize:vertical;line-height:1.7;font-family:inherit}
.sd-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.sd-label{font-size:12px;color:var(--dsw-alias-label-secondary,#555);font-weight:500}
.sd-form-2{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
.sd-form-actions{display:flex;gap:8px;margin-top:8px}
.sd-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px}
.sd-card{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fafafa)}
.sd-card-icon{font-size:14px;opacity:.8}
.sd-card-value{font-size:20px;font-weight:600;line-height:1.3;margin-top:2px;font-variant-numeric:tabular-nums}
.sd-card-label{font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.sd-two-col{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:18px;align-items:start}
.sd-section{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-1,#fcfcfc);min-width:0}
.sd-table{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;overflow:hidden}
.sd-row{display:grid;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#eee);font-size:12px}
.sd-row:last-child{border-bottom:0}
.sd-row-done{opacity:.6}
.sd-row-head{background:var(--dsw-alias-bg-layer-1,#f6f6f6);color:var(--dsw-alias-label-secondary,#666);font-size:11px;font-weight:600}
.sd-cell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-row-actions{display:flex;gap:6px;justify-content:flex-end}
.sd-actions-col{text-align:right}
.sd-empty{padding:26px;text-align:center;color:var(--dsw-alias-label-tertiary,#888);font-size:12px;border:1px dashed var(--dsw-alias-border-l2,#ddd);border-radius:10px}
.sd-modal-mask{position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);pointer-events:auto}
.sd-modal{width:min(620px,92vw);max-height:86vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);border-radius:12px;border:1px solid var(--dsw-alias-border-l2,#ddd);box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden}
.sd-modal-wide{width:min(980px,94vw)}
.sd-modal-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#eee)}
.sd-modal-head strong{flex:1;font-size:13.5px}
.sd-modal-body{padding:14px 16px;overflow-y:auto}
.sd-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2,#eee)}
.sd-timeline{display:flex;flex-direction:column;gap:0;border-left:2px solid var(--dsw-alias-border-l2,#e2e2e2);margin-left:8px;padding-left:16px}
.sd-tl-item{position:relative;padding:0 0 12px 0}
.sd-tl-item:before{content:"";position:absolute;left:-22px;top:12px;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-brand-primary,#247bbf);border:2px solid var(--dsw-alias-bg-base,#fff)}
.sd-tl-badge{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888);margin-bottom:3px}
.sd-tl-card{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:9px;padding:9px 12px;background:var(--dsw-alias-bg-layer-1,#fcfcfc);cursor:pointer}
.sd-tl-card:hover{border-color:var(--dsw-alias-brand-primary,#247bbf)}
.sd-tl-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sd-tl-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary,#666);margin-top:3px}
.sd-tl-text{font-size:12px;line-height:1.6;margin-top:4px;color:var(--dsw-alias-label-secondary,#555);white-space:pre-wrap}
.sd-tag{display:inline-block;padding:0 6px;border-radius:999px;font-size:10.5px;line-height:18px;border:1px solid var(--dsw-alias-border-l2,#ddd);color:var(--dsw-alias-label-secondary,#666);margin-right:4px}
.sd-tag-brand{color:var(--dsw-alias-brand-primary,#247bbf);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 40%,transparent)}
.sd-tag-muted{color:var(--dsw-alias-label-tertiary,#888)}
.sd-checks{display:flex;flex-direction:column;gap:8px}
.sd-check{padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);background:var(--dsw-alias-bg-layer-2,#fff);font-size:12px}
.sd-check-error{border-left:3px solid var(--dsw-alias-state-error-primary,#c0392b)}
.sd-check-warn{border-left:3px solid var(--dsw-alias-state-warn-primary,#d68910)}
.sd-check-info{border-left:3px solid var(--dsw-alias-border-l2,#bbb)}
.sd-check-title{font-weight:600;margin-bottom:2px}
.sd-check-detail{color:var(--dsw-alias-label-secondary,#666);line-height:1.55}
.sd-mini-list{display:flex;flex-direction:column;gap:6px}
.sd-mini-row{display:flex;align-items:center;gap:8px;font-size:12px}
.sd-mini-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-mini-meta{color:var(--dsw-alias-label-tertiary,#888);font-size:11px}
.sd-chapter-list{display:flex;flex-direction:column;gap:6px}
.sd-chapter{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fcfcfc)}
.sd-chapter-id{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums;width:40px;flex:0 0 auto}
.sd-chapter-main{flex:1;min-width:0;cursor:pointer}
.sd-chapter-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-chapter-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary,#666);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-chapter-actions{display:flex;gap:6px}
.sd-welcome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:40px}
.sd-welcome h2{margin:0;font-size:20px}
.sd-welcome p{margin:0;max-width:460px;color:var(--dsw-alias-label-secondary,#666);line-height:1.7}
.sd-code{padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f2f2f2);border:1px solid var(--dsw-alias-border-l2,#e2e2e2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;word-break:break-all;color:var(--dsw-alias-label-secondary,#555)}
.sd-error{margin:10px 16px 0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 10%,transparent);color:var(--dsw-alias-state-error-primary,#c0392b);font-size:12px}

.sd-proposal{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:11px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,#fcfcfc);display:flex;flex-direction:column;gap:8px}
.sd-proposal-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sd-proposal-title{font-size:13.5px}
.sd-proposal-summary{font-size:12.5px;color:var(--dsw-alias-label-secondary,#555);line-height:1.6}
.sd-proposal-body{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.6;border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:8px}
.sd-proposal-item{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-2,#f4f4f4);border-radius:6px;padding:5px 8px;word-break:break-all}
.sd-proposal-text{white-space:pre-wrap;font-size:12px;line-height:1.7;border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:8px}
.sd-proposal-actions{display:flex;gap:8px;justify-content:flex-end}
.sd-ul{margin:4px 0 0;padding-left:20px}
.sd-ul li{margin:2px 0}
.sd-diff{max-height:360px;overflow:auto;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fff);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55;padding:6px 0}
.sd-diff > div{padding:0 10px;white-space:pre-wrap;word-break:break-all}
.sd-diff-same{color:var(--dsw-alias-label-tertiary,#999)}
.sd-diff-add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 12%,transparent);color:var(--dsw-alias-state-success-primary,#1e8449)}
.sd-diff-del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 10%,transparent);color:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-align-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}
.sd-align-card{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-1,#fcfcfc)}
.sd-align-label{font-size:11.5px;color:var(--dsw-alias-label-secondary,#666)}
.sd-align-value{font-size:18px;font-weight:600;margin:4px 0 8px;font-variant-numeric:tabular-nums}
.sd-progress{height:6px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-secondary,#888) 16%,transparent);overflow:hidden}
.sd-progress-fill{height:100%;border-radius:4px;background:var(--dsw-alias-brand-primary,#247bbf);transition:width .2s ease}
.sd-ai-result{white-space:pre-wrap;margin:10px 0 0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f4f4f4);border:1px solid var(--dsw-alias-border-l2,#e2e2e2);font-size:12px;line-height:1.6;max-height:240px;overflow:auto}
.sd-ai-busy{margin-top:10px;font-size:12px;color:var(--dsw-alias-brand-primary,#247bbf)}

.sd-feedback-list{margin-top:6px;border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:8px;display:flex;flex-direction:column;gap:4px}
.sd-feedback-item{padding:6px 9px;border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f4f4f4);font-size:12px;line-height:1.6;white-space:pre-wrap}
.sd-feedback-editor{margin-top:6px;border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:8px}
.sd-preset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.sd-preset-card{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:11px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,#fcfcfc);display:flex;flex-direction:column;gap:6px;min-width:0}
.sd-preset-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sd-preset-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary,#666)}
.sd-preset-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#555);line-height:1.6}
.sd-preset-block{border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:6px}
/* v0.4：视图切换 / 批量操作 / 导出导入 */
.sd-pagehead > .sd-pagehead-actions{flex:0 0 auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.sd-toggle{display:inline-flex;padding:2px;gap:2px;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f6f6f6)}
.sd-toggle-btn{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:11.5px;line-height:1.6;padding:3px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}
.sd-toggle-btn:hover{color:var(--dsw-alias-label-primary,#111)}
.sd-toggle-active{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-brand-primary,#247bbf);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.sd-bulkbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fafafa)}
.sd-bulkbar-actions{display:flex;gap:8px;margin-left:auto}
.sd-notice{margin:8px 0;padding:7px 12px;border-radius:8px;font-size:12px;color:var(--dsw-alias-state-success-primary,#1e8449);border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 8%,transparent)}
.sd-cb{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#555);cursor:pointer;white-space:nowrap}
.sd-cb input{width:13px;height:13px;accent-color:var(--dsw-alias-brand-primary,#247bbf);cursor:pointer;margin:0}
.sd-cb-only{padding:0}
.sd-row-cb{display:flex;align-items:center;justify-content:center}
.sd-row-cb input{width:13px;height:13px;accent-color:var(--dsw-alias-brand-primary,#247bbf);cursor:pointer;margin:0}
.sd-select-inline{width:auto;min-width:110px}
.sd-target-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
.sd-target-select{min-width:260px;max-width:420px}
@media (max-width:760px){.sd-target-select{width:100%;max-width:none}}
.sd-export-select{width:auto;min-width:96px;padding:4px 6px;font-size:11px}
.sd-inline-row{display:flex;gap:8px;align-items:center}
.sd-inline-row .sd-input{flex:1}
.sd-error-inline{margin:8px 0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 10%,transparent);color:var(--dsw-alias-state-error-primary,#c0392b);font-size:12px}
.sd-notice{padding:7px 10px;border-radius:8px;margin-bottom:10px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 10%,transparent);color:var(--dsw-alias-state-success-primary,#1e8449);font-size:11.5px}
.sd-autosave{color:var(--dsw-alias-brand-primary,#247bbf)}
.sd-preset-current{border-color:var(--dsw-alias-brand-primary,#247bbf)}
.sd-align-value-sm{font-size:14px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* v0.4：人物关系图 */
.sd-graph{display:flex;flex-direction:column;gap:8px}
.sd-graph-legend{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary,#666);padding:2px 2px 0}
.sd-graph-legend-title{font-weight:600;color:var(--dsw-alias-label-primary,#333)}
.sd-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:4px;vertical-align:middle}
.sd-dot-protagonist{background:var(--dsw-alias-brand-primary,#247bbf)}
.sd-dot-antagonist{background:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-dot-supporting{background:var(--dsw-alias-state-success-primary,#1e8449)}
.sd-dot-minor{background:#8a8a8a}
.sd-dot-ghost{background:transparent;border:1px dashed var(--dsw-alias-label-tertiary,#999);box-sizing:border-box}
.sd-graph-wrap{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fcfcfc);padding:4px;overflow:auto}
.sd-graph-svg{display:block;width:100%;height:auto;min-height:420px;user-select:none;touch-action:none}
.sd-graph-edge{stroke:var(--dsw-alias-border-l1,#c9c9c9);stroke-width:1.4;fill:none}
.sd-graph-edge-hot{stroke:var(--dsw-alias-brand-primary,#247bbf);stroke-width:2.4}
.sd-graph-edge-label{font-size:10px;fill:var(--dsw-alias-label-tertiary,#888);paint-order:stroke;stroke:var(--dsw-alias-bg-layer-1,#fcfcfc);stroke-width:3px;stroke-linejoin:round;text-anchor:middle}
.sd-graph-node{cursor:grab}
.sd-graph-node:active{cursor:grabbing}
.sd-graph-node circle{stroke:var(--dsw-alias-bg-base,#fff);stroke-width:2}
.sd-graph-node text{font-size:11px;fill:var(--dsw-alias-label-primary,#222);paint-order:stroke;stroke:var(--dsw-alias-bg-layer-1,#fcfcfc);stroke-width:3px;text-anchor:middle;pointer-events:none}
.sd-graph-node-hot circle{stroke:var(--dsw-alias-brand-primary,#247bbf);stroke-width:2.5}
.sd-graph-role-protagonist circle{fill:var(--dsw-alias-brand-primary,#247bbf)}
.sd-graph-role-antagonist circle{fill:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-graph-role-supporting circle{fill:var(--dsw-alias-state-success-primary,#1e8449)}
.sd-graph-role-minor circle{fill:#8a8a8a}
.sd-graph-role-ghost circle{fill:transparent;stroke:var(--dsw-alias-label-tertiary,#999);stroke-width:1.6;stroke-dasharray:4 3}
.sd-graph-node-ghost text{fill:var(--dsw-alias-label-tertiary,#888)}
.sd-graph-ghost-tip{font-size:9px !important;fill:var(--dsw-alias-label-tertiary,#aaa) !important}

/* v0.4：时间线泳道图 */
.sd-lane{display:flex;flex-direction:column;gap:8px}
.sd-lane-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fafafa)}
.sd-zoom{width:180px;accent-color:var(--dsw-alias-brand-primary,#247bbf);cursor:pointer}
.sd-zoom-value{min-width:34px;font-variant-numeric:tabular-nums}
.sd-lane-legend{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.sd-lane-swatch{display:inline-block;width:9px;height:9px;border-radius:2px}
.sd-lane-swatch.sd-lane-ev-normal{background:#8fa8bd}
.sd-lane-swatch.sd-lane-ev-major{background:var(--dsw-alias-brand-primary,#247bbf)}
.sd-lane-swatch.sd-lane-ev-climax{background:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-lane-scroll{overflow:auto;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fcfcfc);max-height:min(64vh,620px)}
.sd-lane-svg{display:block}
.sd-lane-band{fill:var(--dsw-alias-bg-layer-2,#f7f7f7)}
.sd-lane-band-alt{fill:var(--dsw-alias-bg-base,#fff)}
.sd-lane-label{font-size:11px;font-weight:600;fill:var(--dsw-alias-label-secondary,#555)}
.sd-lane-tick{stroke:var(--dsw-alias-border-l2,#e6e6e6);stroke-width:1;stroke-dasharray:2 4}
.sd-lane-tick-label{font-size:9px;fill:var(--dsw-alias-label-tertiary,#999)}
.sd-lane-ev{stroke:var(--dsw-alias-bg-base,#fff);stroke-width:1.5;cursor:pointer}
.sd-lane-ev:hover{stroke:var(--dsw-alias-label-primary,#333)}
.sd-lane-ev-normal{fill:#8fa8bd}
.sd-lane-ev-major{fill:var(--dsw-alias-brand-primary,#247bbf)}
.sd-lane-ev-climax{fill:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-lane-ev-text{font-size:10px;fill:#fff;pointer-events:none}
.sd-lane-arc{fill:none;stroke:#b08968;stroke-width:1.4;opacity:.8}
.sd-lane-arc-paid{stroke:#9a9a9a;stroke-dasharray:5 4;opacity:.6}

/* v0.4：章节历史版本 */
.sd-history{display:grid;grid-template-columns:200px minmax(0,1fr);gap:12px;min-height:240px}
.sd-history-list{display:flex;flex-direction:column;gap:4px;max-height:360px;overflow:auto;border-right:1px solid var(--dsw-alias-border-l2,#eee);padding-right:8px}
.sd-history-item{text-align:left;border:1px solid transparent;background:transparent;border-radius:7px;padding:6px 8px;font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary,#555);cursor:pointer;line-height:1.5}
.sd-history-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.sd-history-item-active{border-color:var(--dsw-alias-brand-primary,#247bbf);background:var(--dsw-alias-interactive-bg-selected,rgba(36,123,191,.1));color:var(--dsw-alias-brand-primary,#247bbf);font-weight:600}
.sd-history-diff{min-width:0}
.sd-history-diff .sd-diff{max-height:330px}

/* v0.4：导入 Markdown */
.sd-import-preview{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1,#fafafa);font-size:12px;display:flex;flex-direction:column;gap:5px;max-height:260px;overflow:auto;margin:4px 0 12px}
.sd-import-chapter{font-size:11.5px;color:var(--dsw-alias-label-secondary,#555);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}


.sd-import-report{display:flex;flex-direction:column;gap:12px}
.sd-import-counts{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:8px}
.sd-import-count{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:9px;padding:8px 10px;text-align:center;background:var(--dsw-alias-bg-layer-1,#fafafa)}
.sd-import-count strong{display:block;font-size:19px;line-height:1.3;font-variant-numeric:tabular-nums}
.sd-import-count span{font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.sd-import-review{border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:10px;display:flex;flex-direction:column;gap:8px}

.sd-segmented{display:inline-flex;border:1px solid var(--dsw-alias-border-l1,#d8d8d8);border-radius:8px;overflow:hidden}
.sd-segmented button{border:0;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#555);font:inherit;font-size:12px;padding:5px 12px;cursor:pointer}
.sd-segmented button.sd-seg-active{background:var(--dsw-alias-brand-primary,#247bbf);color:#fff}

.sd-decision-issue{font-size:12.5px;line-height:1.7;background:var(--dsw-alias-bg-layer-2,#f4f4f4);border-radius:7px;padding:8px 10px}
.sd-decision-options{display:flex;flex-direction:column;gap:6px;margin-top:2px}
.sd-decision-option{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:7px;cursor:pointer;font-size:12px}
.sd-decision-option:hover{border-color:var(--dsw-alias-brand-primary,#247bbf)}

.sd-dash-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.sd-dash-note{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:9px;padding:10px 12px;font-size:12px;line-height:1.8;background:var(--dsw-alias-bg-layer-1,#fafafa);display:flex;flex-direction:column;gap:2px}

.sd-cart-list{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto}
.sd-cart-item{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:7px;padding:7px 9px;font-size:12px}
.sd-cart-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-check-main{display:flex;flex-direction:column;gap:2px}

.sd-cart-row{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:8px;padding:7px 9px}
.sd-cart-row .sd-cart-item{border:0;padding:0}

.sd-writer-cards{grid-template-columns:repeat(auto-fill,minmax(108px,1fr))}
.sd-activity{margin-top:10px}
.sd-activity-bars{display:flex;align-items:flex-end;gap:6px;height:64px;margin-top:6px}
.sd-activity-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:4px;font-size:10px;color:var(--dsw-alias-label-secondary,#666)}
.sd-activity-bar{width:100%;max-width:22px;background:var(--dsw-alias-brand-primary,#247bbf);border-radius:3px 3px 0 0;min-height:4px}

.sd-decision-ai{font-size:12.5px;line-height:1.7;border-left:3px solid var(--dsw-alias-brand-primary,#247bbf);padding:4px 0 4px 10px;background:var(--dsw-alias-bg-layer-1,#fafafa);border-radius:0 6px 6px 0}

.sd-send-options{display:flex;flex-direction:column;gap:6px;margin-top:10px;font-size:12px}


.sd-cart-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1,#fafafa);margin-top:10px}
.sd-cart-banner>div{display:flex;flex-direction:column;gap:2px;font-size:12px}

.sd-picker-list{display:flex;flex-direction:column;gap:2px;max-height:360px;overflow:auto;margin-top:8px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:8px;padding:4px}
.sd-picker-row{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;padding:6px 8px;border-radius:6px;font:inherit;font-size:12px;text-align:left;cursor:pointer}
.sd-picker-row:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f2)}
.sd-picker-icon{width:16px;flex:0 0 16px}
.sd-picker-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 零上下文首读：第 10 个角色「独立审稿人」高亮卡 */
.sd-fresh{position:relative;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 40%,transparent);border-left:4px solid var(--dsw-alias-brand-primary,#247bbf);border-radius:12px;padding:14px 16px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 10%,transparent),transparent 68%),var(--dsw-alias-bg-layer-1,#fcfcfc);display:flex;flex-direction:column;gap:9px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.sd-fresh-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sd-fresh-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 9px;border-radius:999px;font-size:10.5px;line-height:18px;font-weight:600;white-space:nowrap;color:var(--dsw-alias-brand-primary,#247bbf);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 13%,transparent)}
.sd-fresh-title{font-size:14px;letter-spacing:.2px}
.sd-fresh-rank{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap}
.sd-fresh-desc{margin:0;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#555);max-width:860px}
.sd-fresh-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sd-fresh-pick{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%}
.sd-fresh-pick-label{font-size:11.5px;color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.sd-fresh-select{width:auto;min-width:220px;max-width:360px}
.sd-fresh-compact{flex-direction:row;align-items:center;gap:10px 12px;flex-wrap:wrap;padding:9px 14px;border-left-width:3px}
.sd-fresh-compact-text{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;flex:1;min-width:0;font-size:12px}
.sd-fresh-compact .sd-btn{margin-left:0}
.sd-fresh-compact .sd-btn:first-of-type{margin-left:auto}
/* v0.6：侧边栏分组 */
.sd-nav-group{padding:12px 10px 3px;font-size:10.5px;font-weight:600;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary,#999);line-height:1.4;user-select:none;cursor:default}
.sd-nav > .sd-nav-group:first-of-type{padding-top:4px}
.sd-nav-item + .sd-nav-group{margin-top:2px;border-top:1px solid var(--dsw-alias-border-l2,#ececec)}
.sd-row-hi{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 6%,transparent)}
.sd-weight{display:inline-block;min-width:20px;padding:0 5px;border-radius:999px;font-size:11px;line-height:17px;text-align:center;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#666)}
.sd-weight-hi{color:var(--dsw-alias-brand-primary,#247bbf);font-weight:700;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 15%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 45%,transparent)}
.sd-tag-success{color:var(--dsw-alias-state-success-primary,#1e8449);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 45%,transparent)}
.sd-tag-warn{color:var(--dsw-alias-state-warn-primary,#d68910);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 45%,transparent)}
.sd-tag-error{color:var(--dsw-alias-state-error-primary,#c0392b);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 45%,transparent)}
/* 事实账本：按主体合并视图 */
.sd-facts-wrap{display:flex;flex-direction:column;gap:10px}
.sd-facts-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sd-facts-search{max-width:320px}
.sd-facts-toolbar-actions{margin-left:auto;display:flex;gap:8px}
.sd-facts-group{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fafafa)}
.sd-facts-group-conflict{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 45%,transparent)}
.sd-facts-head{display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;border:0;background:transparent;cursor:pointer;font:inherit;font-size:12.5px;text-align:left;color:var(--dsw-alias-label-primary,#111)}
.sd-facts-head:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f2)}
.sd-facts-caret{width:12px;flex:0 0 12px;opacity:.7}
.sd-facts-subject{font-weight:600}
.sd-facts-head-hint{margin-left:auto;color:var(--dsw-alias-label-tertiary,#888);font-size:11px;white-space:nowrap}
.sd-facts-body{padding:6px 12px 10px;border-top:1px solid var(--dsw-alias-border-l2,#eee)}
.sd-facts-attr{margin-top:8px}
.sd-facts-attr-head{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#555)}
.sd-facts-attr-name{font-weight:600}
.sd-facts-rows{margin-top:2px;display:flex;flex-direction:column}
.sd-facts-row{display:grid;grid-template-columns:1.3fr 80px 100px 1.5fr 110px;gap:10px;align-items:center;padding:5px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,#eee);font-size:12px}
.sd-facts-row:last-child{border-bottom:0}
.sd-facts-value{font-weight:500;overflow-wrap:anywhere}
.sd-facts-chapter,.sd-facts-range{color:var(--dsw-alias-label-secondary,#666);font-size:11.5px;white-space:nowrap}
.sd-facts-note{color:var(--dsw-alias-label-tertiary,#888);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-facts-actions{display:flex;gap:6px;justify-content:flex-end}
.sd-facts-group-actions{margin-top:8px}
@media (max-width:900px){.sd-facts-row{grid-template-columns:1fr 70px 80px;}.sd-facts-note,.sd-facts-actions{grid-column:1 / -1;}.sd-facts-actions{justify-content:flex-start}}

/* v0.6：⚡ 注意力页 */
.sd-att-guide{margin:6px 0 0;padding:6px 10px;border-left:3px solid var(--dsw-alias-brand-primary,#247bbf);border-radius:0 6px 6px 0;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 8%,transparent);color:var(--dsw-alias-label-secondary,#555);font-size:11.5px;line-height:1.65}
.sd-att-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.sd-att-stat{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fafafa);min-width:0}
.sd-att-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.sd-att-stat-big{margin-top:2px;font-size:26px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums}
.sd-att-stat-list{display:flex;flex-direction:column;gap:2px;margin-top:4px;font-size:12px}
.sd-att-lowrow{display:flex;align-items:center;justify-content:space-between;gap:8px}
.sd-att-lowscore{font-variant-numeric:tabular-nums;font-weight:600}
.sd-att-warns{display:flex;flex-direction:column;gap:4px}
.sd-att-warn{padding:6px 10px;border-radius:8px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 9%,transparent);color:var(--dsw-alias-label-primary,#333);font-size:11.5px;line-height:1.55}
.sd-att-tone-low{color:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-att-tone-mid{color:var(--dsw-alias-state-warn-primary,#d68910)}
.sd-att-tone-ok{color:var(--dsw-alias-label-primary,#222)}
.sd-att-tone-top{color:var(--dsw-alias-state-success-primary,#1e8449)}
.sd-att-tone-missing{color:var(--dsw-alias-label-tertiary,#888);font-size:13px;font-weight:400}
.sd-att-chart{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fcfcfc);padding:10px 12px}
.sd-att-chart-scroll{overflow-x:auto;overflow-y:hidden;padding-bottom:2px}
.sd-att-chart-svg{display:block;max-width:none}
.sd-att-legend{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.sd-att-legend-item{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.sd-att-swatch{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--att-color,#8a8a8a);flex:0 0 auto}
.sd-att-legend-dash{display:inline-block;width:18px;border-top:2px dashed var(--dsw-alias-label-secondary,#888)}
.sd-att-legend-risk{display:inline-block;width:10px;height:10px;border-radius:50%;border:2px solid var(--dsw-alias-state-error-primary,#c0392b);box-sizing:border-box}
.sd-att-grid{stroke:var(--dsw-alias-border-l2,#e6e6e6);stroke-width:1;stroke-dasharray:2 4}
.sd-att-axis-label{font-size:9.5px;fill:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums}
.sd-att-score-line{fill:none;stroke:var(--dsw-alias-brand-primary,#247bbf);stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round;opacity:.85}
.sd-att-design-line{fill:none;stroke:var(--dsw-alias-label-secondary,#888);stroke-width:1.3;stroke-dasharray:5 4;opacity:.75}
.sd-att-dot{fill:var(--att-color,#247bbf);stroke:var(--dsw-alias-bg-base,#fff);stroke-width:1.2;cursor:pointer}
.sd-att-dot:hover{stroke:var(--dsw-alias-label-primary,#222);stroke-width:2}
.sd-att-dot-risk{stroke:var(--dsw-alias-state-error-primary,#c0392b);stroke-width:2.2}
.sd-att-design-dot{fill:var(--dsw-alias-bg-base,#fff);stroke:var(--dsw-alias-label-secondary,#888);stroke-width:1;opacity:.8}
.sd-att-c-event{--att-color:#247bbf}
.sd-att-c-emotion{--att-color:#e0567b}
.sd-att-c-language{--att-color:#8a6fd1}
.sd-att-c-mystery{--att-color:#d68910}
.sd-att-c-relationship{--att-color:#1e8449}
.sd-att-type{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--att-color,#888) 45%,transparent);background:color-mix(in srgb,var(--att-color,#888) 12%,transparent);color:var(--dsw-alias-label-primary,#333);font-size:10.5px;line-height:18px;font-weight:600;white-space:nowrap}
.sd-att-cards{display:flex;flex-direction:column;gap:10px}
.sd-att-card{padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fcfcfc);display:flex;flex-direction:column;gap:9px;scroll-margin-top:12px}
.sd-att-card:target{border-color:var(--dsw-alias-brand-primary,#247bbf)}
.sd-att-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sd-att-chapter{font-size:13.5px;font-weight:700;display:inline-flex;align-items:baseline;gap:8px}
.sd-att-chapter-title{font-weight:400;font-size:12px;color:var(--dsw-alias-label-secondary,#666);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-att-score{font-size:20px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.sd-att-score-unit{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary,#999);margin-left:1px}
.sd-att-design,.sd-att-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.sd-att-gap{font-size:11px;font-weight:600;padding:0 6px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 40%,transparent);color:var(--dsw-alias-state-warn-primary,#d68910);font-variant-numeric:tabular-nums}
.sd-att-gap-bad{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 40%,transparent);color:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-att-card-actions{margin-left:auto;display:flex;gap:6px}
.sd-att-drop{font-size:12px;line-height:1.6;padding:6px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 9%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 28%,transparent);display:flex;gap:8px;align-items:baseline}
.sd-att-drop strong{color:var(--dsw-alias-state-error-primary,#c0392b);font-size:11px;white-space:nowrap}
.sd-att-beats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
.sd-att-beat{padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f6f6f6);border:1px solid var(--dsw-alias-border-l2,#eee);min-width:0}
.sd-att-beat-label{font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#666);margin-bottom:3px}
.sd-att-beat-text{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-primary,#333);white-space:pre-wrap;word-break:break-word}
.sd-att-beat-empty{color:var(--dsw-alias-label-tertiary,#999)}
.sd-att-emotion,.sd-att-question{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:1.65}
.sd-att-emotion strong,.sd-att-question strong{font-size:11px;color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.sd-att-detail{border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:8px}
.sd-att-detail summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#555)}
.sd-att-detail-body{margin-top:6px;white-space:pre-wrap;font-size:12px;line-height:1.75;color:var(--dsw-alias-label-primary,#333);background:var(--dsw-alias-bg-layer-2,#f6f6f6);border-radius:8px;padding:8px 10px;max-height:320px;overflow:auto}
.sd-att-aggs{display:flex;flex-direction:column;gap:2px;border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:8px}
.sd-att-agg>summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,#555);padding:3px 0;list-style:none;display:flex;align-items:center;gap:6px}
.sd-att-agg>summary::-webkit-details-marker{display:none}
.sd-att-agg>summary:before{content:"▸";font-size:10px;color:var(--dsw-alias-label-tertiary,#999)}
.sd-att-agg[open]>summary:before{content:"▾"}
.sd-att-agg-body{padding:4px 0 6px 18px;display:flex;flex-direction:column;gap:4px}
.sd-att-agg-row{display:flex;gap:10px;align-items:baseline;font-size:12px;line-height:1.55}
.sd-att-agg-title{color:var(--dsw-alias-label-primary,#333);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%}
.sd-att-agg-meta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap}
.sd-att-agg-actions{margin-top:2px}
.sd-att-unmarked-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
.sd-att-unmarked{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px dashed var(--dsw-alias-border-l2,#ddd);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fafafa);scroll-margin-top:12px}
.sd-att-unmarked-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.sd-att-unmarked-ch{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}
.sd-att-unmarked-title{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-att-unmarked-tag{font-size:10.5px;color:var(--dsw-alias-state-warn-primary,#d68910)}
/* 设计 / 实测闭环状态徽章（任务 6） */
.sd-att-state{display:inline-flex;align-items:center;gap:4px;padding:0 7px;border-radius:999px;font-size:10.5px;line-height:18px;font-weight:600;white-space:nowrap;border:1px solid transparent}
.sd-att-state:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
.sd-att-state-closed{color:var(--dsw-alias-state-success-primary,#1e8449);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 10%,transparent)}
.sd-att-state-waiting{color:var(--dsw-alias-brand-primary,#247bbf);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 10%,transparent)}
.sd-att-state-nodesign{color:var(--dsw-alias-state-warn-primary,#d68910);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 10%,transparent)}
.sd-att-state-blank{color:var(--dsw-alias-label-tertiary,#888);border-color:var(--dsw-alias-border-l2,#ddd);background:var(--dsw-alias-bg-layer-2,#f4f4f4)}
.sd-att-design-hint{font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary,#888);max-width:100%}
.sd-att-ov-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.sd-att-ov-head{display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap}
.sd-att-ov-title{margin:0}
.sd-att-ov{display:grid;grid-template-columns:auto repeat(3,minmax(0,1fr));gap:16px;align-items:start;margin-top:6px}
.sd-att-ov-bigwrap{display:flex;flex-direction:column;gap:2px;padding-right:16px;border-right:1px solid var(--dsw-alias-border-l2,#eee)}
.sd-att-ov-big{font-size:38px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.sd-att-ov-label{font-size:11px;color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.sd-att-ov-mini{display:flex;flex-direction:column;gap:3px;min-width:0;font-size:12px}
.sd-att-ov-mini-label{font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.sd-att-ov-num{font-size:20px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}
.sd-att-ov-row{display:flex;justify-content:space-between;gap:8px}
/* v0.6：人物详情弹窗 */
.sd-modal-head .sd-char-name{flex:0 0 auto;font-size:14px}
.sd-char-actions{display:flex;align-items:center;gap:6px;margin-left:auto}
.sd-char-body{display:flex;flex-direction:column;gap:12px}
.sd-char-section{border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:10px}
.sd-char-section:first-child{border-top:0;padding-top:0}
.sd-char-section-title{margin:0 0 8px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#222)}
.sd-char-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px 14px}
.sd-char-field{display:flex;flex-direction:column;gap:2px;min-width:0}
.sd-char-field-wide{margin-top:8px}
.sd-char-field-label{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888)}
.sd-char-field-value{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-primary,#333);white-space:pre-wrap;word-break:break-word}
.sd-char-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
.sd-char-chips{display:flex;flex-wrap:wrap;gap:6px}
.sd-char-chip{font-size:11px;line-height:20px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#ddd);background:var(--dsw-alias-bg-layer-2,#f4f4f4);color:var(--dsw-alias-label-secondary,#555);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.sd-char-row{display:flex;align-items:baseline;gap:10px;padding:5px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,#eee);font-size:12px}
.sd-char-row:last-child{border-bottom:0}
.sd-char-row-main{flex:1;min-width:0;color:var(--dsw-alias-label-primary,#333);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-char-row-meta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap}
.sd-char-fact-group{margin-top:6px}
.sd-char-fact-head{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#555)}
.sd-char-fact-row{display:flex;align-items:baseline;gap:10px;padding:3px 0 3px 12px;font-size:12px;border-bottom:1px dashed var(--dsw-alias-border-l2,#eee)}
.sd-char-fact-row:last-child{border-bottom:0}
.sd-char-fact-value{flex:1;min-width:0;overflow-wrap:anywhere}
.sd-char-fact-meta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap}

/* v0.6：人物重要性配色 / 卡片视图 / 人物详情卡 */
.sd-char-role-protagonist{--char-role-color:var(--dsw-alias-brand-primary,#247bbf)}
.sd-char-role-antagonist{--char-role-color:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-char-role-supporting{--char-role-color:var(--dsw-alias-state-success-primary,#1e8449)}
.sd-char-role-minor{--char-role-color:var(--dsw-alias-label-secondary,#666)}
.sd-char-role-other{--char-role-color:var(--dsw-alias-label-tertiary,#999)}
.sd-charcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.sd-char-card{position:relative;display:flex;flex-direction:column;gap:8px;align-items:stretch;text-align:left;padding:14px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-top:3px solid var(--char-role-color,#8a8a8a);border-radius:13px;background:linear-gradient(160deg,color-mix(in srgb,var(--char-role-color,#8a8a8a) 13%,transparent),transparent 58%),var(--dsw-alias-bg-layer-1,#fcfcfc);box-shadow:0 1px 2px rgba(0,0,0,.05);color:var(--dsw-alias-label-primary,#111);font:inherit;cursor:pointer;transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease;min-width:0}
.sd-char-card:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(0,0,0,.16);border-color:color-mix(in srgb,var(--char-role-color,#8a8a8a) 55%,var(--dsw-alias-border-l2,#e2e2e2))}
.sd-char-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:2px}
.sd-char-card-head{display:flex;align-items:center;gap:10px;min-width:0}
.sd-char-card-avatar{width:44px;height:44px;flex:0 0 auto;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:var(--char-role-color,#8a8a8a);background:radial-gradient(circle at 30% 25%,color-mix(in srgb,var(--char-role-color,#8a8a8a) 34%,transparent),color-mix(in srgb,var(--char-role-color,#8a8a8a) 10%,transparent));border:1.5px solid color-mix(in srgb,var(--char-role-color,#8a8a8a) 60%,transparent)}
.sd-char-card-ident{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.sd-char-card-name{font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-char-card-role{font-size:11px;color:var(--char-role-color,#8a8a8a);font-weight:600}
.sd-char-card-att{font-size:12px;font-weight:700;color:var(--dsw-alias-brand-primary,#247bbf);white-space:nowrap}
.sd-char-card-att-empty{color:var(--dsw-alias-label-tertiary,#999);font-weight:400}
.sd-char-card-tags{display:flex;flex-wrap:wrap;gap:4px}
.sd-char-card-stats{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--dsw-alias-label-secondary,#666);border-top:1px dashed var(--dsw-alias-border-l2,#eee);padding-top:7px}
.sd-char-card-rel{display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:11px;min-width:0}
.sd-char-card-rel-label{color:var(--dsw-alias-label-tertiary,#888);font-size:10.5px;margin-right:2px}
.sd-char-detail{overflow:hidden}
.sd-char-detail-head{display:flex;align-items:center;gap:14px;padding:16px 18px 14px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l2,#e5e5e5);box-shadow:inset 0 1px 0 rgba(255,255,255,.05);background:linear-gradient(150deg,color-mix(in srgb,var(--char-role-color,#8a8a8a) 16%,transparent),transparent 62%),var(--dsw-alias-bg-layer-1,#fafafa)}
.sd-char-avatar-lg{width:72px;height:72px;flex:0 0 auto;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:700;color:var(--char-role-color,#8a8a8a);background:radial-gradient(circle at 30% 25%,color-mix(in srgb,var(--char-role-color,#8a8a8a) 38%,transparent),color-mix(in srgb,var(--char-role-color,#8a8a8a) 10%,transparent));border:2px solid color-mix(in srgb,var(--char-role-color,#8a8a8a) 65%,transparent);box-shadow:0 0 22px color-mix(in srgb,var(--char-role-color,#8a8a8a) 20%,transparent)}
.sd-char-detail-ident{flex:1;min-width:180px;display:flex;flex-direction:column;gap:6px}
.sd-char-detail-name{font-size:20px;font-weight:700;letter-spacing:.02em}
.sd-char-detail-badges{display:flex;flex-wrap:wrap;gap:4px}
.sd-char-detail-meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}
.sd-char-detail-meta-item{white-space:nowrap}
.sd-char-role-badge{display:inline-block;padding:0 8px;border-radius:999px;font-size:10.5px;line-height:18px;font-weight:600;color:var(--char-role-color,#8a8a8a);border:1px solid color-mix(in srgb,var(--char-role-color,#8a8a8a) 50%,transparent);background:color-mix(in srgb,var(--char-role-color,#8a8a8a) 12%,transparent)}
.sd-char-detail-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}
.sd-char-numbers{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1px;background:var(--dsw-alias-border-l2,#e8e8e8);border-bottom:1px solid var(--dsw-alias-border-l2,#e5e5e5)}
.sd-char-number{padding:10px 8px;text-align:center;background:var(--dsw-alias-bg-base,#fff);min-width:0}
.sd-char-number-value{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#111);line-height:1.2}
.sd-char-number-unit{font-size:10.5px;font-weight:400;color:var(--dsw-alias-label-tertiary,#999);margin-left:1px}
.sd-char-number-label{font-size:10.5px;color:var(--dsw-alias-label-secondary,#666);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-char-detail-cols{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:16px;align-items:start}
.sd-char-col{display:flex;flex-direction:column;gap:10px;min-width:0}
.sd-char-basic-field{padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e6e6e6);border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f6f6f6)}
@media (max-width:760px){.sd-char-numbers{grid-template-columns:repeat(2,minmax(0,1fr))}.sd-char-detail-cols{grid-template-columns:1fr}.sd-char-detail-name{font-size:17px}.sd-char-detail-actions{margin-left:0}}

/* v0.6：冲突按参与方 / 伏笔按回收段（与事实账本同一套合并视图样式） */
.sd-conf-wrap,.sd-fore-wrap{display:flex;flex-direction:column;gap:10px}
.sd-conf-toolbar,.sd-fore-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sd-conf-search,.sd-fore-search{max-width:340px}
.sd-conf-toolbar-actions,.sd-fore-toolbar-actions{margin-left:auto;display:flex;gap:8px}
.sd-conf-group,.sd-fore-group{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fafafa)}
.sd-conf-head,.sd-fore-head{display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;border:0;background:transparent;cursor:pointer;font:inherit;font-size:12.5px;text-align:left;color:var(--dsw-alias-label-primary,#111)}
.sd-conf-head:hover,.sd-fore-head:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f2)}
.sd-conf-caret,.sd-fore-caret{width:12px;flex:0 0 12px;opacity:.7}
.sd-conf-parties,.sd-fore-arc{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-conf-head-hint,.sd-fore-head-hint{margin-left:auto;color:var(--dsw-alias-label-tertiary,#888);font-size:11px;white-space:nowrap}
.sd-conf-body,.sd-fore-body{padding:6px 12px 10px;border-top:1px solid var(--dsw-alias-border-l2,#eee);display:flex;flex-direction:column;gap:6px}
.sd-conf-row,.sd-fore-row{padding:7px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,#eee)}
.sd-conf-row:last-child,.sd-fore-row:last-child{border-bottom:0}
.sd-conf-row-head,.sd-fore-row-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sd-conf-title,.sd-fore-title{font-size:12.5px}
.sd-conf-actions,.sd-fore-actions{margin-left:auto;display:flex;gap:6px}
.sd-conf-line{display:flex;gap:8px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#555);margin-top:3px}
.sd-conf-line>span:first-child{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#888)}
.sd-conf-line-note{color:var(--dsw-alias-label-tertiary,#888)}
.sd-fore-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.sd-fore-text{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#555);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-fore-note{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#888);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* v0.6：时间线全景 */
.sd-pano-wrap{display:flex;flex-direction:column;gap:10px}
.sd-pano-toolbar{display:flex;align-items:center;gap:12px 16px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fafafa)}
.sd-pano-count{margin-left:auto;white-space:nowrap}
.sd-pano-cards{display:flex;flex-direction:column;gap:10px}
.sd-pano-card{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:11px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1,#fcfcfc);display:flex;flex-direction:column;gap:8px}
.sd-pano-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sd-pano-title{border:0;background:transparent;padding:0;font:inherit;font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary,#111);cursor:pointer;text-align:left}
.sd-pano-title:hover{color:var(--dsw-alias-brand-primary,#247bbf)}
.sd-pano-att{margin-left:auto;font-size:10.5px;line-height:18px;padding:0 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 10%,transparent);color:var(--dsw-alias-brand-primary,#247bbf);white-space:nowrap}
.sd-pano-att-empty{border-color:var(--dsw-alias-border-l2,#ddd);background:var(--dsw-alias-bg-layer-2,#f4f4f4);color:var(--dsw-alias-label-tertiary,#888)}
.sd-pano-sec{border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:6px}
.sd-pano-sec-label{font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#666);margin-bottom:2px}
.sd-pano-row{display:flex;align-items:baseline;gap:10px;padding:2px 0;font-size:12px;line-height:1.55}
.sd-pano-row-main{color:var(--dsw-alias-label-primary,#333);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.sd-pano-row-meta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap}

/* v0.6：章节地图 🗺️ */
.sd-map-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.sd-map-stat{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fafafa);min-width:0}
.sd-map-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.sd-map-stat-big{margin-top:2px;font-size:24px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums}
.sd-map-stat-hint{margin-top:2px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888)}
.sd-map-stat-cover{grid-column:span 2}
.sd-map-cover{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 12px;margin-top:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#666)}
.sd-map-legend{display:flex;align-items:center;gap:8px 14px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fafafa);font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.sd-map-legend-title{font-weight:600;color:var(--dsw-alias-label-primary,#333)}
.sd-map-legend-item{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.sd-map-legend-sep{color:var(--dsw-alias-border-l1,#ccc)}
.sd-map-swatch{display:inline-block;width:9px;height:9px;border-radius:3px;flex:0 0 auto;border:1px solid transparent}
.sd-map-swatch-draft{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#999) 55%,transparent)}
.sd-map-swatch-revised{background:var(--dsw-alias-state-warn-primary,#d68910)}
.sd-map-swatch-final{background:var(--dsw-alias-state-success-primary,#1e8449)}
.sd-map-swatch-planned{background:transparent;border:1px dashed var(--dsw-alias-label-secondary,#777)}
.sd-map-swatch-att-low{background:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-map-swatch-att-mid{background:var(--dsw-alias-state-warn-primary,#d68910)}
.sd-map-swatch-att-high{background:var(--dsw-alias-state-success-primary,#1e8449)}
.sd-map-swatch-att-untested{background:var(--dsw-alias-label-secondary,#888)}
.sd-map-swatch-att-none{background:transparent;border:1px solid var(--dsw-alias-border-l1,#ccc)}
.sd-map-board{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:12px;padding:12px;background:var(--dsw-alias-bg-layer-1,#fcfcfc);overflow-x:auto}
.sd-map-row{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:8px;min-width:640px}
.sd-map-row-rev{direction:rtl}
.sd-mapnode{position:relative;direction:ltr;display:flex;flex-direction:column;gap:3px;text-align:left;padding:8px 9px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-left:3px solid var(--dsw-alias-label-tertiary,#999);border-radius:9px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:inherit;cursor:pointer;min-width:0;transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease}
.sd-mapnode:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(0,0,0,.14);border-color:var(--dsw-alias-brand-primary,#247bbf)}
.sd-mapnode:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:2px}
.sd-mapnode-status-draft{border-left-color:var(--dsw-alias-label-tertiary,#999)}
.sd-mapnode-status-revised{border-left-color:var(--dsw-alias-state-warn-primary,#d68910)}
.sd-mapnode-status-final{border-left-color:var(--dsw-alias-state-success-primary,#1e8449)}
.sd-mapnode-status-planned{border-style:dashed;border-left-style:dashed;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#f4f4f4) 55%,transparent)}
.sd-mapnode-top{display:flex;align-items:center;justify-content:space-between;gap:4px;min-width:0}
.sd-mapnode-chapter{font-size:18px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#111)}
.sd-mapnode-att{font-size:10px;font-weight:700;line-height:16px;padding:0 5px;border-radius:999px;border:1px solid transparent;white-space:nowrap}
.sd-mapnode-att-low{color:var(--dsw-alias-state-error-primary,#c0392b);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 10%,transparent)}
.sd-mapnode-att-mid{color:var(--dsw-alias-state-warn-primary,#d68910);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 10%,transparent)}
.sd-mapnode-att-high{color:var(--dsw-alias-state-success-primary,#1e8449);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 10%,transparent)}
.sd-mapnode-att-untested{color:var(--dsw-alias-label-secondary,#666);border-color:var(--dsw-alias-border-l2,#ddd)}
.sd-mapnode-att-none{color:var(--dsw-alias-label-tertiary,#aaa);border-color:var(--dsw-alias-border-l2,#e2e2e2);background:transparent}
.sd-mapnode-title{font-size:11.5px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.sd-mapnode-meta{display:flex;align-items:center;justify-content:space-between;gap:4px;font-size:9.5px;color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap}
.sd-mapnode-words{font-variant-numeric:tabular-nums}
.sd-mapnode-badges{display:flex;flex-wrap:wrap;gap:3px}
.sd-mapnode-badge{font-size:9px;line-height:14px;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f0f0f0);border:1px solid var(--dsw-alias-border-l2,#e2e2e2);color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.sd-mapnode-badge-event{color:var(--dsw-alias-brand-primary,#247bbf)}
.sd-mapnode-badge-conflict{color:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-mapnode-badge-foreshadow{color:var(--dsw-alias-state-warn-primary,#d68910)}
.sd-mapnode-badge-highlight{color:var(--dsw-alias-state-success-primary,#1e8449)}
.sd-map-detail{overflow:hidden}
.sd-modal-head .sd-map-detail-title{flex:0 1 auto;font-size:14px}
.sd-map-detail-head{flex-wrap:wrap;gap:8px}
.sd-map-detail-actions{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.sd-map-detail-body{display:flex;flex-direction:column;gap:10px}
.sd-map-section{border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:8px}
.sd-map-section:first-child{border-top:0;padding-top:0}
.sd-map-section-title{margin:0 0 5px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#222)}
.sd-map-text{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#555);white-space:pre-wrap;word-break:break-word}
.sd-map-detail-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary,#666)}
.sd-map-att{display:flex;flex-direction:column;gap:3px}
.sd-map-att-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.sd-map-att-score{font-size:20px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}
.sd-map-att-score-low{color:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-map-att-score-mid{color:var(--dsw-alias-state-warn-primary,#d68910)}
.sd-map-att-score-high{color:var(--dsw-alias-state-success-primary,#1e8449)}
.sd-map-att-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.sd-map-rowline{display:flex;align-items:baseline;gap:10px;padding:3px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,#eee);font-size:12px}
.sd-map-rowline:last-child{border-bottom:0}
.sd-map-rowline-main{flex:1;min-width:0;color:var(--dsw-alias-label-primary,#333);white-space:pre-wrap;word-break:break-word}
.sd-map-rowline-meta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap}
.sd-map-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}

/* v0.6：🌍 世界 / 地点 / 只读 HTML */
.sd-world-guide{display:flex;align-items:center;gap:14px;justify-content:space-between;flex-wrap:wrap;padding:12px 14px;border:1px dashed color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 40%,transparent);border-radius:11px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 8%,transparent),transparent 65%),var(--dsw-alias-bg-layer-1,#fafafa)}
.sd-world-guide strong{font-size:13px}
.sd-world-guide p{margin:2px 0 0;max-width:720px}
.sd-world-guide-actions{display:flex;gap:8px;flex-wrap:wrap}
.sd-world-settings-head{display:flex;align-items:baseline;gap:10px;justify-content:space-between;flex-wrap:wrap}
.sd-world-settings-head .sd-h3{margin:0}
.sd-world-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:0 14px;margin-top:8px}
.sd-world-settings-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px}
.sd-world-map-head{display:flex;align-items:baseline;gap:10px;justify-content:space-between;flex-wrap:wrap}
.sd-world-map-head .sd-h3{margin:0}
.sd-world-focus-banner{display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap;margin-top:8px;padding:7px 11px;border-radius:9px;font-size:11.5px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 9%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 30%,transparent);color:var(--dsw-alias-label-primary,#333)}
.sd-world-focus-banner-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 35%,transparent)}
.sd-world-map-scroll{margin-top:8px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fcfcfc);overflow:hidden}
.sd-world-svg{display:block;width:100%;height:min(70vh,640px);background:var(--dsw-alias-bg-layer-1,#fcfcfc)}
.sd-world-map-bg{fill:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#f5f5f5) 55%,transparent);stroke:var(--dsw-alias-border-l2,#e6e6e6);stroke-width:1}
.sd-world-map-empty{display:flex;align-items:center;justify-content:center;min-height:280px;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary,#888);font-size:12px}
.sd-world-edge-line{stroke:var(--dsw-alias-border-l1,#c9c9c9);stroke-width:1.6;fill:none}
.sd-world-edge-hot .sd-world-edge-line{stroke:var(--dsw-alias-brand-primary,#247bbf);stroke-width:2.6}
.sd-world-edge-dim .sd-world-edge-line{opacity:.28}
.sd-world-edge-label{font-size:11px;fill:var(--dsw-alias-label-tertiary,#888);paint-order:stroke;stroke:var(--dsw-alias-bg-layer-1,#fcfcfc);stroke-width:3px;stroke-linejoin:round;text-anchor:middle;pointer-events:none}
.sd-world-node{cursor:grab}
.sd-world-node:active{cursor:grabbing}
.sd-world-node circle{fill:var(--loc-color,#8fa8bd);stroke:var(--dsw-alias-bg-base,#fff);stroke-width:2;transition:stroke-width .12s ease,stroke .12s ease}
.sd-world-node:hover circle{stroke:var(--dsw-alias-label-primary,#333)}
.sd-world-node-label{font-size:12px;fill:var(--dsw-alias-label-primary,#222);paint-order:stroke;stroke:var(--dsw-alias-bg-layer-1,#fcfcfc);stroke-width:3px;text-anchor:middle;pointer-events:none}
.sd-world-node-hot circle{stroke:var(--dsw-alias-brand-primary,#247bbf);stroke-width:3}
.sd-world-node-adj circle{stroke:var(--dsw-alias-state-warn-primary,#d68910);stroke-width:2.4}
.sd-world-node-focus circle{stroke:var(--dsw-alias-brand-primary,#247bbf);stroke-width:3.4}
.sd-world-node-drag circle{stroke:var(--dsw-alias-state-error-primary,#c0392b);stroke-width:3}
.sd-world-legend{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.sd-world-legend-item{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.sd-world-legend-swatch{width:9px;height:9px;border-radius:50%;background:var(--loc-color,#8fa8bd);display:inline-block;flex:0 0 auto}
.sd-loc-type-capital{--loc-color:#c9a227}
.sd-loc-type-city{--loc-color:#4a8fd4}
.sd-loc-type-town{--loc-color:#3f9e9a}
.sd-loc-type-village{--loc-color:#5aa469}
.sd-loc-type-pass{--loc-color:#c9772f}
.sd-loc-type-temple{--loc-color:#8a6fd1}
.sd-loc-type-mountain{--loc-color:#8a7f6d}
.sd-loc-type-river{--loc-color:#3a9fb8}
.sd-loc-type-sea{--loc-color:#2f6f9e}
.sd-loc-type-other{--loc-color:#8a8a8a}
.sd-world-locations-head{display:flex;align-items:baseline;gap:10px;justify-content:space-between;flex-wrap:wrap;margin-bottom:8px}
.sd-world-locations-head .sd-h3{margin:0}
.sd-loc-table{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;overflow:hidden}
.sd-loc-row{display:grid;grid-template-columns:minmax(120px,1.4fr) 100px 96px 60px 90px 120px;gap:8px;align-items:center;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#eee);font-size:12px}
.sd-loc-row:last-child{border-bottom:0}
.sd-loc-row-head{background:var(--dsw-alias-bg-layer-1,#f6f6f6);color:var(--dsw-alias-label-secondary,#666);font-size:11px;font-weight:600}
.sd-loc-row-focus{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 7%,transparent)}
.sd-loc-name{border:0;background:transparent;padding:0;font:inherit;font-weight:600;color:var(--dsw-alias-label-primary,#111);cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-loc-name:hover{color:var(--dsw-alias-brand-primary,#247bbf)}
.sd-loc-type,.sd-loc-coords,.sd-loc-connections,.sd-loc-first{color:var(--dsw-alias-label-secondary,#666);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-loc-type{display:flex;align-items:center;gap:5px}
.sd-loc-dot{width:9px;height:9px;border-radius:50%;background:var(--loc-color,#8fa8bd);display:inline-block;flex:0 0 auto}
.sd-loc-actions{display:flex;gap:6px;justify-content:flex-end}
.sd-loc-editor-body{display:flex;flex-direction:column;gap:10px}
.sd-loc-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0 14px}
.sd-loc-conn-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:10px}
.sd-loc-conn-head .sd-h3{margin:0}
.sd-loc-conn-list{display:flex;flex-direction:column;gap:6px}
.sd-loc-conn-row{display:grid;grid-template-columns:minmax(120px,1fr) 100px 84px 92px minmax(90px,1fr) 32px;gap:8px;align-items:center}
.sd-loc-conn-row .sd-input{padding:5px 7px;font-size:11.5px;min-width:0}
.sd-htmlview{display:flex;flex-direction:column;max-height:92vh}
.sd-htmlview-body{flex:1;min-height:0;padding:10px 12px;display:flex}
.sd-htmlview-frame{flex:1;width:100%;min-height:min(72vh,720px);border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:9px;background:var(--dsw-alias-bg-base,#fff)}
.sd-htmlview-foot{display:flex;align-items:center;justify-content:space-between;gap:10px}
.sd-create-world{margin-top:14px;border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:12px}
.sd-create-world .sd-h3{margin:0 0 8px}
.sd-create-world-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0 14px}
.sd-create-world-toggle{margin-top:4px}
.sd-create-world-hint{margin:6px 0 0}
.sd-pano-loc{font-size:10.5px;color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.sd-pano-location{display:inline-flex;align-items:center;gap:6px}
.sd-pano-location-select{width:auto;min-width:130px}

/* v0.6：一号原则 ⚡ ATTENTION IS ALL YOU NEED */
.sd-principle-bar{display:flex;align-items:center;gap:14px;padding:5px 16px;min-height:34px;box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2,#e5e5e5);background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 9%,transparent),transparent 65%),var(--dsw-alias-bg-layer-1,#fafafa);font-size:11.5px;line-height:1.4;flex:0 0 auto;overflow:hidden}
.sd-principle-main{display:flex;align-items:baseline;gap:10px;min-width:0;flex:0 1 auto;overflow:hidden}
.sd-principle-slogan{font-weight:700;color:var(--dsw-alias-brand-primary,#247bbf);letter-spacing:.02em;white-space:nowrap}
.sd-principle-sub{color:var(--dsw-alias-label-secondary,#666);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-principle-hint{margin-left:auto;color:var(--dsw-alias-label-tertiary,#888);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-principle-hero{display:grid;grid-template-columns:minmax(220px,1.1fr) minmax(320px,1.4fr);gap:14px 20px;align-items:center;padding:16px 18px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 35%,transparent);border-left:4px solid var(--dsw-alias-brand-primary,#247bbf);border-radius:14px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 14%,transparent),transparent 62%),var(--dsw-alias-bg-layer-1,#fcfcfc);box-shadow:0 1px 3px rgba(0,0,0,.05)}
.sd-principle-hero-main{display:flex;flex-direction:column;gap:4px;min-width:0}
.sd-principle-hero-slogan{margin:0;font-size:22px;line-height:1.2;font-weight:800;letter-spacing:.02em;color:var(--dsw-alias-brand-primary,#247bbf)}
.sd-principle-hero-sub{margin:0;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#333)}
.sd-principle-hero-hint{margin:2px 0 0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#666)}
.sd-principle-hero-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.sd-principle-hero-stat{padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:10px;background:var(--dsw-alias-bg-base,#fff);min-width:0}
.sd-principle-hero-label{font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.sd-principle-hero-value{margin-top:2px;font-size:22px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#111)}
.sd-principle-hero-value-empty{color:var(--dsw-alias-label-tertiary,#999)}
.sd-principle-hero-unit{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary,#888);margin-left:1px}
.sd-principle-hero-list{display:flex;flex-direction:column;gap:1px;margin-top:2px;font-size:11.5px;font-variant-numeric:tabular-nums}
.sd-principle-hero-list-item{color:var(--dsw-alias-label-primary,#333);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-principle-hero-stat-hint{margin-top:3px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888)}
.sd-principle-hero-actions{grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap}
.sd-principle-inline{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:6px 0 0;padding:6px 10px;border-left:3px solid var(--dsw-alias-brand-primary,#247bbf);border-radius:0 7px 7px 0;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 7%,transparent);font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#555)}
.sd-principle-inline strong{color:var(--dsw-alias-brand-primary,#247bbf);font-size:12px;letter-spacing:.02em;white-space:nowrap}
.sd-principle-inline span{min-width:0}

/* v0.6：📚 整本书流水线 */
.sd-pipe-status-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:12px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 7%,transparent),transparent 60%),var(--dsw-alias-bg-layer-1,#fcfcfc)}
.sd-pipe-status-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sd-pipe-status-chip{display:inline-flex;align-items:center;padding:0 9px;border-radius:999px;font-size:10.5px;line-height:19px;font-weight:600;border:1px solid var(--dsw-alias-border-l2,#ddd);background:var(--dsw-alias-bg-layer-2,#f4f4f4);color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.sd-pipe-status-preparing,.sd-pipe-status-ready{color:var(--dsw-alias-brand-primary,#247bbf);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 10%,transparent)}
.sd-pipe-status-running,.sd-pipe-status-done{color:var(--dsw-alias-state-success-primary,#1e8449);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 10%,transparent)}
.sd-pipe-status-paused,.sd-pipe-status-stuck{color:var(--dsw-alias-state-warn-primary,#d68910);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 10%,transparent)}
.sd-pipe-status-aborted{color:var(--dsw-alias-state-error-primary,#c0392b);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 10%,transparent)}
.sd-pipe-status-mode{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#222)}
.sd-pipe-status-target,.sd-pipe-status-session{font-size:11px;color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.sd-pipe-status-session{margin-left:auto}
.sd-pipe-status-meta{display:flex;gap:6px 16px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary,#666)}
.sd-pipe-actions{display:flex;gap:8px;flex-wrap:wrap}
.sd-pipe-progress{display:flex;flex-direction:column;gap:4px}
.sd-pipe-progress-head{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.sd-pipe-progress-bar{height:7px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-secondary,#888) 16%,transparent);overflow:hidden}
.sd-pipe-progress-fill{height:100%;border-radius:4px;background:var(--dsw-alias-brand-primary,#247bbf);transition:width .2s ease}
.sd-pipe-progress-danger{background:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-pipe-banner{padding:8px 11px;border-radius:9px;font-size:12px;line-height:1.6;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);background:var(--dsw-alias-bg-layer-1,#fafafa);color:var(--dsw-alias-label-primary,#333)}
.sd-pipe-banner-done{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 10%,transparent)}
.sd-pipe-banner-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 9%,transparent)}
.sd-pipe-banner-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 9%,transparent)}
.sd-pipe-budget,.sd-pipe-stages,.sd-pipe-notes{padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fcfcfc)}
.sd-pipe-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}
.sd-pipe-section-head .sd-h3{margin:0 0 6px}
.sd-pipe-budget-row{display:grid;grid-template-columns:52px minmax(120px,190px) minmax(0,1fr);gap:10px;align-items:center;font-size:11.5px;margin-top:6px}
.sd-pipe-budget-label{color:var(--dsw-alias-label-secondary,#666)}
.sd-pipe-budget-value{color:var(--dsw-alias-label-primary,#333);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-pipe-budget-bar{height:7px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-secondary,#888) 16%,transparent);overflow:hidden}
.sd-pipe-budget-fill{height:100%;border-radius:4px;background:var(--dsw-alias-brand-primary,#247bbf);transition:width .2s ease}
.sd-pipe-budget-fill.sd-pipe-budget-warn,.sd-pipe-budget-summary.sd-pipe-budget-warn{background:var(--dsw-alias-state-warn-primary,#d68910)}
.sd-pipe-budget-fill.sd-pipe-budget-danger,.sd-pipe-budget-summary.sd-pipe-budget-danger{background:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-pipe-budget-summary{margin-top:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#666);padding:4px 8px;border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f4f4f4)}
.sd-pipe-budget-summary.sd-pipe-budget-warn{color:var(--dsw-alias-label-primary,#222);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 14%,transparent)}
.sd-pipe-budget-summary.sd-pipe-budget-danger{color:var(--dsw-alias-label-primary,#222);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 12%,transparent)}
/* 收尾清理 */
.sd-pipe-banner-info{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 8%,transparent)}
.sd-pipe-cleanup-banner{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.sd-pipe-cleanup{padding:12px 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 35%,transparent);border-radius:12px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 8%,transparent),transparent 65%),var(--dsw-alias-bg-layer-1,#fcfcfc)}
.sd-pipe-cleanup-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:6px}
.sd-pipe-cleanup-stat{padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:9px;background:var(--dsw-alias-bg-base,#fff)}
.sd-pipe-cleanup-value{font-size:20px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#111)}
.sd-pipe-cleanup-label{font-size:10.5px;color:var(--dsw-alias-label-secondary,#666);margin-top:2px}
.sd-pipe-cleanup-hint{margin:8px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary,#555)}
.sd-pipe-cleanup-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.sd-pipe-cleanup-failed{margin-top:6px;font-size:11.5px}
.sd-pipe-cleanup-failed summary{cursor:pointer;color:var(--dsw-alias-state-warn-primary,#d68910)}
.sd-pipe-cleanup-failed-list{display:flex;flex-direction:column;gap:2px;margin-top:4px;max-height:160px;overflow:auto;color:var(--dsw-alias-label-secondary,#666)}
.sd-pipe-cleanup-failed-item{line-height:1.6;word-break:break-word}
@media (max-width:760px){.sd-pipe-cleanup-grid{grid-template-columns:1fr 1fr}.sd-pipe-cleanup-banner{align-items:flex-start}}
.sd-pipe-stage-list{display:flex;flex-direction:column;gap:2px}
.sd-pipe-stage{display:grid;grid-template-columns:22px minmax(120px,1fr) auto auto;gap:8px;align-items:center;padding:5px 8px;border-radius:7px;font-size:12px}
.sd-pipe-stage-current{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 8%,transparent)}
.sd-pipe-stage-icon{width:20px;text-align:center;color:var(--dsw-alias-label-tertiary,#999)}
.sd-pipe-stage-done .sd-pipe-stage-icon{color:var(--dsw-alias-state-success-primary,#1e8449)}
.sd-pipe-stage-running .sd-pipe-stage-icon{color:var(--dsw-alias-brand-primary,#247bbf)}
.sd-pipe-stage-failed .sd-pipe-stage-icon{color:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-pipe-stage-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#333)}
.sd-pipe-stage-range{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap}
.sd-pipe-empty{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}
.sd-pipe-note-list{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow:auto}
.sd-pipe-note{display:flex;gap:10px;padding:4px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,#eee);font-size:11.5px;line-height:1.55}
.sd-pipe-note:last-child{border-bottom:0}
.sd-pipe-note-time{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}
.sd-pipe-note-text{min-width:0;color:var(--dsw-alias-label-secondary,#555);white-space:pre-wrap;word-break:break-word}
.sd-pipe-prepared-hint{margin:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#888)}
.sd-pipe-wizard-body{display:flex;flex-direction:column;gap:14px}
.sd-pipe-wizard-section{border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:10px}
.sd-pipe-wizard-section:first-child{border-top:0;padding-top:0}
.sd-pipe-wizard-section .sd-h3{margin:0 0 8px}
.sd-pipe-wizard-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0 14px}
.sd-pipe-wizard-hint{margin:6px 0 0}
.sd-pipe-wizard-total{display:flex;gap:8px 14px;flex-wrap:wrap;margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}
.sd-pipe-wizard-warn{margin:8px 0 0;padding:6px 10px;border-radius:8px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-primary,#333);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 10%,transparent)}
.sd-pipe-wizard-state{display:flex;flex-direction:column;gap:2px;border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2);padding-top:8px}
.sd-pipe-wizard-actions{flex-wrap:wrap;gap:8px}
.sd-pipe-overview{display:flex;flex-direction:column;gap:6px}
.sd-pipe-overview-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sd-pipe-overview-head .sd-h3{margin:0}
.sd-pipe-overview-head .sd-btn{margin-left:auto}
.sd-pipe-overview-metrics{display:flex;gap:6px 16px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary,#666)}
/* 整本书子导航 + ✍️ 扩写面板 */
.sd-pipe-subnav{display:flex;align-items:center;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2,#e2e2e2);padding-bottom:2px}
.sd-pipe-subtab{border:0;background:transparent;padding:6px 14px;border-radius:8px 8px 0 0;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;white-space:nowrap}
.sd-pipe-subtab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#111)}
.sd-pipe-subtab-active{color:var(--dsw-alias-brand-primary,#247bbf);font-weight:600;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 10%,transparent)}
.sd-exp-panel{display:flex;flex-direction:column;gap:12px}
.sd-exp-head{display:flex;align-items:flex-start;gap:12px;justify-content:space-between;flex-wrap:wrap}
.sd-exp-head .sd-h3{margin:0 0 4px}
.sd-exp-status{display:inline-flex;align-items:center;padding:0 9px;border-radius:999px;font-size:10.5px;line-height:20px;font-weight:600;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2,#ddd);background:var(--dsw-alias-bg-layer-2,#f4f4f4);color:var(--dsw-alias-label-secondary,#666)}
.sd-exp-status-planning,.sd-exp-status-plan-ready,.sd-exp-status-structuring{color:var(--dsw-alias-brand-primary,#247bbf);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 10%,transparent)}
.sd-exp-status-running,.sd-exp-status-done{color:var(--dsw-alias-state-success-primary,#1e8449);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 10%,transparent)}
.sd-exp-status-waiting-outline,.sd-exp-status-paused,.sd-exp-status-stuck{color:var(--dsw-alias-state-warn-primary,#d68910);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 10%,transparent)}
.sd-exp-config,.sd-exp-section,.sd-exp-budget{padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fcfcfc)}
.sd-exp-config{display:flex;flex-direction:column;gap:2px}
.sd-exp-section + .sd-exp-section{margin-top:8px}
.sd-exp-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}
.sd-exp-section-head .sd-h3{margin:0 0 6px}
.sd-exp-mode{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.sd-exp-chapter-pick{display:inline-flex;align-items:center;gap:6px}
.sd-exp-chapter-pick .sd-input{min-width:180px}
.sd-exp-target-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sd-exp-target-row .sd-input{max-width:220px}
.sd-exp-required{margin:6px 0 0;font-size:11.5px;color:var(--dsw-alias-state-warn-primary,#d68910)}
.sd-exp-additions{display:flex;align-items:center;gap:8px 14px;flex-wrap:wrap}
.sd-exp-additions-limit{display:inline-flex;align-items:center;gap:6px}
.sd-exp-additions-limit .sd-input{width:86px}
.sd-exp-outline-toggle{flex:1 1 100%}
.sd-exp-config-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0 14px}
.sd-exp-budget-row{display:grid;grid-template-columns:52px minmax(120px,190px) minmax(0,1fr);gap:10px;align-items:center;font-size:11.5px;margin-top:6px}
.sd-exp-budget-label{color:var(--dsw-alias-label-secondary,#666)}
.sd-exp-budget-value{color:var(--dsw-alias-label-primary,#333);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-exp-budget-bar{height:7px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-secondary,#888) 16%,transparent);overflow:hidden}
.sd-exp-budget-fill{height:100%;border-radius:4px;background:var(--dsw-alias-brand-primary,#247bbf);transition:width .2s ease}
.sd-exp-budget-fill.sd-exp-budget-warn{background:var(--dsw-alias-state-warn-primary,#d68910)}
.sd-exp-budget-fill.sd-exp-budget-danger{background:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-exp-budget-hint{margin:8px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}
.sd-exp-budget-hint.sd-exp-budget-warn{color:var(--dsw-alias-state-warn-primary,#d68910)}
.sd-exp-budget-hint.sd-exp-budget-danger{color:var(--dsw-alias-state-error-primary,#c0392b)}
.sd-exp-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sd-exp-banner{padding:8px 11px;border-radius:9px;font-size:12px;line-height:1.6;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);background:var(--dsw-alias-bg-layer-1,#fafafa);color:var(--dsw-alias-label-primary,#333)}
.sd-exp-banner-info{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 8%,transparent)}
.sd-exp-banner-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 9%,transparent)}
.sd-exp-banner-done{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 10%,transparent)}
.sd-exp-progress{display:flex;flex-direction:column;gap:4px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:11px;background:var(--dsw-alias-bg-layer-1,#fcfcfc)}
.sd-exp-progress-head{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.sd-exp-progress-bar{height:7px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-secondary,#888) 16%,transparent);overflow:hidden}
.sd-exp-progress-fill{height:100%;border-radius:4px;background:var(--dsw-alias-brand-primary,#247bbf);transition:width .2s ease}
.sd-exp-table{border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:9px;overflow:hidden}
.sd-exp-tr{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#eee);font-size:12px}
.sd-exp-tr:last-child{border-bottom:0}
.sd-exp-tr-head{background:var(--dsw-alias-bg-layer-1,#f6f6f6);color:var(--dsw-alias-label-secondary,#666);font-size:11px;font-weight:600}
.sd-exp-tr span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-exp-target-input{width:100%;padding:4px 6px;font-size:11.5px;box-sizing:border-box}
.sd-exp-meta-row{display:flex;align-items:center;gap:8px 14px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}
.sd-exp-list{display:flex;flex-direction:column;gap:3px}
.sd-exp-li{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,#555);padding-left:14px;position:relative}
.sd-exp-li:before{content:"·";position:absolute;left:4px;color:var(--dsw-alias-label-tertiary,#999)}
.sd-exp-note-list{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto}
.sd-exp-note{display:flex;gap:10px;padding:4px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,#eee);font-size:11.5px;line-height:1.55}
.sd-exp-note:last-child{border-bottom:0}
.sd-exp-note-time{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}
.sd-exp-note-text{min-width:0;color:var(--dsw-alias-label-secondary,#555);white-space:pre-wrap;word-break:break-word}
.sd-exp-report{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.sd-exp-report-stat{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:9px;background:var(--dsw-alias-bg-base,#fff)}
.sd-exp-report-label{font-size:10.5px;color:var(--dsw-alias-label-secondary,#666)}
.sd-exp-report-value{font-size:19px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#111)}
.sd-exp-empty{margin:4px 0;font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}
/* 待确认区块 + 大纲变更勾选 + 子导航徽标 */
.sd-exp-confirm{padding:12px 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 45%,transparent);border-radius:12px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d68910) 10%,transparent),transparent 70%),var(--dsw-alias-bg-layer-1,#fcfcfc)}
.sd-exp-confirm-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}
.sd-exp-confirm-head .sd-h3{margin:0 0 6px}
.sd-exp-confirm-list{display:flex;flex-direction:column;gap:6px}
.sd-exp-confirm-item{padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:9px;background:var(--dsw-alias-bg-base,#fff)}
.sd-exp-confirm-question{font-size:12.5px;line-height:1.6;font-weight:600;color:var(--dsw-alias-label-primary,#222);word-break:break-word}
.sd-exp-confirm-impact{margin-top:2px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#666);word-break:break-word}
.sd-exp-confirm-options{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.sd-exp-confirm-fallback{border-style:dashed}
.sd-exp-confirm-empty{margin:4px 0;font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}
.sd-exp-confirm-footer{margin:8px 0 0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#555)}
.sd-exp-outline-confirm{margin-top:10px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l2,#e2e2e2)}
.sd-exp-outline-confirm-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.sd-exp-outline-confirm-head .sd-h3{margin:0 0 6px}
.sd-exp-outline-bulk{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
.sd-exp-outline-list{display:flex;flex-direction:column;gap:4px}
.sd-exp-outline-row{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:8px;align-items:flex-start;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:9px;background:var(--dsw-alias-bg-base,#fff);cursor:pointer}
.sd-exp-outline-row-readonly{cursor:default}
.sd-exp-outline-row-approved{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1e8449) 6%,var(--dsw-alias-bg-base,#fff))}
.sd-exp-outline-row input[type="checkbox"]{margin-top:3px}
.sd-exp-outline-checkmark{margin-top:2px;text-align:center;color:var(--dsw-alias-label-tertiary,#888);font-size:12px}
.sd-exp-outline-row-approved .sd-exp-outline-checkmark{color:var(--dsw-alias-state-success-primary,#1e8449)}
.sd-exp-outline-main{min-width:0}
.sd-exp-outline-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;font-weight:600;line-height:1.6;color:var(--dsw-alias-label-primary,#222);word-break:break-word}
.sd-exp-outline-meta{margin-top:2px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#666);word-break:break-word}
.sd-exp-badge{display:inline-flex;align-items:center;margin-left:6px;padding:0 6px;border-radius:999px;font-size:10px;line-height:17px;font-weight:700;color:var(--dsw-alias-state-error-primary,#c0392b);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 12%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 45%,transparent)}
@media (max-width:760px){.sd-pipe-subnav{overflow-x:auto}.sd-exp-budget-row{grid-template-columns:48px minmax(90px,1fr)}.sd-exp-budget-bar{grid-column:1/-1}.sd-exp-config-grid{grid-template-columns:1fr 1fr}.sd-exp-table{overflow-x:auto}.sd-exp-tr{min-width:420px}.sd-exp-actions .sd-btn{flex:1 1 auto}.sd-exp-status{margin-left:0}.sd-exp-outline-row{grid-template-columns:18px minmax(0,1fr)}.sd-exp-outline-row>.sd-tag{grid-column:2;justify-self:start}}
@media (max-width:760px){.sd-pipe-budget-row{grid-template-columns:48px minmax(90px,1fr)}.sd-pipe-budget-bar{grid-column:1/-1}.sd-pipe-stage{grid-template-columns:20px minmax(80px,1fr) auto}.sd-pipe-stage-range{display:none}.sd-pipe-actions .sd-btn{flex:1 1 auto}.sd-pipe-overview-head .sd-btn{margin-left:0}.sd-pipe-status-session{margin-left:0}}
@media (max-width:900px){.sd-principle-bar .sd-principle-hint{display:none}.sd-principle-hero{grid-template-columns:1fr}.sd-principle-hero-actions{grid-column:auto}}
@media (max-width:760px){.sd-principle-bar .sd-principle-sub{display:none}.sd-principle-hero{padding:12px 14px}.sd-principle-hero-slogan{font-size:18px}.sd-principle-hero-stats{grid-template-columns:1fr 1fr}.sd-principle-inline{gap:4px}}
@media (max-width:900px){.sd-loc-row{grid-template-columns:minmax(100px,1.2fr) 90px 60px 120px}.sd-loc-row>:nth-child(3),.sd-loc-row>:nth-child(5){display:none}.sd-loc-conn-row{grid-template-columns:minmax(100px,1fr) 88px 70px 84px}.sd-loc-conn-row>:nth-child(5){display:none}.sd-world-svg{height:min(62vh,520px)}}
@media (max-width:760px){.sd-loc-row{grid-template-columns:minmax(80px,1fr) 84px 110px}.sd-loc-row>:nth-child(3),.sd-loc-row>:nth-child(4),.sd-loc-row>:nth-child(5){display:none}.sd-loc-conn-row{grid-template-columns:1fr 1fr}.sd-loc-conn-row>:nth-child(5){display:block}.sd-world-settings-grid{grid-template-columns:1fr 1fr}.sd-world-svg{height:min(58vh,440px)}}
@media (max-width:900px){.sd-map-row{grid-template-columns:repeat(6,minmax(0,1fr));min-width:0}.sd-map-stat-cover{grid-column:span 1}.sd-map-cover{grid-template-columns:1fr}}
@media (max-width:760px){.sd-mapnode-chapter{font-size:16px}.sd-map-board{padding:8px}.sd-map-row{gap:6px}.sd-map-legend{gap:6px 10px}}
@media (max-width:760px){.sd-char-row,.sd-char-fact-row,.sd-pano-row{flex-direction:column;gap:2px;align-items:flex-start}.sd-conf-actions,.sd-fore-actions{margin-left:0;width:100%;justify-content:flex-start}.sd-pano-att{margin-left:0}}
@media (max-width: 900px){.sd-att-ov{grid-template-columns:1fr 1fr}.sd-att-ov-bigwrap{grid-column:1/-1;border-right:0;padding-right:0;border-bottom:1px solid var(--dsw-alias-border-l2,#eee);padding-bottom:8px}}
@media (max-width: 760px){.sd-att-ov{grid-template-columns:1fr}.sd-att-card-actions{margin-left:0}}
@media (max-width: 760px){.sd-fresh-actions{flex-direction:column;align-items:stretch}.sd-fresh-pick{flex-direction:column;align-items:flex-start}.sd-fresh-select{width:100%;max-width:none}.sd-fresh-compact .sd-btn{margin-left:0;width:100%}}
@media (max-width: 900px){.sd-two-col{grid-template-columns:1fr}.sd-form-2{grid-template-columns:1fr}.sd-dash-grid{grid-template-columns:1fr}.sd-nav{width:120px}}
`

    // ── 插件挂载 ──────────────────────────────────────────────
    return {
      inject: ['slots'],
      apply(ctx) {
        clientCtx = ctx
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-story-desk'
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'story-desk: styles')

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register({ name: 'sidebar.footer.action', id: 'story-desk', order: 40, label: '长篇中文小说工作台' }, SidebarEntry),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'story-desk', order: 60, label: '长篇中文小说工作台' }, Workbench),
        )
      },
    }
  },
})
