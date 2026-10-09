import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { setupTestDatabase } from '@test-helpers/db'
import { MockMainPreferenceServiceUtils } from '@test-mocks/main/PreferenceService'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { agentTable } from '@data/db/schemas/agent'
import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { makeProvider } from '@main/ai/__tests__/fixtures/provider'
import { AiService } from '@main/ai/AiService'
import { listModelsDetailed } from '@main/ai/provider/listModels'
import type * as CustomFetchModule from '@main/ai/utils/customFetch'
import { BaseService } from '@main/core/lifecycle'
import { providerService } from '@main/data/services/ProviderService'
import { ModelApiDiagnosticsService } from '@main/services/ModelApiDiagnosticsService'
import { httpReach } from '@main/services/network/probes'
import { ENDPOINT_TYPE, MODEL_CAPABILITY } from '@shared/data/types/model'
import { DOCTOR_REPORT_TTL_MS, type DoctorCheckId, type DoctorExecutionSnapshot } from '@shared/types/doctor'
import type { DoctorConnectivitySubject } from '@shared/types/doctorConnectivity'
import { doctorStateCacheKey } from '@shared/utils/doctor'

import { DoctorService } from '../DoctorService'

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({
    AiService: { prepareModelCheck: (id: Parameters<AiService['prepareModelCheck']>[0]) => ai.prepareModelCheck(id) },
    DoctorService: {
      checkConnectivity: (input: Parameters<DoctorService['checkConnectivity']>[0]) =>
        doctorInstance.checkConnectivity(input),
      confirmCheck: (input: Parameters<DoctorService['confirmCheck']>[0]) => doctorInstance.confirmCheck(input),
      cancelConnectivity: (...input: Parameters<DoctorService['cancelConnectivity']>) =>
        doctorInstance.cancelConnectivity(...input)
    },
    NetworkService: {
      diagnoseEndpoint: async ({ url }: { url: string }, signal: AbortSignal) => ({
        http: await httpReach(url, { signal, fetchImpl: fetch })
      })
    }
  } as never)
})

vi.mock('@main/ai/utils/customFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof CustomFetchModule>()),
  customFetch: fetch
}))

let ai: AiService
let doctorInstance: DoctorService

class ReadyDoctor extends DoctorService {
  constructor() {
    super()
    this.onAllReady()
  }
}

