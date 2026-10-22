# WORKLOG · 长篇中文小说工作台

> 位置：`/Users/micellince/Documents/deepseek-harness/dsh-long-novel-workbench`
> 对应 DSH 工作区：**长篇中文小说工作台 · 插件开发**
> 用途：记录每次改动做了什么、为什么、验证结果；发布流程与待办分别见 `PUBLISHING.md` 和 `BACKLOG.md`。

---

## 2026-10-22 · 晚（本地测试，未发布）

### 作品工作区

- **每本书独立工作区**：新建/导入作品时在 DSH 默认工作区目录下创建同名工作区（标题=作品名/自定义工作区名），不再使用导入目录名。
- 已有项目首次打开/发送时自动迁移；旧数据目录空工作区自动清理；旧审阅工作区重命名成「书名 · 旧审阅（历史）」。
- 工作区名可自定义；作品改名同步工作区标题。
- 旧工作区里的审阅会话 token/费用已并入仪表盘统计。

### 导入

- 支持整本书：`.md` / `.txt` / `.epub` / `.pdf` / `.mobi`。
- TXT、EPUB、MOBI(PalmDOC) 纯 JS 原生解析；PDF 借 `pdftotext`；仅 HUFF/CDIC MOBI 才退回 Calibre。
- 整本按「第X章/回/节」「Chapter N」或 EPUB spine 切章；无标题按约 6000 字分段。
- 导入对话框新增「浏览…」本机文件浏览器，可选目录或整本书文件，不用手输路径。
- 作品名默认取电子书标题，不再默认取文件夹名；工作区名独立字段。
- 导入页可勾选「导入完成后立即在新工作区开始审阅」（默认开）。

### 发送 / 清单

- 清单成为唯一 AI 入口：顶部「🧺 清单」+ 总览横幅；去掉顶部「发到对话」弹窗和零散「生成下一章」按钮。
- 发送目标：当前对话 / 新开对话；**当前对话无会话时自动在本书工作区新建会话并发送**，不再要求手动新开。
- 清单每项可写补充意见；提案卡可写作者意见；两者在交接 prompt 里分开标注。
- 决策卡：AI 建议 / 作者意见二选一；多取值事实冲突直接列值选择；原「采纳所选 / 让 AI 重写」移除。
- 具体提案改为「同意并加入清单」，不再直接改正文；对话用 `novel_desk_proposal` 读取完整内容后再落盘。
- 支持「从头审阅整个项目」任务，按六角色规范（连续性/人物/时间线/伏笔/文笔/责任编辑）执行，并带写作预设的风格规则/禁忌。
- 多 Agent 交接：清单可勾选「按分工派子 Agent」，prompt 带 9 个角色与总编拆单规则。

### 审阅 / 提案状态

- 提案已处理列表区分「已采纳 / 已驳回 / 已修订 / 已替代」，不再把所有非 accepted 都显示成「已驳回」。
- 支持单条「重新打开」与勾选批量重新打开。
- `resolvesProposalId` 改为新提案被采纳时才关闭原决策，创建/取消不会误关。

### 人物 / 设定

- 导入人物卡解析「人物关系」小节，生成 `名字(关系)` 标签，关系图有连线；已迁移 15/20 个存量人物。
- 人物、伏笔、高光、事实、事件、冲突、大纲页新增「加入清单：AI 丰富」。

### 仪表盘 / 用量

- 区分工作台一次性 AI 与 DSH 对话会话；token 记账写入 `projects/<id>/usage.json`。
- 费用按 models.dev 挂牌价 + DeepSeek 规则（非高峰=1x，高峰=2x）估算；根会话费用含子 Agent。
- 只统计当前工作区根会话数量；token/费用包含全部子 Agent；旧数据目录工作区用量也并入统计。
- 修复：工作区/session 统计把子 Agent 算成独立会话、费用少一半、旧工作区用量不显示等问题。

### 验证

