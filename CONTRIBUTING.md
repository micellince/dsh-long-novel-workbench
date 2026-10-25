# 参与贡献

这个项目是一个 **DeepSeek Harness（DSH）插件**：宿主层 `index.js` 注册 HTTP 路由与 7 个 Agent 工具，浏览器层 `client.js` 渲染全屏工作台（正文 / 审阅 / 提案 / 全文动作 / 账本 / 总览 / 设置）。数据层在 `lib/`（`store` / `prose` / `gates` / `attention` / `aistyle` / `prompts` / `usage` / `exporters` / `zip`），用户数据是普通文本与 JSON 文件（正文为 `chapters/NNNN.txt` + `NNNN.meta.json`，旧的 `.md` 仍可读）。

0.6 的接口与数据形状以 [`docs/REBUILD-CONTRACT.md`](docs/REBUILD-CONTRACT.md) 为准；已验证到什么程度见 [`docs/ACCEPTANCE-0.6.md`](docs/ACCEPTANCE-0.6.md)。

感谢你想帮忙。下面是最短的开发、测试与发布路径。

## 环境要求

- **Node `^22.19.0 || >=24.0.0`**（`package.json` 的 `engines` 字段，CI 跑 22 / 24 两个版本）；
- 熟悉 ESM（`"type": "module"`）；
- 一个能装插件的 DSH 环境，用来手动验证 UI；
- 跑界面测试需要本机有 Chrome（`scripts/ui-e2e.mjs` / `scripts/ui-smoke.mjs` 直接调无头 Chrome；可用 `--chrome` 指定路径）；
- **不需要安装依赖，也不要新增依赖**：仓库没有 `dependencies`，也没有锁文件，所以 `npm install` / `npm ci` 都不是必需的（`npm ci` 会因为没有 lockfile 直接失败）。测试用 Node 内置的 `node:test`，零依赖；界面测试用 CDP，同样零依赖。

## 本地加载插件

DSH 的插件按 profile 管理。开发时推荐让 profile 直接指向**本地工作区**，这样改代码、重载即可：

```
plugin_manager({ action: "remove_bundle", target: "dsh-long-novel-workbench" })
plugin_manager({ action: "install_bundle", target: "/绝对路径/dsh-long-novel-workbench" })
```

也可以把 profile 里的插件目录 link / 指向本仓库（效果等价于本地安装）。装好后左下角会出现「📖 小说工作台」。

本仓库目录名是历史遗留的 `dsh-long-novel-workbench-0.5.2`，安装时指向**这份工作树**即可；包名与 bundle 名都以 `dsh-long-novel-workbench` 为准（`cordis.patch.yml` 的行 id 是 `novel-desk`）。

**0.6 与 0.5.x 不能同时启用**（同名路由 `/novel-desk/api` 与同名工具会冲突），切换必须原子：先移除旧包，再装 0.6。

### 改 Host（`index.js`、`lib/*.js`）：重载插件

Host 代码不会热更新，改完要重载：

```
plugin_manager({ action: "set_bundle", target: "dsh-long-novel-workbench", enabled: false })
plugin_manager({ action: "set_bundle", target: "dsh-long-novel-workbench", enabled: true })
```

### 改 `client.js`：刷新页面

Host 重载**不会**重新加载浏览器模块。改客户端后刷新 DSH 页面。注意客户端模块 id 必须等于包名 `dsh-long-novel-workbench`，否则不会被装上。

### 验证 API

工作台接口（`POST /novel-desk/api`，body `{op, payload}`）受宿主认证保护：只回环地址 + Host 白名单 + 同源请求放行，**未认证请求返回 401**（返回体不含 CORS 头）。

所以不建议用裸 `curl` 测业务接口；调试要么在工作台页面里发请求（自带 DSH 会话 cookie），要么用浏览器带同源 cookie 的 `fetch`。只想确认路由活着，看未认证是否被 401 拦下即可：

```sh
curl -sS -i -X POST -H 'content-type: application/json' \
  -d '{"op":"ping"}' http://127.0.0.1:<当前端口>/novel-desk/api
# 期望：401 unauthorized（说明守卫生效）
```

端口看当前会话的运行上下文（DSH Web GUI URL）。真正要验证接口行为，请跑 `npm test`（`handleRpc` 直接覆盖）或 `npm run e2e`。

## 测试

```sh
npm test                       # node --test test/*.test.js（0.6.11：164/164）
npm run check                  # index.js / client.js / lib/*.js 语法检查
npm run e2e                    # 界面端到端 116 条（真实 handler + store + 无头 Chrome）
npm run smoke                  # 界面冒烟 12 个页面/页签（无头 Chrome 截图）
npm run smoke -- --size 500x844  # 窄屏 / 手机布局
node scripts/preflight.mjs     # 体检：插件装上没、有没有动作在跑、还有多少旧 .md、自检
node scripts/migrate.js --dry-run   # 旧 .md → .txt + meta，默认只打印计划
```

- 测试用 `mkdtemp` 建临时数据根，**不会碰 `~/StoryDesk`**；手动脚本 / 调试仍建议显式隔离：
  ```sh
  STORY_DESK_ROOT=/tmp/storydesk-dev npm test
  ```
  注意 `npm test` 里的测试自己管理临时目录，`STORY_DESK_ROOT` 主要给手动验证和临时脚本用。
