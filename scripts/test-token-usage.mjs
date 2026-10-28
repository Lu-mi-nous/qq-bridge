// 回归测试：Token 用量统计（src/token-usage.js + 桥接接线）。
//
// 需求（2026-10-21 用户）：「把 token 记录做成日志，每日更新并且放进控制台」。
//
// 复用 scripts/token-usage.mjs 已验证的解析思路，并修掉它两个问题：
//   ① **模型归属**：usage 事件里没有 model 字段，旧脚本按 `data.model` 取，
//      结果「按模型」只统计到 67 次（总数 40006）。模型其实在 `request/header`
//      的 `data.header.config.model`，且该事件**没有 turn 字段**——
//      只能按时间顺序继承（header 出现在其后 usage 之前）。
//   ② **扫描范围**：`~/.dsh/sessions` 下有别的项目和一堆测试工作区
//      （state-probe-* / state-tmp-* 等），全扫会让"今日用量"虚高。
//      只认 `*-state-agents--` 且名字带本项目的目录。
//
// 另外锁住两个原脚本已踩平的坑：
//   ③ 会话文件是 **zstd 多帧拼接**，必须按魔数切帧逐个解（一次性解只得第一帧）。
//   ④ 同一份 usage 在 `assistant/chunk` 与 `assistant/message` 各出现一次，
//      必须去重（否则用量翻倍）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  readSessionText, pickUsage, dayKey, parseSessionFile,
  aggregateTokenUsage, humanTokens
} from '../src/token-usage.js';
import { readConsoleSource } from './lib/console-src.mjs';
import { readConsoleUiSource } from './lib/console-ui-src.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokusage-'));
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 造一个多帧 zstd 的会话文件（模拟 DSH 的真实格式）。 */
function writeSession(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const frames = lines.map((l) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(l) + '\n', 'utf8')));
  fs.writeFileSync(file, Buffer.concat(frames));
}

console.log('── 1. usage 归一化 ──');
{
  const u = pickUsage({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 });
  check('驼峰字段', u.input === 10 && u.output === 20 && u.cacheRead === 30, JSON.stringify(u));
  const u2 = pickUsage({ prompt_tokens: 5, completion_tokens: 6, cache_read_input_tokens: 7 });
  check('兼容 openai 命名', u2.input === 5 && u2.output === 6 && u2.cacheRead === 7);
  check('全 0 返回 null', pickUsage({}) === null && pickUsage(null) === null);
  check('推理 token 单独统计', pickUsage({ inputTokens: 1, reasoningTokens: 9 }).reasoning === 9);
}

console.log('\n── 2. 多帧 zstd 解压（坑③）──');
{
  const f = path.join(tmp, 'multi', 'session.jsonl.zstd');
  writeSession(f, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  const text = readSessionText(f);
  check('三帧都能解出来（只解第一帧会漏）',
    text.includes('"a":1') && text.includes('"b":2') && text.includes('"c":3'), text.slice(0, 60));
  // 魔数切帧的正确性
  const buf = fs.readFileSync(f);
  let count = 0, pos = 0;
  while (true) { const i = buf.indexOf(MAGIC, pos); if (i < 0) break; count++; pos = i + 1; }
  check('文件里有 3 个 zstd 帧', count === 3, String(count));
}

console.log('\n── 3. 解析 + 去重（坑④）+ 模型归属（问题①）──');
{
  const f = path.join(tmp, 'one', 'session.jsonl.zstd');
  const t0 = Date.parse('2026-10-20T10:00:00Z'); // 上海 18:00
  writeSession(f, [
    { type: 'request/header', time: t0, data: { header: { config: { model: 'model-A' } }, reason: 'initial' } },
    // chunk 与 message 带**同一份** usage → 只能算一次
    { type: 'assistant/chunk', time: t0 + 1000, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000 } } } },
    { type: 'assistant/message', time: t0 + 1000, data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000 } } },
    { type: 'turn/end', time: t0 + 2000, data: { turn: 1 } },
    // 换模型后继续
    { type: 'request/header', time: t0 + 3000, data: { header: { config: { model: 'model-B' } } } },
    { type: 'assistant/message', time: t0 + 4000, data: { turn: 2, step: 1, message: {}, usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 500 } } },
    { type: 'turn/end', time: t0 + 5000, data: { turn: 2 } }
  ]);
  const p = parseSessionFile(f);
  check('解析成功', !!p, 'null');
  check('去重后只有 2 次调用（chunk+message 不翻倍）', p.calls === 2, String(p.calls));
  check('合计输入 150（不是 250）', p.days['2026-10-20']?.input === 150, String(p.days['2026-10-20']?.input));
  check('turn 数统计', p.turns === 2, String(p.turns));
  check('模型 A 归到第一次调用',
    p.models['model-A']?.input === 100, JSON.stringify(p.models['model-A']));
  check('模型 B 归到第二次调用（顺序继承生效）',
    p.models['model-B']?.input === 50, JSON.stringify(p.models['model-B']));
  check('没有"未知模型"（说明 request/header 被正确消费）',
    !p.models['(未知模型)'], JSON.stringify(Object.keys(p.models)));
  check('记录首末 usage 时间（会话级报表用）',
    p.firstAt === t0 + 1000 && p.lastAt === t0 + 4000, `${p.firstAt}/${p.lastAt}`);
}

