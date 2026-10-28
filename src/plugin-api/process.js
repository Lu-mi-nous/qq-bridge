// 公共可执行文件定位接口：只检查文件，不启动进程；保留现有查找顺序和缓存。
import fs from 'node:fs';
import path from 'node:path';

/** 在 PATH 与常见安装位置里找 ffmpeg/ffprobe，找到返回绝对路径，否则 null。 */
function resolveBinary(name) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  const dirs = [
    ...String(process.env.PATH ?? '').split(path.delimiter),
    'C:\\Program Files\\ffmpeg-6.1.1-essentials_build\\bin',
    'C:\\ffmpeg\\bin',
    '/usr/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin'
  ].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

let cachedFfmpeg;
let cachedFfprobe;
export function findFfmpeg() {
  if (cachedFfmpeg === undefined) cachedFfmpeg = resolveBinary('ffmpeg');
  return cachedFfmpeg;
}
export function findFfprobe() {
  if (cachedFfprobe === undefined) cachedFfprobe = resolveBinary('ffprobe');
  return cachedFfprobe;
}

/** Upscayl 默认安装位置。可用 config.socialV2.upscale.binDir / modelDir 覆盖。 */
export const DEFAULT_BIN_DIR = 'C:\\Program Files\\Upscayl\\resources\\bin';

export function resolveBin(binDir, name) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const ext of exts) {
    const p = path.join(binDir, name + ext);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

/** upscayl-bin 是否可用（不实际跑，只查文件）。 */
export function findUpscaylBin(opts = {}) {
  const binDir = String(opts.binDir || DEFAULT_BIN_DIR);
  return resolveBin(binDir, 'upscayl-bin');
}
