// 插件上下文：把核心能力收窄成插件能看到的少量接口。
//
// 设计原则（R2.5）：
//   - 插件不 import bridge.js，也不拿核心依赖袋；
//   - 配置按 manifest.configPath 取，插件只读自己的命名空间；
//   - 状态只能写 state/plugins/<id>/，路径越界直接抛错；
//   - 发送/社交状态/定时器都必须声明权限，且由宿主包装。
import path from 'node:path';
import { createJsonStore } from '../state/store.js';

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function getByPath(obj, dotted) {
  let cur = obj;
  for (const key of String(dotted || '').split('.')) {
    if (!key) continue;
    cur = cur?.[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function permissionError(id, permission) {
  return new Error(`插件 ${id} 未声明权限：${permission}`);
}

export function createPluginContext({
  manifest,
  dir,
  root,
  getConfig = () => ({}),
  services = {},
  log = () => {},
  events = null
} = {}) {
  const id = String(manifest?.id || '');
  if (!id) throw new Error('createPluginContext: manifest.id 不能为空');
  const stateRoot = path.join(root, 'state', 'plugins', id);
  const configPath = String(manifest.configPath || `plugins.${id}`);
  const permissions = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : []);

  const ctx = {
    id,
    dir,
    root,
    manifest,
    config: {
      path: configPath,
      get: () => clone(getByPath(getConfig(), configPath) ?? {})
    },
    state: {
      dir: stateRoot,
      file(name = 'state.json') {
        const raw = String(name || '');
        const safe = path.basename(raw);
        if (!raw || safe !== raw) throw new Error(`插件 ${id} 的状态文件名不合法：${raw}`);
        return path.join(stateRoot, safe);
      },
      store(name = 'state.json', opts = {}) {
        return createJsonStore({
          file: ctx.state.file(name),
          version: Number(opts.version) || 1,
          defaults: typeof opts.defaults === 'function' ? opts.defaults : () => ({}),
          migrate: typeof opts.migrate === 'function' ? opts.migrate : null,
          log: (msg) => ctx.log(msg)
        });
      }
    },
    log: (msg) => log(`[plugin:${id}] ${msg}`),
    activity: (line) => {
      if (typeof services.activity !== 'function') return;
      services.activity(`[${id}] ${String(line ?? '')}`);
    },
    hasPermission: (permission) => permissions.has(String(permission)),
    on: (event, handler) => {
      if (!events) return () => {};
      const key = `${id}:${String(event)}`;
      events.on(key, handler);
      return () => events.off(key, handler);
    },
    emit: (event, payload) => {
      if (!events) return;
      events.emit(`${id}:${String(event)}`, payload);
    },
    events: {
      on: (event, handler) => ctx.on(event, handler),
      emit: (event, payload) => ctx.emit(event, payload)
    }
  };

  ctx.send = {};
  if (services.send && typeof services.send === 'object') {
    for (const [name, fn] of Object.entries(services.send)) {
      if (typeof fn !== 'function') continue;
      ctx.send[name] = (...args) => {
        if (!permissions.has('send')) throw permissionError(id, 'send');
        return fn(...args);
      };
    }
  }

  ctx.social = {};
  if (services.social && typeof services.social === 'object') {
    for (const [name, fn] of Object.entries(services.social)) {
      if (typeof fn !== 'function') continue;
      ctx.social[name] = (...args) => {
        if (!permissions.has('state')) throw permissionError(id, 'state');
        return fn(...args);
      };
    }
  }

  // 控制台插槽（R4-5）：插件可以贡献卡片与自己的 API 子路由。
  //
  // 约定：
  //   - 卡片只是元数据（标题/说明/取数地址），核心不渲染插件给的 HTML，
  //     前端只显示文本，避免插件注入脚本。
  //   - 路由必须挂在 /api/plugins/<id>/ 下，且插件必须声明 console:route 权限；
  //     核心只转发，不替插件做鉴权以外的判断（鉴权/CSRF 已在 console-server 做过）。
  ctx.console = {
    cards: [],
    routes: [],
    registerCard(card = {}) {
      const normalized = {
        id: String(card.id || id),
        title: String(card.title || manifest?.name || id),
        description: String(card.description || ''),
        endpoint: String(card.endpoint || `/api/plugins/${id}/card`)
      };
      ctx.console.cards.push(normalized);
      return normalized;
    },
    registerRoute(pathname, handler, options = {}) {
      if (!permissions.has('console:route')) throw permissionError(id, 'console:route');
      const p = String(pathname || '');
      if (!p.startsWith(`/api/plugins/${id}/`)) {
        throw new Error(`插件 ${id} 的控制台路由必须挂在 /api/plugins/${id}/ 下：${p}`);
      }
      if (typeof handler !== 'function') throw new TypeError('registerRoute 需要 handler(req, res, url, helpers)');
      const method = String(options.method || 'GET').toUpperCase();
      ctx.console.routes.push({ path: p, method, handler });
      return p;
    }
  };

  return ctx;
}
