/**
 * run-control.ts — 开演流程。
 *
 * 真正让一场戏跑起来的完整动作：读剧本（inline 文本或文件地址）、写会话剧本
 * 记录（地址/原文一致性判定）、清/带断点、解析 API key、命令引擎开跑。
 * 前端的运行按钮（/run、/create-session 路由）和 AI 的 femwa-run/femwa-mount
 * 工具最终都走到 startRunOnSession。另含剧本文件的保存/读取 handler 和
 * LLM 模型目录聚合（前端下拉 + 引擎编译校验白名单共用）。
 * 从 index.ts 原样迁出（2026-08-23 重构）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FemwaBridge } from './bridge'
import type { ResolvedConfig } from './config'
import { readBody, writeJson, broadcastSse, type SaveScriptBody } from './http'
import { FEM_PRESET, presetOf, injectFemwaDocs, femwaDocsSections } from './persona'
import {
  readCheckpoint, writeCheckpoint, clearCheckpoint,
  readSessionScript, writeSessionScript, readSessionScriptText,
} from './state-files'

// ── 凭证与模型目录 ────────────────────────────────────────────────────────

/** Resolve the engine's LLM key from dsh credentials (absent → AI nodes fail). */
async function resolveApiKey(ctx: Context, resolved: ResolvedConfig): Promise<string | undefined> {
  const credentials = ctx.get('credentials') as { resolve(ref: unknown): Promise<{ value: string } | undefined> } | undefined
  if (credentials === undefined) return undefined
  const cred = await credentials.resolve(resolved.apiKeyRef)
  return cred !== undefined ? cred.value : undefined
}

interface LlmModelEntry { id: string; name?: string }
interface LlmProviderEntry { id: string; name?: string; models: LlmModelEntry[] }
/** 剧本 source 白名单 payload：引擎编译期校验 + 前端下拉的数据源。 */
interface LlmModelsPayload {
  /** 裸 id source 归属的默认 provider（插件配置 dshProvider）。 */
  defaultProvider: string
  providers: LlmProviderEntry[]
}

/** 聚合 dsh 当前可用 LLM provider/模型列表（前端下拉 + 引擎编译校验白名单）。
 * llm 服务缺失或单个 provider 拉取失败 → 兜底默认/跳过，绝不整体失败。 */
export async function collectLlmModels(ctx: Context, resolved: ResolvedConfig): Promise<LlmModelsPayload> {
  const fallback: LlmModelsPayload = {
    defaultProvider: resolved.dshProvider,
    providers: [{ id: resolved.dshProvider, models: [{ id: resolved.model }] }],
  }
  const llm = ctx.get('llm') as {
    listProviders(): { id: string; name?: string }[]
    listModels(provider: string): Promise<readonly { id: string; name?: string }[]>
  } | undefined
  if (llm === undefined || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return fallback
  }
  let providers: LlmProviderEntry[]
  try {
    providers = []
    for (const info of llm.listProviders()) {
      try {
        const models = await llm.listModels(info.id)
        providers.push({ id: info.id, name: info.name, models: models.map((m) => ({ id: m.id, name: m.name })) })
      } catch (error: unknown) {
        console.log(`[dsh-femwa] listModels(${info.id}) failed: ${String(error)}`)
      }
    }
  } catch (error: unknown) {
    console.log(`[dsh-femwa] listProviders failed: ${String(error)}`)
    return fallback
  }
  if (providers.length === 0) return fallback
  return { defaultProvider: resolved.dshProvider, providers }
}

// ── 开跑 ─────────────────────────────────────────────────────────────────

/** Start one engine run bound to a Fem session. Registers the run owner
 * BEFORE sending: a tiny script can finish before the run response returns,
 * and events would be dropped. A checkpoint from a previous interrupted run
 * rides along so the engine resumes from the recorded node positions. */
