// 对账：桥接的 DSH token 统计 vs 本地模型网关的请求日志。
//
// 用法：
//   node scripts/token-reconcile.mjs [gatewayRequestLogDir]
// 默认目录：~/.zcode/workspace/default/workbuddy2api-panel/data/request-logs
//
// 口径：
//   DSH inputTokens      = gateway cache_miss_tokens
//   DSH cacheReadTokens  = gateway cache_hit_tokens
//   DSH 总输入           = input + cacheRead = gateway prompt_tokens
//   DSH outputTokens     = gateway completion_tokens
// 只统计 user_agent 含 deepseek-harness 且 status=200 的请求（即桥接的 DSH）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const usageFile = path.join(root, 'state', 'token-usage.json');
const gatewayDir = process.argv[2] || path.join(
  os.homedir(), '.zcode', 'workspace', 'default', 'workbuddy2api-panel', 'data', 'request-logs'
);

const usage = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
const days = Object.keys(usage.days || {}).sort();

function pct(delta, base) {
  if (!base) return '';
  return `${delta >= 0 ? '+' : ''}${((delta / base) * 100).toFixed(1)}%`;
}
function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

console.log('日期        桥接调用  网关请求 | 桥接总输入      网关 prompt     差    | 桥接输出     网关输出      差    | 网关日志覆盖');
for (const day of days) {
  const b = usage.days[day] || {};
  const file = path.join(gatewayDir, `requests-${day}.jsonl`);
  if (!fs.existsSync(file)) {
    console.log(`${day}  ${String(b.calls || 0).padStart(7)}  ${'—'.padStart(8)} | （无网关日志）`);
    continue;
  }
  let n = 0, miss = 0, hit = 0, comp = 0, prompt = 0, first = '', last = '';
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!String(j.user_agent || '').includes('deepseek-harness')) continue;
    if (Number(j.status) !== 200) continue;
    n += 1;
    miss += Number(j.cache_miss_tokens) || 0;
    hit += Number(j.cache_hit_tokens) || 0;
    prompt += Number(j.prompt_tokens) || 0;
    comp += Number(j.completion_tokens) || 0;
    if (!first) first = String(j.time || '').slice(11, 16);
    last = String(j.time || '').slice(11, 16);
  }
  const bIn = (Number(b.input) || 0) + (Number(b.cacheRead) || 0);
  const bOut = Number(b.output) || 0;
  console.log(
    `${day}  ${String(b.calls || 0).padStart(7)}  ${String(n).padStart(8)} | `
    + `${fmt(bIn).padStart(8)}  ${fmt(prompt).padStart(12)}  ${(pct(bIn - prompt, prompt)).padStart(6)} | `
    + `${fmt(bOut).padStart(8)}  ${fmt(comp).padStart(9)}  ${(pct(bOut - comp, comp)).padStart(6)} | `
    + `${first || '—'}~${last || '—'}`
  );
}
console.log('\n注：网关日志从某天中途才开始时，该日不可直接对账；桥接只统计本项目 DSH 会话，网关同 UA 可能混入其它 DSH 客户端。');
