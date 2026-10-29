// R4.7-5：DshEventPump 领域接口回归。
//
// 锁定：70 个平铺依赖按 8 个领域归一；旧平铺调用仍兼容。bridge 调用点由
// test-bridge-wiring 做静态检查（它本来就是 bridge 源码读者）。
import {
  DSH_EVENT_DOMAINS,
  DSH_EVENT_DOMAIN_KEYS,
  normalizeDshEventDeps,
  assertDshEventDomains
} from '../src/pipeline/dsh-event-domains.js';
import { createDshEventPump } from '../src/pipeline/dsh-events.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

console.log('── 领域契约 ──');
check('固定 8 个领域', DSH_EVENT_DOMAINS.length === 8, DSH_EVENT_DOMAINS.join(','));
const allKeys = DSH_EVENT_DOMAINS.flatMap((d) => DSH_EVENT_DOMAIN_KEYS[d]);
check('领域键总数 70', allKeys.length === 70, String(allKeys.length));
check('领域键无重复', new Set(allKeys).size === allKeys.length);

const flat = {};
for (const key of allKeys) flat[key] = `v:${key}`;
const grouped = normalizeDshEventDeps(flat);
check('平铺依赖可按领域归一', DSH_EVENT_DOMAINS.every((d) => Object.keys(grouped[d]).length === DSH_EVENT_DOMAIN_KEYS[d].length));
check('归一保留取值', grouped.runtime.api === 'v:api' && grouped.social.deliverPrompt === 'v:deliverPrompt');
check('领域输入原样透传', normalizeDshEventDeps(grouped) === grouped);
check('断言通过领域对象', assertDshEventDomains(grouped).domains === 8);
let extraThrew = false;
try { assertDshEventDomains({ ...grouped, runtime: { ...grouped.runtime, unknownKey: 1 } }); } catch { extraThrew = true; }
check('未登记键启动断言失败', extraThrew);

console.log('\n── pump 兼容 ──');
const emptyDomains = Object.fromEntries(DSH_EVENT_DOMAINS.map((d) => [d, {}]));
const pump = createDshEventPump(emptyDomains);
check('领域对象可直接创建 pump', pump && typeof pump.pumpMux === 'function' && typeof pump.handleEnvelope === 'function' && typeof pump.resetStreamTracking === 'function');
const flatPump = createDshEventPump({ ...flat, log: () => {}, sleep: async () => {} });
check('旧平铺依赖仍可创建 pump（迁移期兼容）', flatPump && typeof flatPump.pumpMux === 'function');

console.log(fail ? `\n❌ ${pass} 通过 / ${fail} 失败` : `\n✅ ${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);
