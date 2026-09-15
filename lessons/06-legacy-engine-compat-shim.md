# 06 · 旧内核兼容垫片 —— 一个缺失的 API 如何炸掉整个前端

> **适用范围**：`[通病]`（这是前端打包与浏览器 API 演进的结构性问题，任何"给旧浏览器兜底"的场景都会遇到）。
> **谁该读**：任何要支持"用户浏览器版本不可控"的 Agent。
> **配套代码**：`recipes/compat-shim/`。

---

## 1. 症状：一个跟你的功能完全无关的报错

用户（或另一台设备）打开页面，看到：

```
Failed to load plugins — failed to import loader entry (@scope/dsh-client-ui-sidebar-documentpreview):
Iterator is not defined
```

**注意报错指向的是一个"文档预览侧边栏"插件** —— 跟用户想做的事毫无关系。
用户的实际诉求可能只是"我想在手机上打开这个界面"。

**关键点**：**一个插件的加载失败，导致整个前端功能不可用。**
这是打包体系的设计后果，不是用户的操作问题。

---

## 2. 根因：依赖库在"判断条件"里访问了可能不存在的对象

排查到具体代码：

```js
// 某打包进来的库（pdf.js 6.x）里的写法：
if (typeof Iterator.prototype.join !== 'function') {
  Iterator.prototype.join = function () { /* ... */ };
}
```

**问题出在 `Iterator.prototype` 这个表达式本身**：它在 `typeof` 的左边，
但要先求值 `Iterator.prototype` 才能取 `typeof`。如果 **`Iterator` 这个全局对象根本不存在**，
求值阶段就直接抛 `ReferenceError: Iterator is not defined` —— 后面的 `typeof` 检查形同虚设。

> 📌 **可迁移的模式**：*"存在性检查"如果本身访问了待检查对象的属性，它就不是存在性检查。*
> 正确写法是 `typeof Iterator !== 'undefined' && typeof Iterator.prototype.join !== 'function'`，
> 或者 `typeof Iterator?.prototype?.join !== 'function'`。
> **在 Code Review 里这是一个高价值模式** —— 你会在很多"兼容代码"里见到它的错误版本。

### 为什么这个 API 会不存在

`Iterator` 及其 helpers（`.map` / `.filter` / `.take` / `.join` …）是较新的标准：

| 引擎 | 支持起始版本（数量级参考） |
|---|---|
| Chrome / Edge（Chromium） | 约 122+ |
| Safari | 约 18+ |
| Firefox | 约 131+ |
| 各类国产/定制内核（常基于较老的 Chromium） | 经常缺失 |

**所以"桌面 Chrome 好好的，手机上就崩"是这个问题的典型表现** ——
你在一台新引擎的机器上开发，故障只在旧引擎设备上出现。

---

## 3. 定位手法：全量搜索"这个 API 的所有出现点"

面对"某个 API 在旧引擎不存在"的问题，**先确定爆炸半径**：

```bash
# 在打包产物 / node_modules 里搜所有出现点
rg "Iterator\." --glob '*.js' -n
```

`[本机]` 实测结果：**整个客户端 bundle 里 `Iterator.*` 只出现这一处**。

**这个结论改变了整个方案**：
如果出现了 50 处，方案是"升级依赖 / 换库"；
只有 1 处，方案就变成"**在入口处补一个垫片**" —— 成本极低、风险极小。

> 📌 **先量化再决策。** "撒网式搜一遍"这个动作，比读文档、猜影响面快得多。

---

## 4. 解法：在哪一层补垫片

| 方案 | 优点 | 缺点 |
|---|---|---|
| 改 `node_modules` 里的库源码 | 直接 | ❌ **下次升级就丢**，且改的是第三方代码 |
| 提 PR 给上游 | 根治 | ❌ 慢，且你需要的只是"现在能用" |
| 换掉依赖库 | 彻底 | ❌ 成本高，可能引发别的问题 |
| **在请求路径上注入垫片**（网关 / Service Worker / 模板） | 不碰依赖、升级不丢、可随时撤 | 需要能在 HTML 交付路径上动手 |

**选择注入层的前提**：确认**所有受影响的客户端都必经这一层**。
`[本机]` 的选择是**局域网网关**（→ [08](08-lan-reverse-proxy-remote-gui.md)），
理由是"手机访问必经网关，桌面回环直连不受影响"——**这恰好也限制了影响面**。

---

## 5. 垫片的正确形态（四条设计原则）

