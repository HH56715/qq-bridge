// qq-persona-switch：DSH 宿主侧插件。
//
// 它只做三件事：读两侧状态、收一个切换请求、吐一页 UI。
// 真正的判断逻辑全在 switch-core.js（可裸跑、可单测）；这里只负责把 DSH 的
// webServer 和配置接进来。
//
// 为什么不做成「设置卡片」而是自己挂一页：切换对象是**另一个插件的运行时状态**
// （dsh-persona-dafeiyu 的 current / workspace 映射），它不是 DSH settings 里的
// 一个值，塞不进 schema。所以用一页独立 UI + 两个 JSON 接口最直接。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_BRIDGE_URL,
  DEFAULT_DSH_URL,
  DEFAULT_TIMEOUT_MS,
  createBridgeClient,
  createPersonaClient,
  readState,
  switchPersona,
} from './switch-core.js'
import {
  HttpError,
  describeError,
  isJsonRequest,
  isLoopbackRequest,
  isSameOriginRequest,
  readJsonBody,
  sendHtml,
  sendJson,
} from './http.js'
import { renderPage } from './ui.js'

export const name = 'qq-persona-switch'
export const VERSION = '0.1.1'

/** 所有路由都挂在这个前缀下，避免和 DSH / 别的插件抢路径。 */
export const BASE_PATH = '/api/qq-persona-switch'

/**
 * 配置项（写在 cordis.patch.yml 的 `config:` 里）。
 *
 * 这里**故意不导出 `Config` schema**：
 *   ① 本插件不暴露 DSH settings 命名空间，schema 换不来设置界面；
 *   ② 一旦导出 `Config`，DSH 就会按它校验 entry 配置 —— 校验失败会把整条 entry
 *      打掉，而这条 entry 挂了没有任何提示（qq-mode-console 的头注释里记着这个坑）；
 *   ③ 少一个依赖，`lib/` 就能在 Node 里裸跑、直接单测，不用先 npm install。
 *
 * 因此下面四项全部是「读的时候兜底」：留空 → 读 qq-bridge 的 config.json 与
 * state/console-token → 再退回默认值。字段含义见 README「配置」一节。
 */
export const CONFIG_FIELDS = ['bridgeDir', 'bridgeBaseUrl', 'dshBaseUrl', 'consoleToken', 'workspaceCwd']

// 诊断日志走系统临时目录：插件可能被 `link:` 装到 <DSH_HOME>/plugins 下，
// 按相对层级往上找路径在任何别人的机器上都会写错地方。
const DIAG = process.env.QQ_PERSONA_SWITCH_DIAG ?? path.join(os.tmpdir(), 'qq-persona-switch.log')

