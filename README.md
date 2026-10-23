# 微枢 weishub

在微信里指挥本机的 AI agent：手机发一条消息，claude / codex 等 CLI agent 在你的电脑上干活，结果直接回到微信对话框。

> 状态：**实验阶段**（v1 未发布，配置接口可能变动）。当前安装方式为从源码构建，尚无 npm registry 包。License: MIT

## 它能做什么

- **微信就是终端**：给机器人发「跑一下测试并总结失败原因」，任务在你电脑的工作目录里执行，回复回到微信，支持断点续投（网络断了不丢回复）；
- **多 agent 并行**：`@codex 重构这个模块` 与默认 agent 同时干活，互不排队；`/agent` 切换默认，`/sessions` 绑定历史会话接着聊；
- **权限审批在微信完成**：claude 需要更高权限时，微信收到审批请求，回复「同意」或「拒绝」即可；也可以打开本机 Web 面板处理；
- **agent 主动找你**：agent（或任何本机脚本）用 `wx send "构建通过"` 把消息、图片推到你的微信，任务跑完不用盯着屏幕。

## 快速开始

### 前置要求

- Node.js ≥ 20
- macOS 或 Linux（Windows 尽力而为，未做一等公民测试）
- 本机已安装要用的 agent CLI（如 `claude`），启动时自动扫描 PATH 发现

### 安装

```bash
git clone <仓库地址> && cd weishub
npm install
npm run build
npm install -g ./packages/weishub
```

注意：这是 workspace 链接式安装，全局 `weishub` 命令指向本仓库目录——安装后不要移动/删除仓库。

### 启动

```bash
weishub
```

预期输出（首次启动）：

```
尚未登录微信：请用手机微信扫码（先打开下方面板地址完成扫码登录）
扫码面板：http://127.0.0.1:8090/?token=…
```

浏览器会自动打开面板，用手机微信扫码确认，之后看到：

```
扫码成功，正在启动微枢…
微枢已启动。面板地址：http://127.0.0.1:8090/?token=…
```

### 验证

微信里给机器人发「你好」→ 收到绑定成功欢迎语和 agent 回复，即跑通。

再验证主动推送（另开终端）：

```bash
wx status
# 预期输出：
# 微信登录：已登录
# 发件箱待发：0 条

wx send "来自终端的消息"
```

`wx` 的连接配置由 `weishub` 启动时自动写入 `~/.weishub/`，无需手工配置。

### 故障排查

| 问题 | 原因 | 解决 |
| --- | --- | --- |
| 启动报「另一个 weishub 实例正在运行 (pid=…)」 | 已有实例在跑 | 停掉旧实例；若确认没有，删除 `~/.weishub/hub.lock` |
| `wx` 报「未找到 hub 令牌」 | `weishub` 没在运行 | 先启动 `weishub` |
| `wx` 报 HTTP 401 | 全局安装的是旧版（token 接线修复前） | 在仓库重新 `npm run build && npm install -g ./packages/weishub` |
| 启动时警告「检测到旧微信插件仍在活动」 | 旧 dsh-wechat-gateway 在抢同一长轮询通道 | 先停掉旧插件，见[迁移说明](docs/migration-dsh.md) |
| `wx send` 报「微信通道未就绪」 | 凭据过期（约 24 小时） | 手机上给机器人发条消息即自动续期 |
| 扫码后要求数字验证码 / 一直「登录超时」 | 服务端风控或网络异常 | 看终端报错重试；持续失败检查代理/网络 |

## 下一步

- 把回复里的文件发给微信、切换工作目录、调整 agent 超时 → [配置参考](docs/config.md)
- 用 Claude Code skill 让 agent 自动汇报 → `packages/skills/weishub-notify`（软链到 `~/.claude/skills/` 即可）
- 从 dsh-wechat-gateway 迁移 → [迁移说明](docs/migration-dsh.md)
- 组件与投递语义 → [架构](docs/architecture.md)

## 已知限制

- **codex 配置字段未实测**：`codex exec` 输出解析按官方格式编写，遇到解析偏差请附样本反馈；
- **codex 审批桥未实现**：codex 的 `approval: "app-server"` 只是占位配置，auto 模式下按 flags 执行，不会经微信询问（claude 桥不受影响）；
- **claude 审批桥待真机联调**：单端测试齐全，真机「同意」放行工具调用的端到端冒烟待做；
- 凭据约 24 小时有效，收信自动续期；过期后收信不受影响，仅 `wx send` 不可用。

## 反馈

项目尚未发布到远端仓库；问题与建议先记录在本地，或将日志（`weishub` 终端输出）与复现步骤整理后随仓库一起反馈给维护者。
