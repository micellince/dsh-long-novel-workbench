# 长篇中文小说工作台 0.6 · 验收证据

记录「重建」这件事当前被验证到什么程度。所有数字都是本机实跑结果，命令可直接复现。

## 一、代码与测试

```bash
cd /Users/micellince/Documents/deepseek-harness/dsh-long-novel-workbench
node --check index.js && node --check client.js && node --check lib/store.js
node --test test/*.test.js
```

| 项 | 结果 |
| --- | --- |
| 语法检查 | `index.js` / `client.js` / `lib/*.js` / `scripts/*.js` 全过 |
| 测试 | **66 tests / 62 pass**（`test/` 10 个文件） |
| 模块规模 | `index.js` 1350、`client.js` 3195（上限 3200）、`lib/` 6 个模块 2845 行、`scripts/` 392 行、测试 1529 行 |
| 依赖 | 只有 `react`（客户端）；宿主端 0 三方依赖、无构建 |
| 切换体检 | `node scripts/preflight.mjs`：检查安装状态 / running 流水线 / 自检，退出码 0 才可切换 |
| 界面交互 | `node scripts/ui-e2e.mjs`：无头 Chrome CDP 真点击/按键/拖拽/输入，真实 HTTP + 真实 store。**59/59 通过**（碧血 52 章 .txt 项目）：挂载 / `/` 聚焦搜索 / 搜索有结果 / 结果定位到具体段落（`.nd-target` 在视口内） / `j` 翻章 / 编辑保存提示 / 落盘 / 备份历史 / `⌘S` 保存 / stale 保护 / 批准提示 / 批准真改正文 / 审阅定位条目 / 勾选生成提案 / 审阅工作单含隔离与四路 / 审阅模式拖拽选中 / 读者批注落库 / 新建章节 / 新章 .txt / 章数 +1 / 新建全文动作 / 开始 running / 完成 done / 导入扫描报规模 / 扫描不建作品 / 导入新建作品 / 保留标题 / 导入 3 章 / 切到导入作品 / **资料库**：人物卡 55 张卡片、时间线 377 条、世界地图 SVG + 3 个缩放按钮、大纲 52 行；**三路审阅**：4 张入口卡 → 范围+重点弹窗 → 工作单带 `ai-style`；**历史版本**：22 个版本可列；**写作预设**：卡片列表 + 绝对模板入口；**账本同步**：正文加入账本人物名 → 保存 → 出现「⚠ 第 1 章正文改到了账本里的名字/数字」并可「已核对」 |
| 界面渲染 | `node scripts/ui-smoke.mjs`：在 StoryDesk **副本**上造 fixtures，无头 Chrome 实测 8 个页面全部挂载、无运行时报错；截图见 `docs/screenshots/0.6-*.png`（阅读/编辑/审阅/提案/全文动作/世界地图/账本/总览/设置） |

测试分工：

- `prose` / `attention` / `store`：纯函数与数据层（含旧 `.md` 双读、备份、stale、注意力四拍合计、scoreHistory）。
- `gates` / `prompts`（在 `api.test.js` 内）：闸门五步、失败项格式化、工作单 prompt 关键约束。
- `api`：34 个 RPC 白名单、鉴权（未认证/异常 Host）、工具清单与参数。
- `client`：3200 行上限、loader id、8 页、只用契约内 op、无 `dangerouslySetInnerHTML`/`eval`、单一 `fetch`、样式 token、装配注册两个 slot。
- `e2e`：真实 store + 真实 HTTP handler，跑完「保存 → 历史 → 版本 → stale → 注意力实测 → 读者批注 → 提案 → 批准落盘 → 闸门拦截」。
- `tools`：6 个 Agent 工具在临时作品上跑通读/审/注意力/提案/写/run，且引文不逐字命中会明确报错（不再静默丢弃）。
- `compat`：旧 `.md` 原地写回（未知 frontmatter 键保留、不新建 txt、备份目录、旧扁平备份名仍可列/可读）。
- `client` 另含阅读偏好：A−/A+/行距按钮，字号 13–28px（0.6.10 起上限从 20 提到 28）、行距 1.6–2.4，存 localStorage（`nd.fontSize` / `nd.lineHeight`），只影响阅读/编辑正文视图，不改正文。

## 二、真实数据（只读）

对 `~/StoryDesk`（旧插件在用，未做任何写操作）实跑：

- 作品库 3 部：碧血青霜缘 52 章 / 471677 字；示例·长夜将明 3 章；鱼龙舞 133 章 / 953902 字。
- 读章：碧血第 1 章 `format=md`、10754 字、`contentHash=611e78ee5080`（旧 `.md` 原地可读写回）。
- 目录 52 章带注意力分（78–84）；对齐简报：待处理审阅 1、待采纳提案 0、注意力均分 82（52 章全测）；账本 facts 486 / characters 55 / events 377 / foreshadow 44 / conflicts 12 / locations 38 / world 1。
- 旧审阅 `chapter:0`（全书意见）在工具输出里显示为「全书」，不再出现「第0章」。
- 旧 `proposals.json` 898 条 0.5.x 提案默认不可见（`includeLegacy` 才返回），不重写、不误删。
- 章节 frontmatter 实测：3 部作品共 188 章，键集合固定为 `id/title/status/summary/location/storyTime/characters`，无未知键。
- 迁移（`/tmp/nd-mig` 上的碧血 52 章副本）：`--dry-run` 只打印计划；`--apply` 转换 52 章 md→txt+meta、归档 legacy/、seed `runs.json`、`project.json` 标 `schemaVersion: 0.6.0`、全量备份到 `.pre-0.6.0/`；再跑一次输出「无需迁移」且不重复备份。迁移前后**正文逐字一致**（第 1 章 8950 字，md→txt）。
  注意：迁移后旧插件只认 `.md`，会显示 0 章——**迁移必须等切换完成、旧插件已被移除后再做**（README 已写）。
  逐字校验：迁移报告 `<项目>/migration-report.json` 记录每章源/新 sha256；`--verify` 复核 `/tmp/nd-mig2` 碧血副本输出「52 章 sha256 全部一致」，手改第 3 章一个字后复核立即报「第 3 章内容变了（报告 48c4b734…，现在 a6177d08…）」；写回与源不一致时保留 `.md` 不删。
- 碧血副本（`/tmp/nd-copy2`）上跑通真实流程：md 章节 → 写审阅（逐字 quote 命中）→ 段落补丁提案 → `acceptProposal` 返回 `ok=true`、闸门通过、md frontmatter 完整、审阅置 `fixed`，改后章节旧插件仍可读（10083 字）。
- 真实旧章副本（`/tmp/nd-copy`，非 `~/StoryDesk`）原地写回验证：仍为 `.md`、七个 frontmatter 键与未知键 `customKey` 全部保留、正文追加生效、旁路写出 `meta.json`、旧插件 `listChapters` 仍能读到改后正文（236 字）。

## 三、安全与共存

- 所有测试用 `STORY_DESK_ROOT` 指向 `mkdtemp` 临时目录；没有测试写 `~/StoryDesk`。
- 写入唯一入口 `writeChapterWithGates`：`normalizeProse → 保真 → 残留扫描 → 去 AI 味 → 落盘`，失败返回 `needs-fix` 且不落盘。
- 网关：`connection.requestRejection` → 回环 + Host 白名单 + `Sec-Fetch-Site` 同源兜底；不返回任何 CORS 头。
- 迁移脚本默认 `--dry-run`；检测到项目 `revision/pipeline` running 时整次拒绝。
- 与旧版 0.5 插件 **不能同时启用**（路由 `/novel-desk/api` 与工具名冲突），切换必须原子执行，步骤见 README「安装 / 切换」。旧仓库目录现名 `dsh-long-novel-workbench-0.5.2`。
- **切换已执行（2026-10-24 17:34，`desktop` profile）**：`remove_bundle dsh-novel-desk`（当时试装名）→ `install_bundle …/dsh-long-novel-workbench`，`application: applied`。
  - profile `package.json` 依赖已由 `dsh-long-novel-workbench: link:旧目录` 变为 `dsh-long-novel-workbench: link:…/dsh-long-novel-workbench`，bundle 列表同步。
  - `GET http://127.0.0.1:64615/novel-desk/api/ping` 无凭证返回 **401 unauthorized**（守卫按 `connection.requestRejection` 生效；旧插件同路径是裸奔 200）。
  - 新开会话实测可见且仅见 6 个 `novel_desk_*` 工具（read/write/propose/review/run/attention），`novel_desk_read({"op":"projects"})` 读到真实 3 部作品（碧血 52 章/501077 字、示例 3 章、鱼龙舞 133 章）。
  - 切换后复跑：`node --test` 69/69、`node scripts/ui-e2e.mjs` 32/32。

## 四、尚未验证 / 明确不做

- **真机浏览器验收待你做**：刷新 DSH 页面 → 侧栏底部 📖 → 应在系统默认浏览器打开网页后台（`app.open` 单测只覆盖 URL 拼接与降级，真机拉起与 cookie 兑换需人工确认一次）。
- 客户端仍未接的 op：`ping`（无需界面）、`proposal.get`（列表已含全文，暂不需要）、`proposal.batch`（与「逐条批准」的设计相悖）。
- 审阅→提案改为走 AI：UI 生成 `proposalGroupsWorkorder` / `globalFixWorkorder` 工作单，AI 用 `novel_desk_propose` 提交「after 已成文」的 `patch-paragraph` 或跨章 `book-fix` 提案；旧的确定性转换（`before=quote`、`after=suggestion`）已删除（它会把写作建议直接写进正文，见 2026-10-25 返工记录）。
- 旧项目批量 `migrate --apply` **未执行**（真实数据 188 章仍是 `.md`；双格式读写已兼容，迁移在你发话时再做）。
- 不做：Markdown 正文/富文本编辑、独立服务器、云端多用户、协作冲突合并（`baseHash` 冲突只提示不自动 merge）。

## 2026-10-24 界面返工（用户反馈后）

