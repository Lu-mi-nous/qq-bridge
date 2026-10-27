// 回归测试：敏感信息脱敏正则（SENSITIVE_RE）。
//
// 背景（2026-10-10）：接入 X 登录态抓取后，凭据（auth_token / ct0 / bearer）会流经
// 日志与消息文本，必须确保被遮蔽。实测发现旧正则漏了三类真实形态，同时也发现
// 加固时容易引入「正常聊天被误判」的副作用——而误判的代价是桥接**拦住这条回复**
// （群友看到机器人突然不说话），所以两类断言同等重要：**该遮蔽的要遮蔽，该放行的要放行**。
import { SENSITIVE_RE } from '../src/sensitive.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const hits = (s) => new RegExp(SENSITIVE_RE.source, 'gi').test(s);

console.log('── 必须遮蔽：真实凭据形态 ──');
{
  const FAKE_TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const FAKE_CT0 = '0ea7e4aef9af488259641350927aafc357234c651976395eeb742877025b15cad';
  const FAKE_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  check('auth_token=<值>', hits(`auth_token=${FAKE_TOKEN}`));
  check('ct0: <值>（X 的 CSRF cookie 名，旧正则漏）', hits(`ct0: ${FAKE_CT0}`));
  check('authorization: Bearer <含 % 的 token>', hits(`authorization: Bearer ${FAKE_BEARER}`));
  check('裸 Bearer <长 token>', hits(`Bearer ${FAKE_BEARER}`));
  check('cookie: auth_token=…; ct0=…', hits(`cookie: auth_token=${FAKE_TOKEN}; ct0=${FAKE_CT0}`));
  check('token=sk-…', hits('token=sk-abcdef1234567890'));
  check('password: …', hits('password: hunter2xyz'));
  check('api_key = …', hits('api_key = abcdef123456'));
  // 遮蔽后不能残留原值（这是最终目的，不能只看「是否命中」）
  const g = new RegExp(SENSITIVE_RE.source, 'gi');
  const masked = `authorization: Bearer ${FAKE_BEARER}`.replace(g, '***');
  check('遮蔽后不残留 token 本体', !masked.includes('ANRILgAAAAA'), masked);
}

console.log('\n── 必须遮蔽：中文赋值形态 ──');
{
  check('我的密码是 abc12345', hits('我的密码是 abc12345'));
  check('token是 sk-abcdef123456', hits('token是 sk-abcdef123456'));
  check('密钥为 k9x8y7z6w5', hits('密钥为 k9x8y7z6w5'));
}

console.log('\n── 必须遮蔽：JSON 配置写法（2026-10-11 接入 SauceNAO 时发现漏网）──');
{
  // 项目 config.json 里的字段名是驼峰 apiKey，而旧词表只有 api[_-]?key，匹配不到；
  // 且 JSON 里关键词后紧跟引号再冒号，旧的分隔符判定只允许空白 → 整条漏网。
  const FAKE = 'd4f77df44d0415ff6cb158590a035d35ce290c00';
  check('"apiKey": "<值>"（带引号 JSON）', hits(`"apiKey": "${FAKE}"`));
  check('apiKey: <值>（无引号）', hits(`apiKey: ${FAKE}`));
  check('"api_key": "<值>"', hits(`"api_key": "${FAKE}"`));
  check('"password": "hunter2xyz"', hits('"password": "hunter2xyz"'));
  check('"token": "abc123456"', hits('"token": "abc123456"'));
  // 遮蔽后不能残留原值
  const masked = `"apiKey": "${FAKE}"`.replace(new RegExp(SENSITIVE_RE.source, 'gi'), '***');
  check('JSON 形态遮蔽后不残留', !masked.includes(FAKE), masked);
}

console.log('\n── 必须遮蔽：本机路径 ──');
{
  check('Windows 绝对路径', hits('文件在 C:\\Users\\me\\secret.txt'));
  // UNC：JS 字面量里每个反斜杠要写两次，四个反斜杠 = 真实字符串 \\server
  check('UNC 路径', hits('\\\\server\\share\\file'));
  check('Linux 家目录', hits('/home/user/.ssh/id_rsa'));
}

console.log('\n── 必须放行：正常群聊（误判会拦住机器人发言）──');
{
  const normal = [
    '我今天去喝酒了',
    '这个token是什么意思啊',        // 「是」后面是汉字短语，不是凭据
    '你看过《Cookie》那部电影吗',   // Cookie 是片名
    'session 这个词怎么读',         // 只是问词义
    '我密码忘了，怎么办',
    'bearer of good news 是什么意思', // 英文短语，不是 token
    '这个游戏有 session 机制吗',
    '他 authorization 一下就行了（开玩笑）',
    '帮我查一下 token 这个词的用法',
    'cookie 是什么，能吃吗',
  ];
  for (const s of normal) check(`放行 ${JSON.stringify(s).slice(0, 26)}`, !hits(s));
}

console.log('\n── 边界 ──');
{
  check('空串不命中', !hits(''));
  check('纯数字不误判', !hits('1234567890'));
  check('短值不误判（Bearer 需 ≥20 位）', !hits('Bearer abc'));
  check('token 后无值不命中', !hits('token'));
  // 冒号后跟短值仍算赋值（`token：abc` 是凭据写法，该拦）；
  // 中文逗号能截断值的边界由下面的「放行」用例覆盖。
  check('token：abc 算赋值（该拦）', hits('token：abc'));
  check('token：后直接接中文逗号（无值）不命中', !hits('token：，这是我说的'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
