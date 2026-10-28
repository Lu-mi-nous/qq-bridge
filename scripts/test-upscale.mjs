// 回归测试：超分插件（plugins/upscale/ + src/upscale-bin.js）。
//
// 背景（2026-10-19 用户要求「接入超分功能，软件现成在 C:\Program Files\Upscayl」）：
// 桥接原本用 ffmpeg lanczos 放大过小的图。lanczos 是插值——把像素平滑拉开，笔画边缘还是虚的；
// 模型切 ~14px patch 时糊边正好落进 patch 边界，小图里的中文仍难读。
// Real-ESRGAN 是生成式超分，实测同一张 180×90 文字截图：
//   lanczos 版细笔画粘连、超分版边缘锐利接近原生。
//
// 本测试锁住五条不变量：
//   ① 只对"小图"触发（长边 < 400）——否则每张正常照片都被放大，白烧算力还改变原信息；
//   ② 任何失败都不抛异常、返回 upscaled:false（超分是增强，调用方要能回退 lanczos）；
//   ③ 选模型时自动回退到真实存在的模型（用户填错/模型被删不该炸）；
//   ④ 动图/超大输入明确拒绝（动图超分会丢帧语义）；
//   ⑤ **可选插件语义**：没装 Upscayl（或它坏了）时，桥接出图完全不受影响，
//      且不会每张小图都去等一次超时（靠探测 + 熔断）。
//
// 依赖本机已装 Upscayl；没有时相关用例标记为跳过而不是失败。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  upscaleImage, listModels, pickModel,
  probeUpscale, breakerOpen, resetUpscaleState, upscaleStatus,
  configureUpscaleCache, upscaleCacheDir, pruneUpscaleCache, clearUpscaleCache,
  DEFAULT_MODEL_DIR, MODEL_GUIDE
} from '../plugins/upscale/lib/upscale.js';
import { DEFAULT_BIN_DIR, findUpscaylBin } from '../src/upscale-bin.js';
import { readConsoleSource } from './lib/console-src.mjs';

let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const skipped = (n, why) => { skip++; console.log(`SKIP  ${n}  （${why}）`); };

const bin = findUpscaylBin();
const models = listModels();
console.log('upscayl-bin:', bin ?? '(未找到)');
console.log('模型:', models.join(', ') || '(无)');
console.log('');

// ── 1. 环境探测与模型选择（纯逻辑，不依赖实际跑超分）──
console.log('── 1. 环境探测与模型选择 ──');{
  check('DEFAULT_BIN_DIR 指向 Upscayl 安装目录', /Upscayl/i.test(DEFAULT_BIN_DIR));
  check('DEFAULT_MODEL_DIR 指向 models 目录', /models/i.test(DEFAULT_MODEL_DIR));
  check('MODEL_GUIDE 覆盖默认模型', !!MODEL_GUIDE['upscayl-standard-4x']);
  if (bin) {
    check('findUpscaylBin 找到可执行文件', fs.statSync(bin).isFile());
    check('找到的是 upscayl-bin（不是 Electron 外壳 Upscayl.exe）', /upscayl-bin\.exe$/i.test(bin));
  } else {
    skipped('findUpscaylBin 找到可执行文件', '本机未安装 Upscayl');
  }
  if (models.length) {
    check('listModels 返回多个模型', models.length >= 3, `${models.length} 个`);
    check('模型名不含 .bin 后缀', models.every((m) => !m.endsWith('.bin')));
    check('默认模型在目录里', models.includes('upscayl-standard-4x'));
  } else {
    skipped('listModels 返回多个模型', '本机未安装 Upscayl');
  }

  // 选模型：这是"用户填错不该炸"的关键
  if (models.length) {
    check('pickModel(undefined) 选默认', pickModel(undefined) === 'upscayl-standard-4x');
    check('pickModel 尊重用户指定', pickModel(models[models.length - 1]) === models[models.length - 1]);
    check('pickModel 对不存在的模型回退到默认', pickModel('definitely-not-a-model') === 'upscayl-standard-4x');
    check('pickModel 对空字符串回退到默认', pickModel('') === 'upscayl-standard-4x');
  } else {
    check('pickModel(undefined) 无模型时返回 null', pickModel(undefined) === null);
  }
}

