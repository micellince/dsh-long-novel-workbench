/**
 * 长篇中文小说工作台 · Host 半边
 *
 * 1) Web UI 的同源 API（/novel-desk/api）：作品、章节、账本、提案、审稿、AI 生成。
 * 2) Agent 工具：读上下文、生成「工作单」、提交提案/审稿、按需直写。
 */

import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultRoot, ensureRoot, getLibrary, getBundle, createProject, updateProject, deleteProject, saveChapter, deleteChapter, upsertEntity, deleteEntity, exportBook, getEntities, listProjects, createProposal, acceptProposal, rejectProposal, addProposalFeedback, markProposalRevised, addPresetFromTemplate, applyPreset, listChapterHistory, readChapterHistoryVersion, restoreChapterVersion, batchAcceptProposals, batchRejectProposals, batchUpdateReviews, appendUsageRecord, listUsageRecords, listImportRecords } from './lib/store.js'
import { scanImport, runImport } from './lib/importer.js'
import { estimateContext, runAi } from './lib/ai.js'
import { estimateSessionCost, loadChatUsage, loadModelPrices } from './lib/usage.js'
import { builtinPresets } from './lib/defaults.js'

const ROUTE = '/novel-desk/api'
const MAX_BODY = 8 * 1024 * 1024

export const name = 'novel-desk'
export const inject = ['tools']

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function guard(req, connection) {
  const host = String(req.headers?.host ?? '')
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\]|\[::ffff:127\.0\.0\.1\])(:\d+)?$/.test(host)
  let rejection
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      rejection = connection.requestRejection(req)
    } catch {
      rejection = 403
    }
  } else if (!loopback) {
    rejection = 403
  }
  if (rejection === undefined) return undefined
  // 同源浏览器请求放行：插件自己的回环路由在部分宿主版本上不在 Cookie 门内。
  if (loopback && String(req.headers?.['sec-fetch-site'] ?? '') === 'same-origin') return undefined
  return rejection
}

