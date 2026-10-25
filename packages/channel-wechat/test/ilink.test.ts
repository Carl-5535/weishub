import { describe, expect, it, vi } from 'vitest'
import { ILinkClient, validateApiBase, type ILinkState } from '../src/ilink.js'
import { decryptMedia } from '../src/media.js'

const API = 'https://ilinkai.weixin.qq.com'
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c'

interface Call {
  url: string
  method: string
  body: any
  headers: Record<string, string>
}

function jsonResponse(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** 按路径分发 mock 响应的 fetch 桩。 */
function mockFetch(routes: Record<string, (call: Call, callCount: { n: number }) => Response>): typeof fetch & { calls: Call[] } {
  const calls: Call[] = []
  const counters: Record<string, { n: number }> = {}
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    let body: any
    if (init?.body !== undefined) {
      try {
        body = JSON.parse(String(init.body))
      } catch {
        body = init.body
      }
    }
    const call: Call = { url, method: init?.method ?? 'GET', body, headers: (init?.headers ?? {}) as Record<string, string> }
    calls.push(call)
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    const route = routes[path]
    if (route === undefined) throw new Error(`mock: 未路由 ${url}`)
    counters[path] ??= { n: 0 }
    counters[path].n += 1
    return route(call, counters[path])
  }) as unknown as typeof fetch & { calls: Call[] }
  fetch.calls = calls
  return fetch
}

function client(overrides: Partial<ConstructorParameters<typeof ILinkClient>[0]> = {}): ILinkClient {
  return new ILinkClient({ token: 'tok', accountId: 'bot-1', apiBase: API, cdnBase: CDN, ...overrides })
}

describe('validateApiBase', () => {
  it('HTTPS 与回环 HTTP 放行，其余拒绝', () => {
    expect(() => validateApiBase('https://ilinkai.weixin.qq.com')).not.toThrow()
    expect(() => validateApiBase('http://127.0.0.1:9000')).not.toThrow()
    expect(() => validateApiBase('http://evil.example.com')).toThrow(/HTTPS/)
  })
})

