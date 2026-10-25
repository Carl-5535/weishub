import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { InboundMessage, ILinkState } from '@weishub/channel-wechat'
import { defaultCredentialPath, readCredential } from '@weishub/channel-wechat'
import type { AgentConfig, RunOptions, TaskResult } from '@weishub/core'
import { Hub, loadPersistedProtocol, type HubDeps } from '../src/inbound.js'

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

test('首条陌生私聊认主并处理；认领后其他发送者被忽略（owner 兜底）', async () => {
  const { hub, sent, calls } = makeHub()
  // 凭据 userId（owner-1）与真实会话 id 不同代际：第一条私聊消息认主
  await hub.handleInbound(msg({ userId: 'stranger', chatId: 'stranger', text: 'hello' }))
  await drain(hub)
  expect(hub.ownerUserId).toBe('stranger')
  expect(calls).toHaveLength(1) // 认主后照常进入任务管线
  expect(sent.length).toBeGreaterThan(0)
  // 认领既定：另一个发送者照旧忽略
  await hub.handleInbound(msg({ userId: 'other', chatId: 'other', text: 'hi' }))
  await drain(hub)
  expect(calls).toHaveLength(1)
})

test('群聊消息不认主，始终忽略', async () => {
  const { hub, calls } = makeHub()
  await hub.handleInbound(msg({ userId: 'stranger', chatId: 'room-1', text: 'hi', group: true }))
  await drain(hub)
  expect(hub.ownerUserId).toBe('owner-1') // 未被认领
  expect(calls).toHaveLength(0)
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

test('「网页」回复不消费审批，提示可去 Web 面板处理', async () => {
  const { hub, sent, calls } = makeHub()
  const { done } = hub.approvals.startRequest('owner-1', 'Bash', '{}')
  await hub.handleInbound(msg({ text: '网页' }))
  await drain(hub)
  expect(sent.map((s) => s.text).join('\n')).toContain('Web 面板')
  expect(calls).toHaveLength(0)
  // 审批仍然挂起：同意仍可决议
  await hub.handleInbound(msg({ text: '同意' }))
  expect(await done).toBe('allow')
})

test('正文里包含「网页」的正常任务不被吞：照常下发给 agent', async () => {
  const kit = makeHub()
  const { hub, sent, calls } = kit
  const { done } = hub.approvals.startRequest('owner-1', 'Bash', '{}')
  await hub.handleInbound(msg({ text: '帮我抓取这个网页的内容并总结' }))
  await settle(kit)
  // 任务下发（带待审批提醒），而不是回复面板提示
  expect(calls.map((c) => c.options.prompt)).toEqual(['帮我抓取这个网页的内容并总结'])
  expect(sent.map((s) => s.text).join('\n')).toContain('待审批')
  await hub.handleInbound(msg({ text: '同意' }))
  expect(await done).toBe('allow')
})

test('无挂起审批、无撤销记录时，同意/拒绝词照常作为提示词下发给 agent', async () => {
  // agent 自己的追问（「要继续吗？yes」）必须能收到回答——这是常见交互，不能被审批逻辑吞掉
  const { hub, sent, calls } = makeHub()
  await hub.handleInbound(msg({ text: 'yes' }))
  await drain(hub)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.options.prompt).toBe('yes')
  expect(sent.map((s) => s.text).join('\n')).not.toContain('当前没有待处理的审批')
})

test('带附件的同意词即使刚撤销过审批也照常下发（附件不能被丢弃）', async () => {
  const kit = makeHub(undefined, (_prompt, options) => {
    return new Promise<TaskResult>((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('中止')), { once: true })
    })
  })
  await kit.hub.handleInbound(msg({ text: '跑长任务' }))
  await vi.waitFor(() => expect(kit.calls).toHaveLength(1))
  kit.hub.approvals.startRequest('owner-1', 'Bash', '{}')
  await kit.hub.handleInbound(msg({ text: '/stop' }))
  await vi.waitFor(() => expect(kit.hub.approvals.pending()).toHaveLength(0))
  await drain(kit.hub)
  // 撤销后的下一条允许词带附件：必须作为新任务下发，附件注入
  await kit.hub.handleInbound(msg({
    text: 'yes',
    media: [{ kind: 'image', name: 'a.jpg', mediaType: 'image/jpeg', data: new Uint8Array([1, 2, 3]) }],
  }))
  await drain(kit.hub)
  expect(kit.calls.length).toBeGreaterThanOrEqual(2)
  expect(kit.calls.at(-1)!.options.prompt).toContain('[附件]')
})

