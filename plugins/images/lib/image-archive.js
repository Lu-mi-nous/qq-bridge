/**
 * 图片收藏：把一张图的**原图**保存到专用目录。
 *
 * 为什么必须"回源取原图"而不是直接复制库里的文件：
 *   图库为了省空间与加速，存的多是**压缩版**——safebooru 取 `large_file_url`、
 *   yandere 取 `sample_url`（原图可达 19.5MB）。实测同一张图库里 96KB、
 *   原图 262KB。既然用户要的是"收藏原始画质"，就必须按 id 回源查原图直链再下。
 *
 * 另外图库条目里**没有持久化 url 字段**（只有 id/source/page/tags 等），
 * 所以也无法从条目直接拿到任何直链——回源查询是唯一可行路径。
 *
 * 命名策略：`<来源>_<id>[_<画师>].<ext>`。用 id 派生 → 天然幂等（重复保存同一张
 * 不会产生副本），且名字可读、便于在文件管理器里认出来源。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 文件名里不允许的字符（Windows 最严：<>:"/\|?* 与控制字符，另外避开空格与中文标点）。 */
function sanitizeForFilename(s, maxLen = 40) {
  return String(s ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')   // 非法字符
    .replace(/[\s\u3000]+/g, '_')                // 空白 → 下划线
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')               // 去首尾点/下划线（Windows 不允许结尾点）
    .slice(0, maxLen);
}

/** 从图库 id 拆出 { source, id }。 */
function splitId(entry) {
  const m = /^([a-z]+):(\d+)$/.exec(String(entry?.id ?? '').trim());
  return m ? { source: m[1], id: m[2] } : { source: '', id: '' };
}

/** 由扩展名推断 Content-Type（用于写文件时不做转换，仅记录）。 */
export function extOfUrl(url) {
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(String(url ?? ''));
  const ext = (m?.[1] ?? '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  return 'jpg'; // 兜底
}

/**
 * 按图库条目向外**来源站点**查询原图直链。
 *
 * @param {{id:string, source:string}} entry
 * @param {{jsonFetch?:Function, proxy?:string, log?:Function}} deps
 * @returns {Promise<string>} 原图 URL（取不到时抛错）
 */
export async function resolveOriginalUrl(entry, { jsonFetch = null, proxy = '', log = () => {} } = {}) {
  const { source, id } = splitId(entry);
  if (!source || !id) throw new Error(`图库 id 格式无法解析：${entry?.id ?? '(空)'}`);

  // safebooru / yandere：帖子接口里 file_url 就是原图（large/sample 才是压缩版）
  if (source === 'safebooru') {
    const url = `https://safebooru.donmai.us/posts/${id}.json`;
    const j = jsonFetch
      ? await jsonFetch(url, { accept: 'application/json' })
      : await (await fetch(url, { headers: { 'user-agent': 'qq-bridge/0.1' }, signal: AbortSignal.timeout(30000) })).json();
    if (j?.file_url) return String(j.file_url);
    if (j?.large_file_url) {
      log(`safebooru:${id} 无 file_url，退回 large_file_url`);
      return String(j.large_file_url);
    }
    throw new Error(`safebooru:${id} 未返回原图地址`);
  }

  if (source === 'yandere') {
    const url = `https://yande.re/post.json?tags=id:${id}`;
    if (typeof jsonFetch !== 'function') throw new Error('yandere 需要代理（未注入 jsonFetch）');
    const j = await jsonFetch(url, { accept: 'application/json' });
    const p = Array.isArray(j) ? j[0] : (j?.posts?.[0]);
    if (p?.file_url) return String(p.file_url);
    if (p?.sample_url) {
      log(`yandere:${id} 无 file_url，退回 sample_url`);
      return String(p.sample_url);
    }
    throw new Error(`yandere:${id} 未返回原图地址`);
  }

  if (source === 'pixiv') {
    const url = `https://www.pixiv.net/ajax/illust/${id}`;
    if (typeof jsonFetch !== 'function') throw new Error('pixiv 需要代理（未注入 jsonFetch）');
    const j = await jsonFetch(url, { accept: 'application/json', referer: 'https://www.pixiv.net/' });
    const orig = j?.body?.urls?.original;
    if (orig) return String(orig);
    const large = j?.body?.urls?.large;
    if (large) {
      log(`pixiv:${id} 无 original，退回 large`);
      return String(large);
    }
    throw new Error(`pixiv:${id} 未返回原图地址`);
  }

  throw new Error(`未知图源「${source}」：不知道该去哪个站点取原图`);
}

/**
 * 把一张图的原图保存到专用目录。
 *
 * @param {object} entry 图库条目（需含 id / source / artist）
 * @param {{
 *   dir: string,                    // 专用目录
 *   fetchBuffer: Function,          // (url, {referer}) => Promise<Buffer>；由调用方注入下载实现
 *   jsonFetch?: Function,           // 回源查原图直链
 *   proxy?: string,
 *   log?: Function,
 *   maxBytes?: number,
 *   overwrite?: boolean
 * }} opts
 * @returns {Promise<{ok:boolean, path:string, url:string, bytes:number, ext:string, skipped?:boolean}>}
 */
export async function saveOriginalImage(entry, opts = {}) {
  const { dir, fetchBuffer, jsonFetch = null, proxy = '', log = () => {}, maxBytes = 64 * 1024 * 1024, overwrite = false } = opts;
  if (!dir) throw new Error('未配置收藏目录（socialV2.images.archiveDir）');
  if (typeof fetchBuffer !== 'function') throw new Error('缺少下载实现（fetchBuffer）');

  const { source, id } = splitId(entry);
  const url = await resolveOriginalUrl(entry, { jsonFetch, proxy, log });
  const ext = extOfUrl(url);

  // 目标文件名：来源_id_画师.ext（id 派生 → 重复保存幂等）
  const artistPart = sanitizeForFilename(entry?.artist, 30);
  const base = sanitizeForFilename(`${source}_${id}${artistPart ? '_' + artistPart : ''}`, 90) || `${source}_${id}`;
  let filename = `${base}.${ext}`;
  fs.mkdirSync(dir, { recursive: true });
  let abs = path.join(dir, filename);

  if (fs.existsSync(abs) && !overwrite) {
    const st = fs.statSync(abs);
    // 已存在且非空 → 视为已收藏，不重复下载（省流量也避免覆盖用户可能改过的东西）
    if (st.size > 0) {
      return { ok: true, path: abs, url, bytes: st.size, ext, skipped: true };
    }
  }

  const buf = await fetchBuffer(url, { referer: source === 'pixiv' ? 'https://www.pixiv.net/' : '' });
  if (!buf?.length) throw new Error('下载得到空内容');
  if (buf.length > maxBytes) throw new Error(`原图过大（${(buf.length / 1048576).toFixed(1)}MB > ${(maxBytes / 1048576).toFixed(0)}MB）`);

  // 同名但扩展名不同（如原图是 png 而旧文件是 jpg）时另立名字，避免相互覆盖
  if (fs.existsSync(abs) && !overwrite) {
    let n = 2;
    while (fs.existsSync(abs)) {
      filename = `${base}_${n}.${ext}`;
      abs = path.join(dir, filename);
      n += 1;
      if (n > 99) break;
    }
  }

  const tmp = `${abs}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, abs); // 原子落盘：避免中断留下半个文件
  log(`已收藏 ${entry?.id} → ${abs}（${(buf.length / 1024).toFixed(0)}KB）`);
  return { ok: true, path: abs, url, bytes: buf.length, ext, skipped: false };
}

export { sanitizeForFilename };
