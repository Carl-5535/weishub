import { execSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { startNotifyApi, type NotifyDeps } from '@weishub/core'
import { Outbox, type ILinkClient, type InboundMessage } from '@weishub/channel-wechat'
import { Hub, type HubDeps } from '../src/inbound.js'
import type { AgentConfig, RunOptions, TaskResult } from '@weishub/core'

const repoRoot = resolve(import.meta.dirname, '../../..')
const scriptPath = resolve(repoRoot, 'packages/weishub/lib/wx.js')
const TOKEN = 'wx-test-token'
const OWNER = 'owner-chat'

let api: { port: number; close(): Promise<void> }
let home: string
let sentText: string[]
let sentImages: Array<{ name: string; bytes: Uint8Array }>
let outbox: Outbox
/** 置 true 后下一次 sendText/sendImage 抛错（模拟通道未就绪 → 503），之后自动恢复 */
let failing: boolean

beforeAll(async () => {
  // 测试必须跑真实编译产物进程，先确保 lib/wx.js 存在
  execSync('npx tsc -b packages/weishub', { cwd: repoRoot, stdio: 'pipe' })
  sentText = []
  sentImages = []
  failing = false
  const deps: NotifyDeps = {
    token: TOKEN,
    ownerChatId: OWNER,
    sendText: async (text) => {
      if (failing) {
        failing = false
        throw new Error('未登录')
      }
      sentText.push(text)
    },
    sendImage: async (name, bytes) => {
      if (failing) {
        failing = false
        throw new Error('未登录')
      }
      sentImages.push({ name, bytes })
    },
    outbox: new Outbox({
      send: async () => {
        throw new Error('通道不可用')
      },
      sendFile: async () => {
        throw new Error('通道不可用')
      },
      maxChars: 100,
      maxRetries: 0,
      retryDelayMs: 1,
    }),
  }
  outbox = deps.outbox
  api = await startNotifyApi({ ...deps, port: 0 })
  home = await mkdtemp(join(tmpdir(), 'wx-home-'))
  await writeFile(join(home, 'token'), TOKEN)
  await writeFile(join(home, 'notify-port'), String(api.port))
})

afterAll(() => api.close())

interface WxResult {
  code: number
  stdout: string
  stderr: string
}

/** spawn 真实 wx 进程，收集退出码与 stdout/stderr */
function runWx(args: string[], homeDir: string = home): Promise<WxResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('node', [scriptPath, ...args], {
      env: { ...process.env, WEISHUB_HOME: homeDir },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`wx 进程超时，stderr: ${stderr}`))
    }, 10_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      rejectPromise(err)
    })
  })
}

test('wx send "hi" 使 sendText 收到 "hi"，exit 0', async () => {
  const result = await runWx(['send', '你好，微枢'])
  expect(result.code).toBe(0)
  expect(sentText).toContain('你好，微枢')
})

test('wx send --image <path> 走 /notify/image 且字节一致，exit 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-img-'))
  const imgPath = join(dir, 'shot.png')
  // 伪 PNG：随机字节足够验证 base64 往返
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256)
  await writeFile(imgPath, bytes)
  const result = await runWx(['send', '--image', imgPath])
  expect(result.code).toBe(0)
  const last = sentImages.at(-1)
  expect(last).toBeDefined()
  expect(last!.name).toBe('shot.png')
  expect(Buffer.from(last!.bytes).equals(Buffer.from(bytes))).toBe(true)
})

test('wx status 输出登录状态与发件箱条数，exit 0', async () => {
  const result = await runWx(['status'])
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('未登录')
  expect(result.stdout).toContain('0 条')
})

test('服务端 503 时 stderr 输出中文错误（含 note）且 exit 1', async () => {
  // 图片路径：503 带 error + note
  failing = true
  const dir = mkdtempSync(join(tmpdir(), 'wx-img-'))
  const imgPath = join(dir, 'fail.png')
  await writeFile(imgPath, Buffer.from([1, 2, 3]))
  const imageResult = await runWx(['send', '--image', imgPath])
  expect(imageResult.code).toBe(1)
  expect(imageResult.stderr).toContain('微信通道未就绪')
  expect(imageResult.stderr).toContain('图片未入队，请重试')
  // 文本路径：503 只带 error，内容应同步入发件箱（凭据过期不丢内容）
  failing = true
  const textResult = await runWx(['send', '会失败的一条'])
  expect(textResult.code).toBe(1)
  expect(textResult.stderr).toContain('微信通道未就绪')
  const pending = Object.values(outbox.pending())
  expect(pending.some((item) => item.chunks.includes('会失败的一条'))).toBe(true)
})

