import { sharingHarness } from './helpers/bili-sharing-harness.mjs';
import { checks } from './helpers/pipeline-harness.mjs';
const { check, finish } = checks();
const info = { bvid: 'BV17x411w7KC', title: '测试标题', owner: '示例作者' }, verdict = { interest: 80 };
for (const [name, change] of [
  ['模式变化', h => h.deps.live.currentMode = 'chat'],
  ['功能关闭', h => h.deps.cfg.socialV2.enabled = false],
  ['暂停', h => h.deps.socialV2.paused = true],
  ['目标退出白名单', h => {}], ['静默', h => {}]
]) {
  const h = sharingHarness(name === '目标退出白名单' ? { isSessionAllowedInCurrentMode: () => false } : name === '静默' ? { shouldBlockSilentReply: () => true } : {});
  change(h); const r = await h.sharing.maybeShareBiliVideo('group:1', info, verdict);
  check(`${name}拦截最终发送`, !r.ok && h.sent.length === 0 && h.deps.live.lastBiliShareAt === 0);
}
{
  const h = sharingHarness(); const r = await h.sharing.maybeShareBiliVideo('group:1', info, verdict);
  check('正常发送成功且记录间隔', r.ok && h.sent.length === 1 && h.deps.live.lastBiliShareAt > 0);
  check('标题与 bvid 原样拼入链接', h.sent[0][1].includes('《测试标题》') && h.sent[0][1].includes('https://www.bilibili.com/video/BV17x411w7KC'));
  check('推荐冷却期拒绝重复', !(await h.sharing.maybeShareBiliVideo('group:1', info, verdict)).ok);
}
{
  const h = sharingHarness({ sendToQQ: async () => { throw new Error('send failed'); } });
  let rejected = false; try { await h.sharing.maybeShareBiliVideo('group:1', info, verdict); } catch { rejected = true; }
  check('发送失败不记冷却', rejected && h.deps.live.lastBiliShareAt === 0);
  check('没有目标群明确跳过', !(await h.sharing.maybeShareBiliVideo(null, info, verdict)).ok);
  check('兴趣不足明确跳过', !(await h.sharing.maybeShareBiliVideo('group:1', info, { interest: 1 })).ok);
}
{
  const h = sharingHarness({ askModelOnce: async () => { h.deps.socialV2.paused = true; return '刚看到这个'; } });
  h.deps.cfg.socialV2.bili.share.askModel = true;
  check('生成推荐语期间暂停仍会复查', !(await h.sharing.maybeShareBiliVideo('group:1', info, verdict)).ok && h.sent.length === 0);
}
finish();
