#!/usr/bin/env node
/**
 * phone-gateway —— 让手机通过局域网访问只监听 127.0.0.1 的 DSH Web GUI。
 *
 * 背景：DSH 的 web 服务拒绝 `--host 0.0.0.0`（官方理由：会把远程代码执行暴露到网络），
 * 且 /api 有 browser-trust fence（校验 Host / Origin），启动 URL 里的 token 每次重启都会变。
 * 本网关负责三件事：
 *   1. 监听 0.0.0.0:<PORT>，把请求转发给 127.0.0.1:<target>，转发前把
 *      Host / Origin / Referer 重写成 DSH 期望的 loopback authority；
 *   2. `/phone` 入口：读最新的 token 文件，302 到带 token 的地址 —— 手机不必记 token；
 *   3. 可选口令门（key file）：没有正确口令的请求一律 403，防止同网段其他设备碰到 GUI。
 *
 * 零依赖（qrcode 只给启动脚本用）。HTTP、SSE、WebSocket 三种流量都转发。
 *
 * 环境变量：
 *   PHONE_GATEWAY_PORT         网关监听端口（默认 3081）
 *   PHONE_GATEWAY_BIND         网关绑定地址（默认 0.0.0.0）
 *   PHONE_GATEWAY_TARGET_PORT  DSH web 端口（默认 3080）
 *   PHONE_GATEWAY_TARGET_HOST  DSH web 地址（默认 127.0.0.1）
 *   PHONE_GATEWAY_TOKEN_FILE   DSH 启动 token 所在文件（/phone 入口用）
 *   PHONE_GATEWAY_KEY_FILE     口令文件（设了才启用手口令门）
 *   PHONE_GATEWAY_LOG          日志文件路径（可选，仍写 stdout）
 *   PHONE_GATEWAY_QUIET        1 = 不打印每条请求
 */

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

const BIND = process.env.PHONE_GATEWAY_BIND || '0.0.0.0';
const PORT = Number(process.env.PHONE_GATEWAY_PORT || 3081);
const TARGET_HOST = process.env.PHONE_GATEWAY_TARGET_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.PHONE_GATEWAY_TARGET_PORT || 3080);
const TOKEN_FILE = process.env.PHONE_GATEWAY_TOKEN_FILE || '';
const KEY_FILE = process.env.PHONE_GATEWAY_KEY_FILE || '';
const LOG_FILE = process.env.PHONE_GATEWAY_LOG || '';
const QUIET = process.env.PHONE_GATEWAY_QUIET === '1';

/** DSH 的 trust fence 认这个 authority。 */
const AUTHORITY = `${TARGET_HOST}:${TARGET_PORT}`;
const ORIGIN = `http://${AUTHORITY}`;
const KEY_COOKIE = 'pg_key';

/**
 * 不需要口令的路径。
 * 浏览器拉取 Web App Manifest 时**不发送 cookie**（credentials 默认为 omit），
 * 所以口令门必须放过它，否则"添加到主屏幕"拿不到名称 / 图标 / fullscreen 设置。
 * favicon 同理（部分浏览器按 omit 请求）。这些内容不含任何敏感信息。
 */
const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/favicon.svg', '/favicon.ico']);

/**
 * 旧浏览器内核的兼容垫片（注入到 HTML 最前面，只补缺失的 API，已有原生实现时全部跳过）。
 *
 * 已确认踩到的两个坑：
 *   1. `Iterator` —— pdf.js 6.3（被打包进 @deepseek-ai/dsh-client-ui-sidebar-documentpreview）写的是
 *        if (typeof Iterator.prototype.join !== "function") ...
 *      判断里就先碰了 `Iterator.prototype`，却没先确认 `Iterator` 存在 →
 *      旧内核抛 "Iterator is not defined"，该插件加载失败、整页 "Failed to load plugins"。
 *   2. `AbortSignal.any` —— browse 目录选择器用它中止目录扫描（Chrome 116+ 才有）→
 *      旧内核抛 "AbortSignal.any is not a function"，手机上「添加工作区」直接失败。
 *
 * 因此这里一次性补齐常见缺口：Iterator helpers、AbortSignal.any/timeout、
 * Object.hasOwn、Array.prototype.at/findLast/findLastIndex、String.prototype.replaceAll、Promise.any。
 * 每项都先判存在性，所以新浏览器上这段等于空操作。
 * 垫片把自己补过哪些 API 记在 `globalThis.__phoneGatewayShimmed`，便于在 DevTools 里核对。
 */
