import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { MockUseDataApiUtils } from '@test-mocks/renderer/useDataApi'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { cacheService } from '@data/CacheService'
import i18n from '@renderer/i18n/resolver'
import type { Provider } from '@shared/data/types/provider'
import type { ModelApiDiagnosticsState, ModelApiProviderDiagnostics } from '@shared/types/modelApiDiagnostics'

vi.unmock('@data/hooks/useCache')
vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal())
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))

import ApiCheckPanel, { diagnosticRowStatus } from '../ApiCheckPanel'

const provider = {
  id: 'test',
  name: 'Test provider',
  isEnabled: true,
  apiKeys: [],
  settings: {},
  endpointConfigs: { 'openai-chat-completions': { baseUrl: 'https://test.example/v1' } }
} as unknown as Provider
const row: ModelApiProviderDiagnostics = {
  providerId: 'test',
  providerName: 'Test provider',
  uniqueModelId: 'test::text',
  modelName: 'Text model',
  totalModelCount: 3,
  testedModelCount: 0,
  status: 'completed',
  pendingChecks: [],
  layers: [
    { layer: 'connection', status: 'pass' },
    { layer: 'auth', status: 'pass' },
    { layer: 'model_list', status: 'pass' },
    { layer: 'inference', status: 'unverified' },
    { layer: 'stream', status: 'unverified' },
    { layer: 'tools', status: 'unverified' }
  ]
}
const idle: ModelApiDiagnosticsState = {
  status: 'idle',
  runId: null,
  startedAt: null,
  expiresAt: null,
  completedProviders: 0,
  providers: []
}
function publish(state: ModelApiDiagnosticsState) {
  cacheService.setShared('model_api.diagnostics', state)
}
function completed(providerRow = row): ModelApiDiagnosticsState {
  return {
    ...idle,
    status: 'completed',
    runId: '00000000-0000-4000-8000-000000000001',
    completedProviders: 1,
    providers: [providerRow]
  }
}

beforeAll(async () => {
  await i18n.changeLanguage('en-us')
})
beforeEach(() => {
  MockCacheUtils.resetMocks()
  MockUseDataApiUtils.resetMocks()
  MockUseDataApiUtils.mockQueryData('/models', [])
  publish(idle)
  request.mockReset()
  request.mockImplementation(async (route) => (route.endsWith('.read') ? idle : { status: 'started', state: idle }))
})

describe('API checks', () => {
  it('starts with zero paid probes and sends only configured provider IDs', async () => {
    const user = userEvent.setup()
    render(<ApiCheckPanel providers={[provider]} onConfigureProvider={vi.fn()} />)
    await waitFor(() => expect(request).toHaveBeenCalledWith('model_api.diagnostics.read', {}))
    expect(request.mock.calls.map(([route]) => route)).toEqual(['model_api.diagnostics.read'])
    await user.click(screen.getByRole('button', { name: i18n.t('settings.model_api.check_all') }))
    expect(request).toHaveBeenCalledWith('model_api.diagnostics.start', {
      providerIds: ['test'],
      checks: [],
      modelSelections: []
    })
  })

  it('shows a successful list as basic without counting untested models as available', async () => {
    publish(completed())
    render(<ApiCheckPanel providers={[provider]} onConfigureProvider={vi.fn()} />)
    const table = screen.getByRole('table', { name: i18n.t('settings.model_api.providers') })
    expect(within(table).getByText(i18n.t('settings.model_api.status_basic'))).toBeInTheDocument()
    expect(within(table).queryByText(i18n.t('settings.model_api.status_healthy'))).not.toBeInTheDocument()
    expect(within(table).getByText(i18n.t('settings.model_api.status_unverified'))).toBeInTheDocument()
    expect(diagnosticRowStatus({ ...row, layers: [{ layer: 'model_list', status: 'pass' }] })).toBe('unverified')
  })

  it.each([
    [401, 'credential'],
    [403, 'forbidden'],
    [429, 'rate_limit']
  ])('shows HTTP %s as %s rather than a usable provider', async (httpStatus, status) => {
    publish(
      completed({
        ...row,
        layers: [...row.layers.filter((layer) => layer.layer !== 'auth'), { layer: 'auth', status: 'fail', httpStatus }]
      })
    )
    render(<ApiCheckPanel providers={[provider]} onConfigureProvider={vi.fn()} />)
    const table = screen.getByRole('table', { name: i18n.t('settings.model_api.providers') })
    expect(within(table).getByText(i18n.t('settings.model_api.status_' + status))).toBeInTheDocument()
    expect(within(table).queryByText(i18n.t('settings.model_api.status_healthy'))).not.toBeInTheDocument()
  })

  it('marks every detail layer stale after provider configuration changes', async () => {
    const user = userEvent.setup()
    publish(
      completed({
        ...row,
        status: 'stale',
        testedModelCount: 1,
        layers: row.layers.map((layer) => ({ ...layer, status: 'pass' }))
      })
    )
    render(<ApiCheckPanel providers={[provider]} onConfigureProvider={vi.fn()} />)
    await user.click(
      screen.getByRole('button', { name: i18n.t('settings.model_api.details_provider', { name: 'Test provider' }) })
    )
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getAllByText(i18n.t('settings.model_api.status_stale'))).toHaveLength(7)
    expect(within(dialog).queryByText(i18n.t('settings.model_api.status_pass'))).not.toBeInTheDocument()
    expect(
      within(dialog).queryByRole('button', { name: i18n.t('settings.model_api.confirm_probe') })
    ).not.toBeInTheDocument()
  })

  it('requires an explicit confirmation for the exact paid check and reports cancellation', async () => {
    const user = userEvent.setup()
    const pendingRow: ModelApiProviderDiagnostics = {
      ...row,
      status: 'awaiting_confirmation',
      pendingChecks: [
        {
          kind: 'conversation',
          requestId: '00000000-0000-4000-8000-000000000002',
          maxOutputTokens: 64,
          timeoutMs: 15000
        }
      ],
      layers: row.layers.map((layer) => (layer.layer === 'inference' ? { ...layer, status: 'pending' } : layer))
    }
    const pendingState = { ...completed(pendingRow), status: 'awaiting_confirmation' as const }
    publish(pendingState)
    render(<ApiCheckPanel providers={[provider]} onConfigureProvider={vi.fn()} />)
    await user.click(
      screen.getByRole('button', { name: i18n.t('settings.model_api.details_provider', { name: 'Test provider' }) })
    )
    await user.click(screen.getByRole('button', { name: i18n.t('settings.model_api.confirm_probe') }))
    expect(request.mock.calls.some(([route]) => route.endsWith('.confirm'))).toBe(false)
    const dialogs = screen.getAllByRole('dialog')
    const confirmation = dialogs.at(-1)!
    expect(within(confirmation).getByText(i18n.t('settings.model_api.paid_limit'))).toBeInTheDocument()
    await user.click(within(confirmation).getByRole('button', { name: i18n.t('settings.model_api.confirm_probe') }))
    expect(request).toHaveBeenCalledWith('model_api.diagnostics.confirm', {
      runId: pendingState.runId,
      providerId: 'test',
      requestId: '00000000-0000-4000-8000-000000000002'
    })
    act(() => publish({ ...completed({ ...row, status: 'canceled' }), status: 'canceled' }))
    expect(screen.getAllByText(i18n.t('settings.model_api.status_canceled')).length).toBeGreaterThan(0)
    expect(diagnosticRowStatus({ ...row, testedModelCount: 1 }, true)).toBe('stale')
  })
})
