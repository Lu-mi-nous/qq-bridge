// 回归测试：pixiv 凭据读取与请求头注入。
//
// 背景（2026-10-21 用户）：「pixiv有办法通过账号凭据绕开限制吗」→「先把凭据配置接口做出来」。
//
// 实测前提（必须写清楚，避免以后有人误以为是"凭据能解锁一切"）：
//   2026-10-21 pixiv 全站 503，页面原文是"pixiv is currently under maintenance ...
//   October 22, 2026 (JST) ... update patch for a vulnerability"。
//   也就是说那次是**官方维护**，任何 Cookie 都无效。凭据只解决另外三件事：
//   匿名被限流、部分接口对未登录返回空壳、将来的个性化内容。
//
// 本测试锁住六件事：
//   ① 凭据只从 state/ 读，日志与返回值绝不出现凭据内容
//   ② 缺凭据 / 字段为空时**完全匿名**（请求头里连 cookie 键都不出现）
//   ③ 支持两种写法：分开的字段，或整串 cookie
//   ④ Cookie **只发给 www.pixiv.net**，不能漏给别的图源（safebooru / yande.re）
//   ⑤ 503 的报错要说明"维护或限流"，而不是让人以为是标签写错
//   ⑥ 控制台凭据项与桥接接线齐全
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPixivAuth, setPixivCookie, hasPixivCookie, withPixivAuth
} from '../src/pixiv-auth.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixivauth-'));
const SECRET = '1234567_SECRET_SESSION_VALUE';

// ── 1. 凭据读取 ──
console.log('── 1. 凭据读取 ──');
{
  const f = path.join(tmp, 'a.json');
  fs.writeFileSync(f, JSON.stringify({ PHPSESSID: SECRET, device_token: 'dt-abc' }));
  const r = loadPixivAuth(f);
  check('读到登录态', r.loaded === true && r.hasSession === true);
  check('cookie 拼装正确', r.cookie === `PHPSESSID=${SECRET}; device_token=dt-abc`);

  // 只有 device_token：能加载但不算登录
  const f2 = path.join(tmp, 'b.json');
  fs.writeFileSync(f2, JSON.stringify({ device_token: 'only-device' }));
  const r2 = loadPixivAuth(f2);
  check('只有 device_token 也算已加载', r2.loaded === true);
  check('但明确不是登录态', r2.hasSession === false && /没有登录态/.test(String(r2.reason)));

  // 整串 cookie 写法
  const f3 = path.join(tmp, 'c.json');
  fs.writeFileSync(f3, JSON.stringify({ cookie: `PHPSESSID=${SECRET}; device_token=zzz; other=1` }));
  const r3 = loadPixivAuth(f3);
  check('支持整串 cookie', r3.loaded === true && /PHPSESSID=/.test(r3.cookie) && /other=1/.test(r3.cookie));
  check('整串写法能识别出登录态', r3.hasSession === true);

  // 整串不是 Cookie 头（比如粘了 URL）→ 拒绝，不能把一个网址当 cookie 发出去
  const f4 = path.join(tmp, 'd.json');
  fs.writeFileSync(f4, JSON.stringify({ cookie: 'https://www.pixiv.net/artworks/123' }));
  check('整串不像 Cookie 时拒绝', loadPixivAuth(f4).loaded === false);

  // 空 / 缺失 / 损坏
  const f5 = path.join(tmp, 'e.json');
  fs.writeFileSync(f5, JSON.stringify({ PHPSESSID: '', device_token: '' }));
  check('字段全空判为未配置', loadPixivAuth(f5).loaded === false);
  check('文件不存在不崩', loadPixivAuth(path.join(tmp, 'nope.json')).loaded === false);
  check('非法 JSON 不崩', (() => {
    const p = path.join(tmp, 'bad.json');
    fs.writeFileSync(p, '{ not json');
    return loadPixivAuth(p).loaded === false;
  })());
  check('null 路径不崩', loadPixivAuth(null).loaded === false);

  // 关键：任何失败信息都不能回显凭据内容
  const f6 = path.join(tmp, 'leak.json');
  fs.writeFileSync(f6, JSON.stringify({ note: SECRET }));
  const leak = loadPixivAuth(f6);
  check('失败原因不含凭据内容', !String(leak.reason).includes(SECRET));

  // 换行会被裁掉（从 DevTools 复制常带换行，带进去会让请求头非法）
  const f7 = path.join(tmp, 'nl.json');
  fs.writeFileSync(f7, JSON.stringify({ PHPSESSID: `${SECRET}\r\n` }));
  const r7 = loadPixivAuth(f7);
  check('裁掉换行', !/[\r\n]/.test(r7.cookie));
}

