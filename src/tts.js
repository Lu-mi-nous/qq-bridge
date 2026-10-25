// 语音合成（TTS）插件：用 GPT-SoVITS + 达妮娅音色，让机器人**有概率发语音消息**。
//
// 需求（2026-10-21 用户）：「从 GitHub 上克隆一份 sovits 然后用这个达妮娅音源让它有
// 概率发出语音消息」→（2026-10-22）「这个能够做成可插拔的功能吗」。
//
// ── 可插拔的含义（照抄超分插件 upscale.js 的成熟模式）──────────────
//
//   1. **默认关闭**。config 里 `socialV2.tts.enabled` 不为 true 时，整套东西不存在：
//      不加载模型、不注册工具、不加提示词、控制台只显示"未启用"。
//   2. **探测优先**。启动时只做 `stat` 级别的检查（目录在不在、模型文件在不在、
//      python 能不能跑），**不启动进程**。缺任何一样就判为不可用并记下原因，
//      桥接其余功能完全不受影响。
//   3. **运行时降级**。合成失败（显存不足、文本被过滤、模型文件损坏）只影响这一条语音：
//      调用方回退成文字消息，并把原因记进日志/状态，不抛到群里。
//   4. **不碰外部项目**。GPT-SoVITS 是独立仓库（默认 `~/GPT-SoVITS`），
//      我们只通过环境变量传配置，不修改它的文件——用户更新它时不会冲突。
//
// ── 为什么用常驻进程（实测数据）──────────────────────────────────────
//
//   模型加载 3.4 秒；之后**推理很快**：4 字 1.5s、18 字 1.5s、42 字 2.9s。
//   每次发语音都重开进程 = 每条都白付 3.4~5 秒。所以起常驻 Python 子进程，
//   通过 stdin/stdout 逐行传 JSON（与 ASR 同一套模式，见 src/asr.js）。
//
// ── 为什么需要"概率"──────────────────────────────────────────────────
//
//   全量发语音很吵：群里每条回复都变语音，等于把聊天变成电台。
//   所以由桥接掷骰（`probability`，默认 0.05），模型不参与决策——
//   与自动 @ 一样的思路：让机器决定频率，避免模型"想起来才发"导致忽多忽少。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadVoicesManifest, resolveVoiceSelection, pickVoiceRef, voicesForApi } from './tts-voices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 默认的 GPT-SoVITS 安装位置（用户环境）。 */
export const DEFAULT_SOVITS_DIR = 'E:\\Downloads\\GPT-SoVITS';

/**
 * 读 wav 头算时长（秒）。仅用于缓存命中时补时长。
 *
 * 为什么自己解析而不调 ffprobe：这里只要一个数，起进程（几十毫秒 + 依赖 PATH）
 * 不值得；wav 头是固定结构，直接按 RIFF 块找到 `fmt `/`data` 即可。
 * 解析失败返回 0，调用方按"未知时长"处理。
 */
export function wavDurationSec(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(4096);
      const n = fs.readSync(fd, head, 0, 4096, 0);
      if (n < 44 || head.toString('ascii', 0, 4) !== 'RIFF') return 0;
      let pos = 12;
      let byteRate = 0;
      let dataSize = 0;
      while (pos + 8 <= n) {
        const id = head.toString('ascii', pos, pos + 4);
        const size = head.readUInt32LE(pos + 4);
        if (id === 'fmt ' && pos + 8 + 12 <= n) {
          byteRate = head.readUInt32LE(pos + 8 + 8); // fmt: audioFormat(2) channels(2) sampleRate(4) byteRate(4)
        } else if (id === 'data') {
          dataSize = size;
          break;
        }
        pos += 8 + size + (size % 2);
      }
      if (!byteRate || !dataSize) return 0;
      return Math.round((dataSize / byteRate) * 100) / 100;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
}

/** 默认音色：达妮娅（ModelScope villia/dania 提供的成品权重）。 */
export const DEFAULT_VOICE = {
  // 说话人权重（GPT 侧）
  gptModel: 'GPT_SoVITS/dania-e15.ckpt',
  // SoVITS 侧
  sovitsModel: 'GPT_SoVITS/dania_e16_s2192.pth',
  // 参考音频（音色克隆源）+ 它对应的台词。
  // 这两者**必须成对且逐字对应**：GPT-SoVITS 用 prompt_text 对齐参考音频的语义，
  // 写错会让合成出来的语调跟参考音频对不上（实测表现为"念得像另一个语气"）。
  refAudio: 'GPT_SoVITS/output/slicer_opt/output.wav_0009342720_0009558400.wav',
  refText: '怎么啊？如果有你在也不放心，那就干脆给我也装个限制器或者炸弹喽。',
  refLang: 'zh'
};

