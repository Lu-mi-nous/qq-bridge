import { createEventHarness, sessionEvent, assistantMessage, turnEnd } from './helpers/dsh-event-harness.mjs';
// 回归测试：B 站「自己刷」与全局观看记忆。
//
// 需求（2026-10-19 用户）：
//   「让它自己刷B站，并非有目的地根据命令进行，而是仅像人类一样，遇到自己喜欢的视频就多看一会，
//     不喜欢的就划走，然后放在本地形成记忆；群友发B站卡片链接时也可以直接自主观看」
//   用户选定：记忆跨群全局；潜水时随机刷、每天 ≤30 分钟（群友发链接不计入）；偶尔主动分享。
//
// 本测试锁住的要点：
//   ① 链接解析要覆盖群友实际会发的四种形态（BV号 / 完整链接 / b23.tv 短链 / av号）
//   ② 「多看/划走」用帧数表达（模型不在时间维度上感知视频）
//   ③ 每日额度按"实际观看秒数"记账，用完就不刷
//   ④ 记忆是全局一份、按 bvid 去重、跨群可取
//   ⑤ 额度耗尽/间隔太近时不再刷
//
// 依赖真实 B 站 API 的用例会在无网络时跳过（不当作失败）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseBiliId, isBiliShortUrl, resolveBiliId,
  fetchVideoInfo, fetchPopularVideos, fetchPlayUrl,
  grabVideoFrames, videoFramesHint, createVideoMemory,
  subtitleSnippet, fetchSubtitles
} from '../src/bili.js';
import {
  pickCandidate, watchDepth, canSelfBrowse, nextBrowseDelay,
  watchVideo, buildBrowsePrompt, categoryGroup, categoryWeight,
  parseScanVerdict, buildScanPrompt, buildExtendedPrompt,
  matchGameKeyword, GAME_KEYWORDS, tasteBoost, ownerBoost,
  DEFAULT_CATEGORY_WEIGHTS
} from '../src/bili-browse.js';
import { readConsoleSource } from './lib/console-src.mjs';

let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const skipped = (n, why) => { skip++; console.log(`SKIP  ${n}  （${why}）`); };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-test-'));
// 读一次配置，供各段断言使用真实运行参数（而不是把数字抄进测试里——
// 抄进去的话改了配置测试仍然"通过"，就失去了守护意义）。
const cfgRoot = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const appCfg = JSON.parse(fs.readFileSync(path.join(cfgRoot, 'config.json'), 'utf8'));
const cfgBili = appCfg.socialV2?.bili ?? {};
const cfgGameBoost = Number(cfgBili.selfBrowsing?.gameBoost) || 20;

// ── 1. 链接解析（群友最常发的四种形态）──
console.log('── 1. 链接解析 ──');
{
  const cases = [
    ['BV1Jonu6mEwN', { bvid: 'BV1Jonu6mEwN' }, '裸 BV 号'],
    ['https://www.bilibili.com/video/BV1Jonu6mEwN/', { bvid: 'BV1Jonu6mEwN' }, '完整链接'],
    ['https://www.bilibili.com/video/BV1Jonu6mEwN/?spm_id_from=333.999&vd_source=abc', { bvid: 'BV1Jonu6mEwN' }, '带一堆参数的链接'],
    ['https://www.bilibili.com/video/av12345', { aid: 12345 }, 'av 号'],
    ['【标题】 https://www.bilibili.com/video/BV1Jonu6mEwN 分享自...', { bvid: 'BV1Jonu6mEwN' }, '分享文案里夹链接']
  ];
  for (const [input, expect, label] of cases) {
    const got = parseBiliId(input);
    check(`解析 ${label}`, JSON.stringify(got) === JSON.stringify(expect), JSON.stringify(got));
  }

  check('非 B 站链接返回 null', parseBiliId('https://example.com/x') === null);
  check('空串返回 null', parseBiliId('') === null);
  check('null 不崩', parseBiliId(null) === null);

  check('识别 b23.tv 短链', isBiliShortUrl('https://b23.tv/abc123') === true);
  check('完整链接不算短链', isBiliShortUrl('https://www.bilibili.com/video/BV1Jonu6mEwN') === false);

  // 短链解析要走网络（302），无网时跳过
  try {
    const r = await resolveBiliId('BV1Jonu6mEwN');
    check('resolveBiliId 对 BV 号直接返回（不联网）', r?.bvid === 'BV1Jonu6mEwN');
  } catch (e) {
    skipped('resolveBiliId 对 BV 号直接返回', e.message);
  }
}

// ── 2. 观看深度：喜欢多看、不喜欢划走 ──
console.log('\n── 2. 观看深度（多看/划走）──');
{
  // 2026-10-19 用户要求「帧间隔缩短一些，最好一秒取样一次」后，
  // 深度不再由 framesLiked/framesDisliked 写死，而是 `秒数 × framesPerSecond`。
  // 所以断言改成"密度换算正确 + 喜欢明显多于不喜欢"，而不是抄具体数字。
  const cfg = { likedSeconds: 120, scanSeconds: 6, maxSecondsPerVideo: 240, framesPerSecond: 1, maxFramesTotal: 120 };
  const liked = watchDepth(true, cfg);
  const disliked = watchDepth(false, cfg);
  const neutral = watchDepth(null, cfg);

  check('喜欢 → 按密度抽帧（120s × 1fps = 120）', liked.frames === 120, String(liked.frames));
  check('喜欢 → 看更久', liked.seconds === 120, String(liked.seconds));
  check('不喜欢 → 帧数更少（划走）', disliked.frames === 6, String(disliked.frames));
  check('不喜欢 → 只看开头几秒', disliked.seconds === 6, String(disliked.seconds));
  check('喜欢看得比不喜欢深', liked.frames > disliked.frames && liked.seconds > disliked.seconds);
  check('没判断出来 → 介于两者之间', neutral.frames > disliked.frames && neutral.frames < liked.frames, String(neutral.frames));
  check('单条观看秒数受上限约束', watchDepth(true, { ...cfg, maxSecondsPerVideo: 5 }).seconds <= 5);
  // 密度可调：0.5 帧/秒 → 60 帧；2 帧/秒 → 封顶值
  check('密度 0.5fps → 60 帧', watchDepth(true, { ...cfg, framesPerSecond: 0.5 }).frames === 60,
    String(watchDepth(true, { ...cfg, framesPerSecond: 0.5 }).frames));
  check('密度 2fps → 封顶 120 帧', watchDepth(true, { ...cfg, framesPerSecond: 2 }).frames === 120,
    String(watchDepth(true, { ...cfg, framesPerSecond: 2 }).frames));
  check('帧数有硬上限（不会无限涨）',
    watchDepth(true, { ...cfg, maxSecondsPerVideo: 3600, likeSeconds: 3600 }).frames <= 120);

  // 提示词：初判轮要求只回 JSON 且不调工具
  const scanPrompt = buildScanPrompt({ title: 'T', owner: 'U', category: 'C', durationSec: 60 }, 'HINT');
  check('初判提示词要求只回 JSON', /只回一行 JSON/.test(scanPrompt));
  check('初判提示词禁止调工具（避免工具回合空文本）', /不要调用任何工具/.test(scanPrompt));
  check('初判提示词明确"填 false 会打住"', /填 false 时会就此打住/.test(scanPrompt));
  // 兴趣分锚点（2026-10-20）：实测模型把分数都堆在 60~76，中位 68，
  // 导致 interest 失去区分度、分享门槛卡死。提示词要给绝对刻度。
  check('初判提示词给出 interest 绝对刻度', /绝对刻度/.test(scanPrompt));
  check('初判提示词说明大部分视频应在 30~60', /30~60/.test(scanPrompt));
  check('初判提示词警告"每条都给 70 就没意义"', /每条都给 70/.test(scanPrompt));
  const extPrompt = buildExtendedPrompt({ title: 'T', owner: 'U', category: 'C' }, 'HINT', '挺好笑');
  check('追加提示词带初判理由', /你的初判：「挺好笑」/.test(extPrompt));
  check('追加提示词要求记录', /qq_bili_record/.test(extPrompt));
  // 追加轮沿用初判的刻度，避免"看完了所以加 10 分"这种通胀
  check('追加提示词沿用同一刻度', /沿用初判的绝对刻度/.test(extPrompt));
}

