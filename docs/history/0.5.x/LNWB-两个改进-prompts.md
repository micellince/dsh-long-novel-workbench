# LNWB 两个改进任务 · 可直接交给别的 Agent 的 prompts

> 目标仓库：`dsh-long-novel-workbench`（v0.5.1，Node 22+，零依赖，无构建步骤）
> 两个任务互相独立，可分别交给不同 Agent，也可以一次都做。都**不改数据格式**、**不改正文逻辑**、**不动提案/审稿的判定规则**。

---

## 背景（两个任务共用，先读这一段）

LNWB 现在的实时性是「拉」的，而且只拉了两个地方：

- 客户端 [client.js](client.js) 里 `PIPELINE_POLL_MS = 10000` 和 `EXPANSION_POLL_MS = 10000` 两个常量，
  只在「整本书」页签（约 `client.js:2913`）和「扩写」入口（约 `client.js:3310`）的 `useEffect` 里 `setInterval(load, 10000)`。
- 其余所有页签（提案、审稿、章节、注意力……）打开后**不会自动刷新**。Agent 在对话里写完提案、提案页其实已经开着，作者看到的是旧数据，必须手点「刷新」（`client.js` 约 `6233` 行那个按钮）。
- AI 从对话直连回来时（比如你说「给《长夜将明》补第 3 章时间线」），它不知道作者现在在看哪本书、哪个页签，得先调 `novel_desk_projects` 猜书名；多个作品时容易问错书、改错书。

对应的 Host 侧现状：

- 唯一的同源 API 路由是 `mountRoute(ctx)`（`index.js` 约 `3006` 行），`kind: 'prefix'`，路径 `ROUTE = '/novel-desk/api'`，POST 进来交给 `handleRpc(body, ctx)` 的 `switch (op)` 分发。
- 每个 op 都是「读/写 → 返回 JSON」的纯函数形态，`sendJson(res, 200, { ok: true, value })`。
- 数据根 `defaultRoot()` = `~/StoryDesk`（可用 `STORY_DESK_ROOT` 覆盖），**不在工作区里**，所以工作区文件监听（`workspaceFiles.changes`）看不到它——这也是为什么本方案选择「版本号 + 轮询」，而不是文件监听。
- Agent 工具在 `index.js` 末尾注册（约 `3727` 行 `apply(ctx)`）。
- 系统提示注入用 `ctx.systemPrompt.context(...)` 或 `ctx.systemPrompt.section(...)`，LNWB 目前**一处都没用**。

---

## 任务 A：让工作台在后台有变化时自动刷新

### 要给 Agent 的原话（可直接粘贴）

```
仓库：dsh-long-novel-workbench（v0.5.1）。

任务：让工作台在前台任意页签都能感知后台变化并自动刷新，替换现在只有「整本书/扩写」两个页签才有的 10 秒轮询。

现状：
- client.js 里 PIPELINE_POLL_MS / EXPANSION_POLL_MS 两个 setInterval(load, 10000)，只覆盖两个页签。
- 其他页签（提案、审稿、章节、注意力、人物…）打开后不会自动刷新，作者必须手点「刷新」。

要求：
1. Host 侧（index.js）在 handleRpc 的 switch 里新增 op 'project.version'：
   入参 { projectId }，返回 { version, updatedAt }。
2. version 必须能反映「项目里任何会改变工作台界面的写入」，包括：
   章节、各类账本（facts/events/foreshadow/conflicts/characters/highlights/attention/locations/outlines/world）、
   提案、审稿、预设、agents 分工、pipeline、expansion。
   推荐实现：不新增存储文件，直接由这些文件的 (mtimeMs, size) 拼出一个稳定字符串当 version；
   读不到任何文件时返回 version: ''。不要为版本号新建 .version 文件，避免写入放大和并发问题。
3. 客户端加一个全局的 useProjectVersion(projectId) hook：
   - 间隔 5000ms 调 api('project.version', {projectId})；
   - document.visibilityState !== 'visible' 时跳过这次请求（省事件循环）；
   - 返回的 version 与上次不同才回调 onChanged（不要每次轮询都触发全量 bundle 重拉）；
   - 首次拿到 version 只记录、不触发刷新（避免打开页签就白拉一次）；
   - 组件卸载时 clearInterval。
4. Workbench 组件（约 client.js:6157 refresh 附近）用它：version 变化 → 走现有的 refresh(projectId) 全量重拉，
   然后顶部提示「已同步最新改动」，提示 3 秒自动消失。
5. 删除 PIPELINE_POLL_MS / EXPANSION_POLL_MS 两处独立轮询，改由统一版本号驱动；这两个页签不再需要自己的 timer。
6. 正在编辑中的自动保存（chapter 编辑器停止输入 5 秒自动保存）不能被自己触发的刷新打断：
   refresh 时要保留当前打开的章节编辑器的本地草稿（现有代码有「关闭时若有未保存改动会提示」的逻辑，
   这里要保证「后台刷新不会把用户正在输入的内容冲掉」）。

验收：
- npm test 全绿；新增 test/ 下至少一个用例，直接测 version 计算函数（纯函数，给临时目录造几个文件、改 mtime、断言 version 变了/没变）。
- node --check index.js && node --check client.js 通过。
- 手动：开两个会话，一边让 Agent 提一条提案，另一边停在提案页不点刷新，5 秒内自动出现。
- 手动：正在章节页输入文字时，后台有别的写入，输入框内容不丢。

不要做的事：
- 不要引入 WebSocket/SSE，不要改 ROUTE 路径，不要改数据目录结构。
- 不要碰 checks.js 的判定规则、不要碰提案/审稿的采纳逻辑。
```

