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

### 反向坑：**你自己的程序读配置时也必须容忍 BOM** `[通病]`

这是同一枚硬币的另一面，而且更容易漏：你不可能禁止用户用记事本编辑 `config.json`。

**症状**：程序原本好好的，用户用记事本（或你的另一段 PowerShell 脚本）改了一次配置，
程序就再也起不来：

```
json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

**根因**：文件开头被写入了 `EF BB BF`。`json.load(f, encoding="utf-8")` 不会跳过 BOM，
于是第 1 个字符就解析失败 —— 而报错信息只说"第 1 行第 1 列"，看起来像 JSON 写错了，极难联想。

**解法**（两件事一起做）：

```python
# 1) 用 utf-8-sig 读：它在有 BOM 时自动剥离，没有 BOM 时行为与 utf-8 完全一致
with path.open("r", encoding="utf-8-sig") as fh:
    text = fh.read()

# 2) JSON 语法错误要给出**人话**，不要抛裸栈
try:
    return json.loads(text) or {}
except json.JSONDecodeError as exc:
    raise SystemExit(
        f"配置文件 {path} 不是合法 JSON：{exc}\n"
        f"提示：常见原因是漏逗号、用了中文引号，或末尾多了逗号。"
    ) from exc
```

⚠️ 顺带一个陷阱：**你自己写文件时不要用 `Set-Content -Encoding utf8`**（PS 5.1 会加 BOM），
也不要用带 BOM 的写入方式生成给别人读的 JSON。写文件请用无 BOM 的方式
（Python 的 `open(..., encoding="utf-8")`、Node 的 `writeFileSync`、或 write 工具）。

### 验证

```powershell
Format-Hex .\out.json | Select-Object -First 1     # 看是否以 EF BB BF 开头
node -e "console.log(JSON.parse(require('fs').readFileSync('out.json','utf8')))"
```

BOM 容错的证伪式验证（**别只读一遍自己的文件**，要**故意造一个带 BOM 的副本**）：

```python
tmp.write_bytes(b"\xef\xbb\xbf" + real_config.read_bytes())
assert Config.load(tmp).get("app.port") == 8848   # 能读出来才算通过
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

**推测根因**：**第三方安全软件 / EDR 的主动防御**拦截了"通过 WMI 创建进程 + 修改执行策略"这个组合特征。
**这是推测，不是结论** —— 换一台机器请按下面的矩阵实测确认。

### 解法

用 WMI 脱离进程树启动时，**不要带 `-ExecutionPolicy Bypass`**。
本机 `LocalMachine` 策略是 `RemoteSigned`（这是 Windows 常见默认值），本地脚本本来就能跑，Bypass 纯属多余且触发拦截。
**换机器请先查 `Get-ExecutionPolicy -List`，别照搬这个结论。**

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

### 9.1 把"纯 ASCII"做成**机械校验**，不要靠记忆 `[通病]`

第 1 节这条规则的危险之处在于：**中文写在注释里往往不出事**（`REM` / `#` 行被跳过），
于是你误以为"没问题"，直到某天它出现在**字符串或用法示例**里，整个脚本才崩。
只靠"我记住了"必然会复发 —— 正确做法是写完立刻扫一遍字节。

```powershell
# 任何 .ps1 / .bat 写完都跑一次：输出必须是 0
$b = [System.IO.File]::ReadAllBytes(".\scripts\foo.ps1")
"non-ascii = " + (@($b | Where-Object { $_ -gt 127 }).Count)

# 定位到具体行（比看总数有用）
$lines = [System.IO.File]::ReadAllLines(".\scripts\foo.ps1")
for ($i = 0; $i -lt $lines.Count; $i++) {
  $bad = @([System.Text.Encoding]::UTF8.GetBytes($lines[$i]) | Where-Object { $_ -gt 127 })
  if ($bad.Count) { "line $($i+1): $($lines[$i])" }
}
```

**真实复发记录**：这条规则早就写在本库里，我依然在同一台机器上又犯了两次 ——
一次是用法示例里写了 `-Name "文献雷达"`（12 个非 ASCII 字节，藏在注释里所以没崩，
纯属运气），一次是 `.bat` 里把中文 `echo` 放在了 `chcp 65001` **之前**
（cmd 按当前 OEM 代码页解码，中文在 chcp 生效前就已经是乱码）。

`.bat` 的额外注意：`chcp 65001` **只对它之后的输出生效**，所以
**第一行到 chcp 之间不能有任何非 ASCII 内容**（注释也不行）。最省事的做法还是全 ASCII。

