// 回归测试：X 帖子视频的解析与档位选择（extractVideo / estimateVariantBytes / pickVideoVariant）。
//
// 背景（2026-10-10）：用户要求「抓取帖子中的视频一并发到群里，超过 100MB 除外」。
//
// 两个已踩的坑，都用测试钉住：
//   ① 变体里混着 m3u8（application/x-mpegURL）——不过滤会把播放列表当视频下载（几百字节文本，OneBot 拒收）。
//   ② **两处 variants 字段名不同且只有一处带 bitrate**：顶层 `video.variants[]` 是 {type,src} 无码率；
//      `mediaDetails[].video_info.variants[]` 是 {content_type,url,bitrate} 有码率。必须优先用后者。
//   ③ durationMs 是**毫秒**，按秒算会让体积放大 1000 倍 → 所有档位都被判超限 → 视频永远发不出来。
import { extractVideo, estimateVariantBytes, pickVideoVariant } from '../src/x-monitor/fetch.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// 真实结构（2026-10-10 抓 @mimi_3mi 的视频帖，时长 182.6 秒）
const REAL = {
  video: {
    aspectRatio: [16, 9],
    durationMs: 182613,
    poster: 'https://pbs.twimg.com/amplify_video_thumb/x.jpg',
    variants: [
      { type: 'application/x-mpegURL', src: 'https://video.twimg.com/x/pl/a.m3u8?v=cfc' },
      { type: 'video/mp4', src: 'https://video.twimg.com/x/vid/avc1/480x270/a.mp4' },
      { type: 'video/mp4', src: 'https://video.twimg.com/x/vid/avc1/640x360/b.mp4' },
      { type: 'video/mp4', src: 'https://video.twimg.com/x/vid/avc1/1280x720/c.mp4' },
      { type: 'video/mp4', src: 'https://video.twimg.com/x/vid/avc1/1920x1080/d.mp4' }
    ]
  },
  mediaDetails: [{
    type: 'video',
    video_info: {
      aspect_ratio: [16, 9],
      duration_millis: 182613,
      variants: [
        { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/x/pl/a.m3u8?v=cfc' },
        { bitrate: 256000, content_type: 'video/mp4', url: 'https://video.twimg.com/x/vid/avc1/480x270/a.mp4' },
        { bitrate: 832000, content_type: 'video/mp4', url: 'https://video.twimg.com/x/vid/avc1/640x360/b.mp4' },
        { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/x/vid/avc1/1280x720/c.mp4' },
        { bitrate: 10368000, content_type: 'video/mp4', url: 'https://video.twimg.com/x/vid/avc1/1920x1080/d.mp4' }
      ]
    }
  }]
};

console.log('── 解析：必须取到带 bitrate 的那份，并滤掉 m3u8 ──');
{
  const v = extractVideo(REAL);
  check('识别出视频', !!v);
  check('变体数为 4（滤掉 m3u8）', v.variants.length === 4, `${v.variants.length}`);
  check('没有 m3u8 混入', v.variants.every((x) => !/m3u8/.test(x.url)));
  check('带上了 bitrate（来自 video_info）', v.variants.every((x) => x.bitrate > 0), JSON.stringify(v.variants.map((x) => x.bitrate)));
  check('解析出分辨率', v.variants.some((x) => x.width === 1280 && x.height === 720));
  check('时长为毫秒值', v.durationMs === 182613, String(v.durationMs));
  check('按码率升序（便于挑档）', v.variants[0].bitrate < v.variants[v.variants.length - 1].bitrate);
}

console.log('\n── 只有顶层 video（无 bitrate）时也要能用 ──');
{
  const onlyTop = { video: REAL.video };  // 无 mediaDetails
  const v = extractVideo(onlyTop);
  check('仍能识别', !!v);
  check('变体数 4', v.variants.length === 4, `${v.variants.length}`);
  check('bitrate 为 0（顶层没有）', v.variants.every((x) => x.bitrate === 0));
  check('分辨率仍解析出来（用于兜底估算）', v.variants.every((x) => x.width > 0 && x.height > 0));
}

console.log('\n── 体积估算：毫秒不能被当成秒（曾放大 1000 倍）──');
{
  const v = extractVideo(REAL);
  const p480 = v.variants.find((x) => x.width === 480);
  const p1080 = v.variants.find((x) => x.width === 1920);
  const mb = (b) => b / 1024 / 1024;
  check('480p ≈ 5.6MB', Math.abs(mb(estimateVariantBytes(p480, v.durationMs)) - 5.6) < 0.3, mb(estimateVariantBytes(p480, v.durationMs)).toFixed(2) + 'MB');
  check('1080p ≈ 225.7MB', Math.abs(mb(estimateVariantBytes(p1080, v.durationMs)) - 225.7) < 3, mb(estimateVariantBytes(p1080, v.durationMs)).toFixed(1) + 'MB');
  // 反向断言：若把毫秒当秒，480p 会算成 ~5573MB
  check('没把毫秒当秒（否则会算出 5573MB）', mb(estimateVariantBytes(p480, v.durationMs)) < 100);
  check('无码率时用分辨率兜底（>0）', estimateVariantBytes({ width: 1280, height: 720, bitrate: 0 }, 182613) > 0);
  check('无时长返回 0', estimateVariantBytes(p480, 0) === 0);
}

console.log('\n── 挑档：尽量清晰但不超上限 ──');
{
  const v = extractVideo(REAL);
  const MB = 1024 * 1024;
  const p100 = pickVideoVariant(v, { maxBytes: 100 * MB });
  check('100MB 上限 → 选 720p（47MB）', p100?.width === 1280, JSON.stringify(p100 && { w: p100.width, est: (p100.estimatedBytes / MB).toFixed(1) }));
  const p20 = pickVideoVariant(v, { maxBytes: 20 * MB });
  check('20MB 上限 → 选 640x360（18MB）', p20?.width === 640, p20 && `${p20.width}x${p20.height} ${(p20.estimatedBytes / MB).toFixed(1)}MB`);
  const p6 = pickVideoVariant(v, { maxBytes: 6 * MB });
  check('6MB 上限 → 选 480x270（5.6MB）', p6?.width === 480, p6 && `${p6.width} ${(p6.estimatedBytes / MB).toFixed(1)}MB`);
  const p1 = pickVideoVariant(v, { maxBytes: 1 * MB });
  check('1MB 上限 → 全部超限，返回 null（跳过）', p1 === null);
  check('null 视频返回 null', pickVideoVariant(null) === null);
  check('无变体返回 null', pickVideoVariant({ variants: [] }) === null);
}

console.log('\n── 边界与安全 ──');
{
  check('无视频字段返回 null', extractVideo({}) === null);
  check('null 不抛', extractVideo(null) === null);
  check('undefined 不抛', extractVideo(undefined) === null);
  check('mediaDetails 非视频返回 null', extractVideo({ mediaDetails: [{ type: 'photo' }] }) === null);
  check('只有 m3u8 时返回 null（不能把播放列表当视频）', extractVideo({
    video: { variants: [{ type: 'application/x-mpegURL', src: 'https://x/a.m3u8' }] }
  }) === null);
  check('默认上限是 100MB', (() => {
    const v = extractVideo(REAL);
    return pickVideoVariant(v)?.width === 1280;   // 默认 100MB → 720p
  })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
