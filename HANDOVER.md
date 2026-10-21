# HANDOVER · 长篇中文小说工作台

> 交接时间：2026-10-22 凌晨（Asia/Shanghai）
> 当前版本：**v0.4.0**（代码完成、测试全绿；**尚未发布到 npm**，npm `latest` 仍是 0.3.1）
> 工作区：`/Users/micellince/Documents/deepseek-harness/dsh-long-novel-workbench`
> GitHub：https://github.com/micellince/dsh-long-novel-workbench
> npm：https://www.npmjs.com/package/dsh-long-novel-workbench
> 社区目录 PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8520

这是一份写给下一个会话/下一位接手者的交接文档：它是什么、现在在哪、怎么开发、哪里还没做完、下一步做什么。

---

## 1. 一句话

一个装在 **DeepSeek Harness** 里的**长篇中文小说工作台**插件：14 个页签管理章节、时间线、事实账本、伏笔、冲突、人物、高光、审稿、提案、计划对齐、Agent 分工、写作预设；v0.4 又加了人物关系图、时间线泳道、自动保存 + 章节历史/恢复/diff、批量审稿/采纳、事实生效区间、Markdown 导入、EPUB/DOCX 导出、多预设对齐。AI 可以直接读这些账本生成下一章/审稿/补时间线，但所有 AI 产出先进入「提案」，人工对比后才落盘。

**不是针对某一本书写的**，不绑定《碧血青霜缘》或任何现有作品。数据默认在 `~/StoryDesk`，全是普通 Markdown/JSON。

---

## 2. 当前状态

| 项 | 状态 |
|---|---|
| 代码 | v0.4.0，功能完成，`npm test` 32 个真实用例全绿（`node --test` 自动发现时多算一个空文件，共 33 pass） |
| npm | **未发布 0.4.0**；`latest` 仍是 `0.3.1`（2026-10-21 发布） |
| GitHub Release | 最新是 `v0.3.1`（附带免版本号 tarball）；0.4.0 未打 tag |
| 本机安装 | desktop profile 用 `link:` 指向本工作区；改 Host 代码要重载，改 `client.js` 刷新页面 |
| 社区目录 | PR #8520 已开、只加一个 YAML 文件；仓库创建于 2026-10-21 22:50，**24h 年龄门槛在 2026-10-22 22:50 自动满足**（gate 会自己重跑转绿，不用重提） |
| 自动化测试 | `test/` 已补：`node:test` + `node:assert/strict`，零依赖，临时目录，不碰 `~/StoryDesk` |
| CI | `.github/workflows/ci.yml`（Node 22/24：`npm test` + 两个 `node --check`）、`publish.yml`（tag `v*` 发布，需配 `NPM_TOKEN`） |
| 浏览器截图 | 仍是 v0.3 的三张（`docs/screenshots/`）；v0.4 没来得及重截 |
| 真实浏览器验收 | **未做**：当前 GUI 需要 authenticated URL，且运行中的 Host 仍是旧代码（新 op 会 404）。详见第 6 节 |

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
lib/defaults.js     默认写作方案 + 8 套名家风格预设 + 9 个 Agent 分工
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

1. **发 0.4.0**（需要你本人/有 token 的会话）：
   - `npm test` 全绿后 `npm publish --access public`
   - `npm pack` → 重命名去版本号 → `gh release create v0.4.0 ...`
   - 确认 GitHub Actions 的 `NPM_TOKEN` secret 已配（或改 trusted publishing）
   - 同步 PUBLISHING/README/HANDOVER 的版本状态
2. **社区目录 PR #8520**：2026-10-22 22:50 后 gate 应自动转绿；转绿后确认目录页能搜到。
3. **真实浏览器验收 + 换截图**：按第 4 节方法重载 Host、拿 authenticated URL，逐项点：关系图拖拽/悬停/幽灵建卡、泳道缩放/弧线、自动保存/历史 diff/恢复、批量提案/审稿、事实区间清空、导入预览/导入、EPUB/DOCX 下载、预设当前标记。
4. **在真 GitHub Actions 上跑一次 CI**（本地只做了 YAML 语法/结构校验）。

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
5. 如果要发版：先跑 `npm view dsh-long-novel-workbench version`（应还是 0.3.1），再按 `PUBLISHING.md` 发 0.4.0；
6. 不要读 `~/StoryProject` 的正文来写测试数据——插件是通用的，用 `STORY_DESK_ROOT=/tmp/...` 自建临时作品。

---

## 8. 一句话给作者

v0.3 把骨头立住了（数据是普通文件、AI 产出有人工闸门、失败可回滚、发布链路通）；v0.4 把「用起来顺不顺手」补了一轮：关系图、泳道、自动保存、历史回滚、批量处理、导入导出。接下来最该做的是 **发 0.4.0 + 真机点一遍 + 换截图**，然后才是 i18n 和性能。
