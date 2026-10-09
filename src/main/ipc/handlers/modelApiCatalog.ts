import { application } from '@application'
import type { modelApiCatalogRequestSchemas } from '@shared/ipc/schemas/modelApiCatalog'
import type { IpcHandlersFor } from '@shared/ipc/types'

export const modelApiCatalogHandlers: IpcHandlersFor<typeof modelApiCatalogRequestSchemas> = {
  'model_api.catalog.read': async () => application.get('ModelApiCatalogService').read(),
  'model_api.catalog.scan': async (input) => application.get('ModelApiCatalogService').scan(input),
  'model_api.catalog.verify': async (input) => application.get('ModelApiCatalogService').verify(input),
  'model_api.catalog.apply': async (input) => application.get('ModelApiCatalogService').apply(input),
  'model_api.catalog.undo': async (input) => application.get('ModelApiCatalogService').undo(input),
  'model_api.catalog.cancel': async () => application.get('ModelApiCatalogService').cancel(),
  'model_api.catalog.policy': async (input) => application.get('ModelApiCatalogService').policy(input),
  'model_api.registry.preview': async () => application.get('ModelApiCatalogService').registryPreview(),
  'model_api.registry.apply': async (input) => application.get('ModelApiCatalogService').registryApply(input),
  'model_api.registry.rollback': async () => application.get('ModelApiCatalogService').registryRollback()
}
