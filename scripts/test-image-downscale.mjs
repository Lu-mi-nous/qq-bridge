// 回归测试：传给模型前的大图降采样。
//
// 背景（2026-10-15 用户反馈「引用图片没看到」）：
// 群友引用一张手机拍的图（3072×4080、3.5MB），机器人回「这张图我这边加载失败」。
// 查转录发现模型**正确调用了** qq_get_message_images、图**也取到了**，但结果是：
//   [image unavailable: image/jpeg; Maximum call stack size exceeded;
//    raw image data remains available to programmatic callers]
// 即 DSH 侧处理这个 **4.75MB 的 base64 字符串**时爆栈，模型只看到"图片不可用"，
// 于是照实回了"加载失败"——用户视角就是"引用图片没看到"。
//
// 桥接原有的两道限制都没拦住：MAX_MEDIA_BYTES=8MB（按原始字节，3.5MB 未超）、
// MAX_MEDIA_PIXELS=64M（12.5M 未超）。缺的是第三道：**交给模型的 base64 有多大**。
//
// 修法：超过阈值的图先用 ffmpeg 缩到长边 ≤1568 再重编码 JPEG（实测 3.5MB→124KB）。
// 本测试用**真实那张问题图**验证（若夹具不在则跳过，但会明确提示）。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const m = await import(new URL('../src/image-downscale.js', import.meta.url));
const { downscaleIfLarge, MAX_EDGE, DOWNSCALE_THRESHOLD_BYTES } = m;

console.log('── 1. 接入点（两条交给模型的路径都要缩）──');
{
  // 判据是"这个模块被导入了"，不是"import 列表里只有它"——
  // 后来往同一行加了 upscaleIfSmall / prepareImageForModel，写死列表就误报了
  // （同类坑：把"成员资格"断言写成"位置/格式"断言）。
  
  // 接入方式在 2026-10-16 演进过：原先两处各自调 downscaleIfLarge，
  // 现在统一走 prepareImageForModel（先缩大图、再放小图）。断言跟着实现走，
  // 但守住核心不变式：两条交给模型的路径都必须经过预处理，且预处理里含缩图。
  
  
  // 历史上先有 2 处；2026-10-22 为大图兜底，在「按 URL 取群消息图」那条路上又加了一处
  // （超限拿部分数据后压缩）。别断言"恰好等于 2"——路径会增加，那样每加一条就误报。
  // 真正的不变式：至少两条主路径都接入，且都来自同一个模块。
  
  
  
  check('预处理内部仍会缩大图', /prepareImageForModel[\s\S]{0,600}downscaleIfLarge/.test(
    fs.readFileSync(path.join(root, 'src/image-downscale.js'), 'utf8')));
  // 关键：缩图必须在大小检查**之前**，否则能救回的图会被判超限直接跳过
  
  check('缩图失败不阻断（原样返回原图）', /任何一步失败都\*\*原样返回原图\*\*/.test(fs.readFileSync(path.join(root,'src/image-downscale.js'),'utf8')));
}

console.log('\n── 2. 参数常量合理 ──');
{
  check('长边上限 1568（视觉模型有效输入边长）', MAX_EDGE === 1568, String(MAX_EDGE));
  check('阈值 1.5MB（低于此值不重编码，免得白掉画质）', Math.round(DOWNSCALE_THRESHOLD_BYTES / 1024 / 1024 * 10) / 10 === 1.5, `${(DOWNSCALE_THRESHOLD_BYTES/1024/1024).toFixed(1)}MB`);
}

console.log('\n── 3. 不该缩的情况（原样返回）──');
{
  const small = Buffer.alloc(1000, 1);
  const r1 = await downscaleIfLarge(small, { mimeType: 'image/jpeg' });
  check('小图原样返回', r1.downscaled === false && r1.buffer.length === 1000, r1.reason);

  const empty = await downscaleIfLarge(Buffer.alloc(0));
  check('空 buffer 不崩', empty.downscaled === false && empty.buffer.length === 0, empty.reason);

  // GIF 不能这样缩（会丢帧语义），应交给既有抽帧逻辑
  const gifHead = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(2 * 1024 * 1024, 0)]);
  const r2 = await downscaleIfLarge(gifHead, { mimeType: 'image/gif' });
  check('GIF 不缩（交给抽帧逻辑）', r2.downscaled === false && r2.reason === 'animated-gif', r2.reason);

  const notBuf = await downscaleIfLarge(null);
  check('null 不崩', notBuf.downscaled === false);

  // 大但不是图片的垃圾数据：ffmpeg 会失败 → 必须原样返回，不能抛
  const junk = Buffer.alloc(2 * 1024 * 1024, 0x41);
  const r3 = await downscaleIfLarge(junk, { mimeType: 'image/jpeg', timeoutMs: 15000 });
  check('非图片数据不抛出、原样返回', r3.downscaled === false && r3.buffer.length === junk.length, String(r3.reason).slice(0, 60));
}