/**
 * 韵律/响度默认值。全部可以按请求覆盖（socialV2.tts 里可改），
 * 所以调整这些参数**不需要重启**。
 */
export const DEFAULT_SPEECH_PARAMS = {
  speed: 1.0,             // 语速倍率
  fragmentInterval: 0.3,  // 分句之间的停顿（秒）
  temperature: 0.9,       // 采样温度：太低平、太高飘
  topK: 15,
  topP: 0.95,
  textSplitMethod: 'cut5',// 按标点分句（cut1 = 基本不分）
  volumeGainDb: 0,        // 在自动响度归一之外再加减的 dB
  punctuate: true         // 合成前补标点/去占位符
};

/**
 * 合成前的文本规范化：只动标点与占位符，不改字词。
 *
 * 为什么（2026-10-22 用户「改善停顿」）：
 *   - QQ 回复经常没有句末标点，模型不知道哪里收尾，听起来像一口气念完；
 *   - `[表情76]` / `[图片]` 这类占位符会被念成"表情七十六"。
 * 句末补句号；长句且完全没有逗号时，在第一个常见连接词后补一个逗号，
 * 给模型一个换气点（只补一处，避免满屏逗号）。
 */
export function normalizeTtsText(text, { punctuate = true } = {}) {
  let s = String(text ?? '').trim();
  if (!s) return '';
  s = s.replace(/\[(?:图片|动画表情|表情包?|语音|视频|文件|卡片消息)[^\]]*\]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (!punctuate) return s;
  if (s.length > 18 && !/[，,；;：:]/.test(s)) {
    s = s.replace(/(然后|但是|不过|所以|因为|如果|而且|或者|其实|感觉|觉得)(?=[^，。！？,.!?])/, '$1，');
  }
  if (!/[。！？!?…~～.]$/.test(s)) s += '。';
  return s;
}

/**
 * 探测 GPT-SoVITS 是否可用（**只看文件，不启动进程**）。
 *
 * 与 `probeUpscale` 同样的契约：返回 `{ ok, reason, ... }`，
 * 调用方据此决定"注册工具 / 显示未启用"，绝不因为探测失败而抛错。
 */