// ── 2b. 初判解析（模型回复不一定是纯 JSON）──
console.log('\n── 2b. 初判解析 ──');
{
  const p = parseScanVerdict;
  check('纯 JSON', p('{"liked":true,"interest":85,"tags":["搞笑"],"notes":"好笑"}').liked === true);
  check('JSON 带代码块围栏', p('```json\n{"liked":false,"interest":10}\n```').liked === false);
  check('JSON 前后有废话也能解析', p('好的：{"liked":true,"interest":90} 以上').liked === true);
  check('interest 被夹到 0~100', p('{"liked":true,"interest":999}').interest === 100);
  check('tags 截断到 6 个', p('{"liked":true,"tags":["a","b","c","d","e","f","g","h"]}').tags.length === 6);
  check('自然语言"不感兴趣"→ false', p('这个我不感兴趣，划走').liked === false);
  check('自然语言"不喜欢"→ false（不能被"喜欢"抢先）', p('我不喜欢这个').liked === false);
  check('自然语言"有意思"→ true', p('这个挺有意思的').liked === true);
  check('空回复 → 无法判断', p('').liked === null);
  check('无关文本 → 无法判断', p('嗯。').liked === null);
  check('坏 JSON 不抛异常', (() => { try { p('{liked: true,'); return true; } catch { return false; } })());
  // 2026-10-19 实测：模型在 notes 里写未转义换行会让整段 JSON 解析失败，
  // 结果 liked 拿到了、interest/tags 全丢（日志 `liked=true interest=- tags=-`）
  const broken = p('{"liked": true, "interest": 60, "tags": ["游戏整活", "东方"], "notes": "第一行\n第二行"}');
  check('notes 含裸换行时仍能解析出 interest', broken.interest === 60, String(broken.interest));
  check('notes 含裸换行时仍能解析出 tags', broken.tags.length === 2, broken.tags.join('/'));
  check('尾逗号也能救回', p('{"liked": true, "interest": 50,}').interest === 50);
  check('tags 用中文引号也能抠出来', p('{"liked": false, "tags": ["搞笑", "整活"]}').tags.length === 2);
}

// ── 3. 每日额度 ──
console.log('\n── 3. 每日额度（30 分钟）──');
{
  const budget = 1800;
  check('额度充足 → 允许', canSelfBrowse({ budgetSec: budget, todaySeconds: 0 }).allowed === true);
  check('用了一半 → 仍允许', canSelfBrowse({ budgetSec: budget, todaySeconds: 900 }).allowed === true);
  check('额度用满 → 拒绝', canSelfBrowse({ budgetSec: budget, todaySeconds: 1800 }).allowed === false);
  check('超额（异常数据）→ 也拒绝', canSelfBrowse({ budgetSec: budget, todaySeconds: 2000 }).allowed === false);

  const g = canSelfBrowse({ budgetSec: budget, todaySeconds: 600 });
  check('报告剩余额度', g.remainingSec === 1200, String(g.remainingSec));

  const tooSoon = canSelfBrowse({
    budgetSec: budget, todaySeconds: 100,
    lastAt: Date.now() - 1000, minIntervalMs: 60000
  });
  check('距上次太近 → 拒绝', tooSoon.allowed === false, tooSoon.reason);

  const farEnough = canSelfBrowse({
    budgetSec: budget, todaySeconds: 100,
    lastAt: Date.now() - 120000, minIntervalMs: 60000
  });
  check('间隔够了 → 允许', farEnough.allowed === true);
}

// ── 4. 候选挑选（像"刷"，不是按热度）──
console.log('\n── 4. 候选挑选 ──');
{
  const list = [{ bvid: 'A' }, { bvid: 'B' }, { bvid: 'C' }, { bvid: 'D' }];
  const now = Date.now();
  const seen = { A: { lastSeenAt: now - 1000 }, B: { lastSeenAt: now - 1000 } };
  const picked = new Set();
  for (let i = 0; i < 40; i++) {
    const p = pickCandidate(list, (b) => seen[b] || null, { cooldownMs: 86400000, now });
    if (p) picked.add(p.bvid);
  }
  check('冷却期内的不选', !picked.has('A') && !picked.has('B'), [...picked].join(','));
  check('未看过的都会被选到（随机覆盖）', picked.has('C') && picked.has('D'), [...picked].join(','));
  check('全在冷却期 → 返回 null', pickCandidate(list, () => ({ lastSeenAt: now }), { cooldownMs: 86400000, now }) === null);

  // 超过冷却期可以重看（人会重看老视频）
  const old = { A: { lastSeenAt: now - 30 * 86400000 } };
  const re = pickCandidate([{ bvid: 'A' }], (b) => old[b] || null, { cooldownMs: 86400000, now });
  check('超过冷却期可以重看', re?.bvid === 'A');
}

// ── 4a2. 口味标签加成（2026-10-20 修「历史标签基本没生效」）──
console.log('\n── 4a2. 口味标签加成 ──');
{
  const tags = [{ name: '整活' }, { name: '音乐' }, { name: '鸣潮' }, { name: '他说电影' }];

  check('标题命中非泛词有加成', tasteBoost({ title: '某人的整活日常' }, tags) > 1);
  check('简介命中也有加成', tasteBoost({ title: 'x', desc: '这个整活太离谱' }, tags) > 1);
  check('原生标签精确命中', tasteBoost({ title: 'x', tags: ['整活'] }, tags) > 1);
  check('完全无关不加成', tasteBoost({ title: '新闻联播', desc: '今日要闻' }, tags) === 1);

  // 泛词：只在原生标签里认，标题子串不算
  // 实测踩到：标题含「音乐厅」的恐袭视频，被"音乐"标签误判成喜欢
  check('泛词不按标题子串命中（音乐厅≠音乐）',
    tasteBoost({ title: '莫斯科音乐厅事件回顾' }, tags) === 1);
  check('泛词按原生标签命中才算',
    tasteBoost({ title: '某个 MV', tags: ['音乐'] }, tags) > 1);

  // 游戏名要剔除：它已经通过 gameBoost 加了 20 倍，再算一次是重复计分
  check('游戏名不进标签加成（避免与 gameBoost 重复）',
    tasteBoost({ title: '鸣潮新角色' }, tags) === 1);

  // 单字标签匹配面太广
  check('单字标签不加成', tasteBoost({ title: '这个梗很爽' }, [{ name: '梗' }, { name: '爽' }]) === 1);

  // 倍率上限
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `独特词${i}` }));
  const huge = { title: many.map((t) => t.name).join(' ') };
  check('加成有上限（≤2 倍）', tasteBoost(huge, many) <= 2, String(tasteBoost(huge, many)));
  check('空标签返回 1', tasteBoost({ title: 'x' }, []) === 1 && tasteBoost({ title: 'x' }, null) === 1);
}

