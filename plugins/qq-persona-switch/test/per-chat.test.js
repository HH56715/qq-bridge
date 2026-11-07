// 这一层测「按对话指定」的纯逻辑：渲染、存取、进出模式、单个对话赋值。
// 两个上游还是注入的假对象，所以整组用例不联网、不写真实桥接目录。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CHAT_KEY_RE,
  assignChat,
  chatKeyForSession,
  chatLabel,
  clampInjectMaxChars,
  enterPerChat,
  exitPerChat,
  injectionText,
  listChats,
  normalizeStore,
  readSessions,
  readStore,
  reconcile,
  renderRoleText,
  sessionForChat,
  writeStore,
} from '../lib/per-chat.js'
import { GEN1_ROLE_LINE_RE, selectRoleText } from '../lib/role-card.js'

const CWD = 'C:\\work\\qq-workspace'

function fakeBridge({ role = null, failStatus = false, failWrite = false } = {}) {
  const calls = []
  return {
    calls,
    async status() {
      if (failStatus) throw new Error('POST http://127.0.0.1:3100/api/roles 失败：ECONNREFUSED')
      return { ok: true, mode: 'chat', role, roleMode: 'active' }
    },
    async setRole(name) {
      if (failWrite) throw new Error('写入失败')
      calls.push(['setRole', name])
    },
    async roles() {
      return { roles: ['塔菲', '小鲸鱼'] }
    },
  }
}

function fakePersona({ current = null, mode = 'workspace', workspacePersona = null, failMutate = false } = {}) {
  const calls = []
  return {
    calls,
    state: { current, mode, workspacePersona },
    async status(cwd) {
      return {
        ok: true,
        current,
        mode,
        workspaces: [{ cwd, personaId: workspacePersona }],
        personas: [{ id: 'dafeiyu', name: '大肥鱼' }],
      }
    },
    async mutate(action) {
      if (failMutate) throw new Error('插件 500')
      calls.push(action)
    },
  }
}

function tempBridge({ roles = { 塔菲: '塔菲正文', 小鲸鱼: '小鲸鱼正文' }, sessions = {}, store = null, mode = 'chat' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qps-perchat-'))
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'roles'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ role: { maxInjectChars: 6000 } }), 'utf8')
  fs.writeFileSync(path.join(dir, 'state', 'mode.json'), JSON.stringify({ mode }), 'utf8')
  fs.writeFileSync(path.join(dir, 'state', 'sessions.json'), JSON.stringify({ sessions }), 'utf8')
  if (store !== null) fs.writeFileSync(path.join(dir, 'state', 'qq-persona-switch.json'), JSON.stringify(store), 'utf8')
  for (const [name, text] of Object.entries(roles)) fs.writeFileSync(path.join(dir, 'roles', `${name}.md`), text, 'utf8')
  return dir
}

// ── 渲染 ───────────────────────────────────────────────────────────────────

test('模式标记决定哪一小节被注入', () => {
  const card = [
    '# 小鲸鱼',
    '通用设定。',
    '## 一代专用 〔一代〕',
    '按空格分句。',
    '## 二代专用 〔二代〕',
    '逗号断句。',
  ].join('\n')

  const v1 = selectRoleText(card, 'v1')
  assert.match(v1, /通用设定/)
  assert.match(v1, /按空格分句/)
  assert.doesNotMatch(v1, /逗号断句/)

  const v2 = selectRoleText(card, 'v2')
  assert.match(v2, /逗号断句/)
  assert.doesNotMatch(v2, /按空格分句/)
})

test('二代渲染会把一代专属指令整行剔掉', () => {
  const card = '正文\n请按空格分句，不要用标点\n正常的一句'
  const v2 = renderRoleText(card, { mode: 'v2', maxChars: 8000 })
  assert.doesNotMatch(v2, /空格分句/)
  assert.match(v2, /正常的一句/)
  // 同一张卡的一代渲染不动这行
  assert.match(renderRoleText(card, { mode: 'v1', maxChars: 8000 }), /空格分句/)
  // 那个正则是搬上游的，别在这儿悄悄改宽
  assert.equal(GEN1_ROLE_LINE_RE.test('按空格分句'), true)
})

test('超长按 role.maxInjectChars 截断，并留下可读的尾巴', () => {
  const long = '字'.repeat(1500)
  // 注意下限：role.maxInjectChars 最小 1000，传更小的值会被夹上去
  const out = renderRoleText(long, { mode: 'v1', maxChars: 1000 })
  assert.ok(out.length > 1000, '截断后会追一句说明，所以总长度略超上限')
  assert.ok(out.length < 1100)
  assert.match(out, /已按 role\.maxInjectChars=1000 截断/)

  // 够短就一个字都不动
  const short = '短短一句'
  assert.equal(renderRoleText(short, { mode: 'v1', maxChars: 8000 }), short)
})

