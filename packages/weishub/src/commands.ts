/**
 * 微信命令面：/agents /agent /sessions /new /status /stop /permission /help
 * 及中文别名（/帮助 /状态 /停止 /新会话 /权限），大小写不敏感。
 *
 * 纯函数式分发：识别并消费命令返回 true，非命令文本返回 false。
 * /sessions 列出的会话用「回复序号」绑定；该一次性选择状态存内存
 * Map（重启丢失可接受）。inbound 管线须在审批词匹配与命令解析之前
 * 先调用 resolveSelection——裸数字回复绝不变成提示词或命令。
 */

import type { Outbox } from '@weishub/channel-wechat'
import type { AgentConfig, ApprovalRouter, ChatDispatcher, SessionInfo } from '@weishub/core'

export interface CommandContext {
  chatId: string
  dispatcher: ChatDispatcher
  approvals: ApprovalRouter
  outbox: Outbox
  /** 已安装（PATH 探测命中）的 agent 列表 */
  agents: AgentConfig[]
  /** 全部已配置 agent（含未安装）；缺省视为与 agents 相同 */
  allAgents?: AgentConfig[]
  listSessions(config: AgentConfig, limit?: number): Promise<SessionInfo[]>
  reply(text: string): Promise<void>
}

const HELP_TEXT = [
  '微枢命令：',
  '/agents 列出可用 agent（含未安装）',
  '/agent <名字> 切换默认 agent',
  '@<agent> <任务> 交给指定 agent 执行（可与默认 agent 并行）',
  '/sessions 列出该 agent 的历史会话，回复序号切换',
  '/new 开启新会话',
  '/status 查看状态',
  '/stop 停止当前任务',
  '/permission [auto|full] 查看/切换权限模式',
  '/help 显示本帮助',
  '非命令文本直接发给已绑定的 agent。',
].join('\n')

const ALIASES: Record<string, string> = {
  help: 'help',
  帮助: 'help',
  agents: 'agents',
  agent: 'agent',
  sessions: 'sessions',
  new: 'new',
  新会话: 'new',
  status: 'status',
  状态: 'status',
  stop: 'stop',
  停止: 'stop',
  permission: 'permission',
  权限: 'permission',
}

/** 识别并处理命令：已消费返回 true，非命令文本返回 false。 */
export async function handleCommand(input: string, ctx: CommandContext): Promise<boolean> {
  const text = input.trim()
  if (!text.startsWith('/')) return false
  const [head = '', ...rest] = text.split(/\s+/)
  const command = ALIASES[head.slice(1).toLowerCase()]
  if (command === undefined) {
    await ctx.reply(`未知命令 ${head}。\n\n${HELP_TEXT}`)
    return true
  }
  const arg = rest.join(' ').trim()
  switch (command) {
    case 'help':
      await ctx.reply(HELP_TEXT)
      break
    case 'agents':
      await replyAgents(ctx)
      break
    case 'agent':
      await replyAgentBind(ctx, arg)
      break
    case 'sessions':
      await replySessions(ctx)
      break
    case 'new':
      ctx.dispatcher.clearAllSessions(ctx.chatId)
      await ctx.reply('已开启新会话（所有 agent 的上下文都清空）')
      break
    case 'status':
      await replyStatus(ctx)
      break
    case 'stop':
      await replyStop(ctx)
      break
    case 'permission':
      await replyPermission(ctx, arg.toLowerCase())
      break
  }
  return true
}

// ---- /agents ----

async function replyAgents(ctx: CommandContext): Promise<void> {
  const all = ctx.allAgents ?? ctx.agents
  const installed = new Set(ctx.agents.map((a) => a.name))
  const current = ctx.dispatcher.binding(ctx.chatId)?.agentName
  const lines = all.map((a) => {
    const mark = installed.has(a.name) ? '已装' : '未装'
    return `• ${a.name}［${mark}］${a.name === current ? '（当前）' : ''}`
  })
  await ctx.reply([`可用 agent（共 ${all.length} 个）：`, ...lines, '用 /agent <名字> 切换绑定'].join('\n'))
}

// ---- /agent ----

async function replyAgentBind(ctx: CommandContext, name: string): Promise<void> {
  if (name === '') {
    await ctx.reply('用法：/agent <名字>（用 /agents 查看可用列表）')
    return
  }
  const config = ctx.dispatcher.bind(ctx.chatId, name)
  if (config === undefined) {
    await ctx.reply(`未找到 agent ${name}，用 /agents 查看可用列表`)
    return
  }
  await ctx.reply(
    `已绑定 agent「${config.name}」（当前模式：${ctx.dispatcher.modeOf(ctx.chatId)}）；` +
      '切换 agent 会从该 agent 的新会话开始。',
  )
}

// ---- /sessions 与序号选择 ----

interface PendingSelection {
  agentName: string
  items: SessionInfo[]
  onPick(session: SessionInfo | undefined): void | Promise<void>
}

const pendingSelections = new Map<string, PendingSelection>()

/** 该 chat 是否挂着待回复的会话序号选择。 */
export function hasPendingSelection(chatId: string): boolean {
  return pendingSelections.has(chatId)
}

/**
 * 处理会话序号回复：命中（纯数字）即消费选择并触发绑定，返回 true；
 * 无挂起选择或非纯数字文本返回 false（交给审批/命令/提示词管线）。
 * 序号越界也消费，由 onPick 回复越界提示。
 */
