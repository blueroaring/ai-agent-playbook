# 07 · DSH / Cordis 插件体系内部机制

> **适用范围**：`[本机]` → 具体包名与配置路径只对 DSH（DeepSeek Harness）成立；
> **机制性结论**（patch 的语义边界、启动时组合、swap point 的互斥性）`[通病]`，
> 你在别的"声明式补丁 + 插件图"体系里会见到同样的形状。
> **谁该读**：要改 DSH 行为、装插件、调 MCP 服务注册的人。

> ### ⚠️ 如果你不用 DSH
> 本篇的具体配置语法（`cordis.patch.yml`、包名、swap point 表）对你**没有直接用处**。
> 但**第 1、2、3 节描述的是可迁移的机制** —— 下面三类问题在任何"插件化框架"里都会重现：
>
> | 机制 | 换个框架长什么样 |
> |---|---|
> | 声明式补丁只能**微调**，不能换实现（`name` 是断言） | 配置合并语义的边界：能改字段 ≠ 能换组件 |
> | 有些东西**只在启动时组合一次**，改了必须重启 | bundle / 插件树 / 依赖图 / 路由表 |
> | **环境自适应判定看不到远端用户**（第 3 节） | 任何"按本机环境自动选实现"的设计 |
>
> **先读这三节，其余按需。**

---

## 1. Patch 的语义边界（最重要的一节）

DSH 用一份 `cordis.patch.yml` 去改启动时的插件图（boot graph）。理解两条规则就够用了：

### 规则 A：`name` 是**断言**，不是"要替换成谁" `[通病]`

```yaml
- id: directory-picker
  name: '@scope/dsh-host-directory-picker-auto'   # ← 断言：必须匹配上才应用
  disabled: true
```

实现上（`applyEntryPatches`）：`name` **不匹配就跳过这条 patch**。

**推论：patch 不能用来"换包"。** 想换掉一个包，你不能写"把 A 换成 B"，
只能：
1. `disabled: true` 把 A 关掉
2. 再 `insert` 一条 B

这是设计者的选择（patch 只做"微调"，不做"重构"），但**不读实现的话极容易误解**。

### 规则 B：解构出来的 `overrides` 会**直接赋值**，所以 `disabled` 一定生效 `[通病]`

内部是 `target[key] = value` 这种形式，因此：

- 任何存在于目标条目上的**简单字段**都可以被覆盖（`disabled`、`config` 里的值……）
- 但**改不了"这条是哪个包"**（那是 `name`，规则 A）

### 实测确认方式（离线，不用重启）

```bash
node <dsh>/lib/bin.js --profile <name> --dump-config
```

看三件事：

- [ ] 目标行是否变成 `disabled: true`
- [ ] 新插入的行**在不在**（且顺序合理）
- [ ] **warning 数量是否为零** ← 有 warning 说明有条 patch 没匹配上，静默失败了

> 📌 `--dump-config` 这类"只打印合并结果、不启动服务"的入口，
> 是排查配置问题**成本最低**的手段。优先找它，别一上来就重启。

---

## 2. 重启边界：哪些东西"只在启动时组合一次"

`[通病]`（具体到 DSH 的观测标 `[本机]`）

| 你改了什么 | 生效方式 |
|---|---|
| **`cordis.patch.yml`**（profile 补丁） | `patchReload: live` → **热生效**；但浏览器端要**刷新一次**才能拿到新启动图 |
| **插件 / bundle**（`dsh plugin add/upgrade`） | ❌ **必须重启宿主进程**。bundle 只在启动时组合 |
| **MCP 服务的注册行** | 随补丁热生效；但服务进程本身由宿主拉起，行为取决于宿主 |
| **工作区内的 MCP 服务源码** | 取决于服务是否常驻；**改了源码要么重启服务要么重启宿主**，别假设自动重载 |

### 关键区别：**配置热生效 ≠ 客户端已更新**

`[本机]` 真实事故：改了目录选择器的 surface（host 已切到 `browse`），
但浏览器里那个页面是**热重载之前**加载的，前端还是旧的 `native` surface → 报

```
directoryPicker.pick needs the native capability; the composed picker serves "browse"
```

**看起来像配置错了，其实只需要 F5。** 记住这条判据：
**"改了配置后立刻出现 surface 不匹配的报错" → 先刷新，再怀疑配置。**

→ 方法论详见 [01](01-verification-discipline.md) 事故 3。

---

## 3. Swap point：一个能力往往由**两张表**组成

`[本机]` 案例：目录选择器（directory picker）。

DSH 的"自适应选择器"内部是**两张映射表**：

```
BACKEND_PACKAGES:  { native: '...host-directory-picker-native', browse: '...host-directory-picker-browse' }
SURFACE_PACKAGES:  { native: '...client-ui-directory-picker-native', browse: '...client-ui-directory-picker-browse' }
```

**结论：要换掉它，两张表都要各插一行（后端 + 前端 surface），少一个就崩。**
（一个管"服务端怎么选目录"，一个管"客户端弹什么界面"。）

### 为什么需要换：auto 的判定表把你的场景判错了

`[本机]` 观测的 boot 采样判定表（大意）：

| 条件 | 判定 |
|---|---|
| bind 地址非 `127.0.0.1`，**或**有 SSH 会话 | `browse` |
| 平台是 `darwin` / `win32` | `native` |
| 其他 | `browse` |

