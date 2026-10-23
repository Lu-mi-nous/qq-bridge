// 微信公众号文章解析：把 mp.weixin.qq.com 的文章页转成结构化短文本。
//
// 背景（2026-10-12 用户反馈「机器人无法通过微信反爬验证」）：
// 实测同一条链接、同一时刻，只换请求头：
//   UA = "Mozilla/5.0"（残缺）→ 18045 字节的「环境异常，完成验证后即可继续访问」页
//   UA = 完整 Chrome UA        → 2577741 字节的完整文章页（标题/正文元信息都在）
// 微信拦的是**畸形 UA 指纹**（正常浏览器不会只报 5 个字符），不是要求人过验证码。
// 所以修法是让请求看起来像正常客户端，而不是去绕验证 —— 真要过验证的文章，
// 这里如实返回 ok=false，让模型知道「没读到」，绝不猜内容。
//
// 第二个问题：正文元信息在 ~219KB 处、标题在 ~317KB 处，而 web_fetch 原本只读 50000
// 字符 —— 即使 UA 正常也拿不到正文。所以微信文章按更大上限读全量，再解析成短文本。
//
// 纯函数模块（无网络、无 IO），便于离线回归测试。

// 微信文章页的读取上限：正文元信息在 ~219KB、标题在 ~317KB 处，
// 远超声明的 50KB —— 按 50KB 读会"成功但拿不到正文"（静默失败，最难查）。
// 2.5MB 是实测的典型页大小（含内联 JS bundle），给到 8MB 留余量。
export const WEIXIN_READ_CHARS = 8 * 1024 * 1024;

const MAX_ARTICLE_TEXT = 6000;
const MAX_IMAGES = 12;

/** 微信文章链接判定：只认 mp.weixin.qq.com 的 /s 路径（文章页）。 */
export function isWeixinArticleUrl(urlLike) {
  let u;
  try {
    u = urlLike instanceof URL ? urlLike : new URL(String(urlLike ?? ''));
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host !== 'mp.weixin.qq.com') return false;
  return /^\/s(\/|$)/.test(u.pathname);
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 导航/客户端引导类样板文字：不是文章内容，必须剔除。
// 否则图片帖会把「微信扫一扫可打开此内容」当正文返回，让调用方误以为读到了内容。
const BOILERPLATE_RE = /^(?:知道了|取消|允许|确定|微信扫一扫|使用小程序|视频|小程序|赞|在看|分享|留言|收藏|听过|轻点两下取消赞|轻点两下取消在看|预览时标签不可点|继续滑动看下一个|向上滑动看下一个|作者|发表于|阅读|点击上方|关注我们|长按识别|扫描二维码)+[，。、：:；;！!？?\s]*$/;

/** 是否整段都是样板（去掉标点后仍全部命中样板词）。 */
export function isBoilerplate(text) {
  const t = String(text ?? '').replace(/\s+/g, '');
  if (!t) return true;
  if (BOILERPLATE_RE.test(t)) return true;
  // 短段落：去掉全部样板词后若无剩余中文，也算样板
  if (t.length <= 40) {
    const stripped = t.replace(/知道了|取消|允许|确定|微信扫一扫|使用小程序|可打开此内容|使用完整服务|轻点两下取消赞|轻点两下取消在看|继续滑动看下一个|向上滑动看下一个|预览时标签不可点/g, '');
    const cjk = (stripped.match(/[\u4e00-\u9fa5]/g) || []).length;
    if (cjk <= 2) return true;
  }
  return false;
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const n = parseInt(d, 10);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
    });
}

/** 去掉 script/style/注释后，把 HTML 转成纯文本（块级标签转换行）。 */
export function stripHtmlToText(html) {
  let s = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|li|h[1-6]|tr|blockquote|figcaption)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 取 meta 内容（兼容 property/name 与 content 的两种先后顺序）。 */
function metaContent(html, key) {
  const k = escapeRe(key);
  const re1 = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${k}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${k}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decodeEntities(m[1]).trim() : '';
}

/** 取 `window.x = '...'` / `x: '...'` 形式的字符串字段。 */
function scriptString(html, name) {
  const n = escapeRe(name);
  const re = new RegExp(`(?:window\\.)?${n}\\s*=\\s*(?:window\\.title\\s*=\\s*)?'((?:[^'\\\\]|\\\\.)*)'`);
  const m = html.match(re);
  if (m) return unescapeJs(m[1]).trim();
  const re2 = new RegExp(`(?:^|[\\s,{])${n}\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'`);
  const m2 = html.match(re2);
  return m2 ? unescapeJs(m2[1]).trim() : '';
}

function unescapeJs(s) {
  return decodeEntities(
    String(s ?? '')
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\\\/g, '\\')
  );
}

/**
 * 识别「不是文章正文」的页面（验证页 / 已删除 / 需客户端打开）。
 * 判据跑在**去标签后的可见文本**上：正常文章页的 JS bundle 里也可能出现「去验证」
 * 这类字样，只看原始 HTML 会误判。
 */
export function detectWeixinBlock(html) {
  const visible = stripHtmlToText(html).slice(0, 4000);
  const rules = [
    {
      kind: 'verify',
      re: /环境异常|完成验证后即可继续访问|去验证/,
      message: '微信返回了验证页（要求人工验证），这篇文章机器人读不到。请如实告诉群友打不开，不要猜内容；可以让对方贴标题或正文片段。'
    },
    {
      kind: 'removed',
      re: /该内容已被发布者删除|此内容因违规无法查看|该公众号已迁移|内容已删除|该内容已被删除/,
      message: '这篇文章已被删除或无法查看（微信侧的提示）。如实告知即可。'
    },
    {
      kind: 'need_wechat',
      re: /请在微信客户端打开链接|请在微信中打开/,
      message: '微信要求用客户端打开该链接，当前拿不到正文。如实告知即可。'
    }
  ];
  for (const r of rules) if (r.re.test(visible)) return { kind: r.kind, message: r.message };
  return null;
}

