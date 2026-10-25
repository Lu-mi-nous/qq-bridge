// 消息管线 · OneBot 消息段 → 文本。
//
// 从 bridge.js 抽出的纯计算函数：只依赖传入的 resolveAtName / resolveReply 回调，
// 不读任何全局状态。解析规则（@、引用、图片/表情、分享卡片、转发、语音占位）集中在这里，
// 便于离线回归，也避免 bridge 主流程继续膨胀。
import { buildReplyText, extractQuotedMedia } from '../quoted-media.js';
import { parseShareCard, formatShareCard, coverUrlOf } from '../share-card.js';
import { forwardIdFromData } from '../forward.js';

/**
 * 把 OneBot 消息段数组转成可读文本。
 *
 * @param {Array|string} segments
 * @param {object} options
 * @param {(qq:string)=>Promise<string|null>} [options.resolveAtName] 群名片/昵称解析
 * @param {(messageId:string)=>Promise<object|null>} [options.resolveReply] 引用消息解析
 * @param {boolean} [options.includeReply=true] 是否包含引用段（false = 只看当前消息自己的文字）
 * @param {string} [options.mediaFetchHint] 引用消息里含图时的「怎么查看」说明
 */
export async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true, mediaFetchHint } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」；有图时再附「怎么看到它」。
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let info = null;
        if (resolveReply) {
          try { info = await resolveReply(String(d.id)); } catch {}
        }
        out.push(buildReplyText(info, mediaFetchHint));
        break;
      }
      case 'json': {
        // 分享卡片（B 站视频/小红书/音乐/位置等）：解析出标题、描述、真实链接、封面。
        // 解析不出内容时退回占位符（不编内容）。
        const card = parseShareCard(d.data);
        out.push(card ? formatShareCard(card) : '[卡片消息]');
        break;
      }
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

export function extractMediaFromSegments(segments) {
  const media = extractQuotedMedia(segments);
  const out = Array.isArray(media) ? [...media] : [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || seg.type !== 'json') continue;
    const card = parseShareCard(seg.data?.data);
    if (!card) continue;
    const cover = coverUrlOf(card);
    if (!cover) continue;
    out.push({
      kind: 'image',
      file: '',
      url: cover,
      subType: '',
      // 让模型知道这张图是卡片封面（而不是群友直接发的图）
      summary: `${card.platform || '分享'}卡片封面`,
      fromCard: true,
    });
  }
  return out;
}
