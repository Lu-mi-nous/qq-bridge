// 回归测试：控制台「重启桥接」必须真的重启。
//
// 用户反馈（2026-10-21）：「控制台的重启桥接按钮并没有重启的效果」。
//
// ── 根因 ──────────────────────────────────────────────────────────────
//
// 旧实现只做两件事：`releaseLock()` + `process.exit(0)`。
// 它把"重新启动"完全交给**外部守护窗口**（`start.bat` 的死循环）。
// 问题在于：守护窗口只存在于"手动双击 start.bat 启动"的那一种情形。
// 用 nohup / 计划任务 / 别的脚本拉起时，exit(0) 就是**彻底停服**——
// 按钮看起来"点了没反应"，实际上是"点了就关了"。
//
// 实测日志：19:52:12 打出「控制台：重启桥接」后退出，19:53:06 才出现新进程，
// 中间空了 54 秒；而前端只轮询 30 秒就显示"桥接尚未恢复"。两个问题叠加。
//
// ── 修法 ──────────────────────────────────────────────────────────────
//
// ① 桥接**自己** spawn 一个 detached 子进程（stdio 忽略、unref），父进程再退出。
// ② 子进程启动时若带 QQB_RESTARTED_BY，先等锁文件消失再抢锁
//    （父进程 spawn 后到 exit 之间有几十毫秒仍持锁，直接抢会 exit(2)
//     —— 那就变成"重启按钮把服务关掉"的最坏结果）。
// ③ 前端轮询从 30 秒放宽到 60 秒，并显示秒数进度。
//
// 本测试锁住这三条，防止以后有人"优化"回 exit-only。
import fs from 'node:fs';
import path from 'node:path';
import { readConsoleSource } from './lib/console-src.mjs';
import { readConsoleUiSource } from './lib/console-ui-src.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const bridge = readConsoleSource();
const mainBridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
const html = readConsoleUiSource();
const coreCards = fs.readFileSync(path.join(root, 'src', 'console', 'core-cards.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'public', 'console', 'core', 'renderer.js'), 'utf8');

// R4.7：/api/restart 的实现在 commands/ops.js；路由只转发。
// 端点存在仍看路由源码，自重启细节看命令模块。
const routeStart = bridge.indexOf("pathname === '/api/restart'");
const opsCommands = fs.readFileSync(path.join(root, 'src', 'console', 'commands', 'ops.js'), 'utf8');
const start = opsCommands.indexOf('function scheduleRestart');
const block = opsCommands.slice(start, start + 2600);

console.log('── 1. 服务端：必须自重启，不能只 exit ──');
{
  check('有 /api/restart 端点', routeStart > 0 && start > 0);
  check('用了 detached spawn', /detached:\s*true/.test(block));
  check('spawn 的是 bridge.js 自身', /spawn\(process\.execPath,\s*\[path\.join\(ROOT,\s*'src',\s*'bridge\.js'\)\]/.test(block));
  check('子进程 unref（父进程退出后继续跑）', /\.unref\(\)/.test(block));
  check('stdio 忽略/重定向（不继承父进程管道）', /stdio:\s*\['ignore',\s*out,\s*out\]/.test(block));
  check('标记了自重启来源', /QQB_RESTARTED_BY:\s*'console'/.test(block));
  check('先 spawn 再 exit（顺序不能反）',
    block.indexOf('spawn(') < block.indexOf('process.exit('));
  check('spawn 失败时 exit 1（不是假装成功）', /process\.exit\(spawned \? 0 : 1\)/.test(block));
  check('失败了仍 releaseLock（别留死锁）',
    block.indexOf('releaseLock()') < block.indexOf('process.exit(spawned'));
  // 关键回归点：不能退回"只 exit 等外部守护"
  check('不再依赖"若由守护窗口启动"的措辞', !/若由守护窗口启动/.test(block));
}

console.log('\n── 2. 子进程：等待父进程释放锁 ──');
{
  check('启动时识别自重启环境', /if \(process\.env\.QQB_RESTARTED_BY\)/.test(mainBridge));
  check('等锁文件消失再 acquireLock', /QQB_RESTARTED_BY[\s\S]{0,600}?existsSync\(LOCK_FILE\)[\s\S]{0,200}?acquireLock\(\)/.test(mainBridge));
  check('有等待上限（不能死等）', /deadline\s*=\s*Date\.now\(\)\s*\+\s*\d+/.test(mainBridge));
  check('日志写明由谁拉起', /由\$\{process\.env\.QQB_RESTARTED_BY === 'console' \? '控制台重启'/.test(mainBridge));
  check('就绪时再打一次带 PID 的标记', /桥接已就绪（控制台自重启，PID \$\{process\.pid\}）/.test(mainBridge));
  // 锁释放 ≠ 端口释放：父进程 exit 收尾时 :3100 可能还挂着几十毫秒，
  // 子进程直接 bind 会 EADDRINUSE → exit(2)，服务就彻底停了。
  check('有 waitForPortFree 且被自重启路径调用', /async function waitForPortFree/.test(mainBridge)
    && /QQB_RESTARTED_BY[\s\S]{0,900}?await waitForPortFree\(/.test(mainBridge));
  check('端口等待有超时上限（不死等）', /deadline = Date\.now\(\) \+ Math\.max\(0, timeoutMs\)/.test(mainBridge));
}

console.log('\n── 3. 前端：轮询时间够长、有进度 ──');
{
  // 通用配置卡里的重启按钮
  check('凭据卡按钮轮询 60 次（60 秒）', /for \(let i = 0; i < 60; i\+\+\)/.test(html));
  check('凭据卡按钮显示秒数进度', /正在重启…（\$\{i \+ 1\}s）/.test(html));
  check('凭据卡按钮失败时说清楚去哪看日志', /state\/bridge\.log/.test(html));
  check('凭据卡按钮不再写死 30 秒', !/for \(let i = 0; i < 30; i\+\+\)/.test(html));

  // 17 桥接控制卡（声明式 actions）：由 renderer 统一等待恢复。
  const i2 = coreCards.indexOf("id: '17'");
  const b2 = coreCards.slice(i2, i2 + 2200);
  check('控制卡声明 60 秒恢复等待', /timeoutMs: 60000/.test(b2));
  check('控制卡会等它回来再刷新页面', /reloadAfter: true/.test(b2)
    && /item\.reloadAfter[\s\S]{0,80}location\.reload\(\)/.test(renderer));
  check('控制卡显示秒数进度', /等待服务恢复…（\$\{waited\}s）/.test(renderer));
  check('控制卡不再只发请求就结束', /waitFor:\s*\{/.test(b2) && /if \(!ready\) throw new Error/.test(renderer));
  check('确认框说清了"会中断对话"', /进行中的对话会中断/.test(b2));
}

console.log('\n── 4. 不破坏其它重启路径 ──');
{
  check('restart.bat 仍存在（守护式重启仍可用）', fs.existsSync(path.join(root, 'restart.bat')));
  const bat = fs.readFileSync(path.join(root, 'restart.bat'), 'utf8');
  check('restart.bat 会杀掉旧进程', /Stop-Process/.test(bat));
  check('start.bat 仍有守护循环', /goto loop/.test(fs.readFileSync(path.join(root, 'start.bat'), 'utf8')));
  check('exit 2 语义未被改动（已有实例时不自欺）',
    /if "%code%"=="2"/.test(fs.readFileSync(path.join(root, 'start.bat'), 'utf8').replace(/^\uFEFF/, '')));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
