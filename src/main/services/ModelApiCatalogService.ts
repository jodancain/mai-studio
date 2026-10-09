import { createHash, randomUUID } from 'node:crypto'

import { application } from '@application'
import { loggerService } from '@logger'
import { appProviderIds } from '@main/ai/types'
import { BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import type { UserModelRow } from '@main/data/db/schemas/userModel'
import { modelService, type DiscoveredModelReceipt } from '@main/data/services/ModelService'
import { providerRegistryService } from '@main/data/services/ProviderRegistryService'
import { providerService } from '@main/data/services/ProviderService'
import { createUniqueModelId, ENDPOINT_TYPE, type EndpointType, type Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import {
  DEFAULT_MODEL_API_CATALOG_STATE,
  MODEL_API_AUTOMATIC_VERIFY_LIMIT,
  type ModelApiCatalogCandidate,
  type ModelApiCatalogPolicy,
  type ModelApiCatalogState,
  type ModelApiVerification
} from '@shared/types/modelApiCatalog'

const logger = loggerService.withContext('ModelApiCatalogService')
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const CHAT_ENDPOINTS = new Set<EndpointType>([
  ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
  ENDPOINT_TYPE.OPENAI_RESPONSES,
  ENDPOINT_TYPE.OPENAI_TEXT_COMPLETIONS,
  ENDPOINT_TYPE.ANTHROPIC_MESSAGES,
  ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT,
  ENDPOINT_TYPE.OLLAMA_CHAT,
  ENDPOINT_TYPE.OLLAMA_GENERATE
])

type CandidateEntry = {
  candidate: ModelApiCatalogCandidate
  model: Model | null
  expected: UserModelRow | null
  providerFingerprint: string
  registryFingerprint: string
  verifiedFingerprint?: string
}
const pendingVerification = (): ModelApiVerification => ({
  status: 'pending',
  conversation: 'unknown',
  streaming: 'unknown',
  tools: 'unknown',
  vision: 'unknown',
  context: 'unknown'
})
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function availableCatalogEndpoints(provider: Pick<Provider, 'endpointConfigs'>): EndpointType[] {
  return (Object.keys(provider.endpointConfigs ?? {}) as EndpointType[]).filter((endpoint) => {
    const config = provider.endpointConfigs?.[endpoint]
    return (
      CHAT_ENDPOINTS.has(endpoint) &&
      !!config?.baseUrl &&
      (config.adapterFamily === undefined
        ? endpoint === ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS || endpoint === ENDPOINT_TYPE.OPENAI_RESPONSES
        : Object.hasOwn(appProviderIds, config.adapterFamily))
    )
  })
}

@Injectable('ModelApiCatalogService')
@ServicePhase(Phase.WhenReady)
@DependsOn(['AiService', 'ProviderRegistryUpdaterService'])
export class ModelApiCatalogService extends BaseService {
  private catalogState: ModelApiCatalogState = structuredClone(DEFAULT_MODEL_API_CATALOG_STATE)
  private entries = new Map<string, CandidateEntry>()
  private attempted = new Set<string>()
  private verificationHistory = new Map<string, { fingerprint: string; verification: ModelApiVerification }>()
  private receipts: DiscoveredModelReceipt[] = []
  private controller: AbortController | null = null
  private canceledGeneration = 0

  protected onReady(): void {
    this.catalogState.registryRollbackAvailable = application.get('ProviderRegistryUpdaterService').canRollback
    this.publish()
    this.registerInterval(() => this.runAutomaticScan(), CHECK_INTERVAL_MS)
    const initial = setTimeout(() => void this.runAutomaticScan(), 30_000)
    initial.unref()
    this.registerDisposable(() => clearTimeout(initial))
  }

  protected onStop(): void {
    this.cancel()
  }

  public read(): ModelApiCatalogState {
    this.catalogState.policy = this.readPolicy()
    for (const entry of this.entries.values()) {
      if (entry.candidate.applied || entry.candidate.verification.status !== 'verified') continue
      if (this.entryIsCurrent(entry) && entry.verifiedFingerprint === hash(entry.model)) continue
      entry.candidate.verification = { ...pendingVerification(), status: 'stale', reason: 'verification_stale' }
      if (entry.candidate.change === 'new') entry.candidate.after.isEnabled = false
    }
    return structuredClone(this.catalogState)
  }

  private readPolicy(): ModelApiCatalogPolicy {
    const preferences = application.get('PreferenceService')
    return {
      discoveryEnabled: preferences.get('model_api.catalog.discovery_enabled'),
      automaticVerifyEnabled:
        preferences.get('model_api.catalog.automatic_verify_enabled') &&
        preferences.get('model_api.catalog.paid_verification_confirmed_at') > 0,
      automaticApplyEnabled: preferences.get('model_api.catalog.automatic_apply_enabled')
    }
  }

  public async policy(input: {
    policy: ModelApiCatalogPolicy
    confirmPaidVerification?: boolean
  }): Promise<ModelApiCatalogState> {
    this.assertIdle()
    const current = this.readPolicy()
    if (input.policy.automaticVerifyEnabled && !current.automaticVerifyEnabled && !input.confirmPaidVerification)
      throw new Error('paid_verification_confirmation_required')
    await application.get('PreferenceService').setMultiple({
      'model_api.catalog.discovery_enabled': input.policy.discoveryEnabled,
      'model_api.catalog.automatic_verify_enabled': input.policy.automaticVerifyEnabled,
      'model_api.catalog.automatic_apply_enabled': input.policy.automaticApplyEnabled,
      ...(input.policy.automaticVerifyEnabled && input.confirmPaidVerification
        ? { 'model_api.catalog.paid_verification_confirmed_at': Date.now() }
        : {})
    })
    return this.publish()
  }

  private providerFingerprint(providerId: string): string {
    const auth = providerService.getAuthConfig(providerId)
    const stableAuth =
      auth?.type === 'oauth'
        ? {
            type: auth.type,
            clientId: auth.clientId,
            accountId: auth.accountId,
            credential: auth.refreshToken ?? auth.accessToken
          }
        : auth
    return hash({
      provider: providerService.getByProviderId(providerId),
      keys: providerService.getApiKeys(providerId, { enabled: true }),
      auth: stableAuth
    })
  }

  private entryIsCurrent(entry: CandidateEntry): boolean {
    try {
      if (this.providerFingerprint(entry.candidate.providerId) !== entry.providerFingerprint) return false
      if (this.registryFingerprint() !== entry.registryFingerprint) return false
      const row =
        modelService
          .readDiscoveryRows(entry.candidate.providerId)
          .find((item) => item.modelId === entry.candidate.apiModelId) ?? null
      return hash(row) === hash(entry.expected)
    } catch {
      return false
    }
  }

  private registryFingerprint(): string {
    return hash(
      ['models.json', 'provider-models.json'].map((file) =>
        providerRegistryService.getCatalogVersion(file as 'models.json' | 'provider-models.json')
      )
    )
  }

  private verificationKey(entry: CandidateEntry): string {
    return `${entry.candidate.providerId}\0${entry.candidate.apiModelId}`
  }

  private verificationFingerprint(entry: CandidateEntry): string {
    return hash({ provider: entry.providerFingerprint, registry: entry.registryFingerprint, model: entry.model })
  }

  private exactMetadata(provider: Provider, apiModelId: string): Model | null {
    const model = providerRegistryService.resolveExactModel(
      {
        id: provider.id,
        presetProviderId: provider.presetProviderId ?? null,
        endpointConfigs: provider.endpointConfigs,
        defaultChatEndpoint: provider.defaultChatEndpoint
      },
      apiModelId
    )
    return model ? { ...model, supportsStreaming: false } : null
  }

  private addCandidate(
    provider: Provider,
    apiModelId: string,
    change: ModelApiCatalogCandidate['change'],
    expected: UserModelRow | null,
    fingerprint: string
  ): void {
    let metadata: Model | null = null
    let model: Model | null = null
    const availableEndpoints = availableCatalogEndpoints(provider)
    try {
      metadata = this.exactMetadata(provider, apiModelId)
      model = metadata ?? {
        id: createUniqueModelId(provider.id, apiModelId),
        providerId: provider.id,
        apiModelId,
        name: apiModelId,
        capabilities: [],
        supportsStreaming: false,
        isEnabled: false,
        isHidden: false
      }
      if (expected) model = modelService.getByKey(provider.id, apiModelId)
    } catch {
      model = null
    }
    const declared = model?.endpointTypes?.filter((endpoint) => availableEndpoints.includes(endpoint)) ?? []
    const endpointType =
      metadata || expected
        ? (declared[0] ??
          (provider.defaultChatEndpoint && availableEndpoints.includes(provider.defaultChatEndpoint)
            ? provider.defaultChatEndpoint
            : undefined))
        : undefined
    if (model) model.endpointTypes = endpointType ? [endpointType] : []
    const verification = pendingVerification()
    if (!model) {
      verification.status = 'unsupported'
      verification.reason = 'unsupported_model'
    }
    const candidate: ModelApiCatalogCandidate = {
      id: randomUUID(),
      providerId: provider.id,
      providerName: provider.name,
      apiModelId,
      name: model?.name ?? apiModelId,
      change,
      source: 'provider_api',
      metadataSource: metadata ? 'exact_registry' : 'none',
      capabilities: metadata?.capabilities ?? [],
      availableEndpoints,
      endpointType,
      requiresManualEndpoint: !endpointType,
      ...(expected ? { before: { isEnabled: expected.isEnabled, isDeprecated: expected.isDeprecated } } : {}),
      after: { isEnabled: expected?.isEnabled ?? false, isDeprecated: change === 'missing' },
      verification,
      applied: false
    }
    const entry: CandidateEntry = {
      candidate,
      model,
      expected: expected ? structuredClone(expected) : null,
      providerFingerprint: fingerprint,
      registryFingerprint: this.registryFingerprint()
    }
    const previous = this.verificationHistory.get(this.verificationKey(entry))
    if (previous?.fingerprint === this.verificationFingerprint(entry)) {
      candidate.verification = structuredClone(previous.verification)
      if (candidate.verification.status === 'verified') {
        entry.verifiedFingerprint = hash(model)
        if (change === 'new') candidate.after.isEnabled = true
      }
    }
    this.entries.set(candidate.id, entry)
    this.catalogState.report!.candidates.push(candidate)
  }

  public async scan(input: { providerIds?: string[] } = {}): Promise<ModelApiCatalogState> {
    this.assertIdle()
    const controller = new AbortController()
    this.controller = controller
    this.catalogState.status = 'scanning'
    this.entries.clear()
    this.attempted.clear()
    this.catalogState.report = { id: randomUUID(), scannedAt: Date.now(), providers: [], candidates: [] }
    this.publish()
    const selected = input.providerIds ? new Set(input.providerIds) : null
    try {
      for (const provider of providerService
        .list({ enabled: true })
        .filter((item) => !selected || selected.has(item.id))) {
        if (controller.signal.aborted) break
        try {
          const fingerprint = this.providerFingerprint(provider.id)
          const listing = await application
            .get('AiService')
            .fetchModelsDetailed(provider.id, { signal: controller.signal, source: 'provider_api' })
          controller.signal.throwIfAborted()
          if (this.providerFingerprint(provider.id) !== fingerprint) throw new Error('verification_stale')
          const apiIds = new Set(
            listing.models
              .map((model) => model.apiModelId)
              .filter((id): id is string => typeof id === 'string' && id.length > 0)
          )
          const completeness =
            listing.completeness === 'complete' &&
            listing.models.some((model) => typeof model.apiModelId !== 'string' || model.apiModelId.length === 0)
              ? 'partial'
              : listing.completeness
          this.catalogState.report.providers.push({
            providerId: provider.id,
            providerName: provider.name,
            completeness,
            source: listing.source,
            discoveredCount: apiIds.size,
            ...(completeness === 'unsupported'
              ? { reason: 'listing_unsupported' }
              : completeness === 'partial'
                ? { reason: 'partial_listing' }
                : {})
          })
          if (listing.source === 'provider_api') {
            const rows = modelService.readDiscoveryRows(provider.id)
            for (const apiModelId of apiIds) {
              const existing = rows.find((row) => row.modelId === apiModelId)
              if (!existing || existing.isDeprecated)
                this.addCandidate(provider, apiModelId, existing ? 'restored' : 'new', existing ?? null, fingerprint)
            }
            if (completeness === 'complete') {
              for (const row of rows)
                if (!apiIds.has(row.modelId) && !row.isDeprecated)
                  this.addCandidate(provider, row.modelId, 'missing', row, fingerprint)
            }
          }
        } catch {
          if (controller.signal.aborted) break
          this.catalogState.report.providers.push({
            providerId: provider.id,
            providerName: provider.name,
            completeness: 'failed',
            source: 'provider_api',
            discoveredCount: 0,
            reason: 'listing_failed'
          })
          logger.warn('Provider catalog discovery failed', { providerId: provider.id })
        }
        this.publish()
      }
    } finally {
      this.controller = null
      this.catalogState.status = 'idle'
    }
    return this.publish()
  }

  public async verify(input: {
    reportId: string
    candidateIds: string[]
    endpointType?: EndpointType
  }): Promise<ModelApiCatalogState> {
    this.assertIdle()
    const entries = this.selectedEntries(input.reportId, input.candidateIds)
    const controller = new AbortController()
    this.controller = controller
    this.catalogState.status = 'verifying'
    try {
      for (const entry of entries) {
        if (controller.signal.aborted) break
        const { candidate } = entry
        if (candidate.applied || candidate.change === 'missing' || this.attempted.has(candidate.id)) continue
        if (input.endpointType !== undefined) {
          if (!candidate.availableEndpoints.includes(input.endpointType)) throw new Error('endpoint_unavailable')
          candidate.endpointType = input.endpointType
          candidate.requiresManualEndpoint = false
          if (entry.model) entry.model.endpointTypes = [input.endpointType]
        }
        if (!entry.model || !candidate.endpointType) {
          candidate.verification.reason = 'endpoint_required'
          continue
        }
        this.attempted.add(candidate.id)
        candidate.verification.status = 'verifying'
        this.publish()
        try {
          if (!this.entryIsCurrent(entry)) throw new Error('verification_stale')
          const fingerprint = hash(entry.model)
          const prepared = application.get('AiService').prepareResolvedModelCheck({
            providerId: candidate.providerId,
            model: entry.model,
            isCurrent: () => this.entryIsCurrent(entry) && hash(entry.model) === fingerprint
          })
          if (!prepared.supportsChat || prepared.isExternalCli) throw new Error('unsupported_model')
          const result = await prepared.checkConversation(controller.signal)
          controller.signal.throwIfAborted()
          if (!prepared.isCurrent()) throw new Error('verification_stale')
          entry.verifiedFingerprint = fingerprint
          candidate.verification = {
            ...pendingVerification(),
            status: 'verified',
            conversation: 'passed',
            checkedAt: Date.now(),
            latencyMs: result.latency
          }
          if (candidate.change === 'new') candidate.after.isEnabled = true
        } catch {
          candidate.verification = {
            ...pendingVerification(),
            status: controller.signal.aborted ? 'pending' : this.entryIsCurrent(entry) ? 'failed' : 'stale',
            conversation: 'failed',
            checkedAt: Date.now(),
            reason: controller.signal.aborted
              ? 'canceled'
              : this.entryIsCurrent(entry)
                ? 'verification_failed'
                : 'verification_stale'
          }
        }
        if (candidate.verification.status === 'verified' || candidate.verification.status === 'failed') {
          this.verificationHistory.set(this.verificationKey(entry), {
            fingerprint: this.verificationFingerprint(entry),
            verification: structuredClone(candidate.verification)
          })
        }
        this.publish()
      }
    } finally {
      this.controller = null
      this.catalogState.status = 'idle'
    }
    return this.publish()
  }

  public apply(input: { reportId: string; candidateIds: string[] }): ModelApiCatalogState {
    this.assertIdle()
    const entries = this.selectedEntries(input.reportId, input.candidateIds).filter(
      ({ candidate }) => !candidate.applied
    )
    if (entries.length === 0) return this.read()
    for (const entry of entries) {
      if (!entry.model || !this.entryIsCurrent(entry)) throw new Error('verification_stale')
      if (entry.candidate.verification.status === 'verified' && entry.verifiedFingerprint !== hash(entry.model))
        throw new Error('verification_stale')
    }
    this.catalogState.status = 'applying'
    try {
      this.receipts = modelService.applyDiscoveredModels(
        entries.map((entry) => ({
          model: entry.model!,
          change: entry.candidate.change,
          expected: entry.expected,
          verified: entry.candidate.verification.status === 'verified'
        }))
      )
      for (const { candidate } of entries) candidate.applied = true
      this.catalogState.lastBatch = {
        id: randomUUID(),
        appliedAt: Date.now(),
        candidateIds: entries.map(({ candidate }) => candidate.id),
        undoAvailable: this.receipts.length > 0,
        conflicts: []
      }
    } finally {
      this.catalogState.status = 'idle'
    }
    return this.publish()
  }

  public undo(input: { batchId: string }): ModelApiCatalogState {
    this.assertIdle()
    const batch = this.catalogState.lastBatch
    if (!batch || batch.id !== input.batchId || !batch.undoAvailable) throw new Error('batch_unavailable')
    batch.conflicts = modelService.undoDiscoveredModels(this.receipts)
    batch.undoAvailable = false
    for (const id of batch.candidateIds) {
      const entry = this.entries.get(id)
      if (entry && !batch.conflicts.includes(entry.model?.id ?? '')) entry.candidate.applied = false
    }
    this.receipts = []
    return this.publish()
  }

  public cancel(): ModelApiCatalogState {
    this.canceledGeneration++
    this.controller?.abort()
    return this.read()
  }

  public async registryPreview(): Promise<ModelApiCatalogState> {
    this.assertIdle()
    const controller = new AbortController()
    this.controller = controller
    this.catalogState.status = 'scanning'
    this.publish()
    try {
      const preview = await application.get('ProviderRegistryUpdaterService').preview(controller.signal)
      if (!controller.signal.aborted) this.catalogState.registryPreview = preview
    } catch (error) {
      if (!controller.signal.aborted) throw error
    } finally {
      this.controller = null
      this.catalogState.status = 'idle'
      this.publish()
    }
    return this.read()
  }

  public async registryApply(input: { previewId: string }): Promise<ModelApiCatalogState> {
    this.assertIdle()
    this.catalogState.status = 'applying'
    this.publish()
    try {
      await application.get('ProviderRegistryUpdaterService').apply(input.previewId)
      this.catalogState.registryPreview = null
      this.catalogState.registryRollbackAvailable = application.get('ProviderRegistryUpdaterService').canRollback
    } finally {
      this.catalogState.status = 'idle'
      this.publish()
    }
    return this.read()
  }

  public async registryRollback(): Promise<ModelApiCatalogState> {
    this.assertIdle()
    this.catalogState.status = 'applying'
    this.publish()
    try {
      await application.get('ProviderRegistryUpdaterService').rollback()
      this.catalogState.registryRollbackAvailable = application.get('ProviderRegistryUpdaterService').canRollback
    } finally {
      this.catalogState.status = 'idle'
      this.publish()
    }
    return this.read()
  }

  private async runAutomaticScan(): Promise<void> {
    if (this.catalogState.status !== 'idle' || !this.readPolicy().discoveryEnabled) return
    const generation = this.canceledGeneration
    try {
      await this.scan()
      if (generation !== this.canceledGeneration) return
      const policy = this.readPolicy()
      const candidates =
        this.catalogState.report?.candidates.filter(
          (candidate) => candidate.change === 'new' && !candidate.requiresManualEndpoint
        ) ?? []
      const pending = candidates
        .filter(({ verification }) => verification.status === 'pending')
        .slice(0, MODEL_API_AUTOMATIC_VERIFY_LIMIT)
      if (policy.automaticVerifyEnabled && pending.length)
        await this.verify({ reportId: this.catalogState.report!.id, candidateIds: pending.map(({ id }) => id) })
      if (generation !== this.canceledGeneration) return
      const verified = candidates.filter(({ verification }) => verification.status === 'verified')
      if (this.readPolicy().automaticApplyEnabled && verified.length)
        this.apply({ reportId: this.catalogState.report!.id, candidateIds: verified.map(({ id }) => id) })
    } catch {
      logger.warn('Automatic model catalog cycle failed')
    }
  }

  private selectedEntries(reportId: string, ids: string[]): CandidateEntry[] {
    if (this.catalogState.report?.id !== reportId) throw new Error('report_unavailable')
    return [...new Set(ids)].map((id) => {
      const entry = this.entries.get(id)
      if (!entry) throw new Error('candidate_unavailable')
      return entry
    })
  }

  private assertIdle(): void {
    if (this.catalogState.status !== 'idle') throw new Error('catalog_busy')
  }
  private publish(): ModelApiCatalogState {
    const state = this.read()
    application.get('CacheService').setShared('model_api.catalog', state)
    return state
  }
}
