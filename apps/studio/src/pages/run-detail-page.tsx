import { useMemo } from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { ArrowLeftIcon, InfoIcon, RotateCcwIcon } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { isTerminalRunStatus, runQuery, runTimelineInfiniteQuery } from "@/api/queries"
import type { RunRecord } from "@/api/types"
import { PageError, PageLoading } from "@/components/page-state"
import { RunStatusBadge } from "@/components/status-badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArtifactsPanel } from "@/features/runs/artifacts-panel"
import { RunFailureCallout } from "@/features/runs/run-failure-callout"
import { RunGraphPanel } from "@/features/runs/run-graph-panel"
import { HitlReviewPanel } from "@/features/runs/hitl-review-panel"
import { RunLogsPanel } from "@/features/runs/run-logs-panel"
import { RunRecordDetails } from "@/features/runs/run-record-details"
import { RunTimelinePanel } from "@/features/runs/run-timeline-panel"
import { flattenRunTimeline } from "@/features/runs/run-timeline"
import { useRunEventStream } from "@/features/runs/use-run-event-stream"
import { formatDuration, shortDigest } from "@/lib/format"

export function runWorkflowHref(
  record: Pick<RunRecord, "workflow_id" | "definition_source">,
): string {
  return record.definition_source?.kind === "draft"
    ? `/drafts/${encodeURIComponent(record.definition_source.draft_id)}`
    : `/workflows/${encodeURIComponent(record.workflow_id)}`
}

export function RunDetailPage() {
  const { runId = "" } = useParams()
  const navigate = useNavigate()
  const run = useQuery(runQuery(runId))
  const timeline = useInfiniteQuery(runTimelineInfiniteQuery(runId, run.data))
  const timelineEvents = useMemo(
    () => flattenRunTimeline(timeline.data?.pages),
    [timeline.data?.pages],
  )
  const terminal = isTerminalRunStatus(run.data?.status)
  const streamStatus = useRunEventStream({
    runId,
    afterSequence:
      timeline.data?.pages[0]?.as_of_sequence ??
      (timeline.isError ? 0 : undefined),
    enabled: run.data !== undefined && !terminal,
  })

  if (run.isPending) return <div className="p-6"><PageLoading label="Carregando run" /></div>
  if (run.isError) return <div className="p-6"><PageError error={run.error} retry={() => void run.refetch()} /></div>

  const record = run.data.record
  const relaunchHref = `/launch?${new URLSearchParams({
    workflow: record.workflow_id,
    ...(record.input_provenance?.kind === "adapter"
      ? { adapter: record.input_provenance.adapter_id }
      : {}),
  }).toString()}`
  const workflowHref = runWorkflowHref(record)
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 sm:p-6">
      <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={() => void navigate("/runs")}><ArrowLeftIcon aria-hidden="true" /> Execuções</Button>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">Execução {shortDigest(record.run_id, 16)}</p>
          <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight text-balance">{record.subject?.title ?? record.workflow_id}</h1>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{record.run_id}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RunStatusBadge status={run.data.status} />
          <Button variant="outline" size="sm" onClick={() => void navigate(workflowHref)}>Abrir workflow</Button>
          <Link className={buttonVariants({ size: "sm" })} to={relaunchHref}>
            <RotateCcwIcon aria-hidden="true" /> Executar novamente
          </Link>
        </div>
      </header>

      <RunFailureCallout record={record} />
      <HitlReviewPanel runId={runId} active={!terminal} terminalAt={record.finished_at} />
      {record.completeness !== "complete" && (
        <Alert><InfoIcon aria-hidden="true" /><AlertTitle>Histórico incompleto</AlertTitle><AlertDescription>Parte dos dados desta execução não foi registrada. A ausência de um passo ou evento nesta tela não confirma que ele não ocorreu.</AlertDescription></Alert>
      )}

      {record.execution_profile?.kind === "manual_test" && (
        <Alert>
          <InfoIcon aria-hidden="true" />
          <AlertTitle>Execução manual com dados salvos</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {record.execution_profile.test_data.map((entry) => (
                <li key={entry.node_id}>
                  <code>{entry.node_id}</code> não executou; sua saída veio de <code>{entry.fixture_name}</code>.
                </li>
              ))}
            </ul>
            <p className="mt-2">Os demais passos seguiram a execução normal, mas podem não ter sido alcançados.</p>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card size="sm"><CardHeader><CardDescription>Workflow</CardDescription><CardTitle>{record.workflow_id}</CardTitle></CardHeader></Card>
        <Card size="sm"><CardHeader><CardDescription>Duração</CardDescription><CardTitle>{formatDuration(run.data.wall_duration_ms)}</CardTitle></CardHeader></Card>
        <Card size="sm"><CardHeader><CardDescription>Resultados</CardDescription><CardTitle>{record.artifact_count ?? "Indisponível"}</CardTitle></CardHeader></Card>
        <Card size="sm"><CardHeader><CardDescription>Interrupções</CardDescription><CardTitle>{record.interrupt_count ?? "Indisponível"}</CardTitle></CardHeader></Card>
      </div>

      <p className="text-xs text-muted-foreground">Ao executar novamente, revise a entrada: dados sensíveis não são recuperados desta execução.</p>
      <Tabs defaultValue="flow" className="min-w-0 space-y-4">
        <div className="overflow-x-auto pb-1">
          <TabsList className="w-max min-w-full justify-start">
            <TabsTrigger value="flow">Fluxo</TabsTrigger>
            <TabsTrigger value="results">Resultados</TabsTrigger>
            <TabsTrigger value="diagnostics">Diagnóstico</TabsTrigger>
            <TabsTrigger value="timeline">Linha do tempo</TabsTrigger>
            <TabsTrigger value="context">Contexto</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="flow">
          <RunGraphPanel
            runId={runId}
            record={record}
            events={timelineEvents}
            eventHistoryComplete={!timeline.hasNextPage && !timeline.isError}
          />
        </TabsContent>

        <TabsContent value="results" className="space-y-3">
          <div>
            <h2 className="font-heading text-xl font-semibold tracking-tight">Resultados produzidos</h2>
            <p className="mt-1 text-sm text-muted-foreground">Entregas finais e artefatos associados às etapas que os produziram.</p>
          </div>
          <ArtifactsPanel runId={runId} expectedCount={record.artifact_count} terminalAt={record.finished_at} />
        </TabsContent>

        <TabsContent value="diagnostics" className="space-y-3">
          <div>
            <h2 className="font-heading text-xl font-semibold tracking-tight">Diagnóstico da execução</h2>
            <p className="mt-1 text-sm text-muted-foreground">Investigue falhas e avisos; detalhes técnicos permanecem disponíveis sob demanda.</p>
          </div>
          <RunLogsPanel runId={runId} />
        </TabsContent>

        <TabsContent value="timeline">
          <RunTimelinePanel
            events={timelineEvents}
            streamStatus={streamStatus}
            terminal={terminal}
            pending={timeline.isPending}
            error={timeline.isError ? timeline.error : undefined}
            retry={() => void timeline.refetch()}
            hasPrevious={timeline.hasNextPage}
            fetchingPrevious={timeline.isFetchingNextPage}
            fetchPrevious={() => void timeline.fetchNextPage()}
          />
        </TabsContent>

        <TabsContent value="context">
          <RunRecordDetails record={record} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