async function handleRpc(body, ctx) {
  const op = String(body?.op ?? '')
  const root = defaultRoot()
  await ensureRoot(root)
  switch (op) {
    case 'ping':
      return { root }
    case 'library':
      return getLibrary(root)
    case 'bundle': {
      const id = String(body.projectId ?? '')
      if (!id) throw new Error('缺少 projectId')
      return getBundle(root, id)
    }
    case 'project.create':
      return createProject(root, body.input ?? {})
    case 'project.update':
      return updateProject(root, String(body.projectId ?? ''), body.patch ?? {})
    case 'project.delete':
      return deleteProject(root, String(body.projectId ?? ''))
    case 'chapter.save':
      return saveChapter(root, String(body.projectId ?? ''), body.chapter ?? {})
    case 'chapter.delete':
      return deleteChapter(root, String(body.projectId ?? ''), String(body.chapterId ?? ''))
    case 'chapter.history': {
      const projectId = String(body.projectId ?? '')
      const chapterId = String(body.chapterId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      if (!chapterId) throw new Error('缺少 chapterId')
      return listChapterHistory(root, projectId, chapterId)
    }
    case 'chapter.version': {
      const projectId = String(body.projectId ?? '')
      const chapterId = String(body.chapterId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      if (!chapterId) throw new Error('缺少 chapterId')
      if (!body.file) throw new Error('缺少 file')
      return readChapterHistoryVersion(root, projectId, chapterId, String(body.file))
    }
    case 'chapter.restore': {
      const projectId = String(body.projectId ?? '')
      const chapterId = String(body.chapterId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      if (!chapterId) throw new Error('缺少 chapterId')
      if (!body.file) throw new Error('缺少 file')
      return restoreChapterVersion(root, projectId, chapterId, String(body.file))
    }
    case 'entity.upsert':
      return upsertEntity(root, String(body.projectId ?? ''), String(body.kind ?? ''), body.item ?? {})
    case 'entity.delete':
      return deleteEntity(root, String(body.projectId ?? ''), String(body.kind ?? ''), String(body.entityId ?? ''))
    case 'entity.list':
      return getEntities(root, String(body.projectId ?? ''), String(body.kind ?? ''))
    case 'proposal.create':
      return createProposal(root, String(body.projectId ?? ''), body.proposal ?? {})
    case 'proposal.accept':
      return acceptProposal(root, String(body.projectId ?? ''), String(body.proposalId ?? ''), { optionId: body.optionId })
    case 'proposal.reject':
      return rejectProposal(root, String(body.projectId ?? ''), String(body.proposalId ?? ''))
    case 'proposal.feedback':
      return addProposalFeedback(root, String(body.projectId ?? ''), String(body.proposalId ?? ''), String(body.text ?? ''))
    case 'proposal.batchAccept': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      return batchAcceptProposals(root, projectId, Array.isArray(body.ids) ? body.ids : [])
    }
    case 'proposal.batchReject': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      return batchRejectProposals(root, projectId, Array.isArray(body.ids) ? body.ids : [])
    }
    case 'review.batchUpdate': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      if (!body.status) throw new Error('缺少 status')
      return batchUpdateReviews(root, projectId, Array.isArray(body.ids) ? body.ids : [], { status: String(body.status) })
    }
    case 'preset.builtin':
      return builtinPresets()
    case 'preset.add': {
      const template = builtinPresets().find((t) => t.id === body.templateId)
      if (!template) throw new Error(`内置预设不存在：${body.templateId}`)
      return addPresetFromTemplate(root, String(body.projectId ?? ''), template)
    }
    case 'preset.apply':
      return applyPreset(root, String(body.projectId ?? ''), String(body.presetId ?? ''))
    case 'import.scan': {
      const dirPath = String(body.path ?? '').trim()
      if (!dirPath) throw new Error('缺少 path')
      return scanImport(root, dirPath, { split: body.split })
    }
    case 'import.run':
      return runImport(root, {
        path: body.path,
        projectName: body.projectName,
        genre: body.genre,
        mode: body.mode,
        projectId: body.projectId,
        split: body.split,
      })
    case 'import.review': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      const bundle = await getBundle(root, projectId)
      if (bundle.chapters.length === 0) throw new Error('作品还没有章节，无法审阅')
      return persistImportReview(ctx, root, projectId, bundle)
    }
    case 'review.fix': {
      const projectId = String(body.projectId ?? '')
      const reviewId = String(body.reviewId ?? '')
      const bundle = await getBundle(root, projectId)
      const review = (bundle.reviews ?? []).find((row) => row.id === reviewId)
      if (!review) throw new Error('审稿意见不存在')
      const chapter = (bundle.chapters ?? []).find((row) => Number(row.id) === Number(review.chapter))
      if (!chapter) throw new Error(`第 ${review.chapter} 章不存在，无法按审稿修改`)
      const result = await runAiLogged(ctx, root, projectId, { task: 'review-fix', bundle, chapter: chapter.id, review })
      const json = result.json ?? {}
      const proposal = await createProposal(root, projectId, {
        kind: 'chapter',
        chapter: chapter.id,
        title: `（审稿修改）${chapter.title}`,
        summary: json.summary ?? review.suggestion ?? '按审稿意见修改',
        data: { title: json.title ?? chapter.title, summary: json.summary ?? '', content: json.content ?? '', chapter: chapter.id },
        rationale: `按审稿意见修改：${review.issue ?? ''}`,
        priority: severityPriority(review.severity),
        reviewId: review.id,
      })
      await upsertEntity(root, projectId, 'reviews', { id: review.id, fixProposalId: proposal.id })
      return { proposalId: proposal.id, reviewId: review.id }
    }
    case 'chat.sessions': {
      const controller = ctx.get('sessionController')
      if (!controller?.list) throw new Error('宿主未提供会话服务')
      const value = await controller.list({}, AbortSignal.timeout(15000))
      return { items: (value.items ?? []).map((item) => ({ sessionId: item.sessionId, cwd: item.cwd ?? '', updatedAt: item.updatedAt, running: item.running, blank: item.blank, origin: item.origin ?? null, parentSessionId: item.parentSessionId ?? null })) }
    }
    case 'chat.send': {
      const projectId = String(body.projectId ?? '')
      const bundle = await getBundle(root, projectId)
      const controller = ctx.get('sessionController')
      if (!controller?.list || !controller?.prompt) throw new Error('宿主未提供会话服务，无法发送到对话')
      const imports = await listImportRecords(root, projectId)
      const rootPath = bundle.project.rootPath || imports.at(-1)?.root || ''
      const prompt = String(body.prompt ?? '').trim() || buildHandoffPrompt(bundle, body, rootPath)
      if (body.dryRun && !body.checkTarget) return { dryRun: true, prompt, rootPath }
      const list = await controller.list({}, AbortSignal.timeout(15000))
      const explicit = body.sessionId ? (list.items ?? []).find((item) => item.sessionId === body.sessionId) : null
      const sessions = (list.items ?? []).filter((item) => !item.origin && !item.parentSessionId && !item.blank)
      if (!rootPath && !explicit) throw new Error('这个作品还没有关联工作区目录，无法确定发到哪个对话。请在「设置 → 工作区目录」里填上作品所在目录，或从对应工作区的对话里发送。')
      const sameWorkspace = rootPath ? sessions.filter((item) => item.cwd === rootPath) : sessions
      const preferred = explicit
        || sameWorkspace.find((item) => item.running)
        || sameWorkspace[0]
      if (!preferred) {
        throw new Error(rootPath
          ? `当前项目工作区（${rootPath}）没有打开的对话。请先在左侧切到该工作区的对话再发送，不会跨工作区自动发送。`
          : '没有可用的对话会话，请先在左侧打开一个对话')
      }
      if (body.dryRun) return { dryRun: true, prompt, rootPath, sessionId: preferred.sessionId, cwd: preferred.cwd ?? '' }
      await controller.prompt({
        requestId: randomUUID(),
        sessionId: preferred.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
        clientTimeZone: 'Asia/Shanghai',
      }, AbortSignal.timeout(20000))
      return { sessionId: preferred.sessionId, accepted: true, prompt, rootPath }
    }
    case 'usage.summary': {
      const projectId = String(body.projectId ?? '')
      const bundle = await getBundle(root, projectId)
      const records = await listUsageRecords(root, projectId)
      const now = Date.now()
      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
      const sum = (rows) => rows.reduce((acc, row) => {
        acc.calls += 1
        acc.inputTokens += Number(row.inputTokens) || 0
        acc.outputTokens += Number(row.outputTokens) || 0
        acc.cacheReadTokens += Number(row.cacheReadTokens) || 0
        acc.cacheWriteTokens += Number(row.cacheWriteTokens) || 0
        acc.totalTokens += Number(row.totalTokens) || 0
        acc.durationMs += Number(row.durationMs) || 0
        return acc
      }, { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, durationMs: 0 })
      const byTask = {}
      for (const row of records) {
        const key = row.task || '未知'
        if (!byTask[key]) byTask[key] = []
        byTask[key].push(row)
      }
      const byTaskRows = Object.entries(byTask).map(([task, rows]) => ({ task, ...sum(rows) })).sort((a, b) => b.totalTokens - a.totalTokens)
      const imports = await listImportRecords(root, projectId)
      const rootPath = bundle.project.rootPath || imports.at(-1)?.root || ''
      let rootSessions = []
      let subagentSessions = []
      let subagentCount = 0
      try {
        const sessionController = ctx.get('sessionController')
        if (sessionController?.list && rootPath) {
          const listed = await sessionController.list({}, AbortSignal.timeout(15000))
          const allItems = listed.items ?? []
          const roots = allItems.filter((item) => item.cwd === rootPath && !item.origin && !item.parentSessionId && !item.blank)
          const byParent = new Map()
          for (const item of allItems) {
            if (!item.parentSessionId) continue
            if (!byParent.has(item.parentSessionId)) byParent.set(item.parentSessionId, [])
            byParent.get(item.parentSessionId).push(item.sessionId)
          }
          const descendantIds = new Set()
          let frontier = new Set(roots.map((item) => item.sessionId))
          while (frontier.size > 0) {
            const next = new Set()
            for (const id of frontier) {
              for (const childId of byParent.get(id) ?? []) {
                if (descendantIds.has(childId)) continue
                descendantIds.add(childId)
                next.add(childId)
              }
            }
            frontier = next
          }
          subagentCount = descendantIds.size
          const selected = [...roots, ...allItems.filter((item) => descendantIds.has(item.sessionId))]
          const groups = new Map()
          for (const item of selected) {
            const cwd = item.cwd || rootPath
            if (!groups.has(cwd)) groups.set(cwd, [])
            groups.get(cwd).push(item.sessionId)
          }
          const loaded = []
          for (const [cwd, ids] of groups) {
            const part = await loadChatUsage(cwd, { sessionIds: ids })
            loaded.push(...part.sessions)
          }
          rootSessions = loaded.filter((session) => roots.some((item) => item.sessionId === session.id))
          subagentSessions = loaded.filter((session) => descendantIds.has(session.id))
        }
      } catch {
        rootSessions = []
        subagentSessions = []
        subagentCount = 0
      }
      if (rootSessions.length === 0) {
        const fallback = await loadChatUsage(rootPath)
        rootSessions = fallback.sessions
      }
      const allChatSessions = [...rootSessions, ...subagentSessions]
      const prices = await loadModelPrices()
      let chatCostUSD = 0
      let chatCostCNY = 0
      let unpricedSessions = 0
      let workbenchCostUSD = 0
      for (const row of records) {
        const cost = estimateSessionCost({
          provider: row.provider,
          model: row.model,
          events: [{ time: Date.parse(row.at) || Date.now(), inputTokens: row.inputTokens ?? 0, cacheReadTokens: row.cacheReadTokens ?? 0, cacheWriteTokens: row.cacheWriteTokens ?? 0, outputTokens: row.outputTokens ?? 0 }],
        }, prices)
        if (cost) workbenchCostUSD += cost.usd
      }
      const costOf = (session) => {
        const cost = estimateSessionCost(session, prices)
        if (cost) {
          chatCostUSD += cost.usd
          chatCostCNY += cost.cny
        } else {
          unpricedSessions += 1
        }
        return cost
      }
      const shapeSession = (session, cost, isSubagent = false) => ({
        id: session.id,
        cwd: session.cwd,
        createdAt: session.createdAt,
        lastAt: session.lastAt,
        messages: session.messages,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        cacheReadTokens: session.cacheReadTokens,
        totalTokens: session.totalTokens,
        model: session.model,
        provider: session.provider,
        isSubagent,
        costUSD: cost?.usd ?? null,
        costCNY: cost?.cny ?? null,
      })
      const chatSessions = rootSessions.map((session) => shapeSession(session, costOf(session)))
      const subagentRows = subagentSessions.map((session) => shapeSession(session, costOf(session), true))
      const subagentTokens = subagentRows.reduce((sum, row) => sum + row.totalTokens, 0)
      const subagentCostUSD = subagentRows.reduce((sum, row) => sum + (row.costUSD ?? 0), 0)
      const subagentCostCNY = subagentRows.reduce((sum, row) => sum + (row.costCNY ?? 0), 0)
      const totalChatTokens = allChatSessions.reduce((sum, session) => sum + (session.totalTokens || 0), 0)
      const chat = {
        cwd: rootPath,
        sessions: chatSessions,
        subagents: { count: subagentCount, sessions: subagentRows, totalTokens: subagentTokens, costUSD: Math.round(subagentCostUSD * 10000) / 10000, costCNY: Math.round(subagentCostCNY * 10000) / 10000 },
        totalTokens: totalChatTokens,
      }
      const context = estimateContext(bundle)
      const backupCount = await countBackupFiles(root, projectId)
      const acceptedProposals = (bundle.proposals ?? []).filter((row) => row.status === 'accepted').length
      const fixedReviews = (bundle.reviews ?? []).filter((row) => row.status === 'fixed').length
      const chatSpanMs = chat.sessions.reduce((sum, session) => sum + Math.max(0, (session.lastAt || 0) - (session.createdAt || 0)), 0)
      const days = new Map()
      const dayOf = (time) => new Date(time).toISOString().slice(0, 10)
      for (const row of records) {
        const key = dayOf(row.at)
        if (!days.has(key)) days.set(key, { date: key, workbenchTokens: 0, chatTokens: 0, aiCalls: 0, chatMessages: 0 })
        const bucket = days.get(key)
        bucket.workbenchTokens += Number(row.totalTokens) || 0
        bucket.aiCalls += 1
      }
      for (const session of [...rootSessions, ...subagentSessions]) {
        for (const [key, value] of Object.entries(session.days ?? {})) {
          if (!days.has(key)) days.set(key, { date: key, workbenchTokens: 0, chatTokens: 0, aiCalls: 0, chatMessages: 0 })
          const bucket = days.get(key)
          bucket.chatTokens += value.tokens ?? 0
          bucket.chatMessages += value.messages ?? 0
        }
      }
      const activity = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-14)
      const activeDays = activity.filter((row) => row.workbenchTokens + row.chatTokens > 0).length
      return {
        projectId,
        rootPath,
        context,
        metrics: {
          words: bundle.stats.words,
          chapters: bundle.chapters.length,
          edits: backupCount,
          reviews: (bundle.reviews ?? []).length,
          fixedReviews,
          openReviews: bundle.stats.openReviews,
          acceptedProposals,
          pendingProposals: bundle.stats.pendingProposals,
          imports: imports.length,
          aiCalls: records.length,
          sessionCount: rootSessions.length,
          subagentCount,
          activeDays,
          chatHours: Math.round((chatSpanMs / 3600000) * 10) / 10,
          aiMinutes: Math.round(((sum(records).durationMs) / 60000) * 10) / 10,
          chatCostUSD: Math.round(chatCostUSD * 10000) / 10000,
          chatCostCNY: Math.round(chatCostCNY * 10000) / 10000,
          workbenchCostUSD: Math.round(workbenchCostUSD * 10000) / 10000,
          workbenchCostCNY: Math.round((workbenchCostUSD / 0.15) * 10000) / 10000,
          totalCostUSD: Math.round((chatCostUSD + workbenchCostUSD) * 10000) / 10000,
          totalCostCNY: Math.round(((chatCostUSD + workbenchCostUSD) / 0.15) * 10000) / 10000,
          unpricedSessions,
        },
        activity,
        workbench: {
          total: sum(records),
          today: sum(records.filter((row) => new Date(row.at).getTime() >= startOfDay.getTime())),
          byTask: byTaskRows,
          recent: records.slice(-20).reverse(),
        },
        chat,
        cost: { usd: Math.round((chatCostUSD + workbenchCostUSD) * 10000) / 10000, cny: Math.round(((chatCostUSD + workbenchCostUSD) / 0.15) * 10000) / 10000, unpricedSessions },
        lanes: [
          { id: 'workbench', label: '工作台 AI', kind: 'one-shot', hint: '点一次按钮 = 一次独立调用，不进入对话历史；上下文由工作台按项目拼装，结果进提案/审稿。' },
          { id: 'chat', label: 'DSH 对话', kind: 'agent-session', hint: '左侧对话框的 Agent 会话，多轮、可调 novel_desk_* 工具；用量从 session 日志读取。' },
        ],
      }
    }
    case 'export':
      return exportBook(root, String(body.projectId ?? ''), body.format ?? 'md')
    case 'ai.run': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      const bundle = await getBundle(root, projectId)
      const proposal = body.proposalId ? (bundle.proposals ?? []).find((p) => p.id === body.proposalId) : null
      if (body.proposalId && !proposal) throw new Error(`提案不存在：${body.proposalId}`)
      const feedback = proposal
        ? (body.feedback ?? (proposal.feedback ?? []).map((f) => f.text).join('\n'))
        : body.instruction
      const result = await runAiLogged(ctx, root, projectId, {
        task: proposal ? 'revise-proposal' : String(body.task ?? 'next-chapter-plan'),
        bundle,
        chapter: body.chapter ?? proposal?.chapter,
        instruction: body.instruction,
        proposal,
        feedback,
      })
      const saved = await persistAiResult(root, projectId, result, body)
      return { task: result.task, saved, raw: result.raw.slice(0, 4000) }
    }
    default:
      throw new Error(`未知操作：${op || '(空)'}`)
  }
}

