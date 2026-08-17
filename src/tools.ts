/**
 * tools.ts — dsh-femwa 主模型专用工具（femwa-mount / femwa-run）。
 *
 * 只注册给主模型（无 parentSession 的 fem 会话 agent）；子代理（角色）
 * 不可见——挂载/运行剧本是导演的事。执行体通过依赖注入复用 index.ts 的
 * 现成链路（run / session-script），不在本文件重复实现。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** index.ts 注入给工具的执行依赖。 */
export interface FemwaToolDeps {
  /** 挂载剧本到会话（写会话记录 {path}，用户 femgen 立即可见）。 */
  mountScript(sessionId: string, scriptPath: string): Promise<void>
  /** 运行剧本（scriptPath 省略 = 运行已挂载剧本）。 */
  runScript(sessionId: string, scriptPath?: string): Promise<void>
  /** 是否为 fem 主会话（无 parentSession）——工具调用者校验。 */
  isFemMainSession(agent: Agent): boolean
}

/** 工具 schema：name/description/parameters（与 ToolSchema 对齐的最小面）。 */
interface FemwaToolSchema {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: boolean
  }
}

/** 调用者会话 id（主模型专用校验 + 提取）。返回 null = 非主模型调用。 */
function callerSessionId(deps: FemwaToolDeps, agent: Agent | undefined): string | null {
  if (agent === undefined || !deps.isFemMainSession(agent)) return null
  return String(agent.session.id)
}

/** femwa-mount：把剧本文件挂载到本会话（用户 femgen 立即可见）。 */
const mountTool: FemwaToolSchema = {
  name: 'femwa-mount',
  description:
    '把剧本文件挂载到当前 Fem 会话：用户会在 femgen 编辑器里立刻看到这个剧本，可以查看/编辑。' +
    '写剧本时用文件工具把 .fems 写到 user_data/projects/ 下，然后调用本工具挂载。' +
    '参数 scriptPath 是剧本文件的完整路径。',
  parameters: {
    type: 'object',
    properties: {
      scriptPath: {
        type: 'string',
        description: '剧本文件完整路径（.fems）',
      },
    },
    required: ['scriptPath'],
    additionalProperties: false,
  },
}

/** femwa-run：运行剧本（省略 scriptPath = 运行已挂载的剧本）。 */
const runTool: FemwaToolSchema = {
  name: 'femwa-run',
  description:
    '在当前 Fem 会话运行剧本。省略 scriptPath 时运行已挂载的剧本（femwa-mount 挂载的）。' +
    '运行后剧本由引擎驱动，角色发言显示在投影窗；运行期间你不会收到消息，跑完用户会告诉你。',
  parameters: {
    type: 'object',
    properties: {
      scriptPath: {
        type: 'string',
        description: '剧本文件完整路径（.fems）；省略 = 运行已挂载的剧本',
      },
    },
    additionalProperties: false,
  },
}

/** 注册 femwa 主模型工具（幂等：重复调用先注销再注册）。 */
export function registerFemwaTools(
  ctx: Context,
  deps: FemwaToolDeps,
): () => void {
  const tools = ctx.get('tools') as {
    register(def: {
      name: string
      description: string
      parameters: unknown
      output: { schema: unknown }
      execute(args: unknown, exec: { agent?: Agent; signal: AbortSignal }): Promise<unknown>
    }): () => void
  } | undefined
  if (tools === undefined) {
    console.log('[dsh-femwa] tools service unavailable; femwa-mount/femwa-run not registered')
    return () => undefined
  }

  const disposers: Array<() => void> = []

  const register = (schema: FemwaToolSchema, run: (args: Record<string, unknown>, agent: Agent) => Promise<unknown>): void => {
    const dispose = tools.register({
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      output: { schema: { type: 'object', properties: {}, additionalProperties: true } },
      execute: async (args, exec) => {
        const sid = callerSessionId(deps, exec.agent)
        if (sid === null) {
          return { ok: false, error: '该工具仅 Fem 主会话可用（角色/子代理不可调用）' }
        }
        try {
          return await run((args ?? {}) as Record<string, unknown>, exec.agent!)
        } catch (error: unknown) {
          return { ok: false, error: String(error instanceof Error ? error.message : error) }
        }
      },
    })
    disposers.push(dispose)
    console.log(`[dsh-femwa] tool registered: ${schema.name}`)
  }

  register(mountTool, async (args, agent) => {
    const scriptPath = typeof args.scriptPath === 'string' && args.scriptPath.trim().length > 0
      ? args.scriptPath.trim()
      : ''
    if (scriptPath.length === 0) {
      return { ok: false, error: 'scriptPath 是必填参数' }
    }
    await deps.mountScript(String(agent.session.id), scriptPath)
    return { ok: true, mounted: scriptPath }
  })

  register(runTool, async (args, agent) => {
    const scriptPath = typeof args.scriptPath === 'string' && args.scriptPath.trim().length > 0
      ? args.scriptPath.trim()
      : undefined
    await deps.runScript(String(agent.session.id), scriptPath)
    return { ok: true, running: scriptPath ?? '已挂载剧本' }
  })

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 注销失败不阻塞 */ }
    }
    disposers.length = 0
  }
}
