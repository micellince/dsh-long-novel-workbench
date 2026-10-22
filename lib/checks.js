/**
 * 一致性检查：全部确定性规则，不调用模型。
 * 输出 [{ id, level, title, detail, refs }]，level = error | warn | info。
 */

function maxChapterId(chapters) {
  return chapters.reduce((n, c) => Math.max(n, Number(c.id) || 0), 0)
}

function factKey(fact) {
  return `${String(fact.subject ?? '').trim()}::${String(fact.attribute ?? '').trim()}`
}

/**
 * 事实的生效区间。validFrom 缺省 = 第 1 章起，validTo 缺省 = 一直有效（Infinity）。
 * @returns {{from:number, to:number}}
 */
function factInterval(fact) {
  const from = Number(fact.validFrom)
  const to = Number(fact.validTo)
  return {
    from: Number.isFinite(from) && from > 0 ? from : 1,
    to: Number.isFinite(to) && to > 0 ? to : Infinity,
  }
}

function intervalsOverlap(a, b) {
  return a.from <= b.to && b.from <= a.to
}

/** 注意力分数：0-100 数字，空/非法值视为未打分（null）。 */
function attentionScore(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 按章号取注意力记录：同章多条时以最后一条为准（提案可能先设计后实测）。 */
function attentionByChapter(list) {
  const map = new Map()
  for (const record of Array.isArray(list) ? list : []) {
    const n = Number(record?.chapter)
    if (!Number.isFinite(n) || n <= 0) continue
    map.set(n, record)
  }
  return new Map([...map.entries()].sort((a, b) => a[0] - b[0]))
}

/** 地点名索引：name 与 aliases 都映射到同一个地点。 */
function locationNameIndex(locations) {
  const map = new Map()
  for (const location of Array.isArray(locations) ? locations : []) {
    if (!location) continue
    const names = [location.name, ...(Array.isArray(location.aliases) ? location.aliases : [])]
    for (const raw of names) {
      const key = String(raw ?? '').trim()
      if (key && !map.has(key)) map.set(key, location)
    }
  }
  return map
}

/** 世界是否已建立（world.json 已保存；兼容直接传 bundle 的测试）。 */
function worldPresent(bundle) {
  if (typeof bundle?.stats?.world === 'boolean') return bundle.stats.world
  if (typeof bundle?.worldSaved === 'boolean') return bundle.worldSaved
  const world = bundle?.world
  if (!world || typeof world !== 'object') return false
  return Boolean(String(world.name ?? '').trim() || String(world.era ?? '').trim() || world.updatedAt)
}

/**
 * 运行全部检查。
 * @param {object} bundle getBundle 的返回值（project/chapters/facts/...）
 * @returns {Array<{id:string,level:'error'|'warn'|'info',title:string,detail:string,refs:string[]}>}
 */
export function runChecks(bundle) {
  const out = []
  const chapters = bundle.chapters ?? []
  const maxChapter = maxChapterId(chapters)
  const chapterIds = new Set(chapters.map((c) => String(c.id)))
  const characterNames = new Set((bundle.characters ?? []).map((c) => String(c.name ?? '').trim()).filter(Boolean))

  // 1) 事实账本冲突：同一 subject + attribute 在【生效区间重叠】处出现不同 value
  //    区间不重叠 = 设定随时间合法变化，不报冲突；缺省区间为 [1, Infinity)。
  const groups = new Map()
  for (const fact of bundle.facts ?? []) {
    if (fact.superseded || !fact.subject || !fact.attribute) continue
    const key = factKey(fact)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(fact)
  }
  for (const [key, list] of groups) {
    const conflicting = new Set()
    const refs = new Set()
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]
        const b = list[j]
        const valueA = String(a.value ?? '').trim()
        const valueB = String(b.value ?? '').trim()
        if (!valueA || !valueB || valueA === valueB) continue
        if (!intervalsOverlap(factInterval(a), factInterval(b))) continue
        conflicting.add(valueA)
        conflicting.add(valueB)
        for (const fact of [a, b]) {
          if (fact.chapter) refs.add(String(fact.chapter))
        }
      }
    }
    if (conflicting.size > 1) {
      const [subject, attribute] = key.split('::')
      const values = [...conflicting]
      out.push({
        id: `fact-conflict:${key}`,
        level: 'error',
        title: '事实冲突',
        detail: `「${subject}」的「${attribute}」在生效区间重叠处存在 ${values.length} 个不同取值：${values.map((v) => `「${v}」`).join('、')}`,
        refs: [...refs],
      })
    }
  }

  // 2) 事实写到未来章节
  for (const fact of bundle.facts ?? []) {
    const n = Number(fact.chapter)
    if (Number.isFinite(n) && n > maxChapter && maxChapter > 0) {
      out.push({
        id: `fact-future:${fact.id}`,
        level: 'warn',
        title: '事实超出已写进度',
        detail: `「${fact.subject ?? '?'}·${fact.attribute ?? '?'}」标注在第 ${n} 章，当前只写到第 ${maxChapter} 章`,
        refs: [String(n)],
      })
    }
  }

  // 3) 伏笔超期 / 未回收
  for (const f of bundle.foreshadow ?? []) {
    const status = String(f.status ?? 'open')
    const setup = Number(f.setupChapter)
    const payoff = Number(f.payoffChapter)
    if (status === 'paid' || status === 'dropped') continue
    if (Number.isFinite(payoff) && payoff > 0 && maxChapter >= payoff) {
      out.push({
        id: `foreshadow-overdue:${f.id}`,
        level: 'error',
        title: '伏笔超期未回收',
        detail: `「${f.title ?? f.id}」计划第 ${payoff} 章回收，但已写到第 ${maxChapter} 章仍未标记回收`,
        refs: [String(payoff)],
      })
    } else if (Number.isFinite(setup) && setup > maxChapter && maxChapter > 0) {
      out.push({
        id: `foreshadow-future:${f.id}`,
        level: 'info',
        title: '伏笔尚未埋下',
        detail: `「${f.title ?? f.id}」计划第 ${setup} 章埋设，当前写到第 ${maxChapter} 章`,
        refs: [String(setup)],
      })
    }
  }

  // 4) 冲突待解决
  for (const c of bundle.conflicts ?? []) {
    if (String(c.status ?? 'active') !== 'active') continue
    const resolve = Number(c.resolveChapter)
    if (Number.isFinite(resolve) && resolve > 0 && maxChapter >= resolve) {
      out.push({
        id: `conflict-overdue:${c.id}`,
        level: 'warn',
        title: '冲突未按计划解决',
        detail: `「${c.title ?? c.id}」计划第 ${resolve} 章解决，当前已写到第 ${maxChapter} 章`,
        refs: [String(resolve)],
      })
    }
  }

  // 5) 章节引用了未建卡的人物
  for (const chapter of chapters) {
    for (const name of chapter.characters ?? []) {
      const trimmed = String(name).trim()
      if (trimmed && characterNames.size > 0 && !characterNames.has(trimmed)) {
        out.push({
          id: `char-missing:${chapter.id}:${trimmed}`,
          level: 'warn',
          title: '人物未建卡',
          detail: `第 ${chapter.id} 章引用了「${trimmed}」，但人物库中没有同名卡片`,
          refs: [String(chapter.id)],
        })
      }
    }
  }

  // 6) 空章节 / 无摘要 / 时间线缺口
  for (const chapter of chapters) {
    if (!chapter.content || !chapter.content.trim()) {
      out.push({
        id: `chapter-empty:${chapter.id}`,
        level: 'warn',
        title: '空章节',
        detail: `第 ${chapter.id} 章「${chapter.title}」还没有正文`,
        refs: [String(chapter.id)],
      })
    }
  }
  for (const event of bundle.events ?? []) {
    const n = Number(event.chapter)
    if (n > 0 && !chapterIds.has(String(event.chapter).padStart(4, '0'))) {
      out.push({
        id: `event-chapter-missing:${event.id}`,
        level: 'info',
        title: '事件指向不存在的章节',
        detail: `事件「${event.title ?? event.id}」标注在第 ${n} 章`,
        refs: [String(n)],
      })
    }
    if (!String(event.storyTime ?? '').trim()) {
      out.push({
        id: `event-notime:${event.id}`,
        level: 'info',
        title: '事件缺少故事时间',
        detail: `事件「${event.title ?? event.id}」没有填写故事内时间，时间线无法排序`,
        refs: [],
      })
    }
  }

  // 7) 进度
  const target = Number(bundle.project?.targetChapters) || 0
  if (target > 0 && chapters.length > target) {
    out.push({
      id: 'progress-over',
      level: 'info',
      title: '超出计划章节数',
      detail: `计划 ${target} 章，已写 ${chapters.length} 章`,
      refs: [],
    })
  }

  // 8) 审稿问题与待采纳提案
  for (const review of bundle.reviews ?? []) {
    if (review.status === 'fixed' || review.status === 'wontfix') continue
    if (review.severity === 'blocker') {
      out.push({ id: `review-blocker:${review.id}`, level: 'error', title: '审稿阻断', detail: `第 ${review.chapter ?? '?'} 章：${review.issue ?? ''}`, refs: [String(review.chapter ?? '')] })
    } else if (review.severity === 'major') {
      out.push({ id: `review-major:${review.id}`, level: 'warn', title: '审稿严重问题', detail: `第 ${review.chapter ?? '?'} 章：${review.issue ?? ''}`, refs: [String(review.chapter ?? '')] })
    }
  }
  const pendingProposals = (bundle.proposals ?? []).filter((p) => p.status === 'pending')
  if (pendingProposals.length > 0) {
    out.push({ id: 'proposals-pending', level: 'info', title: '待采纳提案', detail: `${pendingProposals.length} 条提案等待人工对比采纳`, refs: [] })
  }

  // 9) 注意力账本（100 分制）：缺记录 / 章末无牵引 / 类型疲劳 / 分数骤降 / 设计未兑现 / 开篇类型 / 平均分 / 未回填实测分
  const attentionMap = attentionByChapter(bundle.attention)
  const writtenChapters = chapters.filter((c) => String(c.content ?? '').trim())
  // 9.1 已写章节缺 attention 记录
  for (const chapter of writtenChapters) {
    const n = Number(chapter.id)
    if (!attentionMap.has(n)) {
      out.push({
        id: `attention-missing:${chapter.id}`,
        level: 'warn',
        title: '缺注意力记录',
        detail: `第 ${n} 章已有正文，但还没有注意力记录（冷读后补 score/detail）`,
        refs: [String(chapter.id)],
      })
    }
  }
  // 9.2 / 9.5 / 9.8 逐条记录：cliff 为空、设计分与实测分差 ≥20、冷读未回填 score
  for (const [n, record] of attentionMap) {
    if (!String(record.cliff ?? '').trim()) {
      out.push({
        id: `attention-cliff:${n}`,
        level: 'warn',
        title: '章末没有注意力牵引',
        detail: `第 ${n} 章注意力记录的 cliff（章末未决问题）为空`,
        refs: [String(n)],
      })
    }
    const score = attentionScore(record.score)
    const designScore = attentionScore(record.designScore)
    if (score !== null && designScore !== null && Math.abs(designScore - score) >= 20) {
      out.push({
        id: `attention-design-gap:${n}`,
        level: 'warn',
        title: '注意力设计未兑现',
        detail: `第 ${n} 章设计目标 ${designScore} 分，冷读实测 ${score} 分，相差 ${Math.abs(designScore - score)} 分（≥20）`,
        refs: [String(n)],
      })
    }
    if (score === null && String(record.status ?? '') !== 'planned') {
      out.push({
        id: `attention-unscored:${n}`,
        level: 'info',
        title: '注意力未回填实测分',
        detail: `第 ${n} 章注意力记录状态为 ${record.status}，但没有实测分 score，冷读后回填`,
        refs: [String(n)],
      })
    }
  }
  // 9.3 同一类型连续 > 3 章 → 疲劳预警（按真实相邻章号判断）
  const typeRuns = []
  let run = null
  for (const [n, record] of attentionMap) {
    const type = String(record.type ?? '').trim()
    if (!type) continue
    if (run && run.type === type && run.end + 1 === n) {
      run.end = n
      run.chapters.push(n)
    } else {
      run = { type, start: n, end: n, chapters: [n] }
      typeRuns.push(run)
    }
  }
  for (const item of typeRuns) {
    if (item.chapters.length > 3) {
      out.push({
        id: `attention-fatigue:${item.type}:${item.start}-${item.end}`,
        level: 'warn',
        title: '注意力类型疲劳',
        detail: `第 ${item.start}–${item.end} 章连续 ${item.chapters.length} 章都是「${item.type}」型，读者容易疲劳，建议换型`,
        refs: item.chapters.map(String),
      })
    }
  }
  // 9.4 相邻章分数下降 ≥15 → 流失预警
  let previousScored = null
  for (const [n, record] of attentionMap) {
    const score = attentionScore(record.score)
    if (score === null) continue
    if (previousScored && previousScored.chapter + 1 === n && previousScored.score - score >= 15) {
      out.push({
        id: `attention-drop:${previousScored.chapter}-${n}`,
        level: 'warn',
        title: '注意力骤降',
        detail: `第 ${previousScored.chapter} 章 ${previousScored.score} 分 → 第 ${n} 章 ${score} 分，下降 ${previousScored.score - score} 分（≥15）`,
        refs: [String(previousScored.chapter), String(n)],
      })
    }
    previousScored = { chapter: n, score }
  }
  // 9.6 开篇前 3 章没有事件/悬念型（只在已有开篇记录时判断，避免和缺记录重复报警）
  const opening = [...attentionMap.entries()].filter(([n]) => n >= 1 && n <= 3)
  if (opening.length > 0 && !opening.some(([, record]) => {
    const type = String(record.type ?? '').trim()
    return type === 'event' || type === 'mystery'
  })) {
    out.push({
      id: 'attention-opening',
      level: 'warn',
      title: '开篇缺少事件/悬念型注意力',
      detail: `开篇（第 ${opening.map(([n]) => n).join('、')} 章）没有 event 或 mystery 型注意力，读者缺少追更理由`,
      refs: opening.map(([n]) => String(n)),
    })
  }
  // 9.7 有实测分的章节平均 <60 → error
  const scored = [...attentionMap.values()].map((record) => attentionScore(record.score)).filter((n) => n !== null)
  if (scored.length > 0) {
    const average = scored.reduce((sum, n) => sum + n, 0) / scored.length
    if (average < 60) {
      out.push({
        id: 'attention-average-low',
        level: 'error',
        title: '全书注意力平均分偏低',
        detail: `${scored.length} 章有实测分，平均 ${Math.round(average * 10) / 10} 分（<60），整体缺乏追更动力`,
        refs: [],
      })
    }
  }

  // 10) 世界模型 / 地点空间自洽（只读，不阻断任何操作）
  const locations = Array.isArray(bundle.locations) ? bundle.locations : []
  const locationIndex = locationNameIndex(locations)
  const savedWorld = bundle.world && typeof bundle.world === 'object' ? bundle.world : {}
  const mapSize = {
    w: Number(savedWorld.mapSize?.w) > 0 ? Number(savedWorld.mapSize.w) : 1000,
    h: Number(savedWorld.mapSize?.h) > 0 ? Number(savedWorld.mapSize.h) : 1000,
  }
  // 10.1 有已写章节但还没建世界
  if (writtenChapters.length > 0 && !worldPresent(bundle)) {
    out.push({
      id: 'world-missing',
      level: 'info',
      title: '还没有世界模型',
      detail: `已写 ${writtenChapters.length} 章，但还没有 world（尺度/坐标空间/交通模型），可用 world-build / world-infer 任务补齐`,
      refs: [],
    })
  }
  // 10.2 章节 / 事件的地点文本匹配不到地点库（仅当地点库非空，避免老书刷屏）
  if (locations.length > 0) {
    const unknown = new Map()
    const recordUnknown = (name, label) => {
      if (!unknown.has(name)) unknown.set(name, new Set())
      unknown.get(name).add(label)
    }
    for (const chapter of writtenChapters) {
      const name = String(chapter.location ?? '').trim()
      if (name && !locationIndex.has(name)) recordUnknown(name, `第 ${Number(chapter.id)} 章`)
    }
    for (const event of bundle.events ?? []) {
      const name = String(event.location ?? '').trim()
      if (name && !locationIndex.has(name)) {
        const n = Number(event.chapter)
        recordUnknown(name, n > 0 ? `第 ${n} 章事件` : '事件')
      }
    }
    for (const [name, labels] of unknown) {
      const list = [...labels]
      out.push({
        id: `location-unknown:${name}`,
        level: 'warn',
        title: '地点未登记',
        detail: `「${name}」被 ${list.slice(0, 6).join('、')} 引用，但地点库（含别名）里没有该地点`,
        refs: list.slice(0, 6),
      })
    }
  }
  // 10.3 相邻两章地点不同，但两地之间没有直接连接
  const locatedChapters = writtenChapters
    .map((chapter) => ({ chapter: Number(chapter.id), location: String(chapter.location ?? '').trim() }))
    .filter((row) => Number.isFinite(row.chapter) && row.location)
    .sort((a, b) => a.chapter - b.chapter)
  for (let i = 1; i < locatedChapters.length; i += 1) {
    const prev = locatedChapters[i - 1]
    const next = locatedChapters[i]
    const a = locationIndex.get(prev.location)
    const b = locationIndex.get(next.location)
    if (!a || !b || String(a.id ?? a.name) === String(b.id ?? b.name)) continue
    const connected = (Array.isArray(a.connections) && a.connections.some((conn) => String(conn?.to ?? '') === String(b.id ?? '')))
      || (Array.isArray(b.connections) && b.connections.some((conn) => String(conn?.to ?? '') === String(a.id ?? '')))
    if (!connected) {
      out.push({
        id: `location-route-missing:${a.name ?? a.id}-${b.name ?? b.id}`,
        level: 'warn',
        title: '地点之间没有路线',
        detail: `第 ${prev.chapter} 章「${prev.location}」→ 第 ${next.chapter} 章「${next.location}」，两地之间没有直接 connection`,
        refs: [String(prev.chapter), String(next.chapter)],
      })
    }
  }
  // 10.4 坐标非法 / 超出 mapSize
  for (const location of locations) {
    const x = Number(location?.coords?.x)
    const y = Number(location?.coords?.y)
    const id = String(location?.id ?? location?.name ?? '?')
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > mapSize.w || y > mapSize.h) {
      out.push({
        id: `location-coords-bad:${id}`,
        level: 'error',
        title: '地点坐标非法',
        detail: `「${location?.name ?? id}」坐标 (${location?.coords?.x ?? '空'}, ${location?.coords?.y ?? '空'}) 不在 0–${mapSize.w} × 0–${mapSize.h} 的坐标空间内`,
        refs: [],
      })
    }
  }
  // 10.5 两地点坐标过近（归一化距离 < 10）
  const validCoords = locations.filter((location) => Number.isFinite(Number(location?.coords?.x)) && Number.isFinite(Number(location?.coords?.y)))
  for (let i = 0; i < validCoords.length; i += 1) {
    for (let j = i + 1; j < validCoords.length; j += 1) {
      const a = validCoords[i]
      const b = validCoords[j]
      if (String(a.id ?? a.name) === String(b.id ?? b.name)) continue
      const dx = Number(a.coords.x) - Number(b.coords.x)
      const dy = Number(a.coords.y) - Number(b.coords.y)
      const distance = Math.sqrt(dx * dx + dy * dy)
      if (distance < 10) {
        out.push({
          id: `location-coords-close:${a.name ?? a.id}/${b.name ?? b.id}`,
          level: 'warn',
          title: '两个地点坐标过近',
          detail: `「${a.name ?? a.id}」与「${b.name ?? b.id}」坐标距离 ${Math.round(distance * 10) / 10}（<10），地图上会重叠`,
          refs: [],
        })
      }
    }
  }
  // 10.6 地点 firstChapter 晚于首次被章节 / 事件引用的章
  const firstReference = new Map()
  const noteFirstReference = (name, chapterNumber) => {
    const location = locationIndex.get(String(name ?? '').trim())
    const n = Number(chapterNumber)
    if (!location || !Number.isFinite(n) || n <= 0) return
    const current = firstReference.get(location)
    if (!current || n < current.chapter) firstReference.set(location, { chapter: n, name: String(name).trim() })
  }
  for (const chapter of writtenChapters) noteFirstReference(chapter.location, chapter.id)
  for (const event of bundle.events ?? []) noteFirstReference(event.location, event.chapter)
  for (const location of locations) {
    const firstChapter = Number(location?.firstChapter)
    const reference = firstReference.get(location)
    if (!reference || !Number.isFinite(firstChapter) || firstChapter <= 0) continue
    if (firstChapter > reference.chapter) {
      out.push({
        id: `location-first-chapter:${location.id ?? location.name}`,
        level: 'warn',
        title: '地点首次出现章标注偏晚',
        detail: `「${location.name ?? location.id}」标注首次出现第 ${firstChapter} 章，但更早的第 ${reference.chapter} 章（${reference.name}）已引用它`,
        refs: [String(reference.chapter), String(firstChapter)],
      })
    }
  }

  const order = { error: 0, warn: 1, info: 2 }
  return out.sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9))
}

