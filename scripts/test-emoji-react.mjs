// 回归测试：贴表情（**由模型自主决定**，桥接只做校验与限流）。
//
// 历史：初版是桥接按语气分类 + 概率自动贴，用户指出那本质是随机行为、易引起误解，
// 改成模型用工具自主决定。所以这里**不再测语气分类**（已删除），改测桥接该负责的三件事：
//   ① 表情 id 校验（模型可能编 id）② 限流（模型可能连贴）③ 推荐表情清单本身正确。
import fs from 'node:fs';
import {
  REACTION_EMOJIS, emojiMenuText, validateEmojiId, createReactionGate
} from '../src/emoji-react.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

console.log('── 推荐表情清单 ──');
{
  check('清单非空', REACTION_EMOJIS.length >= 10, `${REACTION_EMOJIS.length} 个`);
  check('每项都有 id/name/use', REACTION_EMOJIS.every((e) => e.id && e.name && e.use));
  check('id 都是 1~5 位数字', REACTION_EMOJIS.every((e) => /^\d{1,5}$/.test(String(e.id))));
  check('id 不重复', new Set(REACTION_EMOJIS.map((e) => e.id)).size === REACTION_EMOJIS.length);
  // 清单里不该有负面情绪表情：给模型列出来容易被误用成阴阳怪气
  const NEG = /(发怒|咒骂|抓狂|白眼|鄙视|骷髅|便便|菜刀|炸弹)/;
  check('不含负面情绪表情', !REACTION_EMOJIS.some((e) => NEG.test(e.name)), REACTION_EMOJIS.filter((e) => NEG.test(e.name)).map((e) => e.name).join(','));
  // 涵盖主要语义
  for (const kw of ['赞', '偷笑', '可爱', '爱心', '惊讶']) {
    check(`清单含「${kw}」语义`, REACTION_EMOJIS.some((e) => e.name.includes(kw) || e.use.includes(kw)));
  }
  const menu = emojiMenuText();
  check('菜单文本含 id=名字（用途）格式', /^\d+=[^（]+（.+）/.test(menu), menu.slice(0, 60));
  check('菜单文本覆盖全部条目', REACTION_EMOJIS.every((e) => menu.includes(String(e.id))));
}

console.log('\n── 表情 id 校验（防模型凭印象编）──');
{
  // 拿真实目录当白名单
  const catalogPath = 'C:/SnowLuma/data/sys-face-catalog.json';
  let ids = null;
  if (fs.existsSync(catalogPath)) {
    const j = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    ids = new Set();
    for (const p of j.packs ?? []) for (const e of p.emojis ?? []) if (e?.qSid != null) ids.add(String(e.qSid));
    console.log(`   （用真实表情目录校验，共 ${ids.size} 个 id）`);
  } else {
    console.log('   （未找到表情目录，跳过白名单校验）');
  }

  check('合法 id 通过', validateEmojiId('76', ids).ok === true);
  check('推荐清单里的 id 全部通过', REACTION_EMOJIS.every((e) => validateEmojiId(String(e.id), ids).ok), REACTION_EMOJIS.filter((e) => !validateEmojiId(String(e.id), ids).ok).map((e) => e.id).join(','));
  check('空 id 被拒', validateEmojiId('', ids).ok === false);
  check('空 id 给出原因', /不能为空/.test(validateEmojiId('', ids).reason));
  check('非数字短串被拒', validateEmojiId('abc', ids).ok === false, validateEmojiId('abc', ids).reason);
  check('纯文字被拒且提示格式', /格式/.test(validateEmojiId('赞', ids).reason), validateEmojiId('赞', ids).reason);
  if (ids) {
    check('目录里不存在的 id 被拒', validateEmojiId('99999', ids).ok === false, validateEmojiId('99999', ids).reason);
    check('被拒时给出可用示例', /可用示例/.test(validateEmojiId('99999', ids).hint), validateEmojiId('99999', ids).hint);
    check('不带白名单时只做格式校验（99999 通过）', validateEmojiId('99999', null).ok === true);
  }
  // unicode 表情（长度 >= 4 的非数字）允许通过——SnowLuma 用 length>3 判定为 unicode
  check('unicode 表情允许', validateEmojiId('👍', ids).ok === true);
  check('null 不抛', validateEmojiId(null, ids).ok === false);
  check('undefined 不抛', validateEmojiId(undefined, ids).ok === false);
}

console.log('\n── 限流（防模型连贴）──');
{
  let t = 1_000_000;
  const gate = createReactionGate({ cooldownMs: 60_000, maxPerHour: 3, now: () => t });
  check('首次允许', gate.check('group:1').allow === true);
  t += 1000;
  const second = gate.check('group:1');
  check('1 秒后再贴被拒', second.allow === false);
  check('拒绝时说明还需多久', /秒后/.test(second.reason), second.reason);
  check('别的会话不受影响', gate.check('group:2').allow === true);
  t += 60_000;
  check('冷却过后可再贴', gate.check('group:1').allow === true);
  // 每小时上限
  t += 60_000;
  check('第 3 次仍允许（上限 3）', gate.check('group:1').allow === true);
  t += 60_000;
  const capped = gate.check('group:1');
  check('第 4 次被小时上限拦下', capped.allow === false && /每小时/.test(capped.reason), capped.reason);
  // 时间戳 0 的边界
  let t2 = 0;
  const g2 = createReactionGate({ cooldownMs: 1000, maxPerHour: 5, now: () => t2 });
  check('时间戳 0 时首次允许', g2.check('k').allow === true);
  t2 = 1001;
  check('时间戳 0 起步也能正常冷却', g2.check('k').allow === true);
  // reset
  const g3 = createReactionGate({ cooldownMs: 100000, now: () => 0 });
  g3.check('k');
  check('reset 后可立即再贴', (g3.reset('k'), g3.check('k').allow === true));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
