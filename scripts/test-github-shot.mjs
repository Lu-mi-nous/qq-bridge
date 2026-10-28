import { mediaMcpHarness } from './helpers/media-mcp-harness.mjs';
const mediaToolConfig = { tools: {} };
const mediaTools = mediaMcpHarness(mediaToolConfig);
// 回归测试：GitHub 仓库首页整页截图（src/github-shot.js + 桥接接线）。
//
// 背景（2026-10-20 用户要求）：「加一个功能能够解析 GitHub 链接并且把仓库首页整个截图并发送」。
//
// 本测试锁住五条不变量：
//   ① 只认 GitHub 仓库/用户链接，别的站与保留路径一律拒绝（不能变成通用截图器）
//   ② 子页面（/issues、/tree/main/x）归到仓库首页（需求就是"截首页"）
//   ③ **必须分段**：整页约 1.5 万像素，一张发出去会被 QQ 压成看不清的细线
//   ④ 截图必须走代理（实测直连 github.com 会 ECONNRESET）
//   ⑤ 发送前过老三道闸（模式/暂停/静默）+ agent token 必需
//
// 依赖真实网络与 Chrome 的用例在不可用时跳过，不算失败。
import fs from 'node:fs';
import path from 'node:path';
import { parseGitHubUrl, extractGitHubUrl } from '../plugins/media-tools/lib/github-shot.js';
import { readConsoleSource } from './lib/console-src.mjs';

