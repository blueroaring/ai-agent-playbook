# 经验条目索引

12 篇。**不要通读**——按症状或主题检索。

每篇结构统一：`症状 → 根因 → 解法 → 验证`，并在小节标题上标注环境适用范围：

| 标记 | 含义 | 能不能直接套 |
|---|---|---|
| `[通病]` | 机制性结论，换机器一样成立 | ✅ 可以直接套 |
| `[本机]` | 只在原始主机成立的观测 | ⚠️ 先按「验证」段落探测你的机器 |

---

## 按症状查

| 你看到的症状 / 报错 | 去哪篇 |
|---|---|
| `cannot create standard input pipe for ...: Permission denied` | [03](03-sandbox-stdio-limits.md) |
| `spawn ... EPERM`、`cmd \| Select-Object` 失败、`git push` 必失败 | [03](03-sandbox-stdio-limits.md) |
| `Windows Job runner exited ... before proving its managed range empty` | [03](03-sandbox-stdio-limits.md) |
| PowerShell 脚本里变量莫名其妙变成 null / 中文注释把脚本搞坏 | [02](02-windows-powershell51.md) |
| `JSON.parse` 在读取本机生成的 JSON 文件时失败 | [02](02-windows-powershell51.md) |
| `Unable to find type [System.X.Y]`（明明 `Add-Type` 过） | [02](02-windows-powershell51.md) |
| `Invoke-WebRequest` 遇 3xx 抛异常且 `Exception.Response` 为空 | [02](02-windows-powershell51.md) |
| WMI `Win32_Process.Create` 返回 0 但脚本静默不执行 | [02](02-windows-powershell51.md) |
| `Iterator is not defined` / `AbortSignal.any is not a function` / `next.at is not a function` | [06](06-legacy-engine-compat-shim.md) |
| 某个前端插件加载失败，连带整个页面功能崩掉 | [06](06-legacy-engine-compat-shim.md) |
| `database is locked`（SQLite） | [10](10-zotero-automation.md) |
| 本地 API 的写操作全部返回 501 | [10](10-zotero-automation.md) |
| 无头模式跑起来没有画面 / 截不到图 | [09](09-godot-automation.md) |
| 端口明明空着却绑不上（或探测结果骗人） | [09](09-godot-automation.md) |
| 手机 / 局域网设备打不开本机 GUI，或打开了但功能异常 | [08](08-lan-reverse-proxy-remote-gui.md) |
| PWA「添加到主屏幕」拿不到图标/名称/全屏 | [08](08-lan-reverse-proxy-remote-gui.md) |
| `Invoke-WebRequest` 连不上，但别的工具（Node/Bash）能连 | [11](11-http-network-troubleshooting.md) |
| `git push` 报 403 `Permission to ... denied to <你>` | [11](11-http-network-troubleshooting.md) 第 8 节 |
| 改了配置/插件但行为没变 | [07](07-dsh-harness-internals.md) |
| patch 配置写了但不生效 / warning | [07](07-dsh-harness-internals.md) |
| **桥接源码明明改对了，工具仍报旧错误** | [04](04-mcp-stdio-bridge-authoring.md) 第 8 节 |
| 学术 API 429 / 反爬挑战页 / 抓不到论文 | [12](12-literature-source-apis.md) |
| 多源聚合后同一篇论文重复出现 | [12](12-literature-source-apis.md) 第 7 节 |
| 写入外部服务/papers 库后立刻查重查不到 | [12](12-literature-source-apis.md) 第 8 节 |
| 用标题去学术库精确匹配，却匹配错了文章 | [12](12-literature-source-apis.md) 第 5 节 |
| **验证"打开了网页/窗口"时证据全是假的** | [01](01-verification-discipline.md) 事故 6 |
| 用户手改一次配置文件，程序就起不来了（报第 1 行第 1 列） | [02](02-windows-powershell51.md) 第 2 节 |
| `.ps1` / `.bat` 里中文注释让脚本莫名崩掉 | [02](02-windows-powershell51.md) 第 1、9.1 节 |
| **定时任务到点没跑，却没有任何报错** | [02](02-windows-powershell51.md) 第 10 节 |
| 探测返回空/报错，分不清"不存在"还是"查不到" | [01](01-verification-discipline.md) 事故 7 |

## 按主题读

| # | 主题 | 一句话价值 |
|---|---|---|
| [01](01-verification-discipline.md) | **验证纪律**（元经验，建议先读） | 你的"测试通过"有一半概率是假的，这里教你怎么识别 |
| [02](02-windows-powershell51.md) | Windows / PowerShell 5.1 环境坑 | 写 `.ps1` 前必读，能省半天 |
| [03](03-sandbox-stdio-limits.md) | 沙箱的 stdio 与进程限制 | 理解"为什么 `git push` 在沙箱里永远失败"及破局点 |
| [04](04-mcp-stdio-bridge-authoring.md) | 从零写 MCP stdio 服务 | 一个骨架吃遍所有宿主集成 |
| [05](05-browser-automation-playwright.md) | 浏览器自动化 | 复用登录态、模拟旧内核、稳定断言 |
| [06](06-legacy-engine-compat-shim.md) | 旧内核兼容垫片 | 一个垫片救活整个前端 |
| [07](07-dsh-harness-internals.md) | DSH / Cordis 插件体系内部机制 | patch 语义 + 重启边界（DSH 专属，但机制可迁移） |
| [08](08-lan-reverse-proxy-remote-gui.md) | 局域网反代暴露本机 GUI | 含信任围栏、SSE/WS、PWA 的完整清单 |
| [09](09-godot-automation.md) | Godot 自动化 | 无头/录帧/编辑器桥/端口探测 |
| [10](10-zotero-automation.md) | Zotero 文献库读写 | 锁库读、API 写、字段索引 |
| [11](11-http-network-troubleshooting.md) | HTTP / 网络排查顺序 | 换客户端比换网络先试 |
| [12](12-literature-source-apis.md) | 学术数据源 API 的真实行为 | Scholar/arXiv/dblp/OpenAlex/Crossref 的坑与 Zotero 写入 |

## 阅读顺序建议

- **时间紧**：只读 [01](01-verification-discipline.md) + 你的症状那一篇。
- **要建能力**：[04](04-mcp-stdio-bridge-authoring.md) → [03](03-sandbox-stdio-limits.md) → 对应主题篇 → `recipes/`。
- **在 Windows 上写脚本**：[02](02-windows-powershell51.md) 必读，逐条在目标机验证。

---

## 交叉引用约定

条目之间用「见 NN 篇」的形式互指（例如"见 [03](03-sandbox-stdio-limits.md) 第 3 节"）。
若你发现某条的结论与你的实测冲突，请优先相信实测，并参考 [01](01-verification-discipline.md) 第 4 节「怎么处理反例」。
