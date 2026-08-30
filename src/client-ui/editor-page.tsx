/**
 * client-ui/editor-page.tsx — 「Fem 编辑器」单页常驻宿主（2026-08-26 架构 v3）。
 *
 * 用户拍板模型：内存里只有一个 femgen 网页（FEMEditor 实例），内容跟随
 * 「打开的 Session」加载——打开哪个 Session 就加载哪个；切 Session 内容重载。
 * 网页挂在 body 级隐藏容器里（visibility:hidden 但保留视口尺寸，让编辑器
 * 布局计算与可见时一致），**永不卸载**：
 *   - tab 切换（对话↔Fem 编辑器）不卸载 → host 的 run_request 永远可达；
 *   - 「Fem 编辑器」tab 激活 = 锚点注册 → 隐藏容器被**移动到锚点内**（同一个
 *     DOM 节点，React 状态零丢失；锚点注销再移回 body）；
 *   - view-button 上报「当前打开的 fem 主会话」→ 页面内容跟随（打开哪个
 *     Session 加载哪个）；run_request 落在非当前会话时切过去跑完再切回。
 *
 * 单页（createRoot 于 body 级 div）——一万个 fem 会话也只占一份编辑器内存。
 * （编辑器实例内的一切状态逻辑：session-state 加载、定稿落盘+409 冲突弹窗、
 *   导出/导入、preflight、restore 报错横幅、AI 触发 run 的 triggerRun 与
 *   run-result 回传，全部从 editor-view.tsx 迁来——editor-view 只剩锚点。）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { femStreamAcquire, subscribeControlEvents } from './stream-store'
import FEMEditor from '../../femGen/src/FemWorAuto'

/** 编辑器页需要的注入能力（原 ScriptViewInjected 语义——宿主注入给页面）。 */
export interface EditorPageInjected {
  listScripts(): Promise<string[]>
  readScript(path: string): Promise<string>
  /** sessionId 带上则 host 顺写会话记录 {path, text}（导出/覆盖保存统一格式）。 */
  saveScript(name: string, content: string, sessionId?: string): Promise<string>
  runScript(sessionId: string, scriptPath?: string): Promise<void>
  stopScript(): Promise<void>
  fetchErrors(sessionId: string): Promise<Array<{ ts: number; text: string }>>
  /** 打开 dsh 侧边栏（手机版 femGen 返回键回调）。 */
  toggleSidebar(): void
}

// ── 单页 store（模块级：一个页面一个状态，跨组件共享）─────────────────────

interface EditorPageSlice {
  /** 当前应加载内容的 fem 主会话 id（null=无 fem 会话打开）。 */
  target: string | null
  /** 当前激活的「Fem 编辑器」tab 锚点（会话 id + DOM 容器）。 */
  anchor: { sid: string; el: HTMLElement } | null
}

const pageState: EditorPageSlice = { target: null, anchor: null }
const pageListeners = new Set<() => void>()
/** 会话 id → 打开中的会话数（view-button 上报；投影窗与主窗同 sids 合并计数）。 */
const sessionRefs = new Map<string, number>()

function pageNotify(): void {
  for (const listener of [...pageListeners]) listener()
}

function pageSetTarget(sid: string | null): void {
  if (pageState.target === sid) return
  pageState.target = sid
  pageNotify()
}

/** view-button 上报：某 fem 主会话的窗口打开了（主会话/投影窗都算）。 */
export function editorPageOpenSession(sid: string): void {
  sessionRefs.set(sid, (sessionRefs.get(sid) ?? 0) + 1)
  pageSetTarget(sid)
}

/** view-button 上报：某 fem 主会话的窗口关掉了；最后一个关掉的清空目标。 */
export function editorPageCloseSession(sid: string): void {
  const n = (sessionRefs.get(sid) ?? 0) - 1
  if (n > 0) {
    sessionRefs.set(sid, n)
    return
  }
  sessionRefs.delete(sid)
  if (pageState.target === sid && pageState.anchor === null) pageSetTarget(null)
  // 有锚点（编辑器 tab 还开着）时不清：锚点是当前内容的事实来源。
}

