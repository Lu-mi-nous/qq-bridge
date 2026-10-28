// 只创建空文件验证查找规则，不运行二进制、不依赖本机安装。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as api from '../src/plugin-api/process.js';
import * as gif from '../src/gif-frames.js';
import * as upscale from '../src/upscale-bin.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-public-process-'));
const oldPath = process.env.PATH;
try {
  const a = path.join(tmp, 'first'), b = path.join(tmp, 'second');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const dir of [a, b]) for (const name of ['ffmpeg', 'ffprobe', 'upscayl-bin']) fs.writeFileSync(path.join(dir, name + ext), '');
  process.env.PATH = [a, b].join(path.delimiter);
  check('核心兼容入口共用实现', () => {
    assert.equal(api.findFfmpeg, gif.findFfmpeg);
    assert.equal(api.findFfprobe, gif.findFfprobe);
    assert.equal(api.resolveBin, upscale.resolveBin);
    assert.equal(api.findUpscaylBin, upscale.findUpscaylBin);
    assert.equal(api.DEFAULT_BIN_DIR, upscale.DEFAULT_BIN_DIR);
  });
  check('ffmpeg 按 PATH 顺序查找', () => assert.equal(api.findFfmpeg(), path.join(a, 'ffmpeg' + ext)));
  check('ffprobe 独立查找', () => assert.equal(api.findFfprobe(), path.join(a, 'ffprobe' + ext)));
  process.env.PATH = b;
  check('保留进程内缓存语义', () => {
    assert.equal(api.findFfmpeg(), path.join(a, 'ffmpeg' + ext));
    assert.equal(api.findFfprobe(), path.join(a, 'ffprobe' + ext));
  });
  check('Upscayl 使用显式目录', () => assert.equal(api.findUpscaylBin({ binDir: b }), path.join(b, 'upscayl-bin' + ext)));
  check('缺失工具返回 null', () => assert.equal(api.resolveBin(a, 'missing'), null));
  fs.mkdirSync(path.join(a, 'directory' + ext));
  check('目录不能冒充工具文件', () => assert.equal(api.resolveBin(a, 'directory'), null));
  fs.writeFileSync(path.join(a, 'portable'), '');
  check('无扩展名文件仍能找到', () => assert.equal(api.resolveBin(a, 'portable'), path.join(a, 'portable')));
  console.log(`✅ ${passed} 通过 / 0 失败`);
} finally {
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true });
}
