# compat-shim —— 旧浏览器内核兼容垫片

让依赖了新 API 的前端在旧内核上**不崩**。一个缺失的 `Iterator` 会让整个插件加载失败，
这个垫片就是那种情况下最便宜的止血手段。

| | |
|---|---|
| **适用场景** | 用户/设备的浏览器版本不可控；某个打包进来的库用了新 API 且**没有做存在性检查** |
| **依赖** | 无。`compat-shim.js` 是纯 ES5 浏览器代码；`inject.mjs` 需要 Node 18+ |
| **文件** | `compat-shim.js`（垫片本体）、`inject.mjs`（注入 HTML 的工具） |

→ 完整原理：`lessons/06-legacy-engine-compat-shim.md`

---

## 你要改的地方

| 位置 | 改成什么 |
|---|---|
| 报告变量名 | 默认 `globalThis.__compatShimmed`。**保留它** —— 它是让测试能被证伪的关键 |
| 补哪些 API | 按你实际遇到的报错增减。**别一次性全塞**，只补你真的撞到的 |
| 注入位置 | `inject.mjs` 默认插到 `<head>` 之后（能早于页面脚本，又能吃到 charset） |

---

## 用法 A：独立部署（静态站点）

把 `compat-shim.js` 放到站点根目录，然后在 HTML 的 `<head>` **最前面**引用：

```html
<head>
  <script src="/compat-shim.js"></script>
  <!-- 其它脚本必须在这之后 -->
</head>
```

**必须在所有其它脚本之前**，否则等你的垫片执行时，页面的 `import` 早就抛错了。

## 用法 B：代理/网关注入（推荐，不用改前端）

```js
import { readFileSync } from 'node:fs';
import { injectCompatShim, isHtml, canRewrite } from './inject.mjs';

const shim = readFileSync('./compat-shim.js', 'utf8');

// 转发请求时：
delete outboundHeaders['accept-encoding'];        // ① 否则上游返回压缩体，你插不进去

// 收到响应后：
if (isHtml(upstreamHeaders) && canRewrite(upstreamHeaders)) {
  body = injectCompatShim(body, shim);
  upstreamHeaders['content-length'] = Buffer.byteLength(body);   // ② 必须重算
}
```

**这两个坑不踩等于没做**（详见 `lessons/06` 第 6 节）：

| 坑 | 症状 |
|---|---|
| 忘了删 `accept-encoding` | 拿到压缩体，`injectCompatShim` 插不进去（或产出损坏响应） |
| 忘了重算 `content-length` | 页面加载一半 / 浏览器一直转圈 |

完整实现见 `recipes/phone-gateway/phone-gateway.mjs`。

---

## 验证：**必须双向**，少一个都不算数

### 方向 A —— 旧内核上真的能跑

```js
await page.addInitScript(() => {
  delete globalThis.Iterator;        // ⚠️ 不能写 delete eval('globalThis.Iterator')
  delete AbortSignal.any;            //    delete 不能作用于表达式结果，那样等于什么都没删
});
await page.goto(url);
// 断言：
//   1. 原来的报错消失了
//   2. globalThis.__compatShimmed.length > 0     ← 核心断言，证明垫片真的动手了
//   3. 控制台 0 错误
//   4. 目标功能真的可用（不是"页面看起来正常"）
```

### 方向 B —— 现代内核上零副作用

开一个**干净的 context**（不带上面的删除脚本），确认：

- `__compatShimmed` 是**空数组**（每项都跳过了）
- 原生实现**没被覆盖**（例如 `Iterator.prototype.join` 仍是库提供的那个函数）
- 应用行为与打垫片之前一致

**方向 B 最容易被跳过，而它是"垫片会不会弄坏好环境"的唯一保证。**

→ 为什么这两步缺一不可：`lessons/01-verification-discipline.md` 事故 1

---

## 已知限制

- **不是 polyfill**。目标是"让依赖库不崩"，实现是最小可用的。
  如果你的应用**真的依赖**这些 API 的完整规范行为，垫片会制造更隐蔽的 bug。
- `Iterator` 的垫片只提供 `join` / `from` / `Symbol.iterator`，其余 helpers（`map`/`take`/……）
  **没有实现** —— 如果有别的库用到，它会继续报错，你按需再补。
- 补 `Iterator` 之后**下一个缺失的 API 会立刻浮出来**（本项目实现里接着撞上了 `AbortSignal.any`）。
  旧内核适配是**迭代**的：修一个、再测、再修一个。
- 会**轻微增加 HTML 体积**（每次请求都内联一遍）。回环/局域网无所谓，公网高流量场景请改成外部脚本引用。
