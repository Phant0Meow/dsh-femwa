/**
 * client-ui/editor-view.tsx — 「Fem 编辑器」标签页（conversation.view）。
 *
 * 画布可视化编辑器（femGen 插件模式）的宿主壳：会话状态加载/恢复、双链路
 * 同步（script_changed 广播重拉）、乐观锁 409 冲突弹窗、恢复失败横幅、
 * 导出/导入/运行预检。proj 窗打开时经 useSessions 解析回母会话 id。
 * （2026-08-26 结构整理自 client.tsx 原样迁出，行为零变化。）
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import FEMEditor from '../../femGen/src/FemWorAuto'

/** 本页面实例 id：快照写带上它，host 广播时原样带回；前端跳过自己的
 * script_changed 广播（否则自己写完→自己重拉→白转一圈还压住后续输入）。 */
const PAGE_ID = `p${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`

/** 冲突弹窗按钮统一样式（跟随 dsh 主题 token，暗色自适应）。 */
const conflictBtnStyle: CSSProperties = {
  padding: '6px 14px',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 13,
  background: 'var(--dsw-surface-3, #fff)',
  border: '1px solid var(--dsw-border, #ddd)',
}

// ── Fem script view (conversation.view tab: "Fem 剧本") ───────────────────

export interface ScriptViewInjected {
  listScripts(): Promise<string[]>
  readScript(path: string): Promise<string>
  saveScript(name: string, content: string): Promise<string>
  /** Play a script on the CURRENT session (must be Fem mode). */
  runScript(sessionId: string, scriptPath?: string): Promise<void>
  /** Hard-stop the running workflow; the checkpoint stays for resume. */
  stopScript(): Promise<void>
  fetchErrors(sessionId: string): Promise<Array<{ ts: number; text: string }>>
  /** 打开 dsh 侧边栏（手机版 femGen 返回键回调）。 */
  toggleSidebar(): void
}

type FemScriptViewProps = { sessionId: string } & ScriptViewInjected

/** 画布可视化编辑器（femGen 插件模式）：取代文本编辑标签页。
 *  onRun 把画布生成的 .fems 直接交给插件 run 路由（不落盘），
 *  与聊天窗角色气泡是同一次引擎运行；SSE 事件流由 femGen 内部连接。
 *  挂载时读取会话状态（剧本记录 + 断点）用于恢复画布与「继续」按钮。
 *  savedPath=剧本文件地址（导出/导入产生）：非空 → 会话已保存（提示消失、
 *  支持相对寻址）；空 → 未保存（显示小字提示、依赖只支持绝对地址）。 */
