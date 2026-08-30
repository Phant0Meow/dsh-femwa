/**
 * config.ts — 插件配置（设置表）。
 *
 * Config schema（dsh 配置面的 zod 声明）+ ResolvedConfig（apply 时的运行时
 * 解析结果，全插件统一消费这一份）。从 index.ts 原样迁出（2026-08-23 重构）。
 */

import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/** 插件包根目录：femwaRoot 缺省时指向插件自身（自包含布局，整个文件夹搬走即用）。 */
export const packageRoot = fileURLToPath(new URL('..', import.meta.url))

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
  /**
   * 子 agent 推理等级（'off'|'low'|'high'|'max'）。缺省跟随主会话请求头的
   * 生效档位（跟随主模型 = 连推理档位一起跟随）。显式设置可覆盖——针对
   * 强制思考的模型（如 glm-5.3-flash：不带 low/high/max 直接 400 1210），
   * 子代理请求必须点名一个合法档位。schema 此前漏声明此字段（ResolvedConfig
   * 有消费无入口，2026-08-29 补上）。
   *
   * 注意：这里不是 zod——`z` 实为 @deepseek-ai/schemastery 的 Schema，
   * 没有 .optional() 方法（不加 .required() 就默认可选）。写成
   * z.string().optional() 会在模块加载时 TypeError，炸掉整个插件树
   * （2026-08-29 踩过：3081 启动即崩）。
   */
  subagentReasoning: z.string(),
})

export interface ResolvedConfig {
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
  /** 子 agent 推理等级（'off'|'low'|'high'|'max'）；缺省跟随全局默认模型选择。 */
  subagentReasoning?: string
}

export function resolveConfig(config: unknown): ResolvedConfig {
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
    ...c.subagentReasoning === undefined ? {} : { subagentReasoning: c.subagentReasoning },
  }
}
