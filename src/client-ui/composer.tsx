/**
 * client-ui/composer.tsx — 投影窗 composer（角色/上帝视角的可输入输入框）。
 *
 * dsh 对 origin=subagent 会话默认挂 SubagentReadOnlyComposer（只读）；
 * 投影窗（fem-proj-*）需要可输入。输入 → POST /dsh-femwa/projection-input，
 * 由 host 按运行状态路由（2026-08-24 定稿）：剧本未跑→steer 直达主模型；
 * 人类节点等待→喂引擎 wait_key；跑本中其他时候→本窗留痕（插话待实现）。
 * （2026-08-26 结构整理自 client.tsx 原样迁出，行为零变化。）
 */

import { useState } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ProjectionComposer({ useSession }: any) {
  const sessionId = useSession((s: { sessionId?: string }) => s.sessionId) as string | undefined
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = (): void => {
    const value = text.trim()
    if (value.length === 0 || busy || sessionId === undefined) return
    setBusy(true)
    void fetch('/dsh-femwa/projection-input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, text: value }),
    })
      .then(response => response.json())
      .then((data: { ok?: boolean }) => {
        if (data.ok === true) setText('')
      })
      .catch(() => { /* 保持输入，不丢草稿 */ })
      .finally(() => setBusy(false))
  }
  return (
    <div style={{
      display: 'flex',
      gap: '8px',
      padding: '10px 16px 12px',
      maxWidth: 'calc(var(--dsh-chat-content-width, 748px) + 32px)',
      margin: '0 auto',
      width: '100%',
      boxSizing: 'border-box',
    }}>
      <textarea
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
        rows={1}
        spellCheck={false}
        style={{
          flex: 1,
          padding: '8px 12px',
          border: '1px solid var(--dsw-border, #ddd)',
          borderRadius: '10px',
          background: 'var(--dsw-surface-2, #f5f5f5)',
          color: 'var(--dsw-text-primary, #222)',
          fontSize: '13px',
          lineHeight: 1.5,
          resize: 'none',
          fontFamily: 'inherit',
          boxSizing: 'border-box',
          minHeight: '36px',
        }}
      />
      <button
        type="button"
        onClick={submit}
        disabled={busy || text.trim().length === 0}
        style={{
          padding: '0 16px',
          border: 'none',
          borderRadius: '10px',
          background: 'var(--dsw-accent, #4a9eff)',
          color: '#fff',
          cursor: 'pointer',
          fontSize: '13px',
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        发送
      </button>
    </div>
  )
}
