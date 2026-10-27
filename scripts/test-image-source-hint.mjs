// 回归测试：从群友的话里识别指定图源 + 会话级记忆。
import { detectSourceRequest, createSourceHintStore } from '../plugins/images/lib/image-source-hint.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

console.log('── 真实场景（截图里那句）──');
{
  const r = detectSourceRequest('@dsh pixiv上找几张安洁丽娜的图');
  check('「pixiv上找几张…的图」→ pixiv', r.sources.includes('pixiv'), JSON.stringify(r));
}

console.log('\n── 应当识别 ──');
const yes = [
  ['从 pixiv 找', '从pixiv找'],
  ['pixiv 上找几张', 'pixiv上找几张图'],
  ['用 safebooru 的', '用safebooru的图'],
  ['只要 yande.re 的', '只要yande.re的图'],
  ['来张 p 站的', '来张p站的图'],
  ['safebooru 上搜', 'safebooru上搜一下'],
  ['PIXIV 要大写', 'PIXIV上找图'],
  ['y 站有吗', 'y站有图吗'],
  ['几张 pixiv 的存货', '来几张pixiv的存货'],
  ['大小写混写', '从 Pixiv 找张图'],
];
for (const [label, text] of yes) {
  const r = detectSourceRequest(text);
  check(`${label}：${text}`, r.sources.length > 0, `→ ${r.sources.join(',')} (${r.reason})`);
}

console.log('\n── 多站同时指定 ──');
{
  const r = detectSourceRequest('pixiv和safebooru上都找找');
  check('同时提到两站 → 两个都要', r.sources.length === 2, r.sources.join(','));
}

console.log('\n── 不该识别（宁可不认也别认错）──');
const no = [
  ['只是聊到 pixiv', '我今天在pixiv逛了逛'],
  ['说站点故障', 'pixiv上不去了'],
  ['说站点故障2', 'safebooru打不开了'],
  ['否定语气', 'pixiv加载好慢'],
  ['与图无关', 'pixiv这个网站做得不错'],
  ['没提站点', '来几张安洁丽娜的图'],
  ['空消息', ''],
  ['普通聊天', '今天天气不错'],
];
for (const [label, text] of no) {
  const r = detectSourceRequest(text);
  check(`${label}：${text}`, r.sources.length === 0, `(${r.reason})`);
}

console.log('\n── 会话记忆（带时效）──');
{
  let t = 1_000_000;
  const store = createSourceHintStore({ ttlMs: 600_000, now: () => t });
  store.remember('group:1', ['pixiv'], 'pixiv上找几张');
  check('记住后可取回', store.get('group:1')?.sources.join(',') === 'pixiv');
  check('别的会话不受影响', store.get('group:2') === null);

  t += 60_000;
  check('1 分钟后仍有效（"再来一张"要靠它）', store.get('group:1')?.sources.join(',') === 'pixiv');

  t += 600_000; // 累计 11 分钟
  check('超过 TTL 后失效', store.get('group:1') === null, '过期应自动清');

  // 没指定时不该覆盖已有记忆
  store.remember('group:3', ['safebooru'], 'x');
  store.remember('group:3', [], '未指定');
  check('空数组不覆盖已有记忆', store.get('group:3')?.sources.join(',') === 'safebooru');

  store.clear('group:3');
  check('clear 单会话', store.get('group:3') === null);

  // 时间戳 0 的边界（同 error-notifier 的坑）
  let t2 = 0;
  const s2 = createSourceHintStore({ ttlMs: 1000, now: () => t2 });
  s2.remember('k', ['pixiv']);
  check('时间戳 0 时能取回（不用 0 当哨兵）', s2.get('k')?.sources.join(',') === 'pixiv');
  t2 = 1001;
  check('时间戳 0 起步也能正常过期', s2.get('k') === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
