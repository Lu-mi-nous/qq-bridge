// 插件功能 surface（C6 P3 / 2026-10-27 改为摘要卡布局）。
//
// 与基础功能共用 summary-card / detailPage：每个插件一张摘要卡，点击进入整页详情。
// 插件管理已拆到独立页面（plugin-manage-view.js），这里不再渲染管理列表。
import { api as defaultApi } from '../core/api.js';
import { openDetail, closeDetail, isDetailOpen } from './detail-surface.js';

export function mountPluginSurface(registry, deps = {}) {
  const {
    api = defaultApi,
    mountDeclarativeCards = () => {},
    mountModuleCards = () => {},
    hydratePanelIframes = () => {}
  } = deps;

  const grid = document.getElementById('pluginSummaryGrid');
  const pool = document.getElementById('pluginDetailPool');
  let disabledIds = new Set();
  let requestedId = '';
  let cardsById = new Map();

  const setCount = (n) => {
    const el = document.getElementById('sideCountPlugins');
    if (el) el.textContent = String(n);
  };
  const groupNo = (id) => {
    if (id === 'console-tools') return 'T01';
    const index = registry.pluginGroups.filter((group) => group.id !== 'console-tools').findIndex((group) => group.id === id);
    return 'P' + String(index + 1).padStart(2, '0');
  };
  const summaryText = (group) => {
    const desc = (group.cards || []).map((card) => card.description).filter(Boolean).join('；');
    if (desc) return desc;
    if (group.builtin) return `内置 · ${group.cards.length} 个设置页`;
    return `${group.status === 'started' ? '已加载' : group.status} · ${group.cards.length} 个设置页`;
  };

  function cardTile(card, group) {
    const item = document.createElement('div');
    item.className = 'plugin-card-item';
    const title = document.createElement('b');
    title.textContent = card.title || card.id;
    const status = document.createElement('small');
    status.textContent = group.builtin ? '控制台工具 · 内置' : `${group.id} · ${group.status}`;
    title.appendChild(status);
    const desc = document.createElement('span');
    desc.textContent = card.description || '';
    item.append(title, desc);
    if (card.panel) {
      const frame = document.createElement('iframe');
      frame.className = 'console-panel';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('loading', 'lazy');
      frame.setAttribute('title', card.title || '插件面板');
      frame.dataset.panelSrc = card.panel;
      frame.style.height = '300px';
      frame.addEventListener('load', () => {
        try {
          frame.contentWindow?.postMessage({ type: 'console-panel-init', card: { title: card.title, description: card.description } }, '*');
        } catch {}
      });
      item.appendChild(frame);
    }
    if (card.render === 'module' && card.module) {
      item.classList.add('plugin-card-full');
      const body = document.createElement('div');
      body.className = 'plugin-card-body';
      body.setAttribute('data-card-mount', card.id);
      item.appendChild(body);
    } else if (card.render === 'declarative' && Array.isArray(card.sections) && card.sections.length) {
      const body = document.createElement('div');
      body.className = 'plugin-card-body';
      body.setAttribute('data-card-mount', card.id);
      item.appendChild(body);
    } else if (card.endpoint) {
      const endpoint = document.createElement('code');
      endpoint.className = 'plugin-card-endpoint';
      endpoint.textContent = card.endpoint;
      item.appendChild(endpoint);
    }
    return item;
  }

  function detailSection(group) {
    const section = document.createElement('section');
    section.className = 'card plugin-detail-card';
    section.id = `plugin-sec-${group.id}`;
    section.dataset.pluginId = group.id;

    const meta = document.createElement('div');
    meta.className = 'plugin-detail-meta';
    const status = document.createElement('span');
    status.className = group.builtin ? 'pill' : (group.status === 'started' ? 'pill g' : 'pill r');
    status.textContent = group.builtin ? '内置' : group.status;
    const id = document.createElement('span');
    id.className = 'meta';
    id.textContent = group.id;
    const desc = document.createElement('span');
    desc.className = 'meta';
    desc.textContent = summaryText(group);
    meta.append(status, id, desc);
    section.appendChild(meta);

    if (group.error) {
      const err = document.createElement('p');
      err.className = 'meta err';
      err.textContent = group.error;
      section.appendChild(err);
    }
    const list = document.createElement('div');
    list.className = 'plugin-card-list';
    for (const card of group.cards || []) list.appendChild(cardTile(card, group));
    section.appendChild(list);
    return section;
  }

  function openPluginGroup(id, trigger = null) {
    const entry = cardsById.get(id);
    const group = registry.pluginGroups.find((item) => item.id === id);
    if (!entry || !group) return false;
    requestedId = id;
    return openDetail({
      section: entry.section,
      trigger: trigger || entry.btn,
      title: group.title,
      no: entry.no,
      returnHost: pool,
      inert: [grid, pool],
      kind: 'plugin'
    });
  }

  function render() {
    if (!grid || !pool) return;
    if (isDetailOpen()) closeDetail({ immediate: true });
    grid.textContent = '';
    pool.textContent = '';
    cardsById = new Map();
    const groups = registry.pluginGroups.filter((group) => !disabledIds.has(group.id));
    setCount(groups.length);
    if (!groups.length) {
      const empty = document.createElement('p');
      empty.className = 'meta plugin-empty';
      empty.textContent = registry.pluginGroups.length ? '当前没有已加载的插件。' : '当前没有带控制台卡片的插件。';
      grid.appendChild(empty);
      return;
    }
    groups.forEach((group, index) => {
      const no = groupNo(group.id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'summary-card glass';
      btn.style.setProperty('--i', String(index));
      btn.dataset.pluginId = group.id;
      btn.dataset.group = `plugin:${group.id}`;
      btn.setAttribute('aria-controls', 'detailPage');
      btn.setAttribute('aria-expanded', 'false');
      const badge = document.createElement('span');
      badge.className = 'sc-no';
      badge.textContent = no;
      const title = document.createElement('span');
      title.className = 'sc-title';
      title.textContent = group.title;
      title.title = group.title;
      const summary = document.createElement('span');
      summary.className = 'sc-summary';
      summary.textContent = summaryText(group);
      const main = document.createElement('span');
      main.className = 'sc-main';
      main.append(badge, title);
      btn.append(main, summary);
      btn.addEventListener('click', () => { openPluginGroup(group.id, btn); });
      grid.appendChild(btn);

      const section = detailSection(group);
      pool.appendChild(section);
      cardsById.set(group.id, { btn, section, no });
    });
    mountDeclarativeCards(registry.pluginCards);
    mountModuleCards(registry.pluginCards);
    hydratePanelIframes();
    if (requestedId && cardsById.has(requestedId)) {
      const id = requestedId;
      queueMicrotask(() => openPluginGroup(id));
    }
  }

  async function syncState() {
    try {
      const state = await api('/api/console/plugins');
      const next = new Set((state?.plugins || []).filter((plugin) => plugin.disabled).map((plugin) => plugin.id));
      if (next.size !== disabledIds.size || [...next].some((id) => !disabledIds.has(id))) {
        disabledIds = next;
        render();
      }
    } catch { /* 插件管理接口失败不影响插件页 */ }
  }

  function onStateChange(event) {
    const id = event?.detail?.id;
    if (!id) return;
    if (event.detail.disabled) disabledIds.add(id);
    else disabledIds.delete(id);
    render();
  }

  window.addEventListener('plugin-state-change', onStateChange);
  window.__CONSOLE_PLUGIN_VIEW__ = (group) => {
    const id = String(group || '').startsWith('plugin:') ? String(group).slice('plugin:'.length) : '';
    requestedId = id;
    render();
  };
  window.__CONSOLE_PLUGIN_TITLE__ = (group) => {
    const id = String(group).startsWith('plugin:') ? String(group).slice('plugin:'.length) : '';
    return registry.pluginGroups.find((item) => item.id === id)?.title || '插件功能';
  };

  render();
  void syncState();
  return { render, syncState };
}
