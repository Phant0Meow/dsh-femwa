/**
 * bridge.ts — FemWA bridge client（与 Python 引擎通话的电话线）。
 *
 * 管理 femwa_bridge.py 子进程：NDJSON over stdio 的请求/响应配对，引擎事件
 * 以 (name='dsh-femwa/event', eventType, data) 形式 re-emit——emit 由 index.ts
 * 总装时注入为 ctx.emit（FemwaBridge 自身不依赖事件总线）。
 * 从 index.ts 原样迁出（2026-08-23 重构）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { join } from 'node:path'

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

export class FemwaBridge {
  private handle: SubprocessHandle | undefined
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private lineBuf = ''

  get alive(): boolean {
    return this.handle !== undefined
  }

  /** Spawn the bridge and wire stdout line parsing. */
  start(ctx: Context, config: { python: string; femwaRoot: string }, attempt = 0): void {
    if (this.handle !== undefined) return
    const subprocess = ctx.get('subprocess') as {
      resolveExecutable(command: string, env?: Record<string, string>, signal?: AbortSignal): Promise<string>
      spawn(spec: unknown): SubprocessHandle
    } | undefined
    if (subprocess === undefined) {
      // 插件树并发装配：本插件 apply 可能先于 base bundle 的 subprocess
      // provider 完成（rc.2 快照插件更多、apply 更慢，固定 1s 延迟不再够）。
      // 轮询等待而不是一次性放弃——最多 30s。
      if (attempt < 30) {
        setTimeout(() => this.start(ctx, config, attempt + 1), 1000)
        return
      }
      console.log('[dsh-femwa] subprocess service unavailable after 30s; bridge not started')
      return
    }
    if (attempt > 0) console.log(`[dsh-femwa] subprocess service ready after ${attempt}s wait; starting bridge`)
    // Bridge lives inside the FemWA project itself (self-contained plugin):
    // <femwaRoot>/python/femwa_bridge.py
    const bridgePath = join(config.femwaRoot, 'python', 'femwa_bridge.py')
    void subprocess.resolveExecutable(config.python).then((pythonPath) => {
      const handle = subprocess.spawn({
        argv: [pythonPath, bridgePath, '--fe4m', config.femwaRoot],
        cwd: config.femwaRoot,
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          // 'pipe' (not collect): the caller owns the stream and forwards
          // tracebacks live; a collect buffer would swallow them silently.
          stderr: 'pipe',
        },
        graceMs: 3000,
        env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      this.handle = handle
      handle.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
      // Bridge stderr (Python tracebacks) must not vanish: forward every line.
      handle.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length === 0) continue
          console.log(`[femwa-engine:stderr] ${line}`)
        }
      })
      handle.done.then((outcome) => {
        console.log(`[dsh-femwa] bridge exited: code=${outcome.exitCode} signal=${outcome.signal}`)
        for (const [, pending] of this.pending) {
          pending.reject(new Error(`bridge exited (code=${outcome.exitCode})`))
        }
        this.pending.clear()
        this.handle = undefined
      }, (error: unknown) => {
        console.log(`[dsh-femwa] bridge spawn failed: ${String(error)}`)
        this.handle = undefined
      })
      console.log(`[dsh-femwa] bridge started (pid=${handle.pid})`)
    }, (error: unknown) => {
      console.log(`[dsh-femwa] python resolve failed: ${String(error)}`)
    })
  }

  /** Send one command; resolves with the bridge's response result. */
  send(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<unknown> {
    const handle = this.handle
    if (handle === undefined) return Promise.reject(new Error('bridge not running'))
    const id = this.nextId++
    const payload = `${JSON.stringify({ id, cmd, args })}\n`
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bridge command "${cmd}" timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      handle.stdin?.write(payload, (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(error)
        }
      })
    })
  }

  /** Terminate the bridge process tree (graceful shutdown command first). */
  async stop(): Promise<void> {
    const handle = this.handle
    if (handle === undefined) return
    try {
      await this.send('shutdown', {}, 2000)
    } catch {
      // fall through to terminate
    }
    handle.terminate()
    await handle.waitForExit()
    this.handle = undefined
  }

  private onData(chunk: Buffer): void {
    this.lineBuf += chunk.toString('utf8')
    let idx: number
    while ((idx = this.lineBuf.indexOf('\n')) !== -1) {
      const line = this.lineBuf.slice(0, idx).trim()
      this.lineBuf = this.lineBuf.slice(idx + 1)
      if (line.length === 0) continue
      // FemWA's own prints share stdout; only JSON protocol lines parse.
      // Engine prints (the engine's debugging voice) are forwarded so the
      // harness log can see what the engine saw — they used to be dropped.
      if (!line.startsWith('{')) {
        console.log(`[femwa-engine] ${line}`)
        continue
      }
      let msg: {
        type?: string; id?: number; ok?: boolean; result?: unknown; error?: unknown
        event?: string; data?: unknown
      }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        continue
      }
      if (msg.type === 'response') {
        const rid = msg.id
        if (rid === undefined) continue
        const pending = this.pending.get(rid)
        if (pending === undefined) continue
        this.pending.delete(rid)
        if (msg.ok === true) pending.resolve(msg.result)
        else pending.reject(new Error(String(msg.error ?? 'bridge error')))
      } else if (msg.type === 'event') {
        ;(this as unknown as { emit(name: string, ...args: unknown[]): void }).emit('dsh-femwa/event', msg.event, msg.data)
      }
    }
  }
}
