import { z } from 'zod';

// P0 安全止血：socialV2.tools.fetchXPosts=false 时**不注册**该工具，模型完全看不到。
// 内容审核上线前不要打开；工具开关每次查询/调用都重读配置。
// ctx.config.get() 是 xMonitor 段；工具开关在 socialV2.tools，用只读窄口取。
const xPostsEnabled = ctx => () => ctx.config.toolFlag('fetchXPosts') !== false;

export function registerXPostsTools(ctx) {
  ctx.mcp?.registerTool(
    'qq_fetch_x_posts',
    '拉取某个 X（Twitter）账号的帖子，渲染成卡片图发到当前会话；帖子里的**视频也会一并发出**（reserved2 专用）。\n\n'
    + '【什么时候用】群友说「看看 XX 的推」「XX 最近发什么了」「@某人 在 X 上说了啥」「拉一下 XX 昨天的推」这类请求时调用。\n\n'
    + '【怎么指定人】handle 传 X 账号名（**不带 @**，只能是字母/数字/下划线）。若群友只说昵称、你也不确定账号名，'
    + '先用 web_search 搜「<昵称> twitter/x 账号」确认再调；不要凭印象猜拼写——猜错会拉到别人的帖子。\n\n'
    + '【怎么指定时间】三种用法：\n'
    + '- 不传时间参数 → 拉**最新**的帖子（会自动跳过置顶帖，置顶可能是几个月前的）\n'
    + '- 传 `date: "2026-10-04"` → 拉**那一天**发的帖子\n'
    + '- 传 `lastHours: 24` → 拉**最近 N 小时**内的帖子\n'
    + 'count 控制条数（默认 1，最多 5）。多条会分开发（一条一张图）。\n'
    + '⚠️ 时间能翻多远：**通常能翻到几个月前**（按需翻页），所以「上个月 20 号那条」这种也能查。'
    + '若真查不到，返回的 error 会说明原因——可能是**那天确实没发帖**，也可能是翻页上限到了。'
    + '照实告诉群友（"那天他没发帖" / "翻不到那么远了"），**不要**反复换日期重试碰运气。\n\n'
    + '【视频】帖子带视频时，卡片之后会**再单独发一条视频**（QQ 限制：视频必须独占一条消息，不能和文字同条）。'
    + '超过 100MB 的视频会自动跳过（选更低清晰度；若所有清晰度都超限则整条不发，返回值 videoSkipped 里说明原因）——'
    + '这种情况照实告诉群友「视频太大了发不了」，别假装没看到视频。\n\n'
    + '【耗时提醒】整个流程要抓取+翻译+渲染+（下载视频），**约 15~40 秒**（带视频或条数多时更久）。调用前**务必先用 qq_send_message 回一句**'
    + '（比如「我看看」「等我翻下他的推」），否则群友只看到你沉默很久，以为你又不理人。\n\n'
    + '【返回值】ok=true 表示已发出；posts 里是每条的摘要与链接，hasVideo/videoSize 标记视频。'
    + '若 ok=false，error 会说清原因（账号不存在 / 那天没发帖 / 网络失败），照实告诉群友，别说成"他就是没发过"。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      handle: z.string().describe('X 账号名（不带 @），例如 thsottiaux、sama'),
      count: z.number().optional().describe('可选：要几条，默认 1，最多 5'),
      date: z.string().optional().describe('可选：指定某一天（格式 YYYY-MM-DD），拉那天发的帖子'),
      lastHours: z.number().optional().describe('可选：拉最近 N 小时内的帖子（与 date 二选一）')
    },
    async ({ key, token, handle, count, date, lastHours }) => {
      try {
        const data = await ctx.mcp.callService('fetch', { key, token, handle, count, date, lastHours });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拉取失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: xPostsEnabled(ctx) }
  );
}
