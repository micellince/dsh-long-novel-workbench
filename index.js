/**
 * 长篇中文小说工作台 · Host 半边
 *
 * 1) Web UI 的同源 API（/novel-desk/api）：作品、章节、账本、提案、审稿、AI 生成。
 * 2) Agent 工具：读上下文、生成「工作单」、提交提案/审稿、按需直写。
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { defaultRoot, ensureRoot, getLibrary, getBundle, createProject, updateProject, deleteProject, saveChapter, deleteChapter, upsertEntity, deleteEntity, exportBook, getEntities, listProjects, createProposal, acceptProposal, rejectProposal, addProposalFeedback, markProposalRevised, addPresetFromTemplate, applyPreset, listChapterHistory, readChapterHistoryVersion, restoreChapterVersion, batchAcceptProposals, batchRejectProposals, batchUpdateReviews, reconcileReviewsFromAcceptedProposals, appendUsageRecord, listUsageRecords, listImportRecords, reopenProposal, batchReopenProposals, getWorld, saveWorld, getPipeline, savePipeline, resetPipeline, buildPipelineStages, getExpansion, saveExpansion, resetExpansion, getRevision, saveRevision, resetRevision, listJsonHistory, readJsonHistoryVersion, restoreJsonHistory, ensureDraftCurrent, markLedgersAligned, markSnapshotRestored, markLedgerTouched, KIND_FILES, WORLD_FILE } from './lib/store.js'
import { ALIGN_KINDS, computeVersionAlignment, formatVersionAlignment } from './lib/alignment.js'
import { createSnapshot, getSnapshot, listSnapshots, diffSnapshot, restoreSnapshot, readSnapshotChapter, restoreSnapshotChapter, deleteSnapshot } from './lib/snapshots.js'
import { scanImport, runImport } from './lib/importer.js'
import { estimateContext, runAi } from './lib/ai.js'
import { estimateSessionCost, loadChatUsage, loadModelPrices } from './lib/usage.js'
import { builtinPresets, attentionGenreProfiles, defaultPipeline, defaultExpansion, resolveActivePreset } from './lib/defaults.js'
import { auditAiStyle, auditSummaryText, scanMarkdownArtifacts } from './lib/aistyle.js'
import { planRevisionForBundle, evaluateFidelity, extractAnchors, revisionGatePolicy, describeRevisionTier, buildImpactFromBundle, validateRevisionContract, composeTiers, REVISION_STOP_MODES, findStopMode } from './lib/revision.js'
import { ATTENTION_BEAT_LABEL, ATTENTION_BEAT_MAX, ATTENTION_BEAT_WEAK, ATTENTION_BEATS, ATTENTION_BEFORE_MAX, ATTENTION_BEFORE_MIN, ATTENTION_DESIGN_GAP, ATTENTION_FIX_MAX_ITEMS, ATTENTION_FIX_MAX_TOTAL, ATTENTION_FIX_MIN_ITEMS, ATTENTION_GAIN_MAX, ATTENTION_GOOD_SCORE, attentionBeatScore, attentionByChapter, attentionDeficits, attentionFixCandidates, attentionFixStats, attentionMinFixes, attentionScoreOf, attentionUnscoredChapters } from './lib/attention-fix.js'

/** 会产出正文的 AI 任务：启动前必须已有当前写作预设。 */
const WRITES_PROSE_TASKS = new Set(['continue-chapter', 'rewrite-chapter', 'expand-chapter', 'next-chapter-plan'])

const ROUTE = '/novel-desk/api'
const VIEW_ROUTE = '/novel-desk/view'
const MAX_BODY = 8 * 1024 * 1024

/** 公开 AI 检测入口（作者人工复核用；插件不调用、只给链接与口径）。 */
export const DEAI_AUDIT_URL = 'https://matrix.tencent.com/ai-detect/'

/** 生成链路一号原则：所有生成/工作单 prompt 的开头；零上下文冷读（fresh-read）绝不能用。 */
export const ATTENTION_FIRST_PRINCIPLE = '创作第一原则：ATTENTION IS ALL YOU NEED——怎么吸引读者怎么来，一切为读者服务；事实自洽是底线，不是目标。每章必须先有核心注意力设计，再写正文。'

/** 注意力五类型（顺序用于类型建议）。 */
const ATTENTION_TYPE_ORDER = ['event', 'emotion', 'language', 'mystery', 'relationship']

/** 最弱一环中文名与对应的具体补强动作。 */
const WEAKEST_LABELS = { hook: '钩子', tension: '张力', payoff: '回报', cliff: '章末牵引' }
const WEAKEST_REINFORCE = {
  hook: '开篇 3 行内必须抛出钩子（问题/画面/异常），不能先铺设定',
  tension: '本章张力必须落在主角失去什么上：写清代价、压力来源与不可退让的选择',
  payoff: '本章必须有一次可感知的兑现：爽点/揭示/情绪释放，并指出具体段落',
  cliff: '章末必须留下未决问题：用一句话能说清“接下来读者最想知道什么”',
}

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

/** 版本对齐的账本域参数：去重、只保留 ALIGN_KINDS 内的值；未给或过滤后为空 = 全部。 */
function normalizeAlignKinds(raw) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  const kinds = [...new Set(list.map((kind) => String(kind ?? '').trim()).filter((kind) => ALIGN_KINDS.includes(kind)))]
  return kinds.length > 0 ? kinds : [...ALIGN_KINDS]
}