console.log('\n── 4. 按天归档用上海时区 ──');
{
  check('UTC 16:00 = 上海次日 00:00',
    dayKey(Date.parse('2026-10-20T16:30:00Z')) === '2026-10-21',
    dayKey(Date.parse('2026-10-20T16:30:00Z')));
  check('UTC 08:00 = 上海同一天',
    dayKey(Date.parse('2026-10-20T08:00:00Z')) === '2026-10-20');
}

console.log('\n── 5. 聚合：扫描范围与增量缓存（问题②）──');
{
  const base = path.join(tmp, 'sessions');
  const mk = (dir, model, input) => {
    const f = path.join(base, dir, 'session-x', 'session.jsonl.zstd');
    writeSession(f, [
      { type: 'request/header', time: Date.parse('2026-10-20T02:00:00Z'), data: { header: { config: { model } } } },
      { type: 'assistant/message', time: Date.parse('2026-10-20T02:00:00Z'), data: { turn: 1, step: 1, message: {}, usage: { inputTokens: input, outputTokens: 1, cacheReadTokens: 0 } } }
    ]);
    return f;
  };
  mk('--E-Downloads-qq-bridge-main-state-agents--', 'keep-A', 100);
  mk('--E-Downloads-qq-bridge-main-state-probe-bili--', 'skip-probe', 999);
  mk('--C-Users-someone-other-project--', 'skip-other', 999);

  const r = aggregateTokenUsage([base]);
  check('扫到全部 3 个文件（聚合层不做过滤，过滤在调用方）', r.files === 3, String(r.files));
  check('合计输入包含全部三个', r.days['2026-10-20']?.input === 100 + 999 + 999,
    String(r.days['2026-10-20']?.input));

  // 增量：文件没变就复用
  const r2 = aggregateTokenUsage([base], { cache: r.cache });
  check('未变的文件被复用（不重解）', r2.reused === 3 && r2.scanned === 0, `reused=${r2.reused} scanned=${r2.scanned}`);
  check('复用后结果一致', r2.days['2026-10-20']?.input === r.days['2026-10-20']?.input);

  // 改一个文件 → 只重解那一个
  const f1 = path.join(base, '--E-Downloads-qq-bridge-main-state-agents--', 'session-x', 'session.jsonl.zstd');
  const st = fs.statSync(f1);
  mk('--E-Downloads-qq-bridge-main-state-agents--', 'keep-A', 100);
  fs.utimesSync(f1, new Date(st.atimeMs + 5000), new Date(st.mtimeMs + 5000));
  const r3 = aggregateTokenUsage([base], { cache: r2.cache });
  check('只有变化的文件被重解', r3.scanned === 1 && r3.reused === 2, `scanned=${r3.scanned} reused=${r3.reused}`);
}

console.log('\n── 5b. 会话级分桶（2026-10-25 新增）──');
{
  const base = path.join(tmp, 'sessions2');
  const mkS = (sid, file, time, input) => {
    const f = path.join(base, 'ws', sid, file);
    writeSession(f, [
      { type: 'assistant/message', time, data: { turn: 1, step: 1, message: {}, usage: { inputTokens: input, outputTokens: 2, cacheReadTokens: input * 10 } } }
    ]);
    return f;
  };
  mkS('session-a', 'session.jsonl.zstd', Date.parse('2026-10-20T02:00:00Z'), 100);
  // 同一 DSH 会话目录下的第二份转录文件必须合并到同一个桶
  mkS('session-a', 'session.v4.jsonl.zstd', Date.parse('2026-10-21T02:00:00Z'), 50);
  mkS('session-b', 'session.jsonl.zstd', Date.parse('2026-10-20T03:00:00Z'), 10);

  const r = aggregateTokenUsage([base], {
    sessionKeys: { 'session-a': 'group:1' },
    currentSessions: { 'group:1': 'session-a' }
  });
  check('同一 sessionId 的两个转录文件合并', r.sessions['session-a']?.input === 150,
    JSON.stringify(r.sessions['session-a']));
  check('会话桶按天保留', r.sessions['session-a']?.days?.['2026-10-20']?.input === 100
    && r.sessions['session-a']?.days?.['2026-10-21']?.input === 50);
  check('会话桶计算总输入（未缓存+缓存读）',
    r.sessions['session-a']?.totalInput === 150 + 1500, String(r.sessions['session-a']?.totalInput));
  check('映射历史给 sessionId 打上 QQ key', r.sessions['session-a']?.key === 'group:1');
  check('无主 sessionId 保留且 key=null', r.sessions['session-b']?.key === null
    && r.sessions['session-b']?.input === 10, JSON.stringify(r.sessions['session-b']));
  check('当前映射优先于历史映射',
    aggregateTokenUsage([base], {
      sessionKeys: { 'session-a': 'group:old' },
      currentSessions: { 'group:new': 'session-a' }
    }).sessions['session-a']?.key === 'group:new');

  const r2 = aggregateTokenUsage([base], {
    cache: r.cache, sessionKeys: { 'session-a': 'group:1' }, currentSessions: { 'group:1': 'session-a' }
  });
  check('会话分桶不破坏增量缓存', r2.reused === 3 && r2.scanned === 0, `reused=${r2.reused}`);
  check('复用后会话桶一致', r2.sessions['session-a']?.totalInput === r.sessions['session-a']?.totalInput);
}

