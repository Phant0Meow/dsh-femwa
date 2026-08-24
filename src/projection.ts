/**
 * projection.ts — 投影窗管家。
 *
 * 投影窗（子代理视角窗）：角色/上帝视角从「主会话 CSS 过滤」迁移到
 * 「dsh 原生子代理会话窗」。投影窗 = 无 agent 会话 + origin:subagent +
 * parentSession=主会话 + subagent/descriptor（dsh 原生身份，可进子代理目录、
 * 标题=label、持久化自动）。事件按 turn-scope 投影进对应窗，主会话表面
 * 不再接收角色内容（为「主会话=戏外视角」铺路）。
 *
 * 本模块含四块：
 *  1. appendChat / appendChatProjected —— dsh-femwa/chat 行写入（主会话表面
 *     与投影窗投影，唯一例外 alsoMainSession=llmBridge 直连双写）；
 *  2. 投影窗生命周期 —— ensure/awaken/registry（幂等、冷唤醒、inflight 串行）；
 *  3. projectionAppend —— 按 scope 把事件投进对应窗（空数组=广播全部角色窗）；
 *  4. createGodMirror —— 主会话→上帝窗镜像（实时监听 + 水位补齐），原 apply()
 *     闭包逻辑工厂化（2026-08-23 重构，行为零变化）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'

/** 会话事件的动态 append 面：事件类型在运行时来自引擎事件流/镜像白名单
 * （超出静态 SessionEventMap 的字面量联合，如 subagent/descriptor、镜像的
 * turn/step 结构），统一经此宽化签名调用 session.append——方法引用与参数值
 * 与直接调用完全一致，仅收敛类型（2026-08-23 重构类型整理）。 */
export function appendEvent(session: Session, type: string, data: unknown, surface?: unknown): void {
  ;(session.append as (t: string, d: unknown, s?: unknown) => void)(type, data, surface)
}

// ── 1) chat 行写入 ────────────────────────────────────────────────────────

/** Append a chat line to a Fem session as a dsh-femwa/chat event.
 * @param visible - actor names this line is visible to (the action's scope);
 * absent = visible to everyone (used by role/prompt/human_wait lines whose
 * scope is unknown); caller omits it for god-only meta lines (notice/error/
 * thinking), which the frontend hides in role views. */
function appendChat(
  ctx: Context,
  session: Session,
  text: string,
  kind: 'role' | 'notice' | 'human_wait' | 'prompt' | 'error' | 'thinking' | 'sys' = 'notice',
  actor?: string,
  visible?: string[],
): void {
  try {
    session.append('dsh-femwa/chat', {
      ...actor === undefined ? {} : { actor },
      text,
      kind,
      ...visible === undefined ? {} : { visible },
    })
    console.log(`[dsh-femwa] chat: kind=${kind} actor=${actor ?? '-'} len=${text.length}`)
  } catch (error: unknown) {
    console.log(`[dsh-femwa] appendChat failed: ${String(error)}`)
  }
}

/** 引擎 chat 行投影：只进投影窗（上帝窗全量 + 角色窗按 scope 命中）。
 * 主会话表面绝不写入（主窗口=戏外=纯 DSH 原生页面；引擎通知/节点提示/
 * 等待输入都属戏内信息，上帝窗承载）。唯一例外：alsoMainSession=true
 * （llmBridge 直连模式无子代理镜像，role 行是主会话唯一显示面）。
 * windows 为空（投影窗未建）时丢弃并打日志——flow_start 已确保建窗，
 * 正常运行期不可达。 */
export function appendChatProjected(
  ctx: Context,
  session: Session,
  projections: ProjectionRegistry,
  text: string,
  kind: 'role' | 'notice' | 'human_wait' | 'prompt' | 'error' | 'thinking',
  actor?: string,
  visible?: string[],
  alsoMainSession = false,
): void {
  if (alsoMainSession) {
    appendChat(ctx, session, text, kind, actor, visible)
  }
  const windows = projections.get(String(session.id))
  if (windows === undefined) {
    if (!alsoMainSession) {
      console.log(`[dsh-femwa] chat line dropped (no projection window): kind=${kind}`)
    }
    return
  }
  projectionAppend(windows, 'dsh-femwa/chat', {
    ...actor === undefined ? {} : { actor },
    text,
    kind,
    ...visible === undefined ? {} : { visible },
    seq: Date.now(),
  }, undefined, visible)
}

