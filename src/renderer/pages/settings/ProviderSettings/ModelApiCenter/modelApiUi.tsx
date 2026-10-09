import { CircleAlert, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@cherrystudio/ui'
import { cn } from '@renderer/utils/style'

export function CenterHeader({
  title,
  description,
  children
}: {
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-sm font-semibold text-foreground">{title}</h1>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

export function CenterPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 rounded-lg border border-border-subtle bg-card', className)}>{children}</section>
  )
}

export function CenterNotice({ children, warning = false }: { children: ReactNode; warning?: boolean }) {
  const Icon = warning ? CircleAlert : ShieldCheck
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
        warning
          ? 'border-warning-border bg-warning-subtle text-warning-subtle-foreground'
          : 'border-border-subtle text-muted-foreground'
      )}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div>{children}</div>
    </div>
  )
}

export const modelApiStatusKeys: Record<string, string> = {
  applied: 'settings.model_api.status_applied',
  applying: 'settings.model_api.status_applying',
  awaiting_confirmation: 'settings.model_api.status_awaiting_confirmation',
  basic: 'settings.model_api.status_basic',
  canceled: 'settings.model_api.status_canceled',
  completed: 'settings.model_api.status_completed',
  credential: 'settings.model_api.status_credential',
  disabled: 'settings.model_api.status_disabled',
  enabled: 'settings.model_api.status_enabled',
  error: 'settings.model_api.status_error',
  expired: 'settings.model_api.status_expired',
  fail: 'settings.model_api.status_fail',
  failed: 'settings.model_api.status_failed',
  forbidden: 'settings.model_api.status_forbidden',
  healthy: 'settings.model_api.status_healthy',
  idle: 'settings.model_api.status_idle',
  missing: 'settings.model_api.status_missing',
  network: 'settings.model_api.status_network',
  new: 'settings.model_api.status_new',
  pass: 'settings.model_api.status_pass',
  pending: 'settings.model_api.status_pending',
  rate_limit: 'settings.model_api.status_rate_limit',
  restored: 'settings.model_api.status_restored',
  running: 'settings.model_api.status_running',
  scanning: 'settings.model_api.status_scanning',
  skip: 'settings.model_api.status_skip',
  staged: 'settings.model_api.status_staged',
  stale: 'settings.model_api.status_stale',
  unsupported: 'settings.model_api.status_unsupported',
  unverified: 'settings.model_api.status_unverified',
  verified: 'settings.model_api.status_verified',
  verifying: 'settings.model_api.status_verifying',
  warn: 'settings.model_api.status_warn'
}

export function CenterStatus({ status }: { status: string }) {
  const { t } = useTranslation()
  const good = ['pass', 'healthy', 'verified', 'completed'].includes(status)
  const bad = [
    'fail',
    'error',
    'failed',
    'stale',
    'expired',
    'missing',
    'credential',
    'forbidden',
    'rate_limit',
    'network'
  ].includes(status)
  return (
    <Badge
      variant="outline"
      className={cn(
        'whitespace-nowrap text-xs',
        good && 'border-success-border bg-success-subtle text-success-subtle-foreground',
        bad && 'border-warning-border bg-warning-subtle text-warning-subtle-foreground'
      )}>
      {t(modelApiStatusKeys[status] ?? modelApiStatusKeys.unverified)}
    </Badge>
  )
}
