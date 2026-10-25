# WORLD MODEL · 事实与注意力两个支柱（设计草案）

> 用户提出的核心模型：一本书由两条线支撑——**事实（自洽）** 和 **注意力（抓人）**。
> 人物、物品、地点、时间线、事件、因果、世界规则都是"事实"；每一章是否让人读下去是"注意力"。
> 本文件把"地点/世界模型"作为事实层的新增部分先定契约，再谈它与注意力的联动。

---

## 1. 两个支柱

| 支柱 | 包含 | 判据 | 现状 |
|---|---|---|---|
| **事实（Canon）** | 人物、物品、地点、时间线/事件、事实账本、伏笔、冲突、因果、世界规则 | 不矛盾：空间自洽、时间自洽、逻辑自洽 | 人物/时间线/事实/伏笔/冲突已有账本；**地点还只是文本** |
| **注意力（Attention）** | 每章一个 0–100 总分、四拍（钩子/张力/回报/牵引）、类型、弃读点 | 读不读得下去、想不想追 | `attention.json` + 曲线 + 冷读评分，已落地 |

原则：
- 事实层保证"不错"，注意力层保证"好看"；
- 注意力可以**借用事实层的时空**（关隘、渡口、日夜、赶路）制造场面与悬念；
- 事实层的一致性检查不花 token，注意力层的打分由冷读产生。

---

## 2. 为什么需要空间模型

现在 `location` 只是事件/事实里的自由文本。问题：

- 「从长安往西走，走到洛阳」——洛阳在长安东面，纯文本记不出来；
- 同一地点在不同章写法不一（长安/京兆府/西京）；
- 章与章之间移动没有距离/耗时概念，时间线只靠 `storyTime` 文本；
- AI 写下一章时没有"世界"可依，空间容易漂。

所以需要把**地点建模成实体**，并给世界一个可生成、可校验的**模拟地图**。

---

## 3. 数据契约（待实现，P1）

### `world.json`（每个作品一条）

```jsonc
{
  "id": "world-1",
  "name": "大唐天宝",
  "scale": "realm",              // city | region | continent | realm
  "kind": "historical",          // historical 现实 | fictional 架空 | mixed 混合
  "era": "唐·天宝年间",
  "mapSize": { "w": 1000, "h": 1000 },   // 归一化坐标空间
  "travelModel": {               // 行程时间模型（按时代交通）
    "walkKmPerDay": 30,
    "horseKmPerDay": 80,
    "boatKmPerDay": 60
  },
  "generatedBy": "ai",           // ai | manual | import
  "locked": false,               // 作者锁定后作为正史
  "note": ""
}
```

### `locations.json`（每个地点一条）

```jsonc
{
  "id": "loc-changan",
  "name": "长安",
  "aliases": ["京兆府", "西京"],
  "type": "capital",             // capital | city | town | village | pass | temple | mountain | river | sea
  "coords": { "x": 420, "y": 380 },   // 0–1000 归一化，世界地图直接画
  "region": "关内道",
  "firstChapter": 1,             // 首次出现章
  "connections": [               // 与相邻地点的路
    { "to": "loc-luoyang", "distanceKm": 380, "days": 5, "mode": "horse", "bearing": "east" }
  ],
  "note": "",
  "source": "ai"                 // ai | manual | import
}
```

约定：
- 事实账本里 `subject` 可以是地点；`events.location` / `chapters.location` 写地点名，检查时按 name/alias 匹配到 `locations`；
- 坐标只用于画图与相对方位，**距离以 `connections.distanceKm` 为准**（坐标可以粗略）；
- 真实历史作品允许混合：已知地点用真实相对方位与距离，虚构地点插空。

---

## 4. AI 生成地图（新建作品时）

新作品向导增加一组「世界设定」问题：

1. 背景类型：现实历史 / 架空大陆 / 城市日常 / 混合；
2. 尺度：一座城 / 一个地区 / 一整块大陆 / 多界；
3. 时代与交通（决定行程模型：步行/马/船/飞行）；
4. 是否需要 AI 生成模拟地图（默认是）。

AI 产出：

- 1 份 `world` + 8–20 个核心 `locations`（含坐标、区域、连接、距离/天数、首次出现章）；
- 作者在「世界」页检视、拖拽坐标、改距离、锁定；
- 锁定后作为正史，后续写作/检查都以它为准。

已有作品：可以「AI 反推地点清单」——从 events/chapters 的 `location` 文本聚类，生成地点提案，人工确认后补坐标与连接。

---

## 5. 空间自洽检查（确定性，不花 token，P2）

| 规则 | 级别 |
|---|---|
| 事件/章节 location 匹配不到任何地点（含别名） | warn |
| 相邻事件在同一章内跨地点，但用时超过该章 `storyTime` 允许 | warn |
| 连续两章移动方向与连接方位矛盾（如长安→洛阳却标"向西"） | warn |
| 移动距离/天数与 `storyTime` 差超过阈值（如 >50%） | warn |
| 坐标超出 `mapSize` 或两地点坐标重合 | error |
| 地点首次出现章晚于引用它的事件章 | warn |
| 同一地点在不同章别名混用（未登记到 aliases） | info |

