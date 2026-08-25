/**
 * state-files.ts — user_data 状态文件读写族（存档管理员）。
 *
 * 两套互不相干的 JSON 小文件，全部落在 <femwaRoot>/user_data/ 下：
 *  - sessions/<sid>.json     会话剧本记录：文本域（path/text/rev 乐观锁，画布恢复）
 *                            + 演出域（femSessions 场次账本 / resume 断点块）；
 *  - turn_scopes/<sid>.json  镜像 turn → scope 映射，重启后视角过滤重建用。
 *
 * 纯磁盘读写，无任何 dsh 服务依赖。从 index.ts 原样迁出（2026-08-23 重构）；
 * 2026-08-25 断点改造：checkpoints/ 文件族退役，断点（位置+变量+场次身份+剧本
 * 指纹）并入会话记录的 resume 块——一个 dsh 会话一场戏一份档案。
 */

import { join } from 'node:path'
import { createHash } from 'node:crypto'

// ── 剧本指纹与断点（resume）────────────────────────────────────────────────

/** PlayResume — 一场被打断的戏的完整断点：世界三元组（身份+进度+变量）。
 * fingerprint=开跑时剧本文本指纹；剧本变更后断点即失效——变了就不是断点，
 * 是新戏。femSessionId=引擎台账场次（世界身份，角色记忆按它落库）。 */
export interface PlayResume {
  fingerprint: string
  femSessionId?: number
  checkpoints?: Record<string, string>
  vars?: Record<string, Record<string, unknown>>
}

/** 会话剧本记录文件的完整形态：文本域 + 演出域。 */
interface SessionRecordFile {
  sessionId?: string
  path?: string
  text?: string
  rev?: number
  femSessions?: number[]
  resume?: PlayResume
}

/** 剧本指纹：「判断剧本变没变」的唯一依据。CRLF 归一后 sha256——
 * 断点只属于生成它的那个剧本版本。 */
