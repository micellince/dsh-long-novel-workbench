# 📖 长篇中文小说工作台

[![npm version](https://img.shields.io/npm/v/dsh-long-novel-workbench.svg)](https://www.npmjs.com/package/dsh-long-novel-workbench)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4b6bfb)](https://github.com/micellince/dsh-long-novel-workbench)

写长篇的人都懂那种感觉：写到第三十章，突然想不起来第三章里那个配角姓什么；伏笔埋了三十万字，自己先忘了埋在哪；设定越写越多，最后正文、大纲、笔记各说各话。

这个插件就是给这种时刻准备的——一个装在 **DeepSeek Harness** 里的长篇中文小说工作台。章节、时间线、事实账本、伏笔、冲突、人物、高光、审稿、提案、计划对齐，都在一个地方；AI 不只是陪你聊，它能直接读这些账本，帮你生成下一章、审稿、补时间线，但**所有 AI 产出都先落在「提案」里，你点头才进正文**。

不限文体：武侠、悬疑、科幻、言情、文学都可以。内置金庸、古龙、梁羽生、柯南·道尔、阿加莎·克里斯蒂、东野圭吾、刘慈欣、村上春树八套风格预设，也可以自己调。

## 先看几张图

**总览：一本书现在写到哪、有没有前后矛盾**

![总览](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/01-overview.png)

**时间线：列表 / 泳道两种视图，按章排列事件，伏笔埋收用弧线连起来**

![时间线泳道](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/02-timeline.png)

**预设：计划章数、每章字数、结构、风格规则、禁忌、审稿重点，都能改**

![预设](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/03-presets.png)

**人物关系图：按角色着色、可拖拽、悬停高亮邻接、关系目标未建卡时显示幽灵节点**

![人物关系图](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/04-relationships.png)

**章节历史：每次覆盖前自动备份，可查看与当前稿的逐行 diff 并恢复**

![章节历史](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/05-chapter-history.png)

**导入作品包：章节 + 人物卡 + 大纲 + 时间线 + 事实 + 伏笔 + 预设，导入后一键 AI 审阅**

![导入 Markdown](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/06-import.png)

> 以上截图来自 **v0.4.0 的真实运行界面**（2026-10-22，临时 DSH profile + 无头 Chrome 自动验收，使用演示数据，不含任何真实作品）。

> **版本状态**：当前版本 **v0.4.1**（关系图、时间线泳道、自动保存 + 章节历史、批量审稿/采纳、Markdown 导入、EPUB/DOCX 导出、多预设对齐等）。npm 上最新发布见 [npm 页面](https://www.npmjs.com/package/dsh-long-novel-workbench)；想从源码用最新代码，按下面「从本地源码安装」把 profile 指向本仓库。

## 安装（30 秒）

1. 打开 DeepSeek Harness；
2. 进 **设置 → 插件**；
3. 在安装框里输入：

```
dsh-long-novel-workbench
```

4. 安装，刷新页面；
5. 左下角侧栏出现 **「📖 长篇中文小说工作台」**，点开就能用。

命令行安装也可以：

```sh
dsh plugin --profile <你的 profile> add dsh-long-novel-workbench
```

> 没有 npm 网络时，也可以从 [GitHub Release](https://github.com/micellince/dsh-long-novel-workbench/releases/latest) 下载 tarball 安装。

### 从本地源码安装（v0.4 开发版）

```sh
git clone https://github.com/micellince/dsh-long-novel-workbench.git
cd dsh-long-novel-workbench
npm test            # 可选：先确认测试全绿
```

然后让 profile 的插件指向这个目录（在 DSH 里用插件管理工具 `install_bundle`，目标填上面的绝对路径），或把本地路径加进 profile 的依赖后再重载插件。改 Host 代码（`index.js`、`lib/*.js`）后需要重载插件才生效；改 `client.js` 后刷新页面即可。

## 第一次打开

- 点右上角「＋ 新建作品」，填书名、类型、目标章数/字数，开始你自己的书；
- 工作台只做看板和验收：所有 AI 动作（审阅、修改、生成方案）都从工作台「发到对话」，由左侧对话里的 Agent 执行，结果以提案/审稿回到工作台。

已经有稿子？点「⬆ 导入作品 / 作品包」，填作品根目录，或直接选整本书文件（`.md` / `.txt` / `.epub` / `.pdf` / `.mobi`）。TXT/EPUB/MOBI(PalmDOC) 纯 JS 解析，PDF 需要 `pdftotext`。会自动识别 `正文/`、`wiki/entities`、`大纲.md`、`追踪.md`、`写作规范.md`、`故事线.md`，一次导入章节 + 人物卡 + 大纲 + 时间线 + 事实 + 伏笔 + 预设；导入完成点「开始审阅」，AI 会补缺失并核对冲突。只读扫描，不改原文件；
- 数据默认存在 `~/StoryDesk`，全是普通 Markdown/JSON 文件，能备份、能进 Git、能用别的编辑器打开。

## 功能一览

工作台共有 14 个页签：总览、章节、时间线、事实账本、伏笔、冲突、人物、高光、审稿、提案、对齐、分工、预设、设置。

### 写和改

- **章节编辑器**：标题、状态、故事内时间、地点、出场人物、摘要、正文；停止输入 5 秒自动保存，关闭时若有未保存改动会提示。
- **章节历史**：覆盖已有章节且内容确实变化前，旧稿自动备份（每章最多保留最近 100 份）；可以查看历史版本与当前稿的逐行 diff，并恢复到指定版本——恢复前会先把当前正文再备份一份。
- **批量处理**：提案页支持按类型筛选、全选、批量采纳 / 批量驳回；审稿页支持按严重度筛选、全选、批量「标记已修 / 忽略」。单条失败不影响其他条目，失败项会明确提示。

### 视图

- **人物关系图**：人物页可切换「列表 / 关系图」。关系图是 SVG 力导向布局，支持 `名字(关系)`、`名字（关系）`、`名字:关系` 等写法；目标人物还没建卡时显示为虚线幽灵节点；节点可拖拽，悬停高亮相邻节点与边，点击打开人物编辑卡。
- **时间线泳道**：时间线页可切换「列表 / 泳道」。按卷（没有卷信息时每 20 章）分泳道，横轴是章号；事件按重要度着色，点击可编辑；伏笔的「埋设章 → 回收章」用曲线连接（未回收实线、已回收灰色虚线）；顶部有 0.5x–3x 缩放滑块。
- **总览与计划对齐**：章数 / 字数进度、每章偏离、事件 / 事实 / 审稿 / 提案的覆盖情况；对齐页会显示当前使用的预设。

### 数据与检查

- **事实账本时间维度**：事实可以填「生效章 / 失效章」（`validFrom` / `validTo`），同一属性在不同阶段合法变化不会再被一刀切报成冲突。
- **确定性检查**（不花 token）：同一属性在重叠章段出现不同取值、伏笔过了计划回收章还没回收、章节引用了没建卡的人物、审稿里的阻断 / 严重问题、计划章节 / 字数与实际进度的偏离。
- **多预设 / 多卷**：预设页可以把某套预设「设为当前」，对齐按当前预设计算；预设也可以带章节范围，按卷汇总计划章数与字数。

### 导入与导出

- **导入 Markdown**：作品库页输入本机目录路径，先扫描预览（文件数、章节数、总字数、前 20 章标题），再填作品名导入；可新建作品，也可追加到现有作品并从现有最大章号续号。递归扫描，优先按 `#` / `##` 标题切章，没有标题则一个文件一章。
- **导出**：Markdown 合集、EPUB（EPUB 3）、DOCX。实现零依赖，EPUB 的 `mimetype` 按规范放在第一条且不压缩，DOCX 章节标题使用 `Heading1` 样式。

## AI 帮你干活的两个入口

**在工作台里**：点右上角「🤖 让 AI 操作」，选任务：

- 生成下一章方案（标题、摘要、节拍、事件、事实、伏笔）
- 续写下一章正文
- AI 审稿（按你的审稿重点逐项挑问题）
- 补全时间线 / 抽取事实与人物

**在聊天里**：直接说「给《长夜将明》补第 3 章时间线」「审一下第 2 章」。Agent 会先调 `novel_desk_plan` 拿精确工作单，再调 `novel_desk_propose` 提交提案。

所有 AI 结果都先停在「提案」里：可以 **采纳 / 提修改意见 / 让 AI 按意见重写 / 驳回**，也可以批量采纳或驳回一批提案。章节正文提案带逐行 diff，采纳前自动备份旧稿。**它不会背着你改正文。**

## 9 个 Agent 分工

总编、大纲师、世界观师、人物师、时间线师、伏笔师、连续性审稿、文笔审稿、责任编辑。每个角色有职责、输入、产出，写在「分工」页里，AI 写作和审稿时会读这份分工。你可以改。

## 数据在哪

```
~/StoryDesk/
  library.json
  projects/<id>/
    project.json
    chapters/NNNN.md      ← frontmatter + 正文
    facts.json            ← 事实账本（可带 validFrom / validTo）
    events.json           ← 时间线
    foreshadow.json       ← 伏笔
    conflicts.json        ← 冲突
    characters.json       ← 人物（可带 relationships）
    highlights.json       ← 高光
    reviews.json          ← 审稿
    proposals.json        ← 提案
    agents.json           ← 9 个 Agent 分工
    presets.json          ← 写作预设（可带 chapterFrom / chapterTo 做多卷）
    .backups/             ← 章节历史版本（每章最多 100 份）与采纳正文提案前的旧稿
```

没有数据库，没有私有格式。停用插件，数据还在。
目录根可以用环境变量 `STORY_DESK_ROOT` 覆盖（测试 / 多套数据时很有用）。

## 它还会替你看这些

- 同一个属性，在生效区间重叠的章段里出现两个不同取值 → 事实冲突；不同阶段合法变化不报
- 伏笔过了计划回收章还没回收 → 报警
- 章节引用了没建卡的人物 → 提示
- 审稿里的阻断/严重问题 → 进总览
- 计划章数/字数 vs 实际进度 → 对齐页

这些规则都是确定性的，不花 token。

## 开发与测试

需要 **Node 22+**（`^22.19.0 || >=24.0.0`）。仓库没有第三方依赖，也没有构建步骤。

```sh
git clone https://github.com/micellince/dsh-long-novel-workbench.git
cd dsh-long-novel-workbench

npm test                 # node --test test/，零依赖
node --check index.js    # 宿主入口语法检查
node --check client.js   # 浏览器模块语法检查
```

- 测试自己用临时目录，正常不会碰 `~/StoryDesk`；手动调试请显式隔离：`STORY_DESK_ROOT=/tmp/storydesk-dev npm test`。
- 本地开发：让 profile 的插件指向本仓库；改 Host 代码（`index.js`、`lib/*.js`）后重载插件，改 `client.js` 后刷新页面。
- CI 在 Node 22 / 24 上跑上面这些检查；推送 `v*` tag 会用 `NPM_TOKEN` 发布 npm（见 `.github/workflows/`）。

细节（热重载、发布流程、代码风格）见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变更见 [CHANGELOG.md](CHANGELOG.md)。

## 欢迎 Star，也欢迎来骂

如果这个工作台帮你少踩一个坑，**点个 ⭐ 就是最大的鼓励**；用着不顺手、缺什么功能、发现 bug，直接开 [Issue](https://github.com/micellince/dsh-long-novel-workbench/issues) 告诉我，我会看。

也欢迎 PR：预设、Agent 分工、检查规则都是数据驱动的，很好加。

## License

MIT。拿去用，随便改。

---

<sub>Made for people who write long things. 如果你也在写一本很长的书，祝你写得完。</sub>
