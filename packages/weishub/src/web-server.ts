/**
 * Web 面板（Task 19）：本地回环 HTTP 服务 + 零依赖前端。
 *
 * 路由复用 notify.ts 的手写 node:http 风格，仅监听 127.0.0.1。
 * 鉴权（所有路由，含页面）：以下两种形态任一即可，否则 401——
 *  1. `Authorization: Bearer <token>` 请求头（脚本/API 调用）；
 *  2. `?token=<token>` 查询参数（浏览器打开页面与页面内 fetch 复用同一形态）。
 *
 * 扫码登录：web-server 自持一个 LoginSession（startLoginSession/pollLoginSession），
 * confirmed 后凭据写 defaultCredentialPath() 并调用 hub.reloadCredential() 热启动轮询。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import QRCode from 'qrcode'
import {
  defaultCredentialPath,
  pollLoginSession,
  startLoginSession,
  writePrivateJson,
  type InboundMessage,
  type LoginSession,
} from '@weishub/channel-wechat'
import type { Hub } from './inbound.js'

export interface WebServerDeps {
  hub: Hub
  token: string
  port?: number
  /** 测试注入：扫码登录用的 fetch 替身（默认 globalThis.fetch） */
  fetch?: typeof globalThis.fetch
  maxBodyBytes?: number
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/** 编译产物 lib/web-server.js 与源码 src/web-server.ts 都位于包根下一层，../web/ 在两种形态下均指向 packages/weishub/web/。 */
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url))

