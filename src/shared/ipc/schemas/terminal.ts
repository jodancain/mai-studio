import * as z from 'zod'

import { defineRoute } from '../define'

/**
 * Embedded terminal schemas — one PTY per agent session, owned by the main
 * process TerminalService. `terminal.ensure` is idempotent: it spawns on first
 * call and reattaches afterwards, returning the scrollback replay plus a seq
 * watermark so the renderer can drop already-replayed `terminal.data` events.
 */
const sessionIdSchema = z.string().min(1)

const terminalSizeSchema = {
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000)
}

// ── Request schemas ──
export const terminalRequestSchemas = {
  'terminal.ensure': defineRoute({
    input: z.object({
      sessionId: sessionIdSchema,
      // Validated main-side against the filesystem; invalid or missing falls
      // back to the user's home directory.
      cwd: z.string().optional(),
      ...terminalSizeSchema
    }),
    output: z.object({
      replay: z.string(),
      lastSeq: z.number().int(),
      alive: z.boolean()
    })
  }),
  'terminal.write': defineRoute({
    input: z.object({ sessionId: sessionIdSchema, data: z.string().max(1024 * 1024) }),
    output: z.void()
  }),
  'terminal.resize': defineRoute({
    input: z.object({ sessionId: sessionIdSchema, ...terminalSizeSchema }),
    output: z.void()
  }),
  'terminal.dispose': defineRoute({
    input: z.object({ sessionId: sessionIdSchema }),
    output: z.void()
  })
}

/**
 * Terminal events (M→R, pure types). `terminal.data` is a class-B stream sent
 * directed to the owning window (coalesced main-side), never broadcast.
 */
export type TerminalEventSchemas = {
  'terminal.data': { sessionId: string; seq: number; data: string }
  'terminal.exit': { sessionId: string; exitCode: number }
}
