/**
 * client-ui/director-node.tsx — 导演直播锚点节点（2026-08-25 方案B Step2）。
 *
 * 上帝窗里主模型的发言此前要等 assistant/message 落地才整块出现（MIRROR 白
 * 名单无 chunk）。宿主把主模型 chunk 旁路广播成 fem_stream（actor='导演'，
 * 零落盘）；锚点节点只在「最新一个」且有活跃导演缓冲时，在其下渲染打字机。
 *
 * 锚点事件 = step/start（2026-08-26 修正，此前为 user/message）：主模型 React
 * 多轮（工具调用循环）中间没有新 user/message，第二轮流式会被画在「第一轮
 * 用户消息」的旧锚点上——视觉上第二轮跑到第一轮发言前面。改随 step/start
 * 走（每步一个锚点），直播永远落在最新 step 处=已落地内容之后；与演员机制
 * 同构（speaker 名字行随演员自己的 turn 发）。
 * （2026-08-26 结构整理自 client.tsx 原样迁出。）
 */

import { useMemo } from 'react'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { femProjectionActorKey, useFemStream } from './stream-store'
import { FemStreamLive } from './fem-stream-live'
import { useView } from './view-state'

/** One step/start anchor node's data（仅 seq，直播内容走 SSE store）。 */
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
    // 锚点=step/start：React 多轮每步一个锚点，直播跟随最新步落位（见头注释）。
    if (event.type === 'step/start') return { id: String(event.seq), role: 'start' }
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

/** Render one step/start anchor node in god windows（导演流式）。 */
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
  if (!eligible || !isLastDirectorAnchor || blocks.length === 0) return null
  return <FemStreamLive blocks={blocks} t={t} />
}
