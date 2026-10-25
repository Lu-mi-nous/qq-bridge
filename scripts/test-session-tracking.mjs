import { clearSessionTracking } from '../src/pipeline/session-tracking.js';
import { checks } from './helpers/pipeline-harness.mjs';
const { check, finish } = checks();
let resolved = 0;
// bridge 实际使用 Map<turnId, timestamp>；夹具必须保持同样的容器形态。
const deps = { autoAtTurnDone: new Map([['s', 10], ['s#1', 20], ['s#2', 30], ['sibling#1', 40]]),
  biliJudgeWaiters: new Map([['s', { resolve: value => { if(value === '') resolved++; } }]]),
  social: { silentTurns: new Map([['s', 1]]), exitingSessions: new Set(['s']), conversations: new Map([['group:1', { memory: true }]]) } };
for(const name of ['collectors','v2TurnStartAt','currentTurnBySession','sendToolSucceededSessions','pendingSendToolCalls','toolCallNames','biliJudgeCollectors']) deps[name] = new Map([['s', 1], ['other', 2]]);
clearSessionTracking(deps, 's');
for(const name of ['collectors','v2TurnStartAt','currentTurnBySession','sendToolSucceededSessions','pendingSendToolCalls','toolCallNames','biliJudgeCollectors']) check(`${name}只清目标会话`, !deps[name].has('s') && deps[name].has('other'));
check('按 turnId 清除自动@标记且不误删前缀相似会话', [...deps.autoAtTurnDone.keys()].join() === 'sibling#1');
check('初判 waiter 立即结束', resolved === 1 && deps.biliJudgeWaiters.size === 0);
check('社交记忆保留', deps.social.conversations.get('group:1').memory);
clearSessionTracking(deps, 's');
check('重复清理安全且不重复回填', resolved === 1);
finish();
