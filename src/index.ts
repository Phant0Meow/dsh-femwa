/**
 * dsh-femwa — FemWA integration for DeepSeek Harness.
 *
 * M2 version. Scope (on top of M1):
 *   1. Fem sessions via sidebar button (POST /dsh-femwa/create-session),
 *      optionally with a `fems` script body that auto-starts the engine.
 *   2. No main model: pre-step rejects for Fem sessions; user + plugin
 *      messages surface as user/message events for the chat window.
 *   3. Engine bridge: managed Python subprocess (femwa_bridge.py), NDJSON
 *      over stdio. run/pause/resume/stop/human_input/list_scripts/ping/
 *      shutdown. LLM key resolved from ctx.credentials per run.
 *   4. Event bridge: engine events are re-emitted as cordis
 *      'dsh-femwa/event'; ai_done/flow_done/flow_error/human_wait turn into
 *      chat messages on the session that started the run.
 *   5. Input bridge: user messages on the running Fem session are forwarded
 *      as human input while a human node waits, or hard-stop the run
 *      (interrupt semantics) while the engine is working.
 *
 * NOTE: ctx.logger output is not reliably visible in this deployment, so
 * diagnostics also go to console.log.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
// Type-only: pulls the agent-preset domain's event declarations
// ('agent-preset/selected' merge into cordis Events).
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
// Namespace import: `registerSessionEventType` (the runtime event-type
// registration surface) only exists on builds that ship it; on stock builds
// the plugin still loads and live sessions work — only loading history of
// dsh-femwa/chat sessions is unavailable there (see README "dsh 版本要求").
import * as sessionNS from '@deepseek-ai/dsh-session'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/** 插件包根目录：femwaRoot 缺省时指向插件自身（自包含布局，整个文件夹搬走即用）。 */
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

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

/** Required services: agent registry + session store. */
export const inject = ['agents', 'sessions']

export const Config = z.object({
  /** Master switch. */
  enabled: z.boolean().default(true),
  /** FemWA 引擎根目录（femCompiler/femBridges/func_code/python 所在）。缺省 = 插件包根（自包含）。 */
  femwaRoot: z.string().default(''),
  /** Python executable used to launch the bridge. */
  python: z.string().default('python'),
  /** Provider/model/URL for the engine's AI nodes (llmBridge args). */
  provider: z.string().default('deepseek'),
  model: z.string().default('deepseek-v4-flash'),
  apiUrl: z.string().default('https://api.deepseek.com/v1/chat/completions'),
  /** Credential reference (env name) for the engine's LLM key. */
  apiKeyRef: z.string().default('DEEPSEEK_API_KEY'),
  /** M5: dsh LLM provider route for subagents (dsh adapter name). */
  dshProvider: z.string().default('deepseek-official'),
  /** M5: route every AI node through a dsh subagent (native tool calls + cot). */
  dshAiBackend: z.boolean().default(true),
  /**
   * Per-Actor tool access default. The 剧本 author decides per actor with
   * `tools: true/false` (or `tools: [name, ...]` as a whitelist); an actor
   * that declares nothing falls back to this global default. Default TRUE —
   * the plugin also runs coding workflows, so工具能力 must not vanish
   * unless a script opts out.
   */
  defaultActorTools: z.boolean().default(true),
  /**
   * Global附加 tool whitelist applied on top of the actor's own access
   * (empty = no extra restriction). Actor whitelists (tools: [..]) win over
   * this for the actor that declares them.
   */
  toolWhitelist: z.array(z.string()).default([]),
  /** Subagent provider name (spawn = fresh child, zero parent context). */
  subagentProvider: z.string().default('spawn'),
  /**
   * Subagent IDLE timeout: a child that keeps producing events (reasoning
   * chunks, tool calls, streamed text) is alive no matter how long it runs —
   * multi-turn tool workflows can legitimately take tens of minutes, so there
   * is NO total-duration cap. Only a child that goes silent for this long is
   * presumed hung and aborted.
   */
  subagentIdleTimeoutMs: z.number().default(120_000),
})

/** Fem sessions carry this agentPreset marker in their session header. */
const FEM_PRESET = 'dsh-femwa'

/** Welcome message steered into every fresh Fem session. */
const WELCOME_TEXT = '🤖 Fem 模式会话已创建。发条消息试试：消息会显示在窗口里，但不会有 AI 回复（本会话没有主模型）。'

/** Guide shown once per Fem session that came from the UI preset menu. */
const GUIDE_TEXT = '🎭 已切换到 Fem 剧本模式：本会话没有主模型，直接发言不会得到 AI 回复。请打开本会话顶部的「Fem 剧本」面板（或侧边栏 🎭 按钮）输入/选择 .fems 剧本并运行，角色才会登场。'

/**
 * Session-level preset overrides: the session header is a deep-frozen
 * creation fact, so a preset picked from the UI menu (agentPreset.select →
 * recompose) never rewrites it — the switch only lands as an
 * 'agent-preset/selected' log event. Mirrors dsh-agent-presets'
 * resolveSessionPreset: newest selection wins, header is the fallback.
 */
const presetOverrides = new Map<string, string>()

/** One session's frozen creation facts, the minimum presetOf needs. */
interface PresetBearingIdentity {
  readonly id: SessionId
  readonly header: { readonly agentPreset?: string }
}

/** The preset one session actually runs (override first, header fallback). */
function presetOf(session: PresetBearingIdentity): string | undefined {
  return presetOverrides.get(String(session.id)) ?? session.header.agentPreset
}

/** Whether an agent belongs to a Fem session (subagents excluded: they
 * inherit the parent's agentPreset but must run normally). */
function isFemAgent(agent: Agent): boolean {
  return presetOf(agent.session) === FEM_PRESET
    && agent.session.header.parentSession === undefined
}

/** Steer the welcome message into a fresh Fem session (turns it non-blank). */
function kickWelcome(agent: Agent): void {
  setTimeout(() => {
    try {
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: WELCOME_TEXT }],
        source: { kind: 'plugin', plugin: 'dsh-femwa' },
      }))
      console.log(`[dsh-femwa] steered welcome into ${agent.id}`)
    } catch (error: unknown) {
      console.log(`[dsh-femwa] FAILED to steer welcome: ${String(error)}`)
    }
  }, 1500)
}

