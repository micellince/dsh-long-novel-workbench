# 发布与收录（DSH 插件）

> 最后更新：2026-10-26（0.6.11 发布：整包重写为「读—批注—审—改」工作台）
> 当前版本：`0.6.11` ｜ npm 上此前 `latest` 是 `0.5.1`

## 结论先说

DSH 插件**没有“官方登记”这一步**。一个插件要能被别人安装、被市场收录，通常只做三件事：

1. **仓库里声明 `dsh.bundle`** —— 这是“可安装”的唯一硬门槛；
2. **发布到 npm**（推荐），或至少把预构建 `.tgz` 挂到 GitHub Release；
3. **向社区目录 awesome-dsh-plugin 提一个 PR**（一个 YAML 文件），它同时是 DSH 的插件市场索引。

许可证用 **MIT** 是社区惯例（本仓库已加 `LICENSE`）。

## 发布状态（2026-10-26）

- **当前 npm `latest`：`0.5.1`**（0.6.11 发布后会指向 0.6.11）。
- **0.6.11 的发版路径已确定：推 tag → GitHub Actions 发布**。
  - 本机 npm 登录凭据已失效：`npm whoami` 返回 `E401 Unauthorized`，本地 `npm publish` 不可用，**不要在本地硬试**；
  - 实际发版：推 `v0.6.11` tag → `.github/workflows/publish.yml` 先跑测试、校验 tag 与 `package.json` 版本一致，再用仓库 secret `NPM_TOKEN` 执行 `npm publish --access public`。仓库 secret 已有，`v0.5.1` 就是这样发出去的，链路可用；
  - 发布后 npm 上 `latest` 应从 `0.5.1` 指向 `0.6.11`。
- **GitHub Release**：正文用仓库里的 [`docs/releases/v0.6.11.md`](docs/releases/v0.6.11.md)，可直接整篇作为 Release 说明。
- **社区目录已收录**：PR #8520 已合并，条目文件 `data/plugins/micellince__dsh-long-novel-workbench.yml`。
  - 目录站的**版本号与下载数由市场每日探针（npm）自动更新**，不需要为 0.6.11 手动改版本；
  - 市场详情页 README 由目录仓库的每日构建从本仓库 `README.md` 自动同步，也不用手工贴；
  - 条目里的 `description`（en/zh）仍是 0.5.x 时代文案，**需要单独提一个 PR 更新**（本版由发布流程里的独立任务处理）。
- [ ] 发布后确认：npm `latest` 指向 0.6.11、GitHub Release 可见、市场详情页在下次构建后显示新 README。

## 发版流程（以后每个版本）

### 0. 预检（发版前必须全绿）

```sh
npm test          # 0.6.11：164/164
npm run check     # index.js / client.js / lib/*.js 语法检查
```

同时确认这几处版本/文案一致：

- `package.json` 的 `version`（必须与将要打的 tag 完全一致，`v` + 版本号）；
- `CHANGELOG.md` 顶部新增该版本条目（写实际发布日）；
- `docs/releases/vX.Y.Z.md` 发布说明（GitHub Release 正文）；
- `README.md` 里如果提到版本号/测试数量，一并更新；
- `PUBLISHING.md`（本文件）的「发布状态」。

### 1. 提交、打 tag 触发 npm 发布

```sh
git push origin main        # 发布提交先进 main
git tag v0.6.11
git push origin v0.6.11
```

推 tag 会触发 `.github/workflows/publish.yml`，它依次做：

1. `npm test`（不绿就不发）；
2. 校验 `v${package.json.version}` 与 tag 名一致（不一致直接失败）；
3. 用 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` 执行 `npm publish --access public`。

> 仓库没有依赖与锁文件，**不要用 `npm ci` / `npm install`**（会因为没有 lockfile 失败）；测试与发布都不需要安装依赖。

### 2. 发布后校验

```sh
npm view dsh-long-novel-workbench version        # 期望 0.6.11
npm view dsh-long-novel-workbench dist-tags      # latest 应指向 0.6.11
npm view dsh-long-novel-workbench time --json    # 看 0.6.11 的发布时间
gh run list --workflow=publish.yml --limit 3     # Publish 工作流应为 success
```

装一遍确认能装上（换一个干净的 profile / 或先移除再装）：

```
plugin_manager({ action: "remove_bundle", target: "dsh-long-novel-workbench" })
plugin_manager({ action: "install_bundle", target: "dsh-long-novel-workbench" })
```

装好后重载插件 + 刷新页面，侧栏应出现「📖 小说工作台」。

### 3. GitHub Release

```sh
gh release create v0.6.11 \
  --title "v0.6.11 · 长篇中文小说工作台" \
  --notes-file docs/releases/v0.6.11.md
