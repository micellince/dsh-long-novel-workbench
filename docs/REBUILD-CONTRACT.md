# 长篇中文小说工作台 0.6.3 · 重建契约（模块边界与接口）

本文件是重写期的唯一接口契约。三个模块并行开发，任何人不改别人的文件；接口要变，先改本文件并通知 Lead。
设计意图见 `../dsh-long-novel-workbench-0.5.2/docs/DESIGN-0.6.0.md`（只读参考）。

## 0. 硬约束

1. **只在这个目录里写**：`/Users/micellince/Documents/deepseek-harness/dsh-long-novel-workbench`。禁止修改旧仓库 `dsh-long-novel-workbench`（那边有 Agent 在跑「碧血」）。
2. **测试与脚本不得写 `~/StoryDesk`**（旧插件正在用）。所有测试用 `mkdtemp` 临时目录；`scripts/migrate.js` 默认 `--dry-run`，写盘必须显式 `--apply`。
3. **旧项目数据必须可读**：新插件直接读 `~/StoryDesk/projects/<id>/`，0.5.2 的文件名与 JSON 形状尽量沿用，不认识的字段原样保留、写回时不丢。
4. **正文双格式共存**：旧项目章节是 `chapters/NNNN.md`（带 frontmatter），新写入是 `chapters/NNNN.txt` + `chapters/NNNN.meta.json`。读取时**两种都认**；写回时**写回该章原来的格式**，避免打断正在跑的旧 Agent。迁移脚本单独把 `.md` 转 `.txt`。
5. 不新增依赖；Node ESM；无构建步骤。
6. 注释与文案中文；标识符英文。

## 1. 文件与归属

| 文件 | 归属 | 说明 |
|---|---|---|
| `package.json` `cordis.patch.yml` `locale/*` `icon.svg` | Lead | 已完成，勿动 |
| `lib/prose.js` | core | `normalizeProse` / `toMarkdown`（纯函数） |
| `lib/store.js` | core | 项目/章节/审阅/提案/run/账本 读写；迁移辅助 |
| `lib/attention.js` | core | 注意力打分、统计、四拍（纯函数） |
| `scripts/migrate.js` | core | `.md`→`.txt`+meta，幂等，dry-run 默认 |
| `test/store.test.js` `test/prose.test.js` `test/attention.test.js` | core | `node --test` |
| `lib/aistyle.js` | host | 去 AI 味确定性审计（从旧库 `lib/aistyle.js` 适配） |
| `lib/gates.js` | host | `writeChapterWithGates` |
| `lib/prompts.js` | host | 四路审阅/提案/run 工作单 prompt |
| `index.js` | host | 7 工具 + RPC + 路由 + boot 注入 |
| `test/api.test.js` | host | 路由鉴权、RPC 冒烟 |
| `client.js` | ui | 模块加载器 + 侧栏入口 + 全屏工作台 8 页 |
| `client.css.js`? | ui | 直接内联在 `client.js` 里的 CSS 字符串即可 |
| `test/client.test.js`? | ui | 可选：纯函数部分 |

## 2. 数据模型（`~/StoryDesk/projects/<id>/`）

沿用 0.5.2 布局：

```
project.json                 # 作品设定（title/genre/style/targets…，原样保留）
chapters/NNNN.md | .txt      # 正文（旧：md+frontmatter；新：纯文本）
chapters/NNNN.meta.json      # 新格式的章级元数据
reviews.json                 # 审阅条目数组
attention.json               # 注意力账本（按章）
proposals.json               # 提案数组
runs.json                    # 全文动作状态（0.6 单例，替代 pipeline/expansion/revision）
facts.json characters.json events.json foreshadow.json conflicts.json locations.json world.json presets.json
```

### 2.1 Chapter

```json
{ "chapter": 3, "title": "雨夜", "status": "draft|done",
  "summary": "", "location": "", "storyTime": "", "characters": [],
  "gate": { "prose": {"normalized": true, "removed": {"bold": 3}}, "fidelity": "pass|fail", "residue": "pass|fail", "aistyle": {"score": 42, "pass": true} },
  "contentHash": "sha1…", "words": 3120, "updatedAt": "ISO" }
```

### 2.2 Review（四路同权）

来源只有四个：`logic` / `attention` / `ai-style` / `reader`。

```json
{ "id": "rv_…", "chapter": 3, "source": "logic",
  "severity": "blocker|major|minor|suggestion",
  "quote": "正文逐字原文（≥4 字，必须命中当前正文）",
  "issue": "问题是什么", "suggestion": "怎么改（可空）",
  "status": "open|fixed|wontfix|archived", "createdAt": "ISO",
  "fixedAt": null, "proposalId": null, "runId": null }
```

### 2.3 Attention

0.6 的 `attention.json` 是**按章数组**（§12.2），旧 `{chapters:{}}` 读取时摊平。每章一条：

```json
{ "chapter": 3, "type": "event|emotion|language|mystery|relationship",
  "hook": "…", "tension": "…", "payoff": "…", "cliff": "…", "question": "…",
  "designScore": 80, "status": "planned|written|measured",
  "score": 55, "breakdown": { "hook": 20, "tension": 20, "payoff": 10, "cliff": 5 },
  "weakest": "cliff", "dropPoints": [{ "quote": "…", "why": "…" }],
  "verdict": "…", "dropRisk": "…", "detail": "…",
  "scoreHistory": [{ "at": "ISO", "from": null, "to": 55, "delta": 55, "designScore": 80, "source": "cold-read" }],
  "scoredAt": "ISO", "scoredHash": "sha1…", "recheckPending": false, "emotion": "", "note": "" }
```