// ── HTTP helpers (create-session route) ───────────────────────────────────

/** POST /dsh-femwa/create-session body. */
interface CreateSessionBody {
  cwd?: unknown
  fems?: unknown
  scriptPath?: unknown
  /** POST /dsh-femwa/run only: the Fem session to play the script on. */
  sessionId?: unknown
}

/** POST /dsh-femwa/save-script body. */
interface SaveScriptBody {
  name?: unknown
  content?: unknown
}

/** Read a JSON request body (empty body tolerated). */
async function readBody(req: IncomingMessage): Promise<CreateSessionBody> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text) as CreateSessionBody
  } catch {
    return {}
  }
}

/** Write a JSON response. */
function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

// ── SSE broadcast（femGen 可视化运行的实时事件通道）───────────────────────

/** /dsh-femwa/events 长连接集合（浏览器 EventSource）。 */
const sseClients = new Set<ServerResponse>()

/** 向所有 SSE 客户端广播一个事件（画布可视化运行按 node_name 匹配节点）。 */
function broadcastSse(eventType: string, data: unknown): void {
  const payload = `data: ${JSON.stringify({ type: eventType, data: data ?? {} })}\n\n`
  for (const res of sseClients) {
    try {
      res.write(payload)
    } catch {
      sseClients.delete(res)
    }
  }
}

// ── FemWA bridge client (managed Python subprocess) ──────────────────────

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

class FemwaBridge {
  private handle: SubprocessHandle | undefined
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private lineBuf = ''

  get alive(): boolean {
    return this.handle !== undefined
  }

  /** Spawn the bridge and wire stdout line parsing. */
  start(ctx: Context, config: { python: string; femwaRoot: string }): void {
    if (this.handle !== undefined) return
    const subprocess = ctx.get('subprocess') as {
      resolveExecutable(command: string, env?: Record<string, string>, signal?: AbortSignal): Promise<string>
      spawn(spec: unknown): SubprocessHandle
    } | undefined
    if (subprocess === undefined) {
      console.log('[dsh-femwa] subprocess service unavailable; bridge not started')
      return
    }
    // Bridge lives inside the FemWA project itself (self-contained plugin):
    // <femwaRoot>/python/femwa_bridge.py
    const bridgePath = join(config.femwaRoot, 'python', 'femwa_bridge.py')
    void subprocess.resolveExecutable(config.python).then((pythonPath) => {
      const handle = subprocess.spawn({
        argv: [pythonPath, bridgePath, '--fe4m', config.femwaRoot],
        cwd: config.femwaRoot,
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          // 'pipe' (not collect): the caller owns the stream and forwards
          // tracebacks live; a collect buffer would swallow them silently.
          stderr: 'pipe',
        },
        graceMs: 3000,
        env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      this.handle = handle
      handle.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
      // Bridge stderr (Python tracebacks) must not vanish: forward every line.
      handle.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length === 0) continue
          console.log(`[femwa-engine:stderr] ${line}`)
        }
      })
      handle.done.then((outcome) => {
        console.log(`[dsh-femwa] bridge exited: code=${outcome.exitCode} signal=${outcome.signal}`)
        for (const [, pending] of this.pending) {
          pending.reject(new Error(`bridge exited (code=${outcome.exitCode})`))
        }
        this.pending.clear()
        this.handle = undefined
      }, (error: unknown) => {
        console.log(`[dsh-femwa] bridge spawn failed: ${String(error)}`)
        this.handle = undefined
      })
      console.log(`[dsh-femwa] bridge started (pid=${handle.pid})`)
    }, (error: unknown) => {
      console.log(`[dsh-femwa] python resolve failed: ${String(error)}`)
    })
  }

  /** Send one command; resolves with the bridge's response result. */
  send(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<unknown> {
    const handle = this.handle
    if (handle === undefined) return Promise.reject(new Error('bridge not running'))
    const id = this.nextId++
    const payload = `${JSON.stringify({ id, cmd, args })}\n`
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bridge command "${cmd}" timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      handle.stdin?.write(payload, (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(error)
        }
      })
    })
  }

  /** Terminate the bridge process tree (graceful shutdown command first). */
  async stop(): Promise<void> {
    const handle = this.handle
    if (handle === undefined) return
    try {
      await this.send('shutdown', {}, 2000)
    } catch {
      // fall through to terminate
    }
    handle.terminate()
    await handle.waitForExit()
    this.handle = undefined
  }

  private onData(chunk: Buffer): void {
    this.lineBuf += chunk.toString('utf8')
    let idx: number
    while ((idx = this.lineBuf.indexOf('\n')) !== -1) {
      const line = this.lineBuf.slice(0, idx).trim()
      this.lineBuf = this.lineBuf.slice(idx + 1)
      if (line.length === 0) continue
      // FemWA's own prints share stdout; only JSON protocol lines parse.
      // Engine prints (the engine's debugging voice) are forwarded so the
      // harness log can see what the engine saw — they used to be dropped.
      if (!line.startsWith('{')) {
        console.log(`[femwa-engine] ${line}`)
        continue
      }
      let msg: {
        type?: string; id?: number; ok?: boolean; result?: unknown; error?: unknown
        event?: string; data?: unknown
      }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        continue
      }
      if (msg.type === 'response') {
        const rid = msg.id
        if (rid === undefined) continue
        const pending = this.pending.get(rid)
        if (pending === undefined) continue
        this.pending.delete(rid)
        if (msg.ok === true) pending.resolve(msg.result)
        else pending.reject(new Error(String(msg.error ?? 'bridge error')))
      } else if (msg.type === 'event') {
        ;(this as unknown as { emit(name: string, ...args: unknown[]): void }).emit('dsh-femwa/event', msg.event, msg.data)
      }
    }
  }
}

// ── plugin body ───────────────────────────────────────────────────────────

interface ResolvedConfig {
  enabled: boolean
  femwaRoot: string
  python: string
  provider: string
  model: string
  apiUrl: string
  apiKeyRef: string
  dshProvider: string
  dshAiBackend: boolean
  defaultActorTools: boolean
  toolWhitelist: string[]
  subagentProvider: string
  subagentIdleTimeoutMs: number
}

