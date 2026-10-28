// 回归测试：群文件只读分类。
//
// 背景（2026-10-15 用户要求「让机器人访问群文件并且整理一下，先做只读分类」）：
// 实测群文件 API 可用（群 100002013 有 1161 个文件、6.98GB、跨 6 年）。
//
// ⚠️ **只读是硬约束**，本测试最重要的一组断言就是"没有写操作"：
// 实测 delete_group_file / upload_group_file / move_group_file 这些端点**确实存在且会真实执行**
// （我用假 file_id 测试，返回"文件 file_id 错误"= 端点真的在跑删除逻辑）。
// 群文件里的 docx/pdf（面谈准备、论文之类）删了不可恢复，所以：
//   - `src/group-files.js` 只做分类/统计/搜索，不含任何写操作
//   - 桥接只暴露 GET 端点，且不注册 delete/move/upload 类工具
//
// 另一组关键断言是**分类正确性**，尤其是 QQ 给不允许直传的类型加的 `.1` 后缀
// （实测群里有 `base.apk.1`、`apk-release.apk.1`），不剥掉就会被归进"其他"，
// 而它们实际都是 apk。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConsoleSource } from './lib/console-src.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const m = await import(new URL('../src/group-files.js', import.meta.url));
const { summarizeGroupFiles, formatSummary, searchGroupFiles, normalizeEntries, categoryOf, extOf, humanSize, dateOf, CATEGORY_ORDER } = m;

const bridgeSrc = readConsoleSource();
const mcpSrc = fs.readFileSync(path.join(root, 'src/mcp-snowluma-safe.js'), 'utf8');
const modSrc = fs.readFileSync(path.join(root, 'src/group-files.js'), 'utf8');