test('任务终态撤销该 chat 的挂起审批：/stop 后 pending 清空，后续「同意」不再决议任何请求', async () => {
  const kit = makeHub(undefined, (_prompt, options) => {
    // 模拟真 runAgentTask：abort 即 reject
    return new Promise<TaskResult>((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('中止')), { once: true })
    })
  })
  // 先提交一个会挂起的任务（占用 dispatcher），再挂一条审批
  await kit.hub.handleInbound(msg({ text: '跑长任务' }))
  await vi.waitFor(() => expect(kit.calls).toHaveLength(1))
  const { done } = kit.hub.approvals.startRequest('owner-1', 'Bash', '{"command":"ls"}')
  expect(kit.hub.approvals.pending()).toHaveLength(1)
  // /stop 中止任务 → 任务终态 → 挂起审批被撤销（deny）
  await kit.hub.handleInbound(msg({ text: '/stop' }))
  expect(await done).toBe('deny')
  await vi.waitFor(() => expect(kit.hub.approvals.pending()).toHaveLength(0))
  await drain(kit.hub)
  // 撤销后的「同意」不决议任何请求：明确回复没有待处理审批，也不进任务队列
  await kit.hub.handleInbound(msg({ text: '同意' }))
  await drain(kit.hub)
  expect(kit.calls).toHaveLength(1) // 没有新任务
  expect(kit.sent.map((s) => s.text).join('\n')).toContain('当前没有待处理的审批')
})

test('任务成功终态同样清理该 chat 的待审批提醒', async () => {
  const kit = makeHub()
  kit.hub.approvals.startRequest('owner-1', 'Bash', '{}') // 挂起审批触发提醒登记
  await kit.hub.handleInbound(msg({ text: '继续干活' }))
  await settle(kit)
  // 提醒出现在这条回复里（消息收到时审批还挂着）
  expect(kit.sent.map((s) => s.text).join('\n')).toContain('待审批')
  // 任务终态：挂起审批被撤销，下一条回复不再带提醒
  await kit.hub.handleInbound(msg({ text: '再干一件' }))
  await settle(kit, 2)
  // onTaskEnd 在 reply promise 链的 .finally 里触发，比回复入队更晚一拍
  await vi.waitFor(() => expect(kit.hub.approvals.pending()).toHaveLength(0))
  expect(kit.sent.at(-1)).not.toContain('待审批')
})

test('hub.stop() 中止所有 chat 的在跑任务（关机不留孤儿进程）', async () => {
  const aborted: string[] = []
  const kit = makeHub(undefined, (_prompt, options) => {
    return new Promise<TaskResult>((_, reject) => {
      options.signal?.addEventListener('abort', () => {
        aborted.push(options.chatId ?? '')
        reject(new Error('中止'))
      }, { once: true })
    })
  })
  await kit.hub.handleInbound(msg({ id: 's-a', chatId: 'chat-a', userId: 'owner-1', text: '任务A' }))
  await kit.hub.handleInbound(msg({ id: 's-b', chatId: 'chat-b', userId: 'owner-1', text: '任务B' }))
  await vi.waitFor(() => expect(kit.calls).toHaveLength(2))
  await kit.hub.stop()
  expect(aborted.sort()).toEqual(['chat-a', 'chat-b'])
})

// ---- F-I1：轮询游标 / context token 持久化 ----

