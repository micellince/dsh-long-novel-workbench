# EXPANSION · 扩写（全文扩写 / 单章扩写）设计 v1

> 一句话：**把已有正文按用户设定的目标字数写厚**。目标必须由用户填写（没有默认值），大纲是硬边界；需要动大纲必须先向用户说明并获确认；执行全自动，结果自动采纳但**保留原稿备份**。
> 定位：插件级能力，不绑定任何具体作品、不预设任何字数；扩写是「📚 整本书」下面的独立模块。

---

## 1. 非目标

- 不做压缩/精简（只增不减）；
- 不默认任何目标字数、不提供比例模式、不引入容差；
- 不自动改动大纲（必须用户确认）；
- 不把扩写当"文字润色"：小差距才允许只丰富文字，大差距必须加内容并落账。

---

## 2. 两种模式（两个按钮）

| 模式 | 按钮 | 作用 |
|---|---|---|
| `book` | **全部扩写** | 按方案扩整本（或当前选定的全书范围） |
| `chapter` | **扩写本章** | 只扩当前章 |

两种模式共用同一套：目标字数 → AI 宏观方案 → 大纲变更闸门 → 全自动执行 → 批量审阅/修订 → 总检。
与「生成全文」同构：一个 goal、一个会话、自动推进，工作台只显示进度/预算并提供暂停/恢复。

---

## 3. 配置（向导，必填项）

- **模式**：全部扩写 / 扩写本章；
- **目标字数**：**必填，无默认值**。全局模式填"每章目标字数"，方案出来后逐章目标表允许**单独修改**（覆盖全局值）；单章模式填本章目标；
- **允许新增**：旁线 / 新人物 / 新地点 / 新伏笔 / 新冲突（开关 + 上限），**默认关**；
- **样张**（可选）：先扩 1–3 章确认风格；
- **预算**：token / 费用上限（0=不限），80% 预警、100% 自动暂停；
- **大纲变更**：默认"不允许"；开启后也需要逐项确认，不存在"默认同意"。

---

## 4. 三步流程

### 4.1 第一步：AI 出宏观方案（可多轮讨论）

输入：范围数据、每章现有**大纲节拍**、当前字数、人物/地点/事实/伏笔/注意力曲线。
输出（存 `expansion.json.plan`，并在对话框里可继续改）：

1. **诊断**：每章当前字数、大纲节拍数、目标差距；
2. **大纲容量评估**：按现有节拍判断"这章最多能自然写到多少字"，标出 `可达 / 超出容量`；
3. **逐章方案**：目标字数、扩写类型 `enrich | scene | structure`、加什么、预计增量、是否触碰主线；
4. **大纲变更清单**（仅当需要）：加/改哪些节拍、影响哪些章；
5. 预计 token、样张建议。

用户点「确认方案」后进入执行。方案确认 ≠ 大纲变更确认：涉及大纲的条目在第二步单独向用户说明并等待确认。

### 4.2 第二步：补地基（仅在有大纲变更时）

- 按已确认的大纲变更补：新人物/关系、新地点（坐标+连接）、新事实、新冲突、新伏笔（埋设/回收章）、大纲节拍（`subplotId`）、扩写章注意力目标分；
- 全部走提案；**动大纲前必须先把大纲变更提案给用户看**（状态 `waiting-outline`，页面横幅 + 提案页）；
- 用户确认后自动续跑；不确认则只按大纲内可达字数扩；
- 跑一致性/空间/伏笔检查，缺兜底不写正文。

### 4.3 第三步：扩写（全自动）

- 每章 prompt 写死：本章**现有大纲节拍（锁定）** + 目标字数 + 扩写类型 + 允许新增内容（含已批准的大纲变更）+ 风格规则 + 前后章摘要；
- 硬规则：
  - 不得引入大纲/已批准变更之外的情节、人物、设定；
  - 主线节拍一条不动，章末钩子保留；
  - 原文关键场景不丢，风格/POV 不漂移；
  - 达到目标字数；达不到就报告上限，禁止注水；
  - 新增内容必须有后果（新事件/冲突/关系/信息），纯描写与复述有上限；
  - 扩写后冷读分不得低于扩写前；
