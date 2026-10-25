# 0.5.2 未发布期间的开发记录（已归档）

> **这是什么**：0.5.x 线在发布 `v0.5.1` 之后、0.6 重写开始之前积累的「未发布（Unreleased）」开发记录。
> 内容原样搬自 0.5.2 分支（git 分支 `legacy/0.5.2-wip`）`CHANGELOG.md` 顶部的三节
> （`## [Unreleased]` 与两节 `## [Unreleased · 历史待发]`）；其中最后一节（「提案全部采纳后审阅仍残留」）
> 当时也出现在 `main` 的 `CHANGELOG.md` 顶部，0.6.11 发布时一并搬到这里。
>
> **为什么归档**：0.5.2 这条线最终没有发布。0.6 把插件整体重写成「读—批注—审—改」工作台
> （内部迭代版本 0.6.0 → 0.6.11，对外以 `0.6.11` 发布），下面这些记录里的实现
> （`lib/revision.js`、`lib/alignment.js`、`lib/snapshots.js`、`lib/checks.js`、`lib/ebook.js`，
> 以及 `pipeline.json` / `expansion.json` / `revision.json` 等数据）**不在 0.6.11 的代码里**。
> 0.6.11 没有「版本对齐 / 整本快照回滚 / 全文改动分层 / 12 Agent 分工」这些能力，
> 也没有 0.5 的 19 页签流水线——它是重写，不是 0.5.x 的功能超集。
>
> **只作历史留档**：完整实现见 git 分支 `legacy/0.5.2-wip`；当前版本的变更请看仓库根目录的
> [`CHANGELOG.md`](../../../CHANGELOG.md)。归档时间：2026-10-26（0.6.11 发布时）。

---

## [Unreleased]

### 新增

