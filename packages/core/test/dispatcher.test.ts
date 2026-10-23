import { expect, test, vi } from 'vitest'
import { ChatDispatcher, type ChatBinding } from '../src/dispatcher.js'
import { runAgentTask, type RunOptions, type TaskResult } from '../src/adapter.js'
import type { AgentConfig, PermissionMode } from '../src/types.js'

const agentA: AgentConfig = {
  name: 'claude',
  detect: 'claude',
  run: ['claude', '-p'],
  passVia: 'stdin',
  outputFormat: 'claude-json',
  resume: ['--resume', '{{sessionId}}'],
  approval: null,
  permissionFlags: { auto: [], full: ['--dangerously'] },
  workspace: null,
  timeoutSec: 10,
}

const agentB: AgentConfig = {
  ...agentA,
  name: 'codex',
  workspace: '/tmp/ws-codex',
}

interface RecordedCall {
  config: AgentConfig
  options: RunOptions
}

interface Deferred {
  promise: Promise<TaskResult>
  resolve: (value: TaskResult) => void
  reject: (err: Error) => void
}

function deferred(): Deferred {
  let resolve!: (value: TaskResult) => void
  let reject!: (err: Error) => void
  const promise = new Promise<TaskResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 可注入行为的假 run：记录每次调用，支持外部控制 resolve/reject。 */
function makeFakeRun(impl: (call: RecordedCall) => Promise<TaskResult>) {
  const calls: RecordedCall[] = []
  const deferreds: Deferred[] = []
  const run = vi.fn((config: AgentConfig, options: RunOptions): Promise<TaskResult> => {
    const call = { config, options }
    calls.push(call)
    const d = deferred()
    deferreds.push(d)
    void impl(call).then(
      (value) => d.resolve(value),
      (err: Error) => d.reject(err),
    )
    return d.promise
  })
  return { run, calls, deferreds }
}

function instantRun(sessionIdFor?: (options: RunOptions) => string | undefined) {
  return makeFakeRun(
    (call) =>
      Promise.resolve({
        text: `done:${call.options.prompt}`,
        sessionId: sessionIdFor?.(call.options),
        exitCode: 0,
      }),
  )
}

function makeDeps(
  run: typeof runAgentTask,
  overrides: Partial<{
    cwdFor: (agentName: string) => string
    onReply: (chatId: string, text: string, agentName?: string) => Promise<void>
    onTaskEnd: (chatId: string) => void
    maxQueue: number
  }> = {},
) {
  const replies: Array<{ chatId: string; text: string }> = []
  const replyAgents: Array<string | undefined> = []
  return {
    deps: {
      agents: [agentA, agentB],
      run,
      cwdFor: overrides.cwdFor ?? ((agentName: string) => `/cwd/${agentName}`),
      onReply:
        overrides.onReply ??
        ((chatId: string, text: string, agentName?: string) => {
          replies.push({ chatId, text })
          replyAgents.push(agentName)
          return Promise.resolve()
        }),
      onTaskEnd: overrides.onTaskEnd,
      maxQueue: overrides.maxQueue,
    },
    replies,
    replyAgents,
  }
}

async function drain(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

test('未绑定 chat 的 submit 返回 rejected-unbound 且从不调用 run', () => {
  const fake = instantRun()
  const { deps } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  expect(d.submit('c1', '你好')).toBe('rejected-unbound')
  expect(fake.calls).toHaveLength(0)
  expect(d.busy('c1')).toBe(false)
})

test('bind 未知 agent 返回 undefined，不产生绑定', () => {
  const fake = instantRun()
  const { deps } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  expect(d.bind('c1', 'nope')).toBeUndefined()
  expect(d.binding('c1')).toBeUndefined()
})

test('bind 已知 agent 返回其配置并设为默认', () => {
  const fake = instantRun()
  const { deps } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  expect(d.bind('c1', 'claude')).toBe(agentA)
  expect(d.binding('c1')).toEqual<ChatBinding>({ chatId: 'c1', agentName: 'claude' })
})

test('首条消息：run 收到无 sessionId 的 RunOptions，结果 sessionId 写回 binding', async () => {
  const fake = instantRun(() => 'sess-1')
  const { deps } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  expect(d.submit('c1', '第一问')).toBe('accepted')
  await drain()
  expect(fake.calls).toHaveLength(1)
  expect(fake.calls[0]!.options.prompt).toBe('第一问')
  expect(fake.calls[0]!.options.sessionId).toBeUndefined()
  expect(fake.calls[0]!.options.mode).toBe('auto')
  expect(fake.calls[0]!.options.cwd).toBe('/cwd/claude')
  expect(d.binding('c1')).toEqual<ChatBinding>({ chatId: 'c1', agentName: 'claude', sessionId: 'sess-1' })
})

test('第二条消息携带 sessionId resume，且 run 透传 dispatcher 写入的 sessionId', async () => {
  // 真实 runAgentTask 负责 {{sessionId}} 替换；dispatcher 的职责是把 binding.sessionId 放进 RunOptions
  let call = 0
  const fake = instantRun(() => (call++ === 0 ? 'sess-1' : undefined))
  const { deps } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.submit('c1', '第一问')
  await drain()
  d.submit('c1', '第二问')
  await drain()
  expect(fake.calls).toHaveLength(2)
  expect(fake.calls[1]!.options.sessionId).toBe('sess-1')
  expect(fake.calls[1]!.options.prompt).toBe('第二问')
})

test('dispatcher 注入的 resume 模板含 {{sessionId}}，替换由 runAgentTask 负责', async () => {
  // 钉契约：dispatcher 只传 sessionId 值，不动 argv 模板
  const seen: string[][] = []
  const run = vi.fn(async (config: AgentConfig, options: RunOptions): Promise<TaskResult> => {
    seen.push(config.resume)
    void options
    return { text: 'ok', sessionId: 's9', exitCode: 0 }
  })
  const { deps } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.submit('c1', '问')
  await drain()
  expect(seen[0]).toEqual(['--resume', '{{sessionId}}'])
})

test('任务运行中第二条 submit 返回 queued，前序完成后按序执行', async () => {
  const fake = instantRun()
  const { deps, replies } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  expect(d.submit('c1', '一')).toBe('accepted')
  expect(d.submit('c1', '二')).toBe('queued')
  expect(d.busy('c1')).toBe(true)
  // 同步提交后只有第一个任务被启动，第二个仍在队列
  expect(fake.calls.map((c) => c.options.prompt)).toEqual(['一'])
  fake.deferreds[0]!.resolve({ text: '答一', sessionId: 's1', exitCode: 0 })
  await vi.waitFor(() => expect(fake.calls).toHaveLength(2))
  expect(fake.calls[1]!.options.prompt).toBe('二')
  expect(fake.calls[1]!.options.sessionId).toBe('s1')
  await vi.waitFor(() =>
    expect(replies.map((r) => r.text)).toEqual(['答一', 'done:二']),
  )
  expect(d.busy('c1')).toBe(false)
})

test('队列满（默认上限 5）时第 7 条返回 rejected-busy', async () => {
  const fake = instantRun()
  const { deps } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  expect(d.submit('c1', '运行中')).toBe('accepted')
  for (let i = 1; i <= 5; i++) {
    expect(d.submit('c1', `排${i}`)).toBe('queued')
  }
  expect(d.submit('c1', '第7条')).toBe('rejected-busy')
  // 队列未破坏：释放后 6 条全部按序执行
  fake.deferreds[0]!.resolve({ text: '答0', exitCode: 0 })
  await vi.waitFor(() => expect(fake.calls).toHaveLength(6))
  fake.deferreds[5]!.resolve({ text: '答5', exitCode: 0 })
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))
})

