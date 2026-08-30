/**
 * client-ui/turn-nodes.tsx — turn 级「段落头名字 + 流尾直播」双节点（2026-08-30 V5）。
 *
 * 架构背景：dsh chat 流 = 纯 anchorSeq 平面排序（ChatView 直接 order.map，无组
 * 容器），且 assistant 内容节点的 anchorSeq 会漂移（流式中 = 首块 seq，settled
 * 后 = message seq）——任何固定 seq 的独立行都无法恒定贴住自己的内容段落
 * （V1~V3.1 四轮「改这里错那里」循环的病根）。本文件照官方 TurnTail（组尾行）
 * 的成熟机制做镜像：definition 的 Context 跟随整个 turn 的全部事件（turn/start
 * 开启、内容事件 update），anchor 每次发布动态重算——内容漂移，两节点跟着漂移。
 *
 * ① fem-turn-head（段落头名字）：anchor = turn 内首个 assistant 内容事件
 *    seq − 0.5，恒在自己段落所有内容节点之前。actor 数据源 = host 落盘的
 *    speaker 事件（data.turn 显式归属，物理 seq 位置无关）。
 * ② fem-turn-stream（流尾直播）：anchor = 最新 transcript 事件 seq + 0.1
 *    （TurnTail closingAnchor 同款算法），恒在流尾。渲染直播桶（useFemStream
 *    SSE 缓冲，零落盘）+ Deep diving（turn open 时，官方「骑整个 running
 *    turn」语义）。取代旧「每 step 一个 stream-host 锚」方案。
 *
 * 历史兼容：无 turn 字段的旧 speaker / 旧 stream-host 行仍由 femwaChat 处理
 * （speaker 渲染名字、stream-host 按原条件渲染 null），本文件只接手新版数据。
 */

import { useMemo } from 'react'
import type { ConversationNodeDefinition, ConversationNodeContext, ConversationMatch } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useFemStream, femProjectionActorKey } from './stream-store'
import { FemStreamLive, FemTurnStatus } from './fem-stream-live'
import { useView } from './view-state'
import { actorColor } from './chat-node'

/** fem-turn-head 渲染载荷：段落头名字行。 */
export interface FemTurnHeadData {
  readonly actor: string
  readonly turn: number
}

/** fem-turn-stream 渲染载荷：流尾直播位。 */
export interface FemTurnStreamData {
  readonly actor: string
  readonly turn: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'fem-turn-head': FemTurnHeadData
    'fem-turn-stream': FemTurnStreamData
  }
}

interface FemTurnNodeState {
  readonly turn: number
  readonly actor?: string
}

/** 事件是否携带本插件镜像流的标准 turn 坐标（缺失 = 与 turn 无关，不跟随）。 */
function turnCoordinateOf(event: ConversationMatch['event']): number | undefined {
  if (event.type === 'turn/start') return event.data.turn
  if (event.type === 'dsh-femwa/chat') {
    const d = event.data as { kind?: unknown; turn?: unknown }
    if (d.kind !== 'speaker') return undefined
    return typeof d.turn === 'number' ? d.turn : undefined
  }
  if (event.type === 'assistant/chunk' || event.type === 'assistant/message'
    || event.type === 'tool/call' || event.type === 'tool/result'
    || event.type === 'step/start' || event.type === 'step/end') {
    const turn = (event.data as { turn?: unknown }).turn
    return typeof turn === 'number' ? turn : undefined
  }
  return undefined
}

/** 两个 definition 共用的 match：整个 turn 的骨架/内容/名字事件都进同一 Context。 */
function matchTurnEvent(event: ConversationMatch['event']):
  { id: string; role: 'start' | 'update' } | null {
  const turn = turnCoordinateOf(event)
  if (turn === undefined) return null
  return { id: String(turn), role: event.type === 'turn/start' ? 'start' : 'update' }
}

function startTurnState(_context: unknown, match: ConversationMatch): FemTurnNodeState {
  return { turn: (match.event.data as { turn: number }).turn }
}

function updateTurnState(context: ConversationNodeContext<FemTurnNodeState>, match: ConversationMatch): FemTurnNodeState {
  if (match.event.type === 'dsh-femwa/chat') {
    const d = match.event.data as { kind?: unknown; actor?: unknown }
    const actor = typeof d.actor === 'string' && d.actor.length > 0 ? d.actor : undefined
    if (actor !== undefined) return { turn: context.state?.turn ?? 0, actor }
  }
  return context.state ?? { turn: 0 }
}

/**
 * head anchor：turn 内首个 assistant 内容事件（块边界或 message）seq − 0.5。
 * running 中的 assistant 节点 anchorSeq = 首块 seq，settled 后 = message seq
 * （两者都 ≥ 首块 seq）——head 恒在其前，不随漂移脱钩。turn 尚无内容时回退
 * turn/start seq + 0.5（紧跟骨架，名字先出现，内容到达后吸附）。
 */
function headAnchor(context: ConversationNodeContext<FemTurnNodeState>): number {
  const startSeq = context.start?.event.seq
  let min = Number.POSITIVE_INFINITY
  for (const match of context.matches) {
    const type = match.event.type
    if (type === 'assistant/chunk' || type === 'assistant/message') {
      if (match.event.seq < min) min = match.event.seq
    }
  }
  if (min === Number.POSITIVE_INFINITY) return startSeq !== undefined ? startSeq + 0.5 : 0
  return min - 0.5
}

