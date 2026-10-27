// baidu.mjs — 百度搜索适配器（直连可用，中文语料相关性最好）
// 解析策略：按 <h3> 切结果块（百度每条结果的标题都在 h3 里），
// 标题取 h3 内文本，链接取 h3 内第一个 <a href>（多为 /link?url= 跳转链接，
// 若容器带 mu="真实URL" 属性则优先用真实 URL），摘要取结果块内的纯文本。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const stripTags = (s) =>
  String(s ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export default {
  id: 'baidu',
  label: '百度',
  proxyRequired: false,

  async search(query, { count = 8, timeoutMs = 12000, httpText }) {
    const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${Math.min(20, Math.max(1, count))}`;
    const html = await httpText(url, {
      timeoutMs,
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    });

    // 百度风控页：HTTP 200 但内容是安全验证
    if (/百度安全验证|wappass\.baidu\.com/.test(html)) {
      throw new Error('触发百度安全验证（风控）');
    }

    const results = [];
    const seen = new Set();
    const blocks = html.split(/<h3/g).slice(1);
    for (const block of blocks) {
      const scope = block.slice(0, 5000);
      // scope 从 <h3 开标签之后开始：标题 = 第一个 > 到 </h3> 之间
      const title = stripTags(scope.match(/[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? '');
      if (!title) continue;
      // 链接：优先容器上的 mu="真实URL"，其次 h3 里的第一个 <a href>
      let link = scope.match(/\smu="([^"]+)"/i)?.[1] ?? '';
      if (!/^https?:\/\//i.test(link)) {
        link = scope.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i)?.[1] ?? '';
      }
      if (!link) continue;
      // 摘要：取 </h3> 之后的纯文本（结果块剩余部分），避免把标题行的属性碎片带进来
      const afterTitle = scope.slice((scope.match(/<\/h3>/i)?.index ?? 0) + 5);
      const snippet = stripTags(afterTitle).slice(0, 200);
      if (seen.has(link)) continue;
      seen.add(link);
      results.push({ title, url: link, snippet: snippet.slice(0, 180) });
      if (results.length >= count) break;
    }
    return { engine: 'baidu', results };
  },
};
