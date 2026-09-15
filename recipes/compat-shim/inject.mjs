/**
 * inject.mjs —— 把 compat-shim.js 注入 HTML 的小工具（Node，零依赖）
 *
 * 典型用法（反向代理 / 网关里，见 recipes/phone-gateway/）：
 *
 *   import { readFileSync } from 'node:fs';
 *   import { injectCompatShim, isHtml } from './inject.mjs';
 *
 *   const shim = readFileSync('./compat-shim.js', 'utf8');
 *   // …拿到上游响应后：
 *   if (isHtml(upstreamHeaders)) {
 *     body = injectCompatShim(body, shim);
 *     headers['content-length'] = Buffer.byteLength(body);   // ⚠️ 必须重算，见下
 *   }
 *
 * ── 两个必踩的坑（详见 lessons/06 第 6 节）───────────────────────────────
 *   ① 转发请求时**删掉 `accept-encoding`**。否则上游返回压缩体，你没法在里面插字符串。
 *      回环/局域网带宽不是瓶颈，压缩在这里没有价值，而它挡住了你的改写能力。
 *   ② 改完 HTML **必须重算 `content-length`**。长度对不上会导致截断或挂起，
 *      症状很怪（页面加载一半 / 浏览器一直转圈）。
 *
 * ⚠️ 只对 `text/html` 做这个处理，并且只缓冲 HTML；其余响应必须原样流式转发，
 *    否则会毁掉 SSE / 长轮询。
 */

const MARKER = 'data-compat-shim';

/** 这个响应是不是需要注入的 HTML？ */
export function isHtml(headers) {
  const ct = headers['content-type'];
  return typeof ct === 'string' && ct.toLowerCase().includes('text/html');
}

/**
 * 把垫片插到 <head> 的**最前面**（必须早于页面自身的脚本）。
 * 已经插过就原样返回（幂等）。
 *
 * @param {string} html   完整 HTML 文本（必须是**未压缩**的）
 * @param {string} source compat-shim.js 的内容；省略则注入外部脚本标签
 * @param {string} [src]  使用外部脚本时它的 URL
 * @returns {string}
 */
export function injectCompatShim(html, source, src) {
  if (html.includes(MARKER)) return html;   // 幂等

  const tag = source
    ? `<script ${MARKER}>\n${source}\n</script>`
    : `<script ${MARKER} src="${src || '/compat-shim.js'}"></script>`;

  // 优先插到 <head> 之后（能保证早于页面脚本，又能吃到 <head> 里的 meta/charset）
  const headOpen = html.indexOf('<head>');
  if (headOpen >= 0) {
    const at = headOpen + '<head>'.length;
    return html.slice(0, at) + tag + html.slice(at);
  }

  // 没有 <head>：插到 <html ...> 之后
  const htmlOpen = html.indexOf('<html');
  if (htmlOpen >= 0) {
    const tagEnd = html.indexOf('>', htmlOpen);
    if (tagEnd >= 0) return html.slice(0, tagEnd + 1) + tag + html.slice(tagEnd + 1);
  }

  // 连 <html> 都没有（片段）：放最前面
  return tag + html;
}

/**
 * 检查一个响应头集合是否"可改写"。
 * 如果上游已经返回了压缩内容，说明你忘了删 accept-encoding —— 这时应当**放弃注入**，
 * 而不是硬改（硬改会产出损坏的响应）。宁可让旧内核用户看到原报错，也不要给所有用户发垃圾数据。
 */
export function canRewrite(headers) {
  const ce = headers['content-encoding'];
  if (!ce || ce === 'identity') return true;
  return false;
}