test('自定义 maxQueue 生效', () => {
  const fake = instantRun()
  const { deps } = makeDeps(fake.run, { maxQueue: 1 })
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  expect(d.submit('c1', '运行中')).toBe('accepted')
  expect(d.submit('c1', '排1')).toBe('queued')
  expect(d.submit('c1', '排2')).toBe('rejected-busy')
})

test('stop 触发 RunOptions.signal abort，onReply 收到「已中止」，返回是否在跑', async () => {
  const { run, calls } = makeFakeRun((call) => {
    // 模拟真 runAgentTask：监听 abort 并 reject
    return new Promise<TaskResult>((_, reject) => {
      call.options.signal?.addEventListener('abort', () => reject(new Error('中止')), {
        once: true,
      })
    })
  })
  const { deps, replies } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.submit('c1', '长任务')
  await drain()
  expect(d.stop('c1')).toBe(true)
  expect(calls[0]!.options.signal?.aborted).toBe(true)
  await vi.waitFor(() => expect(replies.some((r) => r.text === '已中止')).toBe(true))
  // 已中止后无任务在跑，再次 stop 返回 false
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))
  expect(d.stop('c1')).toBe(false)
})

test('未在跑的 chat stop 返回 false 且不回复', async () => {
  const fake = instantRun()
  const { deps, replies } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  expect(d.stop('c1')).toBe(false)
  await drain()
  expect(replies).toHaveLength(0)
})

