// 控制台公共工具（C6 runtime 拆分）。
async function api(path, method, body, _retried = 0) {
  const headers = body ? {'content-type':'application/json'} : {};
  const token = localStorage.getItem('consoleToken');
  if (token) headers['x-console-token'] = token;
  const res = await fetch(path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    if (_retried >= 2) {
      localStorage.removeItem('consoleToken');
      throw new Error('未授权');
    }
    const t = prompt('请输入控制台访问令牌：');
    if (t) {
      localStorage.setItem('consoleToken', t.trim());
      return api(path, method, body, _retried + 1);
    }
    localStorage.removeItem('consoleToken');
    throw new Error('未授权');
  }
  return res.json();
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// 行内 Markdown：只用于开发日志条目标题；正文走 renderMd() 的完整渲染。
function renderMdInline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s;
}

// ── 极简 Markdown 渲染（人格卡展示用）──────────────────────────────────────
// 为什么不引第三方库：只服务"把角色卡渲染得能读"这一个用途，需求很窄——
// 支持角色卡里**实际用到**的语法即可（已核对 roles/*.md：标题/有序无序列表/
// 粗体/行内代码/引用/代码块），引一个几十 KB 的库不划算，也不利于离线可用。
//
// 安全：**先转义再拼标签**。所有文本都过 esc()，标签只由本函数生成，
// 所以角色内容里的 <script> 之类不会被当 HTML 执行。
function renderMd(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inCode = false, codeBuf = [];
  let listType = null;   // 'ul' | 'ol' | null
  let inQuote = false;

  const closeList = () => { if (listType) { out.push('</' + listType + '>'); listType = null; } };
  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };

  // 行内：先转义，再替换 `code`、**bold**、*italic*、[文字](链接)、<自动链接>
  const inline = (t) => {
    let s = esc(t);
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    // 链接：**只允许 http/https**，其余（javascript: / data: 等）原样显示文字。
    // 文档内容来自服务端常量，但仍按不可信内容处理——将来若允许编辑文档，这条防线必须还在。
    const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : '');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
      const href = safeHref(url);
      return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    });
    s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (m, url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    return s;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    // 代码块（``` 围栏）
    if (/^\s*```/.test(line)) {
      if (inCode) { out.push('<pre class="md-code">' + esc(codeBuf.join('\n')) + '</pre>'); codeBuf = []; inCode = false; }
      else { closeList(); closeQuote(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    if (!line.trim()) { closeList(); closeQuote(); continue; }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeList(); closeQuote();
      const lvl = Math.min(h[1].length + 2, 6);   // # → h3（卡片里 h2 已被标题占用）
      out.push(`<h${lvl} class="md-h">${inline(h[2])}</h${lvl}>`);
      continue;
    }

    // 引用
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      closeList();
      if (!inQuote) { out.push('<blockquote class="md-quote">'); inQuote = true; }
      out.push('<p>' + inline(q[1]) + '</p>');
      continue;
    }
    closeQuote();

    // 无序列表
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      if (listType !== 'ul') { closeList(); out.push('<ul class="md-ul">'); listType = 'ul'; }
      out.push('<li>' + inline(ul[1]) + '</li>');
      continue;
    }
    // 有序列表
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      if (listType !== 'ol') { closeList(); out.push('<ol class="md-ol">'); listType = 'ol'; }
      out.push('<li>' + inline(ol[1]) + '</li>');
      continue;
    }
    closeList();

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr class="md-hr">'); continue; }

    // 普通段落
    out.push('<p>' + inline(line) + '</p>');
  }
  if (inCode && codeBuf.length) out.push('<pre class="md-code">' + esc(codeBuf.join('\n')) + '</pre>');
  closeList(); closeQuote();
  return out.join('\n');
}


function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

