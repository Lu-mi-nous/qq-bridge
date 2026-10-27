// set-model.mjs — 一键把 QQ 机器人的模型切到指定模型
//   用法: node scripts/set-model.mjs <模型ID> [--no-restart]
//   例:   node scripts/set-model.mjs cn:glm-5.2
//
// 做的事：
//   1. 从本地模型网关读取该模型的真实 context_length / max_output_tokens（避免声明过小导致上下文溢出）
//   2. 写入 DSH 的 llm-pi-ai provider 目录（新模型放首位，保留最近几个便于切回）
//   3. 更新 DSH 默认模型
//   4. 更新桥接 config.json 的 dsh.model
//   5. 重启桥接（除非传 --no-restart）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const GATEWAY = 'http://127.0.0.1:7863/v1';
const GATEWAY_KEY = 'local';
const DSH = 'http://127.0.0.1:3080';
const BRIDGE_DIR = 'C:/qq-bridge';
const CONFIG = path.join(BRIDGE_DIR, 'config.json');
const PROVIDER = 'vgw';
const KEEP_MODELS = 4;

const modelId = process.argv[2];
const noRestart = process.argv.includes('--no-restart');
if (!modelId) {
  console.error('用法: node scripts/set-model.mjs <模型ID> [--no-restart]');
  process.exit(1);
}

let rpc = 0;
async function call(method, payload = {}) {
  const r = await fetch(`${DSH}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `m${++rpc}`, method, payload }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`${method}: ${JSON.stringify(j.result?.error)}`);
  return j.result.value;
}

// 1. 读网关模型信息
let ctx = 131072;
let maxOut = 32768;
let credit = '?';
let supportsImages = false;
const gatewayModels = new Map(); // id -> { ctx, supportsImages }
try {
  const r = await fetch(`${GATEWAY}/models`, { headers: { authorization: `Bearer ${GATEWAY_KEY}` }, signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  for (const m of j.data ?? []) {
    gatewayModels.set(m.id, {
      ctx: Number(m.context_length) || 131072,
      supportsImages: m.supports_images === true,
    });
  }
  const hit = (j.data ?? []).find((m) => m.id === modelId);
  if (hit) {
    ctx = Number(hit.context_length) || ctx;
    maxOut = Number(hit.max_output_tokens) || maxOut;
    supportsImages = hit.supports_images === true;
    const m = /x([\d.]+)\s*credit/.exec(String(hit.description ?? ''));
    credit = m ? `x${m[1]}` : '?';
    console.log(`网关信息: ${modelId} | 上下文 ${ctx} | 最大输出 ${maxOut} | 积分倍率 ${credit} | 支持看图 ${supportsImages ? '✓' : '✗'}`);
  } else {
    console.log(`⚠️ 网关模型列表里没有 ${modelId}（仍会尝试配置，上下文按默认 ${ctx} 声明）`);
    console.log(`   可用模型示例: ${(j.data ?? []).slice(0, 8).map((x) => x.id).join(', ')} ...`);
  }
} catch (e) {
  console.log(`⚠️ 读取网关模型列表失败（${e.message}），上下文按默认 ${ctx} 声明`);
}

// 2. 组装模型目录：新模型置顶 + 保留原有（去重、截断）
//    input 按网关的 supports_images 自动声明 —— 声明成 ['text'] 会让 DSH 完全不给模型发图片！
const nsView = await call('settings.describe');
const piAi = nsView.namespaces.find((n) => n.ns === 'llm-pi-ai');
const current = piAi?.value?.providers?.[PROVIDER]?.models ?? [];
const inputFor = (id) => (gatewayModels.get(id)?.supportsImages ? ['text', 'image'] : ['text']);
const entryOf = (id) => ({ id, name: id, contextWindow: id === modelId ? ctx : (gatewayModels.get(id)?.ctx ?? 1000000), maxTokens: 32768, input: inputFor(id), reasoningEfforts: false });
const merged = [entryOf(modelId), ...current.filter((m) => m.id !== modelId).map((m) => ({ ...m, id: m.id }))].slice(0, KEEP_MODELS);

await call('settings.mutate', {
  ns: 'llm-pi-ai',
  ops: [{ op: 'set', path: ['providers', PROVIDER, 'models'], value: merged }],
});

// 3. DSH 默认模型
await call('settings.update', { ns: 'agent-default-model', patch: { provider: PROVIDER, model: modelId } });

// 4. 桥接 config.json
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
cfg.dsh.provider = PROVIDER;
cfg.dsh.model = modelId;
cfg.dsh.reasoningEffort = '';
fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

console.log(`✅ DSH 目录: ${merged.map((m) => m.id).join(', ')}`);
console.log(`✅ DSH 默认模型 + 桥接 config.json -> ${PROVIDER}/${modelId}`);
if (credit !== '?') console.log(`ℹ️ 积分倍率 ${credit}（对比：cn:deepseek-v4.1-flash 是 x0.03）`);

// 5. 重启桥接
if (noRestart) {
  console.log('（--no-restart：请手动重启桥接生效）');
} else {
  const { spawnSync } = await import('node:child_process');
  try {
    // state/bridge.lock 里存着当前桥接的 PID，直接杀它最可靠（不用 shell 里再套引号）
    let oldPid = null;
    try {
      oldPid = Number(fs.readFileSync(path.join(BRIDGE_DIR, 'state', 'bridge.lock'), 'utf8').trim()) || null;
    } catch {}
    if (oldPid) {
      spawnSync('taskkill', ['/PID', String(oldPid), '/F'], { stdio: 'ignore' });
      console.log(`   已停止旧桥接 PID ${oldPid}`);
    } else {
      console.log('   （未找到 lock 里的 PID，直接启动新实例）');
    }
    await new Promise((r) => setTimeout(r, 2500));
    for (const f of fs.readdirSync(path.join(BRIDGE_DIR, 'state'))) {
      if (f.endsWith('.lock')) fs.rmSync(path.join(BRIDGE_DIR, 'state', f), { force: true });
    }
    const child = spawn('C:\\Program Files\\nodejs\\node.exe', [path.join(BRIDGE_DIR, 'src', 'bridge.js')], {
      cwd: BRIDGE_DIR, detached: true, stdio: 'ignore',
    });
    child.unref();
    console.log(`✅ 桥接已重启（新 PID ${child.pid}）`);
  } catch (e) {
    console.log(`⚠️ 重启桥接失败：${e.message}（请手动重启）`);
  }
}