/** 主会话表面系统回执（kind='sys'）：femwa-run 四动作成功后的用户可见状态条。
 * 与戏内信息走向相反——这条只进主会话、不进投影窗（god 窗的运行状态由引擎
 * 事件 notice 承载；MIRROR_MAIN_EVENTS 白名单不含 dsh-femwa/chat，镜像天然
 * 不收）。不进模型上下文：纯 UI 显示；需要唤醒主模型请用 engine-events 的
 * steerMainAgent，两者勿混用。 */
export function appendChatMain(ctx: Context, session: Session, text: string): void {
  appendChat(ctx, session, text, 'sys')
}

/** 运行状态通知全窗广播：主会话表面（sys）+ 上帝窗 + 全部角色窗各一条。
 * femwa-run 动作回执与引擎结局事件（跑完/报错/暂停/停止）统一走这里，
 * 保证用户在任何视角都能看到同一条状态信息。kind 固定 sys（前端全视角
 * 可见、不计入隐藏数、居中灰字渲染）；targetActors 传空数组 = 广播全部
 * 角色窗（运行状态是全局信息，不做 scope 过滤）。投影窗未建时丢弃窗侧
 * 部分并打日志（与 appendChatProjected 同款行为；运行/结局场景窗必然已建，
 * 仅首跑瞬间的 fresh_start 回执可能早于 flow_start 建窗）。 */
export function appendChatBroadcast(
  ctx: Context,
  session: Session,
  projections: ProjectionRegistry,
  text: string,
): void {
  appendChatMain(ctx, session, text)
  const windows = projections.get(String(session.id))
  if (windows === undefined) {
    console.log(`[dsh-femwa] broadcast dropped (no projection window): ${text.slice(0, 30)}`)
    return
  }
  projectionAppend(windows, 'dsh-femwa/chat', { text, kind: 'sys', seq: Date.now() }, undefined, [])
}

// ── 2) 投影窗生命周期 ─────────────────────────────────────────────────────

/** 投影窗 actor 消毒：非 [A-Za-z0-9_-] 字符替换为 _+码点十六进制（如 @ → _40、
 *  中文字符各占一段），保证不同角色名消毒后必不相同——旧算法把所有非 ASCII
 *  都压成 _，"@演员"/"@观众" 同得 "___"，两键共享同一投影窗导致事件双写。 */
function projectionActorKey(actor: string): string {
  return Array.from(actor).map(ch => (/[A-Za-z0-9_-]/.test(ch) ? ch : `_${ch.codePointAt(0)!.toString(16)}`)).join('')
}

/** 投影窗 id：上帝窗 god / 角色窗 <actorKey>。id 规则化 → 重启后可推导。 */
function projectionId(sid: string, actor: string): string {
  return `fem-proj-${sid}-${projectionActorKey(actor)}`
}

/** 投影窗是否已带 subagent/descriptor（幂等：fold 取第一个事件为权威，不得重复）。 */
function projectionHasDescriptor(session: Session): boolean {
  return session.events.some(e => (e.type as string) === 'subagent/descriptor')
}

/** 唤醒的冷投影窗 detach 收集器：apply 的 effect 统一挂清理（插件卸载时
 * 把唤醒的会话移出 store，防 HMR 重载泄漏 store 条目）。index.ts 总装持有清理 effect。 */
export const awakenedDisposers: Array<() => void> = []

/**
 * 从持久化唤醒一个冷投影窗（重启后 sessions store 为空、create 会撞持久化
 * id 抛 "already exists"，导致整次运行的上帝窗写入全部静默丢弃——2026-08-22）。
 * prepare 加载持久化日志为未发布 Session，enter+announce 发布进 store；
 * detach 交给 awakenedDisposers 随插件卸载清理。目标不存在（全新窗）返回
 * undefined，调用方走 create 新建。
 */
