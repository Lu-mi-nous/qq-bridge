// 回归测试：yande.re 源（需代理 + 分级过滤）。
// 依赖：本机代理 127.0.0.1:7897 可用，否则相关用例会跳过并说明。
import { fetchFromSources, yandere, SOURCES } from '../plugins/images/lib/image-sources.js';
import { proxyGet, isBlockedHost } from '../src/proxy-tunnel.js';

const PROXY = process.env.QQB_PROXY || 'http://127.0.0.1:7897';
let pass = 0, fail = 0, skip = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};
const skipped = (name) => { skip++; console.log(`SKIP  ${name}`); };

// 代理可达性预检
let proxyOk = true;
try {
  const r = await proxyGet('https://yande.re/tag.json?limit=1', { proxy: PROXY, headers: { 'user-agent': 'qq-bridge/0.1' }, timeoutMs: 20000 });
  proxyOk = r.status === 200;
} catch { proxyOk = false; }

console.log(`代理 ${PROXY}: ${proxyOk ? '可用' : '不可用'}\n`);

// ── 离线用例（不依赖网络）──
check('yandere 已注册', SOURCES.yandere === yandere);
check('标记需要代理', yandere.requiresProxy === true);
// SSRF 拦截必须对代理路径同样生效
for (const h of ['127.0.0.1', '192.168.1.1', '10.0.0.1', 'localhost', '169.254.1.1', '172.16.0.1']) {
  check(`SSRF 拦截 ${h}`, isBlockedHost(h) === true);
}
check('正常域名放行', isBlockedHost('yande.re') === false && isBlockedHost('files.yande.re') === false);
// 分级判定：yande.re 用 s/q/e
check('分级 s 判为安全', yandere.normalizeSafe({ rating: 's' }) === true);
check('分级 q 被拒', yandere.normalizeSafe({ rating: 'q' }) === false);
check('分级 e 被拒', yandere.normalizeSafe({ rating: 'e' }) === false);
// 未注入 jsonFetch 时应明确报错（而非静默失败）
try {
  await yandere.fetchList({ tags: ['x'] });
  check('未注入代理时应报错', false, '未抛异常');
} catch (e) {
  check('未注入代理时应报错', /代理/.test(e.message), e.message.slice(0, 40));
}

// ── 联网用例 ──
if (!proxyOk) {
  skipped('联网用例（代理不可用）');
} else {
  const SRC = { yandere: { enabled: true, limit: 8, proxy: PROXY } };

  // 核心安全线：返回的图必须全是 safe 分级
  {
    const r = await fetchFromSources(SRC, { tags: ['neverness_to_everness'], limit: 8 });
    check('按标签能查到', r.entries.length > 0, `条数=${r.entries.length} 错误=${r.errors.join(';') || '无'}`);
    const ratings = [...new Set(r.entries.map((e) => e.rating))];
    check('结果全为 safe 分级', ratings.every((x) => x === 's'), `分级=${ratings.join(',')}`);
    check('结果来源标记正确', r.entries.every((e) => e.source === 'yandere'));
    // 每张图都应有可下载 URL
    check('每条都有图片直链', r.entries.every((e) => /^https:/.test(e.url)));
  }

  // 优先 sample（原图可达 19MB，sample 通常 0.4MB）——避免下载超限
  {
    const r = await fetchFromSources(SRC, { tags: ['neverness_to_everness'], limit: 5 });
    const big = r.entries.filter((e) => (e.size || 0) > 8 * 1024 * 1024);
    const maxMB = r.entries.length ? (Math.max(...r.entries.map((e) => e.size || 0)) / 1048576).toFixed(1) : 'n/a';
    check('未返回超 8MB 的图（应优先 sample）', r.entries.length > 0 && big.length === 0,
      big.length ? `超限 ${big.length} 张` : `最大 ${maxMB}MB`);
  }

  // 真实下载一张，确认真是有效图片。
  // 带重试：代理链路有偶发断连（实测 "socket disconnected before TLS"），
  // 那是网络抖动而非代码问题，不该让测试误报失败。
  {
    let ok = false;
    let note = '';
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const r = await fetchFromSources(SRC, { tags: ['neverness_to_everness'], limit: 3 });
      const target = r.entries[attempt % Math.max(1, r.entries.length)] ?? r.entries[0];
      if (!target) { note = '没有可用条目'; continue; }
      try {
        const img = await proxyGet(target.url, {
          proxy: PROXY, headers: { 'user-agent': 'qq-bridge/0.1' }, maxBytes: 8 * 1024 * 1024, timeoutMs: 45000
        });
        const isImg = img.body[0] === 0xff || img.body[0] === 0x89 || img.body.subarray(0, 4).toString('ascii') === 'RIFF';
        if (img.status === 200 && isImg) { ok = true; note = `${(img.body.length / 1048576).toFixed(2)}MB`; }
        else note = `HTTP ${img.status} 非图片`;
      } catch (e) { note = e.message.slice(0, 40); }
    }
    check('经代理下载得到有效图片', ok, note);
  }

  // 门：未配代理时该源应被跳过并给出可读错误（而不是静默无图）
  {
    const r = await fetchFromSources({ yandere: { enabled: true } }, { tags: ['x'] });
    check('缺代理配置时报错可读', r.entries.length === 0 && r.errors.some((e) => /代理/.test(e)),
      r.errors[0]?.slice(0, 50) ?? '(无错误)');
  }

  // 双源并行：safebooru 直连 + yandere 走代理，互不干扰
  {
    const r = await fetchFromSources({
      safebooru: { enabled: true, limit: 4 },
      yandere: { enabled: true, limit: 4, proxy: PROXY }
    }, { tags: ['neverness_to_everness'], limit: 4 });
    const srcs = [...new Set(r.entries.map((e) => e.source))].sort();
    check('双源聚合都有结果', srcs.includes('safebooru') && srcs.includes('yandere'), `来源=${srcs.join(',')}`);
  }

  // 无标签兜底：yande.re 没有 1girl/solo 这类通用标签（实测查询返回 0 条），
  // 必须用 wallpaper/landscape/tagme 等实测可用的主题标签兜底。
  {
    const r = await fetchFromSources(SRC, { limit: 6 });
    check('无标签时兜底能拉到图', r.entries.length > 0,
      `条数=${r.entries.length} 错误=${r.errors.join(';') || '无'}`);
    check('兜底结果也全是 safe', r.entries.every((e) => e.rating === 's'));
  }
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);


