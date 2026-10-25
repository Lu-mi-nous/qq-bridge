// model-picker.mjs — 列出网关所有模型，标注可用性，交互式切换机器人模型
//
// 可用性判定分两步，避免"看着可用、实际 503"：
//   ① 账号池探测（零成本、瞬时）：读网关 /status，按目标模型的 realm + 裸名
//      统计未被账号级冷却/熔断/禁用、且未被该模型级限流的账号数；
//   ② 真实探测（可选，-p）：对前若干候选各发一条极小的真实请求，以 HTTP 200 为准。
//
// 切模型用 switch-realm-model.mjs 的同一逻辑（会显式声明 input:[text,image]，
// 不会丢看图能力——这是 set-model.mjs 的已知坑）。
//
// 用法：
//   node model-picker.mjs              # 列表 + 交互选择（终端里直接跑）
//   node model-picker.mjs 3            # 直接切到列表第 3 项（等价于交互输入 3）
//   node model-picker.mjs -p           # 列表时对候选做真实探测（较慢、有极小额消耗）
//   node model-picker.mjs --list       # 只列表不交互
//   node model-picker.mjs --json       # 输出 JSON（供其它脚本消费）
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const DSH = 'http://127.0.0.1:3080';
const GATEWAY = 'http://127.0.0.1:7863/v1';
const GATEWAY_ROOT = 'http://127.0.0.1:7863';
const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(BRIDGE_DIR, 'config.json');
const PROVIDER = 'vgw';
const KEEP_MODELS = 4;

const args = process.argv.slice(2);
const PROBE = args.includes('-p') || args.includes('--probe');
const LIST_ONLY = args.includes('--list');
const JSON_OUT = args.includes('--json');
// 位置参数：期望的序号（1-based），来自命令行而非交互输入
const indexArg = args.find((a) => /^\d+$/.test(a));

