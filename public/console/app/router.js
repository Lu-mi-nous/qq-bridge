// 控制台 hash 路由（C6 P1/P2）。
//
// 约定：
//   #/core              基础功能
//   #/core/07           基础卡 07
//   #/plugins           插件功能总览
//   #/plugins/stickers  单个插件
//   #/plugins/manage    插件管理
//   #/about             关于
// 兼容旧书签： #card=07 → #/core/07
export const ROUTE_CONTRACT_VERSION = 'v1';

export function parseHash(hash = '') {
  const raw = String(hash || '').replace(/^#\/?/, '');
  if (!raw) return { kind: 'core', cardId: null };
  // 旧版详情页直接用 #card=07
  const legacy = /^card=([^&]+)$/.exec(raw);
  if (legacy) return { kind: 'core', cardId: decodeURIComponent(legacy[1]) };

  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'core') return { kind: 'core', cardId: parts[1] ? decodeURIComponent(parts[1]) : null };
  if (parts[0] === 'plugins' && parts[1] === 'manage') return { kind: 'plugin-manage', cardId: null };
  if (parts[0] === 'plugins') return { kind: 'plugins', pluginId: parts[1] ? decodeURIComponent(parts[1]) : null };
  if (parts[0] === 'about') return { kind: 'about', cardId: null };
  return { kind: 'core', cardId: null };
}

export function hashForCore(cardId = null) {
  return cardId ? `#/core/${encodeURIComponent(cardId)}` : '#/core';
}

export function hashForPlugins(pluginId = null) {
  return pluginId ? `#/plugins/${encodeURIComponent(pluginId)}` : '#/plugins';
}

export function hashForAbout() {
  return '#/about';
}

export function hashForPluginManage() {
  return '#/plugins/manage';
}

export function hashForRoute(route) {
  if (!route || route.kind === 'core') return hashForCore(route?.cardId || null);
  if (route.kind === 'plugins') return hashForPlugins(route.pluginId || null);
  if (route.kind === 'plugin-manage') return hashForPluginManage();
  if (route.kind === 'about') return '#/about';
  return '#/core';
}
