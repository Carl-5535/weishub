// 独立 stdio MCP server：claude 以 --permission-prompt-tool 接入，把权限请求转发给 hub 本地 HTTP API。
// 手写最小 JSON-RPC 2.0 分发，不引 MCP SDK。配置全部来自 env，绝不读 argv。
import { pathToFileURL } from 'node:url'

type Behavior = 'allow' | 'deny' | 'timeout'

const PORT = process.env.WEISHUB_PORT
const TOKEN = process.env.WEISHUB_TOKEN
const POLL_MS = Number(process.env.WEISHUB_POLL_MS ?? '1000')

const TOOLS = [
  {
    name: 'weishub_request_permission',
    description: '向微枢用户发起权限审批，等待微信回复或超时',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: '发起任务的微信 chat id' },
        tool: { type: 'string', description: '被审批的工具名' },
        input: { type: 'string', description: '工具入参（JSON 字符串）' },
      },
      required: ['chatId', 'tool', 'input'],
    },
  },
]

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

async function hub(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...init?.headers },
  })
  if (!res.ok) throw new Error(`hub ${res.status}`)
  return res.json()
}

async function requestPermission(args: { chatId: string; tool: string; input: string }): Promise<Behavior> {
  try {
    const { id } = (await hub('/approvals/request', {
      method: 'POST',
      body: JSON.stringify(args),
    })) as { id: string }
    for (;;) {
      const { result } = (await hub(`/approvals/result/${id}`)) as { result: Behavior }
      if (result === 'allow' || result === 'deny' || result === 'timeout') return result
      await new Promise((ok) => setTimeout(ok, POLL_MS))
    }
  } catch {
    return 'deny' // hub 不可达/404/500 一律拒绝，宁可误杀不可放行
  }
}

async function dispatch(id: unknown, method: string, params: Record<string, unknown> = {}): Promise<void> {
  if (method === 'initialize') {
    const p = params as { protocolVersion?: string }
    reply(id, {
      protocolVersion: p.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'weishub-approval', version: '0.1.0' },
    })
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS })
  } else if (method === 'tools/call') {
    const { name, arguments: args } = params as { name: string; arguments?: Record<string, string> }
    if (name !== 'weishub_request_permission') {
      reply(id, { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny' }) }] })
      return
    }
    const behavior = await requestPermission({
      chatId: String(args?.chatId ?? ''),
      tool: String(args?.tool ?? ''),
      input: String(args?.input ?? ''),
    })
    reply(id, { content: [{ type: 'text', text: JSON.stringify({ behavior }) }] })
  } else if (typeof id !== 'undefined') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法: ${method}` } })}\n`)
  }
}

function handleLine(line: string, onSettled?: () => void): void {
  const text = line.trim()
  if (!text) return
  try {
    const msg = JSON.parse(text) as { id?: unknown; method?: string; params?: Record<string, unknown> }
    if (msg.method) void dispatch(msg.id, msg.method, msg.params).finally(onSettled)
  } catch (err) {
    process.stderr.write(`坏消息: ${(err as Error).message}\n`)
  }
}

function main(): void {
  if (!PORT || !TOKEN) {
    process.stderr.write('缺少 WEISHUB_PORT / WEISHUB_TOKEN 环境变量\n')
    process.exit(1)
  }
  // 手动按行切分而非 readline：stdin 立刻 EOF 时 readline 可能丢掉已缓冲的整行
  let buffer = ''
  let inFlight = 0
  let stdinEnded = false
  const settled = (): void => {
    inFlight--
    if (stdinEnded && inFlight === 0) process.exit(0)
  }
  const accept = (line: string): void => {
    if (!line.trim()) return
    inFlight++
    handleLine(line, settled)
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      accept(buffer.slice(0, idx))
      buffer = buffer.slice(idx + 1)
    }
  })
  process.stdin.on('end', () => {
    stdinEnded = true
    accept(buffer)
    buffer = ''
    if (inFlight === 0) process.exit(0)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