const NOW = Date.now();
const isFuture = (t) => {
  if (!t) return false;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) && ms > NOW;
};
const fmtIn = (t) => {
  const ms = new Date(t).getTime() - NOW;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const m = Math.ceil(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m 后` : `${m} 分钟后`;
};

// ── realm 解析（与网关 resolve_model.go 同规则）─────────────────────────────
function splitModel(model) {
  const i = model.indexOf(':');
  if (i < 0) return { realm: 'cn', bare: model };
  const pfx = model.slice(0, i);
  if (pfx !== 'cn' && pfx !== 'global') return { realm: 'cn', bare: model };
  return { realm: pfx, bare: model.slice(i + 1) };
}

// ── ① 账号池可用性 ───────────────────────────────────────────────────────────
function accountsForModel(status, model) {
  const { realm, bare } = splitModel(model);
  const usable = [];
  const blocked = [];
  for (const a of status.accounts ?? []) {
    if (a.realm !== realm) continue;
    if (a.disabled) {
      blocked.push({ uid: a.uid, why: '已禁用' });
      continue;
    }
    if (isFuture(a.breaker_until)) {
      blocked.push({ uid: a.uid, why: `熔断中（${fmtIn(a.breaker_until)}恢复）` });
      continue;
    }
    if (isFuture(a.until)) {
      blocked.push({ uid: a.uid, why: `冷却中（${fmtIn(a.until)}恢复）` });
      continue;
    }
    const hit = (a.rate_limited_models ?? []).find((m) => m.model === bare && isFuture(m.until));
    if (hit) {
      blocked.push({ uid: a.uid, why: `该模型限流（${fmtIn(hit.until)}恢复）` });
      continue;
    }
    usable.push(a.uid);
  }
  return { realm, bare, usable, blocked };
}

// ── ② 真实探测（极小请求）────────────────────────────────────────────────────
async function probe(model) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${GATEWAY}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 16,
        stream: false
      }),
      signal: AbortSignal.timeout(60000)
    });
    const ms = Date.now() - t0;
    if (r.status === 200) return { ok: true, ms };
    let code = '';
    try {
      const j = await r.json();
      code = j.code || j.error?.code || '';
    } catch {}
    return { ok: false, ms, detail: `HTTP ${r.status}${code ? ' ' + code : ''}` };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: e.message };
  }
}

// ── 列表 ─────────────────────────────────────────────────────────────────────
// 候选模型来自三处合并，缺一不可：
//   ① 网关 /v1/models 目录；
//   ② 目录条目的「对面 realm」变体 —— 网关目录的 realm 覆盖并不完整（实测 global 半边
//     完全没有 deepseek 系，但 global:deepseek-v4.1-flash 是真实可用的），只读目录会漏掉它们；
//   ③ DSH 里 vgw 已注册的模型名 —— 这些是曾经显式配过的虚拟名，必属可用集合。
const [modelsRes, statusRes] = await Promise.all([
  fetch(`${GATEWAY}/models`, { headers: { authorization: 'Bearer local' }, signal: AbortSignal.timeout(30000) }),
  fetch(`${GATEWAY_ROOT}/status`, { signal: AbortSignal.timeout(30000) })
]);
const catalog = (await modelsRes.json()).data ?? [];
const status = await statusRes.json();

// DSH 侧的虚拟名（读不到就忽略，不影响列表主体）
async function dshRegisteredModels() {
  try {
    const r = await fetch(`${DSH}/api/settings.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'picker', method: 'settings.describe', payload: {} }),
      signal: AbortSignal.timeout(30000)
    });
    const j = await r.json();
    const list = j.result?.value?.namespaces?.find((n) => n.ns === 'llm-pi-ai')?.value?.providers?.[PROVIDER]?.models ?? [];
    return list.map((m) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

const byId = new Map(catalog.map((m) => [m.id, m]));
const extraIds = new Set();

// ② 跨 realm 变体：cn:X 补 global:X，global:X 补 cn:X。
//    注意这类名字是**推断**出来的：上游对模型的 realm 归属有硬限制（实测 cn:gpt-5.6-luna
//    报 "model is only available in global"、cn:o4-mini 报 "service info not found"），
//    账号池算法看不出这种限制，所以它们一律标记 virtual，只作为"待实测候选"呈现。
for (const m of catalog) {
  const { realm, bare } = splitModel(m.id);
  const other = realm === 'cn' ? `global:${bare}` : `cn:${bare}`;
  if (!byId.has(other)) extraIds.add(other);
}
// ③ DSH 里已注册过的名（曾显式配置成功过，比自动推断的可靠，但仍可能因上游变化失效）
const dshIds = new Set(await dshRegisteredModels());
for (const id of dshIds) if (!byId.has(id)) extraIds.add(id);

// 合成统一候选表：虚拟名借同族已知条目的元数据（上下文/看图/工具/倍率）
const candidates = [...catalog];
for (const id of extraIds) {
  const { bare } = splitModel(id);
  const tpl = byId.get(id) ?? byId.get(`cn:${bare}`) ?? byId.get(`global:${bare}`)
    ?? catalog.find((m) => splitModel(m.id).bare === bare);
  candidates.push({
    id,
    name: tpl?.name || id,
    credits: tpl?.credits,
    context_length: tpl?.context_length,
    supports_images: tpl?.supports_images,
    supports_tool_call: tpl?.supports_tool_call,
    virtual: true,
    // DSH 里注册过 = 曾切换成功，可信度高于纯推断
    seenInDsh: dshIds.has(id)
  });
}

// 倍率字段是自由文本，实测有三种形态："x0.11" / "x0.77 credits" / undefined。
// 用正则抓第一个 x<数字>，避免把 "credits" 当成数字、也避免 0.00 被误判成"未知"。
const parseCredit = (raw) => {
  const m = /x\s*([\d.]+)/i.exec(String(raw ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
};
const creditLabel = (raw) => {
  const n = parseCredit(raw);
  return n === null ? '-' : `x${n.toFixed(2)}`;
};
const rows = candidates
  .map((m) => {
    const acc = accountsForModel(status, m.id);
    const creditNum = parseCredit(m.credits);
    const virtual = m.virtual === true;
    return {
      id: m.id,
      name: m.name || m.id,
      credits: creditLabel(m.credits),
      // 未知倍率排到最后（视为昂贵）；已知倍率按数值升序
      creditNum: creditNum === null ? Number.POSITIVE_INFINITY : creditNum,
      context: Number(m.context_length) || 0,
      images: m.supports_images === true,
      tools: m.supports_tool_call === true,
      usable: acc.usable.length,
      blocked: acc.blocked,
      realm: acc.realm,
      virtual,
      seenInDsh: m.seenInDsh === true,
      // 排序权重：目录内条目 > DSH 注册过的虚拟名 > 纯推断的跨 realm 名
      rank: m.virtual ? (m.seenInDsh ? 1 : 2) : 0,
      probe: null
    };
  })
  .sort((a, b) => a.rank - b.rank || b.usable - a.usable || a.creditNum - b.creditNum || a.id.localeCompare(b.id));

// 真实探测：优先测 DSH 注册过 / 池内看似可用的候选，最多 8 个（控制耗时与消耗）
if (PROBE) {
  const targets = rows.filter((r) => r.rank < 2 && r.usable > 0).slice(0, 8);
  if (!JSON_OUT) console.error(`\n正在真实探测 ${targets.length} 个候选（每个一条极小请求）…\n`);
  for (const r of targets) {
    process.stderr.write(`  探测 ${r.id} … `);
    r.probe = await probe(r.id);
    process.stderr.write(r.probe.ok ? `✅ ${r.probe.ms}ms\n` : `❌ ${r.probe.detail}\n`);
    await new Promise((res) => setTimeout(res, 800));
  }
  // 探测结果参与排序：确认可用的排最前
  rows.sort((a, b) => {
    const av = a.probe ? (a.probe.ok ? 2 : 0) : 1;
    const bv = b.probe ? (b.probe.ok ? 2 : 0) : 1;
    return bv - av || b.usable - a.usable || a.creditNum - b.creditNum;
  });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ models: rows, pool: status.realm_totals ?? null }, null, 2));
  process.exit(0);
}