/**
 * stream anchor：turn 内最新 transcript 事件（块边界/message/tool）seq + 0.1。
 * 与官方 TurnTail closingAnchor 同款思路——恒在该 turn 已落地内容之后（流尾）。
 * turn 尚无内容时回退 turn/start seq + 0.6（head 之后：名字 → 直播位）。
 */
function streamAnchor(context: ConversationNodeContext<FemTurnNodeState>): number {
  const startSeq = context.start?.event.seq
  let max = Number.NEGATIVE_INFINITY
  for (const match of context.matches) {
    const type = match.event.type
    if (type === 'assistant/chunk' || type === 'assistant/message'
      || type === 'tool/call' || type === 'tool/result') {
      if (match.event.seq > max) max = match.event.seq
    }
  }
  if (max === Number.NEGATIVE_INFINITY) return startSeq !== undefined ? startSeq + 0.6 : 0
  return max + 0.1
}

/** 段落头名字节点定义（TurnTail 镜像：Context 覆盖整个 turn）。 */
export const femTurnHeadDefinition: ConversationNodeDefinition<FemTurnNodeState> = {
  kind: 'fem-turn-head',
  target: 'chat',
  match: matchTurnEvent,
  start: (context, match) => startTurnState(context, match),
  update: updateTurnState,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    if (context.state?.actor === undefined) return null
    return {
      key: context.key,
      kind: 'fem-turn-head',
      id: context.id,
      target: 'chat',
      anchorSeq: headAnchor(context),
      location: { kind: 'unresolved' },
      visibility: 'visible',
      data: { actor: context.state.actor, turn: context.state.turn },
    }
  },
}

/** 流尾直播节点定义（TurnTail closingAnchor 镜像：恒在已落地内容之后）。 */
export const femTurnStreamDefinition: ConversationNodeDefinition<FemTurnNodeState> = {
  kind: 'fem-turn-stream',
  target: 'chat',
  match: matchTurnEvent,
  start: (context, match) => startTurnState(context, match),
  update: updateTurnState,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    if (context.state?.actor === undefined) return null
    return {
      key: context.key,
      kind: 'fem-turn-stream',
      id: context.id,
      target: 'chat',
      anchorSeq: streamAnchor(context),
      location: { kind: 'unresolved' },
      visibility: 'visible',
      data: { actor: context.state.actor, turn: context.state.turn },
    }
  },
}

/** 段落头名字行渲染：样式与旧 speaker 行同款（加粗彩色，不做 scope 过滤）。 */
export function FemTurnHeadNodeView({ node, useSession, t: _t }: ChatNodeViewProps<'fem-turn-head'>) {
  const sessionId = useSession(snapshot => snapshot.sessionId)
  const view = useView(sessionId)
  if (view === 'offstage') return null
  const { actor } = node.data
  return (
    <div style={{
      margin: '8px 0 2px',
      fontWeight: 700,
      fontSize: '12.5px',
      color: actorColor(actor),
    }}>
      {actor}
    </div>
  )
}

/** 流尾直播渲染：直播桶（SSE 缓冲）+ Deep diving（官方「骑整个 running turn」）。 */
export function FemTurnStreamNodeView({ node, useSession, t }: ChatNodeViewProps<'fem-turn-stream'>) {
  const { actor, turn } = node.data
  const sessionId = useSession(snapshot => snapshot.sessionId)
  const view = useView(sessionId)
  const chat = useSession(snapshot => snapshot.chat)
  // mainSid / 本窗 actorKey 由窗 id 推导（fem-proj-<sid>-<actorKey>；与
  // chat-node 同款：sid 段可含连字符，只剥最后一段）。
  const projSuffix = sessionId !== undefined && sessionId.startsWith('fem-proj-')
    ? sessionId.slice('fem-proj-'.length)
    : undefined
  const mainSid = projSuffix !== undefined ? projSuffix.replace(/-[^-]*$/, '') : undefined
  const winActorKey = projSuffix !== undefined && projSuffix.includes('-')
    ? projSuffix.slice(projSuffix.lastIndexOf('-') + 1)
    : undefined
  const myActorKey = femProjectionActorKey(actor)
  const streamEligible = view !== 'offstage' && winActorKey !== undefined
    && (winActorKey === 'god' || winActorKey === 'stage' || winActorKey === myActorKey)
  const liveBlocks = useFemStream(streamEligible ? mainSid : undefined, streamEligible ? myActorKey : undefined)
  // 本节点所属 turn 的实时状态（number 键直查——timeline.turns 是 Map<number>）。
  const myTurn = useMemo(() => {
    const turns = (chat.timeline as unknown as { turns?: Map<number, { status?: string; start?: { time?: number } }> } | undefined)?.turns
    const t = turns?.get(turn)
    return t === undefined ? undefined : { open: t.status === 'open', start: t.start?.time ?? null }
  }, [chat.timeline, turn])
  if (view === 'offstage') return null
  // 桶空且 turn 已闭合 → 无进行中内容（历史重放隐形；旧 stream-host 行同款语义）。
  if (liveBlocks.length === 0 && !(myTurn !== undefined && myTurn.open)) return null
  return (
    <div>
      {liveBlocks.length > 0 && <FemStreamLive blocks={liveBlocks} t={t} />}
      {myTurn !== undefined && myTurn.open && <FemTurnStatus startTime={myTurn.start} />}
    </div>
  )
}