function resolveConfig(config: unknown): ResolvedConfig {
  const c = (config ?? {}) as Partial<ResolvedConfig>
  return {
    enabled: c.enabled ?? true,
    femwaRoot: c.femwaRoot && c.femwaRoot.length > 0 ? c.femwaRoot : packageRoot,
    python: c.python ?? 'python',
    provider: c.provider ?? 'deepseek',
    model: c.model ?? 'deepseek-v4-flash',
    apiUrl: c.apiUrl ?? 'https://api.deepseek.com/v1/chat/completions',
    apiKeyRef: c.apiKeyRef ?? 'DEEPSEEK_API_KEY',
    dshProvider: c.dshProvider ?? 'deepseek-official',
    dshAiBackend: c.dshAiBackend ?? true,
    toolWhitelist: c.toolWhitelist ?? [],
    defaultActorTools: c.defaultActorTools ?? true,
    subagentProvider: c.subagentProvider ?? 'spawn',
    subagentIdleTimeoutMs: c.subagentIdleTimeoutMs ?? 120_000,
  }
}

export async function apply(ctx: Context, config: unknown): Promise<void> {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) {
    console.log('[dsh-femwa] disabled by config')
    return
  }

  // Admit 'dsh-femwa/chat' into the session event vocabulary at runtime (the
  // persistence read path otherwise refuses logs containing it). Registration
  // must precede any session load, so it happens at apply time. Only builds
  // that ship the registration surface (upstreamed feature / meow fork) have
  // it; on stock builds the plugin keeps working for live sessions.
  const registerSessionEventType = (sessionNS as { registerSessionEventType?: (type: string) => () => void }).registerSessionEventType
  if (registerSessionEventType !== undefined) {
    ctx.effect(() => registerSessionEventType('dsh-femwa/chat'), 'dsh-femwa: session event type')
  } else {
    console.log('[dsh-femwa] this dsh build lacks registerSessionEventType; loading history of dsh-femwa/chat sessions is unsupported here (see README)')
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

  const bridge = new FemwaBridge()
  ;(bridge as unknown as { emit(name: string, ...args: unknown[]): void }).emit = (name, ...args) => {
    ;(ctx.emit as (name: string, ...args: unknown[]) => void)(name, ...args)
  }

  // Run-state bookkeeping: which session owns the current engine run, and
  // whether a human node is waiting for input.
  const runState: {
    sessionId?: SessionId
    running: boolean
    humanWait?: { waitKey: string; nodeName?: string }
    /** Engine node id -> character name (from context_ready ai_name). */
    nodeActors: Map<string, string>
    /** Engine node id -> visible actor names (from node_start scope). */
    nodeScopes: Map<string, string[]>
    /** Per-session script actors (flow_start) for the view-perspective menu. */
    sessionActors: Map<string, string[]>
    /** Per-session engine errors (meta info for the Fem script panel). */
    errors: Map<string, Array<{ ts: number; text: string }>>
  } = {
    running: false,
    nodeActors: new Map(),
    nodeScopes: new Map(),
    sessionActors: new Map(),
    errors: new Map(),
  }

  const recordError = (sessionId: SessionId, text: string): void => {
    const key = String(sessionId)
    const list = runState.errors.get(key) ?? []
    list.push({ ts: Date.now(), text })
    if (list.length > 50) list.shift()
    runState.errors.set(key, list)
    console.log(`[dsh-femwa] error on ${key}: ${text}`)
  }

  /** Fem sessions that already got the write-your-script guide. */
  const guidedSessions = new Set<string>()

  // 1) Fem sessions never reach a model request: reject every pre-step, but
  //    first log the messages as user/message events so the frontend displays
  //    them (a plain reject leaves them only in the inbox, invisible in chat).
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision === undefined || signal.aborted) return decision
    if (decision.kind !== 'enter') return decision
    if (!isFemAgent(agent)) return decision
    for (const message of decision.messages) {
      const source = message.source as { kind?: string; plugin?: string }
      if (source.kind === 'user') {
        // user message: append as-is
      } else if (source.kind === 'plugin' && source.plugin === 'dsh-femwa') {
        // our own welcome/role message: append as-is
      } else {
        continue
      }
      try {
        agent.session.append('user/message', message, { surfaceOp: 'append' })
      } catch (error: unknown) {
        console.log(`[dsh-femwa] append user/message failed: ${String(error)}`)
      }
    }
    // Guide the user once per session: a Fem session picked from the UI
    // preset menu has no welcome steer (that is the create-session route's
    // job), so the first rejected message is where the stage directions go.
    if (!guidedSessions.has(String(agent.session.id))) {
      guidedSessions.add(String(agent.session.id))
      appendChat(ctx, agent.session, GUIDE_TEXT, 'notice')
    }
    console.log(`[dsh-femwa] pre-step REJECTED for fem agent ${agent.id} (${decision.messages.length} message(s) withheld from model)`)
    return { kind: 'reject' }
  })

  // Preset switches from the UI menu land as 'agent-preset/selected' log
  // events (recompose does not touch the frozen header); keep a live override
  // so isFemAgent sees the switch. Rebuilt from the log on agent creation so
  // a cold-resumed switched session still rejects.
  ctx.on('agent/created', ({ agent }) => {
    const events = agent.session.events
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'agent-preset/selected') {
        presetOverrides.set(String(agent.session.id), event.data.agentPreset)
        break
      }
    }
  })
  ctx.on('agent-preset/selected', (sessionId: SessionId, agentPreset: string) => {
    presetOverrides.set(String(sessionId), agentPreset)
    console.log(`[dsh-femwa] preset override ${sessionId} -> ${agentPreset}`)
  })

  // 2) Input bridge: user messages on the running Fem session become engine
  //    input — human input while a human node waits, hard stop otherwise
  //    (interrupt semantics: the user typing mid-run means "stop this").
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (presetOf(session) !== FEM_PRESET) return
    if (session.header.parentSession !== undefined) return // subagent sessions
    if (event.type !== 'user/message') return
    const source = event.data.source as { kind?: string } | undefined
    if (source?.kind !== 'user') return
    const text = extractText(event.data.content)
    console.log(`[dsh-femwa] user message on ${session.id}: ${text}`)
    if (runState.sessionId !== session.id || !runState.running) return // idle session: ignore
    if (runState.humanWait !== undefined) {
      // Human node waiting: forward as normal input.
      void bridge.send('human_input', {
        wait_key: runState.humanWait.waitKey,
        body: { chat_text: text, variables: {} },
      }).catch((error: unknown) => {
        console.log(`[dsh-femwa] human_input forward failed: ${String(error)}`)
      })
      console.log(`[dsh-femwa] forwarded user text to human node ${runState.humanWait.nodeName ?? runState.humanWait.waitKey}`)
    } else {
      // Engine working: hard interrupt (stop).
      void bridge.send('stop', {}).catch((error: unknown) => {
        console.log(`[dsh-femwa] stop failed: ${String(error)}`)
      })
      console.log(`[dsh-femwa] hard-stopped run by user message`)
    }
  })

  // 3) Event bridge: engine events -> chat messages on the run's session.
  const sessionsStore = ctx.get('sessions') as { get(id: SessionId): Session | undefined } | undefined
  ctx.on('dsh-femwa/event', (eventType: string, data: unknown) => {
    const sessionId = runState.sessionId
    if (sessionId === undefined) return
    // 可视化运行通道：原样转发引擎事件（画布按 node_name 匹配节点做高亮/详情）。
    broadcastSse(eventType, data)
    const session = sessionsStore?.get(sessionId)
    if (session === undefined) return
    const d = (data ?? {}) as Record<string, unknown>
    switch (eventType) {
      case 'flow_start': {
        // Script actors feed the view-perspective menu.
        const actors = Array.isArray(d.actors)
          ? d.actors.filter((x): x is string => typeof x === 'string')
          : []
        if (actors.length > 0) runState.sessionActors.set(String(sessionId), actors)
        break
      }
      case 'node_start': {
        // Node hint as a chat announcement: human nodes show their prompt
        // (the user needs it); AI node hints ride context_ready's showprompt.
        // Remember the node's visible actor list for later role lines.
        const nodeName = typeof d.node_name === 'string' ? d.node_name : undefined
        const scopeInfo = Array.isArray(d.scope)
          ? d.scope.filter((x): x is string => typeof x === 'string')
          : undefined
        if (nodeName !== undefined && scopeInfo !== undefined) {
          runState.nodeScopes.set(nodeName, scopeInfo)
        }
        const nodeType = d.node_type
        if (nodeType === 'human') {
          const prompt = typeof d.prompt === 'string' && d.prompt.trim().length > 0 ? d.prompt : undefined
          if (prompt !== undefined) {
            appendChat(ctx, session, `📢 ${prompt}`, 'prompt', undefined, nodeName === undefined ? undefined : runState.nodeScopes.get(nodeName))
          }
        }
        break
      }
      case 'context_ready': {
        // Remember the character name for this engine node (ai_done only
        // carries the node id), and announce the AI node's showprompt.
        const nodeName = typeof d.node_name === 'string' ? d.node_name : undefined
        const aiName = typeof d.ai_name === 'string' && d.ai_name.length > 0 ? d.ai_name : undefined
        if (nodeName !== undefined && aiName !== undefined) {
          runState.nodeActors.set(nodeName, aiName)
        }
        const showprompt = typeof d.showprompt === 'string' && d.showprompt.trim().length > 0 ? d.showprompt : undefined
        if (showprompt !== undefined) {
          appendChat(ctx, session, `📢 ${showprompt}`, 'prompt', undefined, nodeName === undefined ? undefined : runState.nodeScopes.get(nodeName))
        }
        break
      }
      case 'human_wait': {
        runState.humanWait = {
          waitKey: String(d.wait_key ?? ''),
          nodeName: typeof d.node_name === 'string' ? d.node_name : undefined,
        }
        const prompt = typeof d.prompt === 'string' ? d.prompt.slice(0, 120) : ''
        const nodeName = typeof d.node_name === 'string' ? d.node_name : undefined
        appendChat(ctx, session, prompt.length > 0 ? `🎭 等待你的回应：${prompt}` : '🎭 等待你的回应', 'human_wait',
          undefined, nodeName === undefined ? undefined : runState.nodeScopes.get(nodeName))
        break
      }
      case 'human_done': {
        runState.humanWait = undefined
        break
      }
      case 'checkpoint': {
        // 每个分支当前执行到的节点位置：持久化到
        // <femwaRoot>/user_data/checkpoints/<sessionId>.json，供断点续跑。
        const cp = (d.checkpoints ?? {}) as Record<string, string>
        void writeCheckpoint(resolved.femwaRoot, String(sessionId), cp)
          .catch((error: unknown) => console.log(`[dsh-femwa] checkpoint write failed: ${String(error)}`))
        break
      }
      case 'ai_done': {
        const output = typeof d.output === 'string' && d.output.length > 0 ? d.output : undefined
        if (output !== undefined) {
          const nodeName = typeof d.node_name === 'string' ? d.node_name : undefined
          const actor = nodeName === undefined ? undefined : runState.nodeActors.get(nodeName) ?? nodeName
          appendChat(ctx, session, output, 'role', actor, nodeName === undefined ? undefined : runState.nodeScopes.get(nodeName))
        }
        break
      }
      case 'ai_request': {
        // M5: engine wants an AI turn executed by a dsh subagent. Spawn a
        // fresh child (zero parent context), wait for it to finish, assemble
        // the full trajectory (cot only on tool-call turns, matching dsh's
        // passback rule), then deliver { output, trajectory } back to the
        // engine, which stores the trajectory as one long text.
        const reqNode = typeof d.node_name === 'string' ? d.node_name : undefined
        const reqScope = Array.isArray(d.scope_info)
          ? d.scope_info.filter((x): x is string => typeof x === 'string')
          : undefined
        if (reqNode !== undefined && reqScope !== undefined) {
          runState.nodeScopes.set(reqNode, reqScope)
        }
        console.log(`[dsh-femwa] ai_request received node=${String(d.node_name ?? '')} wait_key=${String(d.wait_key ?? '')}`)
        void runAiSubagent(ctx, resolved, bridge, session, d, recordError).catch((error: unknown) => {
          recordError(session.id, `子 agent 执行失败：${String(error)}`)
          void bridge.send('human_input', {
            wait_key: String(d.wait_key ?? ''),
            body: { output: '', trajectory: '' },
          }).catch(() => undefined)
        })
        break
      }
      case 'flow_done': {
        runState.running = false
        // 完整跑完：清掉 checkpoint，下次 run 从头开始
        void clearCheckpoint(resolved.femwaRoot, String(sessionId))
          .catch((error: unknown) => console.log(`[dsh-femwa] checkpoint clear failed: ${String(error)}`))
        appendChat(ctx, session, '✅ 剧本流程结束', 'notice')
        break
      }
      case 'flow_error': {
        // Errors are meta info: record for the Fem script panel AND show a
        // red system-like line in the chat transcript.
        runState.running = false
        const text = `剧本出错：${String(d.error ?? 'unknown error')}`
        recordError(session.id, text)
        appendChat(ctx, session, text, 'error')
        break
      }
      case 'flow_stopped': {
        runState.running = false
        appendChat(ctx, session, '⏹ 剧本已停止', 'notice')
        break
      }
      case 'bridge_run_ended': {
        runState.running = false
        runState.humanWait = undefined
        break
      }
      default:
        break
    }
  })

  // 4) HTTP routes: create-session + script listing (sidebar button calls these).
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
      path: '/dsh-femwa/stop',
      handler: (_req: IncomingMessage, res: ServerResponse): void => {
        // Hard-stop the running workflow (interrupt semantics): the engine
        // keeps its checkpoint file, so the next run resumes from it.
        if (!runState.running) {
          writeJson(res, 200, { ok: true, stopped: false, note: 'no active run' })
          return
        }
        bridge.send('stop', {}, 5000).then(() => {
          writeJson(res, 200, { ok: true, stopped: true })
        }).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    // femGen 画布控制面：pause/resume 目前对应 bridge 的半实现
    // （pause=stop，resume 需要真实 pause 快照——README 已知限制），
    // human-input 是完整可用的（human 节点输入）。
    webServer.register({
      kind: 'exact',
      path: '/dsh-femwa/pause',
      handler: (_req: IncomingMessage, res: ServerResponse): void => {
        bridge.send('pause', {}, 5000).then((result) => {
          writeJson(res, 200, { ok: true, paused: (result as { paused?: boolean } | undefined)?.paused ?? false })
        }).catch((error: unknown) => {
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
          if (waitKey.length === 0 || chatText.length === 0) {
            writeJson(res, 400, { ok: false, error: 'wait_key and chat_text are required' })
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
      path: '/dsh-femwa/actors',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // Script actors of one session's latest run, for the view menu.
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')
        const actors = sessionId === null
          ? (runState.sessionId !== undefined ? (runState.sessionActors.get(String(runState.sessionId)) ?? []) : [])
          : (runState.sessionActors.get(sessionId) ?? [])
        writeJson(res, 200, { ok: true, actors })
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
    console.log('[dsh-femwa] create-session + scripts + save-script + script + errors routes registered')
  } else {
    console.log('[dsh-femwa] webServer unavailable; routes not registered')
  }

  // 5) Bridge lifecycle: start the Python engine subprocess, stop on dispose.
  setTimeout(() => { bridge.start(ctx, resolved) }, 1000)
  ctx.effect(() => () => {
    void bridge.stop()
  }, 'dsh-femwa: bridge lifecycle')
}

/** Extract plain text from a message's content blocks. */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as { type?: string; text?: unknown }
      return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('')
}

/** Append a chat line to a Fem session as a dsh-femwa/chat event.
 * @param visible - actor names this line is visible to (the action's scope);
 * absent = visible to everyone (used by role/prompt/human_wait lines whose
 * scope is unknown); caller omits it for god-only meta lines (notice/error/
 * thinking), which the frontend hides in role views. */
function appendChat(
  ctx: Context,
  session: Session,
  text: string,
  kind: 'role' | 'notice' | 'human_wait' | 'prompt' | 'error' | 'thinking' = 'notice',
  actor?: string,
  visible?: string[],
): void {
  try {
    session.append('dsh-femwa/chat', {
      ...actor === undefined ? {} : { actor },
      text,
      kind,
      ...visible === undefined ? {} : { visible },
    })
  } catch (error: unknown) {
    console.log(`[dsh-femwa] appendChat failed: ${String(error)}`)
  }
}

/** Assemble the subagent's initial prompt from the engine's blocks. */
function buildSubagentPrompt(blocks: Record<string, unknown>): string {
  const str = (key: string): string => (typeof blocks[key] === 'string' ? String(blocks[key]) : '')
  const system = [
    str('basic_safety'),
    str('basic_output'),
    str('soul'),
    str('user_info'),
  ].filter(Boolean).join('\n\n')
  const parts = [str('context'), str('prompt')]
  const memory = str('memory')
  if (memory.length > 0) {
    parts.push('---\n[回忆]\n根据以上情况，你偶然回忆起了以下记忆，可能有用也可能无用：', memory, str('prompt'))
  }
  const user = parts.filter(Boolean).join('\n\n')
  return [system, user].filter(Boolean).join('\n\n')
}

/** Extract plain text from content blocks (text + tool-result content). */
function blocksToText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    const b = block as { type?: string; text?: unknown; content?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') return b.text
    if (b.type === 'tool-result' && Array.isArray(b.content)) return blocksToText(b.content)
    return ''
  }).join('')
}

/**
 * Assemble the child's full trajectory as one long text. cot (reasoning) is
 * kept ONLY on turns that carried tool calls — the same rule dsh's deepseek
 * serialization applies — so pure-text thinking never enters Fem memory.
 * `thinking` returns ALL reasoning (display is separate from storage).
 */
function buildTrajectory(events: readonly SessionEvent[]): { output: string; trajectory: string; thinking: string } {
  const lines: string[] = []
  const thoughts: string[] = []
  let output = ''
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const content = (event.data.message as { content: unknown }).content
      if (!Array.isArray(content)) continue
      const text = content.filter(b => (b as { type?: string }).type === 'text')
        .map(b => String((b as { text?: unknown }).text ?? '')).join('')
      const reasoning = content.filter(b => (b as { type?: string }).type === 'reasoning')
        .map(b => String((b as { text?: unknown }).text ?? '')).join('')
      const toolCalls = content.filter(b => (b as { type?: string }).type === 'tool-call')
      if (reasoning.length > 0 && toolCalls.length > 0) lines.push(`[思考]\n${reasoning}`)
      if (reasoning.length > 0) thoughts.push(reasoning)
      if (text.length > 0) {
        lines.push(`[回复]\n${text}`)
        output = text
      }
    } else if (event.type === 'tool/result') {
      const message = (event.data as { message?: { content?: unknown } }).message
      if (message === undefined) continue
      const resultText = blocksToText(message.content)
      if (resultText.length > 0) lines.push(`[工具结果]\n${resultText}`)
    }
  }
  return { output, trajectory: lines.join('\n\n'), thinking: thoughts.join('\n\n') }
}