/** 把 AI 结果落成提案/审稿。 */
async function persistAiResult(root, projectId, result, request) {
  const json = result.json ?? {}
  const bundle = await getBundle(root, projectId)
  if (result.task === 'revise-proposal') {
    const old = (bundle.proposals ?? []).find((p) => p.id === request.proposalId)
    if (!old) throw new Error(`提案不存在：${request.proposalId}`)
    const common = { kind: old.kind, chapter: old.chapter, title: `（修订）${old.title}`, revisedFrom: old.id }
    let created
    if (old.kind === 'plan' || old.kind === 'chapter' || old.kind === 'custom') {
      created = await createProposal(root, projectId, { ...common, summary: json.summary ?? old.summary, data: { ...json, chapter: old.chapter ?? json.chapter }, rationale: '按作者修改意见重写。' })
    } else if (old.kind === 'decision') {
      const base = old.data ?? {}
      created = await createProposal(root, projectId, {
        ...common,
        summary: json.summary ?? json.answer?.slice(0, 200) ?? old.summary,
        data: {
          ...base,
          ...json,
          conflictType: base.conflictType,
          reviewId: base.reviewId,
          options: Array.isArray(json.options) && json.options.length > 0 ? json.options : base.options,
        },
        rationale: '按作者修改意见调整冲突决策。',
        priority: old.priority,
      })
    } else {
      const items = Array.isArray(json.items)
        ? json.items
        : Array.isArray(json[old.kind])
          ? json[old.kind]
          : Array.isArray(json.outlines)
            ? json.outlines
            : []
      created = await createProposal(root, projectId, { ...common, summary: `按意见修订，共 ${items.length} 条`, items, rationale: '按作者修改意见重写。' })
    }
    await markProposalRevised(root, projectId, old.id, created.id)
    return { kind: 'proposal', proposalId: created.id, revisedFrom: old.id }
  }
  const nextChapter = bundle.chapters.length > 0 ? Math.max(...bundle.chapters.map((c) => Number(c.id) || 0)) + 1 : 1
  const chapter = Number(request.chapter) || Number(json.chapter) || nextChapter

  if (result.task === 'review-chapter') {
    const reviews = Array.isArray(json.reviews) ? json.reviews : []
    for (const review of reviews) {
      await upsertEntity(root, projectId, 'reviews', { ...review, chapter, source: 'ai', status: 'open' })
    }
    for (const highlight of Array.isArray(json.highlights) ? json.highlights : []) {
      await upsertEntity(root, projectId, 'highlights', { ...highlight, chapter, source: 'ai' })
    }
    return { kind: 'reviews', count: reviews.length, overall: json.overall ?? '' }
  }

  if (result.task === 'next-chapter-plan') {
    const proposal = await createProposal(root, projectId, {
      kind: 'plan',
      chapter,
      title: json.title ?? `第 ${chapter} 章方案`,
      summary: json.summary ?? '',
      data: json,
      rationale: 'AI 生成的章节方案，包含事件、事实、伏笔，可逐项采纳。',
    })
    return { kind: 'proposal', proposalId: proposal.id, chapter }
  }

  if (result.task === 'continue-chapter') {
    const proposal = await createProposal(root, projectId, {
      kind: 'chapter',
      chapter,
      title: json.title ?? `第 ${chapter} 章`,
      summary: json.summary ?? '',
      data: { ...json, chapter },
      rationale: 'AI 生成的章节正文，采纳后会写入章节并备份旧稿。',
    })
    return { kind: 'proposal', proposalId: proposal.id, chapter, chars: String(json.content ?? '').length }
  }

  if (result.task === 'generate-timeline') {
    const proposal = await createProposal(root, projectId, {
      kind: 'events',
      chapter,
      title: `第 ${chapter} 章时间线（AI）`,
      summary: `AI 生成 ${Array.isArray(json.events) ? json.events.length : 0} 条事件`,
      items: Array.isArray(json.events) ? json.events : [],
      rationale: '采纳后写入时间线。',
    })
    return { kind: 'proposal', proposalId: proposal.id }
  }

  if (result.task === 'extract-facts') {
    const proposal = await createProposal(root, projectId, {
      kind: 'facts',
      chapter,
      title: `第 ${chapter} 章事实抽取（AI）`,
      items: Array.isArray(json.facts) ? json.facts : [],
      rationale: '采纳后写入事实账本。',
    })
    const characterProposal = Array.isArray(json.characters) && json.characters.length > 0
      ? await createProposal(root, projectId, {
          kind: 'characters',
          chapter,
          title: `第 ${chapter} 章人物抽取（AI）`,
          items: json.characters,
          rationale: '采纳后写入人物库。',
        })
      : null
    return { kind: 'proposal', proposalId: proposal.id, characterProposalId: characterProposal?.id }
  }

  // custom：模型返回 proposals 数组时逐条落提案
  const list = Array.isArray(json.proposals) ? json.proposals : []
  const ids = []
  for (const item of list) {
    const proposal = await createProposal(root, projectId, {
      kind: item.kind ?? 'custom',
      chapter: item.chapter || chapter,
      title: item.title ?? 'AI 提案',
      summary: item.summary ?? '',
      data: item.data ?? {},
      items: Array.isArray(item.items) ? item.items : [],
      rationale: json.answer ?? '',
    })
    ids.push(proposal.id)
  }
  if (ids.length === 0) {
    const proposal = await createProposal(root, projectId, {
      kind: 'custom',
      chapter,
      title: 'AI 回答',
      summary: String(json.answer ?? '').slice(0, 800),
      data: json,
      rationale: '自由指令结果。',
    })
    ids.push(proposal.id)
  }
  return { kind: 'proposal', proposalIds: ids }
}

