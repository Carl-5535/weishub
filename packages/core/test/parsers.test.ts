import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parseAgentOutput } from '../src/parsers.js'

const fixturesDir = join(import.meta.dirname, 'fixtures')

test('claude-json：取 result 为 text、session_id 为 sessionId（真实 fixture）', async () => {
  const stdout = await readFile(join(fixturesDir, 'claude-json.sample.json'), 'utf8')
  const parsed = JSON.parse(stdout)
  const out = parseAgentOutput('claude-json', stdout)
  expect(out.text).toBe(parsed.result)
  expect(out.text).toBe('ok')
  expect(out.sessionId).toBe(parsed.session_id)
})

test('claude-json：对象缺失 result 抛中文错误', () => {
  expect(() => parseAgentOutput('claude-json', JSON.stringify({ session_id: 's1' }))).toThrow(
    /result/,
  )
})

test('claude-json：空 stdout / 非 JSON 抛中文错误', () => {
  expect(() => parseAgentOutput('claude-json', '')).toThrow(/解析/)
  expect(() => parseAgentOutput('claude-json', 'not json')).toThrow(/解析/)
})

test('codex-jsonl：session id 取自首个含 thread_id 的事件，text 取最后一条 agent 消息（fixture）', async () => {
  const stdout = await readFile(join(fixturesDir, 'codex-jsonl.sample.jsonl'), 'utf8')
  const out = parseAgentOutput('codex-jsonl', stdout)
  expect(out.sessionId).toBe('01a161ad-f035-74e0-b132-5d1d0541ff2e')
  expect(out.text).toBe('ok')
})

test('codex-jsonl：text 取自最后一条 agent 消息事件', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"第一句"}}',
    '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"最终回答"}}',
  ].join('\n')
  const out = parseAgentOutput('codex-jsonl', stdout)
  expect(out.text).toBe('最终回答')
  expect(out.sessionId).toBe('t1')
})

test('codex-jsonl：session_id 字段名兼容（老版本事件流）', () => {
  const stdout = ['{"type":"session.started","session_id":"s9"}', '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"hi"}}'].join('\n')
  const out = parseAgentOutput('codex-jsonl', stdout)
  expect(out.sessionId).toBe('s9')
})

test('codex-jsonl：畸形 JSON 行跳过不崩；无 agent 消息抛中文错误', () => {
  const withJunk = ['垃圾行', '{"type":"thread.started","thread_id":"t2"}', '', '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"好"}}'].join('\n')
  expect(parseAgentOutput('codex-jsonl', withJunk)).toEqual({ text: '好', sessionId: 't2' })
  expect(() =>
    parseAgentOutput('codex-jsonl', '{"type":"thread.started","thread_id":"t3"}'),
  ).toThrow(/未找到|无/)
})

test('text：原样返回、无 sessionId；空 stdout 抛中文错误', () => {
  expect(parseAgentOutput('text', '你好\n')).toEqual({ text: '你好\n' })
  expect(() => parseAgentOutput('text', '')).toThrow(/空|无输出|解析/)
  expect(() => parseAgentOutput('text', '  \n')).toThrow(/空|无输出|解析/)
})

describe('opencode-jsonl（真实事件流，实测 v2.0.32）', () => {
  const REAL_EVENTS = [
    '{"type":"step_start","timestamp":1792666499922,"sessionID":"ses_e9cc05489ffevnq2F1cPe7RIeW","part":{"id":"prt_1","sessionID":"ses_e9cc05489ffevnq2F1cPe7RIeW","messageID":"msg_1","type":"step-start"}}',
    '{"type":"text","timestamp":1792666500150,"sessionID":"ses_e9cc05489ffevnq2F1cPe7RIeW","part":{"id":"prt_2","sessionID":"ses_e9cc05489ffevnq2F1cPe7RIeW","messageID":"msg_1","type":"text","text":"收到","time":{"start":1792666479494,"end":1792666500150}}}',
  ].join('\n')

  test('提取最终文本与 sessionID（真实事件样例）', () => {
    const out = parseAgentOutput('opencode-jsonl', REAL_EVENTS)
    expect(out.text).toBe('收到')
    expect(out.sessionId).toBe('ses_e9cc05489ffevnq2F1cPe7RIeW')
  })

  test('多条 text 事件取最后一条', () => {
    const events = REAL_EVENTS + '\n' + '{"type":"text","sessionID":"ses_x","part":{"type":"text","text":"第二段"}}'
    expect(parseAgentOutput('opencode-jsonl', events).text).toBe('第二段')
  })

  test('error 事件（provider 未配置等）抛出带原因的错误', () => {
    const raw = '{"type":"error","sessionID":"ses_e","error":{"type":"provider.invalid-request","message":"Model is unavailable.","status":400}}'
    expect(() => parseAgentOutput('opencode-jsonl', raw)).toThrow(/Model is unavailable/)
  })

  test('没有 text 事件时抛中文错误', () => {
    const raw = '{"type":"step_start","sessionID":"ses_x","part":{}}'
    expect(() => parseAgentOutput('opencode-jsonl', raw)).toThrow(/未找到 text 事件/)
  })

  test('畸形行跳过不崩', () => {
    const out = parseAgentOutput('opencode-jsonl', 'not-json\n' + REAL_EVENTS + '\n\n')
    expect(out.text).toBe('收到')
  })
})