test('协议状态持久化：client 状态变化落盘，重建后新 client 拿到持久化 ILinkState', async () => {
  let stateSink: ((state: ILinkState) => Promise<void> | void) | undefined
  // 模拟真实 ILinkClient：构造时收 state，poll 推进游标并经 onStateChange 回报
  function statefulClient(initial?: ILinkState) {
    let updatesBuffer = initial?.updatesBuffer ?? ''
    const contextTokens = new Map(Object.entries(initial?.contextTokens ?? {}))
    return {
      initial,
      poll: vi.fn(async (): Promise<InboundMessage[]> => {
        updatesBuffer = 'buf-advanced'
        contextTokens.set('chat-a', 'ctx-token-1')
        await stateSink?.({ updatesBuffer, contextTokens: Object.fromEntries(contextTokens) })
        return []
      }),
      sendText: vi.fn(async () => {}),
      sendMedia: vi.fn(async () => {}),
      sendTyping: vi.fn(async () => {}),
    }
  }
  const client1 = statefulClient()
  const hub1 = new Hub({
    client: client1 as unknown as HubDeps['client'],
    accountId: 'bot-1',
    ownerUserId: 'owner-1',
    agents: [agentClaude],
    workspace,
  })
  hubs.push(hub1)
  // 与 serve.ts 相同的装配：client onStateChange → hub.recordProtocolState
  stateSink = (state) => hub1.recordProtocolState(state)
  await hub1.start()
  await hub1.tick() // poll 推进游标 → onStateChange → 落盘
  await hub1.stop()
  // 状态文件里有协议状态；loadPersistedProtocol（serve 构造 client 前的同一接缝）读出
  const persisted = await loadPersistedProtocol()
  expect(persisted).toEqual({ updatesBuffer: 'buf-advanced', contextTokens: { 'chat-a': 'ctx-token-1' } })
  // 重建：新 client（与 serve 一样以持久化状态构造）收到断点
  const client2 = statefulClient(persisted)
  expect(client2.initial).toEqual(persisted)
  const hub2 = new Hub({
    client: client2 as unknown as HubDeps['client'],
    accountId: 'bot-1',
    ownerUserId: 'owner-1',
    agents: [agentClaude],
    workspace,
  })
  hubs.push(hub2)
  stateSink = (state) => hub2.recordProtocolState(state)
  await hub2.start()
  await hub2.tick()
  // 游标在新 client 的基础上继续推进，而不是从头开始
  const after = await loadPersistedProtocol()
  expect(after).toEqual({ updatesBuffer: 'buf-advanced', contextTokens: { 'chat-a': 'ctx-token-1' } })
  await hub2.stop()
})

// ---- F-I4：消息环（Web 面板消息流） ----

test('消息环：入站与回复均按序记录（in/out 方向区分）', async () => {
  const kit = makeHub(undefined, async () => ({ text: '回答内容', exitCode: 0 }))
  await kit.hub.handleInbound(msg({ text: '帮我查一下' }))
  await settle(kit)
  const messages = kit.hub.chatMessages('owner-1')
  // 首条消息自动绑定会产生一条欢迎语（out），随后是入站与任务回复
  expect(messages).toEqual([
    { direction: 'in', text: '帮我查一下', at: expect.any(Number) },
    { direction: 'out', text: expect.stringContaining('已绑定'), at: expect.any(Number) },
    { direction: 'out', text: '回答内容', at: expect.any(Number) },
  ])
})

test('消息环封顶 50 条：超出后丢弃最旧', async () => {
  const kit = makeHub()
  for (let i = 0; i < 60; i++) {
    await kit.hub.handleInbound(msg({ text: `/help ${i}` })) // 命令消息也入环且回复即时
  }
  await drain(kit.hub)
  const messages = kit.hub.chatMessages('owner-1')
  expect(messages).toHaveLength(50)
  // 最旧的已淘汰：末尾是第 60 次（/help 59）的收与复
  expect(messages.at(-2)).toMatchObject({ direction: 'in', text: '/help 59' })
  expect(messages.at(-1)).toMatchObject({ direction: 'out' })
  expect(messages[0]!.text).not.toContain('/help 0')
})

