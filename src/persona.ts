/**
 * persona.ts — Fem 会话的身份证 + 导演手册。
 *
 * 身份判定：presetOf / isFemAgent（会话 header 的 agentPreset 标记 + UI 切换
 * 的 live override）。主模型注入面：femwa:docs（语法文档指路）与 femwa:notify
 * （运行结果摘要，动态 text 读 runNotices），均走 systemPrompt.section——
 * 不污染用户可见聊天。registerPersonaHooks 负责 agent/created（override 重建）
 * 与 agent-preset/selected（切换时补注入/清除 docs section）两个钩子。
 * 从 index.ts 原样迁出（2026-08-23 重构；钩子从 apply() 提为注册函数）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: pulls the agent-preset domain's event declarations
// ('agent-preset/selected' merge into cordis Events).
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { packageRoot } from './config'

/** Fem sessions carry this agentPreset marker in their session header. */
export const FEM_PRESET = 'dsh-femwa'

/**
 * Session-level preset overrides: the session header is a deep-frozen
 * creation fact, so a preset picked from the UI menu (agentPreset.select →
 * recompose) never rewrites it — the switch only lands as an
 * 'agent-preset/selected' log event. Mirrors dsh-agent-presets'
 * resolveSessionPreset: newest selection wins, header is the fallback.
 */
const presetOverrides = new Map<string, string>()

/**
 * femwa:docs section 的 effect disposer 表（按 sessionId）：
 * - 防重：同名 section 在同一 agent scope 重复注册会抛错（systemPrompt 约束）；
 * - 切走 preset 时调用 disposer 清除，普通会话不留 Fem 文档段。
 * 会话销毁时 section 随 agent ctx 的 effect 自动清理（条目残留无害，disposer 幂等）。
 * run-control 的 handleCreateSession 在 setup 回调里写入（导出供跨模块共用同一实例）。
 */
export const femwaDocsSections = new Map<string, () => void>()

/** One session's frozen creation facts, the minimum presetOf needs. */
export interface PresetBearingIdentity {
  readonly id: SessionId
  readonly header: { readonly agentPreset?: string }
}

/** The preset one session actually runs (override first, header fallback). */
export function presetOf(session: PresetBearingIdentity): string | undefined {
  return presetOverrides.get(String(session.id)) ?? session.header.agentPreset
}

/** Whether an agent belongs to a Fem session (subagents excluded: they
 * inherit the parent's agentPreset but must run normally). */
export function isFemAgent(agent: Agent): boolean {
  return presetOf(agent.session) === FEM_PRESET
    && agent.session.header.parentSession === undefined
}

/**
 * 向一个 agent ctx 注入 femwa:docs section（语法文档指路，scoped：只对主会话
 * agent 生效，子代理不继承，角色不需要）。setup（create-session）与
 * agent-preset/selected 兜底（下拉菜单 recompose 路径）两条路径共用。
 * @returns section 的 effect disposer；无 systemPrompt 或注册失败（如同名
 * 重复）返回 undefined。
 */
export function injectFemwaDocs(agentCtx: Context): (() => void) | undefined {
  const systemPrompt = (agentCtx as unknown as { systemPrompt?: { section(s: { name: string; order: number; text: string }): () => void } }).systemPrompt
  if (systemPrompt === undefined) return undefined
  try {
    return systemPrompt.section({
      name: 'femwa:docs',
      order: 50,
      text: `fems 剧本语言完整语法文档在：${packageRoot}语法文档.md（速查表和最小模板已在你的 persona 里；memory/context/module/file: 地址规则等冷门语法查这里）。`
        + `示例剧本在：${packageRoot}examples/（goal-loop.fems 循环+变量退出 / group-chat.fems par+@func 随机间隔 / discussion.fems for+if+par+人类拍板 / town.fems 动态 scope+add/remove 移动）。`
        + '写剧本前先读一个最接近需求的示例照着改；写复杂剧本前建议把 examples/ 整体读一遍，学习 scope/vars/flow 的常见套路。'
        + 'file: 地址规则：相对路径=相对剧本文件所在目录解析；剧本未保存（纯文本直接运行）时只支持绝对路径。',
    })
  } catch (error: unknown) {
    console.log(`[dsh-femwa] femwa:docs section inject failed: ${String(error)}`)
    return undefined
  }
}

