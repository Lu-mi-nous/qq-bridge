// duckduckgo.mjs — DuckDuckGo HTML 版适配器（国内直连被墙，必须走代理）
// 用 html.duckduckgo.com/html/ 端点（纯 HTML，无 JS），结果类名 result__a / result__snippet。
// 链接是 //duckduckgo.com/l/?uddg=<urlencode 的真实URL>&rut=...，需解出真实地址。
// 依赖项目现有代理隧道（proxyGet 走 CONNECT），代理地址由 config 的 webSearch.proxy 提供。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const stripTags = (s) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// 从 ddg 跳转链接解出真实 URL；解不出来就原样返回（可能是直链）
function realUrl(href) {
  const m = String(href ?? '').match(/[?&]uddg=([^&]+)/);
  if (!m) return href.startsWith('//') ? `https:${href}` : href;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return href;
  }
}

export default {
  id: 'duckduckgo',
  label: 'DuckDuckGo',
  proxyRequired: true,

  async search(query, { count = 8, timeoutMs = 12000, proxy = '', httpText }) {
    if (!proxy) throw new Error('需要代理但未配置（webSearch.proxy 为空）');
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=cn-zh`;
    const html = await httpText(url, {
      proxy,
      timeoutMs,
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    });

    // 反爬/异常页：无结果锚点时直接交空，让引擎链落到下一个
    const results = [];
    const seen = new Set();
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripTags(m[1]));
    let idx = 0;
    for (const m of html.matchAll(re)) {
      const urlStr = realUrl(m[1]);
      const title = stripTags(m[2]);
      if (!urlStr || !title || !/^https?:\/\//i.test(urlStr)) continue;
      if (seen.has(urlStr)) continue;
      seen.add(urlStr);
      results.push({ title, url: urlStr, snippet: (snippets[idx] ?? '').slice(0, 180) });
      idx += 1;
      if (results.length >= count) break;
    }
    return { engine: 'duckduckgo', results };
  },
};
