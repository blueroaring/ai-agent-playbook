# 11 · HTTP / 网络排查：**先换客户端，再怀疑网络**

> **适用范围**：`[通病]`（方法论）+ `[本机]`（具体是哪两个客户端行为不一致）。
> **谁该读**：遇到"连不上"、但不确定是网络问题还是工具问题的 Agent。

---

## 1. 事故：同一台机器上，两个 HTTP 客户端结论相反 `[本机]`

### 症状

用 PowerShell 请求一个 HTTPS 地址：

```
Invoke-WebRequest : 基础连接已经关闭: 发送时发生错误。
```

**看起来像网络不通 / 目标站挂了。**

### 但是

同一台机器、同一个 URL，**用 Node 的 `fetch` 请求完全正常**。

### 结论

**"网络不通"这个判断是错的。** 是**那个客户端**有问题。
如果当时没换客户端就下结论，接下来会去查 DNS、查路由、查防火墙 —— **全是在错误的方向上花时间**。

---

## 2. 正确的排查顺序

```
① 换一个客户端重试          ← 几乎总是第一步，且最便宜
② 换协议 / 换地址形式        http↔https、域名↔IP、localhost↔127.0.0.1
③ 测 TCP 层连不连得上        （把"连不上"和"请求被拒"分开）
④ 查代理配置（分客户端！）
⑤ 查 TLS / 证书
⑥ 最后才是 DNS / 路由 / 防火墙
```

**为什么"换客户端"排第一**：它花 10 秒，却能立刻把问题**一分为二**：

- 换了客户端好了 → **是本客户端的问题**（继续查 ④⑤）
- 换了客户端还不行 → **确实是链路/服务端的问题**（继续查 ③⑥）

**没有这一步，你根本不知道自己在查哪一类问题。**

---

## 3. 手边要有的三个"独立客户端"

```powershell
# ① Node（[本机] 上最可靠的参照物）
node -e "fetch('https://example.com').then(r=>r.text()).then(t=>console.log(r.status, t.length))"

# ② curl（Windows 10+ 自带 curl.exe，注意要写 .exe，避免撞上 PowerShell 的 curl 别名）
curl.exe -sS -o NUL -w "%{http_code}\n" https://example.com

# ③ 纯 TCP 层（不涉及 HTTP/TLS，用来判断"端口通不通"）
Test-NetConnection example.com -Port 443 | Select-Object TcpTestSucceeded
```

**三个客户端的实现栈完全不同**：

| 客户端 | 实现 | 受什么影响 |
|---|---|---|
| PowerShell `Invoke-WebRequest` | **.NET Framework**（5.1） | 系统 TLS 默认值、WinINET 代理、证书存储 |
| Node `fetch` | Node 自己的 undici + OpenSSL | `HTTP_PROXY` 等环境变量 |
| `curl.exe` | libcurl | 自己的 CA 包、自己的代理变量 |

**它们"结论不一致"是正常现象，而且这个不一致本身就是最有价值的线索。**

---

## 4. PowerShell 5.1 的 HTTPS：两个高频原因

### ① 默认 TLS 版本太老

PowerShell 5.1 跑在 .NET Framework 上，**默认的 `SecurityProtocol` 可能不包含 TLS 1.2/1.3**，
而现代站点**已经关掉了 TLS 1.0/1.1** → 握手失败 → "基础连接已经关闭"。

