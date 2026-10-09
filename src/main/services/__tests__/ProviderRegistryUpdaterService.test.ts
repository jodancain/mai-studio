import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetch, country } = vi.hoisted(() => ({ netFetch: vi.fn(), country: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: true, getVersion: () => '2.0.0' }, net: { fetch: netFetch } }))
vi.mock('@main/services/RegionService', () => ({ regionService: { getCountry: country } }))
vi.mock('@main/utils/systemInfo', () => ({ generateUserAgent: () => 'mai-test' }))
vi.mock('@main/data/services/ProviderRegistryService', () => ({
  providerRegistryService: { clearCache: vi.fn(), getCatalogVersion: vi.fn() }
}))
vi.mock('@main/data/dataApiDataChange', () => ({ notifyDataApiDataChange: vi.fn() }))
vi.mock('@main/utils/file', async () => {
  const { atomicWriteFile } = await vi.importActual<{ atomicWriteFile: typeof WriteAtomic }>('@main/utils/file/fs')
  return { atomicWriteFile }
})

import { application } from '@application'
import { REGISTRY_SCHEMA_VERSION } from '@cherrystudio/provider-registry/node'
import { BaseService } from '@main/core/lifecycle'
import { parseRegistryFile, registryContentVersion } from '@main/data/services/providerRegistryComposition'
import { providerRegistryService } from '@main/data/services/ProviderRegistryService'
import {
  readActiveOverrideSnapshot,
  readRegistrySourceRevision,
  resolveRegistryPaths
} from '@main/data/services/utils/registryDataPaths'
import type { atomicWriteFile as WriteAtomic } from '@main/utils/file'

import {
  ProviderRegistryUpdaterService,
  REGISTRY_URL_GITCODE,
  REGISTRY_URL_GITHUB,
  resolveRegistryBaseUrl
} from '../ProviderRegistryUpdaterService'

const file = (body: Record<string, unknown>) => JSON.stringify({ ...body, version: registryContentVersion(body) })
const snapshot = (models: unknown[], overrides: unknown[]) => ({
  'models.json': file({ models }),
  'provider-models.json': file({ overrides })
})
const bundled = snapshot(
  [
    { id: 'mai', name: 'Bundled MAI' },
    { id: 'fork-only', name: 'Fork only' }
  ],
  [{ providerId: 'mai', modelId: 'mai', apiModelId: 'mai-wire' }]
)
const remote = snapshot(
  [
    { id: 'mai', name: 'Untrusted name' },
    { id: 'new', name: 'New model' }
  ],
  [
    { providerId: 'mai', modelId: 'mai' },
    { providerId: 'other', modelId: 'new' }
  ]
)
const manifest = {
  schemaVersion: REGISTRY_SCHEMA_VERSION,
  minAppVersion: '1.0.0',
  sourceAppVersion: '2.0.0',
  revision: 2,
  files: Object.fromEntries(Object.entries(remote).map(([key, body]) => [key, JSON.parse(body).version]))
}

function serve(extra: Record<string, unknown> = {}, data: Record<string, string> = remote) {
  netFetch.mockImplementation(async (url: string, options: RequestInit) => {
    options.signal?.throwIfAborted()
    const name = url.split('/').pop()!
    const body = name === 'manifest.json' ? JSON.stringify({ ...manifest, ...extra }) : data[name]
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body }
  })
}