规则：四拍满分 `hook 20 / tension 20 / payoff 30 / cliff 30`，总分 `0–100`（`score = sum(breakdown)`）；`design`（写前四拍 + `designScore`）与 `measured`（写后冷读 `score`）是同一章的两组字段，**空值不擦除**，写入合并而不是覆盖。设计由注意力设计师/写作 AI 先提交（`novel_desk_attention op="design"`，四拍 + `designScore` 缺项拒绝），实测由零上下文冷读提交（`op="measured"`/`recheck`，不透露旧分）；分数变化才追加 `scoreHistory` 并写 `scoredHash`。**ATTENTION IS ALL YOU NEED**：没有本章设计不许写正文；设计-实测差 ≥20 或实测低于全书均分 10 分时，下一章必须补强最弱一环（由 `lib/prompts.js` 的注意力简报生成强制补强段）。

### 2.4 Proposal（三种 action）

```json
{ "id": "pp_…", "chapter": 3, "kind": "patch-paragraph|rewrite-chapter|ledger-fix",
  "title": "…", "summary": "…", "status": "pending|accepted|rejected|revised|needs-fix",
  "source": "review|run|reader|manual", "runId": null, "createdAt": "ISO",
  "data": {
    "patches": [{ "before": "逐字原文", "after": "替换文本", "why": "…", "reviewIds": ["rv_…"] }],
    "content": "整章新正文（rewrite-chapter 时）",
    "ledgerFixes": [{ "kind": "facts", "id": "…", "patch": { "value": "…" } }]
  },
  "gates": { "prose": {...}, "fidelity": "pass|fail", "residue": "pass|fail", "aistyle": {...} },
  "decidedAt": null }
```

`ledger-fix` 的修订项：规范写法是 `data.ledgerFixes = [{ kind, id?, patch }]`（`kind` 取 `world / facts / characters / events / locations / foreshadow / conflicts / highlights / outlines / presets`）。为了兼容早期工作单与手写提案，采纳时还接受：

- `data.items = [{ kind, id, patch }]`（`novel_desk_propose` 的 `items` 入参写法）——提交时规范化为 `data.ledgerFixes`；
- `data.kind = "facts"` + `data.items = [patch, …]`（0.5 风格的裸 patch 列表）；
- 单条 `data.kind` + `data.patch`（或 `data.item`）。

没有可识别修订项时，提交阶段直接失败（不再生成批不了的提案）；采纳阶段先整体校验所有 `kind`，有一条非法就整单拒绝、一条都不写。

`ledger-fix` 里的两类**注意力硬校验**（0.6.2 起，提交即校验，缺项整条拒绝、不落库）：

- `presets` 且 `patch.id === "preset-ai-custom"`（自定义让 AI 定）：`patch.attentionPlan` 必须是对象，含 `principle` 非空、`targetAvg` 0–100、`openingHooks` / `payoffCadence` / `cliffRule` 非空、`mainTypeRotation` 非空数组；
- `outlines`：新建/整章重写的大纲条目（`patch.id` 为空）必须带 `patch.attention` 对象，含 `type`（五类之一）、`hook` / `tension` / `payoff` / `cliff` 非空、`designScore` 0–100；已有条目（带 `id`）的维护性修订不强制重交四拍，避免账本同步被整单卡死。批准大纲提案时，`patch.attention` 会同时 merge 进 `attention.json`（`status=planned`），让开新书提案一批准就有设计记录（总览 hero / 曲线 / run 简报可见）。

理由：0.6 契约只有三种 proposal kind，注意力设计属于 `attention.json` 记录而不是第四种提案；硬校验放在 `ledger-fix` 的 payload 上，既不破坏提案页/旧数据，又保证「AI 预设 → 开新书提案」链路先有注意力总设计。错误码 `bad-proposal`，文案带「ATTENTION IS ALL YOU NEED」。

### 2.5 Run（全文动作单例）

```json
{ "id": "run_…", "kind": "continue|expand|rewrite", "variant": "style|logic|structure|",
  "status": "idle|planning|ready|running|paused|done|aborted|stuck|failed",
  "scope": "book|chapter|range", "chapter": null, "endChapter": null, "sessionId": null,
  "budget": { "maxTokens": 200000, "maxCostCNY": 20, "usedTokens": 0, "usedCostCNY": 0 },
  "stages": [{ "id": "prepare", "title": "…", "status": "pending|running|done|skipped", "note": "" }],
  "notes": [], "startedAt": null, "finishedAt": null, "createdAt": "ISO", "updatedAt": "ISO" }
```

三种动作：`continue`（从头写新章）、`expand`（扩写已有正文）、`rewrite`（改写，`variant` 细分 `style` 文风 / `logic` 逻辑与事实 / `structure` 结构与节奏；旧值 `rephrase` 归一为 `rewrite + style`）。只有 `continue` 会通过 `novel_desk_write` 把新章直接落盘；`expand` / `rewrite` 的产物只进提案。全本动作与单章/区间动作共用同一个单例 run，`scope` 决定范围（`range` 用 `chapter` + `endChapter`）。

开工：全文动作页「开工（发工作单）」会把 `runGoalPrompt` 工作单发进本书对话（`chat.send {workorder:'runGoalPrompt', run}`），AI 按阶段执行；只建 run 不发工作单不会动笔。0.6.2 起 `stages` 首项固定是 `{ id:'attention', title:'先定注意力设计' }`（continue 共 6 阶段：attention / prepare / plan / write / gate / review），`op=start` 返回值会附全局提醒：本次范围先补四拍 + `designScore`（`novel_desk_attention op="design"`），没有设计不许写/改正文；`novel_desk_attention op="design"` 本身缺 type / 四拍任一拍 / designScore 会直接拒绝。

## 2.6 章节删除

