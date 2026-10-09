import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'

import { app } from 'electron'

import { application } from '@application'
import {
  CatalogManifestSchema,
  isCatalogManifestCompatible,
  REMOTE_REGISTRY_FILES,
  type RemoteRegistryFileName
} from '@cherrystudio/provider-registry/node'
import { parseRegistryFile, type RegistrySnapshot } from '@main/data/services/providerRegistryComposition'
import { providerRegistryService } from '@main/data/services/ProviderRegistryService'
import {
  OVERRIDE_MANIFEST,
  PREVIOUS_REGISTRY_SNAPSHOT,
  readActiveOverrideSnapshot,
  readRegistrySourceRevision,
  REGISTRY_SOURCE_REVISION,
  registrySnapshotFileName
} from '@main/data/services/utils/registryDataPaths'
import { atomicWriteFile } from '@main/utils/file'
import { AbsoluteFilePathSchema } from '@shared/types/file'

const directory = 'feature.provider_registry.override' as const
type PreviousSnapshot = { snapshot: RegistrySnapshot | null }

export function hasPreviousProviderRegistrySnapshot(): boolean {
  return readPreviousSnapshot() !== undefined
}

function readPreviousSnapshot(): PreviousSnapshot | undefined {
  const path = application.getPath(directory, PREVIOUS_REGISTRY_SNAPSHOT)
  if (!existsSync(path)) return undefined
  try {
    const previous = JSON.parse(readFileSync(path, 'utf-8')) as PreviousSnapshot
    if (previous.snapshot === null) return previous
    validateSnapshot(previous.snapshot)
    return previous
  } catch {
    return undefined
  }
}

function validateSnapshot(snapshot: RegistrySnapshot): void {
  const manifest = CatalogManifestSchema.parse(JSON.parse(snapshot.manifestBody))
  if (!isCatalogManifestCompatible(manifest, app.getVersion())) throw new Error('Registry snapshot is incompatible')
  for (const file of REMOTE_REGISTRY_FILES) {
    if (parseRegistryFile(file, snapshot.files[file]).version !== manifest.files[file]) {
      throw new Error('Registry snapshot version mismatch')
    }
  }
}

/** Writes immutable metadata files before switching the active manifest. */
export async function writeProviderRegistrySnapshot(
  files: Record<RemoteRegistryFileName, string>,
  manifestBody: string,
  options: { savePrevious?: boolean } = {}
): Promise<void> {
  validateSnapshot({ files, manifestBody })
  const previous = readActiveOverrideSnapshot()
  const manifestPath = application.getPath(directory, OVERRIDE_MANIFEST)
  const previousPath = application.getPath(directory, PREVIOUS_REGISTRY_SNAPSHOT)
  const revisionPath = application.getPath(directory, REGISTRY_SOURCE_REVISION)
  const oldBackup = existsSync(previousPath) ? readFileSync(previousPath, 'utf-8') : undefined
  const oldRevision = existsSync(revisionPath) ? readFileSync(revisionPath, 'utf-8') : undefined
  const generation = randomUUID()
  const manifest = CatalogManifestSchema.parse(JSON.parse(manifestBody))
  const highWatermark = Math.max(readRegistrySourceRevision(), manifest.revision)
  const generatedPaths: string[] = []
  let backupChanged = false
  let revisionChanged = false
  try {
    for (const file of REMOTE_REGISTRY_FILES) {
      const path = application.getPath(directory, registrySnapshotFileName(file, generation))
      generatedPaths.push(path)
      await atomicWriteFile(AbsoluteFilePathSchema.parse(path), files[file])
    }
    if (options.savePrevious !== false) {
      await atomicWriteFile(
        AbsoluteFilePathSchema.parse(previousPath),
        JSON.stringify({
          snapshot: previous ? { files: previous.files, manifestBody: previous.manifestBody } : null
        })
      )
      backupChanged = true
    }
    if (options.savePrevious === false) {
      await atomicWriteFile(AbsoluteFilePathSchema.parse(revisionPath), JSON.stringify({ revision: highWatermark }))
      revisionChanged = true
    }
    await atomicWriteFile(
      AbsoluteFilePathSchema.parse(manifestPath),
      JSON.stringify({ ...JSON.parse(manifestBody), generation })
    )
  } catch (error) {
    if (backupChanged) {
      if (oldBackup !== undefined) await atomicWriteFile(AbsoluteFilePathSchema.parse(previousPath), oldBackup)
      else rmSync(previousPath, { force: true })
    }
    if (revisionChanged) {
      if (oldRevision !== undefined) await atomicWriteFile(AbsoluteFilePathSchema.parse(revisionPath), oldRevision)
      else rmSync(revisionPath, { force: true })
    }
    for (const path of generatedPaths) rmSync(path, { force: true })
    throw error
  }
  providerRegistryService.clearCache()
}

export async function rollbackProviderRegistrySnapshot(): Promise<void> {
  const previous = readPreviousSnapshot()
  if (!previous) throw new Error('No previous registry snapshot')
  if (previous.snapshot) {
    await writeProviderRegistrySnapshot(previous.snapshot.files, previous.snapshot.manifestBody, {
      savePrevious: false
    })
  } else {
    await atomicWriteFile(
      AbsoluteFilePathSchema.parse(application.getPath(directory, REGISTRY_SOURCE_REVISION)),
      JSON.stringify({ revision: readRegistrySourceRevision() })
    )
    rmSync(application.getPath(directory, OVERRIDE_MANIFEST), { force: true })
    providerRegistryService.clearCache()
  }
  rmSync(application.getPath(directory, PREVIOUS_REGISTRY_SNAPSHOT), { force: true })
}
