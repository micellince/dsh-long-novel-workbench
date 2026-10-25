# 全文改动 · 接口契约（未发布）

后端实现者与 UI 实现者共同遵守本文件。

## 1. 数据：`revision.json`（项目单例）

```js
{
  id: 'revision',
  status: 'idle' | 'planned' | 'running' | 'paused' | 'awaiting-author' | 'done',
  runId: 'rev-xxxx',
  tier: 'L1' | 'L2' | 'L3' | 'L1+L2' | ...,
  contract: {
    chapters: ['0001', '0002'],        // 要改的章
    tiers: ['L1', 'L2'],               // 多选；也接受 'L1+L2' 字符串
    tier: 'L1+L2',                     // 组合后的 id（服务端写入）
    goalMode: 'preset',                // preset | custom | both
    presetId: 'preset-liang-wenbai',   // goalMode 含 preset 时必填
    goal: '叙述改成文白相间',           // goalMode=custom 时必填
    charter: {                          // 仅 L3
      oldValue: '为父报仇',
      newValue: '为生民立命',
      affectedCharacters: ['华羽生'],
      keywords: []                      // 可选，影响面扫描补充词
    }
  },
  impact: { keywords: [], chapters: [{ chapter, title, matched: [] }], uncovered: 0 },
  gates: ['fidelity-anchors', 'style-cards'],
  batches: [{
    index: 0,
    kind: 'settings' | 'chapter',
    label: '第 0001、0002 章',
    chapters: ['0001', '0002'],
    status: 'pending' | 'running' | 'done',
    parallel: true,
    requiresAuthorConfirm: true,
    fidelity: { hit: 0, total: 0, missing: [] },
    style: { before: {}, after: {} }
  }],
  notes: [{ at, text }],
  budget: { maxTokens: 0, maxCostCNY: 0, usedTokens: 0, usedCostCNY: 0 },
  createdAt, updatedAt
}
```

## 2. RPC（`POST /novel-desk/api`，body 至少带 `op` 与 `projectId`）

| op | 入参 | 返回 |
|---|---|---|
| `revision.get` | — | `{ revision, audit, summary }` |
| `revision.plan` | `tier, chapters[], goal, charter?, keywords?, batchSize?, stopMode?` | `{ revision, prompt }` |
| `revision.preview` | `tier, chapters[], goal, charter?`（不落盘） | `{ impact, batches, policy, errors }` |
| `revision.start` | `batchSize?, stopMode?`（开始前重排批次，按章保留进度） | `{ revision, sessionId, prompt, rebatched }` |
| `revision.advance` | `batchIndex, status, note?` | `{ revision }` |
| `revision.pause` / `revision.resume` / `revision.reset` | `note?` | `{ revision }` |
| `revision.applyChapter` | `chapter, content, batchIndex?` | `{ revision, fidelity, style, md, backup }` |
| `aistyle.audit` | `thresholds?` | `{ audit, summary, prompt }`（**Markdown 残留优先**） |
| `review.startDeai` | — | `{ sessionId, prompt, audit, summary, workspacePath, chapterCount }`（**硬隔离**：章节副本写入 `<StoryDesk>/.review-workspaces/<作品名-id>/<12位指纹>/`，在该目录新建独立零上下文会话；prompt 只给本书章节清单，禁止跨作品对比） |
| `review.startFull` | `focus[]`（可空） | `{ sessionId, prompt, focus, workspacePath, chapterCount }`（同样硬隔离：新建独立零上下文会话，workspace 就是隔离区 `<StoryDesk>/.review-workspaces/<作品名-id>/<12位指纹>/`，prompt 只列本书章节文件路径） |

`revision.plan` 走 `validateRevisionContract`：契约不成立时返回 `{ error }`，不落盘。