- 每批（卷或 N 章）审一次、修一次；全部卷后总检（重复、节奏、旁线回收、总字数、大纲一致性），新增内容回写账本/时间线。

---

## 5. 大纲是硬边界

| 类型 | 含义 | 门禁 |
|---|---|---|
| 大纲内扩写 | 把已有节拍写透/加场景 | 确认方案即可 |
| 大纲外扩写 | 新增节拍/旁线/人物/地点 | **必须单独确认大纲变更**，否则禁止 |

- 目标超出大纲容量时，AI 必须报告"最多到 X 字"并给出大纲变更方案，不许硬凑；
- 已批准的大纲变更写入 `approvedOutlineChanges`，执行时只允许这部分。

---

## 6. 数据 `expansion.json`（单例，不进 KINDS）

```jsonc
{
  "id": "expansion",
  "status": "idle|planning|plan-ready|waiting-outline|structuring|running|paused|done|stuck",
  "mode": "book|chapter",
  "scope": { "type": "book|chapter", "chapters": [1,2] },
  "targetWords": 2000,                 // 必填，无默认
  "chapterTargets": [
    { "chapter": 1, "targetWords": 2000, "type": "scene", "additions": [], "outlineChangeIds": [] }
  ],
  "plan": { "diagnosis": [], "capacity": [], "outlineChanges": [], "notes": [] },
  "outlineChanges": [],
  "approvedOutlineChanges": [],
  "runId": "exp-...",
  "sessionId": "",
  "budget": { "maxTokens": 0, "maxCostCNY": 0, "usedTokens": 0, "usedCostCNY": 0, "baseline": null },
  "notes": [],
  "createdAt": "", "updatedAt": ""
}
```

- 扩写提案：`kind='chapter'`，`data.expansionRunId`、`data.expansion={targetWords, delta, addedScenes[], subplotIds[], beatsPreserved}`；
- 方案提案：`kind='custom'`（标题「扩写方案」）；
- 大纲变更：`kind='outlines'`。

---

## 7. RPC 与 MCP

- RPC：`expansion.get / plan / confirmPlan / start / approveOutline / advance / pause / resume / reset / usage`；
- MCP 工具 `novel_desk_expansion`（AI 用）：`status`、`plan`（写入宏观方案）、`outline-change`、`wait-outline`、`stage`、`finish`、`stuck`；
- 自动采纳：`createProposal` 中 `kind='chapter'` 且 `data.expansionRunId === expansion.runId` 且 `status==='running'` → 创建后立即 `acceptProposal`，标记 `autoAccepted`；**acceptProposal 已有章节历史备份机制，确保旧稿可回滚**；
- 预算复用 `summarizeUsage` 口径。

---

## 8. 界面

- **📚 整本书页**：顶部两个部分「生成整本书」「扩写」；扩写页含：
  - 向导：模式、目标字数（必填）、允许新增、样张、预算；
  - 方案展示与「确认方案」；大纲变更待确认横幅（`waiting-outline`）与「确认大纲变更并继续」；
  - 逐章目标表（可编辑覆盖）、执行进度、预算条、notes；
  - 「全部扩写」/「扩写本章」按钮；暂停/恢复/停止/重新开始；
  - done 报告：总字数、逐章达成、冷读分变化、新增内容清单、大纲变更记录；
- **章节页**：每章「扩写本章」入口（带本章、目标必填）；
- 总览不做大改，可加一条"扩写进行中"提示。

---

## 9. 确定性检查

- 目标字数为空 → 禁止开始；
- 扩写后未达目标（显示当前/目标，无容差字段）；
- 引入未批准的大纲外内容 → 标记违规并退回；
- 主线节拍缺失/被改；
- 新增内容重复（跨章/与原文）；
- 冷读分下降；
- 大纲变更未确认就执行 → 阻断；
- 预算 80%/100%。

---

## 10. 已确认的产品决策（2026-10-22）

