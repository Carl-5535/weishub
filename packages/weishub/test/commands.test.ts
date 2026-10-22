import { expect, test, vi } from 'vitest'
import { ApprovalRouter, ChatDispatcher } from '@weishub/core'
import type { AgentConfig, SessionInfo } from '@weishub/core'
import { Outbox } from '@weishub/channel-wechat'
import {
  handleCommand,
  hasPendingSelection,
  resolveSelection,
  type CommandContext,
} from '../src/commands.js'

const agentClaude: AgentConfig = {
  name: 'claude',
  detect: 'claude',
  run: ['claude', '-p'],
  passVia: 'stdin',
  outputFormat: 'claude-json',
  listSessions: { store: '~/.claude/projects', kind: 'claude' },
  resume: ['--resume', '{{sessionId}}'],
  approval: null,
  permissionFlags: { auto: [], full: ['--dangerously-skip-permissions'] },
  workspace: null,
  timeoutSec: 10,
}

const agentCodex: AgentConfig = { ...agentClaude, name: 'codex', detect: 'codex' }
const agentGemini: AgentConfig = { ...agentClaude, name: 'gemini', detect: 'gemini', listSessions: undefined }

function makeDispatcher(agents: AgentConfig[] = [agentClaude, agentCodex]): ChatDispatcher {
  return new ChatDispatcher({
    agents,
    run: async () => new Promise(() => {}), // 挂起不落定：让 busy/stop 测试可控
    cwdFor: () => '/tmp',
    onReply: async () => {},
  })
}

interface CtxKit {
  ctx: CommandContext
  sent: string[]
  dispatcher: ChatDispatcher
}

function makeCtx(overrides: Partial<CommandContext> = {}, dispatcher = makeDispatcher()): CtxKit {
  const sent: string[] = []
  const ctx: CommandContext = {
    chatId: 'owner-1',
    dispatcher,
    approvals: new ApprovalRouter(),
    outbox: new Outbox({
      // 挂起的 send 使 enqueue 的内容停留在发件箱，供 /status 断言
      send: async () => new Promise(() => {}),
      sendFile: async () => {},
      maxChars: 2000,
    }),
    agents: [agentClaude, agentCodex],
    allAgents: [agentClaude, agentCodex, agentGemini],
    listSessions: async () => [],
    reply: async (text) => {
      sent.push(text)
    },
    ...overrides,
  }
  return { ctx, sent, dispatcher }
}

/** 放行全部微任务与定时器回调：resolveSelection 的 onPick 是 fire-and-forget */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const sessions: SessionInfo[] = [
  { id: 's-1', title: '第一个会话', mtime: Date.now() - 2 * 60_000, source: 'hub' },
  { id: 's-2', title: 'IDE 会话', mtime: Date.now() - 3 * 3_600_000, source: 'ide' },
]

// ---- /agents ----

test('/agents 列出全部配置 agent 并标记已装/未装', async () => {
  const { ctx, sent } = makeCtx()
  expect(await handleCommand('/agents', ctx)).toBe(true)
  const text = sent.join('\n')
  expect(text).toContain('claude')
  expect(text).toContain('已装')
  expect(text).toContain('gemini')
  expect(text).toContain('未装')
})

// ---- /agent ----

test('/agent claude 绑定成功：回复含 agent 名与模式，绑定生效', async () => {
  const { ctx, sent, dispatcher } = makeCtx()
  expect(await handleCommand('/agent claude', ctx)).toBe(true)
  expect(dispatcher.binding('owner-1')?.agentName).toBe('claude')
  const text = sent.join('\n')
  expect(text).toContain('claude')
  expect(text).toContain('auto')
})

test('/agent 不存在的名字回复「未找到」且不产生绑定', async () => {
  const { ctx, sent, dispatcher } = makeCtx()
  expect(await handleCommand('/agent gemini', ctx)).toBe(true)
  expect(dispatcher.binding('owner-1')).toBeUndefined()
  expect(sent.join('\n')).toContain('未找到 agent gemini')
  expect(sent.join('\n')).toContain('/agents')
})

