import { setupTestDatabase } from '@test-helpers/db'
import { v7 as uuidv7 } from 'uuid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentTable } from '@data/db/schemas/agent'
import { agentSessionTable } from '@data/db/schemas/agentSession'
import { agentWorkspaceTable } from '@data/db/schemas/agentWorkspace'
import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { agentSessionMessageService } from '@data/services/AgentSessionMessageService'
import { BaseService } from '@main/core/lifecycle/BaseService'
import { createUniqueModelId } from '@shared/data/types/model'

import { AgentSessionRuntimeService } from '../../../agentSession/AgentSessionRuntimeService'
import { TerminalPersistenceError } from '../../listeners/PersistenceListener'
import type { StreamListener } from '../../types'
import { AgentChatContextProvider, type ValidatedAgentDispatch } from '../AgentChatContextProvider'

const state = vi.hoisted(() => ({ runtime: undefined as AgentSessionRuntimeService | undefined }))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  const base = mockApplicationFactory()
  const originalGet = base.application.get
  base.application.get = vi.fn((name: string) => {
    if (name === 'AgentSessionRuntimeService') return state.runtime
    if (name === 'AiStreamManager') return { broadcastTopicError: vi.fn() }
    return originalGet(name)
  })
  return base
})

describe('AgentChatContextProvider cancellation ownership', () => {
  const dbh = setupTestDatabase()
  const provider = new AgentChatContextProvider()

  beforeEach(() => {
    BaseService.resetInstances()
    state.runtime = new AgentSessionRuntimeService()
    dbh.db.insert(userProviderTable).values({ providerId: 'test', name: 'Test', orderKey: 'a0' }).run()
    dbh.db
      .insert(userModelTable)
      .values({
        id: 'test::model',
        providerId: 'test',
        modelId: 'model',
        name: 'Model',
        capabilities: [],
        supportsStreaming: true,
        orderKey: 'a0'
      })
      .run()
    dbh.db
      .insert(agentTable)
      .values({
        id: 'agent-1',
        name: 'Agent',
        type: 'test-runtime',
        model: 'test::model',
        instructions: '',
        orderKey: 'a0'
      })
      .run()
    dbh.db
      .insert(agentWorkspaceTable)
      .values({
        id: 'workspace-1',
        name: 'Workspace',
        path: '/tmp/workspace',
        type: 'user',
        orderKey: 'a0'
      })
      .run()
    dbh.db
      .insert(agentSessionTable)
      .values({
        id: 'session-1',
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        name: 'Session',
        orderKey: 'a0'
      })
      .run()
  })

  afterEach(async () => {
    await state.runtime?.closeSession('session-1')
    vi.restoreAllMocks()
  })

  function prepare() {
    const validated: ValidatedAgentDispatch = {
      sessionId: 'session-1',
      topicId: 'agent-session:session-1',
      agentId: 'agent-1',
      agentUpdatedAt: new Date(0).toISOString(),
      agentType: 'test-runtime',
      agentName: 'Agent',
      uniqueModelId: createUniqueModelId('test', 'model'),
      reasoningEffort: 'default',
      serviceTier: 'standard',
      headless: false,
      messageSnapshot: {
        id: 'agent-1',
        name: 'Agent',
        emoji: '🤖',
        model: { id: 'model', name: 'Model', provider: 'test' }
      },
      userMessageId: uuidv7(),
      userMessageParts: [{ type: 'text', text: 'hello' }],
      shouldAutoNameInitialTurn: false
    }
    const subscriber: StreamListener = {
      id: 'test',
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onPaused: vi.fn(),
      onError: vi.fn(),
      isAlive: () => true
    }
    return provider.activateDispatch(provider.persistDispatchTx(dbh.db, validated), subscriber)
  }

  it('persists the reserved turn as paused and releases the runtime before a subsequent dispatch', async () => {
    const prepared = prepare()
    const assistantId = prepared.models[0].request.messageId!
    expect(agentSessionMessageService.getSessionMessage('session-1', assistantId).status).toBe('pending')
    expect(state.runtime!.isSessionBusy('session-1')).toBe(true)

    await prepared.cancelPreparation!(new DOMException('Stopped', 'AbortError'))

    expect(prepared.models[0].abortController!.signal.aborted).toBe(true)
    expect(agentSessionMessageService.getSessionMessage('session-1', assistantId).status).toBe('paused')
    expect(state.runtime!.isSessionBusy('session-1')).toBe(false)
    const next = prepare()
    expect(state.runtime!.isSessionBusy('session-1')).toBe(true)
    expect(agentSessionMessageService.getSessionMessage('session-1', assistantId).status).toBe('paused')
    await next.cancelPreparation!(new DOMException('Stopped', 'AbortError'))
  })

  it('surfaces a paused-write failure, marks the reservation terminal, and still releases the runtime', async () => {
    const prepared = prepare()
    const assistantId = prepared.models[0].request.messageId!
    vi.spyOn(agentSessionMessageService, 'saveMessage').mockImplementationOnce(() => {
      throw new Error('disk write failed')
    })

    await expect(prepared.cancelPreparation!(new DOMException('Stopped', 'AbortError'))).rejects.toBeInstanceOf(
      TerminalPersistenceError
    )

    expect(agentSessionMessageService.getSessionMessage('session-1', assistantId).status).toBe('error')
    expect(state.runtime!.isSessionBusy('session-1')).toBe(false)
  })
})
