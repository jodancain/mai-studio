import { describe, expect, it } from 'vitest'

import { AmbiguousGroupChatMentionError, resolveMentions } from '../mentions'

const members = [
  { agentId: 'a1', agentName: 'Researcher' },
  { agentId: 'a2', agentName: 'Dev' },
  { agentId: 'a3', agentName: 'DevOps' }
]

describe('resolveMentions', () => {
  it('returns only members actually mentioned', () => {
    expect(resolveMentions('@Researcher please check this', members)).toEqual(['a1'])
  })

  it('matches case-insensitively', () => {
    expect(resolveMentions('hey @researcher and @DEVOPS', members)).toEqual(['a1', 'a3'])
  })

  it('does not let a shorter name swallow a longer one', () => {
    // "@DevOps" must resolve to DevOps only, not to Dev via prefix match.
    expect(resolveMentions('@DevOps deploy it', members)).toEqual(['a3'])
  })

  it('still resolves the shorter name when both are mentioned', () => {
    expect(resolveMentions('@Dev and @DevOps split the work', members)).toEqual(['a2', 'a3'])
  })

  it('returns every member for room-wide aliases', () => {
    expect(resolveMentions('@everyone standup time', members)).toEqual(['a1', 'a2', 'a3'])
    expect(resolveMentions('@所有人 开会了', members)).toEqual(['a1', 'a2', 'a3'])
  })

  it('returns no targets when nothing is mentioned', () => {
    expect(resolveMentions('just logging context here', members)).toEqual([])
    expect(resolveMentions('email me at foo@bar.com', members)).toEqual([])
  })

  it('does not match a member name embedded in a longer word', () => {
    expect(resolveMentions('@Developer rocks', members)).toEqual([])
  })

  it('preserves roster order regardless of mention order in the text', () => {
    expect(resolveMentions('@DevOps then @Researcher', members)).toEqual(['a1', 'a3'])
  })

  it('does not execute agents whose names appear in email addresses', () => {
    expect(resolveMentions('Contact support@Dev.com or team@Researcher.org', members)).toEqual([])
    expect(resolveMentions('Contact 用户@Dev.com', members)).toEqual([])
    expect(resolveMentions('Then ask (@Dev) and @Researcher.', members)).toEqual(['a1', 'a2'])
  })

  it('rejects ambiguous names instead of selecting the first member', () => {
    const duplicates = [
      { agentId: 'first', agentName: 'Dev' },
      { agentId: 'second', agentName: ' dev ' }
    ]
    expect(() => resolveMentions('@Dev review', duplicates)).toThrow(AmbiguousGroupChatMentionError)
    expect(resolveMentions('@{second} review', duplicates)).toEqual(['second'])
    expect(resolveMentions('@{first} @{second} review', duplicates)).toEqual(['first', 'second'])
  })

  it('distinguishes reserved member names from room-wide mentions', () => {
    const reserved = [
      { agentId: 'one', agentName: 'All' },
      { agentId: 'two', agentName: 'All Bots' },
      { agentId: 'three', agentName: 'Other' }
    ]
    expect(resolveMentions('@{one} review', reserved)).toEqual(['one'])
    expect(resolveMentions('@All Bots review', reserved)).toEqual(['two'])
    expect(resolveMentions('@all review', reserved)).toEqual(['one', 'two', 'three'])
    expect(resolveMentions('@{not-a-member} review', reserved)).toEqual([])
  })
})
