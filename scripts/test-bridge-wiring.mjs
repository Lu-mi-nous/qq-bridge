// 跨模块接线护栏。业务语义由各模块 import 行为测试覆盖。
// 集中结构检查是为了让模块搬迁只修改一处；不要在这里截函数执行或复制算法。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ROOT=root;
const incoming=fs.readFileSync(path.join(root,'src/pipeline/incoming.js'),'utf8');
const bridge=fs.readFileSync(path.join(root,'src/bridge.js'),'utf8');
const ttsPlugin=fs.readFileSync(path.join(root,'plugins/tts/index.js'),'utf8');
const sessionService=fs.readFileSync(path.join(root,'src/session-service.js'),'utf8');
const imageFacade=fs.readFileSync(path.join(root,'src/image-facade.js'),'utf8');
const stickerService=fs.readFileSync(path.join(root,'src/sticker-service.js'),'utf8');
const joinRequestService=fs.readFileSync(path.join(root,'src/join-request-service.js'),'utf8');
const tokenService=fs.readFileSync(path.join(root,'src/token-service.js'),'utf8');
const mediaService=fs.readFileSync(path.join(root,'src/media-service.js'),'utf8');
const socialEngine=fs.readFileSync(path.join(root,'src/social-engine.js'),'utf8');
const dispatchIncoming=fs.readFileSync(path.join(root,'src/pipeline/dispatch-incoming.js'),'utf8');
const biliBootstrap=fs.readFileSync(path.join(root,'src/bili-bootstrap.js'),'utf8');
let pass=0,fail=0;
const check=(name,ok,detail='')=>{ok?pass++:fail++;console.log((ok?'PASS':'FAIL')+' '+name+(detail?' '+detail:''));};

// 来自 test-context-recovery：只保留跨模块接线约束。
{


check('bridge 引入 context-recovery', /from '\.\/context-recovery\.js'/.test(bridge));
check('bridge 创建恢复器', /createContextRecovery\(\{/.test(bridge));
check('bridge 有会话轮换函数', /function rotateSessionForContextOverflow\(/.test(bridge));
check('投递异常/被拒也识别上下文超限', (bridge.match(/isContextOverflowError\(errText\)/g) || []).length === 2);
}


// 来自 test-credentials-panel：只保留跨模块接线约束。
{


check('引用 maskValue', /maskValue/.test(bridge) && /from '\.\/credentials-doc\.js'/.test(bridge));
check('日志里没有 console.log(value)', !/log\([^)]*\bvalue\b[^)]*\)/.test(bridge.match(/已更新[^\n]*/)?.[0] || ''));
}


// 来自 test-delete-sticker：只保留跨模块接线约束。
{
  const bridgeSrc = bridge;

check('桥接调用上游接口', /delete_custom_face/.test(stickerService));
check('工具默认关闭（写操作，需显式开启）', (bridgeSrc.match(/deleteSticker: false/g) || []).length >= 1);
check('删除前用 findSticker 校验存在性', /async function remove\(stickerId\)[\s\S]{0,500}findSticker\(/.test(stickerService));
check('校验失败即拒绝（不让未校验值进上游）', /找不到表情 \$\{stickerId\}，请先用 qq_list_stickers/.test(stickerService));
check('删前写备份文件', /stickers-deleted-\$\{stamp\}\.json/.test(stickerService));
// 2026-10-27 事故：qq-send 调 findSticker(entries, ref)，bridge 曾只接受 (ref)，
// 数组被当成 ref → 所有表情发送都报“找不到”。签名必须透传两个参数。
check('表情发送 findSticker 透传 entries + ref（防参数被吞）',
  /findSticker:\s*\(entries,\s*ref\)\s*=>\s*findSticker\(entries,\s*ref\)/.test(bridge));
check('备份在调用上游之前', (() => {
    const i = stickerService.indexOf('async function remove(stickerId)');
    const seg = stickerService.slice(i, i + 3000);
    return seg.indexOf('stickers-deleted-') < seg.indexOf("request('delete_custom_face'");
  })());
check('删后回读校验', /verifiedGone/.test(stickerService));
}


// 来自 test-image-downscale：只保留跨模块接线约束。
{
  const bridgeSrc = bridge;

check('媒体服务导入了 prepareImageForModel', /import \{[^}]*prepareImageForModel[^}]*\} from '\.\/image-downscale\.js'/.test(mediaService));
check('resolveMediaList 路径接入预处理', /const scaled = await prepareImageForModel/.test(mediaService));
check('fetchMediaData 路径接入预处理', /const scaled2 = await prepareImageForModel/.test(mediaService));
const prepCount = (mediaService.match(/prepareImageForModel\(/g) || []).length;
check('至少 2 处接入预处理（路径只增不减）', prepCount >= 2, `实际 ${prepCount} 处`);
check('预处理函数唯一（同一模块导入）',
    /import \{[^}]*prepareImageForModel[^}]*\} from '\.\/image-downscale\.js'/.test(mediaService));
