# 版本对齐（Version Alignment）

> 状态：**已实现**（见 CHANGELOG `[Unreleased]`，测试 `test/alignment-version.test.js` / `test/align-prompt.test.js`）。本文是**实现契约**，前端 / 宿主 / 数据层都按这里对齐，不要自行改字段名。

## 为什么

「对齐」原来只比**字数**（计划章数/字数 vs 实际）。但作者真正需要知道的是：**正文改到第几版了，人物、物品（事实）、高光、地图、时间线这些账本各自停在第几版，哪里没跟上。**

所以对齐页改成**版本对齐**：

- 稿本（总稿）有一个递增的**版本号**；
- 每个账本记录「最近一次改动发生在稿本的哪个版本」「最近一次确认对齐到哪个版本」；
- 页面上直接显示：稿本 v12｜人物 v9（落后 3 版）｜时间线 未追踪｜高光 v12 已对齐……
- 落后的账本可以**一键加入清单**，交给 AI 按落后章节补齐（AI 产出仍然是提案，作者采纳后才进账本）；
- 字数/计划进度降级为折叠区，不再是对齐页的主角。

这不是"每次改完自动改账本"：自动改账本会消耗 token、且可能改错。我们做的是**每次改动后自动记账 + 随时看到落差 + 一个按钮把落后的补齐**。

## 数据字段（project.json）

旧数据没有这两个字段也能正常读写；第一次写正文时自动开始记账。

```json
{
  "draft": {
    "version": 12,
    "updatedAt": "2026-10-24T09:01:56.000Z",
    "log": [
      { "version": 10, "at": "...", "kind": "chapter-save", "chapter": 3, "title": "第三章 夜行", "note": "" },
      { "version": 11, "at": "...", "kind": "chapter-delete", "chapter": 7, "title": "", "note": "" },
      { "version": 12, "at": "...", "kind": "external-change", "chapter": 5, "title": "第五章", "note": "检测到外部改动" }
    ]
  },
  "ledgerSync": {
    "characters": { "touchedVersion": 10, "touchedAt": "...", "alignedVersion": 9, "alignedAt": "...", "note": "" },
    "events": { "touchedVersion": null, "touchedAt": null, "alignedVersion": null, "alignedAt": null, "note": "" }
  }
}
```

- `draft.version`：整数，从 0 开始；**正文类变化 +1**。变化来源 `kind`：
  `chapter-create` / `chapter-save` / `chapter-delete` / `chapter-import`（导入按章记）/ `snapshot-restore` / `external-change`（检测到文件被外部改）。
- `draft.log`：最近 100 条，先进先出；每条含 `version`、`at`、`kind`、`chapter`（可空）、`title`、`note`。
- `ledgerSync[kind]`：`ALIGN_KINDS` 里的每个账本一条（见下）。`alignedVersion === null` 表示**未追踪/从未对齐**。
- 账本写入（`upsertEntity` / `deleteEntity` / `saveWorld` / 决策提案改事实）时，自动把该 kind 的 `touchedVersion` 记为当前稿本版本。

## 对齐的域（ALIGN_DOMAINS）

| id | 标签 | 覆盖 kind | 跳转页签 |
|---|---|---|---|
| characters | 人物 | characters | characters |
| facts | 事实账本（物品 / 设定） | facts | facts |
| events | 时间线 | events | timeline |
| locations | 地图 / 地点 | locations | map |
| world | 世界设定 | world | world |
| highlights | 高光 | highlights | highlights |
| foreshadow | 伏笔 | foreshadow | foreshadow |
| conflicts | 冲突 | conflicts | conflicts |
| attention | 注意力 | attention | attention |
| outlines | 章节大纲 | outlines | chapters |

`ALIGN_KINDS` = 上表 kind 的并集（10 个）。`presets` / `reviews` / `proposals` / `agents` 不参与版本对齐。

## 域状态（status）

优先级从上到下：

| status | 条件 | 页面文案 |
|---|---|---|
| `idle` | 没有正文且稿本版本为 0 | 未开始 |
| `untracked` | `alignedVersion === null` 且稿本版本 > 0 | 未追踪（需要一次全量对齐） |
| `behind` | `alignedVersion < draft.version` | 落后 N 版 |
| `pending` | 该域有 pending 提案 | 待验收 |
| `aligned` | 其它 | 已对齐 |

附加信息：`dirty`（对齐之后账本又被改过：`touchedVersion > alignedVersion`）、`pendingProposals`、`changedChapters`、`gaps`。

## 缺口（gaps，回答"哪里没对齐"）

不只看版本号，还看覆盖度（确定性计算，不花 token），每域最多 3 条：

- 注意力 / 大纲 / 高光 / 事件 / 事实：已写章节里缺记录的章号（聚合一条，gap id = `<kind>-missing`，如 `highlights-missing`）；
- 人物：正文 `characters` 引用了、但人物卡里没有的名字（gap id `characters-missing`）；
- 地点：章节 `location` 填了、但地点账本里没登记的名字（gap id `locations-missing`）；
- 世界：`world.json` 尚未创建（gap id `world-missing`）；
- 伏笔 / 冲突：只看版本，不算覆盖缺口。

