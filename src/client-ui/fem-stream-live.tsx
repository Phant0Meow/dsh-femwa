/**
 * client-ui/fem-stream-live.tsx — 直播块渲染件 + Deep diving 状态行。
 *
 * speaker 锚点与导演锚点共用同一套视觉：reasoning 块走 FemReasoningRow 折叠行、
 * toolcall 块走单行 ⚙ 摘要、正文走官方 MarkdownText 打字机 + 光标。
 * FemTurnStatus 是官方 ChatView TurnStatus 的同款转写，由调用方按 open-turn
 * 条件渲染在流末尾（2026-08-26 二次修正：不再内嵌于 FemStreamLive——官方语义
 * 是"骑整个 running turn 全程"，而非"有直播块才显示"）。
 */

import { useEffect, useMemo, useState } from 'react'
// MarkdownText：官方正文渲染器（基线件，shell 同一实例）——投影窗流式方案B
// 的打字机正文与原生消息像素同款的关键。
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { FemReasoningRow } from '../fem-reasoning-row'
import { type FemStreamBlock } from './stream-store'

/**
 * 官方 ChatView runningTurnStartTime 同款 + open-turn 存在性判定。
 * 投影窗是无 agent 镜像会话（官方 running 永 false），"演出中"由落盘事件
 * 推导：timeline 存在 status==='open' 的 turn 即进行中；startTime=最近一个
 * open turn 的 turn/start 时间（中途打开/重启后计时仍真实）。
 */
export function openTurnInfo(timeline: unknown): { hasOpen: boolean; startTime: number | null } {
  const turns = (timeline as { turns?: Map<string, { status?: string; start?: { time?: number } }> } | undefined)?.turns
  if (turns === undefined) return { hasOpen: false, startTime: null }
  let latest: number | null = null
  let hasOpen = false
  for (const turn of turns.values()) {
    if (turn?.status !== 'open') continue
    hasOpen = true
    if (turn.start !== undefined && typeof turn.start.time === 'number') {
      latest = turn.start.time
    }
  }
  return { hasOpen, startTime: latest }
}

/**
 * 官方 ChatView TurnStatus 同款转写（2026-08-26 对齐官方语义）：品牌蓝流光
 * "Deep diving..."，15 秒起追加耗时计时。官方行为（源码注释 "rides the whole
 * running turn"）：用户消息落地即出现（不等首 token，告知"已收到正在处理"，
 * 免得用户以为卡死）、位置恒在消息流末尾、整个 turn 结束才消失（首 token/
 * 工具执行/流式全程不闪烁）。显示条件由调用方给（open turn 存在），本组件
 * 只负责视觉与计时。startTime=open turn 的 turn/start 时间（官方
 * runningTurnStartTime 同源；null 回退挂载时刻）。
 */
export function FemTurnStatus({ startTime }: { startTime: number | null }) {
  const [mountedAt] = useState(() => Date.now())
  // Anchored to turn/start so a mid-turn reload keeps the real elapsed time.
  const anchor = startTime ?? mountedAt
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  useEffect(() => {
    const tick = (): void => { setElapsedMs(Math.max(0, Date.now() - anchor)) }
    tick()
    const id = setInterval(tick, 1000)
    return () => { clearInterval(id) }
  }, [anchor])
  // 官方同款阈值：短回合只留纯文案，跑够 15 秒才出现计时。
  const showClock = elapsedMs >= 15_000
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return (
    <div className="fem-turn-status" role="status" aria-live="polite">
      Deep diving...
      {showClock && (
        <span className="fem-turn-status-clock" aria-hidden>
          {minutes > 0 ? `${minutes}分${String(seconds).padStart(2, '0')}秒` : `${seconds}秒`}
        </span>
      )}
    </div>
  )
}

export function FemStreamLive({ blocks, t }: { blocks: readonly FemStreamBlock[]; t: unknown }) {
  const safeT = typeof t === 'function' ? (t as (key: string) => string) : (key: string): string => key
  const codeLabels = useMemo(() => ({ copyLabel: safeT('copy'), copiedLabel: safeT('copied') }), [safeT])
  return (
    <div className="fem-stream-root">
      {blocks.map((block, i) => block.kind === 'reasoning'
        ? (
          <FemReasoningRow
            key={i}
            text={block.text}
            running={i === blocks.length - 1}
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
  )
}
