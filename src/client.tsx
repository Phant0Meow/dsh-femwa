/**
 * dsh-femwa client half (browser) — 浏览器端总装车间。
 *
 * 本文件是插件 web 侧的入口与总装：把 client-ui/ 子目录的各职责模块注册进
 * dsh web 的 slots/conversationEvents。全部 UI 组件、store、样式都在子模块：
 *
 *   client-ui/stream-store.ts   fem_stream 直播缓冲 + SSE 单例 + useFemStream
 *   client-ui/view-state.ts     视角状态 store + useView/getView/setView
 *   client-ui/styles.ts         fem-stream 样式表一次性注入
 *   client-ui/fem-stream-live.tsx  直播块渲染件（speaker/导演锚点共用）
 *   client-ui/chat-node.tsx     dsh-femwa/chat 节点定义 + 行渲染视图
 *   client-ui/director-node.tsx 导演直播锚点节点定义 + 视图
 *   client-ui/editor-view.tsx   「Fem 编辑器」标签页（画布宿主壳+冲突弹窗）
 *   client-ui/fem-button.tsx    侧边栏「🎭 Fem 剧本」按钮
 *   client-ui/view-button.tsx   视角菜单按钮 + CSS 过滤 + 计数座位
 *   client-ui/composer.tsx      投影窗可输入 composer
 *
 * All @deepseek-ai imports are type-only or shell singletons (external in the
 * bundle); the only other runtime dependency is react (shell singleton).
 * （2026-08-26 结构整理：原 2070 行单文件按职责拆分为上述模块，本文件只剩
 * 总装，行为零变化。）
 */

import { SubagentHeaderLineage as FemLineage } from './lineage-fork.jsx'
// client-ui 拆出件。
import { ensureFemStreamStyles } from './client-ui/styles'
import { femStreamAcquire } from './client-ui/stream-store'
import { FemwaChatNodeView, femwaChatDefinition } from './client-ui/chat-node'
import { FemDirectorNodeView, femDirectorDefinition } from './client-ui/director-node'
import { FemEditorView, type ScriptViewInjected } from './client-ui/editor-view'
import { FemButton, type FemButtonInjected } from './client-ui/fem-button'
import { FemSubagentCount, FemViewButton, type FemViewInjected } from './client-ui/view-button'
import { ProjectionComposer } from './client-ui/composer'

/** Peer packages this plugin needs injected. */
export const inject: string[] = ['slots', 'conversationEvents', 'sessions', 'workspaces']

// ── plugin body ───────────────────────────────────────────────────────────

