import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { InboundMessage } from '@weishub/channel-wechat'
import { defaultCredentialPath, readCredential } from '@weishub/channel-wechat'
import type { AgentConfig, RunOptions, TaskResult } from '@weishub/core'
import { Hub, type HubDeps } from '../src/inbound.js'
import { startWebServer } from '../src/web-server.js'

let seq = 0
let homeDir: string
let workspace: string
let realHome: string | undefined
const hubs: Hub[] = []
const servers: { close(): Promise<void> }[] = []
const tempDirs: string[] = []

const agentClaude: AgentConfig = {
  name: 'claude',
  detect: 'claude',
  run: ['claude', '-p'],
  passVia: 'stdin',
  outputFormat: 'claude-json',
  resume: ['--resume', '{{sessionId}}'],
  approval: null,
  permissionFlags: { auto: [], full: ['--dangerously-skip-permissions'] },
  workspace: null,
  timeoutSec: 10,
}

const agentCodex: AgentConfig = { ...agentClaude, name: 'codex', detect: 'codex' }

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'weishub-home-'))
  workspace = await mkdtemp(join(tmpdir(), 'weishub-ws-'))
  process.env.WEISHUB_HOME = homeDir
  realHome = process.env.HOME
  process.env.HOME = homeDir
})

afterEach(async () => {
  for (const srv of servers) await srv.close().catch(() => undefined)
  servers.length = 0
  for (const hub of hubs) await hub.stop().catch(() => undefined)
  hubs.length = 0
  delete process.env.WEISHUB_HOME
  if (realHome !== undefined) process.env.HOME = realHome
  await rm(homeDir, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  seq += 1
  return {
    id: `m-${seq}`,
    chatId: 'owner-1',
    userId: 'owner-1',
    group: false,
    text: '你好',
    media: [],
    mediaErrors: [],
    ...overrides,
  }
}

interface SentText {
  chatId: string
  text: string
}

function fakeClient() {
  const sent: SentText[] = []
  const polls: InboundMessage[][] = []
  const client = {
    poll: vi.fn(async (): Promise<InboundMessage[]> => polls.shift() ?? new Promise<InboundMessage[]>(() => {})),
    sendText: vi.fn(async (chatId: string, text: string) => {
      sent.push({ chatId, text })
    }),
    sendMedia: vi.fn(async () => {}),
    sendTyping: vi.fn(async () => {}),
  }
  return { client, sent, polls }
}

function fakeRun() {
  const calls: { config: AgentConfig; options: RunOptions }[] = []
  const run = vi.fn(async (config: AgentConfig, options: RunOptions): Promise<TaskResult> => {
    calls.push({ config, options })
    return { text: `echo:${options.prompt}`, exitCode: 0 }
  })
  return { run, calls }
}

interface HubKit {
  hub: Hub
  sent: SentText[]
  calls: { config: AgentConfig; options: RunOptions }[]
}

function makeHub(overrides: Partial<HubDeps> = {}): HubKit {
  const { client, sent } = fakeClient()
  const { run, calls } = fakeRun()
  const deps: HubDeps = {
    client,
    accountId: 'bot-1',
    ownerUserId: 'owner-1',
    agents: [agentClaude, agentCodex],
    workspace,
    run,
    ...overrides,
  }
  const hub = new Hub(deps)
  hubs.push(hub)
  return { hub, sent, calls }
}

const TOKEN = 'secret-token'


/** 发原始 GET，返回状态码与 Location（fetch 无法覆写 Host / 观察 302 全貌）。 */
function rawGetResponse(port: number, hostHeader: string, path: string, extraHeaders = ''): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\n${extraHeaders}Connection: close\r\n\r\n`)
    })
    let buffer = ''
    socket.on('data', (chunk) => { buffer += chunk })
    socket.on('end', () => {
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(buffer)?.[1] ?? 0)
      const location = /\r\nlocation: ([^\r\n]+)/i.exec(buffer)?.[1]
      resolve({ status, location })
    })
    socket.on('error', reject)
  })
}

/** 用原始 socket 发 GET，便于构造自定义 Host 头（fetch 不允许覆写）。 */
function rawGet(port: number, hostHeader: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`)
    })
    let buffer = ''
    socket.on('data', (chunk) => { buffer += chunk })
    socket.on('end', () => resolve(buffer))
    socket.on('error', reject)
  })
}