export function FemEditorView(props: FemScriptViewProps & {
  /** 会话槽标准 share（运行时对 session-scoped 槽位必传）：proj 窗解析母会话用。 */
  useSessions?: (sel: (s: { byId: Record<string, { parentId?: string } | undefined> }) => string | undefined) => string | undefined
}) {
  const { saveScript, stopScript, toggleSidebar } = props
  // proj 窗入口（2026-08-23）：编辑器数据全部挂主会话——剧本记录/断点/运行态
  // 都在主 sid 名下。母 id 从会话表 parentId 取（proj id 的角色键可含 - ，字符串
  // 反解不可逆）；在主会话本体打开时原样使用自身 id。以下整个组件体继续用
  // 变量名 sessionId，零内文改动。
  const rawSessionId = props.sessionId
  const motherId = props.useSessions?.((s) => {
    const summary = s.byId[rawSessionId]
    return typeof summary?.parentId === 'string' ? summary.parentId : undefined
  })
  const sessionId = typeof rawSessionId === 'string'
    && rawSessionId.startsWith('fem-proj-')
    && typeof motherId === 'string'
    ? motherId
    : rawSessionId
  const [state, setState] = useState<{
    hasScript: boolean
    script?: string
    scriptPath?: string
    rev?: number
    checkpoint: Record<string, string>
    running?: boolean
  } | null>(null)
  /** 409 冲突弹窗：localFems=被拒的本地文本；remoteRev=裁决用的服务端当前 rev。 */
  const [conflict, setConflict] = useState<{ localFems: string; remoteRev: number } | null>(null)
  /** 编辑器恢复/解析失败横幅：用户可见 + 上报 host 并入 errors（主模型经 femwa-mount/run 工具结果可见）。 */
  const [editorNotice, setEditorNotice] = useState<string | null>(null)
  const onRestoreError = useCallback((message: string): void => {
    setEditorNotice(message)
    void fetch('/dsh-femwa/editor-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, message, source: 'restore' }),
    }).catch((error: unknown) => { console.warn('[dsh-femwa] editor-error 上报失败:', error) })
  }, [sessionId])

  // 「Fem 编辑器」标签页激活时隐藏底部 composer，切走时恢复。
  // conversation.view 只渲染激活的视图（only: active.id），所以本组件挂载
  // ⇔ 该标签页激活。不做 composer 链 takeover：其 select 只在渲染时调用，
  // 无法感知 tab 切换，而改 dsh 本体（ComposerChainProps 加字段）会破坏
  // 插件自包含。composer seat / scroll body 的 data 属性是 dsh web 的稳定
  // DOM 契约（skeleton 测试依赖 data-composer-seat）。
  useEffect(() => {
    const scrollBody = document.querySelector('[data-conversation-scroll]')
    const seat = scrollBody?.querySelector<HTMLElement>('[data-composer-seat]') ?? null
    if (seat === null) return
    seat.style.display = 'none'
    return () => { seat.style.display = '' }
  }, [])

  /** 拉取 record 侧的原文：「放弃修改直接跑」时作为定稿覆盖前端两处。 */
  const getRecordScript = useCallback(async (): Promise<string | undefined> => {
    try {
      const response = await fetch(`/dsh-femwa/session-state?sessionId=${encodeURIComponent(sessionId)}`)
      const data = await response.json() as { ok?: boolean; script?: string }
      return data.ok === true ? data.script : undefined
    } catch {
      return undefined
    }
  }, [sessionId])

  const loadSessionState = useCallback(async (): Promise<void> => {
    const response = await fetch(`/dsh-femwa/session-state?sessionId=${encodeURIComponent(sessionId)}`)
    const data = await response.json() as { ok?: boolean; script?: string; scriptPath?: string; rev?: number; checkpoint?: Record<string, string>; running?: boolean }
    // [femwa-diag] 记录形态取证：script 长度 / 地址 / running（连接线丢失调查）
    console.log(`[femwa-diag] session-state sid=${sessionId} ok=${String(data.ok)} script=${data.script === undefined ? 'undefined' : String(data.script.length) + 'ch'} path=${data.scriptPath ?? 'none'} rev=${String(data.rev)} running=${String(data.running)}`)
    if (data.ok === true) {
      setState({
        hasScript: data.script !== undefined,
        script: data.script,
        scriptPath: data.scriptPath,
        rev: data.rev ?? 0,
        checkpoint: data.checkpoint ?? {},
        running: data.running === true,
      })
    }
  }, [sessionId])

  useEffect(() => {
    void loadSessionState().catch(() => { /* 编辑器仍可空白启动 */ })
  }, [loadSessionState])

  // 双链路②：femwa-mount 等外部写入会话记录后广播 script_changed → 重拉
  // session-state。initialScript prop 变化会触发 femGen 恢复 effect 重新
  // applyFEMText，已打开的编辑器画布即按最新记录重载。
  // 多端语义（2026-08-22 定稿）：record 为准，外部更新静默接受覆盖。
  useEffect(() => {
    const es = new EventSource('/dsh-femwa/events')
    es.onmessage = (ev: MessageEvent<string>): void => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string; data?: Record<string, unknown> }
        if (msg.type !== 'script_changed') return
        if (String(msg.data?.pageId ?? '') === PAGE_ID) return
        if (String(msg.data?.sessionId ?? '') !== String(sessionId)) return
        void loadSessionState()
          .catch((error: unknown) => { console.warn('[dsh-femwa] script_changed reload failed:', error) })
      } catch {
        // 非 JSON SSE 行忽略
      }
    }
    return () => es.close()
  }, [sessionId, loadSessionState])

  // 断点位置：主流程分支优先，其次任一分支（画布按节点 label 匹配）。
  const checkpointNode = state === null
    ? undefined
    : state.checkpoint['__main__'] ?? Object.values(state.checkpoint)[0]

  // 显式落盘（2026-08-22 架构重构）：仅由「图生文本/文本生图」两个定稿按钮调用，
  // 把传入文本写为会话记录。会话记录 = {path?, text?, rev}：只写 text 保留已有地址；
  // 带 baseRev 做乐观锁——多端并发后写者输（409）→ 弹窗让用户选「加载最新/保留我的」。
  const persistScript = (fems: string): void => {
    void fetch('/dsh-femwa/session-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, fems, pageId: PAGE_ID, ...(state?.rev === undefined ? {} : { baseRev: state.rev }) }),
    })
      .then(async (response) => {
        if (response.status !== 409) return
        const data = await response.json().catch(() => null) as { ok?: boolean; record?: { rev?: number } } | null
        setConflict({ localFems: fems, remoteRev: data?.record?.rev ?? 0 })
      })
      .catch((error: unknown) => {
        console.warn('[dsh-femwa] persist write failed:', error)
      })
  }

  /** 冲突裁决·加载最新：丢弃本地文本，按服务端当前记录重载画布。 */
  const resolveConflictByReload = (): void => {
    setConflict(null)
    void loadSessionState()
      .catch((error: unknown) => { console.warn('[dsh-femwa] conflict reload failed:', error) })
  }

  /** 冲突裁决·保留我的编辑：以服务端最新 rev 为基准强制重写本地文本。 */
  const resolveConflictByOverride = (): void => {
    if (conflict === null) return
    const fems = conflict.localFems
    void fetch('/dsh-femwa/session-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, fems, baseRev: conflict.remoteRev, pageId: PAGE_ID }),
    })
      .then(async (response) => {
        if (response.ok) {
          const data = await response.json().catch(() => null) as { ok?: boolean; rev?: number } | null
          setState(prev => prev === null ? prev : { ...prev, rev: data?.rev ?? prev.rev })
          setConflict(null)
          return
        }
        if (response.status === 409) {
          // 覆盖期间又被别人写了：刷新弹窗里的 remoteRev，让用户再裁一次。
          const data = await response.json().catch(() => null) as { record?: { rev?: number } } | null
          setConflict({ localFems: fems, remoteRev: data?.record?.rev ?? conflict.remoteRev })
        }
      })
      .catch((error: unknown) => { console.warn('[dsh-femwa] conflict override failed:', error) })
  }

  /** 预检（todo #2）：未保存（无剧本地址）时，剧本里的相对 file: 引用非法——
   *  只支持绝对地址。运行前硬拦截并给出明确提示；已保存态放行（引擎裁决）。 */
  const preflightCheck = (fems: string): string | null => {
    if (state?.scriptPath !== undefined && state.scriptPath.length > 0) return null
    // 匹配 file:"xxx" / file:'xxx' / file："" / 文件：""（与引擎解析一致）
    const refs: string[] = []
    const re = /(?:file|文件)[:：]\s*["'“”]([^"'“”]+)["'“”]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(fems)) !== null) refs.push(m[1])
    const isAbs = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
    const relative = refs.filter(p => !isAbs(p))
    if (relative.length === 0) return null
    return `剧本未保存：依赖文件只支持绝对地址。以下引用是相对路径：${relative.join('、')}。请先「导出 .FEMS」保存剧本（相对路径将基于剧本文件位置解析），或改用绝对路径。`
  }

  const onRun = async (fems: string, opts?: { reset?: boolean }): Promise<void> => {
    const problem = preflightCheck(fems)
    if (problem !== null) throw new Error(problem)
    const response = await fetch('/dsh-femwa/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        fems,
        ...(opts?.reset === true ? { reset: true } : {}),
      }),
    })
    let message = `run HTTP ${response.status}`
    try {
      const data = await response.json() as { ok?: boolean; error?: string }
      if (data.ok === true) return
      message = data.error ?? message
    } catch {
      // non-JSON body: keep the status message
    }
    throw new Error(message)
  }
  const onStop = (): void => {
    void stopScript().catch((error: unknown) => {
      console.warn('[dsh-femwa] stop failed:', error)
    })
  }

  /** 导出：系统目录选择器选保存目录 → 保存 <目录>/<文件名>.fems → 会话记录
   *  替换为地址（不保留原文）→ 返回完整路径。 */
  const onExport = async (fems: string, name: string): Promise<string> => {
    const pickResp = await fetch('/dsh-femwa/pick-directory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const pickData = await pickResp.json() as { ok?: boolean; directory?: string | null; error?: string; kind?: string }
    if (pickData.ok !== true || typeof pickData.directory !== 'string' || pickData.directory.length === 0) {
      if (pickData.kind === 'browse') {
        // browse 后端：无系统对话框，前端提示用路径输入（暂未实现）。
        throw new Error('当前环境不支持系统目录选择器（browse 后端）')
      }
      throw new Error(pickData.error ?? (pickData.directory === null ? '已取消选择' : '选择目录失败'))
    }
    const safe = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.fems$/i, '')
    const fullPath = `${pickData.directory.replace(/[\\/]+$/, '')}\\${safe}.fems`
    const saved = await saveScript(fullPath, fems)
    await fetch('/dsh-femwa/session-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, scriptPath: saved }),
    })
    setState(prev => prev === null ? prev : { ...prev, scriptPath: saved, script: fems })
    return saved
  }

  /** 导入：FileReader 已把本地文件读入画布（femGen 内部），这里把内容上传
   *  保存到服务端 projects/（按文件名）→ 会话记录只存地址。 */
  const onImport = async (content: string, filename: string): Promise<string> => {
    const saved = await saveScript(filename.replace(/\.fems$/i, ''), content)
    await fetch('/dsh-femwa/session-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, scriptPath: saved }),
    })
    setState(prev => prev === null ? prev : { ...prev, scriptPath: saved, script: content })
    return saved
  }
  return (
    // data-conversation-composer-overlay：dsh 本体 CSS 据此给 viewArea
    // 确定高度（flex: 1 1 0 + min-height: 0 + overflow: hidden，trajectory
    // 同款机制），否则 FEMEditor 的 height:100% 解析失败、内容撑开使整个
    // 页面可无限下拉。标记随本视图卸载自动撤销。
    <div data-conversation-composer-overlay="" style={{ position: 'relative', height: '100%' }}>
      <FEMEditor
        plugin
        onRun={onRun}
        onStop={onStop}
        onPersistScript={persistScript}
        getRecordScript={getRecordScript}
        onExport={onExport}
        onImport={onImport}
        onBackToShell={toggleSidebar}
        savedPath={state?.scriptPath}
        initialScript={state?.script}
        initialCheckpoint={checkpointNode}
        initialRunning={state?.running === true}
        onRestoreError={onRestoreError}
      />
      {conflict !== null && createPortal(
        <div style={{
          position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            maxWidth: 420, width: 'calc(100% - 48px)', padding: '18px 20px', borderRadius: 12,
            background: 'color-mix(in srgb, var(--dsw-surface-2, #f5f5f5) 96%, transparent)',
            border: '1px solid var(--dsw-border, #e0e0e0)', boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
            fontSize: 13, lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>⚔️ 剧本冲突</div>
            <div style={{ color: 'var(--dsw-text-secondary, #666)', marginBottom: 14 }}>
              本窗口的编辑和其他窗口/设备的保存冲突了（对方先写入）。以哪个为准？
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={resolveConflictByReload} style={conflictBtnStyle}>加载最新版本</button>
              <button
                onClick={resolveConflictByOverride}
                style={{ ...conflictBtnStyle, color: '#fff', background: '#d96b2b', borderColor: '#d96b2b' }}
              >保留我的编辑</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {editorNotice !== null && createPortal(
        <div style={{
          position: 'fixed', left: 12, right: 12, bottom: 12, zIndex: 300,
          display: 'flex', gap: 8, alignItems: 'flex-start',
          padding: '10px 14px', borderRadius: 10, margin: '0 auto', maxWidth: 560,
          background: 'color-mix(in srgb, #fdecea 92%, transparent)',
          border: '1px solid #e5b3ad', boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
          fontSize: 12.5, lineHeight: 1.55,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>⚠️ 剧本恢复失败（已上报主模型）</div>
            <div style={{ color: 'var(--dsw-text-secondary, #666)', whiteSpace: 'pre-wrap' }}>{editorNotice}</div>
          </div>
          <button
            onClick={() => setEditorNotice(null)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 2 }}
            title="关闭"
          >✕</button>
        </div>,
        document.body,
      )}
    </div>
  )
}
