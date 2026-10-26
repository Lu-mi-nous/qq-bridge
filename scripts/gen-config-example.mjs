#!/usr/bin/env node
// 从 CONFIG_DEFAULTS 生成 config.example.json。
// 默认值只有一处来源；模板是它的可读投影，不再手工维护。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DEFAULTS } from '../src/config-defaults.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(ROOT, 'config.example.json');

const SECRET_KEYS = new Set([
  'apiKey', 'accessToken', 'authToken', 'consoleToken', 'token', 'secret',
  'sessdata', 'SESSDATA', 'biliJct', 'buvid3', 'dedeuserid',
]);
const PATH_KEYS = new Set([
  'dir', 'gptModel', 'sovitsModel', 'launcherPath', 'homeDir', 'binDir',
  'modelDir', 'catalogPath', 'archiveDir', 'sessionCwd', 'libDir', 'mediaDir',
]);
const PLACEHOLDER_ID = 123456789;

// 新装推荐值：与代码默认值不同，但更适合首次部署。
// images.enabled 若跟着代码默认 false，克隆者会以为"发不出图"是 bug（已踩过）。
const TEMPLATE_OVERRIDES = {
  'socialV2.images.enabled': true,
  'allow.privateMode': 'friends',
};

function scrub(value, key, path = '') {
  if (Array.isArray(value)) {
    // 只有 allow 的名单用占位号；deny 必须保持空表（否则模板会"默认拉黑一个人"）
    if ((key === 'private' || key === 'groups') && path.startsWith('allow.')) return [PLACEHOLDER_ID];
    return value.map((v) => scrub(v, key, path));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k, path ? `${path}.${k}` : k);
    return out;
  }
  if (SECRET_KEYS.has(key)) return '';
  if (PATH_KEYS.has(key)) return '';
  if (key === 'ownerQQ') return PLACEHOLDER_ID;
  return value;
}

export function buildExample() {
  const example = structuredClone(CONFIG_DEFAULTS);
  if (example.socialV2?.tokenFuse) example.socialV2.tokenFuse.overrides = {};
  const rendered = scrub(example, '');
  for (const [p, v] of Object.entries(TEMPLATE_OVERRIDES)) {
    const parts = p.split('.');
    let node = rendered;
    for (const k of parts.slice(0, -1)) node = node[k];
    node[parts.at(-1)] = v;
  }
  return rendered;
}

export function writeExample() {
  const rendered = buildExample();
  fs.writeFileSync(OUT, JSON.stringify(rendered, null, 2) + '\n', 'utf8');
  return rendered;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const rendered = writeExample();
  const count = (o) => Object.values(o).reduce(
    (n, v) => n + 1 + (v && typeof v === 'object' && !Array.isArray(v) ? count(v) : 0), 0);
  console.log(`已生成 ${path.relative(ROOT, OUT)}（${count(rendered)} 个键）`);
}
