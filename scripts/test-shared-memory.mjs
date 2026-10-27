// 回归测试：跨会话人物记忆（src/shared-memory.js）。
//
// 锁住 2026-10-25 的设计决策：
//   ① 只共享「身份 + 安全偏好」，不共享聊天原文/episode/群名
//   ② 模型给的 people[].id 不可信，只接受纯数字 QQ 号，否则按 sender→userId 反查
//   ③ 私聊只处理对方本人，不共享第三人
//   ④ 默认开启，关闭时注入空串；最大 3 人 × 3 条 / 300 字
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeSharedMemoryConfig,
  resolveEpisodePeople,
  resolveFactSubject,
  mergeEpisodeToSharedMemory,
  selectSharedForPrompt,
  formatSharedMemory,
  formatSharedMemoryForWake,
  sharedMemoryStats,
  listSharedPeople,
  forgetSharedPerson,
  clearSharedMemory,
  loadSharedMemory,
  sharedMemoryFile
} from '../plugins/shared-memory/lib/shared-memory.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharedmem-'));
const stateDir = path.join(tmp, 'state');
const KEY = 'group:1001';
const OTHER = 'group:2002';
const PEER = 'private:30033';
const NOW = 1_792_915_000_000;

const localPerson = (id, name) => ({ id, name, note: '', mentions: 1, firstSeenAt: NOW, lastSeenAt: NOW });
const localFact = (subject, predicate, object, hits = 2, confidence = 0.9) => ({
  subject, predicate, object, confidence, hits, status: 'active', firstSeenAt: NOW, lastSeenAt: NOW
});

console.log('── 1. 配置归一化 ──');
{
  const c = normalizeSharedMemoryConfig({});
  check('默认开启', c.enabled === true && c.shareProfiles === true && c.includePrivate === true,
    JSON.stringify(c));
  check('默认预算 300 字 / 3 人 / 3 条',
    c.maxPromptChars === 300 && c.maxPromptPeople === 3 && c.maxPromptTraits === 3);
  const c2 = normalizeSharedMemoryConfig({
    enabled: false, maxPromptChars: 9999, maxPeople: -1, excludeKeys: ['group:1', 'bad', 'private:2']
  });
  check('字符串/越界值被归一化', c2.enabled === false && c2.maxPromptChars === 1000
    && c2.maxPeople === 1 && c2.excludeKeys.length === 2, JSON.stringify(c2));
}

console.log('\n── 2. 身份解析（模型 id 不可信）──');
{
  const episode = { people: [{ id: '𝐘𝐀𝐍𝐆', name: '杨' }, { id: '10001', name: '清宵' }] };
  const messages = [
    { sender: '杨', userId: '20002', isSelf: false },
    { sender: '清宵', userId: '10001', isSelf: false }
  ];
  const got = resolveEpisodePeople(episode, messages, { people: {} });
  check('数字 id 直接使用', got.some((p) => p.id === '10001'));
  check('名字 id 通过 sender→userId 反查', got.some((p) => p.id === '20002' && p.name === '杨'),
    JSON.stringify(got));
  const ambiguous = resolveEpisodePeople(
    { people: [{ id: '杨', name: '杨' }] },
    [{ sender: '杨', userId: '20002' }, { sender: '杨', userId: '20003' }],
    { people: {} }
  );
  check('同名多 QQ 号时跳过（不瞎挂）', ambiguous.length === 0, JSON.stringify(ambiguous));
  const byLocal = resolveEpisodePeople(
    { people: [{ id: '小清', name: '小清' }] },
    [],
    { people: { '10001': localPerson('10001', '小清') } }
  );
  check('本地长期记忆可补身份', byLocal[0]?.id === '10001', JSON.stringify(byLocal));
  check('fact.subject 按名字解析到 QQ',
    resolveFactSubject('杨', got, messages, { people: {} }) === '20002');
}

