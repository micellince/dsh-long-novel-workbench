# 📖 长篇中文小说工作台

[![npm version](https://img.shields.io/npm/v/dsh-long-novel-workbench.svg)](https://www.npmjs.com/package/dsh-long-novel-workbench)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4b6bfb)](https://github.com/micellince/dsh-long-novel-workbench)
[![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen)](package.json)

一个装在 **DeepSeek Harness（DSH）** 里的长篇中文小说工作台：**打开就能看全文；AI 只负责找问题和写修改稿，稿采纳进正文才生效**。

> 当前版本 **0.7.1**（2026-10-26 发布）。这是 0.7 线第一次公开发布：把「审阅」重做成「问题单 + 修改稿」，提案不再参与审阅改稿。`0.7.0-dev.0` 是未发布的开发线，对外统一使用 `0.7.1`。

## 它解决什么痛点

写长篇的人都懂那种感觉：写到第三十章，突然想不起第三章里那个配角姓什么；伏笔埋了三十万字，自己先忘了埋在哪；设定越写越多，正文、大纲、笔记各说各话。更麻烦的是 AI——它会陪你聊，但要它先读完你的账本再动手，很难；它改起正文来又太快，你不敢直接让它改。

这个插件把写作台搭在数据上面：章节、人物、事实、时间线、地点、世界、伏笔、冲突、高光、大纲都收在同一本书的账本里；AI 通过工具读这些账本，**只出问题与修改稿**，正文只有你采纳修改稿之后才会改（唯一的正文落盘入口仍是写入闸门）。日常只做一件事——**读、批注、找问题、采纳 / 继续改 / 忽略**，循环着往前走。

不限文体：武侠、悬疑、科幻、言情、文学现实都可以。四套内置写作预设（标准长篇 / 冷峻悬疑 / 家国武侠 / 文学现实）加一套自定义模板，也可以让 AI 先出一套方案。

> **⚡ ATTENTION IS ALL YOU NEED**
>
> 怎么吸引读者怎么来，一切为读者服务。先抓人，再自洽：每章必须有核心注意力；事实自洽是底线，不是目标。

- **注意力 = 通读审里的评分**：一次通读给每章 0–100 分 + 一句结论，另给全书一个总分，结果写回注意力曲线；打分机制与展示跟之前一致。
- **四拍不再是门槛**：动笔前只需写一句「本章靠什么抓人」；四拍（钩子 / 张力 / 回报 / 章末牵引）不再参与评价，历史设计记录按只读保留。
- **高光不是问题**：通读中发现的亮点直接进账本，不占待办。

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

- **已有作品（0.6.11 及更早）**：旧数据还在 `~/StoryDesk/projects/<id>/`，但 0.7 的数据形态变了（插件索引 + 每本书一个 DSH 工作区 + `novel.db`）。0.7 **不会自动迁移** 旧作品，用 `node scripts/migrate-book-0.7.mjs --project <作品id>` 迁移（默认 dry-run，`--apply` 写盘，旧目录保留）。
- **开新书**：总览页或空库页点 **＋ 开新书** → 只填书名（同时作为工作区名）→ 选写作预设（或「自定义（让 AI 定）」）→ 写一段想法。工作台会创建作品、**给这本书建一个独立 DSH 工作区，并在里面新开一个对话**，把「方案 / 世界 / 地点 / 人物 / 全书大纲 / 伏笔」工作单发进去；AI 以提案提交，你批准后才进账本。
- **导入旧稿**：设置页 **📥 导入旧稿**（顶栏「⬆ 导入」直达）可以扫描任意目录或单个 `.md` / `.txt`，不要求 `0001.md` 命名，导入会新建一部作品，**原目录不动**。
- **打开方式**：侧栏 **📖 小说工作台** = 在系统默认浏览器打开全屏网页版后台（认证复用 DSH，关掉 DSH 网页即失效）；侧栏 **⧉** = 不跳浏览器，留在 DSH 窗口内的浮层。手机 / DSH Remote 上，普通页面仍是 DSH，只有「在默认浏览器打开」生成的专属链接会直接进入工作台，窄屏有可滚动的顶部导航和常驻关闭按钮。

## 先看几张图

> 截图来自演示数据：一部 24 章的合成武侠长篇《云隐剑歌》，用于展示界面，不涉及任何真实作品。

**问题页（0.7.1 新界面，截图待补）** —— 「通读审」「事实与逻辑」两个入口；一张问题单，按类型 / 状态 / 范围 / 章节筛选；每条问题带修改稿，稿可以采纳、继续改或忽略，也可以勾选多条批量出稿。

> 下面的截图来自 0.6.11：正文页、全文动作、账本、地图、沉浸与手机布局在 0.7.1 没有改。

**正文页：打开就是全文** —— 左目录、中间连续阅读、右栏是本章注意力与问题统计。

![正文页](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/01-read.png)

**全文动作 run** —— 从头写 / 扩写 / 改写三种动作，阶段进度与预算一目了然。

![全文动作](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/04-run.png)

**总览** —— 置顶原则条与平均注意力 / 最低三章 / 未测章数，下面是注意力曲线与待办。

![总览](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/05-overview.png)

**账本 · 世界地图** —— 按地点坐标直绘：分区、水线山形、驿道路线与地名避让。

![世界地图](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/06-ledger-map.png)

**账本 · 人物卡** —— 按主角 / 反派 / 配角分组，几十号人物一眼能扫。

![人物卡](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/07-ledger-characters.png)

**沉浸模式** —— 收掉顶栏、导航与侧栏，正文接近全屏，只留阅读 / 编辑 / 批注三颗按钮和字号。

![沉浸模式](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/08-immersive.png)

**手机阅读** —— 窄屏布局、长按选字加批注、字号照样可调。

![手机阅读](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/09-mobile-read.png)

## 核心循环：读 → 批注 → 找问题 → 采纳 / 继续改 / 忽略

| 一步 | 你做什么 | 工作台做什么 |
| --- | --- | --- |
| **读** | 在正文页连续读全本，或只看某一章 | 打开就是全文：`j` / `k` 翻章、`/` 搜索并精确跳到命中段落、字号 13–28px 与行距可调、记住阅读位置 |
| **批注** | 切到批注模式，选中正文里不顺的那句，写下你的意见 | 落成一条问题（来源标为「作者」），和 AI 找到的问题进同一张问题单 |
| **找问题** | 选范围（单章 / 跨章 / 全局），跑「通读审」或「事实与逻辑」 | 一份 TXT 交给一个 AI 一次读完：通读审给评分 + AI 化 / 文风 / 其他问题 + 高光；事实与逻辑先自动扫库，可选再让 AI 审这版 |
| **改** | 看修改稿 → 采纳；不满意写「我的要求」继续改；AI 误报可以「忽略」；多条可以批量出稿 | 段级稿替换该段、整章稿整章替换；采纳后问题关闭并标出写入位置；原文变了的稿不删、问题回到继续改；忽略不删除、可撤销 |

> **0.7.1 只重做「审阅 → 问题单 → 修改稿 → 采纳 / 继续改」这一块。** 编辑器（含自由增删段落）、注意力打分机制、账本、数据库与同步、全文生成 / 改写、导出、世界地图、写作预设都没有动；旧意见数据保留在数据里，但不再迁移进问题单，旧的审阅 / 冷读 / 拆分链路已经下线。

AI 产出的修改稿不会背着你改正文：只有你点采纳才会写入（仍走写入闸门）。批量写 / 扩 / 改走「全文动作」的 run，同样按阶段推进、可暂停可中止。

## 功能一览

### 正文页优先：连续阅读、页内编辑、读者批注

- **连续阅读**：三栏布局（目录 ｜ 阅读区 ｜ 右栏），默认打开就是全文，不是一页一张表单。
- **三种模式**：**阅读**（纯读，不改正文）｜ **编辑**（页内 `textarea` 直改正文，停止输入 2 秒自动保存，`⌘S` 立即保存；正文被别人改过时按内容指纹拦下来提示刷新）｜ **批注**（选中正文文字即可加读者批注）。
- **搜索与目录**：全文搜索点结果精确跳到命中段落；目录可新建 / 删除章节。删除会一并清理本章相关记录，章节历史版本保留。
- **单章历史版本**：每次保存正文有变化都会自动备份，历史版本可预览、可载回编辑器（载回后仍要保存才写盘）。
- **阅读位置同步（0.6.11）**：阅读 / 编辑 / 批注三种模式共用同一个位置，精度到**段落**。阅读切编辑会打开本章并把编辑器滚到那一段、光标落在段首；编辑切回阅读会落回光标所在段；滚动停下 300ms 后写到本机 `localStorage`，重开页面回到同一段。沉浸模式切换也不会退回章首。这些只存本机浏览器，不写回作品文件。
- **沉浸模式（0.6.10）**：工具栏 **⛶ 沉浸** 收掉顶栏、左导航、目录、右栏与原则条，正文区只留「阅读 / 编辑 / 批注」三颗按钮和字号 `− 15 +`；`Esc` 先退出沉浸（不会顺手关掉工作台）；开关记在本机。
- **仿纸正文底（0.6.10）**：阅读区与正文编辑器共用同一张暖纸（极淡纤维纹理），编辑器不再用等宽字体，和阅读共用字号 / 行距——改稿时看到的就是成稿的样子；宽屏窄屏一致，纸色不随宿主明暗主题反转。
- **手机 / 窄屏**：窄屏自适应布局；批注靠**长按选字**加批注（批注框是贴底面板）；字号上下限（13–28px）在手机上真的生效，不加载任何网络字体。

### 找问题：两个入口（通读审 / 事实与逻辑）

- **通读审（冷读 + 去 AI 化合并）**：选范围 → 导出 TXT（单章 / 明确列出的跨章 / 全书）→ 一个 AI 从头读到尾，一次交付：每章注意力 0–100 + 全书结论、AI 化 / 文风漂移 / 其他等问题（读到逻辑与事实也一并记录；每条带范围、严重度、位置、修改稿），以及直接进账本的高光。不再有「先出总结、再按章拆分」。
- **事实与逻辑（单独一档）**：先「自动扫库」（0 AI，扫账本与数据库，列出人物 / 时间 / 数字 / 专名 / 设定上的可疑点，自动存成一条「事实扫库」审稿记录）；需要时再点「让 AI 审这版」，把 TXT + 可疑点交给一个 AI 一次读完，判真假、找跨章连锁、给修改稿。本档重点是「逻辑与事实」。
- **全量记录**：任何一档都只决定「首要目标」，不是过滤器——通读审读到逻辑 / 事实矛盾也一并提交（`logic-fact`），事实与逻辑读到成对重复段落、文风问题也按 `style` / `other` 提交；不让你为漏掉的问题再读一遍。
- **范围只有三种**：单章 / 跨章（明确章号，例：第 2 章 + 第 15 章）/ 全局（全书）。**不按 5 章 / 10 章自动分批**；要分批由你指定章号。
- **铁律**：必须给 TXT、一个 AI 读完，不拆子 agent、不分章合并——跨章和全局问题只有一次读完才看得出来。
- **问题分四类**：**AI 化 / 逻辑与事实 / 文风漂移·较差 / 其他**；每条都带范围（单章 / 跨章 / 全局）、严重度（最严重 / 严重 / 一般 / 提醒）、位置（章 + 段或逐字引文；跨章 / 全局列出涉及章）、一句话说明和修改稿。同一段上不同类就是不合并的两条，各自出稿、各自采纳。
- **审稿记录**：问题页顶部保留最近 5 条审稿记录（通读审 / 事实与逻辑 / 事实扫库），显示范围、平均注意力分、候选数与「待 AI 交回 / 已交回」；「事实扫库」记录可以直接点「让 AI 审这版」。

### 修改稿：采纳 / 继续改 / 忽略 / 批量

- 每条问题默认带修改稿。**段级稿**是一段换一段（不许增删段落、不许出现空行）；**整章改写稿**是整章替换（段数可变）。
- **粒度按问题定**：局部问题给段级稿；单章问题多或严重给整章改写稿；跨章 / 全局问题先看每章改动大小——每章只是小改（改称呼、改数字、删重复句、换一句）就给涉及章各一份**段级稿**（每份带章 + 段 / 逐字引文），修几段解决不了才给各章整章稿。
- **采纳**：段级稿替换该段；整章稿整章替换；多章稿逐章采纳。一条问题下的稿全部采纳后，问题自动「已采纳」，卡片上直接标出写入位置：**「已采纳并写入正文：第 N 章第 M 段」**（整章稿显示「第 N 章整章替换」）。
- **继续改**：不满意就在问题卡里写「我的要求」，回到产生这条问题的那条对话（上下文还在）出新稿；上一版稿进「历史稿」留底，不删，可以点开、也能「恢复为待采纳」。原文被改过、稿对不上的，问题标「原文已变」，稿保留，点「继续改」按新原文重出。
- **忽略**：AI 误报、或换设定后已不成立的问题，点「忽略」——不删除、不催办、不进批量继续改；在「已忽略」筛选里可随时撤销，回到待处理。
- **批量**：勾选多条问题 → 一次生成一批修改稿（同一个对话里做），回来后逐条采纳 / 继续改。批量边界 = 你勾选的范围，不按固定章数切。
- 没有「驳回 / 合并 / 已随处理 / 失效」这些中间状态：问题只有待处理 / 已采纳 / 原文已变 / 已忽略，稿只有待采纳 / 已采纳 / 已作废。

### 全文动作 run

- 三种动作：**从头写**（`continue`，按大纲接着写新章，过闸门直接落盘）、**扩写**（`expand`）、**改写**（`rewrite`，再细分 文风 / 逻辑与事实 / 结构与节奏）。
- 范围可以是全书、单章或区间；run 有阶段进度与预算（tokens / 费用），可暂停、恢复、中止。
- 点「开工」才把工作单发进本书对话；**除「从头写」外，产物不直接改正文**，由你逐章采纳（账本相关改动仍走提案）。
- run 的第一个阶段仍是「先定注意力目标」：写一句本章靠什么抓人；注意力评分由通读审独立给出。

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

- **开新书向导**：书名（同时是工作区名）→ 选预设（4 套内置口径或「自定义（让 AI 定）」）→ 写一段想法 → 创建作品、独立工作区与对话，并把底座工作单发过去。选「自定义」时 AI 先出一份方案（类型 / 篇幅 / 结构 / 风格 + **注意力总设计**），批准后自动成为本书预设。
- **写作预设**：设置页 **📚 写作预设** 内置 5 套（标准长篇 / 冷峻悬疑 / 家国武侠 / 文学现实 / 自定义模板），可新建、编辑、删除、应用、复制绝对模板（字段说明见 [`docs/PRESET-TEMPLATE.md`](docs/PRESET-TEMPLATE.md)）。**换预设不改正文**，只影响之后生成的 AI 工作单。
- **导入旧稿**：支持任意目录（递归找 `.md` / `.txt`，有 `chapters/` 优先）或单个 `.md` / `.txt`；单文件会先按「第 X 章」标题拆章，≥2 章才拆。章号优先取文件名数字前缀，冲突或缺失时按自然序排。扫描预览后才导入，导入会新建作品，原目录不动。

### 导出正文

顶栏 **⬇ 导出** 或设置页 **📤 导出正文** 可以把全本导成 **TXT / Markdown / EPUB 3 / DOCX**（可选附章节提要）。

- 成品会洗掉写作期残留的 Markdown 标记；`※` 场景分隔在 TXT 里原样保留，在 Markdown 里转成 `***`。
- 零依赖：EPUB / DOCX 在内存里拼 ZIP 生成，不需要装打包工具。
- 导出只读数据、不写盘。

### 用量统计

工作台读这本书的 DSH 会话日志（含子代理会话族），按 token 用量与模型价目估算人民币，显示「对话」与「工作台」两部分；旧版留下的用量记录字段仍兼容读取。

## AI 与工具链

工作台自己不写正文。所有 AI 动作都是同一条链路：**工作台生成工作单 → 发到你选的对话 → AI 调 `novel_desk_*` 工具 → 结果以问题单（问题 + 修改稿）回到工作台**。你也可以直接在对话里让 AI「审一下第 2 章」，它会先读 TXT / 账本再动手。

0.7.1 的 7 个工具（新的对话里就能看到）：

| 工具 | 用途 |
| --- | --- |
| `novel_desk_read` | 读作品列表 / 设定与账本摘要 / 目录 / 单章正文 / 账本 / 全文搜索（返回紧凑文本，不是 JSON 大块） |
| `novel_desk_dispatch` | 派单票据（兼容保留）：老的「主对话派子 agent」流程用；0.7.1 的审稿工作单要求一个 AI 读完，明确不使用子 agent |
| `novel_desk_problems` | 提交 / 继续改问题与修改稿：`submit` 写整份问题单（评分 / 问题 / 高光），`revise` 为选中的问题出新稿 |
| `novel_desk_propose` | 账本修订与全文动作的提案（`ledger-fix` 等），不改正文 |
| `novel_desk_write` | 经闸门写入整章正文（全文动作的写章入口），失败不落盘 |
| `novel_desk_run` | 全文动作：start / status / advance / pause / resume / finish / abort |
| `novel_desk_map` | 把地图区域 / 路线方案存进 `world.json`（兼容保留的入口，界面不再生成底图） |

旧的 `novel_desk_review` / `novel_desk_attention` / `novel_desk_cold_split` 已移除：审阅、冷读打分、按章拆分都不再是独立工具，统一走 `novel_desk_problems`。

约束写在每个工作单里，也由服务端硬校验：

- **单一写入闸门**：任何正文写入都按「规范化 → 保真（数字 / 专名不能丢）→ 残留扫描 → 去 AI 味 → 落盘」执行；任一失败，稿 / 提案不落盘，正文不动。
- **结论只走工具**：AI 不得直接改文件；问题的位置必须是章 + 段或逐字引文，修改稿必须是能直接顶替原文的成文文本。
- **一次读完**：审稿工作单必须给 TXT，由一个 AI 读完；禁止拆子 agent、禁止分章移交、禁止按固定章数自动分批；读到的所有问题都要按性质提交，不能因为不是本档目标就丢掉。
- **工作台接口**：只有一个 RPC 入口 `POST /novel-desk/api`，复用 DSH 宿主认证，未认证请求 401，不返回任何 CORS 头。

## 数据在哪、怎么升级

数据都在本机，纯文本 + SQLite（`novel.db`，Node 内置 `node:sqlite`）+ JSON 索引。

```text
~/.dsh/data/dsh-long-novel-workbench/
  library.json                  ← 插件私有索引（作品列表；不含正文）

~/Documents/deepseek-harness/default-workspace/<书名>/
  project.json                  ← 这本书的数据目录（每本书 = 一个 DSH 工作区）
  chapters/NNNN.txt             ← 正文成品（首行 = 回目标题）
  chapters/NNNN.meta.json       ← 章级元数据（标题 / 状态 / 摘要 / hash / 字数）
  chapters/NNNN.index.json      ← 段落索引（pid / hash / 偏移）
  novel.db                      ← SQLite：章节 / 段落 / 实体 / 事实 / 事件 / 伏笔 / 冲突 / 高光 / 问题 / 修改稿
  attention.json                ← 注意力评分账本（按章）
  manuscripts/                  ← 审稿用 TXT（导出给 AI 读，可随时重生成）
  .backups/                     ← 章节历史版本与写入前备份
```

数据根可以用环境变量 `STORY_DESK_ROOT` 覆盖（测试 / 多套数据时很有用）。

### 0.6.11 → 0.7.1 升级

- **数据形态变了**：0.6.11 的作品在 `~/StoryDesk/projects/<id>/`；0.7 起插件索引在 `~/.dsh/data/dsh-long-novel-workbench/`，每本书的数据放在它自己的 DSH 工作区，正文 / 账本 / 问题都在同一目录 + `novel.db`。**0.7 不会自动迁移 0.6 作品。**
- **迁移**：`node scripts/migrate-book-0.7.mjs --project <作品id>` 先 dry-run；确认后加 `--apply` 写盘；旧作品目录原样保留。迁移后旧意见 / 提案记录保留在数据里，但**不再进入新的问题单**（旧意见数据不迁移）。
- **同一包升级**：在 DSH 插件管理里把 `dsh-long-novel-workbench` 升到 0.7.1（或 `dsh plugin --profile <你的 profile> add dsh-long-novel-workbench@0.7.1`），重载插件 + 刷新页面。升级前建议先备份 `~/StoryDesk` 与作品工作区（含 `novel.db*`）。
- **旧格式仍可读**：0.5.x 的 `chapters/NNNN.md`（带 frontmatter）继续可读、原地写回，未知 frontmatter 字段原样保留；`.txt + meta.json` 与旧审阅 / 账本数据都能读。

## 开发、测试与发布

需要 **Node `^22.19.0 || >=24.0.0`**（`package.json` 的 `engines`）。仓库没有第三方依赖，也没有构建步骤。

```sh
git clone https://github.com/micellince/dsh-long-novel-workbench.git
cd dsh-long-novel-workbench

npm run check       # node --check：index.js / client.js / lib/*.js 语法检查
```

> **0.7.1 的测试状态**：按项目当前规则，本版**没有运行自动化测试**，发布验收以作者手测为准；`test/` 目录仍是 0.6 行为断言，尚未随 0.7 的问题单模型更新。`e2e` / `smoke` 脚本依赖真实作品数据与无头 Chrome，不随发布运行。

### 发布方式

发布只走「**推 tag → GitHub Actions → npm**」：

1. 作者在本地提交、推 `main`；
2. 作者打 `v0.7.1` tag 并推送——`.github/workflows/publish.yml` 会先校验 tag 与 `package.json` 版本一致，再用仓库密钥 `NPM_TOKEN` 执行 `npm publish --access public`；
3. 发布后在 npm 上校验 `version` / `dist-tags`，GitHub Release 用 [docs/releases/v0.7.1.md](docs/releases/v0.7.1.md) 做正文并挂上打包好的 `.tgz`。

干净打包、版本一致性清单、发布前检查、发布后验证与回滚规则见 **[docs/RELEASE-RULES.md](docs/RELEASE-RULES.md)**；每个版本的发布说明在 [docs/releases/](docs/releases/)（本版：[v0.7.1](docs/releases/v0.7.1.md)）。发布与打 tag 一律由作者本人发起，Agent 不推送、不打 tag、不发布。

- 改 Host 代码（`index.js`、`lib/*.js`）后需要重载插件；改 `client.js` 后刷新页面即可。
- 本地 link 安装、升级 / 切换、`preflight` 体检、旧稿迁移见 [docs/DEV-INSTALL.md](docs/DEV-INSTALL.md)。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [`docs/0.7-PROBLEM-WORKFLOW.md`](docs/0.7-PROBLEM-WORKFLOW.md) | 0.7.1 产品逻辑：问题单、修改稿、两个找问题入口、范围、处理粒度、采纳 / 继续改 / 忽略 |
| [`docs/releases/v0.7.1.md`](docs/releases/v0.7.1.md) | 0.7.1 发布说明（GitHub Release 正文） |
| [`docs/RELEASE-RULES.md`](docs/RELEASE-RULES.md) | 发布手册：三区隔离、版本一致性、干净打包、GitHub / npm / 市场、回滚 |
| [`docs/REBUILD-CONTRACT.md`](docs/REBUILD-CONTRACT.md) | 重建契约：数据模型（Chapter / Review / Attention / Proposal / Run）、模块边界、RPC 与工具、客户端结构 |
| [`docs/ACCEPTANCE-0.6.md`](docs/ACCEPTANCE-0.6.md) | 0.6.1 → 0.6.11 每一版的增减与验收证据（0.7 之前的历史） |
| [`docs/MAP-MODEL.md`](docs/MAP-MODEL.md) | 地图模型：坐标、分区、路线、水线山形、地名落点规则 |
| [`docs/PRESET-TEMPLATE.md`](docs/PRESET-TEMPLATE.md) | 写作预设的绝对模板与字段口径 |
| [`docs/DEV-INSTALL.md`](docs/DEV-INSTALL.md) | 开发安装、升级切换、热重载、preflight、旧稿迁移 |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更记录 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 参与贡献：环境、加载插件、测试与代码约定 |

## 问题与反馈

用着不顺手、缺功能、发现 bug，欢迎开 [Issue](https://github.com/micellince/dsh-long-novel-workbench/issues)；预设、检查规则都是数据驱动的，PR 也很好加。如果这个工作台帮你少踩一个坑，点个 ⭐ 就是最大的鼓励。

## License

[MIT](LICENSE)。拿去用，随便改。

---

## English summary

**Long-form Chinese Novel Workbench** — a read → annotate → find problems → accept / revise / ignore workbench for long Chinese novels, shipped as a DeepSeek Harness (DSH) plugin.

- Manuscript first: continuous reading, in-page editing, annotations, immersive mode, a paper-like page, and one shared paragraph-level reading position (unchanged).
- Two ways to find problems: a **single-pass reading review** (cold-read attention score + AI-style / voice / other problems + highlights; one AI reads the whole TXT) and a separate **facts & logic lane** (local ledger scan first, optional single-AI pass with the TXT plus suspicious points). Both lanes record everything they find — the lane only sets the primary target, it is not a filter.
- One strict rule: always hand over a TXT (single chapter, explicitly listed chapters, or the whole book) and let one AI read it end to end — no sub-agents, no per-chapter splitting and merging, no fixed-size auto-batching.
- Every problem carries scope (chapter / cross-chapter / global), severity, location and a **draft** (paragraph or whole-chapter). Accept a draft to replace the text, ask for a revision, or ignore a false positive; batch selected problems in one go.
- Proposals are no longer part of review/rewrite: the review chain produces problems and drafts only. Proposals remain for ledger fixes and full-text actions.
- How to find problems: author annotations + two AI lanes; how to fix: accept / request revision / ignore. Editor, attention scoring, ledger, database, full-text generation/rewrite, export, map and presets are unchanged.
- Version 0.7.1, released 2026-10-26 (first public release of the 0.7 line). Install from DSH *Settings → Plugins* with the package name `dsh-long-novel-workbench`.
