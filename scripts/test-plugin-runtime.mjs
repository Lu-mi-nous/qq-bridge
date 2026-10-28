// R3-4 插件运行时：宿主装配、启动/停止、TTS 能力查询。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginRuntime } from '../src/plugin-runtime.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-plugin-runtime-'));
function writePlugin(id) {
  const dir = path.join(tmp, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id,
    name: id,
    version: '1.0.0',
    engines: { qqBridge: '>=0.4.0' },
    enabledByDefault: false,
    configSchema: 'config.schema.js',
    permissions: []
  }));
  fs.writeFileSync(path.join(dir, 'config.schema.js'), 'export default {};');
  fs.writeFileSync(path.join(dir, 'index.js'), `
    export function create() {
      return {
        started: false,
        stopped: false,
        async start() { this.started = true; },
        async stop() { this.stopped = true; }
      };
    }
  `);
  return dir;
}

try {
  console.log('── 1. 运行时启动/停止 ──');
  {
    const dir = writePlugin('demo');
    const runtime = createPluginRuntime({
      root: rootDir,
      dirs: [tmp],
      getConfig: () => ({}),
      log: () => {}
    });
    const list = await runtime.start();
    check('start 返回插件清单', list.some((p) => p.id === 'demo' && p.status === 'started'));
    check('get 可拿到插件实例', runtime.get('demo')?.started === true);
    await runtime.start();
    check('重复 start 幂等', runtime.get('demo')?.started === true);
    const instance = runtime.get('demo');
    await runtime.stop();
    check('stop 调用插件清理并撤销实例', instance?.stopped === true && runtime.get('demo') === null);
  }

  console.log('\n── 2. TTS 能力查询 ──');
  {
    const runtime = createPluginRuntime({
      root: rootDir,
      dirs: [path.join(rootDir, 'plugins')],
      only: ['tts'],
      getConfig: () => ({ socialV2: { tts: { enabled: false } } }),
      log: () => {}
    });
    await runtime.start();
    const tts = runtime.tts();
    check('tts() 返回插件实例', !!tts);
    check('关闭时 ttsEngine 为 null', runtime.ttsEngine() === null);
    check('关闭时 ttsSpeechParams 仍可读', runtime.ttsSpeechParams()?.speed === 1.0);
    check('host 暴露插件清单', runtime.host.list().some((p) => p.id === 'tts'));
    await runtime.stop();
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