```powershell
# 看当前值
[Net.ServicePointManager]::SecurityProtocol

# 临时抬高（只影响当前进程）
[Net.ServicePointManager]::SecurityProtocol = `
    [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
```

> 注意 `Tls13` 在老的 .NET Framework 上可能不存在，直接引用会抛枚举错误 → 用 `Tls12` 起步。

### ② 代理配置分两套，改一套没用

Windows 上**至少有两套代理设置**，不同客户端读不同的：

| 设置 | 谁读它 |
|---|---|
| **WinINET**（"Internet 选项"里的代理） | PowerShell / .NET / IE / 多数桌面程序 |
| **WinHTTP** | 系统服务、部分后台程序 |
| `HTTP_PROXY` / `HTTPS_PROXY` **环境变量** | Node、curl、多数跨平台工具 |

```powershell
# 看 WinINET 代理
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' |
    Select-Object ProxyEnable, ProxyServer, ProxyOverride
# 看 WinHTTP 代理
netsh winhttp show proxy
```

**"浏览器能上网但脚本不能"、"Node 能但 PowerShell 不能"经常就是这一条。**

---

## 5. `localhost` vs `127.0.0.1`：一个静默的坑 `[通病]`

`localhost` 可能被解析成 **`::1`（IPv6）**，而你的服务**只监听了 `127.0.0.1`（IPv4）** →
**连接被拒**，但"看起来是 localhost"。

**规则**：

- **连自己机器上刚起的服务** → 明确写 `127.0.0.1`，别写 `localhost`
- **配信任围栏 / CORS 白名单** → 两者通常被当成**不同的源**，要确认服务接受哪一个
  （`[本机]` 的目录选择器与 token 校验就区分这两个来源）

```powershell
# 确认服务到底监在哪个地址
Get-NetTCPConnection -LocalPort 3080 -State Listen | Select-Object LocalAddress, OwningProcess
```

---

## 6. 其他常见"看起来像网络问题"的原因

| 现象 | 真实原因 |
|---|---|
| 页面/接口返回旧数据 | **缓存**。加 `?v=<时间戳>` 或换无痕窗口验证 |
| 只在某个客户端失败 | 客户端实现差异（TLS/代理/头过滤）—— 见上 |
| 只在某个站失败 | 目标站有反爬/风控/WAF，或证书链该客户端不认 |
| 请求被重置（RST） | **安全软件/EDR 在做 TLS 拦截**，或上游主动砍连接 |
| 局域网设备访问不了 | **防火墙入站规则**（→ [08](08-lan-reverse-proxy-remote-gui.md) 第 7 节） |
| 服务刚重启就连不上 | 还没监听上（**加等待 + 断言端口在监听**，别用固定 sleep 猜） |

---

## 7. 验证：怎么证明"网络是好的"

不要用"某个请求成功了"来证明网络好 —— 证明力太弱。分层断言：

```powershell
# 第 1 层：TCP 可达
Test-NetConnection <host> -Port 443 | Select-Object -ExpandProperty TcpTestSucceeded

# 第 2 层：TLS 握手成功（用独立客户端）
curl.exe -sS -o NUL -w "tls=%{ssl_verify_result} code=%{http_code}\n" https://<host>/

# 第 3 层：HTTP 语义正确（状态码 + 内容长度非零）
node -e "fetch('https://<host>/').then(async r=>console.log(r.status, (await r.text()).length))"
```

**三层都过 → 才可以说"这个客户端到那个服务的链路是通的"。**
只跑一层就下结论，就是 [01](01-verification-discipline.md) 里说的"看起来成功"。

---

## 8. 认证类 403 的分层诊断：以 `git push` 被拒为例 `[通病]`

### 症状

```
remote: Permission to <OWNER>/<REPO>.git denied to <USER>.
fatal: unable to access 'https://github.com/<OWNER>/<REPO>.git/': The requested URL returned error: 403
```

**这句话极具误导性**：它说"denied to **<你的用户名>**"，于是你会去查**用户**的权限。
而真实原因绝大多数是**凭据（token）自身的授权范围**，跟用户的角色无关。

### 先排除三个错误结论

| 你以为 | 实际 |
|---|---|
| "我的账号没有这个仓库的写权限" | ❌ 角色几乎肯定没问题，见下面的陷阱 |
| "token 的仓库访问范围没勾上这个仓库" | ❌ **范围不对会返回 404，不是 403** |
| "是 credential helper 里存了旧凭据" | ⚠️ 有可能，但**必须实测排除**，别猜 |

### 三层诊断（每层都只回答一个问题）

```bash
# ① 认证本身有没有过？—— 只读操作
git ls-remote https://github.com/<OWNER>/<REPO>.git
#   成功（退出码 0）→ 凭据有效、仓库可见、网络通。问题被限定在"写"上。

# ② 写有没有被授权？—— dry-run，不会真的改动远端
git push --dry-run origin <BRANCH>

# ③ 是不是别的凭据在捣乱？—— 显式禁用 credential helper 再试一次
git -c credential.helper= push --dry-run origin <BRANCH>
#   仍然 403 → 就是这个 token 的授权不够（而不是 helper 里的旧凭据）
#   变好了   → 问题在 helper 存的凭据上，去改它
```

**读通过 + 写 403 ⇒ 凭据的权限问题。** 这是本文档最有价值的一条判据。

### ⚠️ 陷阱：API 的 `permissions` 字段会骗你

```bash
curl -H "Authorization: Bearer $TOKEN" https://api.github.com/repos/<OWNER>/<REPO>
```

返回里会有：

```json
"permissions": { "admin": true, "maintain": true, "push": true, "triage": true, "pull": true }
```

**这个 `push: true` 说的是"你这个用户在仓库里的角色"，不是"这个 token 被授予了什么"。**
拿它判断"token 能不能推"会得到完全错误的结论 —— 我们就是这么被骗了一轮。

> 📌 **可迁移的规则**：*当你用一个"身份令牌"去读"权限信息"时，先问清楚
> 这份权限信息描述的是**谁**的权限 —— 是令牌主体的角色，还是令牌本身的授权范围。*
> 二者在委托/代理模型里是**不同的东西**，而 API 往往只返回前者。

### 修复（GitHub fine-grained PAT）

```
Settings → Developer settings → Personal access tokens → 选中该 token
  ├─ Repository access : 选中目标仓库，或 "All repositories"
  └─ Permissions → Repository permissions → Contents : Read and write   ← 关键
```

- `Contents: Read` → 读全部通过、写全部 403（就是本节的症状）
- **改权限不会改变 token 字符串** → 通常**不需要**更新你的凭据文件
- 之后要推 workflow 文件的话还需要 `Workflows: Read and write`（一般不用）

### 顺带：别把 token 放进 URL 或命令行

```bash
# ❌ token 出现在 argv 里，同机任何进程都能读到（Get-CimInstance Win32_Process 就能看）
git push https://x-access-token:<TOKEN>@github.com/<OWNER>/<REPO>.git

# ✅ 通过环境变量注入 git config，不进 argv、不进仓库配置、不进 remote URL
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=http.extraheader
export GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"
git push origin <BRANCH>
```

`git ls-remote` 与 `git push` 用的是**同一份凭据** —— 所以第 ① 层能成功、第 ② 层失败时，
你可以确信"凭据没配错、只是权限不够"，而不用去查网络和代理。

---

## 9. 速查

| 现象 | 先做 |
|---|---|
| 连不上，不知道怪谁 | **换个客户端重试**（Node / curl.exe / Test-NetConnection） |
| PowerShell HTTPS 失败，别的正常 | `SecurityProtocol` 抬到 Tls12；查 WinINET 代理 |
| Node 失败，别的正常 | 查 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量 |
| 本机服务连不上 | 用 **`127.0.0.1`** 而不是 `localhost`；确认监听地址 |
| 想确认端口是否真的被占 | `Get-NetTCPConnection -State Listen`（**不要**用"能不能连上"推断） |
| 浏览器里行为诡异 | 无痕 / 清缓存 / cache-bust 参数 |
| 局域网访问不了 | 防火墙**入站**规则 |
