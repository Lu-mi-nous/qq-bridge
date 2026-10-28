// 回归测试：角色卡「名字」规则与注入完整性。
//
// 两件事，都在群里真实踩到过：
//
// ① **不许反复纠正称呼**（2026-10-20 用户反馈）。
//    截图里机器人连着两条在纠群友：「说了别喊这个，叫大肥鱼」。起因是角色卡写了两条互相矛盾的指令：
//      - 「被叫"AI"要反复纠正」（雷点）
//      - 「任何情况下你都叫大肥鱼」
//    模型于是把"纠正称呼"当成设定职责，谁喊错都要掰一次，显得像在念设定、不像真人。
//    现在要求：**喊什么就应什么**，同一轮最多提一次名字，别人再喊错也不追着改。
//
// ② **角色卡注入不能被静默截断**（同日顺带发现）。
//    currentRoleHint() 原来硬切 6000 字，而实际角色卡 6283 / 6946 / 7388 字，
//    末尾整节（表情包体系 / 轻量记忆 / 被问长相时）**根本没进提示词**，
//    而「被问长相时」正是"别编造外貌"的唯一约束——丢了不报错，只在群里表现为瞎编长相。
//    这里锁住：长度上限足够装下现有全部角色卡；若未来再超，必须留日志。
//
// 角色卡内容检查 + 真实注入读取行为。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const roleDir = path.join(root, 'roles');

import { createRoleHintReader, ROLE_HINT_MAX } from '../src/pipeline/role-hint.js';
const hintFor = createRoleHintReader({ ROOT: root, roleFor: key => key, roleHintCache: new Map(), log: () => {} });

const cards = fs.readdirSync(roleDir)
  .filter((f) => f.endsWith('.md') && !f.endsWith('.digest.md') && f !== 'README.md')
  .map((f) => ({ name: f.replace(/\.md$/, ''), file: f, text: fs.readFileSync(path.join(roleDir, f), 'utf8') }));

console.log('── 1. 名字规则：不许追着纠正称呼 ──');
{
  const main = cards.find((c) => c.name === '大肥鱼');
  const tsun = cards.find((c) => c.name === '大肥鱼（傲娇版）');
  check('两版大肥鱼都存在', !!main && !!tsun, cards.map((c) => c.name).join(', '));

  for (const c of [main, tsun].filter(Boolean)) {
    const tag = `[${c.name}]`;
    // 旧措辞：把"纠正"写成职责 / 雷点
    check(`${tag} 不再把「被叫 AI 要纠正」写成雷点`,
      !/被叫\s*"?AI"?\s*要(反复|炸毛)?纠正/.test(c.text));
    check(`${tag} 不再要求"任何情况下都叫大肥鱼"这种名字执念`,
      !/任何情况下你都叫大肥鱼/.test(c.text));
    // 新规则必须在场
    check(`${tag} 明确喊什么都答应、不纠正`,
      /不纠正、不强调/.test(c.text));
    check(`${tag} 明确同一轮最多提一次自己的名字`,
      /最多提一次自己的名字/.test(c.text));
    check(`${tag} 明确「名字不是雷点」`,
      /名字不是雷点/.test(c.text));
  }
}

console.log('\n── 2. 回复示例：教的是"应下"而不是"纠正" ──');
{
  // 反例（"说了别喊这个"）**允许**出现在「你不要：」下面——那是示范错误答法；
  // 但绝不能出现在「你可以：」下面，那会直接教模型去纠正。
  const correctionLines = /(说了别喊这个|我叫大肥鱼啦|我叫大肥鱼，不是这个|别喊这个，叫大肥鱼)/;
  for (const c of cards.filter((x) => /^大肥鱼/.test(x.name))) {
    const lines = c.text.split('\n');
    const wrongPlace = lines.filter((l) => /^你可以/.test(l.trim()) && correctionLines.test(l));
    check(`[${c.name}] "你可以"里没有纠正称呼的台词`, wrongPlace.length === 0, wrongPlace.join(' / '));
    check(`[${c.name}] 示例覆盖"被喊怪名字"场景`,
      /@大肥鱼装AI 妈妈/.test(c.text));
    // 该场景下必须给出"应下"的正面示范
    const idx = lines.findIndex((l) => /@大肥鱼装AI 妈妈/.test(l));
    const block = idx >= 0 ? lines.slice(idx, idx + 6).join('\n') : '';
    check(`[${c.name}] 该场景有"直接应下"的正面示范`,
      /你可以：.*(在呢|应了|随你叫|行吧)/.test(block), block.replace(/\n/g, ' ⏎ ').slice(0, 90));
  }

  const main = cards.find((c) => c.name === '大肥鱼');
  const positiveLines = main.text.split('\n').filter((l) => /^(你可以|或者)：/.test(l.trim()));
  check('[大肥鱼] 正面示例没有确认收到/记录完成腔',
    positiveLines.every((l) => !/(认下了|我记下了|已记住|这张我收下了|哈哈哈，应了)/.test(l)));
  check('[大肥鱼] 明确禁止任务受理腔和记忆汇报',
    /任务受理腔/.test(main.text) && /记忆工具静默调用/.test(main.text));
}

console.log('\n── 3. 注入完整性：6000 字硬截断已取消 ──');
{
  const maxLen = Math.max(...cards.map((c) => c.text.length));
  check(`现有最长的角色卡（${maxLen} 字）能整份装进上限`, maxLen <= ROLE_HINT_MAX);

  // 实际读取人格卡，确认注入末尾完整。
  const truncate = text => hintFor(cards.find(c => c.text === text).name);
  for (const c of cards) {
    const kept = truncate(c.text);
    check(`[${c.name}] 注入内容未被截断`, kept.length === c.text.length, `${kept.length}/${c.text.length}`);
  }

  const main = cards.find((c) => c.name === '大肥鱼');
  if (main) {
    check('[大肥鱼] 最后一节「被问长相时」完整进入提示词',
      /## 十二、被问长相时/.test(truncate(main.text)));
    check('[大肥鱼] 末尾的"禁写外貌"约束在场',
      /禁写外貌|别编造具体的发色|没有固定的外貌设定/.test(truncate(main.text)));
  }
  const tsun = cards.find((c) => c.name === '大肥鱼（傲娇版）');
  if (tsun) {
    check('[大肥鱼（傲娇版）] 「轻量记忆」节保住了',
      /## 十一、轻量记忆/.test(truncate(tsun.text)));
    check('[大肥鱼（傲娇版）] 「被问长相时」节保住了',
      /## 十二、被问长相时/.test(truncate(tsun.text)));
  }
  const whale = cards.find((c) => c.name === '小鲸鱼');
  if (whale) {
    check('[小鲸鱼] 「表情包体系」节保住了',
      /## 十、表情包体系/.test(truncate(whale.text)));
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
