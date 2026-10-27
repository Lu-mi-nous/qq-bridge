// 回归测试：控制台「凭据与连接配置」卡片。
//
// 需求（2026-10-20 用户）：「把所有待配置项（如 api key、cookie 凭据等）放在控制台中
// 并且做成密码样式（右侧含有隐藏/显示按钮），并且增加保存键（如需重启桥接等也放在其中），
// 并且在本地加上每个待配置项的说明文档（markdown 格式），在相应密码框旁边放置链接按钮」。
//
// 本测试盯住五件事：
//   ① 每个待配置项都有说明文档（不能有"孤零零"的输入框）
//   ② 默认**绝不下发明文**（列表只给脱敏预览），点眼睛才单条读取
//   ③ 需重启 / 即时生效 的标注必须准确
//   ④ 写入有形态校验（代理格式、令牌长度），且失败不回写文件
//   ⑤ 控制台侧：密码框 + 眼睛按钮 + 说明按钮 + 保存键 + 重启键 + 弹窗动画
import fs from 'node:fs';
import path from 'node:path';
import { CREDENTIAL_ITEMS, credentialByKey, groupedCredentials, maskValue } from '../src/credentials-doc.js';
import { createConfigItems as createImagesConfigItems } from '../plugins/images/config-items.js';
import { createConfigItems as createBiliConfigItems } from '../plugins/bili/config-items.js';
import { createConfigItems as createXConfigItems } from '../plugins/x-posts/config-items.js';
import { createConfigItems as createWebSearchConfigItems } from '../plugins/web-search/config-items.js';
import { createConfigItems as createMediaToolsConfigItems } from '../plugins/media-tools/config-items.js';
import { readConsoleSource } from './lib/console-src.mjs';
import { readConsoleUiSource } from './lib/console-ui-src.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1') + '/..';
const fakeCtx = {
  root,
  config: { get: () => ({}), set: () => true },
  secrets: { readJson: () => ({}), writeJson: () => true }
};
const pluginItems = [
  ...createImagesConfigItems(fakeCtx),
  ...createBiliConfigItems(fakeCtx),
  ...createXConfigItems(fakeCtx),
  ...createWebSearchConfigItems(fakeCtx),
  ...createMediaToolsConfigItems(fakeCtx)
];
const allItems = [...CREDENTIAL_ITEMS, ...pluginItems];

console.log('── 1. 配置项定义 ──');
{
  check('核心配置项保留 SnowLuma/控制台令牌', CREDENTIAL_ITEMS.length === 2, String(CREDENTIAL_ITEMS.length));
  check('插件配置项全部由插件注册', pluginItems.length === 11, String(pluginItems.length));
  check('配置项总数 13', allItems.length === 13, String(allItems.length));

  const keys = allItems.map((x) => x.key);
  check('key 唯一', new Set(keys).size === keys.length);

  // 核心项写 config.json；插件项通过插件自己的 get/set 管理
  check('核心项都有写入位置', CREDENTIAL_ITEMS.every((x) => x.where === 'config' || (x.where === 'file' && x.file)));
  check('核心项都有路径/字段名', CREDENTIAL_ITEMS.every((x) => !!x.path));
  check('每项都有标签', allItems.every((x) => !!x.label));
  check('每项都有分组', allItems.every((x) => !!x.group));

  // ① 文档：不能缺
  const noDoc = allItems.filter((x) => !x.doc || x.doc.trim().length < 40);
  check('每项都有说明文档（≥40 字）', noDoc.length === 0, noDoc.map((x) => x.key).join(','));

  // 文档要包含"怎么取"与"生效方式"这类可操作信息
  const docs = allItems.every((x) => /怎么取|怎么拿|格式|怎么用/.test(x.doc));
  check('文档都写了"怎么取/格式"', docs);
  const effect = allItems.every((x) => /生效方式|立即生效|需要重启/.test(x.doc));
  check('文档都写了"生效方式"', effect);

  // ③ restart 标注与文档一致
  const mismatch = allItems.filter((x) =>
    (x.restart && !/需要重启|需重启/.test(x.doc)) || (!x.restart && !/立即生效/.test(x.doc)));
  check('restart 标注与文档一致', mismatch.length === 0, mismatch.map((x) => x.key).join(','));

  // 凭据类必须打码，连接类可以是明文
  const secrets = allItems.filter((x) => x.kind === 'secret');
  check('有 secret 类型项', secrets.length > 0);
  check('kind 只能是 secret/text', allItems.every((x) => x.kind === 'secret' || x.kind === 'text'));

  check('按 key 查找', credentialByKey('snowlumaAccessToken')?.label?.includes('SnowLuma'));
  check('未知 key 返回 null', credentialByKey('nope') === null);
  const grouped = groupedCredentials();
  check('核心项按凭据分组', grouped.length === 1 && grouped[0].group === '凭据' && grouped[0].items.length === 2,
    grouped.map((g) => `${g.group}:${g.items.length}`).join(' '));
}

