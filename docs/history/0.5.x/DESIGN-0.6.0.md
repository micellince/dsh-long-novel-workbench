# NOVEL DESK 0.6.0 · 设计稿

> 一句话：**后台 = 一个能读全书的网页**。左目录、中正文（阅读 ⇄ 编辑 ⇄ 读者三模式）、右审阅栏；读完一章就地审阅、批注、批准提案；全文只保留「重写 / 扩写 / 改写」三个动作。
>
> 状态：草案（第二版：以「正文/阅读」为中心重组）。替代 `docs/v0.4-CONTRACT.md`，吸收 `ATTENTION.md`、`ATTENTION-FIX.md`、`FULLBOOK-PIPELINE.md`、`REVISION*.md` 中仍有效的契约。
> 依据：m00187 审计 + m00191 清单 + 四份只读审计；本版新增：**0.5.2 没有人能看全文**——这是重大设计失误，0.6 的主界面首先解决它。

---

## 0. 为什么要 0.6

0.5.2 的实际形态：5 个核心动作（写、审阅、注意力、提案、全文动作）被复制成 **14 个工具 / 87 个 RPC / 24 个实际页面 / 13 种提案 / 8 条写正文路径 / 6 种"审阅记录" / 4 套任务词表**。

更致命的问题不是多，而是**重心错了**：

- 工作台里能看人物卡、世界观、地图、伏笔、时间线、注意力分……**却看不到正文**。正文只能在「章节」页打开一个弹窗编辑器逐章看，没有连续阅读、没有全文搜索、没有阅读位置；作者想"从头读一遍自己的书"这件事在 0.5.2 里做不到。
- 结果是：人可以维护资料、可以点"AI 生成"，**但不能作为读者参与**。而这本书最终是给人读的。

0.6 的判据：**打开后台第一眼就是正文；读到哪里，就在哪里审阅、批注、修改。**

### 设计原则（违反即回退）

1. **正文是主页。** 任何其他页面都是正文的附属；打开后台默认落在「正文·阅读」。
2. **一个动作，一个入口，一份实现。** 不再有"这个页面也能做"。
3. **AI 只产提案，不直接改正文。** 正文写入只有一个带闸门的函数。
4. **审阅只有一个收件箱。** 逻辑事实、注意力、去 AI、用户意见——四个来源，同一条队伍，同权重。
5. **人工直改是特权。** 作者在正文页直接改，不需要 AI 闸门（保留备份与版本）。
6. **事实与逻辑模块 0.6 冻结。** facts / 时间线 / 世界 / 地点 / checks 不改逻辑，只把输出接进收件箱。
7. **一个地图。** 世界地图有空间语义，章节地图没有；合并，删掉蛇形进度图。
8. **正文只有一种格式：纯文本。** Markdown 只用于 AI 交换与文档；正文里出现 Markdown 语法即格式错误（同时也是 AI 味）。

---

## 1. 产品模型

作者的真实动作只有四个：**读、写、看意见、批准**。

```
┌──────────────────────────────────────────────────────────────┐
│  正文页（后台主页）                                            │
│  ┌────────┬────────────────────────────────┬───────────────┐ │
│  │ 目录    │  全文（连续滚动）                │ 右栏           │ │
│  │ 1 … 40  │  阅读模式  ⇄  编辑模式  ⇄ 读者   │ 批注 / 审阅 /  │ │
│  │ 状态/分 │  章间分隔、阅读位置记忆、全文搜索  │ 提案 / 本章操作 │ │
│  └────────┴────────────────────────────────┴───────────────┘ │
└──────────────────────────────────────────────────────────────┘
        │读完一章                     │选中一段
        ▼                            ▼
 [审阅本章] / [读者模式]          批注 → Review(source=reader)
        │
        ▼
┌─────────────────────┐   勾选 →「发给 AI 改」   ┌────────────────────┐
│ 审阅收件箱（唯一队列） │ ────────────────────▶ │ 提案批次（待批准）    │
│ 逻辑事实/注意力/去AI/用户│                       │ 逐条：批准/驳回/改   │
└─────────────────────┘                        └─────────┬──────────┘
                                                         │批准
                                              ┌──────────▼──────────┐
                                              │ 闸门写入 → 标记已处理 │
                                              │ 复测（注意力/去 AI）  │
                                              └─────────────────────┘

旁路：正文页顶部「全文动作」——重写 / 扩写 / 改写，一个进度面板。
```

