import { runAgentTask, type RunOptions, type TaskResult } from './adapter.js'
import type { AgentConfig, PermissionMode } from './types.js'

export interface DispatcherDeps {
  agents: AgentConfig[]
  run: typeof runAgentTask
  /** agent 覆盖目录 ?? 全局工作目录，由外层注入 */
  cwdFor(agentName: string): string
  onReply(chatId: string, text: string): Promise<void>
  /** 任务终态钩子（成功/失败/中止都触发，队列续跑前调用）：外层据此清理该 chat 的遗留状态 */
  onTaskEnd?(chatId: string): void
  /** 每 chat 排队上限，默认 5 */
  maxQueue?: number
}

export interface ChatBinding {
  agentName: string
  sessionId?: string
}

interface ChatState {
  binding: ChatBinding
  queue: string[]
  running: boolean
  abort: AbortController | undefined
}

/** 单条回复的兜底时限：onReply 永不 settle 时超时放行，宁可丢一条回复也不卡死会话队列。 */
const REPLY_TIMEOUT_MS = 120_000

/**
 * 每 chat 的 agent 绑定与串行任务队列：同一 chat 任务严格按序执行（并发峰值 1），
 * 不同 chat 互不阻塞。会话恢复：首个任务不带 sessionId，之后把绑定里的 sessionId
 * 交给 runAgentTask 做 {{sessionId}} 替换；失败不清理 sessionId（/new 是唯一清除入口）。
 */
export class ChatDispatcher {
  private readonly agents = new Map<string, AgentConfig>()
  private readonly chats = new Map<string, ChatState>()
  private readonly modes = new Map<string, PermissionMode>()
  private readonly maxQueue: number

  constructor(private readonly deps: DispatcherDeps) {
    for (const agent of deps.agents) this.agents.set(agent.name, agent)
    this.maxQueue = deps.maxQueue ?? 5
  }

  /** 绑定 chat 到 agent；未知 agent 返回 undefined。rebind 到不同 agent 时重置会话。 */
  bind(chatId: string, agentName: string): AgentConfig | undefined {
    const config = this.agents.get(agentName)
    if (!config) return undefined
    const existing = this.chats.get(chatId)
    if (existing) {
      if (existing.binding.agentName !== agentName) existing.binding.sessionId = undefined
      existing.binding.agentName = agentName
    } else {
      this.chats.set(chatId, { binding: { agentName }, queue: [], running: false, abort: undefined })
    }
    return config
  }

  binding(chatId: string): ChatBinding | undefined {
    return this.chats.get(chatId)?.binding
  }

  /** /sessions 的会话绑定与 /new 的清会话都走这里；这是 sessionId 的唯一显式清除入口。 */
  setSession(chatId: string, sessionId: string | undefined): void {
    const state = this.chats.get(chatId)
    if (!state) return
    if (sessionId === undefined) delete state.binding.sessionId
    else state.binding.sessionId = sessionId
  }

  setMode(chatId: string, mode: PermissionMode): void {
    this.modes.set(chatId, mode)
  }

  modeOf(chatId: string): PermissionMode {
    return this.modes.get(chatId) ?? 'auto'
  }

  busy(chatId: string): boolean {
    const state = this.chats.get(chatId)
    return state !== undefined && (state.running || state.queue.length > 0)
  }

  /** /status 展示用：该 chat 是否有任务在跑与排队数（未绑定为空闲）。 */
  queueInfo(chatId: string): { running: boolean; queued: number } {
    const state = this.chats.get(chatId)
    return state !== undefined
      ? { running: state.running, queued: state.queue.length }
      : { running: false, queued: 0 }
  }

  /**
   * 提交任务：未绑定拒绝；在跑则排队（有界，满则拒绝）。
   * 永不抛出——run 的任何失败都转为 onReply 的「任务失败: …」。
   */
  submit(chatId: string, text: string): 'accepted' | 'queued' | 'rejected-unbound' | 'rejected-busy' {
    const state = this.chats.get(chatId)
    if (!state) return 'rejected-unbound'
    if (state.running || state.queue.length > 0) {
      if (state.queue.length >= this.maxQueue) return 'rejected-busy'
      state.queue.push(text)
      return 'queued'
    }
    this.runTask(chatId, state, text)
    return 'accepted'
  }

