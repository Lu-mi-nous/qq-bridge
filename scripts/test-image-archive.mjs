// 回归测试：图片收藏（原图回源 + 专用目录保存）的纯逻辑部分。
// 不依赖网络：下载与回源查询都用注入的假实现。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveOriginalImage, resolveOriginalUrl, sanitizeForFilename, extOfUrl } from '../plugins/images/lib/image-archive.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000640802000000ff1099e9000000064944415478da63fcffff3f030005fe02fea6d5b17c', 'hex');

console.log('── 文件名净化（Windows 最严，必须不移）──');
check('去非法字符', sanitizeForFilename('a<b>c:d"e/f\\g|h?i*j') === 'abcdefghij', sanitizeForFilename('a<b>c:d"e/f\\g|h?i*j'));
check('空白转下划线', sanitizeForFilename('hello world') === 'hello_world');
check('全角空格也处理', sanitizeForFilename('a\u3000b') === 'a_b');
check('连续下划线折叠', sanitizeForFilename('a   b') === 'a_b');
check('去首尾点（Windows 不允许结尾点）', sanitizeForFilename('..a.') === 'a');
check('去首尾下划线', sanitizeForFilename('_a_') === 'a');
check('控制字符清除', sanitizeForFilename('a\u0001b\u001fc') === 'abc');
check('限长', sanitizeForFilename('x'.repeat(100), 10).length === 10);
check('中文保留（合法）', sanitizeForFilename('大肥鱼') === '大肥鱼');
check('空输入返回空', sanitizeForFilename('') === '');
check('null 不抛', sanitizeForFilename(null) === '');

console.log('\n── 扩展名推断 ──');
check('jpg', extOfUrl('https://x/a.jpg') === 'jpg');
check('jpeg 归一到 jpg', extOfUrl('https://x/a.jpeg') === 'jpg');
check('png', extOfUrl('https://x/a.png') === 'png');
check('带查询串', extOfUrl('https://x/a.png?foo=1') === 'png');
check('大写字归一', extOfUrl('https://x/a.PNG') === 'png');
check('无扩展名兜底 jpg', extOfUrl('https://x/noext') === 'jpg');
check('空值兜底', extOfUrl('') === 'jpg');

console.log('\n── 回源取原图直链（注入假接口）──');
{
  // safebooru：file_url 优先
  const sf = async () => ({ file_url: 'https://cdn/orig.jpg', large_file_url: 'https://cdn/large.jpg' });
  check('safebooru 取 file_url', (await resolveOriginalUrl({ id: 'safebooru:1' }, { jsonFetch: sf })) === 'https://cdn/orig.jpg');
  // 缺 file_url 时退回 large
  const sf2 = async () => ({ large_file_url: 'https://cdn/large.jpg' });
  check('safebooru 退回 large', (await resolveOriginalUrl({ id: 'safebooru:1' }, { jsonFetch: sf2 })) === 'https://cdn/large.jpg');
  // 两者都无 → 抛
  let threw = false;
  try { await resolveOriginalUrl({ id: 'safebooru:1' }, { jsonFetch: async () => ({}) }); } catch { threw = true; }
  check('safebooru 无地址时抛错', threw);

  // yandere：数组形态
  check('yandere 取 file_url', (await resolveOriginalUrl({ id: 'yandere:9' }, { jsonFetch: async () => [{ file_url: 'https://y/orig.jpg' }] })) === 'https://y/orig.jpg');
  // yandere：对象包裹形态
  check('yandere posts 包裹', (await resolveOriginalUrl({ id: 'yandere:9' }, { jsonFetch: async () => ({ posts: [{ file_url: 'https://y/o2.jpg' }] }) })) === 'https://y/o2.jpg');
  // 无 file_url → 退回 sample
  check('yandere 退回 sample', (await resolveOriginalUrl({ id: 'yandere:9' }, { jsonFetch: async () => [{ sample_url: 'https://y/s.jpg' }] })) === 'https://y/s.jpg');
  // 未注入 jsonFetch（需代理）
  threw = false;
  try { await resolveOriginalUrl({ id: 'yandere:9' }, {}); } catch (e) { threw = /代理/.test(e.message); }
  check('yandere 未注入代理时抛错', threw);

  // pixiv：original 优先
  check('pixiv 取 original', (await resolveOriginalUrl({ id: 'pixiv:5' }, { jsonFetch: async () => ({ body: { urls: { original: 'https://i/orig.png' } } }) })) === 'https://i/orig.png');
  check('pixiv 退回 large', (await resolveOriginalUrl({ id: 'pixiv:5' }, { jsonFetch: async () => ({ body: { urls: { large: 'https://i/l.jpg' } } }) })) === 'https://i/l.jpg');

  // 未知源 / 非法 id
  threw = false;
  try { await resolveOriginalUrl({ id: 'weird:1' }, { jsonFetch: sf }); } catch (e) { threw = /未知图源/.test(e.message); }
  check('未知源抛错', threw);
  threw = false;
  try { await resolveOriginalUrl({ id: 'nonsense' }, { jsonFetch: sf }); } catch (e) { threw = /无法解析/.test(e.message); }
  check('非法 id 抛错', threw);
}

