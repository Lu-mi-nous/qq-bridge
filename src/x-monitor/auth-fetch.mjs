// x-monitor/auth-fetch.mjs — 登录态抓取（可翻历史，突破免登录「只看最近几条」的限制）
//
// 为什么需要：免登录只能看到账号主页列出的最近几条（实测 6 条，最早约两周前），
// 群友要「上个月 20 号那条」时拿不到（2026-10-10 实测）。
// 用账号 Cookie 调 X 的 GraphQL 接口可翻页，实测一次拉到 124 条、回溯到 4 月。
//
// ── 凭据（state/x-auth.json，由管理员提供，不要提交到仓库）────────────────
//   { "auth_token": "...", "ct0": "...", "bearer": "Bearer AAAA..." }
//   - auth_token / ct0：从浏览器 DevTools → Application → Cookies → x.com 取
//   - bearer：从任意 graphql 请求的 Request Headers 取 authorization
//   文件不存在或字段不全 → 本模块整体不可用，调用方回退到免登录抓取。
//
// ── 两个会失效的东西（都要能明确报错，别静默失败）──────────────────────
//   ① Cookie 失效（改密码/登出/风控）→ HTTP 401 `Could not authenticate you` (code 32)
//   ② queryId 失效（X 发版会换 GraphQL 端点 ID）→ HTTP 404 `Query not found`
//   两者的处置不同：①要用户重新取 Cookie；②要更新下面的 QUERY_IDS。
//
// ⚠️ queryId 是硬编码的社区常量。X 改版后会失效——那时日志/报错会明确说
// 「Query not found」，按提示更新 QUERY_IDS 即可（从浏览器 Network 面板抄新 ID）。
import fs from 'node:fs';
import path from 'node:path';
import { proxyGet } from '../proxy-tunnel.js';

const X_HOST = 'https://x.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** GraphQL 端点 ID（X 发版可能更换；失效时报错会说 Query not found）。 */
export const QUERY_IDS = {
  UserByScreenName: 'G3KGOASz96M-Qu0nwmGXNg',
  UserTweets: 'E3opETHurmVJflFsUBVuUQ'
};

/** 各端点需要的 features 开关（X 要求与 queryId 匹配；少传会被 400 拒）。 */
const FEATURES = {
  UserByScreenName: {
    hidden_profile_subscriptions_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true
  },
  UserTweets: {
    rweb_video_screen_enabled: false,
    payments_enabled: false,
    rweb_profile_cards_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: false,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    rweb_video_vertical_aspect_ratio: 3.0,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    responsive_web_media_download_video_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_enhance_cards_enabled: false
  }
};

/** 凭据读取：不存在/字段不全返回 null（调用方据此回退免登录）。 */
export function loadAuth({ root }) {
  const file = path.join(root, 'state', 'x-auth.json');
  try {
    if (!fs.existsSync(file)) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const auth_token = String(j.auth_token ?? '').trim();
    const ct0 = String(j.ct0 ?? '').trim();
    if (!auth_token || !ct0) return null;
    const bearer = String(j.bearer ?? '').trim() || 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
    return { auth_token, ct0, bearer: /^Bearer\s/i.test(bearer) ? bearer : `Bearer ${bearer}`, file };
  } catch {
    return null;
  }
}

/** 凭据状态（供控制台/日志展示，不泄露值）。 */
export function describeAuth({ root }) {
  const a = loadAuth({ root });
  if (!a) return { available: false, reason: 'state/x-auth.json 不存在或字段不全' };
  return { available: true, authTokenLen: a.auth_token.length, ct0Len: a.ct0.length };
}

class AuthError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

function headers(auth) {
  return {
    'user-agent': UA,
    'authorization': auth.bearer,
    'x-csrf-token': auth.ct0,
    'cookie': `auth_token=${auth.auth_token}; ct0=${auth.ct0}`,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': 'en',
    'accept': '*/*',
    'referer': `${X_HOST}/`
  };
}

/** 统一发 GraphQL 请求，把两类失效翻译成可读错误（不要静默返回空）。 */
async function gqlOnce(op, variables, { proxy, timeoutMs = 30000, auth }) {
  const qid = QUERY_IDS[op];
  const feats = encodeURIComponent(JSON.stringify(FEATURES[op] || {}));
  const url = `${X_HOST}/i/api/graphql/${qid}/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${feats}`;
  const r = await proxyGet(url, { proxy, timeoutMs, headers: headers(auth) });
  const body = String(r.body ?? '');
  if (r.status === 401 || /Could not authenticate/i.test(body)) {
    throw new AuthError('X 登录凭据已失效（改密码/登出/风控都会导致）。请重新从浏览器取 auth_token 与 ct0，更新 state/x-auth.json', 'cookie');
  }
  if (r.status === 404 || /Query not found/i.test(body)) {
    throw new AuthError(`X 的 GraphQL 端点已变更（${op} 的 queryId 失效）。需要从浏览器 Network 面板取新的 queryId 更新 src/x-monitor/auth-fetch.mjs 的 QUERY_IDS`, 'queryid');
  }
  if (r.status === 429) throw new AuthError('X 限频（429），稍后再试', 'ratelimit');
  if (r.status !== 200) throw new AuthError(`X 接口返回 HTTP ${r.status}：${body.slice(0, 200)}`, 'http');
  try { return JSON.parse(body); } catch { throw new AuthError(`X 返回非 JSON：${body.slice(0, 200)}`, 'parse'); }
}

