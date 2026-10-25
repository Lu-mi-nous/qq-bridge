// 使用真实选群实现；固定时间/随机样本，避免依赖用户当天群聊活跃度。
import { sharingHarness } from './helpers/bili-sharing-harness.mjs';
import { checks } from './helpers/pipeline-harness.mjs';
const { check, finish } = checks();
let random = 0;
const h = sharingHarness({ random: () => random, isSessionAllowedInCurrentMode: k => k !== 'group:denied', isConversationBusyV2: k => k === 'group:busy' });
const now = Date.now();
const messages = n => Array.from({ length: n }, () => ({ time: now - 1000, isSelf: false }));
const st = (n, extra = {}) => ({ recentMessages: messages(n), unread: [], lastActionAt: n, ...extra });
const { groupActivityScore: score, pickBiliSessionKey: pick } = h.sharing;
check('活跃度只计窗口内群友', score({ recentMessages: [{ time: now }, { time: now, isSelf: true }, { time: now - 25 * 3600000 }] }, { now, hours: 24 }) === 1);
check('空状态活跃度为零', score({}) === 0);
h.deps.socialV2.conversations = new Map([['group:1', st(0)], ['group:2', st(2)], ['group:3', st(8)], ['private:1', st(99)], ['group:denied', st(99)], ['group:busy', st(99)], ['group:unread', st(99, { unread: [{}] })]]);
check('推荐排除冷群/私聊/忙碌/未读/未准入', pick({ requireActive: true }) === 'group:2');
random = 0.999;
check('权重尾部能选择活跃群', pick({ requireActive: true }) === 'group:3');
check('关闭活跃优先回到最闲群', pick({ preferActive: false }) === 'group:1');
let lower = 0, higher = 0;
for(let i = 0; i < 1000; i++) { random = (i + 0.5) / 1000; pick({ requireActive: true }) === 'group:2' ? lower++ : higher++; }
check('按 2:8 权重分配且不垄断', lower === 200 && higher === 800);
h.deps.cfg.socialV2.bili.share.activityWeightCap = 2;
lower = 0;
for(let i=0;i<100;i++) { random=(i+0.5)/100; if(pick({ requireActive:true })==='group:2') lower++; }
check('权重上限限制大群优势', lower === 50);
h.deps.socialV2.conversations = new Map([['group:1', st(0)]]);
check('无活跃群不推荐', pick({ requireActive: true }) === null);
check('冷群仍可供浏览落脚', pick() === 'group:1');
finish();
