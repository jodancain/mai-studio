import { useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, Button, Spinner } from '@cherrystudio/ui'
import { usePersistCache } from '@data/hooks/useCache'
import { useProviders } from '@renderer/hooks/useProvider'
import type { AppRouter } from '@renderer/types/router'
import { isProviderSettingsListVisibleProvider } from '@renderer/utils/providerSettings'
import type { Provider } from '@shared/data/types/provider'

import { useSettingsSearchKeyboard } from '../settingsSearch/store'
import type { ProviderApiSetupInitialStep } from './ConnectionSettings/ProviderApiSetupDialog'
import { useProviderDeepLinkImport } from './hooks/useProviderDeepLinkImport'
import ModelApiCenter from './ModelApiCenter/ModelApiCenter'
import { ProviderList } from './ProviderList'
import ProviderSetting from './ProviderSetting'

interface PendingApiSetup {
  providerId: string
  initialStep: ProviderApiSetupInitialStep
}

interface ProviderSettingsContentProps {
  rawProviders: Provider[]
}

function ProviderSettingsContent({ rawProviders }: ProviderSettingsContentProps) {
  const search = useSearch<AppRouter, undefined, false>({ strict: false })
  const navigate = useNavigate()
  const [lastSelectedProviderId, setLastSelectedProviderId] = usePersistCache(
    'settings.provider.last_selected_provider_id'
  )
  const [selectedProviderId, setSelectedProviderIdState] = useState<string | undefined>(
    () => lastSelectedProviderId ?? undefined
  )
  const [pendingApiSetup, setPendingApiSetup] = useState<PendingApiSetup | null>(null)
  const setLastSelectedProviderIdRef = useRef(setLastSelectedProviderId)

  const providers = useMemo(() => (Array.isArray(rawProviders) ? rawProviders : []), [rawProviders])
  const visibleProviders = useMemo(() => providers.filter(isProviderSettingsListVisibleProvider), [providers])
  const filterModeHint = search.filter === 'agent' ? 'agent' : undefined

  useEffect(() => {
    setLastSelectedProviderIdRef.current = setLastSelectedProviderId
  }, [setLastSelectedProviderId])

  useEffect(() => {
    const persistedProviderId = lastSelectedProviderId ?? undefined
    setSelectedProviderIdState((currentProviderId) =>
      currentProviderId === persistedProviderId ? currentProviderId : persistedProviderId
    )
  }, [lastSelectedProviderId])

  const setSelectedProviderId = useCallback((providerId: string | undefined) => {
    setPendingApiSetup((current) => (current?.providerId === providerId ? current : null))
    setLastSelectedProviderIdRef.current(providerId ?? null)
    startTransition(() => setSelectedProviderIdState(providerId))
  }, [])

  const handleCustomProviderCreated = useCallback((providerId: string, hasApiKey: boolean) => {
    setPendingApiSetup({ providerId, initialStep: hasApiKey ? 'models' : 'api-key' })
  }, [])

  const handleApiSetupClosed = useCallback((providerId: string) => {
    setPendingApiSetup((current) => (current?.providerId === providerId ? null : current))
  }, [])

  useProviderDeepLinkImport(search.addProviderData, setSelectedProviderId)

  useEffect(() => {
    let shouldConsume = false

    if (search.filter === 'agent') {
      shouldConsume = true
    }

    if (search.id) {
      const provider = visibleProviders.find((item) => item.id === search.id)
      if (provider) {
        setSelectedProviderId(provider.id)
        shouldConsume = true
      } else if (visibleProviders.length > 0) {
        // Loaded and genuinely unknown — degrade to the first like before
        setSelectedProviderId(visibleProviders[0]?.id)
        shouldConsume = true
      } else {
        // Still loading: keep the param until the list resolves, else the
        // selection is consumed with no provider mounted to own it
        return
      }
    }

    if (shouldConsume) {
      void navigate({
        to: '/settings/provider',
        search: (previous) => {
          const rest = { ...previous }
          delete rest.filter
          delete rest.id
          return rest
        },
        replace: true
      })
    }
  }, [navigate, search, setSelectedProviderId, visibleProviders])

  useEffect(() => {
    // A pending ?id= deep link owns the initial selection while providers
    // load; the fallback must not race it to visibleProviders[0]
    if (search.id) return
    if (!selectedProviderId && visibleProviders[0]) {
      setSelectedProviderId(visibleProviders[0].id)
      return
    }

    if (selectedProviderId && !visibleProviders.some((provider) => provider.id === selectedProviderId)) {
      setSelectedProviderId(visibleProviders[0]?.id)
    }
  }, [search.id, selectedProviderId, setSelectedProviderId, visibleProviders])

  const selectedProvider = useMemo(
    () => visibleProviders.find((provider) => provider.id === selectedProviderId),
    [selectedProviderId, visibleProviders]
  )

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 overflow-hidden">
      <ProviderList
        selectedProviderId={selectedProviderId}
        filterModeHint={filterModeHint}
        onSelectProvider={setSelectedProviderId}
        onCustomProviderCreated={handleCustomProviderCreated}
      />
      {selectedProvider && (
        <ProviderSetting
          providerId={selectedProvider.id}
          key={selectedProvider.id}
          initialApiSetupStep={
            pendingApiSetup?.providerId === selectedProvider.id ? pendingApiSetup.initialStep : undefined
          }
          onApiSetupClosed={() => handleApiSetupClosed(selectedProvider.id)}
        />
      )}
    </div>
  )
}

export default function ProviderSettingsPage() {
  const { t } = useTranslation()
  const search = useSearch<AppRouter, undefined, false>({ strict: false })
  const navigate = useNavigate()
  const { pendingFocusId } = useSettingsSearchKeyboard()
  const focusId = search.focusId ?? pendingFocusId
  const centerFocus = focusId?.match(/^setting-provider-(api-checks|model-updates|auto-adaptation)$/)?.[1]
  const hasConfigurationIntent = !!(
    search.id ||
    search.filter ||
    search.addProviderData ||
    (!centerFocus && focusId?.startsWith('setting-provider-'))
  )
  const [configurationOpen, setConfigurationOpen] = useState(hasConfigurationIntent)
  const { providers, hasLoaded, isLoading, error, refetch } = useProviders()

  useEffect(() => {
    if (hasConfigurationIntent) setConfigurationOpen(true)
    else if (centerFocus) setConfigurationOpen(false)
  }, [centerFocus, hasConfigurationIntent])

  const openConfiguration = useCallback(
    (providerId?: string) => {
      setConfigurationOpen(true)
      if (providerId) {
        void navigate({ to: '/settings/provider', search: (previous) => ({ ...previous, id: providerId }) })
      }
    },
    [navigate]
  )

  if (error && !hasLoaded) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <Alert
          type="error"
          showIcon
          message={t('common.error')}
          description={error.message}
          action={
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          }
          className="max-w-lg rounded-md px-4 py-3 shadow-none"
        />
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <Spinner text={t('common.loading')} />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div hidden={configurationOpen} className="min-h-0 flex-1">
        <ModelApiCenter providers={providers} onConfigureProvider={openConfiguration} focusTab={centerFocus} />
      </div>
      {configurationOpen ? (
        <>
          <div className="flex h-10 shrink-0 items-center border-b border-border-subtle px-3">
            <Button variant="ghost" size="sm" onClick={() => setConfigurationOpen(false)}>
              <ArrowLeft className="size-4" />
              {t('settings.model_api.back')}
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <ProviderSettingsContent rawProviders={providers} />
          </div>
        </>
      ) : null}
    </div>
  )
}
