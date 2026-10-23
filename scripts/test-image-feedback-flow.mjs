// 端到端（真库+真桥接不可用时也能跑）：验证"差评→删除→拒绝→重发别的图"的完整链路。
// 用真实 image-store + 真实的 handleImageFeedback 逻辑复刻，确认行为符合预期。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImageStore } from '../src/image-store.js';
import { classifyImageFeedback, createFeedbackGate } from '../src/image-feedback.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000640802000000ff1099e9000000064944415478da63fcffff3f030005fe02fea6d5b17c', 'hex');
// 每张图要有**不同字节**：store 按内容 md5 命名文件，同字节会被视作同一个文件。
const pngFor = (n) => Buffer.concat([PNG, Buffer.from(`padding-${n}`)]);
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-e2e-'));

// 复刻 bridge.handleImageFeedback 的流程（用可控时钟，便于测试冷却行为）
const lastSentImage = new Map();
let clock = 1_700_000_000_000;
// store 也要注入同一个时钟：新的「10 分钟内不重复发」按时间判断，
// 若它用真实 Date.now 而这里用模拟时钟，两边永远对不上，测试会误报失败。
const store = createImageStore({ dir: d, maxFiles: 100, maxTotalBytes: 1e9, log: () => {}, now: () => clock });
for (const i of [1, 2, 3]) {
  store.add(pngFor(i), { id: `hero:${i}`, source: 'safebooru', artist: 'a', page: `p/${i}`, tags: ['1girl', 'hero_(game)'], rating: 'g' });
}
const gate = createFeedbackGate({ cooldownMs: 90_000, now: () => clock });
const sent = [];
async function sendImage(key, tags) {
  sent.push({ key, tags });
  // 本用例验的是「差评 → 拒图 → 换一张」的链路，**不是**"10 分钟内不重复发"。
  // 三张图要在几轮内轮流发到，所以这里显式关掉那道过滤（blockRecentMs:0）。
  // 生产环境走默认值（10 分钟），见 test-image-lib.mjs 的专门用例。
  const picked = store.pickRandom({ tags, allowGroupImages: true, blockRecentMs: 0 });
  if (picked) {
    store.markUsed(picked.entry.id);
    lastSentImage.set(key, { id: picked.entry.id, tags, at: clock });
  }
  return picked;
}
async function handleImageFeedback(key, text) {
  const last = lastSentImage.get(key);
  if (!last) return false;
  const ageMs = clock - last.at;
  const inWindow = ageMs <= 120_000;
  const v = classifyImageFeedback(text, inWindow ? { recentImageMs: ageMs } : {});
  if (!v.negative) return false;
  const g = gate.shouldSwap(key);
  if (!g.allow) return false;
  store.reject(last.id, { reason: text });
  lastSentImage.delete(key);
  await sendImage(key, last.tags ?? []);
  return true;
}

const KEY = 'group:test';
console.log('── 场景：连发三次，每次换到不同的图 ──');
const seen = [];
for (let round = 1; round <= 3; round++) {
  const p = await sendImage(KEY, ['hero_(game)']);
  seen.push(p?.entry?.id);
  // 每轮推进 2 分钟（超出 90 秒冷却，且仍在 120 秒发图窗口边缘内）
  clock += 100_000;
  const handled = await handleImageFeedback(KEY, '这张不好看，换一张');
  check(`第 ${round} 轮：差评被接管`, handled === true);
  console.log(`     发出 ${seen[round - 1]} → 库里还剩 ${store.count()} 张，已拒 ${store.rejectedStats().count} 张`);
}
check('三轮发的是三张不同的图', new Set(seen).size === 3, seen.join(','));
check('被差评的三张都进了拒绝名单', store.rejectedStats().count === 3);
check('图库被删空（三张都拒了）', store.count() === 0);
check('拒不回的图不会被重发', [...seen].every((id) => store.isRejected(id)));

console.log('\n── 场景：冷却内连骂不连发 ──');
{
  const s2 = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-e2e2-'));
  const st2 = createImageStore({ dir: s2, maxFiles: 100, maxTotalBytes: 1e9, log: () => {} });
  for (const i of [1, 2, 3, 4]) st2.add(pngFor(100 + i), { id: `h2:${i}`, source: 'safebooru', page: `p/${i}`, tags: ['1girl', 'hero_(game)'], rating: 'g' });
  const last2 = new Map();
  const gate2 = createFeedbackGate({ cooldownMs: 90_000, now: () => clock });
  let sends = 0;
  const pick = () => { const p = st2.pickRandom({ tags: ['hero_(game)'], blockRecentMs: 0 }); if (p) { st2.markUsed(p.entry.id); last2.set('k', { id: p.entry.id, tags: ['hero_(game)'], at: clock }); sends++; } };
  const fb = (text) => {
    const l = last2.get('k'); if (!l) return false;
    const v = classifyImageFeedback(text, { recentImageMs: clock - l.at }); if (!v.negative) return false;
    if (!gate2.shouldSwap('k').allow) return false;
    st2.reject(l.id); last2.delete('k'); pick(); return true;
  };
  pick();
  check('第一次差评换图', fb('不好看') === true);
  check('立刻再骂不换（冷却中）', fb('还是不好看') === false);
  check('只发出 2 张（首发+换的 1 张）', sends === 2, `sends=${sends}`);
  check('只拒了 1 张', st2.rejectedStats().count === 1);
  // 冷却过后可以再换
  clock += 91_000;
  check('冷却过后可再换', fb('这次也不行') === true);
  fs.rmSync(s2, { recursive: true, force: true });
}

// 正向消息不该触发
console.log('\n── 场景：夸奖不触发删除 ──');
{
  const last3 = new Map([['k', { id: 'x', tags: [], at: Date.now() }]]);
  for (const text of ['好看', '这张不错', '谢谢']) {
    const v = classifyImageFeedback(text, { recentImageMs: 1000 });
    check(`「${text}」不触发`, v.negative === false, v.reason);
  }
}

fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