test('每次 run 都调用 cwdFor，且以绑定 agent 名为参', async () => {
  const fake = instantRun(() => 's1')
  const cwdFor = vi.fn((agentName: string) => `/ws/${agentName}`)
  const { deps } = makeDeps(fake.run, { cwdFor })
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'codex') // codex 有 workspace 覆盖，但 cwdFor 由外层决定
  d.submit('c1', '问1')
  await drain()
  d.submit('c1', '问2')
  await drain()
  expect(cwdFor).toHaveBeenCalledTimes(2)
  expect(cwdFor).toHaveBeenNthCalledWith(1, 'codex')
  expect(cwdFor).toHaveBeenNthCalledWith(2, 'codex')
  expect(fake.calls[0]!.options.cwd).toBe('/ws/codex')
  expect(fake.calls[1]!.options.cwd).toBe('/ws/codex')
})

test('串行性：单 chat 并发峰值 ≤ 1', async () => {
  let active = 0
  let peak = 0
  const { run } = makeFakeRun(async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 5))
    active--
    return { text: 'ok', exitCode: 0 }
  })
  const { deps } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  for (let i = 0; i < 4; i++) d.submit('c1', `t${i}`)
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))
  expect(peak).toBe(1)
})

test('不同 chat 可并发运行', async () => {
  let active = 0
  let peak = 0
  const run = vi.fn(async (): Promise<TaskResult> => {
    active++
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 10))
    active--
    return { text: 'ok', exitCode: 0 }
  })
  const { deps } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('a', 'claude')
  d.bind('b', 'claude')
  expect(d.submit('a', 'a问')).toBe('accepted')
  expect(d.submit('b', 'b问')).toBe('accepted')
  await vi.waitFor(() => expect(d.busy('a')).toBe(false))
  await vi.waitFor(() => expect(d.busy('b')).toBe(false))
  expect(peak).toBe(2)
})

test('run 拒绝时 onReply 收到「任务失败: …」，submit 不抛出', async () => {
  const { run } = makeFakeRun(() => Promise.reject(new Error('boom 详情')))
  const { deps, replies } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  expect(() => d.submit('c1', '会炸的任务')).not.toThrow()
  await vi.waitFor(() =>
    expect(replies).toEqual([{ chatId: 'c1', text: '任务失败: boom 详情' }]),
  )
  expect(d.busy('c1')).toBe(false)
})

test('任务失败不清理 sessionId，resume 对重试仍然有效', async () => {
  let fail = true
  const { run } = makeFakeRun(() =>
    fail ? Promise.reject(new Error('炸了')) : Promise.resolve({ text: '好', sessionId: 's-keep', exitCode: 0 }),
  )
  const { deps } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  // 先成功一次拿到 sessionId
  fail = false
  d.submit('c1', '成功任务')
  await vi.waitFor(() => expect(d.binding('c1')?.sessionId).toBe('s-keep'))
  // 再失败一次
  fail = true
  d.submit('c1', '失败任务')
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))
  expect(d.binding('c1')?.sessionId).toBe('s-keep')
  // 队列中的后续任务仍带 sessionId
  fail = false
  d.submit('c1', '重试任务')
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))
  const last = run.mock.calls.at(-1)![1]
  expect(last.sessionId).toBe('s-keep')
})

