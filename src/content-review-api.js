// 内容审查网关：实现仅由 Host 加载，每次调用重新查询能力。
// unavailable 不能视作审核通过；阻断模式的调用方必须拒发。
export function createContentReviewApi({ capabilities } = {}) {
  const current = () => capabilities?.get('content-review.instance') ?? null;
  const unavailable = () => ({ decision: 'unavailable', action: 'unavailable',
    categories: [], reason: 'review-plugin-unavailable', hash: '' });
  const required = name => (...args) => {
    const impl = current();
    if (typeof impl?.[name] !== 'function') throw new Error('Content review plugin unavailable');
    return impl[name](...args);
  };
  return Object.freeze({
    available: () => typeof current()?.reviewText === 'function',
    reviewText: async (...args) => {
      const impl = current();
      return typeof impl?.reviewText === 'function' ? impl.reviewText(...args) : unavailable();
    },
    localRuleScan: required('localRuleScan'),
    normalizeReviewConfig: required('normalizeReviewConfig'),
    appendAudit: required('appendAudit'),
    auditStats: required('auditStats')
  });
}
