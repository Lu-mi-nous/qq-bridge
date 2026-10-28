// T3：读取当前 preset 的工具档位（profile）。
//
// 数据源与 DSH preset 插件是同一份文件（`<dshHome>/.agent-presets/<preset>/`）：
//   tool-profile.json  → { "profile": "full" }
//   tool-profiles.json → { core: [...], media: [...], bili: [...] }
// 桥接只读它来决定唤醒提示里注不注入某个能力的提示片段（sticker/语音/菜单/Token 报表）；
// 真正的工具可见性由 preset 插件的 ctx.tools.restrict 执行，两边读同一份数据避免漂移。
// 读不到/损坏/未知档位一律 fail-open 到 full（宁可多注入提示，也不要漏能力说明）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createActiveToolProfile({ getPreset, dshHome = path.join(os.homedir(), '.dsh') } = {}) {
  let cache = { key: '', profile: 'full', lists: null };

  function read() {
    const preset = String(getPreset() || '').trim();
    if (!preset) return cache;
    const dir = path.join(dshHome, '.agent-presets', preset);
    try {
      const profileFile = path.join(dir, 'tool-profile.json');
      const listsFile = path.join(dir, 'tool-profiles.json');
      const pStat = fs.statSync(profileFile);
      const lStat = fs.statSync(listsFile);
      const key = `${preset}:${pStat.mtimeMs}:${lStat.mtimeMs}`;
      if (cache.key !== key) {
        const profile = String(JSON.parse(fs.readFileSync(profileFile, 'utf8'))?.profile || 'full');
        const lists = JSON.parse(fs.readFileSync(listsFile, 'utf8'));
        cache = { key, profile, lists };
      }
      return cache;
    } catch {
      return cache;
    }
  }

  function profile() {
    return read().profile;
  }

  /** 该工具在当前档位下是否对模型可见（决定是否注入对应提示片段）。 */
  function allows(toolName) {
    const { profile, lists } = read();
    if (profile === 'full' || profile === 'admin') return true;
    const list = Array.isArray(lists?.[profile]) ? lists[profile] : null;
    if (!list) return true; // 未知档位 fail-open
    return list.includes(String(toolName));
  }

  return { profile, allows };
}
