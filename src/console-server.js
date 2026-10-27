// 本地控制台与 MCP 回调 HTTP 服务。依赖由 bridge.js 显式注入，动态状态经 live 访问。
import {
  normalizeSharedMemoryConfig,
  sharedMemoryStats,
  listSharedPeople,
  forgetSharedPerson,
  clearSharedMemory
} from './shared-memory-api.js';
import { normalizeTokenFuseConfig, normalizeTokenFuseOverride, effectiveTokenFuseThresholds } from './token-fuse.js';
import { normalizeGapNoticeConfig } from './session-gap.js';
import { createConsoleRouter } from './console/router.js';
import * as overviewRoutes from './console/routes/00-overview.js';
import * as coreRoutes from './console/routes/01-core.js';
import * as slangRoutes from './console/routes/02-slang.js';
import * as accessRoutes from './console/routes/03-access.js';
import * as socialV1Routes from './console/routes/04-social-v1.js';
import * as tokenRoutes from './console/routes/05-token.js';
import * as configRoutes from './console/routes/06-config.js';
import * as activityRoutes from './console/routes/07-activity.js';
import * as socialReadRoutes from './console/routes/08-social-read.js';
import * as messagingRoutes from './console/routes/09-messaging.js';
import * as imageRoutes from './console/routes/10-images.js';
import * as stickerRoutes from './console/routes/11-stickers.js';
import * as waitRoutes from './console/routes/12-wait.js';
import * as forwardRoutes from './console/routes/13-forward.js';
import * as biliRoutes from './console/routes/14-bili.js';
import * as memoryRoutes from './console/routes/15-memory.js';
import * as contextRoutes from './console/routes/16-context.js';
import * as agentRoutes from './console/routes/17-agent.js';
import * as opsRoutes from './console/routes/18-ops.js';

/** 分域路由模块（顺序无关：每个模块声明自己的 method+path）。 */
const DOMAIN_ROUTES = [
  coreRoutes, slangRoutes, accessRoutes, socialV1Routes, tokenRoutes, configRoutes,
  activityRoutes, socialReadRoutes, messagingRoutes, imageRoutes, stickerRoutes,
  waitRoutes, forwardRoutes, biliRoutes, memoryRoutes, contextRoutes, agentRoutes, opsRoutes
];

export const AGENT_ALLOWED_PATHS = new Set([
  '/api/authorize/read',
  '/api/images/message',
  '/api/send/group',
  '/api/send/private',
  '/api/send/reply',
  '/api/socialV2/active-members',
  '/api/socialV2/archive-image',
  '/api/socialV2/bili-memory',
  '/api/socialV2/bili-record',
  '/api/socialV2/bili-search',
  '/api/socialV2/bili-watch',
  '/api/socialV2/collect-sticker',
  '/api/socialV2/crawl',
  '/api/socialV2/feedback',
  '/api/socialV2/fetch-x-posts',
  '/api/socialV2/forward-media',
  '/api/socialV2/forward-message',
  '/api/socialV2/github-shot',
  '/api/socialV2/group-file-stats',
  '/api/socialV2/group-files',
  '/api/socialV2/image-preflight',
  '/api/socialV2/image-source',
  '/api/socialV2/mark-read',
  '/api/socialV2/memory',
  '/api/socialV2/memory-append',
  '/api/socialV2/memory-clear',
  '/api/socialV2/memory-remove',
  '/api/socialV2/message-detail',
  '/api/socialV2/my-recent',
  '/api/socialV2/prompt',
  '/api/socialV2/react-message',
  '/api/socialV2/recall',
  '/api/socialV2/recent',
  '/api/socialV2/refresh-image-lib',
  '/api/socialV2/reject-image',
  '/api/socialV2/reverse-search',
  '/api/socialV2/self-image',
  '/api/socialV2/send-burst',
  '/api/socialV2/send-feature-menu',
  '/api/socialV2/send-image',
  '/api/socialV2/send-message',
  '/api/socialV2/send-poke',
  '/api/socialV2/send-sticker',
  '/api/socialV2/send-upscaled',
  '/api/socialV2/send-voice',
  '/api/socialV2/slang/query',
  '/api/socialV2/slang/submit',
  '/api/socialV2/state',
  '/api/socialV2/sticker-delete',
  '/api/socialV2/sticker-image',
  '/api/socialV2/sticker-list',
  '/api/socialV2/sticker-note',
  '/api/socialV2/sticker-remark',
  '/api/socialV2/token-report',
  '/api/socialV2/unread',
  '/api/socialV2/wait',
  '/api/socialV2/wake-config',
  '/api/status'
]);