/** Assemble one AI node's subagent tool filter from actor + config. */
function toolFilterOf(
  resolved: ResolvedConfig,
  request: Record<string, unknown>,
): { toolFilter: { allow: string[] } } | Record<string, never> {
  const actorTools = typeof request.actor_tools === 'boolean'
    ? request.actor_tools
    : resolved.defaultActorTools
  if (!actorTools) {
    // Actor opted out (or default false): no tools at all.
    return { toolFilter: { allow: [] } }
  }
  // Actor declares a whitelist (tools: [..]); otherwise the global附加
  // whitelist; otherwise the preset's full tool set (no filter).
  const list = Array.isArray(request.actor_tool_list)
    ? request.actor_tool_list.filter((x): x is string => typeof x === 'string')
    : []
  const whitelist = list.length > 0 ? list : resolved.toolWhitelist
  return whitelist.length > 0 ? { toolFilter: { allow: whitelist } } : {}
}

/** One engine AI turn executed through a dsh subagent. */
async function runAiSubagent(
  ctx: Context,
  resolved: ResolvedConfig,
  bridge: FemwaBridge,
  session: Session,
  request: Record<string, unknown>,
  recordError: (sessionId: SessionId, text: string) => void,
): Promise<void> {
  const waitKey = String(request.wait_key ?? '')
  if (waitKey.length === 0) return
  const subagents = ctx.get('subagents') as {
    start(name: string, req: unknown): Promise<{
      id: SessionId
      result: Promise<{ output: unknown; stopReason: string }>
      dispose(): Promise<void>
      localAgent?: { ctx: Context; session: { events: readonly SessionEvent[] } }
    }>
  } | undefined
  if (subagents === undefined) {
    throw new Error('subagents service unavailable')
  }
  const parent = ctx.agents.get(session.id)
  if (parent === undefined) {
    throw new Error(`parent agent for ${session.id} is not live`)
  }
  const blocks = (request.blocks ?? {}) as Record<string, unknown>
  const prompt = buildSubagentPrompt(blocks)
  // Debug voice: what one AI node feeds its subagent (context length answers
  // "did the scope filter leak / go empty" for this very node).
  const blk = (key: string): string => typeof blocks[key] === 'string' ? String(blocks[key]) : ''
  console.log(`[dsh-femwa] ai_request node=${String(request.node_name ?? '')} scope=${String(request.scope ?? '')}`
    + ` blocks: context=${blk('context').length}ch soul=${blk('soul').length}ch memory=${blk('memory').length}ch prompt=${blk('prompt').length}ch`)
  console.log(`[dsh-femwa] subagent prompt (${prompt.length}ch): ${prompt.slice(0, 300).replace(/\n/g, '\\n')}`)
  // A hung child must not wedge the engine node forever — but "hung" means
  // SILENT, not slow: a child that keeps emitting events (reasoning chunks,
  // tool calls, streamed text) is alive however long it runs, so the abort
  // timer is an idle watchdog that rearms on every child-session event.
  const controller = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      controller.abort(new Error(`子 agent 空闲超时（${Math.round(resolved.subagentIdleTimeoutMs / 1000)}s 无输出）`))
    }, resolved.subagentIdleTimeoutMs)
  }
  const run = await subagents.start(resolved.subagentProvider, {
    label: `fem-node-${String(request.node_name ?? '')}`,
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal: controller.signal,
    agentOptions: { provider: resolved.dshProvider, model: resolved.model },
    // Actor-level tool access: the script's `tools: true/false` on the actor
    // wins; undeclared actors fall back to defaultActorTools (default true so
    // coding workflows keep their tools). An enabled actor with no whitelist
    // inherits the preset's full tool set (no filter); a disabled actor gets
    // an empty allow-list (no tools at all).
    ...toolFilterOf(resolved, request),
  })
  // Watchdog starts once the child exists; every child-session event rearms
  // it. Listener is scoped to the child's session id and disposed in finally.
  armIdle()
  const onChildEvent = (watched: Session, watchedEvent: SessionEvent): void => {
    if (String(watched.id) !== String(run.id)) return
    armIdle()
    // 流式 token → 画布打字机（只转发正文增量，不转发思考/用量）。
    if (watchedEvent.type === 'assistant/chunk') {
      const chunk = (watchedEvent.data as { chunk?: { type?: string; text?: unknown } }).chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        broadcastSse('ai_token', { node_name: String(request.node_name ?? ''), token: chunk.text })
      }
    }
  }
  const disposeListener = ctx.on('session/event', onChildEvent)
  try {
    const result = await run.result
    let output = typeof result.output === 'string' ? result.output : ''
    let trajectory = ''
    let thinking = ''
    if (run.localAgent !== undefined) {
      const built = buildTrajectory(run.localAgent.session.events)
      trajectory = built.trajectory.length > 0 ? built.trajectory : output
      thinking = built.thinking
      if (output.length === 0 && built.output.length > 0) output = built.output
    }
    if (result.stopReason !== 'completed' && result.stopReason !== 'max-tokens') {
      recordError(session.id, `子 agent 结束异常：${result.stopReason}`)
    }
    // Display the thinking chain (folded) BEFORE the role line.
    if (thinking.length > 0) {
      appendChat(ctx, session, thinking, 'thinking')
    }
    await bridge.send('human_input', {
      wait_key: waitKey,
      body: { output, trajectory },
    })
    console.log(`[dsh-femwa] subagent done: ${String(request.node_name ?? '')} stop=${result.stopReason} output=${output.length}ch thinking=${thinking.length}ch`)
    if (output.length > 0) {
      console.log(`[dsh-femwa] subagent output head: ${output.slice(0, 300).replace(/\n/g, '\\n')}`)
    }
  } catch (error: unknown) {
    // Idle timeout or interruption: tell the engine this node produced
    // nothing and let it continue, recording the failure in the panel.
    const message = error instanceof Error ? error.message : String(error)
    recordError(session.id, `子 agent 中断：${message}`)
    console.log(`[dsh-femwa] subagent interrupted: ${String(request.node_name ?? '')} ${message}`)
    await bridge.send('human_input', {
      wait_key: waitKey,
      body: { output: '', trajectory: '' },
    }).catch((sendError: unknown) => {
      console.log(`[dsh-femwa] timeout回传失败: ${String(sendError)}`)
    })
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    disposeListener()
    await run.dispose()
    console.log(`[dsh-femwa] subagent disposed: ${String(request.node_name ?? '')}`)
    // Archive the child session: its trajectory is already stored in Fem's
    // memory, so it only clutters the subagent list (dsh has no session
    // deletion API; archive hides it while keeping the durable log).
    const registry = ctx.get('workspaceRegistry') as { archiveSession?(id: string): Promise<unknown> } | undefined
    if (registry?.archiveSession !== undefined) {
      try {
        await registry.archiveSession(String(run.id))
        console.log(`[dsh-femwa] archived child session ${run.id}`)
      } catch (error: unknown) {
        console.log(`[dsh-femwa] archive child session failed: ${String(error)}`)
      }
    }
  }
}

