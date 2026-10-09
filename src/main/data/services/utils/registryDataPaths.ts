import { existsSync, readFileSync } from 'node:fs'

import { app } from 'electron'

import { application } from '@application'
import {
  type CatalogManifest,
  CatalogManifestSchema,
  isCatalogManifestCompatible,
  type RegistryPaths,
  REMOTE_REGISTRY_FILES
} from '@cherrystudio/provider-registry/node'

import { parseRegistryFile, type RegistrySnapshot } from '../providerRegistryComposition'

/**
 * Completion marker written last after both remote-safe model metadata files.
 * Provider routing always remains bundled.
 */
export const OVERRIDE_MANIFEST = 'manifest.json'
export const PREVIOUS_REGISTRY_SNAPSHOT = 'previous-snapshot.json'
export const REGISTRY_SOURCE_REVISION = 'source-revision.json'

export type ActiveRegistrySnapshot = RegistrySnapshot & { manifest: CatalogManifest; generation?: string }

export function registrySnapshotFileName(file: string, generation?: string): string {
  if (generation !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(generation)) {
    throw new Error('Invalid registry generation')
  }
  return generation ? `snapshot-${generation}-${file}` : file
}

export function readActiveOverrideSnapshot(): ActiveRegistrySnapshot | null {
  const directory = 'feature.provider_registry.override' as const
  const manifestPath = application.getPath(directory, OVERRIDE_MANIFEST)
  if (!existsSync(manifestPath)) return null
  try {
    const manifestBody = readFileSync(manifestPath, 'utf-8')
    const raw = JSON.parse(manifestBody) as Record<string, unknown>
    const manifest = CatalogManifestSchema.parse(raw)
    if (!isCatalogManifestCompatible(manifest, app.getVersion())) return null
    const generation = raw.generation === undefined ? undefined : String(raw.generation)
    const files = {} as ActiveRegistrySnapshot['files']
    for (const file of REMOTE_REGISTRY_FILES) {
      const path = application.getPath(directory, registrySnapshotFileName(file, generation))
      if (!existsSync(path)) return null
      const body = readFileSync(path, 'utf-8')
      if (parseRegistryFile(file, body).version !== manifest.files[file]) return null
      files[file] = body
    }
    return { files, manifestBody, manifest, generation }
  } catch {
    return null
  }
}

export function readRegistrySourceRevision(): number {
  const path = application.getPath('feature.provider_registry.override', REGISTRY_SOURCE_REVISION)
  let revision = readActiveOverrideManifest()?.revision ?? -1
  if (!existsSync(path)) return revision
  try {
    const stored = JSON.parse(readFileSync(path, 'utf-8')) as { revision?: unknown }
    if (typeof stored.revision === 'number' && Number.isSafeInteger(stored.revision) && stored.revision >= 0) {
      revision = Math.max(revision, stored.revision)
    }
  } catch {
    // An invalid watermark cannot make the active catalog older.
  }
  return revision
}

/**
 * Read the active complete override manifest for this build. The provider file
 * is deliberately excluded: unsigned remote data may enrich models but cannot
 * replace credential-bearing routing configuration.
 */
export function readActiveOverrideManifest(): CatalogManifest | null {
  return readActiveOverrideSnapshot()?.manifest ?? null
}

/**
 * Resolve registry files while keeping provider routing bundled. Models and
 * provider-model metadata switch together only after a complete compatible
 * snapshot is present; a partial snapshot falls back to bundled metadata.
 */
export function resolveRegistryPaths(): RegistryPaths {
  const bundled = 'feature.provider_registry.data' as const
  const active = readActiveOverrideSnapshot()
  const modelData = active ? 'feature.provider_registry.override' : bundled
  return {
    models: application.getPath(modelData, registrySnapshotFileName('models.json', active?.generation)),
    providers: application.getPath(bundled, 'providers.json'),
    providerModels: application.getPath(modelData, registrySnapshotFileName('provider-models.json', active?.generation))
  }
}