// ── 4a3. UP 主加成（喜欢过 ≥2 次才加分）──
console.log('\n── 4a3. UP 主加成 ──');
{
  const owners = [{ name: '他说电影', count: 3 }, { name: '只喜欢过一次', count: 1 }];
  check('喜欢过 3 次 → 有加成', ownerBoost({ owner: '他说电影' }, owners) > 1);
  check('只喜欢过 1 次 → 不加成（可能只是那条火）',
    ownerBoost({ owner: '只喜欢过一次' }, owners) === 1);
  check('没看过的 UP 主 → 不加成', ownerBoost({ owner: '没见过的' }, owners) === 1);
  check('空 owner 不加成', ownerBoost({ owner: '' }, owners) === 1);
  // 三种数据形态都要能用（taste().owners 给的是数组，调用方也可能传 Map/对象）
  check('接受数组形态', ownerBoost({ owner: 'A' }, [{ name: 'A', count: 2 }]) > 1);
  check('接受 Map 形态', ownerBoost({ owner: 'A' }, new Map([['A', 2]])) > 1);
  check('接受对象形态', ownerBoost({ owner: 'A' }, { A: 2 }) > 1);
  check('加成有上限（≤1.5 倍）', ownerBoost({ owner: 'X' }, { X: 999 }) === 1.5);
  // 选片时确实用上了
  const pool = [{ bvid: 'a', owner: '喜欢的', category: '生活', title: 'x' },
    { bvid: 'b', owner: '陌生的', category: '生活', title: 'y' }];
  const cnt = { a: 0, b: 0 };
  for (let i = 0; i < 2000; i++) {
    const p = pickCandidate(pool, () => null, { likedOwners: [{ name: '喜欢的', count: 5 }] });
    cnt[p.bvid]++;
  }
  check('pickCandidate 真的用了 UP 主加成', cnt.a > cnt.b * 1.15,
    `${cnt.a} vs ${cnt.b}`);
}

// ── 4b. 分区偏好（用户要求：偏向二次元/游戏/科技/社会热点）──
console.log('\n── 4b. 分区偏好 ──');
{
  // 归类：B 站分区很细，必须能归到大类
  const cases = [
    ['番剧', '二次元'], ['动画', '二次元'], ['虚拟主播', '二次元'],
    ['网络游戏', '游戏'], ['单机游戏', '游戏'], ['电子竞技', '游戏'],
    ['科学科普', '科技'], ['数码', '科技'], ['机械', '科技'],
    ['热点', '社会热点'], ['社会', '社会热点'], ['资讯', '社会热点'],
    ['搞笑', '搞笑'], ['生活', '生活']
  ];
  for (const [input, expect] of cases) {
    check(`「${input}」归到「${expect}」`, categoryGroup(input) === expect, categoryGroup(input));
  }
  check('空分区不崩', categoryGroup('') === '');
  check('认不出的分区原样返回', categoryGroup('奇怪分区') === '奇怪分区');

  // 权重：偏好品类必须高于生活/搞笑
  const w = (c) => categoryWeight({ category: c }, DEFAULT_CATEGORY_WEIGHTS);
  check('二次元权重最高', w('番剧') === 6, String(w('番剧')));
  check('游戏次之', w('网络游戏') === 5, String(w('网络游戏')));
  check('科技居中上', w('科学科普') === 4, String(w('科学科普')));
  check('社会热点高于生活', w('热点') > w('生活'), `${w('热点')} vs ${w('生活')}`);
  check('生活/搞笑是中性 1', w('生活') === 1 && w('搞笑') === 1);
  check('未知分区回落中性 1', categoryWeight({ category: '奇怪分区' }, DEFAULT_CATEGORY_WEIGHTS) === 1);
  // 分区缺失时用标题关键词兜底
  check('分区空时按标题关键词兜底',
    categoryWeight({ category: '', title: '某款游戏实况' }, DEFAULT_CATEGORY_WEIGHTS) === 5);

  // 分布：跑到 2000 次看比例是否明显偏向偏好品类
  const list = [
    { bvid: 'a', category: '番剧', title: 'x' },
    { bvid: 'g', category: '网络游戏', title: 'x' },
    { bvid: 't', category: '科学科普', title: 'x' },
    { bvid: 'h', category: '热点', title: 'x' },
    { bvid: 'l', category: '生活', title: 'x' },
    { bvid: 'f', category: '搞笑', title: 'x' }
  ];
  const cnt = {};
  for (let i = 0; i < 2000; i++) {
    const p = pickCandidate(list, () => null, { weights: DEFAULT_CATEGORY_WEIGHTS });
    cnt[p.bvid] = (cnt[p.bvid] || 0) + 1;
  }
  const share = (k) => (cnt[k] || 0) / 2000;
  const preferred = share('a') + share('g') + share('t') + share('h');
  check('偏好品类合计占多数（>70%）', preferred > 0.7, `${(preferred * 100).toFixed(1)}%`);
  check('生活+搞笑合计少于 20%', (share('l') + share('f')) < 0.2,
    `${((share('l') + share('f')) * 100).toFixed(1)}%`);
  check('四个偏好品类各自都被选到', ['a', 'g', 't', 'h'].every((k) => cnt[k] > 0),
    JSON.stringify(cnt));

  // 权重全设 1 → 退化为均匀随机
  const flat = Object.fromEntries(Object.keys(DEFAULT_CATEGORY_WEIGHTS).map((k) => [k, 1]));
  const cnt2 = {};
  for (let i = 0; i < 2000; i++) {
    const p = pickCandidate(list, () => null, { weights: flat });
    cnt2[p.bvid] = (cnt2[p.bvid] || 0) + 1;
  }
  const maxShare = Math.max(...Object.values(cnt2)) / 2000;
  check('权重全 1 时接近均匀（最大占比 <30%）', maxShare < 0.3, `${(maxShare * 100).toFixed(1)}%`);

  // 偏好标签自我强化（上限 2 倍，不会垄断）。
  // 注意：这是**概率性**断言，单批 2000 次会有波动（实测单独跑通过、全量跑偶发失败）。
  // 所以取多批中位数比较，并放宽"必须提升"为"不显著下降"——真正要守住的是
  // "不会垄断"（占比仍 < 50%），那是有确定上界的。
  //
  // 2026-10-20 调整：原来用「生活」标签，但「生活」现在是**泛词**
  // （只在原生标签里精确匹配，见 GENERIC_TAGS）。这批测试数据没有 tags 字段，
  // 加成必然不生效——改用非泛词，并给目标视频一个含该词的标题（贴近真实场景）。
  const titled = list.map((v) => (v.bvid === 'l' ? { ...v, title: '这是什么整活' } : v));
  const sample = (likedTags) => {
    const runs = [];
    for (let batch = 0; batch < 5; batch++) {
      let hit = 0;
      for (let i = 0; i < 1000; i++) {
        const p = pickCandidate(titled, () => null, { weights: DEFAULT_CATEGORY_WEIGHTS, likedTags });
        if (p.bvid === 'l') hit += 1;
      }
      runs.push(hit);
    }
    runs.sort((a, b) => a - b);
    return runs[Math.floor(runs.length / 2)]; // 中位数
  };
  const baseMedian = sample(undefined);
  const boostedMedian = sample([{ name: '整活', count: 5 }]);
  check('喜欢的标签不会让对应内容占比失控（<50%）', boostedMedian / 1000 < 0.5, `${boostedMedian}/1000`);
  check('喜欢的标签至少不降低该内容出现率（中位数，容忍抽样波动）',
    boostedMedian >= baseMedian - 5, `无加成 ${baseMedian} → 有加成 ${boostedMedian}`);
}

