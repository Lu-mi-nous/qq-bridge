// x-monitor/translate.mjs — 调本地模型网关把帖子正文译成中文
//
// 设计：
//   - 复用机器人自己的模型网关（config.json 的 dsh.baseUrl 指向 DSH，但翻译直连 7863 更快、
//     不占用 QQ 会话额度；地址取自 socialV2 或默认 7863）。
//   - 内存 + 磁盘缓存（state/x-monitor-translations.json），同一帖子只译一次。
//   - 失败返回空串（调用方渲染时跳过译文段），绝不因为翻译失败而漏推帖子。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_GATEWAY = 'http://127.0.0.1:7863/v1';
const CACHE_MAX = 500;

export function createTranslator({ statePath, gatewayUrl, model = 'cn:deepseek-v4.1-flash', log = () => {} }) {
  const cacheFile = statePath;
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {};
  } catch {
    cache = {};
  }

  const save = () => {
    try {
      const keys = Object.keys(cache);
      if (keys.length > CACHE_MAX) {
        // 只留最近写入的一部分（按插入顺序裁剪）
        const keep = {};
        for (const k of keys.slice(-CACHE_MAX)) keep[k] = cache[k];
        cache = keep;
      }
      fs.writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    } catch {}
  };

  /**
   * 翻译一段文本为中文。命中缓存直接返回。
   * @returns {Promise<string>} 译文；失败或无需翻译返回 ''
   */
  /**
   * 判断文本是否**已经基本是中文**（无需翻译）。
   *
   * 不能用「有没有拉丁字母」来判断 —— 那会把日文/韩文/俄文等**非拉丁文字**的外语
   * 全当成"已经是中文"跳过（实测：日文推文 `しろたん可愛い` 被跳过，用户反馈"外文帖子没翻译"）。
   * 正确判据：统计"中文字符"占"所有字母类字符"的比例，占比高才视为中文。
   * 这样日文（含汉字但混大量假名）、韩文、俄文都会被正确识别为需要翻译。
   */
  function looksChinese(text) {
    const s = String(text ?? '');
    // 汉字（CJK 统一表意文字，不含扩展较偏区域）
    const han = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    // 日文假名（平假名/片假名）—— 出现较多即判为日文
    const kana = (s.match(/[\u3040-\u30ff]/g) || []).length;
    // 拉丁字母、西里尔字母、谚文（韩文）等其它文字系统
    const other = (s.match(/[A-Za-z\u0400-\u04ff\uac00-\ud7af]/g) || []).length;
    const letters = han + kana + other;
    if (letters < 4) return true;              // 几乎没有文字（纯emoji/符号）→ 不必翻译
    if (kana >= 4 && kana > han) return false; // 假名占多 → 日文，需要翻译
    return han / letters >= 0.6;               // 汉字占六成以上才算"已经是中文"
  }

  async function translate(text, { id = '' } = {}) {
    const src = String(text ?? '').trim();
    if (!src) return '';
    if (looksChinese(src)) return '';

    const key = id ? `id:${id}` : `t:${src.slice(0, 120)}`;
    if (cache[key]) return cache[key];
    const url = String(gatewayUrl || DEFAULT_GATEWAY);
    try {
      const r = await fetch(`${url.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                '你是翻译引擎。把用户给的推文翻译成简体中文，要求：保留原意与语气，术语/产品名保留英文原文（如 Codex、ChatGPT、GPT-5），不要添加解释、不要加引号、不要复述原文，只输出译文本身。'
            },
            { role: 'user', content: src }
          ],
          // 关键：这个模型默认是**推理模型**，会先在 reasoning_content 里长篇思考，
          // token 预算被思考耗尽后 content 会是空串、finish_reason=length。
          // 实测日文长句：max_tokens=1200 时 reasoning 吃掉 3304 字符、译文 0 字符
          //（英文短句能成，所以问题只在长外文）。关闭思考后 2.7s 出结果，
          // 比放开到 4000 tokens（12s）快 4 倍，译文质量一致。
          enable_thinking: false,
          max_tokens: 2000,
          stream: false
        }),
        signal: AbortSignal.timeout(90000)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const msg = j.choices?.[0]?.message ?? {};
      const out = String(msg.content ?? '').trim();
      // 注意：**不要**在 content 为空时从 reasoning_content 里抠中文当译文。
      // 试过这种兜底，但推理内容里散落着思考片段（"这句更自然""Good."），
      // 抠出来的往往是最后半句、丢了大半段（实测译文只剩「如果大家能开心地看今天的动画，我会很高兴的！」
      // 还被写进缓存，之后一直返回残缺译文）。宁可返回空（渲染时跳过译文段）也不要给残缺译文。
      // 真正可靠的做法是关闭思考（enable_thinking: false）+ 足够 token，已在上方生效。
      // 去掉模型可能加上的包裹引号
      const clean = out.replace(/^["'“”]+|["'“”]+$/g, '').trim();
      if (clean) {
        cache[key] = clean;
        save();
      }
      return clean;
    } catch (e) {
      log(`[x-monitor] 翻译失败: ${e?.message ?? e}`);
      return '';
    }
  }

  return { translate };
}
