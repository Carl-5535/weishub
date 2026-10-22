import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { InboundMessage } from '@weishub/channel-wechat'
import { defaultCredentialPath, readCredential } from '@weishub/channel-wechat'
import type { AgentConfig, RunOptions, TaskResult } from '@weishub/core'
import { Hub, type HubDeps } from '../src/inbound.js'

let seq = 0
let homeDir: string
let workspace: string
let realHome: string | undefined
const hubs: Hub[] = []
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
  // homedir() 指向临时目录：避免 legacyCredentialPath 读到开发机真实的 ~/.dsh
  realHome = process.env.HOME
  process.env.HOME = homeDir
})

afterEach(async () => {
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
  const mediaSent: { chatId: string; name: string }[] = []
  const polls: InboundMessage[][] = []
  const client = {
    // 队列空时模拟长轮询挂起（真实 getupdates 会 hold），避免后台循环热转
    poll: vi.fn(async (): Promise<InboundMessage[]> => polls.shift() ?? new Promise<InboundMessage[]>(() => {})),
    sendText: vi.fn(async (chatId: string, text: string) => {
      sent.push({ chatId, text })
    }),
    sendMedia: vi.fn(async (chatId: string, name: string) => {
      mediaSent.push({ chatId, name })
    }),
    sendTyping: vi.fn(async () => {}),
  }
  return { client, sent, mediaSent, polls }
}

function fakeRun(impl?: (prompt: string, options: RunOptions) => TaskResult | Promise<TaskResult>) {
  const calls: { config: AgentConfig; options: RunOptions }[] = []
  const run = vi.fn(async (config: AgentConfig, options: RunOptions): Promise<TaskResult> => {
    calls.push({ config, options })
    return impl ? await impl(options.prompt, options) : { text: `echo:${options.prompt}`, exitCode: 0 }
  })
  return { run, calls }
}

interface HubKit {
  hub: Hub
  client: ReturnType<typeof fakeClient>['client']
  sent: SentText[]
  mediaSent: { chatId: string; name: string }[]
  polls: InboundMessage[][]
  calls: { config: AgentConfig; options: RunOptions }[]
}

function makeHub(overrides: Partial<HubDeps> = {}, runImpl?: (prompt: string, options: RunOptions) => TaskResult | Promise<TaskResult>): HubKit {
  const { client, sent, mediaSent, polls } = fakeClient()
  const { run, calls } = fakeRun(runImpl)
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
  return { hub, client, sent, mediaSent, polls, calls }
}

async function drain(hub: Hub): Promise<void> {
  await hub.outbox.resumePending()
}

/** 等待 n 个任务被 run 接收（submit 是 fire-and-forget，需显式等待），再等回复入队并投递静默。 */
async function settle(kit: HubKit, n = 1): Promise<void> {
  await vi.waitFor(() => expect(kit.calls).toHaveLength(n))
  // 放行全部微任务：run 完成 → dispatcher.then → onReply 入队
  await new Promise((resolve) => setTimeout(resolve, 0))
  await drain(kit.hub)
}

test('非 owner 的消息被忽略（owner-only 白名单）', async () => {
  const { hub, sent, calls } = makeHub()
  await hub.handleInbound(msg({ userId: 'stranger', chatId: 'stranger', text: 'hello' }))
  await drain(hub)
  expect(calls).toHaveLength(0)
  expect(sent).toHaveLength(0)
})

test('重复 msg.id 只处理一次（dedupe）', async () => {
  const { hub, calls } = makeHub()
  const m = msg({ id: 'dup-1', text: '跑个任务' })
  await hub.handleInbound(m)
  await hub.handleInbound(m)
  await drain(hub)
  expect(calls).toHaveLength(1)
})

test('命令文本（/ 开头）转命令处理：/help 有回复且不进 dispatcher.submit', async () => {
  const { hub, sent, calls } = makeHub()
  await hub.handleInbound(msg({ text: '/help' }))
  await drain(hub)
  expect(calls).toHaveLength(0) // 从未到达 dispatcher.submit
  expect(sent.map((s) => s.text).join('\n')).toContain('/help')
})

test('普通文本提交 dispatcher，首次自动绑定发现列表第一个 agent 并回欢迎语', async () => {
  const { hub, sent, calls } = makeHub()
  await hub.handleInbound(msg({ text: '第一个任务' }))
  await drain(hub)
  expect(hub.dispatcher.binding('owner-1')?.agentName).toBe('claude')
  expect(calls).toHaveLength(1)
  expect(calls[0]!.options.prompt).toBe('第一个任务')
  expect(sent.map((s) => s.text).join('\n')).toContain('claude') // 欢迎语点名绑定
  // 第二条消息不再重复欢迎
  const before = sent.length
  await hub.handleInbound(msg({ text: '第二个任务' }))
  await drain(hub)
  expect(sent.length).toBe(before) // 只有任务回复经 onReply 入 outbox，欢迎语只有一次
})

test('无可用 agent 时回复安装提示（Review Focus #2）', async () => {
  const { hub, sent, calls } = makeHub({ agents: [] })
  await hub.handleInbound(msg({ text: '在吗' }))
  await drain(hub)
  expect(calls).toHaveLength(0)
  expect(sent.map((s) => s.text).join('\n')).toContain('未发现可用 agent，请先安装 claude/codex 等')
})

test('任务结果经 outbox 分块回发', async () => {
  const long = '甲乙丙丁戊己庚辛壬癸'.repeat(10) // 100 字
  const kit = makeHub({ maxReplyChars: 30 }, async () => ({ text: long, exitCode: 0 }))
  await kit.hub.handleInbound(msg({ text: '来段长的' }))
  await settle(kit)
  const chunks = kit.sent.filter((s) => s.text.includes('甲'))
  expect(chunks.length).toBeGreaterThanOrEqual(4)
  expect(chunks.map((c) => c.text).join('')).toBe(long)
  expect(Object.keys(kit.hub.outbox.pending())).toHaveLength(0)
})

test('agent 空结果回复占位文案', async () => {
  const kit = makeHub(undefined, async () => ({ text: '', exitCode: 0 }))
  await kit.hub.handleInbound(msg({ text: '没输出吗' }))
  await settle(kit)
  expect(kit.sent.map((s) => s.text).join('\n')).toContain('（任务完成，无文本输出）')
})

test('有挂起审批时：同意词先 resolve allow，不进任务队列', async () => {
  const { hub, sent, calls } = makeHub()
  const { done } = hub.approvals.startRequest('owner-1', 'Bash', '{"command":"ls"}')
  await hub.handleInbound(msg({ text: '同意' }))
  expect(await done).toBe('allow')
  expect(calls).toHaveLength(0)
  await drain(hub)
  expect(sent.map((s) => s.text).join('\n')).toContain('已允许')
})

test('有挂起审批时：拒绝词 resolve deny', async () => {
  const { hub, calls } = makeHub()
  const { done } = hub.approvals.startRequest('owner-1', 'Bash', '{"command":"rm -rf /"}')
  await hub.handleInbound(msg({ text: '拒绝' }))
  expect(await done).toBe('deny')
  expect(calls).toHaveLength(0)
})

test('有挂起审批时：其余文本照常入队，回复附有待审批提醒', async () => {
  const kit = makeHub()
  kit.hub.approvals.startRequest('owner-1', 'Bash', '{}')
  await kit.hub.handleInbound(msg({ text: '帮我看看日志' }))
  await settle(kit)
  expect(kit.sent.map((s) => s.text).join('\n')).toContain('待审批')
})

test('「网页」回复不消费审批，提示 Web 面板未接入', async () => {
  const { hub, sent, calls } = makeHub()
  const { done } = hub.approvals.startRequest('owner-1', 'Bash', '{}')
  await hub.handleInbound(msg({ text: '网页' }))
  await drain(hub)
  expect(sent.map((s) => s.text).join('\n')).toContain('Task 19')
  expect(calls).toHaveLength(0)
  // 审批仍然挂起：同意仍可决议
  await hub.handleInbound(msg({ text: '同意' }))
  expect(await done).toBe('allow')
})

test('入站媒体落盘 workspace 并在 prompt 末尾追加 [附件] 行；mediaErrors 附提示', async () => {
  const kit = makeHub()
  await kit.hub.handleInbound(msg({
    text: '看这张图',
    media: [{ kind: 'image', name: 'photo.jpg', mediaType: 'image/jpeg', data: new Uint8Array([1, 2, 3]) }],
    mediaErrors: ['a.png: 下载失败'],
  }))
  await settle(kit)
  expect(kit.calls).toHaveLength(1)
  const prompt = kit.calls[0]!.options.prompt
  const match = /\[附件\] (.+) \(image\)/.exec(prompt)
  expect(match).not.toBeNull()
  const savedPath = match![1]!
  expect(savedPath.startsWith(workspace)).toBe(true)
  const bytes = await readFile(savedPath)
  expect([...bytes]).toEqual([1, 2, 3])
  expect(prompt).toContain('接收失败') // prompt 前置警告行
  expect(kit.sent.map((s) => s.text).join('\n')).toContain('接收失败') // 回复中备注
})

test('一条「同意」只决议最老的一条挂起审批', async () => {
  const { hub, calls } = makeHub()
  const first = hub.approvals.startRequest('owner-1', 'Bash', '{"n":1}')
  const second = hub.approvals.startRequest('owner-1', 'Bash', '{"n":2}')
  await hub.handleInbound(msg({ text: '同意' }))
  expect(await first.done).toBe('allow')
  expect(hub.approvals.resultOf(second.id)).toBe('pending') // 较新的不受影响
  expect(calls).toHaveLength(0)
  // 第二条独立决议
  await hub.handleInbound(msg({ text: '拒绝' }))
  expect(await second.done).toBe('deny')
})

test('两个聊天提交相同提示文本：chatId 各自透传到 run（审批桥 env 各自正确）', async () => {
  const kit = makeHub(undefined, async () => ({ text: 'done', exitCode: 0 }))
  await kit.hub.handleInbound(msg({ id: 'c-a', chatId: 'room-a', text: '同一段提示' }))
  await kit.hub.handleInbound(msg({ id: 'c-b', chatId: 'room-b', text: '同一段提示' }))
  await vi.waitFor(() => expect(kit.calls).toHaveLength(2))
  const promptByChat = new Map(kit.calls.map((c) => [c.options.chatId, c.options.prompt]))
  expect(promptByChat.get('room-a')).toBe('同一段提示')
  expect(promptByChat.get('room-b')).toBe('同一段提示')
  await drain(kit.hub)
})

test('轮询循环（tick）异常不退出循环', async () => {
  const kit = makeHub()
  kit.client.poll.mockImplementationOnce(async () => {
    throw new Error('网络抖动')
  })
  await expect(kit.hub.tick()).resolves.toBeUndefined()
  // 下一次 tick 正常取到消息并处理
  kit.polls.push([msg({ id: 'tick-1', text: 'tick 任务' })])
  await kit.hub.tick()
  await settle(kit)
  expect(kit.calls).toHaveLength(1)
})

test('agent 回复中的 send-file 指令与本地路径经 outbox files 回发', async () => {
  await writeFile(join(workspace, 'test.txt'), 'hello file')
  await writeFile(join(workspace, 'notes.md'), '# notes')
  const kit = makeHub(undefined, async () => ({
    text: `好的\n[[send-file:test.txt]]\n详见 ${join(workspace, 'notes.md')}`,
    exitCode: 0,
  }))
  await kit.hub.handleInbound(msg({ text: '发我文件' }))
  await settle(kit)
  // 文件外发要经工作区 realpath 校验（真实 fs 往返），直接等最终结果
  await vi.waitFor(() => expect(kit.mediaSent.map((m) => m.name).sort()).toEqual(['notes.md', 'test.txt']))
})

test('claude permission-prompt-tool + auto 模式：运行时写临时 --mcp-config 并注入 env，运行后清理', async () => {
  const claudeWithApproval: AgentConfig = { ...agentClaude, approval: 'permission-prompt-tool' }
  // 任务运行期间读取临时 mcp-config（运行结束即被清理，须在 run 内捕获）
  let serverConfig: { command: string; args: string[]; env: Record<string, string> } | undefined
  let serverConfigPath: string | undefined
  const kit = makeHub({ agents: [claudeWithApproval] }, async (_prompt, options) => {
    expect(options.approvalTool).toBeDefined()
    expect(options.approvalTool!.toolName).toBe('weishub_request_permission')
    serverConfigPath = options.approvalTool!.serverConfigPath
    const config = JSON.parse(await readFile(serverConfigPath, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
    }
    serverConfig = config.mcpServers['weishub-approval']
    return { text: 'done', exitCode: 0 }
  })
  await kit.hub.start()
  expect(kit.hub.notifyPort).toBeGreaterThan(0)
  await kit.hub.handleInbound(msg({ text: '跑个需要审批的任务' }))
  await settle(kit)
  expect(serverConfig).toBeDefined()
  expect(serverConfig!.command).toBe('node')
  expect(serverConfig!.args[0]).toMatch(/approval-mcp\.js$/)
  expect(serverConfig!.env.WEISHUB_PORT).toBe(String(kit.hub.notifyPort))
  expect(serverConfig!.env.WEISHUB_TOKEN).toBeTruthy()
  expect(serverConfig!.env.WEISHUB_CHAT_ID).toBe('owner-1')
  // 运行结束后临时配置文件被清理
  await expect(access(serverConfigPath!)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('full 模式不注入 approvalTool', async () => {
  const claudeWithApproval: AgentConfig = { ...agentClaude, approval: 'permission-prompt-tool' }
  const kit = makeHub({ agents: [claudeWithApproval] }, async () => ({ text: 'done', exitCode: 0 }))
  await kit.hub.start()
  kit.hub.dispatcher.setMode('owner-1', 'full')
  await kit.hub.handleInbound(msg({ text: '全速跑' }))
  await settle(kit)
  expect(kit.calls[0]!.options.approvalTool).toBeUndefined()
})

test('start：绑定与发件箱状态持久化并可恢复', async () => {
  const first = makeHub()
  await first.hub.handleInbound(msg({ id: 'p-1', text: '建立绑定' }))
  await settle(first)
  await first.hub.stop()

  // 新 Hub（新 fake client）从状态文件恢复绑定
  const { client, sent } = fakeClient()
  const { run, calls: runCalls } = fakeRun()
  const hub2 = new Hub({
    client,
    accountId: 'bot-1',
    ownerUserId: 'owner-1',
    agents: [agentClaude, agentCodex],
    workspace,
    run,
  })
  hubs.push(hub2)
  await hub2.start()
  expect(hub2.dispatcher.binding('owner-1')?.agentName).toBe('claude')
  await hub2.handleInbound(msg({ id: 'p-2', text: '继续任务' }))
  await vi.waitFor(() => expect(runCalls).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await drain(hub2)
  // 已有绑定：不再发欢迎语（只有任务回复）
  expect(sent.map((s) => s.text).join('\n')).not.toContain('已绑定')
})

test('start：单实例锁拒绝第二个实例', async () => {
  const first = makeHub()
  await first.hub.start()
  const second = makeHub()
  await expect(second.hub.start()).rejects.toThrow('另一个 weishub 实例正在运行')
})

test('start：旧凭据目录注入时迁移到新凭据路径', async () => {
  const legacyDir = await mkdtemp(join(tmpdir(), 'weishub-legacy-'))
  tempDirs.push(legacyDir)
  await writeFile(join(legacyDir, 'account.json'), JSON.stringify({
    accountId: 'legacy-bot',
    token: 'legacy-token',
    apiBase: 'https://ilinkai.weixin.qq.com',
    savedAt: new Date().toISOString(),
  }), { mode: 0o600 }) // readPrivateJson 要求权限收紧
  const kit = makeHub({ legacyCredentialDir: legacyDir })
  await kit.hub.start()
  const credential = await readCredential(defaultCredentialPath())
  expect(credential.token).toBe('legacy-token')
})

test('start：旧凭据存在但迁移失败时输出 stderr 警告且不落凭据', async () => {
  const legacyDir = await mkdtemp(join(tmpdir(), 'weishub-legacy-bad-'))
  tempDirs.push(legacyDir)
  await writeFile(join(legacyDir, 'account.json'), '{"broken": true}')
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const kit = makeHub({ legacyCredentialDir: legacyDir })
  try {
    await kit.hub.start()
    expect(errSpy.mock.calls.some((args) => String(args[0]).includes('检测到旧凭据但迁移失败'))).toBe(true)
    await expect(readCredential(defaultCredentialPath())).rejects.toThrow()
  } finally {
    errSpy.mockRestore()
  }
})

test('start：无凭据进入等待扫码状态——notify api 在、不轮询', async () => {
  const kit = makeHub()
  await kit.hub.start()
  expect(kit.hub.notifyPort).toBeGreaterThan(0)
  expect(kit.client.poll).not.toHaveBeenCalled()
})

test('/sessions 后回复裸数字：绑定会话而非当作提示词或命令', async () => {
  const store = await mkdtemp(join(tmpdir(), 'weishub-sessions-'))
  tempDirs.push(store)
  const sessionId = 'fake-session-0001'
  // claude 存储布局：<store>/<项目目录>/<sessionId>.jsonl
  const projectDir = join(store, 'proj')
  await mkdir(projectDir, { recursive: true })
  await writeFile(
    join(projectDir, `${sessionId}.jsonl`),
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"历史会话标题"}]}}\n',
  )
  const agentWithStore: AgentConfig = { ...agentClaude, listSessions: { store, kind: 'claude' } }
  const kit = makeHub({ agents: [agentWithStore] })
  // 先建立绑定（否则 /sessions 无可列 agent）
  await kit.hub.handleInbound(msg({ id: 'b-1', text: '先建立绑定' }))
  await settle(kit)
  await kit.hub.handleInbound(msg({ id: 'b-2', text: '/sessions' }))
  await drain(kit.hub)
  expect(kit.sent.map((s) => s.text).join('\n')).toContain('历史会话标题')
  expect(kit.calls).toHaveLength(1) // /sessions 不进任务队列
  // 裸数字回复：一次性绑定该会话，绝不变成新提示词
  await kit.hub.handleInbound(msg({ id: 'b-3', text: '1' }))
  await drain(kit.hub)
  expect(kit.hub.dispatcher.binding('owner-1')?.sessionId).toBe(sessionId)
  expect(kit.calls).toHaveLength(1)
})
