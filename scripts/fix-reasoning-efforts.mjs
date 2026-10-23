// 修复 global:deepseek-v4.1-flash 的推理档位声明。
//
// 背景（2026-10-10 15:30 报错）：`pi-ai provider "vgw" model "global:deepseek-v4.1-flash"
// does not support reasoning effort "high"`。
//
// 成因是**两处配置互相矛盾**：
//   - provider 级 `reasoning: high`（llm-pi-ai.providers.vgw.reasoning）
//   - 该模型自己的 `reasoningEfforts: false`（声明"本模型不具备推理能力"）
// DSH 见到 provider 要 high、模型却说没有推理 → 直接拒。
//
// 而 `reasoningEfforts: false` 是 `scripts/switch-realm-model.mjs` 里**遗留的硬编码**：
// 那个脚本给所有模型都写 false，早期没有档位概念时无害，10/8 引入档位后就变成地雷。
// 用户用桌面 switch-model.bat 切到 global 模型时触发了它。
//
// 修法：按网关 /v1/models 的真实能力写档位。对不在网关目录里的模型（如
// global:deepseek-v4.1-flash —— 实测不在 /v1/models，但直接调用能通），
// 用实测可用的档位（max 有真实输出，low/high 被网关静默降级成空响应）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:3080';
const GW = 'http://127.0.0.1:7863';
const DRY = process.argv.includes('--dry-run');

let rpc = 0;
async function call(method, payload = {}) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `f${++rpc}`, method, payload }),
    signal: AbortSignal.timeout(60000)
  });
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`${method} 失败: ${JSON.stringify(j.result?.error)}`);
  return j.result.value;
}

// 1) 读网关真实能力表
let gwCap = {};
try {
  const r = await fetch(`${GW}/v1/models`, { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  for (const m of (j.data || j.models || [])) {
    const id = m.id || m.name;
    const sup = m.reasoning_supported_efforts || m.reasoningSupportedEfforts;
    if (id && Array.isArray(sup)) gwCap[id] = sup;
  }
  console.log(`[fix-effort] 网关能力表：${Object.keys(gwCap).length} 个模型`);
} catch (e) {
  console.log(`[fix-effort] ⚠️ 读网关失败（${e.message}），将只修已知冲突`);
}

// 不在网关目录里的模型（如 global:deepseek-v4.1-flash）用实测结论兜底：
// 只有 max 能拿到真实输出，low/high 会被静默降级成空响应。
// 兜底档位：必须包含 provider 级的默认档（reasoning: high），否则 DSH 判「模型不支持该档」直接报错。
// 实测 high 与 max 都能正常产出（只是路由到不同上游），所以两个都声明。
const FALLBACK_EFFORTS = { high: 'high', max: 'max' };

function effortsFor(id) {
  const sup = gwCap[id];
  if (Array.isArray(sup) && sup.length) return Object.fromEntries(sup.map((e) => [e, e]));
  return { ...FALLBACK_EFFORTS };
}

// 2) 读当前 DSH 配置
const nsView = await call('settings.describe');
const ns = (nsView.namespaces || []).find((n) => n.ns === 'llm-pi-ai');
const vgw = ns?.value?.providers?.vgw;
if (!vgw) { console.log('[fix-effort] ❌ 没找到 llm-pi-ai.providers.vgw'); process.exit(1); }

const models = (vgw.models || []).map((m) => {
  const want = effortsFor(m.id);
  const nowStr = m.reasoningEfforts === false ? 'false' : JSON.stringify(m.reasoningEfforts);
  const wantStr = JSON.stringify(want);
  const bad = m.reasoningEfforts === false;
  console.log(`[fix-effort] ${m.id}`);
  console.log(`    现在: ${nowStr}`);
  console.log(`    目标: ${wantStr}${bad ? '   ← 修复（false 与 provider 级 reasoning 冲突）' : ''}`);
  return { ...m, reasoningEfforts: want };
});

const changed = models.filter((m, i) => JSON.stringify(m) !== JSON.stringify((vgw.models || [])[i]));
console.log(`\n[fix-effort] 需要改动 ${changed.length} 个模型`);

if (DRY) { console.log('[fix-effort] --dry-run，未写入'); process.exit(0); }
if (!changed.length) { console.log('[fix-effort] 无需改动'); process.exit(0); }

await call('settings.mutate', {
  ns: 'llm-pi-ai',
  ops: [{ op: 'set', path: ['providers', 'vgw', 'models'], value: models }]
});
console.log('[fix-effort] ✅ 已写入 models');

// 3) 回读确认
const after = await call('settings.describe');
const ns2 = (after.namespaces || []).find((n) => n.ns === 'llm-pi-ai');
for (const m of (ns2?.value?.providers?.vgw?.models || [])) {
  console.log(`[fix-effort] 回读 ${m.id}: ${JSON.stringify(m.reasoningEfforts)}`);
}
const dm = (after.namespaces || []).find((n) => n.ns === 'agent-default-model');
console.log('[fix-effort] 默认模型 =', JSON.stringify(dm?.value));
