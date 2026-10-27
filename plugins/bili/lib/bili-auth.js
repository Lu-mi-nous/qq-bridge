// B 站登录态（Cookie）读取与搜索。
//
// 需求（2026-10-19 用户）：加账号凭据，让机器人能自行搜索感兴趣的内容。
//
// ── 为什么需要凭据（实测）──
//
// B 站的 `search/type` 接口在**完全没有 Cookie** 时返回 `-412 request was banned`
// （这不是"没登录"，而是"裸请求特征"被风控）。
// 实测：`user-agent` + `referer` + `origin` 全齐但**不带 cookie** → -412；
// 只要带任意一个 `buvid3=...` → **code 0，正常返回 20 条**。
//
// 也就是说：**搜索本身不需要真实登录**。但用户明确选择用自己的账号 cookie，
// 那就走登录态——能拿到更准的个性化结果，也不会因为匿名设备号被限。
//
// ── 安全约定 ──
//
// - 凭据只从 `state/bili-auth.json` 读（`state/` 已在 .gitignore 里），
//   绝不写进 config.json、日志、错误信息或返回值。
// - 日志里只出现「已加载 / 未配置 / 已失效」，不打印 cookie 任何字符。
// - 文件格式：`{ "SESSDATA": "...", "bili_jct": "...", "buvid3": "...", "dedeuserid": "..." }`
//   只需要 SESSDATA + buvid3；其余可选。bili_jct 用于写操作，本模块**不使用**。
import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

/**
 * 读取 B 站凭据。
 *
 * @param {string} file 凭据文件绝对路径
 * @returns {{cookie:string, hasSessdata:boolean, loaded:boolean, reason?:string}}
 *   cookie 是拼好的 Cookie 头；**不要把它打进日志或返回值**。
 */
export function loadBiliAuth(file) {
  const fail = (reason) => ({ cookie: '', hasSessdata: false, loaded: false, reason });
  if (!file) return fail('未配置凭据文件路径');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fail('凭据文件不存在');
  }
  let obj;
  try {
    obj = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {
    return fail('凭据文件不是合法 JSON');
  }
  if (!obj || typeof obj !== 'object') return fail('凭据格式错误');

  const pick = (k) => String(obj[k] ?? '').trim();
  const sessdata = pick('SESSDATA');
  const biliJct = pick('bili_jct');
  const buvid3 = pick('buvid3');
  const dedeuserid = pick('dedeuserid') || pick('DedeUserID');

  // 至少要有一个身份或设备标识，否则拼出来的 Cookie 头等于没带
  if (!sessdata && !buvid3) return fail('凭据里既没有 SESSDATA 也没有 buvid3');

  const parts = [];
  if (sessdata) parts.push(`SESSDATA=${sessdata}`);
  if (biliJct) parts.push(`bili_jct=${biliJct}`);
  if (buvid3) parts.push(`buvid3=${buvid3}`);
  if (dedeuserid) parts.push(`DedeUserID=${dedeuserid}`);

  return {
    cookie: parts.join('; '),
    hasSessdata: !!sessdata,
    loaded: true,
    // 只有设备号没有登录态：能用搜索但不是个性化结果
    reason: sessdata ? undefined : '只有设备号（buvid3），未包含登录态 SESSDATA'
  };
}

/** 统一的请求头（含凭据）。凭据缺失时仍加一个匿名 buvid3，避免裸请求被 -412。 */
function headersFor(auth) {
  const cookie = auth?.cookie
    || 'buvid3=infoc-ANON-' + Math.random().toString(16).slice(2, 10).toUpperCase();
  return {
    'user-agent': UA,
    referer: REFERER,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    origin: REFERER.replace(/\/$/, ''),
    cookie
  };
}

async function biliApi(pathname, auth, opts = {}) {
  const url = pathname.startsWith('http') ? pathname : `https://api.bilibili.com${pathname}`;
  const res = await fetch(url, {
    headers: headersFor(auth),
    signal: AbortSignal.timeout(opts.timeoutMs || 15000)
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`B 站接口返回非 JSON（可能触发风控）：${(text || '').slice(0, 80).replace(/\s+/g, ' ')}`);
  }
  if (json.code !== 0) {
    // 注意：错误信息里不能带 cookie。json.message 是 B 站给的，不含凭据。
    throw new Error(`B 站接口错误 code=${json.code} ${json.message || ''}`.trim());
  }
  return json.data;
}

/**
 * 搜索视频。
 *
 * @param {string} keyword 关键词
 * @param {object} auth loadBiliAuth() 的返回
 * @param {{count?:number, order?:'totalrank'|'pubdate'|'click'|'dm', timeoutMs?:number}} opts
 *   order: totalrank(综合) / pubdate(最新) / click(播放多) / dm(弹幕多)
 * @returns {Promise<Array>} 与 fetchPopularVideos 同结构的视频数组
 */