describe('model connectivity against an HTTP provider', () => {
  const dbh = setupTestDatabase()
  let server: Server
  let url: string
  let listStatus: number
  let listError: { message: string; code?: string }
  let ids: string[]
  let paths: string[]
  let requests: Record<string, unknown>[]
  let modelListRequests: { url: string; authorization?: string }[]
  let holdConversation: boolean
  let holdListing: boolean
  let heldResponsesClosed: number
  let conversationStatus: number
  let streamMode: 'complete' | 'missing_finish' | 'empty'
  let toolMode: 'valid' | 'invalid' | 'text'
  let listResponse: ((url: string) => unknown) | undefined
  let doctor: ReadyDoctor

  beforeEach(async () => {
    BaseService.resetInstances()
    MockMainPreferenceServiceUtils.resetMocks()
    ai = new AiService()
    doctor = new ReadyDoctor()
    doctorInstance = doctor
    holdConversation = false
    holdListing = false
    heldResponsesClosed = 0
    conversationStatus = 200
    streamMode = 'complete'
    toolMode = 'valid'
    listResponse = undefined
    vi.mocked(application.getPath).mockImplementation((namespace, filename) => {
      const root =
        namespace === 'app.root'
          ? process.cwd()
          : namespace === 'feature.provider_registry.data'
            ? path.join(process.cwd(), 'packages/provider-registry/data')
            : `/mock/${namespace}`
      return filename ? path.join(root, filename) : root
    })
    listStatus = 200
    listError = { message: 'test failure' }
    ids = ['wire-model']
    paths = []
    requests = []
    modelListRequests = []
    server = createServer(async (req, res) => {
      paths.push(`${req.method} ${req.url}`)
      if (req.url?.startsWith('/v1/models') || req.url?.startsWith('/v1beta/models')) {
        modelListRequests.push({ url: req.url, authorization: req.headers.authorization })
        if (holdListing) return
        res.writeHead(listStatus, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify(
            listStatus === 200 ? (listResponse?.(req.url) ?? { data: ids.map((id) => ({ id })) }) : { error: listError }
          )
        )
      } else if (req.url === '/v1/chat/completions') {
        let body = ''
        for await (const chunk of req) body += chunk
        requests.push(JSON.parse(body))
        if (holdConversation) {
          res.once('close', () => {
            heldResponsesClosed += 1
          })
          return
        }
        if (conversationStatus !== 200) {
          res.writeHead(conversationStatus, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'probe rejected' } }))
          return
        }
        const request = requests.at(-1)!
        if (request.stream === true) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const chunk = (delta: object, finish: string | null) =>
            `data: ${JSON.stringify({
              id: 'check',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'wire-model',
              choices: [{ index: 0, delta, finish_reason: finish }]
            })}\n\n`
          res.write(chunk({ role: 'assistant', content: streamMode === 'empty' ? '' : 'OK' }, null))
          if (streamMode !== 'missing_finish') res.write(chunk({}, 'stop'))
          res.end('data: [DONE]\n\n')
          return
        }
        if (request.tools && toolMode !== 'text') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'check',
              object: 'chat.completion',
              created: 0,
              model: 'wire-model',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_diagnostic',
                        type: 'function',
                        function: {
                          name: 'diagnostic_echo',
                          arguments: JSON.stringify({ value: toolMode === 'valid' ? 'ok' : 'incorrect' })
                        }
                      }
                    ]
                  },
                  finish_reason: 'tool_calls'
                }
              ],
              usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
            })
          )
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'check',
            object: 'chat.completion',
            created: 0,
            model: 'wire-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
          })
        )
      } else if (req.url === '/api/chat') {
        let body = ''
        for await (const chunk of req) body += chunk
        requests.push(JSON.parse(body))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            model: 'wire-model',
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content: 'ok' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 2,
            eval_count: 1
          })
        )
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    dbh.db
      .insert(userProviderTable)
      .values({
        providerId: 'connectivity',
        name: 'Connectivity',
        orderKey: 'a0',
        isEnabled: true,
        apiKeys: [{ id: 'key-1', key: 'test-key', isEnabled: true }],
        endpointConfigs: { [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: url } }
      })
      .run()
    dbh.db
      .insert(userModelTable)
      .values({
        id: 'connectivity::wire-model',
        providerId: 'connectivity',
        modelId: 'wire-model',
        name: 'Wire model',
        capabilities: [],
        endpointTypes: [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS],
        supportsStreaming: true,
        orderKey: 'a0'
      })
      .run()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await doctor._doStop()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  const subject = { kind: 'chat', providerId: 'connectivity', modelId: 'wire-model' } as const
  const result = (snapshot: DoctorExecutionSnapshot, id: DoctorCheckId) =>
    snapshot.results.find((entry) => entry.id === id)
  const start = async (
    ref: DoctorConnectivitySubject = subject,
    runId = 'run',
    checkIds?: readonly DoctorCheckId[]
  ) => {
    const started = await doctor.checkConnectivity({ subject: ref, runId, checkIds })
    if (started.status !== 'completed') throw new Error(`Unexpected result: ${started.status}`)
    return started
  }
  const confirm = async (started: Awaited<ReturnType<typeof start>>) => {
    const response = await doctor.confirmCheck({
      scope: started.scope,
      runId: started.runId,
      requestId: started.report.pendingChecks[0].requestId
    })
    if (response.status !== 'completed') throw new Error(`Unexpected confirmation: ${response.status}`)
    return response
  }

  it('finishes automatic diagnostics without sending a billable conversation', async () => {
    const started = await start()
    expect(result(started.report, 'network-model-endpoint')).toMatchObject({
      status: 'pass',
      evidence: [{ key: 'httpStatus', value: 404 }]
    })
    expect(result(started.report, 'provider-model-list')?.status).toBe('pass')
    expect(result(started.report, 'provider-model-conversation')).toBeUndefined()
    expect(started.report.pendingChecks).toEqual([
      expect.objectContaining({
        checkId: 'provider-model-conversation',
        confirmation: {
          messageKey: 'settings.doctor.checks.provider-model-conversation.confirmation',
          params: { model: 'Wire model', modelId: 'wire-model', endpoint: url }
        }
      })
    ])
    expect(requests).toEqual([])
    expect(paths.sort()).toEqual(['GET /v1/models', 'HEAD /v1'])
    const confirmed = await confirm(started)
    expect(result(confirmed, 'provider-model-conversation')?.status).toBe('pass')
    expect(confirmed.pendingChecks).toEqual([])
    expect(paths).toHaveLength(3)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      model: 'wire-model',
      messages: [
        { role: 'system', content: 'test' },
        { role: 'user', content: 'hi' }
      ]
    })
    expect(requests[0]).not.toHaveProperty('tools')
  })

  it('verifies stream content and completion only after a single bounded approval', async () => {
    const started = await start(subject, 'stream', ['provider-model-streaming'])
    expect(started.report.pendingChecks[0].checkId).toBe('provider-model-streaming')
    expect(requests).toEqual([])
    const approved = await confirm(started)
    expect(result(approved, 'provider-model-streaming')?.status).toBe('pass')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ model: 'wire-model', stream: true, max_tokens: 64 })
    expect(approved.pendingChecks).toEqual([])
  })

  it.each(['missing_finish', 'empty'] as const)('refuses stream success for %s output', async (mode) => {
    streamMode = mode
    const started = await start(subject, 'stream', ['provider-model-streaming'])
    expect(result(await confirm(started), 'provider-model-streaming')?.status).toBe('fail')
    expect(requests).toHaveLength(1)
  })

  it('verifies a forced schema-valid tool call without executing a tool action', async () => {
    const started = await start(subject, 'tools', ['provider-model-tools'])
    expect(requests).toEqual([])
    expect(result(await confirm(started), 'provider-model-tools')?.status).toBe('pass')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      model: 'wire-model',
      max_tokens: 64,
      tool_choice: { type: 'function', function: { name: 'diagnostic_echo' } },
      tools: [
        {
          type: 'function',
          function: {
            name: 'diagnostic_echo',
            parameters: {
              type: 'object',
              properties: { value: { const: 'ok' } },
              required: ['value'],
              additionalProperties: false
            }
          }
        }
      ]
    })
    expect((requests[0].messages as { role: string }[]).some((message) => message.role === 'tool')).toBe(false)
  })

  it.each(['invalid', 'text'] as const)('refuses tool support evidence from %s replies', async (mode) => {
    toolMode = mode
    const started = await start(subject, 'tools', ['provider-model-tools'])
    expect(result(await confirm(started), 'provider-model-tools')?.status).toBe('fail')
    expect(requests).toHaveLength(1)
  })

  it('invalidates a paid decision when the credential changes under the same key id', async () => {
    const started = await start()
    dbh.db
      .update(userProviderTable)
      .set({ apiKeys: [{ id: 'key-1', key: 'replacement-test-key', isEnabled: true }] })
      .where(eq(userProviderTable.providerId, 'connectivity'))
      .run()
    expect(
      await doctor.confirmCheck({
        scope: started.scope,
        runId: started.runId,
        requestId: started.report.pendingChecks[0].requestId
      })
    ).toEqual({ status: 'stale' })
    expect(requests).toEqual([])
  })

  it('probes a supported candidate before persistence and preserves its exact wire API id', async () => {
    const persisted = (await import('@main/data/services/ModelService')).modelService.getByKey(
      'connectivity',
      'wire-model'
    )
    const prepared = ai.prepareResolvedModelCheck({
      providerId: 'connectivity',
      model: {
        ...persisted,
        id: 'connectivity::candidate',
        apiModelId: 'candidate/api:latest',
        name: 'Candidate'
      }
    })
    await prepared.checkConversation(new AbortController().signal)
    expect(requests).toHaveLength(1)
    expect(requests[0].model).toBe('candidate/api:latest')
    expect(dbh.db.select().from(userModelTable).all()).toHaveLength(1)
  })

  it('keeps free batch reports unverified for inference and exports no credential or URL path', async () => {
    const diagnostics = new ModelApiDiagnosticsService()
    const started = diagnostics.start({ providerIds: ['connectivity'] })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(diagnostics.read().status).toBe('completed'))
    const row = diagnostics.read().providers[0]
    expect(row.testedModelCount).toBe(0)
    expect(row.layers.find((layer) => layer.layer === 'auth')).toMatchObject({
      status: 'unverified',
      code: 'credential_configured'
    })
    expect(row.layers.find((layer) => layer.layer === 'inference')?.status).toBe('unverified')
    expect(row.pendingChecks).toEqual([])
    expect(requests).toEqual([])
    expect(row.endpoint).toBe(new URL(url).host)
    const exported = diagnostics.export({ runId: started.state.runId! }).json
    expect(exported).not.toContain('test-key')
    expect(exported).not.toContain('/v1')
    expect(exported).not.toContain('pendingChecks')
  })

  it('keeps three paid checks independent and consumes a confirmation only once in the batch', async () => {
    const diagnostics = new ModelApiDiagnosticsService()
    const started = diagnostics.start({ providerIds: ['connectivity'], checks: ['conversation', 'streaming', 'tools'] })
    await vi.waitFor(() => expect(diagnostics.read().status).toBe('awaiting_confirmation'))
    expect(requests).toEqual([])
    const row = diagnostics.read().providers[0]
    expect(row.pendingChecks.map((check) => check.kind).sort()).toEqual(['conversation', 'streaming', 'tools'])
    const input = {
      runId: started.state.runId!,
      providerId: row.providerId,
      requestId: row.pendingChecks.find((check) => check.kind === 'tools')!.requestId
    }
    expect((await diagnostics.confirm(input)).status).toBe('completed')
    expect(requests).toHaveLength(1)
    expect((await diagnostics.confirm(input)).status).toBe('stale')
    const after = diagnostics.read().providers[0]
    expect(after.testedModelCount).toBe(1)
    expect(after.layers.find((layer) => layer.layer === 'tools')?.status).toBe('pass')
    expect(after.layers.find((layer) => layer.layer === 'inference')?.status).toBe('pending')
    expect(after.layers.find((layer) => layer.layer === 'auth')?.status).toBe('pass')
    diagnostics.cancel({ runId: input.runId })
    expect(diagnostics.read().providers[0].pendingChecks).toEqual([])
  })

  it('marks canonical complete OpenAI catalogs including unsupported modalities, but malformed rows remain partial', async () => {
    const provider = { ...providerService.getByProviderId('connectivity'), presetProviderId: 'openai' }
    ids = ['wire-model', 'whisper-1']
    const complete = await listModelsDetailed(provider)
    expect(complete.completeness).toBe('complete')
    expect(complete.models.map((model) => model.apiModelId)).toEqual(ids)
    listResponse = () => ({ data: [{ id: 'wire-model' }, { id: '' }] })
    const malformed = await listModelsDetailed(provider)
    expect(malformed.completeness).toBe('partial')
    expect(malformed.models.map((model) => model.apiModelId)).toEqual(['wire-model'])
    expect((await listModelsDetailed({ ...provider, presetProviderId: undefined })).completeness).toBe('partial')
    listResponse = () => ({ data: [{ id: 'wire-model' }], has_more: true })
    expect((await listModelsDetailed(provider)).completeness).toBe('partial')
    listResponse = () => ({ data: [{ id: 'wire-model' }, { id: ' wire-model' }] })
    expect((await listModelsDetailed(provider)).models.map((model) => model.apiModelId)).toEqual([
      'wire-model',
      ' wire-model'
    ])
  })

  it('follows Google page tokens and refuses completeness when a server repeats its cursor', async () => {
    const provider = {
      ...providerService.getByProviderId('connectivity'),
      presetProviderId: 'gemini',
      defaultChatEndpoint: ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT,
      endpointConfigs: { [ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT]: { baseUrl: url.replace('/v1', '/v1beta') } }
    }
    listResponse = (path) =>
      path.includes('pageToken=next')
        ? { models: [{ name: 'models/second' }] }
        : { models: [{ name: 'models/first' }], nextPageToken: 'next' }
    const complete = await listModelsDetailed(provider)
    expect(complete.completeness).toBe('complete')
    expect(complete.models.map((model) => model.apiModelId)).toEqual(['first', 'second'])
    listResponse = () => ({ models: [{ name: 'models/first' }], nextPageToken: 'same' })
    const partial = await listModelsDetailed(provider)
    expect(partial.completeness).toBe('partial')
    expect(partial.models.map((model) => model.apiModelId)).toEqual(['first'])
    expect(paths.filter((path) => path.includes('pageToken=same'))).toHaveLength(1)
    listResponse = () => ({ models: [{ name: 'models/' }] })
    await expect(listModelsDetailed(provider)).rejects.toThrow()
  })

  it('follows Anthropic after_id and requires explicit has_more false before retiring missing models', async () => {
    const provider = { ...providerService.getByProviderId('connectivity'), presetProviderId: 'anthropic' }
    listResponse = (path) =>
      path.includes('after_id=first')
        ? { data: [{ id: 'second' }], has_more: false }
        : { data: [{ id: 'first' }], has_more: true, last_id: 'first' }
    const complete = await listModelsDetailed(provider)
    expect(complete.completeness).toBe('complete')
    expect(complete.models.map((model) => model.apiModelId)).toEqual(['first', 'second'])
    listResponse = () => ({ data: [{ id: 'first' }] })
    expect((await listModelsDetailed(provider)).completeness).toBe('partial')
    listResponse = () => ({ data: [{ id: '' }], has_more: false })
    await expect(listModelsDetailed(provider)).rejects.toThrow()
  })

  it.each([401, 403, 429])(
    'projects actual HTTP %s failures without leaking response text into the batch',
    async (status) => {
      listStatus = status
      listError = { message: 'secret test-key; https://provider.example/private?credential=test-key' }
      const diagnostics = new ModelApiDiagnosticsService()
      diagnostics.start({ providerIds: ['connectivity'] })
      await vi.waitFor(() => expect(diagnostics.read().status).toBe('completed'))
      const row = diagnostics.read().providers[0]
      expect(row.layers.find((layer) => layer.layer === 'model_list')).toMatchObject({
        status: 'fail',
        httpStatus: status
      })
      expect(row.layers.find((layer) => layer.layer === 'auth')?.status).toBe(status === 429 ? 'unverified' : 'fail')
      expect(JSON.stringify(row)).not.toContain('test-key')
      expect(JSON.stringify(row)).not.toContain('/private')
      expect(requests).toEqual([])
    }
  )

  it('invalidates all pending batch decisions after expiration without sending paid requests', async () => {
    const diagnostics = new ModelApiDiagnosticsService()
    const started = diagnostics.start({ providerIds: ['connectivity'], checks: ['conversation', 'streaming', 'tools'] })
    await vi.waitFor(() => expect(diagnostics.read().status).toBe('awaiting_confirmation'))
    const row = diagnostics.read().providers[0]
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(started.state.expiresAt!) + 1)
    try {
      expect(
        (
          await diagnostics.confirm({
            runId: started.state.runId!,
            providerId: row.providerId,
            requestId: row.pendingChecks[0].requestId
          })
        ).status
      ).toBe('stale')
      expect(diagnostics.read().status).toBe('expired')
      expect(diagnostics.read().providers[0].pendingChecks).toEqual([])
      expect(requests).toEqual([])
    } finally {
      clock.mockRestore()
    }
  })

  it('cancels in-flight paid batch HTTP work and cannot attach it to a later batch', async () => {
    const diagnostics = new ModelApiDiagnosticsService()
    const started = diagnostics.start({ providerIds: ['connectivity'], checks: ['streaming'] })
    await vi.waitFor(() => expect(diagnostics.read().status).toBe('awaiting_confirmation'))
    const row = diagnostics.read().providers[0]
    holdConversation = true
    const pending = diagnostics.confirm({
      runId: started.state.runId!,
      providerId: row.providerId,
      requestId: row.pendingChecks[0].requestId
    })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(diagnostics.cancel({ runId: started.state.runId! }).status).toBe('canceled')
    expect((await pending).status).toBe('canceled')
    const next = diagnostics.start({ providerIds: ['connectivity'] })
    await vi.waitFor(() => expect(diagnostics.read().status).toBe('completed'))
    expect(diagnostics.read().runId).toBe(next.state.runId)
    expect(diagnostics.read().providers[0].testedModelCount).toBe(0)
    expect(diagnostics.read().providers[0].layers.find((layer) => layer.layer === 'stream')?.status).toBe('unverified')
    expect(requests).toHaveLength(1)
  })

  it('marks an old batch stale before any paid request after provider credential changes', async () => {
    const diagnostics = new ModelApiDiagnosticsService()
    const started = diagnostics.start({ providerIds: ['connectivity'], checks: ['tools'] })
    await vi.waitFor(() => expect(diagnostics.read().status).toBe('awaiting_confirmation'))
    const row = diagnostics.read().providers[0]
    dbh.db
      .update(userProviderTable)
      .set({ apiKeys: [{ id: 'key-1', key: 'replacement-test-key', isEnabled: true }] })
      .where(eq(userProviderTable.providerId, 'connectivity'))
      .run()
    expect(
      (
        await diagnostics.confirm({
          runId: started.state.runId!,
          providerId: row.providerId,
          requestId: row.pendingChecks[0].requestId
        })
      ).status
    ).toBe('stale')
    expect(diagnostics.read().providers[0].status).toBe('stale')
    expect(requests).toEqual([])
  })

  it('rejects a candidate protocol lacking an explicit configured adapter instead of rerouting it', async () => {
    const persisted = (await import('@main/data/services/ModelService')).modelService.getByKey(
      'connectivity',
      'wire-model'
    )
    expect(() =>
      ai.prepareResolvedModelCheck({
        providerId: 'connectivity',
        model: {
          ...persisted,
          id: 'connectivity::candidate',
          apiModelId: 'candidate',
          endpointTypes: [ENDPOINT_TYPE.ANTHROPIC_MESSAGES]
        }
      })
    ).toThrow('existing supported endpoint')
    expect(requests).toEqual([])
  })

  it('bounds an unresponsive real HTTP conversation and aborts its socket without retrying', async () => {
    holdConversation = true
    const pending = ai.checkModel(
      { uniqueModelId: 'connectivity::wire-model', timeout: 250, requestOptions: { maxRetries: 0 } },
      { chatOnly: true }
    )
    const rejection = expect(pending).rejects.toThrow('Check model timeout')
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await rejection
    await vi.waitFor(() => expect(heldResponsesClosed).toBe(1))
    expect(requests[0]).toMatchObject({ max_tokens: 64 })
    expect(requests).toHaveLength(1)
  })

  it('cancels a main-process remote model listing without altering persisted models or invoking inference', async () => {
    holdListing = true
    const controller = new AbortController()
    const pending = ai.fetchModelsDetailed('connectivity', { signal: controller.signal })
    const rejection = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(paths).toContain('GET /v1/models'))
    controller.abort()
    await rejection
    expect(dbh.db.select().from(userModelTable).all()).toHaveLength(1)
    expect(requests).toEqual([])
  })

  it('skips external CLI providers rather than billing an unrelated HTTP adapter', async () => {
    dbh.db.update(userProviderTable).set({ presetProviderId: 'claude-code' }).run()
    const diagnostics = new ModelApiDiagnosticsService()
    diagnostics.start({ providerIds: ['connectivity'], checks: ['conversation', 'streaming', 'tools'] })
    await vi.waitFor(() => expect(diagnostics.read().status).toBe('completed'))
    const row = diagnostics.read().providers[0]
    expect(row.status).toBe('skipped')
    expect(row.testedModelCount).toBe(0)
    expect(row.layers.every((layer) => layer.status === 'skip' && layer.code === 'external_cli')).toBe(true)
    expect(row.pendingChecks).toEqual([])
    expect(paths).toEqual([])
  })

  it('counts one tested model after a rejected paid request without claiming inference health', async () => {
    conversationStatus = 403
    const diagnostics = new ModelApiDiagnosticsService()
    const started = diagnostics.start({ providerIds: ['connectivity'], checks: ['conversation'] })
    await vi.waitFor(() => expect(diagnostics.read().status).toBe('awaiting_confirmation'))
    const row = diagnostics.read().providers[0]
    await diagnostics.confirm({
      runId: started.state.runId!,
      providerId: row.providerId,
      requestId: row.pendingChecks[0].requestId
    })
    const checked = diagnostics.read().providers[0]
    expect(checked.testedModelCount).toBe(1)
    expect(checked.layers.find((layer) => layer.layer === 'auth')).toMatchObject({ status: 'fail', httpStatus: 403 })
    expect(checked.layers.find((layer) => layer.layer === 'inference')?.status).toBe('fail')
    expect(requests).toHaveLength(1)
  })

  it('never retries a direct health check when a provider rejects the request', async () => {
    conversationStatus = 500
    await expect(ai.checkModel({ uniqueModelId: 'connectivity::wire-model' }, { chatOnly: true })).rejects.toThrow()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ max_tokens: 64 })
  })

  it('keeps a prepared OAuth identity current across token refresh but invalidates a different account', () => {
    const auth = {
      type: 'oauth' as const,
      clientId: 'diagnostic-client',
      accountId: 'account-one',
      refreshToken: 'test-refresh-token',
      accessToken: 'test-access-one',
      expiresAt: 1
    }
    dbh.db.update(userProviderTable).set({ authConfig: auth }).run()
    const prepared = ai.prepareModelCheck('connectivity::wire-model')
    dbh.db
      .update(userProviderTable)
      .set({ authConfig: { ...auth, accessToken: 'test-access-two', expiresAt: 2 } })
      .run()
    expect(prepared.isCurrent()).toBe(true)
    dbh.db
      .update(userProviderTable)
      .set({ authConfig: { ...auth, accountId: 'account-two' } })
      .run()
    expect(prepared.isCurrent()).toBe(false)
  })

  it('uses the selected model endpoint for both the prompt and the actual request', async () => {
    const config = makeProvider({ endpointConfigs: { [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: url } } })
    config.defaultChatEndpoint = ENDPOINT_TYPE.ANTHROPIC_MESSAGES
    config.endpointConfigs![ENDPOINT_TYPE.ANTHROPIC_MESSAGES] = { baseUrl: `${url}/wrong` }
    dbh.db
      .update(userProviderTable)
      .set({ endpointConfigs: config.endpointConfigs, defaultChatEndpoint: config.defaultChatEndpoint })
      .run()
    const started = await start()
    expect(started.report.pendingChecks[0].confirmation.params.endpoint).toBe(url)
    expect(result(await confirm(started), 'provider-model-conversation')?.status).toBe('pass')
    expect(paths).not.toContain('HEAD /v1/wrong')
    expect(paths).toContain('POST /v1/chat/completions')
  })

  it.each([404, 405, 501])(
    'skips unavailable models HTTP %s without preventing a confirmed conversation',
    async (status) => {
      listStatus = status
      const started = await start()
      expect(result(started.report, 'provider-model-list')).toMatchObject({
        status: 'skip',
        detail: { variant: 'endpoint_unavailable' }
      })
      expect(result(await confirm(started), 'provider-model-conversation')?.status).toBe('pass')
    }
  )

  it.each([
    [401, { message: 'Unauthorized' }, 'auth'],
    [403, { message: 'Forbidden' }, 'permission'],
    [403, { message: 'Request rejected', code: 'unsupported_country' }, 'region'],
    [429, { message: 'Request rejected', code: 'insufficient_balance' }, 'quota'],
    [400, { message: 'Invalid API key' }, 'auth']
  ] as const)('preserves the shared classification for models HTTP %s', async (status, error, category) => {
    listStatus = status
    listError = error
    const started = await start()
    expect(result(started.report, 'provider-model-list')).toMatchObject({
      status: 'fail',
      actions: [{ kind: 'navigate', target: '/settings/provider' }],
      evidence: [
        { key: 'category', value: category },
        { key: 'httpStatus', value: status }
      ]
    })
    expect(requests).toEqual([])
    expect(result(await confirm(started), 'provider-model-conversation')?.status).toBe('pass')
  })

  it('does not use registry entries as remote existence evidence', async () => {
    ids = []
    const started = await start()
    expect(result(started.report, 'provider-model-list')).toMatchObject({
      status: 'warn',
      detail: { variant: 'not_listed' },
      actions: [{ kind: 'navigate', target: '/settings/provider' }]
    })
    expect(result(await confirm(started), 'provider-model-conversation')?.status).toBe('pass')
  })

  it('skips registry-only listings without requesting models', async () => {
    dbh.db.update(userProviderTable).set({ presetProviderId: 'claude-code' }).run()
    const started = await start()
    expect(result(started.report, 'provider-model-list')).toMatchObject({
      status: 'skip',
      detail: { variant: 'unsupported' }
    })
    expect(paths).not.toContain('GET /v1/models')
    expect(requests).toEqual([])
  })

  it('keeps MAI registry discovery static by default and lists its configured API only on explicit selection', async () => {
    dbh.db
      .update(userProviderTable)
      .set({
        presetProviderId: 'mai',
        defaultChatEndpoint: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
      })
      .run()
    ids = ['new-model-from-configured-api']

    const configured = await ai.fetchModelsDetailed('connectivity')
    expect(configured.source).toBe('registry')
    expect(configured.completeness).toBe('unsupported')
    expect(configured.models.map((model) => model.apiModelId)).not.toContain(ids[0])
    expect(await ai.listModels({ providerId: 'connectivity' })).toEqual(configured.models)
    expect(paths).toEqual([])

    const discovered = await ai.fetchModelsDetailed('connectivity', { source: 'provider_api' })
    expect(discovered.source).toBe('provider_api')
    expect(discovered.completeness).toBe('partial')
    expect(discovered.models.map((model) => model.apiModelId)).toEqual(ids)
    expect(modelListRequests).toEqual([{ url: '/v1/models', authorization: 'Bearer test-key' }])
    expect(paths).toEqual(['GET /v1/models'])
    expect(requests).toEqual([])
    expect(providerService.getByProviderId('connectivity').modelListSource).toBe('registry')
  })

  it('does not substitute registry models or retry after explicit MAI API discovery fails', async () => {
    dbh.db
      .update(userProviderTable)
      .set({
        presetProviderId: 'mai',
        defaultChatEndpoint: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
      })
      .run()
    listStatus = 401

    await expect(ai.fetchModelsDetailed('connectivity', { source: 'provider_api' })).rejects.toThrow()
    expect(modelListRequests).toEqual([{ url: '/v1/models', authorization: 'Bearer test-key' }])
    expect(paths).toEqual(['GET /v1/models'])
    expect(requests).toEqual([])
    expect(providerService.getByProviderId('connectivity').modelListSource).toBe('registry')
  })

  it('skips API conversation checks for providers using external CLI authentication', async () => {
    dbh.db.update(userProviderTable).set({ presetProviderId: 'claude-code' }).run()
    const started = await start()
    expect(started.report.pendingChecks).toEqual([])
    expect(result(started.report, 'provider-model-conversation')).toMatchObject({
      status: 'skip',
      detail: { variant: 'external_cli' }
    })
    expect(requests).toEqual([])
  })

  it('does not ask for confirmation or generate for an image-only model', async () => {
    dbh.db
      .update(userModelTable)
      .set({
        capabilities: [MODEL_CAPABILITY.IMAGE_GENERATION],
        endpointTypes: [ENDPOINT_TYPE.OPENAI_IMAGE_GENERATION]
      })
      .where(eq(userModelTable.id, 'connectivity::wire-model'))
      .run()
    const started = await start()
    expect(started.report.pendingChecks).toEqual([])
    expect(result(started.report, 'provider-model-conversation')).toMatchObject({
      status: 'skip',
      detail: { variant: 'not_chat_model' }
    })
    expect(requests).toEqual([])
  })

  it('does not retry or fall back after one confirmed request fails', async () => {
    MockMainPreferenceServiceUtils.setPreferenceValue('chat.retry.enabled', true)
    MockMainPreferenceServiceUtils.setPreferenceValue('chat.retry.max_attempts', 3)
    MockMainPreferenceServiceUtils.setPreferenceValue('chat.retry.fallback_model_ids', ['connectivity::backup'])
    dbh.db
      .insert(userModelTable)
      .values({
        id: 'connectivity::backup',
        providerId: 'connectivity',
        modelId: 'backup',
        name: 'Backup',
        capabilities: [],
        endpointTypes: [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS],
        supportsStreaming: true,
        orderKey: 'a1'
      })
      .run()
    conversationStatus = 503
    const started = await start()
    const response = await confirm(started)
    expect(result(response, 'provider-model-conversation')).toMatchObject({
      status: 'fail',
      evidence: [
        { key: 'category', value: 'server' },
        { key: 'httpStatus', value: 503 }
      ]
    })
    expect(requests).toHaveLength(1)
    expect(
      await doctor.confirmCheck({
        scope: started.scope,
        runId: started.runId,
        requestId: started.report.pendingChecks[0].requestId
      })
    ).toEqual({ status: 'stale' })
    expect(requests).toHaveLength(1)
  })

  it('uses a real confirmed Ollama conversation instead of metadata-only health evidence', async () => {
    dbh.db
      .update(userProviderTable)
      .set({
        presetProviderId: 'ollama',
        endpointConfigs: {
          [ENDPOINT_TYPE.OLLAMA_CHAT]: { baseUrl: new URL(url).origin }
        }
      })
      .run()
    dbh.db
      .update(userModelTable)
      .set({ endpointTypes: [ENDPOINT_TYPE.OLLAMA_CHAT] })
      .run()
    const started = await start()
    expect(requests).toEqual([])
    expect(result(await confirm(started), 'provider-model-conversation')?.status).toBe('pass')
    expect(paths).toContain('POST /api/chat')
    expect(paths).not.toContain('POST /api/show')
    expect(requests[0]).toMatchObject({ model: 'wire-model', stream: false })
  })

  it.each(['endpoint', 'model deletion'] as const)('invalidates confirmation after %s changes', async (change) => {
    const started = await start()
    if (change === 'endpoint')
      dbh.db
        .update(userProviderTable)
        .set({
          endpointConfigs: {
            [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: `${url}/wrong` }
          }
        })
        .run()
    else dbh.db.delete(userModelTable).run()
    expect(
      await doctor.confirmCheck({
        scope: started.scope,
        runId: started.runId,
        requestId: started.report.pendingChecks[0].requestId
      })
    ).toEqual({ status: 'stale' })
    expect(requests).toEqual([])
  })

  it('rejects expired, superseded, and wrong-scope confirmations without requests', async () => {
    const first = await start(subject, 'first')
    const second = await start(subject, 'second')
    const input = { scope: second.scope, runId: second.runId, requestId: second.report.pendingChecks[0].requestId }
    expect(
      await doctor.confirmCheck({ ...input, runId: first.runId, requestId: first.report.pendingChecks[0].requestId })
    ).toEqual({ status: 'stale' })
    expect(await doctor.confirmCheck({ ...input, scope: 'agent:other' })).toEqual({ status: 'stale' })
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + DOCTOR_REPORT_TTL_MS + 1)
    expect(await doctor.confirmCheck(input)).toEqual({ status: 'stale' })
    expect(requests).toEqual([])
  })

  it.each(['cancel', 'cancelConnectivity'] as const)(
    'consumes confirmation once and cancels an in-flight request via %s',
    async (cancel) => {
      const started = await start()
      const input = { scope: started.scope, runId: started.runId, requestId: started.report.pendingChecks[0].requestId }
      holdConversation = true
      const pending = doctor.confirmCheck(input)
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      expect(await doctor.confirmCheck(input)).toEqual({ status: 'busy' })
      expect(await doctor.run({ subject, tier: 'quick', checkIds: ['network-online'] })).toEqual({
        status: 'busy',
        runId: started.runId
      })
      expect(await doctor.checkConnectivity({ subject, runId: 'new' })).toEqual({
        status: 'busy',
        runId: started.runId
      })
      expect(doctor[cancel](started.scope, 'wrong-run')).toEqual({ status: 'not_running' })
      expect(doctor[cancel](started.scope, started.runId)).toEqual({ status: 'canceled' })
      expect(await pending).toEqual({ status: 'canceled' })
      expect(await doctor.confirmCheck(input)).toEqual({ status: 'stale' })
      expect(requests).toHaveLength(1)
    }
  )

  it('supersedes a pending connectivity decision with an ordinary run in the same scope', async () => {
    const started = await start()
    const next = await doctor.run({ subject, tier: 'quick', checkIds: ['network-online'] })
    expect(next.status).toBe('completed')
    expect(
      await doctor.confirmCheck({
        scope: started.scope,
        runId: started.runId,
        requestId: started.report.pendingChecks[0].requestId
      })
    ).toEqual({ status: 'stale' })
    expect(requests).toEqual([])
  })

  it('invalidates a pending confirmation when canceled before execution', async () => {
    const started = await start()
    expect(doctor.cancelConnectivity(started.scope, started.runId)).toEqual({ status: 'canceled' })
    expect(
      await doctor.confirmCheck({
        scope: started.scope,
        runId: started.runId,
        requestId: started.report.pendingChecks[0].requestId
      })
    ).toEqual({ status: 'stale' })
    expect(requests).toEqual([])
  })

  it('resolves Agent ownership, detects model reassignment, and preserves another scope report', async () => {
    dbh.db
      .insert(agentTable)
      .values({
        id: 'agent',
        name: 'Agent',
        instructions: '',
        type: 'claude-code',
        model: 'connectivity::wire-model',
        orderKey: 'a0'
      })
      .run()
    const global = await doctor.run({
      subject: { kind: 'global' },
      tier: 'quick',
      checkIds: ['config-boot-config-valid']
    })
    expect(global.status).toBe('completed')
    const before = structuredClone(application.get('CacheService').getShared(doctorStateCacheKey('global')))
    const chat = await start()
    const agent = await start({ kind: 'agent', agentId: 'agent' }, 'agent-run')
    dbh.db.update(agentTable).set({ model: null }).run()
    expect(
      await doctor.confirmCheck({
        scope: agent.scope,
        runId: agent.runId,
        requestId: agent.report.pendingChecks[0].requestId
      })
    ).toEqual({ status: 'stale' })
    expect(result(await confirm(chat), 'provider-model-conversation')?.status).toBe('pass')
    expect(application.get('CacheService').getShared(doctorStateCacheKey('global'))).toEqual(before)
    expect(requests).toHaveLength(1)
  })

  it('applies the same confirmation policy to an explicitly selected ordinary Doctor check', async () => {
    MockMainPreferenceServiceUtils.setPreferenceValue('chat.default_model_id', 'connectivity::wire-model')
    const started = await doctor.run({
      subject: { kind: 'global' },
      tier: 'live',
      checkIds: ['provider-model-conversation']
    })
    if (started.status !== 'completed') throw new Error('Expected report')
    expect(started.report.results).toEqual([])
    expect(requests).toEqual([])
    const response = await doctor.confirmCheck({
      scope: 'global',
      runId: started.report.runId,
      requestId: started.report.pendingChecks![0].requestId
    })
    expect(response.status).toBe('completed')
    expect(application.get('CacheService').getShared(doctorStateCacheKey('global'))).toMatchObject({
      status: 'completed',
      report: {
        runId: started.report.runId,
        pendingChecks: [],
        results: [{ id: 'provider-model-conversation', status: 'pass' }]
      }
    })
    expect(requests).toHaveLength(1)
  })

  it('invalidates a global confirmation if the default model changes', async () => {
    MockMainPreferenceServiceUtils.setPreferenceValue('chat.default_model_id', 'connectivity::wire-model')
    const started = await doctor.run({
      subject: { kind: 'global' },
      tier: 'live',
      checkIds: ['provider-model-conversation']
    })
    if (started.status !== 'completed') throw new Error('Expected report')
    MockMainPreferenceServiceUtils.setPreferenceValue('chat.default_model_id', null)
    expect(
      await doctor.confirmCheck({
        scope: 'global',
        runId: started.report.runId,
        requestId: started.report.pendingChecks![0].requestId
      })
    ).toEqual({ status: 'stale' })
    expect(requests).toEqual([])
  })

  it('refuses missing Agent targets instead of falling back to the default model', async () => {
    await expect(
      doctor.checkConnectivity({ subject: { kind: 'agent', agentId: 'missing' }, runId: 'run' })
    ).rejects.toThrow()
    expect(paths).toEqual([])
  })

  it('aborts confirmed HTTP work on shutdown and refuses pending decisions', async () => {
    const started = await start()
    const input = { scope: started.scope, runId: started.runId, requestId: started.report.pendingChecks[0].requestId }
    holdConversation = true
    const pending = doctor.confirmCheck(input)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await doctor._doStop()
    expect(await pending).toEqual({ status: 'canceled' })
    await expect(doctor.confirmCheck(input)).rejects.toThrow('not ready')
  })
})
