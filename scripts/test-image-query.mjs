// 回归测试：按需查询与日榜语义（image-sources 的 order/标签校验/兜底）。
// 依赖真实网络（图站 API）；无网络时相关用例会失败并在输出中说明。
// 注意：本机对 safebooru.donmai.us 直连会 ETIMEDOUT（2026-09-24 起），
// 生产靠 images.proxy 兜底，所以测试也带上代理，否则测的是「直连不可用」而非查询逻辑。
import { fetchFromSources, safebooru } from '../src/image-sources.js';

const PROXY = process.env.QQB_PROXY || 'http://127.0.0.1:7897';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const SRC = { safebooru: { enabled: true, proxy: PROXY } };
// 精确匹配：booru 标签是下划线词表，用 includes 会误判（"cat" 命中 "cat_ears"）。
// 查询词与标签都归一化后比较，两者可能有下划线/空格两种写法。
const hasTag = (e, tag) => (e.tags ?? []).some((t) => {
  const a = String(t).toLowerCase().replace(/\s+/g, '_');
  const b = String(tag).toLowerCase().replace(/\s+/g, '_');
  return a === b;
});

try {
  // ── 按需查询：标签必须精确命中 ──
  for (const tag of ['cat', 'scenery', 'landscape']) {
    const r = await fetchFromSources(SRC, { proxy: PROXY, tags: [tag], limit: 6, order: 'score' });
    const all = r.entries.length > 0 && r.entries.every((e) => hasTag(e, tag));
    check(`查询「${tag}」结果全部含该标签`, all, `条数=${r.entries.length}`);
  }

  // ── 日榜语义：近两天 + 按热度 ──
  {
    const r = await fetchFromSources(SRC, { proxy: PROXY, limit: 6, order: 'score', maxAgeDays: 2 });
    check('日榜（近2天热门）有结果', r.entries.length > 0, `条数=${r.entries.length}`);
    check('日榜结果带分数', r.entries.every((e) => typeof e.score === 'number'));
    // 分数应递减（按热度排序）
    const scores = r.entries.map((e) => e.score);
    const desc = scores.every((s, i) => i === 0 || scores[i - 1] >= s);
    check('日榜按热度降序', desc, `scores=${scores.slice(0, 5).join(',')}`);
    // 时间窗生效：创建时间应在近期
    const newest = r.entries[0]?.createdAt ?? '';
    const days = newest ? (Date.now() - Date.parse(newest)) / 86400000 : 999;
    check('日榜结果在时间窗内', days <= 3, `最新一条 ${String(newest).slice(0, 10)}`);
  }

  // ── 热门 vs 最新：排序确实不同 ──
  {
    const hot = await fetchFromSources(SRC, { proxy: PROXY, tags: ['cat'], limit: 8, order: 'score' });
    const fresh = await fetchFromSources(SRC, { proxy: PROXY, tags: ['cat'], limit: 8, order: 'new' });
    check('热门与最新返回不同结果', hot.entries[0]?.id !== fresh.entries[0]?.id,
      `hot=${hot.entries[0]?.id} new=${fresh.entries[0]?.id}`);
  }

  // ── 无标签兜底：不该死于 500 ──
  {
    const r = await fetchFromSources(SRC, { proxy: PROXY, limit: 6, order: 'score' });
    check('无标签时自动兜底有结果', r.entries.length > 0, `条数=${r.entries.length} 错误=${r.errors.join(';') || '无'}`);
  }

  // ── 冷门标签：优雅返回空 + 可读错误 ──
  {
    const r = await fetchFromSources(SRC, { proxy: PROXY, tags: ['zzz_definitely_not_a_tag_xyz'], limit: 5 });
    check('冷门标签返回空而非崩溃', r.entries.length === 0);
    check('冷门标签给出可读提示', r.errors.some((e) => e.includes('没有')), r.errors[0] ?? '(无错误)');
  }

  // ── 超高频标签：上游会拒（500/422），应优雅降级而非崩溃 ──
  // 注：加入 422 降级（丢掉排序标签重试）后，1girl 这类从「直接失败」变成
  // 「能拿到图、只是没按热度排」——这是有意的改善，故断言放宽为二选一。
  {
    const r = await fetchFromSources(SRC, { proxy: PROXY, tags: ['1girl'], limit: 5, order: 'score' });
    check('超高频标签（上游会拒）不崩溃', Array.isArray(r.entries));
    const degradedOk = r.entries.length > 0;
    const failedClean = r.entries.length === 0 && r.errors.length > 0;
    check('超高频标签：降级拿到图 或 明确报错', degradedOk || failedClean,
      degradedOk ? `降级成功 ${r.entries.length} 张` : (r.errors[0] ?? ''));
  }

  // ── 元数据完整性（发图标注依赖）──
  {
    const r = await fetchFromSources(SRC, { proxy: PROXY, tags: ['cat'], limit: 4, order: 'score' });
    const e = r.entries[0];
    check('结果含 id/url/rating', !!e?.id && !!e?.url && !!e?.rating);
    check('结果含出处 page', !!e?.page, e?.page?.slice(0, 50));
    check('分级为全年龄', ['g', 's'].includes(e?.rating), `rating=${e?.rating}`);
    check('标签数量足够本地检索', (e?.tags?.length ?? 0) >= 5, `${e?.tags?.length} 个`);
  }

  // ── 禁用源不发起请求 ──
  {
    const r = await fetchFromSources({ safebooru: { enabled: false } }, { tags: ['cat'] });
    check('源禁用时不拉取', r.entries.length === 0 && r.errors.length === 0);
  }

  // ── 适配器直接调用：order 参数被接受（不抛异常）──
  {
    const list = await safebooru.fetchList({ tags: ['cat'], limit: 5, order: 'score' });
    check('适配器 fetchList 支持 order', Array.isArray(list) && list.length > 0);
  }
} catch (error) {
  console.log(`\n!! 测试中断（可能是网络问题）：${error?.message ?? error}`);
  fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
// ── 标签名纠错（booru 精确全名常带括号限定）──
{
  const { resolveTagName } = await import('../src/image-sources.js');
  // 精确存在的词不应被改动
  const exact = await resolveTagName('cat');
  check('已存在的标签保持精确', exact?.exact === true && exact.name === 'cat');
  // 前缀限定名应被纠错（aemeath → aemeath_(...)）
  const fixed = await resolveTagName('aemeath');
  check('限定名被纠错', fixed && fixed.exact === false && fixed.name.startsWith('aemeath'), `→ ${fixed?.name}(${fixed?.postCount})`);
  // 无关子串不应被纠错（emis 会命中 fullmetal_alchemist，必须拒绝）
  const noFix1 = await resolveTagName('emis');
  check('无关子串拒绝纠错（emis）', noFix1 === null || noFix1.name !== 'fullmetal_alchemist', `→ ${noFix1?.name ?? 'null'}`);
  // 冷门同名不应被纠错（hutao 在本站无对应角色标签）
  const noFix2 = await resolveTagName('hutao');
  check('冷门同名拒绝纠错（hutao）', noFix2 === null, `→ ${noFix2?.name ?? 'null'}`);
  // 乱码不纠错
  const noFix3 = await resolveTagName('zzz_nonexistent_xyz');
  check('无匹配返回 null', noFix3 === null);

  // 端到端：纠错后真的能查到图
  const r = await fetchFromSources(SRC, { proxy: PROXY, tags: ['aemeath'], limit: 4, order: 'score' });
  check('纠错后台能查到 aemeath 的图', r.entries.length > 0, `条数=${r.entries.length}`);
  // 查不到时给出可读提示（含正确标签线索或干净报错）
  const r2 = await fetchFromSources(SRC, { proxy: PROXY, tags: ['zzz_nonexistent_xyz'], limit: 4 });
  check('查不到时错误可读', r2.entries.length === 0 && r2.errors.length > 0, r2.errors[0]?.slice(0, 60));
}

// ── 中文角色名的典型链条（实测事故复现）──
// 群友要「原神的沃雅妮莎」，机器人把中文译成英文时猜错（vanessa 而非 varesa）。
// 系统应做到：① 猜偏时能纠正到真实标签；② 纠正后能查到该角色；③ 把纠正事实告诉调用方。
{
  const norm = (t) => String(t).toLowerCase().replace(/\s+/g, '_');

  // ① 正确拼写 + 作品标签 → 查到该角色
  const ok = await fetchFromSources(SRC, { proxy: PROXY, tags: ['varesa', 'genshin_impact'], limit: 4, order: 'score' });
  check('角色名+作品名 能查到', ok.entries.length > 0, `条数=${ok.entries.length}`);
  check('结果确实是该角色', ok.entries.every((e) => (e.tags ?? []).some((t) => t.includes('varesa'))));
  check('纠正被记录（varesa→全名）', ok.corrections.some((c) => c.from === 'varesa' && c.to.includes('varesa')),
    JSON.stringify(ok.corrections.map((c) => `${c.from}→${c.to}`)));

  // ② 译错的名字（机器人实际犯的错）：能查到东西，但必须带纠正记录，
  //    好让调用方/模型察觉「这跟你说的可能不是一个角色」
  const wrong = await fetchFromSources(SRC, { proxy: PROXY, tags: ['vanessa'], limit: 2 });
  check('译错的名字也能查到（靠纠错）', wrong.entries.length > 0, `条数=${wrong.entries.length}`);
  check('译错时必须回报纠正事实', wrong.corrections.some((c) => c.from === 'vanessa'),
    JSON.stringify(wrong.corrections.map((c) => `${c.from}→${c.to}`)));

  // ③ 作品标签 + 已有正确全名 不应被去冗逻辑误伤
  const combo = await fetchFromSources(SRC, { proxy: PROXY, tags: ['cat', 'genshin_impact'], limit: 2, order: 'score' });
  check('两个通用标签组合仍可用', combo.entries.length > 0, `条数=${combo.entries.length}`);
}

// ── 作品内角色校正（真实事故：异环的薄荷）──
// 群友要「异环的薄荷」，机器人用 mint 查 → mint 本身是有效标签（821 张，别的角色），
// 常规纠错见它精确命中就放行 → 但 mint + 异环 = 0 张，发出去的是别的异环角色。
// 正确标签是 mint_(nte)（nte 是异环缩写），463 张。必须靠作品约束才能校正。
// 判据：@mentions 提到「作品 x 的 y 角色」时，模型必须同时传两个标签。
{
  const r = await fetchFromSources(SRC, { proxy: PROXY, tags: ['mint', 'neverness_to_everness'], limit: 3 });
  check('薄荷+异环 能查到图', r.entries.length > 0, `条数=${r.entries.length}`);
  check('校正到了 mint_(nte)', r.corrections.some((c) => c.from === 'mint' && /mint_\(nte\)/.test(c.to)),
    JSON.stringify(r.corrections.map((c) => `${c.from}→${c.to}`)));
  // 返回的图确实含该角色（不是随便一张异环图）
  const hasMint = r.entries.some((e) => (e.tags ?? []).some((t) => t.includes('mint_(nte)')));
  check('结果确实含该角色', hasMint);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