test('clampInjectMaxChars 把越界值夹回 1000~20000', () => {
  assert.equal(clampInjectMaxChars(6000), 6000)
  assert.equal(clampInjectMaxChars(1), 1000)
  assert.equal(clampInjectMaxChars(999999), 20000)
  assert.equal(clampInjectMaxChars('abc'), 8000)
  assert.equal(clampInjectMaxChars(-5), 1000)
})

// ── 存取 ───────────────────────────────────────────────────────────────────

test('坏掉的 store 会被规整成能用，而不是抛错', () => {
  // 不认识的来源降级成「不指定」，而不是把整条丢掉：用户手改了字段，
  // 最坏的结果应该是「这个群没人设」，而不是「这个群从列表里消失」。
  const store = normalizeStore({ mode: 'nonsense', assignments: { 'group:1': { source: 'x' } } })
  assert.equal(store.mode, 'global')
  assert.deepEqual(store.assignments, { 'group:1': { source: 'none', id: null } })
  assert.deepEqual(normalizeStore(null), { version: 1, mode: 'global', assignments: {}, snapshot: null })
  // 认不出形状的 key 直接丢掉：它会拿去拼文件路径
  assert.deepEqual(normalizeStore({ assignments: { '../etc': { source: 'role', id: 'x' } } }).assignments, {})
})