/**
 * Browser plugin body: register the chat nodes and all slots.
 * @param ctx - client root context.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  ensureFemStreamStyles()
  // 页面级预开 SSE（引用计数 +1 常驻）：store 不依赖锚点挂载才喂帧，
  // 锚点晚挂载 read() 也能拿到全量缓冲。
  femStreamAcquire()
  const slots = ctx?.get?.('slots') ?? ctx?.slots
  if (slots === undefined || typeof slots.inject !== 'function') {
    console.warn('[dsh-femwa] slots service unavailable; UI not registered')
    return
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conversationEvents = ctx?.get?.('conversationEvents') as { register(def: unknown): void } | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessions = ctx?.get?.('sessions') as {
    open?(id: string): void
    openSubagent?(address: { parentSessionId: string; childSessionId: string; mode: string }): void
    refreshSubagents?(parentSessionId: string): void
    setSubagentCatalogOpen?(parentSessionId: string, open: boolean): void
  } | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workspaces = ctx?.get?.('workspaces') as {
    list?: { getSnapshot?(): { items?: Array<{ workspaceId: string; path: string }>; recentWorkspaceId?: string } }
  } | undefined

  if (conversationEvents !== undefined && typeof conversationEvents.register === 'function') {
    conversationEvents.register(femwaChatDefinition)
    // 导演直播锚点（Step2）：user/message → 上帝窗主模型打字机落位锚。
    conversationEvents.register(femDirectorDefinition)
  } else {
    console.warn('[dsh-femwa] conversationEvents unavailable; femwa-role node not registered')
  }

  const currentCwd = (): string | undefined => {
    try {
      const state = workspaces?.list?.getSnapshot?.()
      const recent = state?.items?.find(item => item.workspaceId === state.recentWorkspaceId)
      return (recent ?? state?.items?.[0])?.path
    } catch {
      return undefined
    }
  }

  const injected = (): FemButtonInjected => ({
    listScripts: async (): Promise<string[]> => {
      const response = await fetch('/dsh-femwa/scripts')
      if (!response.ok) throw new Error(`scripts HTTP ${response.status}`)
      const data = await response.json() as { ok?: boolean; scripts?: string[]; error?: string }
      if (data.ok !== true || data.scripts === undefined) {
        throw new Error(data.error ?? 'list scripts failed')
      }
      return data.scripts
    },
    createFemSession: async (scriptPath?: string): Promise<void> => {
      const cwd = currentCwd()
      const body: { cwd?: string; scriptPath?: string } = {}
      if (cwd !== undefined) body.cwd = cwd
      if (scriptPath !== undefined) body.scriptPath = scriptPath
      const response = await fetch('/dsh-femwa/create-session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        throw new Error(`create-session HTTP ${response.status}`)
      }
      const data = await response.json() as { ok?: boolean; sessionId?: string; error?: string }
      if (data.ok !== true || data.sessionId === undefined) {
        throw new Error(data.error ?? 'create-session failed')
      }
      sessions?.open?.(data.sessionId)
    },
    saveScript: async (name: string, content: string): Promise<string> => {
      // 绝对路径（导出流程选目录拼出的完整路径）→ path 直写；
      // 否则按 name 存 user_data/projects/（导入/侧边栏保存）。
      const isPath = /^[a-zA-Z]:[\\/]/.test(name) || name.startsWith('/') || name.startsWith('\\\\')
      const response = await fetch('/dsh-femwa/save-script', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isPath ? { path: name, content } : { name, content }),
      })
      if (!response.ok) {
        throw new Error(`save-script HTTP ${response.status}`)
      }
      const data = await response.json() as { ok?: boolean; path?: string; error?: string }
      if (data.ok !== true || data.path === undefined) {
        throw new Error(data.error ?? 'save-script failed')
      }
      return data.path
    },
  })

  // FemViewButton 注入：打开任意会话（视角菜单跳转投影窗用）+ 投影窗 id 查询。
  const viewInjected = (): FemViewInjected => ({
    openSession: (id: string): void => { sessions?.open?.(id) },
    listProjectionWindows: async (sid: string): Promise<{ god?: string; actors: Record<string, string> }> => {
      const response = await fetch(`/dsh-femwa/projection-windows?sessionId=${encodeURIComponent(sid)}`)
      if (!response.ok) throw new Error(`projection-windows HTTP ${response.status}`)
      const data = await response.json() as { ok?: boolean; god?: string; actors?: Record<string, string> }
      if (data.ok !== true) throw new Error(data.error ?? 'projection-windows failed')
      return { god: data.god, actors: data.actors ?? {} }
    },
  })

  slots.inject('sidebar.footer.action', () => slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'dsh-femwa',
      order: 100,
      inject: injected,
    },
    FemButton,
  ))
  slots.inject('conversation.chat.node', () => slots.register(
    {
      name: 'conversation.chat.node',
      key: 'femwa-role',
      // locale 席位（2026-08-25 崩溃修复）：不声明则 t 不注入，组件内
      // t('copy') 直接 TypeError → SlotErrorBoundary 吞掉全部 femwa 节点
      // （流式锚点也随之消失=「说完才上屏」的真凶）。
      locale: 'conversation',
    },
    FemwaChatNodeView,
  ))
  slots.inject('conversation.chat.node', () => slots.register(
    {
      name: 'conversation.chat.node',
      key: 'femwa-director',
      locale: 'conversation',
    },
    FemDirectorNodeView,
  ))
  // FemViewButton：order -20 = preset 徽章(-10)之前、紧贴面包屑区——主窗口
  // 「name / 👁视角  Fem剧本模式 …」；投影窗「母名 / 👁@演员」（fork 让位后
  // 面包屑只剩斜杠，见 lineage-fork.jsx SubagentHeaderLineage）。
  slots.inject('conversation.session.header.actions', () => slots.register(
    {
      name: 'conversation.session.header.actions',
      id: 'dsh-femwa-view',
      order: -20,
      inject: viewInjected,
    },
    FemViewButton,
  ))

  // ── 子代理计数座位（actions 尾部）─────────────────────────────────────────
  // Fem 主会话的官方"N 个子代理"计数菜单：原在面包屑区（lineage 槽），fork
  // 让位后移到这里。order 10 = preset(-10) 之后、job-list(20) 之前，即用户要的
  // 「Fem剧本模式 → 几个子代理 → 几个在跑」。locale 复用官方 'subagent'
  // 命名空间拿文案；仅 Fem 主会话本体渲染，投影窗/普通会话返回 null。
  slots.inject('conversation.session.header.actions', () => slots.register(
    {
      name: 'conversation.session.header.actions',
      id: 'dsh-femwa-count',
      order: 10,
      locale: 'subagent',
      inject: () => ({
        openChild: (address: { parentSessionId: string; childSessionId: string; mode: string }): void => {
          sessions?.openSubagent?.(address)
        },
        refresh: (parentSessionId: string): void => {
          sessions?.refreshSubagents?.(parentSessionId)
        },
        setCatalogOpen: (parentSessionId: string, open: boolean): void => {
          sessions?.setSubagentCatalogOpen?.(parentSessionId, open)
        },
      }),
    },
    FemSubagentCount,
  ))

  // ── 子代理下拉过滤（shadow 官方 lineage 槽位）─────────────────────────────
  // Fem 剧本机制产生的会话——投影窗（id 前缀 fem-proj-）与节点子代理（label
  // 前缀 fem-node-）——不出现在子代理目录里；主模型主动拉起的子代理不受影响
  // （label 无此前缀）。fork 版组件见 lineage-fork.jsx（过滤逻辑全在那里），
  // 非 Fem 会话上行为与官方组件一致（无 fem 条目可滤）。priority -10 shadow
  // 官方默认 0（single 槽 lowest renders，见 ui-slots shadowing 语义）。
  // （2026-08-23 历史注记：布局重排第一版曾整体回退（当时疑似其引入视角切
  // 换卡死），后确认卡死根因在 god 窗 chunk 重放数据层、与本文件无关；布局
  // 重排 v2 已重新落地——视角按钮 order -20 / count 座位 order 10 / 母名
  // 黑化走自有 style 元素（MutationObserver 路线永久弃用）。）
  slots.inject('conversation.session.header.lineage', () => slots.register(
    {
      name: 'conversation.session.header.lineage',
      priority: -10,
      locale: 'subagent',
      inject: () => ({
        openChild: (address: { parentSessionId: string; childSessionId: string; mode: string }): void => {
          sessions?.openSubagent?.(address)
        },
        refresh: (parentSessionId: string): void => {
          sessions?.refreshSubagents?.(parentSessionId)
        },
        setCatalogOpen: (parentSessionId: string, open: boolean): void => {
          sessions?.setSubagentCatalogOpen?.(parentSessionId, open)
        },
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    FemLineage as any,
  ))

  const scriptViewInjected = (): ScriptViewInjected => ({
    listScripts: injected().listScripts,
    readScript: async (path: string): Promise<string> => {
      const response = await fetch(`/dsh-femwa/script?path=${encodeURIComponent(path)}`)
      if (!response.ok) throw new Error(`script HTTP ${response.status}`)
      const data = await response.json() as { ok?: boolean; content?: string; error?: string }
      if (data.ok !== true || data.content === undefined) {
        throw new Error(data.error ?? 'read script failed')
      }
      return data.content
    },
    saveScript: injected().saveScript,
    // The script panel plays on the CURRENT session (it is a per-session
    // view); the sidebar button keeps create-session for new Fem sessions.
    runScript: async (sid: string, scriptPath?: string): Promise<void> => {
      const body: { sessionId: string; scriptPath?: string } = { sessionId: sid }
      if (scriptPath !== undefined) body.scriptPath = scriptPath
      const response = await fetch('/dsh-femwa/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      let message = `run HTTP ${response.status}`
      try {
        const data = await response.json() as { ok?: boolean; error?: string }
        if (data.ok === true) return
        message = data.error ?? message
      } catch {
        // non-JSON body: keep the status message
      }
      throw new Error(message)
    },
    stopScript: async (): Promise<void> => {
      const response = await fetch('/dsh-femwa/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      let message = `stop HTTP ${response.status}`
      try {
        const data = await response.json() as { ok?: boolean; error?: string }
        if (data.ok === true) return
        message = data.error ?? message
      } catch {
        // non-JSON body: keep the status message
      }
      throw new Error(message)
    },
    fetchErrors: async (sid: string): Promise<Array<{ ts: number; text: string }>> => {
      const response = await fetch(`/dsh-femwa/errors?sessionId=${encodeURIComponent(sid)}`)
      if (!response.ok) throw new Error(`errors HTTP ${response.status}`)
      const data = await response.json() as { ok?: boolean; errors?: Array<{ ts: number; text: string }>; error?: string }
      if (data.ok !== true || data.errors === undefined) {
        throw new Error(data.error ?? 'fetch errors failed')
      }
      return data.errors
    },
    toggleSidebar: () => ctx.layout.toggleSidebar(),
  })

  slots.inject('conversation.view', () => slots.register(
    {
      name: 'conversation.view',
      id: 'femwa',
      order: 20,
      label: () => 'Fem 编辑器',
      inject: scriptViewInjected,
    },
    FemEditorView,
  ))

  // 投影窗 composer：selector 匹配 fem-proj-* 会话 → 可输入 composer
  // （替代 dsh 默认的 SubagentReadOnlyComposer 只读链）。priority -20
  // < subagent 的 -10：先匹配我们，未命中才落到只读链。
  slots.inject('conversation.composer', () => slots.register(
    {
      name: 'conversation.composer',
      priority: -20,
      select: (owner: { session?: { sessionId?: string } }): { isProjection: boolean } | null => {
        const sid = owner.session?.sessionId
        if (typeof sid === 'string' && sid.startsWith('fem-proj-')) return { isProjection: true }
        return null
      },
    },
    ProjectionComposer,
  ))
}
