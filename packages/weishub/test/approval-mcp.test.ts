import { execSync, spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../../..')
const scriptPath = resolve(repoRoot, 'packages/weishub/lib/approval-mcp.js')
const TOKEN = 'test-token'

let server: Server
let port: number

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
        const parsed = JSON.parse(body) as { tool?: string }
        if (parsed.tool === 'boom') {
          res.writeHead(404).end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'ap-1' }))
      })
      return
    }
    if (req.method === 'GET' && req.url === '/approvals/result/ap-1') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ result: 'allow' }))
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
  const toolList = (tools!.result! as { tools: { name: string }[] }).tools
  expect(toolList.map((t) => t.name)).toContain('weishub_request_permission')
})

test('tools/call 透传：hub 返回 allow，MCP 内容 behavior=allow', async () => {
  const responses = await callMcp(mcpEnv(), [
    { id: 1, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'weishub_request_permission', arguments: { chatId: 'chat-9', tool: 'Bash', input: 'ls' } } } },
  ])
  const resp = responses.get(1)
  expect(resp).toBeDefined()
  expect(resp!.result).toBeDefined()
  const content = (resp!.result! as { content: { type: string; text: string }[] }).content
  expect(Array.isArray(content)).toBe(true)
  const behavior = JSON.parse(content[0].text) as { behavior: string }
  expect(behavior.behavior).toBe('allow')
})

test('hub 返回 404 时 MCP 以 behavior=deny 兜底', async () => {
  const responses = await callMcp(mcpEnv(), [
    { id: 1, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'weishub_request_permission', arguments: { chatId: 'chat-9', tool: 'boom', input: 'x' } } } },
  ])
  const resp = responses.get(1)
  expect(resp).toBeDefined()
  const content = (resp!.result! as { content: { type: string; text: string }[] }).content
  const behavior = JSON.parse(content[0].text) as { behavior: string }
  expect(behavior.behavior).toBe('deny')
})
