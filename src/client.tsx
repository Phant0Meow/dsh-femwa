/**
 * dsh-femwa client half (browser).
 *
 * 1. Sidebar footer action "🎭 Fem 剧本": opens a small script menu
 *    (GET /dsh-femwa/scripts), creates a Fem session for the chosen script
 *    (POST /dsh-femwa/create-session with scriptPath + workspace cwd) and
 *    opens it. Fem sessions have no main model: pre-step is rejected
 *    host-side, so the chat window only shows the script's role dialogs.
 * 2. 'femwa-role' conversation node: renders dsh-femwa/chat session events
 *    as role bubbles (actor name + stable color), notices (centered small
 *    text), and human-wait prompts.
 *
 * All @deepseek-ai imports are type-only (erased at build); the only runtime
 * dependency is react (shell singleton, external in the bundle).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
// Font Awesome Free solid 图标内联组件（currentColor 随文字色）：视角按钮与菜单用。
import { FaEye, FaPodcast, FaRobot, FaUserSecret } from './fa-icons'
// 官方下箭头（dsh 子代理计数下拉同款）：视角按钮右侧的展开指示。
// MarkdownText：官方正文渲染器（基线件，shell 同一实例）——投影窗流式方案B
// 的打字机正文与原生消息像素同款的关键。
import { IconChevronDownOutline14, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import FEMEditor from '../femGen/src/FemWorAuto'
import { SubagentHeaderLineage as FemLineage, CatalogDropdown } from './lineage-fork.jsx'
import { FemReasoningRow } from './fem-reasoning-row'

/** 本页面实例 id：快照写带上它，host 广播时原样带回；前端跳过自己的
 * script_changed 广播（否则自己写完→自己重拉→白转一圈还压住后续输入）。 */
const PAGE_ID = `p${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`

/** 冲突弹窗按钮统一样式（跟随 dsh 主题 token，暗色自适应）。 */
const conflictBtnStyle: CSSProperties = {
  padding: '6px 14px',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 13,
  background: 'var(--dsw-surface-3, #fff)',
  border: '1px solid var(--dsw-border, #ddd)',
}

/** Peer packages this plugin needs injected. */
export const inject: string[] = ['slots', 'conversationEvents', 'sessions', 'workspaces']

// ── 视角跳转的标签页跟手（2026-08-24）─────────────────────────────────────
// 需求：切视角后落在哪个标签页（对话/Fem 编辑器）跟随「切换前」所在的标签
// 页，而不是恢复目标窗口自己上次停留的位置。实现：跳转前读当前激活 tab，
// 记入下面的一次性内存标记；目标窗口的 FemViewButton 挂载后消费标记，把激
// 活 tab 对齐过去（走官方 tab 点击链路 actions.setView，持久化行为与手点一
// 致）。不新增任何持久化存储。

/** 「Fem 编辑器」标签页固定文案（本插件 conversation.view 注册的 label）。 */
const FEM_EDITOR_TAB_LABEL = 'Fem 编辑器'
/** 对话标签页文案（ui-conversation locales view.chat：中文产品文案为主，英文兜底）。 */
const CHAT_TAB_LABELS = ['对话', 'Chat']

/** 一次性转移标记：kind=切换前所在的一侧；expiresAt 防 openSession 失败后
 *  残留污染下一次任意会话切换。 */
let pendingTabTransfer: { kind: 'editor' | 'chat'; expiresAt: number } | null = null

/** 读当前激活标签页属于哪一侧：编辑器 tab 文本唯一，其余（对话）一律归 chat。 */
function readActiveTabKind(): 'editor' | 'chat' {
  const selected = document.querySelector('[role="tab"][aria-selected="true"]')
  return selected !== null && selected.textContent === FEM_EDITOR_TAB_LABEL ? 'editor' : 'chat'
}

// ── Fem script view (conversation.view tab: "Fem 剧本") ───────────────────

interface ScriptViewInjected {
  listScripts(): Promise<string[]>
  readScript(path: string): Promise<string>
  saveScript(name: string, content: string): Promise<string>
  /** Play a script on the CURRENT session (must be Fem mode). */
  runScript(sessionId: string, scriptPath?: string): Promise<void>
  /** Hard-stop the running workflow; the checkpoint stays for resume. */
  stopScript(): Promise<void>
  fetchErrors(sessionId: string): Promise<Array<{ ts: number; text: string }>>
  /** 打开 dsh 侧边栏（手机版 femGen 返回键回调）。 */
  toggleSidebar(): void
}

type FemScriptViewProps = { sessionId: string } & ScriptViewInjected

/** 画布可视化编辑器（femGen 插件模式）：取代文本编辑标签页。
 *  onRun 把画布生成的 .fems 直接交给插件 run 路由（不落盘），
 *  与聊天窗角色气泡是同一次引擎运行；SSE 事件流由 femGen 内部连接。
 *  挂载时读取会话状态（剧本记录 + 断点）用于恢复画布与「继续」按钮。
 *  savedPath=剧本文件地址（导出/导入产生）：非空 → 会话已保存（提示消失、
 *  支持相对寻址）；空 → 未保存（显示小字提示、依赖只支持绝对地址）。 */
