# 02 · Windows / PowerShell 5.1 环境坑

> **适用范围**：前半部分 `[通病]`（PowerShell 5.1 的固有行为），个别条目标 `[本机]`。
> **先做这一步**：确认你到底在用哪个 PowerShell。**很多翻车源于"以为在 pwsh 7，实际在 5.1"。**

```powershell
$PSVersionTable.PSVersion      # 5.1.x = Windows PowerShell；7.x = PowerShell Core
$PSVersionTable.PSEdition       # Desktop = 5.1 / Core = 7+
```

`[本机]` 观测：某台 Windows 主机上，Agent 运行时的 shell 是 **Windows PowerShell 5.1**，
且机器上**根本没装** pwsh 7（`C:\Program Files\PowerShell\7` 不存在）。
所以"用 pwsh 就好了"这条路当时走不通——必须正面解决 5.1 的坑。

---

## 1. 无 BOM 的 `.ps1` 会被按 ANSI/GBK 解码 `[通病]`

### 症状

脚本里变量**莫名其妙变成 `null`**，或者报出一堆与代码字面完全对不上的语法错误。
把文件另存一次（或换个编辑器打开再保存）就好了——于是你以为是玄学。

### 根因

**Windows PowerShell 5.1 读取没有 BOM 的脚本文件时，按当前系统 ANSI 代码页解码**（中文 Windows 上是 GBK/936），
**不是 UTF-8**。如果你的脚本是 UTF-8 无 BOM 且含中文，字节流会被错误解码：

- 中文注释/字符串里的字节被解释成别的字符，**可能产生引号、括号、换行**等语法元素
- 字符串边界被吃掉 → 后面的语句被吞进字符串里 → 变量"没被赋值" → 读出 `null`

**PowerShell 7 默认按 UTF-8 读，所以这个问题在 7 上不复现**——这正是它最坑的地方：你换个环境测不出来。

### 解法（按推荐度排序）

1. **给这台机器写 `.ps1` 一律纯 ASCII**（最省事、最不容易再踩）。注释用英文。
2. 需要中文 → **存成带 BOM 的 UTF-8**。用记事本"另存为 UTF-8"或显式写入 BOM：

   ```powershell
   [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($true)))
   ```

3. 用 `-Encoding Default` / 显式指定编码去读——但那只解决"读"，不解决"PowerShell 自己解析脚本"。

### 验证

```powershell
# 看文件前三个字节是不是 EF BB BF（UTF-8 BOM）
$bytes = [System.IO.File]::ReadAllBytes('.\script.ps1')[0..2]
($bytes | ForEach-Object { $_.ToString('X2') }) -join ' '
# "EF BB BF" = 有 BOM；否则无 BOM
```

更直接的验证：**故意在注释里写一句中文，运行脚本，看变量是否还正常。**

---

## 2. `Set-Content -Encoding utf8` 会写 BOM，毒害下游 `JSON.parse` `[通病]`

### 症状

PowerShell 生成的 JSON 文件，**Node / Python 读的时候解析失败**：

```
SyntaxError: Unexpected token '', "﻿{"a":1}" is not valid JSON
```

（那个看不见的字符就是 U+FEFF。）

### 根因

**PowerShell 5.1 的 `-Encoding utf8` 含义是"UTF-8 **with** BOM"**（这是 5.1 与 7 的著名语义差异；
7 里 `utf8` 表示无 BOM，`utf8BOM` 才带 BOM）。BOM 落在 JSON 文本最前面，
而 JSON 规范不接受它，多数解析器也不宽容。

### 解法

```powershell
# ❌ PowerShell 5.1 下会写 BOM
Set-Content -Path out.json -Value $json -Encoding utf8

# ✅ 方案 A：显式无 BOM（跨 5.1/7 一致）
[System.IO.File]::WriteAllText($full, $json, (New-Object System.Text.UTF8Encoding($false)))

# ✅ 方案 B：用宿主提供的文件写入工具写数据文件（不经过 PowerShell 编码器）
```

**下游容错也值得做**：如果你的程序要读别人生成的数据文件，**顺手 strip 掉开头的 BOM**：

```js
const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
```

### 验证

```powershell
Format-Hex .\out.json | Select-Object -First 1     # 看是否以 EF BB BF 开头
node -e "console.log(JSON.parse(require('fs').readFileSync('out.json','utf8')))"
```

---

## 3. `Add-Type` 之后，同文件里用不了该类型 `[通病]`

### 症状

```
Unable to find type [System.Drawing.Bitmap].
```

明明**上一行**刚 `Add-Type -AssemblyName System.Drawing`。

### 根因