console.log('\n── 6. 健壮性 ──');
{
  check('空文件返回 null', parseSessionFile(path.join(tmp, 'nope', 'x.zstd')) === null);
  const bad = path.join(tmp, 'bad', 'session.jsonl.zstd');
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, Buffer.from('not zstd at all'));
  check('非 zstd 文件不崩', parseSessionFile(bad) === null);
  const empty = path.join(tmp, 'empty', 'session.jsonl.zstd');
  fs.mkdirSync(path.dirname(empty), { recursive: true });
  fs.writeFileSync(empty, zlib.zstdCompressSync(Buffer.from('{"type":"turn/end","data":{"turn":1}}\n')));
  const e = parseSessionFile(empty);
  check('无 usage 的会话 calls=0 但不崩', e && e.calls === 0, JSON.stringify(e));

  check('humanTokens 格式', humanTokens(999) === '999' && humanTokens(1500) === '1.5K'
    && humanTokens(2_500_000) === '2.50M' && humanTokens(3_000_000_000) === '3.00B');
}

console.log('\n── 7. 桥接接线 ──');
{

  const consoleServer = readConsoleSource();
  const cardDir = path.join(root, 'public', 'console', 'cards');
  const cardHtml = fs.readdirSync(cardDir).filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(cardDir, f), 'utf8').replace(/\\"/g, '"')).join('\n');
  const html = readConsoleUiSource() + '\n' + cardHtml;

  check('有统计端点', /\/api\/socialV2\/token-usage/.test(consoleServer));
  check('有手动重算端点', /token-usage-refresh/.test(consoleServer));
  check('GET 只读缓存不现算（否则请求卡 15 秒）',
    /const data = deps\.live\.tokenUsage \|\| loadTokenUsage\(\)/.test(consoleServer));
  
  
  
  
  

  const tokenServiceSrc = fs.readFileSync(path.join(root, 'src', 'token-service.js'), 'utf8');
  check('落盘按 sessionId 的 sessions 桶', /sessions: agg\.sessions/.test(tokenServiceSrc));
  check('token-usage.json 保留摘要器桶', /summarizer: latest\?\.summarizer \|\| prev\?\.summarizer/.test(tokenServiceSrc));
  check('控制台有卡片', /id="tokenSessions"/.test(html));
  check('16 卡有按会话表格容器', /id="tokenSessions"/.test(html));
  check('16 卡显示当前/累计两个口径', /当前会话总输入/.test(html) && /累计总输入/.test(html));
  check('16 卡有 Token 熔断面板', /id="tokenFusePanel"/.test(html) && /function loadTokenFusePanel\(/.test(html));
  check('熔断面板可解除', /token-fuse-reset/.test(html) && /data-token-fuse-reset/.test(html));
  check('熔断面板显示会话名并支持每会话阈值',
    /displayName: contextDisplayName\(key\)/.test(consoleServer)
    && /data-fuse-\$\{kind\}/.test(html) && /data-token-fuse-save=/.test(html)
    && /token-fuse-override/.test(html));
  check('每会话阈值有 K/M/B 单位下拉框',
    /data-fuse-\$\{kind\}-unit/.test(html) && /\[\['1e3', 'K'\], \['1e6', 'M'\], \['1e9', 'B'\]\]/.test(html)
    && /tokenUnitOptions/.test(html));
  check('有全局默认阈值（不覆盖自定义）',
    /id="tokenFuseWarn"/.test(html) && /id="tokenFuseWarnUnit"/.test(html)
    && /保存全局/.test(html) && /data-token-fuse-clear/.test(html));
  check('24 卡有今日 Token 列', /今日 Token/.test(html));
  check('API 返回派生总输入字段', /totalInput/.test(consoleServer) && /cacheHitRate/.test(consoleServer));
  check('显示今日总输入/未缓存/输出/调用', /总输入（含缓存）/.test(html) && /其中未缓存/.test(html) && /输出 tokens/.test(html) && /缓存读/.test(html));
  check('显示按日趋势', /按日（最近/.test(html));
  check('显示按模型', /按模型/.test(html));
  check('有手动重算按钮', /id="tokenRefresh"/.test(html));
  const initAt = html.indexOf('export async function mount');
  const initialRefreshAt = html.indexOf('await refreshTokenUsage();', initAt);
  check('首屏加载一次', initAt >= 0 && initialRefreshAt > initAt,
    `${initAt} -> ${initialRefreshAt}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