`chapter.delete`（写操作）：删 `chapters/NNNN.txt|md` 与 `NNNN.meta.json`；清 `reviews.json` / `attention.json` 里本章条目；`proposals.json` 只删本章 `pending|needs-fix|stale` 提案，已采纳/已驳回留作历史。返回 `{ ok, chapter, title, words, removed: { text, md, meta, attention, reviews, proposals } }`；章节不存在时 `code='not-found'`。正文删除不写 `.backups`（历史版本仍按章节号留在 `.backups/` 里）。

## 2.7 用量（usage.summary）

`usage.summary` 的准绳是 **DSH 会话日志**，不是工作台自己的记账文件：按作品 `workspacePath` 找根会话（并展开 `parentSessionId` 子代理会话族），读 `~/.dsh/sessions/<encodeCwd>/<sessionId>/session.v*.jsonl(.zstd)` 里的 `data.usage` 事件累计 tokens，再用 `models.dev` 价目（失败时内置兜底价，高峰时段 ×2）估 CNY；返回顶层兼容字段（calls/tokens/costCNY/…，来自旧 `usage.json`）+ `chat`（cwd/sessions/totalTokens/costCNY/subagents/note）+ `workbench`。实现在 `lib/usage.js`（0.5.2 原样移植）。

## 3. `lib/prose.js`

```js
export function normalizeProse(text, opts = {}) // → { text, removed: Record<string, number>, changed: boolean, needsFix: string[] }
export function toMarkdown(text)                 // → 段落空行 + 场景分隔 ※ → ***，仅导出用
export function scanResidue(text)                // → string[]（残留 Markdown 片段，空数组=干净）
```

`normalizeProse` 幂等；`needsFix` 非空表示有无法安全自动处理的结构（表格、未闭合标记）；**只**处理 ASCII Markdown 标记，不碰 `「」『』……——＊`。规则表见设计稿 §3.8。

## 3.5 `lib/exporters.js` + `lib/zip.js`（导出成品）

```js
// lib/zip.js —— 零依赖 ZIP（store / deflate，无 ZIP64，时间戳固定 → 同输入同输出）
export function crc32(buffer)
export function createZip(entries)          // [{ name, data, store? }] → Buffer

// lib/exporters.js
export const EXPORT_FORMATS = ['txt', 'md', 'epub', 'docx']
export const EXPORT_META                    // { [format]: { ext, mime, label, desc } }
export function normalizeFormat(value)      // 别名 markdown→md / epub3→epub / word|doc→docx / text→txt；空 → txt；非法抛 code='invalid'
export function bookFilename(name, ext)     // 非法字符 → _，截 80 字，空标题 → 未命名作品.<ext>
export function chapterTitle(item, index)   // 标题已带「第N章/回/节/卷/部/篇」原样用，否则补「第 N 章　标题」
export function contentBlocks(text)         // → [{ type:'h2'|'h3'|'quote'|'scene'|'p', text }]，顺带剥离 #/**/~~/`/链接/HTML/列表符
export function buildBookText(bundle)       // TXT：作品名 + 逐章；场景 → ※
export function buildBookMarkdown(bundle)   // MD：# 作品名 / ## 章名 / 正文子标题 ###；场景 → ***
export function buildEpub(bundle)           // EPUB 3（mimetype 首条且不压缩、container.xml、content.opf、nav.xhtml、style.css）→ Buffer
export function buildDocx(bundle)           // WordprocessingML（document.xml / styles.xml / [Content_Types].xml / rels）→ Buffer
```

bundle = `{ project, chapters: [{ chapter, title, content, summary }], includeSummary }`。

三个约定：

1. **成品不能漏 Markdown**：`contentBlocks` 是唯一入口，TXT / MD / EPUB / DOCX 都经它排版，写作期残留的 `##`、`**`、`>`、列表符在导出时被剥掉。
2. **`※` 是正文里的场景分隔**：TXT 原样保留 `※`；Markdown 转 `***`；EPUB / DOCX 排成居中分隔块（`p.nd-scene` / Scene 样式）。
3. **确定性**：EPUB 的 `dc:identifier` 由作品 id + 标题 sha1 得出、`dcterms:modified` 每次导出取当前时间，ZIP 内时间戳固定——同一内容重复导出，正文与条目顺序一致。

`test/export.test.js` 自带一个最小 ZIP 解析器（中央目录 + `inflateRawSync`），直接读回成品验证条目、mimetype 顺序、OPF/nav 引用与「没有写作期标记」。

## 4. `lib/store.js`

导出（全部 async，第一参数恒为 `root`）：