console.log('\n── 2. 脱敏 ──');
{
  check('空值返回空串', maskValue('') === '');
  check('短值全打码', maskValue('abc') === '•••', maskValue('abc'));
  check('8 位以内全打码', maskValue('12345678') === '••••••••');
  const m = maskValue('d4f77df44d0415ff6cb158590a035d35ce290c00');
  check('长值露前 2 后 2', m.startsWith('d4') && m.endsWith('00'), m);
  check('中间是圆点', /•/.test(m));
  // 关键：脱敏结果不能包含原值的可识别中段
  const raw = 'd4f77df44d0415ff6cb158590a035d35ce290c00';
  check('不泄露中段', !m.includes(raw.slice(8, 20)));
  check('长度被限制（不会把原文长度暴露得太清楚）', m.length <= raw.length, `${m.length} vs ${raw.length}`);
  check('null 不崩', maskValue(null) === '');
}

console.log('\n── 3. 桥接接线 ──');
{

  const consoleServer = readConsoleSource();
  const adminCommands = fs.readFileSync(path.join(root, 'src', 'admin-commands.js'), 'utf8');
  check('有读取端点', /\/api\/socialV2\/credentials/.test(consoleServer));
  check('有写入（POST）分支', /req\.method === 'POST' && url\.pathname === '\/api\/socialV2\/credentials'/.test(consoleServer));

  // ② 默认不下发明文
  // secret 类：默认只回脱敏预览；text 类（代理等非秘密）直接给明文（用户 2026-10-20 要求）
  check('secret 默认只回脱敏预览',
    /preview: configured && item\.kind !== 'text' \? maskValue\(r\.value\) : ''/.test(consoleServer));
  check('secret 明文仅在 reveal+单 key 时给',
    /reveal && only\) \? \(r\.ok \? r\.value : ''\) : ''/.test(consoleServer));
  check('连接类（kind=text）直接给明文',
    /value: item\.kind === 'text'/.test(consoleServer));
  check('明文仅在 reveal + 单 key 时给',
    /\(reveal && only\) \? \(r\.ok \? r\.value : ''\) : ''/.test(consoleServer));
  

  // ④ 校验
  check('拒绝未知 key', /未知配置项/.test(consoleServer));
  check('代理格式校验', /代理地址应形如/.test(consoleServer));
  check('控制台令牌长度校验', /控制台令牌至少 16 位/.test(consoleServer));
  check('过短值拒绝', /这个值太短了/.test(consoleServer));
  // 失败不回写：write 在 try 里，readJsonSafe 用 required=true
  check('配置损坏时 fail-fast（不回写）', /readJsonSafe\(deps\.configFile, null, true\)/.test(adminCommands));

  // 不把值写进日志
  check('日志不含明文（只记长度）', /已更新 \$\{item\.key\}\$\{value \? `（\$\{value\.length\} 字符）`/.test(consoleServer));
  

  // ③ 返回 applied 让前端知道生效没
  check('返回 applied 标记', /applied: item\.restart !== true/.test(consoleServer));
  check('返回 restart 标记', /restart: item\.restart === true/.test(consoleServer));

  // 反查 key 支持热更新
  check('反查器支持运行时改 key', /setApiKey/.test(consoleServer));
  const revSrc = fs.readFileSync(path.join(root, 'plugins', 'images', 'lib', 'image-reverse-search.mjs'), 'utf8');
  check('反查器 apiKey 可变更（let 而非 const）', /let currentApiKey/.test(revSrc));
  check('反查器导出 setApiKey', /return \{ available, search, stats, setApiKey, DB_INDEX \}/.test(revSrc));

  // 重启复用既有端点
  check('重启端点已存在（无需新增）', /url\.pathname === '\/api\/restart'/.test(consoleServer));
}

