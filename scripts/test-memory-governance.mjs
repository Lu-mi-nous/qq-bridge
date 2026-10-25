// Phase 3 P0-2：长期记忆治理（别名合并/事实冲突/线索过期）测试。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mergeEpisodeToMemory,
  loadLongTermMemory,
  longTermStats,
  formatMemoryPack
} from '../src/context-memory.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-memgov-'));
const key = 'group:123456789';
const now = Date.now();
let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' ' + extra : ''}`); }
}
try {
  console.log('── 人物别名合并 ──');
  mergeEpisodeToMemory(dir, key, {
    summary: '甲出现',
    people: [{ name: '甲', note: '喜欢原神' }],
    facts: [], threads: []
  }, { now: now - 10 * 86400000 });
  mergeEpisodeToMemory(dir, key, {
    summary: '甲带 QQ 号出现',
    people: [{ id: '10001', name: '甲', note: '最近在玩星铁' }],
    facts: [], threads: []
  }, { now });
  let mem = loadLongTermMemory(dir, key);
  check('同名人物只保留一张卡', Object.keys(mem.people).length === 1);
  const person = Object.values(mem.people)[0];
  check('别名合并后保留 QQ 号和最新备注', person.id === '10001' && /星铁/.test(person.note));

  console.log('── 单值事实冲突 ──');
  mergeEpisodeToMemory(dir, key, {
    summary: '身份 A',
    people: [], threads: [],
    facts: [{ subject: '甲', predicate: '是', object: '原神玩家', confidence: 0.9 }]
  }, { now: now - 86400000 });
  mergeEpisodeToMemory(dir, key, {
    summary: '身份 B',
    people: [], threads: [],
    facts: [{ subject: '甲', predicate: '是', object: '星铁玩家', confidence: 0.95 }]
  }, { now });
  mem = loadLongTermMemory(dir, key);
  const facts = Object.values(mem.facts);
  check('单值事实出现新值后旧值标 superseded', facts.some((f) => f.object === '原神玩家' && f.status === 'superseded'));
  check('新单值事实保持 active', facts.some((f) => f.object === '星铁玩家' && f.status === 'active'));

  console.log('── 多值事实不被误杀 ──');
  mergeEpisodeToMemory(dir, key, {
    summary: '喜好',
    people: [], threads: [],
    facts: [
      { subject: '乙', predicate: '喜欢', object: '原神', confidence: 0.9 },
      { subject: '乙', predicate: '喜欢', object: '星铁', confidence: 0.9 }
    ]
  }, { now });
  mem = loadLongTermMemory(dir, key);
  check('喜欢类多值事实保留两条', Object.values(mem.facts).filter((f) => f.subject === '乙' && f.predicate === '喜欢').length === 2);

  console.log('── 线索过期 ──');
  mergeEpisodeToMemory(dir, key, {
    summary: '旧线索',
    people: [], facts: [],
    threads: [{ title: '旧约定', status: 'open', nextAction: '等回复' }]
  }, { now: now - 40 * 86400000 });
  mergeEpisodeToMemory(dir, key, {
    summary: '新活动',
    people: [], facts: [], threads: []
  }, { now });
  mem = loadLongTermMemory(dir, key);
  const thread = Object.values(mem.threads).find((t) => t.title === '旧约定');
  check('30 天未出现的线索变 stale', thread?.status === 'stale');
  const stats = longTermStats(dir, key);
  check('长期统计只把 open 算作未结线索', stats.openThreads === 0);
  const pack = formatMemoryPack({ episodes: [], compactions: [], longTerm: mem, budgetChars: 1500 });
  check('记忆包不展示 stale 线索', !pack.includes('旧约定'));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