AI 视角只有三件事：**读上下文、交审阅、交提案**。

---

## 2. 核心对象

| 对象 | 文件 | 职责 | 备注 |
|---|---|---|---|
| **Chapter**（章） | `chapters/*.txt` + `*.meta.json` | 正文与章级生命周期 | 纯文本正文；新增 `gate` 字段 |
| **Review**（审阅条目） | `reviews.json` | **四路审阅 + 读者批注的唯一载体** | 替代 reviews + decision + 用户意见箱 |
| **Attention**（注意力投影） | `attention.json` | 设计分/实测分/四拍/历史 | 只做量化 |
| **Proposal**（提案） | `proposals.json` | 一条可批准/驳回的改动 | 3 种 action |
| **Batch**（批次） | `proposals.json` | 一次"发给 AI 改"的产物集合 | 一个批次 = 一次审阅会话 |
| **Run**（全文动作实例） | `run.json` | 重写/扩写/改写 的一次执行 | 替代三套单例 |
| **Ledger**（账本） | `facts.json` 等 | 事实、人物、时间线、世界、地点、伏笔、冲突、高光、大纲 | **0.6 不改结构** |

---

## 3. 正文页（本版重点）

### 3.1 布局

- **三栏**：目录 260px ｜ 正文（自适应，最大 720px 阅读宽度）｜ 右栏 320px（可折叠）。窄屏（<1100px）折叠右栏，窄屏（<860px）抽屉化目录。
- 顶部条：书名 · 当前章 · 字数 · [阅读 | 编辑 | 读者] 切换 · 全文搜索 · 全文动作入口。
- 阅读与编辑**共享滚动位置**，切换模式不丢位置、不丢未保存内容。

### 3.2 目录（左栏）

- 每章一行：章号、标题、字数、状态点（draft/written/reviewed/revised/done）、注意力分徽标（未打分显示 `—`）。
- 当前章高亮；`↑/↓` 或 `j/k` 上下翻章；点标题跳章。
- 顶部：作品切换、章节搜索（按标题）、新建章。
- 目录是全书的**唯一进度视图**（替代已删除的「章节地图」）。

### 3.3 阅读模式（默认）

- **全本连续滚动**：一次渲染相邻章（当前 ± 2 章），滚动到底自动续载，几万字长篇也不卡。
- 章间分隔条：章号 · 标题 · 字数 · 状态；点击进入本章操作。
- 排版：字号（14–22px）、行距、栏宽、主题（纸色/夜间/纯白），偏好存本地。
- 阅读位置记忆：`readingPosition = { chapter, offset }` 存项目元数据，下次打开回到原位。
- 键盘：`j/k` 翻章，`空格/Shift+空格` 翻页，`/` 搜索，`Esc` 关搜索。
- 章末：`[审阅本章] [读者模式] [标记完成]`——只有这一组动作。
- 全文搜索：服务端 `chapter.search`（见 §12），命中定位到章 + 偏移并高亮；不把全库正文喂给前端。

### 3.4 编辑模式（简单编辑器）

- 单章纯文本 `.txt`（不是富文本、也不是 Markdown；不做所见即所得，避免引入编辑器依赖）。
- 工具栏：保存状态、字数、状态、字号、`Ctrl/Cmd+S`、查找替换、版本历史。
- 自动保存：内容变化后 **2 秒防抖**（0.5.2 是 5 秒且只在弹窗里）；顶部显示「已保存 hh:mm」。
- 版本历史：复用现有 chapter history（diff 视图 + 回滚），保留"内容变化才备份"的规则。
- 从阅读切到编辑：光标定位到当前阅读位置对应的章。
- 编辑器是**页内视图**，不再是弹窗——这是 0.5.2「找不到看全文入口」的直接修复。

### 3.5 读者模式

- 只读渲染 + 选中文本批注：选中 → 浮出「加批注」→ 填写问题/建议 → 生成 `Review(source='reader', quote=选中文本, status='open')`。
- 批注列表在右栏，可按章筛选；本人可编辑/删除未处理的批注。
- **不触发任何正文修改**；读者模式可以生成只读分享链接（`/novel-desk/view/read?projectId=…&chapter=…`），供他人在浏览器里读并提意见（可选，0.6.1）。
- 「读者先看」= 切换到读者模式并标记 `gate.readerReadAt`。

### 3.6 右栏