export function resolveSelection(chatId: string, text: string): boolean {
  const pending = pendingSelections.get(chatId)
  if (pending === undefined) return false
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return false
  pendingSelections.delete(chatId)
  const n = Number.parseInt(trimmed, 10)
  const picked = n >= 1 && n <= pending.items.length ? pending.items[n - 1] : undefined
  void pending.onPick(picked)
  return true
}

async function replySessions(ctx: CommandContext): Promise<void> {
  const binding = ctx.dispatcher.binding(ctx.chatId)
  const config =
    binding !== undefined ? ctx.agents.find((a) => a.name === binding.agentName) : undefined
  if (binding === undefined || config === undefined) {
    await ctx.reply('尚未绑定 agent，先用 /agents 与 /agent <名字> 绑定')
    return
  }
  if (config.listSessions === undefined) {
    await ctx.reply('该 agent 不支持会话列表')
    return
  }
  const sessions = await ctx.listSessions(config, 10)
  if (sessions.length === 0) {
    await ctx.reply('没有找到历史会话')
    return
  }
  pendingSelections.set(ctx.chatId, {
    agentName: config.name,
    items: sessions,
    onPick: async (picked) => {
      if (picked === undefined) {
        await ctx.reply('序号超出范围，请重新执行 /sessions')
        return
      }
      ctx.dispatcher.setSession(ctx.chatId, config.name, picked.id)
      await ctx.reply(`已切换到会话「${picked.title || picked.id}」`)
    },
  })
  const lines = sessions.map(
    (s, i) => `${i + 1}. ${s.title || s.id}（${relativeTime(s.mtime)}，${s.source}）`,
  )
  await ctx.reply([`${config.name} 的最近会话（回复序号切换）：`, ...lines].join('\n'))
}

function relativeTime(mtime: number): string {
  const diff = Date.now() - mtime
  const minute = 60_000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`
  if (diff < 30 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`
  const d = new Date(mtime)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

// ---- /status ----

function currentAgentConfig(ctx: CommandContext): AgentConfig | undefined {
  const name = ctx.dispatcher.binding(ctx.chatId)?.agentName
  return name === undefined ? undefined : ctx.agents.find((a) => a.name === name)
}

async function replyStatus(ctx: CommandContext): Promise<void> {
  const binding = ctx.dispatcher.binding(ctx.chatId)
  const { running, queued } = ctx.dispatcher.queueInfo(ctx.chatId)
  const queue = running
    ? `运行中${queued > 0 ? `，排队 ${queued}` : ''}`
    : queued > 0
      ? `排队 ${queued}`
      : '空闲'
  // 审批是车道作用域（chatId::agent），pendingCount 与 cancelChat 同一套归属规则
  const pendingApprovals = ctx.approvals.pendingCount(ctx.chatId)
  await ctx.reply(
    [
      '当前状态：',
      `agent：${binding?.agentName ?? '未绑定'}`,
      `会话：${binding?.sessionId !== undefined ? `有（${binding.sessionId}）` : '无'}`,
      `模式：${ctx.dispatcher.modeOf(ctx.chatId)}`,
      `队列：${queue}`,
      `待审批：${pendingApprovals} 项`,
      `发件箱：${ctx.outbox.pending()[ctx.chatId] !== undefined ? '有未发送内容' : '空'}`,
    ].join('\n'),
  )
}

// ---- /stop ----

async function replyStop(ctx: CommandContext): Promise<void> {
  // 回复必须与实际效果一致：真的中止了 / 只有队列 / 什么都没有，三选一
  if (ctx.dispatcher.stop(ctx.chatId)) {
    await ctx.reply('已中止当前任务（队列中的任务会继续）')
    return
  }
  const { queued } = ctx.dispatcher.queueInfo(ctx.chatId)
  if (queued > 0) {
    await ctx.reply(`没有正在运行的任务，队列中的 ${queued} 条任务将继续`)
    return
  }
  await ctx.reply('当前没有运行中的任务')
}

// ---- /permission ----

/** 审批桥可用性说明：当前 agent 支持 permission-prompt-tool 时按模式补充说明。 */
function approvalBridgeNote(config: AgentConfig | undefined, mode: 'auto' | 'full'): string {
  if (config?.approval !== 'permission-prompt-tool') {
    return '（该 agent 不支持审批桥，需要权限确认的操作可能无法自动继续）'
  }
  return mode === 'auto' ? '（审批桥可用：需要权限时会发微信询问你）' : '（full 模式下不启用审批桥）'
}

async function replyPermission(ctx: CommandContext, arg: string): Promise<void> {
  if (arg !== 'auto' && arg !== 'full') {
    if (arg !== '') {
      await ctx.reply('用法：/permission [auto|full]')
      return
    }
    const mode = ctx.dispatcher.modeOf(ctx.chatId)
    await ctx.reply([`当前权限模式：${mode}`, approvalBridgeNote(currentAgentConfig(ctx), mode)].join('\n'))
    return
  }
  ctx.dispatcher.setMode(ctx.chatId, arg)
  await ctx.reply(
    [`已切换到 ${arg} 模式`, approvalBridgeNote(currentAgentConfig(ctx), arg)].join('\n'),
  )
}
