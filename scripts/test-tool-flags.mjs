// 回归测试：工具开关清单（src/tool-flags.js）与控制台渲染。
//
// 需求（2026-10-20 用户）：「目前的工具开关卡片过于复杂，似乎还有遗漏项目，
// 查漏补缺后重新设计视觉元素」。
//
// 查漏发现的真问题：
//   - MCP 注册 55 个工具，旧控制台只有 30 个复选框；
//   - 其中 10 个**真正生效**的开关没有 UI（archiveImage / imageSource / reactMessage /
//     rejectImage / refreshImageLib / reverseSearch / sendImage / getFeatureMenu /
//     groupFiles / deleteSticker）——用户没法关掉它们；
//   - 另有 4 个工具（qq_status / qq_list_groups / qq_get_group_members /
//     qq_get_group_history）无条件注册，完全没有开关，也没在任何地方说明。
//
// 根因：清单写死在控制台 HTML 里，加工具时容易只改一边。
// 修法：清单唯一来源 = src/tool-flags.js，控制台从 /api/socialV2/tool-flags 读。
//
// 本测试锁住：
//   ① 清单覆盖 MCP 实际注册的**每一个**工具（不漏）
//   ② 清单里没有 MCP 不存在的工具（不多）
//   ③ flag 无重复、每项都有分组与说明
//   ④ 控制台不再硬编码复选框（防止漂移复发）
//   ⑤ 视觉元素具备（搜索/折叠/批量/危险标识/不可关闭标识）
import fs from 'node:fs';
import path from 'node:path';
import { TOOL_FLAGS, toolNamesOf, groupedToolFlags } from '../src/tool-flags.js';
import { readConsoleSource } from './lib/console-src.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const mcp = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');
const consoleServer = fs.readFileSync(path.join(root, 'src', 'console-server.js'), 'utf8');
// R4：路由已迁到分域模块，端点断言要在「主文件 + 全部路由模块」里找。
const consoleRoutes = readConsoleSource();
const html = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');