```

`docs/releases/` 下的发布说明是成套的，直接作为 Release 正文即可；截图用仓库 `docs/screenshots/` 下的 raw 链接。

如果需要一个**免版本号**的稳定 tarball 安装地址（市场也可以用 `tarball:` 指过来）：

```sh
npm pack
# 生成 dsh-long-novel-workbench-0.6.11.tgz，复制并去掉版本号
gh release upload v0.6.11 dsh-long-novel-workbench.tgz
# 稳定链接：
# https://github.com/micellince/dsh-long-novel-workbench/releases/latest/download/dsh-long-novel-workbench.tgz
```

### 4. 文档同步（最容易漏）

- `CHANGELOG.md`：新增版本条目；
- `docs/releases/vX.Y.Z.md`：发布说明；
- `PUBLISHING.md`：更新「发布状态」与「最后更新」；
- `CONTRIBUTING.md`：如果测试数量 / 脚本 / 模块结构变了，同步更新；
- `README.md`：公开内容（安装、功能、开发与测试）；
- 目录条目：**不用改版本**（探针自动更新）；只有 `description` 这类静态文案变化时才需要 PR。

## 社区目录（awesome-dsh-plugin）

目录仓库：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
规则：一个 PR 加 / 改一个 `data/plugins/<owner>__<repo>.yml`；仓库创建满 1 天、有 `dsh.bundle`、有 `dsh-plugin` topic、描述与代码一致（维护者会读源码核对，不要写营销词、不要堆容易过期的数字）。

我们的条目已合并（PR #8520）：`data/plugins/micellince__dsh-long-novel-workbench.yml`。

- **版本号 / 下载数**：目录仓库的 nightly 探针会读 npm 自动更新，发完 npm 不用手动改；
- **详情页 README**：目录仓库每日构建会从本仓库 `README.md` 同步，改 README 后等下一次构建即可；
- **description**：静态文案，需要改时单独提 PR（0.5.x → 0.6.x 的描述更新由 0.6.11 发布流程中的独立任务处理）。

需要更新 description 时的命令（示例，分支名按实际情况）：

```sh
gh pr create \
  --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --head micellince:update-description-0-6 \
  --title "Update description for 0.6.x workbench" \
  --body "Same plugin; 0.6 is a rewrite: read → annotate → review → revise workbench."
```

CI 会检查：`dsh.bundle` 存在、仓库满 1 天、YAML 格式、README 自动生成。

## 清单（发布前自查）

- [x] `package.json` 声明 `dsh.bundle.patch`
- [x] 带 UI 时声明 `dsh.client`（`platform: web`）
- [x] 客户端模块 id 与包名一致（`dsh-long-novel-workbench`）
- [x] `cordis.patch.yml` 与包名一致（行 id `novel-desk`）
- [x] `LICENSE`（MIT）
- [x] `repository` / `homepage` / `bugs` / `keywords`（含 `dsh-plugin`）
- [x] `files` 白名单，`npm pack` 内容正确
- [x] GitHub public 仓库 + `dsh-plugin` topic + Release tarball
- [x] npm 发布走 tag → GitHub Actions（本地 token 不可用，见「发布状态」）
- [x] 社区目录已收录（PR #8520 已合并）
- [ ] 0.6.11 发布后：npm `latest` / Release / 市场详情页三项回读确认

## 备注（踩过的坑）

- **不要只声明 `dsh.client`**：那只会在浏览器注册 UI，`dsh plugin add` 装不上。
- **0.6 与 0.5 不能同时启用**：两者注册同名路由与同名工具，同时加载会在插件装配期报错。切换必须原子（先移除旧包，再装新包），装完重载插件 + 刷新页面。
- **2FA 与 token**：如果 npm 账号开了 2FA，CI 用的 `NPM_TOKEN` 必须是带 **Bypass 2FA** 的 granular token（只授权本包 read/write 即可）。这类 token 不能做 unpublish / 改 dist-tag 等治理动作。以后可换成 npm **trusted publishing（OIDC）**，见 `publish.yml` 里的注释——那样就不用长期在仓库里存 token 了。
- **曾经的 staged publishing**：0.3.1 发布时账号未开 2FA，npm 自动进入 staged publishing，随后版本正常上线，`0.0.0-stage` 是暂存占位版本，不影响安装。
- **官方 `@deepseek-ai/*` 包**如果被 import，应放 `peerDependencies`，不要放 `dependencies`。本插件没有 import 官方包（工具用原始 JSON Schema 注册），因此无需 peer 依赖。
- **目录收录不是安全审查**；安装第三方插件会以你的权限执行代码。
- **凭据**：npm token、2FA 恢复码、`.npmrc`、Cookie、个人绝对路径一律不要进仓库；发版后建议 revoke 旧 token、重新生成恢复码。CI 里只通过 GitHub Actions secrets 注入。