// ── 2. 注入行为：默认匿名 ──
console.log('\n── 2. 请求头注入 ──');
{
  setPixivCookie('');
  check('默认匿名', hasPixivCookie() === false);
  const h = { referer: 'https://www.pixiv.net/', accept: 'application/json' };
  const out = withPixivAuth(h);
  check('匿名时不添加 cookie 键', !('cookie' in out));
  check('匿名时原样返回（不新建无谓对象）', out === h);

  setPixivCookie(`PHPSESSID=${SECRET}`);
  check('注入后 hasPixivCookie 为真', hasPixivCookie() === true);
  const out2 = withPixivAuth({ referer: 'x' });
  check('注入后带上 cookie', out2.cookie === `PHPSESSID=${SECRET}`);
  check('不修改入参对象', !('cookie' in { referer: 'x' }));

  // 清空要真的清掉（控制台把值删掉后保存，应立即回到匿名）
  setPixivCookie('');
  check('可以回到匿名', hasPixivCookie() === false && !('cookie' in withPixivAuth({})));

  // 换行注入防御：cookie 里带换行会让请求头拼接出错（CRLF 注入）
  setPixivCookie(`PHPSESSID=abc\r\nX-Evil: 1`);
  check('注入时裁掉换行（防 CRLF）', !/[\r\n]/.test(withPixivAuth({}).cookie));
  setPixivCookie('');
}

