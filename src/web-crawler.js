// 按需网页抓取：给模型一个受控的“看网页 / 找图 / 存表情”入口。
//
// 设计边界（很重要）：
//   - 所有网络请求都走 safe-fetch：禁内网/环回/私网、DNS rebinding 校验、逐跳重定向校验、
//     响应体限量；不接受 file://、data:、非 http(s) 协议。
//   - 不绕过登录/验证码/反爬。小红书等站点返回登录页/“页面不见了”时，如实带
//     needsLogin 标记，让模型告诉群友打不开，而不是伪造内容。
//   - aigengtu.com 有公开的 gallery-index.json，直接读结构化数据，比解析 JS 渲染页可靠。
//
// 本模块只做“抓 + 解析 + 落盘”；把图片加进 QQ 收藏表情由桥接端点调用
// SnowLuma 的 add_custom_face 完成。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { safeFetch, safeFetchBuffer, looksLikeImageBuffer, decodeBuffer } from './safe-fetch.js';
import { proxyGet } from './proxy-tunnel.js';
import { findFfmpeg } from './gif-frames.js';

export const AIGENGTU_INDEX = 'https://aigengtu.com/gallery-index.json';

// 明确自报身份，别伪装成浏览器缺配套头（部分 CDN 会因此直接 403）。
const CRAWLER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QQ-Bridge-Crawler/1.0';

function readProxyConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
    return String(cfg.webSearch?.proxy || cfg.socialV2?.images?.proxy || '').trim();
  } catch {
    return '';
  }
}

function isNetworkError(message) {
  return /(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|请求超时|读取超时|fetch failed|socket hang up)/i.test(String(message ?? ''));
}

/** 抓页面：直连失败且配置了代理时走一次代理（境外网页在污染网络下常被 reset）。 */
async function fetchPage(target, maxChars = 2_000_000) {
  try {
    return await safeFetch(target, maxChars);
  } catch (error) {
    const proxy = readProxyConfig();
    if (!proxy || !isNetworkError(error?.message)) throw error;
    const r = await proxyGet(target, {
      proxy,
      timeoutMs: 20000,
      maxBytes: Math.min(16 * 1024 * 1024, Math.max(64 * 1024, maxChars * 4 + 4096)),
      headers: {
        'user-agent': CRAWLER_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
        'accept-encoding': 'identity',
      },
    });
    const contentType = String(r.headers?.['content-type'] || '');
    const raw = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body ?? ''), 'utf8');
    const body = decodeBuffer(raw, contentType);
    return {
      url: r.url || target,
      statusCode: r.status,
      contentType,
      truncated: body.length >= maxChars,
      body,
    };
  }
}

