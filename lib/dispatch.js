/**
 * 派单票据（强制子 agent 派单，方案 B）。
 *
 * 主对话必须先调用 novel_desk_dispatch(role, task) 拿到 dispatchId，
 * 把返回的提示交给对应子 agent；子 agent 提交 AI 意见 / 冷读结果时必须带 dispatchId。
 * 服务端校验：票据存在、角色匹配、项目匹配、未过期、未被作废；用后可标记 consumed。
 */

import { randomUUID } from 'node:crypto'

const TTL_MS = 30 * 60 * 1000
const tickets = new Map()

export function issueTicket({ role, projectId = '', task = '' } = {}) {
  const id = `dp_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const ticket = {
    id,
    role: String(role || ''),
    projectId: String(projectId || ''),
    task: String(task || ''),
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
    submissions: 0,
  }
  tickets.set(id, ticket)
  return ticket
}

export function getTicket(id) {
  const ticket = tickets.get(String(id || ''))
  if (!ticket) return null
  if (Date.now() > ticket.expiresAt) {
    tickets.delete(ticket.id)
    return null
  }
  return ticket
}

export function requireTicket(id, { role = '', projectId = '', consume = false } = {}) {
  const ticket = getTicket(id)
  if (!ticket) throw new Error('派单票据无效或已过期：请先调用 novel_desk_dispatch 取得 dispatchId，再由子 agent 提交。')
  if (role && ticket.role !== role) throw new Error(`派单票据角色不符：票据是 ${ticket.role}，本次提交需要 ${role}；请为每个角色单独派单。`)
  if (projectId && ticket.projectId && ticket.projectId !== String(projectId)) throw new Error('派单票据属于另一部作品，拒绝提交。')
  if (consume) ticket.submissions += 1
  return ticket
}

/** 生成给主对话的派单提示（含子 agent 可直接执行的任务书）。 */
export function dispatchPrompt({ ticket, roleInfo, task = '', materials = '' } = {}) {
  const lines = [
    `【派单】角色：${roleInfo?.name || ticket.role}（${ticket.role}） ｜ dispatchId=${ticket.id}`,
    roleInfo ? `职责：${roleInfo.duty}` : '',
    roleInfo ? `只允许使用：${roleInfo.inputs}；输出上限：${roleInfo.limit}` : '',
    task ? `任务：${task}` : '',
    materials ? `材料：${materials}` : '',
    '',
    '执行要求：',
    `1. 用宿主 subagent 工具按上面的角色单独起一个子 agent；把本派单提示 + 材料交给它。`,
    '2. 子 agent 交结果时用任务书指定的工具：',
    '   - 找问题/审稿：novel_desk_problems(op="submit", projectId, problems=[{type, scope, chapter, quote, severity, text, drafts:[...]}], highlights=[...])',
    '   - 继续改：novel_desk_problems(op="revise", projectId, revisions=[{problemId, drafts:[...]}])',
    '   - 账本/全文提案：novel_desk_propose（按任务书）',
    '3. 主对话（编辑）只验收子 agent 返回结果：地址合法、整段成文、条数/字数不超限；不自己改正文。',
    '4. 票据 30 分钟内有效；一个角色一张票，不要跨角色复用。',
  ]
  return lines.filter(Boolean).join('\n')
}
