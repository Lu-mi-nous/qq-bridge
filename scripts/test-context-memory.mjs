import { createEventHarness, sessionEvent, assistantMessage, turnEnd } from './helpers/dsh-event-harness.mjs';
// 回归测试：上下文持久化 Phase 0/1（src/context-memory.js + bridge 接线）。
//
// 锁住：
//   ① episode 触发条件：累计条数 / 空闲 + 最少条数，且不重复总结已总结过的消息
//   ② 摘要 JSON 的校验、长度裁剪、confidence 过滤、脱敏
//   ③ 记忆包：episode 优先、DSH 压缩摘要兜底、预算截断
//   ④ 摘要器：OpenAI 兼容响应、reasoning_content 兜底、HTTP 错误
//   ⑤ 桥接接线：压缩事件、记忆包注入、定时扫描、状态/总结/清空接口
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  safeKey,
  contextDir,
  appendEpisode,
  loadEpisodes,
  appendCompaction,
  loadCompactions,
  appendContextMessage,
  loadContextMessages,
  journalStats,
  journalCoverage,
  appendRecallAudit,
  readRecallAudit,
  recallAuditStats,
  appendBacklogSample,
  readBacklogHistory,
  mergeEpisodeToMemory,
  backfillLongTermMemory,
  loadLongTermMemory,
  longTermStats,
  contextStats,
  shouldMakeEpisode,
  buildEpisodePrompt,
  parseEpisode,
  formatMemoryPack,
  createSummarizer,
  DEFAULT_CONTEXT_MEMORY
} from '../src/context-memory.js';
import { readConsoleSource } from './lib/console-src.mjs';

