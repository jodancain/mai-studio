import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PtySpawnRequest, TerminalPty } from '../TerminalRegistry'
import { TerminalRegistry } from '../TerminalRegistry'

/**
 * Contract tests for the per-session PTY bookkeeping: spawn/reattach idempotence,
 * output coalescing + seq watermarking, bounded scrollback replay, exit and
 * dispose semantics. Uses a fake pty seam — no node-pty, no Electron.
 */

class FakePty implements TerminalPty {
  writes: string[] = []
  size: { cols: number; rows: number } | null = null
  killed = false
  private dataListener: ((data: string) => void) | null = null
  private exitListener: ((event: { exitCode: number }) => void) | null = null

  write(data: string) {
    this.writes.push(data)
  }
  resize(cols: number, rows: number) {
    this.size = { cols, rows }
  }
  kill() {
    this.killed = true
  }
  onData(listener: (data: string) => void) {
    this.dataListener = listener
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exitListener = listener
  }

  emitData(data: string) {
    this.dataListener?.(data)
  }
  emitExit(exitCode: number) {
    this.exitListener?.({ exitCode })
  }
}

interface SentData {
  windowId: string
  sessionId: string
  seq: number
  data: string
}

interface SentExit {
  windowId: string
  sessionId: string
  exitCode: number
}

function createHarness() {
  const spawned: FakePty[] = []
  const dataEvents: SentData[] = []
  const exitEvents: SentExit[] = []
  const registry = new TerminalRegistry(
    async () => {
      const pty = new FakePty()
      spawned.push(pty)
      return pty
    },
    {
      sendData: (windowId, payload) => dataEvents.push({ windowId, ...payload }),
      sendExit: (windowId, payload) => exitEvents.push({ windowId, ...payload })
    }
  )
  return { registry, spawned, dataEvents, exitEvents }
}

const REQUEST: PtySpawnRequest = { sessionId: 's1', cwd: '/tmp', cols: 80, rows: 24 }

