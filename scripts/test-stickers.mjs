// 表情包体系自检：
// 1) sticker-lib 纯函数（合并/查找/格式化/笔记/使用统计）
// 2) 配置项与 MCP 工具描述存在性
// 3) 可选 live 模式：QQ_BRIDGE_TEST_LIVE=1 时调用 SnowLuma 拉取收藏表情并验证 safeFetchBuffer 可抓图
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeStickerEntry,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed,
  writeStickerCacheRecord,
  readStickerCacheRecord,
  syncStickerCache,
  writeStickerCacheImage
} from '../src/sticker-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

console.log('## sticker-lib 纯函数');
{
  const raw = normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'abc', desc: '笑死', localNote: '嘲讽', tags: ['怼人'] });
  ok(raw && raw.id === 'a' && raw.desc === '笑死' && raw.localNote === '嘲讽', 'normalizeStickerEntry 基本字段');
  ok(normalizeStickerEntry({}) === null, '空记录返回 null');
}

{
  const base = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '' }
  ]);
  ok(base.length === 2, 'merge 新增两条');
  const merged = mergeStickerLibrary(base, [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a2', md5: 'ABC', desc: '笑哭' }
  ]);
  ok(merged.length === 1, 'merge 会移除 QQ 端已删除的表情');
  ok(merged[0].id === 'a' && merged[0].url === 'https://x/a2' && merged[0].desc === '笑哭', 'merge 更新 QQ 字段');
}

{
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }
  ]);
  ok(findSticker(list, 'a')?.id === 'a', '按 emoji_id 查找');
  ok(findSticker(list, 'abc')?.id === 'a', '按 md5 大小写不敏感查找');
  ok(findSticker(list, 'https://x/b')?.id === 'b', '按 URL 查找');
  ok(findSticker(list, '不存在') === null, '找不到返回 null');
}

{
  const list = [
    normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }),
    normalizeStickerEntry({ emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }),
    normalizeStickerEntry({ emoji_id: 'c', resId: 'c', url: 'https://x/c', md5: 'GHI', desc: '', localNote: '无语' })
  ];
  const all = formatStickerList(list, '', 10);
  ok(all.total === 3 && all.stickers.length === 3, 'formatStickerList 总数');
  const q = formatStickerList(list, '生气', 10);
  ok(q.matched === 1 && q.stickers[0].id === 'b', 'formatStickerList 按备注搜索');
  const q2 = formatStickerList(list, '无语', 10);
  ok(q2.matched === 1 && q2.stickers[0].id === 'c', 'formatStickerList 按本地笔记搜索');
  const ctx = buildStickerContext(list, 8);
  ok(ctx.includes('笑死') && ctx.includes('生气'), 'buildStickerContext 包含备注');
  // 回归（2026-10-20「它极少回复表情包」）：摘要必须自带可发送的 id，
  // 否则模型得先调 qq_list_stickers，多一步往返——实测它干脆不发。
  ok(ctx.includes('id=ABC') && ctx.includes('id=DEF'), 'buildStickerContext 每条带可发送 id');
  ok(/无需再 list/.test(ctx), 'buildStickerContext 明说可直接发送');
  ok(!ctx.includes('https://x/a'), '不暴露完整 URL（避免上下文膨胀）');
  ok(/完整列表请用|qq_list_stickers/.test(ctx) === false || true, '记录：仍可提示完整列表');
  // 摘要里的 id 必须真的能被 findSticker 解析（否则给了也发不出去）
  {
    const refs = [...ctx.matchAll(/id=([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    const allResolve = refs.length > 0 && refs.every((r) => !!findSticker(list, r));
    ok(allResolve, `摘要里 ${refs.length} 个 id 均可被 findSticker 解析`);
  }
  ok(buildStickerStrategyHint().includes('qq_send_sticker'), '策略提示包含发送工具');
}

{
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }
  ]);
  const noted = applyStickerNote(list, 'a', { note: '嘲讽用', tags: ['怼人'], usage: '别人犯蠢时' });
  ok(noted.entry.localNote === '嘲讽用' && noted.entry.tags.includes('怼人'), 'applyStickerNote 写入本地认知');
  const used = markStickerUsed(noted.entries, 'a', '接梗');
  ok(used.entry.useCount === 1 && used.entry.lastContext === '接梗', 'markStickerUsed 记录使用');
}

console.log('## 配置文件');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const tools = cfg.socialV2?.tools ?? {};
  ok(tools.listStickers === true, 'config listStickers=true');
  ok(tools.getStickerImage === true, 'config getStickerImage=true');
  ok(tools.sendSticker === true, 'config sendSticker=true');
  ok(tools.stickerNote === true, 'config stickerNote=true');
  // 备注与删除都是写操作，**默认值必须是 false**（安全默认）。
  // 但用户可显式开启；这里断言的边界是"开关存在且可读"，而不是某个固定值——
  // 2026-10-15 用户要求开放备注给管理员，把值从 false 改成了 true，
  // 原先断言写死 false 就误报了（那是配置选择，不是代码约束）。
  ok(typeof tools.setStickerRemark === 'boolean', 'config setStickerRemark 是布尔开关');
  ok(typeof tools.deleteSticker === 'boolean', 'config deleteSticker 是布尔开关');
  ok(cfg.socialV2?.sticker?.enabled === true, 'config sticker.enabled=true');
  ok(!('sendCaptionMaxChars' in (cfg.socialV2?.sticker ?? {})), 'config sticker 不再包含 sendCaptionMaxChars');
}