// ── 渲染 ─────────────────────────────────────────────────────────────────────
const curCfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const current = curCfg.dsh?.model ?? '';

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

console.log('');
console.log('  网关可用模型（按可用性 / 倍率排序）');
console.log(`  当前机器人模型：${current}`);
console.log('');
console.log(`  ${pad('#', 4)}${pad('模型 ID', 34)}${pad('倍率', 8)}${pad('上下文', 9)}${pad('看图', 6)}${pad('可用号', 8)}状态`);
console.log('  ' + '─'.repeat(96));
rows.forEach((r, i) => {
  let state;
  if (r.probe) state = r.probe.ok ? `✅ 实测通过 ${r.probe.ms}ms` : `❌ 实测失败 ${r.probe.detail}`;
  else if (r.virtual && !r.seenInDsh) {
    // 纯推断的跨 realm 名：上游可能根本不给这个模型提供服务（实测有 "only available in global" 之类）
    state = r.usable > 0 ? '⚠️ 推断名，未验证（加 -p 实测）' : `无账号（${r.blocked[0]?.why ?? '该 realm 无号'}）`;
  } else if (r.usable > 0) state = `池内可用（${r.usable} 个账号）`;
  else state = r.blocked.length ? `不可用：${r.blocked[0].why}` : '池内无该 realm 账号';
  // 虚拟名（不在网关目录、元数据借自同族条目）加 * 标记，提示"能力字段是推断值"
  const star = r.virtual ? '*' : ' ';
  const mark = r.id === current ? ' ←当前' : '';
  console.log(
    `  ${pad(i + 1, 4)}${pad(r.id, 34)}${pad(r.credits || '-', 8)}${pad(r.context ? r.context / 1000 + 'k' : '-', 9)}${pad(r.images ? '✓' : '✗', 6)}${pad(r.usable, 8)}${star}${state}${mark}`
  );
});
const totals = status.realm_totals ?? {};
console.log('');
console.log('  * = 该名不在网关模型目录里（虚拟 realm 路由），倍率/上下文借自同族模型，仅供参考。');
console.log('     带「推断名，未验证」的条目是脚本按 realm 前缀推断出来的，上游未必提供服务，切换前建议 -p 实测。');
console.log('');
console.log(`  账号池：cn ${totals.cn?.healthy ?? '?'}/${totals.cn?.total ?? '?'} 健康，global ${totals.global?.healthy ?? '?'}/${totals.global?.total ?? '?'} 健康`);
console.log('  提示：倍率越低越省积分；机器人是群聊场景，建议优先选看图 ✓ 且倍率低的模型。');
if (!PROBE) console.log('  提示：加 -p 可对候选做真实探测（更准，约 10 秒）。');
console.log('  注意：账号池状态会实时变化，切之前看这里，切完若报 503 就再跑一次换一条。');
console.log('');

if (LIST_ONLY) {
  console.log('');
  process.exit(0);
}