/**
 * 带重试的 GraphQL 请求。
 *
 * 为什么要重试：走代理时偶发 TLS 断连 / 响应不完整（实测 `Client network socket
 * disconnected before secure TLS connection was established`、`响应解析失败`）。
 * 这类瞬时故障会让整个抓取降级成免登录、丢掉翻历史的能力——实测 3 次里有 1 次踩到。
 * 所以重试给到 3 次、退避 1s/2s，把瞬时抖动挡掉。
 * **只对网络类错误重试**：凭据失效(401)/端点变更(404)/限频(429) 重试也没用，直接抛。
 */
async function gql(op, variables, { proxy, timeoutMs = 30000, auth, retries = 3 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await gqlOnce(op, variables, { proxy, timeoutMs, auth });
    } catch (e) {
      lastErr = e;
      // AuthError 带 kind 的是「明确失败」，重试无意义
      if (e instanceof AuthError) throw e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

/** 按 screen_name 取 userId（翻页要用 userId）。 */
export async function resolveUserId(handle, { proxy, auth }) {
  const user = String(handle ?? '').replace(/^@/, '').trim();
  if (!user) throw new Error('账号名为空');
  const j = await gql('UserByScreenName', { screen_name: user }, { proxy, auth });
  const r = j?.data?.user?.result;
  const id = String(r?.rest_id ?? '').trim();
  if (!id) {
    if (r?.reason === 'Suspended' || j?.data?.user?.result?.__typename === 'UserUnavailable') {
      throw new Error(`@${user} 账号不可用（可能已被冻结/注销）`);
    }
    throw new Error(`找不到 @${user}（账号名可能拼错）`);
  }
  const legacy = r?.legacy || {};
  return {
    id,
    handle: user,
    name: String(legacy.name || user),
    bio: String(legacy.description || ''),
    avatar: String(legacy.profile_image_url_https || '')
  };
}

/** 从 GraphQL 时间线响应里抽出推文与翻页 cursor（结构深且会变，用递归找）。 */
export function extractTimeline(json) {
  const tweets = [];
  let bottomCursor = null;
  const seen = new Set();
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    // 置顶项：`clientEventInfo.component === 'pinned_tweets'` 或 `socialContext.contextType === 'Pin'`。
    // **不能靠文本判断**——实测该账号的置顶帖正文以 `#RT` 开头（是个话题标签，不是转推标记），
    // 用 /^RT @/ 会漏判，结果置顶的 8-14 旧帖混进结果、还把「已翻到」的日期带偏。
    const pinned = n.clientEventInfo?.component === 'pinned_tweets'
      || n.socialContext?.contextType === 'Pin'
      || n.itemContent?.socialContext?.contextType === 'Pin';
    if (n.tweet_results?.result) {
      const res = n.tweet_results.result;
      const tw = res.tweet || res;             // 转推/引用会嵌一层 tweet
      const lg = tw.legacy || {};
      const id = String(tw.rest_id || lg.id_str || '');
      if (id && lg.created_at && !seen.has(id)) {
        seen.add(id);
        tweets.push({
          id,
          text: String(lg.full_text || lg.text || '').trim(),
          createdAt: String(lg.created_at),
          createdAtMs: Date.parse(lg.created_at) || 0,
          lang: String(lg.lang || ''),
          likes: Number(lg.favorite_count) || 0,
          replies: Number(lg.reply_count) || 0,
          // 转推判定：retweeted_status_result 存在即转推（免登录那套靠作者名比对，
          // 登录态这里能直接看出来，更准）
          isRetweet: !!lg.retweeted_status_result || /^RT @/.test(String(lg.full_text || '')),
          isPinned: !!pinned,
          authorHandle: String(tw.core?.user_results?.result?.legacy?.screen_name || tw.core?.user_results?.result?.core?.screen_name || ''),
          media: extractMedia(tw)
        });
      }
    }
    if (n.cursorType === 'Bottom' && n.value) bottomCursor = n.value;
    for (const v of Object.values(n)) walk(v);
  })(json);
  return { tweets, bottomCursor };
}

/** 抽出媒体（图/视频），字段形态与 syndication 不同，统一成同一套结构。 */
function extractMedia(tw) {
  const lg = tw.legacy || {};
  const out = [];
  const ext = lg.extended_entities || lg.entities || {};
  for (const m of (ext.media || [])) {
    const type = m.type === 'photo' ? 'photo' : (m.type === 'video' || m.type === 'animated_gif' ? 'video' : m.type);
    const item = { type, url: String(m.media_url_https || m.media_url || '') };
    if (type === 'video' && m.video_info?.variants) {
      const vs = m.video_info.variants
        .filter((v) => /video\/mp4/i.test(String(v.content_type || '')))
        .map((v) => ({ url: String(v.url || ''), bitrate: Number(v.bitrate) || 0, width: 0, height: 0 }))
        .filter((v) => v.url)
        .sort((a, b) => a.bitrate - b.bitrate);
      if (vs.length) item.videoVariants = vs;
    }
    if (item.url) out.push(item);
  }
  return out;
}

