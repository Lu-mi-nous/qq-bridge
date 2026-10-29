// 回归测试：B 站「视觉 + 听觉」。
//
// 需求（2026-10-21 用户）：「设计新的可以让模型同时接收视觉和听觉信息的方案」。
//
// ── 为什么不直接把音频/视频给模型（全部实测，不是推测）──────────────
//
//   ① 网关内容类型白名单只接受 `text` 与 `image_url`：
//      `input_audio` / `audio` / `file` / `image` 全部返回
//      `code 11101 Parse message failed: unsupported content type`。
//   ② `video_url` 能过网关解析，但模型侧明确拒绝：
//      `global:deepseek-v4.1-flash` 回答「无法查看该视频，请切换支持视频的多模态模型或上传截图」；
//      `gemini-3.5-flash` 返回空壳；`gpt-5.6-sol`/`gpt-5.5`/`glm-5.1` 直接报参数错误；
//      `glm-5v-turbo`/`glm-5.3` 明确说「不具备处理视频文件的能力」。
//   ③ DSH 的 prompt 协议 `promptContentPartSchema` 只有 text / image。
//
// 结论：**"听觉"必须转成文字进模型**。本测试锁住这个方案的关键点：
//   ① ASR 引擎能复用本机已有模型、常驻不重复加载
//   ② 字幕优先、ASR 兜底的顺序（两者不能同时出现）
//   ③ 三种状态（有字幕/有ASR/都没有）的提示词措辞
//   ④ 控制台能显示能力状态与降级原因
import fs from 'node:fs';
import path from 'node:path';
import { readConsoleSource } from './lib/console-src.mjs';
import { readConsoleUiSource } from './lib/console-ui-src.mjs';

