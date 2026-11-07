// qq-persona-switch 的核心逻辑：把「桥接人格卡」和「DSH 人设插件」合成一个开关。
//
// 为什么要有这一层：两边的注入路径是**各自独立**的 ——
//   ① qq-bridge 把 roles/<名>.md 拼进每条提示词（`role.maxInjectChars` 截断）；
//   ② dsh-persona-dafeiyu 在 DSH 会话装配时再注一个 prompt section。
// 同时命中就成了「一条回复里混两个人设」。正确做法是切换时把另一侧显式关掉，
// 而不是让用户自己去两个页面里分别关。
//
// 本文件不依赖 cordis / DSH，也不 import 任何第三方包：所有上游都通过
// `createBridgeClient` / `createPersonaClient` 注入，测试里可以直接换成假服务。
// 因此它可以在 Node 里裸跑，也是把这块逻辑单独拿出去发布的前提。

/** dsh-persona-dafeiyu 的回环接口前缀（由插件 id 派生，写死在插件里，不是可配置项）。 */
export const PERSONA_PLUGIN_BASE_PATH = '/api/dsh-persona-dafeiyu'

/** qq-bridge 控制台的默认地址。 */
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3100'

/** DSH 自己的默认地址 —— 人设插件挂在它的 webServer 上。 */
export const DEFAULT_DSH_URL = 'http://127.0.0.1:3080'

/** 单次上游请求的超时。插件在回环上，超过 4 秒基本等于对端挂了。 */
export const DEFAULT_TIMEOUT_MS = 4000

/** 上游返回了「不是我们要的东西」时抛这个，方便上层区分「连不上」与「连上了但拒绝」。 */
export class UpstreamError extends Error {
  constructor(message, { status = 0, body } = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.body = body
  }
}

/** 把用户填的地址归一成 origin（去掉尾部斜杠），顺便挡掉非 http(s)。 */
export function normalizeBaseUrl(raw, fallback = DEFAULT_BRIDGE_URL) {
  const text = String(raw ?? '').trim()
  const value = text.length > 0 ? text : fallback
  let url
  try {
    url = new URL(value)
  } catch {
    throw new UpstreamError(`地址不是合法的 URL：${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UpstreamError(`地址只支持 http/https：${value}`)
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * 一次 JSON 请求。
 *
 * 故意不用 `response.json()`：拿不到 JSON 时我们要把 HTTP 状态码和响应体片段带进
 * 错误消息里 —— 「人设插件返回的不是 JSON」在没装插件时是常态（DSH 的 SPA fallback
 * 会回一页 HTML 200），这条信息直接决定用户能不能自己诊断出来。
 */
async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  let response
  try {
    response = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? `请求超时（${timeoutMs}ms）`
      : (error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error))
    throw new UpstreamError(`${method} ${url} 失败：${reason}`)
  }
  const text = await response.text()
  let data
  try {
    data = text.length === 0 ? {} : JSON.parse(text)
  } catch {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 80)
    throw new UpstreamError(`${method} ${url} 返回的不是 JSON（HTTP ${response.status}）：${snippet}`, { status: response.status })
  }
  return { status: response.status, ok: response.ok, data }
}

/**
 * qq-bridge 控制台客户端。
 *
 * 注意 qq-bridge 的三道门（缺一不可，见 `src/bridge.js` 的 `startConsoleServer`）：
 *   ① Host 头必须是 127.0.0.1:<端口> / localhost:<端口> —— 用 fetch 直连天然满足；
 *   ② `x-console-token`（或 `?token=`）必须匹配 state/console-token；
 *   ③ 写操作必须 `content-type: application/json`。
 */
export function createBridgeClient({ baseUrl, token, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl } = {}) {
  const origin = normalizeBaseUrl(baseUrl)
  const tokenText = String(token ?? '').trim()

  async function call(method, pathname, body) {
    const headers = {
      accept: 'application/json',
      ...(tokenText.length > 0 ? { 'x-console-token': tokenText } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }
    const result = await requestJson(`${origin}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
      fetchImpl,
    })
    // 401 最常见的原因是「桥接重启后重新生成了 token」或「bridgeDir 指错了」，
    // 把这两条直接写进错误里，比让用户猜好得多。
    if (result.status === 401) {
      throw new UpstreamError('桥接控制台拒绝了令牌（401）：请检查 bridgeDir 下的 state/console-token，或在插件配置里直接填 consoleToken', { status: 401 })
    }
    if (result.data?.ok === false) {
      throw new UpstreamError(String(result.data.error ?? `桥接返回失败（HTTP ${result.status}）`), { status: result.status, body: result.data })
    }
    if (!result.ok) {
      throw new UpstreamError(`桥接返回 HTTP ${result.status}`, { status: result.status, body: result.data })
    }
    return result.data
  }

  return {
    origin,
    /** `GET /api/roles`：人格卡清单 + 当前角色 + 上限。 */
    async roles() {
      const data = await call('GET', '/api/roles')
      return {
        current: typeof data.current === 'string' && data.current.length > 0 ? data.current : null,
        summaries: Array.isArray(data.summaries) ? data.summaries : [],
        limits: data.limits ?? {},
      }
    },
    /** `GET /api/status`：只读运行状态（模式等），用来在界面里显示上下文。 */
    async status() {
      const data = await call('GET', '/api/status')
      return { mode: data.mode ?? null, role: data.role ?? null, roleMode: data.roleMode ?? null }
    },
    /**
     * `POST /api/role`：设置 / 清除桥接角色。
     *
     * 传 `null` 时发的是空对象 `{}` —— 桥接里清除分支的判定是 `!body.role`，
     * 不是 `body.role === null`，发 `{role:null}` 同样成立，但空对象更不容易被人误读成
     * 「设成 null 这个角色」。
     */
    async setRole(name) {
      const role = typeof name === 'string' && name.trim().length > 0 ? name.trim() : null
      return call('POST', '/api/role', role ? { role } : {})
    },
  }
}

