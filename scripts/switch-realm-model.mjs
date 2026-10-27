// 切换机器人模型（支持 "[realm:]模型名" 虚拟前缀名）。
// 不用 scripts/set-model.mjs 的原因：虚拟前缀名不在网关 /v1/models 列表里时，
// 那个脚本会把它降级声明成 input:[text]，从而丢掉看图能力（群里发图就瞎）。
// 这里优先用网关真实元数据，取不到时回退到同族模板。
//
// 用法：node scripts/switch-realm-model.mjs cn:deepseek-v4.1-flash
//       node scripts/switch-realm-model.mjs global:deepseek-v4.1-flash
import fs from 'node:fs';
import path from 'node:path';

const DSH = 'http://127.0.0.1:3080';
const GATEWAY = 'http://127.0.0.1:7863/v1';
const BRIDGE_DIR = 'C:/qq-bridge';
const CONFIG = path.join(BRIDGE_DIR, 'config.json');
const PROVIDER = 'vgw';
const KEEP_MODELS = 4;

const NEW_MODEL = String(process.argv[2] ?? '').trim();
if (!NEW_MODEL) {
  console.error('用法：node scripts/switch-realm-model.mjs <模型ID>');
  process.exit(1);
}
// 回退模板：虚拟前缀名不在网关列表里时，用同族的裸名参数（上下文/看图能力）。
// 网关列表里通常只有带 realm 前缀的条目（如 cn:deepseek-v4.1-flash），裸名和对面 realm 名都可能缺席，
// 所以再按「另一侧前缀 + 裸名」补一次，避免因为查不到模板就拒绝执行。
const FALLBACK_TEMPLATE = NEW_MODEL.replace(/^[a-z]+:/i, '');

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

// 1) 取网关模型元数据
const gw = await (await fetch(`${GATEWAY}/models`, { headers: { authorization: 'Bearer local' }, signal: AbortSignal.timeout(30000) })).json();
const byId = new Map((gw.data ?? []).map((m) => [m.id, m]));
const newMeta = byId.get(NEW_MODEL);
// 模板查找顺序：裸名 → 两侧 realm 前缀 + 裸名（网关列表常常只收录带前缀的条目）。
// 元数据只用于抄「上下文长度 / 是否支持看图」，取自另一侧 realm 的同名模型是安全的：
// 同一模型在两个 realm 下的能力一致，仅账号池不同。
const bare = FALLBACK_TEMPLATE;
const templateCandidates = [bare, `cn:${bare}`, `global:${bare}`];
let template = templateCandidates.map((id) => byId.get(id)).find(Boolean);
let templateId = templateCandidates.find((id) => byId.get(id));

// 内置兜底：网关列表会变动（2026-09-26 实测 39→29 个，deepseek 系整体从列表消失，
// 但 global:deepseek-v4.1-flash 仍实测可用）。列表查不到时用已知能力，避免脚本直接拒绝。
const BUILTIN_META = {
  'deepseek-v4.1-flash': { context_length: 1000000, supports_images: true },
  'deepseek-v4-flash': { context_length: 1000000, supports_images: true },
  'deepseek-v4-pro': { context_length: 1000000, supports_images: true },
  'glm-5.2': { context_length: 1000000, supports_images: true },
  'glm-5.3': { context_length: 1000000, supports_images: true },
  'glm-5.3-flash': { context_length: 1000000, supports_images: true },
  'minimax-m3': { context_length: 512000, supports_images: true }
};
let usedBuiltin = false;
if (!newMeta && !template && BUILTIN_META[bare]) {
  template = BUILTIN_META[bare];
  templateId = `内置已知能力（${bare}）`;
  usedBuiltin = true;
}
if (!newMeta && !template) {
  console.error(`❌ 网关列表里找不到 ${NEW_MODEL}，也没有可用模板（试过 ${templateCandidates.join(' / ')}），请检查模型 ID`);
  process.exit(1);
}
console.log('新模型在网关列表中:', newMeta ? '是' : `否（虚拟前缀名，回退模板 ${templateId}）`);

const ctx = Number(newMeta?.context_length) || Number(template?.context_length) || 1000000;
const maxOut = 32768; // 与现有配置保持一致（DSH 侧上限，非网关 max_output_tokens）
const supportsImages = (newMeta?.supports_images ?? template?.supports_images) === true;
console.log(`采用元数据: 上下文 ${ctx} | maxTokens ${maxOut} | 支持看图 ${supportsImages ? '✓' : '✗'}`);
if (!supportsImages) console.warn('⚠️  该模型声明为纯文本，群里发图将无法识别');

// 2) 更新 DSH 模型目录：新模型置顶，保留原有（去重、截断）
const nsView = await call('settings.describe');
const piAi = nsView.namespaces.find((n) => n.ns === 'llm-pi-ai');
const current = piAi?.value?.providers?.[PROVIDER]?.models ?? [];
const inputFor = (id) => {
  if (id === NEW_MODEL) return supportsImages ? ['text', 'image'] : ['text'];
  const m = byId.get(id);
  return (m?.supports_images ?? true) ? ['text', 'image'] : ['text'];
};

// reasoningEfforts：**不能硬编码 false**。
// `false` 的语义是「本模型不具备推理能力」，而 provider 级有 `reasoning: <默认档>`；
// 两者一冲突，DSH 直接拒：`pi-ai provider "vgw" model "X" does not support reasoning effort "high"`
// （2026-10-10 实测，用户用桌面 switch-model.bat 切到 global 模型时触发）。
//
// 正确做法：按网关 /v1/models 的 reasoning_supported_efforts 如实声明；
// 并**务必把 provider 级默认档包进去**，否则切过去的模型一样会被拒。
const providerDefaultReasoning = String(piAi?.value?.providers?.[PROVIDER]?.reasoning ?? '').trim();
const effortsFor = (id) => {
  const meta = id === NEW_MODEL ? newMeta : byId.get(id);
  const sup = meta?.reasoning_supported_efforts ?? meta?.reasoningSupportedEfforts;
  const set = new Set(Array.isArray(sup) && sup.length ? sup : []);
  if (providerDefaultReasoning) set.add(providerDefaultReasoning); // 兜底：默认档必须有
  if (!set.size) {
    // 网关没这个模型（虚拟前缀名，如 global:deepseek-v4.1-flash）且无默认档：
    // 用实测可用的档位。high/max 都能正常产出，只是路由到不同上游。
    for (const e of ['high', 'max']) set.add(e);
  }
  return Object.fromEntries([...set].map((e) => [e, e]));
};

const entryOf = (id) => ({
  id,
  name: id,
  contextWindow: id === NEW_MODEL ? ctx : (Number(byId.get(id)?.context_length) || 1000000),
  maxTokens: maxOut,
  input: inputFor(id),
  reasoningEfforts: effortsFor(id),
});
// 保留原有模型，但把历史遗留的 `reasoningEfforts: false` 一并修掉——
// 那是早期版本写坏的（与 provider 级默认档冲突），留着的话切回来还会报同一个错。
const keepExisting = current
  .filter((m) => m.id !== NEW_MODEL)
  .map((m) => (m.reasoningEfforts === false
    ? { ...m, reasoningEfforts: effortsFor(m.id) }
    : { ...m }));
const merged = [entryOf(NEW_MODEL), ...keepExisting].slice(0, KEEP_MODELS);
const repaired = keepExisting.filter((m) => m.reasoningEfforts && current.find((c) => c.id === m.id)?.reasoningEfforts === false);
if (repaired.length) console.log(`顺带修复历史遗留档位: ${repaired.map((m) => m.id).join(', ')}`);

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
