# 注意力提分闭环（打分 → 提案 → 修改 → 复测）

> 本文是 v0.5.2 新增「提分闭环」的**实现契约**。ATTENTION.md 是账本/角色/打分口径的母文档；本文只补「打完分以后怎么办」这一段。
> 本文同时记录**复核（复测）后新发现的问题如何落成「审稿条目」**：复核不只重打分，读出来的问题要逐条进「审稿」页（可勾选、忽略、加入清单），再由清单生成改动提案，而不是只能直接收补丁、没处审阅。
>
> 目标：冷读打分之后，**每章至少 3 条、可验证的提分方案**，采纳后**段落级定向打补丁**，改完**自动进入待复测**，复测后**把 Δ 分写回账本**。解决实际使用中的两个问题：①冷读后提分方案太少；②改完看不出加了几分、分数上不去。

---

## 1. 为什么旧链路提不上分

旧链路：冷读 → `novel_desk_review` 写 2–4 条审稿 → （可选）`review-to-proposals` 每审核一条 → **整章重写**的 chapter 提案 → 采纳。

- **方案太少**：审稿 2–4 条，且大部分是情节/文笔问题，不落在四拍上；不勾选就没有提案。
- **杠杆低**：按审稿改的是"问题"，不是"最弱拍"；整章重写风险大、读者新鲜感反而被磨平。
- **无法验证**：采纳后**既不标记待复测，也没有分数历史**，同一章还是冷读那一次的旧分；"改完加分少"其实根本没测过。
- **没有优先级**：提分空间 20 分和 2 分的章排在同一个列表里。

新链路：冷读（打分 + 四拍分 + 弃读引文）→ **确定性诊断**（服务端算提分空间/最弱拍）→ **提分工作单**（规定每章至少几条、每条补哪一拍）→ **段落级 before/after 补丁**提案 → 采纳（逐条替换原文 + 写 fixLog + 标记待复测）→ **复测工作单**（零上下文重读）→ 采纳实测（自动算 Δ、写 scoreHistory、清待复测）。

---

## 2. 账本字段（attention.json，向后兼容，旧记录不用迁移）

在现有字段（id/chapter/type/score/designScore/verdict/weakest/dropRisk/hook/tension/payoff/cliff/question/emotion/detail/status）之上新增：

| 字段 | 类型 | 谁写 | 含义 |
|---|---|---|---|
| `breakdown` | `{hook,tension,payoff,cliff}` 各 0–25 整数 | 冷读/复测 | 四拍实测分，合计与 score 相差 ≤10；用于定位"最弱拍"和多条方案的目标 |
| `dropPoints` | `[{quote,why}]` 1–3 条 | 冷读/复测 | 弃读点**原文引文** + 为什么想弃；提分方案必须优先覆盖这些位置 |
| `scoredAt` | ISO 时间 | 采纳实测时服务端写 | 打分时间 |
| `scoredHash` | 字符串（正文 sha1 前 12 位） | 采纳实测时服务端写 | 分数绑定的是哪一版正文；正文变了就能查出"分数过期" |
| `recheckPending` | boolean | 采纳 attention-fix 时写 | 本章已按方案改过、等复测 |
| `recheckRequestedAt` | ISO | 同上 | 进入待复测时间 |
| `fixLog` | `[{proposalId,at,target,expectedGain,weak,summary}]` 最近 12 条 | 采纳 attention-fix 时写 | 改过什么 |
| `lastFixAt` | ISO | 同上 | 最近一次按提分方案修改 |
| `fixPlan` | `{proposalId,expectedGainTotal,fixCount}` | 同上 | 当前这轮预期提分 |
| `scoreHistory` | `[{at,from,to,delta,designScore,source}]` 最近 10 条 | 采纳实测时写 | `source`：`cold-read` / `recheck`；`delta = to - from` |
| `lastRecheckAt` / `lastRecheckDelta` | ISO / 数字 | 复测采纳时写 | 最近一次复测结果 |