```js
export function defaultRoot()                       // ~/StoryDesk
export async function ensureRoot(root)
export async function listProjects(root)            // [{ id, title, genre, chapters, words, updatedAt }]
export async function createProject(root, input)    // { title, genre?, style? }
export async function getProject(root, id)
export async function updateProject(root, id, patch)
export async function getContext(root, id)          // { project, presets, characters, facts, events, foreshadow, conflicts, locations, world, attention, runs, recent }

// 章节
export async function listChapters(root, id)        // [{ chapter, title, words, status, attention, gate }]
export async function readChapter(root, id, n)      // { chapter, text, meta, format: 'md'|'txt' }
export async function saveChapter(root, id, n, text, meta, opts) // 内部：备份、hash、words、meta、写回原格式
export async function listChapterHistory(root, id, n)
export async function readChapterVersion(root, id, n, version)
export async function searchChapter(root, id, q)    // [{ chapter, offset, snippet }]

// 审阅
export async function getReviews(root, id)          // 全部
export async function addReviews(root, id, items)   // 校验 quote 命中当前正文；去重（chapter+source+quote 归一）；返回 { added, skipped }
export async function patchReviews(root, id, ids, patch)

// 注意力
export async function getAttention(root, id)
export async function mergeAttention(root, id, chapter, patch)  // 空值不擦除；自动写 scoreHistory

// 提案
export async function listProposals(root, id, filter)
export async function getProposal(root, id, proposalId)
export async function createProposal(root, id, proposal)        // 生成 id、去重（chapter+kind+payloadKey）
export async function acceptProposal(root, id, proposalId)      // 见 §6 闸门；返回 { ok, proposal }
export async function rejectProposal(root, id, proposalId, reason)
export async function batchProposals(root, id, ids, action)

// 全文动作
export async function getRun(root, id)
export async function saveRun(root, id, patch)
export async function resetRun(root, id)

// 账本
export async function getLedger(root, id)                       // { facts, characters, events, foreshadow, conflicts, locations, world, presets }
export async function upsertLedgerItem(root, id, kind, item)
export async function deleteLedgerItem(root, id, kind, itemId)

// 设置/预设/用量
export async function getSettings(root, id)                     // project + presets + 预算
export async function saveSettings(root, id, patch)
export async function usageSummary(root, id)

// 导出（正文成品；RPC op = export.book）
export async function exportBundle(root, id, opts)              // { project, chapters:[{chapter,title,content,summary}], includeSummary }
export async function exportBook(root, id, format, opts)        // format: txt|md|epub|docx；返回 { filename, mime, format, chapters, words, text?|base64? }
```

`exportBook` 只读数据、不写盘：txt / md 走 `text`（JSON 直传），epub / docx 是二进制，走 `base64` 由客户端转 Blob 下载。单章读失败会跳过，不拖垮整本导出。

`saveChapter` 是唯一正文落盘函数：写前备份到 `.backups/<n>/<ts>-<hash>.md`，写后更新 meta 与 `contentHash`。

## 5. `lib/attention.js`

```js
export const BEAT_MAX = { hook: 20, tension: 20, payoff: 30, cliff: 30 }
export const BEAT_LABEL = { hook: '钩子', tension: '张力', payoff: '回报', cliff: '章末牵引' }
export function scoreOf(beats)              // 0–100 加总并夹紧
export function deficitsOf(beats)           // 低于 0.6×满分 的环节
export function designGap(design, score)    // designScore - score（正数=设计高于实测）
export function byChapter(attention)        // 排序后的章列表
export function stats(attention)            // { avg, scored, unscored, weakest }
export function weakActions(deficits)       // 每个 deficit 的具体补强句（≈0.5.2 WEAKEST_REINFORCE 文案）
```

## 6. `lib/gates.js`

```js
export const AISTYLE_MAX = 30   // 去 AI 味分数阈值（0–100 越低越干净；>30 判 fail）
export async function gateChapterText({ text, previousText, meta })  // → { text, gates, failures: [] }
export async function gatePatchText({ previousText, nextText, deltaText, meta })  // 段落补丁闸门（scope:'patch'）
export async function writeChapterWithGates(storeApi, { root, projectId, chapter, text, source, patch }) // → { ok, chapter, gates } | { ok:false, failures, proposalStatus:'needs-fix' }
```

顺序（任一失败即停，返回不改盘）：
0. `normalizeProse`（记录 `removed`；`needsFix` → fail）
1. 保真：从 `previousText` 抽数字/专名（`extractAnchors`），新文本必须仍包含（缺失 → fail，列出）
2. 残留：`scanResidue(normalized)` 非空 → fail
3. 去 AI 味：`auditAiStyle(normalized).score > AISTYLE_MAX` → fail
4. `store.saveChapter` 落盘 + 备份

`acceptProposal` 在 apply patch/content 后必须走 `writeChapterWithGates`；失败 → 提案 `needs-fix`，不落盘。

**补丁范围（`patch-paragraph`）**：传 `patch:{ deltaText }` 时走 `gatePatchText` —— 规范化/残留/去 AI 味只测**补丁新增文本**，保真仍按整章校验；补丁只改 `before` 处，其余字节原样保留（不整章重排、不顺手迁移格式）。理由：旧章正文可能是 AI 写的或仍是 `.md`，整章重测会让任何补丁永远批不过。

**账本待同步信号（0.6.3）**：两条成功落盘路径（补丁 / 整章）保存后都会调 `storeApi.noteChapterChange(root, projectId, chapter, previousText, nextText)`（内部 `ledgerSignals` 启发式：账本里的人名/地名是否新增或消失、数字集合是否变化），命中才写 `ledger-sync.json` 的 `pending`；失败被吞掉，不影响正文落盘。理由：这个函数是**唯一**的正文写入入口（`novel_desk_write`、run、提案采纳都走它），而以前只有 `chapter.save` RPC 记信号，导致 AI 写完整本书账本仍是旧的。

## 6.5 全书账本同步（0.6.3）

正文写完后的一键分批同步：不新增 RPC op、不新增工具，全部挂在 `ledger.sync` 的 `action` 上。

```js
// lib/store.js
export async function planLedgerSync(root, projectId, { from, to, batchSize })   // 建/重建计划 → getLedgerSync
export async function completeLedgerSyncBatch(root, projectId, { batch })        // 标记某批已同步（默认第一个未完成批）
export async function resetLedgerSync(root, projectId)                          // 清 full，保留 pending
// lib/prompts.js
export function fullLedgerSyncWorkorder({ project, ledger, batch, full })       // 一批一份【全书账本同步工作单】
```