/** 账本文件名 → 账本 kind（ledger.restore 后记 touchedVersion 用；world.json 是单例）。 */
function ledgerKindFromFile(file) {
  const name = basename(String(file ?? '').trim())
  if (!name) return null
  if (name === WORLD_FILE) return 'world'
  const hit = Object.entries(KIND_FILES).find(([, fileName]) => fileName === name)
  return hit ? hit[0] : null
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
    case 'world.get': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      const bundle = await getBundle(root, projectId)
      return { world: bundle.world, locations: bundle.locations, worldSaved: bundle.worldSaved }
    }
    case 'world.save': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      const world = await saveWorld(root, projectId, body.world ?? body.patch ?? {})
      return world
    }
    case 'project.create': {
      const input = body.input ?? {}
      const project = await createProject(root, input)
      return ensureProjectWorkspace(ctx, project, input.workspaceTitle)
    }
    case 'project.update': {
      const projectId = String(body.projectId ?? '')
      const patch = { ...(body.patch ?? {}) }
      const previous = await getBundle(root, projectId).then((bundle) => bundle.project).catch(() => null)
      const name = String(patch.name ?? '').trim()
      if (name && previous && (!previous.workspaceTitle || previous.workspaceTitle === previous.name)) patch.workspaceTitle = name
      const updated = await updateProject(root, projectId, patch)
      if (name && updated.workspaceId) {
        try {
          const workspace = ctx.get('workspaceRegistry')?.get?.(updated.workspaceId)
          const title = updated.workspaceTitle || name
          if (workspace?.setTitle && workspace.title !== title) await workspace.setTitle(title)
        } catch { /* 工作区改名失败不影响项目 */ }
      }
      return updated
    }
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
    case 'proposal.reopen':
      return reopenProposal(root, String(body.projectId ?? ''), String(body.proposalId ?? ''))
    case 'proposal.batchReopen':
      return batchReopenProposals(root, String(body.projectId ?? ''), body.ids)
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
    case 'review.reconcile': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      return reconcileReviewsFromAcceptedProposals(root, projectId)
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
    case 'import.browse': {
      const raw = String(body.path ?? '').trim()
      let target = raw ? resolve(raw) : homedir()
      let info
      try {
        info = await stat(target)
      } catch {
        target = homedir()
        info = await stat(target)
      }
      const dir = info.isDirectory() ? target : dirname(target)
      const entries = []
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          entries.push({ name: entry.name, path: full, dir: true })
        } else if (entry.isFile() && /\.(md|markdown|txt|epub|pdf|mobi|azw3?|azw)$/i.test(entry.name)) {
          entries.push({ name: entry.name, path: full, dir: false })
        }
      }
      entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) : a.dir ? -1 : 1))
      return { path: dir, parent: dirname(dir), entries: entries.slice(0, 500) }
    }
    case 'import.scan': {
      const dirPath = String(body.path ?? '').trim()
      if (!dirPath) throw new Error('缺少 path')
      return scanImport(root, dirPath, { split: body.split })
    }
    case 'import.run': {
      const result = await runImport(root, {
        path: body.path,
        projectName: body.projectName,
        genre: body.genre,
        mode: body.mode,
        projectId: body.projectId,
        split: body.split,
      })
      const project = (await getBundle(root, result.projectId)).project
      const withWorkspace = await ensureProjectWorkspace(ctx, project, body.workspaceTitle)
      return { ...result, workspaceId: withWorkspace.workspaceId, workspacePath: withWorkspace.workspacePath }
    }
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
    case 'workspace.rename': {
      const registry = ctx.get('workspaceRegistry')
      const workspaceId = String(body.workspaceId ?? '')
      const title = String(body.title ?? '').trim()
      if (!registry?.get || !workspaceId || !title) throw new Error('缺少 workspaceId/title')
      const workspace = registry.get(workspaceId)
      if (!workspace) throw new Error('工作区不存在')
      await workspace.setTitle(title)
      return { workspaceId, title }
    }
    case 'workspace.cleanup': {
      const registry = ctx.get('workspaceRegistry')
      if (!registry?.list || !registry?.delete) return { deleted: [] }
      const projects = await listProjects(root)
      const active = new Set()
      for (const row of projects) {
        try {
          const bundle = await getBundle(root, row.id)
          if (bundle.project.workspaceId) active.add(bundle.project.workspaceId)
        } catch { /* ignore */ }
      }
      const deleted = []
      for (const workspace of registry.list()) {
        if (active.has(workspace.id)) continue
        if (!String(workspace.path ?? '').startsWith(join(root, 'projects') + '/')) continue
        if ((workspace.sessionIds ?? []).length > 0) continue
        try {
          if (await registry.delete(workspace.id)) deleted.push({ id: workspace.id, path: workspace.path })
        } catch { /* ignore */ }
      }
      return { deleted }
    }
    case 'chat.sessions': {
      const controller = ctx.get('sessionController')
      if (!controller?.list) throw new Error('宿主未提供会话服务')
      const value = await controller.list({}, AbortSignal.timeout(15000))
      return { items: (value.items ?? []).map((item) => ({ sessionId: item.sessionId, title: item.title ?? '', cwd: item.cwd ?? '', updatedAt: item.updatedAt, running: item.running, blank: item.blank, origin: item.origin ?? null, parentSessionId: item.parentSessionId ?? null })) }
    }
    case 'chat.send': {
      const projectId = String(body.projectId ?? '')
      const bundle = await getBundle(root, projectId)
      const controller = ctx.get('sessionController')
      if (!controller?.list || !controller?.prompt) throw new Error('宿主未提供会话服务，无法发送到对话')
      const imports = await listImportRecords(root, projectId)
      const project = await ensureProjectWorkspace(ctx, bundle.project)
      bundle.project = project
      const workspacePath = project.workspacePath || project.rootPath || imports.at(-1)?.root || ''
      const prompt = String(body.prompt ?? '').trim() || buildHandoffPrompt(bundle, body, workspacePath)
      if (body.dryRun && !body.checkTarget) return { dryRun: true, prompt, rootPath: workspacePath, workspacePath }
      let preferred
      let createdNewSession = false
      let handoffReason = body.newSession ? 'new' : 'recent'
      let rejectedSessionId = false
      if (body.newSession) {
        if (!workspacePath) throw new Error('作品还没有工作区，无法新开对话。')
        if (typeof controller.create !== 'function') throw new Error('宿主不支持新建会话')
        let workspaceId = project.workspaceId
        if (!workspaceId) {
          const workspaceRegistry = ctx.get('workspaceRegistry')
          let workspace = typeof workspaceRegistry?.resolveByPath === 'function' ? await workspaceRegistry.resolveByPath(workspacePath) : undefined
          if (!workspace && typeof workspaceRegistry?.create === 'function') workspace = await workspaceRegistry.create(workspacePath, project.name)
          workspaceId = workspace?.id
        }
        if (!workspaceId) throw new Error(`工作区未注册，无法新开对话：${workspacePath}`)
        const created = await controller.create({ workspaceId })
        preferred = { sessionId: created.sessionId, cwd: workspacePath, running: false }
        createdNewSession = true
      } else {
        const list = await controller.list({}, AbortSignal.timeout(15000))
        const picked = pickHandoffTarget(list.items, { sessionId: body.sessionId, workspacePath })
        preferred = picked.preferred
        rejectedSessionId = picked.rejectedSessionId
        handoffReason = picked.explicit ? 'explicit' : picked.rejectedSessionId ? 'session-rejected' : 'recent'
        if (!preferred) {
          if (!project.workspaceId) throw new Error('作品工作区未注册，无法发送。')
          if (typeof controller.create !== 'function') throw new Error('宿主不支持新建会话')
          const created = await controller.create({ workspaceId: project.workspaceId })
          preferred = { sessionId: created.sessionId, cwd: workspacePath, running: false }
          createdNewSession = true
          handoffReason = 'new'
        }
      }
      if (body.dryRun) return { dryRun: true, prompt, rootPath: workspacePath, workspacePath, sessionId: preferred.sessionId, cwd: preferred.cwd ?? '', reason: handoffReason, rejectedSessionId }
      await controller.prompt({
        requestId: randomUUID(),
        sessionId: preferred.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
        clientTimeZone: 'Asia/Shanghai',
      }, AbortSignal.timeout(20000))
      return { sessionId: preferred.sessionId, accepted: true, prompt, rootPath: workspacePath, workspacePath, workspaceId: project.workspaceId, newSession: createdNewSession, reason: handoffReason, rejectedSessionId }
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
      const project = await ensureProjectWorkspace(ctx, bundle.project)
      bundle.project = project
      const workspacePath = project.workspacePath || project.rootPath || imports.at(-1)?.root || ''
      const usagePaths = [workspacePath, project.legacyRootPath].filter(Boolean)
      try {
        const registry = ctx.get('workspaceRegistry')
        const legacyDataPath = join(root, 'projects', project.id)
        for (const workspace of registry?.list?.() ?? []) {
          if (workspace.path === legacyDataPath || workspace.path === join(root, 'projects', project.id)) usagePaths.push(workspace.path)
        }
      } catch { /* ignore */ }
      const uniqueUsagePaths = [...new Set(usagePaths)]
      let rootSessions = []
      let subagentSessions = []
      let subagentCount = 0
      let sessionRootMap = new Map()
      try {
        const sessionController = ctx.get('sessionController')
        if (sessionController?.list && uniqueUsagePaths.length > 0) {
          const listed = await sessionController.list({}, AbortSignal.timeout(15000))
          const allItems = listed.items ?? []
          const roots = allItems.filter((item) => uniqueUsagePaths.includes(item.cwd) && !item.origin && !item.parentSessionId && !item.blank)
          const byParent = new Map()
          for (const item of allItems) {
            if (!item.parentSessionId) continue
            if (!byParent.has(item.parentSessionId)) byParent.set(item.parentSessionId, [])
            byParent.get(item.parentSessionId).push(item.sessionId)
          }
          const descendantIds = new Set()
          const sessionRoot = new Map(roots.map((item) => [item.sessionId, item.sessionId]))
          let frontier = new Set(roots.map((item) => item.sessionId))
          while (frontier.size > 0) {
            const next = new Set()
            for (const id of frontier) {
              for (const childId of byParent.get(id) ?? []) {
                if (descendantIds.has(childId)) continue
                descendantIds.add(childId)
                sessionRoot.set(childId, sessionRoot.get(id))
                next.add(childId)
              }
            }
            frontier = next
          }
          subagentCount = descendantIds.size
          sessionRootMap = sessionRoot
          const selected = [...roots, ...allItems.filter((item) => descendantIds.has(item.sessionId))]
          const groups = new Map()
          for (const item of selected) {
            const cwd = item.cwd || workspacePath
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
        const fallback = await loadChatUsage(workspacePath)
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
      const rootRows = rootSessions.map((session) => ({ session, cost: costOf(session), row: null }))
      const subagentRows = subagentSessions.map((session) => shapeSession(session, costOf(session), true))
      const familyCost = new Map(rootRows.map((entry) => [entry.session.id, { usd: entry.cost?.usd ?? 0, cny: entry.cost?.cny ?? 0, tokens: entry.session.totalTokens ?? 0 }]))
      for (const row of subagentRows) {
        const rootId = sessionRootMap.get(row.id)
        if (!rootId || !familyCost.has(rootId)) continue
        const bucket = familyCost.get(rootId)
        bucket.usd += row.costUSD ?? 0
        bucket.cny += row.costCNY ?? 0
        bucket.tokens += row.totalTokens ?? 0
      }
      const chatSessions = rootRows.map(({ session, cost }) => {
        const family = familyCost.get(session.id) ?? { usd: cost?.usd ?? 0, cny: cost?.cny ?? 0, tokens: session.totalTokens ?? 0 }
        return {
          ...shapeSession(session, cost),
          familyCostUSD: Math.round(family.usd * 10000) / 10000,
          familyCostCNY: Math.round(family.cny * 10000) / 10000,
          familyTokens: family.tokens,
        }
      })
      const subagentTokens = subagentRows.reduce((sum, row) => sum + row.totalTokens, 0)
      const subagentCostUSD = subagentRows.reduce((sum, row) => sum + (row.costUSD ?? 0), 0)
      const subagentCostCNY = subagentRows.reduce((sum, row) => sum + (row.costCNY ?? 0), 0)
      const totalChatTokens = allChatSessions.reduce((sum, session) => sum + (session.totalTokens || 0), 0)
      const chat = {
        cwd: workspacePath,
        legacyCwd: project.legacyRootPath ?? '',
        legacyPaths: uniqueUsagePaths.filter((path) => path !== workspacePath),
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
        rootPath: workspacePath,
        workspaceId: project.workspaceId ?? null,
        workspacePath,
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
    case 'pipeline.get': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      const pipeline = await getPipeline(root, projectId)
      const usage = await summarizeUsage(root, projectId, ctx)
      return { pipeline, usage }
    }
    case 'pipeline.prepare':
      return preparePipeline(root, String(body.projectId ?? ''), { base: body.base, budget: body.budget }, ctx)
    case 'pipeline.markPrepared':
      return markPipelinePrepared(root, String(body.projectId ?? ''))
    case 'pipeline.startRun':
      return startPipelineRun(root, String(body.projectId ?? ''), { mode: body.mode, count: body.count, base: body.base, budget: body.budget }, ctx)
    case 'pipeline.advance':
      return advancePipeline(root, String(body.projectId ?? ''), { stageId: body.stageId, status: body.status, note: body.note }, ctx)
    case 'pipeline.pause':
      return pausePipeline(root, String(body.projectId ?? ''), String(body.note ?? '用户暂停'))
    case 'pipeline.resume':
      return resumePipeline(root, String(body.projectId ?? ''), ctx)
    case 'pipeline.reset':
      return resetPipeline(root, String(body.projectId ?? ''))
    case 'pipeline.usage':
      return { usage: await summarizeUsage(root, String(body.projectId ?? ''), ctx) }
    case 'pipeline.finalize':
      return finalizePipelineCleanup(root, String(body.projectId ?? ''), { scope: body.scope === 'run' ? 'run' : 'all' })
    case 'pipeline.backfill':
      return backfillPipeline(root, String(body.projectId ?? ''), ctx)
    case 'expansion.get': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      const expansion = await getExpansion(root, projectId)
      const usage = await summarizeUsage(root, projectId, ctx)
      return { expansion, usage }
    }
    case 'expansion.plan':
      return planExpansion(root, String(body.projectId ?? ''), {
        mode: body.mode,
        targetWords: body.targetWords,
        chapterTargets: body.chapterTargets,
        scope: body.scope,
        allowOutlineChanges: body.allowOutlineChanges,
        additions: body.additions,
        additionLimit: body.additionLimit,
        sampleChapters: body.sampleChapters,
        budget: body.budget,
      }, ctx)
    case 'expansion.confirmPlan':
      return confirmExpansionPlan(root, String(body.projectId ?? ''), { plan: body.plan, chapterTargets: body.chapterTargets, approvedOutlineIds: body.approvedOutlineIds })
    case 'expansion.start':
      return startExpansion(root, String(body.projectId ?? ''), ctx)
    case 'expansion.approveOutline':
      return approveExpansionOutline(root, String(body.projectId ?? ''), { approvedOutlineIds: body.approvedOutlineIds }, ctx)
    case 'expansion.advance':
      return advanceExpansion(root, String(body.projectId ?? ''), { stageId: body.stageId, status: body.status, note: body.note }, ctx)
    case 'expansion.pause':
      return pauseExpansion(root, String(body.projectId ?? ''), String(body.note ?? '用户暂停'))
    case 'expansion.resume':
      return resumeExpansion(root, String(body.projectId ?? ''), ctx)
    case 'expansion.reset':
      return resetExpansion(root, String(body.projectId ?? ''))
    case 'expansion.usage':
      return { usage: await summarizeUsage(root, String(body.projectId ?? ''), ctx) }
    case 'aistyle.audit': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      const bundle = await getBundle(root, projectId)
      const audit = auditAiStyle(bundle.chapters ?? [], { thresholds: body.thresholds })
      return { audit, summary: auditSummaryText(audit), prompt: buildAiStyleReviewPrompt(bundle, audit) }
    }
    case 'review.startDeai': {
      const projectId = String(body.projectId ?? '')
      const result = await startDeaiReview(root, projectId, ctx, {})
      return result
    }
    case 'review.startFull':
      return startFullBookReview(root, String(body.projectId ?? ''), { focus: body.focus }, ctx)
    case 'revision.get': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      const bundle = await getBundle(root, projectId)
      const revision = await getRevision(root, projectId)
      const audit = auditAiStyle(bundle.chapters ?? [])
      return { revision, audit, summary: auditSummaryText(audit) }
    }
    case 'revision.preview': {
      const bundle = await getBundle(root, String(body.projectId ?? ''))
      return previewRevision(bundle, body)
    }
    case 'revision.plan': {
      const result = await planRevisionRun(root, String(body.projectId ?? ''), body)
      return {
        revision: result.revision,
        prompt: result.prompt,
        impact: result.impact,
        batchCount: result.batchCount,
      }
    }
    case 'revision.start':
      return startRevisionRun(root, String(body.projectId ?? ''), ctx, body)
    case 'revision.advance':
      return { revision: await advanceRevision(root, String(body.projectId ?? ''), { batchIndex: body.batchIndex, status: body.status, note: body.note }) }
    case 'revision.applyChapter':
      return applyRevisionChapter(root, String(body.projectId ?? ''), { chapter: body.chapter, content: body.content })
    case 'revision.pause': {
      const revision = await getRevision(root, String(body.projectId ?? ''))
      return { revision: await saveRevision(root, String(body.projectId ?? ''), { status: 'paused', notes: [...(revision.notes ?? []), { at: new Date().toISOString(), text: String(body.note ?? '作者暂停') }] }) }
    }
    case 'revision.resume': {
      const projectId = String(body.projectId ?? '')
      const bundle = await getBundle(root, projectId)
      const revision = await getRevision(root, projectId)
      if (revision.status !== 'paused') throw new Error('改动未在暂停状态')
      const prompt = buildRevisionGoalPrompt(bundle, revision)
      const session = await startPipelineSession(ctx, root, bundle, prompt)
      return { revision: await saveRevision(root, projectId, { status: 'running', sessionId: session.sessionId }), sessionId: session.sessionId, prompt }
    }
    case 'revision.reset':
      return { revision: await resetRevision(root, String(body.projectId ?? '')) }
    case 'snapshot.list':
      return listSnapshots(root, String(body.projectId ?? ''))
    case 'snapshot.get':
      return getSnapshot(root, String(body.projectId ?? ''), String(body.snapshotId ?? ''))
    case 'snapshot.create':
      return createSnapshot(root, String(body.projectId ?? ''), {
        label: body.label,
        trigger: body.trigger === undefined ? 'manual' : String(body.trigger),
        note: body.note,
      })
    case 'snapshot.diff':
      return diffSnapshot(root, String(body.projectId ?? ''), String(body.snapshotId ?? ''))
    case 'snapshot.restore': {
      const projectId = String(body.projectId ?? '')
      const result = await restoreSnapshot(root, projectId, String(body.snapshotId ?? ''))
      // 整本回滚后快照内是自洽的：bump 一条 snapshot-restore，并把全部账本标记为已对齐
      await markSnapshotRestored(root, projectId, '整本回滚')
      return result
    }
    case 'snapshot.restoreChapter': {
      const projectId = String(body.projectId ?? '')
      const result = await restoreSnapshotChapter(root, projectId, String(body.snapshotId ?? ''), String(body.chapterId ?? ''))
      // 单章回滚只写正文文件：靠 mtime 补记一条 external-change，账本因此显示落后
      await ensureDraftCurrent(root, projectId)
      return result
    }
    case 'snapshot.chapter':
      return readSnapshotChapter(root, String(body.projectId ?? ''), String(body.snapshotId ?? ''), String(body.chapterId ?? ''))
    case 'snapshot.delete':
      return deleteSnapshot(root, String(body.projectId ?? ''), String(body.snapshotId ?? ''))
    case 'ledger.history':
      return listJsonHistory(root, String(body.projectId ?? ''), String(body.file ?? ''))
    case 'ledger.version':
      return readJsonHistoryVersion(root, String(body.projectId ?? ''), String(body.file ?? ''), String(body.name ?? ''))
    case 'ledger.restore': {
      const projectId = String(body.projectId ?? '')
      const result = await restoreJsonHistory(root, projectId, String(body.file ?? ''), String(body.name ?? ''))
      // 外部改账本后把对应域记为 touchedVersion，对齐状态会显示「改过、未确认对齐」
      const kind = ledgerKindFromFile(result.file ?? body.file)
      if (kind) await markLedgerTouched(root, projectId, [kind])
      return result
    }
    case 'alignment.report': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      // 先把正文文件的 mtime 变化记进稿本版本，再算对齐，避免拿旧版本对比
      await ensureDraftCurrent(root, projectId)
      const bundle = await getBundle(root, projectId)
      return bundle.alignment?.version ?? computeVersionAlignment(bundle)
    }
    case 'alignment.mark': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      // 标记前先刷新稿本版本，否则会把落差的账本标成落后
      await ensureDraftCurrent(root, projectId)
      const kinds = normalizeAlignKinds(body.kinds)
      await markLedgersAligned(root, projectId, kinds, { note: body.note })
      const bundle = await getBundle(root, projectId)
      return bundle.alignment?.version ?? computeVersionAlignment(bundle)
    }
    case 'export':
      return exportBook(root, String(body.projectId ?? ''), body.format ?? 'md')
    case 'ai.run': {
      const projectId = String(body.projectId ?? '')
      if (!projectId) throw new Error('缺少 projectId')
      const bundle = await getBundle(root, projectId)
      const proposal = body.proposalId ? (bundle.proposals ?? []).find((p) => p.id === body.proposalId) : null
      if (body.proposalId && !proposal) throw new Error(`提案不存在：${body.proposalId}`)
      const requestTask = proposal ? 'revise-proposal' : String(body.task ?? 'next-chapter-plan')
      if (WRITES_PROSE_TASKS.has(requestTask)) assertActivePreset(bundle)
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
    const recommended = [...facts].sort((a, b) => (Number(a.chapter) || 999) - (Number(b.chapter) || 999))[0] ?? facts[0]
    const aiSuggestion = `以「${recommended.value}」为准（第${recommended.chapter ?? '?'}章最早出现）`
    await createProposal(root, projectId, {
      kind: 'decision',
      chapter: facts[0].chapter ?? null,
      title,
      summary: `「${facts[0].subject}」的「${facts[0].attribute}」有 ${values.length} 个取值；AI 建议${aiSuggestion}。`,
      data: {
        conflictType: 'fact',
        subject: facts[0].subject,
        attribute: facts[0].attribute,
        facts: facts.map((fact) => ({ id: fact.id, value: fact.value, chapter: fact.chapter })),
        aiSuggestion,
        recommendedFactId: recommended.id,
        recommendedOptionId: `fact-${recommended.id}`,
        options: values.map((fact) => ({
          id: `fact-${fact.id}`,
          label: `以「${fact.value}」为准（第${fact.chapter ?? '?'}章）`,
          factId: fact.id,
          value: fact.value,
        })),
      },
      priority: 1,
      rationale: '事实账本内部冲突，由作者决定走 AI 建议还是自己的裁定。',
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
          aiSuggestion: conflict.suggestion ?? '',
          options: [
            { id: 'ai', label: '同意 AI 建议' },
            { id: 'author', label: '按作者意见处理（在清单里写你的意见）' },
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

/** 确保作品有独立的 DSH 工作区：建在默认工作区目录下，名字用作品名/自定义名。 */
async function ensureProjectWorkspace(ctx, project, titleOverride) {
  const root = defaultRoot()
  const registry = ctx.get('workspaceRegistry')
  if (!registry?.resolveByPath || !registry?.create) return project
  let baseDir = ''
  try {
    const workspaces = typeof registry.list === 'function' ? registry.list() : []
    const defaultWorkspace = workspaces.find((workspace) => workspace.title === 'default-workspace' || basename(workspace.path ?? '') === 'default-workspace')
    if (defaultWorkspace?.path) baseDir = defaultWorkspace.path
  } catch { /* ignore */ }
  if (!baseDir) baseDir = join(homedir(), 'dsh-workspaces')
  await mkdir(baseDir, { recursive: true })
  const desiredTitle = String(titleOverride || project.workspaceTitle || project.name || `作品-${project.id}`).trim() || `作品-${project.id}`
  const safeName = desiredTitle.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+|\.+$/g, '').trim().slice(0, 60) || `作品-${project.id}`
  let dir = join(baseDir, safeName)
  let workspace = null
  try { workspace = await registry.resolveByPath(dir) } catch { workspace = null }
  if (!workspace) {
    let exists = true
    try { await stat(dir); } catch { exists = false; }
    if (exists) dir = join(baseDir, `${safeName}-${project.id.slice(-4)}`)
    await mkdir(dir, { recursive: true })
    workspace = await registry.create(dir, desiredTitle)
  } else if (typeof workspace.setTitle === 'function' && workspace.title !== desiredTitle) {
    try { await workspace.setTitle(desiredTitle); } catch { /* ignore */ }
  }
  const patch = { workspaceId: workspace.id, workspacePath: workspace.path ?? dir, workspaceTitle: desiredTitle }
  if (project.workspacePath && project.workspacePath !== patch.workspacePath && !project.legacyRootPath) patch.legacyRootPath = project.workspacePath
  // 迁移后清理旧的空数据目录工作区，避免侧边栏出现两个同名工作区
  if (project.workspaceId && project.workspaceId !== workspace.id && project.workspacePath?.startsWith(join(root, 'projects') + '/')) {
    try {
      const oldWorkspace = typeof registry.get === 'function' ? registry.get(project.workspaceId) : null
      if (oldWorkspace && (oldWorkspace.sessionIds ?? []).length === 0 && typeof registry.delete === 'function') await registry.delete(project.workspaceId)
    } catch { /* ignore */ }
  }
  if (project.workspaceId === patch.workspaceId && project.workspacePath === patch.workspacePath && project.workspaceTitle === patch.workspaceTitle && project.legacyRootPath === patch.legacyRootPath) return project
  return updateProject(root, project.id, patch)
}

/** 全书首读：正文总字数超过这个值就建议用 subagent 分批读；不论多少，正文都只给文件路径，由 AI 自己 read。 */
const FRESH_READ_BATCH_HINT = 40000

/** 角色权重：缺省 3，用于派单排序与「（权重 N）」标注。 */
function agentWeight(agent) {
  const n = Number(agent?.weight)
  return Number.isFinite(n) ? n : 3
}

/** 按类型取 5 条注意力读者预期；未知类型用通用 5 条。 */
function attentionReadProfile(genre) {
  const profiles = attentionGenreProfiles()
  const text = String(genre ?? '').trim()
  const keys = Object.keys(profiles).filter((key) => key !== '通用')
  const hit = text ? keys.find((key) => text.includes(key) || key.includes(text)) : undefined
  return { label: hit ?? (text || '未填'), items: (profiles[hit] ?? profiles['通用']).slice(0, 5) }
}

/** 冷读 prompt 用的类型行：本作类型 + 该类型读者预期。 */
function attentionGenreLine(genre) {
  const profile = attentionReadProfile(genre)
  return `本作类型：${profile.label}。该类型读者预期（打分校准）：${profile.items.map((item, index) => `${index + 1}) ${item}`).join('；')}。`
}

/** 取本作类型：project.genre 优先，其次当前写作预设的 genre。 */
function projectGenre(bundle) {
  const project = bundle.project ?? {}
  const activePreset = resolveActivePreset(bundle)
  return String(project.genre || activePreset.genre || '').trim()
}

/**
 * 生成前硬闸门：必须由作者显式选定「当前写作预设」。
 * 只认 project.activePresetId，不做任何回落——回落等于替作者做选择，
 * 历史事故（整本按默认「克制」风格生成 31 万字）正是这一步缺失造成的。
 */
export function assertActivePreset(bundle = {}) {
  const presets = Array.isArray(bundle?.presets) ? bundle.presets : []
  const activeId = String(bundle?.project?.activePresetId ?? '').trim()
  const active = activeId ? presets.find((preset) => String(preset?.id ?? '') === activeId) : null
  if (!active) {
    throw new Error(presets.length === 0
      ? '还没有写作预设：请先在「预设」页新建一套、或从名家风格库加入，并设为当前预设，然后再开始生成。'
      : '还没选定当前写作预设：请在「预设」页把一套预设设为当前。没有预设=没有文风规格，生成会退回默认风格。')
  }
  const hasSpec = String(active.tone ?? '').trim()
    || (Array.isArray(active.styleRules) && active.styleRules.length > 0)
    || (Array.isArray(active.styleCards) && active.styleCards.length > 0)
  if (!hasSpec) {
    throw new Error(`当前预设「${active.name ?? active.id}」是空的（无 tone、无风格规则、无指标卡）：请先补上文风规格再生成。`)
  }
  return active
}

/** 注意力分数：0-100 数字；空/非法值视为未标。 */
function attentionNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 注意力记录按章号排序。 */
function sortedAttention(bundle) {
  return [...(bundle.attention ?? [])].sort((a, b) => (Number(a.chapter) || 0) - (Number(b.chapter) || 0))
}

/**
 * 注意力统计：记录、有实测分的记录、平均分、已写章节未标数。
 * context / plan / 强制补强都用它，保证口径一致。
 */
function attentionStats(bundle) {
  const rows = sortedAttention(bundle)
  const scored = rows.filter((row) => attentionNumber(row.score) !== null)
  const average = scored.length > 0
    ? Math.round(scored.reduce((sum, row) => sum + attentionNumber(row.score), 0) / scored.length)
    : null
  const labeled = new Set(rows.map((row) => Number(row.chapter)))
  const missing = (bundle.chapters ?? []).filter((chapter) => String(chapter.content ?? '').trim() && !labeled.has(Number(chapter.id))).length
  return { rows, scored, average, missing }
}

/** 曲线单行：`第 N 章 72分/类型（设计 80，实测-设计 +8）`。 */
function attentionCurveLine(row) {
  const score = attentionNumber(row.score)
  const design = attentionNumber(row.designScore)
  const delta = score !== null && design !== null ? (score - design >= 0 ? `+${score - design}` : String(score - design)) : '—'
  return `第${Number(row.chapter)}章 ${score ?? '未标'}分/${row.type ?? '未分型'}（设计 ${design ?? '—'}，实测-设计 ${delta}）`
}

/** 一次出多少章的详细工作单还算「短工作单」；超过就改成分批工作单（仍只给文件路径）。 */
const ATTENTION_BATCH_INLINE_MAX = 3

/** 四拍分一行：`钩子 12 / 张力 8 / 兑现 15 / 章末 6`（缺失用 —）。 */
function attentionBeatLine(record) {
  return ATTENTION_BEATS.map((beat) => {
    const n = attentionBeatScore(record?.breakdown, beat)
    return `${ATTENTION_BEAT_LABEL[beat]} ${n === null ? '—' : n}`
  }).join(' / ')
}

/** 提分/复测工作单里的章正文：一律不贴正文，只给文件路径 + 字数，让 AI 自己 read（与全文改写/扩写一致）。 */
function attentionFixChapterSource(chapter, bundle, rootPath = '', sandbox = null) {
  const content = String(chapter?.content ?? '')
  const file = chapterFilePath(bundle, Number(chapter?.id), rootPath, sandbox)
  if (!content.trim()) return `（本章还没有正文）`
  return `（正文不内联，${content.length} 字。正文文件：${file}
用 read 工具自己读（长章用 offset/limit 分段读，或先按弃读点/grep 定位要改的段）；before 必须逐字照抄文件内容，不要凭记忆。）`
}

/** 单章提分行：候选里有就用候选，没有（未打分/已达标）就按记录现算一行。 */
function attentionRowForChapter(bundle, chapterNumber) {
  const hit = attentionFixCandidates(bundle).find((row) => row.chapter === chapterNumber)
  if (hit) return hit
  const record = attentionByChapter(bundle.attention).get(chapterNumber)
  if (!record) return null
  const score = attentionScoreOf(record.score)
  const designScore = attentionScoreOf(record.designScore)
  const average = attentionStats(bundle).average
  const target = designScore ?? (average === null ? 80 : Math.min(95, Math.round(average + 8)))
  const deficits = attentionDeficits(record)
  const dropPointCount = Array.isArray(record.dropPoints) ? record.dropPoints.filter((point) => point && String(point.quote ?? '').trim()).length : 0
  return {
    chapter: chapterNumber,
    record,
    score,
    designScore,
    target,
    potential: score === null ? null : Math.round(target - score),
    weakest: String(record.weakest ?? '').trim(),
    dropPointCount,
    deficits,
    minFixes: attentionMinFixes(deficits),
    recheckPending: record.recheckPending === true,
    pendingFixes: 0,
    fixCount: Array.isArray(record.fixLog) ? record.fixLog.length : 0,
    lastDelta: attentionScoreOf(record.lastRecheckDelta),
    stale: false,
  }
}

/** 章节号清单清洗：只留正整数、去重、保留给定顺序。 */
function attentionChapterSelection(options) {
  const raw = Array.isArray(options?.chapters) ? options.chapters : []
  const seen = new Set()
  const out = []
  for (const value of raw) {
    const chapterNumber = Number(value)
    if (!Number.isInteger(chapterNumber) || chapterNumber <= 0 || seen.has(chapterNumber)) continue
    seen.add(chapterNumber)
    out.push(chapterNumber)
  }
  return out
}

/** options 是否要求「全部章节」：all=true / scope=all / limit=0。 */
function attentionWantsAll(options) {
  if (options?.all === true) return true
  if (String(options?.scope ?? '') === 'all') return true
  const limit = options?.limit
  return limit !== undefined && limit !== null && String(limit).trim() !== '' && Number(limit) === 0
}

/**
 * 章节正文文件的绝对路径（工作单只给路径，正文由 AI 自己 read）。
 * 传了 sandbox 就只给隔离区副本的路径——审阅 prompt 永远看不到项目目录，也就看不到别的书。
 */
function chapterFilePath(bundle, chapterNumber, rootPath = '', sandbox = null) {
  const hit = sandbox?.byId?.get(Number(chapterNumber))
  if (hit?.path) return hit.path
  const root = String(bundle?.root ?? rootPath ?? '')
  const chapter = (bundle?.chapters ?? []).find((row) => Number(row.id) === Number(chapterNumber))
  const id = String(chapter?.id ?? String(chapterNumber).padStart(4, '0'))
  return join(root, 'projects', String(bundle?.project?.id ?? ''), 'chapters', `${id}.md`)
}

/** 提分方案的提交格式与硬性要求（单章详细单 / 批量单共用）。 */
function attentionFixSubmissionLines() {
  return [
    '## 提交格式（每章一份）',
    'novel_desk_propose(kind="attention-fix", chapter=N, title="第N章提分方案", summary="预期 +X 分：改了哪几段", items=[{"target":"hook|tension|payoff|cliff|type|language","weak":"这条补什么（一句话）","expectedGain":3,"before":"逐字复制原文 4-600 字","after":"改写后的同一段","why":"为什么这样改能提分"}])',
    '硬性要求：',
    `1. 每章 items 至少 ${ATTENTION_FIX_MIN_ITEMS} 条、最多 ${ATTENTION_FIX_MAX_ITEMS} 条，至少 2 个不同 target；expectedGain 是 1-${ATTENTION_GAIN_MAX} 的整数，单章合计不超过 ${ATTENTION_FIX_MAX_TOTAL}。`,
    `2. before 必须逐字复制该章正文（${ATTENTION_BEFORE_MIN}-${ATTENTION_BEFORE_MAX} 字、不带省略号），且在正文里只出现一次；after 是替换后的同一段，长度可不同。`,
    '3. 至少一条方案直接改最弱一拍；有弃读点的，必须有一条 before 抄弃读点原文。不要只改错别字、不要整章重写、不要改剧情走向与人物关系。',
    '4. summary 写清「预期 +X 分、改了哪几段、对上哪条诊断」。不要直接 upsert 正文。',
  ]
}

/** 注意力提分批量工作单（超过 3 章）：不内联正文，给章节清单 + 每章诊断 + 逐章执行协议。 */
function attentionFixBatchText(bundle, rows, chapters, rootPath, project, scopeLabel, sandbox = null) {
  const label = scopeLabel || `${rows.length} 章`
  const lines = [
    `【注意力提分方案 · 批量】项目《${project.name ?? ''}》 projectId=${project.id ?? ''} · ${label}`,
    '',
    ...REVIEW_ISOLATION_LINES,
    '',
    `目标：把这 ${rows.length} 章的「冷读实测分」拉上去。章节多，正文不内联（只给文件路径，用 read 工具自己读）；下面给每章的提分空间、四拍、弃读点与确定性诊断，逐章读正文 → 提交段落级 before/after 补丁方案（kind=attention-fix）。不要重写整章，不要直接改正文。`,
    '',
    '## 待处理章节（按提分空间降序）',
  ]
  rows.forEach((row, index) => {
    const chapter = chapters.get(row.chapter) ?? {}
    const words = String(chapter.content ?? '').length
    const file = chapterFilePath(bundle, row.chapter, rootPath, sandbox)
    const weak = ATTENTION_BEAT_LABEL[row.weakest] ?? (row.weakest || '冷读没标')
    lines.push(`${index + 1}. 第${row.chapter}章《${chapter.title ?? ''}》｜实测 ${row.score ?? '—'} / 设计 ${row.designScore ?? '—'} / 目标 ${row.target} / 空间 +${row.potential ?? 0}｜四拍 ${attentionBeatLine(row.record)}｜最弱 ${weak}｜弃读点 ${row.dropPointCount} 条｜最少 ${row.minFixes} 条补丁｜${words} 字｜${file}`)
    if (row.pendingFixes > 0) lines.push(`   ⚠ 已有 ${row.pendingFixes} 份提分方案等作者采纳：先看旧方案，别重复提，补旧方案没覆盖的拍。`)
    if (row.recheckPending) lines.push('   ⚠ 本章刚改过、还没复测：先补四拍里仍然最弱的拍，别重复改上次那几段。')
  })
  lines.push('', '## 每章要改什么（确定性诊断，方案逐条对上）')
  rows.forEach((row) => {
    const chapter = chapters.get(row.chapter) ?? {}
    lines.push('', `### 第${row.chapter}章《${chapter.title ?? ''}》`)
    const drops = Array.isArray(row.record?.dropPoints) ? row.record.dropPoints.filter((point) => point && String(point.quote ?? '').trim()) : []
    drops.slice(0, 3).forEach((point, i) => {
      lines.push(`- 弃读点 ${i + 1}：「${String(point.quote).slice(0, 80)}」—— ${String(point.why ?? '').slice(0, 60) || '读者会在这里停下来'}`)
    })
    if (row.deficits.length === 0) {
      lines.push(`- 冷读没给结构性诊断：直接按最弱一拍（${ATTENTION_BEAT_LABEL[row.weakest] ?? '四拍最低项'}）与弃读点补。`)
    } else {
      for (const deficit of row.deficits) {
        lines.push(`- [${deficit.severity >= 3 ? '必改' : deficit.severity === 2 ? '建议' : '可选'}] ${deficit.evidence}；处方：${deficit.prescribe}`)
      }
    }
  })
  lines.push('', '## 执行协议（逐章处理，别一次吞完）')
  lines.push('1. 一批处理 2~3 章：直接 read 上面列的正文文件（工作单不贴正文）；要更细的诊断可 novel_desk_attention_fix(op="workorder", chapters=[这批章号]) 取单章详细单（同样只给路径）。')
  lines.push('2. 每章写完立刻提交 novel_desk_propose(kind="attention-fix", chapter=N, ...)，不要全部读完再统一提。')
  lines.push('3. 建议每 2~3 章汇报一次进度（章号 / 提案 id / 预期提分合计）；全部做完停下汇报，不要直接 upsert 正文。')
  lines.push('4. 中途断了就用 op="scoreboard" 看还剩哪些章没有方案，再继续。')
  lines.push('', ...attentionFixSubmissionLines())
  lines.push('', '作者在提案页采纳后，服务端按 before 定位、只替换补丁段（其余原文不动）、自动备份，并把该章标记「待复测」；复测任务重新冷读后写回 Δ。')
  return lines.join('\n')
}

/**
 * 复测单的提交口径：打分写回 → 复核新发现的问题落审稿 → 仍弱再出提分方案。
 * 「只交打分/只交补丁」是旧链路的缺口：复核发现的问题必须能进「审稿」页被作者逐条审阅。
 */
function attentionRecheckSubmissionLines(project = {}) {
  const projectArg = project?.id ? `project="${project.id}", ` : ''
  return [
    '## 提交格式（每章一条）',
    'novel_desk_propose(kind="attention", chapter=N, items=[{"chapter":N,"score":0-100,"breakdown":{"hook":0-25,"tension":0-25,"payoff":0-25,"cliff":0-25},"dropPoints":[{"quote":"逐字引文","why":"为什么弃读"}],"verdict":"会|犹豫|不会","weakest":"hook|tension|payoff|cliff","dropRisk":"","detail":"一段说明"}])',
    `必须给 breakdown（四拍各 0-25，合计与总分之差不超过 10）和 1~3 条 dropPoints 引文。只写实测字段，不要写设计字段，不要改正文。服务端会把新分写回分数历史、清掉「待复测」并算出 Δ。`,
    '',
    '## 复核发现的问题要落成审稿（不要只交打分）',
    `复测读出来的新问题（上次补丁没改好的、以及读的时候新看出来的），逐条写成审稿，别只在 detail 里提一句：novel_desk_review(${projectArg}origin="recheck", reviews=[{"chapter":N,"dimension":"节奏|情节|人物|连续性|文笔|对话","severity":"major|minor|suggestion","issue":"问题是什么（带一句原文引文）","suggestion":"改哪段、怎么改","quote":"原文引文"}])。`,
    `- 每章至少 1 条、最多 3 条；要能指名原文，禁止「还是不够抓人」这种空话。
- 跨章共性问题（同一个毛病在好几章重复）单独写一条 chapter=0，issue 里列出涉及章号。
- 这些条目进「审稿」页：作者可勾选 →「加入清单」→ 生成改动提案（注意力/节奏类会合并成段落补丁方案），也可忽略。新问题走审稿，不要拿整章重写糊过去。`,
    '',
    `复测后如果某章仍低于 75 分，或四拍里仍有 < ${ATTENTION_BEAT_WEAK} 的拍，再对该章提交一份 novel_desk_propose(kind="attention-fix")：至少 ${ATTENTION_FIX_MIN_ITEMS} 条 before/after 补丁、before 逐字抄正文；达标就只交打分。`,
  ]
}

/** 注意力复测批量工作单（超过 3 章）：不内联正文，给清单与逐章复测协议。 */
function attentionRecheckBatchText(bundle, rows, chapters, rootPath, project, scopeLabel, sandbox = null) {
  const label = scopeLabel || `${rows.length} 章`
  const lines = [
    `【注意力复测 · 批量】项目《${project.name ?? ''}》 projectId=${project.id ?? ''} · ${label}`,
    '',
    ...REVIEW_ISOLATION_LINES,
    '',
    `下面 ${rows.length} 章刚按提分方案改过正文，需要【零上下文】复测：只读正文，不要看旧分、不要看修改记录、不要查账本/设定/大纲/人物卡。章节多，正文不内联（只给文件路径）；按清单逐章 read 文件再打分，按该类型读者预期校准，内容没变好就打低分，禁止凑分。`,
    attentionGenreLine(projectGenre(bundle)),
    '',
    '## 待复测章节',
  ]
  rows.forEach((row, index) => {
    const chapter = chapters.get(row.chapter) ?? {}
    const words = String(chapter.content ?? '').length
    lines.push(`${index + 1}. 第${row.chapter}章《${chapter.title ?? ''}》｜${words} 字｜${chapterFilePath(bundle, row.chapter, rootPath, sandbox)}`)
  })
  lines.push('', ...attentionRecheckSubmissionLines(project))
  lines.push('执行协议：一次处理 2~3 章，先 read 上面列的正文文件；每读完 2~3 章提交一次（打分、审稿、方案各一次工具调用），建议中途报进度；全部做完停下汇报每章新分与四拍。')
  return lines.join('\n')
}

/**
 * 注意力提分工作单：按提分空间选章，输出实测/设计/四拍/弃读点/确定性诊断/正文/提交格式。
 * 冷读任务末尾、"生成提分方案"按钮、novel_desk_attention_fix(op=workorder) 共用。
 */
export function attentionFixWorkorder(bundle, options = {}, rootPath = '') {
  const project = bundle?.project ?? {}
  const chapters = new Map((bundle?.chapters ?? []).map((chapter) => [Number(chapter.id), chapter]))
  const requested = Number(options?.chapter) || 0
  const selected = attentionChapterSelection(options)
  const all = attentionWantsAll(options)
  const limit = Math.max(1, Number(options?.limit) || 3)
  const candidates = attentionFixCandidates(bundle)
  const checkRow = (chapterNumber) => {
    const row = attentionRowForChapter(bundle, chapterNumber)
    if (!row) throw new Error(`第 ${chapterNumber} 章还没有注意力记录：先做零上下文冷读打分，再生成提分方案`)
    const chapter = chapters.get(chapterNumber)
    if (!chapter || !String(chapter.content ?? '').trim()) throw new Error(`第 ${chapterNumber} 章还没有正文，无法按段落提分（先写正文）`)
    return row
  }
  let rows
  let scopeLabel = ''
  if (requested > 0) {
    rows = [checkRow(requested)]
  } else if (selected.length > 0) {
    rows = selected.map((chapterNumber) => checkRow(chapterNumber))
    scopeLabel = `自选 ${rows.length} 章`
  } else {
    rows = all ? candidates : candidates.slice(0, limit)
    if (rows.length === 0) {
      const unscored = attentionUnscoredChapters(bundle)
      throw new Error(unscored.length > 0
        ? `还没有可提分的章节：有 ${unscored.length} 章未冷读打分（${unscored.slice(0, 10).join('、')}），先做零上下文首读打分`
        : `没有需要提分的章节：已打分章节都在 ${ATTENTION_GOOD_SCORE} 分以上，或还没有已打分章节`)
    }
    scopeLabel = all ? `全书 ${rows.length} 章` : (rows.length > 1 ? `${rows.length} 章` : '')
  }
  const sandbox = reviewSandboxFor(bundle, rootPath, rows.map((row) => row.chapter))
  if (rows.length > ATTENTION_BATCH_INLINE_MAX) {
    return attentionFixBatchText(bundle, rows, chapters, rootPath, project, scopeLabel, sandbox)
  }
  const suffix = scopeLabel ? ` · ${scopeLabel}` : ''
  const lines = [
    `【注意力提分方案】项目《${project.name ?? ''}》 projectId=${project.id ?? ''}${suffix}`,
    '',
    ...REVIEW_ISOLATION_LINES,
    '',
    '目标：把「冷读实测分」拉上去。下面每章已经给出提分空间、四拍短板与弃读点；正文不贴进对话，自己用 read 工具读章节文件。请给每章写一份【段落级】before/after 补丁方案，提交 attention-fix 提案。不要重写整章，不要直接改正文。',
  ]
  rows.forEach((row, index) => {
    const chapter = chapters.get(row.chapter) ?? {}
    const head = row.score === null
      ? `第 ${row.chapter} 章《${chapter.title ?? ''}》（还没有冷读分）`
      : `第 ${row.chapter} 章《${chapter.title ?? ''}》（实测 ${row.score} 分 / 设计 ${row.designScore ?? '—'} 分 / 目标 ${row.target} 分 / 提分空间 +${row.potential}）`
    lines.push('', `## ${index + 1}. ${head}`)
    lines.push(`- 四拍（满分 ${ATTENTION_BEAT_MAX}，< ${ATTENTION_BEAT_WEAK} 算明显偏弱）：${attentionBeatLine(row.record)}`)
    lines.push(`- 最弱一环：${ATTENTION_BEAT_LABEL[row.weakest] ?? (row.weakest || '冷读没标（按四拍最低的一项补）')}`)
    if (row.record?.type) lines.push(`- 类型：${row.record.type}`)
    const drops = Array.isArray(row.record?.dropPoints) ? row.record.dropPoints.filter((point) => point && String(point.quote ?? '').trim()) : []
    if (drops.length > 0) {
      lines.push('- 弃读点（提分方案必须直接改这几处原文）：')
      drops.slice(0, 3).forEach((point, i) => {
        lines.push(`  ${i + 1}) 「${String(point.quote).slice(0, 120)}」—— ${String(point.why ?? '').slice(0, 80) || '读者会在这里停下来'}`)
      })
    }
    if (row.deficits.length > 0) {
      lines.push('- 确定性诊断（按优先级，方案要逐条对上）：')
      for (const deficit of row.deficits) {
        lines.push(`  - [${deficit.severity >= 3 ? '必改' : deficit.severity === 2 ? '建议' : '可选'}] ${deficit.evidence}；处方：${deficit.prescribe}`)
      }
    }
    lines.push(`- 本章最少 ${row.minFixes} 条补丁；全章至少 ${ATTENTION_FIX_MIN_ITEMS} 条、最多 ${ATTENTION_FIX_MAX_ITEMS} 条，至少覆盖 2 个不同 target，expectedGain 合计不超过 ${ATTENTION_FIX_MAX_TOTAL}。`)
    if (row.pendingFixes > 0) lines.push(`- ⚠ 已有 ${row.pendingFixes} 份提分方案在等作者采纳：先看旧方案，别重复提，补旧方案没覆盖的拍。`)
    if (row.recheckPending) lines.push('- 本章刚改过、还没复测：先别重复改上次那几段，优先补四拍里仍然最弱的拍。')
    if (row.fixCount > 0) lines.push(`- 历史补丁 ${row.fixCount} 条，上一次复测 Δ ${row.lastDelta === null ? '—' : (row.lastDelta > 0 ? `+${row.lastDelta}` : String(row.lastDelta))}：没加分的拍要换手法，不要重复同样的改法。`)
    lines.push('', attentionFixChapterSource(chapter, bundle, rootPath, sandbox))
  })
  lines.push('', ...attentionFixSubmissionLines())
  lines.push('', '作者在提案页采纳后，服务端按 before 定位、只替换补丁段（其余原文不动）、自动备份，并把该章标记「待复测」；复测任务重新冷读后写回 Δ。做完停下汇报：每章提案 id + 预期提分合计。')
  return lines.join('\n')
}

/**
 * 注意力复测工作单：对「待复测」章节做零上下文重新打分（不透露旧分，避免凑分），
 * 分数由服务端写进 scoreHistory 并算 Δ；复测后仍低分的章节要求再出一份提分方案。
 */
export function attentionRecheckWorkorder(bundle, options = {}, rootPath = '') {
  const project = bundle?.project ?? {}
  const chapters = new Map((bundle?.chapters ?? []).map((chapter) => [Number(chapter.id), chapter]))
  const attentionMap = attentionByChapter(bundle?.attention)
  const requested = Number(options?.chapter) || 0
  const selected = attentionChapterSelection(options)
  const all = attentionWantsAll(options)
  const limit = Math.max(1, Number(options?.limit) || 3)
  const pendingRows = [...attentionMap.values()]
    .filter((record) => record?.recheckPending === true)
    .map((record) => ({ chapter: Number(record.chapter), record }))
    .filter((row) => Number.isFinite(row.chapter) && row.chapter > 0)
    .sort((a, b) => a.chapter - b.chapter)
  const rowFor = (chapterNumber) => {
    const record = attentionMap.get(chapterNumber)
    if (!record) throw new Error(`第 ${chapterNumber} 章还没有注意力记录：先做零上下文冷读打分`)
    return { chapter: chapterNumber, record }
  }
  let rows
  let scopeLabel = ''
  if (requested > 0) {
    rows = [rowFor(requested)]
  } else if (selected.length > 0) {
    rows = selected.map((chapterNumber) => rowFor(chapterNumber))
    scopeLabel = `自选 ${rows.length} 章`
  } else {
    rows = all ? pendingRows : pendingRows.slice(0, limit)
    if (all) scopeLabel = `全书待复测 ${rows.length} 章`
  }
  if (rows.length === 0) {
    throw new Error('没有标记「待复测」的章节：先采纳一份提分方案（采纳后自动标记待复测），或指定 chapter 复测某章；先冷读打分才有可复测的分数')
  }
  const sandbox = reviewSandboxFor(bundle, rootPath, rows.map((row) => row.chapter))
  if (rows.length > ATTENTION_BATCH_INLINE_MAX) {
    return attentionRecheckBatchText(bundle, rows, chapters, rootPath, project, scopeLabel, sandbox)
  }
  const suffix = scopeLabel ? ` · ${scopeLabel}` : ''
  const lines = [
    `【注意力复测】项目《${project.name ?? ''}》 projectId=${project.id ?? ''}${suffix}`,
    '',
    ...REVIEW_ISOLATION_LINES,
    '',
    '下面这些章节刚按提分方案改过正文，需要一次【零上下文】复测：只读正文（自己 read 章节文件，工作单不贴正文），不要看旧分、不要看修改记录、不要查账本/设定/大纲/人物卡。读法：逐章读完再打分，按该类型读者预期校准；内容没变好就打低分，禁止凑分。',
    attentionGenreLine(projectGenre(bundle)),
  ]
  rows.forEach((row, index) => {
    const chapter = chapters.get(row.chapter) ?? {}
    lines.push('', `## ${index + 1}. 第 ${row.chapter} 章《${chapter.title ?? ''}》`)
    lines.push('', attentionFixChapterSource(chapter, bundle, rootPath, sandbox))
  })
  lines.push('', ...attentionRecheckSubmissionLines(project))
  lines.push('做完停下汇报：每章新分与四拍、这次新写了哪几条审稿（章号+问题）、是否又出了补丁方案；分数对比由服务端自动算。')
  return lines.join('\n')
}

/** 全书提分看板：哪些章待提分/待复测/已复测 Δ 多少，一屏看完提分闭环卡在哪。 */
export function attentionScoreboardText(bundle) {
  const project = bundle?.project ?? {}
  const stats = attentionFixStats(bundle)
  const candidates = attentionFixCandidates(bundle)
  const attentionMap = attentionByChapter(bundle?.attention)
  const chapterMap = new Map((bundle?.chapters ?? []).map((chapter) => [Number(chapter.id), chapter]))
  const scored = [...attentionMap.values()].filter((row) => attentionScoreOf(row.score) !== null)
  const avgDelta = stats.avgDelta === null ? '—' : (stats.avgDelta > 0 ? `+${stats.avgDelta}` : String(stats.avgDelta))
  const lines = [
    `# 注意力提分看板 · ${project.name ?? ''}`,
    `- 已打分：${scored.length} 章 ｜ 实测均分 ${attentionStats(bundle).average ?? '—'} ｜ 未冷读：${attentionUnscoredChapters(bundle).length} 章`,
    `- 提分闭环：待复测 ${stats.pendingRecheck} 章 ｜ 已复测 ${stats.verified} 章 ｜ 补丁 ${stats.fixCount} 条 ｜ 平均 Δ ${avgDelta}（最好 ${stats.bestDelta === null ? '—' : `+${stats.bestDelta}`} / 最差 ${stats.worstDelta === null ? '—' : stats.worstDelta}）｜ 待采纳提分方案 ${stats.pendingFixProposals} 份 ｜ 复测没加分 ${stats.noGain} 章`,
  ]
  if (candidates.length === 0) {
    lines.push('', `没有需要提分的章节（已打分章节都在 ${ATTENTION_GOOD_SCORE} 分以上，或还没有冷读分）。先做零上下文冷读打分。`)
    return lines.join('\n')
  }
  lines.push('', '## 待提分章节（按提分空间降序）')
  for (const row of candidates) {
    const chapter = chapterMap.get(row.chapter) ?? {}
    const status = row.recheckPending
      ? '待复测'
      : row.pendingFixes > 0
        ? `等采纳（${row.pendingFixes} 份方案）`
        : row.stale
          ? '分数过期（正文改过，需复测）'
          : row.lastDelta !== null
            ? (row.lastDelta > 0 ? `已复测 Δ+${row.lastDelta}` : `已复测 Δ${row.lastDelta}（没加分）`)
            : '等方案'
    lines.push(`- 第${row.chapter}章《${chapter.title ?? ''}》 实测 ${row.score} / 设计 ${row.designScore ?? '—'} / 空间 +${row.potential} ｜ 四拍 ${attentionBeatLine(row.record)} ｜ 最弱 ${ATTENTION_BEAT_LABEL[row.weakest] ?? '—'} ｜ ${status}`)
  }
  lines.push('', '下一步：novel_desk_attention_fix(op="workorder") 出提分工作单 → novel_desk_propose(kind="attention-fix") → 作者采纳 → op="recheck" 复测写回 Δ。')
  return lines.join('\n')
}

export const TASK_LABEL = {
  'next-chapter-plan': '生成下一章方案',
  'review-chapter': '审阅一章',
  'fresh-read': '零上下文首读一章',
  'attention-design': 'AI 补齐注意力机制（逐章设计）',
  'attention-fix': '生成注意力提分方案',
  'attention-recheck': '复测提分效果',
  'world-build': 'AI 生成世界地图',
  'world-infer': 'AI 反推地点',
  'review-fix': '按审稿意见修改',
  'review-to-proposals': '按审稿意见生成修订提案',
  'revise-proposal': '按作者意见修订提案',
  'continue-chapter': '续写章节',
  'extract-facts': '抽取事实账本',
  'generate-events': '生成时间线',
  'import-review': '导入后审阅',
  'full-review': '从头审阅整个项目',
  'enrich-characters': 'AI 补全人物卡与关系',
  'enrich-foreshadow': 'AI 补全伏笔',
  'enrich-highlights': 'AI 提取高光',
  'enrich-facts': 'AI 补全事实账本',
  'enrich-events': 'AI 补全时间线',
  'enrich-conflicts': 'AI 补全冲突',
  'enrich-outlines': 'AI 补全章节大纲',
  'align-ledgers': '对齐账本到当前稿（版本对齐）',
}

/**
 * 从宿主会话列表里挑「清单发送目标」（纯函数，便于测试）。
 * 规则：显式选中的会话（必须属于本书工作区）> 同工作区运行中 > 同工作区最近一条。
 * 空白会话 / 子 Agent 会话不参与候选。
 */
export function pickHandoffTarget(items, options = {}) {
  const list = Array.isArray(items) ? items : []
  const sessionId = String(options.sessionId ?? '')
  const workspacePath = String(options.workspacePath ?? '')
  const roots = list.filter((item) => item && !item.origin && !item.parentSessionId && !item.blank)
  const candidates = workspacePath ? roots.filter((item) => item.cwd === workspacePath) : roots
  const explicitRaw = sessionId ? list.find((item) => item?.sessionId === sessionId) : null
  const explicit = explicitRaw && (!workspacePath || (explicitRaw.cwd ?? '') === workspacePath) ? explicitRaw : null
  return {
    explicit,
    rejectedSessionId: Boolean(sessionId && !explicit),
    preferred: explicit || candidates.find((item) => item.running) || candidates[0] || null,
    candidates,
  }
}

/** 交接 payload → 提分/复测工作单的选章参数（scope=all / limit=0 都按「全部」处理）。 */
function handoffAttentionOptions(body = {}) {
  const all = attentionWantsAll(body)
  return { chapter: body.chapter, chapters: body.chapters, all, limit: body.limit }
}

/** 工作台 → 对话 的交接 prompt。 */
export function buildHandoffPrompt(bundle, body = {}, rootPath = '') {
  const task = String(body.task ?? 'custom')
  const project = bundle.project
  // 零上下文首读：提前 return，绝不能拼上常规交接头/进度/账本/agents/风格规则
  // scope=chapter 只给一章的正文文件路径；scope=book 给全书章节文件清单，正文都由 AI 自己 read
  if (task === 'fresh-read') {
    const chapters = bundle.chapters ?? []
    if (chapters.length === 0) throw new Error('没有可首读的章节')
    const ordered = [...chapters].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
    const scope = body.scope === 'book' ? 'book' : 'chapter'
    // 类型化打分：只带类型与读者预期，不带账本，保持零上下文
    const genreLine = attentionGenreLine(projectGenre(bundle))
    const reviewLine = (count) => `读完用 novel_desk_review 写 ${count} 条审稿（project=${project.id}, chapter=对应章号, dimension=首读, severity=blocker|major|minor|suggestion, origin="cold-read"），每条一句话：问题 + 依据（带原文引文）。`
    if (scope === 'book') {
      const totalChars = ordered.reduce((n, row) => n + String(row.content ?? '').length, 0)
      const sandbox = reviewSandboxFor(bundle, rootPath, ordered.map((row) => Number(row.id)))
      const plan = ordered.map((row) => `第 ${Number(row.id)} 章《${row.title}》｜${String(row.content ?? '').length} 字｜${chapterFilePath(bundle, row.id, rootPath, sandbox)}`)
      const scoreLine = '除首读意见外，给每一章一个 0-100 的注意力总分（按该类型读者预期校准，格式固定为「第N章 78」），每章再附一句理由；同时给每章最弱一环 weakest（hook|tension|payoff|cliff）。最后给一段全书注意力总评：最抓人/最想弃读的章、曲线高低点、平均分。用 novel_desk_propose(kind=attention) 提交一条 attention 提案（items 每章一个，只写实测字段：chapter/score/breakdown/dropPoints/verdict/weakest/dropRisk/detail；breakdown={hook,tension,payoff,cliff} 各 0-25、合计与总分差≤10，<70 分的章必须给 breakdown 与 1 条 dropPoints 引文）；钩子/张力/回报/章末牵引的设计归注意力设计师，不要写这些字段（type 也不要写），不要改正文。'
      const fixLine = '打完分后按提分空间排序（设计分/均值 - 实测分，弃读点多的优先），给最低的 3 章各提交一份 novel_desk_propose(kind=attention-fix)：items 至少 ' + ATTENTION_FIX_MIN_ITEMS + ' 条、覆盖至少 2 个不同 target，每条 {target,weak,expectedGain:1-15,after,why,before:逐字照抄章节文件原文 4-600 字}，合计 ≤' + ATTENTION_FIX_MAX_TOTAL + '；只改段落不重写剧情。至少要给最低 3 章出方案；作者要全书提分时再用 novel_desk_attention_fix(op="workorder", all=true) 分批补齐其余低分章。至少 3 章都 ≥' + ATTENTION_GOOD_SCORE + ' 分且无弃读点时，说明理由后可以不出方案。'
      const bookLines = [
        '零上下文首读（全书）：只读这本书的正文，自己用 read 工具读文末清单里的章节文件。不要读工作台、不要查设定/大纲/人物卡，也不要读事实账本、事件、时间线、审稿、提案。',
        '',
        ...REVIEW_ISOLATION_LINES,
        '',
        `全书 ${ordered.length} 章 / ${totalChars} 字，正文不贴进对话（只给文件路径）；长章用 offset/limit 分段读。`,
      ]
      if (totalChars <= FRESH_READ_BATCH_HINT) {
        bookLines.push('读法：按章号顺序逐章 read 文末清单里的章节文件，边读边记要点，读完再汇总。')
      } else {
        bookLines.push(
          '读法：一次读不完，按下面的章节清单分批读。用 subagent 工具按顺序分批（每批不超过约 4 万字），每个子 Agent 只给这一批的正文文件路径，要求它只读正文、返回 3~5 条首读意见（哪里抓得住 / 想弃读、人物可信度、信息过载或不足），并给这一批每章一个 0-100 注意力总分 + 一句理由 + 最弱一环（hook|tension|payoff|cliff）；没有子 Agent 工具就逐章读、边读边记要点再汇总。',
          '每个子 Agent 除首读意见外，还要返回该批每一章的注意力总分；收齐后由主会话汇总成一条 attention 提案。',
        )
      }
      bookLines.push(
        reviewLine('3~8'),
        '最后给一段 12 行内全书综合意见：哪里抓得住、哪里想弃读、主线是否清楚、人物是否可信、信息过载还是不足、最想继续读和最先放弃的位置。不要改正文。',
        genreLine,
        scoreLine,
        fixLine,
        '---',
        ...plan,
      )
      return bookLines.join('\n')
    }
    const requested = Number(body.chapter) || 0
    if (requested > 0 && !ordered.some((row) => Number(row.id) === requested)) {
      throw new Error(`没有可首读的章节：第 ${requested} 章不存在`)
    }
    const target = ordered.find((row) => Number(row.id) === requested) ?? ordered[ordered.length - 1]
    const chapter = Number(target.id)
    const sandbox = reviewSandboxFor(bundle, rootPath, [chapter])
    return [
      '零上下文首读：只读这一章正文（自己用 read 工具读章节文件，不要读工作台、不要查设定/大纲/人物卡）。',
      '',
      ...REVIEW_ISOLATION_LINES,
      '',
      `本章正文不贴进对话（${String(target.content ?? '').length} 字），只给文件路径；长章用 offset/limit 分段读。`,
      `读完用 novel_desk_review 写 2~4 条审稿（project=${project.id}, chapter=${chapter}, dimension=首读, severity=blocker|major|minor|suggestion, origin="cold-read"），每条一句话：问题 + 依据（带原文引文）。`,
      '最后给一段 8 行内综合意见：哪里抓得住、哪里想弃读、人物可信度、信息过载或不足。不要改正文。',
      genreLine,
      '除首读意见外，给这一章一个 0-100 注意力总分（按该类型读者预期校准），并拆成四拍分数 breakdown={hook,tension,payoff,cliff}（各 0-25，合计与总分差不超过 10）；再写一段详细说明：钩子/张力/回报/章末牵引哪里有效、哪里不足、最弱一环 weakest（hook|tension|payoff|cliff）、一个弃读点（段落位置）、会不会读下一章 verdict（会/犹豫/不会）、以及 1~3 条 dropPoints（每条 {quote:"逐字引文", why:"读者为什么会在这里停下来"}）。用 novel_desk_propose(kind=attention) 提交本章实测记录（chapter/score/breakdown/dropPoints/verdict/weakest/dropRisk/detail）；钩子/张力/回报/章末牵引的设计归注意力设计师，不要写这些字段（type 也不要写），不要改正文。',
      '提分方案（读完必须产）：无论这一章打多少分，都再提交一份 novel_desk_propose(kind=attention-fix, chapter=' + chapter + ', title="第' + chapter + '章提分方案", items=[...])：items 至少 ' + ATTENTION_FIX_MIN_ITEMS + ' 条、最多 ' + ATTENTION_FIX_MAX_ITEMS + ' 条，至少覆盖 2 个不同 target（hook|tension|payoff|cliff|type|language），每条 {target, weak:"这条补什么", expectedGain:1-15 的整数, before:"逐字复制章节文件原文 4-600 字", after:"改写后的同一段", why:"为什么这样改能提分"}，合计 expectedGain 不超过 ' + ATTENTION_FIX_MAX_TOTAL + '。规则：优先改最弱一拍与 dropPoints 那几处原文；只改局部段落，不整章重写、不改剧情走向和人物关系；before 必须与原文完全一致（标点也算）且在正文里只出现一次，否则提案会被拒绝；总分 ≥' + ATTENTION_GOOD_SCORE + ' 且没有弃读点时可以不出方案，但要说明理由。',
      '---',
      `第 ${chapter} 章《${target.title}》｜${String(target.content ?? '').length} 字｜${chapterFilePath(bundle, chapter, rootPath, sandbox)}`,
    ].join('\n')
  }
  // 按审稿出提案：清单里的审稿项（或直接给的 reviewIds）逐条变成 chapter 提案，作者在提案页验收，不直接改正文
  if (task === 'review-to-proposals') {
    const fromItems = Array.isArray(body.items)
      ? body.items.filter((item) => item && (item.kind === 'review' || item.kind === 'reviews') && item.id).map((item) => String(item.id))
      : []
    const ids = Array.isArray(body.reviewIds) ? body.reviewIds.map(String) : fromItems
    const picked = (bundle.reviews ?? []).filter((row) => ids.includes(String(row.id)))
    if (picked.length === 0) throw new Error('没有选择要处理的审稿意见')
    // 注意力/文笔/节奏类意见合并成段落补丁（不动整章）；情节/人物/连续性等结构问题才走整章修订
    const patchDimensions = new Set(['节奏', '文笔', '语言', '句子', '对话', '首读'])
    const patchRows = picked.filter((row) => patchDimensions.has(String(row.dimension ?? '').trim()))
    const structuralRows = picked.filter((row) => !patchDimensions.has(String(row.dimension ?? '').trim()))
    const chapterTitle = new Map((bundle.chapters ?? []).map((row) => [Number(row.id), row.title ?? '']))
    const reviewChapters = [...new Set(picked.map((row) => Number(row.chapter)).filter((n) => Number.isFinite(n) && n > 0))]
    const sandbox = reviewSandboxFor(bundle, rootPath, reviewChapters.length > 0 ? reviewChapters : null)
    const chapterRows = sandbox ? [...sandbox.byId.values()] : []
    const lines = [
      `【按审稿出提案】项目《${project.name}》 projectId=${project.id}`,
      '',
      ...REVIEW_ISOLATION_LINES,
      '',
      `下面 ${picked.length} 条是已经审出来的意见。请生成修订提案，不要重写整本，也不要直接改正文。`,
      patchRows.length > 0
        ? `其中 ${patchRows.length} 条是注意力/文笔/节奏类的局部问题：合并成段落补丁方案（novel_desk_propose kind="attention-fix"，只改几段原文，不整章回写）。`
        : '',
      structuralRows.length > 0
        ? `${structuralRows.length} 条是情节/人物/连续性等结构问题：每条一个 chapter 提案（完整章节正文 + reviewIds）。`
        : '',
      '每一条审稿都必须被某份提案的 reviewIds 覆盖，不能漏；一条审稿确实无法执行时，在汇报里说明原因。',
      ...(chapterRows.length > 0 ? ['', '## 涉及章节的正文文件（唯一允许读取的文件）', ...chapterRows.map((row) => `- 第${Number(row.id)}章《${row.title}》｜${row.words} 字｜${row.path}`)] : []),
    ].filter((line) => line !== '')
    picked.forEach((row, index) => {
      const kindLabel = patchDimensions.has(String(row.dimension ?? '').trim()) ? '段落补丁' : '整章修订'
      const chapterLabel = Number(row.chapter) === 0 ? '全书级' : `第${row.chapter}章${chapterTitle.get(Number(row.chapter)) ? `《${chapterTitle.get(Number(row.chapter))}》` : ''}`
      lines.push('', `${index + 1}. [${kindLabel}] ${chapterLabel} · ${row.dimension ?? ''} · ${row.severity ?? ''}（审稿 id=${row.id}）`, `问题：${row.issue ?? ''}`, `建议：${row.suggestion ?? ''}`)
      if (String(row.quote ?? '').trim()) lines.push(`原文：${String(row.quote).trim()}`)
    })
    lines.push(
      '',
      '执行要求：',
      '1. 先读上面「涉及章节的正文文件」清单里的文件（用 read），只改这些意见相关的段落，其余原文保持不动；清单之外的文件一律不要打开。',
      '2. 段落补丁类：按章合并成 novel_desk_propose(kind="attention-fix", chapter=N, title="第N章按审稿提分", summary="对应审稿 id 与问题", data={chapter:N, reviewIds:[审稿 id...], items:[{target:"hook|tension|payoff|cliff|type|language", weak:"补什么", expectedGain:1-15 整数, before:"逐字抄这段原文（4-600 字、唯一、不重叠）", after:"改写后的同一段", why:"为什么能提分"}]})。items 至少 3 条、最多 12 条，至少覆盖 2 个不同 target，expectedGain 合计 ≤ 40。不要整章重写；chapter=0 的全书级意见按 issue 里列到的章号拆进对应章的补丁，reviewIds 照带。',
      '3. 整章修订类：每条提交一个 chapter 提案（novel_desk_propose，data 里放 title/summary/content 完整章节正文，并加 reviewIds=[审稿 id]），不要多条合并。',
      '4. 提案 summary 写清改了什么、依据哪几条审稿；拿不准就在 summary 里说明，不要自行扩大改动范围。',
      '5. 做完停下来汇报：每条审稿对应哪个提案 id（补丁方案写清覆盖了哪几条审稿）。审稿状态留给作者在审稿页处理，不要自己改。',
    )
    return lines.join('\n')
  }
  // 注意力提分：打分之后按提分空间出段落级 before/after 补丁方案（不动整章）
  if (task === 'attention-fix') {
    return attentionFixWorkorder(bundle, handoffAttentionOptions(body), rootPath)
  }
  // 注意力复测：采纳补丁后零上下文重新打分，服务端写回分数历史与 Δ
  if (task === 'attention-recheck') {
    return attentionRecheckWorkorder(bundle, handoffAttentionOptions(body), rootPath)
  }
  // 常规交接：一号原则置顶（零上下文 fresh-read 已在上方提前 return，不会被污染）
  const attentionFirstTask = task === 'next-chapter-plan' || task === 'continue-chapter'
  const attentionFirstItem = (Array.isArray(body.items) ? body.items : [])
    .some((item) => item?.task === 'next-chapter-plan' || item?.task === 'continue-chapter')
  const lines = [`> ${ATTENTION_FIRST_PRINCIPLE}`, '']
  if (attentionFirstTask || attentionFirstItem) {
    const targetChapter = Number(body.chapter) || (bundle.chapters.length > 0 ? Math.max(...bundle.chapters.map((c) => Number(c.id) || 0)) + 1 : 1)
    const nextAction = task === 'continue-chapter' ? '正文' : '下一章方案'
    lines.push(
      `## 第一优先级：注意力（ATTENTION IS ALL YOU NEED）`,
      `先提交本章 attention 设计（planned）：type（event|emotion|language|mystery|relationship 选一个主类型）/hook/tension/payoff/cliff/question/designScore（0-100），再写${nextAction}；正文必须按四拍落地，章末必须留未决问题。提交方式：novel_desk_propose(kind="attention", chapter=${targetChapter}, items=[{chapter, type, hook, tension, payoff, cliff, question, designScore, status:"planned"}])。`,
      '',
    )
  }
  lines.push(
    `【工作台交接】项目《${project.name}》 projectId=${project.id}${rootPath ? `，工作区=${rootPath}` : ''}`,
    `进度：${bundle.chapters.length} 章 / ${bundle.stats.words} 字；人物 ${bundle.characters.length}；大纲 ${bundle.outlines.length}；事件 ${bundle.events.length}；事实 ${bundle.facts.length}；伏笔 ${bundle.foreshadow.length}；待处理提案 ${bundle.stats.pendingProposals}；审稿 ${bundle.stats.openReviews}。`,
  )
  // 带上下文的审阅任务同样硬隔离：禁止跨作品对比、禁止读本书工作台以外的文件
  const reviewerTasks = new Set(['full-review', 'import-review', 'review-chapter', 'review-fix'])
  if (reviewerTasks.has(task)) lines.push('', ...REVIEW_ISOLATION_NOTICE_LINES, '')
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
      const label = { review: '审稿', proposal: '提案', check: '检查', chapter: '章节', foreshadow: '伏笔', task: '任务' }[item.kind] ?? item.kind ?? '条目'
      const parts = [`${index + 1}. [${label}]`]
      if (item.chapter) parts.push(`第${item.chapter}章`)
      if (item.title) parts.push(item.title)
      if (item.detail) parts.push(`：${item.detail}`)
      const isDecision = item.proposalKind === 'decision'
      if (item.approved) parts.push('；作者已同意采纳')
      if (isDecision && item.aiSuggestion) parts.push(`；AI 建议：${item.aiSuggestion}`)
      if (isDecision && item.choice) parts.push(`；作者选择：${item.choice}`)
      if (item.authorOpinion) parts.push(`；作者意见：${item.authorOpinion}`)
      if (item.note) parts.push(`；清单补充：${item.note}`)
      if (isDecision && !item.choice && !item.authorOpinion) parts.push('；作者意见：（未填写，按 AI 建议）')
      parts.push(`（id=${item.id}）`)
      lines.push(parts.join(' '))
    })
    lines.push('', '处理要求：逐项处理；每完成一项就立刻把结果写回工作台（novel_desk_propose 提交提案 / novel_desk_review 写审稿 / novel_desk_upsert 更新状态），不要攒到最后。')
    if (items.some((item) => item.proposalKind === 'decision')) {
      lines.push('决策项规则：作者选择 > 作者意见 > AI 建议。把决定落成具体修改提案（chapter/…），并在 data.resolvesProposalId 填对应决策 id；不要直接改正文，也不要只回复“同意”。')
    }
    if (items.some((item) => item.approved)) {
      lines.push('已同意项规则：先用 novel_desk_proposal 读取提案完整内容，再按内容与清单意见执行；可以调用 novel_desk_upsert 更新对应正文/账本。执行前先核对与本清单其他项、现有人物/时间线/事实是否冲突。')
    }
    if (body.allowContinue) lines.push('如果下一步是明确的小步，可以直接继续，不必每步都问；涉及大范围改动或改设定时先问我。')
    else lines.push('完成清单后停下来，逐项汇报结果，并问我要不要继续下一批/下一步。')
  }
  const agents = (bundle.agents ?? []).filter((agent) => agent.enabled !== false && agent.name)
  // 独立审稿人做零上下文首读，不带账本上下文，不参与本批次多 Agent 派单
  // 其余角色按 weight 降序派单（注意力设计师 10 排最前），行尾标注权重
  const dispatchAgents = agents
    .filter((agent) => agent.special !== 'fresh-read')
    .sort((a, b) => agentWeight(b) - agentWeight(a))
  if (body.multiAgent && dispatchAgents.length > 0) {
    lines.push('', `本项目启用多 Agent 分工（${dispatchAgents.length} 个角色，按权重降序）：`)
    dispatchAgents.forEach((agent, index) => lines.push(`${index + 1}. ${agent.name}（权重 ${agentWeight(agent)}）：${agent.duty ?? ''}`))
    lines.push('', '执行方式：先由总编拆单，按任务相关性派给对应角色；可用 subagent 工具（有 Team 能力更好）让每个子 Agent 只做一个维度，各自把审稿/提案写回工作台，最后由责任编辑汇总、按严重度排序。不要只用一个 Agent 从头做到尾；如果宿主没有 subagent 工具，就按角色顺序逐个执行并在结果里标明角色。')
    lines.push('注意力设计师权重最高（10），先出设计：总编拆单时先让注意力设计师产出四拍与 designScore，其他角色再按设计执行。')
    if (dispatchAgents.length < agents.length) lines.push('独立审稿人只做零上下文首读，不带账本上下文，不在本批次派单。')
  }
  const tasks = new Set(items.map((item) => item.task).filter(Boolean))
  const activePreset = resolveActivePreset(bundle)
  // 不截断：预设是作者写的规格书，截断会静默丢掉排在后面的规则（含范文锚点）。
  const styleRules = activePreset.styleRules ?? []
  const taboo = activePreset.taboo ?? []
  const reviewFocus = (activePreset.reviewFocus ?? []).slice(0, 10)
  if (tasks.has('full-review') || items.some((item) => item.kind === 'review')) {
    lines.push('', '分角色审阅规范（必须执行，不能只做冲突检查）：')
    lines.push('1. 连续性审稿：对照事实账本检查年龄、地点、物品、称谓、伤势、门派；每条引用原文。')
    lines.push('2. 人物审稿：对照人物卡检查动机、性格、关系、弧光；指出“知道不该知道的信息”“行为跳变”。')
    lines.push('3. 时间线审稿：检查故事时间、事件顺序、因果链、行程可达性。')
    lines.push('4. 伏笔审稿：检查埋设、回收、超期、道具是否随葬/消失。')
    lines.push('5. 文笔审稿：逐章检查句式重复、现代词、对话腔调、视角漂移、节奏拖沓、抒情直白、章回收束；必须引用原文句子并给改写建议。')
    lines.push('6. 责任编辑：汇总去重，按 blocker → major → minor 排序，产出修订单。')
    if (styleRules.length > 0) lines.push('', '写作预设的风格规则（文笔审稿逐条对照）：', ...styleRules.map((rule) => `- ${rule}`))
    if (taboo.length > 0) lines.push('预设禁忌（文笔审稿重点找）：', ...taboo.map((rule) => `- ${rule}`))
    if (reviewFocus.length > 0) lines.push(`预设审稿重点：${reviewFocus.join('、')}`)
    lines.push('', '每个角色至少写 3 条审稿；确实没问题的维度也要写一条“已检查，无问题”的审稿并说明依据。每条审稿必须带章号、维度、严重度、引用原文、可执行建议；用 novel_desk_review 写入。')
  }
  if (tasks.has('full-review')) lines.push('', '任务：从头审阅整个项目。先用 novel_desk_bundle / novel_desk_context 读取项目，再按上面的角色分工逐章检查；问题写审稿（novel_desk_review），需要补设定/改正文的提交提案（novel_desk_propose）。按 blocker → major → minor 排序。')
  if (tasks.has('import-review')) lines.push('', '任务：导入后审阅。先补齐缺失的人物/时间线/大纲（提案），再对照设定核查正文冲突（审稿）；顺手补齐注意力设计（每章一条，只写 design 字段：type/hook/tension/payoff/cliff/question/designScore）。涉及移动时优先用已登记的地点与连接，不要出现地图外地点。')
  if (tasks.has('enrich-characters')) lines.push('', '任务：补全人物卡。读 characters 与正文，只为缺字段的人物提交 characters 提案（保留 name，可带现有 id），补齐 goal/motivation/flaw/arc/personality；关系写成「名字(关系)」，如「华羽生(师徒)」，目标人物不存在也列出来。不要覆盖已有非空字段。')
  if (tasks.has('enrich-foreshadow')) lines.push('', '任务：补全伏笔。读正文与现有伏笔，提交 foreshadow 提案：title/setupChapter/payoffChapter/status/note；指出埋设章和计划回收章。')
  if (tasks.has('enrich-highlights')) lines.push('', '任务：提取高光。读正文，提交 highlights 提案：chapter/title/quote/why；挑真正值得保留的段落。')
  if (tasks.has('enrich-facts')) lines.push('', '任务：补全事实账本。读正文与现有 facts，提交 facts 提案：subject/attribute/value/chapter；只补缺失或冲突的。')
  if (tasks.has('enrich-events')) lines.push('', '任务：补全时间线。读正文与现有 events，提交 events 提案：title/chapter/storyTime/location/participants/summary。')
  if (tasks.has('enrich-conflicts')) lines.push('', '任务：补全冲突。读正文/大纲/设定，提交 conflicts 提案：title/type/stakes/escalation/status。')
  if (tasks.has('enrich-outlines')) lines.push('', '任务：补全章节大纲。读已写章节与现有 outlines，提交 outlines 提案：chapter/title/summary/beats/status；每章大纲同时给 attention 设计（type/hook/tension/payoff/cliff/question/designScore），单独提交 attention 提案（kind=attention，status="planned"）。')
  // 已有书补注意力机制：逐章设计（不是打分），设计字段归设计师
  if (tasks.has('attention-design') || task === 'attention-design') {
    lines.push('', '任务：为已写章节补「注意力设计」（不是打分）。逐章提交 novel_desk_propose(kind=attention) 一条，只写 design 字段：chapter/type/hook/tension/payoff/cliff/question/designScore/status="planned"。读正文 + outlines + foreshadow/conflicts/highlights 作为素材；章末必须给出未决问题；同类型不要连续超 3 章；书大时用 subagent 分批（每批 ≤4 万字）。不要打 score（留给独立审稿人），不要改正文。')
  }
  // 版本对齐：把落后/未追踪的账本补齐到当前稿本版本（只提交提案，作者采纳后才生效）
  if (tasks.has('align-ledgers') || task === 'align-ledgers') {
    lines.push(
      '',
      '任务：版本对齐（把人物、事实、时间线、地图地点、世界、高光、伏笔、冲突、注意力、章节大纲等账本补齐到当前稿本版本）。严格按下面 5 步执行：',
      '1. 先调用 novel_desk_bundle({ kind: "alignment" }) 读版本对齐：稿本版本、每个账本域的对齐版本、落后域（behind）/未追踪域（untracked）、变更章节（changedChapters）与缺口（gaps）。',
      '2. 对每个 behind / untracked 域：读它 changedChapters 里那些章的正文和已有账本，只补这段落差与 gaps 里的缺口，不要重刷整本。',
      '3. 用 novel_desk_propose 提交提案（kind 用账本 kind：characters/facts/events/locations/world/highlights/foreshadow/conflicts/attention/outlines）；不要直接改账本，也不要改正文；人物/地点先查重，不要重复建同名条目。',
      '4. 全部提交后调用 novel_desk_align({ op: "mark", kinds: [实际完成的域], note: "..." })：只标实际完成的域，没做的留着继续显示落后。',
      '5. 汇报：补了哪些域、提交了几条提案、哪些域没动（及原因）。',
    )
  }
  if (tasks.has('next-chapter-plan') || tasks.has('continue-chapter')) {
    lines.push('', '## 第一优先级：注意力（ATTENTION IS ALL YOU NEED）', '写正文前先提交本章 attention 设计（planned）：type/hook/tension/payoff/cliff/question/designScore（提交 kind=attention 提案），再写正文/下一章方案；正文必须按四拍落地，章末必须留未决问题。')
  }
  // 世界地图生成 / 已有内容反推地点：world 单例 + locations 条目数组，作者在提案页采纳
  if (tasks.has('world-build') || task === 'world-build') {
    lines.push('', '任务：生成世界地图。读作品类型 / 简介 / 补充要求（背景设定），产出 1 份 world 与 8–20 个地点。world 用 novel_desk_propose(kind="world", data=world) 提交：name/scale(city|region|continent|realm)/kind(historical|fictional|mixed)/era/mapSize{w:1000,h:1000}/travelModel{walkKmPerDay,horseKmPerDay,boatKmPerDay}/generatedBy="ai"。地点用 novel_desk_propose(kind="locations", items=[...]) 提交，每个地点含 name/aliases/type/coords（0–1000，分布均匀）/region/firstChapter/connections（含 to/distanceKm/days/mode/bearing，两个方向都要写）/note/source="ai"；坐标只用于画图，距离以 distanceKm 为准。不要改正文。')
  }
  if (tasks.has('world-infer') || task === 'world-infer') {
    lines.push('', '任务：从已有内容反推地点。读 events 与 chapters 的 location 文本、facts 里地点类 subject，按名称 + 别名聚类去重成地点清单；按首次出现章节顺序与相对方位排坐标（0–1000）；world 缺失则一并生成。分别用 novel_desk_propose(kind="world", data=world) 与 novel_desk_propose(kind="locations", items=[...]) 提交，connections 含距离/天数/交通/方位且双向。不要改正文。')
  }
  if (String(body.instruction ?? '').trim()) lines.push('', `补充要求：${String(body.instruction).trim()}`)
  if (items.length === 0) lines.push('', `任务：${TASK_LABEL[task] ?? task}`)
  if (task === 'review-fix') lines.push('请按审稿意见修改对应章节，把修改后的完整章节提交为 chapter 提案（novel_desk_propose），不要直接覆盖正文。')
  else if (task === 'revise-proposal') lines.push('请按作者意见修订原提案，提交为新的提案（novel_desk_propose），不要直接改账本。')
  else if (task === 'import-review') lines.push('请先用 novel_desk_bundle / novel_desk_context 读取项目：补齐缺失的人物卡、时间线、大纲（提交提案）；再对照人物卡、时间线、事实、大纲核查正文冲突，写入审稿（novel_desk_review）；顺手补齐注意力设计（每章一条，design 字段）。涉及移动时优先用已登记的地点与连接，不要出现地图外地点。')
  else if (task === 'full-review') lines.push('请从头审阅整个项目：先读 novel_desk_bundle 和 novel_desk_context，再逐章检查人物、时间线、事实、伏笔、大纲、文风与连续性。把问题写成审稿（novel_desk_review）；需要补设定或改正文的，提交提案（novel_desk_propose），不要直接改正文。按严重度先给 blocker/major，再给 minor。')
  else if (task === 'next-chapter-plan') lines.push('第一优先级：读取大纲和最近章节，先提交本章 attention 设计（planned，type/hook/tension/payoff/cliff/question/designScore），再提交一份下一章方案提案（plan，包含事件/事实/伏笔与 attention 设计）；正文必须按四拍落地。')
  else if (task === 'continue-chapter') lines.push('第一优先级：先提交本章 attention 设计（planned：type/hook/tension/payoff/cliff/question/designScore），再续写正文；正文必须按四拍落地，章末必须留未决问题。')
  else if (task === 'review-chapter') lines.push('请审阅目标章节，把问题写入审稿（novel_desk_review），不要直接改正文。')
  lines.push('', '工作台只负责展示和验收：按上面的清单规则执行，完成后把结果写回工作台，并告诉我生成了哪些提案/审稿/改动。')
  return lines.join('\n')
}

