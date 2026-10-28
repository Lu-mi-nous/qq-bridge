// T3：桥接侧读取 preset 工具档位（决定注入哪些能力提示）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActiveToolProfile } from '../src/pipeline/tool-profile-reader.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (error) { fail++; console.log(`FAIL ${name}  ${error?.message ?? error}`); }
};
const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-profile-reader-'));
const presetDir = path.join(dshHome, '.agent-presets', 'qq-chat-v2');
fs.mkdirSync(presetDir, { recursive: true });
const write = (profile) => fs.writeFileSync(path.join(presetDir, 'tool-profile.json'), JSON.stringify({ profile }));
const lists = { core: ['qq_send_message', 'qq_mark_read'], media: ['qq_send_message', 'qq_mark_read', 'qq_send_sticker', 'qq_send_voice'], bili: ['qq_send_message', 'qq_bili_search'] };
fs.writeFileSync(path.join(presetDir, 'tool-profiles.json'), JSON.stringify(lists));

check('full 档位不限制', () => {
  write('full');
  const p = createActiveToolProfile({ getPreset: () => 'qq-chat-v2', dshHome });
  assert.equal(p.profile(), 'full');
  assert.equal(p.allows('qq_send_sticker'), true);
  assert.equal(p.allows('任意工具'), true);
});

check('core 档位只放行 core 成员', () => {
  write('core');
  const p = createActiveToolProfile({ getPreset: () => 'qq-chat-v2', dshHome });
  assert.equal(p.allows('qq_send_message'), true);
  assert.equal(p.allows('qq_send_sticker'), false);
  assert.equal(p.allows('qq_send_voice'), false);
});

check('media 档位放行表情/语音', () => {
  write('media');
  const p = createActiveToolProfile({ getPreset: () => 'qq-chat-v2', dshHome });
  assert.equal(p.allows('qq_send_sticker'), true);
  assert.equal(p.allows('qq_bili_search'), false);
});

check('mtime 变化后热更新', () => {
  write('core');
  const p = createActiveToolProfile({ getPreset: () => 'qq-chat-v2', dshHome });
  assert.equal(p.allows('qq_send_sticker'), false);
  write('media');
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(path.join(presetDir, 'tool-profile.json'), later, later);
  assert.equal(p.allows('qq_send_sticker'), true);
});

check('未知档位 / 文件缺失 / 无 preset 一律 fail-open', () => {
  write('nope');
  const unknown = createActiveToolProfile({ getPreset: () => 'qq-chat-v2', dshHome });
  assert.equal(unknown.allows('qq_send_sticker'), true);
  fs.rmSync(path.join(presetDir, 'tool-profile.json'));
  const missing = createActiveToolProfile({ getPreset: () => 'qq-chat-v2', dshHome });
  assert.equal(missing.allows('qq_send_sticker'), true);
  const noPreset = createActiveToolProfile({ getPreset: () => '', dshHome });
  assert.equal(noPreset.allows('qq_send_sticker'), true);
});

check('仓库 preset 的档位文件与插件共用同一份', () => {
  const repoPreset = path.resolve('dsh/agent-presets/qq-chat-v2');
  const profiles = JSON.parse(fs.readFileSync(path.join(repoPreset, 'tool-profiles.json'), 'utf8'));
  assert.ok(profiles.core.length >= 8 && profiles.core.length <= 12);
  for (const name of profiles.core) assert.match(name, /^qq_/);
  const chosen = JSON.parse(fs.readFileSync(path.join(repoPreset, 'tool-profile.json'), 'utf8'));
  assert.equal(chosen.profile, 'full');
});

fs.rmSync(dshHome, { recursive: true, force: true });
console.log(fail ? `❌ ${pass} 通过 / ${fail} 失败` : `✅ ${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);