test('setSession 显式设置与清除（/new 语义）', async () => {
  const fake = instantRun(() => 's1')
  const { deps } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.setSession('c1', 'claude', 'manual-1')
  expect(d.binding('c1')?.sessionId).toBe('manual-1')
  d.submit('c1', '问')
  await drain()
  expect(fake.calls[0]!.options.sessionId).toBe('manual-1')
  d.setSession('c1', 'claude', undefined)
  expect(d.binding('c1')?.sessionId).toBeUndefined()
  d.submit('c1', '再问')
  await drain()
  expect(fake.calls[1]!.options.sessionId).toBeUndefined()
})

test('mode：默认 auto，setMode 后每次 run 透传', async () => {
  const fake = instantRun()
  const { deps } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  expect(d.modeOf('c1')).toBe<PermissionMode>('auto')
  d.bind('c1', 'claude')
  d.setMode('c1', 'full')
  expect(d.modeOf('c1')).toBe('full')
  d.submit('c1', '问')
  await drain()
  expect(fake.calls[0]!.options.mode).toBe('full')
})

test('snapshot 返回车道、默认 agent 与模式的只读视图', () => {
  const fake = instantRun()
  const { deps } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.setSession('c1', 'claude', 's1')
  d.setMode('c1', 'full')
  d.bind('c2', 'codex')
  const snap = d.snapshot()
  expect(snap.chats).toEqual([{ chatId: 'c1', agentName: 'claude', sessionId: 's1' }])
  expect(snap.defaults).toEqual({ c1: 'claude', c2: 'codex' })
  expect(snap.modes).toEqual({ c1: 'full' })
})

test('车道模型：bind 改默认不触碰既有车道的会话', () => {
  const fake = instantRun()
  const { deps } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.setSession('c1', 'claude', 's-old')
  // 改默认到 codex：claude 车道的会话原样保留
  d.bind('c1', 'codex')
  expect(d.defaultAgentOf('c1')).toBe('codex')
  expect(d.binding('c1')?.sessionId).toBeUndefined() // 默认车道（codex）还没有会话
  // claude 车道的会话仍在：显式按 agent 设置/读取
  d.setSession('c1', 'claude', 's-new')
  d.setSession('c1', 'codex', 's-codex')
  expect(d.snapshot().chats).toEqual([
    { chatId: 'c1', agentName: 'claude', sessionId: 's-new' },
    { chatId: 'c1', agentName: 'codex', sessionId: 's-codex' },
  ])
})

test('onReply 自身拒绝不会让 submit 抛出或卡死队列', async () => {
  const fake = instantRun()
  const { deps } = makeDeps(fake.run, {
    onReply: () => Promise.reject(new Error('通道炸了')),
  })
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.submit('c1', '一')
  d.submit('c1', '二')
  await vi.waitFor(() => expect(fake.calls).toHaveLength(2))
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))
})

test('onReply 永不 settle 时队列仍推进（回复超时兜底）', async () => {
  vi.useFakeTimers()
  try {
    const fake = instantRun()
    const { deps } = makeDeps(fake.run, {
      onReply: () => new Promise<void>(() => {}),
    })
    const d = new ChatDispatcher(deps)
    d.bind('c1', 'claude')
    expect(d.submit('c1', '一')).toBe('accepted')
    expect(d.submit('c1', '二')).toBe('queued')
    // 越过 REPLY_TIMEOUT_MS 后，挂死的回复被放行，队列继续
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fake.calls.map((c) => c.options.prompt)).toEqual(['一', '二'])
    // 第二个任务的挂死回复同样被超时放行后会话回到空闲
    await vi.advanceTimersByTimeAsync(120_000)
    expect(d.busy('c1')).toBe(false)
    expect(d.stop('c1')).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

test('stop 中止当前任务后，排队任务仍按序执行', async () => {
  let callIndex = 0
  const run = vi.fn((config: AgentConfig, options: RunOptions): Promise<TaskResult> => {
    void config
    if (callIndex++ === 0) {
      // 首个任务模拟真 runAgentTask：abort 即 reject
      return new Promise<TaskResult>((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('中止')), { once: true })
      })
    }
    return Promise.resolve({ text: `答${options.prompt}`, exitCode: 0 })
  })
  const { deps, replies } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  expect(d.submit('c1', '一')).toBe('accepted')
  expect(d.submit('c1', '二')).toBe('queued')
  expect(d.submit('c1', '三')).toBe('queued')
  expect(d.stop('c1')).toBe(true)
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))
  expect(run).toHaveBeenCalledTimes(3)
  // 被中止的首任务不发「任务失败」，只发「已中止」；排队任务照常回复
  expect(replies.map((r) => r.text)).toEqual(['已中止', '答二', '答三'])
})