console.log('── 1. 只读约束（最重要）──');
{
  // 模块本身不含写操作。
  // 注意断言要**排除注释与字段名**：源码注释里解释了"写操作 API 存在但未纳入"，
  // 字段名里有 uploadTime/uploader —— 直接在原文上匹配 delete/upload 会全部误判。
  const codeOnly = modSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const writeOps = [/\.delete\w*\s*\(/i, /\.upload\w*\s*\(/i, /\.move\w*\s*\(/i, /unlinkSync/, /writeFileSync/];
  const dirty = writeOps.filter((re) => re.test(codeOnly)).map((re) => String(re));
  check('分类模块不含写操作调用', dirty.length === 0, dirty.join(','));
  check('模块未 import fs（纯逻辑，无 IO）', !/from 'node:fs'/.test(modSrc));
  check('模块未 import child_process', !/child_process/.test(modSrc));

  // 桥接端点必须只有 GET，且不碰写 API
  const epStart = bridgeSrc.indexOf("url.pathname === '/api/socialV2/group-files'");
  const epEnd = bridgeSrc.indexOf("url.pathname === '/api/socialV2/unread'");
  const epBlock = bridgeSrc.slice(Math.max(0, epStart - 200), epEnd);
  check('群文件端点是 GET（只读）', /req\.method === 'GET'[\s\S]{0,80}group-files/.test(epBlock));
  check('容量端点也是 GET', /req\.method === 'GET'[\s\S]{0,80}group-file-stats/.test(epBlock));
  check('端点未调用删除 API', !/deleteGroupFile/.test(epBlock));
  check('端点未调用上传 API', !/uploadGroupFile/.test(epBlock));
  check('端点未调用移动 API', !/moveGroupFile/.test(epBlock));
  // 端点只应调用只读 SDK 方法
  const sdkCalls = [...epBlock.matchAll(/bot\.(\w+)\(/g)].map((x) => x[1]);
  const allowed = new Set(['getGroupRootFiles', 'getGroupFileSystemInfo']);
  const badCalls = sdkCalls.filter((c) => !allowed.has(c));
  check('端点只调用只读 SDK 方法', badCalls.length === 0, sdkCalls.join(',') || '(无调用)');

  // 工具层不注册写工具
  check('MCP 未注册删除工具', !/qq_delete_group_file/.test(mcpSrc));
  check('MCP 未注册上传工具', !/qq_upload_group_file/.test(mcpSrc));
  check('MCP 未注册移动工具', !/qq_move_group_file/.test(mcpSrc));
  check('工具描述里写明只看不改', /只看不改/.test(mcpSrc));
  check('工具描述要求"做不到要如实说"', /不要假装做了/.test(mcpSrc));
}

console.log('\n── 2. 分类正确性 ──');
{
  check('pdf → 文档', categoryOf('论文.pdf') === '文档');
  check('docx → 文档', categoryOf('面谈准备.docx') === '文档');
  check('jpg → 图片', categoryOf('a.jpg') === '图片');
  check('mp4 → 音视频', categoryOf('视频.mp4') === '音视频');
  check('mp3 → 音视频', categoryOf('歌.mp3') === '音视频');
  check('zip → 压缩包', categoryOf('包.zip') === '压缩包');
  check('exe → 程序', categoryOf('setup.exe') === '程序');
  check('py → 代码', categoryOf('x.py') === '代码');
  check('大小写不敏感', categoryOf('A.PDF') === '文档');
  check('无扩展名 → 其他', categoryOf('README') === '其他');
  check('空名 → 其他', categoryOf('') === '其他');
  check('null → 其他', categoryOf(null) === '其他');

  // 关键：QQ 给不允许直传的类型加 .1 后缀（实测群里有 base.apk.1）
  check('.apk.1 剥掉后缀识别为 apk', extOf('base.apk.1') === 'apk', extOf('base.apk.1'));
  check('.apk.1 归类为程序（不是"其他"）', categoryOf('base.apk.1') === '程序', categoryOf('base.apk.1'));
  check('base(1).apk.1 也正确', extOf('base(1).apk.1') === 'apk');
  check('多层数字后缀也剥', extOf('x.zip.1.2') === 'zip', extOf('x.zip.1.2'));
  check('普通扩展名不受影响', extOf('a.pdf') === 'pdf');
  check('不在扩展名里的点号不误判', extOf('v1.2.3') === '', extOf('v1.2.3'));
}

console.log('\n── 3. 大小与时间格式化 ──');
{
  check('B', humanSize(512) === '512B');
  check('KB', humanSize(2048) === '2KB');
  check('MB', humanSize(5 * 1024 * 1024) === '5.0MB');
  check('GB', humanSize(2 * 1024 * 1024 * 1024) === '2.00GB');
  check('0 不崩', humanSize(0) === '0B');
  check('非法值不崩', humanSize(undefined) === '0B');
  check('日期格式', dateOf(1791972161).startsWith('2026-'), dateOf(1791972161));
  check('0 时间戳返回空', dateOf(0) === '');
  check('非法时间戳返回空', dateOf('abc') === '');
}

console.log('\n── 4. 规范化与统计 ──');
{
  const raw = [
    { file_name: 'a.pdf', file_size: 100, upload_time: 1700000000, uploader_name: '甲' },
    { file_name: 'b.jpg', file_size: 200, upload_time: 1700000100, uploader_name: '乙' },
    { file_name: '', file_size: 1, upload_time: 1, uploader_name: 'x' },   // 无名 → 跳过
    null,                                                                   // 非对象 → 跳过
    { file_name: 'c.pdf', file_size: 300, upload_time: 1700000200, uploader_name: '甲' },
  ];
  const { entries, skipped } = normalizeEntries(raw);
  check('跳过无名/非法条目', entries.length === 3 && skipped === 2, `entries=${entries.length} skipped=${skipped}`);
  check('字段规范化完整', entries[0].name === 'a.pdf' && entries[0].size === 100 && entries[0].category === '文档');
  check('缺上传者给占位', normalizeEntries([{ file_name: 'x.pdf' }]).entries[0].uploader === '(未知)');

  const s = summarizeGroupFiles(raw);
  check('总数正确', s.total === 3);
  check('合计大小正确', s.totalSize === 600, String(s.totalSize));
  check('分类聚合正确', s.categories.find((c) => c.category === '文档')?.count === 2);
  check('上传者聚合与排序', s.uploaders[0].uploader === '甲' && s.uploaders[0].count === 2);
  check('时间范围', s.timeRange && s.timeRange.span.includes('~'), s.timeRange?.span);
  check('大文件排行有内容', s.largest.length > 0 && s.largest[0].name === 'c.pdf');
}

console.log('\n── 5. 重名检测（只报告不清理）──');
{
  const raw = [
    { file_name: 'same.pdf', file_size: 1, upload_time: 1700000000, uploader_name: 'a' },
    { file_name: 'same.pdf', file_size: 2, upload_time: 1700000100, uploader_name: 'b' },
    { file_name: 'solo.pdf', file_size: 3, upload_time: 1700000200, uploader_name: 'a' },
  ];
  const s = summarizeGroupFiles(raw);
  check('检出 1 组重名', s.duplicates.groups === 1, String(s.duplicates.groups));
  check('多出的份数正确', s.duplicates.extraCopies === 1, String(s.duplicates.extraCopies));
  check('样例可读', s.duplicates.samples[0].includes('same.pdf'));
}

console.log('\n── 6. 搜索 ──');
{
  const raw = [
    { file_name: '陆一飞老师面谈准备.docx', file_size: 47 * 1024, upload_time: 1791972161, uploader_name: '群粥黑' },
    { file_name: '第五章习题解答.docx', file_size: 39 * 1024, upload_time: 1758900000, uploader_name: 'zch' },
    { file_name: '大图.jpg', file_size: 60 * 1024 * 1024, upload_time: 1791900000, uploader_name: '群粥黑' },
  ];
  check('关键词命中', searchGroupFiles(raw, { keyword: '面谈' }).matched === 1);
  check('关键词部分匹配', searchGroupFiles(raw, { keyword: '老师' }).matched === 1);
  check('按扩展名', searchGroupFiles(raw, { ext: 'docx' }).matched === 2);
  check('ext 带点也能匹配', searchGroupFiles(raw, { ext: '.jpg' }).matched === 1);
  check('按分类', searchGroupFiles(raw, { category: '图片' }).matched === 1);
  check('按上传者（部分匹配）', searchGroupFiles(raw, { uploader: '群粥黑' }).matched === 2);
  check('按大小过滤', searchGroupFiles(raw, { minBytes: 10 * 1024 * 1024 }).matched === 1);
  check('按时间倒序（新的在前）', searchGroupFiles(raw, {}).entries[0].name === '陆一飞老师面谈准备.docx',
    `1791972161 比 1791900000 新，应排最前；实际 ${searchGroupFiles(raw, {}).entries[0].name}`);
  check('无匹配返回 0', searchGroupFiles(raw, { keyword: '不存在xyz' }).matched === 0);
  check('limit 生效', searchGroupFiles(raw, { limit: 2 }).entries.length === 2);
  check('limit 上限 50', searchGroupFiles(raw, { limit: 999 }).returned <= 50);
}

console.log('\n── 7. 边界输入不崩 ──');
{
  check('空数组摘要', formatSummary(summarizeGroupFiles([])).includes('还没有'));
  check('null 摘要', formatSummary(null).includes('还没有'));
  check('空数组搜索', searchGroupFiles([], {}).matched === 0);
  check('null 搜索', searchGroupFiles(null, {}).matched === 0);
  check('undefined 搜索', searchGroupFiles(undefined, {}).matched === 0);
  check('摘要渲染有长度上限', formatSummary(summarizeGroupFiles(
    Array.from({ length: 3000 }, (_, i) => ({ file_name: `f${i}.pdf`, file_size: 1, upload_time: 1700000000, uploader_name: `u${i}` }))
  )).length <= 1900);
  check('分类顺序把文档排前面', CATEGORY_ORDER[0] === '文档');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