describe('ILinkClient.poll', () => {
  it('解析文本消息、跳过自己发的消息、推进游标并回调状态', async () => {
    const onStateChange = vi.fn(async (_state: ILinkState) => {})
    const fetch = mockFetch({
      '/ilink/bot/getupdates': () => jsonResponse(200, {
        ret: 0,
        get_updates_buf: 'buf-2',
        msgs: [
          { message_id: 11, from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: '你好' } }, { type: 1, text_item: { text: 'DSH' } }] },
          { message_id: 12, from_user_id: 'bot-1', item_list: [{ type: 1, text_item: { text: '自己的消息' } }] },
          { message_id: 13, from_user_id: 'u2', room_id: 'room-9', context_token: 'ctx-room', item_list: [{ type: 1, text_item: { text: '群消息' } }] },
        ],
      }),
    })
    const c = client({ fetch, onStateChange, state: { updatesBuffer: 'buf-1', contextTokens: {} } })
    const messages = await c.poll(AbortSignal.timeout(5_000))
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ id: '11', chatId: 'u1', userId: 'u1', group: false, text: '你好\nDSH' })
    expect(messages[1]).toMatchObject({ id: '13', chatId: 'room-9', group: true, text: '群消息' })
    // at-least-once：poll 本身不落盘新游标（消息还没被消费），只回调整会话 token
    expect(onStateChange).not.toHaveBeenCalledWith(expect.objectContaining({ updatesBuffer: 'buf-2' }))
    expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ contextTokens: { 'room-9': 'ctx-room' }, updatesBuffer: 'buf-1' }))
    // 请求带认证头与游标
    const call = fetch.calls[0]!
    expect(call.headers.authorization).toBe('Bearer tok')
    expect(call.body.get_updates_buf).toBe('buf-1')
    // 消费方处理完消息后 checkpoint：此时才落盘新游标
    await c.checkpoint()
    expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ updatesBuffer: 'buf-2', contextTokens: { 'room-9': 'ctx-room' } }))
  })

  it('消息处理中途状态落盘失败不丢消息：poll 照常返回整批', async () => {
    const onStateChange = vi.fn(async (_state: ILinkState) => {
      throw new Error('ENOSPC 磁盘满')
    })
    const fetch = mockFetch({
      '/ilink/bot/getupdates': () => jsonResponse(200, {
        ret: 0,
        get_updates_buf: 'buf-2',
        msgs: [
          { message_id: 11, from_user_id: 'u1', context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: '第一条' } }] },
          { message_id: 12, from_user_id: 'u1', context_token: 'ctx-2', item_list: [{ type: 1, text_item: { text: '第二条' } }] },
        ],
      }),
    })
    const messages = await client({ fetch, onStateChange }).poll(AbortSignal.timeout(5_000))
    // 两条都已解析的消息不得因落盘失败被丢弃
    expect(messages.map((m) => m.text)).toEqual(['第一条', '第二条'])
  })

  it('ret/errcode 非零时抛出带语义的错误', async () => {
    const fetch = mockFetch({
      '/ilink/bot/getupdates': () => jsonResponse(200, { ret: 0, errcode: 40001, errmsg: 'invalid token' }),
    })
    await expect(client({ fetch }).poll(AbortSignal.timeout(5_000))).rejects.toThrow(/getupdates 失败.*invalid token/)
  })

  it('HTTP 200 但响应体不是 JSON（网关/代理返回 HTML）时报可诊断错误而非裸 SyntaxError', async () => {
    const fetch = mockFetch({
      '/ilink/bot/getupdates': () => new Response('<html>502 Bad Gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    })
    // 报错须带上下文（来源 + 响应开头），且文案不得命中「凭据被拒」的启发式
    await expect(client({ fetch }).poll(AbortSignal.timeout(5_000))).rejects.toThrow(/不是有效 JSON.*502 Bad Gateway/)
  })
})

describe('ILinkClient 媒体下载失败路径', () => {
  // 带一张可下载图片的消息批次（aeskey 走 hex 形态）
  const imageMessage = (media: Record<string, unknown>, aeskey?: string) => ({
    ret: 0,
    get_updates_buf: 'buf-2',
    msgs: [
      {
        message_id: 21,
        from_user_id: 'u1',
        context_token: 'ctx-1',
        item_list: [{ type: 2, image_item: { ...(aeskey !== undefined ? { aeskey } : {}), media } }],
      },
    ],
  })

  it('缺少 AES 密钥：进 mediaErrors 不抛出、不中断批次', async () => {
    const fetch = mockFetch({
      '/ilink/bot/getupdates': () => jsonResponse(200, imageMessage({ encrypt_query_param: 'dl-1' })),
    })
    const messages = await client({ fetch }).poll(AbortSignal.timeout(5_000))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.media).toHaveLength(0)
    expect(messages[0]!.mediaErrors[0]).toContain('媒体缺少 AES 密钥')
  })

  it('CDN 非 200：报带状态码的错误且不中断批次', async () => {
    const fetch = mockFetch({
      '/ilink/bot/getupdates': () => jsonResponse(200, imageMessage({ encrypt_query_param: 'dl-2' }, 'aabbccdd')),
      // cdnBase 含 /c2c 前缀：实际下载 URL 是 <cdn>/download?encrypted_query_param=…
      '/c2c/download': () => new Response('gone', { status: 404 }),
    })
    const messages = await client({ fetch }).poll(AbortSignal.timeout(5_000))
    expect(messages[0]!.media).toHaveLength(0)
    expect(messages[0]!.mediaErrors[0]).toContain('CDN 下载失败 HTTP 404')
  })

  it('服务端给的非 CDN 源地址（full_url 指向别处）：拒绝下载（防重定向外泄）', async () => {
    const fetch = mockFetch({
      '/ilink/bot/getupdates': () => jsonResponse(200, imageMessage({ full_url: 'https://evil.example.com/dl?x=1' }, 'aabbccdd')),
    })
    const messages = await client({ fetch }).poll(AbortSignal.timeout(5_000))
    expect(messages[0]!.media).toHaveLength(0)
    expect(messages[0]!.mediaErrors[0]).toContain('不在配置的 CDN 源内')
    // 不应向外源发起任何请求
    expect(fetch.calls.some((c) => c.url.includes('evil.example.com'))).toBe(false)
  })
})

