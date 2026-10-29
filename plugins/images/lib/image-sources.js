// 图源适配器：从外部图站拉取图片元数据（可插拔多源）。
//
// 设计原则：
// - 每个源实现同一接口，新增源只加一个适配器，不动调用方。
// - 只返回**元数据**（url/作者/出处/分级），不在这里下载字节——下载与落盘
//   归 image-store.js，便于「先看元数据再决定要不要下载」以及统一限流。
// - 版权可追溯：尽量带上 source（原始出处链接）与 artist（画师），
//   发送时一并标注，这是使用第三方作品的基本礼貌也是合规要求。
//
// 分级安全：只接受全年龄内容。Safebooru 整站为 safe 分级（rating 字段为 g/s），
// 仍显式过滤一遍，防止将来换源或接口变动放进成人内容。
import { checkQuality } from './image-quality.js';
import { withPixivAuth, hasPixivCookie } from './pixiv-auth.js';

/** 统一的图片元数据形态。 */
// {
//   id:       源内唯一 id（用于去重）
//   source:   'safebooru' | 'pixiv' | ...
//   url:      图片直链（下载用）
//   page:     作品页/原始出处链接（标注用）——多为画师的 x.com 原帖
//   sourcePage: 图源站点自己的帖子页（「通过来源站点查找」用；见 sourcePageOf）
//   artist:   画师名（可能为空）
//   tags:     标签数组
//   rating:   分级（只接受全年龄）
//   width/height/size: 元数据（可能为 0/未知）
// }

const USER_AGENT = 'qq-bridge/0.1 (personal QQ bot; +https://github.com/DeepSeekHarness/qq-bridge)';

/**
 * 各图源「帖子页」的 URL 规则。用于在只知道图库 id 时反查站点页面。
 *
 * 为什么需要：图库里 `page` 存的是**原始出处**（多为画师的 x.com/twitter 原帖，
 * 实测 safebooru 45/150、yandere 5/12 都是），而群友/模型要「去来源站点查这张图」
 * 时，需要的是**图源站自己的条目页**（safebooru posts/N、yande.re post/show/N）。
 * 二者不是一回事，所以既存 page 也存 sourcePage，并在缺失时按此规则推导。
 * 规则已实测可用（HTTP 200）。
 */
export const SOURCE_PAGE_RULES = {
  safebooru: (id) => `https://safebooru.donmai.us/posts/${id}`,
  yandere: (id) => `https://yande.re/post/show/${id}`,
  pixiv: (id) => `https://www.pixiv.net/artworks/${id}`
};

/**
 * 取一张图的「图源站点页面」URL：优先用存下来的 sourcePage；
 * 老条目没有该字段时，按 id 推导（规则见 SOURCE_PAGE_RULES）。
 *
 * @param {{id?:string, source?:string, sourcePage?:string}} entry
 * @returns {string} 推导不出时返回 ''
 */
export function sourcePageOf(entry) {
  const stored = String(entry?.sourcePage ?? '').trim();
  if (stored) return stored;
  const m = /^([a-z]+):(\d+)$/.exec(String(entry?.id ?? '').trim());
  if (!m) return '';
  const rule = SOURCE_PAGE_RULES[m[1]];
  return rule ? rule(m[2]) : '';
}

// 只接受这些分级：safebooru 的 g(全年龄)/s(敏感) 属安全范围；
// e(explicit)/q(questionable) 一律丢弃。
const SAFE_RATINGS = new Set(['g', 's', 'safe', 'general']);

function isSafeRating(rating) {
  const r = String(rating ?? '').trim().toLowerCase();
  if (!r) return false;
  return SAFE_RATINGS.has(r);
}

async function fetchJson(url, timeoutMs = 20000) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  } catch (error) {
    // 网络层失败（超时/DNS/连接被拒）时退到代理重试一次。
    // 为什么需要：本机对部分图站域名会直连超时（实测 2026-09-24 起 safebooru.donmai.us
    // 直连一律 ETIMEDOUT，而经本机代理 200）。safebooru 是**默认图源**，不兜底就等于
    // 「按标签查图全废」。HTTP 状态码错误是确定性失败，不重试（避免对限流接口火上浇油）。
    if (Number.isFinite(error?.status) || !defaultProxy) throw error;
    const { proxyGet } = await import('../../../src/plugin-api/network.js');
    const r = await proxyGet(url, {
      proxy: defaultProxy,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      maxBytes: 16 * 1024 * 1024,
      timeoutMs: Math.max(timeoutMs, 30000)
    });
    if (r.status < 200 || r.status >= 300) {
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return JSON.parse(r.body.toString('utf8'));
  }
}

/** 直连失败时用于兜底的代理地址（由 fetchFromSources 按配置注入）。 */
let defaultProxy = '';
export function setDefaultImageProxy(proxy) {
  defaultProxy = String(proxy ?? '').trim();
}

// 兜底内容标签（无标签查询时使用）。
// 不能随便选：超高频标签（1girl / original / solo / flowers / sky / touhou 等）
// 与 order:score 组合会被上游拒（实测 HTTP 500，与 limit 无关），
// 因此兜底只用实测可用的中频标签，并按顺序尝试。
const FALLBACK_TAGS = ['cat', 'scenery', 'landscape', 'animal', 'ocean', 'city', 'portrait', 'hololive'];

/**
 * 标签名解析（纠错）：把用户/模型给的词映射到上游真实存在的标签名。
 *
 * 为什么需要：booru 标签是**精确全名**，角色/作品标签普遍带括号限定。例如
 * `aemeath` 精确标签 post_count=0（查不到），但真实标签是
 * `aemeath_(wuthering_waves)`（3573 张）。只报「没找到」会让模型一直换词瞎试，
 * 而正确做法是替它把名字修正过来。
 *
 * 策略：先精确命中就用原名；否则模糊搜索按作品图量降序取最优。
 * 返回 { name, exact } 或 null（实在没有相关标签）。
 */
export async function resolveTagName(word, timeoutMs = 15000) {
  const raw = String(word ?? '').trim();
  if (!raw) return null;
  const norm = raw.toLowerCase().replace(/\s+/g, '_');

  // 1) 精确命中（含别名/不区分大小写由上游处理）。
  //    注意：上游存在 post_count=0 的空标签占位（实测 aemeath 就有一条 0 张的记录），
  //    必须要求 postCount>0 才算真正可用，否则会「精确命中却查不到图」。
  try {
    const exact = await fetchJson(
      `https://safebooru.donmai.us/tags.json?search[name]=${encodeURIComponent(norm)}&limit=1`,
      timeoutMs
    );
    if (Array.isArray(exact) && exact[0]?.name) {
      const pc = Number(exact[0].post_count) || 0;
      if (pc > 0) return { name: exact[0].name, exact: true, postCount: pc };
    }
  } catch {}

  // 2) 模糊搜索，按 post_count 降序（上游 search[order]=count）。
  //    坑：上游 *word* 是全文匹配，`emis` 会命中 `fullmetal_alchemist`（字母碰巧凑出
  //    e-m-i-s 之外的顺序也不行，但它确实是子串），这类「语义无关的高图量标签」光靠
  //    图量门槛拦不住。因此**只接受以查询词开头的标签**（booru 的限定标签惯例正是
  //    `原名_(限定)` / `原名_xxx`），其余一律判为不可信。
  try {
    const list = await fetchJson(
      `https://safebooru.donmai.us/tags.json?search[name_matches]=${encodeURIComponent('*' + norm + '*')}&search[order]=count&limit=20`,
      timeoutMs
    );
    if (!Array.isArray(list) || !list.length) return null;
    // 严格前缀匹配：等价于查询「norm_*」或「norm(*」
    const prefixed = list
      .filter((t) => {
        const name = String(t?.name ?? '').toLowerCase();
        return name.startsWith(norm + '_') || name.startsWith(norm + '(');
      })
      .filter((t) => (Number(t.post_count) || 0) > 0)
      .sort((a, b) => (Number(b.post_count) || 0) - (Number(a.post_count) || 0));
    if (!prefixed.length) return null; // 没有以该词开头的标签 → 不纠错

    const best = prefixed[0];
    const pc = Number(best.post_count) || 0;
    // 图量门槛：前缀命中仍需足够图量，避免把用户带向同名冷门词
    // （如 hutao → hutao_yingying 仅 30 张，而用户想要的是原神胡桃）。
    const floor = Math.max(200, Number(prefixed[1]?.post_count ?? 0) * 0.5);
    if (pc < floor) return null;
    return { name: best.name, exact: false, postCount: pc, candidates: prefixed.slice(0, 5).map((t) => t.name) };
  } catch {
    return null;
  }
}

