import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { GitCompareArrowsIcon } from "lucide-react"

import {
  isTerminalRunStatus,
  runNodeOutputComparisonQuery,
  runOutputComparisonCandidatesQuery,
} from "@/api/queries"
import type { RunNodeOutputComparisonResponse } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { formatDateTime, shortDigest } from "@/lib/format"

type ComparableResponse = Extract<
  RunNodeOutputComparisonResponse,
  { readonly availability: "comparable" }
>

const unavailableReasonCopy = {
  graph_unavailable: "grafo exato indisponível",
  run_not_terminal: "execução ainda não terminou",
  outcome_unavailable: "resultado terminal indisponível",
  output_not_recorded: "output não registrado",
  value_limit_exceeded: "output excedeu o limite individual",
  snapshot_budget_exhausted: "limite total de outputs atingido",
} as const

const changePresentation = {
  added: { label: "Adicionado", className: "text-emerald-700 dark:text-emerald-300" },
  removed: { label: "Removido", className: "text-destructive" },
  changed: { label: "Alterado", className: "text-amber-700 dark:text-amber-300" },
} as const

function displayPath(path: readonly string[]): string {
  return path.length === 0 ? "$ (valor raiz)" : path.join(" → ")
}

function displayValue(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2) ?? "null"
  return serialized.length <= 2_000
    ? serialized
    : `${serialized.slice(0, 2_000)}\n… valor abreviado na tela`
}

function ComparisonResult({ result }: { result: RunNodeOutputComparisonResponse }) {
  if (result.availability === "unavailable") {
    return (
      <Alert>
        <AlertTitle>Não foi possível comparar estes outputs</AlertTitle>
        <AlertDescription>
          {result.reason === "workflow_mismatch"
            ? "As execuções pertencem a workflows diferentes."
            : result.unavailable_sides.map((side) =>
                `${side.side === "baseline" ? "Execução anterior" : "Execução atual"}: ${unavailableReasonCopy[side.reason]}.`,
              ).join(" ")}
        </AlertDescription>
      </Alert>
    )
  }

  return <ComparableResult result={result} />
}

function ComparableResult({ result }: { result: ComparableResponse }) {
  const visibleChanges = result.changes.slice(0, 100)
  return (
    <div className="space-y-3" aria-live="polite">
      {!result.same_workflow_revision && (
        <Alert>
          <AlertTitle>Revisões diferentes do workflow</AlertTitle>
          <AlertDescription>
            A comparação continua válida para este passo, mas a definição mudou entre as execuções.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Adicionados", result.summary.added],
          ["Removidos", result.summary.removed],
          ["Alterados", result.summary.changed],
          ["Total", result.summary.total],
        ].map(([label, value]) => (
          <div key={label} className="rounded-md border bg-background p-2">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-lg font-semibold">{value}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Comparação autoritativa dos snapshots redigidos das duas runs. Nenhum dado vivo foi consultado.
      </p>
      {result.summary.total === 0 ? (
        <p className="rounded-md border bg-background p-3 text-sm font-medium">
          Os outputs são iguais.
        </p>
      ) : (
        <ol className="max-h-[32rem] space-y-2 overflow-auto pr-1">
          {visibleChanges.map((change, index) => {
            const presentation = changePresentation[change.kind]
            return (
              <li key={`${change.path.join("\u0000")}:${change.kind}:${index}`} className="rounded-md border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <code className="break-all text-xs">{displayPath(change.path)}</code>
                  <Badge variant="outline" className={presentation.className}>{presentation.label}</Badge>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {change.kind !== "added" && (
                    <div><p className="text-xs text-muted-foreground">Antes</p><pre className="mt-1 max-h-44 overflow-auto rounded bg-muted p-2 text-xs">{displayValue(change.before)}</pre></div>
                  )}
                  {change.kind !== "removed" && (
                    <div><p className="text-xs text-muted-foreground">Depois</p><pre className="mt-1 max-h-44 overflow-auto rounded bg-muted p-2 text-xs">{displayValue(change.after)}</pre></div>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {(result.truncated || result.changes.length > visibleChanges.length) && (
        <p className="text-xs text-muted-foreground">
          Exibindo {visibleChanges.length} de {result.summary.total} diferenças. O resumo considera todas as diferenças encontradas.
        </p>
      )}
    </div>
  )
}

export function RunNodeOutputComparison({
  runId,
  nodeId,
  workflowId,
}: {
  runId: string
  nodeId: string
  workflowId: string
}) {
  const [open, setOpen] = useState(false)
  const [baselineRunId, setBaselineRunId] = useState("")
  const [requestedBaseline, setRequestedBaseline] = useState("")
  const candidates = useQuery({
    ...runOutputComparisonCandidatesQuery(workflowId),
    enabled: open,
  })
  const comparison = useQuery({
    ...runNodeOutputComparisonQuery(runId, nodeId, requestedBaseline),
    enabled: requestedBaseline.length > 0,
  })
  const runs = (candidates.data?.items ?? []).filter((run) =>
    run.run_id !== runId && isTerminalRunStatus(run.status),
  )

  return (
    <section className="space-y-3 border-t pt-3">
      <Button
        size="sm"
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <GitCompareArrowsIcon aria-hidden="true" /> Comparar com outra execução
      </Button>
      {open && (
        <div className="space-y-3 rounded-md border bg-muted/10 p-3">
          <Field>
            <FieldLabel htmlFor={`output-baseline-${nodeId}`}>Execução anterior</FieldLabel>
            <NativeSelect
              id={`output-baseline-${nodeId}`}
              className="w-full"
              value={baselineRunId}
              disabled={candidates.isPending || candidates.isError}
              onChange={(event) => {
                setBaselineRunId(event.target.value)
                setRequestedBaseline("")
              }}
            >
              <NativeSelectOption value="">Selecione uma execução</NativeSelectOption>
              {runs.map((run) => (
                <NativeSelectOption key={run.run_id} value={run.run_id}>
                  {formatDateTime(run.created_at)} · {shortDigest(run.run_id, 14)} · {run.status}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>
              Somente execuções finalizadas deste workflow são listadas.
            </FieldDescription>
          </Field>
          {candidates.isPending && <p className="text-sm text-muted-foreground" role="status">Carregando execuções…</p>}
          {candidates.isError && <Alert variant="destructive"><AlertTitle>Não foi possível listar as execuções</AlertTitle><AlertDescription>{candidates.error.message}</AlertDescription></Alert>}
          {!candidates.isPending && !candidates.isError && runs.length === 0 && (
            <p className="text-sm text-muted-foreground">Não há outra execução finalizada para comparar.</p>
          )}
          <Button
            size="sm"
            disabled={baselineRunId.length === 0 || (
              requestedBaseline.length > 0 && comparison.isFetching
            )}
            onClick={() => setRequestedBaseline(baselineRunId)}
          >
            <GitCompareArrowsIcon aria-hidden="true" /> {requestedBaseline.length > 0 && comparison.isFetching ? "Comparando…" : "Comparar outputs"}
          </Button>
          {comparison.isError && <Alert variant="destructive"><AlertTitle>Comparação falhou</AlertTitle><AlertDescription>{comparison.error.message}</AlertDescription></Alert>}
          {comparison.data !== undefined && <ComparisonResult result={comparison.data} />}
        </div>
      )}
    </section>
  )
}
