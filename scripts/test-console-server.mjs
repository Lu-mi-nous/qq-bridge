// console-server 模块边界：路由完整搬迁、Agent 默认拒绝、动态状态不显式快照。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_ALLOWED_PATHS,
  buildSessionUsageRows,
  createConsoleServer,
  isAgentRouteAllowed
} from '../src/console-server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src', 'console-server.js'), 'utf8');
const mcp = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');
let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) pass++;
  else fail++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

check('导出 createConsoleServer', typeof createConsoleServer === 'function');
check('bridge 已接回 createConsoleServer', /createConsoleServer\(\{/.test(bridge));
check('bridge 不再保留内联 pathname 路由', !/url\.pathname ===/.test(bridge));
check('权限集中后保留 153 个直接路由比较',
  (server.match(/url\.pathname ===/g) || []).length === 153,
  String((server.match(/url\.pathname ===/g) || []).length));
check('动态模式经 live 读取', server.includes('deps.live.currentMode'));
check('会话代际只经命令递增',
  (server.match(/deps\.ops\.bumpSessionEpoch\(\)/g) || []).length === 4
  && !/sessionEpoch\+\+/.test(server));
check('默认 1MB 请求体上限保留', /: 1_000_000;/.test(server));
check('超分路由保留 8MB 上限', /Math\.min\(8_000_000/.test(server));
check('上下文追赶端点存在', /context-catchup/.test(server));
check('上下文重建索引端点存在', /context-rebuild-index/.test(server));
check('跨会话记忆端点存在', /shared-memory/.test(server) && /shared-memory-config/.test(server)
  && /shared-memory-forget/.test(server) && /shared-memory-clear/.test(server));
check('Token 熔断端点存在', /token-fuse/.test(server) && /token-fuse-config/.test(server)
  && /token-fuse-reset/.test(server) && /token-fuse-override/.test(server));

const mcpPaths = [...mcp.matchAll(/agentApi\(\s*(['"`])([^'"`]+)\1/g)]
  .map((match) => match[2].split('?')[0]);
check('MCP 58 条实际路由全部在允许清单',
  new Set(mcpPaths).size === 58
  && mcpPaths.every((pathname) => isAgentRouteAllowed(pathname, 'POST') || isAgentRouteAllowed(pathname, 'GET')));
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
  '/api/socialV2/token-fuse-override'
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

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
