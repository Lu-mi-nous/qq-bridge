// x-monitor/fetch.mjs — 抓取 X（Twitter）账号的最新帖子（免登录）
//
// 原理（2026-10-04 实测）：
//   ① 账号主页 HTML 里含该账号最近帖子的 status id（未登录也能拿到）；
//   ② cdn.syndication.twimg.com/tweet-result 是 X 的公开嵌入接口，可凭 id 取回
//      帖子正文/时间/媒体，**免登录、返回 JSON**。
//      ⚠️ 该接口必须带 `token` 查询参数，否则返回空对象 `{}`；token 值不校验（任意串即可）。
//
// 限制：主页 HTML 只给最近约 6~20 条；接口对单 IP 有软限频，故 ③ 步之间加间隔。
import { proxyGet } from '../../../src/proxy-tunnel.js';

const X_HOST = 'https://x.com';
const SYNDICATION = 'https://cdn.syndication.twimg.com/tweet-result';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 从主页 HTML 里检出**置顶帖**的 id。
 *
 * 为什么需要：置顶帖会排在个人页最前面，但它可能是几个月前发的。只按"列表顺序取前 N 条"
 * 会把它当成最新帖发出去（2026-10-10 实测：@mimi_3mi 的置顶是 6 月 8 日的十周年帖，
 * 而真正的最新帖是 10-10 的；用户要"最新一条"时拿到的是置顶，明显不对）。
 *
 * 判据（HTML 内嵌的 X 时间线数据里，机器可读）：
 *   social_context:{...,context_type:"Pin",text:"已置顶"},tweet_results:$R[n]={id:"...",rest_id:"<帖子id>"
 * 实测 @mimi_3mi 精确命中 1 条（正是列表第 1 个 id）；对没有置顶的账号（@thsottiaux/@sama）
 * 命中 0 条，无误报。syndication 详情接口**不返回**置顶标记，所以只能从主页 HTML 判。
 *
 * @param {string} html 主页 HTML
 * @returns {Set<string>} 置顶帖 id 集合
 */
export function findPinnedIds(html) {
  const out = new Set();
  const s = String(html ?? '');
  // 置顶的 tweet_results 紧跟在 context_type:"Pin" 之后；$R[n] 的编号因页面而异，用 \d+ 通配。
  const re = /context_type:"Pin"[\s\S]{0,200}?tweet_results:\$R\[\d+\]=\{id:"[^"]*",rest_id:"(\d{15,25})"/g;
  let m;
  while ((m = re.exec(s))) out.add(m[1]);
  return out;
}

/** 从账号主页 HTML 提取最近的 status id 列表（保序、去重）。 */
export async function listPostIds(handle, { proxy = '', timeoutMs = 25000 } = {}) {
  const user = String(handle ?? '').replace(/^@/, '').trim();
  if (!user) throw new Error('账号名为空');
  const r = await proxyGet(`${X_HOST}/${encodeURIComponent(user)}`, {
    proxy,
    timeoutMs,
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' }
  });
  const html = String(r.body ?? '');
  if (!html) throw new Error('主页返回为空');
  const ids = [...new Set([...html.matchAll(/\/status\/(\d{15,25})/g)].map((m) => m[1]))];
  return ids;
}

/**
 * 同 listPostIds，但同时给出置顶帖 id 集合（避免为了判置顶把主页请求两遍）。
 * @returns {Promise<{ids:string[], pinned:Set<string>}>}
 */
export async function listPostIdsWithPinned(handle, { proxy = '', timeoutMs = 25000 } = {}) {
  const user = String(handle ?? '').replace(/^@/, '').trim();
  if (!user) throw new Error('账号名为空');
  const r = await proxyGet(`${X_HOST}/${encodeURIComponent(user)}`, {
    proxy,
    timeoutMs,
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' }
  });
  const html = String(r.body ?? '');
  if (!html) throw new Error('主页返回为空');
  const ids = [...new Set([...html.matchAll(/\/status\/(\d{15,25})/g)].map((m) => m[1]))];
  return { ids, pinned: findPinnedIds(html) };
}

/**
 * 读取账号资料（昵称/头像/简介），用于「用户是否存在」校验与展示。
 * 数据来自主页 HTML 的 og:title / og:description / og:image（免登录可见）。
 * @returns {Promise<{handle,name,bio,avatar}|null>} 账号不存在返回 null
 */
export async function fetchProfile(handle, { proxy = '', timeoutMs = 25000 } = {}) {
  const user = String(handle ?? '').replace(/^@/, '').trim();
  if (!user) return null;
  try {
    const r = await proxyGet(`${X_HOST}/${encodeURIComponent(user)}`, {
      proxy,
      timeoutMs,
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' }
    });
    const html = String(r.body ?? '');
    if (!html) return null;
    const meta = (prop) => {
      const re = new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, 'i');
      return (html.match(re)?.[1] ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    };
    const ogTitle = meta('og:title');
    const ogDesc = meta('og:description');
    const av = meta('og:image');
    // 不存在/被冻结的账号：X 返回「未找到用户个人资料 - X」这类通用页，
    // 其 og:title 里也会含 handle（因为 URL 里带着），所以必须显式排除这些文案，
    // 否则会把不存在的账号当成存在（实测 @thisuserdoesnotexist12345xyz 通过了旧判定）。
    const NOT_FOUND_RE = /未找到|无法找到|找不到|不存在|not found|couldn'?t find|doesn'?t exist|账号已|suspended|暂时受限/i;
    if (NOT_FOUND_RE.test(ogTitle) || NOT_FOUND_RE.test(ogDesc)) return null;
    const titleHitsHandle = ogTitle.toLowerCase().includes(`@${user.toLowerCase()}`);
    if (!titleHitsHandle && !ogDesc) return null;
    // X 的标题格式：「X 上的 昵称 (@handle)」/「昵称 (@handle) on X」
    const name = ogTitle
      .replace(/^X\s*上的\s*/i, '')
      .replace(/\s*\(@[^)]+\)\s*on X\s*$/i, '')
      .replace(/\s*\(@[^)]+\)\s*$/i, '')
      .replace(/\s*on X\s*$/i, '')
      .trim();
    return {
      handle: user,
      name: name || user,
      bio: ogDesc || '',
      avatar: av || ''
    };
  } catch {
    return null;
  }
}

