// 回归测试：帖子配图**不能裁切**（用户反馈「带图片的帖子渲染不全」「图片上下被裁切了」）。
//
// 背景（2026-10-10）：单图路径原写「满宽 + 限高 640px，超高就 crop 掉上下」。而内容区宽
// 884px，比例 h/w > 0.724 就会被切——实测 1:1 方图切 244px、3:4 切 538px、9:16 切 932px。
// 插画帖绝大多数是方图/竖图，等于**大部分帖子都被切过**（只有横图幸免）。
//
// 修法：一律**完整显示**（contain）。过高时按高度上限**等比回缩宽度并居中**，绝不裁内容。
// 这里的断言用真实 ffmpeg 渲染 + 逐像素检查图片区上下边缘是否为图片色，
// 而不是只看代码——「裁没裁」只有看像素才靠得住。
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { renderPostImage } from '../src/x-monitor/render.mjs';
import { findFfmpeg } from '../src/gif-frames.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const ff = findFfmpeg();
if (!ff) { console.log('跳过：本机没有 ffmpeg'); process.exit(0); }

const run = (args) => new Promise((r) => { const p = spawn(ff, args, { windowsHide: true }); p.on('close', () => r()); p.on('error', () => r()); });

// 造纯色测试图（用它当「图片内容」，渲染后检查是否被切）
async function makeSolid(w, h, name) {
  const out = `state/tmp-crop-${name}.png`;
  await run(['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x2f6fd0:s=${w}x${h}:d=1`, '-frames:v', '1', '-update', '1', out]);
  return out;
}

// 解出渲染结果，返回 {w,h,rgb}
//
// ⚠️ 尺寸**不要靠 ffprobe 读**：卡片 PNG 是 RGBA，实测 ffprobe 对这类文件返回空
// （于是 W 变 NaN，整片区域读不到，报「图片区高 1px」——其实图好好的，是检测坏了）。
// 直接用 renderPostImage 返回的 width/height，与写出缓冲一一对应。
async function decode(file, w, h) {
  const raw = `${file}.rgb`;
  await run(['-y', '-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-update', '1', raw]);
  const buf = fs.readFileSync(raw);
  try { fs.unlinkSync(raw); } catch {}
  return { w, h, rgb: buf };
}

const post = {
  id: 'x', text: '测试', createdAt: '2026-10-10T00:00:00Z', createdAtMs: Date.now(),
  lang: 'zh', likes: 0, replies: 0, user: { name: 'T', handle: 't', avatar: '' },
  media: [{ type: 'photo', url: '' }]
};

// 图片色实测 (46,109,206)。**容差必须收紧**：卡片里还有个蓝色认证徽标
// accent=0x1d9bf0=(29,155,240)，用 ±40 时 G 通道会擦到它（G 上限 151 vs 徽标 155），
// 把徽标那几行也算进图片区——实测方图被多算 16px。±12 既容忍 PNG 压缩误差，又不碰徽标。
const isImageColor = (r, g, b) => Math.abs(r - 46) < 12 && Math.abs(g - 109) < 12 && Math.abs(b - 206) < 12;

/** 找出图片区的上下边界（第一行/最后一行**含图片色**的行）
 *  注意阈值要小：图片等比缩宽后会居中、两侧是白底，含色像素占整行比例可能不到 30%。 */
function imageRowRange({ w, h, rgb }) {
  let first = -1, last = -1;
  for (let y = 0; y < h; y++) {
    let cnt = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (isImageColor(rgb[i], rgb[i + 1], rgb[i + 2])) cnt++;
    }
    // 只要有 20 个像素是图片色就算这一行属于图片区（缩宽后的窄图也够）
    if (cnt >= 20) { if (first < 0) first = y; last = y; }
  }
  return { first, last, height: last - first + 1 };
}

console.log('── 各比例单图：内容必须完整（不裁切）──');
{
  const cases = [
    ['方图 1:1', 1000, 1000],
    ['竖图 2:3', 1000, 1500],
    ['长竖 9:16', 1080, 1920],
    ['横图 16:9', 1920, 1080],
  ];
  for (const [label, iw, ih] of cases) {
    const f = await makeSolid(iw, ih, label.replace(/[^\w]/g, ''));
    const img = await renderPostImage(post, { translation: '', media: [{ file: f, width: iw, height: ih }] });
    if (!img) { check(`${label} 渲染成功`, false); continue; }
    const outFile = `state/tmp-crop-out-${label.replace(/[^\w]/g, '')}.png`;
    fs.writeFileSync(outFile, img.buffer);
    const dec = await decode(outFile, img.width, img.height);
    const range = imageRowRange(dec);
    // 关键断言：图片区实际呈现的比例 ≈ 原图比例（裁切会让它变小）
    const shownAr = range.height / (dec.w - 46 * 2 - 52 * 2);
    const origAr = ih / iw;
    // 满宽显示时 shownAr≈origAr；等比缩宽时图片区高度=上限 900
    const ok = range.height > 0 && (Math.abs(shownAr - origAr) < 0.12 || range.height >= 880);
    check(`${label} 未被裁切`, ok,
      `原比例 ${origAr.toFixed(2)} 实际图片区高 ${range.height}px（满宽时若裁切会明显偏小）`);
    try { fs.unlinkSync(outFile); fs.unlinkSync(f); } catch {}
  }
}

console.log('\n── 方图不该被切成横图（旧 bug 的直接症状）──');
{
  const f = await makeSolid(1000, 1000, 'sq2');
  const img = await renderPostImage(post, { translation: '', media: [{ file: f, width: 1000, height: 1000 }] });
  const outFile = 'state/tmp-crop-sq2-out.png';
  fs.writeFileSync(outFile, img.buffer);
  const dec = await decode(outFile, img.width, img.height);
  const range = imageRowRange(dec);
  // 旧代码：限高 640，方图满宽 884 会被切成 640 高 → 明显不是方的
  check('方图呈现为方形（高≥850）', range.height >= 850, `实际 ${range.height}px（旧 bug 会是 640）`);
  try { fs.unlinkSync(outFile); fs.unlinkSync(f); } catch {}
}

console.log('\n── 极端长图：不裁切、也不撑爆卡片 ──');
{
  const f = await makeSolid(400, 4000, 'tall');
  const img = await renderPostImage(post, { translation: '', media: [{ file: f, width: 400, height: 4000 }] });
  check('渲染成功', !!img);
  check('卡片高度受控（<2000）', img.height < 2000, `${img.height}px`);
  const outFile = 'state/tmp-crop-tall-out.png';
  fs.writeFileSync(outFile, img.buffer);
  const dec = await decode(outFile, img.width, img.height);
  const range = imageRowRange(dec);
  check('长图完整显示（图片区高≈900 上限）', range.height >= 850, `实际 ${range.height}px`);
  try { fs.unlinkSync(outFile); fs.unlinkSync(f); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
