/**
 * Agent group chat domain API Schema definitions.
 *
 * A group chat is a user-managed room whose members are agents. Group messages
 * form their own log (`agent_group_chat_message`); each member agent executes in
 * a dedicated agent session bound lazily on first mention.
 */

import * as z from 'zod'

import type { CursorPaginationResponse } from '../types'

// ============================================================================
// Entity & DTOs
// ============================================================================

export const AgentGroupChatNameSchema = z.string().min(1).max(255)

export const AgentGroupChatMemberEntitySchema = z.strictObject({
  id: z.string(),
  agentId: z.string(),
  /** Live agent projection for display; falls back to the agent id when the agent row is gone. */
  agentName: z.string(),
  agentAvatar: z.string().optional(),
  /** The member's bound execution session, present once the member has responded at least once. */
  sessionId: z.string().nullable(),
  createdAt: z.string()
})
export type AgentGroupChatMemberEntity = z.infer<typeof AgentGroupChatMemberEntitySchema>

export const AgentGroupChatEntitySchema = z.strictObject({
  id: z.string(),
  name: AgentGroupChatNameSchema,
  description: z.string(),
  members: z.array(AgentGroupChatMemberEntitySchema),
  lastActivityAt: z.iso.datetime(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type AgentGroupChatEntity = z.infer<typeof AgentGroupChatEntitySchema>

export const AgentGroupChatMessageEntitySchema = z.strictObject({
  id: z.string(),
  groupChatId: z.string(),
  authorType: z.enum(['user', 'agent']),
  /** Author agent id; null for user messages and for messages whose agent was deleted. */
  agentId: z.string().nullable(),
  /** Author display name captured at write time (survives agent rename/delete). */
  authorName: z.string(),
  content: z.string(),
  createdAt: z.string()
})
export type AgentGroupChatMessageEntity = z.infer<typeof AgentGroupChatMessageEntitySchema>

export const CreateAgentGroupChatSchema = z.strictObject({
  name: AgentGroupChatNameSchema,
  description: z.string().max(2000).optional(),
  agentIds: z.array(z.string().min(1)).min(1).max(20)
})
export type CreateAgentGroupChatDto = z.infer<typeof CreateAgentGroupChatSchema>

export const UpdateAgentGroupChatSchema = z.strictObject({
  name: AgentGroupChatNameSchema.optional(),
  description: z.string().max(2000).optional(),
  /** Replaces the member set. Removed members keep their sessions; rows are just unlinked. */
  agentIds: z.array(z.string().min(1)).min(1).max(20).optional()
})
export type UpdateAgentGroupChatDto = z.infer<typeof UpdateAgentGroupChatSchema>

/**
 * Query for `GET /agent-group-chats/:groupChatId/messages`. Returns the newest
 * window in ascending order; `cursor` pages older history (exclusive cursor =
 * message id, which is uuid v7 time-ordered).
 */
export const ListAgentGroupChatMessagesQuerySchema = z.strictObject({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional()
})
export type ListAgentGroupChatMessagesQueryParams = z.input<typeof ListAgentGroupChatMessagesQuerySchema>

// ============================================================================
// API Schema definitions
// ============================================================================

export type AgentGroupChatSchemas = {
  '/agent-group-chats': {
    GET: {
      response: AgentGroupChatEntity[]
    }
    POST: {
      body: CreateAgentGroupChatDto
      response: AgentGroupChatEntity
    }
  }

  '/agent-group-chats/:groupChatId': {
    GET: {
      params: { groupChatId: string }
      response: AgentGroupChatEntity
    }
    PATCH: {
      params: { groupChatId: string }
      body: UpdateAgentGroupChatDto
      response: AgentGroupChatEntity
    }
    DELETE: {
      params: { groupChatId: string }
      response: void
    }
  }

  '/agent-group-chats/:groupChatId/messages': {
    GET: {
      params: { groupChatId: string }
      query?: ListAgentGroupChatMessagesQueryParams
      response: CursorPaginationResponse<AgentGroupChatMessageEntity>
    }
  }
}
