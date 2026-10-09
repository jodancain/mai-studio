import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setupTestDatabase } from '@test-helpers/db'
import { MockMainPreferenceServiceUtils } from '@test-mocks/main/PreferenceService'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { BaseService } from '@main/core/lifecycle'
import { userModelTable } from '@main/data/db/schemas/userModel'
import { userProviderTable } from '@main/data/db/schemas/userProvider'
import { modelService } from '@main/data/services/ModelService'
import { registryContentVersion } from '@main/data/services/providerRegistryComposition'
import { providerRegistryService } from '@main/data/services/ProviderRegistryService'
import { providerService } from '@main/data/services/ProviderService'
import { generateOrderKeyBetween } from '@main/data/services/utils/orderKey'
import { createUniqueModelId, ENDPOINT_TYPE, type Model } from '@shared/data/types/model'

import { availableCatalogEndpoints, ModelApiCatalogService } from '../ModelApiCatalogService'

const originalGet = vi.mocked(application.get).getMockImplementation()!
const originalGetPath = vi.mocked(application.getPath).getMockImplementation()!
const probe = vi.fn(async () => ({ latency: 12 }))
const list = vi.fn<
  (
    providerId: string,
    options?: { signal?: AbortSignal; source?: 'configured' | 'provider_api' }
  ) => Promise<{
    models: Partial<Model>[]
    completeness: 'complete' | 'partial' | 'unsupported'
    source: 'provider_api' | 'registry'
  }>
>(async () => ({
  models: [{ apiModelId: 'Wire-Known' }],
  completeness: 'complete' as 'complete' | 'partial' | 'unsupported',
  source: 'provider_api' as 'provider_api' | 'registry'
}))
const ai = {
  fetchModelsDetailed: list,
  prepareResolvedModelCheck: ({ isCurrent }: { isCurrent: () => boolean }) => ({
    supportsChat: true,
    isExternalCli: false,
    isCurrent,
    checkConversation: probe
  })
}
const jsonFile = (body: Record<string, unknown>) => JSON.stringify({ ...body, version: registryContentVersion(body) })
const existingModel = (apiModelId: string): Model => ({
  id: createUniqueModelId('custom', apiModelId),
  providerId: 'custom',
  apiModelId,
  name: apiModelId,
  capabilities: [],
  supportsStreaming: false,
  isEnabled: false,
  isHidden: false
})