**空值不擦除规则不变**：设计师写 design 字段、审稿人写实测字段，按 chapter 合并。

---

## 3. 新提案类型 `attention-fix`（提分方案）

一条提案 = 一章的**一组段落级补丁**。不是整章重写。

```jsonc
{
  "kind": "attention-fix",
  "chapter": 12,
  "title": "第 12 章提分方案（3 条，预计 +11）",
  "summary": "cliff 没有未决问题 / hook 前 6 段才进冲突 / payoff 只兑现一半",
  "data": {
    "chapter": 12,
    "expectedGainTotal": 11,
    "items": [
      {
        "target": "cliff",
        "weak": "cliff",
        "expectedGain": 6,
        "before": "必须逐字出现在第 12 章正文里的原文片段（4–600 字，建议 1–3 段）",
        "after": "改写后的片段（长度接近 before）",
        "why": "为什么这样改能提分（引用 breakdown/弃读点证据）"
      }
    ]
  }
}
```

**服务端硬校验（`createProposal` 里做，不通过直接报错并说明缺什么）**

1. `data.items` 是数组且 `length >= 3`；
2. 每条：`target` ∈ `hook|tension|payoff|cliff|type|language`；`before` ≥4 字；`after` 非空且 ≠ `before`；`expectedGain` 是 1–15 的整数；`why` 非空；
3. `before` 必须**逐字**存在于该章当前正文（取到之后才允许提交；找不到就是 AI 编的，整条提案打回）；
4. 同一提案内 `before` 片段不得重叠，且至少 2 个不同 `target`；
5. `sum(expectedGain)` ≤ 40（一章不可能靠补丁提 60 分；超过就是估值虚高）。

**采纳（`acceptProposal`）**

1. 先全部校验（每条 before 都能唯一定位、互不重叠），再**从后往前**替换，避免位移；
2. `saveChapter` 保存（自动备份旧稿），保留原有 title/status/summary/location/storyTime/characters；
3. attention 记录：`fixLog` 追加本次各条（最近 12 条）、`recheckPending=true`、`recheckRequestedAt`、`lastFixAt`、`fixPlan={proposalId,expectedGainTotal,fixCount}`；
4. 返回 `applied = {chapter, fixes, attention, backup}`。

**拒绝整章重写**：提分方案只做局部补丁，改剧情走向的另走 chapter 提案。

---

## 4. 诊断（服务端确定性规则，不花 token）

专章 `lib/attention-fix.js`，导出：

- `attentionDeficits(record)` → `[{id,target,gap,evidence,prescribe}]`，规则：
  1. `score` 缺失 → 先冷读（不是提分问题）；
  2. `designScore - score >= 20` → `design-gap`（设计没兑现）；
  3. `weakest` 对应那一拍 `breakdown[weakest] < 13`（满分 25）或该拍文本为空 → `weak-<拍>`；
  4. 其它拍 `breakdown[拍] < 12` → `second-weak-<拍>`；
  5. `dropPoints` 非空 → `drop-point`（必须有一条方案覆盖该引文位置）；
  6. `breakdown` 缺失 → `need-breakdown`（只能给笼统方案，先补齐四拍分）。
- `attentionFixCandidates(bundle)` → 按**提分空间**排序的章节：`potential = (designScore ?? 全书均值+8 ?? 80) - score + designGap≥20 加 5 + dropPoints 加 3`；排除未打分、score ≥ 88。
- `attentionMinFixes(deficits)` → `clamp(3, 6, 2 + 严重项数)`，**每章至少 3 条**。
- `applyAttentionFixes(content, items)` → 校验 + 替换，返回 `{content, applied}`；失败抛带条号的中文错误。
- `attentionFixStats(bundle)` → `{pendingRecheck, verified, avgDelta, bestDelta, worstDelta, fixCount, pendingFixProposals}`，供工具/上下文/文档使用。

## 5. 复测

