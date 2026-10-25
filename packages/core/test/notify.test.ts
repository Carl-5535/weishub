import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ApprovalRouter } from '../src/approval.js'
import { startNotifyApi, type NotifyDeps } from '../src/notify.js'
import { Outbox } from '../../channel-wechat/src/outbox.js'

const TOKEN = 'test-token'
const OWNER = 'owner-chat'

/** 等待微任务/定时器队列清空，让 outbox 自动投递循环跑完失败重试。 */
const flush = (ms = 10): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

interface Started {
  port: number
  close: () => Promise<void>
  sentText: string[]
  sentImages: Array<{ name: string; bytes: Uint8Array }>
  approvals: ApprovalRouter
  outbox: Outbox
  /** 让下次 sendText/sendImage 抛错（模拟通道未就绪），之后自动恢复 */
  failNext: () => void
}

async function start(
  overrides: Partial<NotifyDeps> = {},
  opts: { maxBodyBytes?: number } = {},
): Promise<Started> {
  const sentText: string[] = []
  const sentImages: Array<{ name: string; bytes: Uint8Array }> = []
  let failing = false
  const deps: NotifyDeps = {
    token: TOKEN,
    ownerChatId: OWNER,
    sendText: async (text) => {
      if (failing) { failing = false; throw new Error('未登录') }
      sentText.push(text)
    },
    sendImage: async (name, bytes) => {
      if (failing) { failing = false; throw new Error('未登录') }
      sentImages.push({ name, bytes })
    },
    outbox: new Outbox({
      send: async () => { throw new Error('通道不可用') },
      sendFile: async () => { throw new Error('通道不可用') },
      maxChars: 100,
      maxRetries: 0,
      retryDelayMs: 1,
    }),
    approvals: new ApprovalRouter(),
    getLoggedIn: () => true,
    getCredentialHint: () => '约 2 天后过期',
    ...overrides,
  }
  const handle = await startNotifyApi({ ...deps, port: 0, ...opts })
  return {
    port: handle.port,
    close: handle.close,
    sentText,
    sentImages,
    approvals: deps.approvals as ApprovalRouter,
    outbox: deps.outbox,
    failNext: () => { failing = true },
  }
}

