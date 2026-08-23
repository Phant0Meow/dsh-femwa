/**
 * subagent.ts — AI 演员经纪人。
 *
 * 引擎 ai_request → 开一个 dsh 子代理演这个节点：组装 prompt（blocks：soul/
 * context/memory/prompt）、解析模型来源（跟随主模型或剧本 source 声明）、
 * 应用工具面过滤、空闲看门狗、事件镜像（子代理 turn 重映射 100001+ 并合成
 * turn/start / step/start，dsh 原生 assistant 节点渲染思考折叠/工具卡片/回答，
 * 上帝窗全量 + 角色窗按 scope 命中）、结果 trajectory 回传引擎、归档并移出
 * 子代理会话目录。从 index.ts 原样迁出（2026-08-23 重构）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { dirname, join } from 'node:path'
import type { FemwaBridge } from './bridge'
import type { ResolvedConfig } from './config'
import { broadcastSse } from './http'
import { writeTurnScopeFile } from './state-files'
import { projectionAppend, type ProjectionRegistry } from './projection'

// ── 镜像簿记与白名单 ──────────────────────────────────────────────────────

// 子代理事件镜像到父会话时的 turn 号重映射（父会话可能连续多个 AI 节点，
// 每个子代理 turn 从 1 开始，直接转发会撞号）。每次 run 分配一个 base，
// 预留 100 个 turn 给该 run 内部递增，fork 并发多个子代理也不冲突。
const turnBaseBySession = new Map<string, number>()

/** 主会话镜像 turn → scope 映射（重映射后的 turn 号 → 节点 scope 演员名）。
 * 前端视角过滤用：god 全显示，角色视角按 scope 隐藏其他 turn。
 * 镜像始终全量（信息完整落盘），视角过滤只在显示层。
 * routes.ts 的 /dsh-femwa/turn-scopes 读取（导出共用实例）。 */
export const turnScopesBySession = new Map<string, Map<number, string[]>>()

/** 子代理事件类型：镜像到父会话让 dsh 原生 assistant 节点渲染（思考折叠/
 * 工具卡片/回答，零自绘 UI）。 */
const FORWARD_CHILD_EVENTS = new Set([
  'turn/start', 'step/start', 'assistant/chunk', 'assistant/message',
  'tool/call', 'tool/result', 'step/end', 'turn/end',
])

/** surface-eligible 事件（会话 API 要求 surfaceOp 标记）；其余事件不能带。 */
const SURFACE_OP_EVENTS = new Set(['assistant/message', 'tool/result'])

// ── prompt / trajectory 组装 ─────────────────────────────────────────────

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

// ── 工具面 / 模型来源 ─────────────────────────────────────────────────────

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

/** 主会话当前实际模型（未声明 source 的子代理跟随它）：
 * ① 主会话最近一次请求头（含 UI 会话内切换，对齐 dsh web selectionFor 语义）
 * → ② 用户保存的默认选择（agentDefaultModel）→ ③ undefined（调用方回退配置）。
 * 显式返回模型而非依赖 dsh 隐式默认，堵死"子代理落到部署默认（如 Pro）"的隐患。 */
function resolveMainModel(
  parent: { session: { requestHeader?(): { config?: { provider?: unknown; model?: unknown } } | undefined } },
  defaultModel?: { currentSelection(): unknown },
): { provider: string; model: string } | undefined {
  const header = parent.session.requestHeader?.()
  const h = header?.config
  if (h !== undefined && typeof h.provider === 'string' && h.provider.length > 0
    && typeof h.model === 'string' && h.model.length > 0) {
    return { provider: h.provider, model: h.model }
  }
  const selection = defaultModel?.currentSelection() as { provider?: unknown; model?: unknown } | undefined
  if (selection !== undefined && typeof selection.provider === 'string' && selection.provider.length > 0
    && typeof selection.model === 'string' && selection.model.length > 0) {
    return { provider: selection.provider, model: selection.model }
  }
  return undefined
}

/** 剧本 source → 子代理 agentOptions（provider/model）。
 * 空 source 跟随主模型（mainModel 缺失时才回退配置默认）；裸 id 走默认
 * provider（dshProvider）；provider/model 双写完全指定。
 * 编译期已校验白名单（引擎 validate_actor_sources），这里只做格式解析。 */
