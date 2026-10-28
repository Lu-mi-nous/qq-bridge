// 群友功能声明：纯数据 + 自包含 HTML。只列群友可用的能力，运行时按开关筛选。
// 浏览器渲染和本地缓存在 feature-menu-render.js；这里不读取配置或凭据。
import { findUpscaylBin } from '../../../src/plugin-api/process.js';
import { MENU_RENDER_CSS } from './feature-menu-css.js';

export const MENU_SECTIONS = [
  {
    id: 'image', title: '看图与找图', note: '发张图，再告诉我你想看什么',
    items: [
      { k: '看图聊图', v: '看 QQ 图片、表情和可访问的图片链接；动图可抽帧查看。', feature: 'vision' },
      { k: '超分放大', v: '说“帮我超分/放大一下/来个高清的”，把图放大变清晰发回来。', feature: 'upscale' },
      { k: '按需找图', v: '按角色、主题或标签找现有图片，挑好后发到聊天里。', feature: 'images' },
      { k: '指定图源', v: '可以指定已支持的图站；来源不可用或没找到时会说明。', feature: 'images' },
      { k: '查图片出处', v: '尝试反查画师与作品链接；不保证每张图都能找到。', feature: 'reverse' },
      { k: '收藏原图', v: '把能取到的原图存到机器人本地，不等于发回原图文件。', feature: 'archive' },
      { k: '换一张', v: '刚发的图不合心意，可以说“换一张”，让我重新挑。', feature: 'swap' },
    ],
  },
  {
    id: 'share', title: '读链接与分享', note: '附上链接或卡片，说清想了解哪部分',
    items: [
      { k: '联网查资料', v: '搜索公开资料、梗和术语，再结合找到的内容回答。', feature: 'search' },
      { k: '公众号文章', v: '读取可访问的正文与配图，帮你概括要点。' },
      { k: '普通网页', v: '读取可访问的网页文字；登录、验证或付费限制可能打不开。' },
      { k: 'B 站视频卡片', v: '解析标题、链接和封面；这不代表已经看过视频内容。' },
      { k: '其他分享卡片', v: '识别小红书、音乐、位置等卡片里已有的信息。' },
      { k: '合并转发', v: '读取转发的聊天记录；里面的图片可进一步查看。', feature: 'forward' },
    ],
  },
  {
    id: 'chat', title: '聊天与文字', note: '直接 @ 我，把想说的话接在后面',
    items: [
      { k: '聊天搭话', v: '闲聊、接梗、讨论想法；忙的时候可能晚一点回应。' },
      { k: '文字帮忙', v: '解释、总结、改写、写文案；把用途和要求一起告诉我。' },
      { k: '外文翻译', v: '贴上文字或可读取的内容，可以翻译、解释表达。' },
    ],
  },
  {
    id: 'sticker', title: '表情与互动', note: '有时候，一张表情比一大段话更合适',
    items: [
      { k: '发表情包', v: '从已有表情库里挑合适的图，配合聊天发出来。', feature: 'stickers' },
      { k: '收藏表情', v: '引用表情说“收下这个”，可尝试存进机器人的表情库。', feature: 'collect' },
      { k: '贴表情回应', v: '可以给群消息贴表情，是否使用由聊天语境决定。', feature: 'react' },
      { k: '拍一拍', v: '聊天时可以拍一拍互动，不保证每次都回拍。', feature: 'poke' },
    ],
  },
  {
    id: 'x', title: '查看 X 动态', note: '按需查询；账号名写成 @handle 更准确',
    items: [
      { k: '最近发帖', v: '说“看看某账号最近的帖子”，可生成帖子卡片发来。', feature: 'x' },
      { k: '按日期查找', v: '可指定日期尝试查找；历史范围受可访问内容限制。', feature: 'x' },
      { k: '配图与翻译', v: '按已开启的能力附配图、中文翻译或可发送的视频。', feature: 'x' },
    ],
  },
  {
    id: 'memory', title: '聊天记忆', note: '记忆用于后续聊天，不是定时提醒',
    items: [
      { k: '记住一件事', v: '说“记住我喜欢……”，可保存到本会话的聊天记忆。', feature: 'memory' },
      { k: '查查记忆', v: '问“你还记得什么”，可以查看这个会话里记下的内容。', feature: 'memory' },
      { k: '忘掉某件事', v: '可以移除机器人保存的记忆，不会删除 QQ 聊天记录。', feature: 'memory' },
    ],
  },
];

export const MENU_HEADER = {
  name: 'QQ 小伙伴',
  tagline: '陪你聊天，也帮你找点有意思的',
  hint: '不用记命令，直接说需求。下面是可以找我做的事。',
};
export const MENU_FOOTER = {
  call: '想再看这张图：@ 我说“你会什么”或“功能声明”。',
  limit: '读不到、找不到或暂时用不了时，会如实说明。',
};