- **本章**：状态、字数、注意力分（设计/实测）、最近一次审阅摘要。
- **批注**：本章 reader 意见列表（可跳转到原文位置）。
- **审阅**：四路审阅状态（未审 / 已审 N 条 / 处理中），一键「审阅本章」。
- **提案**：影响本章的待批准提案（点开直接看 diff）。
- **AI**：`续写本章` / `重写本章` 两个按钮——产物一律进提案批次，**不直接改正文**。

### 3.7 正文格式：纯文本（.txt），Markdown 只做交换格式

正文的存储、编辑、阅读、闸门、AI 契约统一按纯文本执行。

**为什么**
- 人读的是段落，不是语法。中文长篇正文里的 `**`、`###`、`---`、`>`、列表符号，对读者是噪音，对作者是干扰。
- 这些符号本身就是 AI 味特征——现有 `lib/aistyle.js` 的 `MARKDOWN_ARTIFACTS` 已把 19 类 md 残留列为 AI 味检测项。一边把正文存成 `.md`、一边把 md 残留当 AI 味，是自相矛盾的。
- 存成纯文本后，闸门才能从"提示"升级为"拒绝"：AI 交来的正文带 Markdown 语法就不能落盘，AI 下一轮也只能模仿纯文本。

**存储**
- 正文：`projects/<id>/chapters/NNNN.txt`，只含正文，UTF-8，段落之间空一行；**不写 frontmatter、不写章号标题**（标题在元数据里）。
- 元数据：`chapters/NNNN.meta.json`：title / status / summary / location / storyTime / characters / gate / contentHash。0.5.2 的 frontmatter 字段全部搬到这里。
- 场景分隔：空行 + 一个普通符号行（`※` 或 `◇`），不用 `---`；首行缩进是**显示样式**（阅读时缩进 2 字符），不写进文本。

**编辑器**：纯 textarea，显示即纯文本，无工具栏、无语法高亮；粘贴带 md 的内容时提示"将转为纯文本"（0.6.1 可加一键清理）。

**阅读器**：按空行分段渲染，首行缩进 2 字，不做任何 Markdown 解析（避免把 `*` 当强调、把 `#` 当标题）。

**AI 交换**：审阅条目、提案 payload、工作单仍然用 JSON / Markdown（模型友好）；但**正文字段必须是纯文本**。prompt 里写死"正文纯文本、禁止 Markdown 语法、场景分隔用 ※"；入站的正文一律过 §3.8 的 `normalizeProse`（确定性清洗 + 留痕），规范化后仍有残留 → 提案 `needs-fix`，不落盘。

**导入/导出**：导入 md/docx/txt 统一转纯文本（去 frontmatter、去 md 标记、保留段落），导入预览展示转换结果；导出默认 `.txt` / `.docx`（读者向），`.md` 只在"给 AI 看 / 发布到支持 md 的平台"时显式选择。

**迁移**：见 §10.2。正文里的 md 残留**不自动删除**（可能是有意的强调），迁移时扫描成 `source=ai-style` 的审阅条目，由作者决定是否生成清理提案。

### 3.8 转换器：一个 `lib/prose.js`，只做入站规范化

```
AI 输出（可能带 Markdown） ── normalizeProse ──▶ 纯文本正文（落盘 + 留痕）
导出 / 发布               ── toMarkdown     ──▶ Markdown（唯一用到 md 的地方）
```

**为什么不是双向对等转换**
- 出站（发 prompt）**不需要**转 Markdown：纯文本模型照读，加 `**` 只是噪音；上下文块用分隔标记（`<<<正文>>>`）而不是 Markdown 格式。
- 入站（收正文）**必须**洗：模型有惯性在散文里塞 `**`、`###`、`---`、`>`、列表符。
- 所以只有一个方向的"规范化"；反向只用于导出，且不试图还原强调——正文里本来没有强调语义。

**`normalizeProse(text)` → `{ text, removed, needsFix }`（幂等）**

