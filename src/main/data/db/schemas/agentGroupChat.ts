import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

import { createUpdateTimestamps, uuidPrimaryKey, uuidPrimaryKeyOrdered } from './_columnHelpers'
import { agentTable } from './agent'
import { agentSessionTable } from './agentSession'

export const agentGroupChatTable = sqliteTable(
  'agent_group_chat',
  {
    id: uuidPrimaryKey(),
    name: text().notNull(),
    description: text().notNull().default(''),
    // Dedicated conversation activity time, mirroring agent_session.lastActivityAt semantics.
    lastActivityAt: integer().notNull().$defaultFn(Date.now),
    ...createUpdateTimestamps
  },
  (t) => [index('agent_group_chat_last_activity_at_idx').on(t.lastActivityAt)]
)

export const agentGroupChatMemberTable = sqliteTable(
  'agent_group_chat_member',
  {
    // uuid v7: intra-ms monotonic ids keep roster order deterministic for batch inserts.
    id: uuidPrimaryKeyOrdered(),
    groupChatId: text()
      .notNull()
      .references(() => agentGroupChatTable.id, { onDelete: 'cascade' }),
    agentId: text()
      .notNull()
      .references(() => agentTable.id, { onDelete: 'cascade' }),
    // The member's dedicated execution session for this room, created lazily on first mention.
    sessionId: text().references(() => agentSessionTable.id, { onDelete: 'set null' }),
    // Group-log cursor: id (uuid v7, time-ordered) of the last message already carried into the
    // member's session transcript, so each group message reaches a member exactly once.
    lastSeenMessageId: text(),
    ...createUpdateTimestamps
  },
  (t) => [
    uniqueIndex('agent_group_chat_member_group_agent_uniq').on(t.groupChatId, t.agentId),
    index('agent_group_chat_member_agent_id_idx').on(t.agentId),
    index('agent_group_chat_member_session_id_idx').on(t.sessionId)
  ]
)

export const agentGroupChatMessageTable = sqliteTable(
  'agent_group_chat_message',
  {
    id: uuidPrimaryKeyOrdered(),
    groupChatId: text()
      .notNull()
      .references(() => agentGroupChatTable.id, { onDelete: 'cascade' }),
    authorType: text({ enum: ['user', 'agent'] }).notNull(),
    agentId: text().references(() => agentTable.id, { onDelete: 'set null' }),
    // Main-authored author snapshot so historical messages keep the name the author had at
    // write time, independent of later agent renames or deletion.
    authorName: text().notNull(),
    content: text().notNull(),
    ...createUpdateTimestamps
  },
  (t) => [
    index('agent_group_chat_message_group_created_id_idx').on(t.groupChatId, t.createdAt, t.id),
    check(
      'agent_group_chat_message_author_check',
      sql`(${t.authorType} = 'user' AND ${t.agentId} IS NULL) OR ${t.authorType} = 'agent'`
    )
  ]
)

export type AgentGroupChatRow = typeof agentGroupChatTable.$inferSelect
export type AgentGroupChatMemberRow = typeof agentGroupChatMemberTable.$inferSelect
export type AgentGroupChatMessageRow = typeof agentGroupChatMessageTable.$inferSelect
export type InsertAgentGroupChatMessageRow = typeof agentGroupChatMessageTable.$inferInsert
