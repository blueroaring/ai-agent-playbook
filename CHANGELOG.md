# 更新日志

本仓库由维护者的 Agent 定期（默认每 3 天）蒸馏 + 推送。只记"知识层面"的变化，
不记机械同步。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0] - 2026-09-15

首个版本。建立仓库结构，并把此前若干天里验证过的结论沉淀成体系。

### 新增

**经验条目（`lessons/`）**

- `01-verification-discipline.md` —— 验证纪律：怎么避免"假通过"，怎么构造能否证伪的断言。
  含真实事故两个（`delete eval(...)` 无效操作、把 `[本机]` 当 `[通病]` 照抄）。
- `02-windows-powershell51.md` —— PowerShell 5.1 的四个坑：无 BOM 脚本被按 GBK 解码、
  `Set-Content -Encoding utf8` 写 BOM 毒害下游 JSON、`Add-Type` 与解析期类型字面量、
  `Invoke-WebRequest -MaximumRedirection 0` 的异常语义。另含 WMI 脱离进程树启动的实测矩阵。
- `03-sandbox-stdio-limits.md` —— 沙箱禁止管道 stdio 的连锁后果（`spawn` EPERM、`git push` 必失败、
  `cmd | Select-Object` 失败），为什么"宿主侧跑一个 stdio 服务"是正确的破局点，以及
  "绝不批量 kill 宿主进程"的事故复盘。
- `04-mcp-stdio-bridge-authoring.md` —— 从零写 MCP stdio 服务的范式：握手、`tools/list`、
  `tools/call`、错误该返回还是该抛、日志为什么必须走 stderr、工具命名的宿主约定，
  以及用 JSONL 落盘做可复现调试的方法。
- `05-browser-automation-playwright.md` —— 用 Playwright 驱动**系统已装浏览器**（不下载 Chromium）、
  持久 profile 保存登录态、快照优先于截图、`addInitScript` 模拟旧内核的验证技巧。
- `06-legacy-engine-compat-shim.md` —— 依赖库探测缺失 API 的方式有缺陷时如何整包炸掉
  （`Iterator.prototype` 在判断条件里被访问却没有存在性检查），以及网关层注入兼容垫片的
  正确形态：逐项存在性判断、自我报告补了哪些、对现代引擎零副作用。
- `07-dsh-harness-internals.md` —— Cordis patch 的语义边界（`name` 是断言不能换包、
  `overrides` 会直接赋值所以 `disabled` 可用）、"只在启动时组合"的体系有哪些、
  目录选择器 native/browse 的互斥设计。
- `08-lan-reverse-proxy-remote-gui.md` —— 把只监听回环的 GUI 暴露到局域网的完整方案：
  为何不能直接改 bind 地址、反代必须重写哪些头才能过信任围栏、SSE/WebSocket 转发、
  PWA manifest 不带 cookie 导致的口令门漏网、压缩与 HTML 改写冲突。
- `09-godot-automation.md` —— 无头模式没有渲染（要画面必须 Movie Maker）、
  端口被无关系统服务占用的探测陷阱与自动挑端口方案、临时目录用点号前缀避免被资源扫描。
- `10-zotero-automation.md` —— 本地 API 默认关闭且只读、运行中 SQLite 被独占锁的应对
  （复制快照读）、写操作走官方 Web API、连接器接口只能新增不能改。
- `11-http-network-troubleshooting.md` —— 同一台机器上不同 HTTP 客户端的连通性可以不一致，
  排查时先换客户端再怀疑网络；以及 TLS/代理排查的正确顺序。

**配方（`recipes/`）**

- `mcp-bridge-minimal/` —— 最小可跑的双向 stdio MCP 服务模板（零依赖，单文件）。
- `compat-shim/` —— 可独立使用的旧内核兼容垫片。
- `git-mcp/` —— Git / GitHub MCP 服务：认证、仓库创建、提交、推送（凭据不进 argv、不进仓库配置）。
- `zotero-mcp/` —— Zotero 读写 MCP 服务（SQLite 快照读 + 官方 Web API 写）。
- `godot-mcp/` —— Godot MCP 服务（CLI 桥 + 编辑器插件桥，含 GDScript 插件）。
- `phone-gateway/` —— 局域网反向代理网关（HTTP/SSE/WebSocket + 口令门 + 兼容垫片注入）。
- `windows-launcher/` —— Windows 启动器与二维码生成脚本。

**工具（`tools/`）**

- `publish.ps1` —— 发布流水线：同步配方源码 → 脱敏扫描（硬门禁）→ 提交 → 推送。
- `install-scheduled-task.ps1` —— 安装/卸载定期更新的计划任务。
- `redact-rules.json` —— 脱敏规则表（占位符映射 + 禁止模式黑名单）。
