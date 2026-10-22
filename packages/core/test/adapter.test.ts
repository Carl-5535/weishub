import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { runAgentTask } from '../src/adapter.js'
import type { AgentConfig } from '../src/types.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'weishub-adapter-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const baseConfig: AgentConfig = {
  name: 'fake',
  detect: 'node',
  run: [process.execPath, '-e', ''],
  passVia: 'stdin',
  outputFormat: 'text',
  resume: ['--resume', '{{sessionId}}'],
  approval: null,
  permissionFlags: { auto: ['--auto-flag'], full: ['--full-flag'] },
  workspace: null,
  timeoutSec: 10,
}

/** 打印 argv（去掉 -e 脚本本体）与收到的 stdin、cwd。
 * 注意：`node -e` 下 process.argv = [execPath, ...用户参数]，且 `--` 之后的参数不会被 node 当作自身选项。 */
const dumpScript = `
let input=''
process.stdin.on('data', d => input += d)
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), input, cwd: process.cwd() }))
})
`

function configWith(outputFormat: AgentConfig['outputFormat'], extraArgv: string[] = []) {
  return {
    ...baseConfig,
    outputFormat,
    run: [process.execPath, '-e', dumpScript, '--', ...extraArgv],
  }
}

test('prompt 经 stdin 到达假 agent 并回显', async () => {
  const result = await runAgentTask(configWith('text'), {
    prompt: '你好，世界',
    mode: 'auto',
    cwd: dir,
  })
  const dumped = JSON.parse(result.text) as { input: string }
  expect(dumped.input).toBe('你好，世界')
  expect(result.exitCode).toBe(0)
})

test('{{sessionId}} 在 argv 中被替换为 options.sessionId', async () => {
  const result = await runAgentTask(configWith('text', ['sid={{sessionId}}', 'tail']), {
    prompt: 'p',
    sessionId: 'sess-42',
    mode: 'auto',
    cwd: dir,
  })
  const dumped = JSON.parse(result.text) as { argv: string[] }
  expect(dumped.argv).toContain('sid=sess-42')
  expect(dumped.argv).not.toContain('sid={{sessionId}}')
  expect(dumped.argv).toContain('tail')
})

test('mode full/auto 分别追加 permissionFlags.full/auto', async () => {
  const full = await runAgentTask(configWith('text'), { prompt: 'p', mode: 'full', cwd: dir })
  expect(JSON.parse(full.text).argv).toContain('--full-flag')
  const auto = await runAgentTask(configWith('text'), { prompt: 'p', mode: 'auto', cwd: dir })
  expect(JSON.parse(auto.text).argv).toContain('--auto-flag')
})

test('cwd 传给子进程', async () => {
  const result = await runAgentTask(configWith('text'), { prompt: 'p', mode: 'auto', cwd: dir })
  // macOS 上 /var 是 /private/var 的符号链接
  const { realpathSync } = await import('node:fs')
  expect(JSON.parse(result.text).cwd).toBe(realpathSync(dir))
})

test('outputFormat claude-json 与 parser 集成：text/sessionId 正确取出', async () => {
  const script = `process.stdout.write(JSON.stringify({ result: '回答内容', session_id: 'sess-7' }))`
  const result = await runAgentTask(
    {
      ...baseConfig,
      outputFormat: 'claude-json',
      run: [process.execPath, '-e', script, '--'],
    },
    {
      prompt: 'p',
      mode: 'auto',
      cwd: dir,
    },
  )
  expect(result.text).toBe('回答内容')
  expect(result.sessionId).toBe('sess-7')
})

test('approval === permission-prompt-tool 且提供 approvalTool 时追加 --mcp-config/--permission-prompt-tool', async () => {
  const cfg = { ...configWith('text'), approval: 'permission-prompt-tool' as const }
  const result = await runAgentTask(cfg, {
    prompt: 'p',
    mode: 'auto',
    cwd: dir,
    approvalTool: { serverConfigPath: '/tmp/mcp.json', toolName: 'approve' },
  })
  const argv = JSON.parse(result.text).argv as string[]
  const i = argv.indexOf('--mcp-config')
  expect(i).toBeGreaterThan(-1)
  expect(argv.slice(i, i + 4)).toEqual([
    '--mcp-config',
    '/tmp/mcp.json',
    '--permission-prompt-tool',
    'approve',
  ])
})