test('车道模型：排队任务留在原车道，rebind 只改默认（排队任务不换 agent）', async () => {
  const first = deferred()
  const run = vi.fn((config: AgentConfig, options: RunOptions): Promise<TaskResult> => {
    void options
    if (config.name === 'claude') return first.promise
    return Promise.resolve({ text: `codex 答`, exitCode: 0 })
  })
  const { deps, replies } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.setSession('c1', 'claude', 's-old')
  expect(d.submit('c1', '一')).toBe('accepted')
  expect(d.submit('c1', '二')).toBe('queued')
  // 任务一在跑时改默认到 codex：claude 车道（含排队任务与 sessionId）不动
  d.bind('c1', 'codex')
  first.resolve({ text: '答一', exitCode: 0 })
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))
  expect(run).toHaveBeenCalledTimes(2)
  // 排队任务仍在 claude 车道用 claude 执行，并保留车道会话
  expect(run.mock.calls[1]![0].name).toBe('claude')
  expect(run.mock.calls[1]![1].sessionId).toBe('s-old')
  expect(run.mock.calls[1]![1].cwd).toBe('/cwd/claude')
  expect(replies.map((r) => r.text)).toEqual(['答一', '答一']) // 排队任务仍在 claude 车道，同一 promise 同回复
  // 新的无 @ 消息才会走 codex
  expect(d.submit('c1', '新消息')).toBe('accepted')
  await vi.waitFor(() => expect(run.mock.calls[2]![0].name).toBe('codex'))
})

test('同一聊天连续两次 stop 只中止一次，只回复一条「已中止」', async () => {
  const { run, calls } = makeFakeRun((call) => {
    return new Promise<TaskResult>((_, reject) => {
      call.options.signal?.addEventListener('abort', () => reject(new Error('中止')), {
        once: true,
      })
    })
  })
  const { deps, replies } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.submit('c1', '长任务')
  await drain()
  expect(d.stop('c1')).toBe(true)
  // 任务尚未 settle（running 仍真），第二次 stop 被 aborted 守卫拦下
  expect(d.stop('c1')).toBe(false)
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))
  expect(calls).toHaveLength(1)
  expect(replies.filter((r) => r.text === '已中止')).toHaveLength(1)
})

test('stopAll：所有 chat 在跑任务的 signal 被中止，队列被丢弃不再执行', async () => {
  const aborted: boolean[] = []
  const run = vi.fn((config: AgentConfig, options: RunOptions): Promise<TaskResult> => {
    void config
    return new Promise<TaskResult>((_, reject) => {
      options.signal?.addEventListener('abort', () => {
        aborted.push(true)
        reject(new Error('中止'))
      }, { once: true })
    })
  })
  const { deps, replies } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('a', 'claude')
  d.bind('b', 'claude')
  expect(d.submit('a', 'a1')).toBe('accepted')
  expect(d.submit('a', 'a2')).toBe('queued')
  expect(d.submit('b', 'b1')).toBe('accepted')
  await drain()
  d.stopAll()
  expect(aborted).toHaveLength(2) // 两个在跑任务的 signal 都被中止
  // 放行微任务：被中止的任务 reject 后队列里没有新任务被启动
  await drain()
  await drain()
  expect(d.busy('a')).toBe(false) // 队列已清空
  expect(d.busy('b')).toBe(false)
  expect(run).toHaveBeenCalledTimes(2) // 只有两个在跑任务，队列任务未执行
  expect(replies).toHaveLength(0) // 关机不发「已中止」回复
})

test('stopAll 对空闲 dispatcher 是安全 no-op', () => {
  const fake = instantRun()
  const { deps } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  expect(() => d.stopAll()).not.toThrow()
})

