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
import { projectionAppend, dedupeIndexFor, type ProjectionRegistry } from './projection'

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

/** 剧场应急提示（2026-08-25《宵夜大辩论》裁决事件）：断档续跑等场景下引擎
 * 可能给不出 scope 共享历史，角色上下文缺前情。与其让角色自己翻源码取证
 * 20 分钟，不如直接告知一键自救命令（fem-chat.mjs 自动定位最近一场的上帝
 * 视角投影日志并倒出全场发言）。 */
function theaterHintOf(femwaRoot: string): string {
  return [
    '【剧场应急】你的上下文应包含同房间（同 scope）角色的历史发言；若发现缺失（典型场景：运行中途断档后续跑），不要凭空编造剧情：',
    `有工具时先运行 node "${join(femwaRoot, 'fem-chat.mjs')}" 一键取回本场全部发言再继续；`,
    '无工具可用时，在回复开头声明「未收到历史发言」，再基于已有信息尽力而为。',
  ].join('\n')
}

/** Assemble the subagent's initial prompt from the engine's blocks. */
function buildSubagentPrompt(blocks: Record<string, unknown>, theaterHint = ''): string {
  const str = (key: string): string => (typeof blocks[key] === 'string' ? String(blocks[key]) : '')
  const system = [
    str('basic_safety'),
    str('basic_output'),
    str('soul'),
    str('user_info'),
    theaterHint,
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
 * 一个子会话 step（一轮）的结构化转写：四列各归各位。
 * cot=该轮 reasoning（全量存，可见性由读取侧开关管）；reply=该轮 assistant
 * 文本；toolCall=该轮工具命令 JSON 数组（callId/name/arguments——dsh core
 * types.ts 的 tool/call 事件自带，命令与文本天然分离）；toolResult=该轮工具
 * 结果（[TOOL CALL #N] 模板格式，命令+结果配对）。
 */
interface AgentStep {
  step: number
  cot: string
  reply: string
  toolCall: string
  toolResult: string
}

function formatToolBlocks(calls: { callId: string; name: string; arguments: string }[], results: string[]): string {
  const n = Math.max(calls.length, results.length)
  const parts: string[] = []
  for (let i = 0; i < n; i++) {
    const c = calls[i]
    const r = results[i] ?? ''
    const lines: string[] = [`[TOOL CALL #${i + 1}]`]
    if (c !== undefined) lines.push(`${c.name}(${c.arguments})`)
    if (r) {
      lines.push(`[TOOL CALL #${i + 1} RESULT]`)
      lines.push(r)
    }
    lines.push(`[TOOL CALL #${i + 1} END]`)
    parts.push(lines.join('\n'))
  }
  return parts.join('\n\n')
}

/**
 * 把子会话事件流按 step 分桶成结构化转写（2026-08-29 转写分离）：assistant/
 * message 开启新一轮（reasoning→cot、text→reply），tool/call 逮住命令（callId/
 * name/arguments），tool/result 归属本轮结果——不再拍平成带标记的长文本，
 * 下游上下文由读取侧按可见性开关重组。output=最后一个非空 reply（流程用）。
 */
function buildSteps(events: readonly SessionEvent[]): { output: string; steps: AgentStep[] } {
  type Bucket = {
    cot: string[]
    reply: string[]
    calls: { callId: string; name: string; arguments: string }[]
    results: string[]
  }
  const buckets = new Map<number, Bucket>()
  const bucketOf = (step: number): Bucket => {
    let b = buckets.get(step)
    if (b === undefined) {
      b = { cot: [], reply: [], calls: [], results: [] }
      buckets.set(step, b)
    }
    return b
  }
  let output = ''
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const data = event.data as { step?: unknown; message?: { content?: unknown } }
      const content = data.message?.content
      if (!Array.isArray(content)) continue
      const step = typeof data.step === 'number' ? data.step : 0
      const b = bucketOf(step)
      const text = content.filter(b2 => (b2 as { type?: string }).type === 'text')
        .map(b2 => String((b2 as { text?: unknown }).text ?? '')).join('')
      const reasoning = content.filter(b2 => (b2 as { type?: string }).type === 'reasoning')
        .map(b2 => String((b2 as { text?: unknown }).text ?? '')).join('')
      if (reasoning.length > 0) b.cot.push(reasoning)
      if (text.length > 0) {
        b.reply.push(text)
        output = text
      }
    } else if (event.type === 'tool/call') {
      const data = event.data as { step?: unknown; callId?: unknown; name?: unknown; arguments?: unknown }
      const step = typeof data.step === 'number' ? data.step : 0
      bucketOf(step).calls.push({
        callId: typeof data.callId === 'string' ? data.callId : '',
        name: typeof data.name === 'string' ? data.name : '',
        arguments: typeof data.arguments === 'string' ? data.arguments : '',
      })
    } else if (event.type === 'tool/result') {
      const data = event.data as { step?: unknown; message?: { content?: unknown } }
      const step = typeof data.step === 'number' ? data.step : 0
      const message = data.message
      if (message === undefined) continue
      const content = message.content
      const items = Array.isArray(content) ? content : []
      for (const block of items) {
        const bl = block as { type?: string; text?: unknown; content?: unknown }
        if (bl.type !== 'tool-result') continue
        const text = typeof bl.text === 'string' ? bl.text : blocksToText(bl.content)
        if (text.length > 0) bucketOf(step).results.push(text)
      }
    }
  }
  const steps: AgentStep[] = [...buckets.keys()].sort((a, b) => a - b).map((step) => {
    const b = buckets.get(step)!
    return {
      step,
      cot: b.cot.join('\n\n'),
      reply: b.reply.join('\n\n'),
      toolCall: b.calls.length > 0 ? JSON.stringify(b.calls) : '',
      toolResult: b.calls.length > 0 || b.results.length > 0 ? formatToolBlocks(b.calls, b.results) : '',
    }
  })
  return { output, steps }
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

/** 剧本 source → 子代理 agentOptions。
 * 空 source 跟随主模型（最近请求头 → 保存默认）；裸 id 走 dshProvider
 * （部署按需配置，编译期白名单已校验）；provider/model 双写完全指定。
 * 均不可得时返回空对象——不写死 provider（2026-08-24 用户拍板「不要写
 * provider」）：交给 dsh 默认模型链，杜绝部署上不存在的 adapter 名导致
 * 整场戏 NO_ADAPTER。 */
function resolveSourceModel(
  resolved: ResolvedConfig,
  source: unknown,
  mainModel?: { provider: string; model: string },
): { agentOptions?: { provider: string; model: string } } {
  const raw = typeof source === 'string' ? source.trim() : ''
  if (raw.length === 0) {
    if (mainModel !== undefined) {
      return { agentOptions: { provider: mainModel.provider, model: mainModel.model } }
    }
    return {}
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
  const prompt = buildSubagentPrompt(blocks, theaterHintOf(resolved.femwaRoot))
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
  // Par 并发安全（2026-08-28）：演员名优先取本次 ai_request 自带的 ai_name
  // （引擎 _exec_ai 三级解析后随 payload 传递，每请求独立身份）。此前取共享
  // Map nodeActors[node_name]——par 循环体各分支 node id 相同而演员不同，
  // context_ready 互相覆盖后 Map 值取决于事件到达序，speaker 行会写上另一
  // 分支的演员名（流式 fem_stream 的 actor 同错，两演员直播混进同一桶）。
  // 旧引擎（payload 无 ai_name）回退 Map：单节点/串行语义下仍正确。
  const requestAiName = typeof request.ai_name === 'string' && request.ai_name.length > 0
    ? request.ai_name
    : undefined
  const actor = requestAiName ?? nodeActors.get(nodeName) ?? nodeName
  // turn 首行：发言者名字（之后 cot/工具调用/回答由 dsh 原生 UI 渲染）
  const scopeInfo = Array.isArray(request.scope_info)
    ? request.scope_info.filter((x): x is string => typeof x === 'string')
    : undefined
  // 角色名字行：只投影进上帝窗 + scope 命中的角色窗。主会话表面绝不写入
  // （主窗口=戏外=纯 DSH 原生 user+主模型；名字行曾写主会话导致"光有名字
  // 没有内容"的幽灵行——内容 turn 本就只进投影窗）。
  // 【2026-08-28 Par 并发修复】名字行从「ai_request 到达即写」推迟到「该
  // 子代理首个事件到达」（ensureSpeakerLine，onChildEvent 最前置同步调用，
  // 先于一切直播广播与镜像）：此前名字行是预约位，par 时 N 个 ai_request
  // 连续到达 = N 行名字连排，正文 turn 之后才交错落地（「ID下面不一定是
  // 发言」）；推迟后名字行紧贴自己的第一块内容。零事件子代理（立即失败/
  // 空闲超时）由 finally 兜底补写，错误行仍有着落点。监听器挂在 windows
  // 就绪之后，首次触发时 windows 必已就绪。
  let windows = projections.get(sid)
  if (windows === undefined) {
    // 【cwd 守卫】同 engine-events flow_start：cwd 缺失绝不落 process.cwd()
    // （2026-08-23 分组键事故原则，routes.ts projection-windows 同款守卫）。
    // 此兜底建窗仅在 registry 无窗时可达；抛错交给 ai_request 调用方现有
    // catch（recordError + 空回传，该演员节点失败、引擎继续），优于建错
    // 分组产生 duplicate session id 炸整树。
    const headerCwd = (session.header as { cwd?: string } | undefined)?.cwd
    if (headerCwd === undefined || headerCwd.length === 0) {
      throw new Error(`session ${sid} cwd missing — projection windows cannot be ensured (process.cwd() fallback forbidden)`)
    }
    windows = await projections.ensure(sid, scopeInfo ?? [], headerCwd)
  }
  let speakerWritten = false
  const ensureSpeakerLine = (): void => {
    if (speakerWritten || windows === undefined) return
    speakerWritten = true
    projectionAppend(windows, 'dsh-femwa/chat', {
      kind: 'speaker',
      actor,
      text: actor,
      ...scopeInfo === undefined ? {} : { visible: scopeInfo },
      seq: Date.now(),
    }, undefined, scopeInfo)
  }
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
    // ★ O(1) 去重索引（2026-08-26 性能修复）：旧实现 session.events.some()
    // 全扫——主会话 13.7 万事件级时每次子代理 turn 都是秒级全数组扫描。
    const dup = dedupeIndexFor(session).structKeys.has(`turn/start:${baseTurn}`)
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
    // ★ O(1) 去重索引（2026-08-26 性能修复，同 ensureTurnStart）。
    let dup = false
    if (windows.god !== undefined) {
      dup = dedupeIndexFor(windows.god).structKeys.has(`step/start:${baseTurn}:${step}`)
    }
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
    // 名字行前置（2026-08-28 Par 并发修复）：先于一切直播广播与镜像 append，
    // 同步执行保证「名字行落盘 → 直播 delta 广播」的顺序，前端锚点行先于
    // 直播块存在（delta 先到也只是进 femStreams 桶暂存，行挂载后全量读取）。
    ensureSpeakerLine()
    // 流式直播（2026-08-24 方案B）：chunk 经插件 SSE 通道旁路广播给前端，
    // 零落盘——前端在投影窗 speaker 锚点行下自绘官方同款打字机，块完成时
    // 该块从缓冲移除、原生镜像接管。sid=主会话 id（各投影窗前端自行推导比
    // 对）；block_end 与原生块落地几乎同时，重叠窗口极小。ai_token 原样保
    // 留：femGen 画布节点流式文本（nodeStates.streamingText）仍消费它。
    if (watchedEvent.type === 'assistant/chunk') {
      const chunk = (watchedEvent.data as {
        chunk?: { type?: string; index?: number; blockType?: string; text?: unknown; name?: unknown; argumentsDelta?: unknown; block?: { type?: string } }
      }).chunk
      const sid0 = String(session.id)
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        broadcastSse('ai_token', { node_name: nodeName, actor, token: chunk.text })
        broadcastSse('fem_stream', { kind: 'delta', sid: sid0, node_name: nodeName, actor, blockKind: 'text', index: chunk.index, text: chunk.text })
      } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        broadcastSse('fem_stream', { kind: 'delta', sid: sid0, node_name: nodeName, actor, blockKind: 'reasoning', index: chunk.index, text: chunk.text })
      } else if (chunk?.type === 'tool-call-delta') {
        // 工具调用参数流式（2026-08-24 用户点名全程流式）：首帧带 name，之后
        // 只发参数增量。【2026-08-29 修】按源 chunk index 聚合——旧实现按
        // 「最后一个 toolcall 块」聚合且假设同 step 工具串行，GLM 并行工具
        // 调用（多 tool-call 块 delta 交错）会把多个工具参数拼进同一块。
        const name = typeof chunk.name === 'string' && chunk.name.length > 0 ? chunk.name : undefined
        const argsDelta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
        if (name !== undefined || argsDelta.length > 0) {
          broadcastSse('fem_stream', {
            kind: 'delta', sid: sid0, node_name: nodeName, actor, blockKind: 'toolcall', index: chunk.index,
            ...name !== undefined ? { name } : {},
            text: argsDelta,
          })
        }
      } else if (chunk?.type === 'block-start' && (chunk.blockType === 'text' || chunk.blockType === 'reasoning')) {
        broadcastSse('fem_stream', { kind: 'start', sid: sid0, node_name: nodeName, actor, blockKind: chunk.blockType, index: chunk.index })
      } else if (chunk?.type === 'block-end' && (chunk.block?.type === 'text' || chunk.block?.type === 'reasoning' || chunk.block?.type === 'tool-call')) {
        // 【2026-08-29 修】块类型字段是 block.type（llm StreamChunk 定义），
        // 旧代码读 chunk.block?.kind——恒 undefined → block_end 广播全丢 →
        // 直播块只进不出，镜像落地后直播残留=整轮内容双份显示。
        broadcastSse('fem_stream', {
          kind: 'block_end', sid: sid0, node_name: nodeName, actor, index: chunk.index,
          blockKind: chunk.block?.type === 'tool-call' ? 'toolcall' : chunk.block?.type,
        })
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
    // _srcSeq 用「子会话id#seq」复合键（2026-08-24 故事接龙 bug）：one-shot 子
    // 会话的本地 seq 都从相近小值起步，兄弟子代理之间必然撞号——projectionAppend
    // 按 _srcSeq 全局判重会把后到者的尾部事件静默误杀（第5棒的 block-end 263/264
    // 与 message 267 被第2棒同号占用→悬空 block-start 渲染不出内容=「有名字没
    // 内容」）。加子会话 id 前缀做命名空间隔离；主会话镜像保持裸数字键（单一
    // 来源无撞号），且数字 !== 字符串，新旧键天然互不干扰。
    const data = structural
      ? { ...raw }
      : { ...raw, _srcSeq: `${String(run.id)}#${Number(watchedEvent.seq)}` }
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
    let steps: AgentStep[] = []
    if (run.localAgent !== undefined) {
      const built = buildSteps(run.localAgent.session.events)
      steps = built.steps
      if (output.length === 0 && built.output.length > 0) output = built.output
    }
    if (steps.length === 0 && output.length > 0) {
      // 兜底：事件流没采到时把最终回复当单行，防该 turn 空 react（半行）
      steps = [{ step: 0, cot: '', reply: output, toolCall: '', toolResult: '' }]
    }
    if (result.stopReason !== 'completed' && result.stopReason !== 'max-tokens') {
      recordError(session.id, `子 agent 结束异常：${result.stopReason}`)
    }
    // 思考链已在 onChildEvent 实时显示（带角色名的折叠行），这里不再重复。
    await bridge.send('human_input', {
      wait_key: waitKey,
      body: { output, steps },
    })
    console.log(`[dsh-femwa] subagent done: ${String(request.node_name ?? '')} stop=${result.stopReason} output=${output.length}ch steps=${steps.length}`)
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
      body: { output: '', steps: [] },
    }).catch((sendError: unknown) => {
      console.log(`[dsh-femwa] timeout回传失败: ${String(sendError)}`)
    })
  } finally {
    // 名字行兜底（2026-08-28 Par 并发修复配套）：零事件子代理（立即失败/
    // 空闲超时，一个子会话事件都没发过）没有首事件可触发 ensureSpeakerLine，
    // 这里补写让错误行/无输出空档有归属；正常路径已写过，幂等跳过。
    ensureSpeakerLine()
    // 直播兜底收尾（2026-08-24 方案B）：无论正常完成/中断/超时，都清掉该
    // 演员的流式缓冲——前端防残影的最后防线（block_end 已逐块移除，这里
    // 覆盖"块没闭合就结束"的异常路径）。
    broadcastSse('fem_stream', { kind: 'end', sid: String(session.id), node_name: nodeName, actor })
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
