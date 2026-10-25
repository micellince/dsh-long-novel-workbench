/**
 * 0.7 角色：像真实出版流程的 7 个角色。
 *
 * 规则（作者定的）：
 *  - 每次派单必须指定角色，由**子 agent** 完成；主对话（编辑）只负责派单与验收；
 *  - 子 agent 只拿自己需要的材料（段落切片 / 可疑点 / 整章纯文本），不读全书；
 *  - 输出有硬上限（条数、字数），超了服务端拒收。
 */

export const ROLES = [
  {
    id: 'editor',
    name: '编辑',
    duty: '主对话角色：派单、验收 schema 与地址、汇总审阅结论、向作者汇报。不重读正文、不读全量账本。',
    inputs: '作者意图 + 各子 agent 返回',
    outputs: '结构化结论 / 修订单',
    limit: '只汇总，不产成文',
    when: '每次派单与验收',
  },
  {
    id: 'publisher',
    name: '出版人',
    duty: '通读作品与预设，给全文写作 / 全文改写定调（题材、读者、爽点密度、商业定位）。',
    inputs: '全书简报（章数/字数/预设/账本摘要）',
    outputs: '定调简报（≤300 字）',
    limit: '≤300 字',
    when: '全文写作 / 全文改写前',
  },
  {
    id: 'author',
    name: '作者',
    duty: '写全文、改全文、扩写正文。',
    inputs: '出版人定调 + 大纲 + 账本摘要 + 目标章',
    outputs: '成文正文（纯文本）',
    limit: '按章',
    when: '写/改全文',
  },
  {
    id: 'stylist',
    name: '文笔文风优化师',
    duty: '句感、对话、叙述、节奏优化；可对指定段落或全文做文笔优化，不改情节与事实。',
    inputs: '选中段落切片（或全文范围）+ 预设风格摘要',
    outputs: '{para, after 整段成文}',
    limit: '每条只改一段',
    when: '文风 / 语感 / 对话 / 节奏问题',
  },
  {
    id: 'continuity',
    name: '事实逻辑设计师',
    duty: '维护账本数据库；首次建账；判定程序筛出的可疑点；必要时做宏观一致性对比。',
    inputs: '可疑点 + 相关事实一条（或 DB 摘要）',
    outputs: '事实修订 / {para, after} / 判定说明',
    limit: '只判可疑点；全书体检需作者明确要求',
    when: '事实/时间/地点/称谓/连续性',
  },
  {
    id: 'cold-reader',
    name: '冷读审稿人',
    duty: '注意力唯一来源：零上下文通读一章，只回答“读者会不会继续读”。',
    inputs: '整章纯文本（不带旧分、账本、大纲）',
    outputs: 'score + verdict + points（地址评价，亮点/不足）',
    limit: 'comment ≤80 字；亮点宁缺毋滥',
    when: '冷读 / 注意力打分',
  },
  {
    id: 'ai-auditor',
    name: '审核 AI 化的 AI',
    duty: '去机器味：本地指标筛出标记段落，再给去 AI 化改法。',
    inputs: '被标记段落切片 + 写作预设摘要',
    outputs: '{para, after 整段成文}',
    limit: '每条只改一段',
    when: 'AI 味 / 模板句 / 机械动作',
  },
]

export const ROLE_BY_ID = Object.fromEntries(ROLES.map((role) => [role.id, role]))

/** 四路审阅 → 角色。 */
export function roleForSource(source) {
  const key = String(source ?? '')
  if (key === 'logic') return ROLE_BY_ID.continuity
  if (key === 'attention') return ROLE_BY_ID['cold-reader']
  if (key === 'ai-style') return ROLE_BY_ID['ai-auditor']
  if (key === 'reader') return ROLE_BY_ID.stylist
  return ROLE_BY_ID.editor
}

/** 工作单里的角色段：指定子 agent + 只给材料 + 输出上限。 */
export function roleBriefLines(role, { task = '' } = {}) {
  const r = typeof role === 'string' ? ROLE_BY_ID[role] : role
  if (!r) return []
  return [
    `## 本次派给子 agent：${r.name}（${r.id}）`,
    `- 职责：${r.duty}`,
    `- 只允许使用：${r.inputs}`,
    `- 输出：${r.outputs}；上限：${r.limit}`,
    task ? `- 本次任务：${task}` : '',
    '- 主对话（编辑）只验收返回结果（地址是否合法、字数是否超限、是否越界改），不重读正文、不转述材料。',
    '- 子 agent 没拿到材料就停下说明，不要编造正文。',
  ].filter(Boolean)
}
