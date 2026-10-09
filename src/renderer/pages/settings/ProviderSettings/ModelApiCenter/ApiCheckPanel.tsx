import { Activity, ArrowDownToLine, ChevronRight, RefreshCw, Settings2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@cherrystudio/ui'
import { useModels } from '@renderer/hooks/useModel'
import { isProviderSettingsListVisibleProvider } from '@renderer/utils/providerSettings'
import { LOCAL_EMBEDDING_PROVIDER_ID } from '@shared/data/presets/localEmbedding'
import type { UniqueModelId } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import type {
  ModelApiDiagnosticResult,
  ModelApiProbeKind,
  ModelApiProviderDiagnostics
} from '@shared/types/modelApiDiagnostics'

import { CenterHeader, CenterNotice, CenterPanel, CenterStatus, modelApiStatusKeys } from './modelApiUi'
import { useModelApiDiagnostics } from './useModelApiDiagnostics'

export function diagnosticRowStatus(row?: ModelApiProviderDiagnostics, expired = false): string {
  if (!row) return 'unverified'
  if (expired || row.status === 'stale') return 'stale'
  if (row.status === 'running' || row.status === 'queued') return 'running'
  if (row.status === 'canceled') return 'canceled'
  if (row.status === 'awaiting_confirmation') return 'awaiting_confirmation'
  if (row.layers.some((layer) => layer.code === 'credential_missing')) return 'credential'
  const failure = row.layers.find((layer) => layer.status === 'fail' || layer.status === 'error')
  if (failure) {
    if (failure.httpStatus === 401) return 'credential'
    if (failure.httpStatus === 403) return 'forbidden'
    if (failure.httpStatus === 429) return 'rate_limit'
    if (failure.layer === 'connection' || failure.category === 'network') return 'network'
    return 'failed'
  }
  if (row.testedModelCount > 0 && row.layers.some((layer) => layer.layer === 'inference' && layer.status === 'pass'))
    return 'healthy'
  if (
    ['connection', 'model_list'].every((name) =>
      row.layers.some((layer) => layer.layer === name && layer.status === 'pass')
    )
  )
    return 'basic'
  return 'unverified'
}

const probeKeys = {
  conversation: 'settings.model_api.probe_conversation',
  streaming: 'settings.model_api.probe_streaming',
  tools: 'settings.model_api.probe_tools'
}
const layerKeys = {
  connection: 'settings.model_api.layer_connection',
  auth: 'settings.model_api.layer_auth',
  model_list: 'settings.model_api.layer_model_list',
  inference: 'settings.model_api.layer_inference',
  stream: 'settings.model_api.layer_stream',
  tools: 'settings.model_api.layer_tools'
}
const evidenceKeys = {
  connection: 'settings.model_api.evidence_connection',
  auth: 'settings.model_api.evidence_auth',
  model_list: 'settings.model_api.evidence_model_list',
  inference: 'settings.model_api.evidence_inference',
  stream: 'settings.model_api.evidence_stream',
  tools: 'settings.model_api.evidence_tools'
}

function layerMessage(result: ModelApiDiagnosticResult): string {
  if (result.code === 'credential_missing') return 'settings.model_api.credential_hint'
  if (result.code === 'configuration_changed' || result.code === 'expired') return 'settings.model_api.status_stale'
  if (result.httpStatus === 401) return 'settings.model_api.credential_hint'
  if (result.httpStatus === 403) return 'settings.model_api.forbidden_hint'
  if (result.httpStatus === 429) return 'settings.model_api.rate_limit_hint'
  if (
    (result.status === 'fail' || result.status === 'error') &&
    (result.layer === 'connection' || result.category === 'network')
  )
    return 'settings.model_api.network_hint'
  if (result.status === 'pass') return evidenceKeys[result.layer]
  if (result.status === 'pending') return 'settings.model_api.paid_pending'
  return 'settings.model_api.unknown_hint'
}

function providerAddress(provider: Provider, row?: ModelApiProviderDiagnostics, expired = false): string {
  const snapshot = !expired && row?.status !== 'stale' ? row : undefined
  // A scheme without default ports preserves the host:port already captured by main.
  const baseUrl = snapshot
    ? snapshot.endpoint
      ? `diagnostic://${snapshot.endpoint}`
      : undefined
    : provider.defaultChatEndpoint
      ? provider.endpointConfigs?.[provider.defaultChatEndpoint]?.baseUrl
      : Object.values(provider.endpointConfigs ?? {}).find((endpoint) => endpoint?.baseUrl)?.baseUrl
  if (!baseUrl) return ''
  try {
    return new URL(baseUrl).host
  } catch {
    return ''
  }
}

export default function ApiCheckPanel({
  providers,
  onConfigureProvider
}: {
  providers: Provider[]
  onConfigureProvider: (providerId?: string) => void
}) {
  const { t } = useTranslation()
  const diagnostics = useModelApiDiagnostics()
  const { state, isSubmitting } = diagnostics
  const { models } = useModels()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [checks, setChecks] = useState<ModelApiProbeKind[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [modelSelections, setModelSelections] = useState<Record<string, UniqueModelId>>({})
  const [confirmation, setConfirmation] = useState<{ providerId: string; requestId: string } | null>(null)
  const results = useMemo(() => new Map(state.providers.map((row) => [row.providerId, row])), [state.providers])
  const expired = state.status === 'expired'
  const running = state.status === 'running' || state.status === 'awaiting_confirmation'
  const busy = running || isSubmitting
  const available = state.providers.filter((row) => diagnosticRowStatus(row, expired) === 'healthy')
  const attention = state.providers.filter((row) =>
    ['credential', 'forbidden', 'rate_limit', 'network', 'failed', 'stale'].includes(diagnosticRowStatus(row, expired))
  )
  const visible = providers.filter(
    (provider) =>
      (filter === 'all' || diagnosticRowStatus(results.get(provider.id), expired) === filter) &&
      `${provider.name} ${providerAddress(provider, results.get(provider.id), expired)}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase())
  )
  const detailProvider = providers.find((provider) => provider.id === detailId)
  const detail = detailId ? results.get(detailId) : undefined
  const detailStale = expired || detail?.status === 'stale'
  const pendingProvider = confirmation ? results.get(confirmation.providerId) : undefined
  const pending = pendingProvider?.pendingChecks.find((item) => item.requestId === confirmation?.requestId)
  const run = (providerIds: string[]) =>
    diagnostics.start({ providerIds, checks, modelSelections: Object.values(modelSelections) })
  const metrics = [
    [t('settings.model_api.configured'), providers.length],
    [t('settings.model_api.available'), available.length],
    [t('settings.model_api.attention'), attention.length],
    [t('settings.model_api.verified_models'), available.reduce((total, row) => total + row.testedModelCount, 0)]
  ]

  return (
    <>
      <CenterHeader title={t('settings.model_api.title')} description={t('settings.model_api.api_description')}>
        <Button
          variant="outline"
          size="sm"
          disabled={!state.runId || isSubmitting || state.status === 'running'}
          onClick={() => void diagnostics.exportReport()}>
          <ArrowDownToLine className="size-4" />
          {t('settings.model_api.export')}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setSettingsOpen(true)}>
          <Settings2 className="size-4" />
          {t('settings.model_api.check_settings')}
        </Button>
        <Button
          size="sm"
          disabled={busy || providers.length === 0 || providers.length > 50}
          onClick={() => void run(providers.map((provider) => provider.id))}>
          <Activity className="size-4" />
          {t('settings.model_api.check_all')}
        </Button>
      </CenterHeader>
      <CenterPanel className="mb-4 grid min-h-[78px] grid-cols-4 items-center py-3">
        {metrics.map(([label, value]) => (
          <div key={label} className="border-r border-border-subtle px-4 last:border-r-0">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-xl font-semibold text-foreground">{value}</p>
          </div>
        ))}
      </CenterPanel>
      {diagnostics.readFailed ? (
        <CenterNotice warning>
          <div className="flex items-center gap-2">
            {t('settings.model_api.operation_failed')}
            <Button variant="link" size="sm" onClick={() => void diagnostics.read()}>
              {t('common.retry')}
            </Button>
          </div>
        </CenterNotice>
      ) : null}
      {running ? (
        <CenterPanel className="mb-3 flex items-center justify-between gap-3 px-4 py-2">
          <p role="status" className="text-xs">
            {t('settings.model_api.progress', { done: state.completedProviders, total: state.providers.length })}
          </p>
          <Button variant="outline" size="sm" disabled={isSubmitting} onClick={() => void diagnostics.cancel()}>
            {t('common.cancel')}
          </Button>
        </CenterPanel>
      ) : null}
      <div className="grid grid-cols-[minmax(0,1fr)_230px] gap-4 max-[900px]:grid-cols-1">
        <CenterPanel>
          <div className="flex items-center justify-between px-4 py-2">
            <h2 className="text-sm font-medium">{t('settings.model_api.providers')}</h2>
            <span className="text-xs text-muted-foreground">
              {t('settings.model_api.provider_count', { count: providers.length })}
            </span>
          </div>
          <div className="flex gap-2 px-4 pb-3">
            <Input
              className="h-8 min-w-0"
              aria-label={t('settings.model_api.search')}
              placeholder={t('settings.model_api.search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger className="h-8 w-32" aria-label={t('settings.model_api.filter')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('settings.model_api.all')}</SelectItem>
                {[
                  'healthy',
                  'basic',
                  'failed',
                  'credential',
                  'forbidden',
                  'rate_limit',
                  'network',
                  'stale',
                  'unverified'
                ].map((status) => (
                  <SelectItem key={status} value={status}>
                    {t(modelApiStatusKeys[status])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Table aria-label={t('settings.model_api.providers')} className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[32%]">{t('settings.model_api.providers')}</TableHead>
                <TableHead className="w-[20%]">{t('settings.model_api.status')}</TableHead>
                <TableHead className="w-[22%]">{t('settings.model_api.verified_models')}</TableHead>
                <TableHead className="w-[12%]">{t('settings.model_api.latency')}</TableHead>
                <TableHead className="w-[14%]">{t('settings.model_api.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((provider) => {
                const row = results.get(provider.id)
                const status = diagnosticRowStatus(row, expired)
                const latency = row?.layers.find(
                  (layer) => layer.layer === 'inference' && layer.status === 'pass'
                )?.durationMs
                return (
                  <TableRow key={provider.id} className="h-12">
                    <TableCell className="py-1">
                      <p className="truncate font-medium">{provider.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {providerAddress(provider, row, expired)}
                      </p>
                    </TableCell>
                    <TableCell className="px-1 py-1">
                      <CenterStatus status={status} />
                    </TableCell>
                    <TableCell className="text-xs">
                      {status === 'healthy'
                        ? t('settings.model_api.verified_count', {
                            count: row!.testedModelCount,
                            total: row!.totalModelCount
                          })
                        : t('settings.model_api.status_unverified')}
                    </TableCell>
                    <TableCell className="text-xs">
                      {latency == null ? '—' : t('settings.model_api.milliseconds', { value: latency })}
                    </TableCell>
                    <TableCell className="px-1 py-1">
                      <div className="flex items-center justify-end">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('settings.model_api.check_provider', { name: provider.name })}
                          disabled={busy}
                          onClick={() => void run([provider.id])}>
                          <RefreshCw className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('settings.model_api.details_provider', { name: provider.name })}
                          onClick={() => setDetailId(provider.id)}>
                          <ChevronRight className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          {visible.length === 0 ? (
            <EmptyState
              title={t('settings.model_api.empty_providers')}
              description={t('settings.model_api.empty_providers_hint')}
              className="py-6"
            />
          ) : null}
          <p className="border-t border-border-subtle px-4 py-2 text-xs text-muted-foreground">
            {t('settings.model_api.evidence_boundary')}
          </p>
        </CenterPanel>
        <div className="space-y-3">
          <CenterPanel className="p-4">
            <h2 className="text-sm font-medium">{t('settings.model_api.summary')}</h2>
            <div className="my-3">
              <CenterStatus status={state.status} />
            </div>
            {state.startedAt ? (
              <p className="mb-2 text-xs text-muted-foreground">{new Date(state.startedAt).toLocaleString()}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t('settings.model_api.summary_hint')}</p>
          </CenterPanel>
          <CenterNotice>
            {t(checks.length ? 'settings.model_api.paid_selected' : 'settings.model_api.basic_free')}
          </CenterNotice>
          {providers.length > 50 ? <CenterNotice warning>{t('settings.model_api.provider_limit')}</CenterNotice> : null}
        </div>
      </div>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('settings.model_api.check_settings')}</DialogTitle>
            <DialogDescription>{t('settings.model_api.basic_free')}</DialogDescription>
          </DialogHeader>
          {(['conversation', 'streaming', 'tools'] as const).map((kind) => (
            <div key={kind} className="flex items-center justify-between gap-3 py-2">
              <label htmlFor={`model-api-${kind}`}>{t(probeKeys[kind])}</label>
              <Switch
                id={`model-api-${kind}`}
                checked={checks.includes(kind)}
                disabled={kind !== 'conversation' && !checks.includes('conversation')}
                onCheckedChange={(checked) =>
                  setChecks((previous) =>
                    kind === 'conversation' && !checked
                      ? []
                      : checked
                        ? [...previous, kind]
                        : previous.filter((item) => item !== kind)
                  )
                }
              />
            </div>
          ))}
          <CenterNotice warning>{t('settings.model_api.paid_limit')}</CenterNotice>
          <DialogFooter>
            <Button onClick={() => setSettingsOpen(false)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!detailProvider}
        onOpenChange={(open) => {
          if (!open) setDetailId(null)
        }}>
        <DialogContent size="xl" closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{detailProvider?.name}</DialogTitle>
            <DialogDescription>{t('settings.model_api.evidence_boundary')}</DialogDescription>
          </DialogHeader>
          {detailProvider ? (
            <>
              <Select
                value={modelSelections[detailProvider.id] ?? ''}
                onValueChange={(value) =>
                  setModelSelections((previous) => ({ ...previous, [detailProvider.id]: value as UniqueModelId }))
                }
                disabled={busy}>
                <SelectTrigger aria-label={t('settings.model_api.test_model')}>
                  <SelectValue placeholder={t('settings.model_api.test_model')} />
                </SelectTrigger>
                <SelectContent>
                  {models
                    .filter((model) => model.providerId === detailProvider.id)
                    .map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {detail?.modelName ? (
                <p className="text-xs text-muted-foreground">
                  {t('settings.model_api.tested_model', { name: detail.modelName })}
                </p>
              ) : null}
              {detailStale ? <CenterNotice warning>{t('settings.model_api.status_stale')}</CenterNotice> : null}
              <div className="space-y-2">
                {(['connection', 'auth', 'model_list', 'inference', 'stream', 'tools'] as const).map((layer) => {
                  const result = detail?.layers.find((item) => item.layer === layer)
                  const pendingCheck = detail?.pendingChecks.find(
                    (item) => ({ conversation: 'inference', streaming: 'stream', tools: 'tools' })[item.kind] === layer
                  )
                  return (
                    <div
                      key={layer}
                      className="flex items-start justify-between gap-3 border-b border-border-subtle py-2 last:border-b-0">
                      <div>
                        <p className="font-medium">{t(layerKeys[layer])}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t(result ? layerMessage(result) : 'settings.model_api.unknown_hint')}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <CenterStatus status={detailStale ? 'stale' : (result?.status ?? 'unverified')} />
                        {pendingCheck ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={isSubmitting || detailStale}
                            onClick={() =>
                              setConfirmation({ providerId: detailProvider.id, requestId: pendingCheck.requestId })
                            }>
                            {t('settings.model_api.confirm_probe')}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
              <DialogFooter>
                {detailProvider.id === LOCAL_EMBEDDING_PROVIDER_ID ||
                isProviderSettingsListVisibleProvider(detailProvider) ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setDetailId(null)
                      onConfigureProvider(detailProvider.id)
                    }}>
                    {t(
                      detailProvider.id === LOCAL_EMBEDDING_PROVIDER_ID
                        ? 'settings.dependencies.localModels.title'
                        : 'settings.model_api.configure'
                    )}
                  </Button>
                ) : null}
                {running ? (
                  <Button variant="outline" disabled={isSubmitting} onClick={() => void diagnostics.cancel()}>
                    {t('common.cancel')}
                  </Button>
                ) : (
                  <Button disabled={isSubmitting} onClick={() => void run([detailProvider.id])}>
                    {t('common.retry')}
                  </Button>
                )}
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('settings.model_api.confirm_probe')}</DialogTitle>
            <DialogDescription>
              {t('settings.model_api.confirm_probe_hint', {
                name: pendingProvider?.providerName,
                kind: pending ? t(probeKeys[pending.kind]) : ''
              })}
            </DialogDescription>
          </DialogHeader>
          <CenterNotice warning>{t('settings.model_api.paid_limit')}</CenterNotice>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={isSubmitting || expired}
              onClick={() => {
                if (confirmation) void diagnostics.confirm(confirmation.providerId, confirmation.requestId)
                setConfirmation(null)
              }}>
              {t('settings.model_api.confirm_probe')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