test('onTaskEnd 在任务终态（成功/失败/中止）时收到 chatId，先于队列续跑', async () => {
  const ends: string[] = []
  let fail = true
  const { run } = makeFakeRun(() =>
    fail
      ? Promise.reject(new Error('炸了'))
      : Promise.resolve({ text: '好', exitCode: 0 }),
  )
  const { deps } = makeDeps(run, { onTaskEnd: (chatId) => ends.push(chatId) })
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  // 失败终态
  d.submit('c1', '一')
  await vi.waitFor(() => expect(ends).toEqual(['c1']))
  // 成功终态 ×2（第二个来自队列续跑），每次终态都回调
  fail = false
  d.submit('c1', '二')
  d.submit('c1', '三')
  await vi.waitFor(() => expect(ends).toEqual(['c1', 'c1', 'c1']))
  expect(d.busy('c1')).toBe(false)
})

test('onTaskEnd 抛出不影响队列推进', async () => {
  const { run } = makeFakeRun(() => Promise.resolve({ text: '好', exitCode: 0 }))
  const { deps, replies } = makeDeps(run, {
    onTaskEnd: () => {
      throw new Error('清理炸了')
    },
  })
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.submit('c1', '一')
  d.submit('c1', '二')
  await vi.waitFor(() => expect(replies.map((r) => r.text)).toEqual(['好', '好']))
  expect(d.busy('c1')).toBe(false)
})

test('queueInfo 汇报运行中与排队数（/status 展示用）', async () => {
  const gates: ((value: TaskResult) => void)[] = []
  const { run } = makeFakeRun(
    () => new Promise<TaskResult>((resolve) => gates.push(resolve)),
  )
  const { deps } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  expect(d.queueInfo('c1')).toEqual({ running: false, queued: 0 })
  d.bind('c1', 'claude')
  expect(d.submit('c1', '一')).toBe('accepted')
  await drain()
  expect(d.queueInfo('c1')).toEqual({ running: true, queued: 0 })
  expect(d.submit('c1', '二')).toBe('queued')
  expect(d.queueInfo('c1')).toEqual({ running: true, queued: 1 })
  gates[0]!({ text: '答一', exitCode: 0 })
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  expect(d.queueInfo('c1')).toEqual({ running: true, queued: 0 })
  gates[1]!({ text: '答二', exitCode: 0 })
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))
  expect(d.queueInfo('c1')).toEqual({ running: false, queued: 0 })
})

test('运行中切换 agent：结果仍返回，但 sessionId 不写到新 agent 头上', async () => {
  const deferredFirst = deferred()
  const seen: RunOptions[] = []
  const { deps, replies } = makeDeps((async (config: AgentConfig, options: RunOptions) => {
    seen.push(options)
    if (seen.length === 1) return deferredFirst.promise
    return { text: 'ok', sessionId: 'sess-new', exitCode: 0 }
  }) as typeof runAgentTask)
  const d = new ChatDispatcher(deps)
  d.bind('room-1', 'claude')

  // 任务 1（claude）启动
  expect(d.submit('room-1', '慢任务')).toBe('accepted')
  await vi.waitFor(() => expect(seen).toHaveLength(1))
  expect(seen[0]!.sessionId).toBeUndefined()

  // 运行中切到 codex：绑定换人，旧任务继续持有自己的 agent
  d.bind('room-1', 'codex')
  deferredFirst.resolve({ text: 'claude 的结果', sessionId: 'sess-claude-old', exitCode: 0 })
  await vi.waitFor(() => expect(replies.some((r) => r.text === 'claude 的结果')).toBe(true)) // 结果仍返回

  const binding = d.binding('room-1')!
  expect(binding.agentName).toBe('codex')
  expect(binding.sessionId).toBeUndefined() // claude 的会话 id 不得污染 codex

  // 任务 2（codex）正常启动并写回自己的会话
  d.submit('room-1', '新任务')
  await vi.waitFor(() => expect(seen).toHaveLength(2))
  expect(seen[1]!.sessionId).toBeUndefined() // 切换时已重置
  await vi.waitFor(() => expect(d.binding('room-1')!.sessionId).toBe('sess-new'))
})

