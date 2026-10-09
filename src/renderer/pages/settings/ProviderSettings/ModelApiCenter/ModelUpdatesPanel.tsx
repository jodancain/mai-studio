import { ChevronRight, RefreshCw, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState
} from '@cherrystudio/ui'

import { CenterHeader, CenterNotice, CenterPanel, CenterStatus } from './modelApiUi'
import type { ModelApiCatalogController } from './useModelApiCatalog'

export default function ModelUpdatesPanel({
  catalog,
  providerIds
}: {
  catalog: ModelApiCatalogController
  providerIds: string[]
}) {
  const { t } = useTranslation()
  const { state } = catalog
  const [selected, setSelected] = useState<string[]>([])
  const [detailId, setDetailId] = useState<string | null>(null)
  const busy = catalog.isSubmitting || state.status !== 'idle'
  const candidates = state.report?.candidates ?? []
  const detail = candidates.find((candidate) => candidate.id === detailId)
  const selectable = candidates.filter((candidate) => !candidate.applied)
  const chosen = selected.filter((id) => selectable.some((candidate) => candidate.id === id))
  const allSelected = selectable.length > 0 && chosen.length === selectable.length
  const reportId = state.report?.id
  useEffect(() => {
    setSelected([])
  }, [reportId])

  return (
    <>
      <CenterHeader title={t('settings.model_api.updates')} description={t('settings.model_api.updates_description')}>
        <Button disabled={busy || providerIds.length === 0} size="sm" onClick={() => void catalog.scan(providerIds)}>
          <RefreshCw className="size-4" />
          {t('settings.model_api.scan')}
        </Button>
        {state.status !== 'idle' ? (
          <Button variant="outline" size="sm" onClick={() => void catalog.cancel()}>
            {t('common.cancel')}
          </Button>
        ) : null}
      </CenterHeader>
      {catalog.readFailed ? (
        <CenterNotice warning>
          <div className="flex items-center gap-2">
            {t('settings.model_api.operation_failed')}
            <Button variant="link" size="sm" onClick={() => void catalog.read()}>
              {t('common.retry')}
            </Button>
          </div>
        </CenterNotice>
      ) : null}
      <div className="mb-4 grid grid-cols-2 gap-4">
        <CenterPanel className="p-4">
          <h2 className="font-medium">{t('settings.model_api.provider_source')}</h2>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">{t('settings.model_api.provider_source_hint')}</p>
          <CenterStatus status={state.status === 'scanning' ? 'running' : state.report ? 'completed' : 'unverified'} />
        </CenterPanel>
        <CenterPanel className="p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-medium">{t('settings.model_api.registry_source')}</h2>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void catalog.previewRegistry()}>
              {t('settings.model_api.compare_registry')}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.model_api.registry_source_hint')}</p>
          {state.registryPreview ? (
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="text-xs">
                {t('settings.model_api.registry_changes', {
                  count: state.registryPreview.changes.length,
                  preserved: state.registryPreview.preservedCount
                })}
              </p>
              <Button
                size="sm"
                disabled={busy || state.registryPreview.changes.length === 0}
                onClick={() => void catalog.applyRegistry()}>
                {t('settings.model_api.apply')}
              </Button>
            </div>
          ) : null}
          {state.registryRollbackAvailable ? (
            <Button variant="link" size="sm" disabled={busy} onClick={() => void catalog.rollbackRegistry()}>
              {t('settings.model_api.rollback_registry')}
            </Button>
          ) : null}
        </CenterPanel>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_230px] gap-4 max-[900px]:grid-cols-1">
        <CenterPanel>
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="font-medium">{t('settings.model_api.candidates')}</h2>
            <CenterStatus status={state.status} />
          </div>
          {candidates.length === 0 ? (
            <EmptyState
              title={t('settings.model_api.empty_updates')}
              description={t('settings.model_api.empty_updates_hint')}
              className="py-8"
            />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 border-y border-border-subtle px-4 py-2">
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={allSelected}
                    disabled={busy || selectable.length === 0}
                    onCheckedChange={(checked) =>
                      setSelected(checked === true ? selectable.map((candidate) => candidate.id) : [])
                    }
                  />
                  {t('settings.model_api.select_all')}
                </label>
                <span className="text-xs text-muted-foreground">
                  {t('settings.model_api.selected_count', { count: chosen.length })}
                </span>
              </div>
              {candidates.map((candidate) => (
                <div
                  key={candidate.id}
                  className="flex min-h-16 items-center gap-3 border-b border-border-subtle px-4 py-2">
                  <Checkbox
                    aria-label={t('settings.model_api.select_model', { name: candidate.name })}
                    checked={selected.includes(candidate.id)}
                    disabled={busy || candidate.applied}
                    onCheckedChange={(checked) =>
                      setSelected((previous) =>
                        checked === true ? [...previous, candidate.id] : previous.filter((id) => id !== candidate.id)
                      )
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{candidate.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {candidate.providerName} · {candidate.apiModelId}
                    </p>
                  </div>
                  <CenterStatus status={candidate.applied ? 'applied' : candidate.change} />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('settings.model_api.details_provider', { name: candidate.name })}
                    onClick={() => setDetailId(candidate.id)}>
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              ))}
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <p className="text-xs text-muted-foreground">{t('settings.model_api.update_boundary')}</p>
                <Button size="sm" disabled={busy || chosen.length === 0} onClick={() => void catalog.apply(chosen)}>
                  {t('settings.model_api.apply_selected')}
                </Button>
              </div>
            </>
          )}
        </CenterPanel>
        <div className="space-y-3">
          <CenterNotice>{t('settings.model_api.update_boundary')}</CenterNotice>
          {state.policy.automaticVerifyEnabled ? (
            <CenterNotice warning>
              {t('settings.model_api.automatic_budget', { count: state.automaticVerifyLimit })}
            </CenterNotice>
          ) : null}
          {state.lastBatch ? (
            <CenterPanel className="p-4">
              <h2 className="font-medium">
                {t('settings.model_api.last_batch', { count: state.lastBatch.candidateIds.length })}
              </h2>
              {state.lastBatch.conflicts.length > 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('settings.model_api.undo_conflicts', { count: state.lastBatch.conflicts.length })}
                </p>
              ) : null}
              <Button
                className="mt-3"
                variant="outline"
                size="sm"
                disabled={busy || !state.lastBatch.undoAvailable}
                onClick={() => void catalog.undo()}>
                <Undo2 className="size-4" />
                {t('settings.model_api.undo')}
              </Button>
            </CenterPanel>
          ) : null}
          {state.report?.providers.some((provider) => provider.completeness !== 'complete') ? (
            <CenterNotice warning>{t('settings.model_api.incomplete_source')}</CenterNotice>
          ) : null}
        </div>
      </div>
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetailId(null)
        }}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{detail?.name}</DialogTitle>
            <DialogDescription>{t('settings.model_api.update_boundary')}</DialogDescription>
          </DialogHeader>
          {detail ? (
            <dl className="grid grid-cols-[100px_1fr] gap-3 text-sm">
              <dt className="text-muted-foreground">{t('settings.model_api.source')}</dt>
              <dd>
                {t('settings.model_api.provider_source')} ·{' '}
                {t(
                  detail.metadataSource === 'exact_registry'
                    ? 'settings.model_api.registry_source'
                    : 'settings.model_api.unknown_metadata'
                )}
              </dd>
              <dt className="text-muted-foreground">{t('settings.model_api.before')}</dt>
              <dd>
                {detail.before ? (
                  <CenterStatus
                    status={detail.before.isDeprecated ? 'missing' : detail.before.isEnabled ? 'enabled' : 'disabled'}
                  />
                ) : (
                  t('settings.model_api.no_local_record')
                )}
              </dd>
              <dt className="text-muted-foreground">{t('settings.model_api.after')}</dt>
              <dd>
                <CenterStatus
                  status={detail.after.isDeprecated ? 'missing' : detail.after.isEnabled ? 'enabled' : 'disabled'}
                />
              </dd>
              <dt className="text-muted-foreground">{t('settings.model_api.verification')}</dt>
              <dd>
                <CenterStatus status={detail.verification.status} />
              </dd>
            </dl>
          ) : null}
          <CenterNotice>{t('settings.model_api.unknown_capabilities')}</CenterNotice>
          <DialogFooter>
            <Button onClick={() => setDetailId(null)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
