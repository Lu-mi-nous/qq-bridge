// Token 报表渲染：HTML → PNG（Chrome/Edge 无头截图 + 磁盘缓存）。
//
// 复用功能菜单那套「先量高、再按真实高度截」的办法（见 feature-menu-render.js
// 顶部的说明：Chrome CLI 的 --screenshot **不支持 full-page**，固定高度会留白或截断）。
//
// ── 为什么按内容指纹缓存 ────────────────────────────────────────────────
//
// 群友可能一天问几次「用了多少 token」，而数据每 6 小时才更新一次。
// 缓存键 = HTML 内容的 sha1，所以：
//   - 数据没变 → 命中缓存，零渲染开销（一次渲染约 2 秒 + 起一次 Chrome）
//   - 数据变了 → 内容变 → 键变 → 自动重渲染，不需要手动清缓存
// 同一时刻多人并发问，用 inFlight 合并成一次渲染。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBrowser } from './feature-menu-render.js';
import { buildTokenReportHtml } from './token-report-html.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'state', 'token-report');

export const REPORT_WIDTH = 1080;
// 防御上限：模型一多 + 天数一多，高度会涨。超过这个高度 QQ 会把图压得看不清，
// 与其发一张糊的，不如报错让调用方知道要精简。
const MAX_HEIGHT = 4200;

const inFlight = new Map();

function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { windowsHide: true }); } catch (e) { resolve({ ok: false, error: e?.message ?? String(e) }); return; }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, error: `超时(${timeoutMs}ms)` }); }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e?.message ?? String(e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, stdout: out } : { ok: false, error: (err || out || `退出码 ${code}`).slice(0, 300) });
    });
  });
}

/** 量页面真实高度（HTML 里的内联脚本把高度写进 <html data-h="...">）。 */
async function measureHeight(browser, htmlFile, width, profile) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${width},1200`,
    '--dump-dom',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--virtual-time-budget=2000',
    pathToFileURL(htmlFile).href,
  ];
  const r = await run(browser, args, 30000);
  if (!r.ok) return 0;
  const m = /data-h="(\d+)"/.exec(r.stdout || '');
  return m ? Number(m[1]) : 0;
}

/** 校验 PNG 是否可用（防止读到写了一半的文件）。 */
function pngInfo(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < 1024 || !buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width === REPORT_WIDTH && height > 80 && height <= MAX_HEIGHT
      ? { bytes: buf.length, width, height }
      : null;
  } catch { return null; }
}

function htmlKey(html) {
  return crypto.createHash('sha1').update(`token-report-v1:${REPORT_WIDTH}:`).update(html).digest('hex').slice(0, 16);
}

/**
 * 渲染 Token 报表为 PNG。
 *
 * @param {object} report buildTokenReport() 的结果
 * @param {{force?:boolean, title?:string, log?:Function}} opts
 * @returns {Promise<{ok:true,file:string,cached:boolean,bytes:number,width:number,height:number} | {ok:false,error:string}>}
 */
export async function renderTokenReport(report, { force = false, title = '', log = () => {} } = {}) {
  let html;
  try {
    html = buildTokenReportHtml(report, { title });
  } catch (error) {
    return { ok: false, error: `生成报表 HTML 失败：${error?.message ?? error}` };
  }
  const key = htmlKey(html);
  const outFile = path.join(CACHE_DIR, `token-report-${key}.png`);

  // 有缓存时不需要浏览器——浏览器暂时不可用也仍能发出已生成的图
  const cached = !force && pngInfo(outFile);
  if (cached) {
    log(`[Token报表] 命中缓存 ${path.basename(outFile)}`);
    return { ok: true, file: outFile, cached: true, ...cached };
  }
  if (inFlight.has(key)) return inFlight.get(key);

  const task = renderNew(html, outFile, log).catch((error) => ({ ok: false, error: `渲染失败：${error?.message ?? error}` }));
  inFlight.set(key, task);
  try { return await task; } finally { inFlight.delete(key); }
}

async function renderNew(html, outFile, log) {
  const browser = findBrowser();
  if (!browser) return { ok: false, error: '未找到 Chrome/Edge，无法渲染 Token 报表（可设环境变量 CHROME_PATH）' };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // 中间产物与缓存同盘（避免 EXDEV）；每次独立目录，跨进程也不共用 profile
  const renderDir = fs.mkdtempSync(path.join(CACHE_DIR, '.render-'));
  const tmpHtml = path.join(renderDir, 'report.html');
  const tmpPng = path.join(renderDir, 'report.png');
  const profile = path.join(renderDir, 'profile');
  try {
    fs.writeFileSync(tmpHtml, html, 'utf8');

    const height = await measureHeight(browser, tmpHtml, REPORT_WIDTH, profile);
    if (height <= 80) return { ok: false, error: '无法测量报表高度，未生成可能被截断的图片' };
    if (height > MAX_HEIGHT) {
      return { ok: false, error: `报表高度 ${height}px 超过 ${MAX_HEIGHT}px，请减少展示的天数或模型数` };
    }

    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${REPORT_WIDTH},${height}`,
      `--screenshot=${tmpPng}`,
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--virtual-time-budget=2500',
      pathToFileURL(tmpHtml).href,
    ];
    const r = await run(browser, args, 45000);
    if (!r.ok) return { ok: false, error: `渲染失败：${r.error}` };
    if (!fs.existsSync(tmpPng)) return { ok: false, error: '渲染未产出图片文件（浏览器可能不支持 --screenshot）' };

    const info = pngInfo(tmpPng);
    if (!info || info.height !== height) return { ok: false, error: '渲染结果异常（PNG 格式或尺寸不正确）' };

    // 原子替换，避免群友读到写了一半的图
    fs.renameSync(tmpPng, outFile);
    log(`[Token报表] 已渲染 ${path.basename(outFile)}（${Math.round(info.bytes / 1024)}KB）`);
    return { ok: true, file: outFile, cached: false, ...info };
  } finally {
    // 只清理由本函数创建、且确定位于缓存目录下的临时目录
    if (path.dirname(path.resolve(renderDir)) === path.resolve(CACHE_DIR)
      && path.basename(renderDir).startsWith('.render-')) {
      try { fs.rmSync(renderDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
    }
  }
}

/**
 * 清理旧报表缓存。
 *
 * 缓存键包含数据指纹，所以每天都会产生新文件；不清理的话一年下来能攒几千张。
 * 只保留最近 N 个（按 mtime），并顺带删掉超过 maxAgeDays 的。
 */
export function pruneTokenReportCache({ maxFiles = 20, maxAgeDays = 14 } = {}) {
  let names;
  try { names = fs.readdirSync(CACHE_DIR); } catch { return { removed: 0 }; }
  const files = names
    .filter((n) => /^token-report-[0-9a-f]{16}\.png$/.test(n))
    .map((n) => {
      const p = path.join(CACHE_DIR, n);
      try { return { p, st: fs.statSync(p) }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

  const cutoff = Date.now() - Math.max(0, maxAgeDays) * 24 * 3600 * 1000;
  let removed = 0;
  files.forEach((f, i) => {
    if (i < maxFiles && f.st.mtimeMs >= cutoff) return;
    try { fs.rmSync(f.p, { force: true }); removed++; } catch {}
  });
  return { removed };
}
