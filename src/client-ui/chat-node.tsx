/**
 * client-ui/chat-node.tsx — dsh-femwa/chat 会话节点（定义 + 渲染视图）。
 *
 * 每个 dsh-femwa/chat 事件渲染为一行聊天：speaker 名字行（兼流式直播锚点）、
 * role 气泡、notice/sys 居中灰字、prompt 舞台提示条、human_wait 高亮框、
 * error 红行、tool_call 单行摘要。视角过滤（offstage/god/角色 scope）在
 * 渲染层完成。
 * （2026-08-26 结构整理自 client.tsx 原样迁出，行为零变化。）
 */

import { useMemo } from 'react'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { EMPTY_FEM_BLOCKS, femProjectionActorKey, useFemStream } from './stream-store'
import { FemStreamLive, FemTurnStatus, openTurnInfo } from './fem-stream-live'
import { useView } from './view-state'

/** One rendered dsh-femwa/chat line. */
export interface FemwaChatData {
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
export const femwaChatDefinition: ConversationNodeDefinition<FemwaChatData> = {
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
  const liveBlocks = streamEligible && lastSpeakerKeys.get(actor ?? '') === node.key
    ? liveBlocksRaw
    : EMPTY_FEM_BLOCKS
  // Deep diving 对齐官方语义（2026-08-26）：窗口存在 open turn（演出进行中，
  // 含等待首 token/工具执行间隙）即显示，整个 turn 结束才消失——不再依赖
  // 直播块有无（此前流式间隙会闪断）。挂在该演员最新名字行下；hooks 全部
  // 前置（早退过滤之前），与文件既有纪律一致。
  const timeline = chat.timeline
  const { hasOpen: hasOpenTurn, startTime: openTurnStart } = useMemo(() => openTurnInfo(timeline), [timeline])
  // 流尾判定（与 director-node 同款修复）：锚点被后续内容节点（正文气泡/
  // 工具卡片）越过时状态行不再挂在半中间；直播块仍在时豁免（打字机正画在
  // 名字行下，状态行与它同生同灭）。
  const isFlowTail = useMemo(
    () => chat.order[chat.order.length - 1] === node.key,
    [chat, node.key],
  )
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
    // Deep diving 状态行同样挂最新名字行下、open turn 全程显示（对齐官方
    // "rides the whole running turn"）；无直播无演出时与历史形态完全一致。
    const isLatestSpeaker = lastSpeakerKeys.get(actor ?? '') === node.key
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
        {liveBlocks.length > 0 && <FemStreamLive blocks={liveBlocks} t={t} />}
        {streamEligible && isLatestSpeaker && hasOpenTurn && (isFlowTail || liveBlocks.length > 0)
          && <FemTurnStatus startTime={openTurnStart} />}
      </div>
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
