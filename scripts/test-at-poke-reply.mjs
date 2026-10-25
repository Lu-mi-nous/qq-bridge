import { WAKE_PRIORITY } from '../src/pipeline/wake.js';
import { createEventHarness, sessionEvent, assistantMessage, turnEnd } from './helpers/dsh-event-harness.mjs';
// 回归测试：「@ 它 / 戳它有时候不回」的三个成因。
//
// 用户反馈（2026-10-20）：「现在@它或者戳它依旧有时候不回复」。
// 查下来是三条独立链路各自漏掉一部分，不是单一 bug：
//
// ① **拍一拍不分对象**。handlePokeNotice 只要 triggers.poke 开着就 scheduleWakeV2(key,'poke')，
//    提示词又写「可能拍了你，也可能拍了别人」→ 模型看到"拍的是别人"就不回。
//    群里感受就是「戳它有时候不理」。修法：拍自己用 pokeSelf（高优先级 + 明确要求回应），
//    拍别人用 poke（低优先级 + 明说不用回）。
//
// ② **pendingWakeReasons 不持久化**。它是内存队列：@ 到达时会话正忙 → 记进队列 →
//    等回合结束补发。但回合中途重启/崩溃，队列直接消失，那条 @ 永远不回。
//    启动补投只救"未读还没被 mark_read"的，救不了已标已读的。
//
// ③ **收尾提醒只催收尾**。buildWakeReminderPromptV2 原本只给角色名 + "请设置下一次唤醒"，
//    模型收到就直接 qq_set_wake_config 潜水，把没回的 @ 一起带走。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
const wakeSrc = fs.readFileSync(path.join(root, 'src/pipeline/wake.js'), 'utf8');

console.log('── 1. 拍一拍区分「拍你」和「拍别人」──');
{
  check('有 pokeSelf 唤醒原因', /scheduleWakeV2\(key, targetIsSelf \? 'pokeSelf' : 'poke'\)/.test(src));
  check('pokeSelf 在优先级表里', WAKE_PRIORITY.pokeSelf === 85);
  check('poke 优先级低于普通消息（拍别人不抢戏）', WAKE_PRIORITY.poke === 35);
  check('pokeSelf 优先级高于 poke', (() => {
    const self = Number((/pokeSelf:\s*(\d+)/.exec(wakeSrc) || [])[1]);
    const other = Number((/(?:^|\s)poke:\s*(\d+)/.exec(wakeSrc) || [])[1]);
    return self > other && other > 0;
  })());

  // 提示词：拍你 -> 必须回应；拍别人 -> 不必回
  const selfBlock = /reason === 'pokeSelf'\) \{[\s\S]{0,500}?\n    \}/.exec(wakeSrc)?.[0] ?? '';
  check('pokeSelf 提示词明确"必须回应"', /必须回应/.test(selfBlock), selfBlock.slice(0, 60));
  check('pokeSelf 提示词给出最小回应方式（回拍/短句）', /qq_send_poke/.test(selfBlock) && /诶？|干嘛|在/.test(selfBlock));
  const otherBlock = /reason === 'poke'\) \{[\s\S]{0,400}?\n    \}/.exec(wakeSrc)?.[0] ?? '';
  check('poke 提示词明确"不是拍你"', /不是拍你/.test(otherBlock));
  check('poke 提示词允许不说话', /不必每次都说话|安静收尾/.test(otherBlock));
  check('不再出现"可能拍了你，也可能拍了别人"的模糊措辞',
    !/可能拍了你，也可能拍了别人/.test(src));
}

