// 这一层不碰 DSH、不碰网络：两个上游都是注入进来的假对象。
// 测的是「谁先写、失败怎么收尾」这类真正会咬人的语义，而不是 HTTP 样板。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  UpstreamError,
  createBridgeClient,
  createPersonaClient,
  normalizeBaseUrl,
  readState,
  switchPersona,
} from '../lib/switch-core.js'

const CWD = 'C:\\work\\qq-workspace'

function jsonResponse(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(data),
  }
}

/**
 * 一个能同时演桥接、DSH 人设插件、以及「坏掉的那一侧」的假服务。
 * 所有请求都记进 `calls`，顺序断言就靠它。
 */
function fakeUpstreams(options = {}) {
  const calls = []
  const cfg = {
    role: options.role ?? null,
    roleNames: options.roleNames ?? ['小鲸鱼', '塔菲'],
    pluginCurrent: options.pluginCurrent ?? null,
    pluginMode: options.pluginMode ?? 'workspace',
    globalOff: options.globalOff ?? true,
    workspacePersona: options.workspacePersona ?? 'atri',
    personas: options.personas ?? [
      { id: 'chaye', name: '阿茶', enabled: true, chars: 1200 },
      { id: 'tinglan', name: '听澜', enabled: true, chars: 900 },
      { id: 'disabled-one', name: '禁用的', enabled: false, chars: 10 },
    ],
    bridgeToken: options.bridgeToken ?? 'secret-token',
    failBridgeWrite: options.failBridgeWrite ?? false,
    failPersonaWrite: options.failPersonaWrite ?? false,
    failPersonaStatus: options.failPersonaStatus ?? false,
    failBridgeUnreachable: options.failBridgeUnreachable ?? false,
  }

  function bridgeStatus() {
    return {
      ok: true,
      mode: 'reserved2',
      role: cfg.role,
      roleMode: 'v2',
    }
  }

  function pluginStatus(cwd) {
    const workspaceMatch = cwd && cwd === CWD
    const effective = workspaceMatch && cfg.workspacePersona
      ? { id: cfg.workspacePersona, name: cfg.personas.find((p) => p.id === cfg.workspacePersona)?.name ?? cfg.workspacePersona, source: 'workspace', enabled: true }
      : cfg.pluginCurrent
        ? { id: cfg.pluginCurrent, name: cfg.pluginCurrent, source: 'global', enabled: true }
        : null
    return {
      ok: true,
      value: {
        plugin: 'dsh-persona-dafeiyu',
        enabled: true,
        active: effective !== null,
        current: cfg.pluginCurrent,
        currentName: cfg.pluginCurrent,
        globalOff: cfg.globalOff,
        mode: cfg.pluginMode,
        sessionId: 's1',
        personas: cfg.personas,
        workspaces: [{ cwd: CWD, personaId: cfg.workspacePersona }],
        effective,
      },
    }
  }

  async function fetchImpl(url, opts = {}) {
    const parsed = new URL(url)
    const method = (opts.method ?? 'GET').toUpperCase()
    const body = typeof opts.body === 'string' && opts.body.length > 0 ? JSON.parse(opts.body) : undefined
    calls.push({ method, path: parsed.pathname, search: parsed.search, body, headers: opts.headers ?? {} })

    const isPersona = parsed.pathname.startsWith('/api/dsh-persona-dafeiyu')

    if (isPersona) {
      if (cfg.failPersonaStatus && parsed.pathname.endsWith('/status')) {
        return jsonResponse(500, { ok: false, error: 'boom' })
      }
      if (parsed.pathname.endsWith('/status')) {
        const cwd = parsed.searchParams.get('cwd') ?? ''
        return jsonResponse(200, pluginStatus(cwd))
      }
      if (parsed.pathname.endsWith('/mutate')) {
        if (cfg.failPersonaWrite) return jsonResponse(500, { ok: false, error: 'plugin refused' })
        if (body?.action === 'set-current') cfg.pluginCurrent = body.id ?? null
        if (body?.action === 'set-mode') cfg.pluginMode = body.mode
        if (body?.action === 'set-workspace-persona') cfg.workspacePersona = body.personaId ?? null
        return jsonResponse(200, { ok: true, value: pluginStatus(CWD) })
      }
      return jsonResponse(404, { ok: false, error: 'no such route' })
    }

    // 桥接控制台
    if (cfg.failBridgeUnreachable) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    const token = opts.headers?.['x-console-token']
    if (token !== cfg.bridgeToken) return jsonResponse(401, { ok: false, error: '未授权：请提供控制台访问令牌' })

    if (parsed.pathname === '/api/status' && method === 'GET') return jsonResponse(200, bridgeStatus())
    if (parsed.pathname === '/api/roles' && method === 'GET') {
      return jsonResponse(200, {
        ok: true,
        roles: cfg.roleNames,
        current: cfg.role,
        summaries: cfg.roleNames.map((name) => ({ name, chars: 100, excerpt: `摘要 ${name}`, warnings: [] })),
        limits: { maxInjectChars: 8000 },
      })
    }
    if (parsed.pathname === '/api/role' && method === 'POST') {
      if (cfg.failBridgeWrite) return jsonResponse(500, { ok: false, error: 'bridge broke' })
      cfg.role = body?.role ?? null
      return jsonResponse(200, { ok: true })
    }
    return jsonResponse(404, { ok: false, error: 'no such route' })
  }

  return {
    calls,
    cfg,
    fetchImpl,
    bridge: createBridgeClient({ baseUrl: 'http://127.0.0.1:3100', token: cfg.bridgeToken, fetchImpl }),
    persona: createPersonaClient({ baseUrl: 'http://127.0.0.1:3080', fetchImpl }),
  }
}

