// x-monitor/media-cache.mjs — 帖子配图的本地缓存（下载 / 复用 / 定期清理）
//
// 为什么需要缓存：
//   - 同一条帖子可能被多次拉取（群友反复要看、或稿件渲染重试），每次重新下载浪费代理流量；
//   - X 的图床（pbs.twimg.com）走代理较慢，缓存后渲染快很多；
//   - 缓存必须**有界**：不清理会无限膨胀（实测一张 large 图约 90KB~500KB）。
//
// 清理策略（沿用项目里图库的 sentTtlMs/sentSweepMs 惯例）：
//   - 按 TTL 删除过期文件（默认 2 小时）；
//   - 兜底：总量或文件数超限时，按访问时间删最旧的；
//   - 定时器 unref()，不阻止进程退出。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { proxyGet } from '../../../src/proxy-tunnel.js';
import { findFfprobe } from '../../../src/gif-frames.js';
import { spawn } from 'node:child_process';

const DEFAULT_DIR = 'state/x-monitor-media';
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;     // 2 小时
const DEFAULT_SWEEP_MS = 5 * 60 * 1000;        // 5 分钟扫一次
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;   // 200MB
const DEFAULT_MAX_FILES = 400;
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;   // 单张上限（X large 图通常 <1MB）

/** 用 ffprobe 读图片尺寸；失败返回 null（调用方按未知尺寸处理）。 */
export function probeImageSize(file) {
  const ffprobe = findFfprobe();
  if (!ffprobe) return Promise.resolve(null);
  return new Promise((resolve) => {
    const p = spawn(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0', file
    ], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      const m = /(\d+)\s*,\s*(\d+)/.exec(out.trim());
      resolve(m ? { width: Number(m[1]), height: Number(m[2]) } : null);
    });
    p.on('error', () => resolve(null));
  });
}