// ── 2. 拒绝路径（不实际跑超分，靠前置判断返回）──
console.log('\n── 2. 拒绝路径（应明确返回原因，不抛异常）──');
{
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(40)]);

  const empty = await upscaleImage(Buffer.alloc(0), {});
  check('空 buffer → upscaled:false', empty.upscaled === false && empty.reason === 'empty');

  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40)]);
  const gifR = await upscaleImage(gif, { mimeType: 'image/gif' });
  check('GIF → 拒绝（会丢帧语义）', gifR.upscaled === false && gifR.reason === 'animated-gif');

  const unknown = await upscaleImage(Buffer.from('not an image at all, really not'), {});
  check('读不出尺寸 → 拒绝', unknown.upscaled === false && unknown.reason === 'unknown-size');

  try {
    // 必须用**能解析出尺寸**的真实小图：假 PNG 头会让 imageSizeOf 先返回 unknown-size，
    // 测不到 binDir 这条分支（第一版就踩了这个，断言失败与代码无关）。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-nobin-'));
    const f = path.join(dir, 's.png');
    const py = `from PIL import Image
Image.new('RGB',(160,80),(200,210,230)).save(${JSON.stringify(f)})`;
    spawnSync('python', ['-c', py]);
    const buf = fs.readFileSync(f);
    const r = await upscaleImage(buf, { mimeType: 'image/png', binDir: path.join(os.tmpdir(), 'no-such-dir-xyz') });
    check('缺 upscayl-bin → upscaled:false（不抛异常）', r.upscaled === false && r.reason === 'no-upscayl-bin');
    console.log('      实际 reason:', r.reason);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    check('缺 upscayl-bin → upscaled:false（不抛异常）', false, String(error?.message));
  }
}

