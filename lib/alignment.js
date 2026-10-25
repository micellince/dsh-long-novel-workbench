/**
 * 版本对齐（Version Alignment）
 *
 * 两套版本号：
 *   - 稿本版本 project.draft.version：正文/章节变化时 +1，log 里记最近 100 次变化；
 *   - 账本同步 project.ledgerSync[kind]：touchedVersion（账本最近一次改动发生在稿本第几版）
 *     与 alignedVersion（最近一次确认对齐到稿本第几版）。
 *
 * 对齐 = alignedVersion 追上 draft.version。落后的账本由作者点按钮加入清单，
 * 交给 AI 读落差章节补账本（AI 只提交提案）。
 *
 * 本文件只有纯函数：不读写文件。写盘由 lib/store.js 负责。
 * 契约见 docs/ALIGNMENT-VERSION.md。
 */

/** draft.log 最多保留多少条。 */
export const DRAFT_LOG_LIMIT = 100

/** 参与版本对齐的账本种类。 */
export const ALIGN_KINDS = [
  'characters',
  'facts',
  'events',
  'locations',
  'world',
  'highlights',
  'foreshadow',
  'conflicts',
  'attention',
  'outlines',
]

/**
 * 对齐的"域"：一个域对应页面上的一行，通常一个域一个账本。
 * tab 用于"去该页"跳转；proposalKinds 用于统计待验收提案。
 */
export const ALIGN_DOMAINS = [
  { id: 'characters', label: '人物', icon: '👤', tab: 'characters', kinds: ['characters'], proposalKinds: ['characters'] },
  { id: 'facts', label: '事实账本（物品 / 设定）', icon: '⚖️', tab: 'facts', kinds: ['facts'], proposalKinds: ['facts'] },
  { id: 'events', label: '时间线', icon: '🕰️', tab: 'timeline', kinds: ['events'], proposalKinds: ['events'] },
  { id: 'locations', label: '地图 / 地点', icon: '🗺️', tab: 'map', kinds: ['locations'], proposalKinds: ['locations'] },
  { id: 'world', label: '世界设定', icon: '🌍', tab: 'world', kinds: ['world'], proposalKinds: ['world'] },
  { id: 'highlights', label: '高光', icon: '✨', tab: 'highlights', kinds: ['highlights'], proposalKinds: ['highlights'] },
  { id: 'foreshadow', label: '伏笔', icon: '🧩', tab: 'foreshadow', kinds: ['foreshadow'], proposalKinds: ['foreshadow'] },
  { id: 'conflicts', label: '冲突', icon: '⚔️', tab: 'conflicts', kinds: ['conflicts'], proposalKinds: ['conflicts'] },
  { id: 'attention', label: '注意力', icon: '⚡', tab: 'attention', kinds: ['attention'], proposalKinds: ['attention'] },
  { id: 'outlines', label: '章节大纲', icon: '📋', tab: 'chapters', kinds: ['outlines'], proposalKinds: ['outlines', 'plan'] },
]

/** 域状态 → 中文文案（behind 的具体版数由 UI 拼）。 */
export const ALIGN_STATUS_LABEL = {
  idle: '未开始',
  untracked: '未追踪',
  behind: '落后',
  pending: '待验收',
  aligned: '已对齐',
}

/** draft.log 里 kind → 中文（给 UI / 文本输出用）。 */
export const DRAFT_KIND_LABEL = {
  'chapter-create': '新建章节',
  'chapter-save': '保存章节',
  'chapter-delete': '删除章节',
  'chapter-import': '导入章节',
  'snapshot-restore': '回滚整本',
  'external-change': '外部改动',
  baseline: '建立基线',
}

function toInt(value, fallback = null) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.floor(num)
}

/** 章号统一成整数；'0003' / 3 / '3' 都 → 3。 */
function toChapterNumber(value) {
  const num = toInt(value, null)
  return num === null || num <= 0 ? null : num
}

function toText(value) {
  return value === undefined || value === null ? '' : String(value)
}

function toIso(value) {
  const text = toText(value)
  return text || null
}

/** 读取稿本版本（旧数据没有 draft 时返回 0）。 */
export function getDraftState(project) {
  const raw = project && typeof project.draft === 'object' && project.draft && !Array.isArray(project.draft) ? project.draft : {}
  const version = Math.max(0, toInt(raw.version, 0) ?? 0)
  const log = Array.isArray(raw.log)
    ? raw.log
        .filter((row) => row && typeof row === 'object')
        .map((row) => ({
          version: toInt(row.version, 0) ?? 0,
          at: toIso(row.at),
          kind: toText(row.kind) || 'chapter-save',
          chapter: toChapterNumber(row.chapter),
          title: toText(row.title),
          note: toText(row.note),
        }))
    : []
  return { version, updatedAt: toIso(raw.updatedAt), log }
}

