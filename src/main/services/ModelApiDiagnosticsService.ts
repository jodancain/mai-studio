import { randomUUID } from 'node:crypto'

import { application } from '@application'
import { BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { modelService } from '@main/data/services/ModelService'
import { providerService } from '@main/data/services/ProviderService'
import { parseUniqueModelId } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import {
  DOCTOR_REPORT_TTL_MS,
  type DoctorCheckId,
  type DoctorExecutionSnapshot,
  type DoctorScopeKey
} from '@shared/types/doctor'
import {
  INITIAL_MODEL_API_DIAGNOSTICS_STATE,
  MODEL_API_DIAGNOSTICS_CACHE_KEY,
  type ModelApiDiagnosticLayer,
  type ModelApiDiagnosticResult,
  type ModelApiDiagnosticsCommandResult,
  type ModelApiDiagnosticsExport,
  type ModelApiDiagnosticsStartInput,
  type ModelApiDiagnosticsState,
  type ModelApiProbeKind,
  type ModelApiProviderDiagnostics
} from '@shared/types/modelApiDiagnostics'
import { doctorScopeKey } from '@shared/utils/doctor'
import { isErrorCategory } from '@shared/utils/errorCategory'
import { isNonChatModel } from '@shared/utils/model'

import type { AiService } from '../ai/AiService'

const PROBE_CHECK: Record<ModelApiProbeKind, DoctorCheckId> = {
  conversation: 'provider-model-conversation',
  streaming: 'provider-model-streaming',
  tools: 'provider-model-tools'
}
const CHECK_LAYER: Partial<Record<DoctorCheckId, ModelApiDiagnosticLayer>> = {
  'network-model-endpoint': 'connection',
  'provider-model-list': 'model_list',
  'provider-model-conversation': 'inference',
  'provider-model-streaming': 'stream',
  'provider-model-tools': 'tools'
}
const LAYERS: readonly ModelApiDiagnosticLayer[] = ['connection', 'auth', 'model_list', 'inference', 'stream', 'tools']
type Target = ReturnType<AiService['prepareModelCheck']>
type ProviderRun = { target: Target; scope: DoctorScopeKey; runId: string; confirming: boolean }

function credentialReadiness(provider: Provider): ModelApiDiagnosticResult {
  if (provider.authOptional) return { layer: 'auth', status: 'unverified', code: 'credential_optional' }
  const configured =
    provider.authType === 'api-key' || provider.authType === 'api-key-aws'
      ? provider.apiKeys.some((key) => key.isEnabled)
      : providerService.getAuthConfig(provider.id) !== null
  return {
    layer: 'auth',
    status: configured ? 'unverified' : 'warn',
    code: configured ? 'credential_configured' : 'credential_missing'
  }
}

function projectSnapshot(
  row: ModelApiProviderDiagnostics,
  snapshot: DoctorExecutionSnapshot
): ModelApiProviderDiagnostics {
  const results = new Map(row.layers.map((result) => [result.layer, result]))
  let tested = row.testedModelCount
  for (const result of snapshot.results) {
    const layer = CHECK_LAYER[result.id]
    if (!layer) continue
    const categoryValue = result.evidence?.find((item) => item.key === 'category' && item.dataClass === 'public')?.value
    const category = isErrorCategory(categoryValue) ? categoryValue : undefined
    const statusValue = result.evidence?.find((item) => item.key === 'httpStatus' && item.dataClass === 'public')?.value
    const httpStatus = typeof statusValue === 'number' ? statusValue : undefined
    results.set(layer, {
      layer,
      status: result.status,
      durationMs: result.durationMs,
      code: 'detail' in result ? result.detail?.variant : result.status === 'error' ? 'request_failed' : undefined,
      category,
      httpStatus
    })
    if (['inference', 'stream', 'tools'].includes(layer) && result.status !== 'skip') tested = 1
    if (layer !== 'connection' && (httpStatus === 401 || httpStatus === 403)) {
      results.set('auth', { layer: 'auth', status: 'fail', code: 'credential_rejected', category, httpStatus })
    } else if (['inference', 'stream', 'tools'].includes(layer)) {
      if (result.status === 'pass') results.set('auth', { layer: 'auth', status: 'pass', code: 'credential_verified' })
    }
  }
  const pendingChecks = snapshot.pendingChecks.flatMap((pending) => {
    const kind = (Object.keys(PROBE_CHECK) as ModelApiProbeKind[]).find((kind) => PROBE_CHECK[kind] === pending.checkId)
    if (!kind) return []
    const layer = CHECK_LAYER[pending.checkId]!
    results.set(layer, { layer, status: 'pending' })
    return [{ requestId: pending.requestId, kind, maxOutputTokens: 64 as const, timeoutMs: 15000 as const }]
  })
  return {
    ...row,
    testedModelCount: tested,
    layers: LAYERS.map((layer) => results.get(layer)!),
    pendingChecks,
    status: pendingChecks.length ? 'awaiting_confirmation' : 'completed'
  }
}

@Injectable('ModelApiDiagnosticsService')
@ServicePhase(Phase.WhenReady)
@DependsOn(['DoctorService', 'AiService'])
export class ModelApiDiagnosticsService extends BaseService {
  private reportState: ModelApiDiagnosticsState = INITIAL_MODEL_API_DIAGNOSTICS_STATE
  private readonly providerRuns = new Map<string, ProviderRun>()

  protected override onReady(): void {
    this.registerInterval(() => {
      this.read()
    }, 60000)
  }

  protected override onStop(): void {
    if (this.reportState.runId) this.cancel({ runId: this.reportState.runId })
  }

  private publish(): void {
    application.get('CacheService').setShared(MODEL_API_DIAGNOSTICS_CACHE_KEY, this.reportState)
  }

  private update(providerId: string, row: ModelApiProviderDiagnostics): void {
    const providers = this.reportState.providers.map((current) => (current.providerId === providerId ? row : current))
    const active = providers.some((provider) => provider.status === 'queued' || provider.status === 'running')
    const pending = providers.some((provider) => provider.pendingChecks.length > 0)
    this.reportState = {
      ...this.reportState,
      providers,
      completedProviders: providers.filter((provider) => !['queued', 'running'].includes(provider.status)).length,
      status: active ? 'running' : pending ? 'awaiting_confirmation' : 'completed'
    }
    this.publish()
  }

  read(): ModelApiDiagnosticsState {
    if (
      this.reportState.expiresAt &&
      Date.parse(this.reportState.expiresAt) <= Date.now() &&
      ['running', 'awaiting_confirmation', 'completed'].includes(this.reportState.status)
    ) {
      this.invalidate('expired')
    }
    if (['canceled', 'expired'].includes(this.reportState.status)) return this.reportState
    for (const [providerId, run] of this.providerRuns) {
      const row = this.reportState.providers.find((provider) => provider.providerId === providerId)
      if (row && !['canceled', 'stale'].includes(row.status) && !run.target.isCurrent()) {
        application.get('DoctorService').cancelConnectivity(run.scope, run.runId)
        this.update(providerId, {
          ...row,
          status: 'stale',
          pendingChecks: [],
          layers: row.layers.map((layer) =>
            ['pending', 'running'].includes(layer.status)
              ? { layer: layer.layer, status: 'unverified', code: 'configuration_changed' }
              : layer
          )
        })
      }
    }
    return this.reportState
  }

  start(input: ModelApiDiagnosticsStartInput): ModelApiDiagnosticsCommandResult {
    this.read()
    if (this.reportState.status === 'running') return { status: 'busy', state: this.reportState }
    if (this.reportState.runId) this.invalidate('canceled')
    this.providerRuns.clear()
    const runId = randomUUID()
    const checks = [...new Set(input.checks ?? [])]
    const providers = [...new Set(input.providerIds)].map((providerId): ModelApiProviderDiagnostics => {
      const provider = providerService.getByProviderId(providerId)
      const models = modelService.list({ providerId })
      const selected = input.modelSelections?.find((id) => parseUniqueModelId(id).providerId === providerId)
      const model = selected
        ? models.find((model) => model.id === selected)
        : (models.find(
            (model) => model.isEnabled && !model.isHidden && !model.isDeprecated && !isNonChatModel(model)
          ) ??
          models.find((model) => model.isEnabled && !model.isHidden && !model.isDeprecated) ??
          models.find((model) => !model.isHidden && !model.isDeprecated))
      if (selected && !model) throw new Error('Selected diagnostic model is unavailable')
      const layers = LAYERS.map(
        (layer): ModelApiDiagnosticResult =>
          layer === 'auth' ? credentialReadiness(provider) : { layer, status: 'unverified' }
      )
      if (!model)
        return {
          providerId,
          providerName: provider.name,
          totalModelCount: models.length,
          testedModelCount: 0,
          status: 'skipped',
          layers: layers.map((layer) => ({ ...layer, status: 'skip', code: 'no_model' })),
          pendingChecks: []
        }
      const target = application.get('AiService').prepareModelCheck(model.id)
      if (target.isExternalCli)
        return {
          providerId,
          providerName: provider.name,
          uniqueModelId: model.id,
          modelName: model.name,
          totalModelCount: models.length,
          testedModelCount: 0,
          status: 'skipped',
          pendingChecks: [],
          layers: LAYERS.map((layer) => ({ layer, status: 'skip', code: 'external_cli' }))
        }
      const scope = doctorScopeKey({ kind: 'chat', ...parseUniqueModelId(model.id) })
      this.providerRuns.set(providerId, { target, scope, runId: randomUUID(), confirming: false })
      let endpoint: string | undefined
      try {
        endpoint = new URL(target.baseUrl).host
      } catch {
        /* An unconfigured endpoint has no host. */
      }
      return {
        providerId,
        providerName: provider.name,
        uniqueModelId: model.id,
        modelName: model.name,
        endpoint,
        endpointType: target.endpointType,
        totalModelCount: models.length,
        testedModelCount: 0,
        status: 'queued',
        layers,
        pendingChecks: []
      }
    })
    this.reportState = {
      status: 'running',
      runId,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + DOCTOR_REPORT_TTL_MS).toISOString(),
      completedProviders: 0,
      providers
    }
    this.publish()
    void this.runProviders(runId, checks)
    return { status: 'started', state: this.reportState }
  }

  private async runProviders(runId: string, checks: readonly ModelApiProbeKind[]): Promise<void> {
    const pending = this.reportState.providers.filter((row) => row.status === 'queued').map((row) => row.providerId)
    await Promise.all(
      Array.from({ length: Math.min(3, pending.length) }, async () => {
        let providerId: string | undefined
        while ((providerId = pending.shift()) !== undefined) {
          if (this.reportState.runId !== runId || ['canceled', 'expired'].includes(this.reportState.status)) return
          const run = this.providerRuns.get(providerId)!
          const row = this.reportState.providers.find((row) => row.providerId === providerId)!
          if (row.status !== 'queued') continue
          if (!run.target.isCurrent()) {
            this.update(providerId, { ...row, status: 'stale', pendingChecks: [] })
            continue
          }
          this.update(providerId, { ...row, status: 'running' })
          try {
            const result = await application.get('DoctorService').checkConnectivity({
              subject: { kind: 'chat', ...parseUniqueModelId(row.uniqueModelId!) },
              runId: run.runId,
              checkIds: ['network-model-endpoint', 'provider-model-list', ...checks.map((kind) => PROBE_CHECK[kind])]
            })
            if (this.reportState.runId !== runId || ['canceled', 'expired'].includes(this.reportState.status)) return
            const current = this.reportState.providers.find((row) => row.providerId === providerId)!
            if (!run.target.isCurrent() || current.status === 'stale') {
              application.get('DoctorService').cancelConnectivity(run.scope, run.runId)
              this.update(providerId, { ...current, status: 'stale', pendingChecks: [] })
            } else if (result.status === 'completed') this.update(providerId, projectSnapshot(current, result.report))
            else
              this.update(providerId, {
                ...current,
                status: result.status === 'canceled' ? 'canceled' : 'completed',
                layers: current.layers.map((layer) => ({ ...layer, status: 'unverified', code: result.status }))
              })
          } catch {
            if (this.reportState.runId === runId && !['canceled', 'expired'].includes(this.reportState.status)) {
              this.update(providerId, {
                ...row,
                status: 'completed',
                layers: row.layers.map((layer) =>
                  layer.layer === 'connection'
                    ? { layer: 'connection', status: 'error', code: 'request_failed' }
                    : layer
                )
              })
            }
          }
        }
      })
    )
    if (
      this.reportState.runId === runId &&
      this.reportState.status === 'running' &&
      pending.length === 0 &&
      this.reportState.providers.every((row) => row.status !== 'running' && row.status !== 'queued')
    ) {
      this.reportState = {
        ...this.reportState,
        completedProviders: this.reportState.providers.length,
        status: this.reportState.providers.some((row) => row.pendingChecks.length)
          ? 'awaiting_confirmation'
          : 'completed'
      }
      this.publish()
    }
  }

  async confirm(input: {
    runId: string
    providerId: string
    requestId: string
  }): Promise<ModelApiDiagnosticsCommandResult> {
    this.read()
    const run = this.providerRuns.get(input.providerId)
    const row = this.reportState.providers.find((row) => row.providerId === input.providerId)
    if (
      input.runId !== this.reportState.runId ||
      !run ||
      !row ||
      !row.pendingChecks.some((check) => check.requestId === input.requestId)
    ) {
      return { status: 'stale', state: this.reportState }
    }
    if (run.confirming) return { status: 'busy', state: this.reportState }
    run.confirming = true
    const kind = row.pendingChecks.find((check) => check.requestId === input.requestId)!.kind
    this.update(input.providerId, {
      ...row,
      status: 'running',
      layers: row.layers.map((layer) =>
        layer.layer === CHECK_LAYER[PROBE_CHECK[kind]] ? { layer: layer.layer, status: 'running' } : layer
      )
    })
    try {
      const result = await application
        .get('DoctorService')
        .confirmCheck({ scope: run.scope, runId: run.runId, requestId: input.requestId })
      if (this.reportState.runId !== input.runId || ['canceled', 'expired'].includes(this.reportState.status))
        return { status: 'canceled', state: this.reportState }
      const current = this.reportState.providers.find((row) => row.providerId === input.providerId)!
      if (!run.target.isCurrent() || current.status === 'stale' || result.status === 'stale') {
        application.get('DoctorService').cancelConnectivity(run.scope, run.runId)
        this.update(input.providerId, { ...current, status: 'stale', pendingChecks: [] })
        return { status: 'stale', state: this.reportState }
      }
      if (result.status === 'completed') this.update(input.providerId, projectSnapshot(current, result))
      else
        this.update(input.providerId, {
          ...current,
          status: result.status === 'canceled' ? 'canceled' : 'awaiting_confirmation'
        })
      return { status: result.status, state: this.reportState }
    } catch {
      if (this.reportState.runId === input.runId && !['canceled', 'expired'].includes(this.reportState.status)) {
        const current = this.reportState.providers.find((row) => row.providerId === input.providerId)!
        this.update(input.providerId, {
          ...current,
          status: 'completed',
          pendingChecks: [],
          layers: current.layers.map((layer) =>
            layer.status === 'running'
              ? { layer: layer.layer, status: 'error', code: 'request_failed' }
              : layer.status === 'pending'
                ? { layer: layer.layer, status: 'unverified', code: 'request_failed' }
                : layer
          )
        })
        application.get('DoctorService').cancelConnectivity(run.scope, run.runId)
      }
      return {
        status:
          this.reportState.status === 'canceled'
            ? 'canceled'
            : this.reportState.status === 'expired'
              ? 'stale'
              : 'completed',
        state: this.reportState
      }
    } finally {
      run.confirming = false
    }
  }

  private invalidate(status: 'canceled' | 'expired'): void {
    for (const run of this.providerRuns.values())
      application.get('DoctorService').cancelConnectivity(run.scope, run.runId)
    this.reportState = {
      ...this.reportState,
      status,
      providers: this.reportState.providers.map((row) => ({
        ...row,
        status: ['queued', 'running', 'awaiting_confirmation'].includes(row.status) ? 'canceled' : row.status,
        pendingChecks: [],
        layers: row.layers.map((layer) =>
          ['running', 'pending'].includes(layer.status)
            ? { layer: layer.layer, status: 'unverified', code: status }
            : layer
        )
      }))
    }
    this.publish()
  }

  cancel(input: { runId: string }): ModelApiDiagnosticsCommandResult {
    if (
      this.reportState.runId !== input.runId ||
      !['running', 'awaiting_confirmation'].includes(this.reportState.status)
    ) {
      return { status: 'not_running', state: this.reportState }
    }
    this.invalidate('canceled')
    return { status: 'canceled', state: this.reportState }
  }

  export(input: { runId: string }): ModelApiDiagnosticsExport {
    this.read()
    if (this.reportState.runId !== input.runId) throw new Error('Diagnostic report is stale')
    const { providers, ...summary } = this.reportState
    return {
      fileName: `model-api-diagnostics-${input.runId}.json`,
      json: JSON.stringify(
        {
          schemaVersion: 1,
          ...summary,
          providers: providers.map((provider) => ({
            providerId: provider.providerId,
            providerName: provider.providerName,
            uniqueModelId: provider.uniqueModelId,
            modelName: provider.modelName,
            endpoint: provider.endpoint,
            endpointType: provider.endpointType,
            totalModelCount: provider.totalModelCount,
            testedModelCount: provider.testedModelCount,
            status: provider.status,
            layers: provider.layers
          }))
        },
        null,
        2
      )
    }
  }
}
