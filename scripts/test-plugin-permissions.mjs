import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPluginContext } from '../src/plugins/context.js';
import { createPluginHost, validatePluginManifest } from '../src/plugins/host.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-permissions-'));
let sends = 0, social = 0, host;
function context(permissions, secrets = ['auth.json']) {
  return createPluginContext({ root: tmp, manifest: { id: 'demo', permissions, secrets },
    services: { send: { text() { sends++; return 'sent'; } }, social: { save() { social++; return 'saved'; } } } });
}
try {
  const denied = context([]), allowed = context(['state', 'send', 'secrets', 'console:route']);
  await check('无 state 权限不能取得文件或 store，且不创建文件', () => {
    assert.throws(() => denied.state.file(), /未声明权限：state/);
    assert.throws(() => denied.state.store(), /未声明权限：state/);
    assert.equal(fs.existsSync(path.join(tmp, 'state')), false);
  });
  await check('有 state 权限可以往返持久化', () => {
    const store = allowed.state.store('data.json', { defaults: () => ({ n: 0 }) });
    store.update(d => { d.n++; }); store.clearCache();
    assert.equal(store.read().n, 1);
    assert.equal(store.file, path.join(tmp, 'state/plugins/demo/data.json'));
  });
  for (const name of ['.', '..', '../outside.json', '..\\outside.json', 'C:\\outside.json', 'data.json:secret', '/outside.json']) {
    await check(`状态文件拒绝 ${name}`, () => assert.throws(() => allowed.state.file(name), /不合法/));
  }
  await check('发送权限在调用服务之前检查', () => {
    assert.throws(() => denied.send.text('hello'), /未声明权限：send/); assert.equal(sends, 0);
    assert.equal(allowed.send.text('hello'), 'sent'); assert.equal(sends, 1);
  });
  await check('社交状态权限在调用服务之前检查', () => {
    assert.throws(() => denied.social.save(), /未声明权限：state/); assert.equal(social, 0);
    assert.equal(allowed.social.save(), 'saved'); assert.equal(social, 1);
  });
  await check('凭据权限与文件白名单同时生效', () => {
    assert.throws(() => denied.secrets.readJson('auth.json'), /未声明权限：secrets/);
    assert.throws(() => denied.secrets.writeJson('auth.json', {}), /未声明权限：secrets/);
    assert.throws(() => allowed.secrets.writeJson('other.json', {}), /未声明凭据文件/);
    allowed.secrets.writeJson('auth.json', { token: 'fixture' });
    assert.equal(allowed.secrets.readJson('auth.json').token, 'fixture');
    assert.equal(fs.existsSync(path.join(tmp, 'state/other.json')), false);
  });
  await check('直接构造上下文也不能通过凭据白名单越界', () => {
    for (const name of ['..', '../outside.json', 'auth.json:stream']) {
      const ctx = context(['secrets'], [name]);
      assert.throws(() => ctx.secrets.readJson(name), /不合法/);
      assert.throws(() => ctx.secrets.writeJson(name, {}), /不合法/);
      assert.equal(validatePluginManifest({ id: 'demo', version: '1', permissions: ['secrets'], secrets: [name] }).ok, false);
    }
  });
  await check('无控制台权限时不注册路由和配置', () => {
    assert.throws(() => denied.console.registerRoute('/api/plugins/demo/test', () => {}), /未声明权限：console:route/);
    assert.throws(() => denied.console.registerConfigItems([]), /未声明权限：console:route/);
    assert.equal(denied.console.routes.length, 0); assert.equal(denied.console.configItems.length, 0);
  });
  await check('控制台授权仍限制命名空间和凭据种类', () => {
    assert.throws(() => allowed.console.registerRoute('/api/plugins/other/test', () => {}), /必须挂在/);
    allowed.console.registerRoute('/api/plugins/demo/test', () => {});
    const item = { key: 'token', label: 'Token', kind: 'secret', get: () => '', set: () => {} };
    assert.throws(() => context(['console:route']).console.registerConfigItems([item]), /未声明权限：secrets/);
    assert.equal(allowed.console.registerConfigItems([item]).length, 1);
  });
  await check('宿主清单区分实际检查与审计声明', async () => {
    const dir = path.join(tmp, 'plugins/demo'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'demo', version: '1', permissions: ['state', 'send', 'secrets', 'console:route', 'network', 'process', 'prompt', 'mcp:register'] }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'export function create() { return {}; }');
    host = createPluginHost({ root: tmp, dirs: [path.dirname(dir)] }); await host.start();
    assert.deepEqual(host.list()[0].permissionModes, { state: 'runtime-gate', send: 'runtime-gate', secrets: 'runtime-gate', 'console:route': 'runtime-gate', network: 'audit-only', process: 'audit-only', prompt: 'audit-only', 'mcp:register': 'runtime-gate' });
  });
  console.log(`✅ ${passed} 通过 / 0 失败`);
} finally {
  await host?.stop();
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true });
}
