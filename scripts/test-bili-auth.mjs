// 回归测试：B 站凭据读取、搜索、推荐分享。
//
// 背景（2026-10-19 用户要求）：
//   「加上账号凭据，让它能够自行搜索感兴趣的内容」
//   「推荐视频的时候顺便给出标题和链接」
//
// 关键实测发现：B 站 `search/type` 在**完全不带 Cookie** 时返回
// `-412 request was banned`；带上任意 buvid3 就正常返回 20 条/页。
// 即"凭据不是必须登录，而是必须有设备/登录标识"。
//
// 本测试锁住：
//   ① 凭据只从 state/ 读、日志与返回值绝不泄露 cookie
//   ② 缺凭据时能降级到匿名设备号（搜索仍可用）
//   ③ 搜索结果的标题要剥掉 <em> 高亮、duration 要转成秒
//   ④ 推荐分享必须带**标题 + 链接**，且链接由桥接拼（不让模型编）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadBiliAuth, searchVideos, buildSearchKeywords, pickSearchQuery
} from '../src/bili-auth.js';

let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const skipped = (n, why) => { skip++; console.log(`SKIP  ${n}  （${why}）`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'biliauth-'));

// ── 1. 凭据读取 ──
console.log('── 1. 凭据读取 ──');
{
  const f = path.join(tmp, 'a.json');
  fs.writeFileSync(f, JSON.stringify({ SESSDATA: 'abc%2C123', buvid3: 'BV-xx', bili_jct: 'jct', dedeuserid: '42' }));
  const r = loadBiliAuth(f);
  check('读到登录态', r.loaded === true && r.hasSessdata === true);
  check('cookie 拼装正确', /SESSDATA=abc%2C123/.test(r.cookie) && /buvid3=BV-xx/.test(r.cookie));
  check('包含 bili_jct 与 DedeUserID', /bili_jct=jct/.test(r.cookie) && /DedeUserID=42/.test(r.cookie));
  check('无多余字段泄漏到 cookie', !/abc/.test(r.cookie.replace('SESSDATA=abc%2C123', '')));

  // 只有 buvid3：可用但非登录态
  const f2 = path.join(tmp, 'b2.json');
  fs.writeFileSync(f2, JSON.stringify({ buvid3: 'only-device' }));
  const r2 = loadBiliAuth(f2);
  check('只有设备号也算已加载', r2.loaded === true && r2.hasSessdata === false);
  check('并说明不是登录态', /未包含登录态/.test(String(r2.reason)));

  // 都没有
  const f3 = path.join(tmp, 'b3.json');
  fs.writeFileSync(f3, JSON.stringify({ foo: 1 }));
  check('空凭据判为未配置', loadBiliAuth(f3).loaded === false);
  check('文件不存在不崩', loadBiliAuth(path.join(tmp, 'nope.json')).loaded === false);
  check('非法 JSON 不崩', (() => {
    const p = path.join(tmp, 'bad.json');
    fs.writeFileSync(p, '{ not json');
    return loadBiliAuth(p).loaded === false;
  })());
  check('null 路径不崩', loadBiliAuth(null).loaded === false);

  // 关键：任何失败信息里都不能出现凭据内容
  fs.writeFileSync(path.join(tmp, 'leak.json'), JSON.stringify({ SESSDATA: '', buvid3: '', note: 'SECRET' }));
  const leak = loadBiliAuth(path.join(tmp, 'leak.json'));
  check('失败原因不含凭据内容', !/SECRET/.test(String(leak.reason)));
}

// ── 2. 搜索关键词生成 ──
console.log('\n── 2. 搜索关键词 ──');
{
  const kw = buildSearchKeywords(
    { likedTags: [{ name: '鬼畜' }, { name: '整活' }], categories: [{ name: '游戏' }] },
    ['鸣潮', '原神']
  );
  check('游戏排最前', kw[0] === '鸣潮' && kw[1] === '原神', kw.join(','));
  check('包含记忆里喜欢的标签', kw.includes('鬼畜') && kw.includes('整活'), kw.join(','));
  check('分区名做了映射', kw.includes('游戏实况'), kw.join(','));
  check('数量受限', buildSearchKeywords({ likedTags: Array.from({ length: 20 }, (_, i) => ({ name: `t${i}` })) }, [], { max: 3 }).length === 3);
  check('空输入不崩', buildSearchKeywords(null, null).length === 0);
  check('去重', (() => { const k = buildSearchKeywords({ likedTags: [{ name: '鸣潮' }] }, ['鸣潮']); return k.filter((x) => x === '鸣潮').length === 1; })());

  // 2026-10-20：游戏名不能占满关键词池，否则记忆里的兴趣标签永远进不来、
  // 搜索退化成"只按游戏名搜"（实测 7 个游戏名把 max=6 全填满了）。
  {
    const games = ['鸣潮', '明日方舟', '原神', '绝区零', '崩坏：星穹铁道', '英雄联盟', '明日方舟：终末地'];
    const k = buildSearchKeywords(
      { likedTags: [{ name: '整活' }, { name: '治愈' }, { name: '音乐' }] }, games, { max: 6 });
    const gameCount = k.filter((x) => games.includes(x)).length;
    check('游戏词不占满关键词池（留位给兴趣标签）', gameCount < k.length, k.join(','));
    check('兴趣标签能进关键词池', k.includes('整活') || k.includes('治愈'), k.join(','));
    check('泛词不进搜索关键词', !k.includes('音乐'), k.join(','));
  }

  // 随机挑一个
  const picked = new Set();
  for (let i = 0; i < 200; i++) picked.add(pickSearchQuery(['a', 'b', 'c']));
  check('随机能覆盖所有关键词', picked.size === 3, [...picked].join(','));
  check('空列表返回空串', pickSearchQuery([]) === '');
}

