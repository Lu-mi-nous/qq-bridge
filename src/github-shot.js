// GitHub 仓库首页整页截图（CDP）。
//
// 需求（2026-10-20 用户）：「加一个功能能够解析 GitHub 链接并且把仓库首页整个截图并发送」。
//
// ── 为什么不用 Chrome CLI 的 --screenshot ─────────────────────────────────
//
// 功能菜单那边用的是 `--screenshot` + 先 `--dump-dom` 量高度（见 feature-menu-render.js）。
// 那套对**自己生成的静态 HTML** 可行（页面高度写在 `data-h` 里），但对 GitHub 不行：
//   ① 外部页面没法预埋 `data-h`，`--dump-dom` 拿不到渲染高度（DOM 里没有这个信息）；
//   ② 固定 `--window-size` 只能截一屏，GitHub 首页要往下滚好几屏才有 README；
//   ③ 高度随宽度变化（响应式），猜一个值必然留白或截断。
//
// 所以这里走 **CDP（Chrome DevTools Protocol）**：`--remote-debugging-port=0` 起一个
// headless Chrome，用 `Page.getLayoutMetrics` 拿真实内容尺寸，再
// `Emulation.setDeviceMetricsOverride` 把视口设成整页大小截一张。这是浏览器官方支持的
// full-page 做法，不依赖任何第三方库（Node 22+ 自带 WebSocket）。
//
// ── 网络 ────────────────────────────────────────────────────────────────
//
// 实测本机**直连 github.com 会 ECONNRESET**，必须经代理（127.0.0.1:7897）。
// 所以浏览器要带 `--proxy-server`，否则截出来是 Chrome 的网络错误页。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { findBrowser } from './feature-menu-render.js';

/** 只接受 github.com 的仓库/用户主页形态，其余一律拒绝（防把它当通用截图器）。 */
export function parseGitHubUrl(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  // 允许只给 owner/repo 这种简写
  const bare = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(s);
  if (bare) return { owner: bare[1], repo: bare[2], url: `https://github.com/${bare[1]}/${bare[2]}` };

  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (!parts.length) return null;

  const reserved = new Set([
    'features', 'topics', 'collections', 'trending', 'events', 'sponsors',
    'about', 'pricing', 'login', 'join', 'signup', 'settings', 'explore',
    'marketplace', 'notifications', 'issues', 'pulls', 'search', 'orgs', 'users'
  ]);
  if (reserved.has(parts[0].toLowerCase())) return null;

  const owner = parts[0];
  const repo = parts[1] && !['issues', 'pulls', 'tree', 'blob', 'releases', 'actions', 'wiki', 'settings'].includes(parts[1])
    ? parts[1].replace(/\.git$/i, '')
    : '';
  // 只截仓库首页 / 用户主页；带子路径（/issues、/tree/main/src）一律归到首页，
  // 因为需求是"仓库首页整个截图"。
  return {
    owner,
    repo,
    url: repo ? `https://github.com/${owner}/${repo}` : `https://github.com/${owner}`,
    // 原始输入里的子路径（仅用于说明，不影响截图目标）
    subpath: parts.slice(2).join('/')
  };
}