const actualTools = new Set([...mcp.matchAll(/server\.tool\(\s*\n?\s*'([^']+)'/g)].map((x) => x[1]));

console.log('── 1. 清单完整性（核心：不再漏工具）──');
{
  const declared = toolNamesOf();
  const declaredSet = new Set(declared);

  const missing = [...actualTools].filter((t) => !declaredSet.has(t));
  check('MCP 每个工具都在清单里', missing.length === 0, missing.join(','));

  const extra = [...declaredSet].filter((t) => !actualTools.has(t));
  check('清单里没有不存在的工具', extra.length === 0, extra.join(','));

  check('工具名无重复', declared.length === declaredSet.size,
    `${declared.length} 声明 vs ${declaredSet.size} 去重`);

  const flags = TOOL_FLAGS.map((x) => x.flag);
  check('flag 无重复', flags.length === new Set(flags).size);

  check('每项都有分组', TOOL_FLAGS.every((x) => !!x.group));
  check('每项都有说明', TOOL_FLAGS.every((x) => !!x.desc && x.desc.length >= 6));
  check('每项至少管一个工具', TOOL_FLAGS.every((x) => Array.isArray(x.tools) && x.tools.length > 0));
}

console.log('\n── 2. 曾遗漏的开关现在都在 ──');
{
  // 这 10 个是实测"生效但没有 UI 开关"的，必须出现在清单里
  const wasMissing = [
    'archiveImage', 'imageSource', 'reactMessage', 'rejectImage',
    'refreshImageLib', 'reverseSearch', 'sendImage', 'getFeatureMenu',
    'groupFiles', 'deleteSticker'
  ];
  const flagSet = new Set(TOOL_FLAGS.map((x) => x.flag));
  for (const f of wasMissing) {
    check(`补上了 ${f}`, flagSet.has(f));
  }
  // 无条件注册的只读工具也要被显式列出（标 fixed）
  const fixed = TOOL_FLAGS.filter((x) => x.fixed);
  check('无条件工具标为 fixed（不可关闭）', fixed.length >= 4, String(fixed.length));
  check('fixed 项覆盖了 4 个基础查询',
    ['qq_status', 'qq_list_groups', 'qq_get_group_members', 'qq_get_group_history']
      .every((t) => fixed.some((f) => f.tools.includes(t))));
}

console.log('\n── 3. 分组与默认值 ──');
{
  const g = groupedToolFlags(() => true);
  check('分组数 ≥6（避免一堵墙）', g.length >= 6, String(g.length));
  check('每组都有项', g.every((x) => x.items.length > 0));
  check('分组名不重复', new Set(g.map((x) => x.group)).size === g.length);
  check('每项带 enabled 状态', g.every((x) => x.items.every((i) => typeof i.enabled === 'boolean')));
  check('fixed 项 enabled 恒为 true',
    g.every((x) => x.items.filter((i) => i.fixed).every((i) => i.enabled === true)));
  // 危险项要能标出来
  check('存在 risky 标记项', TOOL_FLAGS.some((x) => x.risky === true));
  check('写操作类默认关闭（deleteSticker / setStickerRemark）',
    TOOL_FLAGS.filter((x) => x.default === false).map((x) => x.flag).sort().join(',')
      === 'deleteSticker,setStickerRemark');
}

console.log('\n── 4. 桥接接线 ──');
{
  check('有 tool-flags 端点', /\/api\/socialV2\/tool-flags/.test(consoleRoutes));
  check('端点用 groupedToolFlags 生成', /groupedToolFlags\(/.test(consoleRoutes));
  check('保存时的白名单也从清单派生（不再手写）',
    /TOOL_FLAGS\.filter\(\(x\) => x\.fixed !== true\)\.map\(\(x\) => x\.flag\)/.test(consoleRoutes));
  check('不再有手写的 toolFlags 数组',
    !/const toolFlags = \['getPrompt'/.test(consoleRoutes));
  // P0 内容安全止血：开关必须真正控制 MCP 注册，且桥接路由在拉取前硬拦截。
  check('fetchXPosts 开关真正控制 MCP 注册',
    /if \(cfg\.socialV2\?\.tools\?\.fetchXPosts !== false\) \{\s*server\.tool\(\s*'qq_fetch_x_posts'/.test(mcp));
  check('fetchXPosts 关闭时桥接路由拒绝拉取',
    /!v2ToolEnabled\('fetchXPosts'\)/.test(consoleRoutes)
      && /X 帖子转发已临时关闭/.test(consoleRoutes));
  // R4.5-3：实现迁到 plugins/x-posts 后，插件缺席时控制台端点要明确 503，不能 500。
  check('X 插件缺席时控制台端点回 503',
    /X 插件未加载/.test(consoleRoutes)
      && /plugins\/x-posts\//.test(fs.readFileSync(path.join(root, 'plugins', 'x-posts', 'index.js'), 'utf8')));
}

console.log('\n── 5. 控制台不再硬编码 ──');
{
  // 关键回归：旧版把 30 个复选框写死在 HTML 里，这是漂移的根因。
  // 现在只应存在**模板里**的 data-v2-tool="${...}"（动态生成），不能有写死的 flag 字面量。
  check('HTML 里没有写死 flag 的复选框',
    !/<input type="checkbox" data-v2-tool="(?!\$\{)[a-zA-Z]/.test(html));
  check('至少一个复选框由动态模板生成',
    (html.match(/data-v2-tool=/g) || []).length >= 1,
    `出现 ${(html.match(/data-v2-tool=/g) || []).length} 次`);
  check('改为从接口渲染', /async function renderToolFlags/.test(html) && /api\/socialV2\/tool-flags/.test(html));
  check('有容器', /id="tfGroups"/.test(html));
  check('09 工具清单也从接口渲染', /async function refreshToolInventory/.test(html) && /id="tool09Groups"/.test(html));
  check('09 不再写死旧的 9 个工具表', !/qq_get_group_history<\/td><td>群历史/.test(html));
}

console.log('\n── 6. 新视觉元素 ──');
{
  check('有搜索框', /id="tfSearch"/.test(html));
  check('搜索按工具名+说明过滤', /tfMatches/.test(html) && /includes\(q\.toLowerCase\(\)\)/.test(html));
  check('分组可折叠', /tf-group\.collapsed/.test(html) && /collapsed\.add\(group\)/.test(html));
  check('折叠状态持久化', /TF_COLLAPSED_KEY/.test(html) && /localStorage/.test(html));
  check('每组有全开/全关', /data-group-on=/.test(html) && /data-group-off=/.test(html));
  check('顶部有全部展开/收起', /id="tfExpandAll"/.test(html) && /id="tfCollapseAll"/.test(html));
  check('顶部有全局全开/全关', /id="tfEnableAll"/.test(html) && /id="tfDisableAll"/.test(html));
  check('全关需要确认（破坏性）', /confirm\('确定关闭全部可关闭的工具开关/.test(html));
  check('危险项有红色左边条', /\.tf-item\.risky \{ border-left: 3px solid/.test(html));
  check('不可关闭项灰显', /\.tf-item\.fixed \{ opacity/.test(html));
  check('关闭的项整行变淡', /\.tf-item\.disabled-tool/.test(html));
  check('有统计行（已启用/总数/覆盖工具数）', /id="tfStats"/.test(html) && /覆盖 \$\{tfData\.toolCount\} 个工具/.test(html));
  check('搜索无结果时有空态提示', /tf-empty/.test(html));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
