// 内容审查网关（R4.5-10）。
//
// 插件 `plugins/content-review/` 提供统一审核入口与审计；这里给核心/P1 调用。
// 插件缺席或未启用时返回 { decision:'unavailable' }——**不要**把 unavailable 当 allow，
// P1 接线时必须按 fail-closed 处理（mode=block 时拒发）。
let impl = {};
let loadError = '';
try {
  impl = await import('../plugins/content-review/lib/review.mjs');
} catch (error) {
  loadError = String(error?.message ?? error);
}

export const contentReviewPluginLoaded = Object.keys(impl).length > 0;
export const contentReviewPluginError = loadError;

export const DEFAULT_REVIEW = impl.DEFAULT_REVIEW ?? Object.freeze({ enabled: false, mode: 'warn', failClosed: true });
export const normalizeReviewConfig = (...a) => (impl.normalizeReviewConfig ? impl.normalizeReviewConfig(...a) : { ...DEFAULT_REVIEW });
export const localRuleScan = (...a) => (impl.localRuleScan ? impl.localRuleScan(...a) : { hit: false, categories: [], matched: [] });
export const reviewText = async (...a) => (impl.reviewText
  ? impl.reviewText(...a)
  : { decision: 'unavailable', action: 'unavailable', categories: [], reason: 'review-plugin-missing', hash: '' });
export const appendAudit = (...a) => (impl.appendAudit ? impl.appendAudit(...a) : false);
export const auditStats = (...a) => (impl.auditStats ? impl.auditStats(...a) : { total: 0, blocked: 0, warned: 0, byCategory: {}, recent: [] });
