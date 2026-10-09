import { createHash } from 'node:crypto'

import {
  ModelListSchema,
  ProviderModelListSchema,
  type CatalogManifest,
  type RemoteRegistryFileName
} from '@cherrystudio/provider-registry/node'

export type RegistrySnapshotFiles = Record<RemoteRegistryFileName, string>
export type RegistrySnapshot = { files: RegistrySnapshotFiles; manifestBody: string }

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as Record<string, unknown>)[key])])
    )
  }
  return value
}

export function registryContentVersion(value: Record<string, unknown>): string {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'version'))
  return createHash('sha256')
    .update(JSON.stringify(sorted(body)))
    .digest('hex')
    .slice(0, 16)
}

function assertNoDiscardedArrayEntries(raw: unknown, parsed: unknown): void {
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed) || raw.length !== parsed.length)
      throw new Error('Registry contains unsupported array entries')
    raw.forEach((item, index) => assertNoDiscardedArrayEntries(item, parsed[index]))
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (Array.isArray(value) || (value && typeof value === 'object')) {
        assertNoDiscardedArrayEntries(value, (parsed as Record<string, unknown> | undefined)?.[key])
      }
    }
  }
}

export function parseRegistryFile(file: 'models.json', text: string): ReturnType<typeof ModelListSchema.parse>
export function parseRegistryFile(
  file: 'provider-models.json',
  text: string
): ReturnType<typeof ProviderModelListSchema.parse>
export function parseRegistryFile(file: RemoteRegistryFileName, text: string): { version: string }
export function parseRegistryFile(file: RemoteRegistryFileName, text: string) {
  const raw = JSON.parse(text) as Record<string, unknown>
  const parsed = file === 'models.json' ? ModelListSchema.parse(raw) : ProviderModelListSchema.parse(raw)
  assertNoDiscardedArrayEntries(raw, parsed)
  if (parsed.version !== registryContentVersion(raw)) throw new Error('Registry content hash mismatch')
  const entries =
    'models' in parsed
      ? parsed.models.map((m) => m.id)
      : parsed.overrides.map((m) => `${m.providerId}\0${m.apiModelId ?? m.modelId}`)
  if (new Set(entries).size !== entries.length) throw new Error('Registry contains duplicate identities')
  return parsed
}

function serialize(body: Record<string, unknown>): string {
  return JSON.stringify(sorted({ ...body, version: registryContentVersion(body) }), null, 2) + '\n'
}

/** Compose this fork's catalog while retaining bundled MAI pins and remote-missing metadata. */
export function composeForkProviderRegistrySnapshot(
  bundled: RegistrySnapshotFiles,
  active: RegistrySnapshotFiles,
  remote: RegistrySnapshotFiles,
  manifest: CatalogManifest
): {
  snapshot: RegistrySnapshot
  changes: Array<{ id: string; kind: 'model' | 'provider_model'; change: 'added' | 'updated' }>
  preservedCount: number
} {
  const bundledModels = parseRegistryFile('models.json', bundled['models.json']).models
  const bundledOverrides = parseRegistryFile('provider-models.json', bundled['provider-models.json']).overrides
  const activeModels = parseRegistryFile('models.json', active['models.json']).models
  const activeOverrides = parseRegistryFile('provider-models.json', active['provider-models.json']).overrides
  const remoteModels = parseRegistryFile('models.json', remote['models.json']).models
  const remoteOverrides = parseRegistryFile('provider-models.json', remote['provider-models.json']).overrides
  const changes: Array<{ id: string; kind: 'model' | 'provider_model'; change: 'added' | 'updated' }> = []
  const pins = bundledOverrides.filter((row) => row.providerId === 'mai')
  const pinnedIds = new Set(pins.map((row) => row.modelId))
  const models = new Map([...bundledModels, ...activeModels].map((row) => [row.id, row]))
  const overrideKey = (row: (typeof activeOverrides)[number]) => `${row.providerId}\0${row.apiModelId ?? row.modelId}`
  const overrides = new Map([...bundledOverrides, ...activeOverrides].map((row) => [overrideKey(row), row]))
  for (const row of remoteModels) {
    if (pinnedIds.has(row.id)) continue
    const previous = models.get(row.id)
    if (JSON.stringify(sorted(previous)) !== JSON.stringify(sorted(row)))
      changes.push({ id: row.id, kind: 'model', change: previous ? 'updated' : 'added' })
    models.set(row.id, row)
  }
  for (const row of remoteOverrides) {
    if (row.providerId === 'mai') continue
    const key = overrideKey(row)
    const previous = overrides.get(key)
    if (JSON.stringify(sorted(previous)) !== JSON.stringify(sorted(row)))
      changes.push({
        id: `${row.providerId}/${row.apiModelId ?? row.modelId}`,
        kind: 'provider_model',
        change: previous ? 'updated' : 'added'
      })
    overrides.set(key, row)
  }
  for (const row of bundledModels) if (pinnedIds.has(row.id)) models.set(row.id, row)
  for (const row of pins) overrides.set(overrideKey(row), row)
  const files = {
    'models.json': serialize({ models: [...models.values()] }),
    'provider-models.json': serialize({ overrides: [...overrides.values()] })
  }
  const manifestBody =
    JSON.stringify(
      {
        ...manifest,
        sourceFiles: manifest.files,
        files: {
          'models.json': JSON.parse(files['models.json']).version,
          'provider-models.json': JSON.parse(files['provider-models.json']).version
        }
      },
      null,
      2
    ) + '\n'
  const remoteKeys = new Set(remoteOverrides.map(overrideKey))
  const preservedCount =
    activeModels.filter((row) => !remoteModels.some((next) => next.id === row.id)).length +
    activeOverrides.filter((row) => !remoteKeys.has(overrideKey(row))).length
  return { snapshot: { files, manifestBody }, changes, preservedCount }
}
