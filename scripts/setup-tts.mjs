#!/usr/bin/env node
// 部署 GPT-SoVITS + 达妮娅音色（可选插件，装不上不影响桥接）。
//
// 需求（2026-10-21 用户）：「从 GitHub 克隆一份 sovits 然后用这个达妮娅音源让它有概率
// 发出语音消息」→（2026-10-22）「这个能够做成可插拔的功能吗」。
//
// 本脚本把「一次手工踩坑」固化成可重复的部署步骤。每一步都会先检查再动手，
// 已经就绪的会跳过——反复运行是安全的。
//
// ── 实测记录（这些坑写进代码防止重踩）─────────────────────────────────
//
//   1. **GitHub 直连失败**（`Recv failure: Connection was reset`），必须走代理。
//   2. **`--depth 1` 浅克隆就够**（完整历史 44MB→ 只要当前代码）。
//   3. **底模不少**：v2ProPlus 需要 chinese-roberta-wwm-ext-large、
//      chinese-hubert-base，外加 s2Gv2ProPlus/s2Dv2ProPlus/sv。
//      缺任何一个模型都加载不起来，且报错信息很隐晦（往往是 KeyError）。
//   4. **G2PW 压缩包 588MB**，第一次只下了 353MB（截断）导致 zip 校验失败。
//      必须校验 `content-length` 与 `zipfile.is_zipfile`。
//   5. **`jieba_fast` 在 Python 3.10 上编译失败**（无预编译 wheel，
//      setup.py 报 legacy-install-failure）。它只是"更快的 jieba"，
//      所以装一个转发到 `jieba` 的 shim 即可，功能完全等价。
//   6. **`x-transformers` 会把 torch 升到最新版**，破坏 torchaudio 与
//      faster-whisper 的兼容。装完必须把 torch/torchaudio 钉回同一版本。
//   7. **transformers ≥4.5x 要求 torch ≥2.6**（CVE-2025-32434 的安全限制），
//      所以 torch 2.3.1 不够——本项目装 2.6.0+cu124（本机 4070 可用）。
//
// 用法：
//   node scripts/setup-tts.mjs              # 部署到默认位置
//   node scripts/setup-tts.mjs --dir D:\GPT-SoVITS
//   node scripts/setup-tts.mjs --check      # 只检查，不安装
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function arg(name, dflt = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const CHECK_ONLY = process.argv.includes('--check');
const TARGET = path.resolve(arg('dir', 'E:\\Downloads\\GPT-SoVITS'));
const PROXY = arg('proxy', process.env.HTTPS_PROXY || 'http://127.0.0.1:7897');

const MODEL_BASE = 'https://www.modelscope.cn/models/villia/dania/resolve/master';
const DATASET_NOTE = 'https://www.modelscope.cn/datasets/villia/dania';

const log = (m) => console.log(`[setup-tts] ${m}`);
const step = (m) => console.log(`\n=== ${m} ===`);

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function sizeOf(p) { try { return fs.statSync(p).size; } catch { return 0; } }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: opts.quiet ? 'pipe' : 'inherit',
    cwd: opts.cwd || ROOT,
    env: { ...process.env, ...(opts.env || {}) },
    timeout: opts.timeout || 1800000,
    windowsHide: true,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
  });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function pythonHas(module) {
  const r = run('python', ['-c', `import ${module}`], { quiet: true, timeout: 120000 });
  return r.ok;
}

/** 需要下载的文件清单（按 v2ProPlus 的加载需求）。 */
const REQUIRED = [
  { rel: 'GPT_SoVITS/dania-e15.ckpt', url: `${MODEL_BASE}/dania-e15.ckpt`, minBytes: 100e6 },
  { rel: 'GPT_SoVITS/dania_e16_s2192.pth', url: `${MODEL_BASE}/dania_e16_s2192.pth`, minBytes: 100e6 },
  {
    rel: 'GPT_SoVITS/output/slicer_opt/output.wav_0009342720_0009558400.wav',
    url: `${MODEL_BASE}/output.wav_0009342720_0009558400.wav`,
    minBytes: 100e3
  }
];