- **所有审阅硬隔离（一份隔离区、统一硬边界，任何审阅都不许翻别的书）**：作者要求「所有审阅都必须硬隔离，不能产生任何污染，除非用户指定目录或文件，否则绝不允许其他书籍污染当前书籍」。现在审阅隔离从「去 AI 化」推广到全部审阅链路：统一隔离区 `<StoryDesk>/.review-workspaces/<作品名-id后6位>/<12位指纹>/chapters/`（指纹按章号+正文算：同一批章重复准备幂等复用，全书审阅与单章工作单各占目录、互不清文件；只写本书章节正文副本，不带账本/历史报告/其他作品），零上下文首读（单章 + 全书）、`attentionFixWorkorder`、`attentionRecheckWorkorder`、全文重新审阅、`review-to-proposals` 的 prompt 都只给隔离区里的章节文件路径；带账本上下文的审阅任务（`full-review` / `import-review` / `review-chapter` / `review-fix`）在 prompt 里插 `REVIEW_ISOLATION_NOTICE_LINES`（只审当前这本书、禁止读本书工作台以外文件、禁止跨作品对比、缺材料停下来问作者、只提交结果不改正文）。`review.startFull` 不再走 pipeline 会话，改为 `startFullBookReview()`：先 `prepareReviewSandbox` 复制全书副本，再 `startIsolatedReviewSession()` 在隔离区新建独立零上下文会话，返回 `workspacePath` / `chapterCount`（与 `review.startDeai` 同一条路径）。`prepareDeaiWorkspace` 与新 `prepareReviewSandbox` 共用实现，旧的 `.deai-workspaces` 废弃。提交侧原有闸门保留：跨作品名整批拒绝、`origin="deai"` 引文必须逐字在正文。文档 `docs/REVISION-CONTRACT.md`、测试 `test/review-isolation.test.js`（7 例，含在同一个 StoryDesk 下放一本《鱼龙舞》验证任何审阅 prompt 都不出现它）。
- **去 AI 化审阅硬隔离（禁止跨作品对比 + 独立零上下文）**：作者反馈「让它做去 AI 化审核，它去对比《鱼龙舞》」——旧链路虽然新建了空会话，但 prompt 只给汇总指标、不给章节清单也没有隔离禁令，AI 为了找原文自己去翻工作区，而项目工作区的父目录里并列着其他作品、`_work/` 里还有旧的「人类基线」报告，于是把另一本书当「人写的基线」做对比。现在：`review.startDeai` 走新的 `startDeaiReview()`，先把本书章节正文复制到 `<StoryDesk>/.deai-workspaces/<作品名-id>/chapters/` 这个**只含本书副本**的隔离工作区，再在该目录新建会话投递 prompt；prompt 重写为「独立会话 · 零上下文 · 只审本书」，含「硬性边界（违反任何一条本次审阅作废）」6 条（独立新建不继承旧对话、只审本书、只能读清单里的文件、禁止读上级目录/其他作品/`library.json`/`_work`/历史报告、绝对禁止跨作品对比与「人类对照/人写基线」且不得出现其他书名人物名、不要为像人而编造病句）+「章节文件清单（唯一允许读取的文件）」（章号/标题/字数/绝对路径，由 AI 自己 `read`）+ 提交前自查。审稿侧同步加闸：`origin` 新增 `deai`；`origin="deai"` 的条目必须带 `quote` 且逐字存在于该章正文（<4 字或不在正文直接拒绝）；所有审稿条目的问题/建议/引文/维度拼起来命中**其他作品名**（含去副标题、`·`/`・` 分段变体）就整批拒绝并提示删除跨作品内容。新增工具 `novel_desk_deai_review`（`op=start|workorder`），并在 prompt/UI 给出公开 AI 检测「朱雀 AI 检测」链接（`DEAI_AUDIT_URL`，只给入口不自动上传）。契约 `docs/REVISION-CONTRACT.md`，测试 `test/deai-isolation.test.js` / `test/aistyle.test.js`。
- **复核发现的问题落成审稿（可勾选、可忽略、再生成改动提案）**：复测（复核）不再只交回一份新分数——复测工作单强制要求把读到的新问题逐条写成审稿：`novel_desk_review` 升级为可一次写多章（顶层 `chapter` 默认章、`reviews[].chapter` 覆盖）、全书级 `chapter=0`、新增 `origin`（`cold-read|recheck|review|manual`）与 `quote`（原文引文）、`severity` 兼容中文；同章 + 同维度 + 同题自动去重（已修/已忽略的会重新打开并记 `reopenCount`）；章号必须已存在。交接任务 `review-to-proposals` 改写：注意力/文笔/节奏类审稿合并成 `attention-fix` 段落补丁提案（`reviewIds` 覆盖多条审稿），情节/人物/连续性类仍一条一个 chapter 提案，要求每条审稿都被某份提案覆盖。`attention-fix` 提案页显示「处理 N 条审稿」，采纳后关联审稿自动置为已修。审稿页新增「来源」列与筛选、`chapter=0` 显示「全书」、编辑表单加来源/引文；提分工作台新增「看复核审稿（N）」入口。checks 新增 `attention-recheck-no-review`（复测低分却没写复核审稿）。契约见 `docs/ATTENTION-FIX.md` §10，测试 `test/review-batch.test.js`。
- **注意力提分闭环（🎯 提分工作台）**：冷读打分后不再只出两三条审阅意见——新提案 kind `attention-fix` 用「段落级补丁」替代整章重写：`data.items[]` 每条含 `target`（hook/tension/payoff/cliff/type/language）、`weak`、`expectedGain`、逐字 `before`、`after`、`why`；提交时硬校验（≥3 条、≥2 个不同 target、`before` 必须在正文逐字唯一命中且互不重叠、单条 1–15 分、合计 ≤40）。采纳时倒序替换、只改补丁段（自动备份，保留标题/状态/摘要/地点/时间/人物），并把 `fixLog` / `recheckPending` / `fixPlan` 写回 attention 账本。四拍诊断落账：`breakdown{hook,tension,payoff,cliff}`（各 0–25）、`dropPoints[{quote,why}]`、`scoredAt` / `scoredHash`（正文 sha1 前 12 位）。复测：`novel_desk_attention_fix(op=recheck)` 只列「待复测」章、不透露旧分，零上下文重打四拍后写 `scoreHistory`（from/to/delta/designScore/source），清 pending、记 `lastRecheckDelta`。页面「🎯 提分工作台」按「提分空间」降序（目标分 − 实测分，设计差 ≥20 与有弃读点加权），三个总按钮（生成全部提分方案 N 章 / 勾选后生成选中方案 K 章 / 复测全部待复测 N 章）+ 单章「生成方案」，章节可勾选、不再写死前 5 章；章节卡显示四拍条、弃读点引文、补丁次数、`61 → 68 +7` 徽章与待复测状态；统计条与总览加「提分闭环」。新增 `lib/attention-fix.js`（纯函数）、`novel_desk_attention_fix` 工具（workorder/recheck/scoreboard）、交接任务 `attention-fix` / `attention-recheck`；冷读 prompt 升级为读完直接产 3–12 条补丁；context/plan 注入「提分闭环 / 提分待办」；checks 新增 4 条（待复测、分数过期、改了没提分、设计落差不补）。工作单与冷读 prompt 都不再把章节正文贴进对话：提分/复测只给章节文件绝对路径 + 字数，零上下文首读只给章节清单与路径，由 AI 自己 `read`（与全文改写/扩写一致）。契约见 `docs/ATTENTION-FIX.md`，测试 `test/attention-fix.test.js` / `test/attention-fix-prompt.test.js`。
- **版本对齐（🎯 对齐页重写）**：稿本（总稿）新增递增版本号 `project.draft = { version, updatedAt, log[] }`——每次正文变化（新建/保存/删除章节、导入、整本回滚、检测到外部改动）自动 +1，日志保留最近 100 条；10 个账本（人物 / 事实 / 时间线 / 地点 / 世界 / 高光 / 伏笔 / 冲突 / 注意力 / 大纲）各记 `project.ledgerSync[kind] = { touchedVersion, alignedVersion, … }`，账本写入（`upsertEntity` / `deleteEntity` / `saveWorld` / 采纳提案）自动把 `touchedVersion` 记成当前稿本版本。对齐页从"比字数"改成**版本对齐**：稿本 v12｜人物 v9（落后 3 版）｜时间线 未追踪｜哪里没对齐（变更章节 + 覆盖缺口：引用人物没建卡、章节缺高光/大纲/事件/事实/注意力、地点没登记、世界没建）；落后时点「＋ 加入清单：对齐落后账本」交给 AI 按落差章补提案（仍只出提案、不改正文），补齐后逐域或全部「标记为已对齐」；字数/计划进度降级为折叠区。新增 `lib/alignment.js`（纯函数 `computeVersionAlignment` / `formatVersionAlignment` / `bumpDraft` 等）、store 新增 `ensureDraftCurrent` / `markLedgersAligned` / `markSnapshotRestored` / `markLedgerTouched`、RPC `alignment.report` / `alignment.mark`、工具 `novel_desk_align(op=status|mark)`。整本回滚后自动把全部账本标为已对齐（快照内自洽），`ledger.restore` 恢复账本历史后该域显示"改过、待确认对齐"。旧数据无需迁移：无 `draft` 字段时首次读对齐页按现有章节建立版本基线。契约见 `docs/ALIGNMENT-VERSION.md`，测试见 `test/alignment-version.test.js` / `test/align-prompt.test.js`。
- **整本回滚（「📚 整本书 → 🕘 版本」子页）**：`lib/snapshots.js` 整本快照（全部章节 + 19 个 json 账本 + 每文件 sha256 的 manifest），生成整本书 / 扩写 / 全文改动**开工前自动打点**（trigger=run-start，失败不阻断开工）。RPC：`snapshot.list` / `snapshot.create` / `snapshot.get` / `snapshot.diff` / `snapshot.restore` / `snapshot.restoreChapter` / `snapshot.chapter` / `snapshot.delete`。回滚 = 先自动存「回滚前」快照（pre-restore）→ 按 manifest 覆盖 → 删掉快照之后新增的受管文件，保证整本状态精确匹配；单章回滚先把当前正文写进 `.backups/`。revision / pipeline / expansion 任一 status=running 时拒绝回滚。
- **json 账本历史（`.backups/json/`）**：`writeJson` 写入前把旧内容存一份（每本上限 100 份，内容没变不存；首次写入无旧内容则不存），文件名带时间戳 + 进程内序号，同一毫秒多次写入也可确定排序。RPC：`ledger.history` / `ledger.version` / `ledger.restore`；`store.listJsonHistory` / `readJsonHistoryVersion` / `restoreJsonHistory`。
- **全文改动（整本书页内的子模块）**：`revision.json` 单例 + `revision.*` RPC + `novel_desk_revision` 工具。契约校验（L3 缺价值变更书直接拒绝）、影响面分析（出场章 ∪ 关系传导 ∪ 事件参与，全部用现有人物卡/章节/事件数据）、批次规划（L3 强制「设定层先行」，批次大小与停顿方式由作者选）、单章 apply（自动留历史备份 + 双闸门）。UI 落在「📚 整本书」子导航里，不是独立页签。详见 `docs/REVISION.md` 与 `docs/REVISION-CONTRACT.md`。
- **双闸门**：保真（专名不得丢失 / 数字保留率 ≥80% / 对白条数 ±20% / 章末钩子承接 ≥30%）+ 风格（`lib/aistyle.js` 改前改后对比）。不通过仍写入，但批次标 `needs-fix`。
- **整本书 → 审阅子页**：两个入口——「去 AI 化审阅」（按确定性指标与 Markdown 残留清单开刀）与「全文重新审阅」（可填重点，逐条回应）。对应 RPC `review.startDeai` / `review.startFull`。
- **全文改动的批次大小与停顿方式**：`batchSize` 可设正整数（1 = 一次一章）、`'all'`（全书一批）或 `'auto'`（按层级默认）；新增 `stopMode`：`per-batch`（每批停）/ `fix-only`（只在出问题时停）/ `run-to-end`（一路跑到底）/ `'auto'`（按层级默认）。L1/L2/L3 各种组合都可自由选批次与停顿，L3 只保留「设定层批 0 在最前」的顺序约束。批次大小只决定检查点密度，每章仍是独立改写，任何模式都过保真 + Markdown 双闸门。**执行设置归到「开始」这一步**：UI 上批次大小 / 停顿方式移出「① 改动契约」，放进新的「④ 执行」卡片；`revision.start` 接受 `batchSize` / `stopMode` 并在投递工作单前重排批次（`rebatchRevision`，按章保留 done / needs-fix 进度，返回 `rebatched`）。`revision.json` 的 `contract` 白名单补上 `batchSize` / `stopMode`（此前读回时被归一化吃掉，UI 因此一直显示「按层级默认」）。
- **Markdown 残留检测（去 AI 化第一优先级）**：`scanMarkdownArtifacts()` 扫 `##` / `**` / `---` / `>` / 反引号 / 列表符 / 链接 / HTML 标签，命中即 blocker，逐章给样例。

