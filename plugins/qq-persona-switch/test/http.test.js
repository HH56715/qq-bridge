// 这一层测「门」和「接线」：
//   · 回环 / Content-Type / Origin 三道门有没有真的挡住；
//   · apply() 到底把哪几条路由挂到了 webServer 上（少挂一条就是 404，而 404 会被
//     DSH 的 SPA fallback 吃成 HTML 200，界面上只会看到「解析失败」）；
//   · 配置留空时能不能从 qq-bridge 的 config.json 与 state/console-token 推导出来。

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const PERSONA_PATH = '/api/dsh-persona-dafeiyu'

import {
  HttpError,
  isJsonRequest,
  isLoopbackRequest,
  isSameOriginRequest,
  readJsonBody,
  describeError,
} from '../lib/http.js'
import { BASE_PATH, apply, discoverBridgeDir, looksLikeBridgeDir, resolveSettings } from '../lib/index.js'

/** 造一棵「桥 + 工作区同级」的假目录树，用来测自动发现。 */
function fakeLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qps-layout-'))
  const workspace = path.join(root, 'qq-workspace')
  const bridge = path.join(root, 'qq-bridge')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(path.join(bridge, 'src'), { recursive: true })
  fs.mkdirSync(path.join(bridge, 'state'), { recursive: true })
  fs.writeFileSync(path.join(bridge, 'src', 'bridge.js'), '// stub\n', 'utf8')
  fs.writeFileSync(path.join(bridge, 'config.json'), JSON.stringify({
    consolePort: 3197,
    consoleToken: '',
    sessionCwd: workspace,
    dsh: { baseUrl: 'http://127.0.0.1:3997' },
  }), 'utf8')
  fs.writeFileSync(path.join(bridge, 'state', 'console-token'), 'discovered-token\n', 'utf8')
  return { root, workspace, bridge }
}

/**
 * 造一个「已经跑过一阵子」的桥目录：config.json + 会话映射 + 人格卡 + 本插件状态。
 * 按对话的逻辑全依赖这几个文件，所以宁可在这里把真实形状摆全，也别在断言里猜。
 */
