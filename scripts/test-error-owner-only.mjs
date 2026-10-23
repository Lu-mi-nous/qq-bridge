// 回归测试：**报错一律不进群，全部私聊管理员**（用户 2026-10-08 的要求）。
//
// 背景：桥接原先有十几处 `await sendToQQ(key, '⚠️ …')`，会把报错发到群里。
// 现在统一改走 notifyOwnerOfError()：群里一个字都不发，详情私聊 cfg.ownerQQ。
//
// 做法：不伪造 HTTP，而是把 bridge.js 里那套逻辑按同样顺序复刻一遍（与
// test-error-notice-flow.mjs 同一套路），并把「发消息」换成记录，
// 这样既能验证接线与顺序，又不会打扰真实群。
import {
  classifyUpstreamError, createErrorNotifier, buildOwnerReport, buildOwnerNotice,
  pickMessage, DEFAULT_MESSAGES, parseKey
} from '../src/error-notifier.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// ── 复刻 bridge.js 的 notifyOwnerOfError（见 src/bridge.js 同名函数） ──
function makeBridge({ ownerQQ = '100001000', windowMs = 180000, now = () => Date.now(), notifyOwner = true } = {}) {
  const sent = []; // {key, text}
  const ownerNotices = new Map();
  async function sendToQQ(key, msg) { sent.push({ key, text: msg }); }
  function notifyOwnerOfError(key, title, detail = '', extra = {}) {
    if (!notifyOwner) return;
    if (!ownerQQ) return;
    const bucket = `${key}|${title}`;
    const prev = ownerNotices.get(bucket);
    const t = now();
    if (windowMs > 0 && prev && t - prev.at < windowMs) { prev.suppressed += 1; return; }
    const suppressed = prev ? prev.suppressed : 0;
    ownerNotices.set(bucket, { at: t, suppressed: 0 });
    const report = buildOwnerNotice({ key, title, detail, at: t, extra, suppressed });
    sendToQQ(`private:${ownerQQ}`, report);
  }
  // 复刻 handleUpstreamError（inGroup 默认 false）
  const notifier = createErrorNotifier({ windowMs, now });
  async function handleUpstreamError(key, rawError, extra = {}, inGroup = false) {
    const cls = classifyUpstreamError(rawError);
    if (!cls.matched) return false;
    const gate = notifier.shouldNotify(key);
    let sentText = '';
    if (gate.allowed && inGroup === true) {
      sentText = pickMessage(DEFAULT_MESSAGES, () => 0);
      await sendToQQ(key, sentText);
    }
    if (notifyOwner && ownerQQ) {
      const report = buildOwnerReport({ key, code: cls.code, rawError, messages: sentText ? [sentText] : [], sessionId: extra.sessionId ?? '' });
      await sendToQQ(`private:${ownerQQ}`, report);
    }
    return true;
  }
  return { sent, notifyOwnerOfError, handleUpstreamError };
}

const REAL_503 = '503: {"code":"no_healthy_account","gateway_hint":"no healthy account available in pool","message":"all accounts are temporarily unavailable","type":"api_error"}';

// 群里出现"报错/内部状态"字样的判据：⚠️ ❌ ⏳ 报错 失败 出错 异常 未被接受 重启中
const ERROR_ISH = /[⚠❌⏳]|报错|失败|出错|异常|未被接受|重启中|超时|无法/;

console.log('── ① 上游 503：群里零消息，管理员收到详情 ──');
{
  let t = 1_700_000_000_000;
  const b = makeBridge({ now: () => t });
  const handled = await b.handleUpstreamError('group:100001032', REAL_503, { sessionId: 'session-xyz' });
  check('识别并接管', handled === true);
  const group = b.sent.filter((s) => s.key === 'group:100001032');
  const priv = b.sent.filter((s) => s.key === 'private:100001000');
  check('群里 0 条（关键）', group.length === 0, `${group.length} 条`);
  check('管理员私聊 1 条', priv.length === 1, `${priv.length} 条`);
  check('私聊含群号', /群号：100001032/.test(priv[0]?.text ?? ''));
  check('私聊含错误码', /no_healthy_account/.test(priv[0]?.text ?? ''));
  check('私聊不含空的「群内已回复」', !/群内已回复/.test(priv[0]?.text ?? ''));
}

