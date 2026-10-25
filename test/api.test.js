/**
 * host 层测试：RPC 清单、工具注册、路由/鉴权、boot 注入、baseHash 乐观锁。
 *
 * 不启动真实插件宿主：用 fake webServer/connection + 注入 fake store，
 * 临时根目录用 mkdtemp，绝不写 ~/StoryDesk。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  READ_OPS,
  WRITE_OPS,
  RPC_OPS,
  TOOLS,
  ROUTE,
  guard,
  injectBoot,
  createHandler,
  handleRpc,
  browserUrl,
  apply,
} from '../index.js'

// ── 测试替身 ────────────────────────────────────────────────

function fakeStore(overrides = {}) {
  const calls = []
  const base = {
    defaultRoot: () => '/tmp/nd-test-root',
    ensureRoot: async () => {},
    listProjects: async () => [{ id: 'p1', name: '测试书', title: '测试书', chapters: 1, words: 3200 }],
    getProject: async () => ({ id: 'p1', name: '测试书', workspacePath: '/tmp/ws', workspaceId: 'w1' }),
    getContext: async () => ({ project: { id: 'p1', title: '测试书' }, characters: [], facts: [], events: [], foreshadow: [], conflicts: [], locations: [], attention: [], runs: [], recent: [] }),
    listChapters: async () => [{ chapter: 1, id: 1, title: '第一章', words: 1200, status: 'draft', path: '/tmp/ch/0001.md' }],
    readChapter: async () => ({ chapter: 1, title: '第一章', text: '旧正文', meta: { contentHash: 'hash-current' } }),
    saveChapter: async (...args) => {
      calls.push(['saveChapter', ...args])
      return { chapter: 1, meta: { contentHash: 'hash-new' } }
    },
    listChapterHistory: async () => [{ version: 'v2' }],
    readChapterVersion: async () => ({ text: '旧版本正文' }),
    searchChapter: async () => [{ chapter: 1, snippet: '命中片段' }],
    getReviews: async () => [{ id: 'r1', chapter: 1, source: 'logic', status: 'open', severity: 'major', issue: '问题' }],
    addReviews: async (_root, _projectId, items) => ({ added: items.length }),
    patchReviews: async () => ({ patched: 1 }),
    getAttention: async () => [{ chapter: 1, score: 78, designScore: 90, breakdown: { hook: 22, tension: 18, payoff: 18, cliff: 20 }, recheckPending: false }],
    mergeAttention: async () => ({ chapter: 1 }),
    listProposals: async () => [{ id: 'pr1', chapter: 1, kind: 'patch-paragraph', status: 'pending', title: '补丁' }],
    getProposal: async () => ({ id: 'pr1', status: 'pending' }),
    createProposal: async () => ({ id: 'pr2' }),
    acceptProposal: async () => ({ ok: true }),
    rejectProposal: async () => ({ ok: true }),
    batchProposals: async () => ({ accepted: 1 }),
    getRun: async () => ({ status: 'running', kind: 'rewrite', scope: 'book' }),
    saveRun: async (_root, _projectId, patch) => ({ ...patch }),
    resetRun: async () => ({ reset: true }),
    getLedger: async () => ({ characters: [], facts: [] }),
    upsertLedgerItem: async () => ({ ok: true }),
    deleteLedgerItem: async () => ({ ok: true }),
    getSettings: async () => ({ budget: { maxTokens: 0 } }),
    saveSettings: async () => ({ ok: true }),
    usageSummary: async () => ({ sessions: [] }),
  }
  return { ...base, ...overrides, calls }
}

function fakeCtx({ connection, sessionController, toolsSink, webServer } = {}) {
  return {
    inject(services, fn) {
      if (webServer) fn({ webServer, get: (name) => (name === 'connection' ? connection : undefined), effect: () => {} })
    },
    get(name) {
      if (name === 'connection') return connection
      if (name === 'sessionController') return sessionController
      return undefined
    },
    tools: toolsSink ? { register: (tool) => toolsSink.push(tool) } : undefined,
  }
}

async function withServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// ── ⓪ 开新书：作品工作区 ───────────────────────────────────

test('project.create：新建作品时创建独立 DSH 工作区并写回 workspaceId', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nd-ws-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const base = join(root, 'base', 'default-workspace')
  const createdDirs = []
  const registry = {
    list: () => [{ id: 'w0', path: base, title: 'default-workspace' }],
    resolveByPath: async () => null,
    create: async (path, title) => {
      createdDirs.push({ path, title })
      return { id: 'w-new', path, title, setTitle: async () => {} }
    },
  }
  const patches = []
  const s = fakeStore({
    createProject: async (_root, input) => ({ id: 'pmnew', name: input.title, title: input.title, workspaceId: '', workspacePath: '' }),
    updateProject: async (_root, projectId, patch) => {
      patches.push({ projectId, patch })
      return { id: projectId, name: patch.workspaceTitle, title: patch.workspaceTitle, ...patch }
    },
  })
  const value = await handleRpc(
    { op: 'project.create', payload: { title: '泉州疑案' } },
    { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) },
    { store: s, root },
  )
  assert.equal(value.projectId, 'pmnew')
  assert.equal(value.workspaceId, 'w-new')
  assert.equal(createdDirs.length, 1)
  assert.equal(createdDirs[0].title, '泉州疑案')
  assert.ok(createdDirs[0].path.startsWith(base), createdDirs[0].path)
  assert.equal(patches.length, 1)
  assert.equal(patches[0].patch.workspaceId, 'w-new')
  assert.equal(patches[0].patch.workspaceTitle, '泉州疑案')

  // 宿主没有 workspaceRegistry 时不能报错：作品照样建好，只是没有独立工作区
  const plain = await handleRpc(
    { op: 'project.create', payload: { title: '无宿主' } },
    { get: () => undefined },
    { store: fakeStore({ createProject: async (_root, input) => ({ id: 'pmplain', name: input.title, title: input.title }) }), root },
  )
  assert.equal(plain.projectId, 'pmplain')
  assert.equal(plain.workspaceId, '')
})

test('chat.send：newSession 用作品自己的工作区新建会话，不投进现有会话', async () => {
  const created = []
  const prompted = []
  const controller = {
    list: async () => [{ sessionId: 's-old', cwd: '/tmp/ws', updatedAt: '2026-01-01' }],
    create: async ({ workspaceId }) => {
      created.push(workspaceId)
      return { sessionId: 's-new' }
    },
    prompt: async ({ sessionId }) => {
      prompted.push(sessionId)
      return { ok: true }
    },
  }
  const s = fakeStore({
    getProject: async () => ({ id: 'p1', name: '测试书', workspaceId: 'w1', workspacePath: '/tmp/ws' }),
  })
  const value = await handleRpc(
    { op: 'chat.send', payload: { projectId: 'p1', prompt: '写设定', newSession: true } },
    { get: (name) => (name === 'sessionController' ? controller : undefined) },
    { store: s, root: '/tmp/nd-test-root' },
  )
  assert.equal(value.sessionId, 's-new')
  assert.deepEqual(created, ['w1'])
  assert.deepEqual(prompted, ['s-new'])
})

// ── ① RPC 清单 ─────────────────────────────────────────────

test('RPC 恰好 41 op：读 20 + 写 21，清单与契约一致', () => {
  assert.equal(READ_OPS.length, 20)
  assert.equal(WRITE_OPS.length, 21)
  assert.equal(RPC_OPS.length, 41)
  assert.equal(new Set(RPC_OPS).size, 41)

  assert.deepEqual([...READ_OPS].sort(), [
    'align.status', 'chapter.get', 'chapter.history', 'chapter.list', 'chapter.search',
    'chapter.version', 'chat.sessions', 'export.book', 'ledger.get', 'ledger.sync', 'ping', 'preset.defaults', 'project.context', 'projects.list',
    'proposal.get', 'proposal.list', 'review.list', 'run.get', 'settings.get', 'usage.summary',
  ].sort())
  assert.deepEqual([...WRITE_OPS].sort(), [
    'app.open', 'attention.merge', 'chapter.delete', 'chapter.save', 'chat.send', 'import.run', 'import.scan',
    'ledger.delete', 'ledger.upsert', 'map.background', 'project.create', 'proposal.accept', 'proposal.batch', 'proposal.create',
    'proposal.reject', 'proposal.update', 'review.add', 'review.patch', 'run.reset', 'run.save', 'settings.save',
  ].sort())
})

test('app.open：browserUrl 复用宿主认证，缺 webServer 时报 invalid', () => {
  const fakeServer = { getOrigin: () => 'http://127.0.0.1:64615' }
  const tokenized = browserUrl({}, {
    webServer: fakeServer,
    connection: { authenticatedUrl: (base) => `${base}?token=fresh` },
  })
  assert.equal(tokenized, 'http://127.0.0.1:64615/?token=fresh#novel-desk=1')

  // 拿不到 connection（或 authenticatedUrl 抛错）时退回干净 URL，仍然可以复制给浏览器。
  assert.equal(browserUrl({}, { webServer: fakeServer }), 'http://127.0.0.1:64615/#novel-desk=1')

  assert.throws(
    () => browserUrl({}, {}),
    (error) => error.code === 'invalid',
  )
})

test('app.open：显式标记在 token/hash 之后仍只加一次', () => {
  const fakeServer = { getOrigin: () => 'http://127.0.0.1:64615/' }
  const withHash = browserUrl({}, {
    webServer: fakeServer,
    connection: { authenticatedUrl: (base) => `${base}?token=abc#/chat` },
  })
  assert.equal(withHash, 'http://127.0.0.1:64615/?token=abc#/chat&novel-desk=1')

  const already = browserUrl({}, {
    webServer: fakeServer,
    connection: { authenticatedUrl: (base) => `${base}?novel-desk=1` },
  })
  assert.equal(already, 'http://127.0.0.1:64615/?novel-desk=1')
})

// ── ② 7 个工具 + 注册 ──────────────────────────────────────

test('七个工具定义齐全、description ≤200 字', () => {
  assert.equal(TOOLS.length, 7)
  assert.deepEqual(TOOLS.map((tool) => tool.name), [
    'novel_desk_read', 'novel_desk_review', 'novel_desk_propose',
    'novel_desk_attention', 'novel_desk_write', 'novel_desk_run', 'novel_desk_map',
  ])
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 0, `${tool.name} 需要 description`)
    assert.ok(tool.description.length <= 200, `${tool.name} description 超过 200 字（${tool.description.length}）`)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
  }
})

test('apply：注册 7 工具 + 挂 prefix 路由 + tapIndex 注入 boot', () => {
  const registered = []
  const tools = []
  let tap = null
  const webServer = {
    register(options) {
      registered.push(options)
      return () => {}
    },
    tapIndex(fn) {
      tap = fn
      return () => {}
    },
    getOrigin() {
      return 'http://127.0.0.1:64615'
    },
  }
  const ctx = fakeCtx({ toolsSink: tools, webServer })
  apply(ctx)

  assert.equal(tools.length, 7)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, ROUTE)
  assert.equal(typeof registered[0].handler, 'function')
  assert.equal(typeof tap, 'function')

  const html = tap('<html><head><title>DSH</title></head><body></body></html>')
  assert.match(html, /window\.__ND_BOOT__=/)
  assert.match(html, /"apiUrl":"\/novel-desk\/api"/)
  assert.ok(html.indexOf('__ND_BOOT__') < html.indexOf('</head>'))
})

// ── ③ boot 注入转义 ────────────────────────────────────────

test('injectBoot：HTML/JS 字符串转义，幂等，插到 </head> 前', () => {
  const evil = 'http://127.0.0.1:1/"><script>alert(1)</script>'
  const html = injectBoot('<html><head></head><body></body></html>', { apiUrl: evil })
  assert.ok(html.includes('\\u003c'), '尖括号必须被转义')
  assert.ok(!html.includes('<script>alert(1)'), '不能出现可执行注入')
  assert.equal((html.match(/window\.__ND_BOOT__/g) ?? []).length, 1)

  const again = injectBoot(html, { apiUrl: evil })
  assert.equal((again.match(/window\.__ND_BOOT__/g) ?? []).length, 1, '重复注入应幂等')

  const noHead = injectBoot('<div>x</div>', { apiUrl: ROUTE })
  assert.ok(noHead.startsWith('<script>'))
})

// ── ④ 鉴权 ─────────────────────────────────────────────────

test('guard：无 connection 时回环 Host 放行、跨源 Host/站点拒绝', () => {
  assert.equal(guard({ headers: { host: '127.0.0.1:64615' } }, undefined), undefined)
  assert.equal(guard({ headers: { host: 'localhost:3000' } }, undefined), undefined)
  assert.equal(guard({ headers: { host: '[::1]:64615' } }, undefined), undefined)
  assert.equal(guard({ headers: { host: 'evil.example.com' } }, undefined), 403)
  assert.equal(guard({ headers: { host: '127.0.0.1:64615', 'sec-fetch-site': 'cross-site' } }, undefined), 403)
  assert.equal(guard({ headers: { host: '127.0.0.1:64615', 'sec-fetch-site': 'same-origin' } }, undefined), undefined)
})

test('guard：connection.requestRejection 优先，undefined 放行、401 拒绝、抛错落兜底', () => {
  const allow = { requestRejection: () => undefined }
  assert.equal(guard({ headers: { host: 'evil.example.com' } }, allow), undefined, 'connection 放行时不再看 Host')

  const deny = { requestRejection: () => 401 }
  assert.equal(guard({ headers: { host: '127.0.0.1:64615' } }, deny), 401)

  let seen = null
  const headersOnly = { requestRejection: (request) => { seen = request; return 403 } }
  assert.equal(guard({ headers: { host: '127.0.0.1:64615' } }, headersOnly), 403)
  assert.deepEqual(seen, { headers: { host: '127.0.0.1:64615' } }, 'requestRejection 接收 {headers}')

  const throws = { requestRejection: () => { throw new Error('boom') } }
  assert.equal(guard({ headers: { host: '127.0.0.1:64615' } }, throws), undefined, '抛错落到回环兜底：同机放行')
  assert.equal(guard({ headers: { host: 'evil.example.com' } }, throws), 403, '抛错落到回环兜底：外部拒绝')
})

// ── ⑤ baseHash 乐观锁 ──────────────────────────────────────

test('chapter.save：baseHash 与当前 contentHash 不一致 → stale，且不落盘', async () => {
  const s = fakeStore()
  await assert.rejects(
    () => handleRpc({ op: 'chapter.save', payload: { projectId: 'p1', chapter: 1, text: '新正文', baseHash: 'hash-stale' } }, {}, { store: s, root: '/tmp/nd-test-root' }),
    (error) => error.code === 'stale',
  )
  assert.equal(s.calls.filter((call) => call[0] === 'saveChapter').length, 0)
})

test('chapter.save：baseHash 匹配则落盘；缺 baseHash → invalid', async () => {
  const s = fakeStore()
  const saved = await handleRpc({ op: 'chapter.save', payload: { projectId: 'p1', chapter: 1, text: '新正文', baseHash: 'hash-current' } }, {}, { store: s, root: '/tmp/nd-test-root' })
  assert.equal(saved.meta.contentHash, 'hash-new')
  assert.equal(s.calls.filter((call) => call[0] === 'saveChapter').length, 1)

  await assert.rejects(
    () => handleRpc({ op: 'chapter.save', payload: { projectId: 'p1', chapter: 1, text: '新正文' } }, {}, { store: s, root: '/tmp/nd-test-root' }),
    (error) => error.code === 'invalid',
  )
})

test('chapter.save(create)：新章允许空正文建出来，已存在则不能重复新建', async () => {
  const s = fakeStore({
    readChapter: async (_root, _projectId, n) => {
      if (Number(n) === 4) throw Object.assign(new Error('not found'), { code: 'not-found' })
      return { chapter: 1, text: '旧正文', meta: { contentHash: 'hash-current' } }
    },
  })
  const created = await handleRpc(
    { op: 'chapter.save', payload: { projectId: 'p1', chapter: 4, text: '', create: true, meta: { title: '第 4 章' } } },
    {}, { store: s, root: '/tmp/nd-test-root' },
  )
  assert.equal(created.chapter, 1)
  const saveCall = s.calls.find((call) => call[0] === 'saveChapter')
  assert.equal(saveCall[6].allowEmpty, true, 'create 时允许空正文')
  assert.equal(saveCall[6].source, 'editor')

  await assert.rejects(
    () => handleRpc({ op: 'chapter.save', payload: { projectId: 'p1', chapter: 1, text: '', create: true } }, {}, { store: s, root: '/tmp/nd-test-root' }),
    (error) => error.code === 'invalid',
  )
  await assert.rejects(
    () => handleRpc({ op: 'chapter.save', payload: { projectId: 'p1', chapter: 4, text: '' } }, {}, { store: s, root: '/tmp/nd-test-root' }),
    (error) => error.code === 'invalid',
  )
})

test('align.status 派生：不找 store 要对齐函数、只读聚合', async () => {
  const s = fakeStore()
  const value = await handleRpc({ op: 'align.status', payload: { projectId: 'p1' } }, {}, { store: s, root: '/tmp/nd-test-root' })
  assert.equal(value.chapters, 1)
  assert.equal(value.words, 1200)
  assert.equal(value.openReviews, 1)
  assert.equal(value.pendingProposals, 1)
  assert.equal(value.attentionAvg, 78)
  assert.equal(value.ledgerCounts.characters, 0)
})

// ── ⑥ HTTP 层 ──────────────────────────────────────────────

test('HTTP：/ping 200、无 CORS 头；POST 非 JSON → 415；未知 op → ok:false', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nd-api-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const s = fakeStore()
  const handler = createHandler(fakeCtx(), { store: s, root: dir })
  await withServer(handler, async (port) => {
    const base = `http://127.0.0.1:${port}`

    const ping = await fetch(`${base}/ping`)
    assert.equal(ping.status, 200)
    assert.equal(ping.headers.get('access-control-allow-origin'), null)
    const pingBody = await ping.json()
    assert.equal(pingBody.ok, true)
    assert.equal(pingBody.value.name, 'novel-desk')
    assert.equal(pingBody.value.root, dir)
    assert.equal(pingBody.value.ops, 41)

    const wrongType = await fetch(`${base}/novel-desk/api`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ op: 'ping', payload: {} }),
    })
    assert.equal(wrongType.status, 415)
    assert.equal(wrongType.headers.get('access-control-allow-origin'), null)

    const unknown = await fetch(`${base}/novel-desk/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'nope', payload: {} }),
    })
    assert.equal(unknown.status, 200)
    const unknownBody = await unknown.json()
    assert.equal(unknownBody.ok, false)
    assert.equal(unknownBody.error.code, 'invalid')
    assert.equal(unknown.headers.get('access-control-allow-origin'), null)
  })
})

test('HTTP：connection 拒绝时请求被挡（401）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nd-api-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const deny = { requestRejection: () => 401 }
  const handler = createHandler(fakeCtx({ connection: deny }), { store: fakeStore(), root: dir })
  await withServer(handler, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/ping`)
    assert.equal(res.status, 401)
  })
})

test('HTTP：connection 放行时同源请求通过（200）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nd-api-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const allow = { requestRejection: () => undefined }
  const handler = createHandler(fakeCtx({ connection: allow }), { store: fakeStore(), root: dir })
  await withServer(handler, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/ping`)
    assert.equal(res.status, 200)
  })
})

test('map.background：底图只按作者自己的地点推地形，不预设某本书的河山', async () => {
  const os = await import('node:os')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const store = await import('../lib/store.js')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-map-bg-'))
  const project = await store.createProject(root, { title: '冰与火之歌测试' })
  const projectId = project.id
  for (const item of [
    { name: 'Winterfell', type: 'castle', coords: { x: 180, y: 120 } },
    { name: 'The Trident', type: 'river', coords: { x: 320, y: 260 } },
    { name: 'Riverrun', type: 'castle', coords: { x: 300, y: 300 } },
    { name: 'Harrenhal', type: 'ruin', coords: { x: 420, y: 300 } },
    { name: 'Frostfang Mountains', type: 'mountain', coords: { x: 150, y: 60 } },
  ]) await store.upsertLedgerItem(root, projectId, 'locations', item)
  const generated = await handleRpc({ op: 'map.background', payload: { projectId, seed: 3 } }, { get: () => undefined }, { root })
  const style = generated.style
  assert.ok(style.rivers.length >= 1, '河类型的点应被串成水系')
  assert.ok(style.rivers.every((row) => /水系/.test(row.label)), '水系标签用作者的坐标推出来，不写死黄河/汴河')
  assert.ok(style.rivers.every((row) => !/黄河|汴河|运河|蜀江/.test(row.label)), '不能出现某一本书的专名')
  assert.ok(style.ridges.length >= 1, '山形来自作者声明的 mountain/ruin 类地点 + 程序撒点')
  const world = await store.getLedger(root, projectId)
  assert.ok(world.world.mapStyle && world.world.mapStyle.seed === 3, 'mapStyle 落到 world.json')
})


// ── ⑦ 导入扫描：目录 / 单文件都不要求 0001.md ──────────────────

test('import.scan：任意命名目录按自然序成章，单文件按「第X章」拆章', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nd-import-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const s = fakeStore()
  const handler = createHandler(fakeCtx(), { store: s, root: dir })

  // 目录：任意文件名，含一个可以拆章的大文件
  const bookDir = join(dir, '某人的旧稿')
  await mkdir(bookDir, { recursive: true })
  await writeFile(join(bookDir, '开场.md'), '# 雨夜\n\n他推开门，屋里没有人。')
  await writeFile(join(bookDir, '10 归途.txt'), '这一章没有标题，用文件名当标题。\n\n他一路南行。')
  await writeFile(join(bookDir, '合集.txt'), '第一章 试炼\n\n北风很急。\n\n第二章 起程\n\n天亮了。')
  await writeFile(join(bookDir, 'notes.pdf'), '不是正文')

  await withServer(handler, async (port) => {
    const post = async (op, payload) => {
      const res = await fetch(`http://127.0.0.1:${port}/novel-desk/api`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, payload }),
      })
      return res.json()
    }

    const scan = await post('import.scan', { rootPath: bookDir })
    assert.equal(scan.ok, true, JSON.stringify(scan))
    assert.equal(scan.value.kind, 'dir')
    assert.ok(scan.value.files.length >= 4, `应拆出至少 4 章：${JSON.stringify(scan.value.files)}`)
    assert.deepEqual(scan.value.files.map((row) => row.chapter), scan.value.files.map((_, index) => index + 1))
    assert.ok(scan.value.files.some((row) => row.title.includes('雨夜')))
    assert.ok(scan.value.files.some((row) => row.fromSplit === true))

    // 单文件：两个「第X章」标题 → 两章
    const one = await post('import.scan', { rootPath: join(bookDir, '合集.txt') })
    assert.equal(one.ok, true, JSON.stringify(one))
    assert.equal(one.value.kind, 'file')
    assert.deepEqual(one.value.files.map((row) => row.title), ['试炼', '起程'])

    // 不存在的路径 → invalid
    const missing = await post('import.scan', { rootPath: join(dir, '不存在') })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'invalid')

    // 用量：没有 sessionController 时退回工作台记账形状，不炸
    const usage = await post('usage.summary', { projectId: 'p1' })
    assert.equal(usage.ok, true, JSON.stringify(usage))
    assert.ok(Array.isArray(usage.value.chat.sessions))
    assert.equal(typeof usage.value.chat.totalTokens, 'number')
    assert.equal(typeof usage.value.chat.costCNY, 'number')
  })
})

test('run.save：新建时补阶段模板并归一 kind/variant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nd-run-save-'))
  const s = fakeStore()
  const handler = createHandler(fakeCtx(), { store: s, root: dir })
  await withServer(handler, async (port) => {
    const post = async (op, payload) => {
      const res = await fetch(`http://127.0.0.1:${port}/novel-desk/api`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, payload }),
      })
      return res.json()
    }
    const made = await post('run.save', { projectId: 'p1', patch: { kind: 'continue', scope: 'range', chapter: 2, endChapter: 3, status: 'ready' } })
    assert.equal(made.ok, true, JSON.stringify(made))
    assert.equal(made.value.kind, 'continue')
    assert.equal(made.value.stages.length, 6)
    assert.equal(made.value.stages[0].status, 'running')
    assert.equal(made.value.stages[0].title, '先定注意力设计')
    assert.equal(made.value.currentStage, 'attention')

    // 旧值 rephrase → rewrite + style
    const legacy = await post('run.save', { projectId: 'p1', patch: { kind: 'rephrase', scope: 'book', status: 'ready' } })
    assert.equal(legacy.value.kind, 'rewrite')
    assert.equal(legacy.value.variant, 'style')
    assert.deepEqual(legacy.value.stages.map((row) => row.title), ['先定注意力设计', '文风校准', '逐章改写', '闸门校验'])

    // 只改状态时不覆盖已有阶段
    const kept = await post('run.save', { projectId: 'p1', patch: { status: 'paused' } })
    assert.equal(kept.value.stages, undefined)
  })
})

// ── ⑥ 账本同步：增量核对 + 全书分批 ──────────────────────

const FULL_STATUS = {
  pending: [],
  chapters: 40,
  full: {
    from: 1,
    to: 40,
    batchSize: 3,
    done: 1,
    total: 14,
    uncovered: [40],
    batches: [
      { index: 1, chapters: [7, 8, 9], from: 7, to: 9, count: 3, words: 6800, status: 'done', doneAt: 'x' },
      { index: 2, chapters: [10, 11, 12], from: 10, to: 12, count: 3, words: 0, status: 'pending', doneAt: null },
    ],
  },
}

function syncStore(overrides = {}) {
  return fakeStore({
    getProject: async () => ({ project: { id: 'p1', title: '测试书', genre: '悬疑' } }),
    listChapters: async () => [
      { chapter: 7, title: '雨夜', words: 2400 },
      { chapter: 8, title: '来客', words: 2300 },
      { chapter: 9, title: '问路', words: 2100 },
      { chapter: 10, title: '旧信', words: 2000 },
      { chapter: 11, title: '灯下', words: 1900 },
      { chapter: 12, title: '出城', words: 1800 },
    ],
    getLedger: async () => ({ characters: [{ name: '林默' }], facts: [], events: [], locations: [] }),
    ...overrides,
  })
}

test('ledger.sync：status / plan / batch-done / reset 转发到 store', async () => {
  const planned = []
  const batches = []
  const s = fakeStore({
    getLedgerSync: async () => ({ pending: [{ chapter: 3, reasons: ['x'] }], chapters: 5, full: null }),
    planLedgerSync: async (_root, _projectId, options) => {
      planned.push(options)
      return { pending: [], chapters: 5, full: { from: 1, to: 5 } }
    },
    completeLedgerSyncBatch: async (_root, _projectId, options) => {
      batches.push(options)
      return { pending: [], chapters: 5, full: { done: 1 } }
    },
    resetLedgerSync: async () => ({ pending: [], chapters: 5, full: null }),
  })
  const status = await handleRpc({ op: 'ledger.sync', payload: { projectId: 'p1' } }, {}, { store: s, root: '/tmp/nd-test-root' })
  assert.equal(status.pending.length, 1)
  assert.equal(status.chapters, 5)

  const plan = await handleRpc({ op: 'ledger.sync', payload: { projectId: 'p1', action: 'plan', from: 2, to: 8, batchSize: 4 } }, {}, { store: s, root: '/tmp/nd-test-root' })
  assert.deepEqual(planned, [{ from: 2, to: 8, batchSize: 4 }])
  assert.equal(plan.full.from, 1)

  const done = await handleRpc({ op: 'ledger.sync', payload: { projectId: 'p1', action: 'batch-done', batch: 2 } }, {}, { store: s, root: '/tmp/nd-test-root' })
  assert.deepEqual(batches, [{ batch: 2 }])
  assert.equal(done.full.done, 1)

  const reset = await handleRpc({ op: 'ledger.sync', payload: { projectId: 'p1', action: 'reset' } }, {}, { store: s, root: '/tmp/nd-test-root' })
  assert.equal(reset.full, null)

  await assert.rejects(
    handleRpc({ op: 'ledger.sync', payload: { projectId: 'p1', action: 'nope' } }, {}, { store: s, root: '/tmp/nd-test-root' }),
    (error) => error.code === 'invalid' && /不支持 action=nope/.test(error.message),
  )
})

test('ledger.sync workorder：全书模式按批生成工作单，没计划报错，全部完成返回 done', async () => {
  const s = syncStore({ getLedgerSync: async () => FULL_STATUS })
  const value = await handleRpc({ op: 'ledger.sync', payload: { projectId: 'p1', action: 'workorder', mode: 'full' } }, {}, { store: s, root: '/tmp/nd-test-root' })
  assert.match(value.prompt, /【全书账本同步工作单】第 2\/14 批/)
  assert.match(value.prompt, /第10–12章/)
  assert.match(value.prompt, /第10章《旧信》/, '工作单要带本批章节标题')
  assert.equal(value.batch.index, 2)
  assert.equal(value.full.total, 14)
  assert.equal(value.full.done, 1)
  assert.equal(value.chapters, 40)

  const first = await handleRpc({ op: 'ledger.sync', payload: { projectId: 'p1', action: 'workorder', mode: 'full', batch: 1 } }, {}, { store: s, root: '/tmp/nd-test-root' })
  assert.match(first.prompt, /第 1\/14 批/)
  assert.match(first.prompt, /第7–9章/)

  const noPlan = syncStore({ getLedgerSync: async () => ({ pending: [], chapters: 3, full: null }) })
  await assert.rejects(
    handleRpc({ op: 'ledger.sync', payload: { projectId: 'p1', action: 'workorder', mode: 'full' } }, {}, { store: noPlan, root: '/tmp/nd-test-root' }),
    (error) => error.code === 'invalid' && /还没有全书同步计划/.test(error.message),
  )

  const allDone = syncStore({
    getLedgerSync: async () => ({
      pending: [],
      chapters: 3,
      full: {
        from: 1,
        to: 3,
        batchSize: 3,
        done: 1,
        total: 1,
        uncovered: [],
        batches: [{ index: 1, chapters: [1, 2, 3], from: 1, to: 3, count: 3, words: 900, status: 'done', doneAt: 'x' }],
      },
    }),
  })
  const finished = await handleRpc({ op: 'ledger.sync', payload: { projectId: 'p1', action: 'workorder', mode: 'full' } }, {}, { store: allDone, root: '/tmp/nd-test-root' })
  assert.equal(finished.done, true)
  assert.equal(finished.prompt, '')

  // 不带 mode 仍是原来的增量核对工作单
  const legacy = await handleRpc(
    { op: 'ledger.sync', payload: { projectId: 'p1', action: 'workorder' } },
    {},
    {
      store: syncStore({
        getLedgerSync: async () => ({ pending: [{ chapter: 3, title: '第三章', reasons: ['账本里的「林默」不再出现在正文里'] }], chapters: 3, full: null }),
      }),
      root: '/tmp/nd-test-root',
    },
  )
  assert.match(legacy.prompt, /【账本同步工作单】/)
  assert.match(legacy.prompt, /第3章/)
  assert.equal(legacy.full, null)
})
