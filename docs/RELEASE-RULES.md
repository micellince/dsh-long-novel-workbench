# 发布规则（权威手册）

> 适用：`dsh-long-novel-workbench`（DSH 插件）。最后更新 2026-10-26。
> **本文件是发布流程的唯一权威来源**；`PUBLISHING.md` 只是摘要与历史备注，两者冲突时以本文件为准。
> 目标版本：**0.7.1**（0.7 线首个对外发布版本；`0.7.0-dev.0` 是未发布的开发线）。

## 🚨 第一原则（红字，先读）

1. **发布只能由作者本人发起。** Agent（含 Lead、子 agent）**不得**执行 `git push` / `git tag` / `gh release` / `npm publish` / `gh pr create`，不得推 `main`，不得擅自修改 `.github/workflows/*`，不得自行 `npm pack` 对外产出。
2. 本文件里的所有命令都写给**作者本人**执行；Agent 可以把它们整理成清单、检查一致性，但**不能执行**。
3. 作者没有在当次消息里明确说「发布 / 打 tag / 推 main」时，默认**不发布**；文档准备好 ≠ 授权发布。
4. 发布前必须过第 6 节的「测试门禁」决策（红字），否则打 tag 会直接发布失败。

---

## 一、三区隔离：开发区 / 干净包 / 推送区

| 区域 | 位置 | 是什么 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- | --- |
| **开发区** | `/Users/micellince/Documents/deepseek-harness/dsh-long-novel-workbench`（本仓库工作树；DSH profile 软链指向这里，是插件运行来源） | git 工作区；含 `AGENTS.md`、`WORKLOG.md`、`docs/`（含 `docs/audit/`）、`test/`、`release/`、`.github/` | 改代码、写文档、审核；插件热重载从这里读 | 不要把这里整体打包发布 |
| **干净包** | `release/dsh-long-novel-workbench/` + `release/dsh-long-novel-workbench/*.tgz` | 只含将要发布内容的干净副本（由开发区**白名单复制**得到）；`release/` 在 `.git/info/exclude`，`*.tgz` 在 `.gitignore`，**永不进 git** | 打包、校验 tgz、挂 GitHub Release 资产、本地安装复验 | 不要把干净包当源码改（改了下次同步会被覆盖） |
| **推送区** | GitHub `main` + tag `v0.7.1` + GitHub Release；npm registry | 对外可见的发布物 | 作者按第 4/5 节推送 | Agent 一律不得写 |

三条边界：

- **开发区的 `docs/`、`test/`、`AGENTS.md`、`WORKLOG.md`、`.github/`、`release/` 都不进 npm 包**（由 `package.json` 的 `files` 白名单保证，见 §3.2）。
- **干净包是「当前本地版本」的快照**：同步后若开发区又改了代码/版本号，必须**重新同步、重新打包**。
- **npm 只由 GitHub Actions 发布**（推 tag 触发），不在本机 `npm publish`；本机 npm 登录凭据已失效（`npm whoami` → `E401`），不要本地硬试。

---

## 二、版本号：唯一来源与一致性清单

**唯一真源 = `package.json` 的 `version`**。`publish.yml` 会校验 `v${package.json.version}` 与 tag 名完全相等（`.github/workflows/publish.yml:36-42`），不一致直接失败。

发布 0.7.1 时，下面每一处都必须同时是 `0.7.1`：