/** 回环 Host 围栏：只接受本机地址，防 DNS rebinding。 */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function readJson(req: IncomingMessage, cap: number): Promise<Record<string, unknown> | null | 'too-large'> {
  const declared = Number(req.headers['content-length'] ?? '0')
  if (Number.isFinite(declared) && declared > cap) {
    req.resume()
    return 'too-large'
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > cap) {
      req.destroy()
      return 'too-large'
    }
    chunks.push(chunk as Buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export async function startWebServer(
  deps: WebServerDeps & { host?: string },
): Promise<{ port: number; close(): Promise<void> }> {
  const cap = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const fetchImpl = deps.fetch ?? globalThis.fetch
  let versionCache: string | undefined
  let loginSession: LoginSession | undefined

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => send(res, 500, { error: '内部错误' }))
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const hub = deps.hub

    // Host 围栏（对应 dsh 的 browser-trust fence）：只接受回环地址的 Host。
    // 防 DNS rebinding——攻击者把域名解析到 127.0.0.1 时，Host 头是他的域名。
    // 这是 token 之外的第二道锁：即使 token 泄露，外部页面也难以借道。
    if (!LOOPBACK_HOST.test(req.headers.host ?? '')) {
      res.statusCode = 403
      res.end()
      return
    }

    // ---- 公共静态资源（无凭据也可访问：仅 logo，不含任何数据） ----
    if ((req.method === 'GET' || req.method === 'HEAD') && path === '/icon.svg') {
      return serveFile(res, 'icon.svg')
    }


    // 鉴权先行：Bearer 头或 ?token= 查询参数任一命中即可。
    // 页面、静态资源、API 一视同仁——面板地址由 weishub 启动时打印（带 token）并在浏览器自动打开。
    const authorized = req.headers.authorization === `Bearer ${deps.token}`
      || url.searchParams.get('token') === deps.token

    // 唯一放行的免鉴权入口：地址栏里**完全没有任何凭据**的根路径。
    // 浏览器地址栏不会发 Bearer 头，所以这等价于「人手输了 localhost:8090」。
    // 注意不能因为带了 Authorization 头就重定向——那会把 token 回写给任意本地进程。
    if (!authorized) {
      // 只有裸根路径才补 token；/index.html 这类明确请求没凭据直接 401，
      // 避免把重定向当成通用兜底。
      const bareRoot = req.method === 'GET' && path === '/'
        && url.searchParams.get('token') === null
        && req.headers.authorization === undefined
      if (bareRoot) {
        // 重定向补 token：<script src> 不继承查询参数，页面必须自己带上才能让子资源通过鉴权
        res.writeHead(302, { location: `/?token=${encodeURIComponent(deps.token)}` })
        res.end()
        return
      }
      res.statusCode = 401
      res.end()
      return
    }

    // ---- 页面（静态） ----
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      return servePage(res)
    }
    if (req.method === 'GET' && path === '/app.js') {
      return serveFile(res, 'app.js')
    }
    // ---- API ----
    if (req.method === 'GET' && path === '/api/state') {
      const snapshot = hub.dispatcher.snapshot()
      // 车道模型：每 (会话, agent) 一条；消息环按会话共享
      const chats = snapshot.chats.map((binding) => ({
        chatId: binding.chatId,
        agentName: binding.agentName,
        sessionId: binding.sessionId,
        mode: snapshot.modes[binding.chatId] ?? 'auto',
        ...hub.dispatcher.queueInfo(binding.chatId, binding.agentName),
      }))
      return send(res, 200, {
        loggedIn: hub.loggedIn,
        credential: hub.credentialHealth,
        agents: hub.agents.map((a) => ({
          name: a.name,
          enabled: a.name === hub.enabledAgent,
          approval: a.approval ?? null,
        })),
        enabledAgent: hub.enabledAgent ?? null,
        chats,
        approvals: hub.approvals.pending(),
        workspace: hub.getWorkspace(),
        outbox: hub.outbox.pending(),
      })
    }

    if (req.method === 'PUT' && path === '/api/agent') {
      const body = await readJson(req, cap)
      if (body === 'too-large') return send(res, 413, { error: '请求体过大' })
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      if (name === '') return send(res, 400, { error: 'name 必须是非空字符串' })
      try {
        await hub.enableAgent(name)
      } catch (error) {
        return send(res, 400, { error: (error as Error).message })
      }
      return send(res, 200, { ok: true, enabledAgent: hub.enabledAgent })
    }

    if (req.method === 'POST' && path === '/api/qr/start') {
      try {
        loginSession = await startLoginSession({ fetch: fetchImpl })
        const dataUrl = await QRCode.toDataURL(loginSession.display)
        return send(res, 200, { display: loginSession.display, dataUrl })
      } catch (error) {
        loginSession = undefined
        return send(res, 502, { error: `获取二维码失败: ${(error as Error).message}` })
      }
    }

    if (req.method === 'GET' && path === '/api/qr/poll') {
      if (loginSession === undefined) return send(res, 200, { status: 'idle' })
      let result: Awaited<ReturnType<typeof pollLoginSession>>
      try {
        result = await pollLoginSession(loginSession, { fetch: fetchImpl })
      } catch {
        return send(res, 200, { status: 'waiting' })
      }
      if (result.status === 'confirmed') {
        await writePrivateJson(defaultCredentialPath(), result.credential)
        await hub.reloadCredential()
        loginSession = undefined
        return send(res, 200, { status: 'confirmed' })
      }
      if (result.status === 'expired' || result.status === 'already-bound') loginSession = undefined
      return send(res, 200, { status: result.status })
    }

    const sendMatch = req.method === 'POST' ? /^\/api\/chats\/([^/]+)\/send$/.exec(path) : null
    if (sendMatch) {
      const body = await readJson(req, cap)
      if (body === 'too-large') return send(res, 413, { error: '请求体过大' })
      const text = typeof body?.text === 'string' ? body.text.trim() : ''
      if (text === '') return send(res, 400, { error: 'text 必须是非空字符串' })
      // 以 owner 身份注入入站管线：全新 UUID 保证不触去重
      const message: InboundMessage = {
        id: randomUUID(),
        chatId: decodeURIComponent(sendMatch[1]!),
        userId: hub.ownerUserId,
        group: false,
        text,
        media: [],
        mediaErrors: [],
      }
      await hub.handleInbound(message)
      return send(res, 200, { ok: true })
    }

    const messagesMatch = req.method === 'GET' ? /^\/api\/chats\/([^/]+)\/messages$/.exec(path) : null
    if (messagesMatch) {
      const chatId = decodeURIComponent(messagesMatch[1]!)
      return send(res, 200, { messages: hub.chatMessages(chatId) })
    }

    const approvalMatch = req.method === 'POST' ? /^\/api\/approvals\/([^/]+)$/.exec(path) : null
    if (approvalMatch) {
      const body = await readJson(req, cap)
      if (body === 'too-large') return send(res, 413, { error: '请求体过大' })
      const decision = body?.decision
      if (decision !== 'allow' && decision !== 'deny') return send(res, 400, { error: "decision 必须是 'allow' 或 'deny'" })
      const id = decodeURIComponent(approvalMatch[1]!)
      if (hub.approvals.resultOf(id) === undefined) return send(res, 404, { error: '未知审批' })
      hub.approvals.resolve(id, decision)
      return send(res, 200, { ok: true })
    }

    if (req.method === 'GET' && path === '/api/workspace') {
      return send(res, 200, hub.getWorkspace())
    }
    if (req.method === 'PUT' && path === '/api/workspace') {
      const body = await readJson(req, cap)
      if (body === 'too-large') return send(res, 413, { error: '请求体过大' })
      if (body === null) return send(res, 400, { error: '请求体必须是 JSON 对象' })
      const global = body.global
      if (global !== undefined && (typeof global !== 'string' || global.trim() === '')) {
        return send(res, 400, { error: 'global 必须是非空字符串' })
      }
      let perAgent: Record<string, string> | undefined
      if (body.perAgent !== undefined) {
        if (typeof body.perAgent !== 'object' || body.perAgent === null || Array.isArray(body.perAgent)) {
          return send(res, 400, { error: 'perAgent 必须是对象' })
        }
        perAgent = {}
        for (const [name, dir] of Object.entries(body.perAgent as Record<string, unknown>)) {
          if (typeof dir !== 'string' || dir.trim() === '') return send(res, 400, { error: `perAgent.${name} 必须是非空字符串` })
          perAgent[name] = dir
        }
      }
      await hub.setWorkspace(global, perAgent)
      return send(res, 200, { ok: true, workspace: hub.getWorkspace() })
    }

    return send(res, 404, { error: '未知路由' })
  }

  async function serveFile(res: ServerResponse, name: string): Promise<void> {
    try {
      const content = await readFile(join(WEB_DIR, name))
      const type = CONTENT_TYPES[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream'
      res.writeHead(200, { 'content-type': type, 'content-length': content.length })
      res.end(content)
    } catch {
      send(res, 404, { error: '未找到' })
    }
  }

  /**
   * 返回面板 HTML，并把 token 注入<script src>。
   * 浏览器对子资源请求**不会**继承页面的查询参数，`<script src="app.js">`
   * 必然被 401 拦掉、整个脚本不执行、页面成空壳——所以必须在服务端补上。
   */
  /**
   * app.js 内容哈希：页面的 script 引用带上它，
   * 代码一改 URL 就变，浏览器不会拿旧缓存跑出新旧混杂的白屏。
   */
  async function assetVersion(): Promise<string> {
    if (versionCache !== undefined) return versionCache
    try {
      versionCache = createHash('sha256').update(await readFile(join(WEB_DIR, 'app.js'))).digest('hex').slice(0, 10)
    } catch {
      versionCache = '0'
    }
    return versionCache
  }

  async function servePage(res: ServerResponse): Promise<void> {
    try {
      const html = await readFile(join(WEB_DIR, 'index.html'), 'utf8')
      const token = encodeURIComponent(deps.token)
      const version = await assetVersion()
      const body = html.replace(
        '<script src="app.js"></script>',
        `<script src="app.js?v=${version}&token=${token}"></script>`,
      )
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      res.end(body)
    } catch {
      send(res, 404, { error: '未找到' })
    }
  }

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(deps.port ?? 0, deps.host ?? '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      resolve({
        port,
        close: () => new Promise<void>((res, rej) => {
          server.close((err) => (err === undefined ? res() : rej(err)))
        }),
      })
    })
  })
}
