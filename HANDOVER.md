# HANDOVER · 长篇中文小说工作台

> 交接时间：2026-10-24（Asia/Shanghai）
> 当前版本：**v0.5.2 未发布改动**（npm 已发布 0.5.1；工作树含这批未发布特性：版本对齐 / 整本快照回滚 / json 账本历史 / 全文改动 revision + 双闸门 / **注意力提分闭环** / **所有审阅硬隔离**）；本轮只本地测试，未发 npm
> 工作区：`/Users/micellince/Documents/deepseek-harness/dsh-long-novel-workbench`
> GitHub：https://github.com/micellince/dsh-long-novel-workbench
> npm：https://www.npmjs.com/package/dsh-long-novel-workbench
> 社区目录 PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8520

这是一份写给下一个会话/下一位接手者的交接文档：它是什么、现在在哪、怎么开发、哪里还没做完、下一步做什么。

---

## 1. 一句话

一个装在 **DeepSeek Harness** 里的**长篇中文小说工作台**插件：16 个页签（注意力 / 正文 / 验收 / 工具 四组）管理章节、时间线、事实账本、伏笔、冲突、人物、高光、审稿、提案、计划对齐、Agent 分工、写作预设；v0.4 又加了人物关系图、时间线泳道、自动保存 + 章节历史/恢复/diff、批量审稿/采纳、事实生效区间、Markdown 导入、EPUB/DOCX 导出、多预设对齐。AI 可以直接读这些账本生成下一章/审稿/补时间线，但所有 AI 产出先进入「提案」，人工对比后才落盘。

**不是针对某一本书写的**，不绑定《碧血青霜缘》或任何现有作品。数据默认在 `~/StoryDesk`，全是普通 Markdown/JSON。

---

## 2. 当前状态

| 项 | 状态 |
|---|---|
| 代码 | v0.5.2 未发布（`package.json` 0.5.2；tag `v0.5.1` 为上次发布）；`node --test` **302/302** 全绿 |
| npm | **已发布 0.5.1**（tag `v0.5.1` 触发 Publish workflow） |
| GitHub Release | **v0.5.1 已建**（附稳定版 tarball）；stable 链接：`releases/latest/download/dsh-long-novel-workbench.tgz` |
| 本机安装 | desktop profile 用 `link:` 指向本工作区；改 Host 代码要重载，改 `client.js` 刷新页面 |
| 社区目录 | PR #8520 已开、只加一个 YAML 文件；`PR check` 已通过，`Submission gate` 因仓库未满 24h 暂时失败；仓库创建于 2026-10-21 22:50，**24h 门槛在 2026-10-22 22:50 自动满足**（gate 会自己重跑转绿，不用重提） |
| 自动化测试 | `test/`：`node:test` + `node:assert/strict`，零依赖，临时目录，不碰 `~/StoryDesk` |
| CI | CI（Node 22/24）已绿：<https://github.com/micellince/dsh-long-novel-workbench/actions/runs/39636720312> |
| 浏览器截图 | **已换成 v0.4 真实截图**：总览 / 时间线泳道 / 预设 / 关系图 / 章节历史 / 导入（`docs/screenshots/`） |
| 真实浏览器验收 | **已做**：临时 `accept` profile + 本地 link + 无头 Chrome 155（CDP），自动点检关系图/泳道/历史/自动保存/批量/导入/导出，0 exception、0 error。详见 `docs/releases/v0.4.0.md` 第三节 |

