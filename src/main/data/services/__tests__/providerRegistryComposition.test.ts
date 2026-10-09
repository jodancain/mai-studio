import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { REGISTRY_SCHEMA_VERSION } from '@cherrystudio/provider-registry/node'

import {
  composeForkProviderRegistrySnapshot,
  parseRegistryFile,
  registryContentVersion,
  type RegistrySnapshotFiles
} from '../providerRegistryComposition'

const file = (body: Record<string, unknown>) => JSON.stringify({ ...body, version: registryContentVersion(body) })
const snapshot = (models: unknown[] = [], overrides: unknown[] = []): RegistrySnapshotFiles => ({
  'models.json': file({ models }),
  'provider-models.json': file({ overrides })
})
const model = (id: string, name = id) => ({ id, name })

describe('fork provider registry composition', () => {
  it('accepts both bundled catalogs under the stricter update validator', () => {
    expect(() =>
      parseRegistryFile('models.json', readFileSync('packages/provider-registry/data/models.json', 'utf-8'))
    ).not.toThrow()
    expect(() =>
      parseRegistryFile(
        'provider-models.json',
        readFileSync('packages/provider-registry/data/provider-models.json', 'utf-8')
      )
    ).not.toThrow()
  })
  it('rejects a malformed row or unsupported capability instead of silently discarding it', () => {
    expect(() => parseRegistryFile('models.json', file({ models: [model('valid'), { id: 'invalid' }] }))).toThrow(
      'unsupported array'
    )
    expect(() =>
      parseRegistryFile(
        'models.json',
        file({ models: [{ ...model('valid'), capabilities: ['future-unknown-capability'] }] })
      )
    ).toThrow('unsupported array')
  })

  it('rejects tampered content and duplicate wire identities', () => {
    const tampered = JSON.parse(file({ models: [model('valid')] }))
    tampered.models[0].name = 'Changed without digest update'
    expect(() => parseRegistryFile('models.json', JSON.stringify(tampered))).toThrow('hash mismatch')
    expect(() =>
      parseRegistryFile(
        'provider-models.json',
        file({
          overrides: [
            { providerId: 'a', modelId: 'one', apiModelId: 'wire' },
            { providerId: 'a', modelId: 'two', apiModelId: 'wire' }
          ]
        })
      )
    ).toThrow('duplicate')
  })

  it('preserves missing rows and bundled MAI pins while applying remote additions and changes', () => {
    const bundled = snapshot(
      [model('mai-base', 'MAI bundled'), model('fork-only')],
      [{ providerId: 'mai', modelId: 'mai-base', apiModelId: 'mai-wire' }]
    )
    const active = snapshot(
      [model('mai-base', 'Stale override'), model('fork-only'), model('remote-old')],
      [
        { providerId: 'mai', modelId: 'mai-base', apiModelId: 'mai-wire', name: 'Stale override' },
        { providerId: 'custom', modelId: 'remote-old' }
      ]
    )
    const remote = snapshot(
      [model('mai-base', 'Untrusted overwrite'), model('new')],
      [
        { providerId: 'mai', modelId: 'mai-base', apiModelId: 'mai-wire', name: 'Untrusted overwrite' },
        { providerId: 'other', modelId: 'new' }
      ]
    )
    const manifest = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      minAppVersion: '2.0.0',
      sourceAppVersion: '2.0.0',
      revision: 7,
      files: {
        'models.json': JSON.parse(remote['models.json']).version,
        'provider-models.json': JSON.parse(remote['provider-models.json']).version
      }
    }
    const merged = composeForkProviderRegistrySnapshot(bundled, active, remote, manifest)
    expect(parseRegistryFile('models.json', merged.snapshot.files['models.json']).models).toEqual(
      expect.arrayContaining([model('mai-base', 'MAI bundled'), model('fork-only'), model('remote-old'), model('new')])
    )
    expect(
      parseRegistryFile('provider-models.json', merged.snapshot.files['provider-models.json']).overrides.find(
        (row) => row.providerId === 'mai'
      )
    ).toEqual({ providerId: 'mai', modelId: 'mai-base', apiModelId: 'mai-wire' })
    expect(JSON.parse(merged.snapshot.manifestBody)).toMatchObject({ revision: 7, sourceFiles: manifest.files })
    expect(merged.changes).toEqual([
      { id: 'new', kind: 'model', change: 'added' },
      { id: 'other/new', kind: 'provider_model', change: 'added' }
    ])
  })
})
