// 前端文件协作锁：给「正在改 public/console.html 的 agent」和「只想加后端功能的 agent」一个约定。
//
// 为什么需要文件锁：控制台改版会整体移动详情 DOM/JS，另一个 agent 若在这期间
// 读取旧结构再改写，两边会互相覆盖；而它反复轮询 console.html 也没有意义
// （拿到的随时是半成品）。用一个显式锁文件代替"互相猜"。
//
// 用法：
//   node scripts/ui-lock.mjs           查看状态
//   node scripts/ui-lock.mjs check     锁着时退出码 3（脚本/CI 可用）
//   node scripts/ui-lock.mjs release   释放（改版完成、测试通过后）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(root, 'public', 'console.html');
const LOCK = `${TARGET}.lock`;

const cmd = String(process.argv[2] || 'status').toLowerCase();

function sha16(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

if (cmd === 'release') {
  if (!fs.existsSync(LOCK)) {
    console.log('没有锁文件，无需释放。');
    process.exit(0);
  }
  fs.unlinkSync(LOCK);
  console.log('已释放前端文件锁：public/console.html.lock');
  process.exit(0);
}

if (!fs.existsSync(LOCK)) {
  console.log('前端文件未加锁（可以改 public/console.html）。');
  process.exit(cmd === 'check' ? 0 : 0);
}

let info = null;
try {
  info = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
} catch {
  console.log('锁文件存在但无法解析，请人工检查：public/console.html.lock');
  process.exit(cmd === 'check' ? 3 : 0);
}

const current = sha16(TARGET);
const changed = info.sha256_16 && current && info.sha256_16 !== current;

console.log('前端文件已加锁');
console.log(`  持有者   ${info.owner}`);
console.log(`  起始     ${info.since}`);
console.log(`  原因     ${info.reason}`);
if (changed) {
  console.log(`  ⚠️ 文件哈希已变化（锁记录 ${info.sha256_16}，当前 ${current}）——锁期间被改过，需人工确认`);
}
console.log('  不要做   ' + (info.do_not || []).join('；'));
console.log(`  释放条件 ${info.release_when}`);

process.exit(cmd === 'check' ? 3 : 0);