- `npm test`：**40/40 通过**（新增 TXT/EPUB/MOBI 导入、提案重开、resolves 延迟关闭等用例）。
- 真实 MOBI（Gutenberg Alice）解析通过；真实 EPUB/TXT 导入通过。
- 本地 commit：`67db592`（最新），之前关键 commit：`10e2e7b`、`7389a4a`、`759a739`、`ef8aeee`、`eb3a2f1`、`97cb4bc`、`9fb1f0b`。
- **未发布**：npm 仍 0.4.1；发布流程见 `PUBLISHING.md`。

### 已知限制

- DSH 会话绑定 cwd，不能直接跨工作区搬；旧审阅会话保留在旧工作区。
- HUFF/CDIC 压缩 MOBI 才需要 Calibre；扫描版/竖排 PDF 需 OCR。
- 审阅是否真的派子 Agent 取决于对话侧工具，只能提示 + 仪表盘核对。

## 2026-10-22 · 独立审稿人（零上下文首读）

### 分工

- 分工表新增第 10 个角色「独立审稿人」，标记 `special: 'fresh-read'`；旧作品读取时自动补齐（不覆盖作者已有分工改动，幂等）。
- 定位：与「连续性审稿（对照事实账本）」「文笔审稿（对照写作预设）」相反，**零上下文**——不读账本/预设/大纲/人物卡，只拿一章正文，模拟第一次读到的读者。

### 交互

- 「分工」页顶部新增高亮卡：章节下拉（默认最后一章）+「带这章进新会话」；点击 `chat.send` 传 `task=fresh-read`、`chapter`、`newSession=true`，新会话只收到该章正文 + 三行极简指令，不拼常规交接头/账本统计/风格规则。
- 总览页加同功能紧凑入口（默认最后一章）。
- 审稿维度新增「首读」，AI 用 `novel_desk_review` 把首读意见写回审稿页。
- 多 Agent 派单会过滤掉该角色（它只在零上下文下单独跑）。

### 验证

- `node --test` 全绿；`chat.send` dryRun 校验 fresh-read prompt 不含账本污染。
- 已发布说明见 CHANGELOG `[Unreleased]`。

### 范围选择（单章 / 全书）

- 首读高亮卡加「读一章 / 读全书」切换：单章按章号投递正文；全书按章顺序投递整本。
- 全书整本 ≤ 10 万字符：一次性把全书正文塞进 prompt（约 7 万 token），要求 12 行内整体意见。
- 全书超出（鱼龙舞 111.7 万字符）：自动转「分批工作单」——只给 133 章的章号/标题/字数/正文文件绝对路径（prompt 约 1.3 万字符），让新会话用 subagent 按批读正文（每批 ≤ 4 万字），最后汇总出全书意见；不把几十万字硬塞上下文。
- 总览紧凑入口给两个按钮：「首读最后一章」「首读全书」。

## 2026-10-22 · 碧血实战审计 → 插件待修清单

- 审计对象：碧血青霜缘工作区 12:03–12:12 那轮（17 项清单 + 5 个子 Agent）。结论：改/审阅/提案/同步四步基本走通，但暴露 9 个插件问题。
- 已入 BACKLOG：B-082 冲突无提案通道（propose kind 缺 conflicts）、B-083 删除无审计、B-084 批量采纳/改审稿缺 MCP 工具（只好 curl 伪造同源头）、B-085 RPC guard 可伪造、B-086 导入把故事线段落当冲突、B-087 待采纳计数重复、B-088 审稿与提案无关联、B-089 checks 不查 frontmatter 元数据、B-090 提案返回值缺条数。
- 另记 V-01：独立审稿人「读一章/读全书」待真机验证（需重启 DSH）。
- 小说内容遗留（4 条 open 审稿、第 6/7 章元数据）不属于插件待修，仅在审计中记录。

## 2026-10-22 · 审稿页闭环（B-091 / B-092）