describe('startNotifyApi', () => {
  let s: Started
  beforeAll(async () => { s = await start() })
  afterAll(async () => { await s.close() })

  const call = (path: string, init: RequestInit & { token?: string | null } = {}): Promise<Response> => {
    const { token = TOKEN, ...rest } = init
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(rest.headers as Record<string, string>) }
    if (token !== null) headers.authorization = `Bearer ${token}`
    return fetch(`http://127.0.0.1:${s.port}${path}`, { ...rest, headers })
  }

  test('无/错 token 一律 401', async () => {
    expect((await call('/notify', { method: 'POST', body: '{"text":"hi"}', token: null })).status).toBe(401)
    expect((await call('/notify', { method: 'POST', body: '{"text":"hi"}', token: 'wrong' })).status).toBe(401)
    expect((await call('/status', { token: null })).status).toBe(401)
    expect((await call('/approvals/result/x', { token: 'wrong' })).status).toBe(401)
  })

  test('POST /notify 正常：200 且 sendText 收到原文', async () => {
    const res = await call('/notify', { method: 'POST', body: JSON.stringify({ text: '你好，枢' }) })
    expect(res.status).toBe(200)
    expect(s.sentText).toEqual(['你好，枢'])
  })

  test('POST /notify 通道失效：503 且内容保留进 outbox（Review Focus #3）', async () => {
    s.failNext()
    const res = await call('/notify', { method: 'POST', body: JSON.stringify({ text: '这条不能丢' }) })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: '微信通道未就绪' })
    await flush()
    const item = s.outbox.pending()[OWNER]
    expect(item).toBeDefined()
    expect(item?.chunks).toContain('这条不能丢')
  })

  test('POST /notify/image：base64 解码后送 sendImage', async () => {
    const raw = new Uint8Array([0, 1, 2, 250, 255])
    const res = await call('/notify/image', {
      method: 'POST',
      body: JSON.stringify({ name: 'a.png', dataBase64: Buffer.from(raw).toString('base64') }),
    })
    expect(res.status).toBe(200)
    expect(s.sentImages).toHaveLength(1)
    expect(s.sentImages[0].name).toBe('a.png')
    expect([...s.sentImages[0].bytes]).toEqual([...raw])
  })

  test('POST /notify/image 通道失效：503 且不入队 outbox（图片响亮失败）', async () => {
    s.failNext()
    const res = await call('/notify/image', {
      method: 'POST',
      body: JSON.stringify({ name: 'a.png', dataBase64: Buffer.from([1]).toString('base64') }),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; note?: string }
    expect(body.error).toBe('微信通道未就绪')
    expect(body.note).toContain('未入队')
    await flush()
    expect(s.outbox.pending()[OWNER]?.files ?? []).toHaveLength(0)
  })

  test('GET /status：结构正确且 pending 统计 outbox 条目', async () => {
    const res = await call('/status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { loggedIn: boolean; credentialExpiresHint?: string; pending: number }
    expect(body.loggedIn).toBe(true)
    expect(body.credentialExpiresHint).toBe('约 2 天后过期')
    expect(typeof body.pending).toBe('number')

    s.failNext()
    await call('/notify', { method: 'POST', body: JSON.stringify({ text: '计数用' }) })
    await flush()
    const after = (await (await call('/status')).json()) as { pending: number }
    expect(after.pending).toBe(1)
  })

  test('/notify 非 JSON 或缺 text 返回 400', async () => {
    expect((await call('/notify', { method: 'POST', body: 'not-json' })).status).toBe(400)
    expect((await call('/notify', { method: 'POST', body: '{}' })).status).toBe(400)
  })

  test('未知路由 404', async () => {
    expect((await call('/nope')).status).toBe(404)
  })

  test('body 超上限返回 413', async () => {
    const tiny = await start({}, { maxBodyBytes: 16 })
    try {
      const res = await fetch(`http://127.0.0.1:${tiny.port}/notify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(64) }),
      })
      expect(res.status).toBe(413)
    } finally {
      await tiny.close()
    }
  })
})

describe('startNotifyApi 集成 ApprovalRouter', () => {
  let s: Started
  beforeAll(async () => { s = await start() })
  afterAll(async () => { await s.close() })

  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${s.port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    })

  test('request 立即返回 id，result 轮询 pending→allow，决议后仍可查', async () => {
    const res = await call('/approvals/request', {
      method: 'POST',
      body: JSON.stringify({ chatId: OWNER, tool: 'Bash', input: { command: 'ls -la' } }),
    })
    expect(res.status).toBe(200)
    const { id } = (await res.json()) as { id: string }
    expect(typeof id).toBe('string')
    // 挂起中即可查到 pending（说明 request 没有长挂）
    expect((await (await call(`/approvals/result/${id}`)).json())).toEqual({ result: 'pending' })
    // input 对象被序列化存进 ApprovalRouter
    expect(s.approvals.pending().find((a) => a.id === id)?.input).toBe(JSON.stringify({ command: 'ls -la' }))

    s.approvals.resolve(id, 'allow')
    const first = await call(`/approvals/result/${id}`)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ result: 'allow' })
    // 决议后持续可答（桥会一直轮询到终态，之后再查也不能 404）
    expect(await (await call(`/approvals/result/${id}`)).json()).toEqual({ result: 'allow' })
  })

  test('deny 与 timeout 路径', async () => {
    const d = await (await call('/approvals/request', {
      method: 'POST',
      body: JSON.stringify({ chatId: OWNER, tool: 'Write', input: {} }),
    })).json() as { id: string }
    s.approvals.resolve(d.id, 'deny')
    expect(await (await call(`/approvals/result/${d.id}`)).json()).toEqual({ result: 'deny' })
  })

  test('未知/过期 id 返回 404（桥把任何 fetch 错误当 deny）', async () => {
    const res = await call('/approvals/result/ap-no-such-id')
    expect(res.status).toBe(404)
  })

  test('request 缺字段返回 400', async () => {
    expect((await call('/approvals/request', { method: 'POST', body: '{"chatId":"c"}' })).status).toBe(400)
  })
})

describe('超时经 API 可查', () => {
  test('timeoutMs 到期后 result 变 timeout', async () => {
    const s2 = await start({ approvals: new ApprovalRouter({ timeoutMs: 50 }) })
    try {
      const call2 = (path: string, init: RequestInit = {}): Promise<Response> =>
        fetch(`http://127.0.0.1:${s2.port}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        })
      const { id } = (await (await call2('/approvals/request', {
        method: 'POST',
        body: JSON.stringify({ chatId: OWNER, tool: 'Bash', input: {} }),
      })).json()) as { id: string }
      await new Promise((r) => { setTimeout(r, 80) })
      expect(await (await call2(`/approvals/result/${id}`)).json()).toEqual({ result: 'timeout' })
    } finally {
      await s2.close()
    }
  })
})

describe('审批请求推送与 owner 取值', () => {
  test('onApprovalRequest 在登记成功后收到 lane 作用域 chatId/tool/input', async () => {
    const requests: Array<{ chatId: string; tool: string; input: string }> = []
    const s = await start({
      onApprovalRequest: (chatId, tool, input) => { requests.push({ chatId, tool, input }) },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/approvals/request`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'c1::claude', tool: 'Write', input: { file_path: '/tmp/x' } }),
      })
      expect(res.status).toBe(200)
      const { id } = await res.json() as { id: string }
      expect(s.approvals.resultOf(id)).toBe('pending')
      expect(requests).toEqual([{ chatId: 'c1::claude', tool: 'Write', input: '{"file_path":"/tmp/x"}' }])
    } finally {
      await s.close()
    }
  })

  test('onApprovalRequest 抛错不影响登记与应答', async () => {
    const s = await start({
      onApprovalRequest: () => { throw new Error('推送失败') },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/approvals/request`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: OWNER, tool: 'Bash', input: {} }),
      })
      expect(res.status).toBe(200)
    } finally {
      await s.close()
    }
  })

  test('ownerChatId 支持取值函数：通道失效兜底入队用发送时刻的最新值', async () => {
    let owner = 'old-generation-id'
    const s = await start({
      ownerChatId: () => owner,
      sendText: async () => { throw new Error('未登录') },
    })
    try {
      // 认主发生在 hub 构造之后：发送时刻应取到新代际 id
      owner = 'new-generation-id'
      const res = await fetch(`http://127.0.0.1:${s.port}/notify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: '认主后的推送' }),
      })
      expect(res.status).toBe(503)
      await flush()
      expect(s.outbox.pending()['new-generation-id']).toBeDefined()
      expect(s.outbox.pending()['old-generation-id']).toBeUndefined()
    } finally {
      await s.close()
    }
  })
})