### 9.2 语法检查 + ASCII 检查要一起做

```powershell
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors) | Out-Null
if ($errors) { $errors | ForEach-Object { $_.Message } } else { "syntax OK" }
```

**注意**：`ParseFile` 报 OK **不代表**在目标 shell 上能跑 ——
它按当前会话的解码方式读文件。`ParseFile` OK + 字节扫描 0 非 ASCII，
两项都过才算真的安全。

---

## 10. `schtasks /Create` 的默认设置会让笔记本**静默跳过**定时任务 `[通病]`

**症状**：用户抱怨"今天早上没收到邮件/任务没跑"。查日志 —— 什么都没有。查任务 —— 存在、已启用、
但 `LastRunTime` 停在好几天前。**没有任何错误信息**，因为任务压根没启动。

**根因**：`schtasks /Create` 的默认值，对**笔记本**来说全是错的：

| 设置 | schtasks 默认 | 后果 |
|---|---|---|
| `StartWhenAvailable` | `false` | 到点时电脑关着/睡着 → 该次记为 missed，**永远不补跑** |
| `DisallowStartIfOnBatteries` | `true` | **用电池时根本不启动**（笔记本常态） |
| `StopIfGoingOnBatteries` | `true` | 跑一半拔电源就被杀 |
| `WakeToRun` | `false` | 睡眠中的电脑不会被唤醒 |

最阴的地方：**这三项不产生任何报错**，任务只是"没发生"。用户只能自己发现没收到东西，
而排查者的第一反应往往是去怀疑脚本/网络/凭据 —— 方向全错。

**更麻烦的是**：`schtasks.exe` **没有任何开关**能设置 `StartWhenAvailable` 或电池选项
（`/RU` `/RL` `/F` `/Z` 都不管这个）。所以"用 schtasks 注册"这条路本身就不够。

**解法**：用 PowerShell 的 ScheduledTasks 模块显式设置。

```powershell
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument '/c cd /d "C:\path\to\repo" && "C:\path\to\python.exe" -m mytool job >> "C:\path\to\logs\job.log" 2>&1'
$trigger = New-ScheduledTaskTrigger -Daily -At 08:30
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)
# 可选：到点唤醒电脑（笔记本用电池时会吓人，默认关掉）
# $settings.WakeToRun = $true

Register-ScheduledTask -TaskName "MyTask" -Action $action -Trigger $trigger -Settings $settings -Force
```

**注册完必须回读**（不要相信"注册成功"这句话）：

```powershell
(Get-ScheduledTask -TaskName "MyTask").Settings |
  Select-Object StartWhenAvailable, DisallowStartIfOnBatteries, StopIfGoingOnBatteries, WakeToRun
Get-ScheduledTaskInfo -TaskName "MyTask" |
  Select-Object LastRunTime, LastTaskResult, NextRunTime, NumberOfMissedRuns
```

`NumberOfMissedRuns` 是最早能发现问题的信号 —— 它明确告诉你"被跳过过几次"。

**验证**：`Start-ScheduledTask -TaskName "MyTask"` 手动触发一次，确认
`LastTaskResult = 0` **且**目标日志文件的 mtime 真的变了。
（`LastTaskResult = 267011` 或 `0x41303` 都表示"从未运行过"。）

**顺带一条排障顺序**（"到点自动做某事"没发生时）：

```
① Get-ScheduledTaskInfo → 到底跑没跑？（LastRunTime / LastTaskResult / MissedRuns）
② 任务动作里的日志文件 mtime → 跑过就一定会变（cmd 的 >> 会创建/触碰文件）
③ 业务产物（报告/输出文件）目录 → 有产物没邮件 = 下游（网络/凭据）问题；
   产物和日志都没有 = 任务根本没跑，回到 ①
```

**给产品的启示**：凡是"到点自动做某事"的功能，**默认值必须按"用户会关机、会用电池"来设**，
并在设置界面/文档里把"错过怎么办"讲清楚。**静默失败是最差的失败方式。**

**真实案例**：本机 2026-09-15 用 `schtasks /Create` 注册的任务，在 09-16 08:30 没有运行 ——
电脑当时关机，而 `StartWhenAvailable=false`，15:32 开机后也没补跑。
改用 `Register-ScheduledTask` 显式设置后，回读确认三项已修正；手动触发得到
`LastTaskResult=0` + 日志增长 + 报告生成 + 邮件送达。