- 背景：碧血那轮终检写了 4 条 open 审稿，工作台只能「加入清单」，没有出提案的入口；已处理审稿（fixed/wontfix）和待处理混在一张表，越攒越乱。
- 前端：审稿页拆「待处理 / 已处理」两段；已处理默认折叠、可展开、可单条/批量重新打开；待处理勾选后「加入清单」——清单仍是唯一 AI 入口，清单里选「批量生成修订提案」再发送（第一版误做成审稿行内直接发对话，已改回清单路径）。
- 后端：新增 `review-to-proposals` 任务，prompt 只列选中的审稿（章号、维度、严重度、问题、建议、审稿 id），要求逐条提交带 `reviewIds` 的 chapter 提案，明确禁止直改正文；没有选中审稿时报错。
- 测试：新增 `test/review-to-proposals.test.js` 3 例；`node --test` 54/54。
- 待验证：V-02（前端刷新可见分组；批量按钮需重启 DSH 载入新任务）。


## 2026-10-22 · 注意力模块（P0，未发布）

- 设计：`docs/ATTENTION.md`；一眼结论——伏笔/冲突/高光是注意力的三个素材子项，注意力是父级，每章一个 0–100 总分。
- 数据：新增 `attention.json`（chapter/type/score/designScore/verdict/weakest/dropRisk/四拍/detail/status）；`acceptProposal` 支持 `kind=attention`；bundle/stats/提案/工具 kind 全链路打通。
- 角色：第 11 个「注意力设计师」（`weight=10`），总编 9、独立审稿人 8、其余 3；老作品幂等迁移补角色 + 回填缺失 weight，不改已有值/不重排 order。
- 冷读：独立审稿人单章/全书内联/分批三种模式加「按类型校准的 0–100 评分 + 详细不足说明 + 弃读点 + 下一章意愿」，`novel_desk_propose(kind=attention)` 回填；零上下文约束不变。
- 检查：8 条确定性规则（缺记录/章末无牵引/连续同类型/相邻骤降/设计实测差/开篇无事件悬念/平均分过低/冷读未回填）。
- 界面：侧边栏改「注意力/正文/验收/工具」四组；注意力页 = 统计条 + 100 分制 SVG 曲线 + 章节诊断卡 + 按章聚合的伏笔/冲突/高光；总览加注意力卡；分工页加权重列。
- 验证：`node --test` 74/74；纯前端渲染 harness 跑过（含 133 章曲线 2047px、聚合、空态、NAV 顺序）。


### 注意力职责拆分（B-096）

- 修正：设计 ≠ 打分。注意力设计师负责 design 字段（type/hook/tension/payoff/cliff/question/designScore），在写大纲、下一章方案、正文时先产出；独立审稿人只写实测字段（score/verdict/weakest/dropRisk/detail），且明确不写 type/四拍。
- 已有书：注意力页与总览卡新增「＋ 加入清单：AI 补齐注意力机制」（`task=attention-design`），逐章补设计、书大时分批；不直接发对话，清单仍是唯一入口。
- 合并：同一章只有一条 attention 记录，按 chapter 对齐；设计/实测谁后采纳都只覆盖自己给的字段，空值不擦除；plan 提案里的 `data.attention` 采纳即落账。
- 生成流程：`novel_desk_plan` 工作单带 attention 设计模板；`enrich-outlines`、`import-review`、`next-chapter-plan`、`continue-chapter` 均要求先/同时产设计。
- 界面：诊断卡加「已闭环/待冷读/缺设计/空白」状态徽章；空态文案区分新书/老书。
- 验证：`node --test` 79/79；渲染 harness 覆盖状态徽章与清单按钮 payload。


## 2026-10-22 · 清单发送目标修正（B-098）