/** 从聊天文本里抠出第一个 GitHub 链接。 */
export function extractGitHubUrl(text) {
  const m = /https?:\/\/(?:www\.)?github\.com\/[^\s<>"'）)】\]，。；、]+/i.exec(String(text ?? ''));
  return m ? m[0].replace(/[.,;:!?]+$/, '') : '';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 最小 CDP 客户端：连 WebSocket，按 id 收发命令。
 *
 * 为什么手写：项目没有 ws / puppeteer 依赖，而 Node 22 自带 WebSocket。
 * 这里只需要 4 个命令（Page.navigate / getLayoutMetrics / setDeviceMetricsOverride /
 * captureScreenshot），没必要为它引一整个浏览器自动化框架。
 */
function cdpConnect(wsUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let seq = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error(`CDP 连接超时（${timeoutMs}ms）`));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        send(method, params = {}, cmdTimeoutMs = 60000) {
          return new Promise((res, rej) => {
            const id = ++seq;
            const t = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP 命令超时：${method}`));
            }, cmdTimeoutMs);
            pending.set(id, { res, rej, t });
            try {
              ws.send(JSON.stringify({ id, method, params }));
            } catch (e) {
              clearTimeout(t);
              pending.delete(id);
              rej(e);
            }
          });
        },
        close() { try { ws.close(); } catch {} }
      });
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (!msg.id) return; // 事件通知，忽略
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.t);
      if (msg.error) p.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.res(msg.result);
    });

    ws.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('CDP WebSocket 连接失败'));
    });
    ws.addEventListener('close', () => {
      for (const [, p] of pending) { clearTimeout(p.t); p.rej(new Error('CDP 连接已关闭')); }
      pending.clear();
    });
  });
}

/** 起一个 headless Chrome，返回 { browser, port, kill }。 */
async function launchChrome(extraArgs = []) {
  const bin = findBrowser();
  if (!bin) throw new Error('未找到 Chrome/Edge，无法截图（可设环境变量 CHROME_PATH）');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghshot-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    // port=0 让系统分配，再从 stderr 的 DevTools listening 行读回来（避免端口冲突）
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    ...extraArgs,
    'about:blank'
  ];
  const child = spawn(bin, args, { windowsHide: true });
  let stderr = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`启动 Chrome 超时：${stderr.slice(-200)}`)), 30000);
    const onData = (d) => {
      stderr += d.toString();
      const m = /DevTools listening on ws:\/\/[^:/]+:(\d+)\//.exec(stderr);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome 退出（code=${code}）：${stderr.slice(-200)}`));
    });
  }).catch((e) => { try { child.kill(); } catch {} ; throw e; });

  const kill = () => {
    try { child.kill(); } catch {}
    // profile 目录删不掉也无所谓（临时目录），但尽量清
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 1000);
  };
  return { browser: child, port, kill, profile };
}

/**
 * 截一张整页图。
 *
 * @param {string} url 目标 URL（必须是 http/https）
 * @param {object} opts
 *   - proxy       HTTP 代理（如 http://127.0.0.1:7897）；GitHub 在本机直连不通
 *   - width       视口宽度（默认 1400；GitHub 在 <1000 时是移动布局）
 *   - maxHeight   整页高度上限（默认 12000；超高的图 QQ 会压到看不清）
 *   - sliceHeight 分段高度（见下）；0 = 不切
 *   - waitMs      首屏等待（默认 3500，等 README 懒加载）
 *   - timeoutMs   总超时
 */

/**
 * 整页高度上限与分段策略。
 *
 * 为什么必须分段（2026-10-20 实测）：GitHub 首页整页约 **15400px**。
 * QQ 预览图会按宽度等比缩放，1400×15400 缩到聊天窗口宽度后每行文字只有 1~2 像素高，
 * 群友看到的就是一条灰色细线——等于没截。实测 1400×12000 / 3MB 的图就是这个效果。
 *
 * 所以按 `sliceHeight` 切成若干张，每张控制在"宽 1400、高 ≤2400"这个可读比例
 * （约 1.7:1 的竖条，文字仍能辨认）。每张单独可读，按顺序看就是完整页面。
 */
const DEFAULT_SLICE_HEIGHT = 2400;