/** 读取每个账本的同步状态（缺的 kind 补空记录）。 */
export function getLedgerSync(project) {
  const raw = project && typeof project.ledgerSync === 'object' && project.ledgerSync && !Array.isArray(project.ledgerSync)
    ? project.ledgerSync
    : {}
  const out = {}
  for (const kind of ALIGN_KINDS) {
    const row = raw[kind] && typeof raw[kind] === 'object' && !Array.isArray(raw[kind]) ? raw[kind] : {}
    const touchedVersion = toInt(row.touchedVersion, null)
    const alignedVersion = toInt(row.alignedVersion, null)
    out[kind] = {
      touchedVersion: touchedVersion === null ? null : Math.max(0, touchedVersion),
      touchedAt: toIso(row.touchedAt),
      alignedVersion: alignedVersion === null ? null : Math.max(0, alignedVersion),
      alignedAt: toIso(row.alignedAt),
      note: toText(row.note),
    }
  }
  return out
}

/**
 * 稿本版本 +1，并记一条 log。直接改动传入的 project 对象。
 * @param {object} project 作品（project.json 内容）
 * @param {{ kind?: string, chapter?: number|string, title?: string, note?: string, at?: string }} change
 * @returns {{ version: number, at: string, kind: string, chapter: number|null, title: string, note: string }} 新记录
 */
export function bumpDraft(project, change = {}) {
  if (!project || typeof project !== 'object') throw new Error('bumpDraft 需要 project 对象')
  const draft = getDraftState(project)
  const at = toIso(change.at) || new Date().toISOString()
  const version = draft.version + 1
  const entry = {
    version,
    at,
    kind: toText(change.kind) || 'chapter-save',
    chapter: toChapterNumber(change.chapter),
    title: toText(change.title),
    note: toText(change.note),
  }
  const log = [...draft.log, entry].slice(-DRAFT_LOG_LIMIT)
  project.draft = { version, updatedAt: at, log }
  return entry
}

/** 归一化 kinds 参数：只保留 ALIGN_KINDS 内的值，去重。 */
export function normalizeAlignKinds(kinds) {
  const list = Array.isArray(kinds) ? kinds : kinds ? [kinds] : []
  const out = []
  for (const raw of list) {
    const kind = toText(raw).trim()
    if (ALIGN_KINDS.includes(kind) && !out.includes(kind)) out.push(kind)
  }
  return out
}

/**
 * 账本被改动：把 touchedVersion 记成当前稿本版本。直接改动传入的 project 对象。
 * @returns {string[]} 实际更新了的 kind（同版本重复调用不会重复写）
 */
export function touchLedgerKinds(project, kinds, at) {
  if (!project || typeof project !== 'object') throw new Error('touchLedgerKinds 需要 project 对象')
  const draft = getDraftState(project)
  const sync = project.ledgerSync && typeof project.ledgerSync === 'object' && !Array.isArray(project.ledgerSync)
    ? project.ledgerSync
    : {}
  const touchedAt = toIso(at) || new Date().toISOString()
  const touched = []
  for (const kind of normalizeAlignKinds(kinds)) {
    const row = sync[kind] && typeof sync[kind] === 'object' ? sync[kind] : {}
    if (toInt(row.touchedVersion, null) === draft.version && toIso(row.touchedAt)) continue
    sync[kind] = { ...row, touchedVersion: draft.version, touchedAt }
    touched.push(kind)
  }
  if (touched.length > 0) project.ledgerSync = sync
  return touched
}

/**
 * 标记账本已对齐到某个稿本版本。直接改动传入的 project 对象。
 * @returns {string[]} 实际标记了的 kind
 */
export function markLedgerKindsAligned(project, kinds, options = {}) {
  if (!project || typeof project !== 'object') throw new Error('markLedgerKindsAligned 需要 project 对象')
  const draft = getDraftState(project)
  const target = toInt(options.version, draft.version) ?? draft.version
  if (target > draft.version) throw new Error('不能标记到未来的稿本版本')
  const sync = project.ledgerSync && typeof project.ledgerSync === 'object' && !Array.isArray(project.ledgerSync)
    ? project.ledgerSync
    : {}
  const at = toIso(options.at) || new Date().toISOString()
  const note = toText(options.note)
  const marked = []
  for (const kind of normalizeAlignKinds(kinds)) {
    const row = sync[kind] && typeof sync[kind] === 'object' ? sync[kind] : {}
    sync[kind] = { ...row, alignedVersion: target, alignedAt: at, note: note || toText(row.note) }
    marked.push(kind)
  }
  if (marked.length > 0) project.ledgerSync = sync
  return marked
}