const SEVERITY_PRIORITY = { blocker: 1, major: 2, minor: 3, suggestion: 4 }
function severityPriority(severity) {
  return SEVERITY_PRIORITY[severity] ?? 3
}

/** 同一 主体+属性 有多个取值 → 决策提案，让作者选一条路。 */
async function createFactDecisionProposals(root, projectId, bundle) {
  const groups = new Map()
  for (const fact of bundle.facts ?? []) {
    if (fact.superseded || !fact.subject || !fact.attribute) continue
    const key = `${fact.subject}\u0000${fact.attribute}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(fact)
  }
  let created = 0
  for (const facts of groups.values()) {
    const values = [...new Map(facts.map((fact) => [String(fact.value), fact])).values()]
    if (values.length < 2) continue
    const title = `事实冲突：${facts[0].subject} · ${facts[0].attribute}`
    if ((bundle.proposals ?? []).some((proposal) => proposal.status === 'pending' && proposal.title === title)) continue
    await createProposal(root, projectId, {
      kind: 'decision',
      chapter: facts[0].chapter ?? null,
      title,
      summary: `「${facts[0].subject}」的「${facts[0].attribute}」有 ${values.length} 个取值，请选择以哪个为准。`,
      data: {
        conflictType: 'fact',
        subject: facts[0].subject,
        attribute: facts[0].attribute,
        facts: facts.map((fact) => ({ id: fact.id, value: fact.value, chapter: fact.chapter })),
        options: values.map((fact) => ({ id: `fact-${fact.id}`, label: `以「${fact.value}」为准（第${fact.chapter ?? '?'}章）`, factId: fact.id })),
      },
      priority: 1,
      rationale: '事实账本内部冲突，需要作者裁定哪个取值是正史。',
    })
    created += 1
  }
  return created
}

/** 导入后的 AI 补全 + 冲突核查：缺什么补什么，冲突进审稿 + 决策提案。 */
async function persistImportReview(ctx, root, projectId, bundle) {
  const proposalIds = []
  const counts = { characters: 0, events: 0, outlines: 0, conflicts: 0, decisions: 0 }
  const errors = []
  const decisionTitles = new Set((bundle.proposals ?? []).filter((proposal) => proposal.kind === 'decision').map((proposal) => proposal.title))

  const fill = async (task, kind, title, key) => {
    try {
      const result = await runAiLogged(ctx, root, projectId, { task, bundle })
      const items = Array.isArray(result.json?.[key]) ? result.json[key] : []
      if (items.length === 0) return
      const proposal = await createProposal(root, projectId, {
        kind,
        chapter: items[0]?.chapter ?? null,
        title,
        summary: `AI 识别到 ${items.length} 条可补充的${kind === 'characters' ? '人物' : kind === 'events' ? '事件' : '大纲'}，采纳后写入账本。`,
        items,
        rationale: '基于正文与已导入设定生成，未自动写入。',
      })
      proposalIds.push(proposal.id)
      counts[kind] = items.length
    } catch (error) {
      errors.push(`${task}: ${error.message}`)
    }
  }

  if (bundle.characters.length === 0) await fill('import-fill-characters', 'characters', '人物卡补全（AI）', 'characters')
  if (bundle.events.length === 0) await fill('import-fill-events', 'events', '时间线补全（AI）', 'events')
  if (bundle.outlines.length === 0) await fill('import-fill-outlines', 'outlines', '大纲补全（AI）', 'outlines')

  // 已经有审稿记录就不再重复跑冲突核查，避免重复点击产生重复意见
  if ((bundle.reviews ?? []).length === 0) try {
    const result = await runAiLogged(ctx, root, projectId, { task: 'import-conflicts', bundle })
    const conflicts = Array.isArray(result.json?.conflicts) ? result.json.conflicts : []
    for (const conflict of conflicts) {
      const issue = conflict.issue ?? ''
      const duplicate = (bundle.reviews ?? []).some((review) => Number(review.chapter) === Number(conflict.chapter) && review.issue === issue)
      if (duplicate) continue
      const savedReview = await upsertEntity(root, projectId, 'reviews', {
        chapter: conflict.chapter,
        dimension: conflict.dimension ?? '连续性',
        severity: conflict.severity ?? 'major',
        issue,
        suggestion: conflict.suggestion ?? '',
        status: 'open',
        source: 'ai',
        against: conflict.against ?? '',
      })
      counts.conflicts += 1
      const decisionTitle = `冲突决策 · 第${conflict.chapter}章：${issue.slice(0, 36)}`
      if (decisionTitles.has(decisionTitle)) continue
      decisionTitles.add(decisionTitle)
      const proposal = await createProposal(root, projectId, {
        kind: 'decision',
        chapter: conflict.chapter,
        title: decisionTitle,
        summary: issue.slice(0, 200),
        data: {
          conflictType: 'review',
          reviewId: savedReview.id,
          reviewIssue: issue,
          suggestion: conflict.suggestion ?? '',
          options: [
            { id: 'text', label: '以正文为准（改设定/大纲）', mark: 'fixed' },
            { id: 'setting', label: '以设定为准（改正文）', mark: 'fixed' },
            { id: 'later', label: '先保留，之后人工决定', mark: 'open' },
          ],
        },
        priority: severityPriority(conflict.severity),
        rationale: conflict.suggestion ?? '',
      })
      proposalIds.push(proposal.id)
      counts.decisions += 1
    }
  } catch (error) {
    errors.push(`import-conflicts: ${error.message}`)
  }

  // 为已有的未处理审稿补决策提案（backfill，避免重复导入后没有提案）
  for (const review of bundle.reviews ?? []) {
    if (review.status === 'fixed' || review.status === 'wontfix') continue
    const issue = review.issue ?? ''
    if (!issue) continue
    const decisionTitle = `冲突决策 · 第${review.chapter}章：${issue.slice(0, 36)}`
    if (decisionTitles.has(decisionTitle)) continue
    decisionTitles.add(decisionTitle)
    const proposal = await createProposal(root, projectId, {
      kind: 'decision',
      chapter: review.chapter,
      title: decisionTitle,
      summary: issue.slice(0, 200),
      data: {
        conflictType: 'review',
        reviewId: review.id,
        reviewIssue: issue,
        suggestion: review.suggestion ?? '',
        options: [
          { id: 'text', label: '以正文为准（改设定/大纲）', mark: 'fixed' },
          { id: 'setting', label: '以设定为准（改正文）', mark: 'fixed' },
          { id: 'later', label: '先保留，之后人工决定', mark: 'open' },
        ],
      },
      priority: severityPriority(review.severity),
      rationale: review.suggestion ?? '',
    })
    proposalIds.push(proposal.id)
    counts.decisions += 1
  }

  counts.decisions += await createFactDecisionProposals(root, projectId, bundle)

  return { proposalIds, counts, reviews: counts.conflicts, errors }
}

async function countBackupFiles(root, projectId) {
  try {
    const entries = await readdir(join(root, 'projects', projectId, '.backups'), { recursive: true, withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).length
  } catch {
    return 0
  }
}

const TASK_LABEL = {
  'next-chapter-plan': '生成下一章方案',
  'review-chapter': '审阅一章',
  'review-fix': '按审稿意见修改',
  'revise-proposal': '按作者意见修订提案',
  'continue-chapter': '续写章节',
  'extract-facts': '抽取事实账本',
  'generate-events': '生成时间线',
  'import-review': '导入后审阅',
}

/** 工作台 → 对话 的交接 prompt。 */
function buildHandoffPrompt(bundle, body = {}, rootPath = '') {
  const task = String(body.task ?? 'custom')
  const project = bundle.project
  const lines = [
    `【工作台交接】项目《${project.name}》 projectId=${project.id}${rootPath ? `，工作区=${rootPath}` : ''}`,
    `进度：${bundle.chapters.length} 章 / ${bundle.stats.words} 字；人物 ${bundle.characters.length}；大纲 ${bundle.outlines.length}；事件 ${bundle.events.length}；事实 ${bundle.facts.length}；伏笔 ${bundle.foreshadow.length}；待处理提案 ${bundle.stats.pendingProposals}；审稿 ${bundle.stats.openReviews}。`,
  ]
  const chapter = Number(body.chapter) || null
  if (chapter) {
    const hit = (bundle.chapters ?? []).find((row) => Number(row.id) === chapter)
    lines.push(`目标章节：第 ${chapter} 章${hit ? `《${hit.title}》` : ''}`)
  }
  if (body.reviewId) {
    const review = (bundle.reviews ?? []).find((row) => row.id === body.reviewId)
    if (review) {
      lines.push('', '要处理的审稿意见：', `- 第${review.chapter}章 · ${review.dimension ?? ''} · ${review.severity ?? ''}`, `- 问题：${review.issue ?? ''}`, `- 建议：${review.suggestion ?? ''}`)
    }
  }
  if (body.proposalId) {
    const proposal = (bundle.proposals ?? []).find((row) => row.id === body.proposalId)
    if (proposal) {
      lines.push('', `待修订提案：${proposal.title}（kind=${proposal.kind}，第${proposal.chapter ?? '—'}章）`, `提案摘要：${proposal.summary ?? ''}`)
      const feedback = String(body.feedback ?? '').trim()
      if (feedback) lines.push(`作者修改意见：${feedback}`)
    }
  }
  const items = Array.isArray(body.items) ? body.items.filter((item) => item && item.id) : []
  if (items.length > 0) {
    lines.push('', `本次清单（${items.length} 项）：`)
    items.forEach((item, index) => {
      const label = { review: '审稿', proposal: '提案', check: '检查', chapter: '章节', foreshadow: '伏笔' }[item.kind] ?? item.kind ?? '条目'
      const parts = [`${index + 1}. [${label}]`]
      if (item.chapter) parts.push(`第${item.chapter}章`)
      if (item.title) parts.push(item.title)
      if (item.detail) parts.push(`：${item.detail}`)
      if (item.note) parts.push(`；作者补充：${item.note}`)
      parts.push(`（id=${item.id}）`)
      lines.push(parts.join(' '))
    })
    lines.push('', '处理要求：逐项处理；每完成一项就立刻把结果写回工作台（novel_desk_propose 提交提案 / novel_desk_review 写审稿 / novel_desk_upsert 更新状态），不要攒到最后。')
    if (body.allowContinue) lines.push('如果下一步是明确的小步，可以直接继续，不必每步都问；涉及大范围改动或改设定时先问我。')
    else lines.push('完成清单后停下来，逐项汇报结果，并问我要不要继续下一批/下一步。')
  }
  if (String(body.instruction ?? '').trim()) lines.push('', `补充要求：${String(body.instruction).trim()}`)
  if (items.length === 0) lines.push('', `任务：${TASK_LABEL[task] ?? task}`)
  if (task === 'review-fix') lines.push('请按审稿意见修改对应章节，把修改后的完整章节提交为 chapter 提案（novel_desk_propose），不要直接覆盖正文。')
  else if (task === 'revise-proposal') lines.push('请按作者意见修订原提案，提交为新的提案（novel_desk_propose），不要直接改账本。')
  else if (task === 'import-review') lines.push('请先用 novel_desk_bundle / novel_desk_context 读取项目：补齐缺失的人物卡、时间线、大纲（提交提案）；再对照人物卡、时间线、事实、大纲核查正文冲突，写入审稿（novel_desk_review）。')
  else if (task === 'next-chapter-plan') lines.push('请读取大纲和最近章节，提交一份下一章方案提案（plan，包含事件/事实/伏笔）。')
  else if (task === 'review-chapter') lines.push('请审阅目标章节，把问题写入审稿（novel_desk_review），不要直接改正文。')
  lines.push('', '工作台只负责展示和验收：所有写入都用提案/审稿，采纳由我在工作台点。完成后告诉我生成了哪些提案/审稿。')
  return lines.join('\n')
}

function usageRow(result, options, durationMs, ok, error) {
  const usage = result?.usage ?? {}
  const total = Number(usage.totalTokens) || (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0)
  return {
    source: 'workbench',
    task: options.task,
    chapter: options.chapter ?? options.proposal?.chapter ?? options.review?.chapter ?? null,
    proposalId: options.proposal?.id ?? null,
    reviewId: options.review?.id ?? null,
    model: result?.model ?? '',
    provider: result?.provider ?? '',
    inputTokens: Number(usage.inputTokens) || 0,
    outputTokens: Number(usage.outputTokens) || 0,
    cacheReadTokens: Number(usage.cacheReadTokens) || 0,
    cacheWriteTokens: Number(usage.cacheWriteTokens) || 0,
    reasoningTokens: Number(usage.reasoningTokens) || 0,
    totalTokens: total,
    durationMs,
    ok,
    error: error ? String(error).slice(0, 500) : '',
  }
}

/** 带用量记账的 AI 调用。 */
async function runAiLogged(ctx, root, projectId, options) {
  const startedAt = Date.now()
  try {
    const result = await runAi(ctx, options)
    await appendUsageRecord(root, projectId, usageRow(result, options, Date.now() - startedAt, true))
    return result
  } catch (error) {
    await appendUsageRecord(root, projectId, usageRow(null, options, Date.now() - startedAt, false, error?.message ?? error))
    throw error
  }
}

function mountRoute(ctx) {
  ctx.inject(['webServer'], (c) => {
    const webServer = c.webServer
    if (!webServer || typeof webServer.register !== 'function') return
    const connection = c.get?.('connection')
    const dispose = webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        const rejection = guard(req, connection)
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (req.method === 'GET' && url.pathname.endsWith('/ping')) {
          sendJson(res, 200, { ok: true, value: await handleRpc({ op: 'ping' }, ctx) })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'bad-request', message: '只支持 POST' } })
          return
        }
        try {
          const body = await readBody(req)
          sendJson(res, 200, { ok: true, value: await handleRpc(body, ctx) })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) } })
        }
      },
    })
    c.effect(() => () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 已清理 */
      }
    }, 'novel-desk: api route')
  })
}

// ── Agent 工具 ────────────────────────────────────────────────

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

async function resolveProject(nameOrId) {
  const root = defaultRoot()
  await ensureRoot(root)
  const projects = await listProjects(root)
  if (projects.length === 0) throw new Error('作品库为空：请先在工作台新建作品。')
  if (!nameOrId) return projects.length === 1 ? projects[0] : null
  const key = String(nameOrId).trim()
  return projects.find((p) => p.id === key || p.name === key) ?? null
}

async function requireProject(nameOrId) {
  const project = await resolveProject(nameOrId)
  if (!project) throw new Error(`找不到作品「${nameOrId}」。先用 novel_desk_projects 查看列表。`)
  return project
}

const projectsTool = {
  name: 'novel_desk_projects',
  description: '列出「长篇中文小说工作台」里的全部作品（名称、类型、章节数、字数、更新时间）。数据在 ~/StoryDesk，是普通 Markdown/JSON 文件。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: textOutput,
  async execute() {
    const lib = await getLibrary(defaultRoot())
    if (lib.projects.length === 0) return `作品库为空。数据根目录：${lib.root}\n请先在 Web UI 侧栏打开「长篇中文小说工作台」新建作品。`
    const lines = [`# 作品库（${lib.projects.length} 部）`, `数据根目录：${lib.root}`, '']
    for (const p of lib.projects) {
      lines.push(`## ${p.name}（id: ${p.id}）`)
      lines.push(`- 类型：${p.genre || '未填'} ｜ 章节：${p.chapters} ｜ 字数：${p.words}`)
      lines.push(`- 更新：${p.updatedAt ?? '—'}`)
    }
    return lines.join('\n')
  },
}

