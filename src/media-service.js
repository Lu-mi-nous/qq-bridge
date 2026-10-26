// 入站媒体服务（R3-10）：图片/表情取字节、GIF 抽帧、图片预处理。
import fs from 'node:fs';
import path from 'node:path';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';
import { prepareImageForModel } from './image-downscale.js';
import { tileGifFrames, isGifBuffer, gifFramesHint } from './gif-frames.js';

export function createMediaService({
  cfg,
  bot,
  log = () => {},
  MAX_MEDIA_COUNT = 5,
  MAX_MEDIA_BYTES = 8 * 1024 * 1024,
  MAX_MEDIA_PIXELS = 64_000_000
} = {}) {
  if (!cfg) throw new Error('createMediaService: cfg 不能为空');
  if (!bot) throw new Error('createMediaService: bot 不能为空');

  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 静态图 / 动图抽帧拼图：多模态模型对 GIF 只能看到第一帧（实测），
  // 所以这里把多帧动图抽成关键帧横向拼成静态图再送出，让模型能顺着看出动作序列。
  // 开关与参数见 config.socialV2.gifFrames；失败一律退回原图（增强不该破坏链路）。
  async function maybeTileAnimatedGif(buf, mimeType) {
    const gc = cfg.socialV2?.gifFrames ?? {};
    if (gc.enabled === false) return null;
    if (!isGifBuffer(buf)) return null;
    // mimeType 声明为 gif 才处理；PNG/JPEG 永远不会走到这里。
    if (mimeType && mimeType !== 'image/gif') return null;
    try {
      const tiled = await tileGifFrames(buf, {
        maxFrames: gc.maxFrames,
        tileWidth: gc.tileWidth,
        timeoutMs: gc.timeoutMs
      });
      if (!tiled) return null;
      log(`动图抽帧拼图：${tiled.frames} 帧取 ${tiled.kept} 帧，${Math.round(buf.length / 1024)}KB -> ${Math.round(tiled.buffer.length / 1024)}KB`);
      return tiled;
    } catch (error) {
      log(`动图抽帧失败（退回原图）: ${error?.message ?? error}`);
      return null;
    }
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  // 单条消息图片总字节上限。这是桥接自己的保守值（非 QQ/上游的硬性要求），
  // 可通过 config.socialV2.media.maxMessageBytes 调整；默认 8MB。
  // 注：调大后走的是内存内联与上游请求体，注意与网关 server.max_body_mb 的关系。

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  async function fetchOneBotImage(media) {
    // 优先使用 OneBot get_image 获取网关侧信息；只有 file 是安全缓存文件名时才允许交给网关。
    if (media.kind === 'image' && media.file && isProbablySafeImageFileRef(media.file)) {
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const buf = Buffer.from(base64, 'base64');
            if (buf.length > 0 && looksLikeImageBuffer(buf)) {
              const dims = getImageDimensions(buf);
              if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
                log(`get_image 返回的图片像素超限，已跳过（${dims.width}x${dims.height}）`);
              } else {
                return { buffer: buf, mimeType: mimeFromBuffer(buf) };
              }
            }
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
          const dims = getImageDimensions(fetched.buffer);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            log(`get_image URL 图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else {
            return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(obj.url) };
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const buf = fs.readFileSync(obj.file);
            const dims = getImageDimensions(buf);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`本地图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: buf, mimeType: mimeFromBuffer(buf) };
            }
          }
        }
      } catch (error) {
        log(`get_image 解析失败: ${error?.message ?? error}`);
      }
    }
    // 其次直接用消息段里的 URL
    if (media.url) {
      try {
        // 原图可能很大（群友常发几 MB 的动图/超高清壁纸）。这里**不能用"超限就丢弃"**：
        // 实测（2026-10-22）群友发了 >8MB 的图，safeFetchBuffer 直接 reject，本函数返回 null，
        // 模型完全没看到图，只能回「图没加载出来，你再发一次」——而再发一次还是同一张，
        // 永远加载不出来。
        //
        // 上限放宽到 4 倍（32MB），先尽量把整张图拿到：完整图才能被 ffmpeg 正常重编码压缩。
        // 实测截断的 PNG 会让 ffmpeg 报 `chunk too big` 而缩图失败，最后原样把半张灰图给模型
        // ——比完全看不到强，但明显不如拿到整张再压。
        // 所以 partialOnOversize 只是**最后兜底**：连 32MB 都超了，也至少给个能看的前缀。
        const HARD_CAP = Math.max(MAX_MEDIA_BYTES * 4, MAX_MEDIA_BYTES + 1024 * 1024);
        const fetched = await safeFetchBuffer(String(media.url), HARD_CAP, { partialOnOversize: true });
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
          log(`图片 URL 像素超限，已跳过（${dims.width}x${dims.height}）`);
        } else {
          const prepared = await prepareImageForModel(fetched.buffer, {
            mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(media.url),
            log,
            upscale: cfg.socialV2?.upscale
          });
          if (fetched.truncated) {
            // 截断的图可能只解码出上半部分（ffmpeg 会拒绝重编码），模型看到的是残缺画面。
            // 这里明确记日志，便于排查"机器人看图看得不准"这类反馈。
            log(`图片超限（收到 ${Math.round(fetched.receivedBytes / 1024)}KB，未取全），已尽力压缩后交给模型（${Math.round(prepared.buffer.length / 1024)}KB）——画面可能不完整`);
          }
          return { buffer: prepared.buffer, mimeType: prepared.mimeType };
        }
      } catch (error) {
        log(`图片 URL 抓取失败: ${error?.message ?? error}`);
      }
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    if (!Number.isInteger(faceId)) return { text: `[表情#${media.faceId}]` };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`表情图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
            }
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : `[表情#${media.faceId}]` };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: `[表情#${media.faceId}]` };
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += face.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          parts.push({ type: 'image', mediaType: face.mimeType || 'image/png', data: face.buffer.toString('base64'), name: `face-${media.faceId}.${(face.mimeType || 'png').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          // 动图抽帧拼图：模型看 GIF 只有第一帧，拼图后才能看出动作序列。
          const tiled = await maybeTileAnimatedGif(img.buffer, img.mimeType);
          if (tiled) {
            if (totalBytes + tiled.buffer.length > MAX_MEDIA_BYTES) {
              parts.push({ type: 'text', text: `[动图${index}（抽帧后超出大小上限，已跳过）]` });
              continue;
            }
            totalBytes += tiled.buffer.length;
            parts.push({ type: 'text', text: gifFramesHint(index, tiled) });
            // mimeType 用拼图返回的实际格式：大拼图会被转成 JPEG 控体积（见 gif-frames.js），
            // 这里写死 png 会让下游按 PNG 解析 JPEG 字节。
            const tiledExt = (tiled.mimeType || 'image/png').split('/')[1];
            parts.push({ type: 'image', mediaType: tiled.mimeType || 'image/png', data: tiled.buffer.toString('base64'), name: `qq-gif-${index}-tiled.${tiledExt}` });
            continue;
          }
          // 大图先降采样再交给模型（见 image-downscale.js）：
          // 手机拍的原图 base64 后可达 4.7MB，会让 DSH 侧处理时爆栈
          // （实测报 "Maximum call stack size exceeded" → 模型只看到"图片不可用"）。
          // 放在大小检查**之前**：先缩再看大小，避免把能救回来的图直接判超限跳过。
          // 统一预处理：先缩大图（防 base64 过大让 DSH 爆栈），再放大小图
          // （305×92 这类截图文字不足 1 个 patch 高，模型读不出）。见 image-downscale.js。
          const scaled = await prepareImageForModel(img.buffer, { mimeType: img.mimeType, upscale: cfg.socialV2?.upscale, log: (m) => log(m) });
          const useBuf = scaled.buffer;
          const useMime = scaled.mimeType || img.mimeType || 'image/jpeg';
          if (totalBytes + useBuf.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[图片${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += useBuf.length;
          parts.push({ type: 'text', text: `[图片${index}]` });
          parts.push({ type: 'image', mediaType: useMime, data: useBuf.toString('base64'), name: `qq-image-${index}.${useMime.split('/')[1] || 'jpeg'}` });
        } else {
          parts.push({ type: 'text', text: `[图片${index}（获取失败）]` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList, opts = {}) {
    // raw=true：跳过所有预处理（超分/缩放/抽帧），把原图原样返回。
    // 用途：qq_upscale_image 需要**原始像素**才能超分——若先被 lanczos 放大到 1220px，
    // 超分工具看到的已是插值后的糊图，再超分既无收益也失真（实测 200×163 被预处理成 1220×994，
    // 于是工具报"原图已经很大"）。缩放/抽帧是为"直接给模型看"服务的，超分要自己走一遍。
    const raw = opts.raw === true;
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : 'image', text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += face.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: face.mimeType || 'image/png',
            data: face.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          if (raw) {
            // 原图直出（给超分工具用）：不抽帧、不缩放，保留真实像素与格式。
            // 体积仍受 MAX_MEDIA_BYTES 约束（与其它路径一致，避免超大图把本地端点撑爆）。
            if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
              out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（原图超出大小上限，已跳过）' });
              continue;
            }
            totalBytes += img.buffer.length;
            out.push({
              index,
              kind: 'image',
              file: media.file ? String(media.file) : undefined,
              url: media.url ? String(media.url) : undefined,
              mimeType: img.mimeType || 'image/png',
              data: img.buffer.toString('base64'),
              raw: true,
              // 动图也如实标注：超分工具据此拒绝（超分会丢帧语义）
              animated: isGifBuffer(img.buffer),
              text: ''
            });
            continue;
          }
          // 动图抽帧拼图（与 resolveMediaList 同策略）：模型看 GIF 只有第一帧。
          const tiled = await maybeTileAnimatedGif(img.buffer, img.mimeType);
          if (tiled) {
            if (totalBytes + tiled.buffer.length > MAX_MEDIA_BYTES) {
              out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（动图抽帧后超出大小上限，已跳过）' });
              continue;
            }
            totalBytes += tiled.buffer.length;
            out.push({
              index,
              kind: 'image',
              file: media.file ? String(media.file) : undefined,
              url: media.url ? String(media.url) : undefined,
              // mimeType 跟随拼图实际格式（大拼图会转 JPEG 控体积）
              mimeType: tiled.mimeType || 'image/png',
              data: tiled.buffer.toString('base64'),
              animated: true,
              frames: tiled.frames,
              framesKept: tiled.kept,
              // 排布信息必须一起传给 MCP 侧：文案要按实际网格说明阅读顺序
              // （只有 kept 的话，多行拼图会被描述成"从左到右"一行读完，模型会读错时间线）。
              cols: tiled.cols,
              rows: tiled.rows,
              tileWidth: tiled.tileWidth,
              text: ''
            });
            continue;
          }
          // 与 resolveMediaList 同策略：大图先降采样（见 image-downscale.js），
          // 否则 base64 过大时 DSH 侧会爆栈、模型只看到"图片不可用"。
          // 与 resolveMediaList 同一套预处理（缩大图 + 放大小图）——两处必须一致，
          // 否则走 MCP 工具取图时行为不同（这类"两处要同改"的坑踩过多次）。
          const scaled2 = await prepareImageForModel(img.buffer, { mimeType: img.mimeType, upscale: cfg.socialV2?.upscale, log: (m) => log(m) });
          const useBuf2 = scaled2.buffer;
          const useMime2 = scaled2.mimeType || img.mimeType || 'image/jpeg';
          if (totalBytes + useBuf2.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += useBuf2.length;
          out.push({
            index,
            kind: 'image',
            file: media.file ? String(media.file) : undefined,
            url: media.url ? String(media.url) : undefined,
            mimeType: useMime2,
            data: useBuf2.toString('base64'),
            text: ''
          });
        } else {
          out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片获取失败）' });
        }
      }
    }
    return out;
  }

  return {
    mimeFromBuffer,
    mimeFromUrl,
    getImageDimensions,
    fetchOneBotImage,
    fetchFaceMedia,
    resolveMediaList,
    fetchMediaData,
    maybeTileAnimatedGif
  };
}