- 复测**必须把新发现的问题写成审稿条目**：复测工作单末尾固定附一段「## 复核发现的问题要落成审稿（不要只交打分）」——每章 1~3 条 `novel_desk_review(origin="recheck")`（带原文引文 `quote`、`suggestion` 写明改哪段怎么改），跨章共性问题用 `chapter=0`；条目进「审稿」页，作者勾选 → 加入清单 → 生成改动提案。不写审稿、只在 `detail` 里提一句的，会在 checks 里报 `attention-recheck-no-review`。
- 新工具 `novel_desk_attention_fix` 的 `op=recheck`：列出 `recheckPending` 的章（或指定章），带**当前正文**、旧分、`fixPlan` 预期，要求零上下文重读后**只写实测字段**（score/breakdown/verdict/weakest/dropPoints/dropRisk/detail），提交 `kind=attention`。
- 采纳实测时（`applyAttentionItems` 内）：若本条带 `score` 且原记录已有 `score` → 往 `scoreHistory` 追加 `{from,to,delta,designScore,source:'recheck'|'cold-read'}`；清 `recheckPending`，写 `lastRecheckAt/lastRecheckDelta`；更新 `scoredHash/scoredAt`。首次冷读 `from=null`，只记一条。
- 提分效果 = 复测 `delta`；`attentionFixStats.avgDelta` 就是"这套方案平均加了几分"。

## 6. 新检查规则（lib/checks.js）

| id | 级别 | 触发 | 文案要点 |
|---|---|---|---|
| `attention-recheck-pending:<n>` | warn | `recheckPending` | 第 n 章已按提分方案改过（N 条，预期 +X），等复测 |
| `attention-score-stale:<n>` | info | 有 `scoredHash` 且与当前正文 hash 不同、且无 pending | 第 n 章分数对应旧稿，正文已改过，建议复测 |
| `attention-fix-no-gain:<n>` | warn | 最近一次复测 `delta <= 0` 且 `fixLog` 非空 | 第 n 章改了 N 条反而没提分（预期 +X，实测 Δ），换更强的改法 |
| `attention-gap-no-plan:<n>` | warn | 提分空间 ≥20，且无 pending attention-fix 提案、无 `fixLog`、不待复测 | 第 n 章有 X 分提分空间（设计 A/实测 B），还没有提分方案 |
| `attention-recheck-no-review:<n>` | info | 最近复测过，score<75 或任一拍 <13，但本轮没有 `origin='recheck'` 的审稿（同章或 `chapter=0`） | 复测发现的问题没落审稿，作者看不到问题清单，只能直接收补丁 |

## 7. 工具与任务（index.js）

- 新工具 **`novel_desk_attention_fix`**：
  - `op='workorder'`（默认）：按提分空间选章，三种选法：`chapter=N` 单章、`chapters=[...]` 自选（按给定顺序）、`all=true`（或 `limit=0`）全书；都不传时 `limit` 默认 3。≤3 章输出**详细工作单**：该章实测/设计/四拍分/弃读引文/诊断项/固定 slot 要求（几条、各补哪一拍、优先覆盖弃读点）/提交 JSON 结构/硬校验提醒；正文**只给文件绝对路径 + 字数**，不贴进 prompt（由 AI 自己 `read`，与全文改写/扩写一致）。>3 章自动转**批量工作单**：章节清单（章 / 实测 / 设计 / 目标 / 空间 / 四拍 / 最弱 / 弃读点 / 最少补丁数 / 字数 / 正文文件绝对路径）+ 每章诊断 + 逐章执行协议（一批 2~3 章、每章提交后即报、可用 `chapters=[...]` 分批取详细单），同样只给文件路径。
  - `op='recheck'`：输出**复测工作单**（待复测章 + 正文文件路径 + 字数；不透露旧分、不贴正文）；同样支持 `chapter` / `chapters` / `all`，>3 章转批量复测单（清单 + 文件路径 + 逐章协议，不内联正文）。复测单固定附「复核发现的问题要落成审稿」：每章 1~3 条 `novel_desk_review(origin="recheck")`、跨章共性 `chapter=0`，再按需出 attention-fix。
  - `op='scoreboard'`：全书提分看板（均值/设计均值、差距前 10、待复测、已复测平均 Δ）。
