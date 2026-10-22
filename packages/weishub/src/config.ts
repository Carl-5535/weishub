/**
 * hub 配置文件：`$WEISHUB_HOME/config.json`（默认 ~/.weishub/config.json）。
 *
 * 优先级：命令行参数 > 配置文件 > 内置默认值。
 * 端口也可由环境变量覆盖（WEISHUB_WEB_PORT / WEISHUB_NOTIFY_PORT），
 * 便于临时起多套实例做测试。
 */

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { dataDir, pathExists } from '@weishub/channel-wechat'

/** 内置默认端口：面板固定 8090，notify API 固定 8091（两者不冲突）。 */
export const DEFAULT_WEB_PORT = 8090
export const DEFAULT_NOTIFY_PORT = 8091

export interface HubConfig {
  webPort: number
  notifyPort: number
  workspace?: string
  agentsDir?: string
}

function envPort(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 && value < 65_536 ? value : undefined
}

function filePort(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value >= 65_536) {
    throw new Error(`配置文件 ${field} 必须是 1-65535 的整数`)
  }
  return value
}

/** 读取配置文件；不存在返回空对象，形态非法抛中文错误（端口写错必须响亮失败）。 */
export async function readHubConfig(path = join(dataDir(), 'config.json')): Promise<HubConfig> {
  if (!await pathExists(path)) return { webPort: DEFAULT_WEB_PORT, notifyPort: DEFAULT_NOTIFY_PORT }
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`配置文件 ${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`配置文件 ${path} 必须包含一个 JSON 对象`)
  }
  const value = raw as Record<string, unknown>
  const webPort = filePort(value.webPort, 'webPort') ?? DEFAULT_WEB_PORT
  const notifyPort = filePort(value.notifyPort, 'notifyPort') ?? DEFAULT_NOTIFY_PORT
  if (webPort === notifyPort) throw new Error(`配置文件 ${path} 的 webPort 与 notifyPort 不能相同`)
  const workspace = typeof value.workspace === 'string' && value.workspace !== '' ? value.workspace : undefined
  const agentsDir = typeof value.agentsDir === 'string' && value.agentsDir !== '' ? value.agentsDir : undefined
  return { webPort, notifyPort, workspace, agentsDir }
}

/** 合并优先级：显式参数 > 环境变量 > 配置文件。 */
export function resolvePorts(
  config: HubConfig,
  overrides: { webPort?: number; notifyPort?: number } = {},
): { webPort: number; notifyPort: number } {
  const webPort = overrides.webPort ?? envPort('WEISHUB_WEB_PORT') ?? config.webPort
  const notifyPort = overrides.notifyPort ?? envPort('WEISHUB_NOTIFY_PORT') ?? config.notifyPort
  if (webPort === notifyPort) throw new Error('webPort 与 notifyPort 不能相同')
  return { webPort, notifyPort }
}

/** 默认配置文件内容（首次启动时可用 weishub config --init 生成）。 */
export function defaultConfigJson(): string {
  return `${JSON.stringify({
    webPort: DEFAULT_WEB_PORT,
    notifyPort: DEFAULT_NOTIFY_PORT,
    workspace: join(process.env.HOME ?? '', 'weishub-workspace'),
  }, null, 2)}\n`
}
