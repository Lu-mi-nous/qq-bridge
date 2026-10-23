// 回归测试：B 站推荐优先发给活跃群（2026-10-21 用户要求）。
//
// 需求：「B站视频推荐更多推荐给活跃的群聊而不是非活跃的」。
//
// 旧实现的问题：`pickBiliSessionKey()` 取的是 **lastActionAt 最久没动静的那个**——
// 那是**优先冷群**，与需求正好相反。而推荐又复用了这个 key，于是推荐总落在
// 没人说话的群里（实测 9 个群里有 2 个 24 小时零发言）。
//
// 新规则：
//   ① 活跃度 = 近 N 小时**群友**发言数（排除机器人自己）。不能只看 lastActionAt
//      （那只说明"最后一条何时"），也不能拿 recentMessages.length（那是滚动窗口上限）。
//   ② 推荐目的地必须有活跃门槛：近 24h 发言 ≥1 条的群才够格。
//   ③ 候选内按活跃度**加权随机**（不是取最活跃）——否则同一个群天天被推。
//   ④ 落脚群（承载会话）与推荐目标分开：刷视频仍可用冷群，推荐只用活跃群。
import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');
const share = cfg.socialV2?.bili?.share ?? {};

console.log('── 1. 活跃度计算 ──');
{
  check('有 groupActivityScore 函数', /function groupActivityScore\(/.test(bridge));
  check('排除机器人自己的发言', /if \(!m \|\| m\.isSelf\) continue;/.test(bridge));
  check('按时间窗口过滤（不是数数组长度）',
    /if \(t > 0 && t >= from\) n \+= 1;/.test(bridge));
  check('窗口可配（hours 参数）', /const hours = Math\.max\(0\.1, Number\(opts\.hours\)/.test(bridge));
}

console.log('\n── 2. 选群规则 ──');
{
  // 旧行为必须消失：取"最久没动静"
  check('不再按 lastActionAt 升序取最闲（旧行为）',
    !/candidates\.sort\(\(a, b\) => a\.lastActionAt - b\.lastActionAt\);\s*\n\s*return candidates\[0\]\.key;/.test(bridge)
    || /if \(!preferActive\)/.test(bridge),
    '旧逻辑应只在关掉活跃优先时生效');

  check('有"活跃群优先"开关', /preferActiveGroups/.test(bridge));
  check('有关闭后退回旧策略的分支', /if \(!preferActive\) \{/.test(bridge));
  check('按活跃度加权（weight = min(cap, activity)）',
    /weight: Math\.min\(cap, Math\.max\(1, activity\)\)/.test(bridge));
  check('加权随机而非直接取最大', /Math\.random\(\) \* total/.test(bridge));
  check('有活跃门槛参数（requireActive）', /opts\.requireActive === true/.test(bridge));
  check('门槛用 minActivityForShare', /minActivityForShare/.test(bridge));
}

console.log('\n── 3. 落脚群与推荐目标分离 ──');
{
  check('落脚群仍用旧调用（不设活跃门槛）', /const key = pickBiliSessionKey\(\);/.test(bridge));
  check('推荐目标单独选且要求活跃',
    /const shareKey = pickBiliSessionKey\(\{ requireActive: true \}\)/.test(bridge));
  check('分享用 shareKey 而不是 key',
    /maybeShareBiliVideo\(shareKey,/.test(bridge));
  check('没有活跃群时不推荐并说明原因',
    /最近 \$\{Math\.max\(1, Number\(share\.activeWindowHours\) \|\| 24\)\} 小时内没有群达到活跃门槛/.test(bridge)
    || /没有群达到活跃门槛/.test(bridge));
}

console.log('\n── 4. 配置 ──');
{
  check('默认启用活跃群优先', share.preferActiveGroups === true, String(share.preferActiveGroups));
  check('活跃窗口 24 小时', Number(share.activeWindowHours) === 24, String(share.activeWindowHours));
  check('门槛 ≥1 条发言', Number(share.minActivityForShare) >= 1, String(share.minActivityForShare));
  check('有权重上限（防单一群垄断）',
    Number(share.activityWeightCap) > 0 && Number(share.activityWeightCap) <= 200,
    String(share.activityWeightCap));
}

console.log('\n── 5. 控制台可见 ──');
{
  check('有活跃度展示块', /id="biliActivity"/.test(html));
  check('显示每个群的活跃度与是否可推荐',
    /可推荐/.test(html) && /太冷/.test(html) && /<\/b> 条<\/div>/.test(html));
  check('显示可用群数量', /\$\{eligible\.length\}<\/b>\//.test(html) || /eligible\.length/.test(html));
}

console.log('\n── 6. 行为模拟（用真实群数据）──');
{
  // 复刻加权逻辑，验证：冷群永不被选、最活跃群占比最高但不垄断
  const statePath = path.join(root, 'state', 'social-v2.json');
  if (!fs.existsSync(statePath)) {
    console.log('SKIP  真实数据模拟（没有 state/social-v2.json）');
  } else {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const now = Date.now();
    const from = now - 24 * 3600 * 1000;
    const cap = Number(share.activityWeightCap) || 120;
    const minAct = Math.max(1, Number(share.minActivityForShare) || 1);
    const all = Object.entries(state.conversations || {}).filter(([k]) => k.startsWith('group:'));
    const act = new Map(all.map(([k, st]) => [
      k, (st.recentMessages || []).filter((m) => !m.isSelf && Number(m.time) >= from).length
    ]));
    const cands = [...act.entries()].filter(([, a]) => a >= minAct)
      .map(([k, a]) => ({ k, a, w: Math.min(cap, Math.max(1, a)) }));
    check('有候选群', cands.length > 0, String(cands.length));

    const cold = [...act.entries()].filter(([, a]) => a < minAct).map(([k]) => k);
    const N = 8000;
    const cnt = new Map();
    const total = cands.reduce((x, c) => x + c.w, 0);
    for (let i = 0; i < N; i++) {
      let r = Math.random() * total;
      let pick = cands[cands.length - 1];
      for (const c of cands) { r -= c.w; if (r <= 0) { pick = c; break; } }
      cnt.set(pick.k, (cnt.get(pick.k) || 0) + 1);
    }
    const coldPicked = cold.filter((k) => cnt.get(k));
    check('冷群（未达门槛）永远不会被选', coldPicked.length === 0, coldPicked.join(','));
    // 最活跃的群占比应当最高
    const sorted = [...cands].sort((a, b) => b.a - a.a);
    if (sorted.length >= 2 && sorted[0].a > sorted[sorted.length - 1].a * 1.2) {
      const topShare = (cnt.get(sorted[0].k) || 0) / N;
      const lowShare = (cnt.get(sorted[sorted.length - 1].k) || 0) / N;
      check('最活跃群比最冷候选群更容易被选中', topShare > lowShare,
        `${(topShare * 100).toFixed(1)}% vs ${(lowShare * 100).toFixed(1)}%`);
    } else {
      console.log('SKIP  活跃度差距不足 20%，不做占比比较');
    }
    check('没有单一群垄断（最高占比 <50%）',
      Math.max(...cnt.values()) / N < 0.5,
      `${(Math.max(...cnt.values()) / N * 100).toFixed(1)}%`);
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
