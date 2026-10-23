// 回归测试：GIF 抽帧拼图模块（gif-frames.js）。
// 覆盖：帧数探测、均匀采样、单帧/静态图/垃圾字节降级、配置边界。
// 需要 ffmpeg/ffprobe 在 PATH 或常见位置；缺 ffmpeg 时相关用例自动跳过。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tileGifFrames, isAnimated, isGifBuffer, probeFrameCount, findFfmpeg, gifFramesHint } from '../src/gif-frames.js';

// 用 PIL 生成可控帧数的 GIF（每帧纯色 + 编号文字）
function makeGif(frameCount, file) {
  const py = `
from PIL import Image, ImageDraw
W=H=120
colors=[(220,40,40),(40,200,80),(50,90,230),(240,210,40),(200,50,200),(30,200,220),(120,120,120),(255,140,0)]
frames=[]
for i in range(${frameCount}):
    c=colors[i%len(colors)]
    im=Image.new('RGB',(W,H),c); d=ImageDraw.Draw(im)
    d.rectangle([6,6,W-6,H-6],outline=(0,0,0),width=3)
    d.text((40,55),'F'+str(i+1),fill=(0,0,0))
    frames.append(im)
frames[0].save(${JSON.stringify(file)},save_all=True,append_images=frames[1:],duration=400,loop=0)
`;
  const r = spawnSync('python', ['-c', py], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('PIL 生成 GIF 失败: ' + (r.stderr || r.stdout));
}

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gifframes-test-'));
console.log('临时目录:', tmpDir);
console.log('ffmpeg:', findFfmpeg() ?? '(未找到，部分用例将跳过)');
console.log('');

try {
  // ── 工具函数（不依赖 ffmpeg）──
  check('非 GIF 字节 isGifBuffer=false', isGifBuffer(Buffer.from('hello world!!')) === false);
  check('GIF89a 头 isGifBuffer=true', isGifBuffer(Buffer.from('GIF89a............')) === true);

  // ── 注入文案（不依赖 ffmpeg；措辞是实测调出来的，别随手改弱）──
  {
    const hint = gifFramesHint(2, { kept: 20, frames: 48 });
    check('文案说明这是动图', hint.includes('这是一张动图'));
    // 排布从单行改成网格后，时间顺序的说法要跟着变（见 gif-frames.js）
    check('文案含时间顺序说明（单行）', hint.includes('最左边是最早') && hint.includes('最右边是最晚')
      || hint.includes('从左到右') && hint.includes('起点是最早'));
    check('文案含「连续动作」关键引导', hint.includes('连续动作'));
    // 多行排布：必须说清阅读顺序，否则模型会把第二行当成后发生的独立事件
    const gridHint = gifFramesHint(3, { kept: 20, frames: 48, cols: 5, rows: 4 });
    check('网格排布说明行数与每行数量', gridHint.includes('4 行') && gridHint.includes('每行 5 个'));
    check('网格排布说明换行阅读顺序', gridHint.includes('读完第一行') && gridHint.includes('再读下一行'));
    check('网格排布不出现「最右边是最晚」（那会误导跨行阅读）', !gridHint.includes('最右边是最晚'));
    check('文案含「不是并排的几个不同物体」反例提醒', hint.includes('不是并排的几个不同物体'));
    check('文案带入序号', hint.includes('动图2'));
    check('文案说明等间隔取样与总帧数', hint.includes('共 48 帧') && hint.includes('等间隔取了 20 帧'));
    // **关键**：整段文案不能出现「格」字。
    // 为什么连"别说某字"这种提醒也不能写：提了那个字，模型反而会学去用在回答里。
    check('文案本体不含「格」字', !hint.includes('格'));
    check('文案要求当作动图播放来描述', hint.includes('当成一个动图来描述') && hint.includes('像你在看它播放'));
    // 帧数未达上限时不提"等间隔取样"
    const full = gifFramesHint(1, { kept: 5, frames: 5 });
    check('全取时不提等间隔取样', !full.includes('等间隔取了'));
  }

  if (!findFfmpeg()) {
    console.log('\n⚠️ 未找到 ffmpeg，跳过需要它的用例');
  } else {
    // ── 5 帧动图（不足上限）→ 全取 5 帧 ──
    const gif5 = path.join(tmpDir, 'g5.gif');
    makeGif(5, gif5);
    const buf5 = fs.readFileSync(gif5);
    check('5 帧 GIF 帧数探测 = 5', (await probeFrameCount(buf5)) === 5);
    check('5 帧 GIF isAnimated=true', (await isAnimated(buf5)) === true);

    const t5 = await tileGifFrames(buf5, { maxFrames: 20, tileWidth: 120 });
    check('5 帧 → 拼图成功', !!t5);
    check('5 帧 → 不足上限，全取 5 帧', t5?.kept === 5, `kept=${t5?.kept}`);
    check('5 帧 → 报告总帧数 5', t5?.frames === 5);
    check('拼图输出是 PNG', t5?.buffer?.[0] === 0x89 && t5?.buffer?.[1] === 0x50);
    // 排布改成网格（见 gif-frames.js：单行会成 20:1 的细长条，模型看不清每帧）
    const pngW = t5 ? t5.buffer.readUInt32BE(16) : 0;
    const pngH = t5 ? t5.buffer.readUInt32BE(20) : 0;
    check('拼图宽度 = 单帧宽×列数', pngW === 120 * t5.cols, `实际 ${pngW}, cols=${t5?.cols}`);
    check('拼图高度 = 单帧高×行数', pngH === 120 * t5.rows, `实际 ${pngH}, rows=${t5?.rows}`);
    check('5 帧排成 3×2 网格', t5?.cols === 3 && t5?.rows === 2, `${t5?.cols}x${t5?.rows}`);
    check('报告了实际单帧宽度', t5?.tileWidth === 120, `tileWidth=${t5?.tileWidth}`);
    // 本次修复的核心指标：整图不能是细长条
    check('宽高比不超过 2:1（不再是细长条）', pngW / pngH <= 2.01, `w=${pngW} h=${pngH} 比=${(pngW / pngH).toFixed(2)}`);

    // ── 3 帧动图：少于上限 → 全取 ──
    const gif3 = path.join(tmpDir, 'g3.gif');
    makeGif(3, gif3);
    const t3 = await tileGifFrames(fs.readFileSync(gif3), { maxFrames: 20, tileWidth: 120 });
    check('3 帧 → 全取 3 帧', t3?.kept === 3);
    check('3 帧 → 宽度 = 单帧宽×列数', t3 ? t3.buffer.readUInt32BE(16) === 120 * t3.cols : false, `cols=${t3?.cols}`);

    // ── 8 帧动图：仍少于上限 20 → 全取（这是本次需求的关键变化）──
    const gif8 = path.join(tmpDir, 'g8.gif');
    makeGif(8, gif8);
    const t8 = await tileGifFrames(fs.readFileSync(gif8), { maxFrames: 20, tileWidth: 120 });
    check('8 帧 → 全取 8 帧（不再截成 4）', t8?.kept === 8, `kept=${t8?.kept}`);
    check('8 帧 → 报告总帧数 8', t8?.frames === 8);

    // ── 25 帧动图：超过上限 → 等间隔抽 20 帧 ──
    const gif25 = path.join(tmpDir, 'g25.gif');
    makeGif(25, gif25);
    const t25 = await tileGifFrames(fs.readFileSync(gif25), { maxFrames: 20, tileWidth: 120 });
    check('25 帧 → 等间隔抽 20 帧', t25?.kept === 20, `kept=${t25?.kept}`);
    check('25 帧 → 报告总帧数 25', t25?.frames === 25);
    // 20 帧排成 5×4 网格；这是群友反馈"被压成细长条"的场景
    const w25 = t25?.buffer?.readUInt32BE(16) ?? 0;
    const h25 = t25?.buffer?.readUInt32BE(20) ?? 0;
    check('25 帧 → 宽度 = 实际单帧宽×列数', t25 ? w25 === t25.tileWidth * t25.cols : false, `w=${w25} tile=${t25?.tileWidth} cols=${t25?.cols}`);
    check('25 帧 → 排成 5×4 网格', t25?.cols === 5 && t25?.rows === 4, `${t25?.cols}x${t25?.rows}`);
    check('25 帧 → 宽高比不超过 2:1', h25 > 0 && w25 / h25 <= 2.01, `w=${w25} h=${h25} 比=${h25 ? (w25 / h25).toFixed(2) : '?'}`);

    // ── 默认参数（真实桥接调用，不传 tileWidth）──
    // 这是群友报障的真实场景：有效单帧宽度决定模型能不能看清表情。
    // 旧布局 20 列时整图 2400px 宽，缩到模型有效边长后每帧只剩 ~78px。
    {
      const gif48 = path.join(tmpDir, 'g48.gif');
      makeGif(48, gif48);
      const td = await tileGifFrames(fs.readFileSync(gif48), { maxFrames: 20 });
      if (td) {
        const w = td.buffer.readUInt32BE(16), h = td.buffer.readUInt32BE(20);
        const effective = Math.round((1568 / w) * td.tileWidth);
        check('默认参数 → 20 帧排成 5×4', td.cols === 5 && td.rows === 4, `${td.cols}x${td.rows}`);
        check('默认参数 → 单帧宽 320', td.tileWidth === 320, `tileWidth=${td.tileWidth}`);
        check('默认参数 → 整图接近模型有效边长（≤1600）', w <= 1600, `w=${w}`);
        check('默认参数 → 缩放后单帧有效宽 ≥200px（旧布局约 78px）', effective >= 200, `有效宽=${effective}px`);
      } else {
        check('默认参数 → 拼图成功', false, 'tileGifFrames 返回 null');
      }
    }

    // ── 单帧 GIF：不值得拼，应降级 null ──
    const gif1 = path.join(tmpDir, 'g1.gif');
    makeGif(1, gif1);
    const buf1 = fs.readFileSync(gif1);
    check('单帧 GIF isAnimated=false', (await isAnimated(buf1)) === false);
    check('单帧 GIF → 降级 null', (await tileGifFrames(buf1)) === null);

    // ── 静态 PNG：直接降级 ──
    const png = path.join(tmpDir, 'static.png');
    spawnSync('python', ['-c', `from PIL import Image; Image.new('RGB',(60,60),(10,20,30)).save(${JSON.stringify(png)})`]);
    const pngBuf = fs.readFileSync(png);
    check('静态 PNG isGifBuffer=false', isGifBuffer(pngBuf) === false);
    check('静态 PNG isAnimated=false', (await isAnimated(pngBuf)) === false);
    check('静态 PNG → 降级 null', (await tileGifFrames(pngBuf)) === null);

    // ── 垃圾字节：不崩、降级 ──
    const junk = Buffer.from('definitely not an image, just text');
    check('垃圾字节 isAnimated=false', (await isAnimated(junk)) === false);
    check('垃圾字节 → 降级 null', (await tileGifFrames(junk)) === null);

    // ── 截断的 GIF（模拟下载不全）：不崩即可 ──
    const truncated = buf5.subarray(0, Math.floor(buf5.length / 2));
    let threw = false;
    let res = null;
    try { res = await tileGifFrames(truncated, { timeoutMs: 8000 }); } catch { threw = true; }
    check('截断 GIF 不抛异常', !threw);
    check('截断 GIF 降级或给出结果（均可接受）', res === null || Buffer.isBuffer(res.buffer));
  }
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
