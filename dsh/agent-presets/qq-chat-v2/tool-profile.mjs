// T2/T3：工具面 profile（preset 级、agent 作用域）。
//
// 背景：DSH 0.1.1-rc.2 里 MCP client 是**宿主级单进程**，工具列表不能按会话/回合
// 动态加载；per-session 动态工具面没有可靠落点。这里实现「profile 级工具集」：
// 在 agent 创建时用 ctx.tools.restrict({ allow }) 把工具面收窄到某一档，
// 由 preset 目录里的 tool-profile.json 选择（改完需要新会话/重启 DSH 生效）。
//
//   full（默认）/ admin：不限制（保持全部工具，行为与引入本机制前一致）
//   core：12 个高频收发/调度/记忆工具（约 8–12 目标档）
//   media：core + 看图/图库/表情/媒体工具/语音/超分/抓取
//   bili：core + B 站搜索/观看/记忆/记录
//
// 档位成员表在 tool-profiles.json（与桥接共用同一份，桥接用它决定唤醒提示里
// 是否注入某能力的提示片段）。
//
// 注意：restrict 只是**实时可见性组合，不是权限边界**；执行期白名单仍由
// qq-tool-restrict 的 guard 兜底。切到 core/media 等档位会让未列出的能力对模型
// 不可见，属预期取舍；默认 full 不改变现有行为。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'qq-tool-profile'
export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PROFILE_FILE = path.join(HERE, 'tool-profile.json')
export const PROFILES_FILE = path.join(HERE, 'tool-profiles.json')

export function readProfiles(file = PROFILES_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const out = {}
    for (const [id, list] of Object.entries(parsed || {})) {
      if (Array.isArray(list)) out[id] = Object.freeze({ allow: Object.freeze(list.map(String)) })
    }
    return out
  } catch {
    return {}
  }
}

const DEFINITIONS = readProfiles()

export const TOOL_PROFILES = Object.freeze({
  full: null,
  admin: null,
  core: DEFINITIONS.core ?? null,
  media: DEFINITIONS.media ?? null,
  bili: DEFINITIONS.bili ?? null
})

export function resolveProfile(profileId, profiles = TOOL_PROFILES) {
  const raw = String(profileId ?? '').trim()
  const id = raw || 'full'
  if (!Object.hasOwn(profiles, id)) return { id: 'full', filter: null, unknown: id }
  return { id, filter: profiles[id], unknown: '' }
}

export function readProfile(file = PROFILE_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return String(parsed?.profile || 'full')
  } catch {
    return 'full'
  }
}

export function apply(ctx) {
  const requested = readProfile()
  const { id, filter, unknown } = resolveProfile(requested)
  if (unknown) console.error(`[qq-tool-profile] 未知 profile "${unknown}"，回退 full（不限制）`)
  if (!filter) {
    console.error(`[qq-tool-profile] profile=${id}（不限制工具可见性）`)
    return
  }
  ctx.tools.restrict({ allow: filter.allow })
  console.error(`[qq-tool-profile] profile=${id}：仅 ${filter.allow.length} 个工具对模型可见（新会话生效；restrict 不是权限边界）`)
}
