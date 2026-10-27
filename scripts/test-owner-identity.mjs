// 回归测试：管理员身份判定（isOwnerTurn）与删除表情权限。
//
// 需求来源（2026-10-22 用户反馈「删不掉表情包」）：
//   截图里管理员 @ 机器人「把这个表情包删了」，机器人先回「隔壁的鱼不归鱼管」，
//   再回「删不掉，这边回的是没权限」。
//
// ── 实测根因 ────────────────────────────────────────────────────────
//
//   日志：`05:56:35 [sticker] 拒绝删除表情：请求者不是管理员（group:1000000005）`
//   时间线（同一会话）：
//     13:55:48 管理员(1000000000) 引用表情说「把这个表情包删了」
//     13:56:06 群友群友F 发了条拍一拍 → lastRequesterId 被覆盖成群友
//     13:56:35 模型这才调用 qq_delete_sticker → 判成"非管理员"，403
//   即：**管理员的请求被后续闲聊消息冲掉了**。群越热闹越容易出现。
//
//   另外发现一个既有缺陷：`lastRequesterId` 只存不读（saveSocialV2State 有、
//   加载时没恢复），所以**每次重启后**管理员都无法通过判定。
//
// ── 修法 ────────────────────────────────────────────────────────────
//
//   ① 记录 `ownerSpokeAt`（管理员最后一次发言时间）；
//   ② isOwnerTurn = 「最近一条是管理员」**或**「管理员在 N 分钟窗口内说过话」；
//   ③ 存/读两侧都补 lastRequesterId / lastRequesterRole / ownerSpokeAt。
//
// 本测试锁住这三条，尤其是"管理员说完话、别人插一句"这个真实场景。
import fs from 'node:fs';
import path from 'node:path';
import { isOwnerTurn } from '../src/pipeline/message-format.js';
import { readConsoleSource } from './lib/console-src.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const pipelineSrc = fs.readFileSync(path.join(root, 'src', 'pipeline', 'message-format.js'), 'utf8');
const consoleServerSrc = readConsoleSource();

console.log('── 1. 判定逻辑 ──');
{

  const OWNER = '1000000000';
  const state = { lastRequesterId: '', lastRequesterRole: '', ownerSpokeAt: 0 };
  const now = Date.now();
  const fn = () => isOwnerTurn({ ownerQQ: OWNER, state, windowMs: 5 * 60 * 1000, now });

  // ① 最近一条就是管理员
  Object.assign(state, { lastRequesterId: OWNER, ownerSpokeAt: now });
  check('最近一条是管理员 → 通过', fn() === true);

  // ② 管理员说完、被别人的消息覆盖（**本次 bug 的核心场景**）
  Object.assign(state, { lastRequesterId: '2322789554', ownerSpokeAt: now - 47 * 1000 });
  check('管理员说完 47 秒后被别人覆盖 → 仍通过', fn() === true,
    '修复前这里是 false，即用户遇到的"删不掉"');

  // ③ 超出时间窗
  Object.assign(state, { lastRequesterId: '2322789554', ownerSpokeAt: now - 6 * 60 * 1000 });
  check('管理员说完 6 分钟（超 5 分钟窗）→ 拒绝', fn() === false);

  // ④ 从没有管理员说过话
  Object.assign(state, { lastRequesterId: '2322789554', ownerSpokeAt: 0 });
  check('从未有管理员 → 拒绝', fn() === false);

  // ⑤ 没配 ownerQQ 时一律拒绝（fail-closed）
  check('未配置 ownerQQ → 拒绝（fail-closed）',
    isOwnerTurn({ ownerQQ: '', state: { lastRequesterId: '', ownerSpokeAt: now }, windowMs: 5 * 60 * 1000, now }) === false);

  // ⑥ 窗口可配
  check('窗口可配置（60 秒窗口下 2 分钟前的不算）',
    isOwnerTurn({ ownerQQ: OWNER, state: { lastRequesterId: 'x', ownerSpokeAt: now - 2 * 60 * 1000 }, windowMs: 60 * 1000, now }) === false);
  check('窗口设 0 时只看最新一条',
    isOwnerTurn({ ownerQQ: OWNER, state: { lastRequesterId: 'x', ownerSpokeAt: now }, windowMs: 0, now }) === false);
}

// 身份持久化往返在 test-social-state.mjs 覆盖，入站接线在 test-bridge-wiring.mjs 覆盖。

console.log('\n── 4. 拒绝时的措辞 ──');
{
  // 模型看到"仅管理员可用"会如实转述，比"删不掉"更清楚
  check('拒绝信息说明仅管理员可用', /删除收藏表情仅管理员可用/.test(consoleServerSrc));
  check('提示让管理员来说', /请让管理员来说/.test(consoleServerSrc));
  check('拒绝时写日志（便于排查）', /拒绝删除表情：请求者不是管理员/.test(consoleServerSrc));
}

console.log('\n── 4b. preset 指引（模型要"去做"，不是打岔）──');
{
  // 截图里模型先回了「隔壁的鱼不归鱼管」——它没意识到"删表情"是它能做的事。
  // 工具描述里写了，但 preset 里没有，模型就容易用俏皮话打岔。
  const preset = fs.readFileSync(path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');
  check('preset 有删除表情的指引', /【删除表情：群友要求就去做】/.test(preset));
  check('preset 明确工具名', /qq_delete_sticker/.test(preset));
  check('preset 禁止用俏皮话打岔', /不归我管|我删不了/.test(preset));
  check('preset 说明仅管理员可用', /仅后台管理员可用/.test(preset));
  check('preset 要求 403 时如实说、不重试', /不要反复重试/.test(preset));
  // 已安装到 DSH 的副本也要有新规则（否则 DSH 读的是旧 preset）
  const installed = path.join(process.env.USERPROFILE || process.env.HOME || '',
    '.dsh', '.agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
  if (fs.existsSync(installed)) {
    const inst = fs.readFileSync(installed, 'utf8');
    check('DSH 已安装的 preset 也已同步', /【删除表情：群友要求就去做】/.test(inst));
  } else {
    check('DSH preset 路径（未安装时跳过）', true);
  }
}

console.log('\n── 5. 窗口可配置 ──');
{

  check('默认 5 分钟', /windowMs = 5 \* 60 \* 1000/.test(pipelineSrc));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
