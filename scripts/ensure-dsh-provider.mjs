// ensure-dsh-provider.mjs — DSH provider 自检与自愈（唯一权威入口，别再写第二个）
//
// ── 背景：为什么需要它 ────────────────────────────────────────────────
// `~/.dsh/settings.yaml` 会被改名成 `settings.yaml.imported`，而 DSH **不加载 .imported**，
// 于是 provider 表变空 → 每轮投递报 `model-unavailable: no adapter serves provider "vgw"`，
// QQ 侧表现为机器人不理人。已复发三次（2026-10-01、10-08、10-09）。
//
// **改名者已查明：DSH 桌面端（0.2.0-rc.2）的 settings 迁移逻辑。** 官方文档原文：
//   「一旦 Loader 落定所有条目、Settings 启动，早先版本留在 harness home 里的
//     settings.yaml 会被导入一次……**在首次写入前，文件被改名为 settings.yaml.imported**，
//     运行中的组合拒绝的 section 会被记录并只留在改名后的文件里。」
// 也就是：桌面端启动时把 CLI 写的 settings.yaml 当"旧版遗留"导入并改名。而桥接用的是
// **CLI 版（0.1.1-rc.2）**，它只认 `settings.yaml` 这个文件名 → 配置凭空消失。
// 2026-10-09 那次就是「一打开 dsh 桌面端」触发的，`.imported` 时间是 11:59、报错 16:21。
//
// ── 用法 ─────────────────────────────────────────────────────────────
//   node scripts/ensure-dsh-provider.mjs              # 自检+自愈（start-all.ps1 会自动调用）
//   node scripts/ensure-dsh-provider.mjs --dry-run    # 只打印将要写入的内容
//   node scripts/ensure-dsh-provider.mjs --parse-test # 纯解析自检（不碰 DSH）
//
// 配置健康时只打印一行、什么都不改。丢了就从 `.imported`（它每次都留着上一份好配置，
// 所以同时是最好的备份）或最新 `.bak-*` 里读出 vgw 定义，用官方 API 重写并回读确认。
//
// ⚠️ 修复后仍建议**不要同时开着桌面端**：桌面端 0.2.0 与 CLI 0.1.1 争的是同一个
// `~/.dsh/settings.yaml`，只要它再启动一次就会再改名一次。要么统一用一边，要么
// 每次开完桌面端跑一次本脚本（或直接重跑 start-all.ps1）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DSH_BASE = 'http://127.0.0.1:3080';
const DSH_DIR = path.join(os.homedir(), '.dsh');
const SETTINGS = path.join(DSH_DIR, 'settings.yaml');
const IMPORTED = path.join(DSH_DIR, 'settings.yaml.imported');
const DRY_RUN = process.argv.includes('--dry-run');
const PARSE_TEST = process.argv.includes('--parse-test');