| # | 位置 | 字段 / 内容 | 0.7.1 的值 | 检查方式（作者执行） |
| --- | --- | --- | --- | --- |
| 1 | `package.json` | `version` | `0.7.1` | `node -e "console.log(require('./package.json').version)"` |
| 2 | `index.js` | `export const VERSION` | `'0.7.1'` | `grep -n "export const VERSION" index.js` |
| 3 | `CHANGELOG.md` | 顶部条目 | `## [0.7.1] - 2026-10-26` | `grep -n "^## \[0.7.1\]" CHANGELOG.md` |
| 4 | `docs/releases/v0.7.1.md` | 文件名 + 头部 npm / GitHub 链接 + 版本 | 0.7.1 | `ls docs/releases/v0.7.1.md` |
| 5 | `README.md` | 「当前版本」段、升级说明里的版本（安装示例用的是包名，未锁版本号） | 0.7.1 | `grep -n "0.7.1" README.md` |
| 6 | `PUBLISHING.md` | 「发布状态 / 当前版本」 | 0.7.1 | `grep -n "0.7.1" PUBLISHING.md` |
| 7 | `release/dsh-long-novel-workbench/package.json` | `version`（干净副本） | `0.7.1` | `node -e "console.log(require('./release/dsh-long-novel-workbench/package.json').version)"` |
| 8 | tgz 文件名与包内元数据 | `dsh-long-novel-workbench-0.7.1.tgz`；`package/package.json` 的 `version` | 0.7.1 | 见 §3.4 |
| 9 | git tag | `v0.7.1`（annotated） | `v0.7.1` | `git tag -l 'v0.7.1'`（打之前应为空） |
| 10 | npm 上是否已存在 | `dsh-long-novel-workbench@0.7.1` | 应为 404 | `npm view dsh-long-novel-workbench@0.7.1 version`（期望报 404） |
| 11 | 插件市场 | 版本 / 下载数由探针自动更新；`description` 人工 | 见 §7 | 市场详情页 / 目录仓库 |

> 经验规则：**已经发布过的版本号永远不要复用**。哪怕只是删掉 tag、删掉 Release，npm 上已发布的版本仍在；要重发只能提升 patch 版本（0.7.2）。

---

## 三、干净打包当前本地版本

### 3.1 前置条件

- 在**开发区**根目录操作；Node 版本满足 `engines`（`^22.19.0 || >=24.0.0`，本机与 Actions 用 Node 24）。
- 作者已确认：版本号已改为 0.7.1（§2 全部一致）、`CHANGELOG` / `docs/releases/v0.7.1.md` / `README` / `PUBLISHING` 已更新、**0.7.1 代码已落地**（关键实现见 §9 状态快照）。
- 本目录没有 `node_modules`、没有锁文件；**不要** `npm install` / `npm ci`（会因无 lockfile 失败，且发布不需要依赖）。

### 3.2 files 白名单（发布内容边界）

`package.json:23-33` 的 `files`：

```
index.js, client.js, lib, scripts, cordis.patch.yml, locale, icon.svg, README.md, LICENSE
```

- npm 另外会自动包含 `package.json`（以及它声明的 `main`），`README*` / `LICENSE*` 通常自动保留；`CHANGELOG.md` **不在**白名单里，不会进 tgz（干净包目录里留一份给人看即可）。
- 以下内容**永远不应出现在 tgz 里**：`docs/`（含 `docs/audit/`）、`test/`、`release/`、`.github/`、`AGENTS.md`、`WORKLOG.md`、`.git/`、`node_modules/`、`*.tgz`。
- 仓库没有 `.npmignore`、没有 `prepack` / `prepare` 脚本，`npm pack` 不会触发构建或副作用；`files` 白名单是唯一打包依据。

### 3.3 同步干净包目录（精确命令，作者执行）

```sh
cd /Users/micellince/Documents/deepseek-harness/dsh-long-novel-workbench

# 1) 清掉旧干净包（release/ 是 git-excluded，不会被提交）
rm -rf release/dsh-long-novel-workbench
mkdir -p release/dsh-long-novel-workbench

# 2) 白名单复制「当前本地版本」到干净包（不要 rsync 整个目录）
rsync -a \
  index.js client.js lib scripts cordis.patch.yml locale icon.svg \
  package.json README.md LICENSE CHANGELOG.md \
  release/dsh-long-novel-workbench/

# 3) 核对干净副本（应无输出 / 版本一致）
diff index.js release/dsh-long-novel-workbench/index.js
diff -r lib release/dsh-long-novel-workbench/lib
node -e "console.log(require('./release/dsh-long-novel-workbench/package.json').version)"   # 期望 0.7.1

# 4) 确认干净包目录里没有开发区文件
ls release/dsh-long-novel-workbench
# 期望只有：CHANGELOG.md LICENSE README.md client.js cordis.patch.yml icon.svg index.js lib locale package.json scripts
```

### 3.4 打 tgz（精确命令，作者执行）

