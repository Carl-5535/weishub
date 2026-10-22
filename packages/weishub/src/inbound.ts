/**
 * Hub：入站管线与 serve 装配的纯逻辑核心。
 *
 * 职责：轮询循环（含异常退避）、消息去重、owner 白名单、审批应答路由、
 * 命令分发接口（Task 17 实装）、媒体落盘注入 prompt、agent 回复的
 * 文件外发（send-file 指令 + 本地路径探测）、outbox 可靠投递与状态持久化。
 *
 * 所有通道原语经 HubDeps.client 注入：测试用内存假件，serve 用真实 ILinkClient。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  acquireHubLock,
  defaultCredentialPath,
  defaultStatePath,
  detectLocalFilePaths,
  extractFileDirectives,
  legacyCredentialPath,
  migrateLegacyCredential,
  pathExists,
  readCredential,
  readPrivateJson,
  resolveWorkspaceFile,
  saveInboundMedia,
  writePrivateJson,
  type HubLock,
  type ILinkClient,
  type ILinkState,
  type InboundMessage,
  Outbox,
  type OutboxItem,
  type StoredCredential,
} from '@weishub/channel-wechat'
import {
  ApprovalRouter,
  ChatDispatcher,
  listSessions as coreListSessions,
  runAgentTask,
  startNotifyApi,
  type AgentConfig,
  type PermissionMode,
  type RunOptions,
  type SessionInfo,
  type TaskResult,
} from '@weishub/core'
import { handleCommand, resolveSelection } from './commands.js'
import {
  CREDENTIAL_CHECK_INTERVAL_MS,
  expiryView,
  healthFromExpiry,
  isCredentialRejection,
  type CredentialHealth,
} from './credential.js'

export interface HubDeps {
  client: Pick<ILinkClient, 'poll' | 'sendText' | 'sendMedia' | 'sendTyping'>
  /**
   * 用新凭据重建通道 client（重新扫码后必须换掉旧的——token 在构造时固化）。
   * 不传则沿用 deps.client（测试/无登录场景）。
   */
  createClient?: (credential: StoredCredential) => Pick<ILinkClient, 'poll' | 'sendText' | 'sendMedia' | 'sendTyping'>
  accountId: string
  ownerUserId: string
  agents: AgentConfig[]
  /** 全部已配置 agent（含未安装），供 /agents 展示；缺省视为与 agents 相同 */
  allAgents?: AgentConfig[]
  /** 全局工作目录，默认 ~/weishub-workspace（缺则创建） */
  workspace: string
  notifyPort?: number
  webPort?: number
  /** 测试注入：旧插件凭据目录（默认 ~/.dsh/wechat-gateway） */
  legacyCredentialDir?: string
  /** 测试注入：替身 runAgentTask（默认真实实现） */
  run?: typeof runAgentTask
  /** 单条回复最大字符数（超出分块），默认 2000 */
  maxReplyChars?: number
  /** notify api 鉴权 token，缺省随机生成 */
  notifyToken?: string
}

/** 命令上下文与实装见 ./commands.js（CommandContext、handleCommand、resolveSelection）。 */
export type { CommandContext } from './commands.js'

const SEEN_CAP = 4096
const POLL_BACKOFF_MS = 3000
const SEND_FILE_MAX_BYTES = 100 * 1024 * 1024
const EMPTY_RESULT_TEXT = '（任务完成，无文本输出）'
const NO_AGENTS_TEXT = '未发现可用 agent，请先安装 claude/codex 等'
const ALLOW_WORDS = new Set(['同意', '允许', 'yes'])
const DENY_WORDS = new Set(['拒绝', 'no'])

type ApprovalReply = 'allow' | 'deny' | 'web' | 'other'

/** 消息流单条记录（Web 面板 §9「消息流：查看收发」）。 */
export interface ChatMessageEntry {
  /** in = 收到的消息（微信/面板插话），out = hub 发出的回复 */
  direction: 'in' | 'out'
  text: string
  at: number
}

const MESSAGE_RING_CAP = 50
/** 发件箱兜底重试间隔：一次持续失败后不必等重启 */
const OUTBOX_RETRY_MS = 60_000
const MESSAGE_EXCERPT_CHARS = 500

function classifyApprovalReply(text: string): ApprovalReply {
  const normalized = text.trim().toLowerCase()
  if (ALLOW_WORDS.has(normalized)) return 'allow'
  if (DENY_WORDS.has(normalized)) return 'deny'
  if (text.includes('网页')) return 'web'
  return 'other'
}

