// 回归测试：回复时按概率 @ 发出消息的人（auto-at.js）。
//
// 需求（2026-10-20）：「让它回复的时候有概率@发出消息的人」。
//
// 为什么放桥接而不是让模型传 atUserId：`qq_send_message` 早就支持 atUserId，
// 但 30 天里 4174 次调用中带 @ 的极少——模型认为群里大多数对话不需要 @，
// 于是默认省略。而"偶尔点个名"属于发送外观，交给桥接掷骰更稳定。
//
// 本测试盯住四件事：
//   ① @ 的目标必须**准确**（引用谁就 @ 谁；否则 @ 最近一条他人消息），绝不乱 @；
//   ② 概率、冷却、每小时上限都生效；
//   ③ 该排除的都排除（私聊 / 已有 atUserId / 自言自语 / 无目标 / @ 自己）；
//   ④ 桥接接线正确（sendMessagesV2 真的用了判定结果，且只挂在第一条）。
import {
  DEFAULT_AUTO_AT,
  atTargetOf,
  isAddressedToBot,
  isPokeMessage,
  looksLikeSelfTalk,
  pickAutoAt,
  pickUnreadTarget,
  shouldAutoAt,
  textOverlap,
  textGrams
} from '../src/auto-at.js';
import { readConsoleSource } from './lib/console-src.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const T = 1_700_000_000_000;
// 默认关掉「最后一条且新鲜就不 @」的门槛（staleAfterMs: 0 = 不启用该规则），
// 这样第 3 节的老用例仍然专注测"选谁"。该规则本身在 3b4 里单独测（显式开回 1 小时）。
// windowMs 也关掉：老用例的时间戳是「相对 now 的几秒前」，与新规则的 1 小时门槛
// 放在一起会互相干扰。这一组只测"选谁、掷骰、限流"，时间相关规则在 3b4 单独测。
const cfg = { ...DEFAULT_AUTO_AT, probability: 1, cooldownMs: 0, maxPerHour: 0, staleAfterMs: 0, windowMs: 0 };
const base = (over = {}) => ({
  kind: 'group',
  atUserId: null,
  quoted: null,
  recentMessages: [],
  replyText: '在的',
  lastAutoAt: 0,
  autoAtTimes: [],
  config: cfg,
  random: () => 0,   // 0 < probability → 必中
  now: T,
  ...over
});

console.log('── 1. atTargetOf：只认合法 QQ 号 ──');
{
  check('正常 userId 通过', atTargetOf({ userId: '100002027' }) === '100002027');
  check('数字 userId 通过', atTargetOf({ userId: 100002027 }) === '100002027');
  check('isSelf 排除', atTargetOf({ userId: '100002027', isSelf: true }) === null);
  check('null 排除', atTargetOf({ userId: null }) === null);
  check('空串排除', atTargetOf({ userId: '' }) === null);
  check('非数字排除', atTargetOf({ userId: 'abc' }) === null);
  check('0 排除', atTargetOf({ userId: '0' }) === null);
  check('all 排除', atTargetOf({ userId: 'all' }) === null);
  check('太短的号排除（低于 5 位，防误把序号当 QQ）', atTargetOf({ userId: '123' }) === null);
  check('undefined 消息排除', atTargetOf(undefined) === null);
}

console.log('\n── 2. 情绪/收尾类句子不 @ 人 ──');
{
  check('"哈哈哈" 判为自言自语', looksLikeSelfTalk('哈哈哈哈'));
  check('"睡了" 判为自言自语', looksLikeSelfTalk('睡了睡了'));
  check('"晚安" 结尾判为自言自语', looksLikeSelfTalk('那晚安~'));
  check('正常回复不判为自言自语', !looksLikeSelfTalk('在的原神的图我找找'));
  check('问句不判为自言自语', !looksLikeSelfTalk('你说的是哪个角色呀'));
}

console.log('\n── 3. 目标选择：引用优先，其次最近他人消息 ──');
{
  const r1 = pickAutoAt(base({
    quoted: { userId: '100002027', sender: '群友N' },
    recentMessages: [{ sender: '别人', userId: '100002000', time: T - 1000 }]
  }));
  check('有引用时 @ 被引用消息的作者', r1.userId === '100002027', JSON.stringify(r1));
  check('来源标记为 quoted', r1.reason === 'hit:quoted');

  const r2 = pickAutoAt(base({
    quoted: null,
    recentMessages: [
      // 时间调成 2 小时前：本用例测"选谁"，需跨过 staleAfterMs(1h) 才会 @
      { sender: '甲', userId: '1111111111', time: T - 7300000 },
      { sender: '乙', userId: '2222222222', time: T - 7200000 }
    ]
  }));
  check('无引用时 @ 最近一条他人消息', r2.userId === '2222222222', JSON.stringify(r2));
  check('来源标记为 recent', r2.reason === 'hit:recent');

  const r3 = pickAutoAt(base({
    recentMessages: [
      { sender: '我', userId: '9999999999', isSelf: true, time: T - 7199000 },
      { sender: '甲', userId: '1111111111', time: T - 2000 }
    ]
  }));
  check('跳过机器人自己的消息', r3.userId === '1111111111', JSON.stringify(r3));
}

console.log('\n── 3b. 未读优先于最近消息（"谁在叫我"更准）──');
{
  // 未读里只有一条、且回复内容对得上 → 选中它
  const r = pickAutoAt(base({
    quoted: null,
    replyText: '原神的图我找找',
    unreadMessages: [
      { sender: '叫我的人', userId: '3333333333', seq: 10, time: T - 7200000, plain: '有没有原神的图' },
      { sender: '机器人', userId: '9999999999', isSelf: true, seq: 11 }
    ],
    recentMessages: [
      { sender: '更早聊完的人', userId: '4444444444', time: T - 4000 },
      { sender: '机器人', userId: '9999999999', isSelf: true, time: T - 500 }
    ]
  }));
  check('有未读时 @ 未读作者，而不是 recentMessages 里的旧人',
    r.userId === '3333333333', JSON.stringify(r));
  check('来源标记为 unread-match（按内容匹配）', r.reason === 'hit:unread-match', String(r.reason));
}

