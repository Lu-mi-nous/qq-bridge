// 回归测试：表情包主动要求 + 按语气选候选。
//
// 需求（2026-10-22 用户）：「现在依旧极少调用表情包，给出一个解决方案，
// 能够有更多机会并且根据回答语气选择合适表情包」。
//
// ── 实测证据（改动前）─────────────────────────────────────────────
//
//   `state/tool-calls.jsonl` 里 1999 次工具调用，`qq_send_sticker` 只出现 **1 次**。
//   根因不是没提示，而是三条叠加：
//     ① 提示是软建议（"大约每 3~5 轮来一张就够"）——可以不选；
//     ② 发表情要额外一次工具调用、还不能和文字同气泡；
//     ③ 没有外部触发，全靠模型自觉。
//
// ── 解法：桥接掷骰 + 只给 2~3 个候选 ─────────────────────────────
//
//   与自动 @ 同一思路：桥接定"发不发"，模型只从候选里挑"发哪张"。
//   本测试锁住：语气分类、候选多样性、频率上限、提示措辞。
import fs from 'node:fs';
import path from 'node:path';
import { readConsoleSource } from './lib/console-src.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const pickSrc = fs.readFileSync(path.join(root, 'plugins', 'stickers', 'lib', 'sticker-pick.js'), 'utf8');

const wakeSrc = fs.readFileSync(path.join(root, 'src', 'pipeline', 'wake.js'), 'utf8');
const consoleServerSrc = readConsoleSource();
const html = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');

const { MOOD_RULES, moodOfSticker, moodOfText, pickStickerCandidates, buildStickerNudge } =
  await import('../plugins/stickers/lib/sticker-pick.js');

// 构造一组典型表情（对应真实库里的备注格式）
const LIB = [
  { id: 'a', md5: 'MD5_A', desc: '蓝发女仆小鲸鱼无语脸，被吐槽时用', useCount: 10 },
  { id: 'b', md5: 'MD5_B', desc: '鲸鱼娘在米饭里翻滚打滚，搞笑用', useCount: 4 },
  { id: 'c', md5: 'MD5_C', desc: '鲸鱼娘脸红女仆装，害羞用', useCount: 2 },
  { id: 'd', md5: 'MD5_D', desc: '戴狐面具白团子挥手，打招呼用', useCount: 1 },
  { id: 'e', md5: 'MD5_E', desc: '灰发女孩眯眼撇嘴，无语旁观用', useCount: 3 },
  { id: 'f', md5: 'MD5_F', desc: '', useCount: 0 }
];

// ── 1. 语气分类 ──
console.log('── 1. 语气分类 ──');
{
  check('有语气规则表', MOOD_RULES.length >= 6, `${MOOD_RULES.length} 类`);
  check('每条规则有 mood/label/words',
    MOOD_RULES.every((r) => r.mood && r.label && Array.isArray(r.words) && r.words.length));

  // 从备注推断表情的语气
  check('表情"无语脸"归到无语', moodOfSticker(LIB[0]) === 'speechless');
  check('表情"搞笑用"归到搞笑', moodOfSticker(LIB[1]) === 'laugh');
  check('表情"脸红"归到害羞', moodOfSticker(LIB[2]) === 'shy');
  check('表情"挥手"归到打招呼', moodOfSticker(LIB[3]) === 'greet');
  check('无备注的表情不硬猜', moodOfSticker(LIB[5]) === '');

  // 从回复文本判断语气
  check('"哈哈哈哈" → 搞笑', moodOfText('哈哈哈哈笑死我了') === 'laugh');
  check('"行吧，随你" → 无语', moodOfText('行吧，随你') === 'speechless');
  check('"？？" → 疑惑', moodOfText('？？你在说什么') === 'confused');
  check('"晚安" → 打招呼', moodOfText('晚安啦') === 'greet');
  // 这条是修 bug 的断言：「哇你好厉害啊」原来因为含"你好"被分到 greet
  check('"你好厉害" → 得意（不被"你好"抢走）', moodOfText('哇你好厉害啊') === 'proud');
  check('普通陈述不硬判语气', moodOfText('今天天气不错') === '');
}

