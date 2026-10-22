# 微枢 weishub — 设计文档

日期：2026-10-22
状态：已评审（builder check 通过，遗留问题已由所有者裁定）
前身项目：`dsh-wechat-gateway`（同目录，MIT，作者 Carl-5535）

## 1. 意图与为什么

把手机微信变成**所有 agent 的总遥控器**。

`dsh-wechat-gateway` 已经证明了这条通道：微信 iLink Bot API（扫码登录、官方 bot 通道）收发消息，本机 agent 干活，回复送回微信，外加主动推送、审批、可靠投递。但它以 Cordis 插件形式**寄生在 DSH Host 进程内**，只能服务 DSH 一个 agent 框架。

微枢（weishub）把"微信通道"从任何 agent 框架中解放出来，成为独立的中枢：

- **南向**：自动发现本机所有支持无头模式的 agent，统一接入、统一会话管理
- **北向**：微信是第一个前端；本地 Web 面板是第二个
- **出站**：任何 agent（包括 hub 未适配的）都能通过 `wx` CLI 主动推送消息到微信

一句话场景：人在外面，微信发"帮我把那个 bug 修了"——任务落到本机 Claude Code 上执行；它要越界写文件时，审批请求直达微信，回"同意"放行；跑完通过 `wx send` 主动把结果推回你的微信。

## 2. 目标

1. **独立 hub 进程**：扫码登录个人微信（iLink Bot API），独立收发消息，不依赖任何 agent 框架的 Host
2. **agent 自动发现**：启动时扫描 PATH，检测本机安装了哪些无头 agent CLI（`claude`、`codex`、`dsh`、`pi`、`gemini`、`opencode`、`goose`、`crush`、`cursor-agent`…）
3. **通用无头适配器**：一个适配器引擎 + 每个 agent 一份声明式配置（命令模板、prompt 传递方式、输出解析、会话参数），而不是每个 agent 写死一份代码。新 agent 多数情况加配置即接入
4. **首批内置配置**：Claude Code、Codex、DSH、pi。其余（Gemini CLI、OpenCode、Goose、Crush、Cursor CLI 等）靠内置配置逐步补充
5. **会话管理**：每个微信聊天绑定 (agent, session)；session id 持久化落盘，支持 resume 接续；`/new` 重开；`/sessions` 可列出并绑定**任意来源**的既有会话（hub 创建的、VS Code 里创建的——同一会话存储 `~/.claude` / `~/.codex`）
6. **微信审批桥接 + 权限模式**：每个聊天有权限模式，默认 **`auto`**，`/permission` 可切 **`full`**，立即生效：
   - `auto`：工作区内操作自动放行；越界操作 → 能桥接的 agent 走**微信审批**（回复同意/拒绝，回复"网页"转交 Web 面板），不能桥接的直接拒绝
   - `full`：全部权限打开（各 agent 的 bypass flag），不弹审批
   - 桥接能力按 agent 而定（声明在适配器配置里）：**Claude Code 走 `--permission-prompt-tool` 完整桥接（v1）**；**Codex 走 app-server 协议审批，v1 列为勘察项**（可行则桥，不可行降级）；其余 agent 降级为预设模式。将来某 agent 开放审批入口，配置里翻一个字段即升级
7. **出站钥匙**：`wx` CLI（`wx send` / `wx send --image` / `wx status`）+ 一个 Claude Code skill 包装它。任何能执行命令的 agent 都可主动推微信，不限于 hub 已适配的
8. **文件双向**：入站图片/文件落盘到生效工作目录、路径注入 prompt；出站沿用 `[[send-file:路径]]` + 正文提及自动回发 + realpath 校验（边界 = 生效工作目录）
9. **工作目录管理**：**全局工作目录为默认**，所有 agent 预设使用它；可按 agent 单独覆盖（二选一：设了 per-agent 就用 per-agent，否则落全局）。修改入口在 Web 面板（复用前身的可视化目录选择器，运行时生效并持久化）
9. **本地 Web 面板**：hub 内置，浏览器访问。功能：扫码登录、聊天列表 + 绑定的 agent、消息流（轮询/SSE）、手动插话、待审批面板（承接微信转交）
10. **尽可能小**（硬指标）：运行时第三方依赖 ≤ 5 个（目前已知 `qrcode` 一个）；单进程；状态 JSON 文件落盘（不引数据库）；Web UI 原生 HTML/JS（无框架、无重型构建）；配置用 JSON（不引 YAML 解析器）；安装即 `npm i -g weishub`

## 3. 非目标（v1 不做）

