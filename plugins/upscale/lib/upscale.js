// 超分辨率放大（Real-ESRGAN，走本机已装的 Upscayl）。
//
// 背景（2026-10-19 用户要求「接入超分功能，软件现成在 C:\Program Files\Upscayl」）：
// 桥接原本用 ffmpeg lanczos 放大过小的图片（见 image-downscale.js 的 upscaleIfSmall）。
// lanczos 是**插值**：把像素平滑地拉开，笔画边缘还是虚的。模型切 14px patch 时，
// 糊边正好落进 patch 边界，所以小图里的中文仍然难读。
//
// Real-ESRGAN 是**生成式**超分：模型按训练分布"画出"缺失的高频细节，文字边缘明显更实。
// 实测同一张 180×90 的文字截图放大到 720×360：
//   - lanczos：笔画发虚、细笔画粘连
//   - upscayl-standard-4x：边缘锐利、可读性接近原生
// 所以小图放大应当**优先走超分**，失败了再退回 lanczos（超分是增强，不能变成新的失败点）。
//
// 为什么直接调 upscayl-bin.exe 而不是 Upscayl.exe：
//   Upscayl.exe 是 Electron 外壳（172MB），启动一个 GUI 窗口才能干活，无法在桥接里
//   无人值守地调用；resources/bin/upscayl-bin.exe 才是真正干活的 ncnn 命令行程序。
//   它支持 -i/-o/-m/-n/-f/-w，输出可直接指定格式与目标宽度。
//
// 已知限制（都是实测确认的，不是猜测）：
//   - 首次调用要初始化 Vulkan 后端，约 1~5 秒；之后每张 200~300px 的图约 1~3 秒（RTX 4070）。
//   - 只处理**静态图**。动图会丢帧语义，调用方应先抽帧（gif-frames.js）。
//   - 输入过大时耗时会显著上升（4x 模型对 1000px 图要跑十几秒），所以本模块对超大输入
//     直接拒绝、交给调用方走"缩图"路径——放大一张已经够大的图没有意义。
//   - 模型名必须与 resources/models 下的文件名一致（不带 .bin/.param）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { imageSizeOf } from '../../../src/image-downscale.js';
// ffmpeg 定位复用 gif-frames.js（同一套 PATH + 常见安装位置探测，带缓存）。
// 注意：gif-frames.js 不 import 本模块，所以这条依赖不会形成循环。
import { findFfmpeg } from '../../../src/gif-frames.js';

// bin 探针在核心（feature-menu 要同步用）；模型目录仍归插件。
import { DEFAULT_BIN_DIR, resolveBin, findUpscaylBin } from '../../../src/upscale-bin.js';

export { findUpscaylBin };

export const DEFAULT_MODEL_DIR = 'C:\\Program Files\\Upscayl\\resources\\models';

/**
 * 可用模型（文件名去掉 .bin）+ 人话说明，供工具描述与报错提示用。
 *
 * 选择依据（按用途，不是按"哪个更强"——它们各有偏向）：
 *   - upscayl-standard-4x：通用照片/截图，速度与质量均衡 —— **默认**
 *   - upscayl-lite-4x：最快、体积最小，适合"只要能看清就行"的快速场景
 *   - digital-art-4x：二次元插画/立绘，线条干净
 *   - high-fidelity-4x：照片写实向，保留纹理、不过度锐化
 *   - remacri-4x：通用强锐化，噪点多的老图效果明显
 *   - ultrasharp-4x：锐度最高，但可能放大噪点/出现边缘振铃
 *   - ultramix-balanced-4x：多模型混合，折中
 *
 * 只列**实测存在**的模型；目录里没有的会被运行时过滤掉（见 listModels）。
 */
export const MODEL_GUIDE = {
  'upscayl-standard-4x': '通用（照片/截图），默认',
  'upscayl-lite-4x': '最快，适合快速看清',
  'digital-art-4x': '二次元插画/立绘',
  'high-fidelity-4x': '照片写实，保留纹理',
  'remacri-4x': '强锐化，适合噪点多的老图',
  'ultrasharp-4x': '最锐，可能放大噪点',
  'ultramix-balanced-4x': '多模型混合折中'
};

