import assert from 'node:assert/strict';
import { imageSizeOf, looksLikeImageBuffer } from '../src/plugin-api/media.js';
import { looksLikeImageBuffer as compatibilityFormat } from '../src/safe-fetch.js';
import { imageSizeOf as compatibility } from '../src/image-downscale.js';
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
check('核心兼容导出使用同一实现', () => assert.equal(compatibility, imageSizeOf));
const png = Buffer.alloc(24); png.set([0x89, 0x50, 0x4e, 0x47]); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
check('读取 PNG 头尺寸', () => assert.deepEqual(imageSizeOf(png), { width: 640, height: 480 }));
const gif = Buffer.alloc(24); gif.write('GIF89a'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(240, 8);
check('读取 GIF 头尺寸', () => assert.deepEqual(imageSizeOf(gif), { width: 320, height: 240 }));
const jpeg = Buffer.alloc(24); jpeg.set([0xff, 0xd8, 0xff, 0xc0]); jpeg.writeUInt16BE(100, 7); jpeg.writeUInt16BE(200, 9);
check('读取 JPEG SOF 尺寸', () => assert.deepEqual(imageSizeOf(jpeg), { width: 200, height: 100 }));
check('截断输入不猜尺寸', () => assert.equal(imageSizeOf(png.subarray(0, 20)), null));
check('未知格式不猜尺寸', () => assert.equal(imageSizeOf(Buffer.alloc(30)), null));
check('格式识别与核心兼容入口一致', () => assert.equal(looksLikeImageBuffer, compatibilityFormat));
for (const [name, header] of [['PNG', png], ['GIF', gif], ['JPEG', jpeg], ['WebP', Buffer.from('RIFF0000WEBP')]]) {
  check(`识别 ${name} 文件头`, () => assert.equal(looksLikeImageBuffer(header), true));
}
check('截断文件头不接受', () => assert.equal(looksLikeImageBuffer(png.subarray(0, 4)), false));
check('未知格式不接受', () => assert.equal(looksLikeImageBuffer(Buffer.alloc(24)), false));
check('缺失输入不接受', () => assert.equal(looksLikeImageBuffer(null), false));
console.log(`${passed} 通过 / 0 失败`);