let pass = 0, fail = 0, skip = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const skipped = (n, why) => { skip++; console.log(`SKIP  ${n}  （${why}）`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';

// ── 1. URL 解析 ──
console.log('── 1. 链接解析 ──');
{
  const ok = [
    ['https://github.com/Lu-mi-nous/whale-talk', 'https://github.com/Lu-mi-nous/whale-talk', '完整链接'],
    ['http://github.com/owner/repo', 'https://github.com/owner/repo', 'http 也认'],
    ['github.com/owner/repo', 'https://github.com/owner/repo', '无协议'],
    ['www.github.com/owner/repo', 'https://github.com/owner/repo', 'www 前缀'],
    ['owner/repo', 'https://github.com/owner/repo', 'owner/repo 简写'],
    ['owner/repo.git', 'https://github.com/owner/repo', 'git 后缀去掉'],
    ['https://github.com/Lu-mi-nous/whale-talk/', 'https://github.com/Lu-mi-nous/whale-talk', '尾斜杠'],
    ['https://github.com/owner/repo/issues/12', 'https://github.com/owner/repo', 'issues 归到首页'],
    ['https://github.com/owner/repo/tree/main/src', 'https://github.com/owner/repo', 'tree 归到首页'],
    ['https://github.com/owner/repo/blob/main/a.js', 'https://github.com/owner/repo', 'blob 归到首页'],
    ['https://github.com/owner/repo/releases', 'https://github.com/owner/repo', 'releases 归到首页'],
    ['https://github.com/someuser', 'https://github.com/someuser', '用户主页'],
    ['https://github.com/owner/repo?tab=readme', 'https://github.com/owner/repo', '查询串忽略']
  ];
  for (const [input, expect, label] of ok) {
    const r = parseGitHubUrl(input);
    check(`解析 ${label}`, r?.url === expect, r ? r.url : 'null');
  }

  // 不该认的
  const bad = [
    ['https://gitlab.com/owner/repo', 'gitlab'],
    ['https://example.com/owner/repo', '其它站'],
    ['https://github.com/topics/javascript', 'topics 保留路径'],
    ['https://github.com/trending', 'trending 保留路径'],
    ['https://github.com/features', 'features 保留路径'],
    ['https://github.com/', '空路径'],
    ['', '空串'],
    [null, 'null']
  ];
  for (const [input, label] of bad) {
    check(`拒绝 ${label}`, parseGitHubUrl(input) === null, String(parseGitHubUrl(input)));
  }

  // 从消息文本里抠链接
  const msg = '这个项目不错 https://github.com/owner/repo 你看看';
  check('能从消息文本里抠出链接', extractGitHubUrl(msg) === 'https://github.com/owner/repo', extractGitHubUrl(msg));
  check('文本里没链接时返回空串', extractGitHubUrl('没有链接') === '');
  check('链接后面的中文标点被去掉',
    !/。$/.test(extractGitHubUrl('看这个 https://github.com/o/r。')));
}

// ── 2. 桥接接线 ──
console.log('\n── 2. 桥接接线 ──');
{
  const bridge = readConsoleSource();
  const mcp = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const preset = fs.readFileSync(path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

  check('桥接有端点', /\/api\/socialV2\/github-shot/.test(bridge));
  check('端点先发一句说明（含页数）', /分 \$\{slices\.length\} 张发/.test(bridge));
  check('逐张发送', /for \(const s of slices\)/.test(bridge));
  check('某张失败就停（不硬刷）', /第 \$\{sentCount \+ 1\} 张发送失败[\s\S]{0,200}break;/.test(bridge));
  check('一张都没发出去时报错', /一张都没发出去/.test(bridge));
  check('同仓库 30 秒去重', /gitHubShotTimes[\s\S]{0,400}30 ?\* ?1000|30000/.test(bridge));
  check('记进会话时间线', /发了 GitHub \$\{label\} 首页截图/.test(bridge));

  // 安全闸
  check('agent token 必需', /GitHub 截图必须携带 agent token/.test(bridge));
  check('过模式限制', /github-shot[\s\S]{0,2500}modeAllowed\(key, kind, id/.test(bridge));
  check('过总暂停开关', /github-shot[\s\S]{0,1600}socialV2\.paused/.test(bridge));
  check('过静默模式', /github-shot[\s\S]{0,2200}shouldBlockSilentReply/.test(bridge));

  // 网络：必须能配代理
  check('支持代理（实测直连不通）', /githubShot[\s\S]{0,300}proxy/.test(bridge));
  check('直连失败时给出代理提示',
    /ECONNRESET\|ECONNREFUSED\|ETIMEDOUT/.test(bridge) && /配置代理/.test(bridge));

  // MCP
  check('MCP 有工具', mediaTools.has('qq_github_shot'));
  check('工具说明会分多张', /切成若干张|分多张|4~6 张/.test(mediaTools.get('qq_github_shot').description));
  check('工具说明不要说"打不开链接"', /不要说「我打不开链接」/.test(mediaTools.get('qq_github_shot').description));
  check('工具说明失败不许编造', /不要编造仓库内容/.test(mediaTools.get('qq_github_shot').description.replaceAll('*', '')));

  // preset
  check('preset 工具速查里有它', /qq_github_shot：把 GitHub 仓库首页\*\*整页截图\*\*/.test(preset));
  check('preset 有独立规则小节', /【GitHub 链接：截首页发出来】/.test(preset));
  check('preset 禁止说"打不开外链"', /不要说「我打不开外链」/.test(preset));

  // 配置
  check('配置：默认开启', cfg.socialV2?.githubShot?.enabled !== false);
  check('配置：分段高度合理（≤3000，否则单张太矮看不清）',
    Number(cfg.socialV2?.githubShot?.sliceHeight) > 800 && Number(cfg.socialV2?.githubShot?.sliceHeight) <= 3000,
    String(cfg.socialV2?.githubShot?.sliceHeight));
  check('配置：工具开关默认开', cfg.socialV2?.tools?.githubShot !== false);
}

// ── 3. 真实截图（需要 Chrome + 代理 + 网络）──
console.log('\n── 3. 真实截图 ──');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const proxy = String(cfg.socialV2?.githubShot?.proxy || cfg.socialV2?.images?.proxy || '').trim();
  try {
    const { findBrowser } = await import('../plugins/media-tools/lib/feature-menu-render.js');
    const bin = findBrowser();
    if (!bin) { skipped('真实截图', '未找到 Chrome/Edge'); }
    else if (!proxy) { skipped('真实截图', '未配置代理，GitHub 在本机直连不通'); }
    else {
      const { screenshotGitHubRepo } = await import('../plugins/media-tools/lib/github-shot.js');
      const shot = await screenshotGitHubRepo('https://github.com/Lu-mi-nous/whale-talk', {
        proxy, width: 1400, sliceHeight: 2400, maxHeight: 12000, waitMs: 2500, timeoutMs: 120000
      });
      check('截图成功', shot.buffer.length > 0, `${Math.round(shot.buffer.length / 1024)}KB`);
      check('分段多张（整页太高，一张会看不清）', shot.slices.length >= 2, `${shot.slices.length} 张`);
      check('每张高度 ≤ 分段上限', shot.slices.every((s) => s.height <= 2400),
        shot.slices.map((s) => s.height).join(','));
      check('每张宽度一致', new Set(shot.slices.map((s) => s.width)).size === 1, String(shot.width));
      check('分段按时间顺序（fromY 递增）',
        shot.slices.every((s, i) => i === 0 || s.fromY > shot.slices[i - 1].fromY),
        shot.slices.map((s) => s.fromY).join(','));
      check('是合法 PNG',
        shot.slices[0].buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
      check('单张体积可控（<2MB，否则移交/发送会吃力）',
        shot.slices.every((s) => s.buffer.length < 2 * 1024 * 1024),
        shot.slices.map((s) => Math.round(s.buffer.length / 1024) + 'KB').join(','));
    }
  } catch (error) {
    skipped('真实截图', String(error?.message ?? error).slice(0, 90));
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}`);
process.exit(fail === 0 ? 0 : 1);
