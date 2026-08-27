/**
 * tools.ts — dsh-femwa 主模型专用工具（femwa-mount / femwa-run / femwa-script）。
 *
 * 只注册给主模型（无 parentSession 的 fem 会话 agent）；子代理（角色）
 * 不可见——挂载/运行/查看剧本是导演的事。执行体通过依赖注入复用 index.ts 的
 * 现成链路（run / session-script），不在本文件重复实现。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { appendChatBroadcast, type ProjectionRegistry } from './projection'

/** 前端「模拟按 run 按钮」回传给工具的结果（POST /dsh-femwa/run-result）。 */
export type RunResult = {
  ok: boolean
  error?: string
  /** 多端不统一时：哪边脏 + record 原文 + 编辑器本地文本（AI 自己裁决用）。 */
  conflicts?: Record<string, unknown>
  note?: string
}

/** index.ts 注入给工具的执行依赖。 */
export interface FemwaToolDeps {
  /** 挂载剧本到会话（写会话记录 {path}，用户 femgen 立即可见）。 */
  mountScript(sessionId: string, scriptPath: string): Promise<void>

  /** 取走自上次调用以来的编辑器上报错误（restore/解析失败等），随工具结果回传主模型。 */
  takeEditorErrors?(sessionId: string): string[]
  /** AI 触发 fresh_start：模拟按前端 run 按钮——广播 run_request 给编辑器，
   * 等前端守卫+语法检查+点火后的回传结果。工具不做任何检测。 */
  runEditorCommand(sessionId: string): Promise<RunResult>
  /** 停止当前运行（保留 checkpoint，可 resume 续跑）。 */
  stopScript(sessionId: string): Promise<void>
  /** 暂停当前运行（bridge 现有语义；保留 checkpoint）。 */
  pauseScript(sessionId: string): Promise<void>
  /** 从断点继续运行（不 reset 的 run：自动带 checkpoint 续跑）。 */
  resumeScript(sessionId: string): Promise<void>
  /** 读会话当前挂载的剧本内容（最终生效文本 + 来源记录）。 */
  readScript(sessionId: string): Promise<{ path?: string; text?: string; finalText: string } | undefined>
  /** 列出全部角色（soul_id + soul_name，精简；femwa-soul list）。 */
  soulList(): Promise<{ souls: Array<{ soul_id: string; soul_name: string }> }>
  /** 新建角色（全局，所有剧本可用；归属 u001；femwa-soul create）。 */
  soulCreate(soulId: string, soulName: string, description: string): Promise<unknown>
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

/**
 * femwa-run：控制当前 Fem 会话的剧本运行（fresh_start/stop/pause/resume）。
 * 剧本本身不在此传——先 femwa-mount 挂载，或用 femGen 编辑器写入。
 */
const runTool: FemwaToolSchema = {
  name: 'femwa-run',
  description:
    '控制当前 Fem 会话的剧本运行。action 必填，四选一：\n' +
    '- fresh_start：从头开始运行已挂载的剧本（清空断点，全新一轮）\n' +
    '- stop：停止正在运行的剧本（保留断点，之后可 resume 续跑）\n' +
    '- pause：暂停正在运行的剧本（保留断点）\n' +
    '- resume：从断点继续运行上次 stop/pause 的剧本（不从头）\n' +
    '运行后剧本由引擎驱动，角色发言显示在投影窗，不进入你的上下文；' +
    '编译错误随本工具返回值给出；跑到一半报错或全部跑完时，会有一条 [dsh-femwa] 开头的插件消息直接发进你的对话流。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['fresh_start', 'stop', 'pause', 'resume'],
        description: '对剧本运行的控制动作：fresh_start=从头运行 / stop=停止 / pause=暂停 / resume=从断点继续',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
}

/** femwa-script：查看当前会话挂载的剧本内容（AI 读剧本用）。 */
const viewScriptTool: FemwaToolSchema = {
  name: 'femwa-script',
  description:
    '查看当前 Fem 会话挂载的剧本完整内容（最终生效版本：编辑器原文优先，否则读剧本文件地址指向的内容）。' +
    '返回剧本全文、来源（file=文件地址 / session-text=会话内原文）和行数。' +
    '写剧本/改剧本前先调用本工具，了解当前挂载的剧本是什么；会话未挂载剧本时会明确报错。',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
}

/** femwa-soul：管理角色库（list=查库选角 / create=新建角色）。 */
const soulTool: FemwaToolSchema = {
  name: 'femwa-soul',
  description:
    '管理角色库（souls）：\n' +
    '- list：查看库中全部角色（soul_id + 名字）。写剧本选角前先调用本工具查库；\n' +
    '- create：新建角色。参数 soul_id（剧本里用 soul:xxx 引用，不能含空格/逗号）、soul_name（显示名）、description（角色的灵魂设定，注入给扮演它的 AI）。\n' +
    '角色是全局的（所有剧本可用）。soul 非必须：无角色设定的简单剧本（如 goal 模式）可以不写 soul；' +
    '需要角色设定的剧本，库里没有的角色先用本工具 create 新建，再在剧本里引用。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'create'],
        description: 'list=查看全部角色 / create=新建角色',
      },
      soul_id: {
        type: 'string',
        description: 'create 必填：角色唯一标识（剧本里 soul:xxx 引用；不能含空格/逗号）',
      },
      soul_name: {
        type: 'string',
        description: 'create 必填：角色显示名',
      },
      description: {
        type: 'string',
        description: 'create 必填：角色的灵魂设定（system prompt 片段，扮演该角色的 AI 会看到）',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
}

/** 注册 femwa 主模型工具（幂等：重复调用先注销再注册）。
 * projections 用于把动作回执广播进投影窗（主会话+god+全部角色窗统一通知）。 */
export function registerFemwaTools(
  ctx: Context,
  deps: FemwaToolDeps,
  projections: ProjectionRegistry,
): () => void {
  // cordis 服务注入后直接挂 ctx 属性（dsh-tool-todo 等插件同样用法）。
  const tools = (ctx as unknown as { tools?: {
    register(def: {
      name: string
      description: string
      parameters: unknown
      output: {
        schema: unknown
        render(args: unknown, value: { ok: boolean; error?: string }): Array<{ type: 'text'; text: string }>
      }
      execute(args: unknown, exec: { agent?: Agent; signal: AbortSignal }): Promise<unknown>
    }): () => void
  } }).tools
  if (tools === undefined) {
    console.log('[dsh-femwa] tools service unavailable; femwa-mount/femwa-run/femwa-script not registered')
    return () => undefined
  }

  const disposers: Array<() => void> = []

  const register = (
    schema: FemwaToolSchema,
    run: (args: Record<string, unknown>, agent: Agent) => Promise<unknown>,
    renderText?: (value: { ok: boolean; error?: string; script?: string; source?: string; lines?: number; path?: string; souls?: Array<{ soul_id: string; soul_name: string }>; note?: string }) => string,
  ): void => {
    const dispose = tools.register({
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: { ok: boolean; error?: string; script?: string; source?: string; lines?: number; path?: string }) => [{
          type: 'text',
          text: value.ok === true
            ? (renderText !== undefined ? renderText(value) : JSON.stringify(value))
            : `❌ ${value.error ?? '未知错误'}`,
        }],
      },
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
    const editorErrors = deps.takeEditorErrors?.(String(agent.session.id)) ?? []
    return { ok: true, mounted: scriptPath, ...(editorErrors.length > 0 ? { editor_errors: editorErrors } : {}) }
  })

