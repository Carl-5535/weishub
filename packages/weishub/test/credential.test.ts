import { describe, expect, test } from 'vitest'
import {
  EXPIRY_WARN_LEAD_MS,
  expiryView,
  formatRemaining,
  healthFromExpiry,
  isCredentialRejection,
  healthMessage,
} from '../src/credential.js'

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-22T12:00:00.000Z')

describe('expiryView', () => {
  test('24 小时内为 ok', () => {
    const view = expiryView(new Date(NOW).toISOString(), undefined, NOW)
    const health = healthFromExpiry(view, NOW)
    expect(health.state).toBe('ok')
    if (health.state === 'ok') expect(health.remainingMs).toBe(24 * HOUR)
  })

  test('剩余不足预警窗口时为 expiring', () => {
    const savedAt = new Date(NOW - (24 * HOUR - 2 * HOUR)).toISOString()
    const health = healthFromExpiry(expiryView(savedAt, undefined, NOW), NOW)
    expect(health.state).toBe('expiring')
    if (health.state === 'expiring') expect(health.remainingMs).toBe(2 * HOUR)
  })

  test('超过 24 小时为 expired', () => {
    const savedAt = new Date(NOW - 25 * HOUR).toISOString()
    expect(healthFromExpiry(expiryView(savedAt, undefined, NOW), NOW).state).toBe('expired')
  })

  test('最近收信时间晚于凭据落盘时间时，以收信时间为锚点（收信即续期）', () => {
    const savedAt = new Date(NOW - 25 * HOUR).toISOString()
    const activityAt = new Date(NOW - 1 * HOUR).toISOString()
    const health = healthFromExpiry(expiryView(savedAt, activityAt, NOW), NOW)
    // 以 1 小时前为锚点 → 还剩 23 小时
    expect(health.state).toBe('ok')
    if (health.state === 'ok') expect(health.remainingMs).toBe(23 * HOUR)
  })

  test('活动时间早于凭据落盘时间时忽略（换号前的旧活动）', () => {
    const savedAt = new Date(NOW - 1 * HOUR).toISOString()
    const activityAt = new Date(NOW - 30 * HOUR).toISOString()
    const health = healthFromExpiry(expiryView(savedAt, activityAt, NOW), NOW)
    expect(health.state).toBe('ok')
    if (health.state === 'ok') expect(health.remainingMs).toBe(23 * HOUR)
  })

  test('锚点缺失或非法时视为 missing', () => {
    expect(healthFromExpiry(expiryView(undefined, undefined, NOW), NOW).state).toBe('missing')
    expect(healthFromExpiry(expiryView('not-a-date', undefined, NOW), NOW).state).toBe('missing')
  })

  test('预警窗口是 4 小时', () => {
    expect(EXPIRY_WARN_LEAD_MS).toBe(4 * HOUR)
  })
})

describe('isCredentialRejection', () => {
  test('识别鉴权类错误', () => {
    expect(isCredentialRejection(new Error('微信 HTTP 401: unauthorized'))).toBe(true)
    expect(isCredentialRejection(new Error('sendmessage 失败 (ret=1, errcode=403)'))).toBe(true)
    expect(isCredentialRejection(new Error('token 已失效'))).toBe(true)
    expect(isCredentialRejection(new Error('凭据无效，请重新登录'))).toBe(true)
  })

  test('网络类错误不算凭据被拒', () => {
    expect(isCredentialRejection(new Error('ECONNREFUSED'))).toBe(false)
    expect(isCredentialRejection(new Error('The operation was aborted'))).toBe(false)
    expect(isCredentialRejection(new Error('微信 HTTP 500: internal'))).toBe(false)
  })
})

describe('文案', () => {
  test('formatRemaining 边界', () => {
    expect(formatRemaining(0)).toBe('已过期')
    expect(formatRemaining(90_000)).toBe('约 2 分钟')
    expect(formatRemaining(2 * HOUR)).toBe('约 2 小时')
    expect(formatRemaining(20 * HOUR)).toBe('约 20 小时')
  })

  test('每种健康状态都有中文提示', () => {
    const states = [
      { state: 'missing' as const },
      { state: 'ok' as const, expiresAt: 0, remainingMs: 3 * HOUR },
      { state: 'expiring' as const, expiresAt: 0, remainingMs: 1 * HOUR },
      { state: 'expired' as const, expiresAt: 0, remainingMs: -1 },
      { state: 'rejected' as const, reason: 'HTTP 401' },
    ]
    for (const s of states) {
      const message = healthMessage(s)
      expect(message.length).toBeGreaterThan(0)
      expect(message).toMatch(/微信|凭据/)
    }
  })
})
