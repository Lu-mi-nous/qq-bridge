// 回归：Agent 管理边界、双令牌发送闸门与真实发送失败传播。
// 不连接 QQ/DSH；发送测试执行 bridge.js 中的真实 sendToQQ 函数并注入内存 bot。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_ALLOWED_PATHS, isAgentRouteAllowed } from '../src/console-server.js';
import { createSendQueue } from '../src/pipeline/send-queue.js';
import { createQQSender } from '../src/pipeline/qq-send.js';
import { readConsoleSource } from './lib/console-src.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const consoleServer = readConsoleSource();
const mcp = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');
let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) pass++;
  else fail++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

console.log('── 1. Agent 与管理端隔离 ──');
{
  check('凭据接口默认拒绝 Agent', !isAgentRouteAllowed('/api/socialV2/credentials'));
  check('活动消息接口默认拒绝 Agent', !isAgentRouteAllowed('/api/socialV2/activity-feed'));
  check('缓存与模式配置接口默认拒绝 Agent',
    !isAgentRouteAllowed('/api/socialV2/cache') && !isAgentRouteAllowed('/api/socialV2/config'));
  check('反馈 GET 仍仅管理端、POST 可供工具使用',
    !isAgentRouteAllowed('/api/socialV2/feedback', 'GET') && isAgentRouteAllowed('/api/socialV2/feedback', 'POST'));
  check('自拍 GET 不能触发发布', consoleServer.includes('GET 仅用于预览；发布形象图必须使用 POST'));
  check('自拍发布强制会话令牌', /req\.method === 'POST' && !agentToken/.test(consoleServer));
  const mcpPaths = [...mcp.matchAll(/agentApi\(\s*(['"`])([^'"`]+)\1/g)]
    .map((match) => match[2].split('?')[0]);
  check('MCP 实际调用的路由全部被显式允许',
    mcpPaths.every((pathname) => isAgentRouteAllowed(pathname, 'POST') || isAgentRouteAllowed(pathname, 'GET')),
    `${new Set(mcpPaths).size} 条`);
  check('允许清单没有无界前缀或通配符', AGENT_ALLOWED_PATHS.size === 58
    && [...AGENT_ALLOWED_PATHS].every((pathname) => pathname.startsWith('/api/') && !pathname.includes('*')));
}

console.log('\n── 2. Header/Body 令牌与全局闸门 ──');
{
  check('两个 Body 令牌发送入口都对账 Header',
    (consoleServer.match(/Header 与 Body 的 agent token 不一致/g) || []).length === 2);
  check('两个入口都按统一身份复查暂停',
    (consoleServer.match(/\(token \|\| deps\.live\.currentMode === 'reserved2'\) && socialV2\.paused/g) || []).length === 2);
  check('两个入口都按统一身份复查二代总开关',
    (consoleServer.match(/\(token \|\| deps\.live\.currentMode === 'reserved2'\) && cfg\.socialV2\?\.enabled === false/g) || []).length === 2);
  const oldSendHeaders = mcp.match(/agentApi\('\/api\/send\/(?:group|reply|private)', \{[\s\S]{0,180}?headers: token \? \{ 'x-agent-token': token \} : \{\}/g) || [];
  check('三个旧 MCP 发送工具都携带 Header 令牌', oldSendHeaders.length === 3, String(oldSendHeaders.length));
}

console.log('\n── 3. sendToQQ 真实失败传播与队列恢复（pipeline/qq-send 行为断言）──');
{
  const attempts = [];
  const recorded = [];
  const bot = {
    async sendPrivateMessage(id) { attempts.push(`private:${id}`); return { message_id: `p${id}` }; },
    async sendGroupMessage(id) {
      attempts.push(`group:${id}`);
      if (id === 2) throw new Error(' simulated QQ failure ');
      return { message_id: `g${id}` };
    }
  };
  const sender = createQQSender({
    sendQueue: createSendQueue(),
    log: () => {},
    sleep: async () => {},
    randInt: () => 0,
    cfg: { sendDelayMs: 0 },
    text: (x) => x,
    escapeCqText: (x) => x,
    redactKnownTokensOnly: (x) => String(x),
    splitForQQ: (x) => [x],
    withTimeout: (p) => p,
    SEND_TIMEOUT_MS: 1000,
    bot,
    recordSentMessage: (key) => recorded.push(key),
    planAutoAtV2: () => null,
    getTtsPlugin: () => null,
    onebotSend: async () => {},
    syncStickerLibrary: async () => null,
    findSticker: () => null,
    getStickerEntries: () => [],
    setStickerEntries: () => {},
    validateFetchUrl: async () => {},
    markStickerUsed: () => ({}),
    saveStickerStoreSafe: () => {}
  });
  await sender.sendToQQ('group:1', 'before');
  let rejected = false;
  try {
    await sender.sendToQQ('group:2', 'failure');
  } catch (error) {
    rejected = /QQ 发送失败 1\/1 条/.test(String(error?.message ?? error));
  }
  await sender.sendToQQ('group:3', 'after');
  check('失败不会毒化本会话发送队列', attempts.join(',') === 'group:1,group:2,group:3', attempts.join(','));
  check('只有真实成功的消息进入发送记录', recorded.join(',') === 'group:1,group:3', recorded.join(','));
}

// B 站最终准入和成功记账由 test-bili-sharing.mjs 直接运行真实模块覆盖。

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