| 需求 | 实现 | 证据 |
|---|---|---|
| 只迁碧血、删另两部 | 碧血 52 章 `.md` → `.txt` + `.meta.json`，`--verify` 52 章 sha256 一致；另两部移到 `~/StoryDesk/.trash-20261024-175034/` | 迁移输出 + `library.json` 只剩 1 部 |
| 侧栏只留一个按钮 | `SidebarEntry` 单按钮 📖：Electron 里直接在默认浏览器打开，失败给提示；DSH 桌面壳不再叠浮层（`shell.overlay` 只在浏览器标签注册） | `test/client.test.js` + 冒烟截图 |
| 三种模式说明 | 阅读＝纯读不改正文 / 编辑＝直接修改正文 / 审阅＝选中文字提交批注 | 阅读页 `nd-mode-legend` 文案 + e2e |
| 世界地图 | 并入账本页签；按地点坐标直绘 SVG（分区底纹 / 水线 / 山形 / 驿道路线 / 地名避让）+ 四个图层开关 + 全屏滚轮缩放 / 拖动 / 重置 + 点地点出地点卡；不再有「生成底图 / 换画风 / AI 出方案」按钮 | e2e：`.ndm-zone` / `.ndm-route` / `.ndm-pt` / `.ndm-label` + 开关 + 放大/重置/关闭；`node --test` 含 6 条地图模型单测；截图 `0.6-map-model.png` |
| 人物卡 | 卡片：首字头像 / 姓名 / 角色 / 目标 / 缺陷 / 弧光 / 关系 | e2e：55 张卡；截图 `0.6-ledger-characters.png` |
| 时间线 / 大纲 / 高光 / 冲突 / 伏笔 | 账本 9 页签；旧 `highlights.json`、`outlines.json` 已能被 store 读出 | e2e：时间线 377 条、大纲 52 行 |
| 三路审阅入口 | 审阅页四张卡（AI 味 / 事实逻辑 / 注意力 / 四路一起）→ 选范围 + 填重点 → 工作单 | e2e：4 张卡 + 工作单含指定 `ai-style` |
| 账本同步 | `chapter.save` 后做账本信号 diff（人名/地名/事实数字），有信号才写 `ledger-sync.json`；账本页横幅可「让 AI 核对」或「已核对」 | e2e：正文加入「哥舒翰」→ 出现同步提醒 |
| 版本入口 | 正文工具栏「历史版本」（所有模式可见）→ 列版本 → 预览 → 载入编辑器 | e2e：22 个版本可列 |
| 预设丰富 + 绝对模板 | 5 套内置预设（含 pacing/taboo/reviewFocus/人物功能）；设置页预设卡片（应用/编辑/删除/＋新建/复制绝对模板）；字段说明见 `docs/PRESET-TEMPLATE.md` | e2e：预设卡片 + 绝对模板入口；截图 `0.6-settings-presets.png` |
| 注意力曲线坐标轴 | Y 轴 0/25/50/75/100 + 「分」，X 轴章号 + 「章」，点提示「第 N 章 · X 分」 | 截图 `0.6-overview-curve.png` |

同时修复两处真实缺陷：`lib/store.js` 基础 helper 曾被误删导致 `nowIso is not defined`（已重写并补 `createProject`/`realpath` 越界校验）；总览「待处理审阅」与服务端 `align.status` 计数口径不一致（已统一为 open/proposed）。

本轮校验：`node --test` **78/78**；`node scripts/ui-e2e.mjs` **59/59**；`node scripts/ui-smoke.mjs` 11 个画面全部挂载无报错；`preflight` 结论「已切换」。

### 2026-10-24 第二轮界面调整（人物卡 / 地图 / 时间轴）

- 人物卡：卡面只留「头像 + 姓名 + 角色 + 两行摘要」，按角色分组（主角/反派/配角/龙套），不同组左边条与底色不同；**点卡面弹详情**（目标/缺陷/弧光/关系/首现章/备注，弹窗内可编辑）。
- 世界地图：改成 **n×n 方格底纹 + 地点圆点 + 地名标注**（不再画连线）；地名做碰撞避让（重叠的自动只显示点，选中点必显）；右侧是地点卡（区域/别名/坐标/相关事件/编辑入口），缩放 100–300% 仍在工具栏。删掉底部那排无意义的地点卡。
- 时间线：**以故事时间为轴**（解析「至德二载（757）正月」这类写法；缺年份按章节顺序沿用上一年，月份回跳视为跨年），按「年/月」分组显示，事件内仍带章号链接可跳正文。
- e2e 增加 5 条断言：人物卡点开详情、地图方格底纹、地图按点标注、点地图出地点卡、时间线按时间分组 → **59/59**。

### 2026-10-24 地图再改（填满 / 路径 / 分区 / AI 底图）

- 地图不再画 n×n 方格，改为**按点位包络铺满容器**（等比缩放，相对距离不变），删掉底部那排地点卡；点地图点才在右侧出地点卡。
- 新增「分区底图」：按地点 `region` 聚成色块区域 + 区域名，给地图一层地理感。
- 新增「路径」开关：把事件里出现过的地点按章节顺序连成**棕色虚线**，并标出途经点（默认开）。
- 新增「✨ AI 底图方案」：生成 `mapBackgroundWorkorder`（世界观 + 地点分布 + 走过路线），弹窗里可复制或直接发到宿主对话。
- 截图更新 `docs/screenshots/0.6-ledger-map.png`；e2e 增加「分区底图 / 主角路径 / AI 底图方案」三条断言 → **59/59**。

### 2026-10-24 地图第三轮：疏密自适应 + 全屏滚轮缩放

- **不再按真实距离摆放**：新增「疏密自适应」投影（12×12 密度网格 → 每列/行宽度 ∝ 密度^-0.85），点密的区域拉开、点稀的远点拉近；再跑一轮散点位移（最小间距 30px、弱回弹），避免地名叠成一团。
- **地图改成全屏弹窗**：账本「世界地图」页只留一张预览卡，点它弹出全屏地图；全屏里**滚轮对准地名放大/缩小**（缩放锚点跟着鼠标）、拖动平移、`重置`/`Esc` 关闭，缩放百分比显示在标题栏。
- 页内不再放缩放按钮（用户反馈容器内缩放鸡肋）；分区底图/路径/疏密自适应开关移进全屏标题栏。
- e2e：预览→全屏→滚轮 viewBox 变化→点开出地点卡→关闭，全链路断言通过 → **59/59**；截图 `docs/screenshots/0.6-map-full.png`。

### 2026-10-24 会弹「发到对话失败」的修复

- 根因：DSH `sessionController.list()` 会返回子代理路由的会话（`origin:'subagent'` 或带 `parentSessionId`），旧选择逻辑只按 `cwd` + `updatedAt` 取最新，正好挑中它，投递时被 `owned by subagent routing` 拒收。
- 修复：只挑普通会话（排除 subagent / 子会话 / `agentAvailable:false`）；首选投递失败自动换下一个；都失败时新建会话再试；失败提示改为「可点复制贴到 DSH 对话框，或先在 DSH 新建会话」。
- 客户端：`sendToChat()` 遇到「子代理会话/没有可投递会话」自动带 `newSession:true` 重试一次；三种发送成功提示都补「去 DSH 侧栏最近的会话里找它」。
- 新增 `test/chat.test.js` 4 条（跳过子代理会话、失败换会话、指定子代理会话报错、无可投递时给可操作提示）→ 单测 **78/78**；e2e **59/59**。

### 2026-10-24 跳回对话 + 选择目标会话

- 旧插件早就支持「工作台 → 对话」跳转：`clientCtx.get('uiWorkspace').openSession(sessionId)`。0.6 的网页后台就是 DSH 页面本身（token 打开、插件注入），所以同样能调用，之前只是没接。
- 新增 `chat.sessions`（读 op，第 35 个）：只返回普通会话（过滤 `origin:'subagent'` / `parentSessionId` / `agentAvailable:false`），优先当前作品工作区的会话，最多 30 条。
- 三个发工作单的弹窗（审阅 / AI 底图 / 账本同步）都加「发到」下拉：自动（最近在用）/ 新开一个对话 / 指定会话（带「进行中」标记与标题）；发送成功后 `openSession()` 并关闭工作台，直接落到那个对话，工作单已经在输入框里排队。
- 找不到标题时显示会话 id 前 8 位；跳转失败（宿主没暴露 `uiWorkspace`）退回原来的提示，不丢工作单。
- 验证：单测 **78/78**（新增 chat.sessions 过滤用例）、端到端 **59/59**（新增「工作单可以选发到哪个对话」断言）。

### 2026-10-24 地图底图生成 + 发送两步确认 + 工作区会话限定

- **一键生成底图（本地、立即生效）**：`map.background`（第 36 个 RPC）按世界设定 + 地点坐标 + 主角路线生成程序化底图：纸色/水系三条（黄河—汴河—运河、江南水网、蜀江，均标「推测」）+ 山形（关隘/山名地点 + 种子撒点，避开河道）+ 四套画风（水墨绢本/赭石古卷/青绿山河/羊皮纸）。写入 `world.json.mapStyle`，刷新仍在；工具栏「✨ 生成底图 / 换一版 / 清掉底图」。
- **不再把「生成」做成 prompt**：AI 入口保留但改名为「🤖 让 AI 出文字方案」，明确它只出分区/地形/画风建议；直接可见的底图由插件自己算。
- **发送两步确认**：三个弹窗（审阅工作单 / 账本同步 / AI 底图方案）的提交按钮改为「下一步：确认发送」→ 选目标会话 → 「确定发送」；不再点一下就发出去。
- **只发到本作品工作区的对话**：`chat.sessions` 严格按 project.workspacePath 过滤（不再回退到别的工作区会话）；`chat.send` 若指定会话属于别的工作区直接拒绝并说明；没有本工作区会话时只允许「新开一个对话」（用 project.workspaceId 在正确工作区创建）。
- 验证：`node --test` **78/78**；e2e **59/59**（新增：生成底图有山形与水线、换一版仍有效、清掉后消失、发送前多一步「确定发送」、会话列表只列本工作区）；截图 `docs/screenshots/0.6-ledger-map.png`。

### 2026-10-24 底图去预设（用户：换一本书就露馅）

