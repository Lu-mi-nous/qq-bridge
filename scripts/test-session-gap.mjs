// 回归测试：记忆断层提醒（src/session-gap.js）。
//
// 锁住：首次启动不提示、正常间隔不提示、超阈值只提示一次、长间隔措辞、
// 关闭时空串、状态损坏容错、有界 key。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GAP_NOTICE,
  normalizeGapNoticeConfig,
  createSessionGap,
  sessionGapFile
} from '../src/session-gap.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-gap-'));
const file = path.join(tmp, 'state', 'session-gap.json');
const KEY = 'group:1001';
let now = 1_792_915_000_000;

console.log('── 1. 配置归一化 ──');
{
  const c = normalizeGapNoticeConfig({});
  check('默认关闭', c.enabled === false && DEFAULT_GAP_NOTICE.enabled === false);
  check('默认 30 分钟 / 6 小时', c.gapMinutes === 30 && c.longGapHours === 6, JSON.stringify(c));
  const c2 = normalizeGapNoticeConfig({ enabled: true, gapMinutes: -1, longGapHours: 9999 });
  check('阈值 clamp', c2.gapMinutes === 1 && c2.longGapHours === 720, JSON.stringify(c2));
}

console.log('\n── 2. 断层判定与去重 ──');
{
  const gap = createSessionGap({ file, now: () => now });
  check('首次没有历史 → 不提示', gap.buildNotice(KEY, { enabled: true }) === '');
  gap.markProcessed(KEY, now);
  now += 10 * 60000;
  check('10 分钟 < 30 分钟 → 不提示', gap.buildNotice(KEY, { enabled: true }) === '');
  now += 25 * 60000;
  const text = gap.buildNotice(KEY, { enabled: true });
  check('35 分钟 → 提示', text.includes('运行状态') && text.includes('35 分钟'), text);
  check('同一段断层只提示一次', gap.buildNotice(KEY, { enabled: true }) === '');
  now += 1000;
  gap.markProcessed(KEY, now);
  now += 61 * 60000;
  const text2 = gap.buildNotice(KEY, { enabled: true });
  check('回合结束后产生新断层可再次提示', text2.includes('61 分钟'), text2);
}

console.log('\n── 3. 长间隔措辞 / 关闭 / 损坏 ──');
{
  const dir = path.join(tmp, 'long');
  const gap = createSessionGap({ file: path.join(dir, 'gap.json'), now: () => now });
  gap.markProcessed(KEY, now);
  now += 7 * 3600000;
  const text = gap.buildNotice(KEY, { enabled: true, longGapHours: 6 });
  check('超过 6 小时用“隔了很久”', text.includes('隔了很久') && text.includes('7 小时'), text);
  check('关闭时返回空串', gap.buildNotice(KEY, { enabled: false }) === '');

  const bad = path.join(tmp, 'bad', 'gap.json');
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, '{not json');
  const g2 = createSessionGap({ file: bad, now: () => now });
  check('损坏文件不崩', g2.buildNotice(KEY, { enabled: true }) === '');
  check('损坏后仍可写入', g2.markProcessed(KEY, now) === true);
}

console.log('\n── 4. 有界 key / 非会话 key ──');
{
  const dir = path.join(tmp, 'bounded');
  const gap = createSessionGap({ file: path.join(dir, 'gap.json'), maxKeys: 3, now: () => now });
  for (let i = 0; i < 5; i++) gap.markProcessed(`group:${1000 + i}`, now + i);
  check('只保留最近 3 个 key', gap.stats().sessions === 3, JSON.stringify(gap.stats()));
  check('非法 key 不写入', gap.markProcessed('bad-key', now) === false);
}

console.log('\n── 5. 接线 ──');
{
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const wake = fs.readFileSync(new URL('../src/pipeline/wake.js', import.meta.url), 'utf8');
  const events = fs.readFileSync(new URL('../src/pipeline/dsh-events.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  check('回合结束记录处理时间', /recordSessionProcessed\?\.\(key\)/.test(events)
    && /recordSessionProcessed: \(key\) => sessionGap\.markProcessed\(key\)/.test(bridge));
  check('唤醒注入断层背景', /deps\.buildGapNotice/.test(wake) && /lastGapChars/.test(wake));
  check('24 卡有断层设置面板', /id="ctxGapPanel"/.test(html) && /ctxGapEnabled/.test(html));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