// ── 3. 小图门槛（本次修复的核心：不能对每张图都超分）──
console.log('\n── 3. 小图门槛 ──');
if (!bin || !models.length) {
  skipped('小图触发超分', '本机未安装 Upscayl');
  skipped('大图被拒（big-enough）', '本机未安装 Upscayl');
  skipped('force 可越过门槛', '本机未安装 Upscayl');
  skipped('超大输入被拒', '本机未安装 Upscayl');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-test-'));
  const mk = (w, h, file) => {
    const py = `from PIL import Image, ImageDraw
im=Image.new('RGB',(${w},${h}),(240,240,245)); d=ImageDraw.Draw(im)
d.text((6,6),'TEXT ${w}x${h}',fill=(20,20,20))
im.save(${JSON.stringify(file)})`;
    const r = spawnSync('python', ['-c', py], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('PIL 失败: ' + (r.stderr || r.stdout).slice(0, 200));
  };

  // 小图（180×90，长边 < 400）→ 应当超分
  const smallFile = path.join(dir, 'small.png');
  mk(180, 90, smallFile);
  const small = fs.readFileSync(smallFile);
  const logs = [];
  const up = await upscaleImage(small, { mimeType: 'image/png', log: (m) => logs.push(m) });
  check('小图 → 超分成功', up.upscaled === true, `reason=${up.reason ?? '-'}`);
  if (up.upscaled) {
    check('小图 → 输出是 PNG', up.mimeType === 'image/png' && up.buffer[0] === 0x89);
    check('小图 → 确实变大了', Number(up.to.split('x')[0]) > 180, `${up.from} → ${up.to}`);
    check('小图 → 报告所用模型', !!up.model && models.includes(up.model), up.model);
    check('小图 → 报告耗时', Number(up.ms) > 0, `${up.ms}ms`);
    check('小图 → 写了日志', logs.some((l) => l.includes('[超分]')));
  }

  // 正常尺寸（800×600，长边 > 400）→ 应当拒绝（否则每张照片都白烧 3 秒）
  const midFile = path.join(dir, 'mid.png');
  mk(800, 600, midFile);
  const mid = await upscaleImage(fs.readFileSync(midFile), { mimeType: 'image/png' });
  check('正常尺寸图 → 拒绝（big-enough，不白烧算力）', mid.upscaled === false && mid.reason === 'big-enough');

  // force 越过门槛（工具主动调用的场景）
  const forced = await upscaleImage(fs.readFileSync(midFile), { mimeType: 'image/png', force: true, model: 'upscayl-lite-4x' });
  check('force=true 可对中等图超分', forced.upscaled === true, `reason=${forced.reason ?? '-'}`);

  // 输入上限：**必须放得下手机照片**（2026-10-19 用户反馈「它一直说原图就够大」）。
  // 原先上限是 1200，导致群里真实的 879×1448 / 986×1659 全部被拒，模型只能回"原图已经够大"。
  // 实测这些图超分只要 1.6 秒、输出 375KB，完全可行 → 上限提到 4000。
  //
  // 注意：1600 宽的图不算用例——它长边已超过模型有效边长 1568，超分后输出反而更窄，
  // 判 already-large-enough 是**正确**行为（超分救不了"已经够大"的图）。
  const bigFile = path.join(dir, 'big.png');
  mk(1200, 900, bigFile);
  const big = await upscaleImage(fs.readFileSync(bigFile), { mimeType: 'image/png', force: true, model: 'upscayl-lite-4x' });
  check('较大的图（长边 1200）可以超分', big.upscaled === true, `reason=${big.reason ?? '-'}`);
  if (big.upscaled) {
    check('输出宽度被压到 1568（不按 4x 无限放大）', Number(big.to.split('x')[0]) === 1568, big.to);
  }

  // 已经大过模型有效边长的图：超分无意义，应明确拒绝（不是 bug，是正确行为）
  const wideFile = path.join(dir, 'wide.png');
  mk(1600, 900, wideFile);
  const wide = await upscaleImage(fs.readFileSync(wideFile), { mimeType: 'image/png', force: true });
  check('长边超过 1568 的图 → already-large-enough（超分无收益）',
    wide.upscaled === false && wide.reason === 'already-large-enough', String(wide.reason));

  // 竖图 879×1448（群里真实用例）也要能过
  const tallFile = path.join(dir, 'tall.png');
  mk(879, 1448, tallFile);
  const tall = await upscaleImage(fs.readFileSync(tallFile), { mimeType: 'image/png', force: true, model: 'upscayl-lite-4x' });
  check('竖版手机图 879×1448 可以超分', tall.upscaled === true, `reason=${tall.reason ?? '-'}`);

  // 真正超大的（长边 > 4000）仍拒绝：那时候该先缩图，不是超分
  const hugeFile = path.join(dir, 'huge.png');
  mk(4200, 3000, hugeFile);
  const huge = await upscaleImage(fs.readFileSync(hugeFile), { mimeType: 'image/png', force: true });
  check('超大输入（长边 >4000）→ 拒绝', huge.upscaled === false && String(huge.reason).startsWith('input-too-large'), String(huge.reason));

  // 输出宽度上限（视觉模型有效边长）
  const capped = await upscaleImage(small, { mimeType: 'image/png', targetWidth: 99999 });
  if (capped.upscaled) {
    const w = Number(capped.to.split('x')[0]);
    check('输出宽度不超过 1568（模型有效边长）', w <= 1568, `w=${w}`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 3b. 可选插件语义：没装 Upscayl 也不能影响桥接 ──
//
// 这是 2026-10-19 用户明确要求：「做成可选插件的形式，若没有 upscayl 也不能影响桥接本身使用」。
// 光"文件不存在就跳过"不够——真正的风险是**文件在但运行不正常**（驱动坏、DLL 缺失、假文件）：
// 每次调用都挂到超时（默认 120s），一张图把回复卡死两分钟。所以要探测 + 熔断。
console.log('\n── 3b. 可选插件语义 ──');
{
  const BAD = {
    binDir: path.join(os.tmpdir(), 'definitely-no-upscayl', 'bin'),
    modelDir: path.join(os.tmpdir(), 'definitely-no-upscayl', 'models')
  };

  resetUpscaleState();
  const bad = probeUpscale(BAD);
  check('缺目录 → probe 报不可用', bad.ok === false && bad.reason === 'no-upscayl-bin');
  check('缺目录 → 不处于熔断（未尝试过，没必要熔断）', breakerOpen(BAD.binDir) === false);

  const st = upscaleStatus(BAD);
  check('upscaleStatus 如实汇报不可用', st.available === false && st.reason === 'no-upscayl-bin');

  check('pickModel 在空目录返回 null（不猜）', pickModel('x', BAD) === null);

  // 关键：不可用时 prepareImageForModel 仍必须产出可用图片（走 lanczos）
  const { prepareImageForModel } = await import('../src/image-downscale.js');
  const fx = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1'), '..', 'test-fixtures', 'small-screenshot.png.gz');
  if (fs.existsSync(fx)) {
    const zlib = await import('node:zlib');
    const small = zlib.gunzipSync(fs.readFileSync(fx));
    resetUpscaleState();
    const logs = [];
    const r = await prepareImageForModel(small, {
      mimeType: 'image/png',
      upscale: { ...BAD, enabled: true },
      log: (m) => logs.push(m)
    });
    check('无 Upscayl 时仍产出图片（内容非空）', r.buffer.length > 0, `${r.buffer.length} bytes`);
    check('无 Upscayl 时回退到 lanczos', r.notes.includes('upscaled') && !r.notes.includes('super-resolved'), r.notes.join('+') || '(无)');
    check('无 Upscayl 时日志说明"不影响出图"', logs.some((l) => l.includes('不影响出图')));
    check('无 Upscayl 时不抛异常', true);
  } else {
    skipped('无 Upscayl 时仍产出图片', '缺夹具 small-screenshot.png.gz');
  }

  // enabled:false 时完全不碰超分
  if (fs.existsSync(fx)) {
    const zlib = await import('node:zlib');
    const small = zlib.gunzipSync(fs.readFileSync(fx));
    resetUpscaleState();
    const logs = [];
    const r = await prepareImageForModel(small, { mimeType: 'image/png', upscale: { enabled: false }, log: (m) => logs.push(m) });
    check('enabled:false 时不调用超分', !logs.some((l) => l.includes('[超分]')), logs.join(' | ').slice(0, 80));
    check('enabled:false 时仍产出图片', r.buffer.length > 0);
  }
}

// ── 3c. 熔断：二进制在但运行失败时不能反复等超时 ──
console.log('\n── 3c. 熔断（二进制存在但运行失败）──');
{
  // 造一个"存在但执行失败"的假二进制（Windows 下 ELF 无法执行 → 必然失败）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-fake-'));
  const binDir = path.join(dir, 'bin');
  const modelDir = path.join(dir, 'models');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'upscayl-bin.exe'), Buffer.from('not a pe executable'));
  fs.writeFileSync(path.join(modelDir, 'upscayl-lite-4x.bin'), Buffer.alloc(1));
  fs.writeFileSync(path.join(modelDir, 'upscayl-lite-4x.param'), Buffer.alloc(1));

  const fake = { binDir, modelDir };
  resetUpscaleState();
  const p = probeUpscale(fake);
  check('假二进制 → probe 认为可用（文件存在，探测不跑进程）', p.ok === true);

  // 需要一张真实可解析的小图才会走到执行阶段
  const py = `from PIL import Image
Image.new('RGB',(120,60),(210,220,235)).save(${JSON.stringify(path.join(dir, 's.png'))})`;
  const gen = spawnSync('python', ['-c', py]);
  if (gen.status === 0) {
    const buf = fs.readFileSync(path.join(dir, 's.png'));
    const r1 = await upscaleImage(buf, { mimeType: 'image/png', ...fake, force: true });
    check('执行失败 → upscaled:false（不抛异常）', r1.upscaled === false, `reason=${String(r1.reason).slice(0, 40)}`);
    const r2 = await upscaleImage(buf, { mimeType: 'image/png', ...fake, force: true });
    check('连续失败达到阈值 → 熔断', breakerOpen(binDir) === true, `第二次 reason=${String(r2.reason).slice(0, 30)}`);
    const t0 = Date.now();
    const r3 = await upscaleImage(buf, { mimeType: 'image/png', ...fake, force: true });
    const ms = Date.now() - t0;
    check('熔断后直接返回 breaker-open', r3.upscaled === false && r3.reason === 'breaker-open');
    check('熔断后不再起进程（耗时 <100ms）', ms < 100, `${ms}ms`);
  } else {
    skipped('熔断行为', 'PIL 不可用，无法生成测试图');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  resetUpscaleState();
}

// ── 4. 接线检查（源码级）──
console.log('\n── 4. 接线检查 ──');
{
  const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
  const srcRoot = path.join(root, 'src');
  const downscale = fs.readFileSync(path.join(srcRoot, 'image-downscale.js'), 'utf8');
  const mcp = fs.readFileSync(path.join(root, 'plugins', 'upscale', 'mcp-tools.js'), 'utf8');

  const { prepareImageForModel } = await import('../src/image-downscale.js');
  let called = false;
  const prepared = await prepareImageForModel(Buffer.from('fixture'), {
    getUpscalePlugin: () => ({ probe: () => ({ ok: true }),
      upscaleImage: async () => { called = true; return { upscaled: true, buffer: Buffer.from('upscaled'), mimeType: 'image/png' }; } })
  });
  check('prepareImageForModel 调用注入能力', called && prepared.notes.includes('super-resolved'));
  check('超分失败回退 lanczos（仍调用 upscaleIfSmall）', /const grown = await upscaleIfSmall/.test(downscale));
  check('超分可用配置关闭', /opts\.upscale.*enabled !== false/.test(downscale));
  check('超分异常被捕获（不让链路崩）', /\[超分\] 不可用/.test(downscale));
  check('MCP 注册了 qq_upscale_image', /'qq_upscale_image'/.test(mcp));
  // 这条随"主动功能"改过：原先要求"不要对已经清楚的图用"，
  // 但群友明确要求超分时应当照做（用户的诉求），所以改为区分两种场景。
  check('MCP 工具区分"群友要求"与"自己判断"',
    /群友明确要求/.test(mcp) && /自己判断/.test(mcp));
  check('MCP 工具提醒没必要时自己别乱发（publish=false）',
    /publish=false/.test(mcp) && /只看不发|别把放大图刷进群/.test(mcp));
  check('MCP 工具处理动图', /这是动图/.test(mcp));
  check('MCP 工具失败时说明原因', /超分未执行/.test(mcp));
  check('MCP 工具受配置开关控制', /config\.get\(\)\?\.enabled !== false/.test(mcp));

  // ── 超分结果要发回会话（2026-10-19 用户反馈「超分完没有把超分后的结果发回」）──
  const bridge = readConsoleSource();
  const mainBridge = fs.readFileSync(path.join(srcRoot, 'bridge.js'), 'utf8');
  check('桥接有超分回传端点', /url\.pathname === '\/api\/socialV2\/send-upscaled'/.test(bridge));
  check('回传只接受 base64（拒绝 URL/本地路径）', /data 必须是 base64 编码的图片/.test(bridge));
  check('回传校验确实是图片（魔数）', /sniffImageMime\(buf\)/.test(bridge));
  check('回传受模式/令牌校验', /send-upscaled[\s\S]{0,1800}agentTokenOk\(key, token\)/.test(bridge));
  check('工具默认发布（publish 默认 true）', /publish !== false/.test(mcp));
  check('工具可 publish=false 只看不发', /publish=false 只放大给你自己看/.test(mcp));
  check('发送失败不影响把图交给模型（仍返回 image part）',
    /publishNote[\s\S]{0,2000}\{ type: 'image', mimeType: r\.mimeType/.test(mcp));
  // 超分输出是 PNG，照片类图超分后 7MB、base64 9.4MB —— 实测会让 OneBot 侧 fetch failed。
  // 所以发回 QQ 前必须转 JPEG。
  // ── 大图回传：用临时 HTTP 托管绕开 OneBot 的 2MB 请求体上限 ──
  //
  // 2026-10-19 查证 SnowLuma 源码后确认：
  //   `readRequestBody(req, maxBytes = 2 * 1024 * 1024)` —— 写死、没走配置。
  // 超限直接 `req.destroy()`，所以客户端只看到 ECONNRESET（拿不到错误码）。
  // 但这只限制 **HTTP 请求体**；OneBot 读图走 `loadBinarySource()`，支持
  // base64 / http(s) URL / 本地文件路径。实测 5.1MB 图用 http:// 能正常发（请求体几十字节）。
  //
  // 所以桥接现在：Buffer ≤1.4MB 走 base64（最简单），超过则起一次性回环 HTTP 服务托管。
  // 这意味着 MCP 侧**不需要压缩**（除极端大图），用户要的"尽量不压缩"得以满足。
  check('桥接对大 Buffer 改用临时 HTTP 托管（绕开 2MB 请求体上限）',
    /serveTempImage/.test(mainBridge) && /MAX_INLINE_BYTES = 1_400_000/.test(mainBridge));
  check('临时服务只监听回环 + 随机路径 + 只回一张图',
    /listen\(0, '127\.0\.0\.1'/.test(mainBridge) && /randomBytes\(16\)/.test(mainBridge));
  check('临时服务发完即关（finally 里 close）', /\} finally \{[\s\S]{0,400}tempHost\.close\(\)/.test(mainBridge));
  check('MCP 侧不再因 2MB 压缩（只在 6MB 以上兜底）', /HARD_LIMIT = 6 \* 1024 \* 1024/.test(mcp));
  check('压缩实现仍保留（极端大图兜底）', /shrinkForPublish/.test(mcp) && /shrinkForPublish/.test(
    fs.readFileSync(path.join(root, 'plugins', 'upscale', 'lib', 'upscale.js'), 'utf8')));
  check('压缩优先保分辨率（先降质量再降尺寸）', (() => {
    const s = fs.readFileSync(path.join(root, 'plugins', 'upscale', 'lib', 'upscale.js'), 'utf8');
    const qIdx = s.indexOf('for (const q of [3, 6, 10])');
    const sIdx = s.indexOf('force_original_aspect_ratio=decrease');
    return qIdx > 0 && sIdx > qIdx; // 降质量在前，缩尺寸在后
  })());
  // 请求体上限：全局 1MB，仅超分回传路由放宽
  check('第一跳：超分回传路由放宽请求体上限', /BIG_BODY_ROUTES[\s\S]{0,200}send-upscaled/.test(bridge));
  check('第一跳：其它路由仍受 1MB 限制', /: 1_000_000;/.test(bridge));
  check('第一跳：放宽有硬上限（不得超过 8MB）', /Math\.min\(8_000_000/.test(bridge));
  check('注释记录 2MB 是 SnowLuma 写死的（不是我们能配的）',
    /2 \* 1024 \* 1024/.test(mainBridge) && /readRequestBody/.test(mainBridge));
  // 输入上限必须放得下手机照片（原先 1200 把真实用例全拒了）
  check('输入上限不再卡在 1200（手机照片能超分）', /MAX_INPUT_EDGE = 4000/.test(
    fs.readFileSync(path.join(root, 'plugins', 'upscale', 'lib', 'upscale.js'), 'utf8')));
  // 工具名 fallback 给模型的解释必须覆盖主要失败原因
  for (const reason of ['no-upscayl-bin', 'no-model', 'input-too-large']) {
    check(`失败原因有中文解释：${reason}`, mcp.includes(`'${reason}'`));
  }
}

// ── 5. 磁盘缓存与定时清理（2026-10-19 用户要求「超分后的结果本地缓存应当定时清理」）──
//
// 缓存解决的是"同一张图反复超分"（群友重发同一个表情包、模型对同一条消息看两次、
// 桥接重启后重新处理未读），实测命中后从 3 秒降到 1 毫秒。
// 清理解决的是"只增不减"——一张 1568×2583 的超分 PNG 有 3~7MB。
console.log('\n── 5. 磁盘缓存与清理 ──');
{
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-cache-'));
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-src-'));
  configureUpscaleCache(cacheDir);
  check('configureUpscaleCache 生效', upscaleCacheDir() === cacheDir, upscaleCacheDir());

  const mkImg = (w, h, name) => {
    const f = path.join(srcDir, name);
    spawnSync('python', ['-c', `from PIL import Image, ImageDraw
im=Image.new('RGB',(${w},${h}),(235,235,240)); d=ImageDraw.Draw(im)
d.text((8,8),'${name}',fill=(30,30,30))
im.save(${JSON.stringify(f)})`]);
    return fs.readFileSync(f);
  };

  const listCache = () => {
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(cacheDir, { withFileTypes: true }); } catch {}
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let files = [];
      try { files = fs.readdirSync(path.join(cacheDir, d.name)); } catch { continue; }
      for (const f of files) {
        const p = path.join(cacheDir, d.name, f);
        try { out.push({ path: p, size: fs.statSync(p).size }); } catch {}
      }
    }
    return out;
  };

  if (!bin || !models.length) {
    skipped('缓存命中', '本机未安装 Upscayl');
    skipped('缓存键区分图片/模型', '本机未安装 Upscayl');
    skipped('按年龄清理', '本机未安装 Upscayl');
  } else {
    const imgA = mkImg(200, 100, 'a.png');
    const imgB = mkImg(240, 120, 'b.png');

    // 首次：未命中，并写入缓存
    resetUpscaleState();
    const t0 = Date.now();
    const first = await upscaleImage(imgA, { mimeType: 'image/png', force: true, cache: true });
    const firstMs = Date.now() - t0;
    check('首次超分未命中缓存', first.upscaled === true && first.cached !== true, `cached=${first.cached}`);
    const afterFirst = listCache().length;
    check('首次超分后写入缓存', afterFirst === 1, `${afterFirst} 个文件`);

    // 二次：命中，且明显更快
    const t1 = Date.now();
    const second = await upscaleImage(imgA, { mimeType: 'image/png', force: true, cache: true });
    const secondMs = Date.now() - t1;
    check('同一张图二次命中缓存', second.cached === true, `cached=${second.cached}`);
    check('缓存命中显著更快（<100ms，首次通常 2~10s）', secondMs < 100, `首次 ${firstMs}ms / 命中 ${secondMs}ms`);
    check('命中返回的图与首次一致（尺寸）', second.to === first.to, `${first.to} vs ${second.to}`);
    check('命中不重复写缓存', listCache().length === 1, `${listCache().length} 个文件`);

    // 不同图片 → 不同键
    const other = await upscaleImage(imgB, { mimeType: 'image/png', force: true, cache: true });
    check('不同图片不误命中缓存', other.cached !== true);
    check('不同图片各自入库', listCache().length === 2, `${listCache().length} 个文件`);

    // 不同模型 → 不同键（同一张图）
    const otherModel = await upscaleImage(imgA, { mimeType: 'image/png', force: true, model: 'upscayl-lite-4x', cache: true });
    check('换模型不误命中缓存', otherModel.cached !== true);
    check('不同模型各自入库', listCache().length === 3, `${listCache().length} 个文件`);

    // cache:false 时不读也不写
    const before = listCache().length;
    const noCache = await upscaleImage(imgA, { mimeType: 'image/png', force: true, cache: false });
    check('cache:false 时不命中', noCache.cached !== true);
    check('cache:false 时不写缓存', listCache().length === before, `${listCache().length} 个文件`);

    // 按年龄清理：把 now 推到 5 天后，3 天阈值应全删
    const prAge = pruneUpscaleCache({ maxAgeDays: 3, maxBytes: 500 * 1024 * 1024, now: Date.now() + 5 * 86400000 });
    check('按年龄清理：超期文件被删', prAge.removed === before && prAge.kept === 0, `删 ${prAge.removed} 留 ${prAge.kept}`);
    check('按年龄清理后目录为空', listCache().length === 0);

    // 按大小清理：重建两个，用极小上限逼它删
    resetUpscaleState();
    await upscaleImage(imgA, { mimeType: 'image/png', force: true, cache: true });
    await upscaleImage(imgB, { mimeType: 'image/png', force: true, cache: true });
    const two = listCache().length;
    const prSize = pruneUpscaleCache({ maxAgeDays: 0, maxBytes: 1 });
    check('按大小清理：超限时删除', prSize.removed === two, `删 ${prSize.removed} / 共 ${two}`);
    check('按大小清理后目录为空', listCache().length === 0);

    // 安全默认：两个阈值都不设时什么都不删
    resetUpscaleState();
    await upscaleImage(imgA, { mimeType: 'image/png', force: true, cache: true });
    const prSafe = pruneUpscaleCache({ maxAgeDays: 0, maxBytes: 0 });
    check('不设阈值时不清空（安全默认）', prSafe.removed === 0 && prSafe.kept >= 1, `删 ${prSafe.removed}`);

    // clearUpscaleCache
    const cl = clearUpscaleCache();
    check('clearUpscaleCache 清空全部', listCache().length === 0 && cl.removed >= 1, `删 ${cl.removed} 个`);
    check('清空后子目录也被移除', (() => {
      try { return fs.readdirSync(cacheDir, { withFileTypes: true }).every((d) => !d.isDirectory()); } catch { return false; }
    })());
  }

  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
}

// ── 6. 主动功能语义（2026-10-19 用户要求「我需要的超分就是主动功能」）──
//
// 仅让模型"自己判断细节看不清"才用是不够的：群友说「帮我超分」时必须能触发。
// 三处都要通，缺一处群友就得不到响应：
//   ① 工具描述写明"群友明确要求时一定要调"（否则模型会以为只有看不清才用）
//   ② preset 里告诉模型有这能力（否则它根本不知道工具存在）
//   ③ 功能菜单图里列出来（否则群友不知道能要）
console.log('\n── 6. 主动功能语义 ──');
{
  const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
  const srcRoot = path.join(root, 'src');
  const mcp = fs.readFileSync(path.join(root, 'plugins', 'upscale', 'mcp-tools.js'), 'utf8');
  const preset = fs.readFileSync(path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');
  const menuSrc = fs.readFileSync(path.join(root, 'plugins', 'media-tools', 'lib', 'feature-menu.js'), 'utf8');

  // ① 工具描述：必须把"群友明确要求"列为首要触发条件
  check('工具描述强调群友明确要求时必调', /群友明确要求/.test(mcp) && /这是\*\*点名要的功能\*\*/.test(mcp));
  check('工具描述列出群友会说的原话（超分/放大/高清等）',
    /帮我超分/.test(mcp) && /放大一下/.test(mcp) && /来个高清/.test(mcp));
  check('工具描述禁止回"我做不到"', /不要回"我做不到"/.test(mcp));
  check('工具描述说明即使觉得没必要也照做', /即使原图看着还行/.test(mcp));
  check('工具描述区分"群友要图"与"自己看清"（publish 语义）',
    /群友主动要求超分时应为 true/.test(mcp));

  // ② preset：告诉模型有这个能力
  check('preset 提到超分能力', /超分/.test(preset));
  check('preset 列出 qq_upscale_image 工具', /qq_upscale_image/.test(preset));
  check('preset 说明群友点名时要直接调', /明确点名的功能，直接调/.test(preset));
  check('preset 提醒不要回"我只有收藏和发送"', /我只有收藏和发送/.test(preset));

  // ③ 功能菜单：群友要能看见
  check('功能菜单列出超分放大', /k: '超分放大'/.test(menuSrc));
  check('菜单文案给出说法示例', /帮我超分\/放大一下\/来个高清的/.test(menuSrc));

  // 菜单可用性判定：必须真的检查 Upscayl 是否安装（列了却做不了比不列更糟）
  const { featureMenuSections } = await import('../plugins/media-tools/lib/feature-menu.js');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const withUpscale = featureMenuSections(cfg).find((s) => s.id === 'image');
  const hasItem = (sec) => !!sec?.items.some((i) => i.k === '超分放大');

  if (bin) {
    check('装了 Upscayl 时菜单显示超分', hasItem(withUpscale), withUpscale?.items.map((i) => i.k).join('/'));
  } else {
    skipped('装了 Upscayl 时菜单显示超分', '本机未安装 Upscayl');
  }

  // 把 binDir 指向不存在的路径 → 菜单必须隐藏该项
  const badCfg = JSON.parse(JSON.stringify(cfg));
  badCfg.socialV2 = badCfg.socialV2 || {};
  badCfg.socialV2.upscale = { ...(badCfg.socialV2.upscale || {}), binDir: path.join(os.tmpdir(), 'no-upscayl-here', 'bin') };
  const withoutUpscale = featureMenuSections(badCfg).find((s) => s.id === 'image');
  check('没装 Upscayl 时菜单不显示超分（列了却做不了更糟）', !hasItem(withoutUpscale));

  // 配置关闭时也不显示
  const offCfg = JSON.parse(JSON.stringify(cfg));
  offCfg.socialV2.upscale = { ...(offCfg.socialV2.upscale || {}), enabled: false };
  check('配置关闭超分时菜单不显示', !hasItem(featureMenuSections(offCfg).find((s) => s.id === 'image')));
}

// ── 7. 缓存接线（源码级）──
console.log('\n── 6. 缓存接线 ──');
{
  const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
  const srcRoot = path.join(root, 'src');
  const up = fs.readFileSync(path.join(root, 'plugins', 'upscale', 'lib', 'upscale.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(srcRoot, 'bridge.js'), 'utf8');
  const upscalePlugin = fs.readFileSync(path.join(root, 'plugins', 'upscale', 'index.js'), 'utf8');
  const mcp = fs.readFileSync(path.join(root, 'plugins', 'upscale', 'mcp-tools.js'), 'utf8');

  check('缓存键含原图哈希 + 模型 + 目标宽度', /cacheKey[\s\S]{0,300}sha256[\s\S]{0,200}model[\s\S]{0,80}targetWidth/.test(up));
  check('缓存写盘是原子写（先临时名再 rename）', /writeFileSync\(tmp, buf\)[\s\S]{0,120}renameSync\(tmp, file\)/.test(up));
  check('缓存读取校验 PNG 头（损坏文件按未命中处理）', /buf\[0\] === 0x89[\s\S]{0,120}unlinkSync\(file\)/.test(up));
  check('命中时刷新 mtime（常用图不被优先淘汰）', /utimesSync\(file/.test(up));
  check('写入时按次数触发清理', /cacheWrites % CACHE_DEFAULTS\.sweepEveryWrites/.test(up));
  check('插件启动时配置缓存目录', /configureUpscaleCache/.test(upscalePlugin));
  check('插件启动时清理一次', /pruneUpscaleCache\(\{/.test(upscalePlugin));
  check('插件里有定时清理定时器', /setInterval\([\s\S]{0,400}pruneUpscaleCache/.test(upscalePlugin));
  check('定时器 unref（不阻止进程退出）', /timer\.unref\?\.\(\)/.test(upscalePlugin));
  const { createProcessPluginRuntime } = await import('../src/plugins/process-runtime.js');
  const processRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'upscale-process-'));
  fs.writeFileSync(path.join(processRoot, 'package.json'), '{"version":"0.6.0"}');
  fs.writeFileSync(path.join(processRoot, 'config.json'), JSON.stringify({ socialV2: { upscale: { binDir: '__missing__' } } }));
  const processRuntime = await createProcessPluginRuntime({ root: processRoot, only: ['upscale'], dirs: [path.join(root, 'plugins')] });
  try {
    check('独立进程通过宿主启动超分', !!processRuntime.upscale());
    check('独立进程使用宿主默认缓存目录', fs.existsSync(path.join(processRoot, 'state', 'upscale-cache')));
  } finally {
    await processRuntime.stop(); fs.rmSync(processRoot, { recursive: true, force: true });
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const uc = cfg.socialV2?.upscale ?? {};
  check('配置里 maxAgeDays = 3', Number(uc.cache?.maxAgeDays) === 3, String(uc.cache?.maxAgeDays));
  check('配置里 maxBytes = 500MB', Number(uc.cache?.maxBytes) === 500 * 1024 * 1024, String(uc.cache?.maxBytes));
  check('缓存默认开启', uc.cache?.enabled !== false);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}`);
process.exit(fail === 0 ? 0 : 1);