const bundleTool = {
  name: 'novel_desk_bundle',
  description: '读取作品的完整结构：作品设定、写作预设、章节列表、事实账本、时间线、伏笔、冲突、人物、高光、审稿、待采纳提案、计划对齐、一致性检查。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      kind: { type: 'string', enum: ['summary', 'chapters', 'facts', 'events', 'foreshadow', 'conflicts', 'characters', 'highlights', 'presets', 'outlines', 'reviews', 'proposals', 'agents', 'alignment', 'checks'], description: '要看的部分，默认 summary' },
    },
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args) {
    const project = await requireProject(args?.project)
    const bundle = await getBundle(defaultRoot(), project.id)
    const kind = args?.kind ?? 'summary'
    const lines = [`# ${bundle.project.name}`, '']
    if (kind === 'summary' || kind === 'chapters') {
      lines.push(`类型：${bundle.project.genre || '—'} ｜ 视角：${bundle.project.pov || '—'} ｜ 时态：${bundle.project.tense || '—'}`)
      lines.push(`进度：${bundle.stats.chapters} 章 / ${bundle.stats.words} 字 ｜ 待采纳提案：${bundle.stats.pendingProposals} ｜ 未处理审稿：${bundle.stats.openReviews}`)
      lines.push('', `## 章节（${bundle.chapters.length}）`, ...bundle.chapters.map((c) => `- 第 ${c.id} 章《${c.title}》 ${c.words} 字 ｜ ${c.status}${c.summary ? ` ｜ ${c.summary}` : ''}`))
    }
    if (kind === 'summary' || kind === 'checks') {
      lines.push('', `## 一致性检查（${bundle.checks.length}）`, ...bundle.checks.map((c) => `- [${c.level}] ${c.title}：${c.detail}`))
    }
    if (kind === 'summary' || kind === 'alignment') {
      const a = bundle.alignment
      lines.push('', '## 计划对齐', `- 章节：${a.actualChapters} / ${a.plannedChapters || '未设'}（${a.chapterProgress ?? '—'}%）`)
      lines.push(`- 字数：${a.actualWords} / ${a.totalWords || '未设'}（${a.wordProgress ?? '—'}%）｜ 每章目标 ${a.chapterWords || '未设'}`)
      for (const row of a.perChapter) lines.push(`- 第 ${row.id} 章：${row.words} 字（${row.delta === null ? '无目标' : (row.delta >= 0 ? '+' : '') + row.delta}）｜事件 ${row.events}｜事实 ${row.facts}｜待审 ${row.openReviews}`)
    }
    if (kind === 'facts') lines.push('', `## 事实账本（${bundle.facts.length}）`, ...bundle.facts.map((f) => `- [第${f.chapter ?? '?'}章] ${f.subject} · ${f.attribute} = ${f.value}`))
    if (kind === 'events') lines.push('', `## 时间线（${bundle.events.length}）`, ...bundle.events.map((e) => `- [第${e.chapter ?? '?'}章 ｜ ${e.storyTime || '时间未填'}] ${e.title}${e.summary ? `：${e.summary}` : ''}`))
    if (kind === 'foreshadow') lines.push('', `## 伏笔（${bundle.foreshadow.length}）`, ...bundle.foreshadow.map((f) => `- ${f.title} ｜ 第${f.setupChapter ?? '?'}章 → 第${f.payoffChapter ?? '?'}章 ｜ ${f.status ?? 'open'}`))
    if (kind === 'conflicts') lines.push('', `## 冲突（${bundle.conflicts.length}）`, ...bundle.conflicts.map((c) => `- ${c.title} ｜ ${c.type ?? ''} ｜ ${c.status ?? 'active'} ｜ 赌注：${c.stakes ?? '—'}`))
    if (kind === 'characters') lines.push('', `## 人物（${bundle.characters.length}）`, ...bundle.characters.map((c) => `- ${c.name} ｜ ${c.role ?? ''} ｜ 目标：${c.goal ?? '—'} ｜ 缺陷：${c.flaw ?? '—'}`))
    if (kind === 'highlights') lines.push('', `## 高光（${bundle.highlights.length}）`, ...bundle.highlights.map((x) => `- [第${x.chapter ?? '?'}章] ${x.text ?? ''}`))
    if (kind === 'outlines') lines.push('', `## 章节大纲（${bundle.outlines.length}）`, ...bundle.outlines.slice(0, 60).map((o) => `- 第${o.chapter}章 ${o.title}${o.summary ? `：${String(o.summary).slice(0, 80)}` : ''}`))
    if (kind === 'presets') lines.push('', `## 写作预设（${bundle.presets.length}）`, ...bundle.presets.map((p) => `- ${p.name} ｜ 计划 ${p.plannedChapters ?? '—'} 章 × ${p.chapterWords ?? '—'} 字 ｜ ${p.pov ?? ''} ｜ ${p.tone ?? ''}`))
    if (kind === 'reviews') lines.push('', `## 审稿（${bundle.reviews.length}）`, ...bundle.reviews.map((r) => `- [第${r.chapter ?? '?'}章 ｜ ${r.severity ?? ''} ｜ ${r.dimension ?? ''}] ${r.issue ?? ''} → ${r.suggestion ?? ''}（${r.status ?? 'open'}）`))
    if (kind === 'proposals') lines.push('', `## 提案（${bundle.proposals.length}）`, ...bundle.proposals.map((p) => `- [${p.status}] ${p.kind} · ${p.title}${p.summary ? `：${p.summary}` : ''}`))
    if (kind === 'agents') lines.push('', `## Agent 分工（${bundle.agents.length}）`, ...bundle.agents.map((a) => `- ${a.order}. ${a.name}：${a.duty}`))
    return lines.join('\n')
  },
}

