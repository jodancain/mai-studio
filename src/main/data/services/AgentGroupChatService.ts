/**
 * Agent Group Chat Service - CRUD for group chats, members, and the group message log.
 *
 * A group chat is a room whose members are agents. The message log is its own
 * table (not agent_session_message): each row carries a Main-authored author
 * snapshot so history survives agent renames/deletes. Member execution sessions
 * are bound lazily by the orchestrator (see ai/agentGroupChat/).
 */

import { and, desc, eq, gt, inArray, isNull, lt } from 'drizzle-orm'

import { application } from '@application'
import { agentTable } from '@data/db/schemas/agent'
import {
  agentGroupChatMemberTable,
  agentGroupChatMessageTable,
  agentGroupChatTable,
  type AgentGroupChatMemberRow,
  type AgentGroupChatMessageRow,
  type AgentGroupChatRow
} from '@data/db/schemas/agentGroupChat'
import type { DbType } from '@data/db/types'
import { loggerService } from '@logger'
import { DataApiErrorFactory } from '@shared/data/api/errors'
import type {
  AgentGroupChatEntity,
  AgentGroupChatMemberEntity,
  AgentGroupChatMessageEntity,
  CreateAgentGroupChatDto,
  UpdateAgentGroupChatDto
} from '@shared/data/api/schemas/agentGroupChats'
import type { CursorPaginationResponse } from '@shared/data/api/types'

import { notifyDataApiDataChange } from '../dataApiDataChange'
import { timestampToISO } from './utils/rowMappers'

const logger = loggerService.withContext('DataApi:AgentGroupChatService')

const DEFAULT_MESSAGE_LIMIT = 50

function rowToMessage(row: AgentGroupChatMessageRow): AgentGroupChatMessageEntity {
  return {
    id: row.id,
    groupChatId: row.groupChatId,
    authorType: row.authorType,
    agentId: row.agentId,
    authorName: row.authorName,
    content: row.content,
    createdAt: timestampToISO(row.createdAt)
  }
}

export class AgentGroupChatService {
  private get db() {
    return application.get('DbService').getDb()
  }

  private membersOf(groupChatIds: readonly string[]): Map<string, AgentGroupChatMemberEntity[]> {
    const result = new Map<string, AgentGroupChatMemberEntity[]>()
    if (groupChatIds.length === 0) return result
    const rows = this.db
      .select({
        member: agentGroupChatMemberTable,
        agentName: agentTable.name,
        agentConfiguration: agentTable.configuration,
        agentDeletedAt: agentTable.deletedAt
      })
      .from(agentGroupChatMemberTable)
      .leftJoin(agentTable, eq(agentGroupChatMemberTable.agentId, agentTable.id))
      .where(inArray(agentGroupChatMemberTable.groupChatId, [...groupChatIds]))
      .orderBy(agentGroupChatMemberTable.id)
      .all()
    for (const row of rows) {
      const avatar = row.agentConfiguration?.avatar
      const entity: AgentGroupChatMemberEntity = {
        id: row.member.id,
        agentId: row.member.agentId,
        agentName: row.agentDeletedAt == null && row.agentName != null ? row.agentName : row.member.agentId,
        agentAvatar: typeof avatar === 'string' ? avatar : undefined,
        sessionId: row.member.sessionId,
        createdAt: timestampToISO(row.member.createdAt)
      }
      const list = result.get(row.member.groupChatId) ?? []
      list.push(entity)
      result.set(row.member.groupChatId, list)
    }
    return result
  }

