// 「按对话指定人设」：存储、会话映射、注入正文、进入 / 退出。
//
// 背景：qq-bridge 只在**全局**注入一份人格卡（state/current-role.json），上游到
// v0.2.2-rc1 都没有「这个群用 A、那个群用 B」。dsh-persona-dafeiyu 倒是有会话级
// 人设（set-session-persona），但它只认自己库里的人设，装不下 roles/*.md。
//
// 所以这一层由插件自己承担：
//   · 人格卡 → 插件注册一个 systemPrompt section，按当前 DSH 会话反查 QQ 会话，
//     注入那张卡的正文（渲染规则见 ./role-card.js，与桥接同源）；
//   · 插件人设 → 直接调 dafeiyu 的 set-session-persona(sessionId, personaId)，
//     让它按会话原生注入；
//   · 两者互相让路：本会话分到人格卡时给 dafeiyu 写「本会话不启用人设」的哨兵，
//     分到插件人设时插件这边注入空串。
//
// 「会话」这件事本身：桥接把每个 QQ 会话映射到一个 DSH 会话，映射落在
// state/sessions.json（{ sessions: { "group:123": "session-…" } }）。上游与 r1 都有
// 这个文件，且都是普通 JSON，所以插件只读它，不碰桥接的任何私有接口。

import fs from 'node:fs'
import path from 'node:path'

import { GEN1_ROLE_LINE_RE, selectRoleText } from './role-card.js'

/** 存在桥接的 state/ 下：跟它自己的 current-role.json / sessions.json 做邻居。 */
export const STORE_NAME = 'qq-persona-switch.json'
export const STORE_VERSION = 1
export const MAX_ASSIGNMENTS = 200
export const MODES = ['global', 'perChat']
export const SOURCES = ['role', 'plugin', 'none']
export const CHAT_KEY_RE = /^(group|private):\d+$/
export const ROLE_NAME_MAX = 40
export const ROLE_CONTENT_MAX_BYTES = 64 * 1024
export const DEFAULT_INJECT_MAX_CHARS = 8000

// ── 存储 ───────────────────────────────────────────────────────────────────

export function storePath(bridgeDir) {
  return path.join(String(bridgeDir ?? ''), 'state', STORE_NAME)
}

export function emptyStore() {
  return { version: STORE_VERSION, mode: 'global', assignments: {}, snapshot: null }
}

/** 读进来的东西可能是手改的：一律归一，坏字段丢掉而不是让整页崩掉。 */
export function normalizeStore(raw) {
  const base = emptyStore()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  base.mode = MODES.includes(raw.mode) ? raw.mode : 'global'
  const assignments = raw.assignments && typeof raw.assignments === 'object' && !Array.isArray(raw.assignments)
    ? raw.assignments
    : {}
  for (const [key, value] of Object.entries(assignments)) {
    if (!CHAT_KEY_RE.test(key)) continue
    if (!value || typeof value !== 'object') continue
    const source = SOURCES.includes(value.source) ? value.source : 'none'
    const id = source === 'plugin' || source === 'role' ? String(value.id ?? '').trim() : ''
    if ((source === 'plugin' || source === 'role') && id.length === 0) continue
    base.assignments[key] = { source, id: id.length > 0 ? id : null }
  }
  const snap = raw.snapshot
  if (snap && typeof snap === 'object' && !Array.isArray(snap)) {
    base.snapshot = {
      bridgeRole: typeof snap.bridgeRole === 'string' && snap.bridgeRole.length > 0 ? snap.bridgeRole : null,
      persona: snap.persona && typeof snap.persona === 'object'
        ? {
            current: typeof snap.persona.current === 'string' ? snap.persona.current : null,
            mode: typeof snap.persona.mode === 'string' ? snap.persona.mode : 'global',
            workspacePersona: typeof snap.persona.workspacePersona === 'string' ? snap.persona.workspacePersona : null,
          }
        : null,
    }
  }
  return base
}

export function readStore(bridgeDir) {
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(storePath(bridgeDir), 'utf8')))
  } catch {
    return emptyStore()
  }
}

