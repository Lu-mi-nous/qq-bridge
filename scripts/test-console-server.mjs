// console-server 模块边界：路由完整搬迁、Agent 默认拒绝、动态状态不显式快照。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_ALLOWED_PATHS,
  buildSessionUsageRows,
  createConsoleServer,
  parseChangelogMarkdown,
  sanitizeDevLogText,
  isAgentRouteAllowed
} from '../src/console-server.js';
import { readConsoleUiSource } from './lib/console-ui-src.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src', 'console-server.js'), 'utf8');
// R4：概览类路由迁到分域模块，路由总数要两处一起算。
const overviewRoutes = fs.readFileSync(path.join(root, 'src', 'console', 'routes', '00-overview.js'), 'utf8');
const overviewReadModel = fs.readFileSync(path.join(root, 'src', 'console', 'read-model', 'overview.js'), 'utf8');
const mcp = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');
let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) pass++;
  else fail++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

check('导出 createConsoleServer', typeof createConsoleServer === 'function');
check('bridge 已接回 createConsoleServer（R4.7 领域 Facade）', /createConsoleServer\((?:createConsoleServices\()?\{/.test(bridge)
  && /createConsoleServices\(\{/.test(bridge));
check('bridge 不再保留内联 pathname 路由', !/url\.pathname ===/.test(bridge));
// R4：路由按域拆到 src/console/routes/*.js。端点总数 = 内联（`/` 页面 + 401 提示）
// + 概览模块 + 各分域模块声明的 routes 清单。
const domainRouteFiles = fs.readdirSync(path.join(root, 'src', 'console', 'routes'))
  .filter((f) => f.endsWith('.js') && f !== '00-overview.js');
const consoleCommandsSrc = fs.readdirSync(path.join(root, 'src', 'console', 'commands'))
  .filter((f) => f.endsWith('.js'))
  .sort()
  .map((f) => fs.readFileSync(path.join(root, 'src', 'console', 'commands', f), 'utf8'))
  .join('\n');
const domainRoutesSrc = domainRouteFiles
  .map((f) => fs.readFileSync(path.join(root, 'src', 'console', 'routes', f), 'utf8'))
  .join('\n');
const domainRouteCount = domainRouteFiles.reduce((n, f) => {
  const src = fs.readFileSync(path.join(root, 'src', 'console', 'routes', f), 'utf8');
  return n + (src.match(/^  \['(?:GET|POST|PUT|DELETE|PATCH)', '[^']+', '(?:exact|prefix)'\]/gm) || []).length;
}, 0);
const inlineRouteCount = (server.match(/url\.pathname ===/g) || []).length;
const overviewRouteCount = (overviewRoutes.match(/router\.(?:get|post|put|del)(?:Prefix)?\(/g) || []).length;
check('路由总数与拆分前一致（163 个端点，含动态前缀；C1 manifest + C3 plugin-guide + C4 token panel + C6 插件管理 + 插件配置）',
  inlineRouteCount + overviewRouteCount + domainRouteCount === 163,
  `${inlineRouteCount}+${overviewRouteCount}+${domainRouteCount}`);
check('有插件清单接口', /'\/api\/plugins'/.test(overviewRoutes) && /pluginList\(\)/.test(overviewReadModel));
check('有任务清单/控制接口', /'\/api\/tasks'/.test(overviewRoutes)
  && /commands\?\.tasks/.test(overviewRoutes) && /pause\|resume\|trigger\|start\|stop/.test(overviewRoutes));
check('动态模式经 live 读取', server.includes('live.currentMode'));
check('生产控制台不再构造 flatten 兼容视图', !server.includes('flattenConsoleServices'));
check('会话代际只经命令递增',
  (`${server}\n${domainRoutesSrc}\n${consoleCommandsSrc}`.match(/deps\.ops\.bumpSessionEpoch\(\)|ops\.bumpSessionEpoch\?\.\(\)/g) || []).length === 4
  && !/sessionEpoch\+\+/.test(`${server}\n${domainRoutesSrc}\n${consoleCommandsSrc}`));
check('默认 1MB 请求体上限保留', /: 1_000_000;/.test(server));
check('超分路由保留 8MB 上限', /Math\.min\(8_000_000/.test(server));
check('上下文追赶端点存在', /context-catchup/.test(domainRoutesSrc));
check('上下文重建索引端点存在', /context-rebuild-index/.test(domainRoutesSrc));
check('开发日志端点存在', /'\/api\/dev-log'/.test(domainRoutesSrc));
check('开发日志解析：标题/正文/续行', (() => {
  const parsed = parseChangelogMarkdown('## 更新日志\n\n### 未发布\n\n- **标题A**：正文A\n  续行A\n- **标题B**\n\n## 合规提醒\n');
  return parsed.sections.length === 1 && parsed.sections[0].title === '未发布'
    && parsed.sections[0].entries.length === 2
    && parsed.sections[0].entries[0].title === '标题A'
    && parsed.sections[0].entries[0].body.includes('续行A')
    && parsed.sections[0].entries[1].title === '标题B';
})());
check('开发日志展示脱敏/开发者措辞', (() => {
  const out = sanitizeDevLogText('（2026-10-25 用户要求）测试群 group:100002004 QQ 1000000000 100002004 E:/Downloads/x 用户反馈 用户要求', {
    names: [{ name: '测试群', replacement: '某群' }],
    ids: ['100002004', '1000000000']
  });
  return !out.includes('用户要求') && !out.includes('用户反馈')
    && !out.includes('100002004') && !out.includes('1000000000')
    && !out.includes('E:/Downloads') && out.includes('某群') && out.includes('2026-10-25');
})());

check('跨会话记忆端点存在', /shared-memory/.test(domainRoutesSrc) && /shared-memory-config/.test(domainRoutesSrc)
  && /shared-memory-forget/.test(domainRoutesSrc) && /shared-memory-clear/.test(domainRoutesSrc));
check('Token 熔断端点存在', /token-fuse/.test(domainRoutesSrc) && /token-fuse-config/.test(domainRoutesSrc)
  && /token-fuse-reset/.test(domainRoutesSrc) && /token-fuse-override/.test(domainRoutesSrc));

// R4.6-5：插件工具的描述/handler 已迁入插件，桥接端点改由 mcp-bridge-services 的具名服务调用。
// 只正则扫 MCP 源会漏掉这些路径，所以按「实际调用」收集：MCP 源里直接 agentApi 字面量 +
// 各具名服务在假 agentApi 下发出的一次请求。断言只看「用到的都在允许清单」，不数条数。
const mcpPaths = new Set([...mcp.matchAll(/agentApi\(\s*(['"`])([^'"`]+)\1/g)].map((match) => match[2].split('?')[0]));
{
  const services = await import('../src/plugins/mcp-bridge-services.js');
  const factories = [
    'createSlangMcpServices', 'createMediaMcpServices', 'createBiliMcpServices',
    'createImagesMcpServices', 'createStickersMcpServices', 'createTtsMcpServices',
    'createUpscaleMcpServices', 'createXPostsMcpServices'
  ];
  for (const name of factories) {
    check(`具名服务工厂存在：${name}`, typeof services[name] === 'function');
    if (typeof services[name] !== 'function') continue;
    const scoped = services[name]((url) => { mcpPaths.add(String(url).split('?')[0]); return {}; });
    for (const fn of Object.values(scoped)) { try { fn({}); } catch {} }
  }
}
check('MCP 实际调用的桥接路由全部在允许清单',
  mcpPaths.size > 0
  && [...mcpPaths].every((pathname) => isAgentRouteAllowed(pathname, 'POST') || isAgentRouteAllowed(pathname, 'GET')));
check('凭据、活动、配置默认拒绝 Agent', [
  '/api/socialV2/credentials',
  '/api/socialV2/activity-feed',
  '/api/socialV2/config',
  '/api/socialV2/cache',
  '/api/socialV2/shared-memory',
  '/api/socialV2/shared-memory-config',
  '/api/socialV2/shared-memory-forget',
  '/api/socialV2/shared-memory-clear',
  '/api/socialV2/token-fuse',
  '/api/socialV2/token-fuse-config',
  '/api/socialV2/token-fuse-reset',
  '/api/socialV2/token-fuse-override',
  '/api/dev-log'
].every((pathname) => !isAgentRouteAllowed(pathname)));
check('反馈仅 POST 对 Agent 开放',
  isAgentRouteAllowed('/api/socialV2/feedback', 'POST')
  && !isAgentRouteAllowed('/api/socialV2/feedback', 'GET'));
check('允许清单不含通配符', AGENT_ALLOWED_PATHS.size === 58
  && [...AGENT_ALLOWED_PATHS].every((pathname) => pathname.startsWith('/api/') && !pathname.includes('*')));

console.log('\n── 会话级 Token 报表合成 ──');
{
  const usage = {
    sessions: {
      'session-old': {
        key: 'group:1', input: 140, cacheRead: 1400, output: 14, calls: 7,
        firstAt: 1000, lastAt: 2000,
        days: {
          '2026-10-25': { input: 100, cacheRead: 1000, output: 10, calls: 5 },
          '2026-10-24': { input: 40, cacheRead: 400, output: 4, calls: 2 }
        }
      },
      'session-new': {
        key: 'group:1', input: 25, cacheRead: 250, output: 3, calls: 2,
        firstAt: 3000, lastAt: 3000,
        days: {
          '2026-10-25': { input: 20, cacheRead: 200, output: 2, calls: 1 },
          '2026-10-24': { input: 5, cacheRead: 50, output: 1, calls: 1 }
        }
      },
      'session-orphan': {
        key: null, input: 7, cacheRead: 70, output: 1, calls: 1,
        firstAt: 4000, lastAt: 4000,
        days: { '2026-10-25': { input: 7, cacheRead: 70, output: 1, calls: 1 } }
      }
    },
    summarizer: {
      'group:1': {
        input: 60, output: 6, calls: 3,
        days: {
          '2026-10-25': { input: 50, output: 5, calls: 2 },
          '2026-10-24': { input: 10, output: 1, calls: 1 }
        }
      }
    }
  };
  const built = buildSessionUsageRows({
    usage,
    currentSessions: { 'group:1': 'session-new' },
    displayName: (key) => (key === 'group:1' ? '测试群' : key),
    today: '2026-10-25'
  });
  const row = built.rows.find((r) => r.key === 'group:1');
  check('同一 QQ 会话的轮换前后 session 合并', row?.sessionCount === 2 && row?.sessionIds.length === 2);
  check('当前口径只取当前 sessionId', row?.currentSessionId === 'session-new'
    && row?.current?.totalInput === 275, JSON.stringify(row?.current));
  check('累计口径 = 两个会话 + 摘要器', row?.cumulative?.totalInput === 1540 + 275 + 60,
    String(row?.cumulative?.totalInput));
  check('累计调用数含摘要器', row?.cumulative?.calls === 12, String(row?.cumulative?.calls));
  check('今日口径含摘要器', row?.today?.totalInput === 1370, JSON.stringify(row?.today));
  check('显示名由调用方提供', row?.displayName === '测试群');
  check('无主 session 单独返回且不丢', built.unowned.length === 1
    && built.unowned[0].sessionId === 'session-orphan' && built.unowned[0].totalInput === 77);

  // 按日审阅必须对会话表生效（2026-10-25 用户反馈）
  const scoped = buildSessionUsageRows({
    usage,
    currentSessions: { 'group:1': 'session-new' },
    displayName: (key) => (key === 'group:1' ? '测试群' : key),
    today: '2026-10-25',
    scopeDay: '2026-10-24'
  });
  const dayRow = scoped.rows.find((r) => r.key === 'group:1');
  check('会话表支持按日 scope', scoped.scopeDay === '2026-10-24');
  check('按日时累计只算当天（旧会话+新会话+摘要器）',
    dayRow?.cumulative?.totalInput === 440 + 55 + 10, String(dayRow?.cumulative?.totalInput));
  check('按日时当前会话只算当天', dayRow?.current?.totalInput === 55,
    String(dayRow?.current?.totalInput));
  check('按日时摘要器只算当天', dayRow?.summarizer?.calls === 1
    && dayRow?.summarizer?.input === 10, JSON.stringify(dayRow?.summarizer));
  check('按日不影响 24 卡用的 today 口径', dayRow?.today?.totalInput === 1370,
    String(dayRow?.today?.totalInput));
}

// R4-5：插件控制台插槽（卡片 + 子路由）。
{
  const contextSrc = fs.readFileSync(path.join(root, 'src', 'plugins', 'context.js'), 'utf8');
  const hostSrc = fs.readFileSync(path.join(root, 'src', 'plugins', 'host.js'), 'utf8');
  const html = readConsoleUiSource();
  check('插件可注册控制台卡片', /registerCard\(/.test(contextSrc) && /cards: \[\]/.test(contextSrc));
  check('插件路由必须声明 console:route 且挂在自己命名空间下',
    /console:route/.test(contextSrc) && /\/api\/plugins\/\$\{id\}\//.test(contextSrc));
  check('插件路由由核心统一转发', /getContext\?\.\(plugin\.id\)/.test(server)
    && /console\?\.routes/.test(server));
  check('插件清单暴露 console 元数据', /console: \{/.test(hostSrc) && /cards:/.test(hostSrc));
  check('控制台有插件功能分类视图', /id="pluginCategoryView"/.test(html) && /mountPluginSurface/.test(html));
  check('插件清单进入控制台 manifest', /\/api\/console\/manifest/.test(overviewRoutes)
    && /pluginGroups/.test(overviewReadModel) && /pluginId/.test(overviewReadModel));
}

// R4：复合条件与动态路径路由必须显式登记，否则模块根本收不到请求。
{
  const agentRoutes = fs.readFileSync(path.join(root, 'src', 'console', 'routes', '17-agent.js'), 'utf8');
  const slangRoutes = fs.readFileSync(path.join(root, 'src', 'console', 'routes', '02-slang.js'), 'utf8');
  check('统一发送端点已登记',
    ['/api/send/group', '/api/send/private', '/api/send/reply']
      .every((p) => agentRoutes.includes(`'${p}'`)));
  check('黑话动态路由用 prefix 注册',
    /'PATCH', '\/api\/slang\/', 'prefix'/.test(slangRoutes)
      && /'DELETE', '\/api\/slang\/', 'prefix'/.test(slangRoutes)
      && /'POST', '\/api\/slang\/', 'prefix'/.test(slangRoutes));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
