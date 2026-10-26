// B 站启动装配（R3-14）：记忆、凭据、字幕/ASR 与自主刷调度。
import path from 'node:path';
import { createVideoMemory } from './bili.js';
import { loadBiliAuth } from './bili-auth.js';
import { setBiliCookie } from './bili.js';
import { createAsrEngine } from './asr.js';

export function createBiliBootstrap({
  cfg,
  root,
  log = () => {},
  scheduleBiliBrowse = () => {},
  setBiliMem = () => {},
  setBiliAuth = () => {},
  setAsrEngine = () => {}
} = {}) {
  if (!cfg) throw new Error('createBiliBootstrap: cfg 不能为空');

  function start() {
  let engine = null;
  // ── B 站「自己刷」 ────────────────────────────────────────────────────────
  // 记忆是全局的（跨群），初始化一次；调度器在潜水时随机触发。
  if (cfg.socialV2?.bili?.enabled !== false) {
    try {
      const memFile = path.resolve(root, String(cfg.socialV2?.bili?.memory?.file || 'state/bili-memory.json'));
      const mem = createVideoMemory(memFile, {
        maxItems: cfg.socialV2?.bili?.memory?.maxItems
      });
      const st = mem.stats();
      log(`[B站] 已启用：记忆 ${st.total} 条（喜欢 ${st.liked} / 不喜欢 ${st.disliked}），今日已看 ${Math.round(st.today.seconds)}s`);
      // 凭据：只报状态，绝不打印内容（state/ 已在 .gitignore 里）
      const authFile = path.resolve(root, String(cfg.socialV2?.bili?.authFile || 'state/bili-auth.json'));
      const auth = loadBiliAuth(authFile);
      if (auth.loaded) {
        log(auth.hasSessdata
          ? '[B站] 账号凭据已加载（登录态），可用搜索与个性化结果'
          : `[B站] 凭据已加载但无登录态（${auth.reason}），搜索可用但非个性化`);
      } else {
        log(`[B站] 未配置账号凭据（${auth.reason}）；搜索走匿名设备号，功能仍可用`);
      }
      // 登录态同时注入 bili.js：字幕接口 `/x/player/v2` **必须登录**才返回字幕
      // （不登录时 code 仍是 0、subtitles 只是空数组，很容易误判成"这视频没字幕"）。
      // 只传 cookie 字符串，不打印。
      setBiliCookie(auth.cookie || '');
      if (auth.hasSessdata) {
        log('[B站] 字幕已启用（登录态可变声为文字，喂给模型比多抽帧更有用）');
      }
      // ── 本地语音转写（ASR）：让模型"听见"视频（2026-10-21 用户要求）──
      //
      // 实测决定了这条路：网关只接受 text/image_url，音频/视频内容类型全被拒
      // （原因见 src/asr.js 顶部）。所以"听觉"必须转成文字进模型。
      //
      // 字幕 vs ASR 是**互补**关系：有字幕用字幕（瞬时、零成本），
      // 没字幕才走 ASR（12~15 秒，但总能听到）。见 bili-browse 的 watchVideo。
      const asrCfg = cfg.socialV2?.bili?.asr ?? {};
      if (asrCfg.enabled !== false) {
        try {
          engine = createAsrEngine({
            enabled: true,
            model: asrCfg.model,
            cpuThreads: asrCfg.cpuThreads,
            timeoutMs: asrCfg.timeoutMs,
            log: (m) => log(m)
          });
          const ast = engine.status();
          log(`[ASR] 已配置：${ast.model}${ast.modelPath ? '（复用本地模型）' : '（将按名字下载）'}`
            + `，${ast.cpuThreads} 线程；首次识别前自动加载（约 8 秒）`);
          // 预热：启动后 20 秒后台加载，免得第一次刷视频时多等 8 秒。
          // 失败不影响任何功能（只是那一次没有"听觉"）。
          setTimeout(() => { void engine?.warmup?.(); }, 20000).unref?.();
        } catch (error) {
          log(`[ASR] 初始化失败（不影响刷视频，只是没有语音转写）：${error?.message ?? error}`);
          engine = null;
        }
      } else {
        log('[ASR] 已在配置中关闭（socialV2.bili.asr.enabled=false）；只有画面，没有声音内容');
      }
      const taste = mem.taste(3);
      if (taste.totalTags.length) {
        log(`[B站] 目前偏好：${taste.totalTags.map((t) => t.name).join('、')}`);
      }
      setBiliMem(mem);
      setBiliAuth(auth);
      setAsrEngine(engine);
      scheduleBiliBrowse();
    } catch (error) {
      // 记忆文件坏了不该让桥接起不来：降级为"不刷"
      log(`[B站] 初始化失败（不影响桥接）：${error?.message ?? error}`);
      setBiliMem(null);
    }
  } else {
    log('[B站] 已在配置中关闭（socialV2.bili.enabled=false）');
  }

  }

  return { start };
}