- 原因：`chat.send` 把「当前对话」实现成 `sameWorkspace[0]`（最近更新），独立审稿人用 `newSession` 建的新会话会抢占，清单就发进审稿会话。
- 后端：新增纯函数 `pickHandoffTarget`（显式 sessionId（须属本书工作区）> 同工作区运行中 > 同工作区最近；过滤空白/子 Agent 会话）；`chat.send` 返回 `reason` 与 `rejectedSessionId`；`chat.sessions` 带 `title`。
- 前端：清单弹窗改为会话选择器，默认「当前主视图会话」（读 `ctx.sessions.list` 的 `retainedBy.mainView`）→ 「本书上次清单会话」（localStorage）→ 「本书最近会话」；发送按钮直接显示目标会话名；成功发送后记住该会话。
- 测试：`test/session-target.test.js` 5 例；`node --test` 84/84。


## 2026-10-22 · 事实账本按主体合并（B-099）

- 痛点：事实平表几十条按章铺开，同一主体属性散乱，看不出当前状态。
- 前端：事实页加「平表 / 按主体」切换；按主体折叠卡片（条目数/属性数/最近章/冲突标记），展开后按属性分组（取值、章、生效区间、备注、编辑/删除、按属性新增）；顶部搜索（主体/属性/取值）+ 展开全部/收起全部；新增 `groupFactsBySubject` 纯函数。
- 数据零迁移，冲突标记复用 `checks` 里的 `fact-conflict:` 结果。
- 验证：`node --test` 84/84；临时渲染 harness 覆盖分组/搜索/冲突卡片/空态。


## 2026-10-22 · 整理视图扩展（B-100）

- 人物：列表每行「详情」→ 宽弹窗，基础字段 + 关系 + 出场章节（元数据优先、无命中回退事件参与人）+ 相关事实（按属性分组）+ 相关冲突 + 相关高光；编辑保存后详情实时刷新。
- 冲突：加「按参与方」折叠视图，分组键=`parties` 排序后 join('×')，空参与方归「未署名参与方」，卡片头看条数/进行中/已解决，展开行内编辑删除，支持搜索与展开全部。
- 伏笔：加「按回收段」折叠视图，按 `payoffChapter` 每 10 章一段，未定回收排最后；展开看埋设→回收/状态/原文/备注。
- 时间线：加「全景」视图，按章聚合事件、伏笔埋/收、冲突（resolveChapter）、高光、注意力（分数/类型/下一章意愿徽章），6 类过滤开关，点章标题跳章节页，两级空态。
- 验证：`node --test` 84/84；伪 React 渲染 harness 覆盖分组/搜索/详情三路取数/全景映射与空态。


## 2026-10-22 · 人物卡（游戏化，B-101）

- 排序：`sortCharactersByImportance`——role 权重（主角4>反派3>配角2>龙套1>其他0）→ 出场章数（章节元数据优先，无命中回退事件参与人）→ 参与冲突数 → 名字 zh；列表与卡片共用，关系图不动。
- 卡片视图：人物页 ViewToggle 加「卡片」，响应式网格；role 色条、首字头像、角色徽章、出场/冲突/事实统计、注意力均分、关系前 3 条；点卡开详情。
- 详情人物卡：头部大头像/角色徽章/tags/编辑·在新窗口打开·关闭；5 个数值（出场/冲突/事实/高光/注意力均分）；两栏（基础六字段 + 关系/出场章节/相关事实/冲突/高光）；760px 单栏。
- 独立网页：`buildCharacterCardHtml` 生成自包含 HTML（内联 CSS、无外部资源、深色游戏风、`@media print`），Blob URL + window.open，弹窗被拦截有提示；输入全部 HTML 转义。
- 验证：`node --test` 84/84；伪 React harness 覆盖排序、事件回退出场、注意力均分、卡片/详情结构、独立 HTML 无外链与 XSS 转义。


## 2026-10-22 · 章节地图 + 世界模型设计

