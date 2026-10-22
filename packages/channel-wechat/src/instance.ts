/**
 * 旧插件（wechat-gateway）凭据迁移与 hub 单实例锁。
 *
 * - 旧凭据位于 ~/.dsh/wechat-gateway/account.json，首启时校验并复制到新目录；
 * - hub 锁通过数据目录下的 hub.lock 实现：内容 { pid, startedAt }，
 *   持锁进程存活时拒绝二次加锁，进程已死（或锁损坏）时接管重写。
 */

import { readFile, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dataDir, defaultCredentialPath, pathExists, readCredential, writePrivateJson } from './store.js'

/** 旧插件凭据路径：~/.dsh/wechat-gateway/account.json。 */
export function legacyCredentialPath(): string {
  return join(homedir(), '.dsh', 'wechat-gateway', 'account.json')
}

/**
 * 迁移旧凭据：目标缺失且旧凭据存在且能通过校验时，复制到 defaultCredentialPath()
 * 并返回新路径；其余情况返回 null（永不抛出）。
 */
export async function migrateLegacyCredential(): Promise<string | null> {
  const target = defaultCredentialPath()
  try {
    if (await pathExists(target)) return null
    const legacy = legacyCredentialPath()
    if (!(await pathExists(legacy))) return null
    // 校验失败视为不可迁移：原样返回 null，不落任何文件
    const credential = await readCredential(legacy)
    await writePrivateJson(target, credential)
    return target
  } catch {
    return null
  }
}

/** hub 单实例锁句柄。 */
export interface HubLock {
  /** 释放锁：仅在锁仍归自己所有时移除锁文件。 */
  release(): Promise<void>
}

/**
 * 检测旧插件是否仍在运行（会和 hub 抢同一条 getupdates 流）。
 *
 * iLink 的长轮询只允许一个消费者：两个进程同时轮询时消息会被随机一方取走，
 * 表现为「消息发了但没反应」，极难自行排查。这里通过「旧状态文件的修改时间
 * 是否刚刚更新」来推断——旧插件每次收信都会落盘。
 *
 * @param windowMs 判定为「正在活动」的时间窗，默认 2 分钟
 * @returns 疑似活动时的描述；不活动返回 null
 */
export async function detectLegacyPluginActivity(
  windowMs = 120_000,
  now = Date.now(),
): Promise<{ statePath: string; idleMs: number } | null> {
  return detectLegacyPluginActivityAt(join(homedir(), '.dsh', 'wechat-gateway', 'state.json'), windowMs, now)
}

/** 同上，但状态文件路径可注入（测试用）。 */
export async function detectLegacyPluginActivityAt(
  statePath: string,
  windowMs: number,
  now: number,
): Promise<{ statePath: string; idleMs: number } | null> {
  try {
    const { mtimeMs } = await stat(statePath)
    const idleMs = now - mtimeMs
    if (idleMs > windowMs) return null
    return { statePath, idleMs }
  } catch {
    return null
  }
}

interface LockContent {
  pid: number
  startedAt: string
}

function hubLockPath(): string {
  return join(dataDir(), 'hub.lock')
}

/** 读取锁文件内容；缺失或损坏（非对象/缺 pid）返回 null，按可接管处理。 */
async function readLock(path: string): Promise<LockContent | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const { pid, startedAt } = value as { pid?: unknown; startedAt?: unknown }
    if (typeof pid !== 'number' || !Number.isInteger(pid)) return null
    return { pid, startedAt: typeof startedAt === 'string' ? startedAt : '' }
  } catch {
    return null
  }
}

/**
 * 探活：process.kill(pid, 0)。ESRCH=进程不存在，EPERM=存活（无权限发信号），
 * 其余错误保守视为存活。
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * 获取 hub 单实例锁。已有锁且持锁进程存活时抛中文错误；
 * 无锁、锁损坏或持锁进程已死时写入（接管）锁并返回句柄。
 */
export async function acquireHubLock(): Promise<HubLock> {
  const path = hubLockPath()
  if (await pathExists(path)) {
    const lock = await readLock(path)
    if (lock && processAlive(lock.pid)) {
      throw new Error(`另一个 weishub 实例正在运行 (pid=${lock.pid})`)
    }
    // 无锁内容或持锁进程已死：接管重写
  }
  await writePrivateJson(path, { pid: process.pid, startedAt: new Date().toISOString() } satisfies LockContent)
  return {
    async release(): Promise<void> {
      // 锁可能已被接管重写，只有 pid 仍是自己时才删除
      const current = await readLock(path)
      if (current?.pid !== process.pid) return
      await unlink(path).catch(() => undefined)
    },
  }
}
