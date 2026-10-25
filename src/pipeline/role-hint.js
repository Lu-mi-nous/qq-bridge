// 人格卡读取与 mtime 缓存；日志/会话角色归属显式注入。
import fs from 'node:fs';
import path from 'node:path';
export const ROLE_HINT_MAX = 12000;
export function createRoleHintReader({ ROOT, roleFor, roleHintCache, log }) {
  function currentRoleHint(key) {
    try {
      const role = roleFor(key);
      if (!role) return '';
      const roleFile = path.join(ROOT, 'roles', role + '.md');
      if (!fs.existsSync(roleFile)) return '';
      const roleStat = fs.statSync(roleFile);
      const cacheKey = String(roleStat.mtimeMs);
      const cached = roleHintCache.get(role);
      if (cached && cached.key === cacheKey) return cached.hint;
      let hint = fs.readFileSync(roleFile, 'utf8');
      // 角色卡整份注入：上限设得足够宽，**超限要留痕**。
      // 原来硬切 6000 字：实测「大肥鱼」6283、「大肥鱼（傲娇版）」6946、「小鲸鱼」7388 都被切尾，
      // 于是末尾整节（表情包体系 / 轻量记忆 / 被问长相时）静默丢失——「禁写外貌」这类约束
      // 恰恰在最后一节，丢了不报错，只在群聊里表现为"模型忽然开始瞎编长相"。
      if (hint.length > ROLE_HINT_MAX) {
        log(`⚠️ 角色卡 ${role}.md 超长（${hint.length} 字），已截断到 ${ROLE_HINT_MAX} 字；末尾内容不会进入提示词`);
        hint = hint.slice(0, ROLE_HINT_MAX);
      }
      roleHintCache.set(role, { key: cacheKey, hint });
      return hint;
    } catch {
      return '';
    }
  }


  return currentRoleHint;
}