let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const skipped = (n, why) => { skip++; console.log(`SKIP  ${n}  （${why}）`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxmem-'));
const stateDir = path.join(tmp, 'state');
const KEY = 'group:1000000007';
const T = 1_792_660_000_000;

console.log('── 1. 存储与安全 key ──');
{
  check('key 里的冒号转下划线', safeKey(KEY) === 'group_1000000007', safeKey(KEY));
  check('目录在 state/context 下', contextDir(stateDir, KEY).replace(/\\/g, '/').endsWith('state/context/group_1000000007'));
  for (let i = 1; i <= 5; i++) {
    appendEpisode(stateDir, KEY, { id: i, summary: `第${i}段`, createdAt: T + i }, 3);
  }
  const eps = loadEpisodes(stateDir, KEY, 10);
  check('episode 按 keep 截断', eps.length === 3 && eps.map((e) => e.id).join(',') === '3,4,5', JSON.stringify(eps.map((e) => e.id)));
  for (let i = 1; i <= 4; i++) appendCompaction(stateDir, KEY, { at: T + i, summary: `压缩${i}` }, 2);
  const comps = loadCompactions(stateDir, KEY, 10);
  check('压缩摘要按 keep 截断', comps.length === 2 && comps.map((c) => c.summary).join(',') === '压缩3,压缩4');
  const stats = contextStats(stateDir, KEY);
  check('统计返回最新 episode/压缩', stats.episodes === 3 && stats.compactions === 2 && stats.lastEpisodeAt === T + 5);
}

console.log('\n── 2. 触发条件 ──');
{
  const mk = (n, from = 1) => Array.from({ length: n }, (_, i) => ({
    seq: from + i, time: T + i * 1000, sender: '甲', userId: '111', plain: `消息${from + i}`
  }));
  const cfg = { ...DEFAULT_CONTEXT_MEMORY, episodeEveryMessages: 40, episodeIdleMs: 20 * 60 * 1000, episodeIdleMinMessages: 15 };
  const no = shouldMakeEpisode({ messages: mk(39), lastEpisode: null, cfg, now: T + 39_000 });
  check('39 条且不空闲 → 不总结', no.yes === false && no.reason === 'not-enough', no.reason);
  const yes = shouldMakeEpisode({ messages: mk(40), lastEpisode: null, cfg, now: T + 40_000 });
  check('40 条 → 总结（count）', yes.yes === true && yes.reason === 'count' && yes.messages.length === 40);
  const idle = shouldMakeEpisode({ messages: mk(15), lastEpisode: null, cfg, now: T + 15 * 60 * 1000 + 21 * 60 * 1000 });
  check('15 条且空闲 21 分钟 → 总结（idle）', idle.yes === true && idle.reason === 'idle');
  const last = { toSeq: 20, endAt: T + 20_000 };
  const after = shouldMakeEpisode({ messages: mk(60, 1), lastEpisode: last, cfg, now: T + 60_000 });
  check('只统计上次 episode 之后的消息', after.yes === true && after.messages[0].seq === 21, String(after.messages?.[0]?.seq));
  const dup = shouldMakeEpisode({ messages: mk(10, 1), lastEpisode: { toSeq: 50, endAt: T + 50_000 }, cfg, now: T + 60_000 });
  check('没有新消息时不重复总结', dup.yes === false);
}


console.log('\n── 2b. Phase 2：journal 全量消息 ──');
{
  const JKEY = 'group:journal-test';
  appendContextMessage(stateDir, JKEY, { seq: 1, sender: '甲', userId: '111', text: '第一条', time: T + 1000 });
  appendContextMessage(stateDir, JKEY, { isSelf: true, sender: '我', text: '机器人回复', time: T + 1500 });
  appendContextMessage(stateDir, JKEY, { seq: 2, sender: '乙', userId: '222', text: '第二条', time: T + 2000 });
  const all = loadContextMessages(stateDir, JKEY, { limit: 0 });
  check('journal 按顺序保留入站+self', all.length === 3 && all[0].seq === 1 && all[1].isSelf && all[2].seq === 2);
  check('journalStats 能读到文件', journalStats(stateDir, JKEY).exists === true);
  const after = loadContextMessages(stateDir, JKEY, { afterSeq: 1, afterTime: T + 1400, limit: 0 });
  check('按 lastEpisode seq/time 只取新消息', after.length === 2 && after[0].isSelf && after[1].seq === 2, JSON.stringify(after.map(x=>x.seq)));
}

console.log('\n── 2c. Phase 2：长期记忆合并 ──');
{
  const MKEY = 'group:memory-test';
  mergeEpisodeToMemory(stateDir, MKEY, {
    people: [{ id: '111', name: '甲', note: '喜欢原神' }],
    facts: [{ subject: '甲', predicate: '喜欢', object: '原神', confidence: 0.9 }],
    threads: [{ title: '周末联机', status: 'open', nextAction: '等甲定时间' }]
  }, { now: T });
  mergeEpisodeToMemory(stateDir, MKEY, {
    people: [{ id: '111', name: '甲', note: '喜欢原神和星铁' }],
    facts: [{ subject: '甲', predicate: '喜欢', object: '原神', confidence: 0.8 }],
    threads: [{ title: '周末联机', status: 'closed', nextAction: '' }]
  }, { now: T + 1000 });
  const mem = loadLongTermMemory(stateDir, MKEY);
  const st = longTermStats(stateDir, MKEY);
  check('人物按 id 去重', st.people === 1 && mem.people['111'].mentions === 2);
  check('人物备注更新为最新', mem.people['111'].note.includes('星铁'));
  check('事实按 subject|predicate|object 去重', st.facts === 1 && mem.facts[Object.keys(mem.facts)[0]].hits === 2);
  check('线索状态更新为 closed', Object.values(mem.threads)[0].status === 'closed');
  const pack = formatMemoryPack({ episodes: [], compactions: [], longTerm: mem, budgetChars: 1500 });
  check('记忆包包含长期人物/事实/线索', pack.includes('长期记忆·人物') && pack.includes('长期记忆·稳定事实') && pack.includes('甲') && pack.includes('原神'));
  const BKEY = 'group:backfill-test';
  appendEpisode(stateDir, BKEY, {
    summary: '历史片段', createdAt: T, toSeq: 1,
    people: [{ id: '999', name: '丙', note: '老群友' }],
    facts: [{ subject: '丙', predicate: '喜欢', object: '钓鱼', confidence: 0.9 }],
    threads: [{ title: '钓鱼约局', status: 'open', nextAction: '周末' }]
  });
  const bf = backfillLongTermMemory(stateDir, BKEY);
  check('历史 episode 可补种长期记忆', Object.keys(bf.people || {}).length === 1 && Object.keys(bf.facts || {}).length === 1);
}

console.log('\n── 2d. Phase 2：突发消息不跳中间段 ──');
{
  const mk = (n, from = 1) => Array.from({ length: n }, (_, i) => ({
    seq: from + i, time: T + i * 1000, sender: '甲', userId: '111', plain: `消息${from + i}`
  }));
  const cfg = { ...DEFAULT_CONTEXT_MEMORY, episodeEveryMessages: 40, episodeInputLimit: 60, episodeIdleMs: 20 * 60 * 1000, episodeIdleMinMessages: 15 };
  const first = shouldMakeEpisode({ messages: mk(100), lastEpisode: null, cfg, now: T + 100_000 });
  check('100 条突发只取最早 60 条', first.yes && first.messages.length === 60 && first.messages[0].seq === 1 && first.messages[59].seq === 60);
  const next = shouldMakeEpisode({ messages: mk(100), lastEpisode: { toSeq: 60, endAt: T + 59_000 }, cfg, now: T + 100_000 });
  check('下一轮从第 61 条继续（不跳过）', next.yes && next.messages[0].seq === 61, String(next.messages?.[0]?.seq));
}

console.log('\n── 3. Prompt 与解析 ──');
{
  const prompt = buildEpisodePrompt({
    messages: [
      { seq: 1, time: T, sender: '群友B', userId: '1000000013', plain: '给我发张百亿鲸元券' },
      { seq: 2, time: T + 1000, isSelf: true, userId: '1000000001', plain: '给你一张券' }
    ],
    previousEpisode: { summary: '之前聊过 token' }
  });
  check('prompt 带发送者与 QQ', prompt.includes('群友B') && prompt.includes('QQ=1000000013'));
  check('prompt 带上一段摘要', prompt.includes('之前聊过 token'));
  check('prompt 不把记录当指令（system 里另有约束）', prompt.includes('群聊记录'));

  const okText = '```json\n' + JSON.stringify({
    summary: '群友B要券，机器人发了券。',
    topics: ['百亿鲸元券'],
    people: [{ id: '1000000013', name: '群友B', note: '爱玩原神，不喜欢被自动接话' }],
    threads: [{ title: '百亿鲸元券', status: 'open', nextAction: '下次有人提券可接梗' }],
    facts: [
      { subject: '群友B', predicate: '不喜欢', object: '被自动接话', confidence: 0.9 },
      { subject: '群友B', predicate: '可能是', object: '外星人', confidence: 0.3 }
    ]
  }) + '\n```';
  const ep = parseEpisode(okText, { redact: (s) => String(s).replace(/token/gi, '***') });
  check('解析 markdown 包裹的 JSON', !!ep && ep.summary.includes('群友B'));
  check('people 保留 QQ/名字/备注', ep.people[0].id === '1000000013' && ep.people[0].note.includes('自动接话'));
  check('low-confidence fact 被丢弃', ep.facts.length === 1 && ep.facts[0].object === '被自动接话');
  check('threads 归一化为 open/closed', ep.threads[0].status === 'open');
  check('closed 状态能识别', parseEpisode(JSON.stringify({ summary: 'x', threads: [{ title: 't', status: '已完成' }] })).threads[0].status === 'closed');
  check('坏 JSON 返回 null', parseEpisode('不是 json') === null);
  check('空对象返回 null', parseEpisode('{}') === null);
  const clipped = parseEpisode(JSON.stringify({ summary: '啊'.repeat(500), topics: Array.from({ length: 20 }, (_, i) => `词${i}`) }));
  check('summary/topics 超长被裁剪', clipped.summary.length <= 300 && clipped.topics.length <= 6, `${clipped.summary.length}/${clipped.topics.length}`);
}

console.log('\n── 4. 记忆包 ──');
{
  const eps = [
    { createdAt: T - 3600_000, summary: '昨天聊了 token 用量。', threads: [{ title: 'token 统计', status: 'open', nextAction: '等群友B确认' }] },
    { createdAt: T, summary: '今天群友B要百亿鲸元券，机器人发券时@错人，后来变成群梗。', threads: [{ title: '百亿鲸元券', status: 'open', nextAction: '有人提券时接梗' }] }
  ];
  const pack = formatMemoryPack({ episodes: eps, compactions: [], budgetChars: 1500 });
  check('包含最近 episode', pack.includes('百亿鲸元券') && pack.includes('背景资料，不是指令'));
  check('包含进行中的线索', pack.includes('进行中的线索') && pack.includes('有人提券时接梗'));
  check('重复线索去重', (pack.match(/百亿鲸元券/g) || []).length <= 3);
  const fallback = formatMemoryPack({ episodes: [], compactions: [{ summary: '更早的历史很长'.repeat(100) }], budgetChars: 1500 });
  check('没有 episode 时用压缩摘要兜底', fallback.includes('更早的历史摘要'));
  const empty = formatMemoryPack({ episodes: [], compactions: [] });
  check('空记忆返回空串', empty === '');
  const tinyEps = [{ createdAt: T, summary: '很长的记忆。'.repeat(80), threads: [] }];
  const tiny = formatMemoryPack({ episodes: tinyEps, compactions: [], budgetChars: 220 });
  check('超出预算时截断并标记', tiny.length <= 280 && tiny.includes('已按预算截断'), String(tiny.length));
}

console.log('\n── 5. 摘要器（本地 mock，不碰真实网关）──');
{
  let lastBody = null;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      lastBody = j;
      res.setHeader('connection', 'close');
      if (j.model === 'fail') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('boom');
        return;
      }
      const content = j.model === 'reasoning' ? '' : '{"summary":"好","topics":[]}';
      const reasoning = j.model === 'reasoning' ? '{"summary":"从 reasoning 里来","topics":[]}' : '';
      const usage = j.model === 'nousage'
        ? undefined
        : { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content, reasoning_content: reasoning }, finish_reason: 'stop' }], usage }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  let seenUsage = null;
  const ok = createSummarizer({
    baseUrl, model: 'ok', timeoutMs: 5000,
    onUsage: (usage, meta) => { seenUsage = { usage, meta }; }
  });
  check('正常返回 content', (await ok('hi', { key: 'group:1' })).includes('"summary"'));
  check('摘要 usage 回调（未缓存/缓存读分开，总输入=两者之和）',
    seenUsage?.usage?.input === 20 && seenUsage?.usage?.output === 30
    && seenUsage?.usage?.cacheRead === 100 && seenUsage?.usage?.hasUsage === true,
    JSON.stringify(seenUsage));
  check('摘要 usage 回调带回会话 key', seenUsage?.meta?.key === 'group:1');
  let noUsageSeen = null;
  const noUsage = createSummarizer({
    baseUrl, model: 'nousage', timeoutMs: 5000,
    onUsage: (usage) => { noUsageSeen = usage; }
  });
  await noUsage('hi');
  check('网关不返回 usage 时也回调（只记调用次数）', noUsageSeen?.hasUsage === false);
  check('摘要指令并入 user（网关会忽略 system）',
    !!lastBody && lastBody.messages?.[0]?.role === 'user'
    && lastBody.messages[0].content.includes('QQ 群聊记忆整理器')
    && lastBody.messages[0].content.includes('只输出严格 JSON')
    && !lastBody.messages?.some((m) => m.role === 'system'));
  const reasoning = createSummarizer({ baseUrl, model: 'reasoning', timeoutMs: 5000 });
  check('content 为空时兜底 reasoning_content', (await reasoning('hi')).includes('从 reasoning 里来'));
  const bad = createSummarizer({ baseUrl, model: 'fail', timeoutMs: 5000 });
  let err = '';
  try { await bad('hi'); } catch (e) { err = String(e?.message || e); }
  check('HTTP 错误会抛出', err.includes('HTTP 500'), err);
  srv.closeAllConnections?.();
  await new Promise((r) => srv.close(r));
  await new Promise((r) => setTimeout(r, 100));
}

