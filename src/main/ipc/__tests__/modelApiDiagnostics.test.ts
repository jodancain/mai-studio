import { beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { modelApiDiagnosticsRequestSchemas } from '@shared/ipc/schemas/modelApiDiagnostics'
import type { IpcContext } from '@shared/ipc/types'
import { INITIAL_MODEL_API_DIAGNOSTICS_STATE } from '@shared/types/modelApiDiagnostics'

import { modelApiDiagnosticsHandlers } from '../handlers/modelApiDiagnostics'
import { IpcRouter } from '../IpcRouter'

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory()
})

const context: IpcContext = { senderId: 'diagnostics-window' }
const router = new IpcRouter(modelApiDiagnosticsRequestSchemas, modelApiDiagnosticsHandlers)
const runId = '62aa3e74-7bdb-446c-8fb4-bd12f2298d4b'
const requestId = 'd46a0091-1456-4113-9ff9-83d9ad40ab27'

beforeEach(() => {
  vi.clearAllMocks()
})

function expectNoDiagnosticsDelegation(): void {
  const service = application.get('ModelApiDiagnosticsService')
  for (const method of ['start', 'read', 'confirm', 'cancel', 'export'] as const) {
    expect(service[method]).not.toHaveBeenCalled()
  }
}

describe('model API diagnostics renderer boundary', () => {
  it.each([
    { field: 'apiKey', value: 'untrusted-key' },
    { field: 'headers', value: { Authorization: 'untrusted-key' } },
    { field: 'signal', value: {} },
    { field: 'maxRetries', value: 4 },
    { field: 'maxOutputTokens', value: 100000 },
    { field: 'timeoutMs', value: 600000 },
    { field: 'resolvedModel', value: { provider: {}, model: {} } }
  ])('rejects renderer-controlled $field before service execution', async ({ field, value }) => {
    await expect(
      router.dispatch('model_api.diagnostics.start', { providerIds: ['provider'], [field]: value }, context)
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expectNoDiagnosticsDelegation()
  })

  it.each([
    { name: 'unknown check', input: { providerIds: ['provider'], checks: ['unknown'] } },
    { name: 'invalid unique model', input: { providerIds: ['provider'], modelSelections: ['invalid'] } },
    {
      name: 'oversized provider batch',
      input: {
        providerIds: Array.from({ length: 51 }, (_, index) => `provider-${index}`)
      }
    }
  ])('rejects $name before service execution', async ({ input }) => {
    await expect(router.dispatch('model_api.diagnostics.start', input, context)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED'
    })
    expectNoDiagnosticsDelegation()
  })

  it.each([
    { runId: 'invalid', requestId },
    { runId, requestId: 'invalid' }
  ])('rejects invalid confirmation identifiers before service execution', async (identifiers) => {
    await expect(
      router.dispatch(
        'model_api.diagnostics.confirm',
        {
          ...identifiers,
          providerId: 'provider'
        },
        context
      )
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expectNoDiagnosticsDelegation()
  })

  it.each([
    { selection: 'omitted', checks: undefined },
    { selection: 'empty', checks: [] }
  ])('accepts $selection basic selections without adding paid checks', async ({ checks }) => {
    const service = application.get('ModelApiDiagnosticsService')
    const output = { status: 'started' as const, state: INITIAL_MODEL_API_DIAGNOSTICS_STATE }
    vi.mocked(service.start).mockReturnValue(output)
    const input = { providerIds: ['provider'], ...(checks === undefined ? {} : { checks }) }

    expect(await router.dispatch('model_api.diagnostics.start', input, context)).toEqual(output)
    expect(service.start).toHaveBeenCalledOnce()
    expect(service.start).toHaveBeenCalledWith(input)
    expect(service.confirm).not.toHaveBeenCalled()
  })
})