- 存储：`~/StoryDesk/projects/<id>/ledger-sync.json` = `{ pending:[{chapter,reasons,at}], full:{from,to,batchSize,createdAt,updatedAt,batches:[{chapters:[…],status:'pending'|'done',doneAt}]} }`。`pending`（改动信号）与 `full`（全书计划）**互不覆盖**；没有 `full` 时只写 `{pending}`（旧文件可直接读）。
- 切批：范围内现有章按 `batchSize`（1–20，默认 6）顺序切；重建计划时按「批内章号完全相同」复用 `done`，所以不改每批章数就不会倒退。`status` 视图额外给 `done/total`、每批 `from/to/count/words` 与 `uncovered`（`from` 之后不在任何批次的章 = 计划建立后新写的章，提示重建）。
- `ledger.sync` action：`status`（默认）/ `ack` / `plan` / `workorder`（`mode:'full'` + `batch?`，缺省下一个未完成批；不带 `mode` 仍是旧改动核对工作单）/ `batch-done` / `reset`。`workorder` 无计划报 `invalid`「还没有全书同步计划，请先建立计划（action=plan）」；全部完成返回 `{prompt:'', done:true}`。
- 工作单：标题「【全书账本同步工作单】第 X/Y 批 · 第 a–b 章」，带全书章数/本批字数/进度、`账本现状：人物 N · 地点 N · …`、本批章节（章号/标题/字数）、已有条目名（防重复造）、八类记账口径（events / characters / facts / locations / foreshadow / conflicts / highlights / outlines；新建大纲仍要四拍 + `designScore`），提交只允许 `novel_desk_propose(kind="ledger-fix")`，禁止改正文。
- 完成语义是**人工确认**：AI 只产提案，作者批准后自己点「本批已同步」（与 `ack` 同源的人工口径）；点完成会把这批章从 `pending` 里一并去掉。

## 7. `lib/aistyle.js`

从旧库 `<old>/lib/aistyle.js` 适配（可直接复制，改 import 路径），导出：

```js
export function auditAiStyle(text)   // → { score, signals: [{ id, label, count, samples }], pass }
export function scanMarkdownArtifacts(text) // → { count, artifacts: [{ id, label, count }] }
export function auditSummaryText(meta)      // 摘要本身是否 AI 味
```

阈值与信号表沿用旧实现；**不再**输出 4 档 severity，只给 score + signals。

## 8. `lib/prompts.js`

```js
export const ATTENTION_PRINCIPLE        // '> ATTENTION IS ALL YOU NEED——…先提交本章注意力设计（四拍 + designScore），再动笔。'
export const ATTENTION_TYPES            // ['event','emotion','language','mystery','relationship']
export function attentionBriefLines({ attention, chapters }) // 第一优先级 + 曲线 + 疲劳 + 目标分 + 补强 + 四拍
export function reviewWorkorder({ project, chapters, sources })   // 四路审阅工作单（可指定 source 子集）
export function proposalFromReviewsWorkorder({ project, chapter, reviews })
export function fullBookProposalWorkorder({ project, chapters, source, attention })
export function runGoalPrompt({ project, run, attention })        // continue/expand/rewrite
export function chapterRewriteWorkorder({ project, chapter, text, attention })
export function attentionDesignWorkorder({ project, chapters, attention })
export function attentionRecheckWorkorder({ project, chapters })  // 复测不透露旧分
export function readerNotePrompt({ project, chapter, notes })     // 用户批注 → AI 处理
export function newBookWorkorder({ project, preset, brief })
export function fullLedgerSyncWorkorder({ project, ledger, batch, full }) // 全书账本同步的某一批（分批，见 §6.5）
```

统一要求（写进每个工作单）：
- **所有写/改工作单第一行必须是 `ATTENTION_PRINCIPLE`**，随后是 `attentionBriefLines` 的全局注意力简报；例外只有零上下文冷读（`attentionRecheckWorkorder` / 审阅），不注入原则，保持读者视角纯净。
- 结论只走工具：`novel_desk_review`（审阅）、`novel_desk_propose`（提案）、`novel_desk_write`（run 产正文）、`novel_desk_attention op="design"`（写前设计）；**不得直接改文件**。
- 审阅 quote 必须逐字摘自正文（≥4 字），来源 `source` 只能是四路之一。
- 提案正文 payload 必须是纯文本：禁止 Markdown 语法，场景分隔用 `※`。
- 注意力相关请求先读 `novel_desk_read op=context`；复测工作单不透露旧分。
- 只保留一份共享头部（禁止在各 prompt 里重复抄写原则长文）；原则与简报各有唯一实现（`ATTENTION_PRINCIPLE` / `attentionBriefLines`）。

## 9. `index.js`（host）

```js
export const name = 'novel-desk'
export const inject = ['tools']
export function apply(ctx) { mountRoute(ctx); for (const tool of TOOLS) ctx.tools.register(tool) }
```

### 9.1 路由与鉴权（复用 DSH 宿主认证）

```js
const ROUTE = '/novel-desk/api'
function mountRoute(ctx) {
  ctx.inject(['webServer'], (c) => {
    const webServer = c.webServer, connection = c.get?.('connection')
    // boot 注入：让当前页面拿到带凭证的 API 地址
    const origin = webServer.getOrigin?.()
    const apiUrl = connection?.authenticatedUrl ? connection.authenticatedUrl(origin + ROUTE) : ROUTE
    if (webServer.tapIndex) webServer.tapIndex(html => injectBoot(html, { apiUrl }))
    webServer.register({ kind: 'prefix', path: ROUTE, handler: handle })
  })
}

function guard(req, connection) {
  // 1) 宿主认证优先
  if (connection?.requestRejection) {
    try { const r = connection.requestRejection(req); if (r !== undefined) return r } catch { /* fallthrough */ }
    else return undefined
  }
  // 2) 兜底：回环 + 同源（Host 白名单防 DNS rebinding）
  const host = String(req.headers?.host ?? '')
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return 403
  const site = String(req.headers?.['sec-fetch-site'] ?? '')
  if (site && site !== 'same-origin') return 403
  return undefined
}
```

