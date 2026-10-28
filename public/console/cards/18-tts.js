// 18 语音合成（GPT-SoVITS，C5 真模块卡，逻辑自 legacy-runtime 迁入）。
import { api as defaultApi } from '../core/api.js';

export async function mount(container, ctx = {}) {
  const api = ctx.api || defaultApi;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  container.innerHTML = "      <div id=\"ttsStatusLine\" class=\"meta\">加载中…</div>\n      <div id=\"ttsBody\" style=\"margin-top:10px\"></div>\n\n      <!-- 可编辑参数（2026-10-22 用户要求「触发概率、每小时上限、模型设置、字数等\n           设成可变参数并提供修改按钮」）。\n           分两组是因为**生效时机不同**：\n             · 触发策略：每次回复现读配置 → 保存即生效\n             · 模型设置：启动时传给引擎并进了闭包 → 保存后要重启\n           把这点写在界面上，用户才不会改完以为没生效。 -->\n      <details class=\"animated-details\" style=\"margin-top:12px\">\n        <summary class=\"meta\">修改参数</summary>\n        <div class=\"details-anim\"><div class=\"details-inner\">\n          <div class=\"meta\" style=\"margin:10px 0 4px\"><b>触发策略</b>（保存后立即生效）</div>\n          <div class=\"row\">\n            <label style=\"flex:none;width:110px\">触发概率</label>\n            <input type=\"number\" id=\"ttsPProbability\" min=\"0\" max=\"100\" step=\"1\" style=\"width:80px\">\n            <span class=\"meta\">%（0~100，只对单条文本回复生效）</span>\n          </div>\n          <div class=\"row\" style=\"margin-top:6px\">\n            <label style=\"flex:none;width:110px\">每小时上限</label>\n            <input type=\"number\" id=\"ttsPMaxPerHour\" min=\"0\" max=\"60\" step=\"1\" style=\"width:80px\">\n            <span class=\"meta\">条（0 = 不自动发，只能被要求时发）</span>\n          </div>\n          <div class=\"row\" style=\"margin-top:6px\">\n            <label style=\"flex:none;width:110px\">最长字数</label>\n            <input type=\"number\" id=\"ttsPMaxChars\" min=\"10\" max=\"300\" step=\"1\" style=\"width:80px\">\n            <span class=\"meta\">字（超过就发文字）</span>\n          </div>\n\n          <div class=\"meta\" style=\"margin:14px 0 4px\"><b>韵律与音量</b>（保存后立即生效，无需重启）</div>\n          <div class=\"row\">\n            <label style=\"flex:none;width:110px\">语速</label>\n            <input type=\"number\" id=\"ttsPSpeed\" min=\"0.8\" max=\"1.2\" step=\"0.01\" style=\"width:80px\">\n            <label style=\"flex:none;margin-left:12px\">停顿</label>\n            <input type=\"number\" id=\"ttsPFragment\" min=\"0.1\" max=\"0.6\" step=\"0.05\" style=\"width:70px\">\n            <span class=\"meta\">秒（分句间隔）</span>\n          </div>\n          <div class=\"row\" style=\"margin-top:6px\">\n            <label style=\"flex:none;width:110px\" title=\"控制随机性：低更稳、偏平；高更活、可能飘\">温度</label>\n            <input type=\"number\" id=\"ttsPTemperature\" min=\"0.5\" max=\"1.2\" step=\"0.05\" style=\"width:80px\" title=\"随机性：低更稳，高更活\">\n            <label style=\"flex:none;margin-left:12px\" title=\"每一步只从概率最高的 K 个候选里挑：K 小更稳，K 大更自由\">top_k</label>\n            <input type=\"number\" id=\"ttsPTopK\" min=\"5\" max=\"30\" step=\"1\" style=\"width:70px\" title=\"候选数：小更稳，大更自由\">\n            <label style=\"flex:none;margin-left:12px\" title=\"从累计概率达到 p 的候选里挑（核采样）：p 小更稳，p 大更自由\">top_p</label>\n            <input type=\"number\" id=\"ttsPTopP\" min=\"0.7\" max=\"1.0\" step=\"0.01\" style=\"width:70px\" title=\"累计概率阈值：小更稳，大更自由\">\n          </div>\n          <div class=\"meta\" style=\"margin-top:4px;line-height:1.55;opacity:.9\">\n            <b>温度</b>：控制随机性。低（0.6~0.8）更稳、偏平；高（1.0~1.2）更活、可能飘。默认 0.9。<br>\n            <b>top_k</b>：每一步只从概率最高的 K 个候选里挑。K 小更保守稳定，K 大更自由。默认 15。<br>\n            <b>top_p</b>：从累计概率达到 p 的候选里挑（核采样）。p 小更保守，p 大更自由。默认 0.95。<br>\n            <span style=\"opacity:.75\">一般只调温度就够了；top_k / top_p 保持默认即可。</span>\n          </div>\n          <div class=\"row\" style=\"margin-top:6px\">\n            <label style=\"flex:none;width:110px\">分句方式</label>\n            <select id=\"ttsPSplit\" style=\"width:auto\">\n              <option value=\"cut5\">cut5（按标点分句，推荐）</option>\n              <option value=\"cut1\">cut1（基本不分句）</option>\n            </select>\n            <label style=\"flex:none;margin-left:12px\">额外音量</label>\n            <input type=\"number\" id=\"ttsPVolume\" min=\"-12\" max=\"12\" step=\"0.5\" style=\"width:70px\">\n            <span class=\"meta\">dB（自动响度归一之上）</span>\n          </div>\n          <div class=\"row\" style=\"margin-top:6px\">\n            <label style=\"flex:none;width:110px\">标点规范化</label>\n            <label class=\"meta\" style=\"display:flex;align-items:center;gap:6px\">\n              <input type=\"checkbox\" id=\"ttsPPunctuate\" style=\"width:auto\">\n              合成前补句末标点、去掉 [表情] 占位符\n            </label>\n          </div>\n\n          <div class=\"meta\" style=\"margin:14px 0 4px\"><b>模型设置</b>（保存后<span class=\"pill warn\">需重启</span>才生效）</div>\n          <div class=\"row\">\n            <label style=\"flex:none;width:110px\">音色预设</label>\n            <select id=\"ttsPVoiceId\" style=\"flex:1;min-width:0\"></select>\n          </div>\n          <div class=\"row\" style=\"margin-top:6px\">\n            <label style=\"flex:none;width:110px\">权重版本</label>\n            <select id=\"ttsPWeightsId\" style=\"width:auto\"></select>\n          </div>\n          <div class=\"row\" style=\"margin-top:6px\">\n            <label style=\"flex:none;width:110px\">参考音频</label>\n            <select id=\"ttsPRefMode\" style=\"flex:1;min-width:0\"></select>\n          </div>\n          <div class=\"row\" style=\"margin-top:6px;align-items:flex-start\">\n            <label style=\"flex:none;width:110px\">参考台词</label>\n            <div class=\"meta\" id=\"ttsPRefPreview\" style=\"flex:1;min-width:0;white-space:normal\"></div>\n          </div>\n          <div class=\"meta\" style=\"margin:4px 0 2px\">“自动”会按这句回复的语气（开心/生气/难过/中性）挑参考音频；换音色或权重版本需重启，换参考策略即时生效。</div>\n          <div class=\"row\">\n            <label style=\"flex:none;width:110px\">引擎目录</label>\n            <input type=\"text\" id=\"ttsPDir\" style=\"flex:1;min-width:0\" placeholder=\"E:\\Downloads\\GPT-SoVITS\">\n            <button type=\"button\" class=\"small\" data-tts-pick=\"dir\" data-tts-target=\"ttsPDir\">选择…</button>\n          </div>\n          <div class=\"row\" style=\"margin-top:6px\">\n            <label style=\"flex:none;width:110px\">GPT 权重</label>\n            <input type=\"text\" id=\"ttsPGptModel\" style=\"flex:1;min-width:0\">\n            <button type=\"button\" class=\"small\" data-tts-pick=\"file\" data-tts-target=\"ttsPGptModel\">选择…</button>\n          </div>\n          <div class=\"row\" style=\"margin-top:6px\">\n            <label style=\"flex:none;width:110px\">SoVITS 权重</label>\n            <input type=\"text\" id=\"ttsPSovitsModel\" style=\"flex:1;min-width:0\">\n            <button type=\"button\" class=\"small\" data-tts-pick=\"file\" data-tts-target=\"ttsPSovitsModel\">选择…</button>\n          </div>\n          <div class=\"row\" style=\"margin-top:6px\">\n            <label style=\"flex:none;width:110px\">设备</label>\n            <select id=\"ttsPDevice\" style=\"width:auto\">\n              <option value=\"cuda\">cuda（GPU，快）</option>\n              <option value=\"cpu\">cpu（兼容，慢）</option>\n            </select>\n            <label style=\"flex:none;margin-left:12px\">线程</label>\n            <input type=\"number\" id=\"ttsPCpuThreads\" min=\"1\" max=\"32\" step=\"1\" style=\"width:70px\">\n          </div>\n          <div class=\"row\" style=\"margin-top:6px\">\n            <label style=\"flex:none;width:110px\">音色名</label>\n            <input type=\"text\" id=\"ttsPVoiceName\" style=\"width:160px\">\n          </div>\n\n          <div class=\"row\" style=\"margin-top:12px\">\n            <button id=\"ttsSaveParams\" class=\"small\">保存参数</button>\n            <button id=\"ttsRestartForParams\" class=\"small danger\">保存并重启桥接</button>\n            <span class=\"meta\" id=\"ttsParamMsg\"></span>\n          </div>\n        </div></div>\n      </details>\n\n      <div class=\"row\" style=\"margin-top:10px\">\n        <button id=\"ttsTest\" class=\"small\">试听一句</button>\n        <span class=\"meta\" id=\"ttsMsg\"></span>\n      </div>\n      <div id=\"ttsAudioPreview\" style=\"margin-top:8px\"></div>\n      <div class=\"meta\" id=\"ttsHint\" style=\"margin-top:8px\">\n        <b>可插拔</b>：未启用时不加载任何模型、不占显存，桥接只发文字。\n        启用后由桥接按概率把<b>单条</b>文本回复改成语音（多段、含链接、过长的不发）。\n        合成失败会自动回退成文字，不会吞消息。\n      </div>\n      <div class=\"declarative-card\" data-card-mount=\"18\"></div>";

async function refreshTtsStatus() {
  const lineEl = document.getElementById('ttsStatusLine');
  const bodyEl = document.getElementById('ttsBody');
  if (!lineEl || !bodyEl) return;
  try {
    const r = await api('/api/socialV2/tts-status');
    if (!r?.ok) { lineEl.textContent = '读取失败'; return; }
    // 参数表单独存一份，供 fillTtsParams() 回填（60 秒轮询会重复调用，
    // 回填时按 dataset.edited 跳过用户正在编辑的框）
    window.__ttsEditable = r.editable || null;
    // 音色归档清单（voices.json 的紧凑视图）：控制台据此渲染
    // 音色 / 权重版本 / 参考音频（按情绪）三个下拉。
    window.__ttsVoices = Array.isArray(r.voices) ? r.voices : [];
    const pill = r.usable
      ? '<span class="pill g">可用</span>'
      : (r.enabled ? '<span class="pill" style="background:#8a3a3a;color:#fff">不可用</span>' : '<span class="pill">未启用</span>');
    lineEl.innerHTML = `${pill} ${esc(r.summary || '')}`;
    const rows = [
      ['音色', r.voice || '-'],
      ['引擎目录', r.dir || '-'],
      // 显示**实际加载**的权重，而不是只显示配置项：
      // 之前配置写爱弥斯、引擎读 yaml 里的 dania，UI 完全看不出来。
      ['实际权重', `${r.gptModel || '-'} / ${r.sovitsModel || '-'}${r.modelVersion ? `（${r.modelVersion}）` : ''}`],
      ['设备', `${r.device || '-'}${r.loadSec != null ? `　加载 ${r.loadSec}s${r.warmed ? '（已预热）' : ''}` : ''}`],
      ['触发概率', `${Math.round((r.probability || 0) * 100)}%（只对单条文本回复生效）`],
      ['每小时上限', `${r.maxPerHour || 0} 条`],
      ['最长字数', `${r.maxChars || 0} 字（超过就发文字）`]
    ];
    bodyEl.innerHTML = `<table class="tk-table"><tbody>${rows.map(([k, v]) =>
      `<tr><td style="width:110px">${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join('')}</tbody></table>`
      + (r.error ? `<div class="meta" style="margin-top:6px;color:#b45">原因：${esc(r.error)}</div>` : '')
      + (r.refText ? `<div class="meta" style="margin-top:6px;opacity:.8">参考音色台词：${esc(r.refText)}…</div>` : '');
  } catch (e) {
    lineEl.textContent = '读取失败：' + (e?.message || e);
  }
  fillTtsParams();
}

// ── TTS 参数表单（2026-10-22）──────────────────────────────────────────
//
// **回填规则**：只填用户没改过的框。
// 这个函数会被 60 秒轮询调用；若无条件覆盖，用户正在输入时会被冲掉
// ——凭据卡片踩过同一个坑（"点一次保存只保存了最早改的那一个"）。
// 所以每个框一旦被用户编辑过就打 dataset.edited，回填时跳过。
let TTS_PARAMS_LOADED = false;

// ── 音色预设（2026-10-22 用户归档）────────────────────────────────────
// 后端从 GPT-SoVITS/GPT_SoVITS/voices.json 读出「音色 → 权重版本 → 情绪参考」。
// 这里只负责渲染三个下拉 + 台词预览；选择本身通过 /api/socialV2/config 保存。
let TTS_VOICES = [];
function ttsVoiceById(id) {
  return TTS_VOICES.find((v) => v.id === id) || TTS_VOICES[0] || null;
}

function updateTtsRefPreview() {
  const el = document.getElementById('ttsPRefPreview');
  if (!el) return;
  const voice = ttsVoiceById(document.getElementById('ttsPVoiceId')?.value);
  const mode = document.getElementById('ttsPRefMode')?.value || 'auto';
  if (mode === 'auto') {
    const moods = [...new Set((voice?.refs || []).map((r) => r.mood))];
    el.textContent = moods.length
      ? `自动：按回复语气在 ${moods.join('/')} 中选；没有对应情绪时用默认参考。`
      : '自动：清单里没有可用参考音频，回落到默认参考。';
    return;
  }
  const ref = (voice?.refs || []).find((r) => r.id === mode);
  el.textContent = ref ? ref.text : '（这条参考没有台词，不会用于自动选择）';
}

/**
 * 重建音色/权重/参考三个下拉。
 * 规则与其它表单一致：用户正在编辑的项优先，不被 60 秒轮询冲掉。
 */
function syncTtsVoiceOptions(pref = {}) {
  const vsel = document.getElementById('ttsPVoiceId');
  const wsel = document.getElementById('ttsPWeightsId');
  const rsel = document.getElementById('ttsPRefMode');
  if (!vsel || !wsel || !rsel || !TTS_VOICES.length) return;
  const edited = (el) => el?.dataset?.edited === '1';
  const wantVoice = pref.voiceId || (edited(vsel) ? vsel.value : '') || vsel.value || '';
  vsel.innerHTML = TTS_VOICES.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('');
  const voice = ttsVoiceById(wantVoice);
  if (!voice) return;
  vsel.value = voice.id;

  const weights = Array.isArray(voice.weights) ? voice.weights : [];
  const wantWeights = pref.weightsId || (edited(wsel) ? wsel.value : '') || wsel.value || voice.defaultWeights || '';
  wsel.innerHTML = weights.map((w) => `<option value="${esc(w.id)}">${esc(w.label)}</option>`).join('');
  const w = weights.find((x) => x.id === wantWeights) || weights[0];
  if (w) wsel.value = w.id;

  const refs = Array.isArray(voice.refs) ? voice.refs : [];
  const wantRef = pref.refMode || (edited(rsel) ? rsel.value : '') || rsel.value || 'auto';
  rsel.innerHTML = '<option value="auto">自动（按回复语气）</option>'
    + refs.map((r) => `<option value="${esc(r.id)}">固定：${esc(r.label)}（${esc(r.mood)}）</option>`).join('');
  rsel.value = (wantRef === 'auto' || refs.some((r) => r.id === wantRef)) ? wantRef : 'auto';
  updateTtsRefPreview();
}
function fillTtsParams() {
  const p = window.__ttsEditable;
  if (!p) return;
  const set = (id, val, isSelect = false) => {
    const el = document.getElementById(id);
    if (!el) return;
    // 用户改过就不动（dataset.edited 由 input 事件置位）
    if (el.dataset.edited === '1') return;
    if (isSelect) el.value = String(val);
    else el.value = String(val ?? '');
  };
  set('ttsPProbability', Math.round((p.probability ?? 0) * 100));
  set('ttsPMaxPerHour', p.maxPerHour ?? 3);
  set('ttsPMaxChars', p.maxChars ?? 140);
  set('ttsPDir', p.dir ?? '');
  set('ttsPGptModel', p.gptModel ?? '');
  set('ttsPSovitsModel', p.sovitsModel ?? '');
  set('ttsPDevice', p.device ?? 'cuda', true);
  set('ttsPCpuThreads', p.cpuThreads ?? 8);
  set('ttsPVoiceName', p.voiceName ?? '');
  set('ttsPSpeed', p.speed ?? 1);
  set('ttsPFragment', p.fragmentInterval ?? 0.3);
  set('ttsPTemperature', p.temperature ?? 0.9);
  set('ttsPTopK', p.topK ?? 15);
  set('ttsPTopP', p.topP ?? 0.95);
  set('ttsPSplit', p.textSplitMethod ?? 'cut5', true);
  set('ttsPVolume', p.volumeGainDb ?? 0);
  const punctEl = document.getElementById('ttsPPunctuate');
  if (punctEl && punctEl.dataset.edited !== '1') punctEl.checked = p.punctuate !== false;
  // 音色/权重/参考三个下拉只在清单可用时渲染；没有 voices.json 时保持隐藏的空 select。
  TTS_VOICES = Array.isArray(window.__ttsVoices) ? window.__ttsVoices : [];
  if (TTS_VOICES.length) {
    const edited = (id) => document.getElementById(id)?.dataset.edited === '1';
    syncTtsVoiceOptions({
      voiceId: edited('ttsPVoiceId') ? undefined : (p.voiceId || ''),
      weightsId: edited('ttsPWeightsId') ? undefined : (p.weightsId || ''),
      refMode: edited('ttsPRefMode') ? undefined : (p.refMode || 'auto')
    });
  }
  if (!TTS_PARAMS_LOADED) {
    TTS_PARAMS_LOADED = true;
    document.querySelectorAll('#ttsCard input, #ttsCard select').forEach((el) => {
      if (!el.id || !el.id.startsWith('ttsP')) return;
      el.addEventListener('input', () => { el.dataset.edited = '1'; });
      el.addEventListener('change', () => { el.dataset.edited = '1'; });
    });
    // 换音色要重建权重/参考选项；换权重或参考只更新台词预览。
    document.getElementById('ttsPVoiceId')?.addEventListener('change', () => syncTtsVoiceOptions());
    document.getElementById('ttsPWeightsId')?.addEventListener('change', updateTtsRefPreview);
    document.getElementById('ttsPRefMode')?.addEventListener('change', updateTtsRefPreview);
    initTtsPathPickers();
  }
}

// 「选择…」按钮：浏览器出于安全限制拿不到 <input type=file> 的绝对路径，
// 而引擎要的是本机绝对路径。所以由桥接在**运行桥接的这台电脑**上弹原生对话框，
// 选完把路径写回输入框。
//
// 选中后立刻打 dataset.edited：否则 60 秒轮询会把用户刚选的路径冲回旧值
// （与"用户正在输入时不被覆盖"是同一条规则）。
function initTtsPathPickers() {
  document.querySelectorAll('#ttsCard [data-tts-pick]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const input = document.getElementById(btn.dataset.ttsTarget || '');
      if (!input) return;
      const label = btn.textContent;
      const msg = document.getElementById('ttsParamMsg');
      btn.disabled = true;
      btn.textContent = '选择中…';
      try {
        const r = await api('/api/socialV2/tts/pick-path', 'POST', {
          kind: btn.dataset.ttsPick === 'dir' ? 'dir' : 'file'
        });
        if (!r?.ok) throw new Error(r?.error || '打开文件选择框失败');
        if (r.path) {
          input.value = r.path;
          input.dataset.edited = '1';
          if (msg) msg.textContent = '✅ 已选择路径，记得点「保存参数」';
        } else if (msg) {
          msg.textContent = '已取消选择';
        }
      } catch (error) {
        if (msg) msg.textContent = `❌ ${error?.message ?? error}`;
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  });
}

// 收集表单值：概率按百分数填，提交时折回 0~1（后端也兼容两种写法）
function gatherTtsParams() {
  const num = (id, dflt) => {
    const v = Number(document.getElementById(id)?.value);
    return Number.isFinite(v) ? v : dflt;
  };
  const str = (id) => String(document.getElementById(id)?.value ?? '').trim();
  return {
    probability: num('ttsPProbability', 5) / 100,
    maxPerHour: num('ttsPMaxPerHour', 3),
    maxChars: num('ttsPMaxChars', 140),
    dir: str('ttsPDir'),
    gptModel: str('ttsPGptModel'),
    sovitsModel: str('ttsPSovitsModel'),
    device: str('ttsPDevice') || 'cuda',
    cpuThreads: num('ttsPCpuThreads', 8),
    voiceName: str('ttsPVoiceName'),
    // 音色预设：voiceId 一旦有值，后端以 voices.json 里的权重/参考为准
    voiceId: str('ttsPVoiceId'),
    weightsId: str('ttsPWeightsId'),
    refMode: str('ttsPRefMode') || 'auto',
    // 韵律/响度：请求级参数，保存后下一次合成就生效
    speed: num('ttsPSpeed', 1),
    fragmentInterval: num('ttsPFragment', 0.3),
    temperature: num('ttsPTemperature', 0.9),
    topK: num('ttsPTopK', 15),
    topP: num('ttsPTopP', 0.95),
    textSplitMethod: str('ttsPSplit') || 'cut5',
    volumeGainDb: num('ttsPVolume', 0),
    punctuate: !!document.getElementById('ttsPPunctuate')?.checked
  };
}

async function saveTtsParams(thenRestart) {
  const msg = document.getElementById('ttsParamMsg');
  const btn = document.getElementById(thenRestart ? 'ttsRestartForParams' : 'ttsSaveParams');
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = thenRestart ? '保存并重启中…' : '保存中…';
  try {
    const r = await api('/api/socialV2/config', 'POST', { tts: gatherTtsParams() });
    if (!r?.ok) throw new Error(r?.error || '保存失败');
    // 清掉"已编辑"标记：保存后服务端的值就是我们刚提交的，
    // 下次轮询可以安全回填（否则用户改完后再也不会同步）。
    document.querySelectorAll('#ttsCard input, #ttsCard select').forEach((el) => {
      if (el.id && el.id.startsWith('ttsP')) delete el.dataset.edited;
    });
    if (!thenRestart) {
      if (msg) msg.textContent = '✅ 已保存（触发策略立即生效；模型设置需重启）';
      await refreshTtsStatus();
    } else {
      if (msg) msg.textContent = '已保存，正在重启…';
      await api('/api/restart', 'POST', {});
      if (msg) msg.textContent = '已保存并重启（约 5~10 秒恢复，音频参数需等模型重新加载）';
    }
  } catch (e) {
    if (msg) msg.textContent = '失败：' + (e?.message || e);
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => { if (msg) msg.textContent = ''; }, 15000);
  }
}

document.getElementById('ttsSaveParams')?.addEventListener('click', () => { void saveTtsParams(false); });
document.getElementById('ttsRestartForParams')?.addEventListener('click', () => {
  if (!confirm('保存参数并重启桥接？\n\n进行中的对话会被中断，约 5~10 秒恢复。')) return;
  void saveTtsParams(true);
});

document.getElementById('ttsTest')?.addEventListener('click', async () => {
  const msg = document.getElementById('ttsMsg');
  const btn = document.getElementById('ttsTest');
  const box = document.getElementById('ttsAudioPreview');
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = '正在合成（首次约 10~25 秒，之后 1~3 秒）…';
  try {
    const tk = localStorage.getItem('consoleToken');
    // 试听用当前选中的音色/参考：音色只影响文本，参考策略决定语气
    const voiceName = ttsVoiceById(document.getElementById('ttsPVoiceId')?.value)?.name || '达妮娅';
    const refMode = document.getElementById('ttsPRefMode')?.value || 'auto';
    const res = await fetch('/api/socialV2/tts-say', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(tk ? { 'x-console-token': tk } : {}) },
      body: JSON.stringify({
        text: `你好呀，我是${voiceName}。今天也要开心哦。`,
        ...(refMode !== 'auto' ? { refId: refMode } : {})
      })
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const prev = box?.querySelector('audio');
    if (prev) URL.revokeObjectURL(prev.dataset.url || '');
    const url = URL.createObjectURL(blob);
    if (box) {
      box.innerHTML = `<div class="meta" style="margin-bottom:4px">试听（${Math.round(blob.size / 1024)}KB）</div>`
        + `<audio controls style="width:100%"></audio>`;
      const a = box.querySelector('audio');
      a.src = url;
      a.dataset.url = url;
    }
    if (msg) msg.textContent = '已合成';
  } catch (e) {
    if (msg) msg.textContent = '失败：' + (e?.message || e);
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => { if (msg) msg.textContent = ''; }, 10000);
  }
});

  await refreshTtsStatus();
}
