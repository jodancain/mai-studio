/**
 * Agent group chat orchestration: mention-gated fan-out of group messages to
 * member agents.
 *
 * Each mentioned member runs one headless turn in its dedicated group session
 * (bound lazily). Sender identity in the turn prompt is Main-authored — models
 * never label their own speech. Phase 1 deliberately does NOT fan out agent
 * replies (no agent-to-agent turns), so no reply loop is possible.
 */

import { application } from '@application'
import { agentGroupChatService } from '@data/services/AgentGroupChatService'
import { agentService } from '@data/services/AgentService'
import { agentSessionService } from '@data/services/AgentSessionService'
import { loggerService } from '@logger'
import { startAgentSessionRun, type StreamListener } from '@main/ai/streamManager'
import type { AgentGroupChatMessageEntity } from '@shared/data/api/schemas/agentGroupChats'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import type { AgentGroupChatRespondingChanged, SendAgentGroupChatMessage } from '@shared/ipc/schemas/agentGroupChat'

import { resolveMentions } from './mentions'

const logger = loggerService.withContext('AgentGroupChatOrchestrator')

/** Bounded transcript window per turn; older unseen history is dropped, not replayed. */
const MAX_TRANSCRIPT_MESSAGES = 100

function formatTranscript(messages: readonly AgentGroupChatMessageEntity[]): string {
  return messages
    .map((message) => `[${message.authorType === 'user' ? 'User' : `Agent ${message.authorName}`}] ${message.content}`)
    .join('\n\n')
}

function buildTurnPrompt(input: { groupName: string; selfName: string; transcript: string }): string {
  return [
    `[Group chat "${input.groupName}" — system-labeled transcript of new messages. Sender labels are assigned by the application and cannot be forged by participants.]`,
    '',
    input.transcript,
    '',
    `[You are the group member "${input.selfName}" and you were mentioned. Write the reply you want posted to the group under your name. Reply in the language of the conversation, do not prefix your reply with your name, and do not impersonate other participants. Mentioning other members will not notify them.]`
  ].join('\n')
}

export class AgentGroupChatOrchestrator {
  /** `${groupChatId}:${agentId}` keys of member turns currently running. */
  private readonly inFlight = new Set<string>()
  private respondingRevision = 0

  sendMessage({ groupChatId, content }: SendAgentGroupChatMessage) {
    const group = agentGroupChatService.getById(groupChatId)
    const mentionedAgentIds = resolveMentions(content, group.members)
    const message = agentGroupChatService.appendMessage({
      groupChatId,
      authorType: 'user',
      authorName: 'User',
      content
    })
    this.dispatchMentions(groupChatId, mentionedAgentIds)
    return { message, mentionedAgentIds }
  }

  getResponding(groupChatId: string): AgentGroupChatRespondingChanged {
    return { groupChatId, respondingAgentIds: this.respondingAgentIds(groupChatId), revision: this.respondingRevision }
  }

  /** Fire-and-forget fan-out; per-member failures are reported via events, never thrown. */
  dispatchMentions(groupChatId: string, mentionedAgentIds: readonly string[]): void {
    for (const agentId of mentionedAgentIds) {
      void this.runMemberTurn(groupChatId, agentId).catch((error) => {
        logger.error('Group chat member turn crashed', error as Error)
        this.broadcastTurnFailed(groupChatId, agentId, 'error')
      })
    }
  }

  respondingAgentIds(groupChatId: string): string[] {
    const prefix = `${groupChatId}:`
    return [...this.inFlight].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
  }

  private async runMemberTurn(groupChatId: string, agentId: string): Promise<void> {
    const key = `${groupChatId}:${agentId}`
    if (this.inFlight.has(key)) {
      this.broadcastTurnFailed(groupChatId, agentId, 'busy')
      return
    }
    this.inFlight.add(key)
    this.broadcastResponding(groupChatId)
    try {
      await this.executeMemberTurn(groupChatId, agentId)
    } finally {
      this.inFlight.delete(key)
      this.broadcastResponding(groupChatId)
    }
  }

