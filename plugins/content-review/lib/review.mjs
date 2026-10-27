// 内容审查插件（R4.5-10 / X 审查 P1 的落点，默认关闭）。
//
// 设计（见桌面工作计划阶段 6）：
//   - 统一入口返回 { decision, categories, scores, reason }；
//   - 先本地规则（可配置关键词/危险域名），模型审核由调用方注入（只读、强制 JSON）；
//   - 审核记录只存 hash / 分类 / 分数 / 动作 / 时间，**不存原文**；
//   - 任何异常/超时按 fail-closed 处理（mode=block 时一律拒发）。
//
// 敏感词表**不进仓库**：默认关键词与危险域名都为空，由使用者写进自己的
// config.json（xMonitor.review.keywordsByCategory / blockedDomains）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REVIEW_CATEGORIES = [
  'politics', 'porn', 'violence', 'gambling', 'drugs', 'scam', 'other'
];

export const DEFAULT_REVIEW = Object.freeze({
  enabled: false,
  mode: 'warn',              // warn = 只审计不拦；block = 命中即拒发
  failClosed: true,
  maxChars: 4000,
  timeoutMs: 8000,
  keywordsByCategory: {},    // { politics: ['...'], porn: ['...'] }
  blockedDomains: [],
  auditFile: 'state/x-monitor/review-audit.jsonl',
  auditMaxEntries: 2000
});

const URL_RE = /https?:\/\/[^\s)）>]+/gi;

export function normalizeReviewConfig(raw = {}) {
  const k = (raw && typeof raw === 'object') ? raw : {};
  const keywords = {};
  if (k.keywordsByCategory && typeof k.keywordsByCategory === 'object') {
    for (const [cat, list] of Object.entries(k.keywordsByCategory)) {
      const arr = Array.isArray(list) ? list.map((x) => String(x).trim()).filter(Boolean) : [];
      if (arr.length) keywords[cat] = arr;
    }
  }
  return {
    ...DEFAULT_REVIEW,
    ...k,
    keywordsByCategory: keywords,
    blockedDomains: Array.isArray(k.blockedDomains)
      ? k.blockedDomains.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
      : []
  };
}

export function hashText(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** 本地规则命中（纯函数，可单测）。 */
export function localRuleScan(text, cfg = {}) {
  const c = normalizeReviewConfig(cfg);
  const raw = String(text ?? '');
  const sample = raw.slice(0, c.maxChars);
  const categories = new Set();
  const matched = [];
  const lower = sample.toLowerCase();
  for (const [cat, words] of Object.entries(c.keywordsByCategory)) {
    for (const w of words) {
      if (!w) continue;
      if (lower.includes(String(w).toLowerCase())) {
        categories.add(cat);
        matched.push(w);
        break;
      }
    }
  }
  for (const m of sample.matchAll(URL_RE)) {
    let host = '';
    try { host = new URL(m[0]).hostname.toLowerCase(); } catch {}
    if (host && c.blockedDomains.some((d) => host === d || host.endsWith(`.${d}`))) {
      categories.add('scam');
      matched.push(host);
    }
  }
  return { hit: categories.size > 0, categories: [...categories], matched: [...new Set(matched)] };
}

function safeModelVerdict(v) {
  if (!v || typeof v !== 'object') return null;
  const categories = Array.isArray(v.categories)
    ? v.categories.map((x) => String(x).trim()).filter((x) => REVIEW_CATEGORIES.includes(x))
    : [];
  const decision = v.decision === 'block' ? 'block' : (v.decision === 'allow' ? 'allow' : null);
  if (!decision) return null;
  return { decision, categories, reason: String(v.reason ?? '').slice(0, 300) };
}

/**
 * 统一审核入口。
 * @param {string} text 帖子原文 + 译文（调用方拼接）
 * @param {object} opts { cfg, modelReview?: async (sample) => ({decision,categories,reason}), log }
 */
export async function reviewText(text, { cfg = {}, modelReview = null, log = () => {} } = {}) {
  const c = normalizeReviewConfig(cfg);
  const sample = String(text ?? '').slice(0, c.maxChars);
  const hash = hashText(sample);
  if (c.enabled === false) return { decision: 'allow', categories: [], reason: 'review-disabled', hash, action: 'allow' };

  const local = localRuleScan(sample, c);
  let model = null;
  let modelError = '';
  if (modelReview) {
    try {
      const withTimeout = Promise.resolve().then(() => modelReview(sample));
      const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('review-timeout')), Math.max(1000, Number(c.timeoutMs) || 8000)));
      model = safeModelVerdict(await Promise.race([withTimeout, timer]));
      if (!model) modelError = 'bad-model-output';
    } catch (error) {
      modelError = String(error?.message ?? error);
      log(`[review] 模型审核失败：${modelError}`);
    }
  }

  const categories = [...new Set([...local.categories, ...(model?.categories ?? [])])];
  const blocked = local.hit || model?.decision === 'block';
  const uncertain = !!modelReview && !model; // 模型不可用/格式错误
  // fail-closed：block 模式下，模型不可用也算拦截（warn 模式只记录）。
  const decision = blocked ? 'block' : (uncertain && c.failClosed && c.mode === 'block' ? 'block' : 'allow');
  const action = decision === 'block' ? (c.mode === 'block' ? 'block' : 'warn') : 'allow';
  const reason = local.hit ? `local:${local.categories.join(',')}`
    : model?.reason || (uncertain ? `model:${modelError || 'unavailable'}` : 'clean');
  return { decision, action, categories, reason, hash, matched: local.matched.slice(0, 5), modelError };
}

/** 审核记录：只存 hash/分类/分数/动作/时间，不含原文。 */
export function appendAudit(root, entry, cfg = {}) {
  const c = normalizeReviewConfig(cfg);
  const file = path.resolve(root, String(c.auditFile || DEFAULT_REVIEW.auditFile));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({
      at: Date.now(),
      hash: entry.hash,
      action: entry.action,
      decision: entry.decision,
      categories: entry.categories,
      reason: String(entry.reason ?? '').slice(0, 300)
    }) + '\n', 'utf8');
    return true;
  } catch (error) {
    return false;
  }
}

/** 控制台：最近审核统计（只读摘要）。 */
export function auditStats(root, cfg = {}, { limit = 50 } = {}) {
  const c = normalizeReviewConfig(cfg);
  const file = path.resolve(root, String(c.auditFile || DEFAULT_REVIEW.auditFile));
  const out = { total: 0, blocked: 0, warned: 0, byCategory: {}, recent: [] };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  const lines = text.split('\n').filter(Boolean);
  out.total = lines.length;
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.action === 'block') out.blocked++;
    else if (e.action === 'warn') out.warned++;
    for (const cat of e.categories || []) out.byCategory[cat] = (out.byCategory[cat] || 0) + 1;
  }
  out.recent = lines.slice(-Math.max(1, Math.min(200, limit))).reverse().map((line) => {
    try { const e = JSON.parse(line); return { at: e.at, action: e.action, categories: e.categories, hash: String(e.hash || '').slice(0, 12) }; } catch { return null; }
  }).filter(Boolean);
  return out;
}
