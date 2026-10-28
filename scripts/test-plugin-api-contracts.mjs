import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { humanTokens } from '../src/plugin-api/format.js';
import { humanTokens as legacyFormat } from '../src/token-usage.js';
import { SENSITIVE_RE, createPluginLogger } from '../src/plugin-api/logging.js';
import { SENSITIVE_RE as legacySensitive } from '../src/sensitive.js';
import * as speech from '../src/plugin-api/speech.js';
import * as legacySpeech from '../src/tts.js';
import { create } from '../plugins/tts/index.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
await check('格式化兼容入口共用函数', () => assert.equal(humanTokens, legacyFormat));
for (const [value, expected] of [[0, '0'], [999, '999'], [1000, '1.0K'], [1e6, '1.00M'], [1e9, '1.00B'], ['bad', '0']]) {
  await check(`格式化 ${value}`, () => assert.equal(humanTokens(value), expected));
}
await check('敏感规则兼容且不误拦正常文字', () => {
  assert.equal(SENSITIVE_RE, legacySensitive);
  assert.equal(SENSITIVE_RE.test('password=example-secret'), true);
  assert.equal(SENSITIVE_RE.test('今天聊聊音乐'), false);
});
await check('日志前缀、输出目标与返回值保持不变', () => {
  const lines = [];
  const log = createPluginLogger('demo', line => { lines.push(line); return 42; });
  assert.equal(log('已启动'), 42);
  assert.deepEqual(lines, ['[plugin:demo] 已启动']);
  createPluginLogger('silent')('不输出');
});
await check('语音只公开五项既有契约', () => {
  assert.deepEqual(Object.keys(speech).sort(), ['DEFAULT_SOVITS_DIR', 'DEFAULT_SPEECH_PARAMS', 'TTS_DEFAULT_PROBABILITY', 'createTtsEngine', 'probeSovits'].sort());
  for (const key of Object.keys(speech)) assert.equal(speech[key], legacySpeech[key]);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-public-speech-'));
let plugin;
try {
  await check('缺失语音目录明确不可用', () => assert.equal(speech.probeSovits({ dir: path.join(tmp, 'missing') }).ok, false));
  for (const file of ['GPT_SoVITS/configs/tts_infer.yaml', 'weights.ckpt', 'weights.pth', 'ref.wav']) {
    const p = path.join(tmp, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '');
  }
  for (const dir of ['chinese-roberta-wwm-ext-large', 'chinese-hubert-base']) fs.mkdirSync(path.join(tmp, 'GPT_SoVITS/pretrained_models', dir), { recursive: true });
  let current = { pick: { moodOfText: () => 'happy' } };
  const config = { enabled: true, probability: 1, dir: tmp, gptModel: 'weights.ckpt', sovitsModel: 'weights.pth', refAudio: 'ref.wav' };
  plugin = create({
    config: { get: () => config }, log() {},
    social: { getState: () => ({}) },
    // 真实桥接宿主总会注入 send.voiceFile；没有发送能力的宿主（MCP 独立进程）
    // 不建引擎、不预热，由 test-voice-upscale-x-mcp-runtime 覆盖。
    send: { voiceFile: () => {} },
    capabilities: { get: name => name === 'stickers.instance' ? current : null }
  });
  await check('TTS 探测与启动不加载模型', async () => {
    assert.equal((await plugin.start()).available, true);
    assert.equal(plugin.status().state, 'idle');
  });
  await check('语音计划使用当前表情能力', () => assert.equal(plugin.plan('group:1', ['你好呀']).mood, 'happy'));
  current = null;
  await check('表情能力撤销后回退 neutral', () => assert.equal(plugin.plan('group:1', ['你好呀']).mood, 'neutral'));
  current = { pick: { moodOfText: () => 'calm' } };
  await check('重新注册后不使用旧实例', () => assert.equal(plugin.plan('group:1', ['你好呀']).mood, 'calm'));
  await check('停止后不生成语音计划', () => { plugin.stop(); assert.equal(plugin.plan('group:1', ['你好呀']), null); });
} finally {
  plugin?.stop();
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`✅ ${passed} 通过 / 0 失败`);
