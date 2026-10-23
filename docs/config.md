# 配置参考

## 数据目录

所有状态都在 `~/.weishub/`（可用环境变量 `WEISHUB_HOME` 改）：

| 文件 | 内容 |
| --- | --- |
| `account.json` | 微信机器人凭据（0600，扫码登录写入） |
| `token` / `notify-port` | `wx` CLI 连接配置（`weishub` 启动时自动写入） |
| `hub.lock` | 单实例锁 |
| `state.json` | 车道/会话映射、轮询游标、发件箱断点 |
| `agents.d/` | agent 配置覆盖目录 |
| `config.json` | 可选：`{"webPort":8090,"notifyPort":8091,"workspace":"..."}` |

端口优先级：命令行参数 > 环境变量（`WEISHUB_WEB_PORT` / `WEISHUB_NOTIFY_PORT`）> `config.json` > 内置默认（web 8090 / notify 8091）。

## agent 配置（agents.d 覆盖）

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
| `listSessions` | 会话存储位置（`/sessions` 列历史会话用），如 `{"store": "~/.claude/projects", "kind": "claude"}` |
| `resume` / `resumeRun` | 恢复会话的 argv 模板（`{{sessionId}}` 占位）；`resume` 追加到 run 末尾，`resumeRun` 整条替换 |
| `approval` | `permission-prompt-tool`（claude：需要权限时经微信询问你）/ null。⚠️ `app-server` 目前只是合法占位值，**未实现**：声明它的 agent（codex）在需要权限时不会经微信询问，auto 模式下直接按 flags 执行 |
| `permissionFlags` | `auto` / `full` 两种权限模式各自的附加 argv |
| `workspace` | 该 agent 默认工作目录（null = 用全局） |
| `env` | 传给 agent 子进程的额外环境变量，值支持 `{ENV_VAR}` 占位（从 hub 进程环境展开） |
| `timeoutSec` | 单任务超时（到点杀整棵进程树），正整数 |

校验失败会在启动时报中文错误并指明文件与字段。

## 工作目录

- 全局默认 `~/weishub-workspace`（`weishub --workspace <目录>` 可改）；
- 面板「工作目录」表单可实时改全局与 per-agent 覆盖，立即生效并持久化；
- agent 回复中的本地文件路径只在当前工作目录内解析，越界路径（含符号链接逃逸）一律不外发；
- 收到的微信图片/文件按聊天落盘在工作区下（按聊天哈希分目录），保留 30 天后启动时自动清理。

## 权限模式（/permission auto|full）

- `auto`（默认）：claude 走 `--permission-mode acceptEdits` + 微信审批桥——agent 需要更高权限时，微信会收到审批请求，回复「同意 / 拒绝 / 网页」即可；其余 agent 按内置 `auto` flags 执行；
- `full`：不加审批桥，按内置 `full` flags 执行（claude 即 `--dangerously-skip-permissions`，慎用）。

## 常用微信命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 命令列表 |
| `/agents` | 列出已发现 agent（含未安装） |
| `/agent <名字>` | 切换该会话默认 agent（`@<名字> 任务` 可单次指派，与默认 agent 并行） |
| `/sessions` | 列当前 agent 的历史会话，回复序号绑定 |
| `/new` | 清空该会话所有车道的会话（全新开始） |
| `/status` | 默认 agent、会话、模式、队列、待审批、发件箱 |
| `/stop` | 中止在跑任务（多车道并行时全部中止） |
| `/permission [auto\|full]` | 查看/切换权限模式 |
