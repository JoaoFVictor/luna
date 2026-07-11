import { CheckCircle2Icon, FileDiffIcon, GitBranchIcon, PlayIcon, SaveIcon } from "lucide-react"
import { Link } from "react-router-dom"

import type { ApplyResult, DraftItem, DraftValidationResult } from "@/api/types"
import { DraftStatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { formatDateTime, shortDigest } from "@/lib/format"

function ToolbarButton({
  pending,
  pendingLabel,
  children,
  ...props
}: React.ComponentProps<typeof Button> & {
  pending?: boolean
  pendingLabel?: string
}) {
  return (
    <Button {...props} disabled={props.disabled || pending}>
      {pending ? pendingLabel : children}
    </Button>
  )
}

export function WorkflowEditorHeader({
  draft,
  validation,
  hasLocalChanges,
  canMutate,
  saving,
  validating,
  compiling,
  planning,
  applyResult,
  onSave,
  onValidate,
  onCompile,
  onPlanApply,
}: {
  draft: DraftItem
  validation?: DraftValidationResult
  hasLocalChanges: boolean
  canMutate: boolean
  saving: boolean
  validating: boolean
  compiling: boolean
  planning: boolean
  applyResult?: ApplyResult
  onSave: () => void
  onValidate: () => void
  onCompile: () => void
  onPlanApply: () => void
}) {
  const canRunCommands = canMutate && !hasLocalChanges
  return (
    <header className="border-b bg-background px-4 py-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate font-heading text-lg font-semibold">{draft.primary_resource.id}</h1>
            <DraftStatusBadge status={draft.status} />
            {hasLocalChanges && <Badge variant="destructive">Alteração local não salva</Badge>}
            {validation?.compiled && <Badge variant="secondary">Compilado</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Draft {shortDigest(draft.draft_id, 12)} · revision {draft.record_revision} · atualizado {formatDateTime(draft.updated_at)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToolbarButton variant="outline" pending={saving} pendingLabel="Salvando…" disabled={!canMutate || !hasLocalChanges} onClick={onSave}>
            <SaveIcon aria-hidden="true" /> Salvar <span className="sr-only">(Ctrl+S)</span>
          </ToolbarButton>
          <ToolbarButton variant="outline" pending={validating} pendingLabel="Validando…" disabled={!canRunCommands} onClick={onValidate}>
            <CheckCircle2Icon aria-hidden="true" /> Validar
          </ToolbarButton>
          <ToolbarButton variant="outline" pending={compiling} pendingLabel="Compilando…" disabled={!canRunCommands} onClick={onCompile}>
            <GitBranchIcon aria-hidden="true" /> Compilar <span className="sr-only">(Ctrl+Enter)</span>
          </ToolbarButton>
          <ToolbarButton pending={planning} pendingLabel="Planejando…" disabled={!canRunCommands || draft.status !== "valid"} onClick={onPlanApply}>
            <FileDiffIcon aria-hidden="true" /> Diff &amp; apply
          </ToolbarButton>
          <Link
            className={buttonVariants({ variant: "outline" })}
            to={`/launch?workflow=${encodeURIComponent(draft.primary_resource.id)}`}
          >
            <PlayIcon aria-hidden="true" /> Preparar launch
          </Link>
        </div>
      </div>
      {!canMutate && <p className="mt-2 text-xs text-muted-foreground">Sessão somente leitura: a projeção pode ser inspecionada, mas comandos de autoria estão bloqueados.</p>}
      {hasLocalChanges && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Salve o draft antes de validar, compilar ou planejar o apply.</p>}
      {applyResult !== undefined && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100" role="status">
          <CheckCircle2Icon className="size-4" aria-hidden="true" /> Aplicado em {formatDateTime(applyResult.committed_at)} · operação {shortDigest(applyResult.operation_id, 12)}. Nenhum commit ou push foi criado.
        </div>
      )}
    </header>
  )
}