export async function startRunOnSession(
  ctx: Context,
  resolved: ResolvedConfig,
  bridge: FemwaBridge,
  runState: { sessionId?: SessionId; running: boolean },
  sessionId: SessionId,
  scriptText: string,
  scriptPath?: string,
  reset = false,
): Promise<void> {
  const apiKey = await resolveApiKey(ctx, resolved)
  if (apiKey === undefined) {
    console.log(`[dsh-femwa] credential ${resolved.apiKeyRef} not resolved; AI nodes will fail`)
  }
  // 会话剧本记录 + 运行时一致性检测：引擎永远跑「前端文本」；记录形态取决于
  // 地址文件与前端文本是否一致——一致 → 只存地址（不保留原文）；不一致 →
  // 地址与原文并存（text=浏览器端实际运行版本）。读历史时 text 优先。
  const sid = String(sessionId)
  const prev = await readSessionScript(resolved.femwaRoot, sid)
  const effectivePath = scriptPath ?? prev?.path
  try {
    if (effectivePath !== undefined) {
      const { readFile } = await import('node:fs/promises')
      let fileText: string | undefined
      try {
        fileText = await readFile(effectivePath, 'utf8')
      } catch {
        fileText = undefined // 地址文件被删：降级为原文态（不报错）
      }
      const same = fileText !== undefined && fileText.replace(/\r\n/g, '\n') === scriptText.replace(/\r\n/g, '\n')
      await writeSessionScript(resolved.femwaRoot, sid, same
        ? { path: effectivePath }
        : { path: effectivePath, text: scriptText })
    } else {
      await writeSessionScript(resolved.femwaRoot, sid, { text: scriptText })
    }
  } catch (error: unknown) {
    console.log(`[dsh-femwa] session script record failed: ${String(error)}`)
  }
  // 记录随运行版本更新（rev 已变）：广播各端静默同步 rev/内容，
  // 避免各页面下次快照写因 rev 滞后而误触 409 冲突弹窗。
  broadcastSse('script_changed', { sessionId })
  if (reset) {
    // 手动「运行」：作废旧 checkpoint，从头跑。
    await clearCheckpoint(resolved.femwaRoot, String(sessionId)).catch(() => undefined)
    console.log(`[dsh-femwa] reset ${sessionId}: checkpoint cleared, running from start`)
  }
  const checkpoints = await readCheckpoint(resolved.femwaRoot, String(sessionId))
  // 双保险：终点点（[END]/[BREAK]）永远不作续跑位置（老引擎可能已写入）。
  for (const [key, value] of Object.entries(checkpoints)) {
    if (value === '[END]' || value === '[BREAK]') delete checkpoints[key]
  }
  if (Object.keys(checkpoints).length > 0) {
    console.log(`[dsh-femwa] resuming ${sessionId} from checkpoint: ${JSON.stringify(checkpoints)}`)
  }
  runState.sessionId = sessionId
  runState.running = true
  try {
    // base_dir = 剧本文件所在目录（todo #2）：code/memory/context 的相对
    // file: 地址基于它解析。有地址（已保存/导入）→ 剧本文件所在目录；
    // 未保存（纯文本）→ 传空字符串，引擎对相对路径直接报错（只支持绝对地址）。
    const baseDir = effectivePath !== undefined
      ? effectivePath.replace(/[\\/][^\\/]*$/, '')
      : ''
    await bridge.send('run', {
      fems: scriptText,
      base_dir: baseDir,
      user_api_key: apiKey,
      user_api_provider: resolved.provider,
      user_api_url: resolved.apiUrl,
      user_api_model: resolved.model,
      dsh_ai_backend: resolved.dshAiBackend,
      // source 编译期校验白名单：引擎 parse_script 时校验 actors 的 source 字段
      models: await collectLlmModels(ctx, resolved),
      ...Object.keys(checkpoints).length > 0 ? { checkpoints } : {},
    }, 30_000)
  } catch (error: unknown) {
    runState.running = false
    throw error
  }
  console.log(`[dsh-femwa] started script on ${sessionId}${scriptPath !== undefined ? ` (${scriptPath})` : ''}`)
}

// ── 剧本文件读写 handler ──────────────────────────────────────────────────

/** Read one run's script text from an inline body or a script path. */
async function readScriptText(fems: string | undefined, scriptPath: string | undefined): Promise<string> {
  if (fems !== undefined) return fems
  const { readFileSync } = await import('node:fs')
  return readFileSync(scriptPath!, 'utf8')
}

/** Save a user-pasted script into the FemWA project's user_data/projects. */
export async function handleSaveScript(
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
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const rawPath = typeof body.path === 'string' && body.path.trim().length > 0 ? body.path.trim() : ''
  if (rawPath.length > 0) {
    // 导出流程：用户经系统目录选择器选定目录 + 文件名 → 绝对路径直写。
    // 确保扩展名 .fems（用户目录选择器只选目录，文件名由前端拼接）。
    const path = rawPath.toLowerCase().endsWith('.fems') ? rawPath : `${rawPath}.fems`
    writeFileSync(path, content, 'utf8')
    console.log(`[dsh-femwa] saved script to ${path}`)
    writeJson(res, 200, { ok: true, path })
    return
  }
  // Sanitize the file name: keep safe chars, force .fems.
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.fems$/i, '')
  const projectsDir = `${resolved.femwaRoot}\\user_data\\projects`
  mkdirSync(projectsDir, { recursive: true })
  const path = `${projectsDir}\\${safe}.fems`
  writeFileSync(path, content, 'utf8')
  console.log(`[dsh-femwa] saved script to ${path}`)
  writeJson(res, 200, { ok: true, path })
}

