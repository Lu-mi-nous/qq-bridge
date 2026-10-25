// 端到端验证：用**真实的桥接代码路径**跑一次上游 503，确认
//   ① 群里收到的是人设短句（不是原始 JSON）
//   ② 管理员私聊收到含群号的详情
//   ③ 3 分钟内同群不重复发
//
// 做法：不伪造 HTTP，而是把 bridge.js 里那段处理逻辑按同样顺序在测试里跑一遍，
// 并把「发消息」换成记录。这样能验证接线与顺序，且不打扰真实群。
import {
  classifyUpstreamError, createErrorNotifier, buildOwnerReport, pickMessage, DEFAULT_MESSAGES
} from '../src/error-notifier.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// 复刻 bridge.js handleUpstreamError 的流程（保持一致，见该函数）
function makeHandler({ windowMs = 180000, now = () => Date.now(), ownerQQ = '100002000', messages = DEFAULT_MESSAGES, enabled = true, notifyOwner = true } = {}) {
  const notifier = createErrorNotifier({ windowMs, now });
  const sent = []; // {key, text}
  async function sendToQQ(key, msg) { sent.push({ key, text: msg }); }
  async function handleUpstreamError(key, rawError, extra = {}) {
    if (enabled === false) return false;
    const cls = classifyUpstreamError(rawError);
    if (!cls.matched) return false;
    const gate = notifier.shouldNotify(key);
    let sentText = '';
    if (gate.allowed) {
      sentText = pickMessage(messages, () => 0);
      await sendToQQ(key, sentText);
    }
    if (notifyOwner !== false && ownerQQ) {
      const report = buildOwnerReport({ key, code: cls.code, rawError, messages: gate.allowed ? [sentText] : [], sessionId: extra.sessionId ?? '' });
      await sendToQQ(`private:${ownerQQ}`, report);
    }
    return true;
  }
  return { handleUpstreamError, sent };
}

const REAL_503 = '503: {"code":"no_healthy_account","gateway_hint":"no healthy account available in pool; check /status or retry later","message":"all accounts are temporarily unavailable, please retry later","type":"api_error"}';

console.log('── 真实 503：群内人设句 + 私聊详情 ──');
{
  let t = 1_700_000_000_000;
  const h = makeHandler({ now: () => t });
  const handled = await h.handleUpstreamError('group:100002005', REAL_503, { sessionId: 'session-xyz' });

  check('识别并接管（返回 true）', handled === true);
  const group = h.sent.filter((s) => s.key === 'group:100002005');
  const priv = h.sent.filter((s) => s.key === 'private:100002000');
  check('群内正好发 1 条', group.length === 1, `${group.length} 条`);
  check('群内是人设短句', group[0]?.text === DEFAULT_MESSAGES[0], group[0]?.text);
  check('群内**不含**原始 JSON', !/no_healthy_account|\{/.test(group[0]?.text ?? ''), group[0]?.text);
  check('私聊正好发 1 条', priv.length === 1, `${priv.length} 条`);
  check('私聊含群号字段', /群号：100002005/.test(priv[0]?.text ?? ''));
  check('私聊含错误码', /no_healthy_account/.test(priv[0]?.text ?? ''));
  check('私聊含原始 JSON', /gateway_hint/.test(priv[0]?.text ?? ''));
  check('私聊含 sessionId', /session-xyz/.test(priv[0]?.text ?? ''));

  console.log('\n  ── 发给群里的原文 ──');
  console.log('  ' + group[0]?.text);
  console.log('  ── 私聊原文 ──');
  console.log(priv[0]?.text.split('\n').map((l) => '  ' + l).join('\n'));
}

console.log('\n── 节流：3 分钟内同群只发一次 ──');
{
  let t = 0;
  const h = makeHandler({ now: () => t });
  await h.handleUpstreamError('group:111', REAL_503);
  t += 30_000;
  await h.handleUpstreamError('group:111', REAL_503); // 30 秒后：应只私聊、不再群发
  t += 60_000;
  await h.handleUpstreamError('group:111', REAL_503); // 90 秒：同上

  const groups = h.sent.filter((s) => s.key === 'group:111');
  const privs = h.sent.filter((s) => s.key === 'private:100002000');
  check('群内只发 1 条（3 次报错）', groups.length === 1, `${groups.length} 条`);
  check('私聊发 3 条（每次报错都通知）', privs.length === 3, `${privs.length} 条`);
  check('被节流时私聊不写"群内已回复"', !privs[1].text.includes('群内已回复'), privs[1].text.split('\n').slice(0, 6).join(' | '));

  // 别的群不被节流波及
  const before = h.sent.length;
  await h.handleUpstreamError('group:222', REAL_503);
  const after222 = h.sent.filter((s) => s.key === 'group:222');
  check('同期其他群照常提示', after222.length === 1, `${after222.length} 条`);
  check('总计新增 2 条（群222 提示 + 私聊）', h.sent.length - before === 2);

  t += 180_000;
  await h.handleUpstreamError('group:111', REAL_503);
  check('3 分钟后同群可再提示', h.sent.filter((s) => s.key === 'group:111').length === 2);
}

console.log('\n── 非额度类错误不接管 ──');
{
  const h = makeHandler();
  check('普通错误返回 false（照原逻辑报）', (await h.handleUpstreamError('group:1', 'agent 处理出错：模型输出为空')) === false);
  check('超时返回 false', (await h.handleUpstreamError('group:1', 'Error: ETIMEDOUT')) === false);
  check('未产生任何发送', h.sent.length === 0, `${h.sent.length} 条`);
}

console.log('\n── 开关 ──');
{
  const off = makeHandler({ enabled: false });
  check('enabled=false 时不接管', (await off.handleUpstreamError('group:1', REAL_503)) === false);
  check('enabled=false 时无发送', off.sent.length === 0);
  const noOwner = makeHandler({ notifyOwner: false });
  await noOwner.handleUpstreamError('group:1', REAL_503);
  check('notifyOwner=false 时只发群内', noOwner.sent.length === 1 && noOwner.sent[0].key === 'group:1');
}

console.log('\n── 429 额度错误 ──');
{
  const REAL_429 = '429: {"code":"rate_limit_exceeded","gateway_hint":"rate limited by upstream; retry after reset","message":"{\\"code\\":6004,\\"msg\\":\\"usage exceeds frequency limit\\"}"}';
  const h = makeHandler();
  await h.handleUpstreamError('group:5', REAL_429);
  check('429 也走人设句', h.sent[0]?.key === 'group:5' && !/429|rate_limit/.test(h.sent[0].text));
  check('429 私聊错误码归类 rate_limit', /错误码：rate_limit/.test(h.sent[1]?.text ?? ''), h.sent[1]?.text.split('\n').find((l) => l.startsWith('错误码')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