### 修复

- **去 AI 化审阅跨作品/跨工作区对比**：`review.startDeai` 的 prompt 里没有任何边界，AI 会去读父目录下的其他作品（实测报告第 4 行写着「人类对照：《鱼龙舞（妖刀记前传）》133 回 / 1,116,993 字」）。现在与会话侧都是硬隔离：只读本书章节副本、清单外文件一律不许读、跨作品对比整批拒绝（见「新增」第一条）。
- **复测时同一章出现两张重复提案**：AI 在一次复测里对同一章重复提交 `kind=attention`（工具重试，或重打分修正一次），`createProposal` 此前没有幂等/去重，提案页就会并排出现两张同章卡片；两遍都采纳还会把同一分数写两次 `scoreHistory`（出现 `77→77`、`86→86` 这类空更新）。现在：完全相同的待采纳提案（kind + 标题 + 章号 + data + items）复用旧卡；同章同角色（实测/复测分数 vs 写作前设计稿）的待采纳注意力提案**原地覆盖**为最新一份（保留卡片 id，更新分数/四拍/说明），所以重打分只会留下一张最新卡；设计稿与实测稿仍可各留一张；不同章、已采纳/已驳回提案不受影响。已清理《碧血青霜缘》项目里 ch11/ch14/ch36 三组待采纳重复（保留最新一份，旧文件备份在该作品 `.backups/`）。测试 `test/proposal.test.js` 新增 4 例（重复提交幂等、同章重打分覆盖、design/measured 并存、已采纳不覆盖且不同章互不影响）。

