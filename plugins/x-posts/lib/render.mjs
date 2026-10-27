// x-monitor/render.mjs — 把帖子渲染成精致的卡片 PNG（ffmpeg，无需浏览器）
//
// 视觉设计（"高级感"取向）：
//   - 深色主题：外层近黑底 + 圆角深灰卡片，形成悬浮层次；
//   - 唯一亮色是认证徽标与译文标题的蓝，其余用灰阶做层级（白标题 / 浅灰正文 / 深灰元信息）；
//   - 头像带一圈极淡描边环；正文行距 1.6x 留白舒展；
//   - 译文独立色块 + 左侧蓝色细条，与原文视觉分离；
//   - 底部互动数据用"标签灰 + 数值亮"的双色排版，并加分隔线。
//
// 为什么是 ffmpeg 而不是浏览器截图：本项目无 puppeteer/playwright，且 X 正文需登录才能看。
// 渲染耗时约 0.1~0.3 秒。
//
// 踩过的坑（改动前必读）：
//   1. drawtext 用 **textfile=** 而非 text=：text='...' 里出现单引号（we're）会提前闭合引号，
//      整个 filtergraph 解析错位（报 Invalid color string: '0f1419,drawtext=fontfile=C'）。
//   2. 本机 ffmpeg **忽略 line_spacing**：多行塞一个 textfile 会叠在同一基线，
//      所以每行一个 drawtext、自己算 Y。
//   3. 中文字体必须雅黑/黑体（Segoe UI 渲染中文是豆腐块）；代价是雅黑把西文弯引号渲染成全角，
//      故渲染前做 normalizePunctuation 归一化。
//   4. **符号字符（✓ 等）必须换符号字体**：雅黑/黑体/宋体/Segoe UI/Arial 都没有 U+2713 字形，
//      会渲染成豆腐块方框。只有 Segoe UI Symbol / Arial Unicode 有。
//   5. filter_complex 里不要传无意义的占位输入（曾用 color=1x1 导致 Picture size 0x0 is invalid）。
//   6. 不要用 emoji（♥ 💬 等）：字体缺字形会变豆腐块，改用中文标签。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findFfmpeg } from '../../../src/gif-frames.js';
import { proxyGet } from '../../../src/proxy-tunnel.js';

const FONT_REGULAR = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simsun.ttc'
];
const FONT_BOLD = [
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simhei.ttf'
];
// 符号字体：仅用于 ✓ 这类几何符号（正文字体普遍缺字形）
const FONT_SYMBOL = [
  'C:/Windows/Fonts/seguisym.ttf',
  'C:/Windows/Fonts/ARIALUNI.TTF'
];
// ── 按字符集回退（重要）────────────────────────────────────────────────
// drawtext 只用**一个** fontfile，没有字体回退链。雅黑(msyh)不含韩文与 emoji，
// 遇到它们就渲染成方框（实测：一条 53 个韩文字的帖子，正文全是 □；emoji 📌 也是 □）。
// 所以按字符分类挑字体，见 fontForText()。这些字体都实测过能出字形：
//   - 韩文 → malgun.ttf（Windows 韩文默认；ARIALUNI 也行但字形更接近衬线）
//   - emoji → seguiemj.ttf（Windows 彩色 emoji；单色渲染下是轮廓图，仍可辨认）
//   - 其余（中/日/西文）→ 雅黑，观感最好
const FONT_HANGUL = [
  'C:/Windows/Fonts/malgun.ttf',
  'C:/Windows/Fonts/ARIALUNI.TTF',
  'C:/Windows/Fonts/gulim.ttc'
];
const FONT_EMOJI = [
  'C:/Windows/Fonts/seguiemj.ttf',
  'C:/Windows/Fonts/ARIALUNI.TTF'
];
const FONT_FALLBACK = [
  'C:/Windows/Fonts/ARIALUNI.TTF',   // 覆盖面最广：中日韩+西文
  'C:/Windows/Fonts/msyh.ttc'
];

function pick(list) {
  for (const p of list) if (fs.existsSync(p)) return p;
  return null;
}

/**
 * 按字符判断该用哪一类字体。drawtext 没有字体回退链，只能自己分段。
 * 返回 'emoji' | 'hangul' | 'base'。
 *
 * 覆盖范围（实测 2026-10-10）：
 *   - 韩文谚文 U+AC00–U+D7A3（及字母区 U+1100–U+11FF）：雅黑没有 → 必须换 malgun
 *   - emoji：雅黑/黑体都没有 → 必须换 seguiemj
 *   - 其余（中日西文）雅黑够用，且观感最好
 */
export function fontClassOf(ch) {
  const c = ch.codePointAt(0);
  if (!c) return 'base';
  // emoji 与杂项符号：⚠️ ✓ 这类符号另有 FONT_SYMBOL，这里只管彩色 emoji 区
  if ((c >= 0x1F000 && c <= 0x1FAFF) || (c >= 0x1F1E6 && c <= 0x1F1FF) || c === 0xFE0F || c === 0x200D) return 'emoji';
  if ((c >= 0x2600 && c <= 0x27BF) || (c >= 0x2B00 && c <= 0x2BFF)) return 'emoji';
  if ((c >= 0xAC00 && c <= 0xD7A3) || (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3130 && c <= 0x318F)) return 'hangul';
  return 'base';
}

/**
 * 把一段文本按所需字体切成若干「同字体连续段」，供逐段 drawtext。
 * @returns {{text:string, cls:string}[]}
 */
export function segmentByFont(text) {
  const out = [];
  for (const ch of String(text ?? '')) {
    const cls = fontClassOf(ch);
    const last = out[out.length - 1];
    if (last && last.cls === cls) last.text += ch;
    else out.push({ text: ch, cls });
  }
  return out;
}

/** 视觉等价归一化：把中文字体下渲染成全角宽度的西文标点换成紧凑等价形。 */
export function normalizePunctuation(s) {
  return String(s ?? '')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

/** 显示宽度：CJK/全角算 2，西文标点算 1。 */
function widthOf(ch) {
  const c = ch.codePointAt(0);
  if (
    (c >= 0x2010 && c <= 0x2027) ||
    c === 0x2030 || c === 0x2033 ||
    (c >= 0x2039 && c <= 0x203a) ||
    c === 0x2044 || c === 0x2047
  ) return 1;
  if (c >= 0x1100 && (
    c <= 0x115f || c === 0x2329 || c === 0x232a ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x20000 && c <= 0x3fffd)
  )) return 2;
  return 1;
}

/**
 * 按显示宽度折行。中英断行规则不同，必须分开处理：
 *   - 西文按**词**断（不把 "inbox zero" 拆开）；
 *   - 中文按**字**断（中文无空格，按词会整段当一词或让标点跑到行首）；
 *   - URL 作为原子不拆；行首禁则标点回拉到上一行。
 */
/**
 * 把文本里的链接抽出来（返回 { text: 去链接后的文本, links: [...] }）。
 *
 * 为什么要抽：推文正文里常带 t.co 短链（X 自动生成的），译文里也可能带上。
 * 放在正文/译文里会占掉一整行、把排版撑得很难看，统一挪到卡片底部页脚展示。
 * 链接去重、顺序保留。
 */
export function extractLinks(raw) {
  const links = [];
  const text = String(raw ?? '')
    // 匹配 http(s):// 开头的 URL，以及 X 的 t.co 短链（无协议也要能认出来）
    .replace(/(?:https?:\/\/|www\.)[^\s，。；、）)】》"']+/gi, (m) => {
      links.push(m);
      return '';
    })
    // 去掉因移除链接留下的多余空格与空行
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s*\n\s*\n\s*/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  const uniq = [...new Set(links)];
  return { text, links: uniq };
}