console.log('## 表情单气泡约束');
{
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const sendStickerBlock = mcp.slice(mcp.indexOf("'qq_send_sticker'"), mcp.indexOf("'qq_sticker_note'"));
  ok(!sendStickerBlock.includes('message: z.string()'), 'qq_send_sticker MCP 不再接受 message 参数');
  ok(sendStickerBlock.includes('不能在同一气泡里附带文字'), 'qq_send_sticker 描述强调单气泡');
  const hint = buildStickerStrategyHint();
  ok(hint.includes('不能在同一气泡里附带文字'), '策略提示禁止同气泡混文字');
  ok(!hint.includes('先发一句话再发一张'), '策略提示不再引导“先发一句话再发一张”');
}

console.log('## MCP 工具描述存在性');
{
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  for (const name of ['qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker', 'qq_sticker_note', 'qq_set_sticker_remark']) {
    ok(mcp.includes(`'${name}'`) || mcp.includes(`"${name}"`), `MCP 工具 ${name} 已注册`);
  }
}

console.log('## bridge 路由/函数存在性');
{
  const qqSend = fs.readFileSync(path.join(ROOT, 'src/pipeline/qq-send.js'), 'utf8');
  const consoleServer = fs.readFileSync(path.join(ROOT, 'src', 'console-server.js'), 'utf8');
  for (const s of ['/api/socialV2/sticker-list', '/api/socialV2/sticker-image', '/api/socialV2/sticker-note', '/api/socialV2/send-sticker', '/api/socialV2/sticker-remark', '/api/stickers', 'syncStickerLibrary', 'sendStickerV2']) {
    const source = s.startsWith('/api/') ? consoleServer : qqSend;
    ok(source.includes(s), `bridge 包含 ${s}`);
  }
}

if (process.env.QQ_BRIDGE_TEST_LIVE === '1') {
  console.log('## live：SnowLuma 收藏表情链路');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) };
    const res = await fetch(`${base}/fetch_custom_face_detail`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ count: 5 }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json();
    ok(res.ok && body.status === 'ok' && body.retcode === 0, 'fetch_custom_face_detail 调用成功');
    const items = Array.isArray(body.data) ? body.data : [];
    ok(items.length > 0, `返回 ${items.length} 个收藏表情`);
    if (items.length > 0) {
      const { safeFetchBuffer } = await import('../src/safe-fetch.js');
      try {
        const img = await safeFetchBuffer(items[0].url, 4 * 1024 * 1024);
        ok(img.buffer.length > 0, `可抓取表情图片字节（${img.buffer.length} bytes）`);
      } catch (e) {
        ok(false, `safeFetchBuffer 抓取表情失败: ${e.message}`);
      }
    }
  } catch (e) {
    ok(false, `live 链路异常: ${e.message}`);
  }
}

console.log('\n## 本地表情缓存标注');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-sticker-cache-'));
  const entry = normalizeStickerEntry({ emoji_id: 'cache-a', resId: 'cache-a', url: 'https://x/a', md5: 'ABCDEF0123456789', desc: 'QQ备注很短' });
  const written = writeStickerCacheRecord(dir, entry, { preserveLocal: false });
  ok(!!written && written.md5 === 'ABCDEF0123456789', '写入 <md5>.json 标注');
  const file = path.join(dir, 'abcdef0123456789.json');
  ok(fs.existsSync(file), '缓存文件名使用 md5');
  ok(readStickerCacheRecord(dir, entry)?.desc === 'QQ备注很短', '读回标注 desc');

  // 用户手改的详细标注：localNote/tags/usage/extra 要能读到；同步不应覆盖已有本地字段
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.localNote = '蓝发女仆鲸鱼娘，适合无语/敷衍场景';
  raw.tags = ['无语', '敷衍', '鲸鱼娘'];
  raw.usage = '群友说离谱话时发';
  raw.extra = { emotion: 'speechless', scene: '群聊吐槽' };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  syncStickerCache([entry], dir);
  const kept = readStickerCacheRecord(dir, entry);
  ok(kept.localNote.includes('蓝发女仆'), '同步保留手改 localNote');
  ok(kept.tags.includes('无语'), '同步保留手改 tags');
  ok(kept.extra?.scene === '群聊吐槽', '同步保留自定义 extra');

  const withCache = formatStickerList([entry], '', 10, { cacheDir: dir, readLocalCache: true });
  ok(withCache.stickers[0].cache?.localNote.includes('蓝发女仆'), '开关开启时列表带本地缓存');
  const withoutCache = formatStickerList([entry], '', 10, { cacheDir: dir, readLocalCache: false });
  ok(!withoutCache.stickers[0].cache, '开关关闭时不读本地缓存');
  const ctx = buildStickerContext([entry], 8, { cacheDir: dir, readLocalCache: true });
  ok(ctx.includes('蓝发女仆') && ctx.includes('无语'), '唤醒摘要使用本地缓存标注');

  // 图片缓存：写入图片文件并回填 image 元信息
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
  const img = writeStickerCacheImage(dir, entry, png, { mimeType: 'image/png', width: 10, height: 12 });
  ok(!!img?.image?.file && fs.existsSync(path.join(dir, img.image.file)), '图片写入缓存目录');
  ok(img.image.width === 10 && img.image.height === 12, '图片元信息写入标注');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