```sh
cd release/dsh-long-novel-workbench
npm pack --pack-destination .

# 产出：dsh-long-novel-workbench-0.7.1.tgz
shasum -a 256 dsh-long-novel-workbench-0.7.1.tgz
# Linux 用：sha256sum dsh-long-novel-workbench-0.7.1.tgz

# 需要一个「免版本号」的稳定下载别名（市场可用 tarball: 指过来）
cp dsh-long-novel-workbench-0.7.1.tgz dsh-long-novel-workbench.tgz
```

### 3.5 tgz 内容校验（必须做）

```sh
cd /Users/micellince/Documents/deepseek-harness/dsh-long-novel-workbench
TGZ=release/dsh-long-novel-workbench/dsh-long-novel-workbench-0.7.1.tgz

# ① 全量清单（人工扫一眼）
tar -tzf "$TGZ"

# ② 禁止项：docs / test / release / .github / AGENTS / WORKLOG / .git / node_modules
tar -tzf "$TGZ" | grep -E '^package/(docs|test|release|\.github)/' && echo '❌ 含开发目录' || echo '✅ 无 docs/test/release/.github'
tar -tzf "$TGZ" | grep -E '^package/(AGENTS|WORKLOG)\.md$' && echo '❌ 含内部文件' || echo '✅ 无 AGENTS/WORKLOG'
tar -tzf "$TGZ" | grep -E 'node_modules|\.git/' && echo '❌ 含依赖/仓库文件' || echo '✅ 无 node_modules/.git'

# ③ 版本与关键文件
tar -xOzf "$TGZ" package/package.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))"   # 期望 0.7.1
tar -tzf "$TGZ" | grep -E '^package/(index|client)\.js$'
tar -tzf "$TGZ" | grep -E '^package/lib/(problems|review-doc|problems-prompts)\.js$'   # 0.7.1 新增文件必须在
tar -tzf "$TGZ" | grep -E '^package/lib/(store|bookdb|opinions|db)\.js$'                # 旧数据层仍在

# ④ 条目数记录（与上一次发布对比，异常增减要解释）
tar -tzf "$TGZ" | grep -c '^package/'
```

判定标准：`files` 白名单内的文件在、禁止项全无、`package/package.json.version` = 0.7.1。任一不满足 → **不要继续发布**，回 §3.3 重新同步。

### 3.6 sha256 记录

- 把 `shasum -a 256` 的两行（带版本号 tgz + 免版本号别名）记到本地 `release/dsh-long-novel-workbench/SHA256SUMS-0.7.1.txt`（该目录 git-excluded，不进仓库），并**贴到 GitHub Release 正文末尾**，方便别人下载后自校验。
- 校验示例：`shasum -a 256 dsh-long-novel-workbench-0.7.1.tgz`，与 Release 正文里的值比对。

---

## 四、GitHub 流程（作者发起）

顺序：**版本改好 → 本地 commit → 推 main → 打 tag → 推 tag（触发 npm 发布）→ Release 正文 + 挂 tgz**。

```sh
cd /Users/micellince/Documents/deepseek-harness/dsh-long-novel-workbench

# 1) 本地改动提交（作者本人操作；Agent 不 commit/push）
git status
git add package.json index.js client.js lib docs CHANGELOG.md README.md PUBLISHING.md
# 若按 §6 选项 A/B 改了 test/ 或 .github/workflows/，一并 git add 对应文件
git status
git commit -m "release: 0.7.1 — 问题单 + 修改稿"

# 2) 推 main（只推这一个分支；不要强推）
git push origin main

# 3) 打 annotated tag 并推（推 tag 会触发 publish.yml）
git tag -a v0.7.1 -m "v0.7.1"
git push origin v0.7.1
```

注意：

- **不要一次推多个 tag**；`publish.yml` 只按 `v*` 触发，推错 tag 会错误发布。
- tag 与 `package.json.version` 必须严格满足 `v` + 版本号（大小写敏感、不能带后缀）。
- 推 tag 后先看 Actions（§5.3），**确认 npm 发布成功**再建 Release，避免 Release 已出而 npm 没有。

### 4.1 GitHub Release

```sh
# 正文直接用仓库里的发布说明
gh release create v0.7.1 \
  --title "v0.7.1 · 长篇中文小说工作台" \
  --notes-file docs/releases/v0.7.1.md

# 挂 tgz（版本化 + 免版本号稳定别名）
gh release upload v0.7.1 release/dsh-long-novel-workbench/dsh-long-novel-workbench-0.7.1.tgz
gh release upload v0.7.1 release/dsh-long-novel-workbench/dsh-long-novel-workbench.tgz
```