---

## 任务 B：让 AI 从对话直连时知道「当前作品 + 当前页签」

### 要给 Agent 的原话（可直接粘贴）

```
仓库：dsh-long-novel-workbench（v0.5.1）。

任务：Agent 从对话直连进来时（用户说「给《长夜将明》补第 3 章时间线」这类），
目前不知道作者在看哪本书、哪个页签，必须靠 novel_desk_projects 猜；多作品时容易问错/改错书。

要求（这是「两行上下文 + 一个上报接口」，不要做成全量上下文注入）：

1. Host 侧（index.js）在内存里维护一个极轻的「最近焦点」表：
   { [sessionId 或 'global']: { projectId, projectName, tab, at } }
   - 不落盘、不写进项目目录，进程重启即清空。
2. 新增 op 'ui.focus'：{ projectId, tab } → 记录焦点，返回 { ok: true }。
   客户端在切换页签 / 切换作品时调用（节流 1 秒，不需要等返回）。
3. 用 ctx.systemPrompt.context(...)（或 section）注入**最多两行**：
   当前作品：<name>（id=<id>）；当前页签：<tab>
   只在有焦点记录时注入；没有记录就什么都不加。
   ⚠️ 严禁注入整包 bundle、章节列表、账本内容——那是 novel_desk_context 的活，注入会每轮烧 token。
4. 让 novel_desk_plan / novel_desk_context 在「调用方没传 project」时，
   优先用这条焦点记录选作品，而不是「只有一部作品才自动选，多部就报错」。
   即：session 焦点 → 上次用过的作品 → 唯一作品 → 报错并列列表。

验收：
- npm test 全绿；新增用例覆盖「多作品且无显式参数时，按焦点记录选中正确作品」。
- 手动：开两个作品，分别在各自页签里待一下，然后对话里说「给我看下上下文」，
  确认 Agent 选中的是当前页签所属的作品，且首轮 prompt 里只多了两行。

不要做的事：
- 不要注入 bundle/账本（会爆 token）。
- 不要为这个功能改 novel_desk_bundle 的返回结构。
- 不要把焦点记录写进 ~/StoryDesk 的项目目录。
```

---

## 给主控（你）的合并建议

- 两个任务都改 `index.js` 的 `handleRpc` switch 和 `client.js` 的 Workbench 组件，**如果两个 Agent 并行做，必须约定先做 A 再做 B**（B 的 `ui.focus` 上报点就在 A 改过的 Workbench 里），或者让同一个 Agent 顺序做。
- 两个任务都不需要动 `lib/`，也不需要版本迁移。
- 合起来可以作为 v0.6「实时性与上下文」一个版本发，CHANGELOG 里两个条目分开写。