**PowerShell 在解析阶段（parse time）解析类型字面量 `[Type.Name]`，早于执行阶段。**
脚本整体在 `Add-Type` 执行之前就已经被解析完了，所以解析器当时不知道 `System.Drawing.Bitmap` 是什么。

### 解法

1. **拆成两个脚本文件**：文件 A `Add-Type`，文件 B 使用类型。跨文件时先执行 A 再执行 B，即可。
   （这也是最稳的方式。）
2. 或者避免类型字面量，改用**字符串形式的类型名**，让它延到运行时解析：

   ```powershell
   Add-Type -AssemblyName System.Drawing
   $bmp = New-Object -TypeName 'System.Drawing.Bitmap' -ArgumentList 64, 64
   ```

3. 或者把用到类型的代码块放进 `Invoke-Expression` / 单独 `& { ... }`——但可读性差，不推荐。

### 验证

先跑一次 `Add-Type`，新的 PowerShell 进程里再跑使用类型的脚本，看是否成功——能成立就证明是解析期问题。

---

## 4. `Invoke-WebRequest -MaximumRedirection 0` 遇 3xx 会抛异常，且拿不到响应 `[通病]`

### 症状

想探测一个 URL 是"302 重定向到哪里"，写了：

```powershell
Invoke-WebRequest $url -MaximumRedirection 0
```

结果**抛异常**，而且 catch 里 `$_.Exception.Response` 是 `$null`，
于是只能打印一句没用的"请求失败"。

### 根因

PowerShell 5.1 的 `Invoke-WebRequest` 把"重定向配额用尽"当成**终止性错误**抛出，
且在异常对象里**不保留响应**。它不适合用来做"观察 3xx 本身"这件事。

### 解法：改用 `HttpWebRequest`，显式关掉自动重定向

```powershell
$req = [System.Net.HttpWebRequest]::Create($url)
$req.AllowAutoRedirect = $false
$req.Method = 'GET'
$req.Timeout = 5000
try {
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $loc  = $resp.Headers['Location']
    Write-Output ("HTTP {0} -> {1}" -f $code, $loc)
    $resp.Close()
} catch [System.Net.WebException] {
    # 4xx/5xx 会走到这里，但异常里这次**有** Response
    $r = $_.Exception.Response
    if ($r) {
        Write-Output ("HTTP {0}" -f [int]$r.StatusCode)
        $r.Close()
    }
}
```

### 验证

拿一个**已知会 302 的地址**（例如你自己服务的"登录后跳转"端点）跑一遍，应打印出 `HTTP 302 -> /目标路径`。
修复前同样输入会打印"请求失败"。

---

## 5. `[本机]` WMI 脱离进程树启动脚本：带 `-ExecutionPolicy Bypass` 会静默秒退

### 症状

用 WMI 的 `Win32_Process.Create` 启动一个"脱离当前进程树"的 `powershell.exe`，
`ReturnValue = 0`（表示成功创建），但**脚本完全不执行**，也不写日志。没有任何报错。

### 实测矩阵 `[本机]`

| 启动形式 | 结果 |
|---|---|
| `powershell.exe -File script.ps1`（**不带** Bypass） | ✅ 正常执行 |
| `powershell.exe -ExecutionPolicy Bypass -File script.ps1` | ❌ 进程静默秒退 |
| `powershell.exe -ExecutionPolicy Bypass -EncodedCommand <b64>` | ❌ 静默秒退 |
| `powershell.exe -Command "..."`（裸命令，不带 Bypass） | ✅ 正常 |
| `node.exe script.mjs` | ✅ 正常 |

**推测根因**：该机器上的第三方安全软件（当时装着 360 安全卫士）的主动防御拦截了
"通过 WMI 创建 + 修改执行策略"这个组合特征。**这是推测，不是结论。**

### 解法

用 WMI 脱离进程树启动时，**不要带 `-ExecutionPolicy Bypass`**。
本机 `LocalMachine` 策略是 `RemoteSigned`，本地脚本本来就能跑，Bypass 纯属多余且触发拦截。