test('normalizeBaseUrl 去掉尾斜杠、挡掉非 http 协议', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3100/'), 'http://127.0.0.1:3100')
  assert.equal(normalizeBaseUrl('  http://localhost:3080/api/  '), 'http://localhost:3080/api')
  assert.equal(normalizeBaseUrl(''), 'http://127.0.0.1:3100')
  assert.throws(() => normalizeBaseUrl('file:///etc/passwd'), UpstreamError)
  assert.throws(() => normalizeBaseUrl('not a url'), UpstreamError)
})

test('readState 把人设插件状态按工作区解析（必须带 cwd）', async () => {
  const fake = fakeUpstreams({ workspacePersona: 'chaye' })
  const state = await readState({ bridge: fake.bridge, persona: fake.persona, workspaceCwd: CWD })

  const statusCall = fake.calls.find((call) => call.path.endsWith('/status') && call.path.startsWith('/api/dsh-persona-dafeiyu'))
  assert.ok(statusCall, '应该请求过插件 status')
  assert.equal(statusCall.search, `?cwd=${encodeURIComponent(CWD)}`)
  assert.equal(state.active.source, 'plugin')
  assert.equal(state.active.id, 'chaye')
  assert.equal(state.warnings.length, 0)
  // 禁用的人设不进列表
  assert.equal(state.items.some((item) => item.id === 'disabled-one'), false)
  assert.equal(state.items.length, 2 + 2)
})

test('readState 在两侧同时生效时给出显式告警', async () => {
  const fake = fakeUpstreams({ role: '小鲸鱼', workspacePersona: 'chaye' })
  const state = await readState({ bridge: fake.bridge, persona: fake.persona, workspaceCwd: CWD })
  assert.equal(state.active.source, 'role')
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /两层人设同时生效/)
  assert.match(state.warnings[0], /小鲸鱼/)
  assert.match(state.warnings[0], /阿茶/)
})

test('切到人格卡：先写插件（三次 mutate），再写桥接，插件侧清空', async () => {
  const fake = fakeUpstreams({ workspacePersona: 'chaye' })
  const result = await switchPersona({ source: 'role', id: '塔菲' }, { bridge: fake.bridge, persona: fake.persona, workspaceCwd: CWD })

  assert.equal(result.ok, true)
  assert.equal(result.active.source, 'role')
  assert.equal(result.active.id, '塔菲')

  const mutates = fake.calls.filter((call) => call.path.endsWith('/mutate'))
  assert.deepEqual(mutates.map((call) => call.body.action), ['set-current', 'set-mode', 'set-workspace-persona'])
  assert.equal(mutates[0].body.id, null)
  assert.equal(mutates[1].body.mode, 'workspace')
  assert.equal(mutates[2].body.personaId, null)

  const write = fake.calls.find((call) => call.path === '/api/role' && call.method === 'POST')
  const lastMutateIndex = fake.calls.lastIndexOf(mutates[mutates.length - 1])
  assert.ok(fake.calls.indexOf(write) > lastMutateIndex, '桥接写入必须在插件写入之后')
  assert.deepEqual(write.body, { role: '塔菲' })
})

