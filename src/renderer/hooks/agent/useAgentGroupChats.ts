import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { loggerService } from '@logger'
import {
  useDataChange,
  useInfiniteFlatItems,
  useInfiniteQuery,
  useMutation,
  useQuery
} from '@renderer/data/hooks/useDataApi'
import { ipcApi, useIpcOn } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import type {
  AgentGroupChatEntity,
  CreateAgentGroupChatDto,
  UpdateAgentGroupChatDto
} from '@shared/data/api/schemas/agentGroupChats'
import { agentGroupChatErrorCodes } from '@shared/ipc/errors/agentGroupChat'
import { IpcError } from '@shared/ipc/errors/IpcError'
import type { AgentGroupChatRespondingChanged } from '@shared/ipc/schemas/agentGroupChat'

const logger = loggerService.withContext('useAgentGroupChats')

const EMPTY_GROUP_CHATS: readonly AgentGroupChatEntity[] = Object.freeze([])
const EMPTY_IDS: readonly string[] = Object.freeze([])

export const useAgentGroupChats = () => {
  const { t } = useTranslation()
  const { data, error, isLoading, refetch } = useQuery('/agent-group-chats')
  useDataChange('/agent-group-chats', () => void refetch())
  useDataChange(['/agents', '/agents/:agentId'], () => void refetch())
  const groupChats = data ?? (EMPTY_GROUP_CHATS as AgentGroupChatEntity[])

  const { trigger: createTrigger } = useMutation('POST', '/agent-group-chats')
  const { trigger: updateTrigger } = useMutation('PATCH', '/agent-group-chats/:groupChatId')
  const { trigger: deleteTrigger } = useMutation('DELETE', '/agent-group-chats/:groupChatId')

  const createGroupChat = useCallback(
    async (dto: CreateAgentGroupChatDto) => {
      try {
        const created = await createTrigger({ body: dto })
        void refetch().catch((error) => logger.warn('Failed to refresh group chats', error as Error))
        return created
      } catch (err) {
        logger.error('Failed to create group chat', err as Error)
        toast.error(formatErrorMessageWithPrefix(err, t('agent.group_chat.create.error')))
        return null
      }
    },
    [createTrigger, refetch, t]
  )

  const updateGroupChat = useCallback(
    async (groupChatId: string, dto: UpdateAgentGroupChatDto) => {
      try {
        const updated = await updateTrigger({ params: { groupChatId }, body: dto })
        void refetch().catch((error) => logger.warn('Failed to refresh group chats', error as Error))
        return updated
      } catch (err) {
        logger.error('Failed to update group chat', err as Error)
        toast.error(formatErrorMessageWithPrefix(err, t('agent.group_chat.update.error')))
        return null
      }
    },
    [refetch, t, updateTrigger]
  )

  const deleteGroupChat = useCallback(
    async (groupChatId: string) => {
      try {
        await deleteTrigger({ params: { groupChatId } })
        void refetch().catch((error) => logger.warn('Failed to refresh group chats', error as Error))
        return true
      } catch (err) {
        logger.error('Failed to delete group chat', err as Error)
        toast.error(formatErrorMessageWithPrefix(err, t('agent.group_chat.delete.error')))
        return false
      }
    },
    [deleteTrigger, refetch, t]
  )

  return { groupChats, error, isLoading, refetch, createGroupChat, updateGroupChat, deleteGroupChat }
}

export const useAgentGroupChatMessages = (groupChatId: string | undefined) => {
  const { t } = useTranslation()
  const [responding, setResponding] = useState<AgentGroupChatRespondingChanged | null>(null)
  const [isPosting, setIsPosting] = useState(false)
  const postingRef = useRef(false)

  const { pages, isLoading, isRefreshing, refresh, hasNext, loadNext } = useInfiniteQuery(
    '/agent-group-chats/:groupChatId/messages',
    {
      params: { groupChatId: groupChatId ?? '' },
      enabled: !!groupChatId,
      limit: 50,
      swrOptions: { keepPreviousData: false }
    }
  )
  useDataChange('/agent-group-chats/:groupChatId/messages', () => void refresh(), {
    routeParams: groupChatId ? { groupChatId } : undefined
  })

  const applyResponding = useCallback(
    (payload: AgentGroupChatRespondingChanged) => {
      if (payload.groupChatId !== groupChatId) return
      setResponding((current) =>
        current?.groupChatId === payload.groupChatId && current.revision >= payload.revision ? current : payload
      )
    },
    [groupChatId]
  )

  useIpcOn('agent_group_chat.responding_changed', (payload) => {
    applyResponding(payload)
  })
  useEffect(() => {
    if (!groupChatId) return
    let cancelled = false
    void ipcApi
      .request('agent_group_chat.get_responding', { groupChatId })
      .then((snapshot) => {
        if (!cancelled) applyResponding(snapshot)
      })
      .catch((error) => logger.warn('Failed to load group chat responding state', error as Error))
    return () => {
      cancelled = true
    }
  }, [applyResponding, groupChatId])
  useIpcOn('agent_group_chat.turn_failed', (payload) => {
    if (payload.groupChatId !== groupChatId) return
    const reasonKey =
      payload.reason === 'busy'
        ? 'agent.group_chat.turn_failed.busy'
        : payload.reason === 'session-invalid'
          ? 'agent.group_chat.turn_failed.session_invalid'
          : 'agent.group_chat.turn_failed.error'
    toast.error(t(reasonKey))
  })

  const postMessage = useCallback(
    async (content: string) => {
      if (!groupChatId || postingRef.current) return null
      postingRef.current = true
      setIsPosting(true)
      try {
        const result = await ipcApi.request('agent_group_chat.send_message', { groupChatId, content })
        void refresh().catch((error) => logger.warn('Failed to refresh group chat messages', error as Error))
        return result
      } catch (err) {
        logger.error('Failed to post group chat message', err as Error)
        toast.error(
          err instanceof IpcError && err.code === agentGroupChatErrorCodes.AMBIGUOUS_MENTION
            ? t('agent.group_chat.post.ambiguous_mention')
            : formatErrorMessageWithPrefix(err, t('agent.group_chat.post.error'))
        )
        return null
      } finally {
        postingRef.current = false
        setIsPosting(false)
      }
    },
    [groupChatId, refresh, t]
  )

  const messages = useInfiniteFlatItems(pages, { reversePages: true })
  const respondingAgentIds =
    responding && responding.groupChatId === groupChatId ? responding.respondingAgentIds : EMPTY_IDS
  return {
    messages,
    isLoading,
    isRefreshing,
    hasNext,
    loadNext,
    isPosting,
    postMessage,
    respondingAgentIds,
    refetch: refresh
  }
}