async function makeServer(hub: Hub, overrides: { fetch?: typeof globalThis.fetch } = {}) {
  const srv = await startWebServer({ hub, token: TOKEN, fetch: overrides.fetch })
  servers.push(srv)
  return { url: `http://127.0.0.1:${srv.port}`, port: srv.port, close: srv.close }
}

function get(url: string, path: string): Promise<Response> {
  return fetch(`${url}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })
}

async function postJson(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function putJson(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('页面、静态资源、API 全部要求 token', async () => {
  const kit = makeHub()
  const { url } = await makeServer(kit.hub)
  // 根路径无凭据时是 302（补 token），其余一律 401
  expect((await fetch(`${url}/`, { redirect: 'manual' })).status).toBe(302)
  expect((await fetch(`${url}/index.html`)).status).toBe(401)
  expect((await fetch(`${url}/app.js`)).status).toBe(401)
  expect((await fetch(`${url}/api/state`)).status).toBe(401)
  expect((await fetch(`${url}/api/state`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
  // 带 token 的页面地址可以正常打开
  expect((await fetch(`${url}/?token=${TOKEN}`)).status).toBe(200)
  expect((await fetch(`${url}/app.js?token=${TOKEN}`)).status).toBe(200)
  expect((await fetch(`${url}/api/state?token=${TOKEN}`)).status).toBe(200)
})

test('地址栏手输根路径（无任何凭据）重定向到带 token 的地址', async () => {
  // 浏览器地址栏不发 Authorization 头，等价于「人手输 localhost:8090」——自动补 token
  const kit = makeHub()
  const { port } = await makeServer(kit.hub)
  const res = await rawGetResponse(port, `127.0.0.1:${port}`, '/')
  expect(res.status).toBe(302)
  expect(res.location).toBe(`/?token=${TOKEN}`)
})

test('带了 Authorization 头但没 token 时不重定向（避免把 token 回写给本地进程）', async () => {
  const kit = makeHub()
  const { port } = await makeServer(kit.hub)
  const res = await rawGetResponse(port, `127.0.0.1:${port}`, '/', `Authorization: Bearer ${TOKEN}\r\n`)
  expect(res.status).toBe(200) // 已鉴权，直接给页面
  const wrong = await rawGetResponse(port, `127.0.0.1:${port}`, '/', 'Authorization: Bearer wrong\r\n')
  expect(wrong.status).toBe(401) // 凭据错：401，绝不回写真 token
  expect(wrong.location).toBeUndefined()
})

test('/api/state 返回 snapshot、pending 审批与登录态', async () => {
  const kit = makeHub()
  const { url } = await makeServer(kit.hub)
  kit.hub.dispatcher.bind('room-1', 'codex')
  kit.hub.dispatcher.setMode('room-1', 'full')
  const { id } = kit.hub.approvals.startRequest('room-1', 'Bash', '{"command":"ls"}')
  const res = await get(url, '/api/state')
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    loggedIn: boolean
    chats: { chatId: string; agentName: string; mode: string; queued: number }[]
    approvals: { id: string; tool: string }[]
    agents: { name: string; enabled: boolean }[]
    enabledAgent: string | null
  }
  expect(body.loggedIn).toBe(false)
  const chat = body.chats.find((c) => c.chatId === 'room-1')
  expect(chat).toMatchObject({ agentName: 'codex', mode: 'full', queued: 0 })
  expect(body.approvals).toEqual([expect.objectContaining({ id, tool: 'Bash' })])
  expect(body.agents.map((a) => a.name)).toEqual(['claude', 'codex'])
  expect(body.enabledAgent).toBe('claude')
  expect(body.agents.filter((a) => a.enabled).map((a) => a.name)).toEqual(['claude'])
})

test('/api/chats/:id/send 以 owner 身份注入：run 收到提示词、fake client 收到回复', async () => {
  const kit = makeHub()
  const { url } = await makeServer(kit.hub)
  const res = await postJson(url, '/api/chats/room-web/send', { text: '网页插话' })
  expect(res.status).toBe(200)
  await vi.waitFor(() => expect(kit.calls).toHaveLength(1))
  expect(kit.calls[0]!.options.prompt).toBe('网页插话')
  expect(kit.calls[0]!.options.cwd).toBe(workspace)
  await vi.waitFor(() => expect(kit.sent.map((s) => s.text).join('\n')).toContain('echo:网页插话'))
  // 缺 text / 空 text 拒绝
  expect((await postJson(url, '/api/chats/room-web/send', {})).status).toBe(400)
  expect((await postJson(url, '/api/chats/room-web/send', { text: '  ' })).status).toBe(400)
})

test('/api/approvals/:id 决议兑现真实 ApprovalRouter.request；未知 id 404', async () => {
  const kit = makeHub()
  const { url } = await makeServer(kit.hub)
  const done = kit.hub.approvals.request('room-1', 'Bash', '{}').then((r) => {
    expect(r).toBe('allow')
    return r
  })
  const pending = kit.hub.approvals.pending()[0]!
  const res = await postJson(url, `/api/approvals/${pending.id}`, { decision: 'allow' })
  expect(res.status).toBe(200)
  await expect(done).resolves.toBe('allow')
  expect((await postJson(url, '/api/approvals/ap-unknown', { decision: 'allow' })).status).toBe(404)
  expect((await postJson(url, `/api/approvals/${pending.id}`, { decision: 'wat' })).status).toBe(400)
})

test('PUT /api/workspace 运行时生效（cwdFor）且重启后保持（落盘）', async () => {
  const dir2 = await mkdtemp(join(tmpdir(), 'weishub-ws2-'))
  tempDirs.push(dir2)
  const kit = makeHub()
  const srv = await makeServer(kit.hub)
  const res = await putJson(srv.url, '/api/workspace', { global: dir2 })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { workspace: { global: string } }
  expect(body.workspace.global).toBe(dir2)

  // 运行时生效：后续 run 的 cwd 用新目录
  await kit.hub.handleInbound(msg({ id: 'ws-1', chatId: 'room-a', text: '新目录任务' }))
  await vi.waitFor(() => expect(kit.calls).toHaveLength(1))
  expect(kit.calls[0]!.options.cwd).toBe(dir2)

  // 落盘：重启（重新 load）后保持
  await kit.hub.stop()
  const hub2 = makeHub().hub
  await hub2.start()
  expect(hub2.getWorkspace().global).toBe(dir2)
  await hub2.handleInbound(msg({ id: 'ws-2', chatId: 'room-b', text: '重启后任务' }))
  await vi.waitFor(() => expect(hub2 !== kit.hub).toBe(true))
  await hub2.stop()
})

test('PUT /api/workspace 支持 perAgent 覆盖并优先于全局', async () => {
  const dir3 = await mkdtemp(join(tmpdir(), 'weishub-ws3-'))
  tempDirs.push(dir3)
  const kit = makeHub()
  const srv = await makeServer(kit.hub)
  const res = await putJson(srv.url, '/api/workspace', { perAgent: { codex: dir3 } })
  expect(res.status).toBe(200)
  kit.hub.dispatcher.bind('room-c', 'codex')
  await kit.hub.handleInbound(msg({ id: 'pa-1', chatId: 'room-c', text: 'codex 任务' }))
  await vi.waitFor(() => expect(kit.calls).toHaveLength(1))
  expect(kit.calls[0]!.options.cwd).toBe(dir3)
  // GET 回读
  const got = await get(srv.url, '/api/workspace')
  expect(await got.json()).toEqual({ global: workspace, perAgent: { codex: dir3 } })
  // 非法 body 拒绝
  expect((await putJson(srv.url, '/api/workspace', { global: 42 })).status).toBe(400)
})

test('/api/qr/start 用注入的假 fetch 返回 display 与二维码 dataUrl；poll confirmed 写凭据', async () => {
  const fakeFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href
    if (href.includes('get_bot_qrcode')) {
      return new Response(JSON.stringify({ qrcode: 'qr-123', qrcode_img_content: 'https://login.example/qr' }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      status: 'confirmed',
      ilink_bot_id: 'bot-web',
      bot_token: 'tok-web',
      baseurl: 'https://ilinkai.weixin.qq.com',
      ilink_user_id: 'owner-1',
    }), { headers: { 'content-type': 'application/json' } })
  })
  const kit = makeHub()
  const srv = await makeServer(kit.hub, { fetch: fakeFetch as typeof globalThis.fetch })
  const res = await postJson(srv.url, '/api/qr/start', {})
  expect(res.status).toBe(200)
  const body = (await res.json()) as { display: string; dataUrl: string }
  expect(body.display).toBe('https://login.example/qr')
  expect(body.dataUrl).toMatch(/^data:image\/png;base64,/)

  const poll = await get(srv.url, '/api/qr/poll')
  expect(poll.status).toBe(200)
  expect(await poll.json()).toEqual({ status: 'confirmed' })
  const credential = await readCredential(defaultCredentialPath())
  expect(credential.token).toBe('tok-web')
  // 未 start 会话时 poll 报 idle
  const idle = await get(srv.url, '/api/qr/poll')
  expect(await idle.json()).toEqual({ status: 'idle' })
})

test('GET / 返回面板页面；GET /app.js 返回脚本', async () => {
  const kit = makeHub()
  const { url } = await makeServer(kit.hub)
  const page = await get(url, '/')
  expect(page.status).toBe(200)
  expect(page.headers.get('content-type')).toContain('text/html')
  const html = await page.text()
  expect(html).toContain('id="engine-rack"')
  expect(html).toContain('id="login-overlay"')
  const js = await get(url, '/app.js')
  expect(js.status).toBe(200)
  expect(js.headers.get('content-type')).toContain('javascript')
  expect(await js.text()).toContain('/api/state')
  expect((await get(url, '/nope.js')).status).toBe(404)
})

test('PUT /api/agent 切换唯一启用的 agent，并把已绑定会话改绑过去', async () => {
  const kit = makeHub()
  const { url } = await makeServer(kit.hub)
  kit.hub.dispatcher.bind('room-a', 'claude')
  kit.hub.dispatcher.setSession('room-a', 'sess-1')

  const res = await putJson(url, '/api/agent', { name: 'codex' })
  expect(res.status).toBe(200)
  expect((await res.json()).enabledAgent).toBe('codex')

  // 唯一性：只有 codex 是启用的
  const state = (await (await get(url, '/api/state')).json()) as {
    agents: { name: string; enabled: boolean }[]
    enabledAgent: string | null
    chats: { chatId: string; agentName: string; sessionId?: string }[]
  }
  expect(state.enabledAgent).toBe('codex')
  expect(state.agents.filter((a) => a.enabled)).toHaveLength(1)
  expect(state.agents.find((a) => a.enabled)!.name).toBe('codex')
  // 改绑：现有聊天跟随启用的 agent，且换 agent 会重置会话
  const chat = state.chats.find((c) => c.chatId === 'room-a')!
  expect(chat.agentName).toBe('codex')
  expect(chat.sessionId).toBeUndefined()
})

test('PUT /api/agent 拒绝未安装的 agent', async () => {
  const kit = makeHub()
  const { url } = await makeServer(kit.hub)
  const res = await putJson(url, '/api/agent', { name: 'gemini' })
  expect(res.status).toBe(400)
  expect((await res.json()).error).toContain('未安装或未发现')
})

test('启用的 agent 持久化：重启后仍是同一个', async () => {
  const kit = makeHub()
  const { url } = await makeServer(kit.hub)
  await putJson(url, '/api/agent', { name: 'codex' })
  const saved = JSON.parse(await readFile(join(homeDir, 'state.json'), 'utf8')) as { enabledAgent?: string }
  expect(saved.enabledAgent).toBe('codex')
})