// ── 3. 真实搜索（无凭据走匿名设备号）──
console.log('\n── 3. 真实搜索 ──');
{
  try {
    const r = await searchVideos('鸣潮', null, { count: 5 });
    if (!r.length) {
      skipped('搜索返回结果', '上游返回空');
    } else {
      check('无凭据也能搜到（匿名 buvid3 生效）', r.length > 0, `${r.length} 条`);
      check('结果含 bvid', r.every((v) => /^BV[0-9A-Za-z]{10}$/.test(v.bvid)));
      check('标题已剥掉 <em> 高亮标签', r.every((v) => !/<[^>]+>/.test(v.title)), r[0]?.title?.slice(0, 30));
      check('duration 转成了秒（数字）', r.every((v) => typeof v.durationSec === 'number' && v.durationSec >= 0), String(r[0]?.durationSec));
      check('封面补了 https 协议', r.every((v) => !v.cover || /^https:/.test(v.cover)), r[0]?.cover?.slice(0, 30));
      check('结果与关键词相关', r.some((v) => /鸣潮/.test(v.title) || /鸣潮/.test(v.owner)), r[0]?.title?.slice(0, 30));
    }
    // 多页取数
    const r2 = await searchVideos('原神', null, { count: 25 });
    check('count>20 时会翻页', r2.length > 20, `${r2.length} 条`);
    check('翻页后仍去重', new Set(r2.map((v) => v.bvid)).size === r2.length);
  } catch (e) {
    skipped('真实搜索', e.message.slice(0, 70));
  }
}

// ── 3b. 搜索结果的 cid 必须缺失并被告知（2026-10-19 实测踩坑）──
//
// search/type 返回的 `cid` **恒为 0**。若直接拿去调 playurl 会 `-400 请求错误`，
// 表现为"看视频失败"。现在 watchVideo 在 cid<=0 时补一次 view 请求。
console.log('\n── 3b. cid 缺失与补全 ──');
{
  try {
    const r = await searchVideos('原神', null, { count: 3 });
    if (!r.length) {
      skipped('搜索结果不带 cid', '上游返回空');
    } else {
      check('搜索结果不带 cid（恒为 0）', r.every((v) => !v.cid), r.map((v) => v.cid).join(','));
    }
  } catch (e) {
    skipped('搜索结果不带 cid', e.message.slice(0, 50));
  }

  const browse = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1'), '..', 'src', 'bili-browse.js'),
    'utf8'
  );
  check('watchVideo 在 cid 缺失时补查 view',
    /if \(!Number\(info\?\.cid\)\)/.test(browse) && /info = await fetchVideoInfo/.test(browse));
}

// ── 4. 接线检查 ──
console.log('\n── 4. 接线 ──');
{
  const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
  const consoleServer = fs.readFileSync(path.join(root, 'src/console-server.js'), 'utf8');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

  // 列表/搜索降级与最终推荐行为见 test-bili-runtime / test-bili-sharing。
  check('状态端点暴露搜索关键词', /lastKeyword: deps\.live\.lastBiliSearchKeyword/.test(consoleServer));
  check('状态端点不暴露 cookie', !/cookie:/.test(consoleServer.split("pathname === '/api/socialV2/bili-status'")[1]?.slice(0, 3000) || ''));

  // ── 群友要推荐时必须"现场搜新视频"（2026-10-19 用户反馈「为什么没有新增的视频」）──
  //
  // 根因：原来只有 `qq_bili_memory`（查已有记忆），没有搜索工具。
  // 群友问"推荐点视频"时模型只能翻旧账，还会临时编没链接的内容。
  const mcp = fs.readFileSync(path.join(root, 'src/mcp-snowluma-safe.js'), 'utf8');
  const preset = fs.readFileSync(path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');

  check('有现场搜索端点', /\/api\/socialV2\/bili-search/.test(consoleServer));
  check('搜索端点过滤已看过的（推荐"新的"）', /fresh = videos\.filter\(\(v\) => !deps\.live\.biliMem\?\.get\(v\.bvid\)\)/.test(consoleServer));
  check('全看过时明确告知（allSeen）', /allSeen: fresh\.length === 0/.test(consoleServer));
  check('MCP 有 qq_bili_search 工具', /'qq_bili_search'/.test(mcp));
  check('工具返回带真实 URL', /https:\/\/www\.bilibili\.com\/video\/\$\{v\.bvid\}/.test(mcp));
  check('工具要求原样使用标题和链接', /标题和链接必须原样使用|不要自己编/.test(mcp));
  check('preset 要求推荐时现场搜', /必须现场搜，不要翻旧账/.test(preset));
  check('preset 禁止编造 bvid/链接', /绝不要自己拼、改写或凭印象编/.test(preset));
  check('preset 提示 allSeen 时换关键词', /allSeen.*换个关键词/.test(preset));
  check('preset 工具清单列出搜索工具', /qq_bili_search：现场搜/.test(preset));

  check('配置有 authFile', typeof cfg.socialV2?.bili?.authFile === 'string');
  check('authFile 指向 state/', /state\/bili-auth\.json/.test(cfg.socialV2?.bili?.authFile));
  check('搜索默认开启', cfg.socialV2?.bili?.selfBrowsing?.search?.enabled !== false);
  check('分享默认开启', cfg.socialV2?.bili?.share?.enabled !== false);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}`);
process.exit(fail === 0 ? 0 : 1);