test('approvalTool 未提供或 approval 为 null 时不追加', async () => {
  const cfg = { ...configWith('text'), approval: 'permission-prompt-tool' as const }
  const noTool = await runAgentTask(cfg, { prompt: 'p', mode: 'auto', cwd: dir })
  expect(JSON.parse(noTool.text).argv).not.toContain('--mcp-config')
  const noApproval = await runAgentTask(configWith('text'), {
    prompt: 'p',
    mode: 'auto',
    cwd: dir,
    approvalTool: { serverConfigPath: '/tmp/mcp.json', toolName: 'approve' },
  })
  expect(JSON.parse(noApproval.text).argv).not.toContain('--mcp-config')
})

test('timeoutSec 到期杀进程树：孙进程一并死亡', async () => {
  const pidFile = join(dir, 'grandchild.pid')
  const script = `
const { spawn } = require('child_process')
const fs = require('fs')
const gc = spawn('sleep', ['30'])
fs.writeFileSync(process.argv[1], String(gc.pid))
process.stdout.write('spawned\\n')
setTimeout(() => {}, 30000)
`
  const cfg: AgentConfig = {
    ...baseConfig,
    timeoutSec: 1,
    run: [process.execPath, '-e', script, '--', pidFile],
  }
  const startedAt = Date.now()
  await expect(runAgentTask(cfg, { prompt: 'p', mode: 'auto', cwd: dir })).rejects.toThrow(
    /超时/,
  )
  expect(Date.now() - startedAt).toBeLessThan(5000)
  // 等待进程树被清理
  await new Promise((r) => setTimeout(r, 500))
  const gcPid = Number(await readFile(pidFile, 'utf8'))
  expect(gcPid).toBeGreaterThan(0)
  try {
    process.kill(gcPid, 0)
    expect.unreachable('孙进程仍存活')
  } catch (err) {
    expect((err as NodeJS.ErrnoException).code).toBe('ESRCH')
  }
})

test('外部 signal abort 立即终止', async () => {
  const script = `setTimeout(() => {}, 10000)`
  const cfg: AgentConfig = {
    ...baseConfig,
    timeoutSec: 30,
    run: [process.execPath, '-e', script, '--'],
  }
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 100)
  const startedAt = Date.now()
  await expect(
    runAgentTask(cfg, { prompt: 'p', mode: 'auto', cwd: dir, signal: ac.signal }),
  ).rejects.toThrow(/中止|abort/i)
  expect(Date.now() - startedAt).toBeLessThan(5000)
})

test('非零退出码抛含 stderr 摘要的中文错误', async () => {
  const script = `process.stderr.write('boom 内部错误'); process.exit(3)`
  const cfg: AgentConfig = {
    ...baseConfig,
    run: [process.execPath, '-e', script, '--'],
  }
  await expect(runAgentTask(cfg, { prompt: 'p', mode: 'auto', cwd: dir })).rejects.toThrow(
    /退出码 3.*boom 内部错误/s,
  )
})

test('命令不存在时抛中文错误', async () => {
  const cfg: AgentConfig = { ...baseConfig, run: ['weishub-不存在的命令-xyz'] }
  await expect(runAgentTask(cfg, { prompt: 'p', mode: 'auto', cwd: dir })).rejects.toThrow(/启动|失败/)
})

test('sessionId 缺失时 {{sessionId}} 替换为空串', async () => {
  const result = await runAgentTask(configWith('text', ['sid={{sessionId}}']), {
    prompt: 'p',
    mode: 'auto',
    cwd: dir,
  })
  expect(JSON.parse(result.text).argv).toContain('sid=')
})
