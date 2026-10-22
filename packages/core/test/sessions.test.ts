import { cp, mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { listSessions, type SessionInfo } from '../src/sessions.js'
import type { AgentConfig } from '../src/types.js'

let root: string

// fixture 文件名 → 设定的 mtime（毫秒时间戳），决定 mtime 降序的预期顺序
const MTIME: Record<string, number> = {
  // 最老
  'aaaaaaaa-1111-4000-8000-000000000001.jsonl': 2_000,
  'aaaaaaaa-1111-4000-8000-000000000002.jsonl': 4_000, // 最新
  'bbbbbbbb-2222-4000-8000-000000000001.jsonl': 3_000,
  'bbbbbbbb-2222-4000-8000-000000000002.jsonl': 1_000,
}

const LONG_TITLE =
  '这是一个很长的标题用来测试截断逻辑——第四十字符之后的内容不应出现在 title 里，验证 40 字符截断是否生效'

beforeEach(async () => {
  // 把手造 fixture 拷到临时目录，避免测试污染仓库；mtime 用 utimes 精确控制
  root = await mkdtemp(join(tmpdir(), 'weishub-sessions-'))
  await cp(
    join(import.meta.dirname, 'fixtures/claude-store'),
    join(root, 'claude'),
    { recursive: true },
  )
  for (const f of Object.keys(MTIME)) {
    const t = new Date(MTIME[f])
    const dir = f.startsWith('aaaaaaaa') ? '-Users-carlchen-work-alpha' : '-Users-carlchen-work-beta'
    await utimes(join(root, 'claude', dir, f), t, t)
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function claudeConfig(store: string): AgentConfig {
  return {
    name: 'claude',
    detect: 'claude',
    run: ['claude', '-p'],
    passVia: 'stdin',
    outputFormat: 'claude-json',
    listSessions: { store, kind: 'claude' },
    resume: ['--resume', '{{sessionId}}'],
    approval: 'permission-prompt-tool',
    permissionFlags: { auto: [], full: [] },
    timeoutSec: 1800,
  }
}

test('claude：跨项目目录按 mtime 降序返回全部会话，title 取首条用户文本消息', async () => {
  const sessions = await listSessions(claudeConfig(join(root, 'claude')))
  expect(sessions.map((s) => s.id)).toEqual([
    'aaaaaaaa-1111-4000-8000-000000000002',
    'bbbbbbbb-2222-4000-8000-000000000001',
    'aaaaaaaa-1111-4000-8000-000000000001',
    'bbbbbbbb-2222-4000-8000-000000000002',
  ])
  expect(sessions.map((s) => s.mtime)).toEqual([4000, 3000, 2000, 1000])
  expect(sessions[0].title).toBe(LONG_TITLE.slice(0, 40))
  expect(sessions[0].title.length).toBe(40)
  expect(sessions[1].title).toBe('重构配置加载模块')
  expect(sessions[2].title).toBe('修复登录页在移动端的白屏问题')
  expect(sessions[3].title).toBe('第二个会话')
})

test('limit 截断，默认 10', async () => {
  const all = await listSessions(claudeConfig(join(root, 'claude')))
  expect(all.length).toBe(4)
  expect((await listSessions(claudeConfig(join(root, 'claude')), 2)).map((s) => s.id)).toEqual([
    'aaaaaaaa-1111-4000-8000-000000000002',
    'bbbbbbbb-2222-4000-8000-000000000001',
  ])
})

test('source 判定：mtime < hubSince 记 ide，否则 hub', async () => {
  const sessions: SessionInfo[] = await listSessions(
    claudeConfig(join(root, 'claude')),
    undefined,
    2_500,
  )
  const byId = new Map(sessions.map((s) => [s.id, s]))
  expect(byId.get('aaaaaaaa-1111-4000-8000-000000000002')!.source).toBe('hub')
  expect(byId.get('bbbbbbbb-2222-4000-8000-000000000001')!.source).toBe('hub')
  expect(byId.get('aaaaaaaa-1111-4000-8000-000000000001')!.source).toBe('ide')
  expect(byId.get('bbbbbbbb-2222-4000-8000-000000000002')!.source).toBe('ide')
  // 未传 hubSince 时全部记 hub
  const noSince = await listSessions(claudeConfig(join(root, 'claude')))
  expect(noSince.every((s) => s.source === 'hub')).toBe(true)
})

test('目录不存在返回 []，不抛异常；~ 展开走 os.homedir', async () => {
  expect(await listSessions(claudeConfig(join(root, 'nope')))).toEqual([])
  expect(await listSessions(claudeConfig('~/weishub- surely-missing-xyz'))).toEqual([])
})

test('listSessions 缺失（config 未配置 store）时返回 []', async () => {
  const cfg = { ...claudeConfig(''), listSessions: undefined }
  expect(await listSessions(cfg)).toEqual([])
})

test('codex：递归日期目录，id 取首行 session_meta，title 取首条 user_message（结构未实测，按公开文档）', async () => {
  await cp(
    join(import.meta.dirname, 'fixtures/codex-store'),
    join(root, 'codex'),
    { recursive: true },
  )
  const sessions = await listSessions({
    ...claudeConfig(join(root, 'codex')),
    listSessions: { store: join(root, 'codex'), kind: 'codex' },
  })
  expect(sessions.length).toBe(1)
  expect(sessions[0].id).toBe('cccccccc-3333-4000-8000-000000000001')
  expect(sessions[0].title).toBe('帮助我把 README 翻译成中文')
})
