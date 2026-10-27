// 07 二代仿真模式（reserved2，C5 真模块卡，逻辑自 legacy-runtime 迁入）。
import { api as defaultApi } from '../core/api.js';

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  container.innerHTML = "      <div class=\"meta\">配置保存后写入 config.json 并热更新；工具开关决定 AI 能调用哪些工具（关闭后桥接 API 会拒绝）。</div>\n\n      <div class=\"row\" style=\"margin-top:10px\">\n        <label style=\"flex:1\">启用二代模式</label><input type=\"checkbox\" id=\"v2Enabled\" style=\"width:auto\">\n        <label style=\"flex:1\">agentPreset</label><input type=\"text\" id=\"v2AgentPreset\" placeholder=\"qq-chat-v2\" style=\"max-width:200px\">\n      </div>\n      <div class=\"row\" style=\"margin-top:6px\">\n        <label style=\"flex:1\">提供推荐值给 AI</label><input type=\"checkbox\" id=\"v2ProvideRecommendations\" style=\"width:auto\">\n        <span class=\"meta\" style=\"flex:2\">关闭后 qq_get_prompt 不再返回推荐值，AI 完全自主判断。</span>\n      </div>\n      <div class=\"row\" style=\"margin-top:10px\">\n        <button id=\"v2PauseBtn\" class=\"danger\">暂停二代 AI</button>\n        <button id=\"v2ResumeBtn\">恢复二代 AI</button>\n        <button id=\"v2ResetBtn\" class=\"danger\">重置二代状态</button>\n        <button id=\"v2ConfigSaveTop\" style=\"font-weight:bold;padding:6px 14px\">保存当前参数</button>\n        <span class=\"meta\" id=\"v2ActivityStatus\">读取中…</span>\n      </div>\n\n      <div class=\"v2-tabs\" role=\"tablist\" aria-label=\"二代仿真参数分组\">\n        <button type=\"button\" class=\"v2-tab\" role=\"tab\" data-v2-tab=\"wake\">唤醒</button>\n        <button type=\"button\" class=\"v2-tab\" role=\"tab\" data-v2-tab=\"send\">发送</button>\n        <button type=\"button\" class=\"v2-tab active\" role=\"tab\" data-v2-tab=\"wait\">等待与调度</button>\n        <button type=\"button\" class=\"v2-tab\" role=\"tab\" data-v2-tab=\"style\">表情与上下文</button>\n        <button type=\"button\" class=\"v2-tab\" role=\"tab\" data-v2-tab=\"tools\">工具开关</button>\n        <button type=\"button\" class=\"v2-tab\" role=\"tab\" data-v2-tab=\"diag\">诊断</button>\n      </div>\n\n      <div class=\"v2-panel\" data-v2-panel=\"tools\">\n      <div class=\"divider\"></div>\n      <div class=\"meta\" style=\"margin-bottom:6px\">工具开关（关闭后桥接会拒绝对应工具调用）</div>\n      <div class=\"tf-toolbar\">\n        <input type=\"text\" id=\"tfSearch\" class=\"tf-search\" placeholder=\"搜索工具名或说明…\" autocomplete=\"off\">\n        <div class=\"tf-quick\">\n          <button class=\"small\" id=\"tfExpandAll\" type=\"button\">全部展开</button>\n          <button class=\"small\" id=\"tfCollapseAll\" type=\"button\">全部收起</button>\n          <button class=\"small\" id=\"tfEnableAll\" type=\"button\">全开</button>\n          <button class=\"small danger-outline\" id=\"tfDisableAll\" type=\"button\">全关（危险）</button>\n        </div>\n        <span class=\"meta\" id=\"tfStats\"></span>\n      </div>\n      <div id=\"tfGroups\" class=\"tf-groups\"></div>\n      <div class=\"meta\" id=\"tfHint\">\n        开关直接决定 AI 能调用哪些工具（关闭后桥接 API 会拒绝调用）。\n        <b>灰色「不可关闭」</b>的是基础只读查询（机器人状态/群列表等），它们没有开关。\n        <b>红色边</b>的项关闭后影响较大或属于写操作。改完记得点上方的「保存当前参数」。\n      </div>\n      <div class=\"meta\" style=\"margin-top:6px\">二代黑话学习：AI 可用 <code>qq_slang_submit</code> 提交陌生词，也可由桥接自动提取；管理员在下方「08 群聊黑话 / 网络用语库」筛选确认后，词条会自动写入黑话提示词并注入 <code>qq_get_prompt</code> 与后续唤醒。</div>\n\n      </div>\n\n      <div class=\"v2-panel\" data-v2-panel=\"wake\">\n      <div class=\"divider\"></div>\n      <div class=\"meta\" style=\"margin-bottom:6px\">唤醒推荐值（仅参考，AI 可不遵守）</div>\n      <div class=\"row\">\n        <label style=\"flex:1\">默认模式</label>\n        <select id=\"v2WakeDefaultMode\" style=\"width:120px\"><option value=\"diving\">潜水</option><option value=\"active\">活跃</option></select>\n        <label style=\"flex:1\">默认下一次唤醒：无限期（永久）</label><input type=\"checkbox\" id=\"v2RecDefaultInfinite\" style=\"width:auto\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">推荐潜水时长（分）</label>\n        <input type=\"number\" id=\"v2RecSleepMin\" min=\"1\" style=\"width:80px\"> ~\n        <input type=\"number\" id=\"v2RecSleepMax\" min=\"1\" style=\"width:80px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">推荐普通消息概率</label><input type=\"number\" id=\"v2RecProb\" step=\"0.05\" min=\"0\" max=\"1\" style=\"width:80px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">推荐关键词（逗号分隔）</label><input type=\"text\" id=\"v2RecKeywords\" placeholder=\"小鲸鱼, DeepSeek\" style=\"flex:1\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">推荐 @ 唤醒</label><input type=\"checkbox\" id=\"v2RecAt\" style=\"width:auto\">\n        <label style=\"flex:1\">推荐名字唤醒</label><input type=\"checkbox\" id=\"v2RecName\" style=\"width:auto\">\n        <label style=\"flex:1\">推荐提问唤醒</label><input type=\"checkbox\" id=\"v2RecQuestion\" style=\"width:auto\">\n        <label style=\"flex:1\">推荐拍一拍唤醒</label><input type=\"checkbox\" id=\"v2RecPoke\" style=\"width:auto\">\n      </div>\n      <label>唤醒推荐提示（给 AI 看的文字）</label>\n      <textarea id=\"v2WakeHint\" rows=\"2\" placeholder=\"例如：如果你在潜水，推荐 5~120 分钟、普通消息概率 0.05…\"></textarea>\n\n      <div class=\"divider\"></div>\n      <div class=\"meta\" style=\"margin-bottom:6px\">唤醒硬限制</div>\n      <div class=\"row\">\n        <label style=\"flex:1\">最小潜水（秒）</label><input type=\"number\" id=\"v2SleepMinMs\" min=\"0\" style=\"width:90px\">\n        <label style=\"flex:1\">最大潜水（秒，0=不限）</label><input type=\"number\" id=\"v2SleepMaxMs\" min=\"0\" style=\"width:90px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">每分钟最多唤醒</label><input type=\"number\" id=\"v2MaxWakeMin\" min=\"0\" style=\"width:90px\">\n        <label style=\"flex:1\">每小时最多唤醒</label><input type=\"number\" id=\"v2MaxWakeHour\" min=\"0\" style=\"width:90px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">合并窗口（毫秒）</label><input type=\"number\" id=\"v2BatchWindowMs\" min=\"1000\" step=\"500\" style=\"width:100px\">\n        <label style=\"flex:1\">无行动兜底次数</label><input type=\"number\" id=\"v2NoActionLimit\" min=\"1\" style=\"width:80px\">\n        <label style=\"flex:1\">唤醒收尾提醒次数</label><input type=\"number\" id=\"v2MaxWakeConfigReminders\" min=\"1\" style=\"width:80px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">启用沉睡前强制等待</label><input type=\"checkbox\" id=\"v2PreSleepWaitEnabled\" style=\"width:auto\">\n        <label style=\"flex:1\">沉睡前强制等待（分）</label><input type=\"number\" id=\"v2PreSleepWaitMin\" min=\"0\" step=\"1\" style=\"width:80px\">\n        <span class=\"meta\" style=\"flex:2\">AI 设置潜水/下一次唤醒前，默认必须先等够这个观察窗口；0 表示不限制。</span>\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">已发言后允许收尾间隔（秒）</label><input type=\"number\" id=\"v2PreSleepReplyGraceSec\" min=\"0\" max=\"300\" style=\"width:80px\">\n        <span class=\"meta\" style=\"flex:2\">本回合已经发过言且超过这个时间，不再被“连续静默 60 秒”卡死；0 = 立即放行。</span>\n      </div>\n\n      </div>\n\n      <div class=\"v2-panel\" data-v2-panel=\"send\">\n      <div class=\"divider\"></div>\n      <div class=\"meta\" style=\"margin-bottom:6px\">发送限制</div>\n      <div class=\"meta\" style=\"margin-bottom:8px\">二代不再按空格自动拆条；AI 要分多条必须显式传数组或用 qq_send_burst。</div>\n      <div class=\"row\">\n        <label style=\"flex:1\">允许多条发送</label><input type=\"checkbox\" id=\"v2BurstEnabled\" style=\"width:auto\">\n        <label style=\"flex:1\">单次最多条数</label><input type=\"number\" id=\"v2BurstMax\" min=\"1\" style=\"width:70px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">条间间隔（毫秒）</label>\n        <input type=\"number\" id=\"v2BurstMin\" min=\"0\" style=\"width:80px\"> ~\n        <input type=\"number\" id=\"v2BurstMaxMs\" min=\"0\" style=\"width:80px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">长间隔概率</label><input type=\"number\" id=\"v2LongGapProb\" step=\"0.05\" min=\"0\" max=\"1\" style=\"width:80px\">\n        <label style=\"flex:1\">长间隔范围（毫秒）</label>\n        <input type=\"number\" id=\"v2LongGapMin\" min=\"0\" style=\"width:80px\"> ~\n        <input type=\"number\" id=\"v2LongGapMax\" min=\"0\" style=\"width:80px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">每分钟最多发送</label><input type=\"number\" id=\"v2MaxSendMin\" min=\"0\" style=\"width:80px\">\n        <label style=\"flex:1\">每小时最多发送</label><input type=\"number\" id=\"v2MaxSendHour\" min=\"0\" style=\"width:80px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">单条最大字符</label><input type=\"number\" id=\"v2MaxMsgChars\" min=\"1\" style=\"width:80px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">最大条间隔（毫秒，防止过长）</label><input type=\"number\" id=\"v2MaxGapMs\" min=\"100\" style=\"width:90px\">\n        <label style=\"flex:1\">按字数基础间隔（毫秒）</label><input type=\"number\" id=\"v2GapBaseMs\" min=\"0\" style=\"width:80px\">\n        <label style=\"flex:1\">每字追加（毫秒）</label><input type=\"number\" id=\"v2GapPerCharMs\" min=\"0\" style=\"width:80px\">\n      </div>\n      <label>发送推荐提示（给 AI 看的文字）</label>\n      <textarea id=\"v2SendHint\" rows=\"2\" placeholder=\"例如：普通闲聊建议一次 1~3 条，条间 1~3 秒…\"></textarea>\n\n      </div>\n\n      <div class=\"v2-panel active\" data-v2-panel=\"wait\">\n      <div class=\"divider\"></div>\n      <div class=\"meta\" style=\"margin-bottom:6px\">等待工具参数（qq_wait_for_messages）</div>\n      <div class=\"row\">\n        <label style=\"flex:1\">默认等待（毫秒）</label><input type=\"number\" id=\"v2WaitDefaultMs\" min=\"100\" style=\"width:90px\">\n        <label style=\"flex:1\">最小等待（毫秒）</label><input type=\"number\" id=\"v2WaitMinMs\" min=\"100\" style=\"width:90px\">\n        <label style=\"flex:1\">最大等待（毫秒）</label><input type=\"number\" id=\"v2WaitMaxMs\" min=\"100\" style=\"width:90px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">默认静默窗口（毫秒）</label><input type=\"number\" id=\"v2WaitDefaultQuietMs\" min=\"0\" style=\"width:90px\">\n        <label style=\"flex:1\">收到新消息后最小静默（毫秒）</label><input type=\"number\" id=\"v2MinQuietAfterNewMs\" min=\"0\" style=\"width:90px\">\n        <span class=\"meta\" style=\"flex:2\">收到新消息后至少再等这么久，防止抢话；实际值以保存后的配置为准。</span>\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">单次静默上限（毫秒，最大 15000）</label><input type=\"number\" id=\"v2WaitMaxQuietMs\" min=\"0\" max=\"15000\" step=\"1000\" style=\"width:100px\">\n        <label style=\"flex:1\">单回合最多等待次数</label><input type=\"number\" id=\"v2WaitTurnMaxCount\" min=\"1\" max=\"20\" style=\"width:80px\">\n        <label style=\"flex:1\">单回合累计上限（秒）</label><input type=\"number\" id=\"v2WaitTurnMaxSec\" min=\"5\" max=\"600\" style=\"width:80px\">\n      </div>\n      <div class=\"meta v2-note\">单次 wait 的硬截止是「总等待 + 静默窗口 + 1 秒」；同一回合达到次数或累计上限后，桥接直接返回 forceWrapUp，让模型结束回合，避免整群消息排队。</div>\n      <div class=\"row\">\n        <label style=\"flex:1\">回复检查延迟（秒）</label><input type=\"number\" id=\"v2AutoReplyCheckSec\" min=\"1\" style=\"width:90px\">\n        <span class=\"meta\" style=\"flex:2\">回复检查是 AI 发消息后回来检查是否有人回复的延迟。</span>\n      </div>\n\n      <div class=\"divider\"></div>\n      <div class=\"meta\" style=\"margin-bottom:6px\">主动机会参数（proactive：群安静时 AI 主动冒泡）</div>\n      <div class=\"row\">\n        <label style=\"flex:1\">启用主动机会</label><input type=\"checkbox\" id=\"v2ProactiveEnabled\" style=\"width:auto\">\n        <label style=\"flex:1\">检查间隔（分）</label>\n        <input type=\"number\" id=\"v2ProactiveIntervalMin\" min=\"1\" style=\"width:80px\"> ~\n        <input type=\"number\" id=\"v2ProactiveIntervalMax\" min=\"1\" style=\"width:80px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">安静阈值（分）</label><input type=\"number\" id=\"v2ProactiveIdleThreshold\" min=\"1\" style=\"width:80px\">\n        <label style=\"flex:1\">触发概率</label><input type=\"number\" id=\"v2ProactiveProbability\" step=\"0.05\" min=\"0\" max=\"1\" style=\"width:80px\">\n      </div>\n\n      </div>\n\n      <div class=\"v2-panel\" data-v2-panel=\"style\">\n      <div class=\"divider\"></div>\n      <div class=\"meta\" style=\"margin-bottom:6px\">表情包参数（sticker：QQ 收藏表情体系）</div>\n      <div class=\"row\">\n        <label style=\"flex:1\">启用表情包体系</label><input type=\"checkbox\" id=\"v2StickerEnabled\" style=\"width:auto\">\n        <label style=\"flex:1\">同步缓存 TTL（秒）</label><input type=\"number\" id=\"v2StickerSyncTtlSec\" min=\"1\" style=\"width:90px\">\n        <label style=\"flex:1\">列表最大返回数</label><input type=\"number\" id=\"v2StickerMaxList\" min=\"1\" max=\"500\" style=\"width:90px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">提示中列出常用表情数</label><input type=\"number\" id=\"v2StickerPromptMax\" min=\"1\" max=\"30\" style=\"width:90px\">\n        <label style=\"flex:1\">在 prompt/唤醒里附带表情摘要</label><input type=\"checkbox\" id=\"v2StickerIncludePrompt\" style=\"width:auto\">\n        <span class=\"meta\" style=\"flex:2\">关闭后 AI 仍可主动调用 qq_list_stickers，只是不主动喂到上下文。</span>\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">读取本地缓存信息</label><input type=\"checkbox\" id=\"v2StickerReadLocalCache\" style=\"width:auto\">\n        <span class=\"meta\" style=\"flex:2\">开启后 qq_list_stickers / 唤醒摘要会读取 <code>state/sticker-cache/&lt;md5&gt;.json</code> 的本地标注（更详细的描述/标签/用法）；关闭则只用 QQ 备注和本地库字段。</span>\n      </div>\n      <div class=\"row\">\n        <button id=\"v2StickerSyncLocal\" class=\"small\">同步当前收藏到本地</button>\n        <span class=\"meta\" id=\"v2StickerSyncLocalMsg\">从 QQ 拉取当前收藏表情，更新 state/stickers.json 和 state/sticker-cache/ 标注。</span>\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">AI 收藏表情</label><input type=\"checkbox\" id=\"v2StickerCollectEnabled\" style=\"width:auto\">\n        <label style=\"flex:1\">每分钟最多收藏</label><input type=\"number\" id=\"v2StickerCollectPerMin\" min=\"0\" style=\"width:80px\">\n        <label style=\"flex:1\">每小时最多收藏</label><input type=\"number\" id=\"v2StickerCollectPerHour\" min=\"0\" style=\"width:80px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">收藏备注最大字数</label><input type=\"number\" id=\"v2StickerCollectRemarkMax\" min=\"1\" max=\"50\" style=\"width:80px\">\n        <span class=\"meta\" style=\"flex:2\">AI 收藏别人表情时写的简短备注长度上限。</span>\n      </div>\n\n      <!-- 主动要求发表情（2026-10-22 用户反馈「依旧极少调用表情包」）：\n           原来只有软策略提示，实测 1999 次工具调用只发过 1 次。\n           改成桥接掷骰——命中时在提示里明确要求发一张，并给 2~3 个候选。 -->\n      <div class=\"row\" style=\"margin-top:6px\">\n        <label style=\"flex:1\">主动要求发表情</label><input type=\"checkbox\" id=\"v2StickerAutoNudge\" style=\"width:auto\">\n        <span class=\"meta\" style=\"flex:2\">关闭后回到旧的\"软提示\"（模型几乎不会主动发）。</span>\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">每轮命中概率（%）</label><input type=\"number\" id=\"v2StickerNudgeProb\" min=\"0\" max=\"100\" style=\"width:80px\">\n        <label style=\"flex:1\">最小间隔（秒）</label><input type=\"number\" id=\"v2StickerNudgeGapSec\" min=\"0\" style=\"width:90px\">\n      </div>\n      <div class=\"row\">\n        <label style=\"flex:1\">每小时最多要求（次）</label><input type=\"number\" id=\"v2StickerNudgePerHour\" min=\"0\" max=\"60\" style=\"width:80px\">\n        <label style=\"flex:1\">候选数量</label><input type=\"number\" id=\"v2StickerNudgeCandidates\" min=\"1\" max=\"4\" style=\"width:80px\">\n        <span class=\"meta\" style=\"flex:2\">候选越多模型越挑不动，2~3 最合适。</span>\n      </div>\n\n      <div class=\"divider\"></div>\n      <div class=\"meta\" style=\"margin-bottom:6px\">上下文参数（recent / unread / contextWindow）</div>\n      <div class=\"row\">\n        <label style=\"flex:1\">最近消息上限</label><input type=\"number\" id=\"v2ContextRecentLimit\" min=\"1\" style=\"width:80px\">\n        <label style=\"flex:1\">未读上限</label><input type=\"number\" id=\"v2ContextUnreadLimit\" min=\"1\" style=\"width:80px\">\n        <label style=\"flex:1\">上下文窗口</label><input type=\"number\" id=\"v2ContextWindow\" min=\"1\" style=\"width:80px\">\n      </div>\n\n      </div>\n\n      <div class=\"v2-panel\" data-v2-panel=\"diag\">\n      <div class=\"divider\"></div>\n      <div class=\"meta\" style=\"margin-bottom:6px\">反馈工具参数（qq_report_feedback）</div>\n      <div class=\"row\">\n        <label style=\"flex:1\">反馈最大长度</label><input type=\"number\" id=\"v2FeedbackMaxLength\" min=\"1\" style=\"width:90px\">\n        <label style=\"flex:1\">错误级通知 owner</label><input type=\"checkbox\" id=\"v2FeedbackNotifyOwner\" style=\"width:auto\">\n      </div>\n      <div class=\"row\" style=\"margin-top:6px\">\n        <button id=\"v2FeedbackLoad\" class=\"small\">加载 AI 反馈</button>\n        <button id=\"v2FeedbackClear\" class=\"small danger\">清空 AI 反馈</button>\n        <span class=\"meta\" id=\"v2FeedbackMsg\"></span>\n      </div>\n      <pre id=\"v2FeedbackOutput\">（空）</pre>\n\n      <div class=\"divider\"></div>\n      <div class=\"meta\" style=\"margin-bottom:6px\">工具调用日志（AI 调用了什么工具、参数、成功/失败）</div>\n      <div class=\"row\">\n        <button id=\"v2ToolLogLoad\" class=\"small\">加载工具日志</button>\n        <button id=\"v2ToolLogClear\" class=\"small danger\">清空工具日志</button>\n        <span class=\"meta\" id=\"v2ToolLogMsg\"></span>\n      </div>\n      <div id=\"v2ToolLogOutput\" class=\"tool-log-table\">（空）</div>\n\n      <div class=\"divider\"></div>\n      <div class=\"meta\" style=\"margin-bottom:6px\">轻量记忆（activeTopics / pendingThoughts / memberImpressions）</div>\n      <div class=\"row\">\n        <input type=\"text\" id=\"v2MemoryKey\" placeholder=\"group:123456789\" style=\"flex:1\">\n        <button id=\"v2MemoryLoad\" class=\"small\">加载记忆</button>\n        <button id=\"v2MemoryClearAll\" class=\"small danger\">清空全部</button>\n        <span class=\"meta\" id=\"v2MemoryMsg\"></span>\n      </div>\n      <div id=\"v2MemoryOutput\" class=\"tool-log-table\">（空）</div>\n\n      <div class=\"divider\"></div>\n      <div class=\"meta\" style=\"margin-bottom:6px\">唤醒状态（AI 当前设置的下一次唤醒条件/倒计时）</div>\n      <div class=\"row\">\n        <input type=\"text\" id=\"v2WakeKey\" placeholder=\"group:123456789\" style=\"flex:1\">\n        <button id=\"v2WakeStatusLoad\" class=\"small\">查看唤醒状态</button>\n        <span class=\"meta\" id=\"v2WakeStatusMsg\"></span>\n      </div>\n      <div id=\"v2WakeStatusOutput\" class=\"tool-log-table\">（空）</div>\n\n      <div class=\"row\" style=\"margin-top:10px\">\n        <button id=\"v2ConfigSave\" style=\"font-weight:bold;padding:8px 16px\">保存当前参数（写入 config.json）</button>\n        <span class=\"meta\" id=\"v2ConfigMsg\"></span>\n      </div>\n      <div class=\"meta\" style=\"margin-top:4px\">修改上面任意推荐/默认参数后，必须点这个按钮才会持久化；保存后会自动应用到仍使用默认唤醒配置的会话，重启后仍然保留。</div>\n\n      <div class=\"divider\"></div>\n      <div class=\"meta\" style=\"margin-bottom:6px\">白名单会话快速选择</div>\n      <div class=\"row\">\n        <select id=\"v2SessionSelect\" style=\"flex:1\"><option value=\"\">选择白名单群/私聊…</option></select>\n        <button id=\"v2SessionRefresh\" class=\"small\">刷新</button>\n      </div>\n\n      <div class=\"divider\"></div>\n      <div class=\"meta\" style=\"margin-bottom:6px\">会话状态查看</div>\n      <div class=\"row\">\n        <input type=\"text\" id=\"v2StateKey\" placeholder=\"group:123456789\" style=\"flex:1\">\n        <button id=\"v2StateView\" class=\"small\">查看</button>\n        <button id=\"v2ForceWake\" class=\"small\">立即唤醒</button>\n        <button id=\"v2StatesList\" class=\"small\">列出全部会话状态</button>\n      </div>\n      <pre id=\"v2StateOutput\">（空）</pre>\n      <pre id=\"v2AllStatesOutput\" style=\"margin-top:6px\">（全部会话状态：空）</pre>\n      </div>\n      <div class=\"declarative-card\" data-card-mount=\"07\"></div>";

  const TF_COLLAPSED_KEY = 'qq-bridge-toolflag-collapsed';
  let tfData = null; // 最近一次接口返回
  
  function tfLoadCollapsed() {
    try { return new Set(JSON.parse(localStorage.getItem(TF_COLLAPSED_KEY) || '[]')); } catch { return new Set(); }
  }
  function tfSaveCollapsed(set) {
    try { localStorage.setItem(TF_COLLAPSED_KEY, JSON.stringify([...set])); } catch {}
  }
  
  function tfMatches(item, q) {
    if (!q) return true;
    const hay = `${item.flag} ${(item.tools || []).join(' ')} ${item.desc || ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  }
  
  function tfRender() {
    const box = document.getElementById('tfGroups');
    if (!box || !tfData) return;
    const q = (document.getElementById('tfSearch')?.value || '').trim();
    const collapsed = tfLoadCollapsed();
    let shown = 0, total = 0;
  
    box.innerHTML = tfData.groups.map((g) => {
      const items = g.items.filter((it) => tfMatches(it, q));
      total += g.items.length;
      if (!items.length) return ''; // 搜索时整组不匹配就隐藏
      shown += items.length;
      const isCollapsed = collapsed.has(g.group);
      const onCount = g.items.filter((it) => it.fixed || it.enabled).length;
      return `
        <div class="tf-group${isCollapsed ? ' collapsed' : ''}" data-group="${esc(g.group)}">
          <div class="tf-group-head">
            <span class="tf-caret">▼</span>
            <span class="tf-group-title">${esc(g.group)}</span>
            <span class="tf-group-count">${onCount}/${g.items.length} 启用</span>
            ${g.items.some((it) => !it.fixed)
              ? `<span class="tf-group-actions">
                   <button class="small" data-group-on="${esc(g.group)}" type="button">全开</button>
                   <button class="small danger-outline" data-group-off="${esc(g.group)}" type="button">全关</button>
                 </span>`
              : ''}
          </div>
          <div class="tf-group-body">
            <div class="tf-list">
              ${items.map((it) => {
                const cls = [
                  'tf-item',
                  it.risky ? 'risky' : '',
                  it.fixed ? 'fixed' : '',
                  (!it.fixed && !it.enabled) ? 'disabled-tool' : ''
                ].filter(Boolean).join(' ');
                return `
                  <label class="${cls}" data-flag="${esc(it.flag)}">
                    <input type="checkbox" data-v2-tool="${esc(it.flag)}"
                           ${it.fixed ? 'disabled' : ''} ${it.enabled ? 'checked' : ''}>
                    <span class="tf-main">
                      <span class="tf-name">${esc((it.tools || []).join(' / '))}</span>
                      <span class="meta">${esc(it.desc || '')}
                        ${it.fixed ? '<span class="tf-badge lock">不可关闭</span>' : ''}
                        ${it.risky ? '<span class="tf-badge risky">慎关</span>' : ''}
                      </span>
                    </span>
                  </label>`;
              }).join('')}
            </div>
          </div>
        </div>`;
    }).join('') || `<div class="tf-empty">没有匹配「${esc(q)}」的工具</div>`;
  
    // 统计
    const st = document.getElementById('tfStats');
    if (st) {
      const enabledAll = tfData.groups.reduce((n, g) => n + g.items.filter((it) => it.fixed || it.enabled).length, 0);
      st.innerHTML = `<span class="pill g">已启用 ${enabledAll} / ${tfData.total}</span>`
        + ` 覆盖 ${tfData.toolCount} 个工具`
        + (q ? `　<span class="meta">筛选出 ${shown} / ${total}</span>` : '');
    }
    return box;
  }
  
  // 折叠：点组标题切换（点按钮时不算）
  document.addEventListener('click', (e) => {
    const head = e.target.closest?.('.tf-group-head');
    if (head && !e.target.closest('button')) {
      const group = head.parentElement?.dataset?.group;
      if (!group) return;
      const collapsed = tfLoadCollapsed();
      if (collapsed.has(group)) collapsed.delete(group); else collapsed.add(group);
      tfSaveCollapsed(collapsed);
      head.parentElement.classList.toggle('collapsed');
      return;
    }
    // 组内全开 / 全关
    const onBtn = e.target.closest?.('[data-group-on]');
    const offBtn = e.target.closest?.('[data-group-off]');
    const group = onBtn?.dataset.groupOn || offBtn?.dataset.groupOff;
    if (group) {
      const toOn = !!onBtn;
      document.querySelectorAll(`.tf-group[data-group="${CSS.escape(group)}"] input[data-v2-tool]`)
        .forEach((el) => { if (!el.disabled) el.checked = toOn; });
      tfSyncRowVisual();
    }
  });
  
  // 开关勾选后同步那一行的淡化样式
  function tfSyncRowVisual() {
    document.querySelectorAll('.tf-item').forEach((row) => {
      const cb = row.querySelector('input[data-v2-tool]');
      if (!cb || cb.disabled) return;
      row.classList.toggle('disabled-tool', !cb.checked);
    });
  }
  document.addEventListener('change', (e) => {
    if (e.target?.matches?.('input[data-v2-tool]')) tfSyncRowVisual();
  });
  
  // 顶部工具条
  document.getElementById('tfSearch')?.addEventListener('input', tfRender);
  document.getElementById('tfExpandAll')?.addEventListener('click', () => {
    tfSaveCollapsed(new Set());
    document.querySelectorAll('.tf-group').forEach((g) => g.classList.remove('collapsed'));
  });
  document.getElementById('tfCollapseAll')?.addEventListener('click', () => {
    const all = [...document.querySelectorAll('.tf-group')].map((g) => g.dataset.group);
    tfSaveCollapsed(new Set(all));
    document.querySelectorAll('.tf-group').forEach((g) => g.classList.add('collapsed'));
  });
  document.getElementById('tfEnableAll')?.addEventListener('click', () => {
    document.querySelectorAll('input[data-v2-tool]').forEach((el) => { if (!el.disabled) el.checked = true; });
    tfSyncRowVisual();
  });
  document.getElementById('tfDisableAll')?.addEventListener('click', () => {
    if (!confirm('确定关闭全部可关闭的工具开关？AI 将只剩基础只读查询能力。')) return;
    document.querySelectorAll('input[data-v2-tool]').forEach((el) => { if (!el.disabled) el.checked = false; });
    tfSyncRowVisual();
  });
  
  // 从接口拉清单并渲染
  async function renderToolFlags() {
    const box = document.getElementById('tfGroups');
    if (!box) return;
    try {
      const r = await api('/api/socialV2/tool-flags');
      if (!r?.ok) { box.innerHTML = '<div class="tf-empty">读取工具清单失败</div>'; return; }
      tfData = r;
      tfRender();
    } catch (e) {
      box.innerHTML = `<div class="tf-empty">读取工具清单失败：${esc(e?.message || e)}</div>`;
    }
  }

  async function loadV2Config() {
  try {
    const r = await api('/api/socialV2/config');
    const c = r.config || {};
    document.getElementById('v2Enabled').checked = c.enabled !== false;
    document.getElementById('v2AgentPreset').value = c.agentPreset || '';
    document.getElementById('v2ProvideRecommendations').checked = c.provideRecommendations !== false;
    // 工具开关现在由 renderToolFlags() 从 /api/socialV2/tool-flags 渲染（见下）。
    // 这里只把"当前配置"同步给渲染器，不直接碰 DOM——否则会和动态渲染抢着写。
    await renderToolFlags();
    const w = c.wake || {};
    document.getElementById('v2WakeDefaultMode').value = w.defaultMode === 'active' ? 'active' : 'diving';
    document.getElementById('v2RecDefaultInfinite').checked = w.recommendedDefaultInfinite !== false;
    document.getElementById('v2RecSleepMin').value = Math.round((w.recommendedSleepMinMs || 300000) / 60000);
    document.getElementById('v2RecSleepMax').value = Math.round((w.recommendedSleepMaxMs || 7200000) / 60000);
    document.getElementById('v2RecProb').value = w.recommendedProbability ?? 0.05;
    document.getElementById('v2RecKeywords').value = (w.recommendedKeywords || []).join(', ');
    document.getElementById('v2RecAt').checked = w.recommendedAtMention !== false;
    document.getElementById('v2RecName').checked = w.recommendedNameMention !== false;
    document.getElementById('v2RecQuestion').checked = w.recommendedQuestion !== false;
    document.getElementById('v2RecPoke').checked = w.recommendedPoke !== false;
    document.getElementById('v2WakeHint').value = w.recommendedHint || '';
    document.getElementById('v2SleepMinMs').value = Math.round((w.sleepMinMs || 60000) / 1000);
    document.getElementById('v2SleepMaxMs').value = Math.round((w.sleepMaxMs || 0) / 1000);
    document.getElementById('v2MaxWakeMin').value = w.maxWakePerMinute ?? 1;
    document.getElementById('v2MaxWakeHour').value = w.maxWakePerHour ?? 12;
    document.getElementById('v2BatchWindowMs').value = w.batchWindowMs ?? 8000;
    document.getElementById('v2NoActionLimit').value = w.noActionLimit ?? 3;
    document.getElementById('v2MaxWakeConfigReminders').value = w.maxWakeConfigReminders ?? 2;
    document.getElementById('v2PreSleepWaitEnabled').checked = w.preSleepWaitEnabled !== false;
    document.getElementById('v2PreSleepWaitMin').value = Number.isFinite(Number(w.preSleepWaitMs)) ? Math.round(Number(w.preSleepWaitMs) / 60000) : 5;
    document.getElementById('v2PreSleepReplyGraceSec').value = Math.round((Number(w.preSleepReplyGraceMs) || 30000) / 1000);
    const s = c.send || {};
    document.getElementById('v2BurstEnabled').checked = s.burstEnabled !== false;
    document.getElementById('v2BurstMax').value = s.burstMaxMessages ?? 8;
    document.getElementById('v2BurstMin').value = s.burstIntervalMinMs ?? 1000;
    document.getElementById('v2BurstMaxMs').value = s.burstIntervalMaxMs ?? 3000;
    document.getElementById('v2LongGapProb').value = s.longGapProbability ?? 0.2;
    document.getElementById('v2LongGapMin').value = s.longGapMinMs ?? 5000;
    document.getElementById('v2LongGapMax').value = s.longGapMaxMs ?? 10000;
    document.getElementById('v2MaxSendMin').value = s.maxSendPerMinute ?? 8;
    document.getElementById('v2MaxSendHour').value = s.maxSendPerHour ?? 60;
    document.getElementById('v2MaxMsgChars').value = s.maxMessageChars ?? 500;
    document.getElementById('v2MaxGapMs').value = s.maxGapMs ?? 10000;
    document.getElementById('v2GapBaseMs').value = s.gapBaseMs ?? 800;
    document.getElementById('v2GapPerCharMs').value = s.gapPerCharMs ?? 20;
    document.getElementById('v2SendHint').value = s.recommendedHint || '';
    const wt = c.wait || {};
    document.getElementById('v2WaitDefaultMs').value = wt.defaultMs ?? 30000;
    document.getElementById('v2WaitMinMs').value = wt.minMs ?? 5000;
    document.getElementById('v2WaitMaxMs').value = wt.maxMs ?? 600000;
    document.getElementById('v2WaitDefaultQuietMs').value = wt.defaultQuietMs ?? 8000;
    document.getElementById('v2MinQuietAfterNewMs').value = wt.minQuietAfterNewMs ?? 10000;
    document.getElementById('v2WaitMaxQuietMs').value = wt.maxQuietMs ?? 15000;
    document.getElementById('v2WaitTurnMaxCount').value = wt.turnMaxCount ?? 2;
    document.getElementById('v2WaitTurnMaxSec').value = Math.round((Number(wt.turnMaxMs) || 120000) / 1000);
    document.getElementById('v2AutoReplyCheckSec').value = Math.round((c.autoReplyCheckMs || 30000) / 1000);
    const pa = c.proactive || {};
    document.getElementById('v2ProactiveEnabled').checked = pa.enabled !== false;
    document.getElementById('v2ProactiveIntervalMin').value = Math.round((pa.checkIntervalMinMs || 1800000) / 60000);
    document.getElementById('v2ProactiveIntervalMax').value = Math.round((pa.checkIntervalMaxMs || 5400000) / 60000);
    document.getElementById('v2ProactiveIdleThreshold').value = Math.round((pa.idleThresholdMs || 900000) / 60000);
    document.getElementById('v2ProactiveProbability').value = pa.probability ?? 0.3;
    const stk = c.sticker || {};
    document.getElementById('v2StickerEnabled').checked = stk.enabled !== false;
    document.getElementById('v2StickerSyncTtlSec').value = Math.round((stk.syncTtlMs || 60000) / 1000);
    document.getElementById('v2StickerMaxList').value = stk.maxListCount ?? 100;
    document.getElementById('v2StickerPromptMax').value = stk.promptMaxStickers ?? 8;
    document.getElementById('v2StickerIncludePrompt').checked = stk.includeInPrompt !== false;
    document.getElementById('v2StickerReadLocalCache').checked = stk.readLocalCache !== false;
    const stkCollect = stk.collect || {};
    document.getElementById('v2StickerCollectEnabled').checked = stkCollect.enabled !== false;
    document.getElementById('v2StickerCollectPerMin').value = stkCollect.maxPerMinute ?? 2;
    document.getElementById('v2StickerCollectPerHour').value = stkCollect.maxPerHour ?? 10;
    document.getElementById('v2StickerCollectRemarkMax').value = stkCollect.maxRemarkChars ?? 20;
    // 主动要求发表情（2026-10-22）
    document.getElementById('v2StickerAutoNudge').checked = stk.autoNudge !== false;
    document.getElementById('v2StickerNudgeProb').value = Math.round((stk.autoNudgeProbability ?? 0.33) * 100);
    document.getElementById('v2StickerNudgeGapSec').value = Math.round((stk.autoNudgeMinGapMs ?? 180000) / 1000);
    document.getElementById('v2StickerNudgePerHour').value = stk.autoNudgeMaxPerHour ?? 6;
    document.getElementById('v2StickerNudgeCandidates').value = stk.autoNudgeCandidates ?? 3;
    const ctx = c.context || {};
    document.getElementById('v2ContextRecentLimit').value = ctx.recentLimit ?? 100;
    document.getElementById('v2ContextUnreadLimit').value = ctx.unreadLimit ?? 30;
    document.getElementById('v2ContextWindow').value = ctx.contextWindow ?? 20;
    const fb = c.feedback || {};
    document.getElementById('v2FeedbackMaxLength').value = fb.maxLength ?? 500;
    document.getElementById('v2FeedbackNotifyOwner').checked = fb.notifyOwnerOnError === true;
    // 参数值变化后立即刷新 07 号摘要（等待上限现在会显示在悬停文案里）。
    refreshSummaries();
  } catch {}
}

async function saveV2Config() {
  const tools = {};
  document.querySelectorAll('[data-v2-tool]').forEach(el => { tools[el.dataset.v2Tool] = el.checked; });
  const body = {
    enabled: document.getElementById('v2Enabled').checked,
    agentPreset: document.getElementById('v2AgentPreset').value.trim(),
    provideRecommendations: document.getElementById('v2ProvideRecommendations').checked,
    autoReplyCheckMs: Math.round(Number(document.getElementById('v2AutoReplyCheckSec').value) || 30) * 1000,
    tools,
    wake: {
      defaultMode: document.getElementById('v2WakeDefaultMode').value,
      recommendedDefaultInfinite: document.getElementById('v2RecDefaultInfinite').checked,
      preSleepWaitEnabled: document.getElementById('v2PreSleepWaitEnabled').checked,
      preSleepWaitMs: (Number.isFinite(Number(document.getElementById('v2PreSleepWaitMin').value)) && Number(document.getElementById('v2PreSleepWaitMin').value) >= 0 ? Math.round(Number(document.getElementById('v2PreSleepWaitMin').value)) : 5) * 60000,
      preSleepReplyGraceMs: Math.max(0, Math.min(300, Math.round(Number(document.getElementById('v2PreSleepReplyGraceSec').value) || 0))) * 1000,
      recommendedSleepMinMs: (Math.round(Number(document.getElementById('v2RecSleepMin').value) || 5)) * 60000,
      recommendedSleepMaxMs: (Math.round(Number(document.getElementById('v2RecSleepMax').value) || 120)) * 60000,
      recommendedProbability: Number(document.getElementById('v2RecProb').value) || 0,
      recommendedKeywords: document.getElementById('v2RecKeywords').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      recommendedAtMention: document.getElementById('v2RecAt').checked,
      recommendedNameMention: document.getElementById('v2RecName').checked,
      recommendedQuestion: document.getElementById('v2RecQuestion').checked,
      recommendedPoke: document.getElementById('v2RecPoke').checked,
      recommendedHint: document.getElementById('v2WakeHint').value,
      sleepMinMs: (Math.round(Number(document.getElementById('v2SleepMinMs').value) || 0)) * 1000,
      sleepMaxMs: (Math.round(Number(document.getElementById('v2SleepMaxMs').value) || 0)) * 1000,
      maxWakePerMinute: Math.round(Number(document.getElementById('v2MaxWakeMin').value) || 0),
      maxWakePerHour: Math.round(Number(document.getElementById('v2MaxWakeHour').value) || 0),
      batchWindowMs: Math.round(Number(document.getElementById('v2BatchWindowMs').value) || 8000),
      noActionLimit: Math.round(Number(document.getElementById('v2NoActionLimit').value) || 3),
      maxWakeConfigReminders: Math.round(Number(document.getElementById('v2MaxWakeConfigReminders').value) || 2)
    },
    send: {
      burstEnabled: document.getElementById('v2BurstEnabled').checked,
      burstMaxMessages: Math.round(Number(document.getElementById('v2BurstMax').value) || 8),
      burstIntervalMinMs: Math.round(Number(document.getElementById('v2BurstMin').value) || 1000),
      burstIntervalMaxMs: Math.round(Number(document.getElementById('v2BurstMaxMs').value) || 3000),
      longGapProbability: Number(document.getElementById('v2LongGapProb').value) || 0,
      longGapMinMs: Math.round(Number(document.getElementById('v2LongGapMin').value) || 5000),
      longGapMaxMs: Math.round(Number(document.getElementById('v2LongGapMax').value) || 10000),
      maxSendPerMinute: Math.round(Number(document.getElementById('v2MaxSendMin').value) || 0),
      maxSendPerHour: Math.round(Number(document.getElementById('v2MaxSendHour').value) || 0),
      maxMessageChars: Math.round(Number(document.getElementById('v2MaxMsgChars').value) || 500),
      maxGapMs: Math.round(Number(document.getElementById('v2MaxGapMs').value) || 10000),
      gapBaseMs: Math.round(Number(document.getElementById('v2GapBaseMs').value) || 800),
      gapPerCharMs: Math.round(Number(document.getElementById('v2GapPerCharMs').value) || 20),
      recommendedHint: document.getElementById('v2SendHint').value
    },
    wait: {
      defaultMs: Math.round(Number(document.getElementById('v2WaitDefaultMs').value) || 5000),
      minMs: Math.round(Number(document.getElementById('v2WaitMinMs').value) || 1000),
      maxMs: Math.round(Number(document.getElementById('v2WaitMaxMs').value) || 10000),
      defaultQuietMs: Number.isFinite(Number(document.getElementById('v2WaitDefaultQuietMs').value)) ? Math.max(0, Math.round(Number(document.getElementById('v2WaitDefaultQuietMs').value))) : 8000,
      minQuietAfterNewMs: Number.isFinite(Number(document.getElementById('v2MinQuietAfterNewMs').value)) ? Math.max(0, Math.round(Number(document.getElementById('v2MinQuietAfterNewMs').value))) : 10000,
      maxQuietMs: Math.max(0, Math.min(15000, Math.round(Number(document.getElementById('v2WaitMaxQuietMs').value) || 0))),
      turnMaxCount: Math.max(1, Math.min(20, Math.round(Number(document.getElementById('v2WaitTurnMaxCount').value) || 2))),
      turnMaxMs: Math.max(5000, Math.min(600000, Math.round(Number(document.getElementById('v2WaitTurnMaxSec').value) || 120) * 1000))
    },
    proactive: {
      enabled: document.getElementById('v2ProactiveEnabled').checked,
      checkIntervalMinMs: Math.round(Number(document.getElementById('v2ProactiveIntervalMin').value) || 30) * 60000,
      checkIntervalMaxMs: Math.round(Number(document.getElementById('v2ProactiveIntervalMax').value) || 90) * 60000,
      idleThresholdMs: Math.round(Number(document.getElementById('v2ProactiveIdleThreshold').value) || 15) * 60000,
      probability: Number(document.getElementById('v2ProactiveProbability').value) || 0
    },
    sticker: {
      enabled: document.getElementById('v2StickerEnabled').checked,
      syncTtlMs: Math.max(1000, Math.round(Number(document.getElementById('v2StickerSyncTtlSec').value) || 60) * 1000),
      maxListCount: Math.min(500, Math.max(1, Math.round(Number(document.getElementById('v2StickerMaxList').value) || 100))),
      includeInPrompt: document.getElementById('v2StickerIncludePrompt').checked,
      readLocalCache: document.getElementById('v2StickerReadLocalCache').checked,
      promptMaxStickers: Math.min(30, Math.max(1, Math.round(Number(document.getElementById('v2StickerPromptMax').value) || 8))),
      // 主动要求发表情（2026-10-22）：概率按百分数填，提交时折回 0~1
      autoNudge: document.getElementById('v2StickerAutoNudge').checked,
      autoNudgeProbability: Math.min(1, Math.max(0, Number(document.getElementById('v2StickerNudgeProb').value) / 100 || 0)),
      autoNudgeMinGapMs: Math.max(0, Math.round(Number(document.getElementById('v2StickerNudgeGapSec').value) || 0) * 1000),
      autoNudgeMaxPerHour: Math.min(60, Math.max(0, Math.round(Number(document.getElementById('v2StickerNudgePerHour').value) || 0))),
      autoNudgeCandidates: Math.min(4, Math.max(1, Math.round(Number(document.getElementById('v2StickerNudgeCandidates').value) || 3))),
      collect: {
        enabled: document.getElementById('v2StickerCollectEnabled').checked,
        maxPerMinute: Math.max(0, Math.round(Number(document.getElementById('v2StickerCollectPerMin').value) || 0)),
        maxPerHour: Math.max(0, Math.round(Number(document.getElementById('v2StickerCollectPerHour').value) || 0)),
        maxRemarkChars: Math.min(50, Math.max(1, Math.round(Number(document.getElementById('v2StickerCollectRemarkMax').value) || 20)))
      }
    },
    context: {
      recentLimit: Math.round(Number(document.getElementById('v2ContextRecentLimit').value) || 100),
      unreadLimit: Math.round(Number(document.getElementById('v2ContextUnreadLimit').value) || 30),
      contextWindow: Math.round(Number(document.getElementById('v2ContextWindow').value) || 20)
    },
    feedback: {
      maxLength: Math.round(Number(document.getElementById('v2FeedbackMaxLength').value) || 500),
      notifyOwnerOnError: document.getElementById('v2FeedbackNotifyOwner').checked
    }
  };
  const r = await api('/api/socialV2/config', 'POST', body);
  const msg = document.getElementById('v2ConfigMsg');
  msg.textContent = r.ok ? '✅ 已保存' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) loadV2Config();
}

async function viewV2State() {
  const key = document.getElementById('v2StateKey').value.trim();
  if (!key) { alert('请输入会话 key'); return; }
  const r = await api('/api/socialV2/state?key=' + encodeURIComponent(key));
  document.getElementById('v2StateOutput').textContent = JSON.stringify(r, null, 2);
}

function v2ToolLogStatus(entry) {
  if (entry.type === 'result') {
    const ok = entry.ok !== false;
    return `<span class="pill ${ok ? 'g' : 'r'}">${ok ? '成功' : '失败'}</span>`;
  }
  return '<span class="pill b">调用</span>';
}
function summarizeToolArgs(tool, args) {
  let obj = args;
  if (typeof args === 'string') {
    try { obj = JSON.parse(args); } catch { return args || ''; }
  }
  if (!obj || typeof obj !== 'object') return String(obj ?? '');
  const parts = [];
  const push = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    parts.push(`${k}=${v}`);
  };
  const t = String(tool || '');
  if (t.includes('qq_set_wake_config')) {
    const cfg = (obj.config && typeof obj.config === 'object') ? obj.config : obj;
    push('mode', cfg.mode);
    push('infinite', cfg.infinite);
    const sleepUntil = cfg.sleepUntil || obj.sleepUntil;
    const sleepMs = cfg.sleepMs !== undefined ? cfg.sleepMs : obj.sleepMs;
    if (sleepUntil) push('sleepUntil', sleepUntil);
    else if (sleepMs !== undefined) push('sleepMs', sleepMs + 'ms');
    else push('sleep', '未设置时间');
    const tr = (cfg.triggers && typeof cfg.triggers === 'object') ? cfg.triggers : {};
    const trigs = [];
    if (tr.atMention) trigs.push('@');
    if (tr.nameMention) trigs.push('名字');
    if (tr.question) trigs.push('提问');
    if (tr.poke) trigs.push('拍一拍');
    if (Array.isArray(tr.keywords) && tr.keywords.length) trigs.push('关键词:' + tr.keywords.join(','));
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) trigs.push('指定成员:' + tr.speakerIds.join(','));
    if (tr.anyMessage) trigs.push('anyMessage');
    if (Number(tr.probability) > 0) trigs.push('概率:' + tr.probability);
    if (trigs.length) push('triggers', trigs.join('|'));
  } else if (t.includes('qq_wait_for_messages')) {
    push('timeoutMs', obj.timeoutMs != null ? obj.timeoutMs : '默认30000');
    push('minNewMessages', obj.minNewMessages != null ? obj.minNewMessages : 1);
    push('quietMs', obj.quietMs != null ? obj.quietMs : '默认8000');
  } else if (t.includes('qq_send_message')) {
    const msgs = Array.isArray(obj.messages) ? obj.messages : (obj.messages != null ? [obj.messages] : []);
    push('条数', msgs.length);
    if (msgs.length) push('首条', String(msgs[0]).slice(0, 30));
    push('gapMode', obj.gapMode || 'auto');
    if (obj.gapMs != null) push('gapMs', obj.gapMs);
    if (Array.isArray(obj.gaps) && obj.gaps.length) push('gaps', obj.gaps.join(','));
    if (obj.replyToMessageId != null && obj.replyToMessageId !== '') push('引用id', obj.replyToMessageId);
  } else if (t.includes('qq_send_burst')) {
    const msgs = Array.isArray(obj.messages) ? obj.messages : [];
    push('条数', msgs.length);
    if (msgs.length) push('首条', String(msgs[0]).slice(0, 30));
  } else if (t.includes('qq_send_poke')) {
    push('key', obj.key);
    if (obj.targetUserId != null && obj.targetUserId !== '') push('target', obj.targetUserId);
  } else if (t.includes('qq_get_forward_msg')) {
    push('key', obj.key);
    if (obj.id != null && obj.id !== '') push('id', String(obj.id).slice(0, 40));
  } else if (t.includes('qq_mark_read')) {
    push('key', obj.key);
  } else if (t.includes('qq_get_prompt') || t.includes('qq_get_unread_messages') || t.includes('qq_get_recent_messages') || t.includes('qq_social_state') || t.includes('qq_get_my_recent_messages') || t.includes('qq_get_message_detail') || t.includes('qq_get_active_members')) {
    push('key', obj.key);
    if (obj.messageId != null) push('messageId', obj.messageId);
    if (obj.limit != null) push('limit', obj.limit);
  } else {
    push('key', obj.key);
  }
  return parts.join(' | ') || JSON.stringify(obj);
}
function v2ToolLogCell(value, tool) {
  const text = value == null ? '' : String(value);
  if (!text) return '<span class="meta">-</span>';
  const summary = tool ? summarizeToolArgs(tool, text) : text;
  const short = summary.length > 100 ? summary.slice(0, 100) + '…' : summary;
  return `<span class="tool-log-cell" data-full="${esc(text)}" data-short="${esc(short)}" title="点击查看完整 JSON">${esc(short)}</span>`;
}
function renderV2ToolLog(entries) {
  const box = document.getElementById('v2ToolLogOutput');
  const list = entries || [];
  if (!list.length) { box.innerHTML = '<span class="meta">（空）</span>'; return; }
  let html = '<table><tr><th>时间</th><th>会话 key</th><th>工具名</th><th>状态</th><th>参数</th><th>错误信息</th></tr>';
  for (const e of list) {
    const time = e.time ? new Date(e.time).toLocaleString() : '-';
    const key = esc(e.key || '');
    const tool = esc(e.tool || '-');
    const status = v2ToolLogStatus(e);
    const params = e.type === 'call' ? v2ToolLogCell(e.args, e.tool) : '<span class="meta">-</span>';
    const error = e.type === 'result' ? v2ToolLogCell(e.error) : '<span class="meta">-</span>';
    html += `<tr><td>${esc(time)}</td><td>${key}</td><td>${tool}</td><td>${status}</td><td>${params}</td><td>${error}</td></tr>`;
  }
  html += '</table>';
  box.innerHTML = html;
}
function loadV2ToolLog() {
  return api('/api/socialV2/tool-log?limit=200')
    .then(r => { renderV2ToolLog(r.entries || []); })
    .catch(() => { renderV2ToolLog([]); });
}
document.getElementById('v2ToolLogOutput').addEventListener('click', (ev) => {
  const cell = ev.target.closest('.tool-log-cell');
  if (!cell) return;
  const full = cell.dataset.full;
  const short = cell.dataset.short;
  if (cell.classList.contains('expanded')) {
    cell.classList.remove('expanded');
    cell.textContent = short;
  } else {
    cell.classList.add('expanded');
    cell.textContent = full;
  }
});

function renderV2Memory(data) {
  const box = document.getElementById('v2MemoryOutput');
  if (!data || !data.ok) {
    box.innerHTML = '<span class="meta">加载失败</span>';
    return;
  }
  const raw = data.raw || {};
  const topics = Array.isArray(raw.activeTopics) ? raw.activeTopics : [];
  const thoughts = Array.isArray(raw.pendingThoughts) ? raw.pendingThoughts : [];
  const impressions = raw.memberImpressions && typeof raw.memberImpressions === 'object' ? raw.memberImpressions : {};
  let html = '<div style="padding:8px">';
  html += '<div class="memory-section"><b>进行中的话题</b> <button class="small" data-action="clear" data-cat="activeTopic">清空</button>';
  if (!topics.length) html += '<div class="meta">（空）</div>';
  for (const t of topics) {
    const text = esc(String(t?.text || ''));
    const extra = t?.pendingQuestion ? `；待追问：${esc(String(t.pendingQuestion))}` : '';
    html += `<div style="margin:4px 0">📌 ${text}${extra} <button class="small" data-action="edit" data-cat="activeTopic" data-content="${esc(String(t?.text || ''))}">编辑</button> <button class="small" data-action="remove" data-cat="activeTopic" data-content="${esc(String(t?.text || ''))}">删除</button></div>`;
  }
  html += '</div>';
  html += '<div class="memory-section"><b>你想说但还没说的</b> <button class="small" data-action="clear" data-cat="pendingThought">清空</button>';
  if (!thoughts.length) html += '<div class="meta">（空）</div>';
  for (const t of thoughts) {
    html += `<div style="margin:4px 0">💭 ${esc(String(t?.text || ''))}${t?.motivation ? `（${esc(String(t.motivation))}）` : ''} <button class="small" data-action="edit" data-cat="pendingThought" data-content="${esc(String(t?.text || ''))}">编辑</button> <button class="small" data-action="remove" data-cat="pendingThought" data-content="${esc(String(t?.text || ''))}">删除</button></div>`;
  }
  html += '</div>';
  html += '<div class="memory-section"><b>对群友的印象</b> <button class="small" data-action="clear" data-cat="memberImpression">清空</button>';
  const names = Object.keys(impressions);
  if (!names.length) html += '<div class="meta">（空）</div>';
  for (const name of names) {
    const im = impressions[name] || {};
    const traits = Array.isArray(im.traits) ? im.traits : [];
    html += `<div style="margin:4px 0">👤 ${esc(name)}：${traits.length ? esc(traits.join('、')) : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次） <button class="small" data-action="edit" data-cat="memberImpression" data-target="${esc(name)}" data-traits="${esc(traits.join(', '))}">编辑</button> <button class="small" data-action="remove" data-cat="memberImpression" data-target="${esc(name)}">删除</button></div>`;
  }
  html += '</div></div>';
  box.innerHTML = html;
}
function loadV2Memory() {
  const key = document.getElementById('v2MemoryKey').value.trim();
  const msg = document.getElementById('v2MemoryMsg');
  if (!key) { msg.textContent = '请输入会话 key'; msg.className = 'meta err'; return; }
  msg.textContent = '加载中…';
  msg.className = 'meta';
  return api('/api/socialV2/memory?key=' + encodeURIComponent(key))
    .then(r => {
      renderV2Memory(r);
      msg.textContent = r.ok ? '✅ 已加载' : ('❌ ' + (r.error || '失败'));
      msg.className = r.ok ? 'meta ok' : 'meta err';
    })
    .catch(e => {
      msg.textContent = '❌ ' + (e.message || e);
      msg.className = 'meta err';
    });
}
document.getElementById('v2MemoryLoad').addEventListener('click', loadV2Memory);
document.getElementById('v2MemoryClearAll').addEventListener('click', async () => {
  const key = document.getElementById('v2MemoryKey').value.trim();
  const msg = document.getElementById('v2MemoryMsg');
  if (!key) { msg.textContent = '请输入会话 key'; msg.className = 'meta err'; return; }
  if (!confirm('确定清空该会话全部轻量记忆？')) return;
  const r = await api('/api/socialV2/memory-clear', 'POST', { key, category: '' });
  msg.textContent = r.ok ? '✅ 已清空全部记忆' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) loadV2Memory();
});
document.getElementById('v2MemoryOutput').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const key = document.getElementById('v2MemoryKey').value.trim();
  const msg = document.getElementById('v2MemoryMsg');
  if (!key) { msg.textContent = '请输入会话 key'; msg.className = 'meta err'; return; }
  const cat = btn.dataset.cat;
  const action = btn.dataset.action;
  let r;
  if (action === 'clear') {
    r = await api('/api/socialV2/memory-clear', 'POST', { key, category: cat });
  } else if (action === 'edit') {
    let newContent;
    let newExtra = {};
    if (cat === 'memberImpression') {
      const input = prompt(`编辑对 ${btn.dataset.target} 的印象特质（逗号分隔）：`, btn.dataset.traits || '');
      if (input === null) return;
      newContent = input;
    } else {
      const input = prompt(`编辑${cat === 'activeTopic' ? '话题' : '想法'}内容：`, btn.dataset.content || '');
      if (input === null) return;
      newContent = input;
    }
    r = await api('/api/socialV2/memory-update', 'POST', { key, category: cat, oldContent: btn.dataset.content || '', target: btn.dataset.target || '', newContent, newExtra });
  } else {
    r = await api('/api/socialV2/memory-remove', 'POST', { key, category: cat, content: btn.dataset.content || '', target: btn.dataset.target || '' });
  }
  msg.textContent = r.ok ? '✅ 已更新' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) loadV2Memory();
});

function formatWakeStatus(r) {
  if (!r || !r.ok) return '<span class="meta">加载失败</span>';
  const wc = r.wakeConfig || {};
  const lines = [];
  const mode = wc.mode === 'active' ? '活跃（任何消息都会唤醒）' : (wc.mode === 'diving' ? '潜水' : (wc.mode || '未知'));
  lines.push(`<div><b>模式：</b>${esc(mode)}</div>`);
  lines.push(`<div><b>无限期：</b>${wc.infinite ? '是' : '否'}</div>`);
  const safety = r.wakeSafety || {};
  const badge = safety.guaranteed ? '🟢 已保证' : '🔴 无保证';
  lines.push(`<div><b>唤醒保证：</b>${badge}${safety.stale ? '（配置较旧，未确认）' : ''}</div>`);
  let next = '';
  if (wc.mode === 'active' || wc.triggers?.anyMessage) {
    next = '任何新消息都会唤醒';
  } else if (wc.sleepUntil) {
    const until = new Date(wc.sleepUntil).getTime();
    const remain = until - Date.now();
    if (!Number.isFinite(remain)) next = '时间格式无效';
    else if (remain > 0) next = `约 ${Math.max(1, Math.round(remain / 1000))} 秒后（${new Date(wc.sleepUntil).toLocaleString()}）`;
    else next = '已到期，等待下一次唤醒';
  } else if (wc.infinite) {
    next = '无限期潜水，等待指定条件';
  } else {
    next = '未设置时间';
  }
  lines.push(`<div><b>下次唤醒：</b>${esc(next)}</div>`);
  const tr = wc.triggers || {};
  const conds = [];
  if (tr.atMention) conds.push('@');
  if (tr.nameMention) conds.push('名字');
  if (Array.isArray(tr.keywords) && tr.keywords.length) conds.push('关键词：' + tr.keywords.join('、'));
  if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) conds.push('指定成员：' + tr.speakerIds.join('、'));
  if (tr.question) conds.push('提问');
  if (tr.poke) conds.push('拍一拍');
  if (tr.anyMessage) conds.push('任何消息');
  if (Number(tr.probability) > 0) conds.push('普通消息概率 ' + Number(tr.probability));
  lines.push(`<div><b>提前唤醒条件：</b>${conds.length ? esc(conds.join('；')) : '（无）'}</div>`);
  lines.push(`<div><b>最近唤醒原因：</b>${esc(r.lastWakeReason || '-')}</div>`);
  lines.push(`<div><b>唤醒次数：</b>${Number(wc.wakeCount) || 0}</div>`);
  if (wc.confirmedAt) {
    const ago = Math.max(0, Math.round((Date.now() - wc.confirmedAt) / 60000));
    lines.push(`<div><b>配置确认：</b>${ago} 分钟前（${esc(wc.confirmedBy || 'unknown')}）</div>`);
  }
  if (r.lastAiReplyAt) {
    const ago = Math.max(0, Math.round((Date.now() - r.lastAiReplyAt) / 60000));
    lines.push(`<div><b>上次发言：</b>${ago} 分钟前</div>`);
  }
  lines.push(`<div><b>未读：</b>${Number(r.unreadCount) || 0} 条</div>`);
  return '<div style="padding:8px">' + lines.join('') + '</div>';
}
function loadV2WakeStatus() {
  const key = document.getElementById('v2WakeKey').value.trim();
  const msg = document.getElementById('v2WakeStatusMsg');
  if (!key) { msg.textContent = '请输入会话 key'; msg.className = 'meta err'; return; }
  msg.textContent = '加载中…';
  msg.className = 'meta';
  return api('/api/socialV2/state?key=' + encodeURIComponent(key))
    .then(r => {
      document.getElementById('v2WakeStatusOutput').innerHTML = formatWakeStatus(r);
      msg.textContent = r.ok ? '✅ 已加载' : ('❌ ' + (r.error || '失败'));
      msg.className = r.ok ? 'meta ok' : 'meta err';
    })
    .catch(e => {
      msg.textContent = '❌ ' + (e.message || e);
      msg.className = 'meta err';
    });
}
document.getElementById('v2WakeStatusLoad').addEventListener('click', loadV2WakeStatus);

async function loadV2SessionOptions() {
  const sel = document.getElementById('v2SessionSelect');
  const prev = sel.value;
  try {
    const r = await api('/api/status');
    const groups = Array.isArray(r.allowGroups) ? r.allowGroups : [];
    const privates = Array.isArray(r.allowPrivate) ? r.allowPrivate : [];
    const options = [{ value: '', label: '选择白名单群/私聊…' }];
    for (const g of groups) options.push({ value: 'group:' + g, label: '群 ' + g });
    for (const p of privates) options.push({ value: 'private:' + p, label: '私聊 ' + p });
    sel.innerHTML = options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
    if (prev && options.some((o) => o.value === prev)) sel.value = prev;
  } catch (e) {
    sel.innerHTML = '<option value="">无法加载白名单</option>';
  }
}
document.getElementById('v2SessionRefresh').addEventListener('click', loadV2SessionOptions);
document.getElementById('v2SessionSelect').addEventListener('change', (ev) => {
  const key = ev.target.value;
  if (!key) return;
  document.getElementById('v2StateKey').value = key;
  document.getElementById('v2MemoryKey').value = key;
  document.getElementById('v2WakeKey').value = key;
});

// 07 参数分页：只切换显示，不迁移 DOM，所有 load/save 的 id 保持原样。
function setV2Tab(tab) {
  document.querySelectorAll('.v2-tab').forEach((btn) => {
    const on = btn.dataset.v2Tab === tab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.v2-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.v2Panel === tab);
  });
}
document.querySelectorAll('.v2-tab').forEach((btn) => {
  btn.addEventListener('click', () => setV2Tab(btn.dataset.v2Tab));
});
setV2Tab('wait');

document.getElementById('v2ConfigSave').addEventListener('click', saveV2Config);
document.getElementById('v2ConfigSaveTop').addEventListener('click', saveV2Config);
document.getElementById('v2StickerSyncLocal')?.addEventListener('click', async () => {
  const btn = document.getElementById('v2StickerSyncLocal');
  const msg = document.getElementById('v2StickerSyncLocalMsg');
  if (!btn || !msg) return;
  btn.disabled = true;
  msg.textContent = '同步中…';
  try {
    const r = await api('/api/stickers/sync', 'POST', {});
    if (!r?.ok) throw new Error(r?.error || '同步失败');
    msg.textContent = `已同步 ${Number(r.total) || 0} 个收藏表情到本地`;
    msg.className = 'meta ok';
  } catch (error) {
    msg.textContent = `同步失败：${error?.message || error}`;
    msg.className = 'meta err';
  } finally {
    btn.disabled = false;
  }
});
async function refreshV2Activity() {
  try {
    const r = await api('/api/socialV2/activity');
    const el = document.getElementById('v2ActivityStatus');
    el.textContent = r.paused ? '已暂停' : '运行中';
    el.className = r.paused ? 'meta err' : 'meta ok';
  } catch {}
}
document.getElementById('v2PauseBtn').addEventListener('click', async () => {
  await api('/api/socialV2/activity', 'POST', { paused: true });
  refreshV2Activity();
});
document.getElementById('v2ResumeBtn').addEventListener('click', async () => {
  await api('/api/socialV2/activity', 'POST', { paused: false });
  refreshV2Activity();
});
document.getElementById('v2ResetBtn').addEventListener('click', async () => {
  if (!confirm('确定重置二代 AI 状态？\n将清空所有二代会话、唤醒配置、未读消息和定时器；工具调用日志会保留。')) return;
  const r = await api('/api/socialV2/reset', 'POST', {});
  const msg = document.getElementById('v2ConfigMsg');
  msg.textContent = r.ok ? '✅ 已重置二代状态' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  refreshV2Activity();
  document.getElementById('v2AllStatesOutput').textContent = '（全部会话状态：空）';
  document.getElementById('v2StateOutput').textContent = '（空）';
});
document.getElementById('v2StateView').addEventListener('click', viewV2State);
document.getElementById('v2ForceWake').addEventListener('click', async () => {
  const key = document.getElementById('v2StateKey').value.trim();
  if (!key) { alert('请输入会话 key'); return; }
  const r = await api('/api/socialV2/wake', 'POST', { key, reason: 'admin' });
  const msg = document.getElementById('v2ConfigMsg');
  msg.textContent = r.ok ? '✅ 已发送唤醒' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
});
document.getElementById('v2StatesList').addEventListener('click', async () => {
  const r = await api('/api/socialV2/states');
  document.getElementById('v2AllStatesOutput').textContent = JSON.stringify(r.conversations || [], null, 2);
});
document.getElementById('v2FeedbackLoad').addEventListener('click', async () => {
  const r = await api('/api/socialV2/feedback');
  document.getElementById('v2FeedbackOutput').textContent = JSON.stringify(r.entries || [], null, 2);
});
document.getElementById('v2FeedbackClear').addEventListener('click', async () => {
  if (!confirm('确定清空全部 AI 反馈？')) return;
  const r = await api('/api/socialV2/feedback-clear', 'POST', {});
  const msg = document.getElementById('v2FeedbackMsg');
  msg.textContent = r.ok ? '✅ 已清空' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) document.getElementById('v2FeedbackOutput').textContent = '（空）';
});
document.getElementById('v2ToolLogLoad').addEventListener('click', async () => {
  const msg = document.getElementById('v2ToolLogMsg');
  msg.textContent = '';
  await loadV2ToolLog();
});
document.getElementById('v2ToolLogClear').addEventListener('click', async () => {
  if (!confirm('确定清空全部工具调用日志？')) return;
  const r = await api('/api/socialV2/tool-log/clear', 'POST', {});
  const msg = document.getElementById('v2ToolLogMsg');
  msg.textContent = r.ok ? '✅ 已清空' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  renderV2ToolLog([]);
});

// 只在页面加载/保存成功后填充输入框（避免自动刷新覆盖用户正在编辑的值）

  await loadV2Config();
  await refreshV2Activity();
  await loadV2ToolLog();
  await loadV2SessionOptions();
}
