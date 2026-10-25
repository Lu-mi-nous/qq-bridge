// 传给模型前把过大的图片降采样。
//
// 背景（2026-10-15 实测）：
// 群友引用一张手机拍的图（3072×4080、3.5MB），机器人回「这张图我这边加载失败」。
// 查转录发现：模型**正确调用了** qq_get_message_images，图**也取到了**，但结果是
//   [image unavailable: image/jpeg; Maximum call stack size exceeded;
//    raw image data remains available to programmatic callers]
// 即 DSH/模型侧处理这个 **4.75MB 的 base64 字符串**时爆栈，模型只看到"图片不可用"。
//
// 桥接原有的两道限制都没拦住它：
//   - MAX_MEDIA_BYTES = 8MB（按**原始字节**算，3.5MB 没超）
//   - MAX_MEDIA_PIXELS = 64M（12.5M 像素也没超）
// 缺的是第三道：**交给模型的那份 base64 有多大**。原始字节合格不代表 base64 后合格
// （膨胀约 33%），更不代表下游能处理这个长度的字符串。
//
// 做法：只对超阈值的大图用 ffmpeg 缩到长边 MAX_EDGE，再重编码为 JPEG。
// 不动小图（多数图都小，无谓重编码会掉画质也费时）。
//
// 为什么用 ffmpeg 而不是引入 sharp/jimp：项目已经依赖 ffmpeg（gif-frames.js 在用），
// 不新增依赖；且它处理各种畸形 JPEG 比纯 JS 库稳。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { findFfmpeg } from './gif-frames.js';

/** 长边上限。1568 是主流视觉模型的有效输入边长（再大也会被内部缩放），够看清细节。 */
export const MAX_EDGE = 1568;

/** 触发降采样的原始字节阈值。低于此值直接原样传（避免无谓重编码掉画质）。 */
export const DOWNSCALE_THRESHOLD_BYTES = 1.5 * 1024 * 1024;

/** 降采样后的目标质量。视觉模型不需要原图质量，80 足够且体积降得明显。 */
const JPEG_QUALITY = 82;

/**
 * 「小图放大」的触发长边阈值。
 *
 * 为什么需要（2026-10-16 用户反馈「我发的这个图很清晰，是不是处理前降画质了」）：
 * 实测那张图**原始就只有 305×92**（QQ 本地 `Ori` 原图目录里也是同一份 6790 字节），
 * 既没被 QQ 压、也没被桥接缩——但模型读不出，因为视觉模型把图切成约 14px 的 patch，
 * 305×92 里每行文字只占约 1 个 patch 高，笔画细节落不进 patch。
 *
 * 修法与缩图相反：**把小图放大**（ffmpeg lanczos），让文字高达到 2~3 个 patch。
 * 实测 305×92 → 1220×368 后字迹清晰可读。
 * 阈值取 400：低于此长边的图基本是截图/图标类，放大收益明显；正常照片不会被误放大。
 */
export const MIN_EDGE = 400;

/** 小图放大的目标长边（与 MAX_EDGE 同一量级：模型的"舒适区"）。 */
export const UPSCALE_TARGET_EDGE = 1220;

/**
 * 轻量读图尺寸（只看文件头，不解码）。
 * 只需支持模型最常遇到的三种：PNG / JPEG / GIF——够判断"是不是小图"。
 * 读不出时返回 null，调用方按"不动它"处理（不做无依据的猜测）。
 */
export function imageSizeOf(buf) {
  if (!buf || buf.length < 24) return null;
  try {
    // PNG：IHDR 宽高在固定偏移
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF：小端 16 位
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // JPEG：逐段找 SOF（0xC0-0xCF，排除 C4/C8/CC）
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        const len = buf.readUInt16BE(i + 2);
        if (len <= 0) break;
        i += 2 + len;
      }
    }
  } catch { /* 头损坏：当作未知 */ }
  return null;
}

function runFfmpeg(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { windowsHide: true }); } catch (e) {
      resolve({ ok: false, error: String(e?.message ?? e) }); return;
    }
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    child.stderr?.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: false, error: String(e?.message ?? e) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: Buffer.concat(err).toString('utf8').slice(-400) });
    });
  });
}