function diag(message) {
  if (!DIAG) return
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true })
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${message}\n`)
  } catch { /* 日志写不进去不该影响功能 */ }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function exists(target) {
  try {
    fs.accessSync(target)
    return true
  } catch {
    return false
  }
}

/**
 * 一个目录「像不像 qq-bridge 的安装目录」：必须有 `config.json`，且能认出它是桥
 * （`src/bridge.js`、`state/console-token` 或 package.json 里的名字）。
 *
 * 只认这三种证据是有意的：只看 `config.json` 会把任何手写配置的目录当成桥，
 * 而桥的 config.json 里没有版本字段可对。
 */
export function looksLikeBridgeDir(dir) {
  if (!isDir(dir)) return false
  if (!exists(path.join(dir, 'config.json'))) return false
  if (exists(path.join(dir, 'src', 'bridge.js'))) return true
  if (exists(path.join(dir, 'state', 'console-token'))) return true
  const pkg = readJsonFile(path.join(dir, 'package.json'))
  return Boolean(pkg && typeof pkg.name === 'string' && /qq[-_]?bridge/i.test(pkg.name))
}

// 向上找几层。够覆盖 `.../<bot>/qq-workspace` 与 `.../<bot>/qq-bridge` 这种同级布局，
// 又不至于扫到盘符根。
const DISCOVERY_DEPTH = 3

/**
 * 配置里没填 `bridgeDir` 时，猜一个。
 *
 * 市场里一键装完是没有配置界面的，用户也不会去翻 README 填路径；没有这一层，
 * 装完打开页面只有「没有桥接控制台令牌」，看起来就像插件坏了。
 *
 * 顺序：`QQ_BRIDGE_DIR` → 从 `workspaceCwd` / 进程 cwd 各自向上 3 层，每层看
 * 本目录和它的 `qq-bridge` 子目录。纯 stat，不扫盘。
 */
export function discoverBridgeDir({ workspaceCwd = '', cwd = '', env = process.env } = {}) {
  const envDir = text(env.QQ_BRIDGE_DIR)
  if (envDir) {
    const resolved = path.resolve(envDir)
    if (looksLikeBridgeDir(resolved)) return { dir: resolved, source: 'env QQ_BRIDGE_DIR' }
  }

  const starts = []
  for (const raw of [workspaceCwd, cwd || process.cwd()]) {
    const value = text(raw)
    if (value.length === 0) continue
    const abs = path.resolve(value)
    if (!starts.includes(abs)) starts.push(abs)
  }

  for (const start of starts) {
    let cur = start
    for (let depth = 0; depth <= DISCOVERY_DEPTH; depth += 1) {
      for (const candidate of [cur, path.join(cur, 'qq-bridge')]) {
        if (looksLikeBridgeDir(candidate)) {
          return { dir: candidate, source: `upward from ${start}` }
        }
      }
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  }
  return null
}

/**
 * 把配置归一成「两个地址 + 一个令牌 + 一个工作区」，并把推导过程记进 notes。
 *
 * 每次请求都重新读一遍 config.json 和 state/console-token：桥接重启会**重新生成**
 * 令牌，缓存住反而会一直 401。
 */
export function resolveSettings(config = {}, { cwd = process.cwd(), env = process.env } = {}) {
  const notes = []
  let bridgeDir = text(config.bridgeDir)
  let bridgeDirSource = bridgeDir.length > 0 ? 'config' : ''

  if (bridgeDir.length === 0) {
    const envDir = text(env.QQ_BRIDGE_DIR)
    if (envDir.length > 0) {
      bridgeDir = envDir
      bridgeDirSource = 'env QQ_BRIDGE_DIR'
    }
  }
  if (bridgeDir.length === 0) {
    const found = discoverBridgeDir({
      workspaceCwd: text(config.workspaceCwd),
      cwd,
      env,
    })
    if (found) {
      bridgeDir = found.dir
      bridgeDirSource = found.source
    } else {
      notes.push('没找到 qq-bridge 目录：请填 bridgeDir，或设环境变量 QQ_BRIDGE_DIR。')
    }
  }
  let bridgeBaseUrl = text(config.bridgeBaseUrl)
  let dshBaseUrl = text(config.dshBaseUrl)
  let token = text(config.consoleToken) || text(env.QQ_BRIDGE_CONSOLE_TOKEN)
  let workspaceCwd = text(config.workspaceCwd)

  if (bridgeDir.length > 0) {
    const dir = path.resolve(bridgeDir)
    const configPath = path.join(dir, 'config.json')
    const bridgeConfig = readJsonFile(configPath)
    if (bridgeConfig) {
      if (token.length === 0) token = text(bridgeConfig.consoleToken)
      if (workspaceCwd.length === 0) workspaceCwd = text(bridgeConfig.sessionCwd)
      if (dshBaseUrl.length === 0) dshBaseUrl = text(bridgeConfig?.dsh?.baseUrl)
      if (bridgeBaseUrl.length === 0) {
        const port = Number(bridgeConfig.consolePort)
        if (Number.isFinite(port) && port > 0 && port < 65536) bridgeBaseUrl = `http://127.0.0.1:${port}`
      }
    } else {
      notes.push(`读不到 ${configPath}（bridgeDir 指错了？）`)
    }
    if (token.length === 0) {
      try {
        token = fs.readFileSync(path.join(dir, 'state', 'console-token'), 'utf8').trim()
      } catch {
        notes.push(`读不到 ${path.join(dir, 'state', 'console-token')}（桥接还没启动过？）`)
      }
    }
  }

  if (bridgeBaseUrl.length === 0) bridgeBaseUrl = DEFAULT_BRIDGE_URL
  if (dshBaseUrl.length === 0) dshBaseUrl = DEFAULT_DSH_URL
  if (workspaceCwd.length === 0) {
    notes.push('没有工作区路径：插件人设无法按工作区落位，切换会被拒绝。')
  }
  if (token.length === 0 && bridgeDir.length > 0) {
    notes.push('没有桥接控制台令牌：读人格卡会 401。请填 bridgeDir 或 consoleToken。')
  }

  return { bridgeDir, bridgeDirSource, bridgeBaseUrl, dshBaseUrl, token, workspaceCwd, notes }
}

