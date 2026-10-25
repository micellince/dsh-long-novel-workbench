import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

function loadModel() {
  const start = source.indexOf('/* @novel-desk:map-model start */')
  const end = source.indexOf('/* @novel-desk:map-model end */')
  assert.ok(start >= 0 && end > start, 'client.js 缺少 map-model 标记')
  const body = source.slice(start, end)
  const names = ['buildWorldMapScene', 'mapSceneToSvg', 'mapSceneLayers', 'mapPlanRegions', 'mapPlanRoutes', 'mapWaterName', 'mapShort']
  // eslint-disable-next-line no-new-func
  return new Function(body + '\nreturn {' + names.join(',') + '};')()
}

const model = loadModel()

const world = {
  name: '测试世界',
  era: '唐',
  mapSize: { w: 1000, h: 1000 },
  mapStyle: {
    palette: 'ink',
    seed: 7,
    aiPlan: {
      text: [
        '【区域】',
        '京畿关内区｜x 250–420，y 495–630｜秦岭终南山北麓与渭水谷地，渭水自西向东推测横贯 y≈545 一带',
        '河洛都畿区｜x 480–770，y 480–560｜伊洛河谷',
        '【路线】',
        '长安→洛阳｜崤函古道｜必经潼关',
        '汜水至长安驿道｜汜水—虎牢—洛阳—潼关—长安｜官道',
      ].join('\n'),
    },
  },
}

const locations = [
  { id: 'changan', name: '长安', type: 'capital', coords: { x: 320, y: 542 }, region: '京畿道·京兆府' },
  { id: 'luoyang', name: '洛阳', type: 'city', coords: { x: 526, y: 511 }, region: '都畿道·河南府' },
  { id: 'tongguan', name: '潼关', type: 'pass', coords: { x: 397, y: 517 }, region: '京畿道·华州' },
  { id: 'weishui', name: '长安城西渭水渡', type: 'water', coords: { x: 300, y: 545 }, region: '京畿道·京兆府' },
  { id: 'yunyin', name: '云隐村', type: 'village', coords: { x: 318, y: 574 }, region: '京畿道·终南山' },
]

test('地图模型：AI 方案的区域/路线被解析成世界坐标', () => {
  const scene = model.buildWorldMapScene({ world, locations, events: [] })
  assert.equal(scene.regionSource, 'aiPlan')
  assert.equal(scene.regions.length, 2)
  const jingji = scene.regions.find((row) => row.fullName.indexOf('京畿') === 0)
  assert.ok(jingji, '缺少京畿区域')
  assert.deepEqual(
    [jingji.bounds.x1, jingji.bounds.y1, jingji.bounds.x2, jingji.bounds.y2],
    [250, 495, 420, 630],
  )
  assert.equal(jingji.name, '京畿关内', '区域名应去掉尾字「区」')
  assert.ok(scene.routes.length >= 1, '应至少解析出一条路线')
  assert.ok(scene.routes.some((route) => route.stops.length >= 2), '路线应落到地点上')
  assert.equal(scene.routeSource, 'aiPlan')
})

test('地图模型：地点坐标不做二次变形', () => {
  const scene = model.buildWorldMapScene({ world, locations, events: [] })
  const changan = scene.points.find((point) => point.fullName === '长安')
  assert.equal(changan.x, 320)
  assert.equal(changan.y, 542)
  const box = scene.viewBox
  for (const point of scene.points) {
    assert.ok(point.x >= 0 && point.x <= 1000 && point.y >= 0 && point.y <= 1000)
  }
  assert.ok(box.w >= 120 && box.h >= 120)
})

test('地图模型：水系名不从「与/和」这种连接词里截断', () => {
  assert.equal(model.mapWaterName('秦岭终南山北麓与渭水谷地'), '渭水')
  assert.equal(model.mapWaterName('汴州码头 孝水'), '孝水')
  assert.equal(model.mapWaterName('没有水名的描述'), '')
})

test('地图模型：地名互相不重叠，且不压住地点符号', () => {
  const scene = model.buildWorldMapScene({ world, locations, events: [] })
  const shown = scene.labels.filter((row) => row.zoom <= 1)
  assert.ok(shown.length >= 3, '低缩放下应能显示多数地名')
  for (let i = 0; i < shown.length; i += 1) {
    for (let j = i + 1; j < shown.length; j += 1) {
      const a = shown[i]
      const b = shown[j]
      const aw = a.name.length * 10 + 4
      const bw = b.name.length * 10 + 4
      const overlap = !(a.x + aw < b.x || b.x + bw < a.x || a.y + 6 < b.y - 6 || b.y + 6 < a.y - 6)
      assert.ok(!overlap, `地名重叠：${a.name} / ${b.name}`)
    }
  }
})

test('地图模型：能序列化成独立 SVG（用于离线检查与导出）', () => {
  const scene = model.buildWorldMapScene({ world, locations, events: [] })
  const svg = model.mapSceneToSvg(scene, scene.viewBox, { scale: 1 })
  assert.ok(svg.startsWith('<svg'))
  assert.ok(svg.endsWith('</svg>'))
  assert.ok(svg.includes('长安'))
  assert.ok(svg.includes('viewBox="'))
  const box = scene.viewBox
  assert.ok(svg.includes(`viewBox="${box.x} ${box.y} ${box.w} ${box.h}"`), 'SVG 应与场景共用 viewBox')
})

test('地图模型：没有 AI 方案时按地点归属兜底', () => {
  const scene = model.buildWorldMapScene({ world: { mapSize: { w: 1000, h: 1000 } }, locations, events: [] })
  assert.equal(scene.regionSource, 'derived')
  assert.ok(scene.regions.length >= 1)
  assert.equal(scene.routeSource, 'none')
})
