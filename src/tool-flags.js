// 工具开关的**单一事实源**。
//
// 需求（2026-10-20 用户）：「工具开关卡片过于复杂，似乎还有遗漏项目，查漏补缺后重新设计视觉元素」。
//
// 查漏结果（实测）：
//   - MCP 注册 55 个工具，但只有 37 个开关真正被 `v2ToolEnabled()` 检查；
//   - 其中 10 个生效的开关在控制台**没有对应复选框**（archiveImage / imageSource /
//     reactMessage / rejectImage / refreshImageLib / reverseSearch / sendImage /
//     getFeatureMenu / groupFiles / deleteSticker）；
//   - 反过来控制台有 4 个开关**代码里从没检查过**（sendGroup / sendPrivate / reply / checkImage）
//     —— 拨了没反应，比缺开关更误导。
//
// 所以这里把「有哪些开关、对应哪些工具、属于哪一组、默认开不开」集中定义在一处，
// 控制台从 `GET /api/socialV2/tool-flags` 读它来渲染。以后加工具只改这里，
// 不会再出现"加了工具忘了加开关"或"开关是空壳"。
//
// 字段：
//   - flag       config.json 里 socialV2.tools.<flag> 的键名，也是 v2ToolEnabled() 的参数
//   - tools      该开关控制的 MCP 工具名（一个开关可管多个工具）
//   - group      控制台的分组
//   - desc       一句话说明（控制台显示）
//   - default    默认值（缺省视为 true，与 v2ToolEnabled 的 `!== false` 一致）
//   - risky      true = 关闭后影响较大 / 或本身高危，UI 上用不同样式提示
export const TOOL_FLAGS = [
  // ── 上下文与状态（只读）──
  { flag: 'getPrompt', tools: ['qq_get_prompt'], group: '上下文与状态', desc: '查看角色卡、推荐值、可用工具、当前唤醒配置', risky: true },
  { flag: 'getUnread', tools: ['qq_get_unread_messages'], group: '上下文与状态', desc: '查看未读消息，不自动标记已读', risky: true },
  { flag: 'getRecent', tools: ['qq_get_recent_messages'], group: '上下文与状态', desc: '查看最近消息，支持 offset 扩大范围', risky: true },
  { flag: 'socialState', tools: ['qq_social_state'], group: '上下文与状态', desc: '查看当前 WakeConfig、未读数、上次唤醒原因' },
  { flag: 'getMessageDetail', tools: ['qq_get_message_detail'], group: '上下文与状态', desc: '按 message_id 查看单条消息完整内容' },
  { flag: 'getActiveMembers', tools: ['qq_get_active_members'], group: '上下文与状态', desc: '查看最近活跃成员列表' },
  { flag: 'getMyRecent', tools: ['qq_get_my_recent_messages'], group: '上下文与状态', desc: '查看自己最近发过的消息，避免重复' },

  // ── 发送 ──
  { flag: 'sendMessage', tools: ['qq_send_message'], group: '发送', desc: '统一发送：一条/多条/引用/自定义或按字数计算间隔', risky: true },
  { flag: 'sendBurst', tools: ['qq_send_burst'], group: '发送', desc: '按数组分多条发送，桥接自动加真人化间隔' },
  { flag: 'sendPoke', tools: ['qq_send_poke'], group: '发送', desc: '发送 QQ 拍一拍（群聊传 targetUserId，私聊可省）' },
  { flag: 'reactMessage', tools: ['qq_react_message'], group: '发送', desc: '给消息贴一个表情回应（贴什么由模型判断）' },
  // 下面三个走旧版 /api/send/* 端点。它们**只在带会话令牌时**受开关控制
  // （见 bridge.js 里 `if (token && !v2ToolEnabled(flag))`）：
  // 不带 token 的旧调用路径无法关闭，这是既有行为，不在这里改动。
  { flag: 'sendGroup', tools: ['qq_send_group_message'], group: '发送', desc: '向指定群发一条纯文本（旧版端点，带 token 时受此开关控制）', risky: true },
  { flag: 'sendPrivate', tools: ['qq_send_private_message'], group: '发送', desc: '向指定好友发一条纯文本（旧版端点，带 token 时受此开关控制）', risky: true },
  { flag: 'reply', tools: ['qq_reply'], group: '发送', desc: '引用某条消息并回复（旧版端点，带 token 时受此开关控制）' },

  // ── 调度与记忆 ──
  { flag: 'setWakeConfig', tools: ['qq_set_wake_config'], group: '调度与记忆', desc: '设置唤醒/潜水条件：无限期、有限时间、@/名字/关键词/概率等' },
  { flag: 'markRead', tools: ['qq_mark_read'], group: '调度与记忆', desc: '标记当前未读为已读（看过但决定不回复）' },
  { flag: 'memory', tools: ['qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear'], group: '调度与记忆', desc: '轻量记忆：话题/想说的话/群友印象（含清空）' },
  { flag: 'waitMessages', tools: ['qq_wait_for_messages'], group: '调度与记忆', desc: '短暂等待新消息，有新消息立即返回或超时返回' },
  { flag: 'feedback', tools: ['qq_report_feedback'], group: '调度与记忆', desc: '向控制台反馈 AI 遇到的问题/困惑' },

  // ── 看图与图库 ──
  { flag: 'getImages', tools: ['qq_get_message_images'], group: '看图与图库', desc: '查看消息中的图片/表情内容' },
  { flag: 'sendImage', tools: ['qq_send_image'], group: '看图与图库', desc: '从图库挑图并发送（带来源标注）' },
  { flag: 'checkImage', tools: ['qq_check_image'], group: '看图与图库', desc: '发图前预检：本地有没有、要不要现拉' },
  { flag: 'refreshImageLib', tools: ['qq_refresh_image_lib'], group: '看图与图库', desc: '从图源补一批图进本地库' },
  { flag: 'rejectImage', tools: ['qq_reject_image'], group: '看图与图库', desc: '把不合适的图删掉并加入拒绝名单' },
  { flag: 'archiveImage', tools: ['qq_archive_image'], group: '看图与图库', desc: '回源保存一张图的原图到归档目录' },
  { flag: 'imageSource', tools: ['qq_image_source'], group: '看图与图库', desc: '查图库里某张图的来源（画师/图源站页面）' },
  { flag: 'reverseSearch', tools: ['qq_reverse_search'], group: '看图与图库', desc: '以图搜图反查出处（SauceNAO）' },
  { flag: 'upscaleImage', tools: ['qq_upscale_image'], group: '看图与图库', desc: '超分放大图片（需本机装 Upscayl；没装时工具不注册）' },
  { flag: 'getSelfImage', tools: ['qq_get_self_image'], group: '看图与图库', desc: '查看自己的形象图，并默认发到当前会话' },

  // ── 表情包 ──
  { flag: 'listStickers', tools: ['qq_list_stickers'], group: '表情包', desc: '查看/搜索 QQ 收藏表情（含备注和本地笔记）' },
  { flag: 'getStickerImage', tools: ['qq_get_sticker_image'], group: '表情包', desc: '看图理解没有备注的收藏表情' },
  { flag: 'sendSticker', tools: ['qq_send_sticker'], group: '表情包', desc: '发送收藏表情（一条消息只能一张，不能带文字）' },
  // 语音（GPT-SoVITS，可插拔）：TTS 不可用时 MCP 根本不注册这个工具。
  // 开关保持 true 也没关系——控制台会显示"已启用但工具未注册"，
  // 这正是可插拔的语义（不是坏了，是没装）。
  { flag: 'sendVoice', tools: ['qq_send_voice'], group: '发送', desc: '用语音发一句话（群友要听声音时用；需 GPT-SoVITS 插件）' },
  { flag: 'collectSticker', tools: ['qq_collect_sticker'], group: '表情包', desc: '偶尔收藏别人发的表情并写简短备注' },
  { flag: 'stickerNote', tools: ['qq_sticker_note'], group: '表情包', desc: '给表情记录本地含义/标签/用法' },
  { flag: 'setStickerRemark', tools: ['qq_set_sticker_remark'], group: '表情包', desc: '修改 QQ 官方表情备注（写操作，默认关闭）', default: false, risky: true },
  { flag: 'deleteSticker', tools: ['qq_delete_sticker'], group: '表情包', desc: '删除收藏表情（写操作且不可恢复，默认关闭）', default: false, risky: true },

  // ── 内容抓取 ──
  { flag: 'getForwardMsg', tools: ['qq_get_forward_msg'], group: '内容抓取', desc: '查看当前会话收到的合并转发消息内容' },
  { flag: 'groupFiles', tools: ['qq_list_group_files', 'qq_group_file_stats'], group: '内容抓取', desc: '群文件只读：列表、分类统计、搜索' },
  { flag: 'crawl', tools: ['qq_crawl_web'], group: '内容抓取', desc: '按需抓网页/图站（aigengtu 等），可把图片存入 QQ 收藏表情' },
  { flag: 'fetchXPosts', tools: ['qq_fetch_x_posts'], group: '内容抓取', desc: '按需拉取 X（Twitter）帖子' },
  { flag: 'githubShot', tools: ['qq_github_shot'], group: '内容抓取', desc: 'GitHub 仓库首页整页截图并发送（分多张）' },
  // 注意 flag 是 getFeatureMenu 而不是 sendFeatureMenu：代码里检查的是
  // `v2ToolEnabled('getFeatureMenu')`（MCP 注册处与桥接端点都用它）。
  // 早期清单写成 sendFeatureMenu，结果控制台那个开关**拨了没反应**——
  // 正是本文件开头要消灭的那类空壳开关。
  { flag: 'getFeatureMenu', tools: ['qq_send_feature_menu'], group: '内容抓取', desc: '渲染并发送「你会什么」功能菜单图' },
  { flag: 'tokenReport', tools: ['qq_token_report'], group: '内容抓取', desc: '生成 Token 用量统计图并发到会话（今日/近7天/累计/按模型）' },

  // ── B 站 ──
  { flag: 'watchBili', tools: ['qq_watch_bili'], group: 'B 站', desc: '看一个 B 站视频的画面（抽帧+字幕）' },
  { flag: 'biliRecord', tools: ['qq_bili_record'], group: 'B 站', desc: '记录观看感受，写入跨群共用的观看记忆' },
  { flag: 'biliMemory', tools: ['qq_bili_memory'], group: 'B 站', desc: '查观看记忆与口味归纳' },
  { flag: 'biliSearch', tools: ['qq_bili_search'], group: 'B 站', desc: '现场搜 B 站视频，拿标题与真实链接' },

  // ── 基础查询（无条件注册，无开关）──
  //
  // 这几个工具在 MCP 里**没有注册条件**，也从不检查 socialV2.tools：
  // 它们是最早的一批只读查询（机器人自身状态、群列表、群成员、群历史），
  // 风险低且在 closed-agent 之外也用得上。列在这里是为了让控制台能**完整**
  // 说明"有哪些工具、哪些可关"，而不是让它们变成看不见的黑箱。
  // `fixed: true` 表示不可关闭（UI 只展示，不给开关）。
  { flag: 'qq_status', tools: ['qq_status'], group: '基础查询（不可关闭）', desc: '查看机器人自身状态（在线、昵称、账号）', fixed: true },
  { flag: 'qq_list_groups', tools: ['qq_list_groups'], group: '基础查询（不可关闭）', desc: '列出机器人已加入的群', fixed: true },
  { flag: 'qq_get_group_members', tools: ['qq_get_group_members'], group: '基础查询（不可关闭）', desc: '列出某个群的成员', fixed: true },
  { flag: 'qq_get_group_history', tools: ['qq_get_group_history'], group: '基础查询（不可关闭）', desc: '拉取某个群的历史消息', fixed: true },

  // ── 黑话 ──
  { flag: 'slangQuery', tools: ['qq_slang_query'], group: '黑话', desc: '查询已确认黑话/梗/网络表达' },
  { flag: 'slangSubmit', tools: ['qq_slang_submit'], group: '黑话', desc: 'AI 提交陌生词/黑话给管理员筛选' }
];

/** 所有工具的完整清单（用于校验 MCP 有没有漏开关）。 */
export function toolNamesOf(flags = TOOL_FLAGS) {
  const out = [];
  for (const f of flags) for (const t of f.tools) out.push(t);
  return out;
}

/** 按分组聚合并附带当前取值。 */
export function groupedToolFlags(enabledOf) {
  const groups = new Map();
  for (const it of TOOL_FLAGS) {
    if (!groups.has(it.group)) groups.set(it.group, []);
    const on = typeof enabledOf === 'function'
      ? enabledOf(it.flag)
      : (it.default === false ? false : true);
    groups.get(it.group).push({
      flag: it.flag,
      tools: it.tools,
      desc: it.desc,
      risky: it.risky === true,
      default: it.default !== false,
      fixed: it.fixed === true,
      enabled: it.fixed === true ? true : on
    });
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }));
}
