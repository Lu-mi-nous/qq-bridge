// R4.7-3：配置与凭据保存命令。
//
// 凭据保存（config 点路径 / state JSON）与 socialV2 全量归一化原先都在路由里。
// 这里保持原有 fail-fast、逐字段 clamp、tools 白名单派生与默认唤醒同步逻辑。

export function createConfigCommands({
  config = {},
  helpers = {},
  reverseSearcher,
  applyPixivAuth,
  refreshAllDefaultWakeConfigsV2
} = {}) {
  const {
    CREDENTIAL_ITEMS,
    ROOT,
    STATE_DIR,
    TOOL_FLAGS,
    DEFAULT_AUTO_AT,
    DEFAULT_ERROR_MESSAGES,
    TTS_DEFAULT_PROBABILITY,
    cfg = {},
    log,
    maskValue,
    path,
    readJsonSafe,
    atomicWriteJson
  } = config;
  const { normalizeGapNoticeConfig } = helpers;
  const logLine = (message) => { try { log?.(message); } catch { /* 日志失败不影响主流程 */ } };

  /** POST /api/socialV2/credentials */
  function saveCredential(body = {}) {
    const key = String(body.key ?? '').trim();
    const item = CREDENTIAL_ITEMS.find((it) => it.key === key);
    if (!item) return { ok: false, status: 400, error: `未知配置项：${key}` };
    if (typeof body.value !== 'string') return { ok: false, status: 400, error: 'value 必须是字符串' };
    // 换行/首尾空白几乎都是复制时带进来的，直接裁掉（这些值里不会含换行）
    const value = String(body.value).replace(/[\r\n]+/g, '').trim();

    // 基本形态校验：宁可在保存时拒绝，也不要存进去后再去排查"为什么连不上"
    if (item.kind === 'secret' && value && value.length < 6) {
      return { ok: false, status: 400, error: '这个值太短了，确认没复制错吗？' };
    }
    if (item.key === 'imagesProxy' || item.key === 'githubShotProxy' ||
        item.key === 'webSearchProxy' || item.key === 'xMonitorProxy') {
      if (value && !/^https?:\/\/[^\s]+$/i.test(value)) {
        return { ok: false, status: 400, error: '代理地址应形如 http://127.0.0.1:7897' };
      }
    }
    if (item.key === 'consoleToken' && value && value.length < 16) {
      return { ok: false, status: 400, error: '控制台令牌至少 16 位' };
    }

    try {
      if (item.where === 'config') {
        const configFile = path.join(ROOT, 'config.json');
        // fail-fast：配置损坏时绝不回写，否则可能把整个 config 清空
        const file = readJsonSafe(configFile, null, true);
        const segs = item.path.split('.');
        let cur = file;
        for (let i = 0; i < segs.length - 1; i++) {
          if (!cur[segs[i]] || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
          cur = cur[segs[i]];
        }
        cur[segs[segs.length - 1]] = value;
        atomicWriteJson(configFile, file);
        // 同步内存：改完立即生效的那些项（restart=false）立刻能用
        let mem = cfg;
        for (let i = 0; i < segs.length - 1; i++) {
          mem[segs[i]] = mem[segs[i]] ?? {};
          mem = mem[segs[i]];
        }
        mem[segs[segs.length - 1]] = value;
        // 反查器构造时就把 apiKey 抓进闭包了，改了要重建才生效
        if (item.key === 'reverseSearchApiKey') {
          try { reverseSearcher?.setApiKey?.(value); } catch { /* 旧实现没有该方法时忽略 */ }
        }
      } else {
        const file = path.join(STATE_DIR, item.file);
        const obj = readJsonSafe(file, null) ?? {};
        if (value) obj[item.path] = value;
        else delete obj[item.path];
        atomicWriteJson(file, obj);
        // 凭据模块在内存里缓存了 cookie（bili.js / pixiv-auth.js 都是），
        // 存完就地重读一次，用户不必为了试一个值反复重启桥接。
        if (item.file === 'pixiv-auth.json') {
          try { applyPixivAuth?.('控制台保存'); } catch { /* 重读失败不该让保存算失败 */ }
        }
      }

      logLine(`[配置] 已更新 ${item.key}${value ? `（${value.length} 字符）` : '（清空）'}${item.restart ? '，需重启生效' : ''}`);
      return {
        ok: true,
        key: item.key,
        configured: !!value,
        preview: value ? maskValue(value) : '',
        restart: item.restart === true,
        // 明确告诉前端"现在生效了没有"，避免用户以为白填了
        applied: item.restart !== true
      };
    } catch (error) {
      logLine(`[配置] 写入 ${item.key} 失败：${error?.message ?? error}`);
      return { ok: false, status: 500, error: `保存失败：${error?.message ?? error}` };
    }
  }

  /** POST /api/socialV2/config */
  function saveSocialConfig(body = {}) {
    const configFile = path.join(ROOT, 'config.json');
    const file = readJsonSafe(configFile, null, true);
    const current = file.socialV2 ?? {};
    const merged = { ...current, ...body };
    // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
    for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context', 'gapNotice', 'tokenFuse', 'sharedMemory']) {
      if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
        merged[sub] = current[sub] ?? {};
      }
    }
    if (body.gapNotice && typeof body.gapNotice === 'object' && !Array.isArray(body.gapNotice)) {
      merged.gapNotice = normalizeGapNoticeConfig({ ...(current.gapNotice || {}), ...body.gapNotice });
    }
    if (merged.autoReplyCheckMs !== undefined) {
      const n = Number(merged.autoReplyCheckMs);
      merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
    }
    // tools：只接受布尔开关
    // 从唯一来源派生（src/tool-flags.js），避免手写清单与真实工具漂移。
    // fixed 项（无条件注册的只读工具）不接受开关，前端也不会提交。
    const toolFlags = TOOL_FLAGS.filter((x) => x.fixed !== true).map((x) => x.flag);
    if (body.tools && typeof body.tools === 'object') {
      merged.tools = { ...(current.tools ?? {}), ...body.tools };
      for (const k of toolFlags) {
        if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
      }
    }
    // wake：数值与字符串数组归一化
    if (body.wake && typeof body.wake === 'object') {
      merged.wake = { ...(current.wake ?? {}), ...body.wake };
      for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs', 'preSleepReplyGraceMs']) {
        if (merged.wake[k] !== undefined) {
          const n = Number(merged.wake[k]);
          merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
          // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
          if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
        }
      }
      if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
      if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
      if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
      if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
      if (merged.wake.recommendedKeywords !== undefined) {
        merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
      }
      if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
      if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
    }
    // send：数值归一化
    if (body.send && typeof body.send === 'object') {
      merged.send = { ...(current.send ?? {}), ...body.send };
      for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
        if (merged.send[k] !== undefined) {
          const n = Number(merged.send[k]);
          merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
          // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
          if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
        }
      }
      if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
      if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
      if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
      // autoAt：概率 0~1，时间/次数非负取整。子对象是浅合并进来的，
      // 不归一化的话控制台传字符串（"0.5"）或负数会直接进判定逻辑。
      if (body.send.autoAt && typeof body.send.autoAt === 'object' && !Array.isArray(body.send.autoAt)) {
        const cur = current.send?.autoAt ?? {};
        const next = { ...cur, ...body.send.autoAt };
        next.enabled = next.enabled === true;
        const prob = Number(next.probability);
        next.probability = Number.isFinite(prob) ? Math.min(1, Math.max(0, prob)) : (cur.probability ?? DEFAULT_AUTO_AT.probability);
        for (const k of ['windowMs', 'cooldownMs', 'maxPerHour']) {
          const n = Number(next[k]);
          next[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : (cur[k] ?? DEFAULT_AUTO_AT[k]);
        }
        merged.send.autoAt = next;
      }
    }
    // wait：数值归一化
    if (body.wait && typeof body.wait === 'object') {
      merged.wait = { ...(current.wait ?? {}), ...body.wait };
      for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs', 'maxQuietMs', 'turnMaxCount', 'turnMaxMs']) {
        if (merged.wait[k] !== undefined) {
          const n = Number(merged.wait[k]);
          merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
        }
      }
      if (merged.wait.maxQuietMs !== undefined) merged.wait.maxQuietMs = Math.min(15000, Math.max(0, merged.wait.maxQuietMs));
      if (merged.wait.turnMaxCount !== undefined) merged.wait.turnMaxCount = Math.min(20, Math.max(1, merged.wait.turnMaxCount));
      if (merged.wait.turnMaxMs !== undefined) merged.wait.turnMaxMs = Math.min(600000, Math.max(5000, merged.wait.turnMaxMs));
    }
    // tts：语音合成参数（2026-10-22 用户要求「触发概率、每小时上限、模型设置、
    // 字数等设成可变参数并提供修改按钮」）。
    //
    // 这里逐项 clamp，不做"信任前端"那套：
    //   - probability 必须在 0~1（有人会填 5 表示 5%，得救回来）；
    //   - maxPerHour / maxChars 有上下界（0 条 = 禁用；字数太大语速劝退）；
    //   - enabled 只接受布尔，避免 "false" 字符串被当成真值。
    if (body.tts && typeof body.tts === 'object' && !Array.isArray(body.tts)) {
      merged.tts = { ...(current.tts ?? {}), ...body.tts };
      const t = merged.tts;
      const prev = current.tts ?? {};
      if (t.enabled !== undefined) t.enabled = t.enabled === true;
      // 概率：接受 0~1 的小数；也容忍 0~100 的百分数写法（>1 时按百分数折算）
      if (t.probability !== undefined) {
        let p = Number(t.probability);
        if (!Number.isFinite(p)) p = Number(prev.probability ?? TTS_DEFAULT_PROBABILITY);
        if (p > 1) p = p / 100;
        t.probability = Math.min(1, Math.max(0, Math.round(p * 1000) / 1000));
      }
      if (t.maxPerHour !== undefined) {
        const n = Number(t.maxPerHour);
        t.maxPerHour = Number.isFinite(n) ? Math.min(60, Math.max(0, Math.round(n))) : (Number(prev.maxPerHour) || 3);
      }
      if (t.maxChars !== undefined) {
        const n = Number(t.maxChars);
        t.maxChars = Number.isFinite(n) ? Math.min(300, Math.max(10, Math.round(n))) : (Number(prev.maxChars) || 140);
      }
      // 模型设置：路径与音色名只做字符串化 + 去空白；不校验存在性——
      // 路径可能暂时不可达（外接盘没插），不该因此拒绝保存其它参数。
      // voiceId/weightsId/refMode 是音色预设选择（voices.json），
      // 与手写路径二选一；有 voiceId 时以预设为准。
      for (const k of ['dir', 'gptModel', 'sovitsModel', 'refAudio', 'refText', 'refLang', 'voiceName', 'device', 'voiceId', 'weightsId', 'refMode']) {
        if (t[k] !== undefined) t[k] = String(t[k] ?? '').trim();
      }
      if (t.isHalf !== undefined) t.isHalf = t.isHalf !== false;
      if (t.cpuThreads !== undefined) {
        const n = Number(t.cpuThreads);
        t.cpuThreads = Number.isFinite(n) ? Math.min(32, Math.max(1, Math.round(n))) : (Number(prev.cpuThreads) || 8);
      }
      // 韵律/响度参数（2026-10-22 方案 B）：都是请求级参数，改完即时生效。
      // 必须用小数 clamp（ttsNum 会取整，speed 0.95 会被弄成 1）。
      const clampDec = (k, min, max, dflt) => {
        if (t[k] === undefined) return;
        const n = Number(t[k]);
        t[k] = Number.isFinite(n)
          ? Math.min(max, Math.max(min, Math.round(n * 1000) / 1000))
          : dflt;
      };
      clampDec('speed', 0.8, 1.2, 1.0);
      clampDec('fragmentInterval', 0.1, 0.6, 0.3);
      clampDec('temperature', 0.5, 1.2, 0.9);
      clampDec('topK', 5, 30, 15);
      clampDec('topP', 0.7, 1.0, 0.95);
      clampDec('volumeGainDb', -12, 12, 0);
      if (t.textSplitMethod !== undefined) {
        const s = String(t.textSplitMethod ?? '').trim();
        t.textSplitMethod = ['cut1', 'cut5'].includes(s) ? s : 'cut5';
      }
      if (t.punctuate !== undefined) t.punctuate = t.punctuate !== false && t.punctuate !== 'false';
    }
    // proactive：主动机会参数
    if (body.proactive && typeof body.proactive === 'object') {
      merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
      for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
        if (merged.proactive[k] !== undefined) {
          const n = Number(merged.proactive[k]);
          merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
          // 毫秒类字段统一非负取整；概率字段单独 clamp。
          if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
        }
      }
      if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
      if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
    }
    // sticker：表情包体系参数归一化
    if (body.sticker && typeof body.sticker === 'object') {
      merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
      if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
      for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
        if (merged.sticker[k] !== undefined) {
          const n = Number(merged.sticker[k]);
          merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
        }
      }
      if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
      if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
      if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
      if (merged.sticker.readLocalCache !== undefined) merged.sticker.readLocalCache = merged.sticker.readLocalCache === true;
      // 主动要求发表情（2026-10-22）：参数来自控制台，这里逐项 clamp。
      // 概率同 TTS 的约定——接受 0~1，也容忍 0~100 的百分数写法。
      if (merged.sticker.autoNudge !== undefined) merged.sticker.autoNudge = merged.sticker.autoNudge === true;
      if (merged.sticker.autoNudgeProbability !== undefined) {
        let p = Number(merged.sticker.autoNudgeProbability);
        if (!Number.isFinite(p)) p = Number(current.sticker?.autoNudgeProbability ?? 0.33);
        if (p > 1) p = p / 100;
        merged.sticker.autoNudgeProbability = Math.min(1, Math.max(0, Math.round(p * 1000) / 1000));
      }
      if (merged.sticker.autoNudgeMinGapMs !== undefined) {
        const n = Number(merged.sticker.autoNudgeMinGapMs);
        merged.sticker.autoNudgeMinGapMs = Number.isFinite(n) ? Math.max(0, Math.round(n)) : (Number(current.sticker?.autoNudgeMinGapMs) || 180000);
      }
      if (merged.sticker.autoNudgeMaxPerHour !== undefined) {
        const n = Number(merged.sticker.autoNudgeMaxPerHour);
        merged.sticker.autoNudgeMaxPerHour = Number.isFinite(n) ? Math.min(60, Math.max(0, Math.round(n))) : (Number(current.sticker?.autoNudgeMaxPerHour) ?? 6);
      }
      if (merged.sticker.autoNudgeCandidates !== undefined) {
        const n = Number(merged.sticker.autoNudgeCandidates);
        merged.sticker.autoNudgeCandidates = Number.isFinite(n) ? Math.min(4, Math.max(1, Math.round(n))) : (Number(current.sticker?.autoNudgeCandidates) || 3);
      }
      if (body.sticker.collect && typeof body.sticker.collect === 'object') {
        merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
        if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
        for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
          if (merged.sticker.collect[k] !== undefined) {
            const n = Number(merged.sticker.collect[k]);
            merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
          }
        }
      }
    }
    // comply：群友点单的照做判定参数归一化
    if (body.comply && typeof body.comply === 'object') {
      merged.comply = { ...(current.comply ?? {}), ...body.comply };
      if (merged.comply.enabled !== undefined) merged.comply.enabled = merged.comply.enabled === true;
      for (const k of ['ttlMs', 'cooldownMs', 'maxPerHour']) {
        if (merged.comply[k] !== undefined) {
          const n = Number(merged.comply[k]);
          merged.comply[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.comply?.[k] ?? 0;
        }
      }
      if (merged.comply.probability !== undefined) {
        merged.comply.probability = Math.min(1, Math.max(0, Number(merged.comply.probability) || 0));
      }
    } else if (body.comply === undefined && merged.comply === undefined) {
      // 旧配置没有该块时补默认，保证 qq_get_prompt/判定能读到。
      merged.comply = current.comply ?? {};
    }
    // gifFrames：动图抽帧拼图参数归一化
    if (body.gifFrames && typeof body.gifFrames === 'object') {
      merged.gifFrames = { ...(current.gifFrames ?? {}), ...body.gifFrames };
      if (merged.gifFrames.enabled !== undefined) merged.gifFrames.enabled = merged.gifFrames.enabled === true;
      for (const k of ['timeoutMs']) {
        if (merged.gifFrames[k] !== undefined) {
          const n = Number(merged.gifFrames[k]);
          merged.gifFrames[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.gifFrames?.[k] ?? 0;
        }
      }
      if (merged.gifFrames.maxFrames !== undefined) {
        const n = Number(merged.gifFrames.maxFrames);
        merged.gifFrames.maxFrames = Number.isFinite(n) ? Math.min(20, Math.max(2, Math.round(n))) : (current.gifFrames?.maxFrames ?? 20);
      }
      if (merged.gifFrames.tileWidth !== undefined) {
        const n = Number(merged.gifFrames.tileWidth);
        merged.gifFrames.tileWidth = Number.isFinite(n) ? Math.min(640, Math.max(80, Math.round(n))) : (current.gifFrames?.tileWidth ?? 320);
      }
    }
    // media：单条消息图片总量上限等
    if (body.media && typeof body.media === 'object') {
      merged.media = { ...(current.media ?? {}), ...body.media };
      if (merged.media.maxMessageBytes !== undefined) {
        const n = Number(merged.media.maxMessageBytes);
        // 下限 1MB：再小会让常见表情包都发不出去；上限 64MB：避免把内存打爆。
        merged.media.maxMessageBytes = Number.isFinite(n)
          ? Math.min(64 * 1024 * 1024, Math.max(1024 * 1024, Math.round(n)))
          : (current.media?.maxMessageBytes ?? 8 * 1024 * 1024);
      }
    }
    // errorNotice：上游报错拦截（节流窗口 / 文案 / 是否私聊管理员 / 是否在群里发提示）
    if (body.errorNotice && typeof body.errorNotice === 'object') {
      merged.errorNotice = { ...(current.errorNotice ?? {}), ...body.errorNotice };
      if (merged.errorNotice.windowMs !== undefined) {
        const n = Number(merged.errorNotice.windowMs);
        // 下限 0（每次必发，调试用）；上限 1 小时：再长会让限流提示形同关闭。
        merged.errorNotice.windowMs = Number.isFinite(n)
          ? Math.min(60 * 60 * 1000, Math.max(0, Math.round(n)))
          : (current.errorNotice?.windowMs ?? 3 * 60 * 1000);
      }
      if (Array.isArray(merged.errorNotice.messages)) {
        const msgs = merged.errorNotice.messages.map((m) => String(m ?? '').trim()).filter(Boolean);
        // 空数组会让「随机取一条」无从取值，回退到默认文案
        merged.errorNotice.messages = msgs.length ? msgs : DEFAULT_ERROR_MESSAGES;
      }
      // inGroup 默认 false（报错不进群）。只有显式传 true 才打开群内提示。
      if (merged.errorNotice.inGroup !== undefined) {
        merged.errorNotice.inGroup = merged.errorNotice.inGroup === true;
      }
    }
    // images：图库参数归一化（sources 逐层合并，避免外层 spread 覆盖丢默认）
    if (body.images && typeof body.images === 'object') {
      merged.images = { ...(current.images ?? {}), ...body.images };
      if (merged.images.enabled !== undefined) merged.images.enabled = merged.images.enabled === true;
      if (merged.images.annotateSource !== undefined) merged.images.annotateSource = merged.images.annotateSource === true;
      for (const k of ['maxFiles', 'maxTotalBytes', 'maxBytesPerFile', 'fetchPerRun', 'cooldownMs', 'sendCooldownMs', 'maxSendPerHour']) {
        if (merged.images[k] !== undefined) {
          const n = Number(merged.images[k]);
          merged.images[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.images?.[k] ?? 0;
        }
      }
      if (merged.images.libDir !== undefined) merged.images.libDir = String(merged.images.libDir ?? '');
      if (body.images.sources && typeof body.images.sources === 'object') {
        const cur = current.images?.sources ?? {};
        merged.images.sources = { ...cur };
        for (const [name, sc] of Object.entries(body.images.sources)) {
          if (!sc || typeof sc !== 'object') continue;
          merged.images.sources[name] = { ...(cur[name] ?? {}), ...sc };
          const one = merged.images.sources[name];
          if (one.enabled !== undefined) one.enabled = one.enabled === true;
          if (one.limit !== undefined) {
            const n = Number(one.limit);
            one.limit = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 20;
          }
          if (one.tags !== undefined) {
            one.tags = (Array.isArray(one.tags) ? one.tags : String(one.tags).split(/[,，\s]+/)).map(String).filter(Boolean);
          }
        }
      }
    }
    // feedback：数值/布尔归一化
    if (body.feedback && typeof body.feedback === 'object') {
      merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
      if (merged.feedback.maxLength !== undefined) {
        const n = Number(merged.feedback.maxLength);
        merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
      }
      if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
    }
    // context：数值归一化
    if (body.context && typeof body.context === 'object') {
      merged.context = { ...(current.context ?? {}), ...body.context };
      for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
        if (merged.context[k] !== undefined) {
          const n = Number(merged.context[k]);
          merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
        }
      }
    }
    if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
    if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
    if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
    file.socialV2 = merged;
    atomicWriteJson(configFile, file);
    cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
    // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
    // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
    const WAKE_DEFAULT_KEYS = [
      'defaultMode', 'recommendedDefaultInfinite',
      'recommendedSleepMinMs', 'recommendedSleepMaxMs',
      'recommendedProbability', 'recommendedKeywords',
      'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
      'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
    ];
    const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
      WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
    if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2?.();
    logLine('控制台：二代仿真配置已更新');
    return { ok: true, config: cfg.socialV2 };
  }

  return { saveCredential, saveSocialConfig };
}