  private toEntity(row: AgentGroupChatRow, members: AgentGroupChatMemberEntity[]): AgentGroupChatEntity {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      members,
      lastActivityAt: timestampToISO(row.lastActivityAt),
      createdAt: timestampToISO(row.createdAt),
      updatedAt: timestampToISO(row.updatedAt)
    }
  }

  list(): AgentGroupChatEntity[] {
    const rows = this.db.select().from(agentGroupChatTable).orderBy(desc(agentGroupChatTable.lastActivityAt)).all()
    const members = this.membersOf(rows.map((row) => row.id))
    return rows.map((row) => this.toEntity(row, members.get(row.id) ?? []))
  }

  getById(id: string): AgentGroupChatEntity {
    const [row] = this.db.select().from(agentGroupChatTable).where(eq(agentGroupChatTable.id, id)).limit(1).all()
    if (!row) throw DataApiErrorFactory.notFound('AgentGroupChat', id)
    return this.toEntity(row, this.membersOf([row.id]).get(row.id) ?? [])
  }

  create(dto: CreateAgentGroupChatDto): AgentGroupChatEntity {
    const agentIds = [...new Set(dto.agentIds)]
    const groupChatId = application.get('DbService').withWriteTx((tx) => {
      this.assertAgentsExist(tx, agentIds)
      const [group] = tx
        .insert(agentGroupChatTable)
        .values({ name: dto.name, description: dto.description ?? '' })
        .returning()
        .all()
      tx.insert(agentGroupChatMemberTable)
        .values(agentIds.map((agentId) => ({ groupChatId: group.id, agentId })))
        .run()
      return group.id
    })
    this.notifyGroupChange(groupChatId)
    logger.info('Created agent group chat', { groupChatId, memberCount: agentIds.length })
    return this.getById(groupChatId)
  }

  update(id: string, dto: UpdateAgentGroupChatDto): AgentGroupChatEntity {
    application.get('DbService').withWriteTx((tx) => {
      const [row] = tx.select().from(agentGroupChatTable).where(eq(agentGroupChatTable.id, id)).limit(1).all()
      if (!row) throw DataApiErrorFactory.notFound('AgentGroupChat', id)

      const updates: Partial<typeof agentGroupChatTable.$inferInsert> = {}
      if (dto.name !== undefined) updates.name = dto.name
      if (dto.description !== undefined) updates.description = dto.description
      if (Object.keys(updates).length > 0) {
        tx.update(agentGroupChatTable).set(updates).where(eq(agentGroupChatTable.id, id)).run()
      }

      if (dto.agentIds !== undefined) {
        const nextIds = [...new Set(dto.agentIds)]
        this.assertAgentsExist(tx, nextIds)
        const existing = tx
          .select({ agentId: agentGroupChatMemberTable.agentId })
          .from(agentGroupChatMemberTable)
          .where(eq(agentGroupChatMemberTable.groupChatId, id))
          .all()
          .map((memberRow) => memberRow.agentId)
        const removed = existing.filter((agentId) => !nextIds.includes(agentId))
        const added = nextIds.filter((agentId) => !existing.includes(agentId))
        if (removed.length > 0) {
          tx.delete(agentGroupChatMemberTable)
            .where(
              and(eq(agentGroupChatMemberTable.groupChatId, id), inArray(agentGroupChatMemberTable.agentId, removed))
            )
            .run()
        }
        if (added.length > 0) {
          tx.insert(agentGroupChatMemberTable)
            .values(added.map((agentId) => ({ groupChatId: id, agentId })))
            .run()
        }
      }
    })
    this.notifyGroupChange(id)
    return this.getById(id)
  }

  delete(id: string): void {
    const [row] = this.db
      .delete(agentGroupChatTable)
      .where(eq(agentGroupChatTable.id, id))
      .returning({ id: agentGroupChatTable.id })
      .all()
    if (!row) throw DataApiErrorFactory.notFound('AgentGroupChat', id)
    this.notifyGroupChange(id)
    logger.info('Deleted agent group chat', { groupChatId: id })
  }

  /** Newest window in ascending order; `cursor` (exclusive message id) pages older history. */
  listMessages(
    groupChatId: string,
    query: { cursor?: string; limit?: number } = {}
  ): CursorPaginationResponse<AgentGroupChatMessageEntity> {
    this.getById(groupChatId)
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_MESSAGE_LIMIT, 1), 200)
    const filters = [eq(agentGroupChatMessageTable.groupChatId, groupChatId)]
    if (query.cursor) filters.push(lt(agentGroupChatMessageTable.id, query.cursor))
    const rows = this.db
      .select()
      .from(agentGroupChatMessageTable)
      .where(and(...filters))
      .orderBy(desc(agentGroupChatMessageTable.id))
      .limit(limit + 1)
      .all()
    const hasMore = rows.length > limit
    const window = hasMore ? rows.slice(0, limit) : rows
    window.reverse()
    return {
      items: window.map(rowToMessage),
      nextCursor: hasMore ? window[0]?.id : undefined
    }
  }

  /** Latest messages strictly after `afterId`, returned in ascending uuid v7 order. */
  listMessagesAfter(groupChatId: string, afterId: string | null, limit: number): AgentGroupChatMessageEntity[] {
    const filters = [eq(agentGroupChatMessageTable.groupChatId, groupChatId)]
    if (afterId) filters.push(gt(agentGroupChatMessageTable.id, afterId))
    const rows = this.db
      .select()
      .from(agentGroupChatMessageTable)
      .where(and(...filters))
      .orderBy(desc(agentGroupChatMessageTable.id))
      .limit(limit)
      .all()
    return rows.reverse().map(rowToMessage)
  }

  appendMessage(input: {
    groupChatId: string
    authorType: 'user' | 'agent'
    agentId?: string
    authorName: string
    content: string
  }): AgentGroupChatMessageEntity {
    const row = application.get('DbService').withWriteTx((tx) => {
      const [group] = tx
        .select({ id: agentGroupChatTable.id })
        .from(agentGroupChatTable)
        .where(eq(agentGroupChatTable.id, input.groupChatId))
        .limit(1)
        .all()
      if (!group) throw DataApiErrorFactory.notFound('AgentGroupChat', input.groupChatId)
      const [inserted] = tx
        .insert(agentGroupChatMessageTable)
        .values({
          groupChatId: input.groupChatId,
          authorType: input.authorType,
          agentId: input.authorType === 'agent' ? (input.agentId ?? null) : null,
          authorName: input.authorName,
          content: input.content
        })
        .returning()
        .all()
      tx.update(agentGroupChatTable)
        .set({ lastActivityAt: Date.now() })
        .where(eq(agentGroupChatTable.id, input.groupChatId))
        .run()
      return inserted
    })
    this.notifyMessagesChange(input.groupChatId)
    return rowToMessage(row)
  }

  /** Member row lookup for the orchestrator; null when the agent is not (or no longer) a member. */
  findMember(groupChatId: string, agentId: string): AgentGroupChatMemberRow | null {
    const [row] = this.db
      .select()
      .from(agentGroupChatMemberTable)
      .where(
        and(eq(agentGroupChatMemberTable.groupChatId, groupChatId), eq(agentGroupChatMemberTable.agentId, agentId))
      )
      .limit(1)
      .all()
    return row ?? null
  }

  bindMemberSession(memberId: string, sessionId: string): void {
    this.db.update(agentGroupChatMemberTable).set({ sessionId }).where(eq(agentGroupChatMemberTable.id, memberId)).run()
  }

  updateMemberLastSeen(memberId: string, messageId: string): void {
    this.db
      .update(agentGroupChatMemberTable)
      .set({ lastSeenMessageId: messageId })
      .where(eq(agentGroupChatMemberTable.id, memberId))
      .run()
  }

  private assertAgentsExist(tx: Pick<DbType, 'select'>, agentIds: readonly string[]): void {
    if (agentIds.length === 0) return
    const found = tx
      .select({ id: agentTable.id })
      .from(agentTable)
      .where(and(inArray(agentTable.id, [...agentIds]), isNull(agentTable.deletedAt)))
      .all()
      .map((row) => row.id)
    const missing = agentIds.filter((id) => !found.includes(id))
    if (missing.length > 0) throw DataApiErrorFactory.notFound('Agent', missing[0])
  }

  private notifyGroupChange(groupChatId: string): void {
    notifyDataApiDataChange([
      { endpoint: '/agent-group-chats', kind: 'membership', entityIds: [groupChatId] },
      { endpoint: '/agent-group-chats/:groupChatId', routeParams: { groupChatId }, entityIds: [groupChatId] }
    ])
  }

  private notifyMessagesChange(groupChatId: string): void {
    notifyDataApiDataChange([
      {
        endpoint: '/agent-group-chats/:groupChatId/messages',
        kind: 'membership',
        routeParams: { groupChatId }
      },
      { endpoint: '/agent-group-chats', kind: 'projection', entityIds: [groupChatId] }
    ])
  }
}

export const agentGroupChatService = new AgentGroupChatService()