const COMPAT_SHIM = [
  '<script data-phone-gateway="compat-shim">',
  '(function(){',
  "var missing = [];",
  '  // 1) Iterator helpers (pdf.js 6.3 touches Iterator.prototype.join without checking)',
  "  if (typeof globalThis.Iterator === 'undefined') {",
  '    missing.push("Iterator");',
  '    function Iterator(){}',
  '    Iterator.prototype = Object.create(Object.prototype);',
  '    Iterator.prototype[Symbol.iterator] = function(){ return this; };',
  '    Iterator.prototype.join = function(separator){ return Array.from(this).join(separator === undefined ? "," : separator); };',
  '    Iterator.from = function(iterable){',
  '      var source = (iterable != null && typeof iterable[Symbol.iterator] === "function") ? iterable[Symbol.iterator]() : iterable;',
  '      var wrapper = Object.create(Iterator.prototype);',
  '      wrapper.next = function(){ return source.next(); };',
  '      return wrapper;',
  '    };',
  '    globalThis.Iterator = Iterator;',
  '  }',
  '  // 2) AbortSignal.any / timeout (the browse directory picker aborts its scan with these)',
  "  if (typeof AbortSignal !== 'undefined') {",
  "    if (typeof AbortSignal.any !== 'function') {",
  '      missing.push("AbortSignal.any");',
  '      AbortSignal.any = function(signals){',
  '        var controller = new AbortController();',
  '        var list = Array.from(signals);',
  '        function forward(signal){',
  '          if (signal.aborted) { controller.abort(signal.reason); return true; }',
  '          signal.addEventListener("abort", function(){ controller.abort(signal.reason); }, { once: true });',
  '          return false;',
  '        }',
  '        for (var i = 0; i < list.length; i++) { if (forward(list[i])) break; }',
  '        return controller.signal;',
  '      };',
  '    }',
  "    if (typeof AbortSignal.timeout !== 'function') {",
  '      missing.push("AbortSignal.timeout");',
  '      AbortSignal.timeout = function(ms){',
  '        var controller = new AbortController();',
  '        setTimeout(function(){',
  '          var reason;',
  '          try { reason = new DOMException("signal timed out", "TimeoutError"); } catch (e) { reason = new Error("signal timed out"); }',
  '          controller.abort(reason);',
  '        }, ms);',
  '        return controller.signal;',
  '      };',
  '    }',
  '  }',
  '  // 3) small standard-library gaps older engines still have',
  "  if (typeof Object.hasOwn !== 'function') {",
  '    missing.push("Object.hasOwn");',
  '    Object.hasOwn = function(target, key){ return Object.prototype.hasOwnProperty.call(target, key); };',
  '  }',
  "  if (typeof Array.prototype.at !== 'function') {",
  '    missing.push("Array.prototype.at");',
  '    Object.defineProperty(Array.prototype, "at", { value: function(index){',
  '      var length = this.length >>> 0;',
  '      var k = Math.trunc(index) || 0;',
  '      if (k < 0) k += length;',
  '      return (k < 0 || k >= length) ? undefined : this[k];',
  '    }, writable: true, configurable: true });',
  '  }',
  "  if (typeof Array.prototype.findLast !== 'function') {",
  '    missing.push("Array.prototype.findLast");',
  '    Object.defineProperty(Array.prototype, "findLast", { value: function(predicate, thisArg){',
  '      for (var i = this.length - 1; i >= 0; i--) { if (predicate.call(thisArg, this[i], i, this)) return this[i]; }',
  '      return undefined;',
  '    }, writable: true, configurable: true });',
  '  }',
  "  if (typeof Array.prototype.findLastIndex !== 'function') {",
  '    missing.push("Array.prototype.findLastIndex");',
  '    Object.defineProperty(Array.prototype, "findLastIndex", { value: function(predicate, thisArg){',
  '      for (var i = this.length - 1; i >= 0; i--) { if (predicate.call(thisArg, this[i], i, this)) return i; }',
  '      return -1;',
  '    }, writable: true, configurable: true });',
  '  }',
  "  if (typeof String.prototype.replaceAll !== 'function') {",
  '    missing.push("String.prototype.replaceAll");',
  '    Object.defineProperty(String.prototype, "replaceAll", { value: function(search, replacement){',
  '      if (search instanceof RegExp) {',
  '        if (!search.global) throw new TypeError("replaceAll must be called with a global RegExp");',
  '        return this.replace(search, replacement);',
  '      }',
  '      return this.split(String(search)).join(replacement);',
  '    }, writable: true, configurable: true });',
  '  }',
  '  // 4) Promise.any',
  "  if (typeof Promise.any !== 'function') {",
  '    missing.push("Promise.any");',
  '    Promise.any = function(iterable){',
  '      return new Promise(function(resolve, reject){',
  '        var items = Array.from(iterable);',
  '        var errors = [];',
  '        var pending = items.length;',
  '        function fail(){',
  '          var message = "All promises were rejected";',
  '          if (typeof AggregateError === "function") { reject(new AggregateError(errors, message)); return; }',
  '          var error = new Error(message);',
  '          error.errors = errors;',
  '          reject(error);',
  '        }',
  '        if (pending === 0) { fail(); return; }',
  '        items.forEach(function(item, index){',
  '          Promise.resolve(item).then(resolve, function(error){',
  '            errors[index] = error;',
  '            if (--pending === 0) fail();',
  '          });',
  '        });',
  '      });',
  '    };',
  '  }',
  '  // Leave a breadcrumb so the gateway log / devtools can show what was shimmed',
  "  try { globalThis.__phoneGatewayShimmed = missing; } catch (e) {}",
  '})();',
  '</script>',
].join('\n');