- 删掉写死的「黄河—汴河—运河 / 江南水网 / 蜀江」三条线；改成**从作者自己的地点推地形**：
  - 水系：`type` 或名字命中地貌词（中英文：江/河/湖/海/溪/川/渡/湾/港/泉/泽/洲/滩/岸、river/lake/sea/canal/ford/bridge/port/harbor/dock/stream/marsh…）的点，按最近邻（≤380 单位）串成折线，标签统一为「水系 N（按地点推测）」。
  - 山形：`type` 命中 mountain/pass/valley/cave/gorge/hill/cliff/ruin/山/峰/岭/关/谷/崖/岩/峡/洞/丘/隘 或名字带这些字，再加种子撒点（避开河道与已有点）。
  - 没有水点就不画河；换奇幻作品（castle/wall/forest 之类自造类型）时可在 `world.json` 的 `terrain.waterTypes` / `terrain.ridgeTypes` 补词典。
- 画风加「冷灰史诗」「暗红纪事」两套（共六套），`换一版` 连种子带画风一起换。
- 回归测试：`test/api.test.js` 新增「冰与火之歌测试」——castle/river/ruin/mountain 数据下必须出「水系 N」且断言**不出现**黄河/汴河/运河/蜀江等专名；单测 ****70/70****。

### 2026-10-24 AI 地图方案的回路 + 底图观感

- **补上「AI 方案贴回」入口**：地图工具栏 `📥 贴回 AI 方案`（已存过则显示 `📥 AI 方案（已贴回）`）→ 粘进 AI 回的「区域 / 路线 / 绘制提示词」→ 保存进 `world.json` 的 `mapStyle.aiPlan`，随时点开查看/修改；不会自动改地图。
- **底图调淡**：「✨ 生成底图」的山形更小更淡（anchor 7–12、撒点 4.5–9.5、16 个）、水系更细（8px、0.55 透明度）、山形 0.32 透明度；默认不生成，点「清掉底图」可完全去掉。
- **地形仍只从作者数据推**（见上一节），不写死任何书名/河名。
- 验证：`node --test` **70/70**；e2e **59/59**（新增：贴回框能输入、方案存得下、原样读回）。

### 2026-10-24 AI 直接保存地图方案（第 7 个工具）

- 新增 Agent 工具 `novel_desk_map`：
  - `op=plan`：返回世界名、地点/坐标数、水点与山点的候选数、六套画风、现有底图与已存方案；
  - `op=save`：`aiPlan`（区域/路线/绘制提示词全文）直接写进 `world.json` 的 `mapStyle.aiPlan`；可选 `palette` 换画风、`seed` 换一版，顺带重生成底图。
- 「🤖 让 AI 出文字方案」的工作单结尾改为：**写完直接调用 `novel_desk_map(op=save)`**，AI 保存后只回一句「已存进作品」；人不再需要复制粘贴回弹窗（`📥 贴回 AI 方案` 保留为手工兜底）。
- 工具数 6 → **7**；`test/api.test.js`（定义齐全/apply 注册）与 `test/tools.test.js`（plan→save→读回 world.json、palette 生效、缺 aiPlan 报 invalid、未知 op 报 invalid）同步；单测 **70/70**。

### 2026-10-24 地图重画：从「随机三角 + 彩圈」改成坐标可信的地图

问题：点「✨ 生成底图」得到的是 24 个模糊彩圈 + 18 颗随机三角 + 一条三点折线——地形跟着自己的随机坐标走，地点却先被 bbox 拉伸、再过 12×12 密度变形、再被 30 单位斥力抖过一遍，两层永远对不上；AI 方案里写着精确的 `x 250–420，y 495–630`，却只当文本存着从不参与绘制。

改法（全部在 `client.js`，不动 `index.js`，刷新页面即生效）：

- **删掉生成链路**：移除「生成底图 / 换一版 / 清掉底图 / 让 AI 出文字方案 / 贴回 AI 方案」五个按钮和两个弹窗，客户端不再调用 `map.background`、不再用 `sendToChat` 发地图工作单。少花 token，也少一堆和地点对不上的图形。
- **纯函数模型层**（`/* @novel-desk:map-model start */` 标记内，测试直接切出来跑）：`buildWorldMapScene({world,locations,events})` 产出区域 / 水线 / 山形 / 路线 / 地点 / 地名，全部在世界坐标里算；`mapSceneToSvg(scene, view)` 能整张导出成独立 SVG。
- **世界坐标直绘**：删掉 bbox 适配、`buildDensityWarp`、斥力松弛，`viewBox` 直接用世界坐标（已外扩到地名不被裁切），SVG `preserveAspectRatio="xMidYMid meet"` 交给浏览器缩放。
- **分区用 AI 方案里的真坐标**：解析【区域】行 `地名｜x a–b，y c–d｜地貌`，画极淡圆角虚线底纹 + 分区名；解析失败才按地点 `region` 归并兜底。
- **路线**：解析【路线】行（`起点→终点｜地形｜备注`，也支持 `线路名｜A—B—C｜备注`），能落到真实地点的画虚线驿道，按文字判水/陆；无方案时按事件 `location` 顺序串行程线。
- **山形**沿山名地点（mountain/pass/关/山/谷/岭/岳）的走向撒成山脊，水线只在真有水点时才出现，并标河名（「渭水」「孝水」）。
- **地名避让**：按重要性排序试 16 个方位，放不下就放大后带引线出现；区域名、河名与地点名共用同一套碰撞表。
- 新增 `test/map-model.test.js` 6 条：区域解析到世界坐标、地点不做二次变形、河名不从「与/和」处截断、地名互不重叠、能导出独立 SVG、无方案时兜底。

验证：`node --test` **76/76**（原 70 + 地图 6）；`scripts/ui-e2e.mjs` 的地图段改成新选择器（`.ndm-zone` / `.ndm-route` / `.ndm-pt` / `.ndm-label` / 图层开关 / 放大 / 重置 / 关闭）。

### 2026-10-24 导出正文（用户：插件的导出正文没了，可以选择 txt、md、epub 等）

问题：重写成 0.6 时把旧插件的导出整条链路（`lib/exporters.js` + `lib/zip.js`）丢了，正文页和设置页都没有导出入口，作者想交稿只能自己复制粘贴。

补回来的做法（零新依赖）：

- **`lib/zip.js`**：从旧仓库移植的零依赖 ZIP（crc32 + store/deflate，无 ZIP64；DOS 时间戳固定，同内容同字节）。
- **`lib/exporters.js`**：`EXPORT_FORMATS = ['txt','md','epub','docx']` 与 `EXPORT_META`（扩展名 / MIME / 文案）；`normalizeFormat` 支持别名（markdown→md、epub3→epub、word/doc→docx、text→txt，空值默认 txt，非法值抛 `code='invalid'`）；`bookFilename`（非法字符→`_`、截 80 字、空标题→未命名作品）；`chapterTitle`（已带「第N章/回/节/卷/部/篇」原样用，否则补「第 N 章　标题」）；`contentBlocks` 统一排版并剥离写作期残留（`#`、`**`、`~~`、行内码、链接、HTML、列表符）；`buildBookText` / `buildBookMarkdown` / `buildEpub`（EPUB 3：mimetype 首条不压缩、container.xml、content.opf、nav、style.css、稳定 uuid）/ `buildDocx`（WordprocessingML）。
- **`lib/store.js`**：新增 `exportBundle`（逐章读正文，单章损坏跳过）与 `exportBook`（txt/md 回 `text`，epub/docx 回 `base64`）。
- **`index.js`**：新增只读 RPC `export.book`（读 19 + 写 18 = **37 op**）。
- **`client.js`**：`triggerDownload`（base64 → Blob，或 UTF-8 文本 → Blob，`<a download>` 触发后 revoke）；`downloadExport`；顶栏「⬇ 导出」打开 `ExportDialog`（格式 Select + 可勾「附章节提要」+ 导出并下载）；设置页新增「📤 导出正文」卡片，四个格式各一个快捷按钮。
- **`test/export.test.js` 16 条**：格式/别名/文件名/章名/排版块纯函数；TXT 保留 `※`；MD `***`；EPUB 与 DOCX 用自带最小 ZIP 解析器读回，验证条目齐全、mimetype 首条且不压缩、OPF 两个 itemref、nav 引用、章节文件名去重、空书兜底；并断言成品里没有 `##` / `**` / `>` / 列表符。`store.exportBook` 在临时数据根上跑四种格式；`handleRpc` 验证分发、参数透传与非法格式错误码。
- 同步更新契约数字：`test/api.test.js` 36→37 / 读 18→19，`test/client.test.js` 契约 op 36→37；`npm run check` 增加 `lib/exporters.js` / `lib/zip.js` 语法检查。

验证：`node --test test/*.test.js` **92/92**；`npm run check` 通过；`node scripts/preflight.mjs` 自检通过（pass 92 / fail 0）。

界面验证（无头 Chrome + 真实 handler，跑在真实 52 章项目副本上）：

- `node scripts/ui-e2e.mjs` **69/69 通过**（原 60 条 + 导出 9 条）：顶栏「⬇ 导出」出现 → 弹窗列出四种格式 → 切到 epub → 「导出并下载」→ 文件真的落到下载目录（`碧血青霜缘.epub`，832 KB）→ ZIP 头与 `mimetype` 正确 → 弹窗回报「已导出 碧血青霜缘.epub（53 章 / 501096 字）」→ 设置页「📤 导出正文」卡片 → 「TXT 纯文本」按钮下载成功（616665 字符，含章节标题、无 `##` / `**` 残留）。
- 真实大文件复核：`unzip -t` 无错；58 个 ZIP 条目、`mimetype` 首条且内容为 `application/epub+zip`；`content.opf` / `nav.xhtml` / 53 个章节 XHTML 全部 XML 可解析；`itemref` 53 个。DOCX 用 `python-docx` 打开：14 段、样式 `Title` / `Heading 1` / `Heading 2` / `Scene Break` 均生效。
- 截图：`docs/screenshots/0.6-export-dialog.png`（顶栏「⬇ 导出」→ 弹窗，格式下拉 + 附章节提要）、`docs/screenshots/0.6-export-settings.png`（设置页右列顶部「📤 导出正文」四个格式快捷按钮）。

## 0.6.1 增量：提案批量 + 开新书向导（2026-10-24）

