// 插件宿主（R2.5）。
//
// 只做四件事：发现、校验、加载、生命周期。
// 不实现业务逻辑，也不把核心依赖袋直接交给插件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createPluginContext } from './context.js';

export const PLUGIN_PERMISSIONS = Object.freeze([
  'network',
  'state',
  'send',
  'mcp:register',
  'console:route',
  'prompt',
  'process',
  'secrets'
]);

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readPackageVersion(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  return String(pkg?.version || '0.0.0');
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? m.slice(1).map(Number) : null;
}

/** 只支持 manifest 里常见的 `>=x.y.z`；其它写法按兼容处理，不阻塞加载。 */
export function versionSatisfies(current, range) {
  const r = String(range || '').trim();
  if (!r || r === '*') return true;
  const m = /^>=\s*(\d+\.\d+\.\d+)$/.exec(r);
  if (!m) return true;
  const a = parseVersion(current);
  const b = parseVersion(m[1]);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

/**
 * 校验 manifest。返回 `{ ok, errors }`，不抛错，便于测试与诊断。
 */
export function validatePluginManifest(manifest, { currentVersion = '0.0.0' } = {}) {
  const errors = [];
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  if (!ID_RE.test(String(m.id || ''))) errors.push('id 必须是小写字母/数字/连字符，最长 64');
  if (!String(m.version || '').trim()) errors.push('缺少 version');
  if (!String(m.configSchema || '').trim()) errors.push('缺少 configSchema');
  if (!Array.isArray(m.permissions)) errors.push('permissions 必须是数组');
  else {
    for (const p of m.permissions) {
      if (!PLUGIN_PERMISSIONS.includes(p)) errors.push(`未知权限：${p}`);
    }
  }
  if (m.secrets != null) {
    if (!Array.isArray(m.secrets)) errors.push('secrets 必须是数组');
    else {
      for (const name of m.secrets) {
        const raw = String(name || '');
        if (!raw || path.basename(raw) !== raw) errors.push(`secrets 文件名不合法：${raw}`);
      }
      if (m.secrets.length && !(Array.isArray(m.permissions) && m.permissions.includes('secrets'))) {
        errors.push('声明 secrets 文件时必须同时声明 secrets 权限');
      }
    }
  }
  if (m.engines?.qqBridge && !versionSatisfies(currentVersion, m.engines.qqBridge)) {
    errors.push(`需要 qqBridge ${m.engines.qqBridge}，当前 ${currentVersion}`);
  }
  return { ok: errors.length === 0, errors };
}

function manifestDirs({ root, dirs }) {
  if (Array.isArray(dirs)) return dirs;
  return [
    path.join(root, 'plugins'),
    path.join(os.homedir(), '.qq-bridge', 'plugins')
  ];
}

const CONSOLE_FIELD_TYPES = new Set([
  'text', 'input', 'number', 'switch', 'select', 'textarea',
  'table', 'list', 'progress', 'custom-note', 'actions'
]);

/**
 * 校验插件 `console.card.json`（C3）。
 * 只允许声明式 JSON：禁止 HTML/脚本片段；动作路径必须留在插件命名空间。
 */
export function validateConsoleCard(card, { pluginId } = {}) {
  const errors = [];
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return { ok: false, errors: ['console.card.json 必须是对象'] };
  }
  const id = String(card.id || '');
  if (!id) errors.push('缺少 id');
  if (!String(card.title || '').trim()) errors.push('缺少 title');
  if (card.kind !== 'plugin') errors.push('kind 必须是 plugin');
  if (String(card.pluginId || '') !== String(pluginId || '')) errors.push('pluginId 必须与插件 id 一致');
  if (card.order != null && !Number.isFinite(Number(card.order))) errors.push('order 必须是数字');
  if (card.panel && !String(card.panel).startsWith(`/api/plugins/${pluginId}/`)) {
    errors.push(`panel 必须位于 /api/plugins/${pluginId}/：${card.panel}`);
  }
  const raw = JSON.stringify(card);
  if (/<script|<html|javascript:/i.test(raw)) errors.push('不允许 HTML/脚本片段');

  const walkSections = (sections) => {
    if (!Array.isArray(sections)) { errors.push('sections 必须是数组'); return; }
    for (const [index, section] of sections.entries()) {
      if (!section || typeof section !== 'object') { errors.push(`sections[${index}] 必须是对象`); continue; }
      if (!CONSOLE_FIELD_TYPES.has(String(section.type))) errors.push(`sections[${index}] 未知类型：${section.type}`);
      for (const item of Array.isArray(section.items) ? section.items : []) {
        const path = String(item?.path || '');
        if (path && !path.startsWith(`/api/plugins/${pluginId}/`)) {
          errors.push(`sections[${index}] 动作路径必须位于 /api/plugins/${pluginId}/：${path}`);
        }
      }
    }
  };
  walkSections(card.sections);
  for (const item of Array.isArray(card.actions) ? card.actions : []) {
    const path = String(item?.path || '');
    if (path && !path.startsWith(`/api/plugins/${pluginId}/`)) {
      errors.push(`actions 路径必须位于 /api/plugins/${pluginId}/：${path}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * @param {object} opts
 * @param {string} opts.root 项目根目录
 * @param {Function} opts.getConfig 返回完整配置对象
 * @param {object} opts.services 窄服务：{ send, social, activity }
 * @param {string[]} [opts.dirs] 插件目录（测试可注入）
 * @param {Function} [opts.log]
 */
export function createPluginHost({
  root,
  getConfig = () => ({}),
  setConfig = null,
  services = {},
  dirs,
  log = () => {}
} = {}) {
  if (!root) throw new Error('createPluginHost: root 不能为空');
  const currentVersion = readPackageVersion(root);
  const events = new EventEmitter();
  const plugins = new Map(); // id -> { manifest, dir, instance, ctx, status, error }
  let loaded = false;
  let started = false;

  function discover() {
    const found = [];
    const seen = new Set();
    for (const dir of manifestDirs({ root, dirs })) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const pluginDir = path.join(dir, ent.name);
        const manifest = readJson(path.join(pluginDir, 'manifest.json'));
        if (!manifest) continue;
        const id = String(manifest.id || '');
        if (!id) continue;
        if (seen.has(id)) {
          log(`[plugin] 跳过重复插件 ${id}：${pluginDir}`);
          continue;
        }
        seen.add(id);
        found.push({ manifest, dir: pluginDir });
      }
    }
    return found;
  }

  async function load({ only = null } = {}) {
    if (loaded) return list();
    loaded = true;
    const wanted = Array.isArray(only) ? new Set(only) : null;
    for (const { manifest, dir } of discover()) {
      const id = String(manifest.id || '');
      if (wanted && !wanted.has(id)) continue;
      const check = validatePluginManifest(manifest, { currentVersion });
      if (!check.ok) {
        plugins.set(id, { manifest, dir, instance: null, ctx: null, status: 'invalid', error: check.errors.join('；') });
        log(`[plugin] ${id} manifest 不合法：${check.errors.join('；')}`);
        continue;
      }
      const disabledIds = new Set((getConfig()?.plugins?.disabled || []).map(String));
      if (disabledIds.has(id)) {
        plugins.set(id, { manifest, dir, instance: null, ctx: null, status: 'disabled', error: '', consoleCard: null, consoleCardError: '' });
        log(`[plugin] ${id} 已在 plugins.disabled 中，跳过加载`);
        continue;
      }
      try {
        const entry = path.join(dir, 'index.js');
        if (!fs.existsSync(entry)) throw new Error('缺少 index.js');
        const consoleCardRaw = readJson(path.join(dir, 'console.card.json'));
        let consoleCard = null;
        let consoleCardError = '';
        if (consoleCardRaw) {
          const cc = validateConsoleCard(consoleCardRaw, { pluginId: id });
          if (cc.ok) consoleCard = consoleCardRaw;
          else {
            consoleCardError = cc.errors.join('；');
            log(`[plugin] ${id} console.card.json 不合法：${consoleCardError}`);
          }
        }
        const mod = await import(pathToFileURL(entry).href);
        const factory = typeof mod.create === 'function' ? mod.create : mod.default;
        if (typeof factory !== 'function') throw new Error('index.js 必须导出 create(ctx) 或 default');
        const ctx = createPluginContext({
          manifest,
          dir,
          root,
          getConfig,
          setConfig,
          services,
          log,
          events
        });
        const instance = await factory(ctx);
        if (!instance || typeof instance !== 'object') throw new Error('插件 create() 未返回对象');
        plugins.set(id, { manifest, dir, instance, ctx, status: 'loaded', error: '', consoleCard, consoleCardError });
        log(`[plugin] 已加载 ${id}@${manifest.version}`);
      } catch (error) {
        plugins.set(id, { manifest, dir, instance: null, ctx: null, status: 'failed', error: String(error?.message ?? error) });
        log(`[plugin] ${id} 加载失败：${error?.message ?? error}`);
      }
    }
    return list();
  }

  async function start() {
    if (!loaded) await load();
    if (started) return list();
    started = true;
    for (const [id, rec] of plugins) {
      if (rec.status !== 'loaded' || typeof rec.instance?.start !== 'function') continue;
      try {
        await rec.instance.start();
        rec.status = 'started';
        log(`[plugin] 已启动 ${id}`);
      } catch (error) {
        rec.status = 'failed';
        rec.error = String(error?.message ?? error);
        log(`[plugin] ${id} 启动失败：${error?.message ?? error}`);
      }
    }
    return list();
  }

  async function stop() {
    const records = [...plugins.entries()].reverse();
    for (const [id, rec] of records) {
      if (typeof rec.instance?.stop !== 'function') continue;
      try {
        await rec.instance.stop();
        rec.status = 'stopped';
        log(`[plugin] 已停止 ${id}`);
      } catch (error) {
        log(`[plugin] ${id} 停止失败：${error?.message ?? error}`);
      }
    }
    started = false;
  }

  function get(id) {
    return plugins.get(String(id))?.instance ?? null;
  }

  /** 插件上下文：控制台插槽与诊断用（get() 只给 instance）。 */
  function getContext(id) {
    return plugins.get(String(id))?.ctx ?? null;
  }

  function list() {
    return [...plugins.entries()].map(([id, rec]) => ({
      id,
      name: String(rec.manifest?.name || id),
      version: String(rec.manifest?.version || ''),
      status: rec.status,
      error: rec.error || '',
      dir: rec.dir,
      // R4-5：插件贡献的控制台卡片与路由（只有声明了 console:route 才有路由）。
      console: {
        cards: Array.isArray(rec.ctx?.console?.cards) ? rec.ctx.console.cards : [],
        routes: Array.isArray(rec.ctx?.console?.routes)
          ? rec.ctx.console.routes.map((r) => ({ path: r.path, method: r.method }))
          : [],
        // 只暴露元数据，绝不把 get/set 闭包带出插件上下文。
        configItems: Array.isArray(rec.ctx?.console?.configItems)
          ? rec.ctx.console.configItems.map(({ get, set, ...meta }) => meta)
          : []
      },
      consoleCard: rec.consoleCard || null,
      consoleCardError: rec.consoleCardError || ''
    }));
  }

  return { load, start, stop, get, getContext, list, discover, validate: validatePluginManifest };
}