/** Save a user-pasted script into the FemWA project's user_data/projects. */
async function handleSaveScript(
  req: IncomingMessage,
  res: ServerResponse,
  resolved: { femwaRoot: string },
): Promise<void> {
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  let body: SaveScriptBody = {}
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SaveScriptBody
  } catch {
    writeJson(res, 400, { ok: false, error: 'invalid json body' })
    return
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const content = typeof body.content === 'string' ? body.content : ''
  if (name.length === 0) {
    writeJson(res, 400, { ok: false, error: 'name is required' })
    return
  }
  if (content.trim().length === 0) {
    writeJson(res, 400, { ok: false, error: 'content is required' })
    return
  }
  // Sanitize the file name: keep safe chars, force .fems.
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.fems$/i, '')
  const projectsDir = `${resolved.femwaRoot}\\user_data\\projects`
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(projectsDir, { recursive: true })
  const path = `${projectsDir}\\${safe}.fems`
  writeFileSync(path, content, 'utf8')
  console.log(`[dsh-femwa] saved script to ${path}`)
  writeJson(res, 200, { ok: true, path })
}

/** GET /dsh-femwa/script?path=... — read one script file's content. */
async function handleReadScript(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.searchParams.get('path')
  if (path === null || path.trim().length === 0) {
    writeJson(res, 400, { ok: false, error: 'path is required' })
    return
  }
  const { readFileSync } = await import('node:fs')
  try {
    const content = readFileSync(path, 'utf8')
    writeJson(res, 200, { ok: true, content })
  } catch (error: unknown) {
    writeJson(res, 404, { ok: false, error: `cannot read ${path}: ${String(error)}` })
  }
}