  /** 中止当前任务；返回是否有任务在跑（排队中的任务不受影响，按序继续）。 */
  stop(chatId: string): boolean {
    const state = this.chats.get(chatId)
    if (!state || !state.running || state.abort === undefined) return false
    // 已中止过则不再重复中止与回复（防连点导致多条「已中止」）
    if (state.abort.signal.aborted) return false
    state.abort.abort()
    void this.reply(chatId, '已中止')
    return true
  }

  /**
   * 关机语义（Hub.stop 调用，与 /stop 不同）：中止所有 chat 的在跑任务
   * （经各自 AbortController），队列中的任务直接丢弃、不再执行——关机不执行新任务。
   * 不发送「已中止」回复（进程即将退出，回复无意义）。
   */
  stopAll(): void {
    for (const state of this.chats.values()) {
      state.queue.length = 0
      if (state.running && state.abort !== undefined && !state.abort.signal.aborted) {
        state.abort.abort()
      }
    }
  }

  snapshot(): { chats: Record<string, ChatBinding>; modes: Record<string, PermissionMode> } {
    const chats: Record<string, ChatBinding> = {}
    for (const [chatId, state] of this.chats) chats[chatId] = { ...state.binding }
    const modes: Record<string, PermissionMode> = {}
    for (const [chatId, mode] of this.modes) modes[chatId] = mode
    return { chats, modes }
  }

  /** 启动一个任务并接管其后续：成功回透结果、失败回错误文本、终态后驱动队列。 */
  private runTask(chatId: string, state: ChatState, text: string): void {
    const config = this.agents.get(state.binding.agentName)
    if (!config) {
      // bind 校验过的 agent 不应缺失；防御性兜底，不抛出
      void this.reply(chatId, `任务失败: 未知 agent（${state.binding.agentName}）`)
      this.finishAndDrain(chatId, state)
      return
    }
    state.running = true
    state.abort = new AbortController()
    const options: RunOptions = {
      prompt: text,
      mode: this.modeOf(chatId),
      cwd: this.deps.cwdFor(state.binding.agentName),
      chatId,
      signal: state.abort.signal,
    }
    if (state.binding.sessionId !== undefined) options.sessionId = state.binding.sessionId

    this.deps
      .run(config, options)
      .then((result: TaskResult) => {
        // 会话写回：失败路径不经过这里，sessionId 只在新会话产生时更新
        if (result.sessionId !== undefined) state.binding.sessionId = result.sessionId
        if (result.text !== '') return this.reply(chatId, result.text)
        return undefined
      })
      .catch((err: unknown) => {
        // stop 主动中止时已回复「已中止」，避免重复报错
        if (!state.abort?.signal.aborted) {
          const message = err instanceof Error ? err.message : String(err)
          return this.reply(chatId, `任务失败: ${message}`)
        }
        return undefined
      })
      .catch(() => {
        // onReply 自身失败也不能影响队列推进
      })
      .finally(() => this.finishAndDrain(chatId, state))
  }

  /**
   * 回复通道：竞速一个兜底超时。onReply 永不 settle 时按时放行，
   * 保证 .finally 驱动的队列持续推进（此方法从不 reject）。
   */
  private reply(chatId: string, text: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REPLY_TIMEOUT_MS)
    })
    return Promise.race([this.deps.onReply(chatId, text).catch(() => {}), timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  private finishAndDrain(chatId: string, state: ChatState): void {
    state.running = false
    state.abort = undefined
    // 任务终态（完成/失败/中止）钩子：外层清理该 chat 的挂起审批等遗留状态；失败不阻塞队列
    try {
      this.deps.onTaskEnd?.(chatId)
    } catch {
      // 清理钩子失败也不能影响队列推进
    }
    const next = state.queue.shift()
    if (next !== undefined) this.runTask(chatId, state, next)
  }
}