export function isAgentRouteAllowed(pathname, method = 'GET') {
  if (pathname === '/api/socialV2/feedback' && method === 'GET') return false;
  return AGENT_ALLOWED_PATHS.has(pathname);
}

// 把 token-usage.json 的 sessionId 桶合成为「按 QQ 会话」的两套口径：
//   当前会话 = 映射里的 sessionId 对应的桶；累计 = 该 key 名下全部历史桶 + 摘要器桶。
// 轮换后旧 sessionId 的消耗不会从累计里消失，这是会话级统计的核心需求。
export function buildSessionUsageRows({ usage = {}, currentSessions = {}, displayName = () => '', today = '', scopeDay = '' } = {}) {
  const finish = (v = {}) => {
    const input = Number(v.input) || 0;
    const cacheRead = Number(v.cacheRead) || 0;
    const output = Number(v.output) || 0;
    const totalInput = input + cacheRead;
    return {
      input, cacheRead, output,
      reasoning: Number(v.reasoning) || 0,
      calls: Number(v.calls) || 0,
      totalInput,
      totalTokens: totalInput + output,
      cacheHitRate: totalInput > 0 ? Math.round((cacheRead / totalInput) * 1000) / 10 : 0
    };
  };
  const addInto = (target, source) => {
    target.input += Number(source?.input) || 0;
    target.cacheRead += Number(source?.cacheRead) || 0;
    target.output += Number(source?.output) || 0;
    target.reasoning += Number(source?.reasoning) || 0;
    target.calls += Number(source?.calls) || 0;
  };
  // 按日审阅：scopeDay 非空时，会话表的「当前 / 累计 / 摘要器」都只取那一天；
  // today 仍固定为真实今天（24 号卡的列不受日期下拉影响）。
  const scopeOf = (bucket) => (scopeDay ? (bucket?.days?.[scopeDay] || {}) : bucket);
  const rows = new Map();
  const unowned = [];
  const ensureRow = (key) => {
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        displayName: displayName(key) || key,
        sessionIds: [],
        current: finish({}),
        cumulative: { input: 0, cacheRead: 0, output: 0, reasoning: 0, calls: 0 },
        summarizer: { input: 0, cacheRead: 0, output: 0, calls: 0 },
        today: { input: 0, cacheRead: 0, output: 0, calls: 0 },
        firstAt: 0,
        lastAt: 0
      };
      rows.set(key, row);
    }
    return row;
  };
  for (const [sessionId, bucket] of Object.entries(usage.sessions || {})) {
    const key = String(bucket?.key || '');
    if (!key) {
      unowned.push({
        sessionId,
        key: null,
        ...finish(scopeOf(bucket)),
        firstAt: Number(bucket?.firstAt) || 0,
        lastAt: Number(bucket?.lastAt) || 0
      });
      continue;
    }
    const row = ensureRow(key);
    row.sessionIds.push(sessionId);
    addInto(row.cumulative, scopeOf(bucket));
    const firstAt = Number(bucket?.firstAt) || 0;
    const lastAt = Number(bucket?.lastAt) || 0;
    if (firstAt && (!row.firstAt || firstAt < row.firstAt)) row.firstAt = firstAt;
    if (lastAt > row.lastAt) row.lastAt = lastAt;
    if (String(currentSessions[key] || '') === sessionId) row.current = finish(scopeOf(bucket));
    const d = today ? bucket?.days?.[today] : null;
    if (d) {
      row.today.input += Number(d.input) || 0;
      row.today.cacheRead += Number(d.cacheRead) || 0;
      row.today.output += Number(d.output) || 0;
      row.today.calls += Number(d.calls) || 0;
    }
  }
  for (const [key, bucket] of Object.entries(usage.summarizer || {})) {
    if (!/^(group|private):\d+$/.test(key)) continue;
    const row = ensureRow(key);
    const scoped = scopeDay ? (bucket?.days?.[scopeDay] || {}) : bucket;
    row.summarizer.input += Number(scoped?.input) || 0;
    row.summarizer.output += Number(scoped?.output) || 0;
    row.summarizer.cacheRead += Number(scoped?.cacheRead) || 0;
    row.summarizer.calls += Number(scoped?.calls) || 0;
    addInto(row.cumulative, scoped);
    const d = today ? bucket?.days?.[today] : null;
    if (d) {
      row.today.input += Number(d.input) || 0;
      row.today.cacheRead += Number(d.cacheRead) || 0;
      row.today.output += Number(d.output) || 0;
      row.today.calls += Number(d.calls) || 0;
    }
  }
  const list = [...rows.values()].map((row) => ({
    ...row,
    sessionCount: row.sessionIds.length,
    currentSessionId: String(currentSessions[row.key] || ''),
    cumulative: finish(row.cumulative),
    today: {
      ...row.today,
      totalInput: row.today.input + row.today.cacheRead,
      totalTokens: row.today.input + row.today.cacheRead + row.today.output
    }
  }));
  list.sort((a, b) => b.cumulative.totalInput - a.cumulative.totalInput);
  unowned.sort((a, b) => b.totalInput - a.totalInput);
  return { rows: list, unowned, scopeDay: scopeDay || 'all' };
}