/**
 * 登录态抓取帖子（支持翻页，直到满足时间条件或达到页数上限）。
 *
 * @param {string} handle
 * @param {object} opts
 *   - proxy, auth       凭据（loadAuth 的返回值）
 *   - limit             最多返回几条
 *   - sinceMs/untilMs   时间窗口（翻页会一直翻到 sinceMs 之前才停）
 *   - maxPages          页数上限（默认 8，防无限翻；每页约 20 条）
 *   - gapMs             页间间隔（防风控，默认 1200）
 *   - ownOnly           只保留原创（跳过转推，默认 true）
 *   - scanLimit         最多检查多少条（防极端情况，默认 200）
 */
export async function fetchPostsAuth(handle, opts = {}) {
  const {
    proxy = '', auth, limit = 3, sinceMs = 0, untilMs = 0,
    maxPages = 8, gapMs = 1200, ownOnly = true, scanLimit = 200
  } = opts;
  if (!auth) throw new Error('缺少登录凭据');

  const user = await resolveUserId(handle, { proxy, auth });
  const want = String(handle).replace(/^@/, '').toLowerCase();

  const posts = [];
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  let scanned = 0;
  let oldestMs = 0;
  let stoppedByAge = false;
  let pinnedSkipped = 0;
  // ⚠️ 登录态时间线**不是纯倒序**：置顶项（可能是几个月前的）会排在第一条，
  // 所以不能用「遇到早于 sinceMs 的就停」——那样第一条置顶就会让整个抓取立即结束
  // （实测：扫 1 条就停、命中 0 条）。改为「连续 N 条都早于下界」才认为翻过头了。
  let consecutiveOld = 0;
  const OLD_RUN_TO_STOP = 3;

  while (pages < maxPages) {
    pages += 1;
    const vars = {
      userId: user.id,
      count: 20,
      includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: true,
      withVoice: true,
      withV2Timeline: true
    };
    if (cursor) vars.cursor = cursor;
    const json = await gql('UserTweets', vars, { proxy, auth });
    const { tweets, bottomCursor } = extractTimeline(json);
    if (!tweets.length) break;

    for (const t of tweets) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (scanned >= scanLimit) break;
      scanned += 1;
      if (!t.createdAtMs) continue;
      if (ownOnly && t.isRetweet) continue;
      // 置顶帖跳过（它可能排在时间线最前、且是几个月前的），与免登录那套同一策略
      if (t.isPinned) { pinnedSkipped += 1; continue; }
      // 作者校验：登录态时间线里偶尔混入推荐内容，按 handle 过滤（与免登录那套同思路）
      if (ownOnly && t.authorHandle && t.authorHandle.toLowerCase() !== want) continue;
      // oldestMs 只统计**通过筛选的原创帖**：置顶项/转推可能是几个月前的，
      // 计进来会让「已翻到 X 月 X 日」的提示严重失真（实测置顶那条 8-14 混进来，
      // 提示写成"已翻到 2026-08-14"，而实际只翻到 9 月底）。
      if (!oldestMs || t.createdAtMs < oldestMs) oldestMs = t.createdAtMs;
      if (sinceMs && t.createdAtMs < sinceMs) {
        consecutiveOld += 1;
        if (consecutiveOld >= OLD_RUN_TO_STOP) { stoppedByAge = true; break; }
        continue;
      }
      consecutiveOld = 0;
      if (untilMs && t.createdAtMs > Number(untilMs)) continue;
      posts.push({
        id: t.id,
        text: t.text,
        createdAt: t.createdAt,
        createdAtMs: t.createdAtMs,
        lang: t.lang,
        likes: t.likes,
        replies: t.replies,
        media: t.media.filter((m) => m.type === 'photo').map((m) => ({ type: 'photo', url: m.url })),
        video: buildVideo(t.media),
        user: { name: user.name, handle: user.handle, avatar: user.avatar },
        url: `${X_HOST}/${user.handle}/status/${t.id}`
      });
      if (posts.length >= limit) break;
    }

    if (stoppedByAge || posts.length >= limit || !bottomCursor) break;
    cursor = bottomCursor;
    await new Promise((r) => setTimeout(r, gapMs));
  }

  posts.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return {
    posts: posts.slice(0, limit),
    scanned,
    pages,
    skippedPinned: pinnedSkipped,
    pinnedIds: [],
    oldestMs,
    handle: user.handle,
    viaAuth: true
  };
}

/** 把登录态的 media 列表整理成与免登录一致的 video 结构（供 pickVideoVariant 用）。 */
function buildVideo(media) {
  const withVideo = media.find((m) => m.type === 'video' && m.videoVariants?.length);
  if (!withVideo) return null;
  return {
    variants: withVideo.videoVariants,
    durationMs: 0,        // 登录态接口不直接给时长；体积估算会退到分辨率兜底
    aspectRatio: [],
    poster: ''
  };
}