/** null 表示完整能力示例；传入配置时仅展示对应开关允许的条目。 */
export function featureMenuSections(config = null) {
  if (config === null) return MENU_SECTIONS;
  const v2 = config.socialV2 ?? {};
  const tool = (name) => v2.enabled !== false && v2.tools?.[name] !== false;
  const images = v2.images?.enabled === true && tool('sendImage');
  const sticker = v2.sticker?.enabled !== false;
  const enabled = {
    vision: tool('getImages'),
    // 超分：配置开着 **且本机真的能找到 upscayl-bin** 才列进菜单。
    // 为什么不只看配置：菜单是给群友看的能力清单，列了却做不了比不列更糟
    // （群友会去试，然后失望）。这里的检查只是 stat 文件，不启动进程，开销可忽略。
    upscale: v2.upscale?.enabled !== false && !!findUpscaylBin({
      binDir: v2.upscale?.binDir || undefined
    }),
    images,
    reverse: tool('reverseSearch') && config.imageReverseSearch?.enabled !== false && !!(String(config.socialV2?.images?.reverseSearchApiKey || config.imageReverseSearch?.apiKey || '').trim()),
    archive: images && tool('archiveImage'),
    swap: images && v2.images?.feedbackSwap !== false,
    search: config.webSearch?.enabled !== false,
    forward: tool('getForwardMsg'),
    stickers: sticker && tool('sendSticker'),
    collect: sticker && v2.sticker?.collect?.enabled !== false && tool('collectSticker'),
    react: v2.emojiReact?.enabled !== false && tool('reactMessage'),
    poke: tool('sendPoke'),
    x: tool('fetchXPosts'),
    memory: tool('memory'),
  };
  return MENU_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.feature || enabled[item.feature]).map((item) =>
      item.feature === 'vision' && v2.gifFrames?.enabled === false
        ? { ...item, v: '看 QQ 图片、表情和可访问的图片链接，结合画面聊内容。' }
        : item),
  })).filter((section) => section.items.length);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 自包含 HTML：图片仅接收 PNG data URL，角色名与文案均转义。 */
export function buildFeatureMenuHtml({ inlineImage = false, imageDataUrl = '', config = null, roleName = '' } = {}) {
  const name = String(roleName || MENU_HEADER.name).trim().slice(0, 40) || MENU_HEADER.name;
  const selected = featureMenuSections(config);
  const sections = selected.map((section, index) => `
    <section class="card" data-section="${escapeHtml(section.id)}">
      <header class="card-hd"><span class="number">${String(index + 1).padStart(2, '0')}</span><h2>${escapeHtml(section.title)}</h2></header>
      <p class="note">${escapeHtml(section.note)}</p>
      <ul class="items">${section.items.map((item) => `
        <li class="item"><span class="k">${escapeHtml(item.k)}</span><span class="v">${escapeHtml(item.v)}</span></li>`).join('')}
      </ul>
    </section>`).join('');
  const safeImage = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl);
  const avatar = inlineImage && safeImage ? `<img class="avatar" src="${imageDataUrl}" alt="">` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1080">
<title>${escapeHtml(name)} · 功能声明</title>
<style>${MENU_RENDER_CSS}</style>
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <div class="hero-txt">
        <p class="eyebrow">群友功能说明 <span>直接说需求就好</span></p>
        <h1>${escapeHtml(name)}<span>可以做这些</span></h1>
        <p class="tagline">${escapeHtml(MENU_HEADER.tagline)}</p>
      </div>${avatar}
    </header>
    <div class="intro"><p>${escapeHtml(MENU_HEADER.hint)}</p><span>${config === null ? '能力示例' : '按当前启用项展示'}</span></div>
    <main class="grid">${sections}</main>
    <footer class="foot">
      <p class="call">${escapeHtml(MENU_FOOTER.call)}</p>
      <p class="limit">${escapeHtml(MENU_FOOTER.limit)}</p>
    </footer>
  </div>
  <script>
    // 系统字体与固定头像尺寸可立即量高；加载完成后复测，兼容 Chrome CLI 的 dump-dom。
    (function () {
      function measure() {
        document.documentElement.setAttribute('data-h', String(Math.ceil(document.querySelector('.wrap').getBoundingClientRect().height)));
      }
      measure();
      document.fonts.ready.then(measure);
      window.addEventListener('load', measure);
    })();
  </script>
</body>
</html>`;
}

export function menuStats(config = null) {
  const sections = featureMenuSections(config);
  return { sections: sections.length, items: sections.reduce((count, section) => count + section.items.length, 0) };
}