| 输入 | 处理 |
|---|---|
| 开头 `---…---` frontmatter | 删除 |
| 代码围栏 ``` | 去围栏保留内文（计入 `removed.fence`） |
| 行首 `#{1,6}` 标题 | 去标记保留文字 |
| `**x**` `__x__` `*x*` `_x_` `~~x~~` | 去标记保留 x |
| 行内 `` `x` `` | 去反引号 |
| 行首 `> ` 引用、`- ` `* ` `+ ` `1. ` 列表 | 去标记保留内容 |
| `---` `***` `___` 独占行 | 换成场景分隔 `※` |
| `[文字](url)` / `![alt](url)` / `<tag>` | 留文字 / 删 / 删 |
| 3+ 连续空行、行尾空格 | 归一为一个空行 / 去尾 |
| 表格 `\|…\|`、未闭合标记、代码块内多段正文 | **不自动处理** → `needsFix` |

**调用点（只在"要落盘成正文"的地方）**
1. `propose` / `run` 生成正文时——**提案生成时就规范化**，作者看到的 diff 已是纯文本；
2. `writeChapterWithGates` 写入前再规范化一次（防御性，幂等）；
3. 导入时（md / docx / txt → 纯文本）。
**不在**：发送 prompt 时、作者手改时、审阅与提案里的非正文字段（那些本来就用 JSON / Markdown）。

**留痕**：闸门记录 `gates.prose = { normalized: true, removed: {bold: 12, hr: 3, …} }`；提案页显示"已规范化 N 处 Markdown"；`needsFix` 时提案 `needs-fix`、正文不落盘。

**绝不动的字符**：`「」『』`、`……`、`——`、全角 `＊`、数字、专名——只处理确定安全的 Markdown 标记。

**`toMarkdown(text)`**（仅导出）：段落空行分隔，场景分隔 `※` → `***`，不加任何强调。

**测试**：fixtures 覆盖中文标点/对话/场景分隔/链接/表格；断言幂等（`normalizeProse(normalizeProse(x)) === normalizeProse(x)`）；断言 `toMarkdown` 只加段落与 `***`。

---

## 4. 其他页面（7 个）

| # | 页面 | 职责 | 主要动作 |
|---|---|---|---|
| 1 | **正文** | 目录 + 阅读/编辑/读者 + 右栏 | 读、写、批注、审阅本章 |
| 2 | **审阅收件箱** | 四路同权队列 | 筛选、勾选、发给 AI 改、否决 |
| 3 | **提案批次** | 待批准提案 | 逐条批准/驳回/改；diff |
| 4 | **全文动作** | 重写/扩写/改写 | 发起、暂停、看进度与结果 |
| 5 | **世界地图** | 世界模型 + 地点 + 地点关联章 | 增删改查、定位 |
| 6 | **账本** | 人物/时间线/事实/伏笔/冲突/高光/大纲 | 增删改查、版本回滚 |
| 7 | **总览** | 统计、注意力曲线、闸门健康度 | 只读 |
| 8 | **设置** | 预设、导出、成本、数据目录 | 配置 |

侧栏分组：**正文**（1）· **审阅**（2/3/4）· **资料**（5/6）· **系统**（7/8）。

**地图合并说明**：0.5.2 有「世界」（世界模型 + 地点）与「地图」（章节蛇形进度图）两页。章节地图不提供定位、不能操作、信息与目录重复，删除；世界地图保留并吸收"地点 ↔ 章"的关联展示。全书进度改由目录状态点与总览曲线承担。

页面数量目标：**8**（0.5.2 实际 24）。

---

## 5. 数据模型

### 5.1 Review —— 四路同权

```jsonc
{
  "id": "rv_...",
  "chapter": 12,
  "source": "logic",            // logic | attention | ai-style | reader
  "dimension": "事实",          // logic: 事实/连续性/时间线/人物/因果/节奏;
                                // attention: 钩子/张力/回报/章末牵引;
                                // ai-style: 套话/句式/形容/对话;
                                // reader: 任意（作者自定义标签）
  "severity": "major",          // blocker | major | minor | suggestion
  "quote": "原文逐字片段",
  "issue": "问题是什么",
  "suggestion": "怎么改（可执行）",
  "evidence": {},               // 可选：注意力分数 / 去 AI 指标 / 事实引用
  "status": "open",             // open | selected | proposed | done | dismissed
  "batchId": null,
  "proposalIds": [],
  "origin": "ai",               // ai | human | import
  "createdAt": "...", "updatedAt": "..."
}
```