// ── 选择目标 ─────────────────────────────────────────────────────────────────
// 序号来源优先级：命令行位置参数 > 交互提示（TTY）> 管道输入（echo 3 | node ...）。
// 三者都没有则只列表退出，不阻塞。
const readLineFromStdin = async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((res) => {
      rl.question('  输入序号切换模型（直接回车取消）: ', res);
    });
  } finally {
    rl.close();
  }
};

let answer = indexArg ?? '';
if (!answer) {
  if (process.stdin.isTTY) {
    answer = (await readLineFromStdin()).trim();
  } else {
    // 非 TTY：若 stdin 有内容（管道/重定向），读一行；否则只列表
    answer = (await readLineFromStdin()).trim();
  }
}
if (!answer) {
  console.log('  已取消。\n');
  process.exit(0);
}
const idx = Number(answer);
if (!Number.isInteger(idx) || idx < 1 || idx > rows.length) {
  console.error(`  ❌ 序号无效：${answer}（有效范围 1-${rows.length}）\n`);
  process.exit(1);
}
const target = rows[idx - 1];

if (target.id === current) {
  console.log(`  当前已经是 ${current}，无需切换。\n`);
  process.exit(0);
}
if (target.usable === 0 && !target.probe?.ok) {
  const why = target.blocked[0]?.why ?? '池内无该 realm 账号';
  // 命令行已显式指定序号 → 视为确认（便于脚本化）；否则交互征询
  if (!indexArg) {
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const go = (await new Promise((res) => rl2.question(`  ⚠️ ${target.id} 当前不可用（${why}），仍要切换？[y/N] `, res))).trim().toLowerCase();
    rl2.close();
    if (go !== 'y' && go !== 'yes') {
      console.log('  已取消。\n');
      process.exit(0);
    }
  } else {
    console.log(`  ⚠️ ${target.id} 池内暂不可用（${why}）—— 按指定序号继续切换。`);
  }
}

console.log('');
console.log(`  正在切换到 ${target.id} …`);

// 复用 switch-realm-model.mjs：保证显式声明看图能力，不丢视觉
const { spawnSync } = await import('node:child_process');
const sw = spawnSync(process.execPath, [path.join(BRIDGE_DIR, 'scripts', 'switch-realm-model.mjs'), target.id], {
  cwd: BRIDGE_DIR,
  encoding: 'utf8'
});
process.stdout.write(sw.stdout ?? '');
process.stderr.write(sw.stderr ?? '');
if (sw.status !== 0) {
  console.error(`\n  ❌ 切换失败（退出码 ${sw.status}）。配置未改动，可重试。\n`);
  process.exit(sw.status ?? 1);
}

// 重启桥接：必须先杀守护（start.bat 会在桥接退出后 5s 自动拉起），再杀桥接，否则杀不干净。
console.log('');
console.log('  正在重启桥接 …');
const ps = (cmd) =>
  spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });

// ① 守护窗口（cmd.exe 跑 start.bat）；② 桥接本体（命令行可能是相对/绝对路径）
ps(`Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*qq-bridge-main*start.bat*' -and $_.CommandLine -notlike '*stop*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
await new Promise((r) => setTimeout(r, 2500));
try {
  fs.rmSync(path.join(BRIDGE_DIR, 'state', 'bridge.lock'), { force: true });
} catch {}

spawnSync('powershell', [
  '-NoProfile',
  '-Command',
  `Start-Process -FilePath 'C:\\Program Files\\nodejs\\node.exe' -ArgumentList '"${path.join(BRIDGE_DIR, 'src', 'bridge.js')}"' -WorkingDirectory '${BRIDGE_DIR}' -WindowStyle Hidden`
], { encoding: 'utf8' });

// 等启动并确认
let ok = false;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const r = await fetch(`http://127.0.0.1:3100/`, { signal: AbortSignal.timeout(3000) });
    if (r.status === 401 || r.status === 200) {
      ok = true;
      break;
    }
  } catch {}
}
console.log('');
if (ok) {
  console.log(`  ✅ 已切换到 ${target.id}`);
  console.log('  ✅ 桥接已重启（控制台 http://127.0.0.1:3100 已就绪）');
  console.log('  提示：切换后会新建模型缓存，已有 QQ 会话会在下一条消息时切到新模型。');
} else {
  console.log(`  ⚠️ 配置已切到 ${target.id}，但桥接似乎没起来。`);
  console.log('     请双击桌面「启动QQ机器人.bat」，或查看 state\\bridge.log。');
}
console.log('');