// 开发日志展示前置脱敏：控制台是开发者视图，不展示会话号、QQ、群名和本机路径。
// 只改「展示副本」，README 原文保持不变。
export function sanitizeDevLogText(text, { names = [], ids = [] } = {}) {
  let s = String(text ?? '');
  // 去掉“（日期 用户要求）”里的需求来源字样，只保留日期。
  s = s.replace(/（(\d{4}-\d{2}-\d{2})\s*用户要求[^）]*）/g, '（$1）');
  s = s.replace(/（[^）]*用户要求[^）]*）/g, '');
  const replacements = [
    [/用户明确要求/g, '明确需求'],
    [/用户要求/g, '需求'],
    [/用户反馈/g, '实测反馈'],
    [/用户指定/g, '指定'],
    [/用户选择/g, '设计选择'],
    [/用户认为/g, '评估认为'],
    [/用户截图/g, '截图'],
    [/用户问/g, '问题'],
    [/用户输入/g, '输入'],
    [/用户可见/g, '可见']
  ];
  for (const [re, to] of replacements) s = s.replace(re, to);
  // 群名/昵称按当前会话列表替换，避免在日志里泄露私人群名。
  const redactions = [...new Map((names || []).map((n) => {
    if (typeof n === 'string') return [n, '某群'];
    return [String(n?.name || ''), String(n?.replacement || '某群')];
  }).filter(([name]) => name.length >= 2)).entries()]
    .sort((a, b) => b[0].length - a[0].length);
  for (const [name, replacement] of redactions) s = s.split(name).join(replacement);
  // 会话 key / 群号 / QQ / 本机绝对路径。
  s = s.replace(/\b(group|private):\d+\b/gi, '$1:…');
  s = s.replace(/((?:QQ|qq)\s*[:：]?\s*)\d{5,12}/g, '$1***');
  s = s.replace(/(群号?\s*[:：]?\s*)\d{5,12}/g, '$1***');
  // 已知会话/管理员 QQ 的裸数字也要处理（日志里常有“例如 1000000005”这种写法）。
  const knownIds = [...new Set((ids || []).map(String).filter((x) => /^\d{5,12}$/.test(x)))]
    .sort((a, b) => b.length - a.length);
  for (const id of knownIds) s = s.split(id).join('***');
  s = s.replace(/[A-Za-z]:[\\/][^\s，。；、）]+/g, '[本地路径]');
  // 常见密钥形态兜底（正常更新日志不应出现）。
  s = s.replace(/\b(Bearer\s+)[A-Za-z0-9%_.+/=-]{20,}/gi, '$1***');
  s = s.replace(/((?:token|api[_-]?key|password|secret|cookie)\s*[:=：]\s*)[^\s，。；、]+/gi, '$1***');
  return s;
}

