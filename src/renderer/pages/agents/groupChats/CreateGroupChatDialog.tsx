import { LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmojiAvatar,
  Input
} from '@cherrystudio/ui'
import { useQuery } from '@renderer/data/hooks/useDataApi'
import type { AgentGroupChatEntity, CreateAgentGroupChatDto } from '@shared/data/api/schemas/agentGroupChats'

const MAX_MEMBERS = 20

interface CreateGroupChatDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (dto: CreateAgentGroupChatDto) => Promise<AgentGroupChatEntity | null>
}

const CreateGroupChatDialog = ({ open, onOpenChange, onCreate }: CreateGroupChatDialogProps) => {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  const { data: agentsPage, isLoading } = useQuery('/agents', {
    enabled: open,
    query: { limit: 100 }
  })
  const agents = agentsPage?.items ?? []

  const toggleAgent = (agentId: string, checked: boolean) => {
    setSelectedAgentIds((prev) => {
      if (!checked) return prev.filter((id) => id !== agentId)
      if (prev.includes(agentId) || prev.length >= MAX_MEMBERS) return prev
      return [...prev, agentId]
    })
  }

  const reset = () => {
    setName('')
    setSelectedAgentIds([])
  }

  const handleSubmit = async () => {
    const trimmed = name.trim()
    if (trimmed.length === 0 || selectedAgentIds.length === 0) return
    setSubmitting(true)
    try {
      const created = await onCreate({ name: trimmed, agentIds: selectedAgentIds })
      if (created) {
        reset()
        onOpenChange(false)
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('agent.group_chat.create.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('agent.group_chat.create.name_placeholder')}
            maxLength={255}
            autoFocus
          />
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-sm">{t('agent.group_chat.create.members_label')}</span>
            <div className="border-border max-h-64 overflow-y-auto rounded-md border">
              {isLoading ? (
                <div className="flex justify-center p-4">
                  <LoaderCircle className="size-4 animate-spin" />
                </div>
              ) : agents.length === 0 ? (
                <div className="text-muted-foreground p-4 text-sm">{t('agent.group_chat.create.no_agents')}</div>
              ) : (
                agents.map((agent) => (
                  <label
                    key={agent.id}
                    className="hover:bg-background-subtle flex cursor-pointer items-center gap-2 px-3 py-2">
                    <Checkbox
                      checked={selectedAgentIds.includes(agent.id)}
                      onCheckedChange={(checked) => toggleAgent(agent.id, checked === true)}
                    />
                    <EmojiAvatar size={24}>{agent.configuration?.avatar || '🤖'}</EmojiAvatar>
                    <span className="truncate text-sm">{agent.name}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={submitting || name.trim().length === 0 || selectedAgentIds.length === 0}>
            {t('agent.group_chat.create.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default CreateGroupChatDialog
