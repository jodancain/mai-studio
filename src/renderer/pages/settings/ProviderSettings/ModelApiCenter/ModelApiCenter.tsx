import { Settings2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@cherrystudio/ui'
import type { Provider } from '@shared/data/types/provider'

import ApiCheckPanel from './ApiCheckPanel'
import ModelAdaptationPanel from './ModelAdaptationPanel'
import ModelUpdatesPanel from './ModelUpdatesPanel'
import { useModelApiCatalog } from './useModelApiCatalog'

export interface ModelApiCenterProps {
  providers: Provider[]
  onConfigureProvider: (providerId?: string) => void
  focusTab?: string
}

export default function ModelApiCenter({ providers, onConfigureProvider, focusTab }: ModelApiCenterProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState('api')
  useEffect(() => {
    if (focusTab) setTab(focusTab === 'model-updates' ? 'updates' : focusTab === 'auto-adaptation' ? 'adapt' : 'api')
  }, [focusTab])
  const catalog = useModelApiCatalog()
  const configuredProviders = providers.filter(
    (provider) => provider.isEnabled || provider.apiKeys?.some((key) => key.isEnabled) || provider.settings?.isAuthed
  )
  const providerIds = configuredProviders.map((provider) => provider.id)

  return (
    <div data-ui="model-api.center" className="h-full min-h-0 overflow-y-auto p-5 text-sm">
      <Tabs value={tab} onValueChange={setTab} variant="underline" className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle">
          <TabsList aria-label={t('settings.model_api.title')}>
            <TabsTrigger id="setting-provider-api-checks" value="api">
              {t('settings.model_api.api')}
            </TabsTrigger>
            <TabsTrigger id="setting-provider-model-updates" value="updates">
              {t('settings.model_api.updates')}
            </TabsTrigger>
            <TabsTrigger id="setting-provider-auto-adaptation" value="adapt">
              {t('settings.model_api.adapt')}
            </TabsTrigger>
          </TabsList>
          <Button variant="ghost" size="sm" onClick={() => onConfigureProvider()}>
            <Settings2 className="size-4" />
            {t('settings.model_api.configure')}
          </Button>
        </div>
        <TabsContent value="api" forceMount className="data-[state=inactive]:hidden">
          <ApiCheckPanel providers={configuredProviders} onConfigureProvider={onConfigureProvider} />
        </TabsContent>
        <TabsContent value="updates" forceMount className="data-[state=inactive]:hidden">
          <ModelUpdatesPanel catalog={catalog} providerIds={providerIds} />
        </TabsContent>
        <TabsContent value="adapt" forceMount className="data-[state=inactive]:hidden">
          <ModelAdaptationPanel catalog={catalog} providerIds={providerIds} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
