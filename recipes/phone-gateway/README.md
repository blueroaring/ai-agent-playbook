# phone-gateway —— 局域网反向代理网关

把**只监听回环**的服务安全地开放给手机 / 局域网内其它设备，而不去动被代理服务的绑定地址。

| | |
|---|---|
| **适用场景** | 后端服务出于安全**拒绝**绑 `0.0.0.0`（背后是能执行命令的 Agent），但你需要在手机上用它 |
| **依赖** | Node 18+。**零第三方依赖** |
| **文件** | `phone-gateway.mjs`（单文件，反向代理 + 口令门 + 兼容垫片注入） |

→ 完整方案与踩坑：`lessons/08-lan-reverse-proxy-remote-gui.md`

---

## 架构

```
手机 / 其它设备
     │  http://<LAN_IP>:3081/...
     ▼
┌──────────────────────────────────────────┐
│ phone-gateway  (绑 0.0.0.0)              │
│  · 口令门（cookie）                       │
│  · Host/Origin/Referer 重写              │
│  · token 自动补全                         │
│  · 旧内核兼容垫片注入（改 HTML）          │
│  · HTTP / SSE / WebSocket 转发            │
└──────────────────┬───────────────────────┘
                   │  http://127.0.0.1:3080    ← 后端保持最严格绑定
                   ▼
             原始服务（不动它）
```

---

## 你要改的地方

| 位置 | 改成什么 |
|---|---|
| `PORT` | 网关监听端口，默认 `3081` |
| `TARGET_HOST` / `TARGET_PORT` | 被代理的服务，默认 `127.0.0.1:3080` |
| `PUBLIC_PATHS` | **免认证白名单**。默认 `/manifest.webmanifest`、`/favicon.svg`、`/favicon.ico` |
| `KEY_COOKIE` | 口令 cookie 名 |
| 垫片内容 | `COMPAT_SHIM` 是**内联**的，与 `recipes/compat-shim/compat-shim.js` 同源但变量名不同（`__phoneGatewayShimmed`）。改一处记得同步 |

### 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PHONE_GATEWAY_BIND` | `0.0.0.0` | 监听地址 |
| `PHONE_GATEWAY_PORT` | `3081` | 监听端口 |
| `PHONE_GATEWAY_TARGET_HOST` | `127.0.0.1` | 被代理服务地址 |
| `PHONE_GATEWAY_TARGET_PORT` | `3080` | 被代理服务端口 |
| `PHONE_GATEWAY_TOKEN_FILE` | — | 后端入口 token 文件（**用于自动补全新 token**） |
| `PHONE_GATEWAY_KEY_FILE` | — | 口令文件；**设了才启用手口令门** |
| `PHONE_GATEWAY_LOG` | — | 日志文件 |
| `PHONE_GATEWAY_QUIET` | — | `1` = 安静模式 |

---

## 四个关键机制

### ① 必须重写 `Host` / `Origin` / `Referer`

否则过不了后端的来源校验（防 DNS rebinding / CSRF），表现为"页面能开、接口全挂"。

> ⚠️ **这等于主动关掉了后端的一道防线。**
> 所以认证**必须**由网关来补（②）—— 只做头重写不做认证，就是造了个洞。

### ② 口令门（cookie）

未配对请求一律 403；`/<entry>?k=<口令>` 首次访问即配对。

**必踩的漏网**：浏览器拉 **PWA manifest / favicon 时不带 cookie** →
❌ 图标拿不到、名称空白、没有全屏。

**解法**：把这几个**静态、公开、无副作用**的路径加入白名单（`PUBLIC_PATHS`）。
**不要为了省事豁免任何 API。**

### ③ token 自动补全

后端每次重启换 token。网关从**固定文件**读最新 token 并自动补上，
让 token 轮换对用户完全透明。

> 通用原则：**会变的东西在系统里只有一个权威来源**，其它组件都从它读，
> 谁都不许自己缓存一份。

### ④ 注入垫片时必须改两个头

| 动作 | 不改会怎样 |
|---|---|
| 转发时 `delete accept-encoding` | 拿到压缩体，插不进 HTML |
| 改完 HTML 重算 `content-length` | 页面加载一半 / 浏览器一直转圈 |

**只对 `text/html` 缓冲改写，其余原样流式转发**（否则会毁掉 SSE）。

---

## 跑起来

```powershell
$env:PHONE_GATEWAY_KEY_FILE = "$env:USERPROFILE\.dsh\phone-key.txt"
$env:PHONE_GATEWAY_TOKEN_FILE = "$env:USERPROFILE\.dsh\dsh-web-token.txt"
$env:PHONE_GATEWAY_LOG = "$env:USERPROFILE\.dsh\phone-gateway.log"
node phone-gateway.mjs
```

**Windows 还要放行入站端口**（需要管理员）：

```powershell
New-NetFirewallRule -DisplayName 'Phone Gateway (TCP 3081)' -Direction Inbound `
  -Protocol TCP -LocalPort 3081 -Action Allow
```

启动器与二维码生成见 `recipes/windows-launcher/`。

---

## 验证清单

- [ ] 从**局域网地址**（不是回环）完整加载页面
- [ ] **WebSocket / SSE 长连接建立**（看网关日志里的 upgrade 记录 + 浏览器控制台）
- [ ] 所有 API 请求 200，且**控制台 0 错误**
- [ ] 未配对访问 `/` 和入口路径 → **403**
- [ ] 带口令入口 → 自动补 token → 进入 GUI（全链路）
- [ ] **重启后端后**（token 变了、PID 变了），入口仍能自动补上**新** token
- [ ] 窄屏（如 412×915）下功能可用
- [ ] PWA「添加到主屏幕」拿到名称 / 图标 / 全屏
- [ ] **白名单里只有静态资源，没有任何 API**

---

## 已知限制

- **只在局域网内使用。跨公网请走 VPN**，不要把端口映射到公网。
  （已有 WireGuard / 企业 VPN 就直接复用。）
- 局域网 IP 会变（换 WiFi / DHCP 续约）→ **入口地址每次都要重算**，别缓存。
- 口令门是**单一口令 + cookie**，不是多用户体系。别把它当成正式的身份认证。
- 后端升级后如果改了 HTML 结构或入口路径，注入/补 token 的逻辑可能需要跟着调。
- **`node_modules` 之类不要提交**：本文件零依赖，别把调试时装的包带进仓库。