- 新交接任务：`attention-fix`（生成提分方案）、`attention-recheck`（复测）；`buildHandoffPrompt` 各写一段"工作台 → 对话"prompt。
- 冷读 prompt 升级：单章必须给 `breakdown` + 1–3 条 `dropPoints` 引文；全书每章 `score/weakest`，<70 分章必须给 breakdown + 一条引文。冷读末尾直接补一句：**分数最低的 3 章（或本章 <75 分时）顺手提交 attention-fix 提案（每章 ≥3 条）**——冷读刚读完正文，正是提方案的最好时机，不另开一轮。
- `novel_desk_context` / `novel_desk_plan` 的注意力段补一行"提分空间/待复测"。
- `novel_desk_propose` 的 kind 枚举加 `attention-fix`，描述说明"段落级 before/after 补丁，≥3 条，before 必须逐字来自正文"。
- **`novel_desk_review` 升级（复核落审稿的入口）**：
  - 一次可写多章：顶层 `chapter` 是默认章，`reviews[].chapter` 可逐条覆盖；`scope='book'` 即 `chapter=0`（全书级/跨章共性问题）。
  - 新字段 `origin` ∈ `cold-read | recheck | review | manual`（默认 `review`；冷读写 `cold-read`，复测写 `recheck`）；`quote` 存原文引文（≤600 字）；`severity` 兼容中文（阻断/严重/一般/建议）。
  - 去重与重开：同章 + 同维度 + 同题（去空白标点后前 80 字）已存在——`open` 跳过，`fixed/wontfix` 重新打开（`reopenedAt`、`reopenCount+1`、`reopenFrom`）。返回「新增 A / 重新打开 B / 跳过重复 C」+ 章节清单 + 下一步引导。
  - 章号校验：`chapter>0` 必须已存在（否则报「第 N 章不存在：审稿只能写到已有章节（全书级问题用 chapter=0）」）。`required` 从 `['chapter','reviews']` 改为 `['reviews']`。
- **`review-to-proposals` 交接 prompt 改写**：审稿按维度二分——注意力/文笔/节奏类（`节奏/文笔/语言/句子/对话/首读`）合并成 `kind="attention-fix"` 段落补丁提案（3–12 条、≥2 target、合计 ≤40、`reviewIds` 带全部相关审稿 id）；情节/人物/连续性等结构类仍一条一个 chapter 提案。要求**每条审稿都被某份提案的 reviewIds 覆盖**，不能漏。

## 8. 界面（client.js）

1. **注意力页 · 🎯 提分工作台**（统计条之后、曲线之前）
   - 一句话闭环说明；三个总按钮：「生成全部提分方案（N 章）」（`scope:'all'`，N=候选章数）、「生成选中方案（K 章）」（`scope:'selected', chapters:[...]`，K=已勾选数，0 时禁用）、「复测全部待复测（N 章）」（`scope:'all'`）；
   - 表格每行带勾选框，表头可全选/清空；按提分空间降序的行：勾选 / 章号 / 实测分 / 目标分 / 提分空间 / 最弱拍 / 状态徽章（`待复测` / `已复测 Δ+7` / `等方案` / `有提案待采纳`），行内「生成方案」按钮（单章）；
   - 不再有「前 5 章」硬编码：全书一次排进工作单（>3 章服务端自动出批量工作单），也可以只勾几章；
   - 全部走 `sendToChat({projectId, task:'attention-fix'|'attention-recheck', scope, chapter?, chapters?}) `——和 `FreshReadCard` 一样，不新增 RPC。
   - 工作台头部有「看复核审稿（N）」入口，直接跳到「审稿」页看本轮复核新登记的问题。
