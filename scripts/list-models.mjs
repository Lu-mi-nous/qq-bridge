// list-models.mjs — 列出网关模型及其**当前可用性**，便于挑选切换。
//
// 数据来源两个（都在网关 :7863，与 OpenAI 接口同端口）：
//   ① GET /v1/models   模型元数据：积分倍率 credits、上下文、supports_images、supports_tool_call
//   ② GET /status      账号池状态：每个账号的 disabled / cooling / breaker / 模型级限流(rate_limited_models)
//
// 「可用」的判定 = 该模型所属 realm 池里**至少有一个账号对该模型健康**。
// 这是静态判断（免费、快），但调度器仍可能临时选不出号 —— 要权威结论用 --probe 发真实请求实测。
//
// 用法：
//   node scripts/list-models.mjs                     列出全部（可用优先、价格从低到高）
//   node scripts/list-models.mjs --usable            只看当前可用的
//   node scripts/list-models.mjs --vision            只看支持看图的（QQ 群发图需要）
//   node scripts/list-models.mjs --probe             对列出的候选逐个真实请求实测（慢、耗积分，但权威）
//   node scripts/list-models.mjs --switch <模型ID|序号>  直接切换（复用 switch-realm-model.mjs）
//   node scripts/list-models.mjs --switch <...> --no-restart   只改配置，不重启桥接
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const GATEWAY = 'http://127.0.0.1:7863';
const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_NAME = path.basename(BRIDGE_DIR);
const CONFIG = path.join(BRIDGE_DIR, 'config.json');
const SWITCH_SCRIPT = path.join(BRIDGE_DIR, 'scripts', 'switch-realm-model.mjs');
const NODE_EXE = process.execPath;

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ONLY_USABLE = hasFlag('--usable');
const ONLY_VISION = hasFlag('--vision');
const DO_PROBE = hasFlag('--probe');
const NO_RESTART = hasFlag('--no-restart');
const SWITCH_TO = flagValue('--switch');

// ── 取数据 ──────────────────────────────────────────────────────────────────
async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

let models, status;
try {
  const [m, s] = await Promise.all([
    getJson(`${GATEWAY}/v1/models`, { authorization: 'Bearer local' }),
    getJson(`${GATEWAY}/status`),
  ]);
  models = m.data ?? [];
  status = s;
} catch (error) {
  console.error(`❌ 连不上网关（${GATEWAY}）：${error.message}`);
  console.error('   网关是独立进程 wb2api-panel，请确认它在运行。');
  process.exit(1);
}

// ── realm 解析（与网关 resolve_model.go 同口径）─────────────────────────────
// 取第一个 ":"，前段恰为 cn/global 才剥离；否则视为裸名，realm 默认 cn。
function resolveModel(id) {
  const s = String(id);
  const i = s.indexOf(':');
  if (i < 0) return { realm: 'cn', bare: s };
  const prefix = s.slice(0, i);
  if (prefix !== 'cn' && prefix !== 'global') return { realm: 'cn', bare: s };
  return { realm: prefix, bare: s.slice(i + 1) };
}

const accounts = status.accounts ?? [];
const accountsOfRealm = (realm) => accounts.filter((a) => a.realm === realm);

// 某个账号对某裸模型是否健康
function accountHealthyFor(a, bare) {
  if (a.disabled) return false;
  if (a.cooling) return false;
  const breaker = Date.parse(a.breaker_until ?? '');
  if (Number.isFinite(breaker) && breaker > Date.now()) return false;
  const degraded = Date.parse(a.degrade_until ?? '');
  if (Number.isFinite(degraded) && degraded > Date.now()) return false;
  const rl = (a.rate_limited_models ?? []).find((x) => x.model === bare);
  if (rl) {
    const until = Date.parse(rl.until ?? '');
    if (!Number.isFinite(until) || until > Date.now()) return false;
  }
  return true;
}

// 该模型在当前池里的可用情况
function availability(id) {
  const { realm, bare } = resolveModel(id);
  const pool = accountsOfRealm(realm);
  const healthy = pool.filter((a) => accountHealthyFor(a, bare));
  // 不可用时，给出最早解除时间，方便判断等多久
  let earliest = null;
  if (healthy.length === 0) {
    for (const a of pool) {
      const rl = (a.rate_limited_models ?? []).find((x) => x.model === bare);
      const t = Date.parse(rl?.until ?? '');
      if (Number.isFinite(t) && (earliest === null || t < earliest)) earliest = t;
    }
  }
  return { realm, bare, total: pool.length, healthy: healthy.length, earliest };
}

