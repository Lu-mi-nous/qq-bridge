// B 站落脚/推荐选群与发送前最终准入。
export function createBiliSharing(deps) {
  const { cfg, socialV2, live, isSessionAllowedInCurrentMode, isConversationBusyV2,
    shouldBlockSilentReply, sendToQQ, askModelOnce, log, random = Math.random } = deps;
  // 活跃度按时间窗口内的群友发言计数；机器人发言与 lastActionAt 不算群活跃。
  function groupActivityScore(st, opts = {}) {
    const hours = Math.max(0.1, Number(opts.hours) || 24);
    const now = Number(opts.now) || Date.now();
    const from = now - hours * 3600 * 1000;
    const msgs = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    let n = 0;
    for (const m of msgs) {
      if (!m || m.isSelf) continue;              // 机器人自己的发言不算群活跃
      const t = Number(m.time) || 0;
      if (t > 0 && t >= from) n += 1;
    }
    return n;
  }

  /**
   * 选一个群会话作为刷视频的落脚点（它得有个会话才能把画面交给模型）。
   *
   * 2026-10-21 用户要求：「B站视频推荐更多推荐给活跃的群聊而不是非活跃的」。
   *
   * 旧实现是"取 lastActionAt 最久没动静的那个"——那是**优先冷群**，
   * 与需求正好相反。现在的规则：
   *   ① 硬门槛：**近 `activeWindowHours`（默认 24h）群友发言数 ≥ `minActivityForShare`（默认 1）**
   *      才作为候选。完全没人说话的群不推荐（推了也没人看见，还浪费时间）。
   *   ② 候选内按活跃度**加权随机**（权重 = 发言数，有 `activityWeightCap` 上限防垄断）。
   *      不做纯"取最活跃"——那会让同一个群天天被推荐，其余群永远轮不到。
   */
  function pickBiliSessionKey(opts = {}) {
    const sb = cfg.socialV2?.bili?.selfBrowsing ?? {};
    const shareCfg = cfg.socialV2?.bili?.share ?? {};
    // 是否启用"优先活跃群"。默认开；关掉则退回旧的"最闲"策略。
    const preferActive = opts.preferActive ?? (shareCfg.preferActiveGroups !== false);
    const windowHours = Math.max(1, Number(shareCfg.activeWindowHours) || 24);
    const minActivity = Math.max(0, Number(opts.minActivity ?? shareCfg.minActivityForShare) || 0);
    const cap = Math.max(1, Number(shareCfg.activityWeightCap) || 50);
    const now = Date.now();

    const candidates = [];
    for (const [key, st] of socialV2.conversations) {
      if (!key.startsWith('group:')) continue;
      if (!isSessionAllowedInCurrentMode(key)) continue;
      // 有未读/繁忙的跳过：别在人正聊着的时候插进来刷视频
      if (isConversationBusyV2(key, st)) continue;
      if (Array.isArray(st.unread) && st.unread.length > 0) continue;
      const activity = groupActivityScore(st, { hours: windowHours, now });
      // 没指定 minActivity 时（内部刷视频选落脚点）不设活跃门槛——
      // 刷视频本身只需要一个能承载画面的会话，冷群也可以。
      // 只有"推荐到群里"这条路径才要求群真的在说话（见 runBiliBrowse）。
      if (opts.requireActive === true && activity < Math.max(1, minActivity)) continue;
      candidates.push({
        key,
        activity,
        lastActionAt: Number(st.lastActionAt) || 0,
        weight: Math.min(cap, Math.max(1, activity))
      });
    }
    if (!candidates.length) return null;

    if (!preferActive) {
      // 旧行为：最久没动静的那个（最闲）
      candidates.sort((a, b) => a.lastActionAt - b.lastActionAt);
      return candidates[0].key;
    }

    // 按活跃度加权随机
    const total = candidates.reduce((a, c) => a + c.weight, 0);
    let r = random() * total;
    for (const c of candidates) {
      r -= c.weight;
      if (r <= 0) return c.key;
    }
    return candidates[candidates.length - 1].key;
  }

  async function maybeShareBiliVideo(key, info, verdict) {
    const share = cfg.socialV2?.bili?.share ?? {};
    if (share.enabled === false) return { ok: false, reason: '分享已关闭' };
    // 没有"活跃群"可推荐时就不发。用户要求「更多推荐给活跃的群聊」——
    // 推到没人说话的群里既没人看，也会让那个群显得像公告板。
    if (!key) {
      return {
        ok: false,
        reason: `最近 ${Math.max(1, Number(share.activeWindowHours) || 24)} 小时内没有群达到活跃门槛`
          + `（至少 ${Math.max(1, Number(share.minActivityForShare) || 1)} 条群友发言），这次不推荐`
      };
    }

    const interest = Number(verdict?.interest) || 0;
    // 默认门槛 65（2026-10-20 从 75 下调）。
    // 为什么：实际 56 条"喜欢"的视频里 interest 中位数只有 68、最高 82，
    // ≥75 的只有 25%。再乘 30% 概率、6 小时间隔，等于推荐功能几乎从不触发。
    // 65 覆盖约 70% 的喜欢视频，既能真的偶尔推荐，也不会推无聊的。
    const minInterest = Number(share.minInterest) || 65;
    if (interest < minInterest) {
      return { ok: false, reason: `兴趣分 ${interest} 未达 ${minInterest}` };
    }

    // 全局间隔：不管哪个群，两次推荐之间至少隔 minGapMs
    const minGap = Math.max(0, Number(share.minGapMs) || 6 * 3600 * 1000);
    if (live.lastBiliShareAt && Date.now() - live.lastBiliShareAt < minGap) {
      return { ok: false, reason: '距上次推荐太近' };
    }

    const prob = Math.min(1, Math.max(0, Number(share.probability) ?? 0.3));
    if (random() > prob) return { ok: false, reason: `未命中概率（${prob}）` };

    // URL 用 bvid 拼，而不是从接口拿（接口给的链接可能带过期参数）
    const url = `https://www.bilibili.com/video/${info.bvid}`;
    const title = String(info.title || '').trim();
    const owner = String(info.owner || '').trim();

    // 推荐语由模型写；失败就用中性兜底（绝不把机制说出来）
    let lead = '';
    if (share.askModel !== false) {
      lead = await composeBiliRecommendation(key, info, verdict);
    }
    if (!lead) {
      lead = owner ? `刷到个「${owner}」的视频，还挺对味` : '刚刷到个视频，挺对味';
    }

    // 下载、观看和生成推荐语可能耗时数分钟；最终发送前必须重新过准入，
    // 不能沿用选群时的旧模式/白名单/暂停状态。
    if (live.currentMode !== 'reserved2') return { ok: false, reason: '当前不是二代仿真模式，取消推荐' };
    if (cfg.socialV2?.enabled === false) return { ok: false, reason: '二代模式已关闭，取消推荐' };
    if (socialV2.paused) return { ok: false, reason: '二代 AI 已暂停，取消推荐' };
    if (!isSessionAllowedInCurrentMode(key)) return { ok: false, reason: '目标群已不在当前模式允许范围内，取消推荐' };
    if (shouldBlockSilentReply(key)) return { ok: false, reason: '静默模式已开启，取消推荐' };

    // 分两条发：先说一句，再单独发「标题 + 链接」
    // —— 合成一条在群里容易折行错乱，而且链接单独一行更好点。
    const text = `${lead}\n\n《${title}》\n${url}`;
    await sendToQQ(key, text);
    live.lastBiliShareAt = Date.now();
    log(`[B站] 已推荐给 ${key}：《${title.slice(0, 26)}》兴趣 ${interest} → ${url}`);
    return { ok: true, url, title };
  }

  /** 让模型写一句自然的推荐语（不暴露机制、不自称在刷视频）。 */
  async function composeBiliRecommendation(key, info, verdict) {
    try {
      const prompt = `【写一句推荐语】
你刚看了一个 B 站视频，觉得不错，想在群里顺手提一句（像人分享刚看到的好东西）。

标题：${info.title}
UP主：${info.owner || '未知'}｜分区：${info.category || '未知'}
你的感受：${verdict?.notes || '挺有意思'}
你的标签：${(verdict?.tags || []).join('、') || '无'}

要求：
- 只写**一句**自然的话（15~40 字），像随口分享，不要用"推荐""安利"这类正式词。
- 不要说"我在刷 B 站""根据我的分析"这类暴露机制的话，也不要提任何数字/分值。
- 不要写标题、不要写链接（系统会自动附在下面）。
- 直接输出这句话，不要加引号、不要解释。`;
      const text = await askModelOnce(key, prompt, 60000);
      const line = String(text || '').trim().split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
      // 防御：模型有时会把标题/链接也写进来，或超长
      if (!line || line.length > 80) return '';
      if (/https?:\/\//.test(line)) return '';
      return line.replace(/^["「『]|["」』]$/g, '').trim();
    } catch {
      return '';
    }
  }


  return { groupActivityScore, pickBiliSessionKey, maybeShareBiliVideo, composeBiliRecommendation };
}