## 模块与函数（lib/alignment.js，纯函数）

```js
export const DRAFT_LOG_LIMIT = 100
export const ALIGN_KINDS = ['characters','facts','events','locations','world','highlights','foreshadow','conflicts','attention','outlines']
export const ALIGN_DOMAINS = [{ id, label, icon, tab, kinds, proposalKinds }]
export const ALIGN_STATUS_LABEL = { idle, untracked, behind, pending, aligned }

export function getDraftState(project)     // → { version, updatedAt, log: [{version,at,kind,chapter,title,note}] }
export function getLedgerSync(project)     // → { [kind]: { touchedVersion, touchedAt, alignedVersion, alignedAt, note } }
export function bumpDraft(project, change) // 变更 project.draft，返回新 log entry
export function touchLedgerKinds(project, kinds, at) // 变更 project.ledgerSync，返回实际变动的 kinds
export function markLedgerKindsAligned(project, kinds, { version, note, at }) // 同上，返回 kinds
export function computeVersionAlignment(bundle) // → report（见下）
export function formatVersionAlignment(report)  // → Markdown 文本（工具 / bundle 输出用）
```

`bumpDraft` / `touchLedgerKinds` / `markLedgerKindsAligned` 直接改传入的 `project` 对象（store 读完 project 再写回），不读写文件。

### report 形状（`computeVersionAlignment`）

```js
{
  manuscript: { version, updatedAt, chapters, words },
  domains: [{
    id, label, icon, tab, kinds, proposalKinds,
    version,            // 该域当前对齐版本（int | null）
    alignedVersion,     // 同 version（兼容命名）
    alignedAt,          // 最近对齐时间（ISO | null）
    touchedVersion,     // 账本最近改动时的稿本版本（int | null）
    touchedAt, note,
    status,             // idle | untracked | behind | pending | aligned
    behind,             // 落后版数（alignedVersion === null 时为 null）
    dirty,              // boolean
    pendingProposals,   // 该域 pending 提案数
    changedChapters: [{ id, title }],  // 对齐之后有改动的章节（按章号升序）
    changes: [{ version, at, kind, chapter, title }], // 最近 12 条版本记录，升序（旧→新）
    gaps: [{ id, label, chapters: [int] }],
    gapCount,
    empty                // boolean：该域账本是否为空
  }],
  summary: { version, total, aligned, behind, untracked, pending, idle, gaps, needsAlign },
  log: [{ version, at, kind, chapter, title, note }]  // 最近 12 条，倒序（新→旧）
}
```

`needsAlign` = `behind + untracked > 0`。

## store 新增导出（lib/store.js）

```js
export async function ensureDraftCurrent(root, projectId)
// 用章节文件 mtime 对比 draft.updatedAt：
//  - 老数据没有 draft：有正文就记一条 kind='baseline'（version=1），否则不动；
//  - 有章节 mtime 晚于 draft.updatedAt：逐章 bump（kind='external-change'）；
// → { version, changed: [{chapter,title}], baseline: boolean }
export async function markLedgersAligned(root, projectId, kinds, { version, note })
// 把 kinds 的 alignedVersion 记成 version（缺省 = 当前稿本版本）→ { version, kinds }
export async function markSnapshotRestored(root, projectId, note)
// 整本回滚后调用：bump 一条 snapshot-restore，并把全部 ALIGN_KINDS 标记为已对齐
export async function markLedgerTouched(root, projectId, kinds)
// 外部改账本（如 ledger.restore）后调用：touchedVersion = 当前稿本版本
```

写入钩子（已实现，不要绕过）：

- `saveChapter`：内容/元数据变化才 bump（`chapter-create` / `chapter-save`）；
- `deleteChapter`：文件存在才 bump；
- `upsertEntity` / `deleteEntity` / `saveWorld`：touch 对应 kind（`ALIGN_KINDS` 才记）；
- `acceptProposal`：走上面这些函数，自动生效；决策提案直接改 facts 的分支也要 touch。

`getBundle` 里：`bundle.alignment.version = computeVersionAlignment(bundle)`（保留原有计划对齐字段不变，**不能破坏现有测试**）。

## RPC

| op | 入参 | 返回 |
|---|---|---|
| `alignment.report` | `{ projectId }` | 先 `ensureDraftCurrent`，再 `getBundle`，返回 `bundle.alignment.version`（report 形状） |
| `alignment.mark` | `{ projectId, kinds?: string[], note?: string }` | 先 mark（kinds 缺省 = 全部 ALIGN_KINDS），再返回 report |

