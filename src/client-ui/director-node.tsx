/**
 * client-ui/director-node.tsx — 导演直播锚点节点（2026-08-25 方案B Step2）。
 *
 * 上帝窗里主模型的发言此前要等 assistant/message 落地才整块出现（MIRROR 白
 * 名单无 chunk）。宿主把主模型 chunk 旁路广播成 fem_stream（actor='导演'，
 * 零落盘）；这里给每条 user/message 挂一个锚点节点，只有「最新一条」且存
 * 在活跃导演缓冲时，在其下渲染打字机——主模型回复永远紧跟用户消息落位。
 * （2026-08-26 结构整理自 client.tsx 原样迁出，行为零变化。）
 */

import { useMemo } from 'react'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { femProjectionActorKey, useFemStream } from './stream-store'
import { FemStreamLive } from './fem-stream-live'
import { useView } from './view-state'

/** One user/message anchor node's data（仅 seq，直播内容走 SSE store）。 */
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
    if (event.type === 'user/message') return { id: String(event.seq), role: 'start' }
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

/** Render one user/message anchor node in god windows（导演流式）。 */
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
