import {
  createSlangMcpServices, createMediaMcpServices, createBiliMcpServices,
  createImagesMcpServices, createStickersMcpServices, createTtsMcpServices,
  createUpscaleMcpServices, createXPostsMcpServices
} from './plugins/mcp-bridge-services.js';
import { createProcessPluginRuntime } from './plugins/process-runtime.js';
// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SENSITIVE_RE } from './sensitive.js';
import { gifFramesHint } from './gif-frames.js';
import { emojiMenuText } from './emoji-react.js';
import { normalizeMessagesInput } from './pipeline/text-normalize.js';
import { bindPluginToolAvailability } from './plugins/tool-availability.js';
import { bindToolResultBudget } from './tool-result-budget.js';
import { summarizeToolSurface } from './tool-surface.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();
const localPlugins = await createProcessPluginRuntime({ root: ROOT, only: ['upscale', 'slang', 'media-tools', 'bili', 'images', 'stickers', 'tts', 'x-posts'], services: { mcp: { slang: createSlangMcpServices(agentApi), 'media-tools': createMediaMcpServices(agentApi), bili: createBiliMcpServices(agentApi), images: createImagesMcpServices(agentApi), stickers: createStickersMcpServices(agentApi), tts: createTtsMcpServices(agentApi), upscale: createUpscaleMcpServices(agentApi), 'x-posts': createXPostsMcpServices(agentApi) } }, log: message => console.error(message) });

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 构造可选的“引用/回复”消息段：
// - 传了 replyToMessageId 时，在文本前追加 reply 段，让 QQ 显示“引用了某条消息”；
// - 使用结构化消息段而不是 CQ 码，避免注入；
// - replyToMessageId 必须是非零整数（字符串数字也接受；QQ 消息 id 可能为负数）。
function messageSegments(message, replyToMessageId) {
  const segments = [];
  const replyId = replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== ''
    ? String(replyToMessageId).trim()
    : null;
  if (replyId !== null) {
    if (!/^-?[1-9]\d*$/.test(replyId)) {
      throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
    }
    segments.push({ type: 'reply', data: { id: replyId } });
  }
  segments.push({ type: 'text', data: { text: escapeCqText(String(message ?? '')) } });
  return segments;
}

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  try {
    const c = getConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(rest.headers ?? {})
  };
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(body?.error || `桥接 API HTTP ${res.status}`);
  }
  return body;
}