const contextTool = {
  name: 'novel_desk_context',
  description: '生成写作上下文：作品设定与写作预设（计划章数/每章字数/结构/风格/禁忌）、9 个 Agent 分工、人物卡、事实账本、时间线、未回收伏笔、进行中冲突、未处理审稿、待采纳提案、最近章节。写新章或审稿前调用。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      recent: { type: 'integer', minimum: 0, maximum: 10, description: '带入最近几章摘要与结尾，默认 2' },
    },
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args) {
    const project = await requireProject(args?.project)
    const bundle = await getBundle(defaultRoot(), project.id)
    const recent = Number.isInteger(args?.recent) ? args.recent : 2
    const preset = bundle.presets[0] ?? {}
    const lines = [`# 写作上下文 · ${bundle.project.name}`, '']
    lines.push('## 作品设定')
    lines.push(`- 类型：${bundle.project.genre || '—'} ｜ 视角：${bundle.project.pov || '—'} ｜ 时态：${bundle.project.tense || '—'}`)
    lines.push(`- 一句话：${bundle.project.logline || '—'}`)
    lines.push(`- 进度：${bundle.stats.chapters} 章 / ${bundle.stats.words} 字`)
    lines.push('', '## 写作预设')
    lines.push(`- ${preset.name ?? '未设置'}：计划 ${preset.plannedChapters ?? '—'} 章 × ${preset.chapterWords ?? '—'} 字，总 ${preset.totalWords ?? '—'} 字`)
    lines.push(`- 结构：${preset.structure ?? '—'}`)
    lines.push(`- 风格规则：${Array.isArray(preset.styleRules) ? preset.styleRules.join('；') : preset.styleRules ?? '—'}`)
    lines.push(`- 禁忌：${Array.isArray(preset.taboo) ? preset.taboo.join('；') : preset.taboo ?? '—'}`)
    lines.push(`- 审稿重点：${Array.isArray(preset.reviewFocus) ? preset.reviewFocus.join('；') : preset.reviewFocus ?? '—'}`)
    if (bundle.agents.length > 0) {
      lines.push('', '## Agent 分工')
      for (const a of bundle.agents) lines.push(`- ${a.name}：${a.duty}`)
    }
    if (bundle.characters.length > 0) {
      lines.push('', '## 人物卡')
      for (const c of bundle.characters) lines.push(`- ${c.name}（${c.role || '—'}）：目标=${c.goal || '—'}；缺陷=${c.flaw || '—'}；弧光=${c.arc || '—'}`)
    }
    if (bundle.facts.length > 0) {
      lines.push('', '## 事实账本')
      for (const f of bundle.facts) lines.push(`- ${f.subject} · ${f.attribute} = ${f.value}（第${f.chapter ?? '?'}章）`)
    }
    if (bundle.events.length > 0) {
      lines.push('', '## 时间线')
      for (const e of bundle.events) lines.push(`- [第${e.chapter ?? '?'}章 ｜ ${e.storyTime ?? '时间未填'}] ${e.title}`)
    }
    if (bundle.outlines.length > 0) {
      lines.push('', `## 章节大纲（共 ${bundle.outlines.length}）`)
      for (const outline of bundle.outlines.slice(0, 8)) lines.push(`- 第${outline.chapter}章 ${outline.title}${outline.summary ? `：${String(outline.summary).slice(0, 100)}` : ''}`)
    }
    const openForeshadow = bundle.foreshadow.filter((f) => f.status !== 'paid' && f.status !== 'dropped')
    if (openForeshadow.length > 0) {
      lines.push('', '## 未回收伏笔')
      for (const f of openForeshadow) lines.push(`- ${f.title}：第${f.setupChapter ?? '?'}章埋，第${f.payoffChapter ?? '?'}章收`)
    }
    const activeConflicts = bundle.conflicts.filter((c) => c.status === 'active')
    if (activeConflicts.length > 0) {
      lines.push('', '## 进行中的冲突')
      for (const c of activeConflicts) lines.push(`- ${c.title}：赌注=${c.stakes || '—'}；升级=${c.escalation || '—'}`)
    }
    const openReviews = bundle.reviews.filter((r) => r.status !== 'fixed' && r.status !== 'wontfix')
    if (openReviews.length > 0) {
      lines.push('', '## 未处理审稿')
      for (const r of openReviews.slice(0, 15)) lines.push(`- [第${r.chapter ?? '?'}章 ｜ ${r.severity ?? ''}] ${r.issue ?? ''} → ${r.suggestion ?? ''}`)
    }
    const pending = bundle.proposals.filter((p) => p.status === 'pending')
    if (pending.length > 0) {
      lines.push('', '## 待采纳提案')
      for (const p of pending) lines.push(`- ${p.kind} · ${p.title}${p.summary ? `：${p.summary}` : ''}`)
    }
    if (recent > 0 && bundle.chapters.length > 0) {
      lines.push('', `## 最近 ${recent} 章`)
      for (const c of bundle.chapters.slice(-recent)) {
        lines.push(`### 第 ${c.id} 章《${c.title}》`)
        if (c.summary) lines.push(c.summary)
        if (c.content) lines.push('', c.content.slice(-600))
      }
    }
    return lines.join('\n')
  },
}

