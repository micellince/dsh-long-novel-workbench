# FULLBOOK PIPELINE · 生成整本书（全自动长流程）设计 v2

> 一句话：用户给一句话设定 → 先出「事实 + 注意力蓝图 + 大纲」给作者验收 → 点「生成全文」后进入**一个 goal**，全程自动写到完结（按卷循环：写 → 审一次 → 修一次），最后总审 + 总修 → 提示交给独立审稿人。
> 原则不变：**ATTENTION IS ALL YOU NEED**，每个阶段先定注意力，再写内容。

---

## 1. 两种生成模式（用户启动时选）

| 模式 | 行为 | 适用 |
|---|---|---|
| **A. 生成全文** `mode='book'` | 从当前进度一直写到项目目标章数（`project.targetChapters`）或已有大纲的最后一章；全书跑完才停 | 新书验收后、半成品续写到底 |
| **B. 按 N 章生成** `mode='chapters'`, `count=N` | 只生成接下来 N 章，N 章写完 → 审一次 → 修一次 → 停；可再次启动接着生成 | 想一段一段来、控制预算 |

两种模式共用同一套卷循环与 prompt，只是停止条件不同。

---

## 2. 两条入口流程

### 2.1 新建一本书（规模在创建时定）

```
新建作品（用户填：书名/类型/风格/一句话设定/总章数/每章字数/预算）
   ↓
「准备阶段」（自动跑，不入全速流水线）
   ① 事实 + 注意力蓝图   → 提案
   ② 全书章节大纲 + 每章 attention 设计 → 提案
   ↓
作者在工作台验收（看蓝图/大纲/提案）
   ↓
按钮「生成全文」变为可用 → 用户点击
   ↓
进入全自动 goal（见 §3）
```

**新建时不能直接点「生成全文」**——必须先有经作者验收的蓝图与大纲，否则后面全错。

### 2.2 已有作品（半成品，如碧血青霜缘）

- 已有正文/大纲/设定 → 可直接选「生成全文」或「按 N 章」；不需要准备阶段（自动视为已准备）；
- **生成全文的目标章数**：优先取「生成设置」里显式填的 `targetChapter`，其次 `project.targetChapters`、大纲最后一章、上次 run 的目标；
- 若都取不到（例如半成品既没设目标章数也没有大纲），启动会明确报错并提示「去整本书 → 生成设置里填写目标章数」，不会静默失败；
- **按 N 章生成**：目标 = 当前最大章 + N，N 由生成设置决定，跑完会记住供下次使用；
- 若缺少世界/地点/注意力设计，启动时由 goal prompt 先补蓝图（自动，不打断）。

---

## 3. 全自动 goal（核心：不靠工作台插话）

点「生成全文」/「按 N 章」后：

1. 只开**一个新会话**，投递一条「总目标 prompt」（goal prompt）；
2. prompt 明确要求 AI **自己建立 goal**（goal 工具，`max_goal_rounds` 给足），把整本书生成当成一个长目标；
3. prompt 明确要求 AI **用 subagent / Team 分派**：总编先拆单，再按阶段派子 Agent（蓝图、大纲、逐卷写作、审阅、修订、总审），子 Agent 只做一件事并写回工作台；
4. prompt 明确：**不要中途停下来问作者**；每完成一卷自己汇报一句，然后继续；直到全书完成才结束 goal；
5. 之后由 **DSH 的 goal 机制自动续轮**（会话内自动推进），工作台**不发任何"继续"消息**，不干扰对话；
6. 工作台只做三件事：**启动**、**读进度**（AI 通过 `novel_desk_pipeline` 上报，或从提案/审稿推断）、**显示预算**；
7. 每一卷循环：

```
写本卷 n 章（每章 chapter 提案）
   ↓
审阅本卷（一次）：连续性/人物/时间线/文笔 + 每章冷读 0–100 分 → 审稿 + attention 实测提案
   ↓
修订本卷（一次）：按审稿意见出修订提案，由工作台自动采纳（流程内修订，留痕）→ 直接进正文
   ↓
继续下一卷
```

8. 全部卷完成 → 全书总审阅（一次）→ 全书总修订（一次）→ goal 完成 → 结束；
9. 结束提示：把全书交给独立审稿人冷读。

### 为什么不靠工作台「继续」

工作台往会话里发"继续"，本质是**以用户身份往那个对话插一条消息**——会打断 AI 的当前回合、污染上下文，也可能和它自己的 goal 续轮冲突。所以：

- **主机制 = 会话自己的 goal + subagent 编排**，自动推进不需要外部消息；
- 工作台**默认不发「继续」**；
- 只有兜底时（可选）：会话异常停止且 goal 未完成，页面显示「流程卡住」和一个**手动**「继续」按钮，用户点了才发一条；默认关。

