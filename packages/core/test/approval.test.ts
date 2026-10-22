import { expect, test } from 'vitest'
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
