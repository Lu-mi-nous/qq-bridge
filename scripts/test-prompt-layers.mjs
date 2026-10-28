// T3：唤醒提示分层（角色摘要注入 / profile 能力片段缺席 / 分项字符指标）
// + qq_get_prompt compact 载荷。
import assert from 'node:assert/strict';
import { createWakePromptBuilder } from '../src/pipeline/wake.js';
import { buildPromptCompact } from '../src/console/routes/07-activity.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { (typeof fn === 'function' ? fn : () => { if (!fn) throw new Error('false'); })(); pass++; console.log(`PASS ${name}`); }
  catch (error) { fail++; console.log(`FAIL ${name}  ${error?.message ?? error}`); }
};

const metrics = new Map();
function makeWake({ roleText = '摘要正文', fullCard = '完整角色卡正文', visible = () => true, tts = false } = {}) {
  const seen = { roleTextCalls: [], visibleCalls: [] };
  const deps = {
    roleFor: () => '大肥鱼',
    currentRoleHintV2: () => fullCard,
    roleTextFor: (key, reason) => { seen.roleTextCalls.push(reason); return roleText; },
    capabilityVisible: (tool) => { seen.visibleCalls.push(tool); return visible(tool); },
    getSocialV2State: () => ({ agentToken: 't', unread: [], recentMessages: [], wakeConfig: {}, pendingWakeMessage: null, lastAiReplyAt: 0 }),
    cfg: { socialV2: { tools: {}, sticker: { enabled: true } } },
    getTtsEngine: () => (tts ? { available: () => true } : null),
    formatMemoryV2: () => '',
    contextCfg: () => ({ memoryPackChars: 1500, recallAuditKeep: 200 }),
    stateDir: '/tmp/qqb-prompt-layers',
    loadEpisodes: () => [], loadCompactions: () => [], loadLongTermMemory: () => ({}),
    formatMemoryPack: () => '', formatSharedMemoryForWake: () => '', buildGapNotice: () => '',
    contextMetrics: metrics, log: () => {}, buildRecallLine: () => '', formatParticipationV2: () => '',
    planStickerV2: () => null, getStickerEntries: () => [], stickerCacheOpts: () => ({}),
    buildStickerNudge: () => '', buildStickerStrategyHint: () => '【表情包策略】STRATEGY', buildStickerContext: () => '',
    buildComplyLine: () => '', buildTokenAskLine: () => '', looksLikeUnfinished: () => false,
    findCallers: () => ({ pending: [], answered: [] })
  };
  return { wake: createWakePromptBuilder(deps), seen };
}

console.log('── 1. 角色摘要注入 ──');
{
  const { wake, seen } = makeWake();
  const prompt = wake.buildWakePrompt('group:1', 'question');
  check('默认注入摘要而不是完整卡', prompt.includes('摘要正文') && !prompt.includes('完整角色卡正文'));
  check('把唤醒原因传给 roleTextFor（bootstrap 由桥接决定注入全卡）', seen.roleTextCalls.includes('question'));
  const boot = wake.buildWakePrompt('group:1', 'bootstrap');
  check('bootstrap 也走 roleTextFor（不在 wake.js 里硬判全卡）', seen.roleTextCalls.includes('bootstrap') && boot.includes('摘要正文'));
}
{
  // 桥接缺 roleTextFor 时退回整卡（降级路径）。
  const { wake } = makeWake({ roleText: '' });
  check('roleTextFor 缺陷时仍能构建提示', typeof wake.buildWakePrompt('group:1', 'question') === 'string');
}

console.log('\n── 2. profile 收窄时能力片段缺席 ──');
{
  const { wake } = makeWake({ visible: () => false });
  const prompt = wake.buildWakePrompt('group:1', 'question');
  check('表情策略缺席', !prompt.includes('【表情包策略】'));
  check('功能介绍缺席', !prompt.includes('【功能介绍】'));
  check('Token 用量缺席', !prompt.includes('【Token 用量】'));
  check('核心调度提示仍在', prompt.includes('【回合收尾】') && prompt.includes('【会话令牌】'));
}
{
  const { wake } = makeWake({ visible: (tool) => tool === 'qq_send_sticker' });
  const prompt = wake.buildWakePrompt('group:1', 'question');
  check('只放行表情时只注入表情片段', prompt.includes('【表情包策略】') && !prompt.includes('【功能介绍】'));
}

console.log('\n── 3. 提示分项字符指标 ──');
{
  const { wake } = makeWake();
  const prompt = wake.buildWakePrompt('group:1', 'question');
  const m = metrics.get('group:1')?.lastPromptSections;
  check('记录分项与总长', m && m.total === prompt.length && m.role > 0 && m.wrap > 0);
  check('表情片段计入 sticker 项', m.sticker > 0);
  const off = makeWake({ visible: () => false });
  off.wake.buildWakePrompt('group:2', 'question');
  check('能力隐藏后对应分项为 0', (metrics.get('group:2')?.lastPromptSections.sticker ?? -1) === 0);
}

console.log('\n── 4. qq_get_prompt compact 载荷 ──');
{
  const payload = buildPromptCompact({
    key: 'group:1',
    roleName: '大肥鱼',
    digest: '摘要',
    enabledTools: ['qq_send_message'],
    st: { unread: [{ seq: 1 }], wakeConfig: { mode: 'diving' } },
    wakeSafety: { guaranteed: true },
    now: () => 'T'
  });
  check('compact 只含摘要与关键状态', payload.detail === 'compact' && payload.role.hint === '摘要'
    && payload.unreadCount === 1 && payload.currentWakeConfig.mode === 'diving');
  check('compact 不含完整卡/记忆/黑话/表情字段', !('memory' in payload) && !('slang' in payload)
    && !('stickers' in payload) && !('recommended' in payload));
  check('note 指向 detail=full', payload.note.includes('detail=full'));
}

console.log(fail ? `❌ ${pass} 通过 / ${fail} 失败` : `✅ ${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);