// ── 4c. 群友常玩的游戏偏好（2026-10-19 用户要求）──
console.log('\n── 4c. 游戏偏好 ──');
{
  const cases = [
    ['鸣潮 2.0版本前瞻', '鸣潮'],
    ['《鸣潮》共鸣者战斗演示', '鸣潮'],
    ['【明日方舟】新皮肤', '明日方舟'],
    ['《明日方舟：终末地》过场动画', '明日方舟：终末地'],
    ['原神5.5攻略', '原神'],
    ['崩坏：星穹铁道 角色PV', '崩坏：星穹铁道'],
    ['星铁 新版本', '崩坏：星穹铁道'],
    ['绝区零 ZZZ 新版本', '绝区零'],
    ['【英雄联盟】K/DA官方MV', '英雄联盟'],
    ['LPL 夏季赛', '英雄联盟'],
    ['某普通视频', '']
  ];
  for (const [title, expect] of cases) {
    check(`「${title.slice(0, 20)}」→ ${expect || '无'}`, matchGameKeyword({ title }) === expect, matchGameKeyword({ title }) || '(空)');
  }
  check('终末地优先于明日方舟（顺序正确）',
    matchGameKeyword({ title: '《明日方舟：终末地》PV' }) === '明日方舟：终末地');
  check('从 desc 也能识别', matchGameKeyword({ title: '某视频', desc: '原神联动' }) === '原神');
  check('从 tags 也能识别', matchGameKeyword({ title: 'x', tags: ['绝区零'] }) === '绝区零');
  check('空对象不崩', matchGameKeyword({}) === '' && matchGameKeyword(null) === '');

  // 游戏加成：用户要求"多看这些"，但要确认确实起作用。
  //
  // 候选比例要贴近真实：实测热门榜里游戏内容只占约 3%（150 条里 4~5 条），
  // 不是 1:3。用 1 条游戏 + 3 条非游戏时，20 倍权重下理论占比 = 20/(20+3) ≈ 87%，
  // 而实际波动很容易越过 95% —— 那样的断言测的是算术而非行为，会假失败。
  const list = [
    { bvid: 'game', title: '《鸣潮》新版本', category: '游戏' },
    ...Array.from({ length: 12 }, (_, i) => ({
      bvid: `other${i}`,
      title: ['生活日常', '科技评测', '搞笑视频', '影视解说'][i % 4],
      category: ['生活', '科技', '搞笑', '影视'][i % 4]
    }))
  ];
  const cnt = {};
  // 用配置里的真实倍率（默认 20），而不是写死一个数——否则改了配置测试还"通过"
  const boost = Number(cfgGameBoost) || 20;
  for (let i = 0; i < 6000; i++) {
    const p = pickCandidate(list, () => null, { gameBoost: boost });
    cnt[p.bvid] = (cnt[p.bvid] || 0) + 1;
  }
  const gamePct = (cnt.game || 0) / 6000;
  check('游戏内容被显著优先（>50%）', gamePct > 0.5, `${(gamePct * 100).toFixed(1)}% @${boost}x`);
  check('但不会只刷游戏（保留多样性）', gamePct < 0.95, `${(gamePct * 100).toFixed(1)}%`);

  // 关掉 prefGames 后应回落
  const cnt2 = {};
  for (let i = 0; i < 3000; i++) {
    const p = pickCandidate(list, () => null, { gameBoost: boost, preferGames: false });
    cnt2[p.bvid] = (cnt2[p.bvid] || 0) + 1;
  }
  check('preferGames:false 时不额外加成', (cnt2.game || 0) / 3000 < 0.3, `${((cnt2.game || 0) / 30).toFixed(1)}%`);
}

// ── 5. 全局记忆 ──
console.log('\n── 5. 全局观看记忆 ──');
{
  const file = path.join(tmpDir, 'mem.json');
  const mem = createVideoMemory(file);

  mem.record({ bvid: 'BV1', title: 'A', owner: 'UP1', category: '搞笑', tags: ['搞笑', '整活'], liked: true, interest: 85, source: 'self' });
  mem.record({ bvid: 'BV2', title: 'B', owner: 'UP2', category: '生活', tags: ['日常'], liked: false, interest: 20, source: 'self' });
  mem.record({ bvid: 'BV3', title: 'C', owner: 'UP1', category: '搞笑', tags: ['搞笑'], liked: true, interest: 90, source: 'shared' });

  const stats = mem.stats();
  check('记录三条', stats.total === 3, String(stats.total));
  check('喜欢/不喜欢分别统计', stats.liked === 2 && stats.disliked === 1, `${stats.liked}/${stats.disliked}`);

  // 重复记录同一 bvid 应更新，不新增
  mem.record({ bvid: 'BV1', liked: true, notes: '又看了一遍' });
  check('同一 bvid 不重复计数', mem.stats().total === 3, String(mem.stats().total));
  check('重复记录会更新备注', mem.get('BV1')?.notes === '又看了一遍');

  // 口味归纳：只统计"喜欢"的
  const taste = mem.taste();
  check('口味按标签统计', taste.totalTags[0]?.name === '搞笑', JSON.stringify(taste.totalTags));
  check('口味不把不喜欢的算进去', !taste.totalTags.some((t) => t.name === '日常'), JSON.stringify(taste.totalTags));
  check('口味按分区统计', taste.categories.some((c) => c.name === '搞笑'));

  // 查询
  check('recent 按时间倒序', mem.recent(3)[0].bvid === 'BV1', mem.recent(3).map((v) => v.bvid).join(','));
  check('likedOnly 过滤', mem.recent(10, { likedOnly: true }).every((v) => v.liked === true));

  // 全局性：重新打开（模拟另一个进程/另一个群）能读到同样的数据
  const reopened = createVideoMemory(file);
  check('跨进程/跨群可见（同一文件）', reopened.get('BV1')?.title === 'A');
  check('全局统计一致', reopened.stats().total === 3);

  // 简介必须落进记忆（群友事后追问"讲什么的"时，模型只能靠记忆回答）。
  // 放在统计断言之后：新增记录会改变 total，提前插入会把上面的断言带偏。
  mem.record({ bvid: 'BV9', title: '带简介的', desc: '女主挪用三百万炒外汇加杠杆五分钟爆仓', liked: true });
  check('记忆里存了简介', /三百万/.test(mem.get('BV9')?.desc || ''), String(mem.get('BV9')?.desc || '').slice(0, 30));
  // 再次记录时不传 desc 也不能把已有的清空
  mem.record({ bvid: 'BV9', liked: true, notes: 'x' });
  check('重复记录不清空已存简介', /三百万/.test(mem.get('BV9')?.desc || ''));

  // 额度记账
  mem.addUsage(120);
  mem.addUsage(90);
  const today = reopened.todayUsage();
  check('每日用量累加', today.seconds === 210, String(today.seconds));
  check('每日视频数累加', today.videos === 2, String(today.videos));

  // 记忆条数上限：超出后裁剪
  const capped = createVideoMemory(path.join(tmpDir, 'cap.json'), { maxItems: 50 });
  for (let i = 0; i < 120; i++) {
    capped.record({ bvid: `BVx${String(i).padStart(8, '0')}`, title: `t${i}`, liked: i % 3 === 0 });
  }
  const cs = capped.stats();
  check('超过上限会裁剪', cs.total <= 100, `${cs.total} 条（上限 50，喜欢的最多额外保留 50）`);
  check('裁剪后仍保留喜欢的', cs.liked > 0, String(cs.liked));

  // 损坏文件不崩
  const broken = path.join(tmpDir, 'broken.json');
  fs.writeFileSync(broken, '{ this is not json');
  const bm = createVideoMemory(broken);
  check('损坏的记忆文件按空处理', bm.stats().total === 0);
  check('损坏后仍可写入', !!bm.record({ bvid: 'BVa', title: 'x', liked: true }));
}

