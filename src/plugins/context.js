// 插件上下文：把核心能力收窄成插件能看到的少量接口。
//
// 设计原则（R2.5）：
//   - 插件不 import bridge.js，也不拿核心依赖袋；
//   - 配置按 manifest.configPath 取，插件只读自己的命名空间；
//   - 状态只能写 state/plugins/<id>/，路径越界直接抛错；
//   - 发送/社交状态/定时器都必须声明权限，且由宿主包装。
import fs from 'node:fs';
import path from 'node:path';
import { createJsonStore } from '../state/store.js';

const CONFIG_ITEM_KINDS = new Set(['secret', 'text', 'switch', 'number', 'select', 'textarea']);

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

function assertSafeRelativePath(relativePath) {
  const segs = String(relativePath || '').split('.').filter(Boolean);
  if (!segs.length || segs.some((s) => s === '..' || s === '.' || /[\\/]/.test(s))) {
    throw new Error(`插件配置路径不合法：${relativePath}`);
  }
  return segs;
}

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function permissionError(id, permission) {
  return new Error(`插件 ${id} 未声明权限：${permission}`);
}

export function createPluginContext({
  manifest,
  dir,
  root,
  getConfig = () => ({}),
  setConfig = null,
  services = {},
  log = () => {},
  events = null
} = {}) {
  const id = String(manifest?.id || '');
  if (!id) throw new Error('createPluginContext: manifest.id 不能为空');
  const stateRoot = path.join(root, 'state', 'plugins', id);
  const stateRootDir = path.join(root, 'state');
  const configPath = String(manifest.configPath || `plugins.${id}`);
  const permissions = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : []);
  const secretFiles = new Set((Array.isArray(manifest.secrets) ? manifest.secrets : []).map(String));

  const ctx = {
    id,
    dir,
    root,
    manifest,
    config: {
      path: configPath,
      get: () => clone(getByPath(getConfig(), configPath) ?? {}),
      /**
       * 只允许写自己 configPath 命名空间内的字段。
       * 例：configPath=socialV2.images 时，set('proxy', v) → socialV2.images.proxy。
       */
      set(relativePath, value) {
        if (typeof setConfig !== 'function') throw new Error(`插件 ${id} 的配置写入能力未注入`);
        const segs = assertSafeRelativePath(relativePath);
        setConfig(`${configPath}.${segs.join('.')}`, value);
        return true;
      }
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

  // 插件凭据文件：只允许 manifest.secrets 白名单里的 state/ 文件。
  // 凭据值不进日志；写入用原子替换并保持 0600。
  ctx.secrets = {
    files: [...secretFiles],
    readJson(name) {
      if (!permissions.has('secrets')) throw permissionError(id, 'secrets');
      const file = String(name || '');
      if (!secretFiles.has(file)) throw new Error(`插件 ${id} 未声明凭据文件：${file}`);
      try {
        const raw = fs.readFileSync(path.join(stateRootDir, file), 'utf8');
        return JSON.parse(raw.replace(/^\uFEFF/, ''));
      } catch {
        return null;
      }
    },
    writeJson(name, obj) {
      if (!permissions.has('secrets')) throw permissionError(id, 'secrets');
      const file = String(name || '');
      if (!secretFiles.has(file)) throw new Error(`插件 ${id} 未声明凭据文件：${file}`);
      atomicWriteJson(path.join(stateRootDir, file), obj && typeof obj === 'object' ? obj : {});
      return true;
    }
  };

  // 控制台插槽（R4-5）：插件可以贡献卡片、配置项与自己的 API 子路由。
  //
  // 约定：
  //   - 卡片只是元数据（标题/说明/取数地址），核心不渲染插件给的 HTML，
  //     前端只显示文本，避免插件注入脚本。
  //   - 配置项由插件注册元数据与 get/set；核心提供通用配置 API 和通用配置卡，
  //     插件自己决定存储位置、校验与生效方式。
  //   - 路由必须挂在 /api/plugins/<id>/ 下，且插件必须声明 console:route 权限；
  //     核心只转发，不替插件做鉴权以外的判断（鉴权/CSRF 已在 console-server 做过）。
  ctx.console = {
    cards: [],
    routes: [],
    configItems: [],
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
    registerConfigItems(items = []) {
      if (!permissions.has('console:route')) throw permissionError(id, 'console:route');
      const added = [];
      for (const item of Array.isArray(items) ? items : []) {
        if (!item || typeof item !== 'object') throw new TypeError(`插件 ${id} 的配置项必须是对象`);
        const key = String(item.key || '').trim();
        const label = String(item.label || '').trim();
        const kind = String(item.kind || 'text').trim();
        if (!key) throw new Error(`插件 ${id} 的配置项缺少 key`);
        if (!label) throw new Error(`插件 ${id} 的配置项 ${key} 缺少 label`);
        if (!CONFIG_ITEM_KINDS.has(kind)) throw new Error(`插件 ${id} 的配置项 ${key} kind 不合法：${kind}`);
        if (kind === 'secret' && !permissions.has('secrets')) {
          throw permissionError(id, 'secrets');
        }
        if (typeof item.get !== 'function') throw new TypeError(`插件 ${id} 的配置项 ${key} 缺少 get()`);
        if (typeof item.set !== 'function') throw new TypeError(`插件 ${id} 的配置项 ${key} 缺少 set()`);
        if (ctx.console.configItems.some((x) => x.key === key)) {
          throw new Error(`插件 ${id} 的配置项重复：${key}`);
        }
        const normalized = {
          key,
          label,
          group: String(item.group || '配置'),
          kind,
          restart: item.restart === true,
          doc: String(item.doc || ''),
          ...(Array.isArray(item.options) ? { options: item.options } : {}),
          get: item.get,
          set: item.set
        };
        ctx.console.configItems.push(normalized);
        added.push(normalized);
      }
      return added;
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