console.log('\n── 3. 偏好写入：白名单 / hits / 敏感过滤 ──');
{
  const localMemory = {
    people: { '10001': localPerson('10001', '清宵') },
    facts: {
      a: localFact('清宵', '喜欢', '原神'),
      b: localFact('清宵', '住在', '某个地址'),
      c: localFact('清宵', '喜欢', '13800138000'),
      d: localFact('清宵', '喜欢', 'https://example.com'),
      e: localFact('清宵', '喜欢', '这个群里的梗'),
      f: localFact('清宵', '喜欢', '星铁', 1)
    }
  };
  const episode = {
    summary: '这是不该被共享的 episode 摘要',
    people: [{ id: '10001', name: '清宵', note: '不该共享的 note' }],
    facts: [
      { subject: '清宵', predicate: '喜欢', object: '原神', confidence: 0.95 },
      { subject: '清宵', predicate: '住在', object: '某个地址', confidence: 1 },
      { subject: '清宵', predicate: '喜欢', object: '13800138000', confidence: 1 },
      { subject: '清宵', predicate: '喜欢', object: 'https://example.com', confidence: 1 },
      { subject: '清宵', predicate: '喜欢', object: '这个群里的梗', confidence: 1 },
      { subject: '清宵', predicate: '喜欢', object: '星铁', confidence: 1 }
    ],
    threads: [{ title: '不该共享的线索' }]
  };
  const r = mergeEpisodeToSharedMemory(stateDir, {
    key: KEY, episode, messages: [], localMemory, cfg: {}, now: NOW
  });
  check('写入成功', r.changed === true, JSON.stringify(r));
  const mem = loadSharedMemory(stateDir);
  const p = mem.people['10001'];
  check('只有白名单且 hits>=2 的偏好进入共享层',
    Object.values(p.traits).length === 1 && p.traits['喜欢|原神']?.object === '原神',
    JSON.stringify(p.traits));
  const raw = fs.readFileSync(sharedMemoryFile(stateDir), 'utf8');
  check('文件不含 episode 摘要/note/线索/群名',
    !raw.includes('不该被共享') && !raw.includes('某个地址') && !raw.includes('example.com')
    && !raw.includes('13800138000') && !raw.includes('群里的梗'));
  check('记录来源 key 便于审计', p.traits['喜欢|原神'].sources.includes(KEY));
}

console.log('\n── 4. 私聊只处理对方本人 ──');
{
  const localMemory = {
    people: { '30033': localPerson('30033', '对方'), '40044': localPerson('40044', '第三人') },
    facts: {
      a: localFact('对方', '喜欢', '猫咪'),
      b: localFact('第三人', '喜欢', '狗')
    }
  };
  const episode = {
    people: [{ id: '30033', name: '对方' }, { id: '40044', name: '第三人' }],
    facts: [
      { subject: '对方', predicate: '喜欢', object: '猫咪', confidence: 0.95 },
      { subject: '第三人', predicate: '喜欢', object: '狗', confidence: 0.95 }
    ]
  };
  const r = mergeEpisodeToSharedMemory(stateDir, { key: PEER, episode, messages: [], localMemory, now: NOW });
  const mem = loadSharedMemory(stateDir);
  check('私聊只写对方本人', mem.people['30033'] && !mem.people['40044'],
    JSON.stringify(Object.keys(mem.people)));
  check('第三人偏好不好写入', !Object.values(mem.people['30033'].traits).some((t) => t.object === '狗'));
  const disabled = mergeEpisodeToSharedMemory(stateDir, {
    key: PEER, episode, messages: [], localMemory,
    cfg: { includePrivate: false }, now: NOW
  });
  check('includePrivate=false 时私聊不写', disabled.reason === 'private-disabled');
}

