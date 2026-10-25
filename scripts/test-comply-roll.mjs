// 一次性回归：验证点单判定（掷骰/冷却/上限/同请求复用）。
// 显式注入内存状态，直接运行导出模块。
import { createContentRequestPolicy } from '../src/pipeline/content-request.js';

let cfg = { socialV2: { comply: { enabled: true, probability: 0.7, ttlMs: 180000, cooldownMs: 20000, maxPerHour: 12 } } };
const states = new Map();
let saves = 0;
const logs = [];
const getSocialV2State = (key) => {
  if (!states.has(key)) states.set(key, { complyTimes: [] });
  return states.get(key);
};
const saveSocialV2State = () => { saves++; };
const log = (m) => logs.push(m);

const f = createContentRequestPolicy({ cfg, getSocialV2State, saveSocialV2State, log, getSelfNickname: () => "dsh" });

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const KEY = 'group:1';
const st = getSocialV2State(KEY);

// 1) 概率=1 → 必定照做
cfg.socialV2.comply.probability = 1;
let r = f.rollComplyV2(KEY, '帮我写个文案');
check('概率1 → 照做', r && r.comply === true, JSON.stringify({ comply: r?.comply }));

// 2) 同一请求复用判定（不重新掷骰）
const firstAt = r.at;
r = f.rollComplyV2(KEY, '帮我写个文案');
check('同请求复用判定', r && r.at === firstAt);

// 3) 冷却期内、不同请求 → 不判定
r = f.rollComplyV2(KEY, '换个完全不同的请求内容');
check('冷却期内不判定', r === null);

// 4) 过期后新请求 → 重新判定；概率=0 → 自由发挥
st.pendingComply.expireAt = 0;
st.lastComplyRollAt = 0;
cfg.socialV2.comply.probability = 0;
r = f.rollComplyV2(KEY, '再帮我写一段别的东西');
check('概率0 → 自由发挥', r && r.comply === false);

// 5) 每小时上限：拉满后即便概率=1 也不照做
st.pendingComply.expireAt = 0;
st.lastComplyRollAt = 0;
cfg.socialV2.comply.probability = 1;
st.complyTimes = Array.from({ length: 12 }, () => Date.now());
r = f.rollComplyV2(KEY, '上限测试请求');
check('触及每小时上限 → 自由发挥', r && r.comply === false && r.capped === true);

// 6) 开关关闭 → 不判定
st.pendingComply = null;
st.lastComplyRollAt = 0;
cfg.socialV2.comply.enabled = false;
r = f.rollComplyV2(KEY, '开关关闭测试');
check('开关关闭不判定', r === null);

// 7) 概率分布抽样（粗验，不追求精确）
cfg.socialV2.comply.enabled = true;
cfg.socialV2.comply.probability = 0.7;
cfg.socialV2.comply.cooldownMs = 0;
let yes = 0;
const N = 2000;
for (let i = 0; i < N; i++) {
  const s2 = { complyTimes: [] };
  states.set('group:2', s2);
  const rr = f.rollComplyV2('group:2', 'req' + i);
  if (rr && rr.comply) yes++;
}
const rate = yes / N;
check('概率≈0.70（±0.05）', Math.abs(rate - 0.7) < 0.05, `实测 ${rate.toFixed(3)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
