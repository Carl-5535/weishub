# 从 dsh-wechat-gateway 迁移

1. **先停掉旧 dsh-wechat-gateway 插件**：getupdates 长轮询只允许一个消费者，两个进程同时轮询会互相抢消息（表现为「消息发了没反应」）；
2. 首次启动 weishub 时自动把 `~/.dsh/wechat-gateway/account.json` 校验并迁移到 `~/.weishub/account.json`，**无需重新扫码**；
3. 若本机还留着旧插件又在跑，weishub 启动时会检测旧状态文件的活跃度并打警告；数据目录锁（`~/.weishub/hub.lock`）只保护 weishub 自身单实例，管不住旧插件——务必先停旧的；
4. DSH 侧后续改走 hub 的无头适配器（`dsh` 内置条目），不再常驻插件。
