# 📖 长篇中文小说工作台

[![npm version](https://img.shields.io/npm/v/dsh-long-novel-workbench.svg)](https://www.npmjs.com/package/dsh-long-novel-workbench)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4b6bfb)](https://github.com/micellince/dsh-long-novel-workbench)
[![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen)](package.json)

一个装在 **DeepSeek Harness（DSH）** 里的长篇中文小说工作台：**打开就能看全文，AI 只负责写和审，改不改由你逐条批**。

> 当前版本 **0.6.11**（2026-10-26 发布）。这是 0.6 重写后的第一次公开发布——npm 上此前的 latest 是 0.5.1。

## 它解决什么痛点

写长篇的人都懂那种感觉：写到第三十章，突然想不起第三章里那个配角姓什么；伏笔埋了三十万字，自己先忘了埋在哪；设定越写越多，正文、大纲、笔记各说各话。更麻烦的是 AI——它会陪你聊，但要它先读完你的账本再动手，很难；它改起正文来又太快，你不敢直接让它改。

这个插件把写作台搭在数据上面：章节、人物、事实、时间线、地点、世界、伏笔、冲突、高光、大纲都收在同一本书的账本里；AI 通过工具读这些账本，**只出审阅条目和提案**，正文只有你批准之后才会改（唯一的正文落盘入口是写入闸门）。日常只做一件事——**读、批注、审、改**，循环着往前走。

不限文体：武侠、悬疑、科幻、言情、文学现实都可以。四套内置写作预设（标准长篇 / 冷峻悬疑 / 家国武侠 / 文学现实）加一套自定义模板，也可以让 AI 先出一套方案。

> **⚡ ATTENTION IS ALL YOU NEED**
>
> 怎么吸引读者怎么来，一切为读者服务。先抓人，再自洽：每章必须有核心注意力；事实自洽是底线，不是目标。

- **注意力原则**：每章动笔前先提交**注意力设计**——主类型（事件 / 情感 / 文字 / 悬念 / 关系）、四拍（钩子 20 / 张力 20 / 回报 30 / 章末牵引 30）和设计分（0–100）。没有设计，工作单不会让你动笔：`design` 提交缺四拍或 `designScore` 直接拒绝，写正文与开工 run 也会收到注意力提醒。
- 写完用**零上下文冷读**打实测分：不告诉 AI 旧分、梗概和账本，只给正文，按同一套四拍打分，结果写回注意力曲线。
- 设计分与实测分差 ≥20，或实测低于全书均分 10 分，下一章的工作单会点名补强最弱的那一拍。
- 这条原则是所有写 / 改工作单的第一行；**审阅工作单与冷读复测不注入它**，保持读者视角纯净。

## 30 秒安装

1. 打开 DeepSeek Harness；
2. 进入 **设置 → 插件**；
3. 在安装框里输入包名：

   ```text
   dsh-long-novel-workbench
   ```

4. 安装完成后刷新页面；
5. 左下角侧栏出现 **📖 小说工作台**，点开就能用。

也可以在命令行安装：

```sh
dsh plugin --profile <你的 profile> add dsh-long-novel-workbench
```

> **从源码或本地 link 安装（开发者）**：`git clone` 后让 profile 指向本仓库（用 `plugin_manager` 的 `install_bundle`，target 填仓库绝对路径）。完整步骤、升级 / 切换、热重载、`preflight` 体检、旧稿迁移与发版说明见 [docs/DEV-INSTALL.md](docs/DEV-INSTALL.md)。

## 第一次打开

- **已有作品**：作品数据在 `~/StoryDesk/projects/<id>/`，打开工作台就能列出来，旧项目不需要迁移就能读。
- **开新书**：总览页或空库页点 **＋ 开新书** → 只填书名（同时作为工作区名）→ 选写作预设（或「自定义（让 AI 定）」）→ 写一段想法。工作台会创建作品、**给这本书建一个独立 DSH 工作区，并在里面新开一个对话**，把「方案 / 世界 / 地点 / 人物 / 全书大纲 / 伏笔」工作单发进去；AI 以提案提交，你批准后才进账本。
- **导入旧稿**：设置页 **📥 导入旧稿**（顶栏「⬆ 导入」直达）可以扫描任意目录或单个 `.md` / `.txt`，不要求 `0001.md` 命名，导入会新建一部作品，**原目录不动**。
- **打开方式**：侧栏 **📖 小说工作台** = 在系统默认浏览器打开全屏网页版后台（认证复用 DSH，关掉 DSH 网页即失效）；侧栏 **⧉** = 不跳浏览器，留在 DSH 窗口内的浮层。手机 / DSH Remote 上，普通页面仍是 DSH，只有「在默认浏览器打开」生成的专属链接会直接进入工作台，窄屏有可滚动的顶部导航和常驻关闭按钮。

## 先看几张图

> 截图来自演示数据：一部 24 章的合成武侠长篇《云隐剑歌》，用于展示界面，不涉及任何真实作品。

**正文页：打开就是全文** —— 左目录、中间连续阅读、右栏是本章注意力与审阅统计。

![正文页](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/01-read.png)

**审阅收件箱：四路同权** —— AI 味 / 事实逻辑 / 注意力 / 四路一起审四个入口，每条审阅都带逐字引文。

![审阅](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/02-reviews.png)

**提案：AI 只出提案，人逐条批** —— 按状态筛选，可全选批量批准 / 驳回；展开看「原文 / 改为」。

![提案](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/03-proposals.png)

**全文动作 run** —— 从头写 / 扩写 / 改写三种动作，阶段进度与预算一目了然。

![全文动作](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/04-run.png)

**总览** —— 置顶原则条与平均注意力 / 最低三章 / 未测章数，下面是注意力曲线与待办。

![总览](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/05-overview.png)

**账本 · 世界地图** —— 按地点坐标直绘：分区、水线山形、驿道路线与地名避让。

![世界地图](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/06-ledger-map.png)

**账本 · 人物卡** —— 按主角 / 反派 / 配角分组，几十号人物一眼能扫。

![人物卡](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/07-ledger-characters.png)

**沉浸模式** —— 收掉顶栏、导航与侧栏，正文接近全屏，只留阅读 / 编辑 / 审阅三颗按钮和字号。

![沉浸模式](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/08-immersive.png)

**手机阅读** —— 窄屏布局、长按选字加批注、字号照样可调。

![手机阅读](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/09-mobile-read.png)

## 核心循环：读 → 批注 → 审 → 改

| 一步 | 你做什么 | 工作台做什么 |
| --- | --- | --- |
| **读** | 在正文页连续读全本，或只看某一章 | 打开就是全文：`j` / `k` 翻章、`/` 搜索并精确跳到命中段落、字号 13–28px 与行距可调、记住阅读位置 |
| **批注** | 切到审阅模式，选中正文里不顺的那句，写下你的意见 | 读者批注以 `source=reader` 进入审阅收件箱，和 AI 的意见排在一起 |
| **审** | 按需勾选章节，跑 AI 审阅；或让 AI 零上下文冷读打分 | 四路同权审阅（逻辑与事实 / 注意力 / 去 AI 味 / 读者），每条必须带逐字引文；冷读打分只给正文、不给旧分 |
| **改** | 勾选审阅条目 → 生成修改提案 → 逐条批准 / 编辑后批准 | AI 产出段落级 `before / after`（或整章重写、跨章 `book-fix`、账本 `ledger-fix`），**批准才落盘，落盘仍要过闸门** |

所有 AI 产出都先停在「提案」里；工作台不会背着你改正文。批量写 / 扩 / 改走「全文动作」的 run，同样只按阶段推进、可暂停可中止。

## 功能一览

### 正文页优先：连续阅读、页内编辑、读者批注

- **连续阅读**：三栏布局（目录 ｜ 阅读区 ｜ 右栏），默认打开就是全文，不是一页一张表单。
- **三种模式**：**阅读**（纯读，不改正文）｜ **编辑**（页内 `textarea` 直改正文，停止输入 2 秒自动保存，`⌘S` 立即保存；正文被别人改过时按 `baseHash` 拦下来提示刷新）｜ **审阅**（选中正文文字即可加读者批注）。
- **搜索与目录**：全文搜索点结果精确跳到命中段落；目录可新建 / 删除章节。删除会一并清掉本章审阅、批注与待批准提案，已采纳 / 已驳回的提案留作历史。
- **单章历史版本**：每次保存正文有变化都会自动备份，历史版本可预览、可载回编辑器（载回后仍要保存才写盘）。
- **阅读位置同步（0.6.11）**：阅读 / 编辑 / 审阅三种模式共用同一个位置，精度到**段落**。阅读切编辑会打开本章并把编辑器滚到那一段、光标落在段首；编辑切回阅读会落回光标所在段；滚动停下 300ms 后写到本机 `localStorage`，重开页面回到同一段。沉浸模式切换也不会退回章首。这些只存本机浏览器，不写回作品文件。
- **沉浸模式（0.6.10）**：工具栏 **⛶ 沉浸** 收掉顶栏、左导航、目录、右栏与原则条，正文区只留「阅读 / 编辑 / 审阅」三颗按钮和字号 `− 15 +`；`Esc` 先退出沉浸（不会顺手关掉工作台）；开关记在本机。
- **仿纸正文底（0.6.10）**：阅读区与正文编辑器共用同一张暖纸（极淡纤维纹理），编辑器不再用等宽字体，和阅读共用字号 / 行距——改稿时看到的就是成稿的样子；宽屏窄屏一致，纸色不随宿主明暗主题反转。
- **手机 / 窄屏**：窄屏自适应布局；审阅靠**长按选字**加批注（批注框是贴底面板）；字号上下限（13–28px）在手机上真的生效，不加载任何网络字体。

### 四路审阅与冷读打分

- 审阅页顶部四张卡：**AI 味审阅 / 事实逻辑审阅 / 注意力审阅 / 四路一起审**。点任一张 → 逐章勾选范围（默认整本书，快捷：全书 / 未审过的 / 有意见的 / 清空）并填「这次重点」→ 生成工作单发到对话。**不预设章数、不按顺序截断**，勾了哪几章就审哪几章。
- 四路同权：**逻辑与事实 / 注意力 / 去 AI 味 / 读者批注**。每条审阅必须带该章正文里逐字出现、且只出现一次的引文（≥4 字）；全书级问题用 `chapter=0`。
- 勾选审阅条目后可以：**生成修改提案**（AI 把这段改写成成文正文，产出段落补丁）、**全局修改意见**（`chapter=0` 的问题归成一条全局意见，每个问题出一条跨章 `book-fix` 提案）、**冷读打分 / 复测**（零上下文通读，按四拍打实测分，写回注意力曲线）。
- **冷读打分的入口**：审阅页「冷读打分 / 复测」、正文页侧栏「🧊 AI 冷读打分本章」、总览页注意力曲线卡「冷读打分」。打分说明会原样进工作单；复测不透露旧分。
- **注意力可人工校准**：右栏可以直接改本章四拍实测分（钩子 / 张力 / 回报 / 章末牵引，合计即总分），改动写进 `scoreHistory`。

### 提案批次

- 提案分四种：`patch-paragraph`（逐段原文 / 改为）、`rewrite-chapter`（整章新正文）、`ledger-fix`（账本修订）、`book-fix`（跨章全书修改）。
- 提案页按状态分「待批准 / 未通过闸门 / 已采纳 / 已驳回 / 已修订」；展开可以看「原文 / 改为」，并**直接编辑「改为」再批准**。
- 待批准提案支持全选与**批量批准 / 批量驳回**（驳回原因会写到每一条）；采纳后关联审阅自动标为「已修复」。
- 工作单可以选发到「自动（最近在用）/ 新开一个对话 / 指定某个会话」，发送成功后自动跳回那个对话。

### 全文动作 run

- 三种动作：**从头写**（`continue`，按大纲接着写新章，过闸门直接落盘）、**扩写**（`expand`）、**改写**（`rewrite`，再细分 文风 / 逻辑与事实 / 结构与节奏）。
- 范围可以是全书、单章或区间；run 有阶段进度与预算（tokens / 费用），可暂停、恢复、中止。
- 点「开工」才把工作单发进本书对话；**除「从头写」外，产物只进提案**。
- run 的第一个阶段固定是「先定注意力设计」——没有设计不动笔。

### 账本与全书同步

- 账本页把一本书的资料收在一个页面里：**事实库 / 人物卡 / 时间线 / 地点 / 世界地图 / 高光 / 冲突 / 伏笔 / 大纲**。
- **人物卡**用卡片看（目标 / 缺陷 / 弧光 / 关系），不再是一行行表格；**时间线**按章号与故事时间排序，高潮 / 重大事件着色，点章号跳正文；**大纲 / 高光**等旧数据直接读得到、可编辑。
- **账本同步提醒**：改正文如果动到了账本里的**人名 / 地名 / 事实里的数字**，顶部会出现「⚠ 第 N 章正文改到了账本里的名字 / 数字」，可以点「让 AI 核对」（生成账本核对工作单，只允许提 `ledger-fix` 提案）或「已核对，忽略」。没碰到账本内容的改动不会打扰你；AI / run 写出来的正文同样会记这条信号。
- **全书账本同步（0.6.3）**：整本写完后账本常常还停在写作中途。账本页右上角 **📚 全书同步** 把正文按批（默认每批 6 章，可选 4 / 6 / 8 / 10）切开，每批生成一份【全书账本同步工作单】发给 AI 读正文补账本；AI 只能提 `ledger-fix` 提案，作者批准后点「本批已同步」记进度。可以「重新制定计划」（章号范围相同的已完成批保留）或「清除计划」；计划建立后新写的章会单独提示未覆盖。

### 世界地图

- 账本「世界地图」只做一件事：**照你自己的地点坐标画一张能用的地图**——坐标即位置，不拉伸、不挪点、不做疏密变形。
- 分区：若 `world.json` 的 `mapStyle.aiPlan` 里存过【区域】行就按它画分区底纹，没存过就按地点的 `region` 归并兜底；路线：`aiPlan` 里的【路线】行能落到真实地点的画成虚线驿道，没有就按事件里的 `location` 顺序串一条行程线。
- 山水：水点连成水线并标名（如「渭水」），山形沿 mountain / pass / 关 / 山 这类地点撒点；地名按重要性避让，宁可少一个字也不压在地名上。
- 工具栏四个开关：区域 / 山水 / 路线 / 地名；全屏地图支持滚轮缩放、拖动平移、重置、`Esc` 关闭，点地点出地点卡。
- 换样子改 `world.json` 的 `mapStyle.palette`：`ink` 水墨绢本 / `ochre` 赭石古卷 / `jade` 青绿山河 / `sepia` 羊皮纸 / `steel` 冷灰史诗 / `wine` 暗红纪事。0.6.1 起不再提供「生成底图 / 换画风 / 让 AI 出方案」按钮——那些只会多花 token，画出来还和地点对不上。

### 开新书、写作预设与导入旧稿

- **开新书向导**：书名（同时是工作区名）→ 选预设（4 套内置口径或「自定义（让 AI 定）」）→ 写一段想法 → 创建作品、独立工作区与对话，并把底座工作单发过去。选「自定义」时 AI 先出一份方案（类型 / 篇幅 / 结构 / 风格 + **注意力总设计**），批准后自动成为本书预设；大纲每章必须带四拍注意力设计。
- **写作预设**：设置页 **📚 写作预设** 内置 5 套（标准长篇 / 冷峻悬疑 / 家国武侠 / 文学现实 / 自定义模板），可新建、编辑、删除、应用、复制绝对模板（字段说明见 [`docs/PRESET-TEMPLATE.md`](docs/PRESET-TEMPLATE.md)）。**换预设不改正文**，只影响之后生成的 AI 工作单。
- **导入旧稿**：支持任意目录（递归找 `.md` / `.txt`，有 `chapters/` 优先）或单个 `.md` / `.txt`；单文件会先按「第 X 章」标题拆章，≥2 章才拆。章号优先取文件名数字前缀，冲突或缺失时按自然序排。扫描预览后才导入，导入会新建作品，原目录不动。

### 导出正文

顶栏 **⬇ 导出** 或设置页 **📤 导出正文** 可以把全本导成 **TXT / Markdown / EPUB 3 / DOCX**（可选附章节提要）。

- 成品会洗掉写作期残留的 Markdown 标记；`※` 场景分隔在 TXT 里原样保留，在 Markdown 里转成 `***`。
- 零依赖：EPUB / DOCX 在内存里拼 ZIP 生成，不需要装打包工具。
- 导出只读数据、不写盘。

### 用量统计

`usage.summary` 读本书工作区的 DSH 会话日志（含子代理会话族），按 `data.usage` 累计 tokens，再用 models.dev 价目估算人民币；旧 `usage.json` 的字段仍保留在顶层兼容。

## AI 与工具链

工作台自己不写正文。所有 AI 动作都是同一条链路：**工作台生成工作单 → 发到你选的对话 → AI 调 `novel_desk_*` 工具执行 → 结果以审阅 / 提案回到工作台**。你也可以直接在对话里让 AI「审一下第 2 章」「按大纲从头写下一章」，它会先读账本再动手。

7 个工具（新的对话里就能看到）：

| 工具 | 用途 |
| --- | --- |
| `novel_desk_read` | 读作品列表 / 设定与账本摘要 / 目录 / 单章正文 / 审阅收件箱 / 提案 / run / 账本 / 全文搜索（返回紧凑文本，不是 JSON 大块） |
| `novel_desk_review` | 提交审阅条目（四路 `source`，逐字 `quote` ≥4 字） |
| `novel_desk_attention` | 注意力四拍：`design` 写设计 / `measured` 零上下文实测 / `workorder` 设计工作单 / `recheck` 冷读复测 |
| `novel_desk_propose` | 提交提案（`patch-paragraph` / `rewrite-chapter` / `ledger-fix` / `book-fix`），不改正文 |
| `novel_desk_write` | 经闸门写入整章正文（run 产正文入口），失败不落盘 |
| `novel_desk_run` | 全文动作：start / status / advance / pause / resume / finish / abort |
| `novel_desk_map` | 把地图区域 / 路线方案存进 `world.json`（兼容保留的入口，界面不再生成底图） |

约束写在每个工作单里，也由服务端硬校验：

- **单一写入闸门**：任何正文写入都按 `normalizeProse → 保真（数字 / 专名不能丢）→ 残留扫描 → 去 AI 味（>30 分判不过）→ 落盘` 执行；任一失败，提案标 `needs-fix`，正文不动。
- **结论只走工具**：AI 不得直接改文件；审阅与提案的引文必须逐字命中当前正文、且能唯一定位，否则提交阶段就被拒绝。
- **注意力前置**：所有写 / 改工作单第一行都是 `> ATTENTION IS ALL YOU NEED……先提交本章注意力设计（四拍 + designScore），再动笔`，并附最近 6 章曲线、疲劳预警、目标分与强制补强；`novel_desk_attention op="design"` 缺任一拍或 `designScore` 直接拒绝。
- **工作台接口**：只有一个 RPC 入口 `POST /novel-desk/api`，复用 DSH 宿主认证，未认证请求 401，不返回任何 CORS 头。

## 数据在哪、怎么升级

数据都在本机，纯文本 + JSON，没有数据库、没有私有格式；停用插件数据也还在，可以直接备份、进 Git、用别的编辑器打开。

```text
~/StoryDesk/
  library.json
  projects/<id>/
    project.json
    chapters/NNNN.txt          ← 0.6 新章：纯文本正文
    chapters/NNNN.meta.json    ← 章级元数据（标题 / 状态 / 摘要 / 闸门结果…）
    chapters/NNNN.md           ← 0.5.x 旧章：frontmatter + 正文，原地读写回
    reviews.json               ← 四路审阅
    attention.json             ← 注意力账本（按章）
    proposals.json             ← 提案
    runs.json                  ← 全文动作
    facts.json characters.json events.json foreshadow.json conflicts.json locations.json world.json presets.json
    ledger-sync.json           ← 账本同步信号与全书同步计划
    .backups/                  ← 章节历史版本
```

数据根可以用环境变量 `STORY_DESK_ROOT` 覆盖（测试 / 多套数据时很有用）。

### 0.5.x 兼容与升级注意

- **旧项目直接可读**：0.5.x 的 `chapters/NNNN.md`（带 frontmatter）继续可读，也**原地写回 `.md`**，不认识的 frontmatter 字段原样保留；新章才写 `.txt + .meta.json`。旧 `attention.json`、`reviews.json`、账本文件与旧提案都能读，不会误删；0.5.x 的老提案原样保留，但不在 0.6 提案页里处理。
- **0.5 与 0.6 不能同时启用**：两者都注册 `/novel-desk/api`，且工具名 `novel_desk_propose`、`novel_desk_review` 重名——同时加载会在插件装配期直接报错。升级时先移除旧插件，再安装 0.6；顺序见 [`docs/DEV-INSTALL.md`](docs/DEV-INSTALL.md)。
- **迁移是可选的**：不想改文件格式就什么都不用做。需要把旧项目统一成 `.txt + meta.json` 时再跑 `node scripts/migrate.js`（默认 dry-run；`--apply` 前整目录备份到 `.pre-0.6.0/`，逐章 sha256 校验，并写 `migration-report.json`；`--verify` 可复核后来被改过的章）。**迁移后旧插件只认 `.md`、会显示 0 章**，所以务必等旧插件已移除、0.6 已接管之后再迁移。

## 开发与测试

需要 **Node `^22.19.0 || >=24.0.0`**（`package.json` 的 `engines`）。仓库没有第三方依赖，也没有构建步骤；测试用 Node 内置的 `node:test`，零依赖。

```sh
git clone https://github.com/micellince/dsh-long-novel-workbench.git
cd dsh-long-novel-workbench

npm test            # node --test test/*.test.js：164 个测试
npm run check       # node --check：index.js / client.js / lib/*.js 语法检查
npm run e2e         # 界面端到端 116 条：无头 Chrome + CDP，真实 HTTP handler + 真实 store（临时副本）
npm run smoke       # 界面冒烟：12 个页面 / 页签逐一挂载并截图
npm run smoke -- --size 500x844   # 手机宽度截图，验证窄屏布局
```

- 测试与脚本都跑在临时副本上，**不写 `~/StoryDesk`**；`e2e` / `smoke` 需要本机有 Chrome（可用 `--chrome` 指定路径）。
- 改 Host 代码（`index.js`、`lib/*.js`）后需要重载插件；改 `client.js` 后刷新页面即可。
- 本地 link 安装、升级 / 切换、`preflight` 体检、`migrate` 迁移、打开链路与发版流程见 [docs/DEV-INSTALL.md](docs/DEV-INSTALL.md)。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [`docs/REBUILD-CONTRACT.md`](docs/REBUILD-CONTRACT.md) | 重建契约：数据模型（Chapter / Review / Attention / Proposal / Run）、模块边界、RPC 与工具、客户端结构 |
| [`docs/ACCEPTANCE-0.6.md`](docs/ACCEPTANCE-0.6.md) | 0.6.1 → 0.6.11 每一版的增减与验收证据：测试数字、真实数据只读验证、安全与共存、尚未验证 / 明确不做的部分 |
| [`docs/MAP-MODEL.md`](docs/MAP-MODEL.md) | 地图模型：坐标、分区、路线、水线山形、地名落点规则 |
| [`docs/PRESET-TEMPLATE.md`](docs/PRESET-TEMPLATE.md) | 写作预设的绝对模板与字段口径 |
| [`docs/DEV-INSTALL.md`](docs/DEV-INSTALL.md) | 开发安装、升级切换、热重载、preflight、旧稿迁移、发版 |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更记录 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 参与贡献：环境、加载插件、测试与代码约定 |

## 问题与反馈

用着不顺手、缺功能、发现 bug，欢迎开 [Issue](https://github.com/micellince/dsh-long-novel-workbench/issues)；预设、检查规则都是数据驱动的，PR 也很好加。如果这个工作台帮你少踩一个坑，点个 ⭐ 就是最大的鼓励。

## License

[MIT](LICENSE)。拿去用，随便改。

---

## English summary

**Long-form Chinese Novel Workbench** — a read → annotate → review → revise workbench for long Chinese novels, shipped as a DeepSeek Harness (DSH) plugin.

- Manuscript first: continuous reading, in-page editing, reader notes, immersive mode, a paper-like page, and one shared paragraph-level reading position across read / edit / review.
- Four equally weighted review lanes (logic & facts, attention, AI-style, reader notes), plus a zero-context cold read that scores each chapter on four attention beats.
- Every AI change is a proposal — paragraph patches, chapter rewrites, cross-chapter book fixes, ledger fixes — and only human approval writes it to disk, through a single gate (normalize → fidelity → residue scan → AI-style audit → save).
- A per-book ledger (facts, characters, timeline, locations, foreshadowing, conflicts, highlights, outlines), a coordinate-driven world map, and batched whole-book ledger sync keep canon in step with the prose.
- First principle: **ATTENTION IS ALL YOU NEED** — design each chapter's hook, tension, payoff and cliff before writing, then measure it with an independent cold read.
- Export to TXT, Markdown, EPUB 3 or DOCX; plain-text and JSON data in `~/StoryDesk`; MIT licensed.
- Version 0.6.11, released 2026-10-26 (first release after 0.5.1). Install from DSH *Settings → Plugins* with the package name `dsh-long-novel-workbench`.
