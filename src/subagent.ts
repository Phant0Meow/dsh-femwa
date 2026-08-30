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
// 【2026-08-29 撞号根治】基必须是「进程启动纪元」而非固定值：内存 Map 随
// 3081 重启清空，固定基（旧 100_000）会让重启后首场从 100001 重来——与上一
// 进程写进投影窗日志的 turn/start / step/start 结构键（dedupeStructKey）
// 撞车，projectionAppend 与 ensureStepStart 的查重误判「重复」静默拦截：
// 演员骨架与 stream-host 直播锚全部不落盘 → 前端无直播渲染位 → 流式显示
// 全灭（922 场实证，症状=「位置对了但流式没了」）。纪元基随时间前进，跨
// 重启绝不与历史撞号；进程内仍按 run +100 递增防同进程撞号。turn 号量级
// ~18 亿仍在 JS 安全整数范围，消费面全为 number 透传无量级假设。
const TURN_BASE_EPOCH = Math.floor(Date.now() / 1000)

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

/** V6 turn 原子缓冲（2026-08-30）：这些镜像事件不在到达时落盘，攒进
 * mirrorBuffer、turn/end 到达时一次性按序落盘——同一 turn 的官方节点在窗
 * 日志里物理连续成块（「隐形容器」：chat 渲染=纯 anchorSeq 平面排序，落盘
 * 连续 ⇒ 排序连续 ⇒ 名字下恒为该角色的完整段落），par 交错与 react 工具
 * 间隔不再把段落撕碎。骨架（turn/start、step/start）与 speaker 名字行不在
 * 列——它们即时落盘，充当直播期的稳定锚（见 turn-nodes.tsx 回退 anchor）。 */