- **提案页**：待批准提案的卡片头常显「批准 / 驳回」（原来藏在展开态）；列表顶部「全选 + 已选 n / m + 批量批准 + 批量驳回」，批量驳回要求原因并写到每一条提案。后端 `proposal.batch` 透传 `{reason}`，`lib/store.js` 的 `batchProposals(..., options.reason)` 写入 `rejectReason`。
- **开新书向导**（总览页 / 空库页「＋ 开新书」）：第一步只填书名（也是工作区名）→ 选预设（4 套内置口径 + 「自定义（让 AI 定）」，空模板留在设置页）→ 写一段想法 → 创建并把工作单发到对话。
  - 选内置预设：工作单按预设口径生成世界 / 地点 / 人物 / 全书大纲 / 冲突 / 伏笔，全部以 `ledger-fix` 提案提交。
  - 选「自定义（让 AI 定）」：工作单先让 AI 用 `kind="presets"` 提交一份方案（类型 / 基调 / 视角 / 篇幅 / 结构 / 风格规则 / 禁忌 / 审稿重点），批准后自动套用为本书当前预设（章数 / 字数 / 视角一起生效），再生成设定与大纲。
- **新增 RPC**：`preset.defaults`（读）、`project.create`（写）；契约 op 数 37 → 39。
- **新书独立工作区**：`project.create` 会通过宿主的 `workspaceRegistry` 在默认工作区同级建 `<作品名>/` 目录并注册成 DSH 工作区，把 `workspaceId / workspacePath / workspaceTitle` 写回 `project.json`；开新书的工作单用 `chat.send {newSession:true}` 投到「这本书工作区里新开的对话」，不会再落进作者当时正在聊的会话。老作品 / 导入作品第一次 `chat.send` 时也会自动补建工作区。空书的总览页另有「发工作单：生成设定与大纲」按钮，用于给旧版本建的空作品补工作区与底座。
- **改名**：发布名恢复 `dsh-long-novel-workbench`，版本 `0.6.1`；旧 0.5.2 仓库目录改名为 `dsh-long-novel-workbench-0.5.2` 留档；profile 依赖键与 bundle 列表同步，GUI 需刷新或重启一次才会加载新包。
- **验证**：`node --test` **98/98**；`node scripts/ui-e2e.mjs` **79/79**（新增批量批准/批量驳回、开新书第一步只要书名、自定义预设卡、创建→进入作品）；`node scripts/ui-smoke.mjs` 14 个画面全部挂载；截图见 `docs/shots-0.6.1/`。

### 0.6.1 修复：ledger-fix 提案「没有 ledgerFixes」无法批准

- **现象**：批准开新书工作单生成的账本修订提案（世界 / 人物 / 大纲 / 冲突伏笔等）报「采纳失败：ledger-fix 提案没有 ledgerFixes」，批量批准同样全部失败。
- **根因**：`novel_desk_propose` 收到 `items=[{kind,id,patch}]` 时原样写进 `data.items`，而 `acceptProposal` 只认 `data.ledgerFixes` 或「`data.kind` 为账本类型 + `data.items`」，两条都不满足 → 修订项为空。工作单要求的正是 items 写法，所以每次开新书都会落一批批不了的提案。
- **修复**：`lib/store.js` 新增 `ledgerKindOf(value)` / `ledgerFixesOf(data)`，采纳时统一兼容 `data.ledgerFixes`、`data.items=[{kind,id,patch}]`、`data.kind`+裸 patch 列表、单条 `data.kind`+`patch`；`index.js` 的 `normalizeProposalPayload` 在提交时把 items 写法规范化成 `data.ledgerFixes`，`propose` 工具对空修订项直接报错；采纳前先整体校验 `kind`，非法则整单拒绝（不半写入）。提案页「账本修订」区块改走同一套兼容解析并显示条数，旧提案无需迁移即可批准。
- **回归**：`node --test` **99/99**（新增 items 写法、0.5 裸 patch 写法、空修订项、非法 kind 原子性、提交即规范化的用例）；真实数据副本（`StoryDesk/projects/pm03b6046ccc24`）里 8 条 pending `ledger-fix` 全部批准成功，账本写入 facts 20 / characters 12 / foreshadow 10 / conflicts 3 / locations 13 / outlines 68 / presets 6。


### 0.6.1 功能修复：全文动作重设 / 章节删除 / 用量 / 导入（2026-10-24）

作者反馈三件事：全文动作只有重写/改写「太简约」、正文与新章没有删除按钮、用量统计不准（0.5 是准的）；另要求导入和导出放一起、任何作品都能导入、不强制 `0001.md`。

**① 全文动作三类**（`lib/store.js` 的 run 存储不变，`index.js` 重写 `runTool` / `formatRun` / 阶段模板）：

- `kind`：`continue`（从头写新章）/ `expand`（扩写）/ `rewrite`（改写）；`rewrite.variant` 再细分 `style`（文风）/ `logic`（逻辑与事实）/ `structure`（结构与节奏）。旧值 `rephrase` 归一为 `rewrite + style`，旧 run 打开不报错。
- `scope` 增加 `range` + `endChapter`；每种动作有独立阶段模板（continue：读大纲与账本 → 规划本章场景 → 逐章写作 → 闸门校验 → 本章自检）。
- **最关键补丁**：0.6 之前全文动作页只有状态按钮，`runGoalPrompt` 工作单从来没有被发出过——建了 run 也不会动笔。现在 RunTab 加「开工（发工作单）」：`chat.send {workorder:'runGoalPrompt', run}` 发进本书对话，成功后才把 run 置 `running`。
- `continue` 是唯一会写新章的动作（走既有 `novel_desk_write` → 闸门 → 落盘，新章天然跳过保真）；`expand/rewrite` 仍只进提案。正文页动作区加「从头写下一章」（自动取最大章号 +1），RunDialog 的章号改成数字输入（空书也能指定），不再只能从 toc 下拉选。

**② 章节删除**：`lib/store.js` 新增 `deleteChapter`，RPC `chapter.delete`（写 +1 → 40 op）。目录行「✕」（悬停显示）与正文页「删除本章」（确认框）都可删；一并清 reviews / attention / 本章 pending 提案，已采纳/已驳回提案留历史；已删章的 `.backups` 历史版本保留。

**③ 用量**：`lib/usage.js` 从 0.5.2 原样移植（`encodeCwd` / `parseSessionJsonl` / `zstdDecompressAll` 多帧 zstd / `loadChatUsage` / `loadModelPrices` / `estimateSessionCost`），`index.js` 新增 `summarizeUsage(ctx, s, root, projectId)` 并替换 `usage.summary`：按作品工作区找根会话 + `parentSessionId` 子代理会话族，读 `~/.dsh/sessions` 日志里的 `data.usage` 累计 tokens，用 models.dev 价目（兜底内置价、高峰 ×2）估 CNY；旧 `usage.json` 形状仍放在顶层兼容，新增 `chat` / `workbench` 明细。不再出现「0.6 永远读不到调用」的问题。

**④ 导入**：设置页「📥 导入旧稿」从最底部的数据位置之后移到「📤 导出正文」正下方；顶栏「⬆ 导入」直达。扫描支持**任意目录**（递归找 `.md/.txt`，深度 ≤4，有 `chapters/` 优先；跳过隐藏目录 / node_modules / .backups）与**单个文件**（先按「第X章」标题拆章，≥2 个才拆，否则整篇一章）；章号优先文件名数字前缀、冲突或缺失时按自然序 1..N；标题取 frontmatter / 首个标题行 / 文件名。原来的「必须有 chapters/0001.md」限制去掉。

**回归**：`node --test` **110/110**（新增：删除章节清理与提案保留、run continue/range 与非法 variant、import.scan 目录任意命名 + 单文件拆章、usage.summary 无 sessionController 兜底、client 侧开工/删除/导入文案与位置）；`node --check` 全部通过。

## 0.6.2 注意力一号原则回归（2026-10-24）

作者反馈：0.6 构建把「ATTENTION IS ALL YOU NEED」弄丢了——从 AI 预设到生成提案全程没有注意力机制，全文写作也没有注意力全局管理。0.6.2 按旧版口径恢复，但**不新增第 4 种 proposal kind**（0.6 契约只允许 patch-paragraph / rewrite-chapter / ledger-fix）：注意力设计仍落在 `novel_desk_attention op="design"` 的 attention.json 记录上，生成入口靠 prompt 与硬校验保证「先设计、再动笔」。

**① 所有写/改工作单第一行注入原则**（`lib/prompts.js`）：

- 新增 `ATTENTION_PRINCIPLE`（`> ATTENTION IS ALL YOU NEED——…先提交本章注意力设计（四拍 + designScore），再动笔。`）与 `attentionBriefLines()`：第一优先级段、全书均分/已测/最弱环节、最近 6 章曲线（`第N章 72分/event（设计 80，实测-设计 -8）`）、疲劳预警、目标 designScore、主类型建议、`## 补强要求（强制）`（设计-实测 ≥20 或实测低于均分 10 分时点名最弱一环）、`## 四拍要求`。
- 首行注入：`runGoalPrompt`（从头写 / 扩写 / 改写）、`chapterRewriteWorkorder`、`fullBookProposalWorkorder`、`newBookWorkorder`、`attentionDesignWorkorder`。`attentionRecheckWorkorder`（零上下文冷读）**不注入**，保持读者视角纯净。
- run 执行流程第 0 步固定为「先设计再读材料」；continue 每开新章先补设计；rewrite/expand 范围每章补齐设计后，才允许写/改正文。
- 开新书工作单新增「本书注意力总设计」段：自定义方案 `patch.attentionPlan = {principle,targetAvg,openingHooks,mainTypeRotation,payoffCadence,cliffRule,fatigueRule}`；大纲条目 `patch.attention = {type,hook,tension,payoff,cliff,question,designScore}`。

**② 硬校验与全局提醒**（`index.js` / `lib/store.js`）：