test('store 落盘后读回来一致，且不认识的对话 key 不会被写进去', () => {
  const dir = tempBridge()
  try {
    const store = normalizeStore({ mode: 'perChat', assignments: { 'group:111': { source: 'role', id: '塔菲' } } })
    writeStore(dir, store)
    const back = readStore(dir)
    assert.equal(back.mode, 'perChat')
    assert.deepEqual(back.assignments['group:111'], { source: 'role', id: '塔菲' })
    assert.ok(fs.existsSync(path.join(dir, 'state', 'qq-persona-switch.json')))

    // 没有 store 文件时读出来是「默认全局」，不是崩溃
    const empty = tempBridge()
    try {
      assert.equal(readStore(empty).mode, 'global')
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('会话与对话的互相映射', () => {
  const sessions = { 'group:111': 'session-a', 'private:222': 'session-b' }
  assert.equal(sessionForChat(sessions, 'group:111'), 'session-a')
  assert.equal(sessionForChat(sessions, 'group:999'), null)
  assert.equal(chatKeyForSession(sessions, 'session-b'), 'private:222')
  assert.equal(chatKeyForSession(sessions, 'nope'), null)
  assert.equal(chatKeyForSession(sessions, undefined), null)
  assert.equal(chatLabel('group:111'), '群 111')
  assert.equal(chatLabel('private:222'), '好友 222')

  // key 的形状是硬约束：不接受任意字符串，否则注入时会拿它去拼路径
  assert.equal(CHAT_KEY_RE.test('group:111'), true)
  assert.equal(CHAT_KEY_RE.test('../etc'), false)
  assert.equal(CHAT_KEY_RE.test('group:abc'), false)
})

test('listChats 既列已有会话，也列「指定了但还没会话」的', () => {
  const sessions = { 'group:111': 'session-a' }
  const store = normalizeStore({
    mode: 'perChat',
    assignments: { 'group:111': { source: 'role', id: '塔菲' }, 'group:222': { source: 'role', id: '小鲸鱼' } },
  })
  const chats = listChats({ store, sessions })
  assert.equal(chats.length, 2)
  const byKey = Object.fromEntries(chats.map((chat) => [chat.key, chat]))
  assert.equal(byKey['group:111'].pending, false)
  assert.equal(byKey['group:222'].pending, true)
  assert.equal(byKey['group:222'].sessionId, null)
})

// ── 注入 ───────────────────────────────────────────────────────────────────

test('注入只在按对话模式 + 分到人格卡时发生', () => {
  const sessions = { 'group:111': 'session-a' }
  const dir = tempBridge({ sessions })
  try {
    const base = { sessionId: 'session-a', bridgeDir: dir, sessions }
    const roleStore = normalizeStore({ mode: 'perChat', assignments: { 'group:111': { source: 'role', id: '塔菲' } } })
    assert.match(injectionText({ ...base, store: roleStore }), /塔菲正文/)

    // 全局模式：桥接自己会注入，插件必须闭嘴，否则两份
    assert.equal(injectionText({ ...base, store: normalizeStore({ mode: 'global', assignments: roleStore.assignments }) }), '')

    // 分给插件人设：由 dafeiyu 注，插件不注
    const pluginStore = normalizeStore({ mode: 'perChat', assignments: { 'group:111': { source: 'plugin', id: 'dafeiyu' } } })
    assert.equal(injectionText({ ...base, store: pluginStore }), '')

    // 没分到任何东西的会话
    assert.equal(injectionText({ ...base, sessionId: 'session-other', store: roleStore }), '')

    // 卡文件被删了：返回空串，不许抛
    const missing = normalizeStore({ mode: 'perChat', assignments: { 'group:111': { source: 'role', id: '不存在的卡' } } })
    assert.equal(injectionText({ ...base, store: missing }), '')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('reserved2 下注入的是二代正文', () => {
  const card = '正文\n按空格分句\n二代专属一句'
  const dir = tempBridge({ roles: { 塔菲: card }, sessions: { 'group:111': 's1' }, mode: 'reserved2' })
  try {
    const store = normalizeStore({ mode: 'perChat', assignments: { 'group:111': { source: 'role', id: '塔菲' } } })
    const out = injectionText({ store, sessions: { 'group:111': 's1' }, sessionId: 's1', bridgeDir: dir })
    assert.match(out, /二代专属一句/)
    assert.doesNotMatch(out, /按空格分句/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('readSessions 在文件缺失 / 坏掉时返回空表', () => {
  const dir = tempBridge()
  try {
    fs.rmSync(path.join(dir, 'state', 'sessions.json'))
    assert.deepEqual(readSessions(dir), { sessions: {} })
    fs.writeFileSync(path.join(dir, 'state', 'sessions.json'), '{oops', 'utf8')
    assert.deepEqual(readSessions(dir), { sessions: {} })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── 进出模式 ───────────────────────────────────────────────────────────────

test('进按对话模式：关掉两侧全局注入，并把原状态拍进快照', async () => {
  const bridge = fakeBridge({ role: '小鲸鱼' })
  const persona = fakePersona({ current: 'dafeiyu', mode: 'workspace', workspacePersona: 'dafeiyu' })
  const { store, snapshot, warnings } = await enterPerChat({
    bridge,
    persona,
    store: normalizeStore({ mode: 'global' }),
    workspaceCwd: CWD,
  })

  assert.deepEqual(warnings, [])
  assert.equal(store.mode, 'perChat')
  // 桥接的全局卡必须真的被清掉，否则「按对话」下每条消息还会叠一张卡
  assert.deepEqual(bridge.calls, [['setRole', null]])
  assert.deepEqual(persona.calls.map((call) => call.action), ['set-current', 'set-mode', 'set-workspace-persona'])
  assert.equal(persona.calls[1].mode, 'session')
  assert.equal(persona.calls[2].personaId, null)
  assert.equal(persona.calls[2].cwd, CWD)

  // 快照要能把人还回去
  assert.deepEqual(snapshot.bridgeRole, '小鲸鱼')
  assert.deepEqual(snapshot.persona, { current: 'dafeiyu', mode: 'workspace', workspacePersona: 'dafeiyu' })
})

test('进按对话模式：桥接不可达也要进得去，只是留一条告警', async () => {
  const bridge = fakeBridge({ failStatus: true })
  const persona = fakePersona()
  const { store, warnings } = await enterPerChat({
    bridge,
    persona,
    store: normalizeStore({ mode: 'global' }),
    workspaceCwd: CWD,
  })
  assert.equal(store.mode, 'perChat')
  assert.equal(store.snapshot.bridgeRole, null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /桥接不可达/)
  assert.equal(bridge.calls.length, 0)
  // 插件侧照旧关掉
  assert.equal(persona.calls.length, 3)
})

test('退按对话模式：还回快照，并清掉插件侧的会话级选择', async () => {
  const bridge = fakeBridge()
  const persona = fakePersona()
  const store = normalizeStore({
    mode: 'perChat',
    snapshot: { bridgeRole: '小鲸鱼', persona: { current: 'dafeiyu', mode: 'workspace', workspacePersona: 'dafeiyu' } },
    assignments: {
      'group:111': { source: 'plugin', id: 'dafeiyu' },
      'group:222': { source: 'role', id: '塔菲' },
    },
  })
  const sessions = { 'group:111': 'session-a', 'group:222': 'session-b' }
  const { store: next, warnings } = await exitPerChat({ bridge, persona, store, workspaceCwd: CWD, sessions })

  assert.deepEqual(warnings, [])
  assert.equal(next.mode, 'global')
  assert.equal(next.snapshot, null)
  // 只清插件分到的那条；人格卡是插件自己注入的，没有会话级状态
  assert.equal(persona.calls.filter((call) => call.action === 'set-session-persona').length, 1)
  assert.equal(persona.calls.find((call) => call.action === 'set-session-persona').sessionId, 'session-a')
  // 恢复顺序：先恢复插件，再恢复桥接
  const actions = persona.calls.map((call) => call.action)
  assert.deepEqual(actions.slice(-3), ['set-current', 'set-mode', 'set-workspace-persona'])
  assert.deepEqual(bridge.calls, [['setRole', '小鲸鱼']])
})

test('退按对话模式：没有快照时不乱写，只留一条告警', async () => {
  const bridge = fakeBridge()
  const persona = fakePersona()
  const store = normalizeStore({ mode: 'perChat', assignments: {} })
  const { store: next, warnings } = await exitPerChat({ bridge, persona, store, workspaceCwd: CWD, sessions: {} })
  assert.equal(next.mode, 'global')
  assert.equal(persona.calls.length, 0)
  assert.equal(bridge.calls.length, 0)
  assert.match(warnings.join('\n'), /没有进模式前的快照/)
})

// ── 单个对话 ───────────────────────────────────────────────────────────────

test('给还没会话的对话指定：记下来，标 pending，不碰插件', async () => {
  const persona = fakePersona()
  const { ok, store, pending, warnings } = await assignChat({
    store: normalizeStore({ mode: 'perChat' }),
    sessions: {},
    persona,
    chatKey: 'group:333',
    source: 'role',
    id: '塔菲',
  })
  assert.equal(ok, true)
  assert.equal(pending, true)
  assert.equal(persona.calls.length, 0)
  assert.deepEqual(store.assignments['group:333'], { source: 'role', id: '塔菲' })
  assert.match(warnings[0], /还没有 DSH 会话/)
})

test('分给插件人设时写会话级选择；分给人格卡时给人设插件写 none 哨兵', async () => {
  const persona = fakePersona()
  const sessions = { 'group:111': 'session-a' }

  const plugin = await assignChat({
    store: normalizeStore({ mode: 'perChat' }),
    sessions,
    persona,
    chatKey: 'group:111',
    source: 'plugin',
    id: 'dafeiyu',
  })
  assert.equal(plugin.pending, false)
  const role = await assignChat({
    store: plugin.store,
    sessions,
    persona,
    chatKey: 'group:111',
    source: 'role',
    id: '塔菲',
  })
  assert.equal(role.ok, true)

  assert.deepEqual(persona.calls[0], { action: 'set-session-persona', sessionId: 'session-a', personaId: 'dafeiyu' })
  // 人格卡：让 dafeiyu 在本会话闭嘴，不然它会按工作区/全局再注一层
  assert.deepEqual(persona.calls[1], { action: 'set-session-persona', sessionId: 'session-a', none: true })
})

test('assignChat 拒绝非法 key / 来源 / 缺 id', async () => {
  const persona = fakePersona()
  const store = normalizeStore({ mode: 'perChat' })
  for (const key of ['', 'group:abc', '../etc', 'room:1']) {
    assert.equal((await assignChat({ store, sessions: {}, persona, chatKey: key, source: 'role', id: 'x' })).ok, false)
  }
  assert.equal((await assignChat({ store, sessions: {}, persona, chatKey: 'group:1', source: 'bogus', id: 'x' })).ok, false)
  assert.equal((await assignChat({ store, sessions: {}, persona, chatKey: 'group:1', source: 'role', id: '' })).ok, false)
  assert.equal(persona.calls.length, 0, '校验失败不能留下副作用')
})

test('补写：只对已有会话的条目动手，失败的单独记告警', async () => {
  const persona = fakePersona()
  const store = normalizeStore({
    mode: 'perChat',
    assignments: {
      'group:111': { source: 'plugin', id: 'dafeiyu' },
      'group:222': { source: 'role', id: '塔菲' },
      'group:333': { source: 'plugin', id: 'dafeiyu' },
    },
  })
  const sessions = { 'group:111': 'session-a', 'group:222': 'session-b' }
  const { applied, warnings } = await reconcile({ store, sessions, persona })
  assert.equal(applied, 2)
  assert.deepEqual(warnings, [])
  assert.equal(persona.calls.length, 2)

  const broken = fakePersona({ failMutate: true })
  const result = await reconcile({ store, sessions, persona: broken })
  assert.equal(result.applied, 0)
  assert.equal(result.warnings.length, 2)
})