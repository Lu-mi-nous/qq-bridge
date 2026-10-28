import { z } from 'zod';

// 描述与结果格式由搜索插件维护；注册权与声明校验由宿主负责。
export function registerSearchTool(ctx, { searchWeb, describeEngines, sanitizeQuery }) {
  ctx.mcp?.registerTool(
  'web_search',
  '联网搜索（只读）：当群友问时事/新闻/事实/价格/天气/梗的含义，或任何你不确定、需要依据的信息时调用。多引擎自动回退（天气→百度→必应→DuckDuckGo），天气类查询直接返回实时天气数据；其它查询返回标题/URL/摘要。回答时请注明信息来自搜索。仅搜索，不执行任何本地操作。',
  { query: z.string().describe('搜索关键词（群友想查什么就搜什么，可中英文）') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await searchWeb(clean);
      if (result.results.length) {
        // retriedWith：上游把多词查询降级了（只匹配第一个词），引擎改用更窄的词重搜才拿到结果。
        // 必须明确告诉模型"这条是搜 X 得到的"，否则它会把这个答案算到原查询头上。
        const notes = [];
        if (result.retriedWith) {
          notes.push(`注意：原查询「${clean}」在上游被降级为只匹配首个关键词，本次结果来自检索「${result.retriedWith}」。若与问题不符，请换更具体的关键词重搜，不要把这些结果当成原查询的直接答案。`);
        }
        if (result.engine === 'weather') {
          notes.push('本次结果是 Open-Meteo 的实时观测/预报数据（含当前温度、体感、湿度、降水和未来几天预报），可直接引用；回答时说明观测时间。');
        }
        const note = notes.length ? notes.join('\n') : null;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(
              {
                query: result.query,
                engine: result.engine,
                count: result.results.length,
                results: result.results,
                tried: result.tried,
                ...(result.retriedWith ? { retriedWith: result.retriedWith, note } : note ? { note } : {})
              },
              null,
              2
            ),
          }],
        };
      }
      const engineStatus = await describeEngines();
      return {
        content: [{
          type: 'text',
          text: `搜索未得到结果：${result.error}\n尝试记录：${JSON.stringify(result.tried)}\n引擎状态：\n${engineStatus}\n提示：DuckDuckGo 需要代理；引擎开关与顺序在 config.json 的 webSearch.engines（改完即生效）。`,
        }],
        isError: true,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  },
    { isEnabled: () => ctx.config.get()?.enabled !== false }
  );
}
