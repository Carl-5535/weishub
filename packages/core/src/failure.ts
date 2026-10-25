/**
 * agent 失败信息的用户化翻译。
 *
 * 用户装好了 agent 但没配好它自己的凭据/模型时，CLI 会吐出一大段英文原文
 * （stderr 堆栈、provider 路由名、环境变量名）。直接转给微信用户既看不懂、
 * 也不知道该做什么。
 *
 * 这里把常见的「配置缺失」类失败识别出来，翻译成一句人话 + 一个明确的下一步。
 * 识别不出来的原样保留——宁可显示原文，也不能把真正的问题盖掉。
 */

export interface AgentFailureHint {
  /** 一句话说明哪里没配好 */
  summary: string
  /** 具体该做什么 */
  action?: string
}

/** 各类「配置缺失」的特征。顺序有意义：更具体的在前。 */
const PATTERNS: { test: RegExp; hint: (m: RegExpMatchArray) => AgentFailureHint }[] = [
  {
    // codex: ~/.codex/config.toml 损坏 / 引用了不存在的文件（实测报 "Error: No such file or directory"）
    // 只认明确上下文：裸 config.toml 会把任务输出里恰好提到该文件名的错误（如
    // ENOENT /proj/config.toml.bak）误判成「codex 配置有问题」。
    test: /Error loading config\.toml|config\.toml[^\n]*(No such file or directory|not found|invalid|损坏|无法)/i,
    hint: () => ({
      summary: 'codex 的配置文件（~/.codex/config.toml）有问题',
      action: '修复或重命名该文件后重试（0.163 已移除 wire_api="chat"，旧配置需要更新）',
    }),
  },
  {
    // codex: provider 无 /responses 端点（实测 zhipu 404）
    test: /unexpected status 404 Not Found/i,
    hint: () => ({
      summary: 'codex 配置的 provider 不支持 responses 接口',
      action: '换一个支持 /responses 的 provider，或改用 OpenAI 官方端点',
    }),
  },
  {
    // codex: 401（实测 5 次重连后 turn.failed）
    test: /unexpected status 401 Unauthorized/i,
    hint: () => ({
      summary: 'codex 的 API key 无效',
      action: '运行 codex login 重新登录，或检查 ~/.codex/auth.json',
    }),
  },
  {
    // dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
    test: /MISSING_CREDENTIAL|no API key for provider route\s*"([^"]+)"/i,
    hint: (m) => ({
      summary: `dsh 没有配置模型凭据${m[1] === undefined ? '' : `（provider: ${m[1]}）`}`,
      action: '先按 dsh 的文档配好 API key（或改用它已配置的 provider），再回到这里重试',
    }),
  },
  {
    // pi: "No API key found for the selected model. Use /login to log into a provider via OAuth or API key."
    test: /No API key found for the selected model/i,
    hint: () => ({
      summary: 'pi 没有配置任何 provider 的 API key',
      action: '设置一个 key（如 ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY，见 pi --help 尾部）后重试',
    }),
  },
  {
    // Claude Code 未登录
    test: /(not logged in|please run \/login|invalid api key|authentication_error|credit balance)/i,
    hint: () => ({
      summary: 'agent 未登录或 API key 无效',
      action: '在终端里单独运行一次该 agent 完成登录/配置，再回来重试',
    }),
  },
  {
    // 通用：环境变量缺失
    test: /([A-Z][A-Z0-9_]*_API_KEY)\b[^\n]*(missing|not set|未设置|required)/i,
    hint: (m) => ({
      summary: `缺少环境变量 ${m[1]}`,
      action: `设置 ${m[1]} 后重启微枢（或写进该 agent 自己的配置文件）`,
    }),
  },
  {
    // 命令不存在 / 不可执行
    test: /(command not found|ENOENT|not executable|permission denied)/i,
    hint: () => ({
      summary: 'agent 可执行文件无法运行',
      action: '确认它已正确安装并在 PATH 上，然后重启微枢重新探测',
    }),
  },
  {
    // 网络 / 服务端不可达
    test: /(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|getaddrinfo|Connection failed)/i,
    hint: () => ({
      summary: 'agent 无法连接到它的服务端',
      action: '检查网络或代理设置后重试',
    }),
  },
]

/**
 * 把原始失败文本翻译成用户能照做的提示。
 * 未识别时返回 undefined，调用方保留原文。
 */
export function explainAgentFailure(raw: string): AgentFailureHint | undefined {
  for (const { test, hint } of PATTERNS) {
    const match = test.exec(raw)
    if (match !== null) return hint(match)
  }
  return undefined
}

/**
 * 生成给用户看的失败消息。
 * 识别成功时给「摘要 + 下一步 + 折叠的原始首行」；否则保留原文摘要。
 */
export function formatAgentFailure(agentName: string, raw: string): string {
  const hint = explainAgentFailure(raw)
  if (hint !== undefined) {
    const lines = [`「${agentName}」暂时跑不起来：${hint.summary}。`]
    if (hint.action !== undefined) lines.push(hint.action + '。')
    lines.push(`（原始错误：${firstMeaningfulLine(raw)}）`)
    return lines.join('\n')
  }
  // 未识别也要收敛：只留首行有效内容并截断，避免把整段 stderr 堆栈甩给用户
  return `任务失败: ${firstMeaningfulLine(raw)}`
}

/** 取原文里最有信息量的一行（跳过空行、纯堆栈帧、以及各 CLI 的固定 stderr 噪声）。 */
function firstMeaningfulLine(raw: string): string {
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    if (text.startsWith('at ')) continue
    // codex/pi 每次运行都往 stderr 打的固定噪声，留着只会盖住真正的错误
    if (/^Reading (additional )?prompt from stdin\.\.\.$/.test(text)) continue
    return text.length > 200 ? `${text.slice(0, 200)}…` : text
  }
  return '（无输出）'
}