test('任务运行中 /sessions 显式选会话：任务结果的 sessionId 写回不得覆盖显式选择', async () => {
  const deferredFirst = deferred()
  const run = vi.fn((_config: AgentConfig, _options: RunOptions): Promise<TaskResult> => deferredFirst.promise)
  const { deps } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')

  expect(d.submit('c1', '慢任务')).toBe('accepted')
  await drain()
  // 任务在跑（它从 sess-start 续跑），用户显式切到 picked-by-user
  d.setSession('c1', 'claude', 'sess-start')
  d.setSession('c1', 'claude', 'picked-by-user')
  deferredFirst.resolve({ text: '答', sessionId: 'sess-from-task', exitCode: 0 })
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))

  // 用户的显式选择必须保留，而不是被任务的写回覆盖
  expect(d.binding('c1')?.sessionId).toBe('picked-by-user')

  // 下一任务携带用户选的会话，而不是任务写回的会话
  d.submit('c1', '下一问')
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  expect(run.mock.calls[1]![1].sessionId).toBe('picked-by-user')
})

test('任务运行中 /new：任务结果的 sessionId 不得复活已清空的会话', async () => {
  const deferredFirst = deferred()
  const run = vi.fn((_config: AgentConfig, _options: RunOptions): Promise<TaskResult> => deferredFirst.promise)
  const { deps } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.setSession('c1', 'claude', 'sess-old')

  expect(d.submit('c1', '慢任务')).toBe('accepted')
  await drain()
  d.clearAllSessions('c1') // /new
  deferredFirst.resolve({ text: '答', sessionId: 'sess-continuation', exitCode: 0 })
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))

  // /new 的「全新开始」不能被运行中任务的写回撤销
  expect(d.binding('c1')?.sessionId).toBeUndefined()
})

test('stop 多车道并行时中止所有在跑任务并只回复一条', async () => {
  const signals: AbortSignal[] = []
  const run = vi.fn((_config: AgentConfig, options: RunOptions): Promise<TaskResult> => {
    signals.push(options.signal!)
    return new Promise<TaskResult>((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('中止')), { once: true })
    })
  })
  const { deps, replies } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  expect(d.submit('c1', 'claude 任务')).toBe('accepted')
  expect(d.submit('c1', 'codex 任务', 'codex')).toBe('accepted') // @codex 车道并行
  await drain()
  expect(signals).toHaveLength(2)

  expect(d.stop('c1')).toBe(true)
  // 两条车道都被中止，而不是只有第一条
  expect(signals.every((s) => s.aborted)).toBe(true)
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))
  // 单条汇总回复，而不是只有第一个车道收到「已中止」
  expect(replies).toHaveLength(1)
  expect(replies[0]!.text).toBe('已中止 2 个任务')
})

test('onReply 收到回复所属的 agent 名（多车道文件解析依赖）', async () => {
  const fake = instantRun()
  const { deps, replyAgents } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'codex')
  d.submit('c1', '问')
  await vi.waitFor(() => expect(replyAgents.length).toBeGreaterThan(0))
  expect(replyAgents.every((a) => a === 'codex')).toBe(true)
})

test('失败回复同样携带 agent 名', async () => {
  const { run } = makeFakeRun(() => Promise.reject(new Error('boom')))
  const { deps, replyAgents } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.submit('c1', '会炸的任务')
  await vi.waitFor(() => expect(replyAgents.length).toBeGreaterThan(0))
  expect(replyAgents.every((a) => a === 'claude')).toBe(true)
})

test('replyText：多车道会话回复带 agent 前缀，单车道保持干净', async () => {
  // 多车道：默认 claude 车道 + codex 车道并存 → claude 的回复带前缀
  const run = vi.fn((_config: AgentConfig, options: RunOptions): Promise<TaskResult> => {
    void options
    return Promise.resolve({ text: '答', exitCode: 0 })
  })
  const { deps, replies } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.submit('c1', '单车道问')
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))
  expect(replies.map((r) => r.text)).toEqual(['答']) // 单车道：无前缀

  // 此时 codex 车道建立 → 两条车道 → claude 再回复应带前缀
  d.bind('c1', 'codex')
  d.submit('c1', 'codex 问', 'codex')
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))
  expect(replies.at(-1)!.text).toBe('「codex」答')
})