> **2026-10-22 夜新增（未发布）**：分工表第 10 个角色「独立审稿人（零上下文首读）」——`special: 'fresh-read'`，只拿一章正文、不读账本/预设/大纲/人物卡；「分工」页顶部高亮卡可选**读一章 / 读全书**，一键新开会话（`chat.send` + `task=fresh-read` + `scope=chapter|book` + `newSession`）；全书 ≤ 10 万字符直接投递整本（v0.5.2 起改为只给章节文件路径、由 AI 自己 read，不再贴正文），超出（如《鱼龙舞》111.7 万字符）转分批工作单由子 Agent 读文件汇总；总览页有紧凑入口；首读意见以 `dimension=首读` 写回审稿页。老作品打开时自动补入该角色，不覆盖作者已有分工。测试 48 个用例全绿。
>
> **2026-10-22 扩写（未发布）**：`docs/EXPANSION.md` + expansion.json/9 RPC/两套 prompt/大纲闸门/自动采纳+原稿备份/`novel_desk_expansion`/整本书页「扩写」子模块与章节入口；测试 151/151；未真机试跑。
>
> **2026-10-22 收尾新增（未发布）**：生成整本书全自动 goal 流水线——pipeline.json、9 个 pipeline RPC、准备阶段（蓝图+大纲+每章 attention 设计，作者验收）、goal prompt（create_goal + subagent + 每卷写→审→修 + 不中断）、章节修订按 pipelineRunId 自动采纳、novel_desk_pipeline 进度工具、token/费用预算与超限暂停、「📚 整本书」页/向导/总览卡/新建入口。`node --test` 130/130；真实会话首次试跑待验证。
>
> **2026-10-22 深夜新增（未发布）**：注意力一号原则「ATTENTION IS ALL YOU NEED / 一切为读者服务」落地——工作台常驻原则条 + 总览 hero；context/plan/交接 prompt 注入原则并把注意力段置顶（最近曲线/疲劳/目标分/四拍 + 强制补强）；`plan` 提案硬校验 `data.attention`；章节采纳合并 attention / 缺设计返回 `attentionWarning`；旧 ai.js 补齐注意力与世界观；fresh-read 保持零污染。测试 114/114。
>
> **2026-10-22 更晚新增（未发布）**：世界模型 P1–P3——`world.json`（单例）/`locations.json` 账本，世界页 SVG 坐标地图（拖拽/连接编辑）、新建向导世界设定、`world-build`/`world-infer` 清单任务、6 条空间 checks、只读 HTML 视图 `/novel-desk/view/{world|timeline|map}`（面板 iframe + 打印）、章节地图联动世界地图、时间线地点筛选。`docs/WORLD-MODEL.md` 有完整契约与实现记录；`node --test` 105/105。
>
> **2026-10-24 新增（未发布）**：**注意力提分闭环**——冷读后不再只出审阅：新提案 kind `attention-fix` 产段落级补丁（≥3 条、≥2 个 target、`before` 逐字唯一、预期提分合计 ≤40），采纳只改补丁段并自动备份、自动进「待复测」；零上下文复测（不透露旧分）写 `scoreHistory` 与 Δ；四拍 `breakdown`、`dropPoints` 落账；新工具 `novel_desk_attention_fix`（workorder/recheck/scoreboard）与交接任务 `attention-fix`/`attention-recheck`；注意力页新增 🎯 提分工作台（按提分空间降序，支持「生成全部提分方案 N 章 / 勾选生成选中方案 K 章 / 复测全部待复测」，>3 章自动批量工作单，不再写死前 5 章）、章节卡四拍条/弃读点/补丁记录/`61 → 68 +7`、统计条与总览「提分闭环」；checks 新增 4 条；工作单/冷读 prompt 不再把正文贴进对话（只给章节文件路径，由 AI 自己 read）。另：复核（复测）后新发现的问题现在会落成**审稿条目**——复测单强制 `novel_desk_review(origin="recheck")`（每章 1~3 条、跨章共性问题 `chapter=0`），审稿页可按来源筛选、勾选/忽略/加入清单；`novel_desk_review` 支持一次多章、`origin`/`quote`/中文严重度、同题去重与重新打开；`review-to-proposals` 把注意力/节奏类合并成 `attention-fix` 段落补丁（`reviewIds` 覆盖），提案页显示「处理 N 条审稿」；提分工作台加「看复核审稿（N）」；checks 加 `attention-recheck-no-review`。契约 `docs/ATTENTION-FIX.md`（含 §10 复核落审稿、§11 提案去重），测试 289/289（新增 37 例）。另：复测时同一章重复提交注意力提案现在只会留一张待采纳卡（完全相同的复用、同章同角色重打分原地覆盖），历史已采纳重复保持原样。
>
> **2026-10-24 再增（未发布）**：**去 AI 化审阅硬隔离**——作者反馈「让它去做去 AI 化审核，它去对比了《鱼龙舞》」。根因：旧 `review.startDeai` 虽新建空会话，但 prompt 没有隔离禁令也没有本书章节清单，AI 自己翻工作区，父目录并列着其他作品、`_work/` 里还有旧人类基线报告。现在 `startDeaiReview()` 先把本书章节正文复制到 `<StoryDesk>/.deai-workspaces/<作品名-id>/chapters/`（只含本书副本），再在该目录新建独立会话；prompt 重写为「独立会话 · 零上下文 · 只审本书」，含硬性边界 6 条（禁止读上级目录/其他作品/`library.json`/`_work`、禁止跨作品对比与「人类对照/人写基线」）与「章节文件清单（唯一允许读取的文件）」；审稿侧 `origin` 新增 `deai`，`quote` 必须逐字存在于本章正文，内容命中其他作品名（含变体）整批拒绝。新增工具 `novel_desk_deai_review`（start/workorder）；prompt 与审稿页给出公开检测入口「朱雀 AI 检测」（`https://matrix.tencent.com/ai-detect/`，只给链接不上传）。测试 295/295。
>
> **2026-10-24 三增（未发布）**：**所有审阅硬隔离**——作者要求「所有审阅都必须硬隔离，不能产生任何污染，除非用户指定目录或文件，否则绝不允许其他书籍污染当前书籍」。隔离从去 AI 化推广到全部审阅链路：统一隔离区 `<StoryDesk>/.review-workspaces/<作品名-id后6位>/<12位指纹>/chapters/`（指纹按章号+正文算：同批章幂等复用，全书审阅与单章工作单各占目录、互不清文件；只写本书章节正文副本），零上下文首读（单章/全书）、提分工作单、复测单、全文重新审阅、按审稿出提案的 prompt 都只给隔离区文件路径；`review.startFull` 不再走 pipeline 会话，改 `startFullBookReview()` 在隔离区新建独立零上下文会话（返回 `workspacePath`/`chapterCount`）；带账本上下文的审阅任务（full-review/import-review/review-chapter/review-fix）插 `REVIEW_ISOLATION_NOTICE_LINES`。提交侧跨作品名/`origin=deai` 引文校验保留。测试 302/302（新增 `test/review-isolation.test.js` 7 例）。
>
> **2026-10-22 深夜新增（未发布）**：⚡ 注意力模块——`attention.json` 每章一个 0–100 总分 + 四拍 + 详细说明；新页签「⚡ 注意力」带 100 分制曲线与章节诊断卡，伏笔/冲突/高光按章号聚合（零迁移）；第 11 角色「注意力设计师」`weight=10`（总编 9、独立审稿人 8、其余 3），分工表加权重列；独立审稿人冷读加类型化评分（`novel_desk_propose(kind=attention)`）；8 条确定性 checks；侧边栏改为四组导航。`node --test` 74/74。