const planTool = {
  name: 'novel_desk_plan',
  description: '为「下一章」生成一份精确的工作单：目标章号、预设章/字数目标、必须延续的时间线/事实/伏笔/冲突、上一章结尾、以及要求产出的 JSON 结构。作者说“写下一章/补下一章时间线/做下一章大纲”时先调用它，然后按工作单产出内容并调用 novel_desk_propose 提交提案，不要直接改账本。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      chapter: { type: 'integer', minimum: 1, maximum: 999, description: '目标章号；省略则自动取下一章' },
    },
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args) {
    const project = await requireProject(args?.project)
    const bundle = await getBundle(defaultRoot(), project.id)
    const chapter = Number.isInteger(args?.chapter) ? args.chapter : (bundle.chapters.length > 0 ? Math.max(...bundle.chapters.map((c) => Number(c.id) || 0)) + 1 : 1)
    const preset = bundle.presets[0] ?? {}
    const prev = bundle.chapters.find((c) => Number(c.id) === chapter - 1)
    const lines = [`# 工作单 · 第 ${chapter} 章`, '']
    lines.push(`作品：${bundle.project.name}（${bundle.project.genre || '未填类型'}）`)
    lines.push(`目标：${preset.chapterWords || bundle.project.targetWords || 3000} 字左右；全书计划 ${preset.plannedChapters || bundle.project.targetChapters || '未设'} 章`)
    lines.push(`写作口径：${preset.pov || bundle.project.pov || '—'} / ${preset.tense || bundle.project.tense || '—'} / ${preset.tone || '—'}`)
    lines.push(`风格规则：${Array.isArray(preset.styleRules) ? preset.styleRules.join('；') : '—'}`)
    lines.push(`禁忌：${Array.isArray(preset.taboo) ? preset.taboo.join('；') : '—'}`)
    const targetOutline = (bundle.outlines ?? []).find((o) => Number(o.chapter) === chapter)
    if (targetOutline) {
      lines.push('', `## 本章大纲（第 ${chapter} 章）`, `- ${targetOutline.title}`)
      if (targetOutline.summary) lines.push(targetOutline.summary)
      if (Array.isArray(targetOutline.beats) && targetOutline.beats.length > 0) lines.push(...targetOutline.beats.map((b) => `- ${b}`))
    }
    lines.push('', '## 必须延续的既有事实')
    for (const f of bundle.facts.slice(-20)) lines.push(`- ${f.subject} · ${f.attribute} = ${f.value}（第${f.chapter ?? '?'}章）`)
    lines.push('', '## 时间线（最近）')
    for (const e of bundle.events.slice(-12)) lines.push(`- [第${e.chapter ?? '?'}章 ｜ ${e.storyTime ?? '时间未填'}] ${e.title}`)
    const openForeshadow = bundle.foreshadow.filter((f) => f.status !== 'paid' && f.status !== 'dropped')
    lines.push('', '## 未回收伏笔')
    for (const f of openForeshadow) lines.push(`- ${f.title}（第${f.setupChapter ?? '?'}章埋，第${f.payoffChapter ?? '?'}章收）`)
    lines.push('', '## 进行中的冲突')
    for (const c of bundle.conflicts.filter((x) => x.status === 'active')) lines.push(`- ${c.title}：${c.stakes ?? ''}`)
    if (prev) {
      lines.push('', `## 上一章结尾（第 ${prev.id} 章《${prev.title}》）`)
      lines.push(prev.content ? prev.content.slice(-500) : '（上一章还没有正文）')
    }
    lines.push('', '## 输出要求')
    lines.push('只输出严格 JSON：')
    lines.push('```json')
    lines.push(`{"title":"第 ${chapter} 章标题","summary":"一句话","storyTime":"","location":"","characters":[],"beats":["节拍"],"events":[{"title":"","chapter":${chapter},"storyTime":"","location":"","participants":[],"summary":"","consequences":"","importance":"normal"}],"facts":[{"subject":"","attribute":"","value":"","chapter":${chapter},"note":""}],"foreshadow":[{"title":"","setupChapter":${chapter},"payoffChapter":0,"status":"open","note":""}]}`)
    lines.push('```')
    lines.push(`产出后调用 novel_desk_propose(kind="plan", chapter=${chapter}, title=..., data=上面的 JSON)。作者在工作台「提案」页对比后采纳。不要直接调用 novel_desk_upsert 改账本。`)
    return lines.join('\n')
  },
}

