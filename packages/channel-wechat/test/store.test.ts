import { stat, writeFile, chmod, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  dataDir,
  defaultCredentialPath,
  pathExists,
  readCredential,
  readPrivateJson,
  writePrivateJson,
  type StoredCredential,
} from '../src/store.js'

let workDir: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'weishub-store-'))
  // 数据目录相关测试用 env 指到临时目录，避免污染真实 ~/.weishub
  vi.stubEnv('WEISHUB_HOME', workDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

test('dataDir() 尊重 WEISHUB_HOME', () => {
  expect(dataDir()).toBe(workDir)
})

test('dataDir() 缺省 ~/.weishub', async () => {
  vi.unstubAllEnvs()
  delete process.env.WEISHUB_HOME
  const { homedir } = await import('node:os')
  expect(dataDir()).toBe(join(homedir(), '.weishub'))
})

test('defaultCredentialPath() 位于数据目录下的 account.json', () => {
  expect(defaultCredentialPath()).toBe(join(workDir, 'account.json'))
})

test('writePrivateJson 写出 0600 文件且父目录 0700', async () => {
  const target = join(workDir, 'nested', 'state.json')
  await writePrivateJson(target, { hello: '世界' })
  const fileStat = await stat(target)
  expect(fileStat.isFile()).toBe(true)
  // umask 可能影响实际权限，只要求组/其他位为 0
  expect(fileStat.mode & 0o077).toBe(0)
  const dirStat = await stat(join(workDir, 'nested'))
  expect(dirStat.isDirectory()).toBe(true)
  expect(dirStat.mode & 0o077).toBe(0)
  expect(await pathExists(target)).toBe(true)
  expect(await readPrivateJson<{ hello: string }>(target)).toEqual({ hello: '世界' })
})

test('readPrivateJson 对权限过宽的文件抛中文错误', async () => {
  const target = join(workDir, 'loose.json')
  await writeFile(target, '{}\n', 'utf8')
  await chmod(target, 0o644)
  await expect(readPrivateJson(target)).rejects.toThrow(/权限过宽/)
})

test('readPrivateJson 对非对象内容抛中文错误', async () => {
  const target = join(workDir, 'array.json')
  await writeFile(target, '[1,2]\n', 'utf8')
  await chmod(target, 0o600)
  await expect(readPrivateJson(target)).rejects.toThrow(/JSON 对象/)
})

test('pathExists 对不存在的路径返回 false', async () => {
  expect(await pathExists(join(workDir, 'missing.json'))).toBe(false)
})

const validCredential: StoredCredential = {
  accountId: 'bot-001',
  token: 'secret-token',
  apiBase: 'https://ilink.example.com',
  savedAt: new Date().toISOString(),
}

test('readCredential 接受合法凭据', async () => {
  const target = join(workDir, 'account.json')
  await writePrivateJson(target, validCredential)
  expect(await readCredential(target)).toEqual(validCredential)
})

test('readCredential 对缺 accountId 抛含字段名的中文错误', async () => {
  const target = join(workDir, 'account.json')
  await writePrivateJson(target, { ...validCredential, accountId: undefined })
  await expect(readCredential(target)).rejects.toThrow(/accountId/)
})

test('readCredential 对缺 token 抛含字段名的中文错误', async () => {
  const target = join(workDir, 'account.json')
  await writePrivateJson(target, { ...validCredential, token: '' })
  await expect(readCredential(target)).rejects.toThrow(/token/)
})

test('readCredential 对坏 apiBase 抛含字段名的中文错误', async () => {
  const target = join(workDir, 'account.json')
  await writePrivateJson(target, { ...validCredential, apiBase: 'ftp://nope' })
  await expect(readCredential(target)).rejects.toThrow(/apiBase/)
})

test('readCredential 对坏 savedAt 抛含字段名的中文错误', async () => {
  const target = join(workDir, 'account.json')
  await writePrivateJson(target, { ...validCredential, savedAt: '不是时间' })
  await expect(readCredential(target)).rejects.toThrow(/savedAt/)
})
