/**
 * dsh-femwa — FemWA integration for DeepSeek Harness.
 *
 * 本文件是「总装车间」：插件门面（name/inject/Config）、事件词汇声明合并、
 * 以及 apply() 编排——把各职责模块按序装配起来。业务逻辑都在对应模块：
 *
 *   config.ts        设置表（Config schema + ResolvedConfig）
 *   bridge.ts        与 Python 引擎通话的电话线（FemwaBridge 子进程封装）
 *   persona.ts       Fem 会话身份证 + 导演手册/运行通知注入
 *   http.ts          HTTP 小工具箱（readBody/writeJson/SSE 广播）
 *   state-files.ts   存档管理员（checkpoint/turn_scopes/session_script 文件族)
 *   projection.ts    投影窗管家（建窗/唤醒/投影 + 上帝窗镜像）
 *   subagent.ts      AI 演员经纪人（引擎 AI 节点 → dsh 子代理执行与事件镜像）
 *   engine-events.ts 演出中的总调度（pre-step 门卫 + 输入桥 + 引擎事件 switch）
 *   run-control.ts   开演流程（startRunOnSession + 剧本读写 handler）
 *   routes.ts        前台接线员（全部 /dsh-femwa/* HTTP 路由）
 *   tools.ts         主模型专用工具（femwa-mount/run/script/soul；本就独立）
 *
 * 历史行为注记（M2 scope）：
 *   1. Fem sessions via sidebar button (POST /dsh-femwa/create-session),
 *      optionally with a `fems` script body that auto-starts the engine.
 *   2. No main model while running: pre-step rejects for running Fem sessions;
 *      idle Fem sessions run the main model normally.
 *   3. Engine bridge: managed Python subprocess (femwa_bridge.py), NDJSON
 *      over stdio. run/pause/resume/stop/human_input/list_scripts/ping/
 *      shutdown. LLM key resolved from ctx.credentials per run.
 *   4. Event bridge: engine events are re-emitted as cordis
 *      'dsh-femwa/event'; the event switch turns them into projected chat
 *      lines and main-model notices.
 *   5. Input bridge: user messages on the running Fem session are forwarded
 *      as human input while a human node waits, or hard-stop the run
 *      (interrupt semantics) while the engine is working.
 *
 * NOTE: ctx.logger output is not reliably visible in this deployment, so
 * diagnostics also go to console.log.
 *
 * 2026-08-23 重构：单文件（2733 行）拆分为上述模块；纯搬家+闭包工厂化，
 * 行为零变化。重构前快照见 src/index.ts.bak-20260823-pre-refactor。
 */

import type { Context } from '@deepseek-ai/cordis'
// Value import: SessionId 构造器在 resolveMounted 用。
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
// Namespace import: `registerSessionEventType` (the runtime event-type
// registration surface) only exists on builds that ship it; on stock builds
// the plugin still loads and live sessions work — only loading history of
// dsh-femwa/chat sessions is unavailable there (see README "dsh 版本要求").
// 红线：注册必须只发生在此处一处（external 单例语义，见 build.mjs 注释）。
import * as sessionNS from '@deepseek-ai/dsh-session'

import { Config, resolveConfig } from './config'
import { FemwaBridge } from './bridge'
import { FEM_PRESET, presetOf, isFemAgent, registerPersonaHooks } from './persona'
import { broadcastSse } from './http'
import { readSessionScript, readSessionScriptText, writeSessionScript } from './state-files'
import { createProjectionRegistry, createGodMirror, awakenedDisposers } from './projection'
import { type RunState, registerEngineEventHandlers } from './engine-events'
import { startRunOnSession } from './run-control'
import { registerRoutes } from './routes'
import { registerFemwaTools, type FemwaToolDeps } from './tools'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One Fem engine chat line rendered by the dsh-femwa client node.
     * @mode emit
     * @param data - speaker, line text, and line kind.
     */
    'dsh-femwa/chat': {
      /** Speaker name (engine node), when the line is a role line. */
      actor?: string
      /** The line's text. */
      text: string
      /** role = AI character line; notice = engine/flow status; human_wait = waiting for the user; prompt = node hint/announcement; error = engine error (red, system-like); thinking = subagent cot (folded). */
      kind: 'role' | 'notice' | 'human_wait' | 'prompt' | 'error' | 'thinking'
    }
  }
}

