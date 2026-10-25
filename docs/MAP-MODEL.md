# 世界地图 0.6.2 · 地图模型

> 一句话：**坐标即位置，方案即分区**。所有几何都在世界坐标（`world.mapSize`，本书 1000×1000）里算，客户端只做仿射缩放——`client.js` 里不再有 bbox 拉伸、密度变形、斥力抖点。

## 1. 数据流（全在客户端，没有新 RPC）

```
ledger(世界 + 地点 + 事件) + world.mapStyle.aiPlan（若存过）
        │  client.js  buildWorldMapScene({ world, locations, events })
        ▼
   地图场景 scene（§2）
        │  mapSceneLayers(scene, view, { scale, show })
        ▼
   React <svg>（页面里直接渲染）        mapSceneToSvg(scene, view) → 独立 SVG 文件（导出 / 离线检查）
```

不新增读接口、不改 `index.js`：宿主正在运行时也能生效，**刷新页面**即可。

生成链路（`map.background` / 「生成底图 / 换画版 / 让 AI 出方案」按钮）已在 0.6.1 移除。服务端仍保留 `map.background` 与 `novel_desk_map` 工具以兼容旧数据与旧脚本，但界面不再调用，也不再消耗 AI token。

## 2. 场景形状（`buildWorldMapScene` 的返回）

```ts
type Pt = { x: number, y: number }   // 世界坐标
type Glyph = 'capital' | 'city' | 'town' | 'village' | 'pass' | 'temple' | 'water' | 'road' | 'site' | 'mountain'

scene = {
  name, era, mapSize: { w, h }, seed,
  palette: { id, name, paper, ink, water, ridge, accent, label },
  viewBox: { x, y, w, h },          // 建议视框：地点包络 + 地名盒子 + 留白，已允许溢出 mapSize 一点点
  regions: [{ id, name, fullName, desc, bounds, cx, cy,
              labelX?, labelY?, labelAnchor?, labelFaint?,   // 分区名落点（避开地名与地点符号）
              source }],
  rivers: [{ points: Pt[], name, kind }],   // 水线；名字解析不到就叫「水系」
  ranges: [{ points: Pt[], size }],         // 山脊走向折线 + 单颗山形尺寸
  routes: [{ id, name, terrain, note, kind: 'road'|'water'|'trail', stops: [{id,name,x,y}] }],
  points: [{ id, fullName, type, glyph, priority, x, y }],
  labels: [{ id, name, x, y, zoom, leader, anchorX?, anchorY? }],
  planText, planSavedAt, regionSource, routeSource,
}
```

- `regionSource`：`'aiPlan'`（解析到 ≥2 个区域）或 `'derived'`（按地点 `region` 归并兜底）。
- `routeSource`：`'aiPlan'` / `'events'`（按事件 `location` 顺序）/ `'none'`。
- 名字显示长度一律过 `mapShort()`：按 `·`、`→`、`—`、括号切开取短段，超过 10 字截断。

## 3. 解析规则（都对着真实数据调过）

| 输入 | 规则 | 例 |
| --- | --- | --- |
| 【区域】行 | `名字｜x a–b，y c–d｜地貌`，`–—~～至到` 都认，宽或高 < 20 丢弃 | `京畿关内区｜x 250–420，y 495–630｜秦岭…` |
| 【路线】行 | 优先取「第二段是链」的形状 `线路名｜A—B—C｜备注`，否则 `A→B｜地形｜备注`；链上地名逐个 `mapResolveName`（全名 → 别名 → 包含匹配），≥2 个才算一条 | `汜水至长安驿道｜汜水—虎牢—洛阳—潼关—长安｜官道` |
| 水线 | ① 区域地貌里出现 `y≈545` + 河名（`…水/河/江/渠/溪`）→ 在区域横向宽度内画一条摆动水线；② 水类地点（type 或名字带 江/河/湖/渡/口/津…）相邻 < 150 单位时串起来，只有 2 点且 < 90 时沿走向补长到 170 | `渭水`、`孝水` |
| 河名 | 只取 2–3 个汉字 + 水尾字；连接词（与/和/及/之/在…）与方位词、「水域/水名」这类普通词一律不算 | `秦岭终南山北麓与渭水谷地` → `渭水` |
| 山形 | 沿 mountain/pass/关/山/谷/岭/岳 这类地点，按最近邻串成 2–6 点的山脊，再撒点加密；避开河道与地点 | 终南山北麓、秦岭 |
| 分区名落点 | 依次试 6 个方位，与「地点符号 + 已落地名」碰撞则换；都不行就落在区域顶边并降透明度 | — |
| 地名落点 | 按 `priority`（都城 0 < 城/关 1 < 寺/镇 2 < 村/水 3 < 山 4）排序，每个点试 16 个方位；放不下则 `zoom:1.2~1.5` 放大后再出（`leader:true` 带引线） | — |
| 河名落点 | 沿水线 7 个位置 × 6 个偏移逐个试，挤不下就**不画**（宁可少一个字，也不压地名） | — |

## 4. 绘制规范（`mapSceneLayers`）

- 图层顺序：纸面 → 分区底纹 → 水 → 山 → 路线 → 地点 → 地名。全部 `fill/stroke` 走 `palette`，不写死颜色。
- 线宽与字号乘 `thin = 1 / scale`，放大时文字和线条不跟着变粗。
- 分级出字：`scale + 0.001 < label.zoom` 就不画；`scale` 为 1 时只出都/城/关/寺/镇。
- 地点符号：`capital` 双框 + 实心点、`city` 方框、`pass` 菱形、`temple` 屋顶、`water` 水纹、`village` 圆点、`mountain` 山形；点击热区半径 7.5（世界单位），`onPick` 回地点 id。
- 分区底纹：圆角虚线框 + `fillOpacity 0.05`，不描边太重；`pointer-events:none`。
- 全屏视图（`MapFull`）：`scale 1–8`，滚轮以鼠标为锚点缩放，拖动平移并夹在 `viewBox` 内，`重置` / `Esc` 关闭。

## 5. 怎么验证

```bash
node --test test/*.test.js        # 含 test/map-model.test.js 6 条（切 marker 里的纯函数跑）
node scripts/ui-e2e.mjs           # 地图段：.ndm-zone / .ndm-route / .ndm-pt / .ndm-label / 开关 / 放大 / 重置 / 关闭
node --test test/api.test.js      # 服务端 map.background 仍在（界面不再调用）
```

离线看一张真图：

```js
const M = require('./client.js-map-model')   // 或从 client.js 切 marker 求值
const svg = M.mapSceneToSvg(M.buildWorldMapScene({ world, locations, events }), scene.viewBox, { scale: 1 })
fs.writeFileSync('map.svg', svg)             // 浏览器直接打开
```

## 6. 已知取舍

- 只认作者手填的 `coords`：没有坐标的地点不上图（不猜位置）。
- AI 方案只是「分区/路线的提示」，缺了照样出图（按 `region` 与事件顺序兜底），不会因为没方案而变成空白。
- 地名密度靠缩放解决，不靠缩小字号：100% 时挤不下的名字放大才出现。
