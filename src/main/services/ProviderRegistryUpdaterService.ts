import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { app, net } from 'electron'

import { application } from '@application'
import {
  CatalogManifestSchema,
  isCatalogManifestCompatible,
  REGISTRY_SCHEMA_VERSION,
  REMOTE_REGISTRY_FILES,
  type RemoteRegistryFileName
} from '@cherrystudio/provider-registry/node'
import { loggerService } from '@logger'
import { BaseService, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { notifyDataApiDataChange } from '@main/data/dataApiDataChange'
import {
  composeForkProviderRegistrySnapshot,
  parseRegistryFile,
  type RegistrySnapshot,
  type RegistrySnapshotFiles
} from '@main/data/services/providerRegistryComposition'
import { providerRegistryService } from '@main/data/services/ProviderRegistryService'
import { readActiveOverrideSnapshot, readRegistrySourceRevision } from '@main/data/services/utils/registryDataPaths'
import {
  hasPreviousProviderRegistrySnapshot,
  rollbackProviderRegistrySnapshot,
  writeProviderRegistrySnapshot
} from '@main/services/providerRegistrySnapshot'
import { regionService } from '@main/services/RegionService'
import { generateUserAgent } from '@main/utils/systemInfo'
import type { DataApiDataChangeEffect } from '@shared/data/api/types'
import type { ModelApiRegistryPreview } from '@shared/types/modelApiCatalog'
import { UPSTREAM_SERVICES_ENABLED } from '@shared/utils/constants'

const logger = loggerService.withContext('ProviderRegistryUpdaterService')
const REMOTE_BRANCH = 'x-files/provider-registry'
const REMOTE_SUBPATH = `v${REGISTRY_SCHEMA_VERSION}`
export const REGISTRY_URL_GITHUB = `https://raw.githubusercontent.com/CherryHQ/cherry-studio/refs/heads/${REMOTE_BRANCH}/${REMOTE_SUBPATH}`
export const REGISTRY_URL_GITCODE = `https://raw.gitcode.com/CherryHQ/cherry-studio/raw/${encodeURIComponent(REMOTE_BRANCH)}/${REMOTE_SUBPATH}`
export const resolveRegistryBaseUrl = async (): Promise<string> =>
  (await regionService.getCountry()).toLowerCase() === 'cn' ? REGISTRY_URL_GITCODE : REGISTRY_URL_GITHUB

const REGISTRY_DATA_CHANGE_EFFECTS = [
  { endpoint: '/models', kind: 'projection' },
  { endpoint: '/models/:uniqueModelId*' },
  { endpoint: '/providers/:providerId/preset' },
  { endpoint: '/providers/:providerId/models:resolve', kind: 'membership' },
  { endpoint: '/providers/:providerId/models/:modelId*/image-generation-support' }
] satisfies DataApiDataChangeEffect[]

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const PREVIEW_TTL_MS = 10 * 60 * 1000

type PendingPreview = {
  preview: ModelApiRegistryPreview
  snapshot: RegistrySnapshot
  versions: Record<RemoteRegistryFileName, string | null>
  sourceRevision: number
}

@Injectable('ProviderRegistryUpdaterService')
@ServicePhase(Phase.WhenReady)
export class ProviderRegistryUpdaterService extends BaseService {
  private pending: PendingPreview | null = null
  private download: AbortController | null = null
  private writing = false
  private lastAppliedId: string | null = null

  protected onReady(): void {
    this.registerDisposable(() => {
      this.download?.abort()
      this.pending = null
    })
    // Fork-wide upstream services remain opt-out; catalog commands are explicit.
    if (!app.isPackaged || !UPSTREAM_SERVICES_ENABLED) return
    this.registerInterval(() => this.check(), CHECK_INTERVAL_MS)
    const initial = setTimeout(() => void this.check(), 30_000)
    initial.unref()
    this.registerDisposable(() => clearTimeout(initial))
  }

  get canRollback(): boolean {
    return hasPreviousProviderRegistrySnapshot()
  }

  public async check(): Promise<void> {
    try {
      const preview = await this.preview()
      if (preview) await this.apply(preview.id)
    } catch (error) {
      logger.warn('registry update cycle failed', error as Error)
    }
  }

  public async preview(signal?: AbortSignal): Promise<ModelApiRegistryPreview | null> {
    if (this.download || this.writing) throw new Error('Registry update busy')
    const controller = new AbortController()
    this.download = controller
    this.pending = null
    try {
      const requestSignal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15_000),
        ...(signal ? [signal] : [])
      ])
      const current = readActiveOverrideSnapshot()
      const versions = this.currentVersions()
      const sourceRevision = readRegistrySourceRevision()
      const baseUrl = await resolveRegistryBaseUrl()
      const headers = { 'User-Agent': generateUserAgent(), 'Cache-Control': 'no-cache', Accept: 'application/json' }
      const fetchText = async (name: string): Promise<string> => {
        const response = await net.fetch(`${baseUrl}/${name}`, { headers, signal: requestSignal })
        if (!response.ok) throw new Error(`Registry request failed (${response.status})`)
        const body = await response.text()
        if (body.length > 16 * 1024 * 1024) throw new Error('Registry file is too large')
        return body
      }
      const manifest = CatalogManifestSchema.parse(JSON.parse(await fetchText('manifest.json')))
      if (!isCatalogManifestCompatible(manifest, app.getVersion()))
        throw new Error('Registry is incompatible with this application')
      if (manifest.revision <= sourceRevision) {
        this.pending = null
        return null
      }
      const remote = {} as RegistrySnapshotFiles
      for (const file of REMOTE_REGISTRY_FILES) {
        const body = await fetchText(file)
        if (parseRegistryFile(file, body).version !== manifest.files[file])
          throw new Error('Registry revision is inconsistent')
        remote[file] = body
      }
      requestSignal.throwIfAborted()
      const bundled = Object.fromEntries(
        REMOTE_REGISTRY_FILES.map((file) => [
          file,
          readFileSync(application.getPath('feature.provider_registry.data', file), 'utf-8')
        ])
      ) as RegistrySnapshotFiles
      const merged = composeForkProviderRegistrySnapshot(bundled, current?.files ?? bundled, remote, manifest)
      const preview: ModelApiRegistryPreview = {
        id: randomUUID(),
        sourceRevision: manifest.revision,
        currentRevision: current?.manifest.revision ?? null,
        checkedAt: Date.now(),
        changes: merged.changes,
        preservedCount: merged.preservedCount
      }
      this.pending = { preview, snapshot: merged.snapshot, versions, sourceRevision }
      return structuredClone(preview)
    } finally {
      if (this.download === controller) this.download = null
    }
  }

  public async apply(previewId: string): Promise<void> {
    if (this.writing || this.download) throw new Error('Registry update busy')
    if (this.lastAppliedId === previewId && !this.pending) return
    const pending = this.pending
    if (!pending || pending.preview.id !== previewId || Date.now() - pending.preview.checkedAt >= PREVIEW_TTL_MS) {
      throw new Error('Registry preview expired')
    }
    const versions = this.currentVersions()
    if (
      REMOTE_REGISTRY_FILES.some((file) => versions[file] !== pending.versions[file]) ||
      readRegistrySourceRevision() !== pending.sourceRevision
    ) {
      this.pending = null
      throw new Error('Registry preview is stale')
    }
    this.writing = true
    try {
      await writeProviderRegistrySnapshot(pending.snapshot.files, pending.snapshot.manifestBody)
      this.lastAppliedId = previewId
      this.pending = null
      notifyDataApiDataChange(REGISTRY_DATA_CHANGE_EFFECTS)
    } finally {
      this.writing = false
    }
  }

  public async rollback(): Promise<void> {
    if (this.writing || this.download) throw new Error('Registry update busy')
    this.writing = true
    try {
      await rollbackProviderRegistrySnapshot()
      this.pending = null
      this.lastAppliedId = null
      notifyDataApiDataChange(REGISTRY_DATA_CHANGE_EFFECTS)
    } finally {
      this.writing = false
    }
  }

  private currentVersions(): Record<RemoteRegistryFileName, string | null> {
    return {
      'models.json': providerRegistryService.getCatalogVersion('models.json'),
      'provider-models.json': providerRegistryService.getCatalogVersion('provider-models.json')
    }
  }
}
