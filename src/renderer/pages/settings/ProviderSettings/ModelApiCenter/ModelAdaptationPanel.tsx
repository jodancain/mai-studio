import { Sparkles } from 'lucide-react'
import { useState } from 'react'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch
} from '@cherrystudio/ui'
import type { EndpointType } from '@shared/data/types/model'
import type { ModelApiCatalogPolicy } from '@shared/types/modelApiCatalog'

import { CenterHeader, CenterNotice, CenterPanel, CenterStatus } from './modelApiUi'
import type { ModelApiCatalogController } from './useModelApiCatalog'

const stages = [
  { titleKey: 'settings.model_api.stage_discovery', hintKey: 'settings.model_api.stage_discovery_hint' },
  { titleKey: 'settings.model_api.stage_protocol', hintKey: 'settings.model_api.stage_protocol_hint' },
  { titleKey: 'settings.model_api.stage_capability', hintKey: 'settings.model_api.stage_capability_hint' },
  { titleKey: 'settings.model_api.stage_verification', hintKey: 'settings.model_api.stage_verification_hint' },
  { titleKey: 'settings.model_api.stage_enable', hintKey: 'settings.model_api.stage_enable_hint' }
]
const policyKeys = {
  discoveryEnabled: 'settings.model_api.policy_discoveryEnabled',
  automaticVerifyEnabled: 'settings.model_api.policy_automaticVerifyEnabled',
  automaticApplyEnabled: 'settings.model_api.policy_automaticApplyEnabled'
}