/** 按 settings 造两个客户端。地址不合法时抛 UpstreamError，由 handler 转成 500。 */
export function buildClients(settings, { fetchImpl } = {}) {
  return {
    bridge: createBridgeClient({ baseUrl: settings.bridgeBaseUrl, token: settings.token, timeoutMs: DEFAULT_TIMEOUT_MS, fetchImpl }),
    // 人设插件挂在 DSH 自己的 webServer 上，和桥接控制台是两个不同的端口。
    persona: createPersonaClient({ baseUrl: settings.dshBaseUrl, timeoutMs: DEFAULT_TIMEOUT_MS, fetchImpl }),
  }
}

// ── 路由处理 ────────────────────────────────────────────────────────────────

function guard(req, method, { write = false } = {}) {
  if (!isLoopbackRequest(req)) throw new HttpError(403, '只接受本机回环请求')
  if (String(req.method ?? '').toUpperCase() !== method) throw new HttpError(405, `只支持 ${method}`)
  if (write) {
    if (!isJsonRequest(req)) throw new HttpError(415, '请求必须是 application/json')
    if (!isSameOriginRequest(req)) throw new HttpError(403, '跨站请求被拒绝')
  }
}

async function handleState(req, res, config) {
  try {
    guard(req, 'GET')
    const settings = resolveSettings(config)
    const { bridge, persona } = buildClients(settings)
    const state = await readState({ bridge, persona, workspaceCwd: settings.workspaceCwd })
    sendJson(res, 200, {
      ...state,
      settings: {
        bridgeDir: settings.bridgeDir,
        bridgeDirSource: settings.bridgeDirSource,
        bridgeBaseUrl: settings.bridgeBaseUrl,
        dshBaseUrl: settings.dshBaseUrl,
        workspaceCwd: settings.workspaceCwd,
        hasToken: settings.token.length > 0,
      },
      notices: settings.notes,
    })
  } catch (error) {
    const { status, message } = describeError(error)
    diag(`state failed: ${message}`)
    sendJson(res, status, { ok: false, error: message })
  }
}

async function handleSwitch(req, res, config) {
  try {
    guard(req, 'POST', { write: true })
    const body = await readJsonBody(req)
    const settings = resolveSettings(config)
    const { bridge, persona } = buildClients(settings)
    const result = await switchPersona(body, { bridge, persona, workspaceCwd: settings.workspaceCwd })
    if (!result.ok) {
      diag(`switch rejected: ${result.error}`)
      sendJson(res, 400, { ok: false, error: result.error, warnings: result.warnings ?? [] })
      return
    }
    diag(`switch ok: ${result.source}:${result.id ?? '(none)'}`)
    sendJson(res, 200, { ...result, notices: settings.notes })
  } catch (error) {
    const { status, message } = describeError(error)
    diag(`switch failed: ${message}`)
    sendJson(res, status, { ok: false, error: message })
  }
}

function handlePage(req, res) {
  try {
    if (!isLoopbackRequest(req)) throw new HttpError(403, '只接受本机回环请求')
    if (String(req.method ?? '').toUpperCase() !== 'GET') throw new HttpError(405, '只支持 GET')
    sendHtml(res, 200, renderPage({ basePath: BASE_PATH, version: VERSION }))
  } catch (error) {
    const { status, message } = describeError(error)
    sendJson(res, status, { ok: false, error: message })
  }
}

function effect(scope, factory, label) {
  if (typeof scope?.effect === 'function') return scope.effect(factory, label)
  return factory()
}

export function apply(ctx, config = {}) {
  diag(`apply; inject=${typeof ctx?.inject}; config=${JSON.stringify({ ...config, consoleToken: config?.consoleToken ? '***' : '' })}`)
  if (typeof ctx?.inject !== 'function') {
    diag('没有 ctx.inject：这个 DSH 版本不支持 webServer 注入，插件不生效')
    return
  }

  ctx.inject(['webServer'], (scope) => {
    const webServer = scope?.webServer
    if (!webServer || typeof webServer.register !== 'function') {
      diag('webServer 服务不可用：插件不生效')
      return
    }
    const routes = [
      [BASE_PATH, 'qq-persona-switch: page', handlePage],
      [`${BASE_PATH}/`, 'qq-persona-switch: page (slash)', handlePage],
      [`${BASE_PATH}/state`, 'qq-persona-switch: state', (req, res) => handleState(req, res, config)],
      [`${BASE_PATH}/switch`, 'qq-persona-switch: switch', (req, res) => handleSwitch(req, res, config)],
    ]
    for (const [routePath, label, handler] of routes) {
      effect(scope, () => webServer.register({ kind: 'exact', path: routePath, handler }), label)
      diag(`registered ${routePath}`)
    }
  })
}