export async function searchVideos(keyword, auth, opts = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) throw new Error('搜索关键词为空');
  const count = Math.min(50, Math.max(1, Number(opts.count) || 20));
  const order = ['totalrank', 'pubdate', 'click', 'dm'].includes(opts.order) ? opts.order : 'totalrank';
  // search/type 每页固定 20 条（传 ps 无效），所以要多条就翻页
  const pages = Math.ceil(count / 20);
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= pages; page++) {
    const d = await biliApi(
      `/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(kw)}&page=${page}&order=${order}`,
      auth,
      opts
    );
    const list = Array.isArray(d?.result) ? d.result : [];
    for (const v of list) {
      if (!v?.bvid || seen.has(v.bvid)) continue;
      seen.add(v.bvid);
      out.push({
        bvid: v.bvid,
        // 搜索结果标题带 <em class="keyword"> 高亮标签，必须剥掉
        title: String(v.title ?? '').replace(/<[^>]+>/g, ''),
        desc: String(v.description ?? '').slice(0, 200),
        durationSec: parseDuration(v.duration),
        owner: String(v.author ?? ''),
        cover: normalizePic(v.pic),
        category: String(v.typename ?? ''),
        view: Number(v.play) || 0,
        like: 0,
        danmaku: Number(v.video_review) || 0,
        pubdate: Number(v.pubdate) || 0,
        // 注：**搜索结果里没有 cid**（实测恒为 0）。不要以为这里能省一次 view 请求——
        // 拿 0 去调 playurl 会直接返回 `-400 请求错误`，表现为"看视频失败"。
        // 下游 watchVideo 会在 cid<=0 时自己补一次 fetchVideoInfo，见那里说明。
        cid: Number(v.cid) || 0
      });
      if (out.length >= count) break;
    }
    if (out.length >= count || !list.length) break;
    // 翻页之间稍等，避免触发限流
    if (page < pages) await new Promise((r) => setTimeout(r, 800));
  }
  return out;
}

/** 搜索结果里的 duration 是 "12:34" 或 "1:02:03" 格式，转成秒。 */
function parseDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v ?? '').trim();
  if (!s) return 0;
  const parts = s.split(':').map((x) => Number(x) || 0);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Number(s) || 0;
}

/** 搜索结果的封面是 `//i0.hdslb.com/...` 协议相对地址。 */
function normalizePic(pic) {
  const s = String(pic ?? '').trim();
  if (!s) return '';
  return s.startsWith('//') ? `https:${s}` : s;
}

/**
 * 从记忆里的口味归纳出搜索关键词。
 *
 * 为什么需要（用户要求「自行搜索感兴趣的内容」）：热门榜是别人决定的，
 * 搜索才能主动找"我喜欢的那类"。关键词来源：
 *   ① 群友常玩的游戏（GAME_KEYWORDS，优先级最高）
 *   ② 记忆里"喜欢"过的标签（taste.totalTags）
 *   ③ 分区名（如"二次元"→"动漫"）
 *
 * 2026-10-20 修：泛词（音乐/实况/MV 这类）不拿来搜索。
 * 实测记忆里 TOP 标签前五全是「整活、音乐、鸣潮、终末地、MV」——
 * 拿「音乐」去搜会得到一堆完全无关的热门歌，拿「MV」搜更是噪声。
 * 这类词**只能在选片时按分区权重用**，不适合当搜索词。
 *
 * @param {{likedTags?:Array<{name:string}>, categories?:Array<{name:string}>}} taste
 * @param {string[]} gameNames
 * @param {{max?:number}} opts
 */
export function buildSearchKeywords(taste, gameNames = [], opts = {}) {
  const max = Math.max(1, Math.min(12, Number(opts.max) || 6));
  const out = [];
  const push = (k) => {
    const s = String(k ?? '').trim();
    if (s && !out.includes(s) && out.length < max) out.push(s);
  };

  // ① 游戏优先（用户明确说群里多数人玩这些），但**不让它占满整个池子**。
  //    2026-10-20 修：原来 7 个游戏名直接把 max=6 填满，记忆里的偏好标签
  //    永远进不来，搜索就变成"只按游戏名搜"——多样化全靠热门榜。
  //    现在游戏最多占 2/3，剩下留给兴趣标签。
  const games = (Array.isArray(gameNames) ? gameNames : []).filter(Boolean);
  const gameSlots = Math.max(1, Math.min(games.length, Math.ceil(max * 0.67)));
  for (const g of games.slice(0, gameSlots)) push(g);

  // ② 记忆里喜欢过的标签（跳过泛词，见 SEARCH_STOPWORDS）
  for (const t of (Array.isArray(taste?.likedTags) ? taste.likedTags : [])) {
    const name = String(t?.name ?? '').trim();
    if (!name || SEARCH_STOPWORDS.has(name.toLowerCase())) continue;
    push(name);
  }

  // ③ 再补游戏（前面没放下的），最后才用分区兜底
  for (const g of games.slice(gameSlots)) push(g);

  const catMap = { 二次元: '动漫', 游戏: '游戏实况', 科技: '科技数码', 社会热点: '热点新闻', 知识: '科普', 鬼畜: '鬼畜' };
  for (const c of (Array.isArray(taste?.categories) ? taste.categories : [])) {
    const mapped = catMap[c?.name];
    if (mapped) push(mapped);
  }
  return out;
}

/**
 * 不适合当搜索词的泛词。
 *
 * 判定标准：这个词作为搜索词时，命中的是**海量不相干内容**，而不是"我喜欢的类型"。
 * 「音乐」搜出来是全网热门歌曲，「MV」搜出来是各种团的打歌舞台——
 * 它们只有在**分区权重**里才有意义（而且已经那样用了）。
 */
const SEARCH_STOPWORDS = new Set([
  '音乐', 'mv', '游戏', '实况', '影视', '电影', '电视剧', '动漫', '二次元',
  '生活', '搞笑', '科技', '数码', '舞蹈', '翻唱', '娱乐', 'vlog',
  '短片', '视频', '直播', '解说'
]);

/** 生成搜索用的查询串（随机构造，避免每次都是同一个词）。 */
export function pickSearchQuery(keywords, rng = Math.random) {
  const list = (Array.isArray(keywords) ? keywords : []).filter(Boolean);
  if (!list.length) return '';
  const base = list[Math.floor(rng() * list.length)];
  return base;
}
