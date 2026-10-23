// 回归测试：反向搜图（SauceNAO）的响应解析与配额节流。
//
// 背景（2026-10-11）：用户要求接入 SauceNAO 反查图片来源。实测要点：
//   ① 不带/带无效 key：`{"header":{"status":-1,"message":"The anonymous account type does not
//      permit API usage."}}` —— 必须把它翻译成「key 无效」，不能当成「没搜到」。
//   ② 代理不稳时会被 Cloudflare 挑战页挡住（返回 HTML 而非 JSON）—— 要能识别并说明。
//   ③ 免费额度 30 秒 4 次 / 每天 100 次 —— 超了要给「等 N 秒」而不是让模型反复重试。
// 这些错误都必须**可区分**，否则群友会听到「搜不到」而实际是「没配 key」或「被限流」。
import { parseSauceResponse, prettySiteName, DB_INDEX, createReverseSearcher } from '../src/image-reverse-search.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

console.log('── 正常响应：归一化字段 ──');
{
  // 真实形态（output_type=2）
  const real = JSON.stringify({
    header: { status: 0, index: {}, search_depth: 'all' },
    results: [
      {
        header: { similarity: '95.24', thumbnail: 'https://saucenao.com/thumb/1.jpg', index_id: 5, index_name: 'pixiv' },
        data: { title: '作品标题', creator: '画师名', pixiv_id: 12345678, member_id: '9999', ext_urls: ['https://www.pixiv.net/artworks/12345678'] }
      },
      {
        header: { similarity: '61.00', thumbnail: '', index_id: 9, index_name: 'danbooru' },
        data: { source: 'https://twitter.com/x/status/1', ext_urls: ['https://danbooru.donmai.us/posts/1'] }
      }
    ]
  });
  const r = parseSauceResponse(real);
  check('解析成功', r.ok === true);
  check('结果条数 2', r.results.length === 2, String(r.results.length));
  check('按相似度降序', r.results[0].similarity >= r.results[1].similarity);
  check('取到站点名', r.results[0].site === 'pixiv', r.results[0].site);
  check('取到画师名', r.results[0].creator === '画师名', r.results[0].creator);
  check('取到作品页 URL', r.results[0].urls[0] === 'https://www.pixiv.net/artworks/12345678');
  check('pixiv_id 被保留', r.results[0].pixivId === '12345678');
  check('member_id 被保留', r.results[0].memberId === '9999');
  check('相似度是数字', typeof r.results[0].similarity === 'number');
}

console.log('\n── 复合信息字段（creator 可能在不同字段里）──');
{
  const mk = (data) => parseSauceResponse(JSON.stringify({ header:{status:0}, results:[{ header:{similarity:'90',index_id:9}, data }] })).results[0];
  check('creator 字段', mk({ creator: 'A' }).creator === 'A');
  check('author_name 兜底', mk({ author_name: 'B' }).creator === 'B');
  check('member_name 兜底', mk({ member_name: 'C' }).creator === 'C');
  check('username 兜底', mk({ username: 'D' }).creator === 'D');
  check('title 优先于 jp_name', mk({ title: 'EN', jp_name: 'JP' }).title === 'EN');
  check('无 title 时用 jp_name', mk({ jp_name: 'JP' }).title === 'JP');
  check('字面量 "null" 当空串处理', mk({ creator: 'null' }).creator === '');
  check('ext_urls 非 http 被过滤', mk({ ext_urls: ['ftp://x', 'https://ok'] }).urls.length === 1);
  check('ext_urls 最多取 3 条', mk({ ext_urls: ['https://1','https://2','https://3','https://4'] }).urls.length === 3);
}

console.log('\n── 错误必须可区分（关键）──');
{
  const noKey = parseSauceResponse('{"header":{"status":-1,"message":"The anonymous account type does not permit API usage."}}');
  check('key 无效 → 报「key 无效」', !noKey.ok && /key 无效/.test(noKey.error), noKey.error);

  const quota = parseSauceResponse('{"header":{"status":-1,"message":"Daily search limit exceeded."}}');
  check('配额用尽 → 报「配额/限频」', !quota.ok && /配额|限频/.test(quota.error), quota.error);

  const cf = parseSauceResponse('<!DOCTYPE html><html><head><title>Just a moment...</title>');
  check('Cloudflare 挑战页 → 明确说明', !cf.ok && /Cloudflare|风控/.test(cf.error), cf.error);
  // 2026-10-21 修：早先只测 /cloudflare/i，而 SauceNAO **正常首页**里也有
  // "Cloudflare Web Analytics" 的脚本注释 → 会误报成"被拦"。
  check('挑战页提示要说明"不是 key/额度问题"',
    !cf.ok && /不是 key 或额度问题/.test(cf.error), cf.error);
  const normalPage = parseSauceResponse('<html><!-- Cloudflare Web Analytics --><script src="beacon.min.js"></script></html>');
  check('正常页面里的 Cloudflare Analytics 不算挑战页',
    !normalPage.ok && !/挑战页|不是 key 或额度/.test(normalPage.error), normalPage.error);

  const html = parseSauceResponse('<html>some other page</html>');
  check('其他非 JSON → 报非 JSON（不崩）', !html.ok && /非 JSON/.test(html.error), html.error);

  const other = parseSauceResponse('{"header":{"status":-1,"message":"Something else broke"}}');
  check('未知错误 → 带出原始 message', !other.ok && /Something else broke/.test(other.error), other.error);
}

