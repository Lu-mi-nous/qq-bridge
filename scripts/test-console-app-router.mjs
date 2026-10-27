// 回归测试：控制台 hash 路由（C6）。
import { parseHash, hashForCore, hashForPlugins, hashForAbout, hashForPluginManage, hashForRoute } from '../public/console/app/router.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

check('默认进入基础功能', JSON.stringify(parseHash('')) === JSON.stringify({ kind: 'core', cardId: null }));
check('#/core 解析', parseHash('#/core').kind === 'core');
check('#/core/07 解析卡片', parseHash('#/core/07').cardId === '07');
check('#/plugins 解析插件总览', parseHash('#/plugins').kind === 'plugins' && !parseHash('#/plugins').pluginId);
check('#/plugins/stickers 解析单插件', parseHash('#/plugins/stickers').pluginId === 'stickers');
check('#/plugins/manage 解析插件管理', parseHash('#/plugins/manage').kind === 'plugin-manage');
check('#/plugins/manage 不误判为插件 id', parseHash('#/plugins/manage').pluginId === undefined);
check('#/about 解析关于', parseHash('#/about').kind === 'about');
check('旧 #card=07 兼容', parseHash('#card=07').kind === 'core' && parseHash('#card=07').cardId === '07');
check('生成 core hash', hashForCore('07') === '#/core/07' && hashForCore() === '#/core');
check('生成 plugin hash', hashForPlugins('stickers') === '#/plugins/stickers' && hashForPlugins() === '#/plugins');
check('生成 plugin-manage hash', hashForPluginManage() === '#/plugins/manage');
check('生成 about hash', hashForAbout() === '#/about');
check('route→hash', hashForRoute({ kind: 'core', cardId: '05' }) === '#/core/05'
  && hashForRoute({ kind: 'plugins', pluginId: 'tts' }) === '#/plugins/tts'
  && hashForRoute({ kind: 'plugin-manage' }) === '#/plugins/manage'
  && hashForRoute({ kind: 'about' }) === '#/about');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