// ── 生成整本书流水线（pipeline.json 单例 + goal 会话）──────────

const PIPELINE_BUDGET_WARN_RATIO = 0.8
const PIPELINE_PROMPT_PRINCIPLE = '> ATTENTION IS ALL YOU NEED——怎么吸引读者怎么来，一切为读者服务；事实自洽是底线。'

function pipelineNow() {
  return new Date().toISOString()
}

function pipelineMaxChapter(chapters) {
  return (chapters ?? []).reduce((max, chapter) => Math.max(max, Number(chapter?.id) || 0), 0)
}

function pipelinePushNote(pipeline, text) {
  return [...(pipeline?.notes ?? []), { at: pipelineNow(), text: String(text) }]
}

/** 预算使用比例（token / 费用任一最大者；未设上限返回 0）。 */
function pipelineBudgetRatio(budget = {}) {
  const ratios = []
  if (Number(budget.maxTokens) > 0) ratios.push((Number(budget.usedTokens) || 0) / Number(budget.maxTokens))
  if (Number(budget.maxCostCNY) > 0) ratios.push((Number(budget.usedCostCNY) || 0) / Number(budget.maxCostCNY))
  return ratios.length > 0 ? Math.max(...ratios) : 0
}

/**
 * 汇总某作品 AI 用量：复用 usage.summary 的 tokens/费用口径（有 ctx 时直接调它）。
 * 无宿主会话服务时退回 usage.json 的工作台 one-shot 记录，保证工具/测试可用。
 */
export async function summarizeUsage(root, projectId, ctx = null) {
  if (ctx?.get) {
    try {
      const summary = await handleRpc({ op: 'usage.summary', projectId }, ctx)
      return {
        tokens: (summary.chat?.totalTokens ?? 0) + (summary.workbench?.total?.totalTokens ?? 0),
        workbenchTokens: summary.workbench?.total?.totalTokens ?? 0,
        chatTokens: summary.chat?.totalTokens ?? 0,
        costUSD: summary.cost?.usd ?? 0,
        costCNY: summary.cost?.cny ?? 0,
        calls: summary.metrics?.aiCalls ?? 0,
        sessions: summary.metrics?.sessionCount ?? 0,
      }
    } catch {
      /* 宿主服务不全时走本地口径 */
    }
  }
  const records = await listUsageRecords(root, projectId)
  const prices = await loadModelPrices()
  let tokens = 0
  let costUSD = 0
  for (const row of records) {
    tokens += Number(row.totalTokens) || 0
    const cost = estimateSessionCost({
      provider: row.provider,
      model: row.model,
      events: [{ time: Date.parse(row.at) || Date.now(), inputTokens: row.inputTokens ?? 0, cacheReadTokens: row.cacheReadTokens ?? 0, cacheWriteTokens: row.cacheWriteTokens ?? 0, outputTokens: row.outputTokens ?? 0 }],
    }, prices)
    if (cost) costUSD += cost.usd
  }
  return {
    tokens,
    workbenchTokens: tokens,
    chatTokens: 0,
    costUSD: Math.round(costUSD * 10000) / 10000,
    costCNY: Math.round((costUSD / 0.15) * 10000) / 10000,
    calls: records.length,
    sessions: 0,
  }
}

/**
 * 估算本次流水线 token 与费用（数量级提示，估算不准）：
 * 写 ≈ 章数×字数×1.6，审 ×0.8，修 ×1.2；¥ 按约 2 元/百万 token 粗估。
 */
export function estimatePipeline(bundle, pipelineInput = {}) {
  const pipeline = { ...defaultPipeline(), ...pipelineInput }
  const base = pipeline.base ?? {}
  const currentMax = pipelineMaxChapter(bundle.chapters)
  const mode = pipeline.mode === 'chapters' ? 'chapters' : 'book'
  const target = mode === 'chapters'
    ? currentMax + Math.max(0, Number(pipeline.count) || 0)
    : (Number(pipeline.targetChapter) || Number(bundle.project?.targetChapters) || 0)
  const chapters = Math.max(0, target - currentMax)
  const wordsPerChapter = Math.max(1, Number(base.wordsPerChapter) || 3000)
  const writeTokens = Math.round(chapters * wordsPerChapter * 1.6)
  const reviewTokens = Math.round(writeTokens * 0.8)
  const fixTokens = Math.round(writeTokens * 1.2)
  const totalTokens = writeTokens + reviewTokens + fixTokens
  return {
    mode,
    chapters,
    wordsPerChapter,
    writeTokens,
    reviewTokens,
    fixTokens,
    totalTokens,
    costCNY: Math.round((totalTokens / 1_000_000) * 2 * 100) / 100,
    note: '估算不准，仅作数量级提示；实际含上下文/系统开销会更高。',
  }
}

function pipelineStageLines(pipeline) {
  const lines = (pipeline.stages ?? [])
    .filter((stage) => stage.status !== 'done')
    .map((stage) => `- ${stage.id}｜${stage.name}｜第 ${stage.chapterFrom}–${stage.chapterTo} 章`)
  return lines.length > 0 ? lines : ['- （本次所有阶段已完成）']
}

/** goal prompt：一个 run = 一个新会话 + 这一条 prompt，之后靠会话自己的 goal + subagent 自动推进。 */
export function buildPipelineGoalPrompt(bundle, pipelineInput = {}) {
  const pipeline = { ...defaultPipeline(), ...pipelineInput }
  const project = bundle.project ?? {}
  const chapters = bundle.chapters ?? []
  const currentMax = pipelineMaxChapter(chapters)
  const fromChapter = currentMax + 1
  const mode = pipeline.mode === 'chapters' ? 'chapters' : 'book'
  const count = Math.max(0, Number(pipeline.count) || 0)
  const target = Math.max(fromChapter, Number(pipeline.targetChapter) || fromChapter + count - 1)
  const perVolume = Math.max(1, Number(pipeline.base?.chaptersPerVolume) || 10)
  const remaining = Math.max(0, target - currentMax)
  const volumeCount = Math.max(1, Math.ceil(remaining / perVolume))
  const maxRounds = Math.max(50, target * 2)
  const budget = pipeline.budget ?? {}
  const stopText = mode === 'book'
    ? `写到第 ${target} 章完结（第 ${fromChapter}–${target} 章，共 ${remaining} 章）`
    : `再写 ${count} 章（第 ${fromChapter}–${target} 章，共 ${remaining} 章）并完成一次审阅 + 修订后停`
  const lines = [
    PIPELINE_PROMPT_PRINCIPLE,
    '',
    `# 生成整本书 · ${project.name || '未命名作品'}`,
    `projectId=${project.id} ｜ runId=${pipeline.runId || '（启动后生成）'} ｜ 模式：${mode === 'book' ? '生成全文' : `按 ${count} 章生成`} ｜ 当前 ${chapters.length} 章 / ${bundle.stats?.words ?? 0} 字`,
    `停止条件：${stopText}`,
    `规模：每卷 ${perVolume} 章，本次约 ${volumeCount} 卷；每章约 ${Number(pipeline.base?.wordsPerChapter) || 3000} 字。`,
    '',
    '## 第一步：先 create_goal',
    `先调用 create_goal 建立长期目标：objective=「按目标章数（第 ${fromChapter}–${target} 章）写完本书：每卷写→审→修，最后总审+总修」；max_goal_rounds 至少 ${maxRounds}（按每章 1–2 轮，最少 50）。goal 全部完成前不要结束。`,
    '你是本书的总编/导演：自己排期、自己推进，不要再问作者要确认。',
    '',
    '## 编排方式：用 subagent / Team 分派',
    '- 若缺蓝图/大纲/世界/注意力设计：先派子 Agent 补（准备阶段的产物），不要跳过；',
    '- 逐卷写作：每卷派一个写作子 Agent，按本卷大纲与每章注意力设计写章节；',
    '- 每卷审阅（一次）：连续性 / 人物 / 时间线 / 文笔 可分并行子 Agent；每章另出 0–100 冷读实测；',
    '- 每卷修订（一次）：按审稿意见出章节修订提案，由工作台自动采纳；',
    '- 全书总审 + 总修各一次；最后提示作者交给独立审稿人冷读。',
    '',
    '## 每卷循环（严格按顺序，不要问作者、不要中途停）',
    '1. 写本卷：每章先有 attention planned 设计（type/hook/tension/payoff/cliff/question/designScore），再提交章节正文提案；',
    '2. 审本卷一次：审稿用 novel_desk_review；每章冷读给 0–100 实测，提交 attention 实测提案（score/verdict/weakest/dropRisk/detail）；',
    '3. 修本卷一次：按审稿意见提交章节修订提案（见下方“自动采纳”）；',
    '4. 立刻进入下一卷，不要等作者回复；每完成一卷自己汇报一句（第几卷/章数/字数/注意力均分）然后继续。',
    '',
    '## 修订自动采纳（重要）',
    `修订提案必须带 data.pipelineRunId="${pipeline.runId || ''}" 和 data.reviewIds=[对应审稿 id]；工作台识别到 runId 匹配、run 正在跑、kind='chapter' 时会立即自动采纳并写入正文（留 autoAccepted 标记）。`,
    '不要用 novel_desk_upsert 直接改正文；attention 设计与实测仍按 kind=attention 提案提交，审稿写 novel_desk_review。',
    '',
    '## 进度上报：novel_desk_pipeline',
    '- 开始一个阶段：novel_desk_pipeline(op=stage, stageId=..., status=running, note=...)；',
    '- 完成一个阶段：novel_desk_pipeline(op=stage, stageId=..., status=done, note=...)；',
    '- 全部完成：novel_desk_pipeline(op=finish, note=...)；卡住无法推进：novel_desk_pipeline(op=stuck, reason=...)。',
    '本次阶段清单（按顺序执行）：',
    ...pipelineStageLines(pipeline),
    '',
    '## 收尾阶段 final-cleanup（全书写完后自动执行，必须做）',
    '当所有卷 + 总审 + 总修完成后，执行 final-cleanup：通读全书，按章补齐缺失账本（缺什么补什么），然后用 novel_desk_pipeline(op="finish") 触发工作台自动收尾（采纳账本提案、驳回过期章节提案、归档未处理审查、生成 cleanup 报告）。',
    '按章补齐清单：',
    '- 人物：每章出场人物卡/身份/关系，缺卡就补 kind=characters；',
    '- 事实：身份/年龄/地点/物品归属/伤势等硬事实 kind=facts；',
    '- 事件与时间线：kind=events（storyTime、地点、参与人、后果）；',
    '- 高光：真正值得保留的段落 kind=highlights；',
    '- 伏笔：埋设章/回收章 kind=foreshadow；',
    '- 冲突：参与方与解决章 kind=conflicts；',
    '- 地点：名称/坐标/连接 kind=locations（缺世界先补 kind=world）；',
    '- 大纲：每章节拍 kind=outlines；',
    '- 注意力实测：每个已写章节必须有实测记录（score/verdict/weakest/dropRisk/detail，四维与弃读点）kind=attention；',
    '硬要求：全部用 novel_desk_propose 提案并带 data.pipelineRunId="' + (pipeline.runId || '') + '"，不要直接 upsert 改账本；已写章节必须至少有 attention 实测、人物/地点引用必须有卡；补齐后核对一遍再无遗漏。',
    '',
    '## 预算',
    `本次预算：token 上限 ${Number(budget.maxTokens) || 0}（0=不限）｜费用上限 ¥${Number(budget.maxCostCNY) || 0}（0=不限）。`,
    '达到 80% 会收到预警，达到 100% 会自动暂停；接近上限时先收尾当前卷、上报进度并主动 finish 或等待恢复。预算只约束本次 run。',
    '',
    '## 完成时',
    '',
    '全部完成后才调用 goal complete，并汇报：卷数 / 章数 / 总字数 / 平均注意力分 / 最低章 / 建议交给独立审稿人冷读。',
  ]
  return lines.join('\n')
}

/** 准备阶段 prompt：先注意力后事实，产出蓝图 + 大纲 + 每章 attention 设计，全部提案、不写正文。 */
export function buildPipelinePreparePrompt(bundle, pipelineInput = {}) {
  const pipeline = { ...defaultPipeline(), ...pipelineInput }
  const project = bundle.project ?? {}
  const base = pipeline.base ?? {}
  const target = Number(pipeline.targetChapter) || Number(project.targetChapters) || 0
  const perVolume = Math.max(1, Number(base.chaptersPerVolume) || 10)
  const volumeCount = Number(base.volumes) || (target > 0 ? Math.ceil(target / perVolume) : 0)
  const lines = [
    PIPELINE_PROMPT_PRINCIPLE,
    '',
    `# 准备阶段 · ${project.name || '未命名作品'}`,
    `projectId=${project.id} ｜ 目标 ${target || '未设'} 章 ｜ 每卷 ${perVolume} 章 ｜ 每章约 ${Number(base.wordsPerChapter) || 3000} 字 ｜ 约 ${volumeCount || '—'} 卷`,
    `设定：${[
      base.premise ? `一句话=${base.premise}` : '',
      base.genre || project.genre ? `类型=${base.genre || project.genre}` : '',
      base.style ? `风格=${base.style}` : '',
      base.era ? `时代=${base.era}` : '',
      base.locations ? `地点=${base.locations}` : '',
      base.characters ? `人物=${base.characters}` : '',
    ].filter(Boolean).join(' ｜ ')}`,
    '',
    '这是准备阶段：产出「事实 + 注意力蓝图 + 全书大纲 + 每章注意力设计」交给作者验收。',
    '顺序：先注意力，再事实；全部用 novel_desk_propose 提交提案，不要直接 upsert，不要写正文。',
    '',
    '## ① 注意力蓝图（先做）',
    `- 按卷设计：第 1–${volumeCount || 'N'} 卷各自主类型（event|emotion|language|mystery|relationship）、节奏与目标分曲线；`,
    `- 每章给目标分 designScore（0–100，全书曲线有起伏，避免连续 4 章同型）；`,
    '- 用 kind=attention 提交（每章一个 item，status="planned"，先不要 score）。',
    '',
    '## ② 事实底座（提案）',
    '- 世界：kind=world（名称/尺度/类型/时代/mapSize/travelModel）+ kind=locations（8–20 个地点，坐标 0–1000、别名、双向连接含距离/天数/交通/方位）；',
    '- 人物：kind=characters（主角/反派/关键配角：目标、动机、缺陷、弧光、关系）；',
    '- 事实骨架：kind=facts（身份/年龄/地点/物品归属/伤势等硬事实，标 first chapter）；',
    '- 冲突：kind=conflicts（核心对抗、赌注、升级路径）；伏笔：kind=foreshadow（setupChapter/payoffChapter/status）；',
    '',
    '## ③ 全书大纲（提案）',
    '- kind=outlines：每卷/每章标题、summary、3–5 个 beats；主线与支线要收得住，卷末有钩子；',
    '',
    '## ④ 每章 attention planned 设计（提案）',
    '- kind=attention：每章一条，含 chapter/type/hook/tension/payoff/cliff/question/designScore/status="planned"；',
    '- 章末必须留下未决问题；同一类型不要连续超过 3 章。',
    '',
    '## 提交与收尾',
    '- 全部内容先提交提案；不要写正文，不要直接改账本；',
    `- 预算：token 上限 ${Number(pipeline.budget?.maxTokens) || 0}（0=不限）｜费用上限 ¥${Number(pipeline.budget?.maxCostCNY) || 0}（0=不限）；`,
    '- 完成后汇报：提交了哪些提案（世界/地点/人物/事实/冲突/伏笔/大纲/注意力各多少条），等待作者验收（markPrepared 后才会启动生成）。',
  ]
  return lines.join('\n')
}

/** 恢复（用户手动触发）时发给同一会话的续跑 prompt。 */
export function buildPipelineResumePrompt(pipelineInput = {}) {
  const pipeline = { ...defaultPipeline(), ...pipelineInput }
  const current = (pipeline.stages ?? []).find((stage) => stage.id === pipeline.currentStage)
  return [
    '续跑（用户手动触发）：继续「生成整本书」goal。',
    `runId=${pipeline.runId || '（无）'} ｜ 当前阶段：${current ? `${current.name}（${current.id}）` : '未知'} ｜ 目标第 ${pipeline.targetChapter || '?'} 章。`,
    '按原 goal prompt 的卷循环继续：写 → 审一次 → 修一次（章节修订提案带 data.pipelineRunId 与 data.reviewIds，工作台自动采纳）→ 下一卷；不要问作者、不要中途停；每步用 novel_desk_pipeline 上报；完成后 goal complete 并汇报。',
  ].join('\n')
}

