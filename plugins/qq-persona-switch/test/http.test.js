// 这一层测「门」和「接线」：
//   · 回环 / Content-Type / Origin 三道门有没有真的挡住；
//   · apply() 到底把哪几条路由挂到了 webServer 上（少挂一条就是 404，而 404 会被
//     DSH 的 SPA fallback 吃成 HTML 200，界面上只会看到「解析失败」）；
//   · 配置留空时能不能从 qq-bridge 的 config.json 与 state/console-token 推导出来。

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  HttpError,
  isJsonRequest,
  isLoopbackRequest,
  isSameOriginRequest,
  readJsonBody,
  describeError,
} from '../lib/http.js'
import { BASE_PATH, apply, resolveSettings } from '../lib/index.js'

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
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'])
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
    },
  }
  return { ctx, routes }
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
  const settings = resolveSettings({})
  assert.equal(settings.bridgeBaseUrl, 'http://127.0.0.1:3100')
  assert.equal(settings.dshBaseUrl, 'http://127.0.0.1:3080')
  assert.equal(settings.token, '')
  assert.ok(settings.notes.some((line) => /工作区/.test(line)))
  assert.ok(settings.notes.some((line) => /令牌/.test(line)))
})

test('apply 挂上四条路由，并且页面能拿到', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, {})

  assert.deepEqual([...routes.keys()].sort(), [
    BASE_PATH,
    `${BASE_PATH}/`,
    `${BASE_PATH}/state`,
    `${BASE_PATH}/switch`,
  ].sort())

  const res = fakeRes()
  await routes.get(BASE_PATH)(fakeReq({ headers: { host: '127.0.0.1:3080' } }), res)
  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['content-type']), /text\/html/)
  assert.match(res.body, /人设总开关/)
  assert.match(String(res.headers['content-security-policy']), /default-src 'none'/)
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