import { clearSessionTracking as clearSessionTrackingState } from './pipeline/session-tracking.js';
// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import { createIncomingStages } from './pipeline/incoming.js';
import { createIncomingDispatcher } from './pipeline/dispatch-incoming.js';
import { createReplyTargetService } from './pipeline/reply-target.js';
import { createImageSender } from './pipeline/image-send.js';
import { createSocialStateStore, canonicalV2Key } from './pipeline/social-state.js';
import { createContentRequestPolicy } from './pipeline/content-request.js';
import { createBiliRuntime } from './pipeline/bili-runtime.js';
import { normalizePrivateMode, allowed, privateAllowed as privateAllowedPure, modeAllowed as modeAllowedPure } from './pipeline/admission.js';
import { validateConfig, configSummary } from './config-schema.js';
import { createBiliSharing } from './pipeline/bili-sharing.js';
import { createRoleHintReader } from './pipeline/role-hint.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap } from './dsh-client.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
// 传给模型前把过大图片降采样（防 DSH 侧 base64 爆栈），见模块顶部说明。
import { shrinkStickerForUpload, STICKER_UPLOAD_MAX_BYTES, STICKER_UPLOAD_TARGET_BYTES } from './image-downscale.js';
// 群文件只读分类（列表/统计/搜索，不做写操作），见模块顶部说明。
import { summarizeGroupFiles, formatSummary, searchGroupFiles, humanSize } from './group-files.js';
import { fetchFromSources, resolveTagName, sourcePageOf } from './images-api.js';
import { loadPixivAuth, setPixivCookie } from './images-api.js';
import { createAsrEngine } from './asr.js';
import { DEFAULT_SOVITS_DIR, TTS_DEFAULT_PROBABILITY } from './tts.js';
import { createPluginRuntime } from './plugin-runtime.js';
import { collectCacheItems, summarizeCache, purgeCache, humanBytes, CACHE_GROUPS } from './cache-manager.js';
import { detectSourceRequest } from './images-api.js';
import { createImageFacade } from './image-facade.js';
import { createImageRequestService } from './image-request.js';
import { createMediaService } from './media-service.js';
import { createSocialEngine } from './social-engine.js';
import { createSocialLoop } from './social-loop.js';
import { createErrorService } from './error-service.js';
import { createBiliBootstrap } from './bili-bootstrap.js';
import { createReverseSearcher } from './images-api.js';
import { classifyImageFeedback } from './images-api.js';
// 回复时按概率 @ 对方：由桥接掷骰（模型几乎不主动传 atUserId），见 auto-at.js 顶部说明。
import { pickAutoAt, DEFAULT_AUTO_AT } from './auto-at.js';
// 非白名单群的 @：预设话术直接回，不经过 DSH（不消耗 token）。
import { createWhitelistNotifier } from './whitelist-notice.js';
import {
  buildMemoryIndex,
  searchMemory,
  formatRecallResults
} from './memory-retrieval.js';
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
  journalCoverage,
  appendRecallAudit,
  readRecallAudit,
  recallAuditStats,
  appendBacklogSample,
  readBacklogHistory,
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
import { safeFetchBuffer, validateFetchUrl } from './safe-fetch.js';
// 超分回传要按魔数确认"这确实是图片"，不能变成任意文件发送通道。
import { sniffImageMime } from './web-image-fetch.js';
// B 站：自己刷视频 + 全局观看记忆。见 bili.js / bili-browse.js 顶部说明。
import { createVideoMemory, resolveBiliId, fetchVideoInfo, fetchPopularVideos, setBiliCookie } from './bili-api.js';
import { loadBiliAuth, searchVideos, buildSearchKeywords, pickSearchQuery } from './bili-api.js';
import {
  pickCandidate, watchDepth, watchVideo, canSelfBrowse,
  nextBrowseDelay, buildBrowsePrompt, buildScanPrompt, buildExtendedPrompt,
  parseScanVerdict, categoryGroup, categoryWeight, GAME_KEYWORDS
} from './bili-api.js';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import { stripLeadingMetaMarker, stripLeadingMetaMarkers } from './meta-marker.js';
import { extractQuotedMedia, buildReplyText, reserved2MediaFetchHint, inlineMediaFactHint } from './quoted-media.js';
// 拍一拍目标解析：支持 latest / 昵称，避免模型在没有 QQ 号时复用旧号（见 poke-target.js 顶部事故说明）。
import { resolvePokeTarget, isSymbolicPokeRef } from './poke-target.js';
// 分享卡片（B 站/小红书/音乐/位置）：解析标题与封面，见 share-card.js 顶部说明。
import { parseShareCard, formatShareCard, coverUrlOf, extractShareCards } from './share-card.js';
import { crawlUrl, crawlAigengtu, saveStickerImage, isAigengtuUrl } from './web-crawler.js';
// 群友功能菜单图（HTML+CSS → Chrome 无头截图），见 feature-menu.js 顶部说明。
import { renderFeatureMenu } from './media-tools-api.js';
import { parseGitHubUrl, extractGitHubUrl, screenshotGitHubRepo } from './media-tools-api.js';
import { describeJoinRequest, createJoinQueue, DEFAULT_TTL_MS as JOIN_TTL_MS } from './join-request.js';
import { CREDENTIAL_ITEMS, maskValue } from './credentials-doc.js';
import { TOOL_FLAGS, toolNamesOf, groupedToolFlags } from './tool-flags.js';
import { aggregateTokenUsage, humanTokens, dayKey } from './token-usage.js';
import { buildTokenReport, summarizeTokenReport } from './media-tools-api.js';
import { renderTokenReport, pruneTokenReportCache } from './media-tools-api.js';
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
} from './slang-api.js';
import {
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  markStickerUsed,
  writeStickerCacheImage
} from './stickers-api.js';
import { createStickerService } from './sticker-service.js';
// 表情包主动要求：按本轮语气挑候选（见模块顶部说明）
import { pickStickerCandidates, buildStickerNudge, moodOfText } from './stickers-api.js';
import { createConsoleServer } from './console-server.js';
import { createAdminCommands, isAdminCommand, canBypassAdmission, rawTextOfMessage } from './admin-commands.js';
import { createContextRecovery, isContextOverflowError, rotateContextSession } from './context-recovery.js';
import { createJsonStore } from './state/store.js';
import { createSessionHistory } from './session-history.js';
import { createSessionGap, normalizeGapNoticeConfig } from './session-gap.js';
import {
  normalizeSharedMemoryConfig,
  mergeEpisodeToSharedMemory,
  formatSharedMemoryForWake
} from './shared-memory-api.js';
import { createTokenFuse } from './token-fuse.js';
import { needsNewSession } from './pipeline/session-generation.js';
import { createSessionService } from './session-service.js';
import { createSocialService } from './social-service.js';
import { createTaskService } from './task-service.js';
import { createJoinRequestService } from './join-request-service.js';
import { createTokenService } from './token-service.js';
import { createDshEventPump } from './pipeline/dsh-events.js';
import { identityTagOf, senderDisplayName, groupRoleOf, isOwnerSender, isOwnerTurn as isOwnerTurnPure, buildMediaHint, buildIncomingPrompt } from './pipeline/message-format.js';
import { segmentsToText, extractMediaFromSegments } from './pipeline/segments.js';
import { normalizeMessagesInput } from './pipeline/text-normalize.js';
import { createSendQueue } from './pipeline/send-queue.js';
import { createWakePromptBuilder, findPendingCallers, wakePriorityV2 } from './pipeline/wake.js';
import { createQQSender } from './pipeline/qq-send.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const CONVERSATION_ROLE_FILE = path.join(STATE_DIR, 'conversation-roles.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
const socialStateStore = createJsonStore({
  file: SOCIAL_V2_FILE,
  version: 1,
  defaults: () => ({ paused: false, conversations: {} }),
  log: (m) => log(m)
});
// Token 用量统计（每日更新）：聚合结果 + 每会话文件的扫描缓存
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.json');
// 会话映射历史：token 统计把轮换前的旧 sessionId 仍归属到原 QQ 会话
const SESSION_HISTORY_FILE = path.join(STATE_DIR, 'session-history.json');
// 加好友/入群邀请的待裁决队列（落盘，重启不丢）
const JOIN_REQUESTS_FILE = path.join(STATE_DIR, 'join-requests.json');
// 上下文持久化（Phase 0/1）：情节摘要 + DSH 压缩摘要，独立目录，不塞进 social-v2.json
const CONTEXT_DIR = path.join(STATE_DIR, 'context');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const STICKER_CACHE_DIR = path.join(STATE_DIR, 'sticker-cache');
const IMAGE_LIB_DIR = path.join(STATE_DIR, 'image-lib');
// 控制台「选择文件/文件夹」同一时刻只允许一个原生对话框，避免连点叠出多个窗口
let pickPathBusy = false;
// 插件运行时退出清理（main 内初始化；信号处理器在顶层，不能直接拿到 main 的局部变量）
let pluginRuntimeForShutdown = null;
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