在"Windows + 回环绑定 + 无 SSH"的机器上 → 判成 `native` → 弹**操作系统**的文件夹对话框。
**桌面场景这没问题；但通过反向代理用手机访问时，那个 OS 对话框弹在电脑上，手机上什么也看不到。**
auto 采样的是**本机环境**，它**根本感知不到"真正的用户在远端浏览器里"**。

→ 这是"环境自适应"设计的固有盲区。遇到"自动选择选错了"，先问：
**它的判定依据能不能看到我的真实场景？**

### 代价：两种 surface **互斥**（官方设计）

改用 `browse` 后，**桌面端也改用应用内对话框**。这不是 bug，是"同一批 slot 只能填一种实现"的必然结果。

**在替换前要跟用户说清这个代价** —— 别悄悄改掉他桌面端的习惯。

**验证**：

```js
() => window.__DSH_BOOT__.<graphRow>     // 确认前端拿到的是 browse 那一行
```

配合"**实点一次**，看弹出的是应用内对话框还是 OS 对话框"——**行为验证优于配置验证**。

---

## 4. CLI 不在 PATH 时怎么调 `[本机]`

```powershell
# ❌ Get-Command dsh  → 找不到
# ✅ 用 node 直接跑 CLI 入口
& '<NODE>' '<npx-cache>\node_modules\@deepseek-ai\dsh\lib\bin.js' <子命令> [参数]
```

两条约束：

- `plugin` 子命令**强制要求 `--profile <name>`**（没给会直接报错）
- 装插件时宿主进程必须重启才生效（见第 2 节）

**`[本机]` 附带的坑**：插件包只在**启动时**被组合，而**托管你当前会话的进程不能由你自己杀**
（杀了会话就断了）。→ 正确做法：**告诉用户重启**，或让用户已有的启动器去处理。

→ 更严重的情形（批量 kill 导致宿主运行器被摧毁）见 [03](03-sandbox-stdio-limits.md) 第 3 节。

---

## 5. `--host` 的安全设计：只接受两个值

`[本机]` 观测：

| 输入 | 结果 |
|---|---|
| `--host 127.0.0.1` | ✅ |
| `--host 0.0.0.0` | ❌ 被上层**明确拒绝**，理由原文大意："would expose remote code execution to the network" |
| `--host <局域网 IP>` | ❌ schema 校验失败（枚举里没有） |

**这是**正确的**设计**：这个 GUI 背后是**能执行任意命令的 Agent**，把它绑到 `0.0.0.0`
等于把 RCE 暴露给整个网络。

**推论：想让别的设备访问，正确做法是在本机加一层你自己控制的代理**（→ [08](08-lan-reverse-proxy-remote-gui.md)），
在那层上做认证与访问控制 —— **而不是去改 bind 地址**。

---

## 6. 启动 token 与会话准入 `[本机]`

- Web GUI 的入口带一次性 token（`?token=...`），**每次宿主重启都会变**
- 启动器负责**捕获新 token 并落盘**，供其它工具（网关、二维码）读取
- 监听 GUI 的**宿主进程 PID 会变**（每次重启不同）→ 任何按 PID 写死的逻辑都会失效
- **验证"token 是否有效"的正确方式**：拿它去请求一次，看是否被接受，而不是"文件里有内容就算好"

> 📌 **设计教训**：**让下游只认文件，不认 PID**；让"最新的 token"始终从**一个稳定位置**读取。
> 这句话适用于所有"重启会换句柄"的场景。

---

## 7. 一个 DSH 特有的、值得抄的结构

`[本机]` 的 MCP 注册是在 profile 补丁里加一条 `dsh-mcp-client` 条目：

```yaml
- id: mcp-<name>
  name: dsh-mcp-client
  config:
    serverName: <short-name>          # → 工具名变成 mcp__<short-name>__<tool>
    command: <runtime>
    args: [ '<path-to-mcp-server.mjs>' ]
    env: { ... }
```

**值得抄的设计点**：

1. **服务是自建的单文件零依赖 `.mjs`** —— 升级宿主不会连带破坏它
2. **源码在工作区 + 运行副本在宿主目录** 两份，内容一致 → 开发时改源码，跑的是运行副本
3. **凭据由服务自己从 `~/.<app>/<file>` 读**，不进配置、不进 argv

→ 服务怎么写见 [04](04-mcp-stdio-bridge-authoring.md)。

---

## 8. DSH 排查速查

| 现象 | 首查 |
|---|---|
| 改了 patch 没反应 | 是否 `patchReload: live`？浏览器刷新了吗？`--dump-config` 有没有 warning？ |
| 装了插件没反应 | **重启宿主进程**了吗？（bundle 只在启动时组合） |
| `Unable to find type` / 命令找不到 | CLI 不在 PATH，用 `node <bin.js>` 调（第 4 节） |
| 报 surface / capability 不匹配 | **先刷新页面**（客户端还是旧的启动图），再查配置 |
| 想换掉一个内置实现 | `disabled: true` + `insert`，**别试图用 patch 换包**（第 1 节） |
| 换完少了一半功能 | swap point 是**两张表**（后端 + surface），都插了吗？ |
| 想从别的设备访问 | 别改 bind，加反代 → [08](08-lan-reverse-proxy-remote-gui.md) |
| 重启后连不上 | token 变了；PID 变了 → 从**稳定的文件**读最新值 |
| `cannot modify ...: file has not been read` | 先读后写策略：`read` 与 `edit` 成对下 → [13](13-edit-preconditions.md) |
