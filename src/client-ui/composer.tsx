/**
 * client-ui/composer.tsx — 投影窗 composer（角色/上帝视角的可输入输入框）。
 *
 * dsh 对 origin=subagent 会话默认挂 SubagentReadOnlyComposer（只读）；
 * 投影窗（fem-proj-*）需要可输入。输入 → POST /dsh-femwa/projection-input，
 * 由 host 按运行状态路由（2026-08-24 定稿）：剧本未跑→steer 直达主模型；
 * 人类节点等待→喂引擎 wait_key；跑本中其他时候→本窗留痕（插话待实现）。
 *
 * 2026-08-26 视觉重做：官方 InputBar 同款胶囊卡片（styles.ts FEM_COMPOSER_CSS
 * 逐属性转写，全 --dsw/--dsh token → 深浅色与第三方主题自动跟随主窗口）。
 * 不能直接复用官方 InputBar 组件的原因（调研结论）：①跨包 import 被客户端
 * 导出纪律禁止；②投影窗 descriptor 是 mode:'one-shot'，client-runtime 对
 * one-shot 会话的 prompt 在浏览器本地直接拒绝（subagent-not-resumable），
 * 官方提交链路到不了 host；③官方语义=给本会话 agent 发消息，与三路路由冲突。
 *
 * 2026-08-26 二期：左下权限菜单 + 卡片下统计行——都是**主会话**的真数据：
 *  - 权限菜单：读主会话 permissions projection（ISession.projections.faceOf，
 *    官方公开面），切换=对主会话发 `/permission <id>` 斜杠命令（与主窗口
 *    PermissionSelect 同一语义；Full access 保留风险二次确认）。菜单体与
 *    风险弹窗直接用 ui-primitives 的 Menu / RiskConfirmation 官方组件。
 *  - 统计行：主会话 sessionStats / tokenUsage projection，格式化与拼装逻辑
 *    照抄 rc.2 StatsLine.tsx / message-chrome.ts 纯函数；projection 缺失时整行
 *    不渲染（不做 nodes fold 回退，待议）。文案沿用官方中文词典原文。
 *  - 主会话 id 解析与 host projection-input.ts 同语义：fem-proj- 前缀剥除后
 *    去掉最后一个 '-' 右侧的 actorKey（actorKey 只含 [A-Za-z0-9_]）。
 *
 * 官方行为对齐清单：mirror 双层自增高（14 行封顶滚动）、IME composition
 * guard、Enter 发送/Shift+Enter 原生换行、e.repeat 防连发、按钮 mousedown
 * 保焦点、autofocus(preventScroll)、失败 toast 条（4s 自愈）、busy 只读态、
 * primaryStops——主会话 running 时发送钮变方块 Stop，点击中断主模型当前
 * 回合（mainFace.cancel()，官方 ISession 公开动词；剧本运行控制不在本框）。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { IconChevronDownOutline14, Menu, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

/** 提交失败的提示条状态：seq 保证连续同文错误也会重开计时。 */
interface ComposerError {
  seq: number
  text: string
}

// ── 主会话 face（鸭子类型：官方 ISession 公开面中我们用到的成员）──────────

/** ProjectionValueStore 的单 key observable face（identity-stable，见 contract/session.ts ProjectionsFace）。 */
interface ProjectionValueFace {
  getSnapshot(): unknown
  subscribe(fn: () => void): () => void
}

/** 我们消费的主会话 outward face 子集（SessionFace = ISession & ObservableSnapshot）。 */
interface MainSessionFace {
  readonly projections?: { faceOf(key: string): ProjectionValueFace }
  command?(line: string): Promise<{ ok?: boolean; value?: { matched?: boolean } }>
  /** 中断主会话当前回合（官方 primaryStops 的 Stop 语义；one-shot 才会被拒，
   * 主会话是普通会话不受影响）。 */
  cancel?(): Promise<unknown>
  /** ObservableSnapshot 半边：对话快照订阅（running 等会话级事实的来源）。 */
  subscribe?(fn: () => void): () => void
  getSnapshot?(): unknown
}

