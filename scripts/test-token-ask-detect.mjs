// 回归测试：群友问 token 用量时，桥接必须能认出来并要求调工具。
//
// 事故（2026-10-21，group:100002013）：
//   问「你用了多少token」→ 调了 qq_token_report（历史上成功 6 次）
//   问「看看你吃了多少token」→ **没调**
//   问「你怎么这么能吃白饭」→ **没调**，还编出「35.27B里prompt占35.25B」
//   下一条又改口「我这边没有查自己用量的口子，只能看你们截的图」
// 三类错误同时出现：**漏认说法 + 编数字 + 谎称没有能力**。
//
// 根因：只靠工具描述和提示词里列的固定触发词，而群友的说法是开放的
// （"吃了多少白饭""这么能吃"），列举永远追不上。模型对没列出的措辞不会联想。
//
// 修法：桥接自己认（`buildTokenAskLineV2`），认出来就在提示里点名要求调工具；
// 同时把「不许估算/不许说没这个口子」写进工具描述与提示词。
// 判据必须**两段同时命中**，避免 "token 是什么" / "你吃不吃 token" 这类误判。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
import { createContentRequestPolicy } from '../src/pipeline/content-request.js';
const cfg = { socialV2: { tools: {} } };
const { buildTokenAskLineV2 } = createContentRequestPolicy({ cfg });
const wakeSrc = fs.readFileSync(path.join(root, 'src/pipeline/wake.js'), 'utf8');
// R4.6-5c：qq_token_report 的描述已迁入 plugins/media-tools/mcp-tools.js。
const mcpSrc = fs.readFileSync(path.join(root, 'plugins', 'media-tools', 'mcp-tools.js'), 'utf8');

const isTokenAsk = text => !!buildTokenAskLineV2({ unread: [{ plain: text }] });

console.log('── 1. 事故里的说法必须全部认得 ──');
{
  check('「看看你吃了多少token」', isTokenAsk('看看你吃了多少token'));
  check('「你怎么这么能吃白饭」', isTokenAsk('你怎么这么能吃白饭'));
  check('「你用了多少token」', isTokenAsk('你用了多少token'));
  check('「看看你吃了多少白饭」', isTokenAsk('看看你吃了多少白饭'));
  check('「你今天耗了多少token了」', isTokenAsk('你今天耗了多少token了'));
  check('「这个月烧了多少 token」', isTokenAsk('这个月烧了多少 token'));
  check('「token 用了多少了」', isTokenAsk('token 用了多少了'));
  check('「你花了多少算力」', isTokenAsk('你花了多少算力'));
  check('「看看你的用量」', isTokenAsk('看看你的用量'));
  check('「今天跑了多少」+token 语境', isTokenAsk('token 今天跑了多少'));
}

console.log('\n── 2. 不该误判的（两段判据要同时命中）──');
{
  check('「token 是什么」排除', !isTokenAsk('token 是什么'));
  check('「token 啥意思」排除', !isTokenAsk('token 啥意思'));
  check('「你吃不吃 token」是玩笑，排除', !isTokenAsk('你吃不吃 token'));
  check('「大肥鱼吃不吃token」排除', !isTokenAsk('大肥鱼吃不吃token'));
  check('只有"多少"但没有用量词', !isTokenAsk('群里多少人了'));
  check('只有 token 但没有数量词', !isTokenAsk('token 真麻烦'));
  check('「白饭好吃吗」排除', !isTokenAsk('白饭好吃吗'));
  check('空串排除', !isTokenAsk(''));
}

console.log('\n── 3. 桥接判定函数接进了唤醒提示 ──');
{
  check('真实函数返回工具提示', buildTokenAskLineV2({ unread: [{ text: '你用了多少token' }] }).includes('本轮必须调 qq_token_report'));
  check('旧提问超过最近 8 条不再催', !buildTokenAskLineV2({ unread: [{ text: '你用了多少token' }, ...Array.from({ length: 8 }, () => ({ text: '闲聊' }))] }));
  check('自己的消息不触发', !buildTokenAskLineV2({ unread: [{ text: '你用了多少token', isSelf: true }] }));
  cfg.socialV2.tools.tokenReport = false;
  check('工具关闭时不注入', !isTokenAsk('用了多少token'));
  cfg.socialV2.tools.tokenReport = true;
  check('唤醒模块接入 token 提示', /deps\.buildTokenAskLine\(st\)/.test(wakeSrc));

}

console.log('\n── 4. MCP 工具描述也补齐了（模型看到的第二份说明）──');
{
  check('描述里含"吃了多少白饭"', /吃了多少白饭/.test(mcpSrc));
  check('描述里含"这么能吃"', /这么能吃/.test(mcpSrc));
  check('描述里明确"不要自己估算"', /不要自己估算/.test(mcpSrc));
  check('描述里明确"不要说没有查用量的口子"', /没有查用量的口子/.test(mcpSrc));
  check('提示词也含同类禁止措辞', /我没有查用量的口子/.test(buildTokenAskLineV2({ unread: [{ text: '用了多少token' }] })));
}

console.log('\n── 5. 渲染链路可用的前提 ──');
{
  // 浏览器是渲染 PNG 的硬依赖，找不到就会「图调不出来」
  const hasFindBrowser = /findBrowser/.test(fs.readFileSync(path.join(root, 'plugins', 'media-tools', 'lib', 'token-report-render.js'), 'utf8'));
  check('渲染模块通过 findBrowser 找浏览器', hasFindBrowser);
  const cacheDir = path.join(root, 'state', 'token-report');
  fs.mkdirSync(cacheDir, { recursive: true });
  check('报表缓存目录存在', fs.existsSync(cacheDir));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
