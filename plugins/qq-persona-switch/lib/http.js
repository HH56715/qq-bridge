// 这个小插件直接把 HTTP 挂在 DSH 的 webServer 上，所以手上有的是裸
// IncomingMessage / ServerResponse，没有任何框架帮忙。这里放的都是很薄的一层：
// 回环校验、JSON 读写、错误映射。
//
// 为什么要自己校验回环：DSH 的 webServer 只在 127.0.0.1 监听，但那不等于「只有本机
// 能调」—— 浏览器里的任意页面都能对 localhost 发简单请求。所以我们按 Content-Type
// 和 Origin 自己再挡一道，规则与 dsh-persona-dafeiyu / qq-bridge 控制台保持一致。

/** 带 HTTP 状态码的错误，handler 里 catch 后直接按它回包。 */
export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function hostnameOf(hostHeader) {
  const raw = String(hostHeader ?? '').trim().toLowerCase()
  if (raw.length === 0) return ''
  // IPv6 字面量形如 [::1]:3080，不能用 lastIndexOf(':') 切，会切到方括号里。
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end === -1 ? raw : raw.slice(0, end + 1)
  }
  const colon = raw.lastIndexOf(':')
  return colon === -1 ? raw : raw.slice(0, colon)
}

function portOf(hostHeader) {
  const raw = String(hostHeader ?? '').trim()
  if (raw.length === 0) return ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end === -1 ? '' : raw.slice(end + 1).replace(/^:/, '')
  }
  const colon = raw.lastIndexOf(':')
  return colon === -1 ? '' : raw.slice(colon + 1)
}

function isLoopbackAddress(address) {
  const text = String(address ?? '').trim()
  return text === '127.0.0.1' || text === '::1' || text === '::ffff:127.0.0.1'
}

/** 请求必须来自回环：连接的对端是回环，且 Host 头也是回环（防 DNS rebinding）。 */
export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress
  if (address && !isLoopbackAddress(address)) return false
  return LOOPBACK_HOSTS.has(hostnameOf(req?.headers?.host))
}

/** 写操作必须是 application/json —— 浏览器跨站的「简单请求」发不出这个类型。 */
export function isJsonRequest(req) {
  const type = String(req?.headers?.['content-type'] ?? '').toLowerCase()
  return type.startsWith('application/json')
}

/** Origin 存在时必须是同源；缺失（fetch/curl 常见）则放行。 */
export function isSameOriginRequest(req) {
  const origin = String(req?.headers?.origin ?? '').trim()
  if (origin.length === 0) return true
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  const host = String(req?.headers?.host ?? '').trim().toLowerCase()
  const originHost = parsed.host.toLowerCase()
  if (originHost !== host) return false
  return portOf(originHost) === portOf(host) || (portOf(originHost) === '' && portOf(host) === '80')
}

/** 读 JSON body，带体积上限（这个接口只收两个短字段）。 */
export function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, `请求体超过 ${limit} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => reject(new HttpError(400, `读取请求体失败：${error?.message ?? error}`)))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        resolve({})
        return
      }
      try {
        const value = JSON.parse(text)
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          reject(new HttpError(400, '请求体必须是 JSON 对象'))
          return
        }
        resolve(value)
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'))
      }
    })
  })
}

function applyHeaders(res, headers) {
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
}

/** 回 JSON。所有响应都带 no-store：人设状态变得很快，缓存住了会误导人。 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  applyHeaders(res, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.statusCode = status
  res.end(body)
}

/** 回 HTML。页面自带样式，不引外部资源，所以给个宽松一点的 CSP 也没问题。 */
export function sendHtml(res, status, html) {
  applyHeaders(res, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  })
  res.statusCode = status
  res.end(html)
}

/** 把任意错误转成「状态码 + 一段人话」。 */
export function describeError(error) {
  if (error instanceof HttpError) return { status: error.status, message: error.message }
  const message = error?.message ?? String(error)
  // 上游连不上属于 502 而不是 500：不是本插件崩了，是它依赖的服务没起来。
  const unreachable = /失败：|超时|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|not found/i.test(message)
  return { status: unreachable ? 502 : 500, message }
}