- 稳定链接（市场可用 `tarball:` 指过来）：
  `https://github.com/micellince/dsh-long-novel-workbench/releases/latest/download/dsh-long-novel-workbench.tgz`
- Release 正文末尾附 §3.6 的 sha256。
- Release 创建/上传都算「发布动作」，**只能作者本人执行**。

---

## 五、npm 流程（推 tag → GitHub Actions）

### 5.1 工作流做什么

`.github/workflows/publish.yml` 在推 `v*` tag 时依次执行：

1. `actions/checkout` + `setup-node`（Node 24，registry `https://registry.npmjs.org`）；
2. **`npm test`**（`.github/workflows/publish.yml:32-33`）——失败则中止，**不会发布**；
3. 校验 `v${package.json.version}` 是否等于 tag 名（`:36-42`）；
4. `npm publish --access public`，凭据来自仓库 secret `NPM_TOKEN`（`:51-54`）。

### 5.2 NPM_TOKEN 要求

- 仓库 **Settings → Secrets and variables → Actions** 里的 `NPM_TOKEN` 必须可用：
  - 推荐 npm **granular access token**，只对本包有 read/write；
  - 账号开了 2FA 时必须勾选 **Bypass 2FA**，否则 CLI 发布被拦；
  - 这类 token **不能**做 unpublish / 改 dist-tag 等治理动作（回滚见 §8）。
- 本机 npm 登录凭据已失效（`E401`），**不要**在本机尝试 `npm publish`；只走 Actions。
- 以后可换 npm trusted publishing（OIDC）免长期 token；换了要同步改 `publish.yml`（作者决定）。

### 5.3 发布后校验（作者执行）

```sh
npm view dsh-long-novel-workbench version            # 期望 0.7.1
npm view dsh-long-novel-workbench dist-tags          # latest 应指向 0.7.1
npm view dsh-long-novel-workbench time --json        # 看 0.7.1 发布时间
gh run list --workflow=publish.yml --limit 3         # 最近一次 Publish 应为 success
```

安装复验（在 DSH 设置 → 插件里操作，或 `plugin_manager`）：

```
plugin_manager({ action: "remove_bundle", target: "dsh-long-novel-workbench" })
plugin_manager({ action: "install_bundle", target: "dsh-long-novel-workbench" })
```

装好后**重载插件 + 刷新页面**，侧栏应出现「📖 小说工作台」；打开后 0.7.1 的「问题」页应可达，工具列表里应能看到 `novel_desk_problems`。

---

## 六、🔴 测试门禁（0.7.1 打 tag 前必须先决策）

> **本次 0.7.1 的实际决定（2026-10-26）**：作者当次明确要求发布 0.7.1。已按**选项 C（换预检）**执行——`publish.yml` / `ci.yml` 不再跑 0.6 旧测试，改为「`node --check` 语法 + 版本 / CHANGELOG / 发布说明一致性」预检；CI 与 npm 发布均通过。
> **待办（0.7.2 前）**：把 `test/` 更新到 0.7 行为后恢复测试门禁（由作者决定）。
> 以下为决策前的原始风险记录，保留供以后版本参考。

**现状（高风险，红字）**：

- `publish.yml` 第 2 步会跑 `npm test`（`.github/workflows/publish.yml:32-33`）；`ci.yml` 也会在 push main / PR 时跑 `npm test` + `node --check`。
- `test/` 仍是 **0.6 行为断言**（作者规定不跑测试；WORKLOG「已知未收尾」明确：`test/` 未更新）。
- 0.7.1 的工具面按契约会变（`novel_desk_review` / `novel_desk_attention` / `novel_desk_cold_split` 从 `TOOLS` 移除，新增 `novel_desk_problems`），RPC 会新增约 10 个 op。旧测试里的硬断言会直接失败，例如：
  - `test/api.test.js:226-230`：`TOOLS.length === 7` 且工具名列表含已移除的 `novel_desk_review` / `novel_desk_attention`；
  - `test/api.test.js:176`：`RPC_OPS.length === 41`；
  - `test/prompts.test.js` / `test/review-flow.test.js` 等仍引用旧工具与旧工作单。

