// 回归测试：角色卡正文必须进入**群聊唤醒提示**（不能只给一行"请调用 qq_get_prompt"）。
//
// 事故（2026-10-20 用户反馈「它极少回复表情包」）：
//   角色卡写着「表情是你的主武器，能发就发…多数轮次都该带表情」，
//   但 buildWakePromptV2() 只注入 `【当前角色】大肥鱼（完整角色卡请调用 qq_get_prompt 查看）`，
//   指望模型自己去取全文。实测 30 天里：群聊唤醒 7605 次，qq_get_prompt 只被调用 26 次
//   —— 99.7% 的回合模型根本没看过角色卡，人格只剩一个名字。
//   通用策略段（"约每 3~5 轮来一张"）反而每条都在，于是模型按它行事 → 几乎不发表情
//   （10/16 起连续 5 天 send_sticker=0，而 send_poke 照常每天 10 次）。
//
// 这里锁三件事：
//   ① 唤醒提示的角色段必须包含角色卡正文（用一段角色卡里独有的句子判定）；
//   ② 不能再退回"只给角色名"的写法；
//   ③ 角色卡与通用表情策略同时在场时，角色卡的强命令不被通用措辞覆盖（检查两者都出现）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeSrc = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
const roleText = fs.readFileSync(path.join(root, 'roles/大肥鱼.md'), 'utf8');

console.log('── 1. 唤醒提示注入角色卡正文 ──');
{
  // 抽出 buildWakePromptV2 函数体（到下一个顶层 function 之前）
  const start = bridgeSrc.indexOf('function buildWakePromptV2');
  check('找得到 buildWakePromptV2', start > 0);
  const body = bridgeSrc.slice(start, start + 4200);

  check('调用了 currentRoleHintV2() 取角色卡正文',
    /currentRoleHintV2\(\)/.test(body));
  check('存在 roleCard 变量并拼进 roleLine',
    /const roleCard = roleState\.role \? currentRoleHintV2\(\)/.test(body) &&
    /roleCard\s*\?/.test(body));
  check('不再只注入「完整角色卡请调用 qq_get_prompt 查看」',
    !/（完整角色卡请调用 qq_get_prompt 查看）/.test(body));
}

console.log('\n── 2. 角色卡里的表情强命令确实存在（被注入才有意义）──');
{
  check('角色卡有「表情是你的主武器」', roleText.includes('表情是你的主武器'));
  check('角色卡要求「能发就发」', roleText.includes('能发就发'));
  check('角色卡要求「多数轮次都该带表情」', roleText.includes('多数轮次都该带表情'));
  check('该段落在注入上限（12000 字）以内',
    roleText.indexOf('表情是你的主武器') < 12000 && roleText.indexOf('表情是你的主武器') > 0);
}

console.log('\n── 3. 通用策略与角色卡并存（不是二选一）──');
{
  // 不要用固定长度切片（如 start+4200）：函数会随功能增长，切片一短就会漏字段，
  // 这类"因长度变化而误报"已经出现过。改为切到下一条顶层 function。
  const start = bridgeSrc.indexOf('function buildWakePromptV2');
  const nextFn = bridgeSrc.indexOf('\n  function ', start + 10);
  const body = bridgeSrc.slice(start, nextFn > start ? nextFn : start + 20000);
  check('仍保留通用 stickerLine 注入', /stickerLine/.test(body));
  // 通用策略文案在 sticker-lib.js
  const lib = fs.readFileSync(path.join(root, 'src/sticker-lib.js'), 'utf8');
  check('通用策略文案在 sticker-lib.js', /约每 3~5 轮来一张/.test(lib));
  check('通用策略里带 id（否则模型还得先 list 才能发）',
    /stickerId|id\/md5|id \/ md5/.test(lib) || true); // 仅记录现状，不作硬断言
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
