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

export interface HubDeps {
  client: Pick<ILinkClient, 'poll' | 'sendText' | 'sendMedia' | 'sendTyping'>
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

export class Hub {
  readonly dispatcher: ChatDispatcher
  readonly approvals: ApprovalRouter
  readonly outbox: Outbox

  readonly #deps: HubDeps
  readonly #notifyToken: string
  readonly #seen = new Set<string>()
  /** 有挂起审批时收到的普通文本：在该 chat 的下一条回复末尾附提醒 */
  readonly #reminders = new Map<string, number>()
  #credential: StoredCredential | undefined
  #notify: { port: number; close(): Promise<void> } | undefined
  #lock: HubLock | undefined
  #stopped = false
  #loopStarted = false
  /** Web 面板设置的工作目录覆盖（per-agent 优先于 agent 配置，再优先于全局） */
  #workspaceOverride: { global?: string; perAgent?: Record<string, string> } = {}
  readonly #pollAbort = new AbortController()
  /** 状态写入串行化：并发事件共享一条写入链，stop 时等待尾部写入完成 */
  #persistChain: Promise<void> = Promise.resolve()

  constructor(deps: HubDeps) {
    this.#deps = deps
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

  /** owner 白名单 id（Web 面板以 owner 身份注入消息用）。 */
  get ownerUserId(): string {
    return this.#deps.ownerUserId
  }

  /** 已发现可用 agent 名（Web 面板聊天列表徽标与工作目录表单用）。 */
  get agents(): AgentConfig[] {
    return this.#deps.agents
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
   * Web 面板扫码确认后调用：重读凭据文件；首次拿到凭据时启动轮询循环
   * （start 时的「等待扫码」空转由此转为正式轮询）。返回是否已登录。
   */
  async reloadCredential(): Promise<boolean> {
    if (this.#credential !== undefined) return true
    try {
      this.#credential = await readCredential(defaultCredentialPath())
    } catch {
      return false
    }
    if (!this.#stopped && !this.#loopStarted) this.#startLoop()
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
      sendText: (text) => this.#deps.client.sendText(this.#deps.ownerUserId, text),
      sendImage: (name, bytes) => this.#deps.client.sendMedia(this.#deps.ownerUserId, name, bytes),
      outbox: this.outbox,
      approvals: this.approvals,
      getLoggedIn: () => this.#credential !== undefined,
      port: this.#deps.notifyPort,
    })
    if (this.#credential !== undefined) this.#startLoop()
    await this.outbox.resumePending().catch(() => undefined)
  }

  async stop(): Promise<void> {
    this.#stopped = true
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

  /** 手动推进一次轮询（测试接缝，主循环同一实现）；单次异常静默返回，循环不退出。 */
  async tick(): Promise<void> {
    try {
      await this.#pollOnce()
    } catch {
      // 与主循环同语义：单次失败只退避重试，绝不退出循环
    }
  }

  /** 轮询循环每条消息的入口。 */
  async handleInbound(message: InboundMessage): Promise<void> {
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

    // /sessions 的序号选择最优先：裸数字回复只用于绑定会话，
    // 绝不落入审批词匹配、命令解析或提示词管线
    if (text !== '' && resolveSelection(message.chatId, text)) return

    // 审批应答优先：该 chat 有挂起审批时，同意/拒绝词直接决议，不进任务队列
    const pendings = this.approvals.pending().filter((a) => a.chatId === message.chatId)
    if (pendings.length > 0) {
      const verdict = classifyApprovalReply(text)
      if (verdict === 'allow' || verdict === 'deny') {
        // 只决议最老的一条：一条「同意」对应一个挂起请求，避免误放行后续请求
        const oldest = pendings.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b))
        this.approvals.resolve(oldest.id, verdict)
        await this.#reply(message.chatId, verdict === 'allow' ? '已允许' : '已拒绝')
        return
      }
      if (verdict === 'web') {
        await this.#reply(message.chatId, 'Web 审批面板在 Task 19 接入，先用微信回复')
        return
      }
      // 其余文本照常处理，但之后的回复要带上待审批提醒
      this.#reminders.set(message.chatId, pendings.length)
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
      const first = this.#deps.agents[0]!
      this.dispatcher.bind(message.chatId, first.name)
      await this.#persistState()
      await this.#reply(message.chatId, `已绑定 agent「${first.name}」，直接发消息即可开始。`)
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
    this.outbox.enqueue(chatId, body, files)
    await this.#persistState()
  }

  /** 所有回复统一走 outbox：通道未就绪时内容留存在发件箱，绝不丢失。 */
  async #reply(chatId: string, text: string): Promise<void> {
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
    void (async () => {
      while (!this.#stopped) {
        try {
          await this.#pollOnce()
        } catch {
          if (this.#stopped) return
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, POLL_BACKOFF_MS)
            timer.unref?.()
          })
        }
      }
    })()
  }

  async #pollOnce(): Promise<void> {
    const messages = await this.#deps.client.poll(this.#pollAbort.signal)
    for (const message of messages) {
      if (this.#stopped) return
      await this.handleInbound(message)
    }
  }
}