const creditOf = (m) => {
  const n = parseFloat(String(m.credits ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
};

const rows = models.map((m) => {
  const av = availability(m.id);
  return {
    id: m.id,
    name: m.name ?? '',
    credit: m.credits ?? '?',
    creditNum: creditOf(m),
    ctx: m.context_length ?? null,
    vision: m.supports_images === true,
    tools: m.supports_tool_call === true,
    ...av,
  };
});

// ── 当前模型 ────────────────────────────────────────────────────────────────
let currentModel = null;
try {
  currentModel = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))?.dsh?.model ?? null;
} catch {}

// ── 过滤与排序：可用优先 → 便宜优先 ─────────────────────────────────────────
let list = rows;
if (ONLY_USABLE) list = list.filter((r) => r.healthy > 0);
if (ONLY_VISION) list = list.filter((r) => r.vision);
list = list.slice().sort((a, b) => {
  if ((b.healthy > 0) !== (a.healthy > 0)) return (b.healthy > 0) - (a.healthy > 0);
  if (b.healthy !== a.healthy) return b.healthy - a.healthy;
  return a.creditNum - b.creditNum;
});

// ── 输出 ────────────────────────────────────────────────────────────────────
const fmtCtx = (n) => (n ? (n >= 1000000 ? `${(n / 1000000).toFixed(0)}M` : `${Math.round(n / 1000)}K`) : '?');
const pad = (s, n) => {
  const str = String(s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
};

console.log(`网关模型可用性（${new Date().toLocaleString('zh-CN')}）`);
if (currentModel) console.log(`当前机器人模型：${currentModel}`);
console.log(
  `账号池：${accounts.length} 个 | 健康 ${status.healthy ?? '?'} | 冷却 ${status.cooling ?? '?'} | 停用 ${status.disabled ?? '?'}`
);
console.log(`列出 ${list.length} / ${rows.length} 个模型${ONLY_USABLE ? '（仅可用）' : ''}${ONLY_VISION ? '（仅支持看图）' : ''}`);
console.log();

console.log(
  pad('#', 4) + pad('模型ID', 30) + pad('积分', 8) + pad('上下文', 8) + pad('看图', 6) + pad('工具', 6) + pad('可用账号', 10) + '备注'
);
console.log('-'.repeat(104));

list.forEach((r, i) => {
  const usable = r.healthy > 0;
  let note = '';
  if (!usable) {
    note = r.earliest ? `全部限流，最早 ${new Date(r.earliest).toLocaleTimeString('zh-CN')} 解除` : '池内无健康账号';
  } else if (r.healthy < r.total) {
    note = `池内 ${r.total} 个仅 ${r.healthy} 个可用`;
  }
  if (r.id === currentModel) note = note ? `★当前 | ${note}` : '★当前';
  console.log(
    pad(i + 1, 4) +
      pad(r.id, 30) +
      pad(r.credit, 8) +
      pad(fmtCtx(r.ctx), 8) +
      pad(r.vision ? '✓' : '✗', 6) +
      pad(r.tools ? '✓' : '✗', 6) +
      pad(`${r.healthy}/${r.total}`, 10) +
      note
  );
});

console.log();
console.log('说明：');
console.log('  · 「可用账号」是静态判断（读账号池状态，不发请求）。调度器可能仍临时选不出号。');
console.log('  · 要权威结论加 --probe：对上面每个候选发一条真实小请求实测（慢、耗积分）。');
console.log('  · 机器人跑 QQ 群需要「看图 ✓」，否则群里发图它会瞎（且不报错）。');
console.log('  · 不带 realm 前缀的裸名默认走 cn 池；cn/global 是两个独立账号池。');

// ── 可选：真实探测 ──────────────────────────────────────────────────────────
if (DO_PROBE && list.length) {
  console.log();
  console.log(`实测中（${list.length} 个候选，每个约 1~4s）…`);
  console.log(pad('模型ID', 30) + pad('结果', 8) + pad('耗时', 10) + '详情');
  console.log('-'.repeat(90));
  for (const r of list) {
    const t0 = Date.now();
    let ok = false;
    let detail = '';
    try {
      const resp = await fetch(`${GATEWAY}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
        // max_tokens 要给足：该系模型 reasoning 会先吃 token，给太小会得到空 content（不是故障）
        body: JSON.stringify({
          model: r.id,
          messages: [{ role: 'user', content: '回复ok' }],
          max_tokens: 600,
          stream: false,
        }),
        signal: AbortSignal.timeout(120000),
      });
      const j = await resp.json().catch(() => ({}));
      if (resp.status === 200) {
        ok = true;
        detail = JSON.stringify(String(j.choices?.[0]?.message?.content ?? '').trim().slice(0, 24));
      } else {
        detail = `${resp.status} ${j.code ?? ''} ${String(j.gateway_hint ?? j.message ?? '').slice(0, 70)}`;
      }
    } catch (error) {
      detail = `ERR ${error.message}`;
    }
    console.log(pad(r.id, 30) + pad(ok ? '✓ 通' : '✗ 失败', 8) + pad(`${((Date.now() - t0) / 1000).toFixed(1)}s`, 10) + detail);
    await new Promise((res) => setTimeout(res, 800));
  }
}

// ── 可选：直接切换 ──────────────────────────────────────────────────────────
if (SWITCH_TO !== undefined) {
  // 支持用序号（基于本次列表）或直接给模型 ID
  let target = SWITCH_TO;
  const idx = Number(SWITCH_TO);
  if (Number.isInteger(idx) && idx >= 1 && idx <= list.length) {
    target = list[idx - 1].id;
  } else if (!models.some((m) => m.id === target)) {
    console.error(`\n❌ 「${SWITCH_TO}」既不是列表里的序号，也不是已知模型 ID。`);
    process.exit(1);
  }

  console.log();
  console.log(`切换模型：${currentModel ?? '(未读到)'} -> ${target}`);
  try {
    const out = execFileSync(NODE_EXE, [SWITCH_SCRIPT, target], { encoding: 'utf8' });
    process.stdout.write(out);
  } catch (error) {
    console.error('❌ 切换失败：');
    console.error(error.stdout || error.message);
    process.exit(1);
  }

  if (NO_RESTART) {
    console.log('\n（--no-restart）配置已改，需手动重启桥接后才生效。');
  } else {
    restartBridge();
  }
}

// ── 重启桥接 ────────────────────────────────────────────────────────────────
// 注意：桥接通常由守护窗口 `cmd.exe /c start.bat` 拉起，它在桥接退出后 5 秒自动重启，
// 所以必须先杀守护再杀桥接，否则会「杀了又起」。守护启动的桥接命令行是相对路径
// `node src/bridge.js`，按绝对路径匹配抓不到，要按 *bridge.js* 匹配（排除 mcp-* 子进程）。
function restartBridge() {
  console.log('\n重启桥接…');
  const ps = (script) =>
    execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });

  // 1) 杀守护窗口
  const killedGuards = ps(`
    $n = 0
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
      Where-Object { $_.CommandLine -like '*${BRIDGE_NAME}*start.bat*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }
    Write-Output $n
  `).trim();
  console.log(`  守护窗口：停止 ${killedGuards || 0} 个`);

  // 2) 杀桥接进程
  const killedBridge = ps(`
    $n = 0
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }
    Write-Output $n
  `).trim();
  console.log(`  桥接进程：停止 ${killedBridge || 0} 个`);

  // 3) 清残留锁（否则新实例会报「已有实例在运行」）
  try {
    fs.rmSync(path.join(BRIDGE_DIR, 'state', 'bridge.lock'), { force: true });
    console.log('  残留锁：已清理');
  } catch {}

  // 4) 脱离控制台启动（不重定向 stdout：重定向会让子进程挂在启动器控制台上，关窗即杀服务）
  const child = spawn(
    NODE_EXE,
    [path.join(BRIDGE_DIR, 'src', 'bridge.js')],
    { cwd: BRIDGE_DIR, detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();
  console.log(`  新桥接：PID ${child.pid}`);

  console.log('\n等待就绪…');
  const deadline = Date.now() + 45000;
  const waitSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let up = false;
  while (Date.now() < deadline) {
    waitSync(2000);
    try {
      const r = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', "if (Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue) { 'UP' }"],
        { encoding: 'utf8' }
      ).trim();
      if (r === 'UP') {
        up = true;
        break;
      }
    } catch {}
  }

  if (up) {
    console.log('✅ 桥接已就绪（:3100）');
    try {
      const log = fs.readFileSync(path.join(BRIDGE_DIR, 'state', 'bridge.log'), 'utf8').trim().split('\n');
      console.log('\n最近日志：');
      for (const line of log.slice(-8)) console.log('  ' + line);
    } catch {}
    const mm = (() => {
      try {
        return JSON.parse(fs.readFileSync(CONFIG, 'utf8'))?.dsh?.model;
      } catch {
        return null;
      }
    })();
    console.log(`\n当前模型：${mm}`);
    console.log('去 QQ 里发条消息试试即可。');
  } else {
    console.error('❌ 45 秒内未见 :3100 监听，请查看 state/bridge.log');
    process.exit(1);
  }
}
