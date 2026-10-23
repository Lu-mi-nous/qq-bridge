// 清理社交状态里机器人「自称旧名」的历史记录。
//
// 背景：改名只改了角色卡与状态文件，**改不了对话历史**。群聊记录里留着机器人以前
// 自称「阿糖」的发言，而 recentMessages 会作为「你最近已说过：」注入提示——
// 模型读到自己说过「我叫阿糖」，就把它当成既定事实继续用（实测 17:32 还在说
// 「我就是阿糖啊」，那一刻角色卡注入的明明是「大肥鱼」）。
//
// 只改机器人自己的发言（isSelf:true），**不动群友说的话**——群友叫它阿糖是事实，
// 删掉反而造假；而且群友的疑问（「阿糖才不会凶我」）模型应当看到并自然纠正。
//
// 用法：先停桥接！再 node scripts/fix-role-name-history.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';

const STATE = path.join(process.cwd(), 'state', 'social-v2.json');
const OLD = '阿糖';
const NEW = '大肥鱼';
const DRY = process.argv.includes('--dry-run');

if (!fs.existsSync(STATE)) { console.error('找不到', STATE); process.exit(1); }

// 安全前提：桥接在运行时会用自己的内存态覆盖这个文件，必须先停。
// 用 lock 文件里的 PID 判断（桥接退出会删锁）。
const lockFile = path.join(process.cwd(), 'state', 'bridge.lock');
if (fs.existsSync(lockFile)) {
  const pid = Number(String(fs.readFileSync(lockFile, 'utf8')).trim());
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (alive) {
    console.error(`\n❌ 桥接仍在运行（pid ${pid}）——必须先停止，否则内存态会覆盖本脚本的修改。`);
    console.error('   停止：关掉桌面「停止QQ机器人.bat」，或 kill 该 pid 后再跑本脚本。\n');
    process.exit(2);
  }
}

const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
let changed = 0;
let dropped = 0;
const report = [];

// 只替换机器人自己发言里的自称；群友的话原样保留。
// 注意替换范围要克制：只动明确的「自称」句式，避免把「阿糖好」这种别人的称呼改掉。
const SELF_PATTERNS = [
  [/我叫阿糖/g, `我叫${NEW}`],
  [/叫我阿糖/g, `叫我${NEW}`],
  [/我是阿糖/g, `我是${NEW}`],
  [/我就是阿糖/g, `我就是${NEW}`],
  [/阿糖不会/g, `${NEW}不会`],   // 机器人说"阿糖才不会凶我"这类
  [/糖做的/g, '鱼做的'],
  [/糖渣/g, '鱼鳞']
];

// 这些发言当初是**在拒绝「大肥鱼」这个称呼**（"什么大肥鱼，我叫阿糖"）。
// 现在名字正是大肥鱼，改字会产出「什么大肥鱼，我叫大肥鱼」这种自相矛盾的废话，
// 而它本身已经作废——直接从历史里删掉，别留一条自己打自己脸的记录。
const OBSOLETE_RE = /什么大肥鱼.*(?:我叫|叫我)阿糖|阿糖.*才不是大肥鱼/;

function fixMsg(m) {
  if (!m || !m.isSelf) return 'keep';
  const text = String(m.text ?? '');
  if (OBSOLETE_RE.test(text)) {
    report.push(`  删除（已作废的自称否定）：「${text.slice(0, 40)}」`);
    return 'drop';
  }
  let touched = false;
  for (const field of ['text', 'plain', 'tail']) {
    let v = String(m[field] ?? '');
    if (!v.includes(OLD) && !/糖/.test(v)) continue;
    const orig = v;
    for (const [re, to] of SELF_PATTERNS) v = v.replace(re, to);
    if (v !== orig) {
      report.push(`  ${field}: 「${orig.slice(0, 40)}」 → 「${v.slice(0, 40)}」`);
      m[field] = v;
      touched = true;
    }
  }
  return touched ? 'fixed' : 'keep';
}

for (const [key, conv] of Object.entries(st.conversations || {})) {
  let n = 0, d = 0;
  conv.recentMessages = (conv.recentMessages || []).filter((m) => {
    const r = fixMsg(m);
    if (r === 'drop') { d++; return false; }
    if (r === 'fixed') n++;
    return true;
  });
  // 未读里机器人自己的那条（少见）同样处理，但不删——删了会影响未读计数逻辑
  for (const m of (conv.unread || [])) if (fixMsg(m) === 'fixed') n++;
  if (n || d) { changed += n; dropped += d; console.log(`\n[${key}] 改写 ${n} 处，删除 ${d} 条`); }
}

console.log(`\n共改写 ${changed} 处机器人自称，删除 ${dropped} 条已作废发言。`);
if (report.length) console.log('明细：\n' + report.join('\n'));
console.log('\n（群友自己说的话一律未动。）');

if (DRY) { console.log('\n--dry-run：未写入。'); process.exit(0); }
if (!changed) { console.log('无需写入。'); process.exit(0); }

fs.writeFileSync(STATE, JSON.stringify(st, null, 2) + '\n');
console.log('已写入', STATE);
