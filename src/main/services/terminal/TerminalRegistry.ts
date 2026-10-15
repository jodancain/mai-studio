/**
 * Pure terminal bookkeeping — one PTY per agent session — behind two injected
 * seams (`PtySpawner`, `TerminalEmitter`) so the contract is testable with a
 * fake pty and no Electron. Output is coalesced (flush window / byte cap) into
 * monotonically numbered `terminal.data` batches; the same batches feed a
 * bounded scrollback buffer replayed by `ensure` so a remounting renderer can
 * drop duplicates via the `lastSeq` watermark.
 */

export interface TerminalPty {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
}

export interface PtySpawnRequest {
  sessionId: string
  cwd?: string
  cols: number
  rows: number
}

export type PtySpawner = (request: PtySpawnRequest) => Promise<TerminalPty>

export interface TerminalEmitter {
  sendData(windowId: string, payload: { sessionId: string; seq: number; data: string }): void
  sendExit(windowId: string, payload: { sessionId: string; exitCode: number }): void
}

export interface TerminalEnsureResult {
  replay: string
  lastSeq: number
  alive: boolean
}

const FLUSH_INTERVAL_MS = 8
const FLUSH_MAX_BYTES = 64 * 1024
const SCROLLBACK_MAX_BYTES = 1024 * 1024

interface TerminalEntry {
  pty: TerminalPty | null
  ownerWindowId: string
  seq: number
  scrollback: string[]
  scrollbackBytes: number
  pending: string
  flushTimer: NodeJS.Timeout | null
  alive: boolean
}

export class TerminalRegistry {
  private readonly entries = new Map<string, TerminalEntry>()

  constructor(
    private readonly spawner: PtySpawner,
    private readonly emitter: TerminalEmitter
  ) {}

  /**
   * Idempotent attach: reuses a live PTY (last caller becomes the event
   * target), respawns a dead one with fresh scrollback, spawns otherwise.
   */
  async ensure(windowId: string, request: PtySpawnRequest): Promise<TerminalEnsureResult> {
    const existing = this.entries.get(request.sessionId)
    if (existing?.alive) {
      existing.ownerWindowId = windowId
      this.flush(request.sessionId, existing)
      existing.pty?.resize(request.cols, request.rows)
      return { replay: existing.scrollback.join(''), lastSeq: existing.seq, alive: true }
    }

    // Dead entries respawn with a clean buffer; seq continues from the old
    // counter so stale in-flight events can never pass a fresh watermark.
    const entry: TerminalEntry = {
      pty: null,
      ownerWindowId: windowId,
      seq: existing?.seq ?? 0,
      scrollback: [],
      scrollbackBytes: 0,
      pending: '',
      flushTimer: null,
      alive: true
    }
    this.entries.set(request.sessionId, entry)

    try {
      const pty = await this.spawner(request)
      // A concurrent dispose/ensure may have replaced the entry while spawning.
      if (this.entries.get(request.sessionId) !== entry) {
        pty.kill()
        return { replay: '', lastSeq: entry.seq, alive: false }
      }
      entry.pty = pty
      pty.onData((data) => this.handleData(request.sessionId, entry, data))
      pty.onExit(({ exitCode }) => this.handleExit(request.sessionId, entry, exitCode))
      return { replay: '', lastSeq: entry.seq, alive: true }
    } catch (error) {
      entry.alive = false
      throw error
    }
  }

  write(sessionId: string, data: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry?.alive) return
    entry.pty?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.entries.get(sessionId)
    if (!entry?.alive) return
    entry.pty?.resize(cols, rows)
  }

  dispose(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    this.entries.delete(sessionId)
    if (entry.flushTimer) clearTimeout(entry.flushTimer)
    if (entry.alive) entry.pty?.kill()
  }

  disposeMany(sessionIds: string[]): void {
    for (const sessionId of sessionIds) this.dispose(sessionId)
  }

  disposeByWindow(windowId: string): void {
    for (const [sessionId, entry] of this.entries) {
      if (entry.ownerWindowId === windowId) this.dispose(sessionId)
    }
  }

  disposeAll(): void {
    this.disposeMany([...this.entries.keys()])
  }

  private handleData(sessionId: string, entry: TerminalEntry, data: string): void {
    if (!entry.alive) return
    entry.pending += data
    if (entry.pending.length >= FLUSH_MAX_BYTES) {
      this.flush(sessionId, entry)
      return
    }
    entry.flushTimer ??= setTimeout(() => this.flush(sessionId, entry), FLUSH_INTERVAL_MS)
  }

  private flush(sessionId: string, entry: TerminalEntry): void {
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    if (!entry.pending) return
    const data = entry.pending
    entry.pending = ''
    entry.seq += 1
    entry.scrollback.push(data)
    entry.scrollbackBytes += data.length
    while (entry.scrollbackBytes > SCROLLBACK_MAX_BYTES && entry.scrollback.length > 1) {
      entry.scrollbackBytes -= entry.scrollback[0].length
      entry.scrollback.shift()
    }
    this.emitter.sendData(entry.ownerWindowId, { sessionId, seq: entry.seq, data })
  }

  private handleExit(sessionId: string, entry: TerminalEntry, exitCode: number): void {
    if (this.entries.get(sessionId) !== entry || !entry.alive) return
    this.flush(sessionId, entry)
    entry.alive = false
    entry.pty = null
    this.emitter.sendExit(entry.ownerWindowId, { sessionId, exitCode })
  }
}
