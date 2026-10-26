# 发布与收录（DSH 插件）

> 最后更新：2026-10-26（**0.7.1 已发布**：GitHub tag/Release + npm）
> 当前版本：`0.7.1` ｜ npm `dist-tags.latest = 0.7.1`
> **权威发布手册：[`docs/RELEASE-RULES.md`](docs/RELEASE-RULES.md)。** 本文件只是摘要与历史备注；冲突时以 RELEASE-RULES 为准。

## 结论先说

DSH 插件**没有“官方登记”这一步**。一个插件要能被别人安装、被市场收录，通常只做三件事：

1. **仓库里声明 `dsh.bundle`** —— 这是“可安装”的唯一硬门槛；
2. **发布到 npm**（推荐），或至少把预构建 `.tgz` 挂到 GitHub Release；
3. **向社区目录 awesome-dsh-plugin 提一个 PR**（一个 YAML 文件），它同时是 DSH 的插件市场索引。

许可证用 **MIT** 是社区惯例（本仓库已加 `LICENSE`）。

## 🚨 红线（先读）

- **发布只能由作者本人发起。** Agent 不得执行 `git push` / `git tag` / `gh release` / `npm publish` / `gh pr create`，不得擅自改 `.github/workflows/*`，不得自己 `npm pack` 对外产出。见 `AGENTS.md` 与 `docs/RELEASE-RULES.md`。
- **npm 只由 GitHub Actions 发布**（推 `v*` tag 触发），不在本机 `npm publish`；本机 npm 登录凭据已失效（`npm whoami` → `E401`），不要本地硬试。
- **0.7.1 打 tag 前必须先处理 CI 测试门禁**（见下节风险），否则发布会被 `npm test` 挡住。

## 发布状态（2026-10-26，0.7.1 已发布）

- **0.7.1 已发布**（作者当次明确要求；发布流程：推 tag → GitHub Actions → npm）：
  - GitHub `main`：`a2335bf`；tag：`v0.7.1`；
  - GitHub Release：<https://github.com/micellince/dsh-long-novel-workbench/releases/tag/v0.7.1>；
    附件 `dsh-long-novel-workbench-0.7.1.tgz` 与稳定别名 `dsh-long-novel-workbench.tgz`（与 npm 官方 tarball 同一文件，sha1 `1d1096c45a09e8e0e2284f21820a7c91edc8477a`）；
  - npm：`dsh-long-novel-workbench@0.7.1`，`dist-tags.latest = 0.7.1`；`0.6.11` 仍在版本列表。
- **CI 测试门禁已按选项 C 更换（本次发布决定）**：`test/` 仍是 0.6 断言，原 `npm test` 会阻断发布；本次把 `ci.yml` / `publish.yml` 的 `npm test` 换成「`node --check` 语法 + 版本 / CHANGELOG / 发布说明一致性」预检，CI 与 npm 发布均通过。
  - **待办（0.7.2 前）**：把 `test/` 更新到 0.7 行为后恢复测试门禁（由作者决定；细节见 RELEASE-RULES §6）。
- **干净包已重建**：`release/dsh-long-novel-workbench/` = 0.7.1（解包自 npm 官方 tarball）；`release/dsh-long-novel-workbench-0.7.1.tgz` 与 npm 包一致。
- **社区目录**：PR #8520 已收录；版本号 / 下载数由市场探针自动更新（npm 已是 0.7.1），README 由每日构建自动同步。
  - 条目 `description`（en/zh）仍是 0.5.x 文案，是否需要单独 PR 由作者决定（RELEASE-RULES §7 有建议文案）。
- [x] 发布后确认：npm `latest` = 0.7.1；GitHub Release 可见、两个 tgz 附件已挂。
- [ ] 市场详情页在下次每日构建后显示新 README（自动，无需操作）。

## 发版流程（摘要，细节看 RELEASE-RULES）

以后每个版本的完整流程见 [`docs/RELEASE-RULES.md`](docs/RELEASE-RULES.md)。这里只列顺序：

```text
0) 版本一致性 + 干净实现落地检查        → RELEASE-RULES §2 / §8
1) 干净包：白名单 rsync → npm pack → tgz 校验 → sha256 → RELEASE-RULES §3
2) 本地 commit → 作者推 main → 作者打 tag vX.Y.Z → 推 tag   → RELEASE-RULES §4
3) tag 触发 GitHub Actions：npm test → tag/版本校验 → npm publish（NPM_TOKEN） → RELEASE-RULES §5
4) 发布后校验：npm view / gh run / 安装复验                    → RELEASE-RULES §10
5) GitHub Release：正文 + tgz 资产（作者执行）                 → RELEASE-RULES §4.1
6) 文档与市场同步：CHANGELOG / README / 市场探针（description 需人工 PR） → RELEASE-RULES §7
```

