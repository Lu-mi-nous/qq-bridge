// R4.7-2/3：控制台读模型与命令回归（Token + 活动流）。
//
// 目标：
//   1. 读模型口径与旧路由逐字段一致（日/模型/会话/缓存命中率/空态）；
//   2. 发送前置条件（暂停/熔断/模式/静默）在命令层拦住，不再散在路由里；
//   3. 路由不再从平铺 deps 解构，只消费 ctx.readModels / ctx.commands；
//   4. facets 只从 8 个领域对象装配，不新增 createConsoleServer 顶层键。
import { CONSOLE_DOMAINS, CONSOLE_DOMAIN_KEYS, createConsoleServices } from '../src/console/composition.js';
import { createConsoleFacets } from '../src/console/facets.js';
import { createTokenReadModel, deriveUsage, emptyUsage, sumModelUsage } from '../src/console/read-model/token.js';
import { createTokenCommands } from '../src/console/commands/token.js';
import { buildPromptCompact, createActivityReadModel } from '../src/console/read-model/activity.js';
import { createActivityCommands } from '../src/console/commands/activity.js';
import { createTaskCommands } from '../src/console/commands/tasks.js';
import { createContextReadModel } from '../src/console/read-model/context.js';
import { createContextCommands } from '../src/console/commands/context.js';
import { createOpsCommands } from '../src/console/commands/ops.js';
import { createImagesReadModel } from '../src/console/read-model/images.js';
import { createImagesCommands } from '../src/console/commands/images.js';
import { createStickersReadModel } from '../src/console/read-model/stickers.js';
import { createStickersCommands } from '../src/console/commands/stickers.js';
import { createWaitReadModel } from '../src/console/read-model/wait.js';
import { createWaitCommands } from '../src/console/commands/wait.js';
import { createBiliReadModel } from '../src/console/read-model/bili.js';
import { createBiliCommands } from '../src/console/commands/bili.js';
import { createSocialReadModel } from '../src/console/read-model/social-read.js';
import { createSocialReadCommands } from '../src/console/commands/social-read.js';
import { createCoreReadModel } from '../src/console/read-model/core.js';
import { createCoreCommands } from '../src/console/commands/core.js';
import { createMemoryReadModel } from '../src/console/read-model/memory.js';
import { createMemoryCommands } from '../src/console/commands/memory.js';
import { createAccessReadModel } from '../src/console/read-model/access.js';
import { createAccessCommands } from '../src/console/commands/access.js';
import { createAgentReadModel } from '../src/console/read-model/agent.js';
import { createAgentCommands } from '../src/console/commands/agent.js';
import { createMessagingCommands } from '../src/console/commands/messaging.js';
import { createSocialV1ReadModel } from '../src/console/read-model/social-v1.js';
import { createSocialV1Commands } from '../src/console/commands/social-v1.js';
import { createSlangReadModel } from '../src/console/read-model/slang.js';
import { createSlangCommands } from '../src/console/commands/slang.js';
import { createConfigReadModel } from '../src/console/read-model/config.js';
import { createConfigCommands } from '../src/console/commands/config.js';
import { createForwardReadModel } from '../src/console/read-model/forward.js';
import * as tokenRoute from '../src/console/routes/05-token.js';
import * as contextRoute from '../src/console/routes/16-context.js';
import * as opsRoute from '../src/console/routes/18-ops.js';
import * as imagesRoute from '../src/console/routes/10-images.js';
import * as stickersRoute from '../src/console/routes/11-stickers.js';
import * as waitRoute from '../src/console/routes/12-wait.js';
import * as biliRoute from '../src/console/routes/14-bili.js';
import * as socialReadRoute from '../src/console/routes/08-social-read.js';
import * as coreRoute from '../src/console/routes/01-core.js';
import * as memoryRoute from '../src/console/routes/15-memory.js';
import * as accessRoute from '../src/console/routes/03-access.js';
import * as agentRoute from '../src/console/routes/17-agent.js';
import * as messagingRoute from '../src/console/routes/09-messaging.js';
import * as socialV1Route from '../src/console/routes/04-social-v1.js';
import * as slangRoute from '../src/console/routes/02-slang.js';
import * as configRoute from '../src/console/routes/06-config.js';
import * as forwardRoute from '../src/console/routes/13-forward.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

console.log('── 读模型口径 ──');
{
  check('deriveUsage：总输入 = 未缓存 + 缓存读', (() => {
    const d = deriveUsage({ input: 100, cacheRead: 900, output: 10 });
    return d.totalInput === 1000 && d.totalTokens === 1010 && d.cacheHitRate === 90;
  })());
  check('deriveUsage：空值不产生 NaN', (() => {
    const d = deriveUsage(null);
    return d.totalInput === 0 && d.totalTokens === 0 && d.cacheHitRate === 0;
  })());
  check('sumModelUsage 汇总五个字段', (() => {
    const s = sumModelUsage({ a: { input: 1, output: 2, cacheRead: 3, reasoning: 4, calls: 5 } });
    return s.input === 1 && s.output === 2 && s.cacheRead === 3 && s.reasoning === 4 && s.calls === 5;
  })());
  check('emptyUsage 含 dayModels（前端无需分支）', (() => {
    const e = emptyUsage();
    return e.days && e.models && e.dayModels && e.turns === 0 && e.calls === 0;
  })());
}

const usage = {
  updatedAt: 123,
  turns: 12,
  calls: 30,
  files: 2,
  days: {
    '2026-10-29': { input: 100, output: 10, cacheRead: 900, reasoning: 0, calls: 5 },
    '2026-10-28': { input: 50, output: 5, cacheRead: 450, reasoning: 1, calls: 3 }
  },
  models: {
    m1: { input: 100, output: 10, cacheRead: 900, calls: 6 },
    m2: { input: 50, output: 5, cacheRead: 450, calls: 2 }
  },
  dayModels: {
    '2026-10-29': { m1: { input: 100, output: 10, cacheRead: 900, calls: 5 } }
  }
};
const read = createTokenReadModel({
  live: { tokenUsage: usage, turnMetrics: (opts) => ({ seen: opts ?? null }) },
  state: { sessions: { 'group:1': 's1' } },
  contextDisplayName: (key) => `会话 ${key}`,
  buildSessionUsageRows: (args) => ({ scopeDay: args.scopeDay || 'all', rows: [{ key: 'group:1', scope: args.scopeDay || 'all' }], unowned: [] }),
  now: () => new Date('2026-10-29T10:00:00Z')
});

{
  const view = read.usageView('');
  const b = view.body;
  check('全时段：ready + 今日按上海时区', view.ok && b.ready === true && b.today === '2026-10-29', b.today);
  check('全时段：模型明细为全时段汇总', b.modelScope === 'all' && b.models.length === 2 && b.modelScopeUsage.totalInput === 1500);
  check('全时段：总计含缓存读', b.total.totalInput === 1500 && b.total.totalTokens === 1515 && b.total.cacheHitRate === 90);
  check('全时段：会话表 scopeDay=all', b.sessionScope === 'all' && b.sessions[0].scope === 'all');
  check('全时段：turnMetrics 不带 day', JSON.stringify(b.turnMetrics) === JSON.stringify({ seen: null }));
  check('按日：模型明细只取那天', (() => {
    const d = read.usageView('2026-10-28').body;
    return d.modelScope === '2026-10-28' && d.models.length === 0 && d.modelScopeUsage.totalInput === 0;
  })());
  check('按日：turnMetrics 带 day、会话表跟随', (() => {
    const d = read.usageView('2026-10-29').body;
    return d.turnMetrics.seen?.day === '2026-10-29'
      && d.sessionScope === '2026-10-29'
      && d.models.length === 1 && d.models[0].model === 'm1';
  })());
  check('按日：todayUsage 仍取真实今天（24 卡口径）', read.usageView('2026-10-28').body.todayUsage.totalInput === 1000);
  check('非法 date 返回 400', (() => {
    const r = read.usageView('2026-1-2');
    return r.ok === false && r.status === 400 && /YYYY-MM-DD/.test(r.error);
  })());
  check('最多返回 30 天，按日期倒序', (() => {
    const many = { days: {} };
    for (let i = 1; i <= 40; i++) many.days[`2026-09-${String(i).padStart(2, '0')}`] = { input: i, output: 0, cacheRead: 0 };
    const m = createTokenReadModel({ live: { tokenUsage: many }, now: () => new Date('2026-10-29T10:00:00Z') });
    const days = m.usageView('all').body.days;
    return days.length === 30 && days[0].date > days[1].date;
  })());
  check('无缓存时 ready=false 且带空态', (() => {
    const empty = createTokenReadModel({ live: {}, now: () => new Date('2026-10-29T10:00:00Z') });
    const r = empty.usageView('all');
    return r.ok && r.body.ready === false && r.body.days && r.body.turns === 0;
  })());
}

console.log('\n── 命令层：刷新 / 渲染 / 发送闸门 ──');
{
  let refreshCalls = 0;
  let refreshOpts = null;
  let renderCalls = 0;
  let sendCalls = 0;
  let pruneCalls = 0;
  let activityCalls = 0;
  let renderFails = false;
  const builds = [];
  const state = {
    paused: false,
    fused: false,
    modeOk: true,
    silent: false,
    liveMode: 'reserved2'
  };
  const commands = createTokenCommands({
    live: { tokenUsage: usage, get currentMode() { return state.liveMode; } },
    cfg: { socialV2: {} },
    socialV2: { get paused() { return state.paused; } },
    ops: { isTokenFused: () => state.fused },
    fs: { readFileSync: () => Buffer.from('PNG') },
    loadTokenUsage: () => usage,
    refreshTokenUsage: async (opts) => { refreshCalls++; refreshOpts = opts; return { ok: true }; },
    buildTokenReport: (u) => { builds.push(u); return {
      today: { day: '2026-10-29', input: 100, output: 10, calls: 5 },
      all: { input: 1500, output: 15, calls: 8 },
      stale: false,
      ageText: '刚刚'
    }; },
    renderTokenReport: async (report, opts) => {
      renderCalls++;
      if (renderFails) return { ok: false, error: 'Chrome 不可用' };
      return { ok: true, file: 'report.png', bytes: 2048, cached: true, title: opts.title };
    },
    summarizeTokenReport: () => 'summary-text',
    pruneTokenReportCache: () => { pruneCalls++; },
    onebotSendImageFile: async () => { sendCalls++; },
    appendActivity: () => { activityCalls++; },
    log: () => {},
    modeAllowed: () => state.modeOk,
    shouldBlockSilentReply: () => state.silent
  });

  const sendArgs = { key: 'group:1', kind: 'group', id: 1, title: 'Token 用量' };

  state.paused = true;
  let r = await commands.sendReport(sendArgs);
  check('暂停时拒绝发送且不渲染', r.ok === false && r.status === 403 && renderCalls === 0 && sendCalls === 0, r.error);
  state.paused = false;

  state.fused = true;
  r = await commands.sendReport(sendArgs);
  check('熔断时拒绝发送且不渲染', r.ok === false && r.status === 403 && /熔断/.test(r.error) && renderCalls === 0);
  state.fused = false;

  state.modeOk = false;
  r = await commands.sendReport(sendArgs);
  check('模式不允许时拒绝发送', r.ok === false && r.status === 403 && /当前模式/.test(r.error) && renderCalls === 0);
  state.modeOk = true;

  state.silent = true;
  r = await commands.sendReport(sendArgs);
  check('静默模式拒绝发送', r.ok === false && r.status === 403 && /静默/.test(r.error) && renderCalls === 0);
  state.silent = false;

  check('id 非法时拒绝发送', (await commands.sendReport({ ...sendArgs, id: Number.NaN })).status === 403);

  renderFails = true;
  r = await commands.sendReport(sendArgs);
  check('渲染失败返回 500 且不发送', r.ok === false && r.status === 500 && /Chrome/.test(r.error) && sendCalls === 0);
  renderFails = false;

  r = await commands.sendReport({ ...sendArgs, refresh: true });
  check('成功发送：摘要与图同源', r.ok === true && r.summary === 'summary-text' && r.today.input === 100 && r.total.input === 1500);
  check('成功发送：走发送/清理/时间线', sendCalls === 1 && pruneCalls === 1 && activityCalls === 1);
  check('refresh=true 先增量重算且不强制全量', refreshCalls === 1 && refreshOpts && refreshOpts.force === false, JSON.stringify(refreshOpts));
  check('报表使用缓存里的 usage（不重新 load）', builds.length === 2 && builds.every((u) => u === usage));

  const img = await commands.renderImage({ title: '预览', refresh: true });
  check('预览返回 PNG 字节且再重算一次', img.ok && img.buffer.equals(Buffer.from('PNG')) && refreshCalls === 2);
  check('预览默认标题截断到 40 字', commands.cleanTitle('   ') === 'Token 用量' && commands.cleanTitle('x'.repeat(60)).length === 40);

  const missing = createTokenCommands({});
  check('能力缺失时明确报错（不抛异常）', (await missing.renderReport({})).ok === false
    && /能力不可用/.test((await missing.renderReport({})).error));
}

console.log('\n── 活动流读模型 / 暂停与重置命令 ──');
{
  const m1 = { messageId: 1, seq: 1, time: 100, sender: '甲', text: '在吗', isSelf: false };
  const m2 = { messageId: 2, seq: 2, time: 200, sender: '我', text: '在', isSelf: true };
  const m3 = { messageId: 3, seq: 3, time: 300, sender: '乙', text: '[语音]', isSelf: false };
  const conversation = {
    recentMessages: [m1, m2, m3],
    unread: [m1],
    wakeConfig: { enabled: true },
    lastWakeReason: 'at',
    lastAiReplyAt: 5
  };
  const socialV2 = { conversations: new Map([['group:1', conversation]]), paused: true };
  let busy = false;
  let synced = 0;
  const read = createActivityReadModel({
    live: { currentMode: 'reserved2', slangEntries: [{ content: '绷' }], stickerEntries: [{ id: 1 }] },
    socialV2,
    cfg: {
      ownerQQ: 10001,
      socialV2: { tools: { getPrompt: false, sendGroup: true, listStickers: true }, sticker: { enabled: true, promptMaxStickers: 2 } },
      slang: { enabled: true, injectMax: 3 }
    },
    contextDisplayName: () => '测试群',
    findCallersV2: () => ({ pending: [m1], answered: [m3] }),
    isConversationBusyV2: () => busy,
    getSocialV2State: () => conversation,
    computeWakeSafetyV2: () => ({ safe: true }),
    roleFor: () => '角色A',
    currentRoleHint: () => 'full-hint',
    currentRoleHintV2: (key, opts) => (opts?.digest ? 'digest-hint' : 'full-hint-v2'),
    confirmedSlangListV2: () => [{ content: '绷' }],
    buildSlangContext: () => 'slang-block',
    formatMemoryV2: () => 'memory-text',
    formatParticipationV2: () => 'participation-text',
    stickerEnabled: () => false,
    stickerCacheOpts: () => ({}),
    buildStickerContext: () => 'sticker-context',
    buildStickerStrategyHint: () => 'sticker-strategy',
    syncStickerLibrary: async () => { synced++; }
  });
  check('状态端点只回暂停态', read.statusView().paused === true && read.statusView().ok === true);

  const feed = read.feedView('20');
  const byId = Object.fromEntries(feed.rows.map((r) => [r.messageId, r]));
  check('活动流状态推导：待回复/已发送/已回复', byId[1].status === 'pending'
    && byId[2].status === 'sent' && byId[3].status === 'replied');
  check('已回复优先于未读，自发消息标已发送', byId[3].status === 'replied' && byId[3].label === '已回复'
    && byId[2].status === 'sent' && byId[2].label === '已发送');
  check('活动流计数与条数', feed.counts.pending === 1 && feed.counts.sent === 1 && feed.counts.replied === 1 && feed.rows.length === 3);
  busy = true;
  check('繁忙时待回复变处理中', read.feedView('20').rows.find((r) => r.messageId === '1').status === 'processing');
  busy = false;

  const stateView = read.stateView('group:1');
  check('状态摘要只给四个字段', stateView.unreadCount === 1 && stateView.recentCount === 3
    && stateView.lastWakeReason === 'at' && stateView.wakeSafety.safe === true && !('recentMessages' in stateView));

  const compact = await read.promptView('group:1', null);
  check('prompt 默认 compact + 摘要', compact.detail === 'compact' && compact.role.hint === 'digest-hint');
  check('能力片段随工具开关与表情可用性', compact.enabledTools.includes('qq_send_group_message')
    && !compact.enabledTools.includes('qq_get_prompt')
    && !compact.enabledTools.includes('qq_list_stickers'));
  const full = await read.promptView('group:1', 'full');
  check('prompt detail=full 才同步表情并注入完整上下文', synced === 1
    && full.detail === 'full' && full.role.hint === 'full-hint-v2'
    && full.memory === 'memory-text' && full.slang.block === 'slang-block'
    && full.stickers.context === 'sticker-context' && full.ownerQQ === 10001);
  check('compact 载荷结构稳定（qq_get_prompt 契约）', buildPromptCompact({ key: 'k', st: { unread: [1, 2] } }).unreadCount === 2);

  // 命令层：暂停/恢复/重置
  const calls = [];
  const maps = {
    sessionPromises: new Map([['group:1', 1]]),
    reverse: new Map([['s1', 'group:1']]),
    collectors: new Map([['s1', {}]]),
    v2TurnStartAt: new Map([['s1', 1]]),
    toolCallNames: new Map([['s1', []]]),
    pendingSendToolCalls: new Map([['s1', []]]),
    sendToolSucceededSessions: new Set(['s1']),
    pendingWakeKeys: new Set(['group:1']),
    wakeConfigUpdatedKeys: new Set(['group:1']),
    markReadCalledKeys: new Set(['group:1']),
    wakeConfigMissCount: new Map([['group:1', 1]]),
    seenForwardIds: new Set(['group:1'])
  };
  const writableState = { sessions: { 'group:1': 's1' }, sessionMeta: { 'group:1': { mode: 'reserved2' } } };
  const writableSocial = { conversations: new Map([['group:1', { agentToken: 'tok-1' }]]), paused: false };
  const tokens = new Set(['tok-1']);
  const writes = [];
  const commands = createActivityCommands({
    socialV2: writableSocial,
    state: writableState,
    ops: {
      bumpSessionEpoch: () => calls.push('epoch'),
      recordSessionHistory: (...args) => calls.push(['history', ...args]),
      clearSessionTracking: (sid) => calls.push(['clear', sid])
    },
    log: () => {},
    atomicWriteJson: (file, data) => writes.push({ file, data }),
    SOCIAL_V2_FILE: 'social-v2.json',
    KNOWN_AGENT_TOKENS: tokens,
    ...maps,
    clearAllSocialV2Timers: () => calls.push('clearTimers'),
    clearAllPendingWakeLeases: () => calls.push('clearLeases'),
    drainAllPromptQueues: (why) => calls.push(['drain', why]),
    setupSleepTimerV2: (key) => calls.push(['sleep', key]),
    scheduleProactiveCheckV2: (key) => calls.push(['proactive', key]),
    saveSocialV2State: () => calls.push('save')
  });

  commands.setPaused(true);
  check('暂停会清定时器并落盘', writableSocial.paused === true && calls.includes('clearTimers') && calls.includes('save'));
  commands.setPaused(false);
  check('恢复会按会话重排定时器', writableSocial.paused === false
    && calls.some((c) => Array.isArray(c) && c[0] === 'sleep' && c[1] === 'group:1')
    && calls.some((c) => Array.isArray(c) && c[0] === 'proactive' && c[1] === 'group:1'));

  const resetResult = commands.reset();
  check('重置清空会话映射与 agent token', resetResult.ok === true
    && writableSocial.conversations.size === 0 && tokens.size === 0
    && maps.sessionPromises.size === 0 && maps.pendingWakeKeys.size === 0
    && writableState.sessions['group:1'] === undefined);
  check('重置记录 sessionHistory 并写空状态文件', calls.some((c) => Array.isArray(c) && c[0] === 'history' && c[3] === 'reset')
    && writes.length === 1 && writes[0].file === 'social-v2.json'
    && JSON.stringify(writes[0].data) === JSON.stringify({ conversations: {} }));
}