2. **章节诊断卡**：四拍分条（`breakdown`，<13 红）、弃读引文、修改/复测记录（`fixLog` 条数 + `scoreHistory` 最近 `71 → 78 +7`）、`recheckPending` 徽章、卡内「提分方案」「复测」按钮。
3. **统计条**新增一格「提分闭环」：待复测 N 章 · 已复测 M 章 · 平均 Δ+X。
4. **总览注意力卡**加：待复测 N、平均 Δ。
5. **KIND_META** 加 `attention-fix`：`🎯 提分方案`，描述"段落级补丁，≥3 条，采纳后自动标记待复测"。
6. **提案页**：attention-fix 展示 `before/after` 对照块 + 每条 `expectedGain` + 合计；采纳按钮沿用现有批量采纳。
7. 文案常量：`ATTENTION_BEAT_LABEL`、fix 状态徽章文案集中放 attention 常量区。

## 9. 验收

- 冷读一章后：账本有 `score/breakdown/dropPoints/scoredHash`；低分章有 ≥3 条 attention-fix 提案（或明确说明为何不产）。
- 提交 2 条 attention-fix / before 不在正文里 / target 只有一个 → `novel_desk_propose` 直接报错并说明怎么补。
- 采纳 attention-fix：正文只改 `before→after` 那段、其余不动，自动备份；记录有 `fixLog/recheckPending`。
- 复测采纳：`scoreHistory` 多一条 `{from,to,delta}`，`recheckPending` 清掉，统计条平均 Δ 更新。
- checks 出现 `attention-recheck-pending` / `attention-fix-no-gain` / `attention-gap-no-plan`。
- 工作台点「生成全部提分方案（N 章）」：一次把全部待提分章排进工作单；>3 章时是批量工作单（正文只给文件路径，不内联）。
- 勾选 2 章点「生成选中方案（K 章）」：工作单只含这 2 章，标题标「自选 2 章」；全书模式标「全书 N 章」。
- `novel_desk_attention_fix(op="workorder", all=true)` / `chapters=[2,1]` 与界面按钮等价；`limit=0` 等同于全部。
- 工作单/冷读 prompt 都不把章节正文贴进对话：提分/复测只给文件路径，零上下文首读只给章节清单与路径，由 AI 自己 `read`。
- 复测采纳：即使分数仍低，复测工作单也要求把新问题写成 `novel_desk_review(origin="recheck")`；「审稿」页能按来源筛选出「复核」条目，可勾选/忽略/加入清单。
- `review-to-proposals`：节奏类审稿生成 `attention-fix` 段落补丁提案（带 `reviewIds`），结构类生成 chapter 提案；提案页 attention-fix 显示「处理 N 条审稿」，采纳后关联审稿自动标记已修。
- checks 出现 `attention-recheck-no-review`：复测低分却没写复核审稿。
- `node --test` 全绿（302 例）。

## 10. 复核落审稿（v0.5.2，未发布）

**问题**：复测（复核）之后，读出来的新问题只能变成直接改正文的 attention-fix / 整章提案，作者没有「改动审阅」这一层——看不到问题清单、不能挑、不能先讨论再改。

**做法**：

1. **复测必须落审稿**：`attentionRecheckWorkorder` / 批量复测单固定附「## 复核发现的问题要落成审稿（不要只交打分）」——每章 1~3 条 `novel_desk_review(origin="recheck")`（`issue` 带原文引文、`suggestion` 写明改哪段怎么改、可选 `quote`），跨章共性问题 `chapter=0`；之后仍 <75 或任一拍 <13 再出 attention-fix。
2. **审稿可批量登记、可重开**：`novel_desk_review` 支持多章/全书级、`origin`、`quote`、`severity` 中文别名；同章同维度同题去重，已修/已忽略的会重新打开。
3. **从审稿到改动的两条路**：审稿页勾选 →「加入清单」→ 生成修订提案；`review-to-proposals` 把注意力/文笔/节奏类合并成 attention-fix 段落补丁（`reviewIds` 覆盖多条审稿），结构类仍一条一个 chapter 提案。
4. **可审阅**：提案页 attention-fix 显示「处理 N 条审稿」；采纳后 `markReviewsFixed` 把关联审稿自动置为已修。
5. **可发现**：提分工作台「看复核审稿（N）」直达审稿页；审稿页新增「来源」列与筛选（复核/冷读/人工），`chapter=0` 显示「全书」；checks 新增 `attention-recheck-no-review`。
6. **冷读同源**：冷读 prompt 的 `novel_desk_review` 调用带 `origin="cold-read"`，与复测来源区分。
## 11. 提案去重（v0.5.2，未发布）

