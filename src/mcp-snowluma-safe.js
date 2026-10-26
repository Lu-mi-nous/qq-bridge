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

/**
 * 语音合成是否真的可用（只 stat 文件，不启动任何进程）。
 *
 * 为什么在 MCP 侧也探一次、而不是直接问桥接：
 * 工具**注册时机**必须在 MCP 启动时决定（注册了就一直在，不能运行时增删）。
 * 桥接可能还没起来，而且这里只要一个布尔值——按 tts.js 的同一套规则
 * stat 几个必需文件即可，几十微秒。
 *
 * 探测失败 → 工具不注册 → 模型看不到 → 不会承诺做不到的能力。
 */
function sovitsAvailable() {
  try {
    const c = cfg.socialV2?.tts ?? {};
    const dir = String(c.dir || 'E:\\Downloads\\GPT-SoVITS');
    const p = (rel) => (path.isAbsolute(rel) ? rel : path.join(dir, rel));
    const need = [
      p(c.gptModel || 'GPT_SoVITS/dania-e15.ckpt'),
      p(c.sovitsModel || 'GPT_SoVITS/dania_e16_s2192.pth'),
      p(c.refAudio || 'GPT_SoVITS/output/slicer_opt/output.wav_0009342720_0009558400.wav'),
      path.join(dir, 'GPT_SoVITS', 'pretrained_models', 'chinese-hubert-base'),
      path.join(dir, 'GPT_SoVITS', 'pretrained_models', 'chinese-roberta-wwm-ext-large')
    ];
    return need.every((f) => { try { return fs.existsSync(f); } catch { return false; } });
  } catch {
    return false;
  }
}

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

const server = new McpServer({ name: 'snowluma-safe', version: '0.4.1' });

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
  '查看当前二代仿真模式的提示词/角色/管理员QQ/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看指定会话的未读消息（只读，不自动标记已读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'), limit: z.number().optional().describe('最多返回条数，默认 30，最大 100') },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
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

