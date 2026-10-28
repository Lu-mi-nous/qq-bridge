// T1：发言回合自动收尾（把「必填 mark_read / set_wake_config」移出模型控制流）。
//
// 覆盖：
//   1. createTurnWrap 的已读水位清理与未答 @ 保护；
//   2. preset / wake prompt 文案不再要求「回复后必须 wait」；
//   3. replyCheck 提示与新行为一致。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTurnWrap } from '../src/pipeline/turn-wrap.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

function make({ unread = [], wakeSeqAt = 0, pending = [] } = {}) {
  const st = { unread: unread.map((m) => ({ ...m })), wakeSeqAt, lastActionAt: 0, wakeConfig: { noActionCount: 2 } };
  const logs = [], saves = [], ensured = [];
  const fn = createTurnWrap({
    getState: () => st,
    findCallers: () => ({ pending }),
    ensureWakeable: (state, opts) => ensured.push({ state, opts }),
    save: () => saves.push(1),
    log: (line) => logs.push(line),
    now: () => 12345
  });
  return { fn, st, logs, saves, ensured };
}

console.log('── 1. 已读水位与未答 @ 保护 ──');
{
  const t = make({ unread: [{ seq: 1 }, { seq: 3 }, { seq: 5 }], wakeSeqAt: 3 });
  const r = t.fn('group:1');
  check('只清唤醒水位内的未读，保留之后到达的', r.cleared === 2 && r.kept === 1 && t.st.unread.map((m) => m.seq).join() === '5');
  check('水位用掉即清', t.st.wakeSeqAt === 0);
  check('记录行为时间并清零无行动计数', t.st.lastActionAt === 12345 && t.st.wakeConfig.noActionCount === 0);
  check('保证下一次可唤醒', t.ensured.length === 1 && t.ensured[0].opts.key === 'group:1');
  check('确认来源标记为 auto_reply', t.st.wakeConfig.confirmedBy === 'auto_reply' && t.st.wakeConfig.confirmedAt === 12345);
  check('落盘一次', t.saves.length === 1);
}
{
  const t = make({ unread: [{ seq: 1 }, { seq: 2 }], wakeSeqAt: 5, pending: [{ seq: 9, text: '@我' }] });
  const r = t.fn('group:1');
  check('有未答 @ 时不清任何未读', r.cleared === 0 && r.kept === 2 && r.pendingCallers === 1);
  check('有未答 @ 仍补唤醒配置并落盘', t.ensured.length === 1 && t.saves.length === 1);
  check('日志说明保留原因', t.logs.at(-1).includes('未答 @'));
}
{
  const t = make({ unread: [{ seq: 2 }], wakeSeqAt: 0 });
  const r = t.fn('group:1');
  check('没有水位时不清未读（不吞本轮新消息）', r.cleared === 0 && r.kept === 1);
}

console.log('\n── 2. preset 不再要求回复后守着 wait ──');
{
  const preset = fs.readFileSync(path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');
  check('写明「回复后直接收尾」', preset.includes('【回复后直接收尾】'));
  check('删除「必须回复后等待」', !preset.includes('【必须】回复后不要立刻结束')
    && !preset.includes('先调用 mcp__snowluma__qq_wait_for_messages 等待可能的回复'));
  check('说明桥接自动标已读并保证唤醒', preset.includes('桥接会自动标记已读')
    && preset.includes('只在有人回复或出现新消息时才再叫醒你'));
  check('保留半句未完的 wait 例外', preset.includes('对方没说完') || preset.includes('对方明显半句没说完'));
  check('保留等待特定的人（speakerIds）例外', preset.includes('speakerIds'));
  check('沉睡前观察仍保留（潜水前）', preset.includes('沉睡前观察'));
}

console.log('\n── 3. wake prompt 与新行为一致（行为断言，不读源码）──');
{
  const { createWakePromptBuilder } = await import('../src/pipeline/wake.js');
  const wake = createWakePromptBuilder({
    roleFor: () => '测试角色',
    currentRoleHintV2: () => '测试角色卡正文',
    getSocialV2State: () => ({ agentToken: 't', unread: [], recentMessages: [], wakeConfig: {}, pendingWakeMessage: null, lastAiReplyAt: 0 }),
    cfg: { socialV2: { tools: {}, sticker: { enabled: false }, wake: { preSleepWaitMs: 300000 } } },
    getTtsEngine: () => null,
    formatMemoryV2: () => '',
    contextCfg: () => ({ memoryPackChars: 1500, recallAuditKeep: 200 }),
    stateDir: '/tmp/qqb-turn-wrap-test',
    loadEpisodes: () => [],
    loadCompactions: () => [],
    loadLongTermMemory: () => ({}),
    formatMemoryPack: () => '',
    formatSharedMemoryForWake: () => '',
    buildGapNotice: () => '',
    contextMetrics: new Map(),
    log: () => {},
    buildRecallLine: () => '',
    formatParticipationV2: () => '',
    planStickerV2: () => null,
    getStickerEntries: () => [],
    stickerCacheOpts: () => ({}),
    buildStickerNudge: () => '',
    buildStickerStrategyHint: () => '',
    buildStickerContext: () => '',
    buildComplyLine: () => '',
    buildTokenAskLine: () => '',
    looksLikeUnfinished: () => false,
    findCallers: () => ({ pending: [], answered: [] })
  });
  const normal = wake.buildWakePrompt('group:1', 'question');
  check('回合收尾不再承诺无条件回复检查唤醒', !normal.includes('30~45 秒后自动唤醒'));
  check('收尾说明桥接自动标已读/保证唤醒', normal.includes('桥接会自动标记已读并保证下一次唤醒')
    && normal.includes('只在有人回复或出现新消息时才再叫醒你'));
  const reply = wake.buildWakePrompt('group:1', 'replyCheck');
  check('replyCheck 提示说明只在新消息时叫醒', reply.includes('有人回复了、或群里出现了新消息')
    && !reply.includes('桥接会稍后再次检查'));
  check('qq_wait_for_messages 仍存在（高级场景）', normal.includes('qq_wait_for_messages'));
}

console.log(fail ? `❌ ${pass} 通过 / ${fail} 失败` : `✅ ${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);