/** Read one run's script text from an inline body or a script path. */
async function readScriptText(fems: string | undefined, scriptPath: string | undefined): Promise<string> {
  if (fems !== undefined) return fems
  const { readFileSync } = await import('node:fs')
  return readFileSync(scriptPath!, 'utf8')
}

/** Checkpoint file path: one JSON per Fem session, under the project's user data. */
function checkpointPath(femwaRoot: string, sessionId: string): string {
  return join(femwaRoot, 'user_data', 'checkpoints', `${sessionId}.json`)
}

/** Persist one run's branch positions (branch key → node id). */
async function writeCheckpoint(femwaRoot: string, sessionId: string, checkpoints: Record<string, string>): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const path = checkpointPath(femwaRoot, sessionId)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ sessionId, updatedAt: Date.now(), checkpoints }, null, 2), 'utf8')
}

/** Read the last recorded branch positions, if any. */
async function readCheckpoint(femwaRoot: string, sessionId: string): Promise<Record<string, string>> {
  const { readFile } = await import('node:fs/promises')
  try {
    const raw = await readFile(checkpointPath(femwaRoot, sessionId), 'utf8')
    const parsed = JSON.parse(raw) as { checkpoints?: Record<string, string> }
    return parsed.checkpoints ?? {}
  } catch {
    return {}
  }
}

