// set-sauce-key.mjs — 配置 SauceNAO 的 API key（反向搜图用）
//
// 用法：node scripts/set-sauce-key.mjs <40位key>
//       node scripts/set-sauce-key.mjs --check     只自检当前 key
//       node scripts/set-sauce-key.mjs --clear     清空 key
//
// key 获取：saucenao.com 注册账号 → 账号页（Account → API）里能看到 40 位的 key。
// 免费账号额度：30 秒 4 次、每天 100 次（超了会明确报错）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'config.json');
const arg = process.argv[2] || '';

function loadCfg() { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
function saveCfg(c) { fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2) + '\n'); }

if (arg === '--clear') {
  const c = loadCfg();
  c.imageReverseSearch = { ...(c.imageReverseSearch || {}), apiKey: '' };
  saveCfg(c);
  console.log('✅ 已清空 imageReverseSearch.apiKey（反向搜图将不可用，调用时会明确提示未配置）');
  process.exit(0);
}

const cfg = loadCfg();
const current = String(cfg.imageReverseSearch?.apiKey || '').trim();

if (arg === '--check' || !arg) {
  if (!current) {
    console.log('当前未配置 API key。');
    console.log('  配置：node scripts/set-sauce-key.mjs <40位key>');
    console.log('  获取：saucenao.com 注册后在账号页找 40 位 API key');
    process.exit(current ? 0 : 0);
  }
  console.log(`当前 key：${current.slice(0, 6)}…${current.slice(-4)}（长度 ${current.length}）`);
  console.log('正在用一张本地图做真实自检…');
  const { createReverseSearcher } = await import('../plugins/images/lib/image-reverse-search.mjs');
  const searcher = createReverseSearcher({
    root: ROOT,
    proxy: String(cfg.imageReverseSearch?.proxy || cfg.socialV2?.images?.proxy || ''),
    apiKey: current
  });
  // 造一张纯色小图当探针（纯色图必然搜不到出处，但足以验证 key 是否被接受）
  const probe = await makeProbeImage();
  const r = await searcher.search(probe, { numres: 1 });
  if (r.ok) {
    console.log(`✅ key 有效（能正常查询；探针图无出处属正常，返回 ${r.results?.length ?? 0} 条）`);
  } else if (/key 无效|anonymous/i.test(r.error || '')) {
    console.log(`❌ key 无效：${r.error}`);
    console.log('   请确认复制的是完整 40 位、且账号已启用 API');
    process.exitCode = 1;
  } else {
    console.log(`⚠️ 查询未成功：${r.error}`);
    console.log('   若提示「风控」多半是代理不稳定，换代理或稍后重试');
    process.exitCode = 1;
  }
  process.exit();
}

// 写入模式
const key = arg.trim();
if (!/^[A-Za-z0-9]{20,64}$/.test(key)) {
  console.error('❌ key 格式看起来不对（应为 20~64 位字母数字，SauceNAO 正常是 40 位）');
  process.exit(1);
}
cfg.imageReverseSearch = { ...(cfg.imageReverseSearch || {}), enabled: true, apiKey: key };
saveCfg(cfg);
console.log(`✅ 已写入 imageReverseSearch.apiKey（${key.slice(0, 6)}…，长度 ${key.length}）`);
console.log('   下一步：node scripts/set-sauce-key.mjs --check  验证 key 是否真的可用');

/** 生成一张 200x200 纯色 PNG 当探针（不依赖外部资源）。 */
async function makeProbeImage() {
  const { spawn } = await import('node:child_process');
  const { findFfmpeg } = await import('../src/gif-frames.js');
  const ff = findFfmpeg();
  if (!ff) {
    // 没有 ffmpeg 就退化为最小合法 PNG（1x1 灰点，SauceNAO 可能拒收但足以测 key 校验顺序）
    return Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001a5f645400000000049454e44ae426082', 'hex');
  }
  const out = path.join(ROOT, 'state', 'tmp-sauce-probe.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await new Promise((res) => {
    const p = spawn(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x334455:s=200x200:d=1', '-frames:v', '1', '-update', '1', out], { windowsHide: true });
    p.on('close', res); p.on('error', res);
  });
  const buf = fs.readFileSync(out);
  try { fs.unlinkSync(out); } catch {}
  return buf;
}
