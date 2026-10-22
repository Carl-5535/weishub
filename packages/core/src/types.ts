/** agent 权限模式：auto = 受限自动执行；full = 跳过权限确认。 */
export type PermissionMode = 'auto' | 'full'

/**
 * 单个 agent CLI 的接入配置。run/resume/resumeRun 是 argv 模板，支持 {{sessionId}} 占位。
 *
 * 会话恢复语义（options.sessionId 存在时）：
 * - `resumeRun` 已设置 → 整条命令模板替换为渲染后的 resumeRun（适合 codex 这类 resume 是独立子命令的 CLI）
 * - 否则 `resume` 已设置 → 渲染后的 resume 追加到 run argv 末尾（适合 claude/dsh 这类 flag 式恢复）
 * - 两者都没有 → 只用 run（该 agent 不支持会话恢复）
 */
export interface AgentConfig {
  name: string
  detect: string // PATH 中探测的命令名
  run: string[] // argv 模板，{{sessionId}} 占位
  passVia: 'stdin'
  outputFormat: 'text' | 'claude-json' | 'codex-jsonl' | 'opencode-jsonl' | 'pi-jsonl'
  listSessions?: { store: string; kind: 'claude' | 'codex' } // store 支持 ~ 展开
  resume?: string[] // 追加到 run 末尾，含 {{sessionId}}
  resumeRun?: string[] // 整条替换 run，含 {{sessionId}}
  approval: 'permission-prompt-tool' | 'app-server' | null
  permissionFlags: { auto: string[]; full: string[] }
  workspace?: string | null // null/缺失 = 全局工作目录
  /** 传给子进程的额外环境变量；值支持 {ENV_VAR} 占位（从 hub 进程环境展开），缺失占位展开为空串 */
  env?: Record<string, string>
  timeoutSec: number
}