### npm 0.4.0 发布记录（已解决）

- **0.4.0 已发布成功**：`npm view dsh-long-novel-workbench version` → `0.4.0`，`latest` → `0.4.0`。
- 实际发布路径是 **tag 触发的 GitHub Actions**（`.github/workflows/publish.yml`，tag `v0.4.0`，run `39636747121`，14s success），使用 repo secret `NPM_TOKEN`。
- 本机安全文件 `~/.dsh-secrets/npm-token-dsh-long-novel-workbench`（600）与 secret 同源；token 可用。**本地再 publish 同一版本会报「cannot publish over previously published versions」，这不是权限问题。**
- 以后发版推荐流程：`npm version patch|minor` → 提交 → `git tag vX.Y.Z` → `git push origin main --tags` → 等 Publish workflow → `npm pack` + `gh release create`。
- 如确实要在本地直接发：先 `npm view ... version` 确认版本未存在，再用带 Bypass 2FA 的 granular token；或者交互式 `npm publish` 走 WebAuthn/OTP（本机安全密钥注册曾失败，优先走 CI）。

### 关键路径

```
~/Documents/deepseek-harness/dsh-long-novel-workbench   插件源码 / DSH 工作区
~/StoryDesk                                            写作数据（和代码分离）
~/StoryProject                                         原小说项目（已不含插件）
~/.dsh/profiles/desktop                                桌面端 profile（插件安装处）
```