describe('ILinkClient.sendText', () => {
  it('发送正确的消息体', async () => {
    const fetch = mockFetch({ '/ilink/bot/sendmessage': () => jsonResponse(200, { ret: 0 }) })
    await client({ fetch }).sendText('u1', '回复', AbortSignal.timeout(5_000))
    const call = fetch.calls.find(c => c.url.endsWith('/ilink/bot/sendmessage'))!
    expect(call.body.msg.to_user_id).toBe('u1')
    expect(call.body.msg.item_list).toEqual([{ type: 1, text_item: { text: '回复' } }])
    expect(call.body.msg.message_type).toBe(2)
  })

  it('context_token 失效（errcode 41001）时自动清除并重发', async () => {
    const fetch = mockFetch({
      '/ilink/bot/sendmessage': (_call, counter) => counter.n === 1
        ? jsonResponse(200, { ret: 0, errcode: 41001, errmsg: 'context expired' })
        : jsonResponse(200, { ret: 0 }),
    })
    const onStateChange = vi.fn(async () => {})
    const messages = await new ILinkClient({
      token: 'tok', accountId: 'b', apiBase: API, cdnBase: CDN, fetch,
      state: { updatesBuffer: '', contextTokens: { u1: 'stale' } },
      onStateChange,
    }).sendText('u1', 'hi', AbortSignal.timeout(5_000))
    void messages
    const sent = fetch.calls.filter(c => c.url.endsWith('/ilink/bot/sendmessage'))
    expect(sent).toHaveLength(2)
    expect(sent[0]!.body.msg.context_token).toBe('stale')
    expect(sent[1]!.body.msg.context_token).toBeUndefined()
    expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ contextTokens: {} }))
  })

  it('无关协议错误（限流等）不清除 context_token 也不盲发重试', async () => {
    const fetch = mockFetch({
      '/ilink/bot/sendmessage': () => jsonResponse(200, { ret: 0, errcode: -14, errmsg: '频率限制' }),
    })
    const onStateChange = vi.fn(async () => {})
    await expect(new ILinkClient({
      token: 'tok', accountId: 'b', apiBase: API, cdnBase: CDN, fetch,
      state: { updatesBuffer: '', contextTokens: { u1: 'valid' } },
      onStateChange,
    }).sendText('u1', 'hi', AbortSignal.timeout(5_000))).rejects.toThrow(/sendmessage 失败/)
    // 只发一次：不是 token 过期就不能盲目重发（会重复投递）
    expect(fetch.calls).toHaveLength(1)
    // 有效 token 原样保留
    expect(onStateChange).not.toHaveBeenCalled()
  })
})

describe('ILinkClient.sendTyping', () => {
  it('先取 ticket 再设置状态', async () => {
    const fetch = mockFetch({
      '/ilink/bot/getconfig': () => jsonResponse(200, { ret: 0, typing_ticket: 'ticket-1' }),
      '/ilink/bot/sendtyping': () => jsonResponse(200, { ret: 0 }),
    })
    await client({ fetch }).sendTyping('u1', true, AbortSignal.timeout(5_000))
    const config = fetch.calls.find(c => c.url.endsWith('/ilink/bot/getconfig'))!
    const typing = fetch.calls.find(c => c.url.endsWith('/ilink/bot/sendtyping'))!
    expect(config.body.ilink_user_id).toBe('u1')
    expect(typing.body).toMatchObject({ ilink_user_id: 'u1', typing_ticket: 'ticket-1', status: 1 })
  })
})

describe('ILinkClient.sendMedia', () => {
  it('加密上传 CDN 后发送媒体消息，密文可用声明密钥解回', async () => {
    const payload = Buffer.from('文件内容 file payload 📄', 'utf8')
    let uploadedCiphertext: Uint8Array | undefined
    const fetch = mockFetch({
      '/ilink/bot/getuploadurl': () => jsonResponse(200, { ret: 0, upload_full_url: `${CDN}/upload?x=1` }),
      '/c2c/upload': (call) => {
        // 断点：记录密文供外部解密验证
        uploadedCiphertext = call.body instanceof Uint8Array ? call.body : new Uint8Array(Buffer.from(String(call.body), 'latin1'))
        return new Response('', { status: 200, headers: { 'x-encrypted-param': 'dl-param' } })
      },
      '/ilink/bot/sendmessage': () => jsonResponse(200, { ret: 0 }),
    })
    await client({ fetch }).sendMedia('u1', '报告.pdf', payload, AbortSignal.timeout(5_000))
    const uploadCall = fetch.calls.find(c => c.url.includes('/upload?'))!
    // getuploadurl 声明的密钥能把 CDN 收到的密文解回原文
    const aeskeyHex = fetch.calls.find(c => c.url.endsWith('/ilink/bot/getuploadurl'))!.body.aeskey
    expect(decryptMedia(uploadedCiphertext ?? new Uint8Array(), Buffer.from(aeskeyHex).toString('base64'))).toEqual(payload)
    // 发出的消息引用 CDN 下发参数
    const message = fetch.calls.find(c => c.url.endsWith('/ilink/bot/sendmessage'))!
    expect(message.body.msg.item_list[0].type).toBe(4)
    expect(message.body.msg.item_list[0].file_item.file_name).toBe('报告.pdf')
    expect(message.body.msg.item_list[0].file_item.media.encrypt_query_param).toBe('dl-param')
    void uploadCall
  })

  it('拒绝超过大小限制的媒体', async () => {
    const small = new ILinkClient({ token: 'tok', accountId: 'b', apiBase: API, cdnBase: CDN, maxMediaBytes: 1024 })
    await expect(small.sendMedia('u1', 'big.bin', new Uint8Array(4 * 1024), AbortSignal.timeout(5_000))).rejects.toThrow(/超过/)
  })
})
