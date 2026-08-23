/**
 * state-files.ts — user_data 状态文件读写族（存档管理员）。
 *
 * 三套互不相干的 JSON 小文件，全部落在 <femwaRoot>/user_data/ 下：
 *  - checkpoints/<sid>.json   断点位置（分支 key → 节点 id），续跑用；
 *  - turn_scopes/<sid>.json   镜像 turn → scope 映射，重启后视角过滤重建用；
 *  - sessions/<sid>.json      会话剧本记录（path/text/rev 乐观锁），画布恢复用。
 *
 * 纯磁盘读写，无任何 dsh 服务依赖。从 index.ts 原样迁出（2026-08-23 重构）。
 */

import { join } from 'node:path'

/** Checkpoint file path: one JSON per Fem session, under the project's user data. */
export function checkpointPath(femwaRoot: string, sessionId: string): string {
  return join(femwaRoot, 'user_data', 'checkpoints', `${sessionId}.json`)
}

/** Persist one run's branch positions (branch key → node id). */
export async function writeCheckpoint(femwaRoot: string, sessionId: string, checkpoints: Record<string, string>): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const path = checkpointPath(femwaRoot, sessionId)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ sessionId, updatedAt: Date.now(), checkpoints }, null, 2), 'utf8')
}

/** Read the last recorded branch positions, if any. */
export async function readCheckpoint(femwaRoot: string, sessionId: string): Promise<Record<string, string>> {
  const { readFile } = await import('node:fs/promises')
  try {
    const raw = await readFile(checkpointPath(femwaRoot, sessionId), 'utf8')
    const parsed = JSON.parse(raw) as { checkpoints?: Record<string, string> }
    return parsed.checkpoints ?? {}
  } catch {
    return {}
  }
}

/** Drop the checkpoint after a completed run (从头开始 is the next run's default). */
export async function clearCheckpoint(femwaRoot: string, sessionId: string): Promise<void> {
  const { unlink } = await import('node:fs/promises')
  try {
    await unlink(checkpointPath(femwaRoot, sessionId))
  } catch {
    // absent checkpoint is the common case; nothing to clear
  }
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
  const { mkdir, writeFile } = await import('node:fs/promises')
  const prev = await readSessionScript(femwaRoot, sessionId)
  if (expectRev !== undefined && (prev?.rev ?? 0) !== expectRev) {
    return { ok: false, reason: 'conflict', record: prev ?? {} }
  }
  const rev = (prev?.rev ?? 0) + 1
  const next: SessionScriptRecord = { ...record, rev }
  const path = sessionScriptPath(femwaRoot, sessionId)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(next, null, 2), 'utf8')
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
