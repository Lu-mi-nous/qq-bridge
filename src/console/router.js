// 控制台路由表（R4）。
//
// 为什么需要它：console-server.js 曾把 154 条路由内联在同一个请求处理器里，
// 单文件 7k 行、依赖袋 265 项，改一个接口要在 7k 行里翻。这里只做**匹配**，
// 不做业务：路由按域拆到 src/console/routes/*.js，每个模块自带 handler。
//
// 匹配顺序（必须与原来的内联链等价）：
//   1. 精确路径（method + pathname 全等）
//   2. 前缀路径（method + pathname.startsWith），长的优先
// 未命中返回 false，调用方继续走后续内联路由（渐进迁移，不需要一次搬完）。

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

function normalizeMethod(method) {
  const m = String(method ?? '').toUpperCase();
  if (!METHODS.has(m)) throw new TypeError(`不支持的方法：${method}`);
  return m;
}

function normalizePath(pathname) {
  const p = String(pathname ?? '');
  if (!p.startsWith('/')) throw new TypeError(`路由路径必须以 / 开头：${pathname}`);
  return p;
}

/**
 * @returns {{
 *   get(path, handler): void,
 *   post(path, handler): void,
 *   put(path, handler): void,
 *   del(path, handler): void,
 *   getPrefix(prefix, handler): void,
 *   postPrefix(prefix, handler): void,
 *   list(): string[],
 *   count(): number,
 *   handle(req, res, url, ctx): Promise<boolean>
 * }}
 */
export function createConsoleRouter() {
  const exact = new Map(); // `${METHOD} ${path}` -> handler
  const prefixes = []; // { method, prefix, handler }

  const add = (method, pathname, handler, { prefix = false } = {}) => {
    if (typeof handler !== 'function') throw new TypeError(`路由 handler 必须是函数：${pathname}`);
    const m = normalizeMethod(method);
    const p = normalizePath(pathname);
    if (prefix) {
      if (prefixes.some((r) => r.method === m && r.prefix === p)) {
        throw new Error(`路由重复注册：${m} ${p}*`);
      }
      prefixes.push({ method: m, prefix: p, handler });
      // 长前缀优先，避免 `/api/x` 抢走 `/api/x/y`
      prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
      return;
    }
    const key = `${m} ${p}`;
    if (exact.has(key)) throw new Error(`路由重复注册：${key}`);
    exact.set(key, handler);
  };

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    del: (p, h) => add('DELETE', p, h),
    getPrefix: (p, h) => add('GET', p, h, { prefix: true }),
    postPrefix: (p, h) => add('POST', p, h, { prefix: true }),
    /**
     * 注册一个分域模块：`{ routes: [[method, path, 'exact'|'prefix']], handle }`。
     * 模块自己声明路径清单，router 只按清单分派——模块内部仍是原来的 if 链，
     * 所以搬迁不需要改写任何 handler。
     */
    use: (module) => {
      if (!module || typeof module.handle !== 'function' || !Array.isArray(module.routes)) {
        throw new TypeError('路由模块必须提供 routes 数组与 handle 函数');
      }
      for (const [method, p, kind] of module.routes) {
        add(method, p, (req, res, url, ctx) => module.handle(req, res, url, ctx), {
          prefix: kind === 'prefix'
        });
      }
    },
    /** 已注册路由的可读清单（诊断/测试用）。 */
    list: () => [...exact.keys(), ...prefixes.map((r) => `${r.method} ${r.prefix}*`)],
    count: () => exact.size + prefixes.length,
    /**
     * 命中就执行 handler 并返回 true；未命中返回 false（不写响应）。
     * handler 抛错由调用方统一兜底，这里不吞异常。
     */
    async handle(req, res, url, ctx = {}) {
      const method = String(req.method ?? '').toUpperCase();
      const pathname = url?.pathname ?? '/';
      const hit = exact.get(`${method} ${pathname}`);
      if (hit) {
        await hit(req, res, url, ctx);
        return true;
      }
      for (const r of prefixes) {
        if (r.method === method && pathname.startsWith(r.prefix)) {
          await r.handler(req, res, url, ctx);
          return true;
        }
      }
      return false;
    }
  };
}