// ── 3. 只发给 pixiv，不漏给别的源 ──
console.log('\n── 3. 凭据作用域 ──');
{
  const s = fs.readFileSync(path.join(root, 'src/image-sources.js'), 'utf8');
  // 关键设计：cookie 包在 pixiv 适配器内部（apiFetch），而不是加在 fetchFromSources
  // 那个所有源共用的 jsonFetch 工厂上——否则 safebooru / yande.re 也会收到 pixiv 的凭据。
  check('pixiv 适配器内部包了一层 apiFetch', /const apiFetch = async \(url, headers = \{\}\) => \{/.test(s));
  check('apiFetch 里才加凭据', /hasPixivCookie\(\) \? withPixivAuth\(headers\) : headers/.test(s));
  // 4 个 pixiv API 调用点必须都换成 apiFetch
  const pixivBlock = s.slice(s.indexOf('export const pixiv'), s.indexOf('export const yandere'));
  check('画师作品查询走 apiFetch', /apiFetch\(url, \{ referer, accept/.test(pixivBlock));
  check('作品链接解析走 apiFetch', /apiFetch\(`https:\/\/www\.pixiv\.net\/ajax\/illust\//.test(pixivBlock));
  check('关键词搜索走 apiFetch', /const data = await apiFetch\(url, \{ referer, accept/.test(pixivBlock));
  check('日榜走 apiFetch', /await apiFetch\(url, \{ referer: `\$\{referer\}ranking\.php` \}\)/.test(pixivBlock));
  // apiFetch 内部当然要调 jsonFetch（它就是包装层）。真正要防的是
  // **业务代码绕过 apiFetch 直接调 jsonFetch**——那会让该请求漏掉凭据。
  const directCalls = (pixivBlock.match(/await jsonFetch\(/g) ?? []).length;
  check('业务代码不绕过 apiFetch 直接调 jsonFetch', directCalls === 1, `${directCalls} 处`);

  // 图床探测（i.pximg.net）**不该**带 cookie：那里只需要 Referer，
  // 而且 pximg 是独立域，把 www 的会话 cookie 发过去毫无意义。
  check('图床探测不带凭据', /rawFetch\(`\$\{baseNoExt\}\.\$\{ext\}`, \{ referer \}\)/.test(pixivBlock));

  // 共享工厂里不能出现 cookie
  const factory = s.slice(s.indexOf('jsonFetch = async (url, extraHeaders'), s.indexOf('rawFetch = async (url, extraHeaders'));
  check('共用的 jsonFetch 工厂不含 cookie', !/cookie/i.test(factory));
}

// ── 4. 503 的措辞（维护 ≠ 标签写错）──
console.log('\n── 4. 503 降级说明 ──');
{
  const s = fs.readFileSync(path.join(root, 'src/image-sources.js'), 'utf8');
  check('503 被单独识别', /Number\(error\?\.status\) === 503/.test(s));
  check('提到"站点维护"', /站点维护/.test(s));
  check('匿名时提示可配凭据', /可在控制台配置登录凭据后重试/.test(s));
  check('503 标为可重试（不当成"这个标签没图"）', /e\.retryable = true/.test(s));
}

// ── 5. 桥接接线 ──
console.log('\n── 5. 桥接接线 ──');
{
  const bridge = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

  check('桥接导入凭据模块', /from '\.\/pixiv-auth\.js'/.test(bridge));
  check('启动时注入', /applyPixivAuth\(\)/.test(bridge) && /setPixivCookie\(pa\.loaded \? pa\.cookie : ''\)/.test(bridge));
  check('控制台保存后立即重读', /applyPixivAuth\('控制台保存'\)/.test(bridge));
  check('日志只报状态不打印内容',
    /pixiv 登录态已加载/.test(bridge) && !/log\([^)]*pixivAuth\.cookie/.test(bridge) && !/log\([^)]*pa\.cookie/.test(bridge));
  check('未配置时明确写"匿名访问"', /pixiv 匿名访问/.test(bridge));
  check('默认配置指向 state/pixiv-auth.json',
    /authFile: 'state\/pixiv-auth\.json'/.test(bridge));
  check('配置默认不带额外凭据文件', cfg.socialV2?.images?.sources?.pixiv?.authFile === undefined
    || /state\/pixiv-auth\.json/.test(String(cfg.socialV2?.images?.sources?.pixiv?.authFile)));

  // 控制台凭据项
  const { CREDENTIAL_ITEMS, credentialByKey } = await import('../src/credentials-doc.js');
  const a = credentialByKey('pixivPhpSessId');
  const b = credentialByKey('pixivDeviceToken');
  check('控制台有 PHPSESSID 项', !!a);
  check('控制台有 device_token 项', !!b);
  check('两项都写 state/pixiv-auth.json', a?.file === 'pixiv-auth.json' && b?.file === 'pixiv-auth.json');
  check('两项都是 secret（会打码）', a?.kind === 'secret' && b?.kind === 'secret');
  check('两项都标为立即生效', a?.restart === false && b?.restart === false);
  check('文档写明维护期间无效', /维护/.test(a?.doc ?? '') && /任何 Cookie 都无效|填什么都是 503/.test(a?.doc ?? ''));
  check('文档写明风控风险与"由你决定"', /风险/.test(a?.doc ?? '') && /由你决定/.test(a?.doc ?? ''));
  check('标签用了人能认的词', /PHPSESSID/.test(a?.label ?? '') && /device_token/.test(b?.label ?? ''));

  // 保存链路：file 类写入 state/<file> 的 <path> 字段
  check('保存会重读 pixiv 凭据', /item\.file === 'pixiv-auth\.json'/.test(bridge));
  check('凭据项总数含新增两项', CREDENTIAL_ITEMS.length === 13, String(CREDENTIAL_ITEMS.length));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