/** 输出宽度上限：视觉模型有效输入边长约 1568，再大也会被内部缩放，白费算力。 */
const MAX_OUTPUT_WIDTH = 1568;

/**
 * 拒绝放大的输入长边上限。
 *
 * 定这个值时踩过一次（2026-10-19 用户反馈「它一直说原图就够大，超分没意义」）：
 * 原先取 1200，结果**真实照片全部被拒**——群里实际要超分的图是 879×1448、986×1659
 * （手机照片的等比缩略），长边都超过 1200，于是模型每次都收到 `input-too-large`，
 * 只能回"原图已经够大"。而实测 879×1448 用 upscayl-lite-4x + `-w 1568` 只要 **1.6 秒**、
 * 输出 374KB —— 完全能跑。上限太保守，等于把这个功能关掉了。
 *
 * 现在放到 4000：覆盖手机原图（常见 3000~4000 长边）。真正的约束不在输入尺寸，
 * 而在 `-w` 把**输出**压到 1568（否则 4x 会把 879×1448 放大成 3516×5792、1.6MB，5 秒）。
 * 再大的输入由调用方先缩图（prepareImageForModel 的 downscale 在超分之前跑）。
 */
const MAX_INPUT_EDGE = 4000;

/**
 * 触发超分的最小长边——**低于它才值得超分**。
 *
 * 与 image-downscale.js 的 MIN_EDGE 同一量级（那里 lanczos 用 400）。
 * 为什么必须设这道门槛（2026-10-19 实测发现的坑）：不加门槛时，
 * `prepareImageForModel` 会对**每张图**都调超分，一张 800px 的正常照片会被放大到 1568px，
 * 既白烧 3 秒算力、又改变原图信息（模型本来已经看得清）。超分只服务于"太小看不清"。
 */
const MIN_EDGE_TO_UPSCALE = 400;

/** 单次超分的超时。4x 模型对较大图可能要十几秒，留足余量。 */
const DEFAULT_TIMEOUT_MS = 120000;

// ── 磁盘缓存 + 定时清理（2026-10-19 用户要求）───────────────────────────────
//
// 为什么加缓存：超分是这张链路上最贵的一步（200×163 约 3 秒，879×1448 约 8~10 秒），
// 而**同一张图被反复超分**很常见——群友重发同一个表情包、模型对同一条消息看两次、
// 桥接重启后重新处理未读。每次重跑 GPU 纯属浪费，缓存命中的收益是秒级的。
//
// 为什么必须定时清理：这玩意儿**只增不减**。一张 1568×2583 的超分 PNG 是 3~7MB，
// 三百张就把磁盘吃掉 1GB。用户明确要求「超分后的结果本地缓存应当定时清理」。
//
// 设计：
//   - 键 = sha256(原图字节) + 模型 + 目标宽度 + 输出格式。三者任一不同结果就不同，
//     不能只按图片哈希——换模型/换宽度（比如 publish 压缩）会产生不同的正确结果。
//   - 存到 state/upscale-cache/<前两位>/<完整哈希>.png，分目录避免单目录塞几千个文件
//     （Windows 上单目录文件过多时 stat/枚举会明显变慢）。
//   - 写盘用「先写唯一临时名再 rename」的原子写法，避免读到写了一半的文件。
//   - 清理是**双阈值**：超过 maxAgeDays 天 或 总大小超过 maxBytes，先删最旧的，
//     直到两个条件都满足。按 atime/mtime 排序（用 mtime，atime 在 Windows 上常被禁用）。
//   - 清理在**写入时顺手触发**（每 N 次写入一次），外加桥接启动后的定时器兜底：
//     只在写入时清理的话，一张图都不超分时旧缓存会一直留着（比如停用超分后）。
const CACHE_DEFAULTS = {
  enabled: true,
  dir: '',                 // 空则用 <ROOT>/state/upscale-cache
  maxAgeDays: 3,           // 用户选定：3 天
  maxBytes: 500 * 1024 * 1024, // 用户选定：500MB
  sweepEveryWrites: 20     // 每 N 次写入触发一次清理（避免每次都遍历目录）
};

