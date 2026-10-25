// 自主浏览编排：列表/搜索 → 初判 → 可选追加 → 记账/投递/分享。
import { GAME_KEYWORDS, buildBrowsePrompt, buildExtendedPrompt,
  canSelfBrowse, pickCandidate as defaultPickCandidate, watchVideo as defaultWatchVideo } from '../bili-browse.js';
import { fetchPopularVideos as defaultFetchPopularVideos } from '../bili.js';
import { buildSearchKeywords, pickSearchQuery, searchVideos as defaultSearchVideos } from '../bili-auth.js';

export function createBiliRuntime(deps) {
  const { cfg, socialV2, live, log, scheduleBiliBrowse, pickBiliSessionKey, biliBrowseState,
    isTokenFused = () => false,
    rememberBiliInfo, judgeBiliScan, deliverBiliPrompt, maybeShareBiliVideo,
    fetchPopularVideos = defaultFetchPopularVideos, searchVideos = defaultSearchVideos,
    watchVideo = defaultWatchVideo, pickCandidate = defaultPickCandidate } = deps;
  // manual 仅跳过自主排期和间隔，仍遵守每日观看额度。
  async function runBiliBrowse(opts = {}) {
    const manual = opts.manual === true;
    const b = cfg.socialV2?.bili ?? {};
    const sb = b.selfBrowsing ?? {};
    if (b.enabled === false || !live.biliMem) return { ok: false, reason: 'B 站功能未启用' };
    // 暂停只停"自动排期"，**不拦手动触发**——手动是你明确让它看一条，不是自主行为。
    // 但返回里带上 paused 标记，控制台据此提示"当前是暂停状态，这条是手动触发的"，
    // 免得用户以为暂停没生效。
    const manualWhilePaused = manual && sb.enabled === false;
    if (live.biliBrowsing) {
      log('[B站] 上一轮还没结束，跳过这次');
      if (!manual) scheduleBiliBrowse();
      return { ok: false, reason: '上一轮还没结束' };
    }
    // 额度：按今日已用秒数判断
    const today = live.biliMem.todayUsage();
    const gate = canSelfBrowse({
      budgetSec: sb.dailyBudgetSec,
      todaySeconds: today.seconds,
      // 手动触发不受间隔限制：把 lastAt 置 0 让间隔检查必然通过
      lastAt: manual ? 0 : live.lastBiliBrowseAt,
      minIntervalMs: manual ? 0 : sb.minIntervalMs
    });
    if (!gate.allowed) {
      log(`[B站] 跳过自己刷：${gate.reason}（剩余额度 ${Math.round(gate.remainingSec)}s）`);
      if (!manual) scheduleBiliBrowse();
      return { ok: false, reason: gate.reason };
    }
    // 只在潜水时刷（用户没要求，但 active 时刷会抢回复；配成 false 可关闭此限制）
    if (sb.onlyWhenDiving !== false) {
      const anyActive = [...socialV2.conversations.entries()]
        .some(([k, st]) => k.startsWith('group:') && st.phase === 'active');
      if (anyActive) {
        log('[B站] 有群正在活跃，这次不刷');
        if (!manual) scheduleBiliBrowse();
        return { ok: false, reason: '有群正在活跃（潜水时才刷）' };
      }
    }
    // 落脚群（承载模型会话）与"推荐目标群"是两件事：
    //   - 落脚群：任一空闲会话即可，冷群也行（只要能承载画面）；
    //   - 推荐目标：用户要求「更多推荐给活跃的群聊」——必须是真的有人在说话的群。
    // 旧实现把两者绑在一起，而选群规则是"最久没动静的"，于是推荐总落在冷群里。
    const key = pickBiliSessionKey();
    if (!key) {
      log('[B站] 没有空闲会话可以落脚，跳过这次');
      if (!manual) scheduleBiliBrowse();
      return { ok: false, reason: '没有空闲会话可以落脚' };
    }
    // 会话级 Token 熔断：只拦自主刷；手动「现在刷一条」是明确指令，放行并标记。
    const fused = isTokenFused(key) === true;
    if (fused && !manual) {
      log(`[B站] 跳过自己刷：落脚会话 ${key} 已 Token 熔断`);
      scheduleBiliBrowse();
      return { ok: false, reason: 'token-fused' };
    }
    const manualWhileFused = fused && manual;
    // 预览推荐会落在哪个群（不设活跃门槛时返回 null，由 maybeShareBiliVideo 决定不发）
    const shareKey = pickBiliSessionKey({ requireActive: true });

    live.biliBrowsing = true;
    biliBrowseState.startedAt = Date.now();
    biliBrowseState.key = key;
    biliBrowseState.video = null;
    biliBrowseState.phase = 'fetching-list';
    try {
      // 候选池 = 热门榜多页 **+ 主动搜索**（2026-10-19 加搜索）。
      //
      // 为什么要搜索：热门榜是"别人决定给你看什么"，只有搜索才能主动找
      // "我喜欢的那类"。关键词来自：群友常玩的游戏 → 记忆里喜欢过的标签 → 分区兜底。
      //
      // 搜索接口的前提（实测）：`search/type` 在**完全不带 cookie** 时返回
      // `-412 request was banned`；带上任意 buvid3 就正常返回 20 条/页。
      // 所以凭据不是"必须登录"，而是"必须有设备/登录标识"——见 bili-auth.js。
      //
      // 注：分区榜 `ranking/v2?rid=4` 实测持续 -352（真风控），仍未使用。
      const pages = Math.max(1, Math.min(5, Number(sb.poolPages) || 3));
      const poolResults = await Promise.all(
        Array.from({ length: pages }, (_, i) =>
          fetchPopularVideos({ count: 50, page: i + 1 }).catch(() => []))
      );

      // 口味归纳只读一次：选片和搜索关键词都要用（taste() 每次都会读盘+统计）
      const taste = live.biliMem.taste(10);

      // 搜索候选：每次随机挑一个关键词（避免总搜同一个）
      let searchHits = [];
      if (sb.search?.enabled !== false) {
        try {
          const keywords = buildSearchKeywords(
            { likedTags: taste.totalTags, categories: taste.categories },
            sb.search?.gamesOnly === true
              ? GAME_KEYWORDS.map((g) => g.name)
              : GAME_KEYWORDS.map((g) => g.name),
            { max: Number(sb.search?.maxKeywords) || 6 }
          );
          const kw = pickSearchQuery(keywords);
          if (kw) {
            biliBrowseState.phase = 'searching';
            live.lastBiliSearchKeyword = kw;
            const order = ['totalrank', 'pubdate', 'click'].includes(sb.search?.order)
              ? sb.search.order : 'totalrank';
            searchHits = await searchVideos(kw, live.biliAuth, {
              count: Number(sb.search?.count) || 20,
              order
            });
            if (searchHits.length) {
              log(`[B站] 主动搜索「${kw}」得到 ${searchHits.length} 条`);
            }
          }
        } catch (error) {
          // 搜索失败不影响热门榜那条路（降级而非中断）
          log(`[B站] 搜索失败（改用热门榜）：${error?.message ?? error}`);
        }
      }

      // 按 bvid 去重（热门各页、热门与搜索之间都可能重叠）
      const seenIds = new Set();
      const list = [];
      for (const v of [...poolResults.flat(), ...searchHits]) {
        if (!v?.bvid || seenIds.has(v.bvid)) continue;
        seenIds.add(v.bvid);
        list.push(v);
      }
      biliBrowseState.phase = 'picking';
      const pick = pickCandidate(list, (bvid) => live.biliMem.get(bvid), {
        cooldownMs: sb.seenCooldownMs,
        // 分区偏好：默认偏向二次元/游戏/科技/社会热点（见 bili-browse.js 的权重表）。
        weights: sb.categoryWeights,
        // 群友常玩的游戏额外加权（用户要求"多看这些"）
        gameBoost: sb.gameBoost,
        preferGames: sb.preferGames !== false,
        // 把记忆里的高频标签带上，让"我喜欢什么"能自我强化（上限 2 倍，不会垄断）
        likedTags: taste.totalTags,
        // 喜欢过的 UP 主（≥2 次才加分）：比标签更硬的偏好信号
        likedOwners: taste.owners
      });
      if (!pick) {
        log('[B站] 候选都看过（冷却期内），这次不刷');
        return { ok: false, reason: '候选都在冷却期内（最近都看过）' };
      }
      biliBrowseState.video = { bvid: pick.bvid, title: pick.title, owner: pick.owner, category: pick.category };
      biliBrowseState.phase = 'downloading';

      // ── 两段式观看：先浅看判断，喜欢再多看一段 ──────────────────────────
      //
      // 为什么改成两段（2026-10-19 用户问「为什么总是只看 8s11 帧，不是说感兴趣就多看吗」）：
      //   原实现**先定看多深、再去看**，而"喜不喜欢"要看完才知道，所以永远走
      //   `watchDepth(null)` 的中庸分支（8s/11 帧），`framesLiked`/`framesDisliked` 从未生效。
      // 现在的顺序：浅看（6s/6 帧）→ 让模型只回一行 JSON 判断 → 喜欢则追加到 120s/120 帧。
      //
      // 采样密度（2026-10-19 用户要求「帧间隔缩短一些，最好一秒取样一次」）：
      //   帧数不再跟 `framesLiked/framesDisliked` 死绑，而是**按秒数 × framesPerSecond** 算。
      //   120 秒按 1 帧/秒 = 120 帧，超过每张拼图 30 格的上限 → 自动切成 4 张图
      //   （见 bili.js 的分页拼图）。所以"看得更细"不会把单帧压成看不清的小方块。
      //
      // 额度：两段的总秒数都要记进"今日已看"，且不超过剩余额度。
      const remain = Math.max(1, gate.remainingSec);
      const density = Math.max(0.1, Math.min(4, Number(sb.framesPerSecond) || 1));
      const maxFramesTotal = Math.max(8, Math.min(120, Number(sb.maxFramesTotal) || 120));
      const framesFor = (sec) => Math.min(maxFramesTotal, Math.max(1, Math.round(sec * density)));
      const tilesPerSheet = Math.max(4, Math.min(36, Number(sb.tilesPerSheet) || 30));
      // 浅看用"不喜欢"的深度（扫一眼），喜欢才追加到"喜欢"的深度。
      // 秒数取配置里 twoPass 的值，没有就按帧数比例给默认（6s / 120s）。
      const scanSeconds = Math.min(
        Number(sb.scanSeconds) || Number(sb.dislikedSeconds) || 6,
        remain
      );
      const likeSeconds = Math.min(
        Number(sb.likedSeconds) || 120,
        Number(sb.maxSecondsPerVideo) || 240,
        remain
      );

      biliBrowseState.phase = 'scanning';
      const scan = await watchVideo(pick.bvid, {
        info: pick,
        seconds: scanSeconds,
        frames: framesFor(scanSeconds),
        tilesPerSheet,
        // 声音内容：有字幕用字幕，没字幕用本地 ASR（见 bili-browse 的说明）
        asr: live.asrEngine,
        asrEnabled: !!live.asrEngine,
        asrTimeoutMs: Number(sb.asrTimeoutMs) || 120000
      });
      if (!scan.ok) {
        log(`[B站] 看 ${pick.bvid} 失败：${scan.error}`);
        live.lastBiliWatch = { bvid: pick.bvid, title: pick.title, ok: false, error: scan.error, at: Date.now() };
        return { ok: false, reason: `看视频失败：${scan.error}` };
      }
      // 缓存元信息（含简介），供模型稍后 qq_bili_record 时补全
      rememberBiliInfo(scan.info, scan.grid);

      // 第一段交给模型做初判（只回 JSON，不发群）
      let verdict = { liked: null, interest: null, tags: [], notes: '' };
      try {
        biliBrowseState.phase = 'judging';
        const judged = await judgeBiliScan(key, pick, scan);
        if (judged) verdict = judged;
      } catch (error) {
        log(`[B站] 初判失败（按"没判断出来"继续）：${error?.message ?? error}`);
      }

      // 喜欢且额度够 → 追加观看（时间窗口变长，不是另截一段）
      let finalWatch = scan;
      let extended = false;
      if (verdict.liked === true && likeSeconds > scanSeconds) {
        biliBrowseState.phase = 'extending';
        const longer = await watchVideo(pick.bvid, {
          info: pick,
          seconds: likeSeconds,
          frames: framesFor(likeSeconds),
          tilesPerSheet,
          asr: live.asrEngine,
          asrEnabled: !!live.asrEngine,
          asrTimeoutMs: Number(sb.asrTimeoutMs) || 120000
        });
        if (longer.ok) {
          finalWatch = longer;
          extended = true;
        } else {
          log(`[B站] 追加观看失败，保留第一次的画面：${longer.error}`);
        }
      }

      const watchedSeconds = extended ? likeSeconds : scanSeconds;
      // 记账按**实际拿到的帧数**（抽帧可能因超时/源限制少于请求值）
      const watchedFrames = Number(finalWatch.grid?.frames) || framesFor(watchedSeconds);
      // 追加观看后字幕窗口更长：用最终的覆盖一次缓存（同一 bvid 直接覆盖）
      if (extended) rememberBiliInfo(finalWatch.info, finalWatch.grid);

      // 记账：按实际观看秒数
      live.biliMem.addUsage(watchedSeconds);
      live.lastBiliBrowseAt = Date.now();
      live.lastBiliWatch = {
        bvid: finalWatch.info.bvid, title: finalWatch.info.title,
        owner: finalWatch.info.owner, category: finalWatch.info.category,
        seconds: watchedSeconds, frames: watchedFrames,
        extended, liked: verdict.liked, interest: verdict.interest,
        ok: true, at: Date.now(), key
      };

      biliBrowseState.phase = 'delivering';
      // 判断已经做过了：喜欢的走"继续看"提示词（要求记录），不喜欢/没判断的直接记录
      const prompt = extended
        ? buildExtendedPrompt(finalWatch.info, finalWatch.hint, verdict.notes)
        : buildBrowsePrompt(finalWatch.info, finalWatch.hint, finalWatch.grid);
      await deliverBiliPrompt(key, prompt, finalWatch.grid);
      biliBrowseState.phase = 'done';
      log(`[B站] 自己刷了《${finalWatch.info.title.slice(0, 30)}》`
        + `(${watchedSeconds}s / ${watchedFrames} 帧${extended ? '，初判喜欢已追加' : '，扫一眼就过'}) → ${key}`);

      // ── 推荐分享（用户要求「推荐视频时顺便给出标题和链接」）──
      // 条件：喜欢 + 兴趣分够 + 概率命中 + 距上次分享够久。
      // 分享内容 = 标题 + 链接 + 一句推荐语，**由模型自己组织**（不是模板文案），
      // 这样才像人说话；但链接和标题必须原样给出，不能让模型自己编。
      let shared = null;
      if (verdict.liked === true) {
        try {
          // 推荐发到活跃群；没有活跃群时 shareKey 为 null，maybeShareBiliVideo 会跳过
          shared = await maybeShareBiliVideo(shareKey, finalWatch.info, verdict);
        } catch (error) {
          log(`[B站] 分享失败（不影响观看）：${error?.message ?? error}`);
        }
      }

      return {
        ok: true,
        video: {
          bvid: finalWatch.info.bvid, title: finalWatch.info.title,
          owner: finalWatch.info.owner, category: finalWatch.info.category
        },
        seconds: watchedSeconds,
        frames: watchedFrames,
        extended,
        liked: verdict.liked,
        shared: shared || undefined,
        // 暂停状态下手动触发的：控制台要能说明"这条是手动点的，不是它自己又开始刷了"
        manualWhilePaused: manualWhilePaused || undefined,
        key
      };
    } finally {
      live.biliBrowsing = false;
      biliBrowseState.phase = '';
      biliBrowseState.startedAt = 0;
      biliBrowseState.video = null;
      biliBrowseState.key = '';
      scheduleBiliBrowse();
    }
  }


  return { runBiliBrowse };
}