- `novel_desk_attention op="design"`：缺 type / 四拍任一 / designScore（0–100）直接拒绝，错误文案带「注意力设计未通过（ATTENTION IS ALL YOU NEED）」。
- `novel_desk_write` 成功落盘后若该章没有设计记录，返回「⚠ 注意力提醒：…先 design 再写下一章」。
- `novel_desk_run op="start"`：全书无设计时返回「⚠ 全局提醒…本 run 第一步必须是注意力设计」，否则提示本次范围先补齐。
- `chat.send` 生成工作单时把 `attention` 传给 `lib/prompts.js`；`formatContext` 与工作台转交 prompt 也先给原则 + 注意力简报。
- `lib/store.js`：新提案硬校验——AI 自定义方案（`presets` / `preset-ai-custom`）缺 `attentionPlan`、新建大纲（`outlines`，`patch.id` 为空）缺四拍 `attention`，提交即整条拒绝；批准大纲提案时把 `patch.attention` 同步 merge 进 `attention.json`（`status=planned`），开新书一批准就能在 hero/曲线/run 简报里看到设计记录。旧数据、界面直接编辑账本、带 id 的大纲维护、其余三种提案不受影响。
- run 阶段模板首阶段改为 `{ id:'attention', title:'先定注意力设计' }`（continue 共 6 阶段）；client 的 DEFAULT_STAGES 同步。

**③ 界面**：顶栏下常驻原则条 `⚡ ATTENTION IS ALL YOU NEED`（所有页签可见，含欢迎页）；总览页置顶 hero（平均注意力 / 最低三章 / 未测章数）；全文动作页顶部「第一步永远是注意力设计」提醒卡；开新书向导的「自定义」卡与第二步说明写明 AI 必须先出注意力总设计。

**④ 验证**：`node --check` 全过；`node --test` **120/120**（新增 `test/attention-first.test.js` 6 条：写/改工作单首行原则、run 全局块与强制补强、design 缺项拒绝、write/run 提醒、preset attentionPlan 与 outlines attention 硬校验、普通提案不受影响；同步 `api.test.js` 的 run 阶段断言、`tools.test.js` 的 attention 首阶段断言、`store.test.js` 的自定义预设 fixture）。界面：`node scripts/ui-smoke.mjs` 12 个页面/页签全部挂载成功（截图见 `docs/shots-0.6.2/`：overview hero / run 首阶段 / 原则条）；`node scripts/ui-e2e.mjs` **81/81** 通过（真实 handler + 临时数据副本，含开新书、总览 hero、导出、提案批准、无标记页不被覆盖）。`npm run preflight` 通过：插件已安装（link）、无 running 流水线、120/120。

## 0.6.2 DSH Remote / 手机覆盖修复（2026-10-24）

> 0.6.3 修正：标记从 query 改到 hash（认证 303 会丢 query），且手机不再被 `!IS_MOBILE` 挡住；以下保留当次实现与验证记录。

作者反馈：用 DSH Remote（dsh-pocket）手机远程时，工作台会覆盖 DSH 页面；工作台是弹起的 HTML，要求先查原因。

**根因**：dsh-pocket 把同一套 DSH Web 页面交给手机浏览器，`client.js` 的 `IS_BROWSER_TAB` 只按「UA 不含 Electron」判断，手机浏览器为 true；模块 `apply` 里随后无条件 `setOpen(true)`，而 `.nd-overlay{position:fixed;inset:0}` + `.nd-overlay.nd-standalone` 铺满视口。手机端 `.nd-top` 单行不换行、`.nd-panel{overflow:hidden}` 会裁掉右侧关闭按钮，手机又没有 Esc，重载又自动打开 → 无法回到 DSH。问题不在 pocket，而在「任何浏览器标签」都被当成「显式打开的工作台」。

**修复**：
- `index.js` `browserUrl()` 返回的 URL 加显式标记 `?novel-desk=1`（有 token 时用 `&`；保留 hash；重复调用不重复加）。只有带标记的页面才自动展开工作台。
- `client.js`：新增 `IS_STANDALONE_TAB`、`IS_MOBILE`（pointer coarse 或宽度 ≤900），自动展开条件改为 `IS_STANDALONE_TAB && (!IS_MOBILE || __ND_TEST_FORCE_OPEN__)`；手机/窄屏默认保持 DSH，用户点侧栏入口才打开。
- 手机兜底：新增 `.nd-mobile-close` 右下角常驻关闭按钮（固定 + safe-area），桌面顶栏 ✕ 在 ≤900px 隐藏避免重复；新增 `MOBILE_CSS`（overlay/panel 满屏、顶栏换行、项目选择独占一行、导航横排可滚、正文页目录变横向条、侧栏隐藏、双栏/全文动作/地图单列、弹窗限宽、统计卡两列等）。
- 回归测试：`test/api.test.js` 的 `browserUrl` 断言改为带 `?novel-desk=1`，并新增 token+hash / 不重复标记用例；`test/client.test.js` 新增「只有显式链接且非手机才自动展开 + 手机关闭按钮 + 窄屏样式」源码断言；`scripts/ui-smoke.mjs` 页面 URL 带标记、支持 `--size`；`scripts/ui-e2e.mjs` 导航带标记，并新增「无标记页不被覆盖 / 显式链接自动打开」两条。

**验证**：`node --check` 全过；`node --test` **120/120**；`node scripts/ui-smoke.mjs`（1680×1000）12 个页面/页签全部挂载；`node scripts/ui-smoke.mjs --size 500x844` 窄屏（headless 最小布局宽度 500）12 页全部挂载；另用 CDP `Emulation.setDeviceMetricsOverride(390×844, DPR2)` 真实手机视口截图确认顶栏换行、原则条纵向两行、导航横排可滚、目录横向条与右下角关闭按钮（`docs/shots-0.6.2/0.6.2-mobile-overview.png`、`0.6.2-mobile-run.png`）；`node scripts/ui-e2e.mjs` **81/81** 通过（含新增两条远程保护检查）。

## 0.6.2 章节标题落库修复（2026-10-24）

新书《暂定》的 40 章由 AI run 写成后，run 备注报告「章节标题没有保存」：目录只能显示「第 N 章」，`chapters/00NN.meta.json` 里的 `title` 全部是默认值。

**根因**：`lib/gates.js` 的 `writeChapterWithGates` 在落盘时自己重拼 meta——正常路径是 `const nextMeta = { ...currentMeta, gate: result.gates }`，补丁路径是 `{ ...currentMeta, gate: patchGate.gates }`。两处都丢掉了调用方传入的 `meta`（`novel_desk_write` 的 `title/status/summary`），所以新章标题永远写不进 meta。

**修复**：两处都改为从合并后的 `gateMeta` 出发（`{ ...gateMeta, gate: ... }`），调用方 meta 原样保留；补 `test/gates.test.js` 回归（新章正常写入 + 补丁路径都断言 `title/status/summary` 落库）。

**数据修复**：从已批准的 `outlines.json` 回填该新书 40 章标题；只改 `meta.title` 仍是「第 N 章」的章节，改前把 40 个 `.meta.json` 备份到项目根 `.title-backfill-backup-<ISO>/`。

**验证**：`node --check` 全过；`node --test` **120/120**；`node scripts/ui-e2e.mjs` **81/81**。

## 0.6.3 全书账本同步（2026-10-25）

作者反馈：「目前正文写完了，账本缺乏一个正文写完以后同步的功能？」——《暂定》40 章 / 10 万字由 AI run 写完后，`chapters/` 已更新到当天 00:11，但账本文件停在写作前的 22:33，`events.json` 只有 3 字节（空数组 `[]`）、`highlights.json` 缺失，`ledger-sync.json` 也不存在；作者在界面上看不到任何「账本该同步了」的提示。

**根因（两个）**：
1. **AI 写正文完全绕过账本信号**：`noteChapterChange`（人名/地名/事实数字启发式 → `ledger-sync.json` 的 `pending`）此前只在 `chapter.save` RPC（作者手动编辑保存）里调用。`novel_desk_write`、`novel_desk_run` 写章、提案采纳改正文都走 `writeChapterWithGates` → `storeApi.saveChapter`，一条信号都不会产生。所以「AI 全书写完」这条最需要同步的路径恰好永远不提醒。
2. **只有「逐章增量核对」，没有「全书同步」**：`ledger.sync` 的 `workorder` 只从 `pending` 取章，全书写完后没有 pending 就只能得到一份空工作单；账本与正文的差距是整本书规模的，逐章提醒解决不了。

**实现（不新增工具 / 不新增 op，全挂 `ledger.sync` action）**：
- `lib/store.js`：`ledger-sync.json` 从 `{pending}` 扩成 `{pending, full}`；新增 `planLedgerSync`（按 1–20 章/批切批，重建按「章号完全相同」复用已完成批）、`completeLedgerSyncBatch`（默认第一个未完成批，连带清这批的 `pending`）、`resetLedgerSync`；`getLedgerSync` 返回 `{pending, full, chapters}`，`full` 带 `done/total`、每批 `from/to/count/words/status/doneAt` 与 `uncovered`（`from` 之后未覆盖的章）。
- `lib/prompts.js`：新增 `fullLedgerSyncWorkorder({ project, ledger, batch, full })`——【全书账本同步工作单】第 X/Y 批 · 第 a–b 章，含账本现状条目数、已有条目名（防重复造）、本批章节、八类记账口径（新建 outlines 仍要四拍 + designScore）、只允许 `novel_desk_propose(kind="ledger-fix")`。
- `lib/gates.js`：两条落盘路径保存后统一调 `noteChapterChange`（吞错），AI / run / 提案写正文从此也记待同步信号；它是唯一写入入口，一处补齐即全覆盖。
- `index.js`：`ledger.sync` 增加 `plan` / `batch-done` / `reset`，`workorder` 支持 `mode:'full'`（`batch?` 缺省下一个未完成批；无计划报「还没有全书同步计划，请先建立计划（action=plan）」；全部完成返回 `{prompt:'', done:true}`）；旧增量工作单行为不变。
- `client.js`：账本页新增「📚 全书同步」按钮 + 两条互斥横幅（进行中 N/M 批 / 「正文已经写完？全书账本还是旧的」）+ 「全书账本同步」弹窗（制定/重建计划、批次列表与进度、未覆盖提示、发送下一批工作单、本批已同步、清除计划）；工作单发送沿用两步确认与目标会话选择，原有增量同步 UI 一行未改。

