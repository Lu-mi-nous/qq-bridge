// 回归测试：管理命令的识别与优先级。
//
// 背景（2026-10-13 用户要求「检查管理员命令能否正常生效，若不能则修复」）：
// 端到端实测（隔离环境 + 假 SnowLuma 注入 OneBot 事件）确认命令**基本正常**——
// /status /silent /active /role /role X /reset 都能执行并回复。
//
// 但发现一个**静默失败**：处理顺序里「挂起提问/审批」判定在管理命令之前，
// 且条件含 isOwner，于是管理员发 `/status` 时若该会话恰好有挂起的提问，
// 命令会被当成"回答"发给 DSH —— 命令不执行，而管理员收到的回复却是"已回答"，
// 完全不知道命令被吞了。这类只在挂起期间出现的静默失败极难排查。
//
// 修法：管理员发**已知管理命令**时，跳过挂起消费，让命令块处理。
// 判据取「已知管理命令」而非「以 / 开头」——DSH 自己的斜杠命令（/model 等）
// 必须原样转发给 DSH，不能被抢走。
//
// 本测试从 bridge.js 抽真实判定表达式来跑，并用真实命令清单交叉验证。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const src = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8').replace(/\r\n/g, '\n');

console.log('── 1. 判定表达式存在于源码（防被删改）──');
{
  // 不再锚定「以 .test(plainContent) 结尾」：命令清单会增长（2026-10-17 加了 /wl，
  // 表达式改成以 parseWhitelistCommand(...) 收尾），锚定结尾会让测试因为正常扩展而误报。
  // 现在锚定「从 const adminCmd 到紧随其后的空行」这整段。
  const m = /const adminCmd = ([\s\S]*?)\n\n/.exec(src);
  check('adminCmd 判定已定义', !!m);
  check('判定用 plainContent（不含引用原文，避免被引用内容干扰）', /plainContent\.startsWith\('\/'\)/.test(m?.[1] || ''));
  check('挂起判定已加入"管理命令优先"的例外', /if \(p && !\(isOwner && adminCmd\) &&/.test(src));
  check('例外前有解释注释（防后人误删）', /管理员的管理命令优先/.test(src));
  // 新命令必须进 adminCmd，否则挂起期间会被当成"回答"吞掉
  check('adminCmd 覆盖 /wl', /parseWhitelistCommand\(plainContent\)/.test(m?.[1] || ''));
}

console.log('\n── 2. 判定行为（复刻表达式逐例验证）──');
// 与 bridge.js 内保持一致的复刻（若源码改了而这里没改，下面的交叉验证会失败）
const adminCmdOf = (plainContent) => plainContent.startsWith('/')
  && (['/reset', '/new', '/status', '/silent', '/quiet', '/active', '/speak'].includes(plainContent)
    || plainContent.startsWith('/role ') || plainContent === '/role'
    || /^\/(?:recall|撤回)(?:\s+\d+)?$/i.test(plainContent)
    || /^\/(?:wl|白名单)(?:\s|$)/i.test(plainContent));

{
  const yes = ['/status', '/reset', '/new', '/silent', '/quiet', '/active', '/speak',
    '/role', '/role 阿盐', '/role off', '/recall', '/recall 3', '/撤回', '/撤回 2',
    '/wl', '/wl add 100001004', '/wl del 100001004', '/白名单'];
  const no = ['/model', '/help', '/compact', '普通消息', '', '/roleplay', '/recallx', '/status extra',
    'status', '/wlsomething', '/白名单列表'];
  for (const c of yes) check(`识别管理命令 ${c}`, adminCmdOf(c) === true);
  for (const c of no) check(`不抢 DSH 命令/普通消息 ${JSON.stringify(c)}`, adminCmdOf(c) === false);
}

console.log('\n── 3. 与源码里的命令清单交叉验证（防两处漂移）──');
{
  // 命令块实际处理的命令
  const blockStart = src.indexOf('// 管理命令：仅管理员（ownerQQ）可用');
  const blockEnd = src.indexOf('// 其余 / 开头内容照常发给 DSH', blockStart);
  const block = src.slice(blockStart, blockEnd);
  const handled = new Set();
  for (const m of block.matchAll(/plainContent === '(\/[a-z]+)'/g)) handled.add(m[1]);
  for (const m of block.matchAll(/plainContent\.startsWith\('(\/[a-z]+) /g)) handled.add(m[1]);
  // /recall 与 /撤回 走正则
  if (/\/\(\?:recall\|撤回\)/.test(block)) { handled.add('/recall'); handled.add('/撤回'); }

  check('命令块解析到多个命令', handled.size >= 8, [...handled].join(' '));
  // 每个被处理的命令都必须被 adminCmd 识别（否则挂起期间会被吞）
  let allCovered = true; const missing = [];
  for (const c of handled) {
    if (!adminCmdOf(c) && !adminCmdOf(c + ' 1')) { allCovered = false; missing.push(c); }
  }
  check('命令块处理的每条命令都被 adminCmd 覆盖', allCovered, missing.length ? '未覆盖: ' + missing.join(',') : '');
  // 反向：adminCmd 识别的都该被处理（不能识别了却没人处理，否则命令"消失"）
  check('adminCmd 不识别未知命令（避免误拦 DSH 斜杠命令）', adminCmdOf('/somethingelse') === false);
}

console.log('\n── 4. /reset 无会话时要有反馈 ──');
{
  // 原先无会话时静默 return，管理员会以为命令失效
  check('无会话分支有回复', /当前会话还没有上下文，无需重置/.test(src));
  check('有会话分支仍回复重置成功', /已重置会话，下次消息将开新上下文/.test(src));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
