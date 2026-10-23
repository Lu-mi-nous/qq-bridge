// 回归测试：小图放大 + 与大图缩放的统一预处理。
//
// 背景（2026-10-16 用户反馈「我发的这个图很清晰，是不是处理前降画质了」）：
// 实测那张图**原始就只有 305×92**（QQ 本地 `Ori` 原图目录里也是同一份 6790 字节，
// 字节数完全一致 → 证明既没被 QQ 压、也没被桥接缩）。但模型回
// 「糊得跟天书一样，字都黏在一起，我看不清」。
//
// **真因是分辨率不足，不是画质压缩**：视觉模型把图切成约 14px 的 patch，
// 305×92 里中文只有约 12px 高（≈1 patch），笔画落不进 patch，模型只能看到糊块。
// 人眼放大能读，所以用户觉得"很清晰"——差异在这里。
//
// 修法与缩图相反：**把小图放大**（ffmpeg lanczos 到长边 1220）。
// 实测 305×92 → 1220×368 后字迹清晰可读。
//
// 顺序要求：先缩大图（防 base64 过大让 DSH 爆栈，崩溃级）→ 再放大小图。
// 两个条件互斥（字节大 vs 边长小），串联安全。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const m = await import(new URL('../src/image-downscale.js', import.meta.url));
const { upscaleIfSmall, downscaleIfLarge, prepareImageForModel, imageSizeOf, MIN_EDGE, UPSCALE_TARGET_EDGE, MAX_EDGE } = m;
const bridgeSrc = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');

// 造一个指定尺寸的最小 PNG（含 IHDR，可被 imageSizeOf 解析）
function fakePng(w, h) {
  const b = Buffer.alloc(64, 0);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

console.log('── 1. 尺寸探测（只看文件头，不解码）──');
{
  check('PNG 尺寸', JSON.stringify(imageSizeOf(fakePng(305, 92))) === '{"width":305,"height":92}');
  const gif = Buffer.alloc(32); gif.write('GIF89a', 0, 'ascii'); gif.writeUInt16LE(120, 6); gif.writeUInt16LE(80, 8);
  check('GIF 尺寸（小端）', imageSizeOf(gif)?.width === 120 && imageSizeOf(gif)?.height === 80);
  // 注意：夹具长度必须 >= 24 —— imageSizeOf 开头有 `buf.length < 24` 守卫
  // （真实 JPEG 不可能短于这个，是合理防御；测试夹具太短会撞上它而误判为解析失败）
  const jpg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20]),
    Buffer.alloc(20, 0),
  ]);
  const jd = imageSizeOf(jpg);
  check('JPEG 尺寸（SOF 段）', jd && jd.height === 600 && jd.width === 800, JSON.stringify(jd));
  check('空 buffer → null', imageSizeOf(Buffer.alloc(0)) === null);
  check('太短 → null', imageSizeOf(Buffer.alloc(4)) === null);
  check('垃圾数据 → null', imageSizeOf(Buffer.alloc(64, 0x41)) === null);
  check('null 不崩', imageSizeOf(null) === null);
}

console.log('\n── 2. 小图放大 ──');
{
  check('阈值 400（截图类小图才放大）', MIN_EDGE === 400, String(MIN_EDGE));
  check('目标长边 1220（模型舒适区）', UPSCALE_TARGET_EDGE === 1220, String(UPSCALE_TARGET_EDGE));

  // 真实问题图（夹具，gzip 存）
  const fx = path.join(root, 'test-fixtures', 'small-screenshot.png.gz');
  if (!fs.existsSync(fx)) {
    console.log('⚠️  缺夹具 test-fixtures/small-screenshot.png.gz，跳过真实图验证');
    check('夹具存在（保证这条验证不静默跳过）', false, '缺 small-screenshot.png.gz');
  } else {
    const buf = zlib.gunzipSync(fs.readFileSync(fx));
    const dims = imageSizeOf(buf);
    check('夹具是 305×92 的小截图（合成内容）', dims.width === 305 && dims.height === 92, JSON.stringify(dims));
    check('夹具很小（KB 量级，符合截图特征）', buf.length < 20 * 1024, `${(buf.length / 1024).toFixed(1)}KB`);

    const r = await upscaleIfSmall(buf, { mimeType: 'image/png', log: () => {} });
    check('被放大', r.upscaled === true, String(r.reason || ''));
    const out = imageSizeOf(r.buffer);
    check('长边达到 1220', Math.max(out.width, out.height) === UPSCALE_TARGET_EDGE, `${out.width}x${out.height}`);
    check('宽高比保持（不变形）', Math.abs((305 / 92) - (out.width / out.height)) < 0.02,
      `原 ${(305/92).toFixed(3)} 新 ${(out.width/out.height).toFixed(3)}`);
    check('输出是 PNG', r.buffer[0] === 0x89 && r.buffer[1] === 0x50, r.mimeType);
    // 关键：base64 后仍远低于爆栈量级
    check('base64 仍远小于 1MB（不会引发爆栈）',
      r.buffer.toString('base64').length < 1024 * 1024,
      `base64 ${Math.round(r.buffer.length * 4 / 3 / 1024)}KB`);
  }
}

