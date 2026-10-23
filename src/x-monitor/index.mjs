// x-monitor/index.mjs — 按需拉取 X（Twitter）帖子并渲染成卡片
//
// 设计变更（2026-10-04）：**取消定时推送**，改为群友在群里点名时由 AI 主动调用。
//   旧行为：定时轮询固定账号 → 有新帖就推到群（已在 config.xMonitor.enabled 下停用）。
//   新行为：AI 通过 MCP 工具 qq_fetch_x_posts(handle, count|date) 现场拉取 → 渲染 → 发图。
//
// 因此本模块不再持有定时器，只暴露两个方法：
//   - resolveUser(handleOrName)  校验账号是否存在，返回昵称/头像（供 AI 确认找对人）
//   - fetchAndRender(...)        拉帖 → 翻译 → 渲染，返回可直接发送的 PNG 缓冲
import fs from 'node:fs';
import path from 'node:path';
import { fetchPosts, fetchProfile, pickVideoVariant } from './fetch.mjs';
import { loadAuth, describeAuth, fetchPostsAuth, resolveUserId } from './auth-fetch.mjs';
import { renderPostImage } from './render.mjs';
import { createTranslator } from './translate.mjs';
import { createMediaCache } from './media-cache.mjs';

const DEFAULTS = {
  proxy: '',           // 留空则继承 socialV2.images.proxy
  translate: true,     // 是否附中文翻译
  gatewayUrl: '',      // 翻译网关（留空用 http://127.0.0.1:7863/v1）
  translateModel: '',  // 翻译模型（留空用 cn:deepseek-v4.1-flash）
  maxCount: 5,         // 单次最多拉几条（防止一次拉太多刷屏/超时）
  scanLimit: 12,       // 主页最多扫多少条
  includeMedia: true,  // 是否把帖子配图渲染进卡片
  includeVideo: true,  // 是否把帖子里的视频也发出来（作为独立消息，见 bridge.js 的 onebotSendVideoFile）
  maxVideoBytes: 100 * 1024 * 1024,   // 视频体积上限，超过就整条跳过并说明（用户要求 100MB）
  mediaDir: 'state/x-monitor-media',  // 配图缓存目录（相对项目根）
  mediaTtlMs: 2 * 60 * 60 * 1000,     // 缓存 2 小时
  mediaSweepMs: 5 * 60 * 1000,        // 每 5 分钟清理一次
  mediaMaxBytes: 200 * 1024 * 1024,   // 缓存总量上限
  mediaMaxFiles: 400                  // 缓存文件数上限
};

export class XMonitor {
  /**
   * @param {object} opts
   *   - root  项目根目录（用于读 config.json / 写 state）
   *   - log   日志函数
   */
  constructor({ root, log = () => {} } = {}) {
    this.root = root;
    this.log = log;
    this.configPath = path.join(root, 'config.json');
    this.cfgCache = { mtimeMs: -1, cfg: null };
    this.translator = null;
  }

