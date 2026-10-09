import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { writeHook } = vi.hoisted(() => ({ writeHook: vi.fn() }))
vi.mock('@main/utils/file', async () => {
  const { atomicWriteFile } = await vi.importActual<{ atomicWriteFile: typeof WriteAtomic }>('@main/utils/file/fs')
  return {
    atomicWriteFile: async (...args: Parameters<typeof atomicWriteFile>) => {
      writeHook(args[0])
      await atomicWriteFile(...args)
    }
  }
})
vi.mock('@main/data/services/ProviderRegistryService', () => ({ providerRegistryService: { clearCache: vi.fn() } }))
vi.mock('electron', () => ({ app: { getVersion: () => '2.0.0' } }))

import { application } from '@application'
import { REGISTRY_SCHEMA_VERSION } from '@cherrystudio/provider-registry/node'
import { registryContentVersion } from '@main/data/services/providerRegistryComposition'
import {
  readActiveOverrideSnapshot,
  readRegistrySourceRevision,
  resolveRegistryPaths
} from '@main/data/services/utils/registryDataPaths'
import type { atomicWriteFile as WriteAtomic } from '@main/utils/file'

import {
  hasPreviousProviderRegistrySnapshot,
  rollbackProviderRegistrySnapshot,
  writeProviderRegistrySnapshot
} from '../providerRegistrySnapshot'

const file = (body: Record<string, unknown>) => JSON.stringify({ ...body, version: registryContentVersion(body) })
function snapshot(revision: number) {
  const files = {
    'models.json': file({ models: [{ id: `model-${revision}`, name: `Model ${revision}` }] }),
    'provider-models.json': file({ overrides: [{ providerId: 'custom', modelId: `model-${revision}` }] })
  }
  const manifestBody = JSON.stringify({
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    minAppVersion: '1.0.0',
    sourceAppVersion: '2.0.0',
    revision,
    files: Object.fromEntries(Object.entries(files).map(([key, body]) => [key, JSON.parse(body).version]))
  })
  return { files, manifestBody }
}

describe('atomic provider registry snapshots', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mai-registry-snapshot-'))
    mkdirSync(join(root, 'feature.provider_registry.override'))
    vi.mocked(application.getPath).mockImplementation((key, filename) => join(root, key, filename ?? ''))
    writeHook.mockReset()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    vi.mocked(application.getPath).mockReset()
  })

  it('keeps readers on the previous complete generation until both new files are ready', async () => {
    const first = snapshot(1)
    await writeProviderRegistrySnapshot(first.files, first.manifestBody)
    const observed: number[] = []
    writeHook.mockImplementation(() => observed.push(readActiveOverrideSnapshot()!.manifest.revision))
    const second = snapshot(2)
    await writeProviderRegistrySnapshot(second.files, second.manifestBody)
    expect(observed.every((value) => value === 1)).toBe(true)
    expect(readActiveOverrideSnapshot()?.files).toEqual(second.files)
    expect(resolveRegistryPaths().providers).toBe(join(root, 'feature.provider_registry.data', 'providers.json'))
  })

  it.each(['-models.json', '-provider-models.json', 'previous-snapshot.json', 'manifest.json'])(
    'preserves active data and rollback after a failed write to %s',
    async (suffix) => {
      const first = snapshot(1)
      const second = snapshot(2)
      await writeProviderRegistrySnapshot(first.files, first.manifestBody)
      await writeProviderRegistrySnapshot(second.files, second.manifestBody)
      const before = readActiveOverrideSnapshot()
      const backupPath = application.getPath('feature.provider_registry.override', 'previous-snapshot.json')
      const backup = readFileSync(backupPath, 'utf-8')
      let failed = false
      writeHook.mockImplementation((path: string) => {
        if (!failed && path.endsWith(suffix)) {
          failed = true
          throw new Error('disk full')
        }
      })
      const third = snapshot(3)
      await expect(writeProviderRegistrySnapshot(third.files, third.manifestBody)).rejects.toThrow('disk full')
      expect(readActiveOverrideSnapshot()).toEqual(before)
      expect(readFileSync(backupPath, 'utf-8')).toBe(backup)
      expect(readRegistrySourceRevision()).toBe(2)
      expect(
        readdirSync(application.getPath('feature.provider_registry.override')).filter((name) =>
          name.startsWith('snapshot-')
        )
      ).toHaveLength(4)
      await rollbackProviderRegistrySnapshot()
      expect(readActiveOverrideSnapshot()?.files).toEqual(first.files)
    }
  )

  it('restores the previous override once and remembers the undone source revision', async () => {
    const first = snapshot(1)
    const second = snapshot(2)
    await writeProviderRegistrySnapshot(first.files, first.manifestBody)
    await writeProviderRegistrySnapshot(second.files, second.manifestBody)
    await rollbackProviderRegistrySnapshot()
    expect(readActiveOverrideSnapshot()?.files).toEqual(first.files)
    expect(readRegistrySourceRevision()).toBe(2)
    expect(hasPreviousProviderRegistrySnapshot()).toBe(false)
    await expect(rollbackProviderRegistrySnapshot()).rejects.toThrow('No previous')
  })

  it('returns to bundled data after the first update without permitting that revision to autoapply again', async () => {
    const first = snapshot(7)
    await writeProviderRegistrySnapshot(first.files, first.manifestBody)
    expect(hasPreviousProviderRegistrySnapshot()).toBe(true)
    await rollbackProviderRegistrySnapshot()
    expect(readActiveOverrideSnapshot()).toBeNull()
    expect(resolveRegistryPaths().models).toBe(join(root, 'feature.provider_registry.data', 'models.json'))
    expect(readRegistrySourceRevision()).toBe(7)
  })

  it('keeps the current generation if the rollback watermark cannot be persisted', async () => {
    const first = snapshot(1)
    await writeProviderRegistrySnapshot(first.files, first.manifestBody)
    writeHook.mockImplementation((path: string) => {
      if (path.endsWith('source-revision.json')) throw new Error('read only')
    })
    await expect(rollbackProviderRegistrySnapshot()).rejects.toThrow('read only')
    expect(readActiveOverrideSnapshot()?.files).toEqual(first.files)
    expect(hasPreviousProviderRegistrySnapshot()).toBe(true)
  })

  it('rejects corrupt or incompatible input before creating a completion marker', async () => {
    const bad = snapshot(1)
    const parsed = JSON.parse(bad.files['models.json'])
    parsed.models[0].name = 'tampered'
    await expect(
      writeProviderRegistrySnapshot({ ...bad.files, 'models.json': JSON.stringify(parsed) }, bad.manifestBody)
    ).rejects.toThrow('hash mismatch')
    const newer = JSON.stringify({ ...JSON.parse(bad.manifestBody), minAppVersion: '9.0.0', sourceAppVersion: '9.0.0' })
    await expect(writeProviderRegistrySnapshot(bad.files, newer)).rejects.toThrow('incompatible')
    expect(existsSync(application.getPath('feature.provider_registry.override', 'manifest.json'))).toBe(false)
  })
})
