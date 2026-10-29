// R4.7-1：Console 领域 Facade 回归。
//
// 目标不是“把 266 个键塞进一个 services 大对象”，而是：
//   1. 领域键清单唯一、完整、无重复；
//   2. bridge 只向 createConsoleServer 传 8 个领域对象；
//   3. live/ops 保持对象引用（getter/setter 不能展开复制）；
//   4. 旧测试的平铺 deps 仍能被兼容分组，迁移期不阻塞。
import {
  CONSOLE_DOMAINS,
  CONSOLE_DOMAIN_KEYS,
  assertConsoleDomainKeys,
  createConsoleServices,
  flattenConsoleServices,
  ensureConsoleServices
} from '../src/console/composition.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

console.log('── 领域契约 ──');
check('固定 8 个领域', CONSOLE_DOMAINS.length === 8, CONSOLE_DOMAINS.join(','));
const seen = new Map();
let duplicates = [];
let total = 0;
for (const domain of CONSOLE_DOMAINS) {
  for (const key of CONSOLE_DOMAIN_KEYS[domain] || []) {
    total++;
    if (seen.has(key)) duplicates.push(`${key}:${seen.get(key)}/${domain}`);
    seen.set(key, domain);
  }
}
check('领域键无重复', duplicates.length === 0, duplicates.slice(0, 3).join(','));
check('领域键覆盖 266 项', total === 266, String(total));
check('每个领域都有键', CONSOLE_DOMAINS.every((d) => (CONSOLE_DOMAIN_KEYS[d] || []).length > 0));

console.log('\n── 装配与兼容视图 ──');
const live = { get currentMode() { return 'reserved2'; } };
const ops = { resetTokenFuse: () => true };
const domains = Object.fromEntries(CONSOLE_DOMAINS.map((d) => [d, {}]));
for (const [key, domain] of seen) domains[domain][key] = key === 'live' ? live : key === 'ops' ? ops : `v:${key}`;
const services = createConsoleServices(domains);
check('createConsoleServices 返回同一批领域引用', CONSOLE_DOMAINS.every((d) => services[d] === domains[d]));
const flat = flattenConsoleServices(services);
check('flatten 后键数等于领域键总数（live/ops 不重复计）', Object.keys(flat).length === total);
check('flatten 保留 live/ops 引用', flat.live === live && flat.ops === ops);
check('断言通过完整领域', assertConsoleDomainKeys(services).domains === 8);

const legacyFlat = { cfg: { a: 1 }, live, ops, unknownKey: 1 };
const normalized = ensureConsoleServices(legacyFlat);
check('旧平铺 deps 可兼容分组', normalized.config.cfg.a === 1 && normalized.operations.live === live);
check('未知旧键不污染领域', !Object.values(normalized).some((bag) => 'unknownKey' in bag));

let missingThrew = false;
const incomplete = createConsoleServices(Object.fromEntries(CONSOLE_DOMAINS.map((d) => [d, {}])));
try { assertConsoleDomainKeys(incomplete); } catch { missingThrew = true; }
check('缺键时启动断言抛错（allowMissing=false）', missingThrew);

console.log(fail ? `\n❌ ${pass} 通过 / ${fail} 失败` : `\n✅ ${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);