- **同权**：`source` 只用于筛选与展示，**不参与排序、不加权、不影响能否生成提案**。排序一律 `severity → chapter → 时间`。
- **去重**：AI 条目按 `chapter + source + dimension + 归一化 issue` 去重；`reader` 条目不去重（重复强调是信号）。
- **读者容器**：读者模式的批注就是 `source=reader` 的 Review，只读状态产生，不触发修改；作者勾选后才能发给 AI。
- **生命周期**：`open → selected → proposed → done | dismissed`；`dismissed` 永久不再出现（修掉 wontfix 被 reconcile 复活）。
- **证据分离**：分数不进 Review，放 `evidence` 引用；量化在 attention.json。

### 5.2 Attention —— 只做量化投影

```jsonc
{
  "chapter": 12,
  "design":  { "type": "mystery", "hook": 8, "tension": 7, "payoff": 7, "cliff": 8, "score": 30 },
  "measured": { "score": 26, "at": "...", "by": "ai" },
  "history": [ { "from": 26, "to": 30, "delta": 4, "at": "...", "by": "fix" } ],
  "scoredHash": "…"
}
```

- 删除字段：`recheckPending / recheckRequestedAt / lastFixAt / fixPlan / fixLog / lastRecheckDelta / status`（改由 Review 状态承载）。
- 保留 `history + scoredHash`：复测不透露旧分、正文变化才允许重打分。
- 注意力审阅 = 收件箱里 `source=attention` 的 Review，**不再有独立提分工具链**；提分只走 `patch-paragraph` 提案。
- 阈值单源：`25/13/88/20` 只在 `lib/attention.js` 定义一次。

### 5.3 Proposal —— 三种 action

```jsonc
{
  "id": "pp_...",
  "batchId": "bt_...",
  "action": "patch-paragraph",  // patch-paragraph | rewrite-chapter | ledger-fix
  "chapter": 12,
  "title": "第 12 章 · 开篇补钩子",
  "summary": "一句话说清改什么",
  "reviewIds": ["rv_1", "rv_2"],
  "payload": {
    "patches": [ { "before": "逐字原文 4–600 字", "after": "替换文本", "why": "…" } ]
    // rewrite-chapter: payload.content
    // ledger-fix: payload = { kind, items: [...] }
  },
  "status": "pending",               // pending | accepted | rejected | stale
  "gates": {},
  "createdAt": "...", "decidedAt": "..."
}
```

- **禁止**再出现 `custom / decision / attention / attention-fix / world / locations / plan` 七种 kind（映射见 §10）。
- **批次**：一次"发给 AI 改"= 一个 batchId；批次页默认逐条批准；仅 `patch-paragraph` 且无 blocker 时才允许「全部批准安全项」。
- **过期**：生成时记录章节 `contentHash`；批准时正文已变 → `stale`，必须重新生成。
- **追溯**：每条提案必须有 `reviewIds`；没有来源的提案不允许进批次。

### 5.4 Run —— 全文动作一个实例

```jsonc
{
  "id": "run_...",
  "action": "rewrite",             // rewrite | expand | rephrase
  "scope": "chapters",             // book | chapters
  "chapters": [1, 2, 3],
  "status": "running",             // planning | ready | running | paused | done | aborted | stuck
  "plan": {},
  "progress": { "done": 4, "total": 12, "current": 5 },
  "budget": { "maxTokens": 0, "maxCostCNY": 0, "usedTokens": 0, "usedCostCNY": 0 },
  "sessionId": "...",
  "notes": [],
  "createdAt": "...", "updatedAt": "..."
}
```

- `rephrase` 内部三级：L1 文风 / L2 结构 / L3 价值观（沿用现有 `revisionGatePolicy` 与 `REVISION_STOP_MODES`）。
- 预算真实结算：每次 advance 结算 `usedTokens/usedCostCNY`，超限自动 pause（修复 0.5.2 预算恒 0）。
- 取消 pipeline/expansion/revision 三套状态机与三套 UI 面板。

### 5.5 Chapter 生命周期

```jsonc
{ "id": "…", "index": 12, "title": "…", "status": "written" }
// status: draft | written 已写完待审 | reviewed 已审 | revised 已按提案改 | done 定稿
// 附加: gate: { writtenAt, reviewedAt, readerReadAt, proposalsAppliedAt }
```

---

## 6. 状态机

```
Review:    open ──勾选──▶ selected ──生成批次──▶ proposed ──采纳+复测──▶ done
              │                                     └────作者否决────▶ dismissed
Proposal:  pending ──批准──▶ accepted ──闸门通过──▶ 写入
              ├──驳回──▶ rejected
              └──正文变化──▶ stale
Run:       planning ─▶ ready ─▶ running ─┬─▶ done
                                   ├─▶ paused ─▶ running
                                   ├─▶ aborted
                                   └─▶ stuck
Chapter:   draft ─▶ written ─▶ reviewed ─▶ revised ─▶ done
```

