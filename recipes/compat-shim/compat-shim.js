/*
 * compat-shim.js —— 旧浏览器内核兼容垫片（浏览器端，零依赖）
 *
 * 用途：让依赖了新 API 的前端在旧内核上不崩。
 * 详见 lessons/06-legacy-engine-compat-shim.md
 *
 * ── 使用方式 ────────────────────────────────────────────────────────────
 *   A. 直接内联进 HTML（推荐，必须早于任何其它 <script>）：
 *        <script data-compat-shim>/* 本文件内容 *\/</script>
 *   B. 作为外部脚本，放在 <head> 最前面：
 *        <script src="/compat-shim.js" data-compat-shim></script>
 *   C. 由代理/网关注入 → 见同目录 inject.mjs
 *
 * ── 设计原则 ────────────────────────────────────────────────────────────
 *   1. 逐项存在性检查 —— 现代内核上是彻底的空操作，绝不覆盖原生实现
 *   2. 只补最小可用实现，不复刻完整规范（目标是不崩，不是提供 polyfill）
 *   3. 自我报告补了哪些 → globalThis.__compatShimmed（数组）
 *      ⚠️ 这是让测试能被证伪的关键：空数组 = 全都跳过了；非空 = 真的补了。
 *         没有它，你无法区分"垫片正确跳过"和"垫片压根没跑"。
 *         详见 lessons/01-verification-discipline.md 事故 1
 *   4. 零依赖、纯 ES5 语法 —— 它必须在最古老的引擎上也能跑起来
 */