// ── 运行结果通知（femwa:notify section，注入主模型上下文、不污染用户可见聊天）───
// 机制：systemPrompt.section 的 text 支持函数，每次主模型调用组装 system prompt
// 时动态求值（packages/core/system-prompt section+assemble）。运行结束事件把
// 摘要写入 runNotices，section text 读它；无结果时返回空串（空 section 被过滤）。
// 摘要不清空：保持到下一次运行覆盖（用户 2026-08-20 拍板"不清空"）。

/** 最近一次剧本运行结果摘要（按主会话 id）→ femwa:notify section 的动态 text 源。
 * engine-events 的事件 switch 在 flow_done/flow_error/flow_stopped 时写入（导出共用实例）。 */
export const runNotices = new Map<string, string>()

/** femwa:notify section 的 effect disposer 表（按 sessionId，防同名重复注册）。 */
const runNoticeSections = new Map<string, () => void>()

/**
 * 向一个 agent ctx 注入 femwa:notify section（运行结果摘要，scoped：只对主会话
 * agent 生效，子代理不继承）。text 用函数每次 assemble 动态读 runNotices——没有
 * 运行结果时返回空串，被 renderPrompt 过滤。system prompt 不进用户可见聊天，
 * 满足"注入上下文、不污染界面"。仅注册不更新：run 事件更新 runNotices 即可。
 * @returns section 的 effect disposer；无 systemPrompt 或注册失败返回 undefined。
 */
function injectRunNotice(agentCtx: Context, sid: string): (() => void) | undefined {
  const systemPrompt = (agentCtx as unknown as { systemPrompt?: { section(s: { name: string; order: number; text: string | (() => string) }): () => void } }).systemPrompt
  if (systemPrompt === undefined) return undefined
  try {
    return systemPrompt.section({
      name: 'femwa:notify',
      order: 60,
      text: () => runNotices.get(sid) ?? '',
    })
  } catch (error: unknown) {
    console.log(`[dsh-femwa] femwa:notify section inject failed: ${String(error)}`)
    return undefined
  }
}

/**
 * 确保某 Fem 主会话已注入 femwa:notify section（幂等）。flow_start 时调用——
 * 只在真正跑过剧本的会话上挂载。拿不到主会话 agent（极罕见）则跳过不阻断。
 */
export function ensureRunNotice(ctx: Context, sessionId: SessionId): void {
  const sid = String(sessionId)
  if (runNoticeSections.has(sid)) return
  const agent = (ctx as { agents?: { get(id: SessionId): { ctx: Context } | undefined } }).agents?.get(sessionId)
  if (agent === undefined) {
    console.log(`[dsh-femwa] femwa:notify inject skipped: main agent for ${sid} not found`)
    return
  }
  const dispose = injectRunNotice(agent.ctx, sid)
  if (dispose !== undefined) {
    runNoticeSections.set(sid, dispose)
    console.log(`[dsh-femwa] femwa:notify section injected (flow_start)`)
  }
}

/**
 * 注册 persona 相关钩子（原 apply() 内的 agent/created + agent-preset/selected，
 * 由 index.ts 总装调用一次）。
 */
export function registerPersonaHooks(ctx: Context): void {
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
  // 'agent-preset/selected' 的事件声明由 @deepseek-ai/dsh-agent-presets 的
  // 模块增强提供；此处经宽化签名调用（运行时同一 ctx.on 同一字符串）。
  ;(ctx.on as (event: string, listener: (sessionId: SessionId, agentPreset: string) => void) => () => void)(
    'agent-preset/selected',
    (sessionId: SessionId, agentPreset: string) => {
    presetOverrides.set(String(sessionId), agentPreset)
    console.log(`[dsh-femwa] preset override ${sessionId} -> ${agentPreset}`)
    // femwa:docs 注入兜底：下拉菜单切 Fem 模式走 recompose，不执行 create-session 的
    // setup 回调（section 只在那条路径注入过）——这里补注入；切走时清除。
    const sid = String(sessionId)
    if (agentPreset !== FEM_PRESET) {
      const dispose = femwaDocsSections.get(sid)
      if (dispose !== undefined) {
        dispose()
        femwaDocsSections.delete(sid)
        console.log(`[dsh-femwa] femwa:docs section removed (preset -> ${agentPreset})`)
      }
      return
    }
    if (femwaDocsSections.has(sid)) return
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) {
      console.log(`[dsh-femwa] femwa:docs inject skipped: agent for ${sessionId} not found`)
      return
    }
    const dispose = injectFemwaDocs(agent.ctx)
    if (dispose !== undefined) {
      femwaDocsSections.set(sid, dispose)
      console.log(`[dsh-femwa] femwa:docs section injected (recompose path)`)
    }
    },
  )
}
