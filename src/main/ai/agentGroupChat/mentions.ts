const ROOM_WIDE_ALIASES = ['everyone', 'all', '所有人', '全体成员']

export interface MentionCandidate {
  agentId: string
  agentName: string
}

export class AmbiguousGroupChatMentionError extends Error {
  constructor(readonly mentionName: string) {
    super(`Multiple members are named "${mentionName}". Select a member's mention button instead.`)
    this.name = 'AmbiguousGroupChatMentionError'
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentionPattern(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_@.+-])@${escapeRegExp(name)}(?![a-z0-9_])`, 'gu')
}

export function resolveMentions(content: string, members: readonly MentionCandidate[]): string[] {
  if (!content.includes('@') || members.length === 0) return []

  const mentioned = new Set<string>()
  let working = content
    .replace(/(?<![\p{L}\p{N}_@.+-])@\{([^{}\s]+)\}/gu, (match, agentId: string) => {
      if (members.some((member) => member.agentId === agentId)) mentioned.add(agentId)
      return '\u0000'.repeat(match.length)
    })
    .toLowerCase()
  const byName = new Map<string, string[]>()
  for (const member of members) {
    const name = member.agentName.trim().toLowerCase()
    if (name.length === 0 || ROOM_WIDE_ALIASES.includes(name)) continue
    byName.set(name, [...(byName.get(name) ?? []), member.agentId])
  }
  const byLongestName = [...byName].sort(([left], [right]) => right.length - left.length)
  for (const [name, agentIds] of byLongestName) {
    const pattern = mentionPattern(name)
    if (pattern.test(working)) {
      if (agentIds.length > 1) throw new AmbiguousGroupChatMentionError(name)
      mentioned.add(agentIds[0])
      // Mask consumed mentions so shorter names cannot re-match inside them.
      working = working.replace(pattern, (match) => '\u0000'.repeat(match.length))
    }
  }
  for (const alias of ROOM_WIDE_ALIASES) {
    if (mentionPattern(alias).test(working)) return members.map((member) => member.agentId)
  }
  // Roster order keeps fan-out deterministic regardless of name length.
  return members.filter((member) => mentioned.has(member.agentId)).map((member) => member.agentId)
}
