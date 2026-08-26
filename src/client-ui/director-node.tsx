/**
 * client-ui/director-node.tsx — 导演直播锚点节点（2026-08-25 方案B Step2）。
 *
 * 上帝窗里主模型的发言此前要等 assistant/message 落地才整块出现（MIRROR 白
 * 名单无 chunk）。宿主把主模型 chunk 旁路广播成 fem_stream（actor='导演'，
 * 零落盘）；本节点在「最新一个锚点」处渲染打字机（流式内容）+ Deep diving
 * 状态行（open turn 指示）。
 *
 * 锚点事件 = user/message + step/start（2026-08-26 二次修正）：状态行必须
 * 恒在消息流末尾——只挂 step/start 的话，turn 间隙落地的新 user/message 会
 * 排到它后面（用户实测"AI发言/Deep diving/用户Prompt"乱序）。两类事件都建
 * 锚点、最新者接棒，流末尾归属永远正确。多轮演进史：初版仅 user/message
 * （React 多轮无新用户消息 → 第二轮流式画进第一轮上方）；二版仅 step/start
 * （turn 间隙被新消息越过）。
 *
 * Deep diving 显示条件对齐官方 ChatView TurnStatus："rides the whole running
 * turn"——用户消息落地即出现（等待首 token 免得以为卡死）、首 token 后继续
 * 显示（工具执行/流式全程）、整个 turn 结束才消失。投影窗是无 agent 镜像
 * 会话（官方 running 永 false），改由 timeline 推导：存在 status==='open'
 * 的 turn 即演出中。计时起点=open turn 的 turn/start 时间。
 */

import { useMemo } from 'react'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { femProjectionActorKey, useFemStream } from './stream-store'
import { FemStreamLive, FemTurnStatus, openTurnInfo } from './fem-stream-live'
import { useView } from './view-state'

/** One anchor node's data（仅 seq，直播内容走 SSE store）。 */
interface FemDirectorData {
  readonly seq: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'femwa-director': FemDirectorData
  }
}

// 导演在帧里的 actor 名（与宿主 engine-events 同款语义）；存储键必须走同
// 一个消毒函数推导——2026-08-25 实锤教训：曾写死 '__director__' 而宿主发
// 的是 '导演'（消毒后 _5bfc_6f14），两边暗号对不上，几千帧全部写进无人读
// 取的格子，零报错零渲染。
const FEM_DIRECTOR_ACTOR = '导演'
const FEM_DIRECTOR_KEY = femProjectionActorKey(FEM_DIRECTOR_ACTOR)

export const femDirectorDefinition: ConversationNodeDefinition<FemDirectorData> = {
  kind: 'femwa-director',
  target: 'chat',
  match: (event) => {
    // 锚点=user/message + step/start：最新者接棒，Deep diving 恒贴流末尾
    //（见头注释"二次修正"）。访问形态照抄官方 runningTurnStartTime。
    if (event.type === 'user/message' || event.type === 'step/start') {
      return { id: String(event.seq), role: 'start' }
    }
    return null
  },
  start: (_context, match) => ({ seq: match.event.seq }),
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'femwa-director',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: { kind: 'unresolved' },
      visibility: 'visible',
      data: context.state,
    }
  },
}

/** Render one anchor node in god windows（导演流式 + Deep diving）。 */
export function FemDirectorNodeView({ node, useSession, t }: ChatNodeViewProps<'femwa-director'>) {
  const sessionId = useSession(snapshot => snapshot.sessionId)
  const view = useView(sessionId)
  const projSuffix = sessionId !== undefined && sessionId.startsWith('fem-proj-')
    ? sessionId.slice('fem-proj-'.length)
    : undefined
  const mainSid = projSuffix !== undefined ? projSuffix.replace(/-[^-]*$/, '') : undefined
  // 导演是戏外视角：只在上帝窗渲染；角色窗不显示戏外发言。
  const eligible = view === 'god' && projSuffix !== undefined && mainSid !== undefined
  const blocks = useFemStream(eligible ? mainSid : undefined, eligible ? FEM_DIRECTOR_KEY : undefined)
  const chat = useSession(s => s.chat)
  const isLastDirectorAnchor = useMemo(() => {
    let lastKey: string | undefined
    for (const key of chat.order) {
      const nd = chat.nodes.get(key)
      if (nd !== undefined && nd.kind === 'femwa-director') lastKey = nd.key
    }
    return lastKey === node.key
  }, [chat, node.key])
  // 流尾判定（2026-08-26 间距 bug 修复）：「最新锚点」≠「流末尾」——锚点之后
  // 落地的内容节点（assistant 气泡/工具卡片）会把状态行甩在流中间，视觉上
  // 就是"两条工具之间凭空多出一大截"（前后各 16px 列 gap + 26px 行高）。
  // 状态行只在锚点本身就是消息流最后一个节点时承载；直播块仍在时豁免
  // （打字机正画在本锚点下，状态行与它同生同灭，流式间隙不闪断）。
  const isFlowTail = useMemo(
    () => chat.order[chat.order.length - 1] === node.key,
    [chat, node.key],
  )
  // open turn 推导（官方 running 的镜像会话替身）：存在即演出中，全程显示
  // 不闪烁；turn/end 落地即消失。
  const timeline = chat.timeline
  const { hasOpen, startTime } = useMemo(() => openTurnInfo(timeline), [timeline])
  if (!eligible || !isLastDirectorAnchor) return null
  const showStream = blocks.length > 0
  const showStatus = hasOpen && (isFlowTail || showStream)
  if (!showStream && !showStatus) return null
  return (
    <>
      {showStream && <FemStreamLive blocks={blocks} t={t} />}
      {showStatus && <FemTurnStatus startTime={startTime} />}
    </>
  )
}