function formatChapterLabel(list) {
  const ids = [...new Set(list)].sort((a, b) => a - b)
  if (ids.length === 0) return ''
  const head = ids.slice(0, 8).map((id) => `第${id}章`).join('、')
  return ids.length > 8 ? `${head} 等 ${ids.length} 章` : head
}

/** 账本里出现过的章号集合。 */
function coveredChapters(rows, field = 'chapter') {
  const set = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const num = toChapterNumber(row?.[field])
    if (num !== null) set.add(num)
  }
  return set
}

/** 某个账本在已写章节里的覆盖缺口。 */
function missingChapterGap(rows, chapters, label, gapId) {
  const covered = coveredChapters(rows)
  const missing = chapters.map((chapter) => chapter.id).filter((id) => !covered.has(id))
  if (missing.length === 0) return null
  return {
    id: gapId,
    label: `有 ${missing.length} 章缺少${label}：${formatChapterLabel(missing)}`,
    chapters: missing,
  }
}

/** 名字类账本的"正文引用了但没建卡/登记"缺口。 */
function missingNameGap(rows, chapters, options) {
  const known = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = toText(row?.name).trim()
    if (name) known.add(name)
    for (const alias of Array.isArray(row?.aliases) ? row.aliases : []) {
      const key = toText(alias).trim()
      if (key) known.add(key)
    }
  }
  const refs = new Map()
  for (const chapter of chapters) {
    const names = options.pick(chapter)
    for (const raw of names) {
      const name = toText(raw).trim()
      if (!name || known.has(name)) continue
      if (!refs.has(name)) refs.set(name, [])
      refs.get(name).push(chapter.id)
    }
  }
  if (refs.size === 0) return null
  const names = [...refs.keys()]
  const head = names.slice(0, 4).map((name) => `「${name}」`).join('、')
  const more = names.length > 4 ? ` 等 ${names.length} 个` : ''
  const chapterIds = [...new Set([...refs.values()].flat())]
  return {
    id: options.gapId,
    label: `${head}${more}${options.label}（出现在 ${formatChapterLabel(chapterIds)}）`,
    chapters: chapterIds.sort((a, b) => a - b),
  }
}

/**
 * 覆盖缺口：回答"哪里没对齐"（不是版本号，而是账本缺内容）。
 * @returns {Array<{id:string,label:string,chapters:number[]}>} 每域最多 3 条
 */
export function collectCoverageGaps(domain, bundle) {
  const chapters = (Array.isArray(bundle?.chapters) ? bundle.chapters : [])
    .map((chapter) => ({
      id: toChapterNumber(chapter?.id),
      characters: Array.isArray(chapter?.characters) ? chapter.characters : [],
      location: toText(chapter?.location).trim(),
    }))
    .filter((chapter) => chapter.id !== null)
    .sort((a, b) => a.id - b.id)
  const rows = (kind) => (Array.isArray(bundle?.[kind]) ? bundle[kind] : [])
  const gaps = []
  const push = (gap) => {
    if (gap && gaps.length < 3) gaps.push(gap)
  }
  switch (domain.id) {
    case 'characters':
      push(missingNameGap(rows('characters'), chapters, {
        gapId: 'characters-missing',
        label: '在正文出现但未建人物卡',
        pick: (chapter) => chapter.characters,
      }))
      break
    case 'locations':
      push(missingNameGap(rows('locations'), chapters, {
        gapId: 'locations-missing',
        label: '在正文出现但未登记地点',
        pick: (chapter) => (chapter.location ? [chapter.location] : []),
      }))
      break
    case 'events':
      push(missingChapterGap(rows('events'), chapters, '时间线事件', 'events-missing'))
      break
    case 'facts':
      push(missingChapterGap(rows('facts'), chapters, '事实账本条目', 'facts-missing'))
      break
    case 'highlights':
      push(missingChapterGap(rows('highlights'), chapters, '高光记录', 'highlights-missing'))
      break
    case 'attention':
      push(missingChapterGap(rows('attention'), chapters, '注意力记录', 'attention-missing'))
      break
    case 'outlines':
      push(missingChapterGap(rows('outlines'), chapters, '章节大纲', 'outlines-missing'))
      break
    case 'world':
      if (!bundle?.worldSaved) push({ id: 'world-missing', label: '尚未创建世界模型', chapters: [] })
      break
    default:
      break
  }
  return gaps
}

