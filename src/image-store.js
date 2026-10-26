// 图库存储：把拉取到的图片落盘并在本地索引，供按需取图（发图）使用。
//
// 为什么要落盘而不是每次现拉：
//   1) 图站有速率限制，现拉会慢且易被限流；落盘后发图是本地读取，快且稳。
//   2) 群友要求时可能想「再来一张」，本地有库才能立刻响应。
//   3) 可保留元数据（画师/出处/分级），发送时一并标注，版权可追溯。
//
// 存储布局（全部在 state/ 下，已被 .gitignore 忽略，不会误提交）：
//   state/image-lib/index.json   元数据索引
//   state/image-lib/<hash>.<ext> 图片文件（按内容 md5 命名，天然去重）
//
// 容量控制：超过 maxFiles 时按「最久未用」+「最早入库」淘汰，并删除对应文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { looksLikeImageBuffer } from './safe-fetch.js';
import { isGroupLike } from './image-quality.js';
import { createJsonStore } from './state/store.js';

const INDEX_VERSION = 1;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 扩展名（按魔数判定，不信任 URL 后缀）。 */
function extFromBuffer(buf) {
  if (!buf || buf.length < 12) return '.bin';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return '.gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57) return '.webp';
  return '.bin';
}

export function createImageStore({
  dir,
  maxFiles = 300,
  maxTotalBytes = 256 * 1024 * 1024,
  log = () => {},
  // 「发过的图多久内不再发」的默认值（可由 pickRandom 的 blockRecentMs 覆盖）
  recentBlockMs = 10 * 60 * 1000,
  // 时钟注入：测试用可控时钟验证"10 分钟冷却会过期"。
  // 生产不传，用 Date.now()。**不要**在业务代码里传别的。
  now = () => Date.now()
}) {
  const libDir = dir;
  const nowMs = typeof now === 'function' ? now : () => Date.now();
  const defaultRecentBlockMs = Math.max(0, Number(recentBlockMs) || 0);
  const indexPath = path.join(libDir, 'index.json');
  // 被拒绝的图（群友说「不好看/不是我要的」后删掉的）。**必须持久化**：
  // 删除会解除 index 里的 id 去重，若不留记录，下次查询会把同一张直接拉回来
  // ——群友看到的就是「我说了不喜欢，它又发同一张」，这正是要避免的。
  const rejectedPath = path.join(libDir, 'rejected.json');
  const REJECTED_CAP = 2000; // 有界：只留最近拒绝的，避免无限增长

  // ── 最近发过的图（按**内容哈希**记，跨条目删除存活）────────────────────
  //
  // 为什么不能只靠 index 里的 useCount（2026-10-20 实测踩坑）：
  //   `pruneSent` 在 10 分钟后把发过的条目**整个删掉**（连 index 记录一起），
  //   同一张图再被查询时会重新拉取，`add()` 生成一条全新的 `useCount: 0` 记录
  //   ——于是"新鲜度"判断认为它从没发过，又发一次。
  //   日志实证：`pixiv:150564360` 在 4 分钟内被发了 3 次，全是这个循环。
  //
  // 所以单独记一份「内容哈希 → 发送时间」：条目删了它还在，10 分钟内不会再选到。
  const recentPath = path.join(libDir, 'recent-sent.json');
  const RECENT_CAP = 500; // 有界：远超任何 10 分钟内的发送量
  const DEFAULT_RECENT_BLOCK_MS = 10 * 60 * 1000;

  // 图库三个状态文件统一经 R2 store 写入（版本号/原子替换/损坏备份）。
  const indexStore = createJsonStore({
    file: indexPath,
    version: 1,
    defaults: () => ({ version: INDEX_VERSION, items: [] })
  });
  const recentStore = createJsonStore({
    file: recentPath,
    version: 1,
    defaults: () => ({ at: {} })
  });
  const rejectedStore = createJsonStore({
    file: rejectedPath,
    version: 1,
    defaults: () => ({ version: 1, ids: [], at: {} })
  });

  function loadRecent() {
    const raw = recentStore.read();
    if (raw && raw.at && typeof raw.at === 'object') return { at: raw.at };
    return { at: {} };
  }

  function saveRecent() {
    const cutoff = nowMs() - 30 * 60 * 1000; // 只留 30 分钟内的（够 10 分钟窗口用）
    const entries = Object.entries(recent.at)
      .filter(([, t]) => Number(t) >= cutoff)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, RECENT_CAP);
    recent.at = Object.fromEntries(entries);
    recentStore.write({ at: recent.at, savedAt: nowMs() });
  }

  function loadRejected() {
    const raw = rejectedStore.read();
    if (raw && Array.isArray(raw.ids)) return { ids: raw.ids.map(String), at: raw.at ?? {} };
    return { ids: [], at: {} };
  }

  function saveRejected() {
    // 只保留最近 REJECTED_CAP 个（按加入顺序裁剪）
    if (rejected.ids.length > REJECTED_CAP) {
      const drop = rejected.ids.slice(0, rejected.ids.length - REJECTED_CAP);
      for (const id of drop) delete rejected.at[id];
      rejected.ids = rejected.ids.slice(-REJECTED_CAP);
    }
    rejectedStore.write({ version: 1, ids: rejected.ids, at: rejected.at });
  }

  function loadIndex() {
    const raw = indexStore.read();
    if (raw && raw.version === INDEX_VERSION && Array.isArray(raw.items)) return raw;
    return { version: INDEX_VERSION, items: [] };
  }

  function saveIndex(index) {
    indexStore.write(index);
  }

  let index = loadIndex();
  let rejected = loadRejected();
  let recent = loadRecent();

  /** 现有条目数。 */
  const count = () => index.items.length;

  /** 按 id 查条目。 */
  const getById = (id) => index.items.find((it) => it.id === id) ?? null;

  /**
   * 判断某条目是否已入库（按源内 id 去重，避免同一张图反复下载）。
   *
   * **被拒绝过的图也算「已入库」**：调用方（bridge 的拉取循环）用它跳过重复，
   * 所以这里一并拦截，被拒绝的图才不会又被拉回来。语义上是「这张已经处理过了」。
   */
  const has = (id) => isRejected(id) || index.items.some((it) => it.id === id);

  /** 是否被拒绝过（群友说过不好看）。 */
  const isRejected = (id) => rejected.ids.includes(String(id ?? ''));

  /** 被拒绝的数量与列表（诊断用）。 */
  const rejectedStats = () => ({ count: rejected.ids.length, cap: REJECTED_CAP });

  /**
   * 落盘一张图。buf 为图片字节；meta 为源元数据（id/source/page/artist/tags/rating）。
   * 返回入库条目；字节非法（非图片）返回 null。
   */
  function add(buf, meta = {}) {
    if (!looksLikeImageBuffer(buf)) return null;
    const id = String(meta.id ?? '').trim();
    if (!id) return null;
    // 内容哈希命名：同一张图重复下载会得到同一文件名，天然去重且可校验完整性。
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    const ext = extFromBuffer(buf);
    const filename = `${hash}${ext}`;
    const abs = path.join(libDir, filename);

    ensureDir(libDir);
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, buf);

    const existing = index.items.find((it) => it.id === id);
    if (existing) {
      // 同 id 重复入库：只刷新元数据，不重复占文件
      Object.assign(existing, {
        page: meta.page ?? existing.page,
        sourcePage: meta.sourcePage ?? existing.sourcePage,
        artist: meta.artist ?? existing.artist,
        artistId: meta.artistId ?? existing.artistId,
        tags: Array.isArray(meta.tags) ? meta.tags : existing.tags,
        rating: meta.rating ?? existing.rating,
        bytes: buf.length,
        // 分数也要刷新：图站投票会随时间变化（新图从 0 涨起来）
        score: Number.isFinite(Number(meta.score)) ? Number(meta.score) : existing.score,
        width: Number(meta.width) || existing.width,
        height: Number(meta.height) || existing.height
      });
      saveIndex(index);
      return existing;
    }

    const entry = {
      id,
      source: String(meta.source ?? ''),
      file: filename,
      bytes: buf.length,
      page: String(meta.page ?? ''),
      // 图源站点自己的帖子页（与 page 不同：page 多是画师的原始发布处，
      // sourcePage 是它在图源站上的条目页，用于「按来源站点查找」）
      sourcePage: String(meta.sourcePage ?? ''),
      artist: String(meta.artist ?? ''),
      // 画师的**数字 ID**（pixiv userId）。为什么要单独存：pixiv 只能靠数字 ID 可靠地
      // 按画师取图（名字搜索是标签匹配，画师名常不是自己作品的标签），而取回的图只带
      // 名字。若不存 ID，`artist:83739` 这类查询在本地库里永远匹配不上，每次都要回源。
      artistId: String(meta.artistId ?? ''),
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      rating: String(meta.rating ?? ''),
      // score / width / height 必须存：上游三个源都提供，
      // 曾漏存导致图库所有 score 恒为 0，无法按社区票数筛掉丑图（只能随机抽）。
      score: Number(meta.score) || 0,
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
      addedAt: nowMs(),
      useCount: 0,
      lastUsedAt: 0
    };
    index.items.push(entry);
    saveIndex(index);
    return entry;
  }

  /** 淘汰：同时受「数量上限」与「总字节上限」约束，取先到者。
   *
   * 为什么要字节上限：单图上限 4MB × 300 张 = 理论最坏 1.17GB。实际平均约 200KB，
   * 但热门高分辨率图可能长期接近单图上限，只靠数量限制兜不住磁盘增长。
   *
   * 淘汰优先级（从先丢到后留）：
   *   1. 「未用过且入库已久」——纯占位的旧图
   *   2. 「用过但最久远」——老图先轮换
   *   3. 「刚入库的」——**最后才丢**
   *
   * 为什么「刚入库」要排在最后：按需查询的典型场景是「库满 + 用户要新标签」，
   * 此时刚拉来的图必然「未用过且最新」。若按 `lastUsedAt || addedAt` 朴素排序，
   * 它们的键最新看着像「最新鲜」而最后丢；但若把「未用过」一律排在最前，
   * 又会先丢掉这些刚拉来、正是用户要的图（实测：满库查新标签 → 新图被自己淘汰，
   * 用户永远拿不到）。所以必须让「新鲜度」压过「是否用过」：
   * 只有同时满足「未用过」且「不是最新一批」才是首选淘汰对象。
   */
  function prune(explicitMaxFiles, explicitMaxBytes) {
    const maxF = Math.max(1, Number(explicitMaxFiles) || maxFiles);
    const maxB = Math.max(0, Number(explicitMaxBytes) || maxTotalBytes);
    // 最近入库的一批视为「新鲜」，给予保护窗口（按数量取，避免同毫秒入库无法区分）。
    const freshCount = Math.min(20, Math.max(0, Math.ceil(index.items.length * 0.2)));
    const byNewest = [...index.items].sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));
    const freshIds = new Set(byNewest.slice(0, freshCount).map((it) => it.id));

    const rank = (it) => {
      const used = it.lastUsedAt ? 1 : 0;
      const fresh = freshIds.has(it.id) ? 1 : 0;
      if (!used && !fresh) return 0; // 又没用过又不新鲜 → 最先淘汰
      if (used && !fresh) return 1;  // 用过但已放旧 → 次之
      if (!used && fresh) return 2;  // 刚拉来还没用 → 保护
      return 3;                      // 用过且新鲜 → 最该留下
    };
    const order = [...index.items].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      // 同级内：越老越先淘汰
      return (a.lastUsedAt || a.addedAt) - (b.lastUsedAt || b.addedAt);
    });

    let totalBytes = index.items.reduce((sum, it) => sum + (Number(it.bytes) || 0), 0);
    const dropIds = new Set();
    let idx = 0;
    // 只要还超（数量或字节任一），就从最该淘汰的开始丢
    while (idx < order.length && (index.items.length - dropIds.size > maxF || (maxB > 0 && totalBytes > maxB))) {
      const victim = order[idx++];
      dropIds.add(victim.id);
      totalBytes -= Number(victim.bytes) || 0;
    }
    if (!dropIds.size) return 0;

    for (const it of index.items) {
      if (dropIds.has(it.id)) {
        try { fs.rmSync(path.join(libDir, it.file), { force: true }); } catch {}
      }
    }
    index.items = index.items.filter((it) => !dropIds.has(it.id));
    saveIndex(index);
    log(`图库淘汰 ${dropIds.size} 张（上限 数量${maxF} / 总量${Math.round(maxB / 1048576)}MB，剩余 ${index.items.length} 张 ${(totalBytes / 1048576).toFixed(1)}MB）`);
    return dropIds.size;
  }

  /** 当前总字节（用于统计/展示）。 */
  function totalBytes() {
    return index.items.reduce((sum, it) => sum + (Number(it.bytes) || 0), 0);
  }

  /** 读取条目对应的图片字节；文件丢失返回 null。 */
  function readBuffer(entry) {
    if (!entry?.file) return null;
    try {
      return fs.readFileSync(path.join(libDir, entry.file));
    } catch {
      return null;
    }
  }

  /**
   * 随机取一张可用的图（用于「来点图」）。可按 tags 粗筛。
   * 会跳过文件已丢失的条目，并顺手把死条目清掉。
   */
  function pickRandom(filter = {}) {
    const want = Array.isArray(filter.tags) ? filter.tags.map((t) => String(t).toLowerCase()).filter(Boolean) : [];
    // 限定的图源（群主要求「从 pixiv 找」时就该只给 pixiv 的图）。
    // 注意 `source` 字段是源的**名字**（safebooru/pixiv/yandere），不是标签的一部分，
    // 所以必须单独过滤，不能指望 tags 匹配覆盖到它。
    const wantSources = Array.isArray(filter.sources)
      ? filter.sources.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean)
      : [];
    let pool = index.items;
    if (wantSources.length) {
      pool = pool.filter((it) => wantSources.includes(String(it.source ?? '').toLowerCase()));
    }
    if (want.length) {
      const matchTags = (list, queries) => list.filter((it) => {
        const tags = [...(it.tags ?? []), it.artist ?? '', it.source ?? ''].map((t) => String(t).toLowerCase());
        const hay = tags.join(' ');
        const artist = String(it.artist ?? '').toLowerCase();
        // 多标签必须**全部满足**（AND 语义），不能只命中一个就算匹配。
        // 曾经的 bug：用 `.some()` 判「命中任一」，于是查 ["mint","neverness_to_everness"]
        // 时任何异环的图都会命中（它们都含作品标签），发出去的角色完全随机——
        // 用户看到的就是「要薄荷却发了别的角色」。
        // 归一化：查询词的空格转下划线再比（标签用下划线）；同时允许标签名前缀匹配，
        // 因为查询常用短名而标签带作品限定（`aemeath` 应命中 `aemeath_(wuthering_waves)`）。
        return queries.every((w) => {
          const raw = String(w).trim();
          // 画师前缀：`artist:名字` 只匹配 artist 字段，不再散落到 tags/source。
          // 为什么需要专用前缀：画师名常与标签同名或形近（如 `kem` 既是画师也可能出现在
          // 别的字段），无前缀时会误命中不属于该画师的图。也支持 `user:` 别名（yande.re 语法）。
          const m = /^(?:artist|user):\s*(.+)$/.exec(raw);
          // 链接形式的画师引用（群友常贴 pixiv 主页链接，见 image-sources.parsePixivArtistRef）。
          // 这里只需抽出其中的数字 ID —— 本地匹配只认 ID/名字，不关心来源。
          if (!m && /pixiv\.net\/|^\/?users\//i.test(raw)) {
            const linkId = /users\/(\d+)/i.exec(raw);
            if (linkId) return String(it.artistId ?? '') === linkId[1];
          }
          if (m) {
            const needle = m[1].toLowerCase().replace(/\s+/g, '_');
            // 数字 ID 查询（`artist:83739`）匹配 artistId 字段；名字查询匹配 artist 字段。
            // 两者都试：图库里的条目可能只带了其中一个（老条目没有 artistId）。
            const artistId = String(it.artistId ?? '').toLowerCase();
            if (/^\d+$/.test(needle)) return artistId === needle;
            return artist === needle || artist.includes(needle);
          }
          // ⚠️ 必须 toLowerCase：上面的 tags 已小写化，needle 不小写就永远匹配不上
          // 含大写字母的标签名（实测 `Columbina_(Genshin_Impact)` 查不到，
          // 而库里明明有这张图——既有缺陷，2026-10-15 排查群像问题时发现）。
          const needle = raw.replace(/\s+/g, '_').toLowerCase();
          return tags.some((t) => t === needle || t.startsWith(needle + '_') || t.startsWith(needle + '(') || t.includes(needle))
            || hay.includes(needle);
        });
      });

      pool = matchTags(pool, want);
      // 跨站写法互通：booru 系 `name_(franchise)` 与 pixiv 的 `名前(作品)` **不通用**——
      // 库里 pixiv 的图带 `アンジェリーナ(アークナイツ)`（还有英文标签 `angelina`/`Arknights`），
      // 而模型常传 `angelina_(arknights)`，严格匹配命中 0 张（实测）。
      //
      // 这里用**并集**而不是"严格为空才宽松"：库里同时有 booru 图与 pixiv 图时
      // （同一个角色两种写法并存很常见），只取严格结果会把 pixiv 那批漏掉——
      // 群主要的是角色，不该因为图来自哪个站而少一半可选项。
      //
      // 宽松判据是**近似 AND**：查询词拆出的每个片段都要在图里出现
      // （`angelina arknights` → 图里需同时有 angelina 与 arknights）。
      // 这比"含任一片段"严格得多，所以并集也不会引入无关角色。
      {
        const relaxed = want.map((w) => String(w).replace(/[()]/g, ' ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
        const changed = relaxed.some((r, i) => r && r !== String(want[i]).replace(/\s+/g, '_'));
        if (changed) {
          const base = wantSources.length
            ? index.items.filter((it) => wantSources.includes(String(it.source ?? '').toLowerCase()))
            : index.items;
          const parts = relaxed.flatMap((r) => r.toLowerCase().split(/\s+/)).filter(Boolean);
          if (parts.length) {
            const loose = base.filter((it) => {
              const hay = [...(it.tags ?? []), it.artist ?? '', it.source ?? ''].map((t) => String(t).toLowerCase()).join(' ');
              return parts.every((p) => hay.includes(p));
            });
            if (loose.length) {
              // 合并去重（按 id），保留顺序无关
              const seen = new Set(pool.map((it) => it.id));
              for (const it of loose) if (!seen.has(it.id)) { pool.push(it); seen.add(it.id); }
            }
          }
        }
      }
    }
    // 选图策略：**质量 + 口味双筛，再做随机**，而不是纯随机。
    //
    // 纯随机会把图站里得票 0 的冷门/低质图与高分图等概率抽出——用户看到的就是「有的图太丑」。
    // 两层信号：
    //   score   社区投票（图站几万人标的，最接近「好不好看」）
    //   taste   与用户收藏画像的相似度（`image-taste.js`；来自他 7500+ 张收藏的客观特征）
    // 做法：先按 score 截取上半，再按 taste 截取上半，池内随机（保留新鲜感与轮换）。
    // 任一信号缺失（老数据/未算特征）时自动跳过该层，不因缺数据把图全滤掉。
    const scored = pool.filter((it) => Number(it.score) > 0);
    let stage1 = pool;
    if (scored.length >= 3) {
      const sorted = [...pool].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
      stage1 = sorted.slice(0, Math.max(3, Math.ceil(sorted.length * 0.5)));
    }
    // 口味层：只对有 taste 分的条目排序；没有 taste 分的图（尚未算特征的旧图）
    // 与低分图一起留在候选里但排在后面 —— 既优先推合口味的，又不至于完全埋没。
    const withTaste = stage1.filter((it) => Number.isFinite(Number(it.taste)));
    let candidates = stage1;
    if (withTaste.length >= 3) {
      const sorted = [...stage1].sort((a, b) => (Number(b.taste) ?? -1) - (Number(a.taste) ?? -1));
      candidates = sorted.slice(0, Math.max(3, Math.ceil(sorted.length * 0.6)));
    }

    // 群像排除层：**必须放在 score/taste 之后**，否则前两层按分数排会把群像
    // （通常分高、角色标签多）推到前面，这一层就等于没做。
    //
    // 为什么需要：群像图带多个角色标签，查任何角色都能命中它（实测群像平均 9.8 个
    // 角色标签、单角色图仅 1.0），于是「要什么角色都发同一张大合照」。
    //
    // 2026-10-15 用户要求「搜图时别发群像图（超过 10 个角色那种）」，
    // 行为从**降权**改为**排除**：池里没有非群像图时不再退回发群像，
    // 而是返回空结果，让上层去外站现拉（拉到就发单人图，拉不到就如实说没找到）。
    // 依据：库里 91 个角色标签中有 66 个（73%）**只有群像候选**——
    // 降权挡不住它们，每次要这些角色都会发大合照。
    //
    // `allowGroupImages: true` / `preferSingleCharacter: false` 保留为显式退出口。
    if (filter.allowGroupImages !== true) {
      candidates = candidates.filter((it) => !isGroupLike(it, { charTagThreshold: filter.charTagThreshold }));
    }

    // 新鲜度降权层：优先发**没发过**的图，避免同一个角色老是同一张。
    //
    // 为什么需要：已发图会在 10 分钟后被 pruneSent 删除，但删掉后再次查询会
    // 重新拉取，很可能把同一张又拉回来（热门图在按分数排的候选里一直靠前）——
    // 群友看到的就是「每次要这个角色都是这张」。这里按「发过的次数」分层：
    // 没发过的优先；只有全都发过时才在发过的里面挑，且优先挑最久没发的。
    if (filter.ignoreRecentUse !== true) {
      const fresh = candidates.filter((it) => !(Number(it.useCount) > 0));
      if (fresh.length) {
        candidates = fresh;
      } else {
        // 全都发过：按上次发送时间升序，让最久没发的排前面（不再纯随机）
        const byOldest = [...candidates].sort((a, b) => {
          const av = Number(a.lastUsedAt) || 0;
          const bv = Number(b.lastUsedAt) || 0;
          // 从未发过的（0）排最前；其余按时间升序
          return (av === 0 ? -1 : bv === 0 ? 1 : av - bv);
        });
        // 取前一半再随机，兼顾"优先旧图"与"别每次都同一张"
        candidates = byOldest.slice(0, Math.max(1, Math.ceil(byOldest.length / 2)));
      }
    }

    // 「刚发过就别再发」硬过滤（2026-10-20 用户要求「发过的图在十分钟内不要重复发」）。
    //
    // 这一层和上面的新鲜度层解决的是**不同问题**：
    //   新鲜度层：同一次会话里别老发同一张（靠 index 的 useCount）
    //   本层：条目被 pruneSent 删掉后重新拉回来，也不能再发（靠内容哈希）
    // 少了这一层就会出现实测到的现象：同一张图被"发→10 分钟后删→重拉"反复选中。
    //
    // 注意「全部被过滤掉」时不要退让：宁可返回空让上层去现拉新图，也不发重复的。
    const blockMs = Number(filter.blockRecentMs ?? defaultRecentBlockMs) || 0;
    if (blockMs > 0) {
      const now = nowMs();
      candidates = candidates.filter((it) => {
        const t = Number(recent.at[String(it.file ?? '')]) || 0;
        return !(t > 0 && now - t < blockMs);
      });
    }

    // dryRun：只统计「过滤后有多少可用候选」，不读文件、不改状态。
    // 供发图预检用（毫秒级返回，让模型知道要不要等现拉）。
    //
    // ⚠️ 必须返回 `candidates.length` 而不是 `pool.length`：
    // pool 只经过标签/图源过滤，**绕过了群像排除、画风/质量分层、新鲜度降权**等后续层。
    // 原先返回 pool.length 时，预检会报「本地有图」而实际挑选时被过滤层清空，
    // 于是走向"说本地有→发不出去→再现拉"的矛盾路径（实测：只有群像的角色
    // 预检说有 11 张，实际一张都不该发）。
    if (filter.dryRun) return { count: candidates.length };

    // 打乱后逐个试，跳过文件丢失的
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    for (const it of shuffled) {
      const buf = readBuffer(it);
      if (buf?.length) return { entry: it, buffer: buf };
      // 文件没了：清掉死条目
      index.items = index.items.filter((x) => x.id !== it.id);
      saveIndex(index);
    }
    return null;
  }

  /** 标记使用（更新 lastUsedAt/useCount），供淘汰策略与展示用。 */
  function markUsed(id) {
    const it = index.items.find((x) => x.id === id);
    if (!it) return false;
    it.useCount = (Number(it.useCount) || 0) + 1;
    it.lastUsedAt = nowMs();
    saveIndex(index);
    // 同时按**内容哈希**记一笔：条目可能很快被 pruneSent 删掉，
    // 只有 file（= md5 文件名）能跨删除标识"同一张图"。
    if (it.file) {
      recent.at[String(it.file)] = nowMs();
      saveRecent();
    }
    return true;
  }

  /**
   * 某张图是否在「刚发过」窗口内（供上层判断"要不要报没找到"时给更准的理由）。
   * @returns {{blocked:boolean, remainMs:number}}
   */
  function recentlySent(file, blockMs = defaultRecentBlockMs) {
    const t = Number(recent.at[String(file ?? '')]) || 0;
    if (!t) return { blocked: false, remainMs: 0 };
    const left = Number(blockMs) - (nowMs() - t);
    return left > 0 ? { blocked: true, remainMs: left } : { blocked: false, remainMs: 0 };
  }

  /**
   * 拒绝一张图：从图库删除文件 + 记入拒绝名单（**不再拉回**）。
   *
   * 用于群友给出负面评价（「不好看」「不是我要的」）时——把这张删掉，
   * 后续重拉也就不会再命中它。
   *
   * 为什么必须记名单而不是只删文件：`add()` 的去重靠 index 里的 id，
   * 删掉条目等于解除去重，下一次查询会把同一张又拉回来。
   *
   * @returns {{ok:boolean, id:string, reason?:string, freedBytes?:number}}
   */
  function reject(id, opts = {}) {
    const sid = String(id ?? '').trim();
    if (!sid) return { ok: false, id: '', reason: 'id 为空' };
    const it = index.items.find((x) => x.id === sid);
    let freed = 0;
    if (it) {
      freed = Number(it.bytes) || 0;
      // 先删文件再删索引：反过来若删文件失败，索引已没了会留下孤儿文件。
      try { fs.rmSync(path.join(libDir, it.file), { force: true }); } catch {}
      index.items = index.items.filter((x) => x.id !== sid);
      saveIndex(index);
    }
    if (!rejected.ids.includes(sid)) {
      rejected.ids.push(sid);
      rejected.at[sid] = Number(opts.now) || Date.now();
      saveRejected();
    }
    return { ok: true, id: sid, freedBytes: freed, existed: !!it, reason: String(opts.reason ?? '') };
  }

  /** 撤销拒绝（管理员改主意 / 名单误伤时用）。 */
  function unreject(id) {
    const sid = String(id ?? '').trim();
    const before = rejected.ids.length;
    rejected.ids = rejected.ids.filter((x) => x !== sid);
    delete rejected.at[sid];
    if (rejected.ids.length !== before) { saveRejected(); return true; }
    return false;
  }

  /**
   * 删除「已发出且超过 N 毫秒」的图（默认 10 分钟）。
   *
   * 为什么这样设计：
   *   - **只删已发过的**（useCount>0）：从未发过的图是候选池，删了就白拉了。
   *   - **留一段时间再删**（而非发完即删）：见下 —— 立刻删会让"同一角色再要一次"
   *     必然触发 5~30 秒的现拉等待。
   *   - 时间基准用 `lastUsedAt`：发过多次的图从**最后一次**发出算起，避免刚发完就被删。
   *
   * @param {number} ttlMs 保留时长（毫秒）
   * @param {{now?:number}} 便于测试注入时间
   * @returns {{removed:number, freedBytes:number}}
   */
  function pruneSent(ttlMs, opts = {}) {
    const ttl = Number(ttlMs);
    if (!Number.isFinite(ttl) || ttl <= 0) return { removed: 0, freedBytes: 0 };
    const now = Number(opts.now) || Date.now();
    const victims = index.items.filter((it) => Number(it.useCount) > 0
      && Number(it.lastUsedAt) > 0
      && now - Number(it.lastUsedAt) >= ttl);
    if (!victims.length) return { removed: 0, freedBytes: 0 };

    let freed = 0;
    const dropIds = new Set(victims.map((v) => v.id));
    for (const v of victims) {
      freed += Number(v.bytes) || 0;
      try { fs.rmSync(path.join(libDir, v.file), { force: true }); } catch {}
    }
    index.items = index.items.filter((it) => !dropIds.has(it.id));
    saveIndex(index);
    log(`已发图清理 ${victims.length} 张（发出超 ${Math.round(ttl / 60000)} 分钟），释放 ${(freed / 1048576).toFixed(1)}MB，余 ${index.items.length} 张`);
    return { removed: victims.length, freedBytes: freed };
  }

  /** 统计摘要（供 prompt/控制台展示）。 */
  function stats() {
    const bySource = {};
    for (const it of index.items) {
      const s = it.source || 'unknown';
      bySource[s] = (bySource[s] ?? 0) + 1;
    }
    const bytes = totalBytes();
    return {
      total: index.items.length,
      totalBytes: bytes,
      totalMB: Number((bytes / 1048576).toFixed(2)),
      maxFiles,
      maxTotalMB: Number((maxTotalBytes / 1048576).toFixed(1)),
      sent: index.items.filter((it) => Number(it.useCount) > 0).length,
      bySource
    };
  }

  /** 写入口味分（由调用方用 image-features + image-taste 算好后回填）。 */
  /** 写入口味分（由调用方用 image-features/image-style 算好后回填）。
   *  opts.defer=true 时不立即落盘——批量补算时应延迟到批末统一 save()，
   *  否则每张都重写整个索引（大库会慢且易触发文件竞态）。 */
  function setTaste(id, taste, opts = {}) {
    const it = index.items.find((x) => x.id === id);
    if (!it) return false;
    it.taste = Number(taste) || 0;
    if (!opts.defer) saveIndex(index);
    return true;
  }

  /** 显式落盘（配合 setTaste 的 defer 使用）。 */
  function save() {
    saveIndex(index);
  }

  /** 列出尚未算口味分的条目（供批量补算）。 */
  function listWithoutTaste(limit = 1000) {
    return index.items.filter((it) => !Number.isFinite(Number(it.taste))).slice(0, limit);
  }

  return { add, has, prune, pickRandom, markUsed, recentlySent, readBuffer, getById, count, stats, totalBytes, setTaste, save, pruneSent, listWithoutTaste, indexPath, libDir, reject, unreject, isRejected, rejectedStats };
}