export function probeSovits(opts = {}) {
  const dir = String(opts.dir || DEFAULT_SOVITS_DIR).trim();
  const fail = (reason, extra = {}) => ({ ok: false, reason, dir, ...extra });
  if (!dir) return fail('未配置 GPT-SoVITS 目录（socialV2.tts.dir）');
  if (!fs.existsSync(dir)) return fail(`GPT-SoVITS 目录不存在：${dir}`);

  // 关键文件：入口模块 + 配置 + 两个说话人权重 + 参考音频
  const serverScript = path.join(ROOT, 'scripts', 'sovits-server.py');
  if (!fs.existsSync(serverScript)) return fail('缺少 scripts/sovits-server.py（插件不完整）');

  const cfgPath = path.join(dir, 'GPT_SoVITS', 'configs', 'tts_infer.yaml');
  if (!fs.existsSync(cfgPath)) return fail(`配置文件不存在：${cfgPath}`);

  // ── 音色预设（voices.json）优先 ─────────────────────────────────────
  // 用户把「音色 → 权重版本 → 按情绪分好的参考音频」归档在
  // <GPT-SoVITS>/GPT_SoVITS/voices.json。选中预设后，它覆盖手写路径。
  // 找不到清单时完全退回旧行为（单一权重 + 单一参考音频）。
  const manifest = loadVoicesManifest(dir);
  const selection = manifest.ok
    ? resolveVoiceSelection(manifest, {
        voiceId: opts.voiceId,
        weightsId: opts.weightsId,
        refMode: opts.refMode
      })
    : null;

  const gptModel = selection?.weights?.gpt || opts.gptModel || DEFAULT_VOICE.gptModel;
  const sovitsModel = selection?.weights?.sovits || opts.sovitsModel || DEFAULT_VOICE.sovitsModel;
  const refAudio = selection?.defaultRef?.audio || opts.refAudio || DEFAULT_VOICE.refAudio;
  const refText = selection?.defaultRef?.text ?? opts.refText ?? DEFAULT_VOICE.refText;
  const refLang = selection?.defaultRef?.lang || opts.refLang || DEFAULT_VOICE.refLang;
  const voiceName = selection?.voice?.name || String(opts.voiceName || '达妮娅');
  const p = (rel) => (path.isAbsolute(rel) ? rel : path.join(dir, rel));
  if (!fs.existsSync(p(gptModel))) return fail(`GPT 权重不存在：${gptModel}`);
  if (!fs.existsSync(p(sovitsModel))) return fail(`SoVITS 权重不存在：${sovitsModel}`);
  if (!fs.existsSync(p(refAudio))) return fail(`参考音频不存在：${refAudio}`);

  // 底模：没有它们模型根本加载不起来，提前挡掉比"启动 30 秒后报错"友好得多
  const bert = path.join(dir, 'GPT_SoVITS', 'pretrained_models', 'chinese-roberta-wwm-ext-large');
  const hubert = path.join(dir, 'GPT_SoVITS', 'pretrained_models', 'chinese-hubert-base');
  if (!fs.existsSync(bert)) return fail('缺少底模 chinese-roberta-wwm-ext-large');
  if (!fs.existsSync(hubert)) return fail('缺少底模 chinese-hubert-base');

  return {
    ok: true,
    dir,
    cfgPath,
    gptModel,
    sovitsModel,
    // 绝对路径：传给引擎用。配置里可能是相对 GPT-SoVITS 根目录的写法，
    // 而 Python 侧虽然会 chdir 到根目录，显式给绝对路径更不容易出错。
    gptModelAbs: p(gptModel),
    sovitsModelAbs: p(sovitsModel),
    refAudio: p(refAudio),
    refText: String(refText),
    refLang: String(refLang),
    gpu: opts.device !== 'cpu',
    voiceName,
    // 音色预设信息：控制台据此渲染音色/权重/参考下拉
    voiceId: selection?.voice?.id || '',
    weightsId: selection?.weights?.id || '',
    weightsLabel: selection?.weights?.label || '',
    refs: selection?.refs || [],
    defaultRefId: selection?.defaultRef?.id || '',
    refMode: String(opts.refMode || 'auto'),
    voices: voicesForApi(manifest, selection),
    manifestPath: manifest.file,
    manifestError: manifest.ok ? '' : manifest.error
  };
}

/**
 * 常驻 TTS 引擎。
 *
 * 与 `createAsrEngine` 结构一致（idle/starting/ready/failed 状态机 + 串行化 +
 * 失败退避），差异是它还要传参考音频与台词。
 */