function domainIsEmpty(domain, bundle) {
  if (domain.id === 'world') return !bundle?.worldSaved
  return domain.kinds.every((kind) => !(Array.isArray(bundle?.[kind]) ? bundle[kind] : []).length)
}

/**
 * 计算版本对齐报告（供 UI / 工具 / bundle 输出用）。
 * @param {object} bundle getBundle 的结果（至少要有 project、chapters、各账本数组、proposals）
 */
export function computeVersionAlignment(bundle) {
  const project = bundle?.project && typeof bundle.project === 'object' ? bundle.project : {}
  const draft = getDraftState(project)
  const sync = getLedgerSync(project)
  const chapters = (Array.isArray(bundle?.chapters) ? bundle.chapters : [])
    .map((chapter) => ({ id: toChapterNumber(chapter?.id), title: toText(chapter?.title) }))
    .filter((chapter) => chapter.id !== null)
    .sort((a, b) => a.id - b.id)
  const writtenIds = new Set(chapters.map((chapter) => chapter.id))
  const titleOf = new Map(chapters.map((chapter) => [chapter.id, chapter.title]))
  const proposals = Array.isArray(bundle?.proposals) ? bundle.proposals : []

  const domains = ALIGN_DOMAINS.map((domain) => {
    const rows = domain.kinds.map((kind) => sync[kind]).filter(Boolean)
    const alignedVersions = rows.map((row) => row.alignedVersion).filter((value) => value !== null)
    const alignedVersion = alignedVersions.length === 0 ? null : Math.min(...alignedVersions)
    const touchedVersions = rows.map((row) => row.touchedVersion).filter((value) => value !== null)
    const touchedVersion = touchedVersions.length === 0 ? null : Math.max(...touchedVersions)
    const alignedAt = rows.map((row) => row.alignedAt).filter(Boolean).sort().pop() ?? null
    const touchedAt = rows.map((row) => row.touchedAt).filter(Boolean).sort().pop() ?? null
    const note = rows.map((row) => row.note).filter(Boolean).pop() ?? ''

    // 对齐之后发生的稿本变更（未追踪时把所有版本记录都算作落差）
    const changes = draft.log.filter((entry) => (alignedVersion === null ? true : entry.version > alignedVersion))
    const changedChapters = []
    for (const entry of changes) {
      if (entry.chapter === null || !writtenIds.has(entry.chapter)) continue
      if (changedChapters.some((row) => row.id === entry.chapter)) continue
      changedChapters.push({ id: entry.chapter, title: entry.title || titleOf.get(entry.chapter) || `第 ${entry.chapter} 章` })
    }
    changedChapters.sort((a, b) => a.id - b.id)

    const pendingProposals = proposals.filter(
      (proposal) => proposal && proposal.status === 'pending' && domain.proposalKinds.includes(toText(proposal.kind)),
    ).length
    const gaps = collectCoverageGaps(domain, bundle)
    const dirty = touchedVersion !== null && alignedVersion !== null && touchedVersion > alignedVersion

    let status = 'aligned'
    if (chapters.length === 0 && draft.version === 0) status = 'idle'
    else if (alignedVersion === null) status = 'untracked'
    else if (alignedVersion < draft.version) status = 'behind'
    else if (pendingProposals > 0) status = 'pending'

    return {
      id: domain.id,
      label: domain.label,
      icon: domain.icon,
      tab: domain.tab,
      kinds: [...domain.kinds],
      proposalKinds: [...domain.proposalKinds],
      version: alignedVersion,
      alignedVersion,
      alignedAt,
      touchedVersion,
      touchedAt,
      note,
      status,
      behind: alignedVersion === null ? null : Math.max(0, draft.version - alignedVersion),
      dirty,
      pendingProposals,
      changedChapters,
      changes: changes.slice(-12).map((entry) => ({ ...entry })),
      gaps,
      gapCount: gaps.length,
      empty: domainIsEmpty(domain, bundle),
    }
  })

  const summary = {
    version: draft.version,
    total: domains.length,
    aligned: domains.filter((domain) => domain.status === 'aligned').length,
    behind: domains.filter((domain) => domain.status === 'behind').length,
    untracked: domains.filter((domain) => domain.status === 'untracked').length,
    pending: domains.filter((domain) => domain.status === 'pending').length,
    idle: domains.filter((domain) => domain.status === 'idle').length,
    gaps: domains.reduce((sum, domain) => sum + domain.gaps.length, 0),
    pendingProposals: domains.reduce((sum, domain) => sum + domain.pendingProposals, 0),
    needsAlign: false,
  }
  summary.needsAlign = summary.behind + summary.untracked > 0

  const words = (Array.isArray(bundle?.chapters) ? bundle.chapters : []).reduce(
    (sum, chapter) => sum + (Number(chapter?.words) || 0),
    0,
  )

  return {
    manuscript: { version: draft.version, updatedAt: draft.updatedAt, chapters: chapters.length, words },
    domains,
    summary,
    log: draft.log.slice(-12).reverse().map((entry) => ({ ...entry })),
  }
}