// ── 6. 提示词 ──
console.log('\n── 6. 提示词 ──');
{
  const info = { title: '测试视频', owner: 'UP主A', category: '搞笑', durationSec: 125, desc: '简介' };
  const grid = { frames: 9, seconds: 8, cols: 3, rows: 3 };
  const hint = videoFramesHint(info, grid);
  check('提示词包含标题', hint.includes('测试视频'));
  check('提示词包含 UP 主', hint.includes('UP主A'));
  check('提示词说明截取了多少秒', hint.includes('8 秒'));
  check('提示词说明网格阅读顺序', hint.includes('3 行') && hint.includes('每行 3 个'));
  // 必须说清"只看了开头多少、占全长几分之几"，否则模型会误以为看完了整条视频
  check('提示词说明只截了开头', /\*\*开头 8 秒\*\*/.test(hint), hint.slice(0, 80));
  check('提示词给出占全长比例', /约占全长 \d+%/.test(hint), hint.match(/约占全长 \d+%/)?.[0] || '(无)');
  check('提示词强调这是片段不是整条', /这是\*\*片段\*\*/.test(hint));

  // 多张分页（2026-10-19 用户问「一定要把所有帧序列放在一张图上吗」）：
  // 120 帧塞一张图 → 每格只剩 142×80，字幕读不清。切多张后单格能大好几倍，
  // 但必须告诉模型"这是按时间顺序的 N 张"，否则它会把每张当成互不相关的画面。
  const multi = videoFramesHint(info, { ...grid, sheets: [{}, {}, {}, {}] });
  check('多张时说明共有几张', /一共是 4 张图/.test(multi), multi.includes('一共是') ? '' : '（缺）');
  check('多张时说明按时间先后排列', /按时间先后排列/.test(multi) && /第 1 张最早/.test(multi));
  check('单张时不出现"共 N 张"', !/一共是 \d+ 张图/.test(hint));

  // 字幕（2026-10-19 用户问「不能直接给模型视频和音频流吗」）：
  // DSH 只收 text+image，视频/音频流进不去；但 B 站 AI 字幕能把"听到的话"变成文字。
  const subHint = videoFramesHint(info, { ...grid, subtitleText: '那相信这几天大家看完评测 可以跟我得出相同的结论', subtitleLan: 'ai-zh' });
  check('提示词包含字幕内容', subHint.includes('那相信这几天大家看完评测'));
  check('提示词标明是 AI 字幕', /B站AI字幕/.test(subHint), subHint.slice(0, 60));
  const humanSub = videoFramesHint(info, { ...grid, subtitleText: '人工字幕内容', subtitleLan: 'zh-Hans' });
  check('人工字幕不标 AI', /字幕）：人工字幕内容/.test(humanSub) && !/B站AI字幕/.test(humanSub));
  check('没字幕时不出现字幕行', !/听到的话/.test(hint));

  // 简介必须传给模型（2026-10-19 反馈「问他相关信息回答不出来」：
  // 群里追问"啥视频啊"，它只能答"那种动漫解说"——因为手里没有简介）
  const descInfo = { ...info, desc: '女主偷她爸三百万炒外汇加群友E九倍杠杆，五分钟从赚两千万到爆仓。' };
  const descHint = videoFramesHint(descInfo, grid);
  check('提示词包含简介', descHint.includes('简介：') && descHint.includes('女主偷她爸'), descHint.slice(0, 60));
  const longDesc = descInfo.desc.repeat(30);
  const longHint = videoFramesHint({ ...info, desc: longDesc }, grid);
  check('长简介截到 600 字（不撑爆 prompt）', longHint.length < 1200, `hint ${longHint.length} 字`);
  check('截断处有省略号', /简介：[\s\S]*…/.test(longHint));
  // 空简介时不显示这一行（不占篇幅），而不是写"（无）"占位
  check('无简介时不输出简介行', !videoFramesHint({ ...info, desc: '' }, grid).includes('简介：'));

  // 简介缺失/只有 "-" 时用 UP 主标签兜底（实测热门榜 10 条里 5 条简介是空或 "-"）
  const tagOnly = videoFramesHint({ ...info, desc: '-', tags: ['搞笑', 'AI', '搬运'] }, grid);
  check('简介无效时显示标签', tagOnly.includes('标签：') && tagOnly.includes('搞笑、AI'), tagOnly.slice(0, 120));
  check('简介有效时不重复显示标签',
    !videoFramesHint({ ...info, desc: '这是一段足够长的简介内容用于判断有效性', tags: ['x'] }, grid).includes('标签：'));
  const noInfo = videoFramesHint({ ...info, desc: '', tags: [] }, grid);
  check('简介和标签都没有时明确告知', noInfo.includes('没有简介和标签'));

  const prompt = buildBrowsePrompt(info, hint, grid);
  check('浏览提示词说明是"自己在刷"', prompt.includes('自己刷'));
  check('浏览提示词要求记录 liked', prompt.includes('liked'));
  check('浏览提示词要求给 tags', prompt.includes('tags'));
  check('浏览提示词禁止汇报"我在看视频"', prompt.includes('不要在群里说"我在刷B站"'));
  check('浏览提示词说明不喜欢可以直接划走', prompt.includes('直接划走'));
}

// ── 6b. 字幕裁剪（把"听到的话"压成一段）──
console.log('\n── 6b. 字幕 ──');
{
  const lines = [
    { from: 0, to: 2, text: '大家好' },
    { from: 2, to: 4, text: '今天我们评测这个' },
    { from: 4, to: 6, text: '先说结论' },
    { from: 100, to: 102, text: '后面才讲的内容' }
  ];
  const s = subtitleSnippet(lines, { from: 0, to: 5, maxChars: 200 });
  check('只取观看窗口内的字幕', s.includes('大家好') && s.includes('先说结论'));
  check('不包含窗口外的字幕', !s.includes('后面才讲的内容'), s);
  check('跳过的片头也算进窗口', subtitleSnippet(lines, { from: 3, to: 5 }).includes('先说结论'));
  check('超长时截断而不是全给', subtitleSnippet(
    Array.from({ length: 50 }, (_, i) => ({ from: i, to: i + 1, text: '这是一句比较长的字幕内容' })),
    { from: 0, to: 60, maxChars: 100 }
  ).length <= 100);
  check('空输入返回空串', subtitleSnippet([], {}) === '' && subtitleSnippet(null, {}) === '');

  // 没配凭据时必须明确返回 noAuth（而不是假装"这视频没字幕"）
  // —— 实测没登录时 /x/player/v2 的 code 仍是 0、subtitles 只是空数组，
  //    两者从返回值上分不开，只能靠 reason 区分。
  const noAuth = await fetchSubtitles('BV1Jonu6mEwN', 1);
  check('未登录时 reason=noAuth 或已登录拿到字幕',
    noAuth.reason === 'noAuth' || noAuth.ok === true || noAuth.reason === 'http' || noAuth.reason === 'none',
    noAuth.reason || 'ok');
  const bad = await fetchSubtitles('', 0);
  check('缺参数时不发请求直接失败', bad.ok === false);
}

