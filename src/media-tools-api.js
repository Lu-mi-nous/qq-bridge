// 媒体工具网关（R4.5-9）：GitHub 截图 / 功能菜单图 / Token 报表图。
//
// 实现已迁到 `plugins/media-tools/lib/`；这些能力都是**按需生成一张图**，
// 插件缺席时调用会抛明确错误（控制台/工具端点各自有 try/catch），桥接启动不受影响。
let impl = {};
let loadError = '';
try {
  impl = {
    ...(await import('../plugins/media-tools/lib/github-shot.js')),
    ...(await import('../plugins/media-tools/lib/feature-menu.js')),
    ...(await import('../plugins/media-tools/lib/feature-menu-render.js')),
    ...(await import('../plugins/media-tools/lib/token-report.js')),
    ...(await import('../plugins/media-tools/lib/token-report-html.js')),
    ...(await import('../plugins/media-tools/lib/token-report-render.js'))
  };
} catch (error) {
  loadError = String(error?.message ?? error);
}

export const mediaToolsPluginLoaded = Object.keys(impl).length > 0;
export const mediaToolsPluginError = loadError;
const notLoaded = () => { throw new Error(`媒体工具插件未加载（plugins/media-tools）：${loadError || 'unknown'}`); };

// GitHub 截图
export const parseGitHubUrl = (...a) => (impl.parseGitHubUrl ? impl.parseGitHubUrl(...a) : null);
export const extractGitHubUrl = (...a) => (impl.extractGitHubUrl ? impl.extractGitHubUrl(...a) : null);
export const screenshotGitHubRepo = (...a) => (impl.screenshotGitHubRepo ? impl.screenshotGitHubRepo(...a) : notLoaded());

// 功能菜单图
export const renderFeatureMenu = (...a) => (impl.renderFeatureMenu ? impl.renderFeatureMenu(...a) : notLoaded());
export const buildFeatureMenuHtml = (...a) => (impl.buildFeatureMenuHtml ? impl.buildFeatureMenuHtml(...a) : notLoaded());
export const menuStats = (...a) => (impl.menuStats ? impl.menuStats(...a) : { total: 0, enabled: 0 });

// Token 报表图
export const buildTokenReport = (...a) => (impl.buildTokenReport ? impl.buildTokenReport(...a) : notLoaded());
export const summarizeTokenReport = (...a) => (impl.summarizeTokenReport ? impl.summarizeTokenReport(...a) : '');
export const renderTokenReport = (...a) => (impl.renderTokenReport ? impl.renderTokenReport(...a) : notLoaded());
export const pruneTokenReportCache = (...a) => (impl.pruneTokenReportCache ? impl.pruneTokenReportCache(...a) : 0);
