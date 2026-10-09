import * as z from 'zod'

import { ENDPOINT_TYPE, MODEL_CAPABILITY, objectValues } from '@shared/data/types/model'

import { defineRoute } from '../define'

const endpointSchema = z.enum(objectValues(ENDPOINT_TYPE))
const policySchema = z.object({
  discoveryEnabled: z.boolean(),
  automaticVerifyEnabled: z.boolean(),
  automaticApplyEnabled: z.boolean()
})
const candidateSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  apiModelId: z.string(),
  name: z.string(),
  change: z.enum(['new', 'missing', 'restored']),
  source: z.literal('provider_api'),
  metadataSource: z.enum(['exact_registry', 'none']),
  capabilities: z.array(z.enum(objectValues(MODEL_CAPABILITY))),
  availableEndpoints: z.array(endpointSchema),
  endpointType: endpointSchema.optional(),
  requiresManualEndpoint: z.boolean(),
  before: z.object({ isEnabled: z.boolean(), isDeprecated: z.boolean() }).optional(),
  after: z.object({ isEnabled: z.boolean(), isDeprecated: z.boolean() }),
  verification: z.object({
    status: z.enum(['pending', 'verifying', 'verified', 'failed', 'stale', 'unsupported']),
    checkedAt: z.number().optional(),
    latencyMs: z.number().optional(),
    reason: z.string().optional(),
    conversation: z.enum(['unknown', 'passed', 'failed']),
    streaming: z.literal('unknown'),
    tools: z.literal('unknown'),
    vision: z.literal('unknown'),
    context: z.literal('unknown')
  }),
  applied: z.boolean()
})
export const modelApiCatalogStateSchema = z.object({
  status: z.enum(['idle', 'scanning', 'verifying', 'applying']),
  policy: policySchema,
  automaticVerifyLimit: z.number(),
  report: z
    .object({
      id: z.string(),
      scannedAt: z.number(),
      candidates: z.array(candidateSchema),
      providers: z.array(
        z.object({
          providerId: z.string(),
          providerName: z.string(),
          completeness: z.enum(['complete', 'partial', 'unsupported', 'failed']),
          source: z.enum(['provider_api', 'registry']),
          discoveredCount: z.number(),
          reason: z.string().optional()
        })
      )
    })
    .nullable(),
  lastBatch: z
    .object({
      id: z.string(),
      appliedAt: z.number(),
      candidateIds: z.array(z.string()),
      undoAvailable: z.boolean(),
      conflicts: z.array(z.string())
    })
    .nullable(),
  registryPreview: z
    .object({
      id: z.string(),
      sourceRevision: z.number(),
      currentRevision: z.number().nullable(),
      checkedAt: z.number(),
      changes: z.array(
        z.object({ id: z.string(), kind: z.enum(['model', 'provider_model']), change: z.enum(['added', 'updated']) })
      ),
      preservedCount: z.number()
    })
    .nullable(),
  registryRollbackAvailable: z.boolean()
})

export const modelApiCatalogRequestSchemas = {
  'model_api.catalog.read': defineRoute({ input: z.object({}).strict(), output: modelApiCatalogStateSchema }),
  'model_api.catalog.scan': defineRoute({
    input: z.object({ providerIds: z.array(z.string().min(1)).max(100).optional() }).strict(),
    output: modelApiCatalogStateSchema
  }),
  'model_api.catalog.verify': defineRoute({
    input: z
      .object({
        reportId: z.string(),
        candidateIds: z.array(z.string()).min(1).max(20),
        endpointType: endpointSchema.optional()
      })
      .strict(),
    output: modelApiCatalogStateSchema
  }),
  'model_api.catalog.apply': defineRoute({
    input: z.object({ reportId: z.string(), candidateIds: z.array(z.string()).min(1).max(500) }).strict(),
    output: modelApiCatalogStateSchema
  }),
  'model_api.catalog.undo': defineRoute({
    input: z.object({ batchId: z.string() }).strict(),
    output: modelApiCatalogStateSchema
  }),
  'model_api.catalog.cancel': defineRoute({ input: z.object({}).strict(), output: modelApiCatalogStateSchema }),
  'model_api.catalog.policy': defineRoute({
    input: z.object({ policy: policySchema, confirmPaidVerification: z.boolean().optional() }).strict(),
    output: modelApiCatalogStateSchema
  }),
  'model_api.registry.preview': defineRoute({ input: z.object({}).strict(), output: modelApiCatalogStateSchema }),
  'model_api.registry.apply': defineRoute({
    input: z.object({ previewId: z.string() }).strict(),
    output: modelApiCatalogStateSchema
  }),
  'model_api.registry.rollback': defineRoute({ input: z.object({}).strict(), output: modelApiCatalogStateSchema })
}
