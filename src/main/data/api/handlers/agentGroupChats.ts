import { agentGroupChatService } from '@data/services/AgentGroupChatService'
import { toDataApiError } from '@shared/data/api/errors'
import {
  type AgentGroupChatSchemas,
  CreateAgentGroupChatSchema,
  ListAgentGroupChatMessagesQuerySchema,
  UpdateAgentGroupChatSchema
} from '@shared/data/api/schemas/agentGroupChats'
import type { HandlersFor } from '@shared/data/api/types'

export const agentGroupChatHandlers: HandlersFor<AgentGroupChatSchemas> = {
  '/agent-group-chats': {
    GET: async () => agentGroupChatService.list(),

    POST: async ({ body }) => {
      const parsed = CreateAgentGroupChatSchema.safeParse(body)
      if (!parsed.success) throw toDataApiError(parsed.error)
      return agentGroupChatService.create(parsed.data)
    }
  },

  '/agent-group-chats/:groupChatId': {
    GET: async ({ params }) => agentGroupChatService.getById(params.groupChatId),

    PATCH: async ({ params, body }) => {
      const parsed = UpdateAgentGroupChatSchema.safeParse(body)
      if (!parsed.success) throw toDataApiError(parsed.error)
      return agentGroupChatService.update(params.groupChatId, parsed.data)
    },

    DELETE: async ({ params }) => {
      agentGroupChatService.delete(params.groupChatId)
      return undefined
    }
  },

  '/agent-group-chats/:groupChatId/messages': {
    GET: async ({ params, query }) => {
      const parsed = ListAgentGroupChatMessagesQuerySchema.safeParse(query ?? {})
      if (!parsed.success) throw toDataApiError(parsed.error)
      return agentGroupChatService.listMessages(params.groupChatId, parsed.data)
    }
  }
}
