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

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import FEMEditor from '../femGen/src/FemWorAuto'

/** Peer packages this plugin needs injected. */
export const inject: string[] = ['slots', 'conversationEvents', 'sessions', 'workspaces']

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
}

type FemScriptViewProps = { sessionId: string } & ScriptViewInjected

/** 画布可视化编辑器（femGen 插件模式）：取代文本编辑标签页。
 *  onRun 把画布生成的 .fems 直接交给插件 run 路由（不落盘），
 *  与聊天窗角色气泡是同一次引擎运行；SSE 事件流由 femGen 内部连接。
 *  挂载时读取会话状态（剧本快照 + 断点）用于恢复画布与「继续」按钮。 */
export function FemEditorView({ sessionId, stopScript }: FemScriptViewProps) {
  const [state, setState] = useState<{
    hasScript: boolean
    script?: string
    checkpoint: Record<string, string>
    running?: boolean
  } | null>(null)

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

  useEffect(() => {
    let cancelled = false
    void fetch(`/dsh-femwa/session-state?sessionId=${encodeURIComponent(sessionId)}`)
      .then(response => response.json())
      .then((data: { ok?: boolean; script?: string; checkpoint?: Record<string, string>; running?: boolean }) => {
        if (!cancelled && data.ok === true) {
          setState({
            hasScript: data.script !== undefined,
            script: data.script,
            checkpoint: data.checkpoint ?? {},
            running: data.running === true,
          })
        }
      })
      .catch(() => { /* 编辑器仍可空白启动 */ })
    return () => { cancelled = true }
  }, [sessionId])

  // 断点位置：主流程分支优先，其次任一分支（画布按节点 label 匹配）。
  const checkpointNode = state === null
    ? undefined
    : state.checkpoint['__main__'] ?? Object.values(state.checkpoint)[0]

  // 画布编辑的实时快照写（femGen 防抖调用）：刷新/重启后按会话恢复。
  const onSnapshot = (fems: string): void => {
    void fetch('/dsh-femwa/session-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, fems }),
    }).catch((error: unknown) => {
      console.warn('[dsh-femwa] snapshot write failed:', error)
    })
  }

  const onRun = async (fems: string, opts?: { reset?: boolean }): Promise<void> => {
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
  return (
    // data-conversation-composer-overlay：dsh 本体 CSS 据此给 viewArea
    // 确定高度（flex: 1 1 0 + min-height: 0 + overflow: hidden，trajectory
    // 同款机制），否则 FEMEditor 的 height:100% 解析失败、内容撑开使整个
    // 页面可无限下拉。标记随本视图卸载自动撤销。
    <div data-conversation-composer-overlay="" style={{ height: '100%' }}>
      <FEMEditor
        plugin
        onRun={onRun}
        onStop={onStop}
        onSnapshot={onSnapshot}
        initialScript={state?.script}
        initialCheckpoint={checkpointNode}
        initialRunning={state?.running === true}
      />
    </div>
  )
}

