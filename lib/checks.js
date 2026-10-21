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
    if (!fact.subject || !fact.attribute) continue
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