---

## 3. 文件地图

```
index.js            Host 半边：/novel-desk/api 路由 + 7 个 Agent 工具
client.js           浏览器半边：全屏工作台 + 侧栏入口（React.createElement，无构建；v0.4 约 2350 行）
lib/store.js        数据层：作品库、章节 frontmatter、账本、提案、审稿、预设、章节历史、批量操作、导出入口
lib/checks.js       确定性检查：事实区间冲突、伏笔超期、人物未建卡、审稿、计划对齐（多预设/多卷）
lib/defaults.js     默认写作方案 + 8 套名家风格预设 + 11 个 Agent 分工（含独立审稿人、注意力设计师）+ 类型化打分校准表
lib/ai.js           宿主 LLM 调用：下一章方案/续写/审稿/抽取/补时间线/按意见修订
lib/importer.js     v0.4：Markdown 目录扫描与导入（#/## 切章、append 续号）
lib/zip.js          v0.4：零依赖 ZIP 打包（deflateRawSync + CRC32）
lib/exporters.js    v0.4：EPUB 3 / DOCX 生成
cordis.patch.yml    bundle 插入行（id: story-desk，name: dsh-long-novel-workbench）
package.json        dsh.bundle + dsh.client 清单；scripts.test = node --test
locale/             中英文显示名与描述
docs/screenshots/   三张 v0.3 真实界面截图（README 用）
docs/v0.4-CONTRACT.md  v0.4 开发契约（数据/API/前端/测试口径，保留作接口参考）
test/               node:test 测试（checks/store/proposal/alignment/import-export/rpc）
.github/            CI、发布工作流、Issue 表单、PR 模板
CHANGELOG.md        版本变更
CONTRIBUTING.md     开发/测试/热重载/发布流程
PUBLISHING.md       发布/目录收录/发版流程
README.md           用户向说明（npm 安装、源码安装、截图、功能一览、开发测试）
HANDOVER.md         本文
```

### Agent 工具（前缀 `novel_desk_`）

| 工具 | 作用 |
|---|---|
| `novel_desk_projects` | 列出作品库 |
| `novel_desk_bundle` | 读完整结构（章节/事实/时间线/伏笔/冲突/人物/高光/审稿/提案/对齐/检查） |
| `novel_desk_context` | 写作上下文（预设、9 Agent 分工、人物、事实、伏笔、冲突、审稿、最近章节） |
| `novel_desk_plan` | 下一章"工作单"：目标章号、字数、必须延续的设定、上一章结尾、要求的 JSON |
| `novel_desk_propose` | 提交提案（plan/chapter/events/facts/characters/foreshadow/highlights/custom） |
| `novel_desk_review` | 提交审稿意见 |
| `novel_desk_upsert` | 直接写数据（仅作者明确要求"直接改"时用） |

### HTTP API

`POST /novel-desk/api`，body `{op, ...}`。ops：

```
ping / library / bundle
project.create|update|delete
chapter.save|delete|history|version|restore
entity.upsert|delete|list
proposal.create|accept|reject|feedback|batchAccept|batchReject
review.batchUpdate
preset.builtin|add|apply
import.scan|import.run
export（format: md|epub|docx，默认 md）
ai.run
```