// ---- /sessions ----

test('/sessions 列出序号+标题+相对时间+来源，并登记一次性序号选择', async () => {
  const { ctx, sent, dispatcher } = makeCtx({ listSessions: async () => sessions })
  dispatcher.bind('owner-1', 'claude')
  expect(await handleCommand('/sessions', ctx)).toBe(true)
  const text = sent.join('\n')
  expect(text).toContain('1. 第一个会话')
  expect(text).toContain('2 分钟前')
  expect(text).toContain('2. IDE 会话')
  expect(text).toContain('ide')
  expect(hasPendingSelection('owner-1')).toBe(true)
  expect(dispatcher.binding('owner-1')?.sessionId).toBeUndefined()

  // 回复序号 2 → 绑定 s-2，选择消费掉
  expect(resolveSelection('owner-1', '2')).toBe(true)
  await flush()
  expect(dispatcher.binding('owner-1')?.sessionId).toBe('s-2')
  expect(sent.join('\n')).toContain('已切换')
  expect(hasPendingSelection('owner-1')).toBe(false)
})

test('/sessions 序号越界：选择被消费且回复越界提示，不绑定', async () => {
  const { ctx, sent, dispatcher } = makeCtx({ listSessions: async () => sessions })
  dispatcher.bind('owner-1', 'claude')
  await handleCommand('/sessions', ctx)
  expect(resolveSelection('owner-1', '9')).toBe(true)
  await flush()
  expect(dispatcher.binding('owner-1')?.sessionId).toBeUndefined()
  expect(sent.join('\n')).toContain('超出范围')
  expect(hasPendingSelection('owner-1')).toBe(false)
})

test('/sessions 待选择时非数字回复不消费选择', async () => {
  const { ctx } = makeCtx({ listSessions: async () => sessions })
  ctx.dispatcher.bind('owner-1', 'claude')
  await handleCommand('/sessions', ctx)
  expect(resolveSelection('owner-1', '帮我看看日志')).toBe(false)
  expect(hasPendingSelection('owner-1')).toBe(true)
})

test('/sessions 无挂起选择时 resolveSelection 返回 false', () => {
  expect(resolveSelection('other-chat', '1')).toBe(false)
})

test('/sessions agent 无会话存储时回复不支持', async () => {
  const { ctx, sent } = makeCtx()
  ctx.dispatcher.bind('owner-1', 'codex')
  const codexOnly: AgentConfig = { ...agentCodex, listSessions: undefined }
  ctx.agents.splice(0, ctx.agents.length, codexOnly)
  await handleCommand('/sessions', ctx)
  expect(sent.join('\n')).toContain('该 agent 不支持会话列表')
})

// ---- /new ----

test('/new 清除 sessionId 并回复已开启新会话', async () => {
  const { ctx, sent, dispatcher } = makeCtx()
  dispatcher.bind('owner-1', 'claude')
  dispatcher.setSession('owner-1', 'old-session')
  expect(await handleCommand('/new', ctx)).toBe(true)
  expect(dispatcher.binding('owner-1')?.sessionId).toBeUndefined()
  expect(sent.join('\n')).toContain('已开启新会话')
})

// ---- /permission ----

test('/permission 无参显示当前模式', async () => {
  const { ctx, sent } = makeCtx()
  await handleCommand('/permission', ctx)
  expect(sent.join('\n')).toContain('auto')
})

test('/permission full 切换模式并确认（含审批桥说明），auto 可切回', async () => {
  const claudeWithBridge: AgentConfig = { ...agentClaude, approval: 'permission-prompt-tool' }
  const { ctx, sent, dispatcher } = makeCtx()
  dispatcher.bind('owner-1', 'claude')
  ctx.agents.splice(0, ctx.agents.length, claudeWithBridge)
  expect(await handleCommand('/permission full', ctx)).toBe(true)
  expect(dispatcher.modeOf('owner-1')).toBe('full')
  const text = sent.join('\n')
  expect(text).toContain('full')
  expect(text).toContain('审批桥')
  await handleCommand('/permission auto', ctx)
  expect(dispatcher.modeOf('owner-1')).toBe('auto')
})

