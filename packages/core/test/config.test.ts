import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { loadAgentConfigs } from '../src/config.js'
import type { AgentConfig } from '../src/types.js'

let extraDir: string

beforeEach(async () => {
  extraDir = join(await mkdtemp(join(tmpdir(), 'weishub-agents-')), 'agents.d')
  await mkdir(extraDir, { recursive: true })
})

afterEach(async () => {
  await rm(join(extraDir, '..'), { recursive: true, force: true })
})

test('内置配置包含 claude，字段与既定值完全一致', async () => {
  const configs = await loadAgentConfigs(extraDir)
  const claude = configs.find((c) => c.name === 'claude')
  expect(claude).toBeDefined()
  const expected: AgentConfig = {
    name: 'claude',
    detect: 'claude',
    run: ['claude', '-p', '--output-format', 'json'],
    passVia: 'stdin',
    outputFormat: 'claude-json',
    listSessions: { store: '~/.claude/projects', kind: 'claude' },
    resume: ['--resume', '{{sessionId}}'],
    approval: 'permission-prompt-tool',
    permissionFlags: {
      auto: ['--permission-mode', 'acceptEdits'],
      full: ['--dangerously-skip-permissions'],
    },
    workspace: null,
    timeoutSec: 1800,
  }
  expect(claude).toEqual(expected)
})

test('内置配置包含 codex，关键字段与既定值一致', async () => {
  const configs = await loadAgentConfigs(extraDir)
  const codex = configs.find((c) => c.name === 'codex')
  expect(codex).toBeDefined()
  expect(codex!.detect).toBe('codex')
  expect(codex!.run).toEqual(['codex', 'exec', '--json', '--skip-git-repo-check'])
  // auto 留空：resume 子命令不支持 -s，加了会让恢复会话直接报错
  expect(codex!.permissionFlags.auto).toEqual([])
  expect(codex!.passVia).toBe('stdin')
  expect(codex!.outputFormat).toBe('codex-jsonl')
  expect(codex!.approval).toBe('app-server')
  // codex 的 resume 是独立子命令：走 resumeRun 整条替换，不再有追加式 resume
  expect(codex!.resume).toBeUndefined()
  expect(codex!.resumeRun).toEqual(['codex', 'exec', 'resume', '{{sessionId}}', '--json'])
  expect(codex!.timeoutSec).toBe(1800)
})

test('内置配置包含 dsh 与 pi，且 $note 注释键被剥离', async () => {
  const configs = await loadAgentConfigs(extraDir)
  const names = configs.map((c) => c.name)
  expect(names).toContain('dsh')
  expect(names).toContain('pi')
  for (const c of configs) {
    expect(Object.keys(c).some((k) => k.startsWith('$'))).toBe(false)
  }
  const dsh = configs.find((c) => c.name === 'dsh')!
  expect(dsh.run).toEqual(['dsh', '--profile', 'headless'])
  expect(dsh.outputFormat).toBe('text')
  expect(dsh.approval).toBeNull()
  // dsh headless 支持 --session-id <id>（flag 式）：追加式 resume
  expect(dsh.resume).toEqual(['--session-id', '{{sessionId}}'])
  expect(dsh.resumeRun).toBeUndefined()
  const pi = configs.find((c) => c.name === 'pi')!
  expect(pi.run).toEqual(['pi', '-p', '--mode', 'json'])
  expect(pi.outputFormat).toBe('pi-jsonl')
  expect(pi.approval).toBeNull()
  // pi 支持 --session <uuid>（flag 式追加恢复，实测接上上下文）
  expect(pi.resume).toEqual(['--session', '{{sessionId}}'])
  expect(pi.resumeRun).toBeUndefined()
})