鉴权：`connection.requestRejection` 不通过时，同源 loopback（`Sec-Fetch-Site: same-origin`）放行。用 curl 测试要带：
`-H 'sec-fetch-site: same-origin' -H 'content-type: application/json'`。

关键返回形状（前端已依赖）：

- `chapter.history` → `[{file, savedAt, bytes}]`（倒序，最多 100）
- `chapter.version` → `{file, savedAt, content}`（`content` 是**完整文件**，含 frontmatter；前端 diff 时自己剥）
- `chapter.restore` → `{chapter, backup}`
- `proposal.batchAccept` → `{accepted:[{id,applied}], failed:[{id,error}]}`
- `proposal.batchReject` → `{rejected:[id], failed:[{id,error}]}`
- `review.batchUpdate` → `{updated, missing}`
- `import.scan` → `{path, files, chapters, totalWords}`
- `import.run` → `{projectId, projectName, chapters, skipped}`
- `export` → md: `{filename, mime, markdown}`；epub/docx: `{filename, mime, base64}`

---

## 4. 怎么开发 / 调试

### 测试与语法检查（零依赖）

```sh
npm test                    # node --test（自动发现 test/*.test.js）
node --test test/*.test.js  # 只跑真实用例（32 个）
node --check index.js
node --check client.js      # 浏览器模块，只查语法
```

测试全部用 `mkdtemp` 临时根，不碰 `~/StoryDesk`。注意：`node --test test/` 在 Node 22.22 会报 `Cannot find module .../test`，**不要用目录参数**，用 `node --test`。

### 改 Host 代码后重载

```
plugin_manager({ action: "set_bundle", target: "dsh-long-novel-workbench", enabled: false })
plugin_manager({ action: "set_bundle", target: "dsh-long-novel-workbench", enabled: true })
```

或从本地重装（会换成 link 本地目录）：

```
plugin_manager({ action: "remove_bundle", target: "dsh-long-novel-workbench" })
plugin_manager({ action: "install_bundle", target: "/Users/micellince/Documents/deepseek-harness/dsh-long-novel-workbench" })
```

**不重载 = 新 HTTP op 全部 404**（当前运行中的 Host 就是旧代码，这是 v0.4 没做浏览器验收的原因）。

### 改客户端（client.js）

Host 重载不会重新加载浏览器模块；**刷新 DSH 页面**。客户端模块 id 必须等于包名 `dsh-long-novel-workbench`，否则不会被装上。

### 验证 API

```sh
curl -sS -H 'sec-fetch-site: same-origin' -H 'content-type: application/json' \
  -X POST -d '{"op":"ping"}' http://127.0.0.1:<当前端口>/novel-desk/api
```

端口看运行时上下文里的 GUI URL。旧 Host 上可以先用 `ping` / `bundle` 判断是否已重载；`{"op":"chapter.history"}` 回「未知操作」即旧代码。

### 验证 UI（截图/视觉）

本机 Chrome 没开远程调试、系统截图权限也没有。旧会话验证过的办法：

1. 临时在插件里加一个 `debug_auth_url` 工具，返回
   `ctx.get('connection').authenticatedUrl(ctx.get('webServer').getOrigin())`；
2. 调用工具拿到带 token 的 GUI URL；
3. 无头 Chrome 启动 `--remote-debugging-port=9334 --user-data-dir=/tmp/...`；
4. 用 CDP（Node 全局 WebSocket）导航到该 URL、等页面加载、用 JS 点侧栏入口和 `.sd-nav-item`、`Page.captureScreenshot` 存 PNG；
5. **验收前必须删掉 debug 工具并重装**，不要发布带后门的版本。

v0.4 没做这一步（Host 未重载 + 没拿到 authenticated URL）。下一次发版前建议补上，并把三张截图换成 v0.4（关系图/泳道/章节历史）。

