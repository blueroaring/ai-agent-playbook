# 04 · 从零写一个 MCP stdio 服务

> **适用范围**：`[通病]`（协议与设计结论跨平台成立）。
> **谁该读**：需要给 Agent 宿主补一项能力、而这项能力在沙箱里做不到的人。
> **配套代码**：`recipes/mcp-bridge-minimal/server.mjs`（最小骨架）、`recipes/git-mcp/`、
> `recipes/zotero-mcp/`、`recipes/godot-mcp/`（三个真实实现，各有不同形态）。

---

## 1. 什么时候该写一个 MCP 服务

命中任意一条，就值得写：

- 某个操作**在 Agent 的沙箱里做不到**（需要管道 stdio、需要启动工作区外的程序）→ 见 [03](03-sandbox-stdio-limits.md)
- 某个操作**需要凭据**，而你不想让凭据经过 Agent 的上下文 / 命令历史 / argv
- 某个操作**要在另一个进程的语境里做**（访问只有运行中程序才持有的资源、跟本机服务对话）
- 某个能力**要重复用很多次**，每次手搓命令既慢又容易错

**反过来说**：一次性的、没有凭据、沙箱里跑得通的操作，**不值得**包成服务。包了是负债。

---

## 2. 骨架：一个 stdio MCP 服务长什么样

### 传输层（30 行就够）

MCP 的 stdio 传输是最朴素的那种：**stdin 一行一条 JSON-RPC 消息，stdout 一行一条响应**。

```js
// 零依赖，Node 18+ 内置
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { continue; }                     // 脏行直接丢，不要让服务崩掉
    handle(msg).catch((e) => {
      send({ jsonrpc: '2.0', id: msg.id ?? null,
             error: { code: -32603, message: String(e?.message || e) } });
    });
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
```

### 必须实现的三个方法

| 方法 | 作用 | 要点 |
|---|---|---|
| `initialize` | 握手 | 回 `protocolVersion`、`capabilities.tools`、`serverInfo` |
| `tools/list` | 告诉宿主你有哪些工具 | 每个工具给 `name` / `description` / `inputSchema`（JSON Schema） |
| `tools/call` | 执行 | 结果放在 `content: [{ type:'text', text }]` 里 |

一个最小 `initialize` 响应：

```js
send({
  jsonrpc: '2.0', id: msg.id,
  result: {
    protocolVersion: msg.params?.protocolVersion || '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'my-bridge', version: '1.0.0' },
  },
});
```

> **协议版本别硬编码得太死**：回显客户端给的版本（或回一个你确定支持的值）。
> 版本不匹配的报错通常很不直观。

---

## 3. 五条实战规则（每条都踩过）

### 规则 1：日志**必须**走 stderr，stdout 只准放协议消息 `[通病]`

**stdout 是协议信道。** 你在里面 `console.log('debug')` 一次，
宿主就会收到一条非 JSON 的行，轻则警告重则握手失败。

```js
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
log('token loaded from', tokenFile);     // ✅
// console.log('anything');              // ❌ 会污染协议
```

**同理**：服务里调用的库如果会往 stdout 打印（很多 CLI 包装会！），
要么重定向，要么换 API 形式。

### 规则 2：工具执行失败要**返回** `isError`，不要抛 `[通病]`

抛异常会让整条调用链以一个不透明的传输层错误结束；返回 `isError` 才能让 Agent
**读到失败原因并自己纠正**（比如"参数写错了，重来"）。

```js
// ✅
return { content: [{ type: 'text', text: `git 失败: ${stderr}\n${stdout}` }], isError: true };

// ❌ 让异常逃到最外层
if (!ok) throw new Error('git failed');
```

**只有协议层面的错误**（未知方法、参数结构不合法）才用 JSON-RPC `error` 对象。

### 规则 3：每个工具都要有**可执行的最小描述**，给 Agent 看 `[通病]`

`description` 不是给人看的文档，是**给模型看的决策依据**。写清楚：

- 这个工具**做什么**（一句话）
- **参数约束**（路径是绝对还是相对？支持通配吗？）
- **有没有副作用**（会不会写文件、推远端、花钱）
- **危险操作是否要求显式确认参数**（见规则 5）