> 仓库没有依赖与锁文件，**不要用 `npm ci` / `npm install`**（会因为没有 lockfile 失败）；打包与发布都不需要安装依赖。

## 社区目录（awesome-dsh-plugin）

目录仓库：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
规则：一个 PR 加 / 改一个 `data/plugins/<owner>__<repo>.yml`；仓库创建满 1 天、有 `dsh.bundle`、有 `dsh-plugin` topic、描述与代码一致（维护者会读源码核对，不要写营销词、不要堆容易过期的数字）。

我们的条目已合并（PR #8520）：`data/plugins/micellince__dsh-long-novel-workbench.yml`。

- **版本号 / 下载数**：目录仓库的 nightly 探针会读 npm 自动更新，发完 npm 不用手动改；
- **详情页 README**：目录仓库每日构建会从本仓库 `README.md` 同步，改 README 后等下一次构建即可；
- **description**：静态文案，需要改时单独提 PR（0.7.1 建议从 0.5.x 文案更新为「问题单 + 修改稿」定位；是否提由作者决定）。

需要更新 description 时的命令（示例；**作者执行**，分支名按实际情况）：

```sh
gh pr create \
  --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --head micellince:update-description-0-7 \
  --title "Update description for 0.7.x workbench" \
  --body "Same plugin; 0.7 is a problems-and-drafts workflow: single-pass reading review + facts/logic lane, drafts accepted or revised."
```

CI 会检查：`dsh.bundle` 存在、仓库满 1 天、YAML 格式、README 自动生成。

## 清单（发布前自查，完整版见 RELEASE-RULES §8）

- [x] `package.json` 声明 `dsh.bundle.patch`
- [x] 带 UI 时声明 `dsh.client`（`platform: web`）
- [x] 客户端模块 id 与包名一致（`dsh-long-novel-workbench`）
- [x] `cordis.patch.yml` 与包名一致（行 id `novel-desk`）
- [x] `LICENSE`（MIT）
- [x] `repository` / `homepage` / `bugs` / `keywords`（含 `dsh-plugin`）
- [x] `files` 白名单，`npm pack` 内容正确（0.7.1 需重新打包校验）
- [x] GitHub public 仓库 + `dsh-plugin` topic + Release tarball（历史版本）
- [x] npm 发布走 tag → GitHub Actions（本地 token 不可用，见「红线」）
- [x] 社区目录已收录（PR #8520 已合并）
- [ ] **0.7.1 版本号统一（package.json / index.js / CHANGELOG / release notes / README / 干净包）**
- [ ] **0.7.1 干净包重建 + tgz 校验 + sha256 记录**
- [ ] **CI 测试门禁由作者决策（🔴 见「发布状态」）**
- [ ] 0.7.1 发布后：npm `latest` / Release / 市场详情页三项回读确认

## 备注（踩过的坑）

- **不要只声明 `dsh.client`**：那只会在浏览器注册 UI，`dsh plugin add` 装不上。
- **0.6 与 0.5 不能同时启用**：两者注册同名路由与同名工具，同时加载会在插件装配期报错。切换必须原子（先移除旧包，再装新包），装完重载插件 + 刷新页面。0.7.1 与 0.6.11 是同一个包名，用插件管理正常升级即可（会替换旧版本）。
- **2FA 与 token**：如果 npm 账号开了 2FA，CI 用的 `NPM_TOKEN` 必须是带 **Bypass 2FA** 的 granular token（只授权本包 read/write 即可）。这类 token 不能做 unpublish / 改 dist-tag 等治理动作。以后可换成 npm **trusted publishing（OIDC）**，见 `publish.yml` 里的注释——那样就不用长期在仓库里存 token 了。
- **已经发布的版本号不要复用**：删 tag / 删 Release 不会撤销 npm 上已发布的版本；重发只能升 patch（0.7.2）。回滚策略见 RELEASE-RULES §11。
- **曾经的 staged publishing**：0.3.1 发布时账号未开 2FA，npm 自动进入 staged publishing，随后版本正常上线，`0.0.0-stage` 是暂存占位版本，不影响安装。
- **`release/` 是 git-excluded**：干净包与 tgz 不进仓库；不要把 `release/dsh-long-novel-workbench/` 当源码修改（发布前会整包重建）。
- **官方 `@deepseek-ai/*` 包**如果被 import，应放 `peerDependencies`，不要放 `dependencies`。本插件没有 import 官方包（工具用原始 JSON Schema 注册），因此无需 peer 依赖。
- **目录收录不是安全审查**；安装第三方插件会以你的权限执行代码。
- **凭据**：npm token、2FA 恢复码、`.npmrc`、Cookie、个人绝对路径一律不要进仓库；发版后建议 revoke 旧 token、重新生成恢复码。CI 里只通过 GitHub Actions secrets 注入。