### goal prompt 里必须写清（设计要点）

- 你是这本书的总编/导演：先 `create_goal`（目标=写完整本书；`max_goal_rounds` 给足）→ 再按下面阶段执行；
- 用 subagent 分派：蓝图、大纲、每卷写作、每卷审阅（连续性/人物/时间线/文笔/冷读可并行）、每卷修订、总审；子 Agent 只写回工作台提案/审稿，不直接改正文（修订由工作台按 runId 自动采纳）；
- 每卷顺序：写完 → 审一次 → 修一次（自动采纳）→ 立刻下一卷，**不要问作者**；
- 维护进度：每完成一步调用 `novel_desk_pipeline` 上报；预算快用完时按提示收尾或暂停；
- 全部完成才 `goal complete`，最后汇报：卷数/章数/总字数/平均注意力分/最低章/建议冷读。

## 4. 数据 `pipeline.json`（单例）

```jsonc
{
  "id": "pipeline",
  "status": "idle|preparing|running|paused|done|aborted|stuck",
  "runId": "run-...",              // 一次生成 run 的唯一 id（用于提案标记/自动采纳）
  "mode": "book|chapters",        // 生成全文 / 按 N 章
  "count": 0,                      // chapters 模式的 N
  "sessionId": "",                // goal 会话 id（driver 只往这里续推）
  "targetChapter": 80,            // 本次 run 的停止章
  "base": { "premise": "", "genre": "", "style": "", "era": "", "locations": "", "characters": "", "volumes": 3, "chaptersPerVolume": 10, "wordsPerChapter": 3000 },
  "budget": { "maxTokens": 0, "maxCostCNY": 0, "usedTokens": 0, "usedCostCNY": 0, "baseline": null },
  "stages": [ { "id": "volume-1", "kind": "volume-write", "name": "第一卷写作", "status": "pending", "chapterFrom": 1, "chapterTo": 10 } ],
  "currentStage": "volume-1",
  "prepared": { "blueprint": true, "outline": true },   // 新建书必备：蓝图+大纲已验收
  "notes": [],
  "createdAt": "", "updatedAt": ""
}
```

阶段（内部进度用，不需要作者逐步点击）：
`prep-blueprint` → `prep-outline` → 每卷 `write-N` / `review-N` / `fix-N` → `final-review` → `final-fix`。
阶段状态由 AI 通过 MCP 工具上报（见 §6），driver 只负责续推。

---

## 5. 预算（启动时由用户设）

- 向导里选：总 token 上限 和/或 总费用上限（¥），0=不限；**明确标注"估算不准，仅作提示"**；
- 每阶段开始记录用量快照，完成累加；
- 80% 提示（页面横幅 + 一条进度提示），100% 自动暂停 driver（保留产物，可调预算后恢复）；
- 预算只约束本次 run，不限制工作台其他 AI 操作；
- 估算公式仅给数量级：写 ≈ 章数×字数×1.6 token、审 ≈ ×0.8、修 ≈ ×1.2（含系统/上下文开销，实际会更高）。

---

## 6. 进度上报与工具

新增 MCP 工具 `novel_desk_pipeline`（AI 用，不是作者用）：
- `op=status`：读当前 pipeline（阶段/目标/预算/已用）
- `op=stage`：`{stageId, status:'running|done', note}` 更新阶段与 notes
- `op=finish`：全部完成，标记 done
- `op=stuck`：卡住并说明原因（driver 也会自动判定）

用途：AI 在长流程中自报进度，工作台页面据此显示「第 3/13 步：第二卷写作」；即使工作台没开，状态也在文件里。
另需 AI 使用 `create_goal`（目标=写完整本书）与 `subagent` / Team 工具分派工作；工作台不介入会话对话。

---

## 7. 界面

- **新建作品向导**：书名/类型/风格/一句话设定/章节规模（总章数、每章字数）/预算（token 或 ¥）；创建后自动跑「准备阶段」。
- **准备阶段页面**：显示蓝图与大纲提案状态；作者验收后「生成全文」按钮才亮起。
- **📚 整本书页**（工具组页签）：
  - 顶部：模式（全文 / 按 N 章）、目标章数、当前阶段、状态、预算条；
  - 「生成全文 / 生成接下来 N 章」按钮（未准备完毕时置灰）；
  - 阶段进度列表（准备/卷/总审）+ notes 进度提示；
  - 暂停（向该会话发一条「暂停，保存当前进度」）/ 恢复（重新投递续跑 prompt）/ 停止 / 重新开始；预算超限横幅；
  - 卡住兜底：会话异常停止且未完成时显示「流程卡住」与**手动**「继续」按钮（默认不自动发）；
  - 完成后显示「交给独立审稿人」按钮。
