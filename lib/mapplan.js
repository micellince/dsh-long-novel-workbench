/**
 * 世界地图 AI 方案解析与落库。
 *
 * 方案格式（纯文本）：
 *   【区域】
 *   区域名｜x1–x2｜y1–y2｜地貌
 *   【路线】
 *   起点→终点｜地形｜备注
 *   【坐标】
 *   地点名｜x｜y｜类型｜区域
 *   【绘制提示词】
 *   ……
 *
 * 落库：坐标写进 locations（coords + 可选 type/region），整段写进 world.mapStyle.aiPlan。
 */

const SECTION_RE = (name) => new RegExp(`【${name}】(.*?)(?=【|$)`, 's')

function section(text, name) {
  const hit = String(text || '').match(SECTION_RE(name))
  return hit ? hit[1].trim() : ''
}

function num(raw) {
  const hit = String(raw ?? '').match(/-?\d+(?:\.\d+)?/)
  return hit ? Number(hit[0]) : NaN
}

function clamp(value) {
  return Math.max(0, Math.min(1000, Math.round(value * 10) / 10))
}

export function parseMapPlan(text) {
  const raw = String(text || '')
  const coordBody = section(raw, '坐标') || section(raw, '地点坐标') || section(raw, '地点')
  const coordinates = []
  for (const line of coordBody.split(/\n+/)) {
    const clean = line.replace(/^[-*·\s]+/, '').trim()
    if (!clean || clean.includes('地点名')) continue
    const parts = clean.split(/[｜|]/).map((item) => item.trim())
    if (parts.length < 3) continue
    const x = num(parts[1])
    const y = num(parts[2])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    coordinates.push({
      name: parts[0],
      x: clamp(x),
      y: clamp(y),
      type: parts[3] || '',
      region: parts[4] || '',
    })
  }
  const regionBody = section(raw, '区域')
  const regions = regionBody.split(/\n+/).map((line) => line.replace(/^[-*·\s]+/, '').trim()).filter((line) => line.includes('｜') || line.includes('|'))
  const routeBody = section(raw, '路线')
  const routes = routeBody.split(/\n+/).map((line) => line.replace(/^[-*·\s]+/, '').trim()).filter(Boolean)
  const prompt = section(raw, '绘制提示词')
  return { coordinates, regions, routes, prompt }
}

function locationName(row) {
  return String(row?.name ?? '').trim()
}

function matchesLocation(row, name) {
  if (locationName(row) === name) return true
  const aliases = Array.isArray(row?.aliases) ? row.aliases.map(String) : []
  return aliases.includes(name)
}

/**
 * 把解析出的方案写入作品：坐标直接更新地点；整段存 world.mapStyle.aiPlan。
 * @param {{store:object, root:string, projectId:string, text:string, savedAt?:string}} input
 */
export async function applyMapPlan({ store, root, projectId, text, savedAt = '', baseMapStyle = null } = {}) {
  const planText = String(text || '').trim()
  if (!planText) throw Object.assign(new Error('方案文本为空'), { code: 'invalid' })
  const parsed = parseMapPlan(planText)
  const ledger = await store.getLedger(root, projectId)
  const locations = Array.isArray(ledger.locations) ? ledger.locations.slice() : []
  const updated = []
  const missing = []
  for (const coord of parsed.coordinates) {
    const index = locations.findIndex((row) => matchesLocation(row, coord.name))
    if (index < 0) { missing.push(coord.name); continue }
    const current = locations[index]
    const next = {
      ...current,
      coords: { x: coord.x, y: coord.y },
      ...(coord.type ? { type: coord.type } : {}),
      ...(coord.region ? { region: coord.region } : {}),
    }
    await store.upsertLedgerItem(root, projectId, 'locations', next)
    locations[index] = next
    updated.push(coord.name)
  }
  const at = savedAt || new Date().toISOString()
  const world = ledger.world && typeof ledger.world === 'object' ? ledger.world : {}
  const mapStyle = world.mapStyle && typeof world.mapStyle === 'object' ? world.mapStyle : {}
  await store.upsertLedgerItem(root, projectId, 'world', {
    mapStyle: { ...mapStyle, aiPlan: { text: planText, savedAt: at, source: 'ai' } },
    mapStyleUpdatedAt: at,
  })
  return {
    updated,
    missing,
    total: parsed.coordinates.length,
    regions: parsed.regions.length,
    routes: parsed.routes.length,
    hasPrompt: Boolean(parsed.prompt),
  }
}