export async function screenshotPage(url, opts = {}) {
  const target = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('只支持 http/https 链接');
  const width = Math.max(320, Math.min(2400, Number(opts.width) || 1400));
  const maxHeight = Math.max(400, Math.min(30000, Number(opts.maxHeight) || 12000));
  const sliceHeight = Math.max(0, Math.min(8000, Number(opts.sliceHeight ?? DEFAULT_SLICE_HEIGHT) || 0));
  const waitMs = Math.max(0, Math.min(20000, Number(opts.waitMs) || 3500));
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || 90000);
  const proxy = String(opts.proxy || '').trim();

  const chromeArgs = [];
  if (proxy) chromeArgs.push(`--proxy-server=${proxy}`);
  // 直连不可达时不要死等（GitHub 会一直挂到超时）
  chromeArgs.push('--disable-background-networking');

  const started = await launchChrome(chromeArgs);
  let cdp = null;
  try {
    cdp = await cdpConnect(`ws://127.0.0.1:${started.port}/devtools/page/0`, 15000)
      .catch(async () => {
        // 新版 Chrome 的 /devtools/page/0 可能不存在，走 /json/list 找第一个 page
        const list = await fetch(`http://127.0.0.1:${started.port}/json/list`).then((r) => r.json());
        const page = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (!page) throw new Error('找不到可用的页面 target');
        return cdpConnect(page.webSocketDebuggerUrl, 15000);
      });

    await cdp.send('Page.enable', {});
    await cdp.send('Runtime.enable', {});

    // 先定一个普通视口再导航，避免默认 800x600 触发移动布局
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height: 1000, deviceScaleFactor: 1, mobile: false
    }, 30000);

    const navTimeout = Math.min(60000, timeoutMs);
    const nav = await cdp.send('Page.navigate', { url: target }, navTimeout);
    if (nav?.errorText) throw new Error(`打开页面失败：${nav.errorText}`);

    // 等首屏 + README 懒加载。GitHub 的 README 区块是异步渲染的，
    // 只等到 load 事件会截到"还在转圈"的状态。
    await sleep(waitMs);

    // 滚到底再回顶：触发懒加载图片（README 里的截图/徽章）与"Load more"折叠内容。
    try {
      await cdp.send('Runtime.evaluate', {
        expression: `(async () => {
          const step = Math.max(400, window.innerHeight * 0.8);
          const max = document.body.scrollHeight;
          for (let y = 0; y < max; y += step) {
            window.scrollTo(0, y);
            await new Promise(r => setTimeout(r, 120));
          }
          window.scrollTo(0, 0);
          await new Promise(r => setTimeout(r, 400));
          return document.body.scrollHeight;
        })()`,
        awaitPromise: true,
        returnByValue: true
      }, 30000);
    } catch { /* 滚动失败不影响截图，只是可能缺懒加载图 */ }

    // 拿真实内容尺寸（CSS 像素）
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, 20000);
    const css = metrics?.cssContentSize || metrics?.contentSize || {};
    const contentW = Math.ceil(Number(css.width) || width);
    const contentH = Math.ceil(Number(css.height) || 1000);
    const shotW = Math.max(width, Math.min(contentW, 2400));
    const cappedH = Math.max(400, Math.min(contentH, maxHeight));

    // 不分段：整页一张（旧行为，留给需要单图的调用方）
    if (!sliceHeight) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: shotW, height: cappedH, deviceScaleFactor: 1, mobile: false
      }, 30000);
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true, fromSurface: true
      }, Math.min(60000, timeoutMs));
      const buffer = Buffer.from(shot?.data || '', 'base64');
      if (!buffer.length) throw new Error('截图为空');
      return {
        buffer, mimeType: 'image/png', width: shotW, height: cappedH,
        contentHeight: contentH, slices: [{ buffer, mimeType: 'image/png', width: shotW, height: cappedH, fromY: 0 }],
        truncated: contentH > cappedH, finalUrl: target
      };
    }

    // 分段截图：每张截一个高度窗口。
    // 用 `Page.captureScreenshot` 的 clip 参数指定区域，而不是改视口大小——
    // 改视口会触发响应式重排（GitHub 在不同高度下会重新布局），导致各段内容错位。
    const slices = [];
    for (let y = 0; y < cappedH; y += sliceHeight) {
      const h = Math.min(sliceHeight, cappedH - y);
      if (h < 100) break; // 末尾太薄的碎片不值得单独发
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y, width: shotW, height: h, scale: 1 },
        captureBeyondViewport: true,
        fromSurface: true
      }, Math.min(60000, timeoutMs));
      const buf = Buffer.from(shot?.data || '', 'base64');
      if (!buf.length) continue;
      slices.push({ buffer: buf, mimeType: 'image/png', width: shotW, height: h, fromY: y });
    }
    if (!slices.length) throw new Error('截图为空');

    return {
      buffer: slices[0].buffer,
      mimeType: 'image/png',
      width: shotW,
      height: cappedH,
      contentHeight: contentH,
      slices,
      truncated: contentH > cappedH,
      finalUrl: target
    };
  } finally {
    try { cdp?.close(); } catch {}
    started.kill();
  }
}

/**
 * 截 GitHub 仓库首页（含简介与 README）。
 *
 * @param {object|string} target parseGitHubUrl 的结果，或原始链接
 * @returns {Promise<{buffer:Buffer, info:object}>}
 */
export async function screenshotGitHubRepo(target, opts = {}) {
  const info = typeof target === 'string' ? parseGitHubUrl(target) : target;
  if (!info?.url) throw new Error('不是有效的 GitHub 仓库/用户链接');
  const shot = await screenshotPage(info.url, {
    width: 1400,
    maxHeight: 12000,
    waitMs: 3500,
    ...opts
  });
  return { ...shot, info };
}
