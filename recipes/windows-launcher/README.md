# windows-launcher —— 启动器与二维码脚本

两个 `.ps1`，把"手机能连上"这件事压缩成**双击一次**。

| | |
|---|---|
| **适用场景** | Windows 上的桌面启动器：拉起后端、拉起网关、算出局域网地址、出二维码 |
| **依赖** | Windows PowerShell 5.1+；可选 `qrcode`（npm，仅出码时需要） |
| **文件** | `start-phone-access.ps1`（拉起 + 出码）、`show-phone-qr.ps1`（只重算出码） |

> ⚠️ **这两个脚本是 [DSH](../../lessons/07-dsh-harness-internals.md) 专用的**（它们要抓 `dsh web` 的启动 token）。
> 但其中的**几个模式是可迁移的**，见下面第 3 节。

---

## 1. 两个脚本的分工

| 脚本 | 什么场景用 | 行为 |
|---|---|---|
| `start-phone-access.ps1` | 开机 / 服务没起 | 拉起后端 → 抓 token → 起网关 → 出二维码 |
| `show-phone-qr.ps1` | 通道已在跑，只想要码 | **不重启后端**，重算 LAN IP → 出码 → 打开图片 |

这个分工很重要：**"重新出码"不应该顺带重启后端**（重启会换 token、会打断正在进行的会话）。

### `start-phone-access.ps1` 的开关

| 参数 | 作用 |
|---|---|
| `-WebPort` / `-GatewayPort` | 端口（默认 3080 / 3081） |
| `-NoRestart` | 后端已在跑时不做重启 |
| `-NoBrowser` | **不打开**本机 GUI |
| `-NoQr` | **不生成**二维码（只把通道准备好） |

> `-NoQr` 只跳过出码，**手机通道照旧就绪**（网关、token、入口 URL 全部正常）。
> 别把它误当成"什么都不做"。

### 桌面快捷方式的分工（本机实际用法）

| 快捷方式 | 参数 | 效果 |
|---|---|---|
| `DeepSeek Harness` | `-NoQr` | 只开 DSH + 打开电脑端 GUI，**不出码** |
| `DSH 二维码` | → `show-phone-qr.ps1` | 只出码 |

**一个真实教训**：最初两个快捷方式**都只出码不打开 GUI**。
根因是启动器在"服务已在监听"的分支里只做"复用 + 起网关 + 出码"，**不会打开浏览器**。
修法是把"打开浏览器"从分支里挪出来，**无条件执行**（除非传了 `-NoBrowser`）。

→ 一般化的教训：**"复用已有实例"和"启动新实例"两条分支，必须产出同样的用户可见结果。**
否则用户会遇到"第二次点没反应"这种最难查的问题。

---

## 2. 你要改的地方

**路径已经参数化了**（不再有硬编码的机器路径），按需用环境变量覆盖：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `%USERPROFILE%\.dsh` | 配置与运行时文件的根目录 |
| `NODE_EXE` | PATH 上的 `node.exe` | Node 可执行文件 |
| `DSH_BIN` | PATH 上的 `dsh`，否则搜 npm/npx 缓存 | DSH CLI 入口 |
| `DSH_BRIDGE_DIR` | 脚本同目录 → 否则 `<DSH_HOME>\tools` | 网关脚本所在目录 |

**网关目录的解析顺序**值得注意：先看脚本旁边有没有 `phone-gateway.mjs`，
没有再回退到 `<DSH_HOME>\tools`。这样**同一份脚本既能从项目目录跑，也能从部署目录跑**。

另外要改的：

- **入口路径**：`/phone`（若你的网关用了别的路径，同步改）
- **二维码里放的 URL 形态**：`http://<LAN_IP>:<GatewayPort>/phone?k=<口令>`
- **口令文件**：`<DSH_HOME>\phone-key.txt`（首次运行应自动生成一个随机口令）

---

## 3. 可迁移的四个模式

即使你不用 DSH，这四个做法也值得抄：

### ① 出码前**重算**局域网地址

换 Wi-Fi、DHCP 续约都会改变 IP。**别缓存入口地址。**
脚本里的做法是优先取 `WLAN*` 接口的 IPv4，再回退到有默认网关的接口，并排除 `169.254.*`（APIPA）。

### ② 二维码用**两段式写入**绕开文件锁

```
先渲染到 phone-qr-new.png（暂存）
  → 尝试覆盖 phone-qr.png（稳定路径）
  → 被看图程序锁住时，自动回退显示暂存副本
```

**为什么**：图片查看器常常**锁住**正在显示的文件。直接覆盖会失败，
而"失败"在用户眼里就是"二维码没出来"。

### ③ 启动器要**自检并打印证据**

脚本末尾会核对四项：后端在监听 / 网关在监听 / token 已捕获 / **token 被后端接受**，
并打印结果。最后一项尤其重要 —— **"文件里有 token"不等于"token 能用"**。

### ④ `dsh` 不在 PATH 时的动态定位

不要写死某个 npx 缓存的哈希目录（`_npx\1e7f6d95...` 这种路径**换个机器就没了**）。
脚本的做法是：`dsh` on PATH → 否则**递归搜索 npx 缓存**找 `@deepseek-ai/dsh/lib/bin.js`。

---

## 4. 验证

- [ ] `start-phone-access.ps1 -NoQr -NoBrowser` → 自检四项全绿，且**没有生成新二维码**
      （用**文件 mtime 前后一致**来断言，不要只看输出里有没有 QR 字样 —— 见
      `lessons/01-verification-discipline.md` 事故 5）
- [ ] 单独跑 `show-phone-qr.ps1` → 二维码生成并打开
- [ ] **重启后端口号变了**的情况下，入口仍能自动补上新 token
- [ ] 未配对访问 → 403

---

## 5. 已知限制

- **纯 ASCII**，这是**故意的**：Windows PowerShell 5.1 会把无 BOM 的 `.ps1` 按 ANSI 解码，
  含中文的脚本会解析崩溃（→ `lessons/02-windows-powershell51.md` 第 1 节）。
  如果你要加中文，**必须存成带 BOM 的 UTF-8**。
- **不要用 `Start-Process -WorkingDirectory ... -Wait` 跑依赖 `cwd` 的 Node 脚本** ——
  实测会 `ExitCode=1` 且不产出文件。改成"直接调用 + `Push-Location`"。
- **绝不要批量 kill `node` 进程**。会连宿主自己的后台任务运行器一起杀掉，**不可逆**。
  详见 `lessons/03-sandbox-stdio-limits.md` 第 3 节。
- 出二维码需要 `qrcode` 包（`npm i qrcode`）。脚本用 `process.cwd()` 解析模块，
  所以要用 `Push-Location` 或从装了包的目录调用。
