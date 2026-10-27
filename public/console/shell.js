// 控制台 Shell（C1）。
//
// C0 只暴露契约版本；C1 起负责：
//   1) 拉 /api/console/manifest（核心卡 + 插件卡元数据）；
//   2) 更新侧栏计数；
//   3) 渲染基础/插件摘要卡 surface（插件管理是独立页面，按需挂载）；
//   4) 挂载声明式卡与 hash 路由。
import { loadManifest } from './core/registry.js';
import { mountDeclarativeCards } from './core/renderer.js';
import { api } from './core/api.js';
import { parseHash, hashForCore, hashForPlugins, hashForAbout, hashForPluginManage } from './app/router.js';
import { mountCoreSurface } from './app/core-surface.js';
import { mountLayout } from './app/layout.js';
import { mountPluginSurface } from './app/plugin-surface.js';
import { mountPluginManageView } from './app/plugin-manage-view.js';

const CONTRACT_VERSION = 'v1';

function legacyReady() {
  const grid = document.getElementById('summaryGrid');
  return !!grid && grid.querySelectorAll('.summary-card').length > 0;
}


let applyingHash = false;

function updateHash(hash, replace = false) {
  if (!hash || location.hash === hash) return;
  applyingHash = true;
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
  setTimeout(() => { applyingHash = false; }, 0);
}

function applyRoute(route) {
  if (!route) return;
  if (route.kind === 'plugin-manage') {
    window.applyConsoleGroup?.('plugin-manage');
    return;
  }
  if (route.kind === 'plugins') {
    window.applyConsoleGroup?.(route.pluginId ? `plugin:${route.pluginId}` : 'plugins');
    return;
  }
  if (route.kind === 'about') {
    window.applyConsoleGroup?.('about');
    return;
  }
  window.applyConsoleGroup?.('core');
  if (route.cardId) setTimeout(() => (window.__openCoreCard || window.openCardPage)?.(route.cardId), 60);
}

document.addEventListener('click', (event) => {
  const side = event.target.closest?.('.side-item[data-group]');
  if (side) {
    const group = side.dataset.group || '';
    if (group === 'core') updateHash(hashForCore());
    else if (group === 'plugins') updateHash(hashForPlugins());
    else if (group === 'plugin-manage') updateHash(hashForPluginManage());
    else if (group === 'about') updateHash(hashForAbout());
    else if (group.startsWith('plugin:')) updateHash(hashForPlugins(group.slice('plugin:'.length)));
    return;
  }
  const card = event.target.closest?.('.summary-card');
  if (card?.dataset.card) { updateHash(hashForCore(card.dataset.card)); return; }
  if (card?.dataset.pluginId) { updateHash(hashForPlugins(card.dataset.pluginId)); return; }
  if (event.target.closest?.('#detailBack')) {
    const kind = document.getElementById('detailPage')?.dataset.kind;
    setTimeout(() => updateHash(kind === 'plugin' ? hashForPlugins() : hashForCore()), 0);
  }
}, true);

window.addEventListener('hashchange', () => {
  if (applyingHash) return;
  applyRoute(parseHash(location.hash));
});

function initialRoute() {
  const route = parseHash(location.hash);
  if (!location.hash) history.replaceState(null, '', hashForCore());
  else if (route.kind === 'core' && route.cardId) history.replaceState(null, '', hashForCore(route.cardId));
  applyRoute(parseHash(location.hash));
}