const proposeTool = {
  name: 'novel_desk_propose',
  description: '把 AI 生成的内容作为「提案」提交到工作台，等待作者在 UI 里对比采纳。用于下一章方案（kind=plan）、章节正文（kind=chapter）、时间线事件（kind=events）、事实（kind=facts）、人物（kind=characters）、伏笔（kind=foreshadow）。采纳动作由作者在 UI 点击完成，提交本身不改账本。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '作品 id 或名称' },
      kind: { type: 'string', enum: ['plan', 'chapter', 'events', 'facts', 'characters', 'foreshadow', 'highlights', 'custom'], description: '提案类型' },
      chapter: { type: 'integer', minimum: 1, maximum: 999, description: '章号' },
      title: { type: 'string', description: '提案标题' },
      summary: { type: 'string', description: '一句话摘要' },
      data: { type: 'object', description: 'plan/chapter 用：完整 JSON（title/summary/content/events/facts/foreshadow…）' },
      items: { type: 'array', description: 'events/facts/characters/foreshadow/highlights 用：条目数组', items: { type: 'object' } },
      rationale: { type: 'string', description: '为什么这样写' },
    },
    additionalProperties: false,
    required: ['kind', 'title'],
  },
  output: textOutput,
  async execute(args) {
    const project = await requireProject(args?.project)
    const proposal = await createProposal(defaultRoot(), project.id, {
      kind: args?.kind,
      chapter: args?.chapter,
      title: args?.title,
      summary: args?.summary,
      data: args?.data,
      items: args?.items,
      rationale: args?.rationale,
    })
    return `已提交提案「${proposal.title}」（kind=${proposal.kind}，chapter=${proposal.chapter ?? '—'}）。\n作者需在工作台「提案」页对比后点采纳；采纳前不会改动任何账本或正文。`
  },
}

const reviewTool = {
  name: 'novel_desk_review',
  description: '提交对某一章的审稿意见（写入工作台「审稿」）。每条含维度、严重度、问题、建议；作者可在 UI 里标记已修/忽略，也可让 AI 汇总修订单。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '作品 id 或名称' },
      chapter: { type: 'integer', minimum: 1, maximum: 999, description: '章号' },
      reviews: {
        type: 'array',
        description: '审稿意见数组',
        items: {
          type: 'object',
          properties: {
            dimension: { type: 'string', description: '情节/人物/文笔/连续性/节奏/对话/世界观/主题' },
            severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'suggestion'] },
            issue: { type: 'string' },
            suggestion: { type: 'string' },
          },
        },
      },
    },
    additionalProperties: false,
    required: ['chapter', 'reviews'],
  },
  output: textOutput,
  async execute(args) {
    const project = await requireProject(args?.project)
    const reviews = Array.isArray(args?.reviews) ? args.reviews : []
    for (const review of reviews) {
      await upsertEntity(defaultRoot(), project.id, 'reviews', { ...review, chapter: args?.chapter, source: 'ai', status: 'open' })
    }
    return `已写入 ${reviews.length} 条审稿意见到第 ${args?.chapter} 章。作者可在工作台「审稿」页处理。`
  },
}

const upsertTool = {
  name: 'novel_desk_upsert',
  description: '直接写入工作台数据（仅在作者明确要求“直接改”时使用）：章节/事实/事件/伏笔/冲突/人物/高光/预设/审稿/分工。AI 生成的内容应优先用 novel_desk_propose 提交提案。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '作品 id 或名称；kind=project 时省略' },
      kind: { type: 'string', enum: ['project', 'chapter', 'facts', 'events', 'foreshadow', 'conflicts', 'characters', 'highlights', 'presets', 'reviews', 'agents'], description: '数据类型' },
      item: { type: 'object', description: '数据内容，有 id 则更新、无 id 则新增' },
    },
    additionalProperties: false,
    required: ['kind', 'item'],
  },
  output: textOutput,
  async execute(args) {
    const kind = String(args?.kind ?? '')
    if (kind === 'project') {
      const project = await createProject(defaultRoot(), args?.item ?? {})
      return `已创建作品《${project.name}》（id: ${project.id}）。`
    }
    const project = await requireProject(args?.project)
    if (kind === 'chapter') {
      const chapter = await saveChapter(defaultRoot(), project.id, args?.item ?? {})
      return `已写入章节：第 ${chapter.id} 章《${chapter.title}》 ${chapter.words} 字。`
    }
    const item = await upsertEntity(defaultRoot(), project.id, kind, args?.item ?? {})
    return `已写入 ${kind}：${item.title ?? item.name ?? item.id}（id: ${item.id}）`
  },
}

export function apply(ctx) {
  mountRoute(ctx)
  ctx.tools.register(projectsTool)
  ctx.tools.register(bundleTool)
  ctx.tools.register(contextTool)
  ctx.tools.register(planTool)
  ctx.tools.register(proposeTool)
  ctx.tools.register(reviewTool)
  ctx.tools.register(upsertTool)
}