`batchSize`：正整数（每批章数）、`'all'`（全书一批）或 `'auto'`（不指定，L3 逐章 / L1·L2 每 5 章）。`stopMode`：`per-batch` / `fix-only` / `run-to-end` / `'auto'`（按分层默认：L1 只停样张，L2/L3 每批停）。L1–L3 都可用，L3 只保留「设定层批 0 在最前」的顺序约束。两者都写进 `revision.json` 的 `contract`，工作单顶部「范围 / 停顿方式」两行与之对应。二者是**执行设置**：UI 放在「④ 执行」，点「开始」时由 `revision.start` 传入并重排批次（已完成的章按章保留状态）；`revision.plan` 里传的值只是方案默认值。

**Markdown 残留是去 AI 化的第一优先级**：`applyChapter` 的批次验收 = 保真闸门 ∧ `md.total === 0`，有残留即 `needs-fix`。

## 3. MCP 工具 `novel_desk_revision`

`op`: `status` | `plan` | `start` | `stage` | `apply` | `pause` | `finish` | `stuck`

- `plan` 的 `data` 传 tier/chapters/goal/charter；
- `stage` 上报批次进度：`{ batchIndex, status, note }`；
- `apply` 提交单章改写：`{ chapter, content }`（写正文并保留备份，同时跑双闸门）。

## 4. 双闸门

- **保真闸门** `fidelity-anchors`：专名全集不得丢失；数字量化保留率 ≥ 80%；对白条数变化不超过 ±20%。
- **风格闸门** `style-cards`：用 `lib/aistyle.js` 对比改前改后，指标须朝阈值方向移动。

`applyChapter` 返回两个闸门结果，未通过时仍写入（作者可回滚），但批次标记 `needs-fix`。

## 5. UI 要求（client.js）

**全文改动不是独立页签**，它是「📚 整本书」`PipelineTab` 里的一个子模块，与「生成整本书 / 扩写」并列。

`PipelineTab` 的 `section` 取值：`'pipeline' | 'expansion' | 'revision' | 'review'`。

- `section === 'revision'` → `h(RevisionTab, { bundle, projectId, onChanged })`
- `section === 'review'` → `h(ReviewPanel, { bundle, projectId, onChanged })`，内含两张卡：
  1. **去 AI 化审阅**：展示 `aistyle.audit` 的 summary（Markdown 残留置顶），说明「独立会话 · 零上下文 · 只读本书副本；禁止跨作品对比」，按钮 → `review.startDeai`，成功后显示隔离工作区路径，并给出公开检测入口「朱雀 AI 检测」（`https://matrix.tencent.com/ai-detect/`，只给链接）；
  2. **全文重新审阅**：重点 textarea（每行一条）→ `review.startFull`（`focus` 数组）。同样新建**独立零上下文会话**，workspace 指向同一个隔离区，prompt 只列本书章节文件路径（不把正文贴进对话）。

> **所有审阅都硬隔离**（v0.5.2）：`.review-workspaces/<作品名-id>/<12位指纹>/chapters/` 只放本书章节正文副本（不带账本、历史报告、其他作品；指纹由章号+正文决定，同批章幂等复用，不同章集合互不清文件）。零上下文首读（单章/全书）、注意力提分工作单、注意力复测、全文重新审阅、按审稿出提案都只给这个隔离区的文件路径；带账本上下文的审阅任务（全文审阅 / 导入审阅 / 单章审阅 / 按审稿修改）在 prompt 里插「审阅隔离」硬边界（只审当前这本书、禁止读本书工作台以外文件、禁止跨作品对比、缺材料先问作者），提交侧仍按作品名校验拦截跨作品内容。
- 子导航第四项「🔍 审阅」在有 md 残留或 blocker 时显示红色角标「待清」。
- 面板内容：
  1. 分层选择（L1/L2/L3，显示 `describeRevisionTier` 的可动/冻结/风险）
  2. 章节范围（支持 `1-52` 与 `5,7,9` 写法，本地解析成 id 数组）
  3. 目标（goal）文本框
  4. L3 才显示：旧立场 / 新立场 / 受影响人物
  5. 「预览影响面」调 `revision.preview`，列出受影响章与未覆盖数
  6. 「出方案」调 `revision.plan`，「开始」调 `revision.start`
  7. 批次表：批次号、章节、状态、保真 hit/total
  8. 顶部展示 `revision.get` 返回的 audit summary（去 AI 化指标）