console.log('\n── 3b2. 按内容选人：中间插话的人不该被 @（2026-10-20 真实事故）──');
{
  // 真实时间线：记者连发三条讲"开会/没看完"，编辑插了一句"我是153"，
  // 机器人回"这个点还没看完就别硬看了，明天顶着困去开会更亏"。
  // 旧逻辑取"未读里最后一条他人消息"→ @ 了编辑（群里立刻有人说"@错人了吧"）。
  const unread = [
    { sender: '群友Y4', userId: '100002012', plain: '今天到现在才用20%', time: T - 13000 },
    { sender: '群友Y4', userId: '100002012', plain: '明天开会的东西还没看完', time: T - 12000 },
    { sender: '群友Y4', userId: '100002012', plain: '他妈的', time: T - 11000 },
    { sender: '群友Y1', userId: '100002028', plain: '我是153', time: T - 2000 }
  ];
  const r = pickAutoAt(base({
    replyText: '这个点还没看完就别硬看了，明天顶着困去开会更亏',
    unreadMessages: unread
  }));
  check('插话者不该被 @，应 @ 真正在对话的人',
    r.userId === '100002012', `${r.userId} (${r.reason})`);
  check('理由标记为内容匹配', r.reason === 'hit:unread-match', String(r.reason));

  // 同一个人在未读里发了多条 → 合并比较（只看最后一句会丢掉关键信息）
  const r2 = pickAutoAt(base({
    replyText: '开会的东西还没看完就别硬看了',
    unreadMessages: [
      { sender: 'A', userId: '1111111111', plain: '明天开会的东西还没看完', time: T - 5000 },
      { sender: 'B', userId: '2222222222', plain: '哈哈哈哈', time: T - 1000 }
    ]
  }));
  check('多条消息按人合并比较', r2.userId === '1111111111', `${r2.userId}`);

  // 谁都不沾 → 不 @（旧逻辑会硬 @ 最后一条）
  const r3 = pickAutoAt(base({
    replyText: '今天天气不错啊',
    unreadMessages: [
      { sender: 'A', userId: '1111111111', plain: '我的显卡烧了', time: T - 5000 },
      { sender: 'B', userId: '2222222222', plain: '明天去钓鱼', time: T - 1000 }
    ]
  }));
  check('回复与所有未读都不沾时不 @（宁可漏也别乱指人）', r3.userId === null, JSON.stringify(r3));
}

console.log('\n── 3b4. 只在需要指明对象时才 @（回最后一条且新鲜就不 @）──');
{
  // 用户 2026-10-20 要求：「只在回复的消息不在当前会话中的最后一条时，
  // 或者要回复的是最后一条但距现在超过 1 小时时才 @；最后一条且时间相近直接发即可」。
  // 道理：@ 的唯一作用是指明在跟谁说话，回刚才那句谁都知道，@ 是噪音。

  // 本组用例测的是新规则本身，显式开回 1 小时门槛
  const cfgStale = { ...cfg, staleAfterMs: 60 * 60 * 1000 };

  // ① 回最后一条、30 秒前 → 不 @
  const fresh = pickAutoAt(base({
    config: cfgStale,
    unreadMessages: [{ sender: 'A', userId: '1111111111', plain: '原神的图有吗', time: T - 30000 }],
    recentMessages: [{ sender: 'A', userId: '1111111111', plain: '原神的图有吗', time: T - 30000 }],
    replyText: '原神的图我找找'
  }));
  check('回最后一条且时间相近 → 不 @', fresh.userId === null, JSON.stringify(fresh));
  check('跳过原因标明是"最后一条且新鲜"', fresh.reason === 'skip:last-and-fresh', String(fresh.reason));

  // ② 回最后一条、但已过 2 小时 → 要 @
  const stale = pickAutoAt(base({
    config: cfgStale,
    unreadMessages: [{ sender: 'A', userId: '1111111111', plain: '原神的图有吗', time: T - 2 * 3600000 }],
    recentMessages: [{ sender: 'A', userId: '1111111111', plain: '原神的图有吗', time: T - 2 * 3600000 }],
    replyText: '原神的图我找找'
  }));
  check('回最后一条但已过 2 小时 → 要 @', stale.userId === '1111111111', JSON.stringify(stale));

  // ③ 目标不是最后一条（中间有人插话）→ 要 @
  const notLast = pickAutoAt(base({
    config: cfgStale,
    unreadMessages: [
      { sender: 'A', userId: '1111111111', plain: '明天开会的东西还没看完', time: T - 60000 },
      { sender: 'B', userId: '2222222222', plain: '我是153', time: T - 1000 }
    ],
    recentMessages: [
      { sender: 'A', userId: '1111111111', plain: '明天开会的东西还没看完', time: T - 60000 },
      { sender: 'B', userId: '2222222222', plain: '我是153', time: T - 1000 }
    ],
    replyText: '开会的东西还没看完就别硬看了'
  }));
  check('回更早的那条（后面有人插话）→ 要 @', notLast.userId === '1111111111', JSON.stringify(notLast));

  // ④ 直接测 shouldAutoAt 的三种结论
  const S = (o) => shouldAutoAt({ cfg: { ...DEFAULT_AUTO_AT }, now: T, ...o });
  check('shouldAutoAt：最后一条+新鲜 → 不需要',
    S({ target: '1111111111', targetAt: T - 30000, recentMessages: [{ userId: '1111111111', time: T - 30000 }] }).needed === false);
  check('shouldAutoAt：最后一条+超 1 小时 → 需要',
    S({ target: '1111111111', targetAt: T - 7200000, recentMessages: [{ userId: '1111111111', time: T - 7200000 }] }).needed === true);
  check('shouldAutoAt：非最后一条 → 需要',
    S({ target: '1111111111', targetAt: T - 60000, recentMessages: [{ userId: '1111111111', time: T - 60000 }, { userId: '2222222222', time: T - 1000 }] }).needed === true);
  check('shouldAutoAt：拿不到时间 → 倾向需要（信息不足时点名更安全）',
    S({ target: '1111111111', targetAt: 0, recentMessages: [{ userId: '1111111111' }] }).needed === true);
  check('门槛默认 1 小时', DEFAULT_AUTO_AT.staleAfterMs === 60 * 60 * 1000, String(DEFAULT_AUTO_AT.staleAfterMs));
}

