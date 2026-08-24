/**
 * engine-events.ts — 演出中的总调度。
 *
 * 引擎运行期间的所有钩子集中在这：
 *  1. agent/pre-step —— Fem 会话运行中拒绝主模型 step（引擎接管对话）；
 *  2. 输入桥 —— 运行中用户消息：human 节点等待 → 转发为 human_input，
 *     否则 → 硬打断（stop）；
 *  3. 上帝窗实时镜像监听器（由 deps.godMirror 注册，保持原注册顺序）；
 *  4. dsh-femwa/event 事件 switch —— 引擎每个事件的状态更新/投影窗提示/
 *     通知主模型/子代理派发。
 * 原 apply() 内联逻辑提为注册函数，依赖经 EngineEventsDeps 显式注入
 * （2026-08-23 重构，行为零变化；监听器注册顺序与原版一致）。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { FemwaBridge } from './bridge'
import type { ResolvedConfig } from './config'
import { broadcastSse } from './http'
import { FEM_PRESET, presetOf, isFemAgent } from './persona'
import { appendChatProjected, appendChatBroadcast, type GodMirror, type ProjectionRegistry } from './projection'
import { runAiSubagent } from './subagent'
import { writeCheckpoint, clearCheckpoint } from './state-files'

/** 运行结局直达主模型对话流：以 plugin 来源构造 user 消息并 agent.steer()。
 * dsh 官方语义（dsh-agent）：空闲的主模型立即开新回合收到通知；忙碌时在
 * 下一 step 边界消费——必达、不打断当前回合。取代旧 femwa:notify
 * systemPrompt section（布告栏式注入易被模型漏读，2026-08-23 废弃）。 */
function steerMainAgent(ctx: Context, sessionId: string | SessionId, text: string): void {
  try {
    const sid = String(sessionId)
    const bag = ctx as unknown as {
      agents?: { get(id: string): { steer?: unknown } | undefined }
      get?(name: string): { get(id: string): { steer?: unknown } | undefined } | undefined
    }
    const viaProp = bag.agents?.get(sid)
    const viaSvc = typeof bag.get === 'function' ? bag.get('agents')?.get(sid) : undefined
    const agent = (viaProp ?? viaSvc) as { steer?(message: unknown): void } | undefined
    if (agent === undefined || typeof agent.steer !== 'function') {
      console.log(`[dsh-femwa] steer skipped (main agent unavailable): sid=${sid}`)
      return
    }
    agent.steer({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-femwa' },
    })
    console.log(`[dsh-femwa] steered main agent: sid=${sid} len=${text.length}`)
  } catch (error: unknown) {
    console.log(`[dsh-femwa] steer failed: ${String(error)}`)
  }
}

/** 引擎运行状态簿记（index.ts 总装创建唯一实例，全插件共享引用）：
 * 哪个会话在跑、是否 human 节点等待、节点→演员/scope 映射、错误表、SSE 重放缓冲。 */
export interface RunState {
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
  /** 最近一次停止是否由「暂停」发起（flow_stopped 文案区分暂停/停止）。 */
  pausedByUser: boolean
  /** 最近引擎事件缓冲（cap 100）：SSE 新连接重放，运行中打开编辑器也能看到实时状态。 */
  lastEvents: Array<{ type: string; data: unknown }>
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

export interface EngineEventsDeps {
  resolved: ResolvedConfig
  bridge: FemwaBridge
  runState: RunState
  sessionsStore?: { get(id: SessionId): Session | undefined }
  projections: ProjectionRegistry
  godMirror: GodMirror
  defaultModel?: { currentSelection(): unknown }
  recordError(sessionId: SessionId, text: string): void
}

export function registerEngineEventHandlers(ctx: Context, deps: EngineEventsDeps): void {
  const { resolved, bridge, runState, sessionsStore, projections, godMirror, defaultModel, recordError } = deps

  // 1) Fem sessions: idle → main model runs normally (dsh default);
  //    running → reject (the engine owns the conversation; the input bridge
  //    routes user text to human nodes / hard stop).
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision === undefined || signal.aborted) return decision
    if (decision.kind !== 'enter') return decision
    if (!isFemAgent(agent)) return decision
    const running = runState.running && runState.sessionId === agent.session.id
    if (!running) return decision
    console.log(`[dsh-femwa] pre-step REJECTED for running fem agent ${agent.id} (engine owns the conversation)`)
    return { kind: 'reject' }
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

  // 3) 实时镜像监听器（原 apply 内联位置：输入桥之后、事件 switch 之前——
  //    保持注册顺序不变）。
  godMirror.registerRealtimeListener(ctx)

