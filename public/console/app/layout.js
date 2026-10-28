// 控制台布局与侧栏（C6 P1）。
//
// 负责侧栏计数/切换、基础/插件/关于三个视图的显隐；不再让 legacy 管侧栏。
import { api as defaultApi } from '../core/api.js';
import { mountAboutView } from './about-view.js';

const META = {
  core: { title: '基础功能', desc: '桥接自带功能，按编号平铺；点击卡片进入整页设置。' },
  plugins: { title: '插件功能', desc: '每个插件一张摘要卡；点击打开插件设置。已卸载的插件不会出现在这里。' },
  'plugin-manage': { title: '插件管理', desc: '加载 / 卸载会修改 config.plugins.disabled；状态变更后需要重启桥接生效。' },
  about: { title: '关于', desc: '版本、运行环境与项目信息。' }
};

export function mountLayout(registry, { api = defaultApi } = {}) {
  mountAboutView();
  const sidebar = document.getElementById('consoleSidebar');
  const summary = document.getElementById('summaryGrid');
  const pluginView = document.getElementById('pluginCategoryView');
  const pluginManageView = document.getElementById('pluginManageView');
  const aboutView = document.getElementById('aboutView');
  const viewHead = document.getElementById('viewHead');
  const viewTitle = document.getElementById('viewTitle');
  const viewDesc = document.getElementById('viewDesc');
  let aboutLoaded = false;
  let currentGroup = '';

  const setCount = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = String(n); };
  setCount('sideCountCore', registry.coreCards.length);
  setCount('sideCountPlugins', registry.pluginCards.length);

  function applyGroup(group) {
    window.__closeDetail?.();
    const isPluginGroup = String(group).startsWith('plugin:');
    const g = (group === 'core' || group === 'plugins' || group === 'plugin-manage' || group === 'about' || isPluginGroup) ? group : 'core';
    const isAbout = g === 'about';
    const isPluginManage = g === 'plugin-manage';
    const isPlugins = g === 'plugins' || isPluginGroup;
    sidebar?.querySelectorAll('[data-group]').forEach((item) => {
      const on = item.dataset.group === g;
      item.classList.toggle('active', on);
      if (on) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    if (aboutView) aboutView.hidden = !isAbout;
    if (pluginView) pluginView.hidden = !isPlugins;
    if (pluginManageView) pluginManageView.hidden = !isPluginManage;
    if (summary) summary.hidden = isAbout || isPlugins || isPluginManage;
    if (viewHead) viewHead.hidden = isAbout;
    if (isAbout) {
      if (viewTitle) viewTitle.textContent = META.about.title;
      if (viewDesc) viewDesc.textContent = META.about.desc;
      if (!aboutLoaded) { aboutLoaded = true; void loadAbout(); }
    } else if (isPluginManage) {
      if (viewTitle) viewTitle.textContent = META['plugin-manage'].title;
      if (viewDesc) viewDesc.textContent = META['plugin-manage'].desc;
      if (currentGroup !== g) window.__CONSOLE_PLUGIN_MANAGE_VIEW__?.(pluginManageView);
    } else if (isPlugins) {
      if (viewTitle) viewTitle.textContent = isPluginGroup ? (window.__CONSOLE_PLUGIN_TITLE__?.(g) || META.plugins.title) : META.plugins.title;
      if (viewDesc) viewDesc.textContent = META.plugins.desc;
      if (currentGroup !== g) window.__CONSOLE_PLUGIN_VIEW__?.(g);
    } else {
      if (viewTitle) viewTitle.textContent = META.core.title;
      if (viewDesc) viewDesc.textContent = META.core.desc;
      summary?.querySelectorAll('.summary-card').forEach((card) => { card.hidden = false; });
    }
    currentGroup = g;
    document.title = isAbout
      ? 'QQ 桥接控制台 · 关于'
      : isPluginManage
        ? 'QQ 桥接控制台 · 插件管理'
        : isPlugins
          ? 'QQ 桥接控制台 · 插件功能'
          : 'QQ 桥接控制台 · 基础功能';
  }

  async function loadAbout() {
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    try {
      const r = await api('/api/about');
      if (!r?.ok) return;
      const version = r.version ? ('v' + r.version) : 'v0.7.1';
      set('aboutVersion', version);
      set('aboutVersion2', version);
      set('aboutNode', r.node || '—');
      set('aboutNode2', r.node || '—');
      set('aboutSnowluma', r.snowlumaVersion ? ('v' + r.snowlumaVersion) : '—');
      set('aboutSnowluma2', r.snowlumaVersion ? ('v' + r.snowlumaVersion) : '—');
      set('aboutPlatform', [r.platform, r.arch].filter(Boolean).join(' / ') || '—');
      const sv = document.getElementById('sidebarVersion');
      if (sv) sv.textContent = version;
      const repo = document.getElementById('aboutRepo');
      if (repo && r.repo) repo.href = r.repo;
      const p = await api('/api/plugins');
      if (p?.ok) set('aboutPlugins', (p.plugins || []).map((x) => `${x.id}${x.status === 'started' ? '' : '（' + x.status + '）'}`).join(' / ') || '无');
    } catch { /* 关于页失败不影响控制台 */ }
  }

  sidebar?.querySelectorAll('[data-group]').forEach((item) => {
    item.addEventListener('click', () => applyGroup(item.dataset.group));
  });
  window.applyConsoleGroup = applyGroup;
  applyGroup('core');
  return { applyGroup };
}
