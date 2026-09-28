import * as z from 'zod'

import { AgentGroupChatMessageEntitySchema } from '@shared/data/api/schemas/agentGroupChats'

import { defineRoute } from '../define'

export const agentGroupChatRespondingChangedSchema = z.strictObject({
  groupChatId: z.string(),
  /** Agents currently producing a reply in this room; empty when the room is idle. */
  respondingAgentIds: z.array(z.string()),
  revision: z.number().int().nonnegative()
})
export type AgentGroupChatRespondingChanged = z.infer<typeof agentGroupChatRespondingChangedSchema>

export const SendAgentGroupChatMessageSchema = z.strictObject({
  groupChatId: z.string().min(1),
  content: z.string().trim().min(1).max(40000)
})
export type SendAgentGroupChatMessage = z.infer<typeof SendAgentGroupChatMessageSchema>

export const agentGroupChatRequestSchemas = {
  'agent_group_chat.send_message': defineRoute({
    input: SendAgentGroupChatMessageSchema,
    output: z.strictObject({
      message: AgentGroupChatMessageEntitySchema,
      mentionedAgentIds: z.array(z.string())
    })
  }),
  'agent_group_chat.get_responding': defineRoute({
    input: z.strictObject({ groupChatId: z.string().min(1) }),
    output: agentGroupChatRespondingChangedSchema
  })
}

export const agentGroupChatTurnFailedSchema = z.strictObject({
  groupChatId: z.string(),
  agentId: z.string(),
  reason: z.enum(['busy', 'session-invalid', 'error'])
})
export type AgentGroupChatTurnFailed = z.infer<typeof agentGroupChatTurnFailedSchema>

export type AgentGroupChatEventSchemas = {
  'agent_group_chat.responding_changed': AgentGroupChatRespondingChanged
  'agent_group_chat.turn_failed': AgentGroupChatTurnFailed
}