// ── 2. 候选选择 ──
console.log('\n── 2. 候选选择 ──');
{
  const r1 = pickStickerCandidates(LIB, { replyText: '行吧，随你', max: 3 });
  // 注意：picks[].id 存的是 **md5**（更短，直接能传给工具），不是内部 id。
  // 也不能断言「固定是某张」——候选带随机扰动（否则模型总选第 1 个、永远同一张）。
  // 这里该断言的是「语气对得上」：第 1 个候选必须是无语类（库里的 a 或 e）。
  check('无语语气时第 1 个属于无语类', ['MD5_A', 'MD5_E'].includes(r1.picks[0]?.id), r1.picks[0]?.label);
  check('识别出语气标签', r1.mood === 'speechless' && r1.moodLabel === '无语/被吐槽');

  const r2 = pickStickerCandidates(LIB, { replyText: '哈哈哈哈', max: 3 });
  check('搞笑语气时第 1 个是搞笑表情', r2.picks[0]?.id === 'MD5_B', r2.picks[0]?.label);

  // 多样性：候选不能全是同一语气
  const moods = r1.picks.map((p) => p.mood).filter(Boolean);
  check('候选语气不重复（不会给三张无语脸）', new Set(moods).size === moods.length,
    r1.picks.map((p) => p.mood).join(','));

  // 数量限制
  check('候选数量受限', r1.picks.length <= 3, String(r1.picks.length));
  check('max=1 时只给一个', pickStickerCandidates(LIB, { replyText: '哈哈', max: 1 }).picks.length === 1);

  // 最近发过的要避开
  const r3 = pickStickerCandidates(LIB, { replyText: '行吧', recentIds: ['MD5_A'], max: 1 });
  check('刚发过的表情不再推荐', r3.picks[0]?.id !== 'MD5_A', r3.picks[0]?.label);

  // 轮换：同一语气多次调用，首位不能永远是同一张——
  // 否则模型总选第 1 个，群里就会永远收到同一张表情。
  {
    const heads = new Set();
    for (let i = 0; i < 30; i++) {
      const r = pickStickerCandidates(LIB, { replyText: '行吧，随你', max: 3 });
      heads.add(r.picks[0]?.id);
    }
    check('同一语气的首位会轮换（不是永远同一张）', heads.size >= 2, `${heads.size} 种`);
  }

  // 空库不崩
  check('空表情库返回空候选', pickStickerCandidates([], { replyText: '哈哈' }).picks.length === 0);
  check('全部刚发过时仍能给出候选（不会返回空）',
    pickStickerCandidates(LIB, { recentIds: LIB.map((x) => x.md5), max: 2 }).picks.length > 0);
}

// ── 3. 提示措辞 ──
console.log('\n── 3. 提示措辞 ──');
{
  const c = pickStickerCandidates(LIB, { replyText: '行吧，随你', max: 2 });
  const nudge = buildStickerNudge({ ...c, hint: '对方刚才说的是：「行吧，随你」' });
  check('提示里有"必须发一张"（不是"可以考虑"）', /必须发一张/.test(nudge));
  // 不能固定断言 MD5_A：候选带随机扰动，首位会轮换。
  // 要断言的是"每个候选的 md5 都写进了提示"——这才是省掉 list_stickers 的关键。
  check('给出了具体 md5（省掉 list_stickers）',
    c.picks.every((p) => nudge.includes(`md5=${p.id}`)),
    c.picks.map((p) => p.id).join(','));
  check('强调单独气泡（不能和文字混）', /不能和文字混在同一个气泡/.test(nudge));
  check('允许真的不贴时跳过', /跳过/.test(nudge));
  check('带上对方的原话作为语境', /行吧，随你/.test(nudge));
  check('提醒不要在文字里描述表情', /不要在文字里描述/.test(nudge));
  check('空候选不生成提示', buildStickerNudge({ picks: [] }) === '');
}

// ── 4. 桥接接线 ──
console.log('\n── 4. 桥接接线 ──');
{
  
  
  
  
  
  
  check('命中时用 nudge 替换软提示', /stickerPlan\s*\n?\s*\? `\$\{deps\.buildStickerNudge/.test(wakeSrc)
    || /deps\.buildStickerNudge\(stickerPlan\)/.test(wakeSrc));
  check('命中时写日志（便于区分没掷中 / 模型没发）', /\[表情\] \$\{key\} 本轮要求发一张/.test(wakeSrc));

  // 持久化：存与读都要有，否则重启后频率限制失效
  
  
  
  
  
  

  // 发送成功后更新"真发过"的账
  check('发送成功后记 lastStickerAt', /st\.lastStickerAt = now/.test(consoleServerSrc));
  check('发送成功后记 recentStickers', /st\.recentStickers = \[\.\.\./.test(consoleServerSrc));

  // 配置项与 clamp
  
  
  check('配置保存时 clamp 概率', /merged\.sticker\.autoNudgeProbability = Math\.min\(1, Math\.max\(0/.test(consoleServerSrc));
  check('配置保存时 clamp 候选数', /merged\.sticker\.autoNudgeCandidates = Number\.isFinite\(n\) \? Math\.min\(4, Math\.max\(1/.test(consoleServerSrc));

  // 控制台
  check('控制台有开关', /id="v2StickerAutoNudge"/.test(html));
  check('控制台有概率输入', /id="v2StickerNudgeProb"/.test(html));
  check('控制台有间隔输入', /id="v2StickerNudgeGapSec"/.test(html));
  check('控制台有每小时上限', /id="v2StickerNudgePerHour"/.test(html));
  check('控制台有候选数量', /id="v2StickerNudgeCandidates"/.test(html));
  check('控制台加载时回填', /document\.getElementById\('v2StickerAutoNudge'\)\.checked/.test(html));
  check('控制台保存时提交', /autoNudge: document\.getElementById\('v2StickerAutoNudge'\)\.checked/.test(html));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