describe('preview, apply and undo model registry updates', () => {
  let root: string
  let service: ProviderRegistryUpdaterService
  beforeEach(() => {
    BaseService.resetInstances()
    root = mkdtempSync(join(tmpdir(), 'mai-registry-updater-'))
    const bundle = join(root, 'feature.provider_registry.data')
    mkdirSync(bundle)
    mkdirSync(join(root, 'feature.provider_registry.override'))
    for (const [name, body] of Object.entries(bundled)) writeFileSync(join(bundle, name), body)
    writeFileSync(join(bundle, 'providers.json'), 'bundled routing sentinel')
    vi.mocked(application.getPath).mockImplementation((key, filename) => join(root, key, filename ?? ''))
    vi.mocked(providerRegistryService.getCatalogVersion).mockImplementation((name) => {
      const paths = resolveRegistryPaths()
      if (name === 'models.json') return JSON.parse(readFileSync(paths.models, 'utf-8')).version
      if (name === 'provider-models.json') return JSON.parse(readFileSync(paths.providerModels, 'utf-8')).version
      return 'bundled-routing'
    })
    country.mockReset().mockResolvedValue('US')
    netFetch.mockReset()
    serve()
    service = new ProviderRegistryUpdaterService()
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
    vi.mocked(application.getPath).mockReset()
  })

  it('makes an inspectable preview without writing, then preserves fork rows and routing when applied', async () => {
    const preview = await service.preview()
    expect(preview).toMatchObject({
      sourceRevision: 2,
      currentRevision: null,
      changes: [
        { id: 'new', kind: 'model', change: 'added' },
        { id: 'other/new', kind: 'provider_model', change: 'added' }
      ]
    })
    expect(readActiveOverrideSnapshot()).toBeNull()
    await service.apply(preview!.id)
    const active = readActiveOverrideSnapshot()!
    expect(parseRegistryFile('models.json', active.files['models.json']).models).toEqual(
      expect.arrayContaining([
        { id: 'mai', name: 'Bundled MAI' },
        { id: 'fork-only', name: 'Fork only' },
        { id: 'new', name: 'New model' }
      ])
    )
    expect(readFileSync(resolveRegistryPaths().providers, 'utf-8')).toBe('bundled routing sentinel')
    expect(netFetch.mock.calls.some(([url]) => url.endsWith('/providers.json'))).toBe(false)
    await service.apply(preview!.id)
    expect(readActiveOverrideSnapshot()?.generation).toBe(active.generation)
  })

  it('rolls back once and avoids immediately reapplying the undone source', async () => {
    const preview = await service.preview()
    await service.apply(preview!.id)
    expect(service.canRollback).toBe(true)
    await service.rollback()
    expect(readActiveOverrideSnapshot()).toBeNull()
    expect(service.canRollback).toBe(false)
    expect(readRegistrySourceRevision()).toBe(2)
    await expect(service.preview()).resolves.toBeNull()
  })

  it.each([{ minAppVersion: '9.0.0' }, { sourceAppVersion: '1.9.0' }, { schemaVersion: REGISTRY_SCHEMA_VERSION + 1 }])(
    'rejects incompatible metadata before replacing any active file %j',
    async (extra) => {
      serve(extra)
      await expect(service.preview()).rejects.toThrow('incompatible')
      expect(readActiveOverrideSnapshot()).toBeNull()
      expect(netFetch.mock.calls.every(([url]) => url.endsWith('/manifest.json'))).toBe(true)
    }
  )

  it('rejects a file from another revision and a payload with a forged content digest', async () => {
    serve({}, { ...remote, 'models.json': file({ models: [] }) })
    await expect(service.preview()).rejects.toThrow('inconsistent')
    const tampered = JSON.parse(remote['models.json'])
    tampered.models[0].name = 'tampered'
    serve({}, { ...remote, 'models.json': JSON.stringify(tampered) })
    await expect(service.preview()).rejects.toThrow('hash mismatch')
    expect(readActiveOverrideSnapshot()).toBeNull()
  })

  it('preserves the currently applied generation when the next download fails', async () => {
    const preview = await service.preview()
    await service.apply(preview!.id)
    const active = readActiveOverrideSnapshot()
    serve({ revision: 3 }, { 'models.json': remote['models.json'] })
    await expect(service.preview()).rejects.toThrow('404')
    expect(readActiveOverrideSnapshot()).toEqual(active)
  })

  it('refuses expired or superseded previews instead of writing an obsolete snapshot', async () => {
    const first = await service.preview()
    const second = await service.preview()
    await expect(service.apply(first!.id)).rejects.toThrow('expired')
    vi.spyOn(Date, 'now').mockReturnValue(second!.checkedAt + 10 * 60 * 1000)
    await expect(service.apply(second!.id)).rejects.toThrow('expired')
    vi.restoreAllMocks()
    expect(readActiveOverrideSnapshot()).toBeNull()
  })

  it('refuses a preview whose base catalog changed after it was reviewed', async () => {
    const preview = await service.preview()
    vi.mocked(providerRegistryService.getCatalogVersion).mockReturnValue('changed-base')
    await expect(service.apply(preview!.id)).rejects.toThrow('stale')
    expect(readActiveOverrideSnapshot()).toBeNull()
  })

  it('honors cancellation, clears the rejected preview and allows a later fresh download', async () => {
    const previous = await service.preview()
    const controller = new AbortController()
    controller.abort()
    await expect(service.preview(controller.signal)).rejects.toThrow()
    await expect(service.apply(previous!.id)).rejects.toThrow('expired')
    serve()
    await expect(service.preview()).resolves.toMatchObject({ sourceRevision: 2 })
  })

  it('uses the schema-specific GitCode mirror in China', async () => {
    country.mockResolvedValue('CN')
    await expect(resolveRegistryBaseUrl()).resolves.toBe(REGISTRY_URL_GITCODE)
    await service.preview()
    expect(netFetch.mock.calls.every(([url]) => url.startsWith(REGISTRY_URL_GITCODE))).toBe(true)
    expect(REGISTRY_URL_GITHUB).toContain(`/v${REGISTRY_SCHEMA_VERSION}`)
  })
})