### 数据测试

用 `STORY_DESK_ROOT=/tmp/xxx` 指向临时目录，避免污染 `~/StoryDesk`。

---

## 5. v0.4 做了什么（重要决策）

1. **人物关系图**：人物页「列表 / 关系图」切换。解析 `名字(关系)` / `（关系）` / `名字:关系`；SVG 力导向（确定性初始化 + 80 次迭代）、按 role 着色、幽灵节点、拖拽、悬停高亮邻接、点击开卡。
2. **时间线泳道**：按卷（数据有 `volume`）或每 20 章分道，横轴章号；事件按重要度着色；伏笔埋收弧线（已回收灰虚线）；0.5x–3x 缩放。
3. **自动保存 + 章节历史**：编辑器 5 秒防抖自动保存；每次覆盖且内容变化前自动备份到 `.backups/`（每章最多 100 份）；历史列表 / 查看 diff / 恢复（恢复前再备份）。手动保存、采纳正文提案都复用同一套备份函数。
4. **批量审稿 / 批量采纳**：提案页类型筛选 + 全选 + 批量采纳/驳回；审稿页严重度筛选 + 全选 + 批量标记已修/忽略。后端逐条执行、失败隔离，前端列出失败项。
5. **事实时间维度**：`validFrom` / `validTo` 可选；只有生效区间重叠且取值不同才报冲突；缺省 = 全程。这修掉了「同一属性在不同阶段合法变化被一刀切报错」的误报。
6. **Markdown 导入**：扫描本机目录（深度 5，跳过隐藏/node_modules/.git），优先按 `#` / `##` 切章；无标题一文件一章；可新建作品，也可 append 并从现有最大章号续号。只读扫描，不改原目录。
7. **EPUB / DOCX 导出**：零依赖（自带 ZIP + CRC32）；EPUB 3 `mimetype` 第一条且 STORE；DOCX 含 `Heading1`。前端直接下载。
8. **多预设 / 多卷对齐**：`project.activePresetId` + 预设页「设为当前」；对齐优先当前预设 → 多卷预设汇总（`chapterFrom/chapterTo`）→ 第一套（旧行为）。对齐页显示当前预设名。
9. **测试 + CI + 文档**：`test/` 32 个用例、CI 矩阵 Node 22/24、publish workflow、CHANGELOG/CONTRIBUTING/Issue 模板/README 更新。
10. **社区目录 PR #8520**：已开，等仓库年龄 gate 自动转绿。

### 已知的坑 / 注意

- **npm `0.0.0-stage` 占位版本**：首次发布被 staged publishing 机制生成，`latest` 正常；带 Bypass 2FA 的 granular token **不能 unpublish / 改 dist-tag**，删不掉，别纠结。
- **pnpm minimumReleaseAge**：本机 profile 会拦截刚发布的新版本（可能是 24h 冷却）。遇到"npm 上已是新版、装下来还是旧版"，删 `~/Library/Caches/pnpm/v11/metadata/registry.npmjs.org/dsh-long-novel-workbench.jsonl` 再装，或等冷却。
- **npm 2FA**：账号是 security-key（WebAuthn），CLI 发布需要带 Bypass 2FA 的 granular token；安全密钥注册曾失败，不要再折腾注册。
- **凭据**：npm token 和 5 行恢复码曾在旧会话里明文出现过。**不要写进仓库**。建议：发版用完后 revoke token；恢复码去 npm 重新生成一组。
- **客户端 id / 包名 / patch 行名** 三者要一致，改包名时一起改。
- **不要手工改 profile 的 package.json / cordis.patch.yml**，一律走 `plugin_manager`。
- **Host 不重载，新 op 全 404**：前端已经按新 op 写，但当前进程里是旧 Host；验收前先 `set_bundle` 重载。
- **`chapter.version` 的 `content` 是完整文件（含 frontmatter）**：前端历史 diff 已用 `stripChapterFrontmatter` 剥掉；如果以后直接展示，记得处理。
- **事实清空区间发 `null`**：`entity.upsert` 是对象 merge，删不掉 key，前端用 `null` 覆盖；`checks` 把 `null` 当缺省。数据文件里可能留下 `"validFrom": null`，无害。
- **备份上限 100/章**：自动保存频繁时旧快照会被清理，这是有意的。
- **没有真实浏览器验收**：前端逻辑有 /tmp 的 React shim 冒烟（37 项），但拖拽/缩放/下载等交互没在真浏览器点过。
- **导入路径是服务端本机路径**：插件跑在用户机器上，这是本地功能；不要把它暴露成远程可调用的公网接口。

