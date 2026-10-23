// 回归测试：群友功能菜单（HTML+CSS → Chrome 无头截图 → 发给群友）。
//
// 背景（2026-10-12 用户要求）：「写一个自身简要的功能菜单(HTML+CSS)，力求精致美观，
// 只包含群友可调用的相关功能，当群友问及机器人功能时给出渲染图」
//
// 关键约束（错了会出问题的地方）：
//   1. **只列群友真能触发的功能**。不能写内部调度机制（唤醒优先级/沉睡拦截/报错转发），
//      也不能写管理员专属能力（closed-agent 里操控 DSH）——写出来群友会去试，然后失望。
//   2. **渲染必须真能出图**。Chrome CLI 没有 full-page：给固定高度会留白或截断，
//      所以要先量高度再截（这里断言高度确实按内容走了）。
//   3. **失败不能退化成编内容**。渲染失败时工具报错、模型如实说"生成不了"，
//      而不是顺手编一份文字版功能清单（那份清单多半包含做不到的事）。
//   4. **发送由桥接完成**。模型没有"发送任意图片"的能力（qq_send_image 只认图库），
//      所以工具语义是"渲染 + 直接发到当前会话"，不是把 base64 还给模型。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const m = await import(new URL('../src/feature-menu.js', import.meta.url));
const { MENU_SECTIONS, MENU_HEADER, MENU_FOOTER, buildFeatureMenuHtml, menuStats, escapeHtml } = m;