/** 「Fem 编辑器」tab 锚点注册（tab 激活 ⇔ 编辑器视图挂载）。 */
export function editorPageRegisterAnchor(sid: string, el: HTMLElement): void {
  pageState.anchor = { sid, el }
  pageSetTarget(sid)
  pageNotify()
}

/** 锚点注销（tab 切走/会话切换/窗口关闭）。同名同元素才清，防多窗把新的误清。 */
export function editorPageUnregisterAnchor(sid: string, el: HTMLElement): void {
  if (pageState.anchor?.sid !== sid || pageState.anchor.el !== el) return
  pageState.anchor = null
  pageNotify()
}

// ── 全局控制 SSE（页面级常驻，管 run_request / script_changed）────────────

/** 待触发的 AI 运行请求（run_request 落在尚未加载的会话上时排队）。 */
let pendingRunSid: string | null = null
/** 已挂载页面的触发钩子（页面装载完毕就绪时同步触发用）。 */
let pageTriggerRef: ((sid: string) => void) | null = null
/** 已挂载页面的 script_changed 重载钩子。 */
let pageReloadRef: (() => void) | null = null

function handleControlEvent(msg: { type?: string; data?: Record<string, unknown> }): void {
  const sid = typeof msg.data?.sessionId === 'string' ? msg.data.sessionId : ''
  if (sid.length === 0) return
  if (msg.type === 'run_request') {
    // AI 触发「模拟按前端 run 按钮」：内容跟随请求——切到目标会话并排队/触发。
    console.log(`[femwa-page] sse run_request sid=${sid} target=${pageState.target}`)
    pendingRunSid = sid
    pageSetTarget(sid)
    pageTriggerRef?.(sid)
    pageNotify()
    return
  }
  if (msg.type === 'script_changed') {
    // mount/定稿落盘广播：页面内容跟随（当前无目标时采纳；已是目标则重载）。
    console.log(`[femwa-page] sse script_changed sid=${sid} target=${pageState.target} anchor=${pageState.anchor?.sid ?? 'none'}`)
    if (pageState.target === null) pageSetTarget(sid)
    if (pageState.target === sid) {
      // eslint-disable-next-line no-console
      console.log(`[femwa-page] -> reload page (target match)`)
      pageReloadRef?.()
    }
    return
  }
}

/** 从全局 SSE 读到并【取走】待触发 sid（消费语义：取走即清，防陈旧排队
 *  在会话再次挂载时误触发一次多余的 run）。 */
function takePendingRunSid(): string | null {
  const sid = pendingRunSid
  pendingRunSid = null
  return sid
}

// ── 页面根组件（createRoot 于 body 级隐藏容器）────────────────────────────

/** 页面根容器 DOM（body 级；锚点激活时被移动到锚点内）。 */
let pageRootEl: HTMLElement | null = null

/** 把页面根容器放到正确的位置：锚点内（激活）或 body 隐藏（未激活）。
 *  移动的是同一个 DOM 节点——React 端口/状态零丢失（createRoot 容器如何
 *  被挂接与 React 无关）。 */
function applyPagePlacement(): void {
  const rootEl = pageRootEl
  if (rootEl === null) return
  const anchor = pageState.anchor
  if (anchor !== null && anchor.el.isConnected) {
    if (rootEl.parentNode !== anchor.el) anchor.el.appendChild(rootEl)
    rootEl.style.visibility = 'visible'
    rootEl.style.pointerEvents = 'auto'
    rootEl.style.position = 'absolute'
    rootEl.style.inset = '0'
    // ★ 2026-08-26 「以为的屏幕」修正：隐藏态是 100vw×100vh（视口尺寸），
    // 移入锚点时宽度/高度必须切回 100%（锚点尺寸）——否则编辑器布局始终按
    // 视口算，内容右下超出实际容器（用户实拍「下方/右侧出框」真因）。
    rootEl.style.width = '100%'
    rootEl.style.height = '100%'
    console.log(`[femwa-page] placement -> anchor (sid=${anchor.sid})`)
  } else {
    if (rootEl.parentNode !== document.body) document.body.appendChild(rootEl)
    rootEl.style.visibility = 'hidden'
    rootEl.style.pointerEvents = 'none'
    rootEl.style.position = 'fixed'
    rootEl.style.inset = '0'
    rootEl.style.width = '100vw'
    rootEl.style.height = '100vh'
    console.log('[femwa-page] placement -> hidden')
  }
}

