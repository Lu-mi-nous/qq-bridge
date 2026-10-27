// 唤醒提示构建（第 4A 步：从 bridge.js 抽出的编排层）。
//
// 这里不做状态读写：角色卡、会话状态、记忆包、表情候选、点单判定、检索结果
// 全部由 bridge 注入。目标是把“唤醒提示长什么样”集中在一个文件里，
// 后续调 prompt 不用再翻 bridge 主流程。
import { identityTagOf } from './message-format.js';

export function createWakePromptBuilder(deps) {
  const {
    roleFor,
    currentRoleHintV2,
    getSocialV2State,
    cfg,
    getTtsEngine,
    formatMemoryV2,
    contextCfg,
    stateDir,
    loadEpisodes,
    loadCompactions,
    loadLongTermMemory,
    formatMemoryPack,
    contextMetrics,
    log,
    buildRecallLine,
    formatParticipationV2,
    planStickerV2,
    getStickerEntries,
    stickerCacheOpts,
    buildStickerNudge,
    buildStickerStrategyHint,
    buildStickerContext,
    buildComplyLine,
    buildTokenAskLine,
    looksLikeUnfinished,
    findCallers
  } = deps;

  function buildWakePrompt(key, reason) {
    const roleName = deps.roleFor(key);
    // 角色卡**正文**要直接进唤醒提示，不能只给一行「请调用 qq_get_prompt 查看」。
    //
    // 曾经的写法只注入角色名，指望模型自己去调 qq_get_prompt 取全文。实测这个指望不成立：
    // 8/31~10/20 共 30 天里 qq_get_prompt 只被调用过 26 次，而群聊唤醒有 7605 次——
    // 也就是说 **99.7% 的回合里模型根本没看过角色卡**，人格只剩「大肥鱼」三个字。
    // 后果是角色卡里最吃细节的指令全线失效，最明显的是表情包：
    //   角色卡「表情是你的主武器，能发就发…多数轮次都该带表情」
    //   vs 通用策略「普通闲聊不用每条都配；大约每 3~5 轮来一张就够」
    // 没有角色卡的强命令时，模型只按通用策略行事，于是几乎不发（10/16 起连续 5 天 send_sticker=0）。
    //
    // 体积可控：角色卡 6~7 KB，唤醒提示原本约 4 KB，加起来仍在模型上下文内；
    // 且 deps.currentRoleHintV2() 已含「一代指令行过滤 + 示例节空格转换」，可直接复用。
    const roleCard = roleName ? deps.currentRoleHintV2(key) : '';
    const roleLine = roleName
      ? `【当前角色】${roleName}\n\n${roleCard ? roleCard.trim() + '\n\n' : ''}`
      : '';
    const st = deps.getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    // 功能介绍与角色无关：换人格后仍可用菜单图，文案由同一份能力清单维护。
    const menuLine = deps.cfg.socialV2?.tools?.getFeatureMenu !== false
      ? '【功能介绍】群友询问“你会什么 / 你会啥 / 能干嘛 / 有什么功能 / 功能声明 / 功能菜单 / 功能介绍”时，可用 qq_send_feature_menu(key, token) 直接发送本地缓存的功能图。该图按当前角色和已启用功能生成；发送成功后无需逐条复述或追加未列出的能力，失败时如实说明图片暂时发不了。\n\n'
      : '';
    // Token 用量图：与功能菜单同一条路（桥接渲染并直接发送）。
    // 写进唤醒提示的理由：群友问"用了多少 token"时，模型若不知道有这个工具，
    // 会自己去翻日志或凭印象编数字——那是最糟的结果。
    //
    // ⚠️ 触发词必须写全。实测（2026-10-21 group:1000000001）：
    //   问「你用了多少token」→ 调用了工具（6 次成功）；
    //   问「看看你吃了多少token」「你怎么这么能吃白饭」→ **没调用**，
    //   反而编出「35.27B里prompt占35.25B」这种数，下一条又改口
    //   「我这边没有查自己用量的口子」——自相矛盾且全是假的。
    //   根因是旧文案只列了"用了多少/消耗多少/烧了多少"，没有把"吃了/白饭/token 花销"
    //   这些群友口语说法挂钩到工具上。模型对没列出的说法就没有触发联想。
    //
    // 另外两件事一起写明：
    //   ① **绝不允许自己估算或凭印象报数**——错的数字比"我查一下"糟糕得多；
    //   ② 报错时要说"统计图暂时发不了"，不能顺势说"我没有这个能力"（那是谎话）。
    const tokenReportLine = deps.cfg.socialV2?.tools?.tokenReport !== false
      ? '【Token 用量】群友只要在问「机器人自己消耗了多少 token」，**一律调 qq_token_report(key, token)** 生成统计图并发到当前会话。触发说法很多，别只认固定词：'
        + '「用了/耗了/花了/吃了多少 token」「token 用多少了」「今天消耗多少」「这个月烧了多少」「花了多少算力」「吃了多少白饭」「你这么能吃？」「看看你的用量/统计/账单」「今天跑了多少」等，'
        + '只要语义是在问**用量/消耗/花了多少**，都用这个工具。\n'
        + '**绝对不要自己估算、翻日志或凭印象报数字**——你算不准，编出来的数会被图上真实数字当场打脸。'
        + '**也不要说「我没有查用量的口子/这个统计不归我管」**：你有这个工具，说没有是错的。\n'
        + '返回里带与图同源的文字摘要，追问具体数字时照它回答；只有工具真的返回失败时，才如实说「统计图暂时生成不了」并带上原因。\n\n'
      : '';
    // 语音能力：只有 TTS 真可用时才告诉模型"你能发语音"。
    //
    // 这条是必须的，血泪教训（2026-10-22）：之前只做了"桥接按概率把回复换成语音"，
    // 却没写进提示词，群友说「发个语音」时模型答「语音我发不出来呀」——
    // 它说的是实话，因为提示词里从没提过这个能力。
    // **能力不写进提示词，就等于没有**。
    //
    // 注意这里**不能调 v2ToolEnabled()**：那个函数定义在 HTTP 服务器回调内部
    // （bridge.js 约 2766 行），本函数在另一处作用域，直接调会抛
    // `v2ToolEnabled is not defined` 并让**整个唤醒中断**——
    // 实测后果就是"发私聊完全不理人"。同语义直接读 deps.cfg 即可。
    const voiceLine = (deps.getTtsEngine() && deps.getTtsEngine().available() && deps.cfg.socialV2?.tools?.sendVoice !== false)
      ? '【语音】你能发语音（qq_send_voice）。群友明确要听声音时（「发个语音」「说句听听」「用语音回我」）就调它，'
        + '念一句自己组织的口语（≤140 字）。日常聊天不要主动发——语音比文字吵。'
        + '发完不要再复述同一句话。发不出来（比如正在加载）就如实说，改发文字。\n\n'
      : '';
    // 短期/人工记忆（activeTopics / pendingThoughts / memberImpressions）
    const memoryBase = deps.formatMemoryV2(st);
    // Phase 1/2：长期情节记忆（episodes）+ 长期人物/事实/线索 + DSH 压缩摘要兜底。
    // 两段分开拼，避免 deps.formatMemoryV2 的【】小节被覆盖。
    let memoryPack = '';
    let sharedText = '';
    let gapText = '';
    try {
      const cm = deps.contextCfg();
      const episodes = deps.loadEpisodes(deps.stateDir, key, 3);
      const compactions = deps.loadCompactions(deps.stateDir, key, 1);
      const longTerm = deps.loadLongTermMemory(deps.stateDir, key);
      memoryPack = deps.formatMemoryPack({
        episodes,
        compactions,
        longTerm,
        budgetChars: cm.memoryPackChars
      });
      // P2 跨会话人物记忆：只注入「此刻在这个会话里出现过」的人的稳定偏好。
      // 关闭时 formatter 返回空串，拼装结果与旧版完全一致。
      if (typeof deps.formatSharedMemoryForWake === 'function') {
        try { sharedText = String(deps.formatSharedMemoryForWake(key, st, longTerm) || '').trim(); } catch { sharedText = ''; }
      }
      // G1 记忆断层：只在真实间隔超过阈值时补一段运行状态背景；关闭时为空串。
      if (typeof deps.buildGapNotice === 'function') {
        try { gapText = String(deps.buildGapNotice(key, st) || '').trim(); } catch { gapText = ''; }
      }
      const m = deps.contextMetrics.get(key) || {};
      m.lastMemoryChars = memoryPack.length;
      m.lastSharedChars = sharedText.length;
      m.lastGapChars = gapText.length;
      deps.contextMetrics.set(key, m);
    } catch (error) {
      deps.log(`[上下文] 读取记忆包失败：${error?.message ?? error}`);
    }
    // Phase 3 P0：固定记忆包 + 按当前未读/待回复消息检索到的相关记忆。
    // 检索结果只作背景，不会替代固定包；失败时静默退回旧行为。
    const recallText = deps.buildRecallLine(key, st).trim();
    const memoryText = [memoryBase, memoryPack, sharedText, gapText, recallText].filter(Boolean).join('\n');
    const memoryLine = memoryText ? `${memoryText}\n\n` : '';
    // 注意：黑话表不在这里注入，deliverPromptNow 的 withSlangContext 会统一注入，
    // 避免唤醒 prompt 出现两份黑话表。
    const participationText = deps.formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\n\n` : '';
    const antiAiLine = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。\n\n';
    // 元信息防泄漏：这条提示里的所有【】小节（状态/唤醒/令牌/策略/记忆/参与度）都是
    // 给你看的内部调度信息，不是可以拿去说的内容。早期没写这句，模型会把「你别重复回答」
    // 「这条已经交代过了」这类内部指令当台词发到群里（实测群友收到的原话：
    // 「芙老师那句 666 我收到了，这回不接第二遍」「那条我上一条已经交代过了，不再补一遍」），
    // 看起来非常出戏。后台提醒通道早有同类约束，唤醒通道漏了，这里补上。
    const metaLine = '【内部信息不外泄】下面所有【】里的内容（状态、唤醒原因、令牌、策略、记忆、参与度等）都是你内部参考，不是台词。绝对不要复述、转述或提及它们，也不要说“我收到指令”“系统提醒我”“这条我答过了”“我不再重复”这类关于自己调度的话——像真人一样只聊群里的事。\n\n';
    const stickerCfg = deps.cfg.socialV2?.sticker ?? {};
    // 表情包：**桥接掷骰决定"这一轮要不要发"**，模型只从给定候选里挑一张。
    //
    // 背景（2026-10-22 用户反馈「依旧极少调用表情包」）：实测 1999 次工具调用里
    // `qq_send_sticker` 只出现 1 次。原来只有软策略提示（"大约每 3~5 轮来一张"），
    // 模型可以永远不选；而且发表情要额外一次工具调用、还不能和文字同气泡，
    // 收益"可有可无"自然被跳过。
    // 改成"桥接要求 + 只给 2~3 个候选"后，模型的选择成本降到最低，
    // 而频率由桥接控制（不会忽多忽少）。
    const stickerPlan = deps.planStickerV2(key, st);
    if (stickerPlan) {
      // 记一行：出问题时能立刻区分"没掷中"和"掷中了但模型没发"
      deps.log(`[表情] ${key} 本轮要求发一张（语气=${stickerPlan.moodLabel}，候选 ${stickerPlan.picks.length} 个）`);
    }
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? (stickerPlan
        ? `${deps.buildStickerNudge(stickerPlan)}\n\n`
        : `${deps.buildStickerStrategyHint()}\n${deps.buildStickerContext(deps.getStickerEntries(), stickerCfg.promptMaxStickers ?? 8, deps.stickerCacheOpts())}\n\n`)
      : '';
    const preSleepMs = Math.max(0, Number(deps.cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    const proactiveLine = '【积极性】不要习惯性潜水：群里有你能接的话题就主动参与，偶尔插一句别人的话题也很正常；只有确实没话可说、对方已明确结束、或长时间没人说话时才潜水。\n\n';
    const preSleepLine = `【沉睡前强制等待】除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察；短等待（30秒/60秒/180秒）不能代替这次完整观察。若 ${Math.round(preSleepMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。如果返回里带 preSleepWaitRemainingMs，就按剩余时间继续等待。\n\n`;
    // 关键防循环：活跃群里“等 60 秒安静”永远等不到。模型一旦已经发过言，
    // 本回合的任务就完成了；回复检查会自动叫醒它，不需要它抱着 wait 守候。
    const wrapLine = '【回合收尾】本回合已经发过言后，不要再调用 qq_wait_for_messages 守候后续消息；直接结束回合即可，桥接会在 30~45 秒后自动唤醒你做回复检查。只有还没发过言、准备直接潜水时，才需要用一次 qq_wait_for_messages 完成观察。同一个回合最多等 2 次、累计不超过 120 秒，超时桥接会强制收尾。\n\n';

    // 点单判定：桥接掷骰的权威结果，放在最前面（优先级高于自主性规则）。
    const complyLine = deps.buildComplyLine(key, st);
    // 有人在问 token 用量：桥接直接认出来并要求调工具，不靠模型自己联想措辞。
    // 位置紧跟 complyLine——都属于"本轮该做什么"的权威指令，要在自主性规则之前。
    const tokenAskLine = deps.buildTokenAskLine(st);
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).length} 条`];
    // 「最近一条」带上 seq：这是最常被引用的目标（模型引用上一条别人的话时要用它）。
    // 不给 seq 时模型得去未读列表里自己对号，实测经常串行引用错（差几条地错），
    // 而且错了不报错、只能从群友反应看出来。
    if (lastMsg) {
      const seqTag = lastMsg.seq != null ? `（seq=${lastMsg.seq}）` : '';
      // 【管理员】标记：群里管理员和群友的 sender 都是昵称，光看名字模型认不出谁是管理员
      // （2026-10-15 用户要求「管理员发消息时机器人应该能够认出」）。
      // 这是**客观状态描述**，不是命令——措辞按既有惯例保持中性，避免被当台词复述。
      const ownerTag = identityTagOf(lastMsg);
      // 同样不能只截开头：引用类消息里"真正对你说的话"在末尾（见 findCallers 处注释）。
      const lastText = String(lastMsg.text || lastMsg.plain || '').trim();
      const lastSummary = lastText.length <= 60 ? lastText : `${lastText.slice(0, 24)}…${lastText.slice(-36)}`;
      statusBits.push(`最近一条来自 ${ownerTag}${String(lastMsg.sender || '未知')}${seqTag}：${lastSummary}`);
    }
    if (lastMsg && deps.looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    // 最近的几条群友发言 + 各自 seq，做成"可引用清单"：
    // 模型要引用比最新更早的某条时，直接从这份清单里挑一个 seq 抄过去即可，不必翻未读。
    const recentOthers = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])]
      .filter((m) => m && !m.isSelf && m.seq != null)
      .slice(-4);
    if (recentOthers.length > 1) {
      const list = recentOthers
        .map((m) => `seq=${m.seq} ${identityTagOf(m)}${String(m.sender || '某人').slice(0, 8)}：${String(m.text || m.plain || '').slice(0, 24)}`)
        .join(' ｜ ');
      statusBits.push(`最近几条（要引用哪条就用它的 seq）→ ${list}`);
    }
    // 分享卡片：文本里的链接可能被摘要截断，这里给完整链接（小红书等站点
    // 少了 xsec_token 会直接打不开）。只取未读里最新的一条，避免提示词膨胀。
    const shareMsg = [...(Array.isArray(st.unread) ? st.unread : [])]
      .reverse()
      .find((m) => m && !m.isSelf && m.shareUrl);
    if (shareMsg) {
      statusBits.push(`分享链接（${shareMsg.sharePlatform || '卡片'}，seq=${shareMsg.seq}）：${shareMsg.shareUrl}`);
    }
    // 把「你最近说过什么」明确列出来：群消息密集时，模型看不到自己的发言记录，
    // 会把未读里早前的 @ 当新问题重答（实测「这条我答过两回了」）。
    // 措辞保持中性（不给命令口吻），避免被当成台词复述出去。
    const myRecent = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])]
      .filter((m) => m && m.isSelf)
      .slice(-3);
    if (myRecent.length) {
      const mine = myRecent.map((m) => `「${String(m.text || m.plain || '').slice(0, 30)}」`).join('');
      statusBits.push(`你最近已说过：${mine}`);
    }
    // 「有人在叫你吗」必须由桥接明确判定：模型的别名（群名片 / 关键词如「大肥鱼」）
    // 它自己不一定认得出，实测出现过「@大肥鱼 speak」被它判成「没人叫我」而只观察不回应。
    // 同时区分「已答过 / 还没答」：群消息堆满未读上限时，早前的 @ 会一直躺在未读里，
    // 模型每轮都当新问题重答，出现「这条我答过两回了」这种重复输出。
    const calledBy = deps.findCallers(key, st);
    if (calledBy.length) {
      // 摘要**不能只截开头**：引用类消息的结构是
      //   "[引用 某人：[图片]]（被引用的这条消息含 1 个图片/表情。要看到它请调用 …）@大肥鱼 超分一下"
      // 真正对你说的话在**末尾**。只取前 30 字，模型看到的是"引用…请调用工具…"，
      // 完全看不到「@大肥鱼 超分一下」→ 实测它输出"没点我"就收尾了（2026-10-21 group:1000000004）。
      // 现在：短消息原样给；长消息保留开头 + 末尾（末尾更重要，因为指令通常在那儿）。
      const showText = (m) => {
        const t = String(m.text || m.plain || '').trim();
        if (t.length <= 60) return t;
        return `${t.slice(0, 24)}…${t.slice(-36)}`;
      };
      const fmt = (m) => `${identityTagOf(m)}${String(m.sender || '某人')}：${showText(m)}`;
      // 措辞刻意保持「客观状态描述」而非「命令式强调」：早期用过 🚫/加粗/「绝对不要再回」
      // 这类强措辞，结果模型把它当成台词直接说出口（实测群友收到「芙老师那句 666 我收到了，
      // 这回不接第二遍」「那条我上一条已经交代过了，不再补一遍」——全是复述提示词，非常出戏）。
      // 内部调度信息要写得像背景事实，不要像待办或宣言。
      if (calledBy.pending.length) {
        // 带上 seq：模型要引用"正在回的那条"时需要精确目标。不给 seq 时它会自己挑，
        // 实测挑错过（回复请求 seq=15118 时引用成 15117，引用了上一条别人的图，且不报错）。
        // 这里直接点名"该回哪条"，把 seq 摆到它面前。
        const withSeq = calledBy.pending.slice(-3).map((m) => `${fmt(m)}（seq=${m.seq}）`).join('；');
        statusBits.push(`有人新叫你（${withSeq}）`);
      }
      if (calledBy.answered.length) {
        statusBits.push(`另有 ${calledBy.answered.length} 条 @ 你的是你已回过的（未读列表里的旧消息，无需再处理）`);
      }
    }
    // 繁忙期间入队的消息可能已经被 30 条未读/100 条 recent 挤掉；快照必须显式摆出来。
    // 不补这一句，模型只看到一个 atMention 原因，却找不到原文，典型表现就是“@ 它不回”。
    const pendingMsg = st.pendingWakeMessage;
    if (pendingMsg && typeof pendingMsg === 'object') {
      const ptext = String(pendingMsg.text || pendingMsg.plain || '').trim();
      const pshown = ptext.length <= 800 ? ptext : `${ptext.slice(0, 360)}…${ptext.slice(-360)}`;
      if (pshown) {
        statusBits.push(`此前繁忙期间漏看的消息：${identityTagOf(pendingMsg)}${String(pendingMsg.sender || '某人')}：${pshown}${pendingMsg.seq ? `（seq=${pendingMsg.seq}）` : ''}`);
      }
    }
    // 拍你的事件：`deps.findCallers` 刻意把拍一拍排除了（拍不是"叫你"，不该逼它回应），
    // 但那是因为它被当成"喊话"。**拍你**仍然是冲你来的动作，尤其在 pokeSelf 唤醒时，
    // 必须把"谁拍的你"摆到模型眼前——否则它只看到一堆普通未读，顺手 mark_read 就划走了。
    // 实测（2026-10-20）：连续 5 次「戳了戳 你」，模型每轮都只回"这轮先到这儿"。
    const pokeSelfs = (Array.isArray(st.unread) ? st.unread : [])
      .filter((m) => m && !m.isSelf && m.poke?.targetIsSelf)
      .slice(-3);
    if (pokeSelfs.length) {
      // 必须**带上 QQ 号**，否则模型手里没有任何可用目标。
      //
      // 实测事故（2026-10-22 group:1000000005）：提示只说「有人戳了你（群友G）」，
      // 而 qq_send_poke 要的是数字号。模型没有群友G的号，就复用上下文里残留下来的
      // 另一个号（群友C 的 1000000012），一路拍了十几次，群里被问「怎么一直戳我」。
      // 现在直接把号摆出来，模型不需要记忆、也不需要猜。
      const who = pokeSelfs
        .map((m) => {
          const uid = m.userId != null && /^[1-9]\d*$/.test(String(m.userId)) ? ` QQ=${m.userId}` : '';
          return `${identityTagOf(m)}${String(m.sender || '某人')}${uid}`;
        })
        .join('、');
      statusBits.push(
        `有人戳了你（${who}）——这是冲你来的。回拍就把上面 QQ= 后面的数字原样传给 targetUserId，`
        + `或者直接传 targetUserId="latest"（桥接会解析成最近戳你的人）；不要用记忆里别的号。`
        + `不想回拍就回一句话`
      );
    }
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    // complyLine 紧随令牌行、排在 antiAiLine **之前**：点单判定要压过「拒绝有求必应」的默认倾向。
    // metaLine 放在最前（角色行之后）：防泄漏约束要早于所有内部小节出现。
    const base = roleLine + metaLine + tokenLine + menuLine + tokenReportLine + voiceLine + complyLine + tokenAskLine + antiAiLine + proactiveLine + stickerLine + preSleepLine + wrapLine + statusLine + wakeLine + memoryLine + participationLine;
    if (reason === 'bootstrap') {
      return `${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看你的角色、推荐值、可用工具和当前状态，然后用 qq_set_wake_config 设置你希望如何被唤醒。`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}
