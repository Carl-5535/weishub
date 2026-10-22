#!/usr/bin/env node
/**
 * wx：出站 CLI。任意 agent 都可以直接 `wx send "文本"` / `wx send --image <path>`
 * / `wx status`，与本地 hub 的 NotifyApi（127.0.0.1）交互推送微信通知。
 *
 * 配置读取：$WEISHUB_HOME（缺省 ~/.weishub）下的 `token` 与 `notify-port`
 * 两个纯文本文件，均由 serve 启动时写入。helper 函数全部导出，便于测试注入。
 */

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { dataDir } from '@weishub/channel-wechat'

/** wx 连接 hub 所需的最小配置。 */
export interface WxConfig {
  token: string
  port: number
}

/** token 或 notify-port 文件缺失（hub 未启动过）。 */
export class MissingConfigError extends Error {
  constructor() {
    super('未找到 hub 令牌，请先启动 weishub')
    this.name = 'MissingConfigError'
  }
}

/** 网络层连不上 hub（连接拒绝等）。 */
export class CannotConnectError extends Error {
  constructor(readonly port: number) {
    super(`无法连接 weishub（127.0.0.1:${port}），请确认 hub 已启动`)
    this.name = 'CannotConnectError'
  }
}

/** hub 返回 HTTP ≥ 400。 */
export class ApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 从 dataDir() 读 token 与 notify-port，任一缺失即抛 MissingConfigError。 */
export async function readWxConfig(): Promise<WxConfig> {
  const home = dataDir()
  const [tokenRaw, portRaw] = await Promise.all([
    readFile(join(home, 'token'), 'utf8').catch(() => null),
    readFile(join(home, 'notify-port'), 'utf8').catch(() => null),
  ])
  if (tokenRaw === null || portRaw === null) throw new MissingConfigError()
  const port = Number(portRaw.trim())
  if (!Number.isInteger(port) || port <= 0) throw new MissingConfigError()
  return { token: tokenRaw.trim(), port }
}

/** 带鉴权请求 hub，返回 JSON body；非 2xx 抛 ApiError，连不上抛 CannotConnectError。 */
async function requestJson(
  cfg: WxConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${cfg.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new CannotConnectError(cfg.port)
  }
  const raw = await res.text()
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(raw)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>
    }
  } catch {
    // 非 JSON body：错误路径下回退到状态码，成功路径下当空 body
  }
  if (!res.ok) {
    const error = typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.status}`
    const note = typeof parsed.note === 'string' ? parsed.note : undefined
    throw new ApiError(note === undefined ? error : `${error}\n${note}`)
  }
  return parsed
}

/** 发送文本：POST /notify {text}。 */
export async function wxSendText(cfg: WxConfig, text: string): Promise<void> {
  await requestJson(cfg, 'POST', '/notify', { text })
}

/** 发送图片：读文件 → POST /notify/image {name, dataBase64}。 */
export async function wxSendImage(cfg: WxConfig, filePath: string): Promise<void> {
  const bytes = await readFile(filePath).catch(() => undefined)
  if (bytes === undefined) throw new ApiError(`无法读取图片文件：${filePath}`)
  await requestJson(cfg, 'POST', '/notify/image', {
    name: basename(filePath),
    dataBase64: bytes.toString('base64'),
  })
}

/** /status 返回的状态快照。 */
export interface WxStatus {
  loggedIn: boolean
  credentialExpiresHint?: string
  pending: number
}

/** 查询 hub 状态：GET /status。 */
export async function wxStatus(cfg: WxConfig): Promise<WxStatus> {
  const body = await requestJson(cfg, 'GET', '/status')
  return {
    loggedIn: body.loggedIn === true,
    credentialExpiresHint:
      typeof body.credentialExpiresHint === 'string' ? body.credentialExpiresHint : undefined,
    pending: typeof body.pending === 'number' ? body.pending : 0,
  }
}

/** 状态的人类可读中文摘要。 */
export function formatStatus(status: WxStatus): string {
  const lines = [
    `微信登录：${status.loggedIn ? '已登录' : '未登录'}`,
    `发件箱待发：${status.pending} 条`,
  ]
  if (status.credentialExpiresHint !== undefined) {
    lines.push(`凭据提示：${status.credentialExpiresHint}`)
  }
  return lines.join('\n')
}

export function usage(): string {
  return [
    '用法：',
    '  wx send "文本"         发送文本到微信',
    '  wx send --image <路径>  发送图片文件',
    '  wx status              查看登录状态与发件箱',
  ].join('\n')
}

const printError = (message: string): void => {
  console.error(message)
}

/** CLI 主逻辑：返回退出码（0/1），不直接 process.exit，便于测试。 */
export async function run(argv: readonly string[]): Promise<number> {
  let positionals: string[]
  let image: string | undefined
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: { image: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    })
    positionals = parsed.positionals
    image = parsed.values.image
  } catch {
    printError(usage())
    return 1
  }

  const command = positionals[0]
  try {
    if (command === 'send') {
      const extra = positionals.slice(1)
      if (image !== undefined) {
        if (extra.length > 0) {
          printError(usage())
          return 1
        }
        await wxSendImage(await readWxConfig(), image)
        return 0
      }
      if (extra.length !== 1) {
        printError(usage())
        return 1
      }
      await wxSendText(await readWxConfig(), extra[0]!)
      return 0
    }
    if (command === 'status') {
      if (positionals.length !== 1 || image !== undefined) {
        printError(usage())
        return 1
      }
      console.log(formatStatus(await wxStatus(await readWxConfig())))
      return 0
    }
    printError(usage())
    return 1
  } catch (err) {
    if (err instanceof MissingConfigError || err instanceof CannotConnectError || err instanceof ApiError) {
      printError(err.message)
      return 1
    }
    throw err
  }
}

/* 直接以 `node wx.js` 运行时才执行主逻辑；测试 import 本模块时跳过。 */
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