/** Drop the checkpoint after a completed run (从头开始 is the next run's default). */
async function clearCheckpoint(femwaRoot: string, sessionId: string): Promise<void> {
  const { unlink } = await import('node:fs/promises')
  try {
    await unlink(checkpointPath(femwaRoot, sessionId))
  } catch {
    // absent checkpoint is the common case; nothing to clear
  }
}

/** Resolve the engine's LLM key from dsh credentials (absent → AI nodes fail). */
async function resolveApiKey(ctx: Context, resolved: ResolvedConfig): Promise<string | undefined> {
  const credentials = ctx.get('credentials') as { resolve(ref: unknown): Promise<{ value: string } | undefined> } | undefined
  if (credentials === undefined) return undefined
  const cred = await credentials.resolve(resolved.apiKeyRef)
  return cred !== undefined ? cred.value : undefined
}

/** Start one engine run bound to a Fem session. Registers the run owner
 * BEFORE sending: a tiny script can finish before the run response returns,
 * and events would be dropped. A checkpoint from a previous interrupted run
 * rides along so the engine resumes from the recorded node positions. */
async function startRunOnSession(
  ctx: Context,
  resolved: ResolvedConfig,
  bridge: FemwaBridge,
  runState: { sessionId?: SessionId; running: boolean },
  sessionId: SessionId,
  scriptText: string,
  scriptPath?: string,
): Promise<void> {
  const apiKey = await resolveApiKey(ctx, resolved)
  if (apiKey === undefined) {
    console.log(`[dsh-femwa] credential ${resolved.apiKeyRef} not resolved; AI nodes will fail`)
  }
  const checkpoints = await readCheckpoint(resolved.femwaRoot, String(sessionId))
  if (Object.keys(checkpoints).length > 0) {
    console.log(`[dsh-femwa] resuming ${sessionId} from checkpoint: ${JSON.stringify(checkpoints)}`)
  }
  runState.sessionId = sessionId
  runState.running = true
  try {
    // base_dir = the script's own directory (FemWA CLI semantics): @func
    // relative files (e.g. werewolf_utils.py beside the script) resolve
    // against it. Text-mode scripts fall back to the project root.
    const baseDir = scriptPath !== undefined
      ? scriptPath.replace(/[\\/][^\\/]*$/, '')
      : resolved.femwaRoot
    await bridge.send('run', {
      fems: scriptText,
      base_dir: baseDir,
      user_api_key: apiKey,
      user_api_provider: resolved.provider,
      user_api_url: resolved.apiUrl,
      user_api_model: resolved.model,
      dsh_ai_backend: resolved.dshAiBackend,
      ...Object.keys(checkpoints).length > 0 ? { checkpoints } : {},
    }, 30_000)
  } catch (error: unknown) {
    runState.running = false
    throw error
  }
  console.log(`[dsh-femwa] started script on ${sessionId}${scriptPath !== undefined ? ` (${scriptPath})` : ''}`)
}

