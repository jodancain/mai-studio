import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import type { ITheme } from '@xterm/xterm'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'

import { useTheme } from '@renderer/hooks/useTheme'
import { ipcApi } from '@renderer/ipc'
import { ThemeMode } from '@shared/data/preference/preferenceTypes'

// xterm paints to canvas, so its palette must be concrete color values — the
// terminal owns these locally like other code-rendering components (DESIGN.md §4).
const DARK_THEME: ITheme = {
  background: '#1a1a1a',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  selectionBackground: '#264f78'
}
const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#333333',
  cursor: '#333333',
  selectionBackground: '#add6ff'
}

const RESIZE_DEBOUNCE_MS = 50

interface AgentTerminalPanelProps {
  sessionId: string
  cwd?: string
  active: boolean
}

/**
 * Interactive terminal for one agent session. The PTY lives in the main
 * process (`TerminalService`) and survives unmounts; this component only owns
 * the xterm view. On mount it subscribes to `terminal.data` first, then calls
 * the idempotent `terminal.ensure` — queued events at or below the returned
 * `lastSeq` watermark are duplicates of the replayed scrollback and dropped.
 */
export function AgentTerminalPanel({ sessionId, cwd, active }: AgentTerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const { theme } = useTheme()
  const dark = theme === ThemeMode.dark

  const fitAndReport = () => {
    const container = containerRef.current
    const terminal = terminalRef.current
    // fit() under display:none (hidden <Activity>) yields no dimensions — skip.
    if (!terminal || !fitRef.current || !container || !container.clientWidth || !container.clientHeight) return
    const { cols, rows } = terminal
    fitRef.current.fit()
    if (terminal.cols !== cols || terminal.rows !== rows) {
      void ipcApi.request('terminal.resize', { sessionId, cols: terminal.cols, rows: terminal.rows })
    }
  }
  const fitAndReportRef = useRef(fitAndReport)
  fitAndReportRef.current = fitAndReport

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new Terminal({
      scrollback: 5000,
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
      theme: dark ? DARK_THEME : LIGHT_THEME
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminalRef.current = terminal
    fitRef.current = fit
    if (container.clientWidth && container.clientHeight) fit.fit()

    let disposed = false
    let live = false
    let watermark = 0
    let queued: { seq: number; data: string }[] = []

    const offData = ipcApi.on('terminal.data', (payload) => {
      if (payload.sessionId !== sessionId) return
      if (!live) {
        queued.push(payload)
        return
      }
      if (payload.seq <= watermark) return
      terminal.write(payload.data)
    })
    const offExit = ipcApi.on('terminal.exit', (payload) => {
      if (payload.sessionId !== sessionId) return
      terminal.write(`\r\n[process exited with code ${payload.exitCode}]\r\n`)
    })
    const input = terminal.onData((data) => {
      void ipcApi.request('terminal.write', { sessionId, data })
    })

    void ipcApi
      .request('terminal.ensure', { sessionId, cwd, cols: terminal.cols, rows: terminal.rows })
      .then((result) => {
        if (disposed) return
        watermark = result.lastSeq
        if (result.replay) terminal.write(result.replay)
        for (const payload of queued) {
          if (payload.seq > watermark) terminal.write(payload.data)
        }
        queued = []
        live = true
      })
      .catch((error: unknown) => {
        if (disposed) return
        terminal.write(`\r\n[failed to start terminal: ${error instanceof Error ? error.message : String(error)}]\r\n`)
      })

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => fitAndReportRef.current(), RESIZE_DEBOUNCE_MS)
    })
    observer.observe(container)

    return () => {
      disposed = true
      if (resizeTimer) clearTimeout(resizeTimer)
      observer.disconnect()
      offData()
      offExit()
      input.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
    // cwd only matters at spawn time; the PTY is keyed by sessionId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    const terminal = terminalRef.current
    if (terminal) terminal.options.theme = dark ? DARK_THEME : LIGHT_THEME
  }, [dark])

  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => {
      fitAndReportRef.current()
      terminalRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active])

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden pl-2 [&_.xterm]:h-full"
      style={{ backgroundColor: dark ? DARK_THEME.background : LIGHT_THEME.background }}
    />
  )
}
