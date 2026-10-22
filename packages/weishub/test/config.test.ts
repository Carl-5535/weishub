import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_NOTIFY_PORT, DEFAULT_WEB_PORT, readHubConfig, resolvePorts } from '../src/config.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'weishub-cfg-'))
  vi.stubEnv('WEISHUB_WEB_PORT', '')
  vi.stubEnv('WEISHUB_NOTIFY_PORT', '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

describe('配置文件', () => {
  test('文件不存在时给出内置默认端口', async () => {
    const cfg = await readHubConfig(join(dir, 'missing.json'))
    expect(cfg.webPort).toBe(DEFAULT_WEB_PORT)
    expect(cfg.notifyPort).toBe(DEFAULT_NOTIFY_PORT)
    expect(DEFAULT_WEB_PORT).toBe(8090)
    expect(DEFAULT_NOTIFY_PORT).toBe(8091)
  })

  test('读取 webPort / notifyPort / workspace / agentsDir', async () => {
    const path = join(dir, 'config.json')
    await writeFile(path, JSON.stringify({ webPort: 9000, notifyPort: 9001, workspace: '/tmp/w', agentsDir: '/tmp/a' }))
    const cfg = await readHubConfig(path)
    expect(cfg).toEqual({ webPort: 9000, notifyPort: 9001, workspace: '/tmp/w', agentsDir: '/tmp/a' })
  })

  test('端口非法时抛中文错误', async () => {
    const path = join(dir, 'bad.json')
    await writeFile(path, JSON.stringify({ webPort: 'abc' }))
    await expect(readHubConfig(path)).rejects.toThrow(/webPort 必须是 1-65535 的整数/)
    await writeFile(path, JSON.stringify({ webPort: 70000 }))
    await expect(readHubConfig(path)).rejects.toThrow(/webPort/)
  })

  test('非法 JSON 抛中文错误', async () => {
    const path = join(dir, 'broken.json')
    await writeFile(path, '{not json')
    await expect(readHubConfig(path)).rejects.toThrow(/不是合法 JSON/)
  })

  test('webPort 与 notifyPort 相同被拒绝', async () => {
    const path = join(dir, 'same.json')
    await writeFile(path, JSON.stringify({ webPort: 8090, notifyPort: 8090 }))
    await expect(readHubConfig(path)).rejects.toThrow(/不能相同/)
  })
})

describe('端口优先级', () => {
  const cfg = { webPort: 8090, notifyPort: 8091 }

  test('显式参数覆盖一切', () => {
    vi.stubEnv('WEISHUB_WEB_PORT', '7000')
    expect(resolvePorts(cfg, { webPort: 6000 }).webPort).toBe(6000)
  })

  test('环境变量覆盖配置文件', () => {
    vi.stubEnv('WEISHUB_WEB_PORT', '7000')
    vi.stubEnv('WEISHUB_NOTIFY_PORT', '7001')
    expect(resolvePorts(cfg)).toEqual({ webPort: 7000, notifyPort: 7001 })
  })

  test('无覆盖时用配置文件', () => {
    expect(resolvePorts(cfg)).toEqual({ webPort: 8090, notifyPort: 8091 })
  })

  test('冲突端口抛错', () => {
    expect(() => resolvePorts(cfg, { webPort: 8091 })).toThrow(/不能相同/)
  })
})
