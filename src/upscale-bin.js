// Upscayl 二进制探针（R4.5-1）。
//
// 为什么留在核心而不是插件里：`feature-menu.js` 需要**同步**判断"本机有没有 upscayl-bin"
// 来决定菜单里是否列"超分放大"（列了却做不了比不列更糟）。它只是一次 stat，
// 不启动进程、不 import 插件实现；超分本体已迁到 `plugins/upscale/`。
import fs from 'node:fs';
import path from 'node:path';

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