export const name = 'dsh-femwa'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** One FemWA engine event, re-emitted verbatim (eventType, data). */
    'dsh-femwa/event'(eventType: string, data: unknown): void
  }
}

/** Required services: agent registry + session store + tools (femwa-mount/run). */
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'tools']

export { Config }

export async function apply(ctx: Context, config: unknown): Promise<void> {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) {
    console.log('[dsh-femwa] disabled by config')
    return
  }
  // 全局默认模型选择（用户在模型选择 UI 保存的推理等级在这里）；
  // 子 agent 不走 apiproxy 的 selection 安装，需要手动注入。
  const defaultModel = ctx.get('agentDefaultModel') as
    | { currentSelection(): unknown }
    | undefined

  // Admit the plugin's custom event type ('dsh-femwa/chat') into the session
  // event vocabulary at runtime (the persistence read path otherwise refuses
  // logs containing it). Every type the plugin appends to a session log must
  // be registered here — missing one means that session's history fails to
  // load. (turn→scope used to be a log event too; it now persists to the
  // plugin's user_data/turn_scopes/<sessionId>.json instead.) Registration
  // must precede any session load, so it happens at apply time. Only builds
  // that ship the registration surface (upstreamed feature / meow fork) have
  // it; on stock builds the plugin keeps working for live sessions.
  const registerSessionEventType = (sessionNS as { registerSessionEventType?: (type: string) => () => void }).registerSessionEventType
  if (registerSessionEventType !== undefined) {
    ctx.effect(() => registerSessionEventType('dsh-femwa/chat'), 'dsh-femwa: session event type')
  } else {
    console.log('[dsh-femwa] this dsh build lacks registerSessionEventType; loading history of dsh-femwa sessions is unsupported here (see README)')
  }

  // Crash diagnostics: log uncaught exceptions/rejections instead of taking
  // the process down silently (the 3081 instance is managed by AutoClaw and
  // gets relaunched, so a visible log beats a silent relaunch).
  process.on('uncaughtException', (error: Error) => {
    console.log(`[dsh-femwa] uncaughtException: ${String(error?.stack ?? error)}`)
  })
  process.on('unhandledRejection', (reason: unknown) => {
    console.log(`[dsh-femwa] unhandledRejection: ${String(reason instanceof Error ? reason.stack : reason)}`)
  })
  // Event-loop heartbeat (2026-08-23 卡死调查): a 1s timer whose drift exposes
  // event-loop stalls. 静态文件活着但 RPC 全挂 = 异步死锁（心跳正常）；
  // 心跳也停 = 事件循环被同步代码堵死。两种病，两副药。
  let heartbeatLast = Date.now()
  const HEARTBEAT_INTERVAL = 1000
  setInterval(() => {
    const now = Date.now()
    const lag = now - heartbeatLast - HEARTBEAT_INTERVAL
    heartbeatLast = now
    if (lag > 2000) {
      console.log(`[dsh-femwa] event-loop stall: ${lag}ms behind`)
    }
  }, HEARTBEAT_INTERVAL)

  const bridge = new FemwaBridge()
  ;(bridge as unknown as { emit(name: string, ...args: unknown[]): void }).emit = (name, ...args) => {
    ;(ctx.emit as (name: string, ...args: unknown[]) => void)(name, ...args)
  }

  // Run-state bookkeeping: which session owns the current engine run, and
  // whether a human node is waiting for input. 全插件共享同一引用
  // （engine-events/routes/tools deps 显式传参）。
  const runState: RunState = {
    running: false,
    nodeActors: new Map(),
    nodeScopes: new Map(),
    sessionActors: new Map(),
    errors: new Map(),
    pausedByUser: false,
    lastEvents: [],
  }

  const sessionsStore = ctx.get('sessions') as { get(id: SessionId): Session | undefined } | undefined

  /** 投影窗注册表：sid → { god, actors }（角色/上帝视角的子代理窗）。 */
  const projections = createProjectionRegistry(ctx)

  /** 主会话 → 上帝窗镜像（实时监听 + 水位补齐）。 */
  const godMirror = createGodMirror({ femwaRoot: resolved.femwaRoot, sessionsStore, projections })

  const recordError = (sessionId: SessionId, text: string): void => {
    const key = String(sessionId)
    const list = runState.errors.get(key) ?? []
    list.push({ ts: Date.now(), text })
    if (list.length > 50) list.shift()
    runState.errors.set(key, list)
    console.log(`[dsh-femwa] error on ${key}: ${text}`)
  }

  // 身份钩子（preset override 重建 + docs section 补注入/清除）。
  registerPersonaHooks(ctx)

  // 运行期总调度：pre-step 门卫 + 输入桥 + 上帝窗实时镜像 + 引擎事件 switch
  // （内部按此顺序注册监听器，与重构前 apply() 的注册顺序一致）。
  registerEngineEventHandlers(ctx, {
    resolved, bridge, runState, sessionsStore, projections, godMirror, defaultModel, recordError,
  })

  // HTTP 路由（20 个 /dsh-femwa/* 接口登记）。
  registerRoutes(ctx, {
    resolved, bridge, runState, projections, sessionsStore, godMirror, recordError,
  })

  // Bridge lifecycle: start the Python engine subprocess, stop on dispose.
  setTimeout(() => { bridge.start(ctx, resolved) }, 1000)
  ctx.effect(() => () => {
    void bridge.stop()
  }, 'dsh-femwa: bridge lifecycle')
  // 唤醒的冷投影窗 detach：插件卸载/HMR 重载时移出 sessions store，防泄漏。
  ctx.effect(() => () => {
    for (const dispose of awakenedDisposers.splice(0)) {
      try { dispose() } catch { /* 已分离则忽略 */ }
    }
  }, 'dsh-femwa: awakened projection windows')

  // ── 主模型专用工具：femwa-mount（挂载剧本到会话）/ femwa-run（控制运行）。
  //    执行体复用现有链路（writeSessionScript / startRunOnSession），只注入依赖。
  // 公共解析：会话校验 + 读挂载剧本（text 优先）+ 编译校验（check 命令）。
  // fresh_start 与 resume 共用——AI 看到的=AI 跑的=编译过的。
  const resolveMounted = async (sessionId: string): Promise<{ sid: SessionId; scriptText: string; effectivePath?: string }> => {
    const sid = SessionId(sessionId)
    const session = sessionsStore?.get(sid)
    if (session === undefined) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }
    if (presetOf(session) !== FEM_PRESET) {
      throw new Error('当前会话不是 Fem 剧本模式')
    }
    if (runState.running) {
      throw new Error('已有剧本在运行中，请先停止')
    }
    const scriptText = await readSessionScriptText(resolved.femwaRoot, sessionId)
    if (scriptText === undefined) {
      throw new Error('会话未挂载剧本：请先 femwa-mount 或用 femGen 编辑器写入剧本')
    }
    const prev = await readSessionScript(resolved.femwaRoot, sessionId)
    const effectivePath = prev?.path
    // 编译校验（femwa-run 路径）：编译错误作为工具返回结果给主模型，
    // 带细节（parse_script 的行号/变量名）指导改剧本；不启动运行、无状态残留。
    const baseDir = effectivePath !== undefined
      ? effectivePath.replace(/[\\/][^\\/]*$/, '')
      : ''
    try {
      await bridge.send('check', { fems: scriptText, base_dir: baseDir }, 30_000)
    } catch (error: unknown) {
      throw new Error(`剧本编译失败：${String(error instanceof Error ? error.message : error)}`)
    }
    return { sid, scriptText, effectivePath }
  }
  // 编辑器上报错误的水位线：takeEditorErrors 每次取走后推进，工具结果只带增量。
  const editorErrReportedAt = new Map<string, number>()
  const toolDeps: FemwaToolDeps = {
    takeEditorErrors: (sessionId: string): string[] => {
      const list = runState.errors.get(sessionId) ?? []
      const since = editorErrReportedAt.get(sessionId) ?? 0
      const fresh = list.filter((e) => e.ts > since)
      editorErrReportedAt.set(sessionId, Date.now())
      return fresh.map((e) => e.text)
    },
    mountScript: async (sessionId, scriptPath) => {
      // 双链路①：path + text 一起写。恢复面读取是 text 优先（实际运行版本），
      // mount 只写 path 的话，任何后续快照写回的 stale text 都会遮蔽新挂载的
      // 剧本（2026-08-21「挂载后画布空白」bug 根因）。text 始终与文件内容一致。
      const { readFile } = await import('node:fs/promises')
      let text: string
      try {
        text = await readFile(scriptPath, 'utf8')
      } catch (error) {
        throw new Error(`无法读取剧本文件 ${scriptPath}：${String(error instanceof Error ? error.message : error)}`)
      }
      await writeSessionScript(resolved.femwaRoot, sessionId, { path: scriptPath, text })
      console.log(`[dsh-femwa] femwa-mount ${sessionId} <- ${scriptPath}`)
      // 双链路②：记录已更新 → 推信号让已打开的编辑器重读。否则旧画布的
      // 3s 防抖回写会用内存旧本盖掉新写入的地址，重新挂载等于白挂。
      broadcastSse('script_changed', { sessionId })
    },
    runScript: async (sessionId) => {
      // fresh_start：从头运行已挂载的剧本（清 checkpoint，reset=true）。
      const { sid, scriptText, effectivePath } = await resolveMounted(sessionId)
      await startRunOnSession(ctx, resolved, bridge, runState, sid, scriptText, effectivePath, true)
    },
    stopScript: async (sessionId) => {
      if (!runState.running) {
        throw new Error('当前没有剧本在运行，无需停止')
      }
      runState.pausedByUser = false
      await bridge.send('stop', {}, 5000)
      console.log(`[dsh-femwa] femwa-run stop ${sessionId}`)
    },
    pauseScript: async (sessionId) => {
      if (!runState.running) {
        throw new Error('当前没有剧本在运行，无需暂停')
      }
      runState.pausedByUser = true
      await bridge.send('pause', {}, 5000)
      console.log(`[dsh-femwa] femwa-run pause ${sessionId}`)
    },
    resumeScript: async (sessionId) => {
      // resume：不 reset 的 run——自动带 checkpoint 从断点续跑（前端「继续」同款链路）。
      const { sid, scriptText, effectivePath } = await resolveMounted(sessionId)
      await startRunOnSession(ctx, resolved, bridge, runState, sid, scriptText, effectivePath, false)
    },
    isFemMainSession: (agent) => isFemAgent(agent),
    soulList: async () => {
      // femwa-soul list：主模型写剧本选角前查角色库（bridge 直读 DB）。
      const result = await bridge.send('list_souls', {}, 5000) as { souls?: Array<{ soul_id: string; soul_name: string }> } | undefined
      return { souls: result?.souls ?? [] }
    },
    soulCreate: async (soulId, soulName, description) => {
      // femwa-soul create：新建全局角色（归属/创建者固定 u001，与前端 soul 弹窗同链路）。
      return bridge.send('create_soul', { soul_id: soulId, soul_name: soulName, description, user_id: 'u001' }, 5000)
    },
    readScript: async (sessionId) => {
      const record = await readSessionScript(resolved.femwaRoot, sessionId)
      if (record === undefined) return undefined
      const finalText = await readSessionScriptText(resolved.femwaRoot, sessionId)
      if (finalText === undefined) return undefined
      return { path: record.path, text: record.text, finalText }
    },
  }
  ctx.effect(() => registerFemwaTools(ctx, toolDeps), 'dsh-femwa: main-model tools')
}