check('缩图在大小检查之前（先缩再看大小）', (() => {
    const i = mediaService.indexOf('const scaled = await prepareImageForModel');
    const j = mediaService.indexOf('totalBytes + useBuf.length > MAX_MEDIA_BYTES', i);
    return i > 0 && j > i;
  })());
check('bridge 收藏表情接入压缩', /shrinkStickerForUpload\(buffer/.test(stickerService));
check('压缩发生在 add_custom_face 之前', (() => {
    const i = stickerService.indexOf('shrinkStickerForUpload(buffer');
    const j = stickerService.indexOf("request('add_custom_face'", i);
    return i > 0 && j > i;
  })());
check('超限错误说明是 4MB 上限（不再只说 fetch failed）', /超过 QQ 收藏表情[\s\S]{0,80}MB 上限/.test(stickerService));
}


// 来自 test-image-oversize：只保留跨模块接线约束。
{


check('启用 partialOnOversize', /safeFetchBuffer\(String\(media\.url\), HARD_CAP, \{ partialOnOversize: true \}\)/.test(mediaService));
check('宽松上限是原上限的倍数（不是无上限）', /const HARD_CAP = Math\.max\(MAX_MEDIA_BYTES \* 4, MAX_MEDIA_BYTES \+ 1024 \* 1024\)/.test(mediaService));
check('拿到后走 prepareImageForModel 压缩',
    /const prepared = await prepareImageForModel\(fetched\.buffer, \{[\s\S]{0,220}\}/.test(mediaService));
check('返回压缩后的 buffer/mimeType', /return \{ buffer: prepared\.buffer, mimeType: prepared\.mimeType \}/.test(mediaService));
check('超限压缩后记日志（可排查）', /画面可能不完整/.test(mediaService));
check('日志区分"未取全"与完整', /未取全/.test(mediaService));
check('像素上限检查仍在前（防图片炸弹）', /dims\.width \* dims\.height > MAX_MEDIA_PIXELS[\s\S]{0,200}prepareImageForModel/.test(mediaService));
}


// 来自 test-image-upscale：只保留跨模块接线约束。
{
  const bridgeSrc = bridge;

const prepCount = (mediaService.match(/prepareImageForModel\(/g) || []).length;
check('桥接接入统一预处理（路径只增不减）', prepCount >= 2, `实际 ${prepCount} 处`);
check('不再直接调 downscaleIfLarge（避免两处各写一遍）',
    !/await downscaleIfLarge\(img\.buffer/.test(bridgeSrc));
}


// 来自 test-join-request：只保留跨模块接线约束。
{

  const adminCommands = fs.readFileSync(path.join(root, 'src', 'admin-commands.js'), 'utf8');
check('监听 request 事件', /bot\.onRequest\(/.test(bridge));
check('处理加好友请求', /setFriendAddRequest/.test(bridge));
check('处理入群邀请', /setGroupAddRequest/.test(bridge));
check('通知管理员私聊', /notifyJoinRequest/.test(bridge) && /private:\$\{owner\}/.test(bridge));
check('超时会自动拒绝', /pruneExpired\(\)[\s\S]{0,400}submitJoinDecision\(it, false, '超时未处理'\)/.test(bridge));
check('启动时补拒绝旧请求（否则静默消失、QQ 侧一直挂着）',
    /takeExpiredAtStartup\(\)[\s\S]{0,400}submitJoinDecision\(it, false, '超时未处理'\)/.test(bridge));
check('定时清理（不是被动等下一个请求）', /taskService\.define\('joinRequestSweep'[\s\S]{0,500}pruneExpired/.test(bridge));
check('通知失败时自动拒绝（不留悬挂）', /无法通知管理员/.test(joinRequestService));
check('裁决指令在一切之前处理', /adminCommands\.handleJoinDecisionCommand\(key, plainContent\)/.test(incoming));
check('入队前检查机器人是否已在群', /isBotInGroup\(item\.groupId\)/.test(joinRequestService));
check('入群通知按群作废待决邀请', /onNotice\('group_increase'/.test(bridge) && /takeWhere\(/.test(bridge));
check('同意邀请前也检查是否已在群', /isInvite && approve === true && await isBotInGroup/.test(joinRequestService));
check('提交失败时返回结构化结果', /return \{ ok: false, error: msg, expired \}/.test(joinRequestService));
check('已在群时不报失败', /alreadyJoined: true/.test(joinRequestService) && /已经处理过了：机器人已在群里/.test(adminCommands));
check('代码默认 autoApprove: false', /autoApprove: false/.test(bridge));
}


// 来自 test-pixiv-auth：只保留跨模块接线约束。
{


check('桥接导入凭据模块（经 images-api 网关）', /from '\.\/images-api\.js'/.test(bridge) && /loadPixivAuth/.test(bridge));
check('启动时注入', /applyPixivAuth\(\)/.test(bridge) && /setPixivCookie\(pa\.loaded \? pa\.cookie : ''\)/.test(bridge));
check('日志只报状态不打印内容',
    /pixiv 登录态已加载/.test(bridge) && !/log\([^)]*pixivAuth\.cookie/.test(bridge) && !/log\([^)]*pa\.cookie/.test(bridge));
check('未配置时明确写"匿名访问"', /pixiv 匿名访问/.test(bridge));
check('默认配置指向 state/pixiv-auth.json',
    /authFile: 'state\/pixiv-auth\.json'/.test(bridge));
}


// 来自 test-poke-target：只保留跨模块接线约束。
{
  const bridgeSrc = bridge;

check('不再写「我拍了拍 <数字>」', !/\[拍一拍\] 我拍了拍 \$\{targetUserId\}/.test(bridgeSrc));
check('引入 resolvePokeTarget', /from '\.\/poke-target\.js'/.test(bridgeSrc));
}


// 来自 test-role-injected-in-wake：只保留跨模块接线约束。
{
  const bridgeSrc = bridge;

check('bridge 引入 pipeline/wake', /from '\.\/pipeline\/wake\.js'/.test(bridgeSrc));
check('bridge 保留 buildWakePromptV2 薄包装',
    /function buildWakePromptV2\(key, reason\) \{[\s\S]{0,120}wakePrompts\.buildWakePrompt/.test(bridgeSrc));
}


// 来自 test-session-generation：只保留跨模块接线约束。
{


check('bridge 引入 session-generation', /from '\.\/pipeline\/session-generation\.js'/.test(bridge));
check('bridge 使用 session-service', /from '\.\/session-service\.js'/.test(bridge)
  && /sessionService\.ensureSession\(key\)/.test(bridge));
check('ensureSession 比较代际', /needsNewSession\(meta, \{ mode: desiredMode, preset: desiredPreset \}\)/.test(sessionService));
check('创建会话写入 sessionMeta', /state\.sessionMeta\[key\] = \{[\s\S]{0,120}?mode: getMode\(\)/.test(sessionService));
check('模式变化停用旧会话', /retireForModeChange\(key, existing, meta/.test(sessionService));
}


// 来自 test-sticker-nudge：只保留跨模块接线约束。
{
  const bridgeSrc = bridge;

check('有 planStickerV2', /function planStickerV2\(key, st\)/.test(bridgeSrc));
check('桥接掷骰（不是模型自觉）', /Math\.random\(\) >= prob/.test(bridgeSrc));
check('有最小间隔限制', /autoNudgeMinGapMs/.test(bridgeSrc));
check('有每小时上限', /autoNudgeMaxPerHour/.test(bridgeSrc));
check('语气取自对方最后说的话', /const lastOther = \[/.test(bridgeSrc));
check('刚发过的表情进 recentIds', /const recentIds = \(Array\.isArray\(st\.recentStickers\)/.test(bridgeSrc));
check('有 autoNudge 默认开关', /autoNudge: true/.test(bridgeSrc));
check('默认概率 0.33', /autoNudgeProbability: 0\.33/.test(bridgeSrc));
}


// 来自 test-token-day-review：只保留跨模块接线约束。
{
  const bridgeSrc = bridge;

check('落盘包含 dayModels', /dayModels: agg\.dayModels \|\| \{\}/.test(tokenService));
}


// 来自 test-token-report：只保留跨模块接线约束。
{
  const mainBridge = bridge;

check('默认配置开启了 tokenReport', /tokenReport: true/.test(mainBridge));
}


// 来自 test-token-usage：只保留跨模块接线约束。
{


check('结果落盘', /TOKEN_USAGE_FILE/.test(bridge) && /atomicWriteJson\(file/.test(tokenService));
check('写日志（用户要求"做成日志"）', /\[Token\] 今日/.test(tokenService) && /\[Token\] 累计/.test(tokenService));
check('定时调度（跨天或超 6 小时才重算）',
    /startTokenUsageScheduler/.test(bridge) && /ageMs > 6 \* 3600 \* 1000/.test(tokenService));
check('只扫本项目会话，不扫别的项目/测试工作区',
    /-state-agents--\$/i.test(tokenService) && /includes\('qq-bridge'\)/.test(tokenService));
check('启动失败不影响桥接', /\[Token\] 统计失败（不影响桥接）/.test(tokenService));
}


// 来自 test-tts-voices：只保留跨模块接线约束。
{

  const qqSend = fs.readFileSync(new URL('../src/pipeline/qq-send.js', import.meta.url), 'utf8');
check('TTS 插件传回复语气', /mood: moodOfText\(msg\)/.test(ttsPlugin) && /mood: planData\?\.mood/.test(ttsPlugin));
check('TTS 插件传音色预设给 probe', /voiceId: t\.voiceId/.test(ttsPlugin) && /weightsId: t\.weightsId/.test(ttsPlugin));
}


// 来自 test-web-crawler：只保留跨模块接线约束。
{


check('取图拉取时间持久化（重启后控制台不归零）',
    /IMAGE_FETCH_STATE_FILE/.test(bridge) && /lastFetchedAt/.test(imageFacade));
check('分享卡片提取', /extractShareCards\(event\.message/.test(incoming));
check('卡片消息放宽到 1200 字', /textLimit = shareUrl \? 1200 : 200/.test(bridge));
check('shareUrl 单独存字段', /shareUrl,/.test(bridge) && /shareTitle:/.test(bridge));
}


// 来自 test-msg-normalize：只保留跨模块接线约束。
{
  const bridgeSrc = bridge;

check('bridge 引入 text-normalize',
    /from '\.\/pipeline\/text-normalize\.js'/.test(bridgeSrc), true);
}


// 入站身份必须传递到三种模式；权限判定始终以后台管理员为准。
check('三条派发路径取群身份', (dispatchIncoming.match(/groupRoleOf\(event, kind\)/g)||[]).length>=3);
check('时间线接收群角色', /function appendSocialV2Message\([^)]*groupRole = ''/.test(socialEngine));
check('发起人角色与群身份同源', /st\.lastRequesterRole = groupRole/.test(socialEngine));
check('owner 时间窗只记录后台管理员', /if \(ownerQq && String\(userId\)\.trim\(\) === ownerQq\)/.test(socialEngine) && /st\.ownerSpokeAt = Date\.now\(\)/.test(socialEngine));
check('管理员权限使用唯一纯函数', /isOwnerTurnPure\(\{/.test(bridge) && /cfg\.socialV2\?\.adminCommandWindowMs/.test(bridge));
check('B 站凭据只报状态不打印内容', /账号凭据已加载/.test(biliBootstrap) && !/log\(.*auth\.cookie/.test(biliBootstrap));
// T3：唤醒构建器接入分层依赖（角色摘要 / profile 能力可见性）。
check('唤醒构建器注入 roleTextFor 与 capabilityVisible', /roleTextFor,/.test(bridge)
  && /capabilityVisible: capabilityVisibleForPrompt/.test(bridge));
check('完整角色卡由 shouldInjectFullRole 判定', /shouldInjectFullRole\(/.test(bridge));
check('角色列表排除 .digest.md', /!f\.endsWith\('\.digest\.md'\)/.test(bridge));

// R4.7-5：DshEventPump 注入契约（8 个领域对象，不再平铺 70 项）。
{
  const pumpStart = bridge.indexOf('createDshEventPump({');
  const pumpEnd = bridge.indexOf('});', pumpStart);
  const pumpCall = pumpStart >= 0 && pumpEnd > pumpStart ? bridge.slice(pumpStart, pumpEnd) : '';
  const domains = ['runtime', 'social', 'context', 'metrics', 'tools', 'access', 'config', 'lifecycle'];
  check('DshEventPump 使用 8 个领域对象', domains.every((d) => pumpCall.includes(`\n    ${d}: {`)));
  check('DshEventPump 不再平铺 api/social 等键', !/\n    api,/.test(pumpCall)
    && !/\n    social,/.test(pumpCall) && !/\n    KNOWN_AGENT_TOKENS,/.test(pumpCall));
}

// T5 按日审阅：控制台传入的 day 必须透传到 turnMetrics.stats。
check('Token 回合指标按日透传 day', /turnMetrics: \(opts\) => turnMetrics\.stats\(opts\)/.test(bridge));

console.log(`✅ ${pass} 通过 / ${fail} 失败`);
process.exitCode=fail?1:0;
