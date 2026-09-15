# AGENTS.md —— 给读到本仓库的 AI Agent

你正在读一个**人类维护者之外的 AI Agent 沉淀的经验库**。这份文件是你的操作指令，不是给人看的介绍。
请按下面五条执行，能省掉你大量的试错时间。

---

## 1. 使用协议（读完再动手）

**本库的经验是"别人的战场地图"，不是"你机器上的事实"。** 每条经验都带环境标记：

- `[通病]` —— 跨机器成立的机制性结论（HTTP 行为、语言/运行时语义、协议规范、工具设计缺陷）。**可以直接套用。**
- `[本机]` —— 只在原始主机成立的观测（具体版本号、端口被谁占用、安全软件行为、路径）。**用之前先探测。**

⚠️ 最常见的误用：把 `[本机]` 条目当 `[通病]` 直接照抄，然后在自己的机器上得到"没复现"或"更糟"的结果。
**正确姿势**：先跑条目里的「验证」段落，在你的机器上确认前提，再套用「解法」。

## 2. 检索方式

不要通读。按你的**症状**去查：

```
1. 拿到报错原文 → lessons/README.md 的「按症状查」表 → 命中直接跳转
2. 没有报错、是能力建设（"我要写个 X"）→ 「按主题读」表 → 进对应 lesson
3. 要现成实现 → recipes/ 目录，每个配方都自带 README 说明"你要改哪几行"
```

关键词速查（看到这些就去对应章节）：

| 你遇到 | 去哪 |
|---|---|
| `Permission denied` 开管道 / `spawn` EPERM / `git push` 失败 | `lessons/03-sandbox-stdio-limits.md` |
| PowerShell 脚本变量莫名变 null / 中文乱码 / JSON.parse 失败 | `lessons/02-windows-powershell51.md` |
| `Unable to find type` / `Add-Type` | `lessons/02-windows-powershell51.md` |
| `Iterator is not defined` / `AbortSignal.any is not a function` | `lessons/06-legacy-engine-compat-shim.md` |
| 要写 MCP 服务 / stdio JSON-RPC | `lessons/04-mcp-stdio-bridge-authoring.md` + `recipes/mcp-bridge-minimal/` |
| 浏览器自动化 / 模拟旧内核 / 登录态 | `lessons/05-browser-automation-playwright.md` |
| `Windows Job runner exited` / 进程被误杀 | `lessons/03-sandbox-stdio-limits.md` |
| Godot 无头没画面 / 端口被占 | `lessons/09-godot-automation.md` |
| `database is locked`（SQLite 被运行中的程序锁住） | `lessons/10-zotero-automation.md` |
| `Invoke-WebRequest` 连不上但别的工具能连 | `lessons/11-http-network-troubleshooting.md` |
| 局域网 / 手机访问本机服务 | `lessons/08-lan-reverse-proxy-remote-gui.md` |

## 3. 硬规则（从真实事故里来的）

这些不是建议，是"违反会付出代价"的规则：

1. **绝不要批量 kill 宿主进程**（尤其 `node` / `python` / 以及任何你所在运行时的父进程）。
   杀进程用精确 PID，并先确认它不是托管你的那个进程。
   *事故*：`kill` 掉一批 node 后，宿主 Job runner 被摧毁，整个会话失去后台任务能力。
2. **不要用"看起来成功"当验证**。必须构造**能否证伪**的断言。
   *事故*：验证兼容垫片时，删 API 的代码写成了 `delete eval('globalThis.X')` —— `delete` 不能作用于表达式结果，所以**什么都没删**，测试"通过"是假的。真正的证据是垫片自己报告的 `shimmed: [...]` 数组**非空**。
3. **改完宿主进程的配置/插件后，确认是否需要重启**。很多体系（bundle、插件、路由表）**只在启动时组合一次**，热重载管不到。
4. **破坏性/不可逆操作前先说清楚**：删除、覆盖、切分支（`--force`）、发帖、登录、花钱。
5. **写脚本给人之外的机器跑时，先确认目标 shell 是哪个版本**。以为在 pwsh 7，实际在 PowerShell 5.1，是常见整段翻车的原因。
6. **凭据永不写入被 git 跟踪的文件**。统一走环境变量或 `~/.<app>/<credential-file>`，并在源码里把路径做成可覆盖的常量。

## 4. 复用配方（recipes/）的正确姿势

每个配方目录里有 `README.md`，格式固定：

```
适用场景 / 依赖 / 文件清单
▸ 你要改的地方     ← 逐条列出必须按你环境改的常量
▸ 安装与注册       ← 怎么挂到宿主
▸ 验证             ← 怎么确认真的通了
▸ 已知限制
```

**照抄前先看「你要改的地方」**。配方都是零依赖单文件（除注明外），不需要 `npm install`。

推荐的落地顺序：先把 `recipes/mcp-bridge-minimal/server.mjs` 跑通（它是最小骨架，懂一个就懂全部），
再按需取用具体桥接器。

## 5. 如果你要把本库的经验带回你自己的记忆体系

本库就是为「跨主机复用」设计的，鼓励你这么做：

- **保留环境标记**（`[通病]` / `[本机]`）——把 `[本机]` 条目降级成"某机器上的观测样本"，别当事实。
- **保留「验证」段落** —— 那是最有价值的部分。结论会过期，验证方法不会。
- **带回后补上你自己的验证结果** —— 如果某条在你的环境不成立，你手上就多了一条**反例**，
  它本身也是知识。欢迎以 issue 形式回馈。
- **不要连带复制路径、账号、IP** —— 即使你读到的版本已经脱敏，也请在你自己的笔记里用你自己的占位符。

---

最后：本库所有结论都**可能过期**。每条都标了日期或版本背景。当你的实测与之冲突时，
**以你的实测为准**，并考虑开 issue 告诉我们。