- 删除：人物详情「在新窗口打开」独立 HTML 卡（桌面端拦截弹窗），相关生成器/Blob 逻辑一并移除。
- 新增「🗺️ 地图」页（正文组：章节→地图→人物→时间线→事实账本）：蛇形章节节点、状态色、注意力分档、字数、事件/冲突/伏笔/高光角标、计划章虚线；统计条 + 图例 + 节点详情弹窗（摘要/大纲/注意力记录/素材）+ 跳章节页；133 章 12 行蛇形、窄屏 6 列。
- 新增 `docs/WORLD-MODEL.md`：事实（自洽）与注意力（抓人）两个支柱；地点建模 `world.json`/`locations.json`（坐标/别名/连接/距离/行程天数）、新建作品 AI 生成模拟地图、空间自洽 checks（地点存在/方位/距离与 storyTime/坐标越界）、注意力借用时空；P1/P2/P3 分阶段。
- 验证：`node --test` 84/84；渲染 harness 覆盖地图 133 章蛇形/详情/空态与人物卡回归。

## 2026-10-22 · 世界模型 P1–P3（B-102）

- 数据：`world.json` 单例（getWorld 默认不落盘 / saveWorld 合并）+ `locations.json` 账本；bundle 增加 world/worldSaved/locations/stats；`world.get/save` RPC；MCP bundle/upsert/propose/context 支持世界与地点；提案采纳支持 world（单例）与 locations（按名称/别名去重）；`upsertEntity` 对 locations 无 id 时按 name/别名对齐。
- 生成：清单任务 `world-build`（world + 8–20 地点，双向连接含距离/天数/交通/方位）与 `world-infer`（反推地点）；plan/import/续写 prompt 要求移动只用已登记地点与连接。
- 检查：6 条空间规则（缺世界、地点未登记、相邻章无路线、坐标越界、地点重叠、首现章晚于引用）。
- 前端：「🌍 世界」页（设定表单 + SVG 坐标地图拖拽落库 + 连接编辑 + 地点列表/编辑器）；新建向导世界设定（默认创建后 AI 生成）；章节地图「在世界地图中查看」联动；时间线地点显示与筛选；只读 HTML 视图 iframe（/novel-desk/view/{world|timeline|map}）。
- 验证：`node --test` 105/105；渲染 harness 覆盖 22 地点 SVG、拖拽/悬停/联动/向导；真实数据副本冒烟确认 world 默认不落盘、无地点时 world-missing(info)、有地点+连接后无空间告警、world HTML 含 SVG/别名/距离。

## 2026-10-22 · 注意力一号原则（B-105）

- 界面：工作台常驻「⚡ ATTENTION IS ALL YOU NEED · 怎么吸引读者怎么来 · 一切为读者服务」原则条（所有页签可见）；总览置顶 hero（口号 + 平均注意力/最低三章/未标章数 + 去注意力页/去分工页冷读）；注意力页与分工页原则行；分工页注明注意力设计师权重 10 第一优先级。
- 生成：context/plan/常规交接首行注入创作第一原则；plan 工作单「第一优先级：注意力」前置（最近 6 章曲线、疲劳预警、目标分区间、四拍要求）+ 强制补强（design 与实测差 ≥20 或低于均值-10 → 点名最弱一环）；next-chapter-plan/continue-chapter 先要 attention planned 再写；旧 ai.js 上下文补注意力+世界，两个任务 schema 加 attention。
- 约束：createProposal(kind='plan') 硬校验 data.attention；章节采纳合并 data.attention、缺设计返回 attentionWarning；fresh-read 保持零上下文不注入原则。
- 验证：`node --test` 114/114；提示词冒烟确认 first-priority 在交接头之前、fresh-read 零污染；UI harness 覆盖原则条/hero/注意力页/分工页。


## 2026-10-22 · 生成整本书流水线（B-106）