/** client.tsx 注入 face：按会话 id 解析主会话 outward face（sessions.binding）。 */
export interface ProjectionComposerInjected {
  getSessionFace?: (sid: string) => MainSessionFace | undefined
}

interface PermissionOption {
  name: string
  value: string
  description?: string
}

/** ui-permission-presets 推送的 permissions projection 值形状（消费子集）。 */
interface PermissionValue {
  currentValue: string
  options: PermissionOption[]
}

/** dsh-token-meter 的 tokenUsage projection 消费子集。 */
interface TokenUsageProjection {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** dsh-session-stats 的 sessionStats projection 形状（rc.2 StatsLine WindowStats）。 */
interface SessionStatsProjection {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

// ── 工具 ──────────────────────────────────────────────────────────────────

/**
 * 投影窗 id → 主会话 id。与 host projection-input.ts 兜底剥法同语义：
 * fem-proj-<sid>-<actorKey>，actorKey 只含 [A-Za-z0-9_] 不含 '-'。
 * @param sid - 当前投影窗会话 id。
 * @returns 主会话 id；非投影窗 id 返回 undefined。
 */
function resolveMainSid(sid: string | undefined): string | undefined {
  if (sid === undefined || !sid.startsWith('fem-proj-')) return undefined
  const main = sid.slice('fem-proj-'.length).replace(/-[^-]*$/, '')
  return main.length > 0 ? main : undefined
}

/**
 * 订阅任意会话 face 的一个 projection key（useSyncExternalStore 适配）。
 * faceOf 是 identity-stable bare observable（官方契约），subscribe/getSnapshot
 * 引用稳定；face 缺失时恒定 undefined 快照。
 * @param face - 主会话 face（undefined = 主会话不在前端 store）。
 * @param key - projection key。
 * @returns 当前快照值（无数据为 undefined）。
 */
function useProjectionValue(face: MainSessionFace | undefined, key: string): unknown {
  const subscribe = useCallback((onChanged: () => void): (() => void) => {
    return face?.projections?.faceOf(key).subscribe(onChanged) ?? (() => { /* 无 face：空订阅 */ })
  }, [face, key])
  const getSnapshot = useCallback((): unknown => {
    return face?.projections?.faceOf(key).getSnapshot() ?? undefined
  }, [face, key])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * 订阅主会话 conversation 快照（ObservableSnapshot<ConversationSnapshot> 半边，
 * useSession 绑定的同一数据源），读 running 等会话级事实。face 引用按会话
 * identity-stable，deps 稳定不重订阅。
 * @param face - 主会话 face。
 * @returns 快照对象（无 face 为 undefined）。
 */
function useMainSnapshot(face: MainSessionFace | undefined): { running?: boolean } | undefined {
  const subscribe = useCallback((onChanged: () => void): (() => void) => {
    return face?.subscribe?.(onChanged) ?? (() => { /* 无 face：空订阅 */ })
  }, [face])
  const getSnapshot = useCallback((): { running?: boolean } | undefined => {
    return face?.getSnapshot?.() as { running?: boolean } | undefined
  }, [face])
  return useSyncExternalStore(subscribe, getSnapshot)
}

// ── 统计格式化（照抄 rc.2 StatsLine.tsx / message-chrome.ts 纯函数）────────

/** Compact token count: 517 / 12.2K / 517K / 1.2M（rc.2 StatsLine formatTokens）。 */
function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** 45.2s under a minute, 2m42s from there on（rc.2 StatsLine formatDuration）。 */
function formatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** Whole tokens from ten up, one decimal below（rc.2 message-chrome formatTokensPerSecond）。 */
function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** Sum the three disjoint prompt-side billing buckets（rc.2 StatsLine billedInputTokens）。 */
function billedInputTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Round a cache-read ratio to an integer percentage, positive ties up（rc.2 StatsLine）。 */
function roundedIntegerPercent(cacheReadTokens: number, denominator: number): number {
  const denominatorQuotient = Math.floor(denominator / 200)
  const denominatorRemainder = denominator % 200
  let lower = 0
  let upper = 100
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * denominatorQuotient
      + Math.ceil(factor * denominatorRemainder / 200)
    if (cacheReadTokens >= threshold) {
      lower = candidate
      continue
    }
    upper = candidate - 1
  }
  return lower
}

/** Display-ready cache-hit share（rc.2 StatsLine cacheHitPercent）。 */
function cacheHitPercent(usage: TokenUsageProjection): string | null {
  const denominator = billedInputTokens(usage)
  if (denominator === 0) return null
  const missedInputTokens = usage.uncachedInputTokens + usage.cacheWriteTokens
  if (missedInputTokens === 0) return '100'

  const integerPercent = roundedIntegerPercent(usage.cacheReadTokens, denominator)
  if (integerPercent < 100) return String(integerPercent)

  let decimalPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(denominator / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    decimalPlaces += 1
  }
  const denominatorOnes = denominator % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss++) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(decimalPlaces - 1)}${10 - roundedLoss}`
}

// ── 统计行（主会话 sessionStats + tokenUsage）──────────────────────────────

// 官方 conversation 词典中文原文（locales.ts L58-64），不走 locale seat 直接常量。
const STATS_COUNTS = '{turns} 轮 · {steps} 步'
const STATS_LLM = 'LLM {duration}'
const STATS_TOOL = '工具调用 {duration}'
const STATS_TTFT = '首 token 平均 {duration}'
const STATS_TPS = '{throughput} tok/s'
const STATS_CACHE_HIT = '缓存命中 {percent}%'
const STATS_TOKENS = '输入 {input} tok · 输出 {output} tok'

function fill(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (_, name: string) => params[name] ?? '')
}

/**
 * 卡片下方统计行：显示主会话的轮次/步数/耗时/吞吐与计费数据。
 * 数据全缺（两组都拼不出来）时返回 null——与官方 groups.length===0 行为一致。
 */
function StatsRow({ face }: { face: MainSessionFace | undefined }) {
  const stats = useProjectionValue(face, 'sessionStats') as SessionStatsProjection | undefined
  const usage = useProjectionValue(face, 'tokenUsage') as TokenUsageProjection | undefined

  const groups: string[] = []
  if (stats !== undefined && typeof stats === 'object' && stats.steps > 0) {
    groups.push(fill(STATS_COUNTS, { turns: String(stats.turns), steps: String(stats.steps) }))
    const durations: string[] = []
    if (stats.llmMs > 0) durations.push(fill(STATS_LLM, { duration: formatDuration(stats.llmMs) }))
    if (stats.toolMs > 0) durations.push(fill(STATS_TOOL, { duration: formatDuration(stats.toolMs) }))
    if (durations.length > 0) groups.push(durations.join(' · '))
    const speeds: string[] = []
    if (stats.ttftSteps > 0) speeds.push(fill(STATS_TTFT, { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }))
    if (stats.decodeMs > 0) {
      speeds.push(fill(STATS_TPS, { throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)) }))
    }
    if (speeds.length > 0) groups.push(speeds.join(' · '))
  }
  if (usage !== undefined && typeof usage === 'object'
    && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
    const cacheHit = cacheHitPercent(usage)
    if (cacheHit !== null) groups.push(fill(STATS_CACHE_HIT, { percent: cacheHit }))
    groups.push(fill(STATS_TOKENS, {
      input: formatTokens(billedInputTokens(usage)),
      output: formatTokens(usage.outputTokens),
    }))
  }

  if (groups.length === 0) return null
  return (
    <div className="fem-comp-stats">
      {groups.map((group, i) => (
        <span key={group}>
          {i > 0 && <><span className="fem-comp-stats-sep" aria-hidden>|</span>{' '}</>}
          {group}
        </span>
      ))}
    </div>
  )
}

// ── 权限菜单（主会话 access mode；视觉与交互照抄官方 PermissionSelect）──────

const FULL_ACCESS = 'danger-full-access'

/* Shield glyphs（照抄 rc.2 PermissionSelect.tsx design set 1556）。 */
const SHIELD_OUTLINE = 'M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z'

const permissionGlyphs: Record<string, JSX.Element> = {
  'read-only': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE} stroke="currentColor" strokeWidth="1.31831" strokeLinejoin="round" />
      <path d="M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z" fill="currentColor" />
    </svg>
  ),
  'workspace-write': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8.08887 0.251709C8.20479 0.23085 8.32486 0.241168 8.43652 0.282959L15.0215 2.75171C15.2787 2.84819 15.4492 3.09414 15.4492 3.3689V7.0105C15.4492 7.10986 15.4441 7.2081 15.4414 7.30542C15.0285 7.07175 14.5905 6.87695 14.1309 6.73022V3.82495L8.20508 1.60327L2.2793 3.82495V7.0105C2.27936 9.7171 3.4745 11.5379 5.02734 12.7947C5.01025 12.9942 5 13.1962 5 13.4001C5.00001 13.7617 5.02722 14.1169 5.08008 14.4636C2.91555 13.0393 0.961014 10.752 0.960938 7.0105V3.3689C0.960938 3.09417 1.13146 2.84821 1.38867 2.75171L7.97461 0.282959L8.08887 0.251709Z" fill="currentColor" />
      <path d="M11.3525 5.64688V6.85688H5V5.64688H11.3525Z" fill="currentColor" />
      <path d="M9.5824 8.29376V9.50376H5V8.29376H9.5824Z" fill="currentColor" />
      <path d="M14.6647 15.6852H10.0338C10.3878 15.3751 10.7567 15.0517 11.0772 14.7706C11.2531 14.6164 11.4144 14.4746 11.5511 14.3547H14.6647V15.6852Z" fill="currentColor" />
      <path d="M8.14852 14.1308L7.33925 15.4976C7.22458 15.6912 7.42245 15.9194 7.63037 15.8333L9.09785 15.2254L15.0399 10.0719L14.0905 8.97733L8.14852 14.1308Z" fill="currentColor" />
    </svg>
  ),
  [FULL_ACCESS]: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE} stroke="currentColor" strokeWidth="1.31831" strokeLinejoin="round" />
      <path d="M9.10094 4.5V8.75939H7.59888V4.5H9.10094Z" fill="currentColor" />
      <path d="M9.10094 9.8114V11.5H7.59888V9.8114H9.10094Z" fill="currentColor" />
    </svg>
  ),
}

/** kebab-case 机器名转标题式显示名；非 kebab 的宿主配置名原样透传（照抄官方 displayName）。 */
function displayName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

function optionLabel(option: PermissionOption): string {
  return option.value === FULL_ACCESS ? 'Full access' : displayName(option.name)
}

// 官方 conversation 词典中文原文（locales.ts L27/L69-73）。
const ACCESS_CONFIRM_TITLE = '确认启用 Full access？'
const ACCESS_CONFIRM_DESCRIPTION = '启用 Full access 后，agent 将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。'
const ACCESS_CONFIRM_ACKNOWLEDGE = '我已了解风险，并愿意继续'
const ACCESS_CONFIRM_CANCEL = '取消'
const ACCESS_CONFIRM_ENABLE = '启用 Full access'

/**
 * 左下角访问模式菜单：显示并切换**主会话**的权限模式。
 * permissions projection 缺失（宿主无该能力）时渲染 null——与官方一致。
 */
function PermissionMenu({ face, disabled }: { face: MainSessionFace | undefined; disabled: boolean }) {
  const value = useProjectionValue(face, 'permissions') as PermissionValue | undefined
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    if (!disabled && value !== undefined) return
    setOpen(false)
    setAcknowledged(false)
    setConfirmation(null)
  }, [disabled, value])

  // hooks 全部在条件返回之前（React 规则）；value 缺失=官方同款渲染 null。
  if (value === undefined || typeof value !== 'object' || face?.command === undefined) return null

  const currentValue = pick ?? value.currentValue
  const current = value.options.find(option => option.value === currentValue)
  const busy = pick !== null || confirmation !== null

  const items: MenuEntry[] = value.options
    .filter(option => option.value !== 'custom')
    .map(option => {
      const icon = permissionGlyphs[option.value]
      return { id: option.value, label: optionLabel(option), ...(icon === undefined ? {} : { icon }) }
    })

  const submit = (id: string): void => {
    setPick(id)
    void face.command?.(`/permission ${id}`)
      .catch(() => false)
      .then(() => { setPick(null) })
  }

  const choose = (id: string): void => {
    setOpen(false)
    if (id === value.currentValue) return
    if (id === FULL_ACCESS) {
      setAcknowledged(false)
      setConfirmation(id)
      return
    }
    submit(id)
  }

  const closeConfirmation = (): void => {
    setAcknowledged(false)
    setConfirmation(null)
  }

  const confirmFullAccess = (): void => {
    if (disabled || !acknowledged || confirmation === null) return
    const id = confirmation
    closeConfirmation()
    submit(id)
  }

  return (
    <>
      <Menu
        open={open}
        items={items}
        selectedId={currentValue}
        onSelect={choose}
        onClose={() => { setOpen(false) }}
        side="top"
        anchor={
          <button
            type="button"
            className="fem-comp-perm-trigger"
            aria-label={fill('访问模式，当前：{name}', { name: current === undefined ? displayName(currentValue) : optionLabel(current) })}
            title={current?.description}
            disabled={disabled || busy}
            onClick={() => { setOpen(!open) }}
          >
            {permissionGlyphs[currentValue] !== undefined && (
              <span className="fem-comp-perm-icon" aria-hidden>{permissionGlyphs[currentValue]}</span>
            )}
            <span className="fem-comp-perm-label">{current === undefined ? displayName(currentValue) : optionLabel(current)}</span>
            <span className="fem-comp-perm-chevron" data-open={open} aria-hidden>
              <IconChevronDownOutline14 />
            </span>
          </button>
        }
      />
      <RiskConfirmation
        open={confirmation !== null}
        title={ACCESS_CONFIRM_TITLE}
        description={ACCESS_CONFIRM_DESCRIPTION}
        acknowledgeLabel={ACCESS_CONFIRM_ACKNOWLEDGE}
        cancelLabel={ACCESS_CONFIRM_CANCEL}
        confirmLabel={ACCESS_CONFIRM_ENABLE}
        acknowledged={acknowledged}
        disabled={disabled}
        onAcknowledgedChange={setAcknowledged}
        onCancel={closeConfirmation}
        onConfirm={confirmFullAccess}
      />
    </>
  )
}

// ── 主组件 ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ProjectionComposer({ useSession, useSessions, getSessionFace }: any) {
  const sessionId = useSession((s: { sessionId?: string }) => s.sessionId) as string | undefined
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ComposerError | null>(null)
  // IME guard（官方同款）：composition 关闭事件在 Safari 晚于 keydown 一拍到达，
  // 延迟一 tick 复位，中文输入法回车选词不会误触发送。
  const composingRef = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const errorSeqRef = useRef(0)

  // 主会话 id：优先 sessions 列表 summary.parentId（host 建窗元数据，与
  // view-button 同款权威来源）；列表尚未载入（手机冷启动直达投影窗）时回退
  // 字符串剥法。selector 返回原始字符串（引用稳定），列表变化自动重算。
  const mainSid = useSessions((state: { byId?: Record<string, { parentId?: string } | undefined> } | undefined): string | undefined => {
    if (typeof sessionId !== 'string') return undefined
    const pid = state?.byId?.[sessionId]?.parentId
    if (typeof pid === 'string' && pid.length > 0) return pid
    return resolveMainSid(sessionId)
  })
  // 主会话 face（投影窗是主会话的遥控器：权限菜单/统计行/停止钮都读它）。
  // binding() 官方注释明示 render-safe 纯解析且 per-session identity-stable；
  // useMemo 按 mainSid 缓存即引用稳定（mainSid 有值 = 会话已在列表 = 必解析
  // 成功），uSES 订阅不会每渲染重挂。
  const mainFace = useMemo(
    () => mainSid === undefined ? undefined : getSessionFace?.(mainSid),
    [mainSid, getSessionFace],
  )
  const mainSnapshot = useMainSnapshot(mainFace)
  // 官方 primaryStops 同语义：主模型回合进行中 → 主按钮变 Stop。
  // （剧本运行中主会话 agent 通常空闲——引擎主导，此时保持发送态属正确行为：
  // 剧本的停止入口在 femGen 运行控制，不在本输入框。）
  const mainRunning = mainSnapshot?.running === true

  const submit = (): void => {
    const value = text.trim()
    if (value.length === 0 || busy || sessionId === undefined) return
    setBusy(true)
    void fetch('/dsh-femwa/projection-input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, text: value }),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}) as { ok?: boolean; error?: string }) as { ok?: boolean; error?: string }
        if (data.ok === true) {
          setText('')
          return
        }
        errorSeqRef.current += 1
        setError({ seq: errorSeqRef.current, text: data.error ?? `发送失败（HTTP ${response.status}），草稿已保留` })
      })
      .catch(() => {
        errorSeqRef.current += 1
        setError({ seq: errorSeqRef.current, text: '发送失败，草稿已保留' })
      })
      .finally(() => setBusy(false))
  }

  // 错误条自动消失（官方 Toast 的 hold-then-fade 语义的轻量版）。
  useEffect(() => {
    if (error === null) return
    const timer = setTimeout(() => { setError(null) }, 4000)
    return () => { clearTimeout(timer) }
  }, [error])

  // 切换投影窗回焦输入框（官方 unlock effect 同款 preventScroll）。busy 只读态不抢。
  useEffect(() => {
    if (busy) return
    inputRef.current?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // Shift+Enter 无条件原生换行（官方顺序：先于 IME 判定）。
    if (e.key === 'Enter' && e.shiftKey) return
    if (e.key !== 'Enter') return
    // keyCode 229 是引擎无 isComposing 时的 legacy IME 信号（官方注释）。
    const composing = composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229
    if (composing) return
    e.preventDefault()
    if (e.repeat) return // 按住 Enter 不许连发
    submit()
  }

  // 按钮按下不夺走 textarea 焦点（官方 keepFocus：preventDefault 即可）。
  const keepFocus = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.preventDefault()
    inputRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className="fem-comp-root">
      {error !== null && (
        <div className="fem-comp-notice" role="status">{error.text}</div>
      )}
      {/* data 钩子对齐官方 InputBar 的 DOM 契约：meow-smooth 的失焦折叠/
          手机触摸豁免/软键盘避让全部委托 [data-composer-card] 与
          [data-input-scroll] 识别——不挂钩子这些适配层对我们失效。 */}
      <div className="fem-comp-card" data-composer-card="">
        <div className="fem-comp-scroll" data-input-scroll="">
          <div className="fem-comp-grow">
            <div aria-hidden className="fem-comp-mirror" data-input-mirror="">{`${text}\n`}</div>
            <textarea
              ref={inputRef}
              className="fem-comp-input"
              value={text}
              readOnly={busy}
              placeholder="输入消息…"
              rows={2}
              spellCheck={false}
              data-phase={busy ? 'submitting' : 'idle'}
              onChange={(e) => { setText(e.currentTarget.value) }}
              onKeyDown={onKeyDown}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => {
                setTimeout(() => { composingRef.current = false }, 10)
              }}
            />
          </div>
        </div>
        <div className="fem-comp-row">
          {/* 左组：官方此处是 [+命令菜单] 与 [权限/Plan chips]；命令补全面板
              深绑官方草稿机无法正道复用（v1 不放死按钮），权限菜单位置与官方
              tools 区一致。 */}
          <PermissionMenu face={mainFace} disabled={busy} />
          <div className="fem-comp-trailing">
            <button
              type="button"
              className="fem-comp-primary"
              aria-label={mainRunning ? '停止' : busy ? '发送中' : '发送'}
              disabled={mainRunning ? mainFace?.cancel === undefined : busy || text.trim().length === 0}
              onMouseDown={keepFocus}
              onClick={mainRunning
                ? () => { void mainFace?.cancel?.()?.catch(() => { /* 失败经主会话快照 promptError 呈现（官方 stop 同语义） */ }) }
                : submit}
            >
              {/* 官方 InputBar 同款 glyph：running=方块 Stop（primaryStops），
                  空闲=箭头 Send（figma IconButton 34:10465）。 */}
              {mainRunning ? (
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                  <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                  <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      {/* 卡片下方统计行（官方 StatsLine 挂 composer.dock 的同位语义）。 */}
      <StatsRow face={mainFace} />
    </div>
  )
}
