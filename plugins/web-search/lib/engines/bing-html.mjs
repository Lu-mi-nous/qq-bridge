// bing-html.mjs — 必应网页版适配器（直连可用）
// 关键参数（2026-09-25 实测，老代码失效的原因）：
//   - 域名必须用 www.bing.com（cn.bing.com 对脚本 UA 返回无结果空壳页）
//   - UA 必须是完整 Chrome 串（裸 "Mozilla/5.0" 会拿到无 b_algo 的壳）
//   - 带 mkt=zh-CN
// 页面结构依赖 <li class="b_algo">，必应改版会失效——届时引擎链会自动落到下一个引擎。
//
// ── 多词查询的降级（2026-10-18 / 2026-10-23 两次实测）──
//
// 现象：查询 `魔法少女的魔女审判`（无空格）返回萌娘百科/百科/BWIKI 全对；
// 同一标题后面**只要再跟一个词**（`魔法少女的魔女审判 游戏`）就只返回「魔法」词条，
// 摘要里连标题都不出现。`+` 连接、加引号、加书名号、换 mkt、换空格编码（%20 / +）
// 全都一样降级，所以**触发点是查询里出现了分词，不是编码**。
//
// 2026-10-23 的第二个现场：`南京 今天 明天 天气预报` 被降级成只匹配「南京」，
// 返回南京市百科/景点。旧判据看到"南京"命中就放行，模型拿到一堆旅游攻略后
// 回「搜不到实况」。现在把实体选择与降级判定抽到 ../query-plan.mjs：
//   - 实体词选「最长的实义词块」，时间/天气/疑问/通用请求词不参与；
//   - 天气查询额外要求结果里出现天气类词，否则判降级；
//   - 重试用 retryQueryFor()：天气查询拼成「南京天气」，其它查询用实体词。
//
// 危害在于**静默**：降级结果仍是 8 条格式正常的结果，`searchWeb` 只看 length>0
// 就判定成功、后续引擎不再尝试；模型拿到无关条目后如实说"没找到"——听起来像它不会搜。
//
// 已知边界：`橘雪梨` 这类**错字/别名**仍会降级到 `橘雪莉`（必应的纠错行为），
// 结果与查询无字面交集但其实是同一实体。这类情况重试后会返回空 —— 宁可报查不到，
// 也不要把「魔（汉语汉字）」当成答案发给群友。

import { looksOffTopic, retryQueryFor } from '../query-plan.mjs';
export {
  queryChunks,
  longestChunk,
  entityChunk,
  isWeatherQuery,
  weatherLocation,
  retryQueryFor,
  looksOffTopic,
} from '../query-plan.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ' '; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ' '; }
    })
    .replace(/&ensp;|&emsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

const stripTags = (s) => decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// 查询分词/实体识别/降级判定统一在 query-plan.mjs；上面的 re-export 保持旧测试与
// bing-rss 的导入路径不变。
export default {
  id: 'bing-html',
  label: '必应网页版',
  proxyRequired: false,

  async search(query, { count = 8, timeoutMs = 12000, httpText }) {
    const fetchOne = async (q) => {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&mkt=zh-CN&count=${Math.min(30, Math.max(1, count))}`;
      const html = await httpText(url, {
        timeoutMs,
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      });
      const results = [];
      const seen = new Set();
      const blocks = html.split('<li class="b_algo"').slice(1);
      for (const block of blocks) {
        const scope = block.slice(0, 6000);
        const urlStr = stripTags(scope.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i)?.[1] ?? '');
        const title = stripTags(scope.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? '');
        if (!urlStr || !title) continue;
        const snippet = stripTags(scope.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '').slice(0, 180);
        if (seen.has(urlStr)) continue;
        seen.add(urlStr);
        results.push({ title, url: urlStr, snippet });
        if (results.length >= count) break;
      }
      return results;
    };

    const first = await fetchOne(query);
    if (!looksOffTopic(first, query)) return { engine: 'bing-html', results: first };

    // 降级了：用实体词重试一次（天气查询拼成「南京天气」，其它用实体词）。
    const retryQuery = retryQueryFor(query);
    if (!retryQuery || retryQuery === String(query ?? '').trim()) {
      // 没有更窄的词可退——如实返回空，交给下一个引擎。
      return { engine: 'bing-html', results: [], degraded: true, query };
    }
    const second = await fetchOne(retryQuery);
    if (!looksOffTopic(second, retryQuery)) {
      return { engine: 'bing-html', results: second, retriedWith: retryQuery };
    }
    return { engine: 'bing-html', results: [], degraded: true, query, retriedWith: retryQuery };
  },
};
