// 配置 schema、模板生成与校验的回归测试。
//
// 目标：
//   1. 默认值本身必须能通过 schema（否则启动自检会永远报错）
//   2. 类型错误必须被拒绝且给出字段路径
//   3. 未知键只告警，不阻塞（便于灰度与拼写排查）
//   4. config.example.json 必须与生成器输出一致（防止模板漂移）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DEFAULTS } from '../src/config-defaults.js';
import { CONFIG_SCHEMA, validateConfig, flatten, configSummary } from '../src/config-schema.js';
import { buildExample, OUT } from './gen-config-example.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

console.log('── 1. 默认值自洽 ──');
{
  const parsed = CONFIG_SCHEMA.safeParse(CONFIG_DEFAULTS);
  check('默认值通过 schema', parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 2)));
  const report = validateConfig({});
  check('空配置无类型错误', report.errors.length === 0, JSON.stringify(report.errors.slice(0, 2)));
  check('空配置有大量字段使用默认值', report.missing.length > 300, String(report.missing.length));
}

console.log('\n── 2. 类型错误必须拒绝 ──');
{
  const r = validateConfig({ consolePort: '3100' });
  check('端口写成字符串 → 报错', r.errors.some((e) => e.path === 'consolePort'), JSON.stringify(r.errors));
  const r2 = validateConfig({ socialV2: { images: { enabled: 'yes' } } });
  check('布尔开关写成字符串 → 报错', r2.errors.some((e) => e.path === 'socialV2.images.enabled'), JSON.stringify(r2.errors));
  const r3 = validateConfig({ allow: { private: '123' } });
  check('白名单写成字符串 → 报错', r3.errors.some((e) => e.path === 'allow.private'), JSON.stringify(r3.errors));
}

console.log('\n── 3. 未知键只告警 ──');
{
  const r = validateConfig({ consolePorts: 3100 });
  check('顶层拼写错误 → 未知键告警', r.warnings.includes('consolePorts'), JSON.stringify(r.warnings));
  check('未知键不产生类型错误', r.errors.length === 0);
  const r2 = validateConfig({ socialV2: { tokenFuse: { overrides: { 'group:123456789': { warnTokens: 100 } } } } });
  check('动态 overrides 键不算未知', !r2.warnings.some((w) => w.includes('overrides')), JSON.stringify(r2.warnings));
}

console.log('\n── 4. 模板完整性 ──');
{
  const example = buildExample();
  const defaultPaths = Object.keys(flatten(CONFIG_DEFAULTS)).filter((p) => !p.startsWith('socialV2.tokenFuse.overrides'));
  const examplePaths = new Set(Object.keys(flatten(example)));
  const missing = defaultPaths.filter((p) => !examplePaths.has(p));
  check('模板覆盖全部默认字段', missing.length === 0, missing.slice(0, 5).join(', '));
  check('发图默认开启（新装推荐值）', example.socialV2.images.enabled === true);
  check('私聊准入默认 friends', example.allow.privateMode === 'friends');
  check('ownerQQ 是占位号', example.ownerQQ === 123456789);
  check('密钥字段留空', example.imageReverseSearch.apiKey === '' && example.consoleToken === '');
  check('本机路径字段留空', example.socialV2.tts.dir === '' && example.snowluma.launcherPath === '');
  check('动态 overrides 为空对象', Object.keys(example.socialV2.tokenFuse.overrides).length === 0);
  check('deny 名单保持空表', example.deny.private.length === 0 && example.deny.groups.length === 0);
}

console.log('\n── 5. 模板不漂移 ──');
{
  const onDisk = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const generated = buildExample();
  check('config.example.json 与生成器一致', JSON.stringify(onDisk) === JSON.stringify(generated),
    JSON.stringify(onDisk) === JSON.stringify(generated) ? '' : '请运行 npm run gen:config');
}

console.log('\n── 6. 启动摘要 ──');
{
  const s = configSummary(CONFIG_DEFAULTS);
  check('摘要含 DSH 与端口', typeof s.dsh === 'string' && s.dsh.includes('/'), JSON.stringify(s));
  check('摘要含关键能力开关', ['images', 'tts', 'bili', 'upscale'].every((k) => typeof s[k] === 'boolean'), JSON.stringify(s));
  check('工具数量正确', s.toolsTotal === Object.keys(CONFIG_DEFAULTS.socialV2.tools).length);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