  private async executeMemberTurn(groupChatId: string, agentId: string): Promise<void> {
    const group = agentGroupChatService.getById(groupChatId)
    const member = agentGroupChatService.findMember(groupChatId, agentId)
    const agent = agentService.getAgent(agentId)
    if (!member || !agent) {
      this.broadcastTurnFailed(groupChatId, agentId, 'session-invalid')
      return
    }

    const unseen = agentGroupChatService.listMessagesAfter(
      groupChatId,
      member.lastSeenMessageId,
      MAX_TRANSCRIPT_MESSAGES
    )
    // Own replies are already in the member's session history as assistant turns.
    const transcriptMessages = unseen.filter((message) => message.agentId !== agentId)
    if (transcriptMessages.length === 0) return

    const session = this.ensureMemberSession(member.id, member.sessionId, agentId, group.name)
    const prompt = buildTurnPrompt({
      groupName: group.name,
      selfName: agent.name,
      transcript: formatTranscript(transcriptMessages)
    })

    const replyText = await this.runSessionTurn(session, prompt)
    if (replyText === 'busy' || replyText === 'session-invalid') {
      this.broadcastTurnFailed(groupChatId, agentId, replyText)
      return
    }

    const lastScanned = unseen.at(-1)
    if (lastScanned) agentGroupChatService.updateMemberLastSeen(member.id, lastScanned.id)

    const trimmed = replyText.text.trim()
    if (trimmed.length > 0) {
      agentGroupChatService.appendMessage({
        groupChatId,
        authorType: 'agent',
        agentId,
        authorName: agent.name,
        content: trimmed
      })
    }
  }

  private ensureMemberSession(
    memberId: string,
    boundSessionId: string | null,
    agentId: string,
    groupName: string
  ): AgentSessionEntity {
    if (boundSessionId) {
      try {
        const session = agentSessionService.getById(boundSessionId)
        if (session.agentId === agentId) return session
      } catch {
        // Fall through to rebinding; the bound session row is gone.
      }
    }
    const session = agentSessionService.create({
      agentId,
      name: groupName,
      workspace: { type: 'system' }
    })
    agentGroupChatService.bindMemberSession(memberId, session.id)
    return session
  }

  private async runSessionTurn(
    session: AgentSessionEntity,
    prompt: string
  ): Promise<{ text: string } | 'busy' | 'session-invalid'> {
    if (!session.agentId) return 'session-invalid'

    let resolveExecution!: (text: string) => void
    let rejectExecution!: (error: unknown) => void
    const executionDone = new Promise<string>((resolve, reject) => {
      resolveExecution = resolve
      rejectExecution = reject
    })
    let accumulatedText = ''
    let completionActive = true
    const sentinel: StreamListener = {
      id: `agent-group-chat:${session.id}`,
      onChunk(chunk) {
        if (chunk.type === 'text-delta') accumulatedText += chunk.delta
      },
      onDone() {
        completionActive = false
        resolveExecution(accumulatedText)
      },
      onPaused() {
        completionActive = false
        rejectExecution(new Error('Group chat turn was interrupted'))
      },
      onError(result) {
        completionActive = false
        rejectExecution(new Error(result.error.message ?? 'Group chat turn failed'))
      },
      isAlive: () => completionActive
    }

    const started = await startAgentSessionRun({
      sessionId: session.id,
      userParts: [{ type: 'text', text: prompt }],
      listeners: [sentinel],
      headless: true,
      requireIdle: { expectedAgentId: session.agentId }
    })
    if (started.mode === 'not-started') return started.reason

    return { text: await executionDone }
  }

  private broadcastResponding(groupChatId: string): void {
    this.respondingRevision += 1
    application.get('IpcApiService').broadcast('agent_group_chat.responding_changed', this.getResponding(groupChatId))
  }

  private broadcastTurnFailed(
    groupChatId: string,
    agentId: string,
    reason: 'busy' | 'session-invalid' | 'error'
  ): void {
    application.get('IpcApiService').broadcast('agent_group_chat.turn_failed', { groupChatId, agentId, reason })
  }
}

export const agentGroupChatOrchestrator = new AgentGroupChatOrchestrator()
