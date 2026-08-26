/**
 * projection-input.ts — 投影窗输入路由（2026-08-26 自 routes.ts 迁出）。
 *
 * 全插件最复杂的业务路由：投影窗 composer 发言按运行状态三路分发——
 * ①剧本未跑/已暂停 → 进程内直调 apiProxy.sessions.prompt 以真实用户身份
 *   steer 主模型（消息进主会话对话流，上帝窗镜像自然映射）；
 * ②跑本中且人类节点等待 → 喂引擎 human_input 并广播 role 行；
 * ③跑本中其他时候 → 仅本窗留痕（打断语义待编译器实现）。
 * 附诊断文件日志（host stdout 不可见时的排障回路）。
 * （routes.ts 只留注册分发；本文件行为与迁出前逐字一致。）
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { FemwaBridge } from './bridge'
import type { ResolvedConfig } from './config'
import { readBody, writeJson } from './http'
import type { RunState } from './engine-events'
import { appendEvent, appendChatProjected, type ProjectionRegistry } from './projection'

export interface ProjectionInputDeps {
  resolved: ResolvedConfig
  bridge: FemwaBridge
  runState: RunState
  projections: ProjectionRegistry
  sessionsStore?: { get(id: SessionId): Session | undefined }
}

/** POST /dsh-femwa/projection-input — route one projection-window message. */
export async function handleProjectionInput(
  ctx: Context,
  deps: ProjectionInputDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { resolved, bridge, runState, projections, sessionsStore } = deps
  // 诊断轨迹（2026-08-25）：host stdout 不可见，路由全程写文件日志——
  // 每次调用的入参/分支/自调用结果全部落 user_data/debug-projection-input.log，
  // 排查「投影窗发言无反应」时直接读该文件即可分辨端内/端外问题。
  const debugLog = (line: string): void => {
    try {
      appendFileSync(join(resolved.femwaRoot, 'user_data', 'debug-projection-input.log'),
        `[${new Date().toISOString()}] ${line}\n`, 'utf8')
    } catch { /* 日志失败不影响主路 */ }
  }
  debugLog(`=== invoke ===`)
  // 投影窗输入路由（2026-08-24 用户定稿语义）：
  // ①剧本未跑/暂停/已停止 → 走主窗口前门 session.prompt（steer），消息以
  //   真实用户身份进入主会话对话流；上帝窗镜像自然映射，本窗不留痕；
  // ②跑本中且人类节点等待 → bridge human_input 喂引擎（wait_key），并广播 role 行进各投影窗；
  // ③跑本中其他时候 → 人类插话（编译器规划中的打断语义，暂不实现）：仅本窗留痕。
  const raw = await readBody(req) as Record<string, unknown>
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.trim().length > 0 ? raw.sessionId : ''
  const text = typeof raw.text === 'string' && raw.text.trim().length > 0 ? raw.text.trim() : ''
  debugLog(`payload: sessionId=${sessionId} textLen=${text.length}`)
  if (sessionId.length === 0 || text.length === 0) {
    writeJson(res, 400, { ok: false, error: 'sessionId and text are required' })
    return
  }
  const sessions = ctx.get('sessions') as { get(id: SessionId): Session | undefined } | undefined
  const win = sessions?.get(SessionId(sessionId))
  if (win === undefined) {
    debugLog(`result: 404 window not found in store`)
    writeJson(res, 404, { ok: false, error: `session ${sessionId} not found` })
    return
  }
  // 主会话 id：优先 parentSession 头；兜底从 fem-proj-<sid>-<actorKey> 尾段剥离
  //（actorKey 只含 [A-Za-z0-9_]，不含 '-'，故最后一个 '-' 右侧必是 actorKey）。
  const parentHeader = (win.header as { parentSession?: string } | undefined)?.parentSession
  const mainSid = typeof parentHeader === 'string' && parentHeader.length > 0
    ? parentHeader
    : (sessionId.startsWith('fem-proj-')
      ? sessionId.slice('fem-proj-'.length).replace(/-[^-]*$/, '')
      : '')
  const waiting = runState.running === true && runState.pausedByUser !== true
    && runState.humanWait !== undefined
  const idle = runState.running !== true || runState.pausedByUser === true
  if (idle) {
    // ①直达主模型（2026-08-24 用户定稿，反转 steer 注入方案）：进程内直调宿主
    // 自己的 ctx.apiProxy.sessions.prompt——与主窗口输入框完全同一入口，
    // 消息以真实用户身份进入主会话对话流并触发回合；上帝窗镜像自然映射双方。
    // 不做 HTTP 自调用：两次实败已证明不可靠——host 内 DSH_WEB_URL 可能指向
    // 另一实例（实测 :3080 session-not-found）；浏览器 Host 头可能是 Tailscale
    // https 隧道域（实测 :8443 http 自调 400）。
    // steer 模式：空闲=立即开新回合；忙碌=下一步边界送达（queue 空闲时进
    // 隐形收件箱永不消费，2026-08-25 弃）。
    type PromptResult = { ok?: boolean; value?: { accepted?: boolean }; error?: { code?: string; message?: string } }
    const bag = ctx as unknown as { get(name: string): unknown }
    const apiProxy = bag.get('apiProxy') as
      | { sessions: { prompt(request: { rpcId: string; payload: { sessionId: SessionId; mode: 'queue' | 'steer'; content: Array<{ type: 'text'; text: string }> } }): Promise<{ result?: PromptResult }> } }
      | undefined
    debugLog(`branch① idle -> apiProxy.sessions.prompt steer mainSid=${mainSid}`)
    if (apiProxy?.sessions?.prompt === undefined) {
      debugLog('branch① FAILED: apiProxy service unavailable')
      writeJson(res, 200, { ok: false, routed: 'main', error: 'apiProxy service unavailable' })
      return
    }
    const rpcRes = await apiProxy.sessions.prompt({
      rpcId: randomUUID(),
      payload: { sessionId: SessionId(mainSid), mode: 'steer', content: [{ type: 'text', text }] },
    }).catch((error: unknown) => {
      debugLog(`branch① prompt threw: ${String(error)}`)
      return undefined
    })
    const r = rpcRes?.result as PromptResult | undefined
    if (r?.error !== undefined || r?.ok === false) {
      debugLog(`branch① FAILED: ${JSON.stringify(r?.error ?? null)}`)
      console.log(`[dsh-femwa] projection-input -> session.prompt failed: ${JSON.stringify(r?.error ?? null)}`)
      writeJson(res, 200, { ok: false, routed: 'main', error: r?.error?.message ?? 'session.prompt rejected' })
      return
    }
    const accepted = r?.value?.accepted === true
    debugLog(`branch① accepted=${accepted} len=${text.length}`)
    console.log(`[dsh-femwa] projection input -> main session.prompt accepted: sid=${mainSid} len=${text.length}`)
    writeJson(res, 200, { ok: true, routed: 'main', accepted })
    return
  }
  // ②③跑本中：投影窗本地留痕（用户自己说的话要看得见；①不需要——镜像已覆盖）
  appendEvent(win, 'user/message', {
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  if (waiting) {
    // ②人类节点发言：按剧本喂给引擎 + 广播 role 行（全窗可见）
    await bridge.send('human_input', {
      wait_key: String(runState.humanWait?.waitKey ?? ''),
      body: { chat_text: text, variables: {} },
    })
    const main = sessionsStore?.get(SessionId(mainSid))
    if (main !== undefined) {
      appendChatProjected(ctx, main, projections, text, 'role', '人类')
    }
    writeJson(res, 200, { ok: true, routed: 'human-node' })
    return
  }
  // ③人类插话（打断语义待编译器实现）：已本窗留痕，暂不路由
  console.log(`[dsh-femwa] projection input kept local (interjection not implemented): len=${text.length}`)
  writeJson(res, 200, { ok: true, routed: 'interjection-todo' })
}