async function awakenProjectionWindow(
  ctx: Context,
  sessions: { enter?(session: Session): () => void; announce?(session: Session): void },
  id: string,
): Promise<Session | undefined> {
  const persistence = ctx.get('sessionPersistence') as
    | { prepare?(id: SessionId): Promise<{ session: Session }> }
    | undefined
  if (persistence?.prepare === undefined || sessions.enter === undefined || sessions.announce === undefined) {
    return undefined
  }
  let prep: { session: Session }
  try {
    prep = await persistence.prepare(SessionId(id))
  } catch (error: unknown) {
    // 2026-08-23 卡死调查：此前这里静默吞错导致"god 窗每次都 created 新空窗"
    // 无从定位。真实错误必须落日志。
    console.log(`[dsh-femwa] awaken ${id} PREPARE FAILED: ${String(error instanceof Error ? error.message : error)}`)
    return undefined
  }
  try {
    const detach = sessions.enter(prep.session)
    sessions.announce(prep.session)
    awakenedDisposers.push(detach)
    return prep.session
  } catch (error: unknown) {
    console.log(`[dsh-femwa] awaken ${id} enter failed: ${String(error)}`)
    return undefined
  }
}

/** 创建/复用投影窗会话。幂等：内存命中直接返回；重启后冷投影窗从持久化
 * 唤醒（见 awakenProjectionWindow）；都不存在才新建。 */
async function ensureProjectionWindow(
  ctx: Context,
  sid: string,
  actor: string,
  cwd: string,
): Promise<Session | undefined> {
  const sessions = ctx.get('sessions') as
    | {
      get(id: SessionId): Session | undefined
      create(id: string, options: { seed?: unknown[]; meta: Record<string, unknown> }): Session
      enter?(session: Session): () => void
      announce?(session: Session): void
    }
    | undefined
  if (sessions === undefined) return undefined
  const id = projectionId(sid, actor)
  try {
    const existing = sessions.get(SessionId(id))
    if (existing !== undefined) {
      // 补 descriptor（旧会话/重启恢复的投影窗可能缺身份）
      if (!projectionHasDescriptor(existing)) {
        appendEvent(existing, 'subagent/descriptor', {
          version: 2,
          mode: 'one-shot',
          provider: 'dsh-femwa',
          label: actor === 'god' ? '👁 上帝视角' : `🎭 ${actor}`,
        })
      }
      return existing
    }
    const awakened = await awakenProjectionWindow(ctx, sessions, id)
    if (awakened !== undefined) {
      if (!projectionHasDescriptor(awakened)) {
        appendEvent(awakened, 'subagent/descriptor', {
          version: 2,
          mode: 'one-shot',
          provider: 'dsh-femwa',
          label: actor === 'god' ? '👁 上帝视角' : `🎭 ${actor}`,
        })
      }
      console.log(`[dsh-femwa] projection window awakened: ${id} (${actor})`)
      return awakened
    }
    const created = sessions.create(id, {
      meta: { cwd, parentSession: sid, origin: 'subagent' },
    })
    appendEvent(created, 'subagent/descriptor', {
      version: 2,
      mode: 'one-shot',
      provider: 'dsh-femwa',
      label: actor === 'god' ? '👁 上帝视角' : `🎭 ${actor}`,
    })
    console.log(`[dsh-femwa] projection window created: ${id} (${actor})`)
    return created
  } catch (error: unknown) {
    console.log(`[dsh-femwa] ensureProjectionWindow(${actor}) failed: ${String(error)}`)
    return undefined
  }
}

/** 上帝窗 + 该剧本全部角色窗的集合（创建/复用）。 */
async function ensureProjectionWindows(
  ctx: Context,
  sid: string,
  actors: string[],
  cwd: string,
): Promise<{ god?: Session; actors: Map<string, Session> }> {
  const god = await ensureProjectionWindow(ctx, sid, 'god', cwd)
  const map = new Map<string, Session>()
  for (const actor of actors) {
    const win = await ensureProjectionWindow(ctx, sid, actor, cwd)
    if (win !== undefined) map.set(actor, win)
  }
  return { god, actors: map }
}