async function download(url, dest, minBytes) {
  if (exists(dest) && sizeOf(dest) >= minBytes) {
    log(`已存在，跳过：${path.relative(TARGET, dest)}（${(sizeOf(dest) / 1e6).toFixed(1)}MB）`);
    return true;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  log(`下载 ${path.basename(dest)} …`);
  const r = run('curl', ['-sL', '--proxy', PROXY, '-o', dest, url], { timeout: 1800000 });
  if (!r.ok || sizeOf(dest) < minBytes) {
    log(`  失败（得到 ${(sizeOf(dest) / 1e6).toFixed(1)}MB，期望 ≥${(minBytes / 1e6).toFixed(1)}MB）`);
    try { fs.rmSync(dest, { force: true }); } catch {}
    return false;
  }
  log(`  ok（${(sizeOf(dest) / 1e6).toFixed(1)}MB）`);
  return true;
}

async function main() {
  step('环境检查');
  const py = run('python', ['--version'], { quiet: true });
  if (!py.ok) { log('找不到 python，请先安装 Python 3.10+'); process.exit(1); }
  log(`python: ${py.out.trim()}`);
  const git = run('git', ['--version'], { quiet: true });
  log(`git: ${git.ok ? git.out.trim() : '（未安装，将无法克隆）'}`);

  step(`目标目录 ${TARGET}`);
  if (!exists(path.join(TARGET, 'GPT_SoVITS'))) {
    if (CHECK_ONLY) { log('未部署（--check 模式，不安装）'); process.exit(1); }
    log('克隆 GPT-SoVITS（走代理，浅克隆）…');
    const r = run('git', [
      '-c', `http.proxy=${PROXY}`, '-c', `https.proxy=${PROXY}`,
      'clone', '--depth', '1', 'https://github.com/RVC-Boss/GPT-SoVITS.git', TARGET
    ], { timeout: 1200000 });
    if (!r.ok) { log('克隆失败：检查代理是否可用（--proxy 可改）'); process.exit(1); }
  } else {
    log('已存在，跳过克隆');
  }

  step('说话人权重（达妮娅）');
  let okWeights = true;
  for (const f of REQUIRED) {
    if (CHECK_ONLY) {
      const p = path.join(TARGET, f.rel);
      const good = exists(p) && sizeOf(p) >= f.minBytes;
      log(`${good ? '✓' : '✗'} ${f.rel}`);
      okWeights = okWeights && good;
    } else {
      okWeights = (await download(f.url, path.join(TARGET, f.rel), f.minBytes)) && okWeights;
    }
  }
  if (!okWeights) log('⚠️ 有权重缺失，模型无法加载');

  step('底模（roberta / hubert / v2ProPlus / sv）');
  const pm = path.join(TARGET, 'GPT_SoVITS', 'pretrained_models');
  const pretrainedNeed = [
    { rel: 'chinese-roberta-wwm-ext-large', repo: 'hfl/chinese-roberta-wwm-ext-large' },
    { rel: 'chinese-hubert-base', repo: 'TencentGameMate/chinese-hubert-base' }
  ];
  for (const p of pretrainedNeed) {
    const dir = path.join(pm, p.rel);
    if (exists(dir) && fs.readdirSync(dir).some((f) => /\.(bin|safetensors)$/i.test(f))) {
      log(`已存在，跳过：${p.rel}`);
      continue;
    }
    if (CHECK_ONLY) { log(`✗ 缺底模 ${p.rel}`); continue; }
    log(`下载底模 ${p.repo} …`);
    run('python', ['-c', `
import os
os.environ['HTTPS_PROXY']='${PROXY}'; os.environ['HTTP_PROXY']='${PROXY}'
from huggingface_hub import snapshot_download
snapshot_download(repo_id='${p.repo}', local_dir=r'${dir}',
                  allow_patterns=['*.json','*.bin','*.txt','*.model','*.safetensors'])
`], { timeout: 1800000 });
  }
  const extraWeights = [
    { rel: 'v2Pro/s2Gv2ProPlus.pth', url: 'https://huggingface.co/lj1995/GPT-SoVITS/resolve/main/v2Pro/s2Gv2ProPlus.pth', minBytes: 150e6 },
    { rel: 'sv/pretrained_eres2netv2w24s4ep4.ckpt', url: 'https://huggingface.co/lj1995/GPT-SoVITS/resolve/main/sv/pretrained_eres2netv2w24s4ep4.ckpt', minBytes: 80e6 }
  ];
  for (const w of extraWeights) {
    if (!CHECK_ONLY) await download(w.url, path.join(pm, w.rel), w.minBytes);
  }

  step('Python 依赖');
  const needs = ['torch', 'torchaudio', 'transformers', 'librosa', 'resampy', 'opencc',
    'pytorch_lightning', 'peft', 'x_transformers', 'fast_langdetect', 'soundfile', 'budoux'];
  const missing = needs.filter((m) => !pythonHas(m));
  if (!missing.length) log('全部已安装');
  else if (CHECK_ONLY) log(`缺：${missing.join(', ')}`);
  else {
    log(`安装：${missing.join(', ')}`);
    // 注意顺序：先装无依赖冲突的，再钉 torch 版本（见文件头第 6 条）
    run('python', ['-m', 'pip', 'install', '-q',
      'librosa==0.10.2', 'resampy', 'opencc', 'soundfile', 'budoux',
      'fast_langdetect>=0.3.1', 'pytorch-lightning>=2.4', 'peft<0.18.0',
      'x-transformers', 'transformers>=4.51,<5'], { env: { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY } });
    // 把 torch 钉回 CUDA 版 2.6（transformers 要求 ≥2.6；x-transformers 可能把它升过头）
    run('python', ['-m', 'pip', 'install', '-q', 'torch==2.6.0', 'torchaudio==2.6.0',
      '--index-url', 'https://download.pytorch.org/whl/cu124'], { env: { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY } });
  }

  step('NLTK 数据（g2p_en 必需）');
  // 缺这个会在**合成时**才炸：报 `Resource 'cmudict' not found`，
  // 表现是"试听按钮点完没有能听的音频"（接口 500）。装的时候不检查根本发现不了。
  {
    const chk = run('python', ['-c', `
import nltk
missing=[]
for pkg in ['cmudict','averaged_perceptron_tagger','averaged_perceptron_tagger_eng','punkt','punkt_tab']:
    try:
        nltk.data.find(('corpora/' if pkg in ('cmudict',) else 'taggers/' if 'tagger' in pkg else 'tokenizers/')+pkg)
    except Exception:
        missing.append(pkg)
print(','.join(missing))
`], { quiet: true, timeout: 180000 });
    const missing = chk.out.trim();
    if (!missing) log('已就绪');
    else if (CHECK_ONLY) log(`缺：${missing}`);
    else {
      log(`下载：${missing}`);
      // 代理环境下 NLTK 会拒绝下载（SSRF 防护），必须显式放行，
      // 否则会得到一堆 `[nltk_data] ... cannot be enforced` 然后全部失败。
      run('python', ['-c', `
import os, nltk
os.environ['NLTK_ALLOW_PROXIED_URLOPEN']='1'
try:
    import nltk.pathsec as ps
    ps.ALLOW_PROXIED_FETCH = True
except Exception:
    pass
for pkg in ${JSON.stringify(missing.split(','))}:
    nltk.download(pkg, quiet=True)
print('done')
`], { env: { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, NLTK_ALLOW_PROXIED_URLOPEN: '1' }, timeout: 900000 });
    }
  }

  step('jieba_fast 兼容垫片');
  const shimDir = run('python', ['-c', 'import site;print(site.getsitepackages()[1])'], { quiet: true });
  const sp = shimDir.out.trim();
  if (sp) {
    const shim = path.join(sp, 'jieba_fast');
    if (!exists(shim)) {
      if (!CHECK_ONLY) {
        fs.mkdirSync(shim, { recursive: true });
        fs.writeFileSync(path.join(shim, '__init__.py'), [
          '"""jieba_fast 兼容垫片：转发到 jieba（两者 API 一致）。"""',
          'import jieba as _jieba',
          'from jieba import *  # noqa',
          '__version__ = getattr(_jieba, "__version__", "0.42.1")',
          '',
          'def setLogLevel(level):  # noqa: N802',
          '    _jieba.setLogLevel(level)',
          ''
        ].join('\n'), 'utf8');
        fs.writeFileSync(path.join(shim, 'posseg.py'), [
          '"""转发 jieba.posseg。"""',
          'from jieba.posseg import *  # noqa',
          'from jieba.posseg import cut  # noqa',
          ''
        ].join('\n'), 'utf8');
        log('已安装垫片');
      } else log('缺垫片');
    } else log('已存在，跳过');
  }

  step('G2PW 模型（中文多音字，约 588MB）');
  const g2pw = path.join(TARGET, 'GPT_SoVITS', 'text', 'G2PWModel');
  if (exists(path.join(g2pw, 'g2pW.onnx'))) {
    log('已存在，跳过');
  } else if (CHECK_ONLY) {
    log('✗ 缺 G2PWModel');
  } else {
    const zip = path.join(os.tmpdir(), 'G2PWModel.zip');
    // 这条 URL 指向社区镜像；文件大且易截断，必须校验完整性（见文件头第 4 条）
    const url = 'https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/G2PWModel.zip';
    log('下载 G2PWModel.zip …');
    run('curl', ['-sL', '--proxy', PROXY, '-o', zip, url], { timeout: 1800000 });
    const r = run('python', ['-c', `
import zipfile, os, shutil
z=r'${zip}'
if not zipfile.is_zipfile(z):
    raise SystemExit('zip 损坏（可能下载截断）')
tmp=r'${g2pw}_tmp'
shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp, exist_ok=True)
with zipfile.ZipFile(z) as f: f.extractall(tmp)
inner=os.path.join(tmp,'G2PWModel')
shutil.rmtree(r'${g2pw}', ignore_errors=True)
shutil.move(inner if os.path.isdir(inner) else tmp, r'${g2pw}')
shutil.rmtree(tmp, ignore_errors=True)
print('ok')
`], { timeout: 600000 });
    if (!r.ok) {
      log('G2PW 解压失败。可手动下载后解压到 GPT_SoVITS/text/G2PWModel');
      log(`  数据集/模型页：${DATASET_NOTE}`);
    }
  }

  step('结论');
  const ready = exists(path.join(TARGET, 'GPT_SoVITS', 'dania-e15.ckpt'))
    && exists(path.join(TARGET, 'GPT_SoVITS', 'dania_e16_s2192.pth'))
    && exists(path.join(g2pw, 'g2pW.onnx'));
  if (ready) {
    log('部署完成。在 config.json 里设置：');
    log('  socialV2.tts = { "enabled": true, "dir": ' + JSON.stringify(TARGET) + ', "probability": 0.05 }');
    log('然后重启桥接；控制台「17b 语音合成」应显示"可用"，点「试听一句」验证。');
  } else {
    log('尚未就绪（缺模型或 G2PW）。插件在这种情况下只会降级为纯文字，不影响桥接。');
    process.exit(CHECK_ONLY ? 1 : 0);
  }
}

main().catch((e) => { console.error('[setup-tts] 失败：', e?.message ?? e); process.exit(1); });