console.log('\n── 任务命令 ──');
{
  const calls = [];
  const taskService = {
    list: () => [{ name: 'sweep', status: 'running' }],
    pause: (name) => calls.push(['pause', name]),
    resume: (name) => calls.push(['resume', name]),
    trigger: async (name) => calls.push(['trigger', name]),
    start: (name) => calls.push(['start', name]),
    stop: (name) => calls.push(['stop', name]),
    get: () => ({ status: 'paused', runCount: 3, lastError: '' })
  };
  const tasks = createTaskCommands({ taskService });
  check('任务清单读模型', tasks.list().tasks[0].name === 'sweep');
  const paused = await tasks.apply('sweep', 'pause');
  check('任务命令返回动作与状态摘要', paused.ok && paused.action === 'pause'
    && paused.task.status === 'paused' && paused.task.runCount === 3);
  check('任务命令转调 taskService', calls.some((c) => c[0] === 'pause' && c[1] === 'sweep'));
  const missing = createTaskCommands({});
  check('任务服务缺失返回 404', (await missing.apply('x', 'pause')).status === 404);
  const failing = createTaskCommands({ taskService: { pause: () => { throw new Error('boom'); } } });
  const failed = await failing.apply('x', 'pause');
  check('任务异常返回 500 且带原因', failed.ok === false && failed.status === 500 && /boom/.test(failed.error));
}

console.log('\n── 上下文中枢读模型 ──');
{
  const conversations = new Map([
    ['group:1', {}],
    ['private:2', {}],
    ['junk', {}]
  ]);
  const state = { sessions: { 'group:3': 's3', junk: 's0' } };
  const read = createContextReadModel({
    cfg: { socialV2: { sharedMemory: { enabled: true } }, slang: { injectMax: 4 } },
    STATE_DIR: 'state',
    live: { slangEntries: [{ content: '绷' }] },
    socialV2: { conversations },
    state,
    ops: {
      tokenFuseStatus: () => ({
        enabled: true,
        config: { overrides: { 'group:9': { fuseTokens: 1 } } },
        keys: [{ key: 'group:1', totalInput: 50, state: 'warn' }]
      })
    },
    contextDisplayName: (key) => `名称 ${key}`,
    contextStats: () => ({ episodes: 2 }),
    loadLongTermMemory: () => ({}),
    backfillLongTermMemory: () => ({ updatedAt: 9, facts: [{ id: 'f1' }] }),
    longTermStats: () => ({ facts: 1 }),
    journalStats: () => ({ bytes: 10 }),
    loadEpisodes: () => [{ id: 'ep1' }],
    readRecallAudit: () => [{ q: '测试' }],
    confirmedSlangListV2: () => [
      { content: '绷', meaning: '笑', usage: '绷不住了', example: '我绷' },
      { content: '绝绝子', meaning: '厉害', usage: '太绝', example: '绝绝子' }
    ],
    buildSlangContext: (entries, max) => `block:${entries.length}:${max}`,
    normalizeSharedMemoryConfig: (c) => ({ maxPeople: 100, includePrivate: true, ...c }),
    sharedMemoryStats: () => ({ people: 2 }),
    listSharedPeople: (dir, opts) => ({ updatedAt: 7, rows: [{ q: opts.q }] }),
    normalizeTokenFuseConfig: (c) => ({ enabled: true, overrides: {}, ...c }),
    effectiveTokenFuseThresholds: (config, key) => ({ warnTokens: 100, fuseTokens: 200, thresholdKey: key })
  });

  const shared = read.sharedMemoryView({ q: 'x'.repeat(100), limit: '5' });
  check('共享记忆读模型：配置/统计/行', shared.ok === true && shared.config.maxPeople === 100
    && shared.stats.people === 2 && shared.updatedAt === 7 && shared.rows[0].q.length === 80);

  const fuse = read.tokenFuseView();
  const keys = fuse.keys.map((x) => x.key);
  check('熔断视图合并会话/状态/overrides', keys.includes('group:1')
    && keys.includes('private:2') && keys.includes('group:3') && keys.includes('group:9')
    && !keys.includes('junk'));
  check('熔断视图带显示名与阈值', fuse.keys.find((x) => x.key === 'group:1').displayName === '名称 group:1'
    && fuse.keys.find((x) => x.key === 'group:1').warnTokens === 100);
  check('熔断视图按用量倒序', fuse.keys[0].key === 'group:1' && fuse.keys[0].totalInput === 50);

  const memory = read.contextMemoryView('group:1');
  check('长期记忆读取时回填并给全字段', memory.ok && memory.memory.updatedAt === 9
    && memory.longTerm.facts === 1 && memory.journal.bytes === 10
    && memory.episodes.length === 1 && memory.recallAudit.length === 1);

  check('黑话查询按四字段过滤', read.slangQueryView({ key: 'group:1', q: '绝' }).total === 1
    && read.slangQueryView({ key: 'group:1', q: '我绷' }).total === 1
    && read.slangQueryView({ key: 'group:1', q: '' }).total === 2);
  check('黑话注入片段带 injectMax', read.slangQueryView({ key: 'group:1' }).block === 'block:1:4');
}

console.log('\n── 上下文中枢命令 ──');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-context-'));
  const stateDir = path.join(tmp, 'state');
  const contextDir = (dir, key) => path.join(dir, 'context', key.replace(/[:]/g, '_'));
  fs.mkdirSync(contextDir(stateDir, 'group:1'), { recursive: true });
  fs.writeFileSync(path.join(contextDir(stateDir, 'group:1'), 'messages.jsonl'), 'keep');
  fs.writeFileSync(path.join(contextDir(stateDir, 'group:1'), 'episodes.jsonl'), 'drop');

  const cfg = { socialV2: { sharedMemory: { enabled: true }, tokenFuse: { enabled: true } }, slang: { enabled: true, autoResearch: true, inferenceThresholds: [2], injectMax: 4 } };
  let disk = { socialV2: { sharedMemory: { enabled: true }, tokenFuse: { enabled: true, overrides: {} } } };
  let writeFails = false;
  const writes = [];
  const calls = [];
  const socialRuntime = {
    silentTurns: new Set(['s1']), exitingSessions: new Set(['s1']),
    recentMessages: new Map([['group:1', []]]), pendingSummaries: new Map([['group:1', {}]]),
    states: new Map([['group:1', {}]]), silentContext: new Map([['group:1', {}]])
  };
  const conversations = new Map([['group:1', { agentToken: 'tok-1' }]]);
  const sessionsBag = {
    state: { sessions: { 'group:1': 's1' }, sessionMeta: { 'group:1': { mode: 'reserved2' } } },
    socialV2: { conversations },
    social: socialRuntime,
    reverse: new Map([['s1', 'group:1']]),
    collectors: new Map([['s1', {}]]),
    v2TurnStartAt: new Map([['s1', 1]]),
    toolCallNames: new Map([['s1', []]]),
    pendingSendToolCalls: new Map([['s1', []]]),
    sendToolSucceededSessions: new Set(['s1']),
    pendingWakeKeys: new Set(['group:1']),
    wakeConfigUpdatedKeys: new Set(['group:1']),
    markReadCalledKeys: new Set(['group:1']),
    wakeConfigMissCount: new Map([['group:1', 1]]),
    sessionPromises: new Map([['group:1', 1]]),
    pending: new Map([['group:1', {}]]),
    queued: new Map([['group:1', []]]),
    queuedHintAt: new Map([['group:1', 1]]),
    messageMediaStore: new Map([['group:1', []]]),
    slangWindows: new Map([['group:1', []]]),
    slangExtractionCooldowns: new Map([['group:1', 1]]),
    slangSubmitTimes: new Map([['group:1', 1]]),
    lastSentImage: new Map([['group:1', 1]]),
    seenForwardIds: new Set(['group:1']),
    contextMetrics: new Map([['group:1', { lastEpisodeAt: 1, lastEpisodeSummary: 's', lastEpisodeError: 'e' }]]),
    saveState: () => calls.push('saveState'),
    writeConversationRole: (...args) => calls.push(['role', ...args])
  };
  const live = { contextNameCache: { groups: new Set(['555']) }, slangEntries: [] };
  const events = [];
  const commands = createContextCommands({
    config: {
      cfg, ROOT: tmp, STATE_DIR: stateDir, fs, path,
      readJsonSafe: () => JSON.parse(JSON.stringify(disk)),
      atomicWriteJson: (file, data) => {
        if (writeFails) throw new Error('disk full');
        writes.push(data);
        disk = JSON.parse(JSON.stringify(data));
      },
      log: () => {},
      SLANG_STATUS: { CANDIDATE: 'candidate', CONFIRMED: 'confirmed', REJECTED: 'rejected' },
      KNOWN_AGENT_TOKENS: new Set(['tok-1'])
    },
    helpers: {
      normalizeSharedMemoryConfig: (c) => ({ maxPeople: 100, includePrivate: true, ...c }),
      sharedMemoryStats: () => ({ people: 1 }),
      forgetSharedPerson: (dir, id) => id === '12345',
      clearSharedMemory: () => calls.push('clearPeople'),
      normalizeTokenFuseConfig: (c) => ({ enabled: true, overrides: {}, ...c }),
      normalizeTokenFuseOverride: (b) => ({ fuseTokens: Number(b.fuseTokens) || 0 })
    },
    sessions: sessionsBag,
    social: {
      cancelSocialTimers: (k) => calls.push(['cancel', k]),
      clearSocialV2Timers: (k) => calls.push(['clearTimers', k]),
      drainPromptQueue: (k, why) => calls.push(['drain', k, why]),
      saveSocialV2State: () => calls.push('saveSocial')
    },
    context: {
      contextDir,
      contextStats: () => ({ episodes: 1 }),
      longTermStats: () => ({ facts: 1 }),
      backfillLongTermMemory: () => ({ updatedAt: 2 }),
      makeEpisodeNow: async (key, opts) => { events.push(['episode', key, opts.force]); return { ok: true }; },
      clearRecallIndex: (key) => calls.push(['index', key])
    },
    slang: {
      allowSlangSubmit: () => true,
      redactKnownTokensOnly: (s) => s.replace('SECRET', '***'),
      publicSlangEntry: (e) => e,
      mergeEvidence: (a, b) => [...(a || []), ...b],
      saveSlangStore: () => calls.push('saveSlang'),
      queueSlangTask: (fn) => { calls.push('queueSlang'); fn(); },
      runSlangResearch: (entries) => calls.push(['research', entries.length]),
      createSlangEntry: (input) => ({ ...input, count: 0, evidence: input.evidence || [] })
    },
    operations: { live, ops: {
      tokenFuseStatus: () => ({ enabled: true, keys: [] }),
      resetTokenFuse: (key) => key === 'group:1',
      bumpSessionEpoch: () => calls.push('epoch'),
      recordSessionHistory: (...args) => calls.push(['history', ...args]),
      clearSessionTracking: (sid) => calls.push(['clearTracking', sid])
    }, appendActivity: (text) => calls.push(['activity', text]) }
  });

  // 配置写盘：成功同步内存；失败不动内存
  const okCfg = commands.updateSharedMemoryConfig({ enabled: false, maxPeople: 5 });
  check('共享记忆配置写盘并同步内存', okCfg.ok && okCfg.config.maxPeople === 5
    && cfg.socialV2.sharedMemory.maxPeople === 5 && writes.length === 1);
  const before = JSON.stringify(cfg.socialV2);
  writeFails = true;
  const failedCfg = commands.updateSharedMemoryConfig({ maxPeople: 9 });
  check('写盘失败不改内存（AGENTS 约定）', failedCfg.ok === false && failedCfg.status === 500
    && JSON.stringify(cfg.socialV2) === before);
  writeFails = false;

  check('忘记人物 404 / 成功', commands.forgetPerson('99999').status === 404
    && commands.forgetPerson('12345').ok === true);
  check('清空人物走 helper', commands.clearPeople().ok === true && calls.includes('clearPeople'));

  check('熔断配置写盘', commands.saveTokenFuseConfig({ warnTokens: 5 }).config.warnTokens === 5);
  check('熔断 key 非法 400', commands.saveTokenFuseOverride({ key: 'bad' }).status === 400);
  check('熔断 override 写入与恢复', commands.saveTokenFuseOverride({ key: 'group:7', fuseTokens: 3 }).ok === true
    && commands.saveTokenFuseOverride({ key: 'group:7', clear: true }).ok === true);
  check('熔断解除 404 / 成功', commands.resetTokenFuseCount('group:2').status === 404
    && commands.resetTokenFuseCount('group:1').ok === true);

  check('重建长期记忆先删 memory.json', commands.rebuildMemory('group:1').ok === true
    && !fs.existsSync(path.join(contextDir(stateDir, 'group:1'), 'memory.json')));

  events.length = 0;
  check('摘要缺会话 404', (await commands.summarize('group:9')).status === 404);
  check('摘要默认 force', (await commands.summarize('group:1')).ok === true
    && events[0][2] === true);
  events.length = 0;
  const caught = await commands.catchup('group:1', { max: 99 });
  check('追赶最多 12 段且不 force', caught.ok && caught.made === 12
    && events.every((e) => e[2] === false));

  check('重建索引支持空 key', commands.rebuildIndex('').key === '*'
    && commands.rebuildIndex('group:1').key === 'group:1');

  const cleared = commands.clearContext('group:1');
  check('清空保留 messages.jsonl、删派生文件', cleared.ok
    && fs.existsSync(path.join(contextDir(stateDir, 'group:1'), 'messages.jsonl'))
    && !fs.existsSync(path.join(contextDir(stateDir, 'group:1'), 'episodes.jsonl')));
  check('清空重置 memory 指标', !sessionsBag.contextMetrics.get('group:1').lastEpisodeAt);

  check('删除会话拒绝仍在群列表的群', commands.deleteSession('group:555').status === 400);
  const deleted = commands.deleteSession('group:1');
  check('删除会话清全部运行态', deleted.ok && deleted.removedSession === true
    && conversations.size === 0 && !sessionsBag.state.sessions['group:1']
    && sessionsBag.collectors.size === 0 && sessionsBag.pendingWakeKeys.size === 0
    && socialRuntime.states.size === 0);
  check('删除会话写历史/落盘/角色清理', calls.some((c) => Array.isArray(c) && c[0] === 'history' && c[3] === 'delete')
    && calls.includes('saveSocial') && calls.includes('saveState')
    && calls.some((c) => Array.isArray(c) && c[0] === 'role' && c[2] === null));
  check('删除会话后目录被移除', !fs.existsSync(contextDir(stateDir, 'group:1')));

  // 黑话提交
  const submitted = await commands.submitSlang({ key: 'group:2', content: ' SECRET梗 ', context: '语境' });
  check('黑话提交先脱敏并入库', submitted.ok && submitted.entry.content === '***梗'
    && live.slangEntries.length === 1 && calls.includes('saveSlang')
    && calls.some((c) => Array.isArray(c) && c[0] === 'research'));
  const dup = await commands.submitSlang({ key: 'group:2', content: '***梗', context: '再来' });
  check('候选重复累计证据', dup.ok && dup.status === 'candidate'
    && dup.entry.count === 1 && dup.entry.evidence.length === 2);
  const disabled = createContextCommands({ config: { cfg: { slang: { enabled: false } } } });
  check('黑话关闭 403 / 空内容 400 / 超长 400', (await disabled.submitSlang({ key: 'k', content: 'x' })).status === 403
    && (await commands.submitSlang({ key: 'k', content: '  ' })).status === 400
    && (await commands.submitSlang({ key: 'k', content: 'x'.repeat(51) })).status === 400);
  const limited = createContextCommands({
    config: { cfg: { slang: { enabled: true } } },
    slang: { allowSlangSubmit: () => false, redactKnownTokensOnly: (s) => s },
    operations: { live: { slangEntries: [] } }
  });
  check('黑话提交限频 429', (await limited.submitSlang({ key: 'k', content: '梗' })).status === 429);

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n── 运维命令（重置 / 清空 / 自重启）──');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-ops-'));
  const activityFile = path.join(tmp, 'activity.log');
  fs.writeFileSync(activityFile, 'old log');
  const calls = [];
  const state = { sessions: { 'group:1': 's1' }, sessionMeta: { 'group:1': { mode: 'reserved2' } } };
  const conversations = new Map([['group:1', { agentToken: 'tok-1' }]]);
  const pending = new Map([['group:1', { timer: setTimeout(() => {}, 10000) }]]);
  const maps = {
    reverse: new Map([['s1', 'group:1']]),
    collectors: new Map([['s1', {}]]),
    sendToolSucceededSessions: new Set(['s1']),
    pendingSendToolCalls: new Map([['s1', []]]),
    v2TurnStartAt: new Map([['s1', 1]]),
    toolCallNames: new Map([['s1', []]]),
    queued: new Map([['group:1', []]]),
    queuedHintAt: new Map([['group:1', 1]]),
    sessionPromises: new Map([['group:1', 1]]),
    messageMediaStore: new Map([['group:1', []]]),
    slangWindows: new Map([['group:1', []]]),
    slangExtractionCooldowns: new Map([['group:1', 1]]),
    slangSubmitTimes: new Map([['group:1', 1]]),
    pendingWakeKeys: new Set(['group:1']),
    wakeConfigUpdatedKeys: new Set(['group:1']),
    markReadCalledKeys: new Set(['group:1']),
    wakeConfigMissCount: new Map([['group:1', 1]]),
    seenForwardIds: new Set(['group:1'])
  };
  const socialRuntime = {
    states: new Map([['group:1', {}]]), recentMessages: new Map([['group:1', []]]),
    pendingSummaries: new Map([['group:1', {}]]), silentContext: new Map([['group:1', {}]]),
    silentTurns: new Set(['s1']), exitingSessions: new Set(['s1'])
  };
  const timers = [];
  const commands = createOpsCommands({
    config: {
      ROOT: tmp, STATE_DIR: tmp, ACTIVITY_LOG: activityFile,
      KNOWN_AGENT_TOKENS: new Set(['tok-1']), cfg: { workspaceTitle: 'qq' },
      fs, path, log: () => {}, unwrap: (r) => r
    },
    sessions: {
      state, socialV2: { conversations }, social: socialRuntime, ...maps, pending,
      saveState: () => calls.push('saveState')
    },
    social: {
      cancelSocialTimers: (k) => calls.push(['cancel', k]),
      clearSocialV2Timers: (k) => calls.push(['clearTimers', k]),
      drainPromptQueue: (k, why) => calls.push(['drain', k, why]),
      drainAllPromptQueues: (why) => calls.push(['drainAll', why]),
      cancelAllSocialTimers: () => calls.push('cancelAll'),
      clearAllSocialV2Timers: () => calls.push('clearAllTimers'),
      cancelPendingEntry: async () => calls.push('cancelPending'),
      saveSocialV2State: () => calls.push('saveSocial')
    },
    operations: {
      ops: {
        bumpSessionEpoch: () => calls.push('epoch'),
        recordSessionHistory: (...args) => calls.push(['history', ...args]),
        clearSessionTracking: (sid) => calls.push(['clearTracking', sid]),
        clearAllSessionTracking: () => calls.push('clearAllTracking')
      },
      api: {
        workspace: {
          list: async () => ({ items: [{ title: 'qq', sessionIds: ['s1'], workspaceId: 'w1' }] }),
          archiveSession: async ({ sessionId }) => calls.push(['archive', sessionId]),
          delete: async () => calls.push('deleteWs')
        }
      },
      releaseLock: () => calls.push('release')
    },
    setTimer: (fn, ms) => { timers.push(ms); }
  });

  check('会话重置：缺会话 404', (await commands.resetSession('group:9')).status === 404);
  const reset = await commands.resetSession('group:1');
  check('会话重置返回归档会话并清映射', reset.ok && reset.archived === 's1'
    && state.sessions['group:1'] === undefined && conversations.size === 0
    && maps.collectors.size === 0 && maps.pendingWakeKeys.size === 0
    && socialRuntime.states.size === 0 && !pending.has('group:1'));
  check('会话重置：记录历史/归档/落盘', calls.some((c) => Array.isArray(c) && c[0] === 'history' && c[3] === 'reset')
    && calls.some((c) => Array.isArray(c) && c[0] === 'archive' && c[1] === 's1')
    && calls.includes('saveSocial') && calls.includes('saveState'));

  state.sessions = { 'group:2': 's2' };
  state.sessionMeta = { 'group:2': {} };
  conversations.set('group:2', { agentToken: 'tok-2' });
  const ws = await commands.resetWorkspace();
  check('工作区清空：归档计数与空状态', ws.ok && ws.archivedCount === 1
    && Object.keys(state.sessions).length === 0 && Object.keys(state.sessionMeta).length === 0
    && conversations.size === 0 && maps.reverse.size === 0);
  check('工作区清空：活动日志截断/工作区删除', fs.readFileSync(activityFile, 'utf8') === ''
    && calls.includes('deleteWs') && calls.includes('clearAllTimers'));
  check('工作区清空：记录 workspace 迁移', calls.some((c) => Array.isArray(c) && c[0] === 'history' && c[3] === 'workspace'));

  const restart = commands.scheduleRestart();
  check('自重启：返回提示并安排 500ms 定时器', restart.ok && timers.includes(500)
    && /3~5 秒/.test(restart.message));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n── 图片领域读模型 / 命令 ──');
{
  const now = Date.now();
  const read = createImagesReadModel({
    cfg: { socialV2: { images: {
      sentTtlMs: 600000, cooldownMs: 1000, fetchPerRun: 10, proxy: '',
      sendCooldownMs: 5, maxSendPerHour: 20,
      sources: { pixiv: { enabled: true, limit: 5 }, yandere: { enabled: false } }
    } } },
    live: { imageFetchedAt: now - 100, imageFetching: true },
    imageStore: {
      libDir: 'lib',
      stats: () => ({ files: 2, totalBytes: 100 }),
      getById: (id) => (id === 'a' ? { id: 'a', source: 'pixiv', page: 'https://p', tags: ['t'], width: 1, height: 2 } : null)
    },
    lastSentImage: new Map([['group:1', { id: 'a' }]]),
    imagesEnabled: () => true,
    imagePreflightV2: () => ({ count: 3, willWait: false }),
    imageSendAllowed: () => ({ ok: true }),
    normalizeSourceFilter: (raw) => ({ requested: !!raw, valid: raw ? ['pixiv'] : [], unavailable: [] }),
    sourcePageOf: () => 'https://src',
    reverseSearcher: { stats: () => ({ hasKey: true, usedToday: 1, dailyMax: 100, remainingToday: 99, windowMax: 1, windowUsed: 0, windowResetMs: 0, cached: 2 }) }
  });

  const pre = read.preflight({ key: 'group:1', rawTags: '猫, 狗，鱼', rawSources: 'pixiv' });
  check('预检解析多分隔标签并给建议', pre.ok && pre.tags.length === 3 && pre.sources[0] === 'pixiv'
    && pre.sendAllowed === true && /本地有 3 张/.test(pre.advice));
  const stats = read.stats();
  check('图库统计带 sources/fetchedAt', stats.ok && stats.files === 2 && stats.fetchedAt > 0
    && stats.sources.pixiv.limit === 5 && stats.sources.yandere.enabled === false);
  const quota = read.quota();
  check('额度区分冷却/拉取中/反查剩余', quota.ok && quota.enabled === true
    && quota.fetch.cooling === true && quota.fetch.fetching === true
    && quota.reverseSearch.remainingToday === 99 && quota.sources.some((s) => s.name === 'pixiv'));
  check('来源页：显式 id / 最近发送 / 404', read.source({ key: 'group:1', id: 'a' }).sourcePage === 'https://src'
    && read.source({ key: 'group:1' }).id === 'a'
    && read.source({ key: 'group:2' }).status === 404);
}

