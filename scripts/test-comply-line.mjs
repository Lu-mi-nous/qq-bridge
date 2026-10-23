// 一次性回归：验证点单判定渲染成注入文本（照做/自由发挥两种分支 + 已回应则不再判）。
// 桩件替换状态与配置，抽出 buildComplyLineV2 / latestOrderV2 / rollComplyV2 求值。
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function grabFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('fn not found: ' + name);
  const end = src.indexOf('\n  }\n', start);
  if (end < 0) throw new Error('fn end not found: ' + name);
  return src.slice(start, end + 4);
}

const states = new Map();
const cfg = { socialV2: { comply: { enabled: true, probability: 1, ttlMs: 180000, cooldownMs: 0, maxPerHour: 12 } } };
const getSocialV2State = (key) => {
  if (!states.has(key)) states.set(key, { complyTimes: [], recentMessages: [] });
  return states.get(key);
};
const saveSocialV2State = () => {};
const log = () => {};

const f = new Function('cfg', 'getSocialV2State', 'saveSocialV2State', 'log',
  [grabFn('rollComplyV2'), grabFn('latestOrderV2'), grabFn('buildComplyLineV2')].join('\n') +
  '\nreturn { rollComplyV2, latestOrderV2, buildComplyLineV2 };'
)(cfg, getSocialV2State, saveSocialV2State, log);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const KEY = 'group:100';
const st = getSocialV2State(KEY);
const now = Date.now();

// 1) 有点单、概率=1 → 「照做」文案
st.recentMessages = [{ sender: '群友A', text: '帮我写个文案', orderText: '帮我写个文案', orderAt: now, isSelf: false, time: now }];
let line = f.buildComplyLineV2(KEY, st);
check('概率1 → 照做文案', line.includes('照做') && !line.includes('自由发挥'), line.slice(0, 30) + '…');

// 2) 概率=0 → 「自由发挥」文案
st.pendingComply = null; st.lastComplyRollAt = 0;
cfg.socialV2.comply.probability = 0;
line = f.buildComplyLineV2(KEY, st);
check('概率0 → 自由发挥文案', line.includes('自由发挥'), line.slice(0, 30) + '…');

// 3) 无点单 → 空串（不打扰）
st.pendingComply = null; st.lastComplyRollAt = 0;
st.recentMessages = [{ sender: '群友A', text: '哈哈哈', isSelf: false, time: now }];
line = f.buildComplyLineV2(KEY, st);
check('无点单 → 不注入', line === '');

// 4) 点单后 AI 已发言 → 不再判（不翻旧账）
st.pendingComply = null; st.lastComplyRollAt = 0;
cfg.socialV2.comply.probability = 1;
st.recentMessages = [
  { sender: '群友A', text: '帮我写个文案', orderText: '帮我写个文案', orderAt: now, isSelf: false, time: now },
  { sender: '我', text: '行吧', isSelf: true, time: now + 1000 },
];
line = f.buildComplyLineV2(KEY, st);
check('已回应 → 不再判', line === '');

// 5) 点单后插入无关闲聊 → 仍能找回点单（不被顶掉）
st.pendingComply = null; st.lastComplyRollAt = 0;
st.recentMessages = [
  { sender: '群友A', text: '帮我写个文案', orderText: '帮我写个文案', orderAt: now, isSelf: false, time: now },
  { sender: '群友B', text: '我也想看看', isSelf: false, time: now + 500 },
];
line = f.buildComplyLineV2(KEY, st);
check('闲聊不顶掉点单', line.includes('照做'));

// 6) 点单已过期（>5 分钟）→ 不判
st.pendingComply = null; st.lastComplyRollAt = 0;
const old = now - 6 * 60 * 1000;
st.recentMessages = [{ sender: '群友A', text: '帮我写个文案', orderText: '帮我写个文案', orderAt: old, isSelf: false, time: old }];
line = f.buildComplyLineV2(KEY, st);
check('过期点单不判', line === '');

// 7) 开关关闭 → 不注入
cfg.socialV2.comply.enabled = false;
st.recentMessages = [{ sender: '群友A', text: '帮我写个文案', orderText: '帮我写个文案', orderAt: now, isSelf: false, time: now }];
line = f.buildComplyLineV2(KEY, st);
check('开关关闭不注入', line === '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
