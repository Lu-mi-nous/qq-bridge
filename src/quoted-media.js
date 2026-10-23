/**
 * 引用（回复）消息里的图片处理。
 *
 * 背景：原先 `resolveReplyInfo` 只取被引用消息的 sender+text，**把图片段丢掉了**，
 * 于是模型看到的是 `[引用 某人：[图片]]`——它无法据此取图，「回复一张图并问这是什么」
 * 这种最常见的用法直接失效（实测机器人看不到别人引用的图）。
 *
 * 本模块提供两块纯逻辑（便于离线回归）：
 *   1. `extractQuotedMedia()`：从被引用消息的段里数出图片/表情
 *   2. `buildReplyText()`：拼「[引用 人：原文]」并在有图时附上取图提示
 */

/** 从 OneBot 消息段提取图片/表情元数据（不下载字节，仅记录定位信息）。 */
export function extractQuotedMedia(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      const file = String(d.file ?? '');
      const url = String(d.url ?? '');
      // 既无 file 也无 url 的段取不到图，不算数（否则会给模型一个必然失败的提示）
      if (!file && !url) continue;
      media.push({ kind: 'image', file, url, subType: d.subType != null ? String(d.subType) : '', summary: String(d.summary ?? '') });
    } else if (seg.type === 'face') {
      const fid = d.id;
      if (fid == null || String(fid) === '') continue;
      media.push({ kind: 'face', faceId: String(fid) });
    }
  }
  return media;
}

/**
 * 拼引用段文案。
 *
 * @param {{sender?:string, text?:string, messageId?:string, mediaCount?:number}} info
 * @param {(messageId:string, count:number)=>string|null} [mediaFetchHint]
 *   取图提示生成器；返回 null/空表示"本模式取图方式不适用"（则退回只报事实）
 * @returns {string} 形如 `[引用 群友O：[图片]]（被引用的这条消息含 1 个图片/表情，…）`
 */
export function buildReplyText(info, mediaFetchHint = null) {
  let replyText = '';
  if (info?.sender || info?.text) {
    const parts = [];
    if (info.sender) parts.push(info.sender);
    if (info.text) parts.push(info.text);
    replyText = `[引用 ${parts.join('：')}]`;
  }
  const n = Number(info?.mediaCount) || 0;
  if (n > 0) {
    const mid = info?.messageId ? String(info.messageId) : '';
    const hint = mid && typeof mediaFetchHint === 'function' ? mediaFetchHint(mid, n) : '';
    // 提示生成器没给（或没有 messageId）时**至少要报事实**，
    // 让模型/日志知道这条引用里确实有图，而不是无声无息。
    replyText += hint || `（被引用的这条消息含 ${n} 个图片/表情${mid ? `，消息ID=${mid}` : ''}）`;
  }
  // 被引用的是一条**合并转发**时，把 id 直接摆出来。
  //
  // 事故（2026-10-22）：群友引用了一条「群聊的聊天记录」问「这个是什么」，
  // 机器人答「那条转发鱼打不开，id对不上」——它压根没拿到 id，只好编个理由。
  // forward 段以前在 buildReplyText 里被完全忽略（只处理 mediaCount）。
  const fids = Array.isArray(info?.forwardIds) ? info.forwardIds.filter(Boolean) : [];
  if (fids.length) {
    replyText += `（被引用的这条消息是一条合并转发，id=${fids.join(',')}。`
      + `要看内容请调用 mcp__snowluma__qq_get_forward_msg，参数 id 直接用上面的值）`;
  }
  return replyText || '[引用消息]';
}

/** reserved2 的取图提示（图片不自动内联，需模型按需调用工具）。 */
export function reserved2MediaFetchHint(key) {
  return (mid, n) => `（被引用的这条消息含 ${n} 个图片/表情。要看到它请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${mid}"）`;
}

/** 其他模式（图片会自动内联）只报事实即可。 */
export function inlineMediaFactHint() {
  return (mid, n) => `（被引用的这条消息含 ${n} 个图片/表情${mid ? `，消息ID=${mid}` : ''}）`;
}