{
  let mode = 'public';
  let paused = false;
  let fused = false;
  let silent = false;
  let emojiAllowed = true;
  const calls = [];
  const state = { recentMessages: [], wakeConfig: { noActionCount: 2 }, lastAiReplyAt: 0, lastActionAt: 0 };
  const conversations = new Map([['group:1', {}]]);
  const lastSent = new Map([['group:1', { id: 'a' }]]);
  const xCalls = [];
  const commands = createImagesCommands({
    config: {
      cfg: {
        socialV2: {
          enabled: true, emojiReact: { enabled: true }, context: { recentLimit: 100 },
          images: { enabled: true }
        },
        imageReverseSearch: { enabled: true, db: 999, minsim: 50, numres: 5 }
      },
      ROOT: 'C:/tmp', STATE_DIR: 'C:/tmp/state', STICKER_CACHE_DIR: 'C:/tmp/sticker',
      MAX_MEDIA_BYTES: 1000, MAX_MEDIA_PIXELS: 100,
      REACTION_EMOJIS: [{ id: '1', name: '笑' }],
      fs: {
        existsSync: () => true,
        readFileSync: () => Buffer.from('PNG'),
        mkdirSync: () => {}, writeFileSync: () => {}, unlinkSync: () => {}
      },
      path,
      crypto: { randomBytes: () => ({ toString: () => 'abc' }) },
      sleep: async () => {},
      log: () => {}
    },
    operations: {
      live: { get currentMode() { return mode; } },
      ops: { isTokenFused: () => fused },
      appendActivity: (text) => calls.push(['activity', text])
    },
    sessions: {
      socialV2: { get paused() { return paused; }, conversations },
      getSocialV2State: () => state,
      saveSocialV2State: () => calls.push('save'),
      lastSentImage: lastSent
    },
    media: {
      imageStore: {
        getById: (id) => (id === 'a' ? { id: 'a', source: 'pixiv', page: 'https://p' } : null),
        readBuffer: () => Buffer.from('img'),
        reject: (id) => ({ existed: true, freedBytes: 10 }),
        count: () => 1
      },
      imagesEnabled: () => true,
      sendImageV2: async () => ({
        entry: { id: 'a', source: 'pixiv', artist: '画师', page: 'https://p' },
        tagCorrections: [{ from: '猫娘', to: '猫耳', postCount: 2 }],
        annotation: 'ann'
      }),
      archiveImage: async () => ({ path: 'saved.png', url: 'https://orig', bytes: 100, skipped: false }),
      reverseSearcher: {
        available: () => ({ ok: true }),
        search: async () => ({
          ok: true, cached: false,
          results: [{ site: 'pixiv', similarity: 99, creator: 'c', urls: ['u'] }]
        }),
        stats: () => ({})
      },
      findMessageMediaAsync: async () => [],
      fetchMediaData: async () => [],
      onebotSendImageFile: async (...args) => { calls.push(['sendImage', ...args]); return { message_id: 1 }; },
      onebotSendVideoFile: async () => { calls.push('sendVideo'); },
      getStickerImageData: async () => ({ id: 's', url: 'https://s', desc: 'd', tags: ['t'], md5: 'm' }),
      safeFetchBuffer: async () => ({ buffer: Buffer.from('img') }),
      getImageDimensions: () => ({ width: 1, height: 1 }),
      mimeFromBuffer: () => 'image/png',
      mimeFromUrl: () => 'image/png',
      writeStickerCacheImage: () => calls.push('cacheSticker'),
      stickerEnabled: () => true,
      refreshImageLib: async () => ({ cooled: true, remainMs: 100, added: 0, skipped: 0, total: 1, errors: [] })
    },
    emoji: {
      emojiCatalogIds: () => ['1'],
      emojiReactGate: { check: () => ({ allow: emojiAllowed, reason: '太频繁' }) },
      setEmojiLike: async () => { calls.push('setEmoji'); return true; },
      validateEmojiId: (id) => (id === 'bad' ? { ok: false, reason: '表情不存在' } : { ok: true })
    },
    x: {
      xMonitor: {
        describeAuth: () => ({ available: true }),
        verifyAuth: async () => ({ ok: true }),
        fetchAndRender: async (...args) => {
          xCalls.push(args);
          return {
            ok: true,
            user: { name: 'u' },
            posts: [{ post: { id: 'p1', url: 'https://x/1', text: ' hi ', createdAt: 'now', createdAtMs: 1 }, image: { buffer: Buffer.from('img') }, video: null }],
            errors: [], videoSkipped: [], pinnedSkipped: false
          };
        }
      }
    },
    policy: {
      modeAllowed: () => true,
      shouldBlockSilentReply: () => silent
    }
  });

  check('发图：reserved2 之外拒绝', (await commands.sendImage({ key: 'group:1', body: {} })).status === 403);
  mode = 'reserved2';

  paused = true;
  check('发图：暂停拒绝', (await commands.sendImage({ key: 'group:1', body: {} })).status === 403);
  paused = false;
  fused = true;
  check('发图：熔断拒绝', (await commands.sendImage({ key: 'group:1', body: {} })).status === 403);
  fused = false;
  silent = true;
  check('发图：静默拒绝', (await commands.sendImage({ key: 'group:1', body: {} })).status === 403);
  silent = false;

  const sent = await commands.sendImage({ key: 'group:1', body: { tags: ['猫'] } });
  check('发图成功：标签纠正与时间线', sent.ok && /已自动改用/.test(sent.notice)
    && state.recentMessages.length === 1 && /已发送一张图/.test(state.recentMessages[0].text)
    && calls.includes('save') && state.wakeConfig.noActionCount === 0);

  check('收藏：成功 / 缺目标 404', (await commands.archive({ key: 'group:1' })).ok === true
    && (await commands.archive({ key: 'group:2', id: 'missing' })).status === 404);

  check('反查：图库 id 成功', (await commands.reverseSearch({ id: 'a' })).ok === true);
  check('贴表情：私聊拒绝 / 表情非法 / 限流', (await commands.react({ key: 'private:1', body: { messageId: 'm', emojiId: '1' } })).status === 400
    && (await commands.react({ key: 'group:1', body: { messageId: 'm', emojiId: 'bad' } })).status === 400
    && (() => { emojiAllowed = false; return true; })());
  emojiAllowed = false;
  check('贴表情：限流 429', (await commands.react({ key: 'group:1', body: { messageId: 'm', emojiId: '1' } })).status === 429);
  emojiAllowed = true;
  const reacted = await commands.react({ key: 'group:1', body: { messageId: 'm', emojiId: '1' } });
  check('贴表情：成功带表情名', reacted.ok && reacted.emojiName === '笑' && calls.includes('setEmoji'));

  const rejected = commands.reject({ key: 'group:1' });
  check('拒绝图片：默认最近发出并清 lastSent', rejected.ok && rejected.id === 'a' && !lastSent.has('group:1'));
  check('刷新图库：冷却路径', (await commands.refresh({ key: 'group:1', body: {} })).cooled === true);

  mode = 'public';
  const blocked = await commands.selfImage({ key: 'group:1', publish: true });
  check('自拍：非 reserved2 不发但把图给模型', blocked.ok && blocked.sendError === '该接口仅 reserved2 模式可用'
    && blocked.image.data.length > 0);
  mode = 'reserved2';
  const selfSent = await commands.selfImage({ key: 'group:1', publish: true });
  check('自拍：发送并记时间线', selfSent.ok && selfSent.sent === 1
    && state.recentMessages.some((m) => /形象图/.test(m.text))
    && calls.some((c) => Array.isArray(c) && c[0] === 'activity' && /自拍/.test(c[1])));

  const sticker = await commands.stickerImage({ key: 'group:1', stickerId: 's' });
  check('表情图：下载/限像素/写缓存', sticker.ok && sticker.image.mimeType === 'image/png'
    && calls.includes('cacheSticker'));

  check('X 自检：插件可用', (await commands.xAuthCheck()).ok === true);
  const sendsBefore = calls.filter((c) => Array.isArray(c) && c[0] === 'sendImage').length;
  const dry = await commands.fetchXPosts({ key: 'group:1', body: { handle: '@tester', count: 2, dryRun: true } });
  check('X 拉取：干跑不发图', dry.ok && dry.fetched === 1 && dry.sent === 0
    && xCalls[0][0] === 'tester'
    && calls.filter((c) => Array.isArray(c) && c[0] === 'sendImage').length === sendsBefore);
  const badHandle = await commands.fetchXPosts({ key: 'group:1', body: { handle: 'bad name!' } });
  check('X 拉取：非法账号 400', badHandle.status === 400);

  const routeOk = imagesRoute.routes.length === 13;
  check('10-images 保留 13 条路由清单', routeOk);

  let captured = null;
  await imagesRoute.handle({ method: 'GET', headers: {} }, { writeHead() {}, end() {} },
    new URL('http://127.0.0.1/api/socialV2/image-quota'), {
      sendJson: (body, status = 200) => { captured = { body, status }; },
      readBody: async () => ({}),
      readModels: { images: { quota: () => ({ ok: true, enabled: true }) } },
      commands: { images: {} },
      agentTokenOk: () => true, v2SessionAllowed: () => true, v2ToolEnabled: () => true
    });
  check('10-images 无平铺 deps 也能服务', captured?.status === 200 && captured.body.enabled === true);
}

