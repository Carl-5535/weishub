#!/usr/bin/env node
/**
 * weishub CLI：进程唯一入口。
 *
 * - `weishub`（或 `weishub serve`）：单实例预检锁 → 旧凭据迁移 → 凭据缺失时
 *   先起 Web 面板等扫码（面板确认写凭据后自动继续）→ startServe 装配并启动
 *   Hub → 写 token/notify-port（wx CLI 的连接配置）→ 起 Web 面板并打印地址。
 * - `weishub login`：终端扫码登录（通道 login()），完成后退出。
 *
 * 等待扫码阶段用「占位 client」的临时 Hub 只承载面板：Hub.start() 对缺凭据
 * 本就处于「等待扫码」空转（不轮询），扫码确认后面板会调用 reloadCredential()
 * ——临时 Hub 随即被丢弃，正式 Hub 由 startServe 以真实凭据重新装配，
 * 因此 client/owner 身份不存在新旧不一致的问题。
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import {
  acquireHubLock,
  dataDir,
  defaultCredentialPath,
  login as terminalLogin,
  migrateLegacyCredential,
  readCredential,
  type ILinkClient,
  type InboundMessage,
} from '@weishub/channel-wechat'
import { discoverAgents, loadAgentConfigs } from '@weishub/core'
import { isEntrypoint } from './entrypoint.js'
import { DEFAULT_NOTIFY_PORT, DEFAULT_WEB_PORT, readHubConfig, resolvePorts } from './config.js'
import { buildHub, startServe, type ServeOptions } from './serve.js'
import { openInBrowser } from './open-browser.js'
import { startWebServer } from './web-server.js'

export function usage(): string {
  return [
    '用法：',
    '  weishub [serve]                启动 hub + Web 面板（无凭据时先在面板扫码登录）',
    '  weishub login                  终端扫码登录后退出',
    '选项：',
    '  --workspace <目录>             全局工作目录（默认取配置文件，否则 ~/weishub-workspace）',
    "  --agents-dir <目录>            agent 配置覆盖目录（默认 ~/.weishub/agents.d）",
    `  --notify-port <端口>           notify API 端口（默认取配置文件，否则 ${DEFAULT_NOTIFY_PORT}）`,
    `  --web-port <端口>              Web 面板端口（默认取配置文件，否则 ${DEFAULT_WEB_PORT}）`,
    '  --help                         显示本帮助',
    '',
    `配置文件：${join(dataDir(), 'config.json')}（{"webPort":8090,"notifyPort":8091,"workspace":"..."}）`,
    '优先级：命令行参数 > 环境变量（WEISHUB_WEB_PORT/WEISHUB_NOTIFY_PORT）> 配置文件 > 内置默认',
  ].join('\n')
}

/** 等待扫码阶段的占位通道原语：任何调用都以中文错误失败（该阶段不轮询、不发送）。 */
function waitingClient(): Pick<ILinkClient, 'poll' | 'sendText' | 'sendMedia' | 'sendTyping'> {
  const fail = (): never => {
    throw new Error('尚未登录微信（等待扫码中）')
  }
  return {
    poll: async (_signal: AbortSignal): Promise<InboundMessage[]> => fail(),
    sendText: async (): Promise<void> => fail(),
    sendMedia: async (): Promise<void> => fail(),
    sendTyping: async (): Promise<void> => fail(),
  }
}

function parsePort(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${label} 必须是 1-65535 的整数`)
  }
  return port
}

/** 凭据读不到（不存在/损坏）都视为未登录，进入扫码流程。 */
async function readCredentialLoose(path: string): Promise<Awaited<ReturnType<typeof readCredential>> | undefined> {
  return readCredential(path).catch(() => undefined)
}

/** 面板地址（token 走查询参数，浏览器直接打开即完成鉴权）。 */
function panelUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${token}`
}

/**
 * serve 主流程：返回退出码。成功后常驻（Ctrl-C / SIGTERM 优雅停止）。
 * helper 形态拆开便于测试注入；options 与 startServe 对齐。
 */
