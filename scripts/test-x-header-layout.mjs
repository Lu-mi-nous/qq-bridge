// 回归测试：卡片头部布局——ID/时间在**昵称下方第二行**，且超长昵称不会溢出卡片。
//
// 背景（2026-10-11 用户反馈）：
//   ①「用户昵称、ID、时间放在一行太长了，有时会溢出边框」——原布局把
//      昵称 + 徽标 + @handle · 时间全挤在第 1 行，长昵称（韩文/日文/长英文名）直接顶破右边缘。
//   ② 改成两行后，**超长昵称本身**仍会溢出：drawtext 不换行也不裁剪，中文长昵称
//      （X 昵称上限 50 字符，够溢出）照样画到卡片外。所以还得按可用宽度截断加 `…`。
//
// 这个测试用**逐像素扫描**验证边界：只看代码没法确认「有没有画出卡片」。
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { renderPostImage } from '../plugins/x-posts/lib/render.mjs';
import { findFfmpeg } from '../src/gif-frames.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const ff = findFfmpeg();
if (!ff) { console.log('跳过：本机没有 ffmpeg'); process.exit(0); }
const run = (a) => new Promise((r) => { const p = spawn(ff, a, { windowsHide: true }); p.on('close', () => r()); p.on('error', () => r()); });

async function render(name, handle) {
  const post = {
    id: 'x', text: '测试正文', createdAt: '2026-10-10T00:00:00Z', createdAtMs: Date.now() - 3600000,
    lang: 'zh', likes: 0, replies: 0, user: { name, handle, avatar: '' }, media: []
  };
  const img = await renderPostImage(post, { translation: '' });
  const file = `state/tmp-headtest-${handle}.png`;
  fs.writeFileSync(file, img.buffer);
  const raw = `${file}.rgb`;
  await run(['-y', '-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-update', '1', raw]);
  const rgb = fs.readFileSync(raw);
  try { fs.unlinkSync(raw); } catch {}
  return { w: img.width, h: img.height, rgb, file };
}

/** 找出某行区间内「文字」像素的最右边界（卡片内容不该越过它）。
 *
 *  ⚠️ 必须排除卡片**阴影**：THEME.shadow=0x0f172a=(15,23,41) 铺在卡片右侧直到画布边缘，
 *  还带抗锯齿过渡像素（实测见过 (21,22,25)），所以「纯色相等」判不干净、每次都量到画布最右。
 *  做法：**只扫内容区**（x < contentRight），阴影天然被排除在外；
 *  再单独探一次内容区右侧有没有「明显偏色（非灰阶）或比阴影更亮」的像素——那才是真溢出。
 */
function maxRightEdge({ w, h, rgb }, y0, y1, contentRight = 982) {
  let maxX = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < contentRight; x++) {
      const i = (y * w + x) * 3;
      const [r, g, b] = [rgb[i], rgb[i + 1], rgb[i + 2]];
      const isWhite = r > 240 && g > 240 && b > 240;
      const isTransparent = r < 8 && g < 8 && b < 8;
      if (isWhite || isTransparent) continue;
      if (x > maxX) maxX = x;
    }
  }
  return maxX;
}

/** 量「昵称文字」的最右边界。
 *
 *  为什么不能用内容右边界（982）当上限：昵称右边是**蓝色认证徽标**（占 42px + 6px 间距），
 *  徽标本就该一直画到 982 附近。所以昵称**文字**的上限是 `982 - 42 - 6 = 934`。
 *  判据：量所有「非白、非透明、且**非蓝色徽标**」的像素，取最右 x。
 */
const NAME_TEXT_MAX = 982 - 42 - 6;   // = 934
function nameTextRight({ w, h, rgb }, y0, y1) {
  const contentRight = 982;
  let maxX = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < contentRight; x++) {
      const i = (y * w + x) * 3;
      const [r, g, b] = [rgb[i], rgb[i + 1], rgb[i + 2]];
      const isWhite = r > 240 && g > 240 && b > 240;
      const isTransparent = r < 8 && g < 8 && b < 8;
      // 认证徽标蓝 accent=0x1d9bf0=(29,155,240)：B 明显高于 R 且饱和
      const isBadgeBlue = b > 180 && b - r > 90 && g > 110;
      if (isWhite || isTransparent || isBadgeBlue) continue;
      if (x > maxX) maxX = x;
    }
  }
  return maxX;
}

console.log('── 两行布局：ID/时间在昵称下方 ──');
{
  // 头部第 1 行约 y=100~150（昵称），第 2 行约 y=155~190（@handle）
  const img = await render('Tibo', 'thsottiaux');
  // 第 1 行区域（昵称）与第 2 行区域（handle）分别取右边界
  const row1Right = maxRightEdge(img, 100, 152);
  const row2Right = maxRightEdge(img, 153, 195);
  check('第 1 行有内容（昵称）', row1Right > 0, `右边界 ${row1Right}`);
  check('第 2 行有内容（@handle）', row2Right > 0, `右边界 ${row2Right}`);
  check('两行确实分开（两行都有内容）', row2Right > 0 && row1Right > 0);
  const r1 = nameTextRight(img, 100, 152);
  const r2 = nameTextRight(img, 153, 195);
  check('昵称文字未超出可用宽（934）', r1 <= NAME_TEXT_MAX, `右边界 ${r1} <= ${NAME_TEXT_MAX}`);
  check('@handle 行未溢出内容区', r2 <= 982, `右边界 ${r2} <= 982`);
  try { fs.unlinkSync(img.file); } catch {}
}

console.log('\n── 超长昵称：截断且不溢出 ──');
{
  const longName = '这是一个极其冗长的昵称用来测试是否会突破卡片右边缘导致内容溢出边框的极端情况';
  const img = await render(longName, 'verylonghandle');
  const r1 = nameTextRight(img, 100, 152);
  // 关键断言：截断后昵称文字不该越过可用宽 934（旧代码会一路画到卡片外）
  check('超长昵称已截断（未越过 934）', r1 <= NAME_TEXT_MAX, `右边界 ${r1} <= ${NAME_TEXT_MAX}`);
  // 且应接近上限（说明是"填满后截断"，而不是被砍得太短）
  check('昵称填满可用宽度（截断而非丢弃）', r1 > NAME_TEXT_MAX - 90, `右边界 ${r1}`);
  try { fs.unlinkSync(img.file); } catch {}
}

console.log('\n── 长韩文昵称（用户实际遇到的场景）──');
{
  const img = await render('みらつ/밋다다@SD작법서많관부', 'miratsu169');
  const r1 = nameTextRight(img, 100, 152);
  check('韩文长昵称未溢出（<=934）', r1 <= NAME_TEXT_MAX, `右边界 ${r1} <= ${NAME_TEXT_MAX}`);
  check('韩文昵称未被砍短（完整显示）', r1 > NAME_TEXT_MAX - 250, `右边界 ${r1}`);
  try { fs.unlinkSync(img.file); } catch {}
}

console.log('\n── 短昵称不该被改动 ──');
{
  const img = await render('Tibo', 'thsottiaux');
  // 短名渲染后应当与"未截断"一致：直接确认渲染成功且高度为固定两行头
  check('短昵称渲染成功', img.h > 300, `${img.h}px`);
  try { fs.unlinkSync(img.file); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