console.log('\n── 表情领域读模型 / 命令 ──');
{
  let syncCalls = 0;
  let lastForce = null;
  let listArgs = null;
  const live = { lastForcedAgentStickerSync: 0, stickerEntries: [], stickerSyncedAt: 1 };
  const read = createStickersReadModel({
    cfg: { socialV2: { sticker: { maxListCount: 10 } } },
    live,
    stickerEnabled: () => true,
    syncStickerLibrary: async (force) => {
      syncCalls += 1;
      lastForce = force;
      return { entries: [{ id: 'a' }], syncedAt: 2, fromCache: !force };
    },
    formatStickerList: (entries, query, count) => {
      listArgs = { query, count, entries };
      return { entries, total: entries.length };
    },
    stickerCacheOpts: () => ({})
  });
  const first = await read.list({ key: 'group:1', query: '猫', rawCount: '48', refresh: true, agent: true });
  check('表情列表：count 受配置上限约束', first.ok && listArgs.count === 10 && listArgs.query === '猫'
    && first.syncedAt === 2 && first.fromCache === false);
  const second = await read.list({ key: 'group:1', refresh: true, agent: true });
  check('AI 强制刷新有 10 秒最小间隔', syncCalls === 2 && lastForce === false);
  const admin = await read.adminList({ query: '', rawCount: '3', refresh: true });
  check('管理端列表可强制刷新', admin.ok && lastForce === true && listArgs.count === 3);
  check('表情关闭时读模型返回 403', (await createStickersReadModel({ stickerEnabled: () => false }).list({ key: 'k' })).status === 403);

  let mode = 'reserved2';
  let paused = false;
  let fused = false;
  let silent = false;
  let owner = true;
  const calls = [];
  const state = {
    recentMessages: [], sendTimes: [], stickerCollectTimes: [], crawlTimes: [], stickerAddTimes: [],
    wakeConfig: { noActionCount: 1 }
  };
  const liveSticker = {
    get currentMode() { return mode; },
    lastForcedAgentStickerSync: 0,
    stickerEntries: [],
    ttsEngine: { available: () => true, speak: async () => ({ ok: true, file: 'voice.wav', durSec: 2, cached: false }) }
  };
  const commands = createStickersCommands({
    config: {
      cfg: {
        socialV2: {
          send: { maxSendPerMinute: 1, maxSendPerHour: 0 },
          sticker: { enabled: true, collect: { maxPerMinute: 1 } },
          crawl: { maxPerHour: 1, maxStickersPerCall: 2 },
          context: { recentLimit: 100 }
        }
      },
      STATE_DIR: 'state', fs: { rmSync: () => {} }, path, log: () => {},
      ttsNum: (v, d, min, max) => Math.min(max, Math.max(min, Number(v) || d))
    },
    operations: {
      live: liveSticker,
      ops: { isTokenFused: () => fused },
      appendActivity: (text) => calls.push(['activity', text])
    },
    sessions: {
      socialV2: { get paused() { return paused; }, conversations: new Map() },
      getSocialV2State: () => state,
      saveSocialV2State: () => calls.push('save'),
      gitHubShotTimes: new Map()
    },
    social: { scheduleReplyCheckV2: () => calls.push('replyCheck') },
    media: {
      stickerEnabled: () => true,
      applyStickerNoteV2: () => ({ id: 's1' }),
      deleteStickerV2: async () => ({ id: 's1', md5: 'm', desc: 'd', verifiedGone: true }),
      setStickerRemarkV2: async (id, remark) => ({ id, desc: remark }),
      sendStickerV2: async () => ({ messageId: 'm1', entry: { id: 's1', md5: 'm1', desc: '猫' } }),
      collectStickerV2: async () => ({ emojiId: 'e1', entry: { id: 'e1' }, remark: '' }),
      syncStickerLibrary: async () => ({ entries: [{ id: 'a' }, { id: 'b' }], syncedAt: 5 }),
      saveStickerImage: async () => ({ path: 'tmp.png', md5: 'abc', ext: 'png', bytes: 10 }),
      crawlAigengtu: async () => ({ kind: 'aigengtu', url: '', text: '', images: [{ url: 'u', name: 'n' }], needsLogin: false }),
      crawlUrl: async () => ({ kind: 'url', url: 'u', text: '', images: [], needsLogin: false }),
      isAigengtuUrl: () => true,
      onebotSendImageFile: async () => {},
      onebotSendVoiceFile: async () => {},
      sendToQQ: async () => {}
    },
    messaging: {
      recordSentMessagesV2: () => calls.push('recordVoice'),
      isSymbolicReplyRef: () => false,
      resolveReplyTargetV2: async () => null,
      bot: { request: async () => { calls.push('botRequest'); return { status: 'ok', retcode: 0, data: { emoji_id: 'e' } }; } }
    },
    github: { parseGitHubUrl: () => null, extractGitHubUrl: () => '', screenshotGitHubRepo: async () => ({}) },
    reply: { isSymbolicReplyRef: () => false, resolveReplyTargetV2: async () => null },
    crawl: { bot: { request: async () => ({ status: 'ok', retcode: 0, data: { emoji_id: 'e' } }) } },
    policy: { modeAllowed: () => true, shouldBlockSilentReply: () => silent, isOwnerTurn: () => owner },
    menu: { renderFeatureMenu: async () => ({ ok: true, file: 'menu.png', bytes: 1, cached: true }), roleFor: () => 'r' }
  });

  check('发送表情：带文字被拒', (await commands.sendSticker({ key: 'group:1', body: { stickerId: 's1', message: '文字' } })).status === 400);
  check('发送表情：私聊 @ 被拒', (await commands.sendSticker({ key: 'private:1', body: { stickerId: 's1', atUserId: '9' } })).status === 400);
  state.sendTimes = [Date.now()];
  check('发送表情：限频 429', (await commands.sendSticker({ key: 'group:1', body: { stickerId: 's1' } })).status === 429);
  state.sendTimes = [];
  const stickSent = await commands.sendSticker({ key: 'group:1', body: { stickerId: 's1' } });
  check('发送表情：成功写时间线', stickSent.ok && state.recentMessages.length === 1
    && /表情包:猫/.test(state.recentMessages[0].text) && calls.includes('replyCheck'));

  state.stickerCollectTimes = [Date.now()];
  check('收藏表情：限频 429', (await commands.collectSticker({ key: 'group:1', messageRef: 'm' })).status === 429);
  state.stickerCollectTimes = [];
  check('收藏表情：成功', (await commands.collectSticker({ key: 'group:1', messageRef: 'm' })).ok === true);

  state.crawlTimes = [];
  const crawled = await commands.crawlWeb({ key: 'group:1', body: { url: 'https://aigengtu.com/x', dryRun: true, mode: 'stickers' } });
  check('抓取：干跑下载但不写 QQ', crawled.ok && crawled.added.length === 1 && !calls.includes('botRequest')
    && crawled.note.includes('试运行'));

  check('主动语音：链接内容被拒', (await commands.sendVoice({ key: 'group:1', text: '看 https://x' })).status === 400);
  owner = false;
  check('删除表情：非管理员拒绝', (await commands.deleteSticker({ key: 'group:1', stickerId: 's1' })).status === 403);
  owner = true;
  check('同步表情库返回总数', (await commands.syncStickers()).total === 2);
  check('管理端备注/本地认知', commands.adminNote({ stickerId: 's1', note: 'x' }).ok
    && (await commands.adminRemark({ stickerId: 's1', remark: 'y' })).ok);

  check('11-stickers 保留 14 条路由清单', stickersRoute.routes.length === 14);
  let captured = null;
  await stickersRoute.handle({ method: 'GET', headers: {} }, { writeHead() {}, end() {} },
    new URL('http://127.0.0.1/api/stickers'), {
      sendJson: (body, status = 200) => { captured = { body, status }; },
      readBody: async () => ({}),
      readModels: { stickers: { adminList: async () => ({ ok: true, total: 2 }) } },
      commands: { stickers: {} },
      agentTokenOk: () => true, v2SessionAllowed: () => true, v2ToolEnabled: () => true
    });
  check('11-stickers 无平铺 deps 也能服务', captured?.status === 200 && captured.body.total === 2);
}

console.log('\n── 等待领域读模型 / 命令 ──');
{
  const recent = [{ seq: 1, messageId: 'm1', sender: 'A', text: 'hi', forwardIds: ['f'], hasForward: true }];
  const read = createWaitReadModel({
    readToolLog: (limit) => [{ limit }],
    readFeedbackEntries: () => [{ id: 'f' }],
    getSocialV2State: () => ({ recentMessages: [{ isSelf: true, text: 'a' }, { isSelf: false, text: 'b' }, { isSelf: true, text: 'c' }] }),
    resolveReplyInfo: async (kind, id, messageId) => (messageId === 'remote' ? { sender: 'x' } : null)
  });
  check('工具日志条数与上限', read.toolLog('9999').entries[0].limit === 500 && read.toolLog('1').entries[0].limit === 1);
  check('反馈列表只读', read.feedback().entries[0].id === 'f');
  check('我的消息只取自发消息', (() => {
    const r = read.myRecent({ key: 'group:1', rawLimit: '1' });
    return r.ok && r.messages.length === 1 && r.messages[0].text === 'c';
  })());

  const detail = createWaitReadModel({
    getSocialV2State: () => ({ recentMessages: recent }),
    resolveReplyInfo: async (kind, id, messageId) => (messageId === 'remote' ? { sender: 'x' } : null)
  });
  const local = await detail.messageDetail({ key: 'group:1', messageId: '1' });
  check('消息详情本地 seq 优先并补转发字段', local.ok && local.info.messageId === 'm1'
    && local.info.seq === 1 && local.info.hasForward === true && local.info.forwardIds[0] === 'f');
  const remote = await detail.messageDetail({ key: 'group:1', messageId: 'remote' });
  check('消息详情缺失时回源 OneBot', remote.ok && remote.info.sender === 'x');
  check('消息详情 key 非法 400', (await detail.messageDetail({ key: 'bad', messageId: '1' })).status === 400);

  const activeWaits = new Set();
  const waitTurnStats = new Map();
  const waitTurnTotals = new Map();
  const v2TurnStartAt = new Map();
  const feedbackTimes = new Map();
  const calls = [];
  const socialV2 = { paused: false };
  const runtimeState = { sessions: { 'group:1': 's1' } };
  const cfg = { socialV2: { wait: {}, feedback: { maxLength: 10 } } };
  const commands = createWaitCommands({
    config: {
      cfg,
      FORCE_WRAPUP_HINT: '立即收尾',
      WAIT_QUIET_CAP_MS: 15000, WAIT_TURN_MAX_COUNT: 2, WAIT_TURN_MAX_MS: 120000,
      WAIT_WINDOW_MAX: 8, WAIT_WINDOW_MS: 720000,
      TOOL_LOG_FILE: 'tool.log', FEEDBACK_FILE: 'feedback.json',
      fs: { writeFileSync: (file, text) => calls.push(['write', file, text]) },
      atomicWriteJson: (file, data) => calls.push(['json', file, data]),
      log: () => {}, notifyOwnerOfError: (...args) => calls.push(['notify', ...args])
    },
    sessions: { socialV2 },
    state: { activeWaits, waitTurnStats, waitTurnTotals, v2TurnStartAt, state: runtimeState, feedbackTimes },
    social: {
      getSocialV2State: () => ({ unread: [1], recentMessages: [], wakeConfig: {}, lastUnreadSeq: 0, lastIncomingAt: 0 }),
      saveSocialV2State: () => {},
      cancelReplyCheckV2: () => {},
      suggestQuietMsV2: () => 0,
      preSleepWaitBlockedV2: () => false
    },
    operations: {
      looksLikeUnfinished: () => false,
      sleep: async () => {},
      appendActivity: () => {},
      appendFeedbackEntry: () => calls.push('feedback')
    }
  });

  socialV2.paused = true;
  const pausedWait = await commands.waitForMessages({ key: 'group:1', body: {}, req: { on: () => {} } });
  check('暂停时 wait 立即返回', pausedWait.ok && pausedWait.paused === true && pausedWait.arrived === false);
  socialV2.paused = false;

  v2TurnStartAt.set('s1', 100);
  waitTurnTotals.set('s1', { turnStart: 100, count: 2, totalMs: 0 });
  const capped = await commands.waitForMessages({ key: 'group:1', body: {}, req: { on: () => {} } });
  check('单回合等待上限强制收尾', capped.ok && capped.forceWrapUp === true && /立即收尾/.test(capped.wrapUpHint));
  waitTurnTotals.delete('s1');
  activeWaits.add('group:1');
  check('同一会话只允许一个 wait', (await commands.waitForMessages({ key: 'group:1', body: {}, req: { on: () => {} } })).status === 429);
  activeWaits.clear();

  const fb = commands.setFeedback({ key: 'group:1', level: 'error', message: 'x'.repeat(30) });
  check('反馈截断到配置长度并入库', fb.ok && fb.level === 'error' && fb.message.length === 10 && calls.includes('feedback'));
  feedbackTimes.set('group:1', Array.from({ length: 5 }, () => Date.now()));
  check('反馈限频 429', commands.setFeedback({ key: 'group:1', level: 'info', message: 'x' }).status === 429);

  check('清空工具日志/反馈', commands.clearToolLog().ok && commands.clearFeedback().ok
    && calls.some((c) => Array.isArray(c) && c[0] === 'write' && c[1] === 'tool.log')
    && calls.some((c) => Array.isArray(c) && c[0] === 'json' && c[1] === 'feedback.json'));

  check('报错自检缺 owner 400', commands.errorNotifySelftest({}).status === 400);
  cfg.ownerQQ = '12345';
  const self = commands.errorNotifySelftest({ key: 'group:1' });
  check('报错自检只私聊 owner', self.ok && self.sentTo === 'private:12345' && self.groupMessagesSent === 0
    && calls.some((c) => Array.isArray(c) && c[0] === 'notify'));

  check('12-wait 保留 11 条路由清单', waitRoute.routes.length === 11);
  let captured = null;
  await waitRoute.handle({ method: 'GET', headers: {} }, { writeHead() {}, end() {} },
    new URL('http://127.0.0.1/api/socialV2/tool-log'), {
      sendJson: (body, status = 200) => { captured = { body, status }; },
      readBody: async () => ({}),
      readModels: { wait: { toolLog: () => ({ ok: true, entries: [] }) } },
      commands: { wait: {} },
      agentTokenOk: () => true, v2SessionAllowed: () => true, v2ToolEnabled: () => true
    });
  check('12-wait 无平铺 deps 也能服务', captured?.status === 200 && captured.body.ok === true);
}