describe('ModelApiCatalogService discovery and paid verification contract', () => {
  const dbh = setupTestDatabase()
  let directory: string
  let service: ModelApiCatalogService
  beforeEach(() => {
    BaseService.resetInstances()
    MockMainPreferenceServiceUtils.resetMocks()
    probe.mockReset().mockResolvedValue({ latency: 12 })
    list
      .mockReset()
      .mockResolvedValue({ models: [{ apiModelId: 'Wire-Known' }], completeness: 'complete', source: 'provider_api' })
    directory = mkdtempSync(join(tmpdir(), 'model-api-catalog-'))
    writeFileSync(
      join(directory, 'models.json'),
      jsonFile({
        models: [
          {
            id: 'Wire-Known',
            name: 'Known metadata',
            capabilities: [],
            endpointTypes: [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]
          }
        ]
      })
    )
    writeFileSync(join(directory, 'provider-models.json'), jsonFile({ overrides: [] }))
    writeFileSync(join(directory, 'providers.json'), jsonFile({ providers: [] }))
    vi.mocked(application.getPath).mockImplementation((key, filename) =>
      key === 'feature.provider_registry.data'
        ? filename
          ? join(directory, filename)
          : directory
        : originalGetPath(key, filename)
    )
    vi.mocked(application.get).mockImplementation(((name: string) =>
      name === 'AiService' ? ai : originalGet(name as never)) as typeof application.get)
    providerRegistryService.clearCache()
    dbh.db
      .insert(userProviderTable)
      .values({
        providerId: 'custom',
        name: 'Custom',
        isEnabled: true,
        defaultChatEndpoint: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
        endpointConfigs: { [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://configured.example/v1' } },
        orderKey: generateOrderKeyBetween(null, null)
      })
      .run()
    service = new ModelApiCatalogService()
  })
  afterEach(() => {
    vi.mocked(application.get).mockImplementation(originalGet)
    vi.mocked(application.getPath).mockImplementation(originalGetPath)
    providerRegistryService.clearCache()
    rmSync(directory, { recursive: true, force: true })
  })

  it('requests API discovery for the bundled registry-only MAI provider without enabling or verifying new candidates', async () => {
    writeFileSync(join(directory, 'package.json'), readFileSync('package.json'))
    const catalogGetPath = vi.mocked(application.getPath).getMockImplementation()!
    vi.mocked(application.getPath).mockImplementation((key, filename) =>
      key === 'app.root' ? (filename ? join(directory, filename) : directory) : catalogGetPath(key, filename)
    )
    const bundled = JSON.parse(readFileSync('packages/provider-registry/data/providers.json', 'utf8')) as {
      providers: Array<{ id: string }>
    }
    writeFileSync(
      join(directory, 'providers.json'),
      jsonFile({ providers: bundled.providers.filter((row) => row.id === 'mai') })
    )
    providerRegistryService.clearCache()
    dbh.db
      .insert(userProviderTable)
      .values({
        providerId: 'mai',
        presetProviderId: 'mai',
        name: 'mai studio',
        isEnabled: true,
        orderKey: 'a1'
      })
      .run()
    expect(providerService.getByProviderId('mai').modelListSource).toBe('registry')
    list.mockImplementation(async (_providerId, options) =>
      options?.source === 'provider_api'
        ? { models: [{ apiModelId: 'Publisher/Exact.New.Case' }], completeness: 'complete', source: 'provider_api' }
        : { models: [{ apiModelId: 'registry-only' }], completeness: 'unsupported', source: 'registry' }
    )

    const state = await service.scan({ providerIds: ['mai'] })

    expect(state.report!.providers).toMatchObject([
      { providerId: 'mai', source: 'provider_api', completeness: 'complete' }
    ])
    expect(state.report!.candidates).toMatchObject([
      {
        providerId: 'mai',
        apiModelId: 'Publisher/Exact.New.Case',
        metadataSource: 'none',
        after: { isEnabled: false },
        verification: { status: 'pending' },
        applied: false
      }
    ])
    expect(dbh.db.select().from(userModelTable).all()).toEqual([])
    expect(probe).not.toHaveBeenCalled()
    expect(providerService.getByProviderId('mai').modelListSource).toBe('registry')
  })

  it('offers only configured built-in transports and requires an explicit adapter for native protocols', () => {
    expect(
      availableCatalogEndpoints({
        endpointConfigs: {
          [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://configured.example/v1' },
          [ENDPOINT_TYPE.OPENAI_RESPONSES]: { baseUrl: 'https://configured.example/v1' },
          [ENDPOINT_TYPE.ANTHROPIC_MESSAGES]: { baseUrl: 'https://native.example/v1' },
          [ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT]: { baseUrl: 'https://google.example/v1', adapterFamily: 'google' }
        }
      })
    ).toEqual([
      ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
      ENDPOINT_TYPE.OPENAI_RESPONSES,
      ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT
    ])
  })

  it('never infers capabilities or a protocol from an unknown model name', async () => {
    list.mockResolvedValue({
      models: [{ apiModelId: 'claude-opus-99-vision-thinking' }],
      completeness: 'complete',
      source: 'provider_api'
    })
    const state = await service.scan()
    const [candidate] = state.report!.candidates
    expect(candidate).toMatchObject({
      apiModelId: 'claude-opus-99-vision-thinking',
      metadataSource: 'none',
      capabilities: [],
      requiresManualEndpoint: true,
      after: { isEnabled: false }
    })
    await service.verify({ reportId: state.report!.id, candidateIds: [candidate.id] })
    expect(probe).not.toHaveBeenCalled()
    const verified = await service.verify({
      reportId: state.report!.id,
      candidateIds: [candidate.id],
      endpointType: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
    })
    expect(verified.report!.candidates[0].verification).toMatchObject({
      status: 'verified',
      conversation: 'passed',
      streaming: 'unknown',
      tools: 'unknown',
      vision: 'unknown',
      context: 'unknown'
    })
  })

  it('does not deprecate models for partial, unsupported, or failed listings', async () => {
    modelService.applyDiscoveredModels([
      { model: existingModel('existing'), change: 'new', expected: null, verified: true }
    ])
    for (const completeness of ['partial', 'unsupported'] as const) {
      list.mockResolvedValue({
        models: [],
        completeness,
        source: completeness === 'unsupported' ? 'registry' : 'provider_api'
      })
      expect((await service.scan()).report!.candidates).toEqual([])
    }
    list.mockRejectedValue(new Error('Private upstream detail'))
    expect((await service.scan()).report!.providers[0]).toMatchObject({
      completeness: 'failed',
      reason: 'listing_failed'
    })
    expect(dbh.db.select().from(userModelTable).get()?.isDeprecated).toBe(false)
  })

  it('keeps unknown discovered models sparse after persistence and never borrows a fuzzy registry match', async () => {
    writeFileSync(
      join(directory, 'models.json'),
      jsonFile({
        models: [
          {
            id: 'gpt-4o',
            name: 'Known sibling',
            ownedBy: 'openai',
            capabilities: ['function-call'],
            inputModalities: ['text', 'image'],
            contextWindow: 128000,
            endpointTypes: [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]
          }
        ]
      })
    )
    providerRegistryService.clearCache()
    list.mockResolvedValue({
      models: [{ apiModelId: 'gpt-4o-2024-08-06' }],
      completeness: 'complete',
      source: 'provider_api'
    })
    const scanned = await service.scan()
    const input = { reportId: scanned.report!.id, candidateIds: [scanned.report!.candidates[0].id] }
    expect(scanned.report!.candidates[0].metadataSource).toBe('none')
    service.apply(input)
    expect(dbh.db.select().from(userModelTable).get()).toMatchObject({
      discoverySource: 'provider-api',
      name: null,
      capabilities: null,
      contextWindow: null,
      pricing: null
    })
    const model = modelService.getByKey('custom', 'gpt-4o-2024-08-06')
    expect(model.capabilities).toEqual([])
    expect(model.inputModalities).toBeUndefined()
    expect(model.contextWindow).toBeUndefined()
    expect(model.pricing).toBeUndefined()
    expect(model.ownedBy).toBeUndefined()
    expect(model.reasoning).toBeUndefined()
    expect(model.isEnabled).toBe(false)
    modelService.update('custom', 'gpt-4o-2024-08-06', { name: 'My model', contextWindow: 2048 })
    expect(modelService.getByKey('custom', 'gpt-4o-2024-08-06')).toMatchObject({
      name: 'My model',
      contextWindow: 2048
    })
    writeFileSync(
      join(directory, 'models.json'),
      jsonFile({
        models: [
          {
            id: 'gpt-4o-2024-08-06',
            name: 'Exact metadata',
            capabilities: ['function-call'],
            contextWindow: 32768
          }
        ]
      })
    )
    providerRegistryService.clearCache()
    modelService.update('custom', 'gpt-4o-2024-08-06', { contextWindow: 32768, capabilities: ['function-call'] })
    expect(dbh.db.select().from(userModelTable).get()).toMatchObject({ contextWindow: null, capabilities: null })
    expect(modelService.getByKey('custom', 'gpt-4o-2024-08-06')).toMatchObject({
      name: 'My model',
      contextWindow: 32768,
      capabilities: ['function-call']
    })
  })

  it('inherits updated exact metadata through sparse rows while retaining user capability and context overrides', async () => {
    const scanned = await service.scan()
    service.apply({ reportId: scanned.report!.id, candidateIds: [scanned.report!.candidates[0].id] })
    const replaceMetadata = (name: string, contextWindow: number, capabilities: string[]) => {
      writeFileSync(
        join(directory, 'models.json'),
        jsonFile({
          models: [
            {
              id: 'Wire-Known',
              name,
              capabilities,
              contextWindow,
              endpointTypes: [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]
            }
          ]
        })
      )
      providerRegistryService.clearCache()
    }
    replaceMetadata('Registry revision two', 65536, ['function-call'])
    expect(modelService.getByKey('custom', 'Wire-Known')).toMatchObject({
      name: 'Registry revision two',
      contextWindow: 65536,
      capabilities: ['function-call'],
      supportsStreaming: false
    })
    modelService.update('custom', 'Wire-Known', { name: 'My name', contextWindow: 4096, capabilities: [] })
    replaceMetadata('Registry revision three', 131072, ['function-call', 'reasoning'])
    expect(modelService.getByKey('custom', 'Wire-Known')).toMatchObject({
      name: 'My name',
      contextWindow: 4096,
      capabilities: [],
      supportsStreaming: false
    })
  })

  it('enables only a successful current probe, applies selections once, and undoes the selected batch', async () => {
    const scanned = await service.scan()
    const id = scanned.report!.candidates[0].id
    const input = { reportId: scanned.report!.id, candidateIds: [id] }
    await service.verify(input)
    const applied = service.apply(input)
    expect(dbh.db.select().from(userModelTable).get()).toMatchObject({
      modelId: 'Wire-Known',
      isEnabled: true,
      supportsStreaming: false
    })
    const repeated = service.apply(input)
    expect(repeated.lastBatch?.id).toBe(applied.lastBatch?.id)
    expect(dbh.db.select().from(userModelTable).all()).toHaveLength(1)
    service.undo({ batchId: applied.lastBatch!.id })
    expect(dbh.db.select().from(userModelTable).all()).toEqual([])
  })

  it('rejects successful evidence after the provider destination or credential changes', async () => {
    const scanned = await service.scan()
    const input = { reportId: scanned.report!.id, candidateIds: [scanned.report!.candidates[0].id] }
    await service.verify(input)
    dbh.db
      .update(userProviderTable)
      .set({ apiKeys: [{ id: 'same-key-id', key: 'new-value', isEnabled: true }] })
      .where(eq(userProviderTable.providerId, 'custom'))
      .run()
    expect(service.read().report!.candidates[0].verification.status).toBe('stale')
    expect(() => service.apply(input)).toThrow('verification_stale')
    expect(dbh.db.select().from(userModelTable).all()).toEqual([])
  })

  it('discards a probe result when its settings change while the request is in flight', async () => {
    const scanned = await service.scan()
    const input = { reportId: scanned.report!.id, candidateIds: [scanned.report!.candidates[0].id] }
    probe.mockImplementation(async () => {
      dbh.db
        .update(userProviderTable)
        .set({
          endpointConfigs: { [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://changed.example/v1' } }
        })
        .run()
      return { latency: 12 }
    })
    const verified = await service.verify(input)
    expect(verified.report!.candidates[0]).toMatchObject({
      verification: { status: 'stale' },
      after: { isEnabled: false }
    })
    expect(() => service.apply(input)).toThrow('verification_stale')
  })

  it('applies only selected candidates and marks missing rows without deleting or disabling them', async () => {
    modelService.applyDiscoveredModels([
      { model: existingModel('missing'), change: 'new', expected: null, verified: true }
    ])
    const scanned = await service.scan()
    const candidate = scanned.report!.candidates.find((item) => item.change === 'missing')!
    service.apply({ reportId: scanned.report!.id, candidateIds: [candidate.id] })
    expect(dbh.db.select().from(userModelTable).all()).toMatchObject([
      { modelId: 'missing', isEnabled: true, isDeprecated: true }
    ])
    expect(service.read().report!.candidates.find((item) => item.change === 'new')?.applied).toBe(false)
  })

  it('does not retry or switch protocols after a failed probe in the same report', async () => {
    const scanned = await service.scan()
    const input = { reportId: scanned.report!.id, candidateIds: [scanned.report!.candidates[0].id] }
    probe.mockRejectedValue(new Error('Transport failed'))
    const failed = await service.verify(input)
    expect(failed.report!.candidates[0]).toMatchObject({
      endpointType: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
      verification: { status: 'failed' },
      after: { isEnabled: false }
    })
    await service.verify(input)
    expect(probe).toHaveBeenCalledTimes(1)
    service.apply(input)
    expect(dbh.db.select().from(userModelTable).get()?.isEnabled).toBe(false)
  })

  it('requires paid consent and caps an automatic round at three new candidates', async () => {
    await expect(
      service.policy({ policy: { discoveryEnabled: true, automaticVerifyEnabled: true, automaticApplyEnabled: true } })
    ).rejects.toThrow('paid_verification_confirmation_required')
    const names = ['Wire-Known', 'Second', 'Third', 'Fourth']
    writeFileSync(
      join(directory, 'models.json'),
      jsonFile({
        models: names.map((id) => ({
          id,
          name: id,
          capabilities: [],
          endpointTypes: [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]
        }))
      })
    )
    providerRegistryService.clearCache()
    list.mockResolvedValue({
      models: names.map((apiModelId) => ({ apiModelId })),
      completeness: 'complete',
      source: 'provider_api'
    })
    await service.policy({
      policy: { discoveryEnabled: true, automaticVerifyEnabled: true, automaticApplyEnabled: true },
      confirmPaidVerification: true
    })
    await service['runAutomaticScan']()
    expect(probe).toHaveBeenCalledTimes(3)
    expect(
      dbh.db
        .select()
        .from(userModelTable)
        .all()
        .map((row) => row.modelId)
    ).toEqual(['Wire-Known', 'Second', 'Third'])
    expect(service.read().report!.candidates.find((candidate) => candidate.apiModelId === 'Fourth')).toMatchObject({
      applied: false,
      verification: { status: 'pending' },
      after: { isEnabled: false }
    })
  })

  it('keeps automatic discovery free of probes when automatic verification is disabled', async () => {
    await service.policy({
      policy: { discoveryEnabled: true, automaticVerifyEnabled: false, automaticApplyEnabled: true }
    })
    await service['runAutomaticScan']()
    expect(probe).not.toHaveBeenCalled()
    expect(service.read().report!.candidates[0]).toMatchObject({ applied: false, verification: { status: 'pending' } })
    expect(dbh.db.select().from(userModelTable).all()).toEqual([])
  })

  it('cancels automatic application even after a provider completed the paid probe', async () => {
    const names = ['Wire-Known', 'Second']
    writeFileSync(
      join(directory, 'models.json'),
      jsonFile({
        models: names.map((id) => ({
          id,
          name: id,
          capabilities: [],
          endpointTypes: [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]
        }))
      })
    )
    providerRegistryService.clearCache()
    list.mockResolvedValue({
      models: names.map((apiModelId) => ({ apiModelId })),
      completeness: 'complete',
      source: 'provider_api'
    })
    probe.mockResolvedValueOnce({ latency: 12 }).mockImplementation(async () => {
      service.cancel()
      return { latency: 12 }
    })
    await service.policy({
      policy: { discoveryEnabled: true, automaticVerifyEnabled: true, automaticApplyEnabled: true },
      confirmPaidVerification: true
    })
    await service['runAutomaticScan']()
    expect(dbh.db.select().from(userModelTable).all()).toEqual([])
    expect(service.read().status).toBe('idle')
    expect(service.read().report!.candidates[1].verification.reason).toBe('canceled')
  })

  it('reuses current evidence and never automatically retries the same failed configuration', async () => {
    const names = ['Wire-Known', 'Second', 'Third', 'Fourth']
    writeFileSync(
      join(directory, 'models.json'),
      jsonFile({
        models: names.map((id) => ({
          id,
          name: id,
          capabilities: [],
          endpointTypes: [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]
        }))
      })
    )
    providerRegistryService.clearCache()
    list.mockResolvedValue({
      models: names.map((apiModelId) => ({ apiModelId })),
      completeness: 'complete',
      source: 'provider_api'
    })
    probe.mockRejectedValueOnce(new Error('Failed once')).mockResolvedValue({ latency: 12 })
    await service.policy({
      policy: { discoveryEnabled: true, automaticVerifyEnabled: true, automaticApplyEnabled: false },
      confirmPaidVerification: true
    })
    await service['runAutomaticScan']()
    await service['runAutomaticScan']()
    await service['runAutomaticScan']()
    expect(probe).toHaveBeenCalledTimes(4)
    expect(service.read().report!.candidates.map(({ verification }) => verification.status)).toEqual([
      'failed',
      'verified',
      'verified',
      'verified'
    ])
    expect(dbh.db.select().from(userModelTable).all()).toEqual([])
  })
})
