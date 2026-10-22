import { spawn, type ChildProcess } from 'node:child_process'
import { parseAgentOutput } from './parsers.js'
import type { AgentConfig, PermissionMode } from './types.js'

export interface RunOptions {
  prompt: string
  sessionId?: string
  mode: PermissionMode
  cwd: string
  /** 发起任务的会话 id，纯透传（审批桥据此注入 WEISHUB_CHAT_ID）；runAgentTask 不做逻辑 */
  chatId?: string
  /** 存在且 config.approval === 'permission-prompt-tool' 时，追加 --mcp-config / --permission-prompt-tool */
  approvalTool?: { serverConfigPath: string; toolName: string }
  signal?: AbortSignal
}

export interface TaskResult {
  text: string
  sessionId?: string
  exitCode: number | null
}

/** 无头执行一个 agent CLI：prompt 走 stdin，argv 模板做 {{sessionId}} 替换，超时/中止杀整个进程树。 */
export async function runAgentTask(
  config: AgentConfig,
  options: RunOptions,
): Promise<TaskResult> {
  const argv = config.run.map((arg) => arg.replaceAll('{{sessionId}}', options.sessionId ?? ''))
  argv.push(...config.permissionFlags[options.mode])
  if (config.approval === 'permission-prompt-tool' && options.approvalTool) {
    argv.push(
      '--mcp-config',
      options.approvalTool.serverConfigPath,
      '--permission-prompt-tool',
      options.approvalTool.toolName,
    )
  }

  return await new Promise<TaskResult>((resolve, reject) => {
    // 已中止的 signal 不会再触发 abort 事件（WHATWG 规范），spawn 前先查一次
    if (options.signal?.aborted) {
      reject(new Error('agent 执行被中止（外部 signal abort）'))
      return
    }
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // posix 下让子进程成为独立进程组，便于整组击杀；win32 用 taskkill /T
      detached: process.platform !== 'win32',
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    // 子进程提前死亡时 stdin 写入会 EPIPE，吞掉避免 unhandled error
    child.stdin.on('error', () => {})

    const timer =
      config.timeoutSec > 0
        ? setTimeout(() => {
            fail(new Error(`agent 执行超时（${config.timeoutSec} 秒），已终止进程树`))
          }, config.timeoutSec * 1000)
        : undefined
    const onAbort = () => fail(new Error('agent 执行被中止（外部 signal abort）'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    // 消除注册前的中止竞态窗口：spawn 与 addEventListener 之间已中止则立即终止
    if (options.signal?.aborted) {
      fail(new Error('agent 执行被中止（外部 signal abort）'))
      return
    }

    function fail(err: Error): void {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      killTree(child)
      reject(err)
    }

    child.on('error', (err) => {
      fail(new Error(`agent 进程启动失败（${argv[0]}）：${err.message}`))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (code !== 0) {
        reject(
          new Error(
            `agent 执行失败（退出码 ${code}）：${stderr.trim() === '' ? '(无 stderr 输出)' : excerpt(stderr)}`,
          ),
        )
        return
      }
      try {
        const parsed = parseAgentOutput(config.outputFormat, stdout)
        resolve({ ...parsed, exitCode: code })
      } catch (err) {
        reject(err as Error)
      }
    })

    child.stdin.write(options.prompt)
    child.stdin.end()
  })
}

/** 杀掉子进程及其全部后代：posix 杀进程组，win32 用 taskkill /T /F。 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    // detached spawn 使 child 成为进程组组长，负 pid 击杀整组（含孙进程）
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // 组已不存在等情形，退化为直接击杀
    child.kill('SIGKILL')
  }
}

function excerpt(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}…`
}
