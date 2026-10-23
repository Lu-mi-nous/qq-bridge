// 验证新功能：pixiv `artist:<数字ID>` 按画师取图（免登录、可靠）。
// 对照 lack userId=83739（日榜实测存在，596 个作品）。
import { pixiv, translateArtistTag } from '../src/image-sources.js';
import { proxyGet } from '../src/proxy-tunnel.js';

const PROXY = process.env.QQB_PROXY || 'http://127.0.0.1:7897';
let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
// 与下面「网络失败不能静默跳过」的原则不冲突：这里只放过**上游 503 维护**
// 这一种确定性状态（实测 2026-10-21 全站维护到 10-22 凌晨 JST），
// 代理不通、超时、TLS 断开等仍然判失败。
const skipped = (n, why) => { skip++; console.log(`SKIP  ${n}  （${why}）`); };
const isMaintenance = (e) => /站点维护|503/.test(String(e?.message ?? e));

// 构造与 bridge 中同款的 jsonFetch / rawFetch（经代理）。
// 带重试：本机代理对**密集请求**会限流（实测连测易出现 TLS 断开），
// 生产代码里也有同样的退避重试，测试不加重试会把限流误报成功能失败。
const RETRY_WAIT = [1500, 3500];
const jsonFetch = async (url, opts = {}) => {
  let lastErr;
  for (let i = 0; i <= RETRY_WAIT.length; i++) {
    try {
      const r = await proxyGet(url, { proxy: PROXY, headers: { 'user-agent': 'qq-bridge/0.1', ...(opts.referer ? { referer: opts.referer } : {}) }, timeoutMs: 40000 });
      if (r.status < 200 || r.status >= 300) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
      return JSON.parse(r.body.toString('utf8'));
    } catch (e) {
      lastErr = e;
      if (Number.isFinite(e?.status)) throw e; // 确定性失败不重试
      if (RETRY_WAIT[i]) await new Promise((s) => setTimeout(s, RETRY_WAIT[i]));
    }
  }
  throw lastErr;
};
const rawFetch = async (url, opts = {}) => {
  try {
    const r = await proxyGet(url, { proxy: PROXY, headers: { 'user-agent': 'qq-bridge/0.1', ...(opts.referer ? { referer: opts.referer } : {}) }, timeoutMs: 40000 });
    return r.status;
  } catch { return 0; }
};

// ── 离线：语法翻译 ──
check('translateArtistTag(pixiv, artist:83739) 保留数字', translateArtistTag('pixiv', 'artist:83739').tag === '83739');
check('translateArtistTag(pixiv, artist:lack) 去前缀', translateArtistTag('pixiv', 'artist:lack').tag === 'lack');
check('translateArtistTag(yandere, artist:x) 转 user:', translateArtistTag('yandere', 'artist:x').tag === 'user:x');

// ── 在线：按数字 ID 取图 ──
console.log('\n--- 按画师数字 ID 取图（对照 lack/83739）---');
let r = null;
let netErr = '';
let maintenance = false;
try {
  r = await pixiv.fetchList({ tags: ['artist:83739'], limit: 6, jsonFetch, rawFetch });
} catch (e) {
  netErr = e.message;
  maintenance = isMaintenance(e);
  console.log('  fetchList 抛错:', netErr);
}
if (maintenance) {
  skipped('按 ID 取图（上游 503 维护中，未验证）', 'pixiv 维护');
} else if (netErr) {
  // 网络/代理失败不能静默跳过——否则测试会以「更少的断言」假装通过。
  check('按 ID 取图（网络失败，未验证）', false, netErr.slice(0, 70));
} else if (r) {
  check('按 ID 取到作品', r.length > 0, `${r.length} 条`);
  if (r.length) {
    const allLack = r.every((e) => e.artist === 'lack');
    check('返回的都是该画师的作品', allLack, `作者: ${[...new Set(r.map((e) => e.artist))].join(',')}`);
    check('条目带 artistId=83739', r.every((e) => e.artistId === '83739'));
    check('URL 可下载（img-original）', r.every((e) => /img-original/.test(e.url)), r[0]?.url?.slice(-40));
    check('全年龄（rating=safe）', r.every((e) => e.rating === 'safe'));
  }
}

// ── 对照：不存在的数字 ID 应报错而非静默返回空 ──
console.log('\n--- 不存在的画师 ID ---');
try {
  const bad = await pixiv.fetchList({ tags: ['artist:99999999999'], limit: 4, jsonFetch, rawFetch });
  check('不存在的 ID 不返回图', bad.length === 0, `${bad.length} 条`);
} catch (e) {
  // 只认 pixiv 的「用户不存在」错误；网络/代理错误不算通过（否则测试会假装成功）。
  // 维护期连"用户不存在"都问不到，如实跳过。
  if (isMaintenance(e)) skipped('不存在的 ID 报「用户不存在」', 'pixiv 维护');
  else {
    const isPixivNoUser = /存在しない|退会|用户|ユーザー/.test(e.message);
    check('不存在的 ID 报「用户不存在」', isPixivNoUser, e.message.slice(0, 70));
  }
}

// ── 裸数字标签不能被当成画师 ID ──
// 否则查询 ["2026"] 这类普通数字标签会被误解为「画师 2026」，静默走错分支。
console.log('\n--- 裸数字标签（无 artist: 前缀）---');
{
  const bare = await pixiv.fetchList({ tags: ['83739'], limit: 2, jsonFetch, rawFetch }).catch((e) => ({ err: e.message }));
  const isArr = Array.isArray(bare);
  // 关键断言：不能返回 lack 的作品（那说明走了画师分支）
  const hitLack = isArr && bare.some((e) => e.artist === 'lack');
  check('裸数字标签不走画师 ID 分支', !hitLack, isArr ? `${bare.length} 条, 作者=${[...new Set(bare.map((e) => e.artist))].join(',') || '无'}` : `抛错:${String(bare.err).slice(0, 40)}`);
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
