// R3-9 图片请求服务：来源过滤、预检、冷却、标注。
import { createImageRequestService } from '../src/image-request.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

function makeService(overrides = {}) {
  const cfg = {
    socialV2: {
      images: {
        enabled: true,
        sendCooldownMs: 10000,
        maxSendPerHour: 2,
        sources: { pixiv: { enabled: true }, safebooru: { enabled: false } },
        ...(overrides.images || {})
      }
    }
  };
  let count = 2;
  const imageStore = {
    pickRandom: () => ({ count })
  };
  const service = createImageRequestService({
    cfg,
    imageStore,
    log: () => {},
    now: () => 1_700_000_000_000,
    ...overrides
  });
  return { service, cfg, setCount: (n) => { count = n; } };
}

console.log('── 1. 来源过滤 ──');
{
  const { service } = makeService();
  const none = service.normalizeSourceFilter('');
  check('未指定来源', none.requested === false && none.valid.length === 0);
  const one = service.normalizeSourceFilter('pixiv');
  check('指定可用来源', one.requested === true && one.valid.includes('pixiv'));
  const bad = service.normalizeSourceFilter(['pixiv', 'nope']);
  check('不可用来源单独列出', bad.unavailable.includes('nope'));
  const pick = service.sourceFilterForPick({ requested: true, valid: [] });
  check('指定但全不可用 → 强制空结果', pick.sources[0] === '__unavailable__');
  const hinted = service.sourcesWithHint('group:1', '');
  check('无显式来源时返回不限源', hinted.requested === false);
}

console.log('\n── 2. 预检 / 冷却 ──');
{
  const { service, setCount } = makeService();
  const hit = service.preflight(['hero'], '', 'group:1');
  check('本地命中时不等待', hit.hit === true && hit.willWait === false);
  setCount(0);
  const miss = service.preflight(['hero'], '', 'group:1');
  check('本地无图时需要等待', miss.hit === false && miss.willWait === true);

  const first = service.sendAllowed('group:1');
  check('首次发图允许', first.ok === true);
  service.imageSendTimes.set('group:1', [1_700_000_000_000]);
  const cooled = service.sendAllowed('group:1');
  check('冷却内拒绝', cooled.ok === false && /发图太快/.test(cooled.error));
  const feedback = service.sendAllowed('group:1', { fromFeedback: true });
  check('差评换图跳过冷却', feedback.ok === true);
}

console.log('\n── 3. 标注 ──');
{
  const { service } = makeService();
  const text = service.annotation({ artist: 'A', page: 'https://x/a', source: 'pixiv', sourcePage: 'https://pixiv/1' });
  check('包含画师与出处', /画师 A/.test(text) && /pixiv/.test(text));
  check('关闭标注时返回空串', makeService({ images: { annotateSource: false } }).service.annotation({ artist: 'A' }) === '');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
