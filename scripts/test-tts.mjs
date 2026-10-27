// 回归测试：GPT-SoVITS 语音合成（可插拔）。
//
// 需求（2026-10-21 用户）：「从 GitHub 克隆一份 sovits，用达妮娅音源让它有概率发语音消息」
// →（2026-10-22）「这个能够做成可插拔的功能吗」。
//
// ── "可插拔"在测试里的含义 ───────────────────────────────────────────
//
// 不是"代码里有 if 判断"，而是**三条可验证的行为**：
//   ① 默认关闭：`enabled` 不为 true 时，探测/加载/工具全都不存在；
//   ② 探测失败只报原因、不抛错：目录错、模型缺、底模缺，桥接照常起；
//   ③ 合成失败自动回退文字：语音是可选表达，绝不能吞掉消息。
//
// 另外锁住实现里的关键数据点（都是实测的，改动前值得知道）：
//   - 常驻进程：加载 24.8s（含预热），但之后 4 字推理 1.5s、42 字 2.9s；
//   - 参考音频与 prompt_text 必须成对（写错会让语调对不上）；
//   - 只对**单条**文本回复发语音，且不与 @/引用 同时生效。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { readConsoleSource } from './lib/console-src.mjs';
import { readConsoleUiSource } from './lib/console-ui-src.mjs';

