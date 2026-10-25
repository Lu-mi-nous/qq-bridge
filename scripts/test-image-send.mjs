import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImageSender } from '../src/pipeline/image-send.js';
import { createSendQueue } from '../src/pipeline/send-queue.js';
import { checks } from './helpers/pipeline-harness.mjs';
const { check, finish } = checks();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-send-'));
fs.writeFileSync(path.join(temp, 'sample.png'), Buffer.from('fixture'));
function harness(overrides = {}) {
  const calls = [], picks = [], sent = [], used = [];
  const entry = { id: 'sample', file: 'sample.png', source: 'pixiv', artist: '示例', page: 'https://example.com/original' };
  const deps = {
    cfg: { socialV2: { images: {} } }, imagesEnabled: () => true,
    imageSendAllowed: () => ({ ok: true, times: [] }), sourcesWithHint: () => ({ requested: false, valid: [] }),
    imageStore: { libDir: temp, pickRandom: opt => { picks.push(opt); return { entry }; }, markUsed: id => used.push(id) },
    sourceFilterForPick: () => ({}), groupImageOpts: () => ({}), refreshImageLib: async () => ({ ok: true, added: 1 }),
    live: { lastFetchCorrections: [] }, imageAnnotation: () => '出处', recordSentMessage: (...a) => sent.push(a),
    onebotSend: async (...a) => calls.push(['annotation', ...a]), log: (...a) => calls.push(['log', ...a]),
    lastSentImage: new Map(), imageSendTimes: new Map(), sendQueue: createSendQueue(),
    fetchImpl: async (_url, options) => { calls.push(['http', JSON.parse(options.body)]); return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }; },
    resolveTagName: async () => null, ...overrides
  };
  return { sender: createImageSender(deps), deps, calls, picks, sent, used, entry };
}
async function rejects(name, h, opts, pattern) {
  let error; try { await h.sender.sendImageV2('group:1', opts); } catch (e) { error = e; }
  check(name, !!error && pattern.test(error.message), error?.message);
  check(`${name}不产生发送成功记录`, h.sent.length === 0 && h.used.length === 0 && h.deps.lastSentImage.size === 0);
}
try {
  const h = harness();
  const result = await h.sender.sendImageV2('group:1', { tags: ['cat'], replyToMessageId: '-12' });
  check('成功返回出处和真实发送状态', result.sent && result.artist === '示例' && result.annotation === '出处');
  check('成功才写记账', h.sent.length === 1 && h.used.length === 1 && h.deps.imageSendTimes.get('group:1').length === 1);
  const payload = h.calls.find(c => c[0] === 'http')[1];
  check('发图保持引用在前、图片在后', payload.group_id === 1 && payload.message[0].data.id === '-12' && payload.message[1].type === 'image');
  check('出处单独发送', h.calls[1][0] === 'annotation');
  await rejects('关闭图库拒绝', harness({ imagesEnabled: () => false }), {}, /图库未启用/);
  await rejects('准入拒绝', harness({ imageSendAllowed: () => ({ ok: false, error: 'paused' }) }), {}, /paused/);
  await rejects('无效引用拒绝', harness(), { replyToMessageId: '0' }, /非零整数/);
  const traversal = harness(); traversal.entry.file = `../${path.basename(temp)}-sibling/secret.png`;
  await rejects('同前缀兄弟目录拒绝', traversal, {}, /路径越界/);
  await rejects('HTTP 失败传播', harness({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }), {}, /发图失败/);
  const retcode = harness({ fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'failed', retcode: 1 }) }) });
  await rejects('上游 retcode 失败传播', retcode, {}, /发图失败/);
  const ann = harness({ onebotSend: async () => { throw new Error('annotation'); } });
  check('标注失败仍保留图已发成功', (await ann.sender.sendImageV2('group:1')).sent && ann.used.length === 1);
  let pulls = 0;
  const fetcher = harness({ resolveTagName: async t => ({ exact: false, postCount: 3, name: t + '_fixed' }) });
  fetcher.deps.imageStore.pickRandom = opt => { fetcher.picks.push(opt); return pulls++ === 0 ? null : { entry: fetcher.entry }; };
  const fetched = await fetcher.sender.sendImageV2('group:2', { tags: ['cat'], _fromFeedback: true });
  check('本地未命中会拉取再挑选', fetched.fetchedNow === 1 && fetcher.picks.length === 2);
  check('反馈换图两次选择都跳过最近过滤', fetcher.picks.every(p => p.blockRecentMs === 0));
  check('标签纠错随结果返回', fetched.tagCorrections[0].to === 'cat_fixed');
  let gates = 0;
  await rejects('慢查询后暂停必须拒绝发送', harness({ imageSendAllowed: () => ++gates === 1 ? { ok: true, times: [] } : { ok: false, error: 'paused later' } }), {}, /paused later/);
  const queue = createSendQueue(), order = [];
  let release;
  const blocked = queue.enqueue('group:1', () => new Promise(r => { release = r; }));
  const q = harness({ sendQueue: queue, fetchImpl: async (_url, options) => { order.push(JSON.parse(options.body).group_id); return { ok: true, json: async () => ({ status: 'ok', retcode: 0 }) }; } });
  const first = q.sender.sendImageV2('group:1');
  await q.sender.sendImageV2('group:2');
  check('其他群发图不被阻塞', order.join() === '2');
  release(); await blocked; await first;
  check('同群发图经过统一发送队列', order.join() === '2,1');
} finally {
  // 仅删除本测试 mkdtemp 创建的已知临时目录。
  if (path.dirname(temp) !== os.tmpdir() || !path.basename(temp).startsWith('qq-image-send-')) throw new Error('unexpected temp path');
  fs.rmSync(temp, { recursive: true, force: true });
}
finish();
