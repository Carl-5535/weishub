import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, stat, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  defaultCredentialPath,
  pathExists,
  writePrivateJson,
  type StoredCredential,
} from '../src/store.js'
import { acquireHubLock, migrateLegacyCredential } from '../src/instance.js'

// 让 homedir() 指到临时目录，避免读写真实的 ~/.dsh
const mocks = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => (mocks.home === '' ? actual.homedir() : mocks.home) }
})

let workDir: string
let legacyPath: string
const children: ChildProcess[] = []

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'weishub-instance-'))
  mocks.home = workDir
  vi.stubEnv('WEISHUB_HOME', workDir)
  legacyPath = join(workDir, '.dsh', 'wechat-gateway', 'account.json')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  mocks.home = ''
  for (const child of children.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill()
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  }
  await rm(workDir, { recursive: true, force: true })
})

const validCredential: StoredCredential = {
  accountId: 'bot-001',
  token: 'secret-token',
  apiBase: 'https://ilink.example.com',
  savedAt: new Date().toISOString(),
}

/** 起一个短期存活的子进程，返回其 pid（结束后由 afterEach 清理）。 */
async function spawnSleeper(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
  children.push(child)
  return child.pid!
}

/** 起一个立即退出的子进程，等待其结束后返回 pid（保证是死进程）。 */
async function spawnDeadProcess(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''])
  const pid = child.pid!
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return pid
}

test('无旧凭据时返回 null 且不生成新凭据', async () => {
  expect(await migrateLegacyCredential()).toBe(null)
  expect(await pathExists(defaultCredentialPath())).toBe(false)
})

test('有旧凭据且新凭据缺失时复制成功且新文件 600', async () => {
  await writePrivateJson(legacyPath, validCredential)
  const migrated = await migrateLegacyCredential()
  expect(migrated).toBe(defaultCredentialPath())
  expect(await pathExists(migrated!)).toBe(true)
  const fileStat = await stat(migrated!)
  expect(fileStat.mode & 0o077).toBe(0)
})

test('新凭据已存在时不覆盖并返回 null', async () => {
  await writePrivateJson(legacyPath, validCredential)
  const existing = { ...validCredential, accountId: 'already-here' }
  await writePrivateJson(defaultCredentialPath(), existing)
  expect(await migrateLegacyCredential()).toBe(null)
  expect(await readFile(defaultCredentialPath(), 'utf8')).toContain('already-here')
})

test('旧凭据无法通过校验时不迁移并返回 null', async () => {
  await writePrivateJson(legacyPath, { foo: 'bar' })
  expect(await migrateLegacyCredential()).toBe(null)
  expect(await pathExists(defaultCredentialPath())).toBe(false)
})

test('锁被存活进程持有时第二次 acquire 抛中文错误', async () => {
  const lock = await acquireHubLock()
  const sleeperPid = await spawnSleeper()
  // 模拟锁被另一个存活进程持有
  await writeFile(
    join(workDir, 'hub.lock'),
    `${JSON.stringify({ pid: sleeperPid, startedAt: new Date().toISOString() })}\n`,
    'utf8',
  )
  await expect(acquireHubLock()).rejects.toThrow(/另一个 weishub 实例正在运行/)
  await lock.release()
})

test('锁文件持锁进程已死时接管重写', async () => {
  const deadPid = await spawnDeadProcess()
  await writePrivateJson(join(workDir, 'hub.lock'), {
    pid: deadPid,
    startedAt: new Date().toISOString(),
  })
  const lock = await acquireHubLock()
  const content = JSON.parse(await readFile(join(workDir, 'hub.lock'), 'utf8')) as {
    pid: number
    startedAt: string
  }
  expect(content.pid).toBe(process.pid)
  expect(Number.isNaN(Date.parse(content.startedAt))).toBe(false)
  await lock.release()
})

test('release() 移除锁文件且只移除自己持有的锁', async () => {
  const lock = await acquireHubLock()
  const lockPath = join(workDir, 'hub.lock')
  // 锁被别的进程重写后，release 不应删除别人的锁
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
  const sleeperPid = sleeper.pid!
  await writeFile(
    lockPath,
    `${JSON.stringify({ pid: sleeperPid, startedAt: new Date().toISOString() })}\n`,
    'utf8',
  )
  await lock.release()
  expect(await pathExists(lockPath)).toBe(true)

  // 持锁进程退出后可接管，此时 release 删除自己的锁
  sleeper.kill()
  await new Promise<void>((resolve) => sleeper.once('exit', () => resolve()))
  const own = await acquireHubLock()
  await own.release()
  expect(await pathExists(lockPath)).toBe(false)
})
