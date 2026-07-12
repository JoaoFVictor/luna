import { ExternalLinkIcon, HistoryIcon, XIcon } from "lucide-react"
import { Link } from "react-router-dom"

import { RunStatusBadge, runStatusLabel } from "@/components/status-badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { useWorkflowRunOverlay } from "@/features/workflows/use-workflow-run-overlay"
import { formatDateTime, shortDigest } from "@/lib/format"

type WorkflowRunOverlayState = ReturnType<typeof useWorkflowRunOverlay>

export function WorkflowRunOverlayBar({
  state,
  onClose,
}: {
  state: WorkflowRunOverlayState
  onClose: () => void
}) {
  const selected = state.runs.data?.items.find(
    (run) => run.run_id === state.selectedRunId,
  )
  const selectedRunLoading = state.selectedRunId !== undefined &&
    (state.graph.isPending || state.run.isPending)
  const message = state.runs.isPending || selectedRunLoading
    ? "Carregando a execução e seu grafo exato…"
    : state.runs.isError || state.graph.isError || state.run.isError
      ? "Não foi possível carregar a execução selecionada."
      : state.runs.data?.items.length === 0
        ? "Este workflow ainda não possui execuções."
        : state.overlay.kind === "revision_mismatch"
          ? "Esta execução pertence a outra revisão. O canvas não receberá estados incorretos."
          : state.overlay.kind === "unavailable"
            ? "O grafo exato desta execução não está disponível."
            : state.overlay.kind === "compatible"
              ? "Estados da execução aplicados ao canvas desta mesma revisão."
              : "Carregando evidência da execução…"

  return (
    <section className="border-b bg-sky-500/5 px-3 py-2" aria-label="Execução sobre o canvas">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-sky-500/50">
          <HistoryIcon aria-hidden="true" /> Execução no canvas
        </Badge>
        {state.runs.data !== undefined && state.runs.data.items.length > 0 && (
          <NativeSelect
            aria-label="Execução exibida no canvas"
            value={state.selectedRunId ?? ""}
            onChange={(event) => state.setSelectedRunId(event.target.value)}
            className="min-w-64 max-w-full"
          >
            {state.runs.data.items.map((run) => (
              <NativeSelectOption key={run.run_id} value={run.run_id}>
                {formatDateTime(run.created_at)} · {runStatusLabel(run.status)} · {shortDigest(run.run_id, 10)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        {selected !== undefined && <RunStatusBadge status={selected.status} />}
        <span className="min-w-48 flex-1 text-xs text-muted-foreground" role="status">{message}</span>
        {state.selectedRunId !== undefined && (
          <Link
            className={buttonVariants({ size: "sm", variant: "outline" })}
            to={`/runs/${encodeURIComponent(state.selectedRunId)}`}
          >
            Detalhes <ExternalLinkIcon aria-hidden="true" />
          </Link>
        )}
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Fechar execução no canvas">
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      {(state.runs.isError || state.graph.isError || state.run.isError) && (
        <Alert variant="destructive" className="mt-2 py-2">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
    </section>
  )
}