export function scriptFingerprint(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`
}

/** 读会话记录文件全文（文本域+演出域）。 */
async function readSessionRecord(femwaRoot: string, sessionId: string): Promise<SessionRecordFile | undefined> {
  const { readFile } = await import('node:fs/promises')
  try {
    const raw = await readFile(sessionScriptPath(femwaRoot, sessionId), 'utf8')
    return JSON.parse(raw) as SessionRecordFile
  } catch {
    return undefined
  }
}

/** 写回会话记录文件整对象。不碰 rev——rev 只归文本快照协议管，
 * 运行态（演出域）写入不该惊动前端的乐观锁。 */
async function writeSessionRecord(femwaRoot: string, sessionId: string, record: SessionRecordFile): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const path = sessionScriptPath(femwaRoot, sessionId)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ ...record, sessionId }, null, 2), 'utf8')
}

/** 读断点块；无中断记录返回 undefined。 */
export async function readPlayResume(femwaRoot: string, sessionId: string): Promise<PlayResume | undefined> {
  const record = await readSessionRecord(femwaRoot, sessionId)
  return record?.resume
}

/** 「判断剧本变没变」的独立裁决入口（续跑前唯一要问的函数）：
 * 比对当前剧本文本指纹与断点所属指纹。一致 → 返回可用断点；
 * 有断点但不一致 → 清除失效断点并返回 undefined（变了就必须 fresh_start）。 */
export async function loadValidPlayResume(femwaRoot: string, sessionId: string, scriptText: string): Promise<PlayResume | undefined> {
  const resume = await readPlayResume(femwaRoot, sessionId)
  if (resume === undefined) return undefined
  if (resume.fingerprint !== scriptFingerprint(scriptText)) {
    await writePlayResume(femwaRoot, sessionId, null)
    console.log(`[dsh-femwa] ${sessionId}: resume fingerprint mismatch — breakpoint invalidated (script changed)`)
    return undefined
  }
  return resume
}

/** 整块写/删断点（null=删除）。只动 resume 键，不碰文本域与 femSessions。 */
export async function writePlayResume(femwaRoot: string, sessionId: string, resume: PlayResume | null): Promise<void> {
  const record: SessionRecordFile = { ...(await readSessionRecord(femwaRoot, sessionId) ?? {}) }
  if (resume === null) delete record.resume
  else record.resume = resume
  await writeSessionRecord(femwaRoot, sessionId, record)
}

/** 按键合并更新断点块（checkpoint 事件增量到达、开跑盖指纹均走这里）。 */
export async function updatePlayResume(
  femwaRoot: string,
  sessionId: string,
  patch: Partial<Omit<PlayResume, 'fingerprint'>> & Partial<Pick<PlayResume, 'fingerprint'>>,
): Promise<void> {
  const base: PlayResume = (await readSessionRecord(femwaRoot, sessionId))?.resume ?? { fingerprint: '' }
  const next: PlayResume = {
    ...base,
    ...patch,
  }
  await writePlayResume(femwaRoot, sessionId, next)
}

/** 记一场演出：dsh 会话 ↔ fem 场次的一对多账本（末位=当前场次）。连续去重。 */
export async function appendFemSession(femwaRoot: string, sessionId: string, femSessionId: number): Promise<void> {
  const record: SessionRecordFile = { ...(await readSessionRecord(femwaRoot, sessionId) ?? {}) }
  const list = record.femSessions ?? []
  if (list[list.length - 1] === femSessionId) return
  record.femSessions = [...list, femSessionId]
  await writeSessionRecord(femwaRoot, sessionId, record)
}

/** turn→scope 映射文件路径：一 Fem 会话一个 JSON（重启后 /dsh-femwa/turn-scopes 重建用）。 */
function turnScopePath(femwaRoot: string, sessionId: string): string {
  return join(femwaRoot, 'user_data', 'turn_scopes', `${sessionId}.json`)
}

/** Persist the session's whole turn→scope map（跨 run 累积；turnBase 递增保证键不冲突）。 */
export async function writeTurnScopeFile(femwaRoot: string, sessionId: string, scopes: Map<number, string[]>): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const path = turnScopePath(femwaRoot, sessionId)
  const out: Record<string, string[]> = {}
  for (const [turn, scope] of scopes) out[String(turn)] = scope
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ sessionId, updatedAt: Date.now(), scopes: out }, null, 2), 'utf8')
}

/** Read the persisted turn→scope map as a plain object (absent file → {}). */
export async function readTurnScopeFile(femwaRoot: string, sessionId: string): Promise<Record<string, string[]>> {
  const { readFile } = await import('node:fs/promises')
  try {
    const raw = await readFile(turnScopePath(femwaRoot, sessionId), 'utf8')
    const parsed = JSON.parse(raw) as { scopes?: Record<string, string[]> }
    return parsed.scopes ?? {}
  } catch {
    return {}
  }
}

/** 会话级剧本记录路径（femGen 刷新/重启后恢复画布用；JSON 单文件）。 */
function sessionScriptPath(femwaRoot: string, sessionId: string): string {
  return join(femwaRoot, 'user_data', 'sessions', `${sessionId}.json`)
}

/** 会话剧本记录：path=剧本文件地址（导出/导入产生），text=浏览器端剧本原文
 * （未保存态；或已保存但前端修改过、运行检测不一致时保存的实际运行版本）。
 * rev=乐观锁版本号：每次写入自增；前端快照写带 baseRev 做多端并发裁决。
 * 读取优先级：text（实际运行的版本）→ path 指向文件内容。 */
export interface SessionScriptRecord {
  path?: string
  text?: string
  rev?: number
}

export type WriteSessionScriptResult =
  | { ok: true; rev: number }
  | { ok: false; reason: 'conflict'; record: SessionScriptRecord }

/** 写会话剧本记录（覆盖式，自动 rev+1）。expectRev 非空时做乐观锁校验：
 * 与服务端当前 rev 不符 → 拒绝写入并返回当前记录（多端并发编辑，后写者输）。 */
export async function writeSessionScript(
  femwaRoot: string,
  sessionId: string,
  record: SessionScriptRecord,
  expectRev?: number,
): Promise<WriteSessionScriptResult> {
  const prevFile = await readSessionRecord(femwaRoot, sessionId)
  if (expectRev !== undefined && (prevFile?.rev ?? 0) !== expectRev) {
    const conflictRecord: SessionScriptRecord = {}
    if (prevFile?.path !== undefined) conflictRecord.path = prevFile.path
    if (prevFile?.text !== undefined) conflictRecord.text = prevFile.text
    if (prevFile?.rev !== undefined) conflictRecord.rev = prevFile.rev
    return { ok: false, reason: 'conflict', record: conflictRecord }
  }
  const rev = (prevFile?.rev ?? 0) + 1
  // 文本域（path/text）整体以本次传入为准——「一致→只存地址」依赖字段替换语义；
  // 演出域（femSessions/resume）是 host 独占的运行态，跨文本写入保留。
  const next: SessionRecordFile = {
    ...(prevFile?.femSessions !== undefined ? { femSessions: prevFile.femSessions } : {}),
    ...(prevFile?.resume !== undefined ? { resume: prevFile.resume } : {}),
    ...record,
    rev,
  }
  await writeSessionRecord(femwaRoot, sessionId, next)
  return { ok: true, rev }
}

/** 读会话剧本记录；不存在返回 undefined。 */
export async function readSessionScript(femwaRoot: string, sessionId: string): Promise<SessionScriptRecord | undefined> {
  const { readFile } = await import('node:fs/promises')
  try {
    const raw = await readFile(sessionScriptPath(femwaRoot, sessionId), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SessionScriptRecord>
    return {
      ...parsed.path === undefined ? {} : { path: parsed.path },
      ...parsed.text === undefined ? {} : { text: parsed.text },
      ...parsed.rev === undefined ? {} : { rev: parsed.rev },
    }
  } catch {
    return undefined
  }
}

/** 读会话剧本的最终文本：text 优先（实际运行版本）→ path 指向的文件内容 → undefined。 */
export async function readSessionScriptText(femwaRoot: string, sessionId: string): Promise<string | undefined> {
  const record = await readSessionScript(femwaRoot, sessionId)
  if (record === undefined) return undefined
  if (record.text !== undefined && record.text.trim().length > 0) return record.text
  if (record.path !== undefined) {
    try {
      const { readFile } = await import('node:fs/promises')
      return await readFile(record.path, 'utf8')
    } catch {
      return undefined
    }
  }
  return undefined
}