/** 编译产物 lib/approval-mcp.js 与本文件同目录（源码态指向 src/，仅供测试断言路径形态）。 */
function approvalMcpScriptPath(): string {
  return fileURLToPath(new URL('./approval-mcp.js', import.meta.url))
}

/**
 * 读取持久化的 iLink 协议状态（轮询游标 + per-chat context token）。
 * serve 在构造 ILinkClient 前调用：读出的 state 传给 client 构造器即可断点续轮询。
 * 无状态文件或形态非法时返回 undefined（全新开始）。
 */
export async function loadPersistedProtocol(): Promise<ILinkState | undefined> {
  try {
    const state = await readPrivateJson<{ protocol?: unknown }>(defaultStatePath())
    return normalizeProtocol(state.protocol)
  } catch {
    return undefined
  }
}

/** 只接受合法形态：updatesBuffer 必须是字符串，contextTokens 必须是字符串到字符串的映射。 */
function normalizeProtocol(raw: unknown): ILinkState | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.updatesBuffer !== 'string') return undefined
  const contextTokens: Record<string, string> = {}
  if (typeof rec.contextTokens === 'object' && rec.contextTokens !== null && !Array.isArray(rec.contextTokens)) {
    for (const [key, value] of Object.entries(rec.contextTokens)) {
      if (typeof value === 'string') contextTokens[key] = value
    }
  }
  return { updatesBuffer: rec.updatesBuffer, contextTokens }
}

export class Hub {
  readonly dispatcher: ChatDispatcher
  readonly approvals: ApprovalRouter
  readonly outbox: Outbox

  readonly #deps: HubDeps
  readonly #notifyToken: string
  readonly #seen = new Set<string>()
  /** 有挂起审批时收到的普通文本：在该 chat 的下一条回复末尾附提醒 */
  readonly #reminders = new Map<string, number>()
  /** 每 chat 的消息环（收发各记一条，封顶 MESSAGE_RING_CAP，纯内存供 Web 面板消息流） */
  readonly #messages = new Map<string, ChatMessageEntry[]>()
  /** 任务终态撤销过挂起审批的 chat：其后的下一条同意/拒绝词视为对死请求的回应 */
  readonly #cancelledApprovals = new Set<string>()
  #credential: StoredCredential | undefined
  #notify: { port: number; close(): Promise<void> } | undefined
  #lock: HubLock | undefined
  #stopped = false
  #loopStarted = false
  /** 上一轮轮询是否失败（决定主循环要不要退避） */
  #lastRoundFailed = false
  /** Web 面板设置的工作目录覆盖（per-agent 优先于 agent 配置，再优先于全局） */
  #workspaceOverride: { global?: string; perAgent?: Record<string, string> } = {}
  /** 唯一启用的 agent（未设置时退回第一个已发现的 agent） */
  #enabledAgent: string | undefined
  /** 轮询中止控制器：重启循环时换新的（旧的 abort 后不可复用） */
  #pollAbort = new AbortController()
  /** 状态写入串行化：并发事件共享一条写入链，stop 时等待尾部写入完成 */
  #persistChain: Promise<void> = Promise.resolve()
  /** iLink 协议状态（轮询游标 + context token）：client onStateChange 喂入，随状态落盘 */
  #protocol: ILinkState | undefined
  /** 当前生效的通道 client（重新扫码后会整体换成用新 token 构造的实例） */
  #client: Pick<ILinkClient, 'poll' | 'sendText' | 'sendMedia' | 'sendTyping'>
  /** 发件箱兜底重试定时器（stop 时清除） */
  #outboxRetryTimer: ReturnType<typeof setInterval> | undefined
  /** 最近一次收到微信消息的时间（ISO）——收信即续期，是到期推算的锚点 */
  #lastActivityAt: string | undefined
  /** 服务端明确拒绝过凭据（重新扫码后清除） */
  #credentialRejected: string | undefined