**验证**：`node --check` 全过；`node --test` **128/128**（新增 store 3 条：信号去重/核对清空、分批进度/重建保进度/越界范围/清除、pending 与 full 互不覆盖；prompts 1 条工作单内容；api 2 条：四个 action 转发与 workorder 三种返回；gates 1 条：run 写章也记信号。`client.test.js` 行数上限 5750 → 5900）。界面：本机 DSH 文件沙箱禁止 headless Chrome 写 `~/Library/Application Support/Google/Chrome`（Crashpad 报 `Operation not permitted`），`npm run smoke` / `npm run e2e` 的 Chrome 直接 `Trace/BPT trap: 5`（exit 133）起不来——环境限制，与插件代码无关。改用 CDP 直连 Chromium 加载 smoke 生成的页面副本（`.tmp-run/nd-ui-smoke/site/index.html`，数据为《暂定》40 章副本）复查：账本页正常挂载、页头出现「📚 全书同步」；点开后无计划态（每批章数 4/6/8/10 + 制定同步计划）与有计划态（`已完成 2/7 批 · 第 1–40 章 · 每批 6 章` + 7 行批次进度 + `计划未覆盖第 39、40 章` + 清除计划/重新制定计划/本批已同步/发送下一批工作单）均正确渲染；「发送下一批工作单」弹出 `全书账本同步 · 第 3/7 批` 工作单（带原则行与账本现状，两步确认「下一步：确认发送」），全程无 console error。界面源码另由 `test/client.test.js` 断言覆盖（行数上限 5900）。发布前建议在能正常启动 Chrome 的机器上补跑 `npm run smoke` / `npm run e2e`。

## 0.6.3 显式工作台链接认证跳转修复（2026-10-25）

作者反馈（m01181）：用 DSH Remote 手机远程时，打开工作台网页先跳到 DSH Web，还要再点侧栏才能进工作台；「这是不是搞错了」。

**根因（两处）**：
1. **标记放错位置**：0.6.2 把 `?novel-desk=1` 加在 query。DSH 的 `BrowserAuth.authorizeIndex()` 对 `GET /?...token=` 返回 `303 Location: "./"` 换 cookie，query 被整个丢掉；客户端落地时 `location.search` 里没有标记，`IS_STANDALONE_TAB` 为 false → 先显示 DSH。桌面同样受影响（此前只用 `file://` 直测，绕过了认证，没发现）。
2. **手机多一道门**：自动展开条件还带 `!IS_MOBILE`，即使标记没丢，手机点显式链接也被挡回 DSH。

**修复**：
- `index.js` `withStandaloneMarker` 改为把标记写进 hash：`...?token=...#novel-desk=1`（已有 hash 用 `&` 追加；query/hash 里已有标记则不重复）。hash 不发给服务端，303 的 `Location` 没有 fragment，浏览器按规范继承原 fragment，能活到落地页。已用 mock 303 server + headless Chrome 实测：`?token=x&novel-desk=1#novel-desk=1` → `/#novel-desk=1`（search 为空，hash 保留）。
- `client.js`：`IS_STANDALONE_TAB` 同时解析 hash 与 query（兼容旧链接/测试；也兼容 `#page?novel-desk=1` 这种带页面前缀的形态）；删除 `IS_MOBILE`、`FORCE_OPEN_FOR_TEST`；自动展开改为 `if (IS_STANDALONE_TAB) setOpen(true)`——显式链接在桌面和手机都直接进工作台；无标记的 DSH / DSH Remote 页面仍不展开，侧栏入口照常。手机响应式与右下角关闭按钮保留。
- 测试/harness：`test/api.test.js` 期望改为 `?token=fresh#novel-desk=1` 等；`test/client.test.js` 断言 hash+query 解析与无 `!IS_MOBILE` 条件；`scripts/ui-smoke.mjs` 页面 URL 改用 `#<page>?novel-desk=1` 并去掉测试用 force-open；`scripts/ui-e2e.mjs` 显式链接改 `${base}#novel-desk=1`（只改 hash 不触发整页重载，加 `Page.reload` 复现新标签打开）。
- README「打开方式」、REBUILD-CONTRACT §9.2 的 `app.open` 同步改为 hash 语义。

**验证**：`node --check` 全过；`node --test` **128/128**；`npm run check` 通过；`node scripts/ui-smoke.mjs`（1680×1000）12 个页面/页签全部挂载；`node scripts/ui-smoke.mjs --size 500x844` 12 页全部挂载；`node scripts/ui-e2e.mjs` **81/81**（含「普通 DSH 页面不被工作台覆盖」「显式工作台链接自动打开」两条）。早前 0.6.3 账本同步一节记录的「headless Chrome 起不来」为本机临时环境问题，本轮复跑 smoke / e2e 均正常。

## 0.6.4 审阅链路返工：范围由作者选、提案直接成文、冷读打分回归（2026-10-25）

作者反馈（m00001 / m00009 / m00494）：审阅永远只审前五章、审出来的「提案」把改法建议直接写进正文、冷读打分入口消失导致注意力曲线没数据。

**根因与修复**：
1. **5 章硬截断**：`client.js` 的 `reviewChapters` 末尾 `.slice(0, 5)` 且依赖当前状态筛选；没有复核过的章不算 pending，新书/审完后退化为「全部章节」再被截前 5 章。→ 删除该推导与 `fetchWorkorder` 快捷入口，新增 `ChapterPicker`：审阅/复测范围一律由作者逐章勾选（默认整本书，快捷：全书 / 未审过的 / 有意见的 / 清空），四张入口卡与工具栏全部走同一个范围弹窗。
2. **确定性「提案」污染正文**：旧 `createProposals` 把 `before=quote`、`after=suggestion` 直接提交，采纳后写作建议被插进书稿（80 章项目里 24/24 补丁的 after 都出现在第 1–5 章正文中）。→ 删除确定性转换，改为两条 AI 工作单：`proposalGroupsWorkorder`（按章归一，after 必须是成文正文，禁「改成/建议/二选一」编辑指令，每条 patch 挂 reviewIds）与 `globalFixWorkorder`（chapter=0 全书级问题 → 全局修改意见 opinion + 跨章 `book-fix` 提案）。提案页支持直接编辑「改为」/ 整章正文 / 全局意见后再批准（新 RPC `proposal.update`）。
3. **状态断链**：审阅生成提案后不写状态，重复生成、待处理列表永远不清。→ `createProposal` 把关联审阅置 `proposed`、采纳置 `fixed`、驳回退回 `open`；审阅页状态筛选新增「已进提案」。
4. **引文定位不唯一**：`findQuoteSpan` 取第一次出现，重复引文会改错位置；`addReviews` 用 chapter+source+quote 去重导致同一问题永远无法再报。→ 归一后统计出现次数，>1 直接 skipped/`needs-fix` 并报「该引文在第N章出现M次，无法唯一定位」；去重只挡 open/proposed，fixed/wontfix/archived 可重报。
5. **注意力默认 3 章 + 复测永不排队**：`novel_desk_attention` 默认 `limit=3`、`recheckPending` 从不置 true、UI 没有复测入口。→ 去掉默认截断（requested / recheckPending / 全书，仅显式 limit 才截断）；`saveChapter` 正文变化后置 `recheckPending`；审阅页「冷读打分 / 复测」与正文页「🧊 AI 冷读打分本章」两个入口生成零上下文打分工作单，写回注意力曲线。
6. **备份 0 字节**：新建空章把空串备份成 0 B 版本，误载入会清空正文。→ 只在旧正文非空且变化时备份。
7. **工作单缺路径/读法**：审阅清单只有章号标题字数，AI 无法按图读正文。→ `withChapterPaths` 给审阅/提案/设计/复测工作单逐行补 `path`，ISOLATION 明确「按清单路径 read 或 novel_desk_read(op="chapter")」。

**验证**：`npm run check` 全过；`npm test` **156/156**（新增 28 条：审阅范围全量、提案 after 成文、book-fix 生命周期、唯一引文、空备份、recheck 排队、chat.send 透传、client 源码契约等）。`scripts/ui-e2e.mjs` 审阅段重写并 `node --check` 通过，但本机沙箱内 headless Chrome GPU 崩溃，e2e 本轮未实跑（前次 81/81 记录保留）。客户端改动需刷新/重启 DSH 生效（插件以 link 方式装在 desktop profile）。
**数据修复**：`scripts/repair-polluted-chapters.mjs` 反向应用已采纳的 patch-paragraph（after→before），预演与污染前备份逐字一致（第 1–5 章 24 条全部可逆），加 `--apply` 落盘（先备份）。

## 0.6.5 冷读打分：作者填的「打分说明」必须进 prompt（2026-10-25）

作者反馈：冷读打分弹窗里填了「打分说明」，发出去的工作单里没有这段内容。冷读的定义确认：独立会话、零上下文，只给指定文章地址，加上作者给的打分说明，按四拍给出实测分。

**根因**：`client.js` 的 `launchRecheck` 组装 payload 时只传了 `chapters`，把 `launcher.focus` 丢了；`lib/prompts.js` 的 `attentionRecheckWorkorder` 也没有 `focus` 参数，即使传了也不会渲染。

**修复**：
- `client.js`：冷读/复测 payload 带上 `focus: launcher.focus.trim()`；工作单标题改为「冷读打分工作单（N 章）」。
- `lib/prompts.js`：`attentionRecheckWorkorder({ project, chapters, focus })` 新增「本次打分说明（作者指定；打分与弃读判断要回应它，但零上下文与四拍口径不变）」段，未填时明确写「作者没指定额外说明」；冷读边界写死「独立会话 · 零上下文，只给你指定章节的路径和作者的打分说明，不提供剧情梗概、前文、历史分数、修改记录、账本或大纲」。
- 章节清单改为**只给「章号 ｜ 正文路径」**（不再带标题/字数等上下文），没有可读路径时才退化成标题/字数用于识别。
- `index.js`：`novel_desk_attention` 增加可选 `focus` 参数，op=recheck 时透传进工作单；`chat.send` 的 dryRun 与非 dryRun 共用同一份 payload，说明不会再丢。