注意力联动（P3）：注意力设计师在定四拍时可以引用地点——「第 21 章：潼关失守 → 逃难路线」，把空间压力写进张力与章末牵引。

---

## 6. 与现有模块的关系

| 模块 | 变化 |
|---|---|
| 事实账本 | 新增地点实体；`location` 文本可被解析为地点引用；不破坏现有数据 |
| 时间线 | 事件加地点引用；泳道/全景可加地点轴 |
| 章节 | `chapters.location` 保留文本，可换成地点选择 |
| 章节地图（已做） | 章节节点 + 注意力 + 事件/冲突/伏笔/高光，先给"进度地图" |
| 世界地图（P3） | 地点节点 + 连接路线 + 章节推进轨迹；同一套视图层 |
| 注意力 | 不强制改；设计师可选引用地点做张力 |

---

## 7. 分阶段

- **P0（已完成）**：章节地图页——蛇形章节节点、状态/注意力/事件/冲突/伏笔/高光角标、详情弹窗。
- **P1（已完成）**：`world.json` + `locations.json` 一等账本；「🌍 世界」页（设定表单 + SVG 坐标地图 + 拖拽 + 连接编辑 + 地点列表）；新建作品向导加世界设定；已有作品 AI 反推地点（`world-infer`）。
- **P2（已完成）**：6 条空间自洽检查接入 checks/总览；时间线全景加地点显示与地点筛选。
- **P3（已完成）**：世界地图可视化（SVG、拖拽落库、hover 联动、距离标签）；与章节地图联动（「在世界地图中查看」）；只读 HTML 视图（`/novel-desk/view/{world|timeline|map}`，面板内 iframe + 打印样式）。

---

## 8. 实现记录（P1–P3，本地未发布）

**数据层**
- `world.json` 是单例（故意不进 `KINDS`）：`getWorld` 未保存时返回默认世界且不落盘；`saveWorld` 单例合并（mapSize/travelModel 浅合并、id 固定、补 updatedAt）。
- `locations.json` 是数组账本（`KINDS`/`KIND_FILES`，自动建空）；`upsertEntity` 对 locations 在**无 id 时按 name/别名对齐已有地点**，避免重复；提案采纳走 `applyLocationItems`（同样按名称去重）。
- bundle 增加 `world`、`worldSaved`、`locations`、`stats.locations`、`stats.world`；RPC `world.get` / `world.save`。

**生成与移动约束**
- 清单任务 `world-build`：1 份 world + 8–20 个地点（坐标 0–1000、别名、双向连接含距离/天数/交通/方位），分别提交 `novel_desk_propose(kind='world'|'locations')`，不改正文。
- 清单任务 `world-infer`：从 events/chapters 的 `location` 文本与 facts 地点主体聚类去重，按首次出现排序定坐标，world 缺失一并生成。
- `novel_desk_plan` / `import-review` / `continue-chapter` / `next-chapter-plan` 都要求移动优先用已登记地点与连接、不出现地图外地点。

**空间检查（checks，id 前缀 world-/location-）**
`world-missing`(info)、`location-unknown`(warn，地点库非空才查)、`location-route-missing`(warn)、`location-coords-bad`(error)、`location-coords-close`(warn)、`location-first-chapter`(warn)。

**界面**
- 导航「正文」组：章节 → 地图 → **世界** → 人物 → 时间线 → 事实账本。
- 世界页：设定表单（名称/尺度/类型/时代/三种交通日均里程）→ `world.save`；SVG 坐标地图（`getScreenCTM` 精确拖拽落库、双向连接去重、距离/天数标签、hover 高亮）；地点列表；自定义 `LocationEditor`（含 connections 增删改）；AI 入口全部走清单；「只读视图」iframe。
- 新建作品向导：背景类型/尺度/时代 + 「创建后让 AI 生成世界地图」（默认勾选）→ `world-build` 任务。
- 章节地图详情显示地点，「在世界地图中查看」联动世界页高亮；时间线全景显示每章地点并支持地点筛选。
- 只读视图：`GET /novel-desk/view/world|timeline|map?projectId=…`，自包含 HTML（内联 CSS/SVG/JS、无外链、打印按钮、页脚作品名），面板内 iframe 打开（不依赖弹窗）。

**测试**：`test/world.test.js` 21 条（world 默认/保存、locations 账本与去重、提案采纳、MCP 输出、两个任务 prompt、6 条 checks、3 个 HTML 视图与路由状态码）；`node --test` 105/105。

---

## 9. 待定

1. 坐标用归一化 0–1000 还是真实经纬度（历史题材可两者兼容，架空只能归一化）；**当前实现：归一化 0–1000**；
2. 行程时间是否要按地形修正（山路/水路/乘船）；**当前实现：按交通方式给日均里程，未按地形修正**；
3. 导入作品的地点如何从历史版本补（AI 反推 + 人工确认）；**当前实现：`world-infer` 任务，人工采纳提案**；
4. 世界地图与章节地图是否合并成一页；**当前实现：分两页（地图=章节进度，世界=地理）**；
5. 多卷/多大陆是否要多张世界图（P3 再定）；**未实现，多图留给后续**。