- **流式进度转发**：任务执行期间微信端只要最终结果，不转发中间工具调用/阶段进展（将来要加，需在适配器层扩展事件语义，v1 不预留复杂度）
- **多 agent 群聊协作**：一条消息同时分发给多个 agent 开会（v1 每个聊天串行绑定一个 agent）
- **实时遥控 IDE 活会话**：驱动 VS Code 里正在进行的对话窗口（无官方入口）；v1 靠 `/sessions` 绑定 + 无头 resume 达成等效
- **VS Code 桥接插件**：作为 hub 客户端把任务递进 IDE 的小插件（v2 再评估）
- **纯插件型 agent**（Cline / Roo 等）：会话锁在 VS Code 内部存储，无无头模式，无法接入；这类 agent 只能通过 `wx` CLI 获得"主动通知微信"的半边能力
- **群聊**：v1 严格限扫码账号本人的私聊（owner-only，沿用前身安全模型）
- **营销 / 客服 / 高频群发**：违反微信通道条款，红线，永不做

## 4. 反目标（怎样算失败）

- 装出来一大坨依赖、需要 Docker / 数据库 / 复杂配置才能跑
- 通道层再次与某个 agent 框架耦合（重蹈 dsh-wechat-gateway 寄生 DSH 的覆辙）
- 加一个新 agent 需要改 hub 核心代码
- 不安全的默认：任何 agent 默认带越权 flag 跑

## 5. 约束

- **iLink 凭据**：约 24 小时有效，收信自动续期；过期不影响登录收信，仅无法主动推送；腾讯可能随时调整协议端点（沿用现有 ILinkClient 的实现与交叉验证）
- **长轮询独占**：getupdates 长轮询只能有一个消费者，hub 是**唯一**跑微信通道的进程。数据目录加锁文件；dsh-wechat-gateway 插件逐步退役，DSH 改走 hub 的无头适配器
- **凭据迁移**：尝试复用前身项目的凭据文件（同路径/格式），免重新扫码；附迁移说明
- **平台**：Node ≥ 20，TypeScript；macOS / Linux 一等公民，Windows best-effort（执行核心按 argv 数组 + 进程终止抽象设计，不用 POSIX 专有 API 写死）
- **安全模型**（沿用现有项目）：默认仅响应扫码账号本人，白名单显式开启；凭据与状态文件 600 权限落盘；登录路由仅限本机回环；出站文件 realpath 校验

## 6. 架构

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
                claude -p       codex exec        dsh    pi …
