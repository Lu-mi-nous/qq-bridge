// R3-10 媒体服务：MIME/尺寸解析、OneBot 图片与表情、媒体列表。
import { createMediaService } from '../src/media-service.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const png = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
png.writeUInt32BE(2, 16);
png.writeUInt32BE(3, 20);

const bot = {
  getImage: async () => ({ data: 'base64://' + png.toString('base64') }),
  fetchFaceEntity: async () => ({ q_des: '笑脸' })
};
const service = createMediaService({ cfg: { socialV2: {} }, bot, log: () => {} });

console.log('── 1. MIME / 尺寸 ──');
{
  check('PNG MIME', service.mimeFromBuffer(png) === 'image/png');
  check('URL MIME', service.mimeFromUrl('https://x/a.webp') === 'image/webp');
  const dims = service.getImageDimensions(png);
  check('PNG 尺寸', dims.width === 2 && dims.height === 3);
  check('非图片返回 null', service.getImageDimensions(Buffer.from('not an image')) === null);
}

console.log('\n── 2. OneBot 图片 / 表情 ──');
{
  const img = await service.fetchOneBotImage({ kind: 'image', file: 'safe.png' });
  check('从 get_image base64 取图', img?.buffer?.length === 24 && img.mimeType === 'image/png');
  const bad = await service.fetchOneBotImage({ kind: 'image', file: '../etc/passwd' });
  check('不安全 file 不交给网关', bad === null);
  const face = await service.fetchFaceMedia({ faceId: 1 });
  check('表情返回描述文本', face.text.includes('笑脸'));
}

console.log('\n── 3. 媒体列表 ──');
{
  const parts = await service.resolveMediaList([{ kind: 'face', faceId: 1 }]);
  check('表情列表返回文本', parts.some((p) => p.type === 'text' && p.text.includes('笑脸')));
  const out = await service.fetchMediaData([{ kind: 'face', faceId: 1 }]);
  check('fetchMediaData 返回表情条目', out[0]?.kind === 'face' && out[0]?.text.includes('笑脸'));
  const empty = await service.resolveMediaList([]);
  check('空列表返回空数组', Array.isArray(empty) && empty.length === 0);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
