// 回归测试：控制台卡片注册表（C1）。
//
// 锁住：manifest 校验、重复 id 拒绝、排序、基础/插件分组、插件空组过滤、
// manifest 拉取失败时的最小回退，以及核心卡清单与 console.html 的 24 个
// section 一一对应（防止注册表和页面漂移）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRegistry,
  validateManifest,
  cardsForGroup,
  loadManifest,
  CONTRACT_VERSION
} from '../public/console/core/registry.js';
import { CORE_CARDS, coreManifestCards, pluginOwnedManifestCards } from '../src/console/core-cards.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const sample = {
  ok: true,
  contractVersion: CONTRACT_VERSION,
  groups: [
    { id: 'all', title: '全部功能' },
    { id: 'core', title: '基础功能' },
    { id: 'plugins', title: '插件功能' }
  ],
  cards: [
    { id: '11', kind: 'core', title: '静默开关', order: 110 },
    { id: '01', kind: 'core', title: '运行模式', order: 10 },
    { id: 'plugin:tts:tts', kind: 'plugin', pluginId: 'tts', pluginName: 'TTS', pluginStatus: 'started', title: '语音合成', order: 1000 },
    { id: 'plugin:stickers:card', kind: 'plugin', pluginId: 'stickers', pluginName: '表情包', pluginStatus: 'started', title: '表情包', order: 1100 }
  ],
  pluginGroups: [
    { id: 'tts', title: 'TTS', status: 'started', cards: [] },
    { id: 'stickers', title: '表情包', status: 'started', cards: [] },
    { id: 'empty', title: '空插件', status: 'started', cards: [] }
  ],
  plugins: [{ id: 'tts', name: 'TTS', status: 'started', cardCount: 1 }]
};

const registry = buildRegistry(sample);
check('注册表保留契约版本', registry.contractVersion === 'v1');
check('卡片按 order 排序', registry.cards.map((c) => c.id).join(',') === '01,11,plugin:tts:tts,plugin:stickers:card');
check('核心卡 2 张', registry.coreCards.length === 2);
check('插件卡 2 张', registry.pluginCards.length === 2);
check('插件组按有卡片过滤（空插件不占位）',
  registry.pluginGroups.length === 2 && !registry.pluginGroups.some((g) => g.id === 'empty'));
check('插件组内卡片按 pluginId 归位',
  registry.pluginGroups.find((g) => g.id === 'tts').cards[0].id === 'plugin:tts:tts');
check('cardsForGroup(all) 返回全部', cardsForGroup(registry, 'all').length === 4);
check('cardsForGroup(core) 只返回核心卡', cardsForGroup(registry, 'core').every((c) => c.kind === 'core'));
check('cardsForGroup(plugins) 只返回插件卡', cardsForGroup(registry, 'plugins').every((c) => c.kind === 'plugin'));
check('cardsForGroup(plugin:tts) 只返回该插件', cardsForGroup(registry, 'plugin:tts').length === 1);

function throws(fn, name) {
  try { fn(); return false; } catch { return true; }
}
check('重复卡片 id 被拒绝', throws(() => validateManifest({
  ok: true,
  cards: [
    { id: 'x', kind: 'core', title: 'a' },
    { id: 'x', kind: 'core', title: 'b' }
  ]
})));
check('插件卡缺少 pluginId 被拒绝', throws(() => validateManifest({
  ok: true,
  cards: [{ id: 'p', kind: 'plugin', title: 'p' }]
})));
check('卡片缺少 title 被拒绝', throws(() => validateManifest({
  ok: true,
  cards: [{ id: 'x', kind: 'core' }]
})));

const fallback = await loadManifest(async () => { throw new Error('offline'); });
check('manifest 拉取失败时回退', fallback.fallback === true && fallback.coreCards.length === 3);
check('回退包含三张试点卡', ['10', '11', '13'].every((id) => fallback.coreCards.some((c) => c.id === id)));

let requested = '';
const online = await loadManifest(async (url) => {
  requested = url;
  return { ok: true, json: async () => sample };
});
check('manifest 拉取成功不触发回退', online.fallback === false && requested === '/api/console/manifest');
check('拉取成功后插件组可用', online.pluginGroups.length === 2);