```js
{
  name: 'delete_item',
  description: '把条目移入回收站（可恢复）。必须显式传 confirm=true。',
  inputSchema: {
    type: 'object',
    properties: {
      key:     { type: 'string', description: '条目 ID' },
      confirm: { type: 'boolean', description: '必须为 true，否则拒绝执行' },
    },
    required: ['key', 'confirm'],
  },
}
```

### 规则 4：凭据从**文件或环境变量**读，永不进产物 `[通病]`

```js
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_FILE = process.env.MYAPP_TOKEN_FILE
  || join(homedir(), '.myapp', 'token');    // 可被环境变量覆盖 → 换机器不用改代码
```

- **绝不**把 token 写进源码、写进 git 跟踪的文件、或当成命令**参数**（`argv` 对同机其他进程可见）
- 需要把 token 传给子进程时，用**环境变量**或**配置文件**，不用命令行
- 需要给 HTTPS 请求加认证头时，用**环境变量注入的 git config**，别拼进 URL：

  ```js
  // ✅ token 不进 argv
  env: {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${b64}`,
  }
  ```

`[本机]` 原始实现把凭据文件放在 `~/.<app>/` 下并**用 ACL 限制为仅当前用户可读**（Windows）
/ `chmod 600`（类 Unix）。这一步值得做，成本很低。

### 规则 5：破坏性操作要一道**参数级门禁** `[通病]`

Agent 会在意料之外的时候调用你的工具。凡是不可逆的（删除、强推、覆盖、发布、花钱），
**要求一个必须显式传递的确认参数**：

```js
if (args.confirm !== true) {
  return { content: [{ type: 'text', text: '拒绝：需要 confirm=true' }], isError: true };
}
```

这比"在描述里写请小心"有效一个数量级——描述是建议，参数检查是**强制**。

---

## 4. 调试方法：把流量落到 JSONL

stdio 服务很难用断点调试（stdin/stdout 被宿主占着）。**最有效的办法是落盘**：

```js
const DEBUG = process.env.MY_BRIDGE_DEBUG === '1';
function trace(dir, obj) {
  if (!DEBUG) return;
  fs.appendFileSync(join(dir, 'trace.jsonl'),
    JSON.stringify({ t: Date.now(), ...obj }) + '\n');
}
```

**每次请求和响应都落一行**，然后：

```powershell
Get-Content .\trace.jsonl -Tail 20
```

你能直接看到"宿主到底发了什么参数进来"——**九成的集成问题在这一步就暴露了**，
而且这份 jsonl 是**可复现的证据**（可以贴进 issue、可以在另一个环境重放）。

> 原始实现里三个桥接器都用了 `_selftest.jsonl` / `_bridge.jsonl` 这套落盘自检。
> 它们比任何"我觉得应该没问题"都值钱。

---

## 5. 工具命名：宿主通常有约定

`[本机]` 观测：宿主把 `serverName=X` 的服务工具暴露为 `mcp__X__toolName`。
所以：

- 服务名（`serverName`）要**短、稳定**，改它等于改所有调用点
- 工具名要**动词开头、语义单一**（`create_item` 而不是 `item_ops`）
- 别在工具名里重复服务名（`mcp__git__git_push` 是冗余的）

不同宿主的具体前缀规则不一样，**注册后先用一次工具调用实测一下真实名字**，别照抄。

---

## 6. 注册与生效

注册方式因宿主而异，但**有一条通用规律**：

> 宿主对 MCP 服务的注册表**通常在启动时读取一次**。
> 改完注册配置，**先假设需要重启宿主**，然后实测确认。

`[本机]` 的具体做法（DSH 的 Cordis patch 体系）见 [07](07-dsh-harness-internals.md)。

**验证清单**（缺一不可）：

- [ ] 服务能**独立**跑起来：`node server.mjs` 手动喂一行 `initialize` JSON，看它有没有回响应
- [ ] 宿主**列出了**你的工具（`tools/list` 的内容出现在了 Agent 的工具清单里）
- [ ] **实调**一个只读工具成功
- [ ] **实调**一个会失败的工具，确认错误信息**可读**（不是 `[object Object]`）
- [ ] 检查 stderr 有没有协议污染警告

---

## 7. 最后：什么时候**不要**写

- 宿主已经有等价工具（先去 `tools/list` 里翻，别重复造）
- 只是一次性需求（写个脚本跑完就扔）
- 你还没搞清楚要封装的操作**手动能不能成功**——先手动跑通，再包装

**服务是给"要重复用很多次"的能力用的。**