function resolveSourceModel(
  resolved: ResolvedConfig,
  source: unknown,
  mainModel?: { provider: string; model: string },
): { agentOptions: { provider: string; model: string } } {
  const raw = typeof source === 'string' ? source.trim() : ''
  if (raw.length === 0) {
    if (mainModel !== undefined) {
      return { agentOptions: { provider: mainModel.provider, model: mainModel.model } }
    }
    return { agentOptions: { provider: resolved.dshProvider, model: resolved.model } }
  }
  const slash = raw.indexOf('/')
  if (slash >= 0) {
    return { agentOptions: { provider: raw.slice(0, slash), model: raw.slice(slash + 1) } }
  }
  return { agentOptions: { provider: resolved.dshProvider, model: raw } }
}

// ── 子代理会话归档 ────────────────────────────────────────────────────────

/** 子代理会话目录移出 dsh sessions 树（备份区 user_data/subagent_sessions/）。
 * 不删文件、可移回；移出后不再出现在会话列表/投影缓存（镜像已全量落主会话，
 * 子代理日志只是冗余备份）。locate 需要 cwd 才能定位 workspace 分组目录。 */
async function moveChildSessionOut(
  ctx: Context,
  resolved: ResolvedConfig,
  run: { id: SessionId; localAgent?: { session: { events?: readonly unknown[]; header?: { cwd?: string } } } },
): Promise<void> {
  const header = run.localAgent?.session.header
  if (header === undefined || header.cwd === undefined) return
  const persistence = ctx.get('sessionPersistence') as
    | { locate?(meta: { cwd?: string; id: SessionId }): { path: string } | undefined }
    | undefined
  if (persistence?.locate === undefined) return
  const loc = persistence.locate({ cwd: header.cwd, id: run.id })
  if (loc === undefined) return
  const sessionDir = dirname(loc.path)
  const targetRoot = join(resolved.femwaRoot, 'user_data', 'subagent_sessions')
  const target = join(targetRoot, String(run.id))
  const { mkdir, rename } = await import('node:fs/promises')
  await mkdir(targetRoot, { recursive: true })
  // Windows 上会话日志可能仍在异步 flush（句柄占用），rename 会 EPERM：
  // 带重试（最多 10 次 × 500ms），flush 完成后再移出。
  let lastError: unknown
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rename(sessionDir, target)
      console.log(`[dsh-femwa] moved child session ${run.id} -> subagent_sessions/`)
      return
    } catch (error: unknown) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  throw lastError
}

// ── 主流程 ────────────────────────────────────────────────────────────────