```powershell
$cl = [WmiClass]'Win32_Process'
$cl.Create("powershell.exe -NoProfile -File `"$script`"", $null, $null)
```

### 验证

**不要只看 `ReturnValue`。** 让被启动的脚本在**第一步就写一个带时间戳的日志文件**，
然后检查文件是否出现、mtime 是否是刚才。参见 [01](01-verification-discipline.md) 事故 5。

### 排查同类问题的通用启发

> 一个操作"调用了、返回成功、但没效果"时，**怀疑链上多了一个你没意识到的仲裁者**：
> 安全软件、EDR、组策略、AppLocker、容器运行时。
> 换一种等价但特征不同的调用形式（去掉多余参数、换 API、换宿主），往往立刻见分晓。

---

## 6. 控制台中文日志乱码，但数据是对的 `[本机]`

从 Node 等程序往 PowerShell 控制台打中文日志时显示乱码。
**这是显示层（代码页）问题，不是数据损坏**——写到文件里的字节是好的。
用 `[Console]::OutputEncoding` / `chcp 65001` 可以缓解，但如果你能控制输出，
**让程序日志走 ASCII 更省事**。

---

## 7. 把文本**通过管道喂给外部程序**时会乱码：`$OutputEncoding` `[通病]`

### 症状

```powershell
Get-Content -Raw -Encoding UTF8 .\input.jsonl | node .\server.mjs
```

程序收到的是乱码（例如 `你好` 变成 `浣犲ソ`）。**写文件、读文件都正常，只有"喂给外部程序"这条路径坏。**

> 本库的 `recipes/mcp-bridge-minimal/selftest.ps1` 第一版就是这样翻车的 ——
> 服务本身完全正常，是**喂进去的字节**错了。

### 根因

**PowerShell 5.1 的 `$OutputEncoding` 默认不是 UTF-8**（通常是 ASCII/当前 ANSI 代码页）。
**它决定的是"管道另一头是原生程序时用什么编码写字节"**，而不是控制台显示编码。

这就是为什么你会看到两个"看起来相关但不同"的编码问题：

| 变量 | 管什么 |
|---|---|
| `[Console]::OutputEncoding` | **原生程序的输出**怎么被解码显示 |
| `$OutputEncoding` | **PowerShell 喂给原生程序**的字节怎么编码 |

改错一个，问题照旧。

### 解法

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)   # 无 BOM
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-Content -Raw -Encoding UTF8 .\input.jsonl | node .\server.mjs
```

**更省事的替代方案**：**别用管道**，让程序自己读文件：

```powershell
node .\server.mjs --input .\input.jsonl
```

或者用**纯 ASCII 的测试数据**做连通性验证 —— 编码问题与协议问题应当**分开测**，
否则你会在两个变量之间反复横跳。

### 验证

喂一句已知的非 ASCII 文本（`你好`），断言**回显的字节与输入完全一致**。
只在 ASCII 上测过的管道，等于没测。

---

## 8. `$ErrorActionPreference = 'Stop'` + 原生程序的 stderr = 终止性错误 `[通病]`

### 症状

脚本在一句**完全正常**的外部命令调用处崩掉：

```
node.exe : [my-server] ready ...
    + CategoryInfo          : NotSpecified: ([my-server] ready...) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
```

**程序执行成功了**（它的日志就在报错里），但 PowerShell 报了错。

### 根因

`$ErrorActionPreference = 'Stop'` 会把**原生程序写到 stderr 的每一行**提升为**终止性错误**。
而"日志写 stderr"是最佳实践（见 [04](04-mcp-stdio-bridge-authoring.md) 规则 1）——
**两个都对的东西撞在一起，就成了 bug。**

### 解法

**只在那一次原生调用前后临时放宽**，不要全局取消 `Stop`（那会让你自己的错误检查失效）：

```powershell
$saved = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$stdout = Get-Content -Encoding UTF8 .\in.jsonl | & node .\server.mjs 2> .\err.txt
$exit = $LASTEXITCODE
$ErrorActionPreference = $saved
```

**判据**：任何"用 stderr 正常输出日志"的外部程序（Node、Python、git、curl……）
在你的 `Stop` 脚本里都会触发这个。

### 验证

跑一次那个外部命令，**确认脚本没有在它那里中断**，同时 `$LASTEXITCODE` 仍然是正确的退出码。
（注意：`$LASTEXITCODE` 是**原生程序**的退出码，`$?` 是 PowerShell 的成败判断，两者不是一回事。）

---

## 9. 给这台机器写脚本的检查清单

写 `.ps1` 之前过一遍：

- [ ] 目标 shell 是 **5.1 还是 7**？（`$PSVersionTable`，别猜）
- [ ] 文件是**纯 ASCII**，还是**带 BOM 的 UTF-8**？（无 BOM UTF-8 + 中文 = 定时炸弹）
- [ ] 写 JSON/数据文件用的是**无 BOM** 的写入方式吗？
- [ ] 有没有 `Add-Type` 后**同文件**使用该类型？
- [ ] 需要观察 HTTP 3xx 吗？（用 `HttpWebRequest`，不用 `Invoke-WebRequest`）
- [ ] 需要脱离进程树启动吗？（**别带** `-ExecutionPolicy Bypass`）
- [ ] 脚本的"成功"判定，用的是**产物**还是**日志**？