console.log('\n── ② 各类通用报错：全部只走私聊 ──');
{
  let t = 1_700_000_000_000;
  const b = makeBridge({ now: () => t });
  const cases = [
    ['group:111', '安全策略拦截了一条回复', 'token=abc 出现在正文', { 原因: '含会话令牌' }],
    ['group:222', '消息未被 DSH 接受', 'model-unavailable: no adapter serves provider "vgw"', { sessionId: 's1' }],
    ['group:333', 'DSH 不可用，消息已入队', '队列中已有 3 条待处理', { 说明: '群内未提示' }],
    ['private:444', 'agent 处理出错', '模型输出为空', {}],
    ['group:555', '回答 agent 提问回执失败', 'socket hang up', {}],
    ['group:666', '审批回执提交失败', 'timeout', { 决定: 'allowed-once' }]
  ];
  for (const [key, title, detail, extra] of cases) {
    b.notifyOwnerOfError(key, title, detail, extra);
  }
  const groupMsgs = b.sent.filter((s) => s.key.startsWith('group:'));
  const privMsgs = b.sent.filter((s) => s.key.startsWith('private:'));
  check('群里 0 条（关键）', groupMsgs.length === 0, `${groupMsgs.length} 条`);
  check('管理员私聊 6 条', privMsgs.length === 6, `${privMsgs.length} 条`);
  check('私聊都带【桥接报错】标题', privMsgs.every((m) => m.text.startsWith('【桥接报错】')));
  check('群聊报错带群号字段', /群号：111/.test(privMsgs[0]?.text ?? ''));
  check('私聊报错带 QQ号字段', /QQ号：444/.test(b.sent.find((m) => /agent 处理出错/.test(m.text))?.text ?? ''));
  check('详情原文保留', /no adapter serves provider/.test(b.sent.find((m) => /消息未被 DSH 接受/.test(m.text))?.text ?? ''));
}

console.log('\n── ③ 节流：同类报错不刷屏，但计数不丢 ──');
{
  let t = 1_700_000_000_000;
  const b = makeBridge({ now: () => t, windowMs: 180000 });
  for (let i = 1; i <= 4; i++) {
    b.notifyOwnerOfError('group:111', 'agent 处理出错', `第 ${i} 次爆炸`);
    t += 1000;
  }
  check('窗口内只私聊 1 条', b.sent.length === 1, `${b.sent.length} 条`);
  t += 181000;
  b.notifyOwnerOfError('group:111', 'agent 处理出错', '第 5 次爆炸');
  check('过窗后再私聊 1 条', b.sent.length === 2, `${b.sent.length} 条`);
  check('带出被压掉的次数', /此前 3 次同类报错/.test(b.sent[1]?.text ?? ''), b.sent[1]?.text?.split('\n')[5]);
  check('不同 key 互不影响', (() => {
    b.notifyOwnerOfError('group:999', 'agent 处理出错', '别的群也炸了');
    return b.sent.length === 3;
  })());
  check('不同类型互不影响', (() => {
    b.notifyOwnerOfError('group:111', '消息未被 DSH 接受', '另一种错');
    return b.sent.length === 4;
  })());
  check('全程群里 0 条', b.sent.filter((s) => s.key.startsWith('group:')).length === 0);
}

console.log('\n── ④ 私聊会话本身报错：也不往"群里"发 ──');
{
  const b = makeBridge();
  b.notifyOwnerOfError('private:100001001', 'agent 处理出错', '某私聊用户的回合炸了');
  check('原会话收到 0 条', b.sent.filter((s) => s.key === 'private:100001001').length === 0);
  check('管理员收到 1 条', b.sent.filter((s) => s.key === 'private:100001000').length === 1);
  check('带 QQ号 字段', /QQ号：100001001/.test(b.sent[0]?.text ?? ''));
}

console.log('\n── ⑤ 开关与边界 ──');
{
  const b = makeBridge({ notifyOwner: false });
  b.notifyOwnerOfError('group:111', 'agent 处理出错', 'x');
  check('notifyOwner=false 时静默（不发送）', b.sent.length === 0);

  const b2 = makeBridge({ ownerQQ: '' });
  b2.notifyOwnerOfError('group:111', 'agent 处理出错', 'x');
  check('ownerQQ 为空时不发送也不抛', b2.sent.length === 0);

  // inGroup=true 时回到旧行为（群里发人设句）——保留开关不等于默认开
  const b3 = makeBridge();
  await b3.handleUpstreamError('group:111', REAL_503, {}, true);
  check('inGroup=true 时群里才有 1 条人设句', b3.sent.filter((s) => s.key === 'group:111').length === 1);
  check('且那条不含技术词', !/no_healthy_account|\{/.test(b3.sent.find((s) => s.key === 'group:111')?.text ?? ''));

  // 空 key（如发送线程里的错误）也要能通知
  const b4 = makeBridge();
  b4.notifyOwnerOfError('', '发送失败', 'QQ 发送失败');
  check('空 key 也能通知管理员', b4.sent.length === 1);
  check('空 key 时不出现"会话："空行', !/会话：\s*$/m.test(b4.sent[0]?.text ?? ''));
}

console.log('\n── ⑥ 长详情截断 ──');
{
  const long = 'E'.repeat(5000);
  const txt = buildOwnerNotice({ key: 'group:1', title: '长错误', detail: long });
  check('详情截断到 2000 字符内', txt.length < 2100, `长度 ${txt.length}`);
  const txt2 = buildOwnerNotice({ key: 'group:1', title: 't', extra: { a: '', b: null, c: undefined, d: 'keep' } });
  check('extra 里空值被剔除', !/a：|b：|c：/.test(txt2) && /d：keep/.test(txt2), txt2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
