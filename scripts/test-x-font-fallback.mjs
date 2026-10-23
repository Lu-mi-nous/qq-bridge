// 回归测试：X 卡片渲染的字体回退（fontClassOf / segmentByFont）。
//
// 背景（2026-10-10）：群友看到卡片里「好大方框」——雅黑(msyh)不含韩文与 emoji，
// drawtext 又没有字体回退链，于是韩文/emoji 全渲染成 □。实测那条帖子有 53 个韩文字。
// 修法是按字符分段、各段换能出字形的字体（韩文→malgun，emoji→seguiemj）。
import { fontClassOf, segmentByFont } from '../src/x-monitor/render.mjs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

console.log('── 字符分类 ──');
{
  check('韩文音节 → hangul', fontClassOf('월') === 'hangul');
  check('韩文谚文 → hangul', fontClassOf('한') === 'hangul');
  check('韩文字母 → hangul', fontClassOf('\u1100') === 'hangul');
  check('emoji 📌 → emoji', fontClassOf('📌') === 'emoji');
  check('emoji 😍 → emoji', fontClassOf('😍') === 'emoji');
  check('变体选择符 → emoji', fontClassOf('\uFE0F') === 'emoji');
  check('中文 → base', fontClassOf('位') === 'base');
  check('日文假名 → base', fontClassOf('あ') === 'base');
  check('西文 → base', fontClassOf('A') === 'base');
  check('数字 → base', fontClassOf('7') === 'base');
}

console.log('\n── 分段（真实帖子文本）──');
{
  const real = '10월 초보카 일러스타페스 14 인포';
  const segs = segmentByFont(real);
  check('拼回与原文一致（不能丢字符）', segs.map(s => s.text).join('') === real);
  check('识别出韩文段', segs.some(s => s.cls === 'hangul'));
  const emojiLine = '📌위치:Vo71 양일';
  const segs2 = segmentByFont(emojiLine);
  check('emoji 行拼回一致', segs2.map(s => s.text).join('') === emojiLine);
  check('emoji 行有 emoji 段', segs2.some(s => s.cls === 'emoji'));
  check('emoji 行有韩文段', segs2.some(s => s.cls === 'hangul'));
  check('空格保留在 base 段里', segs2.some(s => s.text.includes(' ')));
}

console.log('\n── 纯 base 文本不分段（保证常见情况零开销、行为不变）──');
{
  const plain = '谢谢大家支持，ありがとう';
  const segs = segmentByFont(plain);
  check('纯中日文只有 1 段', segs.length === 1, JSON.stringify(segs.map(s=>s.cls)));
  check('类别是 base', segs[0].cls === 'base');
  const en = 'Blinked and it’s already Saturday';
  check('纯西文只有 1 段', segmentByFont(en).length === 1);
}

console.log('\n── 边界 ──');
{
  check('空串', segmentByFont('').length === 0);
  check('null 不抛', segmentByFont(null).length === 0);
  check('undefined 不抛', segmentByFont(undefined).length === 0);
  check('纯空格', segmentByFont('   ').length === 1);
  check('混合多段', segmentByFont('a월b📌c').length === 5, JSON.stringify(segmentByFont('a월b📌c').map(s=>s.cls)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