export function createTtsEngine(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const probe = opts.probe || probeSovits(opts);
  const pythonBin = String(opts.python || 'python');
  const serverScript = path.join(ROOT, 'scripts', 'sovits-server.py');
  const device = String(opts.device || 'cuda');
  const isHalf = opts.isHalf !== false;
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || 120000);
  const retryAfterMs = Math.max(60000, Number(opts.retryAfterMs) || 10 * 60 * 1000);
  const outDir = String(opts.outDir || path.join(ROOT, 'state', 'tts-cache'));

  let child = null;
  let state = 'idle';
  let lastError = '';
  let failedAt = 0;
  let queue = Promise.resolve();
  let loadedInfo = null;
  // 清单模式下的参考音频集合；旧模式没有清单时为空，合成回落到 probe 的单一参考。
  const voiceSelection = Array.isArray(probe.refs) && probe.refs.length
    ? {
        refs: probe.refs,
        defaultRef: probe.refs.find((r) => r.id === probe.defaultRefId) || probe.refs[0]
      }
    : null;
  const legacyRef = { id: 'default', mood: '', audio: probe.refAudio, text: probe.refText, lang: probe.refLang };

  function spawnServer() {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(pythonBin, [serverScript], {
          cwd: ROOT,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            QQB_SOVITS_DIR: probe.dir,
            QQB_SOVITS_CONFIG: probe.cfgPath,
            QQB_SOVITS_DEVICE: device,
            QQB_SOVITS_HALF: isHalf ? '1' : '0',
            QQB_SOVITS_REF_AUDIO: probe.refAudio,
            QQB_SOVITS_PROMPT_TEXT: probe.refText,
            // 控制台选的权重必须**真的**传给引擎。之前只传了目录/参考音频，
            // Python 侧照旧读 tts_infer.yaml 的 custom 段 → 控制台显示"爱弥斯"、
            // 实际加载的却是 yaml 里的 dania，换权重完全没效果（2026-10-22 实测）。
            QQB_SOVITS_T2S: probe.gptModelAbs || '',
            QQB_SOVITS_VITS: probe.sovitsModelAbs || '',
            // 别让它在运行时去 HF 下载底模（离线/被墙时会卡住几十秒）
            HF_HUB_OFFLINE: '1',
            TRANSFORMERS_OFFLINE: '1',
            // 强制 Python 的 stdio 用 UTF-8。Windows 下默认是 ANSI 代码页（简中=GBK），
            // 中文经 stdin 进去会变成 `'���ѽ�...'`，合成出的是噪声——
            // 表现是"接口 200、有文件、但时长明显偏短且听不出内容"（实测踩到）。
            // 服务端脚本里也做了 reconfigure，这里是双保险。
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1'
          }
        });
      } catch (error) {
        reject(new Error(`无法启动 TTS 进程：${error?.message ?? error}`));
        return;
      }
      let settled = false;
      let stderrBuf = '';
      // 模型加载 + 预热，给足时间（实测 5~15 秒，冷启动可能更久）
      const readyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch {}
        reject(new Error(`TTS 启动超时（>${Math.round(timeoutMs / 1000)}s）`));
      }, Math.max(60000, timeoutMs));

      const onData = (d) => {
        stderrBuf += d.toString();
        const m = /READY\s*(\{[^\n]*\})/.exec(stderrBuf);
        if (m && !settled) {
          settled = true;
          clearTimeout(readyTimer);
          let info = {};
          try { info = JSON.parse(m[1]); } catch {}
          proc.stderr.removeListener('data', onData);
          // 启动后继续把 stderr 转进日志：GPT-SoVITS 的诊断行（如 SYNTH_IN、
          // 目标文本、报错堆栈）都走 stderr，吞掉它们等于把唯一的排查线索扔掉。
          // 只保留关键字，避免把大段调试输出刷进日志。
          proc.stderr.on('data', (buf) => {
            const s = buf.toString();
            for (const line of s.split('\n')) {
              if (!line.trim()) continue;
              if (/SYNTH_IN|实际输入的目标文本|Error|error|Traceback|Exception/.test(line)) {
                log(`[TTS:py] ${line.trim().slice(0, 300)}`);
              }
            }
          });
          resolve({ proc, info });
        }
      };
      proc.stderr.on('data', onData);
      proc.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        reject(new Error(`TTS 进程启动失败：${e?.message ?? e}`));
      });
      proc.on('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(new Error(`TTS 进程提前退出（code=${code}）：${stderrBuf.slice(-200)}`));
        }
        if (child === proc) {
          child = null;
          if (state === 'ready') {
            state = 'failed';
            lastError = `TTS 进程退出（code=${code}）`;
            failedAt = Date.now();
            log(`[TTS] 进程退出（code=${code}），下次合成时会重新拉起`);
          }
        }
      });
    });
  }

  async function ensureReady() {
    if (!probe.ok) throw new Error(probe.reason || 'GPT-SoVITS 不可用');
    if (state === 'ready' && child) return;
    if (state === 'failed' && Date.now() - failedAt < retryAfterMs) {
      throw new Error(`TTS 暂不可用（${lastError}），稍后重试`);
    }
    state = 'starting';
    try {
      const { proc, info } = await spawnServer();
      child = proc;
      state = 'ready';
      lastError = '';
      loadedInfo = {
        loadSec: Number(info?.loadSec) || 0,
        warmed: info?.warmed === true,
        // 引擎回报的**实际加载**权重，供控制台核对（配置/实际不一致时能一眼看出）
        t2s: String(info?.t2s || ''),
        vits: String(info?.vits || ''),
        version: String(info?.version || '')
      };
      log(`[TTS] 已就绪（${probe.voiceName}，${device}，加载 ${loadedInfo.loadSec}s`
        + `${loadedInfo.warmed ? '，已预热' : ''}）`);
    } catch (error) {
      state = 'failed';
      failedAt = Date.now();
      lastError = String(error?.message ?? error);
      log(`[TTS] 启动失败：${lastError}`);
      throw error;
    }
  }

  function synthesize(text, outFile, ref, params) {
    const useRef = ref || legacyRef;
    const p = params || DEFAULT_SPEECH_PARAMS;
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return new Promise((resolve, reject) => {
      if (!child) { reject(new Error('TTS 进程不可用')); return; }
      let buf = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.stdout.removeListener('data', onData);
        reject(new Error(`TTS 合成超时（>${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);

      const onData = (d) => {
        buf += d.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let j;
          try { j = JSON.parse(line); } catch { continue; }
          if (settled) continue;
          settled = true;
          clearTimeout(timer);
          child.stdout.removeListener('data', onData);
          if (j.error) reject(new Error(`TTS 合成失败：${j.error}`));
          else resolve({ out: j.out, sr: j.sr, durSec: j.durSec, synthSec: j.synthSec });
        }
      };
      child.stdout.on('data', onData);
      let reqPath = '';
      try {
        // 请求走**文件**而不是 stdin（见 sovits-server.py 里的详细说明）：
        // Windows 上 Python 子进程的管道 stdio 会按系统 ANSI 代码页（GBK）解码，
        // Node 写入的 UTF-8 中文会被打碎（实测 18 字变 28 个乱码字符），
        // 合成出来的是一段听不出内容的短噪声。
        // stdin 只传一行**绝对路径**（纯 ASCII），文件内容由 Python 按 UTF-8 读。
        reqPath = path.join(outDir, `.req-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`);
        fs.writeFileSync(reqPath, JSON.stringify({
          text,
          // 每次合成可以换参考音频（GPT-SoVITS 的"情绪"就靠它）：
          // 同一个常驻进程里换 ref 不需要重启模型。
          ref_audio_path: useRef.audio || probe.refAudio,
          prompt_text: useRef.text || probe.refText,
          prompt_lang: useRef.lang || probe.refLang,
          text_lang: useRef.lang || probe.refLang,
          // 韵律参数：每次请求现传，控制台改完即时生效（不需要重启）
          speed: num(p.speed, 1.0),
          fragment_interval: num(p.fragmentInterval, 0.3),
          temperature: num(p.temperature, 0.9),
          top_k: num(p.topK, 15),
          top_p: num(p.topP, 0.95),
          text_split_method: String(p.textSplitMethod || 'cut5'),
          volume_gain_db: num(p.volumeGainDb, 0),
          out: outFile
        }), 'utf8');
        child.stdin.write(`${reqPath}\n`);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        try { if (reqPath) fs.rmSync(reqPath, { force: true }); } catch {}
        reject(new Error(`写入 TTS 进程失败：${error?.message ?? error}`));
      }
    });
  }

  return {
    status() {
      return {
        available: probe.ok,
        enabled: opts.enabled !== false,
        state: probe.ok ? state : 'unavailable',
        voice: probe.voiceName || '',
        dir: probe.dir || '',
        device,
        isHalf,
        // 实际加载的权重（引擎已就绪时以它为准，未加载时回落到配置值）。
        // 控制台的"模型设置"以前只显示配置、不显示实际加载，出过
        // "显示爱弥斯、实际跑 dania" 的误导（2026-10-22）。
        gptModel: loadedInfo?.t2s || path.basename(probe.gptModelAbs || probe.gptModel || ''),
        sovitsModel: loadedInfo?.vits || path.basename(probe.sovitsModelAbs || probe.sovitsModel || ''),
        version: loadedInfo?.version || '',
        // 音色预设信息：控制台据此显示/校验当前选择
        voiceId: probe.voiceId || '',
        weightsId: probe.weightsId || '',
        weightsLabel: probe.weightsLabel || '',
        refs: Array.isArray(probe.refs)
          ? probe.refs.map((r) => ({ id: r.id, mood: r.mood, label: r.label }))
          : [],
        defaultRefId: probe.defaultRefId || '',
        refMode: probe.refMode || 'auto',
        loadSec: loadedInfo?.loadSec ?? null,
        warmed: loadedInfo?.warmed ?? null,
        error: probe.ok ? (lastError || null) : (probe.reason || null),
        retryInMs: state === 'failed' ? Math.max(0, retryAfterMs - (Date.now() - failedAt)) : 0
      };
    },

    probe() { return probe; },

    available() { return probe.ok && opts.enabled !== false; },

    /** 预热（启动时后台调一次，避免第一条语音多等 3~4 秒）。失败不抛。 */
    async warmup() {
      if (!probe.ok || opts.enabled === false) return false;
      try { await ensureReady(); return true; } catch { return false; }
    },

    /**
     * 合成一句语音，返回音频文件路径。
     *
     * 输出到 `state/tts-cache/`（按文本哈希命名，同句复用，省一次推理）。
     * 调用方负责发送与清理；本模块不碰 OneBot。
     *
     * @param {string} text
     * @param {{refId?:string, mood?:string, params?:object}} [callOpts]
     *        refId 指定固定参考；mood 是回复语气（happy/sad/angry/...），
     *        清单模式下会映射到对应情绪的参考音频。params 覆盖韵律/响度参数。
     * @returns {Promise<{ok:true, file:string, durSec:number, cached:boolean, refId:string} | {ok:false, error:string}>}
     */
    async speak(text, callOpts = {}) {
      if (!probe.ok) return { ok: false, error: probe.reason || 'GPT-SoVITS 不可用' };
      if (opts.enabled === false) return { ok: false, error: 'TTS 未启用' };
      const t = String(text ?? '').trim();
      if (!t) return { ok: false, error: '文本为空' };
      if (t.length > 300) return { ok: false, error: '文本过长（语音上限 300 字）' };

      // 每次合成都按"这句回复的语气"挑参考音频；同一情绪有多条时随机，
      // 避免每句话都是同一个语调。选不到就回落到默认/单一参考。
      const ref = pickVoiceRef(voiceSelection, { refId: callOpts.refId, mood: callOpts.mood }) || legacyRef;
      // 韵律参数按请求现读：控制台改完下一次合成就生效，不用重启。
      const params = { ...DEFAULT_SPEECH_PARAMS, ...(callOpts.params || {}) };
      // 只对"念出来的文本"补标点/去占位符，不改实际发送的消息。
      const spoken = normalizeTtsText(t, { punctuate: params.punctuate !== false }) || t;

      // 文本指纹缓存：同一句话重复合成没有意义（实测一句 1.5~3 秒）。
      // 参考音频、韵律参数也进指纹：任何一项变了都是**另一条音频**，不能命中旧缓存。
      const hash = (await import('node:crypto')).createHash('sha1')
        .update(`${probe.sovitsModel}|${ref.id}|${ref.audio}|${spoken}|${params.speed}|${params.fragmentInterval}|${params.temperature}|${params.topK}|${params.topP}|${params.textSplitMethod}|${params.volumeGainDb}`)
        .digest('hex').slice(0, 16);
      const file = path.join(outDir, `tts-${hash}.wav`);
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > 1024) {
          // 缓存命中也要给出**时长**：控制台/日志/返回值都靠它显示"这条语音多长"，
          // 返回 0 会让界面显示"0s"（实测踩到）。从 wav 头算，代价可忽略。
          return { ok: true, file, durSec: wavDurationSec(file), cached: true, refId: ref.id, refMood: ref.mood || '' };
        }
      } catch { /* 缓存读失败就重新合成 */ }

      try {
        fs.mkdirSync(outDir, { recursive: true });
      } catch (error) {
        return { ok: false, error: `创建缓存目录失败：${error?.message ?? error}` };
      }

      const run = queue.then(async () => {
        await ensureReady();
        return synthesize(spoken, file, ref, params);
      });
      queue = run.catch(() => {});
      try {
        const r = await run;
        return { ok: true, file: r.out, durSec: Number(r.durSec) || 0, cached: false, synthSec: r.synthSec, refId: ref.id, refMood: ref.mood || '' };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },

    shutdown() {
      try { child?.stdin.write('__quit__\n'); } catch {}
      try { child?.kill(); } catch {}
      child = null;
      state = 'idle';
    },

    /** 清理旧语音缓存（按数量+天数），返回删除数。 */
    pruneCache({ maxFiles = 60, maxAgeDays = 3 } = {}) {
      let names;
      try { names = fs.readdirSync(outDir); } catch { return { removed: 0 }; }
      const files = names.filter((n) => /^tts-[0-9a-f]{16}\.wav$/.test(n)).map((n) => {
        const p = path.join(outDir, n);
        try { return { p, st: fs.statSync(p) }; } catch { return null; }
      }).filter(Boolean).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      const cutoff = Date.now() - Math.max(0, maxAgeDays) * 86400000;
      let removed = 0;
      files.forEach((f, i) => {
        if (i < maxFiles && f.st.mtimeMs >= cutoff) return;
        try { fs.rmSync(f.p, { force: true }); removed++; } catch {}
      });
      return { removed };
    }
  };
}
