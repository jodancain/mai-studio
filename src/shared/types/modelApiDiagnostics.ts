import type { EndpointType, UniqueModelId } from '../data/types/model'

export const MODEL_API_DIAGNOSTICS_CACHE_KEY = 'model_api.diagnostics' as const
export const MODEL_API_PROBE_KINDS = ['conversation', 'streaming', 'tools'] as const
export type ModelApiProbeKind = (typeof MODEL_API_PROBE_KINDS)[number]
export type ModelApiDiagnosticLayer = 'connection' | 'auth' | 'model_list' | 'inference' | 'stream' | 'tools'
export type ModelApiDiagnosticStatus =
  | 'unverified'
  | 'pending'
  | 'running'
  | 'pass'
  | 'warn'
  | 'fail'
  | 'skip'
  | 'error'

export interface ModelApiDiagnosticResult {
  readonly layer: ModelApiDiagnosticLayer
  readonly status: ModelApiDiagnosticStatus
  readonly code?: string
  readonly category?: string
  readonly httpStatus?: number
  readonly durationMs?: number
}

export interface ModelApiDiagnosticConfirmation {
  readonly requestId: string
  readonly kind: ModelApiProbeKind
  readonly maxOutputTokens: 64
  readonly timeoutMs: 15000
}

export interface ModelApiProviderDiagnostics {
  readonly providerId: string
  readonly providerName: string
  readonly uniqueModelId?: UniqueModelId
  readonly modelName?: string
  readonly endpoint?: string
  readonly endpointType?: EndpointType
  readonly totalModelCount: number
  readonly testedModelCount: 0 | 1
  readonly status: 'queued' | 'running' | 'awaiting_confirmation' | 'completed' | 'canceled' | 'stale' | 'skipped'
  readonly layers: readonly ModelApiDiagnosticResult[]
  readonly pendingChecks: readonly ModelApiDiagnosticConfirmation[]
}

export interface ModelApiDiagnosticsState {
  readonly status: 'idle' | 'running' | 'awaiting_confirmation' | 'completed' | 'canceled' | 'expired'
  readonly runId: string | null
  readonly startedAt: string | null
  readonly expiresAt: string | null
  readonly completedProviders: number
  readonly providers: readonly ModelApiProviderDiagnostics[]
}

export const INITIAL_MODEL_API_DIAGNOSTICS_STATE: ModelApiDiagnosticsState = {
  status: 'idle',
  runId: null,
  startedAt: null,
  expiresAt: null,
  completedProviders: 0,
  providers: []
}

export interface ModelApiDiagnosticsStartInput {
  readonly providerIds: string[]
  readonly modelSelections?: UniqueModelId[]
  readonly checks?: ModelApiProbeKind[]
}

export type ModelApiDiagnosticsCommandResult = {
  readonly status: 'started' | 'completed' | 'busy' | 'canceled' | 'stale' | 'not_running'
  readonly state: ModelApiDiagnosticsState
}

export interface ModelApiDiagnosticsExport {
  readonly fileName: string
  readonly json: string
}