/**
 * 粗略识别原文语言，用于译文标题的「翻译自 X」。
 * 只做字符集级别的判断（够用且零成本）：假名→日语、谚文→韩语、西里尔→俄语、
 * 阿拉伯→阿拉伯语、其余带拉丁字母→英语。识别不出返回「外语」。
 */
export function detectLangLabel(text) {
  const s = String(text ?? '');
  const count = (re) => (s.match(re) || []).length;
  const kana = count(/[\u3040-\u30ff]/g);
  const hangul = count(/[\uac00-\ud7af\u1100-\u11ff]/g);
  const cyrillic = count(/[\u0400-\u04ff]/g);
  const arabic = count(/[\u0600-\u06ff]/g);
  const thai = count(/[\u0e00-\u0e7f]/g);
  if (kana >= 4) return '日语';
  if (hangul >= 4) return '韩语';
  if (cyrillic >= 4) return '俄语';
  if (arabic >= 4) return '阿拉伯语';
  if (thai >= 4) return '泰语';
  if (count(/[A-Za-z]/g) >= 4) return '英语';
  return '外语';
}

export function wrapText(text, maxWidth = 46) {
  const urls = [];   // 必须函数作用域（曾放 for 内，多行还原时 ReferenceError）
  const out = [];
  const NO_LINE_START = '。，、；：？！）】》”’…,.!?;:)]}';

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    if (!rawLine.trim()) {
      out.push('');
      continue;
    }
    const guarded = rawLine.replace(/https?:\/\/[^\s]+/g, (m) => {
      urls.push(m);
      return `\u0000${urls.length - 1}\u0000`;
    });

    const units = [];
    const re = /(\u0000\d+\u0000)|([A-Za-z0-9@#$%&*+\-_\u00C0-\u024F]+(?:['’][A-Za-z]+)*)|([ \t]+)|([\s\S])/gu;
    for (const m of guarded.matchAll(re)) {
      if (m[1]) units.push({ t: m[1], w: 23, url: true });
      else if (m[2]) units.push({ t: m[2], w: [...m[2]].reduce((a, c) => a + widthOf(c), 0) });
      else if (m[3]) units.push({ t: ' ', w: 1, space: true });
      else units.push({ t: m[4], w: widthOf(m[4]) });
    }

    let line = '';
    let w = 0;
    const pushLine = () => {
      if (line) out.push(line.replace(/\s+$/, ''));
      line = '';
      w = 0;
    };
    for (const u of units) {
      if (u.space) {
        if (!line) continue;
        line += ' ';
        w += 1;
        continue;
      }
      // 放不下就换行，然后**继续把该单元加到新行**（曾 continue 掉，导致触发换行的字符被丢弃）
      if (w + u.w > maxWidth && line.trim()) pushLine();
      line += u.t;
      w += u.w;
    }
    pushLine();
  }

  const merged = [];
  for (const line of out) {
    if (!line) { merged.push(line); continue; }
    const first = line[0];
    const prev = merged.length ? merged[merged.length - 1] : '';
    if (prev && NO_LINE_START.includes(first)) {
      merged[merged.length - 1] = prev + first;
      const rest = line.slice(1);
      if (rest) merged.push(rest);
    } else {
      merged.push(line);
    }
  }
  return merged.map((l) => l.replace(/\u0000(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''));
}

/** Windows 路径 → ffmpeg 滤镜参数形式（盘符冒号转义）。 */
const escFilterPath = (p) => String(p).replace(/\\/g, '/').replace(/:/g, '\\:');

function writeTemp(content, ext = '.txt') {
  const f = path.join(os.tmpdir(), `xmon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(f, content);
  return f;
}

/** 数字缩写：12345 → 1.2万。 */
function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
  return v.toLocaleString('en-US');
}

/** 时间：2026年10月4日 12:59。 */
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 相对时间：11 小时前。 */
function fmtAgo(ms) {
  if (!ms) return '';
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

const runFfmpeg = (ff, args) => new Promise((resolve) => {
  const p = spawn(ff, args, { windowsHide: true });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => resolve({ code, err }));
});

/**
 * 生成纯色圆角矩形 PNG（卡片/译文块）。
 * geq 表达式：处于「中间竖带 或 中间横带 或 四个圆角内」即不透明。
 */
/**
 * 生成「亚克力卡片」PNG：圆角矩形 + 柔和扩散阴影。
 *
 * 输出图比卡片本身大出 `pad` 的透明边距，里面铺着阴影，调用方按 overlay 贴到画布上。
 *
 * 阴影实现要点（踩过的坑）：
 *   - `color=c=0x0f172a@0.05` 这种**写法在本机 ffmpeg 不生效**（表现为整圈实心深色环，
 *     因为 alpha 没被当作透明度）。
 *   - 可靠做法是用 `geq` 一次产出 RGBA：`a='if(<圆角矩形判定>,<强度>,0)'`，
 *     再由外到内叠多层（越外层越淡、越大）形成渐变。
 *   - 圆角矩形判定：中间竖带 OR 中间横带 OR 四个圆角圆内。
 *
 * @returns {Promise<{file, w, h, pad} | null>}
 */
async function buildAcrylicCard(cardW, cardH, radius, { pad = 30, steps = 8, strength = 13 } = {}) {
  const ff = findFfmpeg();
  if (!ff) return null;
  const W = cardW + pad * 2;
  const H = cardH + pad * 2;
  const out = writeTemp('', '.png');

  const roundRectCond = (x, y, w, h, r) => {
    const R = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
    const cx1 = x + R, cx2 = x + w - R, cy1 = y + R, cy2 = y + h - R;
    const inX = `(gte(X,${cx1})*lte(X,${cx2}))`;
    const inY = `(gte(Y,${cy1})*lte(Y,${cy2}))`;
    const corner = (cx, cy) => `lte((X-${cx})^2+(Y-${cy})^2,${R * R})`;
    return `(gte(X,${x})*lte(X,${x + w})*gte(Y,${y})*lte(Y,${y + h}))*(${inX}+${inY}+${corner(cx1, cy1)}+${corner(cx2, cy1)}+${corner(cx1, cy2)}+${corner(cx2, cy2)})`;
  };

  const shHex = String(THEME.shadow).replace(/^0x/i, '');
  const sr = parseInt(shHex.slice(0, 2), 16);
  const sg = parseInt(shHex.slice(2, 4), 16);
  const sb = parseInt(shHex.slice(4, 6), 16);
  const bgHex = String(THEME.outerBg).replace(/^0x/i, '');

  // 画布基底：**透明**（用户要求「卡片之外的背景改成透明」），这样卡片可以贴到任意底色上。
  // 阴影仍保留（叠在透明底上），只是底色不再填充。
  const graph = [`color=c=0x00000000:s=${W}x${H}:d=1,format=rgba[bg]`];
  let cur = '[bg]';
  // 由外（大而淡）到内（小而深）叠阴影层
  for (let i = steps; i >= 1; i--) {
    const spread = (i * pad) / steps;
    const alpha = Math.round(strength / i);
    const cond = roundRectCond(pad - spread, pad - spread + 4, cardW + spread * 2, cardH + spread * 2, radius + spread);
    graph.push(
      `color=c=0x${shHex}:s=${W}x${H}:d=1,format=rgba,geq=r='${sr}':g='${sg}':b='${sb}':a='if(${cond},${alpha},0)'[sh${i}]`
    );
    graph.push(`${cur}[sh${i}]overlay=0:0[m${i}]`);
    cur = `[m${i}]`;
  }
  // 卡片本体（纯白 + 极淡描边以交代轮廓）
  const cardCond = roundRectCond(pad, pad, cardW, cardH, radius);
  graph.push(`color=c=0xffffff:s=${W}x${H}:d=1,format=rgba[cb]`);
  graph.push(`color=c=black:s=${W}x${H}:d=1,format=gray,geq=lum='if(${cardCond},255,0)'[cm]`);
  graph.push(`[cb][cm]alphamerge[cc]`);
  graph.push(`${cur}[cc]overlay=0:0[out]`);

  const res = await runFfmpeg(ff, [
    '-y', '-v', 'error',
    '-filter_complex', graph.join(';'),
    '-map', '[out]',
    '-frames:v', '1', out
  ]);
  if (res.code !== 0 || !fs.existsSync(out) || !fs.statSync(out).size) return null;
  return { file: out, w: W, h: H, pad };
}

async function buildRoundedRect(w, h, r, color) {
  const ff = findFfmpeg();
  if (!ff) return null;
  const out = writeTemp('', '.png');
  const hex = String(color).replace(/^0x/i, '');
  const R = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
  const inCorner = (cx, cy) => `lte((X-${cx})^2+(Y-${cy})^2,${R * R})`;
  const cond = [
    `gte(X,${R})*lte(X,${w - R})`,
    `gte(Y,${R})*lte(Y,${h - R})`,
    inCorner(R, R),
    inCorner(w - R, R),
    inCorner(R, h - R),
    inCorner(w - R, h - R)
  ].join('+');

  const steps = [
    `color=c=0x${hex}:s=${w}x${h}:d=1,format=rgba[base]`,
    `color=c=black:s=${w}x${h}:d=1,format=gray,geq=lum='if(${cond},255,0)'[mask]`,
    `[base][mask]alphamerge[rr]`
  ];
  const res = await runFfmpeg(ff, [
    '-y', '-v', 'error',
    '-filter_complex', steps.join(';'),
    '-map', '[rr]',
    '-frames:v', '1', out
  ]);
  if (res.code !== 0 || !fs.existsSync(out) || !fs.statSync(out).size) return null;
  return out;
}

/**
 * 生成纯色圆形 PNG（头像描边环 / 认证徽标底）。
 */
async function buildCircle(color, size) {
  const ff = findFfmpeg();
  if (!ff) return null;
  const out = writeTemp('', '.png');
  const half = size / 2;
  const hex = String(color).replace(/^0x/i, '');
  const steps = [
    `color=c=0x${hex}:s=${size}x${size}:d=1,format=rgba[base]`,
    `color=c=black:s=${size}x${size}:d=1,format=gray,geq=lum='if(lte((X-${half})^2+(Y-${half})^2,${(half - 1) ** 2}),255,0)'[mask]`,
    `[base][mask]alphamerge[circle]`
  ];
  const res = await runFfmpeg(ff, [
    '-y', '-v', 'error',
    '-filter_complex', steps.join(';'),
    '-map', '[circle]',
    '-frames:v', '1', out
  ]);
  if (res.code !== 0 || !fs.existsSync(out) || !fs.statSync(out).size) return null;
  return out;
}

/**
 * 生成 X 认证徽标里的白色对勾（粗圆头）。
 *
 * 为什么不继续用字体字符：`✓`(U+2713) / `✔`(U+2714) 在符号字体里都是**细笔画**，
 * 与 X 官方那种粗壮圆头的勾差别明显（用户对照截图指出过）。改用几何绘制：
 * 勾 = 两段「胶囊」（线段 + 圆头）的并集，点到线段距离 ≤ r 即在笔画内。
 * 圆头由距离判定天然得到（线段端点的距离场是球面），无需额外处理。
 *
 * @param size   徽标边长（勾按此尺寸的比例布局）
 * @param color  勾颜色（hex，如 '0xffffff'）
 * @returns {Promise<string|null>} 白勾 PNG 路径（带透明背景）
 */
/**
 * 精确测量一段文字在当前字体/字号下的**实际像素宽高**。
 *
 * 为什么需要：徽标要紧紧跟在昵称右侧、并与昵称垂直居中对齐，这两件事都必须知道
 * 文字的真实尺寸。按「字符数 × 字号 × 0.5」估算偏差很大（实测 "Sam Altman" 估算 165px、
 * 实际 198px，差 33px；徽标因此离昵称忽远忽近）。垂直方向同理：drawtext 的 y 是文字盒顶部，
 * 实际字形高度只有 0.8×字号 左右，用字号居中会让徽标偏下。
 *
 * 做法：把文字画到黑底画布上，逐像素扫描白色区域的包围盒——
 * 一次额外渲染（约 30ms），换来精确定位。
 *
 * @returns {Promise<{width, height, topOffset}|null>}
 */
/**
 * 按宽度上限截断文本并加省略号（超长昵称用）。
 *
 * 为什么必须做：drawtext **不会自动换行也不会裁剪**——文本超长就直接画到画布外，
 * 卡片右边缘会被文字顶破（实测中文长昵称在 1080 宽卡片上明显溢出）。X 的昵称长度上限
 * 是 50 字符，中文 50 字足够溢出，所以不能指望上游给的名字都短。
 *
 * 先用「字符数 × 字号 × 0.5」估算出接近上限的初始长度，再借 measureTextSize
 * 逐步回退到真正放得下为止——避免逐字盲试，也避免估算误差导致仍溢出。
 *
 * @returns {Promise<string>} 放得下的文本（必要时带 `…`）
 */
export async function fitTextEllipsis(text, fontPath, fontSize, maxWidth) {
  const s = String(text ?? '');
  if (!s || !Number.isFinite(maxWidth) || maxWidth <= 0) return s;
  const approxW = (t) => [...t].reduce((a, ch) => a + widthOf(ch) * fontSize * 0.5, 0);
  if (approxW(s) <= maxWidth * 0.9) return s;   // 估算就够短，省一次渲染

  const chars = [...s];
  let keep = Math.max(1, Math.floor(chars.length * (maxWidth / Math.max(1, approxW(s)))));
  if (keep >= chars.length) keep = chars.length - 1;   // 至少去掉一个字符才加得下省略号
  for (; keep >= 1; keep -= 1) {
    const cand = chars.slice(0, keep).join('') + '…';
    const m = await measureTextSize(cand, fontPath, fontSize);
    if (m && m.width <= maxWidth) return cand;
  }
  return chars.slice(0, 1).join('') + '…';
}

export async function measureTextSize(text, fontPath, fontSize) {
  const ff = findFfmpeg();
  if (!ff || !text) return null;
  const W = 1400;
  const H = Math.max(120, Math.ceil(fontSize * 3));
  const tf = writeTemp(normalizePunctuation(text));
  const outFile = writeTemp('', '.png');
  try {
    const res = await runFfmpeg(ff, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}`,
      '-vf', `drawtext=fontfile='${escFilterPath(fontPath)}':textfile='${escFilterPath(tf)}':x=0:y=0:fontsize=${fontSize}:fontcolor=white`,
      '-frames:v', '1', '-pix_fmt', 'rgb24',
      outFile
    ]);
    if (res.code !== 0 || !fs.existsSync(outFile)) return null;
    const buf = fs.readFileSync(outFile);
    // 用 ffmpeg 自己解码回原始像素，省得自己写 PNG 解码
    const rawFile = writeTemp('', '.rgb');
    const res2 = await runFfmpeg(ff, [
      '-y', '-v', 'error', '-i', outFile,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      rawFile
    ]);
    if (res2.code !== 0 || !fs.existsSync(rawFile)) return null;
    const px = fs.readFileSync(rawFile);
    let minX = W, maxX = -1, minY = H, maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (px[(y * W + x) * 3] > 40) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    try { fs.unlinkSync(rawFile); } catch {}
    if (maxX < 0) return null;
    return { width: maxX - minX + 1, height: maxY - minY + 1, topOffset: minY };
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tf); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

async function buildCheckMark(size, color = '0xffffff') {
  const ff = findFfmpeg();
  if (!ff) return null;
  const out = writeTemp('', '.png');
  const hex = String(color).replace(/^0x/i, '');

  // 勾的尺寸：对照 X 原版放大图批次调参选定——
  // inner=0.50（勾的内接框占徽标直径一半）、r=0.16（笔画半径相对 inner）。
  // 曾试 0.55/0.60，勾会顶到花瓣边缘甚至被圆裁掉，明显偏大。
  const inner = size * 0.50;
  const r = inner * 0.16;
  const off = (size - inner) / 2;                // 居中偏移

  // 勾的三个关键点（相对 inner 的比例）：左端 → 转折点 → 右端
  const P = { x1: 0.04, y1: 0.54, x2: 0.36, y2: 0.88, x3: 0.98, y3: 0.10 };
  const pts = [[P.x1, P.y1], [P.x2, P.y2], [P.x3, P.y3]].map(([x, y]) => [x * inner, y * inner]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const bboxCx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const bboxCy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const shiftX = inner / 2 - bboxCx + off;
  const shiftY = inner / 2 - bboxCy + off;
  const [[ax, ay], [bx, by], [cx, cy]] = pts.map(([x, y]) => [x + shiftX, y + shiftY]);

  // 点到线段的距离场：t 把点投影到线段上并 clamp 到 [0,1]
  const segDistance = (ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = `max(0,min(1,((${dx})*(X-${ax})+(${dy})*(Y-${ay}))/${len2}))`;
    return `hypot(X-(${ax}+${t}*${dx}),Y-(${ay}+${t}*${dy}))`;
  };

  const d1 = segDistance(ax, ay, bx, by);
  const d2 = segDistance(bx, by, cx, cy);
  // ffmpeg 表达式不支持 < / >，必须用 lte/lt
  const inside = `lte(min(${d1},${d2}),${r})`;

  const steps = [
    `color=c=0x${hex}:s=${size}x${size}:d=1,format=rgba[base]`,
    `color=c=black:s=${size}x${size}:d=1,format=gray,geq=lum='if(${inside},255,0)'[mask]`,
    `[base][mask]alphamerge[ck]`
  ];
  const res = await runFfmpeg(ff, [
    '-y', '-v', 'error',
    '-filter_complex', steps.join(';'),
    '-map', '[ck]',
    '-frames:v', '1', out
  ]);
  if (res.code !== 0 || !fs.existsSync(out) || !fs.statSync(out).size) return null;
  return out;
}

/**
 * 生成 X 的认证徽标形状：**圆瓣形**（不是正圆，也不是尖角花边）。
 *
 * X 的蓝V 是 8 个**圆润凸瓣**围成的一圈，瓣与瓣之间是平滑内凹（像云朵），
 * 而不是 `cos(Nθ)` 那种尖角花边。实现用半径的平滑幂调制：
 *   r(θ) = R * (1 - A + A * |cos(N/2·θ)|^0.5)
 * A≈0.14 时峰圆、谷平，与官方观感最接近（对比过 4 种画法后选定）。
 *
 * geq 表达式的坑：不支持 `<`/`>`，必须写 lte()/gte()；`^` 要写 pow()。
 */
async function buildScallopedBadge(color, size, { petals = 8, amplitude = 0.11 } = {}) {
  const ff = findFfmpeg();
  if (!ff) return null;
  const out = writeTemp('', '.png');
  const half = size / 2;
  const baseR = Math.max(1, half - Math.max(1.5, size * 0.02));   // 留一点边缘余量
  const hex = String(color).replace(/^0x/i, '');
  const dist = `hypot(X-${half},Y-${half})`;
  const angle = `atan2(Y-${half},X-${half})`;
  const wave = `pow(abs(cos(${petals / 2}*${angle})),0.5)`;
  const radius = `${baseR}*(1-${amplitude}+${amplitude}*${wave})`;
  const steps = [
    `color=c=0x${hex}:s=${size}x${size}:d=1,format=rgba[base]`,
    `color=c=black:s=${size}x${size}:d=1,format=gray,geq=lum='if(lte(${dist},${radius}),255,0)'[mask]`,
    `[base][mask]alphamerge[badge]`
  ];
  const res = await runFfmpeg(ff, [
    '-y', '-v', 'error',
    '-filter_complex', steps.join(';'),
    '-map', '[badge]',
    '-frames:v', '1', out
  ]);
  if (res.code !== 0 || !fs.existsSync(out) || !fs.statSync(out).size) return null;
  return out;
}

/** 下载头像并裁成圆形（取 400x400 高清版，接口默认只给 48px 缩略图）。 */
async function buildCircleAvatar(avatarUrl, { proxy = '', size = 96, timeoutMs = 20000 } = {}) {
  if (!avatarUrl) return null;
  const hiRes = String(avatarUrl).replace(/_(normal|mini|bigger|x96|reasonably_small)\.(jpg|png|jpeg)/i, '_400x400.$2');
  const ff = findFfmpeg();
  let rawFile = null;
  try {
    const r = await proxyGet(hiRes, { proxy, timeoutMs });
    const buf = r.body;
    if (!buf?.length) return null;
    rawFile = writeTemp(buf, '.jpg');
    const out = writeTemp('', '.png');
    const half = size / 2;
    const steps = [
      `[0:v]scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size},format=rgba[av]`,
      `[1:v]format=gray,geq=lum='if(lte((X-${half})^2+(Y-${half})^2,${(half - 1) ** 2}),255,0)'[mask]`,
      `[av][mask]alphamerge[rounded]`
    ];
    const res = await runFfmpeg(ff, [
      '-y', '-v', 'error',
      '-i', rawFile,
      '-f', 'lavfi', '-i', `color=c=black:s=${size}x${size}:d=1`,
      '-filter_complex', steps.join(';'),
      '-map', '[rounded]',
      '-frames:v', '1', out
    ]);
    if (res.code !== 0 || !fs.existsSync(out)) return null;
    return out;
  } catch {
    return null;
  } finally {
    if (rawFile) setTimeout(() => { try { fs.unlinkSync(rawFile); } catch {} }, 5000).unref?.();
  }
}

// ── 配色（白色亚克力卡片）──────────────────────────────────────────────────
// 设计取向：**纯白卡片 + 透明画布背景**（用户要求：卡片之外透明，可贴到任意底色/聊天背景上）。
// 阴影仍在卡片周围（叠在透明底上），但不再有实心底色。
// 层次不靠颜色而靠**灰度 + 字重**：标题最深最粗、正文深灰、次要信息中灰、页脚浅灰。
const THEME = {
  outerBg: '0x00000000',    // 画布底：**透明**（不再填充浅灰；改动见 buildAcrylicCard）
  cardBg: '0xffffff',       // 卡片面：纯白
  cardBorder: '0xe6ebf1',   // 卡片描边：极淡，只在边缘交代轮廓
  transBg: '0xffffff',      // 译文块：与卡片同色（用户要求卡片内背景保持白色）
  shadow: '0x0f172a',       // 阴影基色（深蓝黑，比纯黑柔和）
  accent: '0x1d9bf0',       // X 蓝（仅用于认证徽标与「显示原文」）
  textPrimary: '0x0f1419',  // 正文/昵称：近黑
  textSecondary: '0x536471', // 次要信息：中灰（X 官方灰）
  textMuted: '0x8b98a5',    // 最弱信息：浅灰
  divider: '0xeff3f4',      // 分隔线：极淡
  avatarRing: '0xe8edf2'    // 头像描边环：淡灰
};

/**
 * 渲染一条帖子为精致卡片 PNG。
 * @param {object} post  fetchPost 的返回值
 * @param {object} opts  { translation, proxy, ... }
 * @returns {Promise<{buffer, width, height} | null>}
 */
export async function renderPostImage(post, opts = {}) {
  const ff = findFfmpeg();
  if (!ff) return null;
  const fontRegular = pick(FONT_REGULAR);
  const fontBold = pick(FONT_BOLD);
  const fontSymbol = pick(FONT_SYMBOL);
  if (!fontRegular) return null;

  const {
    translation = '',
    proxy = '',
    showTranslation = true,
    width: reqWidth = 1080,
    maxLineWidth = 44,
    media = []          // [{ file, width, height }]：已下载到本地的帖子配图（见 media-cache.mjs）
  } = opts;

  const width = reqWidth;
  // 边距要**大于**阴影扩散半径（buildAcrylicCard 的 pad），否则卡片周围的阴影会被裁掉
  // （曾用 inset=22 < pad=30，画面顶部阴影缺失）。这里取 46 让阴影完整呼吸。
  const inset = 46;                                    // 卡片与画布边缘的留白（含阴影空间）
  const pad = 52;                                      // 卡片内边距
  const cardX = inset;
  const cardW = width - inset * 2;
  const contentX = cardX + pad;
  const contentW = cardW - pad * 2;

  const avatarSize = 96;
  const avatarX = contentX;
  const textX = avatarX + avatarSize + 24;

  // 正文与译文都从 textX 起、同宽 —— 用户要求「译文卡片和原文对齐」。
  // 内容不再从头像左侧的 contentX 起排，视觉上更整齐（左侧一列留给头像）。
  const bodyContentW = contentX + contentW - textX;
  const transContentW = bodyContentW;

  const bodySize = 31;
  const bodyLH = 52;                                   // 1.68x 行距，留白舒展
  const nameSize = 33;
  const metaSize = 25;
  const transSize = 29;
  const transLH = 50;
  const footSize = 24;

  const handle = String(post.user?.handle || '').replace(/^@/, '');
  const name = normalizePunctuation(post.user?.name || handle || 'X');

  // 译文文本先归一化（后面算块高与绘制都要用）
  const transSrc = normalizePunctuation(translation);

  // ── 正文折行 ────────────────────────────────────────────────────────────
  // 正文里的裸链接（如 t.co 短链）**不放在正文里**，统一挪到卡片底部页脚展示，
  // 否则正文与译文都会被长 URL 占掉一行、观感很差。
  const rawText = String(post.text || '（无正文）');
  const bodyExtracted = extractLinks(rawText);
  const bodyLines = wrapText(normalizePunctuation(bodyExtracted.text || '（无正文）'), maxLineWidth);
  const MAX_BODY = 30;
  const bodyTrunc = bodyLines.length > MAX_BODY;
  const shownBody = bodyTrunc ? bodyLines.slice(0, MAX_BODY) : bodyLines;
  if (bodyTrunc) shownBody.push('…（正文过长，完整内容见原帖）');
  const MAX_TRANS = 24;

  // 译文同样要剔掉链接（模型常把 URL 一并译出来）
  const transExtract = extractLinks(transSrc);
  const transClean = transExtract.text;

  // ── 译文折行：必须在算块高之前完成 ──────────────────────────────────────
  // 译文与正文同左边界、同宽（不再有左蓝条/内边距）
  const transInnerW = transContentW;
  const transMaxUnits = Math.max(20, Math.floor(transInnerW / (transSize * 0.55)));
  const transWrapped = (showTranslation && transClean) ? wrapText(transClean, transMaxUnits) : [];
  const transTruncW = transWrapped.length > MAX_TRANS;
  const shownTrans = transTruncW ? transWrapped.slice(0, MAX_TRANS) : transWrapped;
  if (transTruncW) shownTrans.push('…（译文过长已截断）');
  const transTitleH = 25 + 16;   // 标题字号 25 + 与译文正文的间距

  // ── 布局（先算完所有 Y，再生成图片，最后合成）──────────────────────────
  const cardTop = inset;
  let y = cardTop + pad;
  const headerTop = y;

  // 头部两行：第 1 行「昵称 + 认证徽标」，第 2 行「@handle · 相对时间」。
  // 为什么分行（2026-10-11 用户反馈）：原先三样挤在一行，昵称长的账号（如韩文/日文名）
  // 加 @handle 与时间后整行超出卡片右边缘、溢出边框。分行后横向只受昵称长度约束，
  // 且与 X 移动端「昵称在上、@handle 在下」的观感一致。
  const nameY = headerTop + 6;
  const metaLineGap = 10;                        // 昵称行与 @handle 行的间距
  const metaY = nameY + nameSize + metaLineGap;

  // 正文起点：在头部第二行之下再留约一个行距（保持原来「离昵称约一个行距」的紧凑观感）
  y = metaY + metaSize + bodyLH;
  const bodyTop = y;
  const bodyHeight = shownBody.length * bodyLH;
  y = bodyTop + bodyHeight;

  // ── 配图区域（布局阶段预留高度）────────────────────────────────────────
  // ── 配图区域（布局阶段预留高度）────────────────────────────────────────
  // 用户要求「图片裁剪到与卡片对齐」：图片**满宽贯穿卡片**（左右贴到卡片边缘，与 X 原版一致），
  // 而不是像正文那样缩进在头像右侧那一列里。
  // 注意：卡片外背景现在是透明的，所以图片必须是方角 —— 用圆角会在四角露出透明缺口。
  const mediaItems = (Array.isArray(media) ? media : []).filter((m) => m && m.file).slice(0, 4);
  let mediaBox = null;
  if (mediaItems.length) {
    y += 30;
    const gap = 4;                         // 网格间隙（贴边排布时用小间隙更整齐）
    const single = mediaItems.length === 1;
    const fullX = cardX;                   // 贴左边缘
    const fullW = cardW;                   // 贯穿整张卡片

    if (single) {
      // 单图：**完整显示，不裁切**。
      //
      // 历史坑（2026-10-10 用户反馈「带图片的帖子渲染不全」「图片上下被裁切了」）：
      // 原先写「满宽 + 限高 640，超高就裁掉上下」是为了贴边满宽的观感，
      // 但代价太大——内容区宽 884px，比例 h/w > 0.724 就会被切，实测：
      //   1:1 方图切掉 244px（上下各 122）、3:4 切 538px、9:16 切 932px。
      // 而插画帖绝大多数是方图/竖图，等于**大部分帖子都被切过**（只有横图幸免）。
      // 现在改为按原比例完整呈现：宽度优先铺满内容区，过高时改为**按高度回缩宽度**
      // （等比缩小、居中），这样永远不裁内容，也不会撑爆卡片。
      const m = mediaItems[0];
      const ar = (m.width && m.height) ? m.height / m.width : 0.75;
      const maxH = 900;                      // 单图最大高度：超过则等比缩小（不裁切）
      let w = fullW;
      let h = Math.round(w * ar);
      if (h > maxH) {
        h = maxH;
        w = Math.round(h / ar);              // 按高度反算宽度 → 等比缩放
      }
      const x = fullX + Math.round((fullW - w) / 2);   // 变窄时居中
      mediaBox = { cells: [{ file: m.file, x, y, w, h, cover: false }], top: y, h };
      y += h;
    } else {
      // 多图：2 列网格，格子等宽等高。
      // 格子内用 **contain（完整显示）而不是 cover（裁切）**：X 原版多图确实是裁切的，
      // 但裁切会切掉插画主体（用户反馈同一问题就是「渲染不全」）。宁可有留白，
      // 也不要切掉内容——所以格子高按「最宽那张」的实际比例算，再给每格 contain 显示。
      const cols = 2;
      const cellW = Math.floor((fullW - gap) / cols);
      // 格子高度取本组图片里最高的需求（contain 后按比例会在格内留白，不会裁切）
      const ars = mediaItems.map((m) => ((m.width && m.height) ? m.height / m.width : 0.75));
      const cellH = Math.min(900, Math.round(cellW * Math.max(...ars)));
      const rows = Math.ceil(mediaItems.length / cols);
      // 用与主路径**同一张**透明底作背景，避免 contain 留白处出现黑边
      const cells = mediaItems.map((m, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        return {
          file: m.file,
          x: fullX + col * (cellW + gap),
          y: y + row * (cellH + gap),
          w: cellW,
          h: cellH,
          cover: false
        };
      });
      const totalH = rows * cellH + (rows - 1) * gap;
      mediaBox = { cells, top: y, h: totalH };
      y += totalH;
    }
  }

  // 译文块（高度按实际行数算，避免多余留白）
  let transBlock = null;
  if (shownTrans.length) {
    y += 30;                                    // 正文与译文区之间的间隔（用分隔线 + 标题行区分）
    const blockTop = y;
    // 无背景块后不再需要大内边距：顶部分隔线紧贴 blockTop，标题行从下方一点开始
    const padY = 20;
    const blockH = padY + transTitleH + shownTrans.length * transLH - 6;
    transBlock = { top: blockTop, h: blockH, padY, lines: shownTrans };
    y = blockTop + blockH;
  }

  // 分隔线 + 元信息（分隔线用极淡灰，弱化到几乎只是暗示）
  y += 34;
  const dividerY = y;
  y += 28;
  const metaRowY = y;
  // 卡片底部要预留：互动数据行 + 页脚行 + 外链行（若有）+ 底部内边距。
  // 外链行数必须在布局阶段就算出来，否则卡片高度不够、底部内容会被裁掉。
  const footLinks = [...new Set([...bodyExtracted.links, ...transExtract.links])].slice(0, 3);
  y = metaRowY + footSize + 24 + (footSize - 2) + 6;
  // 与绘制处的间距保持一致（footSize+12 起排、每行 footSize+6），否则卡片底部留白不对
  if (footLinks.length) y += (footSize + 12) + (footSize + 6) * (footLinks.length - 1) + 2;

  // 卡片高度 = 内容总高 + 底部内边距；画布高度 = 卡片 + 上下 inset（inset 已含阴影空间）
  const cardH = y - cardTop;
  const height = cardTop + cardH + inset;

  // ── 生成图片素材 ────────────────────────────────────────────────────────
  const tmpFiles = [];
  const layers = [];   // { file, x, y, w, h }

  // 亚克力卡片（含柔和阴影，输出图自带 pad 的透明边距）
  const card = await buildAcrylicCard(cardW, cardH, 30, { pad: 30, steps: 8, strength: 13 });
  if (!card) return null;
  tmpFiles.push(card.file);
  layers.push({ file: card.file, x: cardX - card.pad, y: cardTop - card.pad, w: card.w, h: card.h });

  // 帖子配图（在卡片之上、译文块之下）。图片文件由 media-cache 提供，这里只负责排版。
  // 满宽贴边 + 方角：卡片外背景透明，加圆角会在四角露出透明缺口。
  if (mediaBox) {
    for (const c of mediaBox.cells) {
      layers.push({ file: c.file, x: c.x, y: c.y, w: c.w, h: c.h, cover: c.cover === true });
    }
  }

  // 译文区不再画独立底色块（卡片内已是纯白），改用「顶部分隔线 + ⊘ 标题行」与正文区分；
  // 分隔线的绘制放在 filters 声明之后（见下方译文区绘制），避免引用未初始化变量。

  // 头像环 + 头像
  const ringPad = 3;
  const ringFile = await buildCircle(THEME.avatarRing, avatarSize + ringPad * 2);
  if (ringFile) {
    tmpFiles.push(ringFile);
    layers.push({ file: ringFile, x: avatarX - ringPad, y: headerTop - ringPad, w: avatarSize + ringPad * 2, h: avatarSize + ringPad * 2 });
  }
  const avatarFile = await buildCircleAvatar(post.user?.avatar, { proxy, size: avatarSize });
  if (avatarFile) {
    tmpFiles.push(avatarFile);
    layers.push({ file: avatarFile, x: avatarX, y: headerTop, w: avatarSize, h: avatarSize });
  }

  // ── 字体分段与富文本测量（必须在布局计算之前定义）────────────────────
  // drawtext 只有一个 fontfile、没有回退链。雅黑(msyh)不含韩文与 emoji，遇到就渲染成方框 □
  // （实测：一条 53 个韩文字的帖子正文全是 □；emoji 📌 也是 □）。
  // 所以按字符分段、各段用能出字形的字体，见 segmentByFont / fontClassOf。
  const filters = [];
  const fontHangul = pick(FONT_HANGUL);
  const fontEmoji = pick(FONT_EMOJI);
  const fontFallback = pick(FONT_FALLBACK);
  const fontByClass = { hangul: fontHangul || fontFallback, emoji: fontEmoji || fontFallback };
  const fontForClass = (cls, base) => ((cls !== 'base' && fontByClass[cls]) ? fontByClass[cls] : base);

  /**
   * 量一段文本在「按字符分段渲染」后的真实宽度。
   *
   * 为什么要分段量：`measureTextSize` 只用**一个**字体渲染，而含韩文/emoji 的文本实际是
   * 用多个字体分段画的（见 draw）。用单字体量出来的宽度与真实落笔宽度不一致，
   * 会导致徽标/@handle 位置错位、文字重叠——实测昵称含韩文时 @handle 压在昵称上。
   * 纯 base 文本（绝大多数）走单字体测量，行为与改动前完全一致。
   */
  /**
   * 量一段文本的**步进宽度**（advance width）——即 drawtext 排下一段时的实际推进量。
   *
   * ⚠️ 不能用 `measureTextSize` 的返回值直接累加：它量的是**字形 bbox**（不含左右边距），
   * 而 drawtext 按**步进宽度**排版。实测（size=31）差异显著：
   *   emoji 📌 bbox=32 但步进=42（差 10px）、韩文 위치 bbox=55 步进=62、西文 @SD bbox=70 步进=74。
   * 逐段累加 bbox 会让每段都少推进一点，段数一多就累积成肉眼可见的重叠
   * （实测：昵称含韩文时 @handle 压在昵称末字上）。
   *
   * 求法：量「text+text」与「text」的 bbox 之差 —— 两倍串比单串多出的正好是一段的步进量。
   */
  const advanceWidth = async (text, fontPath, size) => {
    if (!text) return 0;
    const one = await measureTextSize(text, fontPath, size);
    if (!one) return 0;
    const two = await measureTextSize(text + text, fontPath, size);
    return two ? Math.max(one.width, two.width - one.width) : one.width;
  };

  /** 空格的占位宽度（bbox 量不到空白，用「中 中」与「中中」之差标定，约 0.3×字号）。 */
  const spaceWidth = (size) => Math.round(size * 0.3);

  /**
   * 量一段「按字符分段渲染」的富文本的真实宽度（含段间空格）。
   * 纯 base 文本走单字体测量，行为与改动前一致。
   */
  const measureRich = async (text, baseFont, size) => {
    const segs = segmentByFont(normalizePunctuation(text));
    if (!segs.some((s) => s.cls !== 'base')) return measureTextSize(text, baseFont, size);
    let width = 0;
    let height = 0;
    let topOffset = 0;
    for (const seg of segs) {
      const segText = seg.text;
      const lead = segText.match(/^\s+/)?.[0] ?? '';
      const tail = segText.match(/\s+$/)?.[0] ?? '';
      const core = segText.slice(lead.length, segText.length - tail.length);
      width += [...lead].length * spaceWidth(size);
      if (core) {
        const m = await measureTextSize(core, fontForClass(seg.cls, baseFont), size);
        if (m) {
          width += await advanceWidth(core, fontForClass(seg.cls, baseFont), size);
          height = Math.max(height, m.height);
          topOffset = Math.max(topOffset, m.topOffset);
        } else {
          width += Math.round([...core].reduce((a, ch) => a + widthOf(ch) * size * 0.5, 0));
        }
      }
      width += [...tail].length * spaceWidth(size);
    }
    return { width, height: height || Math.round(size * 0.8), topOffset };
  };

  // 认证徽标：X 的扇贝形（不是正圆）
  // 位置必须基于**实测文字尺寸**，不能按字号估算：
  //   - 水平：估算宽度对英文名偏差大（"Sam Altman" 估 165 实 198），徽标会忽远忽近；
  //   - 垂直：drawtext 的 y 是文字盒顶，字形实际高度约 0.8×字号，按字号居中会让徽标偏下。
  const badgeSize = 42;   // 对照 X 原版放大对比：徽标比昵称的大写高度略大
  // 昵称可用宽度 = 卡片右内边距 - 昵称起始 x - 徽标及其间距。
  // 超长昵称必须截断：drawtext 不会自动换行/裁剪，会直接顶破卡片右边缘把文字画到卡片外
  // （实测中文长昵称会溢出）。这里是**硬约束**，不能只靠 X 的昵称长度上限。
  const nameMaxW = (contentX + contentW) - textX - (badgeSize + 6);
  const nameFitted = await fitTextEllipsis(name, fontBold, nameSize, nameMaxW);
  if (nameFitted !== name) {
    // render.mjs 本身不带日志器，通过 opts.log 透传（调用方 XMonitor 会注入）
    try { opts.log?.(`[x-monitor] 昵称过长已截断：${String(name).slice(0, 20)}…`); } catch {}
  }
  const nameMetric = await measureRich(nameFitted, fontBold, nameSize);
  const nameW = nameMetric?.width ?? Math.round([...nameFitted].reduce((a, ch) => a + widthOf(ch) * nameSize * 0.5, 0));
  const nameGlyphH = nameMetric?.height ?? Math.round(nameSize * 0.8);
  const nameTopOffset = nameMetric?.topOffset ?? 0;
  // 昵称字形的视觉中线（相对 nameY）
  const nameGlyphCenterY = nameY + nameTopOffset + nameGlyphH / 2;
  const badgeX = textX + nameW + 6;      // 紧贴昵称（X 原版几乎连着，间距很小）
  const badgeY = Math.round(nameGlyphCenterY - badgeSize / 2);
  const badgeFile = await buildScallopedBadge(THEME.accent, badgeSize);
  if (badgeFile) {
    tmpFiles.push(badgeFile);
    layers.push({ file: badgeFile, x: badgeX, y: badgeY, w: badgeSize, h: badgeSize });
  }

  // ── 文本滤镜（在图层之上）──────────────────────────────────────────────
  // ── 文本滤镜（在图层之上）──────────────────────────────────────────────
  // 字体选择与 measureRich 已在布局计算前定义（徽标定位需要用到）。
  const draw = async (text, { x, y: ty, size, color, font = fontRegular }) => {
    if (text === '' || text == null) return;
    const norm = normalizePunctuation(text);
    // drawtext 只有一个 fontfile、没有回退链。含韩文/emoji 时雅黑会渲染成方框（□），
    // 所以按字符切成同字体段、逐段 drawtext。纯 base 文本走原来的单条路径，不做分段。
    const segs = segmentByFont(norm);
    const needsFallback = segs.some((s) => s.cls !== 'base');
    if (!needsFallback) {
      const f = writeTemp(norm);
      tmpFiles.push(f);
      filters.push(
        `drawtext=fontfile='${escFilterPath(font)}':textfile='${escFilterPath(f)}':x=${Math.round(x)}:y=${Math.round(ty)}:fontsize=${size}:fontcolor=${color}`
      );
      return;
    }
    // 逐段绘制。段间推进量必须用**步进宽度**（advanceWidth），与 drawtext 的实际排版一致；
    // 用 bbox 宽度会每段少推进一点，累积成重叠（见 advanceWidth 的注释）。
    let cursorX = Math.round(x);
    for (const seg of segs) {
      const segText = seg.text;
      if (!segText) continue;
      const lead = segText.match(/^\s+/)?.[0] ?? '';
      const tail = segText.match(/\s+$/)?.[0] ?? '';
      const core = segText.slice(lead.length, segText.length - tail.length);
      cursorX += [...lead].length * spaceWidth(size);
      if (core) {
        const f = writeTemp(core);
        tmpFiles.push(f);
        const segFont = fontForClass(seg.cls, font);
        filters.push(
          `drawtext=fontfile='${escFilterPath(segFont)}':textfile='${escFilterPath(f)}':x=${cursorX}:y=${Math.round(ty)}:fontsize=${size}:fontcolor=${color}`
        );
        cursorX += await advanceWidth(core, segFont, size);
      }
      cursorX += [...tail].length * spaceWidth(size);
    }
  };

  const textW = contentX + contentW - textX;   // 文本可用宽度（px）

  // 昵称 + 扇贝徽标 + 对勾（同一行，徽标紧贴昵称右侧）
  // 用截断后的 nameFitted（而非原 name），否则超长昵称仍会画到卡片外
  await draw(nameFitted, { x: textX, y: nameY, size: nameSize, color: THEME.textPrimary, font: fontBold });
  // 对勾用几何绘制的粗圆头勾（字体字符 ✓/✔ 都是细笔画，与 X 官方差别明显）。
  // 单独生成一张与徽标等大的透明底白勾 PNG，overlay 到徽标上——位置天然对齐。
  {
    const checkFile = await buildCheckMark(badgeSize, '0xffffff');
    if (checkFile) {
      tmpFiles.push(checkFile);
      layers.push({ file: checkFile, x: badgeX, y: badgeY, w: badgeSize, h: badgeSize });
    }
  }

  // 账号 + 相对时间（**第二行**，左对齐到昵称起始处，与头像下缘齐平排布）
  // 不再接在徽标右侧：那样昵称一长就顶出卡片右边缘（用户反馈溢出边框）。
  await draw(`@${handle}  ·  ${fmtAgo(post.createdAtMs)}`, {
    x: textX,
    y: metaY,
    size: metaSize,
    color: THEME.textSecondary
  });

  // 正文
  let by = bodyTop;
  for (const line of shownBody) {
    await draw(line || ' ', { x: textX, y: by, size: bodySize, color: THEME.textPrimary });
    by += bodyLH;
  }

  // 译文区：「⊘ 翻译自 <语言> 显示原文」标题行 + 译文正文（与正文同左边界）。
  // 语言名按原文自动识别（曾写死「英语」，日文帖会显示错）。
  const sourceLang = detectLangLabel(post.text);
  // 标题样式照 X 官方：⊘ 图标（U+2298）+ 灰色说明 + 蓝色「显示原文」。
  // 注意 ⊘ 必须用符号字体（雅黑无此字形，会变豆腐块）。
  // 不再画左侧竖条与独立底色块 —— 卡片内已是纯白，只靠标题行 + 顶部分隔线区分。
  if (transBlock) {
    // 顶部分隔线：把译文区与正文分开（卡片内纯白，靠这条线与标题行区分）
    filters.push(
      `drawbox=x=${textX}:y=${transBlock.top}:w=${transContentW}:h=1:color=${THEME.divider}:t=fill`
    );
    const innerX = textX;
    const titleY = transBlock.top + transBlock.padY;
    const iconSize = 25;
    let tx = innerX;
    if (fontSymbol) {
      await draw('\u2298', { x: tx, y: titleY - 2, size: iconSize + 3, color: THEME.textSecondary, font: fontSymbol });
      tx += iconSize + 8;
    }
    const label = `翻译自 ${sourceLang}`;
    await draw(label, { x: tx, y: titleY, size: iconSize, color: THEME.textSecondary });
    tx += Math.round([...label].reduce((a, ch) => a + widthOf(ch) * iconSize * 0.5, 0)) + 14;
    await draw('显示原文', { x: tx, y: titleY, size: iconSize, color: THEME.accent });
    let ty2 = titleY + transTitleH;
    for (const line of transBlock.lines) {
      await draw(line || ' ', { x: innerX, y: ty2, size: transSize, color: THEME.textPrimary });
      ty2 += transLH;
    }
  }

  // 分隔线（与正文同起点同宽）
  filters.push(
    `drawbox=x=${textX}:y=${dividerY}:w=${bodyContentW}:h=1:color=${THEME.divider}:t=fill`
  );

  // 互动数据：标签灰 + 数值亮（双色排版，分段绘制）
  const stats = [];
  if (Number(post.replies) > 0) stats.push(['回复', fmtCount(post.replies)]);
  if (Number(post.retweets) > 0) stats.push(['转推', fmtCount(post.retweets)]);
  if (Number(post.likes) > 0) stats.push(['喜欢', fmtCount(post.likes)]);
  let sx = textX;
  for (const [label, val] of stats) {
    await draw(label, { x: sx, y: metaRowY, size: footSize, color: THEME.textMuted });
    const labelW = Math.round([...label].reduce((a, ch) => a + widthOf(ch) * footSize * 0.5, 0));
    await draw(val, { x: sx + labelW + 6, y: metaRowY, size: footSize, color: THEME.textSecondary, font: fontBold });
    const valW = Math.round([...val].reduce((a, ch) => a + widthOf(ch) * footSize * 0.5, 0));
    sx += labelW + 6 + valW + 30;
  }
  // 时间（右对齐到内容右缘）
  const timeText = fmtTime(post.createdAtMs);
  const timeW = Math.round([...timeText].reduce((a, ch) => a + widthOf(ch) * footSize * 0.5, 0));
  await draw(timeText, { x: textX + bodyContentW - timeW, y: metaRowY, size: footSize, color: THEME.textMuted });

  // 页脚：图片数 + 正文里抽出的链接 + x.com/handle
  // 正文/译文里的 URL 都挪到这里统一展示（用户要求：别放在正文和翻译里）。
  let footY = metaRowY + footSize + 24;
  const footParts = [];
  if (post.media?.length) footParts.push(`含 ${post.media.length} 张图片`);
  footParts.push(`x.com/${handle}`);
  await draw(footParts.join('   ·   '), { x: textX, y: footY, size: footSize - 2, color: THEME.textMuted });

  // 帖子自带的外链（可能有多条）单独起一段，与上面的信息拉开距离
  // footLinks 在布局阶段已算好（用于预留高度），这里直接用。
  if (footLinks.length) {
    footY += footSize + 12;
    for (const link of footLinks) {
      await draw(`链接：${link}`, { x: textX, y: footY, size: footSize - 2, color: THEME.textMuted });
      footY += footSize + 6;
    }
  }

  // ── 合成 ────────────────────────────────────────────────────────────────
  // 主画布用**透明底**（用户要求卡片之外背景透明）；各层 overlay 后保留 alpha，
  // 输出 PNG 时用 -pix_fmt rgba 保住透明通道。
  const inputs = ['-f', 'lavfi', '-i', `color=c=0x00000000:s=${width}x${height}:d=1,format=rgba`];
  const steps = [];
  let cur = '[0:v]';
  let extraIdx = 0;
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    const idx = 1 + extraIdx++;
    inputs.push('-i', L.file);
    const outTag = `[m${i}]`;
    if (L.cover) {
      // 网格里的图：等比放大到填满格子后居中裁切（避免不同长宽比的图参差不齐）
      steps.push(
        `[${idx}:v]scale=${L.w}:${L.h}:force_original_aspect_ratio=increase,crop=${L.w}:${L.h},format=rgba[raw${i}]`
      );
    } else {
      // 单图：按原比例完整显示（不裁切内容）
      steps.push(`[${idx}:v]scale=${L.w}:${L.h}:force_original_aspect_ratio=decrease,format=rgba[raw${i}]`);
    }
    if (L.radiusFile) {
      // 圆角：把同尺寸圆角遮罩的 alpha 提取出来，合成到图片上。
      // 注意 scale 只接受一个输入 —— 不能写 [img][mask]scale（会报
      // "More input link labels specified for filter 'scale'"），遮罩要单独 scale。
      const midx = 1 + extraIdx++;
      inputs.push('-i', L.radiusFile);
      steps.push(`[${midx}:v]scale=${L.w}:${L.h},format=rgba[mk${i}]`);
      steps.push(`[mk${i}]alphaextract[a${i}]`);
      steps.push(`[raw${i}][a${i}]alphamerge[L${i}]`);
    } else {
      steps.push(`[raw${i}]null[L${i}]`);
    }
    steps.push(`${cur}[L${i}]overlay=x=${Math.round(L.x)}:y=${Math.round(L.y)}:format=auto${outTag}`);
    cur = outTag;
  }
  steps.push(`${cur}${filters.join(',')}[out]`);

  const outFile = writeTemp('', '.png');
  const res = await runFfmpeg(ff, [
    '-y', '-v', 'error',
    ...inputs,
    '-filter_complex', steps.join(';'),
    '-map', '[out]',
    '-frames:v', '1',
    '-pix_fmt', 'rgba',   // 保住透明通道（卡片外透明）
    outFile
  ]);
  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
  if (res.code !== 0 || !fs.existsSync(outFile)) {
    try { process.stderr.write(`[x-monitor] 渲染失败 code=${res.code}: ${String(res.err).slice(0, 300)}\n`); } catch {}
    return null;
  }
  const buffer = fs.readFileSync(outFile);
  try { fs.unlinkSync(outFile); } catch {}
  if (!buffer.length) return null;
  return { buffer, width, height };
}