/** 取单条帖子详情（syndication 接口）。失败返回 null（不抛，便于批量容错）。 */
export async function fetchPost(id, { proxy = '', timeoutMs = 20000 } = {}) {
  const url = `${SYNDICATION}?id=${encodeURIComponent(id)}&lang=en&token=x`;
  const r = await proxyGet(url, { proxy, timeoutMs, headers: { 'user-agent': UA } });
  const raw = String(r.body ?? '').trim();
  if (!raw || raw === '{}') return null;
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j?.created_at) return null;
  const media = Array.isArray(j.mediaDetails)
    ? j.mediaDetails
        .map((m) => ({
          type: m?.type === 'photo' ? 'photo' : (m?.type || 'media'),
          url: m?.media_url_https || m?.media_url || ''
        }))
        .filter((m) => m.url)
    : [];
  return {
    id: String(j.id_str || id),
    text: String(j.text || '').trim(),
    createdAt: String(j.created_at),
    createdAtMs: Date.parse(j.created_at) || 0,
    lang: String(j.lang || ''),
    likes: Number(j.favorite_count) || 0,
    replies: Number(j.conversation_count) || 0,
    media,
    video: extractVideo(j),
    user: {
      name: String(j.user?.name || ''),
      handle: String(j.user?.screen_name || ''),
      avatar: String(j.user?.profile_image_url_https || '')
    },
    url: `${X_HOST}/${j.user?.screen_name || 'i'}/status/${j.id_str || id}`
  };
}

/**
 * 从 syndication 返回里提取视频信息（没有视频返回 null）。
 *
 * 结构（2026-10-10 实测 @mimi_3mi 的一条视频帖）——**两处的字段名不同，且只有一处带码率**：
 *   - 顶层 `video.variants[]`：`{type, src}`，**没有 bitrate**
 *   - `mediaDetails[].video_info.variants[]`：`{content_type, url, bitrate}`，**有 bitrate**
 * 所以优先取 `video_info`（带码率才能可靠估算体积），顶层只作兜底。
 * 两处都混着 `application/x-mpegURL`(m3u8)，**必须按类型过滤**，否则会把播放列表当视频下载
 * （下回来是几百字节文本，OneBot 拒收）。
 *
 * @returns {{variants:{url:string,bitrate:number,width:number,height:number}[], durationMs:number, aspectRatio:number[], poster:string}|null}
 */