console.log('\n── 6. 桥接接线 ──');
{
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const socialSrc = fs.readFileSync(new URL('../src/social-engine.js', import.meta.url), 'utf8');
  const consoleServer = readConsoleSource();
  check('引入 context-memory', /from '\.\/context-memory\.js'/.test(bridge));
  check('有独立 context 目录', /const CONTEXT_DIR = path\.join\(STATE_DIR, 'context'\)/.test(bridge));
  const events = createEventHarness();
  const frame = sessionEvent('compaction/summary', undefined, { summary: [{ type: 'text', text: '压缩记忆 fixture-secret' }] });
  delete frame.payload.event.data.turn;
  await events.handle(frame);
  check('捕获 compaction/summary 并脱敏保存', events.get('compaction')[0]?.[3].summary === '压缩记忆 ***'
    && events.deps.contextMetrics.has('group:1'));
  const wakeSrc = fs.readFileSync(new URL('../src/pipeline/wake.js', import.meta.url), 'utf8');
  check('唤醒注入记忆包', /formatMemoryPack\(\{/.test(wakeSrc) && /lastMemoryChars = memoryPack\.length/.test(wakeSrc));
  check('唤醒注入长期记忆', /deps\.loadLongTermMemory\(deps\.stateDir, key\)/.test(wakeSrc) && /longTerm,/.test(consoleServer));
  check('唤醒注入跨会话人物资料', /formatSharedMemoryForWake/.test(wakeSrc)
    && /sharedText/.test(wakeSrc) && /lastSharedChars/.test(wakeSrc));
  check('episode 后更新跨会话人物资料', /mergeEpisodeToSharedMemory\(STATE_DIR/.test(bridge)
    && /共享记忆\] .*更新失败（不影响情节记忆）/.test(bridge));
  check('记录唤醒提示长度', /m\.lastPromptChars = promptText\.length/.test(bridge));
  check('定时扫描 episode', /function contextSweep\(\)/.test(bridge)
    && /taskService\.define\('contextSweep'[\s\S]{0,300}run: \(\) => contextSweep\(\)/.test(bridge));
  check('扫描候选过滤掉不够条数的会话', /if \(pending < every && !idleReady\) continue;/.test(bridge));
  check('扫描失败有日志兜底', /\[上下文\] 扫描失败/.test(bridge));
  check('扫描支持每会话多段追赶', /sweepChunksPerKey/.test(bridge) && /chunksPerKey/.test(bridge));
  check('扫描有单轮总段数上限', /sweepMaxEpisodesPerRun/.test(bridge) && /maxEpisodes/.test(bridge));
  check('状态接口', /'\/api\/socialV2\/context-status'/.test(consoleServer));
  check('立即总结接口', /'\/api\/socialV2\/context-summarize'/.test(consoleServer));
  check('长期记忆详情接口', /'\/api\/socialV2\/context-memory'/.test(consoleServer));
  check('长期记忆重建接口', /'\/api\/socialV2\/context-rebuild-memory'/.test(consoleServer));
  check('活动日志状态接口', /'\/api\/socialV2\/activity-feed'/.test(consoleServer));
  check('清空接口', /'\/api\/socialV2\/context-clear'/.test(consoleServer));
  check('默认配置含 contextMemory', /contextMemory: \{ \.\.\.DEFAULT_CONTEXT_MEMORY \}/.test(bridge));
  check('入站消息写入 journal', /appendContextMessage\(STATE_DIR, key, msg\)/.test(socialSrc));
  check('self 消息也写入 journal', /appendContextMessage\(STATE_DIR, key, entry\)/.test(socialSrc));
  check('episode 优先从 journal 取数', /loadContextMessages\(STATE_DIR, key, \{/.test(bridge));
  check('记忆检索接口存在', /'\/api\/socialV2\/recall'/.test(consoleServer) && /searchMemory\(/.test(consoleServer));
  check('唤醒提示注入检索结果', /buildRecallLineV2\(key, st\)/.test(bridge) && /formatRecallResults\(/.test(bridge));
  check('桥接记录召回延迟/命中率', /m\.lastRecallMs = elapsed/.test(bridge) && /m\.recallHitCalls/.test(bridge) && /m\.recallMsTotal/.test(bridge));
  check('桥接写检索审计', /appendRecallAudit\(STATE_DIR/.test(bridge));
  check('扫描写积压快照', /appendBacklogSample\(STATE_DIR/.test(bridge));
  check('状态接口返回覆盖率/积压/召回', /journalCoverage\(STATE_DIR/.test(consoleServer) && /backlogHistory: readBacklogHistory/.test(consoleServer) && /recallHitRate/.test(consoleServer));
  check('追赶/重建索引接口存在', /context-catchup/.test(consoleServer) && /context-rebuild-index/.test(consoleServer));
  check('检索索引来自 journal + episode', /buildMemoryIndex\(\{ messages, episodes \}\)/.test(bridge));
  check('episode 合并长期记忆', /mergeEpisodeToMemory\(STATE_DIR, key, ep/.test(bridge));
  check('状态接口返回长期记忆/日志体积', /longTermStats\(STATE_DIR, key\)/.test(consoleServer) && /journalBytes/.test(consoleServer));
  check('状态接口返回群名/QQ昵称', /displayName: contextDisplayName\(key\)/.test(consoleServer));
  check('名称缓存定期刷新', /refreshContextNames\(true\)/.test(bridge) && /getGroupList\(\{ noCache: true \}\)/.test(bridge) && /getFriendList\(\)/.test(bridge));
  check('状态接口补种历史长期记忆', /backfillLongTermMemory\(STATE_DIR, key\)/.test(consoleServer));
  check('扫描按最久未总结优先', /a\.lastEpisodeAt - b\.lastEpisodeAt/.test(bridge) && /countContextPendingV2/.test(bridge));
  {
    const cs = consoleServer.indexOf("url.pathname === '/api/socialV2/context-clear'");
    const block = consoleServer.slice(cs, cs + 1600);
    check('清空只删派生记忆、保留 messages.jsonl',
      block.includes("['episodes.jsonl', 'compactions.jsonl', 'memory.json']")
      && !block.includes("rmSync(path.join(dir, 'messages.jsonl'))"));
  }
  // 2026-10-22 实测踩到：CONTEXT_DIR 已经包含 /context，再传给 context-memory
  // 会变成 state/context/context/<key>；写入/读取都能"自洽"，但真实目录错了。
  check('context-memory 调用传 STATE_DIR（不能再套一层 context）',
    !/(loadEpisodes|appendEpisode|loadCompactions|appendCompaction|contextStats)\(CONTEXT_DIR/.test(bridge));
}

console.log('\n── 6b. P1 指标、召回审计与积压历史 ──');
{
  const key = 'group:555000111';
  const now = Date.now();
  for (let i = 1; i <= 5; i += 1) {
    appendContextMessage(tmp, key, {
      seq: i,
      messageId: `p1-${i}`,
      sender: '甲',
      text: `P1 消息 ${i}`,
      time: now - (5 - i) * 1000
    });
  }
  const cov = journalCoverage(tmp, key, { hours: 24, now, indexLimit: 3 });
  check('24h 覆盖率按索引窗口计算', cov.messages24h === 5 && cov.indexed24h === 3 && cov.coveragePct === 60, JSON.stringify(cov));
  const covAll = journalCoverage(tmp, key, { hours: 24, now, indexLimit: 100 });
  check('索引足够时覆盖率 100%', covAll.coveragePct === 100);
  const covEmpty = journalCoverage(tmp, 'group:999999999', { hours: 24, now });
  check('无日志时覆盖率按 100% 处理', covEmpty.messages24h === 0 && covEmpty.coveragePct === 100);

  appendRecallAudit(tmp, key, { at: now, query: '测试查询', ms: 12, hits: 2, chars: 80, results: [{ kind: 'message', seq: 1, text: '命中 A' }] }, 3);
  appendRecallAudit(tmp, key, { at: now + 1, query: '测试查询 2', ms: 8, hits: 0, chars: 0, results: [] }, 3);
  const audit = readRecallAudit(tmp, key, 10);
  check('检索审计可读', audit.length === 2 && audit[0].query === '测试查询' && audit[1].hits === 0);
  const stats = recallAuditStats(tmp, key, 10);
  check('召回统计可汇总', stats.calls === 2 && stats.hits === 1 && stats.hitRate === 50 && stats.avgMs === 10, JSON.stringify(stats));

  appendBacklogSample(tmp, { at: now, pending: 10, episodes: 2, conversations: 1 }, 5);
  appendBacklogSample(tmp, { at: now + 1, pending: 20, episodes: 2, conversations: 1 }, 5);
  const hist = readBacklogHistory(tmp, 10);
  check('积压历史可读', hist.length === 2 && hist[1].pending === 20);
}

console.log('\n── 7. 真实目录（存在才测）──');
{
  const realState = new URL('../state', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  const real = path.join(realState, 'context');
  if (!fs.existsSync(real)) {
    skipped('真实 episode', '还没有生成过');
  } else {
    const files = [];
    for (const k of fs.readdirSync(real)) {
      const f = path.join(real, k, 'episodes.jsonl');
      if (fs.existsSync(f)) files.push(f);
    }
    check('真实 context 目录存在', fs.statSync(real).isDirectory());
    if (!files.length) {
      skipped('真实 episode', '目录里还没有 episodes.jsonl');
    } else {
      const eps = loadEpisodes(realState, 'group:1000000007', 3);
      check('真实 episode 可读', eps.length > 0 ? !!eps[0].summary : true, `files=${files.length}`);
    }
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}`);
process.exitCode = fail === 0 ? 0 : 1;
