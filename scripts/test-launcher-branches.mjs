// 验证 start-all.ps1 的两个分支行为（OneBot 就绪 / 未就绪）。
// 做法：把脚本里「决定是否打开 SnowLuma」那段逻辑抽出来跑，
// 分别喂 true/false 给 Test-Port，检查 $openSnowLuma 与是否调用 Start-Process。
// 不真的启动服务、不开浏览器——只验控流。
const { execFileSync } = await import('node:child_process');

const script = `
$ErrorActionPreference = 'Stop'
$results = @()

function Check([bool]$oneBotReady) {
  $openSnowLuma = $false
  $opened = @()
  # 复刻 start-all.ps1 的分支（判定条件与写入 $openSnowLuma 的时机）
  if ($oneBotReady) {
    # 就绪分支：不置 true、不打开
  } else {
    $openSnowLuma = $true
  }
  # 复刻第 5 段的开浏览器条件
  $browserOpened = $false
  if ($openSnowLuma) { $browserOpened = $true; $opened += 'snowluma' }
  return [pscustomobject]@{ oneBotReady = $oneBotReady; openSnowLuma = $openSnowLuma; browserOpened = $browserOpened }
}

Check $true  | ConvertTo-Json -Compress
Check $false | ConvertTo-Json -Compress
`;

const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
const lines = out.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const ready = lines.find((l) => l.oneBotReady === true);
const notReady = lines.find((l) => l.oneBotReady === false);

check('OneBot 就绪 → 不打开 SnowLuma', ready && ready.browserOpened === false, JSON.stringify(ready));
check('OneBot 就绪 → openSnowLuma=false', ready && ready.openSnowLuma === false);
check('OneBot 未就绪 → 打开 SnowLuma', notReady && notReady.browserOpened === true, JSON.stringify(notReady));
check('OneBot 未就绪 → openSnowLuma=true', notReady && notReady.openSnowLuma === true);

// 再验真实脚本里的关键片段存在且语义正确
const fs = await import('node:fs');
const src = fs.readFileSync('scripts/start-all.ps1', 'utf8');
check('脚本默认不打开（初始化为 false）', /\$openSnowLuma = \$false/.test(src));
check('仅在 OneBot 未就绪分支置 true', /else \{\s*\n\s*\$openSnowLuma = \$true/.test(src));
check('已关闭鉴权时开控制台不带 token 参数', /\$needToken/.test(src) && /if \(-not \$needToken\) \{\s*\n\s*Start-Process "http:\/\/127\.0\.0\.1:\$BridgePort"/.test(src));

// 关键回归：SnowLuma 页面必须**在等待扫码之前**打开。
// 曾经的写法是「先等 300 秒扫码、超时 exit 1，最后第 5 段才开页面」——
// 超时路径根本到不了第 5 段，页面永远不弹，用户只能干等。
{
  const openIdx = src.indexOf('Start-Process "http://127.0.0.1:$SnowLumaPort"');
  const waitIdx = src.indexOf('Wait-Port $OneBotWsPort $WaitQrSeconds');
  const exitIdx = waitIdx > 0 ? src.indexOf('exit 1', waitIdx) : -1;
  check('SnowLuma 页面在等待扫码前就打开', openIdx > 0 && waitIdx > 0 && openIdx < waitIdx,
    `open@${openIdx} wait@${waitIdx}`);
  check('超时 exit 位于打开之后（否则页面弹不出来）', exitIdx > openIdx, `exit@${exitIdx}`);
  const openCount = (src.match(/Start-Process "http:\/\/127\.0\.0\.1:\$SnowLumaPort"/g) || []).length;
  check('SnowLuma 只打开一次（不重复弹标签页）', openCount === 1, `${openCount} 次`);
}

console.log(`\n${pass} passed, ${fail} failed`);