test('extraDir 同名条目逐字段覆盖，异名追加，顺序内置在前', async () => {
  await writeFile(
    join(extraDir, 'claude.json'),
    JSON.stringify({ name: 'claude', timeoutSec: 60 }),
  )
  await writeFile(
    join(extraDir, 'myagent.json'),
    JSON.stringify({
      name: 'myagent',
      detect: 'myagent',
      run: ['myagent', 'run'],
      passVia: 'stdin',
      outputFormat: 'text',
      resume: ['--resume', '{{sessionId}}'],
      approval: null,
      permissionFlags: { auto: [], full: [] },
      timeoutSec: 300,
    }),
  )
  const configs = await loadAgentConfigs(extraDir)
  const claude = configs.find((c) => c.name === 'claude')!
  expect(claude.timeoutSec).toBe(60)
  // 未覆盖字段保留内置值
  expect(claude.run).toEqual(['claude', '-p', '--output-format', 'json'])
  expect(claude.permissionFlags.full).toEqual(['--dangerously-skip-permissions'])
  // 异名追加，且排在内置之后
  expect(configs.findIndex((c) => c.name === 'myagent')).toBeGreaterThan(
    configs.findIndex((c) => c.name === 'pi'),
  )
})

test('extraDir 缺失时静默跳过', async () => {
  const configs = await loadAgentConfigs(join(extraDir, 'no-such-dir'))
  expect(configs.map((c) => c.name)).toEqual(['claude', 'codex', 'dsh', 'opencode', 'pi'])
})

test('覆盖文件缺 name 抛中文错误', async () => {
  await writeFile(join(extraDir, 'broken.json'), JSON.stringify({ timeoutSec: 1 }))
  await expect(loadAgentConfigs(extraDir)).rejects.toThrow(/broken\.json/)
  await expect(loadAgentConfigs(extraDir)).rejects.toThrow(/name/)
})

test('非法字段抛中文错误且指明文件与字段', async () => {
  await writeFile(
    join(extraDir, 'bad.json'),
    JSON.stringify({
      name: 'bad',
      detect: '',
      run: [],
      passVia: 'stdin',
      outputFormat: 'text',
      resume: [],
      approval: null,
      permissionFlags: { auto: [], full: [] },
      timeoutSec: -1,
    }),
  )
  const err = await loadAgentConfigs(extraDir).catch((e: unknown) => e as Error)
  expect(err).toBeInstanceOf(Error)
  expect((err as Error).message).toContain('bad.json')
  expect((err as Error).message).toContain('detect')
  expect((err as Error).message).toContain('run')
  expect((err as Error).message).toContain('timeoutSec')
})

test('listSessions 形状非法（store 非字符串 / kind 不认识）抛中文错误', async () => {
  await writeFile(
    join(extraDir, 'badls.json'),
    JSON.stringify({
      name: 'badls',
      detect: 'badls',
      run: ['badls'],
      passVia: 'stdin',
      outputFormat: 'text',
      listSessions: { store: 123, kind: 'claude' },
      approval: null,
      permissionFlags: { auto: [], full: [] },
      timeoutSec: 10,
    }),
  )
  const err = await loadAgentConfigs(extraDir).catch((e: unknown) => e as Error)
  expect((err as Error).message).toContain('badls.json')
  expect((err as Error).message).toContain('listSessions')
})

test('listSessions.kind 非法值抛中文错误', async () => {
  await writeFile(
    join(extraDir, 'badkind.json'),
    JSON.stringify({
      name: 'badkind',
      detect: 'badkind',
      run: ['badkind'],
      passVia: 'stdin',
      outputFormat: 'text',
      listSessions: { store: '~/.x', kind: 'whatever' },
      approval: null,
      permissionFlags: { auto: [], full: [] },
      timeoutSec: 10,
    }),
  )
  const err = await loadAgentConfigs(extraDir).catch((e: unknown) => e as Error)
  expect((err as Error).message).toContain('listSessions')
})