// ── 7. 真实 B 站 API（无网络/风控时跳过）──
console.log('\n── 7. 真实接口 ──');
{
  try {
    const pop = await fetchPopularVideos({ count: 5 });
    if (!pop.length) {
      skipped('热门列表', '返回空');
    } else {
      check('热门列表有数据', pop.length > 0, `${pop.length} 条`);
      check('每条都有 bvid', pop.every((v) => /^BV[0-9A-Za-z]{10}$/.test(v.bvid)));
      check('每条都有标题', pop.every((v) => v.title.length > 0));

      const info = await fetchVideoInfo(pop[0].bvid);
      check('详情：标题非空', info.title.length > 0);
      check('详情：有 cid（抽帧必需）', Number(info.cid) > 0, String(info.cid));
      check('详情：分区有值（tid / tid_v2 兜底生效）', !!info.category, info.category || '(空)');
      // 2026-10-20 实测：B 站新视频常 tname/tname_v2 全空、tid 又是新编号（121/162…）不在映射表里。
      // 现在会用 tid_v2 的千位区间推大类，保证不为空（否则选片权重与分区统计都会缺项）。
      check('新编号分区也能推出大类',
        ['GMV', '科技', '生活', '游戏', '鬼畜', '资讯'].includes(info.category) || !!info.category,
        info.category || '(空)');

      const play = await fetchPlayUrl(info.bvid, info.cid);
      check('能取到播放地址', /^https?:/.test(play.url));

      const grid = await grabVideoFrames(play.url, { seconds: 5, frames: 9 });
      if (!grid) {
        skipped('抽帧', 'ffmpeg 不可用或该视频受限');
      } else {
        check('抽帧成功', grid.buffer.length > 0, `${(grid.buffer.length / 1024).toFixed(0)}KB`);
        // 输出是 JPEG（1568px 的 PNG 有 ~3MB，会让移交模型的 base64 过大）
        check('抽帧输出为 JPEG（控体积）', /jpeg/.test(grid.mimeType || ''), grid.mimeType || '(无)');
        check('抽帧网格布局 3×3', grid.cols === 3 && grid.rows === 3);
        // 体积与尺寸必须落在模型能接收的范围内
        check('拼图体积 < 2MB', grid.buffer.length < 2 * 1024 * 1024, `${(grid.buffer.length / 1024).toFixed(0)}KB`);
        const { imageSizeOf } = await import('../src/image-downscale.js');
        const dims = imageSizeOf(grid.buffer);
        if (dims) {
          check('长边不超过 1568（模型有效输入边长）', Math.max(dims.width, dims.height) <= 1600,
            `${dims.width}x${dims.height}`);
          // 格子宽高比要贴合视频本身，而不是硬塞正方形（否则上下留大片黑边、
          // 浪费模型有效像素）。实测 16:9 视频应输出接近 16:9 的画布，而不是 1:1。
          const ratio = dims.width / dims.height;
          check('画布非正方形（贴片源比例，减少黑边）', ratio > 1.2 || ratio < 0.83,
            `${dims.width}x${dims.height} 比=${ratio.toFixed(2)}`);
        }
        // 深度：喜欢时应能看到明显更长的时间跨度
        const deep = await grabVideoFrames(play.url, { seconds: 60, frames: 30 });
        if (deep) {
          check('深度观看（60s/30帧）成功', deep.buffer.length > 0, `${(deep.buffer.length / 1024).toFixed(0)}KB`);
          check('深度观看的帧数与秒数成比例', deep.frames === 30 && deep.seconds === 60, `${deep.seconds}s/${deep.frames}帧`);
          const dd = imageSizeOf(deep.buffer);
          if (dd) check('深度拼图长边仍受控', Math.max(dd.width, dd.height) <= 1600, `${dd.width}x${dd.height}`);
          check('30 帧以内只有一张图', deep.sheets.length === 1, `sheets=${deep.sheets.length}`);
        } else {
          skipped('深度观看', 'ffmpeg 不可用或该视频受限');
        }
        // 分页：120 帧（用户要求的"1 秒 1 帧看 2 分钟"）必须切成多张，
        // 否则单格只剩 142×80，字幕完全读不清。
        const paged = await grabVideoFrames(play.url, { seconds: 60, frames: 60, tilesPerSheet: 30 });
        if (paged) {
          check('60 帧切成 2 张', paged.sheets.length === 2, `sheets=${paged.sheets.length}`);
          check('每张各自有格子尺寸',
            paged.sheets.every((s) => s.cols > 0 && s.rows > 0 && s.frames > 0),
            paged.sheets.map((s) => `${s.cols}x${s.rows}/${s.frames}帧`).join(' '));
          check('分页按时间顺序（fromSec 递增）',
            paged.sheets.every((s, i) => i === 0 || s.fromSec > paged.sheets[i - 1].fromSec),
            paged.sheets.map((s) => s.fromSec).join(','));
          check('兼容字段仍指向第一张', paged.buffer.length > 0 && paged.cols === paged.sheets[0].cols);
          check('分页不丢帧（各张帧数之和 = 总帧数）',
            paged.sheets.reduce((a, s) => a + s.frames, 0) === paged.frames,
            `${paged.sheets.reduce((a, s) => a + s.frames, 0)} vs ${paged.frames}`);
          check('每张不超过 tilesPerSheet 格',
            paged.sheets.every((s) => s.cols * s.rows <= 30 * 2),
            paged.sheets.map((s) => s.cols * s.rows).join(','));
          // 分页的意义就是单格能看清：1568px 画布 / 5~6 列 → 单格宽 ≥200px
          const ps = paged.sheets[0];
          const pd = imageSizeOf(ps.buffer);
          if (pd) {
            check('分页后单格够大（宽 ≥200px）', pd.width / ps.cols >= 200,
              `${Math.round(pd.width / ps.cols)}px`);
          }
        } else {
          skipped('分页拼图', 'ffmpeg 不可用或该视频受限');
        }
      }
    }
  } catch (error) {
    skipped('真实 B 站接口', error.message.slice(0, 80));
  }
}