function formatAt(value) {
  const text = toText(value)
  if (!text) return ''
  return text.slice(0, 16).replace('T', ' ')
}

function statusText(domain) {
  switch (domain.status) {
    case 'behind':
      return `落后 ${domain.behind} 版`
    case 'untracked':
      return '未追踪'
    case 'pending':
      return '待验收'
    case 'idle':
      return '未开始'
    default:
      return '已对齐'
  }
}

/** 把报告格式化成 Markdown（工具输出 / bundle 输出用）。 */
export function formatVersionAlignment(report) {
  if (!report || typeof report !== 'object') return '## 版本对齐\n\n（暂无数据）'
  const manuscript = report.manuscript ?? {}
  const summary = report.summary ?? {}
  const version = toInt(manuscript.version, 0) ?? 0
  const head = `稿本 v${version}`
  const meta = [formatAt(manuscript.updatedAt), `${manuscript.chapters ?? 0} 章 / ${Number(manuscript.words ?? 0).toLocaleString('en-US')} 字`]
    .filter(Boolean)
    .join('｜')
  const counts = `已对齐 ${summary.aligned ?? 0}/${summary.total ?? 0}｜落后 ${summary.behind ?? 0}｜未追踪 ${summary.untracked ?? 0}｜待验收提案 ${summary.pendingProposals ?? 0}`
  const lines = ['## 版本对齐', '', `**${head}**（${meta}）`, '', counts, '']

  const domains = Array.isArray(report.domains) ? report.domains : []
  const notable = domains.filter((domain) => domain.status !== 'aligned')
  if (notable.length === 0) {
    lines.push('所有账本都已对齐到当前稿本版本。')
  } else {
    for (const domain of notable) {
      const aligned = domain.alignedVersion === null ? '未追踪' : `v${domain.alignedVersion}`
      const parts = [`账本 ${aligned} → 稿本 v${version}（${statusText(domain)}）`]
      if (domain.changedChapters?.length) {
        parts.push(
          `变更章节：${domain.changedChapters
            .slice(0, 8)
            .map((chapter) => `第${chapter.id}章${chapter.title ? `《${chapter.title}》` : ''}`)
            .join('、')}${domain.changedChapters.length > 8 ? ` 等 ${domain.changedChapters.length} 章` : ''}`,
        )
      }
      if (domain.pendingProposals) parts.push(`待采纳提案 ${domain.pendingProposals} 条`)
      if (domain.gaps?.length) parts.push(`缺口：${domain.gaps.map((gap) => gap.label).join('；')}`)
      if (domain.dirty) parts.push('对齐之后账本又改过')
      lines.push(`- **${domain.label}**：${parts.join('；')}`)
    }
    lines.push('')
    lines.push('> 对齐流程：把落后的域加入清单交给 AI（AI 只提交提案，不直接改账本/正文），采纳提案后再标记该域已对齐。')
  }

  const aligned = domains.filter((domain) => domain.status === 'aligned')
  if (aligned.length > 0) {
    lines.push('')
    lines.push(`已对齐：${aligned.map((domain) => domain.label).join('、')}`)
  }

  const log = Array.isArray(report.log) ? report.log : []
  if (log.length > 0) {
    lines.push('', '最近稿本变更：')
    for (const entry of log.slice(0, 6)) {
      const kindLabel = DRAFT_KIND_LABEL[entry.kind] ?? entry.kind
      const chapter = entry.chapter ? `第${entry.chapter}章` : ''
      lines.push(`- v${entry.version} ${kindLabel}${chapter ? ` ${chapter}` : ''}${entry.title && !chapter ? ` ${entry.title}` : ''}${entry.at ? `（${formatAt(entry.at)}）` : ''}`)
    }
  }
  return lines.join('\n')
}