console.log('\n── 5. 注入：只在本人当前在场时 ──');
{
  const localForKey = { people: { '10001': localPerson('10001', '清宵') }, facts: {} };
  const groupEntries = selectSharedForPrompt(stateDir, {
    key: KEY, localMemory: localForKey, userIds: [], cfg: {}, now: NOW
  });
  check('本群有此人 → 命中', groupEntries.length === 1 && groupEntries[0].id === '10001',
    JSON.stringify(groupEntries));
  const otherEntries = selectSharedForPrompt(stateDir, {
    key: OTHER, localMemory: { people: { '99999': localPerson('99999', '别人') } }, userIds: [], cfg: {}, now: NOW
  });
  check('别的群没有此人 → 不注入', otherEntries.length === 0, JSON.stringify(otherEntries));
  const samePersonOtherGroup = selectSharedForPrompt(stateDir, {
    key: OTHER,
    localMemory: { people: { '10001': localPerson('10001', '另一个群的称呼') } },
    userIds: [],
    cfg: {},
    now: NOW
  });
  check('同一 QQ 号出现在第二个群 → 复用偏好且用本群昵称',
    samePersonOtherGroup.length === 1 && samePersonOtherGroup[0].name === '另一个群的称呼'
    && samePersonOtherGroup[0].traits[0].object === '原神',
    JSON.stringify(samePersonOtherGroup));
  const privateEntries = selectSharedForPrompt(stateDir, {
    key: PEER, localMemory: null, userIds: [], cfg: {}, now: NOW
  });
  check('私聊只注入对方本人', privateEntries.length === 1 && privateEntries[0].id === '30033',
    JSON.stringify(privateEntries));
  const privateOther = selectSharedForPrompt(stateDir, {
    key: 'private:99998', localMemory: null, userIds: [], cfg: {}, now: NOW
  });
  check('私聊不会注入其他人', privateOther.length === 0, JSON.stringify(privateOther));
  const text = formatSharedMemory(groupEntries, {});
  check('格式化含标题、QQ、偏好', text.includes('人物资料') && text.includes('QQ 10001') && text.includes('喜欢 原神'), text);
  check('不泄露来源群号', !text.includes('group:1001') && !text.includes('group:'), text);
  const wakeText = formatSharedMemoryForWake(stateDir, {
    key: KEY, localMemory: localForKey,
    st: { unread: [{ userId: '10001', sender: '清宵' }] }, cfg: {}, now: NOW
  });
  check('唤醒入口能取到同一份资料', wakeText.includes('喜欢 原神'), wakeText);
  const off = formatSharedMemoryForWake(stateDir, {
    key: KEY, localMemory: localForKey, st: {}, cfg: { enabled: false }, now: NOW
  });
  check('关闭时返回空串（行为与现状一致）', off === '');
  const budget = formatSharedMemory(groupEntries, { maxPromptChars: 20 });
  check('预算上限生效（不超 maxPromptChars）', budget.length <= 50, budget);
}

console.log('\n── 6. 列表/忘记/清空/统计 ──');
{
  const stats = sharedMemoryStats(stateDir, {});
  check('统计人物与偏好数', stats.people === 2 && stats.traits === 2, JSON.stringify(stats));
  const list = listSharedPeople(stateDir, { q: '清宵' });
  check('按昵称搜索', list.rows.length === 1 && list.rows[0].id === '10001', JSON.stringify(list.rows));
  check('列表不含消息原文字段',
    list.rows.every((p) => !('note' in p) && !('summary' in p) && !('text' in p)));
  check('忘记某人成功', forgetSharedPerson(stateDir, '10001') === true);
  check('忘记后列表消失', listSharedPeople(stateDir, {}).rows.every((p) => p.id !== '10001'));
  check('非法 id 不误删', forgetSharedPerson(stateDir, 'abc') === false);
  clearSharedMemory(stateDir);
  check('清空后为空', sharedMemoryStats(stateDir, {}).people === 0);
}

console.log('\n── 7. TTL / 上限 / 损坏容错 ──');
{
  const old = NOW - 200 * 24 * 60 * 60 * 1000;
  const mem = loadSharedMemory(stateDir);
  mem.people['77777'] = {
    id: '77777', names: { [KEY]: '老用户' },
    traits: {
      '喜欢|老东西': {
        predicate: '喜欢', object: '老东西', confidence: 1, hits: 3,
        status: 'active', firstSeenAt: old, lastSeenAt: old, sources: [KEY]
      }
    },
    manualNote: '', firstSeenAt: old, lastSeenAt: old
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(sharedMemoryFile(stateDir), JSON.stringify(mem, null, 2));
  const oldEntries = selectSharedForPrompt(stateDir, {
    key: KEY, localMemory: { people: { '77777': localPerson('77777', '老用户') } },
    userIds: [], cfg: { ttlDays: 180, identityTtlDays: 365 }, now: NOW
  });
  check('超过 ttl 的偏好不注入', oldEntries.length === 0, JSON.stringify(oldEntries));

  const badDir = path.join(tmp, 'bad');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(sharedMemoryFile(badDir), '{not json');
  check('损坏文件按空启动不抛', loadSharedMemory(badDir).people && Object.keys(loadSharedMemory(badDir).people).length === 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