1. 目标模式只按**字数**；不默认比例；**无默认值**，必填；
2. **不引入容差**：目标在第一步沟通中定死，写进逐章方案与 prompt；
3. 全局目标允许**单章覆盖**；
4. 全文扩写与单章扩写是同一功能，两个按钮，和"生成全文"同构，**全部自动**；
5. 大纲内为默认；动大纲必须在第二步**向用户说明并确认**，否则不执行；
6. 扩写是**整本书下面的独立模块**；
7. 扩写结果**自动采纳**，但必须**保留原稿备份**；
8. 不绑定具体作品，不预设字数（未来 500→5000、1000→2000 都可用）。

---

## 11. 实现分期

- **P1**：数据/状态机/RPC/两套 prompt/大纲变更闸门/自动采纳（带备份）/测试；
- **P2**：整本书页「扩写」子模块 + 向导 + 方案/逐章表/大纲确认/进度预算 + 章节页入口；
- **P3**：确定性检查、done 报告、文档与截图。


## 12. 实现记录（本地，未发布）

- **数据**：`expansion.json`（单例、未启动 idle 不落盘、reset 保留正文）；`bundle.expansion`；`options{additions,additionLimit,sampleChapters,allowOutlineChanges}`、`report`。
- **RPC**：`expansion.get / plan / confirmPlan / start / approveOutline / advance / pause / resume / reset / usage`；plan 目标字数必填（≤0 直接报错）；start 要求 plan-ready 且新建会话发 goal prompt；approveOutline 采纳该 runId 的 pending outlines 后发续跑 prompt。
- **Prompt**：宏观方案（诊断/容量评估/逐章目标/大纲变更/预算，禁写正文）；执行 goal（create_goal + subagent、方案锁定、大纲硬边界、禁注水、冷读不降、每批审一次修一次、`data.expansionRunId` 自动采纳、大纲闸门 wait-outline、完成汇报）；options 写入两套 prompt。
- **自动采纳**：`kind='chapter'` + `data.expansionRunId` 匹配 + status structuring/running → 立即 acceptProposal；旧稿进章节历史备份（可回滚）。
- **MCP**：`novel_desk_expansion`（status/plan/outline-change/wait-outline/stage/finish/stuck）；finish 写 `report`（总字数/章数/平均注意力/新增内容/大纲变更）。
- **界面**：整本书页子导航「生成整本书 / 扩写」；ExpansionPanel 九态（目标必填、方案表可编辑、大纲闸门、预算、报告）；章节页「扩写本章」入口；10s 轮询。
- **测试**：`test/expansion.test.js` 19 条；`node --test` 151/151。
- **确定性检查（已实现）**：`expansion-target-missing`（error）、`expansion-under-target`（warn）、`expansion-outline-pending`（warn）、`expansion-scene-unplanned`（新增场景超出方案且无已批准大纲变更）、`expansion-subplot-unapproved`（旁线未批准）、`expansion-beats-unpreserved`（提案标注主线节拍未保留）、`expansion-attention-drop`（scoreAfter < scoreBefore）、`expansion-added-scene-duplicated`（新增场景跨章重复）、`duplicate-passages`（≥24 字整句跨章重复）。
- **等待大纲确认可勾选（2026-10-22 补）**：waiting-outline 与 plan-ready 共用可勾选清单；`expansion.approveOutline` 接受 `approvedOutlineIds`，无 outlines 提案时直接从 `outlineChanges` 写入 `approvedOutlineChanges` → running + 续跑 prompt；按钮在未勾选时禁用。
- **方案确认（2026-10-22 补）**：plan 新增 `confirmations[]`（AI 待作者拍板事项）；`confirmPlan` 接受 `approvedOutlineIds` 写入 `approvedOutlineChanges`；plan-ready 顶部渲染「需要你确认」+ 大纲变更勾选（全部同意/取消）；全部批准 → start 直接 running，未批准 → structuring 走闸门；子导航「✍️ 扩写」在 plan-ready/waiting-outline 显示「待确认」徽标；计划 prompt 要求 AI 把待拍板事项写进 confirmations。
- **未完成**：真实会话端到端试跑、界面目视；语义级“大纲外内容”识别（当前基于提案元信息 addedScenes/subplotIds/beatsPreserved，非 NLP）。