状态流转只允许在 `lib/store.js` 的 `advanceReview / advanceProposal / advanceRun / advanceChapter` 里发生，前端不手写状态。

---

## 7. 四路审阅的服务端契约

| 来源 | 触发 | 产出 | 约束 |
|---|---|---|---|
| `logic` | 审阅本章 / 全文审阅 | Review(dimension=事实/连续性/…) | 复用 `checks` 结果作为提示，不落盘 |
| `attention` | 同上 | Review(dimension=钩子/张力/…) + attention.json 实测分 | 复测不透露旧分；正文变了才重打 |
| `ai-style` | 同上 | Review(dimension=套话/句式/…) + evidence.metrics | 隔离沙箱 + 零上下文；**只产审阅，不产提案**；逐字 quote |
| `reader` | 读者模式批注 / 导入外部意见 | Review(source=reader) | 不触发修改；不去重 |

**去 AI 审的硬约束（保留）**：`REVIEW_ISOLATION_LINES` 沙箱会话、隔离工作区、`quote` 逐字命中正文 ≥4 字、只产审阅。
**必须修的 0.5.2 bug**：deai 审阅缺 `dimension`，被默认成「首读」后经 `patchDimensions` 并入注意力补丁——0.6 起固定 `dimension='ai-style'`。

---

## 8. 写入闸门（唯一写正文路径）

```
作者在正文页编辑 ──▶ chapter.save（备份 + 版本，无 AI 闸门）
AI 来源（提案/run）──▶ writeChapterWithGates：
     0. 正文规范化 normalizeProse（§3.8；记录 removed；needsFix → needs-fix，不落盘）
     1. 保真闸门 evaluateFidelity（不改事实/数字/专名）
     2. 纯文本校验（规范化后仍有 Markdown 残留 → needs-fix）
     3. 去 AI 味 auditAiStyle（高于阈值 → needs-fix，不落盘）
     4. 章级备份 + 注意力变更提示
     任一门失败 → 提案 needs-fix / run 暂停，不静默写入
```

0.5.2 只有 `revision.applyChapter` 过闸门，而核心写作流（提案采纳、pipeline 自动采纳）零闸门——0.6 全部收口到这一个函数。

---

## 9. 工具面（14 → 6）

| 工具 | 用途 | 主要 op |
|---|---|---|
| `novel_desk_read` | 读一切：作品/上下文/工作单/收件箱/提案/run 状态 | `context` `plan` `inbox` `proposals` `run` |
| `novel_desk_review` | 交审阅（四路） | `write` `list` `decide` `deai`（隔离） |
| `novel_desk_attention` | 注意力量化 | `record` `report` |
| `novel_desk_propose` | 交提案/批次 | `batch` `create` |
| `novel_desk_upsert` | 账本直写（不含正文/审阅/注意力） | `ledger` |
| `novel_desk_run` | 全文动作 | `plan` `start` `stage` `finish` `stuck` |

删除 8 个：`projects / bundle / align / context / plan / proposal / attention_fix / revision / pipeline / expansion`。

**工具不变式**：任何工具都不能直接写正文；`upsert` 的 schema 里不出现 `content`。

---

## 10. 迁移（0.5.2 → 0.6.0）

### 10.1 提案 kind → action

| 0.5.2 kind | 0.6 action | 处理 |
|---|---|---|
| `chapter` | `rewrite-chapter` | 直接映射 |
| `attention-fix` | `patch-paragraph` | payload.patches 原样保留 |
| `plan` / `attention` / `world` / `locations` / `outlines` / `conflicts` | — | 迁成账本变更或归档 |
| `decision` | — | 拆成 Review + `ledger-fix` |
| `custom` | — | 丢弃（本来就是空操作） |

### 10.2 其他