let rpc = 0;
async function call(method, payload = {}) {
  const res = await fetch(`${DSH_BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `ensure${++rpc}`, method, payload }),
    signal: AbortSignal.timeout(60000)
  });
  const json = await res.json();
  if (!json.result?.ok) throw new Error(`${method} 失败: ${JSON.stringify(json.result?.error)}`);
  return json.result.value;
}

// ── yaml 子集解析 ─────────────────────────────────────────────────────
// 手写而非引依赖：settings.yaml 结构很浅（嵌套 map + map 列表）。
// 支持 reasoningEfforts 这种"嵌套 map 作为列表项的一个键"（10/8 之后新增的档位配置）。
function parseYaml(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
  let i = 0;
  const indentOf = (s) => s.match(/^\s*/)[0].length;
  function coerce(v) {
    v = String(v).trim();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~' || v === '') return null;
    // 空对象/空数组必须是结构而非字符串，否则 schema 校验会拒
    // （踩过：compat.chatTemplateKwargs 变成字符串 "{}" 而不是 {}）。
    if (v === '{}') return {};
    if (v === '[]') return [];
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^\[.*\]$/.test(v)) {
      const inner = v.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(',').map((x) => coerce(x.trim().replace(/^['"]|['"]$/g, '')));
    }
    return v.replace(/^['"]|['"]$/g, '');
  }
  function readMap(minIndent) {
    const obj = {};
    while (i < lines.length) {
      const line = lines[i];
      const ind = indentOf(line);
      if (ind < minIndent || line.trim().startsWith('- ')) break;
      const m = /^([^:]+):\s*(.*)$/.exec(line.trim());
      if (!m) { i++; continue; }
      const key = m[1].trim();
      const val = m[2];
      i++;
      if (val.trim() === '') {
        const nxt = lines[i];
        if (nxt && indentOf(nxt) > ind) {
          obj[key] = nxt.trim().startsWith('- ') ? readList(indentOf(nxt)) : readMap(indentOf(nxt));
        } else obj[key] = null;
      } else obj[key] = coerce(val);
    }
    return obj;
  }
  function readList(listIndent) {
    const arr = [];
    while (i < lines.length) {
      const line = lines[i];
      if (indentOf(line) !== listIndent || !line.trim().startsWith('- ')) break;
      const rest = line.trim().slice(2).trim();
      const m = /^([^:]+):\s*(.*)$/.exec(rest);
      if (!m) { arr.push(coerce(rest)); i++; continue; }
      const item = {};
      const firstKey = m[1].trim();
      const firstVal = m[2];
      i++;
      if (firstVal.trim() === '') {
        const nxt = lines[i];
        if (nxt && indentOf(nxt) > listIndent) {
          item[firstKey] = nxt.trim().startsWith('- ') ? readList(indentOf(nxt)) : readMap(indentOf(nxt));
        } else item[firstKey] = null;
      } else item[firstKey] = coerce(firstVal);
      // 同项后续兄弟键：缩进 > listIndent 且不是新的列表项
      while (i < lines.length) {
        const l2 = lines[i];
        const ind2 = indentOf(l2);
        if (ind2 <= listIndent || l2.trim().startsWith('- ')) break;
        const m2 = /^([^:]+):\s*(.*)$/.exec(l2.trim());
        if (!m2) { i++; continue; }
        const k2 = m2[1].trim();
        const v2 = m2[2];
        i++;
        if (v2.trim() === '') {
          const nxt = lines[i];
          if (nxt && indentOf(nxt) > ind2) {
            item[k2] = nxt.trim().startsWith('- ') ? readList(indentOf(nxt)) : readMap(indentOf(nxt));
          } else item[k2] = null;
        } else item[k2] = coerce(v2);
      }
      arr.push(item);
    }
    return arr;
  }
  return readMap(0);
}

function findSource() {
  const cands = [IMPORTED];
  try {
    for (const f of fs.readdirSync(DSH_DIR).filter((f) => /^settings\.yaml\.bak/.test(f)).sort().reverse()) {
      cands.push(path.join(DSH_DIR, f));
    }
  } catch { /* ignore */ }
  if (fs.existsSync(SETTINGS)) cands.push(SETTINGS);
  for (const p of cands) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      if (!/^\s{4}vgw:\s*$/m.test(text)) continue;
      const parsed = parseYaml(text);
      const vgw = parsed['llm-pi-ai']?.providers?.vgw;
      if (vgw?.models?.length) return { path: p, text, vgw, dflt: parsed['agent-default-model'] };
    } catch { /* ignore */ }
  }
  return null;
}

// ── 纯解析自检（不碰 DSH，改动解析器后跑这个）─────────────────────────
if (PARSE_TEST) {
  const src = findSource();
  if (!src) { console.log('❌ 找不到含 vgw 的配置源'); process.exit(1); }
  console.log(`源文件：${path.basename(src.path)}`);
  const models = src.vgw.models;
  const problems = [];
  if (src.vgw.api !== 'openai-completions') problems.push('api 应為 openai-completions');
  if (!/^https?:\/\/127\.0\.0\.1:\d+\/v1$/.test(src.vgw.baseURL || '')) problems.push(`baseURL 可疑: ${src.vgw.baseURL}`);
  if (src.vgw.apiKeyEnv !== 'LOCAL_MODEL_API_KEY') problems.push('apiKeyEnv 应为 LOCAL_MODEL_API_KEY');
  if (models.length < 1) problems.push('models 为空');
  for (const m of models) {
    if (!m.id || !m.name) problems.push(`缺 id/name: ${JSON.stringify(m)}`);
    if (m.contextWindow !== 1000000) problems.push(`${m.id} contextWindow=${m.contextWindow}`);
    if (m.maxTokens !== 32768) problems.push(`${m.id} maxTokens=${m.maxTokens}`);
    if (!Array.isArray(m.input) || !m.input.includes('image')) problems.push(`${m.id} input 应含 image`);
    // reasoningEfforts 允许 false（声明无推理）或对象（档位表），但绝不可是字符串
    const re = m.reasoningEfforts;
    if (re !== false && (typeof re !== 'object' || re === null || Array.isArray(re))) {
      problems.push(`${m.id} reasoningEfforts 类型错: ${JSON.stringify(re)}`);
    }
    if (m.compat && typeof m.compat.chatTemplateKwargs !== 'object') {
      problems.push(`${m.id} compat.chatTemplateKwargs 应是对象`);
    }
  }
  const collectBad = (node, p) => {
    if (typeof node === 'string' && (node === '{}' || node === '[]')) problems.push(`${p} 被解析成字符串 ${node}`);
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) collectBad(v, p ? `${p}.${k}` : k);
  };
  collectBad(src.vgw, 'vgw');
  console.log(`模型 ${models.length} 个: ${models.map((m) => m.id).join(', ')}`);
  console.log('reasoningEfforts 档位:');
  for (const m of models) {
    const re = m.reasoningEfforts;
    console.log(`  ${m.id}: ${re === false ? 'false（不声明推理）' : Object.keys(re).join('/')}`);
  }
  console.log(problems.length ? `\n❌ 有问题：\n  - ${problems.join('\n  - ')}` : '\n✅ 解析结果合法');
  process.exit(problems.length ? 1 : 0);
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main() {
  try {
    await call('llm.providers');
  } catch (e) {
    console.log(`[ensure-provider] DSH :3080 不可达，跳过（${e.message}）`);
    process.exit(0);
  }

  const provs = await call('llm.providers');
  const vgw = provs.providers?.find((p) => p.provider === 'vgw');
  if (vgw && vgw.active !== false) {
    console.log('[ensure-provider] vgw provider 正常，无需处理');
    return;
  }

  const src = findSource();
  if (!src) {
    console.log('[ensure-provider] ⚠️ vgw 缺失，且找不到含 vgw 的备份');
    console.log('[ensure-provider]    请手工恢复：见记忆 dsh-provider-lost-after-reboot');
    process.exit(1);
  }
  console.log(`[ensure-provider] ⚠️ vgw 缺失，从 ${path.basename(src.path)} 恢复`);
  console.log(`[ensure-provider]    settings.yaml 存在=${fs.existsSync(SETTINGS)}（桌面端可能把它改名成了 .imported）`);

  const models = src.vgw.models;
  console.log(`[ensure-provider]    模型 ${models.length} 个，其中带档位配置的 ${models.filter((m) => m.reasoningEfforts && typeof m.reasoningEfforts === 'object').length} 个（会保留）`);

  if (DRY_RUN) {
    console.log('[ensure-provider] --dry-run，将写入：');
    console.log(JSON.stringify(src.vgw, null, 2).slice(0, 1200));
    return;
  }

  await call('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'vgw'], value: src.vgw }] });
  console.log('[ensure-provider] ✅ 已写入 providers.vgw');

  const d = src.dflt;
  const patch = (d?.provider && d?.model)
    ? { provider: d.provider, model: d.model, ...(d.reasoningEffort ? { reasoningEffort: d.reasoningEffort } : {}) }
    : { provider: 'vgw', model: 'cn:deepseek-v4.1-flash' };
  await call('settings.update', { ns: 'agent-default-model', patch });
  console.log('[ensure-provider] ✅ 默认模型 =', JSON.stringify(patch));

  const after = await call('llm.providers');
  const nowOk = after.providers?.find((p) => p.provider === 'vgw');
  console.log(`[ensure-provider] 回读 vgw: active=${nowOk?.active} declared=${nowOk?.declared}`);
  console.log(`[ensure-provider] settings.yaml 已落盘=${fs.existsSync(SETTINGS)}`);
}

await main();
