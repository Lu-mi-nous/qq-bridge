// TTS 插件（R2.5 试点）。
//
// 插件只通过 ctx 访问配置、社交状态、发送能力和日志；不 import bridge.js。
import {
  probeSovits,
  createTtsEngine,
  DEFAULT_SOVITS_DIR,
  DEFAULT_SPEECH_PARAMS,
  TTS_DEFAULT_PROBABILITY
} from '../../src/plugin-api/speech.js';
import { registerTtsTools } from './mcp-tools.js';


function num(raw, dflt, min, max) {
  const n = Number(raw);
  const v = (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) ? dflt : n;
  return Math.min(max, Math.max(min, Math.round(v * 1000) / 1000));
}

function intNum(raw, dflt, min, max) {
  const n = Number(raw);
  const v = (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) ? dflt : n;
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function create(ctx) {
  registerTtsTools(ctx);
  const moodOfText = text => {
    const pick = ctx.capabilities?.get('stickers.instance')?.pick;
    return pick?.moodOfText ? pick.moodOfText(text) : 'neutral';
  };
  let engine = null;
  let probe = null;
  let warmupTimer = null;

  // 控制台卡片（R4-5）：只声明元数据，实际状态由核心的 /api/plugins 汇总。
  ctx.console?.registerCard?.({
    id: 'tts',
    title: '语音合成（GPT-SoVITS）',
    description: '按概率把单条文字回复改发语音；未启用或合成失败时自动退回文字。',
    endpoint: '/api/plugins/tts/card'
  });
  ctx.console?.registerRoute?.('/api/plugins/tts/card', (req, res, url, helpers) => {
    helpers.sendJson({
      ok: true,
      id: 'tts',
      enabled: ctx.config.get().enabled === true,
      engineReady: engine != null,
      voiceName: probe?.voiceName || '',
      reason: probe?.reason || ''
    });
  });

  function speechParams() {
    const t = ctx.config.get();
    const split = String(t.textSplitMethod || DEFAULT_SPEECH_PARAMS.textSplitMethod).trim();
    return {
      speed: num(t.speed, DEFAULT_SPEECH_PARAMS.speed, 0.8, 1.2),
      fragmentInterval: num(t.fragmentInterval, DEFAULT_SPEECH_PARAMS.fragmentInterval, 0.1, 0.6),
      temperature: num(t.temperature, DEFAULT_SPEECH_PARAMS.temperature, 0.5, 1.2),
      topK: intNum(t.topK, DEFAULT_SPEECH_PARAMS.topK, 5, 30),
      topP: num(t.topP, DEFAULT_SPEECH_PARAMS.topP, 0.7, 1.0),
      textSplitMethod: ['cut1', 'cut5'].includes(split) ? split : DEFAULT_SPEECH_PARAMS.textSplitMethod,
      volumeGainDb: num(t.volumeGainDb, DEFAULT_SPEECH_PARAMS.volumeGainDb, -12, 12),
      punctuate: t.punctuate !== false && t.punctuate !== 'false'
    };
  }

  function plan(key, messages, opts = {}) {
    const t = ctx.config.get();
    if (t.enabled !== true) return null;
    if (!engine || !engine.available()) return null;
    if (opts.tts === false) return null;
    if (!Array.isArray(messages) || messages.length !== 1) return null;
    const msg = String(messages[0] ?? '').trim();
    if (!msg) return null;
    const maxChars = intNum(t.maxChars, 140, 20, 300);
    if (msg.length > maxChars) return null;
    if (/https?:\/\/|www\.|```|<[^>]+>/.test(msg)) return null;
    if (/^[\d\s.,%+-]+$/.test(msg)) return null;
    const now = Date.now();
    const st = ctx.social.getState(key);
    const hist = (Array.isArray(st.ttsTimes) ? st.ttsTimes : []).filter((x) => now - Number(x) < 3600000);
    const maxPerHour = intNum(t.maxPerHour, 3, 0, 60);
    if (maxPerHour > 0 && hist.length >= maxPerHour) return null;
    const prob = Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY)));
    if (Math.random() >= prob) return null;
    return { text: msg, history: hist, mood: moodOfText(msg) || '' };
  }

  async function sendAsVoice(key, text, planData) {
    if (!engine) return { ok: false, reason: 'TTS 未启用' };
    const t = ctx.config.get();
    const fixedRef = String(t.refMode || '').trim();
    try {
      const r = await engine.speak(text, {
        mood: planData?.mood,
        refId: fixedRef && fixedRef !== 'auto' ? fixedRef : '',
        params: speechParams()
      });
      if (!r.ok) {
        ctx.log(`合成失败，改发文字：${r.error}`);
        return { ok: false, reason: r.error };
      }
      await ctx.send.voiceFile(key, r.file, { text });
      const st = ctx.social.getState(key);
      st.ttsTimes = [...(planData?.history ?? []), Date.now()].slice(-200);
      st.lastTtsAt = Date.now();
      ctx.social.save();
      const refTag = r.refMood ? `，情绪=${r.refMood}/${r.refId}` : '';
      ctx.log(`已发语音（${r.cached ? '缓存' : `${r.synthSec ?? '?'}s 合成`}，${r.durSec}s，${text.length} 字${refTag}）→ ${key}`);
      ctx.activity(`${key} [TTS] 发了一条语音（${r.durSec}s）`);
      return { ok: true, durSec: r.durSec, cached: !!r.cached, file: r.file };
    } catch (error) {
      ctx.log(`发送语音失败，改发文字：${error?.message ?? error}`);
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  async function start() {
    const t = ctx.config.get();
    if (t.enabled !== true) {
      ctx.log('未启用（socialV2.tts.enabled 不是 true）；只发文字');
      engine = null;
      probe = null;
      return { enabled: false };
    }
    try {
      probe = probeSovits({
        dir: t.dir || DEFAULT_SOVITS_DIR,
        gptModel: t.gptModel,
        sovitsModel: t.sovitsModel,
        refAudio: t.refAudio,
        refText: t.refText,
        refLang: t.refLang,
        voiceName: t.voiceName,
        device: t.device,
        voiceId: t.voiceId,
        weightsId: t.weightsId,
        refMode: t.refMode
      });
      if (!probe.ok) {
        ctx.log(`已启用但不可用：${probe.reason}（将只发文字）`);
        engine = null;
        return { enabled: true, available: false, reason: probe.reason };
      }
      // 本宿主没有语音发送能力（MCP 独立进程只注册工具描述）：不建引擎、不预热。
      // 预热会拉起 GPT-SoVITS 的 Python 进程，独立进程不需要也不该做这件事。
      if (typeof ctx.send?.voiceFile !== 'function') {
        engine = null;
        ctx.log('本宿主无语音发送能力：只提供工具描述，不加载合成引擎');
        return { enabled: true, available: false, reason: '没有语音发送能力' };
      }
      engine = createTtsEngine({
        enabled: true,
        probe,
        python: t.python,
        device: t.device || 'cuda',
        isHalf: t.isHalf !== false,
        timeoutMs: t.timeoutMs,
        log: (m) => ctx.log(m)
      });
      const pct = Math.round(Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY))) * 100);
      ctx.log(`已启用：${probe.voiceName} 音色（${t.device || 'cuda'}），${pct}% 概率把单条回复改成语音，每小时最多 ${intNum(t.maxPerHour, 3, 0, 60)} 条`);
      warmupTimer = setTimeout(() => {
        void engine?.warmup?.()
          .then((ok) => { if (!ok) ctx.log('预热未完成，首次发语音时再加载'); })
          .catch(() => {});
      }, 40000);
      warmupTimer.unref?.();
      return { enabled: true, available: true };
    } catch (error) {
      ctx.log(`初始化失败（不影响文字聊天）：${error?.message ?? error}`);
      engine = null;
      return { enabled: true, available: false, reason: String(error?.message ?? error) };
    }
  }

  function stop() {
    if (warmupTimer) clearTimeout(warmupTimer);
    warmupTimer = null;
    try { engine?.shutdown?.(); } catch {}
    engine = null;
    probe = null;
  }

  return {
    get engine() { return engine; },
    get probe() { return probe; },
    available: () => !!engine?.available?.(),
    speechParams,
    plan,
    sendAsVoice,
    start,
    stop,
    status: () => engine?.status?.() ?? null
  };
}
