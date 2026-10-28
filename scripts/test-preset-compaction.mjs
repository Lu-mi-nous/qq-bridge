// 预设压缩配置护栏：DSH 挂载 tool-result-pruner 时会校验
//   headChars + 截断标记 + tailChars ≤ thresholdChars
// 2026-10-28 线上事故：T4 把 thresholdChars 降到 12000 时 headChars 仍留 10000，
// 10000 + 2000 + 39 = 12039 > 12000，整个 preset 挂载失败，会话 resume 全挂。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (error) { fail++; console.log(`FAIL ${name}  ${error?.message ?? error}`); }
};
// DSH 的截断标记实测 39 字符；留 64 的余量，避免上游改文案后再次踩线。
const MARKER_ALLOWANCE = 64;

const presetDirs = fs.readdirSync(path.join(root, 'dsh', 'agent-presets'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

function readPrunerConfig(file) {
  const text = fs.readFileSync(file, 'utf8');
  const i = text.indexOf('tool-result-pruner');
  if (i < 0) return null;
  const block = text.slice(i, i + 400);
  const grab = (key) => {
    const m = new RegExp(`${key}:\\s*(\\d+)`).exec(block);
    return m ? Number(m[1]) : null;
  };
  return { thresholdChars: grab('thresholdChars'), headChars: grab('headChars'), tailChars: grab('tailChars') };
}

for (const id of presetDirs) {
  const file = path.join(root, 'dsh', 'agent-presets', id, 'agent.cordis.yml');
  if (!fs.existsSync(file)) continue;
  const cfg = readPrunerConfig(file);
  check(`${id} 配置了 tool-result-pruner`, () => {
    if (!cfg) throw new Error('未配置');
    if (!(cfg.thresholdChars > 0 && cfg.headChars > 0 && cfg.tailChars >= 0)) throw new Error(JSON.stringify(cfg));
  });
  check(`${id} pruner 满足 head+marker+tail ≤ threshold`, () => {
    const sum = cfg.headChars + cfg.tailChars + MARKER_ALLOWANCE;
    if (sum > cfg.thresholdChars) throw new Error(`${cfg.headChars}+${cfg.tailChars}+${MARKER_ALLOWANCE}=${sum} > ${cfg.thresholdChars}`);
  });
  check(`${id} pruner 阈值已按 T4 收紧到 ≤ 12000`, () => {
    if (cfg.thresholdChars > 12000) throw new Error(`thresholdChars=${cfg.thresholdChars}`);
  });
}

check('qq-chat-v2 部署副本与仓库一致（若存在部署副本）', () => {
  const deployed = path.join('C:/Users/you/.dsh/.agent-presets/qq-chat-v2/agent.cordis.yml');
  if (!fs.existsSync(deployed)) return;
  const text = fs.readFileSync(deployed, 'utf8');
  const cfg = (() => {
    const i = text.indexOf('tool-result-pruner');
    const block = text.slice(i, i + 400);
    const grab = (key) => Number(new RegExp(`${key}:\\s*(\\d+)`).exec(block)?.[1]);
    return { thresholdChars: grab('thresholdChars'), headChars: grab('headChars'), tailChars: grab('tailChars') };
  })();
  if (cfg.headChars + cfg.tailChars + MARKER_ALLOWANCE > cfg.thresholdChars) {
    throw new Error(`部署副本不满足约束：${JSON.stringify(cfg)}`);
  }
});

console.log(fail ? `❌ ${pass} 通过 / ${fail} 失败` : `✅ ${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);
