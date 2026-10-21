# 长篇中文小说工作台 · Long-form Chinese Novel Workbench

DeepSeek Harness 的通用长篇中文小说工作台插件。**不限文体、不绑定任何作品**，数据全部是普通文件，UI 与 Agent 共享同一套账本。

## 界面

侧栏底部「📖 长篇中文小说工作台」→ 全屏工作台，14 个页签：

| 页签 | 内容 |
|---|---|
| 总览 | 作品设定、统计卡、一致性检查、最近章节 |
| 章节 | 新建/编辑/删除：正文、摘要、状态、故事时间、地点、出场人物、实时字数 |
| 时间线 | 按章排列的事件流：故事时间、地点、参与人、后果、重要度 |
| 事实账本 | 主体·属性·取值·首次出现章；同属性多取值自动判冲突 |
| 伏笔 | 埋设章 → 计划回收章 → 状态；超期未回收报警 |
| 冲突 | 内心/人际/社会/环境：赌注、升级、状态、计划解决章 |
| 人物 | 目标、动机、缺陷、弧光、关系、外貌、性格 |
| 高光 | 对白/描写/反转/情绪/动作片段 |
| 审稿 | 维度、严重度（阻断/严重/一般/建议）、问题、建议、状态 |
| 提案 | AI 生成的内容在此对比、采纳、驳回；章节正文带逐行 diff |
| 对齐 | 预设计划 vs 实际：章数/字数进度、每章偏离、事件/事实/审稿覆盖 |
| 分工 | 9 个 Agent：总编/大纲师/世界观师/人物师/时间线师/伏笔师/连续性审稿/文笔审稿/责任编辑 |
| 预设 | 类型、视角、时态、基调、**计划章数、每章字数、总字数、结构模板、风格规则、禁忌、审稿重点** |
| 设置 | 数据路径、导出 Markdown、删除作品 |

## AI 怎么操作工作台

两条路，共享同一套数据：

**A. 工作台内直接让 AI 干**
点右上角「🤖 让 AI 操作」→ 选任务：

- 生成下一章方案（标题/摘要/节拍/事件/事实/伏笔）→ 进入「提案」
- 续写下一章正文 → 进入「提案」，采纳前不动正文，采纳时自动备份旧稿
- AI 审稿 → 按预设的审稿重点逐项检查 → 写入「审稿」
- 补全时间线 / 抽取事实与人物 → 进入「提案」

AI 使用宿主 LLM 路由（不需要额外 key），结果一律先落「提案/审稿」，人工对比后点「采纳」。

**B. 在会话里对 Agent 说**
Agent 有 7 个工具：

| 工具 | 作用 |
|---|---|
| `novel_desk_projects` / `novel_desk_bundle` | 列出作品 / 读取完整结构 |
| `novel_desk_context` | 写作上下文：预设、9 Agent 分工、人物、事实、时间线、伏笔、冲突、审稿 |
| `novel_desk_plan` | 生成下一章「工作单」：目标章号、字数、必须延续的设定、上一章结尾、要求的 JSON 结构 |
| `novel_desk_propose` | 把生成内容作为「提案」提交，不直接改账本 |
| `novel_desk_review` | 提交审稿意见 |
| `novel_desk_upsert` | 仅在作者明确要求“直接改”时直写 |

例如在会话里说：「给《长夜将明》补第 3 章时间线」。Agent 会 `novel_desk_plan` → 按工作单生成 → `novel_desk_propose`，你在「提案」页对比采纳。

## 数据位置

默认 `~/StoryDesk`（可用 `STORY_DESK_ROOT` 覆盖）：

```
library.json
projects/<id>/project.json
projects/<id>/chapters/NNNN.md      ← frontmatter + 正文
projects/<id>/facts.json
projects/<id>/events.json
projects/<id>/foreshadow.json
projects/<id>/conflicts.json
projects/<id>/characters.json
projects/<id>/highlights.json
projects/<id>/presets.json
projects/<id>/reviews.json
projects/<id>/proposals.json
projects/<id>/agents.json
projects/<id>/.backups/             ← 采纳正文提案前的旧稿备份
```

全部可直接备份、进 Git、用任意编辑器打开；插件停用不影响数据。

## 默认预设

新建作品自动写入「标准长篇方案」：

- 计划 **80 章** × 每章 **3000 字** = 总 **240,000 字**
- 结构：三幕 + 起承转合（20% / 50% / 30%）
- 风格规则 4 条、禁忌 4 条、审稿重点 6 项
- 9 个 Agent 分工

老作品会自动补齐缺失的计划章数/字数/结构/审稿重点。

## 安装

**方式一：GitHub Release tarball（当前可用，无需 npm）**

```sh
dsh plugin --profile <你的 profile> add \
  https://github.com/micellince/dsh-long-novel-workbench/releases/latest/download/dsh-long-novel-workbench.tgz
```

也可以在 DSH 的插件安装框里直接粘贴上面这个 tarball 链接。

**方式二：npm（发布后可用，最方便）**

```sh
dsh plugin --profile <你的 profile> add dsh-long-novel-workbench
```

发布后，在 DSH 的「插件」里直接输入包名 `dsh-long-novel-workbench` 即可安装。

**方式三：本地目录**

```
plugin_manager({ action: "install_bundle", target: "/绝对路径/dsh-long-novel-workbench" })
```

安装后刷新 Web GUI，侧栏底部出现「长篇中文小说工作台」。

## 提案与审稿

- AI 生成的内容先进入「提案」，不会直接改账本。
- 提案支持：**采纳 / 提修改意见 / 让 AI 按意见重写 / 驳回**。
- 修改意见可以是人工写的一段话（保留什么、删什么、往哪改），保存后点「让 AI 按意见重写」，会生成一份新提案，旧提案标记为「已修订」。
- 章节正文提案带逐行 diff；采纳时自动备份旧稿到 `.backups/`。

## 名家风格库

「预设」页内置 8 套可选风格模板，一键加入作品后可继续修改：

金庸 · 古龙 · 梁羽生 · 柯南·道尔 · 阿加莎·克里斯蒂 · 东野圭吾 · 刘慈欣 · 村上春树。

每套都带类型、视角、时态、基调、计划章数/每章字数/总字数、结构模板、风格规则、禁忌、审稿重点。

## License

MIT

## 相关

- 仓库：<https://github.com/micellince/dsh-long-novel-workbench>
- 发布说明：[PUBLISHING.md](PUBLISHING.md)
