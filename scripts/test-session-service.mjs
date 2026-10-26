// R3-1 会话服务：映射、代际、并发创建与模式变化。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionService } from '../src/session-service.js';
import { needsNewSession } from '../src/pipeline/session-generation.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-session-service-'));
fs.mkdirSync(tmp, { recursive: true });

function makeService(overrides = {}) {
  const state = { sessions: {}, sessionMeta: {} };
  const reverse = new Map();
  const sessionPromises = new Map();
  const history = [];
  let epoch = 0;
  let mode = 'reserved2';
  const presets = { 'group:1': 'qq-chat-v2' };
  let seq = 0;
  const archives = [];
  const vision = [];
  const retired = [];
  const creates = [];
  const service = createSessionService({
    state,
    reverse,
    sessionPromises,
    getEpoch: () => epoch,
    getMode: () => mode,
    getPreset: (key) => presets[key] || '',
    getSessionDir: () => path.join(tmp, 'agents'),
    needsNewSession,
    createDshSession: overrides.createDshSession || (async ({ key }) => {
      creates.push(key);
      if (overrides.createError) throw new Error('create failed');
      seq += 1;
      return `session-${seq}`;
    }),
    archiveSession: async (sessionId) => { archives.push(sessionId); },
    ensureVisionModel: async (sessionId) => { vision.push(sessionId); },
    retireForModeChange: async (key, oldId, oldMeta, desired) => {
      retired.push({ key, oldId, oldMeta, desired });
      delete state.sessions[key];
      delete state.sessionMeta[key];
      reverse.delete(oldId);
      sessionPromises.delete(key);
    },
    sessionHistory: { record: (sessionId, key, reason) => history.push({ sessionId, key, reason }) },
    saveState: () => {},
    log: () => {},
    now: () => 1000
  });
  return {
    service, state, reverse, sessionPromises, history, archives, vision, retired, creates,
    setMode: (m) => { mode = m; },
    bumpEpoch: () => { epoch += 1; },
    getEpoch: () => epoch
  };
}

try {
  console.log('── 1. 新建 / 复用 ──');
  {
    const t = makeService();
    const id = await t.service.ensureSession('group:1');
    check('新会话返回 sessionId', id === 'session-1');
    check('写入 sessions 映射', t.state.sessions['group:1'] === id);
    check('写入 sessionMeta', t.state.sessionMeta['group:1']?.mode === 'reserved2'
      && t.state.sessionMeta['group:1']?.preset === 'qq-chat-v2');
    check('写入 reverse', t.reverse.get(id) === 'group:1');
    check('记录 create 历史', t.history.some((x) => x.sessionId === id && x.reason === 'create'));
    check('调用视觉模型设置', t.vision.includes(id));
    const again = await t.service.ensureSession('group:1');
    check('已有映射直接复用', again === id && t.creates.length === 1);
  }

  console.log('\n── 2. 缺 meta / 模式变化 ──');
  {
    const t = makeService();
    t.state.sessions['group:1'] = 'old-1';
    t.reverse.set('old-1', 'group:1');
    const id = await t.service.ensureSession('group:1');
    check('缺 meta 时按当前模式接管', id === 'old-1'
      && t.state.sessionMeta['group:1']?.mode === 'reserved2');
    t.setMode('chat');
    const id2 = await t.service.ensureSession('group:1');
    check('模式变化触发 retire', t.retired.length === 1 && t.retired[0].oldId === 'old-1');
    check('模式变化后创建新会话', id2 !== 'old-1' && t.state.sessions['group:1'] === id2);
  }

  console.log('\n── 3. 代际 / 并发 ──');
  {
    let t;
    t = makeService({
      createDshSession: async () => {
        t.bumpEpoch(); // 模拟创建期间发生 reset
        return 'session-stale';
      }
    });
    let rejected = false;
    try { await t.service.ensureSession('group:1'); } catch { rejected = true; }
    check('创建期间 reset 会丢弃新会话', rejected && !t.state.sessions['group:1']);
    check('被丢弃的新会话会归档', t.archives.includes('session-stale'));

    const t2 = makeService({});
    const a = t2.service.ensureSession('group:2');
    const b = t2.service.ensureSession('group:2');
    const [ida, idb] = await Promise.all([a, b]);
    check('并发 ensure 只创建一次', ida === idb && t2.creates.length === 1);
  }

  console.log('\n── 4. 失败 / 解除映射 ──');
  {
    const t = makeService({ createError: true });
    let rejected = false;
    try { await t.service.ensureSession('group:1'); } catch { rejected = true; }
    check('创建失败向上抛且不写映射', rejected && !t.state.sessions['group:1']);

    const t2 = makeService();
    const id = await t2.service.ensureSession('group:1');
    const old = t2.service.detachMapping('group:1', 'reset');
    check('detach 返回旧 id', old === id);
    check('detach 删除映射/meta/reverse', !t2.state.sessions['group:1']
      && !t2.state.sessionMeta['group:1'] && !t2.reverse.has(id));
    check('detach 记录 reset 历史', t2.history.some((x) => x.sessionId === id && x.reason === 'reset'));
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
