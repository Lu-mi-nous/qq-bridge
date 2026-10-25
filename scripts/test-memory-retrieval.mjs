// Phase 3 P0：记忆检索纯逻辑测试。
import {
  tokenizeMemoryText,
  buildMemoryIndex,
  searchMemory,
  formatRecallResults
} from '../src/memory-retrieval.js';

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
}

const messages = [
  { seq: 1, messageId: 'm1', sender: '甲', time: Date.now() - 3 * 86400000, text: '我上周拔牙后一直低烧，要不要去医院' },
  { seq: 2, messageId: 'm2', sender: '乙', time: Date.now() - 2 * 86400000, text: '低烧超过三天最好去看一下，小心感染' },
  { seq: 3, messageId: 'm3', sender: '甲', time: Date.now() - 86400000, text: '我最近在玩原神，喜欢用那维莱特' },
  { seq: 4, messageId: 'm4', sender: '丙', time: Date.now() - 3600000, text: '今晚有人打本吗，缺一个辅助' }
];
const episodes = [
  { fromSeq: 1, toSeq: 2, createdAt: Date.now() - 86400000, summary: '甲拔牙后低烧，乙建议就医并提醒感染风险。' },
  { fromSeq: 3, toSeq: 3, createdAt: Date.now() - 43200000, summary: '甲提到最近在玩原神，喜欢那维莱特。' }
];

console.log('── 分词 ──');
check('中文分词包含关键词', tokenizeMemoryText('拔牙后低烧').includes('低烧') || tokenizeMemoryText('拔牙后低烧').includes('拔牙'));
check('英文/数字可检索', tokenizeMemoryText('原神 4.2 版本').some((t) => /原神|4\.2/.test(t)));
check('空文本返回空数组', tokenizeMemoryText('   ').length === 0);

const index = buildMemoryIndex({ messages, episodes });
console.log('── 检索 ──');
const lowFever = searchMemory(index, '拔牙 低烧', { limit: 5 });
check('能召回低烧相关消息', lowFever.some((r) => r.text.includes('低烧')));
check('能召回对应 episode', lowFever.some((r) => r.kind === 'episode' && r.text.includes('低烧')));
const genshin = searchMemory(index, '原神 那维莱特', { limit: 5 });
check('能召回原神相关消息/episode', genshin.some((r) => r.text.includes('原神')));
check('结果带时间和 seq 证据', genshin.every((r) => r.time > 0 && (r.seq > 0 || r.kind === 'episode')));
const recent = searchMemory(index, '', { limit: 2 });
check('空查询按时间返回最近消息', recent.length === 2 && recent[0].seq === 4);
const excluded = searchMemory(index, '原神', { limit: 5, excludeSeqs: [3] });
check('excludeSeqs 能排除当前消息', !excluded.some((r) => r.kind === 'message' && r.seq === 3));
const fromFilter = searchMemory(index, '低烧', { limit: 5, from: Date.now() - 2.5 * 86400000 });
check('时间范围过滤生效', fromFilter.every((r) => r.time >= Date.now() - 2.5 * 86400000));
check('无命中返回空数组', searchMemory(index, '完全不存在的词xyz', { limit: 5 }).length === 0);

const formatted = formatRecallResults(lowFever, { budgetChars: 600 });
check('格式化结果带“相关记忆”标题', formatted.startsWith('【相关记忆'));
check('格式化结果带发送者/时间/seq', formatted.includes('甲') && formatted.includes('seq=1'));
check('预算截断生效', formatRecallResults(lowFever, { budgetChars: 100 }).length <= 120);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
