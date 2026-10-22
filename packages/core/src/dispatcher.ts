import { runAgentTask, type RunOptions, type TaskResult } from './adapter.js'
import type { AgentConfig, PermissionMode } from './types.js'
import { formatAgentFailure } from './failure.js'

export interface DispatcherDeps {
  agents: AgentConfig[]
  run: typeof runAgentTask
  /** agent 覆盖目录 ?? 全局工作目录，由外层注入 */
  cwdFor(agentName: string): string
  onReply(chatId: string, text: string): Promise<void>
  /** 任务终态钩子（成功/失败/中止都触发，队列续跑前调用）：外层据此清理该任务所属 chat 的遗留状态 */
  onTaskEnd?(chatId: string, agentName: string): void
  /** 每车道排队上限，默认 5 */
  maxQueue?: number
}

/** 一条「车道」= 会话 × agent：独立队列、独立会话，可与其他车道并行。 */
export interface ChatBinding {
  chatId: string
  agentName: string
  sessionId?: string
}

interface LaneState {
  agentName: string
  sessionId?: string
  queue: string[]
  running: boolean
  abort: AbortController | undefined
}

/** 车道键：chatId 与 agent 名用单元分隔符连接（二者都不含该字符）。 */
function laneKey(chatId: string, agentName: string): string {
  return `${chatId}␟${agentName}`
}

/** 单条回复的兜底时限：onReply 永不 settle 时超时放行，宁可丢一条回复也不卡死会话队列。 */
const REPLY_TIMEOUT_MS = 120_000

/**
 * 多 agent 并行调度器：每 (会话, agent) 一条车道，车道内严格串行（并发峰值 1），
 * 车道间并行——@claude 与 @codex 可以同时干活。无 @ 前缀的消息进「默认 agent」
 * 车道（由 bind/enableAgent 设置）。每车道独立保留 sessionId，互不污染。
 */
export class ChatDispatcher {
  private readonly agents = new Map<string, AgentConfig>()
  private readonly lanes = new Map<string, LaneState>()
  /** 每个会话的默认 agent（无 @ 前缀消息的去处） */
  private readonly defaults = new Map<string, string>()
  private readonly modes = new Map<string, PermissionMode>()
  private readonly maxQueue: number

  constructor(private readonly deps: DispatcherDeps) {
    for (const agent of deps.agents) this.agents.set(agent.name, agent)
    this.maxQueue = deps.maxQueue ?? 5
  }

  /** 设置会话的默认 agent；未知 agent 返回 undefined。不影响已存在的其他车道。 */
  bind(chatId: string, agentName: string): AgentConfig | undefined {
    const config = this.agents.get(agentName)
    if (!config) return undefined
    this.defaults.set(chatId, agentName)
    return config
  }

  /** 会话当前默认 agent（无默认且只有一条车道时回退到那条车道，便于面板展示）。 */
  defaultAgentOf(chatId: string): string | undefined {
    return this.defaults.get(chatId) ?? this.chatLanes(chatId)[0]?.agentName
  }

  binding(chatId: string): ChatBinding | undefined {
    const agentName = this.defaultAgentOf(chatId)
    if (agentName === undefined) return undefined
    const lane = this.lanes.get(laneKey(chatId, agentName))
    return { chatId, agentName, ...(lane?.sessionId !== undefined ? { sessionId: lane.sessionId } : {}) }
  }

  /** /sessions 的会话绑定与 /new 的清会话都走这里；这是 sessionId 的唯一显式清除入口。 */
  setSession(chatId: string, agentName: string, sessionId: string | undefined): void {
    const key = laneKey(chatId, agentName)
    // 车道不存在也要创建：绑定会话本身就是在建立车道（如 /sessions 在首条消息前选取）
    const lane = this.lanes.get(key) ?? { agentName, queue: [], running: false, abort: undefined }
    this.lanes.set(key, lane)
    if (sessionId === undefined) delete lane.sessionId
    else lane.sessionId = sessionId
  }

