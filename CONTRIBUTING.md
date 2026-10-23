# 参与开发

欢迎提 PR！这里是最短路径。

## 环境搭建

要求：Node.js ≥ 20（macOS / Linux；Windows 尽力而为）。

```bash
git clone https://github.com/Carl-5535/weishub.git && cd weishub
npm install
npm run build     # tsc 项目构建 + 修正 bin 执行位
npm test          # 全部测试，应全绿
npm run typecheck # tsc -b 全工程类型检查
```

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| `packages/channel-wechat` | 微信 iLink 协议层（轮询/发送/媒体/扫码/发件箱/锁） |
| `packages/core` | agent 无头执行与调度（适配器/解析器/审批/车道调度） |
| `packages/weishub` | CLI、Hub 消息管线、Web 面板、审批 MCP 桥 |
| `packages/skills` | Claude Code skill |
| `docs/` | 配置参考、架构、迁移说明 |

## 测试约定

- 框架是 vitest（`packages/*/test/*.test.ts`），提交前跑 `npm test` 与 `npm run typecheck`，两者都必须全绿；
- **修 bug 先写会失败的测试再修**（红 → 绿）；新行为要有测试覆盖；
- 测试不依赖真实网络与真实微信——协议层用 fetch 桩，端到端测试跑编译产物 + 本地假服务。

## 提交流程

1. 从 `main` 拉分支，或直接 fork；
2. 提交信息用中文 conventional 风格（`fix: …` / `feat: …` / `docs: …`，参考 `git log`）；
3. PR 描述说清「改了什么 + 为什么 + 怎么验证的」；涉及行为的改动列出新增/调整的测试。

## 代码约定

- TypeScript 严格模式（`tsconfig.base.json`），ESM（`"type": "module"`）；
- 面向用户的报错用中文并指明文件/字段；代码注释也是中文，密度跟随邻近代码；
- 不引入新依赖除非必要——核心运行时目前仅 `qrcode` 一个外部依赖。
