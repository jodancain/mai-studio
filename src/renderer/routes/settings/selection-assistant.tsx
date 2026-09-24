import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { Alert } from '@cherrystudio/ui'
import SelectionAssistantSettings from '@renderer/pages/settings/SelectionAssistantSettings/SelectionAssistantSettings'
import { DESKTOP_ASSISTANTS_ENABLED } from '@shared/utils/releasePolicy'

export const Route = createFileRoute('/settings/selection-assistant')({
  component: SelectionAssistantSettingsRoute
})

function SelectionAssistantSettingsRoute() {
  const { t } = useTranslation()
  if (!DESKTOP_ASSISTANTS_ENABLED) {
    return <Alert className="m-4" description={t('release.core_unavailable')} />
  }
  return <SelectionAssistantSettings />
}