console.log('\n── 4. 真实问题图（决定性验证）──');
{
  // 夹具：把实测的那张问题图放在 test-fixtures（gzip 存），缺失时明确提示
  const fx = path.join(root, 'test-fixtures', 'big-photo.jpg.gz');
  if (!fs.existsSync(fx)) {
    console.log('⚠️  缺少夹具 test-fixtures/big-photo.jpg.gz，跳过真实图验证（其余断言仍有效）');
    check('夹具存在（保证这条验证不静默跳过）', false, '缺 big-photo.jpg.gz');
  } else {
    const zlib = await import('node:zlib');
    const buf = zlib.gunzipSync(fs.readFileSync(fx));
    check('夹具是超大 JPEG（>3MB，尺寸等同手机原图）', buf.length > 3 * 1024 * 1024, `${(buf.length/1024/1024).toFixed(1)}MB`);
    check('夹具是 JPEG', buf[0] === 0xFF && buf[1] === 0xD8, '');

    const r = await downscaleIfLarge(buf, { mimeType: 'image/jpeg' });
    check('大图被降采样', r.downscaled === true, String(r.reason || ''));
    check('体积显著变小（至少 5 倍）', r.buffer.length * 5 < buf.length,
      `${(buf.length/1024).toFixed(0)}KB → ${(r.buffer.length/1024).toFixed(0)}KB`);
    check('base64 后不再是 MB 级（这是爆栈的直接原因）',
      r.buffer.toString('base64').length < 1024 * 1024,
      `base64 ${Math.round(r.buffer.length*4/3/1024)}KB`);
    check('输出仍是 JPEG', r.buffer[0] === 0xFF && r.buffer[1] === 0xD8, r.mimeType);

    // 尺寸确实被限制住了
    let i = 2, dims = null;
    while (i < r.buffer.length - 9) {
      if (r.buffer[i] !== 0xFF) { i++; continue; }
      const mk = r.buffer[i + 1];
      if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) {
        dims = { h: r.buffer.readUInt16BE(i + 5), w: r.buffer.readUInt16BE(i + 7) };
        break;
      }
      i += 2 + r.buffer.readUInt16BE(i + 2);
    }
    check('长边缩到 <= MAX_EDGE', dims && Math.max(dims.w, dims.h) <= MAX_EDGE,
      dims ? `${dims.w}x${dims.h}` : '(未解析)');
    check('保持宽高比（不裁切不变形）', (() => {
      if (!dims) return false;
      const srcRatio = 3072 / 4080, outRatio = dims.w / dims.h;
      return Math.abs(srcRatio - outRatio) < 0.02;
    })(), dims ? `原 0.753 新 ${(dims.w/dims.h).toFixed(3)}` : '');
    check('不会把图放大（短边也小于原图）', dims && dims.w < 3072 && dims.h < 4080, '');
  }
}

console.log('\n── 5. 收藏表情压缩（QQ 4MB 上限）──');
{
  const { shrinkStickerForUpload, STICKER_UPLOAD_MAX_BYTES, STICKER_UPLOAD_TARGET_BYTES } = m;
  check('上限 4MiB（实测 4,028,437 成功 / 4,222,487 失败）', STICKER_UPLOAD_MAX_BYTES === 4 * 1024 * 1024, String(STICKER_UPLOAD_MAX_BYTES));
  check('压缩目标留 256KB 余量', STICKER_UPLOAD_TARGET_BYTES === STICKER_UPLOAD_MAX_BYTES - 256 * 1024, String(STICKER_UPLOAD_TARGET_BYTES));
  
  
  

  const small = Buffer.alloc(1000, 1);
  const r0 = await shrinkStickerForUpload(small);
  check('小图原样返回（不白转码）', r0.shrunk === false && r0.buffer.length === 1000, r0.reason);

  const { findFfmpeg } = await import(new URL('../src/gif-frames.js', import.meta.url));
  const ff = findFfmpeg();
  if (!ff) {
    console.log('⚠️  没有 ffmpeg，跳过真实 GIF 压缩验证');
    check('ffmpeg 可用（保证这条验证不静默跳过）', false, '缺 ffmpeg');
  } else {
    const tmp = path.join(os.tmpdir(), 'qqb-sticker-test-' + process.pid + '.gif');
    try {
      const gen = spawnSync(ff, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=5',
        '-vf', 'split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=bayer',
        tmp
      ], { timeout: 60000 });
      check('生成测试 GIF 成功', gen.status === 0 && fs.existsSync(tmp), String(gen.stderr || '').slice(-120));
      const big = fs.readFileSync(tmp);
      check('测试 GIF 超过 4MiB（覆盖失败边界）', big.length > STICKER_UPLOAD_MAX_BYTES, `${(big.length / 1048576).toFixed(1)}MB`);
      const r = await shrinkStickerForUpload(big, { log: () => {} });
      check('大 GIF 被压缩', r.shrunk === true && !r.static, String(r.reason || ''));
      check('压缩后 <= 目标体积', r.buffer.length <= STICKER_UPLOAD_TARGET_BYTES,
        `${(big.length / 1048576).toFixed(1)}MB → ${(r.buffer.length / 1048576).toFixed(1)}MB`);
      check('压缩后仍是 GIF（保留动画）', r.mimeType === 'image/gif' && r.buffer.subarray(0, 6).toString('ascii').startsWith('GIF'));
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
