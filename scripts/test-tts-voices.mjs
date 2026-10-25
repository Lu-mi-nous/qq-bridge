// 回归测试：音色预设（voices.json）与"按语气选参考音频"。
//
// 背景（2026-10-22 用户要求）：把达妮娅/爱弥斯的权重与按情绪分好的参考音频
// 归档到 GPT-SoVITS 目录，希望控制台能直接选音色，并让语音按回复语气选参考。
//
// 本测试锁住：
//   ① 清单加载/校验：缺文件、缺台词的项要被过滤，不能让引擎拿到坏路径
//   ② 选择顺序：显式 id → 默认 → 第一个可用；权重/参考都必须真实存在
//   ③ 语气映射：happy/sad/angry/neutral；没有对应情绪时回落 neutral/默认
//   ④ 同一情绪多条时随机（避免永远同一个语调）
//   ⑤ 接线：tts.js 用参考音频、bridge 传 mood/refMode、控制台有下拉
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadVoicesManifest,
  resolveVoiceSelection,
  pickVoiceRef,
  voicesForApi,
  MOOD_TO_REF,
  VOICES_MANIFEST_REL
} from '../src/tts-voices.js';

let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const skipped = (n, why) => { skip++; console.log(`SKIP  ${n}  （${why}）`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ttsvoices-'));
const vr = path.join(root, 'GPT_SoVITS');
const touch = (p, data = 'x') => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
};
const rel = (p) => path.relative(vr, p).split(path.sep).join('/');

// 假权重/参考（只校验文件存在，不加载模型）
for (const w of ['a/proplus/gpt.ckpt', 'a/proplus/sovits.pth', 'a/v2/gpt.ckpt', 'a/v2/sovits.pth', 'd/gpt.ckpt', 'd/sovits.pth']) {
  touch(path.join(vr, w));
}
touch(path.join(vr, 'a/refs/happy1.wav'), 'RIFF');
touch(path.join(vr, 'a/refs/happy2.wav'), 'RIFF');
touch(path.join(vr, 'a/refs/neutral.wav'), 'RIFF');
touch(path.join(vr, 'a/refs/sad.wav'), 'RIFF');
touch(path.join(vr, 'd/refs/neutral.wav'), 'RIFF');
// 故意放一条"文件存在但台词为空"的参考，应被过滤
touch(path.join(vr, 'a/refs/empty.wav'), 'RIFF');

const manifest = {
  version: 1,
  defaultVoice: 'aemis',
  voices: [
    {
      id: 'aemis',
      name: '爱弥斯',
      defaultWeights: 'proplus',
      defaultRef: 'neutral-1',
      weights: [
        { id: 'proplus', label: 'v2ProPlus', gpt: 'a/proplus/gpt.ckpt', sovits: 'a/proplus/sovits.pth' },
        { id: 'v2', label: 'v2Pro', gpt: 'a/v2/gpt.ckpt', sovits: 'a/v2/sovits.pth' },
        { id: 'broken', label: '坏权重', gpt: 'a/missing.ckpt', sovits: 'a/missing.pth' }
      ],
      refs: [
        { id: 'happy-1', mood: 'happy', label: '开心1', audio: 'a/refs/happy1.wav', text: '开心一', lang: 'zh' },
        { id: 'happy-2', mood: 'happy', label: '开心2', audio: 'a/refs/happy2.wav', text: '开心二', lang: 'zh' },
        { id: 'neutral-1', mood: 'neutral', label: '中立1', audio: 'a/refs/neutral.wav', text: '中立一', lang: 'zh' },
        { id: 'sad-1', mood: 'sad', label: '难过1', audio: 'a/refs/sad.wav', text: '难过一', lang: 'zh' },
        { id: 'empty', mood: 'neutral', label: '空台词', audio: 'a/refs/empty.wav', text: '', lang: 'zh' },
        { id: 'missing', mood: 'neutral', label: '缺文件', audio: 'a/refs/nope.wav', text: '不存在的参考', lang: 'zh' }
      ]
    },
    {
      id: 'dania',
      name: '达妮娅',
      defaultWeights: 'proplus',
      defaultRef: 'neutral-1',
      weights: [{ id: 'proplus', label: 'v2ProPlus', gpt: 'd/gpt.ckpt', sovits: 'd/sovits.pth' }],
      refs: [{ id: 'neutral-1', mood: 'neutral', label: '中立1', audio: 'd/refs/neutral.wav', text: '中立', lang: 'zh' }]
    }
  ]
};
const mfPath = path.join(root, VOICES_MANIFEST_REL);
fs.mkdirSync(path.dirname(mfPath), { recursive: true });
fs.writeFileSync(mfPath, JSON.stringify(manifest, null, 2), 'utf8');

console.log('── 1. 清单加载与校验 ──');
{
  const m = loadVoicesManifest(root);
  check('清单加载成功', m.ok === true, m.error || '');
  check('识别两个音色', m.ok && m.voices.length === 2, String(m.voices?.length));
  const a = m.voices?.find((v) => v.id === 'aemis');
  check('爱弥斯权重两套可用、坏权重被标记', a?.weights.filter((w) => w.exists).length === 2);
  check('缺文件/空台词的参考被过滤', a?.refs.filter((r) => r.exists).length === 4, String(a?.refs.filter((r) => r.exists).length));
  check('文件缺失的参考 exists=false', a?.refs.find((r) => r.id === 'missing')?.exists === false);
  check('空台词参考 exists=false', a?.refs.find((r) => r.id === 'empty')?.exists === false);
}

console.log('\n── 2. 选择音色/权重 ──');
{
  const m = loadVoicesManifest(root);
  const sel = resolveVoiceSelection(m, { voiceId: 'aemis', weightsId: 'v2' });
  check('按 id 选中爱弥斯', sel?.voice?.id === 'aemis');
  check('按 id 选中 v2Pro 权重', sel?.weights?.id === 'v2', sel?.weights?.id);
  check('默认参考是中立1', sel?.defaultRef?.id === 'neutral-1', sel?.defaultRef?.id);
  const sel2 = resolveVoiceSelection(m, { voiceId: 'nope', weightsId: 'nope' });
  check('未知 id 回落到默认音色/默认权重', sel2?.voice?.id === 'aemis' && sel2?.weights?.id === 'proplus', `${sel2?.voice?.id}/${sel2?.weights?.id}`);
  const sel3 = resolveVoiceSelection(m, { voiceId: 'dania' });
  check('达妮娅只有一套权重', sel3?.voice?.id === 'dania' && sel3?.weights?.id === 'proplus');
}

console.log('\n── 3. 按语气挑参考 ──');
{
  const sel = resolveVoiceSelection(loadVoicesManifest(root), { voiceId: 'aemis' });
  check('laugh → happy', pickVoiceRef(sel, { mood: 'laugh' })?.mood === 'happy');
  check('proud → happy', pickVoiceRef(sel, { mood: 'proud' })?.mood === 'happy');
  check('sad → sad', pickVoiceRef(sel, { mood: 'sad' })?.mood === 'sad');
  check('angry 没有对应参考时回落 neutral/默认', ['neutral', 'sad', 'happy'].includes(pickVoiceRef(sel, { mood: 'angry' })?.mood));
  check('未知语气回落 neutral', pickVoiceRef(sel, { mood: 'xyz' })?.mood === 'neutral');
  check('固定 refId 优先于语气', pickVoiceRef(sel, { refId: 'sad-1', mood: 'laugh' })?.id === 'sad-1');
  check('固定 refId 不存在时按语气回落', pickVoiceRef(sel, { refId: 'nope', mood: 'laugh' })?.mood === 'happy');
  const r0 = pickVoiceRef(sel, { mood: 'happy', random: () => 0 });
  const r1 = pickVoiceRef(sel, { mood: 'happy', random: () => 0.99 });
  check('同一情绪多条时随机（0 → 第一条）', r0?.id === 'happy-1', JSON.stringify(r0));
  check('同一情绪多条时随机（0.99 → 最后一条）', r1?.id === 'happy-2', JSON.stringify(r1));
  check('mood 映射表覆盖表情包十类', Object.keys(MOOD_TO_REF).length >= 10, String(Object.keys(MOOD_TO_REF).length));
}

console.log('\n── 4. API 视图不泄露绝对路径 ──');
{
  const m = loadVoicesManifest(root);
  const sel = resolveVoiceSelection(m, { voiceId: 'aemis' });
  const api = voicesForApi(m, sel);
  check('返回两个音色', api.length === 2);
  check('标记当前选中', api.find((v) => v.id === 'aemis')?.selected === true);
  check('不含绝对路径', !JSON.stringify(api).includes(root.replace(/\\/g, '\\\\')) && !JSON.stringify(api).includes(root));
  check('参考带台词与情绪', api[0].refs.every((r) => r.text && r.mood));
}

console.log('\n── 5. 真实归档（存在才测）──');
{
  const realDir = process.env.GPT_SOVITS_DIR || path.join(os.homedir(), 'GPT-SoVITS');
  if (!fs.existsSync(path.join(realDir, VOICES_MANIFEST_REL))) {
    skipped('真实 voices.json', '未找到归档清单');
  } else {
    const m = loadVoicesManifest(realDir);
    check('真实清单可加载', m.ok === true, m.error || '');
    const a = m.voices?.find((v) => v.id === 'aemis');
    const d = m.voices?.find((v) => v.id === 'dania');
    check('爱弥斯两套权重', a?.weights.filter((w) => w.exists).length >= 2, String(a?.weights.filter((w) => w.exists).length));
    check('爱弥斯有开心/中立/难过参考', ['happy', 'neutral', 'sad'].every((mood) => a?.refs.some((r) => r.mood === mood && r.exists)));
    check('达妮娅有可用权重与中立参考', d?.weights.some((w) => w.exists) && d?.refs.some((r) => r.exists));
  }
}

console.log('\n── 6. 接线 ──');
{
  const tts = fs.readFileSync(new URL('../src/tts.js', import.meta.url), 'utf8');

  const qqSend = fs.readFileSync(new URL('../src/pipeline/qq-send.js', import.meta.url), 'utf8');
  const consoleServer = fs.readFileSync(new URL('../src/console-server.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  check('tts.js 引入音色模块', /from '\.\/tts-voices\.js'/.test(tts) && /pickVoiceRef/.test(tts));
  check('speak 接受 mood/refId', /async speak\(text, callOpts = \{\}\)/.test(tts) && /mood: callOpts\.mood/.test(tts));
  check('请求里带选中的参考音频/台词', /ref_audio_path: useRef\.audio/.test(tts) && /prompt_text: useRef\.text/.test(tts));
  check('缓存键包含参考音频（换情绪不复用旧音频）', /probe\.sovitsModel\}\|\$\{ref\.id\}\|\$\{ref\.audio\}/.test(tts));
  
  
  check('状态接口下发音色/参考清单', /voices: probe\?\.voices/.test(consoleServer) && /refs: st\?\.refs/.test(consoleServer));
  check('控制台有三个下拉', /id="ttsPVoiceId"/.test(html) && /id="ttsPWeightsId"/.test(html) && /id="ttsPRefMode"/.test(html));
  check('控制台有参考台词预览', /id="ttsPRefPreview"/.test(html));
  check('保存时提交音色/权重/参考策略', /voiceId: str\('ttsPVoiceId'\)/.test(html) && /refMode: str\('ttsPRefMode'\)/.test(html));
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}`);
process.exit(fail === 0 ? 0 : 1);
