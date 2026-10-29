// 回归测试：自拍/形象图（qq_get_self_image）。
//
// 背景（2026-10-20 用户要求「别人问及自拍时把自拍图片一并发出去」）：
// 原先 `qq_get_self_image` **只把形象图返回给模型看**，不会发到群里。
// 于是群友问「发张自拍」时，模型只能对着图描述一遍长相——它手里有图，但群里看不到。
//
// 本测试锁住四条不变量：
//   ① 默认 publish=true：要自拍就必须真的发出去，不能只描述；
//   ② 发图不能绕过既有管控（模式/暂停/静默），且失败必须如实回报（sendError）；
//   ③ 模型收到的话术跟着**实际结果**走——没发成功时绝不能让它以为发了；
//   ④ 不要再叠一次 qq_send_image（那是图库挑图，发不到本地形象图）。
//
// 只做静态接线检查（不连 QQ/DSH），所以任何时候都能跑。
import fs from 'node:fs';
import path from 'node:path';
import { readConsoleSource } from './lib/console-src.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const consoleServer = readConsoleSource();
const mcp = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');
const preset = fs.readFileSync(
  path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');

console.log('── 1. 桥接端点 ──');
{
  check('self-image 端点存在', /\/api\/socialV2\/self-image/.test(consoleServer));
  check('POST 支持 publish 参数且默认发布', /body\.publish !== false/.test(consoleServer));
  check('GET 不能发布（只允许纯预览）', /GET 仅用于预览；发布形象图必须使用 POST/.test(consoleServer));
  check('发布强制 agent token', /req\.method === 'POST' && !agentToken/.test(consoleServer));
  check('publish 时真的调发送函数',
    /if \(publish\) \{[\s\S]{0,900}onebotSendImageFile\(key, buf/.test(consoleServer));
  check('发送带可识别标签（审计/撤回用）', /label: '［自拍］'/.test(consoleServer));
  check('返回里带 published / sent', /published: publish/.test(consoleServer) && /sent: sent \|\| undefined/.test(consoleServer));
  check('发送失败回传 sendError（不静默吞掉）', /sendError: sendError \|\| undefined/.test(consoleServer));

  // 发图不能绕过既有管控
  check('遵守 reserved2 模式限制', /publish[\s\S]{0,900}live\.currentMode !== 'reserved2'/.test(consoleServer));
  check('遵守总暂停开关', /publish[\s\S]{0,900}socialV2\.paused/.test(consoleServer));
  check('遵守静默模式', /publish[\s\S]{0,900}shouldBlockSilentReply\(key\)/.test(consoleServer));

  // 记进会话时间线，否则模型下一轮不知道自己刚发过图
  check('发送后记入会话时间线', /发了张自己的形象图/.test(consoleServer));
  check('记完保存状态', /发了张自己的形象图[\s\S]{0,1500}saveSocialV2State\?\.\(\)/.test(consoleServer));

  // 发失败不能让整张图拿不到
  check('发送失败仍返回图片给模型', /catch \(error\) \{[\s\S]{0,300}sendError = String/.test(consoleServer));
}

console.log('\n── 2. MCP 工具语义 ──');
{
  check('工具存在', /'qq_get_self_image'/.test(mcp));
  check('默认发送（不传 publish 时为 true）', /publish: publish !== false/.test(mcp));
  check('MCP 通过 POST 调用发布端点', /agentApi\('\/api\/socialV2\/self-image', \{\s*method: 'POST'/.test(mcp));
  check('publish 参数暴露给模型', /publish: z\.boolean\(\)\.optional\(\)/.test(mcp));
  check('工具描述说明图会自己发出去', /并且默认同时把它发到当前会话/.test(mcp));
  check('明确禁止再调 qq_send_image 重复发', /不要再调 qq_send_image 重复发/.test(mcp));
  check('明确禁止复述"我给你发一张"', /别复述/.test(mcp));
  check('没发成功时要求如实说', /图片\*\*没能发出去\*\*/.test(mcp));
  check('只有"自己核对长相"才允许 publish=false', /你自己想确认长相但对方没要图/.test(mcp));
  check('返回里包含图片本身（模型要看得到）', /type: 'image', mimeType: data\.image\.mimeType/.test(mcp));
}

console.log('\n── 3. preset 提示 ──');
{
  check('工具速查里写了会发图', /qq_get_self_image：看自己的形象图，\*\*并默认把图发到当前会话\*\*/.test(preset));
  check('有独立的自拍规则小节', /【自拍\/长相：图要真的发出去】/.test(preset));
  check('列出群友会说的原话', /发张自拍/.test(preset) && /你长什么样/.test(preset));
  check('要求调完别复述"发一张"', /不要再复述「我给你发一张」/.test(preset));
  check('禁止凭想象描述长相', /不要凭想象描述长相/.test(preset));
  check('禁止提"人设/系统配的"', /人设/.test(preset) && /系统给我配的/.test(preset));
  check('sendError 时要如实说没发成', /sendError` 有值说明\*\*没发出去\*\*/.test(preset));
  check('别反复刷同一张图', /刚发过就别反复刷同一张/.test(preset));
}

// ── 4. 形象图资源 ──
console.log('\n── 4. 形象图资源 ──');
{
  const p = path.join(root, 'assets', 'deepseek娘.png');
  if (!fs.existsSync(p)) {
    check('形象图存在', false, p);
  } else {
    const buf = fs.readFileSync(p);
    check('形象图存在且非空', buf.length > 0, `${(buf.length / 1024).toFixed(0)}KB`);
    // 超过 1.4MB 会改走临时 HTTP 托管（也能发，但多一个失败点）
    check('体积在内联阈值内（走 base64，少一个失败点）', buf.length <= 1_400_000,
      `${(buf.length / 1024).toFixed(0)}KB`);
    check('是合法 PNG', buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47);
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