/** 新建会话并投递一条 prompt（流水线专用；与 chat.send 的 newSession 行为一致）。 */
async function startPipelineSession(ctx, root, bundle, prompt) {
  if (!ctx?.get) throw new Error('宿主未提供会话服务，无法启动流水线')
  const controller = ctx.get('sessionController')
  if (!controller?.create || !controller?.prompt) throw new Error('宿主未提供会话服务，无法启动流水线')
  const project = await ensureProjectWorkspace(ctx, bundle.project)
  bundle.project = project
  const workspacePath = project.workspacePath || project.rootPath || ''
  const created = await controller.create(project.workspaceId ? { workspaceId: project.workspaceId } : {})
  const sessionId = created?.sessionId
  if (!sessionId) throw new Error('宿主新建会话失败')
  await controller.prompt({
    requestId: randomUUID(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
    clientTimeZone: 'Asia/Shanghai',
  }, AbortSignal.timeout(20000))
  return { sessionId, workspacePath, project }
}

/**
 * 所有审阅的硬性边界（去 AI 化 / 零上下文首读 / 提分工作单 / 复测 / 全文重新审阅共用）。
 * 清单之外一律不许读：这是「不能污染本书」的底线，不是建议。
 */
export const REVIEW_ISOLATION_LINES = [
  '## 审阅隔离（硬性边界，违反任何一条本次审阅作废）',
  '1. 只能读下面列出的章节文件（清单在最后）；禁止读取清单以外的任何文件或路径（上级目录、其他作品目录、library.json、历史审阅报告、旧基线、临时草稿）。',
  '2. 绝对禁止跨作品对比：不得把任何其他作品当「人类对照 / 人写基线」，输出里不得出现其他书名或其他作品的人物名。',
  '3. 除非作者在本轮明确指定了目录或文件，否则不得打开清单之外的任何东西；缺材料就停下来问作者，不要自己去翻。',
  '4. 只提交审阅/打分/提案结果，不要改正文。',
]

/**
 * 带上下文的审阅（工作台把账本/大纲/人物卡直接写进 prompt，不需要读文件清单）用的隔离边界：
 * 同样禁止跨作品、禁止读本书工作台以外的文件。
 */
export const REVIEW_ISOLATION_NOTICE_LINES = [
  '## 审阅隔离（硬性边界，违反任何一条本次审阅作废）',
  '1. 只审当前这一本书：禁止读取本书工作台目录以外的任何文件或路径（其他作品目录、library.json、历史审阅报告、旧基线、临时草稿）。',
  '2. 绝对禁止跨作品对比：不得把任何其他作品当「人类对照 / 人写基线」，输出里不得出现其他书名或其他作品的人物名。',
  '3. 除非作者在本轮明确指定了目录或文件，否则不要打开本书工作台之外的东西；缺材料就停下来问作者，不要自己去翻。',
  '4. 只提交审阅/打分/提案结果，不要改正文。',
]

/** 审阅隔离区根目录（每本书一个；真正的副本放在每次新建的子目录里，见 prepareReviewSandbox）。 */
function reviewSandboxDir(root, project) {
  const raw = String(project?.name || project?.id || 'book').trim()
  const safe = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+|\.+$/g, '').trim().slice(0, 40) || 'book'
  return join(root, '.review-workspaces', `${safe}-${String(project?.id ?? '').slice(-6)}`)
}

/** 同一本书同时可能有多个审阅在跑（全文审阅慢慢读、提分工作单随时出），按章集合分目录，互不清理。 */
function pruneReviewSandboxes(baseDir, keep = 8) {
  let entries = []
  try {
    entries = readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{12}$/.test(entry.name))
      .map((entry) => ({ name: entry.name, at: statSync(join(baseDir, entry.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
  } catch {
    return
  }
  for (const entry of entries.slice(keep)) rmSync(join(baseDir, entry.name), { recursive: true, force: true })
}

/**
 * 章节集合指纹：同一批章号 + 同一批正文 → 同一个目录（幂等）。
 * 不同章集合（全书审阅 vs 单章工作单）落在不同目录，不会互相清文件。
 */
function reviewSandboxKey(chapters) {
  const hash = createHash('sha1')
  for (const chapter of chapters) {
    hash.update(String(chapter.id))
    hash.update('\u0000')
    hash.update(String(chapter.content ?? ''))
    hash.update('\u0001')
  }
  return hash.digest('hex').slice(0, 12)
}

/**
 * 准备审阅隔离区：只把本书章节正文复制进去（不带元数据、不带账本、不带历史报告、不带其他作品）。
 * chapterNumbers=null 复制全书；传数组只复制这些章。同步实现，供同步 prompt 构造器直接调用。
 * 目录名由「章号 + 正文」的 sha1 前 12 位决定：同一批章重复调用落到同一目录（幂等），
 * 全书审阅与单章工作单章集合不同、目录不同，不会互相清文件；每个目录只保留最近 8 份，更早的自动清掉。
 * 返回 { dir, chapterFiles, byId }，chapterFiles 会写进 prompt 的「唯一允许读取」清单。
 */
export function prepareReviewSandbox(root, bundle = {}, chapterNumbers = null) {
  const baseDir = reviewSandboxDir(root, bundle.project)
  const wanted = chapterNumbers === null ? null : new Set((chapterNumbers ?? []).map((n) => Number(n)))
  const chapters = (bundle.chapters ?? []).slice()
    .filter((chapter) => !wanted || wanted.has(Number(chapter.id)))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const dir = join(baseDir, reviewSandboxKey(chapters))
  const chaptersDir = join(dir, 'chapters')
  mkdirSync(chaptersDir, { recursive: true })
  const chapterFiles = []
  const byId = new Map()
  const keepNames = new Set()
  for (const chapter of chapters) {
    const number = Number(chapter.id)
    const id = String(chapter.id ?? '').padStart(4, '0')
    const path = join(chaptersDir, `${id}.md`)
    writeFileSync(path, String(chapter.content ?? ''), 'utf8')
    keepNames.add(`${id}.md`)
    const row = { id, title: String(chapter.title ?? ''), words: String(chapter.content ?? '').length, path }
    chapterFiles.push(row)
    byId.set(number, row)
  }
  for (const name of readdirSync(chaptersDir)) {
    if (!keepNames.has(name)) rmSync(join(chaptersDir, name), { force: true })
  }
  const now = new Date()
  try {
    utimesSync(dir, now, now)
  } catch {}
  pruneReviewSandboxes(baseDir, 8)
  return { dir, chapterFiles, byId }
}

/** prompt 构造器用：有 root 一定走隔离区；只有手工 bundle（无 root）才退回项目目录。 */
function reviewSandboxFor(bundle, rootPath, chapterNumbers = null) {
  const root = String(bundle?.root ?? rootPath ?? '')
  if (!root) return null
  return prepareReviewSandbox(root, bundle, chapterNumbers)
}

/**
 * 准备「去 AI 化审阅」隔离工作区（与所有审阅共用同一套隔离区）。
 * 返回的 chapterFiles 会写进 prompt 的只读清单，AI 只能读这些文件。
 */
export async function prepareDeaiWorkspace(root, bundle = {}) {
  const sandbox = prepareReviewSandbox(root, bundle, null)
  return { dir: sandbox.dir, chapterFiles: sandbox.chapterFiles }
}

/** 建/复用隔离工作区对应的 DSH workspace；返回 workspaceId。 */
async function ensureReviewWorkspace(ctx, dir, title) {
  const registry = ctx?.get?.('workspaceRegistry')
  if (!registry?.resolveByPath || !registry?.create) return null
  let workspace = null
  try { workspace = await registry.resolveByPath(dir) } catch { workspace = null }
  if (!workspace) workspace = await registry.create(dir, title)
  else if (workspace.title !== title && typeof workspace.setTitle === 'function') {
    try { await workspace.setTitle(title) } catch { /* ignore */ }
  }
  return workspace?.id ?? null
}

/** 在隔离区里新建空会话（workspace 也指向隔离区，AI 的 cwd 里看不到任何其他作品）。 */
async function startIsolatedReviewSession(ctx, root, project, prompt) {
  const workspaceId = await ensureReviewWorkspace(ctx, root, `审阅 · ${String(project?.name ?? '').trim() || String(project?.id ?? '')}`)
  if (!workspaceId) throw new Error('无法注册审阅隔离工作区：宿主未提供 workspaceRegistry')
  const controller = ctx?.get?.('sessionController')
  if (!controller?.create || !controller?.prompt) throw new Error('宿主未提供会话服务，无法启动独立审阅')
  const created = await controller.create({ workspaceId })
  const sessionId = created?.sessionId
  if (!sessionId) throw new Error('宿主新建会话失败')
  await controller.prompt({
    requestId: randomUUID(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
    clientTimeZone: 'Asia/Shanghai',
  }, AbortSignal.timeout(20000))
  return { sessionId, workspaceId }
}

/**
 * 启动「去 AI 化审阅」：独立空会话 + 隔离工作区（只含本书章节正文副本）+ 写死边界的 prompt。
 * 这是 review.startDeai RPC 与 novel_desk_deai_review 工具的共同实现。
 */
export async function startDeaiReview(root, projectId, ctx = null, options = {}) {
  const bundle = await getBundle(root, projectId)
  assertActivePreset(bundle)
  const audit = auditAiStyle(bundle.chapters ?? [])
  const workspace = await prepareDeaiWorkspace(root, bundle)
  const prompt = buildAiStyleReviewPrompt(bundle, audit, { chapterFiles: workspace.chapterFiles })
  const auditBrief = { overall: audit.overall, flags: audit.flags, mdChapters: audit.mdChapters }
  const base = {
    prompt,
    workspacePath: workspace.dir,
    chapterCount: workspace.chapterFiles.length,
    audit: auditBrief,
    summary: auditSummaryText(audit),
  }
  if (options.dryRun) return base
  const { sessionId } = await startIsolatedReviewSession(ctx, workspace.dir, bundle.project, prompt)
  return { ...base, sessionId }
}


/**
 * 启动「全文重新审阅」：独立空会话 + 隔离工作区（只含本书章节副本）+ 写死边界的通读 prompt。
 * review.startFull RPC 的实现。
 */
export async function startFullBookReview(root, projectId, input = {}, ctx = null) {
  const bundle = await getBundle(root, projectId)
  assertActivePreset(bundle)
  const focus = Array.isArray(input.focus)
    ? input.focus
    : String(input.focus ?? '').split(/[\n、,，]+/).map((item) => item.trim()).filter(Boolean)
  const sandbox = prepareReviewSandbox(root, bundle, null)
  const prompt = buildFullBookReviewPrompt(bundle, { focus, sandbox })
  const { sessionId } = await startIsolatedReviewSession(ctx, sandbox.dir, bundle.project, prompt)
  return { sessionId, prompt, focus, workspacePath: sandbox.dir, chapterCount: sandbox.chapterFiles.length }
}

/** 向已存在的会话投递一条 prompt（恢复/兜底用）。 */
async function sendPipelinePrompt(ctx, sessionId, prompt) {
  const controller = ctx?.get?.('sessionController')
  if (!controller?.prompt) throw new Error('宿主未提供会话服务，无法发送续跑 prompt')
  await controller.prompt({
    requestId: randomUUID(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
    clientTimeZone: 'Asia/Shanghai',
  }, AbortSignal.timeout(20000))
  return { sessionId }
}

/** 准备阶段：生成阶段列表 + 新会话 + 准备阶段 prompt。 */
export async function preparePipeline(root, projectId, input = {}, ctx = null) {
  const bundle = await getBundle(root, projectId)
  assertActivePreset(bundle)
  const current = await getPipeline(root, projectId)
  if (current.status === 'running') throw new Error('流水线正在运行，先暂停/结束再重新准备')
  const preset = resolveActivePreset(bundle)
  const targetChapter = Number(bundle.project.targetChapters)
    || pipelineMaxChapter((bundle.outlines ?? []).map((outline) => ({ id: outline.chapter })))
    || pipelineMaxChapter(bundle.chapters)
    || 0
  const chaptersPerVolume = Math.max(1, Number(input.base?.chaptersPerVolume) || Number(current.base.chaptersPerVolume) || 10)
  const wordsPerChapter = Math.max(1,
    Number(input.base?.wordsPerChapter)
    || Number(current.base.wordsPerChapter)
    || Number(preset.chapterWords)
    || (targetChapter > 0 && Number(bundle.project.targetWords) ? Math.round(Number(bundle.project.targetWords) / targetChapter) : 0)
    || 3000)
  const base = {
    premise: String(input.base?.premise ?? current.base.premise ?? bundle.project.logline ?? ''),
    genre: String(input.base?.genre ?? current.base.genre ?? bundle.project.genre ?? ''),
    style: String(input.base?.style ?? current.base.style ?? preset.tone ?? ''),
    era: String(input.base?.era ?? current.base.era ?? bundle.world?.era ?? ''),
    locations: String(input.base?.locations ?? current.base.locations ?? (bundle.locations ?? []).map((loc) => loc.name).join('、')),
    characters: String(input.base?.characters ?? current.base.characters ?? (bundle.characters ?? []).map((c) => c.name).join('、')),
    volumes: Number(input.base?.volumes) || Number(current.base.volumes) || (targetChapter > 0 ? Math.ceil(targetChapter / chaptersPerVolume) : 0),
    chaptersPerVolume,
    wordsPerChapter,
  }
  const budget = {
    maxTokens: Number(input.budget?.maxTokens) || Number(current.budget.maxTokens) || 0,
    maxCostCNY: Number(input.budget?.maxCostCNY) || Number(current.budget.maxCostCNY) || 0,
    usedTokens: 0,
    usedCostCNY: 0,
    baseline: null,
  }
  const fromChapter = pipelineMaxChapter(bundle.chapters) + 1
  const stages = buildPipelineStages(base, 'book', 0, targetChapter, fromChapter)
  const saved = await savePipeline(root, projectId, {
    status: 'preparing',
    runId: '',
    mode: 'book',
    count: 0,
    sessionId: '',
    targetChapter,
    base,
    budget,
    stages,
    currentStage: 'prep-blueprint',
    prepared: { blueprint: false, outline: false },
    notes: pipelinePushNote(current, '开始准备阶段：事实与注意力蓝图 + 全书大纲 + 每章注意力设计'),
  })
  const prompt = buildPipelinePreparePrompt(bundle, saved)
  const session = await startPipelineSession(ctx, root, bundle, prompt)
  const pipeline = await savePipeline(root, projectId, { sessionId: session.sessionId })
  return { pipeline, sessionId: session.sessionId, prompt }
}

/** 作者验收：蓝图/大纲 prepared，准备阶段收尾，进入 ready。 */
export async function markPipelinePrepared(root, projectId) {
  const pipeline = await getPipeline(root, projectId)
  if (!pipeline.stages.length) throw new Error('还没有准备阶段：先调用 pipeline.prepare')
  const stages = pipeline.stages.map((stage) => (
    stage.kind === 'prep-blueprint' || stage.kind === 'prep-outline' ? { ...stage, status: 'done' } : stage
  ))
  const next = stages.find((stage) => stage.status === 'pending') ?? null
  return savePipeline(root, projectId, {
    status: 'ready',
    prepared: { blueprint: true, outline: true },
    stages,
    currentStage: next?.id ?? null,
    notes: pipelinePushNote(pipeline, '作者已验收蓝图与大纲，可以启动生成'),
  })
}

/**
 * 开工前自动快照：保证任何自动改动都能整本回滚。
 * 快照失败不阻断开工（只记日志），但会在控制台提示。
 */
async function autoSnapshotBeforeRun(root, projectId, label, runId = '') {
  try {
    return await createSnapshot(root, projectId, { label, trigger: 'run-start', runId })
  } catch (error) {
    console.error('[story-desk] 开工前快照失败：', error instanceof Error ? error.message : String(error))
    return null
  }
}

/** 启动一次 run：生成 runId/阶段/目标，新会话投递 goal prompt。 */
export async function startPipelineRun(root, projectId, options = {}, ctx = null) {
  const bundle = await getBundle(root, projectId)
  assertActivePreset(bundle)
  const current = await getPipeline(root, projectId)
  if (current.status === 'running') throw new Error('流水线已经在运行')
  const currentMax = pipelineMaxChapter(bundle.chapters)
  const hasMaterial = (bundle.chapters ?? []).some((chapter) => String(chapter.content ?? '').trim()) || (bundle.outlines ?? []).length > 0
  const prepared = { ...current.prepared }
  if (!hasMaterial) {
    if (!prepared.blueprint || !prepared.outline) {
      throw new Error('新书必须先完成准备阶段并验收蓝图/大纲（pipeline.prepare → markPrepared）才能启动生成')
    }
  } else {
    prepared.blueprint = true
    prepared.outline = true
  }
  const mode = options.mode === 'chapters' ? 'chapters' : 'book'
  const count = Math.max(0, Number(options.count) || Number(current.count) || 0)
  let targetChapter
  const requestedTarget = Math.max(0, Number(options.targetChapter) || 0)
  if (mode === 'chapters') {
    if (count <= 0) throw new Error('按 N 章生成需要 count > 0')
    targetChapter = currentMax + count
  } else {
    // 半成品/新建都允许在「生成设置」里显式指定目标章数；没给才回退项目目标/大纲末章/上次 run 的目标
    targetChapter = requestedTarget
      || Number(bundle.project.targetChapters)
      || Math.max(0, ...(bundle.outlines ?? []).map((outline) => Number(outline.chapter) || 0))
      || Number(current.targetChapter)
      || 0
    if (targetChapter <= currentMax) throw new Error(`目标章数（${targetChapter || '未设置'}）不大于当前进度（${currentMax} 章），无法启动生成全文。请在「整本书 → 生成设置」里填写目标章数。`)
  }
  const fromChapter = currentMax + 1
  const base = { ...current.base, ...(options.base && typeof options.base === 'object' ? options.base : {}) }
  base.chaptersPerVolume = Math.max(1, Number(base.chaptersPerVolume) || 10)
  base.volumes = Number(base.volumes) || Math.ceil((targetChapter - fromChapter + 1) / base.chaptersPerVolume)
  const stages = buildPipelineStages(base, mode, count, targetChapter, fromChapter)
  for (const stage of stages) {
    if (stage.kind === 'prep-blueprint' || stage.kind === 'prep-outline') {
      stage.status = 'done'
      stage.note = prepared.blueprint ? '准备阶段已完成/沿用现有设定' : '沿用已有材料'
    }
  }
  const runId = `run-${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
  await autoSnapshotBeforeRun(root, projectId, `生成整本书开工前 · 目标第 ${targetChapter} 章`, runId)
  const usageBefore = await summarizeUsage(root, projectId, ctx)
  const budget = {
    maxTokens: Number(options.budget?.maxTokens) || Number(current.budget.maxTokens) || 0,
    maxCostCNY: Number(options.budget?.maxCostCNY) || Number(current.budget.maxCostCNY) || 0,
    usedTokens: 0,
    usedCostCNY: 0,
    baseline: { tokens: usageBefore.tokens, costCNY: usageBefore.costCNY },
  }
  const startNote = mode === 'book' ? `启动生成全文：目标第 ${targetChapter} 章` : `启动按 ${count} 章生成：第 ${fromChapter}–${targetChapter} 章`
  const saved = await savePipeline(root, projectId, {
    status: 'running',
    runId,
    mode,
    count: mode === 'chapters' ? count : 0,
    sessionId: '',
    targetChapter,
    base,
    budget,
    stages,
    currentStage: stages.find((stage) => stage.status === 'pending')?.id ?? null,
    prepared,
    notes: pipelinePushNote(current, startNote),
  })
  const prompt = buildPipelineGoalPrompt(bundle, saved)
  let session
  try {
    session = await startPipelineSession(ctx, root, bundle, prompt)
  } catch (error) {
    await savePipeline(root, projectId, {
      status: 'stuck',
      notes: pipelinePushNote(saved, `启动 goal 会话失败：${error instanceof Error ? error.message : String(error)}`),
    })
    throw error
  }
  const pipeline = await savePipeline(root, projectId, { sessionId: session.sessionId })
  return { pipeline, sessionId: session.sessionId, prompt }
}

/**
 * 收尾清理：处理所有 pending 提案（非章节尽量采纳、过期章节驳回）、归档未处理审阅，写 cleanup 报告。
 * scope='run' 只处理 data.pipelineRunId === 本次 runId 的提案；默认 'all' 清理整个项目。
 * @returns {Promise<object>} cleanup 报告（另附 pipeline 字段便于调用方读取最新状态）
 */
export async function finalizePipelineCleanup(root, projectId, options = {}) {
  const scope = options.scope === 'run' ? 'run' : 'all'
  const pipeline = await getPipeline(root, projectId)
  const bundle = await getBundle(root, projectId)
  const report = {
    scope,
    acceptedProposals: 0,
    rejectedChapter: 0,
    closedReviews: 0,
    failed: [],
    at: pipelineNow(),
  }
  const pending = (bundle.proposals ?? []).filter((proposal) => proposal.status === 'pending')
  const targets = scope === 'run'
    ? pending.filter((proposal) => String(proposal.data?.pipelineRunId ?? '') === String(pipeline.runId ?? ''))
    : pending
  for (const proposal of targets) {
    try {
      if (proposal.kind === 'chapter') {
        // 过期章节稿：正文已经写完，采纳会覆盖成品 → 一律驳回
        await rejectProposal(root, projectId, proposal.id)
        report.rejectedChapter += 1
      } else {
        await acceptProposal(root, projectId, proposal.id)
        report.acceptedProposals += 1
      }
    } catch (error) {
      report.failed.push({ id: proposal.id, kind: proposal.kind, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // 归档所有未处理审阅（fixed/wontfix 之外）：wontfix + 说明留给作者二次审阅
  const openReviewIds = (bundle.reviews ?? [])
    .filter((review) => review.status !== 'fixed' && review.status !== 'wontfix')
    .map((review) => review.id)
  if (openReviewIds.length > 0) {
    try {
      const result = await batchUpdateReviews(root, projectId, openReviewIds, { status: 'wontfix' })
      report.closedReviews = result.updated ?? openReviewIds.length
      if (Array.isArray(result.missing) && result.missing.length > 0) {
        report.failed.push({ id: 'reviews', kind: 'reviews', error: `未找到 ${result.missing.length} 条审阅` })
      }
    } catch (error) {
      report.failed.push({ id: 'reviews', kind: 'reviews', error: error instanceof Error ? error.message : String(error) })
    }
  }
  const notes = pipelinePushNote(
    pipeline,
    `收尾：采纳 ${report.acceptedProposals} 条提案、驳回 ${report.rejectedChapter} 条过期章节提案、归档 ${report.closedReviews} 条审阅`,
  )
  const saved = await savePipeline(root, projectId, {
    ...(pipeline.status === 'running' ? { status: 'done' } : {}),
    cleanup: report,
    notes,
  })
  return { ...report, pipeline: saved }
}

/** 阶段上报（RPC 与 MCP 工具共用）：done 后推进 currentStage、结算预算。 */
export async function advancePipeline(root, projectId, input = {}, ctx = null) {
  const pipeline = await getPipeline(root, projectId)
  if (!pipeline.runId && pipeline.status !== 'preparing') throw new Error('还没有运行中的流水线')
  const stageId = String(input.stageId ?? '')
  const stage = (pipeline.stages ?? []).find((row) => row.id === stageId)
  if (!stage) throw new Error(`没有这个阶段：${stageId}`)
  const status = ['running', 'done', 'failed', 'skipped'].includes(input.status) ? input.status : 'done'
  const now = pipelineNow()
  const stages = pipeline.stages.map((row) => (row.id === stageId
    ? { ...row, status, ...(status === 'running' ? { startedAt: row.startedAt ?? now } : {}), ...(status === 'done' ? { doneAt: now } : {}) }
    : row))
  let notes = [...pipeline.notes]
  if (String(input.note ?? '').trim()) notes.push({ at: now, text: `${stage.name}：${String(input.note).trim()}` })
  let currentStage = pipeline.currentStage
  let nextStatus = pipeline.status
  let usage = null
  let budget = pipeline.budget
  let warning = false
  let completedAll = false
  if (status === 'running') {
    currentStage = stageId
  } else if (status === 'done') {
    const next = stages.find((row) => row.status === 'pending')
    currentStage = next?.id ?? null
    if (!next && pipeline.status === 'running') {
      completedAll = true
      notes.push({ at: now, text: '全部阶段完成，开始收尾清理' })
    }
    usage = await summarizeUsage(root, projectId, ctx)
    const baseline = pipeline.budget.baseline ?? { tokens: 0, costCNY: 0 }
    budget = {
      ...pipeline.budget,
      usedTokens: Math.max(0, usage.tokens - (Number(baseline.tokens) || 0)),
      usedCostCNY: Math.max(0, usage.costCNY - (Number(baseline.costCNY) || 0)),
    }
    const ratio = pipelineBudgetRatio(budget)
    if (ratio >= 1 && nextStatus === 'running') {
      nextStatus = 'paused'
      notes.push({ at: now, text: `预算超限（${Math.round(ratio * 100)}%），已自动暂停；调整预算后可恢复` })
    } else if (ratio >= PIPELINE_BUDGET_WARN_RATIO) {
      warning = true
      notes.push({ at: now, text: `预算预警：已用 ${Math.round(ratio * 100)}%` })
    }
  }
  const saved = await savePipeline(root, projectId, { stages, currentStage, status: completedAll ? 'running' : nextStatus, budget, notes })
  if (completedAll) {
    // 最后一次阶段完成 → 自动收尾：采纳账本提案、驳回过期章节、归档审阅
    const cleaned = await finalizePipelineCleanup(root, projectId, { scope: 'all' })
    const { pipeline: cleanedPipeline, ...cleanupReport } = cleaned
    return { pipeline: cleanedPipeline, usage, warning, cleanup: cleanupReport }
  }
  return { pipeline: saved, usage, warning }
}

/** 暂停（只改状态，保留现场）。 */
export async function pausePipeline(root, projectId, note = '用户暂停') {
  const pipeline = await getPipeline(root, projectId)
  if (pipeline.status === 'idle') throw new Error('流水线还没有启动')
  return savePipeline(root, projectId, {
    status: 'paused',
    notes: pipelinePushNote(pipeline, String(note ?? '暂停')),
  })
}

/** 恢复：向同一 sessionId 发一条明确的续跑 prompt（用户手动触发）。 */
export async function resumePipeline(root, projectId, ctx = null) {
  const pipeline = await getPipeline(root, projectId)
  if (pipeline.status !== 'paused' && pipeline.status !== 'stuck') throw new Error('只有 paused/stuck 的流水线可以恢复')
  if (!pipeline.sessionId) throw new Error('流水线没有会话，无法恢复')
  const prompt = buildPipelineResumePrompt(pipeline)
  await sendPipelinePrompt(ctx, pipeline.sessionId, prompt)
  const status = pipeline.runId ? 'running' : 'preparing'
  const saved = await savePipeline(root, projectId, {
    status,
    notes: pipelinePushNote(pipeline, `用户手动恢复，已发送续跑 prompt（${status}）`),
  })
  return { pipeline: saved, sessionId: pipeline.sessionId, prompt }
}

/** 全部完成（MCP finish / advance 完成）：先自动收尾清理，再置 done。 */
export async function finishPipeline(root, projectId, note = '') {
  const before = await getPipeline(root, projectId)
  const cleaned = await finalizePipelineCleanup(root, projectId, { scope: 'all' })
  const pipeline = await getPipeline(root, projectId)
  const stages = (pipeline.stages ?? []).map((stage) => (stage.status === 'pending' ? { ...stage, status: 'skipped' } : stage))
  return savePipeline(root, projectId, {
    status: 'done',
    stages,
    currentStage: null,
    cleanup: pipeline.cleanup ?? cleaned.cleanup ?? null,
    notes: pipelinePushNote(pipeline, note ? `完成：${note}` : '全部阶段完成，流水线结束'),
  })
}

/** 补跑收尾 prompt：给已完成的书补齐账本，然后触发自动清理。 */
export function buildPipelineCleanupPrompt(bundle, pipelineInput = {}) {
  const pipeline = { ...defaultPipeline(), ...pipelineInput }
  const project = bundle.project ?? {}
  const chapters = [...(bundle.chapters ?? [])].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
  const first = chapters[0]?.id ?? 1
  const last = chapters[chapters.length - 1]?.id ?? 1
  const written = chapters.filter((chapter) => String(chapter.content ?? '').trim()).length
  return [
    PIPELINE_PROMPT_PRINCIPLE,
    '',
    `# 收尾补齐 · ${project.name || '未命名作品'}`,
    `projectId=${project.id} ｜ 已有 ${written} 章正文（第 ${Number(first)}–${Number(last)} 章）｜ runId=${pipeline.runId || '（无）'}`,
    '',
    '## 任务：先补齐账本，再触发自动清理（本阶段不改正文）',
    '通读全书，按章补齐缺失账本（缺什么补什么）；已有记录不要重复提交，只补缺的：',
    '- 人物：每章出场人物卡/身份/关系（kind=characters）；',
    '- 事实：身份/年龄/地点/物品归属/伤势/规则等硬事实（kind=facts）；',
    '- 事件与时间线：storyTime、地点、参与人、后果（kind=events）；',
    '- 高光：真正值得保留的段落（kind=highlights）；',
    '- 伏笔：埋设章/回收章（kind=foreshadow）；',
    '- 冲突：参与方与解决章（kind=conflicts）；',
    '- 地点：名称/坐标/连接；缺世界先补 kind=world 再补 kind=locations；',
    '- 大纲：每章节拍（kind=outlines）；',
    '- 注意力实测：每个已写章节必须有实测记录（score/verdict/weakest/dropRisk/detail）（kind=attention）；',
    '',
    '## 硬要求',
    `- 全部用 novel_desk_propose 提交提案，并带 data.pipelineRunId="${pipeline.runId || ''}"；不要用 novel_desk_upsert 直接改账本；`,
    '- 只补缺失内容，不改正文、不重写章节；',
    '- 补完后核对一遍：每个已写章节至少有一条 attention 实测；人物/地点引用有卡；',
    '- 最后调用 novel_desk_pipeline(op="finish", note="收尾补齐完成")，工作台会自动采纳账本提案、驳回过期章节提案、归档未处理审阅并生成 cleanup 报告。',
    '',
    '## 预算与节奏',
    `预算：token 上限 ${Number(pipeline.budget?.maxTokens) || 0}（0=不限）｜费用上限 ¥${Number(pipeline.budget?.maxCostCNY) || 0}（0=不限）；80% 预警、100% 自动暂停。`,
    '按章分批处理，不要停下来问作者；全部补完才 finish。',
  ].join('\n')
}

/** 对已完成/中断的 run 补跑收尾：补齐账本（AI）→ finish 自动清理。 */
export async function backfillPipeline(root, projectId, ctx = null) {
  const bundle = await getBundle(root, projectId)
  const current = await getPipeline(root, projectId)
  if (current.status === 'running' || current.status === 'structuring') throw new Error('流水线正在运行，先暂停或结束后再补跑收尾')
  const chapters = bundle.chapters ?? []
  if (chapters.length === 0) throw new Error('还没有正文，无法补跑收尾')
  const maxChapter = Math.max(0, ...chapters.map((chapter) => Number(chapter.id) || 0))
  const stages = Array.isArray(current.stages) ? [...current.stages] : []
  const hasCleanupStage = stages.some((stage) => stage.id === 'final-cleanup')
  if (!hasCleanupStage) {
    stages.push({ id: 'final-cleanup', kind: 'cleanup', name: '收尾：补齐账本 + 清理残留', status: 'pending', chapterFrom: 1, chapterTo: maxChapter })
  }
  const runId = current.runId || `run-${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
  const pipeline = await savePipeline(root, projectId, {
    status: 'running',
    runId,
    currentStage: 'final-cleanup',
    stages: stages.map((stage) => (stage.id === 'final-cleanup' ? { ...stage, status: 'running' } : stage)),
    cleanup: null,
    notes: pipelinePushNote(current, '补跑收尾：补齐账本 + 清理残留'),
  })
  const prompt = buildPipelineCleanupPrompt(bundle, pipeline)
  const session = await startPipelineSession(ctx, root, bundle, prompt)
  const saved = await savePipeline(root, projectId, { sessionId: session.sessionId })
  return { pipeline: saved, sessionId: session.sessionId, prompt }
}

/** 卡住（MCP stuck 或 driver 判定）。 */
export async function stuckPipeline(root, projectId, reason = '') {
  const pipeline = await getPipeline(root, projectId)
  return savePipeline(root, projectId, {
    status: 'stuck',
    notes: pipelinePushNote(pipeline, reason ? `卡住：${reason}` : '卡住，等待手动恢复'),
  })
}

/** pipeline 摘要文本（MCP status / 页面提示）。 */
export function pipelineSummaryText(pipelineInput = {}) {
  const pipeline = { ...defaultPipeline(), ...pipelineInput }
  const stages = pipeline.stages ?? []
  const done = stages.filter((stage) => stage.status === 'done').length
  const current = stages.find((stage) => stage.id === pipeline.currentStage)
  const usageTokens = Number(pipeline.budget?.usedTokens) || 0
  const ratio = pipelineBudgetRatio(pipeline.budget)
  const lines = [
    `# 生成整本书流水线`,
    `- 状态：${pipeline.status} ｜ 模式：${pipeline.mode || '—'}${pipeline.mode === 'chapters' ? `（${pipeline.count} 章）` : ''} ｜ 目标：第 ${pipeline.targetChapter || '—'} 章`,
    `- 进度：${done}/${stages.length} 阶段完成 ｜ 当前：${current ? `${current.name}（${current.id}）` : '—'}`,
    `- runId：${pipeline.runId || '—'} ｜ sessionId：${pipeline.sessionId || '—'}`,
    `- 预算：已用 ${usageTokens} tokens / ¥${Number(pipeline.budget?.usedCostCNY) || 0}${ratio > 0 ? `（${Math.round(ratio * 100)}%）` : ''}`,
  ]
  const cleanup = pipeline.cleanup && typeof pipeline.cleanup === 'object' ? pipeline.cleanup : null
  if (cleanup) {
    lines.push(`- 收尾报告：采纳 ${Number(cleanup.acceptedProposals) || 0} 条提案 · 驳回过期章节 ${Number(cleanup.rejectedChapter) || 0} 条 · 归档审阅 ${Number(cleanup.closedReviews) || 0} 条${Array.isArray(cleanup.failed) && cleanup.failed.length > 0 ? ` · 失败 ${cleanup.failed.length} 条` : ''}`)
  }
  const pending = stages.filter((stage) => stage.status !== 'done').slice(0, 20)
  if (pending.length > 0) lines.push('- 待执行阶段：', ...pending.map((stage) => `  - ${stage.id}｜${stage.name}｜第 ${stage.chapterFrom}–${stage.chapterTo} 章`))
  const notes = (pipeline.notes ?? []).slice(-5)
  if (notes.length > 0) lines.push('- 最近进度：', ...notes.map((note) => `  - ${note.at ?? ''} ${note.text ?? ''}`))
  return lines.join('\n')
}

// ── 扩写（expansion.json 单例 + 宏观方案 + 大纲闸门 + goal）──

const EXPANSION_TYPES = ['enrich', 'scene', 'structure']
const EXPANSION_STATUSES = ['idle', 'planning', 'plan-ready', 'waiting-outline', 'structuring', 'running', 'paused', 'done', 'stuck']

function expansionNow() {
  return new Date().toISOString()
}

function expansionPushNote(expansion, text) {
  return [...(expansion?.notes ?? []), { at: expansionNow(), text: String(text) }]
}

/** 逐章目标白名单：只保留契约字段，避免 UI/模型塞入任意字段。 */
function sanitizeChapterTargets(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter((row) => Number(row?.chapter) > 0)
    .map((row) => ({
      chapter: Number(row.chapter),
      targetWords: Math.max(0, Number(row.targetWords) || 0),
      type: EXPANSION_TYPES.includes(row.type) ? row.type : 'scene',
      additions: Array.isArray(row.additions) ? row.additions.map(String) : [],
      outlineChangeIds: Array.isArray(row.outlineChangeIds) ? row.outlineChangeIds.map(String) : [],
    }))
    .sort((a, b) => a.chapter - b.chapter)
}

/**
 * 实际逐章目标：优先使用已保存的 chapterTargets；缺失时按 scope/已写章节 + 全局目标字数兜底。
 * 全局目标允许被单章 targetWords 覆盖（不提供比例/容差）。
 */
function effectiveChapterTargets(bundle, expansion) {
  const saved = sanitizeChapterTargets(expansion.chapterTargets)
  if (saved.length > 0) return saved
  const chapters = [...(bundle.chapters ?? [])].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
  const globalTarget = Math.max(0, Number(expansion.targetWords) || 0)
  let scopeChapters = []
  if (expansion.mode === 'chapter') {
    scopeChapters = (expansion.scope?.chapters ?? []).map(Number).filter((n) => n > 0)
    if (scopeChapters.length === 0) scopeChapters = chapters.slice(-1).map((chapter) => Number(chapter.id))
  } else {
    scopeChapters = chapters.map((chapter) => Number(chapter.id))
  }
  return scopeChapters.map((chapter) => ({ chapter, targetWords: globalTarget, type: 'scene', additions: [], outlineChangeIds: [] }))
}

/** 扩写估算：按每章（目标字数 - 当前字数）估新增 token（×1.6）+ 审/修开销；估算不准，仅作数量级提示。 */
export function estimateExpansion(bundle, expansionInput = {}) {
  const expansion = { ...defaultExpansion(), ...expansionInput }
  const targets = effectiveChapterTargets(bundle, expansion)
  const chapterMap = new Map((bundle.chapters ?? []).map((chapter) => [Number(chapter.id), chapter]))
  let deltaWords = 0
  for (const row of targets) {
    const current = Number(chapterMap.get(row.chapter)?.words) || 0
    deltaWords += Math.max(0, (Number(row.targetWords) || 0) - current)
  }
  const writeTokens = Math.round(deltaWords * 1.6)
  const reviewTokens = Math.round(deltaWords * 0.5)
  const fixTokens = Math.round(deltaWords * 0.8)
  const totalTokens = writeTokens + reviewTokens + fixTokens
  return {
    mode: expansion.mode === 'chapter' ? 'chapter' : 'book',
    chapters: targets.length,
    deltaWords,
    writeTokens,
    reviewTokens,
    fixTokens,
    totalTokens,
    costCNY: Math.round((totalTokens / 1_000_000) * 2 * 100) / 100,
    note: '估算不准，仅作数量级提示；实际含上下文/系统开销会更高。',
  }
}

function expansionScopeText(expansion) {
  const chapters = (expansion.scope?.chapters ?? []).map(Number).filter((n) => n > 0)
  if (expansion.mode === 'chapter') return `单章扩写（第 ${chapters[0] ?? '?'} 章，只改这一章）`
  return `全部扩写${chapters.length > 0 ? `（范围第 ${chapters.join('、')} 章）` : '（全书已写章节）'}`
}

/** 第一步宏观方案 prompt：只出方案，禁止写正文。 */
const EXPANSION_ADDITION_LABELS = { subplot: '旁线', subplots: '旁线', person: '新人物', characters: '新人物', place: '新地点', locations: '新地点', foreshadow: '新伏笔', conflict: '新冲突', conflicts: '新冲突' }

function expansionOptionsText(expansion = {}) {
  const options = expansion.options ?? {}
  const enabled = Object.entries(options.additions ?? {}).filter(([, value]) => value === true).map(([key]) => EXPANSION_ADDITION_LABELS[key] ?? key)
  const limit = Number(options.additionLimit) > 0 ? `（每类最多 ${Number(options.additionLimit)} 项）` : ''
  const sample = Number(options.sampleChapters) > 0 ? `先扩 ${Number(options.sampleChapters)} 章样张` : '不抽样'
  return `允许新增：${enabled.length > 0 ? enabled.join('、') + limit : '不允许新增（只在大纲内写厚）'}；${sample}；允许大纲变更：${options.allowOutlineChanges ? '是（执行时仍需逐项确认）' : '否'}`
}

export function buildExpansionPlanPrompt(bundle, expansionInput = {}) {
  const expansion = { ...defaultExpansion(), ...expansionInput }
  const project = bundle.project ?? {}
  const chapters = [...(bundle.chapters ?? [])].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
  const outlineMap = new Map((bundle.outlines ?? []).map((outline) => [Number(outline.chapter), outline]))
  const targets = effectiveChapterTargets(bundle, expansion)
  const targetWords = Number(expansion.targetWords) || 0
  const lines = [
    PIPELINE_PROMPT_PRINCIPLE,
    '',
    `# 扩写方案 · ${project.name || '未命名作品'}`,
    `projectId=${project.id} ｜ 模式：${expansion.mode === 'chapter' ? '扩写本章' : '全部扩写'} ｜ 目标字数（用户必填，不得改动）：${expansion.mode === 'chapter' ? `第 ${(expansion.scope?.chapters ?? [])[0] ?? '?'} 章 ${targetWords} 字` : `每章 ${targetWords} 字`} ｜ 范围：${expansionScopeText(expansion)}`,
    `预算：token 上限 ${Number(expansion.budget?.maxTokens) || 0}（0=不限）｜费用上限 ¥${Number(expansion.budget?.maxCostCNY) || 0}（0=不限）`,
    expansionOptionsText(expansion),
    '',
    '## 第一步：先读现状（本阶段禁止写正文）',
    '当前各章字数与现有大纲节拍：',
    ...(targets.length > 0 ? targets.map((row) => {
      const chapter = chapters.find((item) => Number(item.id) === row.chapter)
      const outline = outlineMap.get(row.chapter)
      const beats = Array.isArray(outline?.beats) && outline.beats.length > 0 ? outline.beats.join(' / ') : '（无大纲节拍）'
      return `- 第${row.chapter}章《${chapter?.title ?? ''}》 现 ${Number(chapter?.words) || 0} 字 → 目标 ${row.targetWords || targetWords} 字；大纲节拍：${beats}`
    }) : ['- （没有可扩写章节）']),
    '',
    '## 必须输出（用 novel_desk_expansion(op="plan", data=...) 写回，不要直接改正文）',
    '1. 诊断 diagnosis：每章当前字数、大纲节拍数、与目标字数的差距；',
    '2. 大纲容量评估 capacity：按现有节拍判断每章最多能自然写到多少字，逐章标「可达 / 超出容量」；',
    '3. 逐章方案 chapterTargets：每章 targetWords、type（enrich|scene|structure）、additions（加什么）、outlineChangeIds、是否触碰主线；全局目标允许单章覆盖；',
    '4. 大纲变更清单 outlineChanges（仅确实需要时）：加/改哪些节拍、影响哪些章；每条必须有 id、chapter、title、change、reason、affects；默认不新增，必须等用户确认；',
    '5. 需要作者拍板的事项 confirmations：数组，每项 {id, question, options?, impact?}；把“字数口径/覆盖值/容量封顶/是否接受某条大纲变更/样张选择”等需要作者决定的事项全部列在这里，不要只写在 notes 里（工作台会把它渲染成待确认清单）；',
    '6. 预算估计 estimate：预计 token/费用与样张建议。',
    '',
    '## 硬规则',
    '- 本阶段禁止写正文、禁止提交 chapter 提案；',
    '- 目标字数由用户填写，不得改小或改大；大纲容量不足时如实报告“最多到 X 字”并给出大纲变更方案，不许硬凑；',
    '- 方案提交后等作者确认（confirmPlan）；方案确认 ≠ 大纲变更确认，大纲变更会单独走 waiting-outline 闸门；',
    '- 不引入未批准的新人物/新地点/新伏笔/新冲突。',
  ]
  return lines.join('\n')
}

/** 第二步执行 goal prompt：按已确认方案自动扩写（大纲硬边界 + 自动采纳 + 大纲闸门）。 */
export function buildExpansionGoalPrompt(bundle, expansionInput = {}) {
  const expansion = { ...defaultExpansion(), ...expansionInput }
  const project = bundle.project ?? {}
  const chapters = bundle.chapters ?? []
  const chapterMap = new Map(chapters.map((chapter) => [Number(chapter.id), chapter]))
  const targets = effectiveChapterTargets(bundle, expansion)
  const targetWords = Number(expansion.targetWords) || 0
  const approved = Array.isArray(expansion.approvedOutlineChanges) ? expansion.approvedOutlineChanges : []
  const pendingOutline = Array.isArray(expansion.outlineChanges) && expansion.outlineChanges.length > 0 && approved.length === 0
  const firstChapter = targets.length > 0 ? targets[0].chapter : 1
  const lastChapter = targets.length > 0 ? targets[targets.length - 1].chapter : 1
  const lines = [
    PIPELINE_PROMPT_PRINCIPLE,
    '',
    `# 扩写执行 · ${project.name || '未命名作品'}`,
    `projectId=${project.id} ｜ runId=${expansion.runId || '（无）'} ｜ 模式：${expansion.mode === 'chapter' ? '扩写本章' : '全部扩写'} ｜ 目标字数：${expansion.mode === 'chapter' ? `第 ${firstChapter} 章 ${targetWords} 字` : `每章 ${targetWords} 字`}（用户填写，无默认、无容差）`,
    `范围：${expansionScopeText(expansion)}；本次共 ${targets.length} 章。`,
    '',
    '## 第一步：先 create_goal',
    `先调用 create_goal：objective=「按已确认方案把第 ${firstChapter}–${lastChapter} 章扩写到目标字数，现有大纲节拍不动」；max_goal_rounds 至少 ${Math.max(30, targets.length * 4)}。你是本书总编/导演：用 subagent/Team 按批（卷或 N 章）分派，不要问作者、不要中途停（大纲闸门除外）。`,
    '',
    '## 已确认的方案摘要（锁定）',
    ...(targets.length > 0 ? targets.map((row) => {
      const current = Number(chapterMap.get(row.chapter)?.words) || 0
      const target = Number(row.targetWords) > 0 ? Number(row.targetWords) : targetWords
      const additions = Array.isArray(row.additions) && row.additions.length > 0 ? `；新增：${row.additions.join('、')}` : ''
      return `- 第${row.chapter}章 现 ${current} 字 → 目标 ${target} 字（增量 ${Math.max(0, target - current)}，类型 ${row.type}${additions}）`
    }) : ['- （没有可扩写章节）']),
    `已批准的大纲变更：${approved.length > 0 ? approved.map((row) => row.title ?? row.proposalId ?? '变更').join('、') : '（无）'}`,
    (() => {
      const pendingChanges = Array.isArray(expansion.outlineChanges) ? expansion.outlineChanges : []
      const approvedIds = new Set(approved.map((row) => String(row.id ?? row.title ?? '')))
      const unapproved = pendingChanges.filter((row) => !approvedIds.has(String(row.id ?? row.title ?? '')))
      return unapproved.length > 0 ? `未批准的大纲变更（不得使用）：${unapproved.map((row) => row.title ?? row.id ?? '变更').join('、')}；若必须使用，先走大纲闸门等作者确认。` : '未批准的大纲变更：（无）'
    })(),
    expansionOptionsText(expansion),
    '方案之外不得新增情节、人物、地点、设定；主线不动。',
    '',
    '## 硬规则（每条必须遵守）',
    '- 现有大纲节拍锁定：一条不改写；主线节拍不动；章末钩子保留；原文关键场景不丢；风格/POV 不漂移；',
    '- 不得引入大纲 / 已批准大纲变更之外的情节、人物、地点、设定；默认只在大纲内写厚；',
    '- 必须达到目标字数（无容差）；达不到就报告“最多到 X 字”的上限，禁止注水、复述、纯描写凑字数；',
    '- 新增内容必须有后果（新事件 / 冲突 / 关系 / 信息），完成后回写事件、事实、冲突、伏笔、时间线；',
    '- 扩写后冷读分不得低于扩写前；每章扩写前后都记录注意力实测；',
    ...(expansion.mode === 'chapter' ? ['- 单章模式：只改第 ' + firstChapter + ' 章，其他章一行不动。'] : []),
    '',
    '## 执行方式（全自动，每批审一次修一次）',
    '1. 每批（卷或 N 章）按逐章目标与现有大纲节拍扩写；',
    '2. 该批写完立即审一次（连续性/人物/时间线/文笔 + 每章冷读），再修一次；',
    `3. 扩写章节提案必须带 data.expansionRunId="${expansion.runId || ''}" 与 data.expansion={targetWords, delta, addedScenes, subplotIds, beatsPreserved, scoreBefore, scoreAfter}；工作台会自动采纳并保留原稿历史备份（旧稿可回滚），不要用 novel_desk_upsert 直接改正文；`,
    '4. 继续下一批，不要等作者；每批完成用 novel_desk_expansion(op="stage", status=..., note=...) 上报进度。' + (Number(expansion.options?.sampleChapters) > 0 ? `\n5. 样张：先扩前 ${Number(expansion.options.sampleChapters)} 章，在 notes 里汇报样张结果（字数/新增内容/冷读），然后继续全量；作者可随时暂停查看。` : ''),
    '',
    '## 大纲闸门（硬，不许自行改大纲）',
    '若执行中发现必须超出已批准大纲（新节拍/旁线/人物/地点）：立即停止扩写，提交 kind="outlines" 提案（带 data.expansionRunId），并调用 novel_desk_expansion(op="wait-outline", reason=...) 停下等待用户确认；未确认前不得继续写正文，也绝不允许自行改大纲。' + (pendingOutline ? '\n（本次方案里已有待确认的大纲变更：先等用户确认，再继续写正文。）' : ''),
    '',
    '## 预算与完成',
    `预算：token 上限 ${Number(expansion.budget?.maxTokens) || 0}（0=不限）｜费用上限 ¥${Number(expansion.budget?.maxCostCNY) || 0}（0=不限）；80% 预警、100% 自动暂停。`,
    '全部完成后调用 novel_desk_expansion(op="finish", note=...)，并汇报：总字数、逐章达成（当前/目标）、冷读分变化、新增内容清单、大纲变更记录。',
  ]
  return lines.join('\n')
}

/**
 * 去 AI 化审稿工作单：把确定性指标当证据，让审稿人只负责「怎么改」，
 * 不负责「像不像机器」——那部分已经算出来了。
 */
export function buildFullBookReviewPrompt(bundle = {}, input = {}) {
  const project = bundle.project ?? {}
  const focus = Array.isArray(input.focus) ? input.focus.map((item) => String(item).trim()).filter(Boolean) : []
  const chapters = bundle.chapters ?? []
  const sandbox = input.sandbox ?? reviewSandboxFor(bundle, String(input.rootPath ?? ''), null)
  const files = sandbox ? sandbox.chapterFiles : chapters.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))).map((chapter) => {
    const id = String(chapter.id ?? '').padStart(4, '0')
    return {
      id,
      title: String(chapter.title ?? ''),
      words: String(chapter.content ?? '').length,
      path: bundle.root && project.id ? join(bundle.root, 'projects', String(project.id), 'chapters', `${id}.md`) : '',
    }
  })
  const lines = [
    '你是本书的「全文重新审阅」负责人。这次不是抽读，是通读全书重新审一遍；独立会话、零上下文，只审这一本书。',
    '',
    ...REVIEW_ISOLATION_LINES,
    '',
    `# 作品：${project.name || '未命名'}（${chapters.length} 章）`,
    '## 本次重点（作者指定，优先级最高；未指定的维度按默认口径）',
    ...(focus.length > 0 ? focus.map((item, index) => `${index + 1}. ${item}`) : ['（作者未指定重点，按默认口径：情节因果、人物动机、连续性、节奏、文笔、章末钩子）']),
    '',
    '## 章节文件清单（唯一允许读取的文件）',
    '用 read 工具读文件，长章用 offset/limit 分段读。每一条审稿都必须能指回下面某一章。',
    ...files.map((item) => `- 第${Number(item.id) || item.id}章《${item.title}》｜${item.words} 字${item.path ? `｜${item.path}` : ''}`),
    '',
    '## 审阅口径',
    '- 每条意见必须带章号、维度、严重度（blocker/major/minor）、引用原文、可执行改法；',
    '- 重点里的每一条都要单独回应：满足 / 部分满足 / 不满足，并给出证据；',
    '- 不许只写感受，不许空泛总结；',
    '- 指出哪些地方不要改（风格资产）。',
    '',
    '## 提交方式',
    `用 novel_desk_review 逐章提交（origin="review"）；最后用一段总结回答：全书在本次重点上处于什么水平。`,
    '提交前自查：每条审稿的章号都在清单里、引文逐字来自该章，没有出现任何其他作品的书名或人物名。',
  ]
  return lines.join('\n')
}

export function buildAiStyleReviewPrompt(bundle = {}, audit = null, options = {}) {
  const project = bundle.project ?? {}
  const result = audit ?? auditAiStyle(bundle.chapters ?? [])
  const { overall, flags, chapterFlags } = result
  const projectId = String(project.id ?? '')
  const root = String(bundle.root ?? '')
  const files = Array.isArray(options.chapterFiles) && options.chapterFiles.length > 0
    ? options.chapterFiles
    : (root ? prepareReviewSandbox(root, bundle, null).chapterFiles : (bundle.chapters ?? []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id))).map((chapter) => {
      const id = String(chapter.id ?? '').padStart(4, '0')
      return {
        id,
        title: String(chapter.title ?? ''),
        words: String(chapter.content ?? '').length,
        path: root && projectId ? join(root, 'projects', projectId, 'chapters', `${id}.md`) : '',
      }
    }))
  const head = [
    '# 去 AI 化审阅（独立会话 · 零上下文 · 只审本书）',
    '',
    ...REVIEW_ISOLATION_LINES,
    '5. 这是独立新建的审稿会话，不继承任何旧对话；你没有「前情」，也不需要，不要去找旧上下文。',
    '6. **只审这一本书**：所有判断只能来自下面「章节文件清单」里的文件。',
    '7. 不要为了「像人」而编造口语、病句、错别字或降低质量；去 AI 化是让叙述更具体、更有信息量，不是伪装。',
    '8. 本轮只提交审稿意见（novel_desk_review），不要改正文、不要提交章节提案。',
    '',
    `# 作品：${project.name || '未命名'}（${overall.chapters} 章 / ${overall.chars} 字符）`,
    `项目 id：${projectId || '（未知）'}`,
    '',
    '## 章节文件清单（唯一允许读取的文件）',
    '用 read 工具读文件，长章用 offset/limit 分段读。每一条审稿都必须能指回下面某一章。',
    ...files.map((item) => `- 第${Number(item.id) || item.id}章《${item.title}》｜${item.words} 字${item.path ? `｜${item.path}` : ''}`),
    '',
    '## 第一优先级：Markdown 残留（有一条就是错，必须先清）',
    `- 全书残留：${overall.mdArtifacts ?? 0} 处，分布在 ${(result.mdChapters ?? []).length} 章`,
    ...(result.mdChapters ?? []).slice(0, 20).map((row) => {
      const kinds = Object.entries(row.byKind ?? {}).map(([key, count]) => `${key} ${count}`).join('、')
      const sample = (row.samples ?? []).slice(0, 2).map((item) => item.text).join(' / ')
      return `  · 第${row.chapter}章《${row.title ?? ''}》：${row.total} 处（${kinds}）样例：${sample}`
    }),
    '  处理规则：## 标题改成纯文本或章回小标题；**粗体** 去掉星号；--- 分隔线删除；> 引用去掉符号；列表符删除；代码反引号删除。',
    '',
    '## 已测出的机器痕迹（这是证据，不是你判断的内容）',
    `- 微动作帧密度：${overall.microFramesPer10k}/万字（阈值 ${result.thresholds.microFramesPer10k}）`,
    `- 装饰性步长量化：${overall.stepQuantPer10k}/万字（阈值 ${result.thresholds.stepQuantPer10k}）`,
    `- 情绪词密度：${overall.emotionPer10k}/万字（最低 ${result.thresholds.emotionPer10kMin}）`,
    `- 长句占比：${(overall.longSentenceRatio * 100).toFixed(1)}%（最低 ${(result.thresholds.longSentenceRatioMin * 100).toFixed(0)}%）`,
    `- 章间句长变异系数：${overall.sentenceMeanCv}（最低 ${result.thresholds.sentenceMeanCvMin}）`,
    `- 对话文言度：${overall.dialogueClassicalPer10k}/万字（最低 ${result.thresholds.dialogueClassicalPer10kMin}）`,
    `- 对话白话标记：${overall.dialogueVernacularPer10k}/万字（最高 ${result.thresholds.dialogueVernacularPer10kMax}）`,
    `- 高频微动作集中度：前 ${overall.topFrames.length} 个帧（${overall.topFrames.join('、')}）占全部帧的 ${(overall.topFrameShare * 100).toFixed(0)}%（最高 ${(result.thresholds.topFrameShareMax * 100).toFixed(0)}%）`,
    '',
    '## 判定口径（必须照此分级）',
    '- blocker：Markdown 残留（必须清零）；情绪词/长句缺口这类结构性问题，单章改不动，需要整段重写；',
    '- major：微动作帧、步长量化、对话文言度这类可局部替换的问题；',
    '- minor：单点重复用词。',
    '',
    '## 输出（用 novel_desk_review 提交，origin="deai"，每条带章号与原文引用）',
    '1. 先清 Markdown：逐章列出残留位置并给出清理后的写法；',
    '2. 再给结论：本书机器痕迹最重的三项（md 之外），各举 2 条原文；',
    '3. 再按章给改法：删/换/补，写清楚改成什么；',
    '4. 指出哪些地方**不能改**（例如器物白描是风格资产，不是机器痕迹）。',
    '要求：每条审稿都带 chapter（章号）、quote（逐字摘自该章正文，≥4 字、≤600 字）、issue、suggestion；跨章共性问题用 chapter=0。',
    '禁止在 issue/suggestion/quote 里提任何其他作品名；违反会被插件直接拒收。',
  ]
  if (flags.length > 0) {
    head.push('', '## 需要重点开刀的指标')
    for (const flag of flags) head.push(`- ${flag.label}：实测 ${flag.value} vs 阈值 ${flag.threshold}`)
  }
  if (chapterFlags.length > 0) {
    head.push('', '## 逐章偏差（按章开工）')
    for (const row of chapterFlags.slice(0, 60)) {
      head.push(`- 第${row.chapter}章《${row.title ?? ''}》：${row.hits.map((hit) => `${hit.key}=${hit.value}`).join('；')}`)
    }
  }
  head.push(
    '',
    '## 提交前自查（逐条确认后再提交）',
    '- [ ] 我读的每个文件都在「章节文件清单」里，没有读清单外文件；',
    '- [ ] 输出里没有其他作品名，没有「人类对照 / 人写基线」这类跨作品比较；',
    '- [ ] 每条审稿都带 chapter、quote（逐字来自该章正文）、issue、suggestion；',
    '- [ ] 我只提交了 novel_desk_review（origin="deai"），没有改正文、没有提章节提案；',
    `- [ ] 需要作者人工复检 AI 痕迹时，提示用朱雀 AI 检测：${DEAI_AUDIT_URL}`,
  )
  return head.join('\n')
}

