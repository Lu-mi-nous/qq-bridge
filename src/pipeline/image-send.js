// 图库挑选、按需拉取、发送与成功记账。
import fs from 'node:fs';
import path from 'node:path';
import { resolveTagName as defaultResolveTagName, sourcePageOf } from '../images-api.js';

export function createImageSender(deps) {
  const {
    cfg, imagesEnabled, imageSendAllowed, sourcesWithHint, imageStore, sourceFilterForPick,
    groupImageOpts, refreshImageLib, live, imageAnnotation, recordSentMessage, onebotSend,
    log, lastSentImage, imageSendTimes, sendQueue,
    fetchImpl = fetch, resolveTagName = defaultResolveTagName
  } = deps;
  function sendImageV2(key, options = {}) {
    return sendQueue.enqueue(key, () => sendImage(key, options));
  }

  async function sendImage(key, options) {
    if (!imagesEnabled()) throw new Error('图库未启用（config.socialV2.images.enabled）');
    const startedAt = Date.now(); // 用于回传耗时（让模型知道哪些查询"重"）
    let gate = imageSendAllowed(key, { fromFeedback: options._fromFeedback === true });
    if (!gate.ok) throw new Error(gate.error);

    const wantTags = Array.isArray(options.tags) ? options.tags.filter(Boolean) : [];
    // 限定的图源（群主说「从 pixiv 找」时）：本地挑选与现拉都要限制，
    // 否则会返回别的站的图（也可能把别的站的图拉进库）。
    // 模型没传时就吃会话记忆（实测模型经常漏传这个参数）。
    const wantSources = sourcesWithHint(key, options.sources);

    // 取图策略：本地优先 → 未命中就按需回源拉取 → 再取一次。
    // 「按需查询」是这里的核心：群友要「猫」而库里没有时，不该只回一句「没有」，
    // 而应去图源按 cat 标签现拉几张入库再发。日榜/热门同理（order+maxAgeDays）。
    //
    // 差评换图跳过「10 分钟内不重复发」：那张刚被拒的图已经移出图库，
    // 剩下能选的本来就不可能是它。若还按 10 分钟窗口拦，只有一张图可用的角色
    // 会直接报"都发过了"而换不出图——那是把"防重复"变成了"不许换"。
    const recentOpt = options._fromFeedback === true ? { blockRecentMs: 0 } : {};
    let picked = imageStore.pickRandom({ tags: wantTags, ...sourceFilterForPick(wantSources), ...groupImageOpts(), ...recentOpt });
    let fetchedNow = 0;
    let fetchErrors = [];
    // 标签纠错信息：本地命中时也要有（否则 notice 缺失，模型不知道实际查的是哪个词）。
    // 做法是先算一次纠错结果，拉取路径再覆盖成实际那次的值。
    let corrections = [];
    if (wantTags.length) {
      try {
        for (const t of wantTags) {
          const r = await resolveTagName(t);
          if (r && !r.exact && r.postCount > 0) corrections.push({ from: t, to: r.name, postCount: r.postCount });
        }
      } catch { /* 纠错是增强，失败不影响取图 */ }
    }
    if (!picked) {
      const r = await refreshImageLib({
        // 按需查询时绕过冷却：用户正等着，但限定拉取量避免打爆图源
        force: true,
        tags: wantTags,
        // 按需现拉**只拉够用就好**，不要用补货用的 fetchPerRun（默认 20）。
        // 为什么：pixiv 每张要"逐个探测扩展名(1.5~4s) + 经代理下载(7~22s)"，
        // 实测约 10~25 秒/张——拉 20 张就是 3~8 分钟，期间模型完全静默、不能回话，
        // 群主看到的就是「又不理人了」（实测 3 分钟无响应后模型超时重试）。
        // 一条消息只发 1 张，所以按需拉 4 张足够（还留了替换余地：群像降权、
        // 拒过的图、扩展名探测失败等都可能让个别条目不可用）。
        limit: Math.max(1, Number(cfg.socialV2.images?.ondemandFetchCount) || 4),
        order: options.order,
        maxAgeDays: options.maxAgeDays,
        // 限定图源：只去指定站点现拉（否则会拉回别的站的图）
        sources: wantSources.requested ? (wantSources.valid.length ? wantSources.valid : []) : undefined
      }).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
      if (r?.ok && r.added) fetchedNow = r.added;
      // 把上游的失败原因带出来：里面含「上游存在的相近标签」提示，
      // 是模型自我纠正的关键线索（否则它只能反复瞎换词）。
      if (Array.isArray(r?.errors) && r.errors.length) fetchErrors = r.errors;
      // 拉取路径的纠错更权威（是真正执行查询时算出来的），覆盖前置估算。
      if (Array.isArray(live.lastFetchCorrections) && live.lastFetchCorrections.length) {
        corrections = live.lastFetchCorrections.slice();
      }
      picked = imageStore.pickRandom({ tags: wantTags, ...sourceFilterForPick(wantSources), ...groupImageOpts(), ...recentOpt });
    }
    if (!picked) {
      // 「10 分钟内发过」的图被硬过滤掉了，可能就是这个角色可用的都刚发过。
      // 这种情况不能报"没找到"——会让模型以为这角色库里没有，进而换词乱搜。
      // 要告诉它"是刚发过、再等等"，它才知道该怎么回应群友。
      // 换图路径（_fromFeedback）本来就跳过这层，所以不必再判。
      const blocked = (options._fromFeedback !== true && Array.isArray(wantTags) && wantTags.length)
        ? imageStore.pickRandom({
            tags: wantTags,
            ...sourceFilterForPick(wantSources),
            ...groupImageOpts(),
            blockRecentMs: 0 // 关掉本层，看看"是不是只因为刚发过才没得选"
          })
        : null;
      if (blocked) {
        const windowSec = Math.round(
          Math.max(0, Number(cfg.socialV2?.images?.recentSendBlockMs ?? 10 * 60 * 1000)) / 1000);
        throw new Error(
          `「${wantTags.join('/')}」的图在最近 ${Math.round(windowSec / 60)} 分钟内都发过了`
          + `（用户要求同一张图不要重复发）。库里还有别的候选但都在冷却中，`
          + `可以等几分钟再发，或换个角色/主题。**不要**告诉群友"没有这个角色的图"。`
        );
      }
      const base = wantTags.length
        ? `没找到「${wantTags.join('/')}」相关的图（已按需拉取${fetchedNow ? `，新入库 ${fetchedNow} 张` : '，未拉到新图'}）`
        : '图库里没有可用的图，先让管理员刷新一次图库';
      // 把标签提示附上（去掉图源名前缀，避免噪音）
      const hint = fetchErrors
        .map((e) => String(e).replace(/^[a-z_]+:\s*/i, ''))
        .filter((e) => e.includes('相近标签'))
        .join('；');
      // 画师查不到时的专用提示。措辞要克制：**不能断言画师不存在**——
      // 实测 pixiv 按画师名搜图是标签匹配，对确认存在的画师（村カルキ/大津/霧月）
      // 同样返回 0 条，所以「搜不到」推不出「没这人」。只说明限制并给出可靠替代。
      const artistNames = wantTags
        .filter((t) => /^(artist|user):/i.test(String(t)))
        .map((t) => String(t).replace(/^(artist|user):\s*/i, ''));
      // 示例数字 ID：查询本身是数字就沿用，否则给个格式样例
      const idExample = artistNames.find((n) => /^\d+$/.test(n)) ?? '12345678';
      const artistHint = artistNames.length
        ? `。注意：搜不到不代表该画师不存在——pixiv 的作品搜索按标签匹配，画师名常常不是自己作品的标签，实测对确认存在的画师也可能 0 条。别连续换拼写硬试。可靠做法：让群友给 pixiv 主页链接（原样传即可，如 https://www.pixiv.net/users/${idExample}）或数字 ID（artist:${idExample}），桥接会直接按 ID 取图；或改用 safebooru/yande.re（这两个源按画师名搜是可靠的）`
        : '';
      throw new Error(hint ? `${base}。${hint}${artistHint}` : `${base}${artistHint}`);
    }

    // 首轮问 web 工具/GIF 抽帧都不适用于本地图：这里直接把本地文件路径交给 OneBot，
    // 由 SnowLuma 读本地文件上传（避免把整张图 base64 过一遍 HTTP）。
    const [kind, id] = key.split(':');
    const abs = path.join(imageStore.libDir, picked.entry.file);
    // 兜底校验：路径必须在图库目录内（防元数据被污染成任意路径读取）
    const relative = path.relative(path.resolve(imageStore.libDir), path.resolve(abs));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('图库路径越界，已拒绝发送');
    }
    if (!fs.existsSync(abs)) throw new Error('图片文件丢失，已从图库移除');

    const segments = [];
    if (options.replyToMessageId != null && String(options.replyToMessageId).trim() !== '') {
      // 上游端点已把 seq 解析成真实 messageId（见 resolveReplyTargetV2），这里只做格式校验
      const rid = String(options.replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    segments.push({ type: 'image', data: { file: `file://${abs}` } });
    // 出处标注单独作为一条文字消息，避免「图文混排」在 QQ 上的显示问题。
    const ann = imageAnnotation(picked.entry);

    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 拉取可能耗时；真正发送前重新检查暂停/模式/额度，避免使用过时的准入结果。
    if (!imagesEnabled()) throw new Error('图库未启用（config.socialV2.images.enabled）');
    gate = imageSendAllowed(key, { fromFeedback: options._fromFeedback === true });
    if (!gate.ok) throw new Error(gate.error);
    const res = await fetchImpl(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`发图失败: ${body.wording || body.retcode || res.status}`);
    }
    recordSentMessage(key, body.data, `［图库图片］${picked.entry.id.slice(0, 16)}`);
    if (ann) {
      // 标注失败不影响图已发出的事实
      try { await onebotSend(kind, id, ann); } catch (error) { log(`图库来源标注发送失败: ${error?.message ?? error}`); }
    }
    imageStore.markUsed(picked.entry.id);
    // 记下这张图是本会话最近发出的：群友之后说「不好看」时要能定位到它。
    lastSentImage.set(key, { id: picked.entry.id, tags: wantTags, at: Date.now(), entry: picked.entry });
    const times = gate.times;
    times.push(Date.now());
    imageSendTimes.set(key, times);
    live.lastFetchCorrections = [];
    // 记下这次是否走了现拉、花了多久：回给模型，让它知道哪些词"重"，
    // 下次对这类词可以先回一句再发（同一会话内避免反复触发长等待）。
    const elapsedMs = Date.now() - startedAt;
    return {
      sent: true,
      entry: picked.entry,
      annotation: ann,
      // 来源信息单列出来，方便模型被问「这图哪来的」时直接回答：
      //   originUrl  画师的原始发布处（多为 x.com/twitter 原帖）
      //   sourcePage 图源站点上这张图的条目页
      //   source     图源站名（safebooru / pixiv / yandere）
      source: picked.entry.source,
      artist: picked.entry.artist || '',
      originUrl: picked.entry.page || '',
      sourcePage: sourcePageOf(picked.entry),
      fetchedNow,
      tookMs: elapsedMs,
      ...(fetchedNow > 0 && elapsedMs > 3000
        ? { note: `这次是现拉的，花了 ${(elapsedMs / 1000).toFixed(1)} 秒（新入库 ${fetchedNow} 张）。下次要同一个词通常很快（已在本地库）。` }
        : {}),
      ...(corrections.length ? { tagCorrections: corrections } : {})
    };
  }


  return { sendImageV2 };
}