- 不要把测试指向真实写作数据；不要在 `~/StoryDesk` 上做破坏性验证。界面测试在**作品副本**上跑造数据，跑完会清理。
- 界面测试需要本机 Chrome（默认 macOS 路径，可用 `--chrome` 覆盖）；没有图形环境时可先只跑 `npm test` + `npm run check`。
- 提交 PR 前请保证 `npm test` 全绿、`npm run check` 通过；UI 改动再加跑 `npm run e2e`。CI 会在 Node 22 / 24 上重复 `npm test` 与语法检查。

## 代码风格

- 与现有代码一致：**2 空格缩进、单引号、行尾不加分号**、注释与用户文案用中文、标识符英文；
- 不引入构建步骤（客户端仍是 `window.__ModuleLoader__.load` + `React.createElement`，CSS 内联在 `client.js` 里）；
- 不新增第三方依赖（`react` 由宿主提供）；
- 正文是**纯文本**：不渲染 Markdown、不引入富文本编辑器；`※` 是场景分隔符；
- **所有正文写入必须走 `writeChapterWithGates`**（`lib/gates.js`）：规范化 → 保真 → 残留扫描 → 去 AI 味 → 落盘；不要绕过闸门直接写 `chapters/*`；
- 数据模型改动必须**向后兼容**：没有新字段的旧数据要能照常读写；旧 `.md` 章节要能继续读、写回原格式、未知 frontmatter 键原样保留；
- AI 只能出提案（`proposal`）与审阅条目（`review`），不要新增「AI 直接改正文」的路径；
- 文件读写只允许落在 `STORY_DESK_ROOT`（导入功能例外：只读用户显式给出的目录）；
- 改数据格式 / API / 行为时，同时更新 `docs/REBUILD-CONTRACT.md`、`README.md` 与 `CHANGELOG.md`。

## 提交 PR

- 从 `main` 切分支，一个 PR 做一件事；描述里说明「改了什么、为什么、怎么验证」；
- 关联相关 Issue；UI 改动附截图更好（`docs/screenshots/` 里是 0.6 各页面的真实截图，`docs/shots-0.6.x/` 是分版本的过程截图）；
- 不要提交调试代码、临时文件、生成物（`*.tgz`、日志）以及任何凭据；
- 不要执行 `git commit` / `git push` / `npm publish`——由维护者统一提交和发布。

## 发布流程（维护者）

从 0.6.11 这次发布开始，发布统一走「推 tag → GitHub Actions」（本机 npm 凭据已失效，`npm whoami` 返回 401，本地 `npm publish` 不可用）：

1. `npm test` 全绿（0.6.11：164/164）、`npm run check` 通过；
2. 在 `CHANGELOG.md` 顶部加新版本条目（日期写实际发布日），并按需要补 `docs/releases/vX.Y.Z.md`；
3. 统一修改 `package.json` 的版本号（遵循 SemVer：修 bug 用 patch，新功能用 minor）；
4. 提交到 `main`，打 tag 并推送：
   ```sh
   git push origin main
   git tag v0.6.11 && git push origin v0.6.11
   ```
   `.github/workflows/publish.yml` 会先跑测试、校验 tag 与 `package.json` 版本一致，再用仓库 secret `NPM_TOKEN` 作为 `NODE_AUTH_TOKEN` 执行 `npm publish --access public`；
5. 发布后验证：`npm view dsh-long-novel-workbench version`、`npm view dsh-long-novel-workbench dist-tags`、`gh run list --workflow=publish.yml`；
6. 建 GitHub Release：`gh release create v0.6.11 --notes-file docs/releases/v0.6.11.md`；需要稳定 tarball 时再 `npm pack` 后重命名去掉版本号上传。

> npm 账号开了 2FA 时，CI 用的 token 需要是带 **Bypass 2FA** 的 granular token；这类 token 不能做 unpublish / 改 dist-tag 等治理动作。以后可以换成 npm **trusted publishing（OIDC）**，见 `publish.yml` 里的注释。完整发布与社区目录收录细节见 `PUBLISHING.md`。

## 不要提交凭据

- npm token、2FA 恢复码、`.npmrc`、API key、Cookie、个人绝对路径，**一律不要进仓库**；
- 如果不小心提交了：立刻去 npm revoke token 并重新生成，再处理 Git 历史；
- CI 里只通过 GitHub Actions secrets 注入，不要写进 YAML 或代码。

## 相关文档

- `README.md` — 用户向说明（安装、功能、数据位置、开发与测试）；
- `CHANGELOG.md` — 版本变更；
- `PUBLISHING.md` — npm 发布、tag → GitHub Actions 流程与社区目录收录细节；
- `docs/REBUILD-CONTRACT.md` — 0.6 的模块边界、数据模型与接口契约（改动前先读）；
- `docs/ACCEPTANCE-0.6.md` — 各版本逐节的验收证据与真实数字；
- `docs/MAP-MODEL.md` — 世界地图的模型与绘制规则；
- `docs/PRESET-TEMPLATE.md` — 写作预设「绝对模板」的字段口径；
- `docs/history/0.5.x/` — 0.5.x 线的历史文档与发布说明归档（含未发布的 0.5.2 开发记录，见 `CHANGELOG-unreleased-0.5.x.md`）。
