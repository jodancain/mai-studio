import { readUIMessageStream, type UIMessageChunk } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AiStreamAttachResponse, StreamChunkPayload } from '@shared/ai/transport'
import type { UniqueModelId } from '@shared/data/types/model'
import type { SerializedError } from '@shared/types/error'

import { TopicStreamSubscription } from '../TopicStreamSubscription'

interface IpcMock {
  request: (route: string, input: unknown) => unknown
  on: (event: string, callback: (payload: unknown) => void) => () => void
}

// Production calls ipcApi.request('ai.stream_*') / ipcApi.on('ai.stream_*'). `ipcMock` is
// re-pointed at a fresh createMockAiApi()'s dispatchers in beforeEach.
const { ipcMock } = vi.hoisted((): { ipcMock: IpcMock } => ({
  ipcMock: {
    request: () => undefined,
    on: () => () => {}
  }
}))
vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: (route: string, input: unknown) => ipcMock.request(route, input),
    on: (event: string, cb: (p: unknown) => void) => ipcMock.on(event, cb)
  }
}))

const STREAM_ERROR: SerializedError = { name: 'Error', message: 'boom', stack: null }

// Reuse the established AI-stream mock shape (see IpcChatTransport.test.ts).
function createMockAiApi() {
  const listeners = {
    chunk: [] as Array<(d: StreamChunkPayload) => void>,
    done: [] as Array<
      (d: {
        topicId: string
        executionId?: UniqueModelId
        attemptId?: number
        anchorMessageId?: string
        status: string
        isTopicDone?: boolean
        topicAttemptWatermark?: number
      }) => void
    >,
    error: [] as Array<
      (d: {
        topicId: string
        executionId?: UniqueModelId
        attemptId?: number
        anchorMessageId?: string
        isTopicDone?: boolean
        topicAttemptWatermark?: number
        error: SerializedError
      }) => void
    >
  }
  const mockApi = {
    streamOpen: vi.fn().mockResolvedValue({ mode: 'started' }),
    streamAttach: vi.fn().mockResolvedValue({ status: 'attached', bufferedChunks: [] }),
    streamDetach: vi.fn().mockResolvedValue(undefined),
    streamAbort: vi.fn().mockResolvedValue(undefined),
    onStreamChunk: vi.fn((cb) => {
      listeners.chunk.push(cb)
      return () => listeners.chunk.splice(listeners.chunk.indexOf(cb) >>> 0, 1)
    }),
    onStreamDone: vi.fn((cb) => {
      listeners.done.push(cb)
      return () => listeners.done.splice(listeners.done.indexOf(cb) >>> 0, 1)
    }),
    onStreamError: vi.fn((cb) => {
      listeners.error.push(cb)
      return () => listeners.error.splice(listeners.error.indexOf(cb) >>> 0, 1)
    })
  }
  const request = (route: string, input: unknown): unknown => {
    switch (route) {
      case 'ai.stream.open':
        return mockApi.streamOpen(input)
      case 'ai.stream.attach':
        return mockApi.streamAttach(input)
      case 'ai.stream.detach':
        return mockApi.streamDetach(input)
      case 'ai.stream.abort':
        return mockApi.streamAbort(input)
      default:
        return Promise.resolve(undefined)
    }
  }
  const on = (event: string, cb: (p: unknown) => void): (() => void) => {
    switch (event) {
      case 'ai.stream.chunk':
        return mockApi.onStreamChunk(cb)
      case 'ai.stream.done':
        return mockApi.onStreamDone(cb)
      case 'ai.stream.error':
        return mockApi.onStreamError(cb)
      default:
        return () => {}
    }
  }
  return {
    mockApi,
    request,
    on,
    emitChunk: (
      topicId: string,
      executionId: UniqueModelId,
      chunk: UIMessageChunk,
      anchorMessageId?: string,
      attemptId = 1,
      sequence?: number
    ) => {
      for (const cb of [...listeners.chunk]) cb({ topicId, executionId, attemptId, anchorMessageId, sequence, chunk })
    },
    emitDone: (
      topicId: string,
      executionId: UniqueModelId | undefined,
      status: 'success' | 'paused',
      isTopicDone?: boolean,
      anchorMessageId?: string,
      attemptId = 1,
      topicAttemptWatermark?: number
    ) => {
      for (const cb of [...listeners.done]) {
        cb({ topicId, executionId, attemptId, status, isTopicDone, anchorMessageId, topicAttemptWatermark })
      }
    },
    emitError: (
      topicId: string,
      executionId: UniqueModelId | undefined,
      isTopicDone?: boolean,
      anchorMessageId?: string,
      attemptId = executionId === undefined ? undefined : 1,
      topicAttemptWatermark?: number
    ) => {
      for (const cb of [...listeners.error]) {
        cb({
          topicId,
          executionId,
          attemptId,
          isTopicDone,
          anchorMessageId,
          topicAttemptWatermark,
          error: STREAM_ERROR
        })
      }
    }
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const textChunk = (delta: string): UIMessageChunk => ({ type: 'text-delta', id: 't', delta })

async function readAll(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const reader = stream.getReader()
  const out: UIMessageChunk[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return out
}

const TOPIC = 'topic-1'
const A = 'openai::gpt-4o' as UniqueModelId
const B = 'anthropic::claude' as UniqueModelId

describe('TopicStreamSubscription', () => {
  let mock: ReturnType<typeof createMockAiApi>

  beforeEach(() => {
    mock = createMockAiApi()
    ipcMock.request = mock.request
    ipcMock.on = mock.on
  })

  it('attaches once for the topic regardless of how many executions register', async () => {
    const sub = new TopicStreamSubscription(TOPIC)
    sub.register(A, undefined, 1)
    sub.register(B, undefined, 1)
    await tick()
    expect(mock.mockApi.streamAttach).toHaveBeenCalledTimes(1)
    expect(mock.mockApi.streamAttach).toHaveBeenCalledWith({ topicId: TOPIC })
    sub.dispose()
  })

  it('demuxes chunks to the correct branch by executionId; no cross-contamination', async () => {
    const sub = new TopicStreamSubscription(TOPIC)
    const sa = sub.register(A, undefined, 1)
    const sb = sub.register(B, undefined, 1)
    await tick()

    mock.emitChunk(TOPIC, A, textChunk('helloA'))
    mock.emitChunk(TOPIC, B, textChunk('helloB'))
    mock.emitDone(TOPIC, A, 'success')
    mock.emitDone(TOPIC, B, 'success')

    const [ca, cb] = await Promise.all([readAll(sa), readAll(sb)])
    expect(ca).toEqual([textChunk('helloA')])
    expect(cb).toEqual([textChunk('helloB')])
    sub.dispose()
  })

  it('buffers chunks that arrive before a reader drains (internal queue)', async () => {
    const sub = new TopicStreamSubscription(TOPIC)
    const sa = sub.register(A, undefined, 1)
    await tick()
    mock.emitChunk(TOPIC, A, textChunk('one'))
    mock.emitChunk(TOPIC, A, textChunk('two'))
    mock.emitDone(TOPIC, A, 'success')
    expect(await readAll(sa)).toEqual([textChunk('one'), textChunk('two')])
    sub.dispose()
  })

  it('can listen for stream-open chunks before an execution branch registers', async () => {
    const sub = new TopicStreamSubscription(TOPIC)
    sub.listen()

    mock.emitChunk(TOPIC, A, textChunk('early'))
    const sa = sub.register(A, undefined, 1)
    mock.emitDone(TOPIC, A, 'success')

    expect(await readAll(sa)).toEqual([textChunk('early')])
    sub.dispose()
  })

  it('keeps same-execution continuation branches distinct by anchorMessageId', async () => {
    const sub = new TopicStreamSubscription(TOPIC)
    const first = sub.register(A, 'assistant-1', 1)
    await tick()

    mock.emitChunk(TOPIC, A, textChunk('before-steer'), 'assistant-1')
    mock.emitDone(TOPIC, A, 'success', false, 'assistant-1')

    // The continuation can emit before React registers the new reader. It must
    // buffer under assistant-2 instead of targeting the closed assistant-1 branch.
    mock.emitChunk(TOPIC, A, textChunk('after-steer'), 'assistant-2', 2)
    const second = sub.register(A, 'assistant-2', 2)
    mock.emitDone(TOPIC, A, 'success', true, 'assistant-2', 2)

    expect(await readAll(first)).toEqual([textChunk('before-steer')])
    expect(await readAll(second)).toEqual([textChunk('after-steer')])
    sub.dispose()
  })

  it('keeps repeated attempts on the same model and anchor isolated', async () => {
    const sub = new TopicStreamSubscription(TOPIC)
    const retry = sub.register(A, 'assistant-1', 2)
    await tick()

    mock.emitChunk(TOPIC, A, textChunk('retry'), 'assistant-1', 2)
    // A delayed terminal from the prior attempt must not close the retry branch.
    mock.emitDone(TOPIC, A, 'success', true, 'assistant-1', 1, 1)
    mock.emitChunk(TOPIC, A, textChunk('-continued'), 'assistant-1', 2)
    mock.emitDone(TOPIC, A, 'success', true, 'assistant-1', 2)

    expect(await readAll(retry)).toEqual([textChunk('retry'), textChunk('-continued')])
    sub.dispose()
  })

  it('keeps the topic attached across the done(false) gap before continuation chunks arrive', async () => {
    const sub = new TopicStreamSubscription(TOPIC)
    const first = sub.register(A, 'assistant-1', 1)
    await tick()

    mock.emitDone(TOPIC, A, 'success', false, 'assistant-1')
    expect(await readAll(first)).toEqual([])
    sub.unregister(A, 'assistant-1', 1)
    await tick()

    expect(sub.isTopicOpen()).toBe(true)
    expect(mock.mockApi.streamDetach).not.toHaveBeenCalled()

    mock.emitChunk(TOPIC, A, textChunk('continued'), 'assistant-2', 2)
    const second = sub.register(A, 'assistant-2', 2)
    mock.emitDone(TOPIC, A, 'success', true, 'assistant-2', 2)
    expect(await readAll(second)).toEqual([textChunk('continued')])
    sub.unregister(A, 'assistant-2', 2)
    await tick()

    expect(sub.isTopicOpen()).toBe(false)
    expect(mock.mockApi.streamDetach).toHaveBeenCalledTimes(1)
    sub.dispose()
  })

  it('replays the error part and terminal status when failure arrives before the branch registers', async () => {
    const sub = new TopicStreamSubscription(TOPIC)
    const terminals: Array<{ id: string; attemptId?: number; isAbort: boolean; isError: boolean }> = []
    sub.listen()

    mock.emitError(TOPIC, A)
    const stream = sub.register(A, undefined, 1)
    sub.onExecutionTerminal((id, terminal) => terminals.push({ id, ...terminal }))

    expect(await readAll(stream)).toEqual([{ type: 'data-error', data: STREAM_ERROR }])
    expect(terminals).toEqual([{ id: A, attemptId: 1, isAbort: false, isError: true }])
    sub.dispose()
  })

  it('one execution ending does NOT detach the topic or affect the other branch', async () => {
    const sub = new TopicStreamSubscription(TOPIC)
    const sa = sub.register(A, undefined, 1)
    const sb = sub.register(B, undefined, 1)
    await tick()

    mock.emitChunk(TOPIC, A, textChunk('a1'))
    mock.emitDone(TOPIC, A, 'success')
    sub.unregister(A, undefined, 1)
    await tick()

    expect(mock.mockApi.streamDetach).not.toHaveBeenCalled()

    // B keeps flowing after A is gone.
    mock.emitChunk(TOPIC, B, textChunk('b1'))
    mock.emitChunk(TOPIC, B, textChunk('b2'))
    mock.emitDone(TOPIC, B, 'success', true)
    expect(await readAll(sb)).toEqual([textChunk('b1'), textChunk('b2')])
    expect(await readAll(sa)).toEqual([textChunk('a1')])
    sub.dispose()
  })

  it('detaches the topic exactly once when the LAST execution unregisters', async () => {
    const sub = new TopicStreamSubscription(TOPIC)
    sub.register(A, undefined, 1)
    sub.register(B, undefined, 1)
    await tick()

    sub.unregister(A, undefined, 1)
    await tick()
    expect(mock.mockApi.streamDetach).not.toHaveBeenCalled()

    sub.unregister(B, undefined, 1)
    await tick()
    expect(mock.mockApi.streamDetach).toHaveBeenCalledTimes(1)
    expect(mock.mockApi.streamDetach).toHaveBeenCalledWith({ topicId: TOPIC })
    sub.dispose()
  })

  it('detaches once attach resolves when the execution unregistered while attach was in flight', async () => {
    // Hold streamAttach open so register→unregister both happen before it resolves.
    let resolveAttach!: (res: { status: 'attached'; bufferedChunks: StreamChunkPayload[] }) => void
    mock.mockApi.streamAttach.mockImplementationOnce(
      () =>
        new Promise<{ status: 'attached'; bufferedChunks: StreamChunkPayload[] }>((resolve) => {
          resolveAttach = resolve
        })
    )

    const sub = new TopicStreamSubscription(TOPIC)
    sub.register(A, undefined, 1)
    sub.unregister(A, undefined, 1) // last execution gone, but #attached is still false → deferred-detach guard skips
    await tick()
    expect(mock.mockApi.streamDetach).not.toHaveBeenCalled()

    // Resolving attach must detach once, with no branches left to keep Main's listener.
    resolveAttach({ status: 'attached', bufferedChunks: [] })
    await tick()
    expect(mock.mockApi.streamDetach).toHaveBeenCalledTimes(1)
    expect(mock.mockApi.streamDetach).toHaveBeenCalledWith({ topicId: TOPIC })
    sub.dispose()
  })

  it('never detaches when the last execution is replaced by a new one within the same microtask', async () => {
    const sub = new TopicStreamSubscription(TOPIC)
    sub.register(A, undefined, 1)
    await tick() // attach resolves → #attached === true

    // Unregister the last execution and immediately re-register a new one,
    // synchronously, before the deferred-detach microtask runs.
    sub.unregister(A, undefined, 1)
    sub.register(B, undefined, 1)
    await tick()

    expect(mock.mockApi.streamDetach).not.toHaveBeenCalled()
    expect(mock.mockApi.streamAttach).toHaveBeenCalledTimes(1) // still the same attach
    sub.dispose()
  })

  it('demuxes attach-replay bufferedChunks by executionId', async () => {
    mock.mockApi.streamAttach.mockResolvedValueOnce({
      status: 'attached',
      bufferedChunks: [
        { topicId: TOPIC, executionId: A, attemptId: 1, chunk: textChunk('replayA') },
        { topicId: TOPIC, executionId: B, attemptId: 1, chunk: textChunk('replayB') }
      ] satisfies StreamChunkPayload[]
    })
    const sub = new TopicStreamSubscription(TOPIC)
    const sa = sub.register(A, undefined, 1)
    const sb = sub.register(B, undefined, 1)
    await tick()
    mock.emitDone(TOPIC, undefined, 'success', true)
    expect(await readAll(sa)).toEqual([textChunk('replayA')])
    expect(await readAll(sb)).toEqual([textChunk('replayB')])
    sub.dispose()
  })

  it('assembles one answer when live chunks overlap the initial attach replay', async () => {
    const prefix: UIMessageChunk[] = [
      { type: 'start-step' },
      { type: 'text-start', id: 'answer' },
      { type: 'text-delta', id: 'answer', delta: 'First paragraph. ' }
    ]
    mock.mockApi.streamAttach.mockResolvedValueOnce({
      status: 'attached',
      bufferedChunks: prefix.map((chunk, index) => ({
        topicId: TOPIC,
        executionId: A,
        attemptId: 1,
        sequence: index + 1,
        chunk
      })),
      replayWatermarks: [{ executionId: A, attemptId: 1, sequence: prefix.length }]
    })
    const sub = new TopicStreamSubscription(TOPIC)
    sub.listen()
    prefix.forEach((chunk, index) => mock.emitChunk(TOPIC, A, chunk, undefined, 1, index + 1))
    const stream = sub.register(A, undefined, 1)
    await tick()
    mock.emitChunk(TOPIC, A, { type: 'text-delta', id: 'answer', delta: 'Last paragraph.' }, undefined, 1, 4)
    mock.emitChunk(TOPIC, A, { type: 'text-end', id: 'answer' }, undefined, 1, 5)
    mock.emitDone(TOPIC, A, 'paused', true)

    let finalMessage
    for await (const message of readUIMessageStream({ stream })) finalMessage = message

    expect(finalMessage?.parts).toEqual([
      { type: 'step-start' },
      { type: 'text', text: 'First paragraph. Last paragraph.', state: 'done' }
    ])
    sub.dispose()
  })

  it.each(['success', 'paused', 'error'] as const)(
    'preserves replay and newer live text before an early %s terminal, including repeated steps',
    async (status) => {
      const attach = Promise.withResolvers<AiStreamAttachResponse>()
      mock.mockApi.streamAttach.mockReturnValueOnce(attach.promise)
      const sub = new TopicStreamSubscription(TOPIC)
      const onTerminal = vi.fn()
      sub.onExecutionTerminal(onTerminal)
      const stream = sub.register(A, 'anchor-a', 1)
      const chunks: UIMessageChunk[] = [
        { type: 'start-step' },
        { type: 'text-start', id: 'first' },
        { type: 'text-delta', id: 'first', delta: 'Same answer.' },
        { type: 'text-end', id: 'first' },
        { type: 'finish-step' },
        { type: 'start-step' },
        { type: 'text-start', id: 'second' },
        { type: 'text-delta', id: 'second', delta: 'Same answer.' },
        { type: 'text-end', id: 'second' }
      ]
      chunks.forEach((chunk, index) => mock.emitChunk(TOPIC, A, chunk, 'anchor-a', 1, index + 1))
      if (status === 'error') mock.emitError(TOPIC, A, true, 'anchor-a', 1)
      else mock.emitDone(TOPIC, A, status, true, 'anchor-a', 1)
      attach.resolve({
        status: 'attached',
        bufferedChunks: chunks.slice(0, 3).map((chunk, index) => ({
          topicId: TOPIC,
          executionId: A,
          attemptId: 1,
          anchorMessageId: 'anchor-a',
          sequence: index + 1,
          chunk
        })),
        replayWatermarks: [{ executionId: A, attemptId: 1, anchorMessageId: 'anchor-a', sequence: 3 }]
      })

      let finalMessage
      for await (const message of readUIMessageStream({ stream })) finalMessage = message
      expect(finalMessage?.parts).toEqual([
        { type: 'step-start' },
        { type: 'text', text: 'Same answer.', state: 'done' },
        { type: 'step-start' },
        { type: 'text', text: 'Same answer.', state: 'done' },
        ...(status === 'error' ? [{ type: 'data-error', data: STREAM_ERROR }] : [])
      ])
      expect(onTerminal).toHaveBeenCalledTimes(1)
      expect(onTerminal).toHaveBeenCalledWith(
        A,
        expect.objectContaining({ isAbort: status === 'paused', isError: status === 'error' })
      )
      sub.dispose()
    }
  )

  it('drops delayed replay-covered chunks without dropping a later attempt with restarted sequence numbers', async () => {
    mock.mockApi.streamAttach.mockResolvedValueOnce({
      status: 'attached',
      bufferedChunks: [{ topicId: TOPIC, executionId: A, attemptId: 1, sequence: 5, chunk: textChunk('old') }],
      replayWatermarks: [{ executionId: A, attemptId: 1, sequence: 5 }]
    })
    const sub = new TopicStreamSubscription(TOPIC)
    const oldStream = sub.register(A, undefined, 1)
    await tick()
    mock.emitChunk(TOPIC, A, textChunk('old'), undefined, 1, 5)
    mock.emitChunk(TOPIC, A, textChunk(' tail'), undefined, 1, 6)
    mock.emitDone(TOPIC, A, 'paused', false, undefined, 1)
    expect(await readAll(oldStream)).toEqual([textChunk('old'), textChunk(' tail')])
    sub.unregister(A, undefined, 1)

    const nextStream = sub.register(A, undefined, 2)
    mock.emitChunk(TOPIC, A, textChunk('new'), undefined, 2, 1)
    mock.emitDone(TOPIC, A, 'success', true, undefined, 2)
    expect(await readAll(nextStream)).toEqual([textChunk('new')])
    sub.dispose()
  })

  it.each(['done', 'paused', 'error'] as const)(
    'preserves an early live answer when attach already reports %s',
    async (status) => {
      const attach = Promise.withResolvers<AiStreamAttachResponse>()
      mock.mockApi.streamAttach.mockReturnValueOnce(attach.promise)
      const sub = new TopicStreamSubscription(TOPIC)
      const onTerminal = vi.fn()
      sub.onExecutionTerminal(onTerminal)
      const stream = sub.register(A, undefined, 1)
      mock.emitChunk(TOPIC, A, textChunk('fast answer'), undefined, 1, 1)
      if (status === 'error') mock.emitError(TOPIC, A)
      else mock.emitDone(TOPIC, A, status === 'done' ? 'success' : 'paused')
      attach.resolve(status === 'error' ? { status, error: STREAM_ERROR } : { status, finalMessages: {} })

      expect(await readAll(stream)).toEqual([
        textChunk('fast answer'),
        ...(status === 'error' ? [{ type: 'data-error', data: STREAM_ERROR }] : [])
      ])
      expect(onTerminal).toHaveBeenCalledTimes(1)
      expect(onTerminal).toHaveBeenCalledWith(
        A,
        expect.objectContaining({ isAbort: status === 'paused', isError: status === 'error' })
      )
      sub.dispose()
    }
  )

  it('keeps a sequenced answer that finishes before its reader registers', async () => {
    mock.mockApi.streamAttach.mockResolvedValueOnce({ status: 'done', finalMessages: {} })
    const sub = new TopicStreamSubscription(TOPIC)
    sub.listen()
    const chunks: UIMessageChunk[] = [
      { type: 'start-step' },
      { type: 'text-start', id: 't' },
      textChunk('complete before mount'),
      { type: 'text-end', id: 't' }
    ]
    chunks.forEach((chunk, index) => mock.emitChunk(TOPIC, A, chunk, undefined, 1, index + 1))
    mock.emitDone(TOPIC, A, 'success')
    const stream = sub.register(A, undefined, 1)

    let finalMessage
    for await (const message of readUIMessageStream({ stream })) finalMessage = message
    expect(finalMessage?.parts).toEqual([
      { type: 'step-start' },
      { type: 'text', text: 'complete before mount', state: 'done' }
    ])
    sub.dispose()
  })

  it('keeps a newer attempt behind its own replay boundary when an older attach reports done', async () => {
    const firstAttach = Promise.withResolvers<AiStreamAttachResponse>()
    const nextAttach = Promise.withResolvers<AiStreamAttachResponse>()
    mock.mockApi.streamAttach.mockReturnValueOnce(firstAttach.promise).mockReturnValueOnce(nextAttach.promise)
    const sub = new TopicStreamSubscription(TOPIC)
    const first = sub.register(A, undefined, 1)
    mock.emitChunk(TOPIC, A, textChunk('old'), undefined, 1, 1)
    mock.emitDone(TOPIC, A, 'success', false, undefined, 1)
    mock.emitChunk(TOPIC, A, textChunk('new'), undefined, 2, 1)
    const next = sub.register(A, undefined, 2)
    firstAttach.resolve({ status: 'done', finalMessages: {} })
    await tick()
    nextAttach.resolve({
      status: 'attached',
      bufferedChunks: [{ topicId: TOPIC, executionId: A, attemptId: 2, sequence: 1, chunk: textChunk('new') }],
      replayWatermarks: [{ executionId: A, attemptId: 2, sequence: 1 }]
    })
    await tick()
    mock.emitDone(TOPIC, A, 'success', true, undefined, 2)

    expect(await readAll(first)).toEqual([textChunk('old')])
    expect(await readAll(next)).toEqual([textChunk('new')])
    sub.dispose()
  })

  it('retires covered sibling branches from attach replay when the topic reaches its attempt watermark', async () => {
    mock.mockApi.streamAttach.mockResolvedValueOnce({
      status: 'attached',
      bufferedChunks: [
        { topicId: TOPIC, executionId: A, attemptId: 2, anchorMessageId: 'assistant-a', chunk: textChunk('replayA') },
        { topicId: TOPIC, executionId: B, attemptId: 1, anchorMessageId: 'assistant-b', chunk: textChunk('replayB') }
      ] satisfies StreamChunkPayload[]
    })
    const sub = new TopicStreamSubscription(TOPIC)
    const onTerminal = vi.fn()
    const onRetired = vi.fn()
    sub.onExecutionTerminal(onTerminal)
    sub.onBranchesRetired(onRetired)
    const live = sub.register(B, 'assistant-b', 1)
    await tick()

    mock.emitDone(TOPIC, B, 'success', true, 'assistant-b', 1, 2)

    expect(await readAll(live)).toEqual([textChunk('replayB')])
    expect(onRetired).toHaveBeenCalledWith([{ executionId: A, attemptId: 2, anchorMessageId: 'assistant-a' }])
    expect(onTerminal).toHaveBeenCalledTimes(1)
    expect(onTerminal).toHaveBeenCalledWith(
      B,
      expect.objectContaining({ attemptId: 1, anchorMessageId: 'assistant-b', isError: false })
    )
    expect(sub.hasAnyOpenBranch()).toBe(false)
    sub.dispose()
  })

  it('drains attach replay before closing covered attempts when the topic terminal arrives first', async () => {
    let resolveAttach!: (res: { status: 'attached'; bufferedChunks: StreamChunkPayload[] }) => void
    mock.mockApi.streamAttach.mockImplementationOnce(
      () =>
        new Promise<{ status: 'attached'; bufferedChunks: StreamChunkPayload[] }>((resolve) => {
          resolveAttach = resolve
        })
    )

    const sub = new TopicStreamSubscription(TOPIC)
    const live = sub.register(B, 'assistant-b', 1)
    await tick()

    mock.emitDone(TOPIC, B, 'success', true, 'assistant-b', 1, 2)
    resolveAttach({
      status: 'attached',
      bufferedChunks: [
        { topicId: TOPIC, executionId: A, attemptId: 2, anchorMessageId: 'assistant-a', chunk: textChunk('replayA') },
        { topicId: TOPIC, executionId: B, attemptId: 1, anchorMessageId: 'assistant-b', chunk: textChunk('replayB') }
      ]
    })
    await tick()

    expect(await readAll(live)).toEqual([textChunk('replayB')])
    expect(sub.hasAnyOpenBranch()).toBe(false)
    sub.dispose()
  })

  it('retires covered replay branches on a terminal error watermark', async () => {
    mock.mockApi.streamAttach.mockResolvedValueOnce({
      status: 'attached',
      bufferedChunks: [
        { topicId: TOPIC, executionId: A, attemptId: 1, anchorMessageId: 'assistant-a', chunk: textChunk('replayA') }
      ] satisfies StreamChunkPayload[]
    })
    const sub = new TopicStreamSubscription(TOPIC)
    const onRetired = vi.fn()
    const onTerminal = vi.fn()
    sub.onBranchesRetired(onRetired)
    sub.onExecutionTerminal(onTerminal)
    const live = sub.register(B, 'assistant-b', 2)
    await tick()

    mock.emitError(TOPIC, B, true, 'assistant-b', 2, 2)

    expect(await readAll(live)).toEqual([{ type: 'data-error', data: STREAM_ERROR }])
    expect(onRetired).toHaveBeenCalledWith([{ executionId: A, attemptId: 1, anchorMessageId: 'assistant-a' }])
    expect(onTerminal).toHaveBeenCalledWith(B, expect.objectContaining({ attemptId: 2, isError: true }))
    expect(sub.hasAnyOpenBranch()).toBe(false)
    sub.dispose()
  })

  it('per-execution onStreamDone closes that branch and fires a terminal event', async () => {
    const sub = new TopicStreamSubscription(TOPIC)
    const sa = sub.register(A, undefined, 1)
    const terminals: Array<{ id: string; attemptId?: number; isAbort: boolean; isError: boolean }> = []
    sub.onExecutionTerminal((id, t) => terminals.push({ id, ...t }))
    await tick()

    mock.emitChunk(TOPIC, A, textChunk('x'))
    mock.emitDone(TOPIC, A, 'paused')
    expect(await readAll(sa)).toEqual([textChunk('x')]) // stream closed → read ends
    expect(terminals).toEqual([{ id: A, attemptId: 1, isAbort: true, isError: false }])
    sub.dispose()
  })

  it('dispose() detaches, drops IPC listeners and closes branches', async () => {
    const sub = new TopicStreamSubscription(TOPIC)
    const sa = sub.register(A, undefined, 1)
    await tick()
    sub.dispose()
    expect(mock.mockApi.streamDetach).toHaveBeenCalledTimes(1)
    expect(await readAll(sa)).toEqual([]) // closed by dispose
    // listeners removed: emitting after dispose is a no-op (no throw)
    mock.emitChunk(TOPIC, A, textChunk('late'))
  })

  it('disposes pending live and terminal work and releases a late successful attach', async () => {
    const attach = Promise.withResolvers<AiStreamAttachResponse>()
    mock.mockApi.streamAttach.mockReturnValueOnce(attach.promise)
    const sub = new TopicStreamSubscription(TOPIC)
    const onTerminal = vi.fn()
    sub.onExecutionTerminal(onTerminal)
    const stream = sub.register(A, undefined, 1)
    mock.emitChunk(TOPIC, A, textChunk('discarded'), undefined, 1, 1)
    mock.emitDone(TOPIC, A, 'success')
    sub.dispose()
    attach.resolve({ status: 'attached', bufferedChunks: [] })
    await tick()

    expect(await readAll(stream)).toEqual([])
    expect(onTerminal).not.toHaveBeenCalled()
    expect(sub.hasAnyOpenBranch()).toBe(false)
    expect(mock.mockApi.streamDetach).toHaveBeenCalledTimes(1)
  })

  it('attach not-found closes branches so readers end immediately', async () => {
    mock.mockApi.streamAttach.mockResolvedValueOnce({ status: 'not-found' })
    const sub = new TopicStreamSubscription(TOPIC)
    const sa = sub.register(A, undefined, 1)
    await tick()
    expect(await readAll(sa)).toEqual([])
    sub.dispose()
  })

  it('attach failure closes branches with an error terminal instead of hanging readers', async () => {
    const attach = Promise.withResolvers<AiStreamAttachResponse>()
    mock.mockApi.streamAttach.mockReturnValueOnce(attach.promise)
    const sub = new TopicStreamSubscription(TOPIC)
    const terminals: Array<{ isAbort: boolean; isError: boolean }> = []
    sub.onExecutionTerminal((_id, terminal) => terminals.push(terminal))
    const sa = sub.register(A, undefined, 1)
    mock.emitChunk(TOPIC, A, textChunk('unconfirmed'), undefined, 1, 1)
    mock.emitDone(TOPIC, A, 'success')
    attach.reject(new Error('ipc down'))
    await tick()
    expect(await readAll(sa)).toEqual([])
    expect(terminals).toEqual([expect.objectContaining({ isAbort: false, isError: true })])
    sub.unregister(A, undefined, 1)
    const retry = sub.register(A, undefined, 2)
    await tick()
    mock.emitChunk(TOPIC, A, textChunk('retry'), undefined, 2, 1)
    mock.emitDone(TOPIC, A, 'success', true, undefined, 2)
    expect(await readAll(retry)).toEqual([textChunk('retry')])
    expect(terminals).toHaveLength(2)
    sub.dispose()
  })
})