- **正文文件 `.md` → `.txt`**：`serializeChapter` 的 frontmatter 拆到 `NNNN.meta.json`，正文写 `NNNN.txt`；`listChapters / backupChapterFile / restore / snapshot / importer / exporters / history` 同步改；原文里的 Markdown 残留扫描成 `source=ai-style` 审阅条目（不自动改字）。
- `reviews.json`：`origin` 归一为 `ai|human|import`；旧 `dimension='首读'` 且 deai → `source=ai-style`；补 `source` 字段（按 dimension 归类）。
- `attention.json`：删除 §5.2 的 7 个状态字段，保留 `history`。
- `pipeline.json / expansion.json / revision.json` → 生成一条 `run.json` + 归档到 `legacy/`，只读保留一个版本。
- 新增 `readingPosition` 到项目元数据（书/章/偏移）。
- 迁移必须**幂等**：写 `schemaVersion: '0.6.0'`，重复跑结果一致；迁移前整库备份 `.pre-0.6.0/`。
- 删除 `/novel-desk/view/map` 路由与 `renderChapterMapHtml`；保留 `world`/`timeline`/`attention` 只读视图，新增 `read` 只读阅读视图（0.6.1 分享用）。

---

## 11. 网页式后台（独立窗口 = 主形态）

### 11.1 现状与可行性（已核）

- 宿主已通过 `ctx.inject(['webServer'])` 注册路由：`/novel-desk/api`（POST RPC）与 `/novel-desk/view/*`（只读 HTML），入口 `index.js:4345 mountRoute()`。
- `guard()`（`index.js:69-86`）对回环 + 同源请求放行；实测 `curl /novel-desk/api/ping` 返回 200，而 `GET /` 才要 token——插件路由不依赖 GUI 登录地址。
- 客户端 `api()` 用相对路径 `/novel-desk/api`（`client.js:78`），同源页面可直接复用；只依赖 4 个可选 DSH 服务（`uiWorkspace`/`sessions`，全部可选链）。
- 结论：**可以做成独立网页后台**，改动集中在"壳"，业务代码不动。

### 11.2 打开方式与形态

- 从 DSH 侧栏/命令 `window.open('/novel-desk/app?projectId=…&view=read&chapter=n', 'novel-desk', 'popup,width=1500,height=960')`。
- 独立窗口默认落在 **正文·阅读**（上次阅读位置），顶部条可切换到其他页。
- 窗口关闭后不丢状态（阅读位置、未保存草稿提示）。
- **关 DSH 自动关**：页面每 5s `GET /novel-desk/api/ping`；连续 2 次失败 → 覆盖层「DSH 已退出」+ `window.close()`（仅脚本打开的窗口可被脚本关闭；手输地址退化为提示层）。
- 端口跟随 `location.origin`，不写死 64615。

### 11.3 实现路线

**B. 宿主 shim 复用现有 UI（先做，1–2 天量级）**

1. 宿主新增 `/novel-desk/app` 路由，返回 HTML 壳：vendor 的 `react`/`react-dom` UMD + `/novel-desk/app/shim.js` + 现有 `client.js`。
2. shim 实现 `window.__ModuleLoader__.load`，`require('react')` 返回 vendor React；伪造 `ctx.slots`（收集组件）、`ctx.effect`、`ctx.get`（undefined）；`apply(ctx)` 后把 `Workbench` 挂到 `#root`。
3. 先按新信息架构改造 `client.js` 的导航与正文页（见 §3、§4），再接入 shim。

**A. 独立前端（目标形态）**

- 抽 `lib/viewmodel.js`（纯函数：收件箱派生、批次、进度、统计），两个壳共享；独立页壳逐步摆脱 React 与 DSH。

### 11.4 限制与风险

- 手动打开的标签页不能被脚本关闭 → 用弹窗方式打开。
- DSH 退出后端口释放，需重新 `dsh web` 才能重连。
- 独立页与 GUI 共享数据目录与 API，**不新增端口、不新增鉴权面**；仍只监听回环。
- 若 DSH 改变 `webServer.register` 约定，B 方案会退化；A 方案不受影响。

---

## 12. 删除清单（一次性，不分阶段）

**页面/入口**：`AiDialog`（`client.js:5122`，从未渲染）、`onAskAi` 断链入口、仪表盘（并入总览）、版本页（并入账本历史）、审稿页与审阅面板二合一、三套 run 面板、设置并入预设、**「章节」列表页（被正文页目录取代）**、**「地图」页（并入世界地图）**、**「读者模式」独立页（并入正文页）**。

**工具**：见 §9 删 8 个。

**RPC**：`pipeline.*`(11) / `expansion.*`(10) / `revision.*`(9) → `run.*`(5)；`snapshot.*`(8) → 账本历史(3)；新增 `chapter.search`；删 19 个客户端零调用的孤儿 RPC；合计 87 → **约 31**。