/** 挂载单页根（client.tsx apply() 调用一次）：body 级隐藏容器 + createRoot。 */
export function mountFemEditorPage(createInjected: () => EditorPageInjected): void {
  if (pageRootEl !== null) return
  const el = document.createElement('div')
  el.setAttribute('data-femwa-editor-page', '')
  el.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;visibility:hidden;pointer-events:none;z-index:0'
  document.body.appendChild(el)
  pageRootEl = el
  createRoot(el).render(<EditorPageRoot injectedFactory={createInjected} />)
  console.log('[femwa-page] editor page root mounted (single-instance keep-alive)')
}

function EditorPageRoot({ injectedFactory }: { injectedFactory: () => EditorPageInjected }): JSX.Element {
  const [, force] = useState(0)
  useEffect(() => {
    // 控制事件搭全局 SSE 便车（stream-store 单例，不另开连接——避免挤占
    // 浏览器 HTTP/1.1 每域 6 连接池）；acquire 保持常驻（与 apply() 的双保险）。
    const release = femStreamAcquire()
    const unsubscribe = subscribeControlEvents(handleControlEvent)
    const listener = (): void => {
      applyPagePlacement()
      force(x => x + 1)
    }
    pageListeners.add(listener)
    applyPagePlacement()
    // target 变化（会话切换）后锚点可能仍挂着——内容跟随 target，重放位置。
    return () => {
      pageListeners.delete(listener)
      unsubscribe()
      release()
    }
  }, [])
  const target = pageState.target
  return (
    <div style={{ width: '100%', height: '100%', background: 'transparent' }}>
      {target !== null && (
        <FemEditorPage
          key={target}
          sessionId={target}
          injected={injectedFactory()}
        />
      )}
    </div>
  )
}

// ── 编辑器页（单实例；key=sessionId 保证切 Session 全量重载）──────────────

type PageState = {
  hasScript: boolean
  script?: string
  scriptPath?: string
  rev?: number
  checkpoint: Record<string, string>
  running?: boolean
} | null

const conflictBtnStyle = {
  padding: '6px 14px',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 13,
  background: 'var(--dsw-surface-3, #fff)',
  border: '1px solid var(--dsw-border, #ddd)',
} as const