// 语音"概率替换"的默认触发率来自 src/tts.js（桥接/控制台/插件共用同一来源）。
// 注意：**模型主动要求发**（qq_send_voice）不受这个概率影响——
// 群友明确说"发个语音"就该发，那里只有每小时的条数上限。

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
const roleStateStore = createJsonStore({
  file: ROLE_STATE_FILE,
  version: 1,
  defaults: () => ({ role: null, mode: 'active' })
});
function readRoleState() {
  return { ...roleStateStore.read() };
}
function writeRoleState(role, mode) {
  roleStateStore.write({ role: role ?? null, mode: mode ?? 'active' });
}
// 会话级人格覆盖：{ version:1, overrides: { "group:123": "角色名" } }。
// 未配置的会话回退 state/current-role.json 的全局默认角色。
// reloadOnMtime 保留控制台/外部编辑后即时生效的行为。
const conversationRoleStore = createJsonStore({
  file: CONVERSATION_ROLE_FILE,
  version: 1,
  reloadOnMtime: true,
  defaults: () => ({ version: 1, overrides: {} })
});
function readConversationRoles() {
  const raw = conversationRoleStore.read();
  const overrides = raw && typeof raw.overrides === 'object' && raw.overrides ? raw.overrides : {};
  return { ...overrides };
}
function writeConversationRole(key, role) {
  const overrides = { ...readConversationRoles() };
  if (role) overrides[key] = role; else delete overrides[key];
  conversationRoleStore.write({ version: 1, overrides });
}
function roleExists(name) {
  const safe = sanitizeRoleName(name);
  if (!safe || safe !== String(name ?? '').trim()) return false;
  return fs.existsSync(path.join(ROOT, 'roles', safe + '.md'));
}
/** 当前会话实际生效的角色：本会话 override 优先，否则全局默认。 */
function roleFor(key) {
  const overrides = key ? readConversationRoles() : {};
  const override = key ? overrides[key] : null;
  if (override && roleExists(override)) return override;
  const fallback = readRoleState().role;
  return fallback && roleExists(fallback) ? fallback : null;
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
// ── 配置 ────────────────────────────────────────────────────────────────────
// 启动时由 loadConfig 填充：未知键与使用默认值的字段数，供启动日志汇总。
let configReport = { warnings: [], missing: 0 };
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

  // 非白名单群的 @ 提示：预设话术直接回，不调用 DSH（用户 2026-10-23 要求）。
  cfg.socialV2.whitelistNotice = {
    enabled: true,
    cooldownMs: 10 * 60 * 1000,
    messages: [],
    ...(cfg.socialV2?.whitelistNotice ?? {})
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

  // 配置校验：类型错误直接拒绝启动（给出字段路径），未知键只告警。
  const report = validateConfig(file);
  if (report.errors.length) {
    const lines = report.errors.slice(0, 10)
      .map((e) => `  - ${e.path}: 期望 ${e.expected}，实际 ${e.got}`);
    throw new Error(`配置校验失败（${report.errors.length} 处）：\n${lines.join('\n')}`);
  }
  configReport = { warnings: report.warnings, missing: report.missing.length };

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
const sessionsStateStore = createJsonStore({
  file: STATE_FILE,
  version: 1,
  defaults: () => ({ sessions: {}, sessionMeta: {} }),
  log: (m) => log(m)
});
let state = { sessions: {} };
function loadState() {
  const loaded = sessionsStateStore.read();
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') {
    state = loaded;
    if (!state.sessionMeta || typeof state.sessionMeta !== 'object') state.sessionMeta = {};
  } else {
    state = { sessions: {}, sessionMeta: {} };
  }
}
function saveState() {
  sessionsStateStore.write(state);
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
// R3-3：命名定时任务统一托管；启动/暂停/恢复/手动触发都走 taskService。
const taskService = createTaskService({ log: (m) => log(`[task] ${m}`) });
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
// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
// 实现在 quoted-media.js（与「引用消息里的图」共用同一份判定，也便于离线回归测试）。
//
// 分享卡片的**封面图**也作为一项 media 加进来：这样 qq_get_message_images 能直接
// 看到封面（fetchOneBotImage 已支持只用 media.url 取图），无需另写取图路径。
// 注意 cover 项没有 file、只有 url，所以判断「有无媒体」时不能只看 file。

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();

  // 配置摘要：一眼看出关键能力是否开启，以及有多少字段在用默认值。
  {
    const s = configSummary(cfg);
    log(`[配置] DSH ${s.dsh} | 控制台 :${s.consolePort} | 图库 ${s.images ? '开' : '关'} | 语音 ${s.tts ? '开' : '关'} | B站 ${s.bili ? '开' : '关'} | 超分 ${s.upscale ? '开' : '关'} | 工具 ${s.toolsOn}/${s.toolsTotal}`);
    if (configReport.missing) log(`[配置] ${configReport.missing} 个字段未填写，使用默认值`);
    if (configReport.warnings.length) {
      log(`[配置] 发现 ${configReport.warnings.length} 个未知字段（可能是拼写错误或新版本字段）：${configReport.warnings.slice(0, 8).join(', ')}`);
    }
  }

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

  // 会话映射历史：首次启用时登记当前映射，并从已有的上下文压缩记录回填旧 sessionId。
  // 这两步都只读本地文件，不影响启动；摘要器记账与 token 报表都依赖它归属旧会话。
  const sessionHistory = createSessionHistory({ file: SESSION_HISTORY_FILE, log });
  sessionHistory.adoptCurrent(state.sessions);
  sessionHistory.backfillFromContext(CONTEXT_DIR);
  // 记忆断层：独立运行状态，不被 reset/上下文清理删除。
  const sessionGap = createSessionGap({ file: path.join(STATE_DIR, 'session-gap.json'), log });

  // 上下文超限恢复器：识别 DSH 的 CONTEXT_WINDOW_EXCEEDED / prompt_too_long，
  // 摘除中毒会话并用新会话重试一次。只认明确错误码/固定文案，避免误判普通 context 事件。
  const contextRecovery = createContextRecovery({
    rotateSession: rotateSessionForContextOverflow,
    buildWakePrompt: (key) => buildWakePromptV2(key, 'contextRecovery'),
    deliverPrompt: (key, prompt) => deliverPrompt(key, prompt, { contextRecovery: true }),
    notifyOwnerOfError,
    appendActivity,
    log,
    cooldownMs: 30 * 60 * 1000,
    retryDelayMs: 1000
  });

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
  const slangSessionStore = createJsonStore({
    file: SLANG_SESSION_FILE,
    version: 1,
    defaults: () => ({ sessionId: null })
  });
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  const stickerService = createStickerService({
    cfg,
    file: STICKER_FILE,
    cacheDir: STICKER_CACHE_DIR,
    stateDir: STATE_DIR,
    request: (action, params) => bot.request(action, params),
    getSocialV2State: (key) => getSocialV2State(key),
    fetchOneBotImage: (media) => fetchOneBotImage(media),
    fetchFaceMedia: (media) => fetchFaceMedia(media),
    shrinkStickerForUpload: (buffer, opts) => shrinkStickerForUpload(buffer, opts),
    uploadMaxBytes: STICKER_UPLOAD_MAX_BYTES,
    uploadTargetBytes: STICKER_UPLOAD_TARGET_BYTES,
    log
  });

  // ── 图库（按需取图发送）────────────────────────────────────────────────
  // 从外部图源拉图落盘，群友要求时取本地图发送；元数据（画师/出处）随图标注。
  const IMAGE_FETCH_STATE_FILE = path.join(STATE_DIR, 'image-fetch-state.json');
  const STYLE_CENTER_FILE = path.join(STATE_DIR, 'style-center.json');
  const imageFacade = createImageFacade({
    cfg,
    imageLibDir: cfg.socialV2?.images?.libDir ? String(cfg.socialV2.images.libDir) : IMAGE_LIB_DIR,
    imageFetchStateFile: IMAGE_FETCH_STATE_FILE,
    styleCenterFile: STYLE_CENTER_FILE,
    imageFetchUA: IMAGE_FETCH_UA,
    sourceDownloadHeaders: SOURCE_DOWNLOAD_HEADERS,
    log: (m) => log(m)
  });
  const imageStore = imageFacade.imageStore;
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
  function imagesEnabled() {
    return imageFacade.imagesEnabled();
  }

  function startSentSweep() {
    return imageFacade.startSentSweep();
  }

  async function refreshImageLib(opts = {}) {
    return imageFacade.refreshImageLib(opts);
  }

  const imageRequestService = createImageRequestService({
    cfg,
    imageStore,
    imageFetchUA: IMAGE_FETCH_UA,
    sourceDownloadHeaders: SOURCE_DOWNLOAD_HEADERS,
    log: (m) => log(m)
  });
  const imageSendTimes = imageRequestService.imageSendTimes;
  const lastSentImage = imageRequestService.lastSentImage;
  const imageFeedbackGate = imageRequestService.imageFeedbackGate;
  const sourceHints = imageRequestService.sourceHints;
  // 「贴表情」的每会话限流（模型自主决定贴不贴，但连贴由桥接拦）。
  const emojiReactGate = createReactionGate({
    cooldownMs: Math.max(0, Number(cfg.socialV2?.emojiReact?.cooldownMs) || 60 * 1000),
    maxPerHour: Math.max(0, Number(cfg.socialV2?.emojiReact?.maxPerHour) || 15)
  });

  function sourcesWithHint(key, explicit) { return imageRequestService.sourcesWithHint(key, explicit); }
  function imageSendAllowed(key, opts = {}) { return imageRequestService.sendAllowed(key, opts); }
  function normalizeSourceFilter(raw) { return imageRequestService.normalizeSourceFilter(raw); }
  function sourceFilterForPick(filter) { return imageRequestService.sourceFilterForPick(filter); }
  function groupImageOpts() { return imageRequestService.groupImageOpts(); }
  function imagePreflightV2(tags, sources, key = '') { return imageRequestService.preflight(tags, sources, key); }
  async function archiveImage(entry) { return imageRequestService.archive(entry); }
  function imageAnnotation(entry) { return imageRequestService.annotation(entry); }
  // 发送工厂在启动依赖就绪后绑定；函数声明保留给较早创建的路由/反馈回调。
  function sendImageV2(key, options) { return imageSender.sendImageV2(key, options); }

  function stickerEnabled() {
    return stickerService.enabled();
  }

  function saveStickerStoreSafe() {
    return stickerService.saveSafe();
  }

  async function syncStickerLibrary(force = false) {
    return stickerService.sync(force);
  }

  async function listStickersForV2(query = '', count = 48, force = false) {
    return stickerService.list(query, count, force);
  }

  async function getStickerImageData(stickerId) {
    return stickerService.getImageEntry(stickerId);
  }

  function applyStickerNoteV2(stickerId, note, tags, usage) {
    return stickerService.applyNote(stickerId, note, tags, usage);
  }

  async function setStickerRemarkV2(stickerId, remark) {
    return stickerService.setRemark(stickerId, remark);
  }

  async function deleteStickerV2(stickerId) {
    return stickerService.remove(stickerId);
  }

  async function collectStickerV2(key, messageRef, remark) {
    return stickerService.collect(key, messageRef, remark);
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
    const saved = slangSessionStore.read();
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
    slangSessionStore.write({ sessionId: slangLearnerSessionId });
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
    slangSessionStore.clearCache();
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
  // sessionId -> { turn, turnId }：当前正在进行的 DSH 回合。turnId 用于把“本回合已 @”/
  // B站 waiter 等状态绑定到具体回合，而不是只按 sessionId 猜（同一 session 的相邻回合会互相污染）。
  const currentTurnBySession = new Map();
  // 本回合已自动 @ 过的会话（turnId，旧版无 turnId 时退回 sessionId → 上次 @ 的时间戳）。
  //
  // 为什么需要：模型回同一个人时常常**分多次调用** qq_send_message（实测 17:55:43 /
  // 17:55:56 / 17:56:09 三次单条发送），而 autoAt 每次都会独立掷骰。
  // 单次调用内部本来就只有第一条带 @（sendMessagesV2 里 `i === 0` 限定），
  // 但跨调用会叠加，同一个人可能连着被 @ 两三次——比不 @ 更像催债。
  // 有了这个标记：**一个回合内最多 @ 一次**。
  const autoAtTurnDone = new Map(); // sessionId#turn -> 时间戳
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

  // 会话级 Token 熔断（二期）：默认关闭；只在 assistant/message 的 usage 上累计，
  // 达到阈值后由 scheduleWakeV2 / sendWakePromptV2 / B 站自主刷的闸门拦截自动行为。
  const tokenFuse = createTokenFuse({
    stateDir: STATE_DIR,
    getConfig: () => cfg.socialV2?.tokenFuse || {},
    resolveKey: (sessionId) => reverse.get(sessionId) || sessionHistory.get(sessionId) || '',
    notifyOwner: (key, title, detail, extra) => notifyOwnerOfError(key, title, detail, extra),
    appendActivity,
    log
  });
  process.on('SIGINT', () => { try { tokenFuse.flush(); } catch {} });
  process.on('SIGTERM', () => { try { tokenFuse.flush(); } catch {} });

  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // R3-1：会话映射/代际/并发创建收进 session-service；bridge 只保留编排。
  async function createDshSessionForService({ dir, preset }) {
    let lastError = null;
    // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
    for (const withPreset of [true, false]) {
      try {
        const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
        if (wsValue.created && cfg.workspaceTitle) {
          await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
        }
        const params = { workspaceId: wsValue.workspace.workspaceId };
        if (withPreset && preset) params.agentPreset = preset;
        const value = unwrap(await api.sessions.create(params), 'session.create');
        if (value?.sessionId) return value.sessionId;
      } catch (error) {
        lastError = error;
      }
    }
    log(`归组创建失败（${lastError?.message}），回退无参创建`);
    const value = unwrap(await api.sessions.create({}), 'session.create');
    return value.sessionId;
  }

  const sessionService = createSessionService({
    state,
    reverse,
    sessionPromises,
    getEpoch: () => sessionEpoch,
    getMode: () => currentMode,
    getPreset: (key, mode) => modePreset(key, mode, cfg) ?? '',
    getSessionDir: () => (cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents')),
    needsNewSession,
    createDshSession: createDshSessionForService,
    archiveSession: (sessionId) => api.workspace.archiveSession({ sessionId }),
    ensureVisionModel,
    retireForModeChange: (key, oldSessionId, oldMeta, desired) => retireSessionForModeChange(key, oldSessionId, oldMeta, desired),
    sessionHistory,
    saveState,
    log,
    now: Date.now
  });

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
  function privateAllowed(id, cfg) { return privateAllowedPure(id, cfg, friendIds); }
  function modeAllowed(key, kind, id, cfg, mode) { return modeAllowedPure(key, kind, id, cfg, mode, friendIds); }

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
    return isOwnerTurnPure({
      ownerQQ: cfg.ownerQQ,
      state: getSocialV2State(key),
      windowMs: cfg.socialV2?.adminCommandWindowMs,
      now: Date.now()
    });
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
  

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  const sendQueue = createSendQueue();
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
  let errorService = null;
  async function handleUpstreamError(...args) { return errorService?.handleUpstreamError(...args) ?? false; }
  function notifyOwnerOfError(...args) { return errorService?.notifyOwnerOfError(...args); }
  errorService = createErrorService({
    cfg,
    errorNotifier,
    sendToQQ: (...args) => sendToQQ(...args),
    log,
    appendActivity,
    contextDisplayName: (...args) => contextDisplayName(...args),
    buildOwnerReport,
    buildOwnerNotice,
    condenseUpstreamDetail,
    classifyUpstreamError,
    pickMessage,
    healScriptFor,
    healDshConfig
  });

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

  // 分条发送：与 sendToQQ 共用本会话的发送队列，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
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
        || 'C:/SnowLuma/data/sys-face-catalog.json';
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
  const MAX_MEDIA_COUNT = 5;
  const MAX_MEDIA_BYTES = Math.max(1024 * 1024, Number(cfg.socialV2?.media?.maxMessageBytes) || 8 * 1024 * 1024);
  const MAX_MEDIA_PIXELS = 64_000_000;
  const MAX_MEDIA_STORE_PER_KEY = 500;
  let mediaService = null;
  function mimeFromBuffer(buf) { return mediaService?.mimeFromBuffer(buf) ?? 'image/jpeg'; }
  function mimeFromUrl(url, fallback = 'image/jpeg') { return mediaService?.mimeFromUrl(url, fallback) ?? fallback; }
  function getImageDimensions(buf) { return mediaService?.getImageDimensions(buf) ?? null; }
  async function fetchOneBotImage(media) { return mediaService?.fetchOneBotImage(media) ?? null; }
  async function fetchFaceMedia(media) { return mediaService?.fetchFaceMedia(media) ?? { text: '' }; }
  async function resolveMediaList(mediaList) { return mediaService?.resolveMediaList(mediaList) ?? []; }
  async function fetchMediaData(mediaList, opts = {}) { return mediaService?.fetchMediaData(mediaList, opts) ?? []; }

  function mediaHintFor(key, messageRef, mediaList) {
    return buildMediaHint({ mode: currentMode, key, messageRef, mediaList });
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
      const currentTurn = sid ? currentTurnBySession.get(sid) : null;
      const turnId = currentTurn?.turnId || '';
      const turnStart = sid ? Number(v2TurnStartAt.get(sid)) || 0 : 0;
      const lastAutoAtTurn = sid ? Number(autoAtTurnDone.get(turnId || sid)) || 0 : 0;
      if (sid) {
        if (turnId) {
          if (lastAutoAtTurn > 0) {
            log(`[自动@] ${key} 跳过：本回合已 @ 过（回多条只在第一条点名）`);
            return null;
          }
        } else if (turnStart > 0) {
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
        autoAtTurnDone.set(turnId || sid, now);
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
    const stickerEntries = stickerService.getEntries();
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

  /** 语音韵律参数由 TTS 插件现读配置；桥接只保留薄包装供控制台/发送层调用。 */
  function ttsSpeechParams() {
    return pluginRuntime?.ttsSpeechParams?.() ?? {};
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
    return sessionService.ensureSession(key);
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
  // 2026-10-22 事故（group:100002007）：账号昵称是 `dsh`，群名片是 `?！哦鲸鲸  ? !`，
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
    const role = roleFor(key);
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
      // 白名单/管理员里也可能有非好友 QQ，一并查昵称（控制台 10 号卡片要显示）。
      const extraPrivateIds = [
        ...(Array.isArray(cfg.allow?.private) ? cfg.allow.private : []),
        ...(Array.isArray(cfg.deny?.private) ? cfg.deny.private : []),
        cfg.ownerQQ,
      ].map((x) => String(x ?? '').trim()).filter(Boolean);
      const missing = [...new Set([
        ...[...socialV2.conversations.keys()]
          .filter((k) => k.startsWith('private:'))
          .map((k) => k.slice('private:'.length)),
        // 历史会话可能已不在 socialV2.conversations 里，但 /api/sessions 仍会列出；
        // 一并查昵称，避免会话映射卡只显示 QQ 号。
        ...Object.keys(state.sessions ?? {})
          .filter((k) => k.startsWith('private:'))
          .map((k) => k.slice('private:'.length)),
        ...extraPrivateIds,
      ])].filter((uid) => uid && !next.privates.has(uid));
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

  // 跨会话人物记忆配置：默认开启（2026-10-25 用户选择），但控制台可随时关闭。
  function sharedCfg() {
    return normalizeSharedMemoryConfig(cfg.socialV2?.sharedMemory || {});
  }

  function gapNoticeCfg() {
    return normalizeGapNoticeConfig(cfg.socialV2?.gapNotice || {});
  }

  // Phase 3 P0：上下文检索索引。按 journal 字节数 + episode 最后时间做轻量缓存，
  // 新消息落盘或新 episode 生成后会自动重建；纯内存，不引入外部依赖。
  const recallIndexCache = new Map(); // key -> { sig, index }
  function getRecallIndexV2(key) {
    const js = journalStats(STATE_DIR, key);
    const episodes = loadEpisodes(STATE_DIR, key, 300);
    const sig = `${js.bytes}:${episodes.length}:${Number(episodes.at(-1)?.createdAt) || 0}`;
    const hit = recallIndexCache.get(key);
    if (hit && hit.sig === sig) return hit.index;
    const messages = loadContextMessages(STATE_DIR, key, { limit: 3000 });
    const index = buildMemoryIndex({ messages, episodes });
    recallIndexCache.set(key, { sig, index });
    if (recallIndexCache.size > 100) {
      const [oldest] = recallIndexCache.keys();
      if (oldest) recallIndexCache.delete(oldest);
    }
    return index;
  }

  function recallMemoryV2(key, query, opts = {}) {
    return searchMemory(getRecallIndexV2(key), query, opts);
  }

  function clearRecallIndex(key) {
    if (key) recallIndexCache.delete(key);
    else recallIndexCache.clear();
  }

  /** 从当前未读/待回复消息生成检索查询，结果注入唤醒提示，作为固定记忆包的补充。 */
  function buildRecallLineV2(key, st) {
    try {
      const unread = Array.isArray(st?.unread) ? st.unread : [];
      const current = unread.filter((m) => m && !m.isSelf).slice(-3).map((m) => String(m.text || m.plain || '').trim()).filter(Boolean);
      const pendingText = String(st?.pendingWakeMessage?.text || st?.pendingWakeMessage?.plain || '').trim();
      const query = [pendingText, ...current].filter(Boolean).join('\n').slice(0, 1200);
      if (!query) return '';
      const excludeSeqs = [
        ...unread.map((m) => Number(m?.seq)).filter(Number.isFinite),
        Number(st?.pendingWakeMessage?.seq) || 0
      ].filter(Boolean);
      const started = Date.now();
      const results = recallMemoryV2(key, query, {
        limit: 4,
        minScore: 0.35,
        excludeSeqs
      });
      const elapsed = Date.now() - started;
      const line = formatRecallResults(results, { budgetChars: 620 });
      const m = contextMetrics.get(key) || {};
      m.lastRecallChars = line.length;
      m.lastRecallQuery = query.slice(0, 200);
      m.lastRecallSeqs = results.map((r) => r.seq).filter(Boolean);
      m.lastRecallMs = elapsed;
      m.lastRecallHits = results.length;
      m.lastRecallAt = Date.now();
      m.recallCalls = (Number(m.recallCalls) || 0) + 1;
      m.recallHitCalls = (Number(m.recallHitCalls) || 0) + (results.length ? 1 : 0);
      m.recallMsTotal = (Number(m.recallMsTotal) || 0) + elapsed;
      contextMetrics.set(key, m);
      try {
        appendRecallAudit(STATE_DIR, key, {
          at: Date.now(),
          query: query.slice(0, 200),
          ms: elapsed,
          hits: results.length,
          chars: line.length,
          results: results.map((r) => ({
            kind: r.kind,
            seq: r.seq,
            time: r.time,
            sender: r.sender,
            text: String(r.text || '').slice(0, 160),
            score: r.score
          }))
        }, contextCfg().recallAuditKeep);
      } catch (error) {
        log(`[上下文] 写检索审计失败：${error?.message ?? error}`);
      }
      if (!line) return '';
      return `${line}\n\n`;
    } catch (error) {
      log(`[上下文] 检索记忆失败：${error?.message ?? error}`);
      return '';
    }
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
      log,
      onUsage: (usage, meta) => recordSummarizerUsage(meta?.key, usage)
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
      let text = await summarizer(prompt, { key });
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
          text = await summarizer(shortPrompt, { key });
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
      let mergedMemory = null;
      try {
        mergedMemory = mergeEpisodeToMemory(STATE_DIR, key, ep, {
          keepPeople: c.longTermKeepPeople,
          keepFacts: c.longTermKeepFacts,
          keepThreads: c.longTermKeepThreads
        });
      } catch (error) {
        log(`[上下文] ${key} 长期记忆合并失败：${error?.message ?? error}`);
      }
      // P2：在本地长期记忆之后更新跨会话人物资料。只共享结构化偏好；
      // 失败不影响 episode（共享层是增强，不是主链路）。
      try {
        // recentMessages 没有 userId，journal 有。dedupe 时 recent 先入 map，
        // 可能把 journal 的 userId 盖掉，所以这里按 messageId/seq 反填一次。
        const userByRef = new Map();
        for (const m of journalPending) {
          const ref = msgKey(m);
          if (ref && m?.userId) userByRef.set(ref, String(m.userId));
        }
        const messagesForShared = (check.messages || []).map((m) => {
          const ref = msgKey(m);
          return { ...m, userId: m?.userId || userByRef.get(ref) || null };
        });
        const sharedResult = mergeEpisodeToSharedMemory(STATE_DIR, {
          key,
          episode: ep,
          messages: messagesForShared,
          localMemory: mergedMemory,
          cfg: sharedCfg(),
          now: ep.createdAt
        });
        if (sharedResult.changed) {
          log(`[共享记忆] ${key} 更新：人物 ${sharedResult.people} / 偏好 ${sharedResult.traits}`);
        }
      } catch (error) {
        log(`[共享记忆] ${key} 更新失败（不影响情节记忆）：${error?.message ?? error}`);
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

  /** 全局积压快照：待总结消息总数 + episode 总数（控制台趋势用）。 */
  function contextBacklogSnapshot() {
    let pending = 0;
    let episodes = 0;
    let conversations = 0;
    for (const [key, st] of socialV2.conversations.entries()) {
      if (!/^(group|private):\d+$/.test(key)) continue;
      const stats = contextStats(STATE_DIR, key);
      pending += Number(countContextPendingV2(
        key, st, Number(stats.lastEpisodeSeq) || 0, Number(stats.lastEpisodeEndAt) || 0
      )) || 0;
      episodes += Number(stats.episodes) || 0;
      conversations += 1;
    }
    return { at: Date.now(), pending, episodes, conversations };
  }

  /** 定时扫描所有会话；串行调用，避免同时打满网关。 */
  async function contextSweep() {
    log('[上下文] 自动扫描触发');
    // Token 熔断计数与上下文记忆是否启用无关：每 5 分钟顺手落盘/日切。
    try { tokenFuse.sweep(); } catch (error) { log(`[Token熔断] 定时落盘失败：${error?.message ?? error}`); }
    if (contextSweepRunning) {
      log('[上下文] 扫描跳过：上一轮仍在运行');
      return;
    }
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
        // 只把“本轮确实能生成”的会话放进候选。
        // 旧逻辑把从未总结、但只有 5~14 条消息的私聊也按 lastEpisodeAt=0 排在最前，
        // 每 5 分钟占满 6 个名额，makeEpisodeNow 又因 not-enough 直接返回——
        // 结果活跃大群永远轮不到，memory.json / episodes 一直停在旧时间。
        const every = Math.max(1, Number(c.episodeEveryMessages) || 40);
        const idleMin = Math.max(1, Number(c.episodeIdleMinMessages) || 15);
        const idleMs = Math.max(0, Number(c.episodeIdleMs) || 20 * 60 * 1000);
        const idleReady = pending >= idleMin
          && (Number(st.lastIncomingAt) || 0) > 0
          && now - Number(st.lastIncomingAt) >= idleMs;
        if (pending < every && !idleReady) continue;
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
      const chunksPerKey = Math.max(1, Math.min(10, Number(c.sweepChunksPerKey) || 2));
      const maxEpisodes = Math.max(1, Math.min(40, Number(c.sweepMaxEpisodesPerRun) || 12));
      let made = 0;
      log(`[上下文] 扫描：候选 ${candidates.length} 个，本轮处理 ${keys.length} 个（${keys.join('、') || '无'}），每会话最多 ${chunksPerKey} 段/总 ${maxEpisodes} 段`);
      for (const key of keys) {
        for (let i = 0; i < chunksPerKey && made < maxEpisodes; i += 1) {
          const r = await makeEpisodeNow(key);
          if (!r?.ok) break;
          made += 1;
          await sleep(150);
        }
        if (made >= maxEpisodes) break;
        await sleep(300);
      }
      try {
        const snap = contextBacklogSnapshot();
        appendBacklogSample(STATE_DIR, snap, c.backlogHistoryKeep);
        log(`[上下文] 扫描完成：本轮生成 ${made} 条情节；积压快照 ${snap.pending} 条 / ${snap.conversations} 个会话`);
      } catch (error) {
        log(`[上下文] 积压快照失败：${error?.message ?? error}`);
        log(`[上下文] 扫描完成：本轮生成 ${made} 条情节`);
      }
    } catch (error) {
      log(`[上下文] 扫描失败：${error?.message ?? error}`);
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
  let pluginRuntime = null; // 插件运行时（R3-4）；null = 未加载
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

  // 社交调度服务在稍后创建；social-state 加载阶段可能提前调用 schedule/setup 包装，
  // 此时应安全 no-op，等 DSH 就绪后再统一恢复定时器。
  let socialService = null;

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  const {
    normalizeSpeakerIdsV2, defaultWakeConfigV2, refreshDefaultWakeConfigV2, refreshAllDefaultWakeConfigsV2, hasExplicitEndV2, isSleepingConfigV2,
    preSleepWaitBlockedV2, computeWakeSafetyV2, ensureWakeableV2, getSocialV2State, loadSocialV2State, saveSocialV2State
  } = createSocialStateStore({
    stateStore: socialStateStore,
    cfg, socialV2, state, v2TurnStartAt, KNOWN_AGENT_TOKENS, seenForwardIds,
    SOCIAL_V2_FILE, readJsonSafe, atomicWriteJson, scheduleProactiveCheckV2, setupSleepTimerV2, log
  });

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
    const roleHint = currentRoleHint(key);
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
      const errText = String(error?.message ?? error);
      if (isContextOverflowError(errText)) {
        await contextRecovery.recover({ key, sessionId, error: errText, mode: currentMode, silent: !!opts.silent });
        return { ok: false, error: errText, recovered: true };
      }
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      if (isContextOverflowError(errText)) {
        await contextRecovery.recover({ key, sessionId, error: errText, mode: currentMode, silent: !!opts.silent });
        return { ok: false, error: errText, recovered: true };
      }
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
  const socialLoop = createSocialLoop({
    cfg,
    social,
    socialState,
    isSocialEnabled,
    enterActive,
    leaveActive,
    triggerActiveDurationExit,
    currentRoleHint: (...args) => currentRoleHint(...args),
    buildProactivePrompt,
    scheduleSocialReply,
    buildBatchPrompt,
    buildProbePrompt,
    appendSummary,
    isMustReplyText,
    state,
    log,
    randInt
  });
  function socialLoopTick() { return socialLoop.tick(); }

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
      const roleHint = currentRoleHint(k);
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

  // 当前角色扮演提示：按 roleFor(key) 取本会话 override（没有则全局默认），
  // 再读 roles/<角色>.md；由桥接注入到 QQ 群消息（群友无法通过对话修改）。
  // 缓存按角色名 + 角色文件 mtime，切换群人格不会串卡。
  const roleHintCache = new Map(); // roleName -> { key, hint }
  const currentRoleHint = createRoleHintReader({ ROOT, roleFor, roleHintCache, log });

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

  function currentRoleHintV2(key) {
    const raw = currentRoleHint(key);
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

  let replyTargetService = null;
  async function resolveReplyInfo(...args) { return replyTargetService?.resolveReplyInfo(...args) ?? null; }
  async function resolveReplyTargetV2(...args) { return replyTargetService?.resolveReplyTargetV2(...args) ?? null; }
  function isSymbolicReplyRef(ref) { return replyTargetService?.isSymbolicReplyRef(ref) ?? false; }

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
  let socialEngine = null;
  function appendSocialV2Message(...args) { return socialEngine?.appendSocialV2Message(...args); }
  function appendSocialV2Poke(...args) { return socialEngine?.appendSocialV2Poke(...args); }
  function recordSentMessagesV2(...args) { return socialEngine?.recordSentMessagesV2(...args); }
  socialEngine = createSocialEngine({
    cfg,
    getSocialV2State,
    saveSocialV2State,
    appendContextMessage,
    STATE_DIR,
    seenForwardIds,
    redactKnownTokensOnly,
    log
  });

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
    // 限流丢掉。2026-10-23 群 100002005 实测：owner 的「查下来源」被记成
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

  const { isAimedAtSelfV2, isContentRequestV2, rollComplyV2, latestOrderV2, buildTokenAskLineV2, buildComplyLineV2 } = createContentRequestPolicy({
    cfg, getSocialV2State, saveSocialV2State, log, getSelfNickname: () => selfNickname
  });

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
    return findPendingCallers(st, botAliasNamesV2(key, st));
  }

  // 第 4A 步：唤醒提示构建已抽到 src/pipeline/wake.js；
  // 这里只注入依赖，具体 prompt 文案/结构在 pipeline 里维护。
  const wakePrompts = createWakePromptBuilder({
    roleFor,
    currentRoleHintV2,
    getSocialV2State,
    cfg,
    getTtsEngine: () => ttsEngine,
    formatMemoryV2,
    contextCfg,
    stateDir: STATE_DIR,
    loadEpisodes,
    loadCompactions,
    loadLongTermMemory,
    formatMemoryPack,
    formatSharedMemoryForWake: (key, st, longTerm) => formatSharedMemoryForWake(STATE_DIR, {
      key,
      st,
      localMemory: longTerm,
      cfg: sharedCfg()
    }),
    buildGapNotice: (key) => sessionGap.buildNotice(key, gapNoticeCfg()),
    contextMetrics,
    log,
    buildRecallLine: buildRecallLineV2,
    formatParticipationV2,
    planStickerV2,
    getStickerEntries: () => stickerService.getEntries(),
    stickerCacheOpts: () => stickerService.cacheOpts(),
    buildStickerNudge,
    buildStickerStrategyHint,
    buildStickerContext,
    buildComplyLine: buildComplyLineV2,
    buildTokenAskLine: buildTokenAskLineV2,
    looksLikeUnfinished,
    findCallers: findCallersV2
  });

  function buildWakePromptV2(key, reason) {
    return wakePrompts.buildWakePrompt(key, reason);
  }

  function buildWakeReminderPromptV2(key) {
    const roleName = roleFor(key);
    // 与主唤醒提示一致：角色卡正文要直接给，不能只给名字。
    // 这条提醒是「模型忘了收尾」时补发的，措辞若只催"收尾"，它会直接
    // qq_set_wake_config 潜水，把还没回的 @ 一起带走。
    const roleCard = roleName ? currentRoleHintV2(key) : '';
    const roleLine = roleName
      ? `【当前角色】${roleName}\n\n${roleCard ? roleCard.trim() + '\n\n' : ''}`
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
  const tokenService = createTokenService({
    file: TOKEN_USAGE_FILE,
    getConfig: () => cfg,
    sessionHistory,
    state,
    contextMetrics,
    appendActivity,
    taskService,
    readJsonSafe,
    atomicWriteJson,
    log
  });

  function loadTokenUsage() { return tokenService.load(); }
  function recordSummarizerUsage(key, usage) { return tokenService.recordSummarizerUsage(key, usage); }
  function refreshTokenUsage(opts) { return tokenService.refresh(opts); }
  function startTokenUsageScheduler() { return tokenService.startScheduler(); }

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

  // 选群与浏览编排显式接线；模式、观看记录和时间戳必须实时读写。
  const { groupActivityScore, pickBiliSessionKey, maybeShareBiliVideo } = createBiliSharing({
    cfg, socialV2, isSessionAllowedInCurrentMode, isConversationBusyV2, shouldBlockSilentReply,
    sendToQQ: (...args) => sendToQQ(...args), askModelOnce, log, live: {
      get currentMode() { return currentMode; },
      get lastBiliShareAt() { return lastBiliShareAt; },
      set lastBiliShareAt(value) { lastBiliShareAt = value; }
    }
  });
  const { runBiliBrowse } = createBiliRuntime({
    cfg, socialV2, log, scheduleBiliBrowse, pickBiliSessionKey, biliBrowseState,
    isTokenFused: (key) => tokenFuse.isFused(key),
    rememberBiliInfo, judgeBiliScan, deliverBiliPrompt, maybeShareBiliVideo,
    live: {
      get biliMem() { return biliMem; },
      set biliMem(value) { biliMem = value; },
      get biliBrowsing() { return biliBrowsing; },
      set biliBrowsing(value) { biliBrowsing = value; },
      get lastBiliBrowseAt() { return lastBiliBrowseAt; },
      set lastBiliBrowseAt(value) { lastBiliBrowseAt = value; },
      get lastBiliSearchKeyword() { return lastBiliSearchKeyword; },
      set lastBiliSearchKeyword(value) { lastBiliSearchKeyword = value; },
      get biliAuth() { return biliAuth; },
      set biliAuth(value) { biliAuth = value; },
      get asrEngine() { return asrEngine; },
      set asrEngine(value) { asrEngine = value; },
      get lastBiliWatch() { return lastBiliWatch; },
      set lastBiliWatch(value) { lastBiliWatch = value; },
    }
  });

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
  // 初判使用独立 waiter，投递前登记，并只接受匹配 turn/turnId 的回填；
  // 超时或异常返回 null，调用方只保留第一段画面，不能阻塞整个浏览流程。
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
        biliJudgeCollectors.delete(sessionId);
        log(`[B站] 初判超时（${sessionId}，${Math.round(timeoutMs / 1000)}s），按"没判断出来"处理`);
        resolve('');
      }, timeoutMs);
      timer.unref?.();
      biliJudgeWaiters.set(sessionId, {
        token,
        turn: null,
        turnId: null,
        collector: null,
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
  /**
   * 向某个会话投一条 prompt，等模型回一段文本（复用初判那套 waiter 机制）。
   * 与 judgeBiliScan 的区别：这里只是要一句话，不解析 JSON。
   */
  async function askModelOnce(key, promptText, timeoutMs = 60000) {
    const sessionId = await ensureSession(key);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        biliJudgeWaiters.delete(sessionId);
        biliJudgeCollectors.delete(sessionId);
        resolve('');
      }, Math.max(5000, timeoutMs));
      timer.unref?.();
      biliJudgeWaiters.set(sessionId, {
        token: 'recommend',
        turn: null,
        turnId: null,
        collector: null,
        resolve: (t) => { clearTimeout(timer); biliJudgeWaiters.delete(sessionId); biliJudgeCollectors.delete(sessionId); resolve(t || ''); }
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

  async function sendWakePromptV2(key, reason, opts = {}) {
    if (cfg.socialV2?.enabled === false) return;
    if (currentMode !== 'reserved2' || socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    // 自动唤醒在熔断后一律拦住；控制台手动唤醒带 manual:true，管理员私聊也不受影响。
    if (!opts.manual && tokenFuse.isFused(key)) {
      log(`[Token熔断] 跳过唤醒 ${key}（${reason}）：会话已熔断`);
      appendActivity(`${key} [Token] 熔断中，已跳过自动唤醒（${reason}）`);
      return;
    }
    const st = getSocialV2State(key);
    // 兜底升级：只要未读里还有没答过的 @，这次唤醒就按 atMention 处理。
    // 否则 anyMessage/probability 定时器会在限流时被直接丢掉，@ 跟着一起饿死
    // （2026-10-23 群 100002005：owner 的「查下来源」就是这样被反复跳过的）。
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

  // R3-2：唤醒合并、回复检查、有限睡眠与主动机会交给 social-service。
  socialService = createSocialService({
    cfg,
    socialV2,
    getState: getSocialV2State,
    getMode: () => currentMode,
    isSessionAllowed: isSessionAllowedInCurrentMode,
    isBusy: isConversationBusyV2,
    isFused: (key) => tokenFuse.isFused(key),
    queuePendingWakeReason: queuePendingWakeReasonV2,
    ensureWakeable: ensureWakeableV2,
    sendWakePrompt: sendWakePromptV2,
    appendActivity,
    log
  });

  function cancelReplyCheckV2(key) {
    return socialService?.cancelReplyCheck(key);
  }

  function scheduleReplyCheckV2(key) {
    return socialService?.scheduleReplyCheck(key);
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

  function scheduleStartupBackfillV2() {
    return socialService?.scheduleStartupBackfill();
  }

  function scheduleWakeV2(key, reason) {
    return socialService?.scheduleWake(key, reason);
  }

  function setupSleepTimerV2(key) {
    return socialService?.setupSleepTimer(key);
  }

  function cancelProactiveCheckV2(key) {
    return socialService?.cancelProactiveCheck(key);
  }

  function scheduleProactiveCheckV2(key) {
    return socialService?.scheduleProactiveCheck(key);
  }

  function clearSocialV2Timers(key) {
    return socialService?.clearTimers(key);
  }

  function clearAllSocialV2Timers() {
    socialService?.clearAllTimers();
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
  // 非白名单群的 @：直接回一条预设话术（OneBot HTTP），不调用 DSH、不消耗 token。
  const whitelistNoticeCache = new Map(); // groupId -> { at, index, count }

  // 会话回合态共用同一个清理器；映射、群聊记忆等按调用场景另行处理。
  function clearSessionTracking(sessionId) {
    clearSessionTrackingState({ collectors, v2TurnStartAt, currentTurnBySession, autoAtTurnDone,
      sendToolSucceededSessions, pendingSendToolCalls, toolCallNames, social,
      biliJudgeCollectors, biliJudgeWaiters }, sessionId);
  }

  function clearAllSessionTracking() {
    const ids = new Set([...collectors.keys(), ...currentTurnBySession.keys(), ...v2TurnStartAt.keys(),
      ...biliJudgeWaiters.keys(), ...biliJudgeCollectors.keys()]);
    for (const sid of ids) clearSessionTracking(sid);
    autoAtTurnDone.clear();
  }

  /** 重置会话全部上下文与登记；返回旧会话是否存在。 */
  function resetSession(key) {
    const old = sessionService.detachMapping(key, 'reset');
    if (!old) return false;
    sessionEpoch++;
    clearSessionTracking(old);
    collectors.delete(old);
    sendToolSucceededSessions.delete(old);
    pendingSendToolCalls.delete(old);
    v2TurnStartAt.delete(old);
    currentTurnBySession.delete(old);
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
    return true;
  }

  /**
   * 模式 / agent preset 变化时停用旧 DSH 会话。
   * 旧会话的能力面（工具集/系统提示）不会随配置变化，继续复用会静默错配。
   * 只摘会话映射与 session 级状态，保留 socialV2 的群聊记忆。
   */
  async function retireSessionForModeChange(key, oldSessionId, oldMeta, desired) {
    if (state.sessions[key] === oldSessionId) delete state.sessions[key];
    if (state.sessionMeta) delete state.sessionMeta[key];
    if (reverse.get(oldSessionId) === key) reverse.delete(oldSessionId);
    clearSessionTracking(oldSessionId);
    collectors.delete(oldSessionId);
    v2TurnStartAt.delete(oldSessionId);
    currentTurnBySession.delete(oldSessionId);
    autoAtTurnDone.delete(oldSessionId);
    sendToolSucceededSessions.delete(oldSessionId);
    pendingSendToolCalls.delete(oldSessionId);
    toolCallNames.delete(oldSessionId);
    social.silentTurns.delete(oldSessionId);
    social.exitingSessions.delete(oldSessionId);
    biliJudgeCollectors.delete(oldSessionId);
    const judgeWaiter = biliJudgeWaiters.get(oldSessionId);
    if (judgeWaiter) {
      try { judgeWaiter.resolve(''); } catch {}
      biliJudgeWaiters.delete(oldSessionId);
    }
    sessionPromises.delete(key);
    const pe = pending.get(key);
    if (pe && pe.sessionId === oldSessionId) {
      clearTimeout(pe.timer);
      pending.delete(key);
      cancelPendingEntry(pe).catch(() => {});
    }
    try { await api.workspace.archiveSession({ sessionId: oldSessionId }); } catch (error) {
      log(`[会话] 归档旧会话失败 ${oldSessionId}：${error?.message ?? error}`);
    }
    sessionHistory.record(oldSessionId, key, 'mode');
    saveState();
    log(`[会话] ${key} 已停用旧会话 ${oldSessionId}（${oldMeta?.mode || '?'}/${oldMeta?.preset || '默认'} → ${desired.mode}/${desired.preset || '默认'}）`);
  }

  /**
   * 上下文超限时摘除中毒会话的映射与 session 级状态。
   *
   * 关键：**不动 socialV2.conversations**（bridge 侧的 recentMessages / episodes /
   * 长期记忆都在那里）。旧 DSH 会话的历史已经超过模型上限，换新会话后靠这些记忆
   * 重建人格与上下文，而不是把整个群的状态一起清掉。
   */
  function rotateSessionForContextOverflow(key, oldSessionId) {
    return rotateContextSession({
      state,
      reverse,
      collectors,
      v2TurnStartAt,
      currentTurnBySession,
      autoAtTurnDone,
      sendToolSucceededSessions,
      pendingSendToolCalls,
      toolCallNames,
      social,
      biliJudgeCollectors,
      biliJudgeWaiters,
      sessionPromises,
      pending,
      cancelPendingEntry,
      saveState,
      log,
      recordSessionHistory: (sessionId, key2, reason) => sessionHistory.record(sessionId, key2, reason),
      bumpSessionEpoch: () => { sessionEpoch++; }
    }, key, oldSessionId);
  }

  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  mediaService = createMediaService({
    cfg,
    bot,
    log,
    MAX_MEDIA_COUNT,
    MAX_MEDIA_BYTES,
    MAX_MEDIA_PIXELS
  });
  replyTargetService = createReplyTargetService({
    bot,
    segmentsToText,
    resolveGroupMemberName,
    extractForwardIds,
    seenForwardIds,
    keyForKindId,
    loadContextMessages,
    STATE_DIR,
    log
  });

  // 第 4B 步：QQ 发送通道抽到 src/pipeline/qq-send.js；
  // 这里只注入依赖。发送一律走 sendQueue（每会话队列）。
  const qqSend = createQQSender({
    sendQueue,
    log,
    sleep,
    randInt,
    cfg,
    text,
    escapeCqText,
    redactKnownTokensOnly,
    splitForQQ,
    withTimeout,
    SEND_TIMEOUT_MS,
    bot,
    recordSentMessage,
    planAutoAtV2,
    getTtsPlugin: () => pluginRuntime?.tts?.() ?? null,
    onebotSend,
    syncStickerLibrary,
    findSticker: (ref) => stickerService.find(ref),
    getStickerEntries: () => stickerService.getEntries(),
    setStickerEntries: (v) => { stickerService.setEntries(v); },
    validateFetchUrl,
    markStickerUsed,
    saveStickerStoreSafe,
    isFused: (key) => tokenFuse.isFused(key)
  });
  const sendToQQ = qqSend.sendToQQ;
  const sendBurstToQQ = qqSend.sendBurstToQQ;
  const sendMessagesV2 = qqSend.sendMessagesV2;
  const sendAsVoice = qqSend.sendAsVoice;
  const sendStickerV2 = qqSend.sendStickerV2;
  // 管理命令执行器：命令表/准入例外都在 admin-commands.js；
  // 这里只注入 bridge 的副作用。joinQueue 用 getter 是因为它在本函数后面才创建，
  // 但 handleIncoming 只会在 bot.connect() 之后被调用，届时已初始化。
  const adminCommands = createAdminCommands({
    cfg,
    configFile: path.join(ROOT, 'config.json'),
    sendToQQ,
    log,
    notifyOwnerOfError,
    readJsonSafe,
    atomicWriteJson,
    withTimeout,
    getGroupList: () => bot.getGroupList({ noCache: true }),
    deleteMessage: (messageId) => bot.deleteMessage(messageId),
    getSentMessages: (key) => sentMessages.get(key) ?? [],
    resetSession,
    getSessionId: (key) => state.sessions[key],
    isAllowed: (kind, id) => allowed(kind, id, cfg),
    roleFor,
    hasConversationRole: (key) => !!readConversationRoles()[key],
    getRoleState: () => readRoleState(),
    writeRoleState,
    writeConversationRole,
    sanitizeRoleName,
    roleExists,
    getOwnerQQ: () => cfg.ownerQQ,
    getJoinQueue: () => joinQueue,
    submitJoinDecision: (item, approve) => submitJoinDecision(item, approve),
    getTokenFuseStatus: () => tokenFuse.status(),
    resetTokenFuse: (key) => tokenFuse.resetKey(key),
    appendActivity
  });



  const imageSender = createImageSender({
    cfg, imagesEnabled, imageSendAllowed, sourcesWithHint, imageStore, sourceFilterForPick,
    groupImageOpts, refreshImageLib, imageAnnotation, recordSentMessage, onebotSend,
    log, lastSentImage, imageSendTimes, sendQueue,
    live: {
      get lastFetchCorrections() { return imageFacade.lastFetchCorrections; },
      set lastFetchCorrections(value) { imageFacade.lastFetchCorrections = value; }
    }
  });

  const maybeSendWhitelistNotice = createWhitelistNotifier({ getSelfQQ: () => selfQQ, whitelistNoticeCache, onebotSend, log });

  const incomingStages = createIncomingStages({
    getMode: () => currentMode, modeAllowed, maybeSendWhitelistNotice, refreshFriendList, log,
    resolveGroupMemberName, resolveReplyInfo, extractMediaFromSegments,
    transcribeIncomingVoice, messageMediaStore, MAX_MEDIA_STORE_PER_KEY,
    isQuoteTargetSelf, readRoleState, adminCommands, pending, handlePendingAnswer, appendActivity, sendToQQ
  });

  async function handleIncoming(kind, id, event, cfg) {
    const context = { key: convKey(kind, id), kind, id, event, cfg };
    if (!await incomingStages.admit(context)) return;
    const parsed = await incomingStages.parse(context);
    if (!parsed) return;
    Object.assign(context, parsed);
    if (await incomingStages.divert(context)) return;
    return dispatchIncoming(context);
  }

  const dispatchIncoming = createIncomingDispatcher({
    getMode: () => currentMode,
    isDshReady: () => dshReady,
    socialV2,
    api,
    sendToQQ,
    notifyOwnerOfError,
    senderDisplayName,
    groupRoleOf,
    ensureSelfCardV2,
    appendSocialV2Message,
    extractForwardIds,
    isAimedAtSelfV2,
    isContentRequestV2,
    getSocialV2State,
    saveSocialV2State,
    feedSlangWindow,
    appendActivity,
    handleImageFeedback,
    detectSourceRequest,
    sourceHints,
    scheduleWakeV2,
    evaluateWakeTriggerV2,
    currentRoleHint,
    buildIncomingPrompt,
    mediaHintFor,
    isSocialEnabled,
    appendRecentMessage,
    socialState,
    appendSummary,
    triggerActiveDurationExit,
    scheduleSocialReply,
    isDirectAddress,
    enterActive,
    buildContextBlock,
    deliverPrompt,
    queued,
    QUEUE_MAX,
    queuedHintAt,
    QUEUE_HINT_COOLDOWN_MS,
    ensureSession,
    enqueueForRetry,
    withSlangContext,
    resolveMediaList,
    auditAndSend,
    mdToPlain,
    log,
    DIRECTION_HINT,
    SPACE_SPLIT_HINT,
    SILENT_MARKER
  });

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

  // 第 4C 步：DSH 事件分派、回合收尾和断流恢复由独立模块处理。
  const { pumpMux } = createDshEventPump({
    api,
    reverse,
    collectors,
    currentTurnBySession,
    v2TurnStartAt,
    sendToolSucceededSessions,
    pendingSendToolCalls,
    toolCallNames,
    biliJudgeWaiters,
    biliJudgeCollectors,
    learnerSessions,
    learnerCollectors,
    learnerWaiters,
    getSlangLearnerSessionId: () => slangLearnerSessionId,
    getMode: () => currentMode,
    cfg,
    social,
    getSocialV2State,
    defaultWakeConfigV2,
    saveSocialV2State,
    pendingWakeKeys,
    wakeConfigUpdatedKeys,
    markReadCalledKeys,
    wakeConfigMissCount,
    activeWaits,
    clearAllPendingWakeLeases,
    armPendingWakeLease,
    disarmPendingWakeLease,
    ensureWakeableV2,
    deliverPrompt,
    buildWakeReminderPromptV2,
    wakePriorityV2,
    pendingWakeSnapshotFromJournalV2,
    scheduleWakeV2,
    SILENT_TURN_TIMEOUT_MS,
    contextRecovery,
    contextCfg,
    recordTokenUsage: (sessionId, usage) => tokenFuse.recordUsage(sessionId, usage),
    recordSessionProcessed: (key) => sessionGap.markProcessed(key),
    STATE_DIR,
    appendCompaction,
    contextMetrics,
    redactSensitiveText,
    sanitizeToolArgs,
    appendToolLog,
    isSendToolName,
    KNOWN_AGENT_TOKENS,
    shouldAuditKey,
    SENSITIVE_RE,
    isSilentMarker,
    SILENT_MARKER,
    isSocialEnabled,
    socialState,
    shouldBlockSilentReply,
    planSocialTimeline,
    sendBurstToQQ,
    sendToQQ,
    registerPending,
    handleUpstreamError,
    appendActivity,
    notifyOwnerOfError,
    log,
    sleep,
  });

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）


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
  const joinRequestService = createJoinRequestService({
    cfg,
    file: JOIN_REQUESTS_FILE,
    ttlMs: Math.max(30 * 1000, Number(cfg.socialV2?.joinRequest?.ttlMs) || JOIN_TTL_MS),
    getSelfQQ: () => selfQQ,
    setFriendAddRequest: (...args) => bot.setFriendAddRequest(...args),
    setGroupAddRequest: (...args) => bot.setGroupAddRequest(...args),
    getGroupMemberInfo: (...args) => bot.getGroupMemberInfo(...args),
    getStrangerInfo: (id) => bot.getStrangerInfo?.(id) ?? null,
    getGroupInfo: (id) => bot.getGroupInfo?.(id) ?? null,
    sendToQQ: (...args) => sendToQQ(...args),
    appendActivity,
    withTimeout,
    log
  });
  const joinQueue = joinRequestService.queue;
  async function isBotInGroupV2(groupId) { return joinRequestService.isBotInGroup(groupId); }
  async function submitJoinDecision(item, approve, reason = '') { return joinRequestService.submitDecision(item, approve, reason); }
  async function notifyJoinRequest(n, item) { return joinRequestService.notify(n, item); }
  async function handleJoinRequest(event) { return joinRequestService.handle(event); }

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
  taskService.define('joinRequestStartup', {
    kind: 'timeout',
    delayMs: 15000,
    run: () => {
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
    }
  });
  taskService.start('joinRequestStartup');

  // 定时清理超时请求并自动拒绝（fail-closed）。
  // 不能只在"下一条请求到来时"才清：那样最后一条会一直挂着。
  taskService.define('joinRequestSweep', {
    everyMs: 30 * 1000,
    run: () => {
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
    }
  });
  taskService.start('joinRequestSweep');

  // 上下文持久化（Phase 1）：启动 90 秒后补扫一次（把积压的最近消息总结成 episode），
  // 之后每 5 分钟扫一次。串行执行、失败只记日志，不影响消息收发。
  log('[上下文] 扫描定时器已启动（首次 90s，之后每 5 分钟）');
  taskService.define('contextSweep', {
    everyMs: 5 * 60 * 1000,
    initialDelayMs: 90 * 1000,
    run: () => contextSweep()
  });
  taskService.start('contextSweep');
  // 群名/昵称独立刷新：context-status 30 秒轮询只读缓存，不会每次都打 OneBot。
  taskService.define('contextNames', {
    everyMs: 5 * 60 * 1000,
    initialDelayMs: 10 * 1000,
    run: () => refreshContextNames(true)
  });
  taskService.start('contextNames');

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
  // 自重启时在**这里**再打一次启动完成标记（带着 PID 与来源）：
  // 前面那条"由控制台重启拉起"打在 connectDSH 之前，只说明进程起来了，
  // 不说明服务已经可用——排查时容易把"刚拉起"误读成"已就绪"。
  if (process.env.QQB_RESTARTED_BY) {
    log(`桥接已就绪（控制台自重启，PID ${process.pid}）`);
  }
  const biliBootstrap = createBiliBootstrap({
    cfg,
    root: ROOT,
    log,
    scheduleBiliBrowse,
    setBiliMem: (v) => { biliMem = v; },
    setBiliAuth: (v) => { biliAuth = v; },
    setAsrEngine: (v) => { asrEngine = v; }
  });
  biliBootstrap.start();

  // ── 插件运行时（R3-4）：核心只装配运行时，不直接创建宿主 ──────────────
  //
  // TTS 仍是第一个试点：插件自己探测 GPT-SoVITS、创建引擎、决定概率与发送语音。
  // 核心只提供窄服务（社交状态/语音文件/活动日志），不 import 插件实现。
  // 插件缺席或加载失败时，运行时返回 null，所有调用点自动回退成文字。
  pluginRuntime = createPluginRuntime({
    root: ROOT,
    log: (m) => log(m),
    getConfig: () => cfg,
    services: {
      social: { getState: getSocialV2State, save: saveSocialV2State },
      send: { voiceFile: onebotSendVoiceFile },
      activity: appendActivity
    }
  });
  pluginRuntimeForShutdown = pluginRuntime;
  try {
    await pluginRuntime.start();
    ttsEngine = pluginRuntime.ttsEngine();
    if (!pluginRuntime.tts()) log('[plugin] TTS 插件未加载；只发文字');
  } catch (error) {
    log(`[plugin] 运行时启动失败（不影响核心）：${error?.message ?? error}`);
    ttsEngine = null;
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
    taskService.define('friendListRefresh', {
      everyMs: FRIEND_LIST_TTL_MS,
      run: () => refreshFriendList({ force: true })
    });
    taskService.start('friendListRefresh');
  }

  // ── X（Twitter）按需拉取 ────────────────────────────────────────────────
  // 实现已迁到 plugins/x-posts/（R4.5-3）：插件构造 XMonitor 并暴露能力；
  // 插件缺席时 xMonitor 为 null，控制台相关端点回 503（P0 关闭时根本走不到）。
  const xMonitor = pluginRuntime?.xMonitor?.() ?? null;

  startDshWatch();
  createConsoleServer({
    ACTIVITY_LOG,
    CACHE_GROUPS,
    CREDENTIAL_ITEMS,
    DEFAULT_AUTO_AT,
    DEFAULT_ERROR_MESSAGES,
    DEFAULT_SOVITS_DIR,
    FEEDBACK_FILE,
    FORCE_WRAPUP_HINT,
    KNOWN_AGENT_TOKENS,
    MAX_MEDIA_BYTES,
    MAX_MEDIA_PIXELS,
    REACTION_EMOJIS,
    ROOT,
    SENSITIVE_RE,
    SLANG_STATUS,
    SOCIAL_V2_FILE,
    STATE_DIR,
    STICKER_CACHE_DIR,
    TOOL_FLAGS,
    TOOL_LOG_FILE,
    TTS_DEFAULT_PROBABILITY,
    WAIT_QUIET_CAP_MS,
    WAIT_TURN_MAX_COUNT,
    WAIT_TURN_MAX_MS,
    WAIT_WINDOW_MAX,
    WAIT_WINDOW_MS,
    activeWaits,
    allowSlangSubmit,
    allowed,
    api,
    appendActivity,
    appendFeedbackEntry,
    appendMemoryV2,
    applyPixivAuth,
    applyStickerNoteV2,
    archiveImage,
    atomicWriteJson,
    atomicWriteText,
    backfillLongTermMemory,
    biliBrowseState,
    biliInfoCache,
    bot,
    buildSlangContext,
    buildStickerContext,
    buildStickerStrategyHint,
    buildTokenReport,
    cancelAllSocialTimers,
    cancelPendingEntry,
    cancelReplyCheckV2,
    cancelSocialTimers,
    canonicalV2Key,
    cfg,
    cleanupSocialForModeChange,
    clearAllPendingWakeLeases,
    clearAllSocialV2Timers,
    clearSocialV2Timers,
    collectCacheItems,
    collectStickerV2,
    collectors,
    computeGapsV2,
    computeWakeSafetyV2,
    confirmedSlangListV2,
    contextCfg,
    contextDir,
    contextDisplayName,
    contextMetrics,
    contextStats,
    countContextPendingV2,
    crawlAigengtu,
    crawlUrl,
    createSlangEntry,
    crypto,
    currentRoleHint,
    currentRoleHintV2,
    deleteStickerV2,
    deliverPrompt,
    drainAllPromptQueues,
    drainPromptQueue,
    emojiCatalogIds,
    emojiReactGate,
    ensureSession,
    ensureWakeableV2,
    enterActive,
    escapeCqText,
    extractGitHubUrl,
    feedbackTimes,
    fetchMediaData,
    fetchVideoInfo,
    findCallersV2,
    findCjkSpaceWarning,
    findMessageMediaAsync,
    findSplitBoundaryWarning,
    flushSummaries,
    formatForwardResponse,
    formatMemoryV2,
    formatParticipationV2,
    formatStickerList,
    formatSummary,
    fs,
    getImageDimensions,
    getRecallIndexV2,
    clearRecallIndex,
    journalCoverage,
    readRecallAudit,
    recallAuditStats,
    readBacklogHistory,
    getSocialV2State,
    getStickerImageData,
    gitHubShotTimes,
    groupActivityScore,
    groupedToolFlags,
    http,
    humanBytes,
    humanSize,
    imagePreflightV2,
    imageSendAllowed,
    imageSendTimes,
    imageStore,
    imagesEnabled,
    invalidateSlangLearnerSession,
    isAigengtuUrl,
    isConversationBusyV2,
    isOwnerTurn,
    isSessionAllowedInCurrentMode,
    isSleepingConfigV2,
    isSymbolicPokeRef,
    isSymbolicReplyRef,
    joinQueue,
    journalStats,
    lastSentImage,
    leaveActive,
    listRoles,
    loadEpisodes,
    loadLongTermMemory,
    loadOrCreateConsoleToken,
    loadTokenUsage,
    log,
    longTermStats,
    looksLikeUnfinished,
    makeEpisodeNow,
    markReadCalledKeys,
    maskValue,
    mergeEvidence,
    messageMediaStore,
    mimeFromBuffer,
    mimeFromUrl,
    modeAllowed,
    normalizeMessagesInput,
    normalizeOwnerQQ,
    normalizePrivateMode,
    normalizeSourceFilter,
    normalizeSpeakerIdsV2,
    notifyOwnerOfError,
    onebotSendImageFile,
    onebotSendVideoFile,
    onebotSendVoiceFile,
    parseGitHubUrl,
    path,
    pending,
    pendingSendToolCalls,
    pendingWakeKeys,
    preSleepWaitBlockedV2,
    promptQueues,
    pruneTokenReportCache,
    publicSlangEntry,
    purgeCache,
    queueSlangTask,
    queued,
    queuedHintAt,
    readActivityTail,
    readConversationRoles,
    readFeedbackEntries,
    readJsonSafe,
    readRoleState,
    readToolLog,
    recordSentMessage,
    recordSentMessagesV2,
    redactKnownTokensOnly,
    refreshAllDefaultWakeConfigsV2,
    refreshContextNames,
    refreshFriendList,
    refreshImageLib,
    refreshTokenUsage,
    releaseLock,
    rememberBiliInfo,
    renderFeatureMenu,
    renderTokenReport,
    resolveBiliId,
    resolveGroupMemberName,
    resolvePokeTarget,
    resolveReplyInfo,
    resolveReplyTargetV2,
    reverse,
    reverseSearcher,
    roleExists,
    roleFor,
    runBiliBrowse,
    runSlangExtraction,
    runSlangResearch,
    safeFetchBuffer,
    sanitizeRoleName,
    saveSlangStore,
    saveSocialV2State,
    saveState,
    saveStickerImage,
    scheduleBiliBrowse,
    scheduleProactiveCheckV2,
    scheduleReplyCheckV2,
    screenshotGitHubRepo,
    searchGroupFiles,
    searchMemory,
    searchVideos,
    seenForwardIds,
    sendImageV2,
    sendMessagesV2,
    sendStickerV2,
    sendToQQ,
    sendToolSucceededSessions,
    sendWakePromptV2,
    sessionFileBytes,
    sessionPromises,
    setEmojiLike,
    setStickerRemarkV2,
    setupSleepTimerV2,
    shouldBlockSilentReply,
    slangExtractionCooldowns,
    slangResearchingIds,
    slangSubmitTimes,
    slangWindows,
    sleep,
    sniffImageMime,
    social,
    socialV2,
    sourcePageOf,
    state,
    stickerCacheOpts: () => stickerService.cacheOpts(),
    stickerEnabled,
    stripLeadingMetaMarker,
    stripLeadingMetaMarkers,
    suggestQuietMsV2,
    summarizeCache,
    summarizeGroupFiles,
    summarizeTokenReport,
    syncStickerLibrary,
    text,
    toolCallNames,
    toolNamesOf,
    ttsNum,
    ttsSpeechParams,
    unquoteJsonString,
    unwrap,
    v2TurnStartAt,
    validateEmojiId,
    waitTurnStats,
    waitTurnTotals,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    watchVideo,
    writeConversationRole,
    writeRoleState,
    writeStickerCacheImage,
    pluginHost: pluginRuntime?.host ?? null,
    taskService,
    xMonitor,
    live: {
      get asrEngine() { return asrEngine; },
      set asrEngine(value) { asrEngine = value; },
      get biliAuth() { return biliAuth; },
      set biliAuth(value) { biliAuth = value; },
      get biliBrowsing() { return biliBrowsing; },
      set biliBrowsing(value) { biliBrowsing = value; },
      get biliMem() { return biliMem; },
      set biliMem(value) { biliMem = value; },
      get biliNextDelay() { return biliNextDelay; },
      set biliNextDelay(value) { biliNextDelay = value; },
      get biliScheduledAt() { return biliScheduledAt; },
      set biliScheduledAt(value) { biliScheduledAt = value; },
      get biliTimer() { return biliTimer; },
      set biliTimer(value) { biliTimer = value; },
      get closedAgentPreset() { return closedAgentPreset; },
      set closedAgentPreset(value) { closedAgentPreset = value; },
      get contextNameCache() { return contextNameCache; },
      set contextNameCache(value) { contextNameCache = value; },
      get currentMode() { return currentMode; },
      set currentMode(value) { currentMode = value; },
      get dshReady() { return dshReady; },
      set dshReady(value) { dshReady = value; },
      get friendIds() { return friendIds; },
      set friendIds(value) { friendIds = value; },
      get imageFetchedAt() { return imageFacade.imageFetchedAt; },
      set imageFetchedAt(value) { imageFacade.imageFetchedAt = value; },
      get imageFetching() { return imageFacade.imageFetching; },
      set imageFetching(value) { imageFacade.imageFetching = value; },
      get lastBiliBrowseAt() { return lastBiliBrowseAt; },
      set lastBiliBrowseAt(value) { lastBiliBrowseAt = value; },
      get lastBiliSearchKeyword() { return lastBiliSearchKeyword; },
      set lastBiliSearchKeyword(value) { lastBiliSearchKeyword = value; },
      get lastBiliShareAt() { return lastBiliShareAt; },
      set lastBiliShareAt(value) { lastBiliShareAt = value; },
      get lastBiliWatch() { return lastBiliWatch; },
      set lastBiliWatch(value) { lastBiliWatch = value; },
      get lastForcedAgentStickerSync() { return stickerService.lastForcedAgentStickerSync; },
      set lastForcedAgentStickerSync(value) { stickerService.lastForcedAgentStickerSync = value; },
      get lastMode() { return lastMode; },
      set lastMode(value) { lastMode = value; },
      get pickPathBusy() { return pickPathBusy; },
      set pickPathBusy(value) { pickPathBusy = value; },
      get slangEntries() { return slangEntries; },
      set slangEntries(value) { slangEntries = value; },
      get stickerEntries() { return stickerService.getEntries(); },
      set stickerEntries(value) { stickerService.setEntries(value); },
      get stickerSyncedAt() { return stickerService.syncedAt; },
      set stickerSyncedAt(value) { stickerService.syncedAt = value; },
      get tokenUsage() { return tokenService.get(); },
      set tokenUsage(value) { tokenService.set(value); },
      get ttsEngine() { return ttsEngine; },
      set ttsEngine(value) { ttsEngine = value; }
    },
    ops: {
      clearSessionTracking, clearAllSessionTracking,
      recordSessionHistory: (sessionId, key, reason) => sessionHistory.record(sessionId, key, reason),
      tokenFuseStatus: () => tokenFuse.status(),
      resetTokenFuse: (key) => tokenFuse.resetKey(key),
      isTokenFused: (key) => tokenFuse.isFused(key),
      bumpSessionEpoch() { sessionEpoch++; }
    }
  });

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  try { taskService.stopAll(); } catch {}
  try { pluginRuntimeForShutdown?.stop(); } catch {}
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  try { taskService.stopAll(); } catch {}
  try { pluginRuntimeForShutdown?.stop(); } catch {}
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
