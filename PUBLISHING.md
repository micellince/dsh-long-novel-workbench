# 发布与收录（DSH 插件）

> 最后更新：2026-10-22 凌晨（v0.4.1 已发布到 npm；GitHub Release v0.4.1 已建；社区目录 PR #8520 已开，等仓库满 24h 自动转绿）

## 结论先说

DSH 插件**没有“官方登记”这一步**。一个插件要能被别人安装、被市场收录，通常只做三件事：

1. **仓库里声明 `dsh.bundle`** —— 这是“可安装”的唯一硬门槛；
2. **发布到 npm**（推荐），或至少把预构建 `.tgz` 挂到 GitHub Release；
3. **向社区目录 awesome-dsh-plugin 提一个 PR**（一个 YAML 文件），它同时是 DSH 的插件市场索引。

许可证用 **MIT** 是社区惯例（本仓库已加 `LICENSE`）。

## 已完成的配置

- `package.json`
  - `name`: `dsh-long-novel-workbench`（npm 上可用）
  - `version`: 代码已是 `0.4.0`（**尚未发布到 npm**）；npm 上 `latest` 仍是 `0.3.1`
  - `license`: `MIT`
  - `repository` / `homepage` / `bugs` / `author` / `keywords`（含 `dsh-plugin`）
  - `engines.node`: `^22.19.0 || >=24.0.0`
  - `dsh.bundle.patch` + `dsh.client`（UI 必需）
  - `files`：只发布运行所需文件
- `LICENSE`：MIT
- `cordis.patch.yml`：插入 `story-desk` 行，指向 `dsh-long-novel-workbench`
- `client.js`：客户端模块 id 与包名一致
- GitHub 仓库：<https://github.com/micellince/dsh-long-novel-workbench>（public，已加 `dsh-plugin` topic）
- GitHub Release：`v0.3.1`，附带免版本号的 tarball
  - `https://github.com/micellince/dsh-long-novel-workbench/releases/latest/download/dsh-long-novel-workbench.tgz`

## 发布状态（2026-10-21）

- [x] npm 已发布：`dsh-long-novel-workbench@0.3.1`，`latest` 指向 0.3.1
  - https://www.npmjs.com/package/dsh-long-novel-workbench
  - 发布时账号未开 2FA，npm 自动进入 staged publishing，随后版本正常上线；`0.0.0-stage` 是暂存占位版本，不影响安装
- [x] 社区目录 PR 已开：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8520>
  - 条目分支：`micellince:add-dsh-long-novel-workbench`（只新增 `data/plugins/micellince__dsh-long-novel-workbench.yml`）
  - **仓库年龄门槛**：目录要求仓库创建满 24 小时（CI 的 Submission gate 自动检查）。
    本仓库创建于 **2026-10-21 22:50（Asia/Shanghai）**，门槛在 **2026-10-22 22:50** 之后自动满足。
    gate 会自己重跑并转绿，**不需要重提、push 或关掉重开**；等它变绿即可。
- [ ] 0.4.0 发布：代码与测试已完成（`npm test` 全绿），待执行 `npm version`/`npm publish`（需要 Bypass 2FA token）
- [ ] 目录合并后：确认目录页/市场能搜到

## 发版流程（以后每个版本）

### 1. 发布到 npm

```sh
cd dsh-long-novel-workbench
npm test                       # 先跑测试
npm version patch|minor        # 0.4.0 用 minor
npm publish --access public
```

发布后验证：

```sh
npm view dsh-long-novel-workbench version
dsh plugin --profile web add dsh-long-novel-workbench
```

> 不想发 npm 也可以：市场支持用 GitHub Release 的 tarball 安装（本仓库已经准备好），
> 目录条目里用 `tarball:` 字段指向它即可。

### 2. GitHub Release

```sh
npm pack
# 生成 dsh-long-novel-workbench-X.Y.Z.tgz，重命名去掉版本号
gh release create vX.Y.Z dsh-long-novel-workbench.tgz
```

### 3. 同步文档（容易漏）

发版时一起改这几处版本号/状态：

- `package.json` 的 `version`
- `CHANGELOG.md` 顶部新增版本条目
- 本文件「发布状态」与「已完成配置」里的版本号
- `HANDOVER.md` 的当前版本与状态表
- `README.md` 如提到版本，一并改
- 目录条目不用改（npm 有新版本会自动体现）

## 社区目录（awesome-dsh-plugin）

目录仓库：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
规则：一个 PR 加一个 `data/plugins/<owner>__<repo>.yml`；仓库创建满 1 天、有 `dsh.bundle`、有 `dsh-plugin` topic、描述与代码一致。

当前条目（已在 PR #8520 里）：

```yaml
url: https://github.com/micellince/dsh-long-novel-workbench
name: micellince/dsh-long-novel-workbench
category: workflow
description:
  en: "Long-form Chinese novel workbench: chapters, timeline, fact ledger, foreshadowing, conflicts, characters, highlights, reviews, proposals, plan alignment, nine agent roles, author-style presets, and built-in AI generation and review."
  zh: "长篇中文小说工作台：章节、时间线、事实账本、伏笔、冲突、人物、高光、审稿、提案、计划对齐、9 个 Agent 分工、名家风格预设，并内置 AI 生成与审稿。"
```

如需补提/更新（一般不用）：

```sh
gh pr create \
  --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --head micellince:add-dsh-long-novel-workbench \
  --title "Add micellince/dsh-long-novel-workbench" \
  --body "Long-form Chinese novel workbench with fact ledger, timeline, foreshadowing, reviews, proposals, agent roles and AI generation."
```

CI 会检查：`dsh.bundle` 存在、仓库满 1 天、YAML 格式、README 自动生成。维护者会读源码核对描述，所以 `description` 不要写营销词、不要夸大工具数量。

## 清单（发布前自查）

- [x] `package.json` 声明 `dsh.bundle.patch`
- [x] 带 UI 时声明 `dsh.client`（`platform: web`）
- [x] 客户端模块 id 与包名一致
- [x] `cordis.patch.yml` 与包名一致
- [x] `LICENSE`（MIT）
- [x] `repository` / `homepage` / `bugs` / `keywords`
- [x] `files` 白名单，`npm pack` 内容正确
- [x] GitHub public 仓库 + `dsh-plugin` topic + Release tarball
- [x] npm 发布（0.3.1）
- [x] 社区目录 PR（#8520，等仓库年龄门槛自动转绿）
- [ ] 0.4.0 发布（测试全绿后）

## 备注

- 不要只声明 `dsh.client`：那只会在浏览器注册 UI，`dsh plugin add` 装不上。
- 官方 `@deepseek-ai/*` 包如果被 import，应放 `peerDependencies`，不要放 `dependencies`。
  本插件没有 import 官方包（工具用原始 JSON Schema 注册），因此无需 peer 依赖。
- 目录收录不是安全审查；安装第三方插件会以你的权限执行代码。
- 凭据：npm token 和 2FA 恢复码曾在旧会话里明文出现过，不要写进仓库；发版后建议 revoke 旧 token、重新生成恢复码。