test('切到插件人设：桥接用空对象清除角色', async () => {
  const fake = fakeUpstreams({ role: '小鲸鱼' })
  const result = await switchPersona({ source: 'plugin', id: 'chaye' }, { bridge: fake.bridge, persona: fake.persona, workspaceCwd: CWD })

  assert.equal(result.ok, true)
  assert.equal(result.active.source, 'plugin')
  assert.equal(result.active.id, 'chaye')

  const write = fake.calls.find((call) => call.path === '/api/role' && call.method === 'POST')
  assert.deepEqual(write.body, {}, '清除角色发空对象，而不是 {role:null}')
  const mutates = fake.calls.filter((call) => call.path.endsWith('/mutate'))
  assert.equal(mutates[2].body.personaId, 'chaye')
})

test('没有工作区路径时，切到插件人设直接拒绝且不做任何写入', async () => {
  const fake = fakeUpstreams()
  const result = await switchPersona({ source: 'plugin', id: 'chaye' }, { bridge: fake.bridge, persona: fake.persona, workspaceCwd: '' })
  assert.equal(result.ok, false)
  assert.match(result.error, /工作区/)
  assert.equal(fake.calls.length, 0)
})

test('人格卡不存在时不做任何修改', async () => {
  const fake = fakeUpstreams()
  const result = await switchPersona({ source: 'role', id: '不存在的卡' }, { bridge: fake.bridge, persona: fake.persona, workspaceCwd: CWD })
  assert.equal(result.ok, false)
  assert.match(result.error, /不存在/)
  assert.deepEqual(fake.calls.map((call) => call.path), ['/api/roles'])
})

test('插件不可达时仍然改桥接，但给出告警', async () => {
  const fake = fakeUpstreams({ failPersonaStatus: true })
  const result = await switchPersona({ source: 'role', id: '小鲸鱼' }, { bridge: fake.bridge, persona: fake.persona, workspaceCwd: CWD })
  assert.equal(result.ok, true)
  assert.equal(result.pluginSynced, false)
  assert.ok(result.warnings.some((line) => /插件不可达/.test(line)))
  assert.equal(fake.cfg.role, '小鲸鱼')
})

test('插件写入失败且目标是插件人设时回滚并报错', async () => {
  const fake = fakeUpstreams({ failPersonaWrite: true })
  const result = await switchPersona({ source: 'plugin', id: 'chaye' }, { bridge: fake.bridge, persona: fake.persona, workspaceCwd: CWD })
  assert.equal(result.ok, false)
  assert.match(result.error, /已回滚/)
  // 一次都没写到桥接
  assert.equal(fake.calls.some((call) => call.path === '/api/role'), false)
})

test('桥接写入失败时回滚插件侧，不留在「两边都关」', async () => {
  const fake = fakeUpstreams({ role: '小鲸鱼', workspacePersona: 'atri', failBridgeWrite: true })
  const result = await switchPersona({ source: 'role', id: '塔菲' }, { bridge: fake.bridge, persona: fake.persona, workspaceCwd: CWD })

  assert.equal(result.ok, false)
  assert.match(result.error, /已回滚/)
  // 3 次前写 + 3 次回滚
  const mutates = fake.calls.filter((call) => call.path.endsWith('/mutate'))
  assert.equal(mutates.length, 6)
  // 回滚把工作区人设恢复成原来的 atri
  assert.equal(fake.cfg.workspacePersona, 'atri')
  assert.equal(fake.cfg.role, '小鲸鱼')
})

test('桥接 401 的错误里直接指明去看 console-token', async () => {
  const fake = fakeUpstreams({ bridgeToken: 'other-token' })
  const bridge = createBridgeClient({ baseUrl: 'http://127.0.0.1:3100', token: 'wrong', fetchImpl: fake.fetchImpl })
  await assert.rejects(() => bridge.roles(), (error) => {
    assert.ok(error instanceof UpstreamError)
    assert.equal(error.status, 401)
    assert.match(error.message, /console-token/)
    return true
  })
})

test('桥接连不上时 switchPersona 说明「未做任何修改」', async () => {
  const fake = fakeUpstreams({ failBridgeUnreachable: true })
  const result = await switchPersona({ source: 'role', id: '小鲸鱼' }, { bridge: fake.bridge, persona: fake.persona, workspaceCwd: CWD })
  assert.equal(result.ok, false)
  assert.match(result.error, /未做任何修改/)
})