- `alignment.mark` 的 `kinds` 必须过滤为 `ALIGN_KINDS` 内的值；空数组视为"全部"。
- 回滚钩子：
  - `snapshot.restore` 成功写盘后 → `markSnapshotRestored`；
  - `snapshot.restoreChapter` 写盘后 → `ensureDraftCurrent`（靠 mtime 记一条 `external-change`）；
  - `ledger.restore` 写盘后 → `markLedgerTouched`。
- RPC 错误用现有 `fail` 方式抛出（中文错误信息，与其它 RPC 一致）。

## 模型工具 `novel_desk_align`

```
novel_desk_align({ project?, op: 'status' | 'mark', kinds?: string[], note?: string })
```

- `status`：返回版本对齐 Markdown（先 `ensureDraftCurrent`）；
- `mark`：kinds 缺省 = 全部 ALIGN_KINDS；返回 mark 结果 + 最新对齐状态文本；
- 注册到 `apply(ctx)` 的 `ctx.tools.register(...)` 列表；工具描述里写清"AI 对齐完账本后调用 mark"。
- `novel_desk_bundle` 的 `alignment` kind 输出里，在「计划对齐」之后追加「版本对齐」小节（用 `formatVersionAlignment`）。
- `novel_desk_bundle` 的描述与 `kind` 枚举无需改动（alignment 已存在）。

## 清单任务 `align-ledgers`（按钮唯一通道）

- `TASK_LABEL['align-ledgers'] = '对齐账本到当前稿（版本对齐）'`；
- 页面按钮加入一条清单项：

```js
{ kind: 'task', id: 'align-ledgers', task: 'align-ledgers', title: '对齐账本到当前稿',
  detail: '落后：人物 v9→v12；未追踪：时间线；待验收：高光 2 条' }
```

- `buildHandoffPrompt` 对 `tasks.has('align-ledgers')` 追加的任务说明（写清流程，务必包含）：
  1. 先 `novel_desk_bundle({ kind: 'alignment' })` 读版本对齐；
  2. 对每个 `behind` / `untracked` 域：读它 `changedChapters` 的正文和已有账本，只补这段落差与 `gaps` 里的缺口；
  3. 产出**提案**（`novel_desk_propose`，kind 用账本 kind：characters/facts/events/locations/world/highlights/foreshadow/conflicts/attention/outlines），不要直接改账本、**不要改正文**；人物/地点先查重；
  4. 全部提交后调用 `novel_desk_align({ op: 'mark', kinds: [...], note: '...' })`（只标实际完成的域）；
  5. 汇报：补了哪些域、提交了几条提案、哪些域没动（及原因）。
- 失败/只完成部分时：只 mark 实际完成的域，其余留着继续显示落后。

## 客户端（client.js）

- 对齐页 `AlignmentTab` 重写为版本对齐：
  - props：`{ bundle, projectId, onChanged, onAddCart, onGoTab, onAskAi }`（渲染处补 `onAddCart={addCart}`、`onGoTab={setTab}`）；
  - mount 时 `api('alignment.report', { projectId })`；失败时回退 `bundle?.alignment?.version`，再失败给「宿主未重载」提示；
  - 顶部卡片：稿本版本 / 已对齐域 / 落后域 / 待验收提案 / 缺口；
  - 域表格：域 ｜ 状态 ｜ 账本版本 ｜ 稿本版本 ｜ 落后 ｜ 变更章节 ｜ 待验收 ｜ 缺口 ｜ 操作（去该页 / 对齐此域）；
  - 主按钮：`＋ 加入清单：对齐落后账本`（落后+未追踪 > 0 才可用）；
  - 次按钮：`全部标记为已对齐`（confirm 后 `alignment.mark`）；每行 `标记已对齐`；
  - 折叠区「计划进度（字数）」，保留原 5 张卡 + 每章字数表（复用 `bundle.alignment` 计划字段）；
  - 稿本版本历史（report.log，最多 12 条：`v12 第 5 章 外部改动 时间`）。
- 页签文案：`对齐` 保留（窄），页面标题写「🎯 版本对齐」。
- 只复用现有 CSS 变量/类；新增类写在 `client.js` 的 `CSS` 模板字符串里，命名 `sd-veralign-*`。
- 不新增构建步骤、不引入依赖、不用 JSX。

## 验收

- `npm test` 全绿；`node --check index.js`、`node --check client.js` 通过。
- 旧数据（无 `draft` / `ledgerSync`）：打开对齐页不报错，显示"未追踪"，首次 `alignment.report` 会建立 baseline。
- 新数据：保存一章 → 稿本版本 +1；写一条人物 → 人物域 `touchedVersion` 更新、状态变"落后"；`alignment.mark` 后变"已对齐"。
- 一键对齐按钮 → 清单里出现 `align-ledgers` 任务，发送后的 prompt 含版本落差与 gap 说明，并要求 mark。
- `snapshot.restore` 后全部账本显示"已对齐"（快照内本来是自洽的）。
- `test/alignment.test.js` 现有的计划对齐断言不改、不破。
