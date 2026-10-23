// 回归测试：删除收藏表情脚本的安全约束。
//
// 背景（2026-10-15 用户要求「加上删除表情包这个功能」）：
// 实测 `delete_custom_face` **不校验 emoji_id** —— 我传假值 "0"，
// 它返回 status=ok 并**真删掉了一个收藏表情**（「戴眼镜的女孩抱着戴眼镜的兔玩偶」）。
// 那次误删已用本地库留存的 URL 重新 add_custom_face 恢复（md5 一致）。
//
// 正因为"参数无效也能触发删除"，这个能力**不能交给模型自由调用**：
// 模型传错 ID 时会静默删掉别的表情，而它以为删的是目标那个。
// 所以做成需手动执行的脚本（与群文件归档同一立场），并强制：
//   ① 默认 dry-run，必须 --apply
//   ② 删前强制备份（含 url/md5，可 --restore 恢复）
//   ③ 必须精确指定（--md5 / --emoji-id / --match），并列出命中让你确认
//   ④ 删后回读校验（接口不校验，只能自己验）
//
// 本测试断言这些约束**存在于代码里**（纯静态检查，不做真实删除）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const src = fs.readFileSync(path.join(root, 'scripts/delete-sticker.mjs'), 'utf8');
const mcpSrc = fs.readFileSync(path.join(root, 'src/mcp-snowluma-safe.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
const roleSrc = fs.existsSync(path.join(root, 'roles/大肥鱼.md')) ? fs.readFileSync(path.join(root, 'roles/大肥鱼.md'), 'utf8') : '';

console.log('── 1. 默认安全：dry-run + 显式 --apply ──');
{
  check('默认 dryRun=true', /apply: false/.test(src));
  check('--apply 才置为真', /a === '--apply'\) out\.apply = true/.test(src));
  check('预演模式不打删除调用', /if \(!args\.apply\)[\s\S]{0,200}return;/.test(src));
  check('预演文案说明未删除', /预演模式，未删除/.test(src));
}

console.log('\n── 2. 删前强制备份（可恢复是底线）──');
{
  check('备份文件写在删除之前', (() => {
    const iBackup = src.indexOf('stickers-deleted-');
    const iDel = src.indexOf("call('delete_custom_face'");
    return iBackup > 0 && iDel > 0 && iBackup < iDel;
  })());
  check('备份含完整条目（url/md5 都在）', /JSON\.stringify\(\{ deletedAt[\s\S]{0,60}entries: targets \}/.test(src));
  check('提示如何恢复', /--restore/.test(src));
  check('恢复用 add_custom_face', /add_custom_face/.test(src));
  check('恢复会校验 md5 一致', /sameMd5/.test(src));
}

console.log('\n── 3. 精确指定 + 命中确认 ──');
{
  check('支持按 md5 精确指定', /--md5/.test(src));
  check('支持按完整 emoji_id 指定', /--emoji-id/.test(src));
  check('列出全部命中再执行', /匹配 \$\{targets\.length\} 个/.test(src));
  check('无匹配时不误删', /没有匹配的表情/.test(src));
}

console.log('\n── 4. 删后回读校验（接口不校验参数，必须自己验）──');
{
  check('删除后重新拉取列表', /const after = await fetchQqFaces\(\)/.test(src));
  check('比对确认真的消失', /gone\.length/.test(src));
  check('未全删成功时给出告警', /有目标仍在 QQ 侧/.test(src));
}

// 模型现在**有**删除工具（2026-10-15 用户明确要求「加上删除表情包这个功能」，
// 机器人此前只能回"我只有收藏和发送两个动作"）。但因为它调的 delete_custom_face
// 不校验参数，安全性必须由桥接自己保证 —— 下面的断言就是那几道防线。
console.log('\n── 5. 模型可用，但桥接侧有硬校验 ──');
{
  check('MCP 已注册删除工具', /'qq_delete_sticker'/.test(mcpSrc));
  // 关键：上游那个不校验参数的接口**只能由桥接**调用，MCP 层不许直接碰
  check('MCP 层不直接调 delete_custom_face（只经桥接端点）', !/delete_custom_face/.test(mcpSrc));
  check('桥接暴露删除端点', /api\/socialV2\/sticker-delete/.test(bridgeSrc));
  check('桥接调用上游接口', /delete_custom_face/.test(bridgeSrc));
  // 三道防线：① 默认关闭 ② 本地库校验 ③ 删前备份 + 删后回读
  check('工具默认关闭（写操作，需显式开启）', (bridgeSrc.match(/deleteSticker: false/g) || []).length === 2);
  check('删除前用 findSticker 校验存在性', /async function deleteStickerV2[\s\S]{0,400}findSticker\(/.test(bridgeSrc));
  check('校验失败即拒绝（不让未校验值进上游）', /找不到表情 \$\{stickerId\}，请先用 qq_list_stickers/.test(bridgeSrc));
  check('删前写备份文件', /stickers-deleted-\$\{stamp\}\.json/.test(bridgeSrc));
  check('备份在调用上游之前', (() => {
    const i = bridgeSrc.indexOf('async function deleteStickerV2');
    const seg = bridgeSrc.slice(i, i + 3000);
    return seg.indexOf('stickers-deleted-') < seg.indexOf("request('delete_custom_face'");
  })());
  check('删后回读校验', /verifiedGone/.test(bridgeSrc));
  check('端点受静默开关约束', /sticker-delete[\s\S]{0,900}socialV2\.paused/.test(bridgeSrc));
}

console.log('\n── 6. 参数校验（避免重演误删）──');
{
  // 关键：请求必须带完整 emoji_id，不能是空/占位
  check('删除前校验 emojiId 非空', /if \(!emojiId\)/.test(src));
  check('缺失时跳过而不是硬删', /缺少 emoji_id，跳过/.test(src));
}

console.log('\n── 7. 用法可发现 ──');
{
  check('无参数时打印用法', /用法：/.test(src));
  check('--list 可查看清单', /--list/.test(src));
  check('清单显示 md5 前缀便于指定', /md5\(前8位\)/.test(src));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