**代码**：`renderChapterMapHtml` + view 路由 `map`、`serializeChapter` 的 frontmatter 拼装与 `stripChapterFrontmatter`（迁完即删）、`estimatePipeline` / `estimateExpansion`、`patchRows` 5 处手写状态流转、清单 15 处字面量、`PROPOSAL_KIND` 4 套词表、`AI_TASKS`/`TASK_LABEL` 3 套、attention 4 份打分实现、deai 维度 3 套词表。

**文档**：11 篇 → 6 篇（README、DESIGN-0.6.0、ATTENTION、REVIEW、RUN、DATA）；删 `docs/v0.4-CONTRACT.md`；CHANGELOG 三个 Unreleased 合一；HANDOVER 工具表由脚本重生成。

**测试**：删提示词整段字符串断言（3 处）+ 死代码测试；补：四路同权、收件箱→批次→批准→闸门、阅读位置、全文搜索、迁移幂等、状态机单点。

---

## 13. 验收标准（可测）

1. 打开后台 **默认看到正文连续阅读**（第 1 章起），任意章 ≤1 次点击开始编辑。
2. 读完全书不需要打开任何弹窗；目录、搜索、阅读位置可用。
3. 选中文本可加批注（`source=reader`），批注进入收件箱且不改正文。
4. 全文搜索命中可定位到章与偏移。
5. 从"写完一章"到"提案批次页可见"≤ 3 次点击。
6. 收件箱四个来源并列、同权重；任一来源都能单独生成提案。
7. 所有 AI 来源正文写入 100% 经过 §8 闸门。
8. 提案批准后 100% 有落点；`stale` 不会静默套用。
9. 工具 = 6；RPC ≤ 32；页面 = 8（含正文）；地图页面 = 1；导航分组 = 4。
10. 迁移幂等；旧数据只读兼容一个版本。
11. 关闭 DSH：独立窗口 10s 内自动关闭（脚本打开场景）。
12. 正文文件为 `.txt`、无 frontmatter；阅读视图不渲染 Markdown；AI 写入的正文先过 `normalizeProse`，规范化后仍有残留 → `needs-fix` 不落盘，`gates.prose.removed` 有记录。
13. 导入 md/docx 后正文为纯文本；导出默认 `.txt` / `.docx`。
14. `normalizeProse` 幂等（`f(f(x)) === f(x)`）；发送 prompt 的代码路径**不**调用规范化（断言）；`toMarkdown` 只用于导出。
15. 提案生成时正文已规范化：作者在提案 diff 里看不到 `**` / `###` / `---`。

---

## 14. 不做 / 冻结

- **事实与逻辑模块**：facts / 时间线 / 世界 / 地点 / checks 结构与规则**不动**，只把输出接进收件箱。
- **注意力**：不新增维度、不扩字段；只恢复「设计分 + 实测分 + 历史」。
- **12 Agent 分工**：保留文案与权重，不作为执行分流依据。
- **不做 Markdown 正文、不做富文本**：正文唯一格式是纯文本 `.txt`；Markdown 只用于 AI 交换与文档；编辑器保持纯 textarea，语法高亮 0.6.1 再评估。
- **不引入构建步骤、不新增依赖**：独立页 B 方案用 vendor 单文件。
- **不做多用户/远程访问**：只监听回环。

---

## 15. 落地顺序（一次性清单）

1. 抽 `lib/viewmodel.js` + 数据迁移脚本（幂等）+ reviews 统一（四路 source）。
2. **正文页 + 格式迁移**：`lib/prose.js`（`normalizeProse` / `toMarkdown`）→ `.md`→`.txt`+`meta.json` 迁移 → 目录 + 全本连续阅读 + 编辑模式 + 读者批注 + 全文搜索（`chapter.search`）。
3. 收件箱 + 提案批次页（跑通整条直线）。
4. 全文动作合并为 `run.json` + 统一闸门 `writeChapterWithGates`。
5. 删除章节列表页/地图页/AiDialog 等旧入口；世界地图合并。
6. 独立窗口：B 方案 shim → 默认落「正文·阅读」。
7. 删工具/RPC/文档，跑验收 §13，更新 README 与 CHANGELOG。

---

_本设计稿为讨论稿：确认后据此实施；有异议先改本文件，再动代码。_
