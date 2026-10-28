import { z } from 'zod';

// 发图族工具的可用性：图库开启且发图工具未被关闭。每次查询/调用都重读配置。
// ctx.config.get() 是 socialV2.images 段；工具开关在 socialV2.tools，用只读窄口取。
const sendFamilyEnabled = ctx => () => {
  const c = ctx.config.get();
  return c?.enabled === true && ctx.config.toolFlag('sendImage') !== false;
};

export function registerImagesTools(ctx) {
  ctx.mcp?.registerTool(
    'qq_check_image',
    '发图前预检（毫秒级，不发送任何东西）：告诉你这个标签本地图库有没有现成的图、调用 qq_send_image 会不会需要现去图站拉取。\n\n【什么时候用】群友点名要某个角色/主题的图，而你不确定库里有没有时——先调它，再决定怎么回。\n\n【怎么用结果】\n- `willWait=false`（本地有图）：直接调 qq_send_image，约 0.1 秒发出。\n- `willWait=true`（要现拉）：**务必先用 qq_send_message 回一句**（例如「等我找找」「我翻翻库存」）再调 qq_send_image。现拉期间你完全无法回应新消息，不先说一声，群友看到的就是「这机器人不理人」。\n- 耗时：booru 系（safebooru/yandere）通常几秒到十几秒；**pixiv 往往更慢（可能 1~3 分钟**，因为它要逐张探测格式再经代理下载大图）。返回值 `etaMs` 有估算区间，`willWait=true` 时**一律先吱声**，别赌它很快。\n- `sendAllowed=false`：当前发不出（冷却中或超每小时上限），按 `sendBlockedReason` 告知群友等一会儿。\n\n注意：这是只读检查，不消耗发图配额、不改图库。多标签用逗号分隔（tags="varesa,genshin_impact"）。\n\n【群主指定了图站就带上 sources】说「从 pixiv 找」这类要求时，预检也要传 sources（逗号分隔，如 "pixiv"），否则统计的是所有源——可能与随后发图实际能用的不一致。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      tags: z.string().describe('要查的标签，多个用逗号分隔，例如 "varesa,genshin_impact"；不传则查"任意图"'),
      sources: z.string().optional().describe('可选：限定图源，逗号分隔。可用值 safebooru,pixiv,yandere。**群主说「从某站找」时必须传**，否则会返回别的站的图')
    },
    async ({ key, token, tags, sources }) => {
      try {
        const data = await ctx.mcp.callService('preflight', { key, token, tags, sources });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `预检失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: sendFamilyEnabled(ctx) }
  );

  ctx.mcp?.registerTool(
    'qq_archive_image',
    '把一张图的**原图**收藏到专门的目录里（群主说「保存」「存一下」「留着」时用）。\n\n【重要】存的是**原图画质**，不是刚发出去的那张压缩版——桥接会去来源站点（safebooru / pixiv / yande.re）查出原图直链再下载。所以同一张图收藏后，文件会比群里看到的那张更大更清晰（实测库里 96KB 的图，原图 262KB）。\n\n【不用传 id】默认存**本会话最近发出的那张**。也可以显式传 id。\n\n【怎么用】调用后回复群主一句话说明存到哪了即可，例如「存好啦，放 collected 里了」。路径在返回值的 path 里。\n\n【幂等】同一张图重复保存不会产生副本（文件名按图库 id 生成，已存在就直接返回原路径、不重复下载）。\n\n【注意】只有**群主/管理员明确要求保存**时才调用，不要自己去存群友发的随便一张图——这是要占磁盘的。若该图源不支持取原图（或站点已删），会返回失败原因，如实告诉群主即可。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().optional().describe('可选：图库 id（如 safebooru:123）。不传则存本会话最近发出的那张')
    },
    async ({ key, token, id }) => {
      try {
        const data = await ctx.mcp.callService('archive', { key, token, id });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: sendFamilyEnabled(ctx) }
  );

  ctx.mcp?.registerTool(
    'qq_image_source',
    '查一张图的来源：图源站点页面、画师、原始发布处。群友问「这图哪来的」「画师是谁」「哪找的」时调用。\n\n【不用传 id】默认查**本会话最近发出的那张**。也可以显式传 id（如果你确实知道图库 id）。\n\n【两个链接的区别，回答时说清楚】\n- `sourcePage`：**图源站点**上这张图的条目页（如 safebooru 的 posts/N、yande.re 的 post/show/N、pixiv 的 artworks/N）。群友想去那个图站看/存图，给这个。\n- `originUrl`：**画师的原始发布处**（通常是 x.com/twitter 原帖）。想找画师本人、看原帖给这个。\n两者经常不同：booru 站的图多是转载自 twitter，所以 `originUrl` 指向推特、`sourcePage` 才指向 booru 站。\n\n注意：发图时的来源标注（画师+链接）已经自动带上了，群友没问就不必特意再报一遍来源。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().optional().describe('可选：图库 id（如 safebooru:123）。不传则查本会话最近发出的那张')
    },
    async ({ key, token, id }) => {
      try {
        const data = await ctx.mcp.callService('source', { key, token, id });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `查来源失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: sendFamilyEnabled(ctx) }
  );

  // 反向搜图（以图搜图）：拿一张**任意图片**去全网图源反查出处。
  // 与 qq_image_source 的区别：那个只读「图库已有条目」的元数据（图库里的图才有来源标注），
  // 这个能对**群友刚发的外来图**做全站反查——「这图哪来的、谁画的、求出处」正是它。
  ctx.mcp?.registerTool(
    'qq_reverse_search',
    '以图搜图（反查出处）：拿一张图去 SauceNAO 反查它来自哪个图源站、画师是谁。\n\n'
    + '【什么时候用】群友发了一张图问「这图哪来的」「谁画的」「求出处」「这画师还有别的作品吗」时调用。'
    + '注意区分：如果问的是**你刚发出去的图**（图库图），用 qq_image_source 更快更准（不用外部搜索）；'
    + '如果是**群友自己发的图**、或任何不在图库里的图，用这个。\n\n'
    + '【怎么指定图】默认取**消息里最近一张图**。推荐显式传 messageId（那条带图消息的 id，'
    + '用 qq_get_unread_messages / qq_get_message_detail 拿）——群聊里可能同时有多张图，不传会挑错。\n'
    + '也可以传 id（图库 id）来反查图库里的某张。\n\n'
    + '【怎么解读结果】results 按相似度降序：\n'
    + '- similarity 是匹配度（百分比）。**>80% 基本可信**；50~80% 可能是同人不同图或改图；'
    + '低于 50% 不要当结论（结果里带 site/creator/title/urls）。\n'
    + '- creator 是画师名，urls[0] 是那个站点的作品页（优先报给群友）。\n'
    + '- **相似度低或没结果时如实说**「没搜到出处，可能是原创/改图/冷门作品」，别硬凑一个不像的当答案。\n\n'
    + '【配额】SauceNAO 免费额度约 30 秒 4 次、每天 100 次，超了会明确报错（等一会儿就好，别连续重试）。'
    + '若返回 needKey 或「未配置 API key」，说明管理员还没配密钥——如实告诉群友「查图功能还没开」，别说成「搜不到」。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().optional().describe('可选：带图消息的 id（推荐传，避免群聊多图时挑错）'),
      id: z.string().optional().describe('可选：图库 id（反查图库里的某张）。与 messageId 二选一')
    },
    async ({ key, token, messageId, id }) => {
      try {
        const data = await ctx.mcp.callService('reverseSearch', { key, token, messageId, id });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `反查失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: () => ctx.config.toolFlag('reverseSearch') !== false }
  );

  ctx.mcp?.registerTool(
    'qq_reject_image',
    '把一张不合适的图从图库删掉，并让它以后不再被发出（加入拒绝名单）。\n\n【什么时候用】群友对刚发的图表示不满（「不好看」「不是我要的」「换一张」），或你发送后自己发现发错了（比如角色不对、明显跑题）。\n\n【重要】桥接**已经会自动处理**最常见的差评：群友说「不好看/换一张」时，桥接会立刻删掉刚发的那张并另发一张，**不需要你再调这个工具**。所以这个工具留给两种情况：\n- 你想主动纠正（自己发现发错了）；\n- 群友的差评表述桥接没抓到（例如用很间接的说法），你判断该换图。\n\n【怎么调】不用传 id——默认删掉「本会话最近发出的那张」。也可以显式传 id（如果你确实知道图库 id）。调完这张图就被禁了，再调 qq_send_image 会挑到别的图。\n\n【注意】别滥用：这只是「删掉一张不合适的」，不是「收集群友偏好」。连续因为不同意见删图会让图库越来越小。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().optional().describe('可选：要删除的图库 id。不传则删本会话最近发出的那张'),
      reason: z.string().optional().describe('可选：删除原因（记入日志，便于排查）')
    },
    async ({ key, token, id, reason }) => {
      try {
        const data = await ctx.mcp.callService('reject', { key, token, id, reason });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `删除失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: sendFamilyEnabled(ctx) }
  );

  ctx.mcp?.registerTool(
    'qq_send_image',
    '从图库挑一张图发到当前会话（reserved2 专用）。图库由公开图站（默认 Safebooru，全年龄）预先抓取落盘，你负责挑时机发。\n\n【先预检再发，别让对方干等】群友点名要某个角色/主题的图时，**先调 qq_check_image** 看本地库里有没有：\n- 本地有（willWait=false）→ 直接发，约 0.1 秒。\n- 要现拉（willWait=true）→ **务必先用 qq_send_message 回一句**（「等我找找」「我翻翻库存」）再发。现拉期间你无法回应新消息，不吱声对方就会觉得你消失了。booru 系通常几秒到十几秒，**pixiv 可能 1~3 分钟**（逐张探测格式 + 经代理下大图），所以更要先说。\n\n【怎么查特定内容】传 tags 即可，用英文标签（booru 系惯例，多个标签是「同时满足」）：例如 ["cat"]、["scenery"]、["raiden_shogun","genshin_impact"]。库里没有匹配的图时，桥接会**自动去图源现拉**（可能等几秒到十几秒），拉到了就发。\n\n【群主指定了图站就只用那个图站】群主说「从 pixiv 找」「用 safebooru 的图」「只要 yande.re 的」这类话时，**必须传 sources 参数**（例如 `["pixiv"]`）。不传的话桥接会搜所有已启用的源，可能返回别的站的图——那就不是群主要的了。可用值只有 `safebooru` / `pixiv` / `yandere`。传了之后本地挑选与现拉都会限制在该站点内。\n\n【查角色：务必带上作品标签】booru 的角色标签都带作品限定，而且**唯一可靠的做法是给两个标签**：角色名 + 作品名。中文名不要自己音译猜拼写——译错会查到完全不同的角色。例如：\n- 要原神的雷电影 → ["raiden_shogun","genshin_impact"]\n- 要原神的沃雅妮莎 → 她的英文名是 Varesa，标签 ["varesa_(genshin_impact)"] 或 ["varesa","genshin_impact"]\n- 要崩铁的流萤 → ["firefly_(honkai:_star_rail)"] 或 ["firefly","honkai:_star_rail"]\n**如果你不确定英文拼写，就同时传作品标签**（如 genshin_impact / honkai:_star_rail），这样即使角色名猜偏，也只会在该作品内部找，不会发成别的作品的角色。另外：不确定拼写时，宁可先用不那么多见的组合去试，也不要凭印象硬拼英文名。\n\n【群像图会被自动降权，不用你操心】库里有些图是多人合照（`multiple_girls`/`2girls`/`1boy 1girl` 那种）。这类图**带很多角色标签，查任何角色都能命中**，所以过去常出现「要什么角色都发同一张大合照」。桥接现在会自动：① 有单角色图时**只发单角色图**；② 只有合照时才退回合照；③ 同一个角色优先发**没发过的**图，不老是同一张。你**不需要**自己在 tags 里加 `-multiple_girls` 之类的负向标签（会白占 booru 的标签配额，反而查不到）。\n\n【查不到时】桥接会自动纠错（如 aemeath → aemeath_(wuthering_waves)）并返回 tagCorrections/notice 字段告诉你实际用了哪个标签。**若 notice 说标签被换成了别的作品，就说明你要的角色没找到，不要当作已找到**——应告诉群友没找到、或换个更常见的角色，别把不对的图当对的那张发出去。\n\n【按画师找图】tags 里用 `artist:画师名`（也接受 `user:名字`），例如 ["artist:moonian"]。桥接会按各图源的语法自动翻译（safebooru 用裸名、yande.re 用 user: 前缀），不用你操心差异。\n**pixiv 要按画师取图，最可靠的是给「用户 ID」或「主页链接」**（下面任一种都会被识别，不用你转换）：\n- `["artist:83739"]` —— 数字 ID\n- `["https://www.pixiv.net/users/83739"]` —— 画师主页链接（群友最常贴这种，**原样传进来即可**，不用你改成 artist: 格式）\n- `["https://www.pixiv.net/artworks/136201011"]` —— 作品链接也可以（桥接会自动查出作者）\n数字 ID 在画师主页链接 `pixiv.net/users/<数字>` 里。注意：**不要把作品 ID 当画师 ID**，两者不同（贴作品链接时桥接会自己转换）。\n**pixiv 按画师名（中文/日文/英文）搜图天然不可靠**：pixiv 的作品搜索是按**标签**匹配的，而画师名常常不是自己作品的标签，因此即使画师确实存在、也常有大量作品，用名字搜仍可能返回 0 条。实测：对日榜上确认存在的画师，`村カルキ`/`大津`/`霧月` 按名搜索都命中 0 条。**所以「搜不到」不等于「画师不存在」，不要据此下结论，更不要对群友说没有这个画师。**\n**画师名要照抄本人原名**，不要自己把中文名音译成英文（音译出来的拼写基本不会存在）。\n**查不到时**：别连续换拼写硬试（每次都要现拉，很慢）。可以让群友给画师主页链接（最省事），或改用 safebooru/yande.re——这两个源按画师名搜是可靠的。\n\n【怎么发日榜/热门】不传 tags 时按「走红程度」而不是最新上传来挑；想要「近日热门」语义，传 mode="daily"（等价于近两天内按热度排序，最接近日榜）。mode 可选值：hot（热门，默认）、daily（近日热门）、new（最新）、random（随机）。\n\n【返回值里的 tookMs / fetchedNow】能看出这次是否走了现拉：若 tookMs 较大且 fetchedNow>0，说明是刚拉来的。同一个词第二次要会很快（已在本地库）。\n\n【注意】\n- 发图会带来源标注（画师与出处链接），这是使用第三方作品的基本要求，不要试图去掉。\n- 一张图就是一条独立消息，不能和文字塞进同一个气泡；想配一句话请先用 qq_send_message 发文字，再单独发图。\n- 同会话发图有冷却与每小时上限；查询没找到时也会消耗一次拉取，别连续试很多冷门词，换个常见标签或直接问群友要什么。\n- 单图只发一张。想连发多张，分多次调用（注意频率限制）。\n- 图库没有、上游也没有的冷门角色，老实说「没找到」比拿一张相近的图充数更好。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      tags: z.array(z.string()).optional().describe('可选：英文标签筛选，例如 ["cat"]、["scenery"]；多个标签需同时满足。不传则不限主题'),
      sources: z.array(z.string()).optional().describe('可选：限定图源（可多选）。**群主说「从 pixiv 找」「只在 safebooru 上找」时必须传**，否则会返回别的站的图。可用值：safebooru / pixiv / yandere'),
      mode: z.enum(['hot', 'daily', 'new', 'random']).optional().describe('可选：挑图模式。hot=热门(默认) daily=近日热门(≈日榜) new=最新 random=随机'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('可选：引用某条消息后再发图（传 messageId 最稳，传 seq 亦可）')
    },
    async ({ key, token, tags, sources, mode, replyToMessageId }) => {
      try {
        const data = await ctx.mcp.callService('send', { key, token, tags, sources, mode, replyToMessageId });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发图失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: sendFamilyEnabled(ctx) }
  );

  ctx.mcp?.registerTool(
    'qq_refresh_image_lib',
    '从已启用的图源补一批图进本地图库（reserved2 专用）。适合图库空了、或想换一批新图时调用。注意：图源受速率限制，桥接有冷却时间（默认两次拉取间隔 30 分钟），冷却中调用会返回 cooled=true 与剩余等待毫秒——这是正常情况，不要反复调用；等一会儿或直接先用图库里现有的图。返回 added 表示本次新入库数量，total 是图库总量。单次拉取可能部分失败（errors 字段），不影响已入库的图。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const data = await ctx.mcp.callService('refresh', { key, token });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `刷新图库失败：${error?.message ?? error}` }], isError: true };
      }
    },
    {
      isEnabled: () => {
        return ctx.config.get()?.enabled === true && ctx.config.toolFlag('refreshImageLib') !== false;
      }
    }
  );
}
