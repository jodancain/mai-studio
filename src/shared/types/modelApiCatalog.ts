import type { EndpointType, ModelCapability } from '@shared/data/types/model'

export const MODEL_API_AUTOMATIC_VERIFY_LIMIT = 3

export type ModelApiCatalogPolicy = {
  discoveryEnabled: boolean
  automaticVerifyEnabled: boolean
  automaticApplyEnabled: boolean
}

export type ModelApiVerification = {
  status: 'pending' | 'verifying' | 'verified' | 'failed' | 'stale' | 'unsupported'
  checkedAt?: number
  latencyMs?: number
  reason?: string
  conversation: 'unknown' | 'passed' | 'failed'
  streaming: 'unknown'
  tools: 'unknown'
  vision: 'unknown'
  context: 'unknown'
}

export type ModelApiCatalogCandidate = {
  id: string
  providerId: string
  providerName: string
  apiModelId: string
  name: string
  change: 'new' | 'missing' | 'restored'
  source: 'provider_api'
  metadataSource: 'exact_registry' | 'none'
  capabilities: ModelCapability[]
  availableEndpoints: EndpointType[]
  endpointType?: EndpointType
  requiresManualEndpoint: boolean
  before?: { isEnabled: boolean; isDeprecated: boolean }
  after: { isEnabled: boolean; isDeprecated: boolean }
  verification: ModelApiVerification
  applied: boolean
}

export type ModelApiProviderScan = {
  providerId: string
  providerName: string
  completeness: 'complete' | 'partial' | 'unsupported' | 'failed'
  source: 'provider_api' | 'registry'
  discoveredCount: number
  reason?: string
}

export type ModelApiCatalogReport = {
  id: string
  scannedAt: number
  providers: ModelApiProviderScan[]
  candidates: ModelApiCatalogCandidate[]
}

export type ModelApiCatalogBatch = {
  id: string
  appliedAt: number
  candidateIds: string[]
  undoAvailable: boolean
  conflicts: string[]
}

export type ModelApiRegistryPreview = {
  id: string
  sourceRevision: number
  currentRevision: number | null
  checkedAt: number
  changes: Array<{ id: string; kind: 'model' | 'provider_model'; change: 'added' | 'updated' }>
  preservedCount: number
}

export type ModelApiCatalogState = {
  status: 'idle' | 'scanning' | 'verifying' | 'applying'
  policy: ModelApiCatalogPolicy
  automaticVerifyLimit: number
  report: ModelApiCatalogReport | null
  lastBatch: ModelApiCatalogBatch | null
  registryPreview: ModelApiRegistryPreview | null
  registryRollbackAvailable: boolean
}

export const DEFAULT_MODEL_API_CATALOG_STATE: ModelApiCatalogState = {
  status: 'idle',
  policy: { discoveryEnabled: false, automaticVerifyEnabled: false, automaticApplyEnabled: false },
  automaticVerifyLimit: MODEL_API_AUTOMATIC_VERIFY_LIMIT,
  report: null,
  lastBatch: null,
  registryPreview: null,
  registryRollbackAvailable: false
}