  /** /new：清空该会话所有车道的会话（全新开始）。 */
  clearAllSessions(chatId: string): void {
    for (const lane of this.chatLanes(chatId)) delete lane.sessionId
  }

  setMode(chatId: string, mode: PermissionMode): void {
    this.modes.set(chatId, mode)
  }

  modeOf(chatId: string): PermissionMode {
    return this.modes.get(chatId) ?? 'auto'
  }

  /** 会话整体是否繁忙（任一车道在跑或排队）。 */
  busy(chatId: string): boolean {
    return this.chatLanes(chatId).some((lane) => lane.running || lane.queue.length > 0)
  }

  /** 某车道的运行/排队状态；不指定 agent 时聚合整车。 */
  queueInfo(chatId: string, agentName?: string): { running: boolean; queued: number } {
    const lanes: LaneState[] = agentName !== undefined
      ? [this.lanes.get(laneKey(chatId, agentName))].filter((lane): lane is LaneState => lane !== undefined)
      : this.chatLanes(chatId)
    return {
      running: lanes.some((lane) => lane.running),
      queued: lanes.reduce((sum, lane) => sum + lane.queue.length, 0),
    }
  }

  /**
   * 提交任务。agentOverride（@提及）优先于会话默认 agent；
   * 未设默认且无 override 时拒绝。目标车道在跑则排队（有界，满则拒绝）。
   * 永不抛出——run 的任何失败都转为 onReply 的失败提示。
   */
  submit(chatId: string, text: string, agentOverride?: string): 'accepted' | 'queued' | 'rejected-unbound' | 'rejected-busy' | 'rejected-unknown-agent' {
    if (agentOverride !== undefined && !this.agents.has(agentOverride)) return 'rejected-unknown-agent'
    const agentName = agentOverride ?? this.defaultAgentOf(chatId)
    if (agentName === undefined || !this.agents.has(agentName)) return 'rejected-unbound'
    const key = laneKey(chatId, agentName)
    let lane = this.lanes.get(key)
    if (lane === undefined) {
      lane = { agentName, queue: [], running: false, abort: undefined }
      this.lanes.set(key, lane)
    }
    if (lane.running || lane.queue.length > 0) {
      if (lane.queue.length >= this.maxQueue) return 'rejected-busy'
      lane.queue.push(text)
      return 'queued'
    }
    this.runTask(chatId, key, lane, text)
    return 'accepted'
  }

  /** 中止会话的当前任务；agentName 限定单条车道。排队中的任务不受影响，按序继续。 */
  stop(chatId: string, agentName?: string): boolean {
    const lanes: LaneState[] = agentName !== undefined
      ? [this.lanes.get(laneKey(chatId, agentName))].filter((lane): lane is LaneState => lane !== undefined)
      : this.chatLanes(chatId)
    for (const lane of lanes) {
      if (lane.running && lane.abort !== undefined && !lane.abort.signal.aborted) {
        lane.abort.abort()
        void this.reply(chatId, '已中止')
        return true
      }
    }
    return false
  }

  /**
   * 关机语义（Hub.stop 调用，与 /stop 不同）：中止所有车道在跑任务，
   * 队列丢弃。不发送「已中止」回复（进程即将退出）。
   */
  stopAll(): void {
    for (const lane of this.lanes.values()) {
      lane.queue.length = 0
      if (lane.running && lane.abort !== undefined && !lane.abort.signal.aborted) {
        lane.abort.abort()
      }
    }
  }

  /** 面板/持久化用：所有车道的绑定快照（每车道一条）。 */
  snapshot(): { chats: ChatBinding[]; modes: Record<string, PermissionMode>; defaults: Record<string, string> } {
    const chats: ChatBinding[] = []
    for (const [key, lane] of this.lanes) {
      const chatId = key.split('␟')[0]!
      chats.push({ chatId, agentName: lane.agentName, ...(lane.sessionId !== undefined ? { sessionId: lane.sessionId } : {}) })
    }
    const modes: Record<string, PermissionMode> = {}
    for (const [chatId, mode] of this.modes) modes[chatId] = mode
    const defaults: Record<string, string> = {}
    for (const [chatId, agentName] of this.defaults) defaults[chatId] = agentName
    return { chats, modes, defaults }
  }