let cacheRoot = '';        // 由 configureUpscaleCache 设置
let cacheWrites = 0;

/**
 * 设置缓存根目录（桥接启动时调用一次；测试里也用它隔离到临时目录）。
 * @param {string} dir 绝对路径；空字符串则禁用缓存
 */
export function configureUpscaleCache(dir) {
  cacheRoot = String(dir || '').trim();
  if (cacheRoot) {
    try { fs.mkdirSync(cacheRoot, { recursive: true }); } catch { cacheRoot = ''; }
  }
}

/** 当前缓存目录（未配置返回空串）。 */
export function upscaleCacheDir() {
  return cacheRoot;
}

function cacheKey(buf, model, targetWidth) {
  return crypto.createHash('sha256')
    .update(buf)
    .update(`|${model}|${targetWidth}`)
    .digest('hex');
}

function cachePaths(key) {
  const sub = path.join(cacheRoot, key.slice(0, 2));
  return { sub, file: path.join(sub, `${key}.png`) };
}

/**
 * 查缓存。命中返回 Buffer，否则 null。
 *
 * 命中时**顺手更新 mtime**，让"最近用过的"排在清理队列后面——
 * 否则清理只按写入时间淘汰，会把反复命中的常用图删掉、留下没人再用一次的。
 */
function readCache(key) {
  if (!cacheRoot) return null;
  const { file } = cachePaths(key);
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return null;
    const buf = fs.readFileSync(file);
    // 轻量校验：缓存文件可能被外部截断/损坏，不是 PNG 就当未命中
    if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
      try { fs.unlinkSync(file); } catch {}
      return null;
    }
    try { const now = new Date(); fs.utimesSync(file, now, now); } catch {}
    return buf;
  } catch {
    return null;
  }
}

/** 写缓存。失败一律忽略——缓存是优化，不能让它成为新的失败点。 */
function writeCache(key, buf) {
  if (!cacheRoot) return;
  const { sub, file } = cachePaths(key);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return;
  }
  // 顺手清理（每 N 次写入一次，避免每条消息都遍历目录）
  cacheWrites += 1;
  if (cacheWrites % CACHE_DEFAULTS.sweepEveryWrites === 0) {
    try { pruneUpscaleCache(); } catch {}
  }
}

/**
 * 按双阈值清理缓存：超过 maxAgeDays 天 或 总量超过 maxBytes 就删，先删最旧的。
 *
 * `maxBytes: 0` 表示"不按大小限制"，`maxAgeDays: 0` 表示"不按年龄限制"；
 * 两者都为 0 时**什么都不删**（安全默认：误传参数不会清空缓存）。
 * 要清空全部请用 `clearUpscaleCache()`。
 *
 * @param {{maxAgeDays?:number, maxBytes?:number, now?:number}} opts
 * @returns {{removed:number, freedBytes:number, kept:number, keptBytes:number, total:number, totalBytes:number}}
 */