**问题**：复测时 AI 对同一章重复提交 `kind=attention`（工具重试 / 自我重打分），提案页并排两张同章卡；两遍都采纳还会把同一分数重复写进 `scoreHistory`（出现 `77→77`、`86→86` 空更新）。

**做法**（`lib/store.js: createProposal`）：

1. **完全相同的 pending 复用**：`kind + title + chapter + data + items` 完全一致的待采纳提案直接返回旧卡，不新增（工具重试幂等）。
2. **同章同角色覆盖**：`kind='attention'` 时区分角色——`measured`（items 带 `breakdown` / `score` / `measuredScore`）与 `design`（带 `designScore` / 字符串 `hook`）；同章同角色已有待采纳卡 → 原地更新那张卡（保留 id / createdAt，更新 title / summary / data / items / rationale / priority / updatedAt），重打分只留最新一份。
3. **不覆盖的情况**：不同章、已采纳 / 已驳回 / 已修订，以及 design 与 measured 两种角色，都可以各自保留。
4. **历史数据**：已采纳的重复提案保持原样（不改历史），只清掉重复的待采纳卡；清理前备份到作品 `.backups/`。

**验收**：同章同 payload 连提两次只有 1 张卡且 id 相同；同章改分重提只有 1 张卡且是新分；design + measured 并存 2 张；已采纳同章再提生成新卡。测试 `test/proposal.test.js`（4 例）。

## 12. 工作单硬隔离（v0.5.2，未发布）

**问题**：提分工作单 / 复测单原先直接给 `projects/<id>/chapters/0001.md` 绝对路径。项目目录旁边就并列着其他作品与历史报告，AI 会顺手去读（甚至跨作品对比）。作者要求：**除非用户明确指定目录或文件，否则任何审阅都不得让其他书籍污染当前书籍**。

**做法**：

1. 所有审阅共用隔离区 `reviewSandboxFor()` → `prepareReviewSandbox()`：`<StoryDesk>/.review-workspaces/<作品名-id后6位>/<12位指纹>/chapters/`，只写本书章节正文副本（不带元数据/账本/历史报告/其他作品），返回 `{ dir, chapterFiles, byId }`。目录名由「章号 + 正文」sha1 前 12 位决定：同一批章重复构造 prompt 幂等复用同一目录；全书审阅与单章工作单章集合不同、各占一个目录，不会互相清文件（每个目录只留最近 8 份）。
2. `chapterFilePath(bundle, chapter, rootPath, sandbox)` 优先返回隔离区路径，`attentionFixChapterSource` / `attentionFixBatchText` / `attentionRecheckBatchText` 全部透传 sandbox，所以工作单里**只出现隔离区路径**，永远不会出现 `projects/` 原始目录。
3. prompt 顶部插统一 `REVIEW_ISOLATION_LINES`（4 条硬边界：只读清单里的章节文件 / 禁止跨作品对比 / 未指定就不得打开清单外的东西 / 只提交结果不改正文）；零上下文首读、全文重新审阅的隔离区也走同一实现。
4. 带账本上下文的审阅任务用 `REVIEW_ISOLATION_NOTICE_LINES`（同样禁止跨作品、禁止读本书工作台之外文件），历史边界规则不变。

**验收**：`test/review-isolation.test.js` 在同一个 StoryDesk 下建一本《鱼龙舞》，断言零上下文首读、提分工作单、复测单、全文审阅、按审稿出提案的 prompt 都只含 `<root>/.review-workspaces/` 路径、不含 `<root>/projects/`、不含「鱼龙舞」与其他作品正文；隔离区目录只有 `chapters/` 且只含本书副本。