export function FemEditorView(props: FemScriptViewProps & {
  /** 会话槽标准 share（运行时对 session-scoped 槽位必传）：proj 窗解析母会话用。 */
  useSessions?: (sel: (s: { byId: Record<string, { parentId?: string } | undefined> }) => string | undefined) => string | undefined
}) {
  const { saveScript, stopScript, toggleSidebar } = props
  // proj 窗入口（2026-08-23）：编辑器数据全部挂主会话——剧本记录/断点/运行态
  // 都在主 sid 名下。母 id 从会话表 parentId 取（proj id 的角色键可含 - ，字符串
  // 反解不可逆）；在主会话本体打开时原样使用自身 id。以下整个组件体继续用
  // 变量名 sessionId，零内文改动。
  const rawSessionId = props.sessionId
  const motherId = props.useSessions?.((s) => {
    const summary = s.byId[rawSessionId]
    return typeof summary?.parentId === 'string' ? summary.parentId : undefined
  })
  const sessionId = typeof rawSessionId === 'string'
    && rawSessionId.startsWith('fem-proj-')
    && typeof motherId === 'string'
    ? motherId
    : rawSessionId
  const [state, setState] = useState<{
    hasScript: boolean
    script?: string
    scriptPath?: string
    rev?: number
    checkpoint: Record<string, string>
    running?: boolean
  } | null>(null)
  /** 409 冲突弹窗：localFems=被拒的本地文本；remoteRev=裁决用的服务端当前 rev。 */
  const [conflict, setConflict] = useState<{ localFems: string; remoteRev: number } | null>(null)
  /** 编辑器恢复/解析失败横幅：用户可见 + 上报 host 并入 errors（主模型经 femwa-mount/run 工具结果可见）。 */
  const [editorNotice, setEditorNotice] = useState<string | null>(null)
  const onRestoreError = useCallback((message: string): void => {
    setEditorNotice(message)
    void fetch('/dsh-femwa/editor-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, message, source: 'restore' }),
    }).catch((error: unknown) => { console.warn('[dsh-femwa] editor-error 上报失败:', error) })
  }, [sessionId])

  // 「Fem 编辑器」标签页激活时隐藏底部 composer，切走时恢复。
  // conversation.view 只渲染激活的视图（only: active.id），所以本组件挂载
  // ⇔ 该标签页激活。不做 composer 链 takeover：其 select 只在渲染时调用，
  // 无法感知 tab 切换，而改 dsh 本体（ComposerChainProps 加字段）会破坏
  // 插件自包含。composer seat / scroll body 的 data 属性是 dsh web 的稳定
  // DOM 契约（skeleton 测试依赖 data-composer-seat）。
  useEffect(() => {
    const scrollBody = document.querySelector('[data-conversation-scroll]')
    const seat = scrollBody?.querySelector<HTMLElement>('[data-composer-seat]') ?? null
    if (seat === null) return
    seat.style.display = 'none'
    return () => { seat.style.display = '' }
  }, [])

  /** 拉取 record 侧的原文：「放弃修改直接跑」时作为定稿覆盖前端两处。 */
  const getRecordScript = useCallback(async (): Promise<string | undefined> => {
    try {
      const response = await fetch(`/dsh-femwa/session-state?sessionId=${encodeURIComponent(sessionId)}`)
      const data = await response.json() as { ok?: boolean; script?: string }
      return data.ok === true ? data.script : undefined
    } catch {
      return undefined
    }
  }, [sessionId])

  const loadSessionState = useCallback(async (): Promise<void> => {
    const response = await fetch(`/dsh-femwa/session-state?sessionId=${encodeURIComponent(sessionId)}`)
    const data = await response.json() as { ok?: boolean; script?: string; scriptPath?: string; rev?: number; checkpoint?: Record<string, string>; running?: boolean }
    // [femwa-diag] 记录形态取证：script 长度 / 地址 / running（连接线丢失调查）
    console.log(`[femwa-diag] session-state sid=${sessionId} ok=${String(data.ok)} script=${data.script === undefined ? 'undefined' : String(data.script.length) + 'ch'} path=${data.scriptPath ?? 'none'} rev=${String(data.rev)} running=${String(data.running)}`)
    if (data.ok === true) {
      setState({
        hasScript: data.script !== undefined,
        script: data.script,
        scriptPath: data.scriptPath,
        rev: data.rev ?? 0,
        checkpoint: data.checkpoint ?? {},
        running: data.running === true,
      })
    }
  }, [sessionId])

  useEffect(() => {
    void loadSessionState().catch(() => { /* 编辑器仍可空白启动 */ })
  }, [loadSessionState])

  // 双链路②：femwa-mount 等外部写入会话记录后广播 script_changed → 重拉
  // session-state。initialScript prop 变化会触发 femGen 恢复 effect 重新
  // applyFEMText，已打开的编辑器画布即按最新记录重载。
  // 多端语义（2026-08-22 定稿）：record 为准，外部更新静默接受覆盖。
  useEffect(() => {
    const es = new EventSource('/dsh-femwa/events')
    es.onmessage = (ev: MessageEvent<string>): void => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string; data?: Record<string, unknown> }
        if (msg.type !== 'script_changed') return
        if (String(msg.data?.pageId ?? '') === PAGE_ID) return
        if (String(msg.data?.sessionId ?? '') !== String(sessionId)) return
        void loadSessionState()
          .catch((error: unknown) => { console.warn('[dsh-femwa] script_changed reload failed:', error) })
      } catch {
        // 非 JSON SSE 行忽略
      }
    }
    return () => es.close()
  }, [sessionId, loadSessionState])

  // 断点位置：主流程分支优先，其次任一分支（画布按节点 label 匹配）。
  const checkpointNode = state === null
    ? undefined
    : state.checkpoint['__main__'] ?? Object.values(state.checkpoint)[0]

  // 显式落盘（2026-08-22 架构重构）：仅由「图生文本/文本生图」两个定稿按钮调用，
  // 把传入文本写为会话记录。会话记录 = {path?, text?, rev}：只写 text 保留已有地址；
  // 带 baseRev 做乐观锁——多端并发后写者输（409）→ 弹窗让用户选「加载最新/保留我的」。
  const persistScript = (fems: string): void => {
    void fetch('/dsh-femwa/session-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, fems, pageId: PAGE_ID, ...(state?.rev === undefined ? {} : { baseRev: state.rev }) }),
    })
      .then(async (response) => {
        if (response.status !== 409) return
        const data = await response.json().catch(() => null) as { ok?: boolean; record?: { rev?: number } } | null
        setConflict({ localFems: fems, remoteRev: data?.record?.rev ?? 0 })
      })
      .catch((error: unknown) => {
        console.warn('[dsh-femwa] persist write failed:', error)
      })
  }

  /** 冲突裁决·加载最新：丢弃本地文本，按服务端当前记录重载画布。 */
  const resolveConflictByReload = (): void => {
    setConflict(null)
    void loadSessionState()
      .catch((error: unknown) => { console.warn('[dsh-femwa] conflict reload failed:', error) })
  }

  /** 冲突裁决·保留我的编辑：以服务端最新 rev 为基准强制重写本地文本。 */
  const resolveConflictByOverride = (): void => {
    if (conflict === null) return
    const fems = conflict.localFems
    void fetch('/dsh-femwa/session-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, fems, baseRev: conflict.remoteRev, pageId: PAGE_ID }),
    })
      .then(async (response) => {
        if (response.ok) {
          const data = await response.json().catch(() => null) as { ok?: boolean; rev?: number } | null
          setState(prev => prev === null ? prev : { ...prev, rev: data?.rev ?? prev.rev })
          setConflict(null)
          return
        }
        if (response.status === 409) {
          // 覆盖期间又被别人写了：刷新弹窗里的 remoteRev，让用户再裁一次。
          const data = await response.json().catch(() => null) as { record?: { rev?: number } } | null
          setConflict({ localFems: fems, remoteRev: data?.record?.rev ?? conflict.remoteRev })
        }
      })
      .catch((error: unknown) => { console.warn('[dsh-femwa] conflict override failed:', error) })
  }

  /** 预检（todo #2）：未保存（无剧本地址）时，剧本里的相对 file: 引用非法——
   *  只支持绝对地址。运行前硬拦截并给出明确提示；已保存态放行（引擎裁决）。 */
  const preflightCheck = (fems: string): string | null => {
    if (state?.scriptPath !== undefined && state.scriptPath.length > 0) return null
    // 匹配 file:"xxx" / file:'xxx' / file："" / 文件：""（与引擎解析一致）
    const refs: string[] = []
    const re = /(?:file|文件)[:：]\s*["'“”]([^"'“”]+)["'“”]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(fems)) !== null) refs.push(m[1])
    const isAbs = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
    const relative = refs.filter(p => !isAbs(p))
    if (relative.length === 0) return null
    return `剧本未保存：依赖文件只支持绝对地址。以下引用是相对路径：${relative.join('、')}。请先「导出 .FEMS」保存剧本（相对路径将基于剧本文件位置解析），或改用绝对路径。`
  }

  const onRun = async (fems: string, opts?: { reset?: boolean }): Promise<void> => {
    const problem = preflightCheck(fems)
    if (problem !== null) throw new Error(problem)
    const response = await fetch('/dsh-femwa/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        fems,
        ...(opts?.reset === true ? { reset: true } : {}),
      }),
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
  }
  const onStop = (): void => {
    void stopScript().catch((error: unknown) => {
      console.warn('[dsh-femwa] stop failed:', error)
    })
  }

  /** 导出：系统目录选择器选保存目录 → 保存 <目录>/<文件名>.fems → 会话记录
   *  替换为地址（不保留原文）→ 返回完整路径。 */
  const onExport = async (fems: string, name: string): Promise<string> => {
    const pickResp = await fetch('/dsh-femwa/pick-directory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const pickData = await pickResp.json() as { ok?: boolean; directory?: string | null; error?: string; kind?: string }
    if (pickData.ok !== true || typeof pickData.directory !== 'string' || pickData.directory.length === 0) {
      if (pickData.kind === 'browse') {
        // browse 后端：无系统对话框，前端提示用路径输入（暂未实现）。
        throw new Error('当前环境不支持系统目录选择器（browse 后端）')
      }
      throw new Error(pickData.error ?? (pickData.directory === null ? '已取消选择' : '选择目录失败'))
    }
    const safe = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.fems$/i, '')
    const fullPath = `${pickData.directory.replace(/[\\/]+$/, '')}\\${safe}.fems`
    const saved = await saveScript(fullPath, fems)
    await fetch('/dsh-femwa/session-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, scriptPath: saved }),
    })
    setState(prev => prev === null ? prev : { ...prev, scriptPath: saved, script: fems })
    return saved
  }

  /** 导入：FileReader 已把本地文件读入画布（femGen 内部），这里把内容上传
   *  保存到服务端 projects/（按文件名）→ 会话记录只存地址。 */
  const onImport = async (content: string, filename: string): Promise<string> => {
    const saved = await saveScript(filename.replace(/\.fems$/i, ''), content)
    await fetch('/dsh-femwa/session-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, scriptPath: saved }),
    })
    setState(prev => prev === null ? prev : { ...prev, scriptPath: saved, script: content })
    return saved
  }
  return (
    // data-conversation-composer-overlay：dsh 本体 CSS 据此给 viewArea
    // 确定高度（flex: 1 1 0 + min-height: 0 + overflow: hidden，trajectory
    // 同款机制），否则 FEMEditor 的 height:100% 解析失败、内容撑开使整个
    // 页面可无限下拉。标记随本视图卸载自动撤销。
    <div data-conversation-composer-overlay="" style={{ position: 'relative', height: '100%' }}>
      <FEMEditor
        plugin
        onRun={onRun}
        onStop={onStop}
        onPersistScript={persistScript}
        getRecordScript={getRecordScript}
        onExport={onExport}
        onImport={onImport}
        onBackToShell={toggleSidebar}
        savedPath={state?.scriptPath}
        initialScript={state?.script}
        initialCheckpoint={checkpointNode}
        initialRunning={state?.running === true}
        onRestoreError={onRestoreError}
      />
      {conflict !== null && createPortal(
        <div style={{
          position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            maxWidth: 420, width: 'calc(100% - 48px)', padding: '18px 20px', borderRadius: 12,
            background: 'color-mix(in srgb, var(--dsw-surface-2, #f5f5f5) 96%, transparent)',
            border: '1px solid var(--dsw-border, #e0e0e0)', boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
            fontSize: 13, lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>⚔️ 剧本冲突</div>
            <div style={{ color: 'var(--dsw-text-secondary, #666)', marginBottom: 14 }}>
              本窗口的编辑和其他窗口/设备的保存冲突了（对方先写入）。以哪个为准？
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={resolveConflictByReload} style={conflictBtnStyle}>加载最新版本</button>
              <button
                onClick={resolveConflictByOverride}
                style={{ ...conflictBtnStyle, color: '#fff', background: '#d96b2b', borderColor: '#d96b2b' }}
              >保留我的编辑</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {editorNotice !== null && createPortal(
        <div style={{
          position: 'fixed', left: 12, right: 12, bottom: 12, zIndex: 300,
          display: 'flex', gap: 8, alignItems: 'flex-start',
          padding: '10px 14px', borderRadius: 10, margin: '0 auto', maxWidth: 560,
          background: 'color-mix(in srgb, #fdecea 92%, transparent)',
          border: '1px solid #e5b3ad', boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
          fontSize: 12.5, lineHeight: 1.55,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>⚠️ 剧本恢复失败（已上报主模型）</div>
            <div style={{ color: 'var(--dsw-text-secondary, #666)', whiteSpace: 'pre-wrap' }}>{editorNotice}</div>
          </div>
          <button
            onClick={() => setEditorNotice(null)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 2 }}
            title="关闭"
          >✕</button>
        </div>,
        document.body,
      )}
    </div>
  )
}


// ── dsh-femwa/chat node ───────────────────────────────────────────────────

/** One rendered dsh-femwa/chat line. */
interface FemwaChatData {
  readonly actor?: string
  readonly text: string
  readonly kind: 'role' | 'notice' | 'human_wait' | 'prompt' | 'error' | 'thinking' | 'tool_call' | 'speaker' | 'sys'
  /**
   * Actor names this line is visible to (the action's scope). Absent =
   * visible to everyone (role/prompt/human_wait with unknown scope);
   * notice/error/thinking lines never carry it and are god-view only.
   */
  readonly visible?: readonly string[]
  readonly seq: number
}

// ── view perspective state (per session) ───────────────────────────────────
// 'god' shows everything; `@actor` filters chat lines to what that actor's
// scope can see. Module-level per-session store + tiny subscribe, so both the
// header button and the chat-line renderer share one source of truth.

const viewBySession = new Map<string, string>()
const viewListeners = new Map<string, Set<() => void>>()

function currentView(sessionId: string | undefined): string {
  if (sessionId === undefined) return 'god'
  const stored = viewBySession.get(sessionId)
  if (stored !== undefined) return stored
  // 默认视图：投影窗=fem-proj- 前缀）=上帝视角全显；主会话=戏外（纯 DSH
  // 原生 user+主模型页面，femwa 行全隐藏——含旧版本写进主会话的历史残留行）。
  return sessionId.startsWith('fem-proj-') ? 'god' : 'offstage'
}

function setView(sessionId: string, view: string): void {
  viewBySession.set(sessionId, view)
  const listeners = viewListeners.get(sessionId)
  if (listeners === undefined) return
  for (const listener of listeners) listener()
}

function subscribeView(sessionId: string | undefined, listener: () => void): () => void {
  if (sessionId === undefined) return () => {}
  let listeners = viewListeners.get(sessionId)
  if (listeners === undefined) {
    listeners = new Set()
    viewListeners.set(sessionId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) viewListeners.delete(sessionId)
  }
}

/** React hook: the session's current view, re-rendering on switches. */
function useView(sessionId: string | undefined): string {
  const [view, setLocal] = useState(currentView(sessionId))
  useEffect(() => {
    if (sessionId === undefined) return
    setLocal(currentView(sessionId))
    return subscribeView(sessionId, () => setLocal(currentView(sessionId)))
  }, [sessionId])
  return view
}

// ── fem_stream 直播缓冲（2026-08-24 方案B：SSE 旁路零落盘）────────────────
// host 的 runAiSubagent 把演员 chunk 旁路广播到 /dsh-femwa/events；这里按
// 「主会话 id + actorKey」分桶缓冲，speaker 锚点行在名字正下方渲染官方同
// 款打字机。块完成（block_end）即从缓冲移除——原生镜像几乎同时落地接管；
// run 结束（end）整桶清空兜底。全部内存态，不写任何会话日志。

interface FemStreamBlock {
  kind: 'text' | 'reasoning' | 'toolcall'
  text: string
  /** toolcall 块：工具名（首帧带 name 的 delta 合并进来）。 */
  name?: string
}

interface FemStreamMsg {
  kind: 'start' | 'delta' | 'block_end' | 'end'
  sid?: unknown
  actor?: unknown
  blockKind?: unknown
  text?: unknown
  name?: unknown
}

const EMPTY_FEM_BLOCKS: readonly FemStreamBlock[] = []

/** 主会话id+actorKey → 该演员当前未落地的直播块序列（copy-on-write）。 */
const femStreams = new Map<string, Map<string, { blocks: readonly FemStreamBlock[] }>>()
const femStreamListeners = new Set<() => void>()
let femStreamRaf = 0

function femStreamNotify(): void {
  if (femStreamRaf !== 0) return
  femStreamRaf = requestAnimationFrame(() => {
    femStreamRaf = 0
    for (const listener of [...femStreamListeners]) listener()
  })
}

function femStreamEntry(sid: string, actorKey: string): { blocks: readonly FemStreamBlock[] } {
  let byActor = femStreams.get(sid)
  if (byActor === undefined) {
    byActor = new Map()
    femStreams.set(sid, byActor)
  }
  let entry = byActor.get(actorKey)
  if (entry === undefined) {
    entry = { blocks: EMPTY_FEM_BLOCKS }
    byActor.set(actorKey, entry)
  }
  return entry
}

function femStreamSet(sid: string, actorKey: string, entry: { blocks: readonly FemStreamBlock[] }): void {
  femStreams.get(sid)?.set(actorKey, entry)
  femStreamNotify()
}

function findLastFemBlock(blocks: readonly FemStreamBlock[], kind: 'text' | 'reasoning' | 'toolcall'): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.kind === kind) return i
  }
  return -1
}

/** 投影窗 id 的 actorKey 消毒（与宿主 projectionActorKey 同算法，前端比对用）。 */
function femProjectionActorKey(actor: string): string {
  return Array.from(actor).map(ch => (/[A-Za-z0-9_-]/.test(ch) ? ch : `_${(ch.codePointAt(0) ?? 0).toString(16)}`)).join('')
}

/** 应用一条宿主广播；未知形态静默忽略（通道宽松前向兼容）。 */
function femStreamApply(msg: FemStreamMsg): void {
  const sid = typeof msg.sid === 'string' ? msg.sid : ''
  const actor = typeof msg.actor === 'string' ? msg.actor : ''
  if (sid.length === 0 || actor.length === 0) return
  const blockKind = msg.blockKind === 'reasoning'
    ? 'reasoning' as const
    : msg.blockKind === 'toolcall' ? 'toolcall' as const : 'text' as const
  const actorKey = femProjectionActorKey(actor)
  if (msg.kind === 'end') {
    if (femStreams.get(sid)?.delete(actorKey) === true) femStreamNotify()
    return
  }
  const prev = femStreams.get(sid)?.get(actorKey)?.blocks ?? EMPTY_FEM_BLOCKS
  if (msg.kind === 'start') {
    femStreamSet(sid, actorKey, { blocks: [...prev, { kind: blockKind, text: '' }] })
    return
  }
  if (msg.kind === 'delta') {
    const text = typeof msg.text === 'string' ? msg.text : ''
    const name = typeof msg.name === 'string' && msg.name.length > 0 ? msg.name : undefined
    if (blockKind === 'toolcall') {
      // 工具调用：聚合到「最后一个 toolcall 块」；无则新建（宿主不发 start）。
      const lastIdx = findLastFemBlock(prev, 'toolcall')
      if (lastIdx >= 0) {
        const target = prev[lastIdx] as FemStreamBlock
        const next = prev.slice()
        next[lastIdx] = {
          ...target,
          text: target.text + text,
          ...name !== undefined && !target.name ? { name } : {},
        }
        femStreamSet(sid, actorKey, { blocks: next })
      } else {
        femStreamSet(sid, actorKey, { blocks: [...prev, { kind: 'toolcall', text, ...name !== undefined ? { name } : {} }] })
      }
      return
    }
    if (text.length === 0) return
    const lastIdx = findLastFemBlock(prev, blockKind)
    if (lastIdx >= 0) {
      const target = prev[lastIdx] as FemStreamBlock
      const next = prev.slice()
      next[lastIdx] = { ...target, text: target.text + text }
      femStreamSet(sid, actorKey, { blocks: next })
    } else {
      femStreamSet(sid, actorKey, { blocks: [...prev, { kind: blockKind, text }] })
    }
    return
  }
  if (msg.kind === 'block_end') {
    const lastIdx = findLastFemBlock(prev, blockKind)
    if (lastIdx < 0) return
    const next = prev.slice()
    next.splice(lastIdx, 1)
    femStreamSet(sid, actorKey, { blocks: next })
  }
}

// SSE 单例（引用计数）：首个订阅者开连接，最后一个释放时关闭。
// 2026-08-25 加固+诊断：apply() 时页面级预开一条（不随锚点卸载关闭——
// store 常年喂帧，锚点晚挂载也能 read() 到全量缓冲）；onopen/onerror/
// 首帧打 [dsh-femwa][stream] 低噪日志，直播层缺席时一眼分辨断在哪环。
let femStreamEs: EventSource | undefined
let femStreamEsRefs = 0
let femStreamFirstFrameLogged = false

function femStreamAcquire(): () => void {
  femStreamEsRefs += 1
  if (femStreamEs === undefined) {
    femStreamEs = new EventSource('/dsh-femwa/events')
    femStreamEs.onopen = (): void => { console.info('[dsh-femwa][stream] sse open') }
    femStreamEs.onerror = (): void => { console.info(`[dsh-femwa][stream] sse error (readyState=${femStreamEs?.readyState})`) }
    femStreamEs.onmessage = (ev: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string; data?: Record<string, unknown> }
        if (msg.type === 'fem_stream') {
          if (!femStreamFirstFrameLogged) {
            femStreamFirstFrameLogged = true
            console.info('[dsh-femwa][stream] first frame received')
          }
          femStreamApply((msg.data ?? {}) as FemStreamMsg)
        }
      } catch {
        // 非 JSON SSE 行忽略
      }
    }
  }
  return () => {
    femStreamEsRefs -= 1
    if (femStreamEsRefs <= 0 && femStreamEs !== undefined) {
      femStreamEs.close()
      femStreamEs = undefined
      femStreamFirstFrameLogged = false
    }
  }
}