/**
 * 选用于对齐计算的预设。
 * 1) project.activePresetId 命中某预设 → 用它；
 * 2) 否则若有预设带 chapterFrom → 视为分卷方案（plannedChapters = max(chapterTo)，
 *    totalWords = Σ 各卷 totalWords，chapterWords = round(totalWords / plannedChapters)）；
 * 3) 否则用第一个预设（旧行为）。
 */
function alignmentPreset(bundle) {
  const presets = Array.isArray(bundle.presets) ? bundle.presets : []
  const project = bundle.project ?? {}
  const activeId = String(project.activePresetId ?? '').trim()
  if (activeId) {
    const active = presets.find((preset) => String(preset.id ?? '') === activeId)
    if (active) return active
  }
  const volumes = presets.filter((preset) => {
    const from = Number(preset.chapterFrom)
    return Number.isFinite(from) && from > 0
  })
  if (volumes.length > 0) {
    const totalWords = volumes.reduce((sum, preset) => sum + (Number(preset.totalWords) || 0), 0)
    const plannedChapters =
      volumes.reduce((max, preset) => Math.max(max, Number(preset.chapterTo) || 0), 0) ||
      Number(project.targetChapters) ||
      0
    return {
      id: 'multi-volume',
      name: `分卷方案（${volumes.length} 卷）`,
      plannedChapters,
      totalWords,
      chapterWords: plannedChapters > 0 ? Math.round(totalWords / plannedChapters) : 0,
    }
  }
  return presets[0] ?? {}
}