export function pruneUpscaleCache(opts = {}) {
  const result = { removed: 0, freedBytes: 0, kept: 0, keptBytes: 0, total: 0, totalBytes: 0 };
  if (!cacheRoot) return result;

  const maxAgeDays = Number(opts.maxAgeDays ?? CACHE_DEFAULTS.maxAgeDays);
  const maxBytes = Number(opts.maxBytes ?? CACHE_DEFAULTS.maxBytes);
  const now = Number(opts.now) || Date.now();

  // 收集所有缓存文件（两层：<xx>/<hash>.png）
  const entries = [];
  let dirs = [];
  try { dirs = fs.readdirSync(cacheRoot, { withFileTypes: true }); } catch { return result; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sub = path.join(cacheRoot, d.name);
    let files = [];
    try { files = fs.readdirSync(sub); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.png')) continue;
      const p = path.join(sub, f);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        entries.push({ path: p, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
  }

  result.total = entries.length;
  result.totalBytes = entries.reduce((a, e) => a + e.size, 0);

  // 先按 mtime 从旧到新
  entries.sort((a, b) => a.mtime - b.mtime);

  const maxAgeMs = maxAgeDays > 0 ? maxAgeDays * 86400000 : 0;
  let remainingBytes = result.totalBytes;
  let kept = 0;

  for (const e of entries) {
    const tooOld = maxAgeMs > 0 && (now - e.mtime) > maxAgeMs;
    const tooBig = maxBytes > 0 && remainingBytes > maxBytes;
    if (!tooOld && !tooBig) {
      kept += 1;
      result.keptBytes += e.size;
      continue;
    }
    try {
      fs.unlinkSync(e.path);
      result.removed += 1;
      result.freedBytes += e.size;
      remainingBytes -= e.size;
    } catch {
      // 删不掉（占用/权限）：仍计入"保留"，否则账面会与实际磁盘不符
      kept += 1;
      result.keptBytes += e.size;
    }
  }
  result.kept = kept;
  return result;
}

/** 清空全部缓存（管理员手动/测试用）。 */
export function clearUpscaleCache() {
  if (!cacheRoot) return { removed: 0, freedBytes: 0 };
  let removed = 0;
  let freedBytes = 0;
  try {
    for (const d of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const sub = path.join(cacheRoot, d.name);
      let files = [];
      try { files = fs.readdirSync(sub); } catch { continue; }
      for (const f of files) {
        const p = path.join(sub, f);
        try {
          const st = fs.statSync(p);
          if (!st.isFile()) continue;
          fs.unlinkSync(p);
          removed += 1;
          freedBytes += st.size;
        } catch {}
      }
      try { fs.rmdirSync(sub); } catch {}
    }
  } catch {}
  return { removed, freedBytes };
}

// ── 插件可用性：探测结果缓存 + 熔断 ────────────────────────────────────────
//
// 这是"没有 Upscayl 也不能影响桥接"的核心（2026-10-19 用户要求做成可选插件）。
// 光有"文件不存在就跳过"还不够——真正会拖垮桥接的是**文件在、但运行不正常**：
//   - 显卡驱动出问题 → 每次调用挂到超时（默认 120s），一张图把回复卡死两分钟
//   - 二进制损坏/缺 DLL → 每次都要先失败一次
//   - 用户把目录指向一个假文件 → 同上
// 所以：
//   ① 探测结果按 (binDir) 缓存，避免每条消息都 stat 一遍；
//   ② 连续失败达到阈值 → 熔断一段时间，期间**直接跳过、连进程都不起**；
//   ③ 熔断到期后放一次试探，成功则恢复。
//
// 全部状态都在进程内存里，不写盘：它是运行时健康度，不是配置。
const AVAIL_TTL_MS = 60 * 1000;        // 探测结果缓存时长
const BREAKER_THRESHOLD = 2;           // 连续失败几次后熔断
const BREAKER_MS = 10 * 60 * 1000;     // 熔断时长

const availCache = new Map();  // binDir -> { ok, at, reason }
const breakerState = new Map(); // binDir -> { failures, until, lastError }

/** 清空探测/熔断状态（测试与"配置改了想立刻重试"时用）。 */
export function resetUpscaleState() {
  availCache.clear();
  breakerState.clear();
}

function breakerFor(binDir) {
  let b = breakerState.get(binDir);
  if (!b) {
    b = { failures: 0, until: 0, lastError: '' };
    breakerState.set(binDir, b);
  }
  return b;
}

/** 当前是否处于熔断中（供调用方/工具报"暂时不可用"而不去等超时）。 */
export function breakerOpen(binDir) {
  const b = breakerState.get(String(binDir || DEFAULT_BIN_DIR));
  return !!(b && b.until > Date.now());
}

/**
 * 超分是否可用——轻量探测，只查"二进制在 + 至少一个模型在"。
 *
 * **不实际执行进程**：执行一次要 1~5 秒，放在每张图的路径上是灾难。
 * 真正的运行期故障由熔断器兜住（见 recordOutcome）。
 *
 * @returns {{ok:boolean, reason?:string, bin?:string, model?:string}}
 */
export function probeUpscale(opts = {}) {
  const binDir = String(opts.binDir || DEFAULT_BIN_DIR);
  const hit = availCache.get(binDir);
  if (hit && Date.now() - hit.at < AVAIL_TTL_MS) return hit.result;

  const bin = findUpscaylBin(opts);
  let result;
  if (!bin) {
    result = { ok: false, reason: 'no-upscayl-bin' };
  } else {
    const model = pickModel(opts.model, opts);
    result = model
      ? { ok: true, bin, model }
      : { ok: false, reason: 'no-model' };
  }
  availCache.set(binDir, { at: Date.now(), result });
  return result;
}

/** 记录一次调用结果，驱动熔断器。 */
function recordOutcome(binDir, ok, error) {
  const b = breakerFor(binDir);
  if (ok) {
    b.failures = 0;
    b.until = 0;
    b.lastError = '';
    return;
  }
  b.failures += 1;
  b.lastError = String(error || '').slice(0, 200);
  if (b.failures >= BREAKER_THRESHOLD) {
    b.until = Date.now() + BREAKER_MS;
  }
}

/** 熔断状态描述（给日志/工具提示用）。 */
export function upscaleStatus(opts = {}) {
  const binDir = String(opts.binDir || DEFAULT_BIN_DIR);
  const probe = probeUpscale(opts);
  const b = breakerState.get(binDir);
  return {
    available: probe.ok,
    reason: probe.reason,
    bin: probe.bin,
    model: probe.model,
    breaker: b && b.until > Date.now() ? { until: b.until, lastError: b.lastError } : null
  };
}

/** 目录里真实存在的模型名（供工具报"可选模型"时只说真有的）。 */
export function listModels(opts = {}) {
  const modelDir = String(opts.modelDir || DEFAULT_MODEL_DIR);
  const out = [];
  try {
    for (const f of fs.readdirSync(modelDir)) {
      if (!f.endsWith('.bin')) continue;
      out.push(f.slice(0, -4));
    }
  } catch {}
  return out.sort();
}

/** 选一个实际存在的模型：优先请求值，其次默认，最后目录里第一个。 */
export function pickModel(requested, opts = {}) {
  const available = listModels(opts);
  if (!available.length) return null;
  const want = String(requested || '').trim();
  if (want && available.includes(want)) return want;
  if (available.includes('upscayl-standard-4x')) return 'upscayl-standard-4x';
  if (available.includes('upscayl-lite-4x')) return 'upscayl-lite-4x';
  return available[0];
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      // windowsHide：Upscayl 的二进制会开控制台窗口，隐藏避免闪黑框
      child = spawn(bin, args, { windowsHide: true });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) });
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => out.push(d));
    child.stderr?.on('data', (d) => err.push(d));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8').slice(-1200)
      });
    });
  });
}