/** 先写临时文件再改名：桥接那边也这么干，半截文件比丢配置更难查。 */
export function writeStore(bridgeDir, store) {
  const file = storePath(bridgeDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return store
}

// ── 会话映射 ───────────────────────────────────────────────────────────────

export function readSessions(bridgeDir) {
  const file = path.join(String(bridgeDir ?? ''), 'state', 'sessions.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const sessions = raw && typeof raw.sessions === 'object' && raw.sessions !== null && !Array.isArray(raw.sessions)
      ? raw.sessions
      : {}
    return { sessions }
  } catch {
    return { sessions: {} }
  }
}

export function sessionForChat(sessions, chatKey) {
  const value = sessions?.[chatKey]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 提示词组装时只有会话 id，没有 QQ key，所以要反查。 */
export function chatKeyForSession(sessions, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  for (const [key, value] of Object.entries(sessions ?? {})) {
    if (value === sessionId) return key
  }
  return null
}

/** `group:123456` → 「群 123456」；只为界面好读，不参与任何判断。 */
export function chatLabel(chatKey) {
  const match = CHAT_KEY_RE.exec(String(chatKey ?? ''))
  if (!match) return String(chatKey ?? '')
  const num = match[0].slice(match[1].length + 1)
  return `${match[1] === 'group' ? '群' : '好友'} ${num}`
}

/**
 * 界面上要列的对话：已有会话的（sessions.json）+ 已经指定过但会话还没出现的。
 * 后者必须列出来，否则「设了但还没生效」的条目会从页面上消失，用户以为没存上。
 */
export function listChats({ store, sessions }) {
  const keys = new Set(Object.keys(sessions ?? {}))
  for (const key of Object.keys(store?.assignments ?? {})) keys.add(key)
  return [...keys]
    .filter((key) => CHAT_KEY_RE.test(key))
    .sort()
    .map((key) => {
      const assignment = store?.assignments?.[key] ?? null
      return {
        key,
        label: chatLabel(key),
        sessionId: sessionForChat(sessions, key),
        assignment,
        pending: assignment !== null && sessionForChat(sessions, key) === null,
      }
    })
}

// ── 渲染正文 ───────────────────────────────────────────────────────────────

export function clampInjectMaxChars(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return DEFAULT_INJECT_MAX_CHARS
  return Math.min(20000, Math.max(1000, Math.trunc(num)))
}

/**
 * 把一张卡渲染成「这次要注入的正文」。
 *
 * 顺序与桥接一致：先按模式筛小节 → 二代再整行剔掉一代专属指令 → 最后按
 * role.maxInjectChars 截断。截断放在最后，是因为前面两步都会让正文变短，
 * 先截会把本来能留下的二代小节截掉。
 */
export function renderRoleText(rawText, { mode = 'v1', maxChars = DEFAULT_INJECT_MAX_CHARS, gen1Filter = true } = {}) {
  const want = mode === 'v2' ? 'v2' : 'v1'
  let text = selectRoleText(rawText, want)
  if (want === 'v2' && gen1Filter) {
    text = text
      .split('\n')
      .filter((line) => !GEN1_ROLE_LINE_RE.test(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }
  const limit = clampInjectMaxChars(maxChars)
  if (text.length > limit) text = `${text.slice(0, limit)}\n…（已按 role.maxInjectChars=${limit} 截断）`
  return text
}

/** 卡名只允许单段文件名：`../x`、绝对路径、`README` 一律拒绝。 */
export function safeRoleName(raw) {
  const name = String(raw ?? '').trim()
  if (name.length === 0 || name.length > ROLE_NAME_MAX) return null
  if (name === 'README') return null
  if (/[/\\:]/.test(name)) return null
  if (name.startsWith('.')) return null
  return name
}

const roleCache = new Map()

function readRoleFile(rolesDir, name) {
  const safe = safeRoleName(name)
  if (!safe) return null
  const file = path.join(rolesDir, `${safe}.md`)
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > ROLE_CONTENT_MAX_BYTES) return null
    const cached = roleCache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text
    const text = fs.readFileSync(file, 'utf8')
    roleCache.set(file, { mtimeMs: stat.mtimeMs, text })
    return text
  } catch {
    return null
  }
}

export function clearRoleCache() {
  roleCache.clear()
}

/** 桥接的仿真模式决定用 v1 还是 v2 小节（二代必须走工具协议）。 */
export function readBridgeMode(bridgeDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(String(bridgeDir ?? ''), 'state', 'mode.json'), 'utf8'))
    return typeof raw?.mode === 'string' && raw.mode.length > 0 ? raw.mode : 'chat'
  } catch {
    return 'chat'
  }
}