/** Full-size panel: browse, paste/edit, save, and run Fem scripts. */
export function FemScriptView({ sessionId, listScripts, readScript, saveScript, runScript, stopScript, fetchErrors }: FemScriptViewProps) {
  const [scripts, setScripts] = useState<string[]>([])
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Array<{ ts: number; text: string }>>([])
  const [runError, setRunError] = useState<string | null>(null)

  const refreshErrors = (): void => {
    void fetchErrors(sessionId).then(setErrors).catch((error: unknown) => {
      console.warn('[dsh-femwa] fetch errors failed:', error)
    })
  }

  useEffect(() => {
    refreshErrors()
    const timer = window.setInterval(refreshErrors, 5000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const refresh = (): void => {
    void listScripts().then(setScripts).catch((error: unknown) => {
      console.warn('[dsh-femwa] list scripts failed:', error)
      setScripts([])
    })
  }

  useEffect(refresh, [listScripts])

  const pick = (path: string): void => {
    setSelected(path)
    setName(path.split(/[\\/]/).pop()?.replace(/\.fems$/i, '') ?? '')
    void readScript(path).then((text) => { setContent(text) }).catch((error: unknown) => {
      console.warn('[dsh-femwa] read script failed:', error)
      setContent('')
    })
  }

  const run = (): void => {
    if (busy) return
    setBusy(true)
    setRunError(null)
    const target = selected
    const saveThenRun = target === undefined || name.trim() !== (selected?.split(/[\\/]/).pop()?.replace(/\.fems$/i, '') ?? '')
    const proceed = saveThenRun
      ? saveScript(name.trim() || 'unnamed', content)
      : Promise.resolve(target)
    void proceed
      .then((path) => runScript(sessionId, path))
      .catch((error: unknown) => {
        console.warn('[dsh-femwa] save/run script failed:', error)
        setRunError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => { setBusy(false) })
  }

  const inputStyle: CSSProperties = {
    padding: '8px',
    border: '1px solid var(--dsw-border, #ddd)',
    borderRadius: '6px',
    background: 'var(--dsw-surface-2, #f5f5f5)',
    color: 'var(--dsw-text-primary, #222)',
    fontSize: '12px',
    fontFamily: 'monospace',
    lineHeight: 1.5,
    boxSizing: 'border-box',
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: '300px',
      gap: '10px',
      padding: '12px 16px',
      boxSizing: 'border-box',
    }}>
      <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--dsw-text-primary, #222)' }}>
        Fem 剧本
        <span style={{ fontWeight: 400, fontSize: '12px', color: 'var(--dsw-text-tertiary, #999)', marginLeft: '8px' }}>
          剧本是会话的元配置（一段 .fems 文本），不是聊天消息
        </span>
      </div>
      <div style={{ display: 'flex', gap: '10px', flex: 1, minHeight: 0 }}>
        {/* left: script list */}
        <div style={{
          width: '220px',
          border: '1px solid var(--dsw-border, #ddd)',
          borderRadius: '8px',
          overflowY: 'auto',
          padding: '4px',
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
        }}>
          <button
            type="button"
            onClick={() => { setSelected(undefined); setName(''); setContent('') }}
            style={{
              padding: '6px 10px',
              border: 'none',
              borderRadius: '6px',
              background: selected === undefined ? 'var(--dsw-accent, #4a9eff)' : 'transparent',
              color: selected === undefined ? '#fff' : 'var(--dsw-text-secondary, #666)',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: '13px',
            }}
          >
            ✏️ 新建/粘贴剧本
          </button>
          {scripts.map((path) => {
            const label = path.split(/[\\/]/).pop() ?? path
            return (
              <button
                key={path}
                type="button"
                onClick={() => pick(path)}
                title={path}
                style={{
                  padding: '6px 10px',
                  border: 'none',
                  borderRadius: '6px',
                  background: selected === path ? 'var(--dsw-accent, #4a9eff)' : 'transparent',
                  color: selected === path ? '#fff' : 'var(--dsw-text-primary, #222)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: '13px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {label}
              </button>
            )
          })}
          {scripts.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: '12px', color: 'var(--dsw-text-tertiary, #999)' }}>
              未找到剧本。可粘贴新剧本，或放到 user_data/projects 下。
            </div>
          )}
        </div>
        {/* right: editor + actions */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="剧本名称（保存为 .fems 文件）"
              style={{ ...inputStyle, flex: 1, fontFamily: 'inherit', fontSize: '13px' }}
            />
            <button
              type="button"
              onClick={refresh}
              style={{
                padding: '6px 12px',
                border: '1px solid var(--dsw-border, #ddd)',
                borderRadius: '6px',
                background: 'transparent',
                color: 'var(--dsw-text-secondary, #666)',
                cursor: 'pointer',
                fontSize: '13px',
              }}
            >
              刷新列表
            </button>
            <button
              type="button"
              onClick={() => {
                setBusy(true)
                setRunError(null)
                void stopScript()
                  .catch((error: unknown) => {
                    console.warn('[dsh-femwa] stop failed:', error)
                    setRunError(error instanceof Error ? error.message : String(error))
                  })
                  .finally(() => { setBusy(false) })
              }}
              style={{
                padding: '6px 14px',
                border: '1px solid color-mix(in srgb, #e5484d 60%, transparent)',
                borderRadius: '6px',
                background: 'transparent',
                color: '#e5484d',
                cursor: 'pointer',
                fontSize: '13px',
              }}
            >
              ⏹ 停止
            </button>
            <button
              type="button"
              disabled={busy || name.trim().length === 0 || content.trim().length === 0}
              onClick={run}
              style={{
                padding: '6px 14px',
                border: 'none',
                borderRadius: '6px',
                background: 'var(--dsw-accent, #4a9eff)',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '13px',
              }}
            >
              {busy ? '运行中…' : '保存并运行'}
            </button>
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.currentTarget.value)}
            placeholder={'粘贴或编辑 .fems 剧本内容…\n\nmeta:\n  name = 我的剧本\n  session = new\n\nactors:\n  ai @Eve = soul:the1stlittlesoul\n\naction speak @ai(@Eve):\n  prompt: 说句话\n\nmainflow:\n  [START] -> speak -> [END]'}
            spellCheck={false}
            style={{ ...inputStyle, flex: 1, resize: 'none' }}
          />
          <div style={{ fontSize: '12px', color: 'var(--dsw-text-tertiary, #999)' }}>
            保存的剧本会出现在列表和侧边栏菜单中；「保存并运行」会在<strong>当前会话</strong>播放（当前会话需为 Fem 剧本模式）。
          </div>
          {runError !== null && (
            <div style={{
              border: '1px solid color-mix(in srgb, #e5484d 40%, transparent)',
              borderRadius: '8px',
              background: 'color-mix(in srgb, #e5484d 8%, transparent)',
              padding: '8px 12px',
              color: '#e5484d',
              fontSize: '12px',
            }}>
              {runError}
            </div>
          )}
          {errors.length > 0 && (
            <div style={{
              border: '1px solid color-mix(in srgb, #e5484d 40%, transparent)',
              borderRadius: '8px',
              background: 'color-mix(in srgb, #e5484d 8%, transparent)',
              padding: '8px 12px',
              maxHeight: '140px',
              overflowY: 'auto',
            }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#e5484d', marginBottom: '4px' }}>
                ⚠ 运行错误（元信息，不进入聊天记录）
              </div>
              {errors.map((err, i) => (
                <div key={i} style={{
                  fontSize: '12px',
                  color: 'var(--dsw-text-secondary, #666)',
                  fontFamily: 'monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  marginBottom: '4px',
                }}>
                  {new Date(err.ts).toLocaleTimeString()} — {err.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── dsh-femwa/chat node ───────────────────────────────────────────────────

/** One rendered dsh-femwa/chat line. */
interface FemwaChatData {
  readonly actor?: string
  readonly text: string
  readonly kind: 'role' | 'notice' | 'human_wait' | 'prompt' | 'error' | 'thinking' | 'tool_call' | 'speaker'
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
  return sessionId === undefined ? 'god' : (viewBySession.get(sessionId) ?? 'god')
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
export function FemwaChatNodeView({ node, useSession }: ChatNodeViewProps<'femwa-role'>) {
  const { actor, text, kind, visible } = node.data
  const sessionId = useSession(snapshot => snapshot.sessionId)
  const view = useView(sessionId)
  // View-perspective filter: in a role view, meta lines (notice/error/
  // thinking) are god-only, and dialogue lines show only when the actor's
  // scope includes this viewer. Absent `visible` = visible to everyone.
  if (view !== 'god') {
    if (kind === 'notice' || kind === 'error' || kind === 'thinking' || kind === 'tool_call') return null
    // speaker 名字行不做 scope 过滤：角色视角也能看到所有角色的名字
    // （内容 turn 由 CSS 按视角隐藏，名字作为对话流的"演员表"保留）。
    if (kind !== 'speaker' && visible !== undefined && !visible.includes(view)) return null
  }
  if (kind === 'speaker') {
    // 子代理 turn 首行：发言者名字；cot/工具调用/回答从下一行开始。
    return (
      <div style={{
        margin: '8px 0 2px',
        fontWeight: 700,
        fontSize: '12.5px',
        color: actorColor(actor ?? 'AI'),
      }}>
        {actor ?? 'AI'}
      </div>
    )
  }
  if (kind === 'thinking') {
    // Folded thinking chain (subagent cot). Display-only; memory storage
    // already filtered it by the tool-call rule.
    return (
      <details style={{
        margin: '2px 0',
        fontSize: '12px',
        color: 'var(--dsw-text-tertiary, #999)',
      }}>
        <summary style={{ cursor: 'pointer', userSelect: 'none', outline: 'none' }}>
          💭 思考（点击展开）
        </summary>
        <div style={{
          marginTop: '4px',
          padding: '6px 10px',
          borderRadius: '6px',
          background: 'var(--dsw-surface-2, #f5f5f5)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: 1.5,
        }}>
          {text}
        </div>
      </details>
    )
  }
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
        color: '#e5484d',
        fontSize: '12px',
        padding: '4px 0',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {text}
      </div>
    )
  }
  if (kind === 'notice') {
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

/** Session-header action: switch between god view and per-actor views. */
export function FemViewButton({ useSession, useSessions }: PropsRuntime<'conversation.session.header.actions'>) {
  const sessionId = useSession(snapshot => snapshot.sessionId)
  const view = useView(sessionId)
  const [open, setOpen] = useState(false)
  // The button lives on Fem sessions only: the sessions list records the
  // preset each session's agent was composed from (agent-preset/selected
  // keeps it current after a runtime switch), so the menu is ready from boot
  // for existing Fem sessions and never appears on other modes.
  const isFem = useSessions(state => state.byId[sessionId]?.agentPreset === 'dsh-femwa')

  // 非 Fem 会话：隐藏「Fem 编辑器」标签页。tab 列表 = conversation.view
  // 的全部注册条目（无按会话过滤的钩子），纯插件方案在 header 挂载时
  // DOM 隐藏该按钮；本组件随会话切换重挂载，Fem 会话恢复显示。
  useEffect(() => {
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find(el => el.textContent === 'Fem 编辑器')
    if (tab === undefined) return
    tab.style.display = isFem ? '' : 'none'
    return () => { tab.style.display = '' }
  }, [isFem])
  // Script actors from the host (complete after a run) — the menu's source of
  // truth; chat-line actors below only backfill before the first run.
  const [scriptActors, setScriptActors] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    void fetch(`/dsh-femwa/actors?sessionId=${encodeURIComponent(sessionId ?? '')}`)
      .then(response => response.json())
      .then((data: { ok?: boolean; actors?: string[] }) => {
        if (!cancelled && data.ok === true && data.actors !== undefined && data.actors.length > 0) {
          setScriptActors(data.actors)
        }
      })
      .catch(() => { /* menu falls back to actors seen in chat */ })
    return () => { cancelled = true }
  }, [sessionId])

  const snapshot = useSession(s => s)

  // ── 视角过滤（显示层 CSS）：host 记录镜像 turn → scope 映射，god 全显示；
  // 角色视角 CSS 隐藏 scope 不含该角色的原生 turn。镜像始终全量（信息完整
  // 落盘），过滤只影响显示，切换视角不丢任何内容。
  const [turnScopes, setTurnScopes] = useState<Record<string, string[]>>({})
  const turnCount = snapshot.turnTimings.size
  useEffect(() => {
    if (!isFem || sessionId === undefined) return
    let cancelled = false
    void fetch(`/dsh-femwa/turn-scopes?sessionId=${encodeURIComponent(sessionId)}`)
      .then(response => response.json())
      .then((data: { ok?: boolean; scopes?: Record<string, string[]> }) => {
        if (!cancelled && data.ok === true && data.scopes !== undefined) setTurnScopes(data.scopes)
      })
      .catch(() => { /* 视角过滤降级为全显示（信息不丢） */ })
    return () => { cancelled = true }
  }, [sessionId, turnCount, isFem])

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

  const { chatActors, hidden } = useMemo(() => {    const actors = new Set<string>()
    let hiddenCount = 0
    for (const node of snapshot.nodes) {
      if (node.kind !== 'femwa-role') continue
      const data = node.data as FemwaChatData | undefined
      if (data === undefined) continue
      if (data.actor !== undefined && data.actor.length > 0) actors.add(data.actor)
      if (view === 'god') continue
      if (data.kind === 'notice' || data.kind === 'error' || data.kind === 'thinking') {
        hiddenCount += 1
        continue
      }
      if (data.visible !== undefined && !data.visible.includes(view)) hiddenCount += 1
    }
    return { chatActors: [...actors], hidden: hiddenCount }
  }, [snapshot, view])

  const actors = scriptActors.length > 0 ? scriptActors : chatActors
  // Fem sessions only: the menu is ready from boot on existing Fem sessions
  // (roles backfilled from chat lines) and never shows on other modes, even
  // after a run populated the host's actor cache.
  if (!isFem) return null
  const label = view === 'god' ? '上帝视角' : view
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
          {[{ id: 'god', label: '👁 上帝视角' }, ...actors.map(actor => ({ id: actor, label: actor }))].map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setOpen(false)
                setView(sessionId, item.id)
              }}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 10px',
                border: 'none',
                borderRadius: '6px',
                background: item.id === view ? 'var(--dsw-accent, #4a9eff)' : 'transparent',
                color: item.id === view ? '#fff' : 'var(--dsw-text-primary, #222)',
                cursor: 'pointer',
                textAlign: 'left',
                whiteSpace: 'nowrap',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )
    : null
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={view === 'god' ? '上帝视角：显示全部消息' : `角色视角：仅显示 ${view} 可见的消息`}
        onClick={() => { setOpen(value => !value) }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          padding: '2px 8px',
          border: '1px solid var(--dsw-border, #ddd)',
          borderRadius: '999px',
          background: 'transparent',
          color: view === 'god' ? 'var(--dsw-text-secondary, #666)' : 'var(--dsw-accent, #4a9eff)',
          cursor: 'pointer',
          fontSize: '12px',
          whiteSpace: 'nowrap',
        }}
      >
        <span aria-hidden>👁</span>
        <span>{label}</span>
        {view !== 'god' && hidden > 0 && <span style={{ opacity: 0.75 }}>· 隐藏{hidden}</span>}
      </button>
      {menu}
    </div>
  )
}

// ── plugin body ───────────────────────────────────────────────────────────

/**
 * Browser plugin body: register the chat node and the footer action.
 * @param ctx - client root context.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  const slots = ctx?.get?.('slots') ?? ctx?.slots
  if (slots === undefined || typeof slots.inject !== 'function') {
    console.warn('[dsh-femwa] slots service unavailable; UI not registered')
    return
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conversationEvents = ctx?.get?.('conversationEvents') as { register(def: unknown): void } | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessions = ctx?.get?.('sessions') as { open?(id: string): void } | undefined
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
      const response = await fetch('/dsh-femwa/save-script', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, content }),
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
    },
    FemwaChatNodeView,
  ))
  slots.inject('conversation.session.header.actions', () => slots.register(
    {
      name: 'conversation.session.header.actions',
      id: 'dsh-femwa-view',
      order: 10,
    },
    FemViewButton,
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
}