describe('TerminalRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns once and reattaches with a replay + watermark instead of respawning', async () => {
    const { registry, spawned, dataEvents } = createHarness()

    const first = await registry.ensure('w1', REQUEST)
    expect(first).toEqual({ replay: '', lastSeq: 0, alive: true })
    expect(spawned).toHaveLength(1)

    spawned[0].emitData('hello ')
    spawned[0].emitData('world')
    vi.runAllTimers()

    const second = await registry.ensure('w1', REQUEST)
    expect(spawned).toHaveLength(1)
    expect(second.alive).toBe(true)
    expect(second.replay).toBe('hello world')
    expect(second.lastSeq).toBe(dataEvents.at(-1)!.seq)
  })

  it('coalesces output emitted within the flush window into one monotonically numbered event', async () => {
    const { registry, spawned, dataEvents } = createHarness()
    await registry.ensure('w1', REQUEST)

    spawned[0].emitData('a')
    spawned[0].emitData('b')
    vi.runAllTimers()
    spawned[0].emitData('c')
    vi.runAllTimers()

    expect(dataEvents).toEqual([
      { windowId: 'w1', sessionId: 's1', seq: 1, data: 'ab' },
      { windowId: 'w1', sessionId: 's1', seq: 2, data: 'c' }
    ])
  })

  it('flushes immediately once pending output reaches the byte cap', async () => {
    const { registry, spawned, dataEvents } = createHarness()
    await registry.ensure('w1', REQUEST)

    spawned[0].emitData('x'.repeat(64 * 1024))
    expect(dataEvents).toHaveLength(1)
  })

  it('ensure flushes pending output so the replay and watermark stay consistent', async () => {
    const { registry, spawned, dataEvents } = createHarness()
    await registry.ensure('w1', REQUEST)

    spawned[0].emitData('pending')
    const result = await registry.ensure('w1', REQUEST)

    expect(result.replay).toBe('pending')
    expect(result.lastSeq).toBe(1)
    expect(dataEvents).toHaveLength(1)
  })

  it('reattach retargets events at the latest caller window', async () => {
    const { registry, spawned, dataEvents } = createHarness()
    await registry.ensure('w1', REQUEST)
    await registry.ensure('w2', REQUEST)

    spawned[0].emitData('out')
    vi.runAllTimers()

    expect(dataEvents).toEqual([{ windowId: 'w2', sessionId: 's1', seq: 1, data: 'out' }])
  })

  it('trims scrollback from the oldest end once it exceeds the cap', async () => {
    const { registry, spawned } = createHarness()
    await registry.ensure('w1', REQUEST)

    spawned[0].emitData('OLD')
    vi.runAllTimers()
    for (let i = 0; i < 20; i++) {
      spawned[0].emitData('n'.repeat(64 * 1024))
    }

    const { replay } = await registry.ensure('w1', REQUEST)
    expect(replay).not.toContain('OLD')
    expect(replay.length).toBeLessThanOrEqual(1024 * 1024)
    expect(replay.endsWith('n')).toBe(true)
  })

  it('forwards writes and resizes to a live pty and drops them after exit', async () => {
    const { registry, spawned } = createHarness()
    await registry.ensure('w1', REQUEST)

    registry.write('s1', 'ls\r')
    registry.resize('s1', 100, 30)
    expect(spawned[0].writes).toEqual(['ls\r'])
    expect(spawned[0].size).toEqual({ cols: 100, rows: 30 })

    spawned[0].emitExit(0)
    registry.write('s1', 'ignored')
    registry.resize('s1', 50, 10)
    expect(spawned[0].writes).toEqual(['ls\r'])
    expect(spawned[0].size).toEqual({ cols: 100, rows: 30 })
  })

  it('exit flushes remaining output, emits terminal.exit, keeps the replay readable, and respawns on next ensure', async () => {
    const { registry, spawned, dataEvents, exitEvents } = createHarness()
    await registry.ensure('w1', REQUEST)

    spawned[0].emitData('tail')
    spawned[0].emitExit(3)

    expect(dataEvents).toEqual([{ windowId: 'w1', sessionId: 's1', seq: 1, data: 'tail' }])
    expect(exitEvents).toEqual([{ windowId: 'w1', sessionId: 's1', exitCode: 3 }])

    const respawned = await registry.ensure('w1', REQUEST)
    expect(spawned).toHaveLength(2)
    expect(respawned.alive).toBe(true)
    expect(respawned.replay).toBe('')
    // seq continues past the dead terminal's counter so stale events never beat the watermark
    expect(respawned.lastSeq).toBe(1)
  })

  it('dispose kills the pty; disposeByWindow only kills that window’s sessions; disposeAll kills everything', async () => {
    const { registry, spawned } = createHarness()
    await registry.ensure('w1', { ...REQUEST, sessionId: 's1' })
    await registry.ensure('w1', { ...REQUEST, sessionId: 's2' })
    await registry.ensure('w2', { ...REQUEST, sessionId: 's3' })

    registry.dispose('s1')
    expect(spawned[0].killed).toBe(true)
    expect(spawned[1].killed).toBe(false)

    registry.disposeByWindow('w2')
    expect(spawned[2].killed).toBe(true)
    expect(spawned[1].killed).toBe(false)

    registry.disposeAll()
    expect(spawned[1].killed).toBe(true)
  })

  it('a disposed session spawns fresh on the next ensure', async () => {
    const { registry, spawned } = createHarness()
    await registry.ensure('w1', REQUEST)
    spawned[0].emitData('gone')
    vi.runAllTimers()

    registry.dispose('s1')
    const result = await registry.ensure('w1', REQUEST)

    expect(spawned).toHaveLength(2)
    expect(result.replay).toBe('')
    expect(result.alive).toBe(true)
  })
})
