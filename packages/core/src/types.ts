/** agent 权限模式：auto = 受限自动执行；full = 跳过权限确认。 */
export type PermissionMode = 'auto' | 'full'

/**
 * 单个 agent CLI 的接入配置。run/resume 是 argv 模板，支持 {{sessionId}} 占位。
 */
export interface AgentConfig {
  name: string
  detect: string // PATH 中探测的命令名
  run: string[] // argv 模板，{{sessionId}} 占位
  passVia: 'stdin'
  outputFormat: 'text' | 'claude-json' | 'codex-jsonl'
  listSessions?: { store: string; kind: 'claude' | 'codex' } // store 支持 ~ 展开
  resume: string[] // 含 {{sessionId}}
  approval: 'permission-prompt-tool' | 'app-server' | null
  permissionFlags: { auto: string[]; full: string[] }
  workspace?: string | null // null/缺失 = 全局工作目录
  timeoutSec: number
}
