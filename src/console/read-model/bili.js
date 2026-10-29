// R4.7-2：B站 / TTS / 入群请求 / 缓存读模型。
//
// 这些 GET 端点原先从 30 项平铺依赖里拼响应。这里只读：不排期、不写配置、
// 不清理缓存。B站记录/搜索/观看/暂停/手动刷、TTS 试听/选路径、缓存清理在
// `src/console/commands/bili.js`。

export function createBiliReadModel({
  cfg = {},
  ROOT,
  live = {},
  socialV2 = { conversations: new Map() },
  biliBrowseState = {},
  CACHE_GROUPS,
  DEFAULT_SOVITS_DIR,
  TTS_DEFAULT_PROBABILITY,
  joinQueue,
  collectCacheItems,
  summarizeCache,
  groupActivityScore,
  ttsNum,
  ttsSpeechParams,
  path
} = {}) {
  /** GET /api/socialV2/bili-memory：全局观看记忆（跨群共用）。 */
  function memory({ key, limit, likedOnly, query } = {}) {
    if (!live.biliMem) return { ok: false, status: 400, error: 'B 站功能未启用' };
    const lim = Math.min(50, Math.max(1, Number(limit) || 10));
    let list = live.biliMem.recent(lim, { likedOnly: likedOnly === true });
    if (query) {
      const q = String(query).toLowerCase();
      list = list.filter((v) =>
        String(v.title).toLowerCase().includes(q)
        || String(v.owner).toLowerCase().includes(q)
        || (v.tags || []).some((t) => String(t).toLowerCase().includes(q)));
    }
    return { ok: true, videos: list, taste: live.biliMem.taste(), stats: live.biliMem.stats() };
  }

  /** GET /api/socialV2/join-requests：加好友/入群待决列表。 */
  function joinRequests() {
    const jr = cfg.socialV2?.joinRequest ?? {};
    return {
      ok: true,
      enabled: jr.enabled !== false,
      autoApprove: jr.autoApprove === true,
      ttlMs: joinQueue.ttlMs,
      ownerConfigured: !!String(cfg.ownerQQ ?? '').trim(),
      pending: joinQueue.list().map((it) => ({
        n: it.n,
        requestType: it.requestType,
        subType: it.subType,
        userId: it.userId,
        nickname: it.nickname || '',
        groupId: it.groupId,
        groupName: it.groupName || '',
        comment: it.comment || '',
        at: it.at,
        remainMs: Math.max(0, joinQueue.ttlMs - (Date.now() - Number(it.at || 0)))
      }))
    };
  }

  /** GET /api/socialV2/cache：只盘点，不删除。 */
  function cache() {
    try {
      const items = collectCacheItems({
        root: ROOT,
        ttsDir: cfg.socialV2?.tts?.enabled === true ? (cfg.socialV2.tts.dir || DEFAULT_SOVITS_DIR) : '',
        // 收藏目录可被配置覆盖；不传则用 <项目>/collected
        collectedDir: cfg.socialV2?.images?.archiveDir || ''
      });
      return { ok: true, items, groups: CACHE_GROUPS, summary: summarizeCache(items) };
    } catch (error) {
      return { ok: false, status: 500, error: `盘点失败：${error?.message ?? error}` };
    }
  }

  /** GET /api/socialV2/tts-status：能不能发语音、什么音色、什么概率。 */
  function ttsStatus() {
    const t = cfg.socialV2?.tts ?? {};
    const st = live.ttsEngine ? live.ttsEngine.status() : null;
    const probe = live.ttsEngine ? live.ttsEngine.probe() : null;
    // 请求级韵律参数：控制台回填/保存用（改完即时生效）
    const speech = ttsSpeechParams();
    return {
      ok: true,
      enabled: t.enabled === true,
      // 可插拔的三种可见状态：未启用 / 已启用但不可用 / 可用
      usable: !!(st && st.available && st.enabled),
      state: st ? st.state : (t.enabled === true ? 'unavailable' : 'disabled'),
      voice: st?.voice || t.voiceName || '达妮娅',
      dir: st?.dir || t.dir || DEFAULT_SOVITS_DIR,
      device: st?.device || t.device || 'cuda',
      // 实际加载的权重/版本：引擎就绪时以引擎回报为准。
      gptModel: st?.gptModel || (t.gptModel ? path.basename(String(t.gptModel)) : ''),
      sovitsModel: st?.sovitsModel || (t.sovitsModel ? path.basename(String(t.sovitsModel)) : ''),
      modelVersion: st?.version || '',
      loadSec: st?.loadSec ?? null,
      warmed: st?.warmed ?? null,
      // 只有真正不可用时才回显 error；可用时若还带着"未初始化"这类
      // 初始化期的残留文案，会和"可用"状态自相矛盾。
      error: (st && st.available && st.state === 'ready') ? null : (st?.error ?? (t.enabled === true ? '未初始化' : null)),
      retryInSec: st?.retryInMs ? Math.round(st.retryInMs / 1000) : 0,
      probability: Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY))),
      maxPerHour: ttsNum(t.maxPerHour, 3, 0, 60),
      maxChars: ttsNum(t.maxChars, 140, 20, 300),
      refText: probe?.refText ? String(probe.refText).slice(0, 80) : '',
      // ── 音色预设（voices.json）──────────────────────────────────
      // refs 只回 id/mood/label，不回绝对路径。
      voiceId: st?.voiceId || t.voiceId || '',
      weightsId: st?.weightsId || t.weightsId || '',
      weightsLabel: st?.weightsLabel || '',
      refs: st?.refs || [],
      defaultRefId: st?.defaultRefId || '',
      refMode: st?.refMode || t.refMode || 'auto',
      voices: probe?.voices || [],
      manifestPath: probe?.manifestPath || '',
      manifestError: probe?.manifestError || '',
      speech,
      // ── 可编辑参数 ──────────────────────────────────────────────
      // 分两类，因为生效时机不同：
      //   ① 即时生效：概率/上限/字数——planTtsV2 与端点每次都现读 cfg；
      //   ② 需重启：dir/模型路径/device/线程——它们在启动时传给引擎并进了闭包。
      editable: {
        probability: Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY))),
        maxPerHour: ttsNum(t.maxPerHour, 3, 0, 60),
        maxChars: ttsNum(t.maxChars, 140, 20, 300),
        dir: String(t.dir || DEFAULT_SOVITS_DIR),
        gptModel: String(t.gptModel || 'GPT_SoVITS/dania-e15.ckpt'),
        sovitsModel: String(t.sovitsModel || 'GPT_SoVITS/dania_e16_s2192.pth'),
        device: String(t.device || 'cuda'),
        cpuThreads: Math.max(1, Number(t.cpuThreads) || 8),
        voiceName: String(t.voiceName || '达妮娅'),
        voiceId: String(t.voiceId || ''),
        weightsId: String(t.weightsId || ''),
        refMode: String(t.refMode || 'auto'),
        ...speech
      },
      summary: (() => {
        if (t.enabled !== true) return '未启用：只发文字';
        if (!st || !st.available) return `已启用但不可用：${st?.error || (probe ? '探测失败' : '未初始化')}`;
        if (st.state === 'ready') {
          return `可用（${st.voice}）· ${Math.round(Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY))) * 100)}% 概率发语音`
            + ` · 每小时最多 ${ttsNum(t.maxPerHour, 3, 0, 60)} 条`;
        }
        if (st.state === 'failed') return `已启用但启动失败：${st.error}（稍后自动重试）`;
        return '已启用，等待首次加载（约 10~25 秒，不阻塞文字）';
      })()
    };
  }

  /** GET /api/socialV2/bili-status：自主刷状态、额度、分享目的地与记忆摘要。 */
  function biliStatus() {
    const b = cfg.socialV2?.bili ?? {};
    const sb = b.selfBrowsing ?? {};
    const today = live.biliMem ? live.biliMem.todayUsage() : { seconds: 0, videos: 0 };
    const budget = Math.max(0, Number(sb.dailyBudgetSec) || 0);
    const now = Date.now();
    const browsing = live.biliBrowsing
      ? {
          active: true,
          phase: biliBrowseState.phase || 'starting',
          since: biliBrowseState.startedAt || now,
          video: biliBrowseState.video || null,
          key: biliBrowseState.key || '',
          elapsedSec: Math.round((now - (biliBrowseState.startedAt || now)) / 1000)
        }
      : { active: false };
    return {
      ok: true,
      enabled: b.enabled !== false,
      selfBrowsing: {
        enabled: sb.enabled !== false,
        // 控制台按钮据此显示"已暂停 / 恢复自主刷"
        paused: sb.enabled === false,
        dailyBudgetSec: budget,
        usedSec: today.seconds,
        remainingSec: Math.max(0, budget - today.seconds),
        videosToday: today.videos,
        lastBrowseAt: live.lastBiliBrowseAt || 0,
        // 下次自己刷还有多久：以**本次调度的起点** + 随机间隔计算。
        // 用 lastBiliBrowseAt 会算错——那个是"上次真的看了"的时间，
        // 而调度可能在它之后才设定（比如跳过某一轮后重新排期）。
        nextInSec: live.biliTimer && live.biliScheduledAt
          ? Math.max(0, Math.round((live.biliScheduledAt + (live.biliNextDelay || 0) - now) / 1000))
          : 0,
        browsing,
        lastVideo: live.lastBiliWatch || null,
        categoryWeights: sb.categoryWeights || null,
        // 主动搜索：开关、上次搜的关键词、凭据状态（**只报状态，不暴露 cookie**）
        search: {
          enabled: sb.search?.enabled !== false,
          lastKeyword: live.lastBiliSearchKeyword || '',
          auth: live.biliAuth.loaded
            ? { loaded: true, hasLogin: !!live.biliAuth.hasSessdata }
            : { loaded: false, reason: live.biliAuth.reason }
        },
        // 声音内容（听觉）：字幕优先、ASR 兜底
        audio: (() => {
          const asr = live.asrEngine ? live.asrEngine.status() : null;
          const cfgAsr = b.asr ?? {};
          return {
            subtitleAvailable: !!live.biliAuth.hasSessdata,
            subtitleReason: live.biliAuth.hasSessdata ? '' : (live.biliAuth.loaded ? '凭据已加载但无登录态' : '未配置 B 站凭据'),
            asrEnabled: cfgAsr.enabled !== false,
            asrConfigured: !!asr,
            asrState: asr?.state ?? 'disabled',
            asrModel: asr?.model ?? '',
            asrModelPath: asr?.modelPath ?? '',
            asrModelKind: asr?.modelKind ?? '',
            asrThreads: asr?.cpuThreads ?? null,
            asrLoadSec: asr?.loadSec ?? null,
            asrError: asr?.error ?? null,
            asrRetryInSec: asr?.retryInMs ? Math.round(asr.retryInMs / 1000) : 0,
            summary: asr?.state === 'ready'
              ? (live.biliAuth.hasSessdata
                ? '字幕优先，字幕缺失时用本地语音识别补'
                : '未登录 B 站：全部走本地语音识别')
              : (asr?.state === 'failed'
                ? `语音识别不可用（${asr.error || '未知原因'}）：只有画面`
                : (asr ? '语音识别待加载（首次用时自动加载，约 8 秒）'
                  : '未启用语音识别：只有画面'))
          };
        })()
      },
      share: {
        enabled: b.share?.enabled !== false,
        minInterest: b.share?.minInterest,
        probability: b.share?.probability,
        lastShareAt: live.lastBiliShareAt || 0,
        nextAllowedInSec: live.lastBiliShareAt
          ? Math.max(0, Math.round((live.lastBiliShareAt + (Number(b.share?.minGapMs) || 6 * 3600 * 1000) - now) / 1000))
          : 0,
        // 推荐目的地策略（2026-10-21 用户要求「更多推荐给活跃的群聊」）
        preferActiveGroups: b.share?.preferActiveGroups !== false,
        activeWindowHours: Math.max(1, Number(b.share?.activeWindowHours) || 24),
        minActivityForShare: Math.max(0, Number(b.share?.minActivityForShare) || 0),
        // 各群活跃度：控制台据此显示"推荐会落到哪些群"
        groups: [...socialV2.conversations.entries()]
          .filter(([k]) => k.startsWith('group:'))
          .map(([k, st]) => {
            const hours = Math.max(1, Number(b.share?.activeWindowHours) || 24);
            const activity = groupActivityScore(st, { hours, now });
            return {
              key: k,
              activity,
              shareEligible: activity >= Math.max(1, Number(b.share?.minActivityForShare) || 1),
              lastActionAt: Number(st.lastActionAt) || 0
            };
          })
          .sort((x, y) => y.activity - x.activity)
      },
      memory: live.biliMem ? live.biliMem.stats() : null,
      taste: live.biliMem ? live.biliMem.taste(5) : null,
      recent: live.biliMem ? live.biliMem.recent(6).map((v) => ({
        bvid: v.bvid, title: v.title, owner: v.owner, category: v.category,
        liked: v.liked, interest: v.interest, tags: v.tags, lastSeenAt: v.lastSeenAt, source: v.source,
        desc: String(v.desc || '').slice(0, 120)
      })) : []
    };
  }

  return { memory, joinRequests, cache, ttsStatus, biliStatus };
}