- 后端：pipeline.json 单例 + 阶段生成 + 9 个 RPC（get/prepare/markPrepared/startRun/advance/pause/resume/reset/usage）；准备阶段 prompt（事实+注意力蓝图+大纲+每章 attention planned）；goal prompt（create_goal + subagent 编排 + 每卷写→审→修 + 不中断 + pipeline 上报 + 停止条件）；章节修订按 pipelineRunId 自动采纳；novel_desk_pipeline MCP 工具；预算估算/baseline/增量/80% 预警/100% 暂停。
- 前端：工具组「📚 整本书」页（八态 UI、阶段进度、预算双条、notes、暂停/恢复/停止/重新开始/stuck 手动继续/done 交给独立审稿人）+ PipelineWizard（模式/设定/规模/预算/准备/启动）+ 总览进度卡 + 新建作品勾选入口。
- 验证：`node --test` 130/130；渲染 harness 覆盖八态/预算/向导/总览/新建入口；goal/prepare prompt 冒烟（create_goal/subagent/不要问作者、蓝图/大纲/planned）。
- 未验证：真实会话中 goal+subagent 自动推进与自动采纳（首次试跑观察）。


### 半成品续写修正（生成全文 / 按 N 章）

- 问题：后端 startRun 本来支持半成品，但前端向导的「按 N 章」没有持久化 N（页面固定 10），「生成全文」没有目标章数输入——半成品若项目没设 targetChapters/大纲会静默走默认或报错。
- 修正：生成设置新增「目标章数」输入（默认项目目标/大纲末章/上次目标，显示当前已写到第 N 章）；启动时把 targetChapter/base/budget 一起提交并持久化；后端 startRun 接受显式 targetChapter，取不到目标时明确提示去生成设置填。
- 测试：新增半成品无目标→拒绝、显式 targetChapter→从第 3 章写到第 6 章；`node --test` 131/131。


## 2026-10-22 · 批量采纳"没反应"排查（B-107）

- 排查：鱼龙舞 proposals.json 显示 59 条全部 accepted（含 world/locations，16:18/16:21），world.json 与 locations.json 同时写入，20 个地点/连接齐全；后端 `proposal.batchAccept` 与 acceptProposal 的 world/locations 分支正常。结论：操作成功，问题是**成功无反馈 + 不跳转 + 不通知对话**。
- 修复（前端）：批量采纳/驳回先显示「处理中…」内联提示；成功后显示「已采纳 N 条（世界 1 · 地点 1 · 高光 3 · …）」；采纳 world/locations 后询问是否去世界页；单条采纳/驳回同样提示；失败保留失败明细弹窗。
- 说明：工作台采纳不会自动发消息到对话（避免刷屏），若需要"采纳后通知对话"可另做开关。


## 2026-10-22 · 扩写（B-108）

- 设计定稿 docs/EXPANSION.md：目标字数必填无默认；book/chapter 两模式；大纲硬边界；大纲变更等待用户确认；全自动；自动采纳+原稿备份。
- 后端：expansion.json 单例、9 个 RPC（get/plan/confirmPlan/start/approveOutline/advance/pause/resume/reset/usage）；宏观方案 prompt（诊断/容量/逐章目标/大纲变更，禁写正文）；执行 goal prompt（create_goal+subagent、大纲锁定、不引入未批准内容、每批审修、自动采纳、大纲闸门、禁注水、冷读不降）；novel_desk_expansion MCP；options（新增上限/样张/允许改大纲）透传并进 prompt；finish 写 report；预算 80/100。
- 前端：整本书页子导航「生成/扩写」+ ExpansionPanel（9 态、目标必填、方案表可编辑、大纲闸门、预算、报告）+ 章节页「扩写本章」入口；轮询 10s。
- 验证：node --test 151/151；渲染 harness TASK-18 通过。
- 未验证：真实会话 goal+subagent 扩写、大纲闸门端到端、真机界面。


### 扩写确定性检查