async function authorizeRead(key, token) {
  await agentApi('/api/authorize/read', { method: 'POST', body: JSON.stringify({ key, token: token || undefined }) });
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.7.1' });
// T4：工具结果按工具预算裁剪（先包 handler，再交给可见性绑定）。
bindToolResultBudget(server, { log: message => console.error(message) });
const pluginToolAvailability = bindPluginToolAvailability(server, {
  readPlugins: async () => {
    const response = await fetch(`${agentApiBase()}/api/plugins`, {
      headers: { 'x-console-token': readConsoleToken() }, signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) throw new Error('Plugin availability unavailable');
    return (await response.json()).plugins;
  }
});

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: JSON.stringify({ ...login, online: status.online, good: status.good }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token；reserved2 模式下通过桥接 /api/status 直接拒绝，
    // 避免绕过二代仿真模式的令牌隔离。
    try {
      const status = await agentApi('/api/status');
      if (status?.mode === 'reserved2') {
        return { content: [{ type: 'text', text: 'reserved2 模式下旧只读工具不可用，请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_members',
  '列出指定群的成员列表（只读）：QQ 号、昵称、群名片。',
  { groupId: z.union([z.number(), z.string()]).describe('群号') },
  async ({ groupId }) => {
    const g = String(groupId);
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中。白名单：${a.allowGroups.join(', ') || '（空）'}` }], isError: true };
    }
    try { await authorizeRead(`group:${g}`); } catch (error) {
      return { content: [{ type: 'text', text: `拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const list = (Array.isArray(data) ? data : (data?.data ?? [])).map((m) => ({ user_id: m.user_id, nickname: m.nickname, card: m.card }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中。白名单：${a.allowGroups.join(', ') || '（空）'}` }], isError: true };
    }
    try { await authorizeRead(`group:${g}`); } catch (error) {
      return { content: [{ type: 'text', text: `拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id。**优先传 messageId**（qq_get_unread_messages / qq_get_recent_messages 返回的真实 QQ 消息 id）；传 seq 也可以，桥接会自动换算。**不确定是哪条就传 latest**（等价于「最近一条别人的消息」），不要自己猜编号——猜错的编号照样能解析到另一条真实消息，会静默引用错。'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        headers: token ? { 'x-agent-token': token } : {},
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。适合群消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。传 messageId（真实 QQ id）最稳；传本会话的 seq 也可以，桥接会自动换算。二代模式下这是你正常可用的引用工具，但不要每条都引用。只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。reserved2 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id：优先传 messageId（真实 QQ 消息 id）；传本会话的 seq 亦可，桥接会自动换算。**不确定是哪条就传 latest**（= 最近一条别人的消息），别自己猜编号'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        headers: token ? { 'x-agent-token': token } : {},
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id。**优先传 messageId**（qq_get_unread_messages / qq_get_recent_messages 返回的真实 QQ 消息 id）；传 seq 也可以，桥接会自动换算。**不确定是哪条就传 latest**（等价于「最近一条别人的消息」），不要自己猜编号——猜错的编号照样能解析到另一条真实消息，会静默引用错。'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        headers: token ? { 'x-agent-token': token } : {},
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。默认 compact：返回角色摘要与工具清单，唤醒提示里已有的状态不重复；需要完整角色卡/推荐值/记忆/黑话/表情上下文时传 detail="full"。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    detail: z.enum(['compact', 'full']).optional().describe('默认 compact（角色摘要+工具+唤醒配置）；full 返回完整角色卡与推荐值/记忆/黑话/表情上下文')
  },
  async ({ key, token, detail }) => {
    try {
      const q = new URLSearchParams({ key });
      if (detail) q.set('detail', detail);
      const data = await agentApi(`/api/socialV2/prompt?${q}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看指定会话的未读消息（只读，不自动标记已读）。默认只取最近 8 条（小窗口，省上下文）；消息多时先看这 8 条，确实不够再用 limit 扩大（最大 100）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'), limit: z.number().optional().describe('最多返回条数，默认 8（小窗口），最大 100；不够再显式扩大') },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 8}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读）。默认只取最近 8 条（小窗口，省上下文），支持 offset 向前翻页：不够就 offset=8、16… 显式扩大，不要一次性拉几十条。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 8（小窗口），最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0；不够就按 8 递增翻页')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 8}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话的当前未读消息标记为已读（用于“看过但决定不回复”后避免重复未读）。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后**有人拍你**一定会唤醒你（必须回应）；拍别人也会给一次低优先级提醒，看一眼即可。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（拍你时一定唤醒并且必须回应；拍别人只作低优先级提醒。私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      const finalMessages = normalizeMessagesInput(messages);
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id。**优先传 messageId**（qq_get_unread_messages / qq_get_recent_messages 返回的真实 QQ 消息 id）；传 seq 也可以，桥接会自动换算。**不确定是哪条就传 latest**（等价于「最近一条别人的消息」），不要自己猜编号——猜错的编号照样能解析到另一条真实消息，会静默引用错。'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      const finalMessages = normalizeMessagesInput(messages);
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。\n\n'
    + '【targetUserId 怎么填】群聊必填，三种都行：\n'
    + '  - 数字 QQ 号（最准）；\n'
    + '  - `latest` —— **最近戳你的那个人**，桥接会自己解析（要回拍时优先用它，省得记号码）；\n'
    + '  - 对方在本群的昵称（如 "群友C"）；桥接会在本会话消息里换算，同名多人时会拒绝并让你改用号码。\n'
    + '**绝对不要凭记忆填一个旧号**：填错就会拍到不相干的人身上（真实事故：反复拍同一个群友十几次）。\n'
    + '私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍谁：QQ 号 / 昵称 / "latest"（最近戳你的人）三选一；群聊必填，私聊可选')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// 表情回应（由你自主决定）：给某条群消息贴一个 QQ 表情。
if (cfg.socialV2?.tools?.reactMessage !== false) {
  server.tool(
    'qq_react_message',
    `给一条群消息贴上 QQ 表情回应（不产生新消息，只在对方那条消息下方留一个表情）。\n\n【它适合什么】当你"看到了、也认同/觉得好笑/想表示收到了"，但**不值得单独发一条消息**时说——真人潜水时也常这么干。典型场合：群友说了个不错的观点、发了好笑的图/梗、分享了好东西、或者只是想让对方知道"我看到了"。\n\n【它不是万能的，别滥用】这是"轻量参与"，不是回话的替代品。以下情况**不要**用它，该正经说话：\n- 有人点名/@你、引用你、问你问题 → 直接回话，贴表情会显得敷衍。\n- 群友在倾诉、难过、吵架、说正事 → 贴表情（尤其笑脸）是冒犯。这种情况要么认真回应，要么保持安静。\n- 你自己刚发过消息 → 别紧接着又贴表情，像在刷存在感。\n- 同一条消息别重复贴；同一会话两次贴表情之间至少间隔 1 分钟（桥接会限流并返回原因）。\n\n【怎么选表情】优先用下面这些（id=名字（适合））：${emojiMenuText()}\n也可以传其它合法的 QQ 内置表情 id（1~5 位数字）。**不确定 id 对不对时优先用上面这些**，写错了桥接会拒绝并提示。\n\n【怎么指定消息】messageId 用 \`qq_get_unread_messages\` / \`qq_get_recent_messages\` 返回值里的 messageId（**不是** seq，那是本地序号）。目标是较新的消息——太旧的已不在 QQ 缓存里会失败。\n\n【撤销】传 set=false 可撤掉自己贴的表情（撤销不受频率限制）。`,
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.union([z.number(), z.string()]).describe('要贴表情的消息 id（来自 qq_get_unread_messages / qq_get_recent_messages 的 messageId 字段，可为负数）'),
      emojiId: z.string().describe(`表情 id，如 "76"（赞）。推荐：${emojiMenuText().slice(0, 120)}…`),
      set: z.boolean().optional().describe('可选：true=贴（默认），false=撤销')
    },
    async ({ key, token, messageId, emojiId, set }) => {
      try {
        const data = await agentApi('/api/socialV2/react-message', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), emojiId, ...(set === false ? { set: false } : {}) }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `贴表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等待群友消息：可指定“静默窗口”来判断对方是否说完了。收到新消息后如果还想要更多上下文，设置 quietMs（例如 10000~20000）继续等一小段没有新消息的时间；桥接会强制至少等后台“收到新消息后最小静默”（默认 10000ms=10 秒）再返回，防止抢话。返回 timeout=true 表示这段时间内没有等到新消息/没人说话，这不是错误；可以再用 qq_get_unread_messages / qq_get_recent_messages 查看是否有新消息，再决定继续等、发言或潜水。沉睡前观察：准备设置潜水/下一次唤醒前，必须用 timeoutMs=300000 发起一次完整观察（短等待不会满足沉睡前观察）。如果全程没人说话，返回 preSleepWaitSatisfied=true；如果等待期间等到新消息，会返回 preSleepWaitObserved=true 和 newMessages，表示你已完成一次沉睡前观察，查看后认为不需要你参与即可直接设置潜水。响应里还会给出 preSleepWaitRemainingMs，帮助你判断还差多久。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    timeoutMs: z.number().optional().describe('总等待毫秒数；普通等待默认 30000，沉睡前观察请传 300000（最大 600000）'),
    minNewMessages: z.number().optional().describe('至少等到多少条新消息才提前返回，默认 1'),
    quietMs: z.number().optional().describe('检测到新消息后继续等待的静默窗口（毫秒），用于判断对方是否说完了；建议 8000~12000，默认取 socialV2.wait.defaultQuietMs（当前 8000）')
  },
  async ({ key, token, timeoutMs, minNewMessages, quietMs }) => {
    try {
      const data = await agentApi('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id 查看单条消息的完整内容、发送者、引用信息（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── B 站：自己刷 / 看群友发的链接 / 全局观看记忆 ─────────────────────────────
//
// 记忆是**全局的**（跨群共用）：现有 activeTopic 那些是群聊上下文，按群隔离是对的；
// 但"我喜欢看什么视频"是机器人自己的偏好，与群无关（2026-10-19 用户选定）。
server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_recall_memory',
  '按当前话题检索历史记忆（journal 消息 + episode 摘要），返回带时间/发送者/seq 的证据。群友问“之前/上次/那天说过什么”、需要回忆旧约定或人物关系时调用；比 qq_memory_query 的轻量记忆更完整。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    query: z.string().describe('检索关键词或自然语言问题，例如“上次说的拔牙低烧”“谁喜欢原神”'),
    limit: z.number().optional().describe('返回条数，默认 6，最多 20'),
    from: z.string().optional().describe('可选起始时间：毫秒时间戳或 ISO 日期'),
    to: z.string().optional().describe('可选结束时间：毫秒时间戳或 ISO 日期')
  },
  async ({ key, token, query, limit, from, to }) => {
    try {
      const q = new URLSearchParams({ key, q: query, limit: String(limit ?? 6) });
      if (from) q.set('from', String(from));
      if (to) q.set('to', String(to));
      const data = await agentApi(`/api/socialV2/recall?${q.toString()}`, {
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆检索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

for (const tool of localPlugins.mcpTools()) {
  server.tool(tool.name, tool.description, tool.inputSchema, tool.handler);
}

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情]、hasMedia=true，或**引用的消息里含图片**时调用（引用文案会写明「被引用的这条消息含 N 个图片/表情，消息ID=xxx」——那种情况也要调本工具、messageId 传被引用的那个 id，才能看到图）。支持一条消息里的多张图片/表情，也能取**别人发的**消息（会向 QQ 回源查询）；二代模式下必须携带会话令牌。\n\n【分享卡片的封面】群友分享的 B 站视频/小红书/音乐等卡片，文本会写成 `[哔哩哔哩卡片] 标题：链接` 这类形式。这类消息 hasMedia=true，里面的图就是**卡片封面**——想看封面长什么样（例如判断视频内容、看封面上的信息）就调本工具，和看普通图片一样。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          const kindLabel = img.kind === 'face' ? '表情' : '图片';
          if (img?.data && img?.mimeType) {
            // 动图：桥接已抽帧拼成一张图（模型直接看 GIF 只有第一帧）。文案与桥接共用，
            // 保证「连续动作、同一对象」这个关键措辞一致。
            // cols/rows 要一起传：多行拼图必须说明"读完一行再读下一行"，
            // 否则模型会按横向一路读下去、把第二行当成更晚的独立事件。
            if (img.animated) {
              textParts.push(gifFramesHint(img.index ?? '', {
                kept: img.framesKept,
                frames: img.frames,
                cols: img.cols,
                rows: img.rows
              }));
            } else {
              textParts.push(`[${kindLabel}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            }
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${kindLabel}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );


}

// 按需爬网页 / 找图 / 把图片存成 QQ 收藏表情。
// 只走桥接的 /api/socialV2/crawl（safe-fetch：禁内网、逐跳校验），不绕过登录。
if (cfg.socialV2?.tools?.crawl !== false && cfg.socialV2?.crawl?.enabled !== false) {
  server.tool(
    'qq_crawl_web',
    '按需抓取网页或图站：看某个链接里的内容（mode=text）、找图片（mode=images）、或把图片直接存进你的 QQ 收藏表情（mode=stickers + saveStickers=true）。\n\n'
    + '【什么时候用】群友让你看某个链接里写了什么、让你找表情包/梗图、或你确实需要网页内容才能回答时。不要主动连续爬站。\n'
    + '【aigengtu】可以只传 query（角色/梗/关键词）或 category，不必传 url；它会从公开图库里挑图。\n'
    + '【存表情】每次最多 3 张，默认 20 张/天；重复的图会自动跳过。存完用 qq_list_stickers 查看，再用 qq_send_sticker 发。\n'
    + '【边界】需要登录/验证码/已失效的页面（小红书等）打不开时如实告诉群友，不要编造内容，也不要尝试绕过登录或风控。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      url: z.string().optional().describe('要抓取的 http(s) 网页；aigengtu 可省略'),
      query: z.string().optional().describe('搜索关键词/角色/梗；aigengtu 用它筛图'),
      category: z.string().optional().describe('aigengtu 分类名，如 DeepSeek娘'),
      mode: z.enum(['text', 'images', 'stickers']).optional().describe('text=看网页；images=找图；stickers=存入收藏表情'),
      limit: z.number().int().min(1).max(30).optional().describe('最多返回/处理几张；存表情时最多 5'),
      saveStickers: z.boolean().optional().describe('mode=stickers 的简写'),
      dryRun: z.boolean().optional().describe('只下载并校验，不写入 QQ 收藏表情（测试用）')
    },
    async ({ key, token, url, query, category, mode, limit, saveStickers, dryRun }) => {
      try {
        const payload = { key };
        if (url) payload.url = String(url);
        if (query) payload.query = String(query);
        if (category) payload.category = String(category);
        if (mode) payload.mode = mode;
        if (limit != null) payload.limit = Number(limit);
        if (saveStickers != null) payload.saveStickers = saveStickers === true;
        if (dryRun != null) payload.dryRun = dryRun === true;
        const data = await agentApi('/api/socialV2/crawl', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token },
          // 下载+转码+入库可能超过 60 秒，给足
          timeoutMs: 120000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '看自己的形象图，**并且默认同时把它发到当前会话**（群友会直接看到这张图）。\n\n'
    + '【什么时候调】群友问「你长什么样」「发张自拍」「看看你」「你是什么形象」「来张照片」这类话时必须调它——'
    + '**这是长相的唯一依据**，看图前不要凭想象描述自己，也别提「人设」「系统给我配的」这类说法。\n'
    + '【关键：图会自己发出去】publish 默认 true，你调完这张图就已经在群里了。'
    + '所以**不要**再调 qq_send_image 发一次（那是从图库挑图，发不到这张），也不要再复述「我给你发一张」，'
    + '看图后像人一样自然接一句话就够（比如「喏」「就长这样」「别笑」）。\n'
    + '【不想发时才传 publish=false】只有一种情况：你自己想确认长相但对方没要图（例如有人描述了一个形象、你想核对）。'
    + '群友明确要「发张自拍」时千万不要传 false——他要的是图，不是文字描述。\n'
    + '【返回值看 sent / sendError】sent 有值说明已经发出去了；sendError 有值说明**没发出去**'
    + '（比如静默模式或暂停中），这时要如实说「图没发出去」或找个台阶，不要假装发了。\n'
    + '【别刷图】同一个会话刚发过就别反复发；对方只是开玩笑喊你两句（没真要图）可以不调。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      publish: z.boolean().optional().describe('是否顺手把这张图发到当前会话。默认 true（群友要自拍时必须保持默认）')
    },
    async ({ key, token, publish }) => {
      try {
        const data = await agentApi('/api/socialV2/self-image', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, publish: publish !== false })
        });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${data?.error || '未知'}` }], isError: true };
        }
        // 发给模型的话术跟着实际结果走：绝不能让它以为发了、实际没发。
        let note;
        if (data.published) {
          note = data.sendError
            ? `（注意：这次图片**没能发出去**——${data.sendError}。请不要说「图发你了」，如实说明或换个说法。）`
            : '（这张图已经发到当前会话了，群友看得见。不要再调 qq_send_image 重复发，也别复述"我给你发一张"。）';
        } else {
          note = '（这次只给你自己看，没有发到群里。如果对方要的是「发张自拍」，请重新调一次并把 publish 设为 true。）';
        }
        return {
          content: [
            { type: 'text', text: `这是你现在的形象${note}` },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 群文件（只读分类）──────────────────────────────────────────────────────
// 只读：列文件、统计分类、搜索。**没有**删除/移动/上传/改名 —— 那是高危能力，
// 未纳入工具（写操作 API 确实存在且会真实执行，但群文件删了不可恢复）。
if (cfg.socialV2?.tools?.groupFiles !== false) {
  server.tool(
    'qq_list_group_files',
    '查看当前群的群文件（只读）。当群友问「群里有什么文件」「有没有那个 xx 资料」「群里多少 PDF」「谁传的文件最多」时用它。\n'
    + '两种用法：\n'
    + '① 不传参数 → 返回整体分类摘要：按类型（文档/图片/音视频/压缩包/程序…）、'
    + '按上传者、最近新增、最大的几个、重名情况。适合回答"群里都有什么"。\n'
    + '② 传 keyword / category / ext / uploader 之一来搜索具体文件。适合回答"有没有那个面谈资料"。\n'
    + '**只看不改**：本工具不会删除、移动或上传任何文件。如果群友要你删/整理文件，如实说这个能力没开，不要假装做了。',
    {
      key: z.string().describe('会话 key，格式 group:群号（群文件只适用于群会话）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      keyword: z.string().optional().describe('按文件名关键词搜索（如「面谈」「习题」）'),
      category: z.string().optional().describe('按分类筛选：文档 / 图片 / 音视频 / 压缩包 / 程序 / 代码 / 素材 / 其他'),
      ext: z.string().optional().describe('按扩展名筛选（如 pdf、docx、mp4）'),
      uploader: z.string().optional().describe('按上传者昵称筛选（部分匹配）'),
      minBytes: z.number().optional().describe('只看大于该字节数的文件'),
      limit: z.number().optional().describe('最多返回几条（默认 20，上限 50）')
    },
    async ({ key, token, keyword, category, ext, uploader, minBytes, limit }) => {
      try {
        const hasQuery = Boolean(keyword || category || ext || uploader || minBytes);
        const q = new URLSearchParams({ key, mode: hasQuery ? 'search' : 'summary' });
        if (keyword) q.set('keyword', String(keyword));
        if (category) q.set('category', String(category));
        if (ext) q.set('ext', String(ext));
        if (uploader) q.set('uploader', String(uploader));
        if (minBytes) q.set('minBytes', String(minBytes));
        if (limit) q.set('limit', String(limit));
        const data = await agentApi(`/api/socialV2/group-files?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `读取群文件失败：${data?.error || '未知原因'}` }], isError: true };
        }
        if (data.mode === 'search') {
          if (!data.matched) {
            return { content: [{ type: 'text', text: `没有匹配的群文件（条件：${JSON.stringify(data.query)}）。可以换个关键词，或先用不带参数的方式看整体分类。` }] };
          }
          const lines = data.entries.map((e) => `- ${e.name}（${e.sizeText}，${e.date}，${e.uploader}）`);
          return { content: [{ type: 'text', text: `匹配 ${data.matched} 个，显示前 ${data.returned} 个：\n${lines.join('\n')}` }] };
        }
        return { content: [{ type: 'text', text: data.text || '（无内容）' }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取群文件失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_group_file_stats',
    '查看群文件的**容量**信息（只读）：已用/总空间、文件数、文件数上限。'
    + '当群友问「群文件满了吗」「还能传多少」时用它。只想看文件清单/分类请用 qq_list_group_files。',
    {
      key: z.string().describe('会话 key，格式 group:群号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const d = await agentApi(`/api/socialV2/group-file-stats?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        if (!d?.ok) return { content: [{ type: 'text', text: `读取容量失败：${d?.error || '未知原因'}` }], isError: true };
        const pct = d.usedPercent != null ? `${d.usedPercent}%` : '未知';
        return {
          content: [{
            type: 'text',
            text: `群文件容量：已用 ${d.usedText} / ${d.totalText}（${pct}）；文件数 ${d.fileCount}${d.limitCount ? ` / 上限 ${d.limitCount}` : ''}。`
          }]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取容量失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

await pluginToolAvailability.refresh();
server.server.onclose = () => { void localPlugins.stop(); };
await server.connect(new StdioServerTransport());

// T2：工具面计量。每次可见工具集合变化（插件可用性/业务开关）时落盘，
// 供控制台/报表对比 T2-T5 的 schema 体积；相同集合不重复写，避免每 2 秒刷盘。
let lastSurfaceKey = '';
function writeToolSurface() {
  try {
    const summary = summarizeToolSurface(pluginToolAvailability.enabledTools());
    const key = `${summary.count}:${summary.totalChars}`;
    if (key === lastSurfaceKey) return;
    lastSurfaceKey = key;
    const dir = path.join(ROOT, 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tool-surface.json'), JSON.stringify({
      at: new Date().toISOString(),
      count: summary.count,
      totalChars: summary.totalChars,
      estimatedTokens: summary.estimatedTokens,
      largest: summary.largest,
      tools: summary.tools.map((t) => t.name)
    }, null, 2) + '\n');
    console.error(`[tool-surface] 可见工具 ${summary.count} 个 / ${summary.totalChars} 字符（约 ${summary.estimatedTokens} tokens）`);
  } catch { /* 计量失败不影响 MCP 主流程 */ }
}
writeToolSurface();
// 桥接可晚于 MCP 启动；利用 SDK 的 tools/list_changed 同步恢复/撤销。
setInterval(() => { void pluginToolAvailability.refresh().then(writeToolSurface, () => {}); }, 2000).unref();