export function extractVideo(j) {
  const md = Array.isArray(j?.mediaDetails) ? j.mediaDetails.find((m) => m?.type === 'video' && m?.video_info) : null;
  // 优先 mediaDetails.video_info（有 bitrate）；没有再用顶层 video
  const info = md?.video_info || j?.video;
  if (!info) return null;
  const raw = Array.isArray(info.variants) ? info.variants : [];
  const variants = raw
    .filter((x) => /video\/mp4/i.test(String(x?.content_type || x?.type || '')))
    .map((x) => {
      const url = String(x?.url || x?.src || '');
      // 从 .../vid/avc1/1280x720/xxx.mp4 里解出分辨率，用于挑档与展示
      const dim = /\/vid\/[^/]+\/(\d+)x(\d+)\//.exec(url);
      return {
        url,
        bitrate: Number(x?.bitrate) || 0,
        width: dim ? Number(dim[1]) : 0,
        height: dim ? Number(dim[2]) : 0
      };
    })
    .filter((x) => x.url);
  if (!variants.length) return null;
  // 低码率在前，便于「先挑小档、不够再升」的选择策略
  variants.sort((a, b) => (a.bitrate || a.height || 0) - (b.bitrate || b.height || 0));
  return {
    variants,
    durationMs: Number(info.durationMs ?? info.duration_millis) || 0,
    aspectRatio: Array.isArray(info.aspectRatio) ? info.aspectRatio : (Array.isArray(info.aspect_ratio) ? info.aspect_ratio : []),
    poster: String(info.poster || '')
  };
}

/**
 * 估算一个视频变体的体积（字节）。拿不到码率时用分辨率经验值兜底。
 * 单独导出便于单测与诊断（估算值直接决定「超 100MB 跳过」的判断）。
 *
 * ⚠️ `durationMs` 是**毫秒**（接口给的是 `durationMs: 182613`），必须先换算成秒，
 * 否则体积会被放大 1000 倍——实测踩过：480p 的 5.6MB 被算成 5572MB，导致所有档位都被
 * 判成「超 100MB」而全部跳过，表现为"视频永远发不出来"。
 */
export function estimateVariantBytes(v, durationMs) {
  const durSec = (Number(durationMs) || 0) / 1000;
  if (!durSec) return 0;
  if (v?.bitrate > 0) return Math.round((v.bitrate * durSec) / 8);
  const px = (v?.width || 0) * (v?.height || 0);
  if (px > 0) return Math.round((px * 0.07 * durSec) / 8); // ~0.07 bit/px/s 经验系数
  return 0;
}

/**
 * 按「尽量清晰、但不超上限」挑一个视频变体。
 *
 * 为什么不是简单取最高清：1080p 视频动辄几十上百 MB，直接下会撑爆内存与 QQ 上限。
 * 策略：按码率升序，取**不超过 maxBytes 的最大档**；若最低档都超限则返回 null（调用方跳过并说明）。
 *
 * @param {{variants:Array,durationMs:number}} video
 * @param {{maxBytes:number}} opts
 * @returns {{url:string,bitrate:number,width:number,height:number,estimatedBytes:number}|null}
 */
export function pickVideoVariant(video, { maxBytes = 100 * 1024 * 1024 } = {}) {
  if (!video?.variants?.length) return null;
  let chosen = null;
  for (const v of video.variants) {
    const est = estimateVariantBytes(v, video.durationMs);
    if (est > 0 && est > maxBytes) continue;
    chosen = { ...v, estimatedBytes: est };   // 保留最后一个「不超限」的，即最清晰的可接受档
  }
  // 全都超限时返回 null，让调用方明确跳过并说明（而不是硬发一个超限的）
  return chosen;
}

/**
 * 抓取指定账号的帖子，并按条件筛选（按需拉取场景的主力函数）。
 *
 * @param {string} handle      账号（可带 @）
 * @param {object} opts
 *   - proxy       代理地址（X 需代理）
 *   - limit       最多返回几条（默认 3，按需拉取通常只要最新的几条）
 *   - sinceMs     只保留「发布时间 ≥ sinceMs」的帖子（指定日期用）
 *   - untilMs     只保留「发布时间 ≤ untilMs」的帖子（指定日期区间用）
 *   - maxAgeMs    只保留「距现在不超过这么久」的帖子（相对时间用，与 since 二选一）
 *   - scanLimit   最多检查主页列出的多少条（控制请求次数，默认 12）
 *   - gapMs       两次详情请求之间的间隔（默认 900ms，防风控）
 *   - ownOnly     只保留该账号**原创**的帖子，跳过转推（默认 true）
 *   - skipPinned  跳过置顶帖（默认 true）。置顶帖排在主页最前，但它可能是几个月前发的，
 *                 "要最新一条"时取到它会明显答非所问（2026-10-10 实测）。
 *
 * 说明：主页列表按时间倒序（置顶除外），因此一旦遇到 early-than-sinceMs 的帖子即可停止扫描。
 */