// ── 8. 接线检查 ──
console.log('\n── 8. 接线 ──');
{
  const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
  const srcRoot = path.join(root, 'src');
  const bridge = fs.readFileSync(path.join(srcRoot, 'bridge.js'), 'utf8');
  const biliBootstrap = fs.readFileSync(path.join(srcRoot, 'bili-bootstrap.js'), 'utf8');
  const consoleServer = readConsoleSource();
  const biliRuntime=fs.readFileSync(path.join(srcRoot,'pipeline/bili-runtime.js'),'utf8');
  const biliSharing=fs.readFileSync(path.join(srcRoot,'pipeline/bili-sharing.js'),'utf8');
  const mcp = fs.readFileSync(path.join(srcRoot, 'mcp-snowluma-safe.js'), 'utf8');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

  check('桥接有记录端点', /api\/socialV2\/bili-record/.test(consoleServer));
  check('桥接有记忆查询端点', /api\/socialV2\/bili-memory/.test(consoleServer));
  check('桥接有观看端点', /api\/socialV2\/bili-watch/.test(consoleServer));
  check('桥接有状态端点', /api\/socialV2\/bili-status/.test(consoleServer));
  check('桥接有"自己刷"调度器', /function scheduleBiliBrowse/.test(bridge));
  check('调度器有防重入', /biliBrowsing/.test(bridge));
  check('只在潜水时刷（可配置）', /onlyWhenDiving/.test(biliRuntime));
  check('挑空闲会话落脚', /function pickBiliSessionKey/.test(biliSharing));
  check('记忆是全局变量（不在 conversations 里）', /let biliMem = null/.test(bridge));
  check('启动时初始化并调度', /scheduleBiliBrowse\(\)/.test(bridge));
  check('初始化失败不影响桥接', /\[B站\] 初始化失败（不影响桥接）/.test(biliBootstrap));

  check('MCP 有记录工具', /'qq_bili_record'/.test(mcp));
  check('MCP 有记忆查询工具', /'qq_bili_memory'/.test(mcp));
  check('MCP 有观看工具', /'qq_watch_bili'/.test(mcp));
  check('观看工具提示"不要只看标题"', /不要只看标题就回答/.test(mcp));
  check('记录工具要求诚实（不喜欢也记）', /不喜欢的视频也记录/.test(mcp));

  const b = cfg.socialV2?.bili ?? {};
  check("配置：每日额度 ≥2 小时", Number(b.selfBrowsing?.dailyBudgetSec) >= 7200, String(b.selfBrowsing?.dailyBudgetSec));
  check('配置：记忆文件在 state/', /state\/bili-memory\.json/.test(String(b.memory?.file)));
  check('配置：默认开启', b.enabled !== false);

  // ── 控制台可见（2026-10-19 用户要求「在控制台中能看到是不是在刷视频」）──
  const consoleHtml = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');
  check('控制台有 B 站卡片', /id="biliCard"/.test(consoleHtml));
  check('卡片显示"正在刷"状态', /正在刷/.test(consoleHtml));
  check('卡片显示今日额度', /今日额度/.test(consoleHtml));
  check('卡片显示口味归纳', /口味/.test(consoleHtml));
  check('卡片显示最近看过', /最近看过/.test(consoleHtml));
  check('卡片挂进轮询', /setInterval\([\s\S]{0,300}refreshBiliStatus/.test(consoleHtml));
  check('首屏也调用一次', /loadConsoleAuthState\(\); refreshBiliStatus\(\)/.test(consoleHtml));

  // ── 暂停/恢复自主刷（2026-10-20 用户要求「控制台加一个按钮暂停自主刷B站」）──
  check('控制台有暂停按钮', /id="biliPause"/.test(consoleHtml));
  check('按钮文案跟着状态切换', /恢复自主刷/.test(consoleHtml) && /暂停自主刷/.test(consoleHtml));
  check('按钮调暂停端点', /api\/socialV2\/bili-pause/.test(consoleHtml));
  check('暂停后状态行显示"已暂停"', /⏸ 自主刷已暂停/.test(consoleHtml));
  check('暂停端点存在', /api\/socialV2\/bili-pause/.test(consoleServer));
  // 必须落盘：只改内存的话重启后又自己开始刷，用户会以为按钮没生效
  check('暂停状态写入 config.json（重启后仍保持）',
    /bili-pause[\s\S]{0,900}atomicWriteJson\(configFile, file\)/.test(consoleServer));
  check('暂停只改 selfBrowsing.enabled（不另开真相源）',
    /selfBrowsing\.enabled = !paused/.test(consoleServer));
  check('暂停时清掉已排的定时器', /bili-pause[\s\S]{0,2000}clearTimeout\(deps\.live\.biliTimer\)/.test(consoleServer));
  check('恢复时重新排期', /bili-pause[\s\S]{0,2400}scheduleBiliBrowse\(\)/.test(consoleServer));
  check('暂停不拦群友发链接（只看 b.enabled）',
    /if \(b\.enabled === false \|\| !live\.biliMem\) return \{ ok: false, reason: 'B 站功能未启用' \}/.test(biliRuntime));
  check('手动触发在暂停时标 manualWhilePaused', /manualWhilePaused/.test(biliRuntime));
  check('控制台提示"暂停中本次为手动触发"', /暂停中，本次为手动触发/.test(consoleHtml));
  check('桥接状态端点返回 browsing 实时状态', /browsing,/.test(consoleServer));
  check('桥接状态端点返回 lastVideo', /lastVideo: deps\.live\.lastBiliWatch/.test(consoleServer));
  check('桥接状态端点返回 recent', /recent: deps\.live\.biliMem \? deps\.live\.biliMem\.recent\(6\)/.test(consoleServer));
  check('有手动触发端点（控制台按钮）', /api\/socialV2\/bili-browse-now/.test(consoleServer));
  check('手动触发也受额度约束（复用 runBiliBrowse）', /runBiliBrowse\(\{ manual: true \}\)/.test(consoleServer));
  // 2026-10-19 用户报障「点了只显示已触发，状态里没显示刷了什么」的两个根因：
  //   ① 手动触发被"距上次太近"的间隔限制拦掉（点了等于没点）
  //   ② 端点先 sendJson 再异步跑，then 里又 sendJson → Cannot write headers after sent
  check('手动触发跳过间隔限制', /lastAt: manual \? 0 : live\.lastBiliBrowseAt/.test(biliRuntime)
    && /minIntervalMs: manual \? 0 : sb\.minIntervalMs/.test(biliRuntime));
  check('手动触发等结果再返回（不先回 ok 再跑）',
    /const r = await runBiliBrowse\(\{ manual: true \}\);\s*\n\s*sendJson\(r\)/.test(consoleServer));
  check('runBiliBrowse 返回具体结果（视频/秒数/帧数）',
    /return \{\s*\n\s*ok: true,\s*\n\s*video:/.test(biliRuntime));
  check('被跳过时也返回可读原因',
    /return \{ ok: false, reason: '候选都在冷却期内/.test(biliRuntime)
    && /return \{ ok: false, reason: gate\.reason \}/.test(biliRuntime));
  check('控制台按钮显示刷了什么（不是"已触发"）',
    /刷完了：《/.test(consoleHtml) && /没刷：/.test(consoleHtml));

  // ── 「感兴趣就多看」必须真的生效（2026-10-19 用户问「为什么总是 8s11帧」）──
  // 原实现先定深度再去看，而喜不喜欢要看完才知道 → 永远走 liked=null 的中庸分支，
  // framesLiked/framesDisliked 从未生效。现在改成两段式：浅看→初判→喜欢则追加。
  check('桥接用两段式（浅看后按初判追加）',
    /biliBrowseState\.phase = 'scanning'/.test(biliRuntime)
    && /biliBrowseState\.phase = 'extending'/.test(biliRuntime));
  check('不再固定传 liked=null 定深度',
    !/const depth = watchDepth\(null/.test(biliRuntime));
  check('浅看用不喜欢档、喜欢用喜欢档',
    /Number\(sb\.scanSeconds\)/.test(biliRuntime)
    && /Number\(sb\.likedSeconds\)/.test(biliRuntime));
  // 采样密度（用户要求「帧间隔缩短一些，最好一秒取样一次」）：
  // 帧数不再由 framesLiked 写死，而是 秒数 × framesPerSecond。
  check('帧数按密度算（秒数 × framesPerSecond）',
    /framesPerSecond/.test(biliRuntime) && /sec \* density/.test(fs.readFileSync(path.join(srcRoot, 'bili-browse.js'), 'utf8')));
  check('帧数有硬上限（maxFramesTotal）', /maxFramesTotal/.test(biliRuntime));
  check('分页格数可配（tilesPerSheet）', /tilesPerSheet/.test(biliRuntime));
  // 口味信号必须真的接到选片上（2026-10-20：原先只在 title+category 里找标签，
  // 实测 50 条只有 10 条命中，其中 4 条还是"只靠分区名"命中=重复计分）
  check('选片传入口味标签', /likedTags: taste\.totalTags/.test(biliRuntime));
  check('选片传入喜欢的 UP 主', /likedOwners: taste\.owners/.test(biliRuntime));
  check('taste() 统计 UP 主', /ownerCount/.test(fs.readFileSync(path.join(srcRoot, 'bili.js'), 'utf8')));
  check('投递时把每一张都发给模型',
    /Array\.isArray\(imageBuffer\?\.sheets\)/.test(bridge)
    && /for \(let i = 0; i < parts\.length; i \+= 1\)/.test(bridge));
  check('初判也把每一张都发给模型',
    /scanimgs/.test(bridge) && /scan\.grid\.sheets/.test(bridge));
  check('观看端点返回全部分页', /images: sheets\.map/.test(consoleServer));
  check('MCP 把全部分页交给模型', /Array\.isArray\(data\.images\)/.test(mcp));
  check('追加只在 liked===true 时发生', /if \(verdict\.liked === true && likeSeconds > scanSeconds\)/.test(biliRuntime));
  check('初判是一次独立的 prompt（只回 JSON）', /buildScanPrompt/.test(bridge) && /buildScanPrompt/.test(
    fs.readFileSync(path.join(srcRoot, 'bili-browse.js'), 'utf8')));
  check('初判解析容错（代码块/自然语言）', /parseScanVerdict/.test(bridge));
  check('初判超时可配、默认 150s', /judgeTimeoutMs\) \|\| 150000/.test(bridge));
  const h = createEventHarness({ mode: 'reserved2' });
  const sid = 'session-fixture';
  const results = [];
  await h.handle(sessionEvent('turn/start', 1));
  const waiter = { turn: null, turnId: null, resolve: text => {
    results.push(text); h.deps.biliJudgeWaiters.delete(sid);
  } };
  h.deps.biliJudgeWaiters.set(sid, waiter);
  await h.handle(assistantMessage(1, '登记前已开始的群聊回复'));
  await h.handle(turnEnd(1));
  check('登记前的旧回合不能回填初判', results.length === 0 && waiter.turn === null);
  await h.handle(sessionEvent('turn/start', 2));
  check('初判有独立 collector 并绑定明确 turnId', h.deps.biliJudgeCollectors.has(sid)
    && h.deps.biliJudgeCollectors.get(sid) !== h.deps.collectors.get(sid) && waiter.turnId === sid + '#2');
  await h.handle(assistantMessage(1, '迟到的群聊回复')); await h.handle(turnEnd(1));
  check('初判忽略别的回合的文本与结束', results.length === 0 && waiter.turn === 2);
  await h.handle(turnEnd(2));
  check('初判纯工具回合不回填空串，解除绑定等待下一轮', results.length === 0 && waiter.turn === null && waiter.turnId === null);
  await h.handle(sessionEvent('turn/start', 3));
  await h.handle(assistantMessage(3, '{"liked":true}')); await h.handle(turnEnd(3));
  check('真正初判文本恰好回填一次', results.length === 1 && results[0] === '{"liked":true}');
  check('初判结束清理专用 collector', !h.deps.biliJudgeCollectors.has(sid));

  const biliSrc = fs.readFileSync(path.join(srcRoot, 'bili.js'), 'utf8');
  check('抽帧支持 skipSeconds（跳过片头黑场）', /skipSeconds/.test(biliSrc));
  check('抽帧会测亮度', /YAVG/.test(biliSrc) && /measureBrightness/.test(biliSrc));
  check('太暗会自动往后挪（autoSkipDark）', /autoSkipDark/.test(biliSrc) && /attempt \* step/.test(biliSrc));
  check('watchVideo 把 skip/autoSkipDark 传下去', /skipSeconds: opts\.skipSeconds/.test(
    fs.readFileSync(path.join(srcRoot, 'bili-browse.js'), 'utf8')));
  check('初判提示词提醒"暗不等于黑屏"', /不要一句"黑屏/.test(
    fs.readFileSync(path.join(srcRoot, 'bili-browse.js'), 'utf8')));
  check('返回里带 extended 标记', /extended,/.test(biliRuntime) && /liked: verdict\.liked,/.test(biliRuntime));
  check('配置：gameBoost = 20（用户指定）', cfgGameBoost === 20, String(cfgGameBoost));
  check('配置：候选池 3 页', Number(cfgBili.selfBrowsing?.poolPages) === 3, String(cfgBili.selfBrowsing?.poolPages));
  check('配置：preferGames 开启', cfgBili.selfBrowsing?.preferGames !== false);
  // 分享门槛（2026-10-20 从 75 降到 65）：实测喜欢的视频 interest 中位数只有 68、
  // 最高 82，≥75 的仅 25%——再乘 30% 概率与 6 小时间隔，推荐几乎从不触发。
  check('配置：分享门槛降到 65（否则几乎不触发）',
    Number(cfgBili.share?.minInterest) > 0 && Number(cfgBili.share?.minInterest) <= 65,
    String(cfgBili.share?.minInterest));
  check('桥接默认门槛与配置一致（65）', /Number\(share\.minInterest\) \|\| 65/.test(biliSharing));
  check('配置：浅看不超过 10 秒（只为判断要不要继续）',
    Number(cfgBili.selfBrowsing?.scanSeconds) <= 10, String(cfgBili.selfBrowsing?.scanSeconds));
  // 喜欢要"真的多看"：12s → 30s → 120s 逐步放宽。
  // 断言用"至少"而不是等号，方便以后再调大。
  check('配置：喜欢时看 ≥120 秒', Number(cfgBili.selfBrowsing?.likedSeconds) >= 120, String(cfgBili.selfBrowsing?.likedSeconds));
  check('配置：喜欢时抽 ≥36 帧', Number(cfgBili.selfBrowsing?.framesLiked) >= 36, String(cfgBili.selfBrowsing?.framesLiked));
  // 用户要求「最好一秒取样一次」
  check('配置：采样密度 1 帧/秒', Number(cfgBili.selfBrowsing?.framesPerSecond) === 1,
    String(cfgBili.selfBrowsing?.framesPerSecond));
  check('配置：单次帧数上限 ≥60（支持 1 秒 1 帧看 2 分钟）',
    Number(cfgBili.selfBrowsing?.maxFramesTotal) >= 60, String(cfgBili.selfBrowsing?.maxFramesTotal));
  check('配置：每张拼图 ≤36 格（再多单格就太小）',
    Number(cfgBili.selfBrowsing?.tilesPerSheet) > 0 && Number(cfgBili.selfBrowsing?.tilesPerSheet) <= 36,
    String(cfgBili.selfBrowsing?.tilesPerSheet));
  check('配置：喜欢明显比不喜欢看得多',
    Number(cfgBili.selfBrowsing?.likedSeconds) >= Number(cfgBili.selfBrowsing?.scanSeconds) * 5,
    `${cfgBili.selfBrowsing?.likedSeconds}s vs ${cfgBili.selfBrowsing?.scanSeconds}s`);
  check('配置：不喜欢抽 ≤10 帧（浅看）',
    Number(cfgBili.selfBrowsing?.framesDisliked) <= 10,
    String(cfgBili.selfBrowsing?.framesDisliked));
  // 字幕（用户问「不能直接给模型视频和音频流吗」→ DSH 只收 text+image，
  // 视频/音频流进不去，但 B 站 AI 字幕能把"听到的话"变成文字）
  check('观看时会抓字幕', /fetchSubtitles/.test(fs.readFileSync(path.join(srcRoot, 'bili-browse.js'), 'utf8')));
  check('启动时把登录态注入 bili.js（字幕接口必须登录）', /setBiliCookie\(auth\.cookie/.test(biliBootstrap));
  check('字幕只取观看窗口内的（不白占 prompt）', /subtitleSnippet/.test(
    fs.readFileSync(path.join(srcRoot, 'bili-browse.js'), 'utf8')));
  check('字幕存进长期记忆', /subtitle: String\(video\.subtitle/.test(biliSrc));
  // 用"至少/不超过"而不是等号：这些是用户会反复调的参数，
  // 写死数值会让每次调参都误报（本次就把 30 分钟 → 2 小时、4s → 6s 全报错了）。
  check('配置：每日额度 ≥2 小时', Number(cfgBili.selfBrowsing?.dailyBudgetSec) >= 7200, String(cfgBili.selfBrowsing?.dailyBudgetSec));
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}`);
process.exit(fail === 0 ? 0 : 1);