/** React hook：读某主会话某演员的直播块；挂载期间维持 SSE 连接并随帧刷新。 */
function useFemStream(mainSid: string | undefined, actorKey: string | undefined): readonly FemStreamBlock[] {
  const [blocks, setBlocks] = useState<readonly FemStreamBlock[]>(EMPTY_FEM_BLOCKS)
  useEffect(() => {
    if (mainSid === undefined || actorKey === undefined) return
    console.info(`[dsh-femwa][stream] anchor subscribe ${mainSid}/${actorKey}`)
    const read = (): void => { setBlocks(femStreams.get(mainSid)?.get(actorKey)?.blocks ?? EMPTY_FEM_BLOCKS) }
    read()
    const release = femStreamAcquire()
    femStreamListeners.add(read)
    return () => {
      femStreamListeners.delete(read)
      release()
    }
  }, [mainSid, actorKey])
  return blocks
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'femwa-role': FemwaChatData
  }
}

/** Stable color per actor name (simple string hash -> HSL). */
function actorColor(actor: string): string {
  let hash = 0
  for (let i = 0; i < actor.length; i++) {
    hash = (hash * 31 + actor.charCodeAt(i)) >>> 0
  }
  return `hsl(${hash % 360} 65% 45%)`
}

/** Single-event node: every dsh-femwa/chat event is one chat row. */
const femwaChatDefinition: ConversationNodeDefinition<FemwaChatData> = {
  kind: 'femwa-role',
  target: 'chat',
  match: (event) => {
    if (event.type === 'dsh-femwa/chat') {
      return { id: String(event.seq), role: 'start' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'dsh-femwa/chat') {
      throw new Error('femwa-role start requires dsh-femwa/chat')
    }
    const d = match.event.data
    return {
      ...d.actor === undefined ? {} : { actor: d.actor },
      text: d.text,
      kind: d.kind,
      ...d.visible === undefined ? {} : { visible: d.visible },
      seq: match.event.seq,
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'femwa-role',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: { kind: 'unresolved' },
      visibility: 'visible',
      data: context.state,
    }
  },
}

/** Render one dsh-femwa/chat line. */
export function FemwaChatNodeView({ node, useSession, t }: ChatNodeViewProps<'femwa-role'>) {
  const { actor, text, kind, visible } = node.data
  const sessionId = useSession(snapshot => snapshot.sessionId)
  const view = useView(sessionId)
  // ── 流式直播订阅（2026-08-24 方案B）───────────────────────────────────
  // 仅投影窗的 speaker 行有资格当锚点；mainSid / 本窗 actorKey 由窗 id
  // 推导（fem-proj-<sid>-<actorKey>）。可见性：god 窗显示全部演员，角色
  // 窗只认自己的 actorKey。hooks 全部前置（早退过滤在 hooks 之后）。
  const projSuffix = sessionId !== undefined && sessionId.startsWith('fem-proj-')
    ? sessionId.slice('fem-proj-'.length)
    : undefined
  const mainSid = projSuffix !== undefined ? projSuffix.replace(/-[^-]*$/, '') : undefined
  const winActorKey = projSuffix !== undefined && projSuffix.includes('-')
    ? projSuffix.slice(projSuffix.lastIndexOf('-') + 1)
    : undefined
  const myActorKey = actor !== undefined ? femProjectionActorKey(actor) : undefined
  const streamEligible = view !== 'offstage' && kind === 'speaker'
    && winActorKey !== undefined && myActorKey !== undefined
    && (winActorKey === 'god' || winActorKey === myActorKey)
  // 诊断（2026-08-25）：每个 speaker 行实例只打一次门控取值——直播层缺席时
  // 一眼分辨「没资格订阅」还是「订阅了没帧」。
  const gateLoggedRef = useRef(false)
  if (!gateLoggedRef.current && kind === 'speaker' && sessionId !== undefined && sessionId.startsWith('fem-proj-')) {
    gateLoggedRef.current = true
    console.info(`[dsh-femwa][stream] anchor gate sid=${sessionId} win=${winActorKey} actor=${myActorKey} eligible=${streamEligible}`)
  }
  const liveBlocksRaw = useFemStream(streamEligible ? mainSid : undefined, streamEligible ? myActorKey : undefined)
  const chat = useSession(s => s.chat)
  // 最新行门控：同一演员历史上有多条 speaker 行，只有最新一条允许渲染直播
  // （否则旧名字行会重复显示当前缓冲）。按当前 chat 快照单遍扫描。
  const lastSpeakerKeys = useMemo(() => {
    const m = new Map<string, string>()
    for (const key of chat.order) {
      const nd = chat.nodes.get(key)
      if (nd === undefined || nd.kind !== 'femwa-role') continue
      const fd = nd.data as FemwaChatData
      if (fd.kind === 'speaker') m.set(fd.actor ?? '', nd.key)
    }
    return m
  }, [chat])
  // 防御性 locale：席位缺失/未来回归时退化为 key 本身，绝不因 t 崩掉节点
  // （2026-08-25 实锤：t 不是函数会让 SlotErrorBoundary 吞掉全部 femwa 行）。
  const safeT = typeof t === 'function' ? t : (key: string): string => key
  const codeLabels = useMemo(() => ({ copyLabel: safeT('copy'), copiedLabel: safeT('copied') }), [safeT])
  const liveBlocks = streamEligible && lastSpeakerKeys.get(actor ?? '') === node.key
    ? liveBlocksRaw
    : EMPTY_FEM_BLOCKS
  // View-perspective filter: in a role view, meta lines (notice/error/
  // thinking) are god-only, and dialogue lines show only when the actor's
  // scope includes this viewer. Absent `visible` = visible to everyone.
  if (view === 'offstage') {
    // 戏外视角：主会话=纯 DSH 原生页面（user+主模型），femwa 行全部隐藏
    // （角色行/名字行/引擎通知/等待提示都属戏内，上帝窗承载；也遮住旧版本
    // 写进主会话的历史残留行）。唯一例外=sys 运行回执（femwa-run 动作成功
    // 的状态条，属戏外系统消息而非戏内内容，host 只写主会话不进投影窗）。
    if (kind !== 'sys') return null
  } else if (view !== 'god') {
    if (kind === 'notice' || kind === 'error' || kind === 'thinking' || kind === 'tool_call') return null
    // speaker 名字行不做 scope 过滤：角色视角也能看到所有角色的名字
    // （内容 turn 由 CSS 按视角隐藏，名字作为对话流的"演员表"保留）。
    if (kind !== 'speaker' && visible !== undefined && !visible.includes(view)) return null
  }
  if (kind === 'speaker') {
    // 子代理 turn 首行：发言者名字；cot/工具调用/回答从下一行开始。
    // 2026-08-24 方案B：本行兼任流式锚点——直播中的块以官方同款渲染画在
    // 名字正下方（=原生块即将落地的位置），block_end/end 后自动消失；
    // 无直播时与历史形态完全一致（一行名字，零额外 DOM）。
    return (
      <div>
        <div style={{
          margin: '8px 0 2px',
          fontWeight: 700,
          fontSize: '12.5px',
          color: actorColor(actor ?? 'AI'),
        }}>
          {actor ?? 'AI'}
        </div>
        {liveBlocks.length > 0 && (
          <div className="fem-stream-root">
            {liveBlocks.map((block, i) => block.kind === 'reasoning'
              ? (
                <FemReasoningRow
                  key={i}
                  text={block.text}
                  running={i === liveBlocks.length - 1}
                  runningLabel={safeT('row.running')}
                />
              )
              : block.kind === 'toolcall'
                ? (
                  <div key={i} className="fem-stream-toolline">
                    ⚙ {block.name ?? 'tool'}（{block.text.length > 140 ? `${block.text.slice(0, 140)}…` : block.text}）
                  </div>
                )
                : <MarkdownText key={i} text={block.text} streaming codeLabels={codeLabels} />)}
            <span className="fem-stream-caret" aria-hidden />
          </div>
        )}      </div>
    )
  }
  // (kind === 'thinking' 的自绘折叠思考链已按用户要求删除：思考链统一用 dsh 原生 assistant-step 折叠渲染，不再自绘。)
  if (kind === 'tool_call') {
    // Subagent tool invocation line: text is JSON {kind:'call'|'result', name, args?, result?}.
    // Parsing failure falls back to plain text (older sessions).
    let tool: { kind?: string; name?: string; args?: string; result?: string } | null = null
    try { tool = JSON.parse(text) as { kind?: string; name?: string; args?: string; result?: string } } catch { tool = null }
    const name = tool?.name ?? '工具调用'
    const body = tool?.kind === 'result' ? (tool?.result ?? '') : (tool?.args ?? '')
    const MAX_BODY = 400
    const clipped = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n…（截断，共 ${body.length} 字符）` : body
    return (
      <div style={{
        margin: '2px 0',
        fontSize: '11px',
        fontFamily: 'JetBrains Mono, monospace',
        color: 'var(--dsw-text-tertiary, #999)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        lineHeight: 1.5,
      }}>
        {tool?.kind === 'result' ? `🔧 ${name} 结果：${clipped}` : `🔧 ${name} 调用：${clipped}`}
      </div>
    )
  }
  if (kind === 'error') {
    // Engine error: red system-like line (meta, but shown in the transcript).
    return (
      <div style={{
        textAlign: 'left',
        color: 'var(--dsw-danger, #e5484d)',
        fontSize: '12px',
        padding: '4px 0',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {text}
      </div>
    )
  }
  if (kind === 'notice' || kind === 'sys') {
    // sys=femwa-run 动作成功的用户回执（只存在于主会话表面），与引擎 notice
    // 共用居中灰字样式；角色视角不过滤它（运行状态对各视角都有效）。
    return (
      <div style={{
        textAlign: 'center',
        color: 'var(--dsw-text-tertiary, #999)',
        fontSize: '12px',
        padding: '6px 0',
      }}>
        {text}
      </div>
    )
  }
  if (kind === 'prompt') {
    // Announcement / node-hint bar: not a speech bubble, a stage note.
    return (
      <div style={{
        margin: '6px 0',
        padding: '6px 12px',
        borderRadius: '6px',
        borderLeft: '3px solid var(--dsw-accent, #4a9eff)',
        background: 'color-mix(in srgb, var(--dsw-accent, #4a9eff) 6%, transparent)',
        color: 'var(--dsw-text-secondary, #666)',
        fontSize: '12px',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {text}
      </div>
    )
  }
  if (kind === 'human_wait') {
    return (
      <div style={{
        margin: '6px 0',
        padding: '8px 12px',
        borderRadius: '8px',
        background: 'color-mix(in srgb, var(--dsw-accent, #4a9eff) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--dsw-accent, #4a9eff) 40%, transparent)',
        color: 'var(--dsw-text-primary, #222)',
        fontSize: '13px',
      }}>
        {text}
      </div>
    )
  }
  // role bubble（名字已由 turn 首行的 speaker 行显示，这里只保留文本块）
  return (
    <div style={{
      margin: '6px 0',
      padding: '8px 12px',
      borderRadius: '8px',
      background: 'var(--dsw-surface-2, #f5f5f5)',
      color: 'var(--dsw-text-primary, #222)',
      fontSize: '13px',
      lineHeight: 1.6,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }}>
      {text}
    </div>
  )
}

// ── sidebar action with script menu ───────────────────────────────────────

/** Injected face assembled by the apply closure. */
interface FemButtonInjected {
  /** Fetch available .fems scripts from the host. */
  listScripts(): Promise<string[]>
  /** Create a Fem session for one script and open it. */
  createFemSession(scriptPath?: string): Promise<void>
  /** Save a pasted script to a .fems file; returns its path. */
  saveScript(name: string, content: string): Promise<string>
}

type FemButtonProps = { wide: boolean } & FemButtonInjected

/** Sidebar footer action: create and open a new Fem mode session. */
export function FemButton({ wide, listScripts, createFemSession, saveScript }: FemButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [scripts, setScripts] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [scriptName, setScriptName] = useState('')
  const [scriptContent, setScriptContent] = useState('')
  const [saving, setSaving] = useState(false)

  const toggleMenu = (): void => {
    if (menuOpen) {
      setMenuOpen(false)
      return
    }
    setMenuOpen(true)
    void listScripts().then(setScripts).catch((error: unknown) => {
      console.warn('[dsh-femwa] list scripts failed:', error)
      setScripts([])
    })
  }

  const run = (scriptPath: string | undefined): void => {
    setMenuOpen(false)
    if (busy) return
    setBusy(true)
    void createFemSession(scriptPath)
      .catch((error: unknown) => {
        console.warn('[dsh-femwa] create fem session failed:', error)
      })
      .finally(() => { setBusy(false) })
  }

  const openEditor = (): void => {
    setMenuOpen(false)
    setScriptName('')
    setScriptContent('')
    setEditorOpen(true)
  }

  const submitScript = (): void => {
    if (saving) return
    const name = scriptName.trim()
    if (name.length === 0) return
    setSaving(true)
    void saveScript(name, scriptContent)
      .then((path) => {
        setEditorOpen(false)
        return createFemSession(path)
      })
      .catch((error: unknown) => {
        console.warn('[dsh-femwa] save/run script failed:', error)
      })
      .finally(() => { setSaving(false) })
  }

  const editor = editorOpen
    ? (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: '8px',
          width: '420px',
          maxWidth: '80vw',
          background: 'var(--dsw-surface-1, #fff)',
          border: '1px solid var(--dsw-border, #ddd)',
          borderRadius: '8px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          padding: '10px',
          zIndex: 100,
          fontSize: '13px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--dsw-text-primary, #222)' }}>输入 Fem 剧本</div>
          <input
            value={scriptName}
            onChange={(e) => setScriptName(e.currentTarget.value)}
            placeholder="剧本名称（不含扩展名）"
            style={{
              padding: '6px 8px',
              border: '1px solid var(--dsw-border, #ddd)',
              borderRadius: '6px',
              background: 'var(--dsw-surface-2, #f5f5f5)',
              color: 'var(--dsw-text-primary, #222)',
              fontSize: '13px',
            }}
          />
          <textarea
            value={scriptContent}
            onChange={(e) => setScriptContent(e.currentTarget.value)}
            placeholder={'粘贴 .fems 剧本内容…\n（剧本是一段文字：meta/actors/vars/action/mainflow…）'}
            rows={10}
            spellCheck={false}
            style={{
              padding: '8px',
              border: '1px solid var(--dsw-border, #ddd)',
              borderRadius: '6px',
              background: 'var(--dsw-surface-2, #f5f5f5)',
              color: 'var(--dsw-text-primary, #222)',
              fontSize: '12px',
              fontFamily: 'monospace',
              lineHeight: 1.5,
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => setEditorOpen(false)}
              style={{
                padding: '5px 12px',
                border: '1px solid var(--dsw-border, #ddd)',
                borderRadius: '6px',
                background: 'transparent',
                color: 'var(--dsw-text-secondary, #666)',
                cursor: 'pointer',
                fontSize: '13px',
              }}
            >
              取消
            </button>
            <button
              type="button"
              disabled={saving || scriptName.trim().length === 0}
              onClick={submitScript}
              style={{
                padding: '5px 12px',
                border: 'none',
                borderRadius: '6px',
                background: 'var(--dsw-accent, #4a9eff)',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '13px',
              }}
            >
              {saving ? '保存中…' : '保存并运行'}
            </button>
          </div>
        </div>
      )
    : null

  const menu = menuOpen
    ? (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: '8px',
          minWidth: '220px',
          maxHeight: '300px',
          overflowY: 'auto',
          background: 'var(--dsw-surface-1, #fff)',
          border: '1px solid var(--dsw-border, #ddd)',
          borderRadius: '8px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          padding: '4px',
          zIndex: 100,
          fontSize: '13px',
        }}>
          {scripts.length === 0 && <div style={{ padding: '6px 10px', color: 'var(--dsw-text-tertiary, #999)' }}>未找到剧本</div>}
          {scripts.length > 0 && <div style={{ padding: '4px 10px', color: 'var(--dsw-text-tertiary, #999)', fontSize: '12px' }}>选择剧本：</div>}
          {scripts.map((path) => {
            const name = path.split(/[\\/]/).pop() ?? path
            return (
              <button
                key={path}
                type="button"
                onClick={() => run(path)}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '6px 10px',
                  border: 'none',
                  borderRadius: '6px',
                  background: 'transparent',
                  color: 'var(--dsw-text-primary, #222)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={path}
              >
                {name}
              </button>
            )
          })}
          <button
            type="button"
            onClick={openEditor}
            style={{
              display: 'block',
              width: '100%',
              padding: '6px 10px',
              border: 'none',
              borderRadius: '6px',
              background: 'transparent',
              color: 'var(--dsw-text-secondary, #666)',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            ✏️ 输入剧本…
          </button>
          <button
            type="button"
            onClick={() => run(undefined)}
            style={{
              display: 'block',
              width: '100%',
              padding: '6px 10px',
              border: 'none',
              borderRadius: '6px',
              background: 'transparent',
              color: 'var(--dsw-text-secondary, #666)',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            ＋ 空会话（不带剧本）
          </button>
        </div>
      )
    : null

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        disabled={busy}
        onClick={toggleMenu}
        title="新建 Fem 剧本会话（无主模型的多智能体剧本舞台）"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          width: '100%',
          height: '28px',
          border: 'none',
          borderRadius: '6px',
          background: 'transparent',
          color: 'var(--dsw-text-secondary, #888)',
          cursor: 'pointer',
          fontSize: '13px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}
      >
        <span aria-hidden>🎭</span>
        {wide && <span>Fem 剧本</span>}
        {busy && <span>…</span>}
      </button>
      {menu}
      {editor}
    </div>
  )
}

// ── view-perspective button (session header) ──────────────────────────────

/** FemViewButton 注入能力。 */
interface FemViewInjected {
  /** 打开任意会话（视角菜单跳转投影窗/主会话）。 */
  openSession(id: string): void
  /** 查询主会话的投影窗 id 列表（上帝窗 + 角色窗）。 */
  listProjectionWindows(sid: string): Promise<{ god?: string; actors: Record<string, string> }>
}

/** Session-header action: switch between god view and per-actor views.
 *  视角菜单：戏外=主会话本体 / 上帝=上帝投影窗 / 角色=角色投影窗。
 *  dsh 原生切换显示（主会话与子代理窗同一 UI 位置）。
 *  2026-08-23：order -10→-20（排到 preset 徽章之前，紧贴 session name）；
 *  菜单支持点外部收起。 */
export function FemViewButton({ useSession, useSessions, openSession, listProjectionWindows }: PropsRuntime<'conversation.session.header.actions'> & FemViewInjected) {
  const sessionId = useSession(snapshot => snapshot.sessionId)
  const view = useView(sessionId)
  const [open, setOpen] = useState(false)
  // 投影窗 id 缓存：{ god?: string, actors: {name: id} }（host 侧幂等创建）。
  const [proj, setProj] = useState<{ god?: string; actors: Record<string, string> }>({ actors: {} })
  // The button lives on Fem sessions only: the sessions list records the
  // preset each session's agent was composed from (agent-preset/selected
  // keeps it current after a runtime switch), so the menu is ready from boot
  // for existing Fem sessions and never appears on other modes.
  //
  // 归属主会话（2026-08-23 扩展）：视角菜单同时服务两类窗口——
  //   Fem 主会话（agentPreset=dsh-femwa 且无父）→ mainSid=自身；
  //   Fem 投影窗（id 前缀 fem-proj-，parentSession 指向主会话）→ mainSid=父会话。
  // 其余会话（普通子代理/非 fem）mainSid=undefined → 菜单不渲染，不受影响。
  // 视角状态（viewBySession）与 actors/turn-scopes/projection-windows 三张
  // 查询一律挂在 mainSid 名下——视角是「剧」的属性，不是「窗」的属性。
  const mainSid = useSessions((state): string | undefined => {
    if (typeof sessionId !== 'string') return undefined
    const summary = state.byId[sessionId]
    if (summary?.agentPreset === 'dsh-femwa' && summary?.parentId === undefined) return sessionId
    if (sessionId.startsWith('fem-proj-')) {
      const pid = summary?.parentId
      return typeof pid === 'string' ? pid : undefined
    }
    return undefined
  })

  // 「Fem 编辑器」标签页显示范围（2026-08-23 扩展）：Fem 主会话 + proj 窗都
  // 显示（proj 窗内编辑器数据经 useSessions 解析回主会话，见 FemEditorView）；
  // 其余会话照旧 DOM 隐藏。tab 列表 = conversation.view 的全部注册条目（无按
  // 会话过滤的钩子），纯插件方案在 header 挂载时 DOM 隐藏该按钮；本组件随
  // 会话切换重挂载，fem 家族窗口恢复显示。
  useEffect(() => {
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find(el => el.textContent === 'Fem 编辑器')
    if (tab === undefined) return
    tab.style.display = mainSid !== undefined ? '' : 'none'
    return () => { tab.style.display = '' }
  }, [mainSid])
  // Script actors from the host (complete after a run) — the menu's source of
  // truth; chat-line actors below only backfill before the first run.
  const [scriptActors, setScriptActors] = useState<string[]>([])
  useEffect(() => {
    if (mainSid === undefined) return
    let cancelled = false
    void fetch(`/dsh-femwa/actors?sessionId=${encodeURIComponent(mainSid)}`)
      .then(response => response.json())
      .then((data: { ok?: boolean; actors?: string[] }) => {
        if (!cancelled && data.ok === true && data.actors !== undefined && data.actors.length > 0) {
          setScriptActors(data.actors)
        }
      })
      .catch(() => { /* menu falls back to actors seen in chat */ })
    return () => { cancelled = true }
  }, [mainSid])

  // 投影窗 id 列表（host 幂等创建；视角菜单跳转目标）。
  useEffect(() => {
    if (mainSid === undefined) return
    let cancelled = false
    void listProjectionWindows(mainSid)
      .then(w => {
        if (!cancelled) {
          setProj(w)
        }
      })
      .catch(() => { /* 投影窗未建（未运行过剧本）：菜单降级为旧 CSS 过滤 */ })
    return () => { cancelled = true }
  }, [mainSid, listProjectionWindows, scriptActors.length])

  // 点击视角项：打开对应窗（戏外=主会话 / 上帝=上帝窗 / 角色=角色窗）。
  // 投影窗不可用时（未运行剧本）降级为旧 CSS 过滤视图。视角状态记在
  // mainSid 名下（投影窗上操作也归属到主会话，保证跨窗状态一致）。
  // 标签页跟手（2026-08-24）：每个真正 openSession 的分支在跳转「前」读当
  // 前激活 tab 记入一次性标记，目标窗口挂载后对齐（见文件头说明）。
  const pickView = (id: string): void => {
    setOpen(false)
    if (id === 'offstage') {
      // 戏外 = 主会话本体；view 状态标记 offstage，CSS 过滤隐藏角色内容
      // （待主模型恢复后主会话表面回归干净）。投影窗上点戏外 = 跳回主会话。
      setView(mainSid, 'offstage')
      if (mainSid !== sessionId) {
        pendingTabTransfer = { kind: readActiveTabKind(), expiresAt: Date.now() + 5000 }
        openSession(mainSid)
      }
      return
    }
    if (id === 'god' && proj.god !== undefined) {
      setView(mainSid, 'god')
      pendingTabTransfer = { kind: readActiveTabKind(), expiresAt: Date.now() + 5000 }
      openSession(proj.god)
      return
    }
    const actorId = proj.actors[id]
    if (actorId !== undefined) {
      setView(mainSid, id)
      pendingTabTransfer = { kind: readActiveTabKind(), expiresAt: Date.now() + 5000 }
      openSession(actorId)
      return
    }
    // 降级：无投影窗时保持旧行为（CSS 过滤显示）。
    setView(mainSid, id)
  }

  const snapshot = useSession(s => s)

  // ── 视角过滤（显示层 CSS）：host 记录镜像 turn → scope 映射，god 全显示；
  // 角色视角 CSS 隐藏 scope 不含该角色的原生 turn。镜像始终全量（信息完整
  // 落盘），过滤只影响显示，切换视角不丢任何内容。
  const [turnScopes, setTurnScopes] = useState<Record<string, string[]>>({})
  const turnCount = snapshot.turnTimings.size
  useEffect(() => {
    if (mainSid === undefined) return
    let cancelled = false
    void fetch(`/dsh-femwa/turn-scopes?sessionId=${encodeURIComponent(mainSid)}`)
      .then(response => response.json())
      .then((data: { ok?: boolean; scopes?: Record<string, string[]> }) => {
        if (!cancelled && data.ok === true && data.scopes !== undefined) setTurnScopes(data.scopes)
      })
      .catch(() => { /* 视角过滤降级为全显示（信息不丢） */ })
    return () => { cancelled = true }
  }, [mainSid, turnCount])

  useEffect(() => {
    // 原生 assistant turn 的 DOM 锚点：data-chat-flow-key =
    // "13:assistant-step{turn}:{step}"（dsh 渲染器的稳定契约）。注入 CSS
    // 隐藏不可见 turn；CSS 属性选择器对流式新增 DOM 自动生效。
    const STYLE_ID = 'dsh-femwa-view-filter'
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
    if (style === null) {
      style = document.createElement('style')
      style.id = STYLE_ID
      document.head.appendChild(style)
    }
    if (view === 'god') {
      style.textContent = ''
      return
    }
    if (view === 'offstage') {
      // 戏外视角：隐藏全部角色 turn（主会话表面只留用户/系统行）。
      const hiddenSelectors: string[] = []
      for (const turn of Object.keys(turnScopes)) {
        hiddenSelectors.push(`[data-chat-flow-key^="13:assistant-step${turn}:"]`)
      }
      style.textContent = hiddenSelectors.length > 0
        ? `${hiddenSelectors.join(',\n')} { display: none !important }`
        : ''
      return
    }
    const hiddenSelectors: string[] = []
    for (const [turn, scope] of Object.entries(turnScopes)) {
      if (scope.length > 0 && !scope.includes(view)) {
        hiddenSelectors.push(`[data-chat-flow-key^="13:assistant-step${turn}:"]`)
      }
    }
    style.textContent = hiddenSelectors.length > 0
      ? `${hiddenSelectors.join(',\n')} { display: none !important }`
      : ''
    return () => { style.textContent = '' }
  }, [view, turnScopes])

  // 点外部收起：菜单打开期间监听 document 的 pointerdown，点容器外任意空白处
  // 自动收起（与 lineage-fork 官方子代理目录同款交互：pointerdown 即响应，
  // 鼠标/触摸通用）。点击容器内不经此路径：按钮=toggle 关闭、菜单项=pickView
  // 关闭，行为不变。注意：必须在 mainSid 早退 return 之前注册（hooks 不能
  // 条件执行）。
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [open])

  // fem-proj 母名颜色（2026-08-23 需求1）：投影窗的母 session 名由骨架直接渲染
  // （非末段非 subagent 的段不经过任何插件槽位），官方样式是 .crumb 的三级灰
  // （--dsw-alias-label-tertiary）；主会话名的黑来自 .crumbCurrent 的
  // --dsw-alias-label-primary。用户要求两者一致——把 fem-proj 下第一段面包屑
  // 覆盖成同一 token（自动跟随深浅主题）。插件侧安全注入点=按当前会话切换全局
  // 样式文本：本组件在每个打开的会话头都挂载，sessionId 带 fem-proj- 前缀时
  // 启用规则，切走/卸载即清空。零 DOM 结构改动（MutationObserver 路线弃用，
  // 上次事故根源）。哈希类名取自 rc.2 构建产物 ui-conversation/lib/client.js
  // （升级快照时需对照重放）。
  useEffect(() => {
    const STYLE_ID = 'dsh-femwa-proj-mother-name'
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
    if (style === null) {
      style = document.createElement('style')
      style.id = STYLE_ID
      document.head.appendChild(style)
    }
    style.textContent = typeof sessionId === 'string' && sessionId.startsWith('fem-proj-')
      ? '.c-Z2Na_crumbs .c-Z2Na_crumbSeg:first-child .c-Z2Na_crumb { color: var(--dsw-alias-label-primary); pointer-events: none; }'
      : ''
    return () => { style.textContent = '' }
  }, [sessionId])

  // 标签页跟手·消费端（2026-08-24）：本组件挂在每个 fem 家族窗口的头部，
  // 视角跳转的目标窗口挂载时从这里消费一次性标记——把激活 tab 对齐到「切
  // 换前」所在的一侧。轮询至多 ~2s 等 tab 环渲染；已一致则不点击（不多写
  // 一次持久化 view）。过期/超时一律清标记自愈。
  useEffect(() => {
    // 非 fem 家族窗口不消费（mainSid undefined = 普通会话/子代理）：防止
    // openSession 失败后 5s 内手动切到普通会话时误触发转移。
    if (pendingTabTransfer === null || mainSid === undefined) return
    const { kind, expiresAt } = pendingTabTransfer
    if (Date.now() > expiresAt) {
      pendingTabTransfer = null
      return
    }
    const wanted = kind === 'editor' ? [FEM_EDITOR_TAB_LABEL] : CHAT_TAB_LABELS
    let tries = 0
    const timer = window.setInterval(() => {
      tries += 1
      // 只认可见 tab（offsetParent null = display:none，如普通会话上被隐藏
      // 的「Fem 编辑器」按钮——不可见就不算候选，避免点中隐藏按钮）。
      const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
        .filter(el => el.offsetParent !== null)
      const selected = tabs.find(el => el.getAttribute('aria-selected') === 'true')
      if (selected !== undefined && wanted.includes(selected.textContent ?? '')) {
        window.clearInterval(timer)
        pendingTabTransfer = null
        return
      }
      const target = tabs.find(el => wanted.includes(el.textContent ?? ''))
      if (target !== undefined) {
        target.click()
        window.clearInterval(timer)
        pendingTabTransfer = null
        return
      }
      if (tries >= 20) {
        window.clearInterval(timer)
        pendingTabTransfer = null
      }
    }, 100)
    return () => { window.clearInterval(timer) }
  }, [sessionId])

  const { chatActors, hidden } = useMemo(() => {
    const actors = new Set<string>()
    let hiddenCount = 0
    for (const node of (snapshot.chat?.nodes?.values() ?? [])) {
      if (node.kind !== 'femwa-role') continue
      const data = node.data as FemwaChatData | undefined
      if (data === undefined) continue
      if (data.actor !== undefined && data.actor.length > 0) actors.add(data.actor)
      if (view === 'god') continue
      // sys 运行回执：所有视角都显示（offstage 也放行），不计入隐藏数。
      if (data.kind === 'sys') continue
      // offstage：femwa 行全隐藏，计数=全部。
      if (view === 'offstage' || data.kind === 'notice' || data.kind === 'error' || data.kind === 'thinking') {
        hiddenCount += 1
        continue
      }
      if (data.visible !== undefined && !data.visible.includes(view)) hiddenCount += 1
    }
    return { chatActors: [...actors], hidden: hiddenCount }
  }, [snapshot, view])

  const actors = scriptActors.length > 0 ? scriptActors : chatActors
  // Fem 主会话与 Fem 投影窗都显示视角菜单（投影窗上=同一份剧的视角切换）；
  // 普通子代理/非 fem 会话 mainSid 为空 → 不渲染，完全不受影响。
  if (mainSid === undefined) return null
  // 视角栏显示「当前所处视角」：从当前窗口直接推导，而非查 viewBySession
  // 记录——投影窗自身没有记录（pickView 写在 mainSid 名下），查记录会永远
  // 落到默认值（2026-08-23 bug：诗人窗上仍显示"上帝视角"）。
  //   主会话 → 已存储的视角（无记录=offstage，与 currentView 默认一致）；
  //   god 投影窗 → 'god'；角色投影窗 → 反查 proj.actors 得角色名；
  //   映射未就绪的 fem-proj-* 窗 → 兜底 'god'。
  const activeViewId = ((): string | undefined => {
    if (mainSid === sessionId) {
      const stored = sessionId === undefined ? undefined : viewBySession.get(sessionId)
      return stored ?? 'offstage'
    }
    if (sessionId === proj.god) return 'god'
    for (const [name, winId] of Object.entries(proj.actors)) {
      if (winId === sessionId) return name
    }
    return typeof sessionId === 'string' && sessionId.startsWith('fem-proj-') ? 'god' : undefined
  })()
  const label = activeViewId === 'god' ? '上帝视角'
    : activeViewId === 'offstage' ? '戏外 · 主模型'
    : activeViewId ?? '上帝视角'
  const menu = open
    ? (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: '0',
          minWidth: '160px',
          maxHeight: '300px',
          overflowY: 'auto',
          background: 'var(--dsw-surface-1, #fff)',
          border: '1px solid var(--dsw-border, #ddd)',
          borderRadius: '8px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          padding: '4px',
          zIndex: 100,
          fontSize: '13px',
        }}>
          {[
            { id: 'offstage', label: '戏外 · 主模型', Icon: FaRobot },
            { id: 'god', label: '上帝视角', Icon: FaPodcast },
            ...actors.map(actor => ({ id: actor, label: actor, Icon: FaUserSecret })),
          ].map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => { pickView(item.id) }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '7px',
                width: '100%',
                padding: '6px 10px',
                border: 'none',
                borderRadius: '6px',
                background: item.id === activeViewId ? 'var(--dsw-accent, #4a9eff)' : 'transparent',
                color: item.id === activeViewId ? '#fff' : 'var(--dsw-text-primary, #222)',
                cursor: 'pointer',
                textAlign: 'left',
                whiteSpace: 'nowrap',
              }}
            >
              <item.Icon size={14} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )
    : null
  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={activeViewId === 'god' ? '上帝视角：显示全部消息' : activeViewId === 'offstage' ? '戏外 · 主模型' : `角色视角：仅显示 ${activeViewId} 可见的消息`}
        onClick={() => { setOpen(value => !value) }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          border: 'none',
          background: 'transparent',
          padding: 0,
          color: 'var(--dsw-alias-label-primary, #222)',
          cursor: 'pointer',
          fontSize: '12px',
          whiteSpace: 'nowrap',
        }}
      >
        <FaEye size={12} />
        <span>{label}</span>
        {view !== 'god' && hidden > 0 && <span style={{ opacity: 0.75 }}>· 隐藏{hidden}</span>}
        <span style={{ display: 'inline-flex', alignItems: 'center', transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 150ms ease' }}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {menu}
    </div>
  )
}

/** Fem 主会话的子代理计数菜单（actions 尾部座位）：复用 fork 的 CatalogDropdown
 *  count 变体 + showRunning 运行数文本。归属判定与 FemViewButton 的 mainSid
 *  同源——只有站在 Fem 主会话本体时渲染；投影窗（子会话的 count 属于其母窗口）
 *  与普通会话返回 null，不受影响。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function FemSubagentCount({ useSession, useSessions, openChild, refresh, setCatalogOpen, t }: any) {
  const sessionId = useSession((s: { sessionId?: string }) => s.sessionId) as string | undefined
  const mainSid = useSessions((state): string | undefined => {
    if (typeof sessionId !== 'string') return undefined
    const summary = state.byId[sessionId]
    if (summary?.agentPreset === 'dsh-femwa' && summary?.parentId === undefined) return sessionId
    return undefined
  })
  if (mainSid === undefined) return null
  return (
    <CatalogDropdown
      rootSessionId={mainSid}
      variant="count"
      showRunning
      hideWhenZero
      useSessions={useSessions}
      openChild={openChild}
      refresh={refresh}
      setCatalogOpen={setCatalogOpen}
      t={t}
    />
  )
}

// ── fem-stream 样式表（一次性注入）─────────────────────────────────────────
// 官方 ReasoningRow.module.css 的 .fem-rr-* 转写（--dsw-alias-* token 同款，
// 浅色/深色自适应；rc 升级需对照重放）+ 直播容器与光标。不走 css module
// （构建链不注入插件侧 css），沿用母名黑化的 style 元素路线。
const FEM_STREAM_CSS = `
.fem-stream-root{display:flex;flex-direction:column;margin:2px 0 10px}
.fem-stream-toolline{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:2px 0}
.fem-stream-caret{display:inline-block;width:8px;height:15px;margin-top:2px;background:var(--dsw-alias-label-secondary,#888);animation:fem-caret-blink 1s steps(2,start) infinite}
@keyframes fem-caret-blink{50%{opacity:0}}
.fem-rr-root{display:flex;flex-direction:column}
.fem-rr-row{position:relative;overflow:hidden}
.fem-rr-root[data-state='running'] .fem-rr-row::after{content:'';position:absolute;inset-block:0;left:0;width:300px;background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 60%,transparent) 55%,transparent 100%);animation:fem-rr-sweep 2.6s ease-out infinite;pointer-events:none}
@keyframes fem-rr-sweep{0%{left:-300px}90%,100%{left:100%}}
.fem-rr-leading{flex-shrink:0}
.fem-rr-chevron{color:var(--dsw-alias-label-secondary)}
.fem-rr-title{font-weight:400}
.fem-rr-separator{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}
.fem-rr-summary{min-width:0;overflow:hidden;flex:1 1 auto;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;text-overflow:ellipsis;white-space:nowrap}
.fem-rr-summary[data-follow-end]{text-overflow:clip}
.fem-rr-think-body{padding:4px 0 4px 22px;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;white-space:pre-wrap;word-break:break-word}
.fem-a11y-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.fem-rr-root[data-state='running'] .fem-rr-row::after{animation:none}}
`

function ensureFemStreamStyles(): void {
  if (document.getElementById('fem-stream-style') !== null) return
  const el = document.createElement('style')
  el.id = 'fem-stream-style'
  el.textContent = FEM_STREAM_CSS
  document.head.appendChild(el)
}

// ── plugin body ───────────────────────────────────────────────────────────

/**
 * Browser plugin body: register the chat node and the footer action.
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

// ── 投影窗 composer（角色/上帝视角的可输入输入框）────────────────────────
// dsh 对 origin=subagent 会话默认挂 SubagentReadOnlyComposer（只读）；
// 投影窗（fem-proj-*）需要可输入。输入 → POST /dsh-femwa/projection-input，
// 由 host 按运行状态路由（2026-08-24 定稿）：剧本未跑→steer 直达主模型；
// 人类节点等待→喂引擎 wait_key；跑本中其他时候→本窗留痕（插话待实现）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ProjectionComposer({ useSession }: any) {
  const sessionId = useSession((s: { sessionId?: string }) => s.sessionId) as string | undefined
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = (): void => {
    const value = text.trim()
    if (value.length === 0 || busy || sessionId === undefined) return
    setBusy(true)
    void fetch('/dsh-femwa/projection-input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, text: value }),
    })
      .then(response => response.json())
      .then((data: { ok?: boolean }) => {
        if (data.ok === true) setText('')
      })
      .catch(() => { /* 保持输入，不丢草稿 */ })
      .finally(() => setBusy(false))
  }
  return (
    <div style={{
      display: 'flex',
      gap: '8px',
      padding: '10px 16px 12px',
      maxWidth: 'calc(var(--dsh-chat-content-width, 748px) + 32px)',
      margin: '0 auto',
      width: '100%',
      boxSizing: 'border-box',
    }}>
      <textarea
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
        rows={1}
        spellCheck={false}
        style={{
          flex: 1,
          padding: '8px 12px',
          border: '1px solid var(--dsw-border, #ddd)',
          borderRadius: '10px',
          background: 'var(--dsw-surface-2, #f5f5f5)',
          color: 'var(--dsw-text-primary, #222)',
          fontSize: '13px',
          lineHeight: 1.5,
          resize: 'none',
          fontFamily: 'inherit',
          boxSizing: 'border-box',
          minHeight: '36px',
        }}
      />
      <button
        type="button"
        onClick={submit}
        disabled={busy || text.trim().length === 0}
        style={{
          padding: '0 16px',
          border: 'none',
          borderRadius: '10px',
          background: 'var(--dsw-accent, #4a9eff)',
          color: '#fff',
          cursor: 'pointer',
          fontSize: '13px',
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        发送
      </button>
    </div>
  )
}

