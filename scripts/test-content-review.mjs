// 回归测试：内容审查插件（R4.5-10）。
//
// 锁住：本地规则/危险域名、warn vs block、模型审核注入、fail-closed、审计不含原文。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  reviewText, localRuleScan, normalizeReviewConfig, hashText, appendAudit, auditStats, DEFAULT_REVIEW
} from '../plugins/content-review/lib/review.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
const cfgBase = { auditFile: 'audit.jsonl', maxChars: 200 };

// ① 配置归一化
{
  check('默认关闭', DEFAULT_REVIEW.enabled === false);
  const c = normalizeReviewConfig({ mode: 'block', keywordsByCategory: { porn: ['x'], empty: [] }, blockedDomains: ['Bad.COM '] });
  check('保留 mode/过滤空分类', c.mode === 'block' && Object.keys(c.keywordsByCategory).length === 1);
  check('域名小写化', c.blockedDomains[0] === 'bad.com');
}

// ② 本地规则
{
  const cfg = { ...cfgBase, keywordsByCategory: { politics: ['敏感词A'], scam: ['刷单'] } };
  const hit = localRuleScan('这里有敏感词A和刷单信息', cfg);
  check('关键词命中分类', hit.hit && hit.categories.includes('politics') && hit.categories.includes('scam'));
  const clean = localRuleScan('今天天气不错', cfg);
  check('干净文本不命中', clean.hit === false && clean.categories.length === 0);
  const domain = localRuleScan('看这里 https://sub.bad.com/x', { ...cfgBase, blockedDomains: ['bad.com'] });
  check('危险域名命中 scam', domain.hit && domain.categories.includes('scam'));
  const beyond = localRuleScan('x'.repeat(300) + '敏感词A', { ...cfgBase, maxChars: 100, keywordsByCategory: { politics: ['敏感词A'] } });
  check('超出 maxChars 不扫描', beyond.hit === false);
}

// ③ 审核入口
{
  const cfg = { ...cfgBase, enabled: true, mode: 'warn', keywordsByCategory: { politics: ['敏感词A'] } };
  const clean = await reviewText('普通帖子', { cfg });
  check('干净 → allow/allow', clean.decision === 'allow' && clean.action === 'allow');
  const hit = await reviewText('含敏感词A', { cfg });
  check('warn 模式 → decision=block/action=warn', hit.decision === 'block' && hit.action === 'warn');
  const hitBlock = await reviewText('含敏感词A', { cfg: { ...cfg, mode: 'block' } });
  check('block 模式 → action=block', hitBlock.action === 'block');

  const disabled = await reviewText('含敏感词A', { cfg: { ...cfg, enabled: false } });
  check('关闭时直接 allow', disabled.decision === 'allow' && disabled.reason === 'review-disabled');
}

// ④ 模型审核
{
  const cfg = { ...cfgBase, enabled: true, mode: 'block', failClosed: true };
  const allow = await reviewText('普通帖子', { cfg, modelReview: async () => ({ decision: 'allow', categories: [], reason: 'ok' }) });
  check('模型放行 → allow', allow.decision === 'allow');
  const block = await reviewText('普通帖子', { cfg, modelReview: async () => ({ decision: 'block', categories: ['porn'], reason: 'x' }) });
  check('模型拦截 → block', block.decision === 'block' && block.categories.includes('porn'));
  const bad = await reviewText('普通帖子', { cfg, modelReview: async () => ({ decision: 'maybe' }) });
  check('模型输出非法 + failClosed + block → block', bad.decision === 'block' && /bad-model-output/.test(bad.reason));
  const timeout = await reviewText('普通帖子', { cfg: { ...cfg, timeoutMs: 1000 }, modelReview: () => new Promise(() => {}) });
  check('模型超时 → block', timeout.decision === 'block' && /review-timeout/.test(timeout.reason));
  const warnCfg = { ...cfg, mode: 'warn' };
  const warnTimeout = await reviewText('普通帖子', { cfg: warnCfg, modelReview: () => new Promise(() => {}) });
  check('warn 模式模型超时 → allow/warn 不拦', warnTimeout.decision === 'allow' && warnTimeout.action === 'allow');

  const noFailClosed = await reviewText('普通帖子', { cfg: { ...cfg, failClosed: false }, modelReview: async () => { throw new Error('boom'); } });
  check('failClosed=false 时模型异常放行', noFailClosed.decision === 'allow');
}

// ⑤ 审计
{
  const cfg = { ...cfgBase, enabled: true, mode: 'block', keywordsByCategory: { politics: ['敏感词A'] } };
  const hit = await reviewText('含敏感词A的原文', { cfg });
  check('审计写入成功', appendAudit(tmp, hit, cfg) === true);
  const raw = fs.readFileSync(path.join(tmp, 'audit.jsonl'), 'utf8');
  check('审计不含原文', !raw.includes('敏感词A') && !raw.includes('原文'));
  check('审计含 hash/分类/动作', raw.includes(hit.hash.slice(0, 8)) && raw.includes('"action":"block"') && raw.includes('politics'));
  const st = auditStats(tmp, cfg, { limit: 10 });
  check('统计读取正常', st.total === 1 && st.blocked === 1 && st.byCategory.politics === 1);
  check('hash 稳定且区分内容', hashText('a') === hashText('a') && hashText('a') !== hashText('b'));
}

// ⑥ 插件与网关
{
  const { default: fs2 } = await import('node:fs');
  const manifest = JSON.parse(fs2.readFileSync(new URL('../plugins/content-review/manifest.json', import.meta.url), 'utf8'));
  const { CONFIG_DEFAULTS } = await import('../src/config-defaults.js');
  check('审核业务默认关闭且 configPath 正确', CONFIG_DEFAULTS.xMonitor.review.enabled === false && manifest.configPath === 'xMonitor.review');
  const { createPluginRuntime } = await import('../src/plugin-runtime.js');
  const { fileURLToPath } = await import('node:url');
  let disabled = [];
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"version":"0.6.0"}');
  const runtime = createPluginRuntime({ root: tmp,
    dirs: [fileURLToPath(new URL('../plugins/', import.meta.url))], only: ['content-review'],
    getConfig: () => ({ plugins: { disabled } }) });
  // 真实插件从项目目录发现，根目录与状态使用临时夹具。
  const hostRuntime = createPluginRuntime({ root: tmp,
    dirs: [fileURLToPath(new URL('../plugins/', import.meta.url))], only: ['content-review'],
    getConfig: () => ({ plugins: { disabled } }) });
  const gw = hostRuntime.contentReview;
  check('启动前网关不可用', (await gw.reviewText('x')).decision === 'unavailable');
  await hostRuntime.start();
  check('宿主启动后网关可用', gw.available());
  const out = await gw.reviewText('含敏感词A', { cfg: { enabled: true, mode: 'warn', keywordsByCategory: { politics: ['敏感词A'] } } });
  check('网关可调用审核', out.decision === 'block' && out.action === 'warn');
  disabled = ['content-review'];
  check('禁用后同一网关立即不可用', !gw.available() && (await gw.reviewText('x')).action === 'unavailable');
  let rejected = false;
  try { gw.localRuleScan('x'); } catch { rejected = true; }
  check('不可用扫描不伪装为干净结果', rejected);
  disabled = [];
  await hostRuntime.stop();
  check('停止后拒绝审核', (await gw.reviewText('x')).decision === 'unavailable');
  await hostRuntime.start();
  check('重启后同一网关恢复', gw.available());
  check('另一宿主不共享能力', !runtime.contentReview.available());
  await hostRuntime.stop();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
