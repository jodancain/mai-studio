import { mockDataApiService, MockDataApiUtils } from '@test-mocks/renderer/DataApiService'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as CherryStudioUi from '@cherrystudio/ui'
import { createSWRTestWrapper } from '@renderer/data/hooks/__tests__/testUtils'
import i18n from '@renderer/i18n/resolver'
import { toast } from '@renderer/services/toast'
import type { AgentGroupChatEntity, AgentGroupChatMessageEntity } from '@shared/data/api/schemas/agentGroupChats'
import { agentGroupChatErrorCodes } from '@shared/ipc/errors/agentGroupChat'

import GroupChatPage from '../GroupChatPage'

vi.unmock('@data/hooks/useDataApi')
vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal<typeof CherryStudioUi>())
vi.mock('@tanstack/react-router', () => ({
  getRouteApi: () => ({ useSearch: () => ({ groupChatId: 'room' }) }),
  useNavigate: () => vi.fn()
}))

const message: AgentGroupChatMessageEntity = {
  id: 'latest',
  groupChatId: 'room',
  authorType: 'user',
  agentId: null,
  authorName: 'User',
  content: 'Latest message',
  createdAt: '2026-09-28T00:00:00Z'
}
const room: AgentGroupChatEntity = {
  id: 'room',
  name: 'Project room',
  description: '',
  lastActivityAt: '',
  createdAt: '',
  updatedAt: '',
  members: [{ id: 'member', agentId: 'agent', agentName: 'Dev', sessionId: null, createdAt: '' }]
}

describe('group chat composer and history', () => {
  const scrollIntoView = vi.fn()

  beforeEach(async () => {
    MockDataApiUtils.resetMocks()
    await i18n.changeLanguage('en-us')
    scrollIntoView.mockClear()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    vi.mocked(window.api.ipcApi.on).mockImplementation(() => () => {})
    vi.mocked(window.api.ipcApi.request)
      .mockReset()
      .mockImplementation(async (route) => {
        if (route === 'agent_group_chat.get_responding') {
          return { ok: true, data: { groupChatId: 'room', respondingAgentIds: [], revision: 0 } }
        }
        return { ok: true, data: { message, mentionedAgentIds: ['agent'] } }
      })
    vi.mocked(mockDataApiService.get).mockImplementation(async (path) => {
      if (path === '/agent-group-chats') return [room]
      if (path === '/agents') return { items: [{ id: 'agent', name: 'Dev', configuration: {} }], total: 1 }
      return { items: [message] }
    })
  })
  afterEach(cleanup)

  const mount = () => {
    const { Wrapper } = createSWRTestWrapper()
    return render(<GroupChatPage />, { wrapper: Wrapper })
  }

  // Rejected sends must retain the user's work and provide an actionable ambiguity hint.
  it('preserves the draft after an ambiguous mention is rejected', async () => {
    const user = userEvent.setup()
    vi.mocked(window.api.ipcApi.request).mockImplementation(async (route) =>
      route === 'agent_group_chat.send_message'
        ? { ok: false, error: { code: agentGroupChatErrorCodes.AMBIGUOUS_MENTION, message: 'Ambiguous mention' } }
        : { ok: true, data: { groupChatId: 'room', respondingAgentIds: [], revision: 0 } }
    )
    mount()
    const composer = await screen.findByRole('textbox')
    await user.type(composer, '@Dev please review')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
    expect(composer).toHaveValue('@Dev please review')
    expect(toast.error).toHaveBeenCalledWith(
      'This name matches multiple members. Choose a member button to mention the right agent.'
    )
  })

  // A successful in-flight send must not clear text the user has edited in the meantime.
  it('keeps a newer draft when the previous send completes', async () => {
    const user = userEvent.setup()
    const sent = Promise.withResolvers<unknown>()
    vi.mocked(window.api.ipcApi.request).mockImplementation(async (route) =>
      route === 'agent_group_chat.send_message'
        ? sent.promise
        : { ok: true, data: { groupChatId: 'room', respondingAgentIds: [], revision: 0 } }
    )
    mount()
    const composer = await screen.findByRole('textbox')
    await user.type(composer, '@Dev first message')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.clear(composer)
    await user.type(composer, 'next message')
    await act(async () => sent.resolve({ ok: true, data: { message, mentionedAgentIds: ['agent'] } }))
    expect(composer).toHaveValue('next message')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(composer).toHaveValue(''))
  })

  // Pasting an oversized message should be bounded before the backend rejects it.
  it('limits pasted text to the server message limit', async () => {
    const user = userEvent.setup()
    mount()
    const composer = await screen.findByRole('textbox')
    await user.click(composer)
    await user.paste('x'.repeat(40001))
    expect(composer).toHaveValue('x'.repeat(40000))
  })

  // Clicking equal-name or alias-named members must address the selected identity only.
  it('uses stable identity mentions for duplicate and reserved names', async () => {
    const user = userEvent.setup()
    const members = [
      { ...room.members[0], id: 'one', agentId: 'a1', agentName: 'Dev' },
      { ...room.members[0], id: 'two', agentId: 'a2', agentName: 'dev' },
      { ...room.members[0], id: 'three', agentId: 'a3', agentName: 'all' }
    ]
    vi.mocked(mockDataApiService.get).mockImplementation(async (path) =>
      path === '/agent-group-chats' ? [{ ...room, members }] : { items: [message] }
    )
    mount()
    const composer = await screen.findByRole('textbox')
    await user.click(screen.getByRole('button', { name: /@dev$/ }))
    await user.click(screen.getByRole('button', { name: /@all$/ }))
    expect(composer).toHaveValue('@{a2} @{a3} ')
  })

  // Fetching older context must reveal it without jumping back to the latest message.
  it('prepends older history without scrolling to the bottom', async () => {
    const user = userEvent.setup()
    vi.mocked(mockDataApiService.get).mockImplementation(async (path, options) => {
      if (path === '/agent-group-chats') return [room]
      if (options?.query?.cursor === 'latest') return { items: [{ ...message, id: 'older', content: 'Older context' }] }
      return { items: [message], nextCursor: 'latest' }
    })
    mount()
    await screen.findByText('Latest message')
    const scrollsBeforeLoading = scrollIntoView.mock.calls.length
    await user.click(screen.getByRole('button', { name: 'Load older messages' }))
    expect(await screen.findByText('Older context')).toBeVisible()
    expect(screen.getByText('Latest message')).toBeVisible()
    expect(scrollIntoView.mock.calls.length).toBe(scrollsBeforeLoading)
  })

  // A failed creation must preserve the selected members and name for correction or retry.
  it('keeps the create form after failure and closes it only after success', async () => {
    const user = userEvent.setup()
    vi.mocked(mockDataApiService.post)
      .mockRejectedValueOnce(new Error('Selected agent was deleted'))
      .mockResolvedValueOnce(room)
    mount()
    await user.click(await screen.findByRole('button', { name: 'New Group Chat' }))
    const nameInput = screen.getByPlaceholderText('Group chat name')
    await user.type(nameInput, 'Review team')
    await user.click(await screen.findByRole('checkbox', { name: /Dev/ }))
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled())
    expect(screen.getByRole('dialog', { name: 'New Group Chat' })).toBeVisible()
    expect(nameInput).toHaveValue('Review team')
    expect(screen.getByRole('checkbox', { name: /Dev/ })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Group Chat' })).not.toBeInTheDocument())
  })
})
