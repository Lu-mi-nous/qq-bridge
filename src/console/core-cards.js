// 控制台核心卡片注册表（C1）。
//
// 唯一来源：`/api/console/manifest` 直接返回这份元数据；前端不再从 HTML
// 里“猜”卡片编号。迁移期核心卡仍由 legacy 适配器渲染，`legacy` 字段给出
// 旧 section 选择器；试点卡（render:"declarative"）由 renderer.js 按
// data/sections/poll 渲染。
//
// 注意：这里只放**元数据**，不放业务逻辑；插件卡片由 pluginHost.list() 合并。

export const CONSOLE_CONTRACT_VERSION = 'v1';

export const CONSOLE_GROUPS = [
  { id: 'all', title: '全部功能', desc: '基础功能与插件功能的总览；点击卡片进入整页设置。' },
  { id: 'core', title: '基础功能', desc: '桥接自带功能，按编号平铺；点击卡片进入整页设置。' },
  { id: 'plugins', title: '插件功能', desc: '由插件提供的控制台卡片；未启用的插件不占位。' },
  { id: 'about', title: '关于', desc: '版本、运行环境与项目信息。' }
];

// group 字段仅用于搜索/统计，不再驱动侧栏（基础功能一律平铺）。
export const CORE_CARDS = [
  {
    id: '01',
    title: '运行模式',
    group: 'run',
    order: 10,
    cardClass: 'span-all',
    legacy: '#sec-01',
    render: 'module',
    module: '/console/cards/01-runtime.js'
  },
  {
    id: '02',
    title: '会话映射',
    group: 'run',
    order: 20,
    cardClass: 'card-h card-half',
    legacy: '#sec-02',
    render: 'module',
    module: '/console/cards/02-sessions.js'
  },
  {
    id: '03',
    title: '挂起审批 / 提问',
    group: 'run',
    order: 30,
    cardClass: 'card-h card-half',
    legacy: '#sec-03',
    render: 'module',
    module: '/console/cards/03-pending.js'
  },
  {
    id: '04',
    title: '活动日志（实时消息状态）',
    group: 'run',
    order: 40,
    cardClass: 'card-h card-log card-half',
    legacy: '#sec-04',
    render: 'module',
    module: '/console/cards/04-activity.js'
  },
  {
    id: '05',
    title: '人格（角色扮演）',
    group: 'content',
    order: 50,
    cardClass: 'span-all role-card',
    legacy: '#sec-05',
    render: 'module',
    module: '/console/cards/05-role.js'
  },
  {
    id: '06',
    title: '一代仿真模式（reserved）',
    group: 'content',
    order: 60,
    cardClass: 'span-all collapsible',
    legacy: 'section[data-sec="06"]',
    render: 'module',
    module: '/console/cards/06-reserved.js'
  },
  {
    id: '07',
    title: '二代仿真模式（reserved2）',
    group: 'content',
    order: 70,
    cardClass: 'span-all',
    legacy: '#sec-07',
    render: 'module',
    module: '/console/cards/07-v2.js'
  },
  {
    id: 'slang-settings',
    title: '群聊黑话 / 网络用语库',
    ownerPlugin: 'slang',
    group: 'content',
    order: 80,
    legacy: '#sec-slang-settings',
    render: 'module',
    module: '/console/cards/08-slang.js'
  },
  {
    id: '08',
    title: 'DSH 侧 MCP 工具',
    group: 'media',
    order: 80,
    cardClass: 'span-all',
    legacy: '#sec-08',
    render: 'module',
    module: '/console/cards/09-tools.js'
  },
  {
    id: '09',
    title: '白名单 / 管理员',
    group: 'community',
    order: 90,
    cardClass: '',
    legacy: '#sec-09',
    render: 'module',
    module: '/console/cards/10-whitelist.js'
  },
  {
    id: '10',
    title: '静默开关',
    group: 'community',
    order: 100,
    cardClass: '',
    legacy: '#sec-10',
    render: 'declarative',
    data: [{ source: '/api/status', as: 'st' }],
    sections: [
      { type: 'custom-note', text: '静默时群友消息不投递 agent，仅管理员可对话。' },
      {
        type: 'text',
        label: '当前状态',
        bind: 'st.roleMode',
        map: { silent: '静默中（只回管理员）', active: '正常回复' },
        fallback: '—'
      },
      {
        type: 'actions',
        items: [
          { label: '开启静默', method: 'POST', path: '/api/role-mode', body: { mode: 'silent' }, tone: 'danger' },
          { label: '恢复正常', method: 'POST', path: '/api/role-mode', body: { mode: 'active' } }
        ]
      }
    ],
    poll: { ms: 5000, sources: ['st'] }
  },
  {
    id: '11',
    title: '安全拦截通知',
    group: 'community',
    order: 110,
    cardClass: '',
    legacy: '#sec-11',
    render: 'declarative',
    data: [{ source: '/api/security', as: 'sec' }],
    sections: [
      { type: 'switch', label: '拦截时在群里发提示', bind: 'sec.security.interceptNotify', default: true },
      {
        type: 'actions',
        items: [{
          label: '保存安全设置',
          method: 'POST',
          path: '/api/security',
          body: { interceptNotify: '$sec.security.interceptNotify' }
        }]
      }
    ],
    poll: { ms: 15000, sources: ['sec'] }
  },
  {
    id: '12',
    title: '控制台访问令牌',
    group: 'system',
    order: 120,
    cardClass: '',
    legacy: '#sec-12',
    render: 'declarative',
    data: [{ source: '/api/console/token', as: 'ct' }],
    sections: [
      {
        type: 'text',
        label: '当前状态',
        bind: 'ct.authEnabled',
        map: {
          true: '🔒 令牌鉴权已开启（刷新页面时需要输入令牌）',
          false: '🔓 令牌鉴权已关闭（免登录；仍只监听 127.0.0.1）'
        },
        fallback: '—'
      },
      { type: 'text', bind: 'ct.hint', fallback: '' },
      { type: 'input', label: '新令牌', inputType: 'password', bind: 'ct.newToken', placeholder: '输入新令牌（至少 16 位），留空则生成随机', autocomplete: 'new-password' },
      {
        type: 'actions',
        items: [
          {
            label: '保存令牌',
            method: 'POST',
            path: '/api/console/token',
            body: { token: '${ct.newToken}' },
            success: '✅ 已保存新令牌',
            storeConsoleToken: true,
            assign: { 'ct.newToken': 'token' }
          },
          {
            label: '生成随机令牌',
            method: 'POST',
            path: '/api/console/token',
            body: { token: '' },
            successTemplate: '✅ 已生成随机令牌：${token}',
            storeConsoleToken: true,
            assign: { 'ct.newToken': 'token' }
          }
        ]
      },
      { type: 'custom-note', text: '令牌只对「浏览器直接打开控制台」有效；刷新页面时浏览器导航带不了自定义请求头，根路径仍会要求输入。想彻底免登录，把 config.json 的 consoleAuth 设为 false（控制台仍只监听 127.0.0.1，写操作仍校验同源）。' }
    ],
    poll: { ms: 30000, sources: ['ct'] }
  },
  {
    id: '13',
    title: '加好友 / 入群请求',
    group: 'community',
    order: 130,
    cardClass: '',
    legacy: 'section[data-sec="13"]',
    render: 'declarative',
    data: [{ source: '/api/socialV2/join-requests', as: 'jr' }],
    sections: [
      { type: 'text', bind: 'jr', format: 'joinStatus', fallback: '加载中…' },
      { type: 'list', bind: 'jr.pending', template: 'joinRequest' },
      {
        type: 'custom-note',
        text: '有人加好友或拉 bot 进群时，桥接会私聊管理员并等裁决：/yes 编号 同意、/no 编号 拒绝、/pending 查看。默认不自动同意，超时（默认 5 分钟）自动拒绝。'
      }
    ],
    poll: { ms: 5000, sources: ['jr'] }
  },
  {
    id: 'images-settings',
    title: '取图额度',
    ownerPlugin: 'images',
    group: 'media',
    order: 150,
    legacy: 'section[data-sec="images-settings"]',
    render: 'module',
    module: '/console/cards/15-image-quota.js'
  },
  {
    id: '14',
    title: 'Token 用量',
    group: 'system',
    order: 140,
    cardClass: 'span-all',
    legacy: 'section[data-sec="14"]',
    render: 'module',
    module: '/console/cards/16-token.js',
    panel: '/api/console/panel/token-report'
  },
  {
    id: 'bili-settings',
    title: 'B 站自己刷视频',
    ownerPlugin: 'bili',
    group: 'media',
    order: 170,
    legacy: 'section[data-sec="bili-settings"]',
    render: 'module',
    module: '/console/cards/17-bili.js'
  },
  {
    id: 'tts-settings',
    title: '语音合成（GPT-SoVITS）',
    ownerPlugin: 'tts',
    group: 'media',
    order: 180,
    cardClass: 'card-half',
    legacy: 'section[data-sec="tts-settings"]',
    render: 'module',
    module: '/console/cards/18-tts.js'
  },
  {
    id: '15',
    title: '磁盘缓存（C 盘）',
    group: 'media',
    order: 150,
    cardClass: 'card-half',
    legacy: 'section[data-sec="15"]',
    render: 'module',
    module: '/console/cards/19-cache.js'
  },
  {
    id: '16',
    title: '测试发送',
    group: 'system',
    order: 160,
    cardClass: '',
    legacy: '#sec-16',
    render: 'declarative',
    sections: [
      { type: 'select', label: '目标类型', bind: 'ts.kind', options: [{ value: 'group', label: '群' }, { value: 'private', label: '私聊' }], default: 'group' },
      { type: 'input', label: '群号 / QQ 号', bind: 'ts.id', placeholder: '群号 / QQ 号' },
      { type: 'textarea', label: '消息内容', bind: 'ts.message', rows: 3, placeholder: '这是一条测试消息' },
      {
        type: 'actions',
        items: [{
          label: '发送测试',
          method: 'POST',
          path: '/api/test-send',
          body: { kind: '${ts.kind}', id: '${ts.id}', message: '${ts.message}' },
          success: '✅ 已发送'
        }]
      },
      { type: 'custom-note', text: '目标必须在白名单内，否则拒绝。' }
    ]
  },
  {
    id: '17',
    title: '桥接控制',
    group: 'run',
    order: 170,
    cardClass: '',
    legacy: '#sec-17',
    render: 'declarative',
    sections: [
      {
        type: 'actions',
        items: [
          {
            label: '重启桥接',
            tone: 'danger',
            confirm: '确定重启桥接？（进程会自重启，约 3~10 秒恢复；进行中的对话会中断）',
            method: 'POST',
            path: '/api/restart',
            body: {},
            success: '✅ 桥接已恢复',
            waitFor: { path: '/api/socialV2/config', intervalMs: 1000, timeoutMs: 60000 },
            reloadAfter: true
          },
          {
            label: '清空 QQ 聊天工作区',
            tone: 'danger',
            confirm: '确定清空整个「QQ 聊天」工作区？\n将归档全部 QQ 会话、清除所有上下文映射、清空活动日志。\n此操作不可撤销。',
            method: 'POST',
            path: '/api/workspace/reset',
            body: {},
            successTemplate: '✅ 已归档 ${archivedCount} 个会话，工作区已清空',
            reloadAfter: true
          }
        ]
      },
      { type: 'custom-note', text: '重启由桥接自己拉起新进程，约 3~10 秒恢复（不再依赖守护窗口）；清空工作区会归档全部 QQ 会话并清空活动日志。' }
    ]
  },
  {
    id: '18',
    title: '后台控制端引导',
    group: 'system',
    order: 180,
    cardClass: 'card-2col',
    legacy: '#sec-18',
    render: 'declarative',
    sections: [
      { type: 'custom-note', text: '直接向指定 QQ 会话的 DSH agent 投递一条“后台控制端提醒”，用于给 AI 引导/提醒；该消息不是群友消息。二代模式（reserved2）下会自动附带会话令牌和二代工具协议说明，AI 的文本输出不会自动转发，发言需通过发送工具。' },
      { type: 'select', label: '目标类型', bind: 'an.kind', options: [{ value: 'group', label: '群' }, { value: 'private', label: '私聊' }], default: 'group' },
      { type: 'input', label: '群号 / QQ 号', bind: 'an.id', placeholder: '群号 / QQ 号' },
      { type: 'textarea', label: '提醒内容（发给 DSH agent 的引导/提醒）', bind: 'an.message', rows: 4, placeholder: '例如：接下来群里聊到某个话题时，你可以更主动一点；或：先潜水，等我叫你。' },
      {
        type: 'actions',
        items: [{
          label: '发送到 DSH',
          method: 'POST',
          path: '/api/console/notify-ai',
          body: { key: '${an.kind}:${an.id}', message: '${an.message}' },
          success: '✅ 已投递到 DSH'
        }]
      }
    ]
  },
  {
    id: '19',
    title: '上下文与记忆',
    group: 'content',
    order: 190,
    cardClass: 'span-all',
    legacy: '#sec-19',
    render: 'module',
    module: '/console/cards/24-context.js'
  },
];

function manifestEntry(card, owner, pluginId = null) {
  return {
    id: card.id,
    kind: owner === 'plugin' ? 'plugin' : 'core',
    owner,
    pluginId,
    title: card.title,
    group: card.group,
    order: card.order,
    legacy: card.legacy,
    cardClass: card.cardClass || '',
    render: card.render || 'legacy',
    ...(card.data ? { data: card.data } : {}),
    ...(card.sections ? { sections: card.sections } : {}),
    ...(card.poll ? { poll: card.poll } : {}),
    ...(card.module ? { module: card.module } : {}),
    ...(card.panel ? { panel: card.panel } : {})
  };
}

/** 基础功能卡：只含 owner=core 的 19 张（旧 20 凭据卡已拆到插件配置注册）。 */
export function coreManifestCards() {
  return CORE_CARDS.filter((card) => !card.ownerPlugin).map((card) => manifestEntry(card, 'core'));
}

/** 功能归属插件、但 UI 暂由核心模块提供的 4 张卡（slang/images/bili/tts）。 */
export function pluginOwnedManifestCards() {
  return CORE_CARDS.filter((card) => card.ownerPlugin).map((card) => manifestEntry(card, 'plugin', card.ownerPlugin));
}
