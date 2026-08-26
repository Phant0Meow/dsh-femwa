/**
 * client-ui/fem-button.tsx — 侧边栏底部「🎭 Fem 剧本」按钮。
 *
 * 剧本菜单（GET /dsh-femwa/scripts）+ 内联粘贴编辑器 + 空会话入口；
 * 选定后 POST /dsh-femwa/create-session（带 scriptPath）并打开新会话。
 * （2026-08-26 结构整理自 client.tsx 原样迁出，行为零变化。）
 */

import { useState } from 'react'

/** Injected face assembled by the apply closure. */
export interface FemButtonInjected {
  /** Fetch available .fems scripts from the host. */
  listScripts(): Promise<string[]>
  /** Create a Fem session for one script and open it. */
  createFemSession(scriptPath?: string): Promise<void>
  /** Save a pasted script to a .fems file; returns its path. */
  saveScript(name: string, content: string): Promise<string>
}

type FemButtonProps = { wide: boolean } & FemButtonInjected

/** Sidebar footer action: create and open a new Fem mode session. */
export function FemButton({ wide, listScripts, createFemSession, saveScript }: FemButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [scripts, setScripts] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [scriptName, setScriptName] = useState('')
  const [scriptContent, setScriptContent] = useState('')
  const [saving, setSaving] = useState(false)

  const toggleMenu = (): void => {
    if (menuOpen) {
      setMenuOpen(false)
      return
    }
    setMenuOpen(true)
    void listScripts().then(setScripts).catch((error: unknown) => {
      console.warn('[dsh-femwa] list scripts failed:', error)
      setScripts([])
    })
  }

  const run = (scriptPath: string | undefined): void => {
    setMenuOpen(false)
    if (busy) return
    setBusy(true)
    void createFemSession(scriptPath)
      .catch((error: unknown) => {
        console.warn('[dsh-femwa] create fem session failed:', error)
      })
      .finally(() => { setBusy(false) })
  }

  const openEditor = (): void => {
    setMenuOpen(false)
    setScriptName('')
    setScriptContent('')
    setEditorOpen(true)
  }

  const submitScript = (): void => {
    if (saving) return
    const name = scriptName.trim()
    if (name.length === 0) return
    setSaving(true)
    void saveScript(name, scriptContent)
      .then((path) => {
        setEditorOpen(false)
        return createFemSession(path)
      })
      .catch((error: unknown) => {
        console.warn('[dsh-femwa] save/run script failed:', error)
      })
      .finally(() => { setSaving(false) })
  }

  const editor = editorOpen
    ? (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: '8px',
          width: '420px',
          maxWidth: '80vw',
          background: 'var(--dsw-surface-1, #fff)',
          border: '1px solid var(--dsw-border, #ddd)',
          borderRadius: '8px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          padding: '10px',
          zIndex: 100,
          fontSize: '13px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--dsw-text-primary, #222)' }}>输入 Fem 剧本</div>
          <input
            value={scriptName}
            onChange={(e) => setScriptName(e.currentTarget.value)}
            placeholder="剧本名称（不含扩展名）"
            style={{
              padding: '6px 8px',
              border: '1px solid var(--dsw-border, #ddd)',
              borderRadius: '6px',
              background: 'var(--dsw-surface-2, #f5f5f5)',
              color: 'var(--dsw-text-primary, #222)',
              fontSize: '13px',
            }}
          />
          <textarea
            value={scriptContent}
            onChange={(e) => setScriptContent(e.currentTarget.value)}
            placeholder={'粘贴 .fems 剧本内容…\n（剧本是一段文字：meta/actors/vars/action/mainflow…）'}
            rows={10}
            spellCheck={false}
            style={{
              padding: '8px',
              border: '1px solid var(--dsw-border, #ddd)',
              borderRadius: '6px',
              background: 'var(--dsw-surface-2, #f5f5f5)',
              color: 'var(--dsw-text-primary, #222)',
              fontSize: '12px',
              fontFamily: 'monospace',
              lineHeight: 1.5,
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => setEditorOpen(false)}
              style={{
                padding: '5px 12px',
                border: '1px solid var(--dsw-border, #ddd)',
                borderRadius: '6px',
                background: 'transparent',
                color: 'var(--dsw-text-secondary, #666)',
                cursor: 'pointer',
                fontSize: '13px',
              }}
            >
              取消
            </button>
            <button
              type="button"
              disabled={saving || scriptName.trim().length === 0}
              onClick={submitScript}
              style={{
                padding: '5px 12px',
                border: 'none',
                borderRadius: '6px',
                background: 'var(--dsw-accent, #4a9eff)',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '13px',
              }}
            >
              {saving ? '保存中…' : '保存并运行'}
            </button>
          </div>
        </div>
      )
    : null

  const menu = menuOpen
    ? (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: '8px',
          minWidth: '220px',
          maxHeight: '300px',
          overflowY: 'auto',
          background: 'var(--dsw-surface-1, #fff)',
          border: '1px solid var(--dsw-border, #ddd)',
          borderRadius: '8px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          padding: '4px',
          zIndex: 100,
          fontSize: '13px',
        }}>
          {scripts.length === 0 && <div style={{ padding: '6px 10px', color: 'var(--dsw-text-tertiary, #999)' }}>未找到剧本</div>}
          {scripts.length > 0 && <div style={{ padding: '4px 10px', color: 'var(--dsw-text-tertiary, #999)', fontSize: '12px' }}>选择剧本：</div>}
          {scripts.map((path) => {
            const name = path.split(/[\\/]/).pop() ?? path
            return (
              <button
                key={path}
                type="button"
                onClick={() => run(path)}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '6px 10px',
                  border: 'none',
                  borderRadius: '6px',
                  background: 'transparent',
                  color: 'var(--dsw-text-primary, #222)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={path}
              >
                {name}
              </button>
            )
          })}
          <button
            type="button"
            onClick={openEditor}
            style={{
              display: 'block',
              width: '100%',
              padding: '6px 10px',
              border: 'none',
              borderRadius: '6px',
              background: 'transparent',
              color: 'var(--dsw-text-secondary, #666)',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            ✏️ 输入剧本…
          </button>
          <button
            type="button"
            onClick={() => run(undefined)}
            style={{
              display: 'block',
              width: '100%',
              padding: '6px 10px',
              border: 'none',
              borderRadius: '6px',
              background: 'transparent',
              color: 'var(--dsw-text-secondary, #666)',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            ＋ 空会话（不带剧本）
          </button>
        </div>
      )
    : null

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        disabled={busy}
        onClick={toggleMenu}
        title="新建 Fem 剧本会话（无主模型的多智能体剧本舞台）"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          width: '100%',
          height: '28px',
          border: 'none',
          borderRadius: '6px',
          background: 'transparent',
          color: 'var(--dsw-text-secondary, #888)',
          cursor: 'pointer',
          fontSize: '13px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}
      >
        <span aria-hidden>🎭</span>
        {wide && <span>Fem 剧本</span>}
        {busy && <span>…</span>}
      </button>
      {menu}
      {editor}
    </div>
  )
}
