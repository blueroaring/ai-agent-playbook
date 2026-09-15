# mcp-bridge-minimal —— 最小可跑的 MCP stdio 服务模板

**先跑通这个，再抄别的。** 三个真实桥接器（git / zotero / godot）用的都是这套骨架。

| | |
|---|---|
| **适用场景** | 要给 Agent 宿主补一项沙箱里做不到的能力（需要管道、需要凭据、要在另一个进程语境里干活） |
| **依赖** | Node 18+，**零第三方依赖** |
| **文件** | `server.mjs`（模板）、`selftest.ps1` + `selftest.jsonl`（断言式自测） |

---

## 你要改的地方

| 位置 | 改成什么 |
|---|---|
| `SERVER_NAME` | 你的服务名。宿主通常把工具暴露为 `mcp__<serverName>__<tool>`，**改它等于改所有调用点** |
| `TOKEN_FILE` 默认值 | 你的凭据路径。保持 `~/.<yourapp>/<file>` 的形态，这样换机器不用改代码 |
| `TOOLS` 对象 | 换成你真实的能力。**先删掉三个示例再写**，别留着 |
| `TRACE_FILE` | 调试落盘位置，默认当前目录 |

---

## 跑起来

```bash
# 喂两行 JSON 进去，看它回什么（这是最快的连通性验证）
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node server.mjs
```

**Windows 上请用自测脚本**（它顺手处理了三个 PowerShell 编码坑）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\selftest.ps1
```

预期最后一行是 `ALL CHECKS PASSED`。

---

## 注册到宿主

不同宿主的注册方式不同，通用形态是"告诉宿主：用这个命令启动这个服务"：

```jsonc
{
  "serverName": "minimal",
  "command": "node",
  "args": ["/absolute/path/to/server.mjs"],
  "env": { "BRIDGE_TOKEN_FILE": "/home/<user>/.bridge/token" }
}
```

> ⚠️ **用绝对路径。** 宿主的工作目录通常不是你的脚本目录。
> ⚠️ **注册完先假设需要重启宿主**，然后实测确认（很多体系只在启动时读一次注册表）。

---

## 验证（缺一不可）

- [ ] **服务能独立跑** —— 上面那条 `printf | node` 能拿到 2 条 JSON 响应
- [ ] **自测全绿** —— `selftest.ps1` 输出 `ALL CHECKS PASSED`
- [ ] **stderr 没有 JSON** —— 说明协议没被日志污染
- [ ] 宿主**列出了**你的工具（在 Agent 的工具清单里能看到）
- [ ] **实调一个只读工具成功**
- [ ] **实调一个会失败的工具**，确认 Agent 读到的是**人话**，不是 `[object Object]`

→ 为什么要这么较真：`lessons/01-verification-discipline.md`

---

## 已知限制

- 只实现了 `tools` 能力（`resources` / `prompts` 返回空列表）。需要的话照 `tools/list` 的写法加。
- 没有实现**流式输出**（长任务请返回进度文本，或拆成多个工具调用）。
- `selftest.ps1` 只验证协议层，**不验证你的真实业务逻辑** —— 那部分要自己补断言。
- 并发：这里按"一行一条、顺序处理"实现。你的 `handler` 如果耗时长，宿主的其他调用会排队。

---

## 从模板到真实桥接器

`handler` 里要跑需要管道 stdio 的外部程序时，用 `spawn`，但注意：

```js
import { spawn } from 'node:child_process';

// ✅ 明确用 pipe（这里是**服务进程**和它的子进程之间，不在 Agent 的沙箱里）
const child = spawn('git', ['push'], { stdio: ['ignore', 'pipe', 'pipe'], env: {...} });
```

**这个"服务进程"本身跑在沙箱外**，所以它能用管道 —— 这正是整个方案成立的原因。
详见 `lessons/03-sandbox-stdio-limits.md`。

**凭据传给子进程时不要走 `argv`**（同机进程可见），用环境变量：

```js
env: {
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.extraheader',
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${base64}`,
}
```

参考实现：`recipes/git-mcp/git-mcp.mjs`。
