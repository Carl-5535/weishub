import { describe, expect, test } from 'vitest'
import { ApprovalRouter } from '../src/approval.js'

test('request 挂起期间出现在 pending()，resolve allow 后兑现并清空', async () => {
  const router = new ApprovalRouter()
  const promise = router.request('chat-1', 'Bash', 'ls -la')
  const pend = router.pending()
  expect(pend).toHaveLength(1)
  expect(pend[0].chatId).toBe('chat-1')
  expect(pend[0].tool).toBe('Bash')
  expect(pend[0].input).toBe('ls -la')
  expect(typeof pend[0].createdAt).toBe('number')

  router.resolve(pend[0].id, 'allow')
  await expect(promise).resolves.toBe('allow')
  expect(router.pending()).toHaveLength(0)
})

test('resolve deny 后 Promise 以 deny 兑现', async () => {
  const router = new ApprovalRouter()
  const promise = router.request('chat-1', 'Write', '/tmp/a.txt')
  const [entry] = router.pending()
  router.resolve(entry.id, 'deny')
  await expect(promise).resolves.toBe('deny')
})

test('注入 timeoutMs=50，无人审批时超时返回 timeout', async () => {
  const router = new ApprovalRouter({ timeoutMs: 50 })
  await expect(router.request('chat-1', 'Bash', 'rm -rf /')).resolves.toBe('timeout')
  expect(router.pending()).toHaveLength(0)
})

test('cancelChat 使该 chat 挂起请求立即 deny，其他 chat 不受影响', async () => {
  const router = new ApprovalRouter()
  const p1 = router.request('chat-1', 'Bash', 'a')
  const p2 = router.request('chat-2', 'Bash', 'b')

  router.cancelChat('chat-1')
  await expect(p1).resolves.toBe('deny')
  expect(router.pending().map((a) => a.chatId)).toEqual(['chat-2'])

  router.resolve(router.pending()[0].id, 'allow')
  await expect(p2).resolves.toBe('allow')
})

test('resolve 未知 id 与 cancelChat 无挂起时均为安全 no-op', () => {
  const router = new ApprovalRouter()
  expect(() => router.resolve('no-such-id', 'allow')).not.toThrow()
  expect(() => router.cancelChat('chat-x')).not.toThrow()
})

test('startRequest 同步返回 id，done 在 resolve 后兑现', async () => {
  const router = new ApprovalRouter()
  const { id, done } = router.startRequest('chat-1', 'Bash', 'ls')
  expect(typeof id).toBe('string')
  expect(router.pending().map((a) => a.id)).toContain(id)
  router.resolve(id, 'allow')
  await expect(done).resolves.toBe('allow')
})

test('resultOf：挂起返回 pending，决议后保留 allow/deny，未知 id 返回 undefined', async () => {
  const router = new ApprovalRouter({ timeoutMs: 30 })
  const { id } = router.startRequest('chat-1', 'Bash', 'a')
  expect(router.resultOf(id)).toBe('pending')

  router.resolve(id, 'deny')
  expect(router.resultOf(id)).toBe('deny')
  expect(router.resultOf(id)).toBe('deny') // 决议后持续可查，不是一次性

  const t = router.startRequest('chat-2', 'Bash', 'b')
  expect(router.resultOf(t.id)).toBe('pending')
  await t.done // 超时
  expect(router.resultOf(t.id)).toBe('timeout')

  expect(router.resultOf('no-such-id')).toBeUndefined()
})

describe('pendingCount（/status 展示用）', () => {
  test('车道作用域（chatId::agent）的审批计入所属 chat', () => {
    const router = new ApprovalRouter()
    void router.request('chat-1::codex', 'Bash', 'a')
    void router.request('chat-1::claude', 'Bash', 'b')
    void router.request('chat-2', 'Bash', 'c')
    expect(router.pendingCount('chat-1')).toBe(2)
    expect(router.pendingCount('chat-2')).toBe(1)
    expect(router.pendingCount('chat-3')).toBe(0)
  })

  test('旧式裸 chatId 与车道作用域混计时都计入', () => {
    const router = new ApprovalRouter()
    void router.request('chat-1', 'Bash', 'legacy')
    void router.request('chat-1::codex', 'Bash', 'lane')
    expect(router.pendingCount('chat-1')).toBe(2)
  })

  test('决议后不再计入', async () => {
    const router = new ApprovalRouter()
    const { id } = router.startRequest('chat-1::codex', 'Bash', 'a')
    expect(router.pendingCount('chat-1')).toBe(1)
    router.resolve(id, 'allow')
    expect(router.pendingCount('chat-1')).toBe(0)
  })
})

describe('cancelChat 车道作用域', () => {
  test('agent 省略撤销该 chat 全部车道；agent 给定只撤该车道', async () => {
    const router = new ApprovalRouter()
    const codexReq = router.startRequest('chat-1::codex', 'Bash', 'a')
    const claudeReq = router.startRequest('chat-1::claude', 'Bash', 'b')
    router.cancelChat('chat-1', 'codex')
    await expect(codexReq.done).resolves.toBe('deny')
    expect(router.resultOf(claudeReq.id)).toBe('pending')
    router.cancelChat('chat-1')
    await expect(claudeReq.done).resolves.toBe('deny')
  })
})