console.log('\n── 2. 繁忙期间的唤醒原因必须持久化 ──');
{
  // 定位 saveSocialV2State 的白名单块
  const storeSrc=fs.readFileSync(path.join(root,'src/pipeline/social-state.js'),'utf8');
  const s=storeSrc.indexOf('function saveSocialV2State');
  const block=storeSrc.slice(s,s+5000);
  check('pendingWakeReasons 进入持久化白名单', /pendingWakeReasons:\s*Array\.isArray\(st\.pendingWakeReasons\)/.test(block));
  check('只保留对象项且上限 20 条（与内存队列一致）', /slice\(-20\)/.test(block));
  check('赋值处仍在（生产端）', /queuePendingWakeReasonV2\(st, key, reason, seq\)/.test(src)
    && /st\.pendingWakeReasons\.push\(\{ reason, seq: nseq, snapshot:/.test(src));
  const events = createEventHarness({ mode: 'reserved2' });
  const st = events.deps.getSocialV2State('group:1');
  st.pendingWakeReasons = [{ reason: 'atMention', seq: 9 }];
  await events.turn(1);
  check('补发会消费队列并保存状态', st.pendingWakeReasons.length === 0
    && events.get('scheduleWake').length === 1 && events.get('save').length > 0);
}

console.log('\n── 3. 收尾提醒不能把没回的 @ 带走 ──');
{
  const s = src.indexOf('function buildWakeReminderPromptV2');
  const block = src.slice(s, s + 1800);
  check('提醒里注入角色卡正文', /currentRoleHintV2\([^)]*\)/.test(block));
  check('不再只给"请调用 qq_get_prompt"', !/完整角色卡请调用 qq_get_prompt 查看/.test(block));
  check('有未读时先要求回应再收尾', /先别急着收尾/.test(block));
  check('提醒里点明"有人@你/问你/拍你就先回应"', /先回应/.test(block));
}

console.log('\n── 3b. 「谁拍了你」必须出现在此刻状态里 ──');
{
  // 实测证据（state/qq-activity.log 04:36~04:39）：连续 5 次「戳了戳 你」，
  // 每一轮模型只输出"这轮先到这儿"就收尾 —— 因为它压根没在状态里看到"有人拍你"。
  // findCallersV2 刻意排除拍一拍（怕逼它回应），但 pokeSelf 场景必须单独point出来。
  const s = wakeSrc.indexOf('const pokeSelfs');
  // 这一段的文案会随提示词迭代变长，别用太窄的固定窗口（曾经 700 字就会漏掉后半句）。
  const block = wakeSrc.slice(s, s + 2000);
  check('状态里单独统计"拍你"的事件', s > 0 && /poke\?\.targetIsSelf/.test(block));
  check('写明是谁拍的', /有人戳了你（\$\{who\}）/.test(block) || /有人戳了你/.test(block));
  check('给出可执行的回应方式（含可照抄的目标）', /targetUserId="latest"/.test(block) && /回一句话/.test(block), block.slice(0, 120));
  check('状态里只取最近 3 条（防刷屏撑大提示词）', /slice\(-3\)/.test(block));

  // MCP 工具描述也要一致，否则模型仍以为"拍别人也会叫它"
  const mcp = fs.readFileSync(path.join(root, 'src/mcp-snowluma-safe.js'), 'utf8');
  check('MCP 描述区分"拍你"与"拍别人"', /拍你时一定会唤醒|拍你时一定唤醒/.test(mcp));
  check('MCP 描述不再说"包括拍你和拍别人"', !/包括拍你和拍别人/.test(mcp));
}

console.log('\n── 4. @ 本身的唤醒链路仍然完整 ──');{
  check('atMention 判定仍在', /if \(tr\.atMention\) \{[\s\S]{0,220}?return 'atMention'/.test(src));
  check('@ 的优先级最高（仅次于私聊）', WAKE_PRIORITY.atMention === 90);
  check('高优先级会缩短合并窗口等待', /高优先级，已缩短等待/.test(src));
  const events = createEventHarness({ mode: 'reserved2' });
  const pendingState = events.deps.getSocialV2State('group:1');
  pendingState.pendingWakeReasons = [{ reason: 'poke', seq: 1 }, { reason: 'atMention', seq: 2 }];
  await events.turn(1);
  check('繁忙时会记录并在回合结束按优先级补发', events.get('scheduleWake')[0]?.[2] === 'atMention');

  // 2026-10-23 群 100002005：anyMessage 放在最前面，把 owner 的 @ 记成
  // anyMessage@seq7064，随后连续「唤醒频率超限，跳过」——@ 被自己的兜底规则饿死。
  const start = src.indexOf('function evaluateWakeTriggerV2');
  const fn = src.slice(start, start + 3200);
  const pos = (needle) => fn.indexOf(needle);
  const anyPos = pos('if (tr.anyMessage)');
  check('anyMessage 在函数里存在', anyPos > 0);
  check('@ 判定排在 anyMessage 之前',
    pos('if (tr.atMention)') > 0 && pos('if (tr.atMention)') < anyPos);
  check('提问/指定成员/名字/关键词都排在 anyMessage 之前',
    pos('if (tr.question') > 0 && pos('if (tr.question') < anyPos
    && pos('Array.isArray(tr.speakerIds)') > 0 && pos('Array.isArray(tr.speakerIds)') < anyPos
    && pos('if (tr.nameMention') > 0 && pos('if (tr.nameMention') < anyPos
    && pos('Array.isArray(tr.keywords)') > 0 && pos('Array.isArray(tr.keywords)') < anyPos);
  check('anyMessage 只作为兜底（在关键词之后）',
    anyPos > pos('Array.isArray(tr.keywords)'));

  // 仅修判定还不够：anyMessage 定时器可能在限流时被丢，@ 仍会一起饿死。
  // 投递前必须再把“还有未答 @”的唤醒升级成 atMention。
  const wakeStart = src.indexOf('async function sendWakePromptV2');
  const wakeFn = src.slice(wakeStart, wakeStart + 4000);
  check('投递前把未答 @ 升级为 atMention',
    /findCallersV2\(key, st\)\.pending\.length/.test(wakeFn)
    && /reason = 'atMention'/.test(wakeFn));
}

console.log('\n── 5. 唤醒频率限流不能饿死 @ / 戳你 ──');
{
  // 实测（2026-10-21）：`唤醒频率超限，跳过` 出现 40 次，其中包含 pokeSelf——
  // 用户戳它、已排到高优先级、还缩短了等待，最后被限流直接丢弃。
  // 群一热闹，anyMessage 就把 maxWakePerHour(30) 吃光，真正冲它来的反而进不来。
  const s = src.indexOf('唤醒频率硬限制');
  const block = src.slice(s, s + 2200);
  check('存在高优先级判定', /const isHighPriorityWake = wakePriorityV2\(reason\) >= 75/.test(block));
  check('低优先级才被限流丢弃', /if \(!isHighPriorityWake && \(\(maxPerMinute/.test(block));
  check('高优先级超限时放行并记日志', /唤醒频率超限但放行/.test(block) && /不能被饿死/.test(block));
  check('跳过日志标注"低优先级"以便区分', /低优先级）/.test(block));

  // 阈值必须真的覆盖 @ 和 pokeSelf
  const prio = (name) => Number((new RegExp(`${name}:\\s*(\\d+)`).exec(wakeSrc) || [])[1] || 0);
  check(`atMention(${prio('atMention')}) >= 75`, prio('atMention') >= 75);
  check(`pokeSelf(${prio('pokeSelf')}) >= 75`, prio('pokeSelf') >= 75);
  check(`private(${prio('private')}) >= 75`, prio('private') >= 75);
  check(`question(${prio('question')}) >= 75`, prio('question') >= 75);
  // 低优先级的确实低于阈值
  check(`anyMessage(${prio('anyMessage')}) < 75`, prio('anyMessage') < 75);
  check(`probability 无限流豁免（不在表内或为 0）`,
    prio('probability') < 75);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
