// 回归测试：插件控制台卡片契约（C3）。
//
// 校验 console.card.json 的 schema、命名空间限制与无 HTML/脚本；
// 同时扫描仓库内所有插件卡片，防止后续新增卡片破坏契约。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConsoleCard } from '../src/plugins/host.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const valid = {
  id: 'demo',
  kind: 'plugin',
  pluginId: 'demo',
  title: '演示插件',
  order: 100,
  data: [{ source: '/api/plugins/demo/card', as: 'st' }],
  sections: [
    { type: 'text', label: '状态', bind: 'st.enabled' },
    { type: 'actions', items: [{ label: '保存', method: 'POST', path: '/api/plugins/demo/config', body: {} }] }
  ]
};
const result = validateConsoleCard(valid, { pluginId: 'demo' });
check('合法卡片通过校验', result.ok, result.errors.join('；'));

function rejects(mutator, name) {
  const card = JSON.parse(JSON.stringify(valid));
  mutator(card);
  const r = validateConsoleCard(card, { pluginId: 'demo' });
  check(name, !r.ok, r.errors.join('；'));
}

rejects((c) => { c.kind = 'core'; }, 'kind 必须是 plugin');
rejects((c) => { c.pluginId = 'other'; }, 'pluginId 必须匹配目录');
rejects((c) => { c.sections[1].items[0].path = '/api/socialV2/config'; }, '动作路径必须在插件命名空间');
rejects((c) => { c.title = '<script>alert(1)</script>'; }, '拒绝 HTML/脚本片段');
rejects((c) => { c.sections[0].type = 'html'; }, '拒绝未知字段类型');
rejects((c) => { delete c.sections; }, 'sections 必填');
rejects((c) => { c.panel = '/api/socialV2/config'; }, 'panel 必须在插件命名空间');

const pluginDir = path.join(root, 'plugins');
const files = fs.readdirSync(pluginDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(pluginDir, e.name, 'console.card.json')))
  .map((e) => e.name);
check('至少有一个插件声明式卡片', files.length >= 1, String(files.length));
for (const id of files) {
  const card = JSON.parse(fs.readFileSync(path.join(pluginDir, id, 'console.card.json'), 'utf8'));
  const r = validateConsoleCard(card, { pluginId: id });
  check(`插件 ${id} 卡片契约通过`, r.ok, r.errors.join('；'));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