console.log('\n── 3b5. 重合度算法 ──');
{
  const ov = (a, b) => textOverlap(a, b);
  check('完全无关 → 0', ov('我是153', '明天开会的东西还没看完') === 0);
  check('明显相关 → 正数', ov('开会的东西还没看完', '明天开会的东西还没看完') > 0.3);
  check('中文 2-gram 能切出词组', textGrams('明天开会').has('明天') && textGrams('明天开会').has('开会'));
  check('单字不参与（避免过度匹配）', textGrams('我').size === 0);
  check('英文单词参与', [...textGrams('use Docker now')].some((g) => g === 'w:docker'));
  check('虚词组合被过滤', ![...textGrams('的是了也')].includes('的是'));
  check('空文本 → 0', ov('', '随便') === 0 && ov('随便', '') === 0);
  check('同分时取最近说话的人', (() => {
    const u = [
      { sender: 'A', userId: '1111111111', plain: '原神好玩', time: T - 9000 },
      { sender: 'B', userId: '2222222222', plain: '原神好玩', time: T - 1000 }
    ];
    return pickUnreadTarget(u, '原神好玩')?.userId === '2222222222';
  })());
  check('纯图片未读退回"最近说话的人"', (() => {
    const u = [
      { sender: 'A', userId: '1111111111', plain: '', time: T - 9000 },
      { sender: 'B', userId: '2222222222', plain: '', time: T - 1000 }
    ];
    const r = pickUnreadTarget(u, '什么都行');
    return r?.userId === '2222222222' && r.reason === 'hit:unread-recent';
  })());
}


{
  // 未读里只有拍一拍 → 不 @ 拍的人（与 findCallersV2 一致：拍一拍不算叫你）。
  // **且不再退回 recent**：未读里"有人"但都不沾，说明这次没有明确的回应对象，
  // 宁可这次不 @——2026-10-21 的 @ 错人事故正是因为退回 recent 而 @ 了不相干的人。
  const r = pickAutoAt(base({
    unreadMessages: [{ sender: '拍我的人', userId: '5555555555', text: '[拍一拍] 拍了拍你', time: T - 7200000 }],
    recentMessages: [{ sender: '真说话的人', userId: '6666666666', time: T - 7200000 }]
  }));
  check('未读只有拍一拍时不 @（不退回 recent）', r.userId === null, JSON.stringify(r));
  check('原因标记为 no-match', r.reason === 'no-match', r.reason);
}

{
  // 引用 > 未读（引用是最强信号）
  const r = pickAutoAt(base({
    quoted: { userId: '7777777777', sender: '被引用的人' },
    unreadMessages: [{ sender: '未读里的人', userId: '3333333333', time: T - 7200000 }]
  }));
  check('引用优先于未读', r.userId === '7777777777', JSON.stringify(r));
  check('来源标记为 quoted', r.reason === 'hit:quoted');
}

{
  // 未读没有时间戳也不该被拦（它还没被处理，与新旧无关）
  const r = pickAutoAt(base({
    unreadMessages: [{ sender: '旧但未读', userId: '8888888888', time: T - 2 * 3600 * 1000 }]
  }));
  check('未读不受时间窗限制（两小时前的未读仍然 @）', r.userId === '8888888888', JSON.stringify(r));
}

console.log('\n── 4. 该排除的都排除 ──');{
  check('私聊不 @', pickAutoAt(base({ kind: 'private', recentMessages: [{ userId: '1111111111', time: T }] })).userId === null);
  check('模型已传 atUserId 时不叠加',
    pickAutoAt(base({ atUserId: '2222222222', recentMessages: [{ userId: '1111111111', time: T }] })).reason === 'already-at');
  check('总开关关闭时不动',
    pickAutoAt(base({ config: { ...cfg, enabled: false }, recentMessages: [{ userId: '1111111111', time: T }] })).reason === 'disabled');
  check('自言自语时不 @',
    pickAutoAt(base({ replyText: '哈哈哈', recentMessages: [{ userId: '1111111111', time: T }] })).reason === 'self-talk');
  check('没有可 @ 的目标时返回 no-target',
    pickAutoAt(base({ recentMessages: [] })).reason === 'no-target');
  check('最近消息超出时间窗就不 @',
    pickAutoAt(base({
      // 本用例专测 windowMs，要用默认配置（上面的 cfg 把 windowMs 关了）
      config: { ...cfg, windowMs: DEFAULT_AUTO_AT.windowMs },
      recentMessages: [{ userId: '1111111111', time: T - 30 * 60 * 1000 }]
    })).reason === 'no-target');
  check('时间窗默认 10 分钟（实测群聊间隔 2~6 分钟很常见）', DEFAULT_AUTO_AT.windowMs === 10 * 60 * 1000);
  check('时间戳缺失（0）时不因窗口被拒',
    pickAutoAt(base({ recentMessages: [{ userId: '1111111111', time: 0 }] })).userId === '1111111111');
}