**验证**：`npm run check` 全过；`npm test` **157/157**（新增：冷读工作单零上下文边界、只给路径、作者说明原样进 prompt、无说明时默认口径、工具 focus 透传、客户端 payload 带 focus）。RPC dryRun 实测：填入「只看读者会不会追下去；第二段容易弃读…」后，工作单包含该句、章节清单只有 `- 第N章 ｜ /…/chapters/000N.txt`、不含标题/字数/旧分。

## 0.6.6 冷读打分运行失败：tool input is invalid JSON（2026-10-25）

作者在《暂定》跑冷读打分，第一轮读了三章后整轮失败：`DeepSeek Messages stream: tool input is invalid JSON`。

**取证（~/.dsh/sessions/.../session-94eaf33e…）**：工作单是 0.6.5 的新版（含作者填的「本次打分说明」，说明已进 prompt）。第 1 章 `novel_desk_attention(op="measured", items=[单章])` 调用成功并落库（第 1 章 72 分）；随后模型把第 2、3 章合并成一次调用，输出的 arguments 末尾多了一个 `}`（`…"projectId": "pm03b6046ccc24"}}`），JSON.parse 在 1311 位置失败 → DSH 判 `MALFORMED_RESPONSE`，整轮作废（第 2、3 章的分数未落库）。

**根因**：模型侧 JSON 生成错误 + 我们工作单鼓励把多章塞进一个 items 数组（1.3KB+ 嵌套 JSON，多一层对象就多一处括号风险）。工具本身没有问题，但失败代价是整轮。

**缓解（不改变打分口径）**：
- `novel_desk_attention` 支持**单章扁平写法**，并作为推荐写法：`novel_desk_attention(projectId, op="measured", chapter=3, score=73, breakdown={hook:15,tension:17,payoff:21,cliff:20}, verdict="会", weakest="hook", detail="…", dropPoints=[{quote,why}])`；design 同理（chapter + type/hook/tension/payoff/cliff/question/designScore/status）。工具 schema 补齐这些顶层字段与 breakdown/dropPoints 子结构，`items` 仅作兼容。
- 冷读打分/设计工作单的提交格式改成**每章一次调用、扁平参数**，并写死：「一次只交 1 章；多章拼成一个大的嵌套 JSON 很容易解析失败、整轮作废；JSON 只包一层对象、结尾只有一个 }，不要包 data/params/args」。
- 审阅工作单的批量提示从「一次可交多条」收敛为「每次 1–5 条，分多次调用」。
- 工具描述控制在 200 字内（`test/api.test.js` 的契约）。

**验证**：`npm run check` 全过；`npm test` **158/158**（新增：扁平 design/measured 落库与校验、score 与 breakdown 不一致拒绝、冷读/设计提交格式与「一次一章」文案、审阅批量收敛）。当前《暂定》attention.json 只有第 1 章 72 分，第 2 章起重新跑冷读打分即可（旧失败不污染数据）。

## 0.6.7 审阅勾选后仍提示「先勾选」（2026-10-25）

作者反馈：在审阅页勾选条目点「生成修改提案」，有些条目可以、有些一直提示「先勾选要处理的审阅条目」。

**根因**：`launchProposalWorkorder` 只接受 `chapter > 0` 的条目，勾选里只有 `chapter=0` 的全书级条目时 `picks` 为空，于是提示「先勾选…；全书级条目请用『全局修改意见』」。但按钮在 `selected.length > 0` 时本是可点的，所以这句话出现在「明明已经勾了」的场景里；混合勾选时全书级条目又被静默忽略。作者遇到的「有些行」= 章节级条目，「有些不行」= 全书级条目。

**修复（client.js）**：
- 「生成修改提案」改为按勾选自动分流：章节级条目 → `proposalGroupsWorkorder`；全书级（chapter=0）条目 → `globalFixWorkorder`；两者同时勾选 → 两条工作单拼成同一份 prompt（`payload={prompt}`，一个分隔线隔开）一次发出，不再要求作者去点第二个按钮。
- 只有真正一条都没勾时才提示，文案改为「先勾选审阅条目（左侧方框）：章节条目生成逐段修改提案，全书级条目不挑章、会并进全局修改意见」。
- 工具栏显示「已选 N 条（全书级 M 条）」；全书级审阅行的提示同步改为「勾选后点生成修改提案会自动并进全局修改意见」。
- 「全局修改意见」按钮保留（不勾选时默认取全部待处理/已进提案的全书级条目）。

**验证**：`npm run check` 全过；`npm test` **158/158**（client 源码契约新增：自动分流、两条工作单拼 prompt、已选提示含全书级条数、不再出现误导性的「全书级条目请用…」文案）；`node scripts/ui-e2e.mjs` **103/103 通过**，其中新增断言「只勾全书级条目时生成修改提案自动走全局修改」真实点击验证通过；同一轮里「AI 审阅工作单」先过章节选择器的断言也同步更新。

## 0.6.8 全局提案只剩一个：单条 book-fix + 一律 stale（2026-10-25）

作者反馈：刚跑完全局修改，AI 说提案了 4、5 个全局提案，提案页只看到一个。

**取证（session-61c23858）**：AI 整轮只调用了一次 `novel_desk_propose`：
`kind="book-fix", chapter=0, title="全局修改：拆先想模板、去情绪标签、分人物口吻、立私人赌注"`，`data.patches` 44 条，覆盖第 1–16、19、21、22、24、25、31、33、35–39 章，`opinion` 把 4 条全局审阅收束成一条总口径。proposals.json 里确实只有这一条 `book-fix`（pending），没有丢数据——是旧 `globalFixWorkorder` 明确要求「把问题归纳成一条全局修改意见」→ 一条提案；作者预期的是「4 条全局问题 → 4 条提案、逐条批准」。

**另一个隐藏坑**：`book-fix` 采纳时按 `data.baseHashes` 一律判 `stale`。如果以后真拆成多条提案，第一条批准改了某章，第二条对同一章的补丁就会因「正文已变化」直接过期，逐条批准根本走不通。

**修复**：
- `lib/prompts.js` `globalFixWorkorder`：改为**每个全书级问题各出一条 `book-fix` 提案**（通常本次选中几条审阅就几条提案），标题模板 `全局修改 N/M：主题`；要求一条补丁只回应一个问题、同一处原文只能出现在一条提案里；若一处兼改多个问题，放进最相关提案并在其它提案 `opinion` 里写明「已并入 <提案标题>」；某条审阅已被其它提案完全覆盖时可不单独提交，但必须汇报并入位置（禁止交 patches 为空的提案）。作者可在提案页逐条批准 / 驳回。
- `lib/store.js` `acceptProposal(book-fix)`：不再按 `baseHashes` 一律 stale；改为用 `applyPatches` 在当前正文里逐章校验 before 是否**唯一可定位**——能定位就照常过闸门写盘（支持前一条提案改过同章后再批下一条），定位不到 → `needs-fix` 并列出失败原因，且一章都不写。`baseHashes` 仍写入提案（`updateProposal` 会重算），只作参考。
- 客户端无需改：提案页本来就按条渲染 `book-fix`，现在会看到 N 张卡，各自「原文/改为」与「编辑『改为』」。

**验证**：`npm run check` 全过；`npm test` **160/160**（新增：两条 book-fix 提案改同一章不同补丁，先后采纳都成功；旧的「任一章变化整条 stale」测试改为「仍能定位→照常采纳」+「定位不到→needs-fix 且一章不写」；globalFixWorkorder 文案断言更新为每问题一条）。`node scripts/ui-e2e.mjs` **104/104 通过**（新增断言：「每个问题一条提案，可逐条批准」+ book-fix 提交格式更新；同一轮里审阅勾选/全局路由/冷读打分等全部通过）。

## 0.6.9 提案页多了以后压在一起、内容看不见（2026-10-25）

作者反馈：提案一多，列表里的内容全压在一起、展开也看不见。

**根因**：`.nd-proposals` 是「页面滚动容器里的第二个滚动容器」（`display:flex;flex-direction:column;overflow-y:auto;min-height:0`），它又是 `.nd-page` 的 flex 子项 → 高度被压缩；里面的 `.nd-proposal` 卡片默认 `flex-shrink:1`，于是每张卡被压扁，而卡片本身 `overflow:hidden`，展开后的 `.nd-proposal-body` 内容直接被裁掉。审阅收件箱的 `.nd-review-list` 有同样问题（行会被压扁）。

**修复（client.js CSS + 少量渲染）**：
- `.nd-proposals` 去掉自己的滚动与 `min-height:0`，交给 `.nd-page` 滚动；`.nd-proposal` 加 `flex:0 0 auto; min-width:0`，卡片不再被压缩。
- `.nd-proposal-head` 改为 `align-items:flex-start`；`.nd-proposal-title` 允许换行（`flex:1 1 220px; overflow-wrap:anywhere`），长标题不再挤掉右侧标签/按钮。
- `.nd-proposal-body` 内边距加大；`.nd-diffs` 改成有上限的内部滚动区（`max-height:min(62vh,680px); overflow-y:auto`），44 条补丁也不会把整页拉爆；`.nd-diff` 用 `minmax(0,1fr)` 两列 + `flex:0 0 auto` + 边框，原文/改为各自可滚（`.nd-pre` 上限 260px）。
- 提案头新增统计标签「N 条补丁 / M 章」（book-fix 一眼看到跨多少章）；展开区标题「补丁（N 条，跨 M 章）· 可在下方直接编辑『改为』」。
- 审阅收件箱同步修：`.nd-review-list` 不再嵌套滚动；`.nd-review-row` 加 `flex:0 0 auto`；右侧操作列 `position:sticky; top:8px`，长条目里「看正文 / 已处理 / 忽略」始终可见。

**验证**：`npm run check` 全过；`npm test` **160/160**；`node scripts/ui-smoke.mjs` 12 个页面正常挂载，提案页截图 `/tmp/nd-smoke-run/shots/proposals.png`（卡片高度正常、标签与统计完整）；`node scripts/ui-e2e.mjs` **104/104 通过**（覆盖提案卡展开→批准、批量批准/驳回、审阅勾选与工作单等真实点击交互，确认 CSS 改动没破坏任何操作）。

## 0.6.10 沉浸模式 + 仿纸正文底（2026-10-25）