function FemEditorPage({ sessionId, injected }: { sessionId: string; injected: EditorPageInjected }): JSX.Element {
  const [state, setState] = useState<PageState>(null)
  /** 409 冲突弹窗：localFems=被拒的本地文本；remoteRev=裁决用的服务端当前 rev。 */
  const [conflict, setConflict] = useState<{ localFems: string; remoteRev: number } | null>(null)
  /** 编辑器恢复/解析失败横幅：用户可见 + 上报 host 并入 errors（主模型经 femwa-mount/run 工具结果可见）。 */
  const [editorNotice, setEditorNotice] = useState<string | null>(null)
  /** FEMEditor 命令式引用：AI 触发（run_request）经它调 triggerRun('ai')。 */
  const editorRef = useRef<{ triggerRun?: (source?: string) => void } | null>(null)
  /** 待触发（页面刚挂载/还在加载时排队，恢复完成后触发）。 */
  const pendingRunRef = useRef(false)
  /** 已上报过的 restore 错误（消息级去重）：同一条错误只报一次，避免多路
   *  触发（挂载/script_changed/remount）累积 N 条相同 POST。新记录载入时
   *  重置（剧本修复后再犯同错仍能重新上报）。 */
  const lastRestoreErrorRef = useRef<string | null>(null)

  const onRestoreError = useCallback((message: string): void => {
    if (lastRestoreErrorRef.current === message) return
    lastRestoreErrorRef.current = message
    setEditorNotice(message)
    void fetch('/dsh-femwa/editor-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, message, source: 'restore' }),
    }).catch((error: unknown) => { console.warn('[dsh-femwa] editor-error 上报失败:', error) })
  }, [sessionId])

  /** AI 触发 run 的前端结果回传（模拟按按钮的工具侧收口）：POST run-result，
   *  host 的 femwa-run 工具正在等这个结果（成功=已点火 / 失败=守卫/语法/运行错）。 */
  const reportRunResult = useCallback((result: {
    ok: boolean
    error?: string
    conflicts?: Record<string, unknown>
    note?: string
  }): void => {
    void fetch('/dsh-femwa/run-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, ...result }),
    }).catch((error: unknown) => { console.warn('[dsh-femwa] run-result 回传失败:', error) })
  }, [sessionId])

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
    console.log(`[femwa-page] loadSessionState start sid=${sessionId}`)
    const response = await fetch(`/dsh-femwa/session-state?sessionId=${encodeURIComponent(sessionId)}`)
    const data = await response.json() as { ok?: boolean; script?: string; scriptPath?: string; rev?: number; checkpoint?: Record<string, string>; running?: boolean }
    if (data.ok === true) {
      // 剧本载入新记录：上次的「恢复失败」横幅自动收起（若新剧本仍解析失败，
      // restore effect 会再次 onRestoreError 重新上报弹出——时序上在本次 setState
      // 之后，所以这里先清是安全的）。
      setEditorNotice(null)
      // 新记录载入=新的恢复上下文：清掉去重标记，剧本修复后再犯同错仍可上报。
      lastRestoreErrorRef.current = null
      setState(prev => {
        // 引用复用：script/checkpoint 内容未变则沿用旧引用，避免 initialScript/
        // initialCheckpoint prop 换新对象触发 restore effect 无谓重跑
        // （每重跑一次坏剧本就多上报一次，是重复 editor_errors 的温床）。
        const sameScript = prev !== null && data.script !== undefined && prev.script === data.script
        const sameCheckpoint = prev !== null && prev.checkpoint !== undefined
          && JSON.stringify(prev.checkpoint) === JSON.stringify(data.checkpoint ?? {})
        return {
          hasScript: data.script !== undefined,
          script: sameScript ? prev.script : data.script,
          scriptPath: data.scriptPath,
          rev: data.rev ?? 0,
          checkpoint: sameCheckpoint ? prev.checkpoint : (data.checkpoint ?? {}),
          running: data.running === true,
        }
      })
      console.log(`[femwa-page] state loaded sid=${sessionId} script=${data.script === undefined ? 'undefined' : String(data.script.length) + 'ch'} rev=${String(data.rev ?? 0)}`)
      if (pendingRunRef.current) {
        pendingRunRef.current = false
        triggerAiRun()
      }
    }
  }, [sessionId])

  /** 切 Session / 新目标：清态 + 重载（key=sessionId 已保证编辑器重挂载）。 */
  useEffect(() => {
    setState(null)
    setConflict(null)
    setEditorNotice(null)
    // 页面刚挂载（新目标）且已有排队 run（run_request 落在未加载的会话上）。
    if (takePendingRunSid() === sessionId) pendingRunRef.current = true
    void loadSessionState().catch(() => { /* 编辑器仍可空白启动 */ })
    pageReloadRef = loadSessionState
    return () => { pageReloadRef = null }
  }, [sessionId, loadSessionState])

  /** AI 触发直达（2026-08-28 去 rAF 改造）：旧实现「等一帧+30ms」赌编辑器文本
   *  已铺好，但 rAF 在隐藏窗口/后台标签完全不跑（60s 点火根因，实测广播后
   *  62s 才点火、窗口不亮就永不点火）。AI 路径文本已改为现取 record（见
   *  FemWorAuto handleRunWorkflow），不再依赖编辑器文本就绪——事件直达，
   *  隐藏窗口照常点火。 */
  const triggerAiRun = useCallback((): void => {
    editorRef.current?.triggerRun?.('ai')
  }, [])

  /** AI run_request 同步触发钩子（页面已就绪→直接触发；未就绪→排队）。 */
  useEffect(() => {
    pageTriggerRef = (sid: string): void => {
      if (sid !== sessionId) return
      pendingRunSid = null
      if (state === null) {
        pendingRunRef.current = true
        return
      }
      triggerAiRun()
    }
    return () => { pageTriggerRef = null }
  }, [sessionId, state, triggerAiRun])

  // 断点位置：主流程分支优先，其次任一分支（画布按节点 label 匹配）。
  const checkpointNode = state === null
    ? undefined
    : state.checkpoint['__main__'] ?? Object.values(state.checkpoint)[0]

  const persistScript = (fems: string): void => {
    void fetch('/dsh-femwa/session-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, fems, ...(state?.rev === undefined ? {} : { baseRev: state.rev }) }),
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
      body: JSON.stringify({ sessionId, fems, baseRev: conflict.remoteRev }),
    })
      .then(async (response) => {
        if (response.ok) {
          const data = await response.json().catch(() => null) as { ok?: boolean; rev?: number } | null
          setState(prev => prev === null ? prev : { ...prev, rev: data?.rev ?? prev.rev })
          setConflict(null)
          return
        }
        if (response.status === 409) {
          const data = await response.json().catch(() => null) as { record?: { rev?: number } } | null
          setConflict({ localFems: fems, remoteRev: data?.record?.rev ?? conflict.remoteRev })
        }
      })
      .catch((error: unknown) => { console.warn('[dsh-femwa] conflict override failed:', error) })
  }

  /** 预检：未保存（无剧本地址）时，剧本里的相对 file: 引用非法——只支持绝对地址。 */
  const preflightCheck = (fems: string): string | null => {
    if (state?.scriptPath !== undefined && state.scriptPath.length > 0) return null
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
    void injected.stopScript().catch((error: unknown) => {
      console.warn('[dsh-femwa] stop failed:', error)
    })
  }

  /** 「未改动」提醒弹窗状态：onExport 挂起等待用户裁决（另存为/返回画布）。 */
  const [saveReminder, setSaveReminder] = useState<{
    path: string
    resolve: (choice: 'saveas' | 'back') => void
  } | null>(null)

  /** 导出（2026-08-30 三态行为，猫猫拍板）：
   *  无 path → 系统目录选择器选位置保存（首次导出）；
   *  有 path 且文件内容与 Editor Text 一致 → 弹「未改动」提醒（另存为/返回画布）；
   *  有 path 且不一致 → Editor Text 覆盖写入该文件 + 记录 {path, text} 同步更新
   *  （save-script 带 sessionId 一步完成文件+记录）。
   *  比对基准=path 文件内容（CRLF 归一）——它是「上次保存版本」的权威载体，
   *  对旧记录（纯 {path}）与运行时比对逻辑剥离 text 的情况都正确。
   *  返回 undefined = 用户选了「返回编辑画布」（未保存）。 */
  const onExport = async (fems: string, name: string): Promise<string | undefined> => {
    const norm = (s: string): string => s.replace(/\r\n/g, '\n')
    const currentPath = state?.scriptPath
    if (currentPath !== undefined && currentPath.length > 0) {
      let fileText: string | undefined
      try {
        fileText = await injected.readScript(currentPath)
      } catch {
        fileText = undefined // 文件被外部删除：视为「有改动」→ 覆盖保存即重建该文件
      }
      if (fileText !== undefined && norm(fileText) === norm(fems)) {
        const choice = await new Promise<'saveas' | 'back'>((resolve) => {
          setSaveReminder({ path: currentPath, resolve })
        })
        if (choice === 'back') return undefined
        // saveas → 落到下方另存为流程（新地址 + 记录跟随新地址）
      } else {
        const saved = await injected.saveScript(currentPath, fems, sessionId)
        setState(prev => prev === null ? prev : { ...prev, scriptPath: saved, script: fems })
        return saved
      }
    }
    const pickResp = await fetch('/dsh-femwa/pick-directory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const pickData = await pickResp.json() as { ok?: boolean; directory?: string | null; error?: string; kind?: string }
    if (pickData.ok !== true || typeof pickData.directory !== 'string' || pickData.directory.length === 0) {
      if (pickData.kind === 'browse') {
        throw new Error('当前环境不支持系统目录选择器（browse 后端）')
      }
      throw new Error(pickData.error ?? (pickData.directory === null ? '已取消选择' : '选择目录失败'))
    }
    const safe = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.fems$/i, '')
    const fullPath = `${pickData.directory.replace(/[\\/]+$/, '')}\\${safe}.fems`
    const saved = await injected.saveScript(fullPath, fems, sessionId)
    setState(prev => prev === null ? prev : { ...prev, scriptPath: saved, script: fems })
    return saved
  }

  /** 导入（2026-08-30 改引用式，猫猫拍板「从哪导入就指向哪」）：host 弹系统
   *  文件选择器（浏览器 FileReader 拿不到完整路径，必须 host 侧选）→
   *  {path, content}；记录写 {path, text}（mount 同款并存格式，不再复制到
   *  projects/）。用户取消返回 null。 */
  const onImport = async (): Promise<{ path: string; content: string } | null> => {
    const resp = await fetch('/dsh-femwa/pick-script', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const data = await resp.json() as { ok?: boolean; path?: string | null; content?: string; error?: string }
    if (data.ok !== true) throw new Error(data.error ?? 'pick-script failed')
    // 提取局部常量再守卫：属性窄化不保留进 setState 回调（TS2345 实测）。
    const pickedPath = data.path
    const pickedContent = data.content
    if (typeof pickedPath !== 'string' || pickedPath.length === 0 || pickedContent === undefined) return null
    await fetch('/dsh-femwa/session-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, scriptPath: pickedPath, fems: pickedContent }),
    })
    setState(prev => prev === null ? prev : { ...prev, scriptPath: pickedPath, script: pickedContent })
    return { path: pickedPath, content: pickedContent }
  }

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <FEMEditor
        ref={editorRef}
        plugin
        onRun={onRun}
        onStop={onStop}
        onPersistScript={persistScript}
        getRecordScript={getRecordScript}
        onExport={onExport}
        onImport={onImport}
        onBackToShell={injected.toggleSidebar}
        savedPath={state?.scriptPath}
        initialScript={state?.script}
        initialCheckpoint={checkpointNode}
        initialRunning={state?.running === true}
        onRestoreError={onRestoreError}
        onRunResult={reportRunResult}
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
      {saveReminder !== null && createPortal(
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
            <div style={{ fontWeight: 700, marginBottom: 6 }}>📤 你并未改动文本</div>
            <div style={{ color: 'var(--dsw-text-secondary, #666)', marginBottom: 14, wordBreak: 'break-all' }}>
              当前编辑器文本和 {saveReminder.path} 里保存的版本一样。你是想要另存为？还是忘了把画布上的改动应用到文本（图到文本）？
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { const r = saveReminder; setSaveReminder(null); r.resolve('back') }}
                style={conflictBtnStyle}
              >返回编辑画布</button>
              <button
                onClick={() => { const r = saveReminder; setSaveReminder(null); r.resolve('saveas') }}
                style={{ ...conflictBtnStyle, color: '#fff', background: '#d96b2b', borderColor: '#d96b2b' }}
              >另存为</button>
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
