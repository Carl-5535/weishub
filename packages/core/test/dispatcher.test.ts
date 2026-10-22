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
    onReply: (chatId: string, text: string) => Promise<void>
    maxQueue: number
  }> = {},
) {
  const replies: Array<{ chatId: string; text: string }> = []
  return {
    deps: {
      agents: [agentA, agentB],
      run,
      cwdFor: overrides.cwdFor ?? ((agentName: string) => `/cwd/${agentName}`),
      onReply:
        overrides.onReply ??
        ((chatId: string, text: string) => {
          replies.push({ chatId, text })
          return Promise.resolve()
        }),
      maxQueue: overrides.maxQueue,
    },
    replies,
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

test('bind 已知 agent 返回其配置并建立绑定', () => {
  const fake = instantRun()
  const { deps } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  expect(d.bind('c1', 'claude')).toBe(agentA)
  expect(d.binding('c1')).toEqual<ChatBinding>({ agentName: 'claude' })
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
  expect(d.binding('c1')).toEqual<ChatBinding>({ agentName: 'claude', sessionId: 'sess-1' })
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
  d.setSession('c1', 'manual-1')
  expect(d.binding('c1')?.sessionId).toBe('manual-1')
  d.submit('c1', '问')
  await drain()
  expect(fake.calls[0]!.options.sessionId).toBe('manual-1')
  d.setSession('c1', undefined)
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

test('snapshot 返回绑定与模式的只读视图', () => {
  const fake = instantRun()
  const { deps } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.setSession('c1', 's1')
  d.setMode('c1', 'full')
  d.bind('c2', 'codex')
  const snap = d.snapshot()
  expect(snap.chats).toEqual({
    c1: { agentName: 'claude', sessionId: 's1' },
    c2: { agentName: 'codex' },
  })
  expect(snap.modes).toEqual({ c1: 'full' })
})

test('rebind 到不同 agent 重置 sessionId，同 agent 保留', () => {
  const fake = instantRun()
  const { deps } = makeDeps(fake.run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.setSession('c1', 's-old')
  d.bind('c1', 'codex')
  expect(d.binding('c1')?.sessionId).toBeUndefined()
  d.setSession('c1', 's-new')
  d.bind('c1', 'codex')
  expect(d.binding('c1')?.sessionId).toBe('s-new')
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

test('队列有任务时 rebind 到另一 agent：排队任务换 agent 执行且旧 sessionId 失效', async () => {
  const first = deferred()
  const run = vi.fn((config: AgentConfig, options: RunOptions): Promise<TaskResult> => {
    void options
    if (config.name === 'claude') return first.promise
    return Promise.resolve({ text: `codex 答`, exitCode: 0 })
  })
  const { deps, replies } = makeDeps(run)
  const d = new ChatDispatcher(deps)
  d.bind('c1', 'claude')
  d.setSession('c1', 's-old')
  expect(d.submit('c1', '一')).toBe('accepted')
  expect(d.submit('c1', '二')).toBe('queued')
  // 任务一还在跑时 rebind：sessionId 立即重置
  d.bind('c1', 'codex')
  expect(d.binding('c1')?.sessionId).toBeUndefined()
  first.resolve({ text: '答一', exitCode: 0 }) // 不产生新 sessionId
  await vi.waitFor(() => expect(d.busy('c1')).toBe(false))
  expect(run).toHaveBeenCalledTimes(2)
  // 排队任务在 codex 配置下执行，且不带被重置前的旧会话
  expect(run.mock.calls[1]![0].name).toBe('codex')
  expect(run.mock.calls[1]![1].sessionId).toBeUndefined()
  expect(run.mock.calls[1]![1].cwd).toBe('/cwd/codex')
  expect(replies.map((r) => r.text)).toEqual(['答一', 'codex 答'])
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