const renderSrc = fs.readFileSync(path.join(root, 'src/feature-menu-render.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
const mcpSrc = fs.readFileSync(path.join(root, 'src/mcp-snowluma-safe.js'), 'utf8');
const roleSrc = fs.readFileSync(path.join(root, 'roles/大肥鱼.md'), 'utf8');

console.log('── 1. 内容只含群友能触发的功能 ──');
{
  const stats = menuStats();
  check('有多个分区', stats.sections >= 5, `${stats.sections} 个分区`);
  check('条目数量合理（不空也不臃肿）', stats.items >= 20 && stats.items <= 60, `${stats.items} 条`);
  check('每个分区都有标题和条目', MENU_SECTIONS.every((s) => s.title && s.items.length > 0));
  check('每条都有 k（功能名）和 v（说明）', MENU_SECTIONS.every((s) => s.items.every((i) => i.k && i.v)));
  check('分区 id 唯一', new Set(MENU_SECTIONS.map((s) => s.id)).size === MENU_SECTIONS.length);

  // 必须覆盖用户明确要求的三类能力
  const all = JSON.stringify(MENU_SECTIONS);
  check('提到 B 站视频', /B 站视频/.test(all));
  check('提到公众号文章', /公众号文章/.test(all));
  check('提到小程序/分享卡片', /分享卡片|小红书/.test(all));
}

console.log('\n── 2. 不能出现内部机制与管理员能力 ──');
{
  const all = JSON.stringify(MENU_SECTIONS) + JSON.stringify(MENU_HEADER) + JSON.stringify(MENU_FOOTER);
  // 内部调度术语：群友看不到也用不到，写出来只会出戏
  const internalTerms = [
    ['唤醒优先级', '内部调度机制'],
    ['沉睡', '内部调度机制'],
    ['批窗口', '内部调度机制'],
    ['报错转发', '内部机制'],
    ['noActionLimit', '配置项'],
    ['token', '内部凭据'],
    ['closed-agent', '管理员专属模式'],
    ['router-standard', '管理员专属 preset'],
    ['DSH', '内部组件名'],
    ['MCP', '内部组件名'],
    ['qq_', '内部工具名'],
    ['sessionId', '内部标识'],
  ];
  for (const [term, why] of internalTerms) {
    check(`不出现「${term}」（${why}）`, !all.includes(term), all.includes(term) ? '出现于菜单文案' : '');
  }
  // 工具名一个都不该出现（群友不需要记命令）
  const toolNames = ['qq_send_message', 'qq_mark_read', 'qq_reverse_search', 'web_search', 'qq_fetch_x_posts'];
  for (const t of toolNames) check(`不暴露工具名 ${t}`, !all.includes(t));
}

console.log('\n── 3. HTML 生成 ──');
{
  const html = buildFeatureMenuHtml();
  check('是完整 HTML 文档', /^<!DOCTYPE html>/.test(html) && /<\/html>$/.test(html.trim()));
  check('声明 UTF-8（中文不乱码）', /charset="utf-8"/.test(html));
  check('内联了 CSS（整页自包含）', /<style>/.test(html) && html.length > 3000);
  check('每个分区都渲染出来', MENU_SECTIONS.every((s) => html.includes(s.title)));
  check('每条 item 都渲染出来', MENU_SECTIONS.every((s) => s.items.every((i) => html.includes(i.v.slice(0, 12)))));
  check('含两列网格', /grid-template-columns/.test(html));
  check('含渐变（精致感的技术前提）', /linear-gradient|radial-gradient/.test(html));
  check('含圆角与投影', /border-radius/.test(html) && /box-shadow/.test(html));
  check('有高度上报脚本（供截图裁剪）', /data-h/.test(html));
  check('无外部资源引用（离线可渲染）', !/<link[^>]+href="http/.test(html) && !/<script[^>]+src=/.test(html));
}

console.log('\n── 4. 形象图内联 ──');
{
  const withImg = buildFeatureMenuHtml({ inlineImage: true, imageDataUrl: 'data:image/png;base64,AAAA' });
  check('inlineImage=true 时内联 data URL', withImg.includes('data:image/png;base64,AAAA'));
  check('内联时出现 avatar 元素', /class="avatar"/.test(withImg));
  const without = buildFeatureMenuHtml({ inlineImage: false });
  check('inlineImage=false 时不带图（不报错）', !/class="avatar"/.test(without));
  const emptyUrl = buildFeatureMenuHtml({ inlineImage: true, imageDataUrl: '' });
  check('图缺失时不生成空 img（避免裂图）', !/<img[^>]+src=""/.test(emptyUrl));
}

console.log('\n── 5. HTML 转义（防注入）──');
{
  check('转义 < >', escapeHtml('<b>') === '&lt;b&gt;');
  check('转义 & 与引号', escapeHtml('a&b"c\'d') === 'a&amp;b&quot;c&#39;d');
  check('null 不崩', escapeHtml(null) === '');
}

console.log('\n── 6. 渲染实现（高度自适应 + 缓存 + 可读报错）──');
{
  check('找浏览器（Chrome 优先，Edge 兜底）', /findBrowser/.test(renderSrc) && /msedge\.exe/.test(renderSrc));
  check('找不到浏览器有可读报错', /未找到 Chrome\/Edge/.test(renderSrc));
  check('用 --headless=new（新版推荐）', /--headless=new/.test(renderSrc));
  check('先量高度再截图（Chrome 无 full-page）', /measureHeight/.test(renderSrc) && /--dump-dom/.test(renderSrc));
  check('宽度固定 1080', /MENU_WIDTH = 1080/.test(renderSrc));
  check('有高度上限防御', /MAX_HEIGHT = \d+/.test(renderSrc));
  check('按内容指纹缓存', /menuCacheKey/.test(renderSrc) && /sha1/.test(renderSrc));
  check('缓存命中时跳过渲染', /命中缓存/.test(renderSrc));
  check('跨盘 rename 已规避（中间产物同盘）', /EXDEV|同盘/.test(renderSrc));
  check('渲染结果过小判为失败', /渲染结果异常/.test(renderSrc));
  check('原子替换（不留半张图）', /renameSync/.test(renderSrc));
  check('浏览器路径可用环境变量覆盖', /CHROME_PATH/.test(renderSrc));
}

console.log('\n── 7. 桥接侧：直接发送而不是回传 base64 ──');
{
  check('端点名表示发送语义', /\/api\/socialV2\/send-feature-menu/.test(bridgeSrc));
  check('端点调用了发图函数', /onebotSendImageFile\(key, r\.file/.test(bridgeSrc));
  check('发送前校验 agent token', /send-feature-menu[\s\S]{0,900}agentTokenOk/.test(bridgeSrc));
  check('发送前校验模式准入', /send-feature-menu[\s\S]{0,1200}modeAllowed/.test(bridgeSrc));
  check('发送前检查静默开关', /send-feature-menu[\s\S]{0,1000}socialV2\.paused/.test(bridgeSrc));
  check('支持 refresh 强制重渲染', /refresh.*===.*'1'/.test(bridgeSrc));
  check('发送成功写活动日志', /已发送功能菜单图/.test(bridgeSrc));
  check('不再回传 image.data（避免模型误以为要自己发）', !/send-feature-menu[\s\S]{0,600}image: \{ mimeType/.test(bridgeSrc));

  // ── 安全：agent token 必须是**必需**的 ──
  // 踩过：最初写成 `if (agentToken && !agentTokenOk(...))`，空 token 会跳过全部校验。
  // 控制台显式关闭鉴权时尤其不能依赖管理令牌兜底，发送仍需有效会话令牌。
  const segStart = bridgeSrc.indexOf("'/api/socialV2/send-feature-menu'");
  // 只截到本端点结束（下一个端点声明之前），避免把别的端点的旧写法算进来
  const nextRoute = bridgeSrc.indexOf("url.pathname === '/api/socialV2/", segStart + 10);
  const rawBody = bridgeSrc.slice(segStart, nextRoute > 0 ? nextRoute : segStart + 2600);
  // 去掉注释行再断言：本端点的注释里为说明历史而引用了旧写法，
  // 直接在原文上匹配会命中注释（误判为"仍在使用可选写法"）。
  const body = rawBody.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  check('空 agent token 被拒（不是可选）', /if \(!req\.headers\['x-agent-token'\]\)/.test(body));
  check('不再用「有 token 才校验」的可选写法', !/if \(agentToken && !agentTokenOk/.test(body));
  check('校验 agent token 有效性', /agentTokenOk\(key, req\.headers\['x-agent-token'\]\)/.test(body));
  check('受静默开关约束', /shouldBlockSilentReply/.test(body));
}

console.log('\n── 8. MCP 工具契约 ──');
{
  check('工具名是 send 语义', /'qq_send_feature_menu'/.test(mcpSrc));
  check('工具已按开关注册', /tools\?\.getFeatureMenu !== false[\s\S]{0,200}qq_send_feature_menu/.test(mcpSrc));
  check('描述要求发完别复述菜单', /不要.{0,6}复述/.test(mcpSrc));
  check('失败时要求如实说、不编清单', /不要改口编一份文字版功能清单/.test(mcpSrc));
  // 工具开关清单已迁到 src/tool-flags.js（2026-10-20 重构：单一事实源，
  // 避免"加工具忘了加开关"）。这里改为检查那份清单，不再盯 bridge.js 里的数组字面量。
  //
  // 2026-10-21 修正：原断言用的是 `flag: 'sendFeatureMenu'`，但代码里（MCP 注册处
  // 与桥接端点）检查的一直是 `getFeatureMenu`。也就是说控制台那个开关**拨了没反应**，
  // 而这条测试还一直"通过"——它锁错了名字，反而把这个 bug 保护住了。
  const flagsSrc = fs.readFileSync(new URL('../src/tool-flags.js', import.meta.url), 'utf8');
  check('工具映射到正确的开关名',
    /flag: 'getFeatureMenu', tools: \['qq_send_feature_menu'\]/.test(flagsSrc));
  check('开关默认开启',
    !/flag: 'getFeatureMenu'[^}]*default: false/.test(flagsSrc));
  check('工具在开关清单里', /qq_send_feature_menu/.test(flagsSrc));
  // 反向断言：那个空壳名字不许再出现（否则又会有人照着它去写检查）
  check('没有残留的空壳开关 sendFeatureMenu', !/flag: 'sendFeatureMenu'/.test(flagsSrc));
}

console.log('\n── 9. 人格卡触发指引 ──');
{
  check('人格卡提到功能菜单工具', /qq_send_feature_menu/.test(roleSrc));
  check('覆盖「你会啥」这类问法', /你会啥|能干嘛|有什么功能/.test(roleSrc));
  check('要求发完只说很短的话', /只说一句很短的话|短的话/.test(roleSrc));
  check('要求失败时不编文字版', /不要改口编一份文字版/.test(roleSrc));
}

console.log('\n── 10. 实际启用能力、准确声明与缓存失效 ──');
{
  const fullConfig = { socialV2: { images: { enabled: true } }, imageReverseSearch: { apiKey: 'test-only-secret' } };
  const full = buildFeatureMenuHtml({ config: fullConfig, roleName: '测试角色' });
  const off = buildFeatureMenuHtml({ config: {
    webSearch: { enabled: false },
    socialV2: { images: { enabled: false }, sticker: { enabled: false },
      emojiReact: { enabled: false }, tools: { memory: false, fetchXPosts: false, getImages: false, getForwardMsg: false, sendPoke: false } },
  } });
  for (const label of ['按需找图', '查图片出处', '收藏原图', '聊天记忆', '查看 X 动态', '联网查资料', '合并转发', '表情与互动', '看图聊图']) {
    check(`能力关闭后不展示「${label}」`, !off.includes(label));
    check(`能力开启时正常展示「${label}」`, full.includes(label));
  }
  check('默认关闭的图库不被当成已启用', !buildFeatureMenuHtml({ config: {} }).includes('按需找图'));
  check('普通聊天不被功能筛选误删', off.includes('聊天与文字'));
  check('关闭动图抽帧后不再声明抽帧能力', !buildFeatureMenuHtml({ config: { socialV2: { gifFrames: { enabled: false } } } }).includes('动图可抽帧'));
  check('不会把凭据写进 HTML', !full.includes('test-only-secret'));
  check('使用传入角色名', full.includes('测试角色'));
  check('角色名中的 HTML 被转义', !buildFeatureMenuHtml({ roleName: '<img src=x onerror=alert(1)>' }).includes('<img src=x'));
  check('拒绝头像属性注入', !buildFeatureMenuHtml({ inlineImage: true, imageDataUrl: 'x" onerror="alert(1)' }).includes('<img'));
  check('说明 B 站卡片与视频内容的区别', full.includes('不代表已经看过视频内容'));
  check('说明记忆不是提醒服务', full.includes('不是定时提醒'));
  check('说明原图保存在本地', full.includes('存到机器人本地'));
  check('不再承诺每次都回复', !/被叫到必回|每次必回|历史都查得到/.test(full));
  const { menuCacheKey } = await import('../src/feature-menu-render.js');
  const options = { config: fullConfig, roleName: '测试角色' };
  const key = menuCacheKey(options);
  check('相同内容指纹稳定', key === menuCacheKey(options));
  check('角色变化使缓存失效', key !== menuCacheKey({ ...options, roleName: '另一个角色' }));
  check('功能关闭使缓存失效', key !== menuCacheKey({ ...options, config: { ...fullConfig, webSearch: { enabled: false } } }));
  check('不相关的配置不引起重渲染', key === menuCacheKey({ ...options, config: { ...fullConfig, sendDelayMs: 999 } }));
  check('已配置凭据换值不改变可见内容与缓存', key === menuCacheKey({ ...options, config: { ...fullConfig, imageReverseSearch: { apiKey: 'another-test-secret' } } }));
  check('任何角色的唤醒都能获知功能声明工具', bridgeSrc.includes('const menuLine =') && /const base = .*menuLine/.test(bridgeSrc));
}

console.log('\n── 11. 实际发送路由的隔离验证（发送器为本地替身）──');
{
  const start = bridgeSrc.indexOf("if (req.method === 'GET' && url.pathname === '/api/socialV2/send-feature-menu')");
  const end = bridgeSrc.indexOf("if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note')", start);
  if (start < 0 || end <= start) throw new Error('找不到功能菜单路由边界');
  const route = bridgeSrc.slice(start, end);
  async function invoke(overrides = {}) {
    let response, renders = 0, sends = 0, renderOptions;
    const context = {
      req: { method: 'GET', headers: { 'x-agent-token': 'session-test' } },
      url: new URL('http://127.0.0.1/api/socialV2/send-feature-menu?key=group:123'),
      cfg: { socialV2: { tools: { getFeatureMenu: true } } },
      currentMode: 'reserved2', socialV2: { paused: false },
      agentTokenOk: (_key, token) => token === 'session-test',
      v2SessionAllowed: () => true, v2ToolEnabled: () => true, modeAllowed: () => true,
      shouldBlockSilentReply: () => false, readRoleState: () => ({ role: '测试角色' }),
      renderFeatureMenu: async (options) => { renders++; renderOptions = options; return { ok: true, file: 'local-menu.png', bytes: 4096, cached: true }; },
      onebotSendImageFile: async () => { sends++; },
      log: () => {}, appendActivity: () => {},
      sendJson: (body, status = 200) => { response = { body, status }; },
      ...overrides,
    };
    await vm.runInNewContext(`(async () => { ${route} })()`, context);
    return { response, renders, sends, renderOptions, cfg: context.cfg };
  }
  const good = await invoke();
  check('允许的请求恰好发送一次图片', good.response.status === 200 && good.renders === 1 && good.sends === 1);
  check('路由使用运行时配置与当前角色', good.renderOptions.config === good.cfg && good.renderOptions.roleName === '测试角色');
  check('缓存命中信息返回给调用方', good.response.body.cached === true);
  for (const [label, override] of [
    ['缺失令牌', { req: { method: 'GET', headers: {} } }],
    ['错误令牌', { req: { method: 'GET', headers: { 'x-agent-token': 'wrong-session' } } }],
    ['未授权会话', { v2SessionAllowed: () => false }],
    ['功能关闭', { v2ToolEnabled: () => false }],
    ['暂停', { socialV2: { paused: true } }],
    ['静默', { shouldBlockSilentReply: () => true }],
    ['模式不允许发送', { modeAllowed: () => false }],
  ]) {
    const result = await invoke(override);
    check(`${label}时拒绝且不渲染、不发送`, result.response.status === 403 && result.renders === 0 && result.sends === 0);
  }
  const failed = await invoke({ renderFeatureMenu: async () => ({ ok: false, error: 'test-unavailable' }) });
  check('渲染失败显式报错且不发送', failed.response.status === 500 && failed.sends === 0 && failed.response.body.ok === false);
}

if (process.argv.includes('--render')) {
  console.log('\n── 12. 真实 PNG、并发合并与缓存复用（不连接 QQ）──');
  const { renderFeatureMenu } = await import('../src/feature-menu-render.js');
  const options = { config: { socialV2: { images: { enabled: true } }, imageReverseSearch: { apiKey: 'test-only' } }, roleName: '菜单渲染回归' };
  let outputFile;
  try {
    const logs = [];
    const [a, b] = await Promise.all([
      renderFeatureMenu({ ...options, force: true, log: (message) => logs.push(message) }),
      renderFeatureMenu({ ...options, force: true, log: (message) => logs.push(message) }),
    ]);
    check('真实浏览器生成成功', a.ok && b.ok, a.error || b.error || '');
    if (a.ok && b.ok) {
      outputFile = a.file;
      check('同内容并发只渲染一次', a.file === b.file && logs.filter((line) => line.includes('已渲染')).length === 1);
      const bytes = fs.readFileSync(a.file);
      check('产物是真实 PNG', bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
      check('宽度正确且高度在完整海报范围内', bytes.readUInt32BE(16) === 1080 && bytes.readUInt32BE(20) === a.height && a.height > 1000 && a.height <= 3000);
      const before = fs.statSync(a.file).mtimeMs;
      const reused = await renderFeatureMenu(options);
      check('第二次直接使用磁盘缓存', reused.ok && reused.cached && reused.file === a.file);
      check('命中缓存不重写 PNG', fs.statSync(a.file).mtimeMs === before);
      fs.writeFileSync(a.file, 'broken-cache');
      const repaired = await renderFeatureMenu(options);
      check('损坏缓存会重新生成而非发送', repaired.ok && !repaired.cached && repaired.bytes > 1024);
    }
  } finally {
    // 仅删除此测试角色生成的单个 PNG，不触碰运行时菜单缓存。
    if (outputFile && path.dirname(path.resolve(outputFile)) === path.resolve(root, 'state/feature-menu')) {
      fs.unlinkSync(outputFile);
    }
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
