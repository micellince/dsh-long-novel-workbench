# 📖 长篇中文小说工作台

[![npm version](https://img.shields.io/npm/v/dsh-long-novel-workbench.svg)](https://www.npmjs.com/package/dsh-long-novel-workbench)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4b6bfb)](https://github.com/micellince/dsh-long-novel-workbench)

写长篇的人都懂那种感觉：写到第三十章，突然想不起来第三章里那个配角姓什么；伏笔埋了三十万字，自己先忘了埋在哪；设定越写越多，最后正文、大纲、笔记各说各话。

这个插件就是给这种时刻准备的——一个装在 **DeepSeek Harness** 里的长篇中文小说工作台。章节、时间线、事实账本、伏笔、冲突、人物、高光、审稿、提案、计划对齐，都在一个地方；AI 不只是陪你聊，它能直接读这些账本，帮你生成下一章、审稿、补时间线，但**所有 AI 产出都先落在「提案」里，你点头才进正文**。

不限文体：武侠、悬疑、科幻、言情、文学都可以。内置金庸、古龙、梁羽生、柯南·道尔、阿加莎·克里斯蒂、东野圭吾、刘慈欣、村上春树八套风格预设，也可以自己调。

## 先看三张图

**总览：一本书现在写到哪、有没有前后矛盾**

![总览](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/01-overview.png)

**时间线：按章排列的事件，故事内时间、地点、参与人、后果**

![时间线](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/02-timeline.png)

**预设：计划章数、每章字数、结构、风格规则、禁忌、审稿重点，都能改**

![预设](https://raw.githubusercontent.com/micellince/dsh-long-novel-workbench/main/docs/screenshots/03-presets.png)

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

## 第一次打开

- 内置一部演示作品《长夜将明》，可以随便点、随便改，玩完在「设置」里一键删掉；
- 点右上角「＋ 新建作品」，填书名、类型、目标章数/字数，开始你自己的书；
- 数据默认存在 `~/StoryDesk`，全是普通 Markdown/JSON 文件，能备份、能进 Git、能用别的编辑器打开。

## AI 帮你干活的两个入口

**在工作台里**：点右上角「🤖 让 AI 操作」，选任务：

- 生成下一章方案（标题、摘要、节拍、事件、事实、伏笔）
- 续写下一章正文
- AI 审稿（按你的审稿重点逐项挑问题）
- 补全时间线 / 抽取事实与人物

**在聊天里**：直接说「给《长夜将明》补第 3 章时间线」「审一下第 2 章」。Agent 会先调 `novel_desk_plan` 拿精确工作单，再调 `novel_desk_propose` 提交提案。

所有 AI 结果都先停在「提案」里：可以 **采纳 / 提修改意见 / 让 AI 按意见重写 / 驳回**。章节正文提案带逐行 diff，采纳前自动备份旧稿。**它不会背着你改正文。**

## 9 个 Agent 分工

总编、大纲师、世界观师、人物师、时间线师、伏笔师、连续性审稿、文笔审稿、责任编辑。每个角色有职责、输入、产出，写在「分工」页里，AI 写作和审稿时会读这份分工。你可以改。

## 数据在哪

```
~/StoryDesk/
  library.json
  projects/<id>/
    project.json
    chapters/NNNN.md      ← frontmatter + 正文
    facts.json            ← 事实账本
    events.json           ← 时间线
    foreshadow.json       ← 伏笔
    conflicts.json        ← 冲突
    characters.json       ← 人物
    highlights.json       ← 高光
    reviews.json          ← 审稿
    proposals.json        ← 提案
    agents.json           ← 9 个 Agent 分工
    presets.json          ← 写作预设
    .backups/             ← 采纳正文提案前的旧稿
```

没有数据库，没有私有格式。停用插件，数据还在。

## 它还会替你看这些

- 同一个人的同一个属性出现两个不同取值 → 事实冲突
- 伏笔过了计划回收章还没回收 → 报警
- 章节引用了没建卡的人物 → 提示
- 审稿里的阻断/严重问题 → 进总览
- 计划章数/字数 vs 实际进度 → 对齐页

这些规则都是确定性的，不花 token。

## 欢迎 Star，也欢迎来骂

如果这个工作台帮你少踩一个坑，**点个 ⭐ 就是最大的鼓励**；用着不顺手、缺什么功能、发现 bug，直接开 [Issue](https://github.com/micellince/dsh-long-novel-workbench/issues) 告诉我，我会看。

也欢迎 PR：预设、Agent 分工、检查规则都是数据驱动的，很好加。

## License

MIT。拿去用，随便改。

---

<sub>Made for people who write long things. 如果你也在写一本很长的书，祝你写得完。</sub>