```

### Monorepo 布局

| 包 | 职责 |
| --- | --- |
| `@weishub/channel-wechat` | 从 dsh-wechat-gateway 抽取：ILinkClient、qrlogin、media、store/state。对 agent 零依赖。**注意**：outbox 与凭据续期逻辑目前缠在前身项目的 Cordis 插件类里（约 700 行，与 abort 信号、配置、存储交织），是**抽取重写**，不是文件搬运——工作量按重写估 |
| `@weishub/core` | agent registry（发现）、adapter（声明式配置 + 执行 + 输出解析）、approval 桥、会话映射与排队、dispatcher |
| `weishub` | 主进程：`weishub serve` 起 hub + Web 面板；`wx` bin（出站 CLI） |
| `@weishub/skills` | Claude Code skill：包装 `wx send`，教 agent 何时主动推送 |

### 适配器配置示意

内置 defaults（JSON）+ 用户在 `~/.weishub/agents.d/` 覆盖/新增：

```json
{
  "name": "claude",
  "detect": "claude",
  "run": ["claude", "-p", "--output-format", "text"],
  "passVia": "stdin",
  "outputFormat": "text",
  "sessionIdFrom": "stderr-meta",
  "listSessions": { "store": "~/.claude/projects", "kind": "claude" },
  "resume": ["--resume", "{{sessionId}}"],
  "approval": "permission-prompt-tool",
  "permissionFlags": { "auto": ["--permission-mode", "workspace-write"], "full": ["--dangerously-skip-permissions"] },
  "workspace": null,
  "timeoutSec": 1800
}
```

要点（评审后定案）：

- **prompt 一律走 stdin**（`passVia: "stdin"`）：不受 ARG_MAX 限制、无 shell 注入面、不暴露在进程列表。argv 数组形式杜绝引号地狱，Windows 渲染器可后加
- **输出只要最终结果**：`outputFormat: "text"` 或各家 JSON 里提取最终文本 + session id，不做事件流转发
- **会话发现**：`listSessions` 声明各 agent 的会话存储位置，`/sessions` 据此列出（含 IDE 创建的）供微信绑定
- **审批能力分级**：`approval` 声明各 agent 的桥接机制——`"permission-prompt-tool"`（claude，v1 完整桥接）、`"app-server"`（codex，勘察项，可行则桥）、`null`（其余，降级预设模式：auto 下越界直接拒绝）
- **工作目录**：`workspace: null` 表示跟随全局工作目录；设了路径则该 agent 用自己的目录（realpath 边界同步跟随）

## 7. 微信命令面

| 命令 | 作用 |
| --- | --- |
| `/agents` | 列出本机发现的 agent |
| `/agent <name>` | 切换当前聊天绑定的 agent（各自 session 独立保留，切回可 resume） |
| `/sessions` | 列出该 agent 最近会话（hub + IDE 创建的），回序号绑定 |
| `/new` | 丢弃当前会话上下文，重开 |
| `/status` | 当前 agent / 会话 / 任务 / 排队状态 |
| `/stop` | 中止当前无头任务（终止进程树） |
| `/permission` | 查看/切换权限模式（`auto` ↔ `full`，默认 auto，立即生效，仅当前聊天） |
| `/help` | 帮助 |

**审批流**（对 approval 桥接的 agent，auto 模式下）：越权请求以问题形式直达微信，回复同意/拒绝词放行或驳回，回复"网页"转交 Web 面板；通道失效或任务中止时自动转交/撤销，不悬挂。无桥接能力的 agent 在 auto 下越界直接拒绝并告知可 `/permission` 切 full。

**排队语义**：任务运行中收到的新消息进入队列（带"已排队"提示），当前任务结束后按序以 resume 续跑；队列有上限（防误触连环任务），超限明确拒绝。

其余消息作为 prompt 交给绑定的 agent。

## 8. 出站 CLI

```
wx send "文本"              # 推送到扫码账号
wx send --image <path>      # 推送图片
wx status                   # 登录状态、凭据剩余有效期
```

走本地回环 HTTP 调 hub 的 notify API（复用前身 `wechat` service 的逻辑：分块、重试、超时）。skill（`@weishub/skills`）在此基础上教 Claude Code 何时该推（任务完成、需要确认、长任务关键节点）。

## 9. Web 面板

- 扫码登录（复用现有侧边栏扫码体验）
- 聊天列表：每个聊天显示绑定的 agent、权限模式、会话状态、最近消息、队列
- 消息流：查看收发，可手动插话（以本人身份注入）
- 待审批面板：承接微信转交的审批项
- 工作目录：可视化目录选择器，可改全局工作目录或任一 agent 的覆盖目录，运行时生效并持久化
- 技术形态：静态 HTML + 原生 JS，hub 进程直接 serve，仅本机回环 + 简单 token；无框架，至多 esbuild 单文件 bundle

## 10. 已裁定的决策记录

评审 subagent 提出的问题及裁定（标 ★ 的是所有者亲自裁定，其余为明显答案由作者定）：

1. ★ **不要流式进度，只要最终结果**（§3、§6）
2. ★ **做微信审批桥接**：claude 走 `--permission-prompt-tool` 完整桥接，其他 agent 降级预设模式（§2.6、§6、§7）
3. ★ **IDE 会话用微信 `/sessions` 选择绑定**（§2.5、§7）
4. ★ **入站媒体落盘 + 路径注入 prompt**（§2.8）
5. ★ **权限模式默认 `auto`（工作区内放行、越界审批或拒绝），可切 `full`**（§2.6、§7）
6. ★ **审批桥接按 agent 能力分级**：claude v1 完整桥接；codex 走 app-server 列为勘察项；其余降级预设模式（§2.6、§6）
7. ★ **工作目录：全局为默认，所有 agent 预设用全局；可按 agent 覆盖，二选一**（§2.9）
8. prompt 一律 stdin 传递，argv 数组形式（防注入、防 ARG_MAX、Windows 可渲染）
9. 配置用 JSON，不引 YAML 解析器
10. Windows best-effort，但执行核心不做 POSIX 写死
11. 运行中消息排队，任务结束按序 resume 续跑，队列有上限
12. v1 限 owner 私聊，无群聊
13. 凭据尽量复用前身文件免重扫码 + 数据目录锁文件防双轮询
14. outbox/续期逻辑是抽取重写而非搬运，工作量按重写估

## 11. 留给 builder 的决策

- 包管理器（npm，与现有项目一致即可）与构建工具细节（tsc / esbuild 取舍）
- 各家输出格式的具体解析（claude 的 text/json 输出、codex `--json`、dsh / pi 的约定）——实现时以各 CLI 实际输出为准
- `listSessions` 对各 agent 会话存储的读取实现（`~/.claude/projects`、`~/.codex/sessions` 等的实际结构需实现时勘察）
- claude `--permission-prompt-tool` 的本地 MCP 端点实现细节
- **codex app-server 协议审批桥接的可行性勘察**（§10.6 勘察项：可行则做，不可行降级预设模式并在文档记录结论）
- 错误恢复细节：进程崩溃后的轮询游标 / outbox 断点续跑（前身实现已解决，随抽取重写带入）