console.log('\n── 5. 概率 / 冷却 / 每小时上限 ──');
{
  // 用真实默认概率 0.3 测掷骰（上面 base 里 probability=1 是"必中"用于验证目标选择）
  // 时间设在 2 小时前：跨过 staleAfterMs(1h) 门槛，否则会先被
  // 「最后一条且新鲜就不 @」拦掉，测不到掷骰本身。
  const oldTs = T - 2 * 3600000;
  const miss = pickAutoAt(base({
    random: () => 0.99,
    // windowMs 放宽：这条消息是 2 小时前的，默认 10 分钟窗口会把它挡掉
    config: { ...DEFAULT_AUTO_AT, windowMs: 6 * 3600000 },
    recentMessages: [{ userId: '1111111111', time: oldTs }]
  }));
  check('掷骰未中就不 @', miss.reason === 'roll-miss', JSON.stringify(miss));
  const hit = pickAutoAt(base({
    random: () => 0.1,
    config: { ...DEFAULT_AUTO_AT, windowMs: 6 * 3600000 },
    recentMessages: [{ userId: '1111111111', time: oldTs }]
  }));
  check('掷骰命中就 @（0.1 < 0.3）', hit.userId === '1111111111', JSON.stringify(hit));
  check('默认概率为 0.3', DEFAULT_AUTO_AT.probability === 0.3);

  const cool = pickAutoAt(base({ lastAutoAt: T - 60 * 1000, config: { ...cfg, cooldownMs: 5 * 60 * 1000 }, recentMessages: [{ userId: '1111111111', time: T }] }));
  check('冷却期内不 @', cool.reason === 'cooldown');

  const capTimes = Array.from({ length: 10 }, (_, i) => T - i * 1000);
  const cap = pickAutoAt(base({ autoAtTimes: capTimes, config: { ...cfg, maxPerHour: 10 }, recentMessages: [{ userId: '1111111111', time: T }] }));
  check('达到每小时上限后不 @', cap.reason === 'hourly-cap');

  const old = [T - 2 * 3600 * 1000, T - 3 * 3600 * 1000];
  const capped = pickAutoAt(base({ autoAtTimes: old, config: { ...cfg, maxPerHour: 10 }, recentMessages: [{ userId: '1111111111', time: T }] }));
  check('一小时以前的记录不计入上限', capped.userId === '1111111111');
}

console.log('\n── 6. 掷骰在"确认有目标"之后 ──');
{
  let called = 0;
  pickAutoAt(base({
    recentMessages: [],
    random: () => { called++; return 0; }
  }));
  check('没有目标时不消耗随机数（避免日志噪声）', called === 0, `called=${called}`);
}

console.log('\n── 7. 桥接接线 ──');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  const socialSrc = fs.readFileSync(path.join(root, 'src/social-engine.js'), 'utf8');
  const consoleServer = readConsoleSource();

  const qqSendSrc = fs.readFileSync(path.join(root, 'src/pipeline/qq-send.js'), 'utf8');
  check('bridge 引入 pickAutoAt', /from '\.\/auto-at\.js'/.test(src) && /pickAutoAt/.test(src));
  check('sendMessagesV2 使用 autoAt 判定', /planAutoAtV2\(key, kind, messages, atUserId, options\.quoted\)/.test(qqSendSrc));
  check('@ 只挂在第一条', /i === 0 \? \(atUserId \?\? autoAt\?\.userId \?\? null\) : null/.test(qqSendSrc));

  // 「@ 之后和正文之间要有一个空格」（2026-10-20 用户反馈）。
  // @ 是**独立消息段**，不是文本的一部分；不补分隔时 QQ 会把「@某人」和正文首字
  // 贴在一起显示成「@小明你好」，读起来别扭，还容易误以为后面那串是名字的一部分。
  check('@ 后有分隔空格', /segments\.push\(\{ type: 'text', data: \{ text: ' ' \} \}\)/.test(src));
  check('只在确实有 @ 时才补空格（普通消息不加前导空格）',
    /if \(segments\.some\(\(s\) => s\.type === 'at'\)\) \{[\s\S]{0,200}text: ' '/.test(src));
  check('正文已以空白开头时不重复补（含换行）',
    /const lead = \/\^\[[^\]]*\\t[^\]]*\\r\\n[^\]]*\]\/\.test\(rawMessage\)/.test(src)
    && /if \(!lead\)/.test(src));
  // 表情/图片路径（at + image，无文字）不需要空格——确认没有误加
  check('表情路径不补空格（at 后直接是图片）',
    !/segments\.push\(\{ type: 'image', data: \{ file: url \} \}\);[\s\S]{0,100}text: ' '/.test(src));

  // 「回同一个人多条 → 只在第一条 @」（用户 2026-10-20 要求）。
  // 单次调用内部已由 `i === 0` 保证；但模型常**分多次调用**（实测 17:55:43 /
  // 17:55:56 / 17:56:09 三次单条），每次都会独立掷骰 → 同一个人可能连被 @ 两三次。
  // 所以再加一层「本回合已 @ 过就不再 @」。
  check('有"本回合已 @ 过"标记', /autoAtTurnDone/.test(src));
  check('判定时用显式 turnId 对齐回合边界',
    /currentTurn\?\.turnId/.test(src) && /lastAutoAtTurn > 0/.test(src));
  check('无回合标记时用 90 秒窗口兜底', /now - lastAutoAtTurn < 90 \* 1000/.test(src));
  check('成功 @ 后按 turnId 写入回合标记', /autoAtTurnDone\.set\(turnId \|\| sid, now\)/.test(src));
  check('标记表有界（防长期运行无限增长）', /autoAtTurnDone\.size > 500/.test(src));
  check('有了 planAutoAtV2 实现', /function planAutoAtV2/.test(src));
  check('记录了自动 @ 额度', /st\.autoAtTimes = \[\.\.\.times, now\]/.test(src));
  check('配置默认值含 autoAt', /autoAt: \{ \.\.\.DEFAULT_AUTO_AT \}/.test(src));
  check('两个发送端点都传了 quoted', (consoleServer.match(/quoted: quotedInfo \}/g) || []).length >= 2);

  // 持久化：saveSocialV2State 是**白名单式**序列化，新字段不显式列出就会丢
  // （实测踩到：赋值了但文件里始终没有 → 冷却与每小时上限每次重启清零）。
  
  

  // 配置热更新归一化（控制台可能传字符串/负数）
  check('autoAt 配置有归一化（概率 clamp 到 0~1）', /body\.send\.autoAt/.test(consoleServer) && /Math\.min\(1, Math\.max\(0, prob\)\)/.test(consoleServer));
  check('autoAt 的毫秒/次数字段做非负取整', /for \(const k of \['windowMs', 'cooldownMs', 'maxPerHour'\]\)/.test(consoleServer));
}

