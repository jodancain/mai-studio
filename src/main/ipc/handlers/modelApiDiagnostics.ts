import { application } from '@application'
import type { modelApiDiagnosticsRequestSchemas } from '@shared/ipc/schemas/modelApiDiagnostics'
import type { IpcHandlersFor } from '@shared/ipc/types'

export const modelApiDiagnosticsHandlers: IpcHandlersFor<typeof modelApiDiagnosticsRequestSchemas> = {
  'model_api.diagnostics.start': async (input) => application.get('ModelApiDiagnosticsService').start(input),
  'model_api.diagnostics.read': async () => application.get('ModelApiDiagnosticsService').read(),
  'model_api.diagnostics.confirm': async (input) => application.get('ModelApiDiagnosticsService').confirm(input),
  'model_api.diagnostics.cancel': async (input) => application.get('ModelApiDiagnosticsService').cancel(input),
  'model_api.diagnostics.export': async (input) => application.get('ModelApiDiagnosticsService').export(input)
}
