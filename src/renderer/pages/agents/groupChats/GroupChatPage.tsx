import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { LoaderCircle, Plus, Trash2, UsersRound } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, ConfirmDialog, EmojiAvatar, EmptyState, Markdown, Textarea } from '@cherrystudio/ui'
import { useAgentGroupChatMessages, useAgentGroupChats } from '@renderer/hooks/agent/useAgentGroupChats'
import { toast } from '@renderer/services/toast'
import type { AgentGroupChatEntity, AgentGroupChatMemberEntity } from '@shared/data/api/schemas/agentGroupChats'

import CreateGroupChatDialog from './CreateGroupChatDialog'

const route = getRouteApi('/app/agent-group-chats')
const MAX_MESSAGE_LENGTH = 40000
const ROOM_WIDE_ALIASES = new Set(['everyone', 'all', '所有人', '全体成员'])

const memberAvatar = (member: AgentGroupChatMemberEntity | undefined) => member?.agentAvatar || '🤖'

const GroupChatMessages = ({ groupChat }: { groupChat: AgentGroupChatEntity }) => {
  const { t } = useTranslation()
  const { messages, isLoading, isRefreshing, hasNext, loadNext, isPosting, postMessage, respondingAgentIds } =
    useAgentGroupChatMessages(groupChat.id)
  const [draft, setDraft] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const membersByAgentId = useMemo(
    () => new Map(groupChat.members.map((member) => [member.agentId, member])),
    [groupChat.members]
  )
  const respondingNames = respondingAgentIds
    .map((agentId) => membersByAgentId.get(agentId)?.agentName)
    .filter((name): name is string => !!name)
  const latestMessageId = messages.at(-1)?.id

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [latestMessageId])

  const handleSend = async () => {
    const content = draft.trim()
    if (content.length === 0 || content.length > MAX_MESSAGE_LENGTH || isPosting) return
    const submittedDraft = draft
    const result = await postMessage(content)
    if (result) setDraft((current) => (current === submittedDraft ? '' : current))
    if (result && result.mentionedAgentIds.length === 0) {
      // Mention gate: without a mention the message is context only — make that visible.
      toast.info(t('agent.group_chat.no_mention_hint'))
    }
  }

  const insertMention = (member: AgentGroupChatMemberEntity) => {
    const name = member.agentName.trim()
    const normalizedName = name.toLowerCase()
    const needsId =
      ROOM_WIDE_ALIASES.has(normalizedName) ||
      groupChat.members.filter((candidate) => candidate.agentName.trim().toLowerCase() === normalizedName).length > 1
    const mention = needsId ? `@{${member.agentId}}` : `@${name}`
    setDraft((prev) => {
      const next = `${prev}${prev.length > 0 && !prev.endsWith(' ') ? ' ' : ''}${mention} `
      return next.length <= MAX_MESSAGE_LENGTH ? next : prev
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex items-center gap-2 border-b px-4 py-3">
        <UsersRound size={18} className="text-muted-foreground" />
        <span className="font-medium">{groupChat.name}</span>
        <span className="text-muted-foreground text-xs">
          {t('agent.group_chat.member_count', { count: groupChat.members.length })}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {hasNext && (
          <div className="mb-3 flex justify-center">
            <Button variant="ghost" size="sm" disabled={isRefreshing} onClick={loadNext}>
              {isRefreshing ? t('common.loading') : t('agent.group_chat.load_older')}
            </Button>
          </div>
        )}
        {isLoading ? (
          <div className="flex justify-center p-6">
            <LoaderCircle className="size-4 animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <EmptyState description={t('agent.group_chat.empty_messages')} />
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((message) => {
              const member = message.agentId ? membersByAgentId.get(message.agentId) : undefined
              const isUser = message.authorType === 'user'
              return (
                <div key={message.id} className="flex items-start gap-2">
                  <EmojiAvatar size={28}>{isUser ? '🙂' : memberAvatar(member)}</EmojiAvatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium">
                        {isUser ? t('agent.group_chat.you') : message.authorName}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {new Date(message.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <Markdown id={`group-chat-message-${message.id}`}>{message.content}</Markdown>
                  </div>
                </div>
              )
            })}
            {respondingNames.length > 0 && (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <LoaderCircle className="size-3 animate-spin" />
                {t('agent.group_chat.responding', { names: respondingNames.join(', ') })}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="border-border flex flex-col gap-2 border-t p-3">
        <div className="flex flex-wrap gap-1">
          {groupChat.members.map((member) => (
            <Button
              key={member.id}
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => insertMention(member)}>
              <EmojiAvatar size={16} fontSize={10}>
                {memberAvatar(member)}
              </EmojiAvatar>
              @{member.agentName}
            </Button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <Textarea.Input
            value={draft}
            maxLength={MAX_MESSAGE_LENGTH}
            rows={2}
            placeholder={t('agent.group_chat.composer_placeholder')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void handleSend()
              }
            }}
          />
          <Button onClick={() => void handleSend()} disabled={draft.trim().length === 0 || isPosting}>
            {t('agent.group_chat.send')}
          </Button>
        </div>
      </div>
    </div>
  )
}

const GroupChatPage = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { groupChatId } = route.useSearch()
  const { groupChats, isLoading, createGroupChat, deleteGroupChat } = useAgentGroupChats()
  const [createOpen, setCreateOpen] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  const activeGroupChat = groupChats.find((groupChat) => groupChat.id === groupChatId) ?? null

  const selectGroupChat = (id: string | undefined) => {
    void navigate({ to: '/app/agent-group-chats', search: id ? { groupChatId: id } : {}, replace: true })
  }

  const handleCreate = async (dto: Parameters<typeof createGroupChat>[0]) => {
    const created = await createGroupChat(dto)
    if (created) selectGroupChat(created.id)
    return created
  }

  const handleDelete = async () => {
    if (!pendingDeleteId) return
    const deleted = await deleteGroupChat(pendingDeleteId)
    if (deleted && pendingDeleteId === groupChatId) selectGroupChat(undefined)
    setPendingDeleteId(null)
  }

  return (
    <div className="bg-background flex h-full min-h-0">
      <div className="border-border flex w-60 shrink-0 flex-col border-r">
        <div className="border-border flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">{t('agent.group_chat.title')}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('agent.group_chat.create.title')}
            onClick={() => setCreateOpen(true)}>
            <Plus size={16} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex justify-center p-4">
              <LoaderCircle className="size-4 animate-spin" />
            </div>
          ) : groupChats.length === 0 ? (
            <div className="text-muted-foreground p-4 text-sm">{t('agent.group_chat.empty_list')}</div>
          ) : (
            groupChats.map((groupChat) => (
              <div
                key={groupChat.id}
                role="button"
                tabIndex={0}
                onClick={() => selectGroupChat(groupChat.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') selectGroupChat(groupChat.id)
                }}
                className={`group hover:bg-background-subtle flex cursor-pointer items-center gap-2 px-3 py-2 ${
                  groupChat.id === groupChatId ? 'bg-background-subtle' : ''
                }`}>
                <UsersRound size={16} className="text-muted-foreground shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm">{groupChat.name}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="invisible size-6 group-hover:visible"
                  aria-label={t('agent.group_chat.delete.title')}
                  onClick={(event) => {
                    event.stopPropagation()
                    setPendingDeleteId(groupChat.id)
                  }}>
                  <Trash2 size={14} />
                </Button>
              </div>
            ))
          )}
        </div>
      </div>

      {activeGroupChat ? (
        <GroupChatMessages key={activeGroupChat.id} groupChat={activeGroupChat} />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState description={t('agent.group_chat.empty_selection')} />
        </div>
      )}

      <CreateGroupChatDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={handleCreate} />
      <ConfirmDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null)
        }}
        title={t('agent.group_chat.delete.title')}
        description={t('agent.group_chat.delete.description')}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={() => void handleDelete()}
      />
    </div>
  )
}

export default GroupChatPage