/** GET /dsh-femwa/script?path=... — read one script file's content. */
export async function handleReadScript(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

// ── HTTP handler：在既有会话上开演 / 新建会话即开演 ────────────────────────

/**
 * POST /dsh-femwa/run — play a script on an EXISTING Fem session (the script
 * panel's "save and run" lands here; create-session stays for the sidebar's
 * new-session flow). The session must already be Fem mode: a standard session
 * has a main model and this plugin must not start an engine run behind it.
 */
export async function handleRunOnSession(
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
    // 引擎一次只能演一场：409 带上归属会话，前端/模型能分清是谁家在跑。
    const owner = String(runState.sessionId ?? '?')
    writeJson(res, 409, {
      ok: false,
      error: owner === sessionId
        ? '本会话已有剧本在运行中，请先停止'
        : `另一会话（${owner}）的剧本正在运行（引擎同时只能演一场），请先停止`,
    })
    return
  }
  const fems = typeof body.fems === 'string' && body.fems.trim().length > 0 ? body.fems : undefined
  const scriptPath = typeof body.scriptPath === 'string' && body.scriptPath.trim().length > 0 ? body.scriptPath : undefined
  if (fems === undefined && scriptPath === undefined) {
    writeJson(res, 400, { ok: false, error: 'fems or scriptPath is required' })
    return
  }
  // 「运行」= 作废快照从头；「继续」= 不传 reset（自动带 checkpoint 续跑）。
  const reset = body.reset === true
  try {
    const scriptText = await readScriptText(fems, scriptPath)
    await startRunOnSession(ctx, resolved, bridge, runState, sessionId, scriptText, scriptPath, reset)
    writeJson(res, 200, { ok: true, sessionId: String(sessionId) })
  } catch (error: unknown) {
    console.log(`[dsh-femwa] run-on-session FAILED: ${String(error)}`)
    writeJson(res, 500, { ok: false, error: String(error) })
  }
}

/** Create one Fem session; when a fems script body is supplied, start it. */
export async function handleCreateSession(
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
  // 模型来源（2026-08-24 用户拍板「不要写provider」）：不写配置默认（deepseek
  // 系在 meow 等部署无 adapter → NO_ADAPTER），跟随用户保存的默认模型选择
  // （与 dsh web 建会话的 selectionFor 语义一致）。未保存过默认 → 不传，
  // 首个导演轮次会响亮报错提示去选模型，绝不静默落到部署隐式默认。
  const defaultModel = ctx.get('agentDefaultModel') as { currentSelection?(): unknown } | undefined
  const sel = defaultModel?.currentSelection?.() as { provider?: unknown; model?: unknown } | undefined
  const agentOptions = typeof sel?.provider === 'string' && sel.provider.length > 0
    && typeof sel.model === 'string' && sel.model.length > 0
    ? { provider: sel.provider, model: sel.model }
    : undefined
  const id = SessionId(`fem-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
  try {
    const handle = await ctx.agents.create({
      sessionId: id,
      meta: {
        cwd,
        agentPreset: FEM_PRESET,
      },
      ...agentOptions !== undefined ? { agentOptions } : {},
      // Mount the preset composition (persona + tools) so subagents spawned
      // under this session join it — without this the child sees no preset
      // tools and no persona (the RPC create path does this in its setup).
      setup: async (agentCtx: Context): Promise<void> => {
        const presets = ctx.get('agentPresets') as { mount?(agentCtx: Context, id: string): Promise<unknown> } | undefined
        if (presets?.mount === undefined) return
        try {
          await presets.mount(agentCtx, FEM_PRESET)
          // 注入语法文档路径（插件自包含布局，路径随插件位置变化——动态算）。
          const dispose = injectFemwaDocs(agentCtx)
          if (dispose !== undefined) femwaDocsSections.set(String(id), dispose)
        } catch (error: unknown) {
          console.log(`[dsh-femwa] preset mount failed: ${String(error)}`)
        }
      },
    })
    console.log(`[dsh-femwa] created fem session ${handle.agent.id} (cwd=${cwd})`)
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
