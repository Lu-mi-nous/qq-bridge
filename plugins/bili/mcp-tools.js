import { z } from 'zod';

export function registerBiliTools(ctx) {
 {
  ctx.mcp?.registerTool(
    'qq_bili_record',
    '记录你刚才看B站视频的真实感受（记住你喜欢什么）。看完一条视频后调用，会在本地形成**跨群共用**的观看记忆。\n\n'
    + '【诚实记录】liked 是你真实的喜好，不是"能不能看完"。不喜欢的视频也记录（liked=false），这同样有价值——'
    + '它帮你之后避开同类。不要为了显得"积极"就全填喜欢。\n'
    + 'interest 用绝对刻度，别都堆在 60~70：0~20=无聊想划走 / 30~45=没感觉 / 50~60=还行但看完就忘 / '
    + '65~75=有意思、愿意看完 / 80~90=很喜欢、会主动找同题材 / 95+=罕见。'
    + '大部分随手刷到的视频应该在 30~60——每条都给 70 的话这个分数就没用了。\n'
    + 'tags 2~5 个：类型/题材/情绪，比如「搞笑」「整活」「治愈」「技术向」「鬼畜」「剧情」。这些标签决定以后系统怎么归纳你的口味。\n'
    + 'notes 一句话：为什么喜欢/不喜欢（例如"节奏快，笑点密" / "太拖了，讲了半天没重点"）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      // bvid **不要传**：模型记不住 10 位随机串，实测它会瞎编一个（缓存查不到、
      // 记忆里存成两条不同的视频）。桥接自动用"刚看完的那条"。
      bvid: z.string().optional().describe('一般不用传！桥接会自动用你刚看完的那条。只有明确要记录某条特定视频时才填'),
      title: z.string().optional().describe('一般不用传（桥接自动补）'),
      owner: z.string().optional().describe('一般不用传（桥接自动补）'),
      category: z.string().optional().describe('一般不用传（桥接自动补）'),
      durationSec: z.number().optional().describe('一般不用传（桥接自动补）'),
      liked: z.boolean().describe('你喜不喜欢：true=喜欢，false=不喜欢/无聊'),
      interest: z.number().optional().describe('兴趣分 0~100'),
      tags: z.array(z.string()).optional().describe('2~5 个短标签'),
      notes: z.string().optional().describe('一句话说明为什么'),
      source: z.enum(['self', 'shared']).optional().describe('self=自己刷到的，shared=群友发的')
    },
    async ({ key, token, bvid, title, owner, category, durationSec, liked, interest, tags, notes, source }) => {
      try {
        const data = await ctx.mcp.callService('record', { key, token, bvid, title, owner, category, durationSec, liked, interest, tags, notes, source });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, recorded: data.video, taste: data.taste }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: () => ctx.config.get()?.enabled !== false }
  );

  ctx.mcp?.registerTool(
    'qq_bili_memory',
    '查你自己的B站观看记忆（跨群共用）：看过哪些、喜欢什么类型、偏好统计。\n\n'
    + '【什么时候用】群友聊到某个视频/UP主/题材，你想确认"这个我看过吗/我是不是喜欢这类"；'
    + '或者有人问你平时爱看什么。查完再回答，不要凭印象编。\n'
    + 'likedOnly=true 只看喜欢的；q 可按标题/UP主/标签搜索。',
    {
      key: z.string().describe('会话 key（用于校验）'),
      token: z.string().describe('会话令牌'),
      limit: z.number().optional().describe('最多条数，默认 10，上限 50'),
      likedOnly: z.boolean().optional().describe('只看你喜欢的'),
      q: z.string().optional().describe('按标题/UP主/标签搜索')
    },
    async ({ key, token, limit, likedOnly, q }) => {
      try {
        const data = await ctx.mcp.callService('memory', { key, token, limit, likedOnly, q });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: () => ctx.config.get()?.enabled !== false }
  );

  ctx.mcp?.registerTool(
    'qq_watch_bili',
    '看一个B站视频（群友发链接/卡片时可以主动看，也可以自己点开）。会截取开头一段的连续画面交给你看。\n\n'
    + '【群友发了B站链接或分享卡片时】不要只看标题就回答，先调本工具真的看一眼画面，再结合内容回应。\n'
    + '【支持】BV号、完整链接、b23.tv 短链。\n'
    + '看完记得用 qq_bili_record 记下你的感受（这样以后才记得）。\n'
    + '⚠️ 这类"应群友要求看的"不计入每日自己刷的额度。',
    {
      key: z.string().describe('会话 key'),
      token: z.string().describe('会话令牌'),
      url: z.string().describe('B站视频链接 / b23.tv 短链 / BV号'),
      seconds: z.number().optional().describe('看开头多少秒，默认 10'),
      frames: z.number().optional().describe('抽几帧，默认 12')
    },
    async ({ key, token, url, seconds, frames }) => {
      try {
        const data = await ctx.mcp.callService('watch', { key, token, url, seconds, frames });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `看不了这个视频：${data?.error || '未知原因'}` }], isError: true };
        }
        // 分页拼图：帧多时会切成多张图（每张最多 30 格），必须**全部**交给模型——
        // 只给第一张会让它把"前 1/4 段"当成整条视频来评价。
        const imgs = Array.isArray(data.images) && data.images.length
          ? data.images
          : [{ data: data.grid, mimeType: data.mimeType || 'image/png' }];
        return {
          content: [
            { type: 'text', text: `${data.hint}\n\n（看完可以用 qq_bili_record 记下感受，bvid=${data.info.bvid}）` },
            ...imgs.map((img) => ({
              type: 'image',
              mimeType: img.mimeType || 'image/png',
              data: img.data
            }))
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `观看失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: () => ctx.config.get()?.enabled !== false }
  );

  // ── 现场搜 B 站并推荐（2026-10-19 用户反馈「为什么没有新增的视频，都是之前说过了的」）──
  //
  // 根因：原来只有 `qq_bili_memory`（查**已有**记忆），群友问"推荐点视频"时
  // 模型只能翻记忆里的旧内容，还会临时编两条没链接的。
  // 补这个工具：**实时搜索**并把标题+链接给模型，让它推荐真正的新视频。
  ctx.mcp?.registerTool(
    'qq_bili_search',
    '现场搜索B站视频并拿到**标题和真实链接**（用于给群友推荐新视频）。\n\n'
    + '【什么时候用】群友说「推荐点视频」「有什么好看的」「来点摸鱼的」这类话时——'
    + '**必须调本工具搜新的**，不要只翻记忆里的旧视频（那些人家可能早看过了）。\n'
    + '也可以先调 qq_bili_memory 看看自己喜欢什么，再用本工具按那些标签搜。\n\n'
    + '【怎么用结果】返回的每条都有 `title` / `url` / `bvid` / `owner` / `durationSec`。'
    + '**推荐时必须原样带上 title 和 url**（url 是真实链接，不要自己拼、不要改写）。\n'
    + '建议一次性给 1~2 条就好，别刷屏；说清为什么推荐（结合群友的喜好）。',
    {
      key: z.string().describe('会话 key'),
      token: z.string().describe('会话令牌'),
      query: z.string().describe('搜索关键词（如「鸣潮」「绝区零」「鬼畜」；不知道搜什么就先查 qq_bili_memory 看自己的口味）'),
      count: z.number().optional().describe('返回几条，默认 8，最多 20'),
      order: z.enum(['totalrank', 'pubdate', 'click']).optional().describe('排序：totalrank=综合(默认) / pubdate=最新 / click=播放多')
    },
    async ({ key, token, query, count, order }) => {
      try {
        const data = await ctx.mcp.callService('search', { key, token, query, count, order });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `搜索失败：${data?.error || '未知原因'}` }], isError: true };
        }
        // 只回必要字段，避免模型被一堆数字干扰
        const slim = (data.videos || []).map((v) => ({
          title: v.title,
          url: `https://www.bilibili.com/video/${v.bvid}`,
          bvid: v.bvid,
          owner: v.owner,
          durationSec: v.durationSec,
          category: v.category
        }));
        return {
          content: [{
            type: 'text',
            text: `搜索「${data.query}」得到 ${slim.length} 条（${data.engineNote || 'B站搜索'}）：\n`
              + JSON.stringify(slim, null, 2)
              + `\n\n推荐时**标题和链接必须原样使用**，不要自己编。`
          }]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: () => ctx.config.get()?.enabled !== false }
  );
}

}
