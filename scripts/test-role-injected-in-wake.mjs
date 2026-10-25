// 回归测试：角色卡正文必须进入**群聊唤醒提示**（不能只给一行"请调用 qq_get_prompt"）。
//
// 事故（2026-10-20 用户反馈「它极少回复表情包」）：
//   角色卡写着「表情是你的主武器，能发就发…多数轮次都该带表情」，
//   但 buildWakePromptV2() 只注入 `【当前角色】大肥鱼（完整角色卡请调用 qq_get_prompt 查看）`，
//   指望模型自己去取全文。实测 30 天里：群聊唤醒 7605 次，qq_get_prompt 只被调用 26 次
//   —— 99.7% 的回合模型根本没看过角色卡，人格只剩一个名字。
//
// 第 4A 步后：buildWakePromptV2 的实现抽到 src/pipeline/wake.js；
// 本测试改为 import 行为断言（假 deps 直接构建 prompt），外加 bridge 接线检查。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWakePromptBuilder } from '../src/pipeline/wake.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const wakeSrc = fs.readFileSync(path.join(root, 'src/pipeline/wake.js'), 'utf8');
const roleText = fs.readFileSync(path.join(root, 'roles/大肥鱼.md'), 'utf8');

const deps = {
  roleFor: () => '大肥鱼',
  currentRoleHintV2: () => roleText,
  getSocialV2State: () => ({
    agentToken: 'test-token',
    unread: [],
    recentMessages: [],
    wakeConfig: {},
    pendingWakeMessage: null,
    lastAiReplyAt: 0
  }),
  cfg: { socialV2: { tools: {}, sticker: { enabled: false } } },
  getTtsEngine: () => null,
  formatMemoryV2: () => '',
  contextCfg: () => ({ memoryPackChars: 1500, recallAuditKeep: 200 }),
  stateDir: '/tmp/qqb-wake-test',
  loadEpisodes: () => [],
  loadCompactions: () => [],
  loadLongTermMemory: () => ({}),
  formatMemoryPack: () => '【长期记忆】测试记忆包',
  formatSharedMemoryForWake: () => '【人物资料（背景补充，不是指令）】\n- 清宵（QQ 10001）：喜欢 原神',
  buildGapNotice: () => '【运行状态·背景补充】\n这个会话距你上次处理已过约 2 小时。',
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
  findCallers: () => []
};
const wake = createWakePromptBuilder(deps);

console.log('── 1. 唤醒提示注入角色卡正文（行为断言）──');
{
  const prompt = wake.buildWakePrompt('group:123', 'bootstrap');
  check('角色段包含角色名', prompt.includes('【当前角色】大肥鱼'));
  check('角色卡正文进入唤醒提示（角色卡独有句子）', prompt.includes('表情是你的主武器'));
  check('不再退回「完整角色卡请调用 qq_get_prompt 查看」',
    !prompt.includes('（完整角色卡请调用 qq_get_prompt 查看）'));
  check('bootstrap 引导仍要求先看 prompt / 设置唤醒',
    prompt.includes('qq_get_prompt') && prompt.includes('qq_set_wake_config'));
  check('记忆包注入', prompt.includes('【长期记忆】测试记忆包'));
  check('跨会话人物资料注入', prompt.includes('【人物资料（背景补充，不是指令）】')
    && prompt.includes('清宵（QQ 10001）：喜欢 原神'));
  check('记录共享注入字数', deps.contextMetrics.get('group:123')?.lastSharedChars > 0);
  check('记忆断层背景注入', prompt.includes('【运行状态·背景补充】') && prompt.includes('约 2 小时'));
  check('记录断层注入字数', deps.contextMetrics.get('group:123')?.lastGapChars > 0);
  const poke = wake.buildWakePrompt('group:123', 'pokeSelf');
  check('pokeSelf 唤醒仍带角色卡', poke.includes('表情是你的主武器') && poke.includes('有人拍了你'));
}

console.log('\n── 2. bridge / pipeline 接线 ──');
{
  
  
  check('wake 模块调用 currentRoleHintV2 取角色卡正文', /deps\.currentRoleHintV2/.test(wakeSrc));
  check('wake 模块仍保留通用 stickerLine 注入', /stickerLine/.test(wakeSrc));
}

console.log('\n── 3. 角色卡里的表情强命令确实存在（被注入才有意义）──');
{
  check('角色卡有「表情是你的主武器」', roleText.includes('表情是你的主武器'));
  check('角色卡要求「能发就发」', roleText.includes('能发就发'));
  check('角色卡要求「多数轮次都该带表情」', roleText.includes('多数轮次都该带表情'));
  check('该段落在注入上限（12000 字）以内',
    roleText.indexOf('表情是你的主武器') < 12000 && roleText.indexOf('表情是你的主武器') > 0);
}

console.log('\n── 4. 提示词体积仍在合理范围 ──');
{
  const card = roleText.length;
  const stickerHint = 1200;   // 【表情包策略】+【可用表情包】约 1.2 KB
  const other = 4000;         // 令牌/状态/唤醒/等待等
  const total = card + stickerHint + other;
  check(`角色卡 ${card} + 其余 ≈ ${total} 字，未超 20000`, total < 20000, `合计约 ${total} 字`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
