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
      if (target && value?.sessionId) {
        try {
          clientCtx?.get?.('uiWorkspace')?.openSession(value.sessionId)
        } catch {
          // 新会话已创建并收到消息；打不开视图也不丢
        }
      }
      return value
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
        desc: '人物卡：目标、动机、缺陷、弧光、关系。章节里引用但未建卡的人物会被提示。',
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
          { k: 'dimension', t: '维度', type: 'select', options: [['情节', '情节'], ['人物', '人物'], ['文笔', '文笔'], ['连续性', '连续性'], ['节奏', '节奏'], ['对话', '对话'], ['世界观', '世界观'], ['主题', '主题']] },
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
        desc: '9 个角色的职责与输入输出。总编派单，各角色按契约产出，审稿与写作上下文都会带上这份分工。',
        columns: [
          { k: 'order', t: '#', w: '40px' },
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

    const TABS = [
      { id: 'overview', label: '总览', icon: '📊' },
      { id: 'dashboard', label: '仪表盘', icon: '📈' },
      { id: 'chapters', label: '章节', icon: '📄' },
      { id: 'timeline', label: '时间线', icon: '🕰️' },
      { id: 'facts', label: '事实账本', icon: '⚖️' },
      { id: 'foreshadow', label: '伏笔', icon: '🧩' },
      { id: 'conflicts', label: '冲突', icon: '⚔️' },
      { id: 'characters', label: '人物', icon: '👤' },
      { id: 'highlights', label: '高光', icon: '✨' },
      { id: 'reviews', label: '审稿', icon: '📝' },
      { id: 'proposals', label: '提案', icon: '📥' },
      { id: 'alignment', label: '对齐', icon: '🎯' },
      { id: 'agents', label: '分工', icon: '🤖' },
      { id: 'presets', label: '预设', icon: '🎛️' },
      { id: 'settings', label: '设置', icon: '⚙️' },
    ]

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

    // ── 通用数据页 ─────────────────────────────────────────────
    function EntityTab({ kind, bundle, projectId, onChanged, onAddCart }) {
      const meta = KIND_META[kind]
      const [editing, setEditing] = useState(null)
      const [mode, setMode] = useState('list')
      const items = bundle[kind] ?? []
      const isCharacters = kind === 'characters'
      const grid = meta.columns.map((c) => c.w || '1fr').join(' ') + ' 96px'

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
            isCharacters ? h(ViewToggle, { value: mode, onChange: setMode, options: [{ value: 'list', label: '列表' }, { value: 'graph', label: '关系图' }] }) : null,
            onAddCart && ['characters', 'foreshadow', 'highlights', 'facts', 'events', 'conflicts', 'outlines'].includes(kind)
              ? h(Btn, { onClick: () => onAddCart({ kind: 'task', id: `enrich-${kind}`, task: `enrich-${kind}`, title: `AI 丰富${meta.title}` }) }, `＋ 加入清单：AI 丰富${meta.title}`)
              : null,
            h(Btn, { kind: 'primary', onClick: () => setEditing({}) }, '＋ 新增'),
          ),
        ),
        isCharacters && mode === 'graph'
          ? h(RelationshipGraph, { characters: items, onEdit: (item) => setEditing(item), onCreate: (name) => setEditing({ name }) })
          : items.length === 0
          ? h(Empty, null, `还没有${meta.title}记录。点右上角「新增」开始。`)
          : h(
              'div',
              { className: 'sd-table' },
              h('div', { className: 'sd-row sd-row-head', style: { gridTemplateColumns: grid } }, meta.columns.map((c) => h('div', { key: c.k }, c.t)), h('div', { className: 'sd-actions-col' }, '操作')),
              items.map((item) =>
                h(
                  'div',
                  { key: item.id, className: 'sd-row', style: { gridTemplateColumns: grid } },
                  meta.columns.map((c) => {
                    const text = c.format ? String(c.format(item[c.k], item)) : displayValue(c.k, item[c.k])
                    return h('div', { key: c.k, className: 'sd-cell', title: text }, text)
                  }),
                  h(
                    'div',
                    { className: 'sd-row-actions' },
                    h(Btn, { small: true, onClick: () => setEditing(item) }, '编辑'),
                    h(Btn, { small: true, kind: 'danger', onClick: () => remove(item) }, '删除'),
                  ),
                ),
              ),
            ),
        editing !== null ? h(EntityEditor, { kind, item: editing, projectId, onClose: () => setEditing(null), onSaved: onChanged }) : null,
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

    function ChaptersTab({ bundle, projectId, onChanged, initialView = 'chapters' }) {
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
        editing !== null ? h(ChapterEditor, { chapter: editing, projectId, onClose: () => setEditing(null), onSaved: onChanged }) : null,
        outlineEditing !== null ? h(EntityEditor, { kind: 'outlines', item: outlineEditing, projectId, onClose: () => setOutlineEditing(null), onSaved: onChanged }) : null,
      )
    }

    function ChapterEditor({ chapter, projectId, onClose, onSaved }) {
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
    function TimelineTab({ bundle, projectId, onChanged }) {
      const [editing, setEditing] = useState(null)
      const [mode, setMode] = useState('list')
      const events = [...(bundle.events ?? [])].sort((a, b) => (Number(a.chapter) || 0) - (Number(b.chapter) || 0))
      return h(
        'div',
        { className: 'sd-page' },
        h(
          'div',
          { className: 'sd-pagehead' },
          h('div', null, h('h2', { className: 'sd-h2' }, '🕰️ 时间线'), h('p', { className: 'sd-desc' }, '按章排列的事件流。故事内时间用于排序与检查；泳道视图按卷或每 20 章分道，并画出伏笔埋收弧线。')),
          h(
            'div',
            { className: 'sd-pagehead-actions' },
            h(ViewToggle, { value: mode, onChange: setMode, options: [{ value: 'list', label: '列表' }, { value: 'lane', label: '泳道' }] }),
            h(Btn, { kind: 'primary', onClick: () => setEditing({}) }, '＋ 新增事件'),
          ),
        ),
        mode === 'lane'
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

    function OverviewTab({ bundle, projectId, onChanged, onAddCart, cartCount = 0, onOpenCart }) {
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
        h('div', { className: 'sd-pagehead' },
          h('div', null, h('h2', { className: 'sd-h2' }, '📖 ' + bundle.project.name), h('p', { className: 'sd-desc' }, bundle.project.logline || '还没有一句话简介。')),
          h('div', { className: 'sd-pagehead-actions' },
            h(Btn, { kind: 'primary', onClick: () => onAddCart({ kind: 'task', id: 'full-review', title: '从头审阅整个项目', task: 'full-review' }) }, '＋ 加入清单：从头审阅'))),
        h('div', { className: 'sd-cart-banner' },
          h('strong', null, `🧺 清单 ${cartCount} 项`),
          onOpenCart ? h(Btn, { small: true, kind: 'primary', onClick: onOpenCart }, '打开清单') : null),
        h('section', { className: 'sd-section sd-mt' }, h('h3', { className: 'sd-h3' }, '写作仪表盘'), h(WriterStats, { data: dash })),
        h('div', { className: 'sd-cards sd-mt' }, cards.map(([label, value, icon]) => h('div', { key: label, className: 'sd-card' }, h('div', { className: 'sd-card-icon' }, icon), h('div', { className: 'sd-card-value' }, String(value)), h('div', { className: 'sd-card-label' }, label)))),
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
              h(Field, { label: '工作区目录', hint: '「发到对话」只发到这个目录对应的对话；留空会拒绝发送' }, h(TextInput, { value: form.rootPath ?? '', placeholder: '/Users/you/你的小说', onChange: (v) => set('rootPath', v) })),
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
      const [form, setForm] = useState({ name: '', genre: '', logline: '', targetChapters: 0, targetWords: 0 })
      const [busy, setBusy] = useState(false)
      const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))
      const save = async () => {
        if (!String(form.name).trim()) {
          window.alert('请填写作品名')
          return
        }
        setBusy(true)
        try {
          const project = await api('project.create', { input: form })
          onCreated(project.id)
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
        h('div', { className: 'sd-modal' },
          h('div', { className: 'sd-modal-head' }, h('strong', null, '新建作品'), h(IconBtn, { onClick: onClose, title: '关闭' }, '✕')),
          h('div', { className: 'sd-modal-body' }, h('div', { className: 'sd-form' },
            h(Field, { label: '作品名 *' }, h(TextInput, { value: form.name, onChange: (v) => set('name', v), placeholder: '如：长夜将明' })),
            h(Field, { label: '类型' }, h(TextInput, { value: form.genre, onChange: (v) => set('genre', v), placeholder: '武侠 / 科幻 / 悬疑 / 言情…' })),
            h(Field, { label: '一句话简介' }, h(TextArea, { value: form.logline, rows: 2, onChange: (v) => set('logline', v) })),
            h(Field, { label: '目标章数' }, h(TextInput, { value: form.targetChapters, type: 'number', onChange: (v) => set('targetChapters', Number(v) || 0) })),
            h(Field, { label: '目标字数' }, h(TextInput, { value: form.targetWords, type: 'number', onChange: (v) => set('targetWords', Number(v) || 0) })),
          )),
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

    function ProposalTab({ bundle, projectId, onChanged, onAskAi, onAddCart }) {
      const [busy, setBusy] = useState('')
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
        try {
          const value = await api(action === 'accept' ? 'proposal.batchAccept' : 'proposal.batchReject', { projectId, ids })
          const failed = value?.failed ?? []
          const okCount = action === 'accept' ? (value?.accepted?.length ?? 0) : (value?.rejected?.length ?? 0)
          if (failed.length > 0) {
            window.alert(`成功 ${okCount} 条，失败 ${failed.length} 条：\n${failed.map((f) => `${f.id}：${f.error ?? '未知错误'}`).join('\n')}`)
          }
          setSelected([])
          onChanged()
        } catch (error) {
          window.alert(`批量${action === 'accept' ? '采纳' : '驳回'}失败：${error.message}`)
        } finally {
          setBulkBusy(false)
        }
      }
      const act = async (p, action, optionId) => {
        if (!window.confirm(`${action === 'accept' ? '采纳' : '驳回'}提案「${p.title}」？`)) return
        setBusy(p.id)
        try {
          await api(action === 'accept' ? 'proposal.accept' : 'proposal.reject', { projectId, proposalId: p.id, optionId })
          onChanged()
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
      const [fixing, setFixing] = useState('')
      const all = bundle.reviews ?? []
      const severityRank = { blocker: 0, major: 1, minor: 2, suggestion: 3 }
      const items = all
        .filter((review) => severityFilter === 'all' || review.severity === severityFilter)
        .sort((a, b) => {
          const doneA = a.status === 'fixed' || a.status === 'wontfix' ? 1 : 0
          const doneB = b.status === 'fixed' || b.status === 'wontfix' ? 1 : 0
          if (doneA !== doneB) return doneA - doneB
          return (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9)
        })
      const selectedItems = all.filter((review) => selected.includes(review.id))
      const grid = '30px ' + meta.columns.map((c) => c.w || '1fr').join(' ') + ' 96px'
      const toggle = (id) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
      const allSelected = items.length > 0 && items.every((review) => selected.includes(review.id))
      const toggleAll = () => {
        if (allSelected) setSelected((prev) => prev.filter((id) => !items.some((review) => review.id === id)))
        else setSelected((prev) => [...new Set([...prev, ...items.map((review) => review.id)])])
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
      const fixWithAi = async (review) => {
        if (!review.chapter) {
          window.alert('这条审稿没有章号，无法生成修改提案')
          return
        }
        if (!window.confirm(`让 AI 按这条意见修改第 ${review.chapter} 章，并生成提案？\n\n${review.issue ?? ''}`)) return
        setFixing(review.id)
        try {
          await sendToChat({ projectId, task: 'review-fix', reviewId: review.id, chapter: review.chapter })
        } catch (error) {
          window.alert(`发送到对话失败：${error.message}`)
        } finally {
          setFixing('')
        }
      }
      const batch = async (status) => {
        if (selectedItems.length === 0) {
          window.alert('请先勾选审稿意见')
          return
        }
        if (!window.confirm(`把 ${selectedItems.length} 条审稿标记为「${status === 'fixed' ? '已修' : '忽略'}」？`)) return
        setBulkBusy(true)
        try {
          const value = await api('review.batchUpdate', { projectId, ids: selectedItems.map((review) => review.id), status })
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
      return h(
        'div',
        { className: 'sd-page' },
        h(
          'div',
          { className: 'sd-pagehead' },
          h('div', null, h('h2', { className: 'sd-h2' }, meta.icon + ' ' + meta.title), h('p', { className: 'sd-desc' }, meta.desc + ' 支持按严重度筛选、全选后批量标记。')),
          h('div', { className: 'sd-pagehead-actions' },
            h(Btn, { onClick: () => onAddCart({ kind: 'task', id: 'full-review', title: '从头审阅整个项目', task: 'full-review' }) }, '＋ 加入清单：从头审阅'),
            h(Btn, { kind: 'primary', onClick: () => setEditing({}) }, '＋ 新增')),
        ),
        all.length > 0 ? h('div', { className: 'sd-bulkbar' },
          h('label', { className: 'sd-cb' }, h('input', { type: 'checkbox', checked: allSelected, onChange: toggleAll }), '全选'),
          h('span', { className: 'sd-hint' }, `共 ${all.length} 条，当前显示 ${items.length} 条，已选 ${selectedItems.length} 条`),
          h('select', { className: 'sd-input sd-select-inline', value: severityFilter, onChange: (e) => setSeverityFilter(e.target.value) },
            h('option', { value: 'all' }, '全部严重度'),
            [['blocker', '阻断'], ['major', '严重'], ['minor', '一般'], ['suggestion', '建议']].map(([value, label]) => h('option', { key: value, value }, label))),
          h('div', { className: 'sd-bulkbar-actions' },
            h(Btn, { small: true, kind: 'primary', disabled: bulkBusy || selectedItems.length === 0, onClick: () => batch('fixed') }, bulkBusy ? '处理中…' : `标记已修（${selectedItems.length}）`),
            h(Btn, { small: true, disabled: bulkBusy || selectedItems.length === 0, onClick: () => batch('wontfix') }, '忽略'),
          ),
        ) : null,
        items.length === 0
          ? h(Empty, null, all.length === 0 ? '还没有审稿意见。AI 审稿或手动新增都会出现在这里。' : '当前严重度筛选下没有审稿意见。')
          : h('div', { className: 'sd-table' },
              h('div', { className: 'sd-row sd-row-head', style: { gridTemplateColumns: grid } },
                h('div', null, h('input', { type: 'checkbox', checked: allSelected, onChange: toggleAll, title: '全选当前筛选' })),
                meta.columns.map((c) => h('div', { key: c.k }, c.t)),
                h('div', { className: 'sd-actions-col' }, '操作')),
              items.map((review) => h('div', { key: review.id, className: 'sd-row', style: { gridTemplateColumns: grid } },
                h('div', { className: 'sd-row-cb' }, h('input', { type: 'checkbox', checked: selected.includes(review.id), onChange: () => toggle(review.id) })),
                meta.columns.map((c) => {
                  const text = c.format ? String(c.format(review[c.k], review)) : displayValue(c.k, review[c.k])
                  return h('div', { key: c.k, className: 'sd-cell', title: text }, text)
                }),
                h('div', { className: 'sd-row-actions' },
                  onAddCart ? h(Btn, { small: true, onClick: () => onAddCart({ kind: 'review', id: review.id, chapter: review.chapter, title: (review.issue ?? '').slice(0, 50), detail: [review.issue, review.suggestion ? `建议：${review.suggestion}` : ''].filter(Boolean).join('；') }) }, '加入清单') : null,
                  h(Btn, { small: true, onClick: () => setEditing(review) }, '编辑'),
                  h(Btn, { small: true, kind: 'danger', onClick: () => remove(review) }, '删除')),
              )),
            ),
        editing !== null ? h(EntityEditor, { kind: 'reviews', item: editing, projectId, onClose: () => setEditing(null), onSaved: onChanged }) : null,
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
    function CartDialog({ items, projectId, sending, onRemove, onNote, onClose, onSend, defaultTarget = 'current' }) {
      const [allowContinue, setAllowContinue] = useState(false)
      const [target, setTarget] = useState(defaultTarget)
      const [multiAgent, setMultiAgent] = useState(true)
      const [preview, setPreview] = useState('')
      const [busy, setBusy] = useState(false)
      const showPreview = async () => {
        setBusy(true)
        try {
          const value = await api('chat.send', { projectId, items, allowContinue, multiAgent, newSession: target === 'new', dryRun: true })
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
              h('label', { className: 'sd-cb' }, h('input', { type: 'radio', name: 'send-target', checked: target === 'current', onChange: () => setTarget('current') }), '发送到当前对话并执行'),
              h('label', { className: 'sd-cb' }, h('input', { type: 'radio', name: 'send-target', checked: target === 'new', onChange: () => setTarget('new') }), '在本工作区新开对话并执行'),
              h('label', { className: 'sd-cb' }, h('input', { type: 'checkbox', checked: allowContinue, onChange: (e) => setAllowContinue(e.target.checked) }), '允许 AI 连续执行下一步（明确的小步不用每步都问）'),
              h('label', { className: 'sd-cb' }, h('input', { type: 'checkbox', checked: multiAgent, onChange: (e) => setMultiAgent(e.target.checked) }), '按分工派子 Agent（总编拆单 / 多角色执行）')),
            h('div', { className: 'sd-form-actions' },
              h(Btn, { onClick: showPreview, disabled: busy || items.length === 0 }, busy ? '生成中…' : '预览发过去的 Prompt')),
            preview ? h('pre', { className: 'sd-ai-result' }, preview) : null,
          ),
          h('div', { className: 'sd-modal-foot' },
            h(Btn, { onClick: () => !sending && onClose() }, '取消'),
            h(Btn, { kind: 'primary', onClick: () => onSend(allowContinue, target, multiAgent), disabled: sending || items.length === 0 }, sending ? '发送中…' : (target === 'new' ? `新开对话并发送 ${items.length} 项` : `发送 ${items.length} 项到当前对话`)))),
      )
    }

    function ImportDialog({ onClose, onImported, onGo, onAddCart, onOpenCart }) {
      const [path, setPath] = useState('')
      const [split, setSplit] = useState('auto')
      const [scan, setScan] = useState(null)
      const [name, setName] = useState('')
      const [genre, setGenre] = useState('')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [report, setReport] = useState(null)
      const [reviewing, setReviewing] = useState(false)
      const [review, setReview] = useState(null)

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
          if (!name.trim()) {
            const base = (value.root || dir).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '导入作品'
            setName(base)
          }
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
        if (!window.confirm(`导入《${name.trim()}》？\n章节 ${c.chapters ?? 0} ｜ 人物 ${c.characters ?? 0} ｜ 大纲 ${c.outlines ?? 0} ｜ 事件 ${c.events ?? 0} ｜ 事实 ${c.facts ?? 0} ｜ 伏笔 ${c.foreshadow ?? 0} ｜ 预设 ${c.presets ?? 0}`)) return
        setBusy('run')
        try {
          const value = await api('import.run', { path: path.trim(), projectName: name.trim(), genre: genre.trim(), mode: 'new', split })
          if (!value?.projectId) throw new Error('导入没有返回作品 id')
          setReport(value)
          onImported(value.projectId)
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
          h(Field, { label: '类型（可选）' }, h(TextInput, { value: genre, placeholder: '武侠 / 科幻 / 悬疑…', onChange: setGenre }))),
      ) : null

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
                 h(Btn, { key: 'run', kind: 'primary', onClick: doImport, disabled: busy === 'run' || !scan }, busy === 'run' ? '导入中…' : '导入并查看报告')]),
        ),
      )
    }

    // ── 工作台主壳 ────────────────────────────────────────────
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
      const cartKey = projectId ? `story-desk/cart/${projectId}` : ''
      const saveCart = (next) => {
        setCart(next)
        try {
          if (cartKey) window.localStorage.setItem(cartKey, JSON.stringify(next))
        } catch {
          /* ignore */
        }
      }
      const addCart = (item) => {
        if (!item?.id) return
        if (cart.some((row) => row.kind === item.kind && row.id === item.id)) return
        saveCart([...cart, item])
      }
      const removeCart = (item) => saveCart(cart.filter((row) => !(row.kind === item.kind && row.id === item.id)))
      const noteCart = (item, note) => saveCart(cart.map((row) => (row.kind === item.kind && row.id === item.id ? { ...row, note } : row)))
      const sendCart = async (allowContinue, target = 'current', multiAgent = true) => {
        if (cart.length === 0) return
        setSendingCart(true)
        try {
          await sendToChat({ projectId, items: cart, allowContinue, multiAgent, newSession: target === 'new' })
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

      useEffect(() => {
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
      }, [cartKey])

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
            : h('div', { className: 'sd-body' },
                h('nav', { className: 'sd-nav' }, TABS.map((t) => h('button', { key: t.id, type: 'button', className: `sd-nav-item${tab === t.id ? ' sd-nav-active' : ''}`, onClick: () => setTab(t.id) }, h('span', { className: 'sd-nav-icon' }, t.icon), h('span', null, t.label)))),
                h('main', { className: 'sd-main' },
                  tab === 'overview' ? h(OverviewTab, { bundle, projectId, onChanged: () => refresh(projectId), onAddCart: addCart, cartCount: cart.length, onOpenCart: () => setCartOpen(true) }) : null,
                  tab === 'dashboard' ? h(DashboardTab, { bundle, projectId }) : null,
                  tab === 'chapters' ? h(ChaptersTab, { bundle, projectId, onChanged: () => refresh(projectId) }) : null,
                  tab === 'timeline' ? h(TimelineTab, { bundle, projectId, onChanged: () => refresh(projectId) }) : null,
                  ['facts', 'foreshadow', 'conflicts', 'characters', 'highlights', 'agents'].includes(tab)
                    ? h(EntityTab, { key: tab, kind: tab, bundle, projectId, onChanged: () => refresh(projectId), onAddCart: addCart })
                    : null,
                  tab === 'reviews' ? h(ReviewsTab, { bundle, projectId, onChanged: () => refresh(projectId), onAddCart: addCart }) : null,
                  tab === 'presets' ? h(PresetsTab, { bundle, projectId, onChanged: () => refresh(projectId) }) : null,
                  tab === 'proposals' ? h(ProposalTab, { bundle, projectId, onChanged: () => refresh(projectId), onAddCart: addCart, onAskAi: (task) => setAi({ task, chapter: bundle.chapters.length > 0 ? Math.max(...bundle.chapters.map((c) => Number(c.id) || 0)) + 1 : 1 }) }) : null,
                  tab === 'alignment' ? h(AlignmentTab, { bundle, projectId, onChanged: () => refresh(projectId), onAskAi: (task) => setAi({ task, chapter: bundle.chapters.length > 0 ? Math.max(...bundle.chapters.map((c) => Number(c.id) || 0)) + 1 : 1 }) }) : null,
                  tab === 'settings' ? h(SettingsTab, { bundle, projectId, onChanged: () => refresh(projectId), onProjectDeleted: () => { setProjectId(''); refresh('') } }) : null,
                ),
              ),
          creating ? h(CreateProjectDialog, { onClose: () => setCreating(false), onCreated: (id) => { setTab('overview'); refresh(id) } }) : null,
          cartOpen ? h(CartDialog, { items: cart, projectId, sending: sendingCart, onRemove: removeCart, onNote: noteCart, defaultTarget: 'current', onClose: () => setCartOpen(false), onSend: sendCart }) : null,
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
.sd-cb{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#555);cursor:pointer;white-space:nowrap}
.sd-cb input{width:13px;height:13px;accent-color:var(--dsw-alias-brand-primary,#247bbf);cursor:pointer;margin:0}
.sd-cb-only{padding:0}
.sd-row-cb{display:flex;align-items:center;justify-content:center}
.sd-row-cb input{width:13px;height:13px;accent-color:var(--dsw-alias-brand-primary,#247bbf);cursor:pointer;margin:0}
.sd-select-inline{width:auto;min-width:110px}
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
