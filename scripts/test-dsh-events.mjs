// 4C：直接运行事件泵，不抽源码、不复制业务逻辑、不连接 QQ/DSH。
// 事件字段来自 test-fixtures/dsh-session-events.json 中已脱敏的本机 DSH 转录。
import { muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema';
import { createEventHarness, fixture, sessionEvent, assistantMessage, turnEnd, toolCall, toolResult } from './helpers/dsh-event-harness.mjs';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
const sid = 'session-fixture', key = 'group:1';

console.log('── 正常事件、迟到事件与回合隔离 ──');
{
  const h = createEventHarness();
  check('创建模块不连接服务、不触发发送', h.effects.length === 0);
  for (const event of Object.values(fixture.events)) {
    check(`真实 ${event.type} 夹具通过 DSH 协议校验`, muxFrameSchema.safeParse({ type: 'session/event', sessionId: sid, event }).success);
  }
  await h.handle(sessionEvent('turn/start', 1));
  check('开始登记明确回合与时间', h.deps.currentTurnBySession.get(sid)?.turnId === `${sid}#1`
    && h.deps.currentTurnBySession.get(sid)?.startedAt === h.deps.v2TurnStartAt.get(sid));
  await h.handle(sessionEvent('assistant/chunk', 1, { chunk: { content: [{ type: 'text', text: '重复片段' }] } }));
  await h.handle(assistantMessage(1, '正常回复'));
  await h.handle(sessionEvent('turn/start', 1));
  await h.handle(turnEnd(1));
  check('完整消息只转发一次，重复 start 不丢文本', h.get('send').length === 1 && h.get('send')[0][2] === '正常回复');
  check('结束释放回合、collector 和计时', !h.deps.currentTurnBySession.has(sid) && !h.deps.collectors.has(sid) && !h.deps.v2TurnStartAt.has(sid));
  await h.handle(turnEnd(1));
  await h.handle(assistantMessage(1, '迟到文本'));
  await h.handle(sessionEvent('session/title', 1, { title: '迟到标题' }));
  check('迟到帧不生成永久繁忙或重复回复', h.get('send').length === 1 && !h.deps.collectors.has(sid));
  await h.handle(sessionEvent('turn/start', 2));
  await h.handle(sessionEvent('turn/start', 3));
  await h.handle(assistantMessage(2, '旧文本'));
  await h.handle(turnEnd(2));
  await h.handle(sessionEvent('turn/start', 2));
  check('旧回合的开始/结束不覆盖新回合', h.deps.currentTurnBySession.get(sid)?.turn === 3 && h.deps.collectors.has(sid));
  await h.handle(assistantMessage(3, '新文本'));
  await h.handle(turnEnd(3));
  check('新回合只发送自己的文本', h.get('send').at(-1)[2] === '新文本');
  await h.turn(4, '甲');
  await h.turn(4, '乙', undefined, 'session-other');
  check('相同 turn 编号在不同会话中相互独立', h.get('send').at(-2)[1] === key && h.get('send').at(-1)[1] === 'group:2');
  const before = h.effects.length;
  await h.turn(1, '不可外发', undefined, 'unknown-session');
  await h.handle({ payload: { type: 'question/requested', sessionId: 'unknown-session', questions: [{ id: 'q', question: '未知提问' }] } });
  await h.handle({ payload: { type: 'session/subscribed', sessionId: sid, lastSeq: 1 } });
  check('未知会话和无关帧不产生副作用', h.effects.length === before);
}

console.log('\n── 发送工具结果与模式实时读取 ──');
for (const isError of [false, true]) {
  const h = createEventHarness();
  await h.handle(sessionEvent('turn/start', 1));
  await h.handle(toolCall(1));
  await h.handle(toolResult(1, 'call-1', isError));
  await h.handle(assistantMessage(1, '工具后文本'));
  await h.handle(turnEnd(1));
  check(isError ? '工具失败仍允许普通文本回复' : '工具成功抑制重复转发', h.get('send').length === (isError ? 1 : 0));
  check('结果审计关联原工具名', h.get('toolLog').at(-1)[1].tool === 'mcp__snowluma__qq_send_message');
  check('结束删除工具调用追踪', !h.deps.pendingSendToolCalls.has(sid) && !h.deps.toolCallNames.has(sid) && !h.deps.sendToolSucceededSessions.has(sid));
}
{
  const h = createEventHarness();
  await h.handle(sessionEvent('turn/start', 1));
  await h.handle(toolCall(1));
  await h.handle(sessionEvent('turn/start', 2));
  await h.handle(toolCall(2));
  await h.handle(toolResult(1));
  check('旧工具结果不能把新回合标为已发送', !h.deps.sendToolSucceededSessions.has(sid) && h.deps.pendingSendToolCalls.get(sid)?.has('call-1'));
  const withoutTurn = toolResult(2); delete withoutTurn.payload.event.data.turn;
  await h.handle(withoutTurn);
  check('缺少回合编号的工具结果不猜当前归属', !h.deps.sendToolSucceededSessions.has(sid));
  await h.handle(assistantMessage(2, '仍要转发'));
  await h.handle(turnEnd(2));
  check('旧工具结果不吞新回复', h.get('send').at(-1)?.[2] === '仍要转发');
  await h.handle(sessionEvent('turn/start', 3));
  h.setMode('reserved2');
  await h.handle(assistantMessage(3, '内部文本'));
  await h.handle(turnEnd(3));
  check('模式切换立即生效，reserved2 不自动外发', h.get('send').length === 1);
  check('无行动计数正常递增', h.states.get(key).wakeConfig.noActionCount === 1);
  await h.turn(4, ''); await h.turn(5, '');
  check('连续无行动达阈值恢复默认唤醒', h.states.get(key).bootstrapSent === true && h.states.get(key).wakeConfig.noActionCount === 0);
  h.states.get(key).wakeConfig.noActionCount = 2;
  await h.handle(sessionEvent('turn/start', 6)); await h.handle(toolCall(6)); await h.handle(toolResult(6)); await h.handle(turnEnd(6));
  check('成功工具行动清零无行动计数', h.states.get(key).wakeConfig.noActionCount === 0);
}


console.log('\n── reserved2 文本-only 兜底（直接点名才转发）──');
{
  const h = createEventHarness({ mode: 'reserved2' });
  h.deps.getSocialV2State(key).lastWakeReason = 'atMention';
  await h.turn(1, '在呢，叫我干嘛');
  check('@ 唤醒只写文本时兜底转发', h.get('send').length === 1 && h.get('send')[0][2] === '在呢，叫我干嘛');
  check('兜底转发写入活动日志', h.get('activity').some((x) => String(x[1]).includes('兜底转发')));
}
{
  const h = createEventHarness({ mode: 'reserved2' });
  h.deps.getSocialV2State(key).lastWakeReason = 'atMention';
  await h.turn(1, '（先潜水，看看再说）');
  await h.turn(2, '这一轮先收尾，我歇一会儿');
  await h.turn(3, '这轮群里只剩发图了，我先不说话了。');
  await h.turn(4, '群里还在发图，我先不接话了。');
  check('内心独白不被兜底转发', h.get('send').length === 0);
}
{
  const h = createEventHarness({ mode: 'reserved2' });
  h.deps.getSocialV2State(key).lastWakeReason = 'anyMessage';
  await h.turn(1, '这条只是自己想想');
  check('非直接唤醒不兜底转发', h.get('send').length === 0);
}
{
  const h = createEventHarness({ mode: 'reserved2' });
  h.deps.getSocialV2State(key).lastWakeReason = 'atMention';
  await h.handle(sessionEvent('turn/start', 1));
  await h.handle(toolCall(1));
  await h.handle(toolResult(1));
  await h.handle(assistantMessage(1, '已经用工具发过了'));
  await h.handle(turnEnd(1));
  check('发送工具成功时不重复兜底', h.get('send').length === 0);
}
{
  const h = createEventHarness({ mode: 'reserved2' });
  h.deps.reverse.set('session-private', 'private:1000000000');
  h.deps.getSocialV2State('private:1000000000').lastWakeReason = 'anyMessage';
  await h.turn(1, '在的', undefined, 'session-private');
  check('私聊任意消息都兜底转发', h.get('send').length === 1 && h.get('send')[0][1] === 'private:1000000000');
}
{
  const h = createEventHarness({ mode: 'reserved2' });
  h.deps.pendingWakeKeys.add(key);
  h.deps.wakeConfigMissCount.set(key, 1);
  h.deps.getSocialV2State(key).lastWakeReason = 'atMention';
  await h.turn(1, '兜底也算发言');
  check('兜底转发按 T1 已发言收尾，不再投提醒', h.get('autoWrap').length === 1
    && h.get('deliver').length === 0 && !h.deps.pendingWakeKeys.has(key));
}
{
  const h = createEventHarness({ mode: 'reserved2' });
  h.deps.getSocialV2State(key).lastWakeReason = 'atMention';
  await h.turn(1, '文字那条已经回到群里了，表情这张没发出去（接口不认令牌），就不补了。');
  check('内部发送状态不兜底转发', h.get('send').length === 0);
}
{
  const h = createEventHarness({ mode: 'reserved2' });
  h.deps.getSocialV2State(key).lastWakeReason = 'atMention';
  await h.handle(sessionEvent('turn/start', 1));
  await h.handle(toolCall(1, 'call-1', 'mcp__snowluma__qq_send_sticker'));
  await h.handle(toolResult(1, 'call-1', true));
  await h.handle(assistantMessage(1, '文字那条已经回到群里了'));
  await h.handle(turnEnd(1));
  check('发送工具失败后不再拿文本兜底', h.get('send').length === 0);
}
{
  const h = createEventHarness({ mode: 'reserved2' });
  h.deps.getSocialV2State(key).lastWakeReason = 'atMention';
  await h.handle(sessionEvent('turn/start', 1));
  await h.handle(toolCall(1, 'call-1', 'mcp__snowluma__qq_send_sticker'));
  await h.handle(toolResult(1, 'call-1', false));
  await h.handle(assistantMessage(1, '表情发你了'));
  await h.handle(turnEnd(1));
  check('表情发送成功按已发言处理，不重复补文本', h.get('send').length === 0);
}

console.log('\n── 静默、安全和错误路径 ──');
{
  const h = createEventHarness();
  h.deps.social.silentTurns.set(sid, [{ ts: h.deps.now() }]);
  await h.turn(1, '摘要内部输出');
  check('摘要回合静默并消费静默名额', h.get('send').length === 0 && !h.deps.social.silentTurns.has(sid));
  h.deps.social.silentTurns.set(sid, [{ ts: h.deps.now() - 60001 }]);
  await h.turn(2, '正常消息');
  check('过期静默名额不吞正常消息', h.get('send').at(-1)?.[2] === '正常消息');
  await h.turn(3, '泄露 fixture-secret');
  check('已知会话令牌被拦截且仅通知管理员', h.get('send').length === 1 && h.get('ownerError').length === 1);
  await h.turn(4, '');
  await h.turn(5, '[SILENT]');
  await h.turn(6, '** **');
  check('空文本/静默标记/纯格式不发送', h.get('send').length === 1);
  await h.turn(7, '', { kind: 'error', error: { message: 'network timeout' } });
  check('普通模型错误仅通知管理员', h.get('send').length === 1 && h.get('ownerError').length === 2);
  await h.turn(8, '', { kind: 'error', error: { message: 'prompt_too_long' } });
  check('上下文超限交恢复器并带当前模式', h.get('recover')[0][1].mode === 'chat' && h.get('recover')[0][1].silent === false);
  h.deps.social.silentTurns.set(sid, [{ ts: h.deps.now() }]);
  await h.turn(9, '', { kind: 'error', error: { message: 'prompt_too_long' } });
  check('静默超限仍恢复但不重试摘要', h.get('recover')[1][1].silent === true && h.get('send').length === 1);
}
for (const [label, text, reason, overrides] of [
  ['普通退场', '再见', undefined, {}], ['静默标记退场', '[SILENT]', undefined, {}],
  ['空退场', '', undefined, {}], ['格式退场', '** **', undefined, {}],
  ['敏感退场', 'fixture-secret', undefined, {}],
  ['错误退场', '', { kind: 'error', error: { message: 'network' } }, {}],
  ['停止退场', '', { kind: 'aborted' }, {}],
  ['全局静默退场', '再见', undefined, { shouldBlockSilentReply: () => true }]
]) {
  const h = createEventHarness({ mode: 'reserved', deps: overrides });
  h.deps.social.exitingSessions.add(sid);
  const st = h.deps.socialState(key); st.phase = 'exiting';
  await h.turn(1, text, reason);
  check(`${label}回到观望且释放退场标记`, st.phase === 'idle' && !h.deps.social.exitingSessions.has(sid));
}

console.log('\n── 唤醒收尾、提醒失败与补投 ──');
for (const marker of ['wakeConfigUpdatedKeys', 'markReadCalledKeys']) {
  const h = createEventHarness({ mode: 'reserved2' });
  h.deps.pendingWakeKeys.add(key); h.deps[marker].add(key); h.deps.wakeConfigMissCount.set(key, 1);
  await h.turn(1);
  check(`${marker} 成功收尾不再提醒`, !h.deps.pendingWakeKeys.has(key) && !h.deps[marker].has(key)
    && !h.deps.wakeConfigMissCount.has(key) && h.get('deliver').length === 0 && h.get('ensureWakeable').length === 1);
}
// T1：本回合成功发过言 = 正常收尾。桥接自动标已读 + 保证唤醒，不再投递提醒（省一次模型调用）。
{
  const h = createEventHarness({ mode: 'reserved2' });
  h.deps.pendingWakeKeys.add(key); h.deps.wakeConfigMissCount.set(key, 1);
  await h.handle(sessionEvent('turn/start', 1));
  await h.handle(toolCall(1));
  await h.handle(toolResult(1));
  await h.handle(turnEnd(1));
  check('T1 发言回合自动收尾且不提醒', h.get('autoWrap').length === 1 && h.get('autoWrap')[0][1] === key
    && h.get('deliver').length === 0
    && !h.deps.pendingWakeKeys.has(key) && !h.deps.wakeConfigMissCount.has(key));
}
// 没发言的回合仍然要提醒（防止模型什么都没做就结束）。
{
  const h = createEventHarness({ mode: 'reserved2' });
  h.deps.pendingWakeKeys.add(key);
  await h.turn(1);
  check('T1 未发言回合仍走提醒', h.get('autoWrap').length === 0
    && h.get('deliver').length === 1 && h.get('deliver')[0][1] === key);
}
// 自动收尾抛错时回退到「保证可唤醒」，不阻断回合、也不额外提醒。
{
  const h = createEventHarness({ mode: 'reserved2', deps: { autoWrapAfterReply: () => { throw new Error('wrap failed'); } } });
  h.deps.pendingWakeKeys.add(key);
  await h.handle(sessionEvent('turn/start', 1));
  await h.handle(toolCall(1));
  await h.handle(toolResult(1));
  await h.handle(turnEnd(1));
  check('T1 自动收尾失败回退保证可唤醒', h.get('ensureWakeable').length >= 1 && h.get('deliver').length === 0);
}
// T4：上下文接近上限时主动轮换（usage 的 input+cacheRead ≈ 本次请求上下文）。
{
  const h = createEventHarness({ mode: 'reserved2' });
  await h.handle(sessionEvent('turn/start', 1));
  const frame = assistantMessage(1, 'hi');
  frame.payload.event.data.usage = { inputTokens: 700000, cacheReadTokens: 100000 };
  await h.handle(frame);
  await h.handle(turnEnd(1));
  check('T4 接近上限时主动轮换', h.get('rotateCtx').length === 1
    && h.get('rotateCtx')[0][1] === key && h.get('rotateCtx')[0][3] === 800000);
  check('T4 轮换判断后清空会话估算', !h.deps.sessionContextTokens.has(sid));
}
{
  const h = createEventHarness({ mode: 'reserved2' });
  await h.handle(sessionEvent('turn/start', 1));
  const frame = assistantMessage(1, 'hi');
  frame.payload.event.data.usage = { inputTokens: 1000, cacheReadTokens: 0 };
  await h.handle(frame);
  await h.handle(turnEnd(1));
  check('T4 小上下文也交给桥接判定（阈值在桥接）', h.get('rotateCtx').length === 1 && h.get('rotateCtx')[0][3] === 1000);
}
// T5：回合指标接线（开始 / usage / 工具调用 / 工具结果 / 收尾）。
{
  const h = createEventHarness({ mode: 'reserved2' });
  await h.handle(sessionEvent('turn/start', 1));
  const frame = assistantMessage(1, 'hi');
  frame.payload.event.data.usage = { inputTokens: 1000, cacheReadTokens: 4000, outputTokens: 200 };
  await h.handle(frame);
  await h.handle(toolCall(1));
  await h.handle(toolResult(1));
  await h.handle(turnEnd(1));
  check('T5 回合指标接线（开始/usage/工具/结果/收尾）', h.get('tmBegin').length === 1
    && h.get('tmBegin')[0][2] === key
    && h.get('tmUsage').length === 1
    && h.get('tmTool').length === 1 && h.get('tmTool')[0][2] === 'mcp__snowluma__qq_send_message'
    && h.get('tmResult').length === 1
    && h.get('tmResult')[0][2] === 'mcp__snowluma__qq_send_message'
    && h.get('tmResult')[0][3] === '测试回复'.length
    && h.get('tmResult')[0][4] === false
    && h.get('tmFinish').length === 1);
}
for (const rejection of ['returned', 'thrown']) {
  const h = createEventHarness({ mode: 'reserved2', deps: { deliverPrompt: async () => {
    if (rejection === 'thrown') throw new Error('delivery failed');
    return { ok: false };
  } } });
  h.deps.pendingWakeKeys.add(key); await h.turn(1);
  await Promise.resolve();
  check(`提醒投递 ${rejection} 释放唤醒标记与租约`, !h.deps.pendingWakeKeys.has(key) && h.get('disarmLease').length === 2);
}
{
  const h = createEventHarness({ mode: 'reserved2' });
  h.deps.pendingWakeKeys.add(key); h.deps.wakeConfigMissCount.set(key, 1);
  h.deps.getSocialV2State(key).wakeConfig.custom = true;
  await h.turn(1);
  check('提醒次数达上限恢复默认配置', !h.states.get(key).wakeConfig.custom && h.get('deliver').length === 0);
  const st = h.states.get(key);
  st.pendingWakeReasons = [{ reason: 'poke', seq: 1 }, { reason: 'atMention', seq: 2, snapshot: { text: '点名原文' } }];
  st.unread = [{ seq: 3 }];
  await h.turn(2);
  check('补投按优先级选 @，保留触发正文并清队列', h.get('scheduleWake').at(-1)?.[2] === 'atMention'
    && st.pendingWakeMessage.text === '点名原文' && st.pendingWakeReasons.length === 0);
  st.pendingWakeReasons = [{ reason: 'question', seq: 8 }];
  await h.turn(3);
  check('旧队列只有 seq 时从日志补正文', st.pendingWakeMessage.seq === 8 && st.pendingWakeMessage.text.includes('完整日志'));
}

console.log('\n── 压缩摘要、提问审批与学习会话 ──');
{
  const h = createEventHarness();
  const event = sessionEvent('compaction/summary', undefined, { summary: [{ type: 'text', text: 'fixture-secret' + '文'.repeat(5000) }] });
  delete event.payload.event.data.turn;
  await h.handle(event);
  const saved = h.get('compaction')[0];
  check('无活跃回合也保存压缩摘要并脱敏截长', saved?.[3].summary.length === 4000 && !saved[3].summary.includes('fixture-secret'));
  check('压缩摘要更新指标但不创建回合', h.deps.contextMetrics.has(key) && h.deps.collectors.size === 0);
  await h.handle({ rpcId: 'rpc-q', payload: { type: 'question/requested', sessionId: sid, questions: [{ id: 'q', question: '选哪一个', options: [{ label: '正常' }] }] } });
  check('提问正常发送后登记原 RPC', h.get('send')[0]?.[2].includes('选哪一个') && h.get('pending')[0]?.[2].rpcId === 'rpc-q');
  await h.handle({ rpcId: 'rpc-a', payload: { type: 'approval/requested', sessionId: sid, approvalId: 'a', toolName: '测试工具', reason: '正常理由' } });
  check('审批正常发送后登记', h.get('pending')[1]?.[2].kind === 'approval' && h.get('pending')[1]?.[2].approvalId === 'a');
  h.deps.learnerSessions.add('learner-old');
  let resolved = '', rejected = false;
  h.deps.learnerWaiters.set('learner-old', [{ resolve: t => { resolved = t; }, reject: () => { rejected = true; } }]);
  await h.turn(1, '学习结果', undefined, 'learner-old');
  check('旧学习会话完成只回填任务并移除登记', resolved === '学习结果' && !rejected && !h.deps.learnerSessions.has('learner-old') && h.get('send').length === 2);
  h.setLearner('learner-new'); h.deps.learnerSessions.add('learner-new');
  h.deps.learnerWaiters.set('learner-new', [{ resolve() {}, reject: () => { rejected = true; } }]);
  await h.turn(1, '', { kind: 'error', error: { message: 'failed' } }, 'learner-new');
  check('当前学习会话失败拒绝任务但保留会话', rejected && h.deps.learnerSessions.has('learner-new'));
  for (const type of ['question/requested', 'approval/requested']) {
    await h.handle({ rpcId: type, payload: { type, sessionId: 'learner-new', questions: [{ id: 'q', question: '内部' }], approvalId: 'a' } });
  }
  check('学习提问自动留空、审批自动拒绝', h.get('respond')[0]?.[1].result.value.answer.answers[0].custom === ''
    && h.get('respond')[1]?.[1].result.value.outcome === 'rejected' && h.get('pending').length === 2);
}

console.log('\n── 正常断流与异常断流共用清理 ──');
for (const throwError of [false, true]) {
  const controller = new AbortController(); let resolved = 0, sleeps = 0;
  const h = createEventHarness({ deps: {
    api: { events: { async *mux() {
      yield sessionEvent('turn/start', 1); yield toolCall(1);
      if (throwError) throw new Error('connection reset');
    } } },
    sleep: async () => { sleeps++; controller.abort(); }
  } });
  h.deps.biliJudgeWaiters.set(sid, { turn: null, resolve: () => { resolved++; } });
  h.deps.pendingWakeKeys.add(key); h.deps.activeWaits.add(key); h.deps.markReadCalledKeys.add(key);
  h.deps.wakeConfigUpdatedKeys.add(key); h.deps.wakeConfigMissCount.set(key, 1);
  h.deps.social.silentTurns.set(sid, [{ ts: h.deps.now() }]); h.deps.social.exitingSessions.add(sid);
  await h.pump.pumpMux({ signal: controller.signal });
  check(`${throwError ? '异常' : '正常'}断流清理全部回合/工具/等待状态`, [
    'collectors', 'currentTurnBySession', 'v2TurnStartAt', 'pendingSendToolCalls', 'toolCallNames', 'sendToolSucceededSessions',
    'biliJudgeWaiters', 'biliJudgeCollectors', 'pendingWakeKeys', 'activeWaits', 'markReadCalledKeys', 'wakeConfigUpdatedKeys', 'wakeConfigMissCount'
  ].every(n => h.deps[n].size === 0) && h.deps.social.silentTurns.size === 0 && h.deps.social.exitingSessions.size === 0);
  check('断流结束初判等待并撤销租约，然后等待重连', resolved === 1 && h.get('clearLeases').length === 1 && sleeps === 1);
  await h.turn(2, '重连后正常');
  check('清理后下一回合可正常回复', h.get('send').at(-1)?.[2] === '重连后正常');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
