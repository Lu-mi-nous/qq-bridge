// 图片请求服务（R3-9）：发图冷却、来源过滤、预检、原图收藏与来源标注。
import { createFeedbackGate } from './image-feedback.js';
import { createSourceHintStore } from './image-source-hint.js';
import { saveOriginalImage } from './image-archive.js';
import { safeFetchBuffer } from './safe-fetch.js';
import { sourcePageOf } from './image-sources.js';

export function createImageRequestService({
  cfg,
  imageStore,
  imageFetchUA = 'qq-bridge/0.1',
  sourceDownloadHeaders = {},
  log = () => {},
  now = Date.now
} = {}) {
  if (!cfg) throw new Error('createImageRequestService: cfg 不能为空');
  if (!imageStore) throw new Error('createImageRequestService: imageStore 不能为空');

  const imageSendTimes = new Map();
  const lastSentImage = new Map();
  const imageFeedbackGate = createFeedbackGate({
    cooldownMs: Math.max(0, Number(cfg.socialV2?.images?.feedbackCooldownMs) || 90 * 1000)
  });
  const sourceHints = createSourceHintStore({
    ttlMs: Math.max(0, Number(cfg.socialV2?.images?.sourceHintTtlMs) || 10 * 60 * 1000)
  });

  function normalizeSourceFilter(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，\s]+/);
    const requestedNames = [...new Set(list.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean))];
    if (!requestedNames.length) return { requested: false, valid: [], unavailable: [] };
    const enabled = Object.entries(cfg.socialV2?.images?.sources ?? {})
      .filter(([, v]) => v?.enabled === true)
      .map(([k]) => k.toLowerCase());
    return {
      requested: true,
      valid: requestedNames.filter((s) => enabled.includes(s)),
      unavailable: requestedNames.filter((s) => !enabled.includes(s))
    };
  }

  function sourcesWithHint(key, explicit) {
    const n = normalizeSourceFilter(explicit ?? '');
    if (n.requested) return n;
    const h = key ? sourceHints.get(key) : null;
    if (h?.sources?.length) return normalizeSourceFilter(h.sources);
    return n;
  }

  function sourceFilterForPick(filter) {
    if (!filter.requested) return {};
    if (!filter.valid.length) return { sources: ['__unavailable__'] };
    return { sources: filter.valid };
  }

  function groupImageOpts() {
    const ic = cfg.socialV2?.images ?? {};
    if (ic.preferSingleCharacter === false) return { allowGroupImages: true };
    return { charTagThreshold: Number(ic.groupCharTagThreshold) || 10 };
  }

  function sendAllowed(key, opts = {}) {
    const ic = cfg.socialV2.images;
    const at = now();
    const times = (imageSendTimes.get(key) ?? []).filter((t) => at - t < 3600000);
    if (opts.fromFeedback !== true) {
      const gap = Number(ic.sendCooldownMs) || 0;
      if (gap && times.length && at - times[times.length - 1] < gap) {
        return { ok: false, error: `发图太快了，再等 ${Math.ceil((gap - (at - times[times.length - 1])) / 1000)} 秒` };
      }
    }
    const cap = Number(ic.maxSendPerHour) || 0;
    if (cap && times.length >= cap) {
      return { ok: false, error: `本会话每小时最多发 ${cap} 张图，已达上限` };
    }
    return { ok: true, times };
  }

  function preflight(tags, sources, key = '') {
    const wantTags = Array.isArray(tags) ? tags.map((t) => String(t ?? '').trim()).filter(Boolean) : [];
    const wantSources = sourcesWithHint(key, sources);
    let count = 0;
    try {
      const probe = imageStore.pickRandom({ tags: wantTags, dryRun: true, ...sourceFilterForPick(wantSources), ...groupImageOpts() });
      count = Number(probe?.count) || 0;
    } catch { count = 0; }
    const hit = count > 0;
    return { hit, count, willWait: !hit, etaMs: hit ? [100, 300] : [5000, 30000] };
  }

  function annotation(entry) {
    if (cfg.socialV2?.images?.annotateSource === false) return '';
    const bits = [];
    if (entry.artist) bits.push(`画师 ${entry.artist}`);
    if (entry.page) bits.push(entry.page);
    const sp = sourcePageOf(entry);
    if (sp && sp !== entry.page) bits.push(`${entry.source || '来源'}：${sp}`);
    if (!bits.length) return '';
    return `图源 ${entry.source || ''}｜${bits.join('｜')}`.trim().slice(0, 300);
  }

  async function archive(entry) {
    const ic = cfg.socialV2?.images ?? {};
    const dir = String(ic.archiveDir || '').trim();
    if (!dir) throw new Error('未配置收藏目录（socialV2.images.archiveDir）');
    const maxBytes = Math.max(1024 * 1024, Number(ic.maxBytesPerFile) || 8 * 1024 * 1024) * 8;
    const srcProxy = String(ic.sources?.[entry.source]?.proxy ?? '').trim();
    const fallbackProxy = String(ic.proxy ?? '').trim();

    const fetchBuffer = async (url, { referer = '' } = {}) => {
      const headers = { 'user-agent': imageFetchUA, ...(sourceDownloadHeaders[entry.source] ?? {}), ...(referer ? { referer } : {}) };
      if (srcProxy) {
        const { proxyGet } = await import('./proxy-tunnel.js');
        const r = await proxyGet(url, { proxy: srcProxy, headers, maxBytes, timeoutMs: 90000 });
        if (r.status < 200 || r.status >= 300) throw new Error(`下载原图 HTTP ${r.status}`);
        return r.body;
      }
      try {
        const fetched = await safeFetchBuffer(url, maxBytes, { userAgent: imageFetchUA, headers });
        if (fetched?.buffer?.length) return fetched.buffer;
        throw new Error('下载得到空内容');
      } catch (error) {
        if (!fallbackProxy) throw error;
        log(`[图库] 直连下载原图失败（${error?.message ?? error}），改走代理重试`);
        const { proxyGet } = await import('./proxy-tunnel.js');
        const r = await proxyGet(url, { proxy: fallbackProxy, headers, maxBytes, timeoutMs: 90000 });
        if (r.status < 200 || r.status >= 300) throw new Error(`下载原图 HTTP ${r.status}`);
        return r.body;
      }
    };

    const jsonFetch = async (url, extra = {}) => {
      const headers = { 'user-agent': imageFetchUA, accept: 'application/json', ...(extra.referer ? { referer: extra.referer } : {}) };
      const parse = (txt) => JSON.parse(txt);
      if (srcProxy) {
        const { proxyGet } = await import('./proxy-tunnel.js');
        const r = await proxyGet(url, { proxy: srcProxy, headers, timeoutMs: 40000 });
        if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
        return parse(r.body.toString('utf8'));
      }
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
        if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
        return await r.json();
      } catch (error) {
        if (Number.isFinite(error?.status) || !fallbackProxy) throw error;
        const { proxyGet } = await import('./proxy-tunnel.js');
        const r = await proxyGet(url, { proxy: fallbackProxy, headers, timeoutMs: 40000 });
        if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
        return parse(r.body.toString('utf8'));
      }
    };

    return saveOriginalImage(entry, {
      dir, fetchBuffer, jsonFetch, log: (m) => log(`[图库] ${m}`), maxBytes,
      overwrite: ic.archiveOverwrite === true
    });
  }

  return {
    imageSendTimes,
    lastSentImage,
    imageFeedbackGate,
    sourceHints,
    normalizeSourceFilter,
    sourcesWithHint,
    sourceFilterForPick,
    groupImageOpts,
    sendAllowed,
    preflight,
    annotation,
    archive
  };
}