// 开发日志：从 README 的「更新日志」章节解析出结构化条目。
// 只读、无网络；按 mtime/size 缓存，避免控制台轮询反复解析整份 README。
export function parseChangelogMarkdown(markdown, { maxSections = 80, maxEntries = 1200 } = {}) {
  const text = String(markdown || '');
  const start = text.search(/(?:^|\n)## 更新日志\s*\n/);
  if (start < 0) return { sections: [], entries: 0 };
  const startAt = text[start] === '\n' ? start + 1 : start;
  let block = text.slice(startAt);
  const next = block.search(/\n## (?!更新日志)/);
  if (next >= 0) block = block.slice(0, next);
  const parts = block.split(/\n(?=### )/).slice(0, maxSections);
  const sections = [];
  let total = 0;
  for (const part of parts) {
    const lines = part.split('\n');
    const heading = String(lines.shift() || '').replace(/^###\s*/, '').trim();
    if (!heading) continue;
    const entries = [];
    let cur = null;
    for (const line of lines) {
      if (/^- /.test(line)) {
        if (cur) entries.push(cur);
        const raw = line.slice(2).trim();
        const m = /^\*\*(.+?)\*\*(.*)$/.exec(raw);
        cur = {
          title: m ? m[1].trim() : raw.slice(0, 80),
          body: m ? m[2].replace(/^[：:]\s*/, '').trim() : ''
        };
      } else if (cur) {
        const add = line.trim();
        if (add) cur.body = `${cur.body}${cur.body ? '\n' : ''}${add}`;
      }
    }
    if (cur) entries.push(cur);
    for (const e of entries) {
      const dm = /(\d{4}-\d{2}-\d{2})/.exec(`${e.title} ${e.body}`);
      e.date = dm ? dm[1] : '';
    }
    if (entries.length) {
      total += entries.length;
      sections.push({ title: heading, entries: entries.slice(0, maxEntries) });
    }
    if (total >= maxEntries) break;
  }
  return { sections, entries: total };
}

export function createConsoleServer(deps) {
  const {
    ROOT,
    TOOL_FLAGS,
    api,
    canonicalV2Key,
    cfg,
    fs,
    groupedToolFlags,
    http,
    isSessionAllowedInCurrentMode,
    loadOrCreateConsoleToken,
    log,
    path,
    reverse,
    social,
    socialV2,
    state,
    text,
    toolNamesOf
  } = deps;

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
    // 令牌会被 POST /api/console/token 旋转。用对象持有同一份引用，
    // 分域路由（03-access）改到的是这里，而不是一份快照。
    const authState = {
      consoleToken: authDisabled ? '' : (tokenValid ? configuredToken : loadOrCreateConsoleToken())
    };
    if (authDisabled) log('控制台鉴权已关闭（config.consoleAuth=false）：不校验令牌，仅监听 127.0.0.1 + 写操作校验 Origin');
    else if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    else if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(authState.consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
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
    // R4：控制台路由按域拆到 src/console/routes/*.js。这里只装配路由表，
    // 鉴权 / CSRF / agent 白名单 / 暂停隔离仍在本文件统一处理；命中即返回。
    const consoleRouter = createConsoleRouter();
    // 概览类（about/plugins/tasks/tool-flags）用 register() 直接挂 handler。
    const routeStaticCtx = { deps, cfg, root: ROOT, TOOL_FLAGS, groupedToolFlags, toolNamesOf };
    overviewRoutes.register(consoleRouter, routeStaticCtx);
    // 其余按域模块：模块自带 routes 清单 + handle，内部保留原来的 if 链。
    for (const routeModule of DOMAIN_ROUTES) consoleRouter.use(routeModule);

    // 插件控制台路由（R4-5）：插件用 ctx.console.registerRoute 声明，核心只转发。
    // 路径必须以 /api/plugins/<id>/ 开头（context.js 已校验），没有注册就没有入口。
    for (const plugin of deps.pluginHost?.list?.() ?? []) {
      const pctx = deps.pluginHost?.getContext?.(plugin.id);
      for (const route of pctx?.console?.routes ?? []) {
        const handler = (req, res, url, rctx) => route.handler(req, res, url, {
          sendJson: rctx.sendJson,
          readBody: rctx.readBody,
          config: pctx.config,
          state: pctx.state,
          log: pctx.log
        });
        if (String(route.method).toUpperCase() === 'POST') consoleRouter.post(route.path, handler);
        else consoleRouter.get(route.path, handler);
      }
    }
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
      // 控制台静态资源（C0）：/console/* 只服务 public/console/**，仅本机监听。
      //
      // 为什么放在鉴权之前：页面里的 <link>/<script src> 无法带 ?token=，
      // 若对静态资源也要求令牌，页面样式和脚本会 401。这里只暴露**前端源码**
      // （仓库里本就可见），不含任何配置/状态数据；数据接口仍然全部鉴权。
      if (req.method === 'GET' && url.pathname.startsWith('/console/')) {
        let rel = '';
        try { rel = decodeURIComponent(url.pathname.slice('/console/'.length)); } catch {}
        const base = path.join(ROOT, 'public', 'console');
        const file = path.resolve(base, rel);
        const ext = path.extname(file).toLowerCase();
        const MIME = {
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.html': 'text/html; charset=utf-8'
        };
        if (!rel || !file.startsWith(base + path.sep) || !MIME[ext]) {
          sendJson({ ok: false, error: 'not found' }, 404);
          return;
        }
        try {
          const buf = fs.readFileSync(file);
          res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'no-cache', ...SECURITY_HEADERS });
          res.end(buf);
        } catch {
          sendJson({ ok: false, error: 'not found' }, 404);
        }
        return;
      }
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      // 注意：MCP 工具（AI 侧）调用时**同时**带 x-console-token 和 x-agent-token
      // （见 mcp-snowluma-safe.js 的 agentApi：它会读 state/console-token 补上），
      // 所以这里不需要为 agent 调用开豁免——曾误加过一个 AGENT_CALLABLE 白名单，
      // 既多余（请求本来就带 console token）又危险（会绕开控制台令牌）。
      const suppliedToken = url.searchParams.get('token') ?? req.headers['x-console-token'];
      if (authState.consoleToken && suppliedToken !== authState.consoleToken) {
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
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && deps.live.currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // Agent 默认拒绝，只允许 MCP 实际需要的显式路由；新增工具必须同步加入允许清单。
        if (req.headers['x-agent-token'] && !isAgentRouteAllowed(url.pathname, req.method)) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // R4：分域路由（src/console/routes/*）先匹配；未命中再走下方内联路由。
        if (await consoleRouter.handle(req, res, url, {
          ...routeStaticCtx,
          req, res, url, sendJson, readBody,
          port,
          authState,
          securityHeaders: SECURITY_HEADERS,
          agentTokenOk,
          v2SessionAllowed,
          v2ToolEnabled,
          helpers: {
            buildSessionUsageRows,
            parseChangelogMarkdown,
            sanitizeDevLogText,
            isAgentRouteAllowed,
            normalizeGapNoticeConfig,
            normalizeSharedMemoryConfig,
            sharedMemoryStats,
            listSharedPeople,
            forgetSharedPerson,
            clearSharedMemory,
            normalizeTokenFuseConfig,
            normalizeTokenFuseOverride,
            effectiveTokenFuseThresholds
          }
        })) return;
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        // R4：路由已按域拆到 src/console/routes/*.js，上方 consoleRouter.handle 统一分派。
        // 走到这里说明所有分域路由都没命中。
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
