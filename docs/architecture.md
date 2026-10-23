# 架构

微枢是单进程 hub：微信 iLink Bot 通道收发消息，本机以无头方式拉起 CLI agent，结果原路回微信。

```
手机微信 ⇄ iLink Bot API ⇄ ┌─ weishub（单进程）──────────────────┐
                            │ channel-wechat                      │
                            │  ├─ ILinkClient 长轮询/发送/媒体     │
                            │  ├─ qrlogin 扫码                    │
                            │  └─ outbox 可靠投递/凭据续期         │
                            │ core                                │
                            │  ├─ registry：扫描 PATH 发现 agent  │
                            │  ├─ adapter：声明式配置 → argv 执行 │
                            │  │   + 输出解析（最终文本/session） │
                            │  ├─ approval：权限桥 → 微信审批      │
                            │  └─ dispatcher：chatId→(agent,      │
                            │      sessionId) 车道映射 + 排队     │
                            │ web panel（原生 HTML/JS）           │
                            │ notify API（本地回环）← wx CLI/skill │
                            └────────────────────────────────────┘
                                     │ spawn 无头进程
                     ┌───────────────┼───────────────┬─────┐
                claude -p       codex exec        dsh    opencode/pi …
```

## 组件职责

| 包 | 职责 |
| --- | --- |
| `packages/channel-wechat` | 微信 iLink Bot 协议：长轮询收信（checkpoint 落盘，at-least-once + 上层 msg.id 去重）、发送、CDN 媒体加解密、扫码登录、发件箱断点续投、hub 单实例锁 |
| `packages/core` | agent 无头执行：声明式配置 → argv + stdin、五种输出格式解析、会话恢复、微信审批路由、多 agent 车道调度（每 (会话, agent) 独立队列与会话） |
| `packages/weishub` | 装配与入口：CLI（`weishub` / `wx`）、Hub 消息管线、Web 面板（回环 + token）、审批 MCP 桥、notify API 消费方 |
| `packages/skills` | Claude Code skill（教 agent 用 `wx` 主动推送） |

## 关键机制

- **投递语义**：入站轮询游标在消息全部处理完才 checkpoint 落盘，崩溃重启最多重放（按 msg.id 去重），不丢消息；出站发件箱至少一次投递，崩溃后断点续发。
- **车道模型**：每 (会话, agent) 一条车道，车道内严格串行、车道间并行。`@codex 任务` 与默认 agent 同时干活互不排队；`/stop` 中止全部在跑车道。
- **审批**：claude 经 `--permission-prompt-tool` 桥把权限请求转到微信，主人回复「同意 / 拒绝」决议；审批是车道作用域（`chatId::agent`）。
- **回环信任**：Web 面板与 notify API 只绑 127.0.0.1；面板带 Host 围栏（防 DNS rebinding）与 token；token 由启动输出携带，本机访问即信任。
- **凭据**：iLink bot token 落盘 `~/.weishub/account.json`（0600），约 24 小时有效，收信自动续期；支持从旧版 dsh-wechat-gateway 无感迁移。