### 说明

- L4（结构层：改事件/结局）不由改动引擎承接，走大纲闸门/扩写。
- 改动同样受「必须有当前写作预设」硬闸门约束。

## [Unreleased · 历史待发]

### 新增

- **去 AI 化审稿人（第 12 个 Agent，权重 7）**：新增 `lib/aistyle.js` 确定性审计——微动作帧密度、装饰性步长量化、情绪词密度、长句占比、章间句长变异系数、对话文言/白话度、模板集中度共 8 项指标，全部不调模型；`aistyle.audit` RPC 返回逐章偏差表与 `buildAiStyleReviewPrompt` 工作单。阈值可由预设 `styleCards` 覆盖。老作品经 `addIfMissing('deai-reviewer')` 幂等补齐。
- **全文改动分层契约（`lib/revision.js`）**：L1 语域 / L2 侧写 / L3 语义（价值观）/ L4 结构四层，各自声明允许动与必须冻结的字段；提供契约校验、批次规划（L3 强制「设定层先行」，批次与停顿由作者选）、闸门策略与影响面分析。L4 明确拒绝，指向大纲闸门。详见 `docs/REVISION.md`。
- **预设解析唯一入口**：新增 `resolveActivePreset(bundle)`。

### 修复

- **预设从未进入生成链路（致命）**：`lib/ai.js:65` 取 `bundle.presets[0]` 而非 `project.activePresetId`，作者选中的风格预设被「标准长篇方案」静默顶替——整本书按 `tone: 克制、有画面感` 生成。现在 `ai.js`、`index.js`（`projectGenre`、审稿 prompt）、`preparePipeline` 全部统一走 `resolveActivePreset`。
- **预设静默截断**：审稿 prompt 里 `styleRules.slice(0, 10)` / `taboo.slice(0, 8)` 会丢掉排在后面的规则（含范文锚点），已取消。
- **生成前没有预设闸门**：`createProject` 从不写 `activePresetId`，导致不选预设也能生成。新增 `assertActivePreset(bundle)`（只认 `activePresetId`，不做回落），挂到扩写出方案/开始、流水线准备/启动、产出正文的 AI 任务上。
- **EPUB/DOCX 泄漏 Markdown 标识符**：`lib/exporters.js` 把正文行原样塞进 `<p>`，`## 第一节`、`**【七律】**`、`---` 全部进了成品书，被出版方当作「AI 流水线格式」。新增 `contentBlocks()` 做块级解析（标题→h2/h3/Heading，引用→blockquote，分隔线丢弃，行内标记剥离），Markdown 导出也不再注入 `> 摘要：`。

---

## [Unreleased · 历史待发]

### 修复

- **提案全部采纳后审阅仍残留**：`review-to-proposals` 生成的章节提案带 `data.reviewIds`，但 `acceptProposal` 只写正文/账本，从未回写审阅状态。现在章节（及带 reviewIds 的）提案采纳后会自动把关联审阅标记为 `fixed`（记录 `fixedByProposalId`）；另新增 `reconcileReviewsFromAcceptedProposals` / `review.reconcile`，审阅页打开时对历史「提案已采纳但审阅未归档」数据自动幂等回填（例如碧血那 53 条）。

