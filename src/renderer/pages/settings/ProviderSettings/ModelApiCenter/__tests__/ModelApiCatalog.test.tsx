import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { cacheService } from '@data/CacheService'
import i18n from '@renderer/i18n/resolver'
import {
  DEFAULT_MODEL_API_CATALOG_STATE,
  type ModelApiCatalogCandidate,
  type ModelApiCatalogState
} from '@shared/types/modelApiCatalog'

vi.unmock('@data/hooks/useCache')
vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal())
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))

import ModelAdaptationPanel from '../ModelAdaptationPanel'
import ModelUpdatesPanel from '../ModelUpdatesPanel'
import { useModelApiCatalog } from '../useModelApiCatalog'

const candidate: ModelApiCatalogCandidate = {
  id: 'candidate-1',
  providerId: 'test',
  providerName: 'Test provider',
  apiModelId: 'new-text',
  name: 'New text',
  change: 'new',
  source: 'provider_api',
  metadataSource: 'none',
  capabilities: [],
  availableEndpoints: ['openai-chat-completions'],
  requiresManualEndpoint: true,
  after: { isEnabled: false, isDeprecated: false },
  applied: false,
  verification: {
    status: 'pending',
    conversation: 'unknown',
    streaming: 'unknown',
    tools: 'unknown',
    vision: 'unknown',
    context: 'unknown'
  }
}
const state: ModelApiCatalogState = {
  ...DEFAULT_MODEL_API_CATALOG_STATE,
  policy: { discoveryEnabled: true, automaticVerifyEnabled: false, automaticApplyEnabled: false },
  report: {
    id: 'report-1',
    scannedAt: 1000,
    candidates: [candidate, { ...candidate, id: 'candidate-2', apiModelId: 'second', name: 'Second text' }],
    providers: []
  }
}
function CatalogHarness({ adapt = false }) {
  const catalog = useModelApiCatalog()
  return adapt ? (
    <ModelAdaptationPanel catalog={catalog} providerIds={['test']} />
  ) : (
    <ModelUpdatesPanel catalog={catalog} providerIds={['test']} />
  )
}

beforeAll(async () => {
  await i18n.changeLanguage('en-us')
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})
beforeEach(() => {
  MockCacheUtils.resetMocks()
  cacheService.setShared('model_api.catalog', state)
  request.mockReset()
  request.mockResolvedValue(state)
})

describe('Model catalog actions', () => {
  it('keeps an empty selection disabled and applies only the selected candidate', async () => {
    const user = userEvent.setup()
    render(<CatalogHarness />)
    const apply = screen.getByRole('button', { name: i18n.t('settings.model_api.apply_selected') })
    expect(apply).toBeDisabled()
    await user.click(
      screen.getByRole('checkbox', { name: i18n.t('settings.model_api.select_model', { name: 'New text' }) })
    )
    await user.click(apply)
    expect(request).toHaveBeenCalledWith('model_api.catalog.apply', {
      reportId: 'report-1',
      candidateIds: ['candidate-1']
    })
  })

  it('requires a supported endpoint and fee confirmation before verifying an unknown model', async () => {
    const user = userEvent.setup()
    render(<CatalogHarness adapt />)
    const rowButton = screen.getAllByRole('button', { name: i18n.t('settings.model_api.verify') })[0]
    await user.click(rowButton)
    const dialog = screen.getByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: i18n.t('settings.model_api.confirm_verify') })
    expect(confirm).toBeDisabled()
    expect(request.mock.calls.some(([route]) => route === 'model_api.catalog.verify')).toBe(false)
    await user.click(within(dialog).getByRole('combobox', { name: i18n.t('settings.model_api.choose_protocol') }))
    await user.click(screen.getByRole('option', { name: 'openai-chat-completions' }))
    await user.click(confirm)
    expect(request).toHaveBeenCalledWith('model_api.catalog.verify', {
      reportId: 'report-1',
      candidateIds: ['candidate-1'],
      endpointType: 'openai-chat-completions'
    })
    expect(
      screen
        .getAllByRole('button', { name: i18n.t('settings.model_api.add_verified') })
        .every((button) => button.hasAttribute('disabled'))
    ).toBe(true)
  })

  it.each(['stale', 'canceled'] as const)(
    'does not present %s verification evidence as a current success',
    async (status) => {
      const user = userEvent.setup()
      cacheService.setShared('model_api.catalog', {
        ...state,
        report: {
          ...state.report!,
          candidates: [
            {
              ...candidate,
              verification: {
                ...candidate.verification,
                status: status === 'stale' ? 'stale' : 'pending',
                reason: status === 'stale' ? 'verification_stale' : 'canceled',
                conversation: 'passed'
              }
            }
          ]
        }
      })
      render(<CatalogHarness adapt />)
      expect(screen.getByRole('button', { name: i18n.t('settings.model_api.add_verified') })).toBeDisabled()
      await user.click(screen.getByRole('button', { name: i18n.t('settings.model_api.evidence') }))
      const dialog = screen.getByRole('dialog')
      expect(within(dialog).getAllByText(i18n.t('settings.model_api.status_' + status)).length).toBeGreaterThan(0)
      expect(within(dialog).queryByText(i18n.t('settings.model_api.status_pass'))).not.toBeInTheDocument()
    }
  )

  it('does not enable automatic paid verification when its confirmation is canceled', async () => {
    const user = userEvent.setup()
    render(<CatalogHarness adapt />)
    await user.click(screen.getByRole('switch', { name: i18n.t('settings.model_api.policy_automaticVerifyEnabled') }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(i18n.t('settings.model_api.paid_limit'))).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: i18n.t('common.cancel') }))
    expect(request.mock.calls.some(([route]) => route === 'model_api.catalog.policy')).toBe(false)
    expect(
      screen.getByRole('switch', { name: i18n.t('settings.model_api.policy_automaticVerifyEnabled') })
    ).not.toBeChecked()
  })
})
