# tools -- 本仓库的维护工具链

三个文件，负责"**自动同步 + 泄露门禁 + 定时推送**"。

| 文件 | 作用 |
|---|---|
| `publish.ps1` | 发布流水线：同步配方源码 → **泄漏扫描（硬门禁）** → 记录待蒸馏日志 → 提交 → 推送 |
| `publish-config.json` | 配置：同步映射、分支、作者。**不含任何密钥或账号名** |
| `redact-rules.json` | 泄漏扫描规则（通用正则）。**故意公开** —— 让脱敏保证可被审计 |
| `install-scheduled-task.ps1` | 安装 / 卸载 / 立即运行那个计划任务 |

---

## 数据流

```
<workspace>\agent-memory\journal.md      ← 原始工作日志（含个人上下文，永不发布）
            │
            │  ①机械部分：publish.ps1 只记录"新增了 N 行，待蒸馏"
            │     → 写入 .local/pending-distill.md（gitignored）
            │
            │  ②判断部分：由 Agent 在会话里把新踩的坑蒸馏成
            │     四段式（症状→根因→解法→验证）经验条目
            ▼
agent-experience\lessons\ + recipes\     ← 已脱敏的发布内容
            │
            │  ③publish.ps1：同步源码 → 扫描 → commit → push
            ▼
        GitHub
```

**为什么 ① 不自动做？** 机械搬运无法判断"什么值得沉淀、怎么归因、边界在哪"，
只会把含个人上下文的原文搬到公开仓库。**能自动化的自动化，需要判断力的留给会话。**

---

## 用法

```powershell
# 干跑：同步 + 扫描 + 报告，不提交不推送
powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -DryRun

# 正常发布
powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1

# 只扫不推（审查用）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -NoPush

# 跳过源码同步（只发布文档改动）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -NoSync
```

**退出码**：`0` = 正常 / 无变化 · `1` = 出错 · **`2` = 被泄漏扫描拦下（未提交未推送）**

---

## 泄漏门禁是怎么工作的

### 三层防线

| 层 | 位置 | 内容 |
|---|---|---|
| **通用规则** | `tools/redact-rules.json`（公开） | Windows/Unix 家目录路径、私有 IP、GitHub/OpenAI/AWS 令牌形态、私钥块 |
| **本机敏感词** | `.local/sensitive-terms.txt`（**gitignored**） | 账号名、局域网 IP、主机名等**机器特有的字面量** |
| **白名单** | `redact-rules.json` 的 `allowMatch` | 占位符（`<LAN_IP>`、`C:\Users\<`）、文档示例 IP（RFC 5737）、`example.com` 等 |

**为什么敏感词要单独放一个本地文件？** 因为规则文件本身是公开的 ——
把账号名写进规则文件，等于**用泄露来防泄露**。所以：**通用模式公开，机器字面量本地。**

### 两种严重级别

- **`deny`** → 命中即**拒绝推送**，退出码 2，详细报告写到 `.local/leak-report.txt`（含原文，故不入库）
- **`warn`** → 只报告，不拦。用于"大概率正常但要人看一眼"的模式（邮箱、疑似硬编码密钥）

### 报告不入库

`.local/leak-report.txt` **故意写成包含命中原文** —— 那正是你要看的。
所以它必须被 gitignore。**别把它复制到别处。**

---

## 计划任务

```powershell
# 安装（默认每 3 天 10:00 跑一次）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-scheduled-task.ps1

# 换个间隔
... -IntervalDays 2

# 立刻跑一次并等它结束
... -RunNow

# 卸载
... -Remove
```

**安装完请做这一步**（不要只看"任务已注册"）：

```powershell
Get-ScheduledTask -TaskName 'AI-Agent-Playbook-Publish' | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName 'AI-Agent-Playbook-Publish' | Select-Object LastRunTime, LastTaskResult
Get-Content .local\publish.log -Tail 20
```

**断言"真的跑了"要看 `publish.log` 有没有新增行**，而不是看任务状态。
（`LastTaskResult = 0` 只说明进程退出码是 0 —— 而"脚本没执行"也常常表现为 0。
详见 `lessons/02-windows-powershell51.md` 第 5 节与 `lessons/01-verification-discipline.md` 事故 5。）

---

## 在另一台机器上复刻

1. `git clone` 本仓库
2. `Copy-Item tools\sensitive-terms.example.txt .local\sensitive-terms.txt`，填**你自己的**敏感字面量
3. 设置凭据：`PLAYBOOK_TOKEN_FILE` 指向你的 PAT 文件，或放在 `<DSH_HOME>\github-token`
4. `git remote set-url origin <你的仓库>`（远端地址不入库，只在本机 `.git/config`）
5. `tools\install-scheduled-task.ps1`

**凭据永远不进 argv** —— `publish.ps1` 通过 `GIT_CONFIG_*` 环境变量把认证头传给 git，
而不是把 token 拼进 URL 或命令行（同机进程能读到命令行）。