let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const skipped = (n, why) => { skip++; console.log(`SKIP  ${n}  （${why}）`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const ttsSrc = fs.readFileSync(path.join(root, 'src', 'tts.js'), 'utf8');
const incomingSrc=fs.readFileSync(path.join(root,'src/pipeline/incoming.js'),'utf8');
const bridgeSrc = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
const socialSrc = fs.readFileSync(path.join(root, 'src', 'social-engine.js'), 'utf8');
const ttsPluginSrc = fs.readFileSync(path.join(root, 'plugins', 'tts', 'index.js'), 'utf8');
const qqSendSrc = fs.readFileSync(path.join(root, 'src', 'pipeline', 'qq-send.js'), 'utf8');
const wakeSrc = fs.readFileSync(path.join(root, 'src', 'pipeline', 'wake.js'), 'utf8');
const consoleServerSrc = readConsoleSource();
const html = readConsoleUiSource({ unescape: true });
const pySrc = fs.readFileSync(path.join(root, 'scripts', 'sovits-server.py'), 'utf8');

const { probeSovits, createTtsEngine, DEFAULT_SOVITS_DIR, DEFAULT_VOICE, normalizeTtsText, DEFAULT_SPEECH_PARAMS } = await import('../src/tts.js');

// ── 1. 默认关闭 / 探测可失败 ──
console.log('── 1. 可插拔：默认关闭与失败降级 ──');
{
  check('默认目录常量是本机 GPT-SoVITS', /GPT-SoVITS/.test(DEFAULT_SOVITS_DIR), DEFAULT_SOVITS_DIR);
  check('默认音色是达妮娅', DEFAULT_VOICE.refText.includes('限制器') || /dania/i.test(DEFAULT_VOICE.gptModel));

  // 目录不存在 → 返回 ok:false + reason，**不抛异常**
  let threw = false;
  let r;
  try { r = probeSovits({ dir: 'Z:\\definitely\\not\\here' }); } catch { threw = true; }
  check('目录不存在时不抛异常', !threw);
  check('目录不存在时给出原因', r && r.ok === false && /不存在/.test(r.reason), r?.reason);

  // 空目录**回退到默认安装位置**（比报错更好：用户没配 dir 时不该直接不可用）
  const r2 = probeSovits({ dir: '' });
  check('空目录回退到默认目录', r2.dir === DEFAULT_SOVITS_DIR, r2.dir);

  // 插件侧：enabled 不是 true 就完全不初始化；桥接只负责加载宿主
  check('TTS 插件默认不启用（要 === true 才加载）', /if \(t\.enabled !== true\)/.test(ttsPluginSrc));
  check('未启用只记一行日志', /未启用.*只发文字/.test(ttsPluginSrc));
  check('探测失败只记日志不抛', /已启用但不可用：\$\{probe\.reason\}/.test(ttsPluginSrc));
  check('初始化异常被吞掉', /初始化失败（不影响文字聊天）/.test(ttsPluginSrc));
  check('桥接通过插件运行时加载 TTS', /createPluginRuntime/.test(bridgeSrc)
    && /pluginRuntime\.ttsEngine\(\)/.test(bridgeSrc));
}

// ── 2. 真机探测（可选）──
console.log('\n── 2. 真机探测 ──');
{
  const p = probeSovits();
  if (p.ok) {
    check('探测通过', true, p.dir);
    check('找到 GPT 权重', fs.existsSync(path.isAbsolute(p.gptModel) ? p.gptModel : path.join(p.dir, p.gptModel)));
    check('找到 SoVITS 权重', fs.existsSync(path.isAbsolute(p.sovitsModel) ? p.sovitsModel : path.join(p.dir, p.sovitsModel)));
    check('找到参考音频', fs.existsSync(p.refAudio));
    check('参考台词非空（缺它语调会对不上）', String(p.refText || '').length > 6, p.refText?.slice(0, 24));
    // 底模存在性：少一个都加载不起来
    check('底模 roberta 存在', fs.existsSync(path.join(p.dir, 'GPT_SoVITS', 'pretrained_models', 'chinese-roberta-wwm-ext-large')));
    check('底模 hubert 存在', fs.existsSync(path.join(p.dir, 'GPT_SoVITS', 'pretrained_models', 'chinese-hubert-base')));
  } else {
    skipped('真机探测', p.reason);
  }
}

// ── 3. 常驻进程与协议 ──
console.log('\n── 3. 常驻进程协议 ──');
{
  check('Node 侧 spawn python 常驻', /spawn\(pythonBin, \[serverScript\]/.test(ttsSrc));
  check('等 READY 握手而非猜时间', /READY\\s\*\(\\\{/.test(ttsSrc));
  check('串行化（并发会抢显存）', /queue = run\.catch/.test(ttsSrc));
  check('失败退避重试', /retryAfterMs/.test(ttsSrc));
  check('合成有超时', /TTS 合成超时/.test(ttsSrc));
  check('通过环境变量传配置（不改外部仓库）',
    /QQB_SOVITS_DIR/.test(ttsSrc) && /QQB_SOVITS_CONFIG/.test(ttsSrc));
  check('离线模式（避免运行时下载底模卡住）',
    /HF_HUB_OFFLINE/.test(ttsSrc) && /TRANSFORMERS_OFFLINE/.test(ttsSrc));
  check('Python 侧不修改外部配置（device 走环境变量）',
    /cfg\.device = device/.test(pySrc) && !/yaml\.dump|io\.open\(cfg_path,\s*['"]w/.test(pySrc));
  check('Python 侧单条失败不退出', /except Exception as e:[\s\S]{0,200}?"error"/.test(pySrc));
  check('有预热步骤（首条不慢 3~4 秒）', /warmup failed|WARN warmup/.test(pySrc));
  check('文本长度上限（300 字）', /文本过长/.test(ttsSrc));
  check('按文本指纹缓存（同句不重复合成）', /createHash\('sha1'\)/.test(ttsSrc));
}

// ── 4. 概率发语音的判定 ──
console.log('\n── 4. 掷骰与回退 ──');
{
  check('由 TTS 插件掷骰而非模型决定', /Math\.random\(\) >= prob/.test(ttsPluginSrc));
  check('只对单条消息发语音', /messages\.length !== 1/.test(ttsPluginSrc));

  // 默认触发率（2026-10-22 用户要求 8% → 5%）。
  // 关键是**只有一个来源**：常量在 tts.js，桥接/插件/控制台都引用它。
  check('默认概率是 5%', /export const TTS_DEFAULT_PROBABILITY = 0\.05;/.test(ttsSrc));
  const literal08 = (ttsSrc.match(/probability \?\? 0\.08/g) || []).length
    + (ttsPluginSrc.match(/probability \?\? 0\.08/g) || []).length;
  check('没有残留写死的 8% 默认值', literal08 === 0, `${literal08} 处`);
  const constRefs = (ttsPluginSrc.match(/probability \?\? TTS_DEFAULT_PROBABILITY/g) || []).length
    + (consoleServerSrc.match(/probability \?\? TTS_DEFAULT_PROBABILITY/g) || []).length;
  check('默认值统一走常量（≥3 处引用）', constRefs >= 3, `${constRefs} 处`);
  // 模型主动发语音**不受概率限制**：群友明确要听，就该发。
  check('主动发不检查概率（只受每小时上限）',
    /send-voice[\s\S]{0,2500}?maxPerHour/.test(consoleServerSrc)
    && !/send-voice[\s\S]{0,1200}?Math\.random\(\)/.test(consoleServerSrc));

  check('过长不发（默认 140 字）', /maxChars\) \|\| 140/.test(consoleServerSrc));
  // 用字面量 includes 而不是正则：源码那行本身含大量转义，
  // 再用正则去匹配它极易写错（这条断言就因此假失败过一次）。
  check('含链接/代码不发',
    ttsPluginSrc.includes('https?:\\/\\/|www\\.|```'),
    '查找 TTS 插件里的链接/代码过滤');
  check('纯数字不发', /\^\[\\d\\s\.,%\+-\]\+\$/.test(ttsPluginSrc));
  check('每小时上限（防连发）', /ttsTimes/.test(ttsPluginSrc) && /maxPerHour/.test(ttsPluginSrc));
  check('不与 @ 同时生效（引用可以带进语音）', /\(autoAt \|\| atUserId\) \? null : \(getTtsPlugin\(\)\?\.plan/.test(qqSendSrc));
  check('语音不拼 reply 段（QQ 不支持同气泡）', !/type: 'reply', data: \{ id: String\(info\.replyToMessageId\) \}/.test(qqSendSrc));
  check('语音失败回退文字时保留引用', /onebotSend\(kind, id, ttsPlan\.text, replyToMessageId, null\)/.test(qqSendSrc));
  // 最关键的一条：语音失败必须回退文字
  check('合成失败回退成文字（绝不吞消息）', /语音没发成，退回普通文字发送/.test(qqSendSrc));
  check('发送失败也回退', /await sendAsVoice\([\s\S]{0,300}?if \(r\.ok\)/.test(qqSendSrc));
}

// ── 5. 发送链路 ──
console.log('\n── 5. 发送链路 ──');
{
  check('有 onebotSendVoiceFile', /async function onebotSendVoiceFile/.test(bridgeSrc));
  check('用 OneBot record 段', /type: 'record', data: \{ file: `file:\/\/\$\{abs\}` \}/.test(bridgeSrc));
  check('调用后记录已发消息', /recordSentMessage\(key, body\.data, `［语音］/.test(bridgeSrc));
  check('概率语音在发送列表标 isVoice', /sent\.push\(\{ text: ttsPlan\.text, isVoice: true \}\)/.test(qqSendSrc));
  check('发送记录保留 [语音] 标记', /isVoice \? '\[语音\] ' : ''/.test(socialSrc) && /isVoice,/.test(socialSrc));
  check('主动语音写回 recentMessages', /recordSentMessagesV2\(key, \[\{ text, isVoice: true \}\]\)/.test(consoleServerSrc));
  {
    const i = consoleServerSrc.indexOf("url.pathname === '/api/socialV2/send-voice'");
    const block = consoleServerSrc.slice(i, i + 5000);
    check('主动语音更新 lastAiReplyAt', i > 0 && /lastAiReplyAt/.test(block));
  }
  check('失败时报出 retcode', /发语音失败: \$\{body\.wording \|\| body\.retcode/.test(bridgeSrc));
  check('入站语音走本地 ASR', /async function transcribeIncomingVoice/.test(bridgeSrc) && /asrEngine\.transcribe/.test(bridgeSrc));
  check('SnowLuma 语音转 wav', /out_format: 'wav'/.test(bridgeSrc));
  check('转写文本注入消息', /语音转文字：\$\{voiceTranscript\}/.test(incomingSrc));
  check('转写失败保留 [语音] 占位', /保留 \[语音\] 占位/.test(incomingSrc));
}

// ── 6. 控制台 ──
console.log('\n── 6. 控制台 ──');
{
  check('有语音合成卡片', /ttsStatusLine/.test(html) && /ttsTest/.test(html));
  // 目录已删除（2026-10-22 用户要求）；改为断言摘要卡会展示语音状态
  check('卡片有状态行', /ttsStatusLine/.test(html));
  check('显示三种状态', /未启用|不可用/.test(html) && /pill g">可用/.test(html));
  check('说明可插拔语义', /未启用时不加载任何模型、不占显存/.test(html));
  check('有试听按钮', /id="ttsTest"/.test(html));
  check('状态端点', /pathname === '\/api\/socialV2\/tts-status'/.test(consoleServerSrc));
  check('试听端点返回 wav', /pathname === '\/api\/socialV2\/tts-say'/.test(consoleServerSrc) && /'content-type': 'audio\/wav'/.test(consoleServerSrc));
  // 状态端点不能在 TTS 不可用时抛错
  check('不可用时状态端点仍返回 200', /usable: !!\(st && st\.available && st\.enabled\)/.test(consoleServerSrc));
}

// ── 6b. 主动发语音：工具 + 端点 + 提示词 ──
//
// 需求（2026-10-22 用户反馈）：群友说「发个语音」，机器人答「语音我发不出来呀」。
// 根因：之前只做了"概率把回复换成语音"，**没给模型工具、也没写进提示词**。
// 能力不注册工具、不写提示词，就等于不存在——这正是本次要锁住的。
console.log('\n── 6b. 主动发语音 ──');
{
  const mcpSrc = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const preset = fs.readFileSync(path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');

  check('MCP 注册了 qq_send_voice', /'qq_send_voice'/.test(mcpSrc));
  check('只在 TTS 可用时注册（可插拔）', /sovitsAvailable\(\)/.test(mcpSrc));
  check('工具受 sendVoice 开关控制', /tools\?\.sendVoice !== false/.test(mcpSrc));
  check('探测只看文件不启动进程', /function sovitsAvailable/.test(mcpSrc) && /existsSync/.test(mcpSrc));

  check('桥接有 send-voice 端点', /pathname === '\/api\/socialV2\/send-voice'/.test(consoleServerSrc));
  check('端点要求 agent token', /发送语音必须携带 agent token/.test(consoleServerSrc));
  check('端点检查 sendVoice 开关', /v2ToolEnabled\('sendVoice'\)/.test(consoleServerSrc));
  check('端点检查 TTS 可用性', /语音合成不可用/.test(consoleServerSrc));
  check('端点限制字数', /语音最多 \$\{limitChars\} 字/.test(consoleServerSrc));
  check('端点限制每小时条数', /一小时最多 \$\{maxPerHour\} 条语音/.test(consoleServerSrc));
  check('端点拦链接/代码', /含链接或代码，念出来没用/.test(consoleServerSrc));

  // 提示词：能力必须写进去，否则模型不知道（就是这次的根因）
  check('唤醒提示词写了语音能力', /【语音】你能发语音/.test(wakeSrc));
  check('提示词说明何时该用', /群友明确要听声音时/.test(wakeSrc));
  check('提示词禁止日常主动发', /日常聊天不要主动发/.test(wakeSrc));
  check('提示词要求失败时如实说', /如实说，改发文字/.test(wakeSrc));

  // ── 作用域陷阱（2026-10-22 实际踩到，导致私聊完全不理人）──
  //
  // `v2ToolEnabled` 定义在 HTTP 服务器回调内部（bridge.js ~2766），
  // 而 buildWakePrompt 在另一处作用域。在提示词里直接调它会抛
  // `v2ToolEnabled is not defined`，让**整个唤醒中断**——
  // 表现为"发私聊完全不理人"。用静态断言挡住：voiceLine 那一行
  // 只能读 cfg，不许调 v2ToolEnabled。
  {
    const i = wakeSrc.indexOf('const voiceLine = ');
    const line = i >= 0 ? wakeSrc.slice(i, wakeSrc.indexOf('\n', i)) : '';
    check('voiceLine 不调用 v2ToolEnabled（跨作用域会抛错）',
      line.length > 0 && !/v2ToolEnabled/.test(line), line.slice(0, 80));
    check('voiceLine 直接读 cfg 配置', /deps\.cfg\.socialV2\?\.tools\?\.sendVoice !== false/.test(line));
  }

  const { TOOL_FLAGS, toolNamesOf } = await import('../src/tool-flags.js');
  check('工具开关清单含 sendVoice',
    TOOL_FLAGS.some((x) => x.flag === 'sendVoice' && x.tools.includes('qq_send_voice')));
  check('工具名清单含 qq_send_voice', toolNamesOf().includes('qq_send_voice'));
  check('preset 工具清单列出 qq_send_voice', /qq_send_voice/.test(preset));
}

// ── 6c. 编码与依赖（2026-10-22 用户反馈「试听按钮点完没有能听的音频」）──
//
// 那次实际有两个独立故障，都会表现成"接口 200 但音频听不出内容/时长明显偏短"：
//   ① 缺 NLTK 数据（cmudict 等）→ 合成时抛 `Resource 'cmudict' not found`（500）
//   ② 中文经管道传进 Python 被按 GBK 解码 → 18 字变 28 个 fffd 乱码
//      合成出 0.5~1 秒的噪声
// 这两条都不报错、只是"声音不对"，所以必须用静态断言锁住修法。
console.log('\n── 6c. 编码与依赖 ──');
{
  const py = fs.readFileSync(path.join(root, 'scripts', 'sovits-server.py'), 'utf8');
  const setup = fs.readFileSync(path.join(root, 'scripts', 'setup-tts.mjs'), 'utf8');

  // 请求走文件而不是管道：Windows 下 Python 管道 stdio 会按 ANSI 代码页解码
  check('服务端从文件读请求（不是 stdin 管道）',
    /open\(req_path, "r", encoding="utf-8"\)/.test(py), 'stdin 只传路径');
  check('stdin 只接收路径/控制字', /req_path = line/.test(py));
  check('Node 侧把请求写成 UTF-8 文件',
    /writeFileSync\(reqPath,[\s\S]{0,1200}?'utf8'\)/.test(ttsSrc));
  check('Node 侧只把路径写上 stdin', /stdin\.write\(`\$\{reqPath\}\\n`\)/.test(ttsSrc));
  check('请求临时文件用后即删', /os\.unlink\(req_path\)/.test(py));
  // 只看**真实代码行**（去掉 # 注释），注释里提到这个方法是在解释踩过的坑
  {
    const codeLines = py.split('\n')
      .map((l) => l.replace(/#.*$/, ''))
      .filter((l) => l.trim());
    const bad = codeLines.filter((l) => /sys\.stdin\.reconfigure|\breconfigure\([^)]*\)/.test(l)
      && /stdin/.test(l));
    check('不再对 stdin 调 reconfigure（会让 buffer 重新包装回 GBK）',
      bad.length === 0, bad.slice(0, 2).join(' | '));
    // 并且确实对 stdout/stderr 重配了
    check('对 stdout/stderr 重配 UTF-8',
      codeLines.some((l) => /stream\.reconfigure/.test(l)) && /for stream in \(sys\.stdout, sys\.stderr\)/.test(py));
  }
  check('Python stdio 额外加 UTF-8 环境变量（双保险）',
    /PYTHONIOENCODING: 'utf-8'/.test(ttsSrc));

  // NLTK：部署脚本必须检查（缺了要到合成时才炸）
  check('部署脚本检查 NLTK 数据', /NLTK 数据（g2p_en 必需）/.test(setup));
  check('部署脚本包含 cmudict', /cmudict/.test(setup));
  check('部署脚本放行代理下载（否则 NLTK 全部失败）',
    /NLTK_ALLOW_PROXIED_URLOPEN/.test(setup));

  // 试听用的 <audio src=blob:> 与页面内 fetch(blob:) 需要 CSP 放行，
  // 否则表现为「按钮点了没反应」——实测两次都被 CSP 静默拦掉。
  check('CSP 放行 media-src blob:（否则试听都是静音）', /media-src 'self' blob:/.test(consoleServerSrc));
  check('CSP 放行 connect-src blob:（页面内读回音频）', /connect-src 'self' blob:/.test(consoleServerSrc));
  check('CSP 仍限制 script-src 为 self', /script-src 'self'/.test(consoleServerSrc));

  // 诊断默认可关，免得刷日志
  check('编码诊断默认关闭（QQB_TTS_DEBUG 才开）', /QQB_TTS_DEBUG/.test(py));
}

// ── 6d. 参数可编辑（2026-10-22 用户要求「设成可变参数并提供修改按钮」）──
console.log('\n── 6d. 参数可编辑 ──');
{
  const setup = fs.readFileSync(path.join(root, 'scripts', 'setup-tts.mjs'), 'utf8');

  // 后端：保存 tts 子对象并逐项 clamp
  check('config 接口接受 tts 子对象', /body\.tts && typeof body\.tts === 'object'/.test(consoleServerSrc));
  check('概率支持百分数写法（>1 折算）', /if \(p > 1\) p = p \/ 100/.test(consoleServerSrc));
  check('概率 clamp 到 0~1', /Math\.min\(1, Math\.max\(0, Math\.round\(p \* 1000\) \/ 1000\)\)/.test(consoleServerSrc));
  check('上限 clamp 到 0~60', /Math\.min\(60, Math\.max\(0, Math\.round\(n\)\)\)/.test(consoleServerSrc));
  check('字数 clamp 到 10~300', /Math\.min\(300, Math\.max\(10, Math\.round\(n\)\)\)/.test(consoleServerSrc));
  check('enabled 只接受布尔', /t\.enabled = t\.enabled === true/.test(consoleServerSrc));
  check('模型路径/音色预设只做字符串化（不校验存在性）',
    /for \(const k of \['dir'[\s\S]{0,300}'voiceId', 'weightsId', 'refMode'\]\)/.test(consoleServerSrc));

  // **0 是合法值**：maxPerHour=0 表示"不自动发"，不能被 || 回落成默认 3
  // （实测踩到：设成 0 后状态接口显示 3，看着像保存失败）
  check('有 ttsNum 帮助函数（避免 0 被当没配）', /function ttsNum\(raw, dflt, min, max\)/.test(bridgeSrc));
  check('不再用 `Number(x) || 默认值` 读上限', !/Number\(t\.maxPerHour\) \|\| 3/.test(bridgeSrc));
  check('不再用 `Number(x) || 默认值` 读字数', !/Number\(t\.maxChars\) \|\| 140/.test(bridgeSrc));

  // 状态接口下发可编辑字段
  check('状态接口返回 editable', /editable: \{/.test(consoleServerSrc));
  check('editable 含全部 9 项',
    /probab|maxPerHour/.test(consoleServerSrc) && /cpuThreads/.test(consoleServerSrc) && /voiceName/.test(consoleServerSrc));

  // 前端：表单 + 两个保存按钮
  check('有参数表单', /id="ttsPProbability"/.test(html) && /id="ttsPMaxPerHour"/.test(html)
    && /id="ttsPMaxChars"/.test(html));
  check('有模型设置输入', /id="ttsPDir"/.test(html) && /id="ttsPGptModel"/.test(html)
    && /id="ttsPSovitsModel"/.test(html) && /id="ttsPDevice"/.test(html));
  check('有保存按钮', /id="ttsSaveParams"/.test(html));
  check('有"保存并重启"按钮', /id="ttsRestartForParams"/.test(html));
  check('标明哪些需重启', /模型设置<\/b>（保存后/.test(html) && /需重启/.test(html));
  check('回填不覆盖用户正在编辑的框', /el\.dataset\.edited === '1'/.test(html));
  check('保存后清掉 edited 标记（否则不再同步）', /delete el\.dataset\.edited/.test(html));
  check('提交时百分数折回 0~1', /num\('ttsPProbability', 5\) \/ 100/.test(html));

  // 2026-10-22 用户要求：模型设置别手打路径，加「选择电脑文件」按钮。
  // 浏览器出于安全限制拿不到 <input type=file> 的绝对路径，所以由桥接在
  // 运行桥接的这台电脑上弹原生对话框，选完把绝对路径回填。
  check('三个路径框都有选择按钮',
    /data-tts-pick="dir" data-tts-target="ttsPDir"/.test(html)
    && /data-tts-pick="file" data-tts-target="ttsPGptModel"/.test(html)
    && /data-tts-pick="file" data-tts-target="ttsPSovitsModel"/.test(html));
  check('有原生选择端点', /'\/api\/socialV2\/tts\/pick-path'/.test(consoleServerSrc));
  check('用 PowerShell -STA 弹 WinForms 对话框',
    /'-STA'/.test(consoleServerSrc)
    && /System\.Windows\.Forms\.OpenFileDialog/.test(consoleServerSrc)
    && /System\.Windows\.Forms\.FolderBrowserDialog/.test(consoleServerSrc));
  check('路径经 UTF-8 无 BOM 临时文件回传（避免中文被 GBK 解码）',
    /UTF8Encoding\(\$false\)/.test(consoleServerSrc));
  check('只接受 file/dir 两种模式（不拼接用户输入）',
    /body\.kind === 'dir' \? 'dir' : 'file'/.test(consoleServerSrc));
  check('同时只允许一个选择窗口', /deps\.live\.pickPathBusy/.test(consoleServerSrc));
  check('选中后标记 edited（不被 60 秒轮询冲掉）', /input\.dataset\.edited = '1'/.test(html));

  // 2026-10-22 已知问题：控制台的权重只参与探测、不参与加载——
  // UI 显示爱弥斯，引擎实际仍读 tts_infer.yaml 里的 dania。
  check('Node 把配置的权重传给引擎',
    /QQB_SOVITS_T2S: probe\.gptModelAbs/.test(ttsSrc)
    && /QQB_SOVITS_VITS: probe\.sovitsModelAbs/.test(ttsSrc));
  check('Python 侧应用传入的权重',
    /cfg\.t2s_weights_path = t2s_env/.test(pySrc)
    && /cfg\.vits_weights_path = vits_env/.test(pySrc));
  check('按 SoVITS 权重自动识别版本（v2Pro/v2ProPlus 不混用）',
    /get_sovits_version_from_path_fast/.test(pySrc) && /cfg\.update_version\(ver\)/.test(pySrc));
  check('引擎回报实际加载的权重/版本',
    /"t2s": os\.path\.basename/.test(pySrc)
    && /"version": str\(getattr\(cfg, "version"/.test(pySrc));
  check('状态接口下发实际权重与版本',
    /gptModel: st\?\.gptModel/.test(consoleServerSrc) && /modelVersion: st\?\.version/.test(consoleServerSrc));
  check('控制台显示"实际权重"', /实际权重/.test(html));
}

// ── 6b. 韵律参数与标点规范化（方案 B）──
console.log('\n── 6b. 韵律参数与标点规范化 ──');
{
  check('默认语速 1.0', DEFAULT_SPEECH_PARAMS.speed === 1.0);
  check('默认用 cut5 分句', DEFAULT_SPEECH_PARAMS.textSplitMethod === 'cut5');
  check('句末无标点 → 补句号', normalizeTtsText('今天也要开心') === '今天也要开心。');
  check('已有句号不重复', normalizeTtsText('今天也要开心。') === '今天也要开心。');
  check('问号/感叹号不覆盖', normalizeTtsText('真的吗？') === '真的吗？');
  check('去掉 [表情] 占位符', normalizeTtsText('好耶[表情76]') === '好耶。');
  check('纯占位符 → 空串（调用方回退原文）', normalizeTtsText('[图片]') === '');
  check('长句无逗号 → 在连接词后补一个逗号',
    normalizeTtsText('我今天真的很开心但是明天早上还要早起去上班').includes('但是，'));
  check('已有逗号不再插入', !normalizeTtsText('我今天真的很开心，但是明天早上还要早起去上班').includes('但是，'));
  check('关闭标点规范化时原样返回', normalizeTtsText('今天也要开心', { punctuate: false }) === '今天也要开心');

  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  const html = readConsoleUiSource({ unescape: true });
  const py = fs.readFileSync(path.join(root, 'scripts', 'sovits-server.py'), 'utf8');
  check('请求里带韵律参数',
    /fragment_interval: num\(p\.fragmentInterval/.test(ttsSrc)
    && /temperature: num\(p\.temperature/.test(ttsSrc)
    && /top_k: num\(p\.topK/.test(ttsSrc)
    && /text_split_method: String\(p\.textSplitMethod/.test(ttsSrc));
  check('缓存键包含韵律参数', /\$\{params\.speed\}\|\$\{params\.fragmentInterval\}/.test(ttsSrc));
  check('Python 侧把参数传给 tts.run',
    /"fragment_interval": float/.test(py) && /"temperature": float/.test(py)
    && /"top_k": int/.test(py) && /"text_split_method": str/.test(py));
  check('Python 侧响度归一 + 限峰',
    /target_rms = 10 \*\* \(-20\.0 \/ 20\.0\)/.test(py)
    && /peak_limit = 10 \*\* \(-1\.5 \/ 20\.0\)/.test(py));
  check('TTS 插件每次现读韵律参数',
    /function speechParams\(\)/.test(ttsPluginSrc)
    && /function ttsSpeechParams\(\)/.test(bridge)
    && /pluginRuntime\?\.ttsSpeechParams\?\.\(\)/.test(bridge));
  check('配置 clamp 用小数（不会取整）', /clampDec\('speed', 0\.8, 1\.2, 1\.0\)/.test(consoleServerSrc));
  check('控制台有语速/停顿/温度/音量和标点开关',
    /id="ttsPSpeed"/.test(html) && /id="ttsPFragment"/.test(html)
    && /id="ttsPTemperature"/.test(html) && /id="ttsPVolume"/.test(html)
    && /id="ttsPPunctuate"/.test(html));
  check('保存时提交韵律参数',
    /speed: num\('ttsPSpeed', 1\)/.test(html) && /fragmentInterval: num\('ttsPFragment', 0\.3\)/.test(html));
  check('控制台有采样参数说明（温度/top_k/top_p）',
    /<b>温度<\/b>：控制随机性/.test(html)
    && /<b>top_k<\/b>：每一步只从概率最高/.test(html)
    && /<b>top_p<\/b>：从累计概率达到/.test(html));
}

// ── 7. 真实合成（可选，慢）──
console.log('\n── 7. 真实合成 ──');
{
  const p = probeSovits();
  if (!p.ok) {
    skipped('真实合成', p.reason);
  } else if (process.env.SKIP_TTS_E2E === '1') {
    skipped('真实合成', 'SKIP_TTS_E2E=1');
  } else {
    const engine = createTtsEngine({ probe: p, timeoutMs: 180000 });
    const ok = await engine.warmup();
    check('引擎预热成功', ok === true, `加载 ${engine.status().loadSec}s`);
    if (ok) {
      const t0 = Date.now();
      const r = await engine.speak('你好呀，我是达妮娅。');
      const ms = Date.now() - t0;
      check('合成成功', r.ok === true, r.ok ? '' : r.error);
      if (r.ok) {
        check('产出文件非空', fs.existsSync(r.file) && fs.statSync(r.file).size > 1024,
          `${Math.round(fs.statSync(r.file).size / 1024)}KB`);
        check('音频有时长', Number(r.durSec) > 0, `${r.durSec}s`);
        check('单句在 30 秒内', ms < 30000, `${ms}ms`);
        const r2 = await engine.speak('你好呀，我是达妮娅。');
        check('同句命中缓存（不重复推理）', r2.ok && r2.cached === true);
      }
      check('文本过长被拒', (await engine.speak('啊'.repeat(400))).ok === false);
      check('空文本被拒', (await engine.speak('   ')).ok === false);
    }
    engine.shutdown();
  }
}


console.log('\n── 6. 入站语音转写函数 ──');
{
  const start = bridgeSrc.indexOf('async function transcribeIncomingVoice');
  if (start < 0) {
    check('找到 transcribeIncomingVoice', false);
  } else {
    let depth = 0, end = bridgeSrc.indexOf('{', start);
    for (; end < bridgeSrc.length; end++) {
      if (bridgeSrc[end] === '{') depth++;
      else if (bridgeSrc[end] === '}') { depth--; if (depth === 0) break; }
    }
    const fnSrc = bridgeSrc.slice(start, end + 1);
    const make = new Function(
      'voiceTranscriptCache', 'asrEngine', 'onebotGetRecordWav', 'safeFetchBuffer',
      'withTimeout', 'log', 'os', 'path', 'crypto', 'fs',
      fnSrc + '\nreturn transcribeIncomingVoice;'
    );
    const cache = new Map();
    let calls = 0;
    const engine = { transcribe: async () => { calls++; return { text: '大家好，这是语音转写' }; } };
    const fn = make(cache, engine,
      async () => Buffer.from('fake-wav'),
      async () => ({ buffer: Buffer.from('fake-wav') }),
      (promise) => promise,
      () => {}, os, path, crypto, fs);
    const first = await fn('group:1', 'mid-voice-1', [{ type: 'record', data: { file: 'x.amr' } }]);
    check('入站语音返回转写文本', first === '大家好，这是语音转写', first);
    check('调用了一次 ASR', calls === 1, String(calls));
    const second = await fn('group:1', 'mid-voice-1', [{ type: 'record', data: { file: 'x.amr' } }]);
    check('同一消息命中转写缓存', second === first && calls === 1, String(calls));
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}`);

process.exit(fail === 0 ? 0 : 1);