/**
 * 用 Real-ESRGAN 放大一张静态图。
 *
 * @param {Buffer} buffer 图片字节
 * @param {object} opts
 *   - mimeType: 输入格式（决定临时文件后缀，png/jpeg/webp）
 *   - model: 模型名（见 MODEL_GUIDE），不存在会自动回退
 *   - targetWidth: 目标宽度（默认按 4x 但不超过 MAX_OUTPUT_WIDTH）
 *   - binDir / modelDir: 覆盖安装路径
 *   - timeoutMs
 *   - log: 日志函数
 * @returns {Promise<{buffer:Buffer, mimeType:string, upscaled:boolean, reason?:string, from?:string, to?:string, model?:string, ms?:number}>}
 *   任何失败都返回 upscaled:false（**不抛异常**）：超分是增强，调用方应据此回退到 lanczos。
 */
export async function upscaleImage(buffer, opts = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const mimeType = String(opts.mimeType || 'image/png');
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;

  const fail = (reason) => ({ buffer: buf, mimeType, upscaled: false, reason });
  if (!buf.length) return fail('empty');

  // 动图不超分：会丢帧语义（调用方应先抽帧）
  const head = buf.subarray(0, 12);
  if (head.toString('ascii', 0, 6) === 'GIF87a' || head.toString('ascii', 0, 6) === 'GIF89a') {
    return fail('animated-gif');
  }

  const dims = imageSizeOf(buf);
  if (!dims || !dims.width || !dims.height) return fail('unknown-size');
  const longEdge = Math.max(dims.width, dims.height);
  // 只放大"太小到看不清"的图；已经够清楚的图放大是白烧算力、还改变原信息。
  const minEdge = Number(opts.minEdge) || MIN_EDGE_TO_UPSCALE;
  if (longEdge >= minEdge && !opts.force) return fail('big-enough');
  if (longEdge > MAX_INPUT_EDGE) return fail(`input-too-large:${longEdge}`);

  // 插件可用性：不可用/熔断中就直接返回，**连进程都不起**。
  // 这是"没有 Upscayl 不影响桥接"的关键路径：调用方拿到 upscaled:false 后走 lanczos。
  const binDir = String(opts.binDir || DEFAULT_BIN_DIR);
  if (breakerOpen(binDir)) {
    return fail('breaker-open');
  }
  const probe = probeUpscale(opts);
  if (!probe.ok) return fail(probe.reason);

  const bin = probe.bin;
  const model = pickModel(opts.model, opts);
  if (!model) return fail('no-model');

  const modelDir = String(opts.modelDir || DEFAULT_MODEL_DIR);

  // 目标宽度：按 4x 推算，但不超过模型有效输入边长；至少要比原图大才值得做
  const want = Number(opts.targetWidth);
  const targetWidth = Number.isFinite(want) && want > 0
    ? Math.min(MAX_OUTPUT_WIDTH, Math.round(want))
    : Math.min(MAX_OUTPUT_WIDTH, dims.width * 4);
  if (targetWidth <= dims.width) return fail('already-large-enough');

  // ── 缓存查询 ──
  // 命中直接返回，省掉整段 GPU 计算。键包含原图内容 + 模型 + 目标宽度：
  // 换模型或换宽度会产生不同的正确结果，不能只按图片哈希。
  const cacheEnabled = opts.cache !== false;
  const key = cacheEnabled && cacheRoot ? cacheKey(buf, model, targetWidth) : '';
  if (key) {
    const hit = readCache(key);
    if (hit) {
      const hitDims = imageSizeOf(hit) || { width: 0, height: 0 };
      log(`[超分] 缓存命中 ${model} ${dims.width}x${dims.height} → ${hitDims.width}x${hitDims.height}（省去一次计算）`);
      return {
        buffer: hit,
        mimeType: 'image/png',
        upscaled: true,
        cached: true,
        model,
        ms: 0,
        from: `${dims.width}x${dims.height}`,
        to: `${hitDims.width}x${hitDims.height}`
      };
    }
  }

  const tag = crypto.randomBytes(6).toString('hex');
  const extIn = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
  const inFile = path.join(os.tmpdir(), `qq-up-${tag}.${extIn}`);
  const outFile = path.join(os.tmpdir(), `qq-up-${tag}-x.png`);
  const t0 = Date.now();
  try {
    fs.writeFileSync(inFile, buf);
    // -w 指定输出宽度（高度按比例），比 -r WxH 更适合"长边可控"的需求：
    // 传 -r 时必须同时给出宽高，对竖图会把比例拉坏。
    const r = await run(bin, [
      '-i', inFile,
      '-o', outFile,
      '-m', modelDir,
      '-n', model,
      '-f', 'png',
      '-w', String(targetWidth)
    ], timeoutMs);
    if (!r.ok) {
      const detail = String(r.error || r.stderr || `exit ${r.code}`).slice(0, 160);
      // 记录失败驱动熔断：连续失败后停用它，避免每张图都先等一次超时
      recordOutcome(binDir, false, detail);
      if (breakerOpen(binDir)) {
        log(`[超分] 连续失败，已熔断 ${Math.round(BREAKER_MS / 60000)} 分钟（期间直接走 lanczos）：${detail.slice(0, 80)}`);
      }
      return fail(`upscayl-failed:${detail}`);
    }
    if (!fs.existsSync(outFile)) {
      recordOutcome(binDir, false, 'no-output');
      return fail('no-output');
    }
    const out = fs.readFileSync(outFile);
    if (!out.length) {
      recordOutcome(binDir, false, 'empty-output');
      return fail('empty-output');
    }

    recordOutcome(binDir, true);
    const outDims = imageSizeOf(out) || { width: 0, height: 0 };
    const ms = Date.now() - t0;
    // 写入缓存（失败静默忽略）。放在 log 之前无所谓，但要在 return 之前。
    if (key) writeCache(key, out);
    log(`[超分] ${model} ${dims.width}x${dims.height} → ${outDims.width}x${outDims.height}（${(buf.length / 1024).toFixed(0)}KB → ${(out.length / 1024).toFixed(0)}KB，${ms}ms）`);
    return {
      buffer: out,
      mimeType: 'image/png',
      upscaled: true,
      model,
      ms,
      from: `${dims.width}x${dims.height}`,
      to: `${outDims.width}x${outDims.height}`
    };
  } catch (error) {
    const detail = String(error?.message ?? error).slice(0, 160);
    recordOutcome(binDir, false, detail);
    return fail(`error:${detail}`);
  } finally {
    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

/**
 * 把超分结果压到能发出去的大小。
 *
 * 什么时候调用：**只在超过阈值时**（2026-10-19 用户要求「尽量不压缩，除非超过阈值」）。
 * 阈值由调用方给（`mcp-snowluma-safe.js` 里是 1.3MB），依据是实测 OneBot 的 base64
 * 上限约 2MB（1.93MB 成功 / 2.04MB 起 ECONNRESET）。
 *
 * 策略：**优先保分辨率，其次保质量**——超分的意义就是细节。
 * 先只降 JPEG 质量（q:v 3 → 6 → 10），实在压不下来才缩长边。
 * 实测 2MB 的 PNG → q:v=3 的 JPEG 只有 174KB。
 *
 * @param {Buffer} buffer 超分输出的 PNG
 * @param {number} maxBytes 目标上限（**原始字节**，不是 base64 后）
 * @returns {Promise<Buffer|null>} 成功返回更小的 JPEG；失败/压不下去返回 null
 */
export async function shrinkForPublish(buffer, maxBytes = 1.3 * 1024 * 1024) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (!buf.length) return null;
  if (buf.length <= maxBytes) return buf;

  const ffmpeg = findFfmpegSafe();
  if (!ffmpeg) return null;

  const tag = crypto.randomBytes(6).toString('hex');
  const inFile = path.join(os.tmpdir(), `qq-pub-${tag}.png`);
  const outFile = path.join(os.tmpdir(), `qq-pub-${tag}.jpg`);
  try {
    fs.writeFileSync(inFile, buf);
    // 先只调质量：优先级是"保住分辨率 > 保住质量"——超分的意义就是细节，
    // 所以先 q:v=3（接近无损观感），不行再降。
    for (const q of [3, 6, 10]) {
      const r = await run(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', inFile,
        '-q:v', String(q),
        '-frames:v', '1',
        outFile
      ], 20000);
      if (!r.ok || !fs.existsSync(outFile)) continue;
      const out = fs.readFileSync(outFile);
      if (out.length && out.length <= maxBytes) return out;
    }

    // 还超：才降分辨率（最长边依次缩到 1200 / 900）。
    // 正常情况下走不到这里（真实超分图 800×652 转 JPEG 只有 ~150KB），
    // 只有极端噪点/纯随机内容才会。降尺寸仍比发不出去好。
    const dims = imageSizeOf(buf);
    if (dims?.width) {
      for (const edge of [1200, 900]) {
        if (Math.max(dims.width, dims.height) <= edge) continue;
        const r = await run(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', inFile,
          '-vf', `scale=${edge}:${edge}:force_original_aspect_ratio=decrease`,
          '-q:v', '6',
          '-frames:v', '1',
          outFile
        ], 20000);
        if (!r.ok || !fs.existsSync(outFile)) continue;
        const out = fs.readFileSync(outFile);
        if (out.length && out.length <= maxBytes) return out;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

/** ffmpeg 定位：复用 gif-frames.js 的实现（PATH + 常见安装位置，已带缓存）。 */
function findFfmpegSafe() {
  try {
    return findFfmpeg();
  } catch {
    return null;
  }
}