console.log('\n── 8. @ 错人事故回放（2026-10-21 group:100002015）──');
{
  // 真实时间线：
  //   12:33:31 翩翩老公：所以大肥鱼究竟是真人还是AI？
  //   12:33:49 翩翩老公：[拍一拍] 戳了戳 你
  //   12:34:41 永夜雨：[引用 翩翩老公：…] ai啊
  //   12:35:41 Lu-mi-nous：@大肥鱼 你用了多少token      ← 真正在问的人
  //   12:36:08 机器人：喏，图来了                        ← 却 @ 了翩翩老公
  // 根因：回复与提问零字面重合 → pickUnreadTarget 返回 null → **兜底退回"最近说话的人"**。
  const ALIAS = ['dsh', '大肥鱼', '大肥鱼装AI', '小鲸鱼'];
  const unread = [
    { sender: 'SWT丶落雪', userId: '195849440', text: '流窜ai太屌了', time: T - 400000 },
    { sender: '刹那は夢のようだ', userId: '3170551499', text: '那我陪你聊', time: T - 380000 },
    { sender: '刹那は夢のようだ', userId: '3170551499', text: '[拍一拍] 刹那は夢のようだ 戳了戳 你', time: T - 375000 },
    { sender: '刹那は夢のようだ', userId: '3170551499', text: '好', time: T - 330000 },
    { sender: '翩翩老公', userId: '2191989525', text: '所以大肥鱼究竟是真人还是AI？', time: T - 160000 },
    { sender: '翩翩老公', userId: '2191989525', text: '[拍一拍] 翩翩老公 戳了戳 你', time: T - 140000 },
    { sender: '永夜雨', userId: '3031518332', text: '[引用 翩翩老公：所以大肥鱼究竟是真人还是AI？]ai啊', time: T - 90000 },
    { sender: 'Lu-mi-nous', userId: '100002000', text: '@大肥鱼 你用了多少token', time: T - 60000 }
  ];
  const recent = [...unread];

  const r = pickAutoAt(base({
    unreadMessages: unread,
    recentMessages: recent,
    aliasNames: ALIAS,
    replyText: '喏，图来了',
    config: { ...cfg, staleAfterMs: 0 }   // 关掉"最后一条太新就不@"，专测选人
  }));
  check('@ 的是提问者 Lu-mi-nous', r.userId === '100002000', JSON.stringify(r));
  check('不是翩翩老公（事故里的人）', r.userId !== '2191989525');
  check('来源是"明确在叫它"', r.reason === 'hit:unread-addressed', r.reason);

  // 短回应 + 无人 @ 它 → 谁都不沾，这次就不 @（旧逻辑会乱指一个人）
  const r2 = pickAutoAt(base({
    unreadMessages: [
      { sender: '甲', userId: '1111111111', text: '今天天气不错', time: T - 30000 },
      { sender: '乙', userId: '2222222222', text: '是啊挺暖和的', time: T - 20000 }
    ],
    recentMessages: [
      { sender: '甲', userId: '1111111111', text: '今天天气不错', time: T - 30000 },
      { sender: '乙', userId: '2222222222', text: '是啊挺暖和的', time: T - 20000 }
    ],
    aliasNames: ALIAS,
    replyText: '哈',
    config: { ...cfg, staleAfterMs: 0 }
  }));
  check('无人叫它 + 内容不沾 → 不 @（宁可不动也不乱指）', r2.userId === null, JSON.stringify(r2));
  check('原因 no-match', r2.reason === 'no-match', r2.reason);
}

console.log('\n── 9. isAddressedToBot 判据 ──');
{
  check('@角色名 命中', isAddressedToBot({ sender: 'x', text: '@大肥鱼 你好' }, ['大肥鱼']));
  check('@群昵称 命中', isAddressedToBot({ sender: 'x', text: '@dsh 在吗' }, ['dsh']));
  check('引用机器人 命中', isAddressedToBot({ sender: 'x', text: '随便说说', quoteTargetIsSelf: true }, []));
  check('只是提到名字不命中（没有 @）', !isAddressedToBot({ sender: 'x', text: '大肥鱼真可爱' }, ['大肥鱼']));
  check('无关内容不命中', !isAddressedToBot({ sender: 'x', text: '今天吃什么' }, ['大肥鱼']));
  check('机器人自己的消息不算', !isAddressedToBot({ sender: '我', isSelf: true, text: '@大肥鱼' }, ['大肥鱼']));
  check('@别人不命中', !isAddressedToBot({ sender: 'x', text: '@翩翩老公 看了五集' }, ['大肥鱼', 'dsh']));
}

