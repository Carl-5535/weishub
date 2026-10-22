import type { AgentConfig } from './types.js'

export interface AgentOutput {
  text: string
  sessionId?: string
}

/**
 * 解析 agent CLI 的 stdout。format 与 AgentConfig.outputFormat 对应：
 * - text：原样返回，无 sessionId
 * - claude-json：单个 JSON 对象，取 result / session_id
 * - codex-jsonl：逐行 JSON 事件流，session id 取自首个含 session_id/thread_id 的事件，
 *   text 取自最后一条 agent_message 消息事件
 */
export function parseAgentOutput(format: AgentConfig['outputFormat'], stdout: string): AgentOutput {
  switch (format) {
    case 'text':
      return parseText(stdout)
    case 'claude-json':
      return parseClaudeJson(stdout)
    case 'codex-jsonl':
      return parseCodexJsonl(stdout)
  }
}

function parseText(stdout: string): AgentOutput {
  if (stdout.trim() === '') {
    throw new Error('解析 agent 输出失败（text）：stdout 为空')
  }
  return { text: stdout }
}

function parseClaudeJson(stdout: string): AgentOutput {
  let obj: unknown
  try {
    obj = JSON.parse(stdout)
  } catch {
    throw new Error(`解析 agent 输出失败（claude-json）：stdout 不是有效 JSON：${excerpt(stdout)}`)
  }
  if (typeof obj !== 'object' || obj === null) {
    throw new Error(`解析 agent 输出失败（claude-json）：stdout 不是 JSON 对象：${excerpt(stdout)}`)
  }
  const { result } = obj as { result?: unknown }
  if (typeof result !== 'string') {
    throw new Error(`解析 agent 输出失败（claude-json）：缺少 result 字段：${excerpt(stdout)}`)
  }
  const sessionId = (obj as { session_id?: unknown }).session_id
  return {
    text: result,
    ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
  }
}

function parseCodexJsonl(stdout: string): AgentOutput {
  let sessionId: string | undefined
  let text: string | undefined
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue // 容忍尾部空行
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue // 畸形行跳过不崩
    }
    if (typeof event !== 'object' || event === null) continue
    const rec = event as Record<string, unknown>
    if (sessionId === undefined) {
      for (const key of ['thread_id', 'session_id'] as const) {
        const value = rec[key]
        if (typeof value === 'string' && value !== '') {
          sessionId = value
          break
        }
      }
    }
    if (
      rec.type === 'item.completed' &&
      typeof rec.item === 'object' &&
      rec.item !== null &&
      (rec.item as Record<string, unknown>).type === 'agent_message'
    ) {
      const itemText = (rec.item as Record<string, unknown>).text
      if (typeof itemText === 'string') text = itemText
    }
  }
  if (text === undefined) {
    throw new Error(
      `解析 agent 输出失败（codex-jsonl）：未找到 agent 消息事件：${excerpt(stdout)}`,
    )
  }
  return { text, ...(sessionId !== undefined ? { sessionId } : {}) }
}

function excerpt(stdout: string): string {
  const head = stdout.trim().slice(0, 200)
  return head === '' ? '(空)' : head
}