写请求：`POST` + `content-type: application/json`，否则 415；body 上限 8MB；**永不返回 CORS 头**。

### 9.2 RPC（单入口 `POST /novel-desk/api`，body `{op, payload}`）

统一返回 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`。op 清单（34）：

读：`ping` `projects.list` `project.context` `chapter.list` `chapter.get` `chapter.history` `chapter.version` `chapter.search` `review.list` `proposal.list` `proposal.get` `run.get` `ledger.get` `align.status` `usage.summary` `settings.get`（16）
写：`app.open` `chapter.save` `review.add` `review.patch` `proposal.create` `proposal.accept` `proposal.reject` `proposal.batch` `attention.merge` `ledger.upsert` `ledger.delete` `settings.save` `run.save` `run.reset` `chat.send` `import.scan` `import.run`（17）

`app.open` 不写数据：宿主用 `connection.authenticatedUrl("http://127.0.0.1:<port>/")` 生成带一次性 token 的 URL，再把显式标记写进 **hash**（`#novel-desk=1`；已有 hash 用 `&` 追加，query/hash 已有标记则不重复），调系统默认浏览器（macOS `open` / Windows `start` / Linux `xdg-open`）打开同一套工作台；返回 `{ url, opened, hint }`。标记必须放 hash：宿主 `BrowserAuth.authorizeIndex()` 会把 `GET /?token=...` 以 `303 Location: "./"` 换成 cookie，query 被丢弃，而 fragment 会随重定向继承。客户端只在「真实浏览器标签（UA 非 Electron）+ 带标记（hash 或 query）」时自动铺满全屏，**桌面与手机一致**；没有标记的 DSH / DSH Remote（dsh-pocket）页面先显示 DSH，点侧栏入口才展开；窄屏有 `MOBILE_CSS` 与右下角关闭按钮兜底。关掉 DSH 后宿主 Web 服务停止，页面自然失效。

`ledger.sync` 用 `action` 区分（0.6.3 起）：`status`（默认，返回 `{pending, full, chapters}`）/ `ack` / `plan`（`{from?,to?,batchSize?}` 建全书分批计划）/ `workorder`（`{mode:'full', batch?}` 发某一批全书同步工作单；不带 `mode` 仍是改动核对工作单）/ `batch-done`（`{batch?}` 标记本批已同步）/ `reset`（清计划、保留改动信号）。全书进度存 `ledger-sync.json` 的 `full` 字段，**不新增 op、不新增工具**。

参数与 store 函数一一对应；`chapter.save` 修改已有章节必须带 `baseHash`，与当前 `contentHash` 不一致返回 `{ code:'stale', message }`（前端提示重新加载）；新建章节传 `{ chapter:N, text:'', create:true }`（仅当章节不存在，默认写 `.txt`、允许空正文）。

### 9.3 工具（7 个）

| 工具 | op | 用途 |
|---|---|---|
| `novel_desk_read` | `projects` `context` `toc` `chapter` `inbox` `proposals` `run` `ledger` `search` `align` | 所有读操作，返回紧凑文本（不是 JSON 大块） |
| `novel_desk_review` | — | 提交审阅条目数组（`projectId, chapter, reviews[]`），逐字校验 quote |
| `novel_desk_propose` | — | 提交提案（`projectId, kind, chapter?, items[]`），生成即规范化正文 |
| `novel_desk_attention` | `design` `measured` `workorder` `recheck` | 注意力设计/实测/工作单/复测工作单；`design` 四拍 + `designScore` 缺项拒绝（ATTENTION IS ALL YOU NEED） |
| `novel_desk_write` | — | run 产正文提交（`projectId, chapter, text, source:'run'`），必过闸门；成功但该章无设计时返回注意力提醒 |
| `novel_desk_run` | `start` `status` `advance` `pause` `resume` `finish` `abort` | 全文动作；首阶段固定「先定注意力设计」，`start` 返回全局注意力提醒 |
| `novel_desk_map` | `plan` `save` | 世界地图方案（AI 直接写回 world.json，不必人工贴回） |

工具描述各 ≤200 字，参数 `projectId` 一律可选、只有一部作品时可省略，但**描述里只写一次**（不要 9 处重复）。

## 10. `client.js`（ui）

```js
window.__ModuleLoader__.load({
  id: 'dsh-long-novel-workbench',            // 必须等于 package.json name
  factory(require) {
    const React = require('react')
    // ... 组件
    return { inject: ['slots'], apply(ctx) {
      const style = document.createElement('style'); style.textContent = CSS
      document.head.appendChild(style); ctx.effect(() => () => style.remove(), 'novel-desk: styles')
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name:'sidebar.footer.action', id:'novel-desk', order:40, label:'小说工作台' }, SidebarEntry))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name:'shell.overlay', id:'novel-desk', order:60, label:'小说工作台' }, Workbench))
    } }
  },
})
```