  register(runTool, async (args, agent) => {
    const action = typeof args.action === 'string' ? args.action.trim() : ''
    if (action !== 'fresh_start' && action !== 'stop' && action !== 'pause' && action !== 'resume') {
      return { ok: false, error: 'action 是必填参数：fresh_start / stop / pause / resume 四选一' }
    }
    const sid = String(agent.session.id)
    switch (action) {
      case 'fresh_start': {
        // AI 触发 = 模拟人类按前端 run 按钮：多端守卫 + 语法检查全由前端
        // handleRunWorkflow 完成（一份逻辑），结果经 run-result 回传。
        // 本工具不再做任何检测（不 readScript / 不 takeEditorErrors）。
        const result = await deps.runEditorCommand(sid)
        if (result.ok !== true) {
          return {
            ok: false,
            error: result.error ?? '前端未响应（编辑器未打开或超时）',
            ...(result.conflicts !== undefined ? { conflicts: result.conflicts } : {}),
          }
        }
        // 成功回执广播全部窗口给用户看（主会话+god+角色窗；纯 UI，不进模型上下文）。
        appendChatBroadcast(ctx, agent.session, projections, '🎬 剧本已开始（在上帝视角窗口查看）')
        return { ok: true, action, note: result.note ?? '已从头开始运行剧本' }
      }
      case 'stop':
        // 停止/暂停的用户通知由引擎 flow_stopped 统一广播（前端按钮触发也走
        // 同一事件），工具侧不再重复写——避免同窗双份通知。
        await deps.stopScript(sid)
        return { ok: true, action, note: '已停止运行（断点保留，可 resume 续跑）' }
      case 'pause':
        await deps.pauseScript(sid)
        return { ok: true, action, note: '已暂停运行（断点保留）' }
      case 'resume':
        await deps.resumeScript(sid)
        appendChatBroadcast(ctx, agent.session, projections, '▶️ 剧本已继续（在上帝视角窗口查看）')
        return { ok: true, action, note: '已从断点继续运行' }
    }
  })

