import { act, render, screen } from '@testing-library/react'
import { type ComponentType, Suspense } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

vi.mock('@renderer/pages/settings/QuickAssistantSettings', () => ({
  default: () => {
    throw new Error('Unavailable settings must not mount or rewrite saved preferences')
  }
}))
vi.mock('@renderer/pages/settings/SelectionAssistantSettings/SelectionAssistantSettings', () => ({
  default: () => {
    throw new Error('Unavailable settings must not mount or rewrite saved preferences')
  }
}))

import { Route as QuickAssistantRoute } from '../quick-assistant'
import { Route as SelectionAssistantRoute } from '../selection-assistant'

describe('core release desktop assistant settings', () => {
  it.each([QuickAssistantRoute, SelectionAssistantRoute])(
    'shows the release notice before mounting settings',
    async (route) => {
      const Settings = route.options.component as ComponentType
      await act(async () => {
        render(
          <Suspense fallback={null}>
            <Settings />
          </Suspense>
        )
      })
      expect(await screen.findByText('release.core_unavailable')).toBeVisible()
    }
  )
})
