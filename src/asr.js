// 本地语音转写（ASR）：把音轨变成文字，让模型"听见"。
//
// 需求（2026-10-21 用户）：「设计新的可以让模型同时接收视觉和听觉信息的方案」。
//
// ── 先说清楚为什么只能走"转文字"这条路（全部实测，不是推测）──
//
//   1. 网关的内容类型白名单：实测 9 种 type，**只接受 `text` 与 `image_url`**。
//      `input_audio` / `audio` / `file` / `image`（DSH 原生写法）全部在解析层
//      被拒：`code 11101 Parse message failed: unsupported content type`。
//      `video_url` 能通过解析，但模型侧会拒绝（见 2）。
//   2. 视频输入也不可用：`global:deepseek-v4.1-flash` 明确回答
//      「无法查看该视频，请切换支持视频的多模态模型或上传截图」；
//      `gemini-3.5-flash` 返回空壳；`gpt-5.6-sol`/`gpt-5.5`/`glm-5.1` 直接报错；
//      `glm-5v-turbo`/`glm-5.3` 明确说「不具备处理视频文件的能力」。
//   3. DSH 的 prompt 协议（`promptContentPartSchema`）只有 text / image 两种。
//
// 结论：**"听觉"必须以文字形态进入模型**。所以这条路是唯一可行的，
// 而不是"退而求其次"——音轨转写成文字后，模型确实"听到"了内容。
//
// ── 为什么用常驻进程 ───────────────────────────────────────────────────
//
// 实测 large-v3（3.1GB，int8/CPU）：**加载 7 秒**，而识别本身
// 12 秒音频约 10.7 秒、22 秒音频约 12.3 秒——**耗时几乎与时长无关**（固定开销为主）。
// 若每次识别都新起进程，那 7 秒纯属浪费。所以起一个常驻子进程，
// 用 stdin/stdout 逐行传 JSON：加载一次，之后每次只付识别时间。
//
// ── 模型来源 ───────────────────────────────────────────────────────────
//
// 优先复用本机已存在的 faster-whisper 模型目录（用户 2026-10-21 指定：
// `E:\Program Files\FasterWhisperGUI\models\faster-whisper-large-v3`），
// 避免重复下载 3GB。找不到时按配置的模型名让 faster-whisper 自己下载。
//
// 实测质量（同一段音频）：
//   large-v3 → 「今天天气不错，我们一起去公园散步吧。记得带上那把红色的雨伞。」（完全正确）
//   base     → 「今天天氣不錯…記得戴上納法紅色的魚閃。」（后半句错）
// 所以默认 large-v3；要更快可以配 small/base，但中文质量会明显下降。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 本机已知的 faster-whisper 模型目录（用户指定，优先复用，免下载 3GB）。 */
export const KNOWN_MODEL_DIRS = [
  'E:\\Program Files\\FasterWhisperGUI\\models\\faster-whisper-large-v3',
  'E:\\Program Files\\FasterWhisperGUI\\models\\faster-whisper-large-v2',
  'E:\\Program Files\\FasterWhisperGUI\\models\\faster-whisper-medium',
  'E:\\Program Files\\FasterWhisperGUI\\models\\faster-whisper-small'
];

/** 判断参数是"本地模型目录"（含 model.bin）还是 huggingface 的模型名。 */
export function resolveModelSpec(spec) {
  const s = String(spec ?? '').trim();
  if (!s) return null;
  // 绝对路径 / 含分隔符：当目录处理
  if (/[\\/]/.test(s) || /^[A-Za-z]:/.test(s)) {
    try {
      if (fs.existsSync(path.join(s, 'model.bin'))) return { kind: 'dir', value: s };
    } catch { /* 不存在就往下走 */ }
    return { kind: 'missing-dir', value: s };
  }
  return { kind: 'name', value: s };
}

/** 自动挑一个可用模型：配置优先 → 已知目录 → 名字兜底。 */
export function pickModelSpec(configured) {
  const explicit = resolveModelSpec(configured);
  if (explicit && explicit.kind !== 'missing-dir') return explicit;
  for (const d of KNOWN_MODEL_DIRS) {
    const r = resolveModelSpec(d);
    if (r && r.kind === 'dir') return r;
  }
  // 都没有：让 faster-whisper 按名字下载（需要网络与 HF 访问）
  return { kind: 'name', value: String(configured || 'base').trim() || 'base' };
}

/**
 * 常驻 ASR 引擎。
 *
 * 状态机：
 *   idle     —— 还没启动（下次识别时启动）
 *   starting —— 正在加载模型（约 7 秒；期间来的请求排队）
 *   ready    —— 可用
 *   failed   —— 启动失败（记录原因，按退避时间重试，不阻塞其它功能）
 */
