import { setupTestDatabase } from '@test-helpers/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { agentTable } from '@data/db/schemas/agent'
import { agentGroupChatService } from '@data/services/AgentGroupChatService'
import { startAgentSessionRun, type StreamListener } from '@main/ai/streamManager'
import { agentGroupChatHandlers } from '@main/ipc/handlers/agentGroupChat'
import { IpcRouter } from '@main/ipc/IpcRouter'
import { agentGroupChatErrorCodes } from '@shared/ipc/errors/agentGroupChat'
import { IpcErrorCode } from '@shared/ipc/errors/IpcError'
import { agentGroupChatRequestSchemas } from '@shared/ipc/schemas/agentGroupChat'

import { AgentGroupChatOrchestrator } from '../AgentGroupChatOrchestrator'

vi.mock('@main/ai/streamManager', () => ({ startAgentSessionRun: vi.fn() }))

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_AGENT_ID = '22222222-2222-4222-8222-222222222222'

describe('Agent group chat execution', () => {
  const dbh = setupTestDatabase()
  let orchestrator: AgentGroupChatOrchestrator
  let listener: StreamListener

  beforeEach(() => {
    orchestrator = new AgentGroupChatOrchestrator()
    vi.mocked(startAgentSessionRun)
      .mockReset()
      .mockImplementation(async ({ listeners }) => {
        listener = listeners[0]
        return { mode: 'started' }
      })
    dbh.db
      .insert(agentTable)
      .values({
        id: AGENT_ID,
        type: 'claude-code',
        name: 'Dev',
        instructions: 'Help',
        orderKey: 'a0'
      })
      .run()
  })

  it('never publishes partial output or acknowledges an aborted request', async () => {
    const group = agentGroupChatService.create({ name: 'Room', agentIds: [AGENT_ID] })
    const { message } = orchestrator.sendMessage({ groupChatId: group.id, content: '@Dev answer' })
    listener.onChunk({ type: 'text-delta', id: 'partial', delta: 'unfinished' })
    await listener.onPaused({ status: 'paused', isTopicDone: true })

    await vi.waitFor(() => expect(orchestrator.getResponding(group.id).respondingAgentIds).toEqual([]))
    expect(agentGroupChatService.listMessages(group.id).items).toEqual([message])
    expect(agentGroupChatService.findMember(group.id, AGENT_ID)?.lastSeenMessageId).toBeNull()
    expect(application.get('IpcApiService').broadcast).toHaveBeenCalledWith('agent_group_chat.turn_failed', {
      groupChatId: group.id,
      agentId: AGENT_ID,
      reason: 'error'
    })
    expect(listener.isAlive()).toBe(false)
  })

  it('exposes ordered responding snapshots and never fans out agent replies', async () => {
    const group = agentGroupChatService.create({ name: 'Room', agentIds: [AGENT_ID] })
    const initial = orchestrator.getResponding(group.id)
    const { message } = orchestrator.sendMessage({ groupChatId: group.id, content: '@Dev answer' })
    const running = orchestrator.getResponding(group.id)
    expect(running.respondingAgentIds).toEqual([AGENT_ID])
    expect(running.revision).toBeGreaterThan(initial.revision)

    listener.onChunk({ type: 'text-delta', id: 'reply', delta: '@everyone complete' })
    await listener.onDone({ status: 'success', isTopicDone: true })
    await vi.waitFor(() => expect(orchestrator.getResponding(group.id).respondingAgentIds).toEqual([]))
    const complete = orchestrator.getResponding(group.id)
    expect(complete.revision).toBeGreaterThan(running.revision)
    expect(agentGroupChatService.listMessages(group.id).items).toMatchObject([
      { id: message.id, authorType: 'user' },
      { authorType: 'agent', agentId: AGENT_ID, authorName: 'Dev', content: '@everyone complete' }
    ])
    expect(agentGroupChatService.findMember(group.id, AGENT_ID)?.lastSeenMessageId).toBe(message.id)
    expect(startAgentSessionRun).toHaveBeenCalledTimes(1)
    expect(listener.isAlive()).toBe(false)
  })

  it('rejects invalid IPC input and ambiguous mentions before writing messages', async () => {
    dbh.db
      .insert(agentTable)
      .values({
        id: OTHER_AGENT_ID,
        type: 'claude-code',
        name: 'DEV',
        instructions: 'Help',
        orderKey: 'a1'
      })
      .run()
    const group = agentGroupChatService.create({ name: 'Room', agentIds: [AGENT_ID, OTHER_AGENT_ID] })
    const router = new IpcRouter(agentGroupChatRequestSchemas, agentGroupChatHandlers)
    for (const content of ['', '   ', 'x'.repeat(40001)]) {
      await expect(
        router.dispatch(
          'agent_group_chat.send_message',
          { groupChatId: group.id, content },
          {
            senderId: 'test-window'
          }
        )
      ).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED })
    }
    await expect(
      router.dispatch(
        'agent_group_chat.send_message',
        {
          groupChatId: group.id,
          content: 'forged author',
          authorType: 'agent'
        },
        { senderId: 'test-window' }
      )
    ).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION_FAILED })
    await expect(
      router.dispatch(
        'agent_group_chat.send_message',
        {
          groupChatId: group.id,
          content: '@Dev answer'
        },
        { senderId: 'test-window' }
      )
    ).rejects.toMatchObject({ code: agentGroupChatErrorCodes.AMBIGUOUS_MENTION })
    expect(agentGroupChatService.listMessages(group.id).items).toEqual([])
    expect(startAgentSessionRun).not.toHaveBeenCalled()
  })

  it('stores a user-authored message through the command route without starting unmentioned agents', async () => {
    const group = agentGroupChatService.create({ name: 'Room', agentIds: [AGENT_ID] })
    const router = new IpcRouter(agentGroupChatRequestSchemas, agentGroupChatHandlers)
    await expect(
      router.dispatch(
        'agent_group_chat.send_message',
        {
          groupChatId: group.id,
          content: '  Keep this context  '
        },
        { senderId: 'test-window' }
      )
    ).resolves.toMatchObject({
      mentionedAgentIds: [],
      message: { authorType: 'user', agentId: null, content: 'Keep this context' }
    })
    expect(agentGroupChatService.listMessages(group.id).items).toHaveLength(1)
    expect(startAgentSessionRun).not.toHaveBeenCalled()
    await expect(
      router.dispatch(
        'agent_group_chat.get_responding',
        { groupChatId: group.id },
        {
          senderId: 'test-window'
        }
      )
    ).resolves.toMatchObject({ groupChatId: group.id, respondingAgentIds: [], revision: 0 })
  })
})