console.log('\n── 3. 不该放大的情况（原样返回）──');
{
  const big = fakePng(1600, 1200);
  const r1 = await upscaleIfSmall(big, { mimeType: 'image/png' });
  check('大图不动', r1.upscaled === false && r1.reason === 'big-enough', r1.reason);
  const atThreshold = fakePng(MIN_EDGE, MIN_EDGE);
  const r2 = await upscaleIfSmall(atThreshold, { mimeType: 'image/png' });
  check('正好等于阈值 → 不动（边界）', r2.upscaled === false);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40)]);
  const r3 = await upscaleIfSmall(gif, { mimeType: 'image/gif' });
  check('GIF 不放大（交给抽帧逻辑）', r3.upscaled === false && r3.reason === 'animated-gif', r3.reason);
  const r4 = await upscaleIfSmall(Buffer.alloc(0));
  check('空 buffer 不崩', r4.upscaled === false && r4.reason === 'empty');
  const r5 = await upscaleIfSmall(Buffer.alloc(64, 0x41), { mimeType: 'image/png' });
  check('尺寸未知 → 不动（不猜）', r5.upscaled === false && r5.reason === 'unknown-size', r5.reason);
  const r6 = await upscaleIfSmall(null);
  check('null 不崩', r6.upscaled === false);
}

console.log('\n── 4. 统一预处理：先缩后放，顺序正确 ──');
{
  check('prepareImageForModel 已导出', typeof prepareImageForModel === 'function');
  // 别断言"恰好 2 处"：2026-10-22 为大图兜底又加了一条路径（按 URL 取图超限后压缩）。
  // 不变式是"每条交给模型的图都走统一预处理"，路径数会随功能增长。
  const prepCount = (bridgeSrc.match(/prepareImageForModel\(/g) || []).length;
  check('桥接接入统一预处理（路径只增不减）', prepCount >= 2, `实际 ${prepCount} 处`);
  check('不再直接调 downscaleIfLarge（避免两处各写一遍）',
    !/await downscaleIfLarge\(img\.buffer/.test(bridgeSrc));

  // 小图：只放大，不缩。
  // 必须用**真实图片夹具**：只有 PNG 头的假 buffer 无法被 ffmpeg 解码，
  // 会走 ffmpeg-failed 分支（那是正确的容错行为，但测不出"只放大"这个语义）。
  const smallFx = path.join(root, 'test-fixtures', 'small-screenshot.png.gz');
  if (fs.existsSync(smallFx)) {
    const small = zlib.gunzipSync(fs.readFileSync(smallFx));
    const r1 = await prepareImageForModel(small, { mimeType: 'image/png', log: () => {} });
    // 放大这一步现在**优先走 Real-ESRGAN 超分**（upscale.js），失败才回退 lanczos：
    //   - 本机装了 Upscayl → notes 是 'super-resolved'
    //   - 没装 / 超分失败 → notes 是 'upscaled'（lanczos）
    // 两种情况都算"放大了"，断言不该锁死具体实现。核心不变量是：**放大且没有缩小**。
    const grew = r1.notes.includes('upscaled') || r1.notes.includes('super-resolved');
    check('小图 → 被放大（超分或 lanczos）', grew && !r1.notes.includes('downscaled'), r1.notes.join('+') || '(未改动)');
    if (!r1.notes.includes('super-resolved')) {
      console.log('      提示：本次走的是 lanczos 回退（本机未装 Upscayl 或超分失败）');
    }
  } else {
    check('小图 → 被放大（缺夹具，跳过）', true, '无 small-screenshot.png.gz');
  }

  // 大图（字节够大 + 边长够大）：只缩，不放
  const bigJpeg = Buffer.alloc(2 * 1024 * 1024, 0xff);
  bigJpeg[0] = 0xff; bigJpeg[1] = 0xd8;
  bigJpeg[2] = 0xff; bigJpeg[3] = 0xc0; bigJpeg.writeUInt16BE(0x11, 4);
  bigJpeg[6] = 0x08; bigJpeg.writeUInt16BE(3000, 7); bigJpeg.writeUInt16BE(4000, 9);
  const r2 = await prepareImageForModel(bigJpeg, { mimeType: 'image/jpeg', log: () => {} });
  check('大图 → 不含 upscaled', !r2.notes.includes('upscaled'), r2.notes.join('+') || '(未改动)');

  // 极小且非图片：任何一步失败都不阻断，返回可用 buffer
  const junk = Buffer.alloc(2048, 0x41);
  const r3 = await prepareImageForModel(junk, { mimeType: 'image/png', log: () => {} });
  check('无法处理时仍返回原 buffer（不阻断）', r3.buffer.length === junk.length);
  check('结果结构完整', typeof r3.mimeType === 'string' && Array.isArray(r3.notes));
}

console.log('\n── 5. 两个方向互不干扰（同一次调用不会既缩又放）──');
{
  // 边长小但字节大：理论上冲突场景，验证不会来回折腾出问题
  const weird = Buffer.alloc(2 * 1024 * 1024, 0x41);
  weird[0] = 0x89; weird[1] = 0x50; weird[2] = 0x4e; weird[3] = 0x47;
  weird.writeUInt32BE(300, 16); weird.writeUInt32BE(200, 20);
  const r = await prepareImageForModel(weird, { mimeType: 'image/png', log: () => {} });
  check('异常组合不崩且返回可用 buffer', r.buffer.length > 0);
  check('notes 不重复同一动作', new Set(r.notes).size === r.notes.length, r.notes.join('+'));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