(function () {
  if (typeof globalThis === 'undefined') return;

  var missing = [];

  /* ── 1) Iterator helpers ────────────────────────────────────────────────
   * 为什么需要：pdf.js 6.x 里有一句
   *     if (typeof Iterator.prototype.join !== 'function') { ... }
   * 它在判断条件里就访问了 Iterator.prototype —— 如果 Iterator 根本不存在，
   * 求值阶段直接抛 ReferenceError，后面的 typeof 检查形同虚设，
   * 进而导致**整个插件加载失败**（打包体系里一个 import 失败会拖垮整页）。
   */
  if (typeof globalThis.Iterator === 'undefined') {
    missing.push('Iterator');
    var IteratorShim = function Iterator() {};
    IteratorShim.prototype = Object.create(Object.prototype);
    IteratorShim.prototype[Symbol.iterator] = function () { return this; };
    IteratorShim.prototype.join = function (separator) {
      return Array.from(this).join(separator === undefined ? ',' : separator);
    };
    IteratorShim.from = function (iterable) {
      var source = (iterable != null && typeof iterable[Symbol.iterator] === 'function')
        ? iterable[Symbol.iterator]()
        : iterable;
      var wrapper = Object.create(IteratorShim.prototype);
      wrapper.next = function () { return source.next(); };
      return wrapper;
    };
    globalThis.Iterator = IteratorShim;
  } else if (typeof globalThis.Iterator.prototype.join !== 'function') {
    // Iterator 存在但缺少 helpers（部分内核只实现了基础协议）
    missing.push('Iterator.prototype.join');
    globalThis.Iterator.prototype.join = function (separator) {
      return Array.from(this).join(separator === undefined ? ',' : separator);
    };
  }

  /* ── 2) AbortSignal.any / timeout ───────────────────────────────────────
   * 为什么需要：目录选择器用 AbortSignal.any 中止目录扫描（Chrome 116+ 才有）。
   * 旧内核上会抛 "AbortSignal.any is not a function"。
   */
  if (typeof AbortSignal !== 'undefined') {
    if (typeof AbortSignal.any !== 'function') {
      missing.push('AbortSignal.any');
      AbortSignal.any = function (signals) {
        var controller = new AbortController();
        var list = Array.from(signals);
        for (var i = 0; i < list.length; i++) {
          var signal = list[i];
          if (signal.aborted) { controller.abort(signal.reason); return controller.signal; }
          signal.addEventListener('abort', function () { controller.abort(this.reason); }.bind(signal), { once: true });
        }
        return controller.signal;
      };
    }
    if (typeof AbortSignal.timeout !== 'function') {
      missing.push('AbortSignal.timeout');
      AbortSignal.timeout = function (ms) {
        var controller = new AbortController();
        setTimeout(function () {
          var reason;
          try { reason = new DOMException('signal timed out', 'TimeoutError'); }
          catch (e) { reason = new Error('signal timed out'); }
          controller.abort(reason);
        }, ms);
        return controller.signal;
      };
    }
  }

  /* ── 3) 标准库里的小缺口 ───────────────────────────────────────────── */

  if (typeof Object.hasOwn !== 'function') {
    missing.push('Object.hasOwn');
    Object.hasOwn = function (target, key) {
      return Object.prototype.hasOwnProperty.call(target, key);
    };
  }

  if (typeof Array.prototype.at !== 'function') {
    missing.push('Array.prototype.at');
    Object.defineProperty(Array.prototype, 'at', {
      value: function (index) {
        var length = this.length >>> 0;
        var k = Math.trunc(index) || 0;
        if (k < 0) k += length;
        return (k < 0 || k >= length) ? undefined : this[k];
      },
      writable: true, configurable: true,
    });
  }

  if (typeof Array.prototype.findLast !== 'function') {
    missing.push('Array.prototype.findLast');
    Object.defineProperty(Array.prototype, 'findLast', {
      value: function (predicate, thisArg) {
        for (var i = this.length - 1; i >= 0; i--) {
          if (predicate.call(thisArg, this[i], i, this)) return this[i];
        }
        return undefined;
      },
      writable: true, configurable: true,
    });
  }

  if (typeof Array.prototype.findLastIndex !== 'function') {
    missing.push('Array.prototype.findLastIndex');
    Object.defineProperty(Array.prototype, 'findLastIndex', {
      value: function (predicate, thisArg) {
        for (var i = this.length - 1; i >= 0; i--) {
          if (predicate.call(thisArg, this[i], i, this)) return i;
        }
        return -1;
      },
      writable: true, configurable: true,
    });
  }

  if (typeof String.prototype.replaceAll !== 'function') {
    missing.push('String.prototype.replaceAll');
    Object.defineProperty(String.prototype, 'replaceAll', {
      value: function (search, replacement) {
        if (search instanceof RegExp) {
          if (!search.global) throw new TypeError('replaceAll must be called with a global RegExp');
          return this.replace(search, replacement);
        }
        return this.split(String(search)).join(replacement);
      },
      writable: true, configurable: true,
    });
  }

  /* ── 4) Promise.any ─────────────────────────────────────────────────── */
  if (typeof Promise.any !== 'function') {
    missing.push('Promise.any');
    Promise.any = function (iterable) {
      return new Promise(function (resolve, reject) {
        var items = Array.from(iterable);
        var errors = [];
        var pending = items.length;
        function fail() {
          var message = 'All promises were rejected';
          if (typeof AggregateError === 'function') { reject(new AggregateError(errors, message)); return; }
          var error = new Error(message);
          error.errors = errors;
          reject(error);
        }
        if (pending === 0) { fail(); return; }
        items.forEach(function (item, index) {
          Promise.resolve(item).then(resolve, function (error) {
            errors[index] = error;
            if (--pending === 0) fail();
          });
        });
      });
    };
  }

  /* ── 自我报告 ─────────────────────────────────────────────────────────
   * 断言 globalThis.__compatShimmed.length > 0 才能证明垫片真的做了事。
   * 空数组在两种情况下出现：「新内核，全都跳过了」和「这个脚本压根没执行」——
   * 所以测试里必须配合"删掉目标 API 模拟旧内核"一起用（见 lessons/05、06）。
   */
  try { globalThis.__compatShimmed = missing; } catch (e) { /* 只读环境，忽略 */ }
})();
