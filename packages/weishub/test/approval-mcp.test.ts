import { execSync, spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../../..')
const scriptPath = resolve(repoRoot, 'packages/weishub/lib/approval-mcp.js')
const TOKEN = 'test-token'

let server: Server
let port: number
/** stub hub 最近一次收到的 /approvals/request body（断言 chatId 投递目标用） */
let lastRequest: { chatId?: string; tool?: string } | undefined

beforeAll(async () => {
  // 测试必须跑真实的编译产物进程，先确保 lib/approval-mcp.js 存在
  execSync('npx tsc -b packages/weishub', { cwd: repoRoot, stdio: 'pipe' })
  server = createServer((req, res) => {
    const deny401 = () => {
      res.writeHead(401).end()
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return deny401()
    if (req.method === 'POST' && req.url === '/approvals/request') {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk))
      req.on('end', () => {
        const parsed = JSON.parse(body) as { tool?: string; chatId?: string }
        lastRequest = parsed
        if (parsed.tool === 'boom') {
          res.writeHead(404).end()
          return
        }
        // 'slow' 走 timeout 结果路径，其余走 allow
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: parsed.tool === 'slow' ? 'ap-2' : 'ap-1' }))
      })
      return
    }
    if (req.method === 'GET' && req.url === '/approvals/result/ap-1') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ result: 'allow' }))
      return
    }
    if (req.method === 'GET' && req.url === '/approvals/result/ap-2') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ result: 'timeout' }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  port = (server.address() as { port: number }).port
})

afterAll(() => new Promise<void>((ok) => server.close(() => ok())))

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

/** spawn 真实 stdio 进程，逐行收 JSON-RPC 响应，按 id 取回 */
function callMcp(env: NodeJS.ProcessEnv, messages: { id: number; body: unknown }[]): Promise<Map<number, JsonRpcResponse>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('node', [scriptPath], { env })
    const responses = new Map<number, JsonRpcResponse>()
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`MCP 进程响应超时，已收到: ${JSON.stringify([...responses.values()])}`))
    }, 10_000)
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        const msg = JSON.parse(line) as JsonRpcResponse
        if (typeof msg.id === 'number') responses.set(msg.id, msg)
        if (responses.size >= messages.length) {
          clearTimeout(timer)
          child.kill('SIGKILL')
          resolvePromise(responses)
        }
      }
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      rejectPromise(err)
    })
    for (const m of messages) child.stdin.write(`${JSON.stringify(m.body)}\n`)
    child.stdin.end()
  })
}

function mcpEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WEISHUB_PORT: String(port),
    WEISHUB_TOKEN: TOKEN,
    WEISHUB_POLL_MS: '20',
  }
}

test('initialize 与 tools/list 返回合法 JSON-RPC 结果，tools/list 暴露审批工具', async () => {
  const responses = await callMcp(mcpEnv(), [
    { id: 1, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } } },
    { id: 2, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } },
  ])
  const init = responses.get(1)
  expect(init).toBeDefined()
  expect(init!.jsonrpc).toBe('2.0')
  expect(init!.result).toBeDefined()
  expect(typeof (init!.result! as { protocolVersion: string }).protocolVersion).toBe('string')
  expect((init!.result! as { serverInfo: { name: string } }).serverInfo.name).toBeTruthy()

  const tools = responses.get(2)
  expect(tools).toBeDefined()
  const tool = (tools!.result! as { tools: { name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }[] }).tools.find((t) => t.name === 'weishub_request_permission')
  expect(tool).toBeDefined()
  // chatId 可选：缺省回退 WEISHUB_CHAT_ID
  expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(['tool_name', 'input']))
  expect(tool!.inputSchema.required).not.toContain('chatId')
  expect(tool!.inputSchema.properties.tool_name).toBeDefined()
  expect(tool!.inputSchema.properties.input).toBeDefined()
})

test('tools/call：hub allow → behavior=allow 且 updatedInput 原样回显；chatId 缺省回退 WEISHUB_CHAT_ID', async () => {
  const env = { ...mcpEnv(), WEISHUB_CHAT_ID: 'chat-env' }
  const responses = await callMcp(env, [
    { id: 1, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'weishub_request_permission', arguments: { tool_name: 'Bash', input: { command: 'ls -la' } } } } },
  ])
  const resp = responses.get(1)
  expect(resp).toBeDefined()
  expect(resp!.result).toBeDefined()
  const content = (resp!.result! as { content: { type: string; text: string }[] }).content
  expect(Array.isArray(content)).toBe(true)
  const decision = JSON.parse(content[0].text) as { behavior: string; updatedInput?: unknown }
  expect(decision.behavior).toBe('allow')
  expect(decision.updatedInput).toEqual({ command: 'ls -la' })
})

test('hub 返回 timeout → MCP 层映射为 behavior=deny 并带超时说明', async () => {
  const responses = await callMcp(mcpEnv(), [
    { id: 1, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'weishub_request_permission', arguments: { tool_name: 'slow', input: {}, chatId: 'chat-9' } } } },
  ])
  const resp = responses.get(1)
  expect(resp).toBeDefined()
  const content = (resp!.result! as { content: { type: string; text: string }[] }).content
  const decision = JSON.parse(content[0].text) as { behavior: string; message?: string }
  expect(decision.behavior).toBe('deny')
  expect(decision.message).toContain('超时')
})

test('hub 返回 404 时 MCP 以 behavior=deny 兜底', async () => {
  const responses = await callMcp(mcpEnv(), [
    { id: 1, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'weishub_request_permission', arguments: { tool_name: 'boom', input: { x: 1 }, chatId: 'chat-9' } } } },
  ])
  const resp = responses.get(1)
  expect(resp).toBeDefined()
  const content = (resp!.result! as { content: { type: string; text: string }[] }).content
  const decision = JSON.parse(content[0].text) as { behavior: string; message?: string }
  expect(decision.behavior).toBe('deny')
  expect(typeof decision.message).toBe('string')
})

test('模型显式传 chatId 不生效：投递目标只由 serve 层 env 决定', async () => {
  const env = { ...mcpEnv(), WEISHUB_CHAT_ID: 'chat-env' }
  await callMcp(env, [
    { id: 1, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'weishub_request_permission', arguments: { tool_name: 'Bash', input: {}, chatId: 'chat-evil' } } } },
  ])
  // 审批必须落在 serve 层注入的 chat 上，而不是模型自己声明的 chat
  expect(lastRequest).toMatchObject({ chatId: 'chat-env' })
})