- **常驻提示**：运行中在总览/原则条旁显示「生成中：第 3/13 步 · 第一卷写作」；不打断用户，不弹确认。
- **自动采纳的提案**：提案页带「流程自动采纳」标记，可重新打开/驳回。

---

## 8. 失败与恢复

- 会话异常停止（goal 没续上、掉线）：页面显示「流程卡住」，给**手动**「恢复」按钮（发一条续跑 prompt），默认不自动发；
- 持续无产出：AI 或工作台标记 `stuck`，保留现场；
- 预算超限：页面提示并可「暂停」（发一条暂停说明）或直接停止；
- 用户关闭工作台：状态在 `pipeline.json`，重开后由页面读取；会话若还在跑不受影响；
- 重新开始：新建 runId，保留旧正文/账本（不删产物）。

## 9. 规模与限制

- **不设上限**：章数/字数由项目创建时设定（`project.targetChapters` / 每章字数），半成品沿用其预设；
- 卷数 = ceil(目标章数 / 每卷章数)，每卷章数默认 10（可在启动时改）；
- 超长书（如 133 章）允许跑，但预算与时长自负；driver 会按卷汇报进度。

---

## 9.5 实现记录（本地，未发布）

- **数据**：`pipeline.json`（单例，不进 KINDS；getPipeline 未启动返回 idle 不落盘；savePipeline 单例合并；resetPipeline 删文件保留正文）；`bundle.pipeline`。
- **阶段**：`prep-blueprint` → `prep-outline` → 每卷 `write-N/review-N/fix-N` → `final-review` → `final-fix`；范围按当前进度到目标章切。
- **RPC**：`pipeline.get / prepare / markPrepared / startRun / advance / pause / resume / reset / usage`。prepare/startRun 会新建会话并发送对应 prompt；resume 向同一 sessionId 发续跑 prompt（仅用户手动触发）。
- **Prompt**：`buildPipelineGoalPrompt`（原则首行、create_goal（max_goal_rounds ≥ max(50, 目标章数×2)）、subagent/Team 编排、每卷 写→审→修、不问作者、novel_desk_pipeline 上报、修订带 pipelineRunId+reviewIds、停止条件、完成汇报）；`buildPipelinePreparePrompt`（先注意力后事实、蓝图+大纲+每章 attention planned）。
- **自动采纳**：`createProposal` 中 kind=chapter 且 data.pipelineRunId 与当前 run 匹配、pipeline 为 running → 立即 acceptProposal 并标 `autoAccepted`；其他情况留 pending。
- **MCP**：`novel_desk_pipeline`（status/stage/finish/stuck）。
- **预算**：`estimatePipeline`（写×1.6 / 审×0.8 / 修×1.2，按 ¥2/百万 token 粗估，注明不准）；startRun 记 baseline，advance→done 累加增量；80% 预警、100% 自动 paused。
- **界面**：工具组「📚 整本书」页 + PipelineWizard + 总览进度卡 + 新建作品勾选「创建后进入整本书」；六态 UI、预算双条、阶段进度、notes、暂停/恢复/停止/重新开始/stuck 手动继续/done 交给独立审稿人。
- **测试**：`test/pipeline.test.js` 16 条；`node --test` 130/130。
- **未验证**：真实会话里 goal + subagent 的自动推进（首次试跑需观察：是否真的自建 goal、是否按卷推进、自动采纳是否命中、预算是否按增量结算）。

---

## 9.6 半成品补充（同日修正）

- 后端 `startRun` 支持显式 `targetChapter`（book 模式）与 `base`/`budget`/`count` 透传；
- 前端「生成设置」新增**目标章数**输入（book 模式），默认取项目目标/大纲末章/上次目标，并显示"当前已写到第 N 章"；
- 从生成设置启动时会把 `targetChapter`、`base`（卷数/每卷章数/每章字数）、`budget` 一起提交并持久化，供页面按钮复用；
- 测试补 1 条：半成品无目标时拒绝并提示、显式 targetChapter 后可续写（`node --test` 131/131）。

---

## 10. 待确认

1. **全自动修订的落地**：流程内修订提案由工作台自动采纳（推荐，留痕）还是允许 AI 直写正文？
2. **按 N 章模式**：N 章写完是否也做「审一次 + 修一次」再停？（建议是）
3. **准备阶段**：蓝图+大纲必须作者验收后才能生成全文（已定）；准备阶段是否走同一预算？（建议走，单独列用量）
4. **goal 续轮上限**：`max_goal_rounds` 给多大？（建议按目标章数估，例如每章 1–2 轮，最少 50）
5. **兜底「继续」默认关**：只有卡住时手动点（已定）。