原因：你刚刚发送过消息，现在回来检查是否有人回复。
先查看未读消息：有人回了就正常接话；没人回你，不用硬补一句，也不要反复长等待——直接结束本回合即可，桥接会稍后再次检查。只有准备直接潜水、且本回合还没发过言时，才按上面的【沉睡前强制等待】完成一次观察。`;
    }
    if (reason === 'proactiveCheck') {
      return `${base}【主动机会】${key}\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。只要内容自然，就大胆开口；如果实在没话想说，再安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'pokeSelf') {
      return `${base}【唤醒】${key}\n原因：**有人拍了你**（拍一拍的目标就是你）。\n这是冲你来的动作，必须回应——哪怕只回一个拍一拍（qq_send_poke）或一句短话（「诶？」「干嘛」「在」），别装没看见。真人被戳了不会一声不吭。\n**回拍的对象就是上面【此刻状态】里那个戳你的人**：直接用他后面的 QQ= 数字，或者传 targetUserId="latest"，桥接会解析成最近戳你的人；不要凭记忆填一个号（填错就会拍到别人身上）。\n回完就收尾（qq_mark_read 或 qq_set_wake_config），不用长篇大论。`;
    }
    if (reason === 'poke') {
      return `${base}【唤醒】${key}\n原因：群里有人拍了别人（**不是拍你**）。\n看一眼就好：觉得有趣可以接个梗，但别把别人的互动抢过来，也不必每次都说话。没有想说的就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    return `${base}【唤醒】${key}\n原因：${reason}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，可以插一句有趣的/相关的，插不上再看情况潜水；不要一上来就划走。\n【引用：只在必要时用】只有你这条消息指向的人或消息并非最新一条别人的消息，或者你连续的几句话中不同消息指代的是不同的消息或人时，才用 qq_reply 或 qq_send_message 的 replyToMessageId 指向具体那条；其他情况不要引用，别让对方猜。**要引用时优先传 messageId；只记得大概位置就传 seq；不确定目标到底哪条就传 latest**（= 最近一条别人的消息）——不要凭记忆猜编号，猜错的编号照样能解析到另一条真实消息，会静默引用错，只有群友看得出来。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。`;
  }
  return { buildWakePrompt };
}

// 明确未答的点名判定；由事件收尾和控制台读/潜水护栏共用。
export function findPendingCallers(st, aliasInfo) {
  // 与自动@ 用同一份别名（含当前群的群名片），避免出现
  // "提示说群友A在叫它、自动@ 却选了别人"这种自相矛盾。
  const unreadList = Array.isArray(st?.unread) ? st.unread : [];
  const lastReplyAt = Number(st?.lastAiReplyAt) || 0;
  const callers = unreadList.filter((m) => m && !m.isSelf).filter((m) => {
    const t = String(m.text || m.plain || '');
    if (!t) return false;
    // 拍一拍不算「在叫你」：它不是言语请求，被拍的人也不该被要求必须回应。
    // 而且 appendSocialV2Poke 会把 targetIsSelf 写进 quoteTargetIsSelf，
    // 若把它当成「引用自己」就会让每条拍一拍都触发拦截 —— 实测导致机器人
    // 每次想潜水都被拒、只能反复 wait，回合卡死、群消息全排队（2026-10-01）。
    if (/^\[拍一拍\]/.test(t)) return false;
    // 入站时从 at 段直接判定的结果，最可靠（不依赖别名/群名片是否被查到）
    if (m.atSelf) return true;
    // 引用机器人自己的消息：这是明确在跟你说话
    if (m.quoteTargetIsSelf) return true;
    // @ 它的任一别名
    const lower = t.toLowerCase();
    return aliasInfo.all.some((nm) => lower.includes(`@${nm}`.toLowerCase()));
  });
  // 已答过 = 明确引用回复过的 seq（answeredSeqs）。不再按时间推断：
  // 同一批里回复了 A，不代表比 A 更早/更新的 B 也答过了。旧状态没有
  // answeredSeqs 时走一次时间兜底（仅兼容旧数据/测试），加载时会补种。
  // 实测 2026-10-23 群 1000000005：机器人引用回复 seq7150 后，owner 的
  // seq7128「查下来源」仍是未答，但旧时间判据让它被 mark_read 一并标掉。
  const hasAnsweredTracking = Array.isArray(st?.answeredSeqs);
  const answeredSet = new Set(
    (hasAnsweredTracking ? st.answeredSeqs : [])
      .map(Number)
      .filter(Number.isFinite)
  );
  const answered = [];
  const pending = [];
  for (const m of callers) {
    if (hasAnsweredTracking) {
      if (Number.isFinite(Number(m.seq)) && answeredSet.has(Number(m.seq))) answered.push(m);
      else pending.push(m);
    } else {
      const t = Number(m.time) || 0;
      if (lastReplyAt && t && t <= lastReplyAt + 5000) answered.push(m);
      else pending.push(m);
    }
  }
  return Object.assign(callers, { answered, pending });
}

export const WAKE_PRIORITY = {
  private: 100,
  atMention: 90,
  // 「拍你」仅次于 @：这是明确冲你来的动作，不回会显得在装死。
  // 与 poke（拍别人）分开是因为实测两者混用导致拍谁都唤醒它，
  // 而模型看到"拍了别人"就不回 —— 群里感受就是「戳它不回」。
  pokeSelf: 85,
  question: 80,
  speaker: 75,
  nameMention: 70,
  keyword: 60,
  anyMessage: 50,
  replyCheck: 40,
  // 「拍别人」：只是群里的热闹，看一眼就好，优先级低于普通消息。
  poke: 35,
  timeout: 30,
  proactiveCheck: 20,
  // 启动补投：优先级最低——它是「收拾重启前的积压」，若同窗口内有真实新消息触发
  // 更高优先级的原因（@/提问等），应让那个原因胜出。
  startupBackfill: 10
};

// 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
export function wakePriorityV2(reason) {
  const base = String(reason ?? '').split(':')[0];
  return WAKE_PRIORITY[base] ?? 0;
}


export function pickPendingWake(queue, unreadSeqs, priority = wakePriorityV2) {
  const all = queue.filter((r) => r && typeof r === 'object');
  if (!all.length) return null;
  const relevant = all.filter((r) => unreadSeqs.size === 0 || [...unreadSeqs].some((s) => s >= Number(r.seq)));
  const pool = relevant.length ? relevant : all;
  return pool.slice().sort((a, b) => {
    const dp = priority(b.reason) - priority(a.reason);
    return dp || Number(b.seq || 0) - Number(a.seq || 0);
  })[0];
}
