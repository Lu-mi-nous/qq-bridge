import { z } from 'zod';

// 每个表情工具受「表情功能开启 + 自己的工具开关」双重约束；每次查询/调用都重读配置。
// ctx.config.get() 是 socialV2.sticker 段；工具开关在 socialV2.tools，用只读窄口取。
const stickerEnabled = (ctx, flag) => () => {
  return ctx.config.get()?.enabled !== false && ctx.config.toolFlag(flag) !== false;
};

export function registerStickersTools(ctx) {
  ctx.mcp?.registerTool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        const data = await ctx.mcp.callService('list', { key, token, query, count, refresh });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: stickerEnabled(ctx, 'listStickers') }
  );

  ctx.mcp?.registerTool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const data = await ctx.mcp.callService('image', { key, token, stickerId });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${data?.error || '未知'}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: stickerEnabled(ctx, 'getStickerImage') }
  );

  ctx.mcp?.registerTool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id。**优先传 messageId**（qq_get_unread_messages / qq_get_recent_messages 返回的真实 QQ 消息 id）；传 seq 也可以，桥接会自动换算。**不确定是哪条就传 latest**（等价于「最近一条别人的消息」），不要自己猜编号——猜错的编号照样能解析到另一条真实消息，会静默引用错。'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await ctx.mcp.callService('send', { key, token, stickerId, replyToMessageId, atUserId });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: stickerEnabled(ctx, 'sendSticker') }
  );

  ctx.mcp?.registerTool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await ctx.mcp.callService('collect', { key, token, messageId, remark });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: stickerEnabled(ctx, 'collectSticker') }
  );

  ctx.mcp?.registerTool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const data = await ctx.mcp.callService('note', { key, token, stickerId, note, tags, usage });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: stickerEnabled(ctx, 'stickerNote') }
  );

  ctx.mcp?.registerTool(
    'qq_delete_sticker',
    '从 QQ 收藏表情里**删除**一个表情。写操作，删掉后不在收藏里了（其他设备也同步消失）。\n'
    + '仅当群友明确要求删某个表情、且你已用 qq_list_stickers 确认它就是目标时调用。\n'
    + '**仅管理员可用**：非管理员的要求会被桥接拒绝（403），不要反复重试，也不要假装删了。\n'
    + '**删除前必须先用 qq_list_stickers 找到它**，把返回的 id 或 md5 原样传进来——\n'
    + '不要凭记忆或猜测编造 id，也不要传备注文字：传了列表里没有的值会被桥接拒绝（这是保护，不是 bug）。\n'
    + '删错了会让群友丢一个收藏，所以**不确定时先问一句**再删。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('要删除的表情标识：qq_list_stickers 返回的 id 或 md5（必须是列表里真实存在的值）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const data = await ctx.mcp.callService('remove', { key, token, stickerId });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `删除表情失败：${data?.error || '未知原因'}` }], isError: true };
        }
        const d = data.deleted || {};
        const tail = data.verifiedGone === false ? '（注意：回读时它似乎还在，可能没删掉）' : '';
        return {
          content: [{
            type: 'text',
            text: `已删除收藏表情${d.desc ? `「${d.desc}」` : ''}（${String(d.md5 || '').slice(0, 8)}）${tail}`
          }]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `删除表情失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: stickerEnabled(ctx, 'deleteSticker') }
  );

  ctx.mcp?.registerTool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。写操作，会直接影响 QQ 账号的表情备注。\n'
    + '**仅管理员可用**：非管理员的要求会被桥接拒绝（403），不要反复重试。\n'
    + '群友想标注含义请用 qq_sticker_note（那是本地记忆，不改官方备注）；本工具只在管理员明确要求改备注时用。\n'
    + '**先用 qq_list_stickers 找到目标**，把返回的 id / md5 原样传进来（传列表外的值会被拒绝）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await ctx.mcp.callService('remark', { key, token, stickerId, remark });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    },
    { isEnabled: stickerEnabled(ctx, 'setStickerRemark') }
  );
}
