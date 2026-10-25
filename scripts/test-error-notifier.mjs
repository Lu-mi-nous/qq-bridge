// 回归测试：上游报错拦截与拟人化告知（纯逻辑，不依赖网络与服务）。
import {
  classifyUpstreamError, createErrorNotifier, buildOwnerReport, pickMessage,
  parseKey, DEFAULT_MESSAGES, condenseUpstreamDetail
} from '../src/error-notifier.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

// ── 1. 识别：真实样本必须命中 ──
console.log('── 识别上游错误 ──');
const realSamples = [
  ['网关 503 no_healthy_account',
    '503: {"code":"no_healthy_account","gateway_hint":"no healthy account available in pool; check /status or retry later","message":"all accounts are temporarily unavailable, please retry later","type":"api_error"}'],
  ['上游 429 6004（额度）',
    '429: {"code":"rate_limit_exceeded","gateway_hint":"rate limited by upstream; retry after reset","message":"{\\"code\\":6004,\\"msg\\":\\"usage exceeds frequency limit, but don\'t worry, your usage will reset at 2026-09-25 11:58:36 UTC+8\\"}"}'],
  ['DSH 归一化 RATE_LIMIT',
    '{"kind":"error","failure":{"message":"429: rate limited","code":"RATE_LIMIT"}}'],
  ['纯 429 文本', 'Error: 429 Too Many Requests'],
  ['中文额度不足', '上游返回：额度不足，请充值'],
];
for (const [label, text] of realSamples) {
  const r = classifyUpstreamError(text);
  check(`命中：${label}`, r.matched === true, `code=${r.code}`);
}

console.log('\n── 不该误判 ──');
for (const [label, text] of [
  ['普通超时', 'Error: ETIMEDOUT'],
  ['404', 'HTTP 404 not found'],
  ['空值', ''],
  ['null', null],
  ['普通业务错误', 'agent 处理出错：模型输出为空'],
]) {
  const r = classifyUpstreamError(text);
  check(`不命中：${label}`, r.matched === false);
}

// ── 2. 错误码归类 ──
console.log('\n── 错误码归类 ──');
check('no_healthy_account 归类', classifyUpstreamError(realSamples[0][1]).code === 'no_healthy_account');
check('rate_limit 归类', classifyUpstreamError(realSamples[1][1]).code === 'rate_limit');
check('RATE_LIMIT 归为 rate_limit', classifyUpstreamError(realSamples[2][1]).code === 'rate_limit');

// ── 2b. 上游 WAF 拦截（2026-10-13 群 100002004 首次遇到）──
// 网关出口 IP 被腾讯云 WAF 临时拦，网关把整个 403 HTML 页当 message 回传。
// 性质与限流同类：上游不可用、临时、非桥接可控。必须识别，否则：
//   ① 群里会看到一坨英文 HTML（虽然群内提示默认已关）；
//   ② 管理员私聊被整页 HTML 淹没，真正有用的错误码看不见。
console.log('\n── 上游 WAF 拦截 ──');
const WAF_REAL = '503: {"code":"waf_ip_blocked","gateway_hint":"upstream WAF blocked the gateway; retry after the block window","message":"<!DOCTYPE html><html lang=\\"en\\"><head><meta charset=\\"UTF-8\\" /><title>WAF Block Page</title><link rel=\\"stylesheet\\" href=\\"https://domain-config-1256704386.cos.accelerate.myqcloud.com/block-pages/403/main_en.css\\"></head><body><div class=\\"wrapper\\"><p class=\\"title\\">Your request has been interrupted</p><p class=\\"desc\\">Your request may pose a threat to the website and cannot be accessed.</p></div><script>function submitWafFeedback(){}</script></body></html>"}';
{
  const c = classifyUpstreamError(WAF_REAL);
  check('WAF 拦截被识别', c.matched === true, `code=${c.code}`);
  check('归类为 waf_ip_blocked', c.code === 'waf_ip_blocked', c.code);
  check('不再归成泛化的 quota', c.code !== 'quota');

  // 仅凭 HTML 特征也要能识别（错误码被 DSH 截掉时的兜底）
  check('只有 WAF Block Page 字样也能识别',
    classifyUpstreamError('<html><title>WAF Block Page</title></html>').matched === true);
  check('只有 waf_ip_blocked 也能识别',
    classifyUpstreamError('{"code":"waf_ip_blocked"}').matched === true);

  // 不该把普通 403 误判成 WAF（那可能是权限问题，不是上游故障）
  check('普通 403 forbidden 不误判',
    classifyUpstreamError('HTTP 403 Forbidden: 无权访问该资源').matched === false);
}

console.log('\n── 错误详情压缩（不能把整页 HTML 丢给管理员）──');
{
  const d = condenseUpstreamDetail(WAF_REAL);
  check('压缩后显著变短', d.length < WAF_REAL.length, `${WAF_REAL.length} → ${d.length}`);
  check('保留 HTTP 状态码', /HTTP 503/.test(d), d.slice(0, 60));
  check('保留错误码（排查关键）', /code=waf_ip_blocked/.test(d));
  check('保留网关提示（排查关键）', /retry after the block window/.test(d));
  check('剥掉 HTML 标签', !/<\/?(div|script|html|link|body)/i.test(d));
  check('剥掉内联脚本内容', !/submitWafFeedback/.test(d));
  check('剥掉 CDN 样式链接', !/myqcloud\.com/.test(d));
  check('保留可读的错误描述文本', /request has been interrupted|posed a threat/i.test(d));

  // 有长度上限，防止超长错误刷屏
  const huge = 'x'.repeat(5000);
  check('超长输入被截断', condenseUpstreamDetail(huge).length <= 605);
  check('截断处有省略号', condenseUpstreamDetail(huge).endsWith('…'));

  // 非 HTML 也要处理（抽字段 + 截断）
  const plain = condenseUpstreamDetail('503: {"code":"no_healthy_account","gateway_hint":"no healthy account available in pool"}');
  check('非 HTML 保留 code', /code=no_healthy_account/.test(plain));
  check('非 HTML 保留 hint', /no healthy account/.test(plain));

  // 边界：不该崩
  check('空值不崩', condenseUpstreamDetail('') === '');
  check('null 不崩', condenseUpstreamDetail(null) === '');
  check('普通短文本原样保留', condenseUpstreamDetail('模型输出为空') === '模型输出为空');
}