const LOGIN_WALL_RE = /(请先?登录|登录后(?:查看|才能)|安全验证|验证码|captcha|页面不见了|当前笔记暂时无法浏览|访问过于频繁|请稍后再试|sign\s*in to|log\s*in to|login required)/i;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', copy: '©'
};

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ''; }
    })
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function cleanText(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attrOf(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(String(tag ?? ''));
  return m ? String(m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
}

function resolveUrl(src, baseUrl) {
  const raw = String(src ?? '').trim();
  if (!raw || /^(?:data:|javascript:|blob:|file:)/i.test(raw)) return '';
  try {
    const u = new URL(raw, baseUrl);
    return /^https?:$/i.test(u.protocol) ? u.toString() : '';
  } catch {
    return '';
  }
}

/** 首页/文章页：标题、描述、正文、图片列表。 */
export function extractHtml(html, baseUrl, { maxText = 4000, maxImages = 20 } = {}) {
  const src = String(html ?? '');
  const title = cleanText((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(src) || [])[1] || '');
  let description = '';
  let ogImage = '';
  for (const m of src.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attrOf(tag, 'property') || attrOf(tag, 'name')).toLowerCase();
    const content = attrOf(tag, 'content');
    if (!content) continue;
    if (!description && (key === 'description' || key === 'og:description')) description = cleanText(content);
    if (!ogImage && (key === 'og:image' || key === 'twitter:image')) ogImage = content;
  }
  const visible = src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article)>/gi, '\n');
  const text = decodeEntities(visible.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, Math.max(200, Number(maxText) || 4000));

  const images = [];
  const seen = new Set();
  const add = (raw, alt = '') => {
    const abs = resolveUrl(raw, baseUrl);
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    images.push({ url: abs, alt: cleanText(alt).slice(0, 120) });
  };
  if (ogImage) add(ogImage, 'og:image');
  for (const m of src.matchAll(/<img\b[^>]*>/gi)) {
    if (images.length >= maxImages) break;
    const tag = m[0];
    const alt = attrOf(tag, 'alt');
    const srcset = attrOf(tag, 'srcset') || attrOf(tag, 'data-srcset');
    const single = attrOf(tag, 'data-src') || attrOf(tag, 'data-original')
      || attrOf(tag, 'data-lazy-src') || attrOf(tag, 'src');
    if (single) add(single, alt);
    if (srcset) {
      // srcset 里最后一项通常是最大图
      const last = srcset.split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).pop();
      if (last) add(last, alt);
    }
  }
  return {
    kind: 'html',
    title,
    description,
    text,
    images: images.slice(0, maxImages),
    needsLogin: LOGIN_WALL_RE.test(title)
      || LOGIN_WALL_RE.test(description)
      || LOGIN_WALL_RE.test(text.slice(0, 400))
  };
}

/** 判断 host 是否为 aigengtu（含 www / 图片子域）。 */
export function isAigengtuUrl(url) {
  try {
    const host = new URL(String(url ?? '')).hostname.toLowerCase();
    return host === 'aigengtu.com' || host === 'www.aigengtu.com';
  } catch {
    return false;
  }
}

/**
 * 把 gallery-index.json 摊平成图片列表，按关键词/分类过滤。
 * @param {object} json
 * @param {{query?:string, category?:string, limit?:number, random?:()=>number}} opts
 */
export function listAigengtuImages(json, { query = '', category = '', limit = 10, random = Math.random } = {}) {
  const gallery = json?.gallery;
  if (!gallery || typeof gallery !== 'object') return [];
  const q = String(query ?? '').trim().toLowerCase();
  const cat = String(category ?? '').trim().toLowerCase();
  const out = [];
  for (const [categoryName, group] of Object.entries(gallery)) {
    if (cat && !categoryName.toLowerCase().includes(cat)) continue;
    for (const img of Array.isArray(group?.images) ? group.images : []) {
      const story = img?.story && typeof img.story === 'object' ? img.story : {};
      const hay = [categoryName, img?.name, img?.alt, img?.category, story.zh, story.en]
        .filter(Boolean).join(' ').toLowerCase();
      if (q && !hay.includes(q)) continue;
      const url = String(img?.original || img?.preview || '').trim();
      if (!/^https?:\/\//i.test(url)) continue;
      out.push({
        url,
        preview: String(img?.preview || '').trim(),
        name: String(img?.name || img?.alt || categoryName).slice(0, 120),
        alt: String(img?.alt || '').slice(0, 120),
        category: categoryName,
        story: String(story.zh || '').slice(0, 300)
      });
    }
  }
  // 随机打散：每次“来点表情包”不会总是同几张
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor((Number(random()) || 0) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

/** 从 aigengtu 的公开索引里挑图。 */
export async function crawlAigengtu({ query = '', category = '', limit = 10, random } = {}) {
  const res = await fetchPage(AIGENGTU_INDEX, 2_000_000);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`aigengtu 索引抓取失败：HTTP ${res.statusCode}`);
  }
  let json;
  try { json = JSON.parse(res.body); } catch { throw new Error('aigengtu 索引不是合法 JSON'); }
  const images = listAigengtuImages(json, { query, category, limit, random });
  const lines = images.map((x, i) => `${i + 1}. [${x.category}] ${x.name}`);
  return {
    kind: 'aigengtu',
    url: AIGENGTU_INDEX,
    title: 'aigengtu 表情库',
    text: lines.length ? lines.join('\n') : '没有匹配的图片',
    images,
    needsLogin: false
  };
}

/**
 * 抓一个网页。自动识别 aigengtu；如果响应是带 gallery 的 JSON，也按图库处理。
 */
export async function crawlUrl(url, { query = '', limit = 10, maxText = 4000, random } = {}) {
  const target = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('url 必须是 http(s) 链接');
  if (isAigengtuUrl(target)) return crawlAigengtu({ query, limit, random });

  const res = await fetchPage(target, 2_000_000);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`网页抓取失败：HTTP ${res.statusCode}`);
  }
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* 不是 JSON，按 HTML 处理 */ }
  if (json?.gallery && typeof json.gallery === 'object') {
    const images = listAigengtuImages(json, { query, limit, random });
    return {
      kind: 'gallery',
      url: res.url,
      title: '图片索引',
      text: images.map((x, i) => `${i + 1}. [${x.category}] ${x.name}`).join('\n') || '没有匹配的图片',
      images,
      needsLogin: false
    };
  }
  const page = extractHtml(res.body, res.url, { maxText, maxImages: limit });
  return { ...page, url: res.url };
}

