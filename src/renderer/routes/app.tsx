import { createFileRoute, Outlet, useLocation } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { Alert } from '@cherrystudio/ui'

export const Route = createFileRoute('/app')({ component: CoreReleaseRoute })

function CoreReleaseRoute() {
  const pathname = useLocation({ select: (location) => location.pathname })
  const { t } = useTranslation()
  const feature = pathname.split('/')[2]
  if (!['chat', 'agents', 'files', 'file-preview', 'knowledge', 'launchpad', 'release-notes'].includes(feature ?? '')) {
    return <Alert className="m-4" description={t('release.core_unavailable')} />
  }
  return <Outlet />
}
