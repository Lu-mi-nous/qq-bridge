// R4.7-2：图片领域读模型（预检 / 图库统计 / 取图额度 / 来源页）。
//
// 四个 GET 端点原先从 40+ 项平铺依赖里拼响应。这里只读：不发图、不写图库、
// 不触发拉取；发图/收藏/拒绝/反查/刷新在 `src/console/commands/images.js`。
//
// 额度口径（2026-10-20 用户要求）必须保留三类独立上限的区分：
//   ① 图库容量（maxFiles / maxTotalBytes）——满了淘汰旧图，不代表不能用
//   ② 拉取冷却（cooldownMs）——两次补货的最小间隔
//   ③ SauceNAO 反查额度——唯一真正的上游免费额度

export function createImagesReadModel({
  cfg = {},
  live = {},
  imageStore,
  lastSentImage,
  imagesEnabled,
  imagePreflightV2,
  imageSendAllowed,
  normalizeSourceFilter,
  sourcePageOf,
  reverseSearcher
} = {}) {
  /** GET /api/socialV2/image-preflight：毫秒级告知「会立刻发」还是「要现拉等一会儿」。 */
  function preflight({ key, rawTags = '', rawSources = '' } = {}) {
    const tags = rawTags ? String(rawTags).split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean) : [];
    const pf = imagePreflightV2?.(tags, rawSources, key) || {};
    const gate = imageSendAllowed?.(key) || { ok: true };
    // 已发图会被定期删除，所以「本地有」= 有**没发过的**图。
    // 这里把 TTL 说清楚，避免模型以为"本地永远有"而误判等待时间。
    const ttlMin = Math.round((Number(cfg.socialV2?.images?.sentTtlMs) || 0) / 60000);
    const srcFilter = normalizeSourceFilter?.(rawSources) || { requested: false, valid: [], unavailable: [] };
    return {
      ok: true,
      key,
      tags,
      ...(srcFilter.requested ? { sources: srcFilter.valid } : {}),
      // 说明这个源限制是哪来的：模型自己传的，还是桥接从群主的话里识别的。
      ...(srcFilter.requested && !normalizeSourceFilter?.(rawSources)?.requested
        ? { sourcesNote: `图源限制来自群主的话（${srcFilter.valid.join('/') || srcFilter.unavailable.join('/')}），桥接已自动应用，发图时不用重复传 sources。` }
        : {}),
      ...pf,
      sendAllowed: gate.ok,
      ...(gate.ok ? {} : { sendBlockedReason: gate.error }),
      ...(ttlMin > 0 ? { sentTtlMinutes: ttlMin } : {}),
      ...(srcFilter.unavailable.length ? { unavailableSources: srcFilter.unavailable } : {}),
      advice: srcFilter.requested && !srcFilter.valid.length
        ? `群主要求的图源（${srcFilter.unavailable.join('/')}）当前不可用，所以查不到任何图（也不会退回其他站点，因为那不符合要求）。可用图源：${Object.entries(cfg.socialV2?.images?.sources ?? {}).filter(([, v]) => v?.enabled === true).map(([k]) => k).join('/') || '无'}。请告诉群主这个站点目前用不了。`
        : pf.willWait
          ? `本地没有匹配的图（发过的图会在 ${ttlMin > 0 ? `${ttlMin} 分钟后被清理` : '下次清理时移除'}，所以库里主要是不重复的新图），这次发图需要现去图站拉取（可能 5~30 秒）${srcFilter.valid.length ? `，且只会在 ${srcFilter.valid.join('/')} 上找` : ''}。建议先用 qq_send_message 回一句（例如「等我找找」）再调用 qq_send_image，这样不会让对方干等；拉取期间你无法回应新消息。`
          : `本地有 ${pf.count} 张匹配的图${srcFilter.valid.length ? `（仅统计 ${srcFilter.valid.join('/')}）` : ''}，会立刻发出（约 0.1 秒），可以直接调用 qq_send_image。`
    };
  }

  function stats() {
    return {
      ok: true,
      enabled: imagesEnabled?.(),
      libDir: imageStore?.libDir,
      ...(imageStore?.stats?.() || {}),
      fetchedAt: live.imageFetchedAt || null,
      sources: Object.fromEntries(
        Object.entries(cfg.socialV2?.images?.sources ?? {}).map(([n, c]) => [n, { enabled: c?.enabled === true, limit: c?.limit ?? 20 }])
      )
    };
  }

  function quota() {
    const ic = cfg.socialV2?.images ?? {};
    const now = Date.now();
    let lib = null;
    try { lib = imageStore?.stats?.() ?? null; } catch { lib = null; }

    const cooldownMs = Math.max(0, Number(ic.cooldownMs) || 0);
    const sinceFetch = live.imageFetchedAt ? now - live.imageFetchedAt : Infinity;
    const cooling = cooldownMs > 0 && live.imageFetchedAt > 0 && sinceFetch < cooldownMs;
    const rs = reverseSearcher?.stats?.() || {};

    const srcCfg = ic.sources ?? {};
    const sources = Object.keys(srcCfg).map((name) => ({
      name,
      enabled: srcCfg[name]?.enabled === true,
      limit: Number(srcCfg[name]?.limit) || 0,
      hasProxy: !!String(srcCfg[name]?.proxy || ic.proxy || '').trim()
    }));

    return {
      ok: true,
      enabled: imagesEnabled?.(),
      library: lib,
      fetch: {
        cooldownMs,
        lastFetchedAt: live.imageFetchedAt || 0,
        cooling,
        remainMs: cooling ? Math.max(0, cooldownMs - sinceFetch) : 0,
        fetching: !!live.imageFetching,
        fetchPerRun: Math.max(1, Number(ic.fetchPerRun) || 20)
      },
      reverseSearch: {
        hasKey: rs.hasKey,
        usedToday: rs.usedToday,
        dailyMax: rs.dailyMax,
        remainingToday: rs.remainingToday,
        windowMax: rs.windowMax,
        windowUsed: rs.windowUsed,
        windowResetMs: rs.windowResetMs,
        cached: rs.cached
      },
      send: {
        cooldownMs: Math.max(0, Number(ic.sendCooldownMs) || 0),
        maxSendPerHour: Math.max(0, Number(ic.maxSendPerHour) || 0)
      },
      sources
    };
  }

  /** GET /api/socialV2/image-source：图库条目的图源页与元数据。 */
  function source({ key, id } = {}) {
    const wantId = String(id ?? '').trim();
    let entry = wantId ? imageStore?.getById?.(wantId) : null;
    if (!entry && key) {
      const last = lastSentImage?.get(key);
      if (last) entry = imageStore?.getById?.(last.id) ?? last.entry ?? null;
    }
    if (!entry) {
      return {
        ok: false,
        status: 404,
        error: wantId ? `图库中没有 ${wantId}` : '本会话最近没有发出过图，也请传 id'
      };
    }
    const sp = sourcePageOf?.(entry);
    return {
      ok: true,
      id: entry.id,
      source: entry.source || '',
      artist: entry.artist || '',
      artistId: entry.artistId || '',
      // originUrl：画师原始发布处；sourcePage：图源站条目页
      originUrl: entry.page || '',
      sourcePage: sp,
      tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 40) : [],
      rating: entry.rating || '',
      width: entry.width || 0,
      height: entry.height || 0,
      note: sp
        ? `这是在 ${entry.source} 上查这张图的页面：${sp}${entry.page && entry.page !== sp ? `；画师原始发布处：${entry.page}` : ''}`
        : '该图没有可推导的图源站点页面'
    };
  }

  return { preflight, stats, quota, source };
}
