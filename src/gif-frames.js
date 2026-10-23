// GIF 动图抽帧拼图：把多帧动图抽成若干关键帧，横向拼成一张静态图。
//
// 背景：多模态模型接到的 image part 若是 GIF，实际只能看到**第一帧**（已实测：
// 首帧换成绿色，模型就答绿色）。群里流行的动图表情包，笑点经常在后面几帧，
// 只给首帧会完全接不到梗。所以这里在桥接侧把动图抽帧拼图后再作为静态图送出。
//
// 设计取舍：
//   - 帧数上限 20（默认）：等间隔抽取，抽不满就取全部帧。帧数多能更好体现动作，
//     代价是拼图更宽——所以单帧宽度要相应调小（见 tileWidth 的说明）。
//   - 均匀采样而非取前 N 帧：动图的关键动作常在中后段（先平静后突变），
//     只取开头会丢掉笑点。
//   - 失败一律降级为 null（调用方退回原 GIF）：抽帧是增强，不该让整条
//     图片链路失败。ffmpeg 不存在、超时、GIF 只有一帧等情况都走降级。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 15000;

/** 在 PATH 与常见安装位置里找 ffmpeg/ffprobe，找到返回绝对路径，否则 null。 */
function resolveBinary(name) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  const dirs = [
    ...String(process.env.PATH ?? '').split(path.delimiter),
    process.env.FFMPEG_DIR,
    'C:\\Program Files\\ffmpeg\\bin',
    'C:\\ffmpeg\\bin',
    '/usr/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin'
  ].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

let cachedFfmpeg;
let cachedFfprobe;
export function findFfmpeg() {
  if (cachedFfmpeg === undefined) cachedFfmpeg = resolveBinary('ffmpeg');
  return cachedFfmpeg;
}
export function findFfprobe() {
  if (cachedFfprobe === undefined) cachedFfprobe = resolveBinary('ffprobe');
  return cachedFfprobe;
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
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
        stderr: Buffer.concat(err).toString('utf8').slice(-800)
      });
    });
  });
}