export default function ModelAdaptationPanel({
  catalog,
  providerIds
}: {
  catalog: ModelApiCatalogController
  providerIds: string[]
}) {
  const { t } = useTranslation()
  const { state } = catalog
  const [candidateId, setCandidateId] = useState<string | null>(null)
  const [endpoint, setEndpoint] = useState<EndpointType | ''>('')
  const [policyConfirmation, setPolicyConfirmation] = useState<ModelApiCatalogPolicy | null>(null)
  const [evidenceId, setEvidenceId] = useState<string | null>(null)
  const busy = catalog.isSubmitting || state.status !== 'idle'
  const candidates = state.report?.candidates.filter((candidate) => candidate.change !== 'missing') ?? []
  const candidate = candidates.find((item) => item.id === candidateId)
  const evidence = candidates.find((item) => item.id === evidenceId)
  const changePolicy = (field: keyof ModelApiCatalogPolicy, checked: boolean) => {
    const policy = { ...state.policy, [field]: checked }
    if (field === 'automaticVerifyEnabled' && checked) setPolicyConfirmation(policy)
    else void catalog.setPolicy(policy)
  }

  return (
    <>
      <CenterHeader title={t('settings.model_api.adapt')} description={t('settings.model_api.adapt_description')}>
        <Button
          size="sm"
          disabled={busy || !state.policy.discoveryEnabled || providerIds.length === 0}
          onClick={() => void catalog.scan(providerIds)}>
          <Sparkles className="size-4" />
          {t('settings.model_api.discover')}
        </Button>
        {state.status !== 'idle' ? (
          <Button variant="outline" size="sm" onClick={() => void catalog.cancel()}>
            {t('common.cancel')}
          </Button>
        ) : null}
      </CenterHeader>
      <CenterPanel className="mb-4 grid grid-cols-5 gap-2 px-4 py-3">
        {stages.map((stage) => (
          <div key={stage.titleKey} className="min-w-0 text-center">
            <p className="text-xs font-medium">{t(stage.titleKey)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t(stage.hintKey)}</p>
          </div>
        ))}
      </CenterPanel>
      <div className="grid grid-cols-[minmax(0,1fr)_250px] gap-4 max-[900px]:grid-cols-1">
        <CenterPanel>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <h2 className="font-medium">{t('settings.model_api.adaptation_results')}</h2>
            <CenterStatus status={state.status} />
          </div>
          {candidates.length === 0 ? (
            <EmptyState
              title={t('settings.model_api.empty_adapt')}
              description={t('settings.model_api.empty_adapt_hint')}
              className="py-8"
            />
          ) : (
            candidates.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{item.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.providerName} · {item.endpointType ?? t('settings.model_api.unknown_protocol')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <CenterStatus
                    status={
                      item.applied && item.after.isEnabled
                        ? 'enabled'
                        : item.verification.reason === 'canceled'
                          ? 'canceled'
                          : item.verification.status === 'verified'
                            ? 'staged'
                            : item.verification.status
                    }
                  />
                  <Button variant="ghost" size="sm" onClick={() => setEvidenceId(item.id)}>
                    {t('settings.model_api.evidence')}
                  </Button>
                  {item.change === 'new' && !item.applied ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setCandidateId(item.id)
                          setEndpoint('')
                        }}>
                        {t('settings.model_api.verify')}
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy || item.verification.status !== 'verified'}
                        onClick={() => void catalog.apply([item.id])}>
                        {t('settings.model_api.add_verified')}
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            ))
          )}
          <p className="border-t border-border-subtle px-4 py-2 text-xs text-muted-foreground">
            {t('settings.model_api.unknown_capabilities')}
          </p>
        </CenterPanel>
        <div className="space-y-3">
          <CenterPanel className="p-4">
            <h2 className="mb-3 font-medium">{t('settings.model_api.policy')}</h2>
            {(['discoveryEnabled', 'automaticVerifyEnabled', 'automaticApplyEnabled'] as const).map((field) => (
              <div
                key={field}
                className="flex items-center justify-between gap-3 border-b border-border-subtle py-2 last:border-b-0">
                <label className="text-xs" htmlFor={`model-api-policy-${field}`}>
                  {t(policyKeys[field])}
                </label>
                <Switch
                  id={`model-api-policy-${field}`}
                  size="sm"
                  checked={state.policy[field]}
                  disabled={busy}
                  onCheckedChange={(checked) => changePolicy(field, checked)}
                />
              </div>
            ))}
            <p className="mt-3 text-xs text-muted-foreground">
              {t('settings.model_api.automatic_budget', { count: state.automaticVerifyLimit })}
            </p>
          </CenterPanel>
          <CenterNotice>{t('settings.model_api.adapt_boundary')}</CenterNotice>
          {catalog.readFailed ? (
            <CenterNotice warning>
              {t('settings.model_api.operation_failed')}
              <Button variant="link" size="sm" onClick={() => void catalog.read()}>
                {t('common.retry')}
              </Button>
            </CenterNotice>
          ) : null}
        </div>
      </div>
      <Dialog
        open={!!candidate}
        onOpenChange={(open) => {
          if (!open) setCandidateId(null)
        }}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('settings.model_api.verify')}</DialogTitle>
            <DialogDescription>
              {t('settings.model_api.verify_confirmation', { name: candidate?.name })}
            </DialogDescription>
          </DialogHeader>
          {candidate?.requiresManualEndpoint ? (
            <Select value={endpoint} onValueChange={(value) => setEndpoint(value as EndpointType)}>
              <SelectTrigger aria-label={t('settings.model_api.choose_protocol')}>
                <SelectValue placeholder={t('settings.model_api.choose_protocol')} />
              </SelectTrigger>
              <SelectContent>
                {candidate.availableEndpoints.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-xs">{candidate?.endpointType ?? t('settings.model_api.unknown_protocol')}</p>
          )}
          <CenterNotice warning>{t('settings.model_api.paid_limit')}</CenterNotice>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCandidateId(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={busy || (!!candidate?.requiresManualEndpoint && !endpoint)}
              onClick={() => {
                if (candidate) void catalog.verify([candidate.id], endpoint || undefined)
                setCandidateId(null)
              }}>
              {t('settings.model_api.confirm_verify')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!policyConfirmation}
        onOpenChange={(open) => {
          if (!open) setPolicyConfirmation(null)
        }}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('settings.model_api.policy_automaticVerifyEnabled')}</DialogTitle>
            <DialogDescription>
              {t('settings.model_api.automatic_budget', { count: state.automaticVerifyLimit })}
            </DialogDescription>
          </DialogHeader>
          <CenterNotice warning>{t('settings.model_api.paid_limit')}</CenterNotice>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPolicyConfirmation(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (policyConfirmation) void catalog.setPolicy(policyConfirmation, true)
                setPolicyConfirmation(null)
              }}>
              {t('settings.model_api.confirm_verify')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!evidence}
        onOpenChange={(open) => {
          if (!open) setEvidenceId(null)
        }}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>
              {evidence?.name} · {t('settings.model_api.evidence')}
            </DialogTitle>
            <DialogDescription>{t('settings.model_api.evidence_boundary')}</DialogDescription>
          </DialogHeader>
          {evidence ? (
            <div className="space-y-3">
              <p className="text-xs">
                {t('settings.model_api.source')}: {t('settings.model_api.provider_source')} ·{' '}
                {t(
                  evidence.metadataSource === 'exact_registry'
                    ? 'settings.model_api.registry_source'
                    : 'settings.model_api.unknown_metadata'
                )}
              </p>
              <div className="flex items-center justify-between">
                <span>{t('settings.model_api.probe_conversation')}</span>
                <CenterStatus
                  status={
                    evidence.verification.status === 'stale'
                      ? 'stale'
                      : evidence.verification.reason === 'canceled'
                        ? 'canceled'
                        : evidence.verification.conversation === 'passed'
                          ? 'pass'
                          : evidence.verification.conversation === 'failed'
                            ? 'fail'
                            : 'unverified'
                  }
                />
              </div>
              {evidence.verification.checkedAt ? (
                <p className="text-xs text-muted-foreground">
                  {new Date(evidence.verification.checkedAt).toLocaleString()}
                </p>
              ) : null}
              {evidence.verification.status === 'failed' ? (
                <CenterNotice warning>{t('settings.model_api.verification_failed')}</CenterNotice>
              ) : null}
              {evidence.verification.status === 'stale' ? (
                <CenterNotice warning>{t('settings.model_api.status_stale')}</CenterNotice>
              ) : null}
              <CenterNotice>{t('settings.model_api.unknown_capabilities')}</CenterNotice>
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setEvidenceId(null)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
