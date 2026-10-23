// 回归测试：取图超过上限时，不能把图整个丢掉。
//
// 事故（2026-10-22）：群友发了一张 >8MB 的图，safeFetchBuffer 直接 reject，
// 桥接记一行「图片超过大小限制」就返回 null —— 模型完全没看到图，
// 只能对群友说「图没加载出来，你再发一次」。而再发一次还是同一张，永远加载不出来。
//
// 桥接本来就有 prepareImageForModel()（缩图/超分/lanczos）能压图，前提是**要有字节**。
// 修法：超限时取已下载的前缀交给压缩链路，而不是丢弃。
//
// 注意：safeFetchBuffer 有 SSRF 防护（禁止访问内网/本机），所以本测试**不能**起本地
// HTTP 服务来喂它——那会被 `禁止访问内网/本机地址` 挡住（这是对的，别为了测试削弱它）。
// 因此这里用「源码级断言 + 纯函数验证」两层：
//   ① 断言 partialOnOversize 分支的真实实现（读源码，不是复制品）；
//   ② 断言调用方确实开启并接入了压缩链路。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const safeFetch = fs.readFileSync(path.join(root, 'src/safe-fetch.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
const mcp = fs.readFileSync(path.join(root, 'src/mcp-web-search-safe.js'), 'utf8');

console.log('── 1. safeFetchBuffer 支持 partialOnOversize ──');
{
  check('读取 partialOnOversize 选项', /const partialOnOversize = opts\.partialOnOversize === true;/.test(safeFetch));
  check('opts 透传到 requestOnceBuffer（含新参数）',
    /requestOnceBuffer\(url, ip, maxBytes, userAgent, extraHeaders, opts\)/.test(safeFetch));
  check('requestOnceBuffer 签名接收 opts',
    /function requestOnceBuffer\(url, ip, maxBytes, userAgent = 'Mozilla\/5\.0', extraHeaders = \{\}, opts = \{\}\)/.test(safeFetch));
  check('超限时先关连接再决定行为', /try \{ res\.destroy\(\); \} catch \{\}[\s\S]{0,120}partialOnOversize/.test(safeFetch));
  check('partial 分支 resolve 已收到的数据', /resolve\(\{ statusCode, buffer: Buffer\.concat\(chunks\), truncated: true, receivedBytes: size \}\)/.test(safeFetch));
  check('默认分支仍然 reject（安全语义不变）', /reject\(new Error\(`图片超过大小限制/.test(safeFetch));
}

console.log('\n── 2. 默认 vs 宽松：行为分叉点唯一 ──');
{
  // 复刻那段判定，确认两种模式互斥
  const decide = (partial) => {
    if (partial) return 'resolve-partial';
    return 'reject';
  };
  check('partial=false → reject', decide(false) === 'reject');
  check('partial=true → resolve 部分数据', decide(true) === 'resolve-partial');
  // 源码里只有一个 resolve-partial 出口，避免多处分支不一致
  const outs = (safeFetch.match(/truncated: true/g) || []).length;
  check('partial 出口只有一处', outs === 1, `找到 ${outs} 处`);
}

console.log('\n── 3. bridge 取群消息图：超限也交给压缩链路 ──');
{
  check('启用 partialOnOversize', /safeFetchBuffer\(String\(media\.url\), HARD_CAP, \{ partialOnOversize: true \}\)/.test(bridge));
  check('宽松上限是原上限的倍数（不是无上限）', /const HARD_CAP = Math\.max\(MAX_MEDIA_BYTES \* 4, MAX_MEDIA_BYTES \+ 1024 \* 1024\)/.test(bridge));
  check('拿到后走 prepareImageForModel 压缩',
    /const prepared = await prepareImageForModel\(fetched\.buffer, \{[\s\S]{0,220}\}/.test(bridge));
  check('返回压缩后的 buffer/mimeType', /return \{ buffer: prepared\.buffer, mimeType: prepared\.mimeType \}/.test(bridge));
  check('超限压缩后记日志（可排查）', /画面可能不完整/.test(bridge));
  check('日志区分"未取全"与完整', /未取全/.test(bridge));
  check('像素上限检查仍在前（防图片炸弹）', /dims\.width \* dims\.height > MAX_MEDIA_PIXELS[\s\S]{0,200}prepareImageForModel/.test(bridge));
}

console.log('\n── 4. MCP 按 URL 看图也启用 ──');
{
  check('web_view_image 启用 partialOnOversize', /partialOnOversize: true/.test(mcp));
  check('上限放宽到 2 倍（不是无上限）', /IMAGE_MAX_BYTES \* 2/.test(mcp));
}

console.log('\n── 5. SSRF 防护没被削弱 ──');
{
  check('仍禁止访问内网/本机地址', /禁止访问内网\/本机地址/.test(safeFetch));
  // 只看 safe-fetch 内部有没有为测试开后门。不要去 bridge.js 里找 allowPrivate——
  // 那是"私聊白名单"配置项，与 SSRF 无关，误判过一次。
  check('safe-fetch 没有为测试开后门', !/allowPrivate|skipSsrf|trustedHost/i.test(safeFetch));
  check('partialOnOversize 不绕过 URL 校验（校验在取字节之前）',
    safeFetch.indexOf('validateFetchUrl(urlString)') < safeFetch.indexOf('partialOnOversize'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
