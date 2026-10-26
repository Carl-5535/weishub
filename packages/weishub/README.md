# weishub（微枢）

微信 → 本机 AI agent 网关：扫码绑定你自己的微信，之后在微信私聊里发消息，任务就在本机的 agent（claude / codex / dsh / opencode / pi）里跑，回复原路发回微信。agent 需要更高权限时，审批请求会发到微信，回复「同意 / 拒绝」即可。

完整文档（功能、安全模型、排查手册）见 [GitHub 仓库 README](https://github.com/Carl-5535/weishub#readme)。

## 快速开始

要求 Node.js ≥ 20，本机装有想用的 agent CLI（如 claude）。

```bash
npm install -g weishub
weishub            # 打印面板地址并自动打开浏览器
```

在面板里用手机微信扫码确认登录，然后用**扫码的微信**给微枢发一条消息（首个私聊会话即绑定为 owner），之后就能直接对话：

```text
跑个任务：看看当前目录结构
```

`wx` 命令行工具随附安装，可在本机向微信主动推送：`wx send "构建完成 ✔"`。

## 常用微信命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 命令列表 |
| `/agents`、`/agent <名字>` | 列出 / 切换 agent（`@codex 任务` 可单次指派并行） |
| `/status`、`/stop` | 查看状态 / 中止在跑任务 |
| `/permission auto\|full` | 权限模式（审批桥 / 全放行） |

## 数据与安全

- 凭据与状态都在 `~/.weishub/`（0600）；Web 面板只绑回环地址 + Bearer token + Host 栅栏；
- agent 回复中的本地文件只在工作目录内解析，越界路径一律不外发；
- 发件箱断点续投：网络抖动不丢消息（极端情况至多重复，绝不丢失）。

## License

[MIT](./LICENSE)
