# 开发安装、切换与本地开发（0.6.11）

> 面向要从源码 / 本地 link 安装、升级切换、跑体检、迁移旧稿或发版的人。
> 普通用户只需要在 DSH 的 **设置 → 插件** 里输入包名 `dsh-long-novel-workbench`，见 [README](../README.md)。

- 当前版本：**0.6.11**，发布日 **2026-10-26**；这是 0.6 重写后的第一次公开发布，npm 上此前的 latest 是 **0.5.1**。
- 本文件替代 README 里原来的「安装 / 切换（必须原子操作）」等内部段落；README 只留对公众的内容。

## 0. 环境要求

- **Node `^22.19.0 || >=24.0.0`**（`package.json` 的 `engines`；CI 在 22 / 24 两个版本上跑检查）。
- 一个能安装插件的 DSH（本机 profile 常见为 `desktop`，`scripts/preflight.mjs` 默认读 `~/.dsh/profiles/desktop`）。
- **不需要 `npm install`**：仓库没有 `dependencies`、没有 lockfile，`npm ci` 会因为缺 lockfile 直接失败；测试用 Node 内置 `node:test`。
- 真实写作数据默认在 `~/StoryDesk`，测试 / 多套数据用 `STORY_DESK_ROOT` 指到副本。

## 1. 安装

### A. 从 npm / 插件市场（普通用户）

1. DSH → **设置 → 插件** → 安装框输入 `dsh-long-novel-workbench` → 安装 → 刷新页面。
2. 或者命令行：

   ```sh
   dsh plugin --profile <你的 profile> add dsh-long-novel-workbench
   ```

3. 刷新后侧栏底部出现 **📖 小说工作台**。新开一个对话，应当能看到 7 个 `novel_desk_*` 工具。

### B. 本地源码 / 本地 link（开发）

```sh
git clone https://github.com/micellince/dsh-long-novel-workbench.git
cd dsh-long-novel-workbench
npm test          # 可选：先确认测试全绿（164 个测试）
```

然后让 profile 指向这个目录，推荐用插件管理工具（不要手工改 profile 的 `package.json` / `cordis.patch.yml`）：

```text
plugin_manager({ action: "remove_bundle", target: "dsh-long-novel-workbench" })
plugin_manager({ action: "install_bundle", target: "/绝对路径/dsh-long-novel-workbench" })
```

装完刷新 DSH 页面。本文档里的示例路径都是开发机上的绝对路径，按你的 checkout 位置替换。

> 注意：本仓库的历史 checkout 目录可能叫 `dsh-long-novel-workbench-0.5.2`（目录名是历史遗留，工作树已经是 0.6.11）。`install_bundle` 认的是 **package.json 的包名与版本**，不是目录名；只要指向这个工作树即可。
>
> 发布名从 0.6.1 起沿用 `dsh-long-novel-workbench`；旧 0.5.x 工作树单独留档，不要和 0.6 混装。

### C. 从 GitHub Release tarball（没有 npm 网络时）

