/**
 * client-ui/fem-stream-live.tsx — 直播块渲染件。
 *
 * speaker 锚点与导演锚点共用同一套视觉：reasoning 块走 FemReasoningRow 折叠行、
 * toolcall 块走单行 ⚙ 摘要、正文走官方 MarkdownText 打字机 + 光标。
 * （2026-08-26 结构整理自 client.tsx 原样迁出，行为零变化。）
 */

import { useEffect, useMemo, useState } from 'react'
// MarkdownText：官方正文渲染器（基线件，shell 同一实例）——投影窗流式方案B
// 的打字机正文与原生消息像素同款的关键。
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { FemReasoningRow } from '../fem-reasoning-row'
import { type FemStreamBlock } from './stream-store'

/**
 * 官方 ChatView TurnStatus 的同款转写（2026-08-26）：品牌蓝流光
 * "Deep diving..."，15 秒起追加耗时计时（官方 anchored turn/start；此处
 * 锚定组件挂载=直播缓冲首帧，误差毫秒级）。投影窗是没有自己 agent 的镜像
 * 会话，官方渲染条件 useSession(running) 永远为 false——这里改为「直播块
 * 渲染即显示」（FemStreamLive 仅在有活跃缓冲时挂载），卸载即停。
 */
function FemTurnStatus() {
  const [mountedAt] = useState(() => Date.now())
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    const tick = (): void => { setElapsedMs(Math.max(0, Date.now() - mountedAt)) }
    tick()
    const id = setInterval(tick, 1000)
    return () => { clearInterval(id) }
  }, [mountedAt])
  // 官方同款阈值：短演出只留纯文案，跑够 15 秒才出现计时。
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
      <FemTurnStatus />
      <span className="fem-stream-caret" aria-hidden />
    </div>
  )
}