  constructor(deps: HubDeps) {
    this.#deps = deps
    this.#client = deps.client
    this.#notifyToken = deps.notifyToken ?? randomBytes(24).toString('hex')
    this.approvals = new ApprovalRouter()
    this.outbox = new Outbox({
      send: (chatId, text) => deps.client.sendText(chatId, text),
      sendFile: async (chatId, path) => {
        const bytes = await readFile(path)
        await deps.client.sendMedia(chatId, basename(path), new Uint8Array(bytes))
      },
      maxChars: deps.maxReplyChars ?? 2000,
    })
    this.dispatcher = new ChatDispatcher({
      agents: deps.agents,
      run: this.#makeRun(),
      cwdFor: (agentName) => this.#cwdFor(agentName),
      onReply: (chatId, text) => this.#onAgentReply(chatId, text),
      // 任务终态（完成/失败/中止）：撤销该 chat 的挂起审批（中止/崩溃后的审批已无主，
      // 否则下一个「同意」会误决议死请求），并清掉待审批提醒
      onTaskEnd: (chatId) => {
        // 只有确实撤销了挂起审批才登记，供下一条同意/拒绝词给出说明而不是误下发
        if (this.approvals.pending().some((a) => a.chatId === chatId)) {
          this.#cancelledApprovals.add(chatId)
        }
        this.approvals.cancelChat(chatId)
        this.#reminders.delete(chatId)
      },
    })
    // 发件箱全部送完时把「已清空」的断点写回状态，避免重启后重放已投递内容
    this.outbox.onEmpty(() => {
      void this.#persistState()
    })
  }

  /** notify api 端口（start 后有效；测试断言审批桥 env 注入用）。 */
  get notifyPort(): number | undefined {
    return this.#notify?.port
  }

  /** 是否已持有登录凭据（Web 面板登录态展示用）。 */
  get loggedIn(): boolean {
    return this.#credential !== undefined
  }

