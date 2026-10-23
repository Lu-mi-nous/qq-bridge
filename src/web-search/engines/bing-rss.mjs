// bing-rss.mjs — 必应 RSS 适配器（直连可用，结构化 XML，不依赖页面结构）
// 已知怪癖（2026-09-25 实测）：对部分中文长查询会返回 0 条（上游分词问题），
// 且 cn.bing.com 的 RSS 恒为空 —— 必须用 www.bing.com。
// 因此它在引擎链里排靠后位置，只作兜底，不作主力。
//
// 2026-10-18：与 bing-html 同一上游，同样会出现**多词查询降级**
// （`魔法少女的魔女审判 游戏` → 只返回「魔法」词条，但仍有 10 条"像样"结果）。
// 这里复用 bing-html 的判定与重试，避免两处逻辑漂移；
// 判据说明见 bing-html.mjs 顶部。
import { looksOffTopic, retryQueryFor } from './bing-html.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const unwrapCdata = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

export default {
  id: 'bing-rss',
  label: '必应 RSS',
  proxyRequired: false,

  async search(query, { count = 8, timeoutMs = 12000, httpText }) {
    const fetchOne = async (q) => {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&count=${Math.min(30, Math.max(1, count))}`;
      const xml = await httpText(url, {
        timeoutMs,
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      });

      const results = [];
      const seen = new Set();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const item = m[1];
        const title = unwrapCdata(item.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
        const link = unwrapCdata(item.match(/<link>([\s\S]*?)<\/link>/)?.[1]);
        const snippet = unwrapCdata(item.match(/<description>([\s\S]*?)<\/description>/)?.[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 180);
        if (!title || !link) continue;
        if (seen.has(link)) continue;
        seen.add(link);
        results.push({ title, url: link, snippet });
        if (results.length >= count) break;
      }
      return results;
    };

    const first = await fetchOne(query);
    if (!looksOffTopic(first, query)) return { engine: 'bing-rss', results: first };

    const retryQuery = retryQueryFor(query);
    if (!retryQuery || retryQuery === String(query ?? '').trim()) {
      return { engine: 'bing-rss', results: [], degraded: true, query };
    }
    const second = await fetchOne(retryQuery);
    if (!looksOffTopic(second, retryQuery)) {
      return { engine: 'bing-rss', results: second, retriedWith: retryQuery };
    }
    return { engine: 'bing-rss', results: [], degraded: true, query, retriedWith: retryQuery };
  },
};