/** 从 HTML 里收集配图直链（图片帖用 cdn_url，正文帖用 img data-src/src）。 */
export function collectWeixinImages(html) {
  const out = [];
  const push = (v) => {
    let s = decodeEntities(String(v ?? '')).trim();
    if (!s) return;
    if (s.startsWith('//')) s = 'https:' + s;
    if (s.startsWith('http://')) s = 'https://' + s.slice(7);
    if (!/^https:\/\//.test(s)) return;
    if (!/mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn/.test(s)) return;
    if (out.includes(s)) return;
    out.push(s);
  };
  for (const m of html.matchAll(/cdn_url\s*:\s*'([^']+)'/g)) push(m[1]);
  for (const m of html.matchAll(/<img[^>]+(?:data-src|src)\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  return out.slice(0, MAX_IMAGES);
}

/** 提取正文：优先 js_content 容器，退回段落扫描。 */
function extractBody(html) {
  // 策略一：标准正文容器。取容器后一段窗口，在已知尾部标记处截断，避免把页脚/推荐位吃进来。
  for (const anchor of ['id="js_content"', 'class="rich_media_content', 'id="js_content_container"']) {
    const i = html.indexOf(anchor);
    if (i < 0) continue;
    // 从**属性结束后**开始（否则会把 id="js_content"> 这类残留当正文头）。
    const start = html.indexOf('>', i) + 1;
    if (start <= 0) continue;
    const tail = html.slice(start, start + 400_000);
    // 尾部标记可能出现在容器内（嵌套结构）也可能在容器后；取最先出现的那个。
    const cutMarkers = ['id="js_article_bottom_bar"', 'id="js_pc_qr_code"', 'id="js_article_comment"', 'id="js_share_content_page_hd"', 'id="js_pc_weapp_code"'];
    let cut = tail.length;
    for (const cm of cutMarkers) {
      const c = tail.indexOf(cm);
      if (c > 0 && c < cut) cut = c;
    }
    let seg = tail.slice(0, cut);
    // 截到标记之后可能还剩标签开头（如 `<div ` 在半路被切断），回退到最后一个完整 '>' 前
    if (cut < tail.length) {
      const lastClose = seg.lastIndexOf('>');
      const lastOpen = seg.lastIndexOf('<');
      if (lastOpen > lastClose) seg = seg.slice(0, lastOpen);
    }
    const text = stripHtmlToText(seg);
    if (text.length > 20) return { text, source: 'js_content' };
  }
  // 策略二：没有容器（部分图片帖/新版页面）→ 全文扫中文长段落，剔除导航样板。
  // 图片帖没有正文容器，若不过滤会把「微信扫一扫可打开此内容」当成正文，
  // 于是 text 非空 → 调用方以为读到了内容，实际是样板文字（比空正文更危险，会误导模型）。
  const paras = [];
  for (const m of html.matchAll(/<p[^>]*>([\s\S]{12,600}?)<\/p>/gi)) {
    const t = stripHtmlToText(m[1]);
    if (t.length < 12 || !/[\u4e00-\u9fa5]/.test(t)) continue;
    if (isBoilerplate(t)) continue;
    if (paras.includes(t)) continue;
    paras.push(t);
  }
  if (paras.length) return { text: paras.join('\n'), source: 'paragraphs' };
  return { text: '', source: '' };
}

/**
 * 解析微信文章页。
 * @returns {{ok:boolean, ...}} ok=false 表示没读到正文，调用方必须如实告知（不要猜）
 */
export function parseWeixinArticle(html, url = '') {
  const h = String(html ?? '');
  const base = { url: String(url), bytes: h.length };

  const block = detectWeixinBlock(h);
  if (block) {
    return { ok: false, reason: block.kind, message: block.message, ...base };
  }

  const title = scriptString(h, 'msg_title') || metaContent(h, 'og:title') || decodeEntities((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  const account = scriptString(h, 'nick_name');
  const author = metaContent(h, 'og:article:author') || scriptString(h, 'author');
  const description = scriptString(h, 'content_noencode') || metaContent(h, 'og:description');
  const publishedAt = scriptString(h, 'create_time');
  const appmsgType = scriptString(h, 'appmsg_type');
  const body = extractBody(h);
  const images = collectWeixinImages(h);

  let text = body.text;
  if (text.length > MAX_ARTICLE_TEXT) text = text.slice(0, MAX_ARTICLE_TEXT) + '…（正文过长已截断）';

  // 关键：正文为空时**不能**编内容。图片帖的真实内容在图里，把这一点说清楚。
  const notes = [];
  if (!text) {
    notes.push(images.length
      ? `正文容器为空：该文章的可见内容在配图里（共 ${images.length} 张），文字说明见 description。`
      : '这个页面没有提取到正文文本。');
  }

  const hasAnything = Boolean(title || text || description);
  return {
    ok: hasAnything,
    title,
    account,
    author,
    publishedAt,
    appmsgType,
    description,
    text,
    textSource: body.source,
    images,
    notes: notes.length ? notes : undefined,
    ...base,
    ...(hasAnything ? {} : { message: '页面里没有可识别的文章内容（可能是特殊类型页面）。' })
  };
}