- API 基址：`window.__ND_BOOT__?.apiUrl || '/novel-desk/api'`。
- 工作台：全屏浮层；左导航 7 项：正文 / 审阅 / 提案 / 全文动作 / 账本（含世界地图）/ 总览 / 设置。顶栏下常驻原则条 `⚡ ATTENTION IS ALL YOU NEED`（所有页签含欢迎页可见），总览页置顶 hero，全文动作页顶部「第一步永远是注意力设计」提醒卡。
- **正文页**（默认）：三栏（目录 260 ｜ 阅读区 ≤720 ｜ 右栏 320），阅读模式连续滚动全本、`j/k` 翻章、阅读位置记忆、全文搜索；编辑模式页内 `textarea`、2s 防抖、Ctrl/Cmd+S、`baseHash` 冲突提示；读者模式选中文本 → 批注（`source:'reader'`）。
- **沉浸模式**（0.6.10）：正文页可一键收掉顶栏 / 左导航 / 目录 / 右栏 / 原则条，只留「阅读 / 编辑 / 审阅」三颗按钮 + 退出；面板铺满视口、正文区接近全屏；`Esc` 先退沉浸（不关工作台）；开关存 `localStorage:nd.immersive`。
- **仿纸正文底**（0.6.10）：阅读区与正文编辑器共用同一张纸（暖纸色 + 极淡纤维纹理），宽屏窄屏一致；编辑器不再用等宽字体，与阅读共用字号 / 行距；纸色与墨色是固定暖色（`--nd-paper*`），不随宿主明暗主题反转。
- **阅读进度三模式同步**（0.6.11）：`readParagraphAnchor()` 从滚动位置算「章 + 段」；`scrollReaderToAnchor()` 滚回该段；进编辑把 textarea 光标放到该段起点并按镜像 div 量出的位置滚（固定浮层里浏览器不会自动滚光标）；出编辑按 textarea 光标换算回段落。滚动停 300ms 持久化到 `localStorage:nd.pos.<projectId>.para`，重开页面恢复到同一段；切模式的过渡滚动用 `modeRef` 挡掉，避免把锚点写歪。
- 所有文本按纯文本渲染，禁止 `dangerouslySetInnerHTML`；不渲染 Markdown。
- 视觉沿用宿主主题 token（`var(--dsw-alias-*)`），不覆盖 app root；唯一例外是仿纸正文面的固定暖色。
- 目标：`client.js` ≤ 6500 行（含浏览器打开入口）；页面组件按文件内函数拆分；共用 `api()`、`useAsync()`、`fmt()` 小工具。

## 11. 验收（0.6.2）

- `node --check index.js client.js lib/*.js scripts/*.js` 通过；`node --test` **117/117**。
- RPC op = 37（读 19 + 写 18，含 `ledger.sync` / `export.book`）；工具 = 7；页面 = 7（世界地图并入账本页签）。
- **ATTENTION IS ALL YOU NEED 回归**：写/改工作单首行原则、`attentionBriefLines` 全局简报、run 首阶段 `attention`、design 缺项拒绝、write/run 提醒、preset `attentionPlan` 与 outlines 四拍硬校验、原则条/总览 hero/RunTab 提醒，均有单元测试或界面验证。
- 界面：`node scripts/ui-smoke.mjs` 12 个页面/页签全部挂载成功；`node scripts/ui-e2e.mjs` **79/79** 通过（含开新书、总览 hero、导出、提案批准）。
- `lib/store.js` 能读旧格式项目（`.md`+frontmatter）与新格式（`.txt`+meta）并写回原格式；旧 pending 提案与旧 attention 记录原样兼容。
- `writeChapterWithGates` 五步顺序有测试（normalize / fidelity / residue / aistyle / 落盘）。
- `prose.normalizeProse` 幂等测试；`toMarkdown` 只给导出用。
- 不写 `~/StoryDesk`（测试用 tmp）；不改旧仓库。

## 12. 0.5.x 实测兼容（2026-10-24 读真实 `~/StoryDesk` 得到，优先级高于上文形状描述）

真实数据在 `~/StoryDesk`：`library.json`（`{version:1, projects:[{id,name,genre,updatedAt}]}`）+ `projects/<id>/`。
三个项目：`pmvi78nd39d7d`、`pmviujtkm6d0d`（52 章，正在被旧 Agent 跑）、`pmvizcbhuf08b`。**只读测试，绝不写。**

### 12.1 章节文件

- 正文是 `chapters/0001.md`，YAML frontmatter 键：`id, title, status, summary, location, storyTime, characters`，`---` 之后是正文。
- 目录里还有旧备份 `0001.md.bak-20261022202745`：列章时必须只认 `/^(\d{4})\.(md|txt)$/`。
- 0.6 新章写 `chapters/NNNN.txt` + `chapters/NNNN.meta.json`；旧章保持 `.md` 原地写回（只改 body / frontmatter 已知键，未知键不动）。

### 12.2 attention.json 是**数组**，不是 `{chapters:{}}`

每章一条，字段（0.6 必须继续用这个数组形状写，否则旧插件读坏）：

```json
{ "chapter": 1, "type": "language",
  "hook": "钩子的文字设计", "tension": "…", "payoff": "…", "cliff": "…",
  "question": "…", "emotion": "…", "note": "…",
  "designScore": 92,
  "score": 78, "breakdown": { "hook": 22, "tension": 18, "payoff": 18, "cliff": 20 },
  "weakest": "tension", "dropRisk": "说明", "verdict": "会",
  "dropPoints": [{ "quote": "逐字原文", "why": "…" }],
  "status": "planned",
  "scoreHistory": [{ "at": "ISO", "from": 72, "to": 74, "delta": 2, "designScore": 92, "source": "recheck" }],
  "scoredAt": "ISO", "scoredHash": "sha1…12",
  "recheckPending": false, "lastFixAt": null, "fixLog": [], "measuredScore": 不写 }
```

- 四拍：`hook/tension/payoff/cliff` 是**文字**，数值在 `breakdown`（20/20/30/30 满分），`score = sum(breakdown)`，`designScore` 是设计分（0–100，独立）。
- `verdict` 是弃读判断（"会"/"不会"）；`measuredScore` 是幽灵字段，禁止写。
- 合并规则不变：空值不擦除、按 chapter 匹配、append `scoreHistory`。