test('/permission 非法参数回复用法且不改模式', async () => {
  const { ctx, sent, dispatcher } = makeCtx()
  await handleCommand('/permission yolo', ctx)
  expect(dispatcher.modeOf('owner-1')).toBe('auto')
  expect(sent.join('\n')).toContain('/permission')
})

// ---- /status ----

test('/status 汇报 agent、会话、模式、队列、待审批与发件箱', async () => {
  const { ctx, sent, dispatcher } = makeCtx()
  dispatcher.bind('owner-1', 'claude')
  dispatcher.setSession('owner-1', 'sess-9')
  ctx.approvals.startRequest('owner-1', 'Bash', '{}')
  ctx.outbox.enqueue('owner-1', '一条待发内容')
  expect(await handleCommand('/status', ctx)).toBe(true)
  const text = sent.join('\n')
  expect(text).toContain('claude')
  expect(text).toContain('sess-9')
  expect(text).toContain('auto')
  expect(text).toContain('待审批')
  expect(text).toContain('发件箱')
})

// ---- /stop ----

test('/stop 无任务时回复当前没有运行中的任务', async () => {
  const { ctx, sent } = makeCtx()
  expect(await handleCommand('/stop', ctx)).toBe(true)
  expect(sent.join('\n')).toContain('当前没有运行中的任务')
})

test('/stop 运行中时中止并回复已中止当前任务', async () => {
  const { ctx, sent, dispatcher } = makeCtx()
  dispatcher.bind('owner-1', 'claude')
  dispatcher.submit('owner-1', '长任务')
  await vi.waitFor(() => expect(dispatcher.busy('owner-1')).toBe(true))
  expect(await handleCommand('/stop', ctx)).toBe(true)
  expect(sent.join('\n')).toContain('已中止当前任务')
})

// ---- 别名、大小写、未知与非命令 ----

test('大小写不敏感：/HELP 与 /Status 都可用', async () => {
  const { ctx, sent } = makeCtx()
  expect(await handleCommand('/HELP', ctx)).toBe(true)
  expect(sent.join('\n')).toContain('/help')
  expect(await handleCommand('/Status', ctx)).toBe(true)
  expect(sent.join('\n')).toContain('agent')
})

test('中文别名：/帮助、/状态、/停止、/新会话、/权限', async () => {
  const { ctx, sent, dispatcher } = makeCtx()
  dispatcher.bind('owner-1', 'claude')
  dispatcher.setSession('owner-1', 's-old')
  await handleCommand('/帮助', ctx)
  expect(sent.join('\n')).toContain('/help')
  await handleCommand('/状态', ctx)
  expect(sent.join('\n')).toContain('claude')
  await handleCommand('/新会话', ctx)
  expect(dispatcher.binding('owner-1')?.sessionId).toBeUndefined()
  await handleCommand('/权限', ctx)
  expect(sent.join('\n')).toContain('auto')
  await handleCommand('/停止', ctx)
  expect(sent.join('\n')).toContain('当前没有运行中的任务')
})

test('未知命令 /xx 回复未知命令并附 /help，消费输入', async () => {
  const { ctx, sent } = makeCtx()
  expect(await handleCommand('/xx', ctx)).toBe(true)
  const text = sent.join('\n')
  expect(text).toContain('未知命令')
  expect(text).toContain('/help')
})

test('非 / 开头文本返回 false 且不回复', async () => {
  const { ctx, sent } = makeCtx()
  expect(await handleCommand('你好跑个任务', ctx)).toBe(false)
  expect(sent).toHaveLength(0)
})