// ── 3) 投影写入 ───────────────────────────────────────────────────────────

/** 按 actor 把事件投影进对应窗：上帝窗全量；角色窗按 scope 命中。
 *  targetActors = 空数组 → 广播全部角色窗；undefined → 上帝窗 + 全部角色窗。
 *  空数组与 undefined 同义：引擎在 action 未写 scope: 时发 scope_info=[]，
 *  语义=未限定可见性（与上下文层 no_filter 全可见一致），绝不能解释为
 *  "无人可见"——否则角色窗收不到自己演的戏（2026-08-22 剧中人视角空白 bug）。 */
export function projectionAppend(
  windows: { god?: Session; actors: Map<string, Session> },
  type: string,
  data: Record<string, unknown>,
  surfaceOp?: Record<string, unknown>,
  targetActors?: string[],
): void {
  const targets = targetActors !== undefined && targetActors.length === 0 ? undefined : targetActors
  // 源级幂等（2026-08-23）：子代理镜像事件带 _srcSeq（子代理会话事件 seq），
  // 落窗前对账——同一子代理事件绝不写进同一窗第二遍（重复 block-start/end
  // 会让渲染层卡死，见小猫咪窗 2026-08-23）。chat 行无 _srcSeq 不受影响。
  // 结构事件（turn/step 骨架）不带 _srcSeq（dsh 迁移器对 turn/end 强制两键，
  // 见 mirrorMainEventToGod 同款注释），幂等改由结构等价键兜底：同
  // type+turn(:step) 已存在即跳过。真实源 start 与合成 start 的竞态也靠它拦。
  const srcSeq = (data as { _srcSeq?: number })._srcSeq
  const structKey = (eventType: string, d: Record<string, unknown>): string | undefined => {
    if (typeof d.turn !== 'number') return undefined
    if (eventType === 'turn/start' || eventType === 'turn/end') return `${eventType}:${d.turn}`
    if ((eventType === 'step/start' || eventType === 'step/end') && typeof d.step === 'number') {
      return `${eventType}:${d.turn}:${d.step}`
    }
    return undefined
  }
  const skey = structKey(type, data)
  const appendTo = (win: Session | undefined): void => {
    if (win === undefined) return
    if (srcSeq !== undefined) {
      const dup = win.events.some(e => (e.data as { _srcSeq?: number } | undefined)?._srcSeq === srcSeq)
      if (dup) return
    }
    if (skey !== undefined && win.events.some(e => structKey(e.type, (e.data ?? {}) as Record<string, unknown>) === skey)) return
    try {
      appendEvent(win, type, data, surfaceOp)
    } catch (error: unknown) {
      console.log(`[dsh-femwa] projectionAppend(${type}) failed: ${String(error)}`)
    }
  }
  appendTo(windows.god)
  if (targets === undefined) {
    for (const win of windows.actors.values()) appendTo(win)
  } else {
    for (const actor of targets) appendTo(windows.actors.get(actor))
  }
}
/** 单会话投影窗注册表：sid → 投影窗集合（含角色窗）。ensure 异步（冷投影窗
 * 唤醒要走持久化 I/O），inflight 按 sid 链式串行——flow_start 与 ai_request
 * 并发调用时后者等待前者完成再幂等复用，绝不并发双建同 id 窗。 */
export interface ProjectionRegistry {
  windows: Map<string, { god?: Session; actors: Map<string, Session> }>
  ensure(sid: string, actors: string[], cwd: string): Promise<{ god?: Session; actors: Map<string, Session> }>
  get(sid: string): { god?: Session; actors: Map<string, Session> } | undefined
}

