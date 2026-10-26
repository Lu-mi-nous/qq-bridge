// 表情包服务（R3-6）：本地库同步、列表、备注、删除与收藏。
//
// 只负责表情库与 QQ 收藏表情接口；发送/提示词挑选仍在 bridge/pipeline。
import fs from 'node:fs';
import path from 'node:path';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  applyStickerNote,
  syncStickerCache,
  writeStickerCacheRecord
} from './sticker-lib.js';

export function createStickerService({
  cfg,
  file,
  cacheDir,
  stateDir,
  request,
  getSocialV2State,
  fetchOneBotImage,
  fetchFaceMedia,
  shrinkStickerForUpload,
  uploadMaxBytes,
  uploadTargetBytes,
  log = () => {},
  now = Date.now
} = {}) {
  if (!file || !cacheDir || !stateDir) throw new Error('createStickerService: 路径不能为空');
  if (typeof request !== 'function') throw new Error('createStickerService: request 不能为空');

  let entries = loadStickerStore(file);
  let syncedAt = 0;
  let lastForcedAgentStickerSync = 0;

  function enabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveSafe() {
    try { saveStickerStore(file, entries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  function cacheOpts() {
    return {
      cacheDir,
      readLocalCache: cfg.socialV2?.sticker?.readLocalCache !== false
    };
  }

  async function sync(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const at = now();
    if (!force && syncedAt && at - syncedAt < ttl) {
      return { entries, syncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      const response = await request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      entries = mergeStickerLibrary(entries, fetched);
      try { syncStickerCache(entries, cacheDir); } catch (e) { log(`[sticker] 本地缓存标注写入失败: ${e?.message ?? e}`); }
      syncedAt = now();
      saveSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${entries.length} 条）`);
      return { entries, syncedAt, fromCache: false };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  async function list(query = '', count = 48, force = false) {
    const synced = await sync(force);
    return formatStickerList(synced?.entries ?? entries, query, count, cacheOpts());
  }

  async function getImageEntry(stickerId) {
    const synced = await sync(false);
    const entry = findSticker(synced?.entries ?? entries, stickerId);
    if (entry) return entry;
    const forced = await sync(true);
    const entry2 = findSticker(forced?.entries ?? entries, stickerId);
    if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    return entry2;
  }

  function applyNote(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(entries, stickerId, patch);
    if (!updated.entry) return null;
    entries = updated.entries;
    saveSafe();
    try { writeStickerCacheRecord(cacheDir, updated.entry, { preserveLocal: false }); } catch {}
    return updated.entry;
  }

  async function setRemark(stickerId, remark) {
    const synced = await sync(false);
    const entry = findSticker(synced?.entries ?? entries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(entries, entry.id, {});
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    entries = updated.entries;
    saveSafe();
    return entries.find((e) => e.id === entry.id) || null;
  }

  async function remove(stickerId) {
    const synced = await sync(false);
    const entry = findSticker(synced?.entries ?? entries, stickerId);
    if (!entry?.id) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效的 id / md5`);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(stateDir, `stickers-deleted-${stamp}.json`);
      fs.writeFileSync(backupFile, JSON.stringify({
        deletedAt: new Date().toISOString(),
        by: 'agent-tool',
        entries: [entry]
      }, null, 2), 'utf8');
    } catch (error) {
      log(`[sticker] 删前备份失败（继续但不可恢复）：${error?.message ?? error}`);
    }
    const expectMd5 = String(entry.md5 || '').toUpperCase();
    const response = await request('delete_custom_face', { emoji_id: entry.id });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`delete_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    let gone = true;
    try {
      const after = await sync(true);
      const listAfter = after?.entries ?? entries;
      if (expectMd5) gone = !findSticker(listAfter, expectMd5);
    } catch {}
    const desc = String(entry.desc || entry.localNote || '').slice(0, 20);
    entries = entries.filter((e) => e.id !== entry.id);
    saveSafe();
    return { id: entry.id, md5: expectMd5, desc, verifiedGone: gone };
  }

  async function collect(key, messageRef, remark) {
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let buffer = null;
    if (media?.kind === 'image') {
      const img = await fetchOneBotImage(media);
      if (img?.buffer) buffer = img.buffer;
      else throw new Error('无法安全获取该图片字节，已拒绝收藏');
    } else if (media?.kind === 'face') {
      const face = await fetchFaceMedia(media);
      if (face?.buffer) buffer = face.buffer;
    }
    if (!buffer) throw new Error('无法获取该表情的图片源');
    const maxUpload = Math.max(256 * 1024, Number(cfg.socialV2?.sticker?.collect?.maxUploadBytes) || uploadMaxBytes);
    if (buffer.length > uploadTargetBytes) {
      const shrunk = await shrinkStickerForUpload(buffer, {
        maxBytes: Math.min(maxUpload, uploadTargetBytes),
        mimeType: media?.mimeType || '',
        log
      });
      if (shrunk.shrunk) {
        buffer = shrunk.buffer;
        log(`[sticker] 收藏表情已压缩：${(shrunk.from / 1048576).toFixed(1)}MB → ${(shrunk.to / 1048576).toFixed(1)}MB${shrunk.static ? '（GIF 转静态首帧）' : ''}`);
      }
    }
    if (buffer.length > maxUpload) {
      throw new Error(`这张表情 ${(buffer.length / 1048576).toFixed(1)}MB，超过 QQ 收藏表情 ${(maxUpload / 1048576).toFixed(0)}MB 上限，压缩后仍然放不下`);
    }
    const fileData = 'base64://' + buffer.toString('base64');
    let addRes = await request('add_custom_face', { file: fileData });
    if ((!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) && String(addRes?.wording || '').includes('fetch failed')) {
      await new Promise((r) => setTimeout(r, 400));
      addRes = await request('add_custom_face', { file: fileData });
    }
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      const wording = addRes?.wording || addRes?.retcode || 'unknown';
      throw new Error(`add_custom_face 失败: ${wording}${String(wording).includes('fetch failed') ? '（QQ 表情上传通道拒绝了这次请求，通常是图片超过 4MB 或上游网络抖动）' : ''}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      const modRes = await request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    const synced = await sync(true);
    const entry = findSticker(synced?.entries ?? entries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }

  return {
    enabled,
    sync,
    list,
    cacheOpts,
    getImageEntry,
    applyNote,
    setRemark,
    remove,
    collect,
    saveSafe,
    find: (ref) => findSticker(entries, ref),
    getEntries: () => entries,
    setEntries: (value) => { entries = Array.isArray(value) ? value : []; },
    get syncedAt() { return syncedAt; },
    set syncedAt(value) { syncedAt = Number(value) || 0; },
    get lastForcedAgentStickerSync() { return lastForcedAgentStickerSync; },
    set lastForcedAgentStickerSync(value) { lastForcedAgentStickerSync = Number(value) || 0; }
  };
}
