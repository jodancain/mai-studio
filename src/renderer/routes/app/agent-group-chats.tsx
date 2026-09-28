import { createFileRoute } from '@tanstack/react-router'

import GroupChatPage from '@renderer/pages/agents/groupChats/GroupChatPage'

export const Route = createFileRoute('/app/agent-group-chats')({
  validateSearch: (search): { groupChatId?: string } => ({
    groupChatId: typeof search.groupChatId === 'string' && search.groupChatId ? search.groupChatId : undefined
  }),
  component: GroupChatPage
})