/** 识别图片格式（只接受 QQ/DSH 常见的四种）。 */
export function imageExtOf(buffer) {
  if (!buffer || buffer.length < 12) return '';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a') return 'gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'webp';
  return '';
}

function runFfmpeg(bin, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { windowsHide: true }); } catch (e) { resolve({ ok: false, error: String(e?.message ?? e) }); return; }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: String(e?.message ?? e) });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: `ffmpeg exit ${code}` });
    });
  });
}

/** webp 转 png：QQ 收藏表情对 webp 的支持不稳定，先转成 png 最稳。 */
async function webpToPng(buffer) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return null;
  const base = path.join(os.tmpdir(), `qqb-sticker-${crypto.randomBytes(6).toString('hex')}`);
  const input = `${base}.webp`;
  const output = `${base}.png`;
  try {
    fs.writeFileSync(input, buffer);
    const r = await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-i', input, '-frames:v', '1', output]);
    if (!r.ok) return null;
    const png = fs.readFileSync(output);
    return looksLikeImageBuffer(png) ? png : null;
  } catch {
    return null;
  } finally {
    try { fs.rmSync(input, { force: true }); } catch {}
    try { fs.rmSync(output, { force: true }); } catch {}
  }
}

/**
 * 下载一张图并保存为本地表情文件。
 * @returns {Promise<{path:string, md5:string, ext:string, bytes:number}>}
 */
export async function saveStickerImage(url, { dir, maxBytes = 5 * 1024 * 1024, headers = {} } = {}) {
  const target = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('图片地址必须是 http(s)');
  if (!dir) throw new Error('缺少表情缓存目录');
  const res = await safeFetchBuffer(target, Math.max(64 * 1024, Number(maxBytes) || 5 * 1024 * 1024), {
    userAgent: CRAWLER_UA,
    headers: { referer: 'https://aigengtu.com/', ...headers }
  });
  let buffer = res.buffer;
  if (!looksLikeImageBuffer(buffer)) throw new Error('下载内容不是有效图片（PNG/JPEG/GIF/WebP）');
  let ext = imageExtOf(buffer) || 'jpg';
  if (ext === 'webp') {
    const png = await webpToPng(buffer);
    if (png) { buffer = png; ext = 'png'; }
  }
  const md5 = crypto.createHash('md5').update(buffer).digest('hex');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `sticker-${md5}.${ext}`);
  if (!fs.existsSync(file) || fs.statSync(file).size !== buffer.length) {
    fs.writeFileSync(file, buffer);
  }
  return { path: file, md5, ext, bytes: buffer.length };
}
