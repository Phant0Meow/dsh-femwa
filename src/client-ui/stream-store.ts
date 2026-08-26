/**
 * client-ui/stream-store.ts — fem_stream 直播缓冲（2026-08-24 方案B：SSE 旁路零落盘）。
 *
 * host 的 runAiSubagent 把演员 chunk 旁路广播到 /dsh-femwa/events；这里按
 * 「主会话 id + actorKey」分桶缓冲，speaker 锚点行在名字正下方渲染官方同
 * 款打字机。块完成（block_end）即从缓冲移除——原生镜像几乎同时落地接管；
 * run 结束（end）整桶清空兜底。全部内存态，不写任何会话日志。
 *
 * 2026-08-26 结构整理自 client.tsx 原样迁出（行为零变化）；femProjectionActorKey
 * 是投影窗 id 的 actorKey 消毒（与宿主 projection.ts projectionActorKey 同算法，
 * 前端比对用——浏览器无法 import host 代码，两端改动必须同步）。
 */

import { useEffect, useState } from 'react'

export interface FemStreamBlock {
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

export const EMPTY_FEM_BLOCKS: readonly FemStreamBlock[] = []

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

function femStreamSet(sid: string, actorKey: string, entry: { blocks: readonly FemStreamBlock[] }): void {
  // ★ 自建缺失的 sid Map（2026-08-25 崩溃级修复）：此前用可选链
  //   femStreams.get(sid)?.set(...)，Map 不存在时写入被【静默跳过】且无人
  //   创建它——所有 fem_stream 帧进黑洞，直播层永远空白、零报错。
  let byActor = femStreams.get(sid)
  if (byActor === undefined) {
    byActor = new Map()
    femStreams.set(sid, byActor)
  }
  byActor.set(actorKey, entry)
  femStreamNotify()
}

function findLastFemBlock(blocks: readonly FemStreamBlock[], kind: 'text' | 'reasoning' | 'toolcall'): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.kind === kind) return i
  }
  return -1
}

/** 投影窗 id 的 actorKey 消毒（与宿主 projectionActorKey 同算法，前端比对用）。 */
export function femProjectionActorKey(actor: string): string {
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

// SSE 单例（引用计数）：apply() 时页面级预开一条常驻连接——store 不依赖
// 锚点挂载才喂帧，锚点晚挂载 read() 也能拿到全量缓冲。
let femStreamEs: EventSource | undefined
let femStreamEsRefs = 0

export function femStreamAcquire(): () => void {
  femStreamEsRefs += 1
  if (femStreamEs === undefined) {
    femStreamEs = new EventSource('/dsh-femwa/events')
    femStreamEs.onmessage = (ev: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string; data?: Record<string, unknown> }
        if (msg.type === 'fem_stream') femStreamApply((msg.data ?? {}) as FemStreamMsg)
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
    }
  }
}

/** React hook：读某主会话某演员的直播块；挂载期间维持 SSE 连接并随帧刷新。 */
export function useFemStream(mainSid: string | undefined, actorKey: string | undefined): readonly FemStreamBlock[] {
  const [blocks, setBlocks] = useState<readonly FemStreamBlock[]>(EMPTY_FEM_BLOCKS)
  useEffect(() => {
    if (mainSid === undefined || actorKey === undefined) return
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