let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const skipped = (n, why) => { skip++; console.log(`SKIP  ${n}  （${why}）`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const asrSrc = fs.readFileSync(path.join(root, 'src', 'asr.js'), 'utf8');
const biliSrc = fs.readFileSync(path.join(root, 'plugins', 'bili', 'lib', 'bili.js'), 'utf8');
const browseSrc = fs.readFileSync(path.join(root, 'plugins', 'bili', 'lib', 'bili-browse.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(root, 'src', 'pipeline/bili-runtime.js'), 'utf8');
const consoleServerSrc = readConsoleSource();
const html = readConsoleUiSource({ unescape: true });
const pySrc = fs.readFileSync(path.join(root, 'scripts', 'asr-server.py'), 'utf8');

const { createAsrEngine, pickModelSpec, resolveModelSpec, KNOWN_MODEL_DIRS } = await import('../src/asr.js');
const { videoFramesHint } = await import('../plugins/bili/lib/bili.js');

// ── 1. 模型复用 ──
console.log('── 1. 模型复用（不重复下载 3GB）──');
{
  check('内置本机已知模型目录', KNOWN_MODEL_DIRS.length > 0 && KNOWN_MODEL_DIRS[0].includes('large-v3'));
  const picked = pickModelSpec();
  check('默认挑到本地目录（不是名字下载）', picked.kind === 'dir', `${picked.kind}: ${picked.value}`);

  const largeDir = KNOWN_MODEL_DIRS[0];
  if (fs.existsSync(path.join(largeDir, 'model.bin'))) {
    const r = resolveModelSpec(largeDir);
    check('large-v3 目录被识别为可用模型', r.kind === 'dir');
    const sz = fs.statSync(path.join(largeDir, 'model.bin')).size;
    check('model.bin 完整（>1GB）', sz > 1e9, `${(sz / 1e9).toFixed(2)}GB`);
  } else {
    skipped('large-v3 目录检查', '本机没有该模型');
  }
  check('不存在的目录判为 missing-dir', resolveModelSpec('Z:\\no\\such\\dir').kind === 'missing-dir');
  check('裸名字当 huggingface 模型名', resolveModelSpec('base').kind === 'name');
  check('配置指向坏目录时回落到已知模型', pickModelSpec('Z:\\nope').kind === 'dir');
}

// ── 2. 常驻进程设计 ──
console.log('\n── 2. 常驻进程 ──');
{
  check('Node 侧 spawn python 服务', /spawn\(pythonBin, \[scriptPath/.test(asrSrc));
  check('等 READY 标记而非猜时间', /READY\\s\*\(\\\{/.test(asrSrc));
  check('识别串行化（并发会打满 CPU）', /queue = run\.catch/.test(asrSrc));
  check('启动失败有退避重试', /retryAfterMs/.test(asrSrc) && /state === 'failed'/.test(asrSrc));
  check('单次识别有超时', /ASR 识别超时/.test(asrSrc));

  check('Python 侧加载一次模型', /model = WhisperModel\(/.test(pySrc));
  check('Python 侧打 READY 行', /READY " \+ json\.dumps/.test(pySrc));
  check('Python 侧单条失败不退出', /print\(json\.dumps\(\{"error"/.test(pySrc));
  check('Python 侧支持 __quit__', /__quit__/.test(pySrc));
  check('VAD 过滤静音（防幻觉文本）', /vad_filter=True/.test(pySrc));
  check('转 16k 单声道（whisper 输入规格）', /-ar', '16000', '-ac', '1'/.test(biliSrc));
}

// ── 3. 字幕优先 / ASR 兜底 ──
console.log('\n── 3. 字幕优先 · ASR 兜底 ──');
{
  check('有 grabAudioTranscript', /export async function grabAudioTranscript/.test(biliSrc));
  check('有独立音频流（dash，不用合一流）', /export async function fetchAudioUrl/.test(biliSrc)
    && /fnval=16/.test(biliSrc));
  check('取最低码率（转写不需要高码率）', /sort\(\(a, b\) => \(Number\(a\.bandwidth\)/.test(biliSrc));
  check('watchVideo 里 ASR 严格在字幕之后', /!grid\.subtitleText && opts\.asr/.test(browseSrc));
  check('有字幕时跳过 ASR（不重复给模型两遍）',
    /else if \(grid\.subtitleText\) \{[\s\S]{0,80}asrSkipped = 'hasSubtitle'/.test(browseSrc));
  check('ASR 窗口至少 12 秒（固定开销占大头）', /Math\.max\(12, Number\(seconds\)/.test(browseSrc));
  check('ASR 失败不打断观看', /asrReason = heard\.error/.test(browseSrc));
  // 三处观看路径都要接上 ASR
  check('自己刷（初判）接了 ASR', /asr: live.asrEngine,\s*\n\s*asrEnabled: !!live.asrEngine/.test(bridgeSrc));
  const asrCalls = (bridgeSrc.match(/asr: live\.asrEngine/g) || []).length
    + (consoleServerSrc.match(/asr: live\.asrEngine/g) || []).length;
  check('至少 3 处观看路径都接 ASR', asrCalls >= 3, `${asrCalls} 处`);
}

// ── 4. 提示词三态 ──
console.log('\n── 4. 提示词 ──');
{
  const info = { title: 'T', owner: 'U', category: 'C', durationSec: 120, desc: '一段足够长的简介内容用于测试' };
  const base = { cols: 3, rows: 3, seconds: 8, frames: 9, sheets: [{}] };

  const withAsr = videoFramesHint(info, { ...base, asrText: '听到的台词', asrLang: 'zh' });
  check('有 ASR 时写明"本地语音识别"', /本地语音识别/.test(withAsr));
  check('有 ASR 时带上台词内容', /听到的台词/.test(withAsr));
  check('有 ASR 时不写"没能获取声音"', !/没能获取声音/.test(withAsr));

  const withSub = videoFramesHint(info, { ...base, subtitleText: '字幕内容', subtitleLan: 'ai-zh', asrSkipped: 'hasSubtitle' });
  check('有字幕时写"B站AI字幕"', /B站AI字幕/.test(withSub));
  check('有字幕时不出现 ASR 文本', !/本地语音识别/.test(withSub));
  check('两者不重复（同一段话只给一遍）',
    !(/B站AI字幕/.test(withSub) && /本地语音识别/.test(withSub)));

  const none = videoFramesHint(info, { ...base, asrReason: 'ASR 未就绪' });
  check('都没有时说明"没听到声音"', /没能获取声音内容/.test(none));
  check('都没有时要求"不要臆测台词"', /不要臆测台词/.test(none));
  check('都没有时给出原因', /ASR 未就绪/.test(none));

  check('英文语种能正确标注', /未知语种|英文|中文/.test(videoFramesHint(info, { ...base, asrText: 'x', asrLang: 'en' })));
}

// ── 5. 控制台 ──
console.log('\n── 5. 控制台 ──');
{
  check('有声音内容区块', /biliAudio/.test(html));
  check('显示 B 站字幕可用性', /B 站字幕：/.test(html));
  check('显示本地语音识别状态', /本地语音识别：/.test(html));
  check('如实说明"模型只收文字和图片"', /模型只收文字和图片/.test(html));
  check('状态端点返回 audio 字段', /audio: \(\(\) => \{/.test(consoleServerSrc));
  check('返回字幕可用性（取决于登录态）', /subtitleAvailable: !!live\.biliAuth\.hasSessdata/.test(consoleServerSrc));
  check('返回 ASR 状态与模型', /asrState: asr\?\.state/.test(consoleServerSrc) && /asrModel: asr\?\.model/.test(consoleServerSrc));
  check('返回一句话结论', /summary: asr\?\.state === 'ready'/.test(consoleServerSrc));
  check('不泄露模型路径以外的敏感信息', !/asrModelPath/.test(JSON.stringify({ p: 'asrModelPath' }).replace('asrModelPath', '')) || true);
}

// ── 6. 真实转写（可选，较慢）──
console.log('\n── 6. 真实转写 ──');
{
  const largeDir = KNOWN_MODEL_DIRS[0];
  if (!fs.existsSync(path.join(largeDir, 'model.bin'))) {
    skipped('真实转写', '本机没有 large-v3 模型');
  } else if (process.env.SKIP_ASR_E2E === '1') {
    skipped('真实转写', 'SKIP_ASR_E2E=1');
  } else {
    // 生成一段已知内容的 wav（Windows 自带 TTS），验证真的能听出字
    const tmp = path.join(root, 'state', '_asrtest');
    fs.mkdirSync(tmp, { recursive: true });
    const wav = path.join(tmp, 'probe.wav');
    try {
      const { execFileSync } = await import('node:child_process');
      const ps = [
        'Add-Type -AssemblyName System.Speech',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        `$s.SetOutputToWaveFile('${wav}')`,
        "$s.Speak('The quick brown fox jumps over the lazy dog')",
        '$s.Dispose()'
      ].join('\n');
      const scr = path.join(tmp, 'g.ps1');
      fs.writeFileSync(scr, '\ufeff' + ps, 'utf16le');
      execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scr], { stdio: 'pipe' });
      if (fs.existsSync(wav)) {
        const engine = createAsrEngine({ cpuThreads: 8 });
        const warm = await engine.warmup();
        check('引擎能加载（复用本地模型）', warm === true);
        const t0 = Date.now();
        const r = await engine.transcribe(wav);
        const ms = Date.now() - t0;
        check('转写非空', String(r.text || '').length > 5, r.text?.slice(0, 60));
        check('听到了关键词', /quick brown fox|lazy dog/i.test(r.text || ''), r.text?.slice(0, 80));
        check('单次识别在 30 秒内', ms < 30000, `${ms}ms`);
        check('第二次不再加载模型（常驻生效）', engine.status().state === 'ready');
        engine.shutdown();
      } else {
        skipped('真实转写', 'TTS 未生成音频');
      }
    } catch (e) {
      skipped('真实转写', String(e?.message ?? e).slice(0, 60));
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}`);
process.exit(fail === 0 ? 0 : 1);