export function readInjectMaxChars(bridgeDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(String(bridgeDir ?? ''), 'config.json'), 'utf8'))
    return clampInjectMaxChars(raw?.role?.maxInjectChars)
  } catch {
    return DEFAULT_INJECT_MAX_CHARS
  }
}

/**
 * 提示词组装时真正被调用的那个函数（每次组装都会跑，必须同步、够快）。
 * 命中不了就返回空串——**空串不等于「没人设」**，只是「这一层不说话」。
 */
export function injectionText({ store, sessions, sessionId, bridgeDir, bridgeMode, maxChars } = {}) {
  if (!store || store.mode !== 'perChat') return ''
  const chatKey = chatKeyForSession(sessions, sessionId)
  if (!chatKey) return ''
  const assignment = store.assignments?.[chatKey]
  if (!assignment || assignment.source !== 'role') return ''
  const raw = readRoleFile(path.join(String(bridgeDir ?? ''), 'roles'), assignment.id)
  if (raw === null) return ''
  const mode = bridgeMode ?? readBridgeMode(bridgeDir)
  return renderRoleText(raw, {
    mode: mode === 'reserved2' ? 'v2' : 'v1',
    maxChars: maxChars ?? readInjectMaxChars(bridgeDir),
  })
}

// ── 进入 / 退出「按对话」 ──────────────────────────────────────────────────

function personaSnapshot(status, workspaceCwd) {
  const workspaces = Array.isArray(status?.workspaces) ? status.workspaces : []
  const mine = workspaces.find((item) => item && item.cwd === workspaceCwd)
  return {
    current: typeof status?.current === 'string' ? status.current : null,
    mode: typeof status?.mode === 'string' ? status.mode : 'global',
    workspacePersona: mine && typeof mine.personaId === 'string' ? mine.personaId : null,
  }
}

/**
 * 进入按对话模式：把**两侧的全局注入都关掉**，交给本插件按会话说话。
 *
 * 关之前先拍快照（桥接的 role、人设插件的 current/mode/本工作区映射），退出时原样
 * 还回去。不拍快照的话，「试一下按对话、发现不好用再关掉」就会把用户原来的人设
 * 静默抹掉——这比功能不好用更伤人。
 *
 * dafeiyu 这边切到 `session` 档：只有显式指定的会话才有人设，其余一律空。
 * 同时清掉本工作区的选择，否则工作区档会兜底给所有群注一层。
 */
export async function enterPerChat({ bridge, persona, store, workspaceCwd }) {
  const warnings = []
  const pluginStatus = await persona.status(workspaceCwd)
  const snapshot = { bridgeRole: null, persona: personaSnapshot(pluginStatus, workspaceCwd) }

  try {
    const bridgeStatus = await bridge.status()
    snapshot.bridgeRole = typeof bridgeStatus?.role === 'string' && bridgeStatus.role.length > 0 ? bridgeStatus.role : null
  } catch (error) {
    warnings.push(`桥接不可达，没有关掉它的全局人格卡：${error?.message ?? error}`)
  }
  if (snapshot.bridgeRole !== null) {
    await bridge.setRole(null)
  }

  await persona.mutate({ action: 'set-current', id: null })
  await persona.mutate({ action: 'set-mode', mode: 'session' })
  await persona.mutate({ action: 'set-workspace-persona', cwd: workspaceCwd, personaId: null })

  // 落盘由调用方负责（它才知道 bridgeDir）：这里只把「应该写成什么」算出来。
  return { store: { ...store, mode: 'perChat', snapshot }, snapshot, warnings }
}

/**
 * 退出按对话模式：把快照还回去，并清掉本插件给各会话写的会话级选择。
 *
 * 清的理由：那些 `set-session-persona` 只在 session 档下有意义，留在表里不会出错，
 * 但用户下次再进按对话模式时会看到一堆「上一轮的残留」，分不清是不是自己设的。
 */
