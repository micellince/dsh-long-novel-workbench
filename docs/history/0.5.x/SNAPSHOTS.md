# 整本回滚（整本快照 + 账本历史）

改动会同时动正文和账本。逐章备份（`.backups/`）只回答「这一章改之前长什么样」，
回答不了「整本书回到开工前那一刻」——因为一次 run 会连着改几十章、十几个 json。
这里用**整本快照**兜住这件事，用 **json 账本历史**兜住单本账本的细粒度回退。

## 一、整本快照（`.snapshots/`）

一台快照 = 一个目录：`projects/<id>/.snapshots/snap-<时间戳>-<4位随机>/`

```
manifest.json                  ← 最后写；没有它视为未完成的快照，列表里跳过
chapters/0001.md               ← 全部章节原文件（含 frontmatter）
project.json  facts.json  …    ← 19 个受管 json 账本
```

manifest 记什么：

```json
{
  "id": "snap-2026-10-23T12-04-28-699Z-7z2z",
  "projectId": "pmviujtkm6d0d",
  "createdAt": "2026-10-23T12:04:28.699Z",
  "label": "当前进度 · 第1章已改版",
  "trigger": "manual",
  "runId": "rev-mvkwjicnd9fa",
  "runStatus": "running",
  "tier": "L1+L2",
  "note": "",
  "counts": { "chapters": 52, "files": 71, "words": 316530, "bytes": 1… },
  "files": [{ "path": "chapters/0001.md", "bytes": 22513, "sha256": "…" }]
}
```

- **受管文件**：`chapters/*.md` + 固定 19 个账本（`MANAGED_JSON`：project / facts / events /
  foreshadow / conflicts / characters / highlights / attention / world / locations / presets /
  outlines / reviews / proposals / agents / imports / pipeline / expansion / revision）。
- **上限**：默认保留 40 份；超出时先删最旧的自动快照，`manual` 快照最后才删。
- **完整性**：回滚前逐文件校验 sha256，任一不符直接拒绝（不写半套）。

### 触发点（trigger）

| trigger | 何时打点 |
| --- | --- |
| `manual` | 在「🕘 版本」里点「创建快照」 |
| `run-start` | 生成整本书 / 扩写 / 全文改动**开工前**（自动；失败只记日志，不阻断开工） |
| `pre-restore` | 每次整本回滚前（自动；所以「回滚的回滚」永远有路） |
| `restore-chapter` | 单章从快照恢复前（自动，同时当前正文进 `.backups/`） |

开工前自动快照会同时记下当时的 `runId` / `runStatus` / `tier`，
所以列表里一眼能看出「这是哪次 run 之前的状态」。

### 回滚语义（为什么能「精确匹配」）

`snapshot.restore` 做三件事，顺序固定：

1. **先** 用当前状态打一份 `pre-restore` 快照（回滚本身也可回滚）；
2. 按 manifest 把每个文件**原样写回**（不是重新生成，字节级一致）；
3. 删掉「快照里没有、当前却有」的受管文件——否则快照之后新增的第 53 章会残留，
   状态就不是「那一刻」了。

返回 `{ restored, removed, safetySnapshotId, snapshotId }`。
返回后 `snapshot.diff` 的 `counts.total` 必为 0。

**闸门**：`revision.json` / `pipeline.json` / `expansion.json` 任一 `status === 'running'` 时
拒绝回滚（避免和正在写文件的会话抢同一批文件），报错文案会说明是哪个任务在跑。

### 单章回滚

`snapshot.restoreChapter` 只从快照恢复一章：先把当前正文写进 `.backups/`（章节历史里能看到），
再打一份 `restore-chapter` 整本快照，然后写回快照版本。适合「只有这一章改坏了」。

## 二、json 账本历史（`.backups/json/`）

`writeJson` 是唯一写账本的通道，写入前把**旧内容**存一份：

```
.backups/json/<name>-<ISO时间戳去分隔符>-<4位序号>-<4位随机>.json
例：project-2026-10-23T115408673Z-0007-nlnn.json
```

- 只备份作品目录下的账本（`basename(dirname(dirname(path))) === 'projects'`），`library.json` 这类根文件不备份。
- **内容没变不备份**；文件本来不存在（首次写入）也不备份。
- 每本上限 100 份，超出删最旧。
- 文件名里的时间戳是定宽的，序号是进程内单调递增的，所以**同一毫秒内多次写入也能确定排序**；
  列出时按文件名倒序 = 写入顺序倒序。

## 三、RPC

| RPC | 入参 | 返回 |
| --- | --- | --- |
| `snapshot.list` | `{ projectId }` | 快照数组（不含 files 明细） |
| `snapshot.get` | `{ projectId, snapshotId }` | 完整 manifest |
| `snapshot.create` | `{ projectId, label?, trigger?, note? }` | manifest（trigger 默认 manual） |
| `snapshot.diff` | `{ projectId, snapshotId }` | `{ counts:{changed,missingNow,newSince,total}, changed, missingNow, newSince }` |
| `snapshot.restore` | `{ projectId, snapshotId }` | `{ restored, removed, safetySnapshotId, snapshotId }` |
| `snapshot.restoreChapter` | `{ projectId, snapshotId, chapterId }` | `{ file, content, previous }` |
| `snapshot.chapter` | `{ projectId, snapshotId, chapterId }` | `{ file, content }`（预览用） |
| `snapshot.delete` | `{ projectId, snapshotId }` | `{ deleted, snapshotId }` |
| `ledger.history` | `{ projectId, file }` | `[{ file, savedAt, bytes }]` |
| `ledger.version` | `{ projectId, file, name }` | `{ file, savedAt, text, data }` |
| `ledger.restore` | `{ projectId, file, name }` | `{ file, restoredFrom }` |

`file` 只接受受管账本文件名（`project.json`、`world.json`、`facts.json` …），
越界路径与不属于该账本的历史文件名都会报错。

## 四、代码位置

- `lib/snapshots.js`：快照创建 / 列表 / 对比 / 校验 / 回滚 / 单章回滚 / 删除 / 清理。
- `lib/store.js`：`backupJsonHistory`（writeJson 内部）、`listJsonHistory` / `readJsonHistoryVersion` /
  `restoreJsonHistory` / `backupChapterNow`。
- `index.js`：`autoSnapshotBeforeRun`；挂在 `startPipelineRun` / `startRevisionRun` / `startExpansion` 上。
- `client.js`：「📚 整本书 → 🕘 版本」`VersionsPanel`。
- 测试：`test/snapshots.test.js`。

## 五、已知边界

- 快照是**整本全量**：52 章 / 31 万字的书一份约 1–2 MB，40 份上限约几十 MB；不存增量。
- 快照只覆盖受管文件：用户自己往项目目录丢的文件不会被备份或删除。
- `.snapshots/` 与 `.backups/` 都不进 git 式版本管理，删了就没有了。
- 回滚期间若外部进程（编辑器、另一个 Agent）同时在改同一本书，快照的 sha256 校验能挡住
  「快照坏了」，但挡不住「回滚后被别人又改了」——回滚前后请勿并行改同一本。
