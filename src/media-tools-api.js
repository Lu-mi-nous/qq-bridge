// 媒体工具仅由 Host 加载；每次操作重新查询当前实现。
export function createMediaToolsApi({ getCapability = () => null } = {}) {
  const current = () => getCapability('media-tools.instance');
  const call = (part, method, fallback) => (...args) => {
    const impl = current()?.[part];
    if (typeof impl?.[method] === 'function') return impl[method](...args);
    if (fallback) return fallback();
    throw new Error('媒体工具插件不可用（media-tools）');
  };
  return Object.freeze({
    available: () => !!current(),
    parseGitHubUrl: call('github', 'parseGitHubUrl', () => null),
    extractGitHubUrl: call('github', 'extractGitHubUrl', () => null),
    screenshotGitHubRepo: call('github', 'screenshotGitHubRepo'),
    renderFeatureMenu: call('menuRender', 'renderFeatureMenu'),
    buildFeatureMenuHtml: call('menu', 'buildFeatureMenuHtml'),
    menuStats: call('menu', 'menuStats', () => ({ total: 0, enabled: 0 })),
    buildTokenReport: call('report', 'buildTokenReport'),
    summarizeTokenReport: call('report', 'summarizeTokenReport', () => ''),
    renderTokenReport: call('reportRender', 'renderTokenReport'),
    pruneTokenReportCache: call('reportRender', 'pruneTokenReportCache', () => 0)
  });
}