console.log('\n── 10. 第三次 @ 错人事故回放（2026-10-21 group:100002005）──');
{
  // 真实时间线：
  //   13:08:18 不会忘本：「[引用 大肥鱼装AI…]@大肥鱼装AI 因为肥嘟嘟」   ← 4 分钟前的 @
  //   13:09:05/13:09:28 不会忘本：😔 / [拍一拍]
  //   13:11:41 群友E：「[拍一拍] 群友E 戳了戳 你」                      ← 只是戳了一下
  //   13:11:42 群友F：「那你怎么漏的」                        ← 真正在问的人
  //   13:12:13 不会忘本：「[图片]」                                    ← 纯图片
  //   13:12:16 机器人：「漏的是空气，别乱想」→ 却 @ 了「群友E」
  // 两个根因：
  //   a) 拍一拍被当成"在叫它"（拍一拍没有说话，不可能是回复对象）
  //   b) 一个人 4 分钟前 @ 过它，就被当成"正在叫它"（应只看最近一条实质消息 + 时效）
  const ALIAS = ['dsh', '大肥鱼', '大肥鱼装AI', '小鲸鱼'];
  const T0 = 1792588200000; // 对应 13:12:16 附近
  const unread = [
    { sender: '不会忘本', userId: '3776322488', text: '[拍一拍] 不会忘本 戳了戳 你', time: T0 - 253000, kind: 'poke', poke: { targetIsSelf: true } },
    { sender: '不会忘本', userId: '3776322488', text: '[引用 大肥鱼装AI：我又不是面团]@大肥鱼装AI 因为肥嘟嘟', time: T0 - 238000, quoteTargetIsSelf: false },
    { sender: '群友F', userId: '3187296089', text: '要漏小鱼仔了', time: T0 - 89000 },
    { sender: '群友E', userId: '2731029763', text: '[拍一拍] 群友E 戳了戳 你', time: T0 - 35000, kind: 'poke', poke: { targetIsSelf: true } },
    { sender: '群友F', userId: '3187296089', text: '那你怎么漏的', time: T0 - 34000 },
    { sender: '景', userId: '1257872986', text: '[图片]', time: T0 - 23000 },
    { sender: '有些话记得早点说', userId: '3255298949', text: '[图片]', time: T0 - 4000 },
    { sender: '不会忘本', userId: '3776322488', text: '[图片]', time: T0 - 3000 }
  ];
  const r = pickAutoAt(base({
    unreadMessages: unread,
    recentMessages: unread,
    aliasNames: ALIAS,
    replyText: '漏的是空气，别乱想',
    now: T0,
    config: { ...cfg, staleAfterMs: 0 }
  }));
  check('@ 的是提问者 群友F', r.userId === '3187296089', JSON.stringify(r));
  check('不是只戳过它的「群友E」', r.userId !== '2731029763');
  check('不是 4 分钟前 @ 过它的「不会忘本」', r.userId !== '3776322488');

  // 单纯戳一下（没有任何文字）不能成为 @ 目标
  const onlyPoke = pickAutoAt(base({
    unreadMessages: [{ sender: '甲', userId: '1111111111', text: '[拍一拍] 甲 戳了戳 你', kind: 'poke', poke: { targetIsSelf: true }, time: T0 - 5000 }],
    recentMessages: [],
    aliasNames: ALIAS,
    replyText: '在的',
    now: T0,
    config: { ...cfg, staleAfterMs: 0 }
  }));
  check('只有拍一拍时不 @（拍没有说话）', onlyPoke.userId === null, JSON.stringify(onlyPoke));
}

console.log('\n── 11. isPokeMessage 判据 ──');
{
  check('结构化 kind=poke 命中', isPokeMessage({ kind: 'poke', text: '任意' }));
  check('poke 对象命中', isPokeMessage({ poke: { targetIsSelf: true }, text: '任意' }));
  check('文本前缀命中', isPokeMessage({ text: '[拍一拍] 某人 戳了戳 你' }));
  check('普通消息不命中', !isPokeMessage({ text: '那你怎么漏的' }));
  check('图片消息不命中', !isPokeMessage({ text: '[图片]' }));
  check('null 安全', !isPokeMessage(null));
}

console.log('\n── 12. @ 信号有时效（话题换了就别再拿旧 @ 当理由）──');
{
  // 5 分钟前的 @（超出 addressedTtlMs 默认 2 分钟）→ 不因它而选人
  const stale = pickAutoAt(base({
    unreadMessages: [
      { sender: '早先叫它的', userId: '1111111111', text: '@大肥鱼 在吗', time: T - 5 * 60 * 1000 }
    ],
    recentMessages: [],
    aliasNames: ['大肥鱼'],
    replyText: '随便说句',
    config: { ...cfg, staleAfterMs: 0 }
  }));
  check('5 分钟前的 @ 不再算"正在叫它"', stale.userId === null, JSON.stringify(stale));

  // 30 秒前的 @ → 有效
  const fresh = pickAutoAt(base({
    unreadMessages: [
      { sender: '刚叫它的', userId: '2222222222', text: '@大肥鱼 在吗', time: T - 30 * 1000 }
    ],
    recentMessages: [],
    aliasNames: ['大肥鱼'],
    replyText: '随便说句',
    config: { ...cfg, staleAfterMs: 0 }
  }));
  check('30 秒前的 @ 仍然有效', fresh.userId === '2222222222', JSON.stringify(fresh));
  check('来源 hit:unread-addressed', fresh.reason === 'hit:unread-addressed', fresh.reason);
  check('默认时效 2 分钟', DEFAULT_AUTO_AT.addressedTtlMs === 2 * 60 * 1000);
}

