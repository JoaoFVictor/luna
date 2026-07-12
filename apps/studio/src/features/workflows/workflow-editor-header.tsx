import { CheckCircle2Icon, FileDiffIcon, LoaderCircleIcon, PlayIcon, Redo2Icon, Undo2Icon } from "lucide-react"
import type { ApplyResult, DraftItem, DraftValidationResult } from "@/api/types"
import { DraftStatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onTest,
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
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onTest: () => void
  onPlanApply: () => void
}) {
  const canRunCommands = canMutate && !hasLocalChanges
  const canTest = canRunCommands &&
    draft.status === "valid" &&
    validation?.status === "valid" &&
    validation.compiled
  return (
    <header className="sticky top-0 z-40 shrink-0 border-b bg-background/95 px-4 py-3 backdrop-blur">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate font-heading text-lg font-semibold">{draft.primary_resource.id}</h1>
            <DraftStatusBadge status={draft.status} />
            {saving ? (
              <Badge variant="outline"><LoaderCircleIcon className="animate-spin" aria-hidden="true" /> Salvando…</Badge>
            ) : hasLocalChanges ? (
              <Badge variant="outline">Alterações pendentes</Badge>
            ) : (
              <Badge variant="outline"><CheckCircle2Icon aria-hidden="true" /> Salvo</Badge>
            )}
            {(validation?.diagnostics.length ?? 0) > 0 && (
              <Badge variant="destructive">
                {validation?.diagnostics.length} problema{validation?.diagnostics.length === 1 ? "" : "s"}
              </Badge>
            )}
            {validation?.status === "valid" && validation.compiled && (
              <Badge variant="secondary">Pronto para testar</Badge>
            )}
            {(validating || compiling) && (
              <Badge variant="outline"><LoaderCircleIcon className="animate-spin" aria-hidden="true" /> Verificando…</Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Draft {shortDigest(draft.draft_id, 12)} · revision {draft.record_revision} · atualizado {formatDateTime(draft.updated_at)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex" role="group" aria-label="Histórico de edição">
            <Button variant="ghost" size="icon" disabled={!canUndo} onClick={onUndo} title="Desfazer (Ctrl+Z)">
              <Undo2Icon aria-hidden="true" /><span className="sr-only">Desfazer</span>
            </Button>
            <Button variant="ghost" size="icon" disabled={!canRedo} onClick={onRedo} title="Refazer (Ctrl+Shift+Z)">
              <Redo2Icon aria-hidden="true" /><span className="sr-only">Refazer</span>
            </Button>
          </div>
          <Button
            variant="outline"
            disabled={!canTest || saving}
            title={hasLocalChanges
              ? "Aguarde o salvamento automático antes de testar"
              : canTest
                ? undefined
                : "Corrija os problemas do workflow antes de testar"}
            onClick={onTest}
          >
            <PlayIcon aria-hidden="true" /> Testar
          </Button>
          <ToolbarButton pending={planning} pendingLabel="Preparando…" disabled={!canRunCommands || draft.status !== "valid"} onClick={onPlanApply}>
            <FileDiffIcon aria-hidden="true" /> Aplicar
          </ToolbarButton>
        </div>
      </div>
      {!canMutate && <p className="mt-2 text-xs text-muted-foreground">Sessão somente leitura: a projeção pode ser inspecionada, mas comandos de autoria estão bloqueados.</p>}
      {hasLocalChanges && <p className="mt-2 text-xs text-muted-foreground">As alterações serão salvas automaticamente.</p>}
      {applyResult !== undefined && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100" role="status">
          <CheckCircle2Icon className="size-4" aria-hidden="true" /> Aplicado em {formatDateTime(applyResult.committed_at)} · operação {shortDigest(applyResult.operation_id, 12)}. Nenhum commit ou push foi criado.
        </div>
      )}
    </header>
  )
}
