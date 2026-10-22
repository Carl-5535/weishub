/**
 * serve：真实依赖装配（微信 iLink client + agent 发现 + Hub）。
 *
 * 保持薄：只做真实实现到 HubDeps 的桥接；CLI 参数解析、扫码登录触发、
 * Web 面板等完整装配由 Task 20 的 cli.ts 负责。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultCredentialPath, ILinkClient, readCredential } from '@weishub/channel-wechat'
import { discoverAgents, loadAgentConfigs } from '@weishub/core'
import { Hub, type HubDeps } from './inbound.js'

export interface ServeOptions {
  /** 全局工作目录，默认 ~/weishub-workspace */
  workspace?: string
  /** agent 覆盖目录（默认 dataDir()/agents.d） */
  agentsDir?: string
  notifyPort?: number
  webPort?: number
  legacyCredentialDir?: string
}

/** 组装 Hub（测试注入假件时也可直接 new Hub，此工厂供对称使用）。 */
export function buildHub(deps: HubDeps): Hub {
  return new Hub(deps)
}

/**
 * 以真实依赖启动 serve。凭据缺失时抛错（扫码登录由 CLI 层触发，Task 20）。
 * 返回已 start 的 Hub；停止调用其 stop()。
 */
export async function startServe(options: ServeOptions = {}): Promise<Hub> {
  const workspace = options.workspace ?? join(homedir(), 'weishub-workspace')
  const credential = await readCredential(defaultCredentialPath()).catch(() => undefined)
  if (credential === undefined) {
    throw new Error('尚未登录微信（缺少凭据），请先执行扫码登录')
  }
  const allAgents = await loadAgentConfigs(options.agentsDir)
  const agents = await discoverAgents(allAgents)
  const client = new ILinkClient({
    token: credential.token,
    accountId: credential.accountId,
    apiBase: credential.apiBase,
  })
  const hub = buildHub({
    client,
    accountId: credential.accountId,
    ownerUserId: credential.userId ?? credential.accountId,
    agents,
    allAgents,
    workspace,
    notifyPort: options.notifyPort,
    webPort: options.webPort,
    legacyCredentialDir: options.legacyCredentialDir,
  })
  await hub.start()
  return hub
}