console.log('\n── 13. 第四次 @ 错人事故回放（2026-10-22 group:100002005）──');
{
  // 真实时间线：
  //   04:13:13 不会忘本：「@大肥鱼装AI 能给我一些比较雷霆的奶龙图片吗？」     ← 提问
  //   04:13:16 群友E：「@大肥鱼装AI 咱是正经鱼 不存这种」
  //   04:13:18 千咲：「正经鱼还立规矩了。」
  //   04:13:29 群友F：「[引用 图片] @大肥鱼装AI 那存这张，遇到不喜欢的就发出来」← 陈述
  //   04:13:50 不会忘本：「[图片]」
  //   04:14:24 不会忘本：「[拍一拍] 戳了戳 你」
  //   04:14:32 机器人：「雷霆的奶龙没有，鱼这儿只有鲸鱼」→ 却 @ 了群友F
  //
  // 根因：两条都 @ 了机器人（都属于 unread-addressed 候选），而旧实现**只取最新的那个**，
  // 于是选了 04:13:29 的群友F。但回复内容「雷霆的奶龙没有」明明在回答 04:13:13 的提问。
  // 修法：候选多于一个时，先按**回复与候选话语的重合度**挑；都沾不上才退回"取最新"。
  const ALIAS = ['dsh', '大肥鱼', '大肥鱼装AI', '小鲸鱼'];
  const T1 = 1792642390000; // 近似 04:14:32
  const unread = [
    { sender: '不会忘本', userId: '3776322488', text: '@大肥鱼装AI 能给我一些比较雷霆的奶龙图片吗？', time: T1 - 80000 },
    { sender: '群友E', userId: '2731029763', text: '@大肥鱼装AI 咱是正经鱼 不存这种', time: T1 - 76000 },
    { sender: '千咲', userId: '3898947389', text: '正经鱼还立规矩了。', time: T1 - 74000 },
    { sender: '群友F', userId: '3187296089', text: '[引用 群友E：[图片]]（被引用的这条消息含 1 个图片/表情）@大肥鱼装AI 那存这张，遇到不喜欢的就发出来', time: T1 - 63000 },
    { sender: '不会忘本', userId: '3776322488', text: '[图片]', time: T1 - 42000 },
    { sender: '不会忘本', userId: '3776322488', text: '[拍一拍] 不会忘本 戳了戳 你', time: T1 - 8000, kind: 'poke', poke: { targetIsSelf: true } }
  ];
  const r = pickAutoAt(base({
    unreadMessages: unread,
    recentMessages: unread,
    aliasNames: ALIAS,
    replyText: '雷霆的奶龙没有，鱼这儿只有鲸鱼',
    now: T1,
    config: { ...cfg, staleAfterMs: 0 }
  }));
  check('@ 的是提问者「不会忘本」', r.userId === '3776322488', JSON.stringify(r));
  check('不是后说话的「群友F」', r.userId !== '3187296089');
  check('来源 hit:unread-addressed', r.reason === 'hit:unread-addressed', r.reason);

  // 内容完全分不出时应保持"取最新"（短回应场景，别把行为改坏）
  const ambiguous = pickAutoAt(base({
    unreadMessages: [
      { sender: '甲', userId: '1111111111', text: '@大肥鱼 好', time: T1 - 60000 },
      { sender: '乙', userId: '2222222222', text: '@大肥鱼 嗯嗯', time: T1 - 10000 }
    ],
    recentMessages: [],
    aliasNames: ALIAS,
    replyText: '睡去了',
    now: T1,
    config: { ...cfg, staleAfterMs: 0 }
  }));
  check('内容分不出时取最新的乙', ambiguous.userId === '2222222222', JSON.stringify(ambiguous));
}

