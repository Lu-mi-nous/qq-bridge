import { createBiliSharing } from '../../src/pipeline/bili-sharing.js';
export function sharingHarness(overrides = {}) {
  const sent = [];
  const deps = {
    cfg: { socialV2: { enabled: true, bili: { share: { enabled: true, probability: 1, askModel: false, minInterest: 65, activeWindowHours: 24 } } } },
    socialV2: { paused: false, conversations: new Map() }, live: { currentMode: 'reserved2', lastBiliShareAt: 0 },
    isSessionAllowedInCurrentMode: () => true, isConversationBusyV2: () => false,
    shouldBlockSilentReply: () => false, sendToQQ: async (...args) => sent.push(args),
    askModelOnce: async () => '', log: () => {}, random: () => 0.5, ...overrides
  };
  return { sharing: createBiliSharing(deps), deps, sent };
}
