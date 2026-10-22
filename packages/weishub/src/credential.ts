/**
 * 凭据有效性与健康检查。
 *
 * 腾讯的 iLink bot token 有效期约 24 小时，**收到微信消息即自动续期**。
 * 所以「过期」不是一个瞬时事件，而是：最后一次成功收信之后超过 24 小时。
 *
 * 这里做三件事：
 * 1. 用 savedAt / 最近收信时间推算剩余寿命（本地时钟即可判断）；
 * 2. 主动向服务端核实一次（getupdates 长轮询本身就会验证 token），
 *    启动时 + 定时各做一次，避免「本地算着还没过期、服务端早已拒绝」；
 * 3. 把结论暴露成状态，供 Web 面板与微信侧提示。
 */

import { CREDENTIAL_TTL_MS } from '@weishub/channel-wechat'

/** 凭据健康度。 */
export type CredentialHealth =
  | { state: 'missing' }
  | { state: 'ok'; expiresAt: number; remainingMs: number }
  | { state: 'expiring'; expiresAt: number; remainingMs: number }
  | { state: 'expired'; expiresAt: number; remainingMs: number }
  | { state: 'rejected'; reason: string }

/** 到期预警窗口：剩余不足 4 小时开始提醒。 */
export const EXPIRY_WARN_LEAD_MS = 4 * 60 * 60 * 1000

/** 定期检查间隔：10 分钟。 */
export const CREDENTIAL_CHECK_INTERVAL_MS = 10 * 60 * 1000

export interface ExpiryView {
  expiresAt: number
  remainingMs: number
}

/**
 * 推算到期时间。锚点取「最近一次收信时间」与「凭据落盘时间」中较晚者
 * ——收信会续期，所以后者更能反映真实寿命。
 */
export function expiryView(savedAt: string | undefined, lastActivityAt: string | undefined, now: number): ExpiryView | undefined {
  const anchor = laterOf(savedAt, lastActivityAt)
  if (anchor === undefined) return undefined
  const issuedAt = Date.parse(anchor)
  if (Number.isNaN(issuedAt)) return undefined
  const expiresAt = issuedAt + CREDENTIAL_TTL_MS
  return { expiresAt, remainingMs: expiresAt - now }
}

function laterOf(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta)) return b
  if (Number.isNaN(tb)) return a
  // 活动时间早于凭据落盘时间，说明是换号前的旧活动，不能作为锚点
  return tb >= ta ? b : a
}

/** 由到期视图得出健康状态（不涉及网络核实）。 */
export function healthFromExpiry(view: ExpiryView | undefined, now: number): CredentialHealth {
  if (view === undefined) return { state: 'missing' }
  const remainingMs = view.expiresAt - now
  if (remainingMs <= 0) return { state: 'expired', expiresAt: view.expiresAt, remainingMs }
  if (remainingMs <= EXPIRY_WARN_LEAD_MS) return { state: 'expiring', expiresAt: view.expiresAt, remainingMs }
  return { state: 'ok', expiresAt: view.expiresAt, remainingMs }
}

/** 剩余时长的人话描述。 */
export function formatRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return '已过期'
  if (remainingMs >= 3_600_000) {
    const hours = remainingMs / 3_600_000
    return `约 ${hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10} 小时`
  }
  return `约 ${Math.max(1, Math.ceil(remainingMs / 60_000))} 分钟`
}

/**
 * iLink 的凭据失效错误码。服务端以 HTTP 200 + `errcode` 返回，
 * 这不走 HTTP 状态码，因此必须从错误文案里的 errcode 识别。
 * -14 = session timeout（token 过期/被顶掉，实测最常遇到）
 */
const CREDENTIAL_ERRCODES = new Set([-14, -1])

/**
 * 从通道错误里识别「凭据被服务端拒绝」。
 * iLink 有两套表达：鉴权类 HTTP 状态，以及 HTTP 200 + errcode。
 * 后者最容易被漏掉——`getupdates 失败 (ret=0, errcode=-14): session timeout`
 * 里既没有 401 也没有 token 字样，只能靠 errcode 认。
 */
export function isCredentialRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  // 1) HTTP 状态码形式
  if (/\b(401|403)\b/.test(message)) return true
  // 2) iLink errcode 形式（服务端用 200 包着错误码返回）
  const errcode = /errcode=(-?\d+)/.exec(message)
  if (errcode !== null && CREDENTIAL_ERRCODES.has(Number(errcode[1]))) return true
  // 3) 文案形式（各家措辞不一，宁可宽一点）
  if (/(token|凭证|凭据|登录失效|未登录|unauthor|credential)/i.test(message)) return true
  // 4) 会话失效的文案（iLink 用 session timeout 表示 token 过期）
  if (/session\s*(timeout|expired|invalid)/i.test(message)) return true
  return false
}

/** 面向用户的提示文案。 */
export function healthMessage(health: CredentialHealth): string {
  switch (health.state) {
    case 'missing':
      return '未登录微信'
    case 'ok':
      return `微信已连接（凭据剩 ${formatRemaining(health.remainingMs)}）`
    case 'expiring':
      return `凭据将在 ${formatRemaining(health.remainingMs)}后过期，发一条消息即可续期`
    case 'expired':
      return '凭据已过期，主动推送会失败；发一条消息即可续期，或重新扫码'
    case 'rejected':
      return `微信拒绝了当前凭据（${health.reason}），需要重新扫码登录`
  }
}