// ── 3. 节流：同会话 3 分钟只发一次 ──
console.log('\n── 节流（3 分钟/会话）──');
{
  let t = 1_000_000;
  const n = createErrorNotifier({ windowMs: 180000, now: () => t });
  const a = n.shouldNotify('group:111');
  check('首次允许', a.allowed === true);
  t += 1000;
  const b = n.shouldNotify('group:111');
  check('1 秒后同群拒绝', b.allowed === false);
  check('拒绝时给出剩余等待', b.retryAfterMs > 170000, `剩余 ${b.retryAfterMs}ms`);
  t += 60_000;
  check('1 分钟后同群仍拒绝', n.shouldNotify('group:111').allowed === false);
  // 关键：节流按会话而不是全局，别的群不受影响
  check('别的群不受影响（按 key 记）', n.shouldNotify('group:222').allowed === true);
  check('私聊不受影响', n.shouldNotify('private:333').allowed === true);
  t += 120_000; // 距首次 181 秒
  check('181 秒后同群允许', n.shouldNotify('group:111').allowed === true);
  // 边界：恰好 3 分钟
  let t2 = 0;
  const n2 = createErrorNotifier({ windowMs: 180000, now: () => t2 });
  n2.shouldNotify('group:1');
  t2 = 179999;
  check('未满 3 分钟拒绝', n2.shouldNotify('group:1').allowed === false);
  t2 = 180000;
  check('恰好 3 分钟允许', n2.shouldNotify('group:1').allowed === true);
}

// ── 4. 判定即记账（防并发重复发）──
console.log('\n── 判定与记账同步 ──');
{
  const n = createErrorNotifier({ windowMs: 180000, now: () => 0 });
  const r1 = n.shouldNotify('group:9');
  const r2 = n.shouldNotify('group:9'); // 模拟并发第二个回合立刻再问
  check('连续两次只有第一次允许', r1.allowed === true && r2.allowed === false);
  check('peek 不改记账', n.peek('group:9').remainingMs === 180000);
  n.reset('group:9');
  check('reset 后可再发', n.shouldNotify('group:9').allowed === true);
}

// ── 5. 文案 ──
console.log('\n── 文案 ──');
{
  check('默认文案非空', DEFAULT_MESSAGES.length > 0);
  check('默认文案都提到额度/卡住且不含技术词',
    DEFAULT_MESSAGES.every((m) => !/(503|429|JSON|json|error|gateway)/i.test(m)));
  const m0 = pickMessage(DEFAULT_MESSAGES, () => 0);
  const m1 = pickMessage(DEFAULT_MESSAGES, () => 0.999999);
  check('取第一条', m0 === DEFAULT_MESSAGES[0], m0);
  check('取最后一条', m1 === DEFAULT_MESSAGES[DEFAULT_MESSAGES.length - 1], m1);
  check('自定义文案生效', pickMessage(['自定义'], () => 0.5) === '自定义');
  check('空数组回退默认', DEFAULT_MESSAGES.includes(pickMessage([], () => 0)));
}

// ── 6. 管理员私聊详情字段 ──
console.log('\n── 管理员私聊字段 ──');
{
  const rep = buildOwnerReport({
    key: 'group:100002005',
    code: 'no_healthy_account',
    rawError: '503: {"code":"no_healthy_account"}',
    at: new Date('2026-09-25T01:20:00+08:00').getTime(),
    messages: ['诶，我这边好像没额度了……'],
    sessionId: 'session-abc'
  });
  check('含标题', rep.includes('上游报错通知'));
  check('含**群号字段**', /群号：100002005/.test(rep), rep.split('\n')[3]);
  check('含会话 key', rep.includes('group:100002005'));
  check('含错误码', rep.includes('no_healthy_account'));
  check('含原始 JSON', rep.includes('{"code":"no_healthy_account"}'));
  check('含 sessionId', rep.includes('session-abc'));
  check('含群内已回复文案', rep.includes('没额度'));

  // 私聊场景字段应为 QQ 号而非群号
  const rep2 = buildOwnerReport({ key: 'private:100002000', code: 'rate_limit', rawError: 'x' });
  check('私聊用 QQ号 字段', /QQ号：100002000/.test(rep2), rep2.split('\n')[3]);
  check('私聊不出现"群号："', !rep2.includes('群号：'));

  // 超长原始错误要截断，避免私聊被刷屏
  const long = buildOwnerReport({ key: 'group:1', code: 'x', rawError: 'A'.repeat(5000) });
  check('原始错误截断到 1200 字符内', long.length < 1500, `长度 ${long.length}`);
}

// ── 7. parseKey ──
console.log('\n── parseKey ──');
check('群', JSON.stringify(parseKey('group:12345')) === JSON.stringify({ kind: 'group', id: '12345' }));
check('私聊', JSON.stringify(parseKey('private:999')) === JSON.stringify({ kind: 'private', id: '999' }));
check('非法返回空', parseKey('bogus').kind === '');
check('空值不抛', parseKey(null).id === '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
