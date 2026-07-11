import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ExternalLinkIcon, InfoIcon } from "lucide-react"
import { Link } from "react-router-dom"

import { runQuery, workflowRunsQuery } from "@/api/queries"
import { PageEmpty, PageError, PageLoading } from "@/components/page-state"
import { RunStatusBadge } from "@/components/status-badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { RunGraphPanel } from "@/features/runs/run-graph-panel"
import { formatDateTime, shortDigest } from "@/lib/format"

export function WorkflowRunsPanel({
  workflowId,
  compiledRevision,
}: {
  workflowId: string
  compiledRevision?: string
}) {
  const runs = useQuery(workflowRunsQuery(workflowId))
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const selectedRun = useQuery({
    ...runQuery(selectedRunId ?? ""),
    enabled: selectedRunId !== undefined,
  })

  useEffect(() => {
    const first = runs.data?.items[0]?.run_id
    if (
      first !== undefined &&
      (selectedRunId === undefined || !runs.data?.items.some((run) => run.run_id === selectedRunId))
    ) {
      setSelectedRunId(first)
    }
  }, [runs.data?.items, selectedRunId])

  if (runs.isPending) return <div className="p-6"><PageLoading label="Carregando runs deste workflow" /></div>
  if (runs.isError) return <div className="p-6"><PageError error={runs.error} retry={() => void runs.refetch()} /></div>
  if (runs.data.items.length === 0) {
    return (
      <div className="p-4 sm:p-6">
        <PageEmpty
          title="Este workflow ainda não tem runs"
          description="A aba mostra execuções reais persistidas. Use Launch após aplicar uma definição válida."
          action={<Link className={buttonVariants()} to="/launch">Abrir Launch</Link>}
        />
      </div>
    )
  }

  const summary = runs.data.items.find((run) => run.run_id === selectedRunId)
  const record = selectedRun.data?.record
  const exactRevisionMatches =
    compiledRevision !== undefined &&
    record?.workflow_revision !== undefined &&
    compiledRevision === record.workflow_revision

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Run selecionada</CardTitle>
              <CardDescription>
                Últimas 100 runs filtradas no servidor por workflow; o grafo sempre vem do snapshot da run.
              </CardDescription>
            </div>
            <Link className={buttonVariants({ variant: "outline", size: "sm" })} to="/launch">
              Nova run <ExternalLinkIcon aria-hidden="true" />
            </Link>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field>
            <FieldLabel htmlFor="workflow-run-selection">Execução</FieldLabel>
            <NativeSelect
              id="workflow-run-selection"
              value={selectedRunId ?? ""}
              onChange={(event) => setSelectedRunId(event.target.value)}
              className="w-full"
            >
              {runs.data.items.map((run) => (
                <NativeSelectOption key={run.run_id} value={run.run_id}>
                  {formatDateTime(run.created_at)} · {run.status} · {shortDigest(run.run_id, 12)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>
              Alterar a seleção não executa nem modifica o draft.
            </FieldDescription>
          </Field>

          {summary !== undefined && (
            <div className="flex flex-wrap items-center gap-2">
              <RunStatusBadge status={summary.status} />
              <Badge variant="outline">{summary.completeness}</Badge>
              {summary.workflow_revision !== undefined && (
                <Badge variant="outline">revision {shortDigest(summary.workflow_revision)}</Badge>
              )}
              <Link
                className={buttonVariants({ variant: "link", size: "sm" })}
                to={`/runs/${encodeURIComponent(summary.run_id)}`}
              >
                Abrir detalhe completo <ExternalLinkIcon aria-hidden="true" />
              </Link>
            </div>
          )}

          {compiledRevision === undefined ? (
            <Alert>
              <InfoIcon aria-hidden="true" />
              <AlertTitle>Draft ainda não compilado nesta sessão</AlertTitle>
              <AlertDescription>Compile para comparar a revisão atual com a revisão executada.</AlertDescription>
            </Alert>
          ) : record?.workflow_revision === undefined ? (
            <Alert>
              <InfoIcon aria-hidden="true" />
              <AlertTitle>Run sem revisão comparável</AlertTitle>
              <AlertDescription>O record é legado ou parcial; o Studio não infere equivalência.</AlertDescription>
            </Alert>
          ) : (
            <Alert variant={exactRevisionMatches ? "default" : "destructive"}>
              <InfoIcon aria-hidden="true" />
              <AlertTitle>{exactRevisionMatches ? "Mesma revisão compilada" : "Revisões diferentes"}</AlertTitle>
              <AlertDescription>
                {exactRevisionMatches
                  ? "O draft compilado nesta sessão corresponde à revisão pinada na run."
                  : "O grafo abaixo pertence à run selecionada e não representa o draft atual."}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {selectedRun.isPending ? (
        <PageLoading label="Carregando record da run" />
      ) : selectedRun.isError ? (
        <PageError error={selectedRun.error} retry={() => void selectedRun.refetch()} />
      ) : record !== undefined && selectedRunId !== undefined ? (
        <RunGraphPanel runId={selectedRunId} record={record} />
      ) : null}
    </div>
  )
}