export function createMediaCache({
  root,
  dir = DEFAULT_DIR,
  ttlMs = DEFAULT_TTL_MS,
  sweepMs = DEFAULT_SWEEP_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  proxy = '',
  log = () => {}
} = {}) {
  const absDir = path.isAbsolute(dir) ? dir : path.join(root, dir);
  fs.mkdirSync(absDir, { recursive: true });

  let sweepTimer = null;

  /** 缓存文件名：按 URL 的哈希，保证同图复用、不同图不冲突（扩展名保留以便 ffprobe 识别）。 */
  const fileFor = (url) => {
    const hash = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 20);
    const ext = (() => {
      const m = /\.(jpg|jpeg|png|gif|webp|mp4|mov|webm)(?:\?|$)/i.exec(String(url));
      return m ? `.${m[1].toLowerCase()}` : '.jpg';
    })();
    return path.join(absDir, `${hash}${ext}`);
  };

  /**
   * 取一张图（命中缓存直接返回；否则下载）。
   * @param url      图片地址
   * @param opts.upgradeLarge 是否把 X 的缩略图 URL 升级为 large（默认 true，观感更好）
   * @returns {Promise<{file, width, height, bytes, cached}|null>}
   */
  async function get(url, { upgradeLarge = true, timeoutMs = 30000 } = {}) {
    if (!url) return null;
    const target = upgradeLarge ? upgradeTweetImageUrl(url) : String(url);
    const file = fileFor(target);

    // 命中缓存：更新 mtime（作为"最近使用"标记，供 LRU 清理用）
    if (fs.existsSync(file)) {
      const st = fs.statSync(file);
      if (st.size > 0) {
        const now = new Date();
        try { fs.utimesSync(file, now, now); } catch {}
        const size = await probeImageSize(file);
        return { file, width: size?.width ?? 0, height: size?.height ?? 0, bytes: st.size, cached: true };
      }
    }

    try {
      const r = await proxyGet(target, { proxy, timeoutMs, maxBytes: MAX_DOWNLOAD_BYTES });
      const buf = r.body;
      if (!buf?.length) return null;
      fs.writeFileSync(file, buf);
      const size = await probeImageSize(file);
      return { file, width: size?.width ?? 0, height: size?.height ?? 0, bytes: buf.length, cached: false };
    } catch (e) {
      log(`[x-monitor] 图片下载失败 ${String(url).slice(0, 60)}: ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * 取一个视频文件（命中缓存直接返回；否则下载）。与 get() 分开是因为：
   *   - 体积上限完全不同（图片 12MB 足够，视频默认放到 100MB）；
   *   - 不能对视频 URL 做 upgradeLarge（那是 X 图床的缩略图参数）；
   *   - 下载超时要长得多。
   * @returns {Promise<{file, bytes, cached}|null>}
   */
  async function getVideo(url, { maxBytes: limit = 100 * 1024 * 1024, timeoutMs = 180000 } = {}) {
    if (!url) return null;
    const target = String(url);
    const file = fileFor(target);

    if (fs.existsSync(file)) {
      const st = fs.statSync(file);
      if (st.size > 0) {
        const now = new Date();
        try { fs.utimesSync(file, now, now); } catch {}
        return { file, bytes: st.size, cached: true };
      }
    }

    try {
      // maxBytes 给 4 倍余量：proxyGet 只在超过 4 倍时才真正中断，
      // 这里传 limit*4 是为了「超过 limit 但仍能下完」，便于上层按真实大小决定是否发送。
      const r = await proxyGet(target, { proxy, timeoutMs, maxBytes: limit * 4 });
      const buf = r.body;
      if (!buf?.length) return null;
      fs.writeFileSync(file, buf);
      return { file, bytes: buf.length, cached: false };
    } catch (e) {
      log(`[x-monitor] 视频下载失败 ${String(url).slice(0, 60)}: ${e?.message ?? e}`);
      return null;
    }
  }

  /** 清理：先按 TTL，再按总量/文件数兜底（最旧的先删）。 */
  function sweep() {
    let removed = 0;
    let freed = 0;
    try {
      const now = Date.now();
      let entries = [];
      for (const name of fs.readdirSync(absDir)) {
        const f = path.join(absDir, name);
        let st;
        try { st = fs.statSync(f); } catch { continue; }
        if (!st.isFile()) continue;
        // TTL 过期直接删
        if (ttlMs > 0 && now - st.mtimeMs > ttlMs) {
          try { fs.unlinkSync(f); removed += 1; freed += st.size; } catch {}
          continue;
        }
        entries.push({ f, size: st.size, mtimeMs: st.mtimeMs });
      }
      // 兜底：超总量或超文件数 → 按 mtime 升序删最旧的
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let totalBytes = entries.reduce((a, e) => a + e.size, 0);
      let totalFiles = entries.length;
      for (const e of entries) {
        if (totalBytes <= maxBytes && totalFiles <= maxFiles) break;
        try { fs.unlinkSync(e.f); removed += 1; freed += e.size; totalBytes -= e.size; totalFiles -= 1; } catch {}
      }
      if (removed) {
        log(`[x-monitor] 图片缓存清理：删除 ${removed} 个文件，释放 ${(freed / 1024 / 1024).toFixed(1)}MB`);
      }
    } catch (e) {
      log(`[x-monitor] 图片缓存清理异常: ${e?.message ?? e}`);
    }
    return { removed, freed };
  }

  function start() {
    if (sweepTimer) return;
    if (sweepMs <= 0) return;
    sweepTimer = setInterval(sweep, sweepMs);
    sweepTimer.unref?.();
    // 打印**相对路径**：桥接的日志脱敏规则会过滤 Windows 绝对路径（保护隐私），
    // 用绝对路径会显示成 ***，排障时看不到缓存位置。
    const shown = path.relative(root, absDir).replace(/\\/g, '/') || absDir;
    log(`[x-monitor] 图片缓存已就绪：${shown}（TTL ${Math.round(ttlMs / 60000)} 分钟，每 ${Math.round(sweepMs / 60000)} 分钟清理）`);
  }

  function stop() {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
  }

  /** 供诊断：当前缓存用量。 */
  function stats() {
    try {
      let files = 0, bytes = 0;
      for (const name of fs.readdirSync(absDir)) {
        try {
          const st = fs.statSync(path.join(absDir, name));
          if (st.isFile()) { files += 1; bytes += st.size; }
        } catch {}
      }
      return { dir: absDir, files, bytes };
    } catch {
      return { dir: absDir, files: 0, bytes: 0 };
    }
  }

  return { dir: absDir, get, getVideo, sweep, start, stop, stats };
}

/**
 * 把 X 的图片 URL 升级为高清版。
 * pbs.twimg.com 支持通过查询参数选尺寸：默认给的是 small/medium（实测同图 23KB vs large 90KB）。
 */
export function upgradeTweetImageUrl(url) {
  const u = String(url ?? '');
  if (!/pbs\.twimg\.com/i.test(u)) return u;
  // 已有明确的 name 参数时不覆盖（尊重调用方）
  if (/[?&]name=/.test(u)) return u;
  return u.includes('?') ? `${u}&name=large` : `${u}?name=large`;
}