export async function serve(
  options: ServeOptions = {},
  io: { stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream } = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr

  // 单实例预检：正式加锁发生在 hub.start() 内，这里只做尽早的友好报错
  const preflight = await acquireHubLock().catch((error: Error) => error)
  if (preflight instanceof Error) {
    stderr.write(`${preflight.message}\n`)
    return 1
  }
  await preflight.release()

  await migrateLegacyCredential()
  const credentialPath = defaultCredentialPath()
  let credential = await readCredentialLoose(credentialPath)

  // 无凭据：起临时 Hub 只承载 Web 面板等扫码，确认后丢弃并走正式装配
  if (credential === undefined) {
    stderr.write('尚未登录微信：请用手机微信扫码（先打开下方面板地址完成扫码登录）\n')
    const bootstrapToken = randomBytes(32).toString('hex')
    const workspace = options.workspace ?? join(homedir(), 'weishub-workspace')
    const allAgents = await loadAgentConfigs(options.agentsDir)
    const agents = await discoverAgents(allAgents)
    const bootstrap = buildHub({
      client: waitingClient(),
      accountId: '',
      ownerUserId: '',
      agents,
      allAgents,
      workspace,
      notifyPort: options.notifyPort,
      legacyCredentialDir: options.legacyCredentialDir,
    })
    await bootstrap.start()
    const panel = await startWebServer({ hub: bootstrap, token: bootstrapToken, port: options.webPort })
    const bootstrapUrl = panelUrl(panel.port, bootstrapToken)
    stderr.write(`扫码面板：${bootstrapUrl}\n`)
    openInBrowser(bootstrapUrl)
    // 等待扫码期间的 Ctrl-C：也要释放锁（正式的 shutdown 在启动完成后才注册）
    const abortWait = (): void => {
      void (async () => {
        await panel.close().catch(() => undefined)
        await bootstrap.stop()
        process.exit(130)
      })()
    }
    process.once('SIGINT', abortWait)
    process.once('SIGTERM', abortWait)
    try {
      while (credential === undefined) {
        await delay(1_000)
        credential = await readCredentialLoose(credentialPath)
      }
    } finally {
      process.removeListener('SIGINT', abortWait)
      process.removeListener('SIGTERM', abortWait)
      await panel.close().catch(() => undefined)
      await bootstrap.stop()
    }
    stdout.write('扫码成功，正在启动微枢…\n')
  }

  // 正式装配：startServe 读凭据、建真实 ILinkClient 并 start Hub（正式加锁、起 notify api）。
  // bootstrap.stop() 释放锁与 hub.start() 重新加锁之间有缝隙：恰好被别的实例抢锁时重试一次。
  let hub
  try {
    hub = await startServe(options)
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('另一个 weishub 实例正在运行'))) throw error
    await delay(1_000)
    hub = await startServe(options)
  }

  // wx CLI 的连接配置：token 随机 32 字节十六进制；notify-port 取 Hub 实际监听端口
  const token = randomBytes(32).toString('hex')
  const home = dataDir()
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeFile(join(home, 'token'), `${token}\n`, { mode: 0o600 })
  await writeFile(join(home, 'notify-port'), `${hub.notifyPort ?? 0}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') {
    await chmod(join(home, 'token'), 0o600).catch(() => undefined)
    await chmod(join(home, 'notify-port'), 0o600).catch(() => undefined)
  }

  const web = await startWebServer({ hub, token, port: options.webPort })
  const url = panelUrl(web.port, token)
  stdout.write(`微枢已启动。面板地址：${url}\n`)
  stdout.write('微信消息将自动分发给绑定的 agent；按 Ctrl-C 停止。\n')
  // 自动打开面板（WEISHUB_NO_OPEN=1 可关闭）
  if (openInBrowser(url)) stdout.write('已在浏览器打开面板。\n')

  // 优雅停机：先关面板再停 Hub（停 Hub 会释放锁、落盘状态与发件箱断点）
  let stopping = false
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
    void (async () => {
      await web.close().catch(() => undefined)
      await hub.stop()
      process.exit(0)
    })()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return 0
}

/** 终端扫码登录：二维码文本输出到终端，确认后写凭据并退出。 */
export async function loginCommand(
  io: { stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream } = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  try {
    const result = await terminalLogin()
    stdout.write(`登录成功，凭据已写入 ${result.credentialPath}\n`)
    stdout.write('执行 weishub 启动服务。\n')
    return 0
  } catch (error) {
    stderr.write(`登录失败：${(error as Error).message}\n`)
    return 1
  }
}

/** CLI 主逻辑：返回退出码，不直接 process.exit，便于测试。 */
export async function run(argv: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean' },
        workspace: { type: 'string' },
        'agents-dir': { type: 'string' },
        'notify-port': { type: 'string' },
        'web-port': { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${usage()}\n`)
    return 1
  }
  if (parsed.values.help === true) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  const positionals = parsed.positionals
  if (positionals.length > 1 || (positionals[0] !== undefined && positionals[0] !== 'serve' && positionals[0] !== 'login')) {
    process.stderr.write(`${usage()}\n`)
    return 1
  }
  let options: ServeOptions
  try {
    const config = await readHubConfig()
    const ports = resolvePorts(config, {
      webPort: parsePort(stringValue(parsed.values['web-port']), '--web-port'),
      notifyPort: parsePort(stringValue(parsed.values['notify-port']), '--notify-port'),
    })
    options = {
      workspace: stringValue(parsed.values.workspace) ?? config.workspace,
      agentsDir: stringValue(parsed.values['agents-dir']) ?? config.agentsDir,
      notifyPort: ports.notifyPort,
      webPort: ports.webPort,
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }
  try {
    return positionals[0] === 'login' ? await loginCommand() : await serve(options)
  } catch (error) {
    process.stderr.write(`启动失败：${(error as Error).message}\n`)
    return 1
  }
}

/** parseArgs 宽泛 values 中的字符串项（严格模式下单值必为 string）。 */
function stringValue(value: string | boolean | readonly (string | boolean)[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/* 直接以 `node cli.js` 运行时才执行主逻辑；测试 import 本模块时跳过。
   argv[1] 是符号链接（npm 全局 bin）时必须 realpath 后比较，见 ./entrypoint.js。 */
if (isEntrypoint(process.argv[1], import.meta.url)) {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
