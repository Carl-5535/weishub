// 本地回环 HTTP API：wx CLI 的出站推送、审批桥（approval-mcp）与状态查询的服务端。
// node:http 手写路由，不引 express；仅监听 127.0.0.1，token 鉴权。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Outbox } from '@weishub/channel-wechat'
import type { ApprovalRouter, ApprovalDecision } from './approval.js'

export interface NotifyDeps {
  token: string
  /**
   * owner 会话 id。owner-only 模型下可能被「首条私聊认主」改写（认领 id ≠ 凭据
   * userId），所以支持传取值函数，兜底入队在发送时刻取最新值，避免把消息
   * 发进已失效的旧代际会话。
   */
  ownerChatId: string | (() => string)
  /** 发送文本（未登录/通道失效时抛错） */
  sendText(text: string): Promise<void>
  /** 发送图片（未登录/通道失效时抛错） */
  sendImage(name: string, bytes: Uint8Array): Promise<void>
  outbox: Outbox
  /** 审批路由：提供后挂载 /approvals/* 路由（approval-mcp 桥依赖） */
  approvals?: ApprovalRouter
  /**
   * 新审批挂起时回调（lane 作用域 chatId，形如 `<会话>::<agent>`）。
   * hub 用它把审批请求推送到微信——审批桥自身只登记与轮询，不推送，
   * 缺了它用户在微信侧收不到任何提示，claude 会静默挂到超时。
   */
  onApprovalRequest?: (chatId: string, tool: string, input: string) => void
  /** 可选状态探针：/status 的 loggedIn 与 credentialExpiresHint */
  getLoggedIn?: () => boolean
  getCredentialHint?: () => string | undefined
}

/** body 上限：主要给图片 base64 留余量 */
export const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024

function resolveOwnerChatId(deps: NotifyDeps): string {
  return typeof deps.ownerChatId === 'function' ? deps.ownerChatId() : deps.ownerChatId
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** 读取请求体，超过上限即拒绝（返回 null），避免恶意大包撑爆内存 */
function readBody(req: IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length'] ?? '0')
    if (Number.isFinite(declared) && declared > cap) {
      req.resume()
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (buf: Buffer | null): void => {
      if (done) return
      done = true
      resolve(buf)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > cap) {
        req.destroy()
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks)))
    req.on('error', () => finish(null))
  })
}

async function readJson(req: IncomingMessage, cap: number): Promise<Record<string, unknown> | null | 'too-large'> {
  const buf = await readBody(req, cap)
  if (buf === null) return 'too-large'
  try {
    const parsed: unknown = JSON.parse(buf.toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export async function startNotifyApi(
  deps: NotifyDeps & { host?: string; port?: number; maxBodyBytes?: number },
): Promise<{ port: number; close(): Promise<void> }> {
  const cap = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => send(res, 500, { error: '内部错误' }))
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 鉴权先行：所有路由都要 Bearer token，否则 401（无 body 唠叨）
    if (req.headers.authorization !== `Bearer ${deps.token}`) {
      res.statusCode = 401
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    if (req.method === 'POST' && path === '/notify') {
      const body = await readJson(req, cap)
      if (body === 'too-large') return send(res, 413, { error: '请求体过大' })
      if (body === null || typeof body.text !== 'string') return send(res, 400, { error: 'text 必须是字符串' })
      try {
        await deps.sendText(body.text)
        return send(res, 200, { ok: true })
      } catch {
        // 通道未就绪：内容保留进发件箱，绝不丢失（Review Focus #3）
        deps.outbox.enqueue(resolveOwnerChatId(deps), body.text)
        return send(res, 503, { error: '微信通道未就绪' })
      }
    }

    if (req.method === 'POST' && path === '/notify/image') {
      const body = await readJson(req, cap)
      if (body === 'too-large') return send(res, 413, { error: '请求体过大' })
      if (body === null || typeof body.name !== 'string' || typeof body.dataBase64 !== 'string') {
        return send(res, 400, { error: 'name 与 dataBase64 必须是字符串' })
      }
      const bytes = new Uint8Array(Buffer.from(body.dataBase64, 'base64'))
      try {
        await deps.sendImage(body.name, bytes)
        return send(res, 200, { ok: true })
      } catch {
        // 图片可靠性不在契约内：响亮失败提示重试，不入队（outbox 文件条目按路径走，此处无文件）
        return send(res, 503, { error: '微信通道未就绪', note: '图片未入队，请重试' })
      }
    }

    if (req.method === 'GET' && path === '/status') {
      return send(res, 200, {
        loggedIn: deps.getLoggedIn?.() ?? false,
        credentialExpiresHint: deps.getCredentialHint?.(),
        pending: Object.keys(deps.outbox.pending()).length,
      })
    }

    if (req.method === 'POST' && path === '/approvals/request') {
      if (!deps.approvals) return send(res, 500, { error: '审批路由未配置' })
      const body = await readJson(req, cap)
      if (body === 'too-large') return send(res, 413, { error: '请求体过大' })
      if (body === null || typeof body.chatId !== 'string' || typeof body.tool !== 'string') {
        return send(res, 400, { error: 'chatId 与 tool 必须是字符串' })
      }
      const input = body.input ?? {}
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return send(res, 400, { error: 'input 必须是对象' })
      }
      // 立即答 id，不长挂——审批桥拿到 id 后轮询 /approvals/result/:id
      const { id } = deps.approvals.startRequest(body.chatId, body.tool, JSON.stringify(input))
      // 推送审批请求到微信（失败不影响登记：面板仍可见，桥照常轮询）
      try {
        deps.onApprovalRequest?.(body.chatId, body.tool, JSON.stringify(input))
      } catch {
        // 通知失败只影响时效，不影响审批本身
      }
      return send(res, 200, { id })
    }

    const resultMatch = req.method === 'GET' ? /^\/approvals\/result\/([^/]+)$/.exec(path) : null
    if (resultMatch) {
      if (!deps.approvals) return send(res, 500, { error: '审批路由未配置' })
      const id = decodeURIComponent(resultMatch[1]!)
      const result: ApprovalDecision | 'pending' | undefined = deps.approvals.resultOf(id)
      if (result === undefined) return send(res, 404, { error: '未知审批' })
      return send(res, 200, { result })
    }

    return send(res, 404, { error: '未知路由' })
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
