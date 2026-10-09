import * as z from 'zod'

import { UniqueModelIdSchema } from '@shared/data/types/model'
import {
  MODEL_API_PROBE_KINDS,
  type ModelApiDiagnosticsCommandResult,
  type ModelApiDiagnosticsExport,
  type ModelApiDiagnosticsState
} from '@shared/types/modelApiDiagnostics'

import { defineRoute } from '../define'

export const modelApiDiagnosticsRequestSchemas = {
  'model_api.diagnostics.start': defineRoute({
    input: z.strictObject({
      providerIds: z.array(z.string().min(1)).min(1).max(50),
      modelSelections: z.array(UniqueModelIdSchema).max(50).optional(),
      checks: z.array(z.enum(MODEL_API_PROBE_KINDS)).max(3).optional()
    }),
    output: z.custom<ModelApiDiagnosticsCommandResult>()
  }),
  'model_api.diagnostics.read': defineRoute({
    input: z.strictObject({}),
    output: z.custom<ModelApiDiagnosticsState>()
  }),
  'model_api.diagnostics.confirm': defineRoute({
    input: z.strictObject({ runId: z.uuid(), providerId: z.string().min(1), requestId: z.uuid() }),
    output: z.custom<ModelApiDiagnosticsCommandResult>()
  }),
  'model_api.diagnostics.cancel': defineRoute({
    input: z.strictObject({ runId: z.uuid() }),
    output: z.custom<ModelApiDiagnosticsCommandResult>()
  }),
  'model_api.diagnostics.export': defineRoute({
    input: z.strictObject({ runId: z.uuid() }),
    output: z.custom<ModelApiDiagnosticsExport>()
  })
}