console.log('\n── 保存到专用目录 ──');
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-'));
  const jsonFetch = async () => ({ file_url: 'https://cdn/orig.jpg' });
  let downloads = 0;
  const fetchBuffer = async () => { downloads++; return PNG; };

  const r1 = await saveOriginalImage(
    { id: 'safebooru:123', source: 'safebooru', artist: 'some artist' },
    { dir: d, jsonFetch, fetchBuffer, log: () => {} }
  );
  check('保存成功', r1.ok === true);
  check('文件确实存在', fs.existsSync(r1.path));
  check('文件名含来源与 id', path.basename(r1.path).startsWith('safebooru_123'), path.basename(r1.path));
  check('画师名进了文件名且已净化', path.basename(r1.path).includes('some_artist'), path.basename(r1.path));
  check('下载了 1 次', downloads === 1);
  check('返回原图 URL', r1.url === 'https://cdn/orig.jpg');

  // 幂等：再存同一张不该重复下载
  const r2 = await saveOriginalImage(
    { id: 'safebooru:123', source: 'safebooru', artist: 'some artist' },
    { dir: d, jsonFetch, fetchBuffer, log: () => {} }
  );
  check('重复保存标记 skipped', r2.skipped === true);
  check('重复保存没再下载', downloads === 1, `downloads=${downloads}`);
  check('路径一致', r2.path === r1.path);

  // overwrite 时应重下
  const r3 = await saveOriginalImage(
    { id: 'safebooru:123', source: 'safebooru', artist: 'some artist' },
    { dir: d, jsonFetch, fetchBuffer, log: () => {}, overwrite: true }
  );
  check('overwrite 时重下', r3.skipped === false && downloads === 2, `downloads=${downloads}`);

  // 不同扩展名不该互相覆盖
  const jsonPng = async () => ({ file_url: 'https://cdn/orig.png' });
  const r4 = await saveOriginalImage(
    { id: 'safebooru:123', source: 'safebooru', artist: 'some artist' },
    { dir: d, jsonFetch: jsonPng, fetchBuffer, log: () => {} }
  );
  check('同 id 不同扩展名各存一份', r4.path !== r1.path && fs.existsSync(r4.path), path.basename(r4.path));

  // 画师为空时文件名不带多余下划线
  const r5 = await saveOriginalImage(
    { id: 'yandere:88', source: 'yandere' },
    { dir: d, jsonFetch: async () => [{ file_url: 'https://y/o.jpg' }], fetchBuffer, log: () => {} }
  );
  check('无画师时文件名干净', path.basename(r5.path) === 'yandere_88.jpg', path.basename(r5.path));

  // 目录不存在时自动创建
  const nested = path.join(d, 'sub', 'deep');
  const r6 = await saveOriginalImage(
    { id: 'safebooru:999', source: 'safebooru' },
    { dir: nested, jsonFetch, fetchBuffer, log: () => {} }
  );
  check('自动创建多级目录', fs.existsSync(r6.path));

  // 未配置目录 / 缺下载实现
  let threw = false;
  try { await saveOriginalImage({ id: 'safebooru:1' }, { jsonFetch, fetchBuffer }); } catch (e) { threw = /未配置收藏目录/.test(e.message); }
  check('未配置目录时抛错', threw);
  threw = false;
  try { await saveOriginalImage({ id: 'safebooru:1' }, { dir: d, jsonFetch }); } catch (e) { threw = /缺少下载实现/.test(e.message); }
  check('缺下载实现时抛错', threw);

  // 空内容 / 超大
  threw = false;
  try { await saveOriginalImage({ id: 'safebooru:2' }, { dir: d, jsonFetch, fetchBuffer: async () => Buffer.alloc(0), log: () => {} }); } catch (e) { threw = /空内容/.test(e.message); }
  check('空内容抛错', threw);
  threw = false;
  try { await saveOriginalImage({ id: 'safebooru:3' }, { dir: d, jsonFetch, fetchBuffer: async () => PNG, maxBytes: 10, log: () => {} }); } catch (e) { threw = /过大/.test(e.message); }
  check('超限抛错', threw);

  // 不留下 .tmp 残file
  const tmps = fs.readdirSync(d).filter((f) => f.endsWith('.tmp'));
  check('无 .tmp 残留', tmps.length === 0, tmps.join(','));

  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
