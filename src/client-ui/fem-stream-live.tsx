/**
 * client-ui/fem-stream-live.tsx — 直播块渲染件。
 *
 * speaker 锚点与导演锚点共用同一套视觉：reasoning 块走 FemReasoningRow 折叠行、
 * toolcall 块走单行 ⚙ 摘要、正文走官方 MarkdownText 打字机 + 光标。
 * （2026-08-26 结构整理自 client.tsx 原样迁出，行为零变化。）
 */

import { useMemo } from 'react'
// MarkdownText：官方正文渲染器（基线件，shell 同一实例）——投影窗流式方案B
// 的打字机正文与原生消息像素同款的关键。
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { FemReasoningRow } from '../fem-reasoning-row'
import { type FemStreamBlock } from './stream-store'

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