- lib/checks.js 新增：`expansion-target-missing`（error）、`expansion-under-target`（warn，列出低于目标的章节）、`expansion-outline-pending`（warn，大纲变更未确认）；测试覆盖；总测试 152/152。


### 扩写 P3：大纲外内容与重复度检查

- lib/checks.js 新增：`expansion-scene-unplanned`（新增场景不在方案 additions 且无已批准大纲变更）、`expansion-subplot-unapproved`（旁线未批准）、`expansion-beats-unpreserved`（提案标注 beatsPreserved=false）、`expansion-attention-drop`（scoreAfter < scoreBefore）、`expansion-added-scene-duplicated`（新增场景跨章重复）、`duplicate-passages`（≥24 字整句跨章重复）。
- goal prompt 元信息补 scoreBefore/scoreAfter，便于冷读下降检查。
- 测试：新增 1 条综合检查用例；总测试 153/153。


## 2026-10-22 · 整本书收尾（B-109）

- 新增 final-cleanup 阶段 + 收尾 prompt（按章补齐人物/事实/事件/时间线/高光/伏笔/冲突/地点/大纲/注意力/世界）。
- finalizePipelineCleanup：采纳账本类提案、驳回 pending 章节提案、归档未处理审阅，写 cleanup 报告；finish/advance 自动触发。
- 自动采纳扩展：仅 final-cleanup 阶段账本类提案直接生效。
- pipeline.finalize / pipeline.backfill RPC + MCP finalize；补跑收尾 prompt + 新会话。
- 前端：done 收尾报告卡/未收尾横幅/收尾按钮/补跑收尾按钮/总览「待收尾」/running 收尾文案。
- 测试 162/162；未真机试跑。


### 修 bug：审阅全选加入清单只进一条

- 原因：`addToCart` forEach 逐条调 `onAddCart`，`addCart` 用 `[...cart, item]` 基于同一渲染快照，14 次互相覆盖，只剩最后一条。
- 修复：审阅页一次 `onAddCart(array)`；`addCart` 用函数式更新 + `mergeCartItems`（kind+id 去重）；localStorage 持久化改由 effect 统一处理（载入 key 完成前不写，避免串项目）。
- 验证：渲染 harness 新增 TASK-21（全选 14 条 → 一次 dispatch 14 条；合并去重=15/16），全部通过；`node --test` 162/162。


### 扩写方案确认可见性修复

- 问题：AI 把「要改哪些大纲/待作者批准」写在 plan.notes 与 plan.outlineChanges，工作台只当普通备注显示，无确认入口；用户以为没输出。
- 修复：plan.confirmations（AI 待拍板事项，无则回退 notes 关键词）；plan-ready「⚠ 需要你确认（N）」+ 大纲变更逐条 checkbox + 全同意/取消；confirmPlan 提交 approvedOutlineIds → approvedOutlineChanges；全批准 start→running，未批准→structuring 走闸门；子导航「待确认」徽标。
- 后端：confirmPlan 支持 approvedOutlineIds、start 保留已批准变更、goal prompt 标出未批准变更、MCP plan 保存 confirmations、plan prompt 要求 confirmations。
- 测试 163/163；harness TASK-21 EXPANSION CONFIRM 通过。


### 修 bug：waiting-outline 大纲变更勾选不了

- 原因：waiting-outline 用只读列表；approveOutline 不接受勾选、只认 pending outlines 提案；AI 只把变更写在 expansion.outlineChanges，没有提案 → 后端报"没有待确认的大纲变更提案"，用户看到的就是勾不上/点了没反应。
- 修复：waiting-outline 复用 plan-ready 的 checkbox 清单（全部同意/取消）；approveOutline 接受 approvedOutlineIds，直接从 plan changes 写入 approvedOutlineChanges，置 running 并发送续跑 prompt；按钮未勾选时禁用；兼容旧的无参调用。
- 测试：新增"无提案按 approvedOutlineIds 直接批准"用例；node --test 164/164；harness TASK-21 通过。
