import { mockDataApiService, MockDataApiUtils } from '@test-mocks/renderer/DataApiService'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSWRTestWrapper } from '@renderer/data/hooks/__tests__/testUtils'
import { toast } from '@renderer/services/toast'
import type { AgentGroupChatEntity, AgentGroupChatMessageEntity } from '@shared/data/api/schemas/agentGroupChats'
import type { AgentGroupChatRespondingChanged } from '@shared/ipc/schemas/agentGroupChat'

import { useAgentGroupChatMessages, useAgentGroupChats } from '../useAgentGroupChats'

vi.unmock('@data/hooks/useDataApi')

const message = (id: number): AgentGroupChatMessageEntity => ({
  id: String(id),
  groupChatId: 'room',
  authorType: 'user',
  agentId: null,
  authorName: 'User',
  content: `Message ${id}`,
  createdAt: '2026-09-28T00:00:00Z'
})

describe('group chat read recovery', () => {
  const listeners = new Map<string, (payload: unknown) => void>()

  beforeEach(() => {
    MockDataApiUtils.resetMocks()
    listeners.clear()
    vi.mocked(window.api.ipcApi.on).mockImplementation((event, callback) => {
      listeners.set(event, callback)
      return () => {
        listeners.delete(event)
      }
    })
    vi.mocked(window.api.ipcApi.request)
      .mockReset()
      .mockResolvedValue({
        ok: true,
        data: { groupChatId: 'room', respondingAgentIds: [], revision: 0 }
      })
    vi.mocked(mockDataApiService.get).mockResolvedValue({ items: [] })
  })
  afterEach(cleanup)

  // A room's 51st message must not make its first message permanently inaccessible.
  it('loads older messages through the canonical cursor in chronological order', async () => {
    vi.mocked(mockDataApiService.get).mockImplementation(async (_path, options) => {
      if (options?.query?.cursor === '2') return { items: [message(1)] }
      return { items: Array.from({ length: 50 }, (_, index) => message(index + 2)), nextCursor: '2' }
    })
    const { Wrapper } = createSWRTestWrapper()
    const { result } = renderHook(() => useAgentGroupChatMessages('room'), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.messages).toHaveLength(50))
    act(() => result.current.loadNext())
    await waitFor(() => expect(result.current.messages).toHaveLength(51))
    expect(result.current.messages.map(({ content }) => content)).toEqual(
      Array.from({ length: 51 }, (_, index) => `Message ${index + 1}`)
    )
    expect(result.current.hasNext).toBe(false)
  })

  // Re-entering a room must recover a run whose start event happened while unmounted.
  it('recovers an ongoing response from the authoritative snapshot', async () => {
    vi.mocked(window.api.ipcApi.request).mockResolvedValue({
      ok: true,
      data: { groupChatId: 'room', respondingAgentIds: ['agent'], revision: 1 }
    })
    const { Wrapper } = createSWRTestWrapper()
    const { result } = renderHook(() => useAgentGroupChatMessages('room'), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.respondingAgentIds).toEqual(['agent']))
  })

  // A slow initial snapshot must not resurrect an agent after a newer completion event.
  it('ignores an older snapshot and out-of-order responding events', async () => {
    const snapshot = Promise.withResolvers<{ ok: true; data: AgentGroupChatRespondingChanged }>()
    vi.mocked(window.api.ipcApi.request).mockReturnValue(snapshot.promise)
    const { Wrapper } = createSWRTestWrapper()
    const { result } = renderHook(() => useAgentGroupChatMessages('room'), { wrapper: Wrapper })
    act(() =>
      listeners.get('agent_group_chat.responding_changed')?.({
        groupChatId: 'room',
        respondingAgentIds: ['agent'],
        revision: 2
      })
    )
    expect(result.current.respondingAgentIds).toEqual(['agent'])
    act(() =>
      listeners.get('agent_group_chat.responding_changed')?.({
        groupChatId: 'room',
        respondingAgentIds: [],
        revision: 3
      })
    )
    await act(async () =>
      snapshot.resolve({ ok: true, data: { groupChatId: 'room', respondingAgentIds: ['agent'], revision: 1 } })
    )
    act(() =>
      listeners.get('agent_group_chat.responding_changed')?.({
        groupChatId: 'room',
        respondingAgentIds: ['agent'],
        revision: 2
      })
    )
    expect(result.current.respondingAgentIds).toEqual([])
  })

  // Agent changes must update the roster before a user clicks a stale mention button.
  it('refreshes projected member names and deletion after agent notifications', async () => {
    const member = { id: 'member', agentId: 'agent', agentName: 'Old name', sessionId: null, createdAt: '' }
    let rooms: AgentGroupChatEntity[] = [
      { id: 'room', name: 'Room', description: '', members: [member], lastActivityAt: '', createdAt: '', updatedAt: '' }
    ]
    vi.mocked(mockDataApiService.get).mockImplementation(async () => rooms)
    const { Wrapper } = createSWRTestWrapper()
    const { result } = renderHook(() => useAgentGroupChats(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.groupChats[0]?.members[0]?.agentName).toBe('Old name'))
    rooms = [{ ...rooms[0], members: [{ ...member, agentName: 'New name' }] }]
    act(() => MockDataApiUtils.emitDataChange([{ endpoint: '/agents/:agentId', entityIds: ['agent'] }]))
    await waitFor(() => expect(result.current.groupChats[0]?.members[0]?.agentName).toBe('New name'))
    rooms = [{ ...rooms[0], members: [] }]
    act(() => MockDataApiUtils.emitDataChange([{ endpoint: '/agents', kind: 'membership', entityIds: ['agent'] }]))
    await waitFor(() => expect(result.current.groupChats[0]?.members).toEqual([]))
  })

  // A failed read after a committed create must not invite retrying the successful write.
  it('returns the created room when the subsequent list refresh fails', async () => {
    const created: AgentGroupChatEntity = {
      id: 'room',
      name: 'Created room',
      description: '',
      members: [],
      lastActivityAt: '',
      createdAt: '',
      updatedAt: ''
    }
    vi.mocked(mockDataApiService.get).mockResolvedValueOnce([]).mockRejectedValue(new Error('List unavailable'))
    vi.mocked(mockDataApiService.post).mockResolvedValue(created)
    const { Wrapper } = createSWRTestWrapper()
    const { result } = renderHook(() => useAgentGroupChats(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const outcome = await act(async () => result.current.createGroupChat({ name: 'Created room', agentIds: ['agent'] }))
    expect(outcome).toEqual(created)
    expect(toast.error).not.toHaveBeenCalled()
  })
})
