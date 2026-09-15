# 05 · 浏览器自动化（Playwright）

> **适用范围**：机制 `[通病]`；具体参数与目录 `[本机]`。
> **谁该读**：需要让 Agent 真的去操作网页（点按、填表、抓取、调试登录态）的人。

---

## 1. 前提：沙箱通常不让你自己拉起浏览器

`[本机]` 观测：沙箱拒绝执行**工作区外**的可执行文件，`chrome.exe` 在列（见 [03](03-sandbox-stdio-limits.md)）。

**所以浏览器自动化必须由宿主侧已经跑着的 MCP 服务来完成**，不能靠脚本 `Start-Process chrome`。
如果你的宿主自带 Playwright MCP，直接注册它；没有就自己包一个（→ [04](04-mcp-stdio-bridge-authoring.md)）。

---

## 2. 用**系统已装的浏览器**，不要下载 Chromium `[本机]`→`[通病]` 倾向

`@playwright/mcp` 支持指定浏览器通道：

```jsonc
{ "command": "npx", "args": ["@playwright/mcp@latest",
    "--browser", "chrome",
    "--output-dir", "<WORKSPACE>/browser-bridge/shots" ] }
```

**为什么这么做**：

- 机器上通常已经装了 Chrome/Edge，**下载一份 Chromium 是几百 MB 的浪费**
- 系统浏览器的**版本与你日常一致**——这既可能帮你（复现真实环境），也可能坑你（见 [06](06-legacy-engine-compat-shim.md)）
- `[本机]` 上 `ms-playwright` 浏览器包**未安装**，走 `--browser chrome` 直接用系统 Chrome（实测 UA `Chrome/152`）

**先探测再假设**：

```powershell
# 系统浏览器在哪
(Get-Item "$env:ProgramFiles\Google\Chrome\Application\chrome.exe").VersionInfo.ProductVersion
# Playwright 自己的浏览器装了吗
Test-Path "$env:LOCALAPPDATA\ms-playwright"
```

---

## 3. 登录态：用持久 profile 目录

默认每次都是**干净 context**，等于每次都要重新登录。要保住登录态，指定一个**持久用户数据目录**：

```
<LOCALAPPDATA>\ms-playwright-mcp\<profile-name>\
```

`[本机]` 实际的 profile 目录是这个形态（`mcp-chrome-<hash>`）。要点：

- 这个目录**含 cookie 和会话**，属于**敏感数据** —— 别提交、别外传、别写进文档
- profile 被**正在运行的浏览器实例**锁住：想用同一个 profile 起第二个实例会失败
- 想验证"未登录状态下的行为"，就开一个**不指定 profile** 的干净 context

`[本机]` 观测：受控浏览器里访问某视频站时**未登录**——所以"登录态可用"这件事本身也需要**实测确认**，
不要假设 `--browser chrome` 就自动带上了你的日常登录（它带的是这个 profile 的登录，不是你默认 profile 的）。

---

## 4. 操作靠**无障碍快照**，截图只用来给人看

这是最容易用错的一点。

| 手段 | 用途 | 能不能用来选元素 |
|---|---|---|
| **无障碍快照**（accessibility snapshot） | 拿到带 ref 的元素树 | ✅ **这才是操作依据** |
| 截图 | 人眼确认画面、留证据 | ❌ 不能（模型不该靠像素坐标点击） |
| `find`（按文本/正则查找快照节点） | 快照太大时精确定位 | ✅ 便宜且精准 |

**实践流程**：

```
find "登录"  →  拿到 ref  →  click ref  →  快照确认状态变了
```

而不是"截个图看看在哪"。

### 但截图在**验证**环节不可替代

当你要证明的结论是"**画面里真的有这个东西**"时，截图是唯一的证据。
`[本机]` 的经典闭环：

> 编辑器里新增一个节点 → 改属性 → 保存 → **磁盘上的场景文件出现该节点** → **录帧画面里真的出现了那个方块**

右边这两步（磁盘 + 画面）才是硬证据。参见 [09](09-godot-automation.md)。

---

## 5. 调试网页：三个必用能力

| 能力 | 什么时候用 |
|---|---|
| **控制台消息** | 页面"没反应"时的第一站。**先看有没有报错，再猜逻辑** |
| **网络请求列表 + 单请求详情** | 接口 404/403/CORS/被重定向——看请求头和响应体 |
| **`evaluate` 执行 JS** | 读全局状态、探测 API 是否存在、断言 |

`[本机]` 实测的典型用法：

```js
// 探测宿主注入的启动数据里，某一行配置到底是什么
() => window.__DSH_BOOT__.someGraphRow
```

**"控制台 0 错误"本身就是一条有效的验证断言** —— 但注意它不是充分条件
（很多失败是静默的），要配合别的断言用。见 [01](01-verification-discipline.md)。

---

## 6. 模拟旧内核：`addInitScript` 的正确与错误写法

要在现代浏览器上验证"旧内核兼容垫片是否生效"，需要**在页面脚本执行前把现代 API 删掉**：

```js
// ✅ 正确：直接引用（详见 01 事故 1，`delete eval(...)` 是无效操作！）
await page.addInitScript(() => {
  delete globalThis.Iterator;
  delete AbortSignal.any;
});
```

**并且要断言"确实删掉了"**，不能只看页面没报错：

```js
const state = await page.evaluate(() => ({
  shimmed: globalThis.__phoneGatewayShimmed,        // 必须非空
  iterator: typeof globalThis.Iterator.prototype.join,
}));
```

**最容易被忽略的一步：在干净 context 里验证"现代浏览器上垫片是空操作"**：
原生实现**不能**被你的垫片覆盖。`[本机]` 的验证方式是检查
`Iterator.prototype.join` 仍是原生/库的实现（例如那串 `[...this].join` 的特征），
以及 `Iterator.from` 没被替换。

> 完整的双向验证（旧内核能跑 + 新内核零副作用）见 [06](06-legacy-engine-compat-shim.md)。

---

## 7. 多标签页：假设"点击会开新页"

点一个链接，页面在新标签页打开了 —— 你的后续操作还在**旧**上下文里，
于是"点了没反应"。**每次会跳转/开新页的操作之后，重新确认当前页面是谁。**

```js
// 操作后列出标签页，明确选中你要的那个
const tabs = await browser.tabs();
// 选中新标签 → 再继续
```

## 8. 窄屏 / 移动端验证

用**视口尺寸**模拟移动端，成本极低但能抓住一批真问题：

```js
await page.setViewportSize({ width: 412, height: 915 });   // 常见安卓机逻辑分辨率
```

`[本机]` 就是靠这一步在打包前发现"目录选择对话框在窄屏上被挤出可视区"的。
**凡是给手机用的界面，必须在窄屏尺寸下过一遍。**

---

## 9. 配置改了要不要重启？

`[本机]` 观测：改 MCP 服务的启动参数（例如 `--output-dir`）后**无需重启宿主**即生效
（该宿主对这类补丁是 live reload）。**但这是个案，不是通则。**

**通用做法**：改完配置，做一次"改一个可观测的值 → 确认变化"的探测，
再决定要不要重启。不要凭印象。

---

## 10. 安全与边界

- **截图目录属于产物**：可能含个人信息（登录后的界面、聊天记录、订单页）→ **不要提交到任何仓库**
- **持久 profile 是凭据**：等同账号密码
- **自动化操作有副作用**：发帖、下单、签到、删除都是**不可逆**的。
  涉及这些动作前，**先说明再执行**（这是本库的硬规则之一）
- **不要自动化"绕过"任何访问控制**：验证码、风控、付费墙的绕过不是"技术问题"