if (cfg.socialV2?.images?.enabled === true && cfg.socialV2?.tools?.sendImage !== false) {
  server.tool(
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
        const q = new URLSearchParams({ key });
        if (tags) q.set('tags', String(tags));
        if (sources) q.set('sources', String(sources));
        const data = await agentApi(`/api/socialV2/image-preflight?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 20000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `预检失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.images?.enabled === true && cfg.socialV2?.tools?.sendImage !== false) {
  server.tool(
    'qq_archive_image',
    '把一张图的**原图**收藏到专门的目录里（群主说「保存」「存一下」「留着」时用）。\n\n【重要】存的是**原图画质**，不是刚发出去的那张压缩版——桥接会去来源站点（safebooru / pixiv / yande.re）查出原图直链再下载。所以同一张图收藏后，文件会比群里看到的那张更大更清晰（实测库里 96KB 的图，原图 262KB）。\n\n【不用传 id】默认存**本会话最近发出的那张**。也可以显式传 id。\n\n【怎么用】调用后回复群主一句话说明存到哪了即可，例如「存好啦，放 collected 里了」。路径在返回值的 path 里。\n\n【幂等】同一张图重复保存不会产生副本（文件名按图库 id 生成，已存在就直接返回原路径、不重复下载）。\n\n【注意】只有**群主/管理员明确要求保存**时才调用，不要自己去存群友发的随便一张图——这是要占磁盘的。若该图源不支持取原图（或站点已删），会返回失败原因，如实告诉群主即可。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().optional().describe('可选：图库 id（如 safebooru:123）。不传则存本会话最近发出的那张')
    },
    async ({ key, token, id }) => {
      try {
        const data = await agentApi('/api/socialV2/archive-image', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, ...(id ? { id } : {}) }),
          timeoutMs: 120000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.images?.enabled === true && cfg.socialV2?.tools?.sendImage !== false) {
  server.tool(
    'qq_image_source',
    '查一张图的来源：图源站点页面、画师、原始发布处。群友问「这图哪来的」「画师是谁」「哪找的」时调用。\n\n【不用传 id】默认查**本会话最近发出的那张**。也可以显式传 id（如果你确实知道图库 id）。\n\n【两个链接的区别，回答时说清楚】\n- `sourcePage`：**图源站点**上这张图的条目页（如 safebooru 的 posts/N、yande.re 的 post/show/N、pixiv 的 artworks/N）。群友想去那个图站看/存图，给这个。\n- `originUrl`：**画师的原始发布处**（通常是 x.com/twitter 原帖）。想找画师本人、看原帖给这个。\n两者经常不同：booru 站的图多是转载自 twitter，所以 `originUrl` 指向推特、`sourcePage` 才指向 booru 站。\n\n注意：发图时的来源标注（画师+链接）已经自动带上了，群友没问就不必特意再报一遍来源。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().optional().describe('可选：图库 id（如 safebooru:123）。不传则查本会话最近发出的那张')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key });
        if (id) q.set('id', String(id));
        const data = await agentApi(`/api/socialV2/image-source?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 20000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `查来源失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// 反向搜图（以图搜图）：拿一张**任意图片**去全网图源反查出处。
// 与 qq_image_source 的区别：那个只读「图库已有条目」的元数据（图库里的图才有来源标注），
// 这个能对**群友刚发的外来图**做全站反查——「这图哪来的、谁画的、求出处」正是它。
if (cfg.socialV2?.tools?.reverseSearch !== false) {
  server.tool(
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
        const q = new URLSearchParams({ key });
        if (messageId) q.set('messageId', String(messageId));
        if (id) q.set('id', String(id));
        const data = await agentApi(`/api/socialV2/reverse-search?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 90000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `反查失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.images?.enabled === true && cfg.socialV2?.tools?.sendImage !== false) {
  server.tool(
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
        const data = await agentApi('/api/socialV2/reject-image', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, ...(id ? { id } : {}), ...(reason ? { reason } : {}) }),
          timeoutMs: 20000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `删除失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.images?.enabled === true && cfg.socialV2?.tools?.sendImage !== false) {
  server.tool(
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
        const data = await agentApi('/api/socialV2/send-image', {
          method: 'POST',
          body: JSON.stringify({ key, tags: tags ?? [], sources, mode, replyToMessageId }),
          headers: { 'x-agent-token': token },
          timeoutMs: 180000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.images?.enabled === true && cfg.socialV2?.tools?.refreshImageLib !== false) {
  server.tool(
    'qq_refresh_image_lib',
    '从已启用的图源补一批图进本地图库（reserved2 专用）。适合图库空了、或想换一批新图时调用。注意：图源受速率限制，桥接有冷却时间（默认两次拉取间隔 30 分钟），冷却中调用会返回 cooled=true 与剩余等待毫秒——这是正常情况，不要反复调用；等一会儿或直接先用图库里现有的图。返回 added 表示本次新入库数量，total 是图库总量。单次拉取可能部分失败（errors 字段），不影响已入库的图。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const data = await agentApi('/api/socialV2/refresh-image-lib', {
          method: 'POST',
          body: JSON.stringify({ key }),
          headers: { 'x-agent-token': token },
          timeoutMs: 180000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `刷新图库失败：${error?.message ?? error}` }], isError: true };
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
if (cfg.socialV2?.bili?.enabled !== false) {
  server.tool(
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
        const data = await agentApi('/api/socialV2/bili-record', {
          method: 'POST',
          body: JSON.stringify({ key, token, bvid, title, owner, category, durationSec, liked, interest, tags, notes, source }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, recorded: data.video, taste: data.taste }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
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
        const params = new URLSearchParams({ key, limit: String(limit ?? 10) });
        if (likedOnly) params.set('liked', '1');
        if (q) params.set('q', String(q));
        const data = await agentApi(`/api/socialV2/bili-memory?${params.toString()}`, {
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
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
        const data = await agentApi('/api/socialV2/bili-watch', {
          method: 'POST',
          body: JSON.stringify({ key, token, url, seconds, frames }),
          headers: { 'x-agent-token': token },
          timeoutMs: 180000
        });
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
    }
  );

  // ── 现场搜 B 站并推荐（2026-10-19 用户反馈「为什么没有新增的视频，都是之前说过了的」）──
  //
  // 根因：原来只有 `qq_bili_memory`（查**已有**记忆），群友问"推荐点视频"时
  // 模型只能翻记忆里的旧内容，还会临时编两条没链接的。
  // 补这个工具：**实时搜索**并把标题+链接给模型，让它推荐真正的新视频。
  server.tool(
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
        const data = await agentApi('/api/socialV2/bili-search', {
          method: 'POST',
          body: JSON.stringify({ key, token, query, count, order }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
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
    }
  );
}

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

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

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

  // ── 超分放大（Real-ESRGAN / Upscayl）——**可选插件** ─────────────────────
  //
  // 为什么给模型一个"主动超分"工具，而不是只让桥接自动处理：
  // 自动那只在**长边 < 400** 时触发（太小到文字不足 1 个 patch 才会看不清）。
  // 但真实场景里还有一类：图不算小（比如 800×600），可内容是远景/小字/老照片，
  // 模型看得见轮廓却认不出细节。这时它应该能自己决定"放大再看看"，
  // 而不是只能报"看不清"。这也符合"失败要显式、给模型可用手段"的约定。
  //
  // **没有 Upscayl 时整个工具不注册**（2026-10-19 用户要求做成可选插件）：
  // 与其挂一个必然失败的工具让模型去试、还要解释失败，不如让它根本不存在——
  // 模型的工具列表里没有它，自然就按原图作答。探测只 stat 文件，不会起进程。
  {
    let upscaleReady = false;
    try {
      const { probeUpscale, configureUpscaleCache } = await import('./upscale.js');
      const uc = cfg.socialV2?.upscale ?? {};
      // MCP 是独立进程，缓存目录要在这里单独配置一次（否则工具路径永远不命中缓存）。
      // 与桥接用同一个目录：桥接自动处理小图时写进去的，模型主动超分时能直接复用。
      if (uc.cache?.enabled !== false) {
        const dir = uc.cache?.dir
          ? path.resolve(ROOT, String(uc.cache.dir))
          : path.join(ROOT, 'state', 'upscale-cache');
        configureUpscaleCache(dir);
      }
      upscaleReady = probeUpscale({ binDir: uc.binDir, modelDir: uc.modelDir, model: uc.model }).ok;
    } catch {
      // upscale.js 缺失/损坏：当作没有这个插件，绝不能因此让 MCP 起不来
      upscaleReady = false;
    }
    if (cfg.socialV2?.upscale?.enabled !== false && upscaleReady) {
      server.tool(
        'qq_upscale_image',
        '用超分（Real-ESRGAN）把 QQ 消息里的一张图放大，用于**群友明确要求**或确实看不清细节时。\n\n'
        + '【什么时候一定会用】群友说「帮我超分」「放大一下」「来个高清」「清晰点」「分辨率太低了」「糊了，放大看看」'
        + '「这张图能不能变清楚」「超分辨率」这类话时——这是**点名要的功能**，不要回"我做不到"或"我只有收藏和发送"，直接调本工具。'
        + '即使原图看着还行、你认为没必要，只要群友明确要求放大，也照做（他可能想要一张更清楚的图存下来）。\n\n'
        + '【什么时候自己判断】群友没明说、但你要看清细节才能回答（远景小字、老照片、远处人脸、模糊表情包）。'
        + '这种情况传 publish=false 只看不发；只有群友想要放大图本身时才发到会话。\n\n'
        + '动图请先按普通取图方式查看（桥接已抽帧拼图），本工具只处理静态图。',
      {
        key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
        messageId: z.union([z.number(), z.string()]).describe('消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
        index: z.number().optional().describe('消息里有多个媒体时指定第几个（从 1 开始），默认第 1 个'),
        model: z.string().optional().describe('超分模型：upscayl-standard-4x(通用,默认) / upscayl-lite-4x(最快) / digital-art-4x(二次元) / high-fidelity-4x(照片) / remacri-4x(强锐化) / ultrasharp-4x(最锐)。群友说「二次元/动漫图」选 digital-art，说「快点」选 lite'),
        publish: z.boolean().optional().describe('是否把放大结果发到会话给群友看，默认 true。群友主动要求超分时应为 true（他要的就是这张图）；你自己只想看清时传 false'),
        token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
      },
      async ({ key, messageId, index, model, publish, token }) => {
        try {
          // raw=1：拿**原始像素**再超分。若走默认路径，桥接会先把小图 lanczos 放大到 1220px，
          // 超分工具看到的已是插值后的糊图，既无收益也会失真（实测 200×163 → 1220×994）。
          const q = new URLSearchParams({ key, messageId: String(messageId), raw: '1' });
          const data = await agentApi(`/api/images/message?${q.toString()}`, {
            headers: token ? { 'x-agent-token': token } : {},
            timeoutMs: 180000
          });
          const images = Array.isArray(data?.images) ? data.images : [];
          if (!images.length) {
            return { content: [{ type: 'text', text: `消息 ${messageId} 没有可取到的图片：${data?.note || '未找到'}` }], isError: true };
          }
          const want = Math.max(1, Number(index) || 1);
          const img = images[want - 1];
          if (!img?.data) {
            return { content: [{ type: 'text', text: `第 ${want} 个媒体取不到图像内容（共 ${images.length} 个）。` }], isError: true };
          }
          if (img.animated) {
            return { content: [{ type: 'text', text: '这是动图，桥接已把它抽帧拼成一张图送给模型；超分不处理动图（会丢帧语义）。请直接按取图结果作答。' }] };
          }
          const buf = Buffer.from(img.data, 'base64');
          const { upscaleImage } = await import('./upscale.js');
          const uc = getConfig().socialV2?.upscale ?? {};
          const r = await upscaleImage(buf, {
            mimeType: img.mimeType || 'image/png',
            model: model || uc.model,
            binDir: uc.binDir,
            modelDir: uc.modelDir,
            timeoutMs: uc.timeoutMs,
            force: true
          });
          if (!r.upscaled) {
            const why = {
              'no-upscayl-bin': '本机没找到 Upscayl 的 upscayl-bin（配置项 socialV2.upscale.binDir 可指定目录）',
              'no-model': 'Upscayl 的 models 目录里没有可用模型',
              'breaker-open': '超分刚刚连续失败，已暂时停用（避免每次调用都卡住），直接看原图即可',
              'animated-gif': '动图不支持超分',
              'unknown-size': '读不出这张图的尺寸',
              'input-too-large': '原图已经很大，超分没有收益（应直接看原图）',
              'already-large-enough': '原图已经够大'
            }[String(r.reason || '').split(':')[0]] || r.reason || '未知原因';
            return { content: [{ type: 'text', text: `超分未执行：${why}。请按原图作答。` }] };
          }
          const note = `[已超分放大：${r.from} → ${r.to}，模型 ${r.model}，用时 ${(r.ms / 1000).toFixed(1)}s。这是同一张图的放大版，不是另一张图。]`;

          // 把放大结果发回会话（2026-10-19 用户反馈「超分完没有把超分后的结果发回」）。
          // 默认发；publish=false 时只给模型看（它自己拿不准、不需要群友看到放大版）。
          // 发送失败**不影响**把图片交给模型：模型仍能看图作答，只是群友看不到放大版。
          let publishNote = '';
          if (publish !== false) {
            try {
              // **不压缩，原样发**（2026-10-19 用户要求「尽量不要压缩，除非超过阈值」）。
              //
              // 为什么现在可以完全不压：查证了 SnowLuma 源码，那个 2MB 上限是
              // `readRequestBody(req, maxBytes = 2 * 1024 * 1024)`——只限制 **HTTP 请求体**，
              // 不限制图片本身。OneBot 读图片走 `loadBinarySource()`，支持 base64 / http(s) / file 三种来源。
              // 桥接已改为：Buffer 超过 1.4MB 时用**本地临时 HTTP 托管**（起一个只服务这张图的
              // 一次性回环服务，把 URL 交给 OneBot），请求体只有几十字节。
              // 实测 5.1MB 的图这样发完全正常。
              //
              // 所以这里只在极少数情况下才压（payload 大到连桥接 8MB 请求体都放不下）：
              // 那说明图已经夸张到 6MB 以上，压一压比发不出去好。
              const HARD_LIMIT = 6 * 1024 * 1024;
              let payload = r.buffer;
              if (payload.length > HARD_LIMIT) {
                const { shrinkForPublish } = await import('./upscale.js');
                const shrunk = await shrinkForPublish(payload, HARD_LIMIT);
                if (shrunk) payload = shrunk;
              }
              const sent = await agentApi('/api/socialV2/send-upscaled', {
                method: 'POST',
                headers: token ? { 'x-agent-token': token } : {},
                body: JSON.stringify({ key, token, data: payload.toString('base64') }),
                timeoutMs: 120000
              });
              publishNote = sent?.ok
                ? `已把放大后的图发到当前会话（群友能看到）。`
                : `放大图**没能发出去**（${sent?.error ?? '未知原因'}），群友看不到；如果群友在等这张图，请如实说明。`;
            } catch (error) {
              publishNote = `放大图**没能发出去**（${error?.message ?? error}），群友看不到。`;
            }
          } else {
            publishNote = `按 publish=false 只放大给你自己看，没有发到会话。`;
          }

          return {
            content: [
              { type: 'text', text: `${note}\n${publishNote}${images.length > 1 ? `\n（消息共 ${images.length} 个媒体，这是第 ${want} 个）` : ''}` },
              { type: 'image', mimeType: r.mimeType, data: r.buffer.toString('base64') }
            ]
          };
        } catch (error) {
          return { content: [{ type: 'text', text: `超分失败：${error?.message ?? error}` }], isError: true };
        }
      }
    );
    }
  }
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
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
        const q = new URLSearchParams({ key });
        if (query) q.set('query', String(query));
        if (count != null) q.set('count', String(count));
        if (refresh) q.set('refresh', '1');
        const data = await agentApi(`/api/socialV2/sticker-list?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
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
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
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
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 语音消息（GPT-SoVITS，可插拔）────────────────────────────────────────
//
// 需求（2026-10-22 用户反馈）：群友说「你发个语音」，机器人回「语音我发不出来呀」——
// 因为**从来没有这个工具**。之前只做了"桥接按概率把普通回复换成语音"，
// 模型既不知道有这能力，也无法主动发。补上工具才是真正的"能发语音"。
//
// 只在 TTS 真可用时注册：不可用时工具**不存在**，模型不会看到、也就不会
// 承诺一个做不到的能力（这比注册了再报错好）。
if (cfg.socialV2?.tts?.enabled === true && cfg.socialV2?.tools?.sendVoice !== false
  && sovitsAvailable()) {
  server.tool(
    'qq_send_voice',
    '把一句话**用语音发**到当前会话（群友会听到声音，不是文字）。\n\n'
    + '【什么时候用】群友明确要听声音时：「发个语音」「说句听听」「用语音回我」'
    + '「来一段」「唱一个」（唱不了，但可以说）这类。日常聊天**不要**主动用——'
    + '语音比文字吵，群里频繁发会被嫌。\n'
    + '【说什么】你自己组织一句话（≤140 字），口语化、别太长。'
    + '念出来会尴尬的内容（链接、代码、大段数字）不要用语音，改发文字。\n'
    + '【发完怎么说】语音气泡已经发出去，别再复述同一句话——'
    + '要么不配文字，要么只加一两个字的语气（「喏」「咳」）。\n'
    + '【失败时】如实说发不出来（可能正在加载模型），改成文字回答，不要假装发了。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      text: z.string().describe('要念出来的话，口语化，≤140 字')
    },
    async ({ key, token, text }) => {
      try {
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({ key, text: String(text ?? '') }),
          headers: { 'x-agent-token': token },
          // 首次合成要加载模型（实测 10~25 秒），超时给足
          timeoutMs: 180000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发语音失败：${error?.message ?? error}。可以改用文字回答，但不要假装语音已发出。` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
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
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
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

if (cfg.socialV2?.tools?.getFeatureMenu !== false) {
  server.tool(
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
        const q = new URLSearchParams({ key });
        if (refresh) q.set('refresh', '1');
        // 桥接侧直接发送（图片落盘 + OneBot 发图），因此这里不需要再调 qq_send_image。
        // 让工具自己完成"发出去"，是因为模型没有"发送任意图片"的能力——
        // qq_send_image 只认图库里的图，拿不到这张实时渲染的菜单。
        const data = await agentApi(`/api/socialV2/send-feature-menu?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
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
    }
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
if (cfg.socialV2?.tools?.tokenReport !== false) {
  server.tool(
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
        const q = new URLSearchParams({ key });
        if (fresh) q.set('refresh', '1');
        // 桥接侧直接发送（渲染 PNG + OneBot 发图），因此这里不需要再调 qq_send_image。
        const data = await agentApi(`/api/socialV2/token-report?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          // 超时给足：fresh=true 时要先扫会话文件（增量约 7 秒），再起 Chrome 截图约 3 秒
          timeoutMs: 180000
        });
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
    }
  );
}

// ── GitHub 仓库首页截图（2026-10-20 用户要求）──────────────────────────────
if (cfg.socialV2?.tools?.githubShot !== false) {
  server.tool(
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
        const data = await agentApi('/api/socialV2/github-shot', {
          method: 'POST',
          body: JSON.stringify({ key, url }),
          headers: { 'x-agent-token': token },
          // 起 Chrome + 加载 + 分段截图，实测约 10 秒；给足余量
          timeoutMs: 180000
        });
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

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
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
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.deleteSticker !== false) {
  server.tool(
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
        // 写操作端点读 **body**（不是 query）。注意 agentApi 把 init 直接交给 fetch，
        // 所以 body 必须自己 JSON.stringify —— 传对象会变成 "[object Object]"。
        const data = await agentApi('/api/socialV2/sticker-delete', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, stickerId: String(stickerId) })
        });
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
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
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
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
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

// ── X（Twitter）帖子按需拉取 ──────────────────────────────────────────────
// 群友点名要看某个 X 账号的帖子时调用：桥接现场抓取 → 渲染成卡片图 → 直接发到当前会话。
// P0 安全止血：socialV2.tools.fetchXPosts=false 时**不注册**该工具，模型完全看不到。
if (cfg.socialV2?.tools?.fetchXPosts !== false) {
server.tool(
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
      const data = await agentApi('/api/socialV2/fetch-x-posts', {
        method: 'POST',
        body: JSON.stringify({ key, handle, count, date, lastHours }),
        headers: { 'x-agent-token': token },
        timeoutMs: 180000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `拉取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);
}

await server.connect(new StdioServerTransport());
