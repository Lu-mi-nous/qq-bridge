import { z } from 'zod';

export function registerMediaTools(ctx) {
 {
  ctx.mcp?.registerTool(
    'qq_send_feature_menu',
    '把「你能做什么」的功能菜单**直接发到当前会话**（一张排版好的 PNG，群友会看到它）。'
    + '当群友问「你会啥」「能干啥」「有什么功能」「功能声明」「功能菜单」「功能介绍」「介绍一下自己」「你能做什么」这类问题时调用它。菜单按当前角色与已启用功能生成，已有本地缓存会直接复用。\n'
    + '调用后**不要**再复述菜单内容（图已经在群友眼前了），说一句「菜单发上来啦」这类短话就够；'
    + '也不要额外承诺菜单里没有的能力。\n'
    + '如果返回失败（例如机器上没找到 Chrome），如实说「菜单图暂时生成不了」，**不要改口编一份文字版功能清单**。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      refresh: z.boolean().optional().describe('通常省略，直接使用本地缓存；内容、样式、角色或功能开关变化会自动换图。仅修复异常图片时才传 true 强制重渲染。')
    },
    async ({ key, token, refresh }) => {
      try {
        const data = await ctx.mcp.callService('featureMenu', { key, token, refresh });
        if (data?.ok === false) {
          return { content: [{ type: 'text', text: `功能菜单发送失败：${data.error || '未知原因'}。请如实告诉群友「菜单图暂时生成不了」，不要改口编一份文字版功能清单。` }], isError: true };
        }
        return {
          content: [{
            type: 'text',
            text: `功能菜单已发到当前会话（${Math.round((data.bytes || 0) / 1024)}KB${data.cached ? '，用缓存' : '，刚渲染'}）。说一句很短的话即可，不要复述菜单里的内容。`
          }]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送功能菜单失败：${error?.message ?? error}。请如实告诉群友生成不了，不要编一份文字版。` }], isError: true };
      }
    },
    { isEnabled: () => ctx.config.get()?.tools?.getFeatureMenu !== false }
  );
}

// ── Token 用量报表图（2026-10-21 用户要求）────────────────────────────────
//
// 「让 bot 能够看到 token 消耗日志，能够以图片形式响应群友要求 token 消耗量相关问题」。
//
// 关键设计：**图由桥接直接发**（与功能菜单、GitHub 截图同一条路），
// 返回值里同时给一段与图上数字同源的文字摘要。
// 为什么两边都要有：图让群友自己看趋势，文字让模型在群友追问
// （"那昨天呢""用的什么模型"）时能答得出来，而**不必再猜一遍数字**。
 {
  ctx.mcp?.registerTool(
    'qq_token_report',
    '生成一张 **Token 用量统计图**并直接发到当前会话（群友会看到这张图）。\n\n'
    + '【什么时候调】**只要群友在问"机器人自己消耗了多少 token"，就调它**，别只认固定说法。'
    + '实测这些说法都会被问到，全都要用它：\n'
    + '  - 「用了/耗了/花了/吃了多少 token」「token 用多少了」\n'
    + '  - 「今天消耗多少」「这个月烧了多少」「花了多少算力」\n'
    + '  - 「吃了多少白饭」「你怎么这么能吃」「看看你的用量/统计/账单」「今天跑了多少」\n'
    + '判据是**语义**：在问用量/消耗/花了多少，就用这个工具。\n'
    + '这是在问**机器人自己**的用量统计，不是让群友查自己的账号。\n\n'
    + '【绝不要做的事】\n'
    + '- **不要自己估算、翻日志或凭印象报数字**。你算不准，编的数会和图上真实数字当场对不上。\n'
    + '- **不要说「我没有查用量的口子」「这个统计不归我管」**——你有这个工具，这么说是在撒谎。\n\n'
    + '【返回了什么】一张排版好的图（今日/近 7 天/累计 + 每日柱状图 + 按模型占比），'
    + '外加一段与图**完全相同口径**的文字摘要。\n'
    + '**图已经发出去了**，所以你只需要说一句很短的话（「喏，这阵子的用量」「图来了」），'
    + '不要复述图里的每个数字。\n'
    + '但如果群友接着追问具体数字，就用返回里的摘要如实回答——'
    + '**不要凭印象编一个数**，也不要自己算（你算不准）。\n\n'
    + '【数据是新的吗】桥接每 6 小时或跨天统计一次，所以默认有几分钟到几小时的延迟，'
    + '图上会标「更新于 X 前」。群友明显在问**此刻/今天到现在**的数字时，'
    + '可以传 fresh=true 让它先重算一次再出图（多等约 7 秒）。\n'
    + '如果返回的 `stale` 为 true，回答时提一句「数据截至 X 前」，别把它说成实时值。\n\n'
    + '【失败时】如实说「用量统计图暂时生成不了」并说明原因，**不要**编一段数字冒充统计。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      fresh: z.boolean().optional().describe('是否先重新统计再出图（群友问"今天到现在"这类实时数字时传 true，会多等约 7 秒）')
    },
    async ({ key, token, fresh }) => {
      try {
        const data = await ctx.mcp.callService('tokenReport', { key, token, fresh });
        if (data?.ok === false) {
          return { content: [{ type: 'text', text: `Token 报表发送失败：${data.error || '未知原因'}。请如实说统计图生成不了，不要编数字。` }], isError: true };
        }
        return {
          content: [{
            type: 'text',
            text: `Token 用量图已发到当前会话（${Math.round((data.bytes || 0) / 1024)}KB${data.cached ? '，用缓存' : '，刚渲染'}）。`
              + '图已经发出去了，只需一句很短的话，不要复述图里的数字。\n'
              + '如果群友追问具体数字，用下面这段回答（与图同源，不要自己改算）：\n'
              + '---\n'
              + String(data.summary || '（没有拿到摘要）')
          }]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送 Token 报表失败：${error?.message ?? error}。请如实说统计图生成不了，不要编数字。` }], isError: true };
      }
    },
    { isEnabled: () => ctx.config.get()?.tools?.tokenReport !== false }
  );
}

