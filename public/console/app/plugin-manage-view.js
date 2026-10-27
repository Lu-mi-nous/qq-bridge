// 插件管理独立页面。
//
// 只负责挂载管理列表；真正的加载/卸载逻辑与重启提示在 plugin-manager.js。
import { api as defaultApi } from '../core/api.js';
import { mountPluginManager } from './plugin-manager.js';

export function mountPluginManageView(container, { api = defaultApi } = {}) {
  if (!container) return null;
  if (container.dataset.mounted === '1') return null;
  container.dataset.mounted = '1';
  const host = document.createElement('div');
  host.className = 'plugin-manage-host';
  container.appendChild(host);
  void mountPluginManager(host, {
    api,
    showHeader: false,
    onChange: (detail) => {
      window.dispatchEvent(new CustomEvent('plugin-state-change', { detail }));
    }
  });
  return host;
}