function wantsCompatShim(headers) {
  const contentType = headers['content-type'];
  return typeof contentType === 'string' && contentType.includes('text/html');
}

function injectCompatShim(html) {
  if (html.includes('data-phone-gateway="compat-shim"')) return html;
  const headOpen = html.indexOf('<head>');
  if (headOpen >= 0) {
    return html.slice(0, headOpen + '<head>'.length) + COMPAT_SHIM + html.slice(headOpen + '<head>'.length);
  }
  const htmlOpen = html.indexOf('<html');
  if (htmlOpen >= 0) {
    const tagEnd = html.indexOf('>', htmlOpen);
    if (tagEnd >= 0) return html.slice(0, tagEnd + 1) + COMPAT_SHIM + html.slice(tagEnd + 1);
  }
  return COMPAT_SHIM + html;
}

function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  if (!QUIET) console.log(text);
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, text + '\n');
    } catch {
      /* 日志失败不影响转发 */
    }
  }
}

/** 每次读盘，这样 token / 口令轮换无需重启网关。 */
function readFileTrim(path) {
  if (!path) return '';
  try {
    return fs.readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function currentKey() {
  return readFileTrim(KEY_FILE);
}

function currentToken() {
  return readFileTrim(TOKEN_FILE);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

/** 日志里不要把 token 明文写出来。 */
function sanitize(url) {
  return String(url).replace(/(token=)[^&]*/gi, '$1***').replace(/(k=)[^&]*/gi, '$1***');
}

function sendDenied(res) {
  res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    '<!doctype html><meta charset="utf-8"><title>403</title>' +
      '<body style="font-family:system-ui;background:#111;color:#eee;padding:2rem">' +
      '<h1 style="font-size:1.2rem">403 · 需要口令</h1>' +
      '<p>这个地址只给已配对的手机会话使用。请用电脑上启动脚本给出的二维码扫码进入，' +
      '或在 URL 后面带上 <code>?k=口令</code>。</p></body>',
  );
}

/**
 * 把浏览器发出的头改写成"来自本机 loopback"的样子。
 * 只动 Host / Origin / Referer —— 其余原样透传。
 */
function rewriteRequestHeaders(headers, remoteAddress) {
  const out = { ...headers };
  out.host = AUTHORITY;

  // 让上游不压缩：网关要改写 HTML 注入垫片，压缩流没法直接改。回环网络，压缩无价值。
  delete out['accept-encoding'];

  if (out.origin) out.origin = ORIGIN;
  if (typeof out.referer === 'string' && out.referer.length > 0) {
    try {
      const ref = new URL(out.referer);
      out.referer = ORIGIN + ref.pathname + ref.search;
    } catch {
      out.referer = ORIGIN;
    }
  }

  const prior = out['x-forwarded-for'];
  out['x-forwarded-for'] = prior ? `${prior}, ${remoteAddress}` : String(remoteAddress);
  out['x-forwarded-proto'] = 'http';
  out['x-forwarded-host'] = out['x-forwarded-host'] || headers.host || '';
  return out;
}

/**
 * 改写响应头：
 *  - 去掉 Set-Cookie 上的 Domain（否则手机浏览器域不匹配会丢）
 *  - 去掉 Secure（网关是 http，带 Secure 的 cookie 会被丢弃）
 *  - 去掉 HSTS（避免手机被强制 https 后连不上）
 */
function rewriteResponseHeaders(headers) {
  const out = { ...headers };

  if (out['set-cookie']) {
    const list = Array.isArray(out['set-cookie']) ? out['set-cookie'] : [out['set-cookie']];
    out['set-cookie'] = list.map((cookie) =>
      cookie
        .split(';')
        .filter((part) => {
          const key = part.trim().toLowerCase();
          return !key.startsWith('domain=') && key !== 'secure';
        })
        .join(';'),
    );
  }

  delete out['strict-transport-security'];
  return out;
}

const server = http.createServer((req, res) => {
  const remote = req.socket.remoteAddress || '?';
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }

  // 口令门（PWA 元数据豁免，见 PUBLIC_PATHS）
  const key = currentKey();
  if (key && !PUBLIC_PATHS.has(url.pathname)) {
    const cookies = parseCookies(req.headers.cookie);
    const provided = url.searchParams.get('k') || cookies[KEY_COOKIE] || '';
    if (provided !== key) {
      log(`DENIED ${sanitize(req.url)} (${remote})`);
      sendDenied(res);
      return;
    }
    if (url.searchParams.has('k')) {
      // 把口令换成 cookie，之后的请求（含静态资源）就不用再带 k
      url.searchParams.delete('k');
      const rest = url.searchParams.toString();
      res.writeHead(302, {
        location: url.pathname + (rest ? `?${rest}` : ''),
        'set-cookie': `${KEY_COOKIE}=${encodeURIComponent(key)}; Path=/; HttpOnly; Max-Age=31536000; SameSite=Lax`,
        'cache-control': 'no-store',
      });
      log(`PAIRED key accepted (${remote})`);
      res.end();
      return;
    }
  }

  // 手机入口：自动补上当前 token，手机永远不用记 token
  if (url.pathname === '/phone') {
    const token = currentToken();
    const location = token ? `/?token=${encodeURIComponent(token)}` : '/';
    res.writeHead(302, { location, 'cache-control': 'no-store' });
    log(`PHONE entry -> ${token ? 'handed out fresh token' : 'NO TOKEN FILE (falls back to /)'} (${remote})`);
    res.end();
    return;
  }

  const proxyReq = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers: rewriteRequestHeaders(req.headers, remote),
    },
    (proxyRes) => {
      log(`${req.method} ${sanitize(req.url)} -> ${proxyRes.statusCode} (${remote})`);

      if (wantsCompatShim(proxyRes.headers)) {
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          const html = injectCompatShim(Buffer.concat(chunks).toString('utf8'));
          const headers = rewriteResponseHeaders(proxyRes.headers);
          delete headers['transfer-encoding'];
          headers['content-length'] = Buffer.byteLength(html);
          res.writeHead(proxyRes.statusCode || 502, headers);
          res.end(html);
        });
        proxyRes.on('error', () => res.destroy());
        return;
      }

      res.writeHead(proxyRes.statusCode || 502, rewriteResponseHeaders(proxyRes.headers));
      proxyRes.pipe(res);
      proxyRes.on('error', () => res.destroy());
    },
  );

  proxyReq.on('error', (err) => {
    log(`UPSTREAM ERROR ${req.method} ${sanitize(req.url)}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end(`phone-gateway: DSH web (${AUTHORITY}) 不可达：${err.message}\n`);
  });

  req.pipe(proxyReq);
  req.on('error', () => proxyReq.destroy());
});

// WebSocket / 其它 Upgrade 流量：手工转发握手与后续字节流
server.on('upgrade', (req, socket, head) => {
  const remote = req.socket.remoteAddress || '?';

  const key = currentKey();
  if (key) {
    let upgradedUrl;
    try {
      upgradedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    const provided = upgradedUrl.searchParams.get('k') || cookies[KEY_COOKIE] || '';
    if (provided !== key) {
      log(`DENIED WS ${sanitize(req.url)} (${remote})`);
      socket.destroy();
      return;
    }
  }

  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const headers = rewriteRequestHeaders(req.headers, remote);
    const lines = [`GET ${req.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`);
      } else {
        lines.push(`${name}: ${value}`);
      }
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length > 0) upstream.write(head);
    log(`WS ${sanitize(req.url)} -> upstream (${remote})`);
  });

  upstream.on('error', (err) => {
    log(`UPSTREAM WS ERROR ${sanitize(req.url)}: ${err.message}`);
    socket.destroy();
  });
  socket.on('error', () => upstream.destroy());

  socket.pipe(upstream).pipe(socket);
});

// SSE / 长连接不能被超时切断
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

server.on('error', (err) => {
  log(`GATEWAY FATAL: ${err.message}`);
  process.exitCode = 1;
});

server.listen(PORT, BIND, () => {
  log(
    `phone-gateway listening on http://${BIND}:${PORT} -> http://${AUTHORITY}` +
      (KEY_FILE ? ` | key file: ${KEY_FILE}` : ' | no key gate') +
      (TOKEN_FILE ? ` | token file: ${TOKEN_FILE}` : ' | no token file'),
  );
});
