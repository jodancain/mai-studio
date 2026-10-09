import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useSharedCacheValue } from '@data/hooks/useCache'
import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import { download } from '@renderer/utils/download'
import {
  MODEL_API_DIAGNOSTICS_CACHE_KEY,
  type ModelApiDiagnosticsStartInput,
  type ModelApiDiagnosticsState
} from '@shared/types/modelApiDiagnostics'

const logger = loggerService.withContext('ModelApiDiagnostics')
const IDLE_STATE: ModelApiDiagnosticsState = {
  status: 'idle',
  runId: null,
  startedAt: null,
  expiresAt: null,
  completedProviders: 0,
  providers: []
}

export function useModelApiDiagnostics() {
  const { t } = useTranslation()
  const shared = useSharedCacheValue(MODEL_API_DIAGNOSTICS_CACHE_KEY)
  const [snapshot, setSnapshot] = useState<ModelApiDiagnosticsState>(IDLE_STATE)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const state = shared ?? snapshot

  const read = useCallback(async () => {
    try {
      setSnapshot(await ipcApi.request('model_api.diagnostics.read', {}))
      setReadFailed(false)
    } catch {
      setReadFailed(true)
    }
  }, [])

  useEffect(() => {
    void read()
  }, [read])

  const perform = useCallback(
    async (action: () => Promise<void>) => {
      setIsSubmitting(true)
      try {
        await action()
      } catch (error) {
        logger.warn('Diagnostic command failed', { errorType: error instanceof Error ? error.name : typeof error })
        toast.error(t('settings.model_api.operation_failed'))
      } finally {
        setIsSubmitting(false)
      }
    },
    [t]
  )

  const start = (input: ModelApiDiagnosticsStartInput) =>
    perform(async () => {
      const result = await ipcApi.request('model_api.diagnostics.start', input)
      setSnapshot(result.state)
      if (result.status === 'busy') toast.warning(t('settings.model_api.status_running'))
    })
  const cancel = () =>
    perform(async () => {
      if (!state.runId) return
      const result = await ipcApi.request('model_api.diagnostics.cancel', { runId: state.runId })
      setSnapshot(result.state)
    })
  const confirm = (providerId: string, requestId: string) =>
    perform(async () => {
      if (!state.runId) return
      const result = await ipcApi.request('model_api.diagnostics.confirm', {
        runId: state.runId,
        providerId,
        requestId
      })
      setSnapshot(result.state)
      if (result.status === 'stale') toast.warning(t('settings.model_api.status_stale'))
    })
  const exportReport = () =>
    perform(async () => {
      if (!state.runId) return
      const result = await ipcApi.request('model_api.diagnostics.export', { runId: state.runId })
      const url = URL.createObjectURL(new Blob([result.json], { type: 'application/json' }))
      try {
        await download(url, result.fileName)
      } finally {
        URL.revokeObjectURL(url)
      }
    })

  return { state, isSubmitting, readFailed, read, start, cancel, confirm, exportReport }
}