```js
(function () {
  if (typeof window === 'undefined') return;
  const done = [];

  // ① 逐项：先判存在，缺了才补
  if (typeof globalThis.Iterator === 'undefined') {
    // ② 补最小可用实现，不要试图复刻完整规范
    globalThis.Iterator = class Iterator { /* ... */ };
    done.push('Iterator');
  }
  if (typeof globalThis.Iterator?.prototype?.join !== 'function') {
    globalThis.Iterator.prototype.join = function (sep) { return [...this].join(sep); };
    done.push('Iterator.prototype.join');
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
    AbortSignal.any = function (signals) { /* ... */ };
    done.push('AbortSignal.any');
  }
  // … Object.hasOwn / Array.prototype.at / String.prototype.replaceAll / Promise.any …

  // ③ 自我报告：让"垫片是否生效"可被断言（见 01 事故 1）
  globalThis.__myShimmed = done;
})();
```

**四条原则**：

1. **逐项存在性检查** —— 现代浏览器上是**空操作**，不会覆盖原生实现（这是安全底线）
2. **补最小实现，不复刻规范** —— 你的目标是"让依赖库不炸"，不是"提供一个完整的 polyfill"。
   过度实现会引入新 bug
3. **自我报告**（`globalThis.__xShimmed = [...]`）—— **这是让测试能被证伪的关键**。
   没有它，你无法区分"垫片正确跳过"和"垫片压根没跑"（见 [01](01-verification-discipline.md) 事故 1）
4. **零依赖、可内联** —— 垫片必须在**任何其他脚本之前**执行，所以它必须能塞进 HTML 里

### `[本机]` 实际补的清单

| API | 谁需要它 |
|---|---|
| `Iterator` + `prototype.join` | 打包进来的 pdf.js |
| `AbortSignal.any` / `AbortSignal.timeout` | 目录选择器（用它中止目录扫描） |
| `Object.hasOwn` | 多处 |
| `Array.prototype.at` / `findLast` / `findLastIndex` | 多处 |
| `String.prototype.replaceAll` | 多处 |
| `Promise.any` | 多处 |

**注意第二行**：补完 `Iterator` 之后，**下一个缺失的 API 会立刻浮出来**。
旧内核适配往往是**迭代**的 —— 修一个、再测、再修一个。别指望一次补全。

---

## 6. 在 HTML 交付路径上注入的两个工程细节 `[通病]`

如果你要在代理/网关层改写 HTML 以注入垫片，有两个几乎必然踩到的坑：

### ① 必须**去掉 `accept-encoding`**，否则拿到的响应是压缩的

上游看到客户端支持 gzip/br，就会返回压缩体。你要在中间插一段 `<script>`，
就得先解压、改写、再重新压缩 —— 除非你**主动声明"我不接受压缩"**。

```js
delete headers['accept-encoding'];   // 回环/局域网网络，压缩收益本来就微不足道
```

### ② 改完 HTML 必须**重算 `content-length`**

缓冲区长度变了但头没改 → 客户端按旧长度读取 → **截断或挂起**（而且症状很怪：
页面加载一半、或浏览器一直转圈）。

```js
res.setHeader('content-length', Buffer.byteLength(newBody));
```

**只对 `text/html` 做这个处理，并且要缓冲完整响应**（流式转发与 HTML 改写天然冲突）。

---

## 7. 验证：必须双向，缺一不可

### 方向 A：旧内核上能用（修复生效）

```js
await page.addInitScript(() => {          // ⚠️ 不能用 delete eval(...)，见 01
  delete globalThis.Iterator;
  delete AbortSignal.any;
  // ...
});
await page.goto(url_with_shim);
// 断言：
//   1. 原报错消失（"Failed to load plugins" 不再出现）
//   2. globalThis.__myShimmed 的长度 > 0   ← 核心断言
//   3. 控制台 0 错误
//   4. 目标功能真的可用（目录选择器真的弹出来了）
```

### 方向 B：新内核上零副作用（没有污染）

**开一个干净的 context**（不要带上面的 `addInitScript`），确认：

- `__myShimmed` 是**空数组**（每项都跳过了）
- 原生实现**没被覆盖**（例如 `Iterator.prototype.join` 仍等于库提供的那个函数，
  `Iterator.from` 仍是原生）
- 应用行为与打垫片之前**完全一致**

**方向 B 最容易被跳过**，而它恰恰是"垫片会不会把好环境搞坏"的唯一保证。

### 方向 C：确认垫片的作用范围符合设计

`[本机]` 的额外确认：**走回环直连（不经网关）时 `__myShimmed` 为 `null`** ——
证明垫片只作用于网关路径。**如果你声称"影响面被限制住了"，就要有证据。**

---

## 8. 什么时候不要用垫片

- **缺失的 API 是应用的核心依赖**（例如整套 ES2022 语法）→ 应该升级运行环境或做构建期降级
- **旧引擎份额极小、且你有能力推动升级** → 别背兼容债
- **补起来的实现与规范行为差异很大，而应用依赖那些差异** → 垫片会制造更隐蔽的 bug

**垫片是"让不兼容的依赖库停止崩溃"的止血手段，不是"支持旧浏览器"的战略。**
