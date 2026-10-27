// tune-waits.mjs — 缩短等待窗口：沉睡前观察 5min→1min，单次等待上限 10min→2min
import fs from 'node:fs';

const p = 'C:/qq-bridge/config.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));

const before = {
  preSleepWaitMs: c.socialV2.wake.preSleepWaitMs,
  maxMs: c.socialV2.wait.maxMs,
  defaultMs: c.socialV2.wait.defaultMs,
};

// 沉睡前观察：5 分钟 -> 1 分钟（桥接会用这个值生成给 AI 的提示词）
c.socialV2.wake.preSleepWaitMs = 60000;

// 单次等待上限：10 分钟 -> 2 分钟（防止模型用长等待把会话占住）
c.socialV2.wait.maxMs = 120000;
c.socialV2.wait.defaultMs = 30000;   // 普通等待默认 30s
c.socialV2.wait.minMs = 5000;

// 推荐提示词里同步改成 1 分钟，避免还告诉模型"等 5 分钟"
c.socialV2.wake.recommendedHint =
  '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=60000) 完成一次沉睡前观察：1 分钟内没人说话就可以设置下一次唤醒并沉睡；' +
  '若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。' +
  '潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。' +
  '需要等特定某人/某几人时，可额外设置 triggers.speakerIds。' +
  '注意：单次等待不要超过 120000ms（桥接会强制截断），也不要设置 minNewMessages——那个参数会让你白等好几分钟，别人叫你你都听不见。';

fs.writeFileSync(p, `${JSON.stringify(c, null, 2)}\n`, 'utf8');

console.log('等待参数（改前 -> 改后）:');
console.log(`  沉睡前观察: ${before.preSleepWaitMs}ms -> ${c.socialV2.wake.preSleepWaitMs}ms`);
console.log(`  单次等待上限: ${before.maxMs}ms -> ${c.socialV2.wait.maxMs}ms`);
console.log(`  普通等待默认: ${before.defaultMs}ms -> ${c.socialV2.wait.defaultMs}ms`);
