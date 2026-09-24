import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { IpcChannel } from '@shared/IpcChannel'

import type { WindowApiType } from '../preload'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke },
  webUtils: {}
}))

vi.stubGlobal('window', {})
await import('../preload')
const api = (window as unknown as { api: WindowApiType }).api

afterAll(() => vi.unstubAllGlobals())
beforeEach(() => invoke.mockReset())

describe('shell.openExternal compatibility bridge', () => {
  it('resolves void after a successful shell request and forwards open options', async () => {
    invoke.mockResolvedValue({ ok: true, data: undefined })
    await expect(api.shell.openExternal('https://example.test', { activate: false })).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith(
      IpcChannel.IpcApi_Request,
      'system.shell.open_external_website',
      { url: 'https://example.test', options: { activate: false } },
      undefined
    )
  })

  it('rejects shell failures so existing preview callers can display an error', async () => {
    invoke.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'No browser available' } })
    await expect(api.shell.openExternal('https://example.test')).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'No browser available'
    })
  })

  it('rejects blocked schemes without dispatching a shell request', async () => {
    await expect(api.shell.openExternal('javascript:alert(1)')).rejects.toThrow('untrusted URL scheme')
    expect(invoke).not.toHaveBeenCalled()
  })
})