console.log('\n── 14. 第五次 @ 错人事故回放（2026-10-22 group:100002007）──');
{
  // 真实时间线（未读上限 30 条，窗口 seq 39750–39779）：
  //   14:36:17 群友A：「[引用 机器人图片]@?！哦鲸鲸  ? ! 大肥鱼可爱」   ← 只是顺口夸名字
  //   14:38:27 群友B：「@?！哦鲸鲸  ? ! 给我发张百亿鲸元券」                ← 真正点单的人
  //   14:39:00 哥伦比娅：「@?！哦鲸鲸  ? ! 来段小星星」
  //   14:39:21 机器人发「【百亿鲸元券】…给大肥鱼买鱼食…」→ 却 @ 了群友A
  //
  // 两个根因：
  //   a) 机器人群名片是 `?！哦鲸鲸  ? !`，别名表只有账号昵称 `dsh` → 所有 @ 都认不出；
  //   b) 反向覆盖率对 6 个 gram 的短句生效：2/6×0.6=0.20，压过群友B的 4/24=0.1667。
  const CARD = '?！哦鲸鲸  ? !';
  const ALIAS = ['dsh', '大肥鱼', CARD];
  const PRIMARY = ['dsh', '大肥鱼', CARD];
  const T2 = 1792651161300;
  const M = (seq, userId, sender, plain, over = {}) => ({
    seq, userId, sender, plain, text: plain,
    time: T2 - (39780 - seq) * 5000, // 仅用于排序/TTL，相对顺序与真实一致
    ...over
  });
  const unread = [
    M(39750, '100002000', 'Lu-mi-nous', '接的workbuddy所以免费用'),
    M(39751, '100002000', 'Lu-mi-nous', '语音模型网上有现成的'),
    M(39752, '100002000', 'Lu-mi-nous', '直接下载本地推理就行了'),
    M(39753, '1000000004', '群友B', '强强[表情76]'),
    M(39754, '183263360', '夜', '强强[表情76]'),
    M(39755, '3344952470', '哥伦比娅', '强强[表情76]'),
    M(39756, '183263360', '夜', '[图片]'),
    M(39757, '1000000005', '群友A', `@${CARD} 大肥鱼可爱`, { time: T2 - 183406, quoteTargetIsSelf: true }),
    M(39758, '183263360', '夜', '[拍一拍] 夜 戳了戳 你', { kind: 'poke', poke: { targetIsSelf: true } }),
    M(39759, '183263360', '夜', '[图片]'),
    M(39760, '3344952470', '哥伦比娅', '[拍一拍] 哥伦比娅 戳了戳 你', { kind: 'poke', poke: { targetIsSelf: true } }),
    M(39761, '1000000004', '群友B', '[拍一拍] 群友B 戳了戳 你', { kind: 'poke', poke: { targetIsSelf: true } }),
    M(39762, '100002000', 'Lu-mi-nous', `@${CARD} 你算算你一共用的token按deepseek官方谷时价格大概多少钱`),
    M(39763, '3344952470', '哥伦比娅', '[图片]'),
    M(39764, '1000000004', '群友B', '还分白天晚上'),
    M(39765, '1000000004', '群友B', '考虑到电费差别了吗'),
    M(39766, '2677607641', '芙艾尔', '[图片]'),
    M(39767, '1000000004', '群友B', '[拍一拍] 群友B 戳了戳 你', { kind: 'poke', poke: { targetIsSelf: true } }),
    M(39768, '183263360', '夜', '[拍一拍] 夜 戳了戳 你', { kind: 'poke', poke: { targetIsSelf: true } }),
    M(39769, '3344952470', '哥伦比娅', '[拍一拍] 哥伦比娅 戳了戳 你', { kind: 'poke', poke: { targetIsSelf: true } }),
    M(39770, '1000000005', '群友A', '[拍一拍] 群友A 戳了戳 你', { kind: 'poke', poke: { targetIsSelf: true } }),
    M(39771, '100002000', 'Lu-mi-nous', '[拍一拍] Lu-mi-nous 戳了戳 你', { kind: 'poke', poke: { targetIsSelf: true } }),
    M(39772, '1000000004', '群友B', `@${CARD} 给我发张百亿鲸元券`, { time: T2 - 53821, atSelf: true }),
    M(39773, '3533617703', '织月', '[拍一拍] 织月 戳了戳 你', { kind: 'poke', poke: { targetIsSelf: true } }),
    M(39774, '3344952470', '哥伦比娅', `@${CARD} 来段小星星`, { atSelf: true }),
    M(39775, '100002000', 'Lu-mi-nous', '怎么不回了'),
    M(39776, '3344952470', '哥伦比娅', '[图片]'),
    M(39777, '100002000', 'Lu-mi-nous', '[图片]'),
    M(39778, '3344952470', '哥伦比娅', '[图片]'),
    M(39779, '100002000', 'Lu-mi-nous', '反正要是按官方计价大概几千块')
  ];
  const reply = '【百亿鲸元券】面额：10000000000 鲸元 仅限在群里给大肥鱼买鱼食使用，不找零，不可提现';
  const opts = { aliasNames: ALIAS, ignoreNames: PRIMARY, ignoreAtNames: ALIAS };

  // ① 修好后：群名片进别名表 → 群友B是"明确 @ 它"的人，命中 addressed
  const fixed = pickAutoAt(base({
    unreadMessages: unread,
    recentMessages: unread,
    replyText: reply,
    now: T2,
    config: { ...cfg, staleAfterMs: 0 },
    ...opts
  }));
  check('@ 的是点单的群友B', fixed.userId === '1000000004', JSON.stringify(fixed));
  check('不是只顺口说「大肥鱼可爱」的群友A', fixed.userId !== '1000000005');
  check('来源是"明确在叫它"', fixed.reason === 'hit:unread-addressed', fixed.reason);

  // ② 就算别名表仍然缺群名片、消息也没有 atSelf（老状态/重启前入库），
  //    内容匹配也不能再选群友A：短句禁用反向覆盖率 + 剔除机器人名字后，她的重合度归零。
  const legacyUnread = unread.map((m) => ({ ...m, atSelf: undefined }));
  const legacy = pickAutoAt(base({
    unreadMessages: legacyUnread,
    recentMessages: legacyUnread,
    replyText: reply,
    now: T2,
    config: { ...cfg, staleAfterMs: 0 },
    aliasNames: ['dsh', '大肥鱼'],
    ignoreNames: ['dsh', '大肥鱼'],
    ignoreAtNames: ['dsh', '大肥鱼']
  }));
  check('缺群名片时也不再选群友A', legacy.userId !== '1000000005', JSON.stringify(legacy));
  check('退化为内容匹配时仍能选中群友B', legacy.userId === '1000000004', String(legacy.reason));
  check('退化时来源是内容匹配', legacy.reason === 'hit:unread-match', legacy.reason);

  // ③ 入站 at 段判据：完全不给别名也能认出 @ 了它
  check('atSelf 命中（不依赖别名）',
    isAddressedToBot({ atSelf: true, plain: `@${CARD} 给我发张百亿鲸元券` }, []) === true);
  const byAt = pickAutoAt(base({
    unreadMessages: [
      M(39772, '1000000004', '群友B', `@${CARD} 给我发张百亿鲸元券`, { atSelf: true })
    ],
    recentMessages: [],
    replyText: reply,
    now: T2,
    config: { ...cfg, staleAfterMs: 0 },
    aliasNames: [] // 故意不给任何别名
  }));
  check('atSelf 单独就足以选中群友B', byAt.userId === '1000000004', JSON.stringify(byAt));

  // ④ 多句闲话不再稀释精确命中（逐条取最大值）
  const diluted = pickUnreadTarget(unread, reply, { ignoreNames: PRIMARY, ignoreAtNames: ALIAS });
  check('群友B的精确命中不再被 3 句闲话稀释', diluted?.userId === '1000000004', JSON.stringify(diluted));
  check('分数高于旧实现的 0.1667', (diluted?.overlap || 0) > 0.1667, String(diluted?.overlap));

  // ⑤ 短文本禁用反向覆盖率（单独验证算法层）
  check('短句蹭到 2 个 gram 不再被放大',
    textOverlap('给大肥鱼买鱼食使用不找零', '大肥鱼可爱', { ignoreNames: ['大肥鱼'], backwardMinGrams: 8 }) === 0);

  // ⑥ 接线：入站记录 atSelf、按群缓存群名片、别名同源、日志带分数
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  const socialSrc = fs.readFileSync(path.join(root, 'src/social-engine.js'), 'utf8');
  const dispatchSrc = fs.readFileSync(path.join(root, 'src/pipeline/dispatch-incoming.js'), 'utf8');
  check('入站消息记录 atSelf', /atSelf: !!atSelf/.test(socialSrc));
  check('从 OneBot at 段判定 atSelf', /seg\?\.type === 'at' && String\(seg\?\.data\?\.qq\) === String\(event\.self_id\)/.test(dispatchSrc));
  check('按群缓存群名片', /async function ensureSelfCardV2/.test(src) && /selfCardCache/.test(src));
  check('自动@ 与 findCallersV2 共用别名函数',
    /botAliasNamesV2\(key, st\)/.test(src)
    && (src.match(/botAliasNamesV2\(key, st\)/g) || []).length >= 2);
  check('自动@ 传了剔除名字的参数', /ignoreNames: aliasInfo\.primary/.test(src) && /ignoreAtNames: aliasInfo\.all/.test(src));
  check('日志带重合度与命中文本', /重合度=\$\{picked\.overlap\}/.test(src) && /命中="\$\{String\(picked\.matchedText\)/.test(src));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
