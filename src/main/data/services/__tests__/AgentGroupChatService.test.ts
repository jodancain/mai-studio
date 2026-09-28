import { setupTestDatabase } from '@test-helpers/db'
import { describe, expect, it } from 'vitest'

import { agentTable } from '@data/db/schemas/agent'
import { agentGroupChatMemberTable } from '@data/db/schemas/agentGroupChat'
import { agentGroupChatService } from '@data/services/AgentGroupChatService'
import { DataApiError, ErrorCode } from '@shared/data/api/errors'

const AGENT_A = '11111111-1111-4111-8111-111111111111'
const AGENT_B = '22222222-2222-4222-8222-222222222222'
const MISSING_ID = '99999999-9999-4999-8999-999999999999'

describe('AgentGroupChatService', () => {
  const dbh = setupTestDatabase()

  async function seedAgents() {
    await dbh.db.insert(agentTable).values([
      { id: AGENT_A, type: 'claude-code', name: 'Researcher', instructions: 'Help', orderKey: 'a0' },
      { id: AGENT_B, type: 'claude-code', name: 'Dev', instructions: 'Help', orderKey: 'a1' }
    ])
  }

  describe('create', () => {
    it('creates a group chat with member projections from live agents', async () => {
      await seedAgents()
      const group = agentGroupChatService.create({ name: 'Room', agentIds: [AGENT_A, AGENT_B] })

      expect(group.name).toBe('Room')
      expect(group.members.map((member) => member.agentId)).toEqual([AGENT_A, AGENT_B])
      expect(group.members.map((member) => member.agentName)).toEqual(['Researcher', 'Dev'])
      expect(group.members.every((member) => member.sessionId === null)).toBe(true)
    })

    it('rejects creation with an unknown agent and leaves nothing behind', async () => {
      await seedAgents()
      expect(() => agentGroupChatService.create({ name: 'Room', agentIds: [AGENT_A, MISSING_ID] })).toThrowError(
        DataApiError
      )
      expect(agentGroupChatService.list()).toEqual([])
    })
  })

  describe('update', () => {
    it('replaces the member set, keeping surviving member rows (and their cursors)', async () => {
      await seedAgents()
      const group = agentGroupChatService.create({ name: 'Room', agentIds: [AGENT_A, AGENT_B] })
      const memberA = agentGroupChatService.findMember(group.id, AGENT_A)!
      agentGroupChatService.updateMemberLastSeen(memberA.id, 'cursor-1')

      const updated = agentGroupChatService.update(group.id, { agentIds: [AGENT_A] })

      expect(updated.members.map((member) => member.agentId)).toEqual([AGENT_A])
      // The surviving member row is the same row, not a recreated one.
      expect(agentGroupChatService.findMember(group.id, AGENT_A)?.lastSeenMessageId).toBe('cursor-1')
      expect(agentGroupChatService.findMember(group.id, AGENT_B)).toBeNull()
    })
  })

  describe('delete', () => {
    it('removes the group chat and cascades member rows', async () => {
      await seedAgents()
      const group = agentGroupChatService.create({ name: 'Room', agentIds: [AGENT_A] })
      agentGroupChatService.delete(group.id)

      expect(agentGroupChatService.list()).toEqual([])
      const memberRows = await dbh.db.select().from(agentGroupChatMemberTable)
      expect(memberRows).toEqual([])
    })

    it('throws NOT_FOUND for an unknown group chat', () => {
      try {
        agentGroupChatService.delete(MISSING_ID)
        expect.unreachable('delete should throw')
      } catch (error) {
        expect((error as DataApiError).code).toBe(ErrorCode.NOT_FOUND)
      }
    })
  })

  describe('messages', () => {
    it('appends and pages messages: newest window ascending, cursor loads older', async () => {
      await seedAgents()
      const group = agentGroupChatService.create({ name: 'Room', agentIds: [AGENT_A] })
      const ids = ['m1', 'm2', 'm3'].map(
        (text) =>
          agentGroupChatService.appendMessage({
            groupChatId: group.id,
            authorType: 'user',
            authorName: 'User',
            content: text
          }).id
      )

      const lastTwo = agentGroupChatService.listMessages(group.id, { limit: 2 })
      expect(lastTwo.items.map((message) => message.content)).toEqual(['m2', 'm3'])
      expect(lastTwo.nextCursor).toBe(ids[1])

      const older = agentGroupChatService.listMessages(group.id, { cursor: lastTwo.nextCursor })
      expect(older.items.map((message) => message.content)).toEqual(['m1'])
      expect(older.nextCursor).toBeUndefined()
    })

    it('listMessagesAfter returns only strictly newer messages in order', async () => {
      await seedAgents()
      const group = agentGroupChatService.create({ name: 'Room', agentIds: [AGENT_A] })
      const first = agentGroupChatService.appendMessage({
        groupChatId: group.id,
        authorType: 'user',
        authorName: 'User',
        content: 'first'
      })
      agentGroupChatService.appendMessage({
        groupChatId: group.id,
        authorType: 'agent',
        agentId: AGENT_A,
        authorName: 'Researcher',
        content: 'second'
      })

      const unseen = agentGroupChatService.listMessagesAfter(group.id, first.id, 10)
      expect(unseen.map((message) => message.content)).toEqual(['second'])
      expect(agentGroupChatService.listMessagesAfter(group.id, null, 10)).toHaveLength(2)
    })

    it('keeps the triggering mention in the bounded unseen window after a backlog', async () => {
      await seedAgents()
      const group = agentGroupChatService.create({ name: 'Room', agentIds: [AGENT_A] })
      const messages = Array.from({ length: 101 }, (_, index) =>
        agentGroupChatService.appendMessage({
          groupChatId: group.id,
          authorType: 'user',
          authorName: 'User',
          content: index === 100 ? '@Researcher answer this request' : `context ${index}`
        })
      )

      const unseen = agentGroupChatService.listMessagesAfter(group.id, null, 100)
      expect(unseen).toHaveLength(100)
      expect(unseen[0].id).toBe(messages[1].id)
      expect(unseen.at(-1)?.content).toBe('@Researcher answer this request')
      expect(agentGroupChatService.listMessagesAfter(group.id, messages[99].id, 100)).toEqual([messages[100]])
    })

    it('keeps the author name snapshot after the agent is renamed', async () => {
      await seedAgents()
      const group = agentGroupChatService.create({ name: 'Room', agentIds: [AGENT_A] })
      agentGroupChatService.appendMessage({
        groupChatId: group.id,
        authorType: 'agent',
        agentId: AGENT_A,
        authorName: 'Researcher',
        content: 'hello'
      })

      await dbh.db.update(agentTable).set({ name: 'Renamed' })

      const { items } = agentGroupChatService.listMessages(group.id)
      expect(items[0].authorName).toBe('Researcher')
    })

    it('rejects appending to an unknown group chat', () => {
      expect(() =>
        agentGroupChatService.appendMessage({
          groupChatId: MISSING_ID,
          authorType: 'user',
          authorName: 'User',
          content: 'x'
        })
      ).toThrowError(DataApiError)
    })
  })
})
