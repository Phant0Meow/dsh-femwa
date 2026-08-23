/**
 * routes.ts — 前台接线员。
 *
 * 全部 HTTP 路由（/dsh-femwa/*）的登记处：前端/femGen 画布来什么请求就
 * 分发给对应模块的执行体，本文件不做业务逻辑。webServer 服务缺失时仅打日志。
 * 从 index.ts 原样迁出（2026-08-23 重构；原 apply() 内联注册提为注册函数）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FemwaBridge } from './bridge'
import type { ResolvedConfig } from './config'
import { readBody, writeJson, sseClients, broadcastSse } from './http'
import type { RunState } from './engine-events'
import { turnScopesBySession } from './subagent'
import {
  readTurnScopeFile, readSessionScript, writeSessionScript,
  readSessionScriptText, readCheckpoint, writeCheckpoint, clearCheckpoint,
} from './state-files'
import { handleCreateSession, handleRunOnSession, handleSaveScript, handleReadScript, collectLlmModels } from './run-control'
import { appendEvent, type GodMirror, type ProjectionRegistry } from './projection'

export interface RoutesDeps {
  resolved: ResolvedConfig
  bridge: FemwaBridge
  runState: RunState
  projections: ProjectionRegistry
  sessionsStore?: { get(id: SessionId): Session | undefined }
  godMirror: GodMirror
  recordError(sessionId: string, text: string): void
}

/** 注册全部 /dsh-femwa/* HTTP 路由（index.ts 总装调用一次）。 */
export function registerRoutes(ctx: Context, deps: RoutesDeps): void {
  const { resolved, bridge, runState, projections, sessionsStore, godMirror, recordError } = deps

  // HTTP routes: create-session + script listing (sidebar button calls these).
  const webServer = ctx.get('webServer') as { register(spec: unknown): void } | undefined
  if (webServer !== undefined && typeof webServer.register === 'function') {
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/create-session',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void handleCreateSession(req, res, ctx, resolved, bridge, runState).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/run',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void handleRunOnSession(req, res, ctx, resolved, bridge, runState).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/models',
      handler: (_req: IncomingMessage, res: ServerResponse): void => {
        // 前端 actor source 下拉数据源：dsh 当前可用 provider/模型列表。
        void collectLlmModels(ctx, resolved).then((payload) => {
          writeJson(res, 200, { ok: true, ...payload })
        }).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/souls',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readBody(req) as Record<string, unknown>
          const soul_id = typeof body.soul_id === 'string' ? body.soul_id.trim() : ''
          if (soul_id.length === 0) {
            writeJson(res, 400, { ok: false, error: 'soul_id is required' })
            return
          }
          // 插件模式 soul 创建：归属/创建者固定默认用户 u001（前端不再输入）。
          const result = await bridge.send('create_soul', {
            soul_id,
            soul_name: typeof body.soul_name === 'string' ? body.soul_name.trim() : '',
            description: typeof body.description === 'string' ? body.description : '',
            user_id: 'u001',
          }, 5000)
          writeJson(res, 200, { ok: true, soul_id, result })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/stop',
      handler: (_req: IncomingMessage, res: ServerResponse): void => {
        // Hard-stop the running workflow (interrupt semantics): the engine
        // keeps its checkpoint file, so the next run resumes from it.
        if (!runState.running) {
          writeJson(res, 200, { ok: true, stopped: false, note: 'no active run' })
          return
        }
        runState.pausedByUser = false
        bridge.send('stop', {}, 5000).then(() => {
          writeJson(res, 200, { ok: true, stopped: true })
        }).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/turn-scopes',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // 主会话镜像 turn → scope 映射（前端视角过滤用）。
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')
        if (sessionId === null || sessionId.length === 0) {
          writeJson(res, 400, { ok: false, error: 'sessionId is required' })
          return
        }
        let scopes = turnScopesBySession.get(sessionId)
        if (scopes === undefined) {
          // 重启后内存 Map 已丢：从插件文件重建（user_data/turn_scopes/<sid>.json）。
          void readTurnScopeFile(resolved.femwaRoot, sessionId).then((record) => {
            const rebuilt = new Map<number, string[]>()
            for (const key of Object.keys(record)) {
              const scope = record[key]
              if (Array.isArray(scope)) rebuilt.set(Number(key), scope)
            }
            if (rebuilt.size > 0) turnScopesBySession.set(sessionId, rebuilt)
            const out: Record<string, string[]> = {}
            for (const [turn, scope] of rebuilt) out[String(turn)] = scope
            writeJson(res, 200, { ok: true, scopes: out })
          }).catch((error: unknown) => {
            writeJson(res, 500, { ok: false, error: String(error) })
          })
          return
        }
        const out: Record<string, string[]> = {}
        for (const [turn, scope] of scopes) out[String(turn)] = scope
        writeJson(res, 200, { ok: true, scopes: out })
      },
    })
    // femGen 画布控制面：pause/resume 目前对应 bridge 的半实现
    // （pause=stop，resume 需要真实 pause 快照——README 已知限制），
    // human-input 是完整可用的（human 节点输入）。
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/pause',
      handler: (_req: IncomingMessage, res: ServerResponse): void => {
        runState.pausedByUser = true
        bridge.send('pause', {}, 5000).then((result) => {
          writeJson(res, 200, { ok: true, paused: (result as { paused?: boolean } | undefined)?.paused ?? false })
        }).catch((error: unknown) => {
          runState.pausedByUser = false
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/resume',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const taskId = url.searchParams.get('taskId') ?? ''
        bridge.send('resume', { task_id: taskId }, 5000).then((result) => {
          writeJson(res, 200, { ok: true, resumed: (result as { resumed?: boolean } | undefined)?.resumed ?? false })
        }).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/human-input',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          const raw = await readBody(req) as unknown as Record<string, unknown>
          const waitKey = typeof raw.wait_key === 'string' ? raw.wait_key : ''
          const chatText = typeof raw.chat_text === 'string' ? raw.chat_text : ''
          const variables = (raw.variables ?? {}) as Record<string, unknown>
          const hasVars = typeof variables === 'object' && variables !== null && Object.keys(variables).length > 0
          if (waitKey.length === 0 || (chatText.length === 0 && !hasVars)) {
            writeJson(res, 400, { ok: false, error: 'wait_key and chat_text/variables are required' })
            return
          }
          const delivered = await bridge.send('human_input', {
            wait_key: waitKey,
            body: { chat_text: chatText, variables },
          })
          writeJson(res, 200, { ok: true, delivered: (delivered as { delivered?: boolean } | undefined)?.delivered ?? false })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/scripts',
      handler: (_req: IncomingMessage, res: ServerResponse): void => {
        bridge.send('list_scripts', {}).then((result) => {
          const scripts = (result as { scripts?: unknown[] } | undefined)?.scripts ?? []
          writeJson(res, 200, { ok: true, scripts })
        }).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/save-script',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void handleSaveScript(req, res, resolved).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/script',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void handleReadScript(req, res).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/errors',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')
        const list = sessionId === null ? [] : (runState.errors.get(sessionId) ?? [])
        writeJson(res, 200, { ok: true, errors: list })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/editor-error',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          // 编辑器前端解析/恢复失败上报：并入 errors 列表（用户可见）+ 可被
          // femwa-mount/run 工具结果带回主模型，杜绝「静默吞错」。
          const raw = await readBody(req) as unknown as Record<string, unknown>
          const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
          const message = typeof raw.message === 'string' ? raw.message.trim() : ''
          const source = typeof raw.source === 'string' && raw.source.length > 0 ? raw.source : 'editor'
          if (sessionId.length === 0 || message.length === 0) {
            writeJson(res, 400, { ok: false, error: 'sessionId and message are required' })
            return
          }
          recordError(sessionId, `[编辑器·${source}] ${message}`)
          writeJson(res, 200, { ok: true })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/actors',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // Script actors of one session's latest run, for the view menu.
        // 内存命中优先（flow_start 写入）；miss 时从 turn_scopes 文件回退——
        // runState 是内存态，3081 重启后为空会导致视角菜单丢失全部角色项
        // （2026-08-23 bug；与 projection-windows 的文件回退同源对称）。
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')
        if (sessionId === null || sessionId.length === 0) {
          writeJson(res, 200, { ok: true, actors: [] })
          return
        }
        const mem = runState.sessionActors.get(sessionId)
        if (mem !== undefined && mem.length > 0) {
          writeJson(res, 200, { ok: true, actors: mem })
          return
        }
        void readTurnScopeFile(resolved.femwaRoot, sessionId).then((record) => {
          const actors = [...new Set(Object.values(record).flat())]
          writeJson(res, 200, { ok: true, actors })
        }).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/session-script',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          // 会话剧本记录写（两种形态）：
          //  - {sessionId, fems}：画布编辑防抖的原文快照（保留已有地址）
          //  - {sessionId, scriptPath}：导出/导入获得地址 → 只存地址（清原文）
          const raw = await readBody(req) as unknown as Record<string, unknown>
          const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.trim().length > 0 ? raw.sessionId : ''
          if (sessionId.length === 0) {
            writeJson(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          const prev = await readSessionScript(resolved.femwaRoot, sessionId)
          const scriptPath = typeof raw.scriptPath === 'string' && raw.scriptPath.trim().length > 0 ? raw.scriptPath.trim() : ''
          const fems = typeof raw.fems === 'string' && raw.fems.trim().length > 0 ? raw.fems : ''
          const baseRev = typeof raw.baseRev === 'number' ? raw.baseRev : undefined
          const pageId = typeof raw.pageId === 'string' ? raw.pageId : ''
          if (scriptPath.length > 0) {
            // 保存动作：会话记录替换为地址，不保留原文（导出/导入=显式动作，无条件写）。
            const result = await writeSessionScript(resolved.femwaRoot, sessionId, { path: scriptPath })
            broadcastSse('script_changed', { sessionId })
            writeJson(res, 200, { ok: true, rev: result.ok ? result.rev : undefined })
          } else if (fems.length > 0) {
            // 画布编辑防抖：写原文，保留已有地址。带 baseRev → 乐观锁：
            // 多端并发编辑后写者输 → 409 + 服务端当前记录，前端弹窗让用户裁决。
            const result = await writeSessionScript(
              resolved.femwaRoot,
              sessionId,
              { ...prev?.path === undefined ? {} : { path: prev.path }, text: fems },
              baseRev,
            )
            if (!result.ok) {
              writeJson(res, 409, { ok: false, error: 'conflict', record: result.record })
              return
            }
            // 广播其他端重载（pageId=写者自身，前端跳过自己的广播防回环）。
            broadcastSse('script_changed', { sessionId, pageId })
            writeJson(res, 200, { ok: true, rev: result.rev })
          } else {
            writeJson(res, 400, { ok: false, error: 'fems or scriptPath is required' })
            return
          }
        })().catch((error: unknown) => {
          // 防御：响应已发出后再出错，绝不能二次 writeJson（ERR_HTTP_HEADERS_SENT
          // 会作为 unhandledRejection 把整个 dsh 进程带崩——2026-08-21 实测教训）。
          if (res.headersSent) {
            console.warn('[dsh-femwa] session-script handler failed after response:', String(error))
            return
          }
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/session-state',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          // femGen 恢复面：剧本快照存在性 + 断点位置（含 [END]/[BREAK] 的
          // 存量 checkpoint 顺带清理——终点点永不作为续跑位置）。
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId')
          if (sessionId === null || sessionId.length === 0) {
            writeJson(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          const record = await readSessionScript(resolved.femwaRoot, sessionId)
          const script = await readSessionScriptText(resolved.femwaRoot, sessionId)
          let checkpoint = await readCheckpoint(resolved.femwaRoot, sessionId)
          let dirty = false
          for (const [key, value] of Object.entries(checkpoint)) {
            if (value === '[END]' || value === '[BREAK]') {
              delete checkpoint[key]
              dirty = true
            }
          }
          if (dirty) {
            if (Object.keys(checkpoint).length === 0) {
              await clearCheckpoint(resolved.femwaRoot, sessionId)
            } else {
              await writeCheckpoint(resolved.femwaRoot, sessionId, checkpoint)
            }
          }
          writeJson(res, 200, {
            ok: true,
            hasScript: script !== undefined,
            script: script ?? undefined,
            scriptPath: record?.path ?? undefined,
            rev: record?.rev ?? 0,
            checkpoint,
            running: runState.running && String(runState.sessionId ?? '') === sessionId,
          })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/events',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // SSE：引擎事件实时推送给 femGen 可视化画布（呼吸灯/节点详情/流式文本）。
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(': connected\n\n')
        // 重放已发生的运行事件（运行中打开编辑器标签时画布立即呈现实时状态）。
        for (const event of runState.lastEvents) {
          res.write(`data: ${JSON.stringify({ type: event.type, data: event.data ?? {} })}\n\n`)
        }
        sseClients.add(res)
        const cleanup = (): void => { sseClients.delete(res) }
        req.on('close', cleanup)
        res.on('close', cleanup)
        // 心跳注释行：防代理/浏览器把空闲连接判死。
        const heartbeat = setInterval(() => {
          try {
            res.write(': ping\n\n')
          } catch {
            clearInterval(heartbeat)
          }
        }, 15_000)
        res.on('close', () => clearInterval(heartbeat))
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/pick-directory',
      handler: (_req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          // 导出流程：让用户选剧本保存目录（dsh directory-picker seam：
          // native=系统目录选择对话框 / browse=应用内浏览）。返回目录绝对路径。
          const picker = ctx.get('directoryPicker') as
            | { capability(): { kind: string; pick?(signal: AbortSignal): Promise<string | null>; list?(path?: string): Promise<unknown> } }
            | undefined
          if (picker === undefined) {
            writeJson(res, 500, { ok: false, error: 'directoryPicker service unavailable' })
            return
          }
          const cap = picker.capability()
          if (cap.kind === 'native' && typeof cap.pick === 'function') {
            const dir = await cap.pick(new AbortController().signal)
            writeJson(res, 200, { ok: true, directory: dir })
          } else {
            // browse 后端无系统对话框：让前端填路径（此处仅声明能力不足）。
            writeJson(res, 501, { ok: false, error: 'directoryPicker backend is browse; path entry unsupported yet', kind: cap.kind })
          }
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/debug-log',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // 前端诊断上报通道（2026-08-23 视角切换卡死调查）：前端在关键链路
        // （pickView/openSession/menu 等）调用本路由，把足迹落进 host 日志，
        // 使「前端卡死时到底走到哪一步」在 host 侧可见。
        const url = new URL(req.url ?? '/', 'http://localhost')
        const msg = (url.searchParams.get('msg') ?? '').slice(0, 300)
        console.log(`[dsh-femwa][front] ${msg}`)
        writeJson(res, 200, { ok: true })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/projection-windows',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // 视角菜单数据源：主会话的上帝窗 + 角色窗 id 列表。
        // 返回前先按水位补齐上帝窗缺失的主会话对话（重启缝隙），打开即全。
        void (async () => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId')
          if (sessionId === null || sessionId.length === 0) {
            writeJson(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          // 重启后 registry 是内存态（空）：投影窗 id 规则化可推导，从持久化
          // 会话 + turn_scopes 文件（历史演员名单）重建注册表，视角菜单重启
          // 即可用，不依赖"再跑一次剧本"。
          let windows = projections.get(sessionId)
          if (windows === undefined) {
            // 主会话未加载时不建窗：cwd 绝不能落到 process.cwd()——否则投影窗
            // 会建进错误的 workspace 分组，与原窗形成 duplicate session id，
            // 整个 workspace 拒绝加载（2026-08-23 事故）。前端 catch 后降级重试。
            const main = sessionsStore?.get(SessionId(sessionId))
            const cwd = (main?.header as { cwd?: string } | undefined)?.cwd
            if (main === undefined || cwd === undefined) {
              writeJson(res, 503, { ok: false, error: 'main session not loaded yet; reopen the main session and retry' })
              return
            }
            const scopeMap = await readTurnScopeFile(resolved.femwaRoot, sessionId)
            const actors = [...new Set(Object.values(scopeMap).flat())]
            windows = await projections.ensure(sessionId, actors, cwd)
          }
          // 按水位补齐上帝窗缺失的主会话对话（重启缝隙），打开即全。
          await godMirror.ensureGodMirrorUpToDate(sessionId)
          const actors: Record<string, string> = {}
          for (const [actor, win] of windows.actors) actors[actor] = String(win.id)
          writeJson(res, 200, {
            ok: true,
            god: windows.god === undefined ? undefined : String(windows.god.id),
            actors,
          })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/projection-input',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          // 投影窗输入（本次：消息 append 到投影窗表面显示，不路由）。
          // 后续 todo 接入真实路由（发给谁/打断）。
          const raw = await readBody(req) as Record<string, unknown>
          const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.trim().length > 0 ? raw.sessionId : ''
          const text = typeof raw.text === 'string' && raw.text.trim().length > 0 ? raw.text.trim() : ''
          if (sessionId.length === 0 || text.length === 0) {
            writeJson(res, 400, { ok: false, error: 'sessionId and text are required' })
            return
          }
          const sessions = ctx.get('sessions') as { get(id: SessionId): Session | undefined } | undefined
          const win = sessions?.get(SessionId(sessionId))
          if (win === undefined) {
            writeJson(res, 404, { ok: false, error: `session ${sessionId} not found` })
            return
          }
          // 打开当前 turn（无则新开），append user 消息（surface）。
          const lastTurn = [...win.events].reverse().find(e => e.type === 'turn/start')
          const turn = lastTurn === undefined ? 1 : (lastTurn.data as { turn?: number }).turn ?? 1
          appendEvent(win, 'user/message', {
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }, { surfaceOp: 'append' })
          writeJson(res, 200, { ok: true })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    console.log('[dsh-femwa] create-session + scripts + save-script + script + errors routes registered')
  } else {
    console.log('[dsh-femwa] webServer unavailable; routes not registered')
  }
}