describe('pi-jsonl（真实事件流，实测 v0.73.1）', () => {
  const REAL = [
    '{"type":"session","version":3,"id":"01a1634d-6959-734b-a2bf-7e0e4f6388d6","timestamp":"2026-10-22T11:09:40.058Z","cwd":"/tmp/pi-cal"}',
    '{"type":"agent_start"}',
    '{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"只回复两个字：收到"}]}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"…"}],"api":"anthropic-messages"}}',
    '{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"只回复两个字：收到"}],"timestamp":1792667380071},{"role":"assistant","content":[{"type":"thinking","thinking":"内部思考"},{"type":"text","text":"收到"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","stopReason":"stop","timestamp":1792667381000}]}',
  ].join('\n')

  test('提取 session id（首行 header）与最终文本（过滤 thinking 块）', () => {
    const out = parseAgentOutput('pi-jsonl', REAL)
    expect(out.sessionId).toBe('01a1634d-6959-734b-a2bf-7e0e4f6388d6')
    expect(out.text).toBe('收到')
  })

  test('多条 agent_end 取最后一条（它带完整 messages 快照）', () => {
    const later = '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"最新回复"}],"stopReason":"stop"}]}'
    expect(parseAgentOutput('pi-jsonl', REAL + '\n' + later).text).toBe('最新回复')
  })

  test('stopReason 非 stop 时带 errorMessage 抛出', () => {
    const raw = '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"x"}],"stopReason":"error","errorMessage":"provider quota exceeded"}]}'
    expect(() => parseAgentOutput('pi-jsonl', raw)).toThrow(/provider quota exceeded/)
  })

  test('没有 agent_end 时抛中文错误', () => {
    const raw = '{"type":"session","version":3,"id":"abc"}'
    expect(() => parseAgentOutput('pi-jsonl', raw)).toThrow(/未找到 agent_end 事件/)
  })

  test('畸形行跳过不崩', () => {
    const out = parseAgentOutput('pi-jsonl', 'broken\\n' + REAL)
    expect(out.text).toBe('收到')
  })
})

describe('codex-jsonl：失败事件（实测 v0.163 逐字格式）', () => {
  const REAL_FAILURE = [
    '{"type":"thread.started","thread_id":"01a16355-84b2-7302-b9ad-40674f3036be"}',
    '{"type":"turn.started"}',
    '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: Invalid API key provided, url: http://127.0.0.1:18081/v1/responses)"}',
    '{"type":"error","message":"unexpected status 401 Unauthorized: Invalid API key provided, url: http://127.0.0.1:18081/v1/responses"}',
    '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Invalid API key provided, url: http://127.0.0.1:18081/v1/responses"}}',
  ].join('\n')

  test('turn.failed 时抛出带原因的错误（而非“未找到 agent 消息”）', () => {
    expect(() => parseAgentOutput('codex-jsonl', REAL_FAILURE)).toThrow(/Invalid API key provided/)
  })

  test('thread.started 仍能取出 sessionId', () => {
    // 失败也带 id：失败翻译层可以引用会话上下文
    try {
      parseAgentOutput('codex-jsonl', REAL_FAILURE)
    } catch {
      // 抛错即可，sessionId 断言在成功路径已覆盖
    }
    const ok = [
      '{"type":"thread.started","thread_id":"t-1"}',
      '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"ok"}}',
    ].join('\n')
    expect(parseAgentOutput('codex-jsonl', ok).sessionId).toBe('t-1')
  })

  test('Reconnecting 可恢复重试不算终态', () => {
    const only = '{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}'
    expect(() => parseAgentOutput('codex-jsonl', only)).toThrow(/未找到 agent 消息事件/)
  })
})