const BUFFERED_CHILD_EVENTS = new Set([
  'assistant/chunk', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
])

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
  // 这里直接给子 agent 的请求链注入（2026-08-30 改造，语义对齐 dsh
  // installModelSelection 的「absent effort clears inherited effort」）：
  // 优先级 actor thinking 标签 > 插件配置 subagentReasoning > 全局默认模型
  // 选择；三层全无时显式剥离继承的 effort——落到适配器/部署默认（settings
  // 的 profile reasoning），不再由上游残留决定。钩子因此必须永远安装：旧版
  // 「有档位才挂」会让 default 态残留继承档位，而 pi-ai 的 zai 格式对缺省
  // 档位发 thinking disabled——glm-5.3-flash 强制思考网关直接 400 1210。
  if (run.localAgent !== undefined) {
    run.localAgent.ctx.on('agent/request', async (_payload, next) => {
      const resolvedCall = await next()
      const actorThinking = typeof request.actor_thinking === 'string' && request.actor_thinking.trim().length > 0
        ? request.actor_thinking.trim()
        : undefined
      const effort = actorThinking
        ?? resolved.subagentReasoning
        ?? (defaultModel?.currentSelection() as { reasoningEffort?: string } | undefined)?.reasoningEffort
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolvedCall
      return {
        ...withoutInheritedEffort,
        ...effort !== undefined && effort.length > 0
          ? { reasoningEffort: effort }
          : {},
      } as typeof resolvedCall
    })
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
  // 【2026-08-29 V3.1】名字行写入点=「首个将真正落盘的镜像事件之前」（
  // onChildEvent 镜像段、裁剪判定之后调用 appendSpeakerLine）。结构性理由：
  // par 并发下每个演员的骨架（turn/start、step/start、stream-host 锚）在
  // 各自首个 chunk 到达时即全部落地，而内容块（流式裁剪后的 block 边界）
  // 必然晚于骨架——无论名字写在 ai_request 时（V1）、首个事件时（V2）还是
  // turn 骨架时（V3.0），所有名字都落在所有内容之前=「AI1 AI2 内容1 内容2」
  // 连排。镜像裁剪保证首个镜像事件之前本演员零内容落地，故此处写入的 seq
  // 恒紧贴内容开头。流式期的名字显示由 stream-host 锚承担（前端 !hasSpeaker
  // 接力），speaker 行只做历史归属标记；零事件子代理由 finally 兜底补写。
  // 【2026-08-30 V6 注】stream-host 锚已废（V5 改 turn 级节点、V6 再改缓冲）。
  // 名字行现在的角色=「直播区锚」：即时落盘（仍在本演员首个内容事件之前，
  // 只不过内容事件此刻进缓冲、turn/end 才落地），前端 fem-turn-head 在直播
  // 期用它回退 anchor（turn/start+0.5）把名字+直播桶钉在骨架旁；turn 落地
  // 后 head 改用区块首内容 seq−0.5 吸附段落头，本行历史归属语义不变。
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
  const appendSpeakerLine = (): void => {
    if (speakerWritten || windows === undefined) return
    speakerWritten = true
    projectionAppend(windows, 'dsh-femwa/chat', {
      kind: 'speaker',
      actor,
      text: actor,
      // 【V5】显式 turn 归属：speaker 事件不再由 femwaChat 独立渲染（无
      // turn 的旧数据除外），而是作为 fem-turn-head 节点的 actor 数据源——
      // 渲染位由 head 的动态 anchor 决定（恒贴自己段落头），与本事件物理
      // seq 无关。
      turn: baseTurn,
      ...scopeInfo === undefined ? {} : { visible: scopeInfo },
      seq: Date.now(),
    }, undefined, scopeInfo)
  }
  const baseTurn = (turnBaseBySession.get(sid) ?? TURN_BASE_EPOCH) + 1
  turnBaseBySession.set(sid, baseTurn + 100)
  const mapTurn = (childTurn: unknown): number =>
    typeof childTurn === 'number' ? baseTurn + childTurn - 1 : baseTurn
  // ── V6 turn 原子缓冲 ────────────────────────────────────────────────
  // 内容镜像事件先排队，turn/end 到达时 flushMirrorBuffer 一次性落盘。
  // flush 全同步（projectionAppend 无 await，Node 单线程），中途不可能插入
  // 其他演员的事件 ⇒ 区块连续性是结构保证。工具名登记表供结果直播帧取名。
  const mirrorBuffer: Array<{
    type: string
    data: Record<string, unknown>
    surface: Record<string, unknown> | undefined
  }> = []
  const toolNamesByCallId = new Map<string, string>()
  const flushMirrorBuffer = (): void => {
    if (mirrorBuffer.length === 0) return
    const pending = mirrorBuffer.splice(0)
    for (const item of pending) {
      projectionAppend(windows, item.type, item.data, item.surface, scopeInfo)
    }
  }
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
    // 【V3.1】名字行不再随骨架落地（挪到镜像段首块前）——par 并发下所有
    // 演员的骨架先于一切内容落地，随骨架写=名字连排（V3.0 事故）。
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
    // 【V5】stream-host 锚已废弃：直播渲染位由前端 turn 级 fem-turn-stream
    // 节点接管（anchor 动态吸附流尾，官方打字机体验回归），不再逐 step 落锚。
  }
  const onChildEvent = (watched: Session, watchedEvent: SessionEvent): void => {
    if (String(watched.id) !== String(run.id)) return
    armIdle()
    // 【V6 时序（2026-08-30）】骨架与名字行即时落盘（turn/start、step/start、
    // speaker——直播期的稳定锚，前端 turn 级节点回退 anchor 挂在它们旁边）；
    // 内容镜像事件进 mirrorBuffer 缓冲，turn/end 到达时原子落盘成连续区块
    // （「隐形容器」，见 BUFFERED_CHILD_EVENTS 注释）。直播帧（SSE）照旧
    // 到达即广播，与落盘时机无关。V3/V5 的「到达即落盘 + 前端锚点追逐」
    // 方案已被实测证伪（par 交错下 head=最小seq/stream=最大seq 全部追着
    // 到达序物理位置跑：名字连排、Deep diving 满屏跳，god 窗日志诊断实锤）。
    const isChunk = watchedEvent.type === 'assistant/chunk'
    if (!FORWARD_CHILD_EVENTS.has(watchedEvent.type) && !isChunk) return
    const chunkWrap = isChunk
      ? (watchedEvent.data as {
          chunk?: { type?: string; index?: number; blockType?: string; text?: unknown; name?: unknown; argumentsDelta?: unknown; block?: { type?: string } }
          turn?: unknown
          step?: unknown
        })
      : undefined
    const chunk = chunkWrap?.chunk
    const sid0 = String(session.id)
    const raw = (watchedEvent.data ?? {}) as Record<string, unknown>
    const mappedTurn = mapTurn(raw.turn)
    const mappedStep = typeof raw.step === 'number' ? raw.step : 0
    // 骨架确保（turn/start+名字行、step/start+stream-host）——chunk 的任何
    // 帧（含首个 delta）都先把骨架与锚建出来，直播才有落点。step/start 也
    // 进本条件（2026-08-23 晚）：真实与合成的重复由 projectionAppend 结构
    // 等价查重拦截。
    if (watchedEvent.type === 'turn/start' || isChunk
      || watchedEvent.type === 'assistant/message' || watchedEvent.type === 'step/end'
      || watchedEvent.type === 'step/start') {
      ensureTurnStart()
      if (watchedEvent.type !== 'turn/start') ensureStepStart(mappedStep)
    }
    // 流式直播（chunk）：SSE 广播，零落盘。此刻骨架与 stream-host 锚已在
    // 窗流（session 推送先于 SSE 帧到达），前端把直播块画进镜像流末尾锚。
    if (isChunk && chunk !== undefined) {
      const sid0 = String(session.id)
      // 帧带 step：桶内块按 (index, step) 匹配——chunk index 每次 LLM 调用
      // 独立编号，react 多步必然复用（V6 起块保留在桶里，不做 step 作用域
      // 会把第2步的 delta 拼进第1步的旧块）。retain：块完成后保留在桶里
      // （V6 缓冲下镜像行要等 turn 落地才接管，即删会文字闪空）；导演路径
      // 无此标记，维持原「落地即移除」语义。
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        broadcastSse('ai_token', { node_name: nodeName, actor, token: chunk.text })
        broadcastSse('fem_stream', { kind: 'delta', sid: sid0, node_name: nodeName, actor, blockKind: 'text', index: chunk.index, step: mappedStep, text: chunk.text })
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        broadcastSse('fem_stream', { kind: 'delta', sid: sid0, node_name: nodeName, actor, blockKind: 'reasoning', index: chunk.index, step: mappedStep, text: chunk.text })
      } else if (chunk.type === 'tool-call-delta') {
        // 工具调用参数流式：按源 chunk index 聚合（GLM 并行工具调用的多
        // tool-call 块 delta 交错，按「最后一个同类块」会拼参数）。
        const name = typeof chunk.name === 'string' && chunk.name.length > 0 ? chunk.name : undefined
        const argsDelta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
        if (name !== undefined || argsDelta.length > 0) {
          broadcastSse('fem_stream', {
            kind: 'delta', sid: sid0, node_name: nodeName, actor, blockKind: 'toolcall', index: chunk.index, step: mappedStep,
            ...name !== undefined ? { name } : {},
            text: argsDelta,
          })
        }
      } else if (chunk.type === 'block-start' && (chunk.blockType === 'text' || chunk.blockType === 'reasoning')) {
        broadcastSse('fem_stream', { kind: 'start', sid: sid0, node_name: nodeName, actor, blockKind: chunk.blockType, index: chunk.index, step: mappedStep })
      } else if (chunk.type === 'block-end' && (chunk.block?.type === 'text' || chunk.block?.type === 'reasoning' || chunk.block?.type === 'tool-call')) {
        // 块类型字段是 block.type（llm StreamChunk 定义），旧代码读
        // chunk.block?.kind 恒 undefined → block_end 广播全丢 → 直播块只进
        // 不出，镜像落地后整轮双份。
        broadcastSse('fem_stream', {
          kind: 'block_end', sid: sid0, node_name: nodeName, actor, index: chunk.index, step: mappedStep, retain: true,
          blockKind: chunk.block?.type === 'tool-call' ? 'toolcall' : chunk.block?.type,
        })
      }
    }
    // 工具调用登记 + 结果直播帧（V6/V6.1）：tool/call 记 callId→name 供结
    // 果帧取名；tool/result 广播进桶由前端合并进同名 toolcall 块（官方一次
    // 调用一行：IN=args/OUT=result，前端官方行渲染）。纯 SSE 零落盘；正文
    // 截 2000 字防病态巨型结果刷屏（官方 OUT 卡 150px 内滚动，落地行承接全文）。
    if (watchedEvent.type === 'tool/call') {
      if (typeof raw.callId === 'string' && typeof raw.name === 'string') {
        toolNamesByCallId.set(raw.callId, raw.name)
      }
    } else if (watchedEvent.type === 'tool/result') {
      const msg = (watchedEvent.data as {
        message?: {
          source?: { callId?: unknown }
          content?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>
        }
      }).message
      const callId = typeof msg?.source?.callId === 'string' ? msg.source.callId : undefined
      let text = ''
      for (const part of msg?.content ?? []) {
        for (const inner of part?.content ?? []) {
          if (inner?.type === 'text' && typeof inner.text === 'string' && inner.text.length > 0) {
            text = inner.text
            break
          }
        }
        if (text.length > 0) break
      }
      const name = callId !== undefined ? toolNamesByCallId.get(callId) : undefined
      broadcastSse('fem_stream', {
        kind: 'tool_result', sid: sid0, node_name: nodeName, actor, step: mappedStep,
        ...(name !== undefined ? { name } : {}),
        text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
      })
    }
    // 镜像到投影窗：dsh 原生 assistant 节点渲染完整 turn（思考折叠/工具卡片/
    // 回答），零自绘 UI。上帝窗全量；角色窗按 scope 命中。主会话表面不再
    // 接收角色内容（主模型上下文保持干净）。
    if (!FORWARD_CHILD_EVENTS.has(watchedEvent.type)) return
    // 镜像裁剪（方案丙）：chunk 只镜像块边界（block-start/block-end 携带完整
    // 块内容），delta/usage/finish 不落日志——历史重放行数大幅下降，
    // 渲染由 block-end 的完整块 + assistant/message 兜底；流式走 SSE 通道。
    if (isChunk) {
      if (chunk?.type !== 'block-start' && chunk?.type !== 'block-end') return
    }
    // 【V3.1 名字行落点】走到此处=本事件已通过裁剪、必将真正落盘。名字行
    // 在首个落盘镜像事件之前写入（幂等，仅首个生效）——seq 恒紧贴内容开头，
    // par 并发下不连排（骨架期不写名字，理由见 appendSpeakerLine 处注释）。
    appendSpeakerLine()
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
    const surfaceOp = SURFACE_OP_EVENTS.has(watchedEvent.type)
      ? ({ surfaceOp: 'append' } as Record<string, unknown>)
      : undefined
    // 【V6 turn 原子缓冲】内容事件排队；turn/end 到达=本 turn 完结，连同
    // turn/end 自己（最后）一次性落盘成连续区块。骨架/名字行走上方即时路径，
    // 不经过这里。
    if (watchedEvent.type === 'turn/end') {
      mirrorBuffer.push({ type: watchedEvent.type, data, surface: surfaceOp })
      flushMirrorBuffer()
    } else if (BUFFERED_CHILD_EVENTS.has(watchedEvent.type)) {
      mirrorBuffer.push({ type: watchedEvent.type, data, surface: surfaceOp })
    } else {
      projectionAppend(windows, watchedEvent.type, data, surfaceOp, scopeInfo)
    }
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
    // 名字行兜底（V3）：零事件子代理（立即失败/空闲超时，一个子会话事件都
    // 没发过）没有骨架事件触发 appendSpeakerLine，这里补写让错误行/无输出
    // 空档有归属；正常路径已在 ensureTurnStart 写过，幂等跳过。
    appendSpeakerLine()
    // 【V6】缓冲兜底 flush：中断/超时/异常路径下 turn/end 可能永远不来，
    // 这里把残余缓冲落盘（正常路径已在 turn/end 到达时清空，此为 no-op），
    // 再补一条合成 turn/end 让 timeline 的 turn 必然闭合（前端直播节点据此
    // 隐藏）。合成件结构键与子代理真实 turn/end 同款（turn/end:<turn>），
    // 幂等由 projectionAppend 结构等价查重拦截。turnStarted=false 说明本回合
    // 连骨架都没落过（与旧行为一致：什么都不写）。
    flushMirrorBuffer()
    if (turnStarted) {
      projectionAppend(windows, 'turn/end', { turn: baseTurn }, undefined, scopeInfo)
    }
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