console.log('\n── 4. 控制台 UI ──');
{
  const html = readConsoleUiSource();
  check('有通用配置卡模块', /export async function mount\(container, ctx/.test(html) && /configEndpoint/.test(html));
  check('有列表容器', /class="cred-body"/.test(html));
  check('有保存按钮', /class="small cred-save"/.test(html));
  check('有重启按钮', /class="small cred-restart"/.test(html));
  check('有状态行', /class="meta cred-status"/.test(html));

  // 密码框 + 眼睛
  // 隐藏态用**真 input**（不是 div、不是 type=password），靠 CSS 渲染成圆点——
  // 用户要求「圆点也是可选元素，全选复制能拿到明文」。
  check('隐藏态是真正的 input（可选/可复制）', /data-cred="\$\{esc\(item\.key\)\}"/.test(html));
  check('用 CSS 把明文渲染成圆点（-webkit-text-security）', /-webkit-text-security: disc/.test(html));
  check('有眼睛按钮', /data-eye=/.test(html) && /👁/.test(html));
  // 回归（2026-10-22）：说明文字里也有一个内联 👁，曾与按钮共用 .cred-eye 的绝对定位，
  // 结果被顶到弹窗极右侧、看起来像"多出来一个眼睛按钮"。
  // 现在绝对定位只作用于 .cred-input-wrap 内的按钮，内联图标用 .cred-eye-inline。
  check('眼睛的绝对定位只在输入框容器内',
    /\.cred-input-wrap \.cred-eye \{[\s\S]{0,120}position: absolute/.test(html));
  // 取出 `.cred-eye { ... }` 基类块（行首匹配，避免误命中 `.cred-input-wrap .cred-eye {`）
  const baseEye = /^[ \t]*\.cred-eye \{([\s\S]*?)^[ \t]*\}/m.exec(html)?.[1] ?? '';
  check('.cred-eye 基类不含绝对定位',
    !!baseEye && !/position\s*:\s*absolute/.test(baseEye), baseEye.slice(0, 60));
  check('说明里的眼睛用内联样式类', /class="cred-eye-inline"/.test(html));
  check('眼睛按需取明文（reveal=1&key=）', /reveal=1&key=/.test(html));
  check('收起时填回脱敏串（不把明文留在 DOM）',
    /input\.value = input\.dataset\.preview \|\| ''/.test(html) && /classList\.add\('masked'\)/.test(html));
  check('输入时自动去掉遮罩（否则自己输入也看不见）', /classList\.remove\('masked'\)/.test(html));

  // 说明按钮
  check('有说明按钮（?）', /data-doc=/.test(html) && /cred-guide/.test(html));
  check('点说明打开弹窗', /openCredDoc\(/.test(html));
  // 文档来自服务端，不是前端硬编码
  // 文档由服务端下发、前端渲染；复用控制台已有的 renderMd（支持代码块/列表/引用）
  check('文档由服务端提供（前端渲染）', /renderMd\(item\.doc/.test(html));
  check('复用既有 markdown 渲染器（不重复实现）', !/function renderMarkdown/.test(html));

  // 弹窗 + 动画
  check('有文档弹窗', /credDocOverlay/.test(html));
  check('弹窗带过渡动画', /\.doc-overlay[\s\S]{0,300}transition: opacity/.test(html));
  check('弹窗内容也有位移动画', /\.doc-modal[\s\S]{0,400}transform: translateY/.test(html));
  check('打开时加 open 类', /classList\.add\('open'\)/.test(html));
  check('关闭时移除 open 类', /classList\.remove\('open'\)/.test(html));
  check('支持 Esc 关闭', /e\.key === 'Escape'/.test(html));
  check('点遮罩关闭', /e\.target\?\.id === 'credDocOverlay'/.test(html));

  // markdown 渲染安全：只允许 http(s) 链接
  check('markdown 链接只允许 http(s)', /const safeHref = \(u\) =>/.test(html) && /https\?:/ .test(html));
  check('渲染前转义 HTML', /const inline = \(t\) => \{\s*let s = esc\(t\)/.test(html));

  // 保存只提交改过的项
  check('只保存改过的项', /const edited = new Map\(\)/.test(html));
  // 关键安全点：隐藏态输入框里是脱敏串，绝不能当新值写盘（会把密钥覆盖成圆点）
  // 待提交值存在内存 Map 里，DOM 重建不丢（"只保存最早一项"的根因修复）
  check('待提交值存 Map（DOM 重建不丢）', /const edited = new Map\(\)/.test(html));
  check('输入时写入 Map', /edited\.set\(input\.dataset\.cred, read\(\)\)/.test(html));
  check('渲染时回填未保存的编辑', /const pending = edited\.get\(input\.dataset\.cred\)/.test(html));
  // 刷新（load）里不能再无条件清空待提交表
  check('刷新不无条件清空待提交表', !/edited\.clear\(\);/.test(html));
  check('只在保存成功后移除成功项', /for \(const key of okKeys\) edited\.delete\(key\)/.test(html));
  check('保存后重新拉取', /await load\(\)/.test(html));
  check('首屏加载', /await load\(\);/.test(html));

  // 重启按钮：确认为破坏性操作 + 等待恢复
  check('重启前有确认', /confirm\('确定重启桥接/.test(html));
  check('重启后轮询等待恢复', /桥接已恢复/.test(html));
}

console.log('\n── 5. 与真实配置的一致性 ──');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  // config 类项：路径必须真实存在（允许为空字符串）
  const cfgItems = CREDENTIAL_ITEMS.filter((x) => x.where === 'config');
  for (const it of cfgItems) {
    let cur = cfg;
    for (const k of it.path.split('.')) { cur = cur?.[k]; }
    check(`config 项 ${it.key} 路径存在`, cur !== undefined, JSON.stringify(cur));
  }
  // file 类项：state 下文件若存在，字段名要对得上（允许未配置）
  const fileItems = CREDENTIAL_ITEMS.filter((x) => x.where === 'file');
  for (const it of fileItems) {
    const f = path.join(root, 'state', it.file);
    if (!fs.existsSync(f)) { check(`state 项 ${it.key} 文件存在（或未配置）`, true); continue; }
    const obj = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    const hasField = Object.prototype.hasOwnProperty.call(obj, it.path);
    const hasOther = Object.keys(obj).some((k) => !k.startsWith('_'));
    check(`state 项 ${it.key} 字段名匹配`, hasField || !hasOther,
      hasField ? '' : `字段 ${it.path} 不在 ${it.file} 里`);
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
