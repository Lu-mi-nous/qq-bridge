// gen-config.mjs — 基于 config.example.json 生成 config.json（UTF-8 安全）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'config.example.json');
const dest = path.join(root, 'config.json');

const cfg = JSON.parse(fs.readFileSync(src, 'utf8'));

// 用户配置
cfg.ownerQQ = 100001000;
cfg.allow.private = [100001000];
cfg.allow.groups = [];
cfg.snowluma.wsUrl = 'ws://127.0.0.1:3001';
cfg.snowluma.httpUrl = 'http://127.0.0.1:3000';
cfg.snowluma.accessToken = '';
const snowlumaDir = process.env.SNOWLUMA_DIR || path.join(os.homedir(), 'SnowLuma');
cfg.snowluma.launcherPath = path.join(snowlumaDir, 'launcher.bat');
cfg.snowluma.homeDir = snowlumaDir;
cfg.snowluma.allowProcessControl = false;

fs.writeFileSync(dest, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
console.log(`config.json written: ${dest}`);
console.log('ownerQQ:', cfg.ownerQQ, '| allow.private:', JSON.stringify(cfg.allow.private));
