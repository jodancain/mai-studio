import { stat } from 'node:fs/promises'

import { application } from '@application'
import { loggerService } from '@logger'
import { BaseService, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { isMac, isWin } from '@main/core/platform'
import { getShellEnv } from '@main/utils/shellEnv'
import type { InputFor, OutputFor, WindowId } from '@shared/ipc/types'

import { type PtySpawnRequest, TerminalRegistry } from './TerminalRegistry'

const logger = loggerService.withContext('TerminalService')

/**
 * Embedded terminal backend: owns one PTY per agent session through
 * {@link TerminalRegistry} and streams coalesced output to the owning window
 * as directed `terminal.data` events. PTYs outlive pane visibility; they die
 * with their owner window, their session, or service stop.
 */
@Injectable('TerminalService')
@ServicePhase(Phase.WhenReady)
export class TerminalService extends BaseService {
  private readonly registry = new TerminalRegistry((request) => this.spawnPty(request), {
    sendData: (windowId, payload) => application.get('IpcApiService').send(windowId, 'terminal.data', payload),
    sendExit: (windowId, payload) => application.get('IpcApiService').send(windowId, 'terminal.exit', payload)
  })

  protected onInit(): void {
    this.registerDisposable(
      application.get('WindowManager').onWindowDestroyed((managed) => this.registry.disposeByWindow(managed.id))
    )
    this.registerDisposable(() => this.registry.disposeAll())
  }

  async ensure(senderId: WindowId | null, input: InputFor<'terminal.ensure'>): Promise<OutputFor<'terminal.ensure'>> {
    if (!senderId) throw new Error('Terminal requires a managed window sender')
    return this.registry.ensure(senderId, input)
  }

  write(input: InputFor<'terminal.write'>): void {
    this.registry.write(input.sessionId, input.data)
  }

  resize(input: InputFor<'terminal.resize'>): void {
    this.registry.resize(input.sessionId, input.cols, input.rows)
  }

  dispose(sessionId: string): void {
    this.registry.dispose(sessionId)
  }

  /** Kills the PTYs of deleted agent sessions (AgentLifecycleService hook). */
  disposeMany(sessionIds: string[]): void {
    this.registry.disposeMany(sessionIds)
  }

  private async spawnPty(request: PtySpawnRequest) {
    const { spawn } = await import('node-pty')
    const env = { ...(await getShellEnv()), TERM: 'xterm-256color' }
    const shell = this.resolveShell(env)
    const cwd = await this.resolveCwd(request.cwd)
    logger.info('Spawning terminal', { sessionId: request.sessionId, shell: shell.file })
    return spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: request.cols,
      rows: request.rows,
      cwd,
      env
    })
  }

  private resolveShell(env: Record<string, string>): { file: string; args: string[] } {
    if (isWin) return { file: env.COMSPEC || process.env.COMSPEC || 'cmd.exe', args: [] }
    const file = env.SHELL || process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash')
    // Login shell so the user's profile (PATH, prompt) loads, matching VS Code.
    return { file, args: ['-l'] }
  }

  private async resolveCwd(cwd: string | undefined): Promise<string> {
    if (cwd) {
      try {
        if ((await stat(cwd)).isDirectory()) return cwd
      } catch {
        // fall through to home
      }
      logger.warn('Terminal cwd is not a directory, falling back to home', { cwd })
    }
    return application.getPath('sys.home')
  }
}
