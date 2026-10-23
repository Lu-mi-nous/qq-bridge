// 功能菜单渲染：把 HTML 用系统 Chrome/Edge 无头截图成 PNG（含磁盘缓存）。
//
// 浏览器处理中文排版、自动换行与内容测高。最终 HTML 内容变了才重新渲染，
// 群友反复问“你会啥”时复用本地缓存，同内容并发请求只执行一次渲染。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildFeatureMenuHtml } from './feature-menu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CACHE_DIR = path.join(ROOT, 'state', 'feature-menu');
const AVATAR = path.join(ROOT, 'assets', 'deepseek娘.png');

// 菜单宽度固定 1080（见 CSS）。高度由内容决定：先量后截（Chrome CLI 无 full-page）。
// MAX_HEIGHT 是防御上限，防止异常内容把图拉得巨大（QQ 对超高图会压缩到看不清）。
export const MENU_WIDTH = 1080;
const MAX_HEIGHT = 3000;
const inFlight = new Map();

let cachedBrowser = undefined;

/**
 * 找可用的无头浏览器。Chrome 优先，Edge 兜底（Windows 一般至少有一个）。
 * 都找不到时返回 ''，调用方应给出可读报错而不是静默失败。
 */
export function findBrowser() {
  if (cachedBrowser !== undefined) return cachedBrowser;
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  cachedBrowser = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || '';
  return cachedBrowser;
}

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

/**
 * 量出页面真实高度。
 *
 * 为什么需要：Chrome CLI 的 --screenshot **不支持 full-page**，只会截 --window-size 那块。
 * 给固定大高度会留一片空白（实测 3000px 画布装 1400px 内容），
 * 给固定小高度又会截断。所以先跑一次 --dump-dom 把 document 高度读出来，再按真实高度截。
 * 两次启动约 2 秒，但有磁盘缓存兜底（群友反复问「你会啥」时不会重复渲染）。
 *
 * 高度由 HTML 里内联的小脚本写进 <html data-h="...">，这里从 dump 出来的 DOM 里正则取。
 */
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

/** 读形象图并转 data URL（内联后整页自包含，截图不依赖外部文件）。 */
export function avatarDataUrl() {
  try {
    const buf = fs.readFileSync(AVATAR);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

/** CLI 预生成与运行时使用同一份配置；只把角色名和筛选后的文案写入 HTML。 */
export function readFeatureMenuOptions() {
  const read = (relative) => {
    const file = path.join(ROOT, relative);
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  };
  return { config: read('config.json'), roleName: read('state/current-role.json').role || '' };
}

function menuHtml(options = {}) {
  const defaults = options.config === undefined || options.roleName === undefined ? readFeatureMenuOptions() : {};
  return buildFeatureMenuHtml({ ...defaults, ...options, inlineImage: true, imageDataUrl: avatarDataUrl() });
}

function htmlKey(html) {
  // 完整 HTML 包含模板、CSS、文案、头像和实际显示的功能；无关配置不影响缓存。
  return crypto.createHash('sha1').update(`menu-v2:${MENU_WIDTH}:`).update(html).digest('hex').slice(0, 16);
}

export function menuCacheKey(options = {}) {
  return htmlKey(menuHtml(options));
}

function pngInfo(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < 1024 || !buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
    return width === MENU_WIDTH && height > 100 && height <= MAX_HEIGHT ? { bytes: buf.length, width, height } : null;
  } catch { return null; }
}

/**
 * 渲染功能菜单为 PNG，返回文件路径。
 * @param {{force?:boolean, log?:Function, config?:object, roleName?:string}} opts
 * @returns {Promise<{ok:true, file:string, cached:boolean, bytes:number} | {ok:false, error:string}>}
 */
export async function renderFeatureMenu({ force = false, log = () => {}, ...options } = {}) {
  let html;
  try { html = menuHtml(options); } catch (error) { return { ok: false, error: `读取菜单配置失败：${error.message}` }; }
  const key = htmlKey(html);
  const outFile = path.join(CACHE_DIR, `feature-menu-${key}.png`);
  // 有可用缓存时无需浏览器；即使浏览器暂时不可用也能照常发送已生成的图。
  const cached = !force && pngInfo(outFile);
  if (cached) {
    log(`[功能菜单] 命中缓存 ${path.basename(outFile)}`);
    return { ok: true, file: outFile, cached: true, ...cached };
  }
  if (inFlight.has(key)) return inFlight.get(key);
  const task = renderNewMenu(html, outFile, log).catch((error) => ({ ok: false, error: `渲染失败：${error.message}` }));
  inFlight.set(key, task);
  try { return await task; } finally { inFlight.delete(key); }
}

async function renderNewMenu(html, outFile, log) {
  const browser = findBrowser();
  if (!browser) return { ok: false, error: '未找到 Chrome/Edge，无法渲染功能菜单（可设环境变量 CHROME_PATH）' };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // 中间产物与缓存同盘，避免 EXDEV；每次使用独立目录，跨进程也不共用浏览器 profile。
  const renderDir = fs.mkdtempSync(path.join(CACHE_DIR, '.render-'));
  const tmpHtml = path.join(renderDir, 'menu.html');
  const tmpPng = path.join(renderDir, 'menu.png');
  const profile = path.join(renderDir, 'profile');
  try {
  fs.writeFileSync(tmpHtml, html, 'utf8');

  // --headless=new 是当前 Chrome 的推荐写法（旧 --headless 在新版会警告甚至行为不同）。
  // 先量高度再截：Chrome CLI 没有 full-page，固定高度会留白或截断。
  const height = await measureHeight(browser, tmpHtml, MENU_WIDTH, profile);
  if (height <= 100) return { ok: false, error: '无法测量菜单高度，未生成可能被截断的图片' };
  if (height > MAX_HEIGHT) return { ok: false, error: `菜单高度 ${height}px 超过 ${MAX_HEIGHT}px，请精简内容后重试` };

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${MENU_WIDTH},${height}`,
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

  // 原子替换：先写临时再 rename，避免群友读到写了一半的图
  fs.renameSync(tmpPng, outFile);
  log(`[功能菜单] 已渲染 ${path.basename(outFile)}（${Math.round(info.bytes / 1024)}KB）`);
  return { ok: true, file: outFile, cached: false, ...info };
  } finally {
    // 只清理由本函数创建且确定位于缓存目录下的临时目录，不触碰已有 PNG。
    if (path.dirname(path.resolve(renderDir)) === path.resolve(CACHE_DIR) && path.basename(renderDir).startsWith('.render-')) {
      try { fs.rmSync(renderDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
    }
  }
}

/** 读取已渲染的菜单图（没有则渲染后再读）。 */
export async function readFeatureMenuBuffer(opts = {}) {
  const r = await renderFeatureMenu(opts);
  if (!r.ok) throw new Error(r.error);
  return { buffer: fs.readFileSync(r.file), file: r.file, cached: r.cached };
}