---

## 6. 后续工作（按优先级）

### P0 · 发布与收尾

1. ~~发 0.4.0~~ **已完成**：npm 0.4.0 已上线；GitHub Release `v0.4.0` 已建（tarball 稳定链接）。
2. **社区目录 PR #8520**：2026-10-22 22:50 后 gate 应自动转绿；转绿后确认目录页能搜到。
3. ~~真实浏览器验收 + 换截图~~：**已完成**（见第 2 节与 `docs/releases/v0.4.0.md` 第三节）。
4. ~~在真 GitHub Actions 上跑 CI~~：**已完成**，Node 22/24 全绿。

### P1 · 继续做厚

5. **i18n**：UI 文案目前中文硬编码；把 `client.js` 的文案抽到 `locale/*.json`（插件行元数据已中英双语）。
6. **性能**：`getBundle` 现在全量读章节；几百章后要分页/懒加载 + 列表虚拟化（可用 `chapter.save` 返回的 `words` 先做摘要接口）。
7. **章节版本更细**：历史列表分页、跨版本对比（现在只和当前稿 diff）、手动打标签/命名版本。
8. **关系图增强**：分组布局（按阵营/门派）、边类型筛选、导出 SVG/PNG。
9. **导入增强**：append 模式的 UI（后端已支持）、frontmatter 映射到章节字段、导入时用 AI 生成摘要/人物/事实提案。
10. **导出增强**：PDF（需要额外渲染，可能引依赖）、设定集/人物卡导出。

### P2 · 工程

11. **测试**：当前 32 个用例覆盖主链路；补真实 RPC 冒烟（需要 `index.js` 导出 `handleRpc` 或注入假 ctx）、并发保存、超大文件导出。
12. **CI**：加 `npm pack --dry-run`、README 链接检查；publish workflow 用 trusted publishing（OIDC）替代长期 token。
13. **Issue/PR 模板** 已补，后续按实际反馈调整。

---

## 7. 给下一个会话的起手建议

如果在这个工作区新开会话，建议先让 Agent：

1. 读 `HANDOVER.md`（本文）和 `README.md`；
2. `git status` + `git log --oneline -5` 确认版本（v0.4.0 应已提交/推送）；
3. 先跑 `npm test` 和两个 `node --check`，确认基线；
4. 如果要做 UI：先按第 4 节重载 Host（`plugin_manager set_bundle`）再刷新页面，否则新 op 会 404；
5. 如果要发版：先跑 `npm view dsh-long-novel-workbench version`（应已是 0.4.0），改版本后走 tag → CI 发布，**不要**对已存在版本重跑本地 publish；
6. 不要读 `~/StoryProject` 的正文来写测试数据——插件是通用的，用 `STORY_DESK_ROOT=/tmp/...` 自建临时作品。

---

## 8. 一句话给作者

v0.3 把骨头立住了（数据是普通文件、AI 产出有人工闸门、失败可回滚、发布链路通）；v0.4 把「用起来顺不顺手」补了一轮：关系图、泳道、自动保存、历史回滚、批量处理、导入导出。接下来最该做的是 **发 0.4.0 + 真机点一遍 + 换截图**，然后才是 i18n 和性能。
