// 回归测试：控制台「取图额度」显示。
//
// 背景（2026-10-20 用户要求「取图 API 额度能不能在控制台中加一个显示」）：
// 取图链路上有**三类互相独立的上限**，都会表现成"取不到图"，但原因完全不同——
// 混在一起排查会走错方向：
//   ① SauceNAO 反查额度：每天 100 次 / 30 秒 1 次。**唯一会"当天用完"的上游免费额度**
//   ② 拉取冷却（cooldownMs）：两次"补货"之间的最小间隔，不是额度
//   ③ 图库容量（maxFiles / maxTotalBytes）：满了会淘汰旧图，不影响继续取图
//
// 本测试锁住：
//   - 端点把这些字段都报出来（尤其 remainingToday 不能靠前端算）
//   - 窗口内用量按"当前时刻"重算，不会因为 hits 里有过期时间戳而虚高
//   - 控制台卡片存在、挂进轮询、三类分开显示
import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const bridge = fs.readFileSync(path.join(root, 'src', 'console-server.js'), 'utf8').replace(/\r\n/g, '\n');
const revSrc = fs.readFileSync(path.join(root, 'src', 'image-reverse-search.mjs'), 'utf8');
const consoleHtml = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');

console.log('── 1. 反查额度统计 ──');
{
  // stats() 必须自己给剩余量：前端算会和"跨天重置"的口径不一致
  check('stats 返回 remainingToday', /remainingToday: Math\.max\(0, FREE_DAILY_MAX - usedToday\)/.test(revSrc));
  check('stats 返回 windowUsed', /windowUsed,/.test(revSrc));
  // 窗口用量必须按当前时刻过滤，否则过期时间戳会让数字虚高
  check('窗口用量按当前时刻重算（不复用 hits.length）',
    /const windowUsed = hits\.filter\(\(t\) => now - t <= FREE_WINDOW_MS\)\.length/.test(revSrc));
  check('返回窗口何时腾出名额', /windowResetMs/.test(revSrc));
  check('保留缓存张数（同一张图不重复扣额度）', /cached: Object\.keys\(cache\)\.length/.test(revSrc));
}

console.log('\n── 2. 桥接端点 ──');
{
  check('端点存在', /\/api\/socialV2\/image-quota/.test(bridge));
  check('报图库容量', /library: lib/.test(bridge));
  check('报拉取冷却 + 是否正在拉', /cooling/.test(bridge) && /fetching: !!deps\.live\.imageFetching/.test(bridge));
  check('报反查额度（含剩余）', /remainingToday: rs\.remainingToday/.test(bridge));
  check('报发送限频（冷却/每小时）', /maxSendPerHour: Math\.max\(0, Number\(ic\.maxSendPerHour\)/.test(bridge));
  check('报各图源开关（"源没开"常被误当成额度问题）', /\n\s+sources\n/.test(bridge));
  check('图源带"有无代理"信息', /hasProxy: !!String\(srcCfg\[name\]\?\.proxy/.test(bridge));
  check('只读端点（用 GET）', /req\.method === 'GET' && url\.pathname === '\/api\/socialV2\/image-quota'/.test(bridge));
}

console.log('\n── 3. 控制台卡片 ──');
{
  check('卡片存在', /id="imageQuotaCard"/.test(consoleHtml));
  check('有状态行', /id="imgQuotaStatus"/.test(consoleHtml));
  check('反查额度单独一块', /id="imgQuotaReverse"/.test(consoleHtml));
  check('拉取冷却单独一块', /id="imgQuotaFetch"/.test(consoleHtml));
  check('图库容量单独一块', /id="imgQuotaLib"/.test(consoleHtml));
  check('图源开关单独一块', /id="imgQuotaSources"/.test(consoleHtml));
  check('有函数 refreshImageQuota', /async function refreshImageQuota/.test(consoleHtml));
  // 首屏调用：不要断言"紧跟在 refreshBiliStatus 之后"——中间后来又插入了
  // refreshTtsStatus() / refreshCacheStatus()，这条断言一度因"相邻"失效而误报。
  // 真正要保证的是：首屏那串初始化调用里确实包含它（且不在 setInterval 里）。
  check('首屏调用一次', (() => {
    const line = (consoleHtml.match(/^refresh\(\);.*$/m) || [''])[0];
    return line.includes('refreshImageQuota()');
  })());
  check('挂进 3 秒轮询', /setInterval\([\s\S]{0,300}refreshImageQuota\(\)/.test(consoleHtml));
  check('反查用完时状态行高亮', /反查额度已用完/.test(consoleHtml));
  check('未配 key 时说明不影响其它取图', /其余取图功能不受影响/.test(consoleHtml));
  check('卡片说明三类上限互相独立', /三类上限互相独立/.test(consoleHtml));
  // 防止把三类混为一谈（这是本卡片的全部意义）
  check('文案区分"额度"与"冷却"与"容量"',
    /唯一会「当天用完」的上游免费额度/.test(consoleHtml)
    && /只是两次补货之间的最小间隔/.test(consoleHtml)
    && /满了会淘汰旧图/.test(consoleHtml));
}

console.log('\n── 4. 配置项一致性 ──');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const ic = cfg.socialV2?.images ?? {};
  check('图库配置里确有 cooldownMs', Number(ic.cooldownMs) >= 0, String(ic.cooldownMs));
  check('图库配置里确有 maxSendPerHour', Number(ic.maxSendPerHour) >= 0, String(ic.maxSendPerHour));
  check('图库里确有容量上限', Number(ic.maxFiles) > 0, String(ic.maxFiles));
  const rs = cfg.imageReverseSearch ?? {};
  // 没配 key 时端点要能明确说"不可用"，而不是显示 0/100 让人误以为还有额度
  check('反查配置存在（key 是否填了不影响本测试）', typeof rs === 'object');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