/** 从 RPC body 里取出改动契约（preview/plan 共用）。 */
function revisionContractFromBody(body = {}) {
  const charter = body.charter && typeof body.charter === 'object' ? body.charter : {}
  const tiers = (Array.isArray(body.tiers) ? body.tiers : String(body.tiers ?? body.tier ?? '').split(/[+、,，\s]+/))
    .map((item) => String(item ?? '').trim().toUpperCase())
    .filter(Boolean)
  // 批次大小与停顿方式由作者选：'auto' = 不指定，交给分层默认（L3 逐章、L1/L2 每 5 章）。
  const batchSizeRaw = String(body.batchSize ?? '').trim().toLowerCase()
  const batchCount = Number(batchSizeRaw)
  const batchSize = batchSizeRaw === 'all'
    ? 'all'
    : (Number.isFinite(batchCount) && batchCount > 0 ? Math.floor(batchCount) : 'auto')
  const stopMode = findStopMode(body.stopMode)?.id ?? 'auto'
  return {
    tiers: [...new Set(tiers)],
    tier: String(body.tier ?? tiers[0] ?? '').trim().toUpperCase(),
    batchSize,
    stopMode,
    goalMode: ['preset', 'custom', 'both'].includes(String(body.goalMode ?? '')) ? String(body.goalMode) : 'custom',
    presetId: String(body.presetId ?? '').trim(),
    chapters: (Array.isArray(body.chapters) ? body.chapters : String(body.chapters ?? '').split(/[、,，\s]+/))
      .map((id) => String(id ?? '').trim())
      .filter(Boolean),
    goal: String(body.goal ?? '').trim(),
    charter: {
      oldValue: String(charter.oldValue ?? '').trim(),
      newValue: String(charter.newValue ?? '').trim(),
      affectedCharacters: (Array.isArray(charter.affectedCharacters) ? charter.affectedCharacters : String(charter.affectedCharacters ?? '').split(/[、,，\s]+/))
        .map((name) => String(name ?? '').trim())
        .filter(Boolean),
      keywords: (Array.isArray(charter.keywords) ? charter.keywords : String(charter.keywords ?? '').split(/[、,，\s]+/))
        .map((word) => String(word ?? '').trim())
        .filter(Boolean),
    },
  }
}

/**
 * 全文改动工作单：分层决定它必须怎么说。
 * L1 只准换语域；L3 必须先立价值基准再级联，且逐章停。
 */
export function buildRevisionGoalPrompt(bundle = {}, revision = {}, plan = null) {
  const project = bundle.project ?? {}
  const contract = revision.contract ?? {}
  const composedTier = composeTiers(
    Array.isArray(contract.tiers) && contract.tiers.length > 0 ? contract.tiers : (revision.tier || plan?.tier?.id || ''),
  )
  const tier = composedTier?.id ?? ''
  const policy = revisionGatePolicy(composedTier)
  const tierInfo = describeRevisionTier(composedTier)
  const impact = revision.impact ?? {}
  const batches = Array.isArray(revision.batches) ? revision.batches : []
  const stopModeInfo = findStopMode(contract.stopMode)
  const stopMode = stopModeInfo?.id ?? ''
  const confirmBatches = batches.filter((batch) => batch.requiresAuthorConfirm)
  const batchSizeInfo = contract.batchSize === 'all'
    ? '一次全改：全书一批'
    : contract.batchSize === 'auto'
      ? '按分层默认（L3 逐章 / L1·L2 每 5 章）'
      : `每批 ${contract.batchSize} 章`
  const stopLine = stopMode === 'run-to-end'
    ? '一路跑到底（不停批，全部改完再汇报）'
    : stopMode === 'fix-only'
      ? '只在出问题时停（同章两次修不过闸门 / 撞冻结项才停）'
      : stopMode === 'per-batch'
        ? `每批停下确认（${batches.length} 批都停）`
        : `按分层默认（${confirmBatches.length} / ${batches.length} 批需要确认）`
  const lines = [
    '你是本书的「全文改动执行者」。这不是扩写：扩写是把内容写厚，你是把已有正文换掉，',
    '情节、事实、伏笔、时间线、章末钩子一律冻结，只动本层允许动的东西。',
    '',
    `# 作品：${project.name || '未命名'} ｜ 改动层级：${tier}`,
    tierInfo,
    '',
    `## 本次目标（唯一验收口径）`,
    contract.goal || '（未填；见下方预设规格）',
    ...(() => {
      const presets = bundle.presets ?? []
      const usePreset = contract.goalMode === 'preset' || contract.goalMode === 'both'
      if (!usePreset) return []
      const preset = presets.find((item) => String(item.id) === String(contract.presetId))
        ?? presets.find((item) => String(item.id) === String(bundle.project?.activePresetId))
        ?? presets[0]
      if (!preset) return ['', '## 文风规格来源：预设（未找到可用预设）']
      const rules = Array.isArray(preset.styleRules) ? preset.styleRules : []
      const cards = Array.isArray(preset.styleCards) ? preset.styleCards : []
      return [
        '',
        `## 文风规格来源：预设《${preset.name ?? preset.id}》`,
        ...(preset.tone ? [`- tone：${preset.tone}`] : []),
        ...(preset.structure ? [`- 结构：${preset.structure}`] : []),
        ...(rules.length > 0 ? ['- 风格规则：', ...rules.map((rule) => `  · ${rule}`)] : []),
        ...(cards.length > 0 ? ['- 指标卡：', ...cards.map((card) => `  · ${card.label ?? card.id}：${card.min ?? ''}–${card.max ?? ''}`)] : []),
        '以上预设条款与本次目标同等优先；冲突时以「本次目标」为准。',
      ]
    })(),
    '',
    `## 范围：${(contract.chapters ?? []).length} 章，共 ${batches.length} 批（${batchSizeInfo}）`,
    `## 停顿方式：${stopLine}`,
    ...batches.map((batch) => `- 批次 ${batch.index}｜${batch.label}｜${batch.kind}${batch.requiresAuthorConfirm ? '｜需作者确认' : ''}`),
  ]

  if (composedTier?.members?.includes('L3')) {
    const charter = contract.charter ?? {}
    lines.push(
      '',
      '## 价值变更书（L3 必读，逐条照做）',
      `- 旧立场：${charter.oldValue || '（未填）'}`,
      `- 新立场：${charter.newValue || '（未填）'}`,
      `- 受影响人物：${(charter.affectedCharacters ?? []).join('、') || '（未填）'}`,
      '',
      '### 执行顺序（不得颠倒）',
      '1. 先做批次 0（settings）：改人物卡的 goal / motivation / arc / relationships，让设定层先站到新立场上；',
      stopMode === 'run-to-end' || stopMode === 'fix-only'
        ? '2. 再按批次清单连续级联正文：不停批，一路做完；每章仍要过保真 + Markdown 闸门；'
        : stopMode === 'per-batch'
          ? '2. 再逐批级联正文：每批改完停下等作者确认，不得跳批、不得连做；'
          : '2. 再按批次清单的「需作者确认」标记推进：标了的停下等确认，没标的直接接下一批；',
      '3. 每章只改「该角色在这一章的价值取向与相应行为描写」，事件外部结果不得抹除（可重解读，不可删除）。',
    )
  }

  if (composedTier?.members?.includes('L1')) {
    lines.push(
      '',
      '## L1 硬规则',
      '- 只准改句式、用词、语域、比喻、描写顺序、情绪抒写方式；',
      '- 事件、人物动作与结果、对白信息量、专名、数字、章末钩子一个字不动；',
      '- 每章改完必须能通过保真闸门（专名不丢、数字保留率 ≥80%、对白条数 ±20%、章末钩子有承接）。',
    )
  }

  lines.push(
    '',
    `## 影响面（${impact.chapters?.length ?? 0} 章命中，${impact.uncovered ?? 0} 章未命中）`,
    ...(impact.chapters ?? []).slice(0, 60).map((row) => `- 第${row.chapter}章《${row.title ?? ''}》：${(row.matched ?? []).join('、')}`),
    '',
    '## 提交方式（硬性）',
    '- 改完一章，调用 novel_desk_revision(op="apply", chapter=..., content=...) 写回；不要用 novel_desk_upsert 直接改正文；',
    '- 每批结束调用 novel_desk_revision(op="stage", data={batchIndex, status, note}) 上报；',
    ...(stopMode === 'run-to-end'
      ? ['- 不要中途停下等作者确认：一路跑完（含修不通过的章）再 op="finish" 汇报；预算到顶会自动暂停。']
      : stopMode === 'fix-only'
        ? ['- 不要每批停下：连续往下跑。只有同一章两次修不过闸门、或与冻结项冲突无法自决时，才 op="pause" 停下说明原因。']
        : ['- 清单里标「需作者确认」的批次，结束后调用 op="pause" 停下，不要自行继续；没标的批次直接接下一批；']),
    '- 全部完成调用 op="finish"。',
    '',
    '## 预算',
    `token 上限 ${Number(revision.budget?.maxTokens) || 0}（0=不限）｜费用上限 ¥${Number(revision.budget?.maxCostCNY) || 0}（0=不限）；80% 预警、100% 自动暂停。`,
  )
  return lines.join('\n')
}

/** 改动状态摘要（MCP status / 页面提示）。 */
export function revisionSummaryText(revision = {}) {
  const contract = revision.contract ?? {}
  const batches = Array.isArray(revision.batches) ? revision.batches : []
  const done = batches.filter((batch) => batch.status === 'done').length
  return [
    '# 全文改动',
    `状态：${revision.status ?? 'idle'} ｜ 层级：${revision.tier || '未选'} ｜ 进度：${done}/${batches.length} 批`,
    `目标：${contract.goal || '（未填）'}`,
    `范围：${(contract.chapters ?? []).length} 章 ｜ 影响面：${revision.impact?.chapters?.length ?? 0} 章命中`,
    ...batches.map((batch) => `- 批次 ${batch.index}｜${batch.label}｜${batch.status}｜保真 ${batch.fidelity?.hit ?? 0}/${batch.fidelity?.total ?? 0}`),
    ...(revision.notes ?? []).slice(-3).map((note) => `· ${note.text ?? note}`),
  ].join('\n')
}


// ── 全文改动：RPC / MCP 共用的执行函数 ────────────────────────

function revisionBatchForChapter(revision, chapterId) {
  const list = Array.isArray(revision.batches) ? revision.batches : []
  return list.findIndex((batch) => (batch.chapters ?? []).map(String).includes(String(chapterId)))
}

/**
 * 提交单章改写：写正文（自动留历史备份）+ 跑双闸门。
 * 闸门不通过也写入（作者可回滚），但批次标记 needs-fix。
 */
export async function applyRevisionChapter(root, projectId, input = {}) {
  const chapterId = String(input.chapter ?? '').trim()
  const content = String(input.content ?? '')
  if (!chapterId) throw new Error('缺少 chapter')
  if (!content.trim()) throw new Error('缺少 content（改写后的正文）')
  const bundle = await getBundle(root, projectId)
  const original = (bundle.chapters ?? []).find((chapter) => String(chapter.id) === chapterId)
  if (!original) throw new Error(`章节不存在：${chapterId}`)
  const revision = await getRevision(root, projectId)

  const anchors = extractAnchors(original, { characterNames: (bundle.characters ?? []).map((c) => c.name).filter(Boolean) })
  const fidelity = evaluateFidelity(original, { content }, anchors)
  const styleBefore = auditAiStyle([original]).overall
  const styleAfter = auditAiStyle([{ id: chapterId, title: original.title, content }]).overall
  // Markdown 残留是去 AI 化的第一优先级：改写稿里还有 ## /**/--- 就不算达标。
  const md = scanMarkdownArtifacts(content)

  const saved = await saveChapter(root, projectId, {
    id: original.id,
    title: original.title,
    status: original.status,
    summary: original.summary,
    location: original.location,
    storyTime: original.storyTime,
    characters: original.characters,
    content,
  })

  const index = revisionBatchForChapter(revision, chapterId)
  const batches = (revision.batches ?? []).map((batch, i) => {
    if (i !== index) return batch
    const passed = fidelity.pass && (md.total ?? 0) === 0
    return {
      ...batch,
      status: passed ? 'done' : 'needs-fix',
      fidelity: { hit: fidelity.hit, total: fidelity.total, missing: fidelity.missing },
      style: { before: styleBefore, after: styleAfter },
      md: { total: md.total, byKind: md.byKind },
    }
  })
  const next = await saveRevision(root, projectId, {
    batches,
    notes: [...(revision.notes ?? []), { at: new Date().toISOString(), text: `第${chapterId}章已改：保真 ${fidelity.hit}/${fidelity.total}，Markdown 残留 ${md.total} 处${fidelity.pass && md.total === 0 ? '' : '（未通过，已标记 needs-fix）'}` }],
  })
  return { revision: next, fidelity, style: { before: styleBefore, after: styleAfter }, md, backup: saved.backup ?? null }
}

/** 影响面预览（不落盘）。 */
export function previewRevision(bundle = {}, body = {}) {
  const contract = revisionContractFromBody(body)
  const validation = validateRevisionContract(contract)
  const plan = planRevisionForBundle(bundle, contract, { batchSize: contract.batchSize === 'auto' ? undefined : contract.batchSize })
  return { contract, validation, ...plan }
}