/**
 * 超过阈值就把图片缩到长边 <= MAX_EDGE 并重编码为 JPEG。
 *
 * @param {Buffer} buffer 原始图片字节
 * @param {{mimeType?:string, maxEdge?:number, thresholdBytes?:number, timeoutMs?:number, log?:Function}} opts
 * @returns {Promise<{buffer:Buffer, mimeType:string, downscaled:boolean, reason?:string, from?:string, to?:string}>}
 *   任何一步失败都**原样返回原图** —— 缩图是优化，不能因为缩图失败让用户看不到图；
 *   真出问题也只是回到"可能爆栈"的现状，不会比现在更差。
 */
export async function downscaleIfLarge(buffer, opts = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const mimeType = String(opts.mimeType || 'image/jpeg');
  const maxEdge = Number(opts.maxEdge) || MAX_EDGE;
  const threshold = Number(opts.thresholdBytes) || DOWNSCALE_THRESHOLD_BYTES;
  const timeoutMs = Number(opts.timeoutMs) || 20000;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  const passthrough = (reason) => ({ buffer: buf, mimeType, downscaled: false, reason });
  if (!buf.length) return passthrough('empty');
  if (buf.length < threshold) return passthrough('below-threshold');

  // 动图不能这样缩（会丢帧语义）——缩图只针对静态图，GIF/WebP 交给既有的抽帧逻辑
  const head = buf.subarray(0, 12);
  if (head.toString('ascii', 0, 6) === 'GIF87a' || head.toString('ascii', 0, 6) === 'GIF89a') {
    return passthrough('animated-gif');
  }

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return passthrough('no-ffmpeg');

  const tag = crypto.randomBytes(6).toString('hex');
  const inFile = path.join(os.tmpdir(), `qq-ds-${tag}.img`);
  const outFile = path.join(os.tmpdir(), `qq-ds-${tag}.jpg`);
  try {
    fs.writeFileSync(inFile, buf);
    // scale: 长边缩到 maxEdge，短边按比例；-1 让 ffmpeg 自己算且保证偶数
    // force_original_aspect_ratio=decrease + 不加 pad：保持比例、不裁切、不放大
    const vf = `scale=${maxEdge}:${maxEdge}:force_original_aspect_ratio=decrease`;
    const r = await runFfmpeg(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inFile,
      '-vf', vf,
      '-q:v', String(Math.round((100 - JPEG_QUALITY) / 100 * 31) || 5),  // ffmpeg 的 q:v 是"越小越好"的反向刻度
      '-frames:v', '1',
      outFile,
    ], timeoutMs);
    if (!r.ok) return passthrough(`ffmpeg-failed:${String(r.error).slice(0, 80)}`);
    if (!fs.existsSync(outFile)) return passthrough('no-output');
    const out = fs.readFileSync(outFile);
    // 缩小了才有意义；如果反而更大（极少见，如原图已是高质量小图），保留原图
    if (!out.length || out.length >= buf.length) return passthrough('not-smaller');
    log(`[缩图] ${(buf.length / 1024).toFixed(0)}KB → ${(out.length / 1024).toFixed(0)}KB（长边≤${maxEdge}）`);
    return {
      buffer: out,
      mimeType: 'image/jpeg',
      downscaled: true,
      from: `${(buf.length / 1024).toFixed(0)}KB`,
      to: `${(out.length / 1024).toFixed(0)}KB`
    };
  } catch (error) {
    return passthrough(`error:${String(error?.message ?? error).slice(0, 80)}`);
  } finally {
    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

/**
 * 过小的图放大——与 downscaleIfLarge 相反的操作，解决"图很清晰但模型读不出"。
 *
 * 背景：实测一张 305×92 的聊天截图（QQ 本地 `Ori` 原图目录里也是同一份 6790 字节），
 * 用户认为"很清晰"（人眼放大能读），但模型回"糊得跟天书一样，字都黏在一起"。
 * 原因：视觉模型把图切成约 14px 的 patch，305×92 里文字只有约 12px 高（≈1 patch），
 * 笔画细节落不进 patch —— 这是**分辨率不足**，不是画质压缩。
 *
 * 做法：长边 < MIN_EDGE 时用 ffmpeg 的 lanczos 放大到 UPSCALE_TARGET_EDGE。
 * 实测 305×92 → 1220×368 后字迹清晰可读。
 *
 * 与缩图的取舍一致：失败就**原样返回**——放不大也比传不出去/传错好。
 *
 * @returns {Promise<{buffer:Buffer, mimeType:string, upscaled:boolean, reason?:string, from?:string, to?:string}>}
 */
export async function upscaleIfSmall(buffer, opts = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const mimeType = String(opts.mimeType || 'image/png');
  const minEdge = Number(opts.minEdge) || MIN_EDGE;
  const targetEdge = Number(opts.targetEdge) || UPSCALE_TARGET_EDGE;
  const timeoutMs = Number(opts.timeoutMs) || 20000;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  const passthrough = (reason) => ({ buffer: buf, mimeType, upscaled: false, reason });
  if (!buf.length) return passthrough('empty');

  // 动图不放大（会丢帧语义，且放大后体积暴涨）——交给既有抽帧逻辑
  const head = buf.subarray(0, 12);
  if (head.toString('ascii', 0, 6) === 'GIF87a' || head.toString('ascii', 0, 6) === 'GIF89a') {
    return passthrough('animated-gif');
  }

  const dims = imageSizeOf(buf);
  if (!dims || !dims.width || !dims.height) return passthrough('unknown-size');
  const longEdge = Math.max(dims.width, dims.height);
  if (longEdge >= minEdge) return passthrough('big-enough');

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return passthrough('no-ffmpeg');

  // 按比例放大到目标长边，且限制倍数上限（放大 10 倍只会让文件变大、字不会更清）
  const scale = Math.min(targetEdge / longEdge, 8);
  const targetW = Math.max(1, Math.round(dims.width * scale));
  const targetH = Math.max(1, Math.round(dims.height * scale));

  const tag = crypto.randomBytes(6).toString('hex');
  const inFile = path.join(os.tmpdir(), `qq-up-${tag}.img`);
  const outFile = path.join(os.tmpdir(), `qq-up-${tag}.png`);
  try {
    fs.writeFileSync(inFile, buf);
    // flags=lanczos：平滑插值，实测比 neighbor 更利于模型识读中文
    const r = await runFfmpeg(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inFile,
      '-vf', `scale=${targetW}:${targetH}:flags=lanczos`,
      '-frames:v', '1',
      outFile,
    ], timeoutMs);
    if (!r.ok) return passthrough(`ffmpeg-failed:${String(r.error).slice(0, 80)}`);
    if (!fs.existsSync(outFile)) return passthrough('no-output');
    const out = fs.readFileSync(outFile);
    if (!out.length) return passthrough('empty-output');
    log(`[放大] ${dims.width}x${dims.height} (${(buf.length / 1024).toFixed(0)}KB) → ${targetW}x${targetH} (${(out.length / 1024).toFixed(0)}KB)`);
    return {
      buffer: out,
      mimeType: 'image/png',
      upscaled: true,
      from: `${dims.width}x${dims.height}`,
      to: `${targetW}x${targetH}`
    };
  } catch (error) {
    return passthrough(`error:${String(error?.message ?? error).slice(0, 80)}`);
  } finally {
    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

/**
 * 交给模型前的统一图像预处理：**先缩大图，再放大小图**。
 *
 * 为什么合并成一个函数：桥接有**两处**把图片交给模型的路径
 * （`resolveMediaList` 与 `fetchMediaData`，后者是 MCP 工具用的），
 * 上一轮加缩图时就必须同时改两处——分开写容易漏（那次踩过）。
 *
 * 顺序有讲究：
 *   ① 先缩：大图 base64 过大会让 DSH 爆栈（"Maximum call stack size exceeded"），
 *      这是**崩溃级**问题，必须先解决。
 *   ② 再放：小图（如 305×92 的聊天截图）文字不足 1 个 patch 高，模型读不出。
 *      两个条件互斥（字节大 vs 边长小），串联不会互相干扰。
 *
 * 任一步失败都继续往下走（各自内部已保证失败返回原图）。
 *
 * 放大这一步**优先走 Real-ESRGAN 超分**（upscale.js，调用本机 Upscayl），失败才退回 lanczos。
 * 为什么（2026-10-19）：lanczos 是插值，笔画边缘仍然虚；Real-ESRGAN 是生成式，
 * 实测同一张 180×90 文字截图，lanczos 版细笔画粘连，超分版边缘锐利、接近原生可读。
 * 超分慢（约 1~3 秒/张）但只在小图上触发，且失败会静默回退——不会让链路变差。
 * 用动态 import 而不是顶部静态 import：upscale.js 需要本模块的 imageSizeOf，
 * 静态互相引会形成循环依赖（ESM 能跑但初始化顺序脆弱）。
 */
/**
 * 已经提示过的"超分不可用"原因（避免每条消息刷屏）。
 * 只记原因、不记次数：探测结果本身有 60s 缓存，这里只是让日志干净。
 */
const probeWarned = new Set();

export async function prepareImageForModel(buffer, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  let cur = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  let mimeType = String(opts.mimeType || 'image/jpeg');
  const notes = [];

  const shrunk = await downscaleIfLarge(cur, { ...opts, mimeType, log });
  if (shrunk.downscaled) {
    cur = shrunk.buffer;
    mimeType = shrunk.mimeType;
    notes.push('downscaled');
  }

  // ① 先试超分（可配置关闭：socialV2.upscale.enabled=false）
  //
  // 这一步是**可插拔的**：本机没装 Upscayl、或它运行不正常，都必须让桥接像没这功能一样工作。
  // 三层保护（2026-10-19 用户要求）：
  //   a) 先做轻量探测（只 stat 文件），不可用就一次都不起进程；
  //   b) 运行期有熔断（upscale.js），连续失败后停用一段时间，避免每张图先等一次超时；
  //   c) 无论哪种失败都只是"跳过"，紧接着走 lanczos —— 缩图/出图链路不受影响。
  if (opts.upscale !== false && opts.upscale?.enabled !== false) {
    try {
      const { upscaleImage, probeUpscale } = await import('./upscale.js');
      const uc = (opts.upscale && typeof opts.upscale === 'object') ? opts.upscale : {};
      const probe = probeUpscale({ binDir: uc.binDir, modelDir: uc.modelDir, model: uc.model });
      if (!probe.ok) {
        // 只在第一次说一句，避免每条消息刷屏（探测结果本身有 60s 缓存）
        if (!probeWarned.has(probe.reason)) {
          probeWarned.add(probe.reason);
          log(`[超分] 未启用（${probe.reason}），小图放大走 lanczos —— 这不影响出图`);
        }
      } else {
        const up = await upscaleImage(cur, {
          ...opts,
          mimeType,
          model: uc.model,
          binDir: uc.binDir,
          modelDir: uc.modelDir,
          timeoutMs: uc.timeoutMs,
          log
        });
        if (up.upscaled) {
          cur = up.buffer;
          mimeType = up.mimeType;
          notes.push('super-resolved');
          return { buffer: cur, mimeType, changed: true, notes };
        }
        if (up.reason && up.reason !== 'big-enough' && up.reason !== 'already-large-enough' && up.reason !== 'empty') {
          log(`[超分] 本次跳过（${up.reason}），回退 lanczos`);
        }
      }
    } catch (error) {
      // 超分模块自身出问题（文件缺失/版本不兼容/语法错误）也只是回退，不影响出图
      log(`[超分] 不可用（${error?.message ?? error}），回退 lanczos`);
    }
  }

  // ② 超分没成（或被关闭）→ lanczos
  const grown = await upscaleIfSmall(cur, { ...opts, mimeType, log });
  if (grown.upscaled) {
    cur = grown.buffer;
    mimeType = grown.mimeType;
    notes.push('upscaled');
  }

  return { buffer: cur, mimeType, changed: notes.length > 0, notes };
}

/**
 * QQ 收藏表情（custom face）上传前的压缩。
 *
 * 背景（2026-10-23 实测）：`add_custom_face` 走 QQ highway HTTP 上传，
 * 单次 body 超过约 4MiB 时 Tencent 侧直接 RST，SnowLuma 只能报
 * `fetch failed`。群友发了一张 5.1MB / 480×270 / 140 帧的 GIF，
 * 模型连续三次收藏都失败，只能回「这张存不下来」。
 *
 * 实测边界：4,028,437 字节成功，4,222,487 失败 → 上限就是 4MiB。
 * 这里按 4MiB 减 256KiB 作为目标，给 highway 帧头留余量。
 *
 * GIF 保留动画：优先降 fps/尺寸/调色板；实在压不下去才退化成首帧静态图
 * （静态图也比「收藏失败」好）。静态图走 JPEG 逐级缩放。
 */
export const STICKER_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const STICKER_UPLOAD_TARGET_BYTES = STICKER_UPLOAD_MAX_BYTES - 256 * 1024;

export async function shrinkStickerForUpload(buffer, opts = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const mimeType = String(opts.mimeType || 'image/gif');
  const maxBytes = Number(opts.maxBytes) || STICKER_UPLOAD_TARGET_BYTES;
  const timeoutMs = Number(opts.timeoutMs) || 15000;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const passthrough = (reason) => ({ buffer: buf, mimeType, shrunk: false, reason });

  if (!buf.length) return passthrough('empty');
  if (buf.length <= maxBytes) return passthrough('within-limit');

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return passthrough('no-ffmpeg');

  const isGif = buf.subarray(0, 6).toString('ascii') === 'GIF87a'
    || buf.subarray(0, 6).toString('ascii') === 'GIF89a';
  const dims = imageSizeOf(buf);
  const srcWidth = dims?.width || 0;
  const tag = crypto.randomBytes(6).toString('hex');
  const inFile = path.join(os.tmpdir(), `qqb-sticker-${tag}.img`);
  try {
    fs.writeFileSync(inFile, buf);

    if (isGif) {
      // 先保动画：降 fps + 缩尺寸 + 减色。多数 5~10MB 的 GIF 第一档就能过。
      const attempts = [
        { width: 480, fps: 12, colors: 128 },
        { width: 400, fps: 10, colors: 96 },
        { width: 340, fps: 8, colors: 64 },
        { width: 280, fps: 6, colors: 48 }
      ];
      for (const a of attempts) {
        const width = srcWidth ? Math.min(a.width, srcWidth) : a.width;
        const outFile = path.join(os.tmpdir(), `qqb-sticker-${tag}-${a.width}-${a.fps}.gif`);
        try {
          const vf = `fps=${a.fps},scale=${width}:-1:flags=lanczos,`
            + `split[s0][s1];[s0]palettegen=max_colors=${a.colors}[p];[s1][p]paletteuse=dither=bayer`;
          const r = await runFfmpeg(ffmpeg, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', inFile, '-vf', vf, '-loop', '0', outFile
          ], timeoutMs);
          if (!r.ok || !fs.existsSync(outFile)) continue;
          const out = fs.readFileSync(outFile);
          if (!out.length) continue;
          if (out.length <= maxBytes) {
            log(`[收藏表情] 压缩 ${(buf.length / 1048576).toFixed(1)}MB → ${(out.length / 1048576).toFixed(1)}MB（GIF ${width}px/${a.fps}fps）`);
            return { buffer: out, mimeType: 'image/gif', shrunk: true, from: buf.length, to: out.length, width, fps: a.fps };
          }
        } finally {
          try { fs.unlinkSync(outFile); } catch {}
        }
      }

      // 兜底：取首帧转静态 JPEG（不再有动画，但至少能收藏）
      const outFile = path.join(os.tmpdir(), `qqb-sticker-${tag}-first.jpg`);
      try {
        const width = srcWidth ? Math.min(480, srcWidth) : 480;
        const r = await runFfmpeg(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', inFile, '-frames:v', '1',
          '-vf', `scale=${width}:-1:flags=lanczos`,
          '-q:v', '4', outFile
        ], timeoutMs);
        if (r.ok && fs.existsSync(outFile)) {
          const out = fs.readFileSync(outFile);
          if (out.length && out.length <= maxBytes) {
            log(`[收藏表情] GIF 压不进 4MB，已转静态首帧 ${(buf.length / 1048576).toFixed(1)}MB → ${(out.length / 1048576).toFixed(1)}MB`);
            return { buffer: out, mimeType: 'image/jpeg', shrunk: true, static: true, from: buf.length, to: out.length };
          }
        }
      } finally {
        try { fs.unlinkSync(outFile); } catch {}
      }
    } else {
      // 静态图：逐级缩到长边 <= 各档，JPEG 质量 82。
      const attempts = [1568, 1200, 900, 700, 500, 320];
      for (const edge of attempts) {
        const width = srcWidth ? Math.min(edge, srcWidth) : edge;
        const outFile = path.join(os.tmpdir(), `qqb-sticker-${tag}-${edge}.jpg`);
        try {
          const r = await runFfmpeg(ffmpeg, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', inFile,
            '-vf', `scale=${width}:-1:flags=lanczos`,
            '-frames:v', '1', '-q:v', '4', outFile
          ], timeoutMs);
          if (!r.ok || !fs.existsSync(outFile)) continue;
          const out = fs.readFileSync(outFile);
          if (!out.length) continue;
          if (out.length <= maxBytes) {
            log(`[收藏表情] 压缩 ${(buf.length / 1048576).toFixed(1)}MB → ${(out.length / 1048576).toFixed(1)}MB（长边≤${width}）`);
            return { buffer: out, mimeType: 'image/jpeg', shrunk: true, from: buf.length, to: out.length, width };
          }
        } finally {
          try { fs.unlinkSync(outFile); } catch {}
        }
      }
    }
    return passthrough('cannot-shrink');
  } catch (error) {
    return passthrough(`error:${String(error?.message ?? error).slice(0, 100)}`);
  } finally {
    try { fs.unlinkSync(inFile); } catch {}
  }
}
