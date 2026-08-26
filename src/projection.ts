/**
 * projection.ts — 投影窗管家。
 *
 * 投影窗（子代理视角窗）：角色/上帝视角从「主会话 CSS 过滤」迁移到
 * 「dsh 原生子代理会话窗」。投影窗 = 无 agent 会话 + origin:subagent +
 * parentSession=主会话 + subagent/descriptor（dsh 原生身份，可进子代理目录、
 * 标题=label、持久化自动）。事件按 turn-scope 投影进对应窗，主会话表面
 * 不再接收角色内容（为「主会话=戏外视角」铺路）。
 *
 * 本模块含三块：
 *  1. appendChat / appendChatProjected —— dsh-femwa/chat 行写入（主会话表面
 *     与投影窗投影，唯一例外 alsoMainSession=llmBridge 直连双写）；
 *  2. 投影窗生命周期 —— ensure/awaken/registry（幂等、冷唤醒、inflight 串行）；
 *  3. projectionAppend —— 按 scope 把事件投进对应窗（空数组=广播全部角色窗）。
 *
 * （主会话→上帝窗镜像已于 2026-08-26 结构整理迁至 ./god-mirror——原第 4 块
 * createGodMirror 工厂，行为零变化；本文件的 appendEvent 被其单向引用。）
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'

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
  // 源级幂等（2026-08-23）：子代理镜像事件带 _srcSeq（「子会话id#seq」复合键，
  // 2026-08-24 起命名空间隔离；主会话镜像仍为裸数字 seq）——同一源事件绝不写
  // 进同一窗第二遍（重复 block-start/end 会让渲染层卡死，见小猫咪窗 2026-08-23）。
  // 此前裸 seq 跨源共用一个判重空间：one-shot 子会话的本地 seq 高度重叠，兄弟
  // 子代理互相误杀尾部事件（2026-08-24 故事接龙第5棒 block-end/message 被第2棒
  // 同号占用→悬空 block-start=「有名字没内容」），复合键后各源互不干扰。
  // chat 行无 _srcSeq 不受影响。结构事件（turn/step 骨架）不带 _srcSeq（dsh
  // 迁移器对 turn/end 强制两键，见 mirrorMainEventToGod 同款注释），幂等改由
  // 结构等价键兜底：同 type+turn(:step) 已存在即跳过。真实源 start 与合成
  // start 的竞态也靠它拦。
  const srcSeq = (data as { _srcSeq?: number | string })._srcSeq
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
      const dup = win.events.some(e => (e.data as { _srcSeq?: number | string } | undefined)?._srcSeq === srcSeq)
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

// ── 4) 主会话 → 上帝窗镜像 → 已迁至 god-mirror.ts（2026-08-26 整理）───────