  register(viewScriptTool, async (_args, agent) => {
    const record = await deps.readScript(String(agent.session.id))
    if (record === undefined) {
      return { ok: false, error: '会话未挂载剧本：请先 femwa-mount 挂载，或用 femGen 编辑器写入剧本' }
    }
    return {
      ok: true,
      source: record.path !== undefined ? 'file' : 'session-text',
      path: record.path,
      lines: record.finalText.split('\n').length,
      script: record.finalText,
    }
  }, (value) => {
    const head = `📜 挂载剧本（${value.source ?? ''}${value.path !== undefined ? `: ${value.path}` : ''}，${value.lines ?? '?'} 行）`
    return `${head}\n\n${value.script ?? ''}`
  })

  register(soulTool, async (args) => {
    const action = typeof args.action === 'string' ? args.action.trim() : ''
    if (action === 'list') {
      const { souls } = await deps.soulList()
      return { ok: true, souls }
    }
    if (action === 'create') {
      const soulId = typeof args.soul_id === 'string' ? args.soul_id.trim() : ''
      const soulName = typeof args.soul_name === 'string' ? args.soul_name.trim() : ''
      const description = typeof args.description === 'string' ? args.description : ''
      if (soulId.length === 0 || soulName.length === 0 || description.length === 0) {
        return { ok: false, error: 'create 需要 soul_id / soul_name / description 三个参数（全部必填）' }
      }
      if (/[\s,，]/.test(soulId)) {
        return { ok: false, error: `soul_id "${soulId}" 不能含空格或逗号（剧本里 soul:xxx 引用用）` }
      }
      await deps.soulCreate(soulId, soulName, description)
      return { ok: true, note: `已创建角色 ${soulName}（soul_id=${soulId}，剧本里用 soul:${soulId} 引用）` }
    }
    return { ok: false, error: 'action 必填：list 或 create 二选一' }
  }, (value) => {
    if (value.note !== undefined) return value.note
    if (Array.isArray(value.souls)) {
      if (value.souls.length === 0) return '角色库为空'
      return `🎭 角色库（${value.souls.length} 个角色）：\n`
        + value.souls.map(s => `- ${s.soul_id}（${s.soul_name}）`).join('\n')
    }
    return JSON.stringify(value)
  })

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 注销失败不阻塞 */ }
    }
    disposers.length = 0
  }
}