export async function fetchPosts(handle, opts = {}) {
  const {
    proxy = '',
    limit = 3,
    sinceMs = 0,
    untilMs = 0,
    maxAgeMs = 0,
    scanLimit = 12,
    gapMs = 900,
    ownOnly = true,
    skipPinned = true
  } = opts;

  let since = Number(sinceMs) || 0;
  if (!since && Number(maxAgeMs) > 0) since = Date.now() - Number(maxAgeMs);

  const { ids, pinned } = await listPostIdsWithPinned(handle, { proxy });
  const posts = [];
  let scanned = 0;
  let stoppedByAge = false;
  let skippedPinned = 0;
  let oldestMs = 0;   // 本页扫到的最早帖子时间（用于说明「最远能翻到哪天」）

  for (const id of ids) {
    // 置顶帖**必须最先跳过**：它排在主页最前但可能是几个月前的帖子，
    // 若先做 limit 判断再跳过，它会占掉名额被当成最新帖发出（2026-10-10 实测）。
    if (skipPinned && pinned.has(id)) {
      skippedPinned += 1;
      continue;   // 不计入 limit，也不消耗详情请求
    }
    // 跳过置顶后，主页顺序即时间倒序，因此收满 limit 条即可停（省请求、防限频）。
    if (posts.length >= limit) break;
    if (scanned >= scanLimit) break;
    scanned += 1;
    let post = null;
    try {
      post = await fetchPost(id, { proxy });
    } catch {
      post = null;
    }
    if (!post) {
      await sleep(gapMs);
      continue;
    }
    // ── 转推过滤（重要）────────────────────────────────────────────────
    // 主页 HTML 里的 status 链接**同时包含原创与转推**（转推项指向被转者的原帖 id），
    // 所以只按 id 抓会把别人发的帖子当成目标账号的帖子发出去。
    // 实测：拉 @mimi_3mi 时抓到了他转推的 @sirotanfunwari 的推文。
    // 判据很干净：syndication 接口返回的 user.screen_name 与请求账号不一致 → 该条是转推。
    if (ownOnly) {
      const author = String(post.user?.handle || '').toLowerCase();
      const want = String(handle).replace(/^@/, '').toLowerCase();
      if (author && author !== want) {
        await sleep(gapMs);
        continue;   // 跳过转推（不计入 limit，继续往后找该账号自己的帖子）
      }
    }
    const t = post.createdAtMs;
    // 记录扫过的最早一条（用于「翻不到那么远」时告诉用户实际能到哪天）
    if (t && (!oldestMs || t < oldestMs)) oldestMs = t;
    // 早于下界：列表倒序，后面的只会更早，直接停
    if (since && t && t < since) {
      stoppedByAge = true;
      break;
    }
    if (untilMs && t && t > Number(untilMs)) {
      await sleep(gapMs);
      continue; // 太新，跳过继续看更早的
    }
    posts.push(post);
    await sleep(gapMs);
  }

  posts.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return {
    posts: posts.slice(0, limit),
    scanned,
    totalIds: ids.length,
    skippedPinned,
    pinnedIds: [...pinned],
    oldestMs,           // 本页能翻到的最早时间（免登录只看得到最近几条，超出即「翻不到那么远」）
    handle: String(handle).replace(/^@/, '')
  };
}

/**
 * 抓取账号最新帖子（兼容旧调用：默认只保留 1 天内、按已知 id 去重）。
 *
 * @param {string} handle      账号（可带 @）
 * @param {object} opts
 *   - proxy       代理地址（X 需代理）
 *   - maxAgeMs    只保留「距现在不超过这么久」的帖子（默认 1 天）
 *   - limit       最多取多少条详情（控制请求次数）
 *   - knownIds    已推送过的 id 集合（用于跳过，但仍会校验时间）
 *   - onPost      每抓到一条有效帖子回调（便于即时处理）
 */
export async function fetchRecentPosts(handle, opts = {}) {
  const {
    proxy = '',
    maxAgeMs = 24 * 60 * 60 * 1000,
    limit = 8,
    knownIds = new Set(),
    onPost = null,
    gapMs = 900
  } = opts;

  const ids = await listPostIds(handle, { proxy });
  const fresh = [];
  let checked = 0;
  for (const id of ids) {
    if (checked >= limit) break;
    checked += 1;
    // 已推送过的直接跳过（不再消耗接口请求）
    if (knownIds.has(String(id))) continue;
    let post = null;
    try {
      post = await fetchPost(id, { proxy });
    } catch {
      post = null;
    }
    if (!post) {
      await sleep(gapMs);
      continue;
    }
    // 时间过滤：太老的整批停手（列表是按时间倒序的，后面只会更老）
    const age = Date.now() - post.createdAtMs;
    if (age > maxAgeMs) break;
    fresh.push(post);
    if (typeof onPost === 'function') {
      try {
        await onPost(post);
      } catch {}
    }
    await sleep(gapMs);
  }
  fresh.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return { posts: fresh, scanned: checked, totalIds: ids.length };
}