export function createProjectionRegistry(ctx: Context): ProjectionRegistry {
  const windows = new Map<string, { god?: Session; actors: Map<string, Session> }>()
  const inflight = new Map<string, Promise<unknown>>()
  const buildOnce = async (sid: string, actors: string[], cwd: string): Promise<void> => {
    const existing = windows.get(sid)
    if (existing !== undefined) {
      // 补充新角色窗（多剧本/角色追加）
      for (const actor of actors) {
        if (!existing.actors.has(actor)) {
          const win = await ensureProjectionWindow(ctx, sid, actor, cwd)
          if (win !== undefined) existing.actors.set(actor, win)
        }
      }
      if (existing.god === undefined) existing.god = await ensureProjectionWindow(ctx, sid, 'god', cwd)
      return
    }
    const created = await ensureProjectionWindows(ctx, sid, actors, cwd)
    windows.set(sid, created)
  }
  return {
    windows,
    ensure(sid, actors, cwd) {
      const prev = inflight.get(sid) ?? Promise.resolve()
      const task = prev.then(() => buildOnce(sid, actors, cwd))
      inflight.set(sid, task)
      void task.catch(() => undefined) // 调用方持有 task 处理错误；这里只防 unhandledRejection
      const cleanup = (): void => {
        if (inflight.get(sid) === task) inflight.delete(sid)
      }
      task.then(cleanup, cleanup)
      return task.then(() => windows.get(sid)!)
    },
    get(sid) {
      return windows.get(sid)
    },
  }
}

// ── 4) 主会话 → 上帝窗镜像（上帝视角=全视视角：戏外+戏内全部对话）─────────
// 上帝窗此前只收剧本内事件，主模型对话永远缺席（2026-08-22 bug）。两条
// 通路补齐：① 实时镜像监听器——上帝窗存在期间逐事件转发；
// ② 水位补齐 ensureGodMirrorUpToDate——重启后 registry 是内存态，缝隙期
// 的主会话对话在 flow_start / 视角菜单拉取时按水位一次性补写。
// 水位取 max（实时与补齐并发推进，防旧值覆盖新值导致重复 append）。
// （2026-08-23 重构：原 apply() 闭包逻辑工厂化，行为零变化。）

/** 主会话 → 上帝窗镜像白名单：主模型对话（用户输入/思考/工具/回答）进上帝
 * 窗，上帝视角=全视视角（戏外+戏内全部对话）。turn 号保持主会话原号
 * （1,2,3…），子代理镜像 turn 从 100001 起，天然不冲突。
 * 2026-08-23 移除 'assistant/chunk'：大会话（2000+ seq）全量镜像 chunk 后
 * 前端 conversation 折叠渲染把浏览器主线程堵死（复现：进 god 窗纯白→二次
 * 进入冻死 F12 都不出）。assistant/message 已携带完整 content（text/reasoning/
 * tool-call 块）作整块兜底，历史显示不受影响；实时流式走 SSE ai_token 通道
 * （方案丁精神：live 流式 + 整块存历史）。 */
const MIRROR_MAIN_EVENTS = new Set([
  'turn/start', 'step/start', 'step/end', 'turn/end',
  'assistant/message', 'tool/call', 'tool/result',
  'user/message',
])

export interface GodMirror {
  /** 镜像一条主会话事件进上帝窗（chunk 裁剪到块边界 + surfaceOp 重包装透传）。 */
  mirrorMainEventToGod(sid: string, event: SessionEvent): void
  /** 按水位把主会话缺失段补写进上帝窗（幂等：水位以下的跳过；per-sid 串行）。 */
  ensureGodMirrorUpToDate(sid: string): Promise<void>
  /** 注册实时镜像监听器（主会话事件白名单转发进上帝窗）。 */
  registerRealtimeListener(ctx: Context): void
}