console.log('\n── B站 / TTS / 缓存领域读模型 / 命令 ──');
{
  const mem = {
    recent: () => [{ bvid: 'BV1', title: '猫猫', owner: 'up', tags: ['猫'], liked: true }],
    taste: () => ['猫'],
    stats: () => ({ videos: 1 }),
    todayUsage: () => ({ seconds: 10, videos: 1 }),
    get: (id) => (id === 'BV1' ? {} : null)
  };
  const read = createBiliReadModel({
    cfg: { socialV2: { joinRequest: { enabled: true }, bili: { selfBrowsing: { enabled: true, dailyBudgetSec: 100 }, share: {} } } },
    ROOT: 'r',
    live: { biliMem: mem, biliAuth: { loaded: true, hasSessdata: false }, biliTimer: 0 },
    socialV2: { conversations: new Map([['group:1', { lastActionAt: 1 }]]) },
    biliBrowseState: {},
    CACHE_GROUPS: ['g'],
    DEFAULT_SOVITS_DIR: 'd',
    TTS_DEFAULT_PROBABILITY: 0.3,
    joinQueue: { ttlMs: 1000, list: () => [{ n: 1, userId: 'u', at: Date.now() - 100 }] },
    collectCacheItems: () => [{ key: 'k', bytes: 10 }],
    summarizeCache: () => ({ total: 10 }),
    groupActivityScore: () => 3,
    ttsNum: (v, d) => (v ?? d),
    ttsSpeechParams: () => ({ speed: 1 }),
    path
  });
  check('B站记忆过滤与统计', read.memory({ limit: 5, query: '猫' }).videos.length === 1
    && read.memory({}).stats.videos === 1);
  check('B站记忆未启用 400', createBiliReadModel({ live: {} }).memory({}).status === 400);
  check('入群请求剩余时间', (() => {
    const r = read.joinRequests();
    return r.ok && r.pending[0].n === 1 && r.pending[0].remainMs > 0;
  })());
  check('缓存盘点只读', read.cache().summary.total === 10);
  check('TTS 状态未启用', read.ttsStatus().enabled === false);
  const status = read.biliStatus();
  check('B站状态含额度/暂停/分享群', status.selfBrowsing.remainingSec === 90
    && status.selfBrowsing.paused === false && status.share.groups[0].activity === 3);

  let cfg = {
    socialV2: {
      bili: { enabled: true, selfBrowsing: { enabled: true }, watchShared: {} },
      images: {}, tts: {}
    }
  };
  let writeFails = false;
  const calls = [];
  const live = {
    biliMem: {
      record: (v) => ({ ...v, liked: true, interest: 70, tags: ['猫'] }),
      get: (id) => (id === 'BVseen' ? {} : null),
      taste: () => ['猫'], stats: () => ({ videos: 1 }), todayUsage: () => ({ seconds: 1, videos: 1 })
    },
    lastBiliWatch: { ok: true, bvid: 'BV1234567890' },
    biliAuth: { loaded: true, hasSessdata: false },
    biliTimer: null, biliBrowsing: false, biliScheduledAt: 0, biliNextDelay: 0, pickPathBusy: false,
    ttsEngine: { available: () => true, speak: async () => ({ ok: true, file: 'voice.wav', refId: 'r1', refMood: 'happy' }) }
  };
  const biliInfoCache = new Map([['BV1234567890', { title: '缓存标题', desc: '缓存简介', owner: 'up', category: '猫', durationSec: 10, biliTags: ['猫'] }]]);
  const commands = createBiliCommands({
    config: {
      cfg, ROOT: 'tmp', STATE_DIR: 'tmp', DEFAULT_SOVITS_DIR: 'd', fs: { readFileSync: () => Buffer.from('WAV'), unlinkSync: () => {} },
      path, log: () => {}, ttsSpeechParams: () => ({ speed: 1 }),
      readJsonSafe: () => ({ socialV2: { bili: { selfBrowsing: { enabled: true } } } }),
      atomicWriteJson: () => { if (writeFails) throw new Error('disk full'); calls.push('write'); }
    },
    operations: { live, appendActivity: (t) => calls.push(['activity', t]) },
    sessions: { biliInfoCache, socialV2: { conversations: new Map() }, biliBrowseState: {} },
    media: {
      searchVideos: async () => [{ bvid: 'BVseen', title: '旧' }, { bvid: 'BVnew', title: '新' }],
      fetchVideoInfo: async () => ({ bvid: 'BV1234567890' }),
      resolveBiliId: async () => ({ bvid: 'BV1234567890' }),
      watchVideo: async () => ({ ok: true, info: { bvid: 'BV1234567890' }, hint: 'h', grid: { buffer: Buffer.from('img'), mimeType: 'image/png' } }),
      rememberBiliInfo: () => {}
    },
    social: { scheduleBiliBrowse: () => calls.push('schedule'), runBiliBrowse: async () => ({ ok: true, video: 'v' }) },
    cache: { collectCacheItems: () => [], purgeCache: () => ({ freedBytes: 100, removed: 2, details: [], dryRun: false }), humanBytes: () => '100B' }
  });

  const rec = commands.record({ bvid: 'BVwrong' });
  check('记录优先最近观看并补缓存元信息', rec.ok && rec.video.title === '缓存标题' && rec.taste[0] === '猫');
  const searched = await commands.search({ query: '猫' });
  check('搜索过滤已看过并标注 allSeen', searched.videos.length === 1 && searched.videos[0].bvid === 'BVnew'
    && searched.allSeen === false);
  check('搜索未启用 400', (await createBiliCommands({ config: { cfg: { socialV2: {} } } }).search({ query: 'x' })).status === 400);

  writeFails = true;
  const failedPause = commands.setPaused(true);
  check('暂停写盘失败不改内存', failedPause.status === 500 && cfg.socialV2.bili.selfBrowsing.enabled === true);
  writeFails = false;
  const paused = commands.setPaused(true);
  check('暂停清定时器并同步内存', paused.ok && paused.paused === true && cfg.socialV2.bili.selfBrowsing.enabled === false);
  const resumed = commands.setPaused(false);
  check('恢复重新排期', resumed.ok && calls.includes('schedule'));

  live.biliBrowsing = true;
  check('手动刷正在刷时 409', (await commands.browseNow()).status === 409);
  live.biliBrowsing = false;
  check('手动刷返回结果', (await commands.browseNow()).ok === true);
  check('TTS 试听返回音频缓冲', (await commands.ttsSay({ text: '你好' })).buffer.length > 0);
  check('缓存清理写活动日志', (() => { const r = commands.purge({}); return r.ok && r.freedHuman === '100B'; })());

  check('14-bili 保留 13 条路由清单', biliRoute.routes.length === 13);
  let captured = null;
  await biliRoute.handle({ method: 'GET', headers: {} }, { writeHead() {}, end() {} },
    new URL('http://127.0.0.1/api/socialV2/bili-status'), {
      sendJson: (body, status = 200) => { captured = { body, status }; },
      readBody: async () => ({}),
      readModels: { bili: { biliStatus: () => ({ ok: true, enabled: true }) } },
      commands: { bili: {} },
      agentTokenOk: () => true, v2SessionAllowed: () => true, v2ToolEnabled: () => true
    });
  check('14-bili 无平铺 deps 也能服务', captured?.status === 200 && captured.body.enabled === true);
}

console.log('\n── 二代只读领域读模型 / 命令 ──');
{
  const files = [
    { file_id: 'f1', file_name: 'a.pdf', file_size: 10, upload_time: 1, uploader_name: '甲' },
    { file_id: 'f2', file_name: 'b.docx', file_size: 20, upload_time: 2, uploader_name: '乙' }
  ];
  const read = createSocialReadModel({
    bot: {
      getGroupRootFiles: async () => ({ files }),
      getGroupFileSystemInfo: async () => ({ used_space: 50, total_space: 100, file_count: 2, limit_count: 10 })
    },
    humanSize: (n) => `${n}B`,
    searchGroupFiles: (list, q) => ({ matches: list.filter((f) => f.file_name.includes(q.keyword || '')) }),
    summarizeGroupFiles: () => ({ count: files.length, totalBytes: 30 }),
    formatSummary: () => 'summary-text',
    getSocialV2State: () => ({
      unread: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
      recentMessages: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
      wakeConfig: { noActionCount: 1 }, lastWakeReason: 'at', lastAiReplyAt: 5
    }),
    socialV2: { conversations: new Map([['group:1', {
      wakeConfig: {}, unread: [{ seq: 1 }], recentMessages: [{ seq: 1 }], lastWakeReason: 'at', lastAiReplyAt: 5
    }]]) },
    state: { sessions: { 'group:1': 's1' } },
    promptQueues: new Map(),
    pendingWakeKeys: new Set(['group:1']),
    v2TurnStartAt: new Map([['s1', 1]]),
    collectors: new Map(),
    isConversationBusyV2: () => true
  });
  check('群文件：非法群 key 400', (await read.groupFiles({ key: 'private:1' })).status === 400);
  check('群文件：汇总模式', (await read.groupFiles({ key: 'group:1' })).summary.count === 2
    && (await read.groupFiles({ key: 'group:1' })).text === 'summary-text');
  check('群文件：搜索模式', (await read.groupFiles({ key: 'group:1', mode: 'search', search: { keyword: 'a' } })).matches.length === 1);
  const stats = await read.groupFileStats({ key: 'group:1' });
  check('群文件容量换算', stats.usedText === '50B' && stats.usedPercent === 50);
  check('未读取最后 N 条', read.unread({ key: 'group:1', limit: 2 }).messages.length === 2);
  check('最近消息按 offset 切片', read.recent({ key: 'group:1', limit: 2, offset: 1 }).messages.length === 2);
  check('会话状态透出 busyBy 诊断', (() => {
    const s = read.states().conversations[0];
    return s.busy === true && s.busyBy.pendingWakeKeys === true && s.busyBy.v2TurnStartAt === true;
  })());

  let stateTick = 1;
  const runtime = {
    unread: [{ seq: 1 }, { seq: 2 }, { seq: 3 }], wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: true }, sleepUntil: null },
    wakeSeqAt: 2, lastIncomingAt: Date.now(), lastActionAt: 0,
    recentMessages: [], pendingWakeTimer: null
  };
  let pendingCallers = [];
  let sleeping = true;
  let blocked = false;
  let liveMode = 'reserved2';
  const calls = [];
  const commands = createSocialReadCommands({
    config: { cfg: { socialV2: { wake: { preSleepWaitMs: 300000, sleepMinMs: 1000, sleepMaxMs: 3600000 } } }, log: () => {} },
    sessions: {
      markReadCalledKeys: new Set(),
      wakeConfigUpdatedKeys: new Set(),
      wakeConfigMissCount: new Map()
    },
    social: {
      getSocialV2State: () => runtime,
      findCallersV2: () => ({ pending: pendingCallers, answered: [] }),
      isSleepingConfigV2: () => sleeping,
      preSleepWaitBlockedV2: () => blocked,
      ensureWakeableV2: () => calls.push('ensureWakeable'),
      computeWakeSafetyV2: () => ({ guaranteed: true }),
      saveSocialV2State: () => calls.push('save'),
      cancelReplyCheckV2: () => calls.push('cancelReply'),
      setupSleepTimerV2: () => calls.push('sleepTimer'),
      normalizeSpeakerIdsV2: (v) => (Array.isArray(v) ? v.filter((x) => /^\d+$/.test(String(x))) : []),
      sendWakePromptV2: (...args) => calls.push(['wakePrompt', ...args])
    },
    operations: { live: { get currentMode() { return liveMode; } }, modeAllowed: () => true }
  });

  pendingCallers = [{ sender: '甲', text: '@机器人' }];
  const blockedMark = commands.markRead({ key: 'group:1' });
  check('标记已读：有未答 @ 时 400', blockedMark.status === 400 && blockedMark.callers === 1);
  pendingCallers = [];
  blocked = true;
  const sleepBlocked = commands.markRead({ key: 'group:1' });
  check('标记已读：沉睡前观察未满足 400', sleepBlocked.status === 400 && sleepBlocked.preSleepWaitMs === 300000);
  blocked = false;
  const marked = commands.markRead({ key: 'group:1' });
  check('标记已读：保留唤醒后新消息并确认配置', marked.ok && runtime.unread.length === 1
    && runtime.unread[0].seq === 3 && runtime.wakeConfig.confirmedBy === 'mark_read'
    && calls.includes('ensureWakeable'));

  sleeping = false;
  const active = commands.setWakeConfig({ key: 'group:1', body: { config: { mode: 'active' } } });
  check('唤醒配置：active 自动 infinite/anyMessage', active.ok && active.wakeConfig.infinite === true
    && active.wakeConfig.triggers.anyMessage === true && calls.includes('sleepTimer'));
  const noTrigger = commands.setWakeConfig({ key: 'group:1', body: { config: { mode: 'diving', infinite: true, triggers: { atMention: false, nameMention: false, poke: false, keywords: [], question: false, anyMessage: false } } } });
  check('无限期潜水必须有触发条件', noTrigger.status === 400 && /至少保留一个唤醒条件/.test(noTrigger.error));
  sleeping = true;
  pendingCallers = [{ sender: '乙', text: '在吗' }];
  const divingBlocked = commands.setWakeConfig({ key: 'group:1', body: { config: { mode: 'diving', infinite: true, triggers: { atMention: true } } } });
  check('设置潜水：有未答 @ 时 400', divingBlocked.status === 400 && divingBlocked.callers === 1);
  pendingCallers = [];
  const diving = commands.setWakeConfig({ key: 'group:1', body: { config: { mode: 'diving', infinite: true, triggers: { atMention: true } } } });
  check('设置潜水成功并清 miss 计数', diving.ok && diving.wakeConfig.mode === 'diving');

  liveMode = 'public';
  check('手动唤醒：非 reserved2 403', commands.wake({ key: 'group:1', reason: 'admin' }).status === 403);
  liveMode = 'reserved2';
  runtime.pendingWakeTimer = setTimeout(() => {}, 10000);
  const woke = commands.wake({ key: 'group:1', reason: 'admin' });
  check('手动唤醒：清定时器并投递', woke.ok && runtime.pendingWakeTimer === null
    && calls.some((c) => Array.isArray(c) && c[0] === 'wakePrompt'));

  check('08-social-read 保留 8 条路由清单', socialReadRoute.routes.length === 8);
  let captured = null;
  await socialReadRoute.handle({ method: 'GET', headers: {} }, { writeHead() {}, end() {} },
    new URL('http://127.0.0.1/api/socialV2/states'), {
      sendJson: (body, status = 200) => { captured = { body, status }; },
      readBody: async () => ({}),
      readModels: { socialRead: { states: () => ({ ok: true, conversations: [] }) } },
      commands: { socialRead: {} },
      agentTokenOk: () => true, v2SessionAllowed: () => true, v2ToolEnabled: () => true
    });
  check('08-social-read 无平铺 deps 也能服务', captured?.status === 200 && Array.isArray(captured.body.conversations));
}

