# 配方目录 —— 可以直接抄走跑的实现

每个配方都是**零依赖、单文件优先**，不需要 `npm install`（例外会标注）。
每个目录里的 `README.md` 固定包含：**适用场景 / 依赖 / 你要改的地方 / 安装与注册 / 验证 / 已知限制**。

> ⚠️ **照抄前先看「你要改的地方」那一节。** 里面有按你环境必须改的常量（路径、端口、凭据位置）。
> 所有凭据都走**环境变量或 `~/.<app>/<file>`**，源码里没有、也不该有任何密钥。

---

## 怎么选

| 配方 | 一句话 | 依赖 |
|---|---|---|
| [`mcp-bridge-minimal/`](mcp-bridge-minimal/) | **先看这个**。最小可跑的双向 stdio MCP 服务模板，自带断言式自测 | Node 18+ |
| [`compat-shim/`](compat-shim/) | 旧浏览器内核兼容垫片 + HTML 注入工具 | 无（浏览器 + Node） |
| [`git-mcp/`](git-mcp/) | Git / GitHub 的 MCP 服务：认证、建仓、提交、推送 | Node 18+ + `git` |
| [`zotero-mcp/`](zotero-mcp/) | Zotero 文献库读写 MCP 服务（SQLite 快照读 + Web API 写） | **Node 22+**（用到内置 `node:sqlite`） |
| [`godot-mcp/`](godot-mcp/) | Godot 自动化 MCP 服务：CLI 桥 + 编辑器插件桥 | Node 18+ + Godot 4.x |
| [`phone-gateway/`](phone-gateway/) | 局域网反向代理网关：把只绑回环的 GUI 安全地给手机用 | Node 18+ |
| [`windows-launcher/`](windows-launcher/) | Windows 启动器 / 二维码脚本（配套 phone-gateway） | PowerShell 5.1+，`qrcode` |

## 推荐的上手顺序

```
1. mcp-bridge-minimal   ← 跑通它，你就懂了所有桥接器的骨架（约 10 分钟）
2. 你真正需要的那一个    ← 按上表挑
3. compat-shim          ← 只有当你要服务版本不可控的浏览器时才需要
```

## 这些配方共享的三条设计约定

1. **零依赖单文件 `.mjs`** —— 升级宿主不会连带破坏它们
2. **凭据只从文件/环境变量读**，路径是可覆盖的常量；绝不写进源码、绝不进 `argv`
3. **破坏性操作要显式 `confirm` 参数** —— 描述是建议，参数检查是强制

→ 为什么这样设计：`lessons/04-mcp-stdio-bridge-authoring.md`

## 关于 `selftest`

`mcp-bridge-minimal/` 带一套**断言式自测**（`selftest.ps1` + `selftest.jsonl`），
它不只是"跑一下不报错"，而是逐条核对协议语义（`initialize` 返回值、`isError` 语义、
stderr 有没有污染协议……）。**把这套做法带进你自己的桥接器** ——
自测落盘的 JSONL 比任何"我觉得应该没问题"都值钱。
