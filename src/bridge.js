// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector } from './dsh-client.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { tileGifFrames, isGifBuffer, probeFrameCount, gifFramesHint } from './gif-frames.js';
// 传给模型前把过大图片降采样（防 DSH 侧 base64 爆栈），见模块顶部说明。
import { downscaleIfLarge, upscaleIfSmall, prepareImageForModel } from './image-downscale.js';
// 群文件只读分类（列表/统计/搜索，不做写操作），见模块顶部说明。
import { summarizeGroupFiles, formatSummary, searchGroupFiles, humanSize } from './group-files.js';
import { fetchFromSources, resolveTagName, sourcePageOf } from './image-sources.js';
import { loadPixivAuth, setPixivCookie } from './pixiv-auth.js';
import { createAsrEngine } from './asr.js';
import { probeSovits, createTtsEngine, DEFAULT_SOVITS_DIR } from './tts.js';
import { collectCacheItems, summarizeCache, purgeCache, humanBytes, CACHE_GROUPS } from './cache-manager.js';
import { saveOriginalImage } from './image-archive.js';
import { detectSourceRequest, createSourceHintStore } from './image-source-hint.js';
import { extractStyleVectors, cosine } from './image-style.js';
import { createImageStore } from './image-store.js';
import { createReverseSearcher } from './image-reverse-search.mjs';
import { classifyImageFeedback, createFeedbackGate } from './image-feedback.js';
// 回复时按概率 @ 对方：由桥接掷骰（模型几乎不主动传 atUserId），见 auto-at.js 顶部说明。
import { pickAutoAt, DEFAULT_AUTO_AT } from './auto-at.js';
import {
  DEFAULT_CONTEXT_MEMORY,
  contextDir,
  loadEpisodes,
  loadCompactions,
  appendEpisode,
  appendCompaction,
  appendContextMessage,
  loadContextMessages,
  journalStats,
  loadLongTermMemory,
  mergeEpisodeToMemory,
  backfillLongTermMemory,
  longTermStats,
  contextStats,
  shouldMakeEpisode,
  buildEpisodePrompt,
  parseEpisode,
  formatMemoryPack,
  createSummarizer
} from './context-memory.js';
import { XMonitor } from './x-monitor/index.mjs';
import {
  classifyUpstreamError,
  condenseUpstreamDetail,
  createErrorNotifier,
  buildOwnerReport,
  buildOwnerNotice,
  looksLikeBridgeErrorEcho,
  pickMessage,
  DEFAULT_MESSAGES as DEFAULT_ERROR_MESSAGES
} from './error-notifier.js';
import { safeFetchBuffer, validateFetchUrl, looksLikeImageBuffer } from './safe-fetch.js';
// 超分回传要按魔数确认"这确实是图片"，不能变成任意文件发送通道。
import { sniffImageMime } from './web-image-fetch.js';
// B 站：自己刷视频 + 全局观看记忆。见 bili.js / bili-browse.js 顶部说明。
import { createVideoMemory, resolveBiliId, fetchVideoInfo, fetchPopularVideos, setBiliCookie } from './bili.js';
import { loadBiliAuth, searchVideos, buildSearchKeywords, pickSearchQuery } from './bili-auth.js';
import {
  pickCandidate, watchDepth, watchVideo, canSelfBrowse,
  nextBrowseDelay, buildBrowsePrompt, buildScanPrompt, buildExtendedPrompt,
  parseScanVerdict, categoryGroup, categoryWeight, GAME_KEYWORDS
} from './bili-browse.js';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import { stripLeadingMetaMarker, stripLeadingMetaMarkers } from './meta-marker.js';
import { extractQuotedMedia, buildReplyText, reserved2MediaFetchHint, inlineMediaFactHint } from './quoted-media.js';
// 拍一拍目标解析：支持 latest / 昵称，避免模型在没有 QQ 号时复用旧号（见 poke-target.js 顶部事故说明）。
import { resolvePokeTarget, isSymbolicPokeRef } from './poke-target.js';
// 分享卡片（B 站/小红书/音乐/位置）：解析标题与封面，见 share-card.js 顶部说明。
import { parseShareCard, formatShareCard, coverUrlOf, extractShareCards } from './share-card.js';
import { crawlUrl, crawlAigengtu, saveStickerImage, isAigengtuUrl } from './web-crawler.js';
// 群友功能菜单图（HTML+CSS → Chrome 无头截图），见 feature-menu.js 顶部说明。
import { renderFeatureMenu } from './feature-menu-render.js';
import { parseGitHubUrl, extractGitHubUrl, screenshotGitHubRepo } from './github-shot.js';
import { parseJoinCommand, describeJoinRequest, createJoinQueue, DEFAULT_TTL_MS as JOIN_TTL_MS } from './join-request.js';
import { CREDENTIAL_ITEMS, maskValue } from './credentials-doc.js';
import { TOOL_FLAGS, toolNamesOf, groupedToolFlags } from './tool-flags.js';
import { aggregateTokenUsage, humanTokens } from './token-usage.js';
import { buildTokenReport, summarizeTokenReport } from './token-report.js';
import { renderTokenReport, pruneTokenReportCache } from './token-report-render.js';
import { validateEmojiId, createReactionGate, REACTION_EMOJIS, emojiMenuText } from './emoji-react.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  SLANG_STATUS
} from './slang-learner.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from './sticker-lib.js';
// 表情包主动要求：按本轮语气挑候选（见模块顶部说明）
import { pickStickerCandidates, buildStickerNudge, moodOfText } from './sticker-pick.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
// Token 用量统计（每日更新）：聚合结果 + 每会话文件的扫描缓存
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.json');
// 加好友/入群邀请的待裁决队列（落盘，重启不丢）
const JOIN_REQUESTS_FILE = path.join(STATE_DIR, 'join-requests.json');
// 上下文持久化（Phase 0/1）：情节摘要 + DSH 压缩摘要，独立目录，不塞进 social-v2.json
const CONTEXT_DIR = path.join(STATE_DIR, 'context');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const IMAGE_LIB_DIR = path.join(STATE_DIR, 'image-lib');
// 控制台「选择文件/文件夹」同一时刻只允许一个原生对话框，避免连点叠出多个窗口
let pickPathBusy = false;
// 收藏原图的默认目录：放在 ROOT 下的 collected/，**刻意不进 state/**——
// state 是运行态缓存（会被清理/淘汰），收藏是用户资产，两者不该混在一起。
const IMAGE_ARCHIVE_DIR = path.join(ROOT, 'collected');
// 图库下载用的 User-Agent：明确自报身份（含项目地址），便于图站识别与追责，
// 也避免被 CDN 当作伪装爬虫拒绝。与 image-sources.js 的 UA 保持一致。
const IMAGE_FETCH_UA = 'qq-bridge/0.1 (personal QQ bot; +https://github.com/DeepSeekHarness/qq-bridge)';
// 各图源的下载附加头。pixiv 的图床 i.pximg.net 有防盗链：**不带 Referer 一律 403**
// （实测），带上 pixiv 域即可 200。
const SOURCE_DOWNLOAD_HEADERS = {
  pixiv: { referer: 'https://www.pixiv.net/' }
};
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');

// 语音"概率替换"的默认触发率（2026-10-22 用户要求从 8% 降到 5%）。
//
// 为什么要抽成常量：这个默认值原本散落在 4 处（planTtsV2 掷骰、状态端点两次、
// 启动日志一次）。改一次要改四处，漏一处就会出现"日志说 8%、实际按 5% 掷"的
// 自相矛盾。集中一处后，改值只动这里。
//
// 注意：**模型主动要求发**（qq_send_voice）不受这个概率影响——
// 群友明确说"发个语音"就该发，那里只有每小时的条数上限。
const TTS_DEFAULT_PROBABILITY = 0.05;

/**
 * 读取 TTS 数值参数（**0 是合法值，不能被当成"没配"**）。
 *
 * 为什么单独写函数：`Number(cfg?.x) || 默认值` 这个常见写法在 x=0 时会回落成默认值。
 * 而 maxPerHour=0 是**有意义的设置**——"不自动发，只在被要求时发"。
 * 实测踩到：把上限设成 0，状态接口却显示 3 条，看着像保存失败。
 */
function ttsNum(raw, dflt, min, max) {
  const n = Number(raw);
  const v = (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) ? dflt : n;
  return Math.min(max, Math.max(min, Math.round(v)));
}

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 原子写文本文件。
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
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

// 把模型可能传成「JSON 数组字符串」的消息归一化成字符串数组。
// 为什么不只用 JSON.parse：模型经常在数组元素里写未转义的直引号
// （例如 ["他说"你好"就走了","第二条"]），JSON.parse 必然失败；若把
// 异常吞掉，整串 JSON 会被当成一条消息原样发到群里（线上事故）。
// 因此解析失败时按引号/逗号手工切分，至少保住分条语义。
function normalizeMessagesInput(value) {
  if (Array.isArray(value)) return value.map((m) => String(m ?? '')).filter((s) => s.trim() !== '');
  if (typeof value !== 'string') return [];

  const trimmed = value.trim();
  // 单条 JSON 字符串："\"你好\"" → 你好
  if (trimmed.startsWith('"') && !trimmed.startsWith('["')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return [parsed].filter((s) => s.trim() !== '');
      if (Array.isArray(parsed)) return parsed.map((m) => String(m ?? '')).filter((s) => s.trim() !== '');
    } catch {}
  }

  // JSON 数组字符串（含内层直引号未转义的容错）
  //
  // 判据必须包含「有引号」：模型真正会踩的是 `["a","b"]` 这种**元素带引号**的序列化形式，
  // 此时引号一定存在。若不加这个前提，容错分支会把任何以 `[` 开头的正文都当数组字面量：
  //   实测（2026-10-09 用真实端点验证）`[图片]` → `图片`、`[doge]这个梗我熟` → `doge]这个梗我熟`，
  //   前者是桥接自己生成的段标记、后者是群友常用写法，都被静默改坏了。
  if (trimmed.startsWith('[') && /["']/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      // 只有「字符串数组」才算消息列表；`[1]` 这种不应被当成分条内容。
      if (Array.isArray(parsed) && parsed.every((m) => typeof m === 'string')) {
        const out = parsed.map((m) => String(m ?? '')).filter((s) => s.trim() !== '');
        if (out.length) return out;
      }
    } catch {
      const salvaged = splitArrayLiteral(trimmed);
      if (salvaged.length) return salvaged;
    }
  }
  return trimmed ? [trimmed] : [];
}

// 手工切分形如 ["a","b"] 的数组字面量：以「引号 + 逗号 + 引号」为分隔，
// 剥掉首尾的 [ ] 与每个元素两侧的引号。仅供 JSON.parse 失败时兜底。
function splitArrayLiteral(text) {
  let s = String(text ?? '').trim();
  if (s.startsWith('[')) s = s.slice(1);
  if (s.endsWith(']')) s = s.slice(0, -1);
  return s
    .split(/"?\s*,\s*"?/)
    .map((part) => {
      let t = part.trim();
      if (t.startsWith('"')) t = t.slice(1);
      if (t.endsWith('"')) t = t.slice(0, -1);
      return t.trim();
    })
    .filter((t) => t !== '');
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
function appendActivity(line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(11, 19);
    fs.appendFileSync(ACTIVITY_LOG, `[${ts}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
    // 只保留最近 500 行
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > 500) fs.writeFileSync(ACTIVITY_LOG, lines.slice(-500).join('\n'));
  } catch {}
}

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}
function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
function sanitizeRoleName(name) {
  // 角色名白名单：中文、字母、数字、下划线、横线，以及**成对的括号**。
  // 为什么允许括号：像「大肥鱼（傲娇版）」这种「本名+变体」的命名很自然，
  // 但原先只保留 \w 与中文，**全角括号会被吃掉**（→「大肥鱼傲娇版」），
  // 于是 /api/roles/create 与 /api/role-content 的 `safe !== name` 校验直接 400，
  // 带括号的角色既建不了也读不了（实测踩到）。半角括号同理。
  //
  // 仍然安全：只保留字符、不保留任何路径分隔符或点号，
  // 所以 `../` 这类穿越构造在清洗后不可能成立；调用方还会再次比对 safe === name。
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff\-（）()]/g, '');
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// 私聊准入策略规范化。非法值一律回落到 'list'（白名单制）——fail-closed：
// 配置写错时宁可收紧，也不要意外变成"谁都放进来"。
function normalizePrivateMode(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (s === 'friends' || s === 'friend') return 'friends';
  if (s === 'all') return 'all';
  return 'list';
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      reasoningEffort: 'max',
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? []),
      // 私聊准入策略：
      //   'list'    = 白名单制（只有 allow.private 里的 QQ 能私聊）—— 旧行为，默认值
      //   'friends' = **QQ 好友自动放行**（除 deny 外），非好友（临时会话）仍需白名单
      //   'all'     = 全放开（除 deny 外任何私聊都收）—— 等同于纯黑名单制
      //
      // 为什么单列 'friends'：SnowLuma 会区分私聊来源——`sub_type: 'friend'` 是真好友，
      // `sub_type: 'group'` 是**临时会话**（群内非好友点开就能发，见 SnowLuma
      // convertPrivateMessage 的注释 "friend_message and temp_message differ only in sub_type"）。
      // 所以「能加我好友的都是我确认过的」这个前提**只对 friend 成立**；
      // 若直接全放开（'all'），群里任何陌生人都能通过临时会话私聊机器人。
      // 'friends' 既免去手动维护名单，又堵住这个口子。
      privateMode: normalizePrivateMode(file.allow?.privateMode)
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    // 控制台鉴权开关。false = 不校验令牌（用户要求：每次刷新都要填太麻烦）。
    // 安全前提：控制台只监听 127.0.0.1，且写操作必须 application/json + 同源 Origin
    // （见 startConsoleServer 的 CSRF 段）。想看令牌拦截效果就设回 true。
    consoleAuth: file.consoleAuth !== false,
    consoleToken: file.consoleToken ?? '',
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    // 报错一律私聊管理员、不进群（用户要求）。notifyOwner 控制私聊总开关，
    // windowMs 是同一类报错的节流窗口；群内报错开关放在 socialV2.errorNotice.inGroup。
    errorNotify: {
      notifyOwner: true,
      windowMs: 3 * 60 * 1000,
      ...(file.errorNotify ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        sendImage: true,
        checkImage: true,
        refreshImageLib: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
    deleteSticker: false,
        deleteSticker: false,
        stickerNote: true,
        collectSticker: true,
        getSelfImage: true,
        getFeatureMenu: true,
        groupFiles: true,
        reverseSearch: true,
        // GitHub 仓库首页截图（2026-10-20 用户要求）
        githubShot: true,
        // Token 用量统计图（2026-10-21 用户要求）
        tokenReport: true
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。',
        // 回复时按概率 @ 发出消息的人（桥接掷骰，模型不用操心）。
        // 模型几乎不主动传 atUserId（30 天 qq_send_message 4174 次，带 @ 的极少），
        // 而"偶尔点个名"的指向感属于发送外观，交给桥接更稳定。详见 auto-at.js。
        autoAt: { ...DEFAULT_AUTO_AT }
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        // 主动要求发表情（2026-10-22 用户反馈「依旧极少调用表情包」）。
        // 原来只有软策略提示，实测 1999 次工具调用里只发过 1 次。
        // 改成桥接掷骰：命中时在提示里**明确要求**发一张，并给 2~3 个候选。
        autoNudge: true,           // 总开关（false = 退回旧的软提示）
        autoNudgeProbability: 0.33,// 每轮命中的概率
        autoNudgeMinGapMs: 180000, // 两次"要求"之间至少隔 3 分钟
        autoNudgeMaxPerHour: 6,    // 每小时最多要求几次（防止连聊时刷屏）
        autoNudgeCandidates: 3,    // 给模型几个候选（越多越挑不动）
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      // 按需网页抓取（qq_crawl_web）：只走 safe-fetch，禁内网/登录绕过。
      // 图片入库额外受 sticker 总开关与每日上限约束。
      crawl: {
        enabled: true,
        maxPerHour: 10,
        maxImages: 10,
        maxStickersPerCall: 3,
        stickerMaxPerDay: 20,
        maxBytes: 5 * 1024 * 1024,
        timeoutMs: 30000
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20
      },
      // 上下文持久化（Phase 0/1）：情节摘要 + 压缩摘要采集 + 记忆包注入。
      // 详见 src/context-memory.js；默认全开，失败只记日志、不影响聊天。
      contextMemory: { ...DEFAULT_CONTEXT_MEMORY },
      // 群友点单（要求生成内容）时的「照做」判定：由桥接掷骰，结果注入唤醒提示。
      comply: {
        enabled: true,
        probability: 0.7,             // 照做概率；其余为自由发挥
        ttlMs: 3 * 60 * 1000,         // 判定有效期
        cooldownMs: 20 * 1000,        // 同会话两次掷骰的最小间隔
        maxPerHour: 12                // 每小时最多照做次数（防刷）
      },
      // 动图抽帧拼图：模型对 GIF 只能看到第一帧，抽帧拼图后可看出动作序列。
      gifFrames: {
        enabled: true,
        maxFrames: 20,                // 等间隔抽 20 帧；不足 20 帧则全取
        tileWidth: 320,               // 每帧缩放宽度上限（帧多时会自动缩窄以控制总宽）
        timeoutMs: 15000              // ffmpeg 超时
      },
      // 媒体内联（群消息图片/表情）：单条消息的图片总量上限。
      // 桥接自己的保守值，非 QQ/上游硬性要求；超限的图会被替换为文字占位。
      media: {
        maxMessageBytes: 8 * 1024 * 1024  // 单条消息图片总字节上限（默认 8MB）
      },
      // 图库：从外部图源拉图落盘，群友要求时按需取图发送。
      images: {
        enabled: false,               // 总开关（默认关：需要网络与版权确认后再开）
        libDir: '',                   // 空 = state/image-lib
        maxFiles: 300,                // 图库容量上限（超出按最久未用淘汰）
        maxTotalBytes: 256 * 1024 * 1024, // 图库总字节上限（默认 256MB），与 maxFiles 取先到者
        maxBytesPerFile: 8 * 1024 * 1024, // 单图字节上限（与消息内联上限一致）
        fetchPerRun: 20,              // 每次刷新最多下载几张
        cooldownMs: 30 * 60 * 1000,   // 两次拉取的最小间隔（防频繁打图站）
        sendCooldownMs: 20 * 1000,    // 同会话两次发图的最小间隔
        maxSendPerHour: 10,           // 每会话每小时最多发几张
        annotateSource: true,         // 发送时附「画师/出处」标注（版权可追溯）
        // 已发图自动删除：发出的图超过这个时长就从本地库删掉（0 = 不删）。
        // 作用：让机器人每次发的都是"新图"，避免同一张反复出现。
        // 代价：删掉后同一角色再要就要重新现拉（5~30 秒），预检会提示 willWait。
        sentTtlMs: 10 * 60 * 1000,    // 默认 10 分钟
        sentSweepMs: 60 * 1000,        // 清理检查间隔（默认每分钟扫一次）
        sources: {
          // 整站全年龄、有公开 API。默认开（但受上面的总开关约束）。
          safebooru: {
            enabled: true,
            tags: [],                 // 追加的固定标签，例如 ['1girl','landscape']
            limit: 20
          },
          // pixiv 日榜：条款禁止未授权转载，且对程序化访问有风控。
          // 默认关；了解并接受风险后再改为 true。
          pixiv: {
            enabled: false,
            limit: 20,
            // 登录态（可选）：文件存在就带上凭据，不存在就是匿名访问。
            // 凭据在控制台「凭据与连接配置」卡片里填（PHPSESSID / device_token）。
            authFile: 'state/pixiv-auth.json'
          },
          // yande.re：需经代理（本地 DNS 污染，直连超时）。
          // ⚠️ 该站**主体是成人内容**：实测全站样本 q:92/s:69/e:39，且即使经
          // rating:safe 过滤，抽查 100 张里仍有约 52% 带擦边标签（skirt_lift 27%、
          // see_through 14%、no_bra 9%）。默认关；开启即表示接受该内容风险。
          yandere: {
            enabled: false,
            limit: 20,
            proxy: ''                // 代理地址，如 http://127.0.0.1:7897；留空则用 images.proxy
          }
        }
      },
      // GitHub 仓库首页整页截图（2026-10-20 用户要求「解析 GitHub 链接并把仓库首页整个截图并发送」）
      githubShot: {
        enabled: true,
        // 分段高度：整页约 15000px，一张发出去会被 QQ 压成细线看不清（实测）。
        // 按 2400px 切段，每段 1400×2400，文字仍清晰。
        sliceHeight: 2400,
        // 单次截图的整页高度上限（防止异常长的 README 把内存/时间打爆）
        maxHeight: 12000,
        // 首屏等待：GitHub 的 README 是异步渲染的，等太短会截到加载中
        waitMs: 3500,
        timeoutMs: 90000,
        // 实测本机直连 github.com 会 ECONNRESET，必须走代理。
        // 留空则用 images.proxy；都空则直连（境外网络环境下可能失败）。
        proxy: ''
      },
      // 加好友 / 入群邀请：通知管理员并等人工裁决（2026-10-20 用户要求）
      joinRequest: {
        enabled: true,
        // 默认**不自动同意**：加好友 / 入群都是在扩张攻击面（好友能私聊、
        // 群能让它出现在陌生人面前）。默认 fail-closed，超时即拒。
        autoApprove: false,
        // 等待裁决的时限。超时自动拒绝——不能一直挂着，否则申请人看到的是
        // "永远在等待"，比明确拒绝更糟。
        ttlMs: JOIN_TTL_MS,
        // 只认管理员私聊的裁决指令（群里的"同意"可能是别人说的）
        notifyChannel: 'private'
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    slangQuery: true,
    slangSubmit: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
        sendImage: true,
        checkImage: true,
        refreshImageLib: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    getSelfImage: true,
    getFeatureMenu: true,
    reverseSearch: true,
    tokenReport: true,
    // 语音工具默认开；TTS 插件没装时 MCP 不会注册它（可插拔语义）
    sendVoice: true,
    ...(cfg.socialV2.tools ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    // 与上面示例配置同源，避免旧 config.json 缺字段时丢默认值
    autoNudge: true,
    autoNudgeProbability: 0.33,
    autoNudgeMinGapMs: 180000,
    autoNudgeMaxPerHour: 6,
    autoNudgeCandidates: 3,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // socialV2.comply 同样深度合并：config.json 里只写概率时不能丢其余默认值。
  cfg.socialV2.comply = {
    enabled: true,
    probability: 0.7,
    ttlMs: 3 * 60 * 1000,
    cooldownMs: 20 * 1000,
    maxPerHour: 12,
    ...(cfg.socialV2.comply ?? {})
  };

  // socialV2.gifFrames 深度合并（同上）。
  // maxFrames=20：等间隔抽取，不足 20 帧则全取。单帧宽度会按帧数自适应
  // （总宽控制在 ~2400px 内），所以帧多也不会糊到看不清。
  cfg.socialV2.gifFrames = {
    enabled: true,
    maxFrames: 20,
    tileWidth: 320,
    timeoutMs: 15000,
    ...(cfg.socialV2.gifFrames ?? {})
  };

  // socialV2.emojiReact：给群消息贴表情回应（QQ 的 set_msg_emoji_like）。
  // **由模型自主决定**贴不贴/贴哪条/贴哪个（它才有完整上下文，桥接只看单条消息
  // 会变成概率行为）。桥接只负责：只允许群聊、限流、校验表情 id。
  // 详见 emoji-react.js 的说明。
  cfg.socialV2.emojiReact = {
    enabled: true,
    cooldownMs: 60 * 1000,   // 同会话两次贴表情的最小间隔（防模型连贴）
    maxPerHour: 15,          // 同会话每小时上限
    emojis: REACTION_EMOJIS, // 推荐给模型的表情清单（工具描述里会列出）
    ...(cfg.socialV2.emojiReact ?? {})
  };

  // socialV2.errorNotice：上游 503/429 等额度类报错的通知方式。
  // inGroup=false（默认）表示**不在群里发任何报错信息**，只私聊管理员——这是用户要求：
  // "以后拦截所有报错信息，全部转发给管理员账号，而不要在群里发送报错相关信息"。
  // 仍保留 inGroup 开关：设成 true 可回到「群里发一句人设短句」的旧行为。
  cfg.socialV2.errorNotice = {
    enabled: true,
    windowMs: 3 * 60 * 1000,      // 同一会话 3 分钟只提示一次
    notifyOwner: true,            // 私聊管理员错误详情
    inGroup: false,               // 群里是否也发一句人设短句（默认关）
    messages: DEFAULT_ERROR_MESSAGES,
    ...(cfg.socialV2.errorNotice ?? {})
  };

  // socialV2.media 深度合并（单条消息图片总量上限等）。
  cfg.socialV2.media = {
    maxMessageBytes: 8 * 1024 * 1024,
    ...(cfg.socialV2.media ?? {})
  };

  // socialV2.images 深度合并：sources 是嵌套对象，外层 spread 会整体覆盖，
  // 必须逐层合并，否则 config 里只写 safebooru 时 pixiv 默认值会丢。
  const imgCfg = cfg.socialV2.images ?? {};
  cfg.socialV2.images = {
    enabled: false,
    libDir: '',
    maxFiles: 300,
    maxTotalBytes: 256 * 1024 * 1024,
    maxBytesPerFile: 8 * 1024 * 1024,
    fetchPerRun: 20,
    // 按需现拉（群友点单时）只拉这么多张：一条消息只发 1 张，拉太多纯属让群友干等。
    // pixiv 实测约 10~25 秒/张，"逐张探测扩展名 + 经代理下载"，拉 20 张要 3~8 分钟——
    // 期间模型无法回话，群友看到的就是「又不理人了」（实测 3 分钟无响应后模型超时重试）。
    ondemandFetchCount: 4,
    cooldownMs: 30 * 60 * 1000,
    sendCooldownMs: 20 * 1000,
    maxSendPerHour: 10,
    annotateSource: true,
    sentTtlMs: 10 * 60 * 1000,
    sentSweepMs: 60 * 1000,
    // 差评换图：群友说「不好看/换一张」时删掉刚发的图并另发一张。
    // feedbackWindowMs：距发图多久内的评价算「说这张」（群友常省略"图"字）
    // feedbackCooldownMs：同会话换图冷却，避免连骂连发
    feedbackSwap: true,
    feedbackWindowMs: 120 * 1000,
    feedbackCooldownMs: 90 * 1000,
    // 收藏原图：把**原图画质**（非库内压缩版）存到 archiveDir。
    // 默认 ROOT/collected（与 state/ 分开：state 是运行态缓存会被清理，
    // 收藏是用户资产）。设为空字符串可关闭该功能。
    archiveDir: IMAGE_ARCHIVE_DIR,
    archiveOverwrite: false,
    ...imgCfg,
    sources: {
      safebooru: { enabled: true, tags: [], limit: 20, ...(imgCfg.sources?.safebooru ?? {}) },
      pixiv: { enabled: false, limit: 20, authFile: 'state/pixiv-auth.json', ...(imgCfg.sources?.pixiv ?? {}) },
      yandere: { enabled: false, limit: 20, proxy: '', ...(imgCfg.sources?.yandere ?? {}) }
    }
  };

  // imageReverseSearch：反向搜图（以图搜图，查「这图哪来的/谁画的」），走 SauceNAO。
  // 与 socialV2.images.sources 的区别：那个是**按标签正向找图**，这个是**拿图反查出出处**。
  // apiKey 免费账号在 saucenao.com 注册后获取；不配则功能不可用（会明确告知，不静默失败）。
  cfg.imageReverseSearch = {
    enabled: true,
    apiKey: '',
    db: 999,          // 999 = 全部站点；可指定单站索引（见 image-reverse-search.mjs 的 DB_INDEX）
    minsim: 50,       // 相似度下限（0~100），低于它的结果 SauceNAO 会直接过滤
    numres: 5,        // 最多返回几条
    proxy: '',        // 留空则继承 socialV2.images.proxy
    ...(file.imageReverseSearch ?? {})
  };

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
let state = { sessions: {} };
function loadState() {
  const loaded = readJsonSafe(STATE_FILE, null);
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
}
function saveState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');
function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') stale = true;
          else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

/**
 * 等某个本机端口被释放（自重启用）。
 *
 * 为什么需要：`releaseLock()` 只删锁文件，**不代表监听已关闭**。
 * 自重启时子进程可能与父进程的退出收尾重叠，此时 bind 会 EADDRINUSE。
 * 这里主动探一次端口（连得上 = 还被占着），等到连不上为止；有上限，不会死等。
 */
async function waitForPortFree(port, timeoutMs) {
  const net = await import('node:net');
  const probe = () => new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (busy) => { try { sock.destroy(); } catch {} resolve(!busy); };
    sock.setTimeout(400);
    sock.on('connect', () => done(true));   // 连上了 = 还有人在监听
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));    // 连不上 = 已释放
  });
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await sleep(150);
  }
  return false;
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）
function log(...args) {
  const line = `${new Date().toISOString().slice(11, 19)} [bridge] ${args.map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`.replace(/[\r\n]+/g, ' ');
  console.log(line);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(BRIDGE_LOG, line + '\n');
    const raw = fs.readFileSync(BRIDGE_LOG, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > 2000) fs.writeFileSync(BRIDGE_LOG, lines.slice(-2000).join('\n'));
  } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 消息的身份前缀——给模型看的**客观身份标记**。
 *
 * 三个概念必须分清（2026-10-16 用户要求「区分后台管理员、群主、群管理员」）：
 *   ① 后台管理员（isOwner，即 config.ownerQQ）→ 【管理员】
 *      这是**唯一**能执行管理命令/写操作（删表情、改备注）的身份。
 *   ② 群主（groupRole==='owner'）→ 【群主】
 *      群里的身份。群主**未必**是后台管理员，两者独立。
 *   ③ 群管理员（groupRole==='admin'）→ 【群管理员】
 *      群里的身份，与①②都无关。
 *
 * 一个人可能同时是多种身份，所以标记可以叠加（如「【管理员】【群主】」）。
 * 措辞保持**客观状态描述**而非命令（既有教训：内部指令写成"必须…"会被当台词复述）。
 */
function identityTagOf(m) {
  if (!m || typeof m !== 'object') return '';
  const tags = [];
  if (m.isOwner) tags.push('【管理员】');
  if (m.isGroupOwner) tags.push('【群主】');
  else if (m.isGroupAdmin) tags.push('【群管理员】');
  return tags.join('');
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true, mediaFetchHint } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」；有图时再附「怎么看到它」。
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        // 拼装逻辑在 quoted-media.js（原先只拼 sender+text，把图片段丢了 →
        // 模型看到 `[引用 某人：[图片]]` 却无法取图，实测「回复图片问这是什么」直接失效）。
        if (!includeReply) break;
        let info = null;
        if (resolveReply) {
          try { info = await resolveReply(String(d.id)); } catch {}
        }
        out.push(buildReplyText(info, mediaFetchHint));
        break;
      }
      case 'json': {
        // 分享卡片（B 站视频/小红书/音乐/位置等）：解析出标题、描述、真实链接、封面。
        // 原先这里只推 '[卡片消息]' 四个字，标题和封面全丢，实测机器人自己在群里
        // 抱怨过「卡片只显示成[卡片消息]，里面什么内容我看不到」。
        // 解析不出内容时退回占位符（不编内容）。封面图走媒体管线，见 extractMediaFromSegments。
        const card = parseShareCard(d.data);
        out.push(card ? formatShareCard(card) : '[卡片消息]');
        break;
      }
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
// 实现在 quoted-media.js（与「引用消息里的图」共用同一份判定，也便于离线回归测试）。
//
// 分享卡片的**封面图**也作为一项 media 加进来：这样 qq_get_message_images 能直接
// 看到封面（fetchOneBotImage 已支持只用 media.url 取图），无需另写取图路径。
// 注意 cover 项没有 file、只有 url，所以判断「有无媒体」时不能只看 file。
function extractMediaFromSegments(segments) {
  const media = extractQuotedMedia(segments);
  const out = Array.isArray(media) ? [...media] : [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || seg.type !== 'json') continue;
    const card = parseShareCard(seg.data?.data);
    if (!card) continue;
    const cover = coverUrlOf(card);
    if (!cover) continue;
    out.push({
      kind: 'image',
      file: '',
      url: cover,
      subType: '',
      // 让模型知道这张图是卡片封面（而不是群友直接发的图）
      summary: `${card.platform || '分享'}卡片封面`,
      fromCard: true,
    });
  }
  return out;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// ── 群白名单管理命令（管理员可用）──────────────────────────────────────────
//
// 需求：管理员在群里直接把人/群加进白名单或移出，不用去控制台或改 config.json 重启。
//
// 为什么放在模块级而不是命令块里内联：解析与增删都是纯函数，测试可以直接抽出来跑；
// 挂在 bridge 里的话得先拉起整个 WS/HTTP 栈才能测一行字符串切分。
//
// 语义与 allowed() 保持一致（**这是最容易写错的地方**）：
//   - allow.groups 为空 且 allowAllWhenEmpty=true  → 等于"全部放行"，此时删到空不会锁群；
//   - allow.groups 为空 且 allowAllWhenEmpty=false → 等于"全部拦截"，**删到空会把所有群关掉**。
// 所以「删最后一条」要显式提醒，而不是静默生效。
// 主命令 `/wl`（whitelist 缩写），同时接受中文 `/白名单`。
// 刻意不占用 `/allow` 这类泛化词：adminCmd 的判定优先于 DSH 斜杠命令，
// 名字越泛越容易在将来与 DSH 自带命令撞车，撞了就是"管理员命令把 DSH 命令吃了"。
const WHITELIST_CMD_RE = /^\/(?:wl|白名单)(?:\s|$)/i;

// 解析 `/wl` 系列命令；不是该命令返回 null，让调用方继续走别的分支。
//   /wl                          列当前白名单
//   /wl add 123456               加群
//   /wl del 123456               移出群
//   /wl add 123456 654321        一次多个（空格/逗号/顿号都认）
function parseWhitelistCommand(text) {
  const s = String(text ?? '').trim();
  if (!WHITELIST_CMD_RE.test(s)) return null;
  const rest = s.replace(/^\/(?:wl|白名单)/i, '').trim();
  if (!rest) return { action: 'list', ids: [] };
  const m = /^(删除|移除|去掉|add|delete|remove|del|rm|加|删)(?:\s+([\s\S]*))?$/i.exec(rest);
  if (!m) {
    // 只写了一个群号（`/wl 123456`）时按「加」处理——管理员手快时最常见的写法。
    if (/^[\d\s,，、]+$/.test(rest)) {
      return { action: 'add', ids: extractIdList(rest) };
    }
    return { action: 'help', ids: [] };
  }
  const action = /^(add|加)$/i.test(m[1]) ? 'add' : 'del';
  return { action, ids: extractIdList(m[2]) };
}

// 从任意分隔的文字里抠出 QQ 号/群号；非数字的整词忽略（不报错，让上层统一提示）。
function extractIdList(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/[\s,，、;；]+/)) {
    const t = raw.trim();
    if (!t) continue;
    if (!/^\d{5,12}$/.test(t)) continue;
    const n = Number(t);
    if (!Number.isSafeInteger(n) || n <= 0) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// 增删白名单数组，返回新数组与"实际发生了什么"。纯函数，不改入参。
function applyWhitelistChange(list, action, ids) {
  // 只收正整数：`Number(null)` / `Number('')` 都是 0，光用 Number.isFinite 会把脏值放进来。
  const toId = (v) => {
    const n = Number(String(v ?? '').trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const before = (Array.isArray(list) ? list : []).map(toId).filter((n) => n !== null);
  const set = new Set(before);
  const added = [];
  const removed = [];
  const missing = [];
  if (action === 'add') {
    for (const id of ids) {
      if (set.has(id)) { missing.push(id); continue; }
      set.add(id);
      added.push(id);
    }
  } else if (action === 'del') {
    for (const id of ids) {
      if (!set.has(id)) { missing.push(id); continue; }
      set.delete(id);
      removed.push(id);
    }
  }
  return { next: [...set], added, removed, unchanged: missing };
}

// `allow.groups` 被删空时会发生什么——命令里要如实说出来，别让管理员以为"处理了"。
function describeEmptyWhitelistRisk(allowAllWhenEmpty) {
  return allowAllWhenEmpty
    ? '注意：群白名单已空，但 allowAllWhenEmpty=true，仍是所有群都放行。'
    : '注意：群白名单已空，且 allowAllWhenEmpty=false，现在所有群都会被拦截（包括本群）。重新加入本群可直接发 /wl add <本群号>。';
}

// 只取消息里的纯文本段（不解析 @ / 引用，便宜且同步）。
// 用途：准入闸门在解析整条消息之前就要判断"是不是白名单命令"——
// 否则新群（还没进白名单）发的 /wl add 会在闸门处被丢掉，永远到不了命令处理。
function rawTextOfMessage(segments) {
  if (typeof segments === 'string') return segments.trim();
  return (segments ?? [])
    .filter((s) => s?.type === 'text')
    .map((s) => s?.data?.text ?? '')
    .join('')
    .trim();
}

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 自重启时新进程可能与父进程并发启动：父进程在 spawn 之后、exit 之前还有一小段
  // 时间持锁。这里让**被自重启拉起**的进程稍等再抢锁，避免新进程撞上"已有实例"
  // 直接 exit(2) —— 那会变成"重启按钮把服务关掉"的最坏结果。
  if (process.env.QQB_RESTARTED_BY) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!fs.existsSync(LOCK_FILE)) break;
      await sleep(150);
    }
  }
  acquireLock();
  if (process.env.QQB_RESTARTED_BY) {
    log(`桥接已启动（由${process.env.QQB_RESTARTED_BY === 'console' ? '控制台重启' : process.env.QQB_RESTARTED_BY}拉起，PID ${process.pid}）`);
    // 锁释放 ≠ 端口已释放。父进程 releaseLock() 之后还要走完 process.exit 的收尾，
    // :3100 的监听可能晚几十毫秒才真正关闭。此时子进程如果已经抢到锁并 bind，
    // 会命中 EADDRINUSE → exit(2)，服务就彻底停了（比不重启还糟）。
    // 所以抢到锁之后再探一次端口，占用就等它放开（有上限）。
    await waitForPortFree(Number(cfg.consolePort) || 3100, 5000);
  }
  loadState();

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  let slangEntries = loadSlang(SLANG_FILE);
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  let stickerEntries = loadStickerStore(STICKER_FILE);
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护

  // ── 图库（按需取图发送）────────────────────────────────────────────────
  // 从外部图源拉图落盘，群友要求时取本地图发送；元数据（画师/出处）随图标注。
  const imageStore = createImageStore({
    dir: cfg.socialV2?.images?.libDir ? String(cfg.socialV2.images.libDir) : IMAGE_LIB_DIR,
    maxFiles: Number(cfg.socialV2?.images?.maxFiles) || 300,
    maxTotalBytes: Number(cfg.socialV2?.images?.maxTotalBytes) || 256 * 1024 * 1024,
    // 「发过的图多久内不再发」：默认 10 分钟（用户 2026-10-20 要求）。
    // 按内容哈希记，跨 pruneSent 删除存活——否则「发→删→重拉→又发」会死循环。
    recentBlockMs: Math.max(0, Number(cfg.socialV2?.images?.recentSendBlockMs ?? 10 * 60 * 1000)),
    log: (m) => log(`[图库] ${m}`)
  });
  // 上次成功拉取时间（冷却用）。持久化到 state/image-fetch-state.json：
  // 以前只在内存里，桥接一重启就变 0，控制台「取图额度」的「上次拉取」和
  // 30 分钟冷却都会丢失，看起来像「额度没更新」。
  const IMAGE_FETCH_STATE_FILE = path.join(STATE_DIR, 'image-fetch-state.json');
  let imageFetchedAt = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(IMAGE_FETCH_STATE_FILE, 'utf8'));
    const t = Number(raw?.lastFetchedAt);
    if (Number.isFinite(t) && t > 0 && t <= Date.now()) imageFetchedAt = t;
  } catch { /* 没有历史状态 */ }
  let imageFetching = null; // 进行中的拉取 Promise（防并发重复拉）
  let lastFetchCorrections = []; // 上次拉取的标签纠错记录（{from,to,postCount}）
  // ── pixiv 登录态（可选，见 src/pixiv-auth.js）────────────────────────────
  // 不设独立开关：**凭据文件存在就带，不存在就是匿名**。多一个隐藏开关只会让
  // 用户填完凭据却「什么也没发生」，排查成本远高于它挡掉的风险。
  // 默认状态（没有 state/pixiv-auth.json）与改造前完全一致：请求头里不出现 cookie。
  const pixivAuthFile = path.resolve(
    ROOT,
    String(cfg.socialV2?.images?.sources?.pixiv?.authFile || 'state/pixiv-auth.json')
  );
  /** 读取并注入 pixiv 登录态。启动时调一次；控制台保存后也调（立即生效）。 */
  function applyPixivAuth(reason = '启动') {
    const pa = loadPixivAuth(pixivAuthFile);
    setPixivCookie(pa.loaded ? pa.cookie : '');
    if (pa.loaded) {
      log(pa.hasSession
        ? `[图库] pixiv 登录态已加载（${reason}，请求会带凭据）`
        : `[图库] pixiv 凭据已加载但没有登录态（${reason}：${pa.reason}），等同匿名`);
    } else {
      log(`[图库] pixiv 匿名访问（${reason}：${pa.reason}）`);
    }
    return { loaded: pa.loaded, hasSession: !!pa.hasSession };
  }
  applyPixivAuth();
  // 反向搜图（以图搜图，查出处）：SauceNAO。与图库的「按标签正向找图」是两件事。
  // apiKey 未配置时 available() 返回 false，端点会明确告知（不静默失败）。
  const reverseSearcher = createReverseSearcher({
    root: ROOT,
    log: (m) => log(`[反查] ${m}`),
    proxy: String(cfg.imageReverseSearch?.proxy || cfg.socialV2?.images?.proxy || ''),
    apiKey: String(cfg.imageReverseSearch?.apiKey || '').trim()
  });
  // 上游额度/限流类报错的拦截器：群内发人设化短句（同会话 3 分钟一次），详情私聊管理员。
  const errorNotifier = createErrorNotifier({
    windowMs: Math.max(0, Number(cfg.socialV2?.errorNotice?.windowMs) || 3 * 60 * 1000)
  });
  // 风格中心（可选）：用户收藏的 CLIP 画风向量均值（scripts/build-style-center.mjs 生成）。
  // 有新入库的图就用它算画风分（taste 字段），供选图时「优先合画风」。
  // 注意：这里比的是**画风**（CLIP 视觉语义），不是尺寸/清晰度那类画质指标。
  const STYLE_CENTER_FILE = path.join(STATE_DIR, 'style-center.json');
  let styleCenter = null;
  try {
    if (fs.existsSync(STYLE_CENTER_FILE)) {
      const sc = JSON.parse(fs.readFileSync(STYLE_CENTER_FILE, 'utf8'));
      if (Array.isArray(sc?.center) && sc.center.length) {
        styleCenter = sc;
        log(`[图库] 已载入画风中心（基于 ${sc.vectors} 张收藏，中位相似度 ${sc.stats?.median ?? '?'}）`);
      }
    }
  } catch (e) {
    log(`[图库] 画风中心载入失败，画风排序将跳过：${e?.message ?? e}`);
  }

  function imagesEnabled() {
    return cfg.socialV2?.images?.enabled === true;
  }

  /**
   * 已发图清理：定时把「发出超过 sentTtlMs」的图从本地库删掉。
   *
   * 为什么用定时器而不是「发图时顺带清」：发图是零星的，若长时间没人发图，
   * 上一批发出去的图会一直留在盘里（10 分钟到了也不会消失）。定时扫描才能保证
   * "10 分钟后必然删除"这个语义。
   *
   * 只删 useCount>0 的（发过的）——从未发过的是候选池，不能动。
   * 时间基准是 lastUsedAt（最后一次发出），所以刚发完不会被立刻清掉。
   */
  let imageSweepTimer = null;
  function startSentSweep() {
    const ic = cfg.socialV2?.images ?? {};
    const ttl = Number(ic.sentTtlMs) || 0;
    if (!imagesEnabled() || ttl <= 0) return;
    const every = Math.max(10 * 1000, Number(ic.sentSweepMs) || 60 * 1000);
    if (imageSweepTimer) clearInterval(imageSweepTimer);
    imageSweepTimer = setInterval(() => {
      try { imageStore.pruneSent(ttl); } catch (e) { log(`[图库] 已发图清理失败：${e?.message ?? e}`); }
    }, every);
    imageSweepTimer.unref?.(); // 不阻止进程退出
    log(`[图库] 已发图将在发出 ${Math.round(ttl / 60000)} 分钟后自动删除（每 ${Math.round(every / 1000)} 秒扫描）`);
  }

  /**
   * 从已启用的图源拉图并落盘（带冷却与并发去重）。
   * 返回 { added, skipped, errors, cooled }。
   */
  async function refreshImageLib(opts = {}) {
    if (!imagesEnabled()) return { ok: false, error: '图库未启用（config.socialV2.images.enabled）' };
    const ic = cfg.socialV2.images;
    const now = Date.now();
    const cooldown = Number(ic.cooldownMs) || 0;
    if (!opts.force && imageFetchedAt && now - imageFetchedAt < cooldown) {
      return { ok: true, cooled: true, added: 0, errors: [], remainMs: cooldown - (now - imageFetchedAt) };
    }
    if (imageFetching) return imageFetching; // 已在拉：复用同一 Promise

    imageFetching = (async () => {
      const maxBytes = Number(ic.maxBytesPerFile) || 4 * 1024 * 1024;
      const perRun = Math.max(1, Number(opts.limit) || Number(ic.fetchPerRun) || 20);
      // opts 可覆盖查询条件（按需查询：指定标签/排序/时间窗）；不传则是日常补货。
      const { entries, errors, corrections } = await fetchFromSources(ic.sources, {
        limit: perRun,
        tags: opts.tags,
        order: opts.order,
        maxAgeDays: opts.maxAgeDays,
        // 限定图源：只向这些站点发起查询（群主要求「从某站找」时）
        // 注意**不要**把空数组折叠成 undefined：`[]` 表示"一个源都不查"
        // （指定的源都不可用时用它保证空结果），而 undefined 才表示"不限源"。
        sources: Array.isArray(opts.sources) ? opts.sources : undefined,
        // 偏好单人图：查角色时让图源加 `-multiple_girls`，从**源头**避免拉回一堆
        // 大合照（否则库里越攒越多群像，选图时只能"退回群像"）。判断依据是
        // 查询标签是否为角色形态（`name_(franchise)`），通用标签不加。
        preferSingle: ic.preferSingleCharacter !== false,
        // 全局代理：供「直连为主」的源（safebooru）在直连超时时兜底。
        // 本机对 safebooru.donmai.us 实测会直连 ETIMEDOUT，而经代理正常。
        proxy: ic.proxy
      });
      // 记录纠错（实际用哪个标签查到的）。跨作品的纠错必须让调用方知道：
      // 实测事故——机器人把「沃雅妮莎」译成 vanessa，纠错静默换成 vanessa_(kof)（拳皇）
      // 后照常发图，用户要原神的图却收到拳皇角色。
      lastFetchCorrections = corrections ?? [];
      let added = 0;
      let skipped = 0;
      for (const e of entries) {
        if (added >= perRun) break;
        if (imageStore.has(e.id)) { skipped++; continue; }
        try {
          // 走 SSRF 防护的抓取：图源元数据里的 URL 也可能被污染成内网地址。
          // 用明确自报的 UA：safe-fetch 默认的裸 'Mozilla/5.0' 会被图站 CDN 判为
          // 可疑爬虫而 403（实测 donmai.us 如此），换成可识别标识即放行。
          //
          // 需要代理的源（yande.re：本地 DNS 被污染，其图片域名也解析不到）必须走
          // 代理隧道下载，否则元数据能取到、图却下不来（表现为「拉取到 N 条但全失败」）。
          const srcProxy = String(ic.sources?.[e.source]?.proxy ?? ic.proxy ?? '').trim();
          // 每个源可能有额外的下载头要求：pixiv 图床**必须带 Referer** 否则 403（实测）。
          const srcHeaders = SOURCE_DOWNLOAD_HEADERS[e.source] ?? {};
          let buf;
          if (srcProxy) {
            const { proxyGet } = await import('./proxy-tunnel.js');
            const r = await proxyGet(e.url, {
              proxy: srcProxy,
              headers: { 'user-agent': IMAGE_FETCH_UA, ...srcHeaders },
              maxBytes,
              timeoutMs: 45000
            });
            if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
            buf = r.body;
          } else {
            const fetched = await safeFetchBuffer(e.url, maxBytes, { userAgent: IMAGE_FETCH_UA, headers: srcHeaders });
            buf = fetched?.buffer;
          }
          if (!buf?.length) { skipped++; continue; }
          const rec = imageStore.add(buf, e);
          if (rec) {
            // 入库时就算画风分（与用户收藏的 CLIP 画风中心比对），供 pickRandom 优先挑合画风的。
            // 失败不阻塞入库——缺 taste 的图仍可用，只是排序时靠后。
            if (styleCenter) {
              try {
                const vecs = await extractStyleVectors([path.join(imageStore.libDir, rec.file)]);
                const v = vecs?.[0];
                if (v) imageStore.setTaste(rec.id, +cosine(v, styleCenter.center).toFixed(4));
              } catch (err) { log(`[图库] 画风分计算失败 ${e.id}: ${err?.message ?? err}`); }
            }
            added++;
          } else skipped++;
        } catch (error) {
          errors.push(`${e.id}: ${error?.message ?? error}`);
          skipped++;
        }
      }
      imageStore.prune();
      imageFetchedAt = Date.now();
      try {
        const tmp = IMAGE_FETCH_STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ lastFetchedAt: imageFetchedAt }) + '\n', { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, IMAGE_FETCH_STATE_FILE);
      } catch (e) { log(`[图库] 拉取时间写入失败：${e?.message ?? e}`); }
      log(`[图库] 拉取完成：新增 ${added}，跳过 ${skipped}，现有 ${imageStore.count()} 张${errors.length ? `，错误 ${errors.length} 条` : ''}`);
      return { ok: true, added, skipped, errors, total: imageStore.count() };
    })();

    try {
      return await imageFetching;
    } finally {
      imageFetching = null;
    }
  }

  // 发图冷却（按会话），防止被刷图
  const imageSendTimes = new Map(); // key -> number[]
  // 每个会话**最近发出的那张图**（key -> {id, tags, at}）。用途：
  //   ① 群友说「不好看/换一张」时知道该删哪张（图片在消息里只是 [图片]，无法从文本定位）
  //   ② 判断评价是否发生在"刚发图"窗口内（群友常省略"图"字，只说"换一张"）
  const lastSentImage = new Map();
  // 因差评换图的限流（同一会话 90 秒内只换一次，避免连骂连发）
  const imageFeedbackGate = createFeedbackGate({
    cooldownMs: Math.max(0, Number(cfg.socialV2?.images?.feedbackCooldownMs) || 90 * 1000)
  });
  // 「贴表情」的每会话限流（模型自主决定贴不贴，但连贴由桥接拦）。
  const emojiReactGate = createReactionGate({
    cooldownMs: Math.max(0, Number(cfg.socialV2?.emojiReact?.cooldownMs) || 60 * 1000),
    maxPerHour: Math.max(0, Number(cfg.socialV2?.emojiReact?.maxPerHour) || 15)
  });
  // 「群主指定了图站」的会话级记忆。用途见 image-source-hint.js：实测模型经常
  // 不传 sources 参数（日志可见），所以桥接在收到消息时就记下群主要哪个站，
  // 取图时作为**兜底**（模型显式传了 sources 仍以模型为准）。
  const sourceHints = createSourceHintStore({
    ttlMs: Math.max(0, Number(cfg.socialV2?.images?.sourceHintTtlMs) || 10 * 60 * 1000)
  });
  /** 取某会话的源兜底：优先模型显式指定，其次会话记忆，最后不限。 */
  function sourcesWithHint(key, explicit) {
    const n = normalizeSourceFilter(explicit ?? '');
    if (n.requested) return n;
    const h = key ? sourceHints.get(key) : null;
    if (h?.sources?.length) return normalizeSourceFilter(h.sources);
    return n;
  }
  function imageSendAllowed(key, opts = {}) {
    const ic = cfg.socialV2.images;
    const now = Date.now();
    const times = (imageSendTimes.get(key) ?? []).filter((t) => now - t < 3600000);
    // 冷却：防止刷图。但**差评换图要跳过它**——群友通常在图刚发出来几秒内就说
    // 「不好看」，此时冷却必然还没过，若照常拦截就等于"要换却换不了"，机制失效。
    // 每小时上限仍然生效（那是防滥用，与"换一张"的即时性不冲突）。
    if (opts.fromFeedback !== true) {
      const gap = Number(ic.sendCooldownMs) || 0;
      if (gap && times.length && now - times[times.length - 1] < gap) {
        return { ok: false, error: `发图太快了，再等 ${Math.ceil((gap - (now - times[times.length - 1])) / 1000)} 秒` };
      }
    }
    const cap = Number(ic.maxSendPerHour) || 0;
    if (cap && times.length >= cap) {
      return { ok: false, error: `本会话每小时最多发 ${cap} 张图，已达上限` };
    }
    return { ok: true, times };
  }

  /**
   * 发图预检（毫秒级，不下载、不发送）：告诉模型「这次会立刻发出来，还是要现拉等一会儿」。
   *
   * 为什么需要：qq_send_image 在「本地库没有、要现拉」时会阻塞十几秒到几十秒
   * （走代理去图站抓）。这段时间模型卡在工具调用里，同群的新消息只能排队，
   * 表现就是「发了张图之后半天不理人」。让模型事先知道要等，它就能先回一句
   * （「等我找找」）再发图——用感受上的并行替代真并行，这是成本最低的改法。
   *
   * @returns {{hit:boolean, count:number, willWait:boolean, etaMs:[number,number]}}
   */
  /**
   * 群像图偏好设置（传给 imageStore.pickRandom）。
   *
   * 为什么要单独一层：群像图带多个角色标签，查任何角色都能命中（实测群像平均
   * 9.8 个角色标签、单角色图仅 1.0），于是「要什么角色都发同一张大合照」。
   * 默认**优先非群像**，池里一张都没有时才退回群像（总比说「没找到」好）。
   * 配置 socialV2.images.preferSingleCharacter=false 可关掉该偏好。
   */
  /**
   * 规范化「限定图源」参数：接受 'pixiv'、['pixiv','safebooru']、'pixiv,safebooru' 等写法。
   *
   * 关键语义（别写反）：**「没指定」与「指定了但不可用」必须区分开**——
   *   - 没指定 → 不限源（valid 为空、requested=false）
   *   - 指定了但一个都不可用（源名写错 / 该源未启用）→ **必须返回空结果**，
   *     而不是退化成"不限源"。否则群主要「从 pixiv 找」而 pixiv 恰好没启用时，
   *     会拿回别的站的图——正是这个功能要避免的事。
   * 用 `unavailable` 让调用方能把这种情况如实告诉用户。
   *
   * @returns {{requested:boolean, valid:string[], unavailable:string[]}}
   */
  function normalizeSourceFilter(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，\s]+/);
    const requestedNames = [...new Set(list.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean))];
    if (!requestedNames.length) return { requested: false, valid: [], unavailable: [] };
    const enabled = Object.entries(cfg.socialV2?.images?.sources ?? {})
      .filter(([, v]) => v?.enabled === true)
      .map(([k]) => k.toLowerCase());
    const valid = requestedNames.filter((s) => enabled.includes(s));
    const unavailable = requestedNames.filter((s) => !enabled.includes(s));
    return { requested: true, valid, unavailable };
  }

  /** 把源过滤结果转成 imageStore.pickRandom 的 sources 参数。
   *  指定了但全不可用时，用一个**永不匹配的名字**强制空结果（而非"不限源"）。 */
  function sourceFilterForPick(filter) {
    if (!filter.requested) return {};
    if (!filter.valid.length) return { sources: ['__unavailable__'] };
    return { sources: filter.valid };
  }

  function groupImageOpts() {
    const ic = cfg.socialV2?.images ?? {};
    // preferSingleCharacter === false 是显式退出口（恢复"有图总比没图好"）。
    // 默认情况下群像是**排除**而非降权（见 image-store 的注释）。
    if (ic.preferSingleCharacter === false) return { allowGroupImages: true };
    return {
      // 角色标签数达到该值即判为群像/合集图。2026-10-15 按用户要求从 6 提到 10：
      // 「超过 10 个角色那种」才是他要挡的；阈值太低会误伤带多个形态标签的单人图
      // （实测踩过：带 1girl 的单人图因 5 个角色标签被误判成群像）。
      charTagThreshold: Number(ic.groupCharTagThreshold) || 10
    };
  }

  function imagePreflightV2(tags, sources, key = '') {
    const wantTags = Array.isArray(tags) ? tags.map((t) => String(t ?? '').trim()).filter(Boolean) : [];
    // 模型没传 sources 时用会话记忆兜底（见 sourcesWithHint）
    const wantSources = sourcesWithHint(key, sources);
    // 本地命中数：与 pickRandom 同样的 AND 语义（多标签必须全满足）
    let count = 0;
    try {
      const probe = imageStore.pickRandom({ tags: wantTags, dryRun: true, ...sourceFilterForPick(wantSources), ...groupImageOpts() });
      count = Number(probe?.count) || 0;
    } catch { count = 0; }
    const hit = count > 0;
    return {
      hit,
      count,
      willWait: !hit,
      // 估算：本地命中 ~0.1s；现拉取决于图源（pixiv/yandere 走代理较慢）
      etaMs: hit ? [100, 300] : [5000, 30000]
    };
  }

  /**
   * 取一张本地图并发送。返回 { sent, entry } 或 { error }。
   * 带来源标注（画师/出处），这是使用第三方作品的基本要求。
   */
  async function sendImageV2(key, options = {}) {
    if (!imagesEnabled()) throw new Error('图库未启用（config.socialV2.images.enabled）');
    const startedAt = Date.now(); // 用于回传耗时（让模型知道哪些查询"重"）
    const gate = imageSendAllowed(key, { fromFeedback: options._fromFeedback === true });
    if (!gate.ok) throw new Error(gate.error);

    const wantTags = Array.isArray(options.tags) ? options.tags.filter(Boolean) : [];
    // 限定的图源（群主说「从 pixiv 找」时）：本地挑选与现拉都要限制，
    // 否则会返回别的站的图（也可能把别的站的图拉进库）。
    // 模型没传时就吃会话记忆（实测模型经常漏传这个参数）。
    const wantSources = sourcesWithHint(key, options.sources);

    // 取图策略：本地优先 → 未命中就按需回源拉取 → 再取一次。
    // 「按需查询」是这里的核心：群友要「猫」而库里没有时，不该只回一句「没有」，
    // 而应去图源按 cat 标签现拉几张入库再发。日榜/热门同理（order+maxAgeDays）。
    //
    // 差评换图跳过「10 分钟内不重复发」：那张刚被拒的图已经移出图库，
    // 剩下能选的本来就不可能是它。若还按 10 分钟窗口拦，只有一张图可用的角色
    // 会直接报"都发过了"而换不出图——那是把"防重复"变成了"不许换"。
    const recentOpt = options._fromFeedback === true ? { blockRecentMs: 0 } : {};
    let picked = imageStore.pickRandom({ tags: wantTags, ...sourceFilterForPick(wantSources), ...groupImageOpts(), ...recentOpt });
    let fetchedNow = 0;
    let fetchErrors = [];
    // 标签纠错信息：本地命中时也要有（否则 notice 缺失，模型不知道实际查的是哪个词）。
    // 做法是先算一次纠错结果，拉取路径再覆盖成实际那次的值。
    let corrections = [];
    if (wantTags.length) {
      try {
        for (const t of wantTags) {
          const r = await resolveTagName(t);
          if (r && !r.exact && r.postCount > 0) corrections.push({ from: t, to: r.name, postCount: r.postCount });
        }
      } catch { /* 纠错是增强，失败不影响取图 */ }
    }
    if (!picked) {
      const r = await refreshImageLib({
        // 按需查询时绕过冷却：用户正等着，但限定拉取量避免打爆图源
        force: true,
        tags: wantTags,
        // 按需现拉**只拉够用就好**，不要用补货用的 fetchPerRun（默认 20）。
        // 为什么：pixiv 每张要"逐个探测扩展名(1.5~4s) + 经代理下载(7~22s)"，
        // 实测约 10~25 秒/张——拉 20 张就是 3~8 分钟，期间模型完全静默、不能回话，
        // 群主看到的就是「又不理人了」（实测 3 分钟无响应后模型超时重试）。
        // 一条消息只发 1 张，所以按需拉 4 张足够（还留了替换余地：群像降权、
        // 拒过的图、扩展名探测失败等都可能让个别条目不可用）。
        limit: Math.max(1, Number(cfg.socialV2.images?.ondemandFetchCount) || 4),
        order: options.order,
        maxAgeDays: options.maxAgeDays,
        // 限定图源：只去指定站点现拉（否则会拉回别的站的图）
        sources: wantSources.requested ? (wantSources.valid.length ? wantSources.valid : []) : undefined
      }).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
      if (r?.ok && r.added) fetchedNow = r.added;
      // 把上游的失败原因带出来：里面含「上游存在的相近标签」提示，
      // 是模型自我纠正的关键线索（否则它只能反复瞎换词）。
      if (Array.isArray(r?.errors) && r.errors.length) fetchErrors = r.errors;
      // 拉取路径的纠错更权威（是真正执行查询时算出来的），覆盖前置估算。
      if (Array.isArray(lastFetchCorrections) && lastFetchCorrections.length) {
        corrections = lastFetchCorrections.slice();
      }
      picked = imageStore.pickRandom({ tags: wantTags, ...sourceFilterForPick(wantSources), ...groupImageOpts(), ...recentOpt });
    }
    if (!picked) {
      // 「10 分钟内发过」的图被硬过滤掉了，可能就是这个角色可用的都刚发过。
      // 这种情况不能报"没找到"——会让模型以为这角色库里没有，进而换词乱搜。
      // 要告诉它"是刚发过、再等等"，它才知道该怎么回应群友。
      // 换图路径（_fromFeedback）本来就跳过这层，所以不必再判。
      const blocked = (options._fromFeedback !== true && Array.isArray(wantTags) && wantTags.length)
        ? imageStore.pickRandom({
            tags: wantTags,
            ...sourceFilterForPick(wantSources),
            ...groupImageOpts(),
            blockRecentMs: 0 // 关掉本层，看看"是不是只因为刚发过才没得选"
          })
        : null;
      if (blocked) {
        const windowSec = Math.round(
          Math.max(0, Number(cfg.socialV2?.images?.recentSendBlockMs ?? 10 * 60 * 1000)) / 1000);
        throw new Error(
          `「${wantTags.join('/')}」的图在最近 ${Math.round(windowSec / 60)} 分钟内都发过了`
          + `（用户要求同一张图不要重复发）。库里还有别的候选但都在冷却中，`
          + `可以等几分钟再发，或换个角色/主题。**不要**告诉群友"没有这个角色的图"。`
        );
      }
      const base = wantTags.length
        ? `没找到「${wantTags.join('/')}」相关的图（已按需拉取${fetchedNow ? `，新入库 ${fetchedNow} 张` : '，未拉到新图'}）`
        : '图库里没有可用的图，先让管理员刷新一次图库';
      // 把标签提示附上（去掉图源名前缀，避免噪音）
      const hint = fetchErrors
        .map((e) => String(e).replace(/^[a-z_]+:\s*/i, ''))
        .filter((e) => e.includes('相近标签'))
        .join('；');
      // 画师查不到时的专用提示。措辞要克制：**不能断言画师不存在**——
      // 实测 pixiv 按画师名搜图是标签匹配，对确认存在的画师（村カルキ/大津/霧月）
      // 同样返回 0 条，所以「搜不到」推不出「没这人」。只说明限制并给出可靠替代。
      const artistNames = wantTags
        .filter((t) => /^(artist|user):/i.test(String(t)))
        .map((t) => String(t).replace(/^(artist|user):\s*/i, ''));
      // 示例数字 ID：查询本身是数字就沿用，否则给个格式样例
      const idExample = artistNames.find((n) => /^\d+$/.test(n)) ?? '12345678';
      const artistHint = artistNames.length
        ? `。注意：搜不到不代表该画师不存在——pixiv 的作品搜索按标签匹配，画师名常常不是自己作品的标签，实测对确认存在的画师也可能 0 条。别连续换拼写硬试。可靠做法：让群友给 pixiv 主页链接（原样传即可，如 https://www.pixiv.net/users/${idExample}）或数字 ID（artist:${idExample}），桥接会直接按 ID 取图；或改用 safebooru/yande.re（这两个源按画师名搜是可靠的）`
        : '';
      throw new Error(hint ? `${base}。${hint}${artistHint}` : `${base}${artistHint}`);
    }

    // 首轮问 web 工具/GIF 抽帧都不适用于本地图：这里直接把本地文件路径交给 OneBot，
    // 由 SnowLuma 读本地文件上传（避免把整张图 base64 过一遍 HTTP）。
    const [kind, id] = key.split(':');
    const abs = path.join(imageStore.libDir, picked.entry.file);
    // 兜底校验：路径必须在图库目录内（防元数据被污染成任意路径读取）
    if (!path.resolve(abs).startsWith(path.resolve(imageStore.libDir))) {
      throw new Error('图库路径越界，已拒绝发送');
    }
    if (!fs.existsSync(abs)) throw new Error('图片文件丢失，已从图库移除');

    const segments = [];
    if (options.replyToMessageId != null && String(options.replyToMessageId).trim() !== '') {
      // 上游端点已把 seq 解析成真实 messageId（见 resolveReplyTargetV2），这里只做格式校验
      const rid = String(options.replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    segments.push({ type: 'image', data: { file: `file://${abs}` } });
    // 出处标注单独作为一条文字消息，避免「图文混排」在 QQ 上的显示问题。
    const ann = imageAnnotation(picked.entry);

    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`发图失败: ${body.wording || body.retcode || res.status}`);
    }
    recordSentMessage(key, body.data, `［图库图片］${picked.entry.id.slice(0, 16)}`);
    if (ann) {
      // 标注失败不影响图已发出的事实
      try { await onebotSend(kind, id, ann); } catch (error) { log(`图库来源标注发送失败: ${error?.message ?? error}`); }
    }
    imageStore.markUsed(picked.entry.id);
    // 记下这张图是本会话最近发出的：群友之后说「不好看」时要能定位到它。
    lastSentImage.set(key, { id: picked.entry.id, tags: wantTags, at: Date.now(), entry: picked.entry });
    const times = gate.times;
    times.push(Date.now());
    imageSendTimes.set(key, times);
    lastFetchCorrections = [];
    // 记下这次是否走了现拉、花了多久：回给模型，让它知道哪些词"重"，
    // 下次对这类词可以先回一句再发（同一会话内避免反复触发长等待）。
    const elapsedMs = Date.now() - startedAt;
    return {
      sent: true,
      entry: picked.entry,
      annotation: ann,
      // 来源信息单列出来，方便模型被问「这图哪来的」时直接回答：
      //   originUrl  画师的原始发布处（多为 x.com/twitter 原帖）
      //   sourcePage 图源站点上这张图的条目页
      //   source     图源站名（safebooru / pixiv / yandere）
      source: picked.entry.source,
      artist: picked.entry.artist || '',
      originUrl: picked.entry.page || '',
      sourcePage: sourcePageOf(picked.entry),
      fetchedNow,
      tookMs: elapsedMs,
      ...(fetchedNow > 0 && elapsedMs > 3000
        ? { note: `这次是现拉的，花了 ${(elapsedMs / 1000).toFixed(1)} 秒（新入库 ${fetchedNow} 张）。下次要同一个词通常很快（已在本地库）。` }
        : {}),
      ...(corrections.length ? { tagCorrections: corrections } : {})
    };
  }

  /**
   * 收藏一张图的**原图**到专用目录（群主说「保存」时用）。
   *
   * 为什么要回源取原图：图库存的是压缩版（safebooru 用 large、yandere 用 sample，
   * 实测同图库里 96KB / 原图 262KB），且条目里没存 url 字段，拿不到直链。
   * 细节见 image-archive.js。
   *
   * @param {object} entry 图库条目
   * @returns {Promise<object>} 保存结果（含绝对路径、原图 URL、字节数）
   */
  async function archiveImage(entry) {
    const ic = cfg.socialV2?.images ?? {};
    const dir = String(ic.archiveDir || '').trim();
    if (!dir) throw new Error('未配置收藏目录（socialV2.images.archiveDir）');
    const maxBytes = Math.max(1024 * 1024, Number(ic.maxBytesPerFile) || 8 * 1024 * 1024) * 8; // 原图可比库内文件大得多
    // **只认源级代理**（如 yandere/pixiv 配了 proxy）。刻意不 fallback 到全局 ic.proxy：
    // 全局代理是给"直连不通的源"兜底的，而 safebooru 直连正常——若把它的请求也丢进
    // 代理，一旦代理被限流就会连带失败（实测收藏 safebooru 图报 TLS 断开，而直连明明能通）。
    const srcProxy = String(ic.sources?.[entry.source]?.proxy ?? '').trim();
    // 直连失败时的兜底代理（仅在源没配代理但全局有配置时用）
    const fallbackProxy = String(ic.proxy ?? '').trim();

    // 复用现拉那套下载实现：带源专属头（pixiv 图床必须 Referer）与代理兜底
    const fetchBuffer = async (url, { referer = '' } = {}) => {
      const headers = { 'user-agent': IMAGE_FETCH_UA, ...(SOURCE_DOWNLOAD_HEADERS[entry.source] ?? {}), ...(referer ? { referer } : {}) };
      if (srcProxy) {
        const { proxyGet } = await import('./proxy-tunnel.js');
        const r = await proxyGet(url, { proxy: srcProxy, headers, maxBytes, timeoutMs: 90000 });
        if (r.status < 200 || r.status >= 300) throw new Error(`下载原图 HTTP ${r.status}`);
        return r.body;
      }
      try {
        const fetched = await safeFetchBuffer(url, maxBytes, { userAgent: IMAGE_FETCH_UA, headers });
        if (fetched?.buffer?.length) return fetched.buffer;
        throw new Error('下载得到空内容');
      } catch (error) {
        // 直连失败才退代理（与 image-sources 的 fetchJson 兜底同一策略）
        if (!fallbackProxy) throw error;
        log(`[图库] 直连下载原图失败（${error?.message ?? error}），改走代理重试`);
        const { proxyGet } = await import('./proxy-tunnel.js');
        const r = await proxyGet(url, { proxy: fallbackProxy, headers, maxBytes, timeoutMs: 90000 });
        if (r.status < 200 || r.status >= 300) throw new Error(`下载原图 HTTP ${r.status}`);
        return r.body;
      }
    };

    // 回源查原图直链：源配了代理就走代理；否则先直连、失败再退代理。
    const jsonFetch = async (url, extra = {}) => {
      const headers = { 'user-agent': IMAGE_FETCH_UA, accept: 'application/json', ...(extra.referer ? { referer: extra.referer } : {}) };
      const parse = (txt) => JSON.parse(txt);
      if (srcProxy) {
        const { proxyGet } = await import('./proxy-tunnel.js');
        const r = await proxyGet(url, { proxy: srcProxy, headers, timeoutMs: 40000 });
        if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
        return parse(r.body.toString('utf8'));
      }
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
        if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
        return await r.json();
      } catch (error) {
        if (Number.isFinite(error?.status) || !fallbackProxy) throw error;
        const { proxyGet } = await import('./proxy-tunnel.js');
        const r = await proxyGet(url, { proxy: fallbackProxy, headers, timeoutMs: 40000 });
        if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
        return parse(r.body.toString('utf8'));
      }
    };

    return saveOriginalImage(entry, {
      dir, fetchBuffer, jsonFetch, log: (m) => log(`[图库] ${m}`), maxBytes,
      overwrite: ic.archiveOverwrite === true
    });
  }

  // 生成来源标注文案（画师/出处）。可在 config 关闭。
  function imageAnnotation(entry) {
    if (cfg.socialV2?.images?.annotateSource === false) return '';
    const bits = [];
    if (entry.artist) bits.push(`画师 ${entry.artist}`);
    if (entry.page) bits.push(entry.page);
    // 图源站点页：与原始出处不同（page 常是画师的 x.com 原帖），
    // 群友想「去那个图站看看」时给这个更有用。
    const sp = sourcePageOf(entry);
    if (sp && sp !== entry.page) bits.push(`${entry.source || '来源'}：${sp}`);
    if (!bits.length) return '';
    const text = `图源 ${entry.source || ''}｜${bits.join('｜')}`.trim();
    return text.slice(0, 300);
  }

  function stickerEnabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      const response = await bot.request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched);
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  async function sendStickerV2(key, stickerRef, options = {}) {
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      // 上层已把 seq 解析成真实 messageId（见 resolveReplyTargetV2），这里只做格式校验
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 发送前校验表情 URL 必须是公网 http(s)，防止本地库被污染后诱导 OneBot 抓取内网/本机地址。
    try {
      await validateFetchUrl(url);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
    }
    segments.push({ type: 'image', data: { file: url } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        recordSentMessage(key, body.data, `［表情］${entry.id.slice(0, 16)}`);
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 删除一个收藏表情（delete_custom_face）。
  //
  // ⚠️ 这个上游接口**不校验 emoji_id** —— 实测传假值 "0" 也返回成功并真删掉了一个表情
  // （2026-10-15 排查时误删过，靠本地库 URL 恢复）。所以**校验必须由我们自己做**：
  //   1. 先同步、再用 findSticker 在本地库确认这个 ref 真的对应某个收藏表情；
  //      找不到就报错拒绝（绝不让未校验的字符串直接进上游）。
  //   2. 删除前把该条目完整写进 state/stickers-deleted-<时间>.json，
  //      含 url/md5，可用 scripts/delete-sticker.mjs --restore 恢复。
  //   3. 删完回读校验（拉一次收藏列表），确认确实消失了才回报成功。
  async function deleteStickerV2(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry?.id) {
      throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效的 id / md5`);
    }
    // 删前备份（可恢复是底线）
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(STATE_DIR, `stickers-deleted-${stamp}.json`);
      fs.writeFileSync(backupFile, JSON.stringify({
        deletedAt: new Date().toISOString(),
        by: 'agent-tool',
        entries: [entry]
      }, null, 2), 'utf8');
    } catch (error) {
      log(`[sticker] 删前备份失败（继续但不可恢复）：${error?.message ?? error}`);
    }
    // 记下预期 md5，用于删后回读校验
    const expectMd5 = String(entry.md5 || '').toUpperCase();
    const response = await bot.request('delete_custom_face', { emoji_id: entry.id });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`delete_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    // 回读校验：接口不校验参数，只能自己确认它真的没了
    let gone = true;
    try {
      const after = await syncStickerLibrary(true);
      const list = after?.entries ?? stickerEntries;
      if (expectMd5) gone = !findSticker(list, expectMd5);
    } catch { /* 回读失败不影响"已发起删除"的事实，只记录 */ }
    // 本地库同步移除（保留 desc 便于日志）
    const desc = String(entry.desc || entry.localNote || '').slice(0, 20);
    stickerEntries = stickerEntries.filter((e) => e.id !== entry.id);
    saveStickerStoreSafe();
    return { id: entry.id, md5: expectMd5, desc, verifiedGone: gone };
  }

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  async function collectStickerV2(key, messageRef, remark) {
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    const addRes = await bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }

  function saveSlangStore() {
    try { saveSlang(SLANG_FILE, slangEntries); } catch (error) { log('保存黑话库失败:', error?.message ?? error); }
  }

  function queueSlangTask(fn) {
    slangTaskChain = slangTaskChain.then(fn).catch((error) => log('黑话学习任务异常:', error?.message ?? error));
    return slangTaskChain;
  }

  async function ensureSlangLearnerSession() {
    if (slangLearnerSessionId) {
      learnerSessions.add(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    const saved = readJsonSafe(SLANG_SESSION_FILE, null);
    if (saved?.sessionId) {
      slangLearnerSessionId = String(saved.sessionId);
      learnerSessions.add(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    const preset = cfg.slang?.learnerPreset || cfg.agentPreset || undefined;
    if (preset) params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    slangLearnerSessionId = value.sessionId;
    learnerSessions.add(slangLearnerSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId });
    log(`黑话学习会话已创建：${slangLearnerSessionId}`);
    return slangLearnerSessionId;
  }

  function invalidateSlangLearnerSession() {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = slangLearnerSessionId;
    slangLearnerSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}
  }

  function waitLearnerTurn(sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  async function runSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const promptText = buildExtractionPrompt(messages);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const items = parseExtractionJson(output);
      if (!items.length) {
        log(`黑话提取：${key} 未发现候选`);
        const win = slangWindows.get(key) ?? [];
        slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(slangEntries, item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = slangWindows.get(key) ?? [];
      slangWindows.set(key, win.slice(messages.length));
      saveSlangStore();
      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log(`黑话提取失败 (${key}):`, error?.message ?? error);
    }
  }

  async function runSlangResearch(candidates) {
    if (!candidates || !candidates.length) return;
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
    const targets = candidates.filter((e) => e && !slangResearchingIds.has(e.id));
    if (!targets.length) return;
    for (const e of targets) slangResearchingIds.add(e.id);
    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      for (const e of targets) slangResearchingIds.delete(e.id);
      log('黑话研究会话创建失败:', error?.message ?? error);
      return;
    }
    const promptText = buildResearchPrompt(targets);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const results = parseResearchJson(output);
      for (const r of results) {
        const entry = slangEntries.find((e) => e.content === r.content);
        if (!entry) continue;
        // 只有明确确认（confirmed: true）的结果才写入解释字段；
        // 不确定/未确认的结果保留原状，允许后续再次研究。
        if (r.confirmed !== true) {
          log(`黑话研究：${r.content} 未确认，保留候选待后续研究`);
          continue;
        }
        if (r.meaning) entry.meaning = r.meaning;
        if (r.usage) entry.usage = r.usage;
        if (r.example) entry.example = r.example;
        if (r.risk) entry.risk = r.risk;
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        entry.lastInferenceCount = entry.count;
        entry.updatedAt = new Date().toISOString();
      }
      saveSlangStore();
      log(`黑话研究：已更新 ${results.length} 条候选解释`);
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log('黑话研究失败:', error?.message ?? error);
    } finally {
      for (const e of targets) slangResearchingIds.delete(e.id);
    }
  }

  function maybeQueueSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const cooldown = Number(cfg.slang?.extractCooldownMs ?? 300000);
    const last = slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    slangExtractionCooldowns.set(key, Date.now());
    queueSlangTask(() => runSlangExtraction(key));
  }

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。一代/二代共用。
  function feedSlangWindow(key, sender, plainContent) {
    if (cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!slangWindows.has(key)) slangWindows.set(key, []);
    const win = slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: text.slice(0, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueSlangExtraction(key);
  }

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  function allowSlangSubmit(key) {
    const now = Date.now();
    const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    slangSubmitTimes.set(key, arr);
    return true;
  }

  // 返回给 AI/控制台的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  function publicSlangEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      evidence: Array.isArray(e?.evidence) ? e.evidence.slice(-5) : [],
      updatedAt: e?.updatedAt ?? ''
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedSlangListV2() {
    const max = Math.max(1, Math.min(30, Number(cfg.slang?.injectMax) || 8));
    return slangEntries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicSlangEntry);
  }

  function withSlangContext(promptText) {
    const now = new Date();
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [timeLine];
    if (cfg.slang?.enabled !== false) {
      const block = buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8);
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl);
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  // 本回合已自动 @ 过的会话（sessionId → 上次 @ 的时间戳）。
  //
  // 为什么需要：模型回同一个人时常常**分多次调用** qq_send_message（实测 17:55:43 /
  // 17:55:56 / 17:56:09 三次单条发送），而 autoAt 每次都会独立掷骰。
  // 单次调用内部本来就只有第一条带 @（sendMessagesV2 里 `i === 0` 限定），
  // 但跨调用会叠加，同一个人可能连着被 @ 两三次——比不 @ 更像催债。
  // 有了这个标记：**一个回合内最多 @ 一次**。
  const autoAtTurnDone = new Map(); // sessionId -> 时间戳
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  const activeWaits = new Set(); // key：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起
  // ── 值班循环硬上限（成因 G 防复发）────────────────────────────────────
  // 活跃群里模型会陷入「唤醒→wait→观察→收尾」的循环：要么单回合无限延长
  // （实测 48 分钟 / 22 步 / 上下文 40 万 token），要么每回合都正常结束但立刻被
  // 新消息再次唤醒（实测同一群 1 小时内 32 次唤醒、0 次发言）。两种形态都会让
  // isConversationBusyV2 长期为 true，新唤醒（含 @）只能排队——表现为「不理人」。
  // 用跨回合的滑动窗口计数（不按回合分桶，因为每回合计数会被重置）：
  // 最近 WAIT_WINDOW_MS 内 wait 超过 WAIT_WINDOW_MAX 次即强制收尾。
  const waitTurnStats = new Map(); // key -> number[]（最近若干次 wait 的时间戳）
  const WAIT_WINDOW_MS = 12 * 60 * 1000;
  const WAIT_WINDOW_MAX = 8;
  // 单回合硬上限：无论滑动窗口是否过期，同一个 DSH turn 内等待超过 2 次或累计 120s
  // 就强制收尾。实测活跃群会连续 wait 6 次、单回合拖到 24 分钟，期间所有新消息排队。
  const waitTurnTotals = new Map(); // sessionId -> { turnStart, count, totalMs }
  const WAIT_TURN_MAX_MS = 120000;
  const WAIT_TURN_MAX_COUNT = 2;
  // quietMs 只用于判断“对方是否说完”，不应让一次 wait 超过总超时太多。
  // 模型实测传 75~80s，旧实现会放大到 timeout + maxQuietMs（245s）；这里硬压到 15s。
  const WAIT_QUIET_CAP_MS = 15000;
  const FORCE_WRAPUP_HINT = '桥接强制收尾：你已连续多轮只观察不发言，群里可能有人在等你回应，而排队中的消息无法被处理。请立即结束本回合——不要再调用任何工具（包括 qq_wait_for_messages / qq_mark_read / qq_set_wake_config），直接输出一句简短结束语即可。需要安静一会儿的话，请先正常结束回合，下一次唤醒时用 qq_set_wake_config 设置较长的潜水时长。';
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  let dshCheckStarted = false;
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  let closedAgentPreset = 'router-standard'; // closed-agent 模式使用的 DSH agent preset
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [] });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  const VALID_MODES = ['chat', 'closed-agent', 'reserved', 'reserved2'];
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      if (ns?.value && typeof ns.value.mode === 'string' && VALID_MODES.includes(ns.value.mode)) {
        currentMode = ns.value.mode;
        // DSH 设置页也可配置管理员 QQ；未设置该字段时不覆盖 config.json。
        if (ns.value.ownerQQ !== undefined) {
          try {
            cfg.ownerQQ = normalizeOwnerQQ(ns.value.ownerQQ);
          } catch (error) {
            log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
          }
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    if (local?.mode && VALID_MODES.includes(local.mode)) currentMode = local.mode;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      closedAgentPreset = local.closedAgentPreset;
    }
  }

  // ── QQ 好友列表缓存（私聊准入 'friends' 模式用）─────────────────────────
  // 为什么要真问 QQ 而不是看事件里的 sub_type：sub_type 只区分「好友私聊 / 临时会话」，
  // 而我们要的判据是「这个 QQ 是不是我好友」——get_friend_list 直接给答案，更准。
  // 设计：**后台预热 + 定期刷新**，让 modeAllowed 保持同步（它有 18 个调用点，
  // 全改成 async 既费事又容易漏）。启动时拉一次，之后每 5 分钟刷新。
  let friendIds = new Set();
  let friendIdsAt = 0;
  let friendListLoading = null;
  const FRIEND_LIST_TTL_MS = 5 * 60 * 1000;
  // 私聊被拒时「强制刷新好友列表」的全局限流时间戳。
  // 防止非好友持续发消息把桥接变成打 SnowLuma 接口的放大器（见 handleIncoming 注释）。
  let lastFriendForceRefreshAt = 0;
  const FRIEND_FORCE_REFRESH_MS = 30 * 1000;
  async function refreshFriendList({ force = false } = {}) {
    if (!force && Date.now() - friendIdsAt < FRIEND_LIST_TTL_MS) return friendIds;
    if (friendListLoading) return friendListLoading;
    friendListLoading = (async () => {
      try {
        const list = await withTimeout(bot.getFriendList(), 10000, '获取好友列表');
        const next = new Set();
        for (const f of (Array.isArray(list) ? list : [])) {
          const uid = String(f?.user_id ?? '').trim();
          if (uid) next.add(uid);
        }
        // 机器人自己也会出现在列表里（自聊会话），剔掉避免"给自己放行"
        if (selfQQ) next.delete(String(selfQQ));
        friendIds = next;
        friendIdsAt = Date.now();
        return friendIds;
      } catch (error) {
        // 拿不到就沿用上一次的结果（可能是空的）；调用方按 fail-closed 处理。
        log(`获取好友列表失败（沿用上次缓存）：${error?.message ?? error}`);
        return friendIds;
      } finally {
        friendListLoading = null;
      }
    })();
    return friendListLoading;
  }

  /**
   * 私聊准入判定（叠加在 allowed() 之前）。
   *
   * 三种策略（config.json 的 `allow.privateMode`）：
   *   - `'list'`    ：不干预，交回 allowed() 走白名单 —— 旧行为，默认
   *   - `'friends'` ：除 deny 外，**QQ 好友自动放行**；非好友（临时会话）仍需命中 allow.private
   *   - `'all'`     ：除 deny 外全放行（**纯黑名单制**）——群里任何人都能通过临时会话私聊，慎用
   *
   * `deny` 优先级最高：即使命中 allow / 是好友，被 deny 也一律拒。
   * 单个好友名单来源是**缓存**（见 refreshFriendList）：同步判定，避免改动 18 个调用点。
   */
  function privateAllowed(id, cfg) {
    const s = String(id);
    const denyList = (Array.isArray(cfg.deny?.private) ? cfg.deny.private : []).map(String);
    if (denyList.includes(s)) return false;
    const mode = cfg.allow?.privateMode ?? 'list';
    if (mode === 'all') return true;
    if (mode === 'friends' && friendIds.has(s)) return true;
    // 'list' 模式、或 'friends' 下非好友（临时会话）：交回白名单
    return allowed('private', id, cfg);
  }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    if (kind === 'private') return privateAllowed(id, cfg);
    return allowed(kind, id, cfg);
  }

  /**
   * 当前这一轮请求是不是管理员发起的（用于"仅管理员可用"的写操作，如删表情）。
   *
   * 为什么按 st.lastRequesterId 判而不是看会话类型：群里管理员和群友共用同一个会话，
   * 「当前模式允许该会话」只说明这个群在白名单里，不等于"刚说话的人是管理员"。
   * 判据取**最近一条入站消息的发送者** —— DSH 的每次 prompt 都由某条消息触发，
   * 那条就是本次请求的发起人。
   *
   * fail-closed：拿不到发起人（老状态/无 userId）时返回 false，宁可拒绝。
   */
  /**
   * 本回合的请求者是不是后台管理员（owner）。
   *
   * 两层判据，缺一不可：
   *   ① 最近一条入站消息就是管理员发的 → 直接通过；
   *   ② 否则看**时间窗**：管理员在最近 N 分钟内说过话 → 也算。
   *
   * ② 是为了修「删不掉表情包」（2026-10-22 用户反馈）。实测时间线：
   *   13:55:48 管理员说"把这个表情包删了"
   *   13:56:06 群友拍一拍 → lastRequesterId 被覆盖
   *   13:56:35 模型才调删除工具 → 判成非管理员、拒绝
   * 管理员的请求被后续闲聊冲掉，群越热闹越容易发生。模型从"看到消息"到
   * "调用工具"可能隔几十秒（它会先回一句、再想、再调），这期间别人插话很常见。
   *
   * 窗口给 5 分钟：够覆盖模型的思考与多轮工具调用，又不至于把"很久以前
   * 管理员说过话"也算成授权。可用 socialV2.adminCommandWindowMs 调整。
   */
  function isOwnerTurn(key) {
    const owner = String(cfg.ownerQQ ?? '').trim();
    if (!owner) return false;
    const st = getSocialV2State(key);
    const requester = String(st?.lastRequesterId ?? '').trim();
    if (requester && requester === owner) return true;
    const winMs = Math.max(0, Number(cfg.socialV2?.adminCommandWindowMs ?? 5 * 60 * 1000));
    const spokeAt = Number(st?.ownerSpokeAt) || 0;
    return winMs > 0 && spokeAt > 0 && Date.now() - spokeAt <= winMs;
  }

  /** 当前模式下的会话预设 */
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') return closedAgentPreset || 'router-standard';
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设
    if (mode === 'reserved2') return cfg.socialV2?.agentPreset || cfg.agentPreset || undefined;
    return cfg.agentPreset || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, currentMode);
  }

  let flushingQueue = false;
  const flushQueue = async () => {
    if (flushingQueue) return;
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [] });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
    }
  };
  const checkDsh = async () => {
    let ok = false;
    try {
      await api.host.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshMode();
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        log(`DSH 已就绪（模式: ${currentMode}）`);
        if (currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
          // 补投「进程重启前积压的未读」：重启会清空内存队列（queued），而
          // state/social-v2.json 里的 unread 是持久化的。若不主动补一次唤醒，
          // 重启前群友@它的消息会被永久搁置，直到群里再来新消息才顺带处理——
          // 表现为「机器人不理人」（实测：重启前 6 条未读含 @点名，重启后一直不回）。
          scheduleStartupBackfillV2();
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
        // 已发图定时清理（sentTtlMs>0 才启用）
        startSentSweep();
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved' && currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (lastMode === 'reserved2' && currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (currentMode === 'reserved2' && lastMode !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else if (dshReady) {
      dshReady = false;
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  function startConsoleServer() {
    const port = cfg.consolePort ?? 3100;
    // 控制台鉴权：
    //   - `consoleAuth: false` → **不要求令牌**（用户要求：每次刷新都要填太麻烦）。
    //   - 否则：优先用 config.consoleToken，未配置则自动生成并持久化到 state/console-token。
    //
    // 为什么每次刷新都会问：浏览器直接访问 `/` 是普通导航，**没法带自定义请求头**，
    // 所以即便 localStorage 里存着令牌，根路径那一步仍然 401 → 弹 prompt；
    // `?token=` 进来的那次会被前端 replaceState 从地址栏抹掉，于是下次刷新又丢。
    // 关掉鉴权就绕过了这个死循环。
    //
    // 关闭后仍保留两道防线（见下方 CSRF 段）：
    //   ① 只监听 127.0.0.1（外网/局域网访问不到）；
    //   ② 写操作必须是 application/json 且 Origin 为本机页面——
    //      这能挡住「别的网页用表单/图片/跨站 fetch 打 /api/restart 这类破坏性接口」。
    const authDisabled = cfg.consoleAuth === false;
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = authDisabled ? '' : (tokenValid ? configuredToken : loadOrCreateConsoleToken());
    if (authDisabled) log('控制台鉴权已关闭（config.consoleAuth=false）：不校验令牌，仅监听 127.0.0.1 + 写操作校验 Origin');
    else if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    else if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
    // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
    // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    const agentTokenOk = (key, token) => {
      const canonical = canonicalV2Key(key);
      const st = socialV2.conversations.get(canonical ?? key);
      return !!st && !!st.agentToken && token === st.agentToken;
    };
    // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const v2SessionAllowed = isSessionAllowedInCurrentMode;
    const v2ToolEnabled = (flag) => cfg.socialV2?.tools?.[flag] !== false;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        // img-src / media-src / connect-src 需要单独放行 blob:。
        //
        // 为什么（两次都踩到，症状都极隐蔽）：
        //   ① 2026-10-21「生成报表图」：fetch → Blob → createObjectURL → <img>。
        //      `default-src 'self'` 不含 blob:，图被静默拦掉——
        //      img 在、complete 为 true、naturalWidth 却是 0，页面只剩 alt 文字。
        //   ② 2026-10-22「试听一句」：<audio src=blob:...> 同理。
        //      media-src 没放行 → 播放器空白；页面内 fetch(blob:) 也失败
        //      （TypeError: Failed to fetch），因为 connect-src 也没放行。
        //      表面看是"按钮点了没反应"，实际是 CSP 静默拦截。
        // 只放开这三类（分别是图片、音视频、同页 fetch），script-src 仍限 self。
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; "
          + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
          + "media-src 'self' blob: data:; connect-src 'self' blob: data:",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      // 请求体读取。默认上限 1MB（控制台/配置类请求都远小于此，
      // 收得紧一些可以挡掉恶意大包），个别需要传图片的路由可以显式放宽。
      //
      // 为什么要能放宽（2026-10-19）：超分回传要 POST 一张 base64 图片，
      // 800×652 的 PNG 就 600KB、编码后 800KB，稍微大一点就撞 413。
      // 但**不放宽全局**——只有白名单里的路由能申请大上限，其余仍受 1MB 约束。
      //
      // 注意这里管的是**第一跳**（MCP → 桥接），不是发到 QQ 的那一跳：
      //   链路是 MCP --base64--> 桥接(:3100) --base64--> OneBot(:3000) --> QQ
      //   第一跳放宽到 8MB 只是让请求进得来；第二跳受 OneBot 自身限制（实测 base64
      //   超过约 2MB 就直接 ECONNRESET，且不返回错误码），那个改不了，只能靠
      //   MCP 侧提前压到 1.3MB 原始字节（≈1.73MB base64）。两者是**并存**的，
      //   不是二选一：只放宽第一跳，图会在第二跳静默失败（实测 6.8MB base64：
      //   第一跳 500「发送失败: fetch failed」= 它成功收到了大图、但转发时被 OneBot 拒绝）。
      const BIG_BODY_ROUTES = new Set(['/api/socialV2/send-upscaled']);
      const readBody = (options = {}) => new Promise((resolve, reject) => {
        // 路由级上限：只允许白名单路由申请，且不得超过 8MB（够放 3~4MB 图片的 base64）。
        const routeWantsBig = BIG_BODY_ROUTES.has(String(options.route ?? ''));
        const MAX_BODY_BYTES = routeWantsBig
          ? Math.min(8_000_000, Number(options.maxBytes) || 8_000_000)
          : 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      // 注意：MCP 工具（AI 侧）调用时**同时**带 x-console-token 和 x-agent-token
      // （见 mcp-snowluma-safe.js 的 agentApi：它会读 state/console-token 补上），
      // 所以这里不需要为 agent 调用开豁免——曾误加过一个 AGENT_CALLABLE 白名单，
      // 既多余（请求本来就带 console token）又危险（会绕开控制台令牌）。
      const suppliedToken = url.searchParams.get('token') ?? req.headers['x-console-token'];
      if (consoleToken && suppliedToken !== consoleToken) {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
        } else {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        }
        return;
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = readRoleState();
          sendJson({
            mode: currentMode,
            closedAgentPreset,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady,
            ownerQQ: cfg.ownerQQ ?? null,
            allowGroups: cfg.allow?.groups ?? [],
            allowPrivate: cfg.allow?.private ?? [],
            // 私聊准入策略与好友数：控制台状态栏按它显示"好友自动放行/纯黑名单/白名单"
            privateMode: cfg.allow?.privateMode ?? 'list',
            friendCount: friendIds.size,
            socialV2Paused: socialV2.paused,
            activity: readActivityTail(100)
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          sendJson({ presets });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/mode') {
          const body = await readBody();
          if (!['chat', 'closed-agent', 'reserved', 'reserved2'].includes(body.mode)) {
            sendJson({ ok: false, error: 'mode 必须是 chat / closed-agent / reserved / reserved2' }, 400);
            return;
          }
          const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
          const next = {
            mode: body.mode,
            ...(body.closedAgentPreset ? { closedAgentPreset: String(body.closedAgentPreset) } : { closedAgentPreset: existing.closedAgentPreset ?? 'router-standard' })
          };
          atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
          if (next.closedAgentPreset) closedAgentPreset = next.closedAgentPreset;
          if (currentMode === 'reserved' && body.mode !== 'reserved') {
            cleanupSocialForModeChange();
            log('控制台：模式离开一代仿真模式，清理社交状态');
          }
          if (currentMode === 'reserved2' && body.mode !== 'reserved2') {
            clearAllSocialV2Timers();
            drainAllPromptQueues('模式切换，已取消排队中的投递');
            log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          currentMode = body.mode;
          lastMode = body.mode;
          if (body.mode === 'reserved2') {
            for (const key of socialV2.conversations.keys()) {
              setupSleepTimerV2(key);
              scheduleProactiveCheckV2(key);
            }
            log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          log(`控制台：模式已设置为 ${body.mode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}`);
          sendJson({ ok: true, mode: body.mode, closedAgentPreset: next.closedAgentPreset });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role') {
          const body = await readBody();
          const rs = readRoleState();
          if (body.role && typeof body.role === 'string') {
            const name = sanitizeRoleName(body.role);
            if (!fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
              sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
              return;
            }
            writeRoleState(name, rs.mode);
            log(`控制台：角色已设置为 ${name}`);
            sendJson({ ok: true, role: name });
          } else {
            writeRoleState(null, rs.mode);
            log('控制台：角色已清除');
            sendJson({ ok: true, role: null });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role-mode') {
          const body = await readBody();
          const rs = readRoleState();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          writeRoleState(rs.role, mode);
          log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          sendJson({ ok: true, roleMode: mode });
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles') {
          const rs = readRoleState();
          sendJson({ roles: listRoles(), current: rs.role ?? null });
          return;
        }
        // 读取单个角色的 Markdown 原文（控制台用来在卡片里渲染人格内容）。
        // 直接读文件而不是维护副本：角色卡是热更新的（改完下次读就生效），
        // 缓存一份反而会出现"控制台看到的和实际用的不一致"。
        if (req.method === 'GET' && url.pathname === '/api/role-content') {
          const name = String(url.searchParams.get('name') ?? '').trim();
          if (!name) { sendJson({ ok: false, error: 'name 不能为空' }, 400); return; }
          // 走与创建/设置同一套名字校验，既防路径穿越（../）也保证与列表口径一致
          const safe = sanitizeRoleName(name);
          if (!safe || safe !== name) { sendJson({ ok: false, error: '角色名不合法' }, 400); return; }
          const roleFile = path.join(ROOT, 'roles', safe + '.md');
          if (!fs.existsSync(roleFile)) { sendJson({ ok: false, error: `角色「${safe}」不存在` }, 404); return; }
          try {
            const content = fs.readFileSync(roleFile, 'utf8');
            sendJson({ ok: true, name: safe, content, bytes: Buffer.byteLength(content, 'utf8') });
          } catch (error) {
            sendJson({ ok: false, error: `读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/create') {
          const body = await readBody();
          const name = sanitizeRoleName(body.name);
          const content = String(body.content ?? '').trim();
          if (!name) { sendJson({ ok: false, error: '角色名不能为空（仅限中文/字母/数字/横线）' }, 400); return; }
          if (!content) { sendJson({ ok: false, error: '角色内容不能为空' }, 400); return; }
          if (name === 'README') { sendJson({ ok: false, error: '该名称被保留' }, 400); return; }
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (fs.existsSync(roleFile)) { sendJson({ ok: false, error: `角色「${name}」已存在` }, 400); return; }
          fs.mkdirSync(path.join(ROOT, 'roles'), { recursive: true });
          atomicWriteText(roleFile, content + (content.endsWith('\n') ? '' : '\n'));
          log(`控制台：创建人格「${name}」`);
          sendJson({ ok: true, role: name });
          return;
        }
        // 删除角色卡。控制台原先只能建不能删，测试也只能直接删文件——但测试脚本
        // 与桥接未必在同一个目录（跑在别处的克隆会删错地方、留下永远清不掉的角色）。
        // 走这个端点后，路径由桥接自己解析，调用方在哪儿都一致。
        if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
          const body = await readBody();
          const name = sanitizeRoleName(body.name);
          if (!name) { sendJson({ ok: false, error: '角色名不能为空' }, 400); return; }
          if (name === 'README') { sendJson({ ok: false, error: '该名称被保留' }, 400); return; }
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) { sendJson({ ok: false, error: `角色「${name}」不存在` }, 404); return; }
          // 正在使用的角色被删掉会让 current-role.json 指向空文件，先清掉当前角色。
          // 保留原 mode，否则删个角色会顺手把静默/活跃状态重置掉。
          try {
            const rs = readRoleState();
            if (rs.role === name) writeRoleState(null, rs.mode);
          } catch { /* 状态损坏不应阻止删除文件 */ }
          try {
            fs.unlinkSync(roleFile);
          } catch (error) {
            sendJson({ ok: false, error: `删除失败：${error?.message ?? error}` }, 500);
            return;
          }
          log(`控制台：删除人格「${name}」`);
          sendJson({ ok: true, role: name, roles: listRoles() });
          return;
        }
        // ── 黑话库管理 ──────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/slang') {
          const status = url.searchParams.get('status') || '';
          const list = status ? slangEntries.filter((e) => e.status === status) : slangEntries;
          sendJson({ entries: list, config: cfg.slang });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang') {
          const body = await readBody();
          const content = String(body.content ?? '').trim();
          if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          if (slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
          const entry = createSlangEntry({
            content,
            meaning: String(body.meaning ?? '').trim(),
            usage: String(body.usage ?? '').trim(),
            example: String(body.example ?? '').trim(),
            risk: String(body.risk ?? '').trim(),
            sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
            status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
            source: 'manual',
            evidence: Array.isArray(body.evidence) ? body.evidence : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          log(`控制台：新增黑话「${content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
          const body = await readBody();
          const status = String(body.status ?? '').trim();
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
            return;
          }
          let removedCount = 0;
          if (status) {
            removedCount = slangEntries.filter((e) => e.status === status).length;
            slangEntries = slangEntries.filter((e) => e.status !== status);
          } else {
            removedCount = slangEntries.length;
            slangEntries = [];
            // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
            slangWindows.clear();
            slangExtractionCooldowns.clear();
            slangSubmitTimes.clear();
            slangResearchingIds.clear();
          }
          saveSlangStore();
          log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          const status = String(body.status ?? '').trim();
          if (ids.length) {
            const idSet = new Set(ids);
            const before = slangEntries.length;
            slangEntries = slangEntries.filter((e) => !idSet.has(e.id));
            const removedCount = before - slangEntries.length;
            if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
            saveSlangStore();
            log(`控制台：批量删除黑话 ${removedCount} 条`);
            sendJson({ ok: true, removedCount });
            return;
          }
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
            return;
          }
          if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
          const removedCount = slangEntries.filter((e) => e.status === status).length;
          slangEntries = slangEntries.filter((e) => e.status !== status);
          saveSlangStore();
          log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
          let confirmedCount = 0;
          let skippedCount = 0;
          const skipped = [];
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
            const entry = slangEntries[idx];
            if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
            entry.status = SLANG_STATUS.CONFIRMED;
            entry.updatedAt = new Date().toISOString();
            confirmedCount++;
          }
          if (confirmedCount) saveSlangStore();
          log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
          sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
          let rejectedCount = 0;
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) continue;
            const entry = slangEntries[idx];
            if (entry.status === SLANG_STATUS.REJECTED) continue;
            entry.status = SLANG_STATUS.REJECTED;
            entry.updatedAt = new Date().toISOString();
            rejectedCount++;
          }
          if (rejectedCount) saveSlangStore();
          log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
          sendJson({ ok: true, rejectedCount });
          return;
        }
        const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = { ...slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return;
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
          if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          entry.updatedAt = new Date().toISOString();
          slangEntries[idx] = entry;
          saveSlangStore();
          log(`控制台：更新黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = slangEntries[idx];
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!entry.meaning) {
            sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return;
          }
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：确认黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = slangEntries[idx];
          entry.status = SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：拒绝黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const [removed] = slangEntries.splice(idx, 1);
          saveSlangStore();
          log(`控制台：删除黑话「${removed.content}」`);
          sendJson({ ok: true, removed });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key && slangWindows.has(key)) {
            queueSlangTask(() => runSlangExtraction(key));
            sendJson({ ok: true, key });
          } else {
            const firstKey = slangWindows.keys().next().value;
            if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
            queueSlangTask(() => runSlangExtraction(firstKey));
            sendJson({ ok: true, key: firstKey });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/research') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const candidates = ids.length
            ? slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
            : slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
          if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
          queueSlangTask(() => runSlangResearch(candidates));
          sendJson({ ok: true, count: candidates.length });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/config') {
          const body = await readBody();
          const oldPreset = cfg.slang?.learnerPreset;
          const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const merged = { ...(file.slang ?? {}), ...body };
          if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
          else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
          if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
          if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
          if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
          if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
          if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
          if (body.inferenceThresholds !== undefined) {
            const raw = Array.isArray(body.inferenceThresholds)
              ? body.inferenceThresholds
              : String(body.inferenceThresholds).split(/[,，\s]+/);
            merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
            if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
          }
          file.slang = merged;
          atomicWriteJson(configFile, file);
          cfg.slang = { ...cfg.slang, ...merged };
          if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习 preset 已变更，已重置学习会话');
          } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习工作区名已变更，已重置学习会话');
          }
          log('控制台：黑话系统配置已更新');
          sendJson({ ok: true, config: cfg.slang });
          return;
        }
        // ── 会话查看 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
          }
          sendJson({ sessions: list });
          return;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          sendJson({ pending: list });
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          sendJson({
            allow: cfg.allow ?? { private: [], groups: [] },
            deny: cfg.deny ?? { private: [], groups: [] },
            ownerQQ: cfg.ownerQQ ?? null,
            // 私聊准入策略（'list' 白名单 / 'friends' 好友自动放行 / 'all' 纯黑名单）
            privateMode: cfg.allow?.privateMode ?? 'list',
            // 好友数：'friends' 模式下控制台据此提示"当前生效的好友有多少"
            friendCount: friendIds.size
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readJsonSafe(configFile, null, true);
          // 私聊准入策略：可改。缺省沿用原值，非法值回落到 'list'（fail-closed）。
          const privateMode = body.allow?.privateMode !== undefined
            ? normalizePrivateMode(body.allow.privateMode)
            : (file.allow?.privateMode ?? 'list');
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? []),
            privateMode
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          atomicWriteJson(configFile, file);
          cfg.allow = { private: allow.private, groups: allow.groups, privateMode: allow.privateMode };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          // 切到 'friends' 时立刻拉一次好友列表（否则要等 5 分钟的定期刷新才生效）
          if (privateMode === 'friends') {
            refreshFriendList({ force: true }).then((ids) => log(`[私聊准入] 好友列表已刷新：${ids.size} 人`)).catch(() => {});
          }
          const modeLabel = { list: '白名单', friends: '好友自动放行', all: '纯黑名单（全放开）' }[allow.privateMode] || allow.privateMode;
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，私聊策略: ${modeLabel}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ, friendCount: friendIds.size });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({ security: cfg.security ?? { interceptNotify: true } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          atomicWriteJson(configFile, file);
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return;
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        // GET：只读返回「鉴权是否开启」，供页面显示当前状态。
        // **不回传令牌本身**（控制台页面不需要它，令牌值在 state/console-token 与 config 里）。
        if (req.method === 'GET' && url.pathname === '/api/console/token') {
          sendJson({
            ok: true,
            authEnabled: consoleToken !== '',
            hasToken: consoleToken !== '',
            port,
            hint: consoleToken === ''
              ? '令牌鉴权已关闭（config.consoleAuth=false）：直接访问即可，无需登录'
              : '令牌鉴权已开启：刷新页面时会要求输入令牌'
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return;
          }
          if (newToken.length > 128) {
            sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          atomicWriteJson(configFile, file);
          cfg.consoleToken = generated ? '' : newToken;
          atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
          consoleToken = newToken;
          log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          sendJson({ ok: true, token: newToken, generated });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
          if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
          try {
            const safeMessage = escapeCqText(redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await bot.sendPrivateMessage(id, text(safeMessage))
              : await bot.sendGroupMessage(id, text(safeMessage));
            recordSentMessage(`${kind}:${id}`, result, safeMessage);
            log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/state') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            enterActive(key);
            log(`控制台：手动将 ${key} 设为活跃`);
            sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            leaveActive(key);
            log(`控制台：手动将 ${key} 设为观望`);
            sendJson({ ok: true, key, phase: 'idle' });
          } else {
            sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
          for (const k of keys) {
            const st = social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          sendJson({ config: cfg.social, pendingSummaries: stats, states });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = readJsonSafe(configFile, null, true);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          atomicWriteJson(configFile, file);
          cfg.social = { ...cfg.social, ...merged };
          log('控制台：社交配置已更新');
          sendJson({ ok: true, config: cfg.social });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/flush') {
          const body = await readBody();
          await flushSummaries(body.key || null);
          sendJson({ ok: true });
          return;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            sendJson({ ok: false, error: 'id 无效' }, 400);
            return;
          }
          if (!modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
            return;
          }
          if (!state.sessions[key] && !allowed(kind, id, cfg)) {
            sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return;
          }
          if (!dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          const isV2 = currentMode === 'reserved2';
          const roleState = readRoleState();
          const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
          // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isV2) {
            const stV2 = getSocialV2State(key);
            tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
          }
          const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = social.silentTurns.get(sessionId) ?? [];
            social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) social.silentTurns.set(sessionId, next);
              else social.silentTurns.delete(sessionId);
            };
            const result = await deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        // ── 待配置项（凭据 / 密钥 / 关键连接配置）────────────────────────────
        //
        // 用户要求（2026-10-20）：把这些项放到控制台、做成密码样式（右侧隐藏/显示）、
        // 旁边配说明文档与保存键，需要重启的标明并提供重启按钮。
        //
        // 安全设计（务必保持）：
        //   ① GET 默认**只回「是否已配置」+ 脱敏预览**，绝不下发完整明文。
        //      用户点「显示」才单条请求（reveal=1），减少明文在页面/内存里的驻留。
        //   ② 写入沿用原始位置（config.json / state/*.json），**不新建集中明文文件**
        //      ——集中一处只会扩大泄露面。
        //   ③ 任何分支都不把这些值写进日志。
        // Token 用量：控制台读这个拿每日/累计数据。
        //
        // 需求（2026-10-21 用户）：「把 token 记录做成日志，每日更新并且放进控制台」。
        // 这里只读缓存（state/token-usage.json），**不在请求里现算**——
        // 全量扫一遍要 13~15 秒，放在 HTTP 请求里会卡住控制台。
        // 需要立刻重算时用 POST ?refresh=1（后台跑，不阻塞响应）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/token-usage') {
          const data = tokenUsage || loadTokenUsage();
          if (!data) {
            // 还没算过：返回空态 + 提示（前端会显示"正在统计"）
            sendJson({ ok: true, ready: false, days: {}, models: {}, dayModels: {}, turns: 0, calls: 0 });
            return;
          }
          const dayKeys = Object.keys(data.days || {}).sort().reverse();
          const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
          const tot = Object.values(data.days || {}).reduce((a, v) => ({
            input: a.input + v.input, output: a.output + v.output,
            cacheRead: a.cacheRead + v.cacheRead, reasoning: a.reasoning + v.reasoning,
            calls: a.calls + v.calls
          }), { input: 0, output: 0, cacheRead: 0, reasoning: 0, calls: 0 });

          // 按日审阅（2026-10-21 用户要求）：`?date=YYYY-MM-DD` 时，
          // `models` 换成**那一天**的模型明细；不传或传 `all` 则是全时段汇总。
          // 为什么要服务端过滤而不是前端自己挑：dayModels 是日×模型的联合分布，
          // 全量下发给前端在日期多了以后会明显变大（30 天 × 6 模型），
          // 而且前端拿到的数字必须和后端口径一致，放一处算就不会漂。
          const dateParam = String(url.searchParams.get('date') ?? '').trim();
          const wantAll = !dateParam || dateParam === 'all';
          const wantDate = wantAll ? '' : (/^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : '');
          if (!wantAll && !wantDate) {
            sendJson({ ok: false, error: 'date 应为 YYYY-MM-DD 或 all' }, 400);
            return;
          }
          const modelSource = wantAll ? (data.models || {}) : (data.dayModels?.[wantDate] || {});
          const sumModels = (obj) => Object.values(obj || {}).reduce((a, v) => ({
            input: a.input + (Number(v.input) || 0),
            output: a.output + (Number(v.output) || 0),
            cacheRead: a.cacheRead + (Number(v.cacheRead) || 0),
            reasoning: a.reasoning + (Number(v.reasoning) || 0),
            calls: a.calls + (Number(v.calls) || 0)
          }), { input: 0, output: 0, cacheRead: 0, reasoning: 0, calls: 0 });

          sendJson({
            ok: true,
            ready: true,
            updatedAt: data.updatedAt || 0,
            today,
            // 当前"按模型"块对应哪一天：'all' = 全时段，否则是 YYYY-MM-DD。
            // 前端用它在标题上写清楚"这是哪天的数"，避免看错口径。
            modelScope: wantAll ? 'all' : wantDate,
            modelScopeUsage: wantAll ? sumModels(data.models) : sumModels(modelSource),
            todayUsage: data.days?.[today] || { input: 0, output: 0, cacheRead: 0, calls: 0 },
            total: tot,
            turns: data.turns || 0,
            calls: data.calls || 0,
            files: data.files || 0,
            // 按日：最近 30 天，新的在前
            days: dayKeys.slice(0, 30).map((d) => ({ date: d, ...data.days[d] })),
            // 按模型：当前所选日期（或全时段）的明细，按输入量排序
            models: Object.entries(modelSource)
              .map(([model, v]) => ({ model, ...v }))
              .sort((a, b) => b.input - a.input)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/token-usage-refresh') {
          // 后台重算，立刻回 202：全量扫描 13~15 秒，不能同步等
          void refreshTokenUsage({ force: url.searchParams.get('force') === '1' }).catch(() => {});
          sendJson({ ok: true, message: '已在后台开始重新统计（约 15 秒）' });
          return;
        }
        // ── Token 用量报表图（2026-10-21 用户要求）──────────────────────────
        //
        // 「让 bot 能够看到 token 消耗日志，能够以图片形式响应群友要求 token 消耗量
        //   相关问题」——所以这个端点是**给模型用的**（MCP 的 qq_token_report 调它），
        // 一次做完「取数 → 渲染 PNG → 发到当前会话」。
        //
        // 为什么由桥接直接发而不是把图 base64 还给模型：模型没有"发送任意图片"的能力
        // （qq_send_image 只认图库里的图），与功能菜单同一个理由。
        //
        // GET，参数：key（会话）、refresh（可选，1=先重算再出图）
        if (req.method === 'GET' && url.pathname === '/api/socialV2/token-report') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          // agent token 必需（与 send-image / send-feature-menu / github-shot 同规则）：
          // 这是个往群里发东西的写操作，不能靠"控制台没设令牌"就放行。
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '发送 Token 报表必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('tokenReport')) { sendJson({ ok: false, error: '工具未启用：qq_token_report' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: 'AI 已暂停，当前不允许发送' }, 403); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许向该会话发送' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          try {
            // refresh=1：先同步重算一次（约 7 秒增量 / 15 秒全量）。
            // 群友明确问"今天用了多少"时值得等一下——拿 6 小时前的旧数回答，
            // 数字可能差出一大截。但不做全量强制重算（force 不传）。
            if (url.searchParams.get('refresh') === '1') {
              await refreshTokenUsage({});
            }
            const usage = tokenUsage || loadTokenUsage() || { days: {}, models: {}, turns: 0, calls: 0 };
            const report = buildTokenReport(usage);
            const title = String(url.searchParams.get('title') ?? '').trim().slice(0, 40) || 'Token 用量';
            const r = await renderTokenReport(report, { title, log: (m) => log(m) });
            if (!r.ok) { sendJson({ ok: false, error: r.error }, 500); return; }
            await onebotSendImageFile(key, r.file, { label: 'Token 用量报表' });
            // 顺手清理旧报表缓存（每天都会产生新指纹文件，不清理会攒几千张）
            try { pruneTokenReportCache({ maxFiles: 20, maxAgeDays: 14 }); } catch {}
            log(`[Token报表] 已发送到 ${key}（${Math.round(r.bytes / 1024)}KB${r.cached ? '，缓存' : '，新渲染'}）`);
            appendActivity(`${key} [Token报表] 已发送 Token 用量图`);
            sendJson({
              ok: true,
              key,
              cached: r.cached,
              bytes: r.bytes,
              // 把关键数字一并回给模型：它在群友追问时要能回答，且**必须与图上同源**
              // （否则模型会凭印象再编一个数，和刚发出去的图对不上）。
              summary: summarizeTokenReport(report),
              today: { day: report.today.day, input: report.today.input, output: report.today.output, calls: report.today.calls },
              total: { input: report.all.input, output: report.all.output, calls: report.all.calls },
              stale: report.stale,
              ageText: report.ageText
            });
          } catch (error) {
            log(`Token 报表发送失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `Token 报表发送失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // 控制台预览：渲染 Token 报表并以 PNG 返回（**不发群**）。
        //
        // 与 /api/socialV2/token-report 的区别：那个是给模型用的（渲染 + 发到会话），
        // 这个只给控制台看图。分成两个端点而不是加个 flag，是因为权限模型不同：
        // 发群那条必须带 agent token，预览这条走控制台鉴权（本机 + 同源）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/token-report-image') {
          try {
            if (url.searchParams.get('refresh') === '1') await refreshTokenUsage({});
            const usage = tokenUsage || loadTokenUsage() || { days: {}, models: {}, turns: 0, calls: 0 };
            const report = buildTokenReport(usage);
            const title = String(url.searchParams.get('title') ?? '').trim().slice(0, 40) || 'Token 用量';
            const r = await renderTokenReport(report, { title, force: url.searchParams.get('force') === '1', log: (m) => log(m) });
            if (!r.ok) { sendJson({ ok: false, error: r.error }, 500); return; }
            const buf = fs.readFileSync(r.file);
            res.writeHead(200, {
              ...SECURITY_HEADERS,
              'content-type': 'image/png',
              'content-length': String(buf.length),
              // 内容指纹已在文件名里，但浏览器拿不到——用 no-store 保证看到的是新图
              'cache-control': 'no-store'
            });
            res.end(buf);
          } catch (error) {
            sendJson({ ok: false, error: `生成报表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // 工具开关清单（控制台由此渲染，不再硬编码复选框）。
        //
        // 需求（2026-10-20 用户）：「工具开关卡片过于复杂，似乎还有遗漏项目」。
        // 实测确实漏了 10 个、还有 1 个空开关。根因是**清单写在控制台 HTML 里**，
        // 加工具时只改后端不改前端（或反过来）就会漂移。
        // 现在清单唯一来源是 src/tool-flags.js，前端只负责画。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-flags') {
          const tools = cfg.socialV2?.tools ?? {};
          const groups = groupedToolFlags((flag) => tools[flag] !== false);
          sendJson({
            ok: true,
            total: TOOL_FLAGS.length,
            toolCount: toolNamesOf().length,
            enabledCount: TOOL_FLAGS.filter((x) => x.fixed !== true && tools[x.flag] !== false).length,
            groups
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/credentials') {
          const reveal = url.searchParams.get('reveal') === '1';
          const only = String(url.searchParams.get('key') ?? '').trim();

          // 读取当前值：config 走点路径，file 走 state 下的 json
          const readValue = (item) => {
            try {
              if (item.where === 'config') {
                const file = readJsonSafe(path.join(ROOT, 'config.json'), null);
                if (!file) return { ok: false, value: '', error: 'config.json 读取失败' };
                let cur = file;
                for (const k of item.path.split('.')) {
                  cur = cur?.[k];
                  if (cur === undefined) break;
                }
                return { ok: true, value: cur == null ? '' : String(cur) };
              }
              const file = readJsonSafe(path.join(STATE_DIR, item.file), null);
              if (!file) return { ok: true, value: '' }; // 文件不存在 = 未配置，不是错误
              const v = file[item.path];
              return { ok: true, value: v == null ? '' : String(v) };
            } catch (error) {
              return { ok: false, value: '', error: String(error?.message ?? error) };
            }
          };

          const items = (only ? CREDENTIAL_ITEMS.filter((it) => it.key === only) : CREDENTIAL_ITEMS)
            .map((item) => {
              const r = readValue(item);
              const configured = !!r.value;
              return {
                key: item.key,
                label: item.label,
                group: item.group,
                kind: item.kind,
                restart: item.restart === true,
                doc: item.doc,
                // 明文下发规则（2026-10-20 用户要求「连接这部分不要脱敏，直接显示明文」）：
                //   - kind='text'（代理地址等**非秘密**）：直接给明文，不然用户没法确认填得对不对。
                //   - kind='secret'（真正的 key / cookie）：默认只给脱敏预览；点眼睛时
                //     （reveal=1 且指定了 key）才给那一条的明文。
                //   整表 reveal 仍然不允许——那会让所有密钥一次性进浏览器内存。
                value: item.kind === 'text'
                  ? (r.ok ? r.value : '')
                  : ((reveal && only) ? (r.ok ? r.value : '') : ''),
                configured,
                // 连接类不需要脱敏预览（前端直接显示明文）
                preview: configured && item.kind !== 'text' ? maskValue(r.value) : '',
                ...(r.ok ? {} : { error: r.error })
              };
            });

          sendJson({ ok: true, items });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/credentials') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const item = CREDENTIAL_ITEMS.find((it) => it.key === key);
          if (!item) { sendJson({ ok: false, error: `未知配置项：${key}` }, 400); return; }
          if (typeof body.value !== 'string') { sendJson({ ok: false, error: 'value 必须是字符串' }, 400); return; }
          // 换行/首尾空白几乎都是复制时带进来的，直接裁掉（这些值里不会含换行）
          const value = String(body.value).replace(/[\r\n]+/g, '').trim();

          // 基本形态校验：宁可在保存时拒绝，也不要存进去后再去排查"为什么连不上"
          if (item.kind === 'secret' && value && value.length < 6) {
            sendJson({ ok: false, error: '这个值太短了，确认没复制错吗？' }, 400);
            return;
          }
          if (item.key === 'imagesProxy' || item.key === 'githubShotProxy' ||
              item.key === 'webSearchProxy' || item.key === 'xMonitorProxy') {
            if (value && !/^https?:\/\/[^\s]+$/i.test(value)) {
              sendJson({ ok: false, error: '代理地址应形如 http://127.0.0.1:7897' }, 400);
              return;
            }
          }
          if (item.key === 'consoleToken' && value && value.length < 16) {
            sendJson({ ok: false, error: '控制台令牌至少 16 位' }, 400);
            return;
          }

          try {
            if (item.where === 'config') {
              const configFile = path.join(ROOT, 'config.json');
              // fail-fast：配置损坏时绝不回写，否则可能把整个 config 清空
              const file = readJsonSafe(configFile, null, true);
              const segs = item.path.split('.');
              let cur = file;
              for (let i = 0; i < segs.length - 1; i++) {
                if (!cur[segs[i]] || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
                cur = cur[segs[i]];
              }
              cur[segs[segs.length - 1]] = value;
              atomicWriteJson(configFile, file);
              // 同步内存：改完立即生效的那些项（restart=false）立刻能用
              let mem = cfg;
              for (let i = 0; i < segs.length - 1; i++) {
                mem[segs[i]] = mem[segs[i]] ?? {};
                mem = mem[segs[i]];
              }
              mem[segs[segs.length - 1]] = value;
              // 反查器构造时就把 apiKey 抓进闭包了，改了要重建才生效
              if (item.key === 'reverseSearchApiKey') {
                try { reverseSearcher.setApiKey?.(value); } catch { /* 旧实现没有该方法时忽略 */ }
              }
            } else {
              const file = path.join(STATE_DIR, item.file);
              const obj = readJsonSafe(file, null) ?? {};
              if (value) obj[item.path] = value;
              else delete obj[item.path];
              atomicWriteJson(file, obj);
              // 凭据模块在内存里缓存了 cookie（bili.js / pixiv-auth.js 都是），
              // 存完就地重读一次，用户不必为了试一个值反复重启桥接。
              if (item.file === 'pixiv-auth.json') {
                try { applyPixivAuth('控制台保存'); } catch { /* 重读失败不该让保存算失败 */ }
              }
            }

            log(`[配置] 已更新 ${item.key}${value ? `（${value.length} 字符）` : '（清空）'}${item.restart ? '，需重启生效' : ''}`);
            sendJson({
              ok: true,
              key: item.key,
              configured: !!value,
              preview: value ? maskValue(value) : '',
              restart: item.restart === true,
              // 明确告诉前端"现在生效了没有"，避免用户以为白填了
              applied: item.restart !== true
            });
          } catch (error) {
            log(`[配置] 写入 ${item.key} 失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `保存失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
          sendJson({ ok: true, config: cfg.socialV2 ?? {} });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const current = file.socialV2 ?? {};
          const merged = { ...current, ...body };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // tools：只接受布尔开关
          // 从唯一来源派生（src/tool-flags.js），避免手写清单与真实工具漂移。
          // fixed 项（无条件注册的只读工具）不接受开关，前端也不会提交。
          const toolFlags = TOOL_FLAGS.filter((x) => x.fixed !== true).map((x) => x.flag);
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs', 'preSleepReplyGraceMs']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
            // autoAt：概率 0~1，时间/次数非负取整。子对象是浅合并进来的，
            // 不归一化的话控制台传字符串（"0.5"）或负数会直接进判定逻辑。
            if (body.send.autoAt && typeof body.send.autoAt === 'object' && !Array.isArray(body.send.autoAt)) {
              const cur = current.send?.autoAt ?? {};
              const next = { ...cur, ...body.send.autoAt };
              next.enabled = next.enabled === true;
              const prob = Number(next.probability);
              next.probability = Number.isFinite(prob) ? Math.min(1, Math.max(0, prob)) : (cur.probability ?? DEFAULT_AUTO_AT.probability);
              for (const k of ['windowMs', 'cooldownMs', 'maxPerHour']) {
                const n = Number(next[k]);
                next[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : (cur[k] ?? DEFAULT_AUTO_AT[k]);
              }
              merged.send.autoAt = next;
            }
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs', 'maxQuietMs', 'turnMaxCount', 'turnMaxMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
            if (merged.wait.maxQuietMs !== undefined) merged.wait.maxQuietMs = Math.min(15000, Math.max(0, merged.wait.maxQuietMs));
            if (merged.wait.turnMaxCount !== undefined) merged.wait.turnMaxCount = Math.min(20, Math.max(1, merged.wait.turnMaxCount));
            if (merged.wait.turnMaxMs !== undefined) merged.wait.turnMaxMs = Math.min(600000, Math.max(5000, merged.wait.turnMaxMs));
          }
          // tts：语音合成参数（2026-10-22 用户要求「触发概率、每小时上限、模型设置、
          // 字数等设成可变参数并提供修改按钮」）。
          //
          // 这里逐项 clamp，不做"信任前端"那套：
          //   - probability 必须在 0~1（有人会填 5 表示 5%，得救回来）；
          //   - maxPerHour / maxChars 有上下界（0 条 = 禁用；字数太大语速劝退）；
          //   - enabled 只接受布尔，避免 "false" 字符串被当成真值。
          if (body.tts && typeof body.tts === 'object' && !Array.isArray(body.tts)) {
            merged.tts = { ...(current.tts ?? {}), ...body.tts };
            const t = merged.tts;
            const prev = current.tts ?? {};
            if (t.enabled !== undefined) t.enabled = t.enabled === true;
            // 概率：接受 0~1 的小数；也容忍 0~100 的百分数写法（>1 时按百分数折算）
            if (t.probability !== undefined) {
              let p = Number(t.probability);
              if (!Number.isFinite(p)) p = Number(prev.probability ?? TTS_DEFAULT_PROBABILITY);
              if (p > 1) p = p / 100;
              t.probability = Math.min(1, Math.max(0, Math.round(p * 1000) / 1000));
            }
            if (t.maxPerHour !== undefined) {
              const n = Number(t.maxPerHour);
              t.maxPerHour = Number.isFinite(n) ? Math.min(60, Math.max(0, Math.round(n))) : (Number(prev.maxPerHour) || 3);
            }
            if (t.maxChars !== undefined) {
              const n = Number(t.maxChars);
              t.maxChars = Number.isFinite(n) ? Math.min(300, Math.max(10, Math.round(n))) : (Number(prev.maxChars) || 140);
            }
            // 模型设置：路径与音色名只做字符串化 + 去空白；不校验存在性——
            // 路径可能暂时不可达（外接盘没插），不该因此拒绝保存其它参数。
            // voiceId/weightsId/refMode 是音色预设选择（voices.json），
            // 与手写路径二选一；有 voiceId 时以预设为准。
            for (const k of ['dir', 'gptModel', 'sovitsModel', 'refAudio', 'refText', 'refLang', 'voiceName', 'device', 'voiceId', 'weightsId', 'refMode']) {
              if (t[k] !== undefined) t[k] = String(t[k] ?? '').trim();
            }
            if (t.isHalf !== undefined) t.isHalf = t.isHalf !== false;
            if (t.cpuThreads !== undefined) {
              const n = Number(t.cpuThreads);
              t.cpuThreads = Number.isFinite(n) ? Math.min(32, Math.max(1, Math.round(n))) : (Number(prev.cpuThreads) || 8);
            }
            // 韵律/响度参数（2026-10-22 方案 B）：都是请求级参数，改完即时生效。
            // 必须用小数 clamp（ttsNum 会取整，speed 0.95 会被弄成 1）。
            const clampDec = (k, min, max, dflt) => {
              if (t[k] === undefined) return;
              const n = Number(t[k]);
              t[k] = Number.isFinite(n)
                ? Math.min(max, Math.max(min, Math.round(n * 1000) / 1000))
                : dflt;
            };
            clampDec('speed', 0.8, 1.2, 1.0);
            clampDec('fragmentInterval', 0.1, 0.6, 0.3);
            clampDec('temperature', 0.5, 1.2, 0.9);
            clampDec('topK', 5, 30, 15);
            clampDec('topP', 0.7, 1.0, 0.95);
            clampDec('volumeGainDb', -12, 12, 0);
            if (t.textSplitMethod !== undefined) {
              const s = String(t.textSplitMethod ?? '').trim();
              t.textSplitMethod = ['cut1', 'cut5'].includes(s) ? s : 'cut5';
            }
            if (t.punctuate !== undefined) t.punctuate = t.punctuate !== false && t.punctuate !== 'false';
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            // 主动要求发表情（2026-10-22）：参数来自控制台，这里逐项 clamp。
            // 概率同 TTS 的约定——接受 0~1，也容忍 0~100 的百分数写法。
            if (merged.sticker.autoNudge !== undefined) merged.sticker.autoNudge = merged.sticker.autoNudge === true;
            if (merged.sticker.autoNudgeProbability !== undefined) {
              let p = Number(merged.sticker.autoNudgeProbability);
              if (!Number.isFinite(p)) p = Number(current.sticker?.autoNudgeProbability ?? 0.33);
              if (p > 1) p = p / 100;
              merged.sticker.autoNudgeProbability = Math.min(1, Math.max(0, Math.round(p * 1000) / 1000));
            }
            if (merged.sticker.autoNudgeMinGapMs !== undefined) {
              const n = Number(merged.sticker.autoNudgeMinGapMs);
              merged.sticker.autoNudgeMinGapMs = Number.isFinite(n) ? Math.max(0, Math.round(n)) : (Number(current.sticker?.autoNudgeMinGapMs) || 180000);
            }
            if (merged.sticker.autoNudgeMaxPerHour !== undefined) {
              const n = Number(merged.sticker.autoNudgeMaxPerHour);
              merged.sticker.autoNudgeMaxPerHour = Number.isFinite(n) ? Math.min(60, Math.max(0, Math.round(n))) : (Number(current.sticker?.autoNudgeMaxPerHour) ?? 6);
            }
            if (merged.sticker.autoNudgeCandidates !== undefined) {
              const n = Number(merged.sticker.autoNudgeCandidates);
              merged.sticker.autoNudgeCandidates = Number.isFinite(n) ? Math.min(4, Math.max(1, Math.round(n))) : (Number(current.sticker?.autoNudgeCandidates) || 3);
            }
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // comply：群友点单的照做判定参数归一化
          if (body.comply && typeof body.comply === 'object') {
            merged.comply = { ...(current.comply ?? {}), ...body.comply };
            if (merged.comply.enabled !== undefined) merged.comply.enabled = merged.comply.enabled === true;
            for (const k of ['ttlMs', 'cooldownMs', 'maxPerHour']) {
              if (merged.comply[k] !== undefined) {
                const n = Number(merged.comply[k]);
                merged.comply[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.comply?.[k] ?? 0;
              }
            }
            if (merged.comply.probability !== undefined) {
              merged.comply.probability = Math.min(1, Math.max(0, Number(merged.comply.probability) || 0));
            }
          } else if (body.comply === undefined && merged.comply === undefined) {
            // 旧配置没有该块时补默认，保证 qq_get_prompt/判定能读到。
            merged.comply = current.comply ?? {};
          }
          // gifFrames：动图抽帧拼图参数归一化
          if (body.gifFrames && typeof body.gifFrames === 'object') {
            merged.gifFrames = { ...(current.gifFrames ?? {}), ...body.gifFrames };
            if (merged.gifFrames.enabled !== undefined) merged.gifFrames.enabled = merged.gifFrames.enabled === true;
            for (const k of ['timeoutMs']) {
              if (merged.gifFrames[k] !== undefined) {
                const n = Number(merged.gifFrames[k]);
                merged.gifFrames[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.gifFrames?.[k] ?? 0;
              }
            }
            if (merged.gifFrames.maxFrames !== undefined) {
              const n = Number(merged.gifFrames.maxFrames);
              merged.gifFrames.maxFrames = Number.isFinite(n) ? Math.min(20, Math.max(2, Math.round(n))) : (current.gifFrames?.maxFrames ?? 20);
            }
            if (merged.gifFrames.tileWidth !== undefined) {
              const n = Number(merged.gifFrames.tileWidth);
              merged.gifFrames.tileWidth = Number.isFinite(n) ? Math.min(640, Math.max(80, Math.round(n))) : (current.gifFrames?.tileWidth ?? 320);
            }
          }
          // media：单条消息图片总量上限等
          if (body.media && typeof body.media === 'object') {
            merged.media = { ...(current.media ?? {}), ...body.media };
            if (merged.media.maxMessageBytes !== undefined) {
              const n = Number(merged.media.maxMessageBytes);
              // 下限 1MB：再小会让常见表情包都发不出去；上限 64MB：避免把内存打爆。
              merged.media.maxMessageBytes = Number.isFinite(n)
                ? Math.min(64 * 1024 * 1024, Math.max(1024 * 1024, Math.round(n)))
                : (current.media?.maxMessageBytes ?? 8 * 1024 * 1024);
            }
          }
          // errorNotice：上游报错拦截（节流窗口 / 文案 / 是否私聊管理员 / 是否在群里发提示）
          if (body.errorNotice && typeof body.errorNotice === 'object') {
            merged.errorNotice = { ...(current.errorNotice ?? {}), ...body.errorNotice };
            if (merged.errorNotice.windowMs !== undefined) {
              const n = Number(merged.errorNotice.windowMs);
              // 下限 0（每次必发，调试用）；上限 1 小时：再长会让限流提示形同关闭。
              merged.errorNotice.windowMs = Number.isFinite(n)
                ? Math.min(60 * 60 * 1000, Math.max(0, Math.round(n)))
                : (current.errorNotice?.windowMs ?? 3 * 60 * 1000);
            }
            if (Array.isArray(merged.errorNotice.messages)) {
              const msgs = merged.errorNotice.messages.map((m) => String(m ?? '').trim()).filter(Boolean);
              // 空数组会让「随机取一条」无从取值，回退到默认文案
              merged.errorNotice.messages = msgs.length ? msgs : DEFAULT_ERROR_MESSAGES;
            }
            // inGroup 默认 false（报错不进群）。只有显式传 true 才打开群内提示。
            if (merged.errorNotice.inGroup !== undefined) {
              merged.errorNotice.inGroup = merged.errorNotice.inGroup === true;
            }
          }
          // images：图库参数归一化（sources 逐层合并，避免外层 spread 覆盖丢默认）
          if (body.images && typeof body.images === 'object') {
            merged.images = { ...(current.images ?? {}), ...body.images };
            if (merged.images.enabled !== undefined) merged.images.enabled = merged.images.enabled === true;
            if (merged.images.annotateSource !== undefined) merged.images.annotateSource = merged.images.annotateSource === true;
            for (const k of ['maxFiles', 'maxTotalBytes', 'maxBytesPerFile', 'fetchPerRun', 'cooldownMs', 'sendCooldownMs', 'maxSendPerHour']) {
              if (merged.images[k] !== undefined) {
                const n = Number(merged.images[k]);
                merged.images[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.images?.[k] ?? 0;
              }
            }
            if (merged.images.libDir !== undefined) merged.images.libDir = String(merged.images.libDir ?? '');
            if (body.images.sources && typeof body.images.sources === 'object') {
              const cur = current.images?.sources ?? {};
              merged.images.sources = { ...cur };
              for (const [name, sc] of Object.entries(body.images.sources)) {
                if (!sc || typeof sc !== 'object') continue;
                merged.images.sources[name] = { ...(cur[name] ?? {}), ...sc };
                const one = merged.images.sources[name];
                if (one.enabled !== undefined) one.enabled = one.enabled === true;
                if (one.limit !== undefined) {
                  const n = Number(one.limit);
                  one.limit = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 20;
                }
                if (one.tags !== undefined) {
                  one.tags = (Array.isArray(one.tags) ? one.tags : String(one.tags).split(/[,，\s]+/)).map(String).filter(Boolean);
                }
              }
            }
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          file.socialV2 = merged;
          atomicWriteJson(configFile, file);
          cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
          log('控制台：二代仿真配置已更新');
          sendJson({ ok: true, config: cfg.socialV2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        // 活动日志改版：按“消息”聚合状态，而不是只追加一行文本。
        // 前端每秒拉一次，状态由当前 unread / pending / answeredSeqs 实时推导：
        // 未读 → 处理中/待回复 → 已回复/已读；自己发出的消息显示已发送/语音已发。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity-feed') {
          const limit = Math.min(200, Math.max(20, Number(url.searchParams.get('limit')) || 120));
          const rows = [];
          const cleanDisplay = (v, n) => String(v ?? '').replace(/[ --]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
          const keyOfMsg = (m) => (m?.messageId != null && String(m.messageId) !== 'null')
            ? `id:${m.messageId}`
            : `seq:${Number(m?.seq) || 0}`;
          for (const [key, st] of socialV2.conversations.entries()) {
            if (!/^(group|private):\d+$/.test(key)) continue;
            const recent = Array.isArray(st.recentMessages) ? st.recentMessages.slice(-20) : [];
            if (!recent.length) continue;
            const callers = findCallersV2(key, st);
            const pendingKeys = new Set();
            const answeredKeys = new Set();
            for (const m of callers.pending) { pendingKeys.add(keyOfMsg(m)); if (m.seq) pendingKeys.add(`seq:${Number(m.seq)}`); }
            for (const m of callers.answered) { answeredKeys.add(keyOfMsg(m)); if (m.seq) answeredKeys.add(`seq:${Number(m.seq)}`); }
            const unreadSeqs = new Set((Array.isArray(st.unread) ? st.unread : []).map((m) => Number(m?.seq)).filter(Number.isFinite));
            const unreadIds = new Set((Array.isArray(st.unread) ? st.unread : []).map((m) => m?.messageId != null ? String(m.messageId) : '').filter(Boolean));
            const busy = isConversationBusyV2(key, st);
            const displayName = contextDisplayName(key) || '';
            const keyLabel = key.replace(/^group:/, '群 ').replace(/^private:/, '私聊 ');
            for (const m of recent) {
              if (!m) continue;
              const text = cleanDisplay(m.text ?? m.plain ?? '', 240);
              const isSelf = !!m.isSelf;
              const isVoice = !!(m.isVoice || /^\[语音\]/.test(text));
              const mk = keyOfMsg(m);
              const inUnread = !isSelf && ((m.seq && unreadSeqs.has(Number(m.seq)))
                || (m.messageId != null && unreadIds.has(String(m.messageId))));
              let status = 'read';
              let label = '已读';
              if (isSelf) {
                status = isVoice ? 'voice-sent' : 'sent';
                label = isVoice ? '语音已发' : '已发送';
              } else if (pendingKeys.has(mk)) {
                status = busy ? 'processing' : 'pending';
                label = busy ? '处理中' : '待回复';
              } else if (answeredKeys.has(mk)) {
                status = 'replied';
                label = '已回复';
              } else if (inUnread) {
                status = 'unread';
                label = '未读';
              }
              rows.push({
                key,
                session: cleanDisplay(displayName || keyLabel, 80),
                sessionKey: keyLabel,
                time: Number(m.time) || 0,
                sender: isSelf ? '我' : cleanDisplay(m.sender || '未知', 60),
                userId: m.userId != null ? String(m.userId) : '',
                text,
                isSelf,
                isVoice,
                status,
                label,
                seq: Number(m.seq) || 0,
                messageId: m.messageId != null ? String(m.messageId) : ''
              });
            }
          }
          rows.sort((a, b) => b.time - a.time);
          const counts = rows.reduce((acc, r) => {
            acc[r.status] = (acc[r.status] || 0) + 1;
            return acc;
          }, { pending: 0, processing: 0, replied: 0, unread: 0, read: 0, sent: 0, 'voice-sent': 0 });
          sendJson({ ok: true, rows: rows.slice(0, limit), counts, generatedAt: Date.now() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          socialV2.paused = paused;
          if (paused) {
            clearAllSocialV2Timers();
            log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
          } else {
            log('控制台：二代 AI 已恢复');
            for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          }
          saveSocialV2State();
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
          sessionEpoch++;
          sessionPromises.clear();
          clearAllSocialV2Timers();
          drainAllPromptQueues('二代状态已重置');
          for (const key of [...socialV2.conversations.keys()]) {
            const sid = state.sessions[key];
            if (sid) {
              delete state.sessions[key];
              reverse.delete(sid);
              collectors.delete(sid);
              v2TurnStartAt.delete(sid);
              toolCallNames.delete(sid);
              pendingSendToolCalls.delete(sid);
              sendToolSucceededSessions.delete(sid);
            }
            const removedV2 = socialV2.conversations.get(key);
            if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
            socialV2.conversations.delete(key);
            seenForwardIds.delete(key);
          }
          pendingWakeKeys.clear();
          clearAllPendingWakeLeases();
          wakeConfigUpdatedKeys.clear();
          markReadCalledKeys.clear();
          wakeConfigMissCount.clear();
          socialV2.paused = false;
          try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败:', error?.message ?? error); }
          log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
          const st = getSocialV2State(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (cfg.socialV2?.sticker?.enabled !== false) {
            try { await syncStickerLibrary(false); } catch {}
          }
          const roleState = readRoleState();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            sendImage: 'qq_send_image',
            checkImage: 'qq_check_image',
            refreshImageLib: 'qq_refresh_image_lib',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            deleteSticker: 'qq_delete_sticker',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image',
            getFeatureMenu: 'qq_send_feature_menu',
            groupFiles: 'qq_list_group_files',
            reverseSearch: 'qq_reverse_search'
          };
          const tools = cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'deleteSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            role: { name: roleState.role ?? null, hint: currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint() },
            recommended: cfg.socialV2?.provideRecommendations === false ? null : {
              wake: cfg.socialV2?.wake ?? {},
              send: cfg.socialV2?.send ?? {},
              wait: cfg.socialV2?.wait ?? {},
              proactive: cfg.socialV2?.proactive ?? {},
              comply: cfg.socialV2?.comply ?? {}
            },
            enabledTools,
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            memory: formatMemoryV2(st),
            participation: formatParticipationV2(st),
            slang: {
              enabled: cfg.slang?.enabled !== false,
              entries: confirmedSlangListV2(),
              block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
            },
            stickers: {
              enabled: cfg.socialV2?.sticker?.enabled !== false,
              total: stickerEntries.length,
              context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
              strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
            }
          });
          return;
        }
        // ── 群文件只读分类（见 group-files.js）──────────────────────────────
        // 只读：列文件、统计、搜索。**不删除/移动/上传/改名** ——
        // 那些写操作 API 确实存在且会真实执行（已实测 delete_group_file），
        // 但群文件里的 docx/pdf 删了不可恢复，不做进工具。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/group-files') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const keyMatch = /^group:(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: '群文件只适用于群会话（key 格式 group:群号）' }, 400); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '读取群文件必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('groupFiles')) { sendJson({ ok: false, error: '工具未启用：qq_list_group_files' }, 403); return; }
          const groupId = Number(keyMatch[1]);
          try {
            // 取列表（走 OneBot，与其它只读查询同一通道）
            // 注意：SDK 的 call() 已经解包（returns response.data）且出错会 throw，
            // 所以这里直接读 .files，不要再套一层 .data（那是原始 HTTP 的形状）。
            const raw = await bot.getGroupRootFiles(groupId);
            const files = (raw && raw.files) || [];
            const mode = String(url.searchParams.get('mode') ?? 'summary');
            if (mode === 'search') {
              const q = {
                keyword: url.searchParams.get('keyword') || '',
                category: url.searchParams.get('category') || '',
                ext: url.searchParams.get('ext') || '',
                uploader: url.searchParams.get('uploader') || '',
                minBytes: Number(url.searchParams.get('minBytes')) || 0,
                maxBytes: Number(url.searchParams.get('maxBytes')) || 0,
                limit: Number(url.searchParams.get('limit')) || 20
              };
              const r = searchGroupFiles(files, q);
              sendJson({ ok: true, key, mode, query: q, ...r });
              return;
            }
            const summary = summarizeGroupFiles(files, { recentDays: Number(url.searchParams.get('recentDays')) || 7 });
            sendJson({ ok: true, key, mode: 'summary', summary, text: formatSummary(summary) });
          } catch (error) {
            log(`群文件读取失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `群文件读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/group-file-stats') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const keyMatch = /^group:(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: '群文件只适用于群会话（key 格式 group:群号）' }, 400); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '读取群文件必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('groupFiles')) { sendJson({ ok: false, error: '工具未启用：qq_group_file_stats' }, 403); return; }
          try {
            // 容量信息：让模型能回答"群文件满了吗"这类问题
            const info = await bot.getGroupFileSystemInfo(Number(keyMatch[1]));
            const d = info ?? {};   // SDK 已解包
            const used = Number(d.used_space) || 0;
            const total = Number(d.total_space) || 0;
            sendJson({
              ok: true,
              key,
              fileCount: Number(d.file_count) || 0,
              limitCount: Number(d.limit_count) || 0,
              usedSpace: used,
              totalSpace: total,
              usedText: humanSize(used),
              totalText: humanSize(total),
              usedPercent: total > 0 ? Math.round(used / total * 100) : null
            });
          } catch (error) {
            sendJson({ ok: false, error: `容量读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages: st.unread.slice(-limit) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          sendJson({ ok: true, key, messages: st.recentMessages.slice(start, end) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
          const st = getSocialV2State(key);
          // 硬拦截：未读里有人在叫它（@ 它的任一别名 / 引用它），而它这一轮还没发过言时，
          // 不允许直接已读收尾。实测模型会一边把「@大肥鱼 speak」「@大肥鱼 夸一夸…」当
          // 「没人叫我」忽略掉，一边 wait 完就 mark_read 走人，导致催它的人永远等不到回应
          // （提示词和 preset 都写了「被 @ 必须回」，但它仍会违反，所以必须有桥接侧硬约束）。
          {
            const callerMsgs = findCallersV2(key, st);
            // 只看 pending（还没答过的 @）。answered 是「已经回过的那条 @」——用
            // qq_send_message 不引用回复时它不会被移出未读（只有带 replyToMessageId 的
            // 发送才清理），于是会长期留在列表里。原先判 callerMsgs.length 把这类旧 @
            // 也算成「有人在叫你」，机器人明明已经把话说完了、想收尾时仍被拦下，
            // 只能硬凑一句话。实测 2026-10-12 被逼出这样一条真发进群的：
            //   「这两下 @ 我都应过了，管理员的「在的」、喊口号那个也拒了」
            // —— 只是把自己的调度状态念了一遍。answered 不该构成拦截理由。
            // —— 这里**不能**再叠 `repliedThisTurn`（本轮发过言就放行）。
            // pending 的判定基准是 lastAiReplyAt（最后一次发言时间）：只要 @ 比它晚，
            // 这条 @ 就是没答过的。而 repliedThisTurn 看的是「本轮有没有发过言」，
            // 一个更早的回复也会让它为 true。实测 2026-10-22 20:18:59 的 @ 就是被它
            // 放行的：机器人 20:14:38 发过言（那轮确实发过），20:20:51 wait 结束后
            // mark_read 把这条 @ 一并标读，靠 backfill 4 分钟后才补回，用户以为没理人。
            if (callerMsgs.pending.length) {
              const brief = callerMsgs.pending
                .slice(-3)
                .map((m) => `${String(m.sender || '某人')}：${String(m.text || m.plain || '').slice(0, 30)}`)
                .join('；');
              sendJson({
                ok: false,
                error: `未读里有人在叫你，不能就这样已读收尾：${brief}。请先正面回应（优先用 qq_reply；用 qq_send_message 时带 replyToMessageId，桥接才能确认你回的是哪条）；如果这条你确实办不到，就直接对群友说明办不到的原因——话说给对方听，不要报告自己的处理流程或调度状态。`,
                callers: callerMsgs.pending.length
              }, 400);
              return;
            }
          }
          // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
          // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
          if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st, key)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = st.unread.length;
          // 未读清理：**该清的要清干净**，否则会永久滞留并导致重复回答。
          //
          // 历史与两个坑：
          //   1. 原先这里写的是 `filter((m) => !pendingSeqs.has(seq))`——与它自己的注释
          //      （"保留命中排队 seq 的未读"）**正好相反**：它把排队中的消息**删掉**、
          //      留下其余全部。实测后果：11 条未读被反复"保留"，mark_read 每次都报
          //      "已读 0 条，保留 11 条"，于是**每一轮唤醒模型都看到同样那 11 条**，
          //      里面 4 条早前的 @ 被当成待办逐条补答 → 同一条消息被回复 3~4 次。
          //   2. 之所以当初想"保留排队消息"，是为了避免"繁忙期间入队的 @ 被顺手标掉、
          //      补发判定误判成已处理"（确有此事）。但正确做法是**只保留本轮唤醒之后
          //      新到的**——那些才是没被任何回合看过的。
          //
          // 判据用 seq 而不是时间：seq 是本地自增、单调，比时钟可靠。
          // 本轮唤醒后新到的消息 seq 一定大于唤醒时的水位。
          const wakeSeqAt = Number(st.wakeSeqAt) || 0;
          if (wakeSeqAt > 0) {
            st.unread = st.unread.filter((m) => Number(m?.seq) > wakeSeqAt);
          } else {
            // 拿不到水位（老状态/异常）时保守清空：宁可清掉也不让它永久滞留
            // ——滞留的代价是"无限重复回答"，比偶尔漏一条更严重。
            st.unread = [];
          }
          // 水位用掉即清，避免下一轮误用它去清刚到的消息。
          st.wakeSeqAt = 0;
          const keptUnread = st.unread.length;
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          ensureWakeableV2(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'mark_read';
          markReadCalledKeys.add(key);
          saveSocialV2State();
          log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount - keptUnread} 条${keptUnread ? `，保留 ${keptUnread} 条待补发唤醒的消息` : ''}，已确认下一次唤醒配置`);
          sendJson({ ok: true, key, markedCount, wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          const st = getSocialV2State(key);
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              ...current.triggers,
              ...inputTriggers,
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // 硬拦截（与 qq_mark_read 同规则）：未读里有人叫它、而本轮还没回应时，
          // 不允许直接设置潜水/下一次唤醒就走人——否则催它的人永远等不到回应。
          // 判据同样只看 pending：已经回过的那条 @ 不构成拦截理由（详见 qq_mark_read 处的说明）。
          if (isSleepingConfigV2(next)) {
            const callerMsgs2 = findCallersV2(key, st);
            // 与 qq_mark_read 同理：pending 已按 lastAiReplyAt 判过，
            // 不能再叠「本轮发过言」——早于新 @ 的回复也会让那个条件成立。
            if (callerMsgs2.pending.length) {
              const brief2 = callerMsgs2.pending
                .slice(-3)
                .map((m) => `${String(m.sender || '某人')}：${String(m.text || m.plain || '').slice(0, 30)}`)
                .join('；');
              sendJson({
                ok: false,
                error: `未读里有人在叫你，不能先潜水走人：${brief2}。请先正面回应（优先用 qq_reply；用 qq_send_message 时带 replyToMessageId，桥接才能确认你回的是哪条），回应后再设置下一次唤醒；如果这条你确实办不到，就直接对群友说明办不到的原因——话说给对方听，不要报告自己的处理流程或调度状态。`,
                callers: callerMsgs2.pending.length
              }, 400);
              return;
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st, key)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialV2State();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimerV2(key);
          log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          sendJson({ ok: true, key, wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of socialV2.conversations) {
            // 诊断：把 isConversationBusyV2 的四个判据分别透出，便于定位「虚假繁忙」卡在哪一项
            const sid = state.sessions[key];
            const q = promptQueues.get(key);
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0,
              busy: isConversationBusyV2(key, st),
              busyBy: {
                pendingWakeTimer: !!st.pendingWakeTimer,
                pendingWakeKeys: pendingWakeKeys.has(key),
                promptQueue: !!(q && (q.running || q.queue.length > 0)),
                promptQueueRunning: !!(q && q.running),
                promptQueueLen: q?.queue?.length ?? 0,
                v2TurnStartAt: !!(sid && v2TurnStartAt.has(sid)),
                collectors: !!(sid && collectors.has(sid))
              }
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const st = getSocialV2State(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          if (!st.bootstrapSent) st.bootstrapSent = true;
          saveSocialV2State();
          sendWakePromptV2(key, reason);
          log(`控制台：手动唤醒 ${key}（${reason}）`);
          sendJson({ ok: true, key, reason });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messages = stripLeadingMetaMarkers(normalizeMessagesInput(body.messages))
            .map((m) => String(m ?? '').trim())
            .filter(Boolean);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          try {
            const st = getSocialV2State(key);
            const now = Date.now();
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const rawMessages = normalizeMessagesInput(body.messages);
          const isRawString = typeof body.messages === 'string' && rawMessages.length === 1;
          // 剥掉模型误写在开头的元标记（如 `[[这是玩笑]]正文`）。
          // 放在归一化之后：归一化负责把 JSON 数组字符串拆成多条，剥标记针对的是最终的文本。
          const messages = stripLeadingMetaMarkers(rawMessages).map((m) => String(m ?? '').trim()).filter(Boolean);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息；数组模式原样使用调用方间隔。
          const gapMode = (isRawString && messages.length > 1) ? 'auto' : (body.gapMode === 'fixed' || body.gapMode === 'byLength' ? body.gapMode : 'auto');
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !isSymbolicReplyRef(replyToMessageId) && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数），或传 latest/上一条 表示引用最近一条别人的消息' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 干跑：只验证引用解析结果，不真发、不占用发送额度。用于排查「引用会引到哪条」，不打扰群。
          if (body.dryRun === true) {
            const stDry = getSocialV2State(key);
            const resolvedDry = (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '')
              ? await resolveReplyTargetV2(stDry, kind, id, String(replyToMessageId).trim())
              : null;
            sendJson({
              ok: !!resolvedDry || replyToMessageId == null || String(replyToMessageId).trim() === '',
              key,
              dryRun: true,
              wouldSend: messages,
              replyToMessageId: resolvedDry ? resolvedDry.messageId : null,
              quoted: resolvedDry ? resolvedDry.info : null
            });
            return;
          }
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId, { quoted: quotedInfo });
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            // 同 reply 端点：已回复的那条立即移出未读，避免本轮/下一轮重复回答同一条。
            if (sentMessages.length > 0 && quotedInfo?.messageId != null) {
              const before = st.unread.length;
              st.unread = st.unread.filter((m) => String(m?.messageId ?? '') !== String(quotedInfo.messageId));
              if (st.unread.length !== before) {
                log(`[reserved2] ${key} 已回复的消息从未读移除 1 条（余 ${st.unread.length}）`);
              }
            }
            // 记录这次明确引用回复的目标 seq：只有它算“已答”。
            if (sentMessages.length > 0 && quotedInfo?.messageId != null) {
              const targetEntry = st.recentMessages.find((m) => m && String(m.messageId) === String(quotedInfo.messageId));
              const targetSeq = Number(quotedInfo.seq) || Number(targetEntry?.seq) || 0;
              if (targetSeq) {
                const set = new Set((Array.isArray(st.answeredSeqs) ? st.answeredSeqs : []).map(Number).filter(Number.isFinite));
                set.add(targetSeq);
                st.answeredSeqs = [...set].slice(-200);
              }
            }
            saveSocialV2State();
            log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（QQ 号 / 昵称 / latest）' }, 400);
            return;
          }
          // 目标解析：允许 latest（最近戳我的人）或对方昵称，由桥接在本会话消息里换算成 QQ 号。
          //
          // 为什么必须支持（2026-10-22 事故）：模型被要求"有人戳你就回拍"，但唤醒提示里
          // 只有对方**名字**、没有 QQ 号；它于是复用上下文里残留的旧号，反复拍同一个人，
          // 群里被问「怎么一直戳我」。给它一条不依赖数字的路（同 replyToMessageId: latest 的思路），
          // 比在提示词里反复强调"别填错"可靠得多。
          if (kind === 'group') {
            const peek = getSocialV2State(key);
            const resolved = resolvePokeTarget({
              ref: targetUserId,
              unread: peek.unread,
              recentMessages: peek.recentMessages
            });
            if (!resolved.ok) {
              if (resolved.reason === 'ambiguous') {
                const cands = (resolved.candidates || []).map((c) => `${c.sender}(${c.userId})`).join('、');
                sendJson({ ok: false, error: `昵称「${targetUserId}」在本会话对应多人：${cands}。请直接传 QQ 号` }, 400);
                return;
              }
              if (resolved.reason === 'not-found') {
                sendJson({
                  ok: false,
                  error: isSymbolicPokeRef(targetUserId)
                    ? '最近没有戳你的人，无法用 latest；请传 QQ 号或对方昵称'
                    : `本会话里找不到「${targetUserId}」对应的 QQ 号，请传数字 QQ 号，或传 latest（最近戳你的人）`
                }, 400);
                return;
              }
              sendJson({ ok: false, error: 'targetUserId 不能为空' }, 400);
              return;
            }
            if (resolved.reason !== 'numeric') {
              log(`[拍一拍] ${key} 目标解析：${targetUserId} → ${resolved.userId}${resolved.sender ? `（${resolved.sender}）` : ''}，来源=${resolved.reason}`);
              targetUserId = resolved.userId;
            }
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          try {
            if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            // 自己的拍一拍记成**名字**并明确「你拍了拍」，不再写裸 QQ 号。
            //
            // 两个原因（2026-10-22 事故）：
            //   ① 裸号会被模型当成"可复用的目标"——上下文里唯一的数字就是它，
            //      下次要拍别人时没有号，就顺手拿这个顶上，反复拍同一个人；
            //   ② 写成「我拍了拍」时模型认不出那是自己的动作，群友问「怎么一直戳我」，
            //      它反而答「戳你的人不是鱼」。
            let targetName = targetUserId;
            if (kind === 'group') {
              try {
                targetName = (await resolveGroupMemberName(id, targetUserId)) || targetUserId;
              } catch { /* 查不到名字就退回号，不影响发送 */ }
            }
            const pokeText = kind === 'group'
              ? `[拍一拍] 你拍了拍 ${targetName}`
              : '[拍一拍] 你拍了拍对方';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 图库（reserved2）：按需取图发送 ────────────────────────────────
        // 发图预检：毫秒级告知「会立刻发」还是「要现拉等一会儿」。
        // 模型先调这个，就能在要等的时候先回一句「等我找找」再发图，避免闷头等十几秒。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/image-preflight') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendImage')) { sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return; }
          const rawTags = url.searchParams.get('tags') ?? '';
          const tags = rawTags ? rawTags.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean) : [];
          const rawSources = url.searchParams.get('sources') ?? '';
          const pf = imagePreflightV2(tags, rawSources, key);
          const gate = imageSendAllowed(key);
          // 已发图会被定期删除，所以「本地有」= 有**没发过的**图。
          // 这里把 TTL 说清楚，避免模型以为"本地永远有"而误判等待时间。
          const ttlMin = Math.round((Number(cfg.socialV2?.images?.sentTtlMs) || 0) / 60000);
          const srcFilter = normalizeSourceFilter(rawSources);
          sendJson({
            ok: true,
            key,
            tags,
            ...(srcFilter.requested ? { sources: srcFilter.valid } : {}),
            // 说明这个源限制是哪来的：模型自己传的，还是桥接从群主的话里识别的。
            // 后者要告诉模型，免得它以为"怎么只有一个站的图"。
            ...(srcFilter.requested && !normalizeSourceFilter(rawSources).requested
              ? { sourcesNote: `图源限制来自群主的话（${srcFilter.valid.join('/') || srcFilter.unavailable.join('/')}），桥接已自动应用，发图时不用重复传 sources。` }
              : {}),
            ...pf,
            sendAllowed: gate.ok,
            ...(gate.ok ? {} : { sendBlockedReason: gate.error }),
            ...(ttlMin > 0 ? { sentTtlMinutes: ttlMin } : {}),
            // 指定的源不可用时要说清楚，否则模型/群主不明白为什么查不到
            ...(srcFilter.unavailable.length ? { unavailableSources: srcFilter.unavailable } : {}),
            advice: srcFilter.requested && !srcFilter.valid.length
              ? `群主要求的图源（${srcFilter.unavailable.join('/')}）当前不可用，所以查不到任何图（也不会退回其他站点，因为那不符合要求）。可用图源：${Object.entries(cfg.socialV2?.images?.sources ?? {}).filter(([, v]) => v?.enabled === true).map(([k]) => k).join('/') || '无'}。请告诉群主这个站点目前用不了。`
              : pf.willWait
                ? `本地没有匹配的图（发过的图会在 ${ttlMin > 0 ? `${ttlMin} 分钟后被清理` : '下次清理时移除'}，所以库里主要是不重复的新图），这次发图需要现去图站拉取（可能 5~30 秒）${srcFilter.valid.length ? `，且只会在 ${srcFilter.valid.join('/')} 上找` : ''}。建议先用 qq_send_message 回一句（例如「等我找找」）再调用 qq_send_image，这样不会让对方干等；拉取期间你无法回应新消息。`
                : `本地有 ${pf.count} 张匹配的图${srcFilter.valid.length ? `（仅统计 ${srcFilter.valid.join('/')}）` : ''}，会立刻发出（约 0.1 秒），可以直接调用 qq_send_image。`
          });
          return;
        }
        // ── 按需拉取 X（Twitter）帖子并直接发到当前会话 ─────────────────────
        // 由 MCP 工具 qq_fetch_x_posts 调用：群友点名要看某个 X 账号的帖子时触发。
        // 参数：handle（账号，可带 @）、count（条数）、date（YYYY-MM-DD 指定某天）、
        //       lastHours（最近 N 小时）。拉取 → 翻译 → 渲染成卡片 → 发图。
        // X 登录凭据自检：查 state/x-auth.json 是否可用、能否连上 X（不泄露凭据值）。
        // 凭据会因改密码/登出而失效，出问题时先打这个端点定位。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/x-auth-check') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          const st = xMonitor.describeAuth();
          if (!st.available) { sendJson({ ok: false, ...st, hint: '按记忆 x-monitor 登录态的说明取 auth_token/ct0 写入 state/x-auth.json' }); return; }
          // 真的发一次请求验证（凭据存在≠有效）
          try {
            const probe = await xMonitor.verifyAuth();
            sendJson({ ok: probe.ok, ...st, ...probe });
          } catch (e) {
            sendJson({ ok: false, ...st, error: `自检失败：${e?.message ?? e}` });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/fetch-x-posts') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const handleRaw = String(body.handle ?? '').trim();
          if (!key || !handleRaw) { sendJson({ ok: false, error: 'key 和 handle 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }

          const account = handleRaw.replace(/^@/, '').trim();
          if (!/^[A-Za-z0-9_]{1,15}$/.test(account)) {
            sendJson({ ok: false, error: `账号名不合法：${handleRaw}（X 账号只能含字母/数字/下划线，最多 15 位）` }, 400);
            return;
          }

          const count = Math.max(1, Math.min(5, Number(body.count) || 1));
          // 时间条件三选一：date（某一天）/ lastHours（最近 N 小时）/ 默认（最新几条）
          let sinceMs = 0;
          let untilMs = 0;
          let rangeNote = '';
          if (body.date) {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(body.date).trim());
            if (!m) { sendJson({ ok: false, error: 'date 格式应为 YYYY-MM-DD' }, 400); return; }
            const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
            const end = new Date(start.getTime() + 24 * 3600 * 1000);
            sinceMs = start.getTime();
            untilMs = end.getTime();
            rangeNote = `${m[1]}-${m[2]}-${m[3]} 当天`;
          } else if (Number(body.lastHours) > 0) {
            const h = Math.min(24 * 30, Number(body.lastHours));
            sinceMs = Date.now() - h * 3600 * 1000;
            rangeNote = `最近 ${h} 小时`;
          }
          // 未来日期：直接拒绝（避免空转一圈）
          if (sinceMs && sinceMs > Date.now()) {
            sendJson({ ok: false, error: `指定的时间还没到（${String(body.date ?? '')}），换个日期或说“最新”` }, 400);
            return;
          }

          log(`[x-monitor] 按需拉取 @${account}（${rangeNote || '最新'}，${count} 条）→ ${key}${body.dryRun === true ? '（干跑）' : ''}`);
          let result;
          try {
            result = await xMonitor.fetchAndRender(account, { count, sinceMs, untilMs });
          } catch (e) {
            sendJson({ ok: false, error: `拉取失败：${e?.message ?? e}` }, 500);
            return;
          }

          if (!result.ok) {
            // 400 而非 404：「那天没发帖 / 翻不到那么远」是查询条件没有结果，
            // 不是接口不存在。404 会让调用方误以为是路由问题。
            sendJson({
              ok: false,
              error: result.errors.join('；') || '没有拉到帖子',
              user: result.user,
              fetched: 0,
              oldestMs: result.oldestMs || 0
            }, 400);
            return;
          }

          // 发图（每张一条消息，与真人发图节奏一致）
          // dryRun：只拉取+渲染、不发送。排障时用，避免测试消息打扰群（踩过：以为传 send:false
          // 能拦住，实际端点不认这个参数，结果真发到群里了）。
          const dryRun = body.dryRun === true;
          let sentCount = 0;
          let sentVideos = 0;
          const sendErrors = [];
          for (const item of result.posts) {
            if (dryRun) break;
            try {
              const dir = path.join(STATE_DIR, 'x-monitor');
              fs.mkdirSync(dir, { recursive: true });
              const file = path.join(dir, `x-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`);
              fs.writeFileSync(file, item.image.buffer);
              try {
                await onebotSendImageFile(key, file, { post: item.post });
              } finally {
                setTimeout(() => { try { fs.unlinkSync(file); } catch {} }, 60000).unref?.();
              }
              sentCount += 1;
              await sleep(700);   // 多条之间留点间隔，避免像刷屏
            } catch (e) {
              sendErrors.push(`${item.post.id}: ${e?.message ?? e}`);
            }
            // 视频必须**单独一条消息**发（SnowLuma 的 assertVideoSendPolicy：
            // video 段必须唯一且是消息里唯一的段），所以放在卡片之后另发，不与文字/图片同条。
            if (item.video?.file) {
              try {
                await sleep(500);
                await onebotSendVideoFile(key, item.video.file, { post: item.post });
                sentVideos += 1;
                await sleep(700);
              } catch (e) {
                sendErrors.push(`${item.post.id} 视频: ${e?.message ?? e}`);
              }
            }
          }

          const skippedNote = result.videoSkipped?.length
            ? `；跳过 ${result.videoSkipped.length} 个超限视频（${result.videoSkipped.map((v) => v.reason).join('；')}）`
            : '';
          log(`[x-monitor] @${account} 拉取完成：${dryRun ? `干跑（未发送）${result.posts.length} 条` : `发出 ${sentCount}/${result.posts.length} 张图、${sentVideos} 个视频`}${skippedNote}${sendErrors.length ? `，失败 ${sendErrors.length}` : ''}`);
          sendJson({
            ok: dryRun ? result.posts.length > 0 : sentCount > 0,
            dryRun: dryRun || undefined,
            user: result.user,
            fetched: result.posts.length,
            sent: sentCount,
            sentVideos,
            videoSkipped: result.videoSkipped ?? [],
            posts: result.posts.map((p) => ({
              id: p.post.id,
              url: p.post.url,
              createdAt: p.post.createdAt,
              createdAtMs: p.post.createdAtMs,
              pinnedSkipped: result.pinnedSkipped,
              hasVideo: !!p.video,
              videoBytes: p.video?.bytes ?? 0,
              videoSize: p.video ? `${p.video.width}x${p.video.height}` : '',
              videoDurationMs: p.video?.durationMs ?? 0,
              summary: String(p.post.text || '').replace(/\s+/g, ' ').slice(0, 120)
            })),
            errors: [...result.errors, ...sendErrors].slice(0, 5)
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-image') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发图必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendImage')) { sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发图' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发图' }, 403); return; }
          const tags = Array.isArray(body.tags) ? body.tags.map(String) : (body.tags ? String(body.tags).split(/[,，\s]+/) : []);
          // mode → 排序与时间窗。「日榜」用 age:<2day + order:score 近似
          // （图站没有真正的 pixiv 式日榜；近两日按热度是最接近的语义）。
          const modeMap = {
            hot: { order: 'score', maxAgeDays: 0 },
            daily: { order: 'score', maxAgeDays: 2 },
            new: { order: 'new', maxAgeDays: 0 },
            random: { order: 'random', maxAgeDays: 0 }
          };
          const mode = modeMap[String(body.mode ?? 'hot')] ?? modeMap.hot;
          try {
            const r = await sendImageV2(key, { tags, replyToMessageId: body.replyToMessageId, sources: body.sources, ...mode });
            const st = getSocialV2State(key);
            // 记入会话时间线，让 AI 与后续上下文知道「我刚发了张图」
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: `[图片] 已发送一张图（${r.entry.source}${r.entry.artist ? ' / ' + r.entry.artist : ''}）`,
              plain: '[图片]',
              tail: '[图片]',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = Date.now();
            st.lastActionAt = Date.now();
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[图库] 工具发图 ${key}：${r.entry.id}`);
            appendActivity(`${key} [图库] 已发送图片（${r.entry.source}）`);
            // tagCorrections：告知调用方「你要的词被换成了别的标签」。
            // 模型据此自查：若换后的标签跨了作品/角色，应主动说明或更正，别当查到了就完事。
            sendJson({
              ok: true,
              key,
              source: r.entry.source,
              artist: r.entry.artist,
              page: r.entry.page,
              annotation: r.annotation,
              ...(r.tagCorrections?.length
                ? {
                    tagCorrections: r.tagCorrections.map((c) => `${c.from} → ${c.to}（${c.postCount} 张）`),
                    notice: `注意：你给的标签「${r.tagCorrections.map((c) => c.from).join('、')}」在上游不存在，已自动改用「${r.tagCorrections.map((c) => c.to).join('、')}」。如果这与你想要的角色/作品不符（例如名字相近但是不同作品），请告诉群友你实际发的是什么，别默认它就是要的那张。`
                  }
                : {})
            });
          } catch (error) {
            log(`[图库] 工具发图失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/archive-image') {
          const body = await readBody();
          // 同 refresh-image-lib 的鉴权：管理员可直接调，AI 必须带合法 agent token。
          let allowed = !req.headers['x-agent-token'];
          let vkey = '';
          if (req.headers['x-agent-token']) {
            vkey = String(body.key ?? '').trim();
            allowed = !!vkey && agentTokenOk(vkey, req.headers['x-agent-token']) && v2SessionAllowed(vkey) && v2ToolEnabled('archiveImage');
          }
          if (!allowed) { sendJson({ ok: false, error: '无权收藏图片' }, 403); return; }
          if (!imagesEnabled()) { sendJson({ ok: false, error: '图库未启用' }, 403); return; }
          // 目标：显式 id，或本会话「最近发出的那张」
          let entry = null;
          const wantId = String(body.id ?? '').trim();
          if (wantId) entry = imageStore.getById(wantId);
          if (!entry && vkey) {
            const last = lastSentImage.get(vkey);
            if (last) entry = imageStore.getById(last.id) ?? last.entry ?? null;
          }
          if (!entry) { sendJson({ ok: false, error: wantId ? `图库中没有 ${wantId}` : '未指定 id，且本会话最近没发过图' }, 404); return; }
          try {
            const r = await archiveImage(entry);
            log(`[图库] 已收藏原图 ${entry.id} → ${r.path}（${(r.bytes / 1024).toFixed(0)}KB${r.skipped ? '，此前已存过' : ''}）`);
            appendActivity(`${vkey || 'admin'} [图库] 收藏原图 ${entry.id}（${(r.bytes / 1024).toFixed(0)}KB）`);
            sendJson({
              ok: true,
              id: entry.id,
              path: r.path,
              originalUrl: r.url,
              bytes: r.bytes,
              alreadySaved: !!r.skipped,
              note: r.skipped
                ? `此前已收藏过，文件在 ${r.path}`
                : `已把原图保存到 ${r.path}（${(r.bytes / 1024).toFixed(0)}KB）`
            });
          } catch (error) {
            log(`[图库] 收藏原图失败 ${entry.id}: ${error?.message ?? error}`);
            sendJson({ ok: false, id: entry.id, error: `收藏失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 反向搜图（以图搜图）：拿一张图去 SauceNAO 反查出处（谁画的、来自哪个站）。
        // 参数：messageId（群友发的那条消息，取其图）或 id（图库里某张）；两者都没有则用
        // 本会话「最近发出的那张」。与 /image-source 的区别：那个只查**图库已有条目**的元数据，
        // 这个能对**任意一张图**做全站反查（含群友发的外来图）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/reverse-search') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (key && req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (key && req.headers['x-agent-token'] && !v2ToolEnabled('reverseSearch')) { sendJson({ ok: false, error: '工具未启用：qq_reverse_search' }, 403); return; }
          if (cfg.imageReverseSearch?.enabled === false) { sendJson({ ok: false, error: '反向搜图已关闭（imageReverseSearch.enabled）' }, 403); return; }
          const avail = reverseSearcher.available();
          if (!avail.ok) { sendJson({ ok: false, error: avail.reason, needKey: true }, 400); return; }

          const wantMsgId = String(url.searchParams.get('messageId') ?? '').trim();
          const wantId = String(url.searchParams.get('id') ?? '').trim();
          let buffer = null;
          let from = '';
          if (wantMsgId && key) {
            const media = await findMessageMediaAsync(key, wantMsgId);
            if (!media.length) { sendJson({ ok: false, error: '这条消息里没有图片/表情' }, 404); return; }
            const imgs = await fetchMediaData(media.slice(0, 1));
            const first = imgs.find((x) => x?.data);
            if (!first) { sendJson({ ok: false, error: '图片读取失败（可能已过期或取不到原图）' }, 404); return; }
            buffer = Buffer.from(first.data, 'base64');
            from = `消息 ${wantMsgId}`;
          } else {
            let entry = wantId ? imageStore.getById(wantId) : null;
            if (!entry && key) {
              const last = lastSentImage.get(key);
              if (last) entry = imageStore.getById(last.id) ?? last.entry ?? null;
            }
            if (!entry) { sendJson({ ok: false, error: wantId ? `图库中没有 ${wantId}` : '请给 messageId（群友发的图）或 id（图库图）' }, 404); return; }
            buffer = imageStore.readBuffer(entry);
            if (!buffer) { sendJson({ ok: false, error: '图库文件读取失败' }, 500); return; }
            from = `图库 ${entry.id}`;
          }

          const r = await reverseSearcher.search(buffer, {
            db: Number(cfg.imageReverseSearch?.db) || 999,
            minsim: Number(cfg.imageReverseSearch?.minsim) || 50,
            numres: Number(cfg.imageReverseSearch?.numres) || 5
          });
          if (!r.ok) { sendJson({ ok: false, error: r.error }, r.quota ? 429 : 502); return; }
          const top = r.results?.[0];
          sendJson({
            ok: true,
            from,
            cached: !!r.cached,
            count: r.results.length,
            results: r.results,
            note: top
              ? `最匹配：${top.site || '未知站点'}（相似度 ${top.similarity.toFixed(1)}%）`
                + (top.creator ? `，作者 ${top.creator}` : '')
                + (top.urls?.length ? `，出处 ${top.urls[0]}` : '')
              : '没找到相似度足够高的来源（可能是原创/改图/冷门作品）',
            stats: reverseSearcher.stats()
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/image-source') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (key && req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (key && req.headers['x-agent-token'] && !v2ToolEnabled('imageSource')) { sendJson({ ok: false, error: '工具未启用：qq_image_source' }, 403); return; }
          // 目标：显式给 id，或用本会话「最近发出的那张」（模型通常不知道图库 id）
          let entry = null;
          const wantId = String(url.searchParams.get('id') ?? '').trim();
          if (wantId) entry = imageStore.getById(wantId);
          if (!entry && key) {
            const last = lastSentImage.get(key);
            if (last) entry = imageStore.getById(last.id) ?? last.entry ?? null;
          }
          if (!entry) {
            sendJson({ ok: false, error: wantId ? `图库中没有 ${wantId}` : '本会话最近没有发出过图，也请传 id' }, 404);
            return;
          }
          const sp = sourcePageOf(entry);
          sendJson({
            ok: true,
            id: entry.id,
            source: entry.source || '',
            artist: entry.artist || '',
            artistId: entry.artistId || '',
            // originUrl：画师原始发布处；sourcePage：图源站条目页
            originUrl: entry.page || '',
            sourcePage: sp,
            tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 40) : [],
            rating: entry.rating || '',
            width: entry.width || 0,
            height: entry.height || 0,
            note: sp
              ? `这是在 ${entry.source} 上查这张图的页面：${sp}${entry.page && entry.page !== sp ? `；画师原始发布处：${entry.page}` : ''}`
              : '该图没有可推导的图源站点页面'
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/react-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          // 鉴权同 send-image：reserved2 下 AI 必须带 agent token
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式贴表情必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('reactMessage')) { sendJson({ ok: false, error: '工具未启用：qq_react_message' }, 403); return; }
          if (cfg.socialV2?.emojiReact?.enabled === false) { sendJson({ ok: false, error: '贴表情功能已关闭（socialV2.emojiReact.enabled）' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能贴表情' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const convId = Number(keyMatch[2]);
          if (!Number.isFinite(convId) || convId <= 0 || !modeAllowed(key, kind, convId, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          // QQ 的表情回应**只支持群聊**（实测私聊报 "emoji reactions are not supported
          // on private messages"）。提前拦掉并说清原因，别让模型以为是自己参数错了。
          if (kind !== 'group') {
            sendJson({ ok: false, error: 'QQ 的表情回应只支持群消息，私聊不支持（这不是参数问题，无需重试）' }, 400);
            return;
          }
          const rawId = String(body.messageId ?? body.id ?? '').trim();
          if (!rawId) { sendJson({ ok: false, error: 'messageId 不能为空（用 qq_get_unread_messages 里的 messageId）' }, 400); return; }
          const emojiId = String(body.emojiId ?? '').trim();
          const v = validateEmojiId(emojiId, emojiCatalogIds());
          if (!v.ok) {
            sendJson({ ok: false, error: v.reason, ...(v.hint ? { hint: v.hint } : {}) }, 400);
            return;
          }
          const set = body.set !== false; // 默认贴；传 set:false 撤销
          // 限流：模型可能一时兴起连贴一串。撤销不计入限流（那是修正行为）。
          if (set) {
            const gate = emojiReactGate.check(key);
            if (!gate.allow) { sendJson({ ok: false, error: gate.reason, rateLimited: true }, 429); return; }
          }
          const ok = await setEmojiLike(convId, rawId, emojiId, set);
          if (!ok) {
            sendJson({ ok: false, error: '贴表情失败（消息可能太旧、已不在 QQ 消息缓存里；请对较新的消息贴）' }, 502);
            return;
          }
          const named = REACTION_EMOJIS.find((e) => String(e.id) === emojiId);
          log(`[表情] ${key} ${set ? '贴了' : '撤销了'}「${named?.name || emojiId}」（msg ${rawId}）`);
          appendActivity(`${key} [表情] ${set ? '贴' : '撤销'}${named?.name || emojiId}`);
          sendJson({ ok: true, key, messageId: rawId, emojiId, emojiName: named?.name || '', set });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reject-image') {
          const body = await readBody();
          // 同 refresh-image-lib 的鉴权：管理员可直接调，AI 必须带合法 agent token。
          let allowed = !req.headers['x-agent-token'];
          let vkey = '';
          if (req.headers['x-agent-token']) {
            vkey = String(body.key ?? '').trim();
            allowed = !!vkey && agentTokenOk(vkey, req.headers['x-agent-token']) && v2SessionAllowed(vkey) && v2ToolEnabled('rejectImage');
          }
          if (!allowed) { sendJson({ ok: false, error: '无权删除图库图片' }, 403); return; }
          if (!imagesEnabled()) { sendJson({ ok: false, error: '图库未启用' }, 403); return; }
          // 目标：显式给 id；不传则用本会话「最近发出的那张」（AI 通常不知道图库 id）
          let targetId = String(body.id ?? '').trim();
          if (!targetId && vkey) targetId = lastSentImage.get(vkey)?.id ?? '';
          if (!targetId) { sendJson({ ok: false, error: '没有可删除的目标（未指定 id，且本会话最近没发过图）' }, 400); return; }
          const r = imageStore.reject(targetId, { reason: String(body.reason ?? 'AI 判定不合适') });
          if (vkey && lastSentImage.get(vkey)?.id === targetId) lastSentImage.delete(vkey);
          log(`[图库] 删除并拒绝 ${targetId}（${r.existed ? '已从库中移除' : '条目原本不在库'}，原因：${body.reason ?? '未说明'}）`);
          appendActivity(`${vkey || 'admin'} [图库] 删除图 ${targetId}（${String(body.reason ?? '').slice(0, 30)}）`);
          sendJson({ ok: true, id: targetId, removed: r.existed, freedBytes: r.freedBytes ?? 0, note: '该图已加入拒绝名单，之后不会再被拉取或发出' });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/image-stats') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          sendJson({
            ok: true,
            enabled: imagesEnabled(),
            libDir: imageStore.libDir,
            ...imageStore.stats(),
            fetchedAt: imageFetchedAt || null,
            sources: Object.fromEntries(
              Object.entries(cfg.socialV2?.images?.sources ?? {}).map(([n, c]) => [n, { enabled: c?.enabled === true, limit: c?.limit ?? 20 }])
            )
          });
          return;
        }
        // ── 取图额度总览（控制台「12c 取图额度」卡片）──────────────────────
        //
        // 用户要求（2026-10-20）：「取图 API 额度能不能在控制台中加一个显示」。
        //
        // 这里把**三类互相独立的上限**放在一起，因为它们都会以"取不到图"的形式
        // 表现，但原因完全不同，混在一起排查会走错方向：
        //   ① 图库容量（maxFiles / maxTotalBytes）——满了会淘汰旧图，不代表不能用
        //   ② 拉取冷却（cooldownMs）——两次"补货"之间的最小间隔，冷却中预检会 willWait
        //   ③ SauceNAO 反查额度（每天 100 次 / 30 秒 1 次）——**真正的上游免费额度**，
        //      用完了当天就没法反查（这是唯一"会真的用完"的）
        // 另外附各图源的启用状态，因为"某个源没开"也会被误当成额度问题。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/image-quota') {
          const ic = cfg.socialV2?.images ?? {};
          const now = Date.now();
          const enabled = imagesEnabled();

          // 图库容量
          let lib = null;
          try { lib = imageStore.stats(); } catch { lib = null; }

          // 拉取冷却：imageFetchedAt 是"上次成功拉取"的时刻
          const cooldownMs = Math.max(0, Number(ic.cooldownMs) || 0);
          const sinceFetch = imageFetchedAt ? now - imageFetchedAt : Infinity;
          const cooling = cooldownMs > 0 && imageFetchedAt > 0 && sinceFetch < cooldownMs;

          // 反查额度（唯一真正的"API 额度"）
          const rs = reverseSearcher.stats();

          // 各图源开关：pixiv/yandere 默认关，容易和"额度用完"混淆
          const srcCfg = ic.sources ?? {};
          const sources = Object.keys(srcCfg).map((name) => ({
            name,
            enabled: srcCfg[name]?.enabled === true,
            limit: Number(srcCfg[name]?.limit) || 0,
            hasProxy: !!String(srcCfg[name]?.proxy || ic.proxy || '').trim()
          }));

          // 每会话发送限频（同会话冷却 / 每小时上限）——也不是"额度"，但会拦发图
          sendJson({
            ok: true,
            enabled,
            library: lib,
            fetch: {
              cooldownMs,
              lastFetchedAt: imageFetchedAt || 0,
              cooling,
              remainMs: cooling ? Math.max(0, cooldownMs - sinceFetch) : 0,
              fetching: !!imageFetching,
              fetchPerRun: Math.max(1, Number(ic.fetchPerRun) || 20)
            },
            reverseSearch: {
              hasKey: rs.hasKey,
              usedToday: rs.usedToday,
              dailyMax: rs.dailyMax,
              remainingToday: rs.remainingToday,
              windowMax: rs.windowMax,
              windowUsed: rs.windowUsed,
              windowResetMs: rs.windowResetMs,
              cached: rs.cached
            },
            send: {
              cooldownMs: Math.max(0, Number(ic.sendCooldownMs) || 0),
              maxSendPerHour: Math.max(0, Number(ic.maxSendPerHour) || 0)
            },
            sources
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/refresh-image-lib') {
          const body = await readBody();
          // 管理员可直接刷；AI 必须带合法 agent token（允许它自己按需补图，但受限频）。
          let allowed = !req.headers['x-agent-token'];
          if (req.headers['x-agent-token']) {
            const key = String(body.key ?? '').trim();
            allowed = !!key && agentTokenOk(key, req.headers['x-agent-token']) && v2SessionAllowed(key) && v2ToolEnabled('refreshImageLib');
          }
          if (!allowed) { sendJson({ ok: false, error: '无权刷新图库' }, 403); return; }
          if (!imagesEnabled()) { sendJson({ ok: false, error: '图库未启用：请在 config.json 设置 socialV2.images.enabled=true' }, 403); return; }
          try {
            const r = await refreshImageLib({
              force: body.force === true && !req.headers['x-agent-token'],
              tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
              order: body.order,
              maxAgeDays: body.maxAgeDays,
              limit: body.limit,
              sources: Array.isArray(body.sources) ? body.sources.map(String) : undefined
            });
            if (r.cooled) {
              sendJson({ ok: true, cooled: true, remainMs: r.remainMs, total: imageStore.count() });
            } else {
              sendJson({ ok: true, added: r.added, skipped: r.skipped, total: r.total, errors: (r.errors ?? []).slice(0, 5) });
            }
          } catch (error) {
            sendJson({ ok: false, error: `${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 表情包体系（reserved2） ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
          try {
            const entry = await getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType, data: fetched.buffer.toString('base64') }
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
          // publish=1：**顺便把形象图发到当前会话**（用户要求「别人问及自拍时把自拍图片一并发出去」）。
          //
          // 为什么由桥接发、而不是让模型再调一次 qq_send_image：
          //   qq_send_image 只会从图库里挑图，拿不到这张本地形象图；
          //   而且分两步会让模型「看了图却忘了发」，或被问「发张自拍」时只描述长相。
          //   一次做完「放进视觉上下文 + 发到群里」才是能用的语义。
          const publish = ['1', 'true', 'yes'].includes(String(url.searchParams.get('publish') ?? '').toLowerCase());
          const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
          try {
            if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
            const buf = fs.readFileSync(selfPath);
            const mimeType = mimeFromBuffer(buf) || 'image/png';
            const image = { mimeType, data: buf.toString('base64') };

            // 发图前照例过一遍准入与静默：不能因为「是自拍」就绕过暂停/静默/模式限制
            let sent = null;
            let sendError = '';
            if (publish) {
              if (currentMode !== 'reserved2') {
                sendError = '该接口仅 reserved2 模式可用';
              } else if (socialV2.paused) {
                sendError = '二代 AI 已暂停，不能发图';
              } else if (shouldBlockSilentReply(key)) {
                sendError = '静默模式已开启，当前不允许发图';
              } else {
                try {
                  const r = await onebotSendImageFile(key, buf, { label: '［自拍］' });
                  sent = r?.message_id ?? true;
                  // 记进会话时间线：模型与后续上下文要知道"我刚发了张自拍"
                  const st = getSocialV2State(key);
                  st.recentMessages.push({
                    messageId: null,
                    sender: '我',
                    text: '[图片] 发了张自己的形象图',
                    plain: '[图片]',
                    tail: '[图片]',
                    quoteTargetIsSelf: false,
                    isOwner: true,
                    ownerLabel: '我',
                    isSelf: true,
                    media: [],
                    hasMedia: false,
                    forwardIds: [],
                    hasForward: false,
                    time: Date.now()
                  });
                  const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
                  if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
                  st.lastAiReplyAt = Date.now();
                  st.lastActionAt = Date.now();
                  st.wakeConfig.noActionCount = 0;
                  saveSocialV2State();
                  appendActivity(`${key} [自拍] 已发送形象图`);
                  log(`[自拍] 已发送形象图 → ${key}`);
                } catch (error) {
                  // 发失败不算致命：图仍然给模型（它至少能照着描述），但要如实告知
                  sendError = String(error?.message ?? error);
                  log(`[自拍] 发送失败 ${key}：${sendError}`);
                }
              }
            }

            sendJson({
              ok: true,
              key,
              image,
              published: publish,
              sent: sent || undefined,
              // 没发出去时给模型一句可转述的话，避免它以为已经发了
              sendError: sendError || undefined
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 功能菜单图：群友问「你会啥/能干嘛」时，渲染并**直接发到当前会话**。
        //
        // 为什么由桥接发而不是把 base64 还给模型：模型没有"发送任意图片"的能力
        // （qq_send_image 只认图库里的图，拿不到这张实时渲染的菜单），
        // 让工具一次做完"渲染 + 发送"才符合模型能用得上的语义。
        //
        // 渲染走 Chrome 无头截图（见 feature-menu-render.js），按内容指纹缓存，
        // 反复问只渲染一次。失败时如实报错，不退回让模型自己编功能清单。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/send-feature-menu') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          // agent token 是**必需**的，不是可选（与 send-image 同规则）。
          // 早期写法是 `if (agentToken && !agentTokenOk(...))`，那样空 token 会跳过所有校验：
          // 因为控制台鉴权在 consoleToken 留空时不拦，任何能访问 3100 的人都能触发发群。
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '发送功能菜单必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('getFeatureMenu')) { sendJson({ ok: false, error: '工具未启用：qq_send_feature_menu' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: 'AI 已暂停，当前不允许发送' }, 403); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许向该会话发送' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          try {
            const force = url.searchParams.get('refresh') === '1';
            const r = await renderFeatureMenu({ force, config: cfg, roleName: readRoleState().role || '', log: (m) => log(m) });
            if (!r.ok) { sendJson({ ok: false, error: r.error }, 500); return; }
            // 图库目录下不碰：菜单是桥接自有产物，放 state/feature-menu 缓存目录里直接发
            await onebotSendImageFile(key, r.file, { label: '群友功能菜单' });
            log(`[功能菜单] 已发送到 ${key}（${Math.round(r.bytes / 1024)}KB${r.cached ? '，缓存' : '，新渲染'}）`);
            appendActivity(`${key} [功能菜单] 已发送功能菜单图`);
            sendJson({ ok: true, key, cached: r.cached, bytes: r.bytes });
          } catch (error) {
            log(`功能菜单发送失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `功能菜单发送失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── GitHub 仓库首页截图（2026-10-20 用户要求）─────────────────────────
        //
        // 「解析 GitHub 链接并把仓库首页整个截图并发送」。
        //
        // 为什么自己截图而不是抓 API：群友要的是**看到页面长什么样**（Star 数、
        // 文件列表、README 排版、语言占比条），这些只有渲染后的页面有。
        // GitHub API 只给元数据，画不出首页。
        //
        // 为什么分段发：实测首页整页约 15400px，一张 1400×15400 的图在 QQ 里
        // 会被等比压成灰色细线（文字 1~2 像素高，完全看不清）。按 2400px 切段，
        // 每段仍是 1400 宽、文字清晰，按顺序看就是完整页面。
        //
        // 网络：实测直连 github.com 会 ECONNRESET，必须走代理（见下面 proxy 取值）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/github-shot') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const raw = String(body.url ?? body.text ?? '').trim();
          const gs = cfg.socialV2?.githubShot ?? {};
          if (gs.enabled === false) { sendJson({ ok: false, error: 'GitHub 截图功能已关闭（socialV2.githubShot.enabled）' }, 400); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          // agent token 必需（与 send-image / send-feature-menu 同规则）：
          // 这是个会往群里发东西的写操作，不能靠"控制台没设令牌"就放行。
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'GitHub 截图必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('githubShot')) { sendJson({ ok: false, error: '工具未启用：qq_github_shot' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: 'AI 已暂停，当前不允许发送' }, 403); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许向该会话发送' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }

          // 解析：允许直接贴链接，也允许贴一段含链接的消息文本
          const candidate = parseGitHubUrl(raw) ? raw : (extractGitHubUrl(raw) || raw);
          const info = parseGitHubUrl(candidate);
          if (!info) {
            sendJson({ ok: false, error: '识别不出 GitHub 仓库（支持 https://github.com/owner/repo、owner/repo；不支持 /issues、/tree 等子页面，会归到仓库首页）' }, 400);
            return;
          }

          // 同一仓库同一会话 30 秒内不重复截（群友常连发两次链接）
          const shotKey = `${key}|${info.url}`;
          const lastAt = gitHubShotTimes.get(shotKey) || 0;
          if (Date.now() - lastAt < 30000) {
            sendJson({ ok: false, error: '刚截过这个仓库，30 秒内不重复发（避免刷屏）' }, 429);
            return;
          }

          try {
            const proxy = String(gs.proxy || cfg.socialV2?.images?.proxy || '').trim();
            const shot = await screenshotGitHubRepo(info, {
              proxy,
              width: 1400,
              sliceHeight: Math.max(0, Number(gs.sliceHeight) || 2400),
              maxHeight: Math.max(1000, Number(gs.maxHeight) || 12000),
              waitMs: Math.max(0, Number(gs.waitMs) || 3500),
              timeoutMs: Math.max(10000, Number(gs.timeoutMs) || 90000)
            });

            const slices = Array.isArray(shot.slices) && shot.slices.length
              ? shot.slices
              : [{ buffer: shot.buffer, mimeType: shot.mimeType, height: shot.height, fromY: 0 }];

            // 先发一句说明（含页数），群友知道后面还有几张
            const label = info.repo ? `${info.owner}/${info.repo}` : info.owner;
            const note = slices.length > 1
              ? `GitHub ${label} 首页（整页 ${Math.round(shot.height)}px，分 ${slices.length} 张发）`
              : `GitHub ${label} 首页`;
            try { await sendToQQ(key, note); } catch { /* 说明发失败不影响截图 */ }

            let sentCount = 0;
            for (const s of slices) {
              try {
                await onebotSendImageFile(key, s.buffer, { label: `［GitHub］${label}` });
                sentCount += 1;
              } catch (error) {
                log(`[GitHub] 第 ${sentCount + 1} 张发送失败：${error?.message ?? error}`);
                break; // 后面几张大概率也会失败（限频/断线），别硬刷
              }
            }
            if (!sentCount) throw new Error('截图已生成但一张都没发出去');

            gitHubShotTimes.set(shotKey, Date.now());
            // 只留最近 200 条，避免无限增长
            while (gitHubShotTimes.size > 200) {
              const oldest = gitHubShotTimes.keys().next().value;
              if (oldest === undefined) break;
              gitHubShotTimes.delete(oldest);
            }

            // 记进会话时间线：后续上下文要知道"我刚发过这个仓库的截图"
            const st = getSocialV2State(key);
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: `[图片] 发了 GitHub ${label} 首页截图（${sentCount} 张）`,
              plain: '[图片]',
              tail: '[图片]',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = Date.now();
            st.lastActionAt = Date.now();
            saveSocialV2State();

            log(`[GitHub] 已发送 ${label} 首页截图 ${sentCount}/${slices.length} 张（整页 ${shot.height}px${shot.truncated ? '，已截断' : ''}）`);
            appendActivity(`${key} [GitHub] 已发送 ${label} 首页截图 ${sentCount} 张`);
            sendJson({
              ok: true,
              repo: label,
              url: info.url,
              sent: sentCount,
              slices: slices.length,
              height: shot.height,
              contentHeight: shot.contentHeight,
              truncated: shot.truncated,
              // 让模型知道"还差最后一张没发"之类的情况
              note: sentCount < slices.length ? `只发出 ${sentCount}/${slices.length} 张（后面的发送失败）` : undefined
            });
          } catch (error) {
            const msg = String(error?.message ?? error);
            log(`[GitHub] 截图失败 ${info.url}：${msg}`);
            // 直连失败是最常见的原因，直接点明，省得模型瞎猜
            const hint = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|net::ERR/i.test(msg)
              ? '（GitHub 在本机直连不通，需要在 config.json 的 socialV2.githubShot.proxy 或 socialV2.images.proxy 配置代理）'
              : '';
            sendJson({ ok: false, error: `截图失败：${msg}${hint}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          sendJson({ ok: true, key, sticker: entry });
          return;
        }
        // 删除收藏表情（写操作，默认关闭 —— 与 set-sticker-remark 同级）。
        // 之所以默认关：上游 delete_custom_face 不校验 emoji_id，
        // 开放后模型一旦传错就会静默删掉别的表情（详见 deleteStickerV2 注释）。
        // 开启方式：config.json 的 socialV2.tools.deleteSticker = true。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-delete') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('deleteSticker')) { sendJson({ ok: false, error: '工具未启用：qq_delete_sticker' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行写操作' }, 403); return; }
          // **仅管理员可用**（2026-10-15 用户要求）：群里群友和管理员共用一个会话，
          // 上面的 v2SessionAllowed 只验证"这个会话在白名单里"，不能说明"刚说话的是管理员"。
          // 所以还要按最近一条入站消息的发送者判定，非管理员直接拒绝。
          if (!isOwnerTurn(key)) {
            log(`[sticker] 拒绝删除表情：请求者不是管理员（${key}）`);
            sendJson({ ok: false, error: '删除收藏表情仅管理员可用。如果确实需要删，请让管理员来说。' }, 403);
            return;
          }
          try {
            const r = await deleteStickerV2(stickerId);
            log(`[sticker] 删除收藏表情 ${key}: ${r.id}（${r.desc}）回读确认=${r.verifiedGone ? '已消失' : '未确认'}`);
            appendActivity(`${key} [表情] 已删除收藏表情${r.desc ? `「${r.desc}」` : ''}`);
            sendJson({ ok: true, key, deleted: { id: r.id, md5: r.md5, desc: r.desc }, verifiedGone: r.verifiedGone });
          } catch (error) {
            sendJson({ ok: false, error: `删除表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
          // 与删除同理：改的是 QQ 账号上的官方备注，**仅管理员可用**。
          if (!isOwnerTurn(key)) {
            log(`[sticker] 拒绝改备注：请求者不是管理员（${key}）`);
            sendJson({ ok: false, error: '修改收藏表情备注仅管理员可用。' }, 403);
            return;
          }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 语音消息（GPT-SoVITS）：模型主动发一条语音。
        //
        // 用户反馈（2026-10-22）：群友说「你发个语音」，机器人回「语音我发不出来呀」。
        // 原因是之前只有"桥接按概率把普通回复换成语音"，**模型无从得知、也无法主动调用**。
        // 这个端点让 qq_send_voice 真正能发。
        //
        // 与"概率语音"共用一个引擎与缓存；区别是这里**不受概率限制**——
        // 群友明确要听，就该发。但仍受每小时上限约束（防止一次要十句）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const text = String(body.text ?? '').trim();
          if (!key || !text) { sendJson({ ok: false, error: 'key 和 text 不能为空' }, 400); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '发送语音必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!ttsEngine || !ttsEngine.available()) {
            sendJson({ ok: false, error: '语音合成不可用（未启用、未加载完成或探测失败；见控制台「17b 语音合成」）' }, 503);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const limitChars = Math.max(20, Number(cfg.socialV2?.tts?.maxChars) || 140);
          if (text.length > limitChars) {
            sendJson({ ok: false, error: `语音最多 ${limitChars} 字（念太长没人听）；这句有 ${text.length} 字，请精简或改用文字` }, 400);
            return;
          }
          // 念出来没有意义的内容直接挡掉（与概率语音同一套规则）
          if (/https?:\/\/|www\.|```/.test(text)) {
            sendJson({ ok: false, error: '这条内容含链接或代码，念出来没用；请改用文字发送' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          const now = Date.now();
          const hist = (Array.isArray(st.ttsTimes) ? st.ttsTimes : []).filter((x) => now - Number(x) < 3600000);
          const maxPerHour = ttsNum(cfg.socialV2?.tts?.maxPerHour, 3, 0, 60);
          if (maxPerHour > 0 && hist.length >= maxPerHour) {
            sendJson({ ok: false, error: `这个会话一小时最多 ${maxPerHour} 条语音，已经发完了；这条先用文字吧` }, 429);
            return;
          }
          try {
            const r = await ttsEngine.speak(text);
            if (!r.ok) { sendJson({ ok: false, error: `合成失败：${r.error}` }, 500); return; }
            await onebotSendVoiceFile(key, r.file, { text });
            st.ttsTimes = [...hist, Date.now()].slice(-200);
            st.lastTtsAt = Date.now();
            // 主动语音也是一次真实发言：更新回复时间，并把 [语音] 标记写回
            // recentMessages/journal，避免模型下一轮不知道刚才发的是语音。
            st.lastAiReplyAt = Date.now();
            st.lastActionAt = st.lastAiReplyAt;
            st.wakeConfig.noActionCount = 0;
            recordSentMessagesV2(key, [{ text, isVoice: true }]);
            saveSocialV2State();
            log(`[TTS] 主动发语音（${r.cached ? '缓存' : `${r.synthSec ?? '?'}s 合成`}，${r.durSec}s，${text.length} 字）→ ${key}`);
            appendActivity(`${key} [TTS] 主动发了一条语音（${r.durSec}s）`);
            sendJson({ ok: true, key, durSec: r.durSec, cached: !!r.cached, chars: text.length });
          } catch (error) {
            log(`[TTS] 主动发语音失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !isSymbolicReplyRef(replyToMessageId) && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数），或传 latest/上一条 表示引用最近一条别人的消息' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: text.slice(0, 200),
              plain: text.slice(0, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            // 表情频率控制用：记下"真发过"的时间与最近发过的 id。
            // 注意与 stickerNudgeTimes（"要求过"的次数）是两笔账——
            // 掷中但模型选择"跳过"时，不该算进"发过"，否则下次会被间隔误挡。
            st.lastStickerAt = now;
            st.recentStickers = [...(Array.isArray(st.recentStickers) ? st.recentStickers : []),
              String(sent.entry?.md5 || sent.entry?.id || stickerId)].slice(-10);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectStickerV2(key, messageRef, remark);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 按需抓网页 / 找图 / 把图片存成 QQ 收藏表情 ────────────────────
        // 模型侧工具：qq_crawl_web。所有抓取走 safe-fetch（禁内网、逐跳校验重定向），
        // 不绕过登录/验证码；图片入库用 SnowLuma 的 add_custom_face。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/crawl') {
          const ccfg = { ...(cfg.socialV2?.crawl ?? {}) };
          if (ccfg.enabled === false) { sendJson({ ok: false, error: '爬虫功能已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('crawl')) { sendJson({ ok: false, error: '工具未启用：qq_crawl_web' }, 403); return; }
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }

          const st = getSocialV2State(key);
          const now = Date.now();
          const maxPerHour = Math.max(0, Number(ccfg.maxPerHour) || 0);
          const crawlTimes = (Array.isArray(st.crawlTimes) ? st.crawlTimes : []).filter((t) => now - Number(t) < 3600000);
          if (maxPerHour > 0 && crawlTimes.length >= maxPerHour) {
            sendJson({ ok: false, error: `爬取太频繁了：每小时最多 ${maxPerHour} 次` }, 429);
            return;
          }
          st.crawlTimes = [...crawlTimes, now].slice(-200);
          saveSocialV2State();

          const mode = ['text', 'images', 'stickers'].includes(String(body.mode))
            ? String(body.mode)
            : (body.saveStickers === true ? 'stickers' : 'auto');
          const saveStickers = body.saveStickers === true || mode === 'stickers';
          const dryRun = body.dryRun === true;
          const maxStickersPerCall = Math.max(1, Math.min(5, Number(ccfg.maxStickersPerCall) || 3));
          const maxImages = Math.max(1, Math.min(30, Number(ccfg.maxImages) || 10));
          const limit = Math.max(1, Math.min(saveStickers ? maxStickersPerCall : maxImages, Number(body.limit) || (saveStickers ? maxStickersPerCall : maxImages)));
          const query = String(body.query ?? '').trim();
          const category = String(body.category ?? '').trim();
          const targetUrl = String(body.url ?? '').trim();

          try {
            let result;
            if (!targetUrl || isAigengtuUrl(targetUrl)) {
              result = await crawlAigengtu({ query, category, limit });
            } else {
              result = await crawlUrl(targetUrl, { query, limit, maxText: 4000 });
            }

            if (!saveStickers) {
              const blocked = !!result.needsLogin;
              sendJson({
                ok: !blocked,
                kind: result.kind,
                url: result.url,
                title: result.title,
                text: result.text,
                images: (result.images || []).slice(0, limit),
                needsLogin: blocked,
                error: blocked ? '页面需要登录/验证或已经失效，无法读取内容' : undefined,
                note: blocked
                  ? '不要编造内容；如实告诉群友这个链接打不开（需要登录/验证或已失效）。'
                  : (mode === 'images' ? '只返回了图片地址；需要变成 QQ 收藏表情时用 mode=stickers。' : '')
              });
              return;
            }

            if (cfg.socialV2?.sticker?.enabled === false) {
              sendJson({ ok: false, error: '表情包体系已关闭，不能存表情' }, 403);
              return;
            }
            const candidates = (result.images || []).slice(0, limit);
            if (!candidates.length) {
              sendJson({ ok: false, error: '没有找到可用图片', needsLogin: !!result.needsLogin }, 404);
              return;
            }

            const maxPerDay = Math.max(0, Number(ccfg.stickerMaxPerDay) || 0);
            const addTimes = (Array.isArray(st.stickerAddTimes) ? st.stickerAddTimes : []).filter((t) => now - Number(t) < 86400000);
            if (maxPerDay > 0 && addTimes.length >= maxPerDay) {
              sendJson({ ok: false, error: `今天存的表情太多了：每天最多 ${maxPerDay} 张` }, 429);
              return;
            }

            const synced = await syncStickerLibrary(false);
            const existingMd5 = new Set(
              (synced?.entries ?? stickerEntries ?? [])
                .map((e) => String(e?.md5 || '').trim().toLowerCase())
                .filter(Boolean)
            );
            const cacheDir = path.join(STATE_DIR, 'sticker-cache');
            const referer = result.kind === 'aigengtu' ? 'https://aigengtu.com/' : (result.url || targetUrl || '');
            const maxBytes = Math.max(256 * 1024, Number(ccfg.maxBytes) || 5 * 1024 * 1024);
            const added = [];
            const skipped = [];
            const errors = [];

            for (const c of candidates) {
              let tmp = null;
              try {
                tmp = await saveStickerImage(c.url, { dir: cacheDir, maxBytes, headers: referer ? { referer } : {} });
                if (existingMd5.has(String(tmp.md5).toLowerCase())) {
                  skipped.push({ url: c.url, md5: tmp.md5, name: c.name, reason: '已经收藏过' });
                  continue;
                }
                if (dryRun) {
                  added.push({ url: c.url, md5: tmp.md5, ext: tmp.ext, bytes: tmp.bytes, name: c.name, dryRun: true });
                  continue;
                }
                const resp = await bot.request('add_custom_face', { file: tmp.path });
                if (!resp || resp.status !== 'ok' || resp.retcode !== 0) {
                  throw new Error(resp?.wording || resp?.message || `add_custom_face retcode=${resp?.retcode}`);
                }
                const emojiId = String(resp.data?.emoji_id || '');
                if (!emojiId) throw new Error('add_custom_face 没返回 emoji_id');
                if (c.name) {
                  try {
                    await bot.request('modify_custom_face', { emoji_id: emojiId, desc: String(c.name).slice(0, 20) });
                  } catch { /* 备注失败不影响已入库 */ }
                }
                existingMd5.add(String(tmp.md5).toLowerCase());
                st.stickerAddTimes = [...(Array.isArray(st.stickerAddTimes) ? st.stickerAddTimes : []).filter((t) => now - Number(t) < 86400000), Date.now()].slice(-200);
                added.push({ url: c.url, md5: tmp.md5, ext: tmp.ext, bytes: tmp.bytes, name: c.name, emojiId });
              } catch (error) {
                errors.push({ url: c.url, name: c.name, error: String(error?.message ?? error) });
              } finally {
                if (tmp?.path) { try { fs.rmSync(tmp.path, { force: true }); } catch { /* 忽略 */ } }
              }
            }

            if (added.length && !dryRun) {
              try { await syncStickerLibrary(true); } catch { /* 同步失败不影响已入库 */ }
            }
            saveSocialV2State();
            log(`[crawl] ${key} ${dryRun ? '试运行' : '存表情'}：新增 ${added.length}，跳过 ${skipped.length}，失败 ${errors.length}`);
            appendActivity(`${key} [crawl] ${dryRun ? '试运行' : '存表情'}：${added.map((x) => x.name || x.emojiId).join('、').slice(0, 60) || '无新增'}`);
            sendJson({
              ok: added.length > 0 || skipped.length > 0,
              kind: 'stickers',
              dryRun,
              added,
              skipped,
              errors,
              text: result.text || '',
              needsLogin: !!result.needsLogin,
              note: dryRun ? '试运行：只下载和校验，没有写入 QQ 收藏表情。' : ''
            });
          } catch (error) {
            log(`[crawl] ${key} 抓取失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `抓取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          let force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - lastForcedAgentStickerSync < 10000) force = false;
            else lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? stickerEntries.length, syncedAt: synced?.syncedAt ?? stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          sendJson({ ok: true, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
          if (socialV2.paused) {
            const st = getSocialV2State(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], unreadCount: st.unread.length });
            return;
          }
          const waitCfg = cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const waitTurnMaxCount = Math.max(1, Math.min(20, Math.round(Number(waitCfg.turnMaxCount) || WAIT_TURN_MAX_COUNT)));
          const waitTurnMaxMs = Math.max(5000, Math.min(600000, Math.round(Number(waitCfg.turnMaxMs) || WAIT_TURN_MAX_MS)));
          const st = getSocialV2State(key);
          const sendWaitWrapUp = (why) => {
            log(`[reserved2] wait 强制收尾 ${key}（${why}），要求模型立即结束回合`);
            sendJson({
              ok: true,
              key,
              arrived: false,
              quiet: true,
              quietMs: 0,
              suggestedQuietMs: 0,
              speakerLikelyDone: true,
              lastMessageUnfinished: false,
              timeout: true,
              waitedMs: 0,
              preSleepWaitSatisfied: false,
              preSleepWaitObserved: false,
              preSleepWaitMs: 0,
              preSleepWaitRemainingMs: 0,
              newMessages: [],
              unreadCount: st.unread.length,
              forceWrapUp: true,
              wrapUpHint: `${FORCE_WRAPUP_HINT}（触发原因：${why}）`
            });
          };
          // ── 单回合硬上限（优先于滑动窗口）──────────────────────────────
          // 旧版只有 12 分钟/8 次的跨回合窗口：单回合 6 次、跨度 24 分钟，早期记录
          // 过期后窗口永远凑不满 8 次。这里按 DSH turn 计时，最多 2 次/120s。
          let waitTurnStat = null;
          {
            const sid = state.sessions[key];
            const turnStart = sid ? (Number(v2TurnStartAt.get(sid)) || 0) : 0;
            if (sid && turnStart) {
              let stat = waitTurnTotals.get(sid);
              if (!stat || stat.turnStart !== turnStart) {
                stat = { turnStart, count: 0, totalMs: 0 };
                waitTurnTotals.set(sid, stat);
              }
              if (stat.count >= waitTurnMaxCount || stat.totalMs >= waitTurnMaxMs) {
                const why = stat.totalMs >= waitTurnMaxMs
                  ? `本回合等待累计 ${Math.round(stat.totalMs / 1000)}s`
                  : `本回合已等待 ${stat.count} 次`;
                waitTurnTotals.delete(sid);
                sendWaitWrapUp(why);
                return;
              }
              stat.count += 1;
              waitTurnStat = stat;
            }
            // 有界清理：避免长进程里 Map 无限增长
            if (waitTurnTotals.size > 200) {
              const nowTs = Date.now();
              for (const [sid2, stat2] of waitTurnTotals) {
                if (!stat2 || nowTs - Number(stat2.turnStart) > 30 * 60 * 1000) waitTurnTotals.delete(sid2);
              }
            }
          }
          // ── 值班循环硬上限（跨回合滑动窗口）───────────────────────────
          // 起初按「单回合内 wait 次数」计数，但活跃群里的循环形态是
          // 「唤醒→wait 60s→收尾结束回合→又被新消息唤醒→再 wait …」，
          // 每个回合都正常 completed，单回合计数每回合重置，永远到不了上限——
          // 表现为群里有人不停催（speak/戳），机器人却一直在「观察→收尾」，消息全排队。
          // 因此改为滑动窗口：不管跨多少个回合，只要「最近 WINDOW 内 wait 满 MAX 次」
          // 就强制收尾，让模型立即结束回合（配 wakeConfig 的潜水设置去过一会儿再看）。
          {
            const nowTs = Date.now();
            const hist = (waitTurnStats.get(key) ?? []).filter((t) => nowTs - t < WAIT_WINDOW_MS);
            hist.push(nowTs);
            waitTurnStats.set(key, hist);
            // 顺带清理过期条目，防止 Map 无限增长
            if (waitTurnStats.size > 200) {
              for (const [k, arr] of waitTurnStats) {
                if (!arr.some((t) => nowTs - t < WAIT_WINDOW_MS)) waitTurnStats.delete(k);
              }
            }
            if (hist.length > WAIT_WINDOW_MAX) {
              const why = `最近 ${Math.round(WAIT_WINDOW_MS / 60000)} 分钟内已等待 ${hist.length - 1} 次`;
              // 重置窗口：给下一轮一个干净起点，避免刚结束就再次触发
              waitTurnStats.set(key, []);
              sendWaitWrapUp(why);
              return;
            }
          }
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          if (activeWaits.has(key)) {
            sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
            return;
          }
          activeWaits.add(key);
          // 占位标记必须用 finally 兜底释放：曾只挂在 req 'close' + 正常返回路径上，
          // 一旦等待循环中途抛异常（消息处理/状态读写出错），标记就永久残留——
          // 之后该会话所有 qq_wait_for_messages 都返回 429「已有一个等待中」，
          // 模型反复重试全失败，表现为「机器人不理人」（实测私聊遇到）。
          // keep-alive 连接下 req 'close' 也可能迟迟不触发，不能只依赖它。
          let finishWait = () => activeWaits.delete(key);
          req.on('close', () => finishWait());
          try {
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // quietMs 单独封顶（默认 15s），不能拿 wait.maxMs 当静默上限——
          // 旧实现让 timeout=120s + quietMs=75s 实际跑出 245s 的单次等待。
          const configuredQuietCap = Number.isFinite(Number(waitCfg.maxQuietMs))
            ? Math.max(0, Number(waitCfg.maxQuietMs))
            : WAIT_QUIET_CAP_MS;
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(WAIT_QUIET_CAP_MS, configuredQuietCap || WAIT_QUIET_CAP_MS));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          const baseline = st.lastUnreadSeq || 0;
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          req.on('close', () => { aborted = true; });
          // 绝对截止：timeout + 一次 quiet 窗口（+1s 余量）。
          // 旧实现允许 timeout + maxQuietMs + 5s，且每次新消息都重置 lastNewAt，
          // 活跃群里单次 wait 可无限逼近 245s。
          const waitDeadline = start + timeoutMs + quietMs + 1000;
          while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 但总时长绝不超过 waitDeadline，防止活跃群把 handler 无限挂起。
              while (Date.now() - lastNewAt < quietMs && Date.now() < waitDeadline && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (waitTurnStat) waitTurnStat.totalMs += waitedMs;
          const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          const preSleepRemainingMs = preSleepWaitBlockedV2(st, key)
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          const quiet = arrived && quietMs > 0 && (Date.now() - lastNewAt >= quietMs);
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs);
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          saveSocialV2State();
          const newMessages = arrived ? (Array.isArray(st.recentMessages) ? st.recentMessages : []).filter((m) => m && !m.isSelf && (m.seq || 0) > baseline) : [];
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1] : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            arrived,
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            lastMessageUnfinished,
            timeout: !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !!st.preSleepWaitObservedAt,
            preSleepWaitMs,
            preSleepWaitRemainingMs: preSleepRemainingMs,
            newMessages,
            unreadCount: st.unread.length
          });
          } catch (error) {
            // 等待途中异常：释放占位标记后再回错，避免该会话永久无法再 wait
            log(`qq_wait_for_messages 异常 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `等待消息失败：${error?.message ?? error}` }, 500);
          } finally {
            finishWait();
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!v2ToolEnabled(flag)) {
            sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
          log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        // 自检：在**运行中的桥接进程里**真实跑一次报错通知，验证「群里零消息 + 管理员收到私聊」。
        // 用控制台令牌鉴权（不是 agent 令牌），只发私聊给 owner，不会打扰任何群。
        // 排障用法：curl -H "x-console-token: <token>" "http://127.0.0.1:3100/api/socialV2/error-notify-selftest?key=group:123"
        if (req.method === 'POST' && url.pathname === '/api/socialV2/error-notify-selftest') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim() || 'group:0';
          const title = String(body.title ?? '自检报错（可忽略）');
          const detail = String(body.detail ?? '这是一条由控制台触发的自检通知，用于确认「报错只私聊管理员、不进群」的通道正常。');
          const en = cfg.socialV2?.errorNotice ?? {};
          const base = cfg.errorNotify ?? {};
          const ownerQQ = String(cfg.ownerQQ ?? '').trim();
          if (!ownerQQ) { sendJson({ ok: false, error: 'config.ownerQQ 为空，无法通知管理员' }, 400); return; }
          if (en.notifyOwner === false || base.notifyOwner === false) {
            sendJson({ ok: false, error: '管理员报错通知当前被关闭（socialV2.errorNotice.notifyOwner / errorNotify.notifyOwner）' }, 400);
            return;
          }
          notifyOwnerOfError(key, title, detail, { 来源: '控制台自检' });
          sendJson({
            ok: true,
            key,
            sentTo: `private:${ownerQQ}`,
            groupMessagesSent: 0,
            config: { inGroup: en.inGroup === true, notifyOwner: true, windowMs: Number(base.windowMs) || 0 }
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
          sendJson({ ok: true, entries: readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          atomicWriteJson(FEEDBACK_FILE, []);
          log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
          const message = rawMessage.slice(0, maxLength);
          appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
            log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('getForwardMsg')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const data = await bot.raw('get_forward_msg', { id });
            const formatted = formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await bot.raw('get_forward_msg', { id: fid });
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
          if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
          const st = getSocialV2State(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          sendJson({ ok: true, key, members });
          return;
        }
        // ── B 站：观看记录与记忆（全局，跨群共用）────────────────────────────
        //
        // 为什么是全局而不是挂 key：现有 activeTopic/memberImpression 是**群聊上下文**，
        // 本就该按群隔离；而"我喜欢看什么视频"是机器人自己的偏好，与群无关。
        // 在 A 群看过的视频，B 群聊到时也该记得（2026-10-19 用户选定）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-record') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!biliMem) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          // bvid 解析：**优先用"最近看完的那条"**，而不是信模型传的值。
          //
          // 为什么（2026-10-19 实测）：模型记不住 10 位随机 bvid，会**瞎编一个**——
          // 日志里 12:47:12 缓存的是 BV14cnn6REvX，12:47:39 它记录时传的是 BV1qh411c7mR，
          // 于是缓存查不到、记忆里存成两条不同的视频、简介也丢了。
          // 模型只该负责"喜不喜欢"，标识由桥接给。
          let bvid = String(body.bvid ?? '').trim();
          const recent = lastBiliWatch?.ok ? String(lastBiliWatch.bvid || '').trim() : '';
          if (recent && bvid !== recent) {
            log(`[B站] 模型传的 bvid=${bvid || '(空)'} 与刚看完的 ${recent} 不符，改用后者`);
            bvid = recent;
          }
          if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
            sendJson({ ok: false, error: '没有可记录的 bvid（最近没有看完的视频）' }, 400);
            return;
          }
          // 用缓存补全元信息（简介、标题等模型看不到的字段）
          const cached = biliInfoCache.get(bvid);
          if (cached) {
            body.desc = body.desc || cached.desc;
            body.title = body.title || cached.title;
            body.owner = body.owner || cached.owner;
            body.category = body.category || cached.category;
            body.durationSec = body.durationSec || cached.durationSec;
            body.biliTags = cached.biliTags || undefined;
          } else {
            log(`[B站] 记录 ${bvid}: 元信息缓存未命中（可能重启过），标题/简介可能缺失`);
          }
        const rec = biliMem.record({
            bvid,
            title: body.title,
            owner: body.owner,
            category: body.category,
            durationSec: body.durationSec,
            // 简介：模型不必自己传，桥接在"自己刷"时会带；工具调用没传就沿用已有的
            desc: body.desc,
            // B 站给的原生标签（简介为空时的主要线索），与模型自己打的 tags 分开存
            biliTags: Array.isArray(body.biliTags) ? body.biliTags : undefined,
            // 字幕片段：桥接看过时缓存，模型不必自己传（它记不住上千字原话）
            subtitle: body.subtitle || undefined,
            tags: Array.isArray(body.tags) ? body.tags : undefined,
            liked: body.liked === true ? true : (body.liked === false ? false : null),
            interest: body.interest,
            watchedFrames: body.watchedFrames,
            watchedSeconds: body.watchedSeconds,
            source: body.source,
            notes: body.notes
          });
          log(`[B站] 记录 ${bvid} liked=${rec?.liked} interest=${rec?.interest} tags=${(rec?.tags || []).join('/')}`);
          sendJson({ ok: true, video: rec, taste: biliMem.taste(5), stats: biliMem.stats() });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/bili-memory') {
          if (!biliMem) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const token = String(req.headers['x-agent-token'] ?? '').trim();
          if (token && key && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          const likedOnly = url.searchParams.get('liked') === '1';
          const query = String(url.searchParams.get('q') ?? '').trim();
          let list = biliMem.recent(limit, { likedOnly });
          if (query) {
            const q = query.toLowerCase();
            list = list.filter((v) =>
              String(v.title).toLowerCase().includes(q)
              || String(v.owner).toLowerCase().includes(q)
              || (v.tags || []).some((t) => String(t).toLowerCase().includes(q)));
          }
          sendJson({ ok: true, videos: list, taste: biliMem.taste(), stats: biliMem.stats() });
          return;
        }
        // ── 现场搜索（模型工具 qq_bili_search 用它）──────────────────────────
        //
        // 需求（2026-10-19 用户反馈「为什么没有新增的视频，都是之前说过了的」）：
        // 群友问"推荐点视频"时，模型原来只能翻记忆里的旧视频（因为只有查询工具、
        // 没有搜索工具），还会临时编没有链接的内容。这个端点补上"实时搜索"。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-search') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!cfg.socialV2?.bili?.enabled) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          const query = String(body.query ?? '').trim().slice(0, 60);
          if (!query) { sendJson({ ok: false, error: 'query 不能为空' }, 400); return; }
          try {
            const count = Math.min(20, Math.max(1, Number(body.count) || 8));
            const order = ['totalrank', 'pubdate', 'click'].includes(body.order) ? body.order : 'totalrank';
            const videos = await searchVideos(query, biliAuth, { count, order });
            // 过滤掉已经看过/记录过的（推荐"新的"才有意义）
            const fresh = videos.filter((v) => !biliMem?.get(v.bvid));
            sendJson({
              ok: true,
              query,
              engineNote: biliAuth.loaded && biliAuth.hasSessdata ? '登录态搜索' : '匿名搜索',
              videos: fresh.length ? fresh : videos,
              // 若过滤后为空说明全都看过，明确告知（模型据此换关键词）
              allSeen: fresh.length === 0 && videos.length > 0
            });
          } catch (error) {
            log(`[B站] 搜索失败 ${query}：${error?.message ?? error}`);
            sendJson({ ok: false, error: `搜索失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 手动看一条（群友发链接时也可以走这里；模型工具 qq_watch_bili 用它）
        if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-watch') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!cfg.socialV2?.bili?.enabled) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (token && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          try {
            // 支持 b23.tv 短链：群友分享卡片给的常是短链
            const id = await resolveBiliId(String(body.url ?? body.bvid ?? ''));
            if (!id) { sendJson({ ok: false, error: '识别不出 B 站视频（支持 BV号 / 完整链接 / b23.tv 短链）' }, 400); return; }
            const info = id.bvid ? await fetchVideoInfo(id.bvid) : await fetchVideoInfo({ aid: id.aid });
            const wc = cfg.socialV2?.bili?.watchShared ?? {};
            const depth = {
              seconds: Math.max(1, Number(body.seconds) || Number(wc.seconds) || 10),
              frames: Math.max(1, Number(body.frames) || Number(wc.frames) || 12)
            };
            const w = await watchVideo(info.bvid, {
              ...depth,
              info,
              // 群友发的视频同样需要"听见"：字幕拿不到时走 ASR
              asr: asrEngine,
              asrEnabled: !!asrEngine,
              asrTimeoutMs: 120000
            });
            if (!w.ok) { sendJson({ ok: false, error: w.error || '观看失败' }, 500); return; }
            rememberBiliInfo(w.info, w.grid);
            // 群友发的链接**不计入**每日"自己刷"额度（那是应要求观看，用户明确区分）
            // 分页拼图：帧多时会被切成多张图，按时间顺序全部返回（模型能一次收多张）
            const sheets = Array.isArray(w.grid.sheets) && w.grid.sheets.length
              ? w.grid.sheets
              : [{ buffer: w.grid.buffer, mimeType: w.grid.mimeType || 'image/png' }];
            sendJson({
              ok: true,
              info: w.info,
              hint: w.hint,
              grid: sheets[0].buffer.toString('base64'),
              mimeType: sheets[0].mimeType || 'image/png',
              images: sheets.map((s) => ({
                data: s.buffer.toString('base64'),
                mimeType: s.mimeType || 'image/png'
              }))
            });
          } catch (error) {
            log(`[B站] 观看失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `观看失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 暂停 / 恢复「自主刷」（控制台按钮）──────────────────────────────
        //
        // 语义：只停"它自己想看视频"这件事，**不影响**群友发链接时的 qq_watch_bili
        //（那条路走 /bili-watch，只检查 b.enabled）。
        //
        // 为什么直接复用 `selfBrowsing.enabled` 而不是新开一个 paused 字段：
        //   这个字段本来就是"自主刷开关"，`scheduleBiliBrowse` / `runBiliBrowse` 都已检查它。
        //   再开一个 paused 会变成两个真相源——配置里写 enabled:false 而 paused:false 时
        //   到底算不算暂停？迟早对不上。
        //
        // 必须落盘：只改内存的话重启就自己恢复刷视频了，用户会以为按钮没生效。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-pause') {
          const body = await readBody();
          const paused = body.paused === true;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置损坏时绝不回写，否则可能把整个 config 清成只剩 bili 段
          const file = readJsonSafe(configFile, null, true);
          file.socialV2 = file.socialV2 ?? {};
          file.socialV2.bili = file.socialV2.bili ?? {};
          file.socialV2.bili.selfBrowsing = file.socialV2.bili.selfBrowsing ?? {};
          file.socialV2.bili.selfBrowsing.enabled = !paused;
          try {
            atomicWriteJson(configFile, file);
          } catch (error) {
            // 写盘失败不改内存：否则进程内看似生效、重启即丢，症状比报错更迷惑
            log(`[B站] 暂停状态写入失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `配置写入失败：${error?.message ?? error}` }, 500);
            return;
          }
          // 同步内存（cfg.socialV2 是启动时读进来的副本）
          cfg.socialV2 = cfg.socialV2 ?? {};
          cfg.socialV2.bili = cfg.socialV2.bili ?? {};
          cfg.socialV2.bili.selfBrowsing = cfg.socialV2.bili.selfBrowsing ?? {};
          cfg.socialV2.bili.selfBrowsing.enabled = !paused;

          if (paused) {
            // 清掉已排的定时器：否则"暂停"后它还会按原计划再刷一次
            if (biliTimer) { clearTimeout(biliTimer); biliTimer = null; }
            biliScheduledAt = 0;
            biliNextDelay = 0;
            log(`[B站] 自主刷已暂停${biliBrowsing ? '（当前这一条会看完，之后不再排期）' : ''}`);
          } else {
            log('[B站] 自主刷已恢复');
            scheduleBiliBrowse();
          }
          sendJson({
            ok: true,
            paused,
            // 附带实时状态，前端不必再请求一次
            selfBrowsingEnabled: !paused,
            browsing: biliBrowsing
              ? { active: true, phase: biliBrowseState.phase || 'starting' }
              : { active: false }
          });
          return;
        }

        // 「自己刷」状态：剩余额度、上次时间
        // ── 手动触发一次"自己刷"（控制台按钮 / 调试用）──────────────────────
        // 与自动刷的区别只有两点：跳过"距上次太近"的间隔限制、**等结果再回响应**
        // （自动刷是 fire-and-forget，手动点按钮需要知道"到底刷没刷、刷了什么"）。
        //
        // 为什么必须等结果（2026-10-19 踩的坑）：先前这里先 `sendJson({ok:true})` 再把
        // runBiliBrowse 当异步任务跑，两个问题——
        //   ① 用户在控制台只看到"已触发"，实际被间隔限制拦掉，什么都没发生；
        //   ② promise 的 then 里又调 sendJson，导致 "Cannot write headers after they are sent"。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-browse-now') {
          if (!biliMem) { sendJson({ ok: false, error: 'B 站功能未启用' }, 400); return; }
          if (biliBrowsing) { sendJson({ ok: false, error: '正在刷，等这次结束' }, 409); return; }
          if (biliTimer) { clearTimeout(biliTimer); biliTimer = null; }
          try {
            const r = await runBiliBrowse({ manual: true });
            sendJson(r);
          } catch (e) {
            log(`[B站] 手动刷失败：${e?.message ?? e}`);
            sendJson({ ok: false, error: String(e?.message ?? e) }, 500);
          }
          return;
        }

        // 加好友/入群邀请的待决列表（控制台可见；也方便管理员在外网侧查）
        if (req.method === 'GET' && url.pathname === '/api/socialV2/join-requests') {
          const jr = cfg.socialV2?.joinRequest ?? {};
          sendJson({
            ok: true,
            enabled: jr.enabled !== false,
            autoApprove: jr.autoApprove === true,
            ttlMs: joinQueue.ttlMs,
            ownerConfigured: !!String(cfg.ownerQQ ?? '').trim(),
            pending: joinQueue.list().map((it) => ({
              n: it.n,
              requestType: it.requestType,
              subType: it.subType,
              userId: it.userId,
              nickname: it.nickname || '',
              groupId: it.groupId,
              groupName: it.groupName || '',
              comment: it.comment || '',
              at: it.at,
              remainMs: Math.max(0, joinQueue.ttlMs - (Date.now() - Number(it.at || 0)))
            }))
          });
          return;
        }

        // 控制台试听：合成一句并**以音频返回**（不发群）。
        // 与 /tts-status 分开：这个是 POST + 可能耗时数秒，不该被轮询碰到。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tts-say') {
          if (!ttsEngine || !ttsEngine.available()) {
            sendJson({ ok: false, error: '语音合成未启用或不可用（见控制台 17b 卡片）' }, 400);
            return;
          }
          const body = await readBody();
          const text = String(body.text ?? '').trim() || '你好呀，我是达妮娅。';
          try {
            // refId/mood 可选：控制台试听时可以把当前选定的情绪参考也带上
            const r = await ttsEngine.speak(text.slice(0, 200), {
              refId: body.refId,
              mood: body.mood,
              params: ttsSpeechParams()
            });
            if (!r.ok) { sendJson({ ok: false, error: r.error }, 500); return; }
            const buf = fs.readFileSync(r.file);
            res.writeHead(200, {
              ...SECURITY_HEADERS,
              'content-type': 'audio/wav',
              'content-length': String(buf.length),
              'cache-control': 'no-store',
              // 诊断用：这次实际用了哪条参考（同源 fetch 可直接读，不需要 CORS）
              'x-tts-ref': String(r.refId || ''),
              'x-tts-mood': String(r.refMood || '')
            });
            res.end(buf);
          } catch (error) {
            sendJson({ ok: false, error: `合成失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 控制台「选择文件/文件夹」：在**运行桥接的这台电脑**上弹原生对话框。
        //
        // 为什么不在页面里用 <input type=file>：浏览器出于安全限制不会把选中文件的
        // 绝对路径交给 JS，而 TTS 引擎要的正是本机绝对路径（权重/引擎目录）。
        // 所以由桥接起一个 PowerShell（-STA 才能弹 WinForms 对话框），选完把路径
        // 写到临时文件（UTF-8 无 BOM），Node 再读回——避免中文路径经过管道被按
        // GBK 解码（这个坑在 TTS 试听上已经踩过一次）。
        // 脚本是固定文本，只通过环境变量传模式/标题，不接受任何拼接执行的内容。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tts/pick-path') {
          const body = await readBody();
          const kind = body.kind === 'dir' ? 'dir' : 'file';
          if (process.platform !== 'win32') {
            sendJson({ ok: false, error: '原生文件选择目前只支持 Windows' }, 400);
            return;
          }
          if (pickPathBusy) {
            sendJson({ ok: false, error: '已经有一个选择窗口打开了，请先处理它' }, 429);
            return;
          }
          pickPathBusy = true;
          const outFile = path.join(STATE_DIR, `pick-path-${process.pid}-${Date.now()}.txt`);
          const script = [
            'Add-Type -AssemblyName System.Windows.Forms',
            'Add-Type -AssemblyName System.Drawing',
            '$owner = New-Object System.Windows.Forms.Form',
            '$owner.TopMost = $true',
            '$owner.ShowInTaskbar = $false',
            '$owner.FormBorderStyle = "None"',
            '$owner.StartPosition = "CenterScreen"',
            '$owner.Size = New-Object System.Drawing.Size(1,1)',
            '$owner.Opacity = 0',
            '$owner.Show()',
            'try {',
            '  if ($env:QQB_PICK_KIND -eq "dir") {',
            '    $d = New-Object System.Windows.Forms.FolderBrowserDialog',
            '    $d.Description = $env:QQB_PICK_TITLE',
            '    $d.ShowNewFolderButton = $false',
            '    if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
            '      [System.IO.File]::WriteAllText($env:QQB_PICK_OUT, $d.SelectedPath, (New-Object System.Text.UTF8Encoding($false)))',
            '    }',
            '  } else {',
            '    $f = New-Object System.Windows.Forms.OpenFileDialog',
            '    $f.Title = $env:QQB_PICK_TITLE',
            '    $f.Filter = "权重文件 (*.ckpt;*.pth;*.pt;*.safetensors)|*.ckpt;*.pth;*.pt;*.safetensors|所有文件 (*.*)|*.*"',
            '    $f.CheckFileExists = $true',
            '    if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
            '      [System.IO.File]::WriteAllText($env:QQB_PICK_OUT, $f.FileName, (New-Object System.Text.UTF8Encoding($false)))',
            '    }',
            '  }',
            '} finally { $owner.Close() }'
          ].join('\r\n');
          try {
            const { execFile } = await import('node:child_process');
            await new Promise((resolve, reject) => {
              execFile('powershell.exe',
                ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script],
                {
                  timeout: 120000,
                  windowsHide: true,
                  maxBuffer: 1024 * 1024,
                  env: {
                    ...process.env,
                    QQB_PICK_KIND: kind,
                    QQB_PICK_TITLE: kind === 'dir' ? '选择 GPT-SoVITS 引擎目录' : '选择模型权重文件',
                    QQB_PICK_OUT: outFile
                  }
                },
                (error) => (error ? reject(error) : resolve())
              );
            });
            let picked = '';
            try {
              picked = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim();
            } catch { /* 用户取消：没有输出文件 */ }
            sendJson({ ok: true, path: picked, cancelled: !picked });
          } catch (error) {
            const msg = error?.killed ? '等待选择超时（120 秒）' : (error?.message ?? String(error));
            log(`[TTS] 原生路径选择失败：${msg}`);
            sendJson({ ok: false, error: `打开文件选择框失败：${msg}` }, 500);
          } finally {
            pickPathBusy = false;
            try { fs.unlinkSync(outFile); } catch { /* 没生成就忽略 */ }
          }
          return;
        }

        // ── 缓存盘点与清理（2026-10-22 用户要求）──────────────────────────
        //
        // 「注意清理 C 盘缓存，并且控制台中给出对应功能卡片」。
        // GET 只盘点（算体积）；POST 才真删，且只删 kind='safe' 的项
        // （语音模型/图库/观看记忆一律不动，见 cache-manager.js 顶部说明）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/cache') {
          try {
            const items = collectCacheItems({
              root: ROOT,
              ttsDir: cfg.socialV2?.tts?.enabled === true ? (cfg.socialV2.tts.dir || DEFAULT_SOVITS_DIR) : '',
              // 收藏目录可被配置覆盖；不传则用 <项目>/collected
              collectedDir: cfg.socialV2?.images?.archiveDir || ''
            });
            sendJson({ ok: true, items, groups: CACHE_GROUPS, summary: summarizeCache(items) });
          } catch (error) {
            sendJson({ ok: false, error: `盘点失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/cache-purge') {
          const body = await readBody();
          try {
            const items = collectCacheItems({
              root: ROOT,
              ttsDir: cfg.socialV2?.tts?.enabled === true ? (cfg.socialV2.tts.dir || DEFAULT_SOVITS_DIR) : '',
              collectedDir: cfg.socialV2?.images?.archiveDir || ''
            });
            const r = purgeCache(items, {
              keys: Array.isArray(body.keys) ? body.keys.map(String) : [],
              dryRun: body.dryRun === true
            });
            const human = humanBytes(r.freedBytes);
            if (!r.dryRun) {
              log(`[缓存] 清理完成：释放 ${human}（${r.removed} 个文件）`);
              appendActivity(`[缓存] 清理释放 ${human}`);
            }
            sendJson({
              ok: true,
              freedBytes: r.freedBytes,
              freedHuman: human,
              removed: r.removed,
              details: r.details,
              dryRun: r.dryRun
            });
          } catch (error) {
            log(`[缓存] 清理失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: `清理失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 语音合成（TTS）状态：给控制台显示"能不能发语音、什么音色、什么概率"。
        // 与 bili-status 分开成独立端点：TTS 是全局能力，不属于 B 站。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tts-status') {
          const t = cfg.socialV2?.tts ?? {};
          const st = ttsEngine ? ttsEngine.status() : null;
          const probe = ttsEngine ? ttsEngine.probe() : null;
          // 请求级韵律参数：控制台回填/保存用（改完即时生效）
          const speech = ttsSpeechParams();
          sendJson({
            ok: true,
            enabled: t.enabled === true,
            // 可插拔的三种可见状态：未启用 / 已启用但不可用 / 可用
            usable: !!(st && st.available && st.enabled),
            state: st ? st.state : (t.enabled === true ? 'unavailable' : 'disabled'),
            voice: st?.voice || t.voiceName || '达妮娅',
            dir: st?.dir || t.dir || DEFAULT_SOVITS_DIR,
            device: st?.device || t.device || 'cuda',
            // 实际加载的权重/版本：引擎就绪时以引擎回报为准。
            // 之前控制台只显示配置项，出现过「显示爱弥斯、实际跑 dania」的误导。
            gptModel: st?.gptModel || (t.gptModel ? path.basename(String(t.gptModel)) : ''),
            sovitsModel: st?.sovitsModel || (t.sovitsModel ? path.basename(String(t.sovitsModel)) : ''),
            modelVersion: st?.version || '',
            loadSec: st?.loadSec ?? null,
            warmed: st?.warmed ?? null,
            // 只有真正不可用时才回显 error；可用时若还带着"未初始化"这类
            // 初始化期的残留文案，会和"可用"状态自相矛盾（实测 UI 上出现过
            // 「可用」+「原因：未初始化」并列）。
            error: (st && st.available && st.state === 'ready') ? null : (st?.error ?? (t.enabled === true ? '未初始化' : null)),
            retryInSec: st?.retryInMs ? Math.round(st.retryInMs / 1000) : 0,
            probability: Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY))),
            maxPerHour: ttsNum(t.maxPerHour, 3, 0, 60),
            maxChars: ttsNum(t.maxChars, 140, 20, 300),
            refText: probe?.refText ? String(probe.refText).slice(0, 80) : '',
            // ── 音色预设（voices.json）──────────────────────────────────
            // 归档里的音色/权重版本/按情绪分好的参考音频。控制台据此渲染下拉；
            // refs 只回 id/mood/label，不回绝对路径。
            voiceId: st?.voiceId || t.voiceId || '',
            weightsId: st?.weightsId || t.weightsId || '',
            weightsLabel: st?.weightsLabel || '',
            refs: st?.refs || [],
            defaultRefId: st?.defaultRefId || '',
            refMode: st?.refMode || t.refMode || 'auto',
            voices: probe?.voices || [],
            manifestPath: probe?.manifestPath || '',
            manifestError: probe?.manifestError || '',
            // 韵律/响度（请求级，保存即生效）
            speech,
            // ── 可编辑参数（2026-10-22 用户要求「设成可变参数并提供修改按钮」）──
            // 分两类，因为生效时机不同：
            //   ① 即时生效：概率/上限/字数——planTtsV2 与端点每次都现读 cfg；
            //   ② 需重启：dir/模型路径/device/线程——它们在启动时传给引擎并进了闭包。
            // 前端据此把第二类标「需重启」，避免用户改完以为没生效。
            editable: {
              probability: Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY))),
              maxPerHour: ttsNum(t.maxPerHour, 3, 0, 60),
              maxChars: ttsNum(t.maxChars, 140, 20, 300),
              dir: String(t.dir || DEFAULT_SOVITS_DIR),
              gptModel: String(t.gptModel || 'GPT_SoVITS/dania-e15.ckpt'),
              sovitsModel: String(t.sovitsModel || 'GPT_SoVITS/dania_e16_s2192.pth'),
              device: String(t.device || 'cuda'),
              cpuThreads: Math.max(1, Number(t.cpuThreads) || 8),
              voiceName: String(t.voiceName || '达妮娅'),
              voiceId: String(t.voiceId || ''),
              weightsId: String(t.weightsId || ''),
              refMode: String(t.refMode || 'auto'),
              // 韵律/响度：请求级参数，保存后下一次合成即生效
              ...speech
            },
            summary: (() => {
              if (t.enabled !== true) return '未启用：只发文字';
              if (!st || !st.available) return `已启用但不可用：${st?.error || (probe ? '探测失败' : '未初始化')}`;
              if (st.state === 'ready') {
                return `可用（${st.voice}）· ${Math.round(Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY))) * 100)}% 概率发语音`
                  + ` · 每小时最多 ${ttsNum(t.maxPerHour, 3, 0, 60)} 条`;
              }
              if (st.state === 'failed') return `已启用但启动失败：${st.error}（稍后自动重试）`;
              return '已启用，等待首次加载（约 10~25 秒，不阻塞文字）';
            })()
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/bili-status') {
          const b = cfg.socialV2?.bili ?? {};
          const sb = b.selfBrowsing ?? {};
          const today = biliMem ? biliMem.todayUsage() : { seconds: 0, videos: 0 };
          const budget = Math.max(0, Number(sb.dailyBudgetSec) || 0);
          // 控制台要能看到"此刻是不是在刷"以及"刷到哪一步了"。
          // 这些是进程内的瞬时状态，不落盘：重启后自然归零。
          const now = Date.now();
          const browsing = biliBrowsing
            ? {
                active: true,
                phase: biliBrowseState.phase || 'starting',
                since: biliBrowseState.startedAt || now,
                video: biliBrowseState.video || null,
                key: biliBrowseState.key || '',
                elapsedSec: Math.round((now - (biliBrowseState.startedAt || now)) / 1000)
              }
            : { active: false };
          sendJson({
            ok: true,
            enabled: b.enabled !== false,
            selfBrowsing: {
              enabled: sb.enabled !== false,
              // 控制台按钮据此显示"已暂停 / 恢复自主刷"
              paused: sb.enabled === false,
              dailyBudgetSec: budget,
              usedSec: today.seconds,
              remainingSec: Math.max(0, budget - today.seconds),
              videosToday: today.videos,
              lastBrowseAt: lastBiliBrowseAt || 0,
              // 下次自己刷还有多久：以**本次调度的起点** + 随机间隔计算。
              // 用 lastBiliBrowseAt 会算错——那个是"上次真的看了"的时间，
              // 而调度可能在它之后才设定（比如跳过某一轮后重新排期）。
              nextInSec: biliTimer && biliScheduledAt
                ? Math.max(0, Math.round((biliScheduledAt + (biliNextDelay || 0) - now) / 1000))
                : 0,
              // 当前是否在刷（控制台用这个显示"刷视频中…"）
              browsing,
              // 最近一次刷的结果，方便回看"它刚才看了啥"
              lastVideo: lastBiliWatch || null,
              // 分区偏好（让控制台能说明"为什么总刷这类"）
              categoryWeights: sb.categoryWeights || null,
              // 主动搜索：开关、上次搜的关键词、凭据状态（**只报状态，不暴露 cookie**）
              search: {
                enabled: sb.search?.enabled !== false,
                lastKeyword: lastBiliSearchKeyword || '',
                auth: biliAuth.loaded
                  ? { loaded: true, hasLogin: !!biliAuth.hasSessdata }
                  : { loaded: false, reason: biliAuth.reason }
              },
              // 声音内容（听觉）：字幕优先、ASR 兜底（2026-10-21 用户要求）
              audio: (() => {
                const asr = asrEngine ? asrEngine.status() : null;
                const cfgAsr = b.asr ?? {};
                return {
                  // 字幕需要登录态；没登录时 B 站返回空数组（且 code 仍是 0），
                  // 所以这里明确告诉控制台"字幕能不能用"
                  subtitleAvailable: !!biliAuth.hasSessdata,
                  subtitleReason: biliAuth.hasSessdata ? '' : (biliAuth.loaded ? '凭据已加载但无登录态' : '未配置 B 站凭据'),
                  asrEnabled: cfgAsr.enabled !== false,
                  asrConfigured: !!asr,
                  asrState: asr?.state ?? 'disabled',
                  asrModel: asr?.model ?? '',
                  asrModelPath: asr?.modelPath ?? '',
                  asrModelKind: asr?.modelKind ?? '',
                  asrThreads: asr?.cpuThreads ?? null,
                  asrLoadSec: asr?.loadSec ?? null,
                  asrError: asr?.error ?? null,
                  asrRetryInSec: asr?.retryInMs ? Math.round(asr.retryInMs / 1000) : 0,
                  // 一句话结论，控制台直接显示
                  summary: asr?.state === 'ready'
                    ? (biliAuth.hasSessdata
                      ? '字幕优先，字幕缺失时用本地语音识别补'
                      : '未登录 B 站：全部走本地语音识别')
                    : (asr?.state === 'failed'
                      ? `语音识别不可用（${asr.error || '未知原因'}）：只有画面`
                      : (asr ? '语音识别待加载（首次用时自动加载，约 8 秒）'
                        : '未启用语音识别：只有画面'))
                };
              })()
            },
            share: {
              enabled: b.share?.enabled !== false,
              minInterest: b.share?.minInterest,
              probability: b.share?.probability,
              lastShareAt: lastBiliShareAt || 0,
              nextAllowedInSec: lastBiliShareAt
                ? Math.max(0, Math.round((lastBiliShareAt + (Number(b.share?.minGapMs) || 6 * 3600 * 1000) - now) / 1000))
                : 0,
              // 推荐目的地策略（2026-10-21 用户要求「更多推荐给活跃的群聊」）
              preferActiveGroups: b.share?.preferActiveGroups !== false,
              activeWindowHours: Math.max(1, Number(b.share?.activeWindowHours) || 24),
              minActivityForShare: Math.max(0, Number(b.share?.minActivityForShare) || 0),
              // 各群活跃度：控制台据此显示"推荐会落到哪些群"
              groups: [...socialV2.conversations.entries()]
                .filter(([k]) => k.startsWith('group:'))
                .map(([k, st]) => {
                  const hours = Math.max(1, Number(b.share?.activeWindowHours) || 24);
                  const activity = groupActivityScore(st, { hours, now });
                  return {
                    key: k,
                    activity,
                    // 是否够格作为推荐目的地
                    shareEligible: activity >= Math.max(1, Number(b.share?.minActivityForShare) || 1),
                    lastActionAt: Number(st.lastActionAt) || 0
                  };
                })
                .sort((x, y) => y.activity - x.activity)
            },
            memory: biliMem ? biliMem.stats() : null,
            taste: biliMem ? biliMem.taste(5) : null,
            recent: biliMem ? biliMem.recent(6).map((v) => ({
              bvid: v.bvid, title: v.title, owner: v.owner, category: v.category,
              liked: v.liked, interest: v.interest, tags: v.tags, lastSeenAt: v.lastSeenAt, source: v.source,
              desc: String(v.desc || '').slice(0, 120)
            })) : []
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
          const st = getSocialV2State(key);
          appendMemoryV2(st, category, content, extra);
          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const oldTarget = target;
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            const im = st.memberImpressions[oldTarget] || {};
            const newTarget = String(cleanNewExtra.target || oldTarget).trim();
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
          const st = getSocialV2State(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            delete st.memberImpressions[target];
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
          const st = getSocialV2State(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') st.memberImpressions = {};
          saveSocialV2State();
          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
          return;
        }
        // ── 上下文持久化（Phase 0/1）：状态 / 立即总结 / 清空 ────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/context-status') {
          const cm = contextCfg();
          void refreshContextNames().catch(() => {});
          const rows = [];
          for (const [key, st] of socialV2.conversations) {
            if (!/^(group|private):\d+$/.test(key)) continue;
            const stats = contextStats(STATE_DIR, key);
            const m = contextMetrics.get(key) || {};
            const lastEpSeq = Number(stats.lastEpisodeSeq) || 0;
            const pendingMessages = countContextPendingV2(
              key, st, lastEpSeq, Number(stats.lastEpisodeEndAt) || 0
            );
            let longTerm = longTermStats(STATE_DIR, key);
            // Phase 2 迁移：老 episode 在 memory.json 还不存在时补种一次。
            if (stats.episodes > 0 && !longTerm.updatedAt) {
              try { backfillLongTermMemory(STATE_DIR, key); longTerm = longTermStats(STATE_DIR, key); } catch {}
            }
            const journal = journalStats(STATE_DIR, key);
            const sid = state.sessions[key] || '';
            rows.push({
              key,
              displayName: contextDisplayName(key),
              sessionId: sid,
              sessionBytes: sessionFileBytes(sid),
              compactions: stats.compactions,
              lastCompactionAt: stats.lastCompactionAt,
              compactionTokenNotch: stats.lastCompactionNotch,
              episodes: stats.episodes,
              lastEpisodeAt: stats.lastEpisodeAt,
              lastEpisodeSummary: String(stats.lastEpisodeSummary || '').slice(0, 140),
              pendingMessages: Number(pendingMessages) || 0,
              journalBytes: Number(journal.bytes) || 0,
              longTerm,
              memory: {
                topics: Array.isArray(st.activeTopics) ? st.activeTopics.length : 0,
                thoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.length : 0,
                impressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? Object.keys(st.memberImpressions).length : 0
              },
              lastPromptChars: Number(m.lastPromptChars) || 0,
              lastMemoryChars: Number(m.lastMemoryChars) || 0,
              lastEpisodeError: String(m.lastEpisodeError || '')
            });
          }
          rows.sort((a, b) => b.sessionBytes - a.sessionBytes);
          const totals = rows.reduce((acc, r) => ({
            sessionBytes: acc.sessionBytes + r.sessionBytes,
            episodes: acc.episodes + r.episodes,
            compactions: acc.compactions + r.compactions,
            journalBytes: acc.journalBytes + (Number(r.journalBytes) || 0),
            people: acc.people + (Number(r.longTerm?.people) || 0),
            facts: acc.facts + (Number(r.longTerm?.facts) || 0),
            openThreads: acc.openThreads + (Number(r.longTerm?.openThreads) || 0)
          }), { sessionBytes: 0, episodes: 0, compactions: 0, journalBytes: 0, people: 0, facts: 0, openThreads: 0 });
          sendJson({ ok: true, enabled: cm.enabled !== false, rows, totals });
          return;
        }
        // 长期记忆详情（控制台 24 号卡「长期」按钮）
        if (req.method === 'GET' && url.pathname === '/api/socialV2/context-memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 非法' }, 400); return; }
          const stats = contextStats(STATE_DIR, key);
          let memory = loadLongTermMemory(STATE_DIR, key);
          if (stats.episodes > 0 && !memory.updatedAt) {
            try { memory = backfillLongTermMemory(STATE_DIR, key); } catch {}
          }
          sendJson({
            ok: true,
            key,
            stats,
            longTerm: longTermStats(STATE_DIR, key),
            journal: journalStats(STATE_DIR, key),
            memory,
            episodes: loadEpisodes(STATE_DIR, key, 5)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/context-rebuild-memory') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 非法' }, 400); return; }
          try {
            fs.rmSync(path.join(contextDir(STATE_DIR, key), 'memory.json'), { force: true });
            const memory = backfillLongTermMemory(STATE_DIR, key);
            log(`[上下文] 已从 episode 重建长期记忆 ${key}`);
            sendJson({
              ok: true,
              key,
              memory,
              stats: contextStats(STATE_DIR, key),
              longTerm: longTermStats(STATE_DIR, key)
            });
          } catch (error) {
            sendJson({ ok: false, error: `重建失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/context-summarize') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!/^(group|private):\d+$/.test(key) || !socialV2.conversations.has(key)) {
            sendJson({ ok: false, error: '会话不存在' }, 404);
            return;
          }
          const r = await makeEpisodeNow(key, { force: body.force !== false });
          sendJson({ ok: r.ok === true, ...r });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/context-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key !== '*' && !/^(group|private):\d+$/.test(key)) {
            sendJson({ ok: false, error: 'key 非法（用会话 key 或 *）' }, 400);
            return;
          }
          try {
            const clearFiles = (k) => {
              const dir = contextDir(STATE_DIR, k);
              // journals（messages.jsonl）是聊天记录，清空记忆时**保留**；
              // 只删派生的情节/压缩/长期记忆。
              for (const name of ['episodes.jsonl', 'compactions.jsonl', 'memory.json']) {
                try { fs.rmSync(path.join(dir, name), { force: true }); } catch {}
              }
            };
            if (key === '*') {
              for (const k of socialV2.conversations.keys()) clearFiles(k);
            } else {
              clearFiles(key);
            }
            const m = contextMetrics.get(key);
            if (m) {
              delete m.lastEpisodeAt;
              delete m.lastEpisodeSummary;
              delete m.lastEpisodeError;
            }
            log(`[上下文] 已清空 ${key === '*' ? '全部会话' : key} 的情节/压缩/长期记忆（保留消息日志）`);
            sendJson({ ok: true, key });
          } catch (error) {
            sendJson({ ok: false, error: `清空失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
          const list = confirmedSlangListV2().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          sendJson({
            ok: true,
            key,
            total: list.length,
            entries: list,
            block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
          const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
          if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
          if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
          const existing = slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === SLANG_STATUS.CONFIRMED) {
              sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
              return;
            }
            if (existing.status === SLANG_STATUS.REJECTED) {
              sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
              return;
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            saveSlangStore();
            if (cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                queueSlangTask(() => runSlangResearch([existing]));
              }
            }
            log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
            return;
          }
          const entry = createSlangEntry({
            content,
            source: 'ai',
            status: SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          if (cfg.slang?.autoResearch !== false) {
            queueSlangTask(() => runSlangResearch([entry]));
          }
          log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
          appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          sendJson({ ok: true, entry: publicSlangEntry(entry) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (currentMode === 'reserved2' && !agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'reserved2 模式下旧只读工具不可用，请使用带会话令牌的 v2 读工具' }, 403);
            return;
          }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
            return;
          }
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (agentToken && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          if (!agentToken && currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          // 本地缓存优先，未命中则回源取那条消息（群友引用别人的图时本地没有）
          const media = await findMessageMediaAsync(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            // raw=1：跳过缩放/抽帧，返回原图（供 qq_upscale_image 做超分）
            const images = await fetchMediaData(media, { raw: url.searchParams.get('raw') === '1' });
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 超分结果回传（把放大后的图发给群友）─────────────────────────────
        //
        // 需求（2026-10-19）：「超分完没有把超分后的结果发回」——超分图原先只作为
        // image part 交给模型，群友看不到。这个端点把结果真正发到会话里。
        //
        // 安全边界与其它发送端点一致：模式校验 → agent token → 目标在允许范围内 →
        // 发送配额 → 静默模式。图片走 base64 段（不落临时文件，也不接受任意 URL／路径）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-upscaled') {
          // 这里要收一张 base64 图片，申请放宽的请求体上限（白名单路由，见 readBody）。
          const body = await readBody({ route: url.pathname, maxBytes: 8_000_000 });
          const token = String(body.token ?? '').trim();
          const key = String(body.key ?? '').trim();
          const dataB64 = String(body.data ?? '').replace(/\s/g, '');
          const caption = String(body.caption ?? '').trim().slice(0, 200);
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return;
          }
          if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (!key || !/^(group|private):(\d+)$/.test(key)) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (token && !v2ToolEnabled('sendImage')) { sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const [, kind, idStr] = /^(group|private):(\d+)$/.exec(key);
          if (!modeAllowed(key, kind, Number(idStr), cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (!dataB64) { sendJson({ ok: false, error: 'data 不能为空' }, 400); return; }
          // 只接受 base64：拒绝任何 URL／本地路径 —— 那会绕过 SSRF/本地文件防护。
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataB64.slice(0, 64))) { sendJson({ ok: false, error: 'data 必须是 base64 编码的图片' }, 400); return; }
          const buf = Buffer.from(dataB64, 'base64');
          if (!buf.length) { sendJson({ ok: false, error: 'data 解码后为空' }, 400); return; }
          if (buf.length > MAX_MEDIA_BYTES) { sendJson({ ok: false, error: `图片过大（${(buf.length / 1024 / 1024).toFixed(1)}MB），上限 ${(MAX_MEDIA_BYTES / 1024 / 1024) | 0}MB` }, 400); return; }
          // 必须是图片：超分端点只发图，不能变成任意文件发送通道。
          const sniffed = sniffImageMime(buf);
          if (!sniffed) { sendJson({ ok: false, error: 'data 不是可识别的图片格式' }, 400); return; }
          try {
            const st = getSocialV2State(key);
            const gate = imageSendAllowed(key);
            if (!gate.ok) { sendJson({ ok: false, error: gate.error }, 429); return; }
            const sent = await onebotSendImageFile(key, buf, { label: '［超分］' });
            const now = Date.now();
            const times = (imageSendTimes.get(key) ?? []).filter((t) => now - t < 3600000);
            times.push(now);
            imageSendTimes.set(key, times);
            st.lastActionAt = now;
            saveSocialV2State();
            // 说明文字可选：先说图再补一句（分两条发，避免图配长文被截断）
            if (caption) {
              await sendToQQ(key, caption).catch((e) => log(`超分回传附言发送失败 ${key}: ${e?.message ?? e}`));
            }
            log(`[超分] 已回传图片到 ${key}（${(buf.length / 1024).toFixed(0)}KB）`);
            sendJson({ ok: true, key, messageId: sent?.message_id ?? null, bytes: buf.length, mimeType: sniffed });
          } catch (error) {
            log(`超分回传失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const token = String(body.token ?? '').trim();
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = stripLeadingMetaMarker(unquoteJsonString(String(body.message ?? '').trim()));
          const replyToMessageId = isReply ? body.replyToMessageId : body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
          // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return;
          }
          if (socialV2.paused && token) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !isSymbolicReplyRef(replyToMessageId) && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数），或传 latest/上一条 表示引用最近一条别人的消息' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          try {
            const st = getSocialV2State(key);
            const now = Date.now();
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId, { quoted: quotedInfo });
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            // 已回复的那条立即从未读移除：与它对应的请求已经处理完了，
            // 留着只会让本轮/下一轮又把同一条当待办重答一次（实测重复回答 3~4 次）。
            // 只在**真的发出去了**之后才移除，发送失败则保留（下次还能补）。
            if (sentMessages.length > 0 && quotedInfo?.messageId != null) {
              const before = st.unread.length;
              st.unread = st.unread.filter((m) => String(m?.messageId ?? '') !== String(quotedInfo.messageId));
              if (st.unread.length !== before) {
                log(`[send] ${key} 已回复 seq 对应消息，从待回复列表移除 1 条（余 ${st.unread.length}）`);
              }
            }
            if (sentMessages.length > 0 && quotedInfo?.messageId != null) {
              const targetEntry = st.recentMessages.find((m) => m && String(m.messageId) === String(quotedInfo.messageId));
              const targetSeq = Number(quotedInfo.seq) || Number(targetEntry?.seq) || 0;
              if (targetSeq) {
                const set = new Set((Array.isArray(st.answeredSeqs) ? st.answeredSeqs : []).map(Number).filter(Number.isFinite));
                set.add(targetSeq);
                st.answeredSeqs = [...set].slice(-200);
              }
            }
            saveSocialV2State();
            log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/session/reset') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          sessionEpoch++;
          const oldSessionId = state.sessions[key];
          delete state.sessions[key];
          reverse.delete(oldSessionId);
          collectors.delete(oldSessionId);
          sendToolSucceededSessions.delete(oldSessionId);
          pendingSendToolCalls.delete(oldSessionId);
          v2TurnStartAt.delete(oldSessionId);
          toolCallNames.delete(oldSessionId);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          social.silentTurns.delete(oldSessionId);
          social.exitingSessions.delete(oldSessionId);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          const removedV2 = socialV2.conversations.get(key);
          if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          try { await api.workspace.archiveSession({ sessionId: oldSessionId }); } catch {}
          log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已归档）`);
          sendJson({ ok: true, key, archived: oldSessionId });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
          sessionEpoch++;
          let archivedCount = 0;
          try {
            const ws = unwrap(await api.workspace.list({}), 'workspace.list');
            const qq = ws.items.find((w) => w.title === cfg.workspaceTitle);
            if (qq) {
              for (const sid of qq.sessionIds) {
                try { await api.workspace.archiveSession({ sessionId: sid }); archivedCount += 1; } catch {}
              }
              try { await api.workspace.delete({ workspaceId: qq.workspaceId }); } catch {}
            }
          } catch {}
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            cancelPendingEntry(entry).catch(() => {});
          }
          pending.clear();
          queued.clear();
          queuedHintAt.clear();
          sessionPromises.clear();
          drainAllPromptQueues('工作区已清空');
          social.states.clear();
          social.recentMessages.clear();
          messageMediaStore.clear();
          seenForwardIds.clear();
          social.pendingSummaries.clear();
          social.silentContext.clear();
          social.silentTurns.clear();
          social.exitingSessions.clear();
          slangWindows.clear();
          slangExtractionCooldowns.clear();
          slangSubmitTimes.clear();
          cancelAllSocialTimers();
          clearAllSocialV2Timers();
          for (const st of socialV2.conversations.values()) {
            if (st?.agentToken) KNOWN_AGENT_TOKENS.delete(st.agentToken);
          }
          socialV2.conversations.clear();
          saveSocialV2State();
          state.sessions = {};
          reverse.clear();
          collectors.clear();
          sendToolSucceededSessions.clear();
          pendingSendToolCalls.clear();
          v2TurnStartAt.clear();
          toolCallNames.clear();
          saveState();
          try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
          log(`控制台：已清空 QQ 聊天工作区（归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          sendJson({ ok: true, archivedCount });
          return;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          // 重启 = **自己拉一个新进程**，不能只 process.exit 等外部守护窗口。
          //
          // 2026-10-21 用户反馈「控制台的重启桥接按钮并没有重启的效果」。
          // 实测日志：19:52:12 打出"控制台：重启桥接"后 exit(0)，到 19:53:06 才
          // 出现新进程——中间空了 54 秒，而前端只轮询 30 秒就显示"桥接尚未恢复"。
          // 根因不是按钮没发命令，而是**没有任何守护在跑**：`start.bat` 的死循环
          // 只存在于手动双击启动的那个窗口里；用 nohup / 计划任务 / 别的方式拉起时，
          // exit(0) 就是彻底停服。把"能不能起来"交给运气是不对的。
          //
          // 做法：detached 子进程 + stdio 忽略 + unref，父进程退出后子进程继续跑。
          // 子进程等 800ms 再启动（给父进程释放 :3100 和锁文件的时间），
          // 并通过 QQB_RESTARTED_BY 标记来源，便于日志区分"手动启动"与"自重启"。
          // 子进程启动时会 acquireLock()：若父进程还没退干净，它会 exit(2) 自行放弃，
          // 不会出现两个实例同时抢端口。
          const logFile = path.join(STATE_DIR, 'bridge.log');
          sendJson({ ok: true, message: '正在重启桥接（已安排自重启，约 3~5 秒恢复）…' });
          setTimeout(async () => {
            log('控制台：重启桥接（将以 detached 子进程自重启）');
            let spawned = false;
            try {
              const { spawn } = await import('node:child_process');
              const out = fs.openSync(logFile, 'a');
              const child = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
                cwd: ROOT,
                detached: true,
                stdio: ['ignore', out, out],
                windowsHide: true,
                env: { ...process.env, QQB_RESTARTED_BY: 'console' }
              });
              child.unref();
              spawned = true;
            } catch (error) {
              log(`重启失败：无法拉起新进程（${error?.message ?? error}）；若由守护脚本启动，会由它恢复`);
            }
            releaseLock();
            process.exit(spawned ? 0 : 1);
          }, 500);
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  /**
   * 群友对刚发的图给出差评时：删掉那张图（并记入拒绝名单，不再拉回），再发一张新的。
   *
   * 返回 true 表示已识别并接管（调用方**不应**再让模型照常回复这条消息）。
   *
   * 设计要点：
   *   - **必须记住"最近发的是哪张"**：图片在消息里只显示 `[图片]`，无法从文本定位。
   *     记录时机是发图成功之后（见 sendImageV2），内存 Map，重启即清（可接受：
   *     重启后群友再骂一次即可）。
   *   - 识别用 `classifyImageFeedback`，传 `recentImageMs` 让"换一张"这类省略说法
   *     在刚发图窗口内也算数（群里最常见的正是这种）。
   *   - 换图走 `sendImageV2`，**复用原查询 tags**，但那张已被拒绝，所以会挑到别的图。
   *   - 限流 90 秒：连骂三句不该连发三张。
   *
   * @param {string} key
   * @param {string} text 用户消息文本
   * @returns {Promise<boolean>} 是否已接管
   */
  async function handleImageFeedback(key, text) {
    const ic = cfg.socialV2?.images ?? {};
    if (ic.enabled !== true || ic.feedbackSwap === false) return false;

    const last = lastSentImage.get(key);
    if (!last) return false;
    const ageMs = Date.now() - last.at;
    const windowMs = Math.max(0, Number(ic.feedbackWindowMs) || 120 * 1000);
    const inWindow = ageMs <= windowMs;

    // 在窗口内才允许"省略图字"也判差评；窗口外要求句子里明确提到图。
    const verdict = classifyImageFeedback(text, inWindow ? { recentImageMs: ageMs } : {});
    if (!verdict.negative) return false;

    const gate = imageFeedbackGate.shouldSwap(key);
    if (!gate.allow) {
      log(`[图库] ${key} 差评（${verdict.reason}）但 ${Math.ceil(gate.retryAfterMs / 1000)}s 内已换过图，跳过`);
      return false;
    }

    // 1) 先删掉被差评的这张（含拒绝名单，避免下次又拉回来）
    const rej = imageStore.reject(last.id, { reason: `差评：${text.slice(0, 40)}` });
    log(`[图库] ${key} 收到差评（${verdict.reason}），已删除 ${last.id}${rej.existed ? '' : '（条目已不在库）'}并加入拒绝名单`);
    appendActivity(`${key} [图库] 差评换图：删除 ${last.id}（${text.slice(0, 20)}）`);
    lastSentImage.delete(key);

    // 2) 再发一张新的（沿用原查询条件；被拒的那张已排除，会挑到别的）
    try {
      const r = await sendImageV2(key, { tags: last.tags ?? [], _fromFeedback: true });
      if (r?.sent) {
        log(`[图库] ${key} 差评后已换发新图：${r.entry.id}`);
        return true;
      }
    } catch (error) {
      // 换不成就如实说——别让群友干等一张永远不来的图
      log(`[图库] ${key} 差评换图失败：${error?.message ?? error}`);
      try { await sendToQQ(key, '诶，没找到别的了……要不你换个词？'); } catch {}
    }
    return true;
  }

  // ── 运行中自愈：DSH 丢掉 provider 配置 ────────────────────────────────
  // 起因：打开 DSH 桌面端（0.2.0-rc.2）会把 ~/.dsh/settings.yaml 改名成
  // settings.yaml.imported（它的"旧版遗留导入"逻辑），而桥接用的 CLI 版
  // （0.1.1-rc.2）只认 settings.yaml → provider 表变空 → 每轮投递报
  // `no adapter serves provider "vgw"`，表现为机器人集体不理人。
  //
  // start-all.ps1 里的脚本只在**启动时**自愈；但桌面端是运行中打开的，
  // 那时没人修，会一直坏到下次重启。所以这里在检测到该错误时主动重写一次配置
  // （复用 scripts/ensure-dsh-provider.mjs，从 .imported 读回）。
  let providerHealRunning = null;
  const PROVIDER_HEAL_COOLDOWN_MS = 2 * 60 * 1000;
  const providerHealAtByKind = new Map(); // kind -> 上次修复时间（两类错误各自节流，别互相压住）
  function isProviderLostError(text) {
    return /no adapter serves provider|no adapter registered for provider|model-unavailable/i.test(String(text ?? ''));
  }
  // 推理档位冲突：provider 级 `reasoning: <默认档>` 与模型自己的 `reasoningEfforts` 表对不上，
  // DSH 直接拒：`pi-ai provider "vgw" model "X" does not support reasoning effort "high"`。
  // 成因是 `scripts/switch-realm-model.mjs` 早期硬编码 `reasoningEfforts: false`（2026-10-10 实测触发）。
  function isEffortMismatchError(text) {
    return /does not support reasoning effort|UNSUPPORTED_REASONING_EFFORT/i.test(String(text ?? ''));
  }
  // 两类错误的修复脚本不同，但都是「配置写坏 → 每轮投递全失败」，共用同一套节流与私聊通知。
  function healScriptFor(text) {
    if (isProviderLostError(text)) return { kind: 'provider', name: 'ensure-dsh-provider.mjs', label: 'provider 配置丢失', ok: /已写入 providers\.vgw|正常，无需处理/ };
    if (isEffortMismatchError(text)) return { kind: 'effort', name: 'fix-reasoning-efforts.mjs', label: '推理档位声明与 provider 默认档冲突', ok: /已写入 models|无需改动/ };
    return null;
  }
  function healDshConfig(reason, detail) {
    const spec = healScriptFor(detail);
    if (!spec) return Promise.resolve(false);
    if (providerHealRunning) return providerHealRunning;
    const now = Date.now();
    const lastAt = providerHealAtByKind.get(spec.kind) || 0;
    if (now - lastAt < PROVIDER_HEAL_COOLDOWN_MS) {
      log(`[自愈] ${spec.label} 恢复冷却中（${Math.ceil((PROVIDER_HEAL_COOLDOWN_MS - (now - lastAt)) / 1000)}s），跳过`);
      return Promise.resolve(false);
    }
    providerHealAtByKind.set(spec.kind, now);
    const script = path.join(ROOT, 'scripts', spec.name);
    providerHealRunning = (async () => {
      try {
        if (!fs.existsSync(script)) { log(`[自愈] 找不到 ${script}，无法自动恢复`); return false; }
        log(`[自愈] 检测到${spec.label}（${reason}），执行 ${spec.name}…`);
        const { execFile } = await import('node:child_process');
        const out = await new Promise((resolve) => {
          execFile(process.execPath, [script], { cwd: ROOT, timeout: 120000 }, (err, stdout, stderr) => {
            resolve(`${stdout ?? ''}${stderr ?? ''}${err ? `\n[exit ${err.code}]` : ''}`);
          });
        });
        for (const line of String(out).trim().split('\n')) if (line.trim()) log(`[自愈] ${line.trim()}`);
        const healed = spec.ok.test(out);
        if (healed) {
          log(`[自愈] ${spec.label} 已修复；被拒的唤醒会由后续重试/补投重新投递`);
          notifyOwnerOfError('', `DSH ${spec.label}，已自动修复`, `触发原因：${reason}\n${String(out).slice(0, 600)}`, {
            说明: `已执行 scripts/${spec.name} 自动修好，无需手工操作。`
          }, true);
        } else {
          log(`[自愈] ${spec.label} 未能自动修复，请看上面的输出`);
          notifyOwnerOfError('', `DSH ${spec.label}，自动修复失败`, `${reason}\n${String(out).slice(0, 800)}`, {
            处置: `需手工排查：scripts/${spec.name}`
          }, true);
        }
        return healed;
      } catch (error) {
        log(`[自愈] 修复${spec.label}出错：${error?.message ?? error}`);
        return false;
      } finally {
        providerHealRunning = null;
      }
    })();
    return providerHealRunning;
  }

  /**
   * 上游额度/限流类报错的处理：详情私聊管理员（默认群内不发任何提示）。
   *
   * 返回 true 表示已识别并接管（调用方**不应**再发原始错误串），
   * false 表示不是额度类错误，调用方按原逻辑处理。
   *
   * @param {string} key 会话 key
   * @param {string} rawError 原始错误文本（发给管理员的详情里会原样带上）
   * @param {{sessionId?:string}} [extra]
   */
  async function handleUpstreamError(key, rawError, extra = {}) {
    // provider 配置丢失不属于"额度/限流"，先走自愈（不 return，后续照常通知管理员）。
    if (healScriptFor(rawError)) healDshConfig(`${key || '未知会话'} 投递被拒`, rawError).catch(() => {});
    const en = cfg.socialV2?.errorNotice ?? {};
    if (en.enabled === false) return false;
    const cls = classifyUpstreamError(rawError);
    if (!cls.matched) return false;

    // 节流：同一会话 windowMs 内只提示一次。判定与记账同步（见 error-notifier 注释），
    // 所以这里拿到的 allowed 就是最终结论，不存在两个回合都拿到 true 的窗口。
    const gate = errorNotifier.shouldNotify(key);
    let sentText = '';
    // 群内提示默认关闭（cfg.socialV2.errorNotice.inGroup）：报错不进群，只私聊管理员。
    if (gate.allowed && en.inGroup === true) {
      const msg = pickMessage(en.messages);
      sentText = msg;
      await sendToQQ(key, msg);
      log(`[报错拦截] ${key} 上游${cls.code}，已发人设提示：${msg}`);
      appendActivity(`${key} [报错拦截] 上游${cls.code}，已提示：${msg}`);
    } else if (gate.allowed) {
      log(`[报错拦截] ${key} 上游${cls.code}，群内提示已关闭（只通知管理员）`);
    } else {
      log(`[报错拦截] ${key} 上游${cls.code}，${Math.ceil(gate.retryAfterMs / 1000)}s 内已提示过，跳过`);
    }

    // 私聊管理员：带上群号、错误码与**压缩过的**错误详情，便于直接排查。
    // 为什么压缩：网关在 WAF 拦截时会把整个 403 HTML 页（含内联 CSS/JS、腾讯云 CDN
    // 链接）当 message 回传，原样转发就是满屏英文标签，真正有用的错误码反而被淹没。
    if (en.notifyOwner !== false && cfg.ownerQQ) {
      const report = buildOwnerReport({
        key,
        code: cls.code,
        rawError: condenseUpstreamDetail(rawError),
        // 群内提示默认关闭，此时列表为空——别塞空串，否则详情里会出现没有内容的「群内已回复：」。
        messages: sentText ? [sentText] : [],
        sessionId: extra.sessionId ?? ''
      });
      // 私聊走同一个 sendChain，顺序不会被群消息插队；失败只记日志，不影响主流程。
      sendToQQ(`private:${String(cfg.ownerQQ)}`, report).catch(() => {});
    }
    return true;
  }

  // ── 统一的「报错只私聊管理员」通道 ────────────────────────────────────
  // 用户要求：报错信息一律不再出现在群里，全部转发给管理员账号。
  // 所有原本 `await sendToQQ(key, '⚠️ …')` 的报错点都改走这里：
  //   ① 只在群里留下「无」——群友看不到任何报错相关字样；
  //   ② 详情走私聊，带群号/QQ 号、类型、上下文，便于直接排查；
  //   ③ 按 key+类型节流，避免刷屏；被节流压掉的数量会在下次通知里带出来，不静默丢失。
  const ownerNotices = new Map(); // `${key}|${title}` -> { at, suppressed }
  // selfHeal=true 表示这条通知来自自愈流程本身，不再触发自愈（防递归）。
  function notifyOwnerOfError(key, title, detail = '', extra = {}, selfHeal = false) {
    // 配置类故障（provider 丢失 / 推理档位冲突）在这里统一自愈：
    // 这条是**所有报错出口的汇聚点**，唤醒投递被拒、黑话提取失败等都经过它，
    // 比在 handleUpstreamError 里挂更全面（那个只管"额度/限流"类）。
    if (!selfHeal) {
      const probe = `${detail} ${extra?.sessionId ?? ''} ${title}`;
      if (healScriptFor(probe)) healDshConfig(`${key || '未知会话'} · ${title}`, probe).catch(() => {});
    }
    const en = cfg.socialV2?.errorNotice ?? {};
    const base = cfg.errorNotify ?? {};
    if (en.notifyOwner === false || base.notifyOwner === false) return;
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    if (!ownerQQ) { log(`[报错] 想通知管理员但 cfg.ownerQQ 为空：${title}（${key}）`); return; }
    // key 可能为空（如发送线程里的错误），此时也能通知，只是没有群号字段。
    const bucket = `${key}|${title}`;
    const windowMs = Math.max(0, Number(base.windowMs) || 0);
    const now = Date.now();
    const prev = ownerNotices.get(bucket);
    if (windowMs > 0 && prev && now - prev.at < windowMs) {
      prev.suppressed += 1;
      log(`[报错] ${title}（${key}）在节流窗口内，已累计 ${prev.suppressed} 次不重复私聊`);
      return;
    }
    const suppressed = prev ? prev.suppressed : 0;
    ownerNotices.set(bucket, { at: now, suppressed: 0 });
    if (ownerNotices.size > 500) {
      for (const k of ownerNotices.keys()) { ownerNotices.delete(k); if (ownerNotices.size <= 400) break; }
    }
    const report = buildOwnerNotice({ key, title, detail, at: now, extra, suppressed });
    // 私聊走同一个 sendChain，顺序不会被群消息插队；失败只记日志，不影响主流程。
    sendToQQ(`private:${ownerQQ}`, report).catch(() => {});
    log(`[报错] 已私聊管理员：${title}（${key || '无会话'}）${suppressed ? `，含此前 ${suppressed} 次同类` : ''}`);
  }

  function sendToQQ(key, msg) {
    const safeMsg = redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    for (const part of parts) {
      sendChain = sendChain
        .then(async () => {
          const sentData = kind === 'private'
            ? await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`)
            : await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          recordSentMessage(key, sentData, part);
        })
        .catch((error) => log(`QQ 发送失败 (${key}):`, error?.message ?? error))
        .then(() => sleep(cfg.sendDelayMs));
    }
    return sendChain;
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (let i = 0; i < tok.length; i += safeMax) out.push(tok.slice(i, i + safeMax));
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendChain = sendChain
        .then(async () => {
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => log(`QQ 发送失败 (${key}):`, error?.message ?? error));
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendChain = sendChain.then(() => sleep(delay));
      }
    }
    return sendChain.then(() => sent);
  }


  // ── 已发消息登记（供管理员 /recall 撤回）────────────────────────────────
  // 四条发送通道（onebotSend 文本 / sendToQQ 系统提示 / 表情 / 图库）成功后都登记
  // OneBot 返回的 message_id，按会话保留最近 20 条。进程重启后记录清空（可接受：
  // 撤回本来就只对刚发的消息有意义）。
  const SENT_MSG_KEEP = 20;
  const sentMessages = new Map(); // key -> [{ messageId, at, preview }]
  const keyForKindId = (kind, id) => `${kind}:${id}`;
  function recordSentMessage(key, data, preview = '') {
    try {
      const mid = data?.message_id ?? data?.messageId;
      if (mid === undefined || mid === null || String(mid) === '') return;
      const arr = sentMessages.get(key) ?? [];
      arr.push({ messageId: mid, at: Date.now(), preview: String(preview).replace(/\s+/g, ' ').slice(0, 40) });
      while (arr.length > SENT_MSG_KEEP) arr.shift();
      sentMessages.set(key, arr);
    } catch {}
  }

  // 把本地图片文件发到指定会话（供 X 监控等外部推送使用）。
  // 走与图库相同的通道：OneBot 读本地文件上传，不经 base64 HTTP。
  /**
   * 把一个本地图片文件发到会话（X 推送用）。
   *
   * 也支持直接传 Buffer（`filePath` 为 Buffer 时）——超分回传要用：
   * 超分结果是内存里的字节，没必要落临时文件让 OneBot 再去读磁盘。
   *
   * ── 为什么要处理大图（2026-10-19 查证）──
   *
   * SnowLuma 的 OneBot HTTP 入口有一个**写死的 2MB 请求体上限**：
   *   `readRequestBody(req, maxBytes = 2 * 1024 * 1024)`
   * 超限时它直接 `req.destroy()`，所以客户端只看到 ECONNRESET、拿不到任何错误码。
   * 这个上限**没有通过配置暴露**，改源码才能动——不适合作为常规手段。
   *
   * 但这个上限只针对 **HTTP 请求体**，不针对图片本身：OneBot 读图片走的是
   * `loadBinarySource()`，它支持三种来源（base64 / http(s) URL / 本地文件路径），
   * 实测 5.1MB 的图用 `file://` 和 `http://` 都能正常发出（请求体只有几十字节）。
   *
   * 所以这里对超过安全阈值的 Buffer 走**本地临时 HTTP 托管**：起一个只监听回环、
   * 只服务这一张图、发完即关的一次性服务，把 http://127.0.0.1:port/xxx 交给 OneBot。
   * 选择 http:// 而不是 file:// 的原因：file:// 要求 OneBot 与桥接共享同一个文件系统
   * 路径（本机没问题，但换成跨容器/跨用户部署就会失效），http:// 没有这个耦合。
   */
  async function onebotSendImageFile(key, filePath, info = {}) {
    const [kind, id] = String(key).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error(`会话 key 格式错误：${key}`);
    let fileRef;
    let tempHost = null;
    if (Buffer.isBuffer(filePath)) {
      // base64 后必须留在 OneBot 的 2MB 请求体内（含 JSON 其余字段，留点余量）。
      // 超过就改用临时 HTTP 托管，绕开请求体上限。
      const MAX_INLINE_BYTES = 1_400_000;
      if (filePath.length <= MAX_INLINE_BYTES) {
        // base64 段：与 add_custom_face 处同一写法（bridge.js 1915 行附近）
        fileRef = `base64://${filePath.toString('base64')}`;
      } else {
        tempHost = await serveTempImage(filePath);
        fileRef = tempHost.url;
      }
    } else {
      const abs = path.resolve(filePath);
      if (!fs.existsSync(abs)) throw new Error(`图片文件不存在：${abs}`);
      fileRef = `file://${abs}`;
    }
    try {
      const segments = [{ type: 'image', data: { file: fileRef } }];
      const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
      const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(120000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
        throw new Error(`发图失败: ${body.wording || body.retcode || res.status}`);
      }
      // label 只用于发送记录（撤回/审计），超分图给个可辨识的标记
      recordSentMessage(key, body.data, info?.label ?? `［X推送］${info?.post?.id ?? ''}`);
      return body.data;
    } finally {
      // OneBot 拉取是同步完成的（它 await 完整响应后才返回），所以这里可以立即关。
      // 万一它做了异步续传，close 会等连接结束；再加 unref + 超时兜底避免泄漏。
      if (tempHost) tempHost.close();
    }
  }

  /**
   * 起一个一次性本地 HTTP 服务托管单张图片，返回它的 URL 与关闭函数。
   *
   * 边界：只监听 127.0.0.1、只认随机路径、只回这一张图、发完即关。
   * 不读磁盘、不接受任何参数——不存在目录穿越或任意文件读取的可能。
   */
  async function serveTempImage(buf) {
    const token = crypto.randomBytes(16).toString('hex');
    const contentType = sniffImageMime(buf) || 'image/png';
    const srv = http.createServer((req, res) => {
      if (req.url !== `/${token}`) {
        res.writeHead(404, { connection: 'close' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': buf.length,
        connection: 'close'
      });
      res.end(buf);
    });
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', resolve);
    });
    const port = srv.address()?.port;
    if (!port) {
      try { srv.close(); } catch {}
      throw new Error('临时图片服务启动失败');
    }
    // unref：不让这个短命服务阻止进程退出
    srv.unref?.();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try { srv.close(); } catch {}
      // close() 只有等现存连接结束才回调；给一个兜底，避免极端情况下端口悬挂
      const t = setTimeout(() => { try { srv.closeAllConnections?.(); } catch {} }, 5000);
      t.unref?.();
    };
    return { url: `http://127.0.0.1:${port}/${token}`, close };
  }

  /**
   * 发一个本地视频文件（X 帖子里的视频）。
   *
   * ⚠️ SnowLuma 的 OneBot 实现强制要求：**video 段必须是消息里唯一的段**
   * （`assertVideoSendPolicy`：出现次数必须为 1，且 segment 总数必须为 1）。
   * 所以视频**不能**和文字/引用拼在同一条消息里，文字要另发一条。
   */
  async function onebotSendVideoFile(key, filePath, info = {}) {
    const [kind, id] = String(key).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error(`会话 key 格式错误：${key}`);
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) throw new Error(`视频文件不存在：${abs}`);
    const st = fs.statSync(abs);
    if (!st.size) throw new Error('视频文件为空');
    const segments = [{ type: 'video', data: { file: `file://${abs}` } }];
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      // 视频上传比图片慢得多（47MB 实测约 20~60s），超时要给足
      signal: AbortSignal.timeout(300000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`发视频失败: ${body.wording || body.retcode || res.status}`);
    }
    recordSentMessage(key, body.data, `［X视频］${info?.post?.id ?? ''}`);
    return body.data;
  }

  /**
   * 发一条**语音消息**（GPT-SoVITS 合成，达妮娅音色），单独 record 发送。
   *
   * 与图片/视频发送同一套结构，差异在于：
   *   - OneBot 的语音段是 `{type:'record', data:{file}}`；
   *   - 部分实现要求**silk/amr** 格式，但 SnowLuma 实测能直接吃 wav
   *     （它内部会转码），所以这里不额外压一道，省一次 ffmpeg。
   *   - 语音比图片小得多（3~4 秒约 250KB），`file://` 直接可发，不需要 base64 兜底。
   */
  async function onebotSendVoiceFile(key, filePath, info = {}) {
    const [kind, id] = String(key).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error(`会话 key 格式错误：${key}`);
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) throw new Error(`语音文件不存在：${abs}`);
    const st = fs.statSync(abs);
    if (!st.size) throw new Error('语音文件为空');
    // QQ 客户端实测不支持 reply + record 同气泡：引用段会让语音不渲染，
    // 只在通知里出现一条“语音”。所以语音永远单独发 record，不拼引用段；
    // 引用语义由桥接内部记录（answeredSeqs / 未读移除）保留。
    const segments = [{ type: 'record', data: { file: `file://${abs}` } }];
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(60000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`发语音失败: ${body.wording || body.retcode || res.status}`);
    }
    recordSentMessage(key, body.data, `［语音］${info?.text?.slice(0, 20) ?? ''}`);
    return body.data;
  }

  /** 让 SnowLuma 把语音缓存转成 wav base64（用于本地 ASR）。 */
  async function onebotGetRecordWav(file) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/get_record`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify({ file: String(file), out_format: 'wav' }),
      signal: AbortSignal.timeout(30000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0 || !body.data?.base64) {
      throw new Error(body.wording || `get_record 失败(${res.status})`);
    }
    return Buffer.from(body.data.base64, 'base64');
  }

  /**
   * 入站语音转文字（Phase 2 语音输入）：从 record 段拿 file，让 SnowLuma
   * 转成 wav，再交给本地 faster-whisper。失败/ASR 不可用时保留 [语音] 占位，
   * 不阻塞正常文字消息。
   */
  async function transcribeIncomingVoice(key, messageId, segments) {
    const record = (Array.isArray(segments) ? segments : []).find((seg) => seg?.type === 'record');
    if (!record) return '';
    const data = record.data ?? {};
    const file = String(data.file ?? '').trim();
    const url = String(data.url ?? '').trim();
    if (!file && !url) return '';
    const cacheKey = String(messageId || file || url);
    if (voiceTranscriptCache.has(cacheKey)) return voiceTranscriptCache.get(cacheKey);
    if (!asrEngine) return '';
    let buffer = null;
    try {
      if (file && !/^https?:\/\//i.test(file) && !/^file:\/\//i.test(file)) {
        buffer = await onebotGetRecordWav(file);
      } else {
        const target = file || url;
        const fetched = await safeFetchBuffer(target, 10 * 1024 * 1024, {
          userAgent: 'Mozilla/5.0 QQ-Bridge-ASR/1.0',
          headers: { referer: 'https://im.qq.com/' }
        });
        buffer = fetched?.buffer ?? null;
      }
    } catch (error) {
      log(`[语音] ${key} 读取语音失败：${error?.message ?? error}`);
      return '';
    }
    if (!buffer?.length) return '';
    const tmp = path.join(os.tmpdir(), `qq-voice-${crypto.randomBytes(6).toString('hex')}.wav`);
    try {
      fs.writeFileSync(tmp, buffer);
      const started = Date.now();
      const r = await withTimeout(asrEngine.transcribe(tmp), 30000, `语音转写 ${key}`);
      const text = String(r?.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      voiceTranscriptCache.set(cacheKey, text);
      while (voiceTranscriptCache.size > 200) {
        const oldest = voiceTranscriptCache.keys().next().value;
        if (oldest === undefined) break;
        voiceTranscriptCache.delete(oldest);
      }
      log(`[语音] ${key} 转写 ${text.length} 字（${Date.now() - started}ms）：${text.slice(0, 40)}`);
      return text;
    } catch (error) {
      log(`[语音] ${key} 转写失败（保留 [语音] 占位）：${error?.message ?? error}`);
      return '';
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
  }

  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      // 到这一层时 replyToMessageId 已被上层（send-message 端点）解析成真实 messageId，
      // 这里只做格式校验。不要在此再调 resolveReplyTargetV2：它是 async 且签名是
      // (st, kind, convId, ref)、返回 {info, messageId} 对象，在此同步使用会拿到 truthy 对象
      // 拼进 reply 段，导致发送失败。
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    // @ 之后补一个空格再跟正文（2026-10-20 用户反馈）。
    //
    // 为什么由这里加、而不是让模型写：@ 是**独立的消息段**，不是文本的一部分。
    // 不加分隔时 QQ 会把「@某人」和正文首字贴在一起，看着像「@小明你好」——
    // 群里读起来很别扭，也容易被误认为 @ 后面那串是名字的一部分。
    //
    // 只在**确实有 @** 且正文不以空白开头时补，避免：
    //   - 没有 @ 的普通消息被加前导空格；
    //   - 正文本身已经以空格/换行开头时出现两个空格。
    if (segments.some((s) => s.type === 'at')) {
      // 正文已以空白（空格/制表符/全角空格/换行）开头就不再补，否则会出现两个空格
      const lead = /^[ \t\u3000\r\n]/.test(rawMessage);
      if (!lead) segments.push({ type: 'text', data: { text: ' ' } });
    }
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    recordSentMessage(keyForKindId(kind, id), body.data, rawMessage);
    return body.data;
  }

  /**
   * 给某条群消息贴表情回应（OneBot `set_msg_emoji_like`）。
   *
   * 参数与限制见 emoji-react.js 的说明：**只支持群聊**，且目标消息需仍在
   * SnowLuma 的消息缓存里（否则 message not found）。
   * 失败只记日志、不抛——贴表情是"锦上添花"，不该影响主流程。
   *
   * @returns {Promise<boolean>} 是否成功
   */
  /**
   * 读 SnowLuma 的表情目录，得到合法 emoji_id 集合（供模型传错 id 时校验）。
   *
   * 为什么需要：模型可能凭印象编一个不存在的 id。有目录就能提前拒绝并提示，
   * 而不是把请求打到 QQ 再拿到一个含糊的报错。
   * 读不到目录时返回 null —— 此时只做格式校验，不因为环境缺文件而禁止贴表情。
   * 结果缓存（目录不会变）。
   */
  let emojiCatalogCache;
  function emojiCatalogIds() {
    if (emojiCatalogCache !== undefined) return emojiCatalogCache;
    emojiCatalogCache = null;
    try {
      const p = cfg.socialV2?.emojiReact?.catalogPath
        || path.join(cfg.snowluma?.homeDir || process.env.SNOWLUMA_DIR || path.join(os.homedir(), 'SnowLuma'), 'data', 'sys-face-catalog.json');
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const ids = new Set();
      for (const pack of raw.packs ?? []) {
        for (const e of pack.emojis ?? []) if (e?.qSid != null) ids.add(String(e.qSid));
      }
      if (ids.size) emojiCatalogCache = ids;
    } catch { /* 读不到就只做格式校验 */ }
    return emojiCatalogCache;
  }

  /**
   * 给某条群消息贴表情回应（OneBot `set_msg_emoji_like`）。
   * 参数与限制见 emoji-react.js。失败只记日志并返回 false，由调用方报错给模型。
   */
  async function setEmojiLike(groupId, messageId, emojiId, set = true) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/set_msg_emoji_like`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ message_id: Number(messageId), emoji_id: String(emojiId), set: set === true }),
        signal: AbortSignal.timeout(15000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.retcode !== 0) {
        log(`贴表情失败 (group:${groupId} msg:${messageId} emoji:${emojiId}): ${body.wording || body.retcode || res.status}`);
        return false;
      }
      return true;
    } catch (error) {
      log(`贴表情异常 (group:${groupId} msg:${messageId}): ${error?.message ?? error}`);
      return false;
    }
  }

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 静态图 / 动图抽帧拼图：多模态模型对 GIF 只能看到第一帧（实测），
  // 所以这里把多帧动图抽成关键帧横向拼成静态图再送出，让模型能顺着看出动作序列。
  // 开关与参数见 config.socialV2.gifFrames；失败一律退回原图（增强不该破坏链路）。
  async function maybeTileAnimatedGif(buf, mimeType) {
    const gc = cfg.socialV2?.gifFrames ?? {};
    if (gc.enabled === false) return null;
    if (!isGifBuffer(buf)) return null;
    // mimeType 声明为 gif 才处理；PNG/JPEG 永远不会走到这里。
    if (mimeType && mimeType !== 'image/gif') return null;
    try {
      const tiled = await tileGifFrames(buf, {
        maxFrames: gc.maxFrames,
        tileWidth: gc.tileWidth,
        timeoutMs: gc.timeoutMs
      });
      if (!tiled) return null;
      log(`动图抽帧拼图：${tiled.frames} 帧取 ${tiled.kept} 帧，${Math.round(buf.length / 1024)}KB -> ${Math.round(tiled.buffer.length / 1024)}KB`);
      return tiled;
    } catch (error) {
      log(`动图抽帧失败（退回原图）: ${error?.message ?? error}`);
      return null;
    }
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  const MAX_MEDIA_COUNT = 5; // 单条消息最多内联/返回的图片/表情数
  // 单条消息图片总字节上限。这是桥接自己的保守值（非 QQ/上游的硬性要求），
  // 可通过 config.socialV2.media.maxMessageBytes 调整；默认 8MB。
  // 注：调大后走的是内存内联与上游请求体，注意与网关 server.max_body_mb 的关系。
  const MAX_MEDIA_BYTES = Math.max(1024 * 1024, Number(cfg.socialV2?.media?.maxMessageBytes) || 8 * 1024 * 1024);
  const MAX_MEDIA_PIXELS = 64_000_000; // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  async function fetchOneBotImage(media) {
    // 优先使用 OneBot get_image 获取网关侧信息；只有 file 是安全缓存文件名时才允许交给网关。
    if (media.kind === 'image' && media.file && isProbablySafeImageFileRef(media.file)) {
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const buf = Buffer.from(base64, 'base64');
            if (buf.length > 0 && looksLikeImageBuffer(buf)) {
              const dims = getImageDimensions(buf);
              if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
                log(`get_image 返回的图片像素超限，已跳过（${dims.width}x${dims.height}）`);
              } else {
                return { buffer: buf, mimeType: mimeFromBuffer(buf) };
              }
            }
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
          const dims = getImageDimensions(fetched.buffer);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            log(`get_image URL 图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else {
            return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(obj.url) };
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const buf = fs.readFileSync(obj.file);
            const dims = getImageDimensions(buf);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`本地图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: buf, mimeType: mimeFromBuffer(buf) };
            }
          }
        }
      } catch (error) {
        log(`get_image 解析失败: ${error?.message ?? error}`);
      }
    }
    // 其次直接用消息段里的 URL
    if (media.url) {
      try {
        // 原图可能很大（群友常发几 MB 的动图/超高清壁纸）。这里**不能用"超限就丢弃"**：
        // 实测（2026-10-22）群友发了 >8MB 的图，safeFetchBuffer 直接 reject，本函数返回 null，
        // 模型完全没看到图，只能回「图没加载出来，你再发一次」——而再发一次还是同一张，
        // 永远加载不出来。
        //
        // 上限放宽到 4 倍（32MB），先尽量把整张图拿到：完整图才能被 ffmpeg 正常重编码压缩。
        // 实测截断的 PNG 会让 ffmpeg 报 `chunk too big` 而缩图失败，最后原样把半张灰图给模型
        // ——比完全看不到强，但明显不如拿到整张再压。
        // 所以 partialOnOversize 只是**最后兜底**：连 32MB 都超了，也至少给个能看的前缀。
        const HARD_CAP = Math.max(MAX_MEDIA_BYTES * 4, MAX_MEDIA_BYTES + 1024 * 1024);
        const fetched = await safeFetchBuffer(String(media.url), HARD_CAP, { partialOnOversize: true });
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
          log(`图片 URL 像素超限，已跳过（${dims.width}x${dims.height}）`);
        } else {
          const prepared = await prepareImageForModel(fetched.buffer, {
            mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(media.url),
            log,
            upscale: cfg.socialV2?.upscale
          });
          if (fetched.truncated) {
            // 截断的图可能只解码出上半部分（ffmpeg 会拒绝重编码），模型看到的是残缺画面。
            // 这里明确记日志，便于排查"机器人看图看得不准"这类反馈。
            log(`图片超限（收到 ${Math.round(fetched.receivedBytes / 1024)}KB，未取全），已尽力压缩后交给模型（${Math.round(prepared.buffer.length / 1024)}KB）——画面可能不完整`);
          }
          return { buffer: prepared.buffer, mimeType: prepared.mimeType };
        }
      } catch (error) {
        log(`图片 URL 抓取失败: ${error?.message ?? error}`);
      }
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    if (!Number.isInteger(faceId)) return { text: `[表情#${media.faceId}]` };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`表情图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
            }
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : `[表情#${media.faceId}]` };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: `[表情#${media.faceId}]` };
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += face.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          parts.push({ type: 'image', mediaType: face.mimeType || 'image/png', data: face.buffer.toString('base64'), name: `face-${media.faceId}.${(face.mimeType || 'png').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          // 动图抽帧拼图：模型看 GIF 只有第一帧，拼图后才能看出动作序列。
          const tiled = await maybeTileAnimatedGif(img.buffer, img.mimeType);
          if (tiled) {
            if (totalBytes + tiled.buffer.length > MAX_MEDIA_BYTES) {
              parts.push({ type: 'text', text: `[动图${index}（抽帧后超出大小上限，已跳过）]` });
              continue;
            }
            totalBytes += tiled.buffer.length;
            parts.push({ type: 'text', text: gifFramesHint(index, tiled) });
            // mimeType 用拼图返回的实际格式：大拼图会被转成 JPEG 控体积（见 gif-frames.js），
            // 这里写死 png 会让下游按 PNG 解析 JPEG 字节。
            const tiledExt = (tiled.mimeType || 'image/png').split('/')[1];
            parts.push({ type: 'image', mediaType: tiled.mimeType || 'image/png', data: tiled.buffer.toString('base64'), name: `qq-gif-${index}-tiled.${tiledExt}` });
            continue;
          }
          // 大图先降采样再交给模型（见 image-downscale.js）：
          // 手机拍的原图 base64 后可达 4.7MB，会让 DSH 侧处理时爆栈
          // （实测报 "Maximum call stack size exceeded" → 模型只看到"图片不可用"）。
          // 放在大小检查**之前**：先缩再看大小，避免把能救回来的图直接判超限跳过。
          // 统一预处理：先缩大图（防 base64 过大让 DSH 爆栈），再放大小图
          // （305×92 这类截图文字不足 1 个 patch 高，模型读不出）。见 image-downscale.js。
          const scaled = await prepareImageForModel(img.buffer, { mimeType: img.mimeType, upscale: cfg.socialV2?.upscale, log: (m) => log(m) });
          const useBuf = scaled.buffer;
          const useMime = scaled.mimeType || img.mimeType || 'image/jpeg';
          if (totalBytes + useBuf.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[图片${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += useBuf.length;
          parts.push({ type: 'text', text: `[图片${index}]` });
          parts.push({ type: 'image', mediaType: useMime, data: useBuf.toString('base64'), name: `qq-image-${index}.${useMime.split('/')[1] || 'jpeg'}` });
        } else {
          parts.push({ type: 'text', text: `[图片${index}（获取失败）]` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList, opts = {}) {
    // raw=true：跳过所有预处理（超分/缩放/抽帧），把原图原样返回。
    // 用途：qq_upscale_image 需要**原始像素**才能超分——若先被 lanczos 放大到 1220px，
    // 超分工具看到的已是插值后的糊图，再超分既无收益也失真（实测 200×163 被预处理成 1220×994，
    // 于是工具报"原图已经很大"）。缩放/抽帧是为"直接给模型看"服务的，超分要自己走一遍。
    const raw = opts.raw === true;
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : 'image', text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += face.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: face.mimeType || 'image/png',
            data: face.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          if (raw) {
            // 原图直出（给超分工具用）：不抽帧、不缩放，保留真实像素与格式。
            // 体积仍受 MAX_MEDIA_BYTES 约束（与其它路径一致，避免超大图把本地端点撑爆）。
            if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
              out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（原图超出大小上限，已跳过）' });
              continue;
            }
            totalBytes += img.buffer.length;
            out.push({
              index,
              kind: 'image',
              file: media.file ? String(media.file) : undefined,
              url: media.url ? String(media.url) : undefined,
              mimeType: img.mimeType || 'image/png',
              data: img.buffer.toString('base64'),
              raw: true,
              // 动图也如实标注：超分工具据此拒绝（超分会丢帧语义）
              animated: isGifBuffer(img.buffer),
              text: ''
            });
            continue;
          }
          // 动图抽帧拼图（与 resolveMediaList 同策略）：模型看 GIF 只有第一帧。
          const tiled = await maybeTileAnimatedGif(img.buffer, img.mimeType);
          if (tiled) {
            if (totalBytes + tiled.buffer.length > MAX_MEDIA_BYTES) {
              out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（动图抽帧后超出大小上限，已跳过）' });
              continue;
            }
            totalBytes += tiled.buffer.length;
            out.push({
              index,
              kind: 'image',
              file: media.file ? String(media.file) : undefined,
              url: media.url ? String(media.url) : undefined,
              // mimeType 跟随拼图实际格式（大拼图会转 JPEG 控体积）
              mimeType: tiled.mimeType || 'image/png',
              data: tiled.buffer.toString('base64'),
              animated: true,
              frames: tiled.frames,
              framesKept: tiled.kept,
              // 排布信息必须一起传给 MCP 侧：文案要按实际网格说明阅读顺序
              // （只有 kept 的话，多行拼图会被描述成"从左到右"一行读完，模型会读错时间线）。
              cols: tiled.cols,
              rows: tiled.rows,
              tileWidth: tiled.tileWidth,
              text: ''
            });
            continue;
          }
          // 与 resolveMediaList 同策略：大图先降采样（见 image-downscale.js），
          // 否则 base64 过大时 DSH 侧会爆栈、模型只看到"图片不可用"。
          // 与 resolveMediaList 同一套预处理（缩大图 + 放大小图）——两处必须一致，
          // 否则走 MCP 工具取图时行为不同（这类"两处要同改"的坑踩过多次）。
          const scaled2 = await prepareImageForModel(img.buffer, { mimeType: img.mimeType, upscale: cfg.socialV2?.upscale, log: (m) => log(m) });
          const useBuf2 = scaled2.buffer;
          const useMime2 = scaled2.mimeType || img.mimeType || 'image/jpeg';
          if (totalBytes + useBuf2.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += useBuf2.length;
          out.push({
            index,
            kind: 'image',
            file: media.file ? String(media.file) : undefined,
            url: media.url ? String(media.url) : undefined,
            mimeType: useMime2,
            data: useBuf2.toString('base64'),
            text: ''
          });
        } else {
          out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片获取失败）' });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    if (currentMode === 'reserved2') {
      return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
    }
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (currentMode === 'reserved2' || socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st && Array.isArray(st.recentMessages)) {
          const found = st.recentMessages.find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
          if (found && Array.isArray(found.media)) return found.media;
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  /**
   * 异步版的 findMessageMedia：本地缓存没命中时**回源向 QQ 取那条消息**。
   *
   * 为什么必须回源：本地缓存只装「桥接见过的消息」，而**群友引用别人的图**时，
   * 被引用的那条消息桥接可能压根没经手（或已超出 recentMessages 窗口），
   * 于是 `qq_get_message_images` 返回「没有可读取的图片元数据」——模型就看不了图。
   * 实测这是「别人回复图片消息，机器人看不到图」的直接原因。
   *
   * 归属校验与 resolveReplyInfo 一致：只接受本会话的消息，避免跨会话读取。
   */
  async function findMessageMediaAsync(key, ref) {
    const local = findMessageMedia(key, ref);
    if (local.length) return local;
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    const keyMatch = /^(group|private):(\d+)$/.exec(key);
    if (!keyMatch) return [];
    const kind = keyMatch[1];
    const convId = keyMatch[2];
    try {
      const numericId = Number(refStr);
      if (!Number.isSafeInteger(numericId)) return [];
      const raw = await bot.getMessage(numericId);
      if (!raw) return [];
      // 归属校验（同 resolveReplyInfo）：群消息必须属于该群；私聊必须无群归属
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null || String(rawGroup) !== String(convId)) return [];
      } else {
        if ((raw.group_id ?? raw.groupId) != null) return [];
      }
      const media = extractMediaFromSegments(raw.message ?? []);
      // 顺手写回缓存，避免同一条被反复回源
      if (media.length) {
        let byRef = messageMediaStore.get(key);
        if (!byRef) { byRef = new Map(); messageMediaStore.set(key, byRef); }
        byRef.set(refStr, media);
      }
      return media;
    } catch (error) {
      log(`回源取被引用消息图片失败 ${key} ${refStr}: ${error?.message ?? error}`);
      return [];
    }
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  /**
   * 决定这次发送要不要自动 @，并把结果记进会话状态（用于冷却与每小时上限）。
   * 只在真正要发时调用（planAutoAtV2 不产生副作用以外的东西）。
   */
  function planAutoAtV2(key, kind, messages, explicitAtUserId, quoted) {
    if (kind !== 'group') return null;
    const sendCfg = cfg.socialV2?.send ?? {};
    const autoCfg = { ...DEFAULT_AUTO_AT, ...(sendCfg.autoAt ?? {}) };
    if (autoCfg.enabled === false) return null;
    try {
      const st = getSocialV2State(key);
      const now = Date.now();
      // 「本回合已 @ 过」就不再 @（用户要求：回同一个人多条时只在第一条 @）。
      //
      // 判据用 v2TurnStartAt（本回合开始时间）而不是固定时间窗：
      // 固定窗会误伤——一个回合可能持续几分钟（模型连续调用工具），
      // 而两个不同回合可能相隔几秒。用"是否同一回合"才准确。
      // 极端情况下（拿不到 sessionId / 没有回合标记）退回 90 秒窗口兜底，
      // 覆盖"模型连续调用但回合标记已清理"的间隙。
      const sid = state.sessions[key];
      const turnStart = sid ? Number(v2TurnStartAt.get(sid)) || 0 : 0;
      const lastAutoAtTurn = sid ? Number(autoAtTurnDone.get(sid)) || 0 : 0;
      if (sid) {
        if (turnStart > 0) {
          if (lastAutoAtTurn >= turnStart) {
            log(`[自动@] ${key} 跳过：本回合已 @ 过（回多条只在第一条点名）`);
            return null;
          }
        } else if (lastAutoAtTurn > 0 && now - lastAutoAtTurn < 90 * 1000) {
          // 没有回合标记（非 reserved2 / 刚重置）：用 90 秒窗口兜底
          log(`[自动@] ${key} 跳过：刚 @ 过（${Math.round((now - lastAutoAtTurn) / 1000)}s 前）`);
          return null;
        }
      }
      const times = (st.autoAtTimes || []).filter((t) => now - Number(t) < 3600000);
      // 机器人别名：用于判断"这条是不是明确在叫它"（@它 / 引用它）。
      // 与 findCallersV2 同源：**群名片** + 账号昵称 + 角色名 + 唤醒关键词。
      // 群名片不能少：QQ 的 @ 显示的是群名片而不是账号昵称（2026-10-22 事故）。
      // 有了这个，短回应（"喏，图来了"）也能正确落到提问者身上，不依赖字面重合。
      const aliasInfo = botAliasNamesV2(key, st);
      const picked = pickAutoAt({
        kind,
        atUserId: explicitAtUserId,
        quoted: quoted ?? null,
        // 未读才是"这次是谁在叫它"，比 recentMessages 准；见 auto-at.js
        unreadMessages: Array.isArray(st.unread) ? st.unread : [],
        recentMessages: Array.isArray(st.recentMessages) ? st.recentMessages : [],
        aliasNames: aliasInfo.all,
        // 匹配前把机器人自己的名字剔掉：否则"给大肥鱼买鱼食"和"大肥鱼可爱"
        // 会因为共享名字而被判成在聊同一件事。
        ignoreNames: aliasInfo.primary,
        ignoreAtNames: aliasInfo.all,
        replyText: String(messages?.[0] ?? ''),
        lastAutoAt: st.lastAutoAt || 0,
        autoAtTimes: times,
        config: autoCfg,
        now
      });
      if (!picked.userId) {
        // 只在"掷中但被排除"这类值得关注的情况下记一行，避免刷屏日志。
        if (picked.reason === 'cooldown' || picked.reason === 'hourly-cap') {
          log(`[自动@] ${key} 跳过：${picked.reason}`);
        }
        return null;
      }
      // 记额度（冷却与每小时上限都基于它）
      st.autoAtTimes = [...times, now].slice(-100);
      st.lastAutoAt = now;
      saveSocialV2State();
      // 记「本回合已 @ 过」：同一回合后续的多次发送不再点名（见上面的说明）。
      // 只放内存：回合标记本身是进程内状态，重启后归零也无害。
      if (sid) {
        autoAtTurnDone.set(sid, now);
        // 有界：会话不多，但避免长期运行无限增长
        if (autoAtTurnDone.size > 500) {
          const oldest = autoAtTurnDone.keys().next().value;
          if (oldest !== undefined) autoAtTurnDone.delete(oldest);
        }
      }
      const who = String(quoted?.sender ?? '').trim();
      // 日志里带上"凭什么选他"：@错人时不用再翻会话记录。
      // 重合度只对内容匹配有意义；引用/明确@ 的分数可能为 0，属正常。
      const score = picked.overlap > 0 ? ` 重合度=${picked.overlap}` : '';
      const hitText = picked.matchedText ? ` 命中="${String(picked.matchedText).slice(0, 40)}"` : '';
      log(`[自动@] ${key} @${picked.userId}${who ? `（${who}）` : ''} 来源=${picked.reason}${score}${hitText}`);
      if (Array.isArray(picked.candidates) && picked.candidates.length > 1) {
        log(`[自动@] ${key} 候选：${picked.candidates.map((c) => `${c.userId}:${c.overlap}`).join(' / ')}`);
      }
      appendActivity(`${key} 自动 @${picked.userId}（${picked.reason}）`);
      return { userId: picked.userId, reason: picked.reason, overlap: picked.overlap || 0 };
    } catch (error) {
      log(`[自动@] 判定失败（已忽略）: ${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * 统一发送（所有 reserved2 发送端点最终都走这里）。
   *
   * `options.quoted` 传入引用解析出的被引消息（{userId, sender, messageId}），
   * 供「按概率 @ 对方」定位目标；`options.autoAt` 传 false 可跳过（例如发图片标注）。
   */
  /**
   * 语音消息掷骰：这次回复要不要**改用语音**发出去。
   *
   * 需求（2026-10-21 用户）：「让它有概率发出语音消息」。
   *
   * ── 为什么由桥接掷骰而不是让模型决定 ────────────────────────────────
   *
   * 与自动 @ 同一个道理：让模型自己判断"这次要不要发语音"，它要么几乎不发、
   * 要么想起来就连续发好几条，频率完全不可控。交给桥接按固定概率掷，
   * 群友听到的节奏是稳定的（默认 8%，约每 12 条回复里 1 条）。
   *
   * ── 哪些情况不发语音 ────────────────────────────────────────────────
   *
   * 这些限制都是"发了会更糟"的情形，不是保守：
   *   - 文本太长（>140 字）：语音要念 30 秒以上，群里没人愿意听；
   *   - 含链接/代码/数字串：念出来没法用，反而丢失信息；
   *   - 多段消息：分条语音会变成刷屏；
   *   - 自己刚发过语音（1 小时内）：避免叮叮叮连着响。
   */
  /**
   * 表情包掷骰：这一轮要不要**要求**模型发一张表情。
   *
   * 需求（2026-10-22 用户）：「现在依旧极少调用表情包，给出一个解决方案，
   * 能够有更多机会并且根据回答语气选择合适表情包」。
   *
   * ── 为什么不让模型自己决定 ──────────────────────────────────────
   *
   * 实测：1999 次工具调用里 `qq_send_sticker` 只有 **1 次**。原来的软策略
   * （"大约每 3~5 轮来一张就够"）没有约束力，而发表情要多一次工具调用、
   * 还不能和文字同气泡——对模型来说收益"可有可无"，自然永远跳过。
   * 所以改成与自动 @ 同一思路：**桥接掷骰定"发不发"，模型只负责"发哪张"**。
   *
   * ── 语气怎么判 ──────────────────────────────────────────────────
   *
   * 提示词生成时模型还没写回复（那是它接下来的产物），所以只能用
   * **已有的上下文**判断语气：未读消息里对方最后一句话 + 机器人上次说的话。
   * 这已经够用——"对方在吐槽 → 回一张无语脸"这类对应关系，看对方的话最准。
   *
   * @returns {{mood,moodLabel,picks}|null} null = 本轮不要求发表情
   */
  function planStickerV2(key, st) {
    const sc = cfg.socialV2?.sticker ?? {};
    if (sc.enabled === false) return null;
    if (sc.autoNudge === false) return null;
    if (!Array.isArray(stickerEntries) || !stickerEntries.length) return null;
    // 工具被关掉时不要要求——否则模型只能违规或空转
    if (cfg.socialV2?.tools?.sendSticker === false) return null;

    const now = Date.now();
    // 频率：默认每 3 轮里最多 1 轮要求（约 33%），比原来"约 3~5 轮一次"高得多，
    // 但仍不会每句都发。间隔兜底防止模型连聊时每轮都命中。
    const minGapMs = Math.max(0, Number(sc.autoNudgeMinGapMs) || 3 * 60 * 1000);
    if (now - (Number(st.lastStickerAt) || 0) < minGapMs) return null;
    const prob = Math.max(0, Math.min(1, Number(sc.autoNudgeProbability ?? 0.33)));
    if (Math.random() >= prob) return null;
    // 每小时硬上限：表情比语音吵，超了就宁可这轮不发
    const maxPerHour = Math.max(0, Number(sc.autoNudgeMaxPerHour) || 6);
    const hist = (Array.isArray(st.stickerNudgeTimes) ? st.stickerNudgeTimes : [])
      .filter((x) => now - Number(x) < 3600000);
    if (maxPerHour > 0 && hist.length >= maxPerHour) return null;

    // 语气判断：优先看**对方最后说的话**（未读优先，其次最近消息），
    // 因为"该配什么表情"取决于对方给了什么情绪，而不是我们自己上轮说了什么。
    const unread = Array.isArray(st.unread) ? st.unread : [];
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const lastOther = [
      ...[...unread].reverse(),
      ...[...recent].reverse()
    ].find((m) => m && !m.isSelf && String(m.text || '').trim());
    const moodSource = String(lastOther?.text || '');

    // 刚发过的表情不再进候选（避免连着两张一样）
    const recentIds = (Array.isArray(st.recentStickers) ? st.recentStickers : []).slice(-6);

    const picked = pickStickerCandidates(stickerEntries, {
      replyText: moodSource,
      recentIds,
      max: Math.max(1, Math.min(4, Number(sc.autoNudgeCandidates) || 3))
    });
    if (!picked?.picks?.length) return null;

    // 记下这次"要求过"，用于频率限制。真正的 lastStickerAt 在发送成功时更新。
    st.stickerNudgeTimes = [...hist, now].slice(-100);
    try { saveSocialV2State(); } catch { /* 存不上也不影响本轮 */ }

    return {
      ...picked,
      hint: moodSource
        ? `对方刚才说的是：「${moodSource.slice(0, 80)}」`
        : ''
    };
  }

  /**
   * 语音韵律/响度参数：**每次发送现读配置**，所以控制台改完即时生效，
   * 不需要重启（与音色/权重不同）。字段与 tts.js 的 DEFAULT_SPEECH_PARAMS 对齐。
   */
  function ttsSpeechParams() {
    const t = cfg.socialV2?.tts ?? {};
    const num = (v, d, min, max) => {
      const n = Number(v);
      const x = (v === undefined || v === null || v === '' || !Number.isFinite(n)) ? d : n;
      return Math.min(max, Math.max(min, Math.round(x * 1000) / 1000));
    };
    const split = String(t.textSplitMethod || 'cut5').trim();
    return {
      speed: num(t.speed, 1.0, 0.8, 1.2),
      fragmentInterval: num(t.fragmentInterval, 0.3, 0.1, 0.6),
      temperature: num(t.temperature, 0.9, 0.5, 1.2),
      topK: num(t.topK, 15, 5, 30),
      topP: num(t.topP, 0.95, 0.7, 1.0),
      textSplitMethod: ['cut1', 'cut5'].includes(split) ? split : 'cut5',
      volumeGainDb: num(t.volumeGainDb, 0, -12, 12),
      punctuate: t.punctuate !== false && t.punctuate !== 'false'
    };
  }

  function planTtsV2(key, messages, opts = {}) {
    const t = cfg.socialV2?.tts ?? {};
    if (t.enabled !== true) return null;
    if (!ttsEngine || !ttsEngine.available()) return null;
    if (opts.tts === false) return null;
    if (!Array.isArray(messages) || messages.length !== 1) return null;
    const msg = String(messages[0] ?? '').trim();
    if (!msg) return null;
    const maxChars = ttsNum(t.maxChars, 140, 20, 300);
    if (msg.length > maxChars) return null;
    // 链接、代码块、纯数字串念出来没有意义
    if (/https?:\/\/|www\.|```|<[^>]+>/.test(msg)) return null;
    if (/^[\d\s.,%+-]+$/.test(msg)) return null;
    // 频率上限：每小时最多 N 条语音（默认 3），避免连发
    const now = Date.now();
    const st = getSocialV2State(key);
    const hist = (Array.isArray(st.ttsTimes) ? st.ttsTimes : []).filter((x) => now - Number(x) < 3600000);
    const maxPerHour = ttsNum(t.maxPerHour, 3, 0, 60);
    if (maxPerHour > 0 && hist.length >= maxPerHour) return null;
    const prob = Math.max(0, Math.min(1, Number(t.probability ?? TTS_DEFAULT_PROBABILITY)));
    if (Math.random() >= prob) return null;
    // 语气决定用哪条参考音频（GPT-SoVITS 的"情绪"就是参考音频）。
    // 分类复用表情包的十类语气；没有匹配时引擎回落到默认参考。
    return { text: msg, history: hist, mood: moodOfText(msg) || '' };
  }

  /**
   * 把一条文本回复改成语音发出去。
   *
   * 失败**必须静默回退成文字**——语音是可选的表达方式，
   * 不能因为 TTS 出问题就让这条回复凭空消失（那才是真正的"不理人"）。
   */
  async function sendAsVoice(key, text, plan) {
    const [kind, id] = key.split(':');
    try {
      // refMode 每次现读配置：换成"固定某条参考"即时生效，不必重启；
      // 音色/权重才是启动参数（需重启）。
      const fixedRef = String(cfg.socialV2?.tts?.refMode || '').trim();
      const r = await ttsEngine.speak(text, {
        mood: plan?.mood,
        refId: fixedRef && fixedRef !== 'auto' ? fixedRef : '',
        params: ttsSpeechParams()
      });
      if (!r.ok) {
        log(`[TTS] 合成失败，改发文字：${r.error}`);
        return { ok: false, reason: r.error };
      }
      await onebotSendVoiceFile(key, r.file, { text });
      const st = getSocialV2State(key);
      st.ttsTimes = [...(plan?.history ?? []), Date.now()].slice(-200);
      st.lastTtsAt = Date.now();
      saveSocialV2State();
      const refTag = r.refMood ? `，情绪=${r.refMood}/${r.refId}` : '';
      log(`[TTS] 已发语音（${r.cached ? '缓存' : `${r.synthSec ?? '?'}s 合成`}，${r.durSec}s，${text.length} 字${refTag}）→ ${key}`);
      appendActivity(`${key} [TTS] 发了一条语音（${r.durSec}s）`);
      return { ok: true, durSec: r.durSec, cached: !!r.cached, file: r.file };
    } catch (error) {
      log(`[TTS] 发送语音失败，改发文字：${error?.message ?? error}`);
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null, options = {}) {
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    // 概率 @：只作用于第一条（与 reply/at 段一致，后续气泡不再挂 @）。
    const autoAt = (options.autoAt === false || replyToMessageId) ? null : planAutoAtV2(key, kind, messages, atUserId, options.quoted);
    // 概率语音：同样只作用于"单条文本回复"。
    // 注意它**不能与 @ 同时生效**：record 段不承载 at。
    // 也不能和 reply 同气泡（QQ 客户端实测语音不渲染）。所以带 replyToMessageId
    // 的回复仍然可以掷中语音，但语音单发；引用语义由端点内部保留。
    const ttsPlan = (autoAt || atUserId) ? null : planTtsV2(key, messages, options);
    if (ttsPlan) {
      sendChain = sendChain.then(async () => {
        const r = await sendAsVoice(key, ttsPlan.text, ttsPlan);
        if (r.ok) { sent.push({ text: ttsPlan.text, isVoice: true }); return; }
        // 回退：语音没发成，退回普通文字发送（下面这段与常规路径一致）
        try {
          await onebotSend(kind, id, ttsPlan.text, replyToMessageId, null);
          sent.push(ttsPlan.text);
        } catch (error) {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        }
      });
      return sendChain.then(() => {
        if (failed.length > 0) {
          const err = new Error(`QQ 发送失败 ${failed.length}/1 条：${failed[0]?.message ?? '未知错误'}`);
          err.sent = sent.slice();
          throw err;
        }
        return sent;
      });
    }
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      // 模型自己传了 atUserId 时用它；否则用桥接掷出的 autoAt（仅第一条）。
      const useAt = i === 0 ? (atUserId ?? autoAt?.userId ?? null) : null;
      sendChain = sendChain
        .then(async () => {
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => sleep(d));
      }
    }
    return sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (currentMode === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      // 群内不再提示（会暴露内部机制）；只私聊管理员，原样带上被拦的正文便于判断误判。
      notifyOwnerOfError(key, '安全策略拦截了一条回复', String(text ?? ''), {
        原因: hasKnownToken ? '含会话令牌' : '疑似包含敏感信息（路径/凭据）',
        处置: '该条回复未发出，群友看不到'
      });
      return false;
    }
    await sendToQQ(key, text);
    return true;
  }

  // 视觉模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次。
  // 四种 QQ 模式共用 DSH 会话，统一强制使用 DeepSeek-V4-Flash-Vision-Exp + max 思考强度。
  const visionModelAppliedSessions = new Set();
  async function ensureVisionModel(sessionId) {
    if (visionModelAppliedSessions.has(sessionId)) return;
    const provider = String(cfg.dsh?.provider || 'deepseek-official');
    const model = String(cfg.dsh?.model || 'deepseek-v4-flash-vision-exp');
    // reasoningEffort：未配置（键不存在）时沿用旧的 max 兜底；显式留空（""）表示不指定该字段——
    // 供不支持 reasoning 参数的 provider 使用（例如本地 OpenAI 兼容端点），传了会被判 model-unavailable。
    const effortRaw = cfg.dsh?.reasoningEffort;
    const effort = effortRaw === undefined || effortRaw === null ? 'max' : String(effortRaw).trim();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const selectArgs = { sessionId, provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
        const result = unwrap(await api.sessions.selectModel(selectArgs), 'session.selectModel');
        visionModelAppliedSessions.add(sessionId);
        log(`已设置会话视觉模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
        return;
      } catch (error) {
        log(`设置会话视觉模型失败 ${sessionId}（第 ${attempt}/2 次）: ${error?.message ?? error}`);
        if (attempt < 2) await sleep(1000);
      }
    }
  }

  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (epoch !== sessionEpoch) {
        delete state.sessions[key];
        if (reverse.get(existing) === key) reverse.delete(existing);
        try { await api.workspace.archiveSession({ sessionId: existing }); } catch {}
      } else {
        await ensureVisionModel(existing);
        return existing;
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      for (const withPreset of [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && cfg.workspaceTitle) {
            await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          const preset = modePreset(key, currentMode, cfg);
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        log(`归组创建失败（${lastError?.message}），回退无参创建`);
        const value = unwrap(await api.sessions.create({}), 'session.create');
        sessionId = value.sessionId;
      }
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== sessionEpoch) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await api.workspace.archiveSession({ sessionId }); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      reverse.set(sessionId, key);
      saveState();
      await ensureVisionModel(sessionId);
      log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（启动时从网关获取，识别"被提到"用）
  let selfQQ = '';               // 机器人自身 QQ（启动时获取；好友列表里剔除自己用）
  // 账号昵称的原始大小写。selfNickname 为了旧的宽松比较被转成了小写，
  // 但别名判断需要原样（群名片/昵称里的大小写是用户能看到的）。
  let selfDisplayName = '';
  // 机器人在**每个群**的群名片。@ 时 QQ 显示的是群名片，不是账号昵称。
  //
  // 2026-10-22 事故（group:100001005）：账号昵称是 `dsh`，群名片是 `?！哦鲸鲸  ? !`，
  // 而别名表只放了 `dsh`，于是所有 `@?！哦鲸鲸  ? !` 都不算"在叫它"，
  // 自动@ 退化成模糊字面匹配，把票投给了只顺口说了句「大肥鱼可爱」的人。
  const selfCardCache = new Map(); // groupId -> { card, at }
  const selfCardPending = new Map(); // groupId -> Promise（合并并发查询）
  const SELF_CARD_TTL_MS = 10 * 60 * 1000;
  function selfCardOf(key) {
    if (!key || !key.startsWith('group:')) return '';
    const hit = selfCardCache.get(key.slice(6));
    return hit && Date.now() - hit.at < SELF_CARD_TTL_MS ? hit.card : '';
  }
  async function ensureSelfCardV2(key) {
    if (!key || !key.startsWith('group:') || !selfQQ) return '';
    const gid = key.slice(6);
    const hit = selfCardCache.get(gid);
    if (hit && Date.now() - hit.at < SELF_CARD_TTL_MS) return hit.card;
    if (selfCardPending.has(gid)) return selfCardPending.get(gid);
    const p = (async () => {
      try {
        const name = await resolveGroupMemberName(gid, selfQQ);
        if (name) selfCardCache.set(gid, { card: String(name), at: Date.now() });
        return name ? String(name) : '';
      } catch {
        return '';
      } finally {
        selfCardPending.delete(gid);
      }
    })();
    selfCardPending.set(gid, p);
    return p;
  }
  // 判定"是不是在叫它"用的别名集合。自动@ 与唤醒提示（findCallersV2）必须**同源**，
  // 否则会出现"提示里说 A 在叫它、自动@ 却选了 B"这种自相矛盾。
  // primary = 真正的名字（角色名/账号昵称/群名片），匹配时可以从正文里剔除；
  // keywords = 唤醒关键词，可能是 DS/R1 这类短词，只剔除 `@关键词` 写法。
  function botAliasNamesV2(key, st) {
    const role = readRoleState().role;
    const primary = [...new Set([
      selfCardOf(key),
      selfDisplayName,
      selfNickname,
      role
    ].map((x) => String(x ?? '').trim()).filter(Boolean))];
    const keywords = [...new Set(
      (Array.isArray(st?.wakeConfig?.triggers?.keywords) ? st.wakeConfig.triggers.keywords : [])
        .map((x) => String(x ?? '').trim()).filter(Boolean)
    )];
    return { primary, keywords, all: [...new Set([...primary, ...keywords])] };
  }
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };

  // ── 上下文持久化（Phase 0/1）运行时状态 ───────────────────────────────
  // episode 摘要走本地模型网关；失败只记日志，不影响聊天。
  let contextSummarizer = null;
  let contextSweepRunning = false;
  const episodeInFlight = new Set();
  const contextMetrics = new Map(); // key -> { lastPromptChars, lastMemoryChars, lastEpisodeAt, ... }
  const contextPendingCache = new Map(); // key -> { lastSeq, lastAt, journalBytes, at, count }
  const sessionSizeCache = new Map(); // sessionId -> { bytes, at }

  // Phase 2：群名 / QQ 昵称缓存。context-status 每 30 秒轮询，名称每 5 分钟刷新；
  // 查不到名称时前端继续显示群号/QQ 号，不影响记忆功能。
  let contextNameCache = { groups: new Map(), privates: new Map(), at: 0 };
  let contextNameRefresh = null;
  const CONTEXT_NAME_TTL_MS = 5 * 60 * 1000;

  async function refreshContextNames(force = false) {
    if (!force && Date.now() - contextNameCache.at < CONTEXT_NAME_TTL_MS) return contextNameCache;
    if (contextNameRefresh) return contextNameRefresh;
    contextNameRefresh = (async () => {
      const next = {
        groups: new Map(contextNameCache.groups),
        privates: new Map(contextNameCache.privates),
        at: Date.now()
      };
      try {
        const list = await withTimeout(bot.getGroupList({ noCache: true }), 8000, '获取群列表');
        for (const g of (Array.isArray(list) ? list : (list?.data ?? []))) {
          const gid = String(g?.group_id ?? '').trim();
          if (!gid) continue;
          const name = String(g?.group_name ?? g?.group_remark ?? '').trim();
          if (name) next.groups.set(gid, name);
        }
      } catch (error) {
        log(`[上下文] 获取群名失败（继续用旧缓存）：${error?.message ?? error}`);
      }
      try {
        const list = await withTimeout(bot.getFriendList(), 8000, '获取好友列表');
        for (const f of (Array.isArray(list) ? list : [])) {
          const uid = String(f?.user_id ?? '').trim();
          if (!uid) continue;
          const name = String(f?.nickname ?? f?.remark ?? '').trim();
          if (name) next.privates.set(uid, name);
        }
      } catch (error) {
        log(`[上下文] 获取QQ昵称失败（继续用旧缓存）：${error?.message ?? error}`);
      }
      // 非好友私聊：好友列表里没有，逐个查陌生人资料；失败就保留号码。
      const missing = [...socialV2.conversations.keys()]
        .filter((k) => k.startsWith('private:'))
        .map((k) => k.slice('private:'.length))
        .filter((uid) => uid && !next.privates.has(uid));
      if (missing.length && typeof bot.getStrangerInfo === 'function') {
        await Promise.all(missing.map(async (uid) => {
          try {
            const info = await withTimeout(bot.getStrangerInfo(uid), 3000, `查QQ资料 ${uid}`);
            const name = String(info?.nickname ?? info?.remark ?? '').trim();
            if (name) next.privates.set(uid, name);
          } catch { /* 非好友查不到就显示号码 */ }
        }));
      }
      contextNameCache = next;
      contextNameRefresh = null;
      return contextNameCache;
    })().catch((error) => {
      contextNameRefresh = null;
      log(`[上下文] 名称缓存刷新失败：${error?.message ?? error}`);
      return contextNameCache;
    });
    return contextNameRefresh;
  }

  function contextDisplayName(key) {
    const idx = String(key ?? '').indexOf(':');
    if (idx <= 0) return '';
    const kind = key.slice(0, idx);
    const id = key.slice(idx + 1);
    return String((kind === 'group' ? contextNameCache.groups : contextNameCache.privates).get(id) || '');
  }

  function contextCfg() {
    return { ...DEFAULT_CONTEXT_MEMORY, ...(cfg.socialV2?.contextMemory || {}) };
  }

  function ensureContextSummarizer() {
    if (contextSummarizer) return contextSummarizer;
    const c = contextCfg();
    if (c.enabled === false) return null;
    contextSummarizer = createSummarizer({
      baseUrl: c.gatewayUrl,
      // 网关默认允许本机无鉴权；有 key 就带上（兼容需要鉴权的部署）
      apiKey: c.apiKey || process.env.LOCAL_MODEL_API_KEY || '',
      model: c.model,
      timeoutMs: c.timeoutMs,
      log
    });
    return contextSummarizer;
  }

  /** 统计“当前实际拿得到”的待总结消息数（journal + recentMessages 去重）。 */
  function countContextPendingV2(key, st, lastSeq, lastAt) {
    const seq = Number(lastSeq) || 0;
    const at = Number(lastAt) || 0;
    const js = journalStats(STATE_DIR, key);
    const hit = contextPendingCache.get(key);
    if (hit && hit.lastSeq === seq && hit.lastAt === at && hit.journalBytes === js.bytes
        && Date.now() - hit.at < 10000) return hit.count;
    const j = loadContextMessages(STATE_DIR, key, {
      afterSeq: seq,
      afterTime: at,
      limit: 0
    });
    const r = (st.recentMessages || []).filter((m) => {
      if (!m) return false;
      if (m.isSelf) return (Number(m.time) || 0) > (Number(lastAt) || 0);
      return (Number(m.seq) || 0) > (Number(lastSeq) || 0);
    });
    const keyOf = (m) => (m?.messageId != null && String(m.messageId) !== 'null')
      ? `id:${m.messageId}`
      : ((Number(m?.seq) || 0) > 0 ? `seq:${m.seq}` : `t:${Number(m?.time) || 0}:${m?.sender || ''}:${m?.text || m?.plain || ''}`);
    const set = new Set();
    for (const m of [...r, ...j]) if (m) set.add(keyOf(m));
    const count = set.size;
    contextPendingCache.set(key, { lastSeq: seq, lastAt: at, journalBytes: js.bytes, at: Date.now(), count });
    return count;
  }

  /**
   * 立即为某个会话生成一条 episode。
   * 正常由定时器调用；force=true 时忽略"消息还不够"的条件（控制台手动触发）。
   */
  async function makeEpisodeNow(key, { force = false } = {}) {
    const c = contextCfg();
    if (c.enabled === false) return { ok: false, error: '上下文记忆未启用' };
    if (!/^(group|private):\d+$/.test(String(key || ''))) return { ok: false, error: 'key 非法' };
    const st = getSocialV2State(key);
    const eps = loadEpisodes(STATE_DIR, key, 3);
    const last = eps[eps.length - 1] || null;
    // Phase 2：journal 是完整流，recentMessages 补旧会话/迁移期缺失段。
    // 两者按 messageId/seq 去重后合并；recentMessages 只有 100 条，
    // 群聊突发时中间段只能靠 journal 补，旧会话没有 journal 时仍用 recent。
    const lastSeq = Number(last?.toSeq) || 0;
    const lastAt = Number(last?.endAt) || 0;
    const journalPending = loadContextMessages(STATE_DIR, key, {
      afterSeq: lastSeq,
      afterTime: lastAt,
      limit: 0
    });
    const recentPending = (st.recentMessages || []).filter((m) => {
      if (!m) return false;
      if (m.isSelf) return (Number(m.time) || 0) > lastAt;
      return (Number(m.seq) || 0) > lastSeq;
    });
    const msgKey = (m) => (m?.messageId != null && String(m.messageId) !== 'null')
      ? `id:${m.messageId}`
      : ((Number(m?.seq) || 0) > 0 ? `seq:${m.seq}` : `t:${Number(m?.time) || 0}:${m?.sender || ''}:${m?.text || m?.plain || ''}`);
    const dedupe = (arr) => {
      const map = new Map();
      for (const m of arr) {
        if (!m) continue;
        const k = msgKey(m);
        if (!map.has(k)) map.set(k, m);
      }
      return [...map.values()].sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
    };
    const pending = dedupe([...recentPending, ...journalPending]);
    let check = shouldMakeEpisode({ messages: pending, lastEpisode: null, cfg: c });
    if (!check.yes && force) {
      const journalAll = loadContextMessages(STATE_DIR, key, { limit: Math.max(10, (Number(c.episodeInputLimit) || 60) * 2) });
      const all = dedupe([...(st.recentMessages || []).slice(-Math.max(10, (Number(c.episodeInputLimit) || 60) * 2)), ...journalAll])
        .slice(-Math.max(5, Number(c.episodeInputLimit) || 60));
      if (all.length < 3) return { ok: false, error: '消息太少（<3 条）' };
      const first = all[0];
      const lastMsg = all[all.length - 1];
      check = {
        yes: true,
        reason: 'manual',
        pendingCount: all.length,
        messages: all,
        fromSeq: Number(first.seq) || 0,
        toSeq: Number(lastMsg.seq) || 0,
        startAt: Number(first.time) || 0,
        endAt: Number(lastMsg.time) || 0
      };
    }
    if (!check.yes) return { ok: false, error: check.reason || 'not-enough', pending: check.pendingCount || 0 };
    if (episodeInFlight.has(key)) return { ok: false, error: '正在生成中' };
    const summarizer = ensureContextSummarizer();
    if (!summarizer) return { ok: false, error: '摘要器不可用' };
    episodeInFlight.add(key);
    const started = Date.now();
    try {
      const prompt = buildEpisodePrompt({
        messages: check.messages,
        previousEpisode: last,
        maxChars: c.promptMaxChars
      });
      let text = await summarizer(prompt);
      let parsed = parseEpisode(text, { redact: redactSensitiveText });
      if (!parsed) {
        // 首次 JSON 失败时用更短的窗口重试一次：模型偶尔会先写很长的
        // reasoning 或在长记录里跑题，30 条通常能把格式拉回来。
        log(`[上下文] ${key} 摘要 JSON 解析失败（${text.length} 字），用短窗口重试`);
        try {
          const shortPrompt = buildEpisodePrompt({
            messages: (check.messages || []).slice(-30),
            previousEpisode: last,
            maxChars: 3000
          });
          text = await summarizer(shortPrompt);
          parsed = parseEpisode(text, { redact: redactSensitiveText });
        } catch (retryError) {
          log(`[上下文] ${key} 摘要重试失败：${retryError?.message ?? retryError}`);
        }
      }
      if (!parsed) {
        log(`[上下文] ${key} 摘要输出仍无法解析：${String(text).replace(/\s+/g, ' ').slice(0, 160)}`);
        return { ok: false, error: '模型输出无法解析为 JSON' };
      }
      // seq 只取真实的入站消息；self 消息没有 seq，别让 0 覆盖边界。
      const inbound = (check.messages || []).filter((m) => m && !m.isSelf && Number(m.seq) > 0);
      const fromSeq = Number(inbound[0]?.seq) || Number(check.messages?.[0]?.seq) || 0;
      const toSeq = Number(inbound[inbound.length - 1]?.seq) || Number(check.messages?.[check.messages.length - 1]?.seq) || 0;
      const ep = {
        ...parsed,
        fromSeq,
        toSeq,
        startAt: check.startAt,
        endAt: check.endAt,
        messageCount: Array.isArray(check.messages) ? check.messages.length : 0,
        createdAt: Date.now(),
        source: 'auto'
      };
      appendEpisode(STATE_DIR, key, ep, c.episodeKeep);
      // Phase 2：把人物/事实/线索合并进长期记忆。
      try {
        mergeEpisodeToMemory(STATE_DIR, key, ep, {
          keepPeople: c.longTermKeepPeople,
          keepFacts: c.longTermKeepFacts,
          keepThreads: c.longTermKeepThreads
        });
      } catch (error) {
        log(`[上下文] ${key} 长期记忆合并失败：${error?.message ?? error}`);
      }
      const m = contextMetrics.get(key) || {};
      m.lastEpisodeAt = ep.createdAt;
      m.lastEpisodeSummary = ep.summary;
      m.lastEpisodeError = '';
      contextMetrics.set(key, m);
      log(`[上下文] ${key} 生成情节摘要（${check.reason}，${ep.messageCount} 条，${Date.now() - started}ms）`);
      appendActivity(`${key} [上下文] 情节摘要：${String(ep.summary).slice(0, 40)}`);
      return { ok: true, episode: ep };
    } catch (error) {
      const msg = String(error?.message ?? error);
      const m = contextMetrics.get(key) || {};
      m.lastEpisodeError = msg.slice(0, 200);
      contextMetrics.set(key, m);
      log(`[上下文] ${key} 生成情节摘要失败：${msg}`);
      return { ok: false, error: msg };
    } finally {
      episodeInFlight.delete(key);
    }
  }

  /** 定时扫描所有会话；串行调用，避免同时打满网关。 */
  async function contextSweep() {
    if (contextSweepRunning) return;
    const c = contextCfg();
    if (c.enabled === false) return;
    contextSweepRunning = true;
    try {
      const now = Date.now();
      const maxRun = Math.max(1, Number(c.sweepMaxPerRun) || 6);
      const activeMs = Math.max(0, Number(c.sweepActiveWithinMs) || 0);
      // Phase 2 公平性：按“最久没总结 / 积压最多”排队，而不是永远按最近活跃取前 6。
      // 旧逻辑下最热闹的几个群每次都占满名额，安静会话永远轮不到。
      const candidates = [];
      for (const [key, st] of socialV2.conversations.entries()) {
        if (!/^(group|private):\d+$/.test(key)) continue;
        if (activeMs && (Number(st.lastIncomingAt) || 0) < now - activeMs) continue;
        const stats = contextStats(STATE_DIR, key);
        const lastSeq = Number(stats.lastEpisodeSeq) || 0;
        const pending = countContextPendingV2(key, st, lastSeq, Number(stats.lastEpisodeEndAt) || 0);
        if (!pending) continue;
        candidates.push({
          key,
          pending,
          lastEpisodeAt: Number(stats.lastEpisodeAt) || 0,
          lastIncomingAt: Number(st.lastIncomingAt) || 0
        });
      }
      const keys = candidates
        .sort((a, b) => (a.lastEpisodeAt - b.lastEpisodeAt)
          || (b.pending - a.pending)
          || (b.lastIncomingAt - a.lastIncomingAt))
        .slice(0, maxRun)
        .map((x) => x.key);
      for (const key of keys) {
        await makeEpisodeNow(key);
        await sleep(300);
      }
    } finally {
      contextSweepRunning = false;
    }
  }

  /** DSH 会话文件大小（压缩后），控制台用；按 60 秒缓存。 */
  function sessionFileBytes(sessionId) {
    if (!sessionId) return 0;
    const hit = sessionSizeCache.get(sessionId);
    if (hit && Date.now() - hit.at < 60000) return hit.bytes;
    let bytes = 0;
    try {
      const root = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'sessions');
      for (const proj of fs.readdirSync(root)) {
        try {
          const p = path.join(root, proj, sessionId, 'session.jsonl.zstd');
          bytes = fs.statSync(p).size;
          if (bytes) break;
        } catch { /* 不在这个项目目录 */ }
      }
    } catch { /* 没有 DSH 目录 */ }
    sessionSizeCache.set(sessionId, { bytes, at: Date.now() });
    return bytes;
  }

  // ── B 站「自己刷」运行时状态 ──────────────────────────────────────────────
  // 记忆是全局的（跨群共用），所以放在 socialV2.conversations 之外。
  let biliMem = null;
  let biliTimer = null;
  let lastBiliBrowseAt = 0;
  let biliNextDelay = 0;
  let biliScheduledAt = 0;  // 本次调度的起点时间（用于算"还有多久"）
  let biliBrowsing = false;  // 防重入：上一轮还没看完就不叠加
  // 控制台显示用：当前正在刷到哪一步 + 最近一次看了什么（进程内状态，不落盘）
  const biliBrowseState = { phase: '', startedAt: 0, video: null, key: '' };
  let lastBiliWatch = null;
  // 最近看过的视频元信息（bvid -> info），用于在模型调 qq_bili_record 时补全简介。
  //
  // 为什么需要（2026-10-19 用户反馈「读取简介信息，不然问他相关信息回答不出来」）：
  // 模型只能看到画面和标题，它手里**没有**简介原文，无法作为参数传回来。
  // 如果不在这里补，记忆里就只有模型自己编的一句 notes。
  // 只保留最近 30 条，进程内即可（重启丢失也能接受——真正长期的是 bili-memory.json）。
  const biliInfoCache = new Map();
  // B 站凭据（只从 state/bili-auth.json 读）。启动时加载一次，
  // 不在日志/返回值里出现任何 cookie 内容。
  let biliAuth = { cookie: '', loaded: false, reason: '未初始化' };
  // 本地语音转写引擎（可选）。null = 未启用/初始化失败。
  // 只用于"字幕拿不到时听音轨"，不影响任何其它功能。
  let asrEngine = null;
  const voiceTranscriptCache = new Map(); // messageId/file/url -> 转写文本
  // 语音合成引擎（可选，GPT-SoVITS）。null = 未启用/探测失败。
  // 可插拔：装不上就是不存在，所有调用点都会自动跳回文字。
  let ttsEngine = null;
  // 上次搜索用的关键词（控制台展示"它在找什么"用）
  let lastBiliSearchKeyword = '';
  // 上次在群里推荐视频的时间（分享间隔控制）
  let lastBiliShareAt = 0;
  // 「自己刷」两段式观看：第一段让模型做初判，这里登记等待者（sessionId -> {token, resolve}）。
  // 事件流收到该 session 的回合结束时回填文本，见 judgeBiliScan 的说明。
  const biliJudgeWaiters = new Map();
  // 初判专用 turn 收集器（sessionId -> collector）。为什么不复用 `collectors`：
  // 那个只在 v2TurnStartAt 有标记时才建，而初判 prompt 是直接投递的、没有标记，
  // 复用它会导致拿不到 turn/end（2026-10-19 实测 liked=null 的根因）。
  const biliJudgeCollectors = new Map();
  // GitHub 截图去重：key|url -> 上次发送时间。群友常把同一个链接连发两次，
  // 30 秒内不重复截（截图要起一个 Chrome、花 10 秒左右，重复毫无意义）。
  const gitHubShotTimes = new Map();
  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
  // 新规则：每次设置潜水/下一次唤醒前，AI 必须先进入一次“沉睡前观察”（qq_wait_for_messages(timeoutMs=preSleepWaitMs)）。
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function preSleepWaitBlockedV2(st, key = '') {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    // 活跃群死锁兜底：本回合已经发过言、且距最后一次发言已过 30 秒，就不再要求
    // 连续 60 秒静默。否则群里一直有人说话 → 观察窗口永远重置 → 模型只能反复 wait，
    // 单个回合拖到几十分钟（2026-10-23 group:100001005 实测 24 分钟）。
    if (key) {
      const sid = state.sessions[key];
      const turnStart = sid ? (Number(v2TurnStartAt.get(sid)) || 0) : 0;
      const lastReply = Number(st.lastAiReplyAt) || 0;
      const graceMs = Math.max(0, Math.min(300000, Math.round(Number(w.preSleepReplyGraceMs) || 30000)));
      if (turnStart && lastReply >= turnStart && now - lastReply >= graceMs) return false;
    }
    return true;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        // 明确引用回复过的消息 seq。mark_read 只认这个集合，
        // 不再按"回复时间晚于 @ 时间"推断——那会把同一批里没答的 @ 一起标掉。
        answeredSeqs: [],
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        crawlTimes: [],
        stickerAddTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        // 本轮唤醒的未读水位（唤醒时未读里最大的 seq）。mark_read 只清 ≤ 它的消息，
        // 水位之后新到的不动。0 = 没有在途回合（如启动初期）。
        wakeSeqAt: 0,
        lastComplyRollAt: 0,
        pendingComply: null,
        complyTimes: [],
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {},
        // 表情包主动要求的频率账（见 saveSocialV2State 里的说明）
        lastStickerAt: 0,
        recentStickers: [],
        stickerNudgeTimes: []
      };
      KNOWN_AGENT_TOKENS.add(st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  // 注意：引用目标的解析由下面的 resolveReplyTargetV2(st, kind, convId, ref) 统一负责
  //（含 seq→messageId 映射与归属校验）。**不要**在此处再定义一个同名函数——
  // 函数声明提升会让后者覆盖前者，静默废掉原有的解析与校验（曾因此把发送链路打断）。

  function loadSocialV2State() {
    try {
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              triggers: { ...defaultWc.triggers, ...((val.wakeConfig?.triggers) ?? {}) }
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            answeredSeqs: Array.isArray(val.answeredSeqs)
              ? val.answeredSeqs.map(Number).filter(Number.isFinite).slice(-200)
              : [],
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            crawlTimes: Array.isArray(val.crawlTimes) ? val.crawlTimes : [],
            stickerAddTimes: Array.isArray(val.stickerAddTimes) ? val.stickerAddTimes : [],
            // 表情包主动要求的频率账（与 saveSocialV2State 的白名单成对出现：
            // 只存不读 = 重启后限制失效；只读不存 = 一直为 0，等于没限制）
            lastStickerAt: Number(val.lastStickerAt) || 0,
            recentStickers: Array.isArray(val.recentStickers) ? val.recentStickers : [],
            stickerNudgeTimes: Array.isArray(val.stickerNudgeTimes) ? val.stickerNudgeTimes : [],
            pendingWakeMessage: (val.pendingWakeMessage && typeof val.pendingWakeMessage === 'object')
              ? val.pendingWakeMessage
              : null,
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            // 管理员身份判定依赖这两个字段（isOwnerTurn）。
            // 原来**只存不读**：重启后 lastRequesterId 恒为空，管理员的所有
            // 写操作（删表情等）都会被判成"不是管理员"——这本身就让人以为
            // "删不掉"。现在补上读取，并加了 ownerSpokeAt 时间窗。
            lastRequesterId: String(val.lastRequesterId || ''),
            lastRequesterRole: String(val.lastRequesterRole || ''),
            ownerSpokeAt: Number(val.ownerSpokeAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastComplyRollAt: Number(val.lastComplyRollAt) || 0,
            pendingComply: (val.pendingComply && typeof val.pendingComply === 'object') ? val.pendingComply : null,
            complyTimes: Array.isArray(val.complyTimes) ? val.complyTimes : [],
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            wakeSeqAt: Number(val.wakeSeqAt) || 0,
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })()
          };
          // 旧状态没有 answeredSeqs：把“上次发过言之前”的未读视为历史已答，
          // 避免升级后突然把所有旧 @ 都当成待回复；比 lastAiReplyAt 新的仍保持待答。
          if (!Array.isArray(val.answeredSeqs)) {
            st.answeredSeqs = (st.unread || [])
              .filter((m) => m && !m.isSelf && Number(m.time) && st.lastAiReplyAt
                && Number(m.time) <= st.lastAiReplyAt + 5000)
              .map((m) => Number(m.seq))
              .filter(Number.isFinite)
              .slice(-200);
          }
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          KNOWN_AGENT_TOKENS.add(st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        saveSocialV2State();
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State() {
    try {
      const obj = { paused: socialV2.paused, conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          answeredSeqs: Array.isArray(st.answeredSeqs) ? st.answeredSeqs.slice(-200) : [],
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          crawlTimes: Array.isArray(st.crawlTimes) ? st.crawlTimes.slice(-200) : [],
          stickerAddTimes: Array.isArray(st.stickerAddTimes) ? st.stickerAddTimes.slice(-200) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          // 最近一条入站消息的发送者：管理员专属工具据此判请求者身份。
          // ⚠️ 这个序列化是**白名单式**的（只写这里列举的字段）——
          // 新加会话字段时必须在这里补一行，否则赋值后会立刻丢失
          // （实测踩过：加了赋值但没加这行，文件里始终没有该字段）。
          lastRequesterId: st.lastRequesterId || '',
          lastRequesterRole: st.lastRequesterRole || '',
          // 管理员最后一次发言的时间：isOwnerTurn 的时间窗判据依赖它。
          // 不持久化的话重启后就没了，管理员刚下的命令会立刻失效。
          ownerSpokeAt: st.ownerSpokeAt || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastComplyRollAt: st.lastComplyRollAt || 0,
          pendingComply: st.pendingComply ?? null,
          complyTimes: Array.isArray(st.complyTimes) ? st.complyTimes.slice(-50) : [],
          lastUnreadSeq: st.lastUnreadSeq || 0,
          // 自动 @ 的额度：冷却与每小时上限都依赖它，必须持久化
          // （否则每次重启都清零，冷却失效 → 可能连着重启连着重启都 @）。
          lastAutoAt: st.lastAutoAt || 0,
          autoAtTimes: Array.isArray(st.autoAtTimes) ? st.autoAtTimes.slice(-100) : [],
          // 表情包主动要求的频率控制（2026-10-22）：
          //   stickerNudgeTimes = "要求过几次"（掷中即记，不论模型是否真发）
          //   lastStickerAt / recentStickers = "真发过"的时间与 id
          // 两笔账分开，是因为"掷中但模型跳过"不该占用真发出的间隔。
          // 不持久化的话每次重启频率限制清零 → 重启几次后可能连着刷表情。
          lastStickerAt: st.lastStickerAt || 0,
          recentStickers: Array.isArray(st.recentStickers) ? st.recentStickers.slice(-10) : [],
          stickerNudgeTimes: Array.isArray(st.stickerNudgeTimes) ? st.stickerNudgeTimes.slice(-100) : [],
          // 繁忙期间暂存的唤醒原因（内存里产生、回合结束后补发）。
          // 不持久化的话**回合中途重启就全丢**：典型场景是群里 @ 它、
          // 它正在处理上一轮 → 记进 pendingWakeReasons → 这时重启/崩溃 → @ 永远不回。
          // 启动补投只兜底"未读还没被 mark_read"的情况，救不了已被标记已读的那些。
          pendingWakeReasons: Array.isArray(st.pendingWakeReasons)
            ? st.pendingWakeReasons.filter((r) => r && typeof r === 'object').slice(-20)
            : [],
          // 繁忙期间触发消息的正文快照：队列里的 seq 会先于回合结束被未读窗口挤掉。
          pendingWakeMessage: (st.pendingWakeMessage && typeof st.pendingWakeMessage === 'object')
            ? st.pendingWakeMessage
            : null,
          // 必须持久化：回合跨重启时水位丢了会导致 mark_read 走保守清空分支，
          // 虽然安全但会清掉本轮刚到的未读，所以能存就存。
          wakeSeqAt: st.wakeSeqAt || 0,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
    } else if (recentAi2m >= 2) {
      hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
    } else if (aiCount >= 5) {
      hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  function formatMemoryV2(st) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
    }
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const names = Object.keys(impressions);
    if (names.length) {
      lines.push('【对群友的印象】');
      for (const name of names.slice(-10)) {
        const im = impressions[name] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        lines.push(`- ${name}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
    }
    return lines.join('\n');
  }

  function appendMemoryV2(st, category, content, extra = {}) {
    if (!st) return;
    const text = redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = redactKnownTokensOnly(String(extra.pendingQuestion)).slice(0, 200);
      } else {
        st.activeTopics.push({
          text: text.slice(0, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'memberImpression') {
      const target = String(extra.target || '').trim();
      if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) return;
      if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
      const old = st.memberImpressions[target] || {};
      const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
      if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));
      st.memberImpressions[target] = {
        traits,
        interactionCount: (Number(old.interactionCount) || 0) + 1,
        lastSeenAt: Date.now()
      };
      const impressionEntries = Object.entries(st.memberImpressions);
      if (impressionEntries.length > 50) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 50; i++) {
          delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
    }
    saveSocialV2State();
  }

  loadSocialV2State();

  function isSocialEnabled() {
    return currentMode === 'reserved' && cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '', groupRole = '', share = null) {
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    // 分享卡片（小红书/B站等）的链接放在文本末尾，200 字硬切会把 xsec_token 切掉。
    // 卡片消息放宽到 1200 字，并单独存 shareUrl，保证模型拿到完整可打开的链接。
    const shareUrl = share?.url ? String(share.url).slice(0, 1200) : '';
    const textLimit = shareUrl ? 1200 : 200;
    arr.push({
      sender,
      text: String(textContent).slice(0, textLimit),
      plain: String(plainText ?? textContent).slice(0, textLimit),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      // 群内身份（owner=群主 / admin=群管理员），与后台管理员 isOwner 分开算。
      groupRole: groupRole || '',
      isGroupOwner: groupRole === 'owner',
      isGroupAdmin: groupRole === 'admin',
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      shareUrl,
      shareCover: share?.cover ? String(share.cover).slice(0, 1200) : '',
      shareTitle: share?.title ? String(share.title).slice(0, 200) : '',
      sharePlatform: share?.platform ? String(share.platform).slice(0, 40) : '',
      time: Date.now()
    });
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: String(textContent).slice(0, 200), plain: String(plainText ?? textContent).slice(0, 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  function buildContextBlock(key) {
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${identityTagOf(m)}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    promptQueues.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${identityTagOf(m)}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    return `【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = currentRoleHint();
    const promptText = buildActiveExitPrompt(key, roleHint);
    scheduleSocialReply(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [] });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      if (!opts.silent) notifyOwnerOfError(key, '消息未被 DSH 接受', errText, { sessionId });
      return { ok: false, error: errText };
    }
    if (accepted.result.value.command?.text && !opts.silent && currentMode !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (entry.queue.length) processPromptQueue(key);
      else promptQueues.delete(key);
    }
  }

  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = randInt(minDelay, maxDelay);
    log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      const timers = social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) social.pendingTimers.delete(key);
      }
      deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    social.pendingTimers.set(key, timers);
  }

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  function socialLoopTick() {
    if (!isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const key of keys) {
      const st = socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(cfg.social?.proactiveProbability ?? 0.2)) {
                enterActive(key);
                const roleHint = currentRoleHint();
                const promptText = buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            social.silentContext.delete(key);
            const promptText = buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              leaveActive(key);
              log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = state.sessions[key];
          if (sid) social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        leaveActive(key);
        log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  function startSocialLoop() {
    if (social.loopTimer) clearInterval(social.loopTimer);
    social.loopTimer = setInterval(socialLoopTick, 5000);
    social.loopTimer.unref?.();
  }

  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${identityTagOf(m)}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = currentRoleHint();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }

  if (isSocialEnabled() || cfg.social?.enabled !== false) {
    startSocialLoop();
  }

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', hint: '' };
  function currentRoleHint() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      const roleFile = path.join(ROOT, 'roles', rs.role + '.md');
      if (!fs.existsSync(roleFile)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      const cacheKey = `${stateStat.mtimeMs}:${roleStat.mtimeMs}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.hint;
      let hint = fs.readFileSync(roleFile, 'utf8');
      // 角色卡整份注入：上限设得足够宽，**超限要留痕**。
      // 原来硬切 6000 字：实测「大肥鱼」6283、「大肥鱼（傲娇版）」6946、「小鲸鱼」7388 都被切尾，
      // 于是末尾整节（表情包体系 / 轻量记忆 / 被问长相时）静默丢失——「禁写外貌」这类约束
      // 恰恰在最后一节，丢了不报错，只在群聊里表现为"模型忽然开始瞎编长相"。
      const ROLE_HINT_MAX = 12000;
      if (hint.length > ROLE_HINT_MAX) {
        log(`⚠️ 角色卡 ${rs.role}.md 超长（${hint.length} 字），已截断到 ${ROLE_HINT_MAX} 字；末尾内容不会进入提示词`);
        hint = hint.slice(0, ROLE_HINT_MAX);
      }
      roleHintCache = { key: cacheKey, hint };
      return hint;
    } catch {
      return '';
    }
  }

  // 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
  // 让二代 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }

  // 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
  // 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
  // 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
  function convertExampleSpacesToComma(line) {
    const chars = Array.from(String(line ?? ''));
    const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t') {
        const prev = chars[i - 1];
        const next = chars[i + 1];
        const prevCjk = !!prev && isCjkLikeChar(prev);
        const nextCjk = !!next && isCjkLikeChar(next);
        const prevBlocked = !!prev && NO_REPLACE.has(prev);
        const nextBlocked = !!next && NO_REPLACE.has(next);
        if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
          out += '，';
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  // 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  function findCjkSpaceWarning(messages) {
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  function currentRoleHintV2() {
    const raw = currentRoleHint();
    if (!raw) return '';
    // 一代仿真模式专用指令整行过滤，避免污染二代工具协议
    const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的一代语义改写成二代语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      // 被引用消息里的**图片/表情段**必须一并统计出来：否则「回复某张图并评论」
      // 这种最常见的用法里，模型只看到 `[引用 某人：[图片]]` —— 这是 resolveReplyInfo
      // 原先的 bug：它只取 sender+text，把图片段丢了，于是模型完全看不到那张图。
      // 这里只统计数量与类型（不下载），具体图片由模型按 messageId 调
      // qq_get_message_images 取（见下面 segmentsToText 里注入的引用提示）。
      const quotedMedia = [];
      for (const seg of (Array.isArray(raw.message) ? raw.message : [])) {
        if (!seg || typeof seg !== 'object') continue;
        const t = seg.type;
        if (t === 'image') {
          const d = seg.data ?? {};
          const file = d.file ? String(d.file) : '';
          const url = d.url ? String(d.url) : '';
          if (file || url) quotedMedia.push({ kind: 'image', ...(file ? { file } : {}), ...(url ? { url } : {}) });
        } else if (t === 'face') {
          const fid = seg.data?.id;
          if (fid != null) quotedMedia.push({ kind: 'face', faceId: String(fid) });
        }
      }
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      // 被引用消息里的**合并转发**：必须把 forward id 提取出来并登记为可见。
      //
      // 事故（2026-10-22）：群友引用了一条「群聊的聊天记录」并问「@大肥鱼装AI 这个是什么」，
      // 机器人答「那条转发鱼打不开，id对不上」。查下来两处都在丢信息：
      //   ① 这里只处理 image/face 段，forward 段被忽略，模型连 id 都拿不到；
      //   ② 即便模型从文本里读到 id，qq_get_forward_msg 还有道白名单
      //      （seenInRecent / seenInUnread / seenForwardIds），而**引用里的转发从来没被登记**，
      //      于是必然 404「不在当前会话可见范围内」。
      // 修法：解析时提取 id、写进 info.forwardIds，并立刻登记到 seenForwardIds。
      // 安全性不变：这个 id 确实来自本会话收到的消息段，属于"本会话可见"。
      const quotedForwardIds = extractForwardIds(Array.isArray(raw.message) ? raw.message : []);
      if (quotedForwardIds.length) {
        // 登记为"本会话已见过"，这样 qq_get_forward_msg 不会被白名单挡掉。
        let set = seenForwardIds.get(keyForKindId(kind, convId));
        if (!set) {
          set = new Set();
          seenForwardIds.set(keyForKindId(kind, convId), set);
        }
        for (const fid of quotedForwardIds) set.add(fid);
        log(`[引用] ${kind}:${convId} 被引用的消息含转发 id=${quotedForwardIds.join(',')}，已登记可见`);
      }
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null,
        // 消息 id 与图片信息：让 caller 能告诉模型「被引用的那条消息里有图，去调工具看」
        messageId: String(messageId),
        media: quotedMedia,
        mediaCount: quotedMedia.length,
        // 被引用消息里的转发 id：让模型知道可以直接 qq_get_forward_msg 读
        forwardIds: quotedForwardIds
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 引用目标的三种合法写法：真实 messageId（非零整数）、本会话 seq（整数）、符号引用（latest/上一条）。
  // 符号引用由 resolveReplyTargetV2 解析成「最近一条别人的消息」，无需模型自己算编号。
  function isSymbolicReplyRef(ref) {
    return /^(latest|last|最新|最新一条|上一条|上一条消息|最后一条)$/i.test(String(ref ?? '').trim());
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    // 符号引用：模型可以传 latest/last/上一条 之类，由桥接解析成「最近一条别人的消息」。
    // 为什么需要：实测（2026-10-07）唤醒提示里没带 seq 时（probability 触发那轮），
    // 模型会拿它之前见过的 seq 加一 去猜（等消息返回里见过 seq=15360 → 填 15361）。
    // 而 seq 是连续编号，猜错也照样解析到另一条**真实存在**的消息 —— 不报错、静默引用错，
    // 只有群友看出来。给一个不需要数字的引用方式，比继续加强提示词可靠。
    if (isSymbolicReplyRef(refStr)) {
      const target = [...(Array.isArray(st?.recentMessages) ? st.recentMessages : [])]
        .reverse()
        .find((m) => m && !m.isSelf && m.messageId != null);
      if (!target) return null;
      const realId = String(target.messageId);
      log(`[引用] ${kind}:${convId} 符号引用「${refStr}」→ seq=${target.seq} messageId=${realId} 作者=${String(target.sender || '?')}`);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(target.sender || ''),
          text: String(target.text || target.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: target.seq
        },
        messageId: realId
      };
    }
    let found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 活跃群/长回合里，触发消息可能已经被 recentMessages 挤出；从完整 journal 兜底找回，
    // 否则模型引用旧 @ 时会退化成无引用发送（日志：解析引用消息失败: message not found）。
    if (!found && /^[1-9]\d*$/.test(refStr)) {
      try {
        const journalKey = `${kind}:${convId}`;
        const rows = loadContextMessages(STATE_DIR, journalKey, {
          afterSeq: Math.max(0, Number(refStr) - 1),
          limit: 1
        });
        found = rows.find((m) => m && String(m.seq) === refStr) || null;
        if (found) {
          log(`[引用] ${journalKey} 从完整日志找回 seq=${refStr} → messageId=${String(found.messageId || '')}`);
        }
      } catch { /* journal 不可读时退回原有行为 */ }
    }
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      // 审计：模型按 seq 引用时把「它填的 seq → 实际引到谁」记进日志。
      // seq 在群消息里是连续编号，模型写错一位照样能解析到**另一条真实存在的消息**，
      // 桥接无法从 ref 本身判断对错，只能事后从日志核对（实测存在差 6 条仍静默引用成功的情况）。
      log(`[引用] ${kind}:${convId} 按 seq 引用：seq=${refStr} → messageId=${realId} 作者=${String(found.sender || '?')} 内容=${String(found.text || found.plain || '').slice(0, 40)}`);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = [], groupRole = '', atSelf = false, share = null) {
    // 入站源头拦截：桥接自己发的报错被 QQ 回显时，直接丢弃、不记录、不唤醒。
    // 判据见 error-notifier.js 的 looksLikeBridgeErrorEcho（有专门的回归测试，别在这里另写正则）。
    const echoText = String(plainContent ?? textContent ?? '');
    if (looksLikeBridgeErrorEcho(echoText)) {
      log(`[清理] 丢弃桥接自身报错的回显消息 (${key})：${echoText.slice(0, 60)}`);
      return;
    }
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const safeMedia = Array.isArray(media) ? media.map((m) => ({
      kind: m?.kind === 'face' ? 'face' : 'image',
      file: m?.file ? String(m.file) : undefined,
      url: m?.url ? String(m.url) : undefined,
      faceId: m?.faceId ? String(m.faceId) : undefined
    })).filter((m) => m.kind === 'face' ? !!m.faceId : !!(m.file || m.url)) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const shareUrl = share?.url ? String(share.url).slice(0, 1200) : '';
    // 卡片链接在文本末尾，200 字硬切会把 xsec_token 切掉（实测小红书卡片只剩半截）。
    const textLimit = shareUrl ? 1200 : 200;
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: String(textContent).slice(0, textLimit),
      plain: String(plainContent ?? textContent).slice(0, textLimit),
      tail: String(plainContent ?? textContent).slice(-textLimit),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      // 分享卡片：完整链接/封面/标题单独存一份，模型工具与唤醒提示都能直接拿到。
      shareUrl,
      shareCover: share?.cover ? String(share.cover).slice(0, 1200) : '',
      shareTitle: share?.title ? String(share.title).slice(0, 200) : '',
      sharePlatform: share?.platform ? String(share.platform).slice(0, 40) : '',
      // 入站时从 OneBot 的 at 段直接判定的"@ 了机器人"。比按昵称/群名片猜可靠：
      // 别名表可能缺当前群名片（见 selfCardCache 的说明），而这个字段不会漏。
      atSelf: !!atSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      // 群内身份：owner=群主 / admin=群管理员 / member=普通成员 / ''=私聊或未知。
      // 三个概念必须分清（2026-10-16 用户要求）：
      //   ① isOwner（后台管理员=config.ownerQQ）—— 控制台/管理命令/写操作的权限
      //   ② groupRole='owner'（群主）—— 群里的身份，与①无关（群主未必是后台管理员）
      //   ③ groupRole='admin'（群管理员）—— 群里的身份，与①②都无关
      groupRole: groupRole || '',
      isGroupOwner: groupRole === 'owner',
      isGroupAdmin: groupRole === 'admin',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    // Phase 2：完整消息日志（recentMessages 只有 100 条，突发时会丢中间段）。
    try { appendContextMessage(STATE_DIR, key, msg); } catch { /* 记忆写盘失败不影响收发 */ }
    st.lastIncomingAt = Date.now();
    // 记下「最近一条群友消息是谁发的」——管理员专属工具（如删表情）据此判定
    // 请求者身份。为什么需要：工具调用本身不带"谁在要求"，而 DSH 的每次 prompt
    // 都由某条入站消息触发，所以这条就是本次请求的发起人。
    // 只记非自己的消息（isSelf 的不会走到这里）且带 userId 的。
    if (userId != null && String(userId).trim()) {
      st.lastRequesterId = String(userId).trim();
      // 连群角色一起记：某些能力以后可能要按"群主/群管理员"放行（当前删表情只认后台管理员）。
      st.lastRequesterRole = groupRole || '';
      // 额外记「管理员最后一次说话的时间」。
      //
      // 为什么需要（2026-10-22 用户反馈「删不掉表情包」）：`lastRequesterId` 是
      // **最后一条**入站消息的发送者，而一次 prompt 可能由多条未读触发。
      // 实测时间线：
      //   13:55:48 管理员说「把这个表情包删了」
      //   13:56:06 群友发了个拍一拍 → lastRequesterId 被覆盖成群友
      //   13:56:35 模型这才调用删除工具 → 判成"非管理员"直接拒绝
      // 管理员的合法请求被后续闲聊冲掉了，越热闹的群越容易出这问题。
      // 所以另外记一个时间戳，让 isOwnerTurn 能在时间窗内认出"刚才管理员说过话"。
      const ownerQq = String(cfg.ownerQQ ?? '').trim();
      if (ownerQq && String(userId).trim() === ownerQq) {
        st.ownerSpokeAt = Date.now();
      }
    }
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    saveSocialV2State();
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    // Phase 2：完整消息日志（recentMessages 只有 100 条，突发时会丢中间段）。
    try { appendContextMessage(STATE_DIR, key, msg); } catch { /* 记忆写盘失败不影响收发 */ }
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const raw = list[i];
      const isVoice = !!(raw && typeof raw === 'object' && raw.isVoice === true);
      const bodyText = raw && typeof raw === 'object' ? String(raw.text ?? '') : String(raw ?? '');
      const safeText = redactKnownTokensOnly(bodyText).slice(0, 200);
      // 语音必须留下可识别标记：桥接按概率把文字换成语音时，模型并没有主动
      // 调用 qq_send_voice；如果 recentMessages 里仍记成原文，它下一轮就不知道
      // 自己发的是语音（实测 2026-10-23 group:100001004）。
      const text = (isVoice ? '[语音] ' : '') + safeText;
      const entry = {
        sender: '我',
        text,
        plain: text,
        isVoice,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      };
      st.recentMessages.push(entry);
      // 机器人自己的话也进 journal：episode 需要知道"我回了什么"。
      try { appendContextMessage(STATE_DIR, key, entry); } catch { /* 不影响发送 */ }
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    // 点单判定已消费：本轮已按（或未按）判定产出，留着会污染下一轮的新点单。
    st.pendingComply = null;
    saveSocialV2State();
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  function appendToolLog(entry) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      fs.appendFileSync(TOOL_LOG_FILE, JSON.stringify(safeEntry) + '\n', 'utf8');
      // 防止工具调用日志无限增长：保留最近 2000 行。
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n');
      if (lines.length > 2000) {
        fs.writeFileSync(TOOL_LOG_FILE, lines.slice(-2000).join('\n') + '\n', 'utf8');
      }
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = text.slice(0, 2000) + '…(truncated)';
    return text;
  }

  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return 'private';
    const tr = st.wakeConfig?.triggers ?? {};
    // 顺序必须按 WAKE_PRIORITY 从高到低。`anyMessage` 若放在前面，会把所有
    // @/提问/指定成员/名字/关键词都吞成低优先级的 anyMessage——群一热闹就被
    // 限流丢掉。2026-10-23 群 100001006 实测：owner 的「查下来源」被记成
    // anyMessage@seq7064，之后只剩「唤醒频率超限，跳过」，表现就是 @ 了不理。
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.question && isDirectedAtAi(plainContent)) return 'question';
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    if (tr.nameMention && selfNickname) {
      const lower = String(textContent ?? '').toLowerCase();
      if (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase())) return 'nameMention';
    }
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    if (tr.anyMessage) return 'anyMessage';
    if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';
    return null;
  }

  // ── 群友点单（要求生成内容）的「照做」判定 ─────────────────────────────────
  // 背景：preset 主体性规则明确写了「别人要推荐/要答案/要帮忙时不一定马上给」，
  // 群友点单因此常被挡回。这里由桥接给出**权威的**照做/自由发挥判定，注入唤醒提示，
  // 让模型有依据地服从——概率不能交给模型自报（不可复现，且与主体性规则互相打架）。

  // 点单动词/句式：要求产出内容或执行具体任务，而不是普通闲聊。
  const COMPLY_REQUEST_RE = /(帮我|帮忙|给我|替我|请你|求你|能不能|可不可以|能否|麻烦|拜托|来一[个张段篇首份]|写一?[个张段篇首份下]|生成|画一?[个张幅]|做一?[个张份]|整个|搞个|出个|编个|编一?段|翻译|总结一下|概括|续写|改写|润色|扩写|取个名|起个名|想个|列[个一]|列一下|整理一下|排版|做成|转换成|计算一下|算一下|解释一下|讲讲|介绍一下|推荐一?[个下些]|安利|出个主意|想个办法|写代码|写个函数|写段代码)/;
  // 产出物名词：与上面的动词独立，用于扩大命中（需配合「冲着我来」才判定）。
  const COMPLY_ARTIFACT_RE = /(文案|标题|提纲|大纲|脚本|方案|计划|攻略|清单|列表|表格|代码|函数|正则|周报|日报|总结|摘要|作文|故事|小说|诗|对联|歌词|顺口溜|段子|笑话|谜语|签名|昵称|翻译|字幕|配文|旁白|剧本|台词|人设|设定|封面|海报|logo|图标|邮件|通知|公告|策划|复盘|问卷|试卷|作业|答案)/i;
  // 否定/防御语气：这是在拒绝或吐槽，不是在点单。
  // 刻意不用裸「别/不要/不用」——中文没有词边界，「个别/特别/别的/不用心」会误伤；
  // 只认多字、明确的收回说法。
  const COMPLY_NEGATIVE_RE = /(不用了|不必了|不要了|算了|懒得|凭什么|你又不|又不会|做不到|开玩笑|骗你的|别闹|别搞|别写|别问|别说|别管|别来|你想多了)/;
  // 起手就是祈使句（无 @、无名）——群里指名道姓之外最常见的点单口吻。
  const COMPLY_IMPERATIVE_RE = /^(帮我|帮忙|给我|替我|来一?[个张段篇首份下]|写|生成|画|做|整|搞|出|编|翻|列|总结|概括|续写|改写|润色|扩写|取|起|想|整理|排版|转|计算|算|解释|讲|介绍|推荐|安利)/;
  // 第一人称自述（「我想写代码」「我要做个表」）：在说自己要干嘛，不是点单。
  // 只有同时带了明确的请求标记（帮我/请你/能不能…）才翻回点单。
  const COMPLY_SELF_DESC_RE = /^[我咱](想|要|打算|准备|正在|正|在|去|得|需要|应该|该|准备)/;
  const COMPLY_EXPLICIT_RE = /(帮我|帮忙|给我|替我|请你|求你|麻烦|拜托|能不能|可不可以|能否|可以)/;

  // 这条消息是不是「冲着机器人说的」。@ 了别人、或明显在找别人，就不算。
  function isAimedAtSelfV2(plainContent, event, quoteTargetIsSelf) {
    const s = String(plainContent ?? '').trim();
    const lower = s.toLowerCase();
    const segs = Array.isArray(event?.message) ? event.message : [];
    const selfId = String(event?.self_id ?? '');
    const atSelf = segs.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) === selfId);
    const atOthers = segs.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) !== selfId);
    if (atSelf || quoteTargetIsSelf) return true;
    if (selfNickname && lower.includes(String(selfNickname).toLowerCase())) return true;
    if (atOthers) return false;                                  // 明确 @ 了别人
    if (/(你|您)/.test(s)) return true;                          // 直接对「你」说话
    return COMPLY_IMPERATIVE_RE.test(s);                         // 光是祈使句也认（群里常见的直接点单）
  }

  // 是否属于「点单」：既要有请求/产出物，还要是冲着机器人来的。
  function isContentRequestV2(plainContent, aimedAtSelf) {
    const s = String(plainContent ?? '').trim();
    if (!s || !aimedAtSelf) return false;
    if (s.length > 300) return false;                            // 长文更像群友自己的输出
    if (COMPLY_NEGATIVE_RE.test(s)) return false;                // 拒绝/吐槽语境
    // 第一人称自述且没有明确请求标记 → 在说自己要干嘛，不算点单。
    if (COMPLY_SELF_DESC_RE.test(s) && !COMPLY_EXPLICIT_RE.test(s)) return false;
    // 祈使句起手且带产出物/动作 → 稳定的点单信号（不必再要求产出物名词）。
    if (COMPLY_IMPERATIVE_RE.test(s)) return true;
    return COMPLY_REQUEST_RE.test(s) || COMPLY_ARTIFACT_RE.test(s);
  }

  // 掷骰：同一请求只判一次（结果存 pendingComply，后续唤醒沿用），
  // 带冷却与每小时上限，避免被刷成「有求必应」。
  function rollComplyV2(key, requestText) {
    const st = getSocialV2State(key);
    const cc = cfg.socialV2?.comply ?? {};
    if (cc.enabled === false) return null;
    const now = Date.now();
    const pending = st.pendingComply;
    if (pending && pending.text === requestText && now < (pending.expireAt || 0)) {
      return pending;                                            // 同一请求复用上次判定，别反复掷骰子
    }
    if (st.lastComplyRollAt && now - st.lastComplyRollAt < (Number(cc.cooldownMs) || 0)) {
      return null;                                               // 冷却中：本轮不判定，模型按自主性处理
    }
    const hour = 60 * 60 * 1000;
    const recent = (st.complyTimes || []).filter((t) => now - Number(t) < hour);
    const overCap = Number(cc.maxPerHour) > 0 && recent.filter(Boolean).length >= Number(cc.maxPerHour);
    const base = Math.min(1, Math.max(0, Number(cc.probability) || 0));
    const comply = !overCap && Math.random() < base;
    st.lastComplyRollAt = now;
    st.pendingComply = {
      text: requestText,
      comply,
      roll: Number(base.toFixed(3)),
      at: now,
      expireAt: now + (Number(cc.ttlMs) || 3 * 60 * 1000),
      capped: overCap
    };
    st.complyTimes = [...(st.complyTimes || []).slice(-49), comply ? now : 0];
    saveSocialV2State();
    log(`[reserved2] 点单判定 ${key}：${comply ? '照做' : '自由发挥'}（概率 ${base}${overCap ? '，已触每小时上限' : ''}）：${requestText.slice(0, 40)}`);
    return st.pendingComply;
  }

  // 取最近一条「点单」消息，用于掷骰对象。
  // 从后往前扫：遇到自己发过言就停（说明这单已经处理过了，别再翻旧账）；
  // 中间的非点单闲聊跳过（群友常在点单后插一句话，不该把点单顶掉）。
  function latestOrderV2(st) {
    const list = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const now = Date.now();
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (!m) continue;
      if (m.isSelf) return null;                                     // 已经被回应过
      if (now - (Number(m.time) || 0) > 5 * 60 * 1000) return null;  // 超过 5 分钟的点单不再作数
      if (m.orderText) return m;
    }
    return null;
  }

  // 把判定渲染成注入文本。
  /**
   * 判定「未读里有人在问机器人的 token 用量」，并给出**权威**指令。
   *
   * 为什么由桥接判定，而不是只靠工具描述里的触发词：
   * 实测（2026-10-21 group:100001004）问「你用了多少token」会调工具（6 次成功），
   * 但换种说法——「看看你吃了多少token」「你怎么这么能吃白饭」——**就不调了**，
   * 反而编出「35.27B里prompt占35.25B」，下一条又改口「我这边没有查自己用量的口子」。
   * 模型对没见过的措辞不会自动联想，而群友的说法是开放的，列举永远追不上。
   * 所以：桥接自己认（语义范围写得宽一点），认出来就在提示里点名要求调工具。
   *
   * 判据两段式，必须**同时**满足，避免误判（"token"在别的话题里也常出现）：
   *   ① 有"用量"语义词：token / 用量 / 算力 / 消耗（或"白饭"这类群里常用的代称）
   *   ② 有"数量/询问"语义：多少 / 几 / 用了 / 耗了 / 花了 / 吃了 / 看看 / 统计 / 账单 / 烧
   * 再排除明显不是问它用量的（如"token 是什么""你吃不吃 token"这种玩笑）。
   */
  const TOKEN_ASK_SUBJECT_RE = /(token|token\s*数|用量|算力|白饭)/i;
  const TOKEN_ASK_QUANTITY_RE = /(多少|几[个亿万千]|用了|耗了|花了|吃了|吃掉|看看|查查|统计|账单|消耗|烧了|跑多少|这么能吃|能吃)/;
  const TOKEN_ASK_NOT_RE = /(是什么|啥意思|什么意思|怎么读|单词|英文|你吃不吃|好吃吗)/;
  function buildTokenAskLineV2(st) {
    if (cfg.socialV2?.tools?.tokenReport === false) return '';
    const unread = Array.isArray(st?.unread) ? st.unread : [];
    // 只看最近几条：更早的「问用量」如果已回，会留在未读里造成"每轮都催它发图"。
    const hit = [...unread].reverse().slice(0, 8).find((m) => {
      if (!m || m.isSelf) return false;
      const t = String(m.plain ?? m.text ?? '').trim();
      if (!t) return false;
      if (TOKEN_ASK_NOT_RE.test(t)) return false;
      return TOKEN_ASK_SUBJECT_RE.test(t) && TOKEN_ASK_QUANTITY_RE.test(t);
    });
    if (!hit) return '';
    return `【本轮必须调 qq_token_report】未读里有人在问你的 token 用量（「${String(hit.text || hit.plain || '').slice(0, 40)}」）。
这一轮**先调 qq_token_report(key, token)** 把统计图发出去，再配一句很短的话（「喏，图来了」这类）。
**不许自己估算数字、不许说"我没有查用量的口子"**——你有这个工具，编数字会被图当场打脸。
如果工具返回失败，如实说统计图暂时生成不了并带上原因。\n\n`;
  }

  function buildComplyLineV2(key, st) {
    if (cfg.socialV2?.comply?.enabled === false) return '';
    const order = latestOrderV2(st);
    if (!order) return '';
    const p = rollComplyV2(key, String(order.orderText));
    if (!p) return '';
    if (Date.now() >= (p.expireAt || 0)) return '';
    return p.comply
      ? `【本轮点单判定：照做】群里有人在点单（"${String(p.text).slice(0, 60)}"）。桥接已为你掷出「照做」：这一轮请**直接按要求产出内容**，别再装傻、反问或拒绝。产出要自然、贴群友语感、长度适中；如果对方要的东西你确实给不了（真实图片/文件/联网下载等），就说明给不了，并在能力范围内给一个替代方案。\n\n`
      : `【本轮点单判定：自由发挥】有人在点单（"${String(p.text).slice(0, 60)}"）。桥接掷出的是「不照做」：这轮按你自己的性子来——可以装傻、咸鱼、反问、拒绝，也可以给个离谱答案或只吐槽一句；但**别每次都这样**，同一个人反复求你就别一直晾着。\n\n`;
  }

  // 判定未读里有哪些消息是「在叫机器人」，并按「是否已经答过」分成两组。
  // 别名集合 = 机器人昵称 + 角色名 + 该会话唤醒关键词（如「大肥鱼」这类群友常用的称呼）。
  // 模型自己不一定认得出别名（实测 @大肥鱼 被判成「没人叫我」），所以由桥接权威判定，
  // 既用于唤醒提示（明确告诉它有人在叫），也用于 mark_read 的硬拦截（不许直接已读收尾）。
  //
  // 关键：区分「已答过」与「还没答」。活跃群里同一条 @ 会反复出现在未读里
  // （群消息几分钟就堆满上限，旧消息被挤出而未读里的 @ 仍在），模型每轮都当新问题重答一遍，
  // 实测出现「这条我答过两回了」这种尴尬输出，群友直接问「怎么一直回复同一条」。
  // 判据：该消息的入库时间早于机器人上次发言时间 → 上一轮它已经看过并回过了。
  function findCallersV2(key, st) {
    // 与自动@ 用同一份别名（含当前群的群名片），避免出现
    // "提示说群友B在叫它、自动@ 却选了别人"这种自相矛盾。
    const aliasInfo = botAliasNamesV2(key, st);
    const unreadList = Array.isArray(st?.unread) ? st.unread : [];
    const lastReplyAt = Number(st?.lastAiReplyAt) || 0;
    const callers = unreadList.filter((m) => m && !m.isSelf).filter((m) => {
      const t = String(m.text || m.plain || '');
      if (!t) return false;
      // 拍一拍不算「在叫你」：它不是言语请求，被拍的人也不该被要求必须回应。
      // 而且 appendSocialV2Poke 会把 targetIsSelf 写进 quoteTargetIsSelf，
      // 若把它当成「引用自己」就会让每条拍一拍都触发拦截 —— 实测导致机器人
      // 每次想潜水都被拒、只能反复 wait，回合卡死、群消息全排队（2026-10-01）。
      if (/^\[拍一拍\]/.test(t)) return false;
      // 入站时从 at 段直接判定的结果，最可靠（不依赖别名/群名片是否被查到）
      if (m.atSelf) return true;
      // 引用机器人自己的消息：这是明确在跟你说话
      if (m.quoteTargetIsSelf) return true;
      // @ 它的任一别名
      const lower = t.toLowerCase();
      return aliasInfo.all.some((nm) => lower.includes(`@${nm}`.toLowerCase()));
    });
    // 已答过 = 明确引用回复过的 seq（answeredSeqs）。不再按时间推断：
    // 同一批里回复了 A，不代表比 A 更早/更新的 B 也答过了。旧状态没有
    // answeredSeqs 时走一次时间兜底（仅兼容旧数据/测试），加载时会补种。
    // 实测 2026-10-23 群 100001006：机器人引用回复 seq7150 后，owner 的
    // seq7128「查下来源」仍是未答，但旧时间判据让它被 mark_read 一并标掉。
    const hasAnsweredTracking = Array.isArray(st?.answeredSeqs);
    const answeredSet = new Set(
      (hasAnsweredTracking ? st.answeredSeqs : [])
        .map(Number)
        .filter(Number.isFinite)
    );
    const answered = [];
    const pending = [];
    for (const m of callers) {
      if (hasAnsweredTracking) {
        if (Number.isFinite(Number(m.seq)) && answeredSet.has(Number(m.seq))) answered.push(m);
        else pending.push(m);
      } else {
        const t = Number(m.time) || 0;
        if (lastReplyAt && t && t <= lastReplyAt + 5000) answered.push(m);
        else pending.push(m);
      }
    }
    return Object.assign(callers, { answered, pending });
  }

  function buildWakePromptV2(key, reason) {
    const roleState = readRoleState();
    // 角色卡**正文**要直接进唤醒提示，不能只给一行「请调用 qq_get_prompt 查看」。
    //
    // 曾经的写法只注入角色名，指望模型自己去调 qq_get_prompt 取全文。实测这个指望不成立：
    // 8/31~10/20 共 30 天里 qq_get_prompt 只被调用过 26 次，而群聊唤醒有 7605 次——
    // 也就是说 **99.7% 的回合里模型根本没看过角色卡**，人格只剩「大肥鱼」三个字。
    // 后果是角色卡里最吃细节的指令全线失效，最明显的是表情包：
    //   角色卡「表情是你的主武器，能发就发…多数轮次都该带表情」
    //   vs 通用策略「普通闲聊不用每条都配；大约每 3~5 轮来一张就够」
    // 没有角色卡的强命令时，模型只按通用策略行事，于是几乎不发（10/16 起连续 5 天 send_sticker=0）。
    //
    // 体积可控：角色卡 6~7 KB，唤醒提示原本约 4 KB，加起来仍在模型上下文内；
    // 且 currentRoleHintV2() 已含「一代指令行过滤 + 示例节空格转换」，可直接复用。
    const roleCard = roleState.role ? currentRoleHintV2() : '';
    const roleLine = roleState.role
      ? `【当前角色】${roleState.role}\n\n${roleCard ? roleCard.trim() + '\n\n' : ''}`
      : '';
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    // 功能介绍与角色无关：换人格后仍可用菜单图，文案由同一份能力清单维护。
    const menuLine = cfg.socialV2?.tools?.getFeatureMenu !== false
      ? '【功能介绍】群友询问“你会什么 / 你会啥 / 能干嘛 / 有什么功能 / 功能声明 / 功能菜单 / 功能介绍”时，可用 qq_send_feature_menu(key, token) 直接发送本地缓存的功能图。该图按当前角色和已启用功能生成；发送成功后无需逐条复述或追加未列出的能力，失败时如实说明图片暂时发不了。\n\n'
      : '';
    // Token 用量图：与功能菜单同一条路（桥接渲染并直接发送）。
    // 写进唤醒提示的理由：群友问"用了多少 token"时，模型若不知道有这个工具，
    // 会自己去翻日志或凭印象编数字——那是最糟的结果。
    //
    // ⚠️ 触发词必须写全。实测（2026-10-21 group:100001004）：
    //   问「你用了多少token」→ 调用了工具（6 次成功）；
    //   问「看看你吃了多少token」「你怎么这么能吃白饭」→ **没调用**，
    //   反而编出「35.27B里prompt占35.25B」这种数，下一条又改口
    //   「我这边没有查自己用量的口子」——自相矛盾且全是假的。
    //   根因是旧文案只列了"用了多少/消耗多少/烧了多少"，没有把"吃了/白饭/token 花销"
    //   这些群友口语说法挂钩到工具上。模型对没列出的说法就没有触发联想。
    //
    // 另外两件事一起写明：
    //   ① **绝不允许自己估算或凭印象报数**——错的数字比"我查一下"糟糕得多；
    //   ② 报错时要说"统计图暂时发不了"，不能顺势说"我没有这个能力"（那是谎话）。
    const tokenReportLine = cfg.socialV2?.tools?.tokenReport !== false
      ? '【Token 用量】群友只要在问「机器人自己消耗了多少 token」，**一律调 qq_token_report(key, token)** 生成统计图并发到当前会话。触发说法很多，别只认固定词：'
        + '「用了/耗了/花了/吃了多少 token」「token 用多少了」「今天消耗多少」「这个月烧了多少」「花了多少算力」「吃了多少白饭」「你这么能吃？」「看看你的用量/统计/账单」「今天跑了多少」等，'
        + '只要语义是在问**用量/消耗/花了多少**，都用这个工具。\n'
        + '**绝对不要自己估算、翻日志或凭印象报数字**——你算不准，编出来的数会被图上真实数字当场打脸。'
        + '**也不要说「我没有查用量的口子/这个统计不归我管」**：你有这个工具，说没有是错的。\n'
        + '返回里带与图同源的文字摘要，追问具体数字时照它回答；只有工具真的返回失败时，才如实说「统计图暂时生成不了」并带上原因。\n\n'
      : '';
    // 语音能力：只有 TTS 真可用时才告诉模型"你能发语音"。
    //
    // 这条是必须的，血泪教训（2026-10-22）：之前只做了"桥接按概率把回复换成语音"，
    // 却没写进提示词，群友说「发个语音」时模型答「语音我发不出来呀」——
    // 它说的是实话，因为提示词里从没提过这个能力。
    // **能力不写进提示词，就等于没有**。
    //
    // 注意这里**不能调 v2ToolEnabled()**：那个函数定义在 HTTP 服务器回调内部
    // （bridge.js 约 2766 行），本函数在另一处作用域，直接调会抛
    // `v2ToolEnabled is not defined` 并让**整个唤醒中断**——
    // 实测后果就是"发私聊完全不理人"。同语义直接读 cfg 即可。
    const voiceLine = (ttsEngine && ttsEngine.available() && cfg.socialV2?.tools?.sendVoice !== false)
      ? '【语音】你能发语音（qq_send_voice）。群友明确要听声音时（「发个语音」「说句听听」「用语音回我」）就调它，'
        + '念一句自己组织的口语（≤140 字）。日常聊天不要主动发——语音比文字吵。'
        + '发完不要再复述同一句话。发不出来（比如正在加载）就如实说，改发文字。\n\n'
      : '';
    // 短期/人工记忆（activeTopics / pendingThoughts / memberImpressions）
    const memoryBase = formatMemoryV2(st);
    // Phase 1/2：长期情节记忆（episodes）+ 长期人物/事实/线索 + DSH 压缩摘要兜底。
    // 两段分开拼，避免 formatMemoryV2 的【】小节被覆盖。
    let memoryPack = '';
    try {
      const cm = contextCfg();
      const episodes = loadEpisodes(STATE_DIR, key, 3);
      const compactions = loadCompactions(STATE_DIR, key, 1);
      const longTerm = loadLongTermMemory(STATE_DIR, key);
      memoryPack = formatMemoryPack({
        episodes,
        compactions,
        longTerm,
        budgetChars: cm.memoryPackChars
      });
      const m = contextMetrics.get(key) || {};
      m.lastMemoryChars = memoryPack.length;
      contextMetrics.set(key, m);
    } catch (error) {
      log(`[上下文] 读取记忆包失败：${error?.message ?? error}`);
    }
    const memoryText = [memoryBase, memoryPack].filter(Boolean).join('\n');
    const memoryLine = memoryText ? `${memoryText}\n\n` : '';
    // 注意：黑话表不在这里注入，deliverPromptNow 的 withSlangContext 会统一注入，
    // 避免唤醒 prompt 出现两份黑话表。
    const participationText = formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\n\n` : '';
    const antiAiLine = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。\n\n';
    // 元信息防泄漏：这条提示里的所有【】小节（状态/唤醒/令牌/策略/记忆/参与度）都是
    // 给你看的内部调度信息，不是可以拿去说的内容。早期没写这句，模型会把「你别重复回答」
    // 「这条已经交代过了」这类内部指令当台词发到群里（实测群友收到的原话：
    // 「芙老师那句 666 我收到了，这回不接第二遍」「那条我上一条已经交代过了，不再补一遍」），
    // 看起来非常出戏。后台提醒通道早有同类约束，唤醒通道漏了，这里补上。
    const metaLine = '【内部信息不外泄】下面所有【】里的内容（状态、唤醒原因、令牌、策略、记忆、参与度等）都是你内部参考，不是台词。绝对不要复述、转述或提及它们，也不要说“我收到指令”“系统提醒我”“这条我答过了”“我不再重复”这类关于自己调度的话——像真人一样只聊群里的事。\n\n';
    const stickerCfg = cfg.socialV2?.sticker ?? {};
    // 表情包：**桥接掷骰决定"这一轮要不要发"**，模型只从给定候选里挑一张。
    //
    // 背景（2026-10-22 用户反馈「依旧极少调用表情包」）：实测 1999 次工具调用里
    // `qq_send_sticker` 只出现 1 次。原来只有软策略提示（"大约每 3~5 轮来一张"），
    // 模型可以永远不选；而且发表情要额外一次工具调用、还不能和文字同气泡，
    // 收益"可有可无"自然被跳过。
    // 改成"桥接要求 + 只给 2~3 个候选"后，模型的选择成本降到最低，
    // 而频率由桥接控制（不会忽多忽少）。
    const stickerPlan = planStickerV2(key, st);
    if (stickerPlan) {
      // 记一行：出问题时能立刻区分"没掷中"和"掷中了但模型没发"
      log(`[表情] ${key} 本轮要求发一张（语气=${stickerPlan.moodLabel}，候选 ${stickerPlan.picks.length} 个）`);
    }
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? (stickerPlan
        ? `${buildStickerNudge(stickerPlan)}\n\n`
        : `${buildStickerStrategyHint()}\n${buildStickerContext(stickerEntries, stickerCfg.promptMaxStickers ?? 8)}\n\n`)
      : '';
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    const proactiveLine = '【积极性】不要习惯性潜水：群里有你能接的话题就主动参与，偶尔插一句别人的话题也很正常；只有确实没话可说、对方已明确结束、或长时间没人说话时才潜水。\n\n';
    const preSleepLine = `【沉睡前强制等待】除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察；短等待（30秒/60秒/180秒）不能代替这次完整观察。若 ${Math.round(preSleepMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。如果返回里带 preSleepWaitRemainingMs，就按剩余时间继续等待。\n\n`;
    // 关键防循环：活跃群里“等 60 秒安静”永远等不到。模型一旦已经发过言，
    // 本回合的任务就完成了；回复检查会自动叫醒它，不需要它抱着 wait 守候。
    const wrapLine = '【回合收尾】本回合已经发过言后，不要再调用 qq_wait_for_messages 守候后续消息；直接结束回合即可，桥接会在 30~45 秒后自动唤醒你做回复检查。只有还没发过言、准备直接潜水时，才需要用一次 qq_wait_for_messages 完成观察。同一个回合最多等 2 次、累计不超过 120 秒，超时桥接会强制收尾。\n\n';

    // 点单判定：桥接掷骰的权威结果，放在最前面（优先级高于自主性规则）。
    const complyLine = buildComplyLineV2(key, st);
    // 有人在问 token 用量：桥接直接认出来并要求调工具，不靠模型自己联想措辞。
    // 位置紧跟 complyLine——都属于"本轮该做什么"的权威指令，要在自主性规则之前。
    const tokenAskLine = buildTokenAskLineV2(st);
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).length} 条`];
    // 「最近一条」带上 seq：这是最常被引用的目标（模型引用上一条别人的话时要用它）。
    // 不给 seq 时模型得去未读列表里自己对号，实测经常串行引用错（差几条地错），
    // 而且错了不报错、只能从群友反应看出来。
    if (lastMsg) {
      const seqTag = lastMsg.seq != null ? `（seq=${lastMsg.seq}）` : '';
      // 【管理员】标记：群里管理员和群友的 sender 都是昵称，光看名字模型认不出谁是管理员
      // （2026-10-15 用户要求「管理员发消息时机器人应该能够认出」）。
      // 这是**客观状态描述**，不是命令——措辞按既有惯例保持中性，避免被当台词复述。
      const ownerTag = identityTagOf(lastMsg);
      // 同样不能只截开头：引用类消息里"真正对你说的话"在末尾（见 findCallers 处注释）。
      const lastText = String(lastMsg.text || lastMsg.plain || '').trim();
      const lastSummary = lastText.length <= 60 ? lastText : `${lastText.slice(0, 24)}…${lastText.slice(-36)}`;
      statusBits.push(`最近一条来自 ${ownerTag}${String(lastMsg.sender || '未知')}${seqTag}：${lastSummary}`);
    }
    if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    // 最近的几条群友发言 + 各自 seq，做成"可引用清单"：
    // 模型要引用比最新更早的某条时，直接从这份清单里挑一个 seq 抄过去即可，不必翻未读。
    const recentOthers = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])]
      .filter((m) => m && !m.isSelf && m.seq != null)
      .slice(-4);
    if (recentOthers.length > 1) {
      const list = recentOthers
        .map((m) => `seq=${m.seq} ${identityTagOf(m)}${String(m.sender || '某人').slice(0, 8)}：${String(m.text || m.plain || '').slice(0, 24)}`)
        .join(' ｜ ');
      statusBits.push(`最近几条（要引用哪条就用它的 seq）→ ${list}`);
    }
    // 分享卡片：文本里的链接可能被摘要截断，这里给完整链接（小红书等站点
    // 少了 xsec_token 会直接打不开）。只取未读里最新的一条，避免提示词膨胀。
    const shareMsg = [...(Array.isArray(st.unread) ? st.unread : [])]
      .reverse()
      .find((m) => m && !m.isSelf && m.shareUrl);
    if (shareMsg) {
      statusBits.push(`分享链接（${shareMsg.sharePlatform || '卡片'}，seq=${shareMsg.seq}）：${shareMsg.shareUrl}`);
    }
    // 把「你最近说过什么」明确列出来：群消息密集时，模型看不到自己的发言记录，
    // 会把未读里早前的 @ 当新问题重答（实测「这条我答过两回了」）。
    // 措辞保持中性（不给命令口吻），避免被当成台词复述出去。
    const myRecent = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])]
      .filter((m) => m && m.isSelf)
      .slice(-3);
    if (myRecent.length) {
      const mine = myRecent.map((m) => `「${String(m.text || m.plain || '').slice(0, 30)}」`).join('');
      statusBits.push(`你最近已说过：${mine}`);
    }
    // 「有人在叫你吗」必须由桥接明确判定：模型的别名（群名片 / 关键词如「大肥鱼」）
    // 它自己不一定认得出，实测出现过「@大肥鱼 speak」被它判成「没人叫我」而只观察不回应。
    // 同时区分「已答过 / 还没答」：群消息堆满未读上限时，早前的 @ 会一直躺在未读里，
    // 模型每轮都当新问题重答，出现「这条我答过两回了」这种重复输出。
    const calledBy = findCallersV2(key, st);
    if (calledBy.length) {
      // 摘要**不能只截开头**：引用类消息的结构是
      //   "[引用 某人：[图片]]（被引用的这条消息含 1 个图片/表情。要看到它请调用 …）@大肥鱼 超分一下"
      // 真正对你说的话在**末尾**。只取前 30 字，模型看到的是"引用…请调用工具…"，
      // 完全看不到「@大肥鱼 超分一下」→ 实测它输出"没点我"就收尾了（2026-10-21 group:100001033）。
      // 现在：短消息原样给；长消息保留开头 + 末尾（末尾更重要，因为指令通常在那儿）。
      const showText = (m) => {
        const t = String(m.text || m.plain || '').trim();
        if (t.length <= 60) return t;
        return `${t.slice(0, 24)}…${t.slice(-36)}`;
      };
      const fmt = (m) => `${identityTagOf(m)}${String(m.sender || '某人')}：${showText(m)}`;
      // 措辞刻意保持「客观状态描述」而非「命令式强调」：早期用过 🚫/加粗/「绝对不要再回」
      // 这类强措辞，结果模型把它当成台词直接说出口（实测群友收到「芙老师那句 666 我收到了，
      // 这回不接第二遍」「那条我上一条已经交代过了，不再补一遍」——全是复述提示词，非常出戏）。
      // 内部调度信息要写得像背景事实，不要像待办或宣言。
      if (calledBy.pending.length) {
        // 带上 seq：模型要引用"正在回的那条"时需要精确目标。不给 seq 时它会自己挑，
        // 实测挑错过（回复请求 seq=15118 时引用成 15117，引用了上一条别人的图，且不报错）。
        // 这里直接点名"该回哪条"，把 seq 摆到它面前。
        const withSeq = calledBy.pending.slice(-3).map((m) => `${fmt(m)}（seq=${m.seq}）`).join('；');
        statusBits.push(`有人新叫你（${withSeq}）`);
      }
      if (calledBy.answered.length) {
        statusBits.push(`另有 ${calledBy.answered.length} 条 @ 你的是你已回过的（未读列表里的旧消息，无需再处理）`);
      }
    }
    // 繁忙期间入队的消息可能已经被 30 条未读/100 条 recent 挤掉；快照必须显式摆出来。
    // 不补这一句，模型只看到一个 atMention 原因，却找不到原文，典型表现就是“@ 它不回”。
    const pendingMsg = st.pendingWakeMessage;
    if (pendingMsg && typeof pendingMsg === 'object') {
      const ptext = String(pendingMsg.text || pendingMsg.plain || '').trim();
      const pshown = ptext.length <= 800 ? ptext : `${ptext.slice(0, 360)}…${ptext.slice(-360)}`;
      if (pshown) {
        statusBits.push(`此前繁忙期间漏看的消息：${identityTagOf(pendingMsg)}${String(pendingMsg.sender || '某人')}：${pshown}${pendingMsg.seq ? `（seq=${pendingMsg.seq}）` : ''}`);
      }
    }
    // 拍你的事件：`findCallersV2` 刻意把拍一拍排除了（拍不是"叫你"，不该逼它回应），
    // 但那是因为它被当成"喊话"。**拍你**仍然是冲你来的动作，尤其在 pokeSelf 唤醒时，
    // 必须把"谁拍的你"摆到模型眼前——否则它只看到一堆普通未读，顺手 mark_read 就划走了。
    // 实测（2026-10-20）：连续 5 次「戳了戳 你」，模型每轮都只回"这轮先到这儿"。
    const pokeSelfs = (Array.isArray(st.unread) ? st.unread : [])
      .filter((m) => m && !m.isSelf && m.poke?.targetIsSelf)
      .slice(-3);
    if (pokeSelfs.length) {
      // 必须**带上 QQ 号**，否则模型手里没有任何可用目标。
      //
      // 实测事故（2026-10-22 group:100001006）：提示只说「有人戳了你（群友F）」，
      // 而 qq_send_poke 要的是数字号。模型没有群友F的号，就复用上下文里残留下来的
      // 另一个号（群友A 的 100001009），一路拍了十几次，群里被问「怎么一直戳我」。
      // 现在直接把号摆出来，模型不需要记忆、也不需要猜。
      const who = pokeSelfs
        .map((m) => {
          const uid = m.userId != null && /^[1-9]\d*$/.test(String(m.userId)) ? ` QQ=${m.userId}` : '';
          return `${identityTagOf(m)}${String(m.sender || '某人')}${uid}`;
        })
        .join('、');
      statusBits.push(
        `有人戳了你（${who}）——这是冲你来的。回拍就把上面 QQ= 后面的数字原样传给 targetUserId，`
        + `或者直接传 targetUserId="latest"（桥接会解析成最近戳你的人）；不要用记忆里别的号。`
        + `不想回拍就回一句话`
      );
    }
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    // complyLine 紧随令牌行、排在 antiAiLine **之前**：点单判定要压过「拒绝有求必应」的默认倾向。
    // metaLine 放在最前（角色行之后）：防泄漏约束要早于所有内部小节出现。
    const base = roleLine + metaLine + tokenLine + menuLine + tokenReportLine + voiceLine + complyLine + tokenAskLine + antiAiLine + proactiveLine + stickerLine + preSleepLine + wrapLine + statusLine + wakeLine + memoryLine + participationLine;
    if (reason === 'bootstrap') {
      return `${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看你的角色、推荐值、可用工具和当前状态，然后用 qq_set_wake_config 设置你希望如何被唤醒。`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}
原因：你刚刚发送过消息，现在回来检查是否有人回复。
先查看未读消息：有人回了就正常接话；没人回你，不用硬补一句，也不要反复长等待——直接结束本回合即可，桥接会稍后再次检查。只有准备直接潜水、且本回合还没发过言时，才按上面的【沉睡前强制等待】完成一次观察。`;
    }
    if (reason === 'proactiveCheck') {
      return `${base}【主动机会】${key}\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。只要内容自然，就大胆开口；如果实在没话想说，再安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'pokeSelf') {
      return `${base}【唤醒】${key}\n原因：**有人拍了你**（拍一拍的目标就是你）。\n这是冲你来的动作，必须回应——哪怕只回一个拍一拍（qq_send_poke）或一句短话（「诶？」「干嘛」「在」），别装没看见。真人被戳了不会一声不吭。\n**回拍的对象就是上面【此刻状态】里那个戳你的人**：直接用他后面的 QQ= 数字，或者传 targetUserId="latest"，桥接会解析成最近戳你的人；不要凭记忆填一个号（填错就会拍到别人身上）。\n回完就收尾（qq_mark_read 或 qq_set_wake_config），不用长篇大论。`;
    }
    if (reason === 'poke') {
      return `${base}【唤醒】${key}\n原因：群里有人拍了别人（**不是拍你**）。\n看一眼就好：觉得有趣可以接个梗，但别把别人的互动抢过来，也不必每次都说话。没有想说的就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    return `${base}【唤醒】${key}\n原因：${reason}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，可以插一句有趣的/相关的，插不上再看情况潜水；不要一上来就划走。\n【引用：只在必要时用】只有你这条消息指向的人或消息并非最新一条别人的消息，或者你连续的几句话中不同消息指代的是不同的消息或人时，才用 qq_reply 或 qq_send_message 的 replyToMessageId 指向具体那条；其他情况不要引用，别让对方猜。**要引用时优先传 messageId；只记得大概位置就传 seq；不确定目标到底哪条就传 latest**（= 最近一条别人的消息）——不要凭记忆猜编号，猜错的编号照样能解析到另一条真实消息，会静默引用错，只有群友看得出来。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。`;
  }

  function buildWakeReminderPromptV2(key) {
    const roleState = readRoleState();
    // 与主唤醒提示一致：角色卡正文要直接给，不能只给名字。
    // 这条提醒是「模型忘了收尾」时补发的，措辞若只催"收尾"，它会直接
    // qq_set_wake_config 潜水，把还没回的 @ 一起带走。
    const roleCard = roleState.role ? currentRoleHintV2() : '';
    const roleLine = roleState.role
      ? `【当前角色】${roleState.role}\n\n${roleCard ? roleCard.trim() + '\n\n' : ''}`
      : '';
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    // 先看有没有欠着的（未读里有人叫你），有就先回，再谈收尾。
    const pending = Array.isArray(st.unread) ? st.unread.length : 0;
    const pendingLine = pending > 0
      ? `【先别急着收尾】还有 ${pending} 条未读没处理。如果其中有人 @ 你、问你、拍你，**先回应**——用 qq_send_message / qq_reply / qq_send_poke 回完再收尾。没人找你才可以安静收尾。\n\n`
      : '';
    return `${roleLine}${tokenLine}${pendingLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。**如果本回合已经发过言且没有待回 @，直接结束回合即可，不要再用 qq_wait_for_messages 守候**；只有本回合还没发过言、准备直接潜水时，才先按【沉睡前强制等待】完成一次观察。`;
  }

  /**
   * 「自己刷 B 站」的调度循环。
   *
   * 为什么要单独一条循环而不是挂进社交唤醒：
   *   社交唤醒是"群里有动静"驱动的；自己刷是"机器人自己的空闲时间"，与群消息无关。
   *   混在一起会让刷视频和回复群友抢同一个唤醒通道，且每日额度的记账也变得含糊。
   *
   * 节奏（用户选定）：
   *   - 潜水时随机间隔（20~90 分钟）尝试一次
   *   - 每天累计 ≤ 30 分钟（按**实际观看秒数**记账，不是挂钟时间）
   *   - 群友发的链接不计入这个额度（那是应要求观看，见 /api/socialV2/bili-watch）
   *
   * 为什么用"观看秒数"而不是真实耗时：下载+抽帧的真实耗时跟视频长度、网速有关，
   * 但真正"看进去"的是截取的那几秒。用秒数记账更接近"我看了多久视频"的直觉，
   * 也能防止一晚上刷几百条标题。
   */
  // ── Token 用量统计（每日更新 + 落盘 + 日志）─────────────────────────────
  //
  // 需求（2026-10-21 用户）：「把 token 记录做成日志，每日更新并且放进控制台」。
  //
  // 数据来源：DSH 的会话转录（`~/.dsh/sessions/**/session*.jsonl.zstd`）。
  // 解析逻辑复用 scripts/token-usage.mjs 的思路（zstd 多帧、usage 去重），
  // 已在 src/token-usage.js 里做成可复用模块。
  //
  // 为什么要落盘 + 增量缓存：
  //   - 全量扫一遍要 13~15 秒（15 个文件、最大的 72MB），不能每次请求都算；
  //   - 但**每天算一次**是够的（用户要的就是"每日更新"）；
  //   - 中间重启时用文件 mtime+size 指纹复用上次结果，只有变化的文件才重解。
  let tokenUsage = null;      // { updatedAt, days:{}, models:{}, turns, calls }
  let tokenUsageBusy = false;

  function loadTokenUsage() {
    try {
      const raw = readJsonSafe(TOKEN_USAGE_FILE, null);
      if (raw && typeof raw === 'object' && raw.days) return raw;
    } catch { /* 损坏就当没算过 */ }
    return null;
  }

  /**
   * 重新统计并落盘。
   * @param {{force?:boolean}} opts force=true 时不复用缓存（全量重解）
   */
  async function refreshTokenUsage(opts = {}) {
    if (tokenUsageBusy) return tokenUsage;
    tokenUsageBusy = true;
    const startedAt = Date.now();
    try {
      const prev = loadTokenUsage();
      // **只统计桥接自己的会话**。
      //
      // 为什么不扫整个 ~/.dsh/sessions（2026-10-21 实测）：那个目录下还有别的项目
      // 和一堆测试用工作区（`state-probe-*`、`state-tmp-*`、`state-local-*` 等），
      // 全扫进去会让"今日用量"虚高、且和机器人的真实开销无关。
      // 桥接的会话按 `sessionCwd` 落在 `--<项目路径>-state-agents--` 这类目录下，
      // 所以只挑名字里带本项目标识的那几个。
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const sessionsRoot = path.join(home, '.dsh', 'sessions');
      const roots = [];
      try {
        const marker = 'qq-bridge';
        for (const name of fs.readdirSync(sessionsRoot)) {
          // 只认正式运行目录（state-agents），跳过测试/探针工作区
          if (!name.includes(marker)) continue;
          if (!/-state-agents--$/i.test(name)) continue;
          roots.push(path.join(sessionsRoot, name));
        }
      } catch { /* 目录不存在就留空 */ }

      if (!roots.length) {
        log('[Token] 未找到 DSH 会话目录，跳过统计');
        return tokenUsage;
      }

      const agg = aggregateTokenUsage(roots, {
        cache: opts.force ? {} : (prev?.cache || {}),
        maxFiles: 400
      });

      const out = {
        updatedAt: Date.now(),
        // 按天（上海时区 YYYY-MM-DD）
        days: agg.days,
        models: agg.models,
        // 按天 × 按模型的联合分布：控制台「按日审阅」用它按所选日期取明细。
        // 不能从 days/models 事后反推（边际汇总推不出联合分布）。
        dayModels: agg.dayModels || {},
        turns: agg.turns,
        calls: agg.calls,
        files: agg.files,
        cache: agg.cache
      };
      atomicWriteJson(TOKEN_USAGE_FILE, out);
      tokenUsage = out;

      // 写日志：今日 + 昨日 + 累计（用户要求"做成日志"）
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      const keys = Object.keys(out.days).sort();
      const t = out.days[today] || { input: 0, output: 0, cacheRead: 0, calls: 0 };
      const y = out.days[keys[keys.length - 2]] || { input: 0, output: 0, cacheRead: 0, calls: 0 };
      const tot = Object.values(out.days).reduce((a, v) => ({
        input: a.input + v.input, output: a.output + v.output, cacheRead: a.cacheRead + v.cacheRead, calls: a.calls + v.calls
      }), { input: 0, output: 0, cacheRead: 0, calls: 0 });
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`[Token] 统计完成（${secs}s，新解析 ${agg.scanned} 文件 / 复用 ${agg.reused}）`);
      log(`[Token] 今日 ${today}：输入 ${humanTokens(t.input)} / 输出 ${humanTokens(t.output)}`
        + ` / 缓存读 ${humanTokens(t.cacheRead)} / 调用 ${t.calls}`);
      log(`[Token] 累计：输入 ${humanTokens(tot.input)} / 输出 ${humanTokens(tot.output)}`
        + ` / 缓存读 ${humanTokens(tot.cacheRead)} / 调用 ${tot.calls}`);
      appendActivity(`[Token] 今日 输入 ${humanTokens(t.input)} / 输出 ${humanTokens(t.output)} / 调用 ${t.calls}`);
      return out;
    } catch (error) {
      log(`[Token] 统计失败（不影响桥接）：${error?.message ?? error}`);
      return tokenUsage;
    } finally {
      tokenUsageBusy = false;
    }
  }

  /**
   * 启动定时更新：
   *   - 启动后 30 秒先算一次（让控制台马上有数据）
   *   - 之后**每小时**检查一次；只有"日期变了"或"距上次统计 > 6 小时"才真算
   *     （用户要"每日更新"，但白天也想看到今日实时数字，所以用 6 小时兜底）
   */
  function startTokenUsageScheduler() {
    setTimeout(() => { void refreshTokenUsage().catch(() => {}); }, 30 * 1000).unref?.();
    const timer = setInterval(() => {
      const prev = tokenUsage || loadTokenUsage();
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      const lastDay = prev?.updatedAt
        ? new Date(prev.updatedAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
        : '';
      const ageMs = Date.now() - (Number(prev?.updatedAt) || 0);
      // 跨天 → 一定重算；否则超过 6 小时也重算（让"今日"数字不会僵一整天）
      if (lastDay !== today || ageMs > 6 * 3600 * 1000) {
        void refreshTokenUsage().catch(() => {});
      }
    }, 60 * 60 * 1000);
    timer.unref?.();
  }

  function scheduleBiliBrowse() {
    const b = cfg.socialV2?.bili ?? {};
    const sb = b.selfBrowsing ?? {};
    if (b.enabled === false || sb.enabled === false || !biliMem) return;
    if (biliTimer) { clearTimeout(biliTimer); biliTimer = null; }

    biliScheduledAt = Date.now();
    biliNextDelay = nextBrowseDelay({
      minIntervalMs: sb.minIntervalMs,
      maxIntervalMs: sb.maxIntervalMs
    });
    biliTimer = setTimeout(() => {
      biliTimer = null;
      void runBiliBrowse().catch((e) => log(`[B站] 自己刷异常：${e?.message ?? e}`));
    }, biliNextDelay);
    biliTimer.unref?.();
    log(`[B站] 下次自己刷：${Math.round(biliNextDelay / 60000)} 分钟后`);
  }

  /**
   * 统计某个群会话的"活跃度"：近 N 小时群友发了多少条**非自己**的消息。
   *
   * 为什么不用 lastActionAt：那只说明"最后一条是什么时候"，
   * 一个昨天热闹、今天没人说话的群它的值也是旧的；而"活跃"要看**持续的消息量**。
   * 也不能只看 recentMessages 的长度——它是有上限的滚动窗口（100 条），
   * 所以统计时必须**按时间过滤**，不能拿数组长度当活跃度。
   *
   * @param {object} st 会话状态
   * @param {{hours?:number, now?:number}} opts
   * @returns {number} 窗口内群友消息条数（排除机器人自己）
   */
  function groupActivityScore(st, opts = {}) {
    const hours = Math.max(0.1, Number(opts.hours) || 24);
    const now = Number(opts.now) || Date.now();
    const from = now - hours * 3600 * 1000;
    const msgs = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    let n = 0;
    for (const m of msgs) {
      if (!m || m.isSelf) continue;              // 机器人自己的发言不算群活跃
      const t = Number(m.time) || 0;
      if (t > 0 && t >= from) n += 1;
    }
    return n;
  }

  /**
   * 选一个群会话作为刷视频的落脚点（它得有个会话才能把画面交给模型）。
   *
   * 2026-10-21 用户要求：「B站视频推荐更多推荐给活跃的群聊而不是非活跃的」。
   *
   * 旧实现是"取 lastActionAt 最久没动静的那个"——那是**优先冷群**，
   * 与需求正好相反。现在的规则：
   *   ① 硬门槛：**近 `activeWindowHours`（默认 24h）群友发言数 ≥ `minActivityForShare`（默认 1）**
   *      才作为候选。完全没人说话的群不推荐（推了也没人看见，还浪费时间）。
   *   ② 候选内按活跃度**加权随机**（权重 = 发言数，有 `activityWeightCap` 上限防垄断）。
   *      不做纯"取最活跃"——那会让同一个群天天被推荐，其余群永远轮不到。
   */
  function pickBiliSessionKey(opts = {}) {
    const sb = cfg.socialV2?.bili?.selfBrowsing ?? {};
    const shareCfg = cfg.socialV2?.bili?.share ?? {};
    // 是否启用"优先活跃群"。默认开；关掉则退回旧的"最闲"策略。
    const preferActive = opts.preferActive ?? (shareCfg.preferActiveGroups !== false);
    const windowHours = Math.max(1, Number(shareCfg.activeWindowHours) || 24);
    const minActivity = Math.max(0, Number(opts.minActivity ?? shareCfg.minActivityForShare) || 0);
    const cap = Math.max(1, Number(shareCfg.activityWeightCap) || 50);
    const now = Date.now();

    const candidates = [];
    for (const [key, st] of socialV2.conversations) {
      if (!key.startsWith('group:')) continue;
      if (!isSessionAllowedInCurrentMode(key)) continue;
      // 有未读/繁忙的跳过：别在人正聊着的时候插进来刷视频
      if (isConversationBusyV2(key, st)) continue;
      if (Array.isArray(st.unread) && st.unread.length > 0) continue;
      const activity = groupActivityScore(st, { hours: windowHours, now });
      // 没指定 minActivity 时（内部刷视频选落脚点）不设活跃门槛——
      // 刷视频本身只需要一个能承载画面的会话，冷群也可以。
      // 只有"推荐到群里"这条路径才要求群真的在说话（见 runBiliBrowse）。
      if (opts.requireActive === true && activity < Math.max(1, minActivity)) continue;
      candidates.push({
        key,
        activity,
        lastActionAt: Number(st.lastActionAt) || 0,
        weight: Math.min(cap, Math.max(1, activity))
      });
    }
    if (!candidates.length) return null;

    if (!preferActive) {
      // 旧行为：最久没动静的那个（最闲）
      candidates.sort((a, b) => a.lastActionAt - b.lastActionAt);
      return candidates[0].key;
    }

    // 按活跃度加权随机
    const total = candidates.reduce((a, c) => a + c.weight, 0);
    let r = Math.random() * total;
    for (const c of candidates) {
      r -= c.weight;
      if (r <= 0) return c.key;
    }
    return candidates[candidates.length - 1].key;
  }

  /**
   * 跑一次「自己刷」。
   *
   * @param {{manual?:boolean}} opts manual=true 表示管理员在控制台点的「现在刷一条」：
   *   **跳过"距上次太近"的间隔限制**（否则点了没反应——这正是 2026-10-19 用户报的现象），
   *   但仍受每日额度约束（手动刷也算看了视频）。
   */
  async function runBiliBrowse(opts = {}) {
    const manual = opts.manual === true;
    const b = cfg.socialV2?.bili ?? {};
    const sb = b.selfBrowsing ?? {};
    if (b.enabled === false || !biliMem) return { ok: false, reason: 'B 站功能未启用' };
    // 暂停只停"自动排期"，**不拦手动触发**——手动是你明确让它看一条，不是自主行为。
    // 但返回里带上 paused 标记，控制台据此提示"当前是暂停状态，这条是手动触发的"，
    // 免得用户以为暂停没生效。
    const manualWhilePaused = manual && sb.enabled === false;
    if (biliBrowsing) {
      log('[B站] 上一轮还没结束，跳过这次');
      if (!manual) scheduleBiliBrowse();
      return { ok: false, reason: '上一轮还没结束' };
    }
    // 额度：按今日已用秒数判断
    const today = biliMem.todayUsage();
    const gate = canSelfBrowse({
      budgetSec: sb.dailyBudgetSec,
      todaySeconds: today.seconds,
      // 手动触发不受间隔限制：把 lastAt 置 0 让间隔检查必然通过
      lastAt: manual ? 0 : lastBiliBrowseAt,
      minIntervalMs: manual ? 0 : sb.minIntervalMs
    });
    if (!gate.allowed) {
      log(`[B站] 跳过自己刷：${gate.reason}（剩余额度 ${Math.round(gate.remainingSec)}s）`);
      if (!manual) scheduleBiliBrowse();
      return { ok: false, reason: gate.reason };
    }
    // 只在潜水时刷（用户没要求，但 active 时刷会抢回复；配成 false 可关闭此限制）
    if (sb.onlyWhenDiving !== false) {
      const anyActive = [...socialV2.conversations.entries()]
        .some(([k, st]) => k.startsWith('group:') && st.phase === 'active');
      if (anyActive) {
        log('[B站] 有群正在活跃，这次不刷');
        if (!manual) scheduleBiliBrowse();
        return { ok: false, reason: '有群正在活跃（潜水时才刷）' };
      }
    }
    // 落脚群（承载模型会话）与"推荐目标群"是两件事：
    //   - 落脚群：任一空闲会话即可，冷群也行（只要能承载画面）；
    //   - 推荐目标：用户要求「更多推荐给活跃的群聊」——必须是真的有人在说话的群。
    // 旧实现把两者绑在一起，而选群规则是"最久没动静的"，于是推荐总落在冷群里。
    const key = pickBiliSessionKey();
    if (!key) {
      log('[B站] 没有空闲会话可以落脚，跳过这次');
      if (!manual) scheduleBiliBrowse();
      return { ok: false, reason: '没有空闲会话可以落脚' };
    }
    // 预览推荐会落在哪个群（不设活跃门槛时返回 null，由 maybeShareBiliVideo 决定不发）
    const shareKey = pickBiliSessionKey({ requireActive: true });

    biliBrowsing = true;
    biliBrowseState.startedAt = Date.now();
    biliBrowseState.key = key;
    biliBrowseState.video = null;
    biliBrowseState.phase = 'fetching-list';
    try {
      // 候选池 = 热门榜多页 **+ 主动搜索**（2026-10-19 加搜索）。
      //
      // 为什么要搜索：热门榜是"别人决定给你看什么"，只有搜索才能主动找
      // "我喜欢的那类"。关键词来自：群友常玩的游戏 → 记忆里喜欢过的标签 → 分区兜底。
      //
      // 搜索接口的前提（实测）：`search/type` 在**完全不带 cookie** 时返回
      // `-412 request was banned`；带上任意 buvid3 就正常返回 20 条/页。
      // 所以凭据不是"必须登录"，而是"必须有设备/登录标识"——见 bili-auth.js。
      //
      // 注：分区榜 `ranking/v2?rid=4` 实测持续 -352（真风控），仍未使用。
      const pages = Math.max(1, Math.min(5, Number(sb.poolPages) || 3));
      const poolResults = await Promise.all(
        Array.from({ length: pages }, (_, i) =>
          fetchPopularVideos({ count: 50, page: i + 1 }).catch(() => []))
      );

      // 口味归纳只读一次：选片和搜索关键词都要用（taste() 每次都会读盘+统计）
      const taste = biliMem.taste(10);

      // 搜索候选：每次随机挑一个关键词（避免总搜同一个）
      let searchHits = [];
      if (sb.search?.enabled !== false) {
        try {
          const keywords = buildSearchKeywords(
            { likedTags: taste.totalTags, categories: taste.categories },
            sb.search?.gamesOnly === true
              ? GAME_KEYWORDS.map((g) => g.name)
              : GAME_KEYWORDS.map((g) => g.name),
            { max: Number(sb.search?.maxKeywords) || 6 }
          );
          const kw = pickSearchQuery(keywords);
          if (kw) {
            biliBrowseState.phase = 'searching';
            lastBiliSearchKeyword = kw;
            const order = ['totalrank', 'pubdate', 'click'].includes(sb.search?.order)
              ? sb.search.order : 'totalrank';
            searchHits = await searchVideos(kw, biliAuth, {
              count: Number(sb.search?.count) || 20,
              order
            });
            if (searchHits.length) {
              log(`[B站] 主动搜索「${kw}」得到 ${searchHits.length} 条`);
            }
          }
        } catch (error) {
          // 搜索失败不影响热门榜那条路（降级而非中断）
          log(`[B站] 搜索失败（改用热门榜）：${error?.message ?? error}`);
        }
      }

      // 按 bvid 去重（热门各页、热门与搜索之间都可能重叠）
      const seenIds = new Set();
      const list = [];
      for (const v of [...poolResults.flat(), ...searchHits]) {
        if (!v?.bvid || seenIds.has(v.bvid)) continue;
        seenIds.add(v.bvid);
        list.push(v);
      }
      biliBrowseState.phase = 'picking';
      const pick = pickCandidate(list, (bvid) => biliMem.get(bvid), {
        cooldownMs: sb.seenCooldownMs,
        // 分区偏好：默认偏向二次元/游戏/科技/社会热点（见 bili-browse.js 的权重表）。
        weights: sb.categoryWeights,
        // 群友常玩的游戏额外加权（用户要求"多看这些"）
        gameBoost: sb.gameBoost,
        preferGames: sb.preferGames !== false,
        // 把记忆里的高频标签带上，让"我喜欢什么"能自我强化（上限 2 倍，不会垄断）
        likedTags: taste.totalTags,
        // 喜欢过的 UP 主（≥2 次才加分）：比标签更硬的偏好信号
        likedOwners: taste.owners
      });
      if (!pick) {
        log('[B站] 候选都看过（冷却期内），这次不刷');
        return { ok: false, reason: '候选都在冷却期内（最近都看过）' };
      }
      biliBrowseState.video = { bvid: pick.bvid, title: pick.title, owner: pick.owner, category: pick.category };
      biliBrowseState.phase = 'downloading';

      // ── 两段式观看：先浅看判断，喜欢再多看一段 ──────────────────────────
      //
      // 为什么改成两段（2026-10-19 用户问「为什么总是只看 8s11 帧，不是说感兴趣就多看吗」）：
      //   原实现**先定看多深、再去看**，而"喜不喜欢"要看完才知道，所以永远走
      //   `watchDepth(null)` 的中庸分支（8s/11 帧），`framesLiked`/`framesDisliked` 从未生效。
      // 现在的顺序：浅看（6s/6 帧）→ 让模型只回一行 JSON 判断 → 喜欢则追加到 120s/120 帧。
      //
      // 采样密度（2026-10-19 用户要求「帧间隔缩短一些，最好一秒取样一次」）：
      //   帧数不再跟 `framesLiked/framesDisliked` 死绑，而是**按秒数 × framesPerSecond** 算。
      //   120 秒按 1 帧/秒 = 120 帧，超过每张拼图 30 格的上限 → 自动切成 4 张图
      //   （见 bili.js 的分页拼图）。所以"看得更细"不会把单帧压成看不清的小方块。
      //
      // 额度：两段的总秒数都要记进"今日已看"，且不超过剩余额度。
      const remain = Math.max(1, gate.remainingSec);
      const density = Math.max(0.1, Math.min(4, Number(sb.framesPerSecond) || 1));
      const maxFramesTotal = Math.max(8, Math.min(120, Number(sb.maxFramesTotal) || 120));
      const framesFor = (sec) => Math.min(maxFramesTotal, Math.max(1, Math.round(sec * density)));
      const tilesPerSheet = Math.max(4, Math.min(36, Number(sb.tilesPerSheet) || 30));
      // 浅看用"不喜欢"的深度（扫一眼），喜欢才追加到"喜欢"的深度。
      // 秒数取配置里 twoPass 的值，没有就按帧数比例给默认（6s / 120s）。
      const scanSeconds = Math.min(
        Number(sb.scanSeconds) || Number(sb.dislikedSeconds) || 6,
        remain
      );
      const likeSeconds = Math.min(
        Number(sb.likedSeconds) || 120,
        Number(sb.maxSecondsPerVideo) || 240,
        remain
      );

      biliBrowseState.phase = 'scanning';
      const scan = await watchVideo(pick.bvid, {
        info: pick,
        seconds: scanSeconds,
        frames: framesFor(scanSeconds),
        tilesPerSheet,
        // 声音内容：有字幕用字幕，没字幕用本地 ASR（见 bili-browse 的说明）
        asr: asrEngine,
        asrEnabled: !!asrEngine,
        asrTimeoutMs: Number(sb.asrTimeoutMs) || 120000
      });
      if (!scan.ok) {
        log(`[B站] 看 ${pick.bvid} 失败：${scan.error}`);
        lastBiliWatch = { bvid: pick.bvid, title: pick.title, ok: false, error: scan.error, at: Date.now() };
        return { ok: false, reason: `看视频失败：${scan.error}` };
      }
      // 缓存元信息（含简介），供模型稍后 qq_bili_record 时补全
      rememberBiliInfo(scan.info, scan.grid);

      // 第一段交给模型做初判（只回 JSON，不发群）
      let verdict = { liked: null, interest: null, tags: [], notes: '' };
      try {
        biliBrowseState.phase = 'judging';
        const judged = await judgeBiliScan(key, pick, scan);
        if (judged) verdict = judged;
      } catch (error) {
        log(`[B站] 初判失败（按"没判断出来"继续）：${error?.message ?? error}`);
      }

      // 喜欢且额度够 → 追加观看（时间窗口变长，不是另截一段）
      let finalWatch = scan;
      let extended = false;
      if (verdict.liked === true && likeSeconds > scanSeconds) {
        biliBrowseState.phase = 'extending';
        const longer = await watchVideo(pick.bvid, {
          info: pick,
          seconds: likeSeconds,
          frames: framesFor(likeSeconds),
          tilesPerSheet,
          asr: asrEngine,
          asrEnabled: !!asrEngine,
          asrTimeoutMs: Number(sb.asrTimeoutMs) || 120000
        });
        if (longer.ok) {
          finalWatch = longer;
          extended = true;
        } else {
          log(`[B站] 追加观看失败，保留第一次的画面：${longer.error}`);
        }
      }

      const watchedSeconds = extended ? likeSeconds : scanSeconds;
      // 记账按**实际拿到的帧数**（抽帧可能因超时/源限制少于请求值）
      const watchedFrames = Number(finalWatch.grid?.frames) || framesFor(watchedSeconds);
      // 追加观看后字幕窗口更长：用最终的覆盖一次缓存（同一 bvid 直接覆盖）
      if (extended) rememberBiliInfo(finalWatch.info, finalWatch.grid);

      // 记账：按实际观看秒数
      biliMem.addUsage(watchedSeconds);
      lastBiliBrowseAt = Date.now();
      lastBiliWatch = {
        bvid: finalWatch.info.bvid, title: finalWatch.info.title,
        owner: finalWatch.info.owner, category: finalWatch.info.category,
        seconds: watchedSeconds, frames: watchedFrames,
        extended, liked: verdict.liked, interest: verdict.interest,
        ok: true, at: Date.now(), key
      };

      biliBrowseState.phase = 'delivering';
      // 判断已经做过了：喜欢的走"继续看"提示词（要求记录），不喜欢/没判断的直接记录
      const prompt = extended
        ? buildExtendedPrompt(finalWatch.info, finalWatch.hint, verdict.notes)
        : buildBrowsePrompt(finalWatch.info, finalWatch.hint, finalWatch.grid);
      await deliverBiliPrompt(key, prompt, finalWatch.grid);
      biliBrowseState.phase = 'done';
      log(`[B站] 自己刷了《${finalWatch.info.title.slice(0, 30)}》`
        + `(${watchedSeconds}s / ${watchedFrames} 帧${extended ? '，初判喜欢已追加' : '，扫一眼就过'}) → ${key}`);

      // ── 推荐分享（用户要求「推荐视频时顺便给出标题和链接」）──
      // 条件：喜欢 + 兴趣分够 + 概率命中 + 距上次分享够久。
      // 分享内容 = 标题 + 链接 + 一句推荐语，**由模型自己组织**（不是模板文案），
      // 这样才像人说话；但链接和标题必须原样给出，不能让模型自己编。
      let shared = null;
      if (verdict.liked === true) {
        try {
          // 推荐发到活跃群；没有活跃群时 shareKey 为 null，maybeShareBiliVideo 会跳过
          shared = await maybeShareBiliVideo(shareKey, finalWatch.info, verdict);
        } catch (error) {
          log(`[B站] 分享失败（不影响观看）：${error?.message ?? error}`);
        }
      }

      return {
        ok: true,
        video: {
          bvid: finalWatch.info.bvid, title: finalWatch.info.title,
          owner: finalWatch.info.owner, category: finalWatch.info.category
        },
        seconds: watchedSeconds,
        frames: watchedFrames,
        extended,
        liked: verdict.liked,
        shared: shared || undefined,
        // 暂停状态下手动触发的：控制台要能说明"这条是手动点的，不是它自己又开始刷了"
        manualWhilePaused: manualWhilePaused || undefined,
        key
      };
    } finally {
      biliBrowsing = false;
      biliBrowseState.phase = '';
      biliBrowseState.startedAt = 0;
      biliBrowseState.video = null;
      biliBrowseState.key = '';
      scheduleBiliBrowse();
    }
  }

  /**
   * 让模型对"浅看"的画面做初判，并**同步等它回一行 JSON**。
   *
   * 为什么需要单独的等待机制：现有的 collector 是全局事件循环驱动的、且与
   * "会话是否繁忙"绑定，不适合在一个函数里同步拿结果。这里用一次性的
   * `biliJudgeWaiters`（sessionId → resolve）实现：
   *   投递 prompt 前登记，事件流收到该 session 的 turn/end 时把文本回填。
   *
   * 超时/异常一律返回 null（调用方按"没判断出来"处理，只保留第一段画面），
   * 绝不让一次判断失败卡住整个刷视频流程。
   */
  /** 记住看过的视频元信息（含简介），供模型稍后记录时补全。 */
  function rememberBiliInfo(info, grid) {
    if (!info?.bvid) { log('[B站] rememberBiliInfo: 无 bvid，跳过'); return; }
    biliInfoCache.set(String(info.bvid), {
      bvid: info.bvid,
      title: info.title || '',
      owner: info.owner || '',
      category: info.category || '',
      durationSec: Number(info.durationSec) || 0,
      desc: String(info.desc || '').slice(0, 600),
      biliTags: Array.isArray(info.tags) ? info.tags.slice(0, 10) : [],
      // 字幕片段（如果这次看的时候抓到了）：模型随后 qq_bili_record 时补进长期记忆
      subtitle: String(grid?.subtitleText || info.subtitleText || '').slice(0, 1200)
    });
    // 有界：超过 30 条删最旧的（进程内缓存，重启丢失可接受——
    // 真正长期的是 bili-memory.json，这里只为"刚看完就要记录"这一小段时间补全）
    while (biliInfoCache.size > 30) {
      const oldest = biliInfoCache.keys().next().value;
      if (oldest === undefined) break;
      biliInfoCache.delete(oldest);
    }
  }
  async function judgeBiliScan(key, info, scan) {
    const sessionId = await ensureSession(key);
    // 投递前再确认一次：挑会话和真正投递之间隔了几秒（要下载视频），
    // 期间该群可能来了消息、会话变忙，初判就会排在群消息后面。
    // 实测有一次因此等了 90 秒才回，被判成"没判断出来"。
    const st = getSocialV2State(key);
    if (isConversationBusyV2(key, st)) {
      log(`[B站] 初判前发现 ${key} 已变忙，仍投递但预计会排队`);
    }
    const prompt = buildScanPrompt(info, scan.hint);

    const text = await new Promise((resolve) => {
      const token = crypto.randomBytes(8).toString('hex');
      // 超时给足（默认 150 秒）：这个会话可能正忙于处理群消息，模型排在队列后面。
      // 实测 90 秒不够——有一次响应在超时后 1 秒才回来，白白判成"没判断出来"，
      // 于是本该追加观看的视频只看了 4 秒。宁可多等，也别漏判"喜欢"。
      const timeoutMs = Math.max(30000, Number(cfg.socialV2?.bili?.selfBrowsing?.judgeTimeoutMs) || 150000);
      const timer = setTimeout(() => {
        biliJudgeWaiters.delete(sessionId);
        log(`[B站] 初判超时（${sessionId}，${Math.round(timeoutMs / 1000)}s），按"没判断出来"处理`);
        resolve('');
      }, timeoutMs);
      timer.unref?.();
      biliJudgeWaiters.set(sessionId, {
        token,
        resolve: (t) => {
          clearTimeout(timer);
          biliJudgeWaiters.delete(sessionId);
          // 诊断：把实际拿到的原文长度与开头打出来，定位"liked=null 但模型明明回了 JSON"
          log(`[B站] 初判拿到文本（${String(t || '').length} 字）：${String(t || '').slice(0, 100).replace(/\s+/g, ' ')}`);
          resolve(t || '');
        }
      });

      const content = [{ type: 'text', text: prompt }];
      const scanimgs = Array.isArray(scan.grid?.sheets) && scan.grid.sheets.length
        ? scan.grid.sheets
        : (scan.grid?.buffer?.length ? [{ buffer: scan.grid.buffer, mimeType: scan.grid.mimeType }] : []);
      for (let i = 0; i < scanimgs.length; i += 1) {
        const img = scanimgs[i];
        if (!img?.buffer?.length) continue;
        const mime = String(img.mimeType || 'image/png');
        content.push({
          type: 'image',
          mediaType: mime,
          data: img.buffer.toString('base64'),
          name: `bili-scan-${i + 1}.${mime.includes('jpeg') ? 'jpg' : 'png'}`
        });
      }
      api.sessions.prompt({ sessionId, mode: 'queue', content }).catch((error) => {
        log(`[B站] 初判 prompt 投递失败：${error?.message ?? error}`);
        biliJudgeWaiters.get(sessionId)?.resolve('');
      });
    });

    if (!text) return null;
    const verdict = parseScanVerdict(text);
    log(`[B站] 初判：liked=${verdict.liked} interest=${verdict.interest ?? '-'} tags=${(verdict.tags || []).join('/') || '-'}`);
    return verdict;
  }

  /**
   * 刷到喜欢的视频时，偶尔在群里推荐（标题 + 链接 + 一句推荐语）。
   *
   * 用户要求：「推荐视频的时候顺便给出标题和链接」。
   *
   * 设计取舍：
   *   - **链接与标题由桥接提供，不让模型自己写**。模型编 URL 是高频问题
   *     （之前引用消息就踩过"凭记忆猜编号"），而 B 站链接错了点不开。
   *     所以消息结构固定为「推荐语 + 标题 + 链接」，模型只负责写推荐语。
   *   - 概率/门槛走 `socialV2.bili.share`：兴趣分 ≥ minInterest、按 probability 掷骰、
   *     距上次 ≥ minGapMs（默认 6 小时），避免刷屏。
   *   - 分享失败不影响观看记录（调用方已 try/catch）。
   *
   * @returns {Promise<{ok:boolean, messageId?:any, reason?:string}>}
   */
  async function maybeShareBiliVideo(key, info, verdict) {
    const share = cfg.socialV2?.bili?.share ?? {};
    if (share.enabled === false) return { ok: false, reason: '分享已关闭' };
    // 没有"活跃群"可推荐时就不发。用户要求「更多推荐给活跃的群聊」——
    // 推到没人说话的群里既没人看，也会让那个群显得像公告板。
    if (!key) {
      return {
        ok: false,
        reason: `最近 ${Math.max(1, Number(share.activeWindowHours) || 24)} 小时内没有群达到活跃门槛`
          + `（至少 ${Math.max(1, Number(share.minActivityForShare) || 1)} 条群友发言），这次不推荐`
      };
    }

    const interest = Number(verdict?.interest) || 0;
    // 默认门槛 65（2026-10-20 从 75 下调）。
    // 为什么：实际 56 条"喜欢"的视频里 interest 中位数只有 68、最高 82，
    // ≥75 的只有 25%。再乘 30% 概率、6 小时间隔，等于推荐功能几乎从不触发。
    // 65 覆盖约 70% 的喜欢视频，既能真的偶尔推荐，也不会推无聊的。
    const minInterest = Number(share.minInterest) || 65;
    if (interest < minInterest) {
      return { ok: false, reason: `兴趣分 ${interest} 未达 ${minInterest}` };
    }

    // 全局间隔：不管哪个群，两次推荐之间至少隔 minGapMs
    const minGap = Math.max(0, Number(share.minGapMs) || 6 * 3600 * 1000);
    if (lastBiliShareAt && Date.now() - lastBiliShareAt < minGap) {
      return { ok: false, reason: '距上次推荐太近' };
    }

    const prob = Math.min(1, Math.max(0, Number(share.probability) ?? 0.3));
    if (Math.random() > prob) return { ok: false, reason: `未命中概率（${prob}）` };

    // URL 用 bvid 拼，而不是从接口拿（接口给的链接可能带过期参数）
    const url = `https://www.bilibili.com/video/${info.bvid}`;
    const title = String(info.title || '').trim();
    const owner = String(info.owner || '').trim();

    // 推荐语由模型写；失败就用中性兜底（绝不把机制说出来）
    let lead = '';
    if (share.askModel !== false) {
      lead = await composeBiliRecommendation(key, info, verdict);
    }
    if (!lead) {
      lead = owner ? `刷到个「${owner}」的视频，还挺对味` : '刚刷到个视频，挺对味';
    }

    // 分两条发：先说一句，再单独发「标题 + 链接」
    // —— 合成一条在群里容易折行错乱，而且链接单独一行更好点。
    const text = `${lead}\n\n《${title}》\n${url}`;
    await sendToQQ(key, text);
    lastBiliShareAt = Date.now();
    log(`[B站] 已推荐给 ${key}：《${title.slice(0, 26)}》兴趣 ${interest} → ${url}`);
    return { ok: true, url, title };
  }

  /** 让模型写一句自然的推荐语（不暴露机制、不自称在刷视频）。 */
  async function composeBiliRecommendation(key, info, verdict) {
    try {
      const prompt = `【写一句推荐语】
你刚看了一个 B 站视频，觉得不错，想在群里顺手提一句（像人分享刚看到的好东西）。

标题：${info.title}
UP主：${info.owner || '未知'}｜分区：${info.category || '未知'}
你的感受：${verdict?.notes || '挺有意思'}
你的标签：${(verdict?.tags || []).join('、') || '无'}

要求：
- 只写**一句**自然的话（15~40 字），像随口分享，不要用"推荐""安利"这类正式词。
- 不要说"我在刷 B 站""根据我的分析"这类暴露机制的话，也不要提任何数字/分值。
- 不要写标题、不要写链接（系统会自动附在下面）。
- 直接输出这句话，不要加引号、不要解释。`;
      const text = await askModelOnce(key, prompt, 60000);
      const line = String(text || '').trim().split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
      // 防御：模型有时会把标题/链接也写进来，或超长
      if (!line || line.length > 80) return '';
      if (/https?:\/\//.test(line)) return '';
      return line.replace(/^["「『]|["」』]$/g, '').trim();
    } catch {
      return '';
    }
  }

  /**
   * 向某个会话投一条 prompt，等模型回一段文本（复用初判那套 waiter 机制）。
   * 与 judgeBiliScan 的区别：这里只是要一句话，不解析 JSON。
   */
  async function askModelOnce(key, promptText, timeoutMs = 60000) {
    const sessionId = await ensureSession(key);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        biliJudgeWaiters.delete(sessionId);
        resolve('');
      }, Math.max(5000, timeoutMs));
      timer.unref?.();
      biliJudgeWaiters.set(sessionId, {
        token: 'recommend',
        resolve: (t) => { clearTimeout(timer); biliJudgeWaiters.delete(sessionId); resolve(t || ''); }
      });
      api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] })
        .catch((error) => {
          log(`[B站] 推荐语投递失败：${error?.message ?? error}`);
          biliJudgeWaiters.get(sessionId)?.resolve('');
        });
    });
  }

  /**
   * 把"看的视频"作为一条带图的 prompt 投递给模型。
   *
   * 帧序列可能被切成**多张图**（见 bili.js 的分页拼图）：一帧一图时单帧只有 142×80，
   * 字幕读不清。这里按时间顺序把每张都作为独立的 image part 投递，模型能一次接收多张。
   */
  async function deliverBiliPrompt(key, promptText, imageBuffer, mimeType = 'image/png') {
    const sessionId = await ensureSession(key);
    const parts = Array.isArray(imageBuffer?.sheets) && imageBuffer.sheets.length
      ? imageBuffer.sheets
      : (imageBuffer?.buffer ? [{ buffer: imageBuffer.buffer, mimeType: imageBuffer.mimeType || mimeType }] : []);
    const content = [
      { type: 'text', text: promptText }
    ];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!part?.buffer?.length) continue;
      const mime = String(part.mimeType || mimeType || 'image/png');
      const ext = mime.includes('jpeg') ? 'jpg' : 'png';
      content.push({
        type: 'image',
        mediaType: mime,
        data: part.buffer.toString('base64'),
        name: `bili-frames-${i + 1}.${ext}`
      });
    }
    await withTimeout(
      api.sessions.prompt({ sessionId, mode: 'queue', content }),
      30000,
      `B站观看 prompt ${key}`
    );
  }

  /** 从消息对象提取可持久化的快照：繁忙期间 unread/recent 会被新消息挤出，只留 seq 不够。 */
  function snapshotWakeMessageV2(m) {
    if (!m || typeof m !== 'object') return null;
    return {
      seq: Number(m.seq) || 0,
      messageId: m.messageId != null ? String(m.messageId) : null,
      sender: String(m.sender || ''),
      userId: m.userId != null ? String(m.userId) : null,
      text: String(m.text || m.plain || '').slice(0, 1200),
      plain: String(m.plain || m.text || '').slice(0, 1200),
      tail: String(m.tail || m.plain || m.text || '').slice(-1200),
      time: Number(m.time) || 0,
      atSelf: m.atSelf === true,
      quoteTargetIsSelf: m.quoteTargetIsSelf === true,
      isOwner: m.isOwner === true,
      ownerLabel: String(m.ownerLabel || ''),
      shareUrl: String(m.shareUrl || '').slice(0, 1200),
      shareTitle: String(m.shareTitle || '').slice(0, 200),
      sharePlatform: String(m.sharePlatform || '').slice(0, 40)
    };
  }

  /**
   * 繁忙时把唤醒原因和触发消息快照一起入队。
   * 只存 seq 不够：活跃群 30 条未读/100 条 recent 几分钟就滚过去了，
   * 等回合结束只剩一个 atMention@seq，没有正文，模型无法补答（2026-10-23 B站 @ 实测）。
   */
  function queuePendingWakeReasonV2(st, key, reason, seq) {
    if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
    const nseq = Number(seq) || 0;
    const pool = [...(Array.isArray(st.unread) ? st.unread : []), ...(Array.isArray(st.recentMessages) ? st.recentMessages : [])];
    const trigger = [...pool].reverse().find((m) => m && Number(m.seq) === nseq) || pool[pool.length - 1] || null;
    const existing = st.pendingWakeReasons.find((r) => r && r.reason === reason && Number(r.seq) === nseq);
    if (existing) {
      // 旧状态/早期队列可能只有 seq，这次拿到正文就补上。
      if (!existing.snapshot) existing.snapshot = snapshotWakeMessageV2(trigger);
      return;
    }
    st.pendingWakeReasons.push({ reason, seq: nseq, snapshot: snapshotWakeMessageV2(trigger) });
    if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
  }

  /** 回合结束时若旧队列只有 seq，从完整消息日志把正文补回来。 */
  function pendingWakeSnapshotFromJournalV2(key, seq) {
    try {
      const n = Number(seq) || 0;
      if (!n) return null;
      const rows = loadContextMessages(STATE_DIR, key, { afterSeq: n - 1, limit: 1 });
      return snapshotWakeMessageV2(rows[0]);
    } catch { return null; }
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (currentMode !== 'reserved2' || socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    // 兜底升级：只要未读里还有没答过的 @，这次唤醒就按 atMention 处理。
    // 否则 anyMessage/probability 定时器会在限流时被直接丢掉，@ 跟着一起饿死
    // （2026-10-23 群 100001006：owner 的「查下来源」就是这样被反复跳过的）。
    try {
      const pendingCallers = findCallersV2(key, st).pending.length;
      if (pendingCallers > 0 && wakePriorityV2(reason) < 90) {
        log(`[reserved2] ${key} 有 ${pendingCallers} 个未答 @，唤醒原因 ${reason} → atMention`);
        reason = 'atMention';
      }
    } catch { /* 判定失败不阻塞唤醒 */ }
    // 每次唤醒都是一个新回合：清空上一轮可能残留的“沉睡前已观察/已等待”标记，
    // 确保 AI 这一轮想再次潜水时，必须重新走 5 分钟沉睡前观察。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      const seq = st.lastUnreadSeq || 0;
      queuePendingWakeReasonV2(st, key, reason, seq);
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    // 唤醒频率硬限制：超限则跳过本次唤醒，避免成本失控。
    //
    // ⚠️ 但**不能连 @ 和"戳你"一起丢**。实测（2026-10-21）：`唤醒频率超限，跳过` 出现 40 次，
    // 其中包含 `pokeSelf`（用户戳它、花了高优先级排队、缩短了等待，最后被这条限制直接扔了）。
    // 群聊一热闹，anyMessage/probability 这类低价值唤醒就把配额吃光，
    // 真正冲它来的 @ / 戳反而被饿死 —— 群友感受就是"@它不回、戳它不回"。
    //
    // 规则：高优先级（私聊/@/戳你/提问/名字）**永不被限流丢弃**；
    // 低优先级（anyMessage/probability/replyCheck 等）照旧受限，用来兜住成本。
    const now = Date.now();
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    // 阈值与 WAKE_PRIORITY 对齐：>=75 视为"冲它来的"（speaker/question/pokeSelf/atMention/private）。
    // 用常量而不是散落的魔法数，改优先级表时不会漏。
    const isHighPriorityWake = wakePriorityV2(reason) >= 75;
    if (!isHighPriorityWake && ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour))) {
      log(`[reserved2] 唤醒频率超限，跳过 ${key}（${reason}，低优先级）`);
      return;
    }
    if (isHighPriorityWake && ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour))) {
      log(`[reserved2] 唤醒频率超限但放行 ${key}（${reason}：高优先级，不能被饿死）`);
    }
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    // 记录「本轮唤醒的水位」= 唤醒时未读里最大的 seq。
    // mark_read 只清理 seq ≤ 水位的（= 本轮确实看过的），水位之后新到的不动。
    // 为什么需要：原先 mark_read 的保留逻辑写反了，导致未读永久滞留，
    // 每轮唤醒模型都看到同一批旧 @ 而重复回答（详见 mark_read 处的说明）。
    st.wakeSeqAt = (Array.isArray(st.unread) ? st.unread : [])
      .reduce((mx, m) => Math.max(mx, Number(m?.seq) || 0), 0);
    saveSocialV2State();
    // 唤醒提示里要判断"谁在叫它"，别名必须包含当前群的群名片。
    // 群消息入站时已经会异步刷新，这里再 await 一次兜住两种空档：
    // 重启补投（没有新消息）与刚进群/刚改名片。
    await ensureSelfCardV2(key);
    const promptText = buildWakePromptV2(key, reason);
    // Phase 0：记录本会话最近一次唤醒提示长度，控制台/日志用它观察上下文膨胀。
    {
      const cm = contextCfg();
      const m = contextMetrics.get(key) || {};
      m.lastPromptChars = promptText.length;
      m.lastPromptAt = Date.now();
      contextMetrics.set(key, m);
      if (cm.promptBudgetChars > 0 && promptText.length > cm.promptBudgetChars) {
        log(`[上下文] ${key} 唤醒提示 ${promptText.length} 字符，超过预算 ${cm.promptBudgetChars}`);
      }
    }
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText);
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
      // 快照只注入一次：真正投递成功后清掉；入队则保留到实际投递。
      if (result && result.ok !== false && result.queued !== true && st.pendingWakeMessage) {
        st.pendingWakeMessage = null;
        saveSocialV2State();
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheckV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    const st = getSocialV2State(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void sendWakePromptV2(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    if (sid && (v2TurnStartAt.has(sid) || collectors.has(sid))) return true;
    return false;
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    // 「拍你」仅次于 @：这是明确冲你来的动作，不回会显得在装死。
    // 与 poke（拍别人）分开是因为实测两者混用导致拍谁都唤醒它，
    // 而模型看到"拍了别人"就不回 —— 群里感受就是「戳它不回」。
    pokeSelf: 85,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    replyCheck: 40,
    // 「拍别人」：只是群里的热闹，看一眼就好，优先级低于普通消息。
    poke: 35,
    timeout: 30,
    proactiveCheck: 20,
    // 启动补投：优先级最低——它是「收拾重启前的积压」，若同窗口内有真实新消息触发
    // 更高优先级的原因（@/提问等），应让那个原因胜出。
    startupBackfill: 10
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  /**
   * 启动补投：把「进程重启前积压的未读」重新排一次唤醒。
   *
   * 为什么需要：深度重启会清空内存队列（`queued` 只覆盖 DSH 短暂不可用的场景），
   * 而 unread 是持久化在 state/social-v2.json 的。若不主动补，重启前群友 @ 它的
   * 消息会被永久搁置——直到群里再来新消息才顺带处理，表现为「机器人不理人」。
   *
   * 策略：只对有未读的会话派人；delayMs 错开，避免重启瞬间十来个会话同时起 turn
   * 把 DSH 和模型配额打满。用 'startupBackfill' 作为唤醒原因（不计入正常优先级）。
   */
  function scheduleStartupBackfillV2() {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    const pending = [];
    for (const [key, st] of socialV2.conversations) {
      const unread = Array.isArray(st.unread) ? st.unread.length : 0;
      if (!unread) continue;
      if (!isSessionAllowedInCurrentMode(key)) continue;
      pending.push({ key, unread });
    }
    if (!pending.length) return;
    log(`[reserved2] 启动补投：${pending.length} 个会话有积压未读（${pending.map((p) => `${p.key}×${p.unread}`).join('、')}）`);
    pending.forEach((p, i) => {
      // 每个会话错开 6 秒，第一个也稍等一下（让 DSH 的 MCP 子进程就绪）
      const delay = 6000 + i * 6000;
      setTimeout(() => {
        const st = socialV2.conversations.get(p.key);
        if (!st) return;
        if (!isConversationBusyV2(p.key, st)) {
          log(`[reserved2] 启动补投唤醒 ${p.key}（积压 ${p.unread} 条未读）`);
          scheduleWakeV2(p.key, 'startupBackfill');
        } else {
          log(`[reserved2] 启动补投跳过 ${p.key}（会话正忙）`);
        }
      }, delay).unref?.();
    });
  }

  function scheduleWakeV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      const seq = st.lastUnreadSeq || 0;
      queuePendingWakeReasonV2(st, key, reason, seq);
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    // 批处理窗口：把「同一波密集消息」合并成一次唤醒，避免抢话、也省额度。
    // 但**高优先级唤醒（@/提问/私聊）要短得多**——它们是明确冲着机器人来的，
    // 等 8 秒只是白白让群友觉得「@ 了不理人」（2026-10-11 用户反馈）。
    // 仍留一个 1.5 秒的小窗口，用于合并「同一条消息触发多个原因」的重复投递。
    const batchMsDefault = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    const isHighPriority = wakePriorityV2(reason) >= 80;   // private(100)/atMention(90)/question(80)
    const batchMs = isHighPriority ? Math.min(batchMsDefault, 1500) : batchMsDefault;
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送${isHighPriority && batchMs < batchMsDefault ? '（高优先级，已缩短等待）' : ''}`);
  }

  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等满上限后重新续期，而不是提前唤醒。
    const MAX_TIMEOUT_MS = 2147483647;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 86400000)} 天后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  function scheduleProactiveCheckV2(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      ensureWakeableV2(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      if (idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // QQ 消息 → DSH prompt
  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    // 白名单命令的准入例外。
    //
    // 为什么必须加（否则功能自相矛盾）：管理员想「从这个新群把自己加进白名单」时，
    // 消息在准入闸门就被丢掉了，永远走不到命令块——那这条命令就只能对**已经在白名单里的群**
    // 生效，等于没法加新群。
    // 放行条件收得很窄：仅群聊、仅 ownerQQ、且文本确实以白名单命令开头；
    // 群友发同样的话照旧被丢弃（命令块里还有一次 isOwner 校验）。
    // closed-agent 模式不例外（该模式只认管理员私聊，开了口子等于破模式）。
    const ownerWhitelistCmd = kind === 'group'
      && currentMode !== 'closed-agent'
      && !!String(cfg.ownerQQ ?? '').trim()
      && String(event.user_id) === String(cfg.ownerQQ)
      && parseWhitelistCommand(rawTextOfMessage(event.message)) !== null;
    if (!modeAllowed(key, kind, id, cfg, currentMode) && !ownerWhitelistCmd) {
      // 私聊被拒时先强制刷一次好友列表再定论。
      //
      // 为什么需要（2026-10-13 实测）：好友列表有 5 分钟 TTL 缓存，而**刚加的好友**
      // 不在缓存里，于是被判成"非好友"直接忽略——对方看到的就是"私聊不回人"。
      // 实测用户新加好友 100001050（昵称"牢"），发了两条消息全被丢弃，
      // 日志只有 `忽略未授权会话 private:100001050`，而 SnowLuma 侧查同一个人是好友。
      //
      // 节流：force 刷新会真的去问 SnowLuma，不加限制的话非好友持续刷消息就等于
      // 拿桥接当放大器打 SnowLuma 接口。所以全局限流（同一窗口内只刷一次），
      // 且失败也不重试——宁可这一次仍按拒绝处理，也不能被打爆。
      const canRetry = kind === 'private'
        && cfg.allow?.privateMode === 'friends'
        && (Date.now() - lastFriendForceRefreshAt >= FRIEND_FORCE_REFRESH_MS);
      let retryOk = false;
      if (canRetry) {
        lastFriendForceRefreshAt = Date.now();
        retryOk = await refreshFriendList({ force: true })
          .then(() => modeAllowed(key, kind, id, cfg, currentMode))
          .catch(() => false);
      }
      if (retryOk) {
        log(`[私聊准入] ${key} 刷新好友列表后放行（新加的好友）`);
      } else {
        log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
        return;
      }
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // 被引用消息里含图片/表情时，给模型一句「怎么看到它」的说明。
    // reserved2 用按需取图工具（图片不自动内联）；其他模式图片本就自动内联，只报事实。
    const mediaFetchHint = currentMode === 'reserved2' ? reserved2MediaFetchHint(key) : inlineMediaFactHint();
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    let textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply, mediaFetchHint });
    let plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    // 分享卡片的完整链接（小红书/B站等）：消息文本会被截断，单独留一份给模型。
    const shareCard = extractShareCards(event.message ?? [])[0] || null;
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    // 语音输入：先转写再进入唤醒提示/上下文；失败就保留 [语音] 占位。
    const voiceTranscript = await transcribeIncomingVoice(key, messageRef, event.message ?? []);
    if (voiceTranscript) {
      textContent = `${textContent}（语音转文字：${voiceTranscript}）`;
      plainContent = `${plainContent}（语音转文字：${voiceTranscript}）`;
    }
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');

    // 「不想回时的轻量参与」：给群友的消息贴个表情。
    // **贴什么由消息语气决定**（好笑→偷笑、称赞→强、负面→不贴），不是随机抽一个；
    // 概率也按语气给（好笑 35%、中性 3%、负面 0），见 emoji-react.js 的说明。
    // 贴表情已改为**由模型自主决定**（它才有完整上下文）：桥接只提供
    // /api/socialV2/react-message 端点与 qq_react_message 工具，不再在此自动贴。
    // 曾在此按语气分类 + 概率自动贴，用户指出那本质仍是随机行为、易引起误解。
    const roleState = readRoleState();

    // 管理命令的识别（管理员专用，由桥接直接执行、不经过模型）。
    // 判据取「已知管理命令」而非「以 / 开头」：DSH 自己的斜杠命令（/model 之类）
    // 要原样转发给 DSH，不能被这里抢走。
    const adminCmd = plainContent.startsWith('/')
      && (['/reset', '/new', '/status', '/silent', '/quiet', '/active', '/speak'].includes(plainContent)
        || plainContent.startsWith('/role ') || plainContent === '/role'
        || /^\/(?:recall|撤回)(?:\s+\d+)?$/i.test(plainContent)
        || parseWhitelistCommand(plainContent) !== null
        // /yes /no /pending 是加入请求的裁决指令（只对管理员私聊生效，
        // 非管理员发同样的词不会被消费，见 handleJoinDecisionCommand）
        || parseJoinCommand(plainContent) !== null);

    // 加好友/入群邀请的裁决指令：必须在一切之前处理。
    // 为什么提前：它既不该进 DSH（模型不该"批准加好友"），也不该被
    // 挂起提问逻辑吞掉。只有管理员私聊会被消费，其余返回 false 继续走正常流程。
    if (await handleJoinDecisionCommand(key, plainContent)) return;

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    //
    // 但**管理员的管理命令优先**（2026-10-13 修）：原先 pending 判定在前且条件含 isOwner，
    // 于是管理员发 /status 时若恰好有挂起提问，命令会被当成"回答"发给 DSH——命令不执行，
    // 回复却是"已回答"，管理员完全不知道命令被吞了。这类静默失败只在挂起期间出现，很难查。
    const p = pending.get(key);
    if (p && !(isOwner && adminCmd) && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          sessionEpoch++;
          delete state.sessions[key];
          reverse.delete(old);
          collectors.delete(old);
          sendToolSucceededSessions.delete(old);
          pendingSendToolCalls.delete(old);
          v2TurnStartAt.delete(old);
          toolCallNames.delete(old);
          social.silentTurns.delete(old);
          social.exitingSessions.delete(old);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          const removedV2 = socialV2.conversations.get(key);
          if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        } else {
          // 无会话时也要有反馈：原先是静默 return，管理员会以为命令没生效。
          await sendToQQ(key, '当前会话还没有上下文，无需重置。');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 撤回机器人最近发出的消息：/recall 或 /撤回，可带条数（/recall 3，最多 10）。
      // 只撤本会话（key）里登记的消息；进程重启后登记清空，撤不了重启前的。
      if (/^\/(?:recall|撤回)(?:\s+(\d+))?$/i.test(plainContent)) {
        const n = Math.min(10, Math.max(1, Number(plainContent.match(/(\d+)/)?.[1]) || 1));
        const arr = sentMessages.get(key) ?? [];
        if (!arr.length) {
          await sendToQQ(key, '没有可撤回的记录（本会话自启动以来还没有发出过消息）。');
          return;
        }
        const targets = arr.splice(Math.max(0, arr.length - n)).reverse();
        let ok = 0;
        const errs = [];
        for (const t of targets) {
          try {
            await bot.deleteMessage(t.messageId);
            ok += 1;
          } catch (error) {
            errs.push(`${String(t.messageId).slice(0, 20)}: ${error?.message ?? error}`);
          }
        }
        log(`管理命令 /recall (${key}): 请求 ${targets.length} 条，成功 ${ok} 条${errs.length ? `，失败 ${errs.length} 条` : ''}`);
        // 静默撤回：成功不发确认消息（管理员要求，撤回动作本身可见）。
        // 一条都没撤成时把原因私聊给管理员——撤回失败属于报错，按「报错不进群」处理。
        if (ok === 0) {
          notifyOwnerOfError(key, '撤回失败（一条都没撤成）', errs[0] ?? '未知错误', {
            说明: `请求撤回 ${targets.length} 条，成功 0 条`,
            可能原因: 'QQ 对撤回有时限（约 2 分钟）/权限限制'
          });
        }
        return;
      }
      // ── 群白名单管理：/wl [add|del] [群号...] ─────────────────────────────
      //
      // 需求（2026-10-17）：「添加一条管理员指令，能够控制群白名单，包含添加进白名单和从中移除」。
      // 设计要点：
      //   ① 落盘 + 内存同步：只改 cfg 不写 config.json，重启就丢；只写文件不同步内存，
      //      当前进程直到重启前都不认（管理员会以为没生效）。
      //   ② 用与 allowed() 相同的字段（allow.groups），不要另开一份"命令白名单"——
      //      两份名单迟早不一致。
      //   ③ 删到空必须显式说后果：allowAllWhenEmpty=false 时那等于关掉所有群。
      const wl = parseWhitelistCommand(plainContent);
      if (wl) {
        if (wl.action === 'help') {
          await sendToQQ(key, '用法：/wl 查看群白名单；/wl add 群号 [群号...] 加入；/wl del 群号 [群号...] 移除。');
          return;
        }
        // 白名单只对群生效：私聊有独立的 privateMode 三态（白名单/好友放行/全放开），
        // 在这里改私聊名单会把那套语义搅乱，所以明确不做。
        if (kind === 'private' && wl.action !== 'list') {
          await sendToQQ(key, '群白名单只能在群里操作（私聊准入用 allow.privateMode）。');
          return;
        }
        const configFile = path.join(ROOT, 'config.json');
        let file;
        try {
          // fail-fast：配置损坏时直接报错，绝不回写，避免把整个 config 清成只剩 allow/deny。
          file = readJsonSafe(configFile, null, true);
        } catch (error) {
          notifyOwnerOfError(key, '群白名单读取失败，未做任何修改', String(error?.message ?? error));
          return;
        }
        const current = Array.isArray(file.allow?.groups) ? file.allow.groups.map(Number).filter(Number.isFinite) : cfg.allow.groups;
        if (wl.action === 'list') {
          // 群名只是锦上添花：查不到（SnowLuma 未连/接口异常）就只列群号，绝不让列表本身失败。
          const names = await (async () => {
            const map = new Map();
            try {
              const list = await withTimeout(bot.getGroupList({ noCache: true }), 5000, '获取群列表');
              for (const g of Array.isArray(list) ? list : (list?.data ?? [])) {
                const gid = Number(g?.group_id);
                if (Number.isFinite(gid)) map.set(gid, String(g?.group_name ?? g?.group_remark ?? '').trim());
              }
            } catch (error) {
              log(`[白名单] 获取群列表失败（仅影响显示群名）：${error?.message ?? error}`);
            }
            return map;
          })();
          const lines = current.length
            ? current.map((gid, i) => `${i + 1}. ${gid}${names.get(gid) ? `（${names.get(gid)}）` : ''}`)
            : ['（空）'];
          const tail = current.length ? '' : `\n${describeEmptyWhitelistRisk(cfg.allowAllWhenEmpty)}`;
          await sendToQQ(key, `群白名单 ${current.length} 个：\n${lines.join('\n')}${tail}`);
          return;
        }
        if (!wl.ids.length) {
          await sendToQQ(key, '没看到有效的群号（5~12 位数字）。用法：/wl add 群号 [群号...] 或 /wl del 群号 [群号...]。');
          return;
        }
        const { next, added, removed, unchanged } = applyWhitelistChange(current, wl.action, wl.ids);
        // 没变化就不写盘：避免"看到回复以为重启后生效了"，实际什么都没改。
        if (!added.length && !removed.length) {
          await sendToQQ(key, `${wl.action === 'add' ? '这些群都已在白名单里' : '这些群本来就不在白名单里'}：${unchanged.join(', ')}`);
          return;
        }
        file.allow = {
          ...(file.allow ?? {}),
          groups: next
        };
        try {
          atomicWriteJson(configFile, file);
        } catch (error) {
          // 写盘失败**不能**改内存：否则进程内看似生效、重启即丢，症状比报错更迷惑。
          notifyOwnerOfError(key, '群白名单写入失败，改动未生效', String(error?.message ?? error), {
            尝试: `${wl.action} ${wl.ids.join(',')}`,
            结果: 'config.json 未改动，内存也未改'
          });
          return;
        }
        cfg.allow.groups = next;
        log(`管理命令 /wl ${wl.action} (${key}): 加入 ${added.join(',') || '无'}，移除 ${removed.join(',') || '无'}，现有 ${next.length} 个`);
        const parts = [];
        if (added.length) parts.push(`已加入：${added.join(', ')}`);
        if (removed.length) parts.push(`已移出：${removed.join(', ')}`);
        if (unchanged.length) parts.push(`未变：${unchanged.join(', ')}`);
        parts.push(`当前群白名单 ${next.length} 个${next.length ? `：${next.join(', ')}` : ''}`);
        // 移出当前群 = 这条消息是它在白名单里的最后一次发言，必须说清楚"之后不会再来"。
        const removedSelf = removed.includes(Number(id));
        if (removedSelf) parts.push('本群已被移出，之后这个群的消息不再处理。要加回就在本群发 /wl add ' + String(id) + '（仅管理员有效）。');
        if (!next.length && wl.action === 'del') parts.push(describeEmptyWhitelistRisk(cfg.allowAllWhenEmpty));
        await sendToQQ(key, parts.join('\n'));
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (currentMode === 'reserved2') {
      // 私聊也取昵称（同 reserved 路径）：让模型能认出私聊里说话的是谁，
      // 而不是一律看到 "私聊"（那会让它认不出管理员）。
      const sender = kind === 'group'
        ? (event.sender?.card || event.sender?.nickname || String(event.user_id))
        : (event.sender?.nickname || event.sender?.card || '私聊');
      // 群内身份（owner=群主 / admin=群管理员 / member=普通成员）。
      // 实测 SnowLuma 的 sender 里带 role 字段（messages.db 实测三值分布：
      // member 23395 / admin 21937 / owner 9414），可靠可用。
      // 与「后台管理员」(config.ownerQQ) 是**两回事**：那个是控制台/管理命令的权限；
      // 这个是群里的身份，用于让模型知道"谁说话更有分量"。
      const groupRole = kind === 'group' ? String(event.sender?.role ?? '').trim().toLowerCase() : '';
      // @ 机器人？直接看 OneBot 的 at 段，不依赖别名表（群名片可能还没查到/已改名）。
      const atSelfRaw = Array.isArray(event.message)
        && event.self_id != null
        && event.message.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) === String(event.self_id));
      if (kind === 'group') void ensureSelfCardV2(key); // 顺带刷新群名片缓存（@ 别名用）
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []), groupRole, atSelfRaw, shareCard);
      // 点单标记：在**入站时刻**判定（此时才拿得到 at 段），存到消息条目上，
      // 供唤醒时掷骰——名单之外的群友点单同样纳入。
      if (!isOwner) {
        try {
          const stOrder = getSocialV2State(key);
          const aimed = isAimedAtSelfV2(plainContent, event, quoteTargetIsSelf);
          if (isContentRequestV2(plainContent, aimed)) {
            const last = stOrder.recentMessages[stOrder.recentMessages.length - 1];
            if (last && !last.isSelf) {
              last.orderText = String(plainContent).slice(0, 120);
              last.orderAt = Date.now();
              saveSocialV2State();
            }
          }
        } catch (error) {
          log(`[reserved2] 点单标记失败 ${key}: ${error?.message ?? error}`);
        }
      }
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent);
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      // 差评换图：群友说「不好看/换一张」时，删掉刚发的那张（并禁止再拉回）后另发一张。
      // 放在唤醒之前，是为了**即时响应**——等模型回合结束再处理，群里那口气已经凉了。
      // 命中即 return：这条消息由本机制处理完，不必再交给模型（避免模型又为它发一张）。
      if (!isOwner) {
        try {
          const swapped = await handleImageFeedback(key, plainContent);
          if (swapped) {
            appendActivity(`${key} [reserved2] 差评换图已处理：${plainContent.slice(0, 40)}`);
            return;
          }
        } catch (error) {
          log(`[reserved2] 差评换图处理失败 ${key}: ${error?.message ?? error}`);
        }
      }
      // 「群主指定图站」识别：「pixiv上找几张X的图」这类话里，图站是自然语言，
      // 而**实测模型经常不填 sources 参数**（于是又去 safebooru 找）。桥接在这里
      // 记下指定，之后该会话取图默认用它；模型若显式传了 sources 仍以模型为准。
      try {
        const det = detectSourceRequest(plainContent);
        if (det.sources.length) {
          sourceHints.remember(key, det.sources, plainContent);
          log(`[图库] ${key} 识别到指定图源：${det.sources.join('/')}（命中「${det.matched.join('、')}」）`);
        }
      } catch (error) {
        log(`[图库] 图源识别失败 ${key}: ${error?.message ?? error}`);
      }
      const st = getSocialV2State(key);
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          scheduleWakeV2(key, reason);
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + identityTagOf({ isOwner, isGroupOwner: groupRole === 'owner', isGroupAdmin: groupRole === 'admin' })
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      // 私聊原本一律记成 '私聊'，导致模型认不出私聊里说话的就是管理员本人
      // （2026-10-15 用户要求「管理员发消息时机器人应该能够认出」）。
      // 改成优先取昵称/群名片，取不到再退回 '私聊'。
      const sender = kind === 'group'
        ? (event.sender?.card || event.sender?.nickname || String(event.user_id))
        : (event.sender?.nickname || event.sender?.card || '私聊');
      // 群内身份（owner=群主 / admin=群管理员），与后台管理员(isOwner)分开算。
      const groupRole = kind === 'group' ? String(event.sender?.role ?? '').trim().toLowerCase() : '';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef, groupRole, shareCard); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${identityTagOf({ isOwner, isGroupOwner: groupRole === 'owner', isGroupAdmin: groupRole === 'admin' })}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = currentRoleHint();
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        // 群里不发「系统服务重启中」这类内部状态（用户要求报错/内部信息不进群）；
        // 只私聊管理员，群友侧表现为机器人暂时安静。
        notifyOwnerOfError(key, 'DSH 不可用，消息已入队', `队列中已有 ${items.length} 条待处理`, {
          说明: 'DSH 未就绪，消息会在恢复后自动处理，群内未提示'
        });
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      notifyOwnerOfError(key, '消息未被 DSH 接受', errText);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          type: 'client-response',
          rpcId: entry.rpcId,
          result: { ok: true, value: { sessionId: entry.sessionId, approvalId: entry.approvalId, outcome: 'rejected' } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          type: 'client-response',
          rpcId: entry.rpcId,
          result: { ok: true, value: { sessionId: entry.sessionId, answer: { answers: [] } } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          type: 'client-response',
          rpcId: p.rpcId,
          result: { ok: true, value: { sessionId: p.sessionId, answer: { answers } } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        // 报错不进群，只私聊管理员（挂起保留，群友可再回一次）。
        notifyOwnerOfError(key, '回答 agent 提问回执失败', error.message, { 说明: '挂起已保留，可再回复一次' });
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          type: 'client-response',
          rpcId: p.rpcId,
          result: { ok: true, value: { sessionId: p.sessionId, approvalId: p.approvalId, outcome } }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        // 报错不进群，只私聊管理员（挂起保留，可再回复一次）。
        notifyOwnerOfError(key, '审批回执提交失败', error.message, { 说明: '挂起已保留，可再回复「通过」或「拒绝」', 决定: outcome });
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) return;
    if (currentMode !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      // 区分「拍你」和「拍别人」：
      // 原来一律用 'poke'，提示词又写「可能拍你，也可能拍别人」，于是模型多半判断
      // "跟我无关"就不回 —— 群里感受就是「戳它有时候不理」。拍自己时用独立原因，
      // 提示词里给出明确指令（必须回应），优先级也高于普通拍一拍。
      scheduleWakeV2(key, targetIsSelf ? 'pokeSelf' : 'poke');
    }
  }

  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        // 超时属系统侧异常（报错不进群）；只通知管理员。群友侧表现为这条提问自然过期。
        notifyOwnerOfError(key, '等待回答超时，已取消挂起请求', `等待 ${Math.round((cfg.questionTimeoutMs || 0) / 1000)} 秒无人回答`, {
          请求类型: entry.kind === 'approval' ? '审批' : '提问'
        });
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }

  // 事件流断开后清理本轮连接遗留的追踪状态。
  // 必须在“正常结束”与“异常中断”两条路径上都调用：WebSocket 关闭时 dsh-client 以 yield 收尾
  // （生成器正常 return，不抛异常），因此只有 catch 分支的清理永远不会执行 —— 曾导致 DSH 重启后
  // collectors/v2TurnStartAt 残留，isConversationBusyV2 恒为 true，该会话永久「会话繁忙」不再理人。
  function resetStreamTracking(reason) {
    const busyKeys = [...pendingWakeKeys];
    collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
    social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
    sendToolSucceededSessions.clear();
    pendingSendToolCalls.clear();
    v2TurnStartAt.clear();
    toolCallNames.clear();
    pendingWakeKeys.clear();
    clearAllPendingWakeLeases();
    social.exitingSessions.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    // 长轮询占位标记同样要清：断流后残留的等待请求早已失效，留着会让该会话
    // 后续所有 qq_wait_for_messages 都被拒（429「已有一个等待中」）。
    if (activeWaits.size) {
      log(`事件流断开（${reason}），清除等待占位标记：${[...activeWaits].join('、')}`);
      activeWaits.clear();
    }
    // 断流时若有会话正被标记为“唤醒在途”，其 turn/end 已随连接一起丢失，必须就地解除，
    // 否则该会话会被 isConversationBusyV2 判定为永久繁忙。正常情况下这里应为空。
    if (busyKeys.length) log(`事件流断开（${reason}），解除唤醒占用标记：${busyKeys.join('、')}`);
  }

  // DSH 事件流 → QQ
  async function pumpMux() {
    for (;;) {
      let streamEnded = false;
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          const frame = envelope.payload;
          if (frame.type === 'session/event') {
            const key = reverse.get(frame.sessionId);
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (learnerSessions.has(frame.sessionId)) {
                const learnerCollector = learnerCollectors.get(frame.sessionId) ?? createTurnCollector();
                learnerCollectors.set(frame.sessionId, learnerCollector);
                const learnerEnded = learnerCollector.push(frame.event);
                if (learnerEnded) {
                  learnerCollectors.delete(frame.sessionId);
                  const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  if (frame.sessionId !== slangLearnerSessionId) learnerSessions.delete(frame.sessionId);
                }
              }
              continue;
            }
            // Phase 0：捕获 DSH 的压缩摘要。
            // 它替换掉几十万 token 的历史，是"更早发生什么"的唯一线索；
            // 以前只留在 DSH 会话文件里，桥接完全看不到。这里落一份到
            // state/context/<key>/compactions.jsonl，记忆包在没有 episode 时用它兜底。
            if (frame.event.type === 'compaction/summary') {
              try {
                const d = frame.event.data || {};
                const rawSummary = Array.isArray(d.summary)
                  ? d.summary.map((b) => String(b?.text ?? '')).join('\n')
                  : String(d.summary ?? '');
                const summary = redactSensitiveText(rawSummary).trim();
                if (summary) {
                  const c = contextCfg();
                  appendCompaction(STATE_DIR, key, {
                    at: Date.now(),
                    sessionId: frame.sessionId,
                    compactionId: String(d.compactionId || ''),
                    summary: summary.slice(0, 4000),
                    shadowedTokenCount: Number(d.shadowedTokenCount) || 0,
                    provider: String(d.provider || ''),
                    model: String(d.model || ''),
                    maxTokens: Number(d.maxTokens) || 0
                  }, c.compactionKeep);
                  const m = contextMetrics.get(key) || {};
                  m.lastCompactionAt = Date.now();
                  m.lastCompactionNotch = Number(d.shadowedTokenCount) || 0;
                  contextMetrics.set(key, m);
                  log(`[上下文] ${key} 捕获 DSH 压缩摘要（压掉 ${Math.round((Number(d.shadowedTokenCount) || 0) / 1000)}k tokens）`);
                }
              } catch (error) {
                log(`[上下文] 保存压缩摘要失败：${error?.message ?? error}`);
              }
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }
            // collector 只在「本会话有在途回合」时才需要（turn/start 会先写 v2TurnStartAt）。
            // 曾经的 bug：这里**无条件** set，而删除只在 ended（回合结束）时发生，
            // 于是任何在 turn/end 之后到达的迟到帧（迟到的 chunk、session/title/usage 等）
            // 都会重新生成一个 collector 并永久残留 —— isConversationBusyV2 因此恒为 true，
            // 该会话表现为「永久繁忙、不理人」（实测：turn 已 completed 8 分钟，日志仍在报繁忙）。
            // 修法：没有在途回合时既不新建、也不收集（没有回合就没有要收集的东西）。
            let collector = collectors.get(frame.sessionId);
            if (!collector && v2TurnStartAt.has(frame.sessionId)) {
              collector = createTurnCollector();
              collectors.set(frame.sessionId, collector);
            }
            // 初判专用 collector：初判的 prompt 是**直接投递**的，不走
            // v2TurnStartAt 那套唤醒标记，所以上面那个 collector 不会为它创建，
            // `ended` 永远是 false，waiter 只能等到超时（2026-10-19 实测：
            // "初判：liked=null" 且没有超时日志，说明连超时都没等到就被别处 resolve 了）。
            // 这里给"有 waiter 的 session"单独建一个，保证能拿到 turn/end。
            let judgeCollector = biliJudgeCollectors.get(frame.sessionId);
            if (!judgeCollector && biliJudgeWaiters.has(frame.sessionId)) {
              judgeCollector = createTurnCollector();
              biliJudgeCollectors.set(frame.sessionId, judgeCollector);
            }
            const judgeEnded = judgeCollector ? judgeCollector.push(frame.event) : false;
            if (judgeEnded) {
              biliJudgeCollectors.delete(frame.sessionId);
              const waiter = biliJudgeWaiters.get(frame.sessionId);
              if (waiter) {
                const text = judgeEnded.text || '';
                if (text.trim()) {
                  try { waiter.resolve(text); } catch {}
                } else {
                  log(`[B站] 初判回合无文本（工具调用），继续等｜reason=${JSON.stringify(judgeEnded.reason)?.slice(0, 60)}`);
                }
              }
            }
            const ended = collector ? collector.push(frame.event) : false;
            if (ended) {
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const actionTaken = sendToolSucceededSessions.has(frame.sessionId) || (turnStart > 0 && st.lastActionAt >= turnStart);
                if (actionTaken) {
                  st.wakeConfig.noActionCount = 0;
                } else {
                  st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                  const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                  if (st.wakeConfig.noActionCount >= limit) {
                    log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                    st.wakeConfig = defaultWakeConfigV2();
                    st.bootstrapSent = true;
                    st.wakeConfig.noActionCount = 0;
                  }
                }
                saveSocialV2State();
              }
              v2TurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSocialV2State(key);
                    st.wakeConfig = defaultWakeConfigV2();
                    saveSocialV2State();
                    log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，避免关键 @/提问被漏掉。
              // 但如果触发它的消息已经被 AI 在当前回合处理（unread 中已不存在该 seq），则不再补发。
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，避免关键 @/提问被漏掉。
              //
              // ⚠️ 2026-10-11 修：原先只 `shift()` **最旧**一条（FIFO），结果 @ 会被更早的
              // poke/probability 插队——实测群 100001005：用户 16:08:31 @ 机器人（atMention@20893），
              // 但补发取的是更早的 poke@20871，@ 那条一直排在队列里没补，直到 16:10:01 才被处理，
              // 延迟 90 秒。群友感受就是「@ 它不是必回」。
              // 现在改为：**在仍相关的项里挑优先级最高的**（atMention/question 高于 poke/probability），
              // 与 scheduleWakeV2 合并窗口的升级逻辑保持一致。
              {
                const stEnd = getSocialV2State(key);
                if (Array.isArray(stEnd.pendingWakeReasons) && stEnd.pendingWakeReasons.length) {
                  // 先剔除「触发它的消息已被本回合处理掉」的项（unread 里已无该 seq）。
                  // 注意：这只说明消息被读过，不代表已经回复过——所以只在确实没有更高优先级项时
                  // 才用它来收尾，避免把 @ 误判成「已处理」而静默丢弃。
                  const unreadSeqs = new Set((Array.isArray(stEnd.unread) ? stEnd.unread : [])
                    .map((m) => Number(m && m.seq)).filter((n) => Number.isFinite(n)));
                  const all = stEnd.pendingWakeReasons.filter((r) => r && typeof r === 'object');
                  if (all.length) {
                    const relevant = all.filter((r) => unreadSeqs.size === 0 || [...unreadSeqs].some((s) => s >= Number(r.seq)));
                    const pool = relevant.length ? relevant : all;
                    // 优先级最高者胜出；同优先级取最新的（seq 大者），因为最新消息更能代表当前意图
                    const pick = pool.slice().sort((a, b) => {
                      const dp = wakePriorityV2(b.reason) - wakePriorityV2(a.reason);
                      if (dp !== 0) return dp;
                      return Number(b.seq || 0) - Number(a.seq || 0);
                    })[0];
                    // 队列里可能只有 seq，正文已经被 30 条未读/100 条 recent 挤掉；
                    // 回合结束时补一份正文快照，下一次唤醒提示直接带上，模型才知道要回什么。
                    stEnd.pendingWakeMessage = pick.snapshot
                      || pendingWakeSnapshotFromJournalV2(key, pick.seq)
                      || stEnd.pendingWakeMessage
                      || null;
                    stEnd.pendingWakeReasons = [];
                    saveSocialV2State();
                    log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${pick.reason}@seq${pick.seq}`
                      + (all.length > 1 ? `（队列共 ${all.length} 条，已按优先级选取）` : '')
                      + (stEnd.pendingWakeMessage ? '，已保留触发消息正文' : ''));
                    scheduleWakeV2(key, pick.reason);
                  }
                }
              }
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain)) {
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  // 群内不再提示（会暴露内部机制）；只私聊管理员，附被拦正文便于判断误判。
                  notifyOwnerOfError(key, '安全策略拦截了一条回复', plain, {
                    原因: hasKnownToken ? '含会话令牌' : '疑似包含敏感信息（路径/凭据）',
                    处置: '该条回复未发出，群友看不到'
                  });
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (isSocialEnabled()) {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    if (isFarewell) {
                      const st = socialState(key);
                      if (st.phase === 'exiting') {
                        st.phase = 'idle';
                        st.activeDeadlineAt = 0;
                        st.activeExitAt = 0;
                        log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                      }
                    }
                    continue;
                  }
                  const timeline = planSocialTimeline(plain, cfg.social);
                  const messages = timeline.main;
                  log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
                  appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  if (messages.length > 1) {
                    await sendBurstToQQ(key, messages, cfg.social);
                  } else {
                    await sendToQQ(key, messages[0]);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    st.lastActiveMessageAt = Date.now();
                    st.lastAiReplyAt = Date.now();
                    log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                  }
                } else if (currentMode === 'reserved2') {
                  log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                } else {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    continue;
                  }
                  log(`agent 回复 (${key}) ${plain.length} 字`);
                  appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  await sendToQQ(key, plain);
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                // 先让报错拦截器处理「额度/限流」类错误（含私聊管理员详情）。
                // 返回 false 表示不是额度类（如模型输出为空、网络抖动）。
                const handled = await handleUpstreamError(key, msg, { sessionId: ended.sessionId ?? '' })
                  .catch((e) => { log(`[报错拦截] 处理失败：${e?.message ?? e}`); return false; });
                // 兜底：不论是否额度类，**一律不再往群里发任何报错字样**（用户要求），
                // 只私聊管理员。群友侧表现为这一轮机器人没说话。
                if (!handled) {
                  notifyOwnerOfError(key, 'agent 处理出错', msg, { sessionId: ended.sessionId ?? '' });
                }
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'aborted') {
                await sendToQQ(key, '⏹️ 已停止');
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  type: 'client-response',
                  rpcId: envelope.rpcId,
                  result: { ok: true, value: { sessionId: frame.sessionId, answer: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } } }
                });
              } else {
                await api.respond({
                  type: 'client-response',
                  rpcId: envelope.rpcId,
                  result: { ok: true, value: { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome: 'rejected' } }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, approvalId: frame.approvalId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
          }
        }
        // WebSocket 正常关闭（DSH 重启/退出）也会走到这里：dsh-client 以 yield 收尾而非抛异常。
        streamEnded = true;
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      }
      // 两条退出路径共用清理：漏掉正常结束这条曾导致会话永久「繁忙」。
      resetStreamTracking(streamEnded ? 'WebSocket 正常关闭' : '读取异常');
      await sleep(3000);
    }
  }

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  bot.onPrivateMessage(async (event) => {
    if (event.user_id === event.self_id) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (event.sender?.user_id === event.self_id || event.user_id === event.self_id) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  // ── 加好友 / 入群邀请：通知管理员并等人工裁决 ───────────────────────────
  //
  // 用户要求（2026-10-20）：「当 bot 账号被请求加好友或者拉进群的时候通知管理员
  // 并且询问同意或拒绝」。
  //
  // OneBot 的请求事件（`post_type: 'request'`）：
  //   - 加好友：request_type='friend'，带 user_id / comment / flag
  //   - 群邀请：request_type='group'，sub_type='invite'，带 group_id / user_id / flag
  //     （还有 sub_type='add' 的"主动申请入群"，QQ 上少见，一并处理）
  //
  // 默认**不自动同意**：这两件事都在扩张攻击面——好友能私聊它、群能让它出现在
  // 陌生人面前。没人处理就超时拒绝（fail-closed）。
  const joinQueue = createJoinQueue({
    file: JOIN_REQUESTS_FILE,
    ttlMs: Math.max(30 * 1000, Number(cfg.socialV2?.joinRequest?.ttlMs) || JOIN_TTL_MS),
    now: () => Date.now()
  });

  /**
   * 机器人现在是不是已经在某个群里。
   *
   * 用途：识别「邀请已经被 QQ 自动同意」的竞态。2026-10-22 实测：
   *   15:02:02 入群通知与群邀请事件同一秒到达（QQ 侧已自动同意）
   *   15:02:03 桥接照常通知管理员「新的入群请求 #9」
   *   15:02:46 管理员回 /yes 9 → SnowLuma 报 "matching group request not found"
   * 请求已经从待处理列表消失，但机器人明明在群里。提前查一次成员身份，
   * 就能把"无需裁决"和"操作失败"区分开。
   */
  async function isBotInGroupV2(groupId) {
    if (!groupId || !selfQQ) return false;
    try {
      const info = await withTimeout(
        bot.getGroupMemberInfo(Number(groupId), Number(selfQQ)),
        5000,
        '查自己的群成员身份'
      );
      return !!info;
    } catch {
      return false;
    }
  }

  /** 真正向 QQ 提交裁决。返回 {ok, alreadyJoined?, expired?, error?}。 */
  async function submitJoinDecision(item, approve, reason = '') {
    const isInvite = item.requestType !== 'friend' && !!item.groupId
      && (item.subType === 'invite' || !item.subType);
    // 同意邀请前先看是否已经在群里：已经在群 = 邀请早已被处理，不用再提交。
    // 只对 invite 生效；sub_type='add' 是"别人申请进我在的群"，机器人在群里是正常的。
    if (isInvite && approve === true && await isBotInGroupV2(item.groupId)) {
      log(`[加入请求] #${item.n} 机器人已在群 ${item.groupId}，邀请已被处理，无需再同意`);
      return { ok: true, alreadyJoined: true };
    }
    try {
      if (item.requestType === 'friend') {
        await bot.setFriendAddRequest(String(item.flag), approve === true);
      } else {
        await bot.setGroupAddRequest(String(item.flag), {
          subType: item.subType || 'invite',
          type: item.subType === 'add' ? 'add' : 'invite',
          approve: approve === true,
          ...(approve ? {} : { reason: reason || '暂不加入' })
        });
      }
      log(`[加入请求] ${approve ? '同意' : '拒绝'} #${item.n}：${item.requestType === 'friend' ? '好友' : '群'} ${item.userId ?? ''}${item.groupId ? ` → ${item.groupId}` : ''}`);
      return { ok: true };
    } catch (error) {
      const msg = error?.message ?? String(error);
      // 请求已不在 QQ 待处理列表：再查一次群成员，区分"已入群"与"已过期/已撤销"
      if (isInvite && await isBotInGroupV2(item.groupId)) {
        log(`[加入请求] #${item.n} 提交时请求已失效，但机器人已在群 ${item.groupId}`);
        return { ok: true, alreadyJoined: true };
      }
      const expired = /not found|不存在|已失效|expired/i.test(msg);
      log(`[加入请求] 提交裁决失败 #${item.n}：${msg}`);
      return { ok: false, error: msg, expired };
    }
  }

  /** 把一条待决请求的说明发给管理员私聊。 */
  async function notifyJoinRequest(n, item) {
    const owner = String(cfg.ownerQQ ?? '').trim();
    if (!owner) {
      log('[加入请求] 未配置 ownerQQ，无法通知管理员；将按超时拒绝处理');
      return false;
    }
    const mins = Math.round((joinQueue.ttlMs || JOIN_TTL_MS) / 60000);
    const text = `【新的${item.requestType === 'friend' ? '好友' : '入群'}请求 #${n}】\n`
      + `${describeJoinRequest(item)}\n\n`
      + `回复以下任一指令处理（${mins} 分钟内有效）：\n`
      + `/yes ${n}　同意\n`
      + `/no ${n}　拒绝\n`
      + `/pending　看还有哪些待处理\n`
      + `⚠️ 超时未处理会自动拒绝。`;
    try {
      await sendToQQ(`private:${owner}`, text);
      return true;
    } catch (error) {
      log(`[加入请求] 通知管理员失败：${error?.message ?? error}`);
      return false;
    }
  }

  /** 处理一条新的请求事件。 */
  async function handleJoinRequest(event) {
    const jr = cfg.socialV2?.joinRequest ?? {};
    if (jr.enabled === false) {
      // 功能关闭时静默拒绝：请求不能一直挂着（QQ 侧会一直显示等待）
      const tmp = {
        flag: event.flag, requestType: event.request_type,
        subType: event.sub_type, userId: event.user_id, groupId: event.group_id
      };
      await submitJoinDecision({ ...tmp, n: 0 }, false, '未开启自动处理');
      return;
    }

    const item = {
      flag: String(event.flag ?? ''),
      requestType: event.request_type === 'friend' ? 'friend' : 'group',
      subType: String(event.sub_type ?? ''),
      userId: Number(event.user_id) || 0,
      groupId: Number(event.group_id) || 0,
      comment: String(event.comment ?? '').slice(0, 200),
      // 昵称/群名不在事件里，尽力查（失败就用号）
      nickname: '',
      groupName: ''
    };
    if (!item.flag) {
      log(`[加入请求] 事件缺 flag，无法裁决：${JSON.stringify(event).slice(0, 200)}`);
      return;
    }

    // 补昵称/群名：通知里只有号码的话管理员很难判断
    try {
      if (item.requestType === 'friend' && item.userId) {
        const info = await withTimeout(bot.getStrangerInfo?.(item.userId) ?? null, 5000, '查陌生人信息').catch(() => null);
        if (info?.nickname) item.nickname = String(info.nickname);
      } else if (item.groupId) {
        const info = await withTimeout(bot.getGroupInfo?.(item.groupId) ?? null, 5000, '查群信息').catch(() => null);
        item.groupName = String(info?.group_name ?? info?.groupName ?? '');
      }
    } catch { /* 查不到就用号码 */ }

    // 群邀请的常见竞态：QQ 已经自动同意了（入群通知与邀请事件同一秒到达），
    // 这条邀请其实已经无效。此时若照常发"新的入群请求"，管理员回 /yes 必然失败。
    // sub_type='add'（别人申请进群）不适用：机器人在群里是正常的。
    if (item.requestType === 'group' && item.groupId
        && (item.subType === 'invite' || !item.subType)
        && await isBotInGroupV2(item.groupId)) {
      log(`[加入请求] 忽略邀请 #${item.groupId}：机器人已在群里（QQ 已自动同意）`);
      const owner = String(cfg.ownerQQ ?? '').trim();
      if (owner) {
        sendToQQ(`private:${owner}`,
          `【入群邀请已自动同意】\n${describeJoinRequest(item)}\n机器人已经在群里，这条邀请不需要再裁决。`).catch(() => {});
      }
      appendActivity(`[加入请求] 忽略已自动同意的邀请 ${item.userId}→${item.groupId}`);
      return;
    }

    // 自动同意（默认关）：开了就跳过人工，但仍要通知管理员"我批了什么"。
    if (jr.autoApprove === true) {
      const res = await submitJoinDecision({ ...item, n: 0 }, true);
      log(`[加入请求] 自动同意（autoApprove=true）：${item.requestType} ${item.userId}${item.groupId ? ` → ${item.groupId}` : ''}${res.ok ? '' : '（提交失败）'}`);
      const owner = String(cfg.ownerQQ ?? '').trim();
      if (owner) {
        sendToQQ(`private:${owner}`,
          `【已自动同意】${item.requestType === 'friend' ? '好友请求' : '入群邀请'}\n${describeJoinRequest(item)}`).catch(() => {});
      }
      return;
    }

    const { n, item: stored } = joinQueue.push(item);
    const notified = await notifyJoinRequest(n, stored);
    if (!notified) {
      // 通知不了管理员（未配 ownerQQ / 发送失败）→ 不能让它干等，直接拒绝
      const taken = joinQueue.take(n);
      if (taken.ok) await submitJoinDecision(taken.item, false, '无法联系管理员');
      log('[加入请求] 无法通知管理员，已自动拒绝');
      return;
    }
    appendActivity(`[加入请求] #${n} ${item.requestType === 'friend' ? '好友' : '入群'} ${item.userId}${item.groupId ? `→${item.groupId}` : ''}，等管理员裁决`);
  }

  /**
   * 处理管理员在私聊里发来的裁决指令。
   * @returns {Promise<boolean>} 是否已消费这条消息（true 表示不要再转给 DSH）
   */
  async function handleJoinDecisionCommand(key, text) {
    const cmd = parseJoinCommand(text);
    if (!cmd) return false;
    // 只认管理员私聊：群里的"同意"可能是别人说的（账号级权限变更不能这么随便）
    const owner = String(cfg.ownerQQ ?? '').trim();
    if (!owner || key !== `private:${owner}`) {
      // 不是管理员：不消费，让消息走正常流程（它在群里说"同意"不该被当成指令）
      return false;
    }

    if (cmd.action === 'list') {
      const all = joinQueue.list();
      if (!all.length) {
        sendToQQ(key, '现在没有待处理的好友/入群请求。');
      } else {
        const mins = Math.round((joinQueue.ttlMs || JOIN_TTL_MS) / 60000);
        sendToQQ(key, `待处理 ${all.length} 条（${mins} 分钟内有效）：\n\n`
          + all.map((it) => `#${it.n}　${describeJoinRequest(it)}`).join('\n\n')
          + `\n\n用 /yes 编号 或 /no 编号 处理。`);
      }
      return true;
    }

    const taken = joinQueue.take(cmd.index);
    if (!taken.ok) {
      const extra = Array.isArray(taken.candidates) && taken.candidates.length
        ? `\n\n当前待处理：\n${taken.candidates.map((it) => `#${it.n}　${describeJoinRequest(it).replace(/\n/g, ' ')}`).join('\n')}`
        : '';
      sendToQQ(key, `${taken.error}${extra}`);
      return true;
    }

    const item = taken.item;
    const approve = cmd.action === 'approve';
    const res = await submitJoinDecision(item, approve);
    const what = item.requestType === 'friend' ? '好友请求' : '入群邀请';
    let reply;
    if (res.ok && res.alreadyJoined) {
      // 不是失败：QQ 已经替我们同意了（或对方已在群里），没必要再操作
      reply = `#${item.n} 已经处理过了：机器人已在群里，不需要再${approve ? '同意' : '拒绝'}。`;
    } else if (res.ok) {
      reply = `已${approve ? '同意' : '拒绝'} #${item.n}（${what}，${item.nickname || item.userId}${item.groupId ? ` → ${item.groupId}` : ''}）`;
    } else if (res.expired) {
      reply = `#${item.n} 的请求已经失效（QQ 侧可能已自动同意或过期），请到 QQ 侧确认一下。`;
    } else {
      reply = `#${item.n} 的裁决提交失败，请稍后在 QQ 侧手动处理（${what}）`;
    }
    sendToQQ(key, reply);
    appendActivity(`[加入请求] 管理员${approve ? '同意' : '拒绝'} #${item.n}`);
    return true;
  }

  bot.onRequest(async (event) => {
    try { await handleJoinRequest(event); } catch (error) { log(`处理加入请求出错：${error?.message ?? error}`); }
  });

  // 机器人自己被拉进群：QQ 可能已经替我们同意了邀请（实测 2026-10-22，
  // 入群通知与群邀请事件同一秒到达）。队列里那条邀请随即作废——
  // 不清掉的话管理员照着通知回 /yes，只会得到 "matching group request not found"。
  // 与 onRequest 的处理顺序无关，所以入队前检查 + 这里兜底两条路径都要有。
  bot.onNotice('group_increase', async (event) => {
    try {
      if (event?.user_id == null || event?.self_id == null) return;
      if (String(event.user_id) !== String(event.self_id)) return;
      const gid = Number(event.group_id) || 0;
      if (!gid) return;
      const removed = joinQueue.takeWhere((it) => it.requestType === 'group'
        && Number(it.groupId) === gid
        && (it.subType === 'invite' || !it.subType));
      if (!removed.length) return;
      log(`[加入请求] 机器人已加入 ${gid}，作废待决邀请 ${removed.map((it) => `#${it.n}`).join('、')}`);
      const owner = String(cfg.ownerQQ ?? '').trim();
      if (owner) {
        sendToQQ(`private:${owner}`,
          `${removed.map((it) => `#${it.n}`).join('、')} 的入群邀请已由 QQ 自动同意（机器人已在群里），无需再裁决。`).catch(() => {});
      }
    } catch (error) {
      log(`处理入群通知出错：${error?.message ?? error}`);
    }
  });

  // 启动时补拒绝：重启前就在排队、但已经超时的请求。
  //
  // 为什么必须单独处理（2026-10-20 实测）：`createJoinQueue` 会在 load 时丢掉过期项，
  // 如果不管它们，那些请求就从队列里消失、却**从未向 QQ 提交过拒绝**——
  // 申请人一直挂着等，日志里也什么都没有。这里把它们捞出来补发拒绝。
  // 延后几秒执行：此时 bot 可能还没连上，太早调用会失败。
  setTimeout(() => {
    try {
      const stale = joinQueue.takeExpiredAtStartup();
      if (!stale.length) return;
      for (const it of stale) {
        void submitJoinDecision(it, false, '超时未处理').catch(() => {});
      }
      log(`[加入请求] 启动时发现 ${stale.length} 条已超时的旧请求，已补发拒绝`);
    } catch (error) {
      log(`[加入请求] 补拒绝旧请求出错：${error?.message ?? error}`);
    }
  }, 15000).unref?.();

  // 定时清理超时请求并自动拒绝（fail-closed）。
  // 不能只在"下一条请求到来时"才清：那样最后一条会一直挂着。
  const joinSweep = setInterval(() => {
    try {
      const expired = joinQueue.pruneExpired();
      if (!expired.length) return;
      for (const it of expired) {
        void submitJoinDecision(it, false, '超时未处理').catch(() => {});
      }
      log(`[加入请求] ${expired.length} 条超时未处理，已自动拒绝`);
      const owner = String(cfg.ownerQQ ?? '').trim();
      if (owner) {
        sendToQQ(`private:${owner}`,
          `有 ${expired.length} 条好友/入群请求超时未处理，已自动拒绝。`).catch(() => {});
      }
    } catch (error) {
      log(`[加入请求] 超时清理出错：${error?.message ?? error}`);
    }
  }, 30 * 1000);
  joinSweep.unref?.();

  // 上下文持久化（Phase 1）：启动 90 秒后补扫一次（把积压的最近消息总结成 episode），
  // 之后每 5 分钟扫一次。串行执行、失败只记日志，不影响消息收发。
  setTimeout(() => { void contextSweep(); }, 90 * 1000).unref?.();
  const contextSweepTimer = setInterval(() => { void contextSweep(); }, 5 * 60 * 1000);
  contextSweepTimer.unref?.();
  // 群名/昵称独立刷新：context-status 30 秒轮询只读缓存，不会每次都打 OneBot。
  setTimeout(() => { void refreshContextNames(true); }, 10 * 1000).unref?.();
  const contextNameTimer = setInterval(() => { void refreshContextNames(true); }, 5 * 60 * 1000);
  contextNameTimer.unref?.();

  bot.on('open', () => log(`SnowLuma 已连接：${cfg.snowluma.wsUrl}`));
  bot.on('close', (info) => log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`));
  bot.on('error', (error) => log('SnowLuma 错误:', error));

  await bot.connect();
  // 读取机器人昵称（用于社交模式"被提到"识别）与自身 QQ（用于好友列表剔除自己）
  try {
    const login = await bot.getLoginInfo();
    if (login?.nickname) {
      selfDisplayName = String(login.nickname);
      selfNickname = selfDisplayName.toLowerCase();
      log(`机器人昵称: ${login.nickname}`);
    }
    if (login?.user_id != null) selfQQ = String(login.user_id);
  } catch {}
  log('桥接已启动。按 Ctrl+C 退出。');

  // 启动自检：图库关闭时把后果说清楚。
  // 克隆者按旧模板建 config.json 时模板里没有 images 段，会吃默认值 false ——
  // 此时 MCP 侧 6 个发图工具根本不注册，模型手里只剩表情包。
  if (!imagesEnabled()) {
    log('[图库] 未启用（socialV2.images.enabled 不是 true）：qq_send_image / qq_check_image / qq_refresh_image_lib / qq_reject_image / qq_image_source / qq_archive_image 均不会注册，agent 无法发图。');
    log('[图库] 若要启用，在 config.json 的 socialV2 下加 images.enabled=true（参考 config.example.json），然后重启桥接。');
  }
  // 自重启时在**这里**再打一次启动完成标记（带着 PID 与来源）：
  // 前面那条"由控制台重启拉起"打在 connectDSH 之前，只说明进程起来了，
  // 不说明服务已经可用——排查时容易把"刚拉起"误读成"已就绪"。
  if (process.env.QQB_RESTARTED_BY) {
    log(`桥接已就绪（控制台自重启，PID ${process.pid}）`);
  }
  // 超分插件自检（只 stat 文件，不起进程，毫秒级）：
  // 让管理员在启动日志里一眼看到"超分有没有生效"，而不是等群友发小图才发现。
  // 不可用是正常情况（可选插件），只说一句，不报警。
  if (cfg.socialV2?.upscale?.enabled !== false) {
    import('./upscale.js')
      .then(({ probeUpscale, configureUpscaleCache, pruneUpscaleCache }) => {
        const uc = cfg.socialV2?.upscale ?? {};
        // 缓存目录：默认 <ROOT>/state/upscale-cache；空字符串 = 关闭缓存。
        // 配成相对路径时按 ROOT 解析，避免受启动时 cwd 影响。
        if (uc.cache?.enabled !== false) {
          const dir = uc.cache?.dir
            ? path.resolve(ROOT, String(uc.cache.dir))
            : path.join(STATE_DIR, 'upscale-cache');
          configureUpscaleCache(dir);
          // 启动时先清一次：进程可能停机很久，攒下的过期缓存要趁早收掉。
          const pr = pruneUpscaleCache({
            maxAgeDays: uc.cache?.maxAgeDays,
            maxBytes: uc.cache?.maxBytes
          });
          if (pr.total > 0) {
            log(`[超分] 缓存清理：${pr.total} 个 / ${(pr.totalBytes / 1024 / 1024).toFixed(1)}MB → 保留 ${pr.kept} 个 / ${(pr.keptBytes / 1024 / 1024).toFixed(1)}MB（删除 ${pr.removed} 个，释放 ${(pr.freedBytes / 1024 / 1024).toFixed(1)}MB）`);
          }
          // 定时清理：写入时也会按次数触发，这里兜底处理"长期没有新超分"的情况
          // （否则一张新图都没有时，旧缓存永远不会被回收）。
          const everyH = Math.max(1, Number(uc.cache?.sweepEveryHours) || 6);
          setInterval(() => {
            try {
              const r = pruneUpscaleCache({
                maxAgeDays: uc.cache?.maxAgeDays,
                maxBytes: uc.cache?.maxBytes
              });
              if (r.removed > 0) {
                log(`[超分] 定时缓存清理：删除 ${r.removed} 个（${(r.freedBytes / 1024 / 1024).toFixed(1)}MB），保留 ${r.kept} 个 / ${(r.keptBytes / 1024 / 1024).toFixed(1)}MB`);
              }
            } catch (error) {
              log(`[超分] 定时缓存清理失败：${error?.message ?? error}`);
            }
          }, everyH * 3600 * 1000).unref?.();
        } else {
          log('[超分] 缓存已关闭（socialV2.upscale.cache.enabled=false）');
        }
        const p = probeUpscale({ binDir: uc.binDir, modelDir: uc.modelDir, model: uc.model });
        if (p.ok) log(`[超分] 已启用（${p.model}）`);
        else log(`[超分] 未启用（${p.reason}）：小图放大走 lanczos，不影响其它功能`);
      })
      .catch((error) => log(`[超分] 插件加载失败（不影响桥接）：${error?.message ?? error}`));
  } else {
    log('[超分] 已在配置中关闭（socialV2.upscale.enabled=false）');
  }
  // ── B 站「自己刷」 ────────────────────────────────────────────────────────
  // 记忆是全局的（跨群），初始化一次；调度器在潜水时随机触发。
  if (cfg.socialV2?.bili?.enabled !== false) {
    try {
      const memFile = path.resolve(ROOT, String(cfg.socialV2?.bili?.memory?.file || 'state/bili-memory.json'));
      biliMem = createVideoMemory(memFile, {
        maxItems: cfg.socialV2?.bili?.memory?.maxItems
      });
      const st = biliMem.stats();
      log(`[B站] 已启用：记忆 ${st.total} 条（喜欢 ${st.liked} / 不喜欢 ${st.disliked}），今日已看 ${Math.round(st.today.seconds)}s`);
      // 凭据：只报状态，绝不打印内容（state/ 已在 .gitignore 里）
      const authFile = path.resolve(ROOT, String(cfg.socialV2?.bili?.authFile || 'state/bili-auth.json'));
      biliAuth = loadBiliAuth(authFile);
      if (biliAuth.loaded) {
        log(biliAuth.hasSessdata
          ? '[B站] 账号凭据已加载（登录态），可用搜索与个性化结果'
          : `[B站] 凭据已加载但无登录态（${biliAuth.reason}），搜索可用但非个性化`);
      } else {
        log(`[B站] 未配置账号凭据（${biliAuth.reason}）；搜索走匿名设备号，功能仍可用`);
      }
      // 登录态同时注入 bili.js：字幕接口 `/x/player/v2` **必须登录**才返回字幕
      // （不登录时 code 仍是 0、subtitles 只是空数组，很容易误判成"这视频没字幕"）。
      // 只传 cookie 字符串，不打印。
      setBiliCookie(biliAuth.cookie || '');
      if (biliAuth.hasSessdata) {
        log('[B站] 字幕已启用（登录态可变声为文字，喂给模型比多抽帧更有用）');
      }
      // ── 本地语音转写（ASR）：让模型"听见"视频（2026-10-21 用户要求）──
      //
      // 实测决定了这条路：网关只接受 text/image_url，音频/视频内容类型全被拒
      // （原因见 src/asr.js 顶部）。所以"听觉"必须转成文字进模型。
      //
      // 字幕 vs ASR 是**互补**关系：有字幕用字幕（瞬时、零成本），
      // 没字幕才走 ASR（12~15 秒，但总能听到）。见 bili-browse 的 watchVideo。
      const asrCfg = cfg.socialV2?.bili?.asr ?? {};
      if (asrCfg.enabled !== false) {
        try {
          asrEngine = createAsrEngine({
            enabled: true,
            model: asrCfg.model,
            cpuThreads: asrCfg.cpuThreads,
            timeoutMs: asrCfg.timeoutMs,
            log: (m) => log(m)
          });
          const ast = asrEngine.status();
          log(`[ASR] 已配置：${ast.model}${ast.modelPath ? '（复用本地模型）' : '（将按名字下载）'}`
            + `，${ast.cpuThreads} 线程；首次识别前自动加载（约 8 秒）`);
          // 预热：启动后 20 秒后台加载，免得第一次刷视频时多等 8 秒。
          // 失败不影响任何功能（只是那一次没有"听觉"）。
          setTimeout(() => { void asrEngine?.warmup?.(); }, 20000).unref?.();
        } catch (error) {
          log(`[ASR] 初始化失败（不影响刷视频，只是没有语音转写）：${error?.message ?? error}`);
          asrEngine = null;
        }
      } else {
        log('[ASR] 已在配置中关闭（socialV2.bili.asr.enabled=false）；只有画面，没有声音内容');
      }
      const taste = biliMem.taste(3);
      if (taste.totalTags.length) {
        log(`[B站] 目前偏好：${taste.totalTags.map((t) => t.name).join('、')}`);
      }
      scheduleBiliBrowse();
    } catch (error) {
      // 记忆文件坏了不该让桥接起不来：降级为"不刷"
      log(`[B站] 初始化失败（不影响桥接）：${error?.message ?? error}`);
      biliMem = null;
    }
  } else {
    log('[B站] 已在配置中关闭（socialV2.bili.enabled=false）');
  }

  // ── 语音合成（TTS，可插拔）：让机器人偶尔发语音消息 ──────────────────
  //
  // 需求（2026-10-21 用户）：「克隆一份 sovits 用达妮娅音源，让它有概率发出语音消息」
  // →（2026-10-22）「这个能够做成可插拔的功能吗」。
  //
  // 可插拔的三条硬性要求（与超分插件同一套约定）：
  //   ① 默认关闭：`socialV2.tts.enabled` 不为 true 时**完全不加载**，不占显存；
  //   ② 探测失败不报错：只是不可用，记一行日志，桥接其余功能毫发无损；
  //   ③ 运行期失败只影响这一条：合成失败自动回退成文字（绝不吞消息）。
  //
  // 探测只 stat 文件、不启动进程——启动 Python 要 3~5 秒 + 占 2GB 显存，
  // 没启用时不该付这个代价。
  {
    const ttsCfg = cfg.socialV2?.tts ?? {};
    if (ttsCfg.enabled === true) {
      try {
        const probe = probeSovits({
          dir: ttsCfg.dir || DEFAULT_SOVITS_DIR,
          gptModel: ttsCfg.gptModel,
          sovitsModel: ttsCfg.sovitsModel,
          refAudio: ttsCfg.refAudio,
          refText: ttsCfg.refText,
          refLang: ttsCfg.refLang,
          voiceName: ttsCfg.voiceName,
          device: ttsCfg.device,
          // 音色预设（voices.json）：voiceId/weightsId/refMode 一旦设置，
          // 会覆盖上面的手写权重/参考音频路径。
          voiceId: ttsCfg.voiceId,
          weightsId: ttsCfg.weightsId,
          refMode: ttsCfg.refMode
        });
        if (!probe.ok) {
          log(`[TTS] 已启用但不可用：${probe.reason}（将只发文字）`);
          ttsEngine = null;
        } else {
          ttsEngine = createTtsEngine({
            enabled: true,
            probe,
            python: ttsCfg.python,
            device: ttsCfg.device || 'cuda',
            isHalf: ttsCfg.isHalf !== false,
            timeoutMs: ttsCfg.timeoutMs,
            log: (m) => log(m)
          });
          const pct = Math.round(Math.max(0, Math.min(1, Number(ttsCfg.probability ?? TTS_DEFAULT_PROBABILITY))) * 100);
          log(`[TTS] 已启用：${probe.voiceName} 音色（${ttsCfg.device || 'cuda'}），`
            + `${pct}% 概率把单条回复改成语音，每小时最多 ${Number(ttsCfg.maxPerHour) || 3} 条`);
          // 预热放到后台：模型加载 + 预热共 10~25 秒，不能挡住启动。
          // 延迟 40 秒（等 DSH 与 B 站先连上），失败只记日志。
          setTimeout(() => {
            void ttsEngine?.warmup?.()
              .then((ok) => { if (!ok) log('[TTS] 预热未完成，首次发语音时再加载'); })
              .catch(() => {});
          }, 40000).unref?.();
        }
      } catch (error) {
        log(`[TTS] 初始化失败（不影响文字聊天）：${error?.message ?? error}`);
        ttsEngine = null;
      }
    } else {
      log('[TTS] 未启用（socialV2.tts.enabled 不是 true）；只发文字');
    }
  }
  // Token 用量统计：启动 30 秒后先算一次，之后每小时检查（跨天或超 6 小时才真算）。
  // 放在 B 站初始化之后：它是纯统计，失败绝不能影响主流程。
  try {
    startTokenUsageScheduler();
  } catch (error) {
    log(`[Token] 调度启动失败（不影响桥接）：${error?.message ?? error}`);
  }
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  // 预热好友列表：私聊准入 'friends' 模式需要它；启动时拉一次，之后每 5 分钟刷新。
  // 放在这里（而非按需拉）是为了让 modeAllowed 保持同步——它有 18 个调用点。
  if ((cfg.allow?.privateMode ?? 'list') === 'friends') {
    refreshFriendList({ force: true })
      .then((ids) => log(`[私聊准入] 好友列表已加载：${ids.size} 人（策略 friends：好友自动放行，非好友仍需白名单）`))
      .catch(() => {});
    setInterval(() => { refreshFriendList({ force: true }).catch(() => {}); }, FRIEND_LIST_TTL_MS).unref?.();
  }

  // ── X（Twitter）按需拉取 ────────────────────────────────────────────────
  // 不再定时推送：群友在群里点名要看某个 X 账号的帖子时，AI 调用 MCP 工具
  // qq_fetch_x_posts 现场拉取 → 渲染成卡片图 → 发到当前会话。
  // 账号/条数/时间条件都由调用方给，xMonitor 段只存放共享设置（代理、翻译开关）。
  const xMonitor = new XMonitor({
    root: ROOT,
    log: (m) => log(m)
  });

  startDshWatch();
  startConsoleServer();

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => log('未处理异常:', error?.message ?? error));
// 崩溃前留痕：桥接由隐藏窗口启动，stderr 无人接收，进程一死什么痕迹都没有
// （实测 2026-09-26 00:54 一次计划外重启，死因无法追查）。先记日志再按守护模式退出，
// 让 start.bat 的守护循环 5 秒后拉起新实例。
process.on('uncaughtException', (error) => {
  try { log('💥 未捕获异常，进程即将退出:', error?.stack ?? error?.message ?? error); } catch {}
  setTimeout(() => process.exit(1), 500);
});
process.on('exit', () => releaseLock());

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