export function createGodMirror(deps: {
  femwaRoot: string
  sessionsStore?: { get(id: SessionId): Session | undefined }
  projections: ProjectionRegistry
}): GodMirror {
  const { femwaRoot, sessionsStore, projections } = deps

  /** 上帝窗镜像水位（sid → 已镜像的主会话最大 seq）。内存缓存 + user_data 落盘。 */
  const godMirrorSeqs = new Map<string, number>()

  function godMirrorPath(sid: string): string {
    return join(femwaRoot, 'user_data', 'god_mirror', `${sid}.json`)
  }

  async function loadGodMirrorSeq(sid: string): Promise<number> {
    const cached = godMirrorSeqs.get(sid)
    if (cached !== undefined) return cached
    try {
      const { readFile } = await import('node:fs/promises')
      const parsed = JSON.parse(await readFile(godMirrorPath(sid), 'utf8')) as { seq?: number }
      const seq = typeof parsed.seq === 'number' ? parsed.seq : 0
      godMirrorSeqs.set(sid, seq)
      return seq
    } catch {
      godMirrorSeqs.set(sid, 0)
      return 0
    }
  }

  function markGodMirrorSeq(sid: string, seq: number): void {
    const prev = godMirrorSeqs.get(sid) ?? 0
    if (seq <= prev) return
    // 内存水位同步推进（实时镜像与补齐并发时取 max 防重复）；落盘异步。
    godMirrorSeqs.set(sid, seq)
    void import('node:fs/promises').then(({ mkdir, writeFile }) =>
      mkdir(join(godMirrorPath(sid), '..'), { recursive: true })
        .then(() => writeFile(godMirrorPath(sid), JSON.stringify({ sessionId: sid, seq }, null, 2), 'utf8'))
        .catch((error: unknown) => console.log(`[dsh-femwa] god-mirror watermark write failed: ${String(error)}`)),
    )
  }

  /** 镜像一条主会话事件进上帝窗（chunk 裁剪到块边界 + surfaceOp 重包装透传）。
   * 内存 SessionEvent.surfaceOp 是裸值（如 'append'），session.append 第三参
   * 要 { surfaceOp } 包装——直传裸值会被校验拒绝（user/message、assistant/
   * message 等 surface-eligible 事件全部丢失）。
   *
   * 幂等三层（2026-08-23 两轮 bug 后定稿）：
   * ①源 seq 对账（最强）：写入时 data 注入 _srcSeq=主会话事件 seq；落窗前查
   *   god 窗内是否已有同 _srcSeq 事件——无论水位文件丢失、多客户端并发触发、
   *   冷加载重放，同一主会话事件绝不会被写第二遍（user/message 也是
   *   "一消息一 start"节点，重复同样炸历史加载）；
   * ②结构 start 查重：turn/start、step/start 落窗前查同 turn(:step) 是否已
   *   存在——覆盖 dsh 会话系统对 surface append 的自动 turn 管理（auto 补的
   *   start 不带 _srcSeq，只能按结构识别）；
   * ③per-sid catch-up 串行（见 ensureGodMirrorUpToDate）。 */
  function mirrorMainEventToGod(sid: string, event: SessionEvent): void {
    const windows = projections.get(sid)
    if (windows?.god === undefined) return
    const srcSeq = Number(event.seq)
    const dupBySrc = windows.god.events.some(e => (e.data as { _srcSeq?: number } | undefined)?._srcSeq === srcSeq)
    if (dupBySrc) return
    const mTurn = (event.data as { turn?: number }).turn
    const mStep = (event.data as { step?: number }).step
    if (event.type === 'turn/start' && typeof mTurn === 'number') {
      const dup = windows.god.events.some(e => e.type === 'turn/start'
        && (e.data as { turn?: number }).turn === mTurn)
      if (dup) return
    }
    if (event.type === 'step/start' && typeof mTurn === 'number' && typeof mStep === 'number') {
      const dup = windows.god.events.some(e => e.type === 'step/start'
        && (e.data as { turn?: number }).turn === mTurn
        && (e.data as { step?: number }).step === mStep)
      if (dup) return
    }
    // end 侧结构查重（与 start 侧对称）：结构事件不再注入 _srcSeq（见下）后，
    // 源级对账对它们失效，end 重复全靠这里拦——重复的 turn:end 同样破坏
    // react-loop 结构。turn/step 号单调递增不复用，无误杀场景。
    if (event.type === 'turn/end' && typeof mTurn === 'number') {
      const dup = windows.god.events.some(e => e.type === 'turn/end'
        && (e.data as { turn?: number }).turn === mTurn)
      if (dup) return
    }
    if (event.type === 'step/end' && typeof mTurn === 'number' && typeof mStep === 'number') {
      const dup = windows.god.events.some(e => e.type === 'step/end'
        && (e.data as { turn?: number }).turn === mTurn
        && (e.data as { step?: number }).step === mStep)
      if (dup) return
    }
    const rawSurface = (event as { surfaceOp?: unknown }).surfaceOp
    const surface = rawSurface === undefined ? undefined : { surfaceOp: rawSurface }
    // 结构事件（dsh react-loop 骨架）绝不注入 _srcSeq：session-persistence
    // 迁移器对 turn/end 强制 hasOnlyKeys(['turn','reason'])，第三键即判
    // "malformed pre-react-loop turn/end" 冷加载拒载整窗（2026-08-23 三投影窗
    // 中毒根因）。对账缺口由 end 侧结构查重 + 水位文件补齐。
    const structural = event.type === 'turn/start' || event.type === 'turn/end'
      || event.type === 'step/start' || event.type === 'step/end'
    const data = structural
      ? { ...(event.data as Record<string, unknown>) }
      : { ...(event.data as Record<string, unknown>), _srcSeq: srcSeq }
    try {
      appendEvent(windows.god, event.type, data, surface)
    } catch (error: unknown) {
      console.log(`[dsh-femwa] main->god mirror(${event.type}) failed: ${String(error)}`)
      return
    }
    markGodMirrorSeq(sid, srcSeq)
  }

  /** 按水位把主会话缺失段补写进上帝窗（幂等：水位以下的跳过）。
   * per-sid inflight 串行：flow_start 与 projection-windows API 可能并发触发，
   * 并发实例各自持有独立遍历游标会把同一段历史写两遍（2026-08-23 上帝窗
   * 头部双份的成因之一），此处与 ProjectionRegistry.ensure 同款串行化。 */
  const catchUpInflight = new Map<string, Promise<void>>()
  function ensureGodMirrorUpToDate(sid: string): Promise<void> {
    const prev = catchUpInflight.get(sid) ?? Promise.resolve()
    const task = prev.then(() => catchUpNow(sid)).catch((error: unknown) => {
      console.log(`[dsh-femwa] god-mirror catch-up ${sid} failed: ${String(error)}`)
    })
    catchUpInflight.set(sid, task)
    const cleanup = (): void => {
      if (catchUpInflight.get(sid) === task) catchUpInflight.delete(sid)
    }
    void task.then(cleanup, cleanup)
    return task
  }

  async function catchUpNow(sid: string): Promise<void> {
    const windows = projections.get(sid)
    if (windows?.god === undefined) return
    const main = sessionsStore?.get(SessionId(sid))
    if (main === undefined) return
    let last = await loadGodMirrorSeq(sid)
    let wrote = 0
    for (const event of main.events) {
      const seq = Number(event.seq)
      if (seq <= last) continue
      last = seq
      if (!MIRROR_MAIN_EVENTS.has(event.type)) continue
      mirrorMainEventToGod(sid, event)
      wrote += 1
    }
    if (wrote > 0) {
      console.log(`[dsh-femwa] god-mirror catch-up ${sid}: +${wrote} events (watermark -> ${last})`)
    }
  }

  /** 实时镜像：主会话事件白名单转发进上帝窗。投影窗自身与子代理会话都带
   * parentSession（header），在此天然排除——无递归、无重复（子代理 → 投影窗
   * 由 runAiSubagent 的 onChildEvent 负责，两条监听互不重叠）。 */
  function registerRealtimeListener(ctx: Context): void {
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (session.header.parentSession !== undefined) return
      if (!MIRROR_MAIN_EVENTS.has(event.type)) return
      mirrorMainEventToGod(String(session.id), event)
    })
  }

  return { mirrorMainEventToGod, ensureGodMirrorUpToDate, registerRealtimeListener }
}