/**
 * 计划 vs 实际的对齐数据（供 UI 与 Agent 使用）。
 * @param {object} bundle
 */
export function computeAlignment(bundle) {
  const preset = alignmentPreset(bundle)
  const plannedChapters = Number(preset.plannedChapters) || Number(bundle.project?.targetChapters) || 0
  const chapterWords = Number(preset.chapterWords) || 0
  const totalWords = Number(preset.totalWords) || Number(bundle.project?.targetWords) || 0
  const chapters = bundle.chapters ?? []
  const countByChapter = (list) => {
    const map = new Map()
    for (const item of list ?? []) {
      const n = Number(item.chapter)
      if (!Number.isFinite(n)) continue
      map.set(n, (map.get(n) ?? 0) + 1)
    }
    return map
  }
  const events = countByChapter(bundle.events)
  const facts = countByChapter(bundle.facts)
  const reviewsOpen = new Map()
  for (const review of bundle.reviews ?? []) {
    if (review.status === 'fixed' || review.status === 'wontfix') continue
    const n = Number(review.chapter)
    if (!Number.isFinite(n)) continue
    reviewsOpen.set(n, (reviewsOpen.get(n) ?? 0) + 1)
  }
  const proposals = new Map()
  for (const proposal of bundle.proposals ?? []) {
    if (proposal.status !== 'pending') continue
    const n = Number(proposal.chapter)
    if (!Number.isFinite(n)) continue
    proposals.set(n, (proposals.get(n) ?? 0) + 1)
  }
  const perChapter = chapters.map((chapter) => {
    const n = Number(chapter.id)
    return {
      id: chapter.id,
      title: chapter.title,
      words: chapter.words,
      target: chapterWords || null,
      delta: chapterWords ? chapter.words - chapterWords : null,
      events: events.get(n) ?? 0,
      facts: facts.get(n) ?? 0,
      openReviews: reviewsOpen.get(n) ?? 0,
      proposals: proposals.get(n) ?? 0,
    }
  })
  const actualWords = chapters.reduce((n, c) => n + (c.words || 0), 0)
  const pct = (actual, target) => (target > 0 ? Math.min(100, Math.round((actual / target) * 100)) : null)
  return {
    presetId: preset.id ?? null,
    presetName: String(preset.name ?? ''),
    plannedChapters,
    chapterWords,
    totalWords,
    actualChapters: chapters.length,
    actualWords,
    chapterProgress: pct(chapters.length, plannedChapters),
    wordProgress: pct(actualWords, totalWords),
    pendingProposals: (bundle.proposals ?? []).filter((p) => p.status === 'pending').length,
    openReviews: (bundle.reviews ?? []).filter((r) => r.status !== 'fixed' && r.status !== 'wontfix').length,
    perChapter,
  }
}
