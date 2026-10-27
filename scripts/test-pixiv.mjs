// 回归测试：pixiv 源（需代理；图床需 Referer）。
// 覆盖：日榜、关键词搜索、分级过滤（sexual/xRestrict=0）、原图 URL 推导、格式探测。
import { fetchFromSources, pixiv, SOURCES } from '../plugins/images/lib/image-sources.js';
import { proxyGet } from '../src/proxy-tunnel.js';

const PROXY = process.env.QQB_PROXY || 'http://127.0.0.1:7897';
const REFERER = { referer: 'https://www.pixiv.net/' };
let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const skipped = (n) => { skip++; console.log(`SKIP  ${n}`); };

let proxyOk = true;
try {
  const r = await proxyGet('https://www.pixiv.net/ranking.php?mode=daily&content=illust&format=json', {
    proxy: PROXY, headers: { 'user-agent': 'qq-bridge/0.1', ...REFERER }, timeoutMs: 20000
  });
  proxyOk = r.status === 200;
} catch { proxyOk = false; }
console.log(`代理 ${PROXY}: ${proxyOk ? '可用' : '不可用'}\n`);

// ── 离线 ──
check('pixiv 已注册', SOURCES.pixiv === pixiv);
check('标记需要代理', pixiv.requiresProxy === true);
check('无需登录（实测图床只要 Referer）', pixiv.needsAuth === false);
check('未注入代理时报错', await (async () => {
  try { await pixiv.fetchList({ tags: ['x'] }); return false; } catch (e) { return /代理/.test(e.message); }
})());

// 原图 URL 推导：日榜与搜索两种缩略图后缀都要能解析
for (const [label, thumb] of [
  ['日榜 master1200', 'https://i.pximg.net/c/480x960/img-master/img/2026/09/23/00/00/27/149989168_p0_master1200.jpg'],
  ['搜索 square1200', 'https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/09/24/11/58/49/150045816_p0_square1200.jpg'],
  ['搜索 custom1200', 'https://i.pximg.net/c/250x250_80_a2/custom-thumb/img/2026/09/24/14/14/41/150048427_p0_custom1200.jpg'],
]) {
  const base = pixiv._toOriginalBase(thumb);
  const ok = /img-original\/img\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d+_p\d+$/.test(base);
  check(`原图 URL 推导：${label}`, ok, base.slice(-42));
}
check('非法缩略图返回空', pixiv._toOriginalBase('not-a-pixiv-url') === '');

// ── 联网 ──
if (!proxyOk) {
  skipped('联网用例（代理不可用）');
} else {
  const SRC = { pixiv: { enabled: true, limit: 8, proxy: PROXY } };

  // 日榜
  {
    const r = await fetchFromSources(SRC, { limit: 8 });
    check('日榜能拉到图', r.entries.length > 0, `条数=${r.entries.length} 错误=${r.errors.join(';') || '无'}`);
    check('日榜结果全为 safe', r.entries.every((e) => e.rating === 'safe'));
    check('结果来源标记正确', r.entries.every((e) => e.source === 'pixiv'));
    check('含画师与作品页', r.entries.every((e) => !!e.artist && /artworks\/\d+/.test(e.page)));
    // 榜单名次 → 分数应递减（越靠前越高）
    const scores = r.entries.map((e) => e.score);
    check('按名次排序（分数递减）', scores.every((s, i) => i === 0 || scores[i - 1] >= s), scores.slice(0, 5).join(','));
  }

  // 关键词搜索（薄荷的日文名）
  {
    const r = await fetchFromSources(SRC, { tags: ['ミント'], limit: 6 });
    check('按关键词搜索能拉到图', r.entries.length > 0, `条数=${r.entries.length}`);
    check('搜索结果全为 safe', r.entries.every((e) => e.rating === 'safe'));
  }

  // 格式探测：结果里应至少出现 jpg，且不出现无扩展名的 URL
  {
    const r = await fetchFromSources(SRC, { limit: 10 });
    const exts = [...new Set(r.entries.map((e) => e.url.split('.').pop()))];
    check('URL 均带合法扩展名', exts.every((x) => ['jpg', 'png', 'gif'].includes(x)), `扩展名=${exts.join(',')}`);
  }

  // 图床 Referer 硬要求：不带 Referer 必须 403，带上必须 200
  {
    const r = await fetchFromSources(SRC, { limit: 2 });
    const target = r.entries[0];
    if (target) {
      let noRef = 0, withRef = 0;
      try {
        const a = await proxyGet(target.url, { proxy: PROXY, headers: { 'user-agent': 'qq-bridge/0.1' }, headOnly: true, timeoutMs: 20000 });
        noRef = a.status;
      } catch { noRef = -1; }
      try {
        const b = await proxyGet(target.url, { proxy: PROXY, headers: { 'user-agent': 'qq-bridge/0.1', ...REFERER }, headOnly: true, timeoutMs: 20000 });
        withRef = b.status;
      } catch { withRef = -1; }
      check('不带 Referer 被图床拒绝（403）', noRef === 403, `实际 ${noRef}`);
      check('带 Referer 可访问（200）', withRef === 200, `实际 ${withRef}`);
    }
  }

  // 真实下载一张（带重试，代理链路偶发断连）
  {
    let ok = false, note = '';
    for (let i = 0; i < 3 && !ok; i++) {
      const r = await fetchFromSources(SRC, { limit: 4 });
      const t = r.entries[i % Math.max(1, r.entries.length)];
      if (!t) { note = '无条目'; continue; }
      try {
        const img = await proxyGet(t.url, { proxy: PROXY, headers: { 'user-agent': 'qq-bridge/0.1', ...REFERER }, maxBytes: 8 * 1024 * 1024, timeoutMs: 45000 });
        const isImg = img.body[0] === 0xff || img.body[0] === 0x89;
        if (img.status === 200 && isImg) { ok = true; note = `${(img.body.length / 1048576).toFixed(2)}MB`; }
        else note = `HTTP ${img.status}`;
      } catch (e) { note = e.message.slice(0, 35); }
    }
    check('真实下载得到有效图片', ok, note);
  }
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
