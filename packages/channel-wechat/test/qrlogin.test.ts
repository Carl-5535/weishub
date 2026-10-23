import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { login, pollLoginSession, startLoginSession, type LoginSession } from '../src/qrlogin.js'

const API = 'https://ilinkai.weixin.qq.com'

function fetchReturning(valueFor: (path: string) => Record<string, unknown>): typeof fetch {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    return new Response(JSON.stringify(valueFor(path)), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

describe('startLoginSession', () => {
  it('解析二维码与展示地址', async () => {
    const fetch = fetchReturning(() => ({ qrcode: 'qr-1', qrcode_img_content: 'https://img/qr.png' }))
    const session = await startLoginSession({ fetch, apiBase: API })
    expect(session).toMatchObject({ qrcode: 'qr-1', display: 'https://img/qr.png', apiBase: API })
  })

  it('缺少 qrcode 时报错', async () => {
    const fetch = fetchReturning(() => ({ ok: 1 }))
    await expect(startLoginSession({ fetch, apiBase: API })).rejects.toThrow(/qrcode/)
  })
})

describe('pollLoginSession 状态机', () => {
  function session(): LoginSession {
    return { qrcode: 'qr-1', display: 'x', apiBase: API }
  }

  it('wait/scaned → waiting/scanned', async () => {
    expect((await pollLoginSession(session(), { fetch: fetchReturning(() => ({ status: 'wait' })) })).status).toBe('waiting')
    expect((await pollLoginSession(session(), { fetch: fetchReturning(() => ({ status: 'scaned' })) })).status).toBe('scanned')
  })

  it('confirmed → 返回完整凭据', async () => {
    const fetch = fetchReturning(() => ({
      status: 'confirmed',
      ilink_bot_id: 'bot-9',
      bot_token: 'tok-9',
      baseurl: 'https://sz.ilinkai.weixin.qq.com',
      ilink_user_id: 'owner-1',
    }))
    const result = await pollLoginSession(session(), { fetch })
    expect(result.status).toBe('confirmed')
    if (result.status !== 'confirmed') return
    expect(result.credential).toMatchObject({
      accountId: 'bot-9',
      token: 'tok-9',
      apiBase: 'https://sz.ilinkai.weixin.qq.com',
      userId: 'owner-1',
    })
    expect(Number.isNaN(Date.parse(result.credential.savedAt))).toBe(false)
  })

  it('scaned_but_redirect → 更新区域 apiBase', async () => {
    const s = session()
    const fetch = fetchReturning(() => ({ status: 'scaned_but_redirect', redirect_host: 'gz.ilinkai.weixin.qq.com' }))
    expect((await pollLoginSession(s, { fetch })).status).toBe('redirected')
    expect(s.apiBase).toBe('https://gz.ilinkai.weixin.qq.com')
  })

  it('验证码状态', async () => {
    expect((await pollLoginSession(session(), { fetch: fetchReturning(() => ({ status: 'need_verifycode' })) })).status).toBe('needs-code')
    const blocked = session()
    blocked.verifyCode = '1234'
    expect((await pollLoginSession(blocked, { fetch: fetchReturning(() => ({ status: 'verify_code_blocked' })) })).status).toBe('code-blocked')
    expect(blocked.verifyCode).toBeUndefined()
  })

  it('expired', async () => {
    expect((await pollLoginSession(session(), { fetch: fetchReturning(() => ({ status: 'expired' })) })).status).toBe('expired')
  })

  it('网络错误视为继续等待（服务端 hold 语义）', async () => {
    const fetch = vi.fn(async () => { throw new Error('network reset') }) as unknown as typeof fetch
    expect((await pollLoginSession(session(), { fetch })).status).toBe('waiting')
  })
})

describe('pollLoginSession 错误透出', () => {
  function session(): LoginSession {
    return { qrcode: 'qr-1', display: 'x', apiBase: API }
  }

  it('HTTP 非 200（500/代理 HTML）不再吞成 waiting，直接抛出', async () => {
    const fetch = vi.fn(async (): Promise<Response> => new Response('<html>gateway error</html>', { status: 502 })) as unknown as typeof fetch
    await expect(pollLoginSession(session(), { fetch })).rejects.toThrow(/HTTP 502/)
  })

  it('响应非 JSON（HTML 错误页）直接抛出而不是静默等待', async () => {
    const fetch = vi.fn(async (): Promise<Response> => new Response('<html>blocked</html>', { status: 200 })) as unknown as typeof fetch
    await expect(pollLoginSession(session(), { fetch })).rejects.toThrow()
  })

  it('超时（服务端 hold）仍视为 waiting', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout')
    timeoutError.name = 'TimeoutError'
    const fetch = vi.fn(async (): Promise<Response> => { throw timeoutError }) as unknown as typeof fetch
    expect((await pollLoginSession(session(), { fetch })).status).toBe('waiting')
  })
})

describe('login 快速失败路径', () => {
  it('服务端要求数字验证码时立即报错，不空转到超时', async () => {
    let call = 0
    const fetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '')
      if (path.includes('get_bot_qrcode')) {
        return new Response(JSON.stringify({ qrcode: 'qr-1', qrcode_img_content: 'x' }), { status: 200 })
      }
      call += 1
      return new Response(JSON.stringify({ status: 'need_verifycode' }), { status: 200 })
    }) as unknown as typeof fetch
    await expect(login({ fetch, timeoutMs: 5_000 })).rejects.toThrow(/验证码/)
    expect(call).toBeLessThanOrEqual(2) // 首轮即失败，不轮询到超时
  })

  it('already-bound 但本地凭据损坏时报错并指明路径，不无限循环', async () => {
    const home = await mkdtemp(join(tmpdir(), 'weishub-login-'))
    const credentialPath = join(home, 'account.json')
    await writeFile(credentialPath, 'not-json{', { mode: 0o600 })
    let polls = 0
    const fetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '')
      if (path.includes('get_bot_qrcode')) {
        return new Response(JSON.stringify({ qrcode: 'qr-1', qrcode_img_content: 'x' }), { status: 200 })
      }
      polls += 1
      return new Response(JSON.stringify({ status: 'binded_redirect' }), { status: 200 })
    }) as unknown as typeof fetch
    await expect(login({ fetch, credentialPath, timeoutMs: 5_000 })).rejects.toThrow(new RegExp(credentialPath.replace(/\//g, '\\/').slice(0, 20)))
    expect(polls).toBe(1)
  }, 10_000)
})
