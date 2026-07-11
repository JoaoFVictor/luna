import { BanIcon, CircleCheckIcon, CircleXIcon, ClockIcon, LoaderCircleIcon, PaperclipIcon, PauseCircleIcon, SkipForwardIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react"

import type { RunGraphNodeStatus } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export type WorkflowNodeExecution = {
  readonly status?: RunGraphNodeStatus
  readonly attemptCount?: number
  readonly artifactCount?: number
  readonly primaryFailure?: boolean
}

export const workflowStatusPresentation: Record<RunGraphNodeStatus, { readonly label: string; readonly icon: LucideIcon; readonly className: string }> = {
  pending: { label: "Pendente", icon: ClockIcon, className: "border-muted-foreground/40" },
  running: { label: "Em execução", icon: LoaderCircleIcon, className: "border-sky-500/70 bg-sky-500/5" },
  waiting_for_input: { label: "Aguardando entrada", icon: PauseCircleIcon, className: "border-amber-500/70 bg-amber-500/5" },
  succeeded: { label: "Concluído", icon: CircleCheckIcon, className: "border-emerald-500/70 bg-emerald-500/5" },
  failed: { label: "Falhou", icon: CircleXIcon, className: "border-destructive bg-destructive/5" },
  skipped_inactive: { label: "Ignorado: inativo", icon: SkipForwardIcon, className: "border-muted-foreground/40 bg-muted/30" },
  skipped_dependency_failed: { label: "Ignorado: dependência falhou", icon: TriangleAlertIcon, className: "border-amber-500/70 bg-amber-500/5" },
  cancelled: { label: "Cancelado", icon: BanIcon, className: "border-muted-foreground/40 bg-muted/30" },
  timed_out: { label: "Tempo esgotado", icon: ClockIcon, className: "border-destructive bg-destructive/5" },
}

export function workflowExecutionDescription(execution: WorkflowNodeExecution | undefined): string {
  if (execution?.status === undefined) return "estado não observado"
  const attempts = execution.attemptCount === undefined ? "" : `, ${execution.attemptCount} tentativa${execution.attemptCount === 1 ? "" : "s"}`
  const artifacts = execution.artifactCount === undefined ? "" : `, ${execution.artifactCount} resultado${execution.artifactCount === 1 ? "" : "s"}`
  return `${workflowStatusPresentation[execution.status].label}${attempts}${artifacts}${execution.primaryFailure ? ", falha principal da execução" : ""}`
}

export function WorkflowExecutionBadges({ execution }: { execution?: WorkflowNodeExecution }) {
  if (execution?.status === undefined) return null
  const presentation = workflowStatusPresentation[execution.status]
  const StatusIcon = presentation.icon
  return <div className="mt-2 flex flex-wrap gap-1">
    <Badge variant="outline" className={presentation.className}><StatusIcon className={cn(execution.status === "running" && "motion-safe:animate-spin")} aria-hidden="true" />{presentation.label}</Badge>
    {execution.attemptCount !== undefined && <Badge variant="outline">{execution.attemptCount} tentativa{execution.attemptCount === 1 ? "" : "s"}</Badge>}
    {execution.artifactCount !== undefined && execution.artifactCount > 0 && <Badge variant="outline"><PaperclipIcon aria-hidden="true" />{execution.artifactCount} resultado{execution.artifactCount === 1 ? "" : "s"}</Badge>}
    {execution.primaryFailure && <Badge variant="destructive"><TriangleAlertIcon aria-hidden="true" /> Falha principal</Badge>}
  </div>
}