/**
 * POST /dsh-femwa/run — play a script on an EXISTING Fem session (the script
 * panel's "save and run" lands here; create-session stays for the sidebar's
 * new-session flow). The session must already be Fem mode: a standard session
 * has a main model and this plugin must not start an engine run behind it.
 */
async function handleRunOnSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  resolved: ResolvedConfig,
  bridge: FemwaBridge,
  runState: { sessionId?: SessionId; running: boolean },
): Promise<void> {
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  const body = await readBody(req)
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim().length > 0
    ? SessionId(body.sessionId)
    : undefined
  if (sessionId === undefined) {
    writeJson(res, 400, { ok: false, error: 'sessionId is required' })
    return
  }
  const sessionsStore = ctx.get('sessions') as { get(id: SessionId): Session | undefined } | undefined
  const session = sessionsStore?.get(sessionId)
  if (session === undefined) {
    writeJson(res, 404, { ok: false, error: `session ${sessionId} not found` })
    return
  }
  if (presetOf(session) !== FEM_PRESET) {
    writeJson(res, 400, { ok: false, error: '当前会话不是 Fem 剧本模式：请先在会话上方的模式菜单选择「Fem 剧本模式」' })
    return
  }
  if (runState.running) {
    writeJson(res, 409, { ok: false, error: '已有剧本在运行中，请先停止' })
    return
  }
  const fems = typeof body.fems === 'string' && body.fems.trim().length > 0 ? body.fems : undefined
  const scriptPath = typeof body.scriptPath === 'string' && body.scriptPath.trim().length > 0 ? body.scriptPath : undefined
  if (fems === undefined && scriptPath === undefined) {
    writeJson(res, 400, { ok: false, error: 'fems or scriptPath is required' })
    return
  }
  try {
    const scriptText = await readScriptText(fems, scriptPath)
    await startRunOnSession(ctx, resolved, bridge, runState, sessionId, scriptText, scriptPath)
    writeJson(res, 200, { ok: true, sessionId: String(sessionId) })
  } catch (error: unknown) {
    console.log(`[dsh-femwa] run-on-session FAILED: ${String(error)}`)
    writeJson(res, 500, { ok: false, error: String(error) })
  }
}

/** Create one Fem session; when a fems script body is supplied, start it. */
async function handleCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  resolved: ResolvedConfig,
  bridge: FemwaBridge,
  runState: { sessionId?: SessionId; running: boolean },
): Promise<void> {
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  const body = await readBody(req)
  const cwd = typeof body.cwd === 'string' && body.cwd.trim().length > 0 ? body.cwd : process.cwd()
  const id = SessionId(`fem-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
  try {
    const handle = await ctx.agents.create({
      sessionId: id,
      meta: {
        cwd,
        agentPreset: FEM_PRESET,
      },
      agentOptions: {
        provider: resolved.provider,
        model: resolved.model,
      },
      // Mount the preset composition (persona + tools) so subagents spawned
      // under this session join it — without this the child sees no preset
      // tools and no persona (the RPC create path does this in its setup).
      setup: async (agentCtx: Context): Promise<void> => {
        const presets = ctx.get('agentPresets') as { mount?(agentCtx: Context, id: string): Promise<unknown> } | undefined
        if (presets?.mount === undefined) return
        try {
          await presets.mount(agentCtx, FEM_PRESET)
        } catch (error: unknown) {
          console.log(`[dsh-femwa] preset mount failed: ${String(error)}`)
        }
      },
    })
    console.log(`[dsh-femwa] created fem session ${handle.agent.id} (cwd=${cwd})`)
    kickWelcome(handle.agent)

    const fems = typeof body.fems === 'string' && body.fems.trim().length > 0 ? body.fems : undefined
    const scriptPath = typeof body.scriptPath === 'string' && body.scriptPath.trim().length > 0 ? body.scriptPath : undefined
    if (fems !== undefined || scriptPath !== undefined) {
      const scriptText = await readScriptText(fems, scriptPath)
      await startRunOnSession(ctx, resolved, bridge, runState, id, scriptText, scriptPath)
    }
    writeJson(res, 200, { ok: true, sessionId: String(id) })
  } catch (error: unknown) {
    console.log(`[dsh-femwa] create-session FAILED: ${String(error)}`)
    writeJson(res, 500, { ok: false, error: String(error) })
  }
}