  /**
   * 凭据健康度：本地按最近收信时间推算到期，并结合服务端是否拒绝过。
   * 启动时与每 10 分钟各刷新一次（见 #startCredentialCheck）。
   */
  get credentialHealth(): CredentialHealth {
    if (this.#credential === undefined) return { state: 'missing' }
    if (this.#credentialRejected !== undefined) return { state: 'rejected', reason: this.#credentialRejected }
    return healthFromExpiry(expiryView(this.#credential.savedAt, this.#lastActivityAt, Date.now()), Date.now())
  }

  /**
   * 凭据核实。
   *
   * **不能用 poll() 探活**：iLink 的游标（get_updates_buf）在 client 内共享，
   * 一次探测性 poll 会消费掉本属于主循环的消息、并推进游标让主循环跳过它们
   * ——那是实打实的丢消息。
   *
   * 实际上也不需要探测：主循环每次 getupdates 都在验证 token，
   * 失败时自己会标记 rejected（见 #startLoop）。这里只做本地推算，
   * 保证启动瞬间（循环还没跑起来）也有结论。
   */
  async checkCredential(): Promise<CredentialHealth> {
    return this.credentialHealth
  }

  /**
   * 启动时报一次凭据状态（本地推算 + 已持久化的拒绝结论）。
   * 不做定时探活：主循环的每次 getupdates 就是最强的探活，
   * 额外的探针只会和它抢游标（见 checkCredential 的注释）。
   */
  #startCredentialCheck(): void {
    const health = this.credentialHealth
    if (health.state === 'rejected') {
      process.stderr.write(`微枢：微信凭据已失效（${health.reason}），请重新扫码登录\n`)
    } else if (health.state === 'expired') {
      process.stderr.write('微枢：微信凭据已过期，主动推送将失败；发一条消息即可续期\n')
    }
  }

  /** owner 白名单 id（Web 面板以 owner 身份注入消息用）。 */
  get ownerUserId(): string {
    return this.#deps.ownerUserId
  }

  /** 已发现可用 agent 名（Web 面板聊天列表徽标与工作目录表单用）。 */
  get agents(): AgentConfig[] {
    return this.#deps.agents
  }

  /**
   * 当前「启用」的 agent 名：一次只能启用一个。
   * 显式设置过就用它（若该 agent 仍可用），否则退回第一个已发现的 agent。
   */
  get enabledAgent(): string | undefined {
    if (this.#enabledAgent !== undefined && this.#deps.agents.some((a) => a.name === this.#enabledAgent)) {
      return this.#enabledAgent
    }
    return this.#deps.agents[0]?.name
  }

  /**
   * 启用某个 agent：把它设为唯一启用项，并把所有已绑定聊天改绑到它
   * （换 agent 会重置会话，与 ChatDispatcher.bind 的规则一致）。
   * 未安装/未发现的 agent 直接抛错，避免面板「启用成功」但实际不可用。
   */
  async enableAgent(name: string): Promise<void> {
    const config = this.#deps.agents.find((a) => a.name === name)
    if (config === undefined) throw new Error(`未安装或未发现 agent「${name}」`)
    this.#enabledAgent = name
    for (const chatId of Object.keys(this.dispatcher.snapshot().chats)) {
      this.dispatcher.bind(chatId, name)
    }
    await this.#persistState()
  }

  /**
   * 主动推送的统一出口：成功即证明凭据有效（顺带续期），
   * 鉴权失败则立刻标记，让面板/状态如实反映——否则用户只会看到「发送失败」却不知原因。
   */
  async #sendOutbound(send: () => Promise<void>): Promise<void> {
    try {
      await send()
      if (this.#credentialRejected !== undefined) {
        this.#credentialRejected = undefined
        await this.#persistState().catch(() => undefined)
      }
    } catch (error) {
      if (isCredentialRejection(error) && this.#credentialRejected === undefined) {
        this.#credentialRejected = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)
        await this.#persistState().catch(() => undefined)
      }
      throw error
    }
  }

  /** 当前工作目录配置（global 为生效默认值，perAgent 为覆盖表）。 */
  getWorkspace(): { global: string; perAgent: Record<string, string> } {
    return {
      global: this.#workspaceOverride.global ?? this.#deps.workspace,
      perAgent: { ...this.#workspaceOverride.perAgent },
    }
  }

  /**
   * Web 面板修改工作目录：立即生效（cwdFor 下次取值即新目录）并随状态落盘。
   * 传 undefined 的字段保持不变；perAgent 传空对象即清空全部覆盖。
   */
  async setWorkspace(global?: string, perAgent?: Record<string, string>): Promise<void> {
    if (global !== undefined) {
      await mkdir(global, { recursive: true })
      this.#workspaceOverride.global = global
    }
    if (perAgent !== undefined) this.#workspaceOverride.perAgent = { ...perAgent }
    await this.#persistState()
  }

  /**
   * iLink 协议状态变化（client 的 onStateChange 接缝，serve 装配）：
   * 记录最新游标并随状态链落盘，重启后可从断点续轮询、不重放已消费消息。
   */
  async recordProtocolState(state: ILinkState): Promise<void> {
    this.#protocol = state
    if (this.#stopped) return // stop 的关机尾写已覆盖最终状态
    await this.#persistState()
  }

  /**
   * Web 面板扫码确认后调用：重读凭据文件；首次拿到凭据时启动轮询循环
   * （start 时的「等待扫码」空转由此转为正式轮询）。返回是否已登录。
   */
  async reloadCredential(): Promise<boolean> {
    try {
      const fresh = await readCredential(defaultCredentialPath())
      // 重新扫码拿到新凭据：清除「服务端拒绝过」的旧结论，并视为一次活动
      this.#credential = fresh
      this.#credentialRejected = undefined
      this.#lastActivityAt = new Date().toISOString()
      // token 在 client 构造时固化，换了凭据必须换 client，否则循环重跑也用旧 token
      if (this.#deps.createClient !== undefined) this.#client = this.#deps.createClient(fresh)
    } catch {
      return this.#credential !== undefined
    }
    // 旧循环可能正卡在「凭据失效」的长退避里，且它捕获的是旧 client。
    // 这里重启循环：先中止旧的，再起一条新的（pollAbort 不能复用，重建一个）。
    if (!this.#stopped) this.#restartLoop()
    if (!this.#stopped) this.#startCredentialCheck()
    await this.#persistState().catch(() => undefined)
    return true
  }

  /**
   * 启动顺序：迁移凭据 → 单实例锁 → 读凭据（缺则「等待扫码」空转）→
   * 恢复持久状态 → notify api → 轮询循环。
   */
  async start(): Promise<void> {
    await mkdir(this.#deps.workspace, { recursive: true })
    await this.#migrateCredential()
    this.#lock = await acquireHubLock()
    try {
      this.#credential = await readCredential(defaultCredentialPath())
    } catch {
      this.#credential = undefined // 缺凭据：等待扫码，notify api 照常起，但不轮询
    }
    await this.#loadState()
    this.#notify = await startNotifyApi({
      token: this.#notifyToken,
      ownerChatId: this.#deps.ownerUserId,
      sendText: (text) => this.#sendOutbound(() => this.#client.sendText(this.#deps.ownerUserId, text)),
      sendImage: (name, bytes) => this.#sendOutbound(() => this.#client.sendMedia(this.#deps.ownerUserId, name, bytes)),
      outbox: this.outbox,
      approvals: this.approvals,
      getLoggedIn: () => this.#credential !== undefined,
      port: this.#deps.notifyPort,
    })
    if (this.#credential !== undefined) this.#startLoop()
    await this.outbox.resumePending().catch(() => undefined)
    this.#startOutboxRetry()
    if (this.#credential !== undefined) this.#startCredentialCheck()
  }

  /**
   * 发件箱兜底重试：投递重试耗尽后条目会留在发件箱等下次机会，
   * 但若只在 enqueue/启动时触发，一次持续失败会永久卡住（直到进程重启）。
   * 这里按固定间隔再推一次；只在有挂起内容时才动，空发件箱零开销。
   */
  #startOutboxRetry(): void {
    this.#outboxRetryTimer = setInterval(() => {
      if (this.#stopped) return
      const pending = this.outbox.pending()
      if (Object.keys(pending).length === 0) return
      void this.outbox.resumePending().catch(() => undefined)
    }, OUTBOX_RETRY_MS)
    this.#outboxRetryTimer.unref?.()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#outboxRetryTimer !== undefined) clearInterval(this.#outboxRetryTimer)
    // 关机先停任务：中止所有在跑 agent 进程树、丢弃队列（不执行新任务），再做收尾持久化
    this.dispatcher.stopAll()
    this.#pollAbort.abort()
    await this.#persistChain.catch(() => undefined)
    // 关机尾写：把最终状态（含最后一条投递触发的断点推进）落盘后再释放资源
    await this.#persistState().catch(() => undefined)
    if (this.#notify !== undefined) {
      const notify = this.#notify
      this.#notify = undefined
      await notify.close().catch(() => undefined)
    }
    if (this.#lock !== undefined) {
      const lock = this.#lock
      this.#lock = undefined
      await lock.release().catch(() => undefined)
    }
  }

  /** Web 面板消息流：该 chat 的消息环快照（旧→新，封顶 50 条，纯内存不落盘）。 */
  chatMessages(chatId: string): ChatMessageEntry[] {
    return [...(this.#messages.get(chatId) ?? [])]
  }

  #recordMessage(chatId: string, direction: 'in' | 'out', text: string): void {
    let ring = this.#messages.get(chatId)
    if (ring === undefined) {
      ring = []
      this.#messages.set(chatId, ring)
    }
    const excerpt =
      text.length <= MESSAGE_EXCERPT_CHARS ? text : `${text.slice(0, MESSAGE_EXCERPT_CHARS)}…`
    ring.push({ direction, text: excerpt, at: Date.now() })
    if (ring.length > MESSAGE_RING_CAP) ring.splice(0, ring.length - MESSAGE_RING_CAP)
  }

  /** 手动推进一次轮询（测试接缝，主循环同一实现）；单次异常静默返回，循环不退出。 */
  async tick(): Promise<void> {
    await this.#pollRound(this.#pollAbort.signal)
  }

  /**
   * 一次完整轮询（成功/失败的全部状态维护都在这里）：
   * 主循环与 tick() 共用，避免两条路径的健康状态判断走偏。
   * 只吞异常不抛出——调用方决定是否退避。
   */
  async #pollRound(signal: AbortSignal): Promise<void> {
    this.#lastRoundFailed = false
    try {
      await this.#pollOnce(signal)
      // 一次成功的轮询说明凭据被接受；若此前标记过拒绝，这里清除
      if (this.#credentialRejected !== undefined) {
        this.#credentialRejected = undefined
        await this.#persistState().catch(() => undefined)
      }
    } catch (error) {
      this.#lastRoundFailed = true
      if (this.#stopped || signal.aborted) return
      // 鉴权失败必须让状态可见，否则只是无限退避重试、面板一直显示「已连接」
      if (isCredentialRejection(error) && this.#credentialRejected === undefined) {
        this.#credentialRejected = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)
        await this.#persistState().catch(() => undefined)
        process.stderr.write(`微枢：微信凭据已失效（${this.#credentialRejected}），请重新扫码\n`)
      }
    }
  }

  /** 轮询循环每条消息的入口。 */
  async handleInbound(message: InboundMessage): Promise<void> {
    // 收到微信消息 = 服务端已经接受了当前凭据，顺带续期（这也是过期推算的锚点）
    const activityAt = new Date().toISOString()
    const shouldPersistActivity = this.#lastActivityAt === undefined
      || Date.parse(activityAt) - Date.parse(this.#lastActivityAt) > 60_000
    this.#lastActivityAt = activityAt
    this.#credentialRejected = undefined
    if (shouldPersistActivity) void this.#persistState().catch(() => undefined)
    // 去重先于白名单：同一条消息重复推送无论发给谁都只算一次
    if (message.id !== '') {
      if (this.#seen.has(message.id)) return
      this.#seen.add(message.id)
      while (this.#seen.size > SEEN_CAP) {
        const oldest = this.#seen.values().next().value
        if (oldest === undefined) break
        this.#seen.delete(oldest)
      }
    }
    if (message.userId !== this.#deps.ownerUserId) return
    const text = message.text.trim()
    if (text === '' && message.media.length === 0 && message.mediaErrors.length === 0) return
    // 消息流记录：过了去重与白名单即入环（命令/审批应答也算收到的消息）
    this.#recordMessage(message.chatId, 'in', text)

    // /sessions 的序号选择最优先：裸数字回复只用于绑定会话，
    // 绝不落入审批词匹配、命令解析或提示词管线
    if (text !== '' && resolveSelection(message.chatId, text)) return

    // 审批应答优先：该 chat 有挂起审批时，同意/拒绝词直接决议，不进任务队列
    const pendings = this.approvals.pending().filter((a) => a.chatId === message.chatId)
    const verdict = classifyApprovalReply(text)
    if (pendings.length > 0) {
      if (verdict === 'allow' || verdict === 'deny') {
        // 只决议最老的一条：一条「同意」对应一个挂起请求，避免误放行后续请求
        const oldest = pendings.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b))
        this.approvals.resolve(oldest.id, verdict)
        await this.#reply(message.chatId, verdict === 'allow' ? '已允许' : '已拒绝')
        return
      }
      if (verdict === 'web') {
        await this.#reply(message.chatId, '可在 Web 面板处理该审批（面板地址见 weishub 启动输出）')
        return
      }
      // 其余文本照常处理，但之后的回复要带上待审批提醒
      this.#reminders.set(message.chatId, pendings.length)
    } else if ((verdict === 'allow' || verdict === 'deny') && this.#cancelledApprovals.has(message.chatId) && message.media.length === 0) {
      // 刚因任务终态撤销过审批：这条同意/拒绝是对已死请求的回应，回一句说明而不是下发给 agent。
      // 仅在「撤销过 + 不带附件」时拦一次，避免吃掉 agent 自己的 yes/no 追问（如「要继续吗？yes」）。
      this.#cancelledApprovals.delete(message.chatId)
      await this.#reply(message.chatId, '当前没有待处理的审批')
      return
    }

    if (text.startsWith('/')) {
      await handleCommand(text, {
        chatId: message.chatId,
        dispatcher: this.dispatcher,
        approvals: this.approvals,
        outbox: this.outbox,
        agents: this.#deps.agents,
        allAgents: this.#deps.allAgents,
        listSessions: (config: AgentConfig, limit?: number): Promise<SessionInfo[]> =>
          coreListSessions(config, limit),
        reply: (reply) => this.#reply(message.chatId, reply),
      })
      return
    }

    let prompt = text
    const attachments: string[] = []
    const mediaFailures = [...message.mediaErrors]
    for (const item of message.media) {
      try {
        const path = await saveInboundMedia(this.#deps.workspace, message.chatId, item)
        attachments.push(`\n[附件] ${path} (${item.kind})`)
      } catch (error) {
        mediaFailures.push(`${item.name}: ${(error as Error).message}`)
      }
    }
    if (mediaFailures.length > 0) {
      prompt = `（提示：部分附件接收失败：${mediaFailures.join('；')}）\n${prompt}`
      await this.#reply(message.chatId, `注意：有 ${mediaFailures.length} 个附件接收失败，已略过（详见任务提示）`)
    }
    prompt += attachments.join('')

    if (this.dispatcher.binding(message.chatId) === undefined) {
      if (this.#deps.agents.length === 0) {
        await this.#reply(message.chatId, NO_AGENTS_TEXT)
        return
      }
      const enabled = this.enabledAgent ?? this.#deps.agents[0]!.name
      this.dispatcher.bind(message.chatId, enabled)
      await this.#persistState()
      await this.#reply(message.chatId, `已绑定 agent「${enabled}」，直接发消息即可开始。`)
    }

    const outcome = this.dispatcher.submit(message.chatId, prompt)
    if (outcome === 'rejected-busy') {
      await this.#reply(message.chatId, '任务队列已满，请稍后再试')
    }
  }

  #cwdFor(agentName: string): string {
    const override = this.#workspaceOverride.perAgent?.[agentName]
    if (override !== undefined) return override
    const config = this.#deps.agents.find((a) => a.name === agentName)
    if (config?.workspace) return config.workspace
    return this.#workspaceOverride.global ?? this.#deps.workspace
  }

  /**
   * run 包装器：claude 类 agent 在 auto 模式下为单次任务写临时 --mcp-config
   * （指向编译产物 approval-mcp.js，env 注入 notify 端口/token/chatId），
   * 并把空结果替换为占位文案；临时文件在任务 settle 后清理。
   */
  #makeRun(): typeof runAgentTask {
    const realRun = this.#deps.run ?? runAgentTask
    return async (config: AgentConfig, options: RunOptions): Promise<TaskResult> => {
      const chatId = options.chatId
      let serverConfigPath: string | undefined
      let approvalTool: RunOptions['approvalTool']
      if (config.approval === 'permission-prompt-tool' && options.mode === 'auto' && chatId !== undefined) {
        serverConfigPath = join(tmpdir(), `weishub-mcp-${randomUUID()}.json`)
        const serverConfig = {
          mcpServers: {
            'weishub-approval': {
              command: 'node',
              args: [approvalMcpScriptPath()],
              env: {
                WEISHUB_PORT: String(this.#notify?.port ?? this.#deps.notifyPort ?? ''),
                WEISHUB_TOKEN: this.#notifyToken,
                WEISHUB_CHAT_ID: chatId,
              },
            },
          },
        }
        await writeFile(serverConfigPath, `${JSON.stringify(serverConfig, null, 2)}\n`, { mode: 0o600 })
        approvalTool = { serverConfigPath, toolName: 'weishub_request_permission' }
      }
      try {
        const result = await realRun(config, { ...options, approvalTool })
        return result.text === '' ? { ...result, text: EMPTY_RESULT_TEXT } : result
      } finally {
        if (serverConfigPath !== undefined) await unlink(serverConfigPath).catch(() => undefined)
      }
    }
  }

  /** agent 回复通道：提取文件指令与本地路径（工作区校验）后经 outbox 分块回发。 */
  async #onAgentReply(chatId: string, text: string): Promise<void> {
    const cwd = this.#cwdFor(this.dispatcher.binding(chatId)?.agentName ?? '')
    const { text: cleaned, files: directiveFiles } = extractFileDirectives(text)
    const files: string[] = []
    for (const candidate of [...directiveFiles, ...detectLocalFilePaths(cleaned)]) {
      try {
        files.push((await resolveWorkspaceFile(cwd, candidate, SEND_FILE_MAX_BYTES)).path)
      } catch {
        // 不存在或越出工作区的路径一律不外发
      }
    }
    let body = cleaned === '' ? EMPTY_RESULT_TEXT : cleaned
    const reminder = this.#reminders.get(chatId)
    if (reminder !== undefined) {
      this.#reminders.delete(chatId)
      body += `\n\n（提醒：你有 ${reminder} 项待审批项，回复 同意/拒绝 处理）`
    }
    this.#recordMessage(chatId, 'out', body)
    this.outbox.enqueue(chatId, body, files)
    await this.#persistState()
  }

  /** 所有回复统一走 outbox：通道未就绪时内容留存在发件箱，绝不丢失。 */
  async #reply(chatId: string, text: string): Promise<void> {
    this.#recordMessage(chatId, 'out', text)
    this.outbox.enqueue(chatId, text)
    await this.#persistState()
  }

  async #migrateCredential(): Promise<void> {
    if (await migrateLegacyCredential() !== null) return
    const legacyPath = this.#deps.legacyCredentialDir !== undefined
      ? join(this.#deps.legacyCredentialDir, 'account.json')
      : legacyCredentialPath()
    if (await pathExists(defaultCredentialPath())) return
    if (!(await pathExists(legacyPath))) return
    if (this.#deps.legacyCredentialDir !== undefined) {
      // 测试注入目录：与 migrateLegacyCredential 同规则的迁移
      try {
        await writePrivateJson(defaultCredentialPath(), await readCredential(legacyPath))
        return
      } catch {
        // 校验失败按迁移失败处理
      }
    }
    process.stderr.write('检测到旧凭据但迁移失败，将需要重新扫码\n')
  }

  async #loadState(): Promise<void> {
    try {
      const state = await readPrivateJson<{
        chats?: Record<string, { agentName: string; sessionId?: string }>
        modes?: Record<string, string>
        outbox?: Record<string, OutboxItem>
        workspace?: { global?: string; perAgent?: Record<string, string> }
        protocol?: unknown
        enabledAgent?: string
        lastActivityAt?: string
        credentialRejected?: string
      }>(defaultStatePath())
      for (const [chatId, binding] of Object.entries(state.chats ?? {})) {
        if (this.dispatcher.bind(chatId, binding.agentName) !== undefined && binding.sessionId !== undefined) {
          this.dispatcher.setSession(chatId, binding.sessionId)
        }
      }
      for (const [chatId, mode] of Object.entries(state.modes ?? {})) {
        if (mode === 'auto' || mode === 'full') this.dispatcher.setMode(chatId, mode as PermissionMode)
      }
      if (state.outbox !== undefined) this.outbox.load(state.outbox)
      // 协议状态：保留到内存，保证后续持久化不丢游标（client 侧的恢复由 serve 在构造时完成）
      this.#protocol = normalizeProtocol(state.protocol)
      // 唯一启用的 agent：只在仍可用时采用，否则由 getter 退回第一个已发现项
      if (typeof state.enabledAgent === 'string' && state.enabledAgent !== '') {
        this.#enabledAgent = state.enabledAgent
      }
      if (typeof state.lastActivityAt === 'string' && !Number.isNaN(Date.parse(state.lastActivityAt))) {
        this.#lastActivityAt = state.lastActivityAt
      }
      if (typeof state.credentialRejected === 'string' && state.credentialRejected !== '') {
        this.#credentialRejected = state.credentialRejected
      }
      // 工作目录覆盖：只接受合法形态，其余按无覆盖处理
      const saved = state.workspace
      if (typeof saved?.global === 'string' && saved.global !== '') this.#workspaceOverride.global = saved.global
      if (saved?.perAgent !== undefined && typeof saved.perAgent === 'object' && !Array.isArray(saved.perAgent)) {
        const perAgent: Record<string, string> = {}
        for (const [name, dir] of Object.entries(saved.perAgent)) {
          if (typeof dir === 'string' && dir !== '') perAgent[name] = dir
        }
        this.#workspaceOverride.perAgent = perAgent
      }
    } catch {
      // 无状态或状态损坏：全新开始
    }
  }

  async #persistState(): Promise<void> {
    const snapshot = this.dispatcher.snapshot()
    const value = {
      chats: snapshot.chats,
      modes: snapshot.modes,
      outbox: this.outbox.pending(),
      workspace: {
        ...(this.#workspaceOverride.global !== undefined ? { global: this.#workspaceOverride.global } : {}),
        ...(this.#workspaceOverride.perAgent !== undefined ? { perAgent: this.#workspaceOverride.perAgent } : {}),
      },
      ...(this.enabledAgent !== undefined ? { enabledAgent: this.enabledAgent } : {}),
      ...(this.#lastActivityAt !== undefined ? { lastActivityAt: this.#lastActivityAt } : {}),
      ...(this.#credentialRejected !== undefined ? { credentialRejected: this.#credentialRejected } : {}),
      ...(this.#protocol !== undefined ? { protocol: this.#protocol } : {}),
    }
    const write = this.#persistChain.catch(() => undefined).then(async () => {
      try {
        await writePrivateJson(defaultStatePath(), value)
      } catch (error) {
        process.stderr.write(`weishub 状态持久化失败: ${(error as Error).message}\n`)
      }
    })
    this.#persistChain = write
    await write
  }

  #startLoop(): void {
    this.#loopStarted = true
    const abort = this.#pollAbort
    void (async () => {
      while (!this.#stopped && !abort.signal.aborted) {
        await this.#pollRound(abort.signal)
        if (this.#stopped || abort.signal.aborted) return
        // pollRound 从不抛出：成功时会立刻进入下一轮（长轮询本身就是等待），
        // 失败时按凭据状态决定退避时长。
        if (this.#lastRoundFailed) {
          await new Promise<void>((resolve) => {
            // 凭据已失效时不必每 3 秒重试一次：降频到 1 分钟，等用户重新扫码
            const wait = this.#credentialRejected !== undefined ? CREDENTIAL_CHECK_INTERVAL_MS : POLL_BACKOFF_MS
            const timer = setTimeout(resolve, wait)
            timer.unref?.()
          })
        }
      }
    })()
  }

  /**
   * 重启轮询循环（重新扫码后调用）：旧循环可能正卡在长退避里、
   * 且它持有的是用旧 token 构造的 client。先中止旧的再起新的。
   */
  #restartLoop(): void {
    this.#pollAbort.abort()
    this.#pollAbort = new AbortController()
    this.#startLoop()
  }

  async #pollOnce(signal: AbortSignal): Promise<void> {
    const messages = await this.#client.poll(signal)
    for (const message of messages) {
      if (this.#stopped) return
      await this.handleInbound(message)
    }
  }
}