  /** 恢复持久化车道（chatId + agentName + sessionId）。 */
  restoreLane(chatId: string, agentName: string, sessionId?: string): void {
    const key = laneKey(chatId, agentName)
    const lane = this.lanes.get(key) ?? { agentName, queue: [], running: false, abort: undefined }
    if (sessionId !== undefined) lane.sessionId = sessionId
    this.lanes.set(key, lane)
  }

  restoreDefault(chatId: string, agentName: string): void {
    this.defaults.set(chatId, agentName)
  }

  private defaultLaneKey(chatId: string): string | undefined {
    const agentName = this.defaultAgentOf(chatId)
    return agentName === undefined ? undefined : laneKey(chatId, agentName)
  }

  private chatLanes(chatId: string): LaneState[] {
    const prefix = `${chatId}␟`
    const lanes: LaneState[] = []
    for (const [key, lane] of this.lanes) {
      if (key.startsWith(prefix)) lanes.push(lane)
    }
    return lanes
  }

  private runTask(chatId: string, key: string, lane: LaneState, text: string): void {
    // 任务全程锁定启动时的 agent：这条车道就是它的 agent，不存在运行中换人的问题
    const taskAgentName = lane.agentName
    const config = this.agents.get(taskAgentName)
    if (!config) {
      void this.reply(chatId, `任务失败: 未知 agent（${taskAgentName}）`)
      this.finishAndDrain(chatId, key, lane)
      return
    }
    lane.running = true
    lane.abort = new AbortController()
    const options: RunOptions = {
      prompt: text,
      mode: this.modeOf(chatId),
      cwd: this.deps.cwdFor(taskAgentName),
      chatId,
      signal: lane.abort.signal,
    }
    if (lane.sessionId !== undefined) options.sessionId = lane.sessionId

    this.deps
      .run(config, options)
      .then((result: TaskResult) => {
        // 会话写回：车道专属，天然不会跨 agent 污染
        if (result.sessionId !== undefined) lane.sessionId = result.sessionId
        if (result.text !== '') return this.reply(chatId, this.replyText(chatId, taskAgentName, result.text))
        return undefined
      })
      .catch((err: unknown) => {
        // stop 主动中止时已回复「已中止」，避免重复报错
        if (!lane.abort?.signal.aborted) {
          const message = err instanceof Error ? err.message : String(err)
          // 把「配置没配好」这类失败翻译成用户能照做的提示（未识别时保留原文）
          return this.reply(chatId, this.replyText(chatId, taskAgentName, formatAgentFailure(taskAgentName, message)))
        }
        return undefined
      })
      .catch(() => {
        // onReply 自身失败也不能影响队列推进
      })
      .finally(() => this.finishAndDrain(chatId, key, lane))
  }

  /** 多车道会话给回复加 agent 前缀，防混淆；单车道保持干净。 */
  private replyText(chatId: string, agentName: string, text: string): string {
    return this.chatLanes(chatId).length > 1 ? `「${agentName}」${text}` : text
  }

  private finishAndDrain(chatId: string, key: string, lane: LaneState): void {
    lane.running = false
    lane.abort = undefined
    // 任务终态（成功/失败/中止）钩子：外层据此清理该任务的遗留状态；失败不阻塞队列
    try {
      this.deps.onTaskEnd?.(chatId, lane.agentName)
    } catch {
      // 清理钩子失败也不能影响队列推进
    }
    const next = lane.queue.shift()
    if (next !== undefined) this.runTask(chatId, key, lane, next)
  }

  /** 回复通道：竞速一个兜底超时。onReply 永不 settle 时按时放行，队列持续推进。 */
  private reply(chatId: string, text: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REPLY_TIMEOUT_MS)
    })
    return Promise.race([this.deps.onReply(chatId, text).catch(() => {}), timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }
}