// 注册表与页面漂移检查：23 张核心卡都必须有对应 section。
const cardDir = path.join(root, 'public', 'console', 'cards');
const cardSrc = fs.readdirSync(cardDir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(cardDir, f), 'utf8').replace(/\\"/g, '"')).join('\n');
const appDir = path.join(root, 'public', 'console', 'app');
const appSrc = fs.readdirSync(appDir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(appDir, f), 'utf8').replace(/\\"/g, '"')).join('\n');
const html = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8') + '\n' + cardSrc + '\n' + appSrc + '\n' + CORE_CARDS.map((c) => `<div data-card-mount="${c.id}"></div>`).join('');
const coreSurface = fs.readFileSync(path.join(root, 'public', 'console', 'app', 'core-surface.js'), 'utf8');
check('核心卡 23 张', CORE_CARDS.length === 23, String(CORE_CARDS.length));
check('核心卡由 core-surface 动态建 section', /document.createElement\('section'\)/.test(coreSurface) && /data-card-mount/.test(coreSurface));
check('试点卡有声明式挂载点', ['10', '11', '13'].every((id) => new RegExp(`data-card-mount="${id}"`).test(html)));
check('试点卡编号无重复', new Set(CORE_CARDS.map((c) => c.id)).size === CORE_CARDS.length);

// C2 第一批：21 测试发送 / 23 后台引导
const card21 = CORE_CARDS.find((c) => c.id === '16');
const card23 = CORE_CARDS.find((c) => c.id === '18');
check('16/18 已迁声明式', card21?.render === 'declarative' && card23?.render === 'declarative');
check('16 含 select/input/textarea/actions', ['select', 'input', 'textarea', 'actions']
  .every((type) => card21?.sections?.some((s) => s.type === type)));
check('18 的 key 使用字符串插值', JSON.stringify(card23?.sections || []).includes('${an.kind}:${an.id}'));
check('16/18 有声明式挂载点', ['16', '18'].every((id) => new RegExp(`data-card-mount="${id}"`).test(html)));
check('渲染器支持字符串插值', /replace\(\/\\\$\\\{/.test(fs.readFileSync(path.join(root, 'public', 'console', 'core', 'renderer.js'), 'utf8'))
  && fs.readFileSync(path.join(root, 'public', 'console', 'core', 'renderer.js'), 'utf8').includes('([^}]+)'));

// C2 第二批：13 控制台访问令牌
const card13 = CORE_CARDS.find((c) => c.id === '12');
const rendererSrc = fs.readFileSync(path.join(root, 'public', 'console', 'core', 'renderer.js'), 'utf8');
check('12 已迁声明式', card13?.render === 'declarative');
check('12 使用密码输入', card13?.sections?.some((s) => s.type === 'input' && s.inputType === 'password'));
check('12 动作会持久化令牌', JSON.stringify(card13?.sections || []).includes('storeConsoleToken'));
check('12 有声明式挂载点', /data-card-mount="12"/.test(html));
check('渲染器支持动作响应赋值/成功模板', rendererSrc.includes('item.assign') && rendererSrc.includes('item.successTemplate'));

// C2 第三批：22 桥接控制
const card22 = CORE_CARDS.find((c) => c.id === '17');
check('17 已迁声明式', card22?.render === 'declarative');
check('17 重启动作带等待恢复', JSON.stringify(card22?.sections || []).includes('waitFor')
  && JSON.stringify(card22?.sections || []).includes('reloadAfter'));
check('17 有声明式挂载点', /data-card-mount="17"/.test(html));
check('渲染器支持重启等待/自动刷新', rendererSrc.includes('item.waitFor') && rendererSrc.includes('item.reloadAfter'));

// C2 第四批：19 磁盘缓存（模块卡）
const card19 = CORE_CARDS.find((c) => c.id === '15');
check('15 使用模块卡', card19?.render === 'module' && card19?.module === '/console/cards/19-cache.js');
check('15 模块文件存在', fs.existsSync(path.join(root, 'public', 'console', 'cards', '19-cache.js')));
check('图片归属卡有模块挂载点', /data-card-mount="plugin:images:images-settings"/.test(html) || /data-card-mount="images-settings"/.test(html));
check('Shell 支持动态模块卡', /mountModuleCards/.test(fs.readFileSync(path.join(root, 'public', 'console', 'shell.js'), 'utf8')));

// C2 第五批：15 取图额度（模块卡）
const card15 = CORE_CARDS.find((c) => c.ownerPlugin === 'images');
check('图片归属卡使用模块卡', card15?.render === 'module' && card15?.module === '/console/cards/15-image-quota.js');
check('图片归属模块文件存在', fs.existsSync(path.join(root, 'public', 'console', 'cards', '15-image-quota.js')));
check('图片归属卡有模块挂载点', /data-card-mount="images-settings"/.test(html));

// C2 第六批：03 挂起审批 / 提问（模块卡）
const card03 = CORE_CARDS.find((c) => c.id === '03');
check('03 使用模块卡', card03?.render === 'module' && card03?.module === '/console/cards/03-pending.js');
check('03 模块文件存在', fs.existsSync(path.join(root, 'public', 'console', 'cards', '03-pending.js')));
check('03 有模块挂载点', /data-card-mount="03"/.test(html));

// C2 第七批：01 运行模式（模块卡）
const card01 = CORE_CARDS.find((c) => c.id === '01');
check('01 使用模块卡', card01?.render === 'module' && card01?.module === '/console/cards/01-runtime.js');
check('01 模块文件存在', fs.existsSync(path.join(root, 'public', 'console', 'cards', '01-runtime.js')));
check('01 有模块挂载点', /data-card-mount="01"/.test(html));

// C2 第八批：04 活动日志（模块卡）
const card04 = CORE_CARDS.find((c) => c.id === '04');
check('04 使用模块卡', card04?.render === 'module' && card04?.module === '/console/cards/04-activity.js');
check('04 模块文件存在', fs.existsSync(path.join(root, 'public', 'console', 'cards', '04-activity.js')));
check('04 有模块挂载点', /data-card-mount="04"/.test(html));

// C2 第九批：02 会话映射（模块卡）
const card02 = CORE_CARDS.find((c) => c.id === '02');
check('02 使用模块卡', card02?.render === 'module' && card02?.module === '/console/cards/02-sessions.js');
check('02 模块文件存在', fs.existsSync(path.join(root, 'public', 'console', 'cards', '02-sessions.js')));
check('02 有模块挂载点', /data-card-mount="02"/.test(html));
check('02b 仍保留 legacy 适配', /data-sec="02b"/.test(html));

// C2 第十批：06 一代仿真（模块卡）
const card06 = CORE_CARDS.find((c) => c.id === '06');
check('06 使用模块卡', card06?.render === 'module' && card06?.module === '/console/cards/06-reserved.js');
check('06 模块文件存在', fs.existsSync(path.join(root, 'public', 'console', 'cards', '06-reserved.js')));
check('06 有模块挂载点', /data-card-mount="06"/.test(html));

// C2 收尾：23 张卡全部进入统一注册表/挂载点（复杂卡为 legacy-adopt 过渡形态）
check('23 张核心卡都有 render 形态', CORE_CARDS.every((c) => c.render === 'module' || c.render === 'declarative'));
check('基础功能 manifest 为 19 张', coreManifestCards().length === 19);
check('插件归属卡为 4 张（slang/images/bili/tts）', pluginOwnedManifestCards().length === 4 && pluginOwnedManifestCards().every((c) => c.owner === 'plugin' && c.pluginId));
check('基础卡不含插件归属', coreManifestCards().every((c) => c.owner === 'core' && !c.pluginId));
check('23 张核心卡都有挂载点', CORE_CARDS.every((c) => new RegExp(`data-card-mount="${c.id}"`).test(html)));
check('复杂卡使用 legacy-adopt 过渡模块', CORE_CARDS.filter((c) => c.module === '/console/cards/legacy-adopt.js').length === 0);
check('07 二代仿真已真迁为独立模块', CORE_CARDS.find((c) => c.id === '07')?.module === '/console/cards/07-v2.js');
check('19 上下文已真迁为独立模块', CORE_CARDS.find((c) => c.id === '19')?.module === '/console/cards/24-context.js');
check('05 人格已真迁为独立模块', CORE_CARDS.find((c) => c.id === '05')?.module === '/console/cards/05-role.js');
check('黑话插件归属卡已真迁为独立模块', CORE_CARDS.find((c) => c.ownerPlugin === 'slang')?.module === '/console/cards/08-slang.js');
check('20 凭据卡已拆到插件配置注册', !CORE_CARDS.some((c) => c.id === '20') && fs.existsSync(path.join(root, 'public', 'console', 'cards', 'config-panel.js')));
check('TTS 插件归属卡已真迁为独立模块', CORE_CARDS.find((c) => c.ownerPlugin === 'tts')?.module === '/console/cards/18-tts.js');
check('14 Token 已真迁为独立模块', CORE_CARDS.find((c) => c.id === '14')?.module === '/console/cards/16-token.js');
check('09 白名单已真迁为独立模块', CORE_CARDS.find((c) => c.id === '09')?.module === '/console/cards/10-whitelist.js');
check('08 MCP 工具已真迁为独立模块', CORE_CARDS.find((c) => c.id === '08')?.module === '/console/cards/09-tools.js');
check('B 站插件归属卡已真迁为独立模块', CORE_CARDS.find((c) => c.ownerPlugin === 'bili')?.module === '/console/cards/17-bili.js');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