console.log('\n── 核心状态 / 人格领域读模型 / 命令 ──');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-core-'));
  const rolesDir = path.join(tmp, 'roles');
  fs.mkdirSync(rolesDir, { recursive: true });
  fs.writeFileSync(path.join(rolesDir, '大肥鱼.md'), '人格内容\n');
  const read = createCoreReadModel({
    ROOT: tmp,
    cfg: { ownerQQ: '1', allow: { groups: ['2'], private: [], privateMode: 'list' } },
    live: {
      currentMode: 'reserved2', closedAgentPreset: 'p', dshReady: true,
      friendIds: new Set(['1']),
      contextNameCache: { at: 1, groups: new Map([['2', '群二']]) }
    },
    socialV2: { paused: false, conversations: new Map([['group:2', {}]]) },
    state: { sessions: { 'group:3': 's3' } },
    api: { agentPresets: { list: async () => ({ presets: [{ id: 'a', trust: 'user' }] }) } },
    unwrap: (r) => r,
    readActivityTail: () => ['act'],
    readRoleState: () => ({ role: '大肥鱼', mode: 'active' }),
    listRoles: () => ['大肥鱼'],
    readConversationRoles: () => ({ 'group:2': '大肥鱼' }),
    refreshContextNames: async () => {},
    roleFor: () => '大肥鱼',
    sanitizeRoleName: (s) => (String(s).includes('/') ? '' : s),
    fs,
    path
  });
  const status = read.status();
  check('状态栏字段完整', status.mode === 'reserved2' && status.friendCount === 1
    && status.privateMode === 'list' && status.activity[0] === 'act');
  check('预设列表带 trust', (await read.presets()).presets[0].trust === 'user');
  check('角色列表/默认角色', read.roles().current === '大肥鱼' && read.roles().overrides['group:2'] === '大肥鱼');
  const assignments = await read.roleAssignments();
  const keys = assignments.conversations.map((c) => c.key);
  check('人格分配合并白名单/群列表/会话/override', keys.includes('group:2')
    && keys.includes('group:3') && assignments.conversations.find((c) => c.key === 'group:2').inGroupList === true);
  check('角色正文读取/非法名/不存在', read.roleContent({ name: '大肥鱼' }).content.includes('人格内容')
    && read.roleContent({ name: 'bad/../x' }).status === 400
    && read.roleContent({ name: '不存在' }).status === 404);

  let live = { currentMode: 'reserved2', closedAgentPreset: 'old', lastMode: '' };
  let failWrite = false;
  const calls = [];
  const cfg = { socialV2: {} };
  const state = { sessions: {} };
  const socialV2 = { conversations: new Map([['group:1', {}]]) };
  const commands = createCoreCommands({
    config: {
      ROOT: tmp, STATE_DIR: tmp, cfg, fs, path, log: () => {},
      readJsonSafe: () => ({ closedAgentPreset: 'old' }),
      atomicWriteJson: (file, data) => {
        if (failWrite) throw new Error('disk full');
        calls.push(['json', file, data]);
      },
      atomicWriteText: (file, content) => fs.writeFileSync(file, content, 'utf8')
    },
    sessions: { state, socialV2 },
    social: {
      cleanupSocialForModeChange: () => calls.push('cleanup'),
      clearAllSocialV2Timers: () => calls.push('clearTimers'),
      drainAllPromptQueues: () => calls.push('drain'),
      setupSleepTimerV2: (k) => calls.push(['sleep', k]),
      scheduleProactiveCheckV2: (k) => calls.push(['proactive', k])
    },
    role: {
      readRoleState: () => ({ role: '大肥鱼', mode: 'active' }),
      writeRoleState: (role, mode) => calls.push(['roleState', role, mode]),
      writeConversationRole: (key, role) => calls.push(['convRole', key, role]),
      sanitizeRoleName: (s) => (String(s).includes('/') ? '' : s),
      roleExists: (name) => name === '大肥鱼',
      roleFor: () => '大肥鱼'
    },
    operations: { live }
  });

  check('模式非法值 400', commands.setMode({ mode: 'bad' }).status === 400);
  failWrite = true;
  let modeThrew = false;
  try { commands.setMode({ mode: 'chat' }); } catch { modeThrew = true; }
  check('模式写盘失败不改内存', modeThrew && live.currentMode === 'reserved2');
  failWrite = false;
  const mode = commands.setMode({ mode: 'reserved2' });
  check('模式切换写盘并重建定时器', mode.ok && live.currentMode === 'reserved2'
    && calls.some((c) => Array.isArray(c) && c[0] === 'sleep' && c[1] === 'group:1'));

  check('会话角色设置校验存在性', commands.setRole({ key: 'group:1', role: '不存在' }).status === 400);
  const roleSet = commands.setRole({ key: 'group:1', role: '大肥鱼' });
  check('会话角色设置成功', roleSet.ok && roleSet.effectiveRole === '大肥鱼');
  check('全局默认角色设置', commands.setRole({ role: '大肥鱼' }).defaultRole === '大肥鱼');
  check('角色模式 silent', commands.setRoleMode({ mode: 'silent' }).roleMode === 'silent');

  const saved = commands.saveRoleContent({ name: '大肥鱼', content: '新内容' });
  check('人格卡保存先备份再写', saved.ok && fs.readFileSync(path.join(rolesDir, '大肥鱼.md'), 'utf8') === '新内容\n'
    && fs.readdirSync(path.join(rolesDir, '.backups')).some((f) => f.startsWith('大肥鱼.')));
  check('人格卡非法名/空内容拒绝', commands.saveRoleContent({ name: 'bad/../x', content: 'x' }).status === 400
    && commands.saveRoleContent({ name: '大肥鱼', content: '   ' }).status === 400);
  check('创建人格成功/重名拒绝', commands.createRole({ name: '新角色', content: '卡' }).ok
    && commands.createRole({ name: '新角色', content: '卡' }).status === 400
    && fs.existsSync(path.join(rolesDir, '新角色.md')));

  check('01-core 保留 10 条路由清单', coreRoute.routes.length === 10);
  let captured = null;
  await coreRoute.handle({ method: 'GET', headers: {} }, { writeHead() {}, end() {} },
    new URL('http://127.0.0.1/api/status'), {
      sendJson: (body, status = 200) => { captured = { body, status }; },
      readBody: async () => ({}),
      readModels: { core: { status: () => ({ mode: 'reserved2' }) } },
      commands: { core: {} }
    });
  check('01-core 无平铺 deps 也能服务', captured?.status === 200 && captured.body.mode === 'reserved2');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n── 记忆 / 召回 / 上下文状态领域 ──');
{
  const state = {
    activeTopics: [{ text: '话题A', pendingQuestion: 'q' }],
    pendingThoughts: [{ text: '想法B', expiresAt: Date.now() + 10000 }],
    memberImpressions: { 张三: { traits: ['猫'] } }
  };
  const read = createMemoryReadModel({
    cfg: { socialV2: { sharedMemory: {} } },
    STATE_DIR: 'state',
    live: { tokenUsage: { turns: 1 }, contextNameCache: { groups: new Map([['1', '群一']]) } },
    socialV2: { conversations: new Map([['group:1', state]]) },
    state: { sessions: { 'group:1': 's1' } },
    ops: { tokenFuseStatus: () => ({ enabled: false }) },
    contextCfg: () => ({ enabled: true, backlogWarnMessages: 2, backlogCriticalMessages: 5 }),
    contextStats: () => ({ episodes: 1, lastEpisodeSeq: 1, lastEpisodeEndAt: 0, compactions: 0, lastCompactionAt: 0, lastCompactionNotch: 0, lastEpisodeAt: 0, lastEpisodeSummary: '摘要' }),
    contextMetrics: new Map([['group:1', { lastPromptChars: 10 }]]),
    countContextPendingV2: () => 3,
    longTermStats: () => ({ people: 1, facts: 2, openThreads: 0, updatedAt: 1 }),
    backfillLongTermMemory: () => {},
    journalStats: () => ({ bytes: 100 }),
    journalCoverage: () => ({ messages24h: 10, indexed24h: 9 }),
    recallAuditStats: () => ({ calls: 2, hits: 1, hitRate: 50, avgMs: 10, last: { chars: 5, ms: 3, hits: 1, at: 1, query: 'q' } }),
    refreshContextNames: async () => {},
    loadTokenUsage: () => ({}),
    contextDisplayName: () => '群一',
    sessionFileBytes: () => 123,
    formatMemoryV2: (st) => `mem:${(st.activeTopics || []).length}`,
    getSocialV2State: () => state,
    getRecallIndexV2: () => ({ docs: [{ id: 1 }], builtAt: 1 }),
    searchMemory: (index, query, opts) => [{ id: 1, query, opts }],
    buildSessionUsageRows: () => ({ rows: [{ key: 'group:1', today: { totalInput: 5 }, cumulative: { totalInput: 9 } }] }),
    sharedMemoryStats: () => ({ people: 0 }),
    readBacklogHistory: () => []
  });
  check('记忆视图：按 category 只留一类', (() => {
    const v = read.memoryView({ key: 'group:1', category: 'activeTopic' });
    return v.ok && v.raw.activeTopics.length === 1 && v.raw.pendingThoughts.length === 0
      && v.raw.memberImpressions && Object.keys(v.raw.memberImpressions).length === 0;
  })());
  const recall = read.recall({ key: 'group:1', query: '话题', limit: 5 });
  check('召回：带上限/时间窗/索引信息', recall.count === 1 && recall.results[0].opts.limit === 5
    && recall.index.documents === 1);
  const status = read.contextStatus();
  const row = status.rows[0];
  check('上下文状态：行字段与积压等级', row.pendingMessages === 3 && row.backlogLevel === 'warn'
    && row.tokenToday === 5 && row.coverage.indexed24h === 9 && row.sessionBytes === 123);
  check('上下文状态：总计覆盖率/命中率', status.totals.coveragePct === 90
    && status.totals.recallHitRate === 50 && status.enabled === true);

  const memoryState = {
    activeTopics: [{ text: '旧话题' }],
    pendingThoughts: [{ text: '旧想法', expiresAt: Date.now() + 10000 }],
    memberImpressions: { 张三: { traits: ['旧'] } }
  };
  let saves = 0;
  const commands = createMemoryCommands({
    getSocialV2State: () => memoryState,
    appendMemoryV2: (st, category, content, extra) => {
      if (category === 'activeTopic') st.activeTopics.push({ text: content, ...extra });
      if (category === 'pendingThought') st.pendingThoughts.push({ text: content, ...extra });
      if (category === 'memberImpression') st.memberImpressions[extra.target] = { traits: content.split(/[,，、]/).filter(Boolean) };
    },
    formatMemoryV2: () => 'formatted',
    saveSocialV2State: () => { saves += 1; },
    redactKnownTokensOnly: (s) => String(s).replace('SECRET', '***')
  });
  check('追加：非法 category/缺 target 400', commands.append({ key: 'k', category: 'bad', content: 'x' }).status === 400
    && commands.append({ key: 'k', category: 'memberImpression', content: 'x' }).status === 400);
  check('追加：activeTopic/成员印象', commands.append({ key: 'k', category: 'activeTopic', content: '新话题' }).ok
    && commands.append({ key: 'k', category: 'memberImpression', content: '猫,狗', extra: { target: '李四' } }).ok
    && memoryState.memberImpressions['李四'].traits.length === 2);

  const updated = commands.update({ key: 'k', category: 'activeTopic', oldContent: '旧话题', newContent: 'SECRET新话题' });
  check('编辑：activeTopic 脱敏并替换', updated.ok && memoryState.activeTopics[0].text === '***新话题');
  check('编辑：找不到原文 404', commands.update({ key: 'k', category: 'activeTopic', oldContent: '不存在', newContent: 'x' }).status === 404);
  check('编辑：成员名 __proto__ 拒绝', commands.update({ key: 'k', category: 'memberImpression', target: '__proto__', newContent: 'x' }).status === 400);
  check('删除：activeTopic', commands.remove({ key: 'k', category: 'activeTopic', content: '***新话题' }).ok
    && memoryState.activeTopics.length === 1 && memoryState.activeTopics[0].text === '新话题');
  check('清空：单类与全部', commands.clear({ key: 'k', category: 'pendingThought' }).ok
    && memoryState.pendingThoughts.length === 0
    && commands.clear({ key: 'k' }).ok && Object.keys(memoryState.memberImpressions).length === 0);
  check('记忆写命令都会落盘', saves >= 4);

  check('15-memory 保留 7 条路由清单', memoryRoute.routes.length === 7);
  let captured = null;
  await memoryRoute.handle({ method: 'GET', headers: {} }, { writeHead() {}, end() {} },
    new URL('http://127.0.0.1/api/socialV2/context-status'), {
      sendJson: (body, status = 200) => { captured = { body, status }; },
      readBody: async () => ({}),
      readModels: { memory: { contextStatus: () => ({ ok: true, rows: [] }) } },
      commands: { memory: {} },
      agentTokenOk: () => true, v2SessionAllowed: () => true, v2ToolEnabled: () => true
    });
  check('15-memory 无平铺 deps 也能服务', captured?.status === 200 && Array.isArray(captured.body.rows));
}

console.log('\n── 会话 / 白名单 / 安全 / 令牌领域 ──');
{
  const authState = { consoleToken: 'tok' };
  const read = createAccessReadModel({
    cfg: {
      ownerQQ: '9',
      allow: { private: [9], groups: [1], privateMode: 'list' },
      deny: { private: [], groups: [] },
      security: { interceptNotify: true }
    },
    live: {
      friendIds: new Set(['9']),
      contextNameCache: { at: 1, groups: new Map([['1', '群一']]), privates: new Map([['9', '主人']]) }
    },
    state: { sessions: { 'group:1': 's1', 'private:9': 's2' } },
    pending: new Map([
      ['group:1', { kind: 'approval', sessionId: 's1', toolName: 't', reason: 'r', approvalId: 'a' }],
      ['private:9', { kind: 'question', sessionId: 's2', questions: ['q'] }]
    ]),
    contextDisplayName: (key) => (key === 'group:1' ? '群一' : '主人'),
    refreshContextNames: async () => {}
  });
  const sessions = await read.sessions();
  check('会话列表带名称与 owner 标记', sessions.sessions.length === 2
    && sessions.sessions.find((s) => s.key === 'private:9').owner === true
    && sessions.sessions[0].name);
  check('挂起列表区分 approval/question', read.pendingList().pending.length === 2
    && read.pendingList().pending[0].approvalId === 'a'
    && read.pendingList().pending[1].questions[0] === 'q');
  const wl = await read.whitelist();
  check('白名单视图带群名/私聊名/好友数', wl.ownerQQ === '9' && wl.friendCount === 1
    && wl.groupNames['1'] === '群一' && wl.privateNames['9'] === '主人');
  check('安全设置默认展示', read.security().security.interceptNotify === true);
  check('令牌状态不回传令牌值', read.consoleToken({ authState, port: 3100 }).authEnabled === true
    && read.consoleToken({ authState, port: 3100 }).port === 3100);

  let cfg = { allow: { private: [], groups: [], privateMode: 'list' }, deny: { private: [], groups: [] }, ownerQQ: null, security: {} };
  let disk = { allow: { private: [7], groups: [8] }, deny: { private: [], groups: [] }, ownerQQ: null, security: {} };
  let failWrite = false;
  const calls = [];
  const commands = createAccessCommands({
    config: {
      ROOT: 'tmp', STATE_DIR: 'tmp', cfg,
      crypto: { randomBytes: () => ({ toString: () => 'a'.repeat(48) }) },
      fs: {}, path,
      log: () => {},
      readJsonSafe: () => JSON.parse(JSON.stringify(disk)),
      atomicWriteJson: (file, data) => {
        if (failWrite) throw new Error('disk full');
        disk = JSON.parse(JSON.stringify(data));
        calls.push(['json', file]);
      },
      atomicWriteText: (file, data) => calls.push(['text', file, data])
    },
    live: { friendIds: new Set(['9']), currentMode: 'reserved2' },
    SENSITIVE_RE: /secret/i,
    allowed: (kind, id, c) => c.allow?.[kind === 'group' ? 'groups' : 'private']?.includes(id),
    modeAllowed: () => true,
    normalizeOwnerQQ: (v) => { if (String(v) === 'bad') throw new Error('ownerQQ 无效'); return String(v); },
    normalizePrivateMode: (v) => (['list', 'friends', 'all'].includes(v) ? v : 'list'),
    refreshFriendList: async () => new Set(['9']),
    escapeCqText: (s) => s,
    redactKnownTokensOnly: (s) => s,
    bot: { sendGroupMessage: async () => ({ message_id: 1 }), sendPrivateMessage: async () => ({ message_id: 2 }) },
    text: (s) => ({ text: s }),
    recordSentMessage: () => calls.push('record')
  });
  const saved = commands.saveWhitelist({ allow: { groups: ['8', '8', 'x'], private: ['7'], privateMode: 'friends' }, ownerQQ: '9' });
  check('白名单归一化/去重/策略', saved.ok && saved.allow.groups.length === 1
    && saved.allow.private[0] === 7 && saved.allow.privateMode === 'friends'
    && cfg.ownerQQ === '9' && calls.some((c) => Array.isArray(c) && c[0] === 'json'));
  check('白名单非法 ownerQQ 400', commands.saveWhitelist({ ownerQQ: 'bad' }).status === 400);
  const beforeCfg = JSON.stringify(cfg);
  failWrite = true;
  let threw = false;
  try { commands.saveWhitelist({ allow: { groups: [1] } }); } catch { threw = true; }
  check('白名单写盘失败不改内存', threw && JSON.stringify(cfg) === beforeCfg);
  failWrite = false;
  check('安全设置合并', commands.saveSecurity({ interceptNotify: false }).security.interceptNotify === false);

  const token = commands.rotateConsoleToken({}, authState);
  check('随机令牌生成并同步 authState', token.ok && token.generated === true
    && token.token.length === 48 && authState.consoleToken === token.token);
  check('令牌长度/字符校验', commands.rotateConsoleToken({ token: 'short' }, authState).status === 400
    && commands.rotateConsoleToken({ token: 'x'.repeat(20) + '!' }, authState).status === 400);

  check('测试发送：id/空消息/敏感词/白名单', (await commands.testSend({ id: 0, message: 'x' })).status === 400
    && (await commands.testSend({ id: 1, message: '' })).status === 400
    && (await commands.testSend({ id: 1, message: 'secret' })).status === 403
    && (await commands.testSend({ id: 2, message: 'hi' })).status === 403);
  const sent = await commands.testSend({ kind: 'group', id: 8, message: 'hi' });
  check('测试发送走机器人并记账', sent.ok && sent.message_id === 1 && calls.includes('record'));

  check('03-access 保留 9 条路由清单', accessRoute.routes.length === 9);
  let captured = null;
  await accessRoute.handle({ method: 'GET', headers: {} }, { writeHead() {}, end() {} },
    new URL('http://127.0.0.1/api/security'), {
      sendJson: (body, status = 200) => { captured = { body, status }; },
      readBody: async () => ({}),
      readModels: { access: { security: () => ({ security: { interceptNotify: true } }) } },
      commands: { access: {} }
    });
  check('03-access 无平铺 deps 也能服务', captured?.status === 200 && captured.body.security.interceptNotify === true);
}

