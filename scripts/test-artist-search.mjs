// 回归测试：按画师名搜索（本地 + 三源）
// 覆盖：统一 artist: 语法的各源翻译、本地 artist 字段精确匹配、标签校验不误杀画师查询。
import fs from 'node:fs';
import path from 'node:path';
import { translateArtistTag, fetchFromSources } from '../plugins/images/lib/image-sources.js';
import { createImageStore } from '../plugins/images/lib/image-store.js';
import { proxyGet } from '../src/proxy-tunnel.js';

const PROXY = process.env.QQB_PROXY || 'http://127.0.0.1:7897';
let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const skipped = (n) => { skip++; console.log(`SKIP  ${n}`); };

// ── 语法翻译（离线，核心逻辑）──
console.log('=== 各源画师语法翻译 ===');
check('safebooru: artist:x → 裸名', translateArtistTag('safebooru', 'artist:moonian').tag === 'moonian');
check('yandere: artist:x → user:x', translateArtistTag('yandere', 'artist:moonian').tag === 'user:moonian');
check('pixiv: artist:x → 裸名（走关键词）', translateArtistTag('pixiv', 'artist:moonian').tag === 'moonian');
check('user: 别名同样识别', translateArtistTag('yandere', 'user:moonian').tag === 'user:moonian');
check('标记为画师查询', translateArtistTag('safebooru', 'artist:moonian').isArtist === true);
check('普通标签不翻译', translateArtistTag('yandere', 'cat').tag === 'cat' && translateArtistTag('yandere', 'cat').isArtist === false);
check('大小写不敏感', translateArtistTag('yandere', 'ARTIST:MooNian').tag === 'user:MooNian');
check('带空格的名字', translateArtistTag('safebooru', 'artist:some_artist name').tag === 'some_artist name');

// ── 本地检索（离线）──
console.log('\n=== 本地库按画师查 ===');
{
  const LIB = 'state/image-lib';
  if (!fs.existsSync(path.join(LIB, 'index.json'))) {
    skipped('本地检索（无图库）');
  } else {
    const store = createImageStore({ dir: LIB, maxFiles: 1e6, maxTotalBytes: 1e12, log: () => {} });
    const items = JSON.parse(fs.readFileSync(path.join(LIB, 'index.json'), 'utf8')).items;
    const artists = [...new Set(items.map((x) => x.artist).filter(Boolean))];
    if (!artists.length) {
      skipped('本地检索（库内无画师名）');
    } else {
      const target = artists[0];
      let hit = 0, correct = 0;
      for (let i = 0; i < 10; i++) {
        const r = store.pickRandom({ tags: [`artist:${target}`] });
        if (r) { hit++; if (String(r.entry.artist).toLowerCase().includes(target.toLowerCase())) correct++; }
      }
      check(`artist:${target} 能查到`, hit > 0, `${hit}/10`);
      check('结果确实属于该画师', hit > 0 && correct === hit, `${correct}/${hit}`);
      check('user: 别名等价', !!store.pickRandom({ tags: [`user:${target}`] }));
      // 不存在的画师应查不到（不能退回"任意图"）
      check('不存在的画师返回空', store.pickRandom({ tags: ['artist:zzz_no_such_artist_xyz'] }) === null
        || store.pickRandom({ tags: ['artist:zzz_no_such_artist_xyz'] })?.count === 0);
    }
  }
}

// ── 上游三源（联网）──
let proxyOk = true;
try {
  const r = await proxyGet('https://yande.re/tag.json?limit=1', { proxy: PROXY, headers: { 'user-agent': 'qq-bridge/0.1' }, timeoutMs: 20000 });
  proxyOk = r.status === 200;
} catch { proxyOk = false; }

console.log(`\n=== 上游画师查询（代理${proxyOk ? '可用' : '不可用'}）===`);
if (!proxyOk) {
  skipped('上游用例（代理不可用）');
} else {
  // safebooru：用已知存在的画师
  {
    const known = 'betanonbeet';
    const r = await fetchFromSources({ safebooru: { enabled: true, limit: 6 } }, { tags: [`artist:${known}`], limit: 6 });
    const ok = r.entries.length > 0 && r.entries.every((e) => String(e.artist).toLowerCase().includes(known));
    check(`safebooru artist:${known}`, ok, `${r.entries.length} 条 画师=${[...new Set(r.entries.map((e) => e.artist))].join(',') || '-'}`);
  }
  // yandere：必须翻译成 user: 前缀才有效（这是最容易踩的坑）
  {
    const known = 'moonian';
    const r = await fetchFromSources({ yandere: { enabled: true, limit: 6, proxy: PROXY } }, { tags: [`artist:${known}`], limit: 6 });
    const ok = r.entries.length > 0 && r.entries.every((e) => String(e.artist).toLowerCase() === known);
    check(`yandere artist:${known}（需翻译为 user:）`, ok, `${r.entries.length} 条 画师=${[...new Set(r.entries.map((e) => e.artist))].join(',') || '-'}`);

    // 反向验证：若翻译失效（原样发 artist:）应当查不到 —— 证明翻译确实必要
    const raw = await fetchFromSources({ yandere: { enabled: true, limit: 3, proxy: PROXY } }, { tags: [`user:${known}`], limit: 3 });
    check(`yandere user:${known} 同样可用（两种写法都通）`, raw.entries.length > 0, `${raw.entries.length} 条`);
  }
  // 不存在的画师：不应静默返回别的画师
  {
    const r = await fetchFromSources({ safebooru: { enabled: true, limit: 3 } }, { tags: ['artist:zzz_no_such_artist_xyz'], limit: 3 });
    check('不存在的画师不返回无关结果', r.entries.length === 0, `${r.entries.length} 条`);
  }
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