  // 4) Event bridge: engine events -> chat messages on the run's session.
  ctx.on('dsh-femwa/event', (eventType: string, data: unknown) => {
    const sessionId = runState.sessionId
    if (sessionId === undefined) return
    // flow_stopped 附加 paused 标记（pausedByUser 判定）：
    // 暂停（bridge 半实现=stop）与停止共用 flow_stopped 事件，前端据此
    // 区分「继续」（paused=true）vs「运行」（idle）按钮——AI 工具
    // pause/resume 与 femGen 按钮共享同一状态机，不打架。
    const payload = eventType === 'flow_stopped'
      ? { ...((data ?? {}) as Record<string, unknown>), paused: runState.pausedByUser }
      : data
    // 可视化运行通道：原样转发引擎事件（画布按 node_name 匹配节点做高亮/详情）。
    broadcastSse(eventType, payload)
    // 事件缓冲：SSE 新连接（运行中打开编辑器标签）先重放已发生的事件。
    runState.lastEvents.push({ type: eventType, data: payload })
    if (runState.lastEvents.length > 100) runState.lastEvents.shift()
    const session = sessionsStore?.get(sessionId)
    if (session === undefined) return
    const d = (payload ?? {}) as Record<string, unknown>
    switch (eventType) {
      case 'flow_start': {
        // Script actors feed the view-perspective menu + projection windows.
        const actors = Array.isArray(d.actors)
          ? d.actors.filter((x): x is string => typeof x === 'string')
          : []
        runState.sessionActors.set(String(sessionId), actors)
        // 上帝窗无条件创建（actors 为空的剧本也要有引擎通知的落点）；
        // 角色窗按剧本角色。幂等创建/复用/冷唤醒；异步，失败仅打日志。
        const header = session.header as { cwd?: string } | undefined
        void projections.ensure(String(sessionId), actors, header?.cwd ?? process.cwd()).catch((error: unknown) => {
          console.log(`[dsh-femwa] flow_start ensure projection windows failed: ${String(error)}`)
        })
        // 补齐上帝窗缺失的主会话对话（重启缝隙：registry 是内存态，
        // 重启后到本次运行前的主模型对话按水位一次性补写）。
        void godMirror.ensureGodMirrorUpToDate(String(sessionId))
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
            appendChatProjected(ctx, session, projections, `📢 ${prompt}`, 'prompt', undefined, nodeName === undefined ? undefined : runState.nodeScopes.get(nodeName))
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
          appendChatProjected(ctx, session, projections, `📢 ${showprompt}`, 'prompt', undefined, nodeName === undefined ? undefined : runState.nodeScopes.get(nodeName))
        }
        break
      }
      case 'ai_retry': {
        // 赋值失败重试：把拒绝原因显示出来（此前静默——用户视角是
        // "AI 输出了赋值但系统没识别"，实际是引擎拒绝了非法赋值）。
        const errors = Array.isArray(d.errors) ? d.errors.map(String) : []
        const attempt = typeof d.attempt === 'number' ? d.attempt : 0
        const nodeName = typeof d.node_name === 'string' ? d.node_name : undefined
        if (errors.length > 0) {
          appendChatProjected(ctx, session, projections, `⚠️ ${errors[0]}（第 ${attempt} 次重试）`, 'notice',
            undefined, nodeName === undefined ? undefined : runState.nodeScopes.get(nodeName))
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
        appendChatProjected(ctx, session, projections, prompt.length > 0 ? `🎭 等待你的回应：${prompt}` : '🎭 等待你的回应', 'human_wait',
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
        // dsh 后端模式：回答已由子代理事件镜像（原生 assistant 节点）显示，
        // 这里不再自绘 role 行；llmBridge 直连模式无镜像，role 行是主会话
        // 唯一显示面（alsoMainSession=true 双写）。
        if (resolved.dshAiBackend) break
        const output = typeof d.output === 'string' && d.output.length > 0 ? d.output : undefined
        if (output !== undefined) {
          const nodeName = typeof d.node_name === 'string' ? d.node_name : undefined
          const actor = nodeName === undefined ? undefined : runState.nodeActors.get(nodeName) ?? nodeName
          appendChatProjected(ctx, session, projections, output, 'role', actor, nodeName === undefined ? undefined : runState.nodeScopes.get(nodeName), true)
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
        void runAiSubagent(ctx, resolved, bridge, session, d, recordError, defaultModel, runState.nodeActors, projections).catch((error: unknown) => {
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
        runState.pausedByUser = false
        // 完整跑完：清掉 checkpoint，下次 run 从头开始
        void clearCheckpoint(resolved.femwaRoot, String(sessionId))
          .catch((error: unknown) => console.log(`[dsh-femwa] checkpoint clear failed: ${String(error)}`))
        // 结局通知全窗广播（主会话+god+角色窗统一可见，2026-08-23 通知统一改造）。
        appendChatBroadcast(ctx, session, projections, '✅ 剧本已跑完')
        // 通知主模型（对话流直达，必达）：跑完、断点已清。
        steerMainAgent(ctx, sessionId, '[dsh-femwa] 剧本运行结果：✅ 已完整跑完。checkpoint 已清除——若要重跑请用 fresh_start（不能 resume 续跑）。')
        break
      }
      case 'flow_error': {
        // Errors are meta info: record for the Fem script panel AND show a
        // red system-like line in the chat transcript.
        runState.running = false
        const text = `剧本出错：${String(d.error ?? 'unknown error')}`
        recordError(session.id, text)
        // 报错通知全窗广播（含主会话；❌ 前缀补足原 error 红行的警示性）。
        appendChatBroadcast(ctx, session, projections, `❌ ${text}`)
        // 通知主模型（对话流直达，必达）：报错详情供据此迭代修剧本。
        steerMainAgent(ctx, sessionId, `[dsh-femwa] 剧本运行结果：❌ 运行出错。错误信息：${String(d.error ?? 'unknown error')}——可修复剧本后再 fresh_start。`)
        break
      }
      case 'flow_stopped': {
        runState.running = false
        // 暂停（引擎侧为 stop 半实现）与停止共用 flow_stopped：按发起方区分文案。
        // 全窗广播：工具与前端按钮触发的停止/暂停都由此统一通知所有窗口
        // （femwa-run 工具侧已不再重复写）。
        appendChatBroadcast(ctx, session, projections, runState.pausedByUser ? '⏸ 剧本已暂停' : '⏹ 剧本已停止')
        // 停止/暂停由发起方经 femwa-run 工具返回值或前端按钮已知悉，不再重复通知主模型。
        runState.pausedByUser = false
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
}
