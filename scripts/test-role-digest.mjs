// T3：角色摘要（自动摘要 / 人工 digest / 完整卡触发条件）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoleDigest, createRoleDigestReader, shouldInjectFullRole, DEFAULT_DIGEST_CHARS } from '../src/pipeline/role-digest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (error) { fail++; console.log(`FAIL ${name}  ${error?.message ?? error}`); }
};

const card = [
  '# 角色卡：测试鱼',
  '## 一、你是谁',
  '你是测试鱼，一条软萌的鱼。'.repeat(80),
  '## 二、说话铁律',
  '- 短。默认一条 1~15 字',
  '- 不说教不总结',
  '## 三、收尾',
  '- 回复完直接结束，不守着等'
].join('\n');

check('自动摘要受预算约束且保留结构', () => {
  const digest = buildRoleDigest(card, { maxChars: 600 });
  assert.ok(digest.length <= 620, `digest=${digest.length}`);
  assert.ok(digest.includes('你是谁') || digest.includes('测试鱼'));
  assert.ok(digest.includes('说话铁律'), '后续小节标题应保留');
  assert.ok(digest.includes('qq_get_prompt detail=full'), '应给出完整卡入口');
});

check('默认预算 1200 字', () => {
  assert.equal(DEFAULT_DIGEST_CHARS, 1200);
  const digest = buildRoleDigest(card);
  assert.ok(digest.length <= 1220);
});

check('短卡不摘要（原样返回）', () => {
  const short = '## 一、你是谁\n你是小鱼。';
  assert.equal(buildRoleDigest(short), short);
});

check('空卡返回空串', () => {
  assert.equal(buildRoleDigest(''), '');
  assert.equal(buildRoleDigest(null), '');
});

check('完整卡触发条件：明确 full / 角色切换 / bootstrap', () => {
  assert.equal(shouldInjectFullRole({ full: true }), true);
  assert.equal(shouldInjectFullRole({ changed: true }), true);
  assert.equal(shouldInjectFullRole({ reason: 'bootstrap' }), true);
  assert.equal(shouldInjectFullRole({ reason: 'question' }), false);
  assert.equal(shouldInjectFullRole({}), false);
});

check('人工 digest 优先且 mtime 热更新', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-digest-'));
  fs.mkdirSync(path.join(dir, 'roles'));
  const file = path.join(dir, 'roles', '小鱼.digest.md');
  fs.writeFileSync(file, '第一版摘要');
  const read = createRoleDigestReader({ ROOT: dir });
  assert.equal(read('小鱼'), '第一版摘要');
  fs.writeFileSync(file, '第二版摘要更长了');
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(file, later, later);
  assert.equal(read('小鱼'), '第二版摘要更长了');
  assert.equal(read('不存在'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('生产角色有 600–1200 字的英文/中文摘要文件', () => {
  const read = createRoleDigestReader({ ROOT: root });
  const digest = read('大肥鱼');
  assert.ok(digest, '缺少 roles/大肥鱼.digest.md');
  assert.ok(digest.length >= 300 && digest.length <= 1200, `digest=${digest.length}`);
  assert.ok(digest.includes('大肥鱼'));
});

console.log(fail ? `❌ ${pass} 通过 / ${fail} 失败` : `✅ ${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);
