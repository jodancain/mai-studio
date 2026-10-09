import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useSharedCacheValue } from '@data/hooks/useCache'
import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import type { EndpointType } from '@shared/data/types/model'
import {
  DEFAULT_MODEL_API_CATALOG_STATE,
  type ModelApiCatalogPolicy,
  type ModelApiCatalogState
} from '@shared/types/modelApiCatalog'

const logger = loggerService.withContext('ModelApiCatalog')

export function useModelApiCatalog() {
  const { t } = useTranslation()
  const shared = useSharedCacheValue('model_api.catalog')
  const [snapshot, setSnapshot] = useState<ModelApiCatalogState>(DEFAULT_MODEL_API_CATALOG_STATE)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const state = shared ?? snapshot
  const read = useCallback(async () => {
    try {
      setSnapshot(await ipcApi.request('model_api.catalog.read', {}))
      setReadFailed(false)
    } catch {
      setReadFailed(true)
    }
  }, [])
  useEffect(() => {
    void read()
  }, [read])

  const perform = useCallback(
    async (action: () => Promise<ModelApiCatalogState>) => {
      setIsSubmitting(true)
      try {
        setSnapshot(await action())
      } catch (error) {
        logger.warn('Catalog command failed', { errorType: error instanceof Error ? error.name : typeof error })
        toast.error(t('settings.model_api.operation_failed'))
      } finally {
        setIsSubmitting(false)
      }
    },
    [t]
  )

  return {
    state,
    isSubmitting,
    readFailed,
    read,
    scan: (providerIds: string[]) => perform(() => ipcApi.request('model_api.catalog.scan', { providerIds })),
    apply: (candidateIds: string[]) =>
      perform(() => ipcApi.request('model_api.catalog.apply', { reportId: state.report!.id, candidateIds })),
    undo: () => perform(() => ipcApi.request('model_api.catalog.undo', { batchId: state.lastBatch!.id })),
    cancel: () => perform(() => ipcApi.request('model_api.catalog.cancel', {})),
    verify: (candidateIds: string[], endpointType?: EndpointType) =>
      perform(() =>
        ipcApi.request('model_api.catalog.verify', {
          reportId: state.report!.id,
          candidateIds,
          ...(endpointType ? { endpointType } : {})
        })
      ),
    setPolicy: (policy: ModelApiCatalogPolicy, confirmPaidVerification?: boolean) =>
      perform(() =>
        ipcApi.request('model_api.catalog.policy', {
          policy,
          ...(confirmPaidVerification ? { confirmPaidVerification } : {})
        })
      ),
    previewRegistry: () => perform(() => ipcApi.request('model_api.registry.preview', {})),
    applyRegistry: () =>
      perform(() => ipcApi.request('model_api.registry.apply', { previewId: state.registryPreview!.id })),
    rollbackRegistry: () => perform(() => ipcApi.request('model_api.registry.rollback', {}))
  }
}

export type ModelApiCatalogController = ReturnType<typeof useModelApiCatalog>
