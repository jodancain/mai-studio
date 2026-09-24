import type * as ChildProcess from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, vi } from 'vitest'

const { execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))

import { type AppRecord, ensureProfile, readAppRecord, restartApp, stopOwnedApp } from '../lifecycle'
import { ensureRunDirectories, getRunPaths } from '../paths'

afterEach(() => {
  execFileSyncMock.mockReset()
  spawnMock.mockReset()
  vi.restoreAllMocks()
})

describe('owned application lifecycle', () => {
  it.each([true, false])(
    'restarts past an exited zombie only when its runner was owned (matching command: %s)',
    async (matchingCommand) => {
      const directory = mkdtempSync(join(tmpdir(), 'cherry-regression-lifecycle-'))
      const paths = getRunPaths(directory)
      ensureRunDirectories(paths)
      const executablePath = join(paths.installed, 'mai studio.app', 'Contents', 'MacOS', 'mai studio')
      const runnerPid = 42_000
      const nextRunnerPid = 43_000
      let running = true
      let replacementRunning = false
      const record: AppRecord = {
        schemaVersion: 1,
        ownership: 'regression-driver',
        policy: 'ephemeral',
        mode: 'tag',
        platform: 'macos',
        profile: 'authenticated',
        runKey: 'restart-test',
        targetRoot: directory,
        executablePath,
        command: executablePath,
        args: [],
        cwd: directory,
        runnerPid,
        electronPid: runnerPid,
        cdpPort: 9222,
        targetUrl: 'file:///windows/main/index.html',
        logPath: join(paths.logs, 'electron.log'),
        startedAt: '2026-08-22T00:00:00.000Z',
        restartCount: 2
      }
      writeFileSync(paths.appRecord, JSON.stringify(record))
      writeFileSync(paths.installation, JSON.stringify({ executablePath }))
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -runnerPid && signal === 'SIGTERM') {
          running = false
          return true
        }
        if (signal === 0 && (pid === runnerPid || (pid === nextRunnerPid && replacementRunning))) return true
        throw new Error('Unexpected process signal')
      })
      execFileSyncMock.mockImplementation((file: string, args: string[]) => {
        if (file === 'lsof') return replacementRunning ? String(nextRunnerPid) : running ? String(runnerPid) : ''
        const command = running ? (matchingCommand ? executablePath : 'unrelated-app') : '[mai studio] <defunct>'
        if (args[1] === 'pid=,pgid=,command=') return `${runnerPid} ${runnerPid} ${command}`
        if (args[1] === 'pgid=,stat=') return `${runnerPid} ${running ? 'S' : 'Z'}`
        if (args[1] === 'command=') return command
        throw new Error(`Unexpected command: ${file} ${args.join(' ')}`)
      })
      spawnMock.mockImplementation((command: string, args: string[]) => {
        expect(running).toBe(false)
        expect(command).toBe(executablePath)
        expect(args).toContain(`--user-data-dir=${join(paths.profiles, 'clean')}`)
        replacementRunning = true
        return { pid: nextRunnerPid, unref: vi.fn() }
      })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify([{ type: 'page', title: 'mai studio', url: record.targetUrl }]))
      )

      try {
        if (!matchingCommand) {
          await expect(restartApp(paths, 'clean')).rejects.toThrow('Refusing to terminate stale runner PID')
          expect(replacementRunning).toBe(false)
          expect(spawnMock).not.toHaveBeenCalled()
          expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
          expect(readAppRecord(paths)).toEqual(record)
          return
        }
        const restarted = await restartApp(paths, 'clean')
        expect(restarted).toMatchObject({
          profile: 'clean',
          runKey: record.runKey,
          targetRoot: record.targetRoot,
          executablePath,
          runnerPid: nextRunnerPid,
          electronPid: nextRunnerPid,
          restartCount: 3
        })
        expect(readAppRecord(paths)).toEqual(restarted)
      } finally {
        rmSync(directory, { force: true, recursive: true })
      }
    }
  )

  it('reuses a live application when the requested profile already matches', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cherry-regression-lifecycle-'))
    const paths = getRunPaths(directory)
    ensureRunDirectories(paths)
    const record: AppRecord = {
      schemaVersion: 1,
      ownership: 'regression-driver',
      policy: 'ephemeral',
      mode: 'branch',
      platform: 'macos',
      profile: 'clean',
      runKey: 'test-run',
      targetRoot: '/tmp/target-app',
      command: 'pnpm',
      args: ['debug'],
      cwd: '/tmp/target-app',
      runnerPid: 42_000,
      electronPid: 42_001,
      cdpPort: 9222,
      targetUrl: 'http://127.0.0.1:9222',
      logPath: join(paths.logs, 'electron.log'),
      startedAt: '2026-08-22T00:00:00.000Z',
      restartCount: 0
    }
    writeFileSync(paths.appRecord, JSON.stringify(record))
    vi.spyOn(process, 'kill').mockReturnValue(true)

    try {
      await expect(ensureProfile(paths, 'clean')).resolves.toEqual(record)
      expect(execFileSyncMock).not.toHaveBeenCalled()
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('force terminates the verified Windows process tree and waits for its CDP listener', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cherry-regression-lifecycle-'))
    const paths = getRunPaths(directory)
    ensureRunDirectories(paths)
    const runnerPid = 42_000
    const electronPid = 42_001
    const alive = new Set([runnerPid, electronPid])
    let cdpChecks = 0
    const targetRoot = 'D:\\target-app'
    const record: AppRecord = {
      schemaVersion: 1,
      ownership: 'regression-driver',
      policy: 'ephemeral',
      mode: 'branch',
      platform: 'windows',
      profile: 'authenticated',
      runKey: 'test-run',
      targetRoot,
      command: 'pnpm.cmd',
      args: ['debug'],
      cwd: targetRoot,
      runnerPid,
      electronPid,
      cdpPort: 9222,
      targetUrl: 'http://127.0.0.1:9222',
      logPath: join(paths.logs, 'electron.log'),
      startedAt: '2026-08-22T00:00:00.000Z',
      restartCount: 0
    }
    writeFileSync(paths.appRecord, JSON.stringify(record))

    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (!alive.has(Number(pid))) throw new Error('Process not found')
      return true
    })
    execFileSyncMock.mockImplementation((file: string, args: string[]) => {
      const script = String(args.at(-1))
      if (file === 'taskkill.exe') {
        if (Number(args[1]) === runnerPid) alive.clear()
        else alive.delete(Number(args[1]))
        return ''
      }
      if (script.includes('Get-NetTCPConnection')) {
        cdpChecks += 1
        return alive.has(electronPid) || cdpChecks === 2 ? String(electronPid) : ''
      }
      if (script.includes('CommandLine')) {
        return script.includes(String(electronPid)) ? targetRoot : 'pnpm exec dotenv -- electron-vite'
      }
      if (script.includes('ParentProcessId')) return script.includes(String(electronPid)) ? String(runnerPid) : '1'
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`)
    })

    try {
      await stopOwnedApp(paths)
      expect(execFileSyncMock).not.toHaveBeenCalledWith(
        'taskkill.exe',
        ['/PID', String(electronPid), '/T', '/F'],
        expect.anything()
      )
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'taskkill.exe',
        ['/PID', String(runnerPid), '/T', '/F'],
        expect.anything()
      )
      expect(cdpChecks).toBe(3)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('only terminates a replacement Windows Electron process owned by the recorded runner', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cherry-regression-lifecycle-'))
    const paths = getRunPaths(directory)
    ensureRunDirectories(paths)
    const runnerPid = 42_000
    const staleElectronPid = 42_001
    const currentElectronPid = 42_002
    const alive = new Set([runnerPid, currentElectronPid])
    let currentParentPid = 1
    const targetRoot = 'D:\\target-app'
    const record: AppRecord = {
      schemaVersion: 1,
      ownership: 'regression-driver',
      policy: 'ephemeral',
      mode: 'branch',
      platform: 'windows',
      profile: 'authenticated',
      runKey: 'test-run',
      targetRoot,
      command: 'pnpm.cmd',
      args: ['debug'],
      cwd: targetRoot,
      runnerPid,
      electronPid: staleElectronPid,
      cdpPort: 9222,
      targetUrl: 'http://127.0.0.1:9222',
      logPath: join(paths.logs, 'electron.log'),
      startedAt: '2026-08-22T00:00:00.000Z',
      restartCount: 0
    }
    writeFileSync(paths.appRecord, JSON.stringify(record))

    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (!alive.has(Number(pid))) throw new Error('Process not found')
      return true
    })
    execFileSyncMock.mockImplementation((file: string, args: string[]) => {
      const script = String(args.at(-1))
      if (file === 'taskkill.exe') {
        if (Number(args[1]) === runnerPid) alive.clear()
        else alive.delete(Number(args[1]))
        return ''
      }
      if (script.includes('Get-NetTCPConnection'))
        return alive.has(currentElectronPid) ? String(currentElectronPid) : ''
      if (script.includes('CommandLine')) {
        return script.includes(String(currentElectronPid)) ? targetRoot : 'pnpm exec dotenv -- electron-vite'
      }
      if (script.includes('ParentProcessId'))
        return script.includes(String(currentElectronPid)) ? String(currentParentPid) : '1'
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`)
    })

    try {
      await expect(stopOwnedApp(paths)).rejects.toThrow(
        'Refusing cleanup because the current CDP process is not owned by the recorded runner'
      )
      expect(execFileSyncMock.mock.calls.some(([file]) => file === 'taskkill.exe')).toBe(false)

      currentParentPid = runnerPid
      await stopOwnedApp(paths)
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'taskkill.exe',
        ['/PID', String(runnerPid), '/T', '/F'],
        expect.anything()
      )
      expect(execFileSyncMock).not.toHaveBeenCalledWith(
        'taskkill.exe',
        ['/PID', String(currentElectronPid), '/T', '/F'],
        expect.anything()
      )
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