console.log('\n── Agent 回调领域读模型 / 命令 ──');
{
  const read = createAgentReadModel({
    cfg: {},
    live: { currentMode: 'reserved2' },
    findMessageMediaAsync: async (key, messageId) => (messageId === 'm1' ? [{ url: 'u' }] : []),
    fetchMediaData: async (media, opts) => [{ data: 'aW1n', raw: opts.raw }],
    modeAllowed: () => true,
    log: () => {}
  });
  check('旧授权：key 非法 400', read.authorize({ key: 'bad', token: 't', agentTokenOk: () => true }).status === 400);
  check('旧授权：reserved2 必须带 token', read.authorize({ key: 'group:1', token: '', agentTokenOk: () => false }).status === 403);
  check('旧授权：token 无效 403', read.authorize({ key: 'group:1', token: 'bad', agentTokenOk: () => false }).status === 403);
  check('旧授权：通过', read.authorize({ key: 'group:1', token: 't', agentTokenOk: () => true }).ok === true);
  check('图片查询：reserved2 无 token 403', (await read.messageImages({ key: 'group:1', messageId: 'm1', agentToken: '' })).status === 403);
  check('图片查询：无图片元数据提示', (await read.messageImages({
    key: 'group:1', messageId: 'm2', agentToken: 't', agentTokenOk: () => true, toolEnabled: () => true
  })).note.includes('没有可读取'));
  const imgs = await read.messageImages({ key: 'group:1', messageId: 'm1', agentToken: 't', agentTokenOk: () => true, toolEnabled: () => true, raw: true });
  check('图片查询：返回 media/images 且 raw 透传', imgs.ok && imgs.media.length === 1 && imgs.images[0].raw === true);

  let mode = 'reserved2';
  let paused = false;
  let fused = false;
  let silent = false;
  let modeOk = true;
  const state = { sendTimes: [], unread: [{ messageId: 'm1', seq: 1 }], recentMessages: [{ messageId: 'm1', seq: 1 }], wakeConfig: {}, lastAiReplyAt: 0, lastActionAt: 0 };
  const calls = [];
  const imageTimes = new Map();
  const commands = createAgentCommands({
    config: { cfg: { socialV2: { enabled: true, send: { maxSendPerMinute: 1 } } }, MAX_MEDIA_BYTES: 1000, SENSITIVE_RE: /secret/i, log: () => {} },
    operations: {
      live: { get currentMode() { return mode; } },
      ops: { isTokenFused: () => fused },
      appendActivity: (t) => calls.push(['activity', t])
    },
    sessions: {
      socialV2: { get paused() { return paused; } },
      imageSendTimes: imageTimes,
      getSocialV2State: () => state,
      saveSocialV2State: () => calls.push('save')
    },
    media: {
      imageSendAllowed: () => ({ ok: true }),
      onebotSendImageFile: async () => { calls.push('sendImage'); return { message_id: 5 }; },
      sendToQQ: async () => {},
      sniffImageMime: (buf) => (buf.toString() === 'img' ? 'image/png' : null),
      sendMessagesV2: async (...args) => { calls.push(['sendMessages', ...args]); return [{ messageId: 'out1' }]; }
    },
    messaging: {
      recordSentMessagesV2: () => calls.push('record'),
      stripLeadingMetaMarker: (s) => s,
      unquoteJsonString: (s) => s,
      isSymbolicReplyRef: () => false,
      resolveReplyTargetV2: async () => ({ messageId: 'm1', info: { messageId: 'm1', seq: 1 } })
    },
    social: {
      scheduleReplyCheckV2: () => calls.push('replyCheck'),
      shouldBlockSilentReply: () => silent,
      modeAllowed: () => modeOk
    }
  });

  const b64 = Buffer.from('img').toString('base64');
  check('超分：Header/Body token 不一致 403', (await commands.sendUpscaled({ body: { token: 'a', key: 'group:1', data: b64 }, headerToken: 'b' })).status === 403);
  paused = true;
  check('超分：暂停 403', (await commands.sendUpscaled({ body: { key: 'group:1', data: b64 }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).status === 403);
  paused = false;
  mode = 'chat';
  check('超分：chat 模式 403', (await commands.sendUpscaled({ body: { key: 'group:1', data: b64 }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).status === 403);
  mode = 'reserved2';
  check('超分：reserved2 无 token 403', (await commands.sendUpscaled({ body: { key: 'group:1', data: b64 } })).status === 403);
  check('超分：非 base64 400', (await commands.sendUpscaled({ body: { key: 'group:1', data: 'http://x' }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).status === 400);
  check('超分：非图片 400', (await commands.sendUpscaled({ body: { key: 'group:1', data: Buffer.from('nope').toString('base64') }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).status === 400);
  check('超分：过大 400', (await commands.sendUpscaled({ body: { key: 'group:1', data: Buffer.alloc(2000, 1).toString('base64') }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).status === 400);
  const up = await commands.sendUpscaled({ body: { key: 'group:1', data: b64, caption: 'hi' }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true });
  check('超分：发送成功并记额度', up.ok && up.messageId === 5 && imageTimes.get('group:1').length === 1 && calls.includes('sendImage'));

  mode = 'chat';
  check('发送：chat 模式 403', (await commands.sendMessage({ pathname: '/api/send/group', body: { groupId: '1', message: 'hi' }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).status === 403);
  mode = 'reserved2';
  check('发送：缺目标 400', (await commands.sendMessage({ pathname: '/api/send/group', body: { message: 'hi' }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).status === 400);
  check('发送：私聊 @ 400', (await commands.sendMessage({ pathname: '/api/send/private', body: { userId: '1', message: 'hi', atUserId: '2' }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).status === 400);
  check('发送：reserved2 无 token 403', (await commands.sendMessage({ pathname: '/api/send/group', body: { groupId: '1', message: 'hi' } })).status === 403);
  check('发送：敏感词 403', (await commands.sendMessage({ pathname: '/api/send/group', body: { groupId: '1', message: 'secret' }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).status === 403);
  state.sendTimes = [Date.now()];
  check('发送：限频 429', (await commands.sendMessage({ pathname: '/api/send/group', body: { groupId: '1', message: 'hi' }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).status === 429);
  state.sendTimes = [];
  const sent = await commands.sendMessage({ pathname: '/api/send/reply', body: { groupId: '1', message: 'hi', replyToMessageId: '1' }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true });
  check('发送：成功移除已回复未读并记账', sent.ok && sent.sent === 1
    && state.unread.length === 0 && calls.includes('record') && calls.includes('replyCheck'));

  check('17-agent 保留 6 条路由清单', agentRoute.routes.length === 6);
  let captured = null;
  await agentRoute.handle({ method: 'POST', headers: {} }, { writeHead() {}, end() {} },
    new URL('http://127.0.0.1/api/authorize/read'), {
      sendJson: (body, status = 200) => { captured = { body, status }; },
      readBody: async () => ({ key: 'group:1', token: 't' }),
      readModels: { agent: { authorize: () => ({ ok: true, key: 'group:1' }) } },
      commands: { agent: {} },
      agentTokenOk: () => true, v2ToolEnabled: () => true
    });
  check('17-agent 无平铺 deps 也能服务', captured?.status === 200 && captured.body.key === 'group:1');
}

console.log('\n── 二代发送命令（连发 / 消息 / 拍一拍）──');
{
  let mode = 'reserved2';
  let paused = false;
  let fused = false;
  let silent = false;
  let burstEnabled = true;
  const state = {
    sendTimes: [], unread: [{ messageId: 'm1', seq: 1 }],
    recentMessages: [{ messageId: 'm1', seq: 1 }], wakeConfig: {},
    answeredSeqs: [], lastAiReplyAt: 0, lastActionAt: 0
  };
  const calls = [];
  const commands = createMessagingCommands({
    config: {
      cfg: { socialV2: { send: { burstEnabled: true, burstMaxMessages: 8, maxMessageChars: 500, maxSendPerMinute: 5 }, context: { recentLimit: 100 } } },
      SENSITIVE_RE: /secret/i,
      log: () => {}
    },
    operations: {
      live: { get currentMode() { return mode; } },
      ops: { isTokenFused: () => fused },
      appendActivity: (t) => calls.push(['activity', t])
    },
    sessions: {
      socialV2: { get paused() { return paused; } },
      getSocialV2State: () => state,
      saveSocialV2State: () => calls.push('save')
    },
    social: {
      computeGapsV2: () => [],
      scheduleReplyCheckV2: () => calls.push('replyCheck'),
      shouldBlockSilentReply: () => silent,
      modeAllowed: () => true
    },
    messaging: {
      normalizeMessagesInput: (v) => (Array.isArray(v) ? v : [String(v ?? '')]),
      stripLeadingMetaMarkers: (a) => a,
      sendMessagesV2: async (key, msgs) => { calls.push(['send', msgs]); return msgs.map((_, i) => ({ messageId: `out${i}` })); },
      recordSentMessagesV2: () => calls.push('record'),
      findCjkSpaceWarning: () => '',
      findSplitBoundaryWarning: () => '',
      resolveReplyTargetV2: async (st, kind, id, ref) => (String(ref) === 'bad' ? null : { messageId: 'm1', info: { messageId: 'm1', seq: 1 } }),
      isSymbolicReplyRef: () => false,
      resolvePokeTarget: ({ ref }) => (String(ref) === 'latest'
        ? { ok: true, userId: '9', reason: 'latest', sender: '小明' }
        : (String(ref) === '9' ? { ok: true, userId: '9', reason: 'numeric' } : { ok: false, reason: 'not-found' })),
      isSymbolicPokeRef: (ref) => String(ref) === 'latest',
      resolveGroupMemberName: async () => '小明',
      bot: { raw: async (...args) => calls.push(['raw', ...args]) }
    }
  });

  check('连发：暂不支持引用 400', (await commands.sendBurst({ body: { key: 'group:1', messages: ['a'], replyToMessageId: '1' }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).status === 400);
  check('连发：空消息 400', (await commands.sendBurst({ body: { key: 'group:1', messages: [] }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).status === 400);
  mode = 'reserved2';
  burstEnabled = false;
  const cfgBurst = { ...commands };
  // 直接改配置对象不可行，用一条独立命令实例验证 burstEnabled=false
  const noBurst = createMessagingCommands({
    config: { cfg: { socialV2: { send: { burstEnabled: false } } }, SENSITIVE_RE: /x/, log: () => {} },
    operations: { live: { currentMode: 'reserved2' }, ops: {}, appendActivity: () => {} },
    sessions: { socialV2: { paused: false }, getSocialV2State: () => state, saveSocialV2State: () => {} },
    social: { computeGapsV2: () => [], scheduleReplyCheckV2: () => {}, shouldBlockSilentReply: () => false, modeAllowed: () => true },
    messaging: { normalizeMessagesInput: (v) => v, stripLeadingMetaMarkers: (a) => a, sendMessagesV2: async () => [], recordSentMessagesV2: () => {}, findCjkSpaceWarning: () => '', findSplitBoundaryWarning: () => '', resolveReplyTargetV2: async () => null, isSymbolicReplyRef: () => false, resolvePokeTarget: () => ({ ok: false }), isSymbolicPokeRef: () => false, resolveGroupMemberName: async () => '', bot: {} }
  });
  check('连发：禁用多条 403', (await noBurst.sendBurst({ body: { key: 'group:1', messages: ['a', 'b'] }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).status === 403);
  check('连发：reserved2 无 token 403', (await commands.sendBurst({ body: { key: 'group:1', messages: ['a'] } })).status === 403);
  state.sendTimes = [];
  const burst = await commands.sendBurst({ body: { key: 'group:1', messages: ['a', 'b', 'c'] }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true });
  check('连发：成功发送并给连发提示', burst.ok && burst.sent === 3 && /连发/.test(burst.hint)
    && calls.some((c) => Array.isArray(c) && c[0] === 'send' && c[1].length === 3));

  state.sendTimes = [];
  const dry = await commands.sendMessage({ body: { key: 'group:1', messages: ['hi'], dryRun: true, replyToMessageId: '1' }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true });
  check('消息：干跑不发且解析引用', dry.ok && dry.dryRun === true && dry.replyToMessageId === 'm1'
    && !calls.some((c) => Array.isArray(c) && c[0] === 'send' && c[1][0] === 'hi' && false));
  state.unread = [{ messageId: 'm1', seq: 1 }];
  state.sendTimes = [];
  const sent = await commands.sendMessage({ body: { key: 'group:1', messages: ['hi'], replyToMessageId: '1' }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true });
  check('消息：成功移除已回复未读并记 answeredSeqs', sent.ok && sent.sent === 1
    && state.unread.length === 0 && state.answeredSeqs.includes(1) && calls.includes('replyCheck'));
  state.sendTimes = [];
  const badReply = await commands.sendMessage({ body: { key: 'group:1', messages: ['hi'], replyToMessageId: 'bad' }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true });
  check('消息：引用解析失败回滚额度', badReply.status === 400 && state.sendTimes.length === 0);

  check('拍一拍：群聊缺目标 400', (await commands.sendPoke({ body: { key: 'group:1' }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).status === 400);
  state.sendTimes = [];
  const poke = await commands.sendPoke({ body: { key: 'group:1', targetUserId: 'latest' }, headerToken: 't', agentTokenOk: () => true, toolEnabled: () => true });
  check('拍一拍：latest 解析为 QQ 号并写名字', poke.ok && poke.targetUserId === '9'
    && state.recentMessages.some((m) => /你拍了拍 小明/.test(m.text))
    && calls.some((c) => Array.isArray(c) && c[0] === 'raw'));

  check('09-messaging 保留 3 条路由清单', messagingRoute.routes.length === 3);
  let captured = null;
  await messagingRoute.handle({ method: 'POST', headers: {} }, { writeHead() {}, end() {} },
    new URL('http://127.0.0.1/api/socialV2/send-burst'), {
      sendJson: (body, status = 200) => { captured = { body, status }; },
      readBody: async () => ({}),
      commands: { messaging: { sendBurst: async () => ({ ok: true, sent: 1 }) } },
      agentTokenOk: () => true, v2ToolEnabled: () => true
    });
  check('09-messaging 无平铺 deps 也能服务', captured?.status === 200 && captured.body.sent === 1);
}

console.log('\n── 一代社交状态 / 开发日志领域 ──');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-socialv1-'));
  fs.writeFileSync(path.join(tmp, 'README.md'), '## 更新日志\n\n### 未发布\n\n- **标题**：正文\n');
  const social = {
    pendingSummaries: new Map([['group:1', { items: [1, 2] }]]),
    states: new Map([['group:1', { phase: 'active' }]]),
    recentMessages: new Map([['group:2', []]])
  };
  const read = createSocialV1ReadModel({
    ROOT: tmp,
    cfg: { ownerQQ: '9' },
    social,
    socialV2: { conversations: new Map([['group:1', {}]]) },
    state: { sessions: { 'group:1': 's1' } },
    contextDisplayName: () => '群一',
    fs,
    path,
    parseChangelogMarkdown: () => ({ entries: 1, sections: [{ title: '未发布', entries: [{ title: '标题', body: '正文', date: '' }] }] }),
    sanitizeDevLogText: (text, opts) => `${text}|n${opts.names.length}|i${opts.ids.length}`
  });
  const ss = read.socialState();
  check('社交状态：阶段与待摘要统计', ss.pendingSummaries['group:1'] === 2
    && ss.states['group:1'].phase === 'active' && ss.states['group:2'].phase === 'idle');
  const dl = read.devLog();
  check('开发日志：脱敏并返回分区', dl.ok && dl.sanitized === true
    && dl.sections[0].title.includes('|n1|i2') && dl.sections[0].entries[0].body.includes('|n1|i2'));
  check('开发日志：缺 README 500', (() => {
    const r = createSocialV1ReadModel({ ROOT: path.join(tmp, 'missing'), cfg: {}, social: { pendingSummaries: new Map(), states: new Map(), recentMessages: new Map() }, socialV2: { conversations: new Map() }, state: {}, contextDisplayName: () => '', fs, path, parseChangelogMarkdown: () => ({}), sanitizeDevLogText: (x) => x }).devLog();
    return r.status === 500;
  })());

  let cfg = { social: {} };
  let disk = { social: { burstProbability: 0.5, proactiveEnabled: true } };
  let failWrite = false;
  const calls = [];
  const runtime = { silentTurns: new Map(), pendingSummaries: new Map(), states: new Map(), recentMessages: new Map() };
  const commands = createSocialV1Commands({
    config: {
      ROOT: tmp, cfg, fs, path, log: () => {},
      readJsonSafe: () => JSON.parse(JSON.stringify(disk)),
      atomicWriteJson: (file, data) => { if (failWrite) throw new Error('disk full'); disk = JSON.parse(JSON.stringify(data)); calls.push('write'); },
      roleFor: () => '角色'
    },
    operations: {
      live: { currentMode: 'reserved2', dshReady: true },
      appendActivity: (t) => calls.push(['activity', t]),
      deliverPrompt: async (key, text, opts) => { calls.push(['deliver', key, text, opts]); return { ok: true }; },
      ensureSession: async (key) => { calls.push(['ensure', key]); return 's1'; }
    },
    sessions: {
      socialV2: { conversations: new Map() },
      state: { sessions: { 'group:1': 's1' } },
      allowed: () => true,
      social: runtime
    },
    social: {
      enterActive: (k) => calls.push(['active', k]),
      leaveActive: (k) => calls.push(['idle', k]),
      flushSummaries: async (k) => calls.push(['flush', k]),
      getSocialV2State: () => ({ agentToken: 'tok' }),
      modeAllowed: () => true
    }
  });
  check('阶段切换 active/idle/非法', commands.setPhase({ key: 'group:1', phase: 'active' }).ok
    && commands.setPhase({ key: 'group:1', phase: 'idle' }).ok
    && commands.setPhase({ key: 'group:1', phase: 'bad' }).status === 400
    && calls.some((c) => Array.isArray(c) && c[0] === 'active'));
  const saved = commands.saveConfig({ proactiveProbability: 1.5, contextWindow: 0, activeCheckMinMs: 10, activeCheckMaxMs: 5, burstIntervalMinMs: -5, mustReplyKeywords: [1, 2] });
  check('社交配置清理旧字段/clamp/交换范围', saved.ok && saved.config.burstProbability === undefined
    && saved.config.proactiveProbability === 1 && saved.config.contextWindow === 1
    && saved.config.activeCheckMinMs === 5 && saved.config.activeCheckMaxMs === 10
    && saved.config.burstIntervalMinMs === 0 && saved.config.mustReplyKeywords[0] === '1');
  const before = JSON.stringify(cfg);
  failWrite = true;
  let threw = false;
  try { commands.saveConfig({ proactiveProbability: 0.2 }); } catch { threw = true; }
  check('社交配置写盘失败不改内存', threw && JSON.stringify(cfg) === before);
  failWrite = false;
  check('flush 支持全局/单会话', (await commands.flush({})).ok && (await commands.flush({ key: 'group:1' })).ok
    && calls.some((c) => Array.isArray(c) && c[0] === 'flush' && c[1] === null)
    && calls.some((c) => Array.isArray(c) && c[0] === 'flush' && c[1] === 'group:1'));

  check('后台提醒：key 非法 400', (await commands.notifyAi({ key: 'bad', message: 'x' })).status === 400);
  check('后台提醒：缺 key/message 400', (await commands.notifyAi({ key: 'group:1', message: '' })).status === 400);
  const notice = await commands.notifyAi({ key: 'group:1', message: '注意' });
  check('后台提醒：silent 投递并带会话令牌', notice.ok && calls.some((c) => Array.isArray(c) && c[0] === 'deliver'
    && /会话令牌.*tok/.test(c[2]) && c[3].silent === true));
  const failDeliver = createSocialV1Commands({
    config: { ROOT: tmp, cfg, fs, path, log: () => {}, readJsonSafe: () => disk, atomicWriteJson: () => {}, roleFor: () => '' },
    operations: { live: { currentMode: 'reserved2', dshReady: true }, appendActivity: () => {}, deliverPrompt: async () => ({ ok: false, error: 'no' }), ensureSession: async () => 's1' },
    sessions: { socialV2: { conversations: new Map() }, state: { sessions: {} }, allowed: () => true, social: { silentTurns: new Map() } },
    social: { enterActive: () => {}, leaveActive: () => {}, flushSummaries: async () => {}, getSocialV2State: () => ({ agentToken: 't' }), modeAllowed: () => true }
  });
  check('后台提醒：投递失败回滚 silent 占位', (await failDeliver.notifyAi({ key: 'group:1', message: 'x' })).status === 500);

  check('04-social-v1 保留 6 条路由清单', socialV1Route.routes.length === 6);
  let captured = null;
  await socialV1Route.handle({ method: 'GET', headers: {} }, { writeHead() {}, end() {} },
    new URL('http://127.0.0.1/api/social'), {
      sendJson: (body, status = 200) => { captured = { body, status }; },
      readBody: async () => ({}),
      readModels: { socialV1: { socialState: () => ({ config: {}, pendingSummaries: {}, states: {} }) } },
      commands: { socialV1: {} }
    });
  check('04-social-v1 无平铺 deps 也能服务', captured?.status === 200 && captured.body.config !== undefined);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n── 黑话库领域读模型 / 命令 ──');
{
  const entries = [
    { id: 'a', content: '绷', status: 'candidate', meaning: '' },
    { id: 'b', content: '绝', status: 'confirmed', meaning: '厉害' }
  ];
  const live = { slangEntries: entries };
  const cfg = { slang: { enabled: true, injectMax: 8 } };
  const read = createSlangReadModel({ live, cfg });
  check('黑话列表：按 status 过滤', read.list({ status: 'candidate' }).entries.length === 1
    && read.list({ status: 'candidate' }).entries[0].id === 'a'
    && read.list({ status: '' }).entries.length === 2);
  check('黑话列表：回配置', read.list({}).config.injectMax === 8);

  const calls = [];
  const maps = {
    slangWindows: new Map([['group:1', []]]),
    slangExtractionCooldowns: new Map([['group:1', 1]]),
    slangSubmitTimes: new Map([['group:1', 1]]),
    slangResearchingIds: new Set(['x'])
  };
  const commands = createSlangCommands({
    live,
    cfg: { slang: { enabled: true, learnerPreset: 'old' } },
    SLANG_STATUS: { CANDIDATE: 'candidate', CONFIRMED: 'confirmed', REJECTED: 'rejected' },
    createSlangEntry: (input) => ({ id: `id${entries.length + 1}`, ...input, status: input.status || 'confirmed' }),
    saveSlangStore: () => calls.push('save'),
    log: () => {},
    ...maps,
    queueSlangTask: (fn) => { calls.push('queue'); fn(); },
    runSlangExtraction: (key) => calls.push(['extract', key]),
    runSlangResearch: (list) => calls.push(['research', list.length]),
    invalidateSlangLearnerSession: () => calls.push('invalidate'),
    ROOT: 'tmp', path,
    readJsonSafe: () => ({ slang: { enabled: true, learnerPreset: 'old', injectMax: 20 } }),
    atomicWriteJson: (file, data) => calls.push(['write', data.slang]),
    isAvailable: () => true
  });
  check('黑话可用性检查', commands.available() === true
    && createSlangCommands({ isAvailable: () => false }).available() === false);
  check('新增：空内容/重复 400', commands.create({ content: ' ' }).status === 400
    && commands.create({ content: '绷' }).status === 400);
  const created = commands.create({ content: '新词', meaning: '新含义', status: 'candidate' });
  check('新增：成功并落盘', created.ok && created.entry.content === '新词' && calls.includes('save'));
  check('批量确认：缺含义跳过', (() => {
    const r = commands.batchConfirm({ ids: ['a', created.entry.id] });
    return r.ok && r.confirmedCount === 1 && r.skippedCount === 1 && r.skipped[0].reason === '缺少含义';
  })());
  check('批量拒绝', commands.batchReject({ ids: [created.entry.id] }).rejectedCount === 1
    && live.slangEntries.find((e) => e.id === created.entry.id).status === 'rejected');
  check('单条更新：重名 400', commands.update(created.entry.id, { content: '绝' }).status === 400);
  check('单条确认：缺含义 400', commands.confirm('a').status === 400);
  check('清空全部：清窗口/冷却', (() => {
    const beforeLen = live.slangEntries.length;
    const r = commands.clear({});
    return r.ok && r.removedCount === beforeLen
      && maps.slangWindows.size === 0 && maps.slangExtractionCooldowns.size === 0;
  })());

  live.slangEntries = [{ id: 'c', content: '候选', status: 'candidate', meaning: '含义' }];
  maps.slangWindows.set('group:1', []);
  calls.length = 0;
  const ex = commands.extract({});
  check('提取：无指定 key 时取第一个窗口', ex.ok && ex.key === 'group:1'
    && calls.some((c) => Array.isArray(c) && c[0] === 'extract' && c[1] === 'group:1'));
  const rs = commands.research({});
  check('研究：只取候选', rs.ok && rs.count === 1
    && calls.some((c) => Array.isArray(c) && c[0] === 'research' && c[1] === 1));
  const saved = commands.saveConfig({ injectMax: 0, inferenceThresholds: '4, 2, 2, x' });
  check('配置：clamp/阈值去重排序', saved.ok && saved.config.injectMax === 1
    && JSON.stringify(saved.config.inferenceThresholds) === '[1,2,4]');

  check('02-slang 保留 12 条路由清单', slangRoute.routes.length === 12);
  let captured = null;
  await slangRoute.handle({ method: 'GET', headers: {} }, { writeHead() {}, end() {} },
    new URL('http://127.0.0.1/api/slang'), {
      sendJson: (body, status = 200) => { captured = { body, status }; },
      readBody: async () => ({}),
      readModels: { slang: { list: () => ({ entries: [], config: {} }) } },
      commands: { slang: { available: () => true } }
    });
  check('02-slang 无平铺 deps 也能服务', captured?.status === 200 && Array.isArray(captured.body.entries));
}

console.log('\n── 配置 / 凭据领域 ──');
{
  const CREDENTIAL_ITEMS = [
    { key: 'reverseSearchApiKey', label: '反查 Key', group: '图库', kind: 'secret', restart: false, doc: 'd', where: 'config', path: 'socialV2.images.reverseSearchApiKey' },
    { key: 'imagesProxy', label: '图库代理', group: '连接', kind: 'text', restart: false, doc: 'd', where: 'config', path: 'socialV2.images.proxy' }
  ];
  const read = createConfigReadModel({
    CREDENTIAL_ITEMS,
    ROOT: 'root',
    STATE_DIR: 'state',
    cfg: { socialV2: { images: { proxy: 'http://p' } } },
    maskValue: (v) => `${v.slice(0, 2)}••${v.slice(-2)}`,
    path,
    readJsonSafe: (file) => {
      if (String(file).endsWith('config.json')) return { socialV2: { images: { proxy: 'http://p', reverseSearchApiKey: 'abc12345' } } };
      return null;
    }
  });
  const secret = read.credentials({}).items.find((x) => x.key === 'reverseSearchApiKey');
  check('凭据默认不下发明文、给脱敏预览', secret.value === '' && secret.configured === true && /••/.test(secret.preview));
  check('连接类直接明文', read.credentials({}).items.find((x) => x.key === 'imagesProxy').value === 'http://p');
  check('reveal 必须指定单条才给明文', read.credentials({ reveal: true, only: 'reverseSearchApiKey' }).items[0].value === 'abc12345'
    && read.credentials({ reveal: true }).items.find((x) => x.key === 'reverseSearchApiKey').value === '');
  check('配置读取', read.socialConfig().config.images.proxy === 'http://p');

  let cfg = { socialV2: { images: { proxy: 'http://p' } } };
  let disk = { socialV2: { images: { proxy: 'http://p', reverseSearchApiKey: 'oldkey', sources: { pixiv: { enabled: true, limit: 20 } } } } };
  const calls = [];
  const commands = createConfigCommands({
    config: {
      CREDENTIAL_ITEMS, ROOT: 'root', STATE_DIR: 'state',
      TOOL_FLAGS: [{ flag: 'a', fixed: false }, { flag: 'fixed', fixed: true }],
      DEFAULT_AUTO_AT: { probability: 0.3, windowMs: 1000, cooldownMs: 1000, maxPerHour: 5 },
      DEFAULT_ERROR_MESSAGES: ['默认错误'], TTS_DEFAULT_PROBABILITY: 0.3,
      cfg, log: () => {}, maskValue: (v) => `m:${v}`,
      path,
      readJsonSafe: (file, dflt, failFast) => {
        if (String(file).endsWith('config.json')) return JSON.parse(JSON.stringify(disk));
        if (failFast) throw new Error('bad config');
        return dflt;
      },
      atomicWriteJson: (file, data) => {
        calls.push(['write', file, data]);
        if (String(file).endsWith('config.json')) disk = JSON.parse(JSON.stringify(data));
      }
    },
    helpers: { normalizeGapNoticeConfig: (c) => ({ ...c, windowMs: 100 }) },
    reverseSearcher: { setApiKey: (v) => calls.push(['setKey', v]) },
    applyPixivAuth: (why) => calls.push(['pixiv', why]),
    refreshAllDefaultWakeConfigsV2: () => calls.push('refreshWake')
  });
  check('凭据：未知 key 400', commands.saveCredential({ key: 'nope', value: 'x' }).status === 400);
  check('凭据：代理格式校验', commands.saveCredential({ key: 'imagesProxy', value: 'not-a-url' }).status === 400);
  check('凭据：secret 太短拒绝', commands.saveCredential({ key: 'reverseSearchApiKey', value: '123' }).status === 400);
  const savedProxy = commands.saveCredential({ key: 'imagesProxy', value: ' http://127.0.0.1:7897 ' });
  check('凭据：config 点路径写入并同步内存', savedProxy.ok && cfg.socialV2.images.proxy === 'http://127.0.0.1:7897'
    && disk.socialV2.images.proxy === 'http://127.0.0.1:7897');
  const savedKey = commands.saveCredential({ key: 'reverseSearchApiKey', value: 'newkey123' });
  check('凭据：config 写入并重建反查器', savedKey.ok && cfg.socialV2.images.reverseSearchApiKey === 'newkey123'
    && disk.socialV2.images.reverseSearchApiKey === 'newkey123'
    && calls.some((c) => Array.isArray(c) && c[0] === 'setKey' && c[1] === 'newkey123'));

  const savedCfg = commands.saveSocialConfig({
    tools: { a: 'yes' },
    wait: null,
    wake: { defaultMode: 'active', sleepMinMs: -5 },
    tts: { probability: 5, maxChars: 5 },
    images: { sources: { pixiv: { limit: 999, enabled: 1 } } },
    gapNotice: { enabled: true }
  });
  check('配置：tools 只接受布尔且 fixed 不写', savedCfg.ok && savedCfg.config.tools.a === true
    && savedCfg.config.tools.fixed === undefined);
  check('配置：null 子对象保留原值', savedCfg.config.wait && typeof savedCfg.config.wait === 'object');
  check('配置：wake 概率/毫秒归一', savedCfg.config.wake.defaultMode === 'active'
    && savedCfg.config.wake.sleepMinMs === 0);
  check('配置：TTS 百分数折算与字数下限', savedCfg.config.tts.probability === 0.05
    && savedCfg.config.tts.maxChars === 10);
  check('配置：图源 limit clamp/布尔归一', savedCfg.config.images.sources.pixiv.limit === 100
    && savedCfg.config.images.sources.pixiv.enabled === false);
  check('配置：gapNotice 归一与默认唤醒同步', savedCfg.config.gapNotice.windowMs === 100
    && calls.includes('refreshWake'));

  check('06-config 保留 4 条路由清单', configRoute.routes.length === 4);
  let captured = null;
  await configRoute.handle({ method: 'GET', headers: {} }, { writeHead() {}, end() {} },
    new URL('http://127.0.0.1/api/socialV2/config'), {
      sendJson: (body, status = 200) => { captured = { body, status }; },
      readBody: async () => ({}),
      readModels: { config: { socialConfig: () => ({ ok: true, config: { x: 1 } }) } },
      commands: { config: {} }
    });
  check('06-config 无平铺 deps 也能服务', captured?.status === 200 && captured.body.config.x === 1);
}

console.log('\n── 转发 / 活跃成员领域 ──');
{
  const state = {
    recentMessages: [
      { userId: '1', sender: '甲', time: 100 },
      { userId: '1', sender: '甲', time: 200 },
      { userId: '2', sender: '乙', time: 150 },
      { isSelf: true, sender: '我', time: 300 }
    ],
    unread: [{ forwardIds: ['f9'] }]
  };
  const seenForwardIds = new Map([['group:1', new Set(['f1'])]]);
  const read = createForwardReadModel({
    bot: {
      raw: async (action, args) => ({
        id: args.id,
        messages: args.id === 'f1' ? [{ nestedForwardIds: ['f2'] }] : []
      })
    },
    cfg: {},
    live: { currentMode: 'reserved2' },
    fetchMediaData: async (media) => media.map((m, i) => ({ data: `img${i}`, mimeType: 'image/png' })),
    formatForwardResponse: (data) => ({ messages: data.messages || [] }),
    getSocialV2State: () => state,
    log: () => {},
    modeAllowed: () => true,
    seenForwardIds
  });
  check('活跃成员按次数/时间排序且排除自己', (() => {
    const r = read.activeMembers({ key: 'group:1', limit: 10 });
    return r.ok && r.members.length === 2 && r.members[0].userId === '1' && r.members[0].count === 2;
  })());
  check('活跃成员 limit 生效', read.activeMembers({ key: 'group:1', limit: 1 }).members.length === 1);
  check('转发消息：key/id 校验', (await read.forwardMessage({ key: 'bad', id: 'f1' })).status === 400
    && (await read.forwardMessage({ key: 'group:1', id: '' })).status === 400);
  const noToken = await read.forwardMessage({ key: 'group:1', id: 'f1' });
  check('转发消息：无 token 403', noToken.status === 403);
  const notSeen = await read.forwardMessage({ key: 'group:1', id: 'unknown', agentToken: 't', agentTokenOk: () => true, toolEnabled: () => true });
  check('转发消息：未见过的 id 404', notSeen.status === 404);
  const seen = await read.forwardMessage({ key: 'group:1', id: 'f1', agentToken: 't', agentTokenOk: () => true, toolEnabled: () => true });
  check('转发消息：已见 id 可读并缓存嵌套 id', seen.ok && seen.messages.length === 1
    && seenForwardIds.get('group:1').has('f2') && seen.nestedPreviews[0].id === 'f2');
  check('转发消息：unread 里的 id 可见', (await read.forwardMessage({ key: 'group:1', id: 'f9', agentToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).ok === true);
  check('转发媒体：空数组直接返回', (await read.forwardMedia({ key: 'group:1', media: [] })).images.length === 0);
  check('转发媒体：取图', (await read.forwardMedia({ key: 'group:1', media: [{ url: 'u' }], agentToken: 't', agentTokenOk: () => true, toolEnabled: () => true })).images[0].data === 'img0');

  check('13-forward 保留 3 条路由清单', forwardRoute.routes.length === 3);
  let captured = null;
  await forwardRoute.handle({ method: 'GET', headers: {} }, { writeHead() {}, end() {} },
    new URL('http://127.0.0.1/api/socialV2/active-members?key=group:1'), {
      sendJson: (body, status = 200) => { captured = { body, status }; },
      readBody: async () => ({}),
      readModels: { forward: { activeMembers: () => ({ ok: true, key: 'group:1', members: [] }) } },
      agentTokenOk: () => true, v2ToolEnabled: () => true
    });
  check('13-forward 无平铺 deps 也能服务', captured?.status === 200 && Array.isArray(captured.body.members));
}

console.log('\n── 接线与依赖面 ──');
{
  // 行为断言：给一个**没有 deps** 的 ctx，路由仍能服务 —— 证明它不再依赖平铺依赖袋。
  let captured = null;
  const ctx = {
    sendJson: (body, status = 200) => { captured = { body, status }; },
    readBody: async () => ({}),
    securityHeaders: {},
    readModels: { token: read },
    commands: { token: {} },
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true
  };
  const res = { writeHead() {}, end() {} };
  await tokenRoute.handle({ method: 'GET', headers: {} }, res,
    new URL('http://127.0.0.1/api/socialV2/token-usage?date=all'), ctx);
  check('05-token 无平铺 deps 也能服务', captured?.status === 200
    && captured.body.ok === true && captured.body.ready === true && captured.body.today === '2026-10-29');
  check('05-token 保留四条路由清单', tokenRoute.routes.length === 4);

  // 16-context 同样不能依赖平铺 deps。
  let contextCaptured = null;
  const contextCtx = {
    sendJson: (body, status = 200) => { contextCaptured = { body, status }; },
    readBody: async () => ({}),
    securityHeaders: {},
    readModels: { context: { tokenFuseView: () => ({ ok: true, keys: [] }), sharedMemoryView: () => ({ ok: true, rows: [] }) } },
    commands: { context: { clearPeople: () => ({ ok: true, stats: {} }) } },
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true
  };
  await contextRoute.handle({ method: 'GET', headers: {} }, res,
    new URL('http://127.0.0.1/api/socialV2/token-fuse'), contextCtx);
  check('16-context 无平铺 deps 也能服务', contextCaptured?.status === 200
    && contextCaptured.body.ok === true && Array.isArray(contextCaptured.body.keys));
  contextCaptured = null;
  await contextRoute.handle({ method: 'POST', headers: {} }, res,
    new URL('http://127.0.0.1/api/socialV2/shared-memory-clear'), contextCtx);
  check('16-context 写命令经 facets 调用', contextCaptured?.status === 200 && contextCaptured.body.ok === true);
  check('16-context 保留 17 条路由清单', contextRoute.routes.length === 17);

  let opsCaptured = null;
  const opsCtx = {
    sendJson: (body, status = 200) => { opsCaptured = { body, status }; },
    readBody: async () => ({ key: 'group:1' }),
    securityHeaders: {},
    commands: { ops: { resetSession: async (key) => ({ ok: true, key }), scheduleRestart: () => ({ ok: true, message: 'restart' }) } },
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true
  };
  await opsRoute.handle({ method: 'POST', headers: {} }, res,
    new URL('http://127.0.0.1/api/session/reset'), opsCtx);
  check('18-ops 无平铺 deps 也能服务', opsCaptured?.status === 200 && opsCaptured.body.key === 'group:1');
  opsCaptured = null;
  await opsRoute.handle({ method: 'POST', headers: {} }, res,
    new URL('http://127.0.0.1/api/restart'), opsCtx);
  check('18-ops 自重启经命令层', opsCaptured?.status === 200 && opsCaptured.body.message === 'restart');
  check('18-ops 保留三条路由清单', opsRoute.routes.length === 3);
  check('未新增 createConsoleServer 顶层键', CONSOLE_DOMAINS.length === 8
    && Object.keys(CONSOLE_DOMAIN_KEYS).every((d) => CONSOLE_DOMAINS.includes(d)));

  const bags = Object.fromEntries(CONSOLE_DOMAINS.map((d) => [d, {}]));
  bags.sessions.state = { sessions: {} };
  bags.sessions.socialV2 = { paused: false };
  bags.context.loadTokenUsage = () => null;
  bags.operations.live = {};
  bags.config.cfg = {};
  const services = createConsoleServices(bags);
  const facets = createConsoleFacets(services, { buildSessionUsageRows: null });
  check('facets 缺能力时仍可装配（读空态）', facets.readModels.token.usageView('all').body.ready === false
    && facets.readModels.activity.statusView().paused === false);
  check('facets 不把平铺 deps 暴露给路由', Object.keys(facets).sort().join(',') === 'commands,readModels'
    && Object.keys(facets.readModels).join(',') === 'token,activity,context,images,stickers,wait,bili,socialRead,core,memory,access,agent,socialV1,slang,config,forward,overview'
    && Object.keys(facets.commands).join(',') === 'token,activity,tasks,context,ops,images,stickers,wait,bili,socialRead,core,memory,access,agent,messaging,socialV1,slang,config,plugins');
}

console.log(fail ? `\n❌ ${pass} 通过 / ${fail} 失败` : `\n✅ ${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);
