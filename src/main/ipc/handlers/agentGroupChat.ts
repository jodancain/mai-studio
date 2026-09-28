import { agentGroupChatOrchestrator } from '@main/ai/agentGroupChat/AgentGroupChatOrchestrator'
import { AmbiguousGroupChatMentionError } from '@main/ai/agentGroupChat/mentions'
import { agentGroupChatErrorCodes } from '@shared/ipc/errors/agentGroupChat'
import { IpcError } from '@shared/ipc/errors/IpcError'
import type { agentGroupChatRequestSchemas } from '@shared/ipc/schemas/agentGroupChat'
import type { IpcHandlersFor } from '@shared/ipc/types'

export const agentGroupChatHandlers: IpcHandlersFor<typeof agentGroupChatRequestSchemas> = {
  'agent_group_chat.send_message': async (input) => {
    try {
      return agentGroupChatOrchestrator.sendMessage(input)
    } catch (error) {
      if (error instanceof AmbiguousGroupChatMentionError) {
        throw new IpcError(agentGroupChatErrorCodes.AMBIGUOUS_MENTION, error.message, { name: error.mentionName })
      }
      throw error
    }
  },
  'agent_group_chat.get_responding': async ({ groupChatId }) => agentGroupChatOrchestrator.getResponding(groupChatId)
}