/**
 * 作品内角色校正：用户同时给了作品标签时，把「在该作品下查不到图的词」换成
 * 「该作品下真实存在的同名限定标签」。
 *
 * 为什么必须有这一层：`mint`（薄荷）本身是个**有效标签**（821 张，属于另一个作品），
 * 常规 `resolveTagName` 见它精确命中就放行了。但用户要的是「异环的薄荷」，其真实标签是
 * `mint_(nte)`（463 张，nte = neverness_to_everness 的缩写）。**只有引入作品约束**
 * 才能判定 mint 是错的（mint + 异环 = 0 张），进而找到正确的同作品标签。
 *
 * 做法：把该词与作品名拼成若干候选（`word_(franchise_缩写)`、`word_(franchise)` 等），
 * 逐个真实查询验证——不能只看标签名，因为作品在标签里常用缩写（nte）。
 * 只返回**确实有图**的候选。
 */
export async function resolveWithinFranchise(word, allTags, timeoutMs = 15000) {
  const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  const w = norm(word);
  if (!w) return null;
  // 找出其它标签里像「作品名」的（排除当前词本身与排序/时间修饰符）
  const others = (Array.isArray(allTags) ? allTags : [])
    .map(norm)
    .filter((t) => t && t !== w && !/^(order:|age:|date:|score:|rating:)/.test(t));
  if (!others.length) return null;

  // 先确认「原词 + 作品」确实查不到图（否则说明原词没问题，不必校正）
  for (const fr of others) {
    const direct = await countPosts(`${w} ${fr}`, timeoutMs);
    if (direct > 0) return null; // 原词在该作品下有图 → 不必校正
  }

  // 原词在各作品下都没图：尝试用「词 + 作品缩写/全名」模糊找同名限定标签
  try {
    const list = await fetchJson(
      `https://safebooru.donmai.us/tags.json?search[name_matches]=${encodeURIComponent(w + '*' )}&search[order]=count&limit=20`,
      timeoutMs
    );
    if (!Array.isArray(list)) return null;
    // 候选：以 word_ 开头（即限定形式），并按「在同作品下确实有图」验证
    const cands = list
      .filter((t) => t?.name && (Number(t.post_count) || 0) > 0)
      .filter((t) => String(t.name).toLowerCase().startsWith(w + '_') || String(t.name).toLowerCase().startsWith(w + '('));
    for (const c of cands) {
      for (const fr of others) {
        // 该候选标签是否与用户给的作品相关（标签名含作品缩写/全名，或实际共现可查）
        const n = String(c.name).toLowerCase();
        const frShort = fr.split('_')[0];
        const nameHint = n.includes(fr) || n.includes(frShort);
        const posts = nameHint ? 1 : await countPosts(`${c.name} ${fr}`, timeoutMs);
        if (posts > 0) {
          return { name: c.name, exact: false, postCount: Number(c.post_count) || 0 };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 查询某标签组合的图片数量（用于判定约束是否成立）。失败返回 0（保守）。 */
async function countPosts(tagQuery, timeoutMs = 15000) {
  try {
    const list = await fetchJson(
      `https://safebooru.donmai.us/posts.json?limit=1&tags=${encodeURIComponent(tagQuery)}`,
      timeoutMs
    );
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
}

/** 批量解析多个标签（保持顺序，解析失败的保留原词由上游处理）。 */
export async function resolveTagNames(words) {
  const out = [];
  const notes = [];
  for (const w of words) {
    const r = await resolveTagName(w);
    if (!r) {
      out.push(w);
      continue;
    }
    if (r.exact) {
      out.push(r.name);
    } else {
      out.push(r.name);
      notes.push(`${w} → ${r.name}（${r.postCount} 张）`);
    }
  }
  return { names: out, notes };
}

/**
 * 从 pixiv 链接或 ID 写法里抽出画师用户 ID。
 *
 * 为什么需要：群友不会按 `artist:83739` 这种格式说话，他们贴的是主页链接
 * （`pixiv.net/users/83739`），模型很可能原样塞进 tags。若不识别，这些写法会
 * **静默退化**成关键词搜索并返回 0 条——又回到「搜不到就说画师不存在」的老坑。
 *
 * 支持（实测 pixiv 主页链接的常见变体）：
 *   - 纯数字            `83739`
 *   - users 链接        `https://www.pixiv.net/users/83739`（含 /en/ 前缀、查询串）
 *   - 作品链接          `https://www.pixiv.net/artworks/136201011`
 *     ——作品 ID **不是**画师 ID，需再查一次 `/ajax/illust/{id}` 才能得到 userId，
 *       故此处只标记为「作品」，由调用方决定是否解析。
 *
 * @returns {{kind:'user'|'illust'|null, id:string}}
 */
export function parsePixivArtistRef(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { kind: null, id: '' };
  // 剥掉 artist:/user: 前缀后继续判断（模型可能两种都写）
  const body = s.replace(/^(?:artist|user):\s*/i, '').trim().replace(/[\/\s]+$/, '');
  // 1) 纯数字
  if (/^\d+$/.test(body)) return { kind: 'user', id: body };
  // 2) 链接里的 users/{id}（允许 /en/ 语言前缀与结尾查询串/斜杠）
  const u = /(?:^|\/\/|\.)pixiv\.net\/(?:[a-z]{2}\/)?users\/(\d+)/i.exec(body)
    ?? /^\/?users\/(\d+)/i.exec(body);
  if (u) return { kind: 'user', id: u[1] };
  // 3) 作品链接 → 作品 ID（非画师 ID，需二次查询）
  const a = /(?:^|\/\/|\.)pixiv\.net\/(?:[a-z]{2}\/)?artworks\/(\d+)/i.exec(body)
    ?? /^\/?artworks\/(\d+)/i.exec(body);
  if (a) return { kind: 'illust', id: a[1] };
  return { kind: null, id: '' };
}

/**
 * 统一「画师」查询语法，翻译成各源自己的写法。
 *
 * 用户/模型统一用 `artist:名字`（也接受 `user:名字`），本函数按源翻译：
 *   - safebooru：**裸名**（它的画师标签就是光名字；实测 `artist:x`/`user:x` 都返回 0 条）
 *   - yandere  ：**`user:名字`**（实测裸名 0 条，`user:名字` 才有结果）
 *   - pixiv    ：不加前缀，交给它的关键词搜索（pixiv 没有画师标签语法）
 *
 * 为什么必须翻译而不能统一原样传：这是**静默失败**（错误写法返回 0 条而非报错），
 * 排查困难。所以语法差异必须在这里一次性收口。
 *
 * @returns {{tag:string, isArtist:boolean}} tag 为该源要用的查询词
 */
export function translateArtistTag(sourceName, rawTag) {
  const m = /^(?:artist|user):\s*(.+)$/i.exec(String(rawTag ?? '').trim());
  if (!m) return { tag: String(rawTag ?? ''), isArtist: false };
  const name = m[1].trim();
  if (sourceName === 'yandere') return { tag: `user:${name}`, isArtist: true };
  if (sourceName === 'pixiv') return { tag: name, isArtist: true };
  return { tag: name, isArtist: true }; // safebooru 及默认：裸名
}

/** Safebooru（danbooru 系）适配器。整站全年龄，有公开 API、无需登录。 */
export const safebooru = {
  name: 'safebooru',
  needsAuth: false,
  // 该站不支持 rating:safe 这类过滤标签（会返回 0 条）——它整站就是 safe 分级，
  // 因此靠 tags 表达「要什么」，分级由返回的 rating 字段在 normalize 阶段过滤。
  //
  // 排序不是 query 参数而是**标签语法**（实测 search[order]=/order=/sort= 全部无效，
  // 返回与默认完全相同）：
  //   order:score   按热度（热门图/榜单）
  //   order:rank    按榜单排名
  //   order:random  随机
  //   age:<2day     限定时间窗，配合 order:score 即「近日热门 ≈ 日榜」
  //   date:2026-09-20  指定某天
  //
  // 两个上游脾气（都实测过）：
  //   1) 排序标签必须配内容标签，否则/或配超高频标签（1girl、original、solo…）
  //      会被拒（HTTP 500）。因此无标签时按 FALLBACK_TAGS 依次尝试。
  //   2) limit 过小时会做「相关性填充」，返回标签不含查询词的结果
  //      （实测 limit=3 查 cat 混入无关图）。因此客户端再做一次严格标签校验。
  async fetchList({ tags = [], limit = 20, order = 'score', maxAgeDays = 0, onCorrection = null, preferSingle = false } = {}) {
    const capLimit = Math.min(100, Math.max(4, limit)); // 下限 4：更小会触发相关性填充
    const noneTags = (t) => !/^(order:|age:|date:|score:|rating:)/.test(t);
    // 画师查询先翻译成本源的语法（safebooru = 裸名）。
    // 注意：翻译要在 noneTags 过滤**之前**做，否则 `artist:x` 会被当成内容标签原样发出（0 条）。
    const baseTags = (Array.isArray(tags) ? tags : [])
      .map((t) => translateArtistTag('safebooru', t).tag)
      .map((t) => String(t ?? '').trim())
      .filter(Boolean);

    // 排序/时间窗标签也算「标签配额」。Safebooru 匿名用户上限 2 个标签，
    // 所以 order:score 很贵——用户给 2 个内容标签时就没配额给排序了（实测 422）。
    let rankTagInUse = order !== 'new';
    // 偏好单人图时追加 `-multiple_girls`：实测能把「查角色返回大合照」从
    // 11/20 降到 0/20，是最有效的一个负向标签。它与排序标签**共用 2 个标签配额**
    // （实测 `角色 -multiple_girls -2girls` = 3 个标签 → 422），因此二者取其一，
    // 优先保「单人」——用户要的是角色，不是按热度排的大合照。
    let singleTagInUse = preferSingle === true;
    const buildQuery = (contentTags) => {
      const tl = [...contentTags];
      // 排序标签：单人偏好生效时不占配额（让位给 -multiple_girls）
      const rankTag = (!rankTagInUse || singleTagInUse) ? ''
        : order === 'random' ? 'order:random'
        : order === 'rank' ? 'order:rank'
        : 'order:score';
      if (rankTag) tl.push(rankTag);
      if (singleTagInUse) tl.push('-multiple_girls');
      if (maxAgeDays > 0) tl.push(`age:<${Math.round(maxAgeDays)}day`);
      return { tagStr: tl.join(' '), contentTags: contentTags.filter(noneTags) };
    };

    // 候选内容标签序列：优先用户给的；没有（或首个失败）时退兜底标签。
    // 用户给的若查不到，再做一轮「标签名纠错」重试（见 resolveTagName 的说明）。
    const userTags = baseTags.filter(noneTags);
    const candidates = userTags.length ? [userTags] : FALLBACK_TAGS.map((t) => [t]);
    const corrections = []; // 纠错记录（回传给调用方展示，便于告知正确标签名）
    let lastErr = null;
    let correctedTried = false; // 纠错只做一次（防止无限重试）

    for (let ci = 0; ci < candidates.length; ci++) {
      const contentTags = candidates[ci];
      const { tagStr, contentTags: verifyTags } = buildQuery(contentTags);
      const url = `https://safebooru.donmai.us/posts.json?limit=${capLimit}&tags=${encodeURIComponent(tagStr)}`;
      let list;
      try {
        list = await fetchJson(url);
      } catch (error) {
        lastErr = error;
        // 上游「拒绝执行这条查询」时不要直接抛：走纠错/降级重试可能就好了。
        // 实测两类拒绝：
        //   500 —— 「排序标签 + 超高频标签」组合被拒
        //   422 TagLimitError —— 标签数超限（**Safebooru 匿名用户最多 2 个标签**，
        //        而 order:score / age:<Nday 也都算一个标签！）
        // 之前只判 500，导致 422 直接抛给调用方，表现为「明明有图却报查不到」。
        const rejected = error?.status === 500 || error?.status === 422;
        if (!rejected) throw error;
        // 标签数超限：优先丢掉排序标签（内容正确比排序重要），重试一次。
        if (error?.status === 422 && rankTagInUse) {
          rankTagInUse = false;
          candidates.splice(ci + 1, 0, contentTags); // 在该轮之后插入一次无排序的重试
          continue;
        }
        // 单人偏好也可能撑爆配额（用户给了 2 个内容标签时）：丢掉它再试，
        // 拿得到图总比报「没找到」好——群像至少还能看。
        if (error?.status === 422 && singleTagInUse) {
          singleTagInUse = false;
          candidates.splice(ci + 1, 0, contentTags);
          continue;
        }
        // 仍被拒：无用户标签时换兜底轮转。
        if (!userTags.length) continue;
        // 有用户标签：**就地做标签纠错**（不能 continue——那会跳过循环末尾的纠错分支，
        // 而 ci 已 >0 导致纠错永远不触发。这是本分支之前修不好 varesa 的原因）。
        if (!correctedTried) {
          correctedTried = true;
          const fixed = [];
          for (const t of userTags) {
            const r = await resolveTagName(t);
            if (r && !r.exact && r.postCount > 0) {
              fixed.push(r.name);
              corrections.push({ from: t, to: r.name, postCount: r.postCount });
            } else {
              fixed.push(t);
            }
          }
          // 去冗：纠错后的全名可能已包含用户同时给的其它标签（如 varesa_(genshin_impact)
          // 已含 genshin_impact）。上游对重复约束会返回 0 条，看着像查不到。
          const dedup = fixed.filter((t) => {
            const low = t.toLowerCase();
            return !fixed.some((o) => o.toLowerCase() !== low && low.includes(o.toLowerCase()));
          });
          const next = dedup.length ? dedup : fixed;
          candidates.splice(ci + 1, 0, next);
          // 纠错后换用「新标签集合」，但下一轮的 ci>0，需允许它再做一次无排序重试
          rankTagInUse = false;
          continue;
        }
        return [];
      }
      if (!Array.isArray(list)) continue;

      const out = [];
      for (const p of list) {
        if (!p || !(p.file_url || p.large_file_url)) continue;
        // 严格标签校验：保证「查猫就给猫」
        if (verifyTags.length) {
          const hay = `${p.tag_string_general ?? ''} ${p.tag_string_character ?? ''} ${p.tag_string_copyright ?? ''} ${p.tag_string_artist ?? ''}`.toLowerCase();
          const allHit = verifyTags.every((t) => {
            const needle = String(t).toLowerCase();
            // 标签内用下划线，查询词可能用空格：两种形式都应命中
            return hay.includes(needle) || hay.includes(needle.replace(/_/g, ' ')) || hay.includes(needle.replace(/\s+/g, '_'));
          });
          if (!allHit) continue;
        }
        out.push({
          id: `safebooru:${p.id}`,
          source: 'safebooru',
          // 优先 large（体积可控），拿不到再退回 original
          url: p.large_file_url || p.file_url,
          // page：**原始出处**（多为 x.com/twitter 的画师原帖），群友问「这图哪来的」时最有用。
          page: p.source || `https://safebooru.donmai.us/posts/${p.id}`,
          // sourcePage：**图源站点自己的帖子页**。`p.source` 常是外部站点，所以
          // 「在图源站上查这张图」必须靠这个字段——见 sourcePageOf()。
          sourcePage: `https://safebooru.donmai.us/posts/${p.id}`,
          artist: String(p.tag_string_artist ?? '').split(/\s+/).filter(Boolean).join(', '),
          // 保留**完整**标签而非截断：booru 标签常多达 90+ 个，语义标签（scenery、
          // landscape 等）可能排在第 60 位之后；一旦截断，本地按标签检索就会漏图
          // （实测 scenery 排在第 63 位）。标签是纯文本，容量代价可接受。
          //
          // 必须**合并全部四个标签域**：上游把标签分类存放，角色/作品不在 general 里——
          // 角色在 tag_string_character（aemeath_(wuthering_waves)）、作品在
          // tag_string_copyright（wuthering_waves）。曾只存 general，导致「按角色/作品
          // 查图永远查不到」（查 aemeath 明明上游有 3573 张，本地却一张都匹配不上）。
          tags: [
            ...String(p.tag_string_general ?? '').split(/\s+/),
            ...String(p.tag_string_character ?? '').split(/\s+/),
            ...String(p.tag_string_copyright ?? '').split(/\s+/)
          ].filter(Boolean),
          rating: String(p.rating ?? ''),
          score: Number(p.score) || 0,
          width: Number(p.image_width) || 0,
          height: Number(p.image_height) || 0,
          size: Number(p.file_size) || 0,
          createdAt: String(p.created_at ?? '')
        });
      }
      if (out.length) {
        // 纠错事实要透出去：静默替换会让调用方误以为「按我说的词查到了」。
        // 实测事故：机器人把中文角色名译错（沃雅妮莎→vanessa），纠错悄悄换成
        // vanessa_(kof)（拳皇）后照常发图，于是「要原神的图」收到了拳皇角色。
        if (corrections.length && typeof onCorrection === 'function') {
          try { onCorrection(corrections); } catch {}
        }
        return out;
      }
      // 用户显式给了标签但没结果 → 尝试标签名纠错（booru 精确全名常带括号限定，
      // 例如 aemeath 实际是 aemeath_(wuthering_waves)）。
      // 用独立标志控制「只纠错一次」，**不能用 ci===0 判断**：422 降级分支会往
      // candidates 里插队，ci 早已不是 0，导致纠错永远进不去（实测 varesa 卡在这）。
      if (userTags.length && !correctedTried) {
        correctedTried = true;
        const fixed = [];
        for (const t of userTags) {
          // 先做「作品内校正」：若用户同时给了作品标签，而某个标签在该作品下查不到图，
          // 就用「该词 + 作品」去模糊搜索同名的限定标签。
          // 必要性：`mint` 本身是**有效标签**（821 张，另一个角色），
          // 常规纠错见它精确命中就放行了；但用户要的是「异环的薄荷」= `mint_(nte)`。
          // 有作品约束时才能判定 mint 是错的（mint + 异域作品 = 0 张）。
          const viaFranchise = await resolveWithinFranchise(t, userTags);
          if (viaFranchise) {
            fixed.push(viaFranchise.name);
            corrections.push({ from: t, to: viaFranchise.name, postCount: viaFranchise.postCount });
            continue;
          }
          const r = await resolveTagName(t);
          if (r && !r.exact && r.postCount > 0) {
            fixed.push(r.name);
            corrections.push({ from: t, to: r.name, postCount: r.postCount });
          } else {
            fixed.push(t);
          }
        }
        // 去冗：纠错后的全名可能已包含用户同时给的其它标签。
        // 实测：["varesa","genshin_impact"] → 纠成 ["varesa_(genshin_impact)","genshin_impact"]，
        // 后者冗余（已被前者包含），而上游对同一约束重复会返回 0 条，看着像查不到。
        // 注意方向：要删的是**被包含的短标签**（genshin_impact），不是包含者
        // （varesa_(genshin_impact)）—— 后者才是我们纠错的核心成果。
        const dedup = fixed.filter((t) => {
          const low = t.toLowerCase();
          return !fixed.some((o) => {
            const ol = o.toLowerCase();
            return ol !== low && ol.length > low.length && ol.includes(low);
          });
        });
        const next = dedup.length ? dedup : fixed;
        const changed = next.some((f, i) => f !== userTags[i]) || next.length !== userTags.length;
        if (changed) {
          candidates.push(next);
        }
        continue; // 下一轮用纠错后的标签重试
      }
      // 无用户标签（走兜底）时继续试下一个兜底标签
      if (!userTags.length) continue;
      // 有用户标签但没结果：
      //   - 还没纠错过 → continue 让下一轮（或下方纠错分支）再试一次；
      //     注意这里必须显式 continue，否则流程会走到循环末尾直接退出（曾这样丢掉纠错机会）。
      //   - 已纠错过 → 确实没有，返回空。
      // 实测：mint+异环 首轮 422，无排序重试返回 200 但 0 条，模型需要一个明确的
      // 「该角色在图站没有图」结论，而不是笼统的「没结果」。
      if (correctedTried) return [];
      continue;
    }
    // 走到这里说明所有候选轮都没结果。
    // 只有当「最后一轮是用户标签且实际报错」时才抛错——如果最后一轮成功返回 0 条
    // （例如 mint+异环 这种「标签各自有效、组合起来确实没图」），那是**正常空结果**，
    // 抛 422 会把上游那句「标签数超限」暴露给调用方，反而掩盖真相。
    if (lastErr && !userTags.length) throw lastErr;
    if (corrections.length) {
      const err = new Error(`标签已自动修正但无结果：${corrections.map((c) => `${c.from}→${c.to}`).join('、')}`);
      err.corrections = corrections;
      throw err;
    }
    return [];
  },
  /** 给出与查询词相近的、上游真实存在的标签名（用于「查不到」时提示正确写法）。
   *
   * 排序策略：**以查询词开头的标签优先**（这些通常正是用户想要的角色/作品全名，
   * 如 aemeath → aemeath_(wuthering_waves)），其次才是仅含该子串的。
   * 否则会给出一堆无关词（实测 emis 会先列出 fullmetal_alchemist），反而误导模型。 */
  async suggestTags(word, timeoutMs = 12000) {
    const norm = String(word ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!norm) return [];
    try {
      const list = await fetchJson(
        `https://safebooru.donmai.us/tags.json?search[name_matches]=${encodeURIComponent('*' + norm + '*')}&search[order]=count&limit=20`,
        timeoutMs
      );
      if (!Array.isArray(list)) return [];
      const usable = list.filter((t) => t?.name && (Number(t.post_count) || 0) > 0);
      const prefixed = usable.filter((t) => {
        const n = String(t.name).toLowerCase();
        return n.startsWith(norm + '_') || n.startsWith(norm + '(');
      });
      // 前缀命中优先展示（这些通常正是用户想要的全名）。
      if (prefixed.length) return prefixed.slice(0, 5).map((t) => `${t.name}(${t.post_count})`);
      // 没有前缀命中时：只展示「该词本就是其中一段」的（按词边界切分的整段匹配），
      // 排除字母碰巧凑成子串的无关词（实测 emis 会列出 fullmetal_alchemist，纯误导）。
      const segmentHit = usable.filter((t) => {
        const parts = String(t.name).toLowerCase().split(/[_()]/).filter(Boolean);
        return parts.includes(norm);
      });
      return segmentHit.slice(0, 5).map((t) => `${t.name}(${t.post_count})`);
    } catch {
      return [];
    }
  },
  normalizeSafe(entry) {
    return isSafeRating(entry.rating);
  }
};

/**
 * pixiv 适配器（日榜 / 关键词搜索）。
 *
 * 实测结论（经代理，2026-09-24）——**不需要登录 Cookie**：
 *   - `ranking.php?...&format=json` 日榜：HTTP 200，返回 contents[50]
 *   - `ajax/search/artworks/{word}` 搜索：HTTP 200，body.illustManga.data[]
 *   - 图床 `i.pximg.net`：**必须带 `Referer: https://www.pixiv.net/`**，
 *     不带一律 403（实测）。带 Referer 后 img-original 与 master1200 都能下。
 *
 * 关键实现点：
 *   1) 日榜/搜索返回的都是**缩略图 URL**（`/c/xxx/img-master/...` 或 custom-thumb），
 *      原图要按日期路径自行拼：把 `img-master/img/<日期路径>/<id>_p<N>_master1200.ext`
 *      换成 `img-original/img/<日期路径>/<id>_p<N>.jpg`。实测可下（1.55MB）。
 *   2) 分级看 `illust_content_type.sexual`（日榜）/ `xRestrict`（搜索）：
 *      **0 = 全年龄，1/2 = R-18**。实测日榜 50 条里 3 条非 0，**必须过滤**。
 *   3) 需经代理（本地 DNS 污染）。
 *
 * ⚠️ 版权：pixiv 条款禁止未经授权转载/再分发，画作版权归画师。默认禁用，
 * 开启即表示接受该风险；本适配器只做只读、低频拉取，并在发送时标注画师与作品页。
 */
export const pixiv = {
  name: 'pixiv',
  needsAuth: false,      // 实测无需登录（图床只需 Referer）
  requiresProxy: true,

  /** 缩略图 URL → 原图 URL 的**无扩展名**前缀（扩展名稍后探测）。
   *
   * 实测两种来源的缩略图后缀不同，必须都兼容：
   *   日榜：`..._p0_master1200.jpg`
   *   搜索：`..._p0_square1200.jpg` / `..._p0_custom1200.jpg`
   * 曾只匹配 `_master1200`，导致搜索路径全部解析失败（返回 0 条，看着像搜不到）。
   */
  _toOriginalBase(thumbUrl) {
    const s = String(thumbUrl ?? '');
    const m = s.match(/\/(?:img-master|custom-thumb)\/img\/(\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2})\/(\d+)_p(\d+)/);
    if (!m) return '';
    const [, datePath, id, pageNo] = m;
    return `https://i.pximg.net/img-original/img/${datePath}/${id}_p${pageNo}`;
  },

  async fetchList({ tags = [], limit = 20, order = 'score', maxAgeDays = 0, onCorrection = null, jsonFetch = null, rawFetch = null } = {}) {
    if (typeof jsonFetch !== 'function') throw new Error('pixiv 源需要代理（未注入 jsonFetch）');
    const capLimit = Math.min(50, Math.max(1, limit));
    // pixiv 没有画师标签语法，`artist:x` 只取名字交给它的关键词搜索。
    // 同时记住哪些 tag **显式带了** artist:/user: 前缀——只有这些才允许走
    // 「数字 ID = 画师」的解释，否则裸数字标签（如 ["2026"]）会被误当成画师 ID。
    const parsedTags = (Array.isArray(tags) ? tags : []).map((t) => translateArtistTag('pixiv', t));
    const userTags = parsedTags
      .map((r) => r.tag)
      .map((t) => String(t ?? '').trim())
      .filter(Boolean);
    const referer = 'https://www.pixiv.net/';

    // 登录态（可选，见 src/pixiv-auth.js）。
    // 只包在**这个源内部**，不加到 fetchFromSources 的 jsonFetch 工厂上：
    // 那个工厂是所有源共用的（safebooru / yande.re 也走它），把 cookie 加在那里
    // 等于把 pixiv 的登录态发给别的站——既是凭据泄露，也可能被对方的 WAF 拦。
    // 图床探测（rawFetch → i.pximg.net）也不带：那里只需要 Referer。
    const apiFetch = async (url, headers = {}) => {
      const h = hasPixivCookie() ? withPixivAuth(headers) : headers;
      try {
        return await jsonFetch(url, h);
      } catch (error) {
        // 503 在 pixiv 上有两种完全不同的原因，都不该被当成「标签写错了」：
        //   ① 站点维护（实测 2026-10-21 全站 503，官方维护页写到次日凌晨）
        //   ② 匿名 / 同出口 IP 请求过密被限流（凭据能缓解这一种）
        if (Number(error?.status) === 503) {
          const e = new Error(hasPixivCookie()
            ? 'pixiv 返回 503（站点维护或请求过密，稍后再试；与查询标签无关）'
            : 'pixiv 返回 503（站点维护，或匿名访问被限流；可在控制台配置登录凭据后重试）');
          e.status = 503;
          e.retryable = true;
          throw e;
        }
        throw error;
      }
    };

    // pixiv 的图床同时存在 jpg/png/gif 作品，日榜与搜索都**不告诉你格式**。
    // 实测：直接拼 .jpg 对 PNG 作品会 404（如 149984321 → 该作品是 .png）。
    // 因此探测可用扩展名并缓存（同一 id 不重复探测）。
    // 探测用注入的 rawFetch（返回 {status}，不解析 JSON）。
    const extCache = this._extCache ?? (this._extCache = new Map());
    const probeImageUrl = async (baseNoExt) => {
      const idKey = baseNoExt.split('/').slice(-2).join('/'); // 日期目录+文件名，够唯一
      const cached = extCache.get(idKey);
      if (cached) return `${baseNoExt}.${cached}`;
      if (typeof rawFetch === 'function') {
        for (const ext of ['jpg', 'png', 'gif']) {
          try {
            const st = await rawFetch(`${baseNoExt}.${ext}`, { referer });
            if (st >= 200 && st < 300) { extCache.set(idKey, ext); return `${baseNoExt}.${ext}`; }
            if (st !== 404) break; // 非 404（403/500）不再试其他格式
          } catch { break; }
        }
      }
      extCache.set(idKey, 'jpg'); // 探测不了就按 jpg 兜底（下载失败会被日志记录）
      return `${baseNoExt}.jpg`;
    };

    // 把条目规整为统一形态（日榜与搜索的字段名不同）
    const normalize = (raw, kind) => {
      const isRank = kind === 'rank';
      const id = isRank ? raw.illust_id : raw.id;
      // 分级：日榜用 illust_content_type.sexual，搜索用 xRestrict；0=全年龄
      const sexual = isRank ? Number(raw.illust_content_type?.sexual ?? 0) : Number(raw.xRestrict ?? 0);
      if (sexual !== 0) return null; // 只要全年龄
      const base = this._toOriginalBase(raw.url);
      if (!base) return null;
      return {
        id: `pixiv:${id}`,
        source: 'pixiv',
        _baseUrl: base, // 稍后探测扩展名再定 url
        page: `https://www.pixiv.net/artworks/${id}`,
        // pixiv 本身就是原始发布地，两者一致
        sourcePage: `https://www.pixiv.net/artworks/${id}`,
        artist: String(isRank ? (raw.user_name ?? '') : (raw.userName ?? '')),
        // 画师数字 ID：pixiv 三种来源都带（日榜 user_id / 搜索与 profile userId）。
        // 存下来才能让 `artist:<数字ID>` 在本地库命中（见 image-store 的 artistId）。
        artistId: String(isRank ? (raw.user_id ?? '') : (raw.userId ?? '')),
        tags: (isRank ? String(raw.tags ?? '').split(',') : (Array.isArray(raw.tags) ? raw.tags : String(raw.tags ?? '').split(' ')))
          .map((t) => String(t).trim()).filter(Boolean),
        rating: 'safe', // 已过滤 sexual/xRestrict != 0
        score: isRank ? Math.max(0, 1000 - (Number(raw.rank) || 999)) : 0, // 榜单名次→分数
        width: Number(raw.width) || 0,
        height: Number(raw.height) || 0,
        size: 0,
        createdAt: String(isRank ? (raw.date ?? '') : (raw.createDate ?? ''))
      };
    };

    let list = [];
    let kind = 'rank';
    // 画师引用解析：接受 `artist:83739`、**主页/作品链接**。
    // 为什么必须收链接：群友不会按 `artist:83739` 说话，他们贴 `pixiv.net/users/83739`，
    // 模型很可能原样传进来。不识别就会静默退化成关键词搜索并返回 0 条——
    // 又变成「搜不到就说画师不存在」那个坑。
    //
    // 但**裸数字**（无前缀、非链接）不算画师引用：`["2026"]` 这类普通数字标签
    // 会被误判成画师 ID，静默走错分支。链接则无歧义（没有内容标签长这样），放行。
    const looksLikeUrl = (t) => /pixiv\.net\/|^\/?users\/|^\/?artworks\//i.test(String(t));
    const refs = userTags
      .map((t, i) => ({ ref: parsePixivArtistRef(t), ok: parsedTags[i]?.isArtist === true || looksLikeUrl(t) }))
      .filter((x) => x.ok && x.ref.kind)
      .map((x) => x.ref);
    let numericArtist = refs.find((r) => r.kind === 'user')?.id ?? '';
    // 贴的是作品链接时，先查该作品拿到画师 userId（作品 ID ≠ 画师 ID）
    if (!numericArtist) {
      const illust = refs.find((r) => r.kind === 'illust');
      if (illust) {
        try {
          const d = await apiFetch(`https://www.pixiv.net/ajax/illust/${encodeURIComponent(illust.id)}`, { referer, accept: 'application/json' });
          const uid = d?.body?.userId;
          if (uid) numericArtist = String(uid);
        } catch { /* 解析失败就退化为关键词搜索 */ }
      }
    }
    if (numericArtist) {
      kind = 'user';
      const url = `https://www.pixiv.net/ajax/user/${encodeURIComponent(numericArtist)}/profile/top`;
      let data;
      try {
        data = await apiFetch(url, { referer, accept: 'application/json' });
      } catch (error) {
        // 画师 ID 不存在时 pixiv 返回 404（body 是 HTML，不是 JSON）。
        // 转成能直接告诉群友的话——否则模型只会看到「HTTP 404」，无法解释原因。
        if (error?.status === 404) {
          const e = new Error(`pixiv 上不存在用户 ID ${numericArtist}（画师可能已注销，或 ID 抄错了）。请核对主页链接 pixiv.net/users/${numericArtist}`);
          e.status = 404;
          e.empty = true;
          throw e;
        }
        throw error;
      }
      const illusts = data?.body?.illusts;
      list = Array.isArray(illusts) ? illusts : Object.values(illusts ?? {});
      if (!list.length && data?.error) {
        throw new Error(`pixiv 取画师作品失败：${data.message ?? '未知错误'}`);
      }
    } else if (userTags.length) {
      // 关键词搜索（pixiv 搜索用中文/日文/英文皆可，s_tag 为标签精确匹配）
      kind = 'search';
      const word = userTags.join(' ');
      const searchOnce = async (w) => {
        const url = `https://www.pixiv.net/ajax/search/artworks/${encodeURIComponent(w)}`
          + `?word=${encodeURIComponent(w)}&order=${order === 'new' ? 'date_d' : 'popular_d'}&mode=all&p=1&s_mode=s_tag`;
        const data = await apiFetch(url, { referer, accept: 'application/json' });
        return Array.isArray(data?.body?.illustManga?.data) ? data.body.illustManga.data : [];
      };
      list = await searchOnce(word);
      // 兜底：booru 系的 `name_(franchise)` 标签在 pixiv 上**通常不存在**
      // （pixiv 用日文/罗马字的空格分隔标签）。实测 `angelina_(arknights)` = 0 条，
      // 而 `angelina arknights` = 374 条；`varesa_(genshin_impact)` = 0 条，
      // 而 `varesa genshin impact` = 722 条。只加 `s_tag_full` 没用（那是精确匹配
      // 模式，反而把结果收窄），必须**去掉下划线与括号**改成空格分隔再搜一次。
      // 这一步很重要：否则群主要「pixiv 上找某角色」时会直接得到「搜不到」。
      if (!list.length && userTags.some((t) => /_\([^)]+\)/.test(t))) {
        const relaxed = userTags
          .map((t) => String(t).replace(/_/g, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' ');
        if (relaxed && relaxed !== word) {
          const alt = await searchOnce(relaxed);
          if (alt.length) {
            list = alt;
            onCorrection?.([{ from: word, to: relaxed, postCount: alt.length, note: 'pixiv 不接受 booru 系标签语法，已改用空格分隔查询' }]);
          }
        }
      }
    } else {
      // 日榜（不加标签时默认取日榜，与「safebooru 按热度」的默认语义一致）
      const url = `https://www.pixiv.net/ranking.php?mode=daily&content=illust&format=json`;
      const data = await apiFetch(url, { referer: `${referer}ranking.php` });
      list = Array.isArray(data?.contents) ? data.contents : [];
    }

    const out = [];
    for (const raw of list) {
      if (out.length >= capLimit) break;
      const e = normalize.call(this, raw, kind);
      if (e) out.push(e);
    }
    // 逐个确定扩展名（有缓存，代价可控）
    for (const e of out) {
      e.url = await probeImageUrl(e._baseUrl);
      delete e._baseUrl;
    }
    if (!out.length && userTags.length) {
      const err = new Error(`pixiv 搜不到「${userTags.join(' ')}」的全年龄结果（换个词或改用其他图源）`);
      err.empty = true;
      throw err;
    }
    return out;
  },

  /** 查不到时的相近词提示（pixiv 无标签搜索接口，返回空）。 */
  async suggestTags() {
    return [];
  },

  normalizeSafe(entry) {
    return isSafeRating(entry.rating);
  }
};
/**
 * yande.re 适配器（二次元图站，标签体系与 Safebooru 不同）。
 *
 * ⚠️ 与 Safebooru 的三个关键差别（都实测过）：
 *
 * 1) **该站含成人内容**。全站样本 200 张的分级分布是 `q:92 / s:69 / e:39`——
 *    成人向占多数。因此**必须**在请求里带 `rating:safe` 做服务端过滤（实测有效，
 *    只返回 s 级），并在本地按 rating 字段二次校验。
 *    **千万别写成 `rating:general`**——实测那个写法无效，仍会混入 q/e。
 *
 * 2) **图很大**。实测单张原图可达 19.5MB，而 `sample_url` 通常仅 0.4MB。
 *    因此优先用 sample_url（默认 8MB 上限下原图基本下不来）。
 *
 * 3) **必须经代理访问**。本地 DNS 把 yande.re 解析到 Facebook 的 IP 段（污染），
 *    直连必然超时；因此由调用方注入 `jsonFetch`（走代理隧道）。
 *    `requiresProxy: true` 标记此要求。
 *
 * 排序用 query 参数 `order=`（不是标签语法），且**无标签数上限**——
 * Safebooru 那个「最多 2 个标签」的坑在这里不存在。
 */
export const yandere = {
  name: 'yandere',
  needsAuth: false,
  requiresProxy: true,

  async fetchList({ tags = [], limit = 20, order = 'score', maxAgeDays = 0, onCorrection = null, jsonFetch = null } = {}) {
    if (typeof jsonFetch !== 'function') throw new Error('yandere 源需要代理（未注入 jsonFetch）');
    const capLimit = Math.min(100, Math.max(4, limit));
    const noneTags = (t) => !/^(order:|age:|date:|score:|rating:)/.test(t);
    // 画师查询翻译：yande.re 必须是 `user:名字`（实测裸名返回 0 条）。
    const userTags = (Array.isArray(tags) ? tags : [])
      .map((t) => translateArtistTag('yandere', t).tag)
      .map((t) => String(t ?? '').trim())
      .filter(Boolean);
    const corrections = [];

    // 排序：yande.re 用 query 参数。random 需注意它返回的是随机抽样。
    const orderParam = order === 'random' ? 'random' : order === 'new' ? 'id' : 'score';

    const buildUrl = (contentTags) => {
      // **永远带 rating:safe**：这是该站的安全硬线，不能省。
      const tl = [...contentTags, 'rating:safe'];
      return `https://yande.re/post.json?limit=${capLimit}&order=${orderParam}&tags=${encodeURIComponent(tl.join(' '))}`;
    };

    // 无标签时用兜底标签。**不能用 1girl/solo 这类通用标签**——实测 yande.re
    // 没有这些标签（tag.json 里都查不到，post 查询返回 0 条），它只收录
    // 作品/角色/画师/主题标签。因此用实测可用的中频主题标签轮换。
    const YANDERE_FALLBACK = ['wallpaper', 'landscape', 'tagme', 'rating:safe'];
    const candidates = userTags.length ? [userTags] : YANDERE_FALLBACK.map((t) => [t]);
    let correctedTried = false;
    let lastErr = null;

    for (let ci = 0; ci < candidates.length; ci++) {
      const contentTags = candidates[ci];
      const verifyTags = contentTags.filter(noneTags);
      let list;
      try {
        list = await jsonFetch(buildUrl(verifyTags));
      } catch (error) {
        lastErr = error;
        list = null;
      }

      const out = [];
      if (Array.isArray(list)) {
        for (const p of list) {
          if (!p || (!p.sample_url && !p.file_url)) continue;
          // 分级二次校验：服务端已过滤，这里再挡一道（防上游行为变化）
          if (!isSafeRating(p.rating)) continue;
          // 标签精确校验：避免「查猫给狗」。
          // 注意 `user:名字` 这类画师查询：上游的 tags 字段里**不含 `user:` 前缀**，
          // 画师名在 `author` 字段。若原样拿 `user:xxx` 去比对 tags，所有结果都会被
          // 误过滤成 0 条（实测踩到：URL 完全正确却始终返回空）。
          if (verifyTags.length) {
            const hay = String(p.tags ?? '').toLowerCase();
            const author = String(p.author ?? '').toLowerCase();
            const allHit = verifyTags.every((t) => {
              const raw = String(t).toLowerCase();
              const m = /^user:\s*(.+)$/.exec(raw);
              if (m) {
                const name = m[1].trim();
                return author === name || author.includes(name) || hay.includes(name);
              }
              return hay.includes(raw) || hay.includes(raw.replace(/_/g, ' '));
            });
            if (!allHit) continue;
          }
          out.push({
            id: `yandere:${p.id}`,
            source: 'yandere',
            // 优先 sample（原图可达 19.5MB，sample 通常 0.4MB）
            url: p.sample_url || p.file_url,
            // page：原始出处（多指向 x.com 等画师原帖）
            page: p.source || `https://yande.re/post/show/${p.id}`,
            // sourcePage：图源站自己的帖子页（查这张图在该站的标签/评分/讨论）
            sourcePage: `https://yande.re/post/show/${p.id}`,
            artist: String(p.author ?? ''),
            tags: String(p.tags ?? '').split(/\s+/).filter(Boolean),
            rating: String(p.rating ?? ''),
            score: Number(p.score) || 0,
            width: Number(p.sample_width || p.width) || 0,
            height: Number(p.sample_height || p.height) || 0,
            size: Number(p.sample_file_size || p.file_size) || 0,
            // created_at 是 unix 秒
            createdAt: p.created_at ? new Date(Number(p.created_at) * 1000).toISOString() : ''
          });
        }
      }

      if (out.length) {
        if (corrections.length && typeof onCorrection === 'function') {
          try { onCorrection(corrections); } catch {}
        }
        return out;
      }

      // 无结果 → 纠错重试一次（yande.re 标签名也常与直觉不同）
      if (userTags.length && !correctedTried) {
        correctedTried = true;
        const fixed = [];
        for (const t of userTags) {
          const r = await this.resolveTagName(t, jsonFetch);
          if (r && !r.exact && r.postCount > 0) {
            fixed.push(r.name);
            corrections.push({ from: t, to: r.name, postCount: r.postCount });
          } else fixed.push(t);
        }
        if (fixed.some((f, i) => f !== userTags[i])) candidates.push(fixed);
        continue;
      }
      if (!userTags.length) continue;
      return [];
    }
    // 兜底标签轮完仍无结果：保留 lastErr 供调用方判断（非致命）
    if (lastErr && !userTags.length) throw lastErr;
    return [];
  },

  /** 标签名解析（yande.re 的 tag.json，字段是 name/count，与 safebooru 不同）。 */
  async resolveTagName(word, jsonFetch, timeoutMs = 15000) {
    const norm = String(word ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!norm) return null;
    // 精确命中
    try {
      const exact = await jsonFetch(`https://yande.re/tag.json?name=${encodeURIComponent(norm)}&limit=1`);
      if (Array.isArray(exact) && exact[0]?.name && (Number(exact[0].count) || 0) > 0) {
        return { name: exact[0].name, exact: true, postCount: Number(exact[0].count) || 0 };
      }
    } catch {}
    // 模糊：只接受以查询词开头的限定形式（同 safebooru 策略：宁缺勿滥）
    try {
      const list = await jsonFetch(`https://yande.re/tag.json?name=${encodeURIComponent(norm)}*&limit=20&order=count`);
      if (!Array.isArray(list)) return null;
      const prefixed = list
        .filter((t) => t?.name && (Number(t.count) || 0) > 0)
        .filter((t) => {
          const n = String(t.name).toLowerCase();
          return n.startsWith(norm + '_') || n.startsWith(norm + '(');
        })
        .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0));
      if (!prefixed.length) return null;
      const best = prefixed[0];
      // 图量门槛：避免把用户带向同名冷门词
      if ((Number(best.count) || 0) < 50) return null;
      return { name: best.name, exact: false, postCount: Number(best.count) || 0 };
    } catch {
      return null;
    }
  },

  /** 查不到时列出相近的真实标签（供模型自我纠正）。 */
  async suggestTags(word, jsonFetch) {
    if (typeof jsonFetch !== 'function') return [];
    try {
      const norm = String(word ?? '').trim().toLowerCase().replace(/\s+/g, '_');
      const arr = await jsonFetch(`https://yande.re/tag.json?name=${encodeURIComponent(norm)}*&limit=12&order=count`);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((t) => t?.name && (Number(t.count) || 0) > 0)
        .slice(0, 6)
        .map((t) => `${t.name}(${t.count})`);
    } catch {
      return [];
    }
  },

  normalizeSafe(entry) {
    return isSafeRating(entry.rating);
  }
};

/** 可用源注册表。 */
export const SOURCES = { safebooru, pixiv, yandere };

/** 按配置取源实例；未配置或未启用返回 null。 */
export function getSource(name) {
  return SOURCES[String(name ?? '').trim()] ?? null;
}

/**
 * 多源聚合拉取：按 cfg.sources 里 enabled 的源依次取，合并去重。
 * 单源失败不影响其它源（记录到 errors 返回）。
 *
 * opts 可覆盖单个源的 tags/limit/order/maxAgeDays，用于「按需查特定图」：
 * fetchFromSources(cfg.sources, { tags:['cat'], order:'score' })
 */
/**
 * 按一批结果的分数分布计算自适应分数门。
 *
 * - 少于 4 条：样本不足，不启用（返回 null）。
 * - 整批都是 0 分：该源没有提供分数信号（pixiv 搜索就是这种），不启用——
 *   否则「绝对底限 1」会把搜索结果全部判成低质（真实事故）。
 * - 否则取半中位，且不低于绝对底限。
 */
export function adaptiveScoreGate(rawScores, absFloorInput = 1) {
  const scores = (Array.isArray(rawScores) ? rawScores : [])
    .map((n) => Number(n) || 0)
    .filter((n) => Number.isFinite(n))
    .sort((x, y) => x - y);
  if (scores.length < 4) return null;
  if (!(scores[scores.length - 1] > 0)) return null;
  const mid = scores[Math.floor(scores.length / 2)];
  const absFloor = Math.max(0, Number(absFloorInput ?? 1));
  return Math.max(absFloor, Math.floor(mid / 2));
}

export async function fetchFromSources(cfgSources, opts = {}) {
  const out = [];
  const errors = [];
  const corrections = []; // 标签名纠错记录（{from,to,postCount}）：调用方据此知道实际查的词
  const seen = new Set();
  const qualityNotes = [];
  // 质量门选项：可在配置里关掉或调阈值（质量门宁可保守，不该因调参把可用图全滤掉）
  const qualityOpts = opts.quality === false ? null : (opts.quality ?? {});
  // 给 fetchJson 兜底用的代理：safebooru 这类「直连为主」的源若直连超时（本机对
  // donmai.us 实测会 ETIMEDOUT），自动退到该代理重试，避免默认图源整个失效。
  setDefaultImageProxy(opts.proxy ?? '');
  // 限定图源：群主说「从 pixiv 找」「只从 safebooru 找」时，**只查这些源**。
  // 为什么必须在拉取侧就限制：各源结果会混进同一个库，若只在前端筛，
  // 仍会白白拉一堆别的站的图占空间，且「按需现拉」的语义也错了。
  //
  // 三种语义必须分清（`undefined` 与 `[]` 不同！）：
  //   undefined / 不传 → 不限源
  //   ['pixiv']        → 只查 pixiv
  //   []（空数组）      → **一个源都不查**（调用方发现指定的源都不可用时用这个
  //                      表达"结果必须为空"；若当成"不限源"就会返回别的站的图）
  const sourcesSpecified = Array.isArray(opts.sources);
  const onlySources = sourcesSpecified
    ? opts.sources.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean)
    : [];
  for (const [name, sc] of Object.entries(cfgSources ?? {})) {
    if (!sc || sc.enabled !== true) continue;
    if (sourcesSpecified && !onlySources.includes(String(name).toLowerCase())) continue;
    const src = getSource(name);
    if (!src) {
      errors.push(`${name}: 未知图源`);
      continue;
    }
    // 需要代理的源（如 yande.re，本地 DNS 被污染）：按源配置或全局配置取代理地址，
    // 用代理隧道拉 JSON——否则直连必然超时。
    const proxy = String(sc.proxy ?? opts.proxy ?? '').trim();
    let jsonFetch = null;
    let rawFetch = null;
    if (src.requiresProxy || proxy) {
      if (!proxy) {
        errors.push(`${name}: 该源需要代理（请在配置里设置 sources.${name}.proxy 或全局 images.proxy）`);
        continue;
      }
      const { proxyGet } = await import('../../../src/plugin-api/network.js');
      // 带重试：代理链路对**密集请求**有限流（实测：间隔 300ms 连测会超时失败，
      // 间隔 2.5s 则 8/8 全成功），所以退避要给足——0.5s 太短会连着撞限流。
      // 图源接口是幂等 GET，重试安全。HTTP 4xx/5xx 属确定性失败，不重试
      // （避免对限流接口火上浇油）。
      const PROXY_RETRY_BACKOFF_MS = [1500, 3500];
      jsonFetch = async (url, extraHeaders = {}) => {
        let lastErr = null;
        for (let attempt = 0; attempt <= PROXY_RETRY_BACKOFF_MS.length; attempt++) {
          try {
            const r = await proxyGet(url, {
              proxy,
              headers: { 'user-agent': 'qq-bridge/0.1 (personal QQ bot)', ...extraHeaders },
              maxBytes: 16 * 1024 * 1024,
              timeoutMs: 30000
            });
            if (r.status < 200 || r.status >= 300) {
              const err = new Error(`HTTP ${r.status}`);
              err.status = r.status;
              throw err;
            }
            return JSON.parse(r.body.toString('utf8'));
          } catch (error) {
            lastErr = error;
            // HTTP 状态码错误（含 4xx/5xx）：确定性失败，直接抛
            if (Number.isFinite(error?.status)) throw error;
            // 网络/解析类：按实测的限流间隔退避后重试
            const wait = PROXY_RETRY_BACKOFF_MS[attempt];
            if (wait) await new Promise((s) => setTimeout(s, wait));
          }
        }
        throw lastErr;
      };
      // rawFetch：只回状态码，用于探测图片扩展名（pixiv 需要知道自己该用 .jpg 还是 .png）。
      // 用 headOnly 模式只读响应头即断开，不为探测下载整张图。
      rawFetch = async (url, extraHeaders = {}) => {
        const r = await proxyGet(url, {
          proxy,
          headers: { 'user-agent': 'qq-bridge/0.1 (personal QQ bot)', ...extraHeaders },
          headOnly: true,
          timeoutMs: 20000
        });
        return r.status;
      };
    }
    try {
      const list = await src.fetchList({
        // 显式传入的 tags 覆盖配置里的固定 tags（「按需查询」语义）；
        // 未传时才用配置的固定 tags（「日常补货」语义）。
        tags: Array.isArray(opts.tags) && opts.tags.length ? opts.tags : (sc.tags ?? []),
        limit: opts.limit ?? sc.limit ?? 20,
        order: opts.order ?? sc.order ?? 'score',
        maxAgeDays: opts.maxAgeDays ?? sc.maxAgeDays ?? 0,
        // 偏好单人图：查角色时追加 `-multiple_girls`，避免「要角色给大合照」。
        // 默认只对**角色形态的标签**（形如 `name_(franchise)`）启用：通用标签
        // （cat/scenery）加负向标签没有意义，还会白占掉 2 个标签配额里的一个。
        // 调用方也可显式传 true/false 覆盖。
        preferSingle: opts.preferSingle ?? (Array.isArray(opts.tags) && opts.tags.some((t) => /_\([^)]+\)$/.test(String(t)))),
        jsonFetch,
        rawFetch,
        // 纠错回调：把「实际用的是哪个标签」透出去（见 fetchList 内注释的静默纠错事故）
        onCorrection: (list_) => {
          for (const c of list_) {
            if (!corrections.some((x) => x.from === c.from)) corrections.push(c);
          }
        }
      });
      let kept = 0;
      let rejected = 0; // 本源的「质量门剔除数」，供日志与调参

      // ── 分数门槛自适应（2026-10-21 修「经常查不到」）──
      //
      // 原来 `SCORE_FLOOR.safebooru = 5` 是**固定阈值**，依据是"该站热门图能到 800+"。
      // 但实测那个依据只对**角色图**成立：通用标签的分数天然低得多——
      //   beach scenery 中位 1 / max 7；1girl landscape 中位 2 / max 22；
      //   cat 中位 3 / max 30；wuthering_waves 中位 9 / max 32。
      // 于是「beach/scenery」这类查询 10 条**全部**被 `分数 < 5` 挡掉，
      // 日志只剩"拉取到 N 条但全被过滤"，表现为"这站查不到图"。
      //
      // 改法：按**本批结果自己的分数分布**取阈值（中位数一定放行一半），
      // 同时保留一个**极低绝对底限**（默认 1）挡掉真正 0 分的冷门/垃圾图。
      // 这样"分数高的一批"和"分数本来就不高的一批"都能出图，而不是一刀切。
      let batchScoreGate = null;
      if (qualityOpts && qualityOpts.useTags !== false) {
        const scores = list.map((e) => Number(e?.score) || 0);
        batchScoreGate = adaptiveScoreGate(scores, qualityOpts.scoreAbsoluteFloor);
      }

      for (const e of list) {
        if (!e?.url) continue;
        // 分级过滤：只保留全年龄。拿不到分级信息的源按「不安全」丢弃更保守，
        // 但对自带评级的源（safebooru）放行 g/s。
        if (!src.normalizeSafe(e)) continue;
        // 质量门：用图站的人工标签+社区分数筛掉低质图（sketch/bad_anatomy/lowres、
        // 分数过低、分辨率过小）。见 image-quality.js 的设计说明。
        if (qualityOpts) {
          // 分数下限：取「固定阈值」与「自适应阈值」中**更宽松**的那个。
          // 只放宽、不收紧——不能因为某批图分数都低，就把原本严格的高分源也放水。
          let effFloor = Number(qualityOpts.scoreFloor);
          if (Number.isFinite(effFloor) && effFloor > 0) {
            effFloor = batchScoreGate === null ? effFloor : Math.min(effFloor, batchScoreGate);
          } else {
            // 调用方没给固定值 → 直接用自适应值（没有就交给 checkQuality 按源默认）
            effFloor = batchScoreGate === null ? undefined : batchScoreGate;
          }
          const q = checkQuality(e, effFloor === undefined
            ? qualityOpts
            : { ...qualityOpts, scoreFloor: effFloor });
          if (!q.ok) { rejected++; continue; }
        }
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push(e);
        kept++;
      }
      if (rejected > 0) qualityNotes.push(`${name} 质量门剔除 ${rejected} 张`);
      if (!kept && list.length) errors.push(`${name}: 拉取到 ${list.length} 条但全被过滤（分级/质量/去重）`);
      if (!kept && !list.length) {
        // 查不到时给出「上游真实存在的相关标签」，让调用方能自我纠正而不是瞎换词。
        // 这是本模块最有价值的一条反馈：booru 标签是精确全名，用户/模型猜的词
        // 常常只是真实标签的前缀或被限定名（aemeath → aemeath_(wuthering_waves)）。
        const asked = Array.isArray(opts.tags) && opts.tags.length ? opts.tags : (sc.tags ?? []);
        let hint = '';
        if (src.suggestTags && asked.length) {
          try {
            const sug = await src.suggestTags(asked[0]);
            if (sug?.length) hint = `；上游存在的相近标签：${sug.slice(0, 5).join('、')}`;
          } catch {}
        }
        errors.push(`${name}: 没有「${asked.join('/') || '(无标签)'}」的结果${hint}`);
      }
    } catch (error) {
      errors.push(`${name}: ${error?.message ?? error}`);
    }
  }
  return { entries: out, errors, corrections, qualityNotes };
}