/** One engine AI turn executed through a dsh subagent. */
export async function runAiSubagent(
  ctx: Context,
  resolved: ResolvedConfig,
  bridge: FemwaBridge,
  session: Session,
  request: Record<string, unknown>,
  recordError: (sessionId: SessionId, text: string) => void,
  defaultModel?: { currentSelection(): unknown },
  nodeActors: ReadonlyMap<string, string> = new Map(),
  projections?: ProjectionRegistry,
): Promise<void> {
  // 唯一调用点（engine-events）总传 registry；守卫只为类型收窄（缺 registry
  // 时原实现会在首次投影处 TypeError，这里提前以明确错误失败，路径等价）。
  if (projections === undefined) throw new Error('projections registry unavailable')
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
  // 未声明 source 的子代理跟随主模型（最近请求头 → 保存默认 → 配置兜底），
  // 绝不落到 dsh 部署隐式默认（防"主模型 Flash 子代理跑 Pro"类问题）。
  const mainModel = resolveMainModel(parent, defaultModel)
  const run = await subagents.start(resolved.subagentProvider, {
    label: `fem-node-${String(request.node_name ?? '')}`,
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal: controller.signal,
    // source → (provider, model)：剧本 actor 声明（编译期已校验白名单）。
    // 裸 id 走默认 provider（dshProvider）；provider/model 双写完全指定；空跟随主模型。
    ...resolveSourceModel(resolved, request.source, mainModel),
    // Actor-level tool access: the script's `tools: true/false` on the actor
    // wins; undeclared actors fall back to defaultActorTools (default true so
    // coding workflows keep their tools). An enabled actor with no whitelist
    // inherits the preset's full tool set (no filter); a disabled actor gets
    // an empty allow-list (no tools at all).
    ...toolFilterOf(resolved, request),
  })
  // 推理等级注入：子 agent（spawn 进程内）不走 apiproxy 的 model-selection
  // 安装（installSelection 只作用于会话 agent），导致用户在模型选择里调的
  // 推理等级对子 agent 永远无效（表现为"关了推理还在输出 cot"）。
  // 这里直接给子 agent 的请求链注入：显式配置 subagentReasoning 优先，
  // 否则跟随全局默认模型选择（用户 UI 保存的默认）。
  if (run.localAgent !== undefined) {
    const effort = resolved.subagentReasoning
      ?? (defaultModel?.currentSelection() as { reasoningEffort?: string } | undefined)?.reasoningEffort
    if (effort !== undefined && effort.length > 0) {
      run.localAgent.ctx.on('agent/request', async (_payload, next) => {
        const resolvedCall = await next()
        return { ...resolvedCall, reasoningEffort: effort } as typeof resolvedCall
      })
    }
  }
  // Watchdog starts once the child exists; every child-session event rearms
  // it. Listener is scoped to the child's session id and disposed in finally.
  armIdle()
  const sid = String(session.id)
  const nodeName = String(request.node_name ?? '')
  const actor = nodeActors.get(nodeName) ?? nodeName
  // turn 首行：发言者名字（之后 cot/工具调用/回答由 dsh 原生 UI 渲染）
  const scopeInfo = Array.isArray(request.scope_info)
    ? request.scope_info.filter((x): x is string => typeof x === 'string')
    : undefined
  // 角色名字行：只投影进上帝窗 + scope 命中的角色窗。主会话表面绝不写入
  // （主窗口=戏外=纯 DSH 原生 user+主模型；名字行曾写主会话导致"光有名字
  // 没有内容"的幽灵行——内容 turn 本就只进投影窗）。
  let windows = projections.get(sid)
  if (windows === undefined) {
    windows = await projections.ensure(sid, scopeInfo ?? [], (session.header as { cwd?: string } | undefined)?.cwd ?? process.cwd())
  }
  projectionAppend(windows, 'dsh-femwa/chat', {
    kind: 'speaker',
    actor,
    text: actor,
    ...scopeInfo === undefined ? {} : { visible: scopeInfo },
    seq: Date.now(),
  }, undefined, scopeInfo)
  const baseTurn = (turnBaseBySession.get(sid) ?? 100_000) + 1
  turnBaseBySession.set(sid, baseTurn + 100)
  const mapTurn = (childTurn: unknown): number =>
    typeof childTurn === 'number' ? baseTurn + childTurn - 1 : baseTurn
  // 合成 turn/step 起始事件（子代理 one-shot 会话没有这两个 start 事件，
  // 原生 assistant 节点以 step/start 为 start，缺了就不渲染）。
  let turnStarted = false
  let currentStep = -1
  const ensureTurnStart = (): void => {
    if (turnStarted) return
    // 幂等兜底：log 里已有同 turn 的 turn/start（可能由 dsh 内部机制补发）
    // 就不重复 append——重复的 turn/start 会让 deliverables 等以
    // turn/start 为 start 的节点收到两个 start Match（历史加载失败）。
    const dup = session.events.some(e => e.type === 'turn/start'
      && (e.data as { turn?: number }).turn === baseTurn)
    if (dup) {
      turnStarted = true
      return
    }
    turnStarted = true
    // 投影窗：上帝窗全量 + scope 命中的角色窗。
    projectionAppend(windows, 'turn/start', { turn: baseTurn }, undefined, scopeInfo)
    // 记录镜像 turn 的 scope（合成 turn/start 时；子代理自身没有 turn/start）。
    // 持久化到插件文件而非会话日志事件——少一个需注册的自定义类型，
    // 重建也不再依赖主会话日志。fire-and-forget：写失败仅打日志。
    let scopes = turnScopesBySession.get(sid)
    if (scopes === undefined) {
      scopes = new Map()
      turnScopesBySession.set(sid, scopes)
    }
    scopes.set(baseTurn, scopeInfo ?? [])
    void writeTurnScopeFile(resolved.femwaRoot, sid, scopes).catch((error: unknown) => {
      console.log(`[dsh-femwa] write turn-scope file failed: ${String(error)}`)
    })
  }
  const ensureStepStart = (step: number): void => {
    if (currentStep === step) return
    // 幂等兜底：投影窗 log 里已有相同 turn:step 的 step/start 就不重复。
    const dup = windows.god?.events.some(e => e.type === 'step/start'
      && (e.data as { turn?: number }).turn === baseTurn
      && (e.data as { step?: number }).step === step) ?? false
    if (dup) {
      currentStep = step
      return
    }
    currentStep = step
    ensureTurnStart()
    projectionAppend(windows, 'step/start', { turn: baseTurn, step }, undefined, scopeInfo)
  }
  const onChildEvent = (watched: Session, watchedEvent: SessionEvent): void => {
    if (String(watched.id) !== String(run.id)) return
    armIdle()
    // 流式 token → 打字机通道（对话窗口 SSE 预览行 + 画布）：只转发正文
    // 增量，不转发思考/用量；actor 供前端预览行显示角色名。
    if (watchedEvent.type === 'assistant/chunk') {
      const chunk = (watchedEvent.data as { chunk?: { type?: string; text?: unknown } }).chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        broadcastSse('ai_token', { node_name: nodeName, actor, token: chunk.text })
      }
    }
    // 镜像到投影窗：dsh 原生 assistant 节点渲染完整 turn（思考折叠/工具卡片/
    // 回答），零自绘 UI。上帝窗全量；角色窗按 scope 命中。主会话表面不再
    // 接收角色内容（主模型上下文保持干净）。
    if (!FORWARD_CHILD_EVENTS.has(watchedEvent.type)) return
    // 镜像裁剪（方案丙）：chunk 只镜像块边界（block-start/block-end 携带完整
    // 块内容），delta/usage/finish 不落日志——历史重放行数大幅下降，
    // 渲染由 block-end 的完整块 + assistant/message 兜底；流式走 SSE 通道。
    if (watchedEvent.type === 'assistant/chunk') {
      const ctype = (watchedEvent.data as { chunk?: { type?: string } }).chunk?.type
      if (ctype !== 'block-start' && ctype !== 'block-end') return
    }
    const raw = watchedEvent.data as Record<string, unknown>
    const mappedTurn = mapTurn(raw.turn)
    const mappedStep = typeof raw.step === 'number' ? raw.step : 0
    // 子代理是 one-shot 会话，事件流传统上没有 turn/start、step/start（只有
    // chunk/message/step/end/turn/end），而 dsh 原生 assistant 节点以
    // step/start 为 start——这里合成两个 start 事件，原生 turn 才能渲染。
    // step/start 也进本条件（2026-08-23 晚）：新版子代理源流可能自带真实
    // step/start——它必须落在合成 turn/start 之后，否则骨架乱序会被持久化
    // 校验判 malformed（角色窗中毒形态之一）；真实与合成的重复由
    // projectionAppend 的结构等价查重拦截。
    if (watchedEvent.type === 'turn/start' || watchedEvent.type === 'assistant/chunk'
      || watchedEvent.type === 'assistant/message' || watchedEvent.type === 'step/end'
      || watchedEvent.type === 'step/start') {
      ensureTurnStart()
      if (watchedEvent.type !== 'turn/start') ensureStepStart(mappedStep)
    }
    // 结构事件不注 _srcSeq：dsh 迁移器对 turn/end 强制 data 两键
    // （hasOnlyKeys ['turn','reason']），第三键即冷加载拒载整窗。幂等由
    // projectionAppend 的结构等价查重兜底。
    const structural = watchedEvent.type === 'turn/start' || watchedEvent.type === 'turn/end'
      || watchedEvent.type === 'step/start' || watchedEvent.type === 'step/end'
    const data = structural ? { ...raw } : { ...raw, _srcSeq: Number(watchedEvent.seq) }
    if ('turn' in data) data.turn = mappedTurn
    if ('step' in data && typeof data.step === 'number') data.step = data.step
    // surface-eligible 事件（assistant/message、tool/result）要求 surfaceOp。
    const surface = SURFACE_OP_EVENTS.has(watchedEvent.type)
    projectionAppend(windows, watchedEvent.type, data,
      surface ? { surfaceOp: 'append' } : undefined, scopeInfo)
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
    // 思考链已在 onChildEvent 实时显示（带角色名的折叠行），这里不再重复。
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
    // 子代理会话目录移出 dsh sessions 树（备份区）：不删文件、可移回；
    // 移出后不再出现在会话列表/投影缓存（镜像已全量落主会话，此目录是冗余备份）。
    await moveChildSessionOut(ctx, resolved, run).catch((error: unknown) => {
      console.log(`[dsh-femwa] move child session failed: ${String(error)}`)
    })
  }
}
