// R3-6 表情包服务：同步、列表、备注、删除、收藏错误路径。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStickerService } from '../src/sticker-service.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-sticker-service-'));
const file = path.join(tmp, 'stickers.json');
const cacheDir = path.join(tmp, 'cache');
const stateDir = path.join(tmp, 'state');
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

function makeService(overrides = {}) {
  let deleted = false;
  const requests = [];
  const cfg = { socialV2: { sticker: { enabled: true, syncTtlMs: 60000, maxListCount: 100, ...(overrides.sticker || {}) } } };
  const service = createStickerService({
    cfg,
    file,
    cacheDir,
    stateDir,
    request: async (action, params) => {
      requests.push({ action, params });
      if (action === 'fetch_custom_face_detail') {
        return {
          status: 'ok',
          retcode: 0,
          data: deleted ? [] : [{ emoji_id: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }]
        };
      }
      if (action === 'delete_custom_face') { deleted = true; return { status: 'ok', retcode: 0 }; }
      if (action === 'modify_custom_face' || action === 'add_custom_face') {
        return { status: 'ok', retcode: 0, data: { emoji_id: 'new' } };
      }
      return { status: 'ok', retcode: 0 };
    },
    getSocialV2State: () => ({ recentMessages: [] }),
    fetchOneBotImage: async () => ({ buffer: Buffer.from([1]) }),
    fetchFaceMedia: async () => ({ buffer: Buffer.from([1]) }),
    shrinkStickerForUpload: async (b) => ({ shrunk: false, buffer: b }),
    uploadMaxBytes: 4 * 1024 * 1024,
    uploadTargetBytes: 4 * 1024 * 1024,
    log: () => {},
    now: () => 1_700_000_000_000
  });
  return { service, requests, cfg };
}

try {
  console.log('── 1. 同步 / 缓存 / 列表 ──');
  {
    const { service, requests } = makeService();
    const r = await service.sync(true);
    check('同步拉取收藏表情', r.entries.length === 1 && r.entries[0].id === 'a');
    check('同步写入本地库', fs.existsSync(file));
    check('同步调用 OneBot', requests.some((x) => x.action === 'fetch_custom_face_detail'));
    const cached = await service.sync(false);
    check('TTL 内使用缓存', cached.fromCache === true);
    const list = await service.list('笑', 10, false);
    check('列表可按备注搜索', list.matched === 1 && list.stickers[0].id === 'a');
  }

  console.log('\n── 2. 备注 / 修改备注 / 删除 ──');
  {
    const { service, requests } = makeService();
    await service.sync(true);
    const note = service.applyNote('a', '嘲讽', ['怼人'], '互怼');
    check('写入本地备注', note?.localNote === '嘲讽' && note?.tags.includes('怼人'));
    const remark = await service.setRemark('a', '新备注');
    check('修改 QQ 备注并同步本地 desc', remark?.desc === '新备注'
      && requests.some((x) => x.action === 'modify_custom_face'));
    const del = await service.remove('a');
    check('删除前备份并返回校验结果', del.id === 'a' && del.verifiedGone === true);
    check('删除后本地库移除', service.getEntries().length === 0);
    check('删除生成备份文件', fs.readdirSync(stateDir).some((f) => f.startsWith('stickers-deleted-')));
  }

  console.log('\n── 3. 关闭 / 收藏错误路径 ──');
  {
    const { service } = makeService({ sticker: { enabled: false } });
    const r = await service.sync(true);
    check('关闭时不同步', r === null);

    const { service: s2 } = makeService();
    let err = '';
    try { await s2.collect('group:1', '999', 'x'); } catch (e) { err = String(e.message || e); }
    check('找不到消息时明确报错', /找不到这条消息/.test(err));
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