下载 [Releases](https://github.com/micellince/dsh-long-novel-workbench/releases) 页面附件里的 tarball，解包后按上面的本地包方式安装（以该 Release 的实际附件名为准）。

## 2. 升级与切换（0.6 与 0.5 必须原子操作）

**0.6（本包）与旧版 0.5 不能同时启用**：两者都注册 `/novel-desk/api` 路由，且工具名 `novel_desk_propose`、`novel_desk_review` 重名——同时加载会在**插件装配期直接抛错**。所以升级不是「再装一次」，而是「先移除旧包，再装新包」。

### 步骤

1. **体检**（只读）：`node scripts/preflight.mjs`，退出码 0 才继续（见 §4）。
2. **确认没有 AI 会话 / 流水线在跑**：preflight 会报 `revision.json` / `pipeline.json` / `expansion.json` 里 `status=running` 的项目，以及最近 3 分钟内有过章节文件变动的项目。
3. **移除旧包**：

   ```text
   plugin_manager({ action: "remove_bundle", target: "dsh-long-novel-workbench" })
   ```

   如果还残留旧的试装名，也一并移除：

   ```text
   plugin_manager({ action: "remove_bundle", target: "dsh-novel-desk" })
   ```

4. **安装 0.6**：

   ```text
   plugin_manager({ action: "install_bundle", target: "dsh-long-novel-workbench" })
   # 或本地目录：install_bundle target 填 checkout 的绝对路径
   ```

5. **刷新 / 重启 DSH 页面**，侧栏出现 **📖 小说工作台**。新会话里验证：
   - 只有 7 个 `novel_desk_*` 工具（read / review / propose / attention / write / run / map）；
   - `GET http://127.0.0.1:<port>/novel-desk/api/ping` 无凭证返回 **401**（守卫生效）。

### 为什么要「原子」

- 路由冲突：两套实现都挂 `POST /novel-desk/api`，插件装配时 `webServer.register` 会失败；
- 工具冲突：`novel_desk_propose` / `novel_desk_review` 同名注册；
- 数据口径：0.5.x 有 pipeline / revision / expansion 等 0.6 不再使用的状态文件，旧流水线跑着的时候切换会互相抢文件。

## 3. 热重载与重载插件

- **改 Host 代码**（`index.js`、`lib/*.js`）：不会热更新，需要重载插件：

  ```text
  plugin_manager({ action: "set_bundle", target: "dsh-long-novel-workbench", enabled: false })
  plugin_manager({ action: "set_bundle", target: "dsh-long-novel-workbench", enabled: true })
  ```

  或者直接重启 DSH。

- **改 `client.js`**：Host 重载**不会**重新加载浏览器模块，改完刷新 DSH 页面即可。客户端模块 id 必须等于包名 `dsh-long-novel-workbench`，否则不会被装上。
- **改 Host 代码后要重载插件才生效**；重载完再刷新一次页面，确保界面的 API 基址也是新的。

## 4. 体检：`preflight`

```sh
node scripts/preflight.mjs        # 等价于 npm run preflight
```

只读检查，不安装、不写 `~/StoryDesk`。输出四块：

1. **插件安装状态**：`dsh-long-novel-workbench` 装没装、版本是什么；是否残留旧试装名 `dsh-novel-desk`（残留会判为阻塞）。
2. **流水线是否在跑**：扫描每个项目的 `revision.json` / `pipeline.json` / `expansion.json` 的 `status=running`，以及最近 3 分钟内有章节文件变动的项目——有在跑的流水线时**不要切换**。
3. **数据格式**：统计全库还有多少章是旧 `.md`、多少章是 `.txt`；`.md` 可直读，迁移是可选的（见 §5）。
4. **自检**：对本包跑 `node --check index.js` / `node --check client.js` 和 `node --test test/*.test.js`，报告 pass / fail。

退出码：`0` = 健康（可以切换 / 已安装且测试全绿）；`1` = 有阻塞问题（脚本会列出原因）。profile 目录在脚本里写死为 `~/.dsh/profiles/desktop`，用别的 profile 时请自行核对。

## 5. 旧稿迁移（可选）

0.6 **双读双写**：旧项目的 `chapters/NNNN.md`（frontmatter + 正文）可以直接读，也原地写回 `.md`，不认识的 frontmatter 字段原样保留。**不迁移也能正常写作**。迁移只是把旧项目统一成 0.6 的 `NNNN.txt + NNNN.meta.json`。

```sh
node scripts/migrate.js                  # dry-run：只打印计划，不写任何文件
node scripts/migrate.js --apply          # 明确要写才加 --apply
node scripts/migrate.js --verify         # 按迁移报告复核 sha256，报出后来被改过的章
node scripts/migrate.js --project pmxxx  # 只处理一个项目
node scripts/migrate.js --root /path/to/StoryDesk   # 指定数据根
```

行为要点：

- 默认 **dry-run**；`--apply` 写盘前把整个项目目录备份到 `<数据根>/.pre-0.6.0/<项目>-<时间>/`。
- **逐章 sha256 校验**：只有写回内容与源 `.md` 逐字一致才删除 `.md`；校验和写进 `<项目>/migration-report.json`，事后 `--verify` 可复核哪些章节后来被正常编辑过。
- 幂等：重复执行不会重复转换、不重复备份。
- 项目里有 `status=running` 的旧流水线（revision / pipeline / expansion）时，`--apply` 直接拒绝，不写任何文件。
- **迁移后旧插件只认 `.md`，会显示 0 章**——所以务必等旧插件已经移除、0.6 已经接管之后再迁移。

## 6. 界面 / 端到端验证

```sh
npm test            # node --test test/*.test.js：164 个测试
npm run check       # node --check：index.js / client.js / lib/*.js
npm run e2e         # 界面端到端 116 条
npm run smoke       # 界面冒烟：12 个页面 / 页签
node scripts/ui-smoke.mjs --size 500x844 --out /tmp/nd-mobile   # 手机宽度截图
```

- `ui-e2e.mjs`：真实 HTTP handler + 真实 store（先复制到临时副本）+ 无头 Chrome + CDP，做真实点击 / 按键 / 拖拽 / 输入。参数：`--project pmXXX`、`--out /tmp/nd-ui-e2e`、`--chrome <路径>`、`--keep`。
- `ui-smoke.mjs`：先复制数据（含 `chapters`）到临时目录、再造 fixtures、无头 Chrome 截图 12 个页面 / 页签。参数：`--project`、`--root`、`--out`、`--chrome`、`--size 1680x1000|500x844`。
- 两者都**不会写 `~/StoryDesk`**；需要本机有 Chrome，默认找 macOS 的 Google Chrome，可用 `--chrome` 指定。
- 数字以本版实测为准；版本间变化见 [`../CHANGELOG.md`](../CHANGELOG.md) 与 [`ACCEPTANCE-0.6.md`](ACCEPTANCE-0.6.md)。

### 手测清单（真机一次）

1. 刷新 DSH 页面 → 侧栏 📖 → 默认浏览器打开全屏网页版后台，认证能换到 cookie。
2. 关掉 DSH → 网页版失效；重开 DSH 再点入口仍能打开。
3. 手机 / 窄屏：普通 DSH 页面不被工作台覆盖；「在默认浏览器打开」的专属链接直接进入工作台，右下角关闭按钮可用。
4. 开一本新书 → 选预设 → 看到工作单发到「这本书工作区里新开的对话」。
5. 编辑保存 → 历史版本可载回；导出 EPUB / TXT 能真下载。

## 7. 数据位置与隔离

```text
~/StoryDesk/
  library.json
  projects/<id>/
    project.json
    chapters/NNNN.txt | NNNN.md      ← 新章纯文本；旧章原格式
    chapters/NNNN.meta.json
    reviews.json attention.json proposals.json runs.json
    facts.json characters.json events.json foreshadow.json conflicts.json locations.json world.json presets.json
    ledger-sync.json
    .backups/
```

- 数据根可用 `STORY_DESK_ROOT` 覆盖；测试脚本一律用临时目录，不碰真实数据。
- `saveChapter` 是唯一正文落盘函数（写前备份到 `.backups/<n>/<ts>-<hash>.md`，保留最近 100 份）；对外写入统一走 `writeChapterWithGates`。
- 任何写盘前会先 `realpath` 并确认落在 `root/projects/<id>/` 内。

## 8. 打开链路（实现细节）

工作台有两种打开方式：**在默认浏览器打开**与**DSH 窗口内浮层**。前者是用户最常用的全屏网页版后台，链路如下：

- 侧栏入口调用 RPC `app.open`；宿主用 `connection.authenticatedUrl(...)` 生成带一次性 token 的地址，再调系统默认浏览器（macOS `open` / Windows `start` / Linux `xdg-open`）打开；浏览器首次访问时宿主用 cookie 换取登录态。自动拉起失败时界面会给出可复制的链接。
- **显式标记放在 hash**：`...?token=...#novel-desk=1`。宿主认证对 `GET /?token=...` 返回 `303 Location: "./"`，query 会被丢掉，fragment 会随重定向继承——所以标记必须放 hash。
- 只有「显式链接」才自动铺满工作台（桌面与手机一致）；**不带标记**的 DSH / DSH Remote 页面先显示 DSH，点侧栏入口才展开。窄屏有可滚动顶部导航与右下角常驻关闭按钮，不会出现关不掉的浮层。
- 关掉 DSH 后宿主 Web 服务停止，网页自然失效；关掉浏览器标签不影响 DSH。
- 页面通过 `window.__ND_BOOT__.apiUrl` 拿到带凭证的 API 地址；API 基址默认 `/novel-desk/api`。
- 网关：宿主认证优先（`connection.requestRejection`），否则回环 + Host 白名单 + `Sec-Fetch-Site` 同源兜底；写请求要求 `POST` + `application/json`，body 上限 8MB，**永不返回 CORS 头**。

## 9. 发版与收录

- CI 在 Node 22 / 24 上跑语法与测试检查（见 `.github/workflows/`）。
- npm 发布与社区目录（DSH 插件市场）收录流程见 [`../PUBLISHING.md`](../PUBLISHING.md)；版本变更记录见 [`../CHANGELOG.md`](../CHANGELOG.md)。
- 发布前建议按 §6 跑一遍 `npm test` / `npm run check` / `npm run e2e` / `npm run smoke`，并按 §2 核对手装环境。

## 10. 已知边界与不做的事

- 正文是**纯文本**：不做 Markdown 正文 / 富文本编辑；Markdown 只用于导入导出与 AI 交换格式。
- 不做独立服务器、云端多用户、协作冲突自动合并——正文并发改动只按 `baseHash` 提示刷新，不自动 merge。
- 0.6 是重写版本：0.5.x 的流水线式页签设计没有移植到 0.6，旧数据只做兼容读取；功能以 [README](../README.md) 与 [`ACCEPTANCE-0.6.md`](ACCEPTANCE-0.6.md) 为准。
- 测试 / 冒烟需要本机 Chrome；没有 GUI 的机器上只能跑到单元测试与 `node --check`。
