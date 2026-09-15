#!/usr/bin/env node
/**
 * mcp-bridge-minimal / server.mjs
 *
 * 一个最小可跑的 **MCP stdio 服务**模板。零依赖，单文件，Node 18+。
 * 抄这个文件，把 `TOOLS` 换成你自己的能力，就得到了一个新的桥接器。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * Agent 的运行沙箱常常禁止进程间管道 stdio，导致 `spawn`/`git push`/管道捕获必然失败。
 * 破解办法是：把这类工作挪到**沙箱之外**（宿主侧）跑，Agent 通过工具调用访问它。
 * 而"宿主侧运行 + stdio 通信"正是 MCP 服务的形态。详见 lessons/03。
 *
 * ── 三条铁律（详见 lessons/04）─────────────────────────────────────────
 *   ① stdout 只准放协议消息；所有日志走 stderr。console.log 会污染协议。
 *   ② 工具执行失败要**返回** isError，不要抛异常 —— 让 Agent 能读到原因并自我纠正。
 *   ③ 破坏性操作要有**参数级门禁**（必须显式传 confirm=true），描述只是建议，参数检查才是强制。
 *
 * ── 自测 ────────────────────────────────────────────────────────────────
 *   node server.mjs <<'EOF'
 *   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}
 *   {"jsonrpc":"2.0","id":2,"method":"tools/list"}
 *   EOF
 *   （Windows PowerShell 下用 echo 拼两行 JSON 管道进去，或写一个 .jsonl 文件再 Get-Content | node server.mjs）
 */

import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 配置：一切可被环境变量覆盖 —— 换机器不用改代码
 * ══════════════════════════════════════════════════════════════════════════ */

const SERVER_NAME = process.env.BRIDGE_SERVER_NAME || 'minimal';
const SERVER_VERSION = '1.0.0';

/** 凭据永远从**文件或环境变量**读，绝不写进源码、绝不进 argv（argv 对同机进程可见） */
const TOKEN_FILE = process.env.BRIDGE_TOKEN_FILE
  || join(homedir(), '.bridge', 'token');

/** 调试落盘开关：置 1 后每次请求/响应都追加一行 JSONL，可复现、可回放、可贴 issue */
const DEBUG = process.env.BRIDGE_DEBUG === '1';
const TRACE_FILE = process.env.BRIDGE_TRACE_FILE || join(process.cwd(), 'bridge-trace.jsonl');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 日志：一律 stderr
 * ══════════════════════════════════════════════════════════════════════════ */

function log(...args) {
  process.stderr.write(`[${SERVER_NAME}] ${args.join(' ')}\n`);
}