function tempBridgeDir({ store = null, sessions = {}, roles = {}, consoleToken = 'token-x' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qps-bridge-'))
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'roles'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'bridge.js'), '// stub\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    consolePort: 3188,
    consoleToken: '',
    sessionCwd: dir,
    dsh: { baseUrl: 'http://127.0.0.1:3998' },
    role: { maxInjectChars: 6000 },
  }), 'utf8')
  fs.writeFileSync(path.join(dir, 'state', 'console-token'), `${consoleToken}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'state', 'sessions.json'), JSON.stringify({ version: 1, sessions, sessionPolicies: {} }), 'utf8')
  fs.writeFileSync(path.join(dir, 'state', 'mode.json'), JSON.stringify({ mode: 'chat', closedAgentPreset: '' }), 'utf8')
  if (store !== null) {
    fs.writeFileSync(path.join(dir, 'state', 'qq-persona-switch.json'), JSON.stringify(store), 'utf8')
  }
  for (const [name, text] of Object.entries(roles)) {
    fs.writeFileSync(path.join(dir, 'roles', `${name}.md`), text, 'utf8')
  }
  return dir
}

function fakeReq({ method = 'GET', headers = {}, body = null, remoteAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: '127.0.0.1:3080', ...headers }
  req.socket = { remoteAddress }
  req.destroy = () => {}
  if (body !== null) {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    setImmediate(() => {
      req.emit('data', Buffer.from(text, 'utf8'))
      req.emit('end')
    })
  }
  return req
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk ?? ''
      this.ended = true
    },
  }
}

function fakeCtx() {
  const routes = new Map()
  const sections = []
  const ctx = {
    inject(deps, callback) {
      assert.equal(deps.length, 1, 'apply 每次只注入一个服务')
      const dep = deps[0]
      if (dep === 'webServer') {
        callback({
          webServer: {
            register(def) {
              routes.set(def.path, def.handler)
              return () => routes.delete(def.path)
            },
          },
          effect(factory) {
            return factory()
          },
        })
        return
      }
      if (dep === 'systemPrompt') {
        callback({
          systemPrompt: {
            section(def) {
              sections.push(def)
              return () => {}
            },
          },
          effect(factory) {
            return factory()
          },
        })
        return
      }
      assert.fail(`意外的注入依赖：${dep}`)
    },
  }
  return { ctx, routes, sections }
}

test('回环判定：Host 与对端地址都必须是本机', () => {
  assert.equal(isLoopbackRequest(fakeReq()), true)
  assert.equal(isLoopbackRequest(fakeReq({ headers: { host: 'localhost:3080' } })), true)
  assert.equal(isLoopbackRequest(fakeReq({ headers: { host: '[::1]:3080' } })), true)
  // DNS rebinding：Host 是外部域名，即使连接来自本机也拒绝
  assert.equal(isLoopbackRequest(fakeReq({ headers: { host: 'evil.example.com:3080' } })), false)
  assert.equal(isLoopbackRequest(fakeReq({ headers: { host: '' } })), false)
  // 非回环来源
  assert.equal(isLoopbackRequest(fakeReq({ remoteAddress: '192.168.1.9' })), false)
})

test('Content-Type 与 Origin 的门', () => {
  assert.equal(isJsonRequest(fakeReq({ headers: { 'content-type': 'application/json' } })), true)
  assert.equal(isJsonRequest(fakeReq({ headers: { 'content-type': 'application/json; charset=utf-8' } })), true)
  assert.equal(isJsonRequest(fakeReq({ headers: { 'content-type': 'text/plain' } })), false)
  assert.equal(isJsonRequest(fakeReq()), false)

  assert.equal(isSameOriginRequest(fakeReq()), true, '缺 Origin 视为同源（fetch/curl 都不带）')
  assert.equal(isSameOriginRequest(fakeReq({ headers: { origin: 'http://127.0.0.1:3080' } })), true)
  assert.equal(isSameOriginRequest(fakeReq({ headers: { origin: 'http://evil.example.com' } })), false)
  assert.equal(isSameOriginRequest(fakeReq({ headers: { origin: 'http://127.0.0.1:9999' } })), false)
})

test('readJsonBody 拒绝超长与非 JSON', async () => {
  await assert.rejects(() => readJsonBody(fakeReq({ body: { source: 'role' } }), 8), (error) => {
    assert.ok(error instanceof HttpError)
    assert.equal(error.status, 413)
    return true
  })
  await assert.rejects(() => readJsonBody(fakeReq({ body: 'not json' })), (error) => {
    assert.equal(error.status, 400)
    return true
  })
  await assert.rejects(() => readJsonBody(fakeReq({ body: '[1,2]' })), (error) => {
    assert.equal(error.status, 400)
    return true
  })
  assert.deepEqual(await readJsonBody(fakeReq({ body: { source: 'role', id: '塔菲' } })), { source: 'role', id: '塔菲' })
  assert.deepEqual(await readJsonBody(fakeReq({ body: '' })), {})
})

test('describeError 把「上游连不上」归成 502 而不是 500', () => {
  assert.equal(describeError(new HttpError(403, 'x')).status, 403)
  assert.equal(describeError(new Error('GET http://x 失败：ECONNREFUSED')).status, 502)
  assert.equal(describeError(new Error('请求超时（4000ms）')).status, 502)
  assert.equal(describeError(new Error('代码里炸了')).status, 500)
})

test('resolveSettings 从 qq-bridge 的 config.json 与 console-token 推导', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qps-settings-'))
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      consolePort: 3199,
      consoleToken: '',
      sessionCwd: 'D:\\work\\qq-workspace',
      dsh: { baseUrl: 'http://127.0.0.1:3999' },
    }), 'utf8')
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'state', 'console-token'), 'token-from-file\n', 'utf8')

    const settings = resolveSettings({ bridgeDir: dir })
    assert.equal(settings.bridgeBaseUrl, 'http://127.0.0.1:3199')
    assert.equal(settings.dshBaseUrl, 'http://127.0.0.1:3999')
    assert.equal(settings.workspaceCwd, 'D:\\work\\qq-workspace')
    assert.equal(settings.token, 'token-from-file')
    assert.deepEqual(settings.notes, [])

    // 显式配置优先于文件
    const overridden = resolveSettings({ bridgeDir: dir, bridgeBaseUrl: 'http://127.0.0.1:1', consoleToken: 'explicit' })
    assert.equal(overridden.bridgeBaseUrl, 'http://127.0.0.1:1')
    assert.equal(overridden.token, 'explicit')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSettings 在什么都没有时给出可读的 notes', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'qps-empty-'))
  try {
    const settings = resolveSettings({}, { cwd: empty, env: {} })
    assert.equal(settings.bridgeBaseUrl, 'http://127.0.0.1:3100')
    assert.equal(settings.dshBaseUrl, 'http://127.0.0.1:3080')
    assert.equal(settings.token, '')
    assert.equal(settings.bridgeDir, '')
    assert.ok(settings.notes.some((line) => /qq-bridge 目录/.test(line)))
    assert.ok(settings.notes.some((line) => /工作区/.test(line)))
    // 找不到目录时不该再叠一条「没有令牌」的噪音：上一条已经把该做的事说完了
    assert.ok(!settings.notes.some((line) => /令牌/.test(line)))
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }
})

test('looksLikeBridgeDir 只认真正的桥目录', () => {
  const { root, bridge } = fakeLayout()
  try {
    assert.equal(looksLikeBridgeDir(bridge), true)
    // 有 config.json 但没有桥的任何特征 —— 不算
    const decoy = path.join(root, 'decoy')
    fs.mkdirSync(decoy, { recursive: true })
    fs.writeFileSync(path.join(decoy, 'config.json'), '{"a":1}', 'utf8')
    assert.equal(looksLikeBridgeDir(decoy), false)
    assert.equal(looksLikeBridgeDir(path.join(root, 'nope')), false)
    // 只有 package.json 里的名字也算（bridge 刚 clone、还没跑过时没有 state/）
    const fresh = path.join(root, 'fresh')
    fs.mkdirSync(fresh, { recursive: true })
    fs.writeFileSync(path.join(fresh, 'config.json'), '{}', 'utf8')
    fs.writeFileSync(path.join(fresh, 'package.json'), '{"name":"qq-bridge"}', 'utf8')
    assert.equal(looksLikeBridgeDir(fresh), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('discoverBridgeDir 从工作区向上找到同级的 qq-bridge', () => {
  const { root, workspace, bridge } = fakeLayout()
  try {
    // 市场安装后的真实情形：工作区在桥的隔壁
    const found = discoverBridgeDir({ workspaceCwd: workspace, cwd: root, env: {} })
    assert.ok(found, '应该找到 qq-bridge')
    assert.equal(path.resolve(found.dir), path.resolve(bridge))
    assert.match(found.source, /upward from/)

    // 从更深的子目录也应该能上去
    const deep = path.join(workspace, 'a', 'b')
    fs.mkdirSync(deep, { recursive: true })
    assert.equal(path.resolve(discoverBridgeDir({ cwd: deep, env: {} }).dir), path.resolve(bridge))

    // 环境变量优先
    const viaEnv = discoverBridgeDir({ cwd: path.parse(root).root, env: { QQ_BRIDGE_DIR: bridge } })
    assert.equal(path.resolve(viaEnv.dir), path.resolve(bridge))
    assert.equal(viaEnv.source, 'env QQ_BRIDGE_DIR')

    // 找不到就是 null，不许乱猜（用一棵与之无关的树，别让 root 那棵干扰）
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'qps-isolated-'))
    try {
      assert.equal(discoverBridgeDir({ cwd: path.join(isolated, 'x'), env: {} }), null)
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolveSettings 在 bridgeDir 留空时自动发现并照常推导出端口与令牌', () => {
  const { root, workspace, bridge } = fakeLayout()
  try {
    const settings = resolveSettings({ workspaceCwd: workspace }, { cwd: root, env: {} })
    assert.equal(path.resolve(settings.bridgeDir), path.resolve(bridge))
    assert.match(settings.bridgeDirSource, /upward from/)
    assert.equal(settings.bridgeBaseUrl, 'http://127.0.0.1:3197')
    assert.equal(settings.dshBaseUrl, 'http://127.0.0.1:3997')
    assert.equal(settings.token, 'discovered-token')
    assert.equal(settings.workspaceCwd, workspace)
    assert.deepEqual(settings.notes, [])

    // 显式填了就用显式的，不做发现
    const explicit = resolveSettings({ bridgeDir: bridge }, { cwd: path.parse(root).root, env: {} })
    assert.equal(explicit.bridgeDirSource, 'config')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('apply 挂上全部路由与提示词段落', async () => {
  const { ctx, routes, sections } = fakeCtx()
  apply(ctx, {})

  assert.deepEqual([...routes.keys()].sort(), [
    BASE_PATH,
    `${BASE_PATH}/`,
    `${BASE_PATH}/state`,
    `${BASE_PATH}/switch`,
    `${BASE_PATH}/mode`,
    `${BASE_PATH}/assign`,
    `${BASE_PATH}/sync`,
  ].sort())

  // 段落必须注册：按对话模式全靠它注入人格卡，漏了就是「模式切了但没人设」
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'qq-persona-switch:role')
  assert.equal(sections[0].interpolate, false)
  assert.equal(typeof sections[0].text, 'function')

  const res = fakeRes()
  await routes.get(BASE_PATH)(fakeReq({ headers: { host: '127.0.0.1:3080' } }), res)
  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['content-type']), /text\/html/)
  assert.match(res.body, /人设总开关/)
  assert.match(res.body, /按对话各自指定/)
  assert.match(String(res.headers['content-security-policy']), /default-src 'none'/)
})

test('提示词段落在全局模式下什么都不注入', () => {
  const { ctx, sections } = fakeCtx()
  const dir = tempBridgeDir()
  try {
    apply(ctx, { bridgeDir: dir })
    const text = sections[0].text({ agent: { session: { header: { id: 'session-a' } } } })
    assert.equal(text, '')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('提示词段落在按对话模式下按会话注入对应人格卡', () => {
  const dir = tempBridgeDir({
    store: {
      version: 1,
      mode: 'perChat',
      assignments: { 'group:111': { source: 'role', id: '塔菲' }, 'group:222': { source: 'role', id: '小鲸鱼' } },
    },
    sessions: { 'group:111': 'session-111', 'group:222': 'session-222' },
    roles: { 塔菲: '塔菲的正文', 小鲸鱼: '小鲸鱼的正文' },
  })
  const { ctx, sections } = fakeCtx()
  try {
    apply(ctx, { bridgeDir: dir })
    const at = (id) => sections[0].text({ agent: { session: { header: { id } } } })
    assert.match(at('session-111'), /塔菲的正文/)
    assert.match(at('session-222'), /小鲸鱼的正文/)
    // 没指定过的会话：perChat 下全局注入都关着，所以必须是空的
    assert.equal(at('session-unknown'), '')
    // 上下文缺 id（比如非 QQ 会话）时也不能炸
    assert.equal(sections[0].text({}), '')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('state 路由在两侧都不可达时仍然回 200，并把原因摊在 warnings / reachable 上', async () => {
  const { ctx, routes } = fakeCtx()
  // 端口 1 必定拒绝连接，两个客户端都会快速失败
  apply(ctx, { bridgeBaseUrl: 'http://127.0.0.1:1', dshBaseUrl: 'http://127.0.0.1:1', workspaceCwd: 'D:\\w' })

  const res = fakeRes()
  await routes.get(`${BASE_PATH}/state`)(fakeReq({ headers: { host: '127.0.0.1:3080' } }), res)

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.bridge.reachable, false)
  assert.equal(payload.plugin.reachable, false)
  assert.ok(payload.bridge.error)
  assert.equal(payload.active.source, 'none')
})

test('switch 路由的三道门与参数校验', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, { workspaceCwd: 'D:\\w' })
  const handler = routes.get(`${BASE_PATH}/switch`)

  const wrongMethod = fakeRes()
  await handler(fakeReq({ method: 'GET', headers: { host: '127.0.0.1:3080' } }), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)

  const wrongType = fakeRes()
  await handler(fakeReq({ method: 'POST', headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain' }, body: {} }), wrongType)
  assert.equal(wrongType.statusCode, 415)

  const crossSite = fakeRes()
  await handler(fakeReq({
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', origin: 'http://evil.example.com' },
    body: { source: 'none' },
  }), crossSite)
  assert.equal(crossSite.statusCode, 403)

  const badSource = fakeRes()
  await handler(fakeReq({
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    body: { source: 'neither' },
  }), badSource)
  assert.equal(badSource.statusCode, 400)
  assert.match(JSON.parse(badSource.body).error, /source/)
})

/**
 * 起一个同时扮演「桥接控制台」和「dsh-persona-dafeiyu」的本机 HTTP 服务。
 *
 * 这一层是唯一能证明「路由 → 客户端 → 上游 HTTP → 落盘」整条链没断的地方：
 * 单测里两个上游都是假对象，假对象永远配合，真实的 URL 拼错、请求方法用错是测不出来的。
 */
async function startUpstreams({ role = null, sessions = {} } = {}) {
  const calls = []
  let bridgeRole = role
  const state = { current: null, mode: 'workspace', workspacePersona: null, sessionPicks: {} }

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const body = raw.length > 0 ? JSON.parse(raw) : {}
      calls.push({ method: req.method, path: url.pathname, body })
      const send = (payload) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (url.pathname === '/api/roles') {
        send({ ok: true, roles: ['塔菲', '小鲸鱼'], summaries: [], current: bridgeRole, limits: { maxInjectChars: 6000 } })
        return
      }
      if (url.pathname === '/api/status') {
        send({ ok: true, mode: 'chat', role: bridgeRole, roleMode: 'active' })
        return
      }
      if (url.pathname === '/api/role' && req.method === 'POST') {
        bridgeRole = body.role ?? null
        send({ ok: true, role: bridgeRole })
        return
      }
      if (url.pathname === `${PERSONA_PATH}/status`) {
        const effective = state.current ? { id: state.current, name: state.current, source: 'global', enabled: true } : null
        send({
          ok: true,
          value: {
            plugin: 'dsh-persona-dafeiyu',
            enabled: true,
            current: state.current,
            globalOff: state.current === null,
            mode: state.mode,
            workspaces: [{ cwd: state.workspaceCwd ?? null, personaId: state.workspacePersona }],
            sessionId: null,
            personas: [{ id: 'dafeiyu', name: '大肥鱼', enabled: true, chars: 900 }],
            effective,
          },
        })
        return
      }
      if (url.pathname === `${PERSONA_PATH}/mutate` && req.method === 'POST') {
        const action = body.action
        if (action === 'set-current') state.current = body.id ?? null
        if (action === 'set-mode') state.mode = body.mode
        if (action === 'set-workspace-persona') {
          state.workspaceCwd = body.cwd
          state.workspacePersona = body.personaId ?? null
        }
        if (action === 'set-session-persona') state.sessionPicks[body.sessionId] = body
        send({ ok: true })
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { url: `http://127.0.0.1:${port}`, calls, state, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('mode / assign / sync 走真实 HTTP 打到两个上游，并把状态落盘', async () => {
  const upstream = await startUpstreams({ role: '小鲸鱼', sessions: {} })
  const dir = tempBridgeDir({
    consoleToken: 'tok',
    sessions: { 'group:111': 'session-a' },
    roles: { 塔菲: '塔菲正文', 小鲸鱼: '小鲸鱼正文' },
  })
  try {
    const { ctx, routes } = fakeCtx()
    apply(ctx, {
      bridgeDir: dir,
      bridgeBaseUrl: upstream.url,
      dshBaseUrl: upstream.url,
      consoleToken: 'tok',
      workspaceCwd: dir,
    })

    // 进按对话模式：桥接全局卡必须被清掉，插件切到 session 档
    const modeRes = fakeRes()
    await routes.get(`${BASE_PATH}/mode`)(fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { mode: 'perChat' },
    }), modeRes)
    assert.equal(modeRes.statusCode, 200)
    const modeBody = JSON.parse(modeRes.body)
    assert.equal(modeBody.mode, 'perChat')
    assert.equal(modeBody.changed, true)

    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'qq-persona-switch.json'), 'utf8'))
    assert.equal(stored.mode, 'perChat')
    assert.equal(stored.snapshot.bridgeRole, '小鲸鱼')
    assert.equal(upstream.state.mode, 'session')
    assert.equal(upstream.state.current, null)

    // 给一个已有会话的群指定人格卡
    const assignRes = fakeRes()
    await routes.get(`${BASE_PATH}/assign`)(fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { chatKey: 'group:111', source: 'role', id: '塔菲' },
    }), assignRes)
    assert.equal(assignRes.statusCode, 200)
    const assignBody = JSON.parse(assignRes.body)
    assert.equal(assignBody.pending, false)
    assert.equal(assignBody.perChat.chats[0].key, 'group:111')
    // 人格卡走「让 dafeiyu 在本会话闭嘴」这条路
    assert.equal(upstream.state.sessionPicks['session-a'].none, true)

    // 按对话模式下拒绝整体切换（否则桥接 role 会被写回来，跟本模式打架）
    const switchRes = fakeRes()
    await routes.get(`${BASE_PATH}/switch`)(fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { source: 'role', id: '小鲸鱼' },
    }), switchRes)
    assert.equal(switchRes.statusCode, 400)
    assert.match(JSON.parse(switchRes.body).error, /按对话/)

    // state 把 perChat 一起带出来
    const stateRes = fakeRes()
    await routes.get(`${BASE_PATH}/state`)(fakeReq(), stateRes)
    const stateBody = JSON.parse(stateRes.body)
    assert.equal(stateBody.perChat.mode, 'perChat')
    assert.equal(stateBody.perChat.chats.length, 1)
    assert.equal(stateBody.perChat.assignments['group:111'].id, '塔菲')
    assert.equal(stateBody.settings.hasToken, true)

    // 退出：快照还回去
    const exitRes = fakeRes()
    await routes.get(`${BASE_PATH}/mode`)(fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { mode: 'global' },
    }), exitRes)
    assert.equal(JSON.parse(exitRes.body).mode, 'global')
    assert.equal(upstream.state.mode, 'workspace')
    assert.equal(upstream.state.workspacePersona, null)
    // 桥接的全局卡被恢复（快照里是「小鲸鱼」）
    // 桥接的「清除」就是发空对象（`!body.role` 分支），所以这里也照真机形状断言
    const roleCalls = upstream.calls.filter((call) => call.path === '/api/role')
    assert.deepEqual(roleCalls.map((call) => call.body.role ?? null), [null, '小鲸鱼'])

    const after = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'qq-persona-switch.json'), 'utf8'))
    assert.equal(after.mode, 'global')
    assert.equal(after.snapshot, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    await upstream.close()
  }
})