作者反馈两件事：①正文页想有「沉浸模式」——只保留阅读 / 编辑 / 审阅三个按钮，正文接近全屏；②正文编辑器想改成阅读区那种仿纸底，且**不分宽屏窄屏都这样**。

**做法（只动 client.js，RPC / 数据零改动）**：

- **沉浸模式**：`Workbench` 持 `immersive` 状态（`localStorage:nd.immersive`），只在 `page === 'read'` 时给外壳挂 `nd-immersive`。CSS 收掉顶栏、原则条、左导航、目录、右栏、手机兜底关闭，面板铺满 `100dvh`；正文页头改成三栏网格：左「第 N 章 / 共 M 章」（编辑态改为保存状态），中间 `阅读 / 编辑 / 审阅`，右「退出沉浸」。非沉浸时工具条多一颗「⛶ 沉浸」入口。`Esc` 先退沉浸：正文页在输入框判断之前拦下并 `stopImmediatePropagation`，`Workbench` 的 Esc 处理器在沉浸时直接返回，不会顺手关掉整个工作台。进出沉浸时按当前章重新锚定滚动（外壳高度和正文宽度都变了）。
- **仿纸正文底**：新增 `PAPER_CSS`（`CSS_EXTRA` 之后、`MAP_CSS` / `MOBILE_CSS` 之前拼接）。`.nd-reader-scroll` 与 `.nd-edit` 用同一组暖纸变量 `--nd-paper*`（纸色 `#f7f2e6`、墨色 `#3b352a`、极淡纤维纹理）；纸色/墨色写死为暖色，**不随宿主明暗主题反转**，保证纸面文字永远可读。编辑器：去掉等宽字体与白底，改成 `font-family:inherit` + 与阅读共用 `prefs.size / prefs.lineHeight`，文字列最大 800px 居中，聚焦是暖色细描边；编辑栏的提示文字 / 次要按钮改成纸面配色。窄屏只调边距（正文 18/16、编辑器 16/14），底仍是同一张纸。
- **顺带修的两个真实 bug**（沉浸切换会放大它们）：
  - 阅读位置恢复 / `scrollToChapter` / 滚动选章原来用 `node.offsetTop`，而 `offsetParent` 是 `.nd-overlay`，沉浸切换后顶栏高度变化会把落点算歪（截图里出现过章标题被切一半）。改为 `nodeTopInScroll()`：`getBoundingClientRect()` 差值 + `box.scrollTop`。
  - `scripts/ui-smoke.mjs` 复制数据时 `cp(chapters 目录)` 没带 `recursive: true`，EISDIR 被 `.catch(() => {})` 吞掉，截图里永远是「还没有章节」。补上 `{ recursive: true }` 后截图才有正文。
  - 窄屏 `.nd-read-row` 加 `flex-wrap:wrap`，多出「沉浸」按钮后 360–500px 不会横向溢出。

- **手机审阅修复（作者跟进反馈：手机沉浸里点「审阅」像是没反应）**：两个原因叠在一起——
  1. 读者批注原来只挂在正文容器的 `onMouseUp` 上；手机长按选字走的是系统选区手柄 + `selectionchange`，**iOS / Android 都不会再发 mouseup**，所以桌面拖选能弹批注框、手机长按选完却什么都不发生。现在抽出 `pickReaderSelection()` 作为唯一入口：鼠标 `mouseup` 照旧立即弹；`document` 上再挂 `selectionchange` 与 `touchend`（260ms 防抖，等系统选区稳定）走同一入口。同一段引文已在编辑时不重置弹窗，避免把作者刚输入的批注冲掉；选区落在弹窗内 / 非正文时直接忽略。
  2. 沉浸模式把「审阅＝选中正文文字提交批注」的模式说明和切换提示都收掉了，切到审阅没有任何视觉反馈。现在沉浸模式左侧状态在审阅态显示「审阅：选中文字 → 加批注」。
  另外：`.nd-reader-body` 显式 `user-select:text`（宿主可能给容器设了 `user-select:none`）；窄屏批注框改成贴底面板（`left/right/bottom` + `100dvh` 内的 `max-height:72dvh`，避开安全区），不再依赖选区坐标的 inline `left/top`。
- **沉浸模式字号 −/+（作者跟进三轮：先要能调字 → 嫌贴底胶囊挡字 → 手机仍然「没反应」）**：
  1. 位置：从贴底浮层挪到**顶栏左侧**（`第 N 章 / M 章（或保存状态 / 审阅提示）  − 15 +`，右侧仍是退出），不再压正文；窄屏顶栏排两行（第一行状态 + 字号 + 退出，第二行三颗模式按钮），宽屏一行。按钮 26px（窄屏 30px）、`touch-action:manipulation` 去 300ms 延迟；手机 `touchend` 只在手指落在正文里时才去取选区，点顶栏按钮不会误触发批注。
  2. **手机「没反应」的真正原因**：`MOBILE_CSS` 里 `.nd-reader-body{font-size:15px!important;line-height:1.9!important}` 把窄屏正文字号钉死在 15px。点 + 时状态确实变了（内联 `style="font-size:16px"`、顶栏数字 15→16），但 computed `font-size` 仍是 15px——所以「只改数字不改字」；PC 不受这条媒体查询影响，于是「PC 可以、手机不行」。去掉这两条 `!important` 后，窄屏也按 `nd.fontSize / nd.lineHeight` 走（默认 15px / 1.95）。
  3. 上限：作者反馈「20 有点小」，字号上限从 **20px 提到 28px**（下限仍 13px；阅读栏 720/820px 宽、手机上 500px 宽时一行仍能放 12–15 个汉字）。沉浸顶栏 `− 15 +` 和非沉浸工具条的 A− / A+ 一起放宽，`localStorage:nd.fontSize` 原值继续有效。
  4. 仍然只是改 CSS `font-size`，**不打包字体文件、不请求任何网络字体**（客户端没有 `@font-face` / `fonts.googleapis` / `woff`，测试断言守住）。

**验证**：`npm run check` 全过；`npm test` **163/163**（新增 3 组静态断言：immersive 持久化 / 外壳类名 / Esc 优先、PAPER_CSS 纸色墨色、编辑器与阅读共用字号行距 + 窄屏纸底；以及「手机审阅：selectionchange / touchend / 同段不重置 / user-select / 窄屏贴底」「沉浸字号 +− 接到现有偏好、不加载网络字体」）；`node scripts/ui-smoke.mjs --size 1680x1000` 与 `--size 500x844` 12 个页面全部挂载；`node scripts/ui-e2e.mjs` **116/116 通过**（新增 13 条真实交互：沉浸后顶栏 / 导航 / 目录 / 右栏都不可见、正文只剩三颗按钮、正文高度 > 90% 视口、阅读区计算样式为 `rgb(247,242,230)`、沉浸切审阅有选字提示、**字号 −/+ 在顶栏且点按区域 ≥26px、`+` 真的放大、`−` 缩回原字号、切到 500×844 手机视口后 `+` 仍能改到 computed font-size、**连点 + 停在上限 28px、再点 − 能退回原值**、`Esc` 退出沉浸且工作台仍在、**程序化选区 + 手动 selectionchange 能弹出批注框**（复刻手机长按选字的事件序列））。截图：`docs/screenshots/0.6.10-read-paper.png`、`0.6.10-edit-paper.png`、`0.6.10-immersive.png`、`0.6.10-immersive-mobile.png`、`0.6.10-mobile-reader-note.png`、`0.6.10-immersive-mobile-max.png`（手机上 28px 上限的实际观感）。

## 0.6.11 阅读位置在 阅读 / 编辑 / 审阅 之间同步（2026-10-25）

作者反馈：编辑和审阅分开没问题，但切模式后位置丢了，「还得从头找」；要求把位置同步做掉，并把用法写进工作区手册（README）。

**做法（只动 client.js + README/契约文档）**：

- `readParagraphAnchor()`：从滚动位置算「章 + 段」——先找视口顶部所在的章，再取「露出超过半段」的第一段（段落只露一条尾巴时算下一段）。
- `scrollReaderToAnchor()`：把正文滚回某段的顶部（段落 0 等于章首，会露出章标题）。
- **阅读/审阅 → 编辑**：`switchMode('edit')` 记下锚点，`openEdit(该章)`；编辑器渲染后用 `caretOffsetTop()`（镜像 div）量出该段起点在 textarea 里的纵向位置并设 `scrollTop`，光标放到段首。浏览器在固定浮层里不会把 textarea 光标滚进视口，所以必须自己量。
- **编辑 → 阅读/审阅**：用 textarea `selectionStart` 反查段落，切回后 `scrollReaderToAnchor()` 落位，而不是回到书首/章首。
- **持久化**：滚动停 300ms 后把章与段写进 `localStorage:nd.pos.<作品id>` / `.para`，首次渲染时按它恢复（最多重试等目标章加载）；切模式的过渡滚动用 `modeRef` 挡掉，避免把锚点写歪。
- **沉浸模式切换**：改为按当前段重新落位（原来退回章首）。

**验证方式（按作者要求，本次不再跑 `node scripts/ui-e2e.mjs`）**：用一次性的轻量 headless CDP 脚本（临时副本 + 固定视口 1400×900）实测：

- 读到第 2 章第 31 段 → 切编辑：textarea `scrollTop=2275`、光标在 `spans[31].start`，编辑器显示文本与该段一致；
- 直接切回阅读：该段位于滚动区顶部 +8px（`scrollTop=5545`），不是书首/章首；
- 再切审阅：位置不变；
- 重载页面：`nd.pos...para=31`，恢复到同一段（该段 `top` 相对滚动区 +8px）。

同时修了测试脚本的占盘问题（作者反馈「测试塞满 tmp」）：`ui-smoke` 原来每页开 2 个 Chrome profile（12 页 = 24 个 profile，~84MB/次）且不清；现在单 profile 复用、跑完删除，并只复制目标作品的 `chapters`（原来所有作品的 chapters 全拷）。`ui-e2e` 原来整目录复制作品（含 `.pre-0.6.0` / `.snapshots`，单次可达 1.4G），现在只拷测试所需文件，并在启动与 Ctrl-C/中断时清理 `data/site/chrome/downloads`。
