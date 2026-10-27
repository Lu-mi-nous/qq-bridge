// 一次性切换脚本：把机器人模型切到 global:deepseek-v4.1-flash。
// 不用 scripts/set-model.mjs 的原因：该模型是按 "[realm:]" 前缀路由的虚拟名，
// 不在网关 /v1/models 列表里，那个脚本会把它降级声明成 131072 上下文 + input:[text]，
// 从而丢掉看图能力（群里发图就瞎）。这里直接沿用 cn:deepseek-v4.1-flash 的真实元数据。
import fs from 'node:fs';
import path from 'node:path';

const DSH = 'http://127.0.0.1:3080';
const GATEWAY = 'http://127.0.0.1:7863/v1';
const BRIDGE_DIR = 'C:/qq-bridge';
const CONFIG = path.join(BRIDGE_DIR, 'config.json');
const PROVIDER = 'vgw';
const NEW_MODEL = 'global:deepseek-v4.1-flash';
const KEEP_MODELS = 4;

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

// 1) 取网关模型元数据（新模型不在列表里，用同族的 cn 版参数作为模板）
const gw = await (await fetch(`${GATEWAY}/models`, { headers: { authorization: 'Bearer local' }, signal: AbortSignal.timeout(30000) })).json();
const byId = new Map((gw.data ?? []).map((m) => [m.id, m]));
const newMeta = byId.get(NEW_MODEL);
const template = byId.get('cn:deepseek-v4.1-flash');
console.log('新模型在网关列表中:', newMeta ? '是' : '否（虚拟前缀名）');

const ctx = Number(newMeta?.context_length) || Number(template?.context_length) || 1000000;
const maxOut = 32768; // 与现有配置保持一致（DSH 侧上限，非网关 max_output_tokens）
const supportsImages = (newMeta?.supports_images ?? template?.supports_images) === true;
console.log(`采用元数据: 上下文 ${ctx} | maxTokens ${maxOut} | 支持看图 ${supportsImages ? '✓' : '✗'}`);

// 2) 更新 DSH 模型目录：新模型置顶，保留原有（去重、截断）
const nsView = await call('settings.describe');
const piAi = nsView.namespaces.find((n) => n.ns === 'llm-pi-ai');
const current = piAi?.value?.providers?.[PROVIDER]?.models ?? [];
const inputFor = (id) => {
  if (id === NEW_MODEL) return supportsImages ? ['text', 'image'] : ['text'];
  const m = byId.get(id);
  return (m?.supports_images ?? true) ? ['text', 'image'] : ['text'];
};
const entryOf = (id) => ({
  id,
  name: id,
  contextWindow: id === NEW_MODEL ? ctx : (Number(byId.get(id)?.context_length) || 1000000),
  maxTokens: maxOut,
  input: inputFor(id),
  reasoningEfforts: false,
});
const merged = [entryOf(NEW_MODEL), ...current.filter((m) => m.id !== NEW_MODEL).map((m) => ({ ...m }))].slice(0, KEEP_MODELS);

await call('settings.mutate', {
  ns: 'llm-pi-ai',
  ops: [{ op: 'set', path: ['providers', PROVIDER, 'models'], value: merged }],
});
console.log(`✅ DSH 模型目录: ${merged.map((m) => m.id).join(', ')}`);

// 3) DSH 默认模型
await call('settings.update', { ns: 'agent-default-model', patch: { provider: PROVIDER, model: NEW_MODEL } });
console.log(`✅ DSH 默认模型 -> ${PROVIDER}/${NEW_MODEL}`);

// 4) 桥接 config.json
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const before = cfg.dsh.model;
cfg.dsh.provider = PROVIDER;
cfg.dsh.model = NEW_MODEL;
cfg.dsh.reasoningEffort = '';
fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
console.log(`✅ 桥接 config.json: ${before} -> ${cfg.dsh.model}`);