  /** 配置（mtime 热加载）。 */
  loadConfig() {
    try {
      const st = fs.statSync(this.configPath);
      if (!this.cfgCache.cfg || st.mtimeMs !== this.cfgCache.mtimeMs) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        const xm = raw.xMonitor ?? {};
        const imagesProxy = raw.socialV2?.images?.proxy ?? '';
        this.cfgCache = {
          mtimeMs: st.mtimeMs,
          cfg: {
            ...DEFAULTS,
            ...xm,
            proxy: String(xm.proxy ?? '').trim() || String(imagesProxy).trim()
          }
        };
      }
      return this.cfgCache.cfg;
    } catch {
      return { ...DEFAULTS };
    }
  }

  _translator(cfg) {
    if (!this.translator) {
      this.translator = createTranslator({
        statePath: path.join(this.root, 'state', 'x-monitor-translations.json'),
        gatewayUrl: String(cfg.gatewayUrl || '').trim() || undefined,
        model: String(cfg.translateModel || '').trim() || undefined,
        log: this.log
      });
    }
    return this.translator;
  }

  /** 帖子配图缓存（懒初始化，并把定期清理定时器挂上）。 */
  _mediaCache(cfg) {
    if (!this.mediaCache) {
      const dir = String(cfg.mediaDir || '').trim() || 'state/x-monitor-media';
      this.mediaCache = createMediaCache({
        root: this.root,
        dir,
        ttlMs: Math.max(60_000, Number(cfg.mediaTtlMs) || 2 * 60 * 60 * 1000),
        sweepMs: Math.max(30_000, Number(cfg.mediaSweepMs) || 5 * 60 * 1000),
        maxBytes: Math.max(1 << 20, Number(cfg.mediaMaxBytes) || 200 * 1024 * 1024),
        maxFiles: Math.max(10, Number(cfg.mediaMaxFiles) || 400),
        proxy: cfg.proxy,
        log: this.log
      });
      this.mediaCache.start();
    }
    return this.mediaCache;
  }

  /** 供控制台/诊断：缓存用量与翻译缓存条数。 */
  stats() {
    const cfg = this.loadConfig();
    let media = { files: 0, bytes: 0, dir: '' };
    try {
      media = this.mediaCache ? this.mediaCache.stats() : this._mediaCache(cfg).stats();
    } catch {}
    return { media, translate: cfg.translate !== false, includeMedia: cfg.includeMedia !== false };
  }

  /**
   * 校验账号是否存在，返回资料。找不到返回 null。
   * @param {string} handleOrName 形如 thsottiaux 或 @thsottiaux
   */
  async resolveUser(handleOrName) {
    const cfg = this.loadConfig();
    const h = String(handleOrName ?? '').trim().replace(/^@/, '');
    if (!h || !/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
    // 优先用登录态校验账号：免登录的 og:meta 抓取会被限频（实测间歇返回 null，
    // 表现为「找不到用户」，把存在的好账号也判成不存在）。登录态走 GraphQL，稳定得多。
    const auth = loadAuth({ root: this.root });
    if (auth) {
      try {
        const u = await resolveUserId(h, { proxy: cfg.proxy, auth });
        return { handle: u.handle, name: u.name, bio: u.bio, avatar: u.avatar };
      } catch (e) {
        // 账号确实不存在时（而非凭据问题）直接返回 null
        if (/账号不可用|找不到/.test(e?.message ?? '')) return null;
        // 凭据/网络问题：回退免登录。**但要记下原因**——免登录被限频时也返回 null，
        // 若不留痕，上层就会把「网络抖动」误报成「账号不存在」（实测踩过：
        // 一次 TLS 抖动 + 免登录限频 → 报「找不到 @miratsu169」，而账号明明存在）。
        this.log(`[x-monitor] 登录态校验账号失败（${e?.kind ?? 'unknown'}）：${e?.message ?? e}；回退免登录`);
        this._lastResolveFallback = e?.message ?? String(e);
      }
    }
    const viaProfile = await fetchProfile(h, { proxy: cfg.proxy });
    if (!viaProfile && this._lastResolveFallback) {
      // 免登录也没拿到：抛错说明是**网络/凭据问题**，别让上层报成"账号不存在"
      const err = new Error(`无法校验 @${h}：登录态失败（${this._lastResolveFallback}），免登录也拿不到（可能被限频）。这多半是网络或凭据问题，不代表账号不存在`);
      err.kind = 'resolve-unavailable';
      throw err;
    }
    return viaProfile;
  }

  /** 登录凭据状态（不含凭据值，供控制台自检展示）。 */
  describeAuth() {
    return describeAuth({ root: this.root });
  }

  /**
   * 真发一次请求验证凭据是否有效（凭据存在 ≠ 有效：改密码/登出会立刻失效）。
   * 用一个不存在的探针账号调接口：能区分「凭据失效(401)」「端点变更(404)」「网络不通」。
   */
  async verifyAuth() {
    const cfg = this.loadConfig();
    const auth = loadAuth({ root: this.root });
    if (!auth) return { ok: false, reason: '凭据文件不存在或字段不全' };
    try {
      await resolveUserId('x', { proxy: cfg.proxy, auth });
      return { ok: true, note: '凭据有效（能正常调用 X 接口）' };
    } catch (e) {
      // 「找不到该账号」说明凭据是好的（请求被正常处理了），只是探针账号不存在
      if (/找不到|账号不可用/.test(e?.message ?? '')) return { ok: true, note: '凭据有效（能正常调用 X 接口）' };
      return { ok: false, kind: e?.kind ?? 'unknown', error: e?.message ?? String(e) };
    }
  }

  /**
   * 按需拉取并渲染。
   *
   * @param {string} handle  账号（不带 @）
   * @param {object} opts
   *   - count    要几条（默认 1，受 maxCount 限制）
   *   - sinceMs / untilMs  指定时间范围（指定日期用）
   *   - maxAgeMs 相对时间（如最近 24 小时）
   *   - translateOverride  强制开关翻译
   * @returns {Promise<{ok, user, posts:[{post, image}], errors:[]}>}
   */
  async fetchAndRender(handle, opts = {}) {
    const cfg = this.loadConfig();
    const h = String(handle ?? '').trim().replace(/^@/, '');
    const result = { ok: false, user: null, posts: [], errors: [], handle: h, pinnedSkipped: 0, videoSkipped: [] };

    let profile;
    try {
      profile = await this.resolveUser(h);
    } catch (e) {
      // 网络/凭据问题（而非账号不存在）——如实说明，别误报成"账号不存在"
      result.errors.push(e?.message ?? String(e));
      return result;
    }
    if (!profile) {
      result.errors.push(`找不到 X 用户 @${h}（可能账号名拼错、账号不存在或已注销）`);
      return result;
    }
    result.user = profile;

    const wantCount = Math.max(1, Math.min(Number(cfg.maxCount) || 5, Number(opts.count) || 1));
    // 抓取方式：**有登录凭据就翻历史**（能精确到某一天），没有则回退免登录
    // （免登录只看得到最近几条，约两周内）。凭据在 state/x-auth.json。
    let fetched;
    const auth = loadAuth({ root: this.root });
    if (auth) {
      try {
        fetched = await fetchPostsAuth(h, {
          proxy: cfg.proxy,
          auth,
          limit: wantCount,
          sinceMs: opts.sinceMs,
          untilMs: opts.untilMs,
          ownOnly: cfg.ownOnly !== false,
          maxPages: Math.max(1, Number(cfg.authMaxPages) || 8),
          gapMs: Math.max(0, Number(cfg.authPageGapMs) || 1200)
        });
        result.viaAuth = true;
      } catch (e) {
        // 凭据失效（401）/端点变更（404）都会走到这里。**不静默降级**：
        // 把原因如实带出去，让管理员能修；同时仍尝试免登录兜底，尽量给出结果。
        result.authError = e?.message ?? String(e);
        this.log(`[x-monitor] 登录态抓取失败（${e?.kind ?? 'unknown'}）：${result.authError}；回退免登录`);
        fetched = null;
      }
    }
    if (!fetched) {
      try {
        fetched = await fetchPosts(h, {
          proxy: cfg.proxy,
          limit: wantCount,
          sinceMs: opts.sinceMs,
          untilMs: opts.untilMs,
          maxAgeMs: opts.maxAgeMs,
          ownOnly: cfg.ownOnly !== false,   // 默认跳过转推（主页列表含转推，会把别人的帖子当成他的发出去）
          skipPinned: cfg.skipPinned !== false, // 默认跳过置顶帖（它排在主页最前，但可能是几个月前的）
          // 扫描余量要留够：跳过转推/超龄项后还要继续往后找，否则可能凑不满 wantCount
          scanLimit: Math.max(Number(cfg.scanLimit) || 12, wantCount * 3)
        });
      } catch (e) {
        result.errors.push(`拉取 @${h} 的帖子失败：${e?.message ?? e}`);
        return result;
      }
    }
    result.pinnedSkipped = Number(fetched.skippedPinned) || 0;
    result.oldestMs = Number(fetched.oldestMs) || 0;

    if (!fetched.posts.length) {
      // 免登录抓取只看得到账号主页**最近几条**（实测 6 条左右，最早约两周前），
      // 用登录态时能翻到很早，所以「没找到」多半是**那天真没发帖**；
      // 免登录时则多半是「翻不到那么远」。两种情况说法不同，别混为一谈。
      const oldest = Number(fetched.oldestMs) || 0;
      if (fetched.viaAuth) {
        result.errors.push(`@${h} 在指定时间范围内没有发帖（已翻到 ${new Date(oldest).toLocaleDateString('sv-SE')} 附近，共 ${fetched.scanned} 条）`);
      } else {
        const reach = oldest ? `；这个账号免登录最多只能翻到 ${new Date(oldest).toLocaleDateString('sv-SE')} 前后（主页只列出最近 ${fetched.totalIds} 条）` : '';
        result.errors.push(`@${h} 在指定时间范围内没有找到帖子${reach}。要更早的帖子需要登录态，目前拿不到。`);
      }
      return result;
    }

    const useTrans = opts.translateOverride !== undefined ? opts.translateOverride !== false : cfg.translate !== false;

    for (const post of fetched.posts) {
      let translation = '';
      if (useTrans) {
        try {
          translation = await this._translator(cfg).translate(post.text, { id: post.id });
        } catch (e) {
          result.errors.push(`翻译 ${post.id} 失败：${e?.message ?? e}`);
        }
      }
      // 帖子配图：下载到本地缓存（同图复用），再连同卡片一起渲染。
      // 图片失败不影响卡片本体（renderPostImage 会跳过缺失的 media）。
      let mediaFiles = [];
      if (cfg.includeMedia !== false && Array.isArray(post.media) && post.media.length) {
        try {
          const got = await Promise.all(
            post.media.slice(0, 4).map((m) => this._mediaCache(cfg).get(m.url))
          );
          mediaFiles = got.filter(Boolean);
          if (mediaFiles.length < post.media.length) {
            result.errors.push(`${post.id}: ${post.media.length - mediaFiles.length} 张配图下载失败`);
          }
        } catch (e) {
          result.errors.push(`${post.id}: 配图处理失败 ${e?.message ?? e}`);
        }
      }
      let img = null;
      try {
        img = await renderPostImage(post, { translation, proxy: cfg.proxy, media: mediaFiles, log: this.log });
      } catch (e) {
        result.errors.push(`渲染 ${post.id} 失败：${e?.message ?? e}`);
      }

      // 帖子视频：挑一档清晰度（默认不超过 maxVideoBytes，超限则整条跳过并说明）。
      // 视频要作为**独立消息**发（SnowLuma 要求 video 段必须是消息里唯一的段），
      // 所以这里只负责下载+返回文件路径，发送由调用方在卡片之后单独做。
      let videoFile = null;
      if (cfg.includeVideo !== false && post.video) {
        try {
          const maxBytes = Math.max(1, Number(cfg.maxVideoBytes) || 100 * 1024 * 1024);
          const picked = pickVideoVariant(post.video, { maxBytes });
          if (!picked) {
            const dur = post.video.durationMs ? `（时长 ${Math.round(post.video.durationMs / 1000)} 秒）` : '';
            result.videoSkipped.push({
              id: post.id,
              reason: `所有清晰度都超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限${dur}`
            });
          } else {
            const got = await this._mediaCache(cfg).getVideo(picked.url, { maxBytes });
            // 下载后再按**真实大小**复核一次：估算可能偏低（尤其码率缺失时），
            // 真下回来超限就不发，避免把超限视频推给 OneBot 被拒或撑爆内存。
            if (got && got.bytes > maxBytes) {
              result.videoSkipped.push({
                id: post.id,
                reason: `实际大小 ${(got.bytes / 1024 / 1024).toFixed(1)}MB 超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`
              });
            } else if (got) {
              videoFile = { ...got, width: picked.width, height: picked.height, durationMs: post.video.durationMs };
            } else {
              result.errors.push(`${post.id}: 视频下载失败`);
            }
          }
        } catch (e) {
          result.errors.push(`${post.id}: 视频处理失败 ${e?.message ?? e}`);
        }
      }

      if (img) result.posts.push({ post, image: img, video: videoFile });
    }

    result.ok = result.posts.length > 0;
    return result;
  }
}

// 兼容旧代码里可能存在的 start/stop 调用（现已无定时行为）
export function createXMonitor(opts) {
  return new XMonitor(opts);
}