/**
 * dsh-persona-dafeiyu 客户端。
 *
 * 写操作要过插件的三道门：回环来源 + `application/json` + 同源（Origin 缺失视为放行）。
 * fetch 不发 Origin，所以第③条天然满足；这也是为什么不能换成浏览器里直接 fetch —— 那会带 Origin。
 */
export function createPersonaClient({ baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl } = {}) {
  const origin = normalizeBaseUrl(baseUrl)

  async function call(method, pathname, body) {
    const headers = {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }
    const result = await requestJson(`${origin}${PERSONA_PLUGIN_BASE_PATH}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
      fetchImpl,
    })
    if (result.data?.ok === false) {
      throw new UpstreamError(String(result.data.error ?? '人设插件返回失败'), { status: result.status, body: result.data })
    }
    if (!result.ok) {
      throw new UpstreamError(`人设插件返回 HTTP ${result.status}`, { status: result.status, body: result.data })
    }
    return result.data
  }

  return {
    origin,
    /**
     * `GET /status`。
     *
     * **必须带上 `?cwd=`**：带了这个参数，插件才会按「工作区档」解析并给出
     * `effective`（真正会被注入的那条）。不带的话它按全局档算 —— 而我们的切换
     * 总是把全局关掉、只用工作区映射，于是 `effective` 恒为 null，
     * 界面会一直显示「没有人设」。
     */
    async status(cwd) {
      const key = typeof cwd === 'string' ? cwd.trim() : ''
      const query = key.length > 0 ? `?cwd=${encodeURIComponent(key)}` : ''
      const data = await call('GET', `/status${query}`)
      return data.value ?? null
    },
    /** `POST /mutate`：一条 action 一次调用（插件就是这么设计的，每次落盘）。 */
    async mutate(action) {
      const data = await call('POST', '/mutate', action)
      return data.value ?? null
    },
  }
}

/** 从插件快照里取「当前生效」的那条，只认真正会注入的（enabled + active）。 */
function pluginActive(plugin) {
  const effective = plugin?.effective
  if (!effective || typeof effective.id !== 'string') return null
  if (effective.enabled === false) return null
  if (plugin.active === false) return null
  return effective
}

/** 把两侧状态合成一个给界面看的视图。任何一侧挂掉都不抛错，只标 reachable:false。 */
export async function readState({ bridge, persona, workspaceCwd }) {
  const cwd = String(workspaceCwd ?? '').trim()
  const warnings = []

  let bridgeState = { reachable: false, error: null, role: null, roleMode: null, mode: null, summaries: [], limits: {} }
  try {
    const [status, roles] = await Promise.all([bridge.status(), bridge.roles()])
    bridgeState = {
      reachable: true,
      error: null,
      role: roles.current,
      roleMode: status.roleMode,
      mode: status.mode,
      summaries: roles.summaries,
      limits: roles.limits,
    }
  } catch (error) {
    bridgeState.error = error?.message ?? String(error)
  }

  let pluginState = { reachable: false, error: null, enabled: null, mode: null, globalOff: null, current: null, currentName: null, effective: null, active: null, personas: [], workspaces: [] }
  try {
    const value = await persona.status(cwd)
    if (!value || typeof value !== 'object') throw new UpstreamError('人设插件返回了空状态')
    pluginState = {
      reachable: true,
      error: null,
      enabled: value.enabled ?? null,
      mode: value.mode ?? null,
      globalOff: value.globalOff ?? null,
      current: value.current ?? null,
      currentName: value.currentName ?? null,
      effective: value.effective ?? null,
      active: value.active ?? null,
      personas: Array.isArray(value.personas) ? value.personas : [],
      workspaces: Array.isArray(value.workspaces) ? value.workspaces : [],
    }
  } catch (error) {
    pluginState.error = error?.message ?? String(error)
  }

  const pluginNow = pluginActive(pluginState)
  const roleSummary = bridgeState.role
    ? bridgeState.summaries.find((item) => item.name === bridgeState.role) ?? null
    : null

  // 两侧同时生效 = 这条插件存在的理由。把它做成显式告警，而不是界面上两个高亮。
  if (bridgeState.role && pluginNow) {
    warnings.push(`两层人设同时生效：人格卡「${bridgeState.role}」+ 插件人设「${pluginNow.name ?? pluginNow.id}」。点一次任意一张卡即可收敛。`)
  }

  const active = bridgeState.role
    ? { source: 'role', id: bridgeState.role, name: bridgeState.role, chars: roleSummary?.chars ?? 0 }
    : pluginNow
      ? { source: 'plugin', id: pluginNow.id, name: pluginNow.name ?? pluginNow.id, chars: pluginState.personas.find((item) => item.id === pluginNow.id)?.chars ?? 0 }
      : { source: 'none', id: null, name: null, chars: 0 }

  const items = []
  for (const role of bridgeState.summaries) {
    items.push({
      source: 'role',
      id: role.name,
      name: role.name,
      chars: role.chars ?? 0,
      description: role.excerpt ?? '',
      enabled: true,
      active: active.source === 'role' && active.id === role.name,
      warnings: Array.isArray(role.warnings) ? role.warnings : [],
    })
  }
  for (const item of pluginState.personas) {
    if (item.enabled === false) continue
    items.push({
      source: 'plugin',
      id: item.id,
      name: item.name ?? item.id,
      chars: item.chars ?? 0,
      description: item.description ?? '',
      enabled: true,
      active: active.source === 'plugin' && active.id === item.id,
      warnings: [],
    })
  }

  return {
    ok: true,
    workspaceCwd: cwd,
    active,
    items,
    warnings,
    bridge: { baseUrl: bridge.origin, ...bridgeState },
    plugin: { baseUrl: persona.origin, basePath: PERSONA_PLUGIN_BASE_PATH, ...pluginState },
  }
}

/** 把插件侧恢复成一个之前拍下的快照（用于「桥接写入失败」时回滚）。 */
async function restorePlugin(persona, cwd, snapshot) {
  if (!snapshot) return
  const attempts = [
    () => persona.mutate({ action: 'set-current', id: snapshot.current ?? null }),
    () => persona.mutate({ action: 'set-mode', mode: snapshot.mode || 'global' }),
    () => (cwd.length > 0 ? persona.mutate({ action: 'set-workspace-persona', cwd, personaId: snapshot.personaId ?? null }) : Promise.resolve(null)),
  ]
  for (const attempt of attempts) {
    try { await attempt() } catch { /* 回滚是尽力而为：中断后不再抛，避免掩盖原始错误 */ }
  }
}

/** 拍一份插件侧快照，字段与 mutate 的三个 action 一一对应。 */
function snapshotPlugin(plugin, cwd) {
  if (!plugin) return null
  const pick = (plugin.workspaces ?? []).find((item) => item.cwd === cwd)
  return {
    current: plugin.current ?? null,
    mode: plugin.mode || 'global',
    personaId: pick?.personaId ?? null,
  }
}

/**
 * 切换人设。`request = { source: 'role' | 'plugin' | 'none', id? }`。
 *
 * 顺序（和 qq-bridge 自己的 `/api/persona/switch` 一致，理由也是同一个）：
 * 插件侧先写。目标是人设插件时插件失败就直接返回，**绝不先清桥接 role**
 * —— 否则 bot 会变成完全没有人设，比切换失败更糟。
 *
 * 比桥接多出来的一步：桥接写失败时会回滚插件侧。桥接是另一个进程，
 * 它的写操作是会失败的（端口没开、token 过期），而插件侧的写入是已经落盘的；
 * 不回滚就正好停在「两边都关」这个最差状态上。
 */
export async function switchPersona(request, { bridge, persona, workspaceCwd } = {}) {
  const source = String(request?.source ?? '').trim()
  const rawId = typeof request?.id === 'string' ? request.id.trim() : ''
  const id = rawId.length > 0 ? rawId : null
  const cwd = String(workspaceCwd ?? '').trim()
  const warnings = []

  if (source !== 'role' && source !== 'plugin' && source !== 'none') {
    return { ok: false, error: 'source 只能是 role / plugin / none' }
  }
  if (source === 'role' && id === null) return { ok: false, error: '缺少角色卡名' }
  if (source === 'plugin' && id === null) return { ok: false, error: '缺少人设 id' }
  if (source === 'plugin' && cwd.length === 0) {
    return { ok: false, error: '没有工作区路径：请在插件配置里填 workspaceCwd，或把 bridgeDir 指向含 config.json（sessionCwd）的 qq-bridge' }
  }

  // ① 先验证目标存在 —— 验证失败时两侧都还没动过，可以直接返回。
  if (source === 'role') {
    let roles
    try {
      roles = await bridge.roles()
    } catch (error) {
      return { ok: false, error: `桥接不可达，未做任何修改：${error?.message ?? error}` }
    }
    if (!roles.summaries.some((item) => item.name === id)) {
      return { ok: false, error: `人格卡「${id}」不存在（roles/${id}.md）` }
    }
  }

  let plugin = null
  let pluginReadError = null
  try {
    plugin = await persona.status(cwd)
  } catch (error) {
    pluginReadError = error?.message ?? String(error)
  }

  if (source === 'plugin') {
    if (!plugin) {
      return { ok: false, error: `DSH 人设插件不可达：${pluginReadError}（DSH 没启动，或者没装 dsh-persona-dafeiyu？）` }
    }
    const target = (plugin.personas ?? []).find((item) => item.id === id)
    if (!target) return { ok: false, error: `插件人设「${id}」不存在` }
    if (target.enabled === false) return { ok: false, error: `插件人设「${target.name ?? id}」已被禁用` }
  }

  // ② 插件侧先写。
  const snapshot = snapshotPlugin(plugin, cwd)
  let pluginSynced = false
  let pluginWriteError = null
  if (plugin) {
    try {
      // 先关全局：不关的话工作区档之外（别的 cwd）会回落到它，两层又叠一起。
      await persona.mutate({ action: 'set-current', id: null })
      await persona.mutate({ action: 'set-mode', mode: 'workspace' })
      if (cwd.length > 0) {
        await persona.mutate({ action: 'set-workspace-persona', cwd, personaId: source === 'plugin' ? id : null })
      } else {
        warnings.push('没有工作区路径，插件端的「本工作区人设」未清空；若它原来有值，会与人格卡叠加。')
      }
      pluginSynced = true
    } catch (error) {
      pluginWriteError = error?.message ?? String(error)
      if (source === 'plugin') {
        await restorePlugin(persona, cwd, snapshot)
        return { ok: false, error: `人设插件写入失败，已回滚：${pluginWriteError}` }
      }
      warnings.push(`人设插件写入失败（已忽略，人格卡仍然生效）：${pluginWriteError}`)
    }
  } else if (source === 'plugin') {
    return { ok: false, error: `DSH 人设插件不可达：${pluginReadError}` }
  } else {
    pluginWriteError = pluginReadError ?? '不可达'
    warnings.push(`人设插件不可达，只改了桥接侧：${pluginWriteError}`)
  }

  // ③ 桥接侧。失败时回滚插件侧，避免停在「两边都关」。
  try {
    await bridge.setRole(source === 'role' ? id : null)
  } catch (error) {
    const detail = error?.message ?? String(error)
    if (snapshot) await restorePlugin(persona, cwd, snapshot)
    return { ok: false, error: `桥接写入失败，已回滚插件侧：${detail}` }
  }

  const after = await readState({ bridge, persona, workspaceCwd: cwd })
  return {
    ok: true,
    source: after.active.source,
    id: after.active.id,
    name: after.active.name,
    active: after.active,
    pluginSynced,
    pluginError: pluginWriteError,
    warnings: [...warnings, ...after.warnings],
  }
}