console.log('\n── 空结果（不是错误）──');
{
  const empty = parseSauceResponse('{"header":{"status":0},"results":[]}');
  check('空 results → ok:true 且 0 条', empty.ok === true && empty.results.length === 0);
  const noField = parseSauceResponse('{"header":{"status":0}}');
  check('缺 results 字段 → ok:true 且 0 条', noField.ok === true && noField.results.length === 0);
}

console.log('\n── 异常输入不崩 ──');
{
  check('空串', parseSauceResponse('').ok === false);
  check('null', parseSauceResponse(null).ok === false);
  check('undefined', parseSauceResponse(undefined).ok === false);
  check('纯数字', parseSauceResponse('123').ok === false);
}

console.log('\n── 站名清洗（SauceNAO 原始 index_name 带内部编号与文件名）──');
{
  // 实测原始形态：'Index #N: 站名 - 匹配到的那个文件名'
  const raw1 = 'Index #12: Yande.re - 1313e6d8f63540d90440c24d385baa87_1.jpg';
  const raw2 = 'Index #5: Pixiv Images - 99729014_p0_master1200.jpg';
  const raw3 = 'Index #38: H-Misc (E-Hentai) - 014793cb15680bfa9ddbdb763af09cfda6caed94.jpg';
  check('去编号 + 文件名后缀', prettySiteName(raw1) === 'Yande.re', prettySiteName(raw1));
  check('Pixiv Images 规整为 Pixiv', prettySiteName(raw2) === 'Pixiv', prettySiteName(raw2));
  check('E-Hentai 别名规整', prettySiteName(raw3) === 'E-Hentai', prettySiteName(raw3));
  check('本来就没文件名的照常', prettySiteName('Index #9: Danbooru') === 'Danbooru', prettySiteName('Index #9: Danbooru'));
  check('缺 index_name 时按索引号兜底', prettySiteName('', 5) === 'pixiv', prettySiteName('', 5));
  check('空值不崩', typeof prettySiteName('', 0) === 'string');
  // 画师字段：SauceNAO 会填字面量 Unknown，照原样返回会让模型对群友说「作者是 Unknown」
  const mkCreator = (data) => parseSauceResponse(JSON.stringify({ header:{status:0}, results:[{ header:{similarity:'90',index_id:5}, data }] })).results[0].creator;
  check('creator=Unknown → 清成空', mkCreator({ creator: 'Unknown' }) === '');
  check('creator=N/A → 清成空', mkCreator({ creator: 'N/A' }) === '');
  check('creator=- → 清成空', mkCreator({ creator: '-' }) === '');
  check('真实画师名保留', mkCreator({ creator: 'yajuu' }) === 'yajuu');
}

console.log('\n── db 索引表（给模型解释用）──');
{
  check('pixiv = 5', DB_INDEX.pixiv === 5);
  check('danbooru = 9', DB_INDEX.danbooru === 9);
  check('twitter = 41', DB_INDEX.twitter === 41);
  check('all = 0', DB_INDEX.all === 0);
}

console.log('\n── 额度状态持久化（重启后控制台不归零）──');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-reverse-quota-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(stateDir, 'reverse-search-quota.json'), JSON.stringify({
    date: new Date().toDateString(),
    dailyCount: 7,
    hits: [now, now - 60_000], // 第二个已超出 30 秒窗口
  }));
  const searcher = createReverseSearcher({ root, apiKey: 'test-key' });
  const st = searcher.stats();
  check('重启后 usedToday 从磁盘恢复', st.usedToday === 7, String(st.usedToday));
  check('重启后 remainingToday 正确', st.remainingToday === 93, String(st.remainingToday));
  check('过期窗口 hits 被过滤', st.windowUsed === 1, String(st.windowUsed));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