export function createAsrEngine(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const pythonBin = String(opts.python || 'python');
  const cpuThreads = Math.max(1, Math.min(32, Number(opts.cpuThreads) || 8));
  const modelSpec = pickModelSpec(opts.model);
  const scriptPath = path.join(ROOT, 'scripts', 'asr-server.py');
  // 单次识别超时：实测 22 秒音频约 12 秒；留足余量给长音频与慢机器
  const timeoutMs = Math.max(10000, Number(opts.timeoutMs) || 120000);
  // 启动失败后的重试退避（避免每次刷视频都白等一次 7 秒加载）
  const retryAfterMs = Math.max(60000, Number(opts.retryAfterMs) || 10 * 60 * 1000);

  let child = null;
  let state = 'idle';        // idle | starting | ready | failed
  let lastError = '';
  let failedAt = 0;
  let queue = Promise.resolve();
  let loadedInfo = null;     // { spec, loadSec }

  const isEnabled = () => opts.enabled !== false;

  function spawnServer() {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(pythonBin, [scriptPath, modelSpec.value, String(cpuThreads)], {
          cwd: ROOT,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (error) {
        reject(new Error(`无法启动 ASR 进程：${error?.message ?? error}`));
        return;
      }
      let settled = false;
      let stderrBuf = '';
      const readyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch {}
        reject(new Error(`ASR 模型加载超时（>${Math.round(timeoutMs / 1000)}s）`));
      }, Math.max(60000, timeoutMs));

      // 启动脚本第一行 stderr 会写 `READY {"loadSec":...}`；等它出现才算可用
      const onData = (d) => {
        const txt = d.toString();
        stderrBuf += txt;
        const m = /READY\s*(\{[^\n]*\})/.exec(stderrBuf);
        if (m && !settled) {
          settled = true;
          clearTimeout(readyTimer);
          let info = {};
          try { info = JSON.parse(m[1]); } catch {}
          proc.stderr.removeListener('data', onData);
          resolve({ proc, info });
        }
      };
      proc.stderr.on('data', onData);
      proc.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        reject(new Error(`ASR 进程启动失败：${e?.message ?? e}`));
      });
      proc.on('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(new Error(`ASR 进程提前退出（code=${code}）：${stderrBuf.slice(-200)}`));
        }
        // 运行期退出：标记不可用，下次识别时重建
        if (child === proc) {
          child = null;
          if (state === 'ready') {
            state = 'failed';
            lastError = `ASR 进程退出（code=${code}）`;
            failedAt = Date.now();
            log(`[ASR] 进程退出（code=${code}），下次识别时会重新拉起`);
          }
        }
      });
    });
  }

  async function ensureReady() {
    if (!isEnabled()) throw new Error('ASR 未启用');
    if (state === 'ready' && child) return;
    if (state === 'failed' && Date.now() - failedAt < retryAfterMs) {
      throw new Error(`ASR 暂不可用（${lastError}），${Math.round((retryAfterMs - (Date.now() - failedAt)) / 60000)} 分钟后重试`);
    }
    state = 'starting';
    try {
      const { proc, info } = await spawnServer();
      child = proc;
      state = 'ready';
      lastError = '';
      loadedInfo = { spec: modelSpec.value, kind: modelSpec.kind, loadSec: Number(info?.loadSec) || 0 };
      log(`[ASR] 已就绪（${modelSpec.kind === 'dir' ? path.basename(modelSpec.value) : modelSpec.value}，加载 ${loadedInfo.loadSec}s，${cpuThreads} 线程）`);
    } catch (error) {
      state = 'failed';
      failedAt = Date.now();
      lastError = String(error?.message ?? error);
      log(`[ASR] 启动失败：${lastError}`);
      throw error;
    }
  }

  /** 真正的一次识别（单飞：串行化，避免并发把 CPU 打满）。 */
  function transcribeOnce(audioPath) {
    return new Promise((resolve, reject) => {
      if (!child) { reject(new Error('ASR 进程不可用')); return; }
      let buf = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.stdout.removeListener('onData', onData);
        reject(new Error(`ASR 识别超时（>${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);

      const onData = (d) => {
        buf += d.toString();
        let idx;
        // 逐行解析：一行一个 JSON 结果
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
          if (j.error) reject(new Error(`ASR 失败：${j.error}`));
          else resolve({ text: String(j.text ?? '').trim(), lang: String(j.lang ?? ''), asrSec: Number(j.asrSec) || 0 });
        }
      };
      child.stdout.on('data', onData);
      try {
        child.stdin.write(`${audioPath}\n`);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        reject(new Error(`写入 ASR 进程失败：${error?.message ?? error}`));
      }
    });
  }

  return {
    /** 当前状态（给控制台展示；不含任何路径以外的敏感信息）。 */
    status() {
      return {
        enabled: isEnabled(),
        state,
        model: modelSpec.kind === 'dir' ? path.basename(modelSpec.value) : modelSpec.value,
        modelPath: modelSpec.kind === 'dir' ? modelSpec.value : '',
        modelKind: modelSpec.kind,
        cpuThreads,
        loaded: state === 'ready',
        loadSec: loadedInfo?.loadSec ?? null,
        error: lastError || null,
        // 失败后还要等多久才会重试
        retryInMs: state === 'failed' ? Math.max(0, retryAfterMs - (Date.now() - failedAt)) : 0
      };
    },

    /** 是否可用（不触发加载）。 */
    available() {
      return isEnabled() && state === 'ready' && !!child;
    },

    /**
     * 转写一个音频文件。
     *
     * @param {string} audioPath 本地音频路径（wav/mp3/m4a 都行，ffmpeg 解码）
     * @returns {Promise<{text:string, lang:string, asrSec:number}>}
     */
    async transcribe(audioPath) {
      if (!isEnabled()) throw new Error('ASR 未启用');
      if (!audioPath || !fs.existsSync(audioPath)) throw new Error('音频文件不存在');
      // 串行化：两次识别并发会把 CPU 打满，反而都变慢
      const run = queue.then(async () => {
        await ensureReady();
        return transcribeOnce(audioPath);
      });
      // 无论成败都让队列继续（失败不能卡死后续请求）
      queue = run.catch(() => {});
      return run;
    },

    /** 预热（启动时调用，避免第一次刷视频时多等 7 秒）。失败不抛。 */
    async warmup() {
      try { await ensureReady(); return true; } catch { return false; }
    },

    /** 关闭（进程退出时清理）。 */
    shutdown() {
      try { child?.stdin.write('__quit__\n'); } catch {}
      try { child?.kill(); } catch {}
      child = null;
      state = 'idle';
    }
  };
}
