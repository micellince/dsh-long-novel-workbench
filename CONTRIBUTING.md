# 参与贡献

这个项目是一个 **DeepSeek Harness（DSH）插件**：宿主层 `index.js` 注册 HTTP 路由与 Agent 工具，浏览器层 `client.js` 渲染全屏工作台。数据层在 `lib/`，用户数据是普通 Markdown/JSON 文件。

感谢你想帮忙。下面是最短的开发、测试与发布路径。

## 环境要求

- **Node `^22.19.0 || >=24.0.0`**（`package.json` 的 `engines` 字段，CI 跑 22 / 24 两个版本）；
- 熟悉 ESM（`"type": "module"`）；
- 一个能装插件的 DSH 环境，用来手动验证 UI；
- **不需要安装依赖，也不要新增依赖**：仓库没有 `dependencies`，也没有锁文件，所以 `npm install` / `npm ci` 都不是必需的（`npm ci` 会因为没有 lockfile 直接失败）。测试用 Node 内置的 `node:test`，零依赖。

## 本地加载插件

DSH 的插件按 profile 管理。开发时推荐让 profile 直接指向**本地工作区**，这样改代码、重载即可：

```
plugin_manager({ action: "remove_bundle", target: "dsh-long-novel-workbench" })
plugin_manager({ action: "install_bundle", target: "/绝对路径/dsh-long-novel-workbench" })
```

也可以把 profile 里的插件目录 link / 指向本仓库（效果等价于本地安装）。装好后左下角会出现「📖 长篇中文小说工作台」。

### 改 Host（`index.js`、`lib/*.js`）：重载插件

Host 代码不会热更新，改完要重载：

```
plugin_manager({ action: "set_bundle", target: "dsh-long-novel-workbench", enabled: false })
plugin_manager({ action: "set_bundle", target: "dsh-long-novel-workbench", enabled: true })
```

### 改 `client.js`：刷新页面

Host 重载**不会**重新加载浏览器模块。改客户端后刷新 DSH 页面。注意客户端模块 id 必须等于包名 `dsh-long-novel-workbench`，否则不会被装上。

### 验证 API

```sh
curl -sS -H 'sec-fetch-site: same-origin' -H 'content-type: application/json' \
  -X POST -d '{"op":"ping"}' http://127.0.0.1:<当前端口>/novel-desk/api
```

端口看当前会话的运行上下文（DSH Web GUI URL）。

## 测试

```sh
npm test                       # node --test test/
node --check index.js          # Host 入口语法
node --check client.js         # 浏览器模块只做语法检查
```

- 测试用 `mkdtemp` 建临时数据根，**理论上不会碰 `~/StoryDesk`**；手动脚本 / 调试仍建议显式隔离：
  ```sh
  STORY_DESK_ROOT=/tmp/storydesk-dev npm test
  ```
  注意 `npm test` 里的测试自己管理临时目录，`STORY_DESK_ROOT` 主要给手动验证和临时脚本用。
- 不要把测试指向真实写作数据；不要在 `~/StoryDesk` 上做破坏性验证。
- 提交 PR 前请保证 `npm test` 全绿，且两个 `node --check` 通过。CI 会在 Node 22 / 24 上重复这些检查。

## 代码风格

- 与现有代码一致：**2 空格缩进、单引号、行尾不加分号**、注释用中文；
- 不引入构建步骤（客户端仍是 `window.__ModuleLoader__.load` + `React.createElement`）；
- 不新增第三方依赖；
- 数据模型改动必须**向后兼容**：旧版本没有新字段的数据要能照常读写；
- 文件读写只允许落在 `STORY_DESK_ROOT`（导入功能例外：只读用户显式给出的目录）；
- 改数据格式 / API / 行为时，同时更新 `README.md` 与 `CHANGELOG.md`。

## 提交 PR

- 从 `main` 切分支，一个 PR 做一件事；描述里说明「改了什么、为什么、怎么验证」；
- 关联相关 Issue；UI 改动附截图更好（`docs/screenshots/` 已有三张示意截图）；
- 不要提交调试代码、临时文件、生成物（`*.tgz`、日志）以及任何凭据；
- 不要执行 `git commit` / `git push` / `npm publish`——由维护者统一提交和发布。

## 发布流程（维护者）

1. `npm test` 全绿，`node --check index.js`、`node --check client.js` 通过；
2. 在 `CHANGELOG.md` 顶部加新版本条目（日期写实际发布日）；
3. 统一修改 `package.json` 的版本号（遵循 SemVer：修 bug 用 patch，新功能用 minor）；
4. 提交并打 tag，例如 `v0.4.0`；推送 tag 会触发 `.github/workflows/publish.yml`：
   - 工作流会先跑测试、校验 tag 与 `package.json` 版本一致，然后
   - 用仓库 secret `NPM_TOKEN` 作为 `NODE_AUTH_TOKEN` 执行 `npm publish --access public`；
5. 发布后验证：`npm view dsh-long-novel-workbench version`；
6. 需要 GitHub Release tarball 时：`npm pack` 后重命名去掉版本号，`gh release create vX.Y.Z dsh-long-novel-workbench.tgz`。

> npm 账号开了 2FA 时，CI 用的 token 需要是带 **Bypass 2FA** 的 granular token；这类 token 不能做 unpublish / 改 dist-tag 等治理动作。以后可以换成 npm **trusted publishing（OIDC）**，见 `publish.yml` 里的注释。

## 不要提交凭据

- npm token、2FA 恢复码、`.npmrc`、API key、Cookie、个人绝对路径，**一律不要进仓库**；
- 如果不小心提交了：立刻去 npm revoke token 并重新生成，再处理 Git 历史；
- CI 里只通过 GitHub Actions secrets 注入，不要写进 YAML 或代码。

## 相关文档

- `README.md` — 用户向说明（安装、功能、数据位置）；
- `CHANGELOG.md` — 版本变更；
- `PUBLISHING.md` — npm / 社区目录收录的细节；
- `HANDOVER.md` — 交接现状、已知坑、路线图；
- `docs/v0.4-CONTRACT.md` — v0.4 的接口与行为约定（内部文档）。
