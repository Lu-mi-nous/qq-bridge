// dl-release.mjs — 通过 GitHub API 下载 release 资产（绕开 github.com 主域限制）
// 用法: node scripts/dl-release.mjs <owner> <repo> <tag> <assetNameSubstr> <dest>
const fs = await import('node:fs');
const path = await import('node:path');
const { Readable } = await import('node:stream');
const { pipeline } = await import('node:stream/promises');

const [, , owner, repo, tag, substr, dest] = process.argv;
if (!owner || !repo || !tag || !substr || !dest) {
  console.error('usage: node scripts/dl-release.mjs <owner> <repo> <tag> <assetNameSubstr> <dest>');
  process.exit(1);
}
const UA = { headers: { 'User-Agent': 'dsh-installer' } };

// 1. 找 asset id
const relUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;
const rel = await (await fetch(relUrl, UA)).json();
const asset = (rel.assets || []).find((a) => a.name.includes(substr));
if (!asset) {
  console.error(`asset containing "${substr}" not found in release ${tag}`);
  process.exit(1);
}
console.log(`asset: ${asset.name} (${(asset.size / 1048576).toFixed(1)} MB)`);

// 2. 走 API 下载端点（octet-stream，302 到 CDN）
const dlUrl = `https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`;
console.log(`downloading via api.github.com ...`);
const r = await fetch(dlUrl, {
  headers: { 'User-Agent': 'dsh-installer', Accept: 'application/octet-stream' },
  redirect: 'follow',
});
if (!r.ok) throw new Error(`HTTP ${r.status} for ${dlUrl}`);
fs.mkdirSync(path.dirname(dest), { recursive: true });
await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
const size = fs.statSync(dest).size;
console.log(`done: ${(size / 1048576).toFixed(1)} MB -> ${dest}`);
