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
        ],
        fields: [
          { k: 'subject', t: '主体', type: 'text', required: true, ph: '人物 / 地点 / 组织 / 物品' },
          { k: 'attribute', t: '属性', type: 'text', required: true, ph: '年龄 / 身份 / 持有物 / 所在地' },
          { k: 'value', t: '取值', type: 'text', required: true },
          { k: 'chapter', t: '首次出现章', type: 'number' },
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
          await api('entity.upsert', { projectId, kind, item: form })
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
    function EntityTab({ kind, bundle, projectId, onChanged }) {
      const meta = KIND_META[kind]
      const [editing, setEditing] = useState(null)
      const items = bundle[kind] ?? []
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
          h(Btn, { kind: 'primary', onClick: () => setEditing({}) }, '＋ 新增'),
        ),
        items.length === 0
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
                    const text = c.format ? String(c.format(item[c.k])) : displayValue(c.k, item[c.k])
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
    function ChaptersTab({ bundle, projectId, onChanged }) {
      const [editing, setEditing] = useState(null)
      const chapters = bundle.chapters ?? []

      const remove = async (chapter) => {
        if (!window.confirm(`删除第 ${chapter.id} 章《${chapter.title}》？`)) return
        try {
          await api('chapter.delete', { projectId, chapterId: chapter.id })
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
          h('div', null, h('h2', { className: 'sd-h2' }, '📄 章节'), h('p', { className: 'sd-desc' }, `共 ${chapters.length} 章，${bundle.stats.words} 字。章节正文保存为 projects/<id>/chapters/NNNN.md。`)),
          h(Btn, { kind: 'primary', onClick: () => setEditing({}) }, '＋ 新建章节'),
        ),
        chapters.length === 0
          ? h(Empty, null, '还没有章节。新建一章，或让 Agent 调用 story_desk_upsert 前先建章节。')
          : h(
              'div',
              { className: 'sd-chapter-list' },
              chapters.map((chapter) =>
                h(
                  'div',
                  { key: chapter.id, className: 'sd-chapter' },
                  h('div', { className: 'sd-chapter-id' }, chapter.id),
                  h(
                    'div',
                    { className: 'sd-chapter-main', onClick: () => setEditing(chapter) },
                    h('div', { className: 'sd-chapter-title' }, chapter.title),
                    h('div', { className: 'sd-chapter-meta' }, `${chapter.words} 字 ｜ ${STATUS_LABEL[chapter.status] || chapter.status}${chapter.storyTime ? ' ｜ ' + chapter.storyTime : ''}${chapter.summary ? ' ｜ ' + chapter.summary : ''}`),
                  ),
                  h('div', { className: 'sd-chapter-actions' }, h(Btn, { small: true, onClick: () => setEditing(chapter) }, '打开'), h(Btn, { small: true, kind: 'danger', onClick: () => remove(chapter) }, '删除')),
                ),
              ),
            ),
        editing !== null ? h(ChapterEditor, { chapter: editing, projectId, onClose: () => setEditing(null), onSaved: onChanged }) : null,
      )
    }

    function ChapterEditor({ chapter, projectId, onClose, onSaved }) {
      const [form, setForm] = useState(() => ({ ...chapter }))
      const [busy, setBusy] = useState(false)
      const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))
      const words = React.useMemo(() => {
        const text = String(form.content ?? '')
        const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length
        const latin = (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length
        return cjk + latin
      }, [form.content])

      const save = async () => {
        setBusy(true)
        try {
          await api('chapter.save', { projectId, chapter: form })
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
          { className: 'sd-modal sd-modal-wide' },
          h('div', { className: 'sd-modal-head' }, h('strong', null, form.id ? `编辑 · 第 ${form.id} 章` : '新建章节'), h('span', { className: 'sd-hint' }, `${words} 字`), h(IconBtn, { onClick: onClose, title: '关闭' }, '✕')),
          h(
            'div',
            { className: 'sd-modal-body' },
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
            h(Field, { label: '正文' }, h(TextArea, { value: form.content, rows: 20, placeholder: '在这里写正文，或让 Agent 生成后提交。', onChange: (v) => set('content', v) })),
          ),
          h('div', { className: 'sd-modal-foot' }, h(Btn, { onClick: onClose }, '取消'), h(Btn, { kind: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存')),
        ),
      )
    }

    // ── 时间线页 ──────────────────────────────────────────────
    function TimelineTab({ bundle, projectId, onChanged }) {
      const [editing, setEditing] = useState(null)
      const events = [...(bundle.events ?? [])].sort((a, b) => (Number(a.chapter) || 0) - (Number(b.chapter) || 0))
      return h(
        'div',
        { className: 'sd-page' },
        h(
          'div',
          { className: 'sd-pagehead' },
          h('div', null, h('h2', { className: 'sd-h2' }, '🕰️ 时间线'), h('p', { className: 'sd-desc' }, '按章排列的事件流。故事内时间用于排序与检查。')),
          h(Btn, { kind: 'primary', onClick: () => setEditing({}) }, '＋ 新增事件'),
        ),
        events.length === 0
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
    function OverviewTab({ bundle, projectId, onChanged }) {
      const [form, setForm] = useState(() => ({ ...bundle.project }))
      const [busy, setBusy] = useState(false)
      useEffect(() => setForm({ ...bundle.project }), [bundle.project.id])
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
        h('div', { className: 'sd-pagehead' }, h('div', null, h('h2', { className: 'sd-h2' }, '📊 ' + bundle.project.name), h('p', { className: 'sd-desc' }, bundle.project.logline || '还没有一句话简介。'))) ,
        h('div', { className: 'sd-cards' }, cards.map(([label, value, icon]) => h('div', { key: label, className: 'sd-card' }, h('div', { className: 'sd-card-icon' }, icon), h('div', { className: 'sd-card-value' }, String(value)), h('div', { className: 'sd-card-label' }, label)))),
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
            ),
            h(Field, { label: '一句话简介' }, h(TextArea, { value: form.logline, rows: 2, onChange: (v) => set('logline', v) })),
            h(Field, { label: '故事梗概' }, h(TextArea, { value: form.description, rows: 5, onChange: (v) => set('description', v) })),
            h('div', { className: 'sd-form-actions' }, h(Btn, { kind: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存设定')),
          ),
          h('section', { className: 'sd-section' },
            h('h3', { className: 'sd-h3' }, `一致性检查（${bundle.checks.length}）`),
            bundle.checks.length === 0
              ? h(Empty, null, '没有发现问题。')
              : h('div', { className: 'sd-checks' }, bundle.checks.map((check) => h('div', { key: check.id, className: `sd-check sd-check-${check.level}` }, h('div', { className: 'sd-check-title' }, check.title), h('div', { className: 'sd-check-detail' }, check.detail)))),
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
      const exportMd = async () => {
        setBusy(true)
        try {
          const value = await api('export', { projectId })
          const blob = new Blob([value.markdown], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = value.filename
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 2000)
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
          h('div', { className: 'sd-form-actions' }, h(Btn, { onClick: exportMd, disabled: busy }, '导出 Markdown 合集')),
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
    const PROPOSAL_KIND = { plan: '章节方案', chapter: '章节正文', events: '时间线', facts: '事实', characters: '人物', foreshadow: '伏笔', highlights: '高光', custom: '自由' }

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

    function ProposalTab({ bundle, projectId, onChanged, onAskAi }) {
      const [busy, setBusy] = useState('')
      const [feedbackFor, setFeedbackFor] = useState('')
      const [feedbackText, setFeedbackText] = useState('')
      const [showDone, setShowDone] = useState(false)
      const pending = (bundle.proposals ?? []).filter((p) => p.status === 'pending')
      const done = (bundle.proposals ?? []).filter((p) => p.status !== 'pending')
      const act = async (p, action) => {
        if (!window.confirm(`${action === 'accept' ? '采纳' : '驳回'}提案「${p.title}」？`)) return
        setBusy(p.id)
        try {
          await api(action === 'accept' ? 'proposal.accept' : 'proposal.reject', { projectId, proposalId: p.id })
          onChanged()
        } catch (error) {
          window.alert(error.message)
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
        setBusy(p.id)
        try {
          const value = await api('ai.run', { projectId, task: 'revise-proposal', proposalId: p.id, chapter: p.chapter })
          const saved = value.saved ?? {}
          window.alert(`已按修改意见生成新提案${saved.proposalId ? '（' + saved.proposalId + '）' : ''}，旧提案已标记为「已修订」。`)
          onChanged()
        } catch (error) { window.alert(error.message) } finally { setBusy('') }
      }
      const renderBody = (p) => {
        const data = p.data ?? {}
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
          h('div', null, h('h2', { className: 'sd-h2' }, '📥 提案'), h('p', { className: 'sd-desc' }, 'AI 或 Agent 生成的内容先停在这里。可以对比、采纳、驳回；不满意就写修改意见，再让 AI 按意见重写。采纳前不会改动任何账本或正文。')),
          h(Btn, { kind: 'primary', onClick: () => onAskAi('next-chapter-plan') }, '🤖 让 AI 生成下一章方案'),
        ),
        pending.length === 0 ? h(Empty, null, '没有待采纳的提案。可以在右上角「让 AI 操作」生成。') : pending.map((p) => h('div', { key: p.id, className: 'sd-proposal' },
          h('div', { className: 'sd-proposal-head' },
            h(Tag, { tone: 'brand' }, PROPOSAL_KIND[p.kind] ?? p.kind),
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
          h('div', { className: 'sd-proposal-actions' },
            h(Btn, { kind: 'primary', onClick: () => act(p, 'accept'), disabled: busy === p.id }, busy === p.id ? '处理中…' : '采纳'),
            h(Btn, { onClick: () => { setFeedbackFor(p.id); setFeedbackText(''); setBusy('') }, disabled: busy === p.id }, '提修改意见'),
            Array.isArray(p.feedback) && p.feedback.length > 0
              ? h(Btn, { kind: 'primary', onClick: () => revise(p), disabled: busy === p.id }, busy === p.id ? '重写中…' : '让 AI 按意见重写')
              : null,
            h(Btn, { onClick: () => act(p, 'reject'), disabled: busy === p.id }, '驳回'),
          ),
        )),
        done.length > 0 ? h('div', { className: 'sd-section' },
          h('div', { className: 'sd-pagehead' }, h('h3', { className: 'sd-h3' }, `已处理（${done.length}）`), h(Btn, { small: true, onClick: () => setShowDone(!showDone) }, showDone ? '收起' : '展开')),
          showDone ? h('div', { className: 'sd-mini-list' }, done.slice(-20).reverse().map((p) => h('div', { key: p.id, className: 'sd-mini-row' }, h(Tag, { tone: 'muted' }, p.status === 'accepted' ? '已采纳' : '已驳回'), h('span', { className: 'sd-mini-title' }, p.title)))) : null,
        ) : null,
      )
    }

    // ── 对齐页 ────────────────────────────────────────────────
    function AlignmentTab({ bundle }) {
      const a = bundle.alignment
      if (!a) return h(Empty, null, '暂无对齐数据。')
      const bar = (pct) => h('div', { className: 'sd-progress' }, h('div', { className: 'sd-progress-fill', style: { width: `${pct ?? 0}%` } }))
      return h('div', { className: 'sd-page' },
        h('div', { className: 'sd-pagehead' }, h('div', null, h('h2', { className: 'sd-h2' }, '🎯 计划对齐'), h('p', { className: 'sd-desc' }, '预设计划 vs 实际产出。目标来自「预设」页的写作方案。'))),
        h('div', { className: 'sd-align-cards' },
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
          const value = await api('ai.run', { projectId, task, chapter: Number(chapter), instruction })
          const saved = value.saved ?? {}
          setResult(saved.kind === 'reviews' ? `✅ 已写入 ${saved.count} 条审稿意见${saved.overall ? `\n\n总体判断：${saved.overall}` : ''}` : `✅ 已生成${saved.proposalIds ? ` ${saved.proposalIds.length} 条` : ''}提案，请到「提案」页对比采纳。${saved.chars ? `\n新稿约 ${saved.chars} 字符。` : ''}`)
          onChanged()
        } catch (error) {
          setResult(`❌ ${error.message}`)
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'sd-modal-mask', onClick: (e) => e.target === e.currentTarget && !busy && onClose() },
        h('div', { className: 'sd-modal sd-modal-wide' },
          h('div', { className: 'sd-modal-head' }, h('strong', null, '🤖 让 AI 操作工作台'), h('span', { className: 'sd-hint' }, '结果先进入提案/审稿，采纳前不改正文'), h(IconBtn, { onClick: () => !busy && onClose(), title: '关闭' }, '✕')),
          h('div', { className: 'sd-modal-body' },
            h('div', { className: 'sd-form sd-form-2' },
              h(Field, { label: '任务' }, h(Select, { value: task, options: AI_TASKS.map(([v, label]) => ({ value: v, label })), onChange: setTask })),
              h(Field, { label: '章号' }, h(TextInput, { value: chapter, type: 'number', onChange: (v) => setChapter(Number(v) || 1) })),
            ),
            h('div', { className: 'sd-hint', style: { marginBottom: 8 } }, (AI_TASKS.find((t) => t[0] === task) ?? [])[2] ?? ''),
            h(Field, { label: '补充指令（可选）' }, h(TextArea, { value: instruction, rows: 3, placeholder: '例如：这一章要让母亲露出破绽；或：重点检查时间线矛盾', onChange: setInstruction })),
            result ? h('pre', { className: 'sd-ai-result' }, result) : null,
            busy ? h('div', { className: 'sd-ai-busy' }, 'AI 正在生成，可能需要 30–120 秒…') : null,
          ),
          h('div', { className: 'sd-modal-foot' }, h(Btn, { onClick: () => !busy && onClose() }, '关闭'), h(Btn, { kind: 'primary', onClick: run, disabled: busy }, busy ? '生成中…' : '开始生成')),
        ),
      )
    }


    // ── 预设页（作品预设 + 名家风格库）──────────────────────────
    function PresetCard({ preset, mode, busy, onEdit, onApply, onDelete, onAdd }) {
      const total = preset.plannedChapters && preset.chapterWords ? preset.plannedChapters * preset.chapterWords : preset.totalWords
      const actions = mode === 'builtin'
        ? [h(Btn, { key: 'add', kind: 'primary', small: true, disabled: busy, onClick: onAdd }, busy ? '添加中…' : '添加到作品')]
        : [
            h(Btn, { key: 'edit', small: true, onClick: onEdit }, '编辑'),
            h(Btn, { key: 'apply', small: true, onClick: onApply }, '设为作品目标'),
            h(Btn, { key: 'del', small: true, kind: 'danger', onClick: onDelete }, '删除'),
          ]
      return h('div', { className: 'sd-preset-card' },
        h('div', { className: 'sd-preset-head' },
          h('strong', null, preset.name),
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
        if (!window.confirm(`把「${preset.name}」的章数/字数/类型/视角应用为作品目标？`)) return
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
        (bundle.presets ?? []).length === 0
          ? h(Empty, null, '还没有预设。从下面的名家风格库里添加一套，或自定义。')
          : h('div', { className: 'sd-preset-grid' }, (bundle.presets ?? []).map((preset) => h(PresetCard, {
              key: preset.id, preset, mode: 'current', busy: busy === preset.id,
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
      const [ai, setAi] = useState(null)

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
              h(Btn, { kind: 'primary', disabled: !bundle, onClick: () => setAi({ task: 'next-chapter-plan', chapter: bundle ? (bundle.chapters.length > 0 ? Math.max(...bundle.chapters.map((c) => Number(c.id) || 0)) + 1 : 1) : 1 }) }, '🤖 让 AI 操作'),
              h(Btn, { onClick: () => setCreating(true) }, '＋ 新建作品'),
              h(Btn, { onClick: () => refresh() }, '刷新'),
              h(IconBtn, { onClick: () => setOpen(false), title: '关闭（Esc）' }, '✕'),
            ),
          ),
          error ? h('div', { className: 'sd-error' }, error) : null,
          !bundle
            ? h('div', { className: 'sd-welcome' },
                h('h2', null, '还没有作品'),
                h('p', null, '工作台把作品数据存成普通文件（Markdown + JSON），可直接备份、进 Git。'),
                h(Btn, { kind: 'primary', onClick: () => setCreating(true) }, '创建第一部作品'),
              )
            : h('div', { className: 'sd-body' },
                h('nav', { className: 'sd-nav' }, TABS.map((t) => h('button', { key: t.id, type: 'button', className: `sd-nav-item${tab === t.id ? ' sd-nav-active' : ''}`, onClick: () => setTab(t.id) }, h('span', { className: 'sd-nav-icon' }, t.icon), h('span', null, t.label)))),
                h('main', { className: 'sd-main' },
                  tab === 'overview' ? h(OverviewTab, { bundle, projectId, onChanged: () => refresh(projectId) }) : null,
                  tab === 'chapters' ? h(ChaptersTab, { bundle, projectId, onChanged: () => refresh(projectId) }) : null,
                  tab === 'timeline' ? h(TimelineTab, { bundle, projectId, onChanged: () => refresh(projectId) }) : null,
                  ['facts', 'foreshadow', 'conflicts', 'characters', 'highlights', 'reviews', 'agents'].includes(tab)
                    ? h(EntityTab, { key: tab, kind: tab, bundle, projectId, onChanged: () => refresh(projectId) })
                    : null,
                  tab === 'presets' ? h(PresetsTab, { bundle, projectId, onChanged: () => refresh(projectId) }) : null,
                  tab === 'proposals' ? h(ProposalTab, { bundle, projectId, onChanged: () => refresh(projectId), onAskAi: (task) => setAi({ task, chapter: bundle.chapters.length > 0 ? Math.max(...bundle.chapters.map((c) => Number(c.id) || 0)) + 1 : 1 }) }) : null,
                  tab === 'alignment' ? h(AlignmentTab, { bundle, projectId, onChanged: () => refresh(projectId), onAskAi: (task) => setAi({ task, chapter: bundle.chapters.length > 0 ? Math.max(...bundle.chapters.map((c) => Number(c.id) || 0)) + 1 : 1 }) }) : null,
                  tab === 'settings' ? h(SettingsTab, { bundle, projectId, onChanged: () => refresh(projectId), onProjectDeleted: () => { setProjectId(''); refresh('') } }) : null,
                ),
              ),
          creating ? h(CreateProjectDialog, { onClose: () => setCreating(false), onCreated: (id) => { setTab('overview'); refresh(id) } }) : null,
          ai && bundle ? h(AiDialog, { bundle, projectId, initialTask: ai.task, initialChapter: ai.chapter, onClose: () => setAi(null), onChanged: () => refresh(projectId) }) : null,
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
@media (max-width: 900px){.sd-two-col{grid-template-columns:1fr}.sd-form-2{grid-template-columns:1fr}.sd-nav{width:120px}}
`

    // ── 插件挂载 ──────────────────────────────────────────────
    return {
      inject: ['slots'],
      apply(ctx) {
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