test('缺 token 文件时输出精确提示且 exit 1', async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'wx-empty-'))
  const result = await runWx(['send', 'hi'], emptyHome)
  expect(result.code).toBe(1)
  expect(result.stderr.trim()).toBe('未找到 hub 令牌，请先启动 weishub')
})

test('编译产物首行是 shebang（npm i -g 后 wx 可执行的前提）', async () => {
  expect(readFileSync(scriptPath, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node')
})

test('无参数或未知旗标 → 用法文本 exit 1', async () => {
  const noArgs = await runWx([])
  expect(noArgs.code).toBe(1)
  expect(noArgs.stderr).toContain('wx send')
  const badFlag = await runWx(['send', 'hi', '--bogus'])
  expect(badFlag.code).toBe(1)
  expect(badFlag.stderr).toContain('wx send')
})

const HUB_TOKEN = 'hub-side-token'

test('端到端接线：token 文件里的 hub notify token 能通过真实 notify API 认证', async () => {
  // 独立 WEISHUB_HOME：凭据、锁、状态都落在临时目录
  const hubHome = await mkdtemp(join(tmpdir(), 'wx-hub-home-'))
  const prevHome = process.env.WEISHUB_HOME
  process.env.WEISHUB_HOME = hubHome
  try {
    // 凭据文件（hub.start 需要）：内容合法且权限 0600
    await writeFile(join(hubHome, 'account.json'), JSON.stringify({
      accountId: 'bot-1', token: 'tok', apiBase: 'https://127.0.0.1:1', savedAt: new Date().toISOString(),
    }), { mode: 0o600 })
    await chmod(join(hubHome, 'account.json'), 0o600)

    const sent: string[] = []
    const agent: AgentConfig = {
      name: 'claude', detect: 'claude', run: ['claude', '-p'], passVia: 'stdin',
      outputFormat: 'claude-json', approval: null, permissionFlags: { auto: [], full: [] },
      workspace: null, timeoutSec: 10,
    }
    const fail = (): never => { throw new Error('测试中不应真正轮询') }
    const client: Pick<ILinkClient, 'poll' | 'checkpoint' | 'sendText' | 'sendMedia' | 'sendTyping'> = {
      poll: async (_signal: AbortSignal): Promise<InboundMessage[]> => new Promise<InboundMessage[]>(() => {}),
      checkpoint: async () => {},
      sendText: async (_chatId: string, text: string) => { sent.push(text) },
      sendMedia: async () => {},
      sendTyping: async () => {},
    }
    void fail
    const deps: HubDeps = {
      client,
      accountId: 'bot-1',
      ownerUserId: OWNER,
      agents: [agent],
      allAgents: [agent],
      workspace: await mkdtemp(join(tmpdir(), 'wx-hub-ws-')),
      notifyToken: HUB_TOKEN,
      notifyPort: 0,
    }
    const hub = new Hub(deps)
    await hub.start()
    try {
      // cli.ts 的写法：token 文件写 hub 暴露的 notify token，port 写 hub 实际端口
      await writeFile(join(hubHome, 'token'), `${hub.notifyToken}\n`, { mode: 0o600 })
      await writeFile(join(hubHome, 'notify-port'), `${hub.notifyPort}\n`, { mode: 0o600 })

      const result = await runWx(['send', '走真实 hub'], hubHome)
      expect(result.code).toBe(0)
      expect(sent).toContain('走真实 hub')

      // 反向：写一个不匹配的 token 就必须 401（防止测试假阳性）
      await writeFile(join(hubHome, 'token'), 'wrong-token\n', { mode: 0o600 })
      const bad = await runWx(['send', '不该发出'], hubHome)
      expect(bad.code).toBe(1)
      expect(bad.stderr).toContain('401')
      expect(sent).not.toContain('不该发出')
    } finally {
      await hub.stop()
    }
  } finally {
    if (prevHome === undefined) delete process.env.WEISHUB_HOME
    else process.env.WEISHUB_HOME = prevHome
  }
}, 20_000)
