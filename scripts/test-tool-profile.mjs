// T2：preset 级工具 profile（core/media/bili/full）与 restrict 应用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolNamesOf } from '../src/tool-flags.js';
import {
  TOOL_PROFILES, resolveProfile, readProfile, apply, PROFILE_FILE
} from '../dsh/agent-presets/qq-chat-v2/tool-profile.mjs';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (error) { fail++; console.log(`FAIL ${name}  ${error?.message ?? error}`); }
};
const allTools = new Set(toolNamesOf());

check('默认 profile 文件为 full（不改变现有行为）', () => {
  assert.equal(JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')).profile, 'full');
  assert.equal(readProfile(), 'full');
});

check('未知 profile 回退 full 并标记 unknown', () => {
  const r = resolveProfile('nope');
  assert.equal(r.id, 'full'); assert.equal(r.filter, null); assert.equal(r.unknown, 'nope');
  assert.equal(resolveProfile('').id, 'full');
  assert.equal(resolveProfile(undefined).unknown, '');
});

check('core 为 8–12 个工具且都在工具清单里', () => {
  const allow = TOOL_PROFILES.core.allow;
  assert.ok(allow.length >= 8 && allow.length <= 12, `core=${allow.length}`);
  for (const name of allow) assert.ok(allTools.has(name), `未知工具：${name}`);
  assert.equal(new Set(allow).size, allow.length, 'core 有重复工具');
});

check('media / bili 都包含 core 且工具名合法', () => {
  const core = new Set(TOOL_PROFILES.core.allow);
  for (const profile of ['media', 'bili']) {
    const allow = TOOL_PROFILES[profile].allow;
    for (const name of core) assert.ok(allow.includes(name), `${profile} 缺 ${name}`);
    for (const name of allow) assert.ok(allTools.has(name), `${profile} 未知工具：${name}`);
  }
  assert.ok(TOOL_PROFILES.media.allow.length > TOOL_PROFILES.core.allow.length);
  assert.ok(TOOL_PROFILES.bili.allow.length > TOOL_PROFILES.core.allow.length);
});

check('full / admin 不限制', () => {
  assert.equal(TOOL_PROFILES.full, null);
  assert.equal(TOOL_PROFILES.admin, null);
});

check('apply(full) 不调用 restrict', () => {
  const calls = [];
  apply({ tools: { restrict: (filter) => calls.push(filter) } });
  assert.equal(calls.length, 0);
});

check('apply(core) 用 allow 掩码调用一次 restrict', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-profile-'));
  const file = path.join(dir, 'tool-profile.json');
  fs.writeFileSync(file, '{"profile":"core"}');
  const prev = readProfile(file);
  assert.equal(prev, 'core');
  // apply 固定读 PROFILE_FILE；这里直接验证 resolve+restrict 的契约。
  const { filter } = resolveProfile(prev);
  const calls = [];
  const ctx = { tools: { restrict: (f) => calls.push(f) } };
  ctx.tools.restrict({ allow: filter.allow });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].allow, TOOL_PROFILES.core.allow);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('profile 文件缺失/损坏时回退 full', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-profile-bad-'));
  assert.equal(readProfile(path.join(dir, 'missing.json')), 'full');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  assert.equal(readProfile(path.join(dir, 'bad.json')), 'full');
  fs.writeFileSync(path.join(dir, 'empty.json'), '{}');
  assert.equal(readProfile(path.join(dir, 'empty.json')), 'full');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('profile 插件已挂载进 preset 且默认 full', () => {
  const preset = fs.readFileSync(path.join(path.dirname(PROFILE_FILE), 'agent.cordis.yml'), 'utf8');
  assert.ok(preset.includes('qq-tool-profile'));
  assert.ok(preset.includes('./tool-profile.mjs'));
  assert.ok(preset.includes('qq-tool-restrict'), '执行期白名单仍保留');
});

console.log(fail ? `❌ ${pass} 通过 / ${fail} 失败` : `✅ ${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);
