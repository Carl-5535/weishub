# 微枢（weishub）

把微信变成 AI agent 的随身入口：手机微信发消息 → 本机 hub 分发给 claude / codex 等 CLI agent → 结果回到微信；agent 也能随时用 `wx` 主动推送、请求审批、外发文件。

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
                            │      sessionId) 映射 + 排队         │
                            │ web panel（原生 HTML/JS）           │
                            │ notify API（本地回环）← wx CLI/skill │
                            └────────────────────────────────────┘
                                     │ spawn 无头进程
                     ┌───────────────┼───────────────┬─────┐
                claude -p       codex exec        dsh    opencode/pi …
```

## 快速开始

要求：Node ≥ 20，macOS / Linux（Windows best-effort）。

```bash
# 1. 构建并全局安装（仓库根目录执行）
npm run build
npm install -g ./packages/weishub
# 注意：这是 workspace 链接式安装——全局 bin 符号链接回本仓库目录，
# 安装后不可移动/删除仓库目录；正式发布后将改用 npm registry 安装（v1 尚未发布）。

# 2. 启动（首次没有凭据，会先给出面板地址，浏览器打开用手机微信扫码登录）
weishub
# 面板地址形如 http://127.0.0.1:<port>/?token=<token>
# 扫码确认后自动进入正式服务，再打印正式面板地址

#   —— 或者用终端扫码代替面板 ——
weishub login    # 终端展示二维码，扫码确认后退出
weishub          # 再启动服务
```

登录成功后，在微信里给机器人发消息即可：

1. 微信发送「你好」→ hub 自动绑定第一个可用 agent 并回复；
2. `/agents` 看可用 agent，`/agent codex` 切换，`/sessions` 绑定历史会话；
3. agent 侧主动推送：

```bash
wx send "任务完成：构建通过"
wx send --image ./report.png
wx status
```

`wx` 的连接配置（`~/.weishub/token` 与 `~/.weishub/notify-port`）由 `weishub` 启动时自动写入，无需手工配置。

## 配置参考

### agent 配置（agents.d 覆盖）

内置 claude / codex / dsh / opencode / pi 五条声明式配置；在 `~/.weishub/agents.d/*.json` 里放同名条目可逐字段覆盖，异名条目即新增。示例（覆盖 claude 的超时与工作目录）：

```json
{
  "name": "claude",
  "timeoutSec": 3600,
  "workspace": "/Users/me/work/alpha"
}
```

字段含义：

| 字段 | 说明 |
| --- | --- |
| `name` / `detect` | 名称 / PATH 探测命令（探测不到则标记未安装，仍可 `/agents` 查看） |
| `run` | 启动命令（argv 数组，prompt 一律经 stdin 传入） |
| `outputFormat` | `text` / `claude-json` / `codex-jsonl` / `opencode-jsonl` / `pi-jsonl` |
| `listSessions` | 会话存储位置（`/sessions` 列历史会话用） |
| `resume` | 恢复会话的 argv 模板（`{{sessionId}}` 占位） |
| `approval` | `permission-prompt-tool`（claude：需要权限时经微信询问你）/ null。⚠️ `app-server` 目前只是合法占位值，**未实现**：声明它的 agent（codex）在需要权限时不会经微信询问，auto 模式下直接按 flags 执行 |
| `permissionFlags` | `auto` / `full` 两种权限模式各自的附加 argv |
| `workspace` | 该 agent 默认工作目录（null = 用全局） |
| `timeoutSec` | 单任务超时（到点杀整棵进程树） |

### 工作目录

- 全局默认 `~/weishub-workspace`（`weishub --workspace <目录>` 可改）；
- 面板「工作目录」表单可实时改全局与 per-agent 覆盖，立即生效并持久化；
- agent 回复中的本地文件路径只在当前工作目录内解析，越界路径一律不外发。

### 权限模式（/permission auto|full）

- `auto`（默认）：claude 走 `--permission-mode acceptEdits` + 微信审批桥——agent 需要更高权限时，微信会收到审批请求，回复「同意 / 拒绝 / 网页」即可；其余 agent 按内置 `auto` flags 执行；
- `full`：不加审批桥，按内置 `full` flags 执行（claude 即 `--dangerously-skip-permissions`，慎用）。

### 常用微信命令

`/help`、`/agents`、`/agent <名字>`、`/sessions`（回复序号绑定历史会话）、`/new`、`/status`、`/stop`、`/permission [auto|full]`。

## 从 dsh-wechat-gateway 迁移

1. **先停掉旧 dsh-wechat-gateway 插件**：getupdates 长轮询只允许一个消费者，两个进程同时轮询会互相抢消息；
2. 首次启动 weishub 时自动把 `~/.dsh/wechat-gateway/account.json` 校验并迁移到 `~/.weishub/account.json`，**无需重新扫码**；
3. 若本机还留着旧插件又在跑，weishub 的数据目录锁文件（`~/.weishub/hub.lock`）只保护 weishub 自身单实例，管不住旧插件——务必先停旧的；
4. DSH 侧后续改走 hub 的无头适配器（`dsh` 内置条目），不再常驻插件。

## 已知限制

- **codex 配置字段未实测**：`codex exec` 输出解析与 `listSessions` 按官方格式与 fixture 编写，真实输出字段未逐一实测，遇到解析偏差请提 issue 附样本；
- **codex 审批桥未实现**：codex 的 `approval: "app-server"` 只是合法占位配置，没有任何桥接实现——codex 在 auto 模式下按 flags 执行，需要权限时不会经微信询问（claude 的 `--permission-prompt-tool` 桥不受影响）；
- **审批桥待真机联调**：claude `--permission-prompt-tool` 桥的单端测试齐全，端到端（真机微信回复「同意」放行工具调用）尚待真机冒烟；
- **Windows best-effort**：凭据/锁文件的 600 权限、进程树终止等在 Windows 上尽力而为，未做一等公民测试；
- 凭据约 24 小时有效，收信自动续期；过期后收信不受影响，仅主动推送（`wx send`）不可用。

## Claude Code skill：微信主动推送

`packages/skills/weishub-notify` 是一个 Claude Code skill，教 agent 在任务完成、需要确认等时机用 `wx` CLI 给你发微信。安装：

```bash
# 复制（或软链）到 Claude Code 的 skills 目录
mkdir -p ~/.claude/skills
ln -s "$(pwd)/packages/skills/weishub-notify" ~/.claude/skills/weishub-notify
```

前提：`weishub serve` 在本机运行（`wx` 依赖其 notify API 与 `~/.weishub/token`）。