function setCount(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function hydratePanelIframes() {
  const token = localStorage.getItem('consoleToken') || '';
  for (const frame of document.querySelectorAll('iframe[data-panel-src]')) {
    if (frame.dataset.hydrated === '1') continue;
    const base = frame.dataset.panelSrc || '';
    if (!base) continue;
    frame.src = base + (token ? (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : '');
    frame.dataset.hydrated = '1';
  }
}

window.addEventListener('message', (event) => {
  if (event.data?.type !== 'console-panel-height') return;
  for (const frame of document.querySelectorAll('iframe[data-panel-src]')) {
    if (frame.contentWindow !== event.source) continue;
    const height = Math.max(300, Math.min(2000, Number(event.data.height) || 0));
    if (height > 0) frame.style.height = height + 'px';
    break;
  }
});

async function mountModuleCards(cards) {
  await Promise.all((cards || []).map(async (card) => {
    if (card.render !== 'module' || !card.module) return;
    const mount = document.querySelector(`[data-card-mount="${card.id}"]`);
    if (!mount) return;
    try {
      const mod = await import(card.module);
      if (typeof mod.mount === 'function') await mod.mount(mount, { api, card });
    } catch (error) {
      mount.textContent = `卡片加载失败：${error?.message || error}`;
    }
  }));
}

async function loadPluginGuide() {
  const body = document.getElementById('pluginGuideBody');
  if (!body) return;
  try {
    const g = await api('/api/console/plugin-guide');
    body.textContent = '';
    const version = document.getElementById('pluginGuideVersion');
    if (version) version.textContent = `console card contract ${g.contractVersion || 'v1'}`;

    const fields = document.createElement('p');
    fields.className = 'meta';
    fields.textContent = '字段类型：' + (g.cardContract?.fields || []).join(' / ');
    const perms = document.createElement('p');
    perms.className = 'meta';
    perms.textContent = '权限：' + (g.permissions || []).join(' / ');
    const security = document.createElement('ul');
    security.className = 'meta';
    for (const line of g.cardContract?.security || []) {
      const li = document.createElement('li');
      li.textContent = line;
      security.appendChild(li);
    }
    const exampleTitle = document.createElement('p');
    exampleTitle.className = 'meta';
    exampleTitle.textContent = '最小示例：plugins/<id>/console.card.json';
    const pre = document.createElement('pre');
    pre.className = 'plugin-guide-example';
    pre.textContent = JSON.stringify(g.example?.json || {}, null, 2);
    const listTitle = document.createElement('p');
    listTitle.className = 'meta';
    listTitle.textContent = '实时插件清单：';
    const table = document.createElement('table');
    table.className = 'tk-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const t of ['插件', '版本', '状态', '卡片', '声明式']) {
      const th = document.createElement('th');
      th.textContent = t;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const p of g.plugins || []) {
      const tr = document.createElement('tr');
      for (const value of [p.id, p.version, p.status, p.cardCount ?? 0, p.hasDeclarativeCard ? '是' : '否']) {
        const td = document.createElement('td');
        td.textContent = String(value ?? '');
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.append(fields, perms, security, exampleTitle, pre, listTitle, table);
  } catch (error) {
    body.textContent = '插件文档读取失败：' + (error?.message || error);
  }
}

async function boot() {
  const registry = await loadManifest();
  window.__CONSOLE_REGISTRY__ = registry;
  setCount('sideCountAll', registry.cards.length);
  setCount('sideCountCore', registry.coreCards.length);
  setCount('sideCountPlugins', registry.pluginCards.length);
  mountLayout(registry);
  mountCoreSurface(registry);
  mountPluginSurface(registry, { mountDeclarativeCards, mountModuleCards, hydratePanelIframes });
  window.__CONSOLE_PLUGIN_MANAGE_VIEW__ = (host = document.getElementById('pluginManageView')) => {
    if (!host) return;
    mountPluginManageView(host);
  };
  mountDeclarativeCards(registry.coreCards);
  void mountModuleCards(registry.coreCards).then(() => hydratePanelIframes());
  hydratePanelIframes();
  void loadPluginGuide();
  initialRoute();

  const shellState = Object.freeze({
    contractVersion: CONTRACT_VERSION,
    legacyReady: legacyReady(),
    startedAt: Date.now(),
    manifestFallback: registry.fallback === true,
    coreCards: registry.coreCards.length,
    pluginCards: registry.pluginCards.length,
    pluginGroups: registry.pluginGroups.length
  });
  window.__CONSOLE_SHELL__ = shellState;
  document.dispatchEvent(new CustomEvent('console-manifest-ready', { detail: shellState }));
}

const initialState = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  legacyReady: legacyReady(),
  startedAt: Date.now()
});
window.__CONSOLE_SHELL__ = initialState;
document.dispatchEvent(new CustomEvent('console-shell-ready', { detail: initialState }));
void boot();