/** 出方案：算批次 + 影响面，落盘 plan-ready。 */
export async function planRevisionRun(root, projectId, body = {}) {
  const bundle = await getBundle(root, projectId)
  assertActivePreset(bundle)
  const contract = revisionContractFromBody(body)
  // 目标可以来自预设：没手写目标时，用预设的 tone / 规则生成一句可判定的目标
  if (!contract.goal && (contract.goalMode === 'preset' || contract.goalMode === 'both')) {
    const presets = bundle.presets ?? []
    const preset = presets.find((item) => String(item.id) === String(contract.presetId))
      ?? presets.find((item) => String(item.id) === String(bundle.project?.activePresetId))
      ?? presets[0]
    if (preset) {
      contract.goal = `按预设《${preset.name ?? preset.id}》重写：${String(preset.tone ?? '').trim() || (preset.styleRules ?? []).slice(0, 2).join('；')}`
    }
  }
  const plan = planRevisionForBundle(bundle, contract, { batchSize: contract.batchSize === 'auto' ? undefined : contract.batchSize })
  if (!plan.ok) throw new Error(`改动契约不成立：${plan.errors.join('；')}`)
  contract.tier = plan.tier.id
  const current = await getRevision(root, projectId)
  if (current.status === 'running') throw new Error('改动正在执行，先暂停/重置再重新出方案')
  const runId = `rev-${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
  const saved = await saveRevision(root, projectId, {
    status: 'plan-ready',
    runId,
    tier: plan.tier.id,
    contract,
    impact: plan.impact,
    gates: plan.gates,
    batches: plan.batches.map((batch) => ({
      ...batch,
      status: 'pending',
      fidelity: { hit: 0, total: 0, missing: [] },
      style: { before: {}, after: {} },
    })),
    budget: { ...current.budget, usedTokens: 0, usedCostCNY: 0 },
    notes: [...(current.notes ?? []), { at: new Date().toISOString(), text: `出方案：${plan.tier.id} 改动 ${contract.chapters.length} 章 / ${plan.batches.length} 批` }],
  })
  // 在这里一并生成 prompt，避免 RPC 再取一次 bundle（52 章时取一次要跑 checks + alignment，很慢）
  return {
    revision: saved,
    plan,
    prompt: buildRevisionGoalPrompt(bundle, saved),
    impact: saved.impact,
    batchCount: (saved.batches ?? []).length,
  }
}

/**
 * 开始前的执行设置：批次大小与停顿方式由作者在「开始」这一步决定。
 * 只改这两项时不动契约其它字段；未传 / 'auto' 表示沿用方案里的值（'auto' 表示回到分层默认）。
 */
function startBatchSizeOverride(value) {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim().toLowerCase()
  if (text === 'all') return 'all'
  if (text === 'auto') return 'auto'
  const num = Number(text)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null
}

function startStopModeOverride(value) {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim()
  if (text === 'auto') return 'auto'
  return findStopMode(text)?.id ?? null
}

/**
 * 开始时按作者此刻的选择重新切批，并按章保留已有进度。
 * 不改正文、不跑闸门，只重排批次（每章仍是独立改写）。
 */
export function rebatchRevision(bundle = {}, revision = {}, input = {}) {
  const current = revision.contract ?? {}
  const batchSize = startBatchSizeOverride(input.batchSize)
  const stopMode = startStopModeOverride(input.stopMode)
  if (batchSize === null && stopMode === null) return { changed: false, revision }
  const contract = { ...current }
  if (batchSize !== null) contract.batchSize = batchSize
  if (stopMode !== null) contract.stopMode = stopMode
  if (String(contract.batchSize ?? 'auto') === String(current.batchSize ?? 'auto')
    && String(contract.stopMode ?? 'auto') === String(current.stopMode ?? 'auto')) {
    return { changed: false, revision }
  }
  const plan = planRevisionForBundle(bundle, contract, { batchSize: contract.batchSize === 'auto' ? undefined : contract.batchSize })
  if (!plan.ok) throw new Error(`改动契约不成立：${plan.errors.join('；')}`)
  // 章节 → 旧批次：重新切批后按章沿用状态（全 done 才算 done，任一 needs-fix 即 needs-fix）
  const chapterState = new Map()
  for (const batch of revision.batches ?? []) {
    for (const id of batch.chapters ?? []) chapterState.set(String(id), batch)
  }
  const emptyFidelity = () => ({ hit: 0, total: 0, missing: [] })
  const batches = plan.batches.map((batch) => {
    if (batch.kind === 'settings') {
      const old = (revision.batches ?? []).find((item) => item.kind === 'settings')
      return {
        ...batch,
        status: old?.status === 'done' ? 'done' : 'pending',
        fidelity: old?.fidelity ?? emptyFidelity(),
        style: old?.style ?? { before: {}, after: {} },
      }
    }
    const olds = (batch.chapters ?? []).map((id) => chapterState.get(String(id))).filter(Boolean)
    const allDone = olds.length === (batch.chapters ?? []).length && olds.every((item) => item.status === 'done')
    const needsFix = olds.some((item) => item.status === 'needs-fix')
    return {
      ...batch,
      status: allDone ? 'done' : (needsFix ? 'needs-fix' : 'pending'),
      fidelity: allDone
        ? { hit: olds.reduce((sum, item) => sum + (Number(item.fidelity?.hit) || 0), 0), total: olds.reduce((sum, item) => sum + (Number(item.fidelity?.total) || 0), 0), missing: [] }
        : emptyFidelity(),
      style: { before: {}, after: {} },
    }
  })
  return { changed: true, contract, tier: plan.tier.id, gates: plan.gates, batches }
}

/** 开始执行：建会话 + 投递工作单（可带开始时的批次 / 停顿设置，先重排再投递）。 */
export async function startRevisionRun(root, projectId, ctx = null, body = {}) {
  const bundle = await getBundle(root, projectId)
  assertActivePreset(bundle)
  const revision = await getRevision(root, projectId)
  if (!['plan-ready', 'paused'].includes(revision.status)) throw new Error('请先出方案（plan-ready）再开始改动')
  if ((revision.batches ?? []).length === 0) throw new Error('方案里没有批次，请重新出方案')
  const rebatched = rebatchRevision(bundle, revision, body)
  let work = revision
  if (rebatched.changed) {
    work = await saveRevision(root, projectId, {
      contract: rebatched.contract,
      tier: rebatched.tier,
      gates: rebatched.gates,
      batches: rebatched.batches,
      notes: [...(revision.notes ?? []), {
        at: new Date().toISOString(),
        text: `开始时改执行设置：批次 ${rebatched.contract.batchSize} / 停顿 ${rebatched.contract.stopMode}，重排 ${rebatched.batches.length} 批（已完成进度按章保留）`,
      }],
    })
  }
  const prompt = buildRevisionGoalPrompt(bundle, work)
  await autoSnapshotBeforeRun(root, projectId, `全文改动开工前 · ${revision.tier || '改动'}`, revision.runId)
  const session = await startPipelineSession(ctx, root, bundle, prompt)
  const saved = await saveRevision(root, projectId, {
    status: 'running',
    sessionId: session.sessionId,
    notes: [...(work.notes ?? []), { at: new Date().toISOString(), text: '开始执行改动' }],
  })
  return { revision: saved, sessionId: session.sessionId, prompt, rebatched: rebatched.changed }
}

/** 推进批次状态。 */
export async function advanceRevision(root, projectId, input = {}) {
  const revision = await getRevision(root, projectId)
  const index = Number(input.batchIndex)
  const status = String(input.status ?? '').trim() || 'done'
  const batches = (revision.batches ?? []).map((batch, i) => (i === index ? { ...batch, status } : batch))
  const allDone = batches.length > 0 && batches.every((batch) => ['done', 'skipped'].includes(batch.status))
  return saveRevision(root, projectId, {
    batches,
    ...(input.note ? { notes: [...(revision.notes ?? []), { at: new Date().toISOString(), text: String(input.note) }] } : {}),
    ...(allDone ? { status: 'done' } : {}),
  })
}

/** 大纲确认 / 手动恢复时发给同一会话的续跑 prompt。 */
export function buildExpansionResumePrompt(expansionInput = {}) {
  const expansion = { ...defaultExpansion(), ...expansionInput }
  return [
    '续跑（用户手动触发）：继续「扩写」goal。',
    `runId=${expansion.runId || '（无）'} ｜ 状态：${expansion.status} ｜ 模式：${expansion.mode || '—'} ｜ 目标字数：${expansion.targetWords || '?'} ｜ 已批准大纲变更：${(expansion.approvedOutlineChanges ?? []).length} 条。`,
    '按已确认方案继续：每批写 → 审一次 → 修一次（扩写提案带 data.expansionRunId 与 data.expansion，工作台自动采纳并保留原稿备份）；需要动大纲时提交 outlines 提案并 wait-outline 等用户确认；不要问作者、不要中途停；完成后 op="finish" 汇报。',
  ].join('\n')
}

/** 扩写状态摘要（MCP status / 页面提示）。 */
export function expansionSummaryText(expansionInput = {}) {
  const expansion = { ...defaultExpansion(), ...expansionInput }
  const targets = Array.isArray(expansion.chapterTargets) ? expansion.chapterTargets : []
  const budget = expansion.budget ?? {}
  const ratio = pipelineBudgetRatio(budget)
  const lines = [
    '# 扩写',
    `- 状态：${expansion.status} ｜ 模式：${expansion.mode || '—'} ｜ 目标字数：${expansion.mode === 'chapter' ? `${targets[0]?.targetWords ?? expansion.targetWords ?? '—'} 字/章` : `${expansion.targetWords || '—'} 字/章`}`,
    `- 范围：${expansionScopeText(expansion)} ｜ 逐章目标：${targets.length} 章`,
    `- runId：${expansion.runId || '—'} ｜ sessionId：${expansion.sessionId || '—'}`,
    `- 大纲变更：待确认 ${(expansion.outlineChanges ?? []).length} 条 / 已批准 ${(expansion.approvedOutlineChanges ?? []).length} 条`,
    `- 预算：已用 ${Number(budget.usedTokens) || 0} tokens / ¥${Number(budget.usedCostCNY) || 0}${ratio > 0 ? `（${Math.round(ratio * 100)}%）` : ''}`,
  ]
  if (targets.length > 0) lines.push('- 逐章目标：', ...targets.slice(0, 40).map((row) => `  - 第${row.chapter}章 → ${row.targetWords} 字（${row.type}）`))
  const notes = (expansion.notes ?? []).slice(-5)
  if (notes.length > 0) lines.push('- 最近进度：', ...notes.map((note) => `  - ${note.at ?? ''} ${note.text ?? ''}`))
  return lines.join('\n')
}

/** 第一步：新建会话 + 宏观方案 prompt；targetWords 必填无默认。 */
export async function planExpansion(root, projectId, input = {}, ctx = null) {
  const targetWords = Number(input.targetWords)
  if (!Number.isFinite(targetWords) || targetWords <= 0) throw new Error('请填写目标字数')
  const bundle = await getBundle(root, projectId)
  assertActivePreset(bundle)
  const current = await getExpansion(root, projectId)
  if (current.status === 'structuring' || current.status === 'running') throw new Error('扩写正在执行，先暂停/重置再重新出方案')
  const mode = input.mode === 'chapter' ? 'chapter' : 'book'
  let scopeChapters = Array.isArray(input.scope?.chapters) ? input.scope.chapters.map(Number).filter((n) => Number.isFinite(n) && n > 0) : []
  if (Array.isArray(input.chapterTargets)) scopeChapters = [...scopeChapters, ...sanitizeChapterTargets(input.chapterTargets).map((row) => row.chapter)]
  scopeChapters = [...new Set(scopeChapters)].sort((a, b) => a - b)
  if (mode === 'chapter') {
    if (scopeChapters.length === 0) {
      const maxChapter = pipelineMaxChapter(bundle.chapters)
      if (maxChapter > 0) scopeChapters = [maxChapter]
    }
    if (scopeChapters.length === 0) throw new Error('单章扩写需要指定章节')
    scopeChapters = [scopeChapters[0]]
  }
  const budget = {
    maxTokens: Number(input.budget?.maxTokens) || 0,
    maxCostCNY: Number(input.budget?.maxCostCNY) || 0,
    usedTokens: 0,
    usedCostCNY: 0,
    baseline: null,
  }
  const runId = `exp-${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
  const allowOutlineChanges = input.allowOutlineChanges === true
  const options = {
    additions: input.additions && typeof input.additions === 'object' ? { ...input.additions } : {},
    additionLimit: Math.max(0, Number(input.additionLimit) || 0),
    sampleChapters: Math.max(0, Number(input.sampleChapters) || 0),
    allowOutlineChanges,
  }
  const saved = await saveExpansion(root, projectId, {
    status: 'planning',
    mode,
    scope: { type: mode, chapters: scopeChapters },
    targetWords,
    planConfirmed: false,
    options,
    chapterTargets: sanitizeChapterTargets(input.chapterTargets),
    plan: { diagnosis: [], capacity: [], outlineChanges: [], notes: [] },
    outlineChanges: [],
    approvedOutlineChanges: [],
    runId,
    sessionId: '',
    budget,
    notes: expansionPushNote(current, `开始扩写方案：${mode === 'chapter' ? `第 ${scopeChapters[0]} 章` : '全部扩写'}，目标 ${targetWords} 字/章；允许大纲变更：${allowOutlineChanges ? '是（仍需逐项确认）' : '否（默认）'}`),
  })
  const prompt = buildExpansionPlanPrompt(bundle, saved)
  const session = await startPipelineSession(ctx, root, bundle, prompt)
  const expansion = await saveExpansion(root, projectId, { sessionId: session.sessionId })
  return { expansion, sessionId: session.sessionId, prompt }
}

/** 用户确认宏观方案（可带编辑过的 chapterTargets，白名单写入）。 */
export async function confirmExpansionPlan(root, projectId, input = {}) {
  const current = await getExpansion(root, projectId)
  if (current.status === 'structuring' || current.status === 'running') throw new Error('扩写正在执行，不能重新确认方案')
  const patch = {
    status: 'plan-ready',
    planConfirmed: true,
    notes: expansionPushNote(current, '作者已确认扩写方案'),
  }
  if (input.plan && typeof input.plan === 'object') {
    const plan = { ...current.plan }
    for (const key of ['diagnosis', 'capacity', 'outlineChanges', 'confirmations', 'notes']) {
      if (Array.isArray(input.plan[key])) plan[key] = input.plan[key]
    }
    patch.plan = plan
    if (Array.isArray(input.plan.outlineChanges)) patch.outlineChanges = input.plan.outlineChanges
  }
  if (Array.isArray(input.chapterTargets)) patch.chapterTargets = sanitizeChapterTargets(input.chapterTargets)
  if (Array.isArray(input.approvedOutlineIds)) {
    const pending = (patch.plan?.outlineChanges ?? current.outlineChanges ?? []).filter(Boolean)
    const approved = pending.filter((change) => input.approvedOutlineIds.map(String).includes(String(change.id ?? change.title ?? '')))
    patch.approvedOutlineChanges = approved
    patch.notes = expansionPushNote(current, `作者确认 ${approved.length}/${pending.length} 条大纲变更`)
  }
  return saveExpansion(root, projectId, patch)
}

/** 第二步：按已确认方案启动自动扩写（新会话 + goal prompt）。 */
export async function startExpansion(root, projectId, ctx = null) {
  const bundle = await getBundle(root, projectId)
  assertActivePreset(bundle)
  const current = await getExpansion(root, projectId)
  if (current.status !== 'plan-ready') throw new Error('请先确认扩写方案（status=plan-ready）再开始')
  const targetWords = Number(current.targetWords)
  if (!Number.isFinite(targetWords) || targetWords <= 0) throw new Error('请填写目标字数')
  const targets = effectiveChapterTargets(bundle, current).map((row) => ({
    ...row,
    targetWords: Number(row.targetWords) > 0 ? Number(row.targetWords) : targetWords,
  }))
  if (targets.length === 0) throw new Error('没有可扩写的章节')
  const pendingOutlineChanges = Array.isArray(current.outlineChanges) && current.outlineChanges.length > 0
    ? current.outlineChanges
    : (Array.isArray(current.plan?.outlineChanges) ? current.plan.outlineChanges : [])
  const approvedOutlineChanges = Array.isArray(current.approvedOutlineChanges) ? current.approvedOutlineChanges : []
  const approvedIds = new Set(approvedOutlineChanges.map((change) => String(change?.id ?? change?.title ?? '')))
  const unapprovedOutlineChanges = pendingOutlineChanges.filter((change) => !approvedIds.has(String(change?.id ?? change?.title ?? '')))
  const usageBefore = await summarizeUsage(root, projectId, ctx)
  const budget = {
    maxTokens: Number(current.budget.maxTokens) || 0,
    maxCostCNY: Number(current.budget.maxCostCNY) || 0,
    usedTokens: 0,
    usedCostCNY: 0,
    baseline: { tokens: usageBefore.tokens, costCNY: usageBefore.costCNY },
  }
  const status = unapprovedOutlineChanges.length > 0 ? 'structuring' : 'running'
  await autoSnapshotBeforeRun(root, projectId, `扩写开工前 · ${targets.length} 章`, current.runId)
  const saved = await saveExpansion(root, projectId, {
    status,
    runId: current.runId || `exp-${Date.now().toString(36)}${randomUUID().slice(0, 4)}`,
    chapterTargets: targets,
    outlineChanges: pendingOutlineChanges,
    approvedOutlineChanges,
    budget,
    sessionId: '',
    notes: expansionPushNote(current, `启动扩写执行（${status === 'structuring' ? '先补地基/大纲闸门' : '全自动'}）`),
  })
  const prompt = buildExpansionGoalPrompt(bundle, saved)
  let session
  try {
    session = await startPipelineSession(ctx, root, bundle, prompt)
  } catch (error) {
    await saveExpansion(root, projectId, {
      status: 'stuck',
      notes: expansionPushNote(saved, `启动扩写会话失败：${error instanceof Error ? error.message : String(error)}`),
    })
    throw error
  }
  const expansion = await saveExpansion(root, projectId, { sessionId: session.sessionId })
  return { expansion, sessionId: session.sessionId, prompt }
}

/** 用户确认大纲变更：采纳带该 runId 的 pending outlines 提案 → approvedOutlineChanges → running + 续跑 prompt。 */
export async function approveExpansionOutline(root, projectId, input = {}, ctx = null) {
  // 兼容旧调用 approveExpansionOutline(root, projectId, ctx)
  if (input && typeof input.get === 'function' && !ctx) {
    ctx = input
    input = {}
  }
  const bundle = await getBundle(root, projectId)
  const current = await getExpansion(root, projectId)
  if (current.status !== 'waiting-outline' && current.status !== 'structuring') {
    throw new Error('当前没有待确认的大纲变更')
  }
  const requestedIds = (Array.isArray(input.approvedOutlineIds) ? input.approvedOutlineIds : []).map(String).filter(Boolean)
  const pending = (bundle.proposals ?? []).filter((proposal) => (
    proposal.status === 'pending'
    && proposal.kind === 'outlines'
    && String(proposal.data?.expansionRunId ?? '') === String(current.runId ?? '')
  ))
  const accepted = []
  for (const proposal of pending) {
    if (requestedIds.length > 0 && !requestedIds.includes(String(proposal.id))) continue
    await acceptProposal(root, projectId, proposal.id)
    accepted.push({ proposalId: proposal.id, title: proposal.title, summary: proposal.summary, chapter: proposal.chapter ?? null })
  }
  // 方案阶段就存在 expansion.outlineChanges 时，不依赖 outlines 提案，直接按作者勾选写入 approvedOutlineChanges
  const planChanges = Array.isArray(current.outlineChanges) && current.outlineChanges.length > 0
    ? current.outlineChanges
    : (Array.isArray(current.plan?.outlineChanges) ? current.plan.outlineChanges : [])
  const selectedChanges = requestedIds.length > 0
    ? planChanges.filter((change) => requestedIds.includes(String(change?.id ?? change?.title ?? '')))
    : []
  if (accepted.length === 0 && selectedChanges.length === 0) {
    throw new Error(requestedIds.length > 0 ? '选中的大纲变更不存在或已批准' : '请先勾选要批准的大纲变更（或等待 AI 提交变更提案）')
  }
  const existing = Array.isArray(current.approvedOutlineChanges) ? current.approvedOutlineChanges : []
  const merged = [...existing]
  for (const change of selectedChanges) {
    const key = String(change?.id ?? change?.title ?? '')
    if (key && !merged.some((row) => String(row?.id ?? row?.title ?? '') === key)) merged.push(change)
  }
  const approved = [...merged, ...accepted]
  const saved = await saveExpansion(root, projectId, {
    status: 'running',
    approvedOutlineChanges: approved,
    notes: expansionPushNote(current, `作者确认 ${accepted.length + selectedChanges.length} 条大纲变更，继续扩写`),
  })
  const prompt = buildExpansionResumePrompt(saved)
  if (saved.sessionId) await sendPipelinePrompt(ctx, saved.sessionId, prompt)
  return { expansion: saved, accepted, sessionId: saved.sessionId, prompt }
}

/** 执行进度上报（RPC 与 MCP 共用）：状态/notes/预算结算。 */
export async function advanceExpansion(root, projectId, input = {}, ctx = null) {
  const current = await getExpansion(root, projectId)
  if (current.status === 'idle') throw new Error('还没有开始扩写')
  const statusInput = String(input.status ?? '')
  const notes = [...current.notes]
  if (String(input.note ?? '').trim()) notes.push({ at: expansionNow(), text: `${input.stageId ? `${input.stageId}：` : ''}${String(input.note).trim()}` })
  const patch = { notes }
  if (EXPANSION_STATUSES.includes(statusInput) && statusInput !== 'idle') {
    patch.status = statusInput
    notes.push({ at: expansionNow(), text: `状态 → ${statusInput}` })
  }
  let usage = null
  let warning = false
  if (current.budget.baseline) {
    usage = await summarizeUsage(root, projectId, ctx)
    const baseline = current.budget.baseline
    const budget = {
      ...current.budget,
      usedTokens: Math.max(0, usage.tokens - (Number(baseline.tokens) || 0)),
      usedCostCNY: Math.max(0, usage.costCNY - (Number(baseline.costCNY) || 0)),
    }
    const ratio = pipelineBudgetRatio(budget)
    if (ratio >= 1 && ['structuring', 'running'].includes(patch.status ?? current.status)) {
      patch.status = 'paused'
      notes.push({ at: expansionNow(), text: `预算超限（${Math.round(ratio * 100)}%），已自动暂停` })
    } else if (ratio >= PIPELINE_BUDGET_WARN_RATIO) {
      warning = true
      notes.push({ at: expansionNow(), text: `预算预警：已用 ${Math.round(ratio * 100)}%` })
    }
    patch.budget = budget
  }
  const saved = await saveExpansion(root, projectId, patch)
  return { expansion: saved, usage, warning }
}

export async function pauseExpansion(root, projectId, note = '用户暂停') {
  const current = await getExpansion(root, projectId)
  if (current.status === 'idle') throw new Error('还没有开始扩写')
  return saveExpansion(root, projectId, {
    status: 'paused',
    notes: expansionPushNote(current, String(note ?? '暂停')),
  })
}

export async function resumeExpansion(root, projectId, ctx = null) {
  const current = await getExpansion(root, projectId)
  if (current.status !== 'paused' && current.status !== 'stuck') throw new Error('只有 paused/stuck 的扩写可以恢复')
  if (!current.sessionId) throw new Error('扩写没有会话，无法恢复')
  const prompt = buildExpansionResumePrompt(current)
  await sendPipelinePrompt(ctx, current.sessionId, prompt)
  const saved = await saveExpansion(root, projectId, {
    status: 'running',
    notes: expansionPushNote(current, '用户手动恢复，已发送续跑 prompt'),
  })
  return { expansion: saved, sessionId: current.sessionId, prompt }
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

// ── 只读 HTML 视图（打印 / 导出用：自包含，无外部资源，不写数据、不调 AI）──

const LOCATION_TYPE_LABEL = {
  capital: '都城', city: '城市', town: '城镇', village: '村落', pass: '关隘',
  temple: '寺庙', mountain: '山川', river: '河流', sea: '海域', other: '其他',
}
const LOCATION_TYPE_COLOR = {
  capital: '#c2410c', city: '#1d4ed8', town: '#0e7490', village: '#15803d', pass: '#b91c1c',
  temple: '#6d28d9', mountain: '#475569', river: '#0284c7', sea: '#0369a1', other: '#6b7280',
}
const ATTENTION_TIERS = [
  { min: 80, label: '强吸引', className: 'tier-high', color: '#15803d' },
  { min: 60, label: '合格想追', className: 'tier-mid', color: '#1d4ed8' },
  { min: 40, label: '能读但平淡', className: 'tier-low', color: '#b45309' },
  { min: 0, label: '会弃读', className: 'tier-bad', color: '#b91c1c' },
]

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

function attentionTier(score) {
  if (score === null || score === undefined || score === '') return { label: '未标', className: 'tier-none', color: '#9ca3af', scoreText: '—' }
  const n = Number(score)
  if (!Number.isFinite(n)) return { label: '未标', className: 'tier-none', color: '#9ca3af', scoreText: '—' }
  const tier = ATTENTION_TIERS.find((row) => n >= row.min) ?? ATTENTION_TIERS[ATTENTION_TIERS.length - 1]
  return { ...tier, scoreText: String(Math.round(n)) }
}

const VIEW_STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 0 24px 48px; background: #f8fafc; color: #111827;
  font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 0 12px; border-bottom: 2px solid #1f2937; }
.top h1 { margin: 0; font-size: 22px; }
.top .meta { color: #4b5563; font-size: 14px; }
.actions button { border: 1px solid #1f2937; background: #1f2937; color: #fff; border-radius: 8px;
  padding: 8px 16px; font-size: 14px; cursor: pointer; }
.actions button:hover { background: #111827; }
main { margin-top: 20px; }
section { margin: 0 0 20px; }
h2 { font-size: 17px; margin: 24px 0 10px; padding-left: 8px; border-left: 4px solid #1f2937; }
.cards { display: flex; flex-wrap: wrap; gap: 12px; }
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 16px; min-width: 160px; }
.card .k { color: #6b7280; font-size: 12px; }
.card .v { font-size: 18px; font-weight: 600; margin-top: 4px; }
.notice { background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 14px 18px; color: #92400e; }
table { width: 100%; border-collapse: collapse; background: #fff; font-size: 13px; }
th, td { border: 1px solid #e5e7eb; padding: 7px 9px; text-align: left; vertical-align: top; }
th { background: #f3f4f6; font-weight: 600; }
.map-wrap { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px; overflow: hidden; }
svg text { font-family: inherit; }
.legend { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0; font-size: 12px; color: #374151; }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.tag { display: inline-block; border-radius: 999px; padding: 1px 8px; margin: 1px 4px 1px 0; font-size: 12px; background: #eef2ff; color: #3730a3; }
.tag.event { background: #e0f2fe; color: #075985; }
.tag.foreshadow { background: #f3e8ff; color: #6b21a8; }
.tag.conflict { background: #fee2e2; color: #991b1b; }
.tag.highlight { background: #fef3c7; color: #92400e; }
.tag.attention { background: #dcfce7; color: #166534; }
.chapter-row { display: flex; gap: 10px; padding: 7px 0; border-bottom: 1px dashed #e5e7eb; }
.chapter-row .no { flex: 0 0 150px; font-weight: 600; }
.chapter-row .items { flex: 1; }
.snake-row { display: flex; gap: 10px; margin: 0 0 10px; }
.snake-row.reverse { flex-direction: row-reverse; }
.node { flex: 0 0 120px; min-height: 96px; background: #fff; border: 1px solid #d1d5db; border-top: 4px solid #9ca3af;
  border-radius: 8px; padding: 8px 9px; position: relative; page-break-inside: avoid; }
.node .node-no { font-size: 12px; color: #6b7280; }
.node .node-title { font-size: 13px; font-weight: 600; margin: 4px 0; line-height: 1.3; word-break: break-all; }
.node .node-score { font-size: 12px; }
.node .corners { position: absolute; right: 6px; bottom: 6px; display: flex; gap: 3px; font-size: 10px; }
.node .corners b { background: #f3f4f6; border-radius: 4px; padding: 0 3px; font-weight: 600; color: #374151; }
.node.status-draft { border-top-color: #3b82f6; }
.node.status-planned { border-top-color: #9ca3af; }
.node.status-revised { border-top-color: #f59e0b; }
.node.status-final { border-top-color: #16a34a; }
.node.tier-high .node-score { color: #15803d; font-weight: 700; }
.node.tier-mid .node-score { color: #1d4ed8; font-weight: 600; }
.node.tier-low .node-score { color: #b45309; }
.node.tier-bad .node-score { color: #b91c1c; }
.node.tier-none .node-score { color: #9ca3af; }
footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 12px; }
@media print {
  body { background: #fff; padding: 0 8px; }
  .actions { display: none; }
  h2 { page-break-after: avoid; }
  .map-wrap, table { page-break-inside: auto; }
}
`

function viewPage({ title, projectName, subtitle = '', body, extraStyle = '' }) {
  const safeProject = escapeHtml(projectName || '未命名作品')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 《${safeProject}》</title>
<style>${VIEW_STYLE}${extraStyle}</style>
</head>
<body>
<header class="top">
  <div><h1>${escapeHtml(title)}</h1>${subtitle ? `<div class="meta">${escapeHtml(subtitle)}</div>` : ''}</div>
  <div class="actions"><button type="button" onclick="window.print()">打印 / 导出 PDF</button></div>
</header>
<main>
${body}
</main>
<footer>《${safeProject}》 · 长篇中文小说工作台</footer>
</body>
</html>`
}

function viewMessagePage(title, message, projectName = '') {
  return viewPage({
    title: '长篇中文小说工作台',
    projectName,
    subtitle: title,
    body: `<section class="notice">${escapeHtml(message)}</section>`,
  })
}

/** 世界视图：世界摘要 + SVG 坐标地图 + 地点清单。 */
export function renderWorldHtml(bundle = {}) {
  const project = bundle.project ?? {}
  const world = bundle.world ?? {}
  const locations = Array.isArray(bundle.locations) ? bundle.locations : []
  const mapW = Number(world.mapSize?.w) > 0 ? Number(world.mapSize.w) : 1000
  const mapH = Number(world.mapSize?.h) > 0 ? Number(world.mapSize.h) : 1000
  const byId = new Map(locations.map((loc) => [String(loc.id ?? loc.name), loc]))
  const parts = []
  parts.push(`<section class="cards">
    <div class="card"><div class="k">世界</div><div class="v">${escapeHtml(world.name || '未命名')}</div></div>
    <div class="card"><div class="k">尺度</div><div class="v">${escapeHtml(world.scale || '—')}</div></div>
    <div class="card"><div class="k">类型</div><div class="v">${escapeHtml(world.kind || '—')}</div></div>
    <div class="card"><div class="k">时代</div><div class="v">${escapeHtml(world.era || '—')}</div></div>
    <div class="card"><div class="k">地点</div><div class="v">${locations.length}</div></div>
  </section>`)
  if (!bundle.worldSaved) {
    parts.push('<section class="notice">这部作品还没有保存世界模型。可用清单任务「AI 生成世界地图」（world-build）或「AI 反推地点」（world-infer）补齐，再在提案页采纳。</section>')
  }
  parts.push(`<section><div class="legend">
    <span>坐标空间：${mapW} × ${mapH}</span>
    <span>行程：步行 ${escapeHtml(world.travelModel?.walkKmPerDay ?? '—')} km/天</span>
    <span>马 ${escapeHtml(world.travelModel?.horseKmPerDay ?? '—')} km/天</span>
    <span>船 ${escapeHtml(world.travelModel?.boatKmPerDay ?? '—')} km/天</span>
    <span>生成：${escapeHtml(world.generatedBy || '—')}</span>
    ${Object.entries(LOCATION_TYPE_LABEL).map(([type, label]) => `<span><i style="background:${LOCATION_TYPE_COLOR[type]}"></i>${label}</span>`).join('')}
  </div></section>`)
  parts.push('<h2>坐标地图</h2>')
  if (locations.length === 0) {
    parts.push('<section class="notice">还没有地点。用「AI 生成世界地图」或「AI 反推地点」任务生成地点提案。</section>')
  } else {
    const drawn = []
    for (const loc of locations) {
      const x = Number(loc.coords?.x)
      const y = Number(loc.coords?.y)
      if (Number.isFinite(x) && Number.isFinite(y)) drawn.push({ loc, x, y })
    }
    const drawnById = new Map(drawn.map((row) => [String(row.loc.id ?? row.loc.name), row]))
    const lines = []
    const seen = new Set()
    for (const { loc } of drawn) {
      for (const conn of Array.isArray(loc.connections) ? loc.connections : []) {
        const from = drawnById.get(String(loc.id ?? loc.name))
        const to = drawnById.get(String(conn?.to ?? ''))
        if (!from || !to) continue
        const key = [String(loc.id ?? loc.name), String(conn.to)].sort().join('→')
        if (seen.has(key)) continue
        seen.add(key)
        const mx = (from.x + to.x) / 2
        const my = (from.y + to.y) / 2
        lines.push(`<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="#94a3b8" stroke-width="2" stroke-dasharray="6 4"/>`)
        if (Number(conn?.distanceKm) > 0) {
          lines.push(`<text x="${mx}" y="${my - 6}" font-size="16" fill="#475569" text-anchor="middle">${escapeHtml(conn.distanceKm)}km</text>`)
        }
      }
    }
    const nodes = drawn.map(({ loc, x, y }) => {
      const type = LOCATION_TYPE_LABEL[loc.type] ? loc.type : 'other'
      const color = LOCATION_TYPE_COLOR[type]
      return `<g>
        <circle cx="${x}" cy="${y}" r="14" fill="${color}" stroke="#fff" stroke-width="3"/>
        <text x="${x}" y="${y - 22}" font-size="18" font-weight="600" fill="#111827" text-anchor="middle" style="paint-order:stroke;stroke:#fff;stroke-width:4px;stroke-linejoin:round">${escapeHtml(loc.name ?? loc.id)}</text>
      </g>`
    })
    parts.push(`<div class="map-wrap"><svg viewBox="0 0 ${mapW} ${mapH}" width="100%" role="img" aria-label="世界坐标地图">
      <defs><pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse">
        <path d="M 100 0 L 0 0 0 100" fill="none" stroke="#e5e7eb" stroke-width="1"/>
      </pattern></defs>
      <rect x="0" y="0" width="${mapW}" height="${mapH}" fill="url(#grid)" stroke="#cbd5e1" stroke-width="2"/>
      ${lines.join('')}
      ${nodes.join('')}
    </svg></div>`)
  }
  parts.push('<h2>地点清单</h2>')
  if (locations.length === 0) {
    parts.push('<section class="notice">暂无地点记录。</section>')
  } else {
    const rows = locations.map((loc) => {
      const connections = (Array.isArray(loc.connections) ? loc.connections : []).map((conn) => {
        const target = byId.get(String(conn?.to ?? ''))
        const targetName = target?.name ?? conn?.to ?? '?'
        const detail = [conn?.distanceKm ? `${conn.distanceKm}km` : '', conn?.days ? `${conn.days}天` : '', conn?.mode ?? '', conn?.bearing ?? '']
          .filter(Boolean).join('/')
        return `${escapeHtml(targetName)}${detail ? `（${escapeHtml(detail)}）` : ''}`
      }).join('、')
      return `<tr>
        <td>${escapeHtml(loc.name ?? loc.id)}</td>
        <td>${escapeHtml((Array.isArray(loc.aliases) ? loc.aliases : []).join('、') || '—')}</td>
        <td>${escapeHtml(LOCATION_TYPE_LABEL[loc.type] ?? loc.type ?? '其他')}</td>
        <td>${escapeHtml(loc.region || '—')}</td>
        <td>${escapeHtml(loc.coords?.x ?? '?')}, ${escapeHtml(loc.coords?.y ?? '?')}</td>
        <td>${escapeHtml(loc.firstChapter ?? '—')}</td>
        <td>${connections || '—'}</td>
      </tr>`
    }).join('')
    parts.push(`<table><thead><tr><th>名称</th><th>别名</th><th>类型</th><th>区域</th><th>坐标</th><th>首次出现章</th><th>连接</th></tr></thead><tbody>${rows}</tbody></table>`)
  }
  return viewPage({ title: '世界地图', projectName: project.name, subtitle: `地点 ${locations.length} 个`, body: parts.join('\n') })
}

/** 注意力视图：0-100 注意力曲线 + 每章诊断（只读、可打印）。 */
export function renderAttentionHtml(bundle = {}) {
  const project = bundle.project ?? {}
  const TYPE_LABEL = { event: '事件', emotion: '情感', language: '文字', mystery: '悬念', relationship: '关系' }
  const TYPE_COLOR = { event: '#0ea5e9', emotion: '#ef4444', language: '#8b5cf6', mystery: '#f59e0b', relationship: '#10b981' }
  const rows = (bundle.attention ?? [])
    .map((row) => ({ ...row, chapter: Number(row.chapter) || 0 }))
    .filter((row) => row.chapter > 0)
    .sort((a, b) => a.chapter - b.chapter)
  const scored = rows.filter((row) => row.score !== null && row.score !== undefined && row.score !== '' && Number.isFinite(Number(row.score)))
  const avg = scored.length > 0 ? Math.round(scored.reduce((sum, row) => sum + Number(row.score), 0) / scored.length) : null
  const lowest = [...scored].sort((a, b) => Number(a.score) - Number(b.score)).slice(0, 3)
  const written = (bundle.chapters ?? []).filter((chapter) => String(chapter.content ?? '').trim())
  const labeled = new Set(rows.map((row) => row.chapter))
  const unmarked = written.filter((chapter) => !labeled.has(Number(chapter.id))).length
  const parts = []
  parts.push(`<section class="cards">
    <div class="card"><div class="k">平均注意力分</div><div class="v">${avg === null ? '—' : avg}</div></div>
    <div class="card"><div class="k">有实测分的章</div><div class="v">${scored.length} / ${rows.length}</div></div>
    <div class="card"><div class="k">未标注意力的已写章</div><div class="v">${unmarked}</div></div>
    <div class="card"><div class="k">最低三章</div><div class="v" style="font-size:14px">${lowest.length > 0 ? lowest.map((row) => `第${row.chapter}章 ${Math.round(Number(row.score))}`).join(' · ') : '—'}</div></div>
  </section>`)
  if (rows.length === 0) {
    parts.push('<section class="notice">还没有注意力记录：先在「注意力」页设计或冷读打分。</section>')
  } else {
    const W = Math.max(760, rows.length * 34 + 80)
    const H = 240
    const padX = 36
    const padY = 30
    const x = (index) => (rows.length === 1 ? W / 2 : padX + index * (W - padX * 2) / (rows.length - 1))
    const y = (score) => H - padY - (Math.max(0, Math.min(100, Number(score) || 0)) / 100) * (H - padY * 2)
    const scoredPts = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.score !== null && row.score !== undefined && row.score !== '' && Number.isFinite(Number(row.score)))
    const designPts = rows.map((row, index) => ({ row, index })).filter(({ row }) => Number.isFinite(Number(row.designScore)))
    const scorePath = scoredPts.map(({ row, index }, i) => `${i === 0 ? 'M' : 'L'} ${x(index).toFixed(1)} ${y(row.score).toFixed(1)}`).join(' ')
    const designPath = designPts.map(({ row, index }, i) => `${i === 0 ? 'M' : 'L'} ${x(index).toFixed(1)} ${y(row.designScore).toFixed(1)}`).join(' ')
    const grid = [0, 20, 40, 60, 80, 100].map((line) => `<line x1="${padX}" y1="${y(line)}" x2="${W - padX}" y2="${y(line)}" stroke="#e5e7eb" stroke-width="1" stroke-dasharray="4 5"/><text x="${padX - 8}" y="${y(line) + 4}" font-size="10" fill="#9ca3af" text-anchor="end">${line}</text>`).join('')
    const dots = rows.map((row, index) => {
      const score = Number(row.score)
      const hasScore = row.score !== null && row.score !== undefined && row.score !== '' && Number.isFinite(score)
      const color = TYPE_COLOR[row.type] ?? '#64748b'
      const cx = x(index)
      const cy = hasScore ? y(score) : H - padY - 6
      const title = `第${row.chapter}章 · ${TYPE_LABEL[row.type] ?? row.type ?? '未分型'} · ${hasScore ? `${Math.round(score)} 分` : '未测'}${row.dropRisk ? ` · 弃读点：${row.dropRisk}` : ''}`
      return `<g><title>${escapeHtml(title)}</title>${hasScore ? `<circle cx="${cx}" cy="${cy}" r="${row.dropRisk ? 6 : 4.5}" fill="${color}" stroke="${row.dropRisk ? '#b91c1c' : '#fff'}" stroke-width="${row.dropRisk ? 2 : 1.5}"/>` : `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#cbd5e1"/>`}<text x="${cx}" y="${H - 8}" font-size="10" fill="#6b7280" text-anchor="middle">${row.chapter}</text></g>`
    }).join('')
    parts.push(`<section><h2>注意力曲线（0–100）</h2><div class="map-wrap"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="注意力曲线">${grid}${designPath ? `<path d="${designPath}" fill="none" stroke="#94a3b8" stroke-width="2" stroke-dasharray="6 5"/>` : ''}${scorePath ? `<path d="${scorePath}" fill="none" stroke="#1f2937" stroke-width="2.5"/>` : ''}${dots}</svg></div>
    <div class="legend">${Object.entries(TYPE_LABEL).map(([type, label]) => `<span><i style="background:${TYPE_COLOR[type]}"></i>${label}</span>`).join('')}<span><i style="background:#94a3b8"></i>虚线=设计目标分</span><span><i style="background:#b91c1c"></i>红圈=弃读点</span><span>灰点=未测</span></div></section>`)
    parts.push('<section><h2>每章诊断</h2><table class="attention-table"><thead><tr><th>章</th><th>类型</th><th>总分</th><th>目标</th><th>下一章意愿</th><th>最弱一环</th><th>弃读点</th><th>章末牵引</th><th>详细说明</th></tr></thead><tbody>')
    for (const row of rows) {
      const tier = attentionTier(row.score)
      const typeLabel = TYPE_LABEL[row.type] ?? row.type ?? '—'
      const detail = String(row.detail ?? '')
      parts.push(`<tr><td>第${row.chapter}章</td><td>${escapeHtml(typeLabel)}</td><td style="color:${tier.color};font-weight:700">${tier.scoreText}</td><td>${row.designScore ?? '—'}</td><td>${escapeHtml(row.verdict ?? '—')}</td><td>${escapeHtml(row.weakest ?? '—')}</td><td>${escapeHtml(row.dropRisk ?? '—')}</td><td>${escapeHtml(row.cliff ?? '—')}</td><td style="max-width:360px">${escapeHtml(detail.length > 240 ? `${detail.slice(0, 240)}…` : detail)}</td></tr>`)
    }
    parts.push('</tbody></table></section>')
  }
  return viewPage({
    title: '注意力',
    projectName: project.name,
    subtitle: `ATTENTION IS ALL YOU NEED · 怎么吸引读者怎么来，一切为读者服务 · ${rows.length} 章有注意力记录`,
    body: parts.join('\n'),
    extraStyle: '.attention-table td, .attention-table th { white-space: nowrap; } .attention-table td:last-child { white-space: normal; min-width: 300px; }',
  })
}

/** 时间线全景：按章列出事件 / 伏笔埋收 / 冲突 / 高光 / 注意力，每 20 章（或按分卷预设）分组。 */
export function renderTimelineHtml(bundle = {}) {
  const project = bundle.project ?? {}
  const chapters = [...(bundle.chapters ?? [])].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
  const byChapter = (list) => {
    const map = new Map()
    for (const item of list ?? []) {
      const n = Number(item.chapter)
      if (!Number.isFinite(n)) continue
      if (!map.has(n)) map.set(n, [])
      map.get(n).push(item)
    }
    return map
  }
  const events = byChapter(bundle.events)
  const highlights = byChapter(bundle.highlights)
  const attention = new Map()
  for (const row of bundle.attention ?? []) {
    const n = Number(row.chapter)
    if (Number.isFinite(n)) attention.set(n, row)
  }
  const foreshadowSetup = byChapter((bundle.foreshadow ?? []).map((f) => ({ ...f, chapter: f.setupChapter })))
  const foreshadowPayoff = byChapter((bundle.foreshadow ?? []).map((f) => ({ ...f, chapter: f.payoffChapter })).filter((f) => Number(f.chapter) > 0))
  const conflictResolve = byChapter((bundle.conflicts ?? []).filter((c) => Number(c.resolveChapter) > 0).map((c) => ({ ...c, chapter: c.resolveChapter })))
  const parts = [`<section class="cards">
    <div class="card"><div class="k">章节</div><div class="v">${chapters.length}</div></div>
    <div class="card"><div class="k">事件</div><div class="v">${(bundle.events ?? []).length}</div></div>
    <div class="card"><div class="k">伏笔</div><div class="v">${(bundle.foreshadow ?? []).length}</div></div>
    <div class="card"><div class="k">冲突</div><div class="v">${(bundle.conflicts ?? []).length}</div></div>
    <div class="card"><div class="k">高光</div><div class="v">${(bundle.highlights ?? []).length}</div></div>
  </section>`]
  if (chapters.length === 0) {
    parts.push('<section class="notice">还没有章节，无法生成时间线全景。</section>')
    return viewPage({ title: '时间线全景', projectName: project.name, body: parts.join('\n') })
  }
  // 分卷预设优先；否则每 20 章一组
  const volumes = (bundle.presets ?? [])
    .filter((preset) => Number(preset.chapterFrom) > 0 && Number(preset.chapterTo) > 0)
    .sort((a, b) => Number(a.chapterFrom) - Number(b.chapterFrom))
  let groups
  if (volumes.length > 0) {
    groups = volumes.map((volume) => ({
      title: volume.name || `第 ${volume.chapterFrom}–${volume.chapterTo} 章`,
      chapters: chapters.filter((chapter) => Number(chapter.id) >= Number(volume.chapterFrom) && Number(chapter.id) <= Number(volume.chapterTo)),
    })).filter((group) => group.chapters.length > 0)
  } else {
    groups = []
    for (let i = 0; i < chapters.length; i += 20) {
      const chunk = chapters.slice(i, i + 20)
      groups.push({ title: `第 ${Number(chunk[0].id)}–${Number(chunk[chunk.length - 1].id)} 章`, chapters: chunk })
    }
  }
  for (const group of groups) {
    parts.push(`<h2>${escapeHtml(group.title)}</h2>`)
    for (const chapter of group.chapters) {
      const n = Number(chapter.id)
      const items = []
      for (const event of events.get(n) ?? []) items.push(`<span class="tag event">事件：${escapeHtml(event.title ?? event.id)}${event.storyTime ? `（${escapeHtml(event.storyTime)}）` : ''}</span>`)
      for (const f of foreshadowSetup.get(n) ?? []) items.push(`<span class="tag foreshadow">伏笔埋：${escapeHtml(f.title ?? f.id)}</span>`)
      for (const f of foreshadowPayoff.get(n) ?? []) items.push(`<span class="tag foreshadow">伏笔收：${escapeHtml(f.title ?? f.id)}</span>`)
      for (const c of conflictResolve.get(n) ?? []) items.push(`<span class="tag conflict">冲突解：${escapeHtml(c.title ?? c.id)}</span>`)
      for (const h of highlights.get(n) ?? []) items.push(`<span class="tag highlight">高光：${escapeHtml(h.title ?? h.text ?? h.id ?? '')}</span>`)
      const attentionRow = attention.get(n)
      if (attentionRow) {
        const tier = attentionTier(attentionRow.score)
        items.push(`<span class="tag attention">注意力 ${escapeHtml(tier.scoreText)}/${escapeHtml(attentionRow.type ?? '未分型')} ${escapeHtml(tier.label)}</span>`)
      }
      parts.push(`<div class="chapter-row"><div class="no">第 ${n} 章《${escapeHtml(chapter.title ?? '')}》</div><div class="items">${items.join('') || '<span class="tag">（本章无记录）</span>'}</div></div>`)
    }
  }
  return viewPage({ title: '时间线全景', projectName: project.name, subtitle: `${chapters.length} 章`, body: parts.join('\n') })
}

/** 章节蛇形地图：状态 / 注意力分档 / 事件·冲突·伏笔·高光角标。 */
export function renderChapterMapHtml(bundle = {}) {
  const project = bundle.project ?? {}
  const chapters = [...(bundle.chapters ?? [])].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
  const countByChapter = (list, field = 'chapter') => {
    const map = new Map()
    for (const item of list ?? []) {
      const n = Number(item?.[field])
      if (!Number.isFinite(n)) continue
      map.set(n, (map.get(n) ?? 0) + 1)
    }
    return map
  }
  const eventCount = countByChapter(bundle.events)
  const highlightCount = countByChapter(bundle.highlights)
  const foreshadowCount = countByChapter([
    ...(bundle.foreshadow ?? []).map((f) => ({ chapter: f.setupChapter })),
    ...(bundle.foreshadow ?? []).map((f) => ({ chapter: f.payoffChapter })),
  ])
  const conflictCount = countByChapter((bundle.conflicts ?? []).map((c) => ({ chapter: c.resolveChapter })))
  const attention = new Map()
  for (const row of bundle.attention ?? []) {
    const n = Number(row.chapter)
    if (Number.isFinite(n)) attention.set(n, row)
  }
  const parts = [`<section class="cards">
    <div class="card"><div class="k">章节</div><div class="v">${chapters.length}</div></div>
    <div class="card"><div class="k">已标注意力</div><div class="v">${attention.size}</div></div>
    <div class="card"><div class="k">平均分</div><div class="v">${(() => {
      const scores = [...attention.values()].map((row) => Number(row.score)).filter((n) => Number.isFinite(n))
      return scores.length > 0 ? Math.round(scores.reduce((sum, n) => sum + n, 0) / scores.length) : '—'
    })()}</div></div>
  </section>
  <div class="legend">
    <span><i style="background:#16a34a"></i>80+ 强吸引</span>
    <span><i style="background:#1d4ed8"></i>60–79 合格想追</span>
    <span><i style="background:#b45309"></i>40–59 平淡</span>
    <span><i style="background:#b91c1c"></i>&lt;40 会弃读</span>
    <span>角标：E 事件 / F 伏笔 / C 冲突 / H 高光</span>
  </div>`]
  if (chapters.length === 0) {
    parts.push('<section class="notice">还没有章节，无法生成章节地图。</section>')
    return viewPage({ title: '章节地图', projectName: project.name, body: parts.join('\n') })
  }
  const perRow = 12
  const rows = []
  for (let i = 0; i < chapters.length; i += perRow) rows.push(chapters.slice(i, i + perRow))
  rows.forEach((row, rowIndex) => {
    const nodes = row.map((chapter) => {
      const n = Number(chapter.id)
      const status = ['draft', 'planned', 'revised', 'final'].includes(String(chapter.status)) ? String(chapter.status) : 'draft'
      const tier = attentionTier(attention.get(n)?.score ?? null)
      const corners = [
        eventCount.get(n) ? `<b>E${eventCount.get(n)}</b>` : '',
        foreshadowCount.get(n) ? `<b>F${foreshadowCount.get(n)}</b>` : '',
        conflictCount.get(n) ? `<b>C${conflictCount.get(n)}</b>` : '',
        highlightCount.get(n) ? `<b>H${highlightCount.get(n)}</b>` : '',
      ].join('')
      return `<div class="node status-${status} ${tier.className}">
        <div class="node-no">第 ${n} 章</div>
        <div class="node-title">${escapeHtml(chapter.title ?? '')}</div>
        <div class="node-score">${escapeHtml(tier.scoreText)} 分 · ${escapeHtml(tier.label)}</div>
        ${corners ? `<div class="corners">${corners}</div>` : ''}
      </div>`
    }).join('')
    parts.push(`<div class="snake-row${rowIndex % 2 === 1 ? ' reverse' : ''}">${nodes}</div>`)
  })
  return viewPage({ title: '章节地图', projectName: project.name, subtitle: `${chapters.length} 章 · 蛇形排列`, body: parts.join('\n') })
}

/** 按视图名选择渲染函数；未知视图返回 null。 */
export function renderViewHtml(bundle, view) {
  if (view === 'world') return renderWorldHtml(bundle)
  if (view === 'attention') return renderAttentionHtml(bundle)
  if (view === 'timeline') return renderTimelineHtml(bundle)
  if (view === 'map') return renderChapterMapHtml(bundle)
  return null
}

function mountRoute(ctx) {
  ctx.inject(['webServer'], (c) => {
    const webServer = c.webServer
    if (!webServer || typeof webServer.register !== 'function') return
    const connection = c.get?.('connection')
    const disposeApi = webServer.register({
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
    // 只读 HTML 视图：/novel-desk/view/world|timeline|map?projectId=xxx
    const disposeView = webServer.register({
      kind: 'prefix',
      path: VIEW_ROUTE,
      handler: async (req, res) => {
        const rejection = guard(req, connection)
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const sendHtml = (status, html) => {
          res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(html)
        }
        if (req.method !== 'GET') {
          sendHtml(405, viewMessagePage('只支持 GET', '视图是只读页面，用浏览器直接打开。'))
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const view = url.pathname.replace(/^\/novel-desk\/view\/?/, '').replace(/\/+$/, '')
        const projectId = String(url.searchParams.get('projectId') ?? '').trim()
        if (!['world', 'timeline', 'map'].includes(view)) {
          sendHtml(404, viewMessagePage('未知视图', `可用视图：world / timeline / map。示例：${VIEW_ROUTE}/world?projectId=<作品 id>`))
          return
        }
        if (!projectId) {
          sendHtml(400, viewMessagePage('缺少 projectId', `用法：${VIEW_ROUTE}/${view}?projectId=<作品 id>`))
          return
        }
        try {
          const bundle = await getBundle(defaultRoot(), projectId)
          sendHtml(200, renderViewHtml(bundle, view))
        } catch (error) {
          sendHtml(404, viewMessagePage('无法打开视图', error instanceof Error ? error.message : String(error)))
        }
      },
    })
    if (typeof c.effect === 'function') {
      c.effect(() => () => {
        for (const dispose of [disposeApi, disposeView]) {
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            /* 已清理 */
          }
        }
      }, 'novel-desk: api + html views')
    }
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
  description: '读取作品的完整结构：作品设定、写作预设、世界模型与地点、章节列表、事实账本、时间线、伏笔、冲突、人物、高光、注意力（每章 0-100 分 + 四拍）、审稿、待采纳提案、计划对齐、一致性检查。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      kind: { type: 'string', enum: ['summary', 'world', 'locations', 'chapters', 'facts', 'events', 'foreshadow', 'conflicts', 'characters', 'highlights', 'attention', 'presets', 'outlines', 'reviews', 'proposals', 'agents', 'alignment', 'checks'], description: '要看的部分，默认 summary' },
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
      lines.push(`进度：${bundle.stats.chapters} 章 / ${bundle.stats.words} 字 ｜ 地点：${bundle.stats.locations} ｜ 待采纳提案：${bundle.stats.pendingProposals} ｜ 未处理审稿：${bundle.stats.openReviews}`)
      lines.push('', `## 章节（${bundle.chapters.length}）`, ...bundle.chapters.map((c) => `- 第 ${c.id} 章《${c.title}》 ${c.words} 字 ｜ ${c.status}${c.summary ? ` ｜ ${c.summary}` : ''}`))
    }
    if (kind === 'summary' || kind === 'world') {
      const world = bundle.world ?? {}
      lines.push('', '## 世界', `- 名称：${world.name || '未命名'} ｜ 尺度：${world.scale || '—'} ｜ 类型：${world.kind || '—'} ｜ 时代：${world.era || '—'}`)
      lines.push(`- 坐标空间：${world.mapSize?.w ?? 1000} × ${world.mapSize?.h ?? 1000} ｜ 交通：步行 ${world.travelModel?.walkKmPerDay ?? '—'}km/天 / 马 ${world.travelModel?.horseKmPerDay ?? '—'} / 船 ${world.travelModel?.boatKmPerDay ?? '—'} ｜ 地点 ${bundle.stats.locations} 个${bundle.worldSaved ? '' : '（尚未建世界）'}`)
    }
    if (kind === 'summary' || kind === 'locations') {
      lines.push('', `## 地点（${bundle.locations.length}）`, ...bundle.locations.map((loc) => {
        const connections = Array.isArray(loc.connections) ? loc.connections.length : 0
        return `- ${loc.name ?? loc.id} ｜ ${loc.type ?? 'other'} ｜ (${loc.coords?.x ?? '?'}, ${loc.coords?.y ?? '?'}) ｜ 连接 ${connections}${Array.isArray(loc.aliases) && loc.aliases.length > 0 ? ` ｜ 别名：${loc.aliases.join('、')}` : ''}`
      }))
    }
    if (kind === 'summary' || kind === 'checks') {
      lines.push('', `## 一致性检查（${bundle.checks.length}）`, ...bundle.checks.map((c) => `- [${c.level}] ${c.title}：${c.detail}`))
    }
    if (kind === 'summary' || kind === 'alignment') {
      const a = bundle.alignment
      lines.push('', '## 计划对齐', `- 章节：${a.actualChapters} / ${a.plannedChapters || '未设'}（${a.chapterProgress ?? '—'}%）`)
      lines.push(`- 字数：${a.actualWords} / ${a.totalWords || '未设'}（${a.wordProgress ?? '—'}%）｜ 每章目标 ${a.chapterWords || '未设'}`)
      for (const row of a.perChapter) lines.push(`- 第 ${row.id} 章：${row.words} 字（${row.delta === null ? '无目标' : (row.delta >= 0 ? '+' : '') + row.delta}）｜事件 ${row.events}｜事实 ${row.facts}｜待审 ${row.openReviews}`)
      // 版本对齐排在计划对齐之后（计划对齐字段保留不变）
      const versionReport = a.version ?? computeVersionAlignment(bundle)
      if (versionReport) lines.push('', formatVersionAlignment(versionReport))
    }
    if (kind === 'facts') lines.push('', `## 事实账本（${bundle.facts.length}）`, ...bundle.facts.map((f) => `- [第${f.chapter ?? '?'}章] ${f.subject} · ${f.attribute} = ${f.value}`))
    if (kind === 'events') lines.push('', `## 时间线（${bundle.events.length}）`, ...bundle.events.map((e) => `- [第${e.chapter ?? '?'}章 ｜ ${e.storyTime || '时间未填'}] ${e.title}${e.summary ? `：${e.summary}` : ''}`))
    if (kind === 'foreshadow') lines.push('', `## 伏笔（${bundle.foreshadow.length}）`, ...bundle.foreshadow.map((f) => `- ${f.title} ｜ 第${f.setupChapter ?? '?'}章 → 第${f.payoffChapter ?? '?'}章 ｜ ${f.status ?? 'open'}`))
    if (kind === 'conflicts') lines.push('', `## 冲突（${bundle.conflicts.length}）`, ...bundle.conflicts.map((c) => `- ${c.title} ｜ ${c.type ?? ''} ｜ ${c.status ?? 'active'} ｜ 赌注：${c.stakes ?? '—'}`))
    if (kind === 'characters') lines.push('', `## 人物（${bundle.characters.length}）`, ...bundle.characters.map((c) => `- ${c.name} ｜ ${c.role ?? ''} ｜ 目标：${c.goal ?? '—'} ｜ 缺陷：${c.flaw ?? '—'}`))
    if (kind === 'highlights') lines.push('', `## 高光（${bundle.highlights.length}）`, ...bundle.highlights.map((x) => `- [第${x.chapter ?? '?'}章] ${x.text ?? ''}`))
    if (kind === 'attention') lines.push('', `## 注意力（${bundle.attention.length}）`, ...bundle.attention.map((a) => {
      const fixCount = Array.isArray(a.fixLog) ? a.fixLog.length : 0
      const lastDelta = attentionScoreOf(a.lastRecheckDelta)
      return `- 第${a.chapter ?? '?'}章 ｜ ${a.type ?? '未分型'} ｜ 实测 ${a.score ?? '—'} / 设计 ${a.designScore ?? '—'} ｜ ${a.verdict ?? '—'}${a.weakest ? ` ｜ 最弱：${a.weakest}` : ''}${a.breakdown ? ` ｜ 四拍：${attentionBeatLine(a)}` : ''}${Array.isArray(a.dropPoints) && a.dropPoints.length > 0 ? ` ｜ 弃读点 ${a.dropPoints.length} 条` : ''}${a.recheckPending ? ' ｜ ⏳待复测' : ''}${fixCount > 0 ? ` ｜ 补丁 ${fixCount} 条${lastDelta === null ? '' : `（上次 Δ ${lastDelta > 0 ? '+' : ''}${lastDelta}）`}` : ''}${a.cliff ? ` ｜ 章末：${a.cliff}` : ''}`
    }))
    if (kind === 'outlines') lines.push('', `## 章节大纲（${bundle.outlines.length}）`, ...bundle.outlines.slice(0, 60).map((o) => `- 第${o.chapter}章 ${o.title}${o.summary ? `：${String(o.summary).slice(0, 80)}` : ''}`))
    if (kind === 'presets') lines.push('', `## 写作预设（${bundle.presets.length}）`, ...bundle.presets.map((p) => `- ${p.name} ｜ 计划 ${p.plannedChapters ?? '—'} 章 × ${p.chapterWords ?? '—'} 字 ｜ ${p.pov ?? ''} ｜ ${p.tone ?? ''}`))
    if (kind === 'reviews') lines.push('', `## 审稿（${bundle.reviews.length}）`, ...bundle.reviews.map((r) => `- [第${r.chapter ?? '?'}章 ｜ ${r.severity ?? ''} ｜ ${r.dimension ?? ''}] ${r.issue ?? ''} → ${r.suggestion ?? ''}（${r.status ?? 'open'}）`))
    if (kind === 'proposals') lines.push('', `## 提案（${bundle.proposals.length}）`, ...bundle.proposals.map((p) => `- [${p.status}] ${p.kind} · ${p.title}${p.summary ? `：${p.summary}` : ''}`))
    if (kind === 'agents') lines.push('', `## Agent 分工（${bundle.agents.length}）`, ...bundle.agents.map((a) => `- ${a.order}. ${a.name}：${a.duty}${a.special === 'fresh-read' ? '（零上下文首读，勿带账本）' : ''}`))
    return lines.join('\n')
  },
}

const alignTool = {
  name: 'novel_desk_align',
  description: '读或标记「版本对齐」状态（稿本版本 vs 各账本版本）。作者说“对齐账本 / 对齐人物时间线”或你刚补齐账本后用它；op=status 读当前稿本版本与每个账本版本、落后域、缺口；op=mark 表示你刚提交完某几类账本的提案，把那些域标记为“已对齐到当前稿本版本”（提案采纳后作者才能看到内容生效）。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      op: { type: 'string', enum: ['status', 'mark'], description: '操作，默认 status' },
      kinds: { type: 'array', items: { type: 'string' }, description: `op=mark 要标记的账本域，取值同版本对齐域：${ALIGN_KINDS.join('/')}；缺省 = 全部` },
      note: { type: 'string', description: 'op=mark 的备注（例如补了哪几条落差）' },
    },
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args) {
    const project = await requireProject(args?.project)
    const op = String(args?.op ?? 'status')
    const root = defaultRoot()
    // 先把正文文件的 mtime 变化记进稿本版本，再读/标记，避免拿旧版本对比
    await ensureDraftCurrent(root, project.id)
    if (op === 'status') {
      const bundle = await getBundle(root, project.id)
      const report = bundle.alignment?.version ?? computeVersionAlignment(bundle)
      return formatVersionAlignment(report)
    }
    if (op === 'mark') {
      const kinds = normalizeAlignKinds(args?.kinds)
      const marked = await markLedgersAligned(root, project.id, kinds, { note: args?.note })
      const bundle = await getBundle(root, project.id)
      const report = bundle.alignment?.version ?? computeVersionAlignment(bundle)
      return `已标记 ${marked.kinds.length} 个域对齐到稿本 v${marked.version}：${marked.kinds.join('、')}\n\n${formatVersionAlignment(report)}`
    }
    throw new Error(`未知操作：${op}（可选 status/mark）`)
  },
}

const contextTool = {
  name: 'novel_desk_context',
  description: '生成写作上下文：作品设定与写作预设（计划章数/每章字数/结构/风格/禁忌）、世界与地点（尺度/坐标/交通/地点清单/最近章节地点）、12 个 Agent 分工（含权重）、人物卡、事实账本、时间线、未回收伏笔、进行中冲突、注意力（最近 6 章分数/类型、未标章数、平均分）、未处理审稿、待采纳提案、最近章节。写新章或审稿前调用。',
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
    const lines = [`# 写作上下文 · ${bundle.project.name}`, '', `> ${ATTENTION_FIRST_PRINCIPLE}`, '']
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
    // 注意力前置：先看每章是否抓人，再看自洽（写作预设之后、人物/事实之前）
    const attention = attentionStats(bundle)
    lines.push('', '## 注意力（100 分制）')
    lines.push('- 读者第一：先看每章是否抓人，再看自洽。')
    lines.push(`- 全书平均分：${attention.average === null ? '—' : `${attention.average}（${attention.scored.length} 章有实测分）`}`)
    lines.push(`- 未标注意力：${attention.missing} 章已写章节`)
    if (attention.rows.length > 0) {
      const recentAttention = attention.rows.slice(-6)
      lines.push(`- 最近 ${recentAttention.length} 章：`)
      for (const row of recentAttention) {
        const oneLine = String(row.question ?? '').trim()
          || String(row.detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
          || String(row.verdict ?? '').trim()
          || '—'
        lines.push(`  - 第${Number(row.chapter)}章 ${row.score ?? '未标'}分/${row.type ?? '未分型'}｜${oneLine}`)
      }
    }
    // 提分闭环：冷读之后第一件事是提分，不是继续写（用户反馈：方案太少/改完不加分）
    const fixStats = attentionFixStats(bundle)
    const fixCandidates = attentionFixCandidates(bundle)
    if (fixStats.pendingRecheck > 0 || fixStats.verified > 0 || fixStats.pendingFixProposals > 0 || fixCandidates.length > 0) {
      const avgDelta = fixStats.avgDelta === null ? '—' : (fixStats.avgDelta > 0 ? `+${fixStats.avgDelta}` : String(fixStats.avgDelta))
      lines.push(`- 提分闭环：待复测 ${fixStats.pendingRecheck} 章 ｜ 已复测 ${fixStats.verified} 章 ｜ 补丁 ${fixStats.fixCount} 条 ｜ 平均 Δ ${avgDelta} ｜ 待采纳提分方案 ${fixStats.pendingFixProposals} 份`)
      if (fixStats.pendingRecheck > 0) {
        lines.push(`- ⚠ ${fixStats.pendingRecheck} 章采纳补丁后还没复测：先跑 novel_desk_attention_fix(op="recheck")，否则分数与 Δ 不算数。`)
        lines.push('- 复测读完把新发现的问题写成审稿（novel_desk_review，origin="recheck"，全书共性用 chapter=0）：作者在「审稿」页勾选 →「加入清单」→ 生成改动提案；新问题不要只塞进补丁或整章重写。')
      }
      if (fixCandidates.length > 0) {
        const top = fixCandidates.slice(0, 3)
        lines.push(`- 提分空间最大：${top.map((row) => `第${row.chapter}章 +${row.potential}（实测 ${row.score}，最弱 ${ATTENTION_BEAT_LABEL[row.weakest] ?? '—'}）`).join('；')}`)
        lines.push('- 低分章先出段落补丁：novel_desk_attention_fix(op="workorder") → novel_desk_propose(kind="attention-fix")，采纳后自动标记待复测。默认按提分空间取 3 章；要全书用 op="workorder", all=true，要自选章节用 chapters=[...]。')
      }
    }
    // 世界与地点：写场景 / 设计移动前先读，避免出现地图外地点
    const world = bundle.world ?? {}
    lines.push('', '## 世界与地点')
    lines.push(`- 本作类型：${bundle.project.genre || '—'} ｜ 世界：${bundle.worldSaved ? (world.name || '未命名') : '未建'}（尺度 ${world.scale || '—'} / ${world.kind || '—'} / 时代 ${world.era || '—'}）｜ 地点 ${bundle.locations.length} 个`)
    if (bundle.worldSaved) {
      lines.push(`- 坐标空间：${world.mapSize?.w ?? 1000} × ${world.mapSize?.h ?? 1000} ｜ 行程模型：步行 ${world.travelModel?.walkKmPerDay ?? '—'}km/天 / 马 ${world.travelModel?.horseKmPerDay ?? '—'} / 船 ${world.travelModel?.boatKmPerDay ?? '—'}`)
    }
    if (bundle.locations.length > 0) {
      lines.push('- 地点清单：')
      for (const loc of bundle.locations.slice(0, 30)) {
        const aliases = Array.isArray(loc.aliases) && loc.aliases.length > 0 ? ` ｜ 别名：${loc.aliases.join('、')}` : ''
        const connections = Array.isArray(loc.connections) ? loc.connections.length : 0
        lines.push(`  - ${loc.name ?? loc.id}（${loc.type ?? 'other'}）｜ ${loc.region || '—'} ｜ 坐标 (${loc.coords?.x ?? '?'}, ${loc.coords?.y ?? '?'}) ｜ 连接 ${connections}${aliases}`)
      }
      if (bundle.locations.length > 30) lines.push(`  - …另有 ${bundle.locations.length - 30} 个地点`)
    }
    const recentLocatedChapters = bundle.chapters.filter((chapter) => String(chapter.location ?? '').trim()).slice(-6)
    if (recentLocatedChapters.length > 0) {
      lines.push(`- 最近章节地点：${recentLocatedChapters.map((chapter) => `第${Number(chapter.id)}章 ${chapter.location}`).join(' → ')}`)
    }
    if (bundle.agents.length > 0) {
      lines.push('', '## Agent 分工')
      for (const a of bundle.agents) {
        const weight = Number(a.weight)
        const weightText = Number.isFinite(weight) ? `（权重 ${weight}）` : ''
        lines.push(`- ${a.name}${weightText}：${a.duty}${a.special === 'fresh-read' ? '（零上下文首读，勿带账本）' : ''}`)
      }
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
  description: '为「下一章」生成一份精确的工作单：第一优先级是注意力（最近曲线/疲劳预警/目标分/四拍/强制补强），再给目标章号、预设章/字数目标、必须延续的时间线/事实/伏笔/冲突、上一章结尾、以及要求产出的 JSON 结构。作者说“写下一章/补下一章时间线/做下一章大纲”时先调用它，然后按工作单产出内容并调用 novel_desk_propose 提交提案，不要直接改账本。',
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
    const lines = [`# 工作单 · 第 ${chapter} 章`, '', `> ${ATTENTION_FIRST_PRINCIPLE}`, '']
    lines.push(`作品：${bundle.project.name}（${bundle.project.genre || '未填类型'}）`)
    lines.push(`目标：${preset.chapterWords || bundle.project.targetWords || 3000} 字左右；全书计划 ${preset.plannedChapters || bundle.project.targetChapters || '未设'} 章`)
    lines.push(`写作口径：${preset.pov || bundle.project.pov || '—'} / ${preset.tense || bundle.project.tense || '—'} / ${preset.tone || '—'}`)
    lines.push(`风格规则：${Array.isArray(preset.styleRules) ? preset.styleRules.join('；') : '—'}`)
    lines.push(`禁忌：${Array.isArray(preset.taboo) ? preset.taboo.join('；') : '—'}`)

    // ── 第一优先级：注意力（置顶；先定四拍与目标分，再定情节）────────
    const attention = attentionStats(bundle)
    const previousAttention = attention.rows.find((row) => Number(row.chapter) === chapter - 1)
    const previousScore = previousAttention ? attentionNumber(previousAttention.score) : null
    const previousDesign = previousAttention ? attentionNumber(previousAttention.designScore) : null
    const lastThree = attention.rows.slice(-3)
    const lastThreeTypes = lastThree.map((row) => String(row.type ?? '').trim()).filter(Boolean)
    const allSameType = lastThreeTypes.length >= 3 && lastThreeTypes.every((type) => type === lastThreeTypes[0])
    const suggestedType = allSameType
      ? (ATTENTION_TYPE_ORDER.find((type) => type !== lastThreeTypes[0]) ?? 'event')
      : (ATTENTION_TYPE_ORDER.find((type) => !lastThreeTypes.includes(type)) ?? 'event')
    lines.push('', '## 第一优先级：注意力（ATTENTION IS ALL YOU NEED）')
    lines.push('先定本章注意力设计：type/hook/tension/payoff/cliff/question/designScore，再写情节节拍。')
    lines.push('读者第一：怎么吸引读者怎么来；事实自洽是底线，不是目标。')
    lines.push('- 最近 6 章注意力曲线：')
    if (attention.rows.length > 0) {
      for (const row of attention.rows.slice(-6)) lines.push(`  - ${attentionCurveLine(row)}`)
    } else {
      lines.push('  - （还没有注意力记录，本章就是曲线起点）')
    }
    if (allSameType) {
      lines.push(`- 疲劳预警：最近 3 章（${lastThree.map((row) => `第${Number(row.chapter)}章`).join('、')}）都是「${lastThreeTypes[0]}」型，本章必须换 type，建议「${suggestedType}」，否则会触发连续同型疲劳。`)
    } else if (lastThreeTypes.length > 0) {
      lines.push(`- 疲劳预警：最近 3 章类型为 ${lastThreeTypes.join('、')}；本章主类型避免连续同型（同一 type 不得连续超过 3 章），建议「${suggestedType}」。`)
    } else {
      lines.push(`- 疲劳预警：暂无历史类型；本章主类型建议「${suggestedType}」。`)
    }
    const targetLow = previousScore === null ? 70 : Math.min(95, Math.max(60, previousScore + 5))
    const targetHigh = previousScore === null ? 85 : Math.min(98, Math.max(70, previousScore + 15))
    lines.push(`- 本章目标分：designScore 建议 ${targetLow}–${targetHigh}（0–100；全书实测均值 ${attention.average ?? '暂无'}。80+ 必须在四拍里写出依据，禁止轻易给。）`)
    lines.push(`- 主类型建议：${suggestedType}（event|emotion|language|mystery|relationship 里选一个主类型）`)
    lines.push('- 四拍要求（attention 提案与 plan 提案都必须逐项给出，可核对）：')
    lines.push('  - hook：开篇 3 行内抛出的问题/画面')
    lines.push('  - tension：本章承压点——主角失去什么/被逼什么，必须具体')
    lines.push('  - payoff：本章兑现什么（爽点/揭示/情绪释放）')
    lines.push('  - cliff：章末留下的未决问题，一句话能说清')
    lines.push('  - question：读到这里读者最想知道的一句话')
    if (previousAttention) {
      lines.push(`- 上一章注意力：第${previousAttention.chapter}章 ${previousAttention.score ?? '未标'}分/${previousAttention.type ?? '未分型'}；最弱一环：${previousAttention.weakest ?? '—'}；章末问题：${previousAttention.cliff ?? '—'}`)
    }
    // 强制补强：上一章设计没兑现（designScore - score ≥ 20）或明显低于全书均值（< 均值-10）
    const designGap = previousScore !== null && previousDesign !== null ? previousDesign - previousScore : null
    const belowAverage = previousScore !== null && attention.average !== null && previousScore < attention.average - 10
    if ((designGap !== null && designGap >= 20) || belowAverage) {
      const weakest = String(previousAttention?.weakest ?? '').trim()
      const weakestKey = WEAKEST_LABELS[weakest] ? weakest : 'tension'
      const reasons = []
      if (designGap !== null && designGap >= 20) reasons.push(`上一章设计目标 ${previousDesign} 分、冷读实测 ${previousScore} 分，差 ${designGap} 分（≥20，设计没兑现）`)
      if (belowAverage) reasons.push(`上一章实测 ${previousScore} 分低于全书均值 ${attention.average} 分超过 10 分`)
      lines.push('', '## 补强要求（强制）')
      lines.push(`- 触发原因：${reasons.join('；')}。`)
      lines.push(`- 上一章最弱一环：${WEAKEST_LABELS[weakestKey]}（${weakestKey}）；本章必须优先补强：${WEAKEST_REINFORCE[weakestKey]}。`)
      lines.push('- 补强要落到可核对的动作：在 hook/tension/payoff/cliff 至少两拍写清具体段落、人物选择与代价，不能只写“加强节奏/更有张力”。')
    }
    // 提分待办：待复测/待采纳提分方案没处理完，先别拿旧分数写新章
    const planFixStats = attentionFixStats(bundle)
    const planFixProposals = (bundle.proposals ?? []).filter((p) => p?.status === 'pending' && p?.kind === 'attention-fix')
    const planFixCandidates = attentionFixCandidates(bundle)
    if (planFixStats.pendingRecheck > 0 || planFixProposals.length > 0) {
      lines.push('', '## 提分待办（先处理，再写新章）')
      if (planFixStats.pendingRecheck > 0) {
        const pendingChapters = (bundle.attention ?? []).filter((row) => row?.recheckPending === true).map((row) => Number(row.chapter)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
        lines.push(`- 待复测 ${planFixStats.pendingRecheck} 章（${pendingChapters.join('、')}）：采纳补丁后还没重新打分；先跑 novel_desk_attention_fix(op="recheck")，拿到真实分再决定下一章怎么承接。复测读到的新问题用 novel_desk_review（origin="recheck"）落成审稿条目，作者勾选后再出改动提案。`)
      }
      if (planFixProposals.length > 0) lines.push(`- 待采纳提分方案 ${planFixProposals.length} 份：先让作者在提案页采纳/驳回，不要拿旧分数写下一章。`)
      if (planFixCandidates.length > 0) lines.push(`- 提分空间最大：第${planFixCandidates[0].chapter}章 +${planFixCandidates[0].potential}（novel_desk_attention_fix(op="workorder")；全书用 all=true，自选用 chapters=[...]）。`)
    }
    lines.push(`- 设计定好后先提交 novel_desk_propose(kind="attention", chapter=${chapter}, items=[{chapter, type, hook, tension, payoff, cliff, question, designScore, status:"planned"}])；下面的 plan 提案 data.attention 里也要带同一份设计（作者采纳 plan 时会自动补进注意力账本），再产出 plan 提案。`)

    // 之后才是大纲 / 事实 / 时间线 / 伏笔 / 冲突
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
    lines.push('', '## 地点与移动')
    lines.push(`已登记地点：${bundle.locations.length > 0 ? bundle.locations.map((loc) => `${loc.name ?? loc.id}(${loc.coords?.x ?? '?'},${loc.coords?.y ?? '?'})`).join('、') : '（无）'}。`)
    lines.push('涉及移动时优先使用已登记的地点与 connections（距离/天数/交通），不要出现地图外地点；需要新地点时先补 locations 提案。')
    lines.push('', '## 输出要求')
    lines.push('只输出严格 JSON：')
    lines.push('```json')
    lines.push(`{"title":"第 ${chapter} 章标题","summary":"一句话","storyTime":"","location":"","characters":[],"beats":["节拍"],"attention":{"type":"","hook":"","tension":"","payoff":"","cliff":"","question":"","designScore":0,"status":"planned"},"events":[{"title":"","chapter":${chapter},"storyTime":"","location":"","participants":[],"summary":"","consequences":"","importance":"normal"}],"facts":[{"subject":"","attribute":"","value":"","chapter":${chapter},"note":""}],"foreshadow":[{"title":"","setupChapter":${chapter},"payoffChapter":0,"status":"open","note":""}]}`)
    lines.push('```')
    lines.push(`产出后调用 novel_desk_propose(kind="plan", chapter=${chapter}, title=..., data=上面的 JSON)。作者在工作台「提案」页对比后采纳。不要直接调用 novel_desk_upsert 改账本。`)
    return lines.join('\n')
  },
}

const proposeTool = {
  name: 'novel_desk_propose',
  description: '把 AI 生成的内容作为「提案」提交到工作台，等待作者在 UI 里对比采纳。用于下一章方案（kind=plan）、章节正文（kind=chapter）、时间线事件（kind=events）、事实（kind=facts）、人物（kind=characters）、伏笔（kind=foreshadow）、注意力（kind=attention：注意力设计师写 design 字段、独立审稿人写实测字段，按 chapter 合并成同一条记录）、注意力提分方案（kind=attention-fix：段落级 before/after 补丁，采纳后只替换补丁段并标记待复测）、世界（kind=world：单例，data 直接是 world）、地点（kind=locations：条目数组）。如果这是对某条「冲突决策」提案的处理结果，在 data.resolvesProposalId 填原决策 id，工作台会把原决策标记为已修订。采纳动作由作者在 UI 点击完成，提交本身不改账本。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '作品 id 或名称' },
      kind: { type: 'string', enum: ['plan', 'chapter', 'events', 'facts', 'characters', 'foreshadow', 'highlights', 'attention', 'attention-fix', 'world', 'locations', 'custom'], description: '提案类型' },
      chapter: { type: 'integer', minimum: 1, maximum: 999, description: '章号' },
      title: { type: 'string', description: '提案标题' },
      summary: { type: 'string', description: '一句话摘要' },
      data: { type: 'object', description: 'plan/chapter/world 用：完整 JSON（world 单例直接放 world 字段；plan 可带 attention）' },
      items: { type: 'array', description: 'events/facts/characters/foreshadow/highlights/attention/locations 用：条目数组；attention-fix 用：每章 3~12 条 {target,weak,expectedGain(1-15),before(逐字原文 4-600 字),after,why}', items: { type: 'object' } },
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
      resolvesProposalId: args?.data?.resolvesProposalId ?? null,
    })
    const resolves = args?.data?.resolvesProposalId
    return `已提交提案「${proposal.title}」（kind=${proposal.kind}，chapter=${proposal.chapter ?? '—'}）。${resolves ? `\n这份提案关联原决策 ${resolves}，在它被采纳时工作台会把原决策标记为「已修订」。` : ''}\n作者需在工作台「提案」页对比后处理；采纳前不会改动任何账本或正文。`
  },
}

const attentionFixTool = {
  name: 'novel_desk_attention_fix',
  description: '注意力提分闭环工具（打分之后用，不是打分本身）：op=workorder 按提分空间生成「段落级 before/after 补丁」工作单（实测/设计/四拍/弃读点/确定性诊断/正文文件路径/提交格式；正文不贴进 prompt，由 AI 自己 read）；支持单章 chapter=N、自选 chapters=[...]、全书 all=true（超过 3 章自动出批量工作单：章节清单+正文文件路径+逐章协议，不内联正文），让 AI 提交 kind=attention-fix 提案；op=recheck 生成「待复测」章节的零上下文复测工作单（不透露旧分，避免凑分），要求提交 kind=attention 实测记录 + 把复核新发现的问题写成审稿条目（novel_desk_review origin="recheck"，整书共性问题用 chapter=0）+ 仍弱再出 attention-fix；op=scoreboard 读全书提分看板（待复测/已复测 Δ/补丁数/等方案章节）。冷读后提分方案太少、改完不加分时先用它。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      op: { type: 'string', enum: ['workorder', 'recheck', 'scoreboard'], description: '操作，默认 workorder' },
      chapter: { type: 'integer', minimum: 1, maximum: 999, description: '只处理这一章（op=workorder/recheck）' },
      chapters: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 999 }, maxItems: 200, description: '自选章节（按给定顺序；op=workorder/recheck），优先于 chapter/limit' },
      all: { type: 'boolean', description: '处理全部候选章（op=workorder 全部待提分章 / op=recheck 全部待复测章）；章节多时自动出批量工作单' },
      limit: { type: 'integer', minimum: 0, maximum: 200, description: '最多处理几章，默认 3；0=全部' },
    },
    additionalProperties: false,
  },
  output: textOutput,
  async execute(args) {
    const project = await requireProject(args?.project)
    const bundle = await getBundle(defaultRoot(), project.id)
    const op = String(args?.op ?? 'workorder')
    if (op === 'workorder') return attentionFixWorkorder(bundle, { chapter: args?.chapter, chapters: args?.chapters, all: args?.all, limit: args?.limit }, defaultRoot())
    if (op === 'recheck') return attentionRecheckWorkorder(bundle, { chapter: args?.chapter, chapters: args?.chapters, all: args?.all, limit: args?.limit }, defaultRoot())
    if (op === 'scoreboard') return attentionScoreboardText(bundle)
    throw new Error(`未知操作：${op}（可选 workorder/recheck/scoreboard）`)
  },
}

const proposalReadTool = {
  name: 'novel_desk_proposal',
  description: '读取一条提案的完整内容（data/items/feedback），用于按作者已同意的提案执行修改。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '作品 id 或名称' },
      proposalId: { type: 'string', description: '提案 id' },
    },
    additionalProperties: false,
    required: ['proposalId'],
  },
  output: textOutput,
  async execute(args) {
    const project = await requireProject(args?.project)
    const bundle = await getBundle(defaultRoot(), project.id)
    const proposal = (bundle.proposals ?? []).find((row) => row.id === String(args?.proposalId ?? ''))
    if (!proposal) throw new Error(`提案不存在：${args?.proposalId ?? ''}`)
    return JSON.stringify({
      id: proposal.id,
      kind: proposal.kind,
      chapter: proposal.chapter,
      title: proposal.title,
      summary: proposal.summary,
      status: proposal.status,
      data: proposal.data ?? null,
      items: proposal.items ?? [],
      feedback: proposal.feedback ?? [],
    }, null, 2)
  },
}

const REVIEW_ORIGINS = ['cold-read', 'recheck', 'review', 'manual', 'deai']
const REVIEW_SEVERITIES = ['blocker', 'major', 'minor', 'suggestion']
const REVIEW_SEVERITY_ALIAS = { 阻断: 'blocker', 严重: 'major', 一般: 'minor', 建议: 'suggestion' }

/** 审稿去重用的归一化：去掉空白/标点，截到 80 字（同一问题的不同说法仍能对上） */
export function reviewIssueKey(text) {
  return String(text ?? '').replace(/[\s\u3000，。；、：！？…—“”‘’"'「」『』（）()【】\[\]<>《》~·,.;:!?]/g, '').slice(0, 80)
}

function normalizeReviewSeverity(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return 'minor'
  const mapped = REVIEW_SEVERITY_ALIAS[raw] ?? raw
  if (!REVIEW_SEVERITIES.includes(mapped)) {
    throw new Error(`审稿 severity 不认识：${raw}（可选 blocker/major/minor/suggestion，或写 阻断/严重/一般/建议）`)
  }
  return mapped
}

function normalizeReviewOrigin(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return 'review'
  if (!REVIEW_ORIGINS.includes(raw)) {
    throw new Error(`审稿 origin 不认识：${raw}（可选 cold-read/recheck/review/manual/deai）`)
  }
  return raw
}

/** 审稿隔离校验用的归一化：去掉所有空白与常见标点。 */
function normalizeGuardText(text) {
  return String(text ?? '').replace(/[\s\u3000，。；、：！？…—“”‘’"'「」『』（）()【】\[\]<>《》~·,.;:!?]/g, '')
}

/**
 * 其他作品名（含去掉括号副标题、·/／分段后的变体），用于拒绝跨作品对比。
 * 与当前书名互相包含的名字不算（避免《X》与《X 前传》误判）。
 */
function crossWorkNames(projects, currentProject) {
  const current = String(currentProject?.name ?? '').trim()
  const currentId = String(currentProject?.id ?? '')
  const names = new Set()
  for (const row of projects ?? []) {
    if (!row || String(row.id ?? '') === currentId) continue
    const name = String(row.name ?? '').trim()
    if (!name) continue
    const variants = [name, name.split(/[（(]/)[0], ...name.split(/[·・/／]/)]
    for (const raw of variants) {
      const value = String(raw ?? '').trim()
      if (value.length < 3) continue
      if (current && (current.includes(value) || value.includes(current))) continue
      names.add(value)
    }
  }
  return [...names]
}

/**
 * 写审稿条目：支持多章混交、全书级（chapter=0）、来源标记、同章同维度同题去重与重新打开。
 * 复核/冷读新发现的问题先落这里，作者勾选后由审稿页「加入清单」生成改动提案。
 * 隔离校验：禁止跨作品对比（提到其他作品名直接拒收）；去 AI 化审稿（origin=deai）必须带本章逐字 quote。
 */
export async function writeReviewBatch(root, projectId, input = {}) {
  const raw = Array.isArray(input.reviews) ? input.reviews : []
  if (raw.length === 0) throw new Error('没有要写入的审稿意见：reviews 不能为空')
  const bundle = await getBundle(root, projectId)
  const chapterIds = new Set((bundle.chapters ?? []).map((chapter) => Number(chapter.id)))
  const chapterContents = new Map((bundle.chapters ?? []).map((chapter) => [Number(chapter.id), normalizeGuardText(chapter.content)]))
  const otherWorkNames = crossWorkNames(await listProjects(root), bundle.project)
  const existing = Array.isArray(bundle.reviews) ? bundle.reviews.slice() : []
  const indexByKey = new Map()
  for (let i = 0; i < existing.length; i += 1) {
    const row = existing[i]
    if (!row) continue
    const key = `${Number(row.chapter) || 0}|${String(row.dimension ?? '').trim()}|${reviewIssueKey(row.issue)}`
    if (!indexByKey.has(key)) indexByKey.set(key, i)
  }
  const scopeBook = String(input.scope ?? '').trim() === 'book'
  const defaultChapter = input.chapter === undefined || input.chapter === null ? null : Number(input.chapter)
  const defaultOrigin = normalizeReviewOrigin(input.origin)
  const patch = []
  const touchedChapters = new Set()
  let added = 0
  let reopened = 0
  let skipped = 0
  const seen = new Set()
  for (let i = 0; i < raw.length; i += 1) {
    const row = raw[i] ?? {}
    const issue = String(row.issue ?? '').trim()
    if (!issue) throw new Error(`第 ${i + 1} 条审稿没写问题：issue 不能为空`)
    let chapter = row.chapter === undefined || row.chapter === null ? defaultChapter : Number(row.chapter)
    if (chapter === null || chapter === undefined) chapter = scopeBook ? 0 : NaN
    if (!Number.isInteger(chapter) || chapter < 0) {
      throw new Error(`第 ${i + 1} 条审稿没写章号：每条要带 chapter（全书级问题用 chapter=0）`)
    }
    if (chapter > 0 && !chapterIds.has(chapter)) {
      throw new Error(`第 ${chapter} 章不存在：审稿只能写到已有章节（全书级问题用 chapter=0）`)
    }
    const dimension = String(row.dimension ?? '首读').trim() || '首读'
    const severity = normalizeReviewSeverity(row.severity)
    const origin = normalizeReviewOrigin(row.origin ?? defaultOrigin)
    const quote = String(row.quote ?? '').trim().slice(0, 600)
    const suggestion = String(row.suggestion ?? '').trim()
    const guardText = [issue, suggestion, quote, dimension].join('\n')
    const otherWork = otherWorkNames.find((name) => guardText.includes(name))
    if (otherWork) {
      throw new Error(`第 ${i + 1} 条审稿提到了其他作品「${otherWork}」：审稿禁止跨作品/跨工作区对比，只能审《${bundle.project?.name ?? projectId}》。请删掉跨作品内容后重新提交。`)
    }
    if (origin === 'deai' && chapter > 0) {
      const needle = normalizeGuardText(quote)
      if (needle.length < 4) {
        throw new Error(`第 ${i + 1} 条去 AI 化审稿没带 quote：每条必须引用该章正文原文（≥4 字）`)
      }
      const body = chapterContents.get(chapter) ?? ''
      if (!body.includes(needle)) {
        throw new Error(`第 ${i + 1} 条去 AI 化审稿的 quote 不在第 ${chapter} 章正文里：quote 必须逐字摘自本书该章正文（不准跨作品引用）`)
      }
    }
    const key = `${chapter}|${dimension}|${reviewIssueKey(issue)}`
    if (seen.has(key)) { skipped += 1; continue }
    seen.add(key)
    const found = indexByKey.get(key)
    if (found !== undefined) {
      const prev = existing[found]
      if (String(prev?.status ?? 'open') === 'open') { skipped += 1; continue }
      const reopenPatch = {
        id: prev.id,
        status: 'open',
        origin,
        severity,
        suggestion: suggestion || prev.suggestion,
        quote: quote || prev.quote,
        reopenedAt: new Date().toISOString(),
        reopenCount: Number(prev.reopenCount ?? 0) + 1,
        reopenFrom: prev.status,
      }
      patch.push(reopenPatch)
      existing[found] = { ...prev, ...reopenPatch }
      reopened += 1
      touchedChapters.add(chapter)
      continue
    }
    const created = {
      chapter,
      dimension,
      severity,
      issue,
      suggestion,
      origin,
      source: 'ai',
      status: 'open',
    }
    if (quote) created.quote = quote
    patch.push(created)
    indexByKey.set(key, existing.length)
    existing.push(created)
    added += 1
    touchedChapters.add(chapter)
  }
  for (const row of patch) {
    await upsertEntity(root, projectId, 'reviews', row)
  }
  const chapters = [...touchedChapters].sort((a, b) => a - b).map((n) => (n === 0 ? '全书' : `第${n}章`)).join('、')
  const parts = [`新增 ${added} 条 / 重新打开 ${reopened} 条 / 跳过重复 ${skipped} 条`]
  if (chapters) parts.push(`（${chapters}）`)
  return `已写入审稿：${parts.join('')}。作者可在「审稿」页勾选 →「加入清单」→ 生成修订提案（注意力/节奏类会合并成段落补丁方案）。复核新发现的问题不再只能直接改正文。`
}

const reviewTool = {
  name: 'novel_desk_review',
  description: '提交审稿意见（写入工作台「审稿」）。支持一次交多章、全书级问题（chapter=0）、来源标记（origin=cold-read/recheck/review/manual/deai）；同章同维度同题自动去重，已归档的会自动重新打开。复核/冷读新发现的问题先落这里，作者在「审稿」页勾选→加入清单→生成改动提案。审稿禁止跨作品/跨工作区对比（提到其他作品名会被拒收）；origin=deai 的每条必须带本章正文逐字 quote。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '作品 id 或名称' },
      chapter: { type: 'integer', minimum: 0, maximum: 999, description: '默认章号；每条 reviews[].chapter 可覆盖；0=全书级问题' },
      scope: { type: 'string', enum: ['chapter', 'book'], description: 'book=本书级（默认找 chapter=0）' },
      origin: { type: 'string', enum: ['cold-read', 'recheck', 'review', 'manual', 'deai'], description: '来源：冷读/复核/审阅/人工/去AI化；默认 review' },
      reviews: {
        type: 'array',
        description: '审稿意见数组',
        items: {
          type: 'object',
          properties: {
            chapter: { type: 'integer', minimum: 0, maximum: 999, description: '章号；0=全书级' },
            dimension: { type: 'string', description: '情节/人物/文笔/连续性/节奏/对话/世界观/主题/首读' },
            severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'suggestion'] },
            issue: { type: 'string', description: '问题是什么（复核时带上原文引文）' },
            suggestion: { type: 'string', description: '改哪段、怎么改' },
            quote: { type: 'string', description: '原文引文（选填，最多 600 字）' },
            origin: { type: 'string', enum: ['cold-read', 'recheck', 'review', 'manual', 'deai'] },
          },
        },
      },
    },
    additionalProperties: false,
    required: ['reviews'],
  },
  output: textOutput,
  async execute(args) {
    const project = await requireProject(args?.project)
    return writeReviewBatch(defaultRoot(), project.id, args ?? {})
  },
}

const upsertTool = {
  name: 'novel_desk_upsert',
  description: '直接写入工作台数据（仅在作者明确要求“直接改”时使用）：章节/事实/事件/伏笔/冲突/人物/高光/注意力/地点/预设/审稿/分工。AI 生成的内容应优先用 novel_desk_propose 提交提案。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '作品 id 或名称；kind=project 时省略' },
      kind: { type: 'string', enum: ['project', 'chapter', 'facts', 'events', 'foreshadow', 'conflicts', 'characters', 'highlights', 'attention', 'locations', 'presets', 'reviews', 'agents'], description: '数据类型' },
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

function createRevisionTool(ctx) {
  return {
    name: 'novel_desk_revision',
    description: '全文改动执行工具（goal 中的 AI 使用，不是作者用）：op=status 读状态；op=plan 出方案；op=start 开始；op=stage 上报批次进度；op=apply 提交单章改写（自动留备份并跑双闸门）；op=pause 暂停等待作者；op=finish 完成；op=stuck 卡住说明原因。L1=只换文风（事件/专名/数字/钩子全冻结），L3=价值观改动（必须先立价值基准再逐章级联，逐章停）。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
        op: { type: 'string', enum: ['status', 'plan', 'start', 'stage', 'apply', 'pause', 'finish', 'stuck'], description: '操作' },
        data: { type: 'object', description: 'op=plan：{tiers,batchSize,stopMode,goal,charter}；op=start：{batchSize,stopMode}（开始前重排批次，按章保留进度）；op=stage：{batchIndex,status,note}' },
        chapter: { type: 'string', description: 'op=apply：章号' },
        content: { type: 'string', description: 'op=apply：改写后的完整正文' },
        note: { type: 'string', description: '进度说明 / 卡住原因' },
        reason: { type: 'string', description: 'op=stuck：卡住原因' },
      },
      additionalProperties: false,
      required: ['op'],
    },
    output: textOutput,
    async execute(args) {
      const project = await requireProject(args?.project)
      const op = String(args?.op ?? 'status')
      const root = defaultRoot()
      if (op === 'status') return revisionSummaryText(await getRevision(root, project.id))
      if (op === 'plan') {
        const data = args?.data && typeof args.data === 'object' ? args.data : {}
        const result = await planRevisionRun(root, project.id, {
          tier: data.tier, chapters: data.chapters, goal: data.goal, charter: data.charter,
          batchSize: data.batchSize,
        })
        return revisionSummaryText(result.revision)
      }
      if (op === 'start') {
        const data = args?.data && typeof args.data === 'object' ? args.data : {}
        const result = await startRevisionRun(root, project.id, ctx, data)
        return `已开始改动（会话 ${result.sessionId}）。\n\n${revisionSummaryText(result.revision)}`
      }
      if (op === 'stage') {
        const data = args?.data && typeof args.data === 'object' ? args.data : {}
        return revisionSummaryText(await advanceRevision(root, project.id, data))
      }
      if (op === 'apply') {
        const result = await applyRevisionChapter(root, project.id, { chapter: args?.chapter, content: args?.content })
        const { fidelity, style } = result
        return [
          `第${args?.chapter}章已写入（原稿已备份${result.backup ? '' : '：无变化'}）。`,
          `保真闸门：${fidelity.hit}/${fidelity.total}${fidelity.pass ? ' 通过' : ' 未通过'}`,
          ...(fidelity.missing ?? []).map((item) => `  - 缺 ${item.type}: ${item.value}`),
          `风格闸门：微动作帧 ${style.before.microFramesPer10k} → ${style.after.microFramesPer10k} ｜ 情绪词 ${style.before.emotionPer10k} → ${style.after.emotionPer10k}`,
          `Markdown 残留：${result.md?.total ?? 0} 处${(result.md?.total ?? 0) > 0 ? '（必须清零）' : ''}`,
        ].join('\n')
      }
      if (op === 'pause') {
        const current = await getRevision(root, project.id)
        const saved = await saveRevision(root, project.id, {
          status: 'paused',
          notes: [...(current.notes ?? []), { at: new Date().toISOString(), text: String(args?.note ?? '等待作者确认') }],
        })
        return revisionSummaryText(saved)
      }
      if (op === 'finish') {
        const saved = await saveRevision(root, project.id, {
          status: 'done',
          ...(args?.note ? { notes: [...((await getRevision(root, project.id)).notes ?? []), { at: new Date().toISOString(), text: String(args.note) }] } : {}),
        })
        return revisionSummaryText(saved)
      }
      if (op === 'stuck') {
        const current = await getRevision(root, project.id)
        const saved = await saveRevision(root, project.id, {
          status: 'stuck',
          notes: [...(current.notes ?? []), { at: new Date().toISOString(), text: `卡住：${String(args?.reason ?? args?.note ?? '未说明')}` }],
        })
        return revisionSummaryText(saved)
      }
      throw new Error(`未知操作：${op}`)
    },
  }
}

/** 去 AI 化审阅工具：作者提「去AI化审核」时优先走这里，强制新建独立空会话 + 隔离工作区。 */
function createDeaiReviewTool(ctx) {
  return {
    name: 'novel_desk_deai_review',
    description: '去 AI 化审阅（作者说「去AI化审核/审阅/机器味重」时先调用本工具，不要在当前对话里直接审）。会新建独立空会话 + 隔离工作区（只含本书章节正文副本），工作单写死硬边界：禁止读其他作品/历史报告，禁止跨作品对比与「人类对照」。op=start 直接启动；op=workorder 只返回工作单全文，供预览。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
        op: { type: 'string', enum: ['start', 'workorder'], description: 'start=新建隔离会话并启动审阅（默认）；workorder=只返回工作单' },
      },
      additionalProperties: false,
      required: ['op'],
    },
    output: textOutput,
    async execute(args) {
      const project = await requireProject(args?.project)
      const op = String(args?.op ?? 'start')
      if (op !== 'start' && op !== 'workorder') throw new Error(`未知操作：${op}（可选 start/workorder）`)
      const result = await startDeaiReview(defaultRoot(), project.id, ctx, { dryRun: op === 'workorder' })
      if (op === 'workorder') return result.prompt
      return [
        '已新建「去 AI 化审阅」独立会话：零上下文，只审本书。',
        `- sessionId：${result.sessionId}`,
        `- 隔离工作区：${result.workspacePath}（只含本书 ${result.chapterCount} 章正文副本，没有历史报告/其他作品）`,
        `- 当前机器痕迹：${result.summary.split('\n').join('；')}`,
        '',
        '硬性边界：禁止跨作品/跨工作区对比；只读工作单「章节文件清单」里的文件；只提交 novel_desk_review(origin="deai")，不改正文。',
        `作者人工复检 AI 痕迹：${DEAI_AUDIT_URL}`,
      ].join('\n')
    },
  }
}

function createPipelineTool(ctx) {
  return {
  name: 'novel_desk_pipeline',
  description: '生成整本书流水线的进度上报工具（goal 中的 AI 使用，不是作者用）：op=status 读当前阶段/目标/预算/收尾报告；op=stage 上报某阶段 running/done；op=finish 全部完成（会自动收尾清理）；op=finalize 手动收尾（采纳账本提案、驳回过期章节、归档审阅）；op=stuck 卡住并说明原因。每完成一步就上报，工作台页面据此显示进度。',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
      op: { type: 'string', enum: ['status', 'stage', 'finish', 'finalize', 'stuck'], description: '操作' },
      stageId: { type: 'string', description: '阶段 id（op=stage 时必填，如 write-1/review-1/fix-1/final-cleanup）' },
      status: { type: 'string', enum: ['running', 'done'], description: '阶段状态（op=stage）' },
      note: { type: 'string', description: '进度说明 / 完成说明' },
      reason: { type: 'string', description: '卡住原因（op=stuck）' },
      scope: { type: 'string', enum: ['all', 'run'], description: 'op=finalize：清理范围（all=整个项目，run=只清理本次 run 提案）' },
    },
    additionalProperties: false,
    required: ['op'],
  },
  output: textOutput,
  async execute(args) {
    const project = await requireProject(args?.project)
    const op = String(args?.op ?? 'status')
    const root = defaultRoot()
    if (op === 'status') return pipelineSummaryText(await getPipeline(root, project.id))
    if (op === 'stage') {
      const result = await advancePipeline(root, project.id, { stageId: args?.stageId, status: args?.status, note: args?.note }, ctx)
      const warning = result.warning ? '\n\n⚠️ 预算已用超过 80%，请准备收尾或暂停。' : ''
      return `${pipelineSummaryText(result.pipeline)}${warning}`
    }
    if (op === 'finish') return pipelineSummaryText(await finishPipeline(root, project.id, String(args?.note ?? '')))
    if (op === 'finalize') {
      const cleaned = await finalizePipelineCleanup(root, project.id, { scope: args?.scope === 'run' ? 'run' : 'all' })
      const { pipeline: cleanedPipeline, ...cleanupReport } = cleaned
      const failed = Array.isArray(cleanupReport.failed) && cleanupReport.failed.length > 0 ? `\n- 失败：${cleanupReport.failed.length} 条` : ''
      return `${pipelineSummaryText(cleanedPipeline)}\n\n## 收尾报告\n- 采纳提案：${cleanupReport.acceptedProposals} 条\n- 驳回过期章节提案：${cleanupReport.rejectedChapter} 条\n- 归档审阅：${cleanupReport.closedReviews} 条${failed}`
    }
    if (op === 'stuck') return pipelineSummaryText(await stuckPipeline(root, project.id, String(args?.reason ?? '')))
    throw new Error(`未知操作：${op}（可选 status/stage/finish/finalize/stuck）`)
  },
  }
}

function createExpansionTool(ctx) {
  return {
    name: 'novel_desk_expansion',
    description: '扩写进度与方案上报工具（goal 中的 AI 使用，不是作者用）：op=status 读状态；op=plan 写入宏观方案（status=plan-ready）；op=outline-change 提交大纲变更提案并进入 waiting-outline；op=wait-outline 停下等待作者确认；op=stage 上报执行进度；op=finish 全部完成；op=stuck 卡住并说明原因。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '作品 id 或名称；只有一部时可省略' },
        op: { type: 'string', enum: ['status', 'plan', 'outline-change', 'wait-outline', 'stage', 'finish', 'stuck'], description: '操作' },
        data: { type: 'object', description: 'op=plan 用：diagnosis/capacity/chapterTargets/outlineChanges/notes' },
        items: { type: 'array', description: 'op=outline-change 用：大纲变更条目数组', items: { type: 'object' } },
        stageId: { type: 'string', description: '执行阶段/批次标识（op=stage，可选）' },
        status: { type: 'string', description: 'op=stage：running|done|paused|stuck 等' },
        note: { type: 'string', description: '进度说明 / 完成说明' },
        reason: { type: 'string', description: '等待/卡住原因（op=wait-outline / stuck）' },
      },
      additionalProperties: false,
      required: ['op'],
    },
    output: textOutput,
    async execute(args) {
      const project = await requireProject(args?.project)
      const op = String(args?.op ?? 'status')
      const root = defaultRoot()
      const current = await getExpansion(root, project.id)
      if (op === 'status') return expansionSummaryText(current)
      if (op === 'plan') {
        const data = args?.data && typeof args.data === 'object' ? args.data : {}
        const patch = {
          status: 'plan-ready',
          plan: {
            diagnosis: Array.isArray(data.diagnosis) ? data.diagnosis : current.plan.diagnosis,
            capacity: Array.isArray(data.capacity) ? data.capacity : current.plan.capacity,
            outlineChanges: Array.isArray(data.outlineChanges) ? data.outlineChanges : current.plan.outlineChanges,
            confirmations: Array.isArray(data.confirmations) ? data.confirmations : (current.plan.confirmations ?? []),
            notes: Array.isArray(data.notes) ? data.notes : current.plan.notes,
          },
          notes: expansionPushNote(current, 'AI 提交宏观扩写方案，等待作者确认'),
        }
        if (Array.isArray(data.chapterTargets)) patch.chapterTargets = sanitizeChapterTargets(data.chapterTargets)
        if (Array.isArray(data.outlineChanges)) patch.outlineChanges = data.outlineChanges
        return expansionSummaryText(await saveExpansion(root, project.id, patch))
      }
      if (op === 'outline-change') {
        const items = Array.isArray(args?.items) ? args.items : []
        if (items.length === 0) throw new Error('缺少大纲变更条目 items')
        const proposal = await createProposal(root, project.id, {
          kind: 'outlines',
          chapter: Number(items[0]?.chapter) || null,
          title: '扩写大纲变更（待确认）',
          summary: `扩写需要 ${items.length} 条大纲变更，等待作者确认`,
          items,
          data: { expansionRunId: current.runId },
        })
        const outlineChanges = [
          ...current.outlineChanges,
          ...items.map((item, index) => ({
            id: item.id ?? `outline-change-${index + 1}`,
            chapter: Number(item.chapter) || 0,
            title: item.title ?? '',
            summary: item.summary ?? '',
            proposalId: proposal.id,
          })),
        ]
        const saved = await saveExpansion(root, project.id, {
          status: 'waiting-outline',
          outlineChanges,
          notes: expansionPushNote(current, `提交 ${items.length} 条大纲变更提案，等待作者确认`),
        })
        return `${expansionSummaryText(saved)}\n\n⏸ 已进入 waiting-outline：等待作者在提案页确认（expansion.approveOutline 后自动续跑）。`
      }
      if (op === 'wait-outline') {
        const reason = String(args?.reason ?? args?.note ?? '').trim()
        const saved = await saveExpansion(root, project.id, {
          status: 'waiting-outline',
          notes: expansionPushNote(current, reason ? `停下等待大纲确认：${reason}` : '停下等待大纲确认'),
        })
        return expansionSummaryText(saved)
      }
      if (op === 'stage') {
        const result = await advanceExpansion(root, project.id, { stageId: args?.stageId, status: args?.status, note: args?.note }, ctx)
        const warning = result.warning ? '\n\n⚠️ 预算已用超过 80%，请准备收尾或暂停。' : ''
        return `${expansionSummaryText(result.expansion)}${warning}`
      }
      if (op === 'finish') {
        const bundle = await getBundle(root, project.id)
        const chapters = bundle.chapters ?? []
        const totalWords = chapters.reduce((sum, chapter) => sum + (Number(chapter.words) || String(chapter.content ?? '').replace(/\s/g, '').length), 0)
        const scored = (bundle.attention ?? []).filter((row) => row.score !== null && row.score !== undefined && row.score !== '' && Number.isFinite(Number(row.score)))
        const attention = scored.length > 0 ? Math.round(scored.reduce((sum, row) => sum + Number(row.score), 0) / scored.length) : null
        const additions = (current.chapterTargets ?? []).flatMap((row) => (Array.isArray(row.additions) ? row.additions.map((item) => `第${row.chapter}章：${item}`) : []))
        const report = {
          totalWords,
          chapters: chapters.length,
          attention,
          additions,
          outlineChanges: (current.approvedOutlineChanges ?? []).map((row) => row.title ?? row.proposalId ?? '大纲变更'),
          completedAt: new Date().toISOString(),
        }
        const saved = await saveExpansion(root, project.id, {
          status: 'done',
          report,
          notes: expansionPushNote(current, args?.note ? `完成：${args.note}` : '全部扩写完成'),
        })
        return expansionSummaryText(saved)
      }
      if (op === 'stuck') {
        const reason = String(args?.reason ?? args?.note ?? '').trim()
        const saved = await saveExpansion(root, project.id, {
          status: 'stuck',
          notes: expansionPushNote(current, reason ? `卡住：${reason}` : '卡住，等待手动恢复'),
        })
        return expansionSummaryText(saved)
      }
      throw new Error(`未知操作：${op}（可选 status/plan/outline-change/wait-outline/stage/finish/stuck）`)
    },
  }
}

export function apply(ctx) {
  mountRoute(ctx)
  ctx.tools.register(projectsTool)
  ctx.tools.register(bundleTool)
  ctx.tools.register(alignTool)
  ctx.tools.register(contextTool)
  ctx.tools.register(planTool)
  ctx.tools.register(proposalReadTool)
  ctx.tools.register(proposeTool)
  ctx.tools.register(attentionFixTool)
  ctx.tools.register(reviewTool)
  ctx.tools.register(createDeaiReviewTool(ctx))
  ctx.tools.register(upsertTool)
  ctx.tools.register(createPipelineTool(ctx))
  ctx.tools.register(createExpansionTool(ctx))
  ctx.tools.register(createRevisionTool(ctx))
}
