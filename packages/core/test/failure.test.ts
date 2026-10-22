import { describe, expect, test } from 'vitest'
import { explainAgentFailure, formatAgentFailure } from '../src/failure.js'

describe('formatAgentFailure', () => {
  test('dsh 缺模型凭据：翻译成用户能照做的提示', () => {
    const raw = 'agent 执行失败（退出码 1）：dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service'
    const message = formatAgentFailure('dsh', raw)
    expect(message).toContain('dsh')
    expect(message).toContain('没有配置模型凭据')
    expect(message).toContain('deepseek-official')
    expect(message).toContain('配好 API key') // 明确的下一步
    // 仍保留原始错误便于排查，但只留首行
    expect(message).toContain('原始错误')
    expect(message.split('\n').length).toBeLessThanOrEqual(3)
  })

  test('agent 未登录 / key 无效', () => {
    const message = formatAgentFailure('claude', 'Error: Invalid API key · Please run /login')
    expect(message).toContain('未登录或 API key 无效')
    expect(message).toContain('终端')
  })

  test('缺环境变量：直接点名是哪个', () => {
    const message = formatAgentFailure('codex', 'OPENAI_API_KEY is not set')
    expect(message).toContain('OPENAI_API_KEY')
    expect(message).toContain('设置')
  })

  test('命令找不到', () => {
    const message = formatAgentFailure('pi', 'spawn pi ENOENT')
    expect(message).toContain('无法运行')
    expect(message).toContain('PATH')
  })

  test('网络不可达', () => {
    const message = formatAgentFailure('claude', 'fetch failed: getaddrinfo ENOTFOUND api.anthropic.com')
    expect(message).toContain('无法连接')
    expect(message).toContain('网络')
  })

  test('识别不出时保留原文（绝不能把真问题盖掉）', () => {
    const raw = '任务在 30 秒后超时'
    expect(explainAgentFailure(raw)).toBeUndefined()
    expect(formatAgentFailure('claude', raw)).toBe(`任务失败: ${raw}`)
  })

  test('原始错误只取首行、跳过堆栈帧', () => {
    const raw = 'something odd\n    at foo.js:1:1\n    at bar.js:2:2'
    const message = formatAgentFailure('x', raw)
    expect(message).toBe('任务失败: something odd')
  })

  test('过长原文被截断', () => {
    const raw = 'x'.repeat(500)
    expect(formatAgentFailure('a', raw).length).toBeLessThan(260)
  })
})
