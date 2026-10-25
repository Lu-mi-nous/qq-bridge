import { createBiliRuntime } from '../src/pipeline/bili-runtime.js';
import { checks } from './helpers/pipeline-harness.mjs';
const { check, finish } = checks();
function harness(overrides = {}) {
  const calls = [], usage = [];
  const info = { bvid: 'BV17x411w7KC', title: '夹具视频', owner: '作者', category: '游戏', duration: 120 };
  const deps = {
    cfg: { socialV2: { bili: { enabled: true, selfBrowsing: { enabled: true, dailyBudgetSec: 600, scanSeconds: 6, likedSeconds: 120, search: { enabled: false } } } } },
    socialV2: { conversations: new Map() },
    live: { biliMem: { todayUsage: () => ({ seconds: 0 }), taste: () => ({}), get: () => null, addUsage: s => usage.push(s) }, biliBrowsing: false, lastBiliBrowseAt: 0, biliAuth: {}, asrEngine: null },
    log: (...a) => calls.push(['log', ...a]), scheduleBiliBrowse: () => calls.push(['schedule']),
    pickBiliSessionKey: opts => opts?.requireActive ? 'group:2' : 'group:1', biliBrowseState: {},
    rememberBiliInfo: (...a) => calls.push(['remember', ...a]), judgeBiliScan: async () => ({ liked: true, interest: 9, notes: '喜欢' }),
    deliverBiliPrompt: async (...a) => calls.push(['deliver', ...a]), maybeShareBiliVideo: async (...a) => { calls.push(['share', ...a]); return { sent: true }; },
    fetchPopularVideos: async () => [info], searchVideos: async () => [], pickCandidate: a => a[0],
    watchVideo: async (_id, opts) => { calls.push(['watch', opts]); return { ok: true, info, hint: '画面', grid: { frames: opts.frames, sheets: [] } }; },
    ...overrides
  };
  return { runtime: createBiliRuntime(deps), deps, calls, usage };
}
{
  const h = harness(); const result = await h.runtime.runBiliBrowse();
  check('喜欢时两段观看', result.ok && result.extended && h.calls.filter(c => c[0] === 'watch').length === 2);
  check('按最终观看秒数记账', h.usage.join() === '120');
  check('落脚和推荐会话分离', h.calls.find(c => c[0] === 'deliver')[1] === 'group:1' && h.calls.find(c => c[0] === 'share')[1] === 'group:2');
  check('结束释放繁忙状态并重新排期', !h.deps.live.biliBrowsing && h.deps.biliBrowseState.phase === '' && h.calls.at(-1)[0] === 'schedule');
  h.deps.cfg.socialV2.bili.selfBrowsing.enabled = false;
  const manual = await h.runtime.runBiliBrowse({ manual: true });
  check('暂停中手动浏览明确返回标记', manual.ok && manual.manualWhilePaused);
}
{
  const h = harness({ judgeBiliScan: async () => ({ liked: false }) });
  const r = await h.runtime.runBiliBrowse();
  check('不喜欢只浅看', r.ok && !r.extended && h.usage.join() === '6');
  check('不喜欢不分享', !h.calls.some(c => c[0] === 'share'));
}
{
  const h = harness({ watchVideo: async () => ({ ok: false, error: 'offline' }) });
  const r = await h.runtime.runBiliBrowse();
  check('观看失败有原因且不记成功额度', !r.ok && r.reason.includes('offline') && h.usage.length === 0);
  check('失败也释放繁忙并排期', !h.deps.live.biliBrowsing && h.calls.at(-1)[0] === 'schedule');
}
{
  const h = harness(); h.deps.live.biliBrowsing = true;
  check('防重入', !(await h.runtime.runBiliBrowse()).ok && !h.calls.some(c => c[0] === 'watch'));
  h.deps.live.biliBrowsing = false; h.deps.cfg.socialV2.bili.enabled = false;
  check('实时关闭功能拒绝运行', !(await h.runtime.runBiliBrowse({ manual: true })).ok);
}
{
  const h = harness({ deliverBiliPrompt: async () => { throw new Error('delivery failure'); } });
  let thrown = false; try { await h.runtime.runBiliBrowse(); } catch { thrown = true; }
  check('投递失败不吞异常且释放繁忙', thrown && !h.deps.live.biliBrowsing && h.calls.at(-1)[0] === 'schedule');
}
finish();
