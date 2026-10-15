import { application } from '@application'
import type { terminalRequestSchemas } from '@shared/ipc/schemas/terminal'
import type { IpcHandlersFor } from '@shared/ipc/types'

/** Thin adapters: delegate to TerminalService. */
export const terminalHandlers: IpcHandlersFor<typeof terminalRequestSchemas> = {
  'terminal.ensure': async (input, ctx) => application.get('TerminalService').ensure(ctx.senderId, input),
  'terminal.write': async (input) => application.get('TerminalService').write(input),
  'terminal.resize': async (input) => application.get('TerminalService').resize(input),
  'terminal.dispose': async (input) => application.get('TerminalService').dispose(input.sessionId)
}