export async function exitPerChat({ bridge, persona, store, workspaceCwd, sessions }) {
  const warnings = []
  const snapshot = store.snapshot ?? null

  for (const [chatKey, assignment] of Object.entries(store.assignments ?? {})) {
    const sessionId = sessionForChat(sessions, chatKey)
    if (!sessionId) continue
    if (assignment.source === 'role') continue // 人格卡是插件自己注入的，没有会话级状态要清
    try {
      await persona.mutate({ action: 'set-session-persona', sessionId, personaId: null })
    } catch (error) {
      warnings.push(`清理 ${chatKey} 的会话级人设失败：${error?.message ?? error}`)
    }
  }

  if (snapshot?.persona) {
    try {
      await persona.mutate({ action: 'set-current', id: snapshot.persona.current ?? null })
      await persona.mutate({ action: 'set-mode', mode: snapshot.persona.mode || 'global' })
      await persona.mutate({ action: 'set-workspace-persona', cwd: workspaceCwd, personaId: snapshot.persona.workspacePersona ?? null })
    } catch (error) {
      warnings.push(`恢复插件人设状态失败：${error?.message ?? error}`)
    }
  } else {
    warnings.push('没有进模式前的快照，插件人设维持当前状态未动。')
  }

  if (snapshot?.bridgeRole) {
    try {
      await bridge.setRole(snapshot.bridgeRole)
    } catch (error) {
      warnings.push(`恢复桥接全局人格卡「${snapshot.bridgeRole}」失败：${error?.message ?? error}`)
    }
  }

  const next = { ...store, mode: 'global', snapshot: null }
  return { store: next, warnings }
}

/**
 * 给某个对话定人设。
 *
 * `pending` 是常态而不是错误：新加的群在 bot 发过第一条消息之前根本没有 DSH 会话，
 * 这时只能先把选择记下来，等会话出现（页面上的「同步」或下次指定时）再落到插件那边。
 */
export async function assignChat({ store, sessions, persona, chatKey, source, id }) {
  const key = String(chatKey ?? '').trim()
  if (!CHAT_KEY_RE.test(key)) return { ok: false, error: `对话 key 不合法：${key}` }
  if (!SOURCES.includes(source)) return { ok: false, error: `不认识的来源：${source}` }
  if ((source === 'role' || source === 'plugin') && String(id ?? '').trim().length === 0) {
    return { ok: false, error: '缺少 id' }
  }

  const sessionId = sessionForChat(sessions, key)
  const warnings = []
  if (sessionId && source === 'plugin') {
    await persona.mutate({ action: 'set-session-persona', sessionId, personaId: id })
  } else if (sessionId) {
    // 人格卡 / 不使用：让 dafeiyu 在本会话闭嘴，避免它按工作区或全局兜底再注一层。
    await persona.mutate({ action: 'set-session-persona', sessionId, none: true })
  } else {
    warnings.push(`${chatKey} 还没有 DSH 会话（bot 还没在这个对话发过言）；先记下选择，等会话出现后再同步。`)
  }

  const assignments = { ...store.assignments }
  if (source === 'none') {
    assignments[key] = { source: 'none', id: null }
  } else {
    assignments[key] = { source, id: String(id).trim() }
  }
  // 上限保护：超了丢最早的那条，跟桥接的工作区映射一个思路。
  const keys = Object.keys(assignments)
  if (keys.length > MAX_ASSIGNMENTS) {
    for (const old of keys.slice(0, keys.length - MAX_ASSIGNMENTS)) delete assignments[old]
  }
  return { ok: true, store: { ...store, assignments }, sessionId, pending: sessionId === null, warnings }
}

/**
 * 把已记下但还没落到会话上的选择补写一遍（页面上的「同步」按钮）。
 * 返回补上了几条，界面据此给反馈。
 */
export async function reconcile({ store, sessions, persona }) {
  const warnings = []
  let applied = 0
  for (const [chatKey, assignment] of Object.entries(store.assignments ?? {})) {
    const sessionId = sessionForChat(sessions, chatKey)
    if (!sessionId) continue
    try {
      if (assignment.source === 'plugin') {
        await persona.mutate({ action: 'set-session-persona', sessionId, personaId: assignment.id })
      } else {
        await persona.mutate({ action: 'set-session-persona', sessionId, none: true })
      }
      applied += 1
    } catch (error) {
      warnings.push(`${chatKey} 同步失败：${error?.message ?? error}`)
    }
  }
  return { applied, warnings }
}