**结论：按当前仓库状态，`v0.7.1` tag 推到 GitHub 后，`publish.yml` 的 `npm test` 步骤会失败，npm 发布被阻断（Release 可以建，但 npm 上没有 0.7.1）。**

打 tag 之前，**必须由作者本人决定**以下之一（Agent 不擅自改 workflow、不跑测试）：

| 选项 | 做法 | 代价 / 风险 |
| --- | --- | --- |
| A. 更新测试 | 由作者明确要求后，更新 `test/` 到 0.7.1 行为（工具数 / RPC 数 / 新问题单流程），使 `npm test` 变绿 | 工作量最大；需要作者明确授权写/跑测试（违反「不测试」的默认规则，需当次授权） |
| B. 临时移除 CI 测试门禁 | 作者当次明确要求下，从 `publish.yml` 删掉/注释 `Run tests` 步骤（`ci.yml` 同样处理或接受红叉） | 发布不再被测试挡住；但 CI 对 main 会显示失败，需在 Release 说明/Issue 里交代；恢复测试时要改回来 |
| C. 换其他预检 | 作者指定另一套发布前检查（例如只保留 tag/版本校验、加 `node --check` 作为最小门禁） | 需要改 workflow（作者授权）；`ci.yml` 仍会跑旧测试 |

**未决策 = 不发布。** 决策结果请写进 `WORKLOG.md` 当天的记录（改了什么、为什么），再走 §4。

> 选了 B（临时移除门禁）的，建议同时记一条待办：在 0.7.2 之前恢复测试门禁或把 `test/` 更新到 0.7 行为——否则下一个版本还会被同一道门挡住。

---

## 七、README 与插件市场同步

- **npm 徽章**：README 顶部的 `img.shields.io/npm/v/...` 自动显示 npm 最新版，npm 发布后自动变，无需手改。
- **插件市场（awesome-dsh-plugin）**：
  - 版本号 / 下载数：目录仓库 nightly 探针读 npm，**自动更新**，发布后不用手动改；
  - 详情页 README：目录仓库每日构建从本仓库 `README.md` 同步，改完 README **等下一次构建**即可；
  - 条目里的 `description`（en / zh）：静态文案，**需要单独提 PR**（0.6 / 0.5 时代文案，0.7.1 建议一并更新；是否提、提什么由作者决定；Agent 不得开 PR）。
- README 更新范围（0.7.1）：版本号与「当前版本」段、找问题流程（问题单 / 修改稿 / 两个入口）、旧「审阅 / 冷读 / 提案」概念、工具列表、数据位置与升级说明。发布前对照 `docs/releases/v0.7.1.md` 自检一遍。
- 建议的新 description（供作者提 PR 时参考，非必须）：

  ```yaml
  description:
    en: "Find problems and get replacement drafts for long Chinese novels: reading-review, facts & logic lane, paragraph/chapter drafts, accept or ask for revision."
    zh: "长篇中文小说工作台：通读审 + 事实与逻辑两档找问题，问题带可采纳的修改稿，采纳或继续改。"
  ```

---

## 八、发布前检查清单（作者逐项打勾）

**版本与文档**

- [ ] §2 的 11 处版本/文案一致（`package.json` / `index.js` / `CHANGELOG` / `docs/releases/v0.7.1.md` / `README` / `PUBLISHING` / 干净包 / tgz / tag / npm 未占用）。
- [ ] `CHANGELOG.md` 顶部是 `[0.7.1] - 2026-10-26`，内容与 `docs/releases/v0.7.1.md` 不打架。
- [ ] `docs/releases/v0.7.1.md` 里没有内部 bug 清单 / 内部路径 / token。
- [ ] `README.md` 的安装、升级、数据位置与 0.7.1 实际行为一致。

**实现落地（发布说明承诺的东西必须在）**

- [ ] `novel_desk_problems` 已注册；`TOOLS` 里已移除 `novel_desk_review` / `novel_desk_attention` / `novel_desk_cold_split`（作者抽查 `index.js`）。
- [ ] 新 RPC `problems.*` 已加进 `READ_OPS` / `WRITE_OPS`；问题页从导航可达。
- [ ] `lib/problems.js` / `lib/review-doc.js` / `lib/problems-prompts.js` 已存在且被引用。
- [ ] **没有指向未注册工具的旧指令**：`grep -n "novel_desk_review\\|novel_desk_attention\\|novel_desk_cold_split" lib/prompts.js lib/dispatch.js index.js`。若某个仍可达的工作单（如账本同步）还在教 AI 调已移除的工具，AI 会调用失败；发布前修掉或确认该入口已不可达。（2026-10-26 复查：账本同步工作单仍提到 `novel_desk_review`，派单提示仍写 review / attention 示例，见 §9。）
- [ ] 版本号已改（`package.json` + `index.js VERSION`）。

**干净包与资产**

- [ ] §3.3 干净包目录已重建并 diff 一致；目录内无 `docs/ test/ AGENTS.md WORKLOG.md release/ .github`。
- [ ] §3.4 tgz 已生成；§3.5 校验全过；0.7.1 新文件在包内。
- [ ] §3.6 sha256 已记录并准备贴到 Release。
- [ ] 免版本号别名 tgz 已生成。

**CI / npm / 发布决策**

- [ ] **§6 测试门禁已由作者决策**（更新测试 / 临时移除 / 换预检），并写进 WORKLOG；未决策就不要打 tag。
- [ ] `git diff` 里没有未经作者授权的 `.github/workflows/*` 改动（若按 §6 B/C 改了，改动必须是作者当次要求的）。
- [ ] `NPM_TOKEN` 仍在仓库 secrets 里且可用（不是过期 token）。
- [ ] 本机不做 `npm publish`；只走 Actions。
- [ ] 已确认 `dsh-long-novel-workbench@0.7.1` 在 npm 上不存在。
- [ ] 备份：升级说明已提醒作者/用户备份 `~/StoryDesk` 与作品工作区；本机测试作品已备份。

## 九、2026-10-26 状态快照（发布前一页速查，会过期，以实际检查为准）

- 版本号已改为 `0.7.1`（`package.json` + `index.js VERSION`，2026-10-26 落地）；发布前仍按 §2 复核全部一致性。
- 实现已落地（2026-10-26 本手册写入时抽查）：`lib/problems.js` / `lib/review-doc.js` / `lib/problems-prompts.js` 已存在；`novel_desk_problems` 已注册；`TOOLS` = read / dispatch / propose / write / run / map / problems（7 个，旧的 review / attention / cold_split 不再注册）；`problems.*` RPC 已进 `READ_OPS` / `WRITE_OPS`；问题页已接入客户端导航。发布前仍请按 §8「实现落地」逐项复核（代码可能继续变）。
- 干净包 `release/dsh-long-novel-workbench/` 与 tgz 仍是 `0.7.0-dev.0` 旧快照 → **必须按 §3.3 重建并重新 pack**。
- 测试门禁：`test/api.test.js` 的旧断言（工具名列表含 `novel_desk_review` / `novel_desk_attention`、`RPC_OPS.length === 41`）与当前代码不符，`npm test` 会失败（§6）→ 打 tag 前必须由作者决策。
- 旧指令残留（2026-10-26 复查）：`lib/prompts.js` 的账本同步工作单（约 300 / 393 行）仍教 `novel_desk_review`；`lib/dispatch.js` 的派单提示（60-61 行）仍写 review / attention 示例。这些入口若仍可达，AI 会调用已移除的工具；发布前修掉或确认入口不可达（见 §8 对应勾选项）。
- 本机 npm 登录失效 → 只能走 Actions；社区目录已收录（PR #8520），版本/README 由探针与每日构建自动同步，`description` 待作者决定是否提 PR。

---

## 十、发布后验证

| 检查 | 命令 / 操作 | 期望 |
| --- | --- | --- |
| npm 版本 | `npm view dsh-long-novel-workbench version` | `0.7.1` |
| npm latest | `npm view dsh-long-novel-workbench dist-tags` | `latest: 0.7.1` |
| Actions | `gh run list --workflow=publish.yml --limit 3` | 最近一次 success |
| GitHub Release | 打开 `releases/tag/v0.7.1` | 正文 = `docs/releases/v0.7.1.md`，含版本化 tgz + 稳定别名 |
| tgz 校验 | 下载 tgz，`shasum -a 256` 对比 | 与 Release 正文一致 |
| 安装 | DSH 插件管理安装 0.7.1 → 重载插件 → 刷新 | 侧栏出现工作台；「问题」页可达；工具列表有 `novel_desk_problems` |
| 升级路径 | 用一个 0.6.11 作品试 `migrate-book-0.7.mjs`（先 dry-run） | 迁移后能打开、正文与账本在 |
| 市场 | 等 nightly 后看详情页 | 版本变 0.7.1、README 已同步 |
| 数据安全 | 作者手测采纳/继续改/批量 | 不丢稿、不覆盖正文、`outdated` 行为符合说明 |

> 发布后回归由作者本人手测（按 AGENTS.md：Agent 不跑测试、不跑 e2e、不截图）。

---

## 十一、回滚 / 补救

**原则：能前向修复就不要撤包。npm 版本号不可复用，发布出去的 `0.7.1` 永远在 npm 历史里。**

### 11.1 npm 发布内容有问题

1. **首选前向修复**：修代码 → 升 `0.7.2` → 重走 §4/§5（最干净，用户执行 `npm update` 即可）。
2. 临时止损：`npm deprecate dsh-long-novel-workbench@0.7.1 "0.7.1 有已知问题，请升级 0.7.2"`（作者 token 需要治理权限；granular + Bypass 2FA 的 token 可能不够，需确认）。
3. `dist-tags` 回退（把 latest 指回旧版，仅当下一个版本还没准备好时用）：
   `npm dist-tag add dsh-long-novel-workbench@0.6.11 latest`
   —— 会让用户装回 0.6.11（数据形态不同，需在 Release/Issue 说明升级/回退注意事项）。
4. `npm unpublish` **不要依赖**：npm 只在发布 72 小时内、无依赖者时可能允许，且治理 token 权限通常不具备；即使成功也会打断已安装用户。

### 11.2 GitHub Release / tag 有问题

```sh
# 撤 Release（作者执行）
gh release delete v0.7.1 --yes

# 删远端/本地 tag（作者执行；注意删 tag 不会撤销 npm 已发布版本）
git push origin :refs/tags/v0.7.1
git tag -d v0.7.1

# 回退 main 上的发布提交（作者执行；优先 revert 不要强推）
git revert <release-commit-sha>
git push origin main
```

- 重新发布必须用新版本号（0.7.2）：npm 同版本不能二次 publish；`publish.yml` 也不会覆盖已存在版本。
- 若 Release 已挂 tgz 而后发现包有问题：删 Release/资产 → 前向发 0.7.2 → 用新 Release 替换下载链接。

### 11.3 用户数据回滚

- 升级前要求用户备份 `~/StoryDesk`（0.6 数据）与作品工作区（0.7 数据）。
- 0.7 的章节历史在作品目录 `.backups/`；迁移脚本**不删除旧作品目录**，回退到 0.6.11 时旧数据仍在原处。
- 问题单 / 修改稿在 `novel.db`，回退版本前先整目录备份（含 `novel.db*`）。

---

## 附录：路径与命令速查

```text
开发区（git 工作树 / 插件运行来源）：
  /Users/micellince/Documents/deepseek-harness/dsh-long-novel-workbench
干净包目录：
  release/dsh-long-novel-workbench/
tgz（git-excluded）：
  release/dsh-long-novel-workbench/dsh-long-novel-workbench-0.7.1.tgz
  release/dsh-long-novel-workbench/dsh-long-novel-workbench.tgz
插件私有数据根（运行期数据，不进包）：
  ~/.dsh/data/dsh-long-novel-workbench/
作品数据（运行期数据，不进包）：
  ~/Documents/deepseek-harness/default-workspace/<书名>/
旧 0.6 作品数据：
  ~/StoryDesk/projects/<id>/
npm 包：
  dsh-long-novel-workbench（registry.npmjs.org）
GitHub：
  https://github.com/micellince/dsh-long-novel-workbench
插件市场目录：
  https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
```

关键文件：`package.json`（version / files）、`index.js`（VERSION / TOOLS / RPC_OPS）、`CHANGELOG.md`、`docs/releases/v0.7.1.md`、`README.md`、`PUBLISHING.md`、`.github/workflows/publish.yml`、`.github/workflows/ci.yml`。

---

## 变更记录（本手册）

- 2026-10-26：首版。适用于 0.7.1；明确三区隔离、版本一致性、干净打包与校验、GitHub/npm/市场流程、测试门禁红字、回滚。
