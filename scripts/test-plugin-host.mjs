// R2.5 插件宿主回归：manifest、生命周期、权限、状态路径、TTS 试点。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginHost, validatePluginManifest } from '../src/plugins/host.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-plugin-host-'));

function writePlugin(dir, id, { manifest = {}, code = '' } = {}) {
  const pluginDir = path.join(dir, id);
  fs.mkdirSync(pluginDir, { recursive: true });
  const base = {
    id,
    name: id,
    version: '1.0.0',
    engines: { qqBridge: '>=0.4.0' },
    enabledByDefault: false,
    configSchema: 'config.schema.js',
    permissions: []
  };
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({ ...base, ...manifest }, null, 2));
  fs.writeFileSync(path.join(pluginDir, 'config.schema.js'), 'export default {};\n');
  fs.writeFileSync(path.join(pluginDir, 'index.js'), code || 'export function create() { return {}; }\n');
  return pluginDir;
}

try {
  console.log('── 1. manifest 校验 ──');
  {
    check('合法 manifest 通过', validatePluginManifest({
      id: 'demo', version: '1.0.0', configSchema: 'config.schema.js', permissions: []
    }, { currentVersion: '0.4.0' }).ok);
    const bad = validatePluginManifest({
      id: 'Bad ID', version: '', configSchema: '', permissions: ['root']
    }, { currentVersion: '0.4.0' });
    check('非法 id/版本/权限被拒绝', !bad.ok && bad.errors.length >= 4, bad.errors.join('；'));
    check('版本范围不满足被拒绝', !validatePluginManifest({
      id: 'demo2', version: '1.0.0', configSchema: 'x.js', permissions: [], engines: { qqBridge: '>=9.0.0' }
    }, { currentVersion: '0.4.0' }).ok);
  }

  console.log('\n── 2. 生命周期 ──');
  {
    const dir = path.join(tmp, 'lifecycle');
    writePlugin(dir, 'demo', {
      code: `
        export function create(ctx) {
          return {
            started: false,
            stopped: false,
            async start() { this.started = true; ctx.log('started'); },
            async stop() { this.stopped = true; }
          };
        }
      `
    });
    const host = createPluginHost({ root: rootDir, dirs: [dir], log: () => {} });
    await host.load();
    await host.start();
    const plugin = host.get('demo');
    check('load + start 调用插件', plugin?.started === true);
    check('list 反映 started 状态', host.list().find((p) => p.id === 'demo')?.status === 'started');
    await host.stop();
    check('stop 调用插件清理并更新状态', plugin?.stopped === true
      && host.list().find((p) => p.id === 'demo')?.status === 'stopped');
  }

  console.log('\n── 3. 权限与状态路径 ──');
  {
    const dir = path.join(tmp, 'permissions');
    writePlugin(dir, 'denied', {
      manifest: { permissions: ['state'] },
      code: `
        export function create(ctx) {
          return {
            callSend() { return ctx.send.voiceFile('group:1', 'x'); },
            stateFile(name) { return ctx.state.file(name); }
          };
        }
      `
    });
    const host = createPluginHost({
      root: rootDir,
      dirs: [dir],
      log: () => {},
      services: { send: { voiceFile: () => 'sent' } }
    });
    await host.load();
    const plugin = host.get('denied');
    let threw = false;
    try { plugin.callSend(); } catch { threw = true; }
    check('未声明 send 权限时发送被拒绝', threw);
    let traversal = false;
    try { plugin.stateFile('../escape.json'); } catch { traversal = true; }
    check('状态路径越界被拒绝', traversal);
    check('合法状态文件在插件目录内', plugin.stateFile('state.json').includes(path.join('state', 'plugins', 'denied')));
  }

  console.log('\n── 4. TTS 试点 ──');
  {
    const host = createPluginHost({
      root: rootDir,
      dirs: [path.join(rootDir, 'plugins')],
      getConfig: () => ({ socialV2: { tts: { enabled: false } } }),
      log: () => {}
    });
    await host.load({ only: ['tts'] });
    await host.start();
    const tts = host.get('tts');
    check('TTS 插件已加载', !!tts);
    check('关闭时不创建引擎', tts?.available() === false && !tts?.engine);
    check('关闭时不产生语音计划', tts?.plan('group:1', ['你好']) === null);
    check('韵律参数可读', tts?.speechParams()?.speed === 1.0);
    await host.stop();
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