test('workspace 非字符串或 null 抛中文错误', async () => {
  await writeFile(
    join(extraDir, 'badws.json'),
    JSON.stringify({
      name: 'badws',
      detect: 'badws',
      run: ['badws'],
      passVia: 'stdin',
      outputFormat: 'text',
      workspace: 1,
      approval: null,
      permissionFlags: { auto: [], full: [] },
      timeoutSec: 10,
    }),
  )
  const err = await loadAgentConfigs(extraDir).catch((e: unknown) => e as Error)
  expect((err as Error).message).toContain('workspace')
})

test('env 非字符串键值对抛中文错误', async () => {
  await writeFile(
    join(extraDir, 'badenv.json'),
    JSON.stringify({
      name: 'badenv',
      detect: 'badenv',
      run: ['badenv'],
      passVia: 'stdin',
      outputFormat: 'text',
      env: { KEY: 42 },
      approval: null,
      permissionFlags: { auto: [], full: [] },
      timeoutSec: 10,
    }),
  )
  const err = await loadAgentConfigs(extraDir).catch((e: unknown) => e as Error)
  expect((err as Error).message).toContain('env')
})

test('resume / resumeRun 空数组抛中文错误（会导致 spawn 空命令）', async () => {
  await writeFile(
    join(extraDir, 'emptyresume.json'),
    JSON.stringify({
      name: 'emptyresume',
      detect: 'emptyresume',
      run: ['emptyresume'],
      passVia: 'stdin',
      outputFormat: 'text',
      resume: [],
      resumeRun: [],
      approval: null,
      permissionFlags: { auto: [], full: [] },
      timeoutSec: 10,
    }),
  )
  const err = await loadAgentConfigs(extraDir).catch((e: unknown) => e as Error)
  expect((err as Error).message).toContain('resume')
})

test('resume/resumeRun 均可省略（不支持会话恢复的 agent），resumeRun 非数组时报错', async () => {
  await writeFile(
    join(extraDir, 'nores.json'),
    JSON.stringify({
      name: 'nores',
      detect: 'nores',
      run: ['nores'],
      passVia: 'stdin',
      outputFormat: 'text',
      approval: null,
      permissionFlags: { auto: [], full: [] },
      timeoutSec: 10,
    }),
  )
  const configs = await loadAgentConfigs(extraDir)
  expect(configs.find((c) => c.name === 'nores')!.resume).toBeUndefined()
  await writeFile(
    join(extraDir, 'badrun.json'),
    JSON.stringify({
      name: 'badrun',
      detect: 'badrun',
      run: ['badrun'],
      passVia: 'stdin',
      outputFormat: 'text',
      resumeRun: 'codex exec resume',
      approval: null,
      permissionFlags: { auto: [], full: [] },
      timeoutSec: 10,
    }),
  )
  await expect(loadAgentConfigs(extraDir)).rejects.toThrow(/badrun\.json.*resumeRun/)
})

test('outputFormat 非法值抛中文错误', async () => {
  await writeFile(
    join(extraDir, 'fmt.json'),
    JSON.stringify({
      name: 'fmt',
      detect: 'fmt',
      run: ['fmt'],
      passVia: 'stdin',
      outputFormat: 'xml',
      resume: [],
      approval: null,
      permissionFlags: { auto: [], full: [] },
      timeoutSec: 10,
    }),
  )
  await expect(loadAgentConfigs(extraDir)).rejects.toThrow(/fmt\.json.*outputFormat/)
})

test('passVia 非 stdin 抛中文错误', async () => {
  await writeFile(
    join(extraDir, 'pv.json'),
    JSON.stringify({
      name: 'pv',
      detect: 'pv',
      run: ['pv'],
      passVia: 'argv',
      outputFormat: 'text',
      resume: [],
      approval: null,
      permissionFlags: { auto: [], full: [] },
      timeoutSec: 10,
    }),
  )
  await expect(loadAgentConfigs(extraDir)).rejects.toThrow(/pv\.json.*passVia/)
})

test('不传 extraDir 时默认使用 dataDir()/agents.d（目录缺失即仅内置）', async () => {
  const configs = await loadAgentConfigs()
  expect(configs.length).toBeGreaterThanOrEqual(4)
})
