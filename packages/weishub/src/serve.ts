/**
 * serve：真实依赖装配（微信 iLink client + agent 发现 + Hub）。
 *
 * 保持薄：只做真实实现到 HubDeps 的桥接；CLI 参数解析、扫码登录触发、
 * Web 面板等完整装配由 Task 20 的 cli.ts 负责。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultCredentialPath, ILinkClient, readCredential, type StoredCredential } from '@weishub/channel-wechat'
import { discoverAgents, loadAgentConfigs } from '@weishub/core'
import { Hub, loadPersistedProtocol, type HubDeps } from './inbound.js'

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
  // 断点续轮询：先读持久化的协议状态（轮询游标 + context token）喂给 client 构造器，
  // client 侧状态变化回写 Hub 的持久化链（hub 先声明再赋值，绕开构造顺序环）
  const persistedProtocol = await loadPersistedProtocol()
  let hubRef: Hub | undefined
  /** 按凭据构造通道 client（启动与重新扫码共用，token/账号都从这里来）。 */
  const makeClient = (cred: StoredCredential): ILinkClient => new ILinkClient({
    token: cred.token,
    accountId: cred.accountId,
    apiBase: cred.apiBase,
    // 重新扫码时必须带 hub 的最新游标：进程启动时读的 persistedProtocol 是旧
    // 快照，用它构造的新 client 会让服务端重放自启动以来的全部消息（超过去重
    // 容量后真会重复执行任务）。hub 未建好时（首次启动）才退回磁盘快照。
    state: hubRef?.protocolState ?? persistedProtocol,
    onStateChange: (state) => hubRef?.recordProtocolState(state),
  })
  const client = makeClient(credential)
  const hub = buildHub({
    client,
    // 重新扫码后 token 变了：用新凭据重建 client，否则轮询还拿旧 token 请求
    createClient: makeClient,
    accountId: credential.accountId,
    ownerUserId: credential.userId ?? credential.accountId,
    agents,
    allAgents,
    workspace,
    notifyPort: options.notifyPort,
    webPort: options.webPort,
    legacyCredentialDir: options.legacyCredentialDir,
  })
  hubRef = hub
  await hub.start()
  return hub
}
