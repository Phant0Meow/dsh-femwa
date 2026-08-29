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
  /** 源 chunk index（llm StreamChunk 每块独立编号）——同 step 并行工具调用
   * （多 tool-call 块 delta 交错）按 index 分块聚合。2026-08-29 前按「最后
   * 一个同类块」聚合且假设同 step 工具串行，GLM 并行工具会把多工具参数拼
   * 进同一块。宿主旧广播帧无 index → 回退 findLast 行为。 */
  index?: number
}

interface FemStreamMsg {
  kind: 'start' | 'delta' | 'block_end' | 'end'
  sid?: unknown
  actor?: unknown
  blockKind?: unknown
  index?: unknown
  text?: unknown
  name?: unknown
}

export const EMPTY_FEM_BLOCKS: readonly FemStreamBlock[] = []

/** 帧携带的源块编号（缺省/非法 = 旧宿主广播，回退按 kind 找块）。 */
function msgIndex(msg: FemStreamMsg): number | undefined {
  return typeof msg.index === 'number' ? msg.index : undefined
}

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
  const idx = msgIndex(msg)
  const findByIdx = (blocks: readonly FemStreamBlock[]): number =>
    idx === undefined ? -1 : blocks.findIndex(b => b.index === idx)
  if (msg.kind === 'start') {
    // 重复 start 幂等（同 index 块已存在则忽略）。
    if (idx !== undefined && prev.some(b => b.index === idx)) return
    femStreamSet(sid, actorKey, { blocks: [...prev, { kind: blockKind, text: '', ...(idx !== undefined ? { index: idx } : {}) }] })
    return
  }
  if (msg.kind === 'delta') {
    const text = typeof msg.text === 'string' ? msg.text : ''
    const name = typeof msg.name === 'string' && msg.name.length > 0 ? msg.name : undefined
    // 定位：index 匹配优先；无 index（旧宿主广播）回退「最后一个同类块」。
    let at = findByIdx(prev)
    if (at < 0 && idx === undefined) at = findLastFemBlock(prev, blockKind)
    if (at < 0) {
      // 该块的首个 delta：toolcall 无 start 帧、text/reasoning 空文本不建块。
      if (blockKind === 'toolcall' || text.length > 0) {
        femStreamSet(sid, actorKey, {
          blocks: [...prev, {
            kind: blockKind, text,
            ...name !== undefined ? { name } : {},
            ...(idx !== undefined ? { index: idx } : {}),
          }],
        })
      }
      return
    }
    const target = prev[at] as FemStreamBlock
    const next = prev.slice()
    next[at] = {
      ...target,
      text: target.text + text,
      ...name !== undefined && !target.name ? { name } : {},
    }
    femStreamSet(sid, actorKey, { blocks: next })
    return
  }
  if (msg.kind === 'block_end') {
    let at = findByIdx(prev)
    if (at < 0 && idx === undefined) at = findLastFemBlock(prev, blockKind)
    if (at < 0) return
    const next = prev.slice()
    next.splice(at, 1)
    femStreamSet(sid, actorKey, { blocks: next })
  }
}

// SSE 单例（引用计数）：apply() 时页面级预开一条常驻连接——store 不依赖
// 锚点挂载才喂帧，锚点晚挂载 read() 也能拿到全量缓冲。
// 2026-08-26：控制事件（run_request/script_changed）也搭这条全局 SSE 便车
// （subscribeControlEvents）——与 fem_stream 共用一个连接，避免第二条长连接
// 挤占浏览器 HTTP/1.1 每域 6 连接池（曾致 RPC fetch「signal timed out」）。
let femStreamEs: EventSource | undefined
let femStreamEsRefs = 0

/** 控制事件订阅（editor-page 单页宿主用）：全局 SSE 收到的每条消息都会转发。 */
const controlHandlers = new Set<(msg: { type?: string; data?: Record<string, unknown> }) => void>()

export function subscribeControlEvents(h: (msg: { type?: string; data?: Record<string, unknown> }) => void): () => void {
  controlHandlers.add(h)
  return () => { controlHandlers.delete(h) }
}

export function femStreamAcquire(): () => void {
  femStreamEsRefs += 1
  if (femStreamEs === undefined) {
    femStreamEs = new EventSource('/dsh-femwa/events')
    femStreamEs.onmessage = (ev: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string; data?: Record<string, unknown> }
        if (msg.type === 'fem_stream') femStreamApply((msg.data ?? {}) as unknown as FemStreamMsg)
        // 控制事件转发给单页宿主（run_request / script_changed 等）。
        if (controlHandlers.size > 0) {
          for (const h of [...controlHandlers]) {
            try { h(msg) } catch { /* 单个处理器异常不影响广播 */ }
          }
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
