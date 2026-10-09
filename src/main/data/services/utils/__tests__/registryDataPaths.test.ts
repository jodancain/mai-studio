import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '2.0.0' } }))

import { application } from '@application'
import { REGISTRY_SCHEMA_VERSION } from '@cherrystudio/provider-registry/node'

import { registryContentVersion } from '../../providerRegistryComposition'
import { readActiveOverrideSnapshot, readRegistrySourceRevision, resolveRegistryPaths } from '../registryDataPaths'

const generation = 'f959cb52-37e6-4338-ab6c-05d191191d90'
const modelBody = { models: [{ id: 'valid', name: 'Valid' }] }
const overrideBody = { overrides: [{ providerId: 'custom', modelId: 'valid' }] }
const models = JSON.stringify({ ...modelBody, version: registryContentVersion(modelBody) })
const overrides = JSON.stringify({ ...overrideBody, version: registryContentVersion(overrideBody) })
const manifest = {
  minAppVersion: '1.0.0',
  sourceAppVersion: '2.0.0',
  revision: 3,
  schemaVersion: REGISTRY_SCHEMA_VERSION,
  files: { 'models.json': JSON.parse(models).version, 'provider-models.json': JSON.parse(overrides).version }
}

describe('complete compatible registry path selection', () => {
  let root: string
  let override: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mai-registry-paths-'))
    override = join(root, 'feature.provider_registry.override')
    mkdirSync(override)
    vi.mocked(application.getPath).mockImplementation((key, filename) => join(root, key, filename ?? ''))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    vi.mocked(application.getPath).mockReset()
  })
  function writeSnapshot(extra: Record<string, unknown> = {}, suffix = '') {
    writeFileSync(join(override, `${suffix}models.json`), models)
    writeFileSync(join(override, `${suffix}provider-models.json`), overrides)
    writeFileSync(join(override, 'manifest.json'), JSON.stringify({ ...manifest, ...extra }))
  }
  function expectBundled() {
    expect(resolveRegistryPaths()).toEqual({
      models: join(root, 'feature.provider_registry.data', 'models.json'),
      providers: join(root, 'feature.provider_registry.data', 'providers.json'),
      providerModels: join(root, 'feature.provider_registry.data', 'provider-models.json')
    })
  }

  it('supports preexisting complete overrides and keeps provider routing bundled', () => {
    writeSnapshot()
    expect(readActiveOverrideSnapshot()?.files).toEqual({ 'models.json': models, 'provider-models.json': overrides })
    expect(resolveRegistryPaths()).toEqual({
      models: join(override, 'models.json'),
      providers: join(root, 'feature.provider_registry.data', 'providers.json'),
      providerModels: join(override, 'provider-models.json')
    })
  })
  it('selects only the immutable generation named by the active manifest', () => {
    writeSnapshot({ generation }, `snapshot-${generation}-`)
    writeFileSync(join(override, 'models.json'), 'uncommitted file')
    expect(resolveRegistryPaths().models).toBe(join(override, `snapshot-${generation}-models.json`))
  })
  it.each([
    { schemaVersion: REGISTRY_SCHEMA_VERSION + 1 },
    { minAppVersion: '2.1.0' },
    { sourceAppVersion: '1.9.0' },
    { generation: '../../outside' }
  ])('falls back to the bundle for an incompatible manifest %j', (extra) => {
    writeSnapshot(extra)
    expectBundled()
  })
  it('falls back as a whole when one generation file is missing', () => {
    writeSnapshot({ generation }, `snapshot-${generation}-`)
    rmSync(join(override, `snapshot-${generation}-provider-models.json`))
    expectBundled()
  })
  it('rejects a changed payload even if its claimed version matches the manifest', () => {
    writeSnapshot()
    writeFileSync(
      join(override, 'models.json'),
      JSON.stringify({ version: manifest.files['models.json'], models: [{ id: 'valid', name: 'tampered' }] })
    )
    expectBundled()
  })
  it('does not adopt uncommitted files without a manifest', () => {
    writeFileSync(join(override, 'models.json'), models)
    expectBundled()
  })
  it('ignores malformed watermarks and retains the highest committed source revision', () => {
    writeSnapshot()
    writeFileSync(join(override, 'source-revision.json'), JSON.stringify({ revision: 9 }))
    expect(readRegistrySourceRevision()).toBe(9)
    writeFileSync(join(override, 'source-revision.json'), JSON.stringify({ revision: -1 }))
    expect(readRegistrySourceRevision()).toBe(3)
  })
})
