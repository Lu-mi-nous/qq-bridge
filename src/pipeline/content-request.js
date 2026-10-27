// 点单判定及提示构建。保留现有文案与概率/冷却语义。
export function createContentRequestPolicy(deps) {
  const { cfg, getSocialV2State, saveSocialV2State, log, getSelfNickname } = deps;
  // ── 群友点单（要求生成内容）的「照做」判定 ─────────────────────────────────
  // 背景：preset 主体性规则明确写了「别人要推荐/要答案/要帮忙时不一定马上给」，
  // 群友点单因此常被挡回。这里由桥接给出**权威的**照做/自由发挥判定，注入唤醒提示，
  // 让模型有依据地服从——概率不能交给模型自报（不可复现，且与主体性规则互相打架）。

  // 点单动词/句式：要求产出内容或执行具体任务，而不是普通闲聊。
  const COMPLY_REQUEST_RE = /(帮我|帮忙|给我|替我|请你|求你|能不能|可不可以|能否|麻烦|拜托|来一[个张段篇首份]|写一?[个张段篇首份下]|生成|画一?[个张幅]|做一?[个张份]|整个|搞个|出个|编个|编一?段|翻译|总结一下|概括|续写|改写|润色|扩写|取个名|起个名|想个|列[个一]|列一下|整理一下|排版|做成|转换成|计算一下|算一下|解释一下|讲讲|介绍一下|推荐一?[个下些]|安利|出个主意|想个办法|写代码|写个函数|写段代码)/;
  // 产出物名词：与上面的动词独立，用于扩大命中（需配合「冲着我来」才判定）。
  const COMPLY_ARTIFACT_RE = /(文案|标题|提纲|大纲|脚本|方案|计划|攻略|清单|列表|表格|代码|函数|正则|周报|日报|总结|摘要|作文|故事|小说|诗|对联|歌词|顺口溜|段子|笑话|谜语|签名|昵称|翻译|字幕|配文|旁白|剧本|台词|人设|设定|封面|海报|logo|图标|邮件|通知|公告|策划|复盘|问卷|试卷|作业|答案)/i;
  // 否定/防御语气：这是在拒绝或吐槽，不是在点单。
  // 刻意不用裸「别/不要/不用」——中文没有词边界，「个别/特别/别的/不用心」会误伤；
  // 只认多字、明确的收回说法。
  const COMPLY_NEGATIVE_RE = /(不用了|不必了|不要了|算了|懒得|凭什么|你又不|又不会|做不到|开玩笑|骗你的|别闹|别搞|别写|别问|别说|别管|别来|你想多了)/;
  // 起手就是祈使句（无 @、无名）——群里指名道姓之外最常见的点单口吻。
  const COMPLY_IMPERATIVE_RE = /^(帮我|帮忙|给我|替我|来一?[个张段篇首份下]|写|生成|画|做|整|搞|出|编|翻|列|总结|概括|续写|改写|润色|扩写|取|起|想|整理|排版|转|计算|算|解释|讲|介绍|推荐|安利)/;
  // 第一人称自述（「我想写代码」「我要做个表」）：在说自己要干嘛，不是点单。
  // 只有同时带了明确的请求标记（帮我/请你/能不能…）才翻回点单。
  const COMPLY_SELF_DESC_RE = /^[我咱](想|要|打算|准备|正在|正|在|去|得|需要|应该|该|准备)/;
  const COMPLY_EXPLICIT_RE = /(帮我|帮忙|给我|替我|请你|求你|麻烦|拜托|能不能|可不可以|能否|可以)/;

  // 这条消息是不是「冲着机器人说的」。@ 了别人、或明显在找别人，就不算。
  function isAimedAtSelfV2(plainContent, event, quoteTargetIsSelf) {
    const s = String(plainContent ?? '').trim();
    const lower = s.toLowerCase();
    const segs = Array.isArray(event?.message) ? event.message : [];
    const selfId = String(event?.self_id ?? '');
    const atSelf = segs.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) === selfId);
    const atOthers = segs.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) !== selfId);
    if (atSelf || quoteTargetIsSelf) return true;
    if (getSelfNickname() && lower.includes(String(getSelfNickname()).toLowerCase())) return true;
    if (atOthers) return false;                                  // 明确 @ 了别人
    if (/(你|您)/.test(s)) return true;                          // 直接对「你」说话
    return COMPLY_IMPERATIVE_RE.test(s);                         // 光是祈使句也认（群里常见的直接点单）
  }

  // 是否属于「点单」：既要有请求/产出物，还要是冲着机器人来的。
  function isContentRequestV2(plainContent, aimedAtSelf) {
    const s = String(plainContent ?? '').trim();
    if (!s || !aimedAtSelf) return false;
    if (s.length > 300) return false;                            // 长文更像群友自己的输出
    if (COMPLY_NEGATIVE_RE.test(s)) return false;                // 拒绝/吐槽语境
    // 第一人称自述且没有明确请求标记 → 在说自己要干嘛，不算点单。
    if (COMPLY_SELF_DESC_RE.test(s) && !COMPLY_EXPLICIT_RE.test(s)) return false;
    // 祈使句起手且带产出物/动作 → 稳定的点单信号（不必再要求产出物名词）。
    if (COMPLY_IMPERATIVE_RE.test(s)) return true;
    return COMPLY_REQUEST_RE.test(s) || COMPLY_ARTIFACT_RE.test(s);
  }

  // 掷骰：同一请求只判一次（结果存 pendingComply，后续唤醒沿用），
  // 带冷却与每小时上限，避免被刷成「有求必应」。
  function rollComplyV2(key, requestText) {
    const st = getSocialV2State(key);
    const cc = cfg.socialV2?.comply ?? {};
    if (cc.enabled === false) return null;
    const now = Date.now();
    const pending = st.pendingComply;
    if (pending && pending.text === requestText && now < (pending.expireAt || 0)) {
      return pending;                                            // 同一请求复用上次判定，别反复掷骰子
    }
    if (st.lastComplyRollAt && now - st.lastComplyRollAt < (Number(cc.cooldownMs) || 0)) {
      return null;                                               // 冷却中：本轮不判定，模型按自主性处理
    }
    const hour = 60 * 60 * 1000;
    const recent = (st.complyTimes || []).filter((t) => now - Number(t) < hour);
    const overCap = Number(cc.maxPerHour) > 0 && recent.filter(Boolean).length >= Number(cc.maxPerHour);
    const base = Math.min(1, Math.max(0, Number(cc.probability) || 0));
    const comply = !overCap && Math.random() < base;
    st.lastComplyRollAt = now;
    st.pendingComply = {
      text: requestText,
      comply,
      roll: Number(base.toFixed(3)),
      at: now,
      expireAt: now + (Number(cc.ttlMs) || 3 * 60 * 1000),
      capped: overCap
    };
    st.complyTimes = [...(st.complyTimes || []).slice(-49), comply ? now : 0];
    saveSocialV2State();
    log(`[reserved2] 点单判定 ${key}：${comply ? '照做' : '自由发挥'}（概率 ${base}${overCap ? '，已触每小时上限' : ''}）：${requestText.slice(0, 40)}`);
    return st.pendingComply;
  }

  // 取最近一条「点单」消息，用于掷骰对象。
  // 从后往前扫：遇到自己发过言就停（说明这单已经处理过了，别再翻旧账）；
  // 中间的非点单闲聊跳过（群友常在点单后插一句话，不该把点单顶掉）。
  function latestOrderV2(st) {
    const list = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const now = Date.now();
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (!m) continue;
      if (m.isSelf) return null;                                     // 已经被回应过
      if (now - (Number(m.time) || 0) > 5 * 60 * 1000) return null;  // 超过 5 分钟的点单不再作数
      if (m.orderText) return m;
    }
    return null;
  }

  // 把判定渲染成注入文本。
  /**
   * 判定「未读里有人在问机器人的 token 用量」，并给出**权威**指令。
   *
   * 为什么由桥接判定，而不是只靠工具描述里的触发词：
   * 实测（2026-10-21 group:1000000001）问「你用了多少token」会调工具（6 次成功），
   * 但换种说法——「看看你吃了多少token」「你怎么这么能吃白饭」——**就不调了**，
   * 反而编出「35.27B里prompt占35.25B」，下一条又改口「我这边没有查自己用量的口子」。
   * 模型对没见过的措辞不会自动联想，而群友的说法是开放的，列举永远追不上。
   * 所以：桥接自己认（语义范围写得宽一点），认出来就在提示里点名要求调工具。
   *
   * 判据两段式，必须**同时**满足，避免误判（"token"在别的话题里也常出现）：
   *   ① 有"用量"语义词：token / 用量 / 算力 / 消耗（或"白饭"这类群里常用的代称）
   *   ② 有"数量/询问"语义：多少 / 几 / 用了 / 耗了 / 花了 / 吃了 / 看看 / 统计 / 账单 / 烧
   * 再排除明显不是问它用量的（如"token 是什么""你吃不吃 token"这种玩笑）。
   */
  const TOKEN_ASK_SUBJECT_RE = /(token|token\s*数|用量|算力|白饭)/i;
  const TOKEN_ASK_QUANTITY_RE = /(多少|几[个亿万千]|用了|耗了|花了|吃了|吃掉|看看|查查|统计|账单|消耗|烧了|跑多少|这么能吃|能吃)/;
  const TOKEN_ASK_NOT_RE = /(是什么|啥意思|什么意思|怎么读|单词|英文|你吃不吃|好吃吗)/;
  function buildTokenAskLineV2(st) {
    if (cfg.socialV2?.tools?.tokenReport === false) return '';
    const unread = Array.isArray(st?.unread) ? st.unread : [];
    // 只看最近几条：更早的「问用量」如果已回，会留在未读里造成"每轮都催它发图"。
    const hit = [...unread].reverse().slice(0, 8).find((m) => {
      if (!m || m.isSelf) return false;
      const t = String(m.plain ?? m.text ?? '').trim();
      if (!t) return false;
      if (TOKEN_ASK_NOT_RE.test(t)) return false;
      return TOKEN_ASK_SUBJECT_RE.test(t) && TOKEN_ASK_QUANTITY_RE.test(t);
    });
    if (!hit) return '';
    return `【本轮必须调 qq_token_report】未读里有人在问你的 token 用量（「${String(hit.text || hit.plain || '').slice(0, 40)}」）。
这一轮**先调 qq_token_report(key, token)** 把统计图发出去，再配一句很短的话（「喏，图来了」这类）。
**不许自己估算数字、不许说"我没有查用量的口子"**——你有这个工具，编数字会被图当场打脸。
如果工具返回失败，如实说统计图暂时生成不了并带上原因。\n\n`;
  }

  function buildComplyLineV2(key, st) {
    if (cfg.socialV2?.comply?.enabled === false) return '';
    const order = latestOrderV2(st);
    if (!order) return '';
    const p = rollComplyV2(key, String(order.orderText));
    if (!p) return '';
    if (Date.now() >= (p.expireAt || 0)) return '';
    return p.comply
      ? `【本轮点单判定：照做】群里有人在点单（"${String(p.text).slice(0, 60)}"）。桥接已为你掷出「照做」：这一轮请**直接按要求产出内容**，别再装傻、反问或拒绝。产出要自然、贴群友语感、长度适中；如果对方要的东西你确实给不了（真实图片/文件/联网下载等），就说明给不了，并在能力范围内给一个替代方案。\n\n`
      : `【本轮点单判定：自由发挥】有人在点单（"${String(p.text).slice(0, 60)}"）。桥接掷出的是「不照做」：这轮按你自己的性子来——可以装傻、咸鱼、反问、拒绝，也可以给个离谱答案或只吐槽一句；但**别每次都这样**，同一个人反复求你就别一直晾着。\n\n`;
  }


  return { isAimedAtSelfV2, isContentRequestV2, rollComplyV2, latestOrderV2, buildTokenAskLineV2, buildComplyLineV2 };
}