async function trace(dir, obj) {
  if (!DEBUG) return;
  try {
    appendFileSync(TRACE_FILE, JSON.stringify({ t: Date.now(), dir, ...obj }) + '\n');
  } catch (e) {
    log('trace failed:', e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 工具定义
 *    description 是**给模型看的决策依据**，不是给人看的文档。要写清楚：
 *    做什么 / 参数约束 / 有没有副作用。
 * ══════════════════════════════════════════════════════════════════════════ */

const TOOLS = {
  /** ── 示例 1：无副作用的纯函数，用来验证链路 ── */
  echo: {
    description: '回显输入文本。用于验证服务连通性与参数传递是否正确。无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要回显的文本' },
      },
      required: ['text'],
    },
    handler: async (args) => {
      if (typeof args.text !== 'string') throw new Error('参数 text 必须是字符串');
      return { text: `echo: ${args.text}` };
    },
  },

  /** ── 示例 2：读环境信息，演示"返回结构化文本" ── */
  env_info: {
    description: '返回服务进程的运行环境信息（平台、Node 版本、是否检测到凭据文件）。只读，无副作用。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const { existsSync } = await import('node:fs');
      return {
        text: JSON.stringify({
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          cwd: process.cwd(),
          serverName: SERVER_NAME,
          tokenFile: TOKEN_FILE,
          tokenFileExists: existsSync(TOKEN_FILE),   // ⚠️ 只报告"在不在"，绝不返回内容
        }, null, 2),
      };
    },
  },

  /** ── 示例 3：破坏性操作，演示参数级门禁（照抄这个模式）── */
  delete_thing: {
    description:
      '删除一个"东西"（本模板中为演示，不产生真实副作用）。'
      + ' 不可逆操作，必须显式传 confirm=true，否则拒绝执行。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的对象 ID' },
        confirm: { type: 'boolean', description: '必须为 true，否则拒绝执行（防误调用）' },
      },
      required: ['id', 'confirm'],
    },
    handler: async (args) => {
      if (args.confirm !== true) {
        // 返回 isError 而不是抛异常 —— 让 Agent 读到原因并自己纠正
        return { text: '拒绝执行：需要显式传入 confirm=true', isError: true };
      }
      // 真实实现里，这里是你唯一的破坏性动作。
      // 建议：先记录日志到 stderr（谁在什么时候删了什么）。
      log(`DELETE id=${args.id}`);
      return { text: `已删除 ${args.id}（模板演示，无真实副作用）` };
    },
  },
};

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 协议层
 * ══════════════════════════════════════════════════════════════════════════ */

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id: id ?? null, error });
}

/** 工具返回值 → MCP content 数组 */
function toContent(out) {
  const text = typeof out?.text === 'string' ? out.text : JSON.stringify(out ?? null, null, 2);
  const content = [{ type: 'text', text }];
  return out?.isError ? { content, isError: true } : { content };
}

async function handle(msg) {
  const { id, method, params } = msg;
  await trace('in', msg);

  // 通知（无 id）：不需要响应
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('client initialized');
    return;
  }

  switch (method) {
    case 'initialize':
      return sendResult(id, {
        // 回显客户端给的协议版本，别硬编码得太死（版本不匹配的报错通常很不直观）
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case 'ping':
      return sendResult(id, {});

    case 'tools/list':
      return sendResult(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      const tool = TOOLS[name];
      if (!tool) return sendError(id, -32602, `未知工具: ${name}`);

      try {
        const out = await tool.handler(args);
        const result = toContent(out);
        await trace('out', { id, result });
        return sendResult(id, result);
      } catch (e) {
        // ⚠️ 工具执行失败走 isError（不是 JSON-RPC error），让 Agent 能读到并纠正
        log(`tool ${name} failed: ${e?.message || e}`);
        const result = toContent({ text: `执行失败：${e?.message || String(e)}`, isError: true });
        await trace('out', { id, result });
        return sendResult(id, result);
      }
    }

    // 客户端可能探测的能力，礼貌回"未实现"而不是崩掉
    case 'resources/list':
      return sendResult(id, { resources: [] });
    case 'prompts/list':
      return sendResult(id, { prompts: [] });

    default:
      return sendError(id, -32601, `未实现的方法: ${method}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 传输层：stdin 一行一条 JSON-RPC，stdout 一行一条响应
 * ══════════════════════════════════════════════════════════════════════════ */

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log(`丢弃非 JSON 输入行（长度 ${trimmed.length}）`);   // 脏行直接丢，绝不崩
    return;
  }

  handle(msg).catch((e) => {
    log('handle crashed:', e?.stack || e);
    sendError(msg?.id, -32603, `内部错误: ${e?.message || String(e)}`);
  });
});

rl.on('close', () => {
  log('stdin closed, exiting');
  process.exit(0);
});

// 兜底：任何未捕获异常都不应该让服务静默死掉
process.on('uncaughtException', (e) => {
  log('uncaughtException:', e?.stack || e);
});
process.on('unhandledRejection', (e) => {
  log('unhandledRejection:', e?.stack || e);
});

log(`ready (serverName=${SERVER_NAME}, tools=${Object.keys(TOOLS).join(',')})`);
