// 回归测试：X 置顶帖识别（findPinnedIds）。
//
// 背景（2026-10-10）：用户要「最新一条帖子」，拿到的是置顶帖——@mimi_3mi 的置顶是 6 月 8 日
// 的十周年帖，而真正最新的是 10-10 的。原因是主页列表把置顶排在最前，而 fetchPosts 一到
// limit 就提前 break，按时间排序根本没机会纠正。
//
// 判据取自真实主页 HTML（X 内嵌时间线数据）：
//   social_context:{...,context_type:"Pin",text:"已置顶"},tweet_results:$R[n]={id:"...",rest_id:"<id>"
// syndication 详情接口不返回置顶标记，所以只能从主页 HTML 判。
import { findPinnedIds } from '../src/x-monitor/fetch.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

console.log('── 真实片段（@mimi_3mi，2026-10-10 抓取）──');
{
  // 真实 HTML 里置顶项的形态（$R 编号会变，故用 $R[69]）
  const html = 'social_context:$R[68]={__isTimelineSocialContext:"TimelineGeneralContext",'
    + '__typename:"TimelineGeneralContext",context_type:"Pin",text:"已置顶"},'
    + 'tweet_results:$R[69]={id:"VHdlZXRSZXN1bHRzOjIwNjQwMDkxNzU4MzE5MjA4MzQ=",rest_id:"2064009175831920834",result:$R[70]={...';
  const got = findPinnedIds(html);
  check('检出 1 个置顶', got.size === 1, JSON.stringify([...got]));
  check('id 正确', got.has('2064009175831920834'));
}

console.log('\n── 无置顶的账号：不能误报 ──');
{
  // @thsottiaux / @sama 实测都没有 context_type:"Pin"
  const html = 'timeline:$R[60]={id:"ProfileOriginalsProduct-Timeline",instructions:$R[61]=['
    + '$R[62]={__typename:"TimelineClearCache"},$R[63]={__typename:"TimelineAddEntries",entries:[...]}]};';
  check('无 Pin 时返回空集', findPinnedIds(html).size === 0);
  check('普通 social_context 不算置顶', findPinnedIds('social_context:{context_type:"Follow",text:"你关注的人"}').size === 0);
}

console.log('\n── $R 编号变化：判据不能写死 ──');
{
  const make = (n) => 'context_type:"Pin",text:"已置顶"},tweet_results:$R[' + n + ']={id:"x",rest_id:"1234567890123456789"';
  check('$R[3]', findPinnedIds(make(3)).has('1234567890123456789'));
  check('$R[200]', findPinnedIds(make(200)).has('1234567890123456789'));
  check('$R[9999]', findPinnedIds(make(9999)).has('1234567890123456789'));
}

console.log('\n── 多个置顶（理论上少见，但要能全收）──');
{
  const html = 'context_type:"Pin",text:"已置顶"},tweet_results:$R[1]={id:"a",rest_id:"1111111111111111111"'
    + ' ... context_type:"Pin",text:"已置顶"},tweet_results:$R[2]={id:"b",rest_id:"2222222222222222222"';
  const got = findPinnedIds(html);
  check('检出 2 个', got.size === 2, JSON.stringify([...got]));
}

console.log('\n── 边界与安全 ──');
{
  check('空串', findPinnedIds('').size === 0);
  check('null 不抛', findPinnedIds(null).size === 0);
  check('undefined 不抛', findPinnedIds(undefined).size === 0);
  // 不能把「Pin 出现在很远之后」的无关 id 误当成置顶（限制匹配跨度）
  const far = 'context_type:"Pin"' + 'x'.repeat(5000) + 'tweet_results:$R[1]={id:"a",rest_id:"1111111111111111111"';
  check('跨度过大不误匹配', findPinnedIds(far).size === 0);
  // id 必须是 15-25 位数字
  check('非数字 id 不匹配', findPinnedIds('context_type:"Pin"},tweet_results:$R[1]={id:"a",rest_id:"abc"').size === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