### 12.3 reviews.json 旧条目

旧条目字段：`id, chapter, dimension（中文：连续性/情节/人物/文笔/节奏/世界观/全文意见…）, severity, issue, suggestion, status, source（旧值 "ai"）, origin?, against?（死字段）, createdAt, updatedAt`；`chapter:0` 表示全书级；**没有 quote**（旧数据 quote 可空，新条目必须 ≥4 字逐字命中）。

读取时派生四路（不改盘）：`dimension` 含「连续/逻辑/事实/情节」→`logic`；含「注意力/节奏/钩子」→`attention`；含「AI/文笔/语言」→`ai-style`；`source==='reader'`→`reader`；其余→`logic`。写新条目用四路 `source` + 中文 `dimension` 标签并存，旧插件仍按 `dimension` 分组。
`chapter:0` 的全书级条目只在「审阅收件箱」的书级 tab 显示。

### 12.4 proposals.json

旧库 898 条（`pmviujtkm6d0d`），kind 为 0.5.x 的 13 种（chapter/attention/attention-fix/facts/…），status 只剩 `accepted/rejected/revised`，无 pending。
0.6 **只读展示新 kind**（`patch-paragraph/rewrite-chapter/ledger-fix`）的 pending 条目；旧条目原样保留、不参与 accept/reject、不重写文件。迁移时旧条目整体视为 `archived`（只在账本/历史里可查）。

### 12.5 其它

- 旧库还有 `agents.json / outlines.json / highlights.json / presets.json`：原样保留，0.6 不读 `agents.json`（0.6 不设 12 Agent）。
- `proposals.json` 顶层之外，`projects/proposals.json` 也存在（437 字节）——本项目文件优先，找不到再从 `projects/proposals.json` 兜底读（只读）。
- 任何写盘前先 `realpath` 并确认落在 `root/projects/<id>/` 内。

## 0.6.4 审阅/提案链路（模块边界变更）

- **审阅范围**：由 UI 逐章勾选（`ChapterPicker`），`chat.send` 的 `reviewWorkorder` 直接收 `chapters` 数组（含 `path`），不存在任何默认章数截断；`scope='book'` 且未给章节时后端取全书（替代旧的 `context.recent` 默认 3 章）。
- **审阅 → 提案改走 AI**：UI 只生成工作单，不再在客户端拼 `before=quote / after=suggestion`。
  - `proposalGroupsWorkorder({project, chapters, groups:[{chapter,title,path,reviews}], focus})` → AI 提交每章一条 `kind="patch-paragraph"` 提案，`after` 必须是成文正文。
  - `globalFixWorkorder({project, chapters, reviews(chapter=0), focus})` → AI 先写 `opinion`，再提交 `kind="book-fix"`, `chapter=0`, `data={opinion, patches:[{chapter,before,after,why,reviewIds}], baseHashes}`。
- **提案生命周期**：`createProposal` 把关联审阅置 `proposed`；`acceptProposal` → `fixed`；`rejectProposal` → `open`。`book-fix` 在 `acceptProposal` 里逐章校验 `baseHashes`（任一章变化 → `stale`）、先校验全部 `before` 唯一定位、再逐章过 `runChapterGates` 写盘；失败 → `needs-fix`。新增 `updateProposal` / RPC `proposal.update`（仅 pending/needs-fix；改后重算 baseHash(s)，needs-fix 回 pending）。
- **引文唯一性**：`findQuoteSpan` / `applyPatches` 统计归一化出现次数，>1 视为 ambiguous（`needs-fix` 报「无法唯一定位」）；`addReviews` 同样跳过并给原因。`addReviews` 去重只挡 `open/proposed`，已 fixed/wontfix/archived 的同 quote 可重报。
- **注意力**：`novel_desk_attention` 不再默认 `limit=3`（requested → `recheckPending` → 全书，仅显式 `limit` 截断）；`saveChapter` 正文变化后 `mergeAttention(chapter,{recheckPending:true})`，打实测分后清除。UI 入口：审阅页「冷读打分 / 复测」（`attentionRecheckWorkorder`，零上下文打分，写回注意力曲线）、正文页侧栏「AI 冷读打分本章」、总览注意力曲线卡「冷读打分」。
- **备份**：`saveChapter` 只在旧正文非空且变化时备份（0 字节空备份修复）。
- **数据修复**：`scripts/repair-polluted-chapters.mjs` 反向应用历史已采纳 `patch-paragraph`（after→before），预演后 `--apply`；2026-10-25 已用它对《暂定》第 1–5 章完成修复（与污染前备份逐字一致）。

### 0.6.6 工具输入 JSON 安全（冷读打分事故）

- `novel_desk_attention` 的 design/measured 支持**单章扁平参数**（推荐）：顶层 `chapter` + `type/hook/tension/payoff/cliff/question/designScore/status`（design）或 `chapter/score/breakdown/dropPoints/verdict/weakest/detail`（measured）；`items` 数组仅作兼容、一次最多 1–5 条。schema 里补齐这些顶层字段与 `breakdown`/`dropPoints` 子结构。
- 工作单文案（`attentionDesignWorkorder` / `attentionRecheckWorkorder`）：一次只交 1 章、提交成功再读下一章；明确「多章拼一个大嵌套 JSON 容易解析失败、整轮作废；JSON 只包一层对象、结尾只有一个 `}`，不要包 data/params/args」。
- `reviewWorkorder`：提交提示从「一次可交多条」改为「每次 1–5 条，分多次调用」。
- 注意：DSH 宿主对模型产出的 tool arguments 做严格 `JSON.parse`，失败即 `MALFORMED_RESPONSE` 终止整轮；插件侧无法兜底，只能通过更小、更扁平的提交格式降低概率。