test('chatMessages 对未知 chat 返回空数组', () => {
  const { hub } = makeHub()
  expect(hub.chatMessages('no-such-chat')).toEqual([])
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

test('@codex 车道的回复文件按 codex 自己的工作区解析，不受默认 agent 影响', async () => {
  // codex 专属工作区：文件只存在于这里，全局工作区没有
  const codexWs = join(workspace, 'codex-ws')
  await mkdir(codexWs, { recursive: true })
  await writeFile(join(codexWs, 'codex-only.txt'), 'from codex')
  const kit = makeHub({ allAgents: [agentClaude, agentCodex] }, async () => ({
    text: '[[send-file:codex-only.txt]]',
    exitCode: 0,
  }))
  await kit.hub.setWorkspace(undefined, { codex: codexWs })
  // 首条消息经 @codex 路由：任务跑在 codex 车道，默认绑定是 claude
  await kit.hub.handleInbound(msg({ text: '@codex 发文件' }))
  await settle(kit)
  // 回复里的文件指令必须按 codex 的工作区解析（cwd 随回复的 agent 走）
  await vi.waitFor(() => expect(kit.mediaSent.map((m) => m.name)).toEqual(['codex-only.txt']))
})

test('claude permission-prompt-tool + auto 模式：运行时写临时 --mcp-config 并注入 env，运行后清理', async () => {
  const claudeWithApproval: AgentConfig = { ...agentClaude, approval: 'permission-prompt-tool' }
  // 任务运行期间读取临时 mcp-config（运行结束即被清理，须在 run 内捕获）
  let serverConfig: { command: string; args: string[]; env: Record<string, string> } | undefined
  let serverConfigPath: string | undefined
  const kit = makeHub({ agents: [claudeWithApproval] }, async (_prompt, options) => {
    expect(options.approvalTool).toBeDefined()
    expect(options.approvalTool!.toolName).toBe('mcp__weishub-approval__weishub_request_permission')
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
  // 车道作用域：审批归属「会话::agent」，多 agent 并行时互不串扰
  expect(serverConfig!.env.WEISHUB_CHAT_ID).toBe('owner-1::claude')
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

test('发件箱重试耗尽后，兜底定时器会再次尝试投递', async () => {
  vi.useFakeTimers()
  try {
    const kit = makeHub()
    await kit.hub.start() // 兜底重试定时器在 start 里装
    let failing = true
    let attempts = 0
    kit.client.sendText = (async () => {
      attempts += 1
      if (failing) throw new Error('通道不可用')
    }) as HubDeps['client']['sendText']

    await kit.hub.handleInbound(msg({ text: '会先失败的消息' }))
    await vi.advanceTimersByTimeAsync(30_000) // 走完单次投递的重试
    const failedAttempts = attempts
    expect(failedAttempts).toBeGreaterThan(0)
    expect(kit.hub.outbox.pending()['owner-1']).toBeDefined() // 失败不丢，留在发件箱

    failing = false
    await vi.advanceTimersByTimeAsync(61_000) // 兜底定时器再推一次
    await vi.advanceTimersByTimeAsync(1000)
    expect(kit.hub.outbox.pending()['owner-1']).toBeUndefined()
    expect(attempts).toBeGreaterThan(failedAttempts)
  } finally {
    vi.useRealTimers()
  }
})

async function writeCredential(savedAt = new Date()): Promise<void> {
  await writeFile(defaultCredentialPath(), JSON.stringify({
    accountId: 'bot-1',
    token: 'tok-cred',
    apiBase: 'https://ilinkai.weixin.qq.com',
    userId: 'owner-1',
    savedAt: savedAt.toISOString(),
  }), { mode: 0o600 })
}

test('凭据健康：刚写入的凭据为 ok', async () => {
  await writeCredential()
  const kit = makeHub()
  await kit.hub.start()
  expect(kit.hub.credentialHealth.state).toBe('ok')
})

test('凭据健康：凭据已放 25 小时且无活动记录时为 expired', async () => {
  await writeCredential(new Date(Date.now() - 25 * 3_600_000))
  const kit = makeHub()
  await kit.hub.start()
  expect(kit.hub.credentialHealth.state).toBe('expired')
})

test('凭据健康：收信即续期——过期凭据收到消息后回到 ok', async () => {
  await writeCredential(new Date(Date.now() - 25 * 3_600_000))
  const kit = makeHub()
  await kit.hub.start()
  expect(kit.hub.credentialHealth.state).toBe('expired')
  await kit.hub.handleInbound(msg({ text: '你好' }))
  expect(kit.hub.credentialHealth.state).toBe('ok')
})

test('凭据健康：轮询遇鉴权错时标记 rejected，重新扫码后清除', async () => {
  await writeCredential()
  const kit = makeHub()
  await kit.hub.start()
  kit.client.poll = (async () => { throw new Error('getupdates 失败 (ret=0, errcode=-14): session timeout') }) as HubDeps['client']['poll']
  // tick 会吞掉异常，但循环体里的标记逻辑要先于这一步——直接跑一次主循环的 poll 路径
  await kit.hub.tick()
  expect(kit.hub.credentialHealth.state).toBe('rejected')
  await kit.hub.reloadCredential()
  expect(kit.hub.credentialHealth.state).not.toBe('missing')
})

test('凭据检查不消费消息、不推进游标（探活绝不能抢主循环的 getupdates）', async () => {
  await writeCredential()
  const kit = makeHub()
  await kit.hub.start()
  // 队列里放一条待收消息
  kit.polls.push([msg({ id: 'pending-1', text: '这条必须被主循环收到' })])
  const pollSpy = kit.client.poll as unknown as { mock: { calls: unknown[] } }
  const before = pollSpy.mock.calls.length
  // 反复检查健康状态：不得触发任何 poll
  for (let i = 0; i < 5; i += 1) await kit.hub.checkCredential()
  expect(pollSpy.mock.calls.length).toBe(before)
  // 消息仍在，主循环一跑就能拿到
  await kit.hub.tick()
  expect(kit.calls.some((c) => c.options.prompt.includes('这条必须被主循环收到'))).toBe(true)
})

test('重新扫码后换用新凭据构造的 client（旧 client 的 token 已固化）', async () => {
  await writeCredential()
  const seen: string[] = []
  let kitRef: HubKit | undefined
  const kit = makeHub({
    createClient: () => {
      seen.push('rebuilt')
      return kitRef!.client
    },
  })
  kitRef = kit
  await kit.hub.start()
  expect(seen).toHaveLength(0) // 启动时用 deps.client，不重建
  await kit.hub.reloadCredential()
  expect(seen).toEqual(['rebuilt']) // 重新扫码后必须换 client
})

test('凭据健康：网络抖动不改变本地推算结论', async () => {
  await writeCredential()
  const kit = makeHub()
  await kit.hub.start()
  kit.client.poll = (async () => { throw new Error('ECONNREFUSED') }) as HubDeps['client']['poll']
  const health = await kit.hub.checkCredential()
  expect(health.state).toBe('ok')
})

test('凭据健康：状态随 state.json 持久化', async () => {
  await writeCredential(new Date(Date.now() - 10 * 3_600_000))
  const kit = makeHub()
  await kit.hub.start()
  // 用一次真实收信刷新活动时间（checkCredential 的探测会挂起到超时，测试里不走那条路）
  await kit.hub.handleInbound(msg({ text: '在吗' }))
  const saved = JSON.parse(await readFile(join(homeDir, 'state.json'), 'utf8')) as { lastActivityAt?: string }
  expect(typeof saved.lastActivityAt).toBe('string')
  expect(Date.now() - Date.parse(saved.lastActivityAt!)).toBeLessThan(60_000)
})

const agentGemini: AgentConfig = { ...agentClaude, name: 'gemini', detect: 'gemini' }

describe('@提及路由：多 agent 并行', () => {
  const sentText = (kit: HubKit) => kit.sent.map((s) => s.text).join('\n')

  test('@claude 前缀把消息路由给 claude 车道；无 @ 走默认', async () => {
    const kit = makeHub({ allAgents: [agentClaude, agentCodex] })
    await kit.hub.handleInbound(msg({ text: '写首诗' })) // 默认（claude）车道
    await kit.hub.handleInbound(msg({ text: '@codex 跑下测试' })) // 提及 codex 车道
    await settle(kit, 2)
    expect(kit.calls).toHaveLength(2)
    expect(kit.calls[0]!.config.name).toBe('claude')
    expect(kit.calls[1]!.config.name).toBe('codex')
    expect(kit.calls[1]!.options.prompt).toBe('跑下测试')
  })

  test('@未安装 agent 给出明确提示，不进队列', async () => {
    const kit = makeHub({ allAgents: [agentClaude, agentCodex, agentGemini] })
    await kit.hub.handleInbound(msg({ text: '@gemini 你好' }))
    await drain(kit.hub)
    expect(sentText(kit)).toContain('已配置但未安装')
    expect(kit.calls).toHaveLength(0)
  })

  test('@未知 agent 给出提示', async () => {
    const kit = makeHub({ allAgents: [agentClaude, agentCodex] })
    await kit.hub.handleInbound(msg({ text: '@不存在的 你好' }))
    await drain(kit.hub)
    expect(sentText(kit)).toContain('没有叫')
  })

  test('@后没有任务内容时提示用法', async () => {
    const kit = makeHub({ allAgents: [agentClaude, agentCodex] })
    await kit.hub.handleInbound(msg({ text: '@codex ' }))
    await drain(kit.hub)
    expect(sentText(kit)).toContain('后面要跟任务内容')
  })

  test('两条车道并行：互不排队，回复带 agent 前缀', async () => {
    const kit = makeHub({ allAgents: [agentClaude, agentCodex] }, async (_prompt, options) => {
      if (options.prompt.includes('慢')) await new Promise((r) => setTimeout(r, 400))
      return { text: `${options.prompt} 完成`, exitCode: 0 }
    })
    await kit.hub.handleInbound(msg({ text: '@codex 慢任务' })) // codex 车道，慢
    await kit.hub.handleInbound(msg({ text: '快任务' })) // 默认（claude）车道，快
    await settle(kit, 2)
    // 快车道先完成：如果被慢车道阻塞，此时 calls 只有 1
    expect(kit.calls).toHaveLength(2)
    // 多车道会话回复带 agent 前缀（慢车道 400ms 后完成）
    await vi.waitFor(() => {
      expect(sentText(kit)).toContain('「codex」')
      expect(sentText(kit)).toContain('「claude」')
    })
  })
})