/** 读取动图帧数（失败返回 0）。 */
export async function probeFrameCount(buf, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ffprobe = findFfprobe();
  if (!ffprobe) return 0;
  const tmp = writeTemp(buf, '.gif');
  try {
    const r = await run(ffprobe, [
      '-v', 'error',
      '-count_frames',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames',
      '-of', 'default=nokey=1:noprint_wrappers=1',
      tmp
    ], timeoutMs);
    if (!r.ok) return 0;
    const n = Number(String(r.stdout).trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } finally {
    cleanup(tmp);
  }
}

function writeTemp(buf, ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqgif-'));
  const file = path.join(dir, `in${ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

function cleanup(file) {
  try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch {}
}

/**
 * 等间隔采样 frameCount 帧并横向拼成一张 PNG。
 *
 * 采样规则（按需求）：
 *   - 帧数**超过 20** 时，等间隔抽 20 帧（含首尾，保证起止都在）
 *   - 帧数**不足 20** 时，**全部帧都取**（不做丢帧）
 *
 * @returns {Promise<{buffer: Buffer, frames: number, kept: number}|null>} 失败返回 null
 */
export async function tileGifFrames(buf, opts = {}) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return null;
  const maxFrames = Math.max(2, Math.min(20, Number(opts.maxFrames) || 20));
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;

  const total = await probeFrameCount(buf, timeoutMs);
  // 单帧或不认识帧数：不值得拼，交给调用方按原图处理。
  if (total <= 1) return null;

  const kept = Math.min(maxFrames, total);
  // 等间隔采样：总帧数多于采样数时，按下标等距取（含首尾）。
  const indices = [];
  if (kept >= total) {
    // 不足上限：全取
    for (let i = 0; i < total; i++) indices.push(i);
  } else {
    for (let i = 0; i < kept; i++) {
      indices.push(Math.round((i * (total - 1)) / (kept - 1)));
    }
  }

  // ── 排布：多行网格，而不是一条横向长条 ────────────────────────────────
  //
  // 为什么改（2026-10-18 群友反馈）：原先固定排成 `kept × 1` 一行，
  // 20 帧时是 2400×120 —— 宽高比 20:1 的"细长条"。视觉模型会把长边缩到约
  // 1568px，于是每帧只剩 78px 宽、高度同比缩到 78px 上下，人脸/表情全糊成色块，
  // 模型只能说"一个戴帽子的金发小人在晃"。**帧数越多反而越看不清**，这与
  // "多抽几帧看得更准"的初衷正好相反。
  //
  // 现在按网格排：目标是整张图接近方形（宽高比 ≤ 2:1），单帧尽量大。
  // 帧数少时仍是一行（5 帧不必排成 3+2）；20 帧时约 5×4。
  const requested = Number(opts.tileWidth) || 320;
  const cols = Math.max(1, Math.min(kept, Math.ceil(Math.sqrt(kept))));
  const rows = Math.ceil(kept / cols);
  // 单帧宽度：整图宽 = cols × tileWidth，控制在 ~1600px 内，
  // 这样输出落在视觉模型的有效输入边长（约 1568）附近，不必再被缩一次。
  const ideal = Math.floor(1600 / cols);
  const tileWidth = Math.max(48, Math.min(Math.min(640, requested), ideal));
  // 拼图要求帧数正好填满 cols×rows；不足时补黑帧，否则 ffmpeg 不会输出完整网格。
  const pad = cols * rows - kept;

  const tmpIn = writeTemp(buf, '.gif');
  const outPng = path.join(path.dirname(tmpIn), 'tiled.png');
  try {
    const selectExpr = indices.map((i) => `eq(n\\,${i})`).join('+');
    // tile 过滤器要求输入帧数正好填满 cols×rows，多一帧少一帧都会让输出异常。
    // 不足时用 tpad 补**克隆帧**（重复最后一帧）：比黑块更不容易被模型误读成"动作停住"，
    // 且最后一帧本来就是动作终点，重复它视觉上最自然。
    const padFilter = pad > 0 ? `,tpad=stop_mode=clone:stop=${pad}` : '';
    const filter = `select='${selectExpr}',scale=${tileWidth}:-1:flags=lanczos${padFilter},tile=${cols}x${rows}`;

    // 先输出 PNG（无损），再按体积决定是否转 JPEG。
    //
    // 为什么需要（2026-10-18 实测真实群里的 10.8MB / 135 帧动图）：
    // 拼图 PNG 是 **3MB**，base64 后 4MB —— 正是当初让 DSH 侧
    // "Maximum call stack size exceeded" 的量级（见 image-downscale.js 顶部）。
    // 照片类动图（真人表情包）PNG 几乎压不动，而转 JPEG q:v=6 后只有 184KB、体积降 94%，
    // 画质对这种用途完全够（实测表情/文字都清楚）。
    //
    // 阈值取 1.2MB：低于此的拼图（多为简单/纯色动图）保留 PNG 无损；
    // 超过就转 JPEG，避免把 4MB 的 base64 送进下游。
    const JPEG_CONVERT_THRESHOLD_BYTES = 1.2 * 1024 * 1024;
    const r = await run(ffmpeg, [
      '-y', '-v', 'error',
      '-i', tmpIn,
      '-vf', filter,
      '-frames:v', '1',
      outPng
    ], timeoutMs);
    if (!r.ok) return null;
    let out = fs.readFileSync(outPng);
    if (!out?.length) return null;

    let mimeType = 'image/png';
    if (out.length > JPEG_CONVERT_THRESHOLD_BYTES) {
      const outJpg = path.join(path.dirname(tmpIn), 'tiled.jpg');
      const cj = await run(ffmpeg, [
        '-y', '-v', 'error',
        '-i', outPng,
        '-q:v', '6',
        '-frames:v', '1',
        outJpg
      ], timeoutMs);
      if (cj.ok && fs.existsSync(outJpg)) {
        const jpg = fs.readFileSync(outJpg);
        // 只有确实更小才换（极少数情况 JPEG 反而更大，如大面积纯色）
        if (jpg.length && jpg.length < out.length) {
          out = jpg;
          mimeType = 'image/jpeg';
        }
      }
    }

    return { buffer: out, mimeType, frames: total, kept, tileWidth, cols, rows };
  } catch {
    return null;
  } finally {
    cleanup(tmpIn);
  }
}

/** 是不是多帧动图（帧数 > 1）。失败按 false 处理（当静态图）。 */
export async function isAnimated(buf, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!isGifBuffer(buf)) return false;
  const n = await probeFrameCount(buf, timeoutMs);
  return n > 1;
}

/** GIF 魔数判定（避免对被误标成 gif 的静态图跑 ffmpeg）。 */
export function isGifBuffer(buf) {
  if (!buf || buf.length < 6) return false;
  const head = buf.toString('ascii', 0, 6);
  return head === 'GIF87a' || head === 'GIF89a';
}

/**
 * 抽帧拼图的注入文案（桥接与 MCP 工具共用，避免两处措辞漂移）。
 *
 * 措辞为什么这么强、又为什么**整段不能出现「格」字**：
 *   - 早先只说「横向拼接」时，模型把拼图读成「几个静止的并排物体」
 *     （移动的红球被理解成"四个球排一排"）。
 *   - 后来改成「连拍分解图、横向 N 格、逐格比对」，模型不再当并排物体了，
 *     但开始**在回答里说"第 3 格""每一格"**——群友看到的是"这机器人怎么一格一格的"，
 *     很出戏。
 *   - 所以现在把它描述成**一张动图的连续画面**，并且**连"不要用某字"这种提醒
 *     也不用那个字**（提了反而会被模型学去用）。测试里锁死了「文案不含该字」。
 *
 * 2026-10-18 排布从单行改成网格（见 tileGifFrames 的说明），文案要跟着改：
 *   - 阅读顺序变成"从左到右、一行读完接下一行"，必须说清楚，否则模型会按
 *     横向一路读下去、把第二行当成时间更晚的独立事件。
 *   - 补帧（奇数帧）会克隆最后一帧，也要说明，免得模型以为"动作最后重复了一次"。
 */
export function gifFramesHint(index, tiled) {
  const n = Number(tiled?.kept) || 0;
  const total = Number(tiled?.frames) || 0;
  const cols = Number(tiled?.cols) || 0;
  const rows = Number(tiled?.rows) || 0;
  const sampled = total > n && n > 0 ? `（原动图共 ${total} 帧，这里等间隔取了 ${n} 帧）` : '';
  const layout = cols > 1 && rows > 1
    ? `按时间顺序排成 ${rows} 行、每行 ${cols} 个画面：先从左到右读完第一行，再读下一行，直到最后一行`
    : '按时间顺序从左到右排开';
  const padded = cols > 1 && rows > 1 && cols * rows > n
    ? `（末尾空缺处是重复的最后一帧，只为把版面补齐，不代表动作重复）`
    : '';
  return `[动图${index}：这是一张动图，为了方便你查看，已把它的连续画面${layout}${sampled}——起点是最早的一瞬，终点是最晚的一瞬${padded}。请把它当作**同一个场景、同一个对象在时间上的连续动作**来理解（想象它在播放），对比画面之间的变化：位置、形态、表情、文字有什么不同，从而说出这个动图在做什么、笑点或重点在哪。注意这不是并排的几个不同物体，而是同一个动作的不同瞬间。回答时请直接把它当成一个动图来描述（例如「它一开始…然后…最后…」），就像你在看它播放一样，不要说成一张被切开的静态长条。]`;
}
