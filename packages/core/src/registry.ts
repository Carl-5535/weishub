import { execFile } from 'node:child_process'
import type { AgentConfig } from './types.js'

/** 探测函数：命令在 PATH 中可执行则 resolve true，否则 false。 */
export type Probe = (cmd: string) => Promise<boolean>

/** 默认探测：posix 用 which，win32 用 where。非零退出视为未命中。 */
function defaultProbe(cmd: string): Promise<boolean> {
  const command = process.platform === 'win32' ? 'where' : 'which'
  return new Promise((resolve) => {
    execFile(command, [cmd], (error) => {
      resolve(!error)
    })
  })
}

/**
 * 按 detect 命令是否在 PATH 中过滤 agent 配置：
 * 命中的保留（保持原顺序），未命中的过滤掉，全不命中返回空数组。
 * 单个探测失败按未命中处理，绝不向调用方抛出。
 */
export async function discoverAgents(
  configs: AgentConfig[],
  probe?: Probe,
): Promise<AgentConfig[]> {
  const run = probe ?? defaultProbe
  const checks = await Promise.all(
    configs.map(async (config) => {
      try {
        return { config, found: await run(config.detect) }
      } catch {
        return { config, found: false }
      }
    }),
  )
  return checks.filter(({ found }) => found).map(({ config }) => config)
}