// ── GitHub 仓库首页截图（2026-10-20 用户要求）──────────────────────────────
 {
  ctx.mcp?.registerTool(
    'qq_github_shot',
    '把一个 GitHub 仓库的**首页整页截图**发到当前会话（群友会直接看到图片）。\n\n'
    + '【什么时候调】群友发了 github.com 链接、或说「看看这个仓库」「这项目长啥样」「截个图看看」时，'
    + '**直接调它**，不要说「我打不开链接」或只复述仓库名。\n\n'
    + '【会发几张】GitHub 首页很长（实测约 1.5 万像素），一张发到 QQ 会被压成看不清的细线，'
    + '所以桥接会按顺序切成若干张发出来（通常 4~6 张），并先发一句「第 N 张」的说明。'
    + '**不要**自己再补发一遍，也不要逐张描述——群友自己能看。\n\n'
    + '【支持的链接】`https://github.com/owner/repo`、`owner/repo` 简写都行；'
    + '`/issues`、`/tree/main/xxx` 这类子页面会被**归到仓库首页**（功能就是截首页）。'
    + '也支持用户主页 `https://github.com/owner`。\n\n'
    + '【返回后怎么说】一句话就够（「喏，这仓库长这样」）。'
    + '如果 `note` 说只发出了一部分（后面几张失败），要如实说「后面几张没发出去」。\n\n'
    + '【失败时】返回里会说清原因（常见是没配代理导致 GitHub 连不上）。'
    + '**不要**编造仓库内容，也不要改用 GitHub API 的元数据假装截了图。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      url: z.string().describe('GitHub 链接或 owner/repo 简写；也可以直接贴含链接的原消息文本')
    },
    async ({ key, token, url }) => {
      try {
        const data = await ctx.mcp.callService('githubShot', { key, token, url });
        if (!data?.ok) {
          return {
            content: [{
              type: 'text',
              text: `GitHub 截图失败：${data?.error || '未知原因'}。请如实告诉群友截图没成功，不要编造仓库内容。`
            }],
            isError: true
          };
        }
        const parts = [`已把 ${data.repo} 的首页截图发到当前会话（${data.sent}/${data.slices} 张，整页 ${data.height}px）。`];
        if (data.truncated) parts.push(`（页面太长，只截了前 ${data.height}px）`);
        if (data.note) parts.push(data.note);
        parts.push('说一句简短的话就好，不要逐张描述图里的内容。');
        return { content: [{ type: 'text', text: parts.join('') }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `GitHub 截图失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: () => ctx.config.get()?.tools?.githubShot !== false }
  );
}

}
