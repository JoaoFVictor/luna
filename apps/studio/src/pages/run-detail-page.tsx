import { useMemo } from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { ArrowLeftIcon, CircleIcon, InfoIcon, RotateCcwIcon } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { isTerminalRunStatus, runQuery, runTimelineInfiniteQuery } from "@/api/queries"
import type { RunRecord } from "@/api/types"
import { PageError, PageLoading } from "@/components/page-state"
import { RunStatusBadge } from "@/components/status-badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArtifactsPanel } from "@/features/runs/artifacts-panel"
import { RunGraphPanel } from "@/features/runs/run-graph-panel"
import { RunLogsPanel } from "@/features/runs/run-logs-panel"
import { flattenRunTimeline } from "@/features/runs/run-timeline"
import { runFailurePresentation } from "@/features/runs/run-failure-presentation"
import { useRunEventStream, type RunEventStreamStatus } from "@/features/runs/use-run-event-stream"
import { formatDateTime, formatDuration, shortDigest } from "@/lib/format"
import { humanizeTechnicalId } from "@/lib/presentation"

export function runWorkflowHref(
  record: Pick<RunRecord, "workflow_id" | "definition_source">,
): string {
  return record.definition_source?.kind === "draft"
    ? `/drafts/${encodeURIComponent(record.definition_source.draft_id)}`
    : `/workflows/${encodeURIComponent(record.workflow_id)}`
}

function streamPresentation(status: RunEventStreamStatus, terminal: boolean) {
  if (terminal || status === "complete") {
    return { label: "Finalizado", description: "Timeline fechada no ledger persistido; não há eventos vivos pendentes." }
  }
  if (status === "live") {
    return { label: "Ao vivo", description: "Eventos via SSE; polling de 5 segundos permanece como fallback." }
  }
  if (status === "connecting" || status === "waiting") {
    return { label: "Conectando", description: "Abrindo o stream após fixar o snapshot inicial da timeline." }
  }
  if (status === "reconnecting") {
    return { label: "Reconectando", description: "O navegador está retomando o stream; polling continua ativo." }
  }
  if (status === "invalid") {
    return { label: "Fallback", description: "O stream violou o contrato canônico e foi fechado; polling continua ativo." }
  }
  if (status === "unsupported") {
    return { label: "Polling", description: "SSE não está disponível neste navegador; atualização a cada 5 segundos." }
  }
  return { label: "Polling", description: "Atualização moderada a cada 5 segundos." }
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
  const stream = streamPresentation(streamStatus, terminal)

  if (run.isPending) return <div className="p-6"><PageLoading label="Carregando run" /></div>
  if (run.isError) return <div className="p-6"><PageError error={run.error} retry={() => void run.refetch()} /></div>

  const record = run.data.record
  const inputProvenance = record.input_provenance?.kind === "adapter"
    ? `adapter ${record.input_provenance.adapter_id} · ${record.input_provenance.adapter_input_hash}`
    : record.input_provenance?.kind === "invocation"
      ? "invocation JSON direta"
      : "—"
  const relaunchHref = `/launch?${new URLSearchParams({
    workflow: record.workflow_id,
    ...(record.input_provenance?.kind === "adapter"
      ? { adapter: record.input_provenance.adapter_id }
      : {}),
  }).toString()}`
  const workflowHref = runWorkflowHref(record)
  const failurePresentation = record.failure === undefined
    ? undefined
    : runFailurePresentation(record.failure, record.failed_node_id)
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <Button variant="ghost" size="sm" className="w-fit" onClick={() => void navigate("/runs")}><ArrowLeftIcon aria-hidden="true" /> Voltar às execuções</Button>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">Execução {shortDigest(record.run_id, 16)}</p>
          <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight text-balance">{record.subject?.title ?? record.workflow_id}</h1>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{record.run_id}</p>
        </div>
        <RunStatusBadge status={run.data.status} />
      </header>

      {record.completeness !== "complete" && (
        <Alert><InfoIcon aria-hidden="true" /><AlertTitle>Alguns detalhes não estão disponíveis</AlertTitle><AlertDescription>Esta execução foi registrada parcialmente. Os dados existentes continuam acessíveis.</AlertDescription></Alert>
      )}
      {record.failure !== undefined && (
        <Alert variant="destructive"><InfoIcon aria-hidden="true" /><AlertTitle>{failurePresentation?.title}</AlertTitle><AlertDescription>{failurePresentation?.description}{record.failed_node_id !== undefined && <p className="mt-1">Passo: <code>{humanizeTechnicalId(record.failed_node_id)}</code></p>}<details className="mt-2"><summary className="cursor-pointer text-xs">Detalhes técnicos</summary><p><code>{record.failure.code}</code></p><p className="mt-1">{record.failure.message}</p></details></AlertDescription></Alert>
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
            <p className="mt-2">Os demais passos e efeitos foram reais.</p>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card size="sm"><CardHeader><CardDescription>Workflow</CardDescription><CardTitle>{record.workflow_id}</CardTitle></CardHeader></Card>
        <Card size="sm"><CardHeader><CardDescription>Duração</CardDescription><CardTitle>{formatDuration(run.data.wall_duration_ms)}</CardTitle></CardHeader></Card>
        <Card size="sm"><CardHeader><CardDescription>Resultados</CardDescription><CardTitle>{record.artifact_count ?? "Indisponível"}</CardTitle></CardHeader></Card>
        <Card size="sm"><CardHeader><CardDescription>Interrupções</CardDescription><CardTitle>{record.interrupt_count ?? "Indisponível"}</CardTitle></CardHeader></Card>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Link className={buttonVariants({ size: "sm" })} to={relaunchHref}>
          <RotateCcwIcon aria-hidden="true" /> Executar novamente
        </Link>
        <Button variant="outline" size="sm" onClick={() => void navigate(workflowHref)}>Abrir workflow</Button>
      </div>
      <p className="text-right text-xs text-muted-foreground">Por segurança, a entrada sensível não é persistida; revise ou informe os dados novamente.</p>
      <RunGraphPanel
        runId={runId}
        record={record}
        events={timelineEvents}
        eventHistoryComplete={!timeline.hasNextPage && !timeline.isError}
      />

      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(20rem,1fr)]">
        <Card>
          <CardHeader><div className="flex items-center justify-between gap-3"><CardTitle>Linha do tempo</CardTitle><Badge variant={streamStatus === "live" ? "secondary" : "outline"} aria-live="polite">{stream.label}</Badge></div><CardDescription>{stream.description}</CardDescription></CardHeader>
          <CardContent>
            {timeline.isPending ? <PageLoading label="Carregando timeline" /> : timeline.isError ? <PageError error={timeline.error} retry={() => void timeline.refetch()} /> : timelineEvents.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">Nenhum evento registrado.</p> : (
              <><ol className="space-y-0">
                {timelineEvents.map((event, index) => (
                  <li key={event.event_id} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-3">
                    <div className="flex flex-col items-center"><CircleIcon className="mt-1.5 size-2 fill-foreground" aria-hidden="true" />{index < timelineEvents.length - 1 && <span className="h-full w-px bg-border" />}</div>
                    <div className="min-w-0 pb-5"><div className="flex flex-wrap items-center gap-2"><p className="font-medium">{humanizeTechnicalId(event.event_type)}</p><Badge variant="outline">#{event.sequence}</Badge></div><p className="text-xs text-muted-foreground">{formatDateTime(event.occurred_at)}</p><details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">Dados técnicos do evento</summary><pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted p-2 text-xs">{JSON.stringify(event.data, null, 2)}</pre></details></div>
                  </li>
                ))}
              </ol>{timeline.hasNextPage && <Button variant="outline" className="w-full" disabled={timeline.isFetchingNextPage} onClick={() => void timeline.fetchNextPage()}>{timeline.isFetchingNextPage ? "Carregando…" : "Carregar eventos anteriores"}</Button>}</>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Detalhes da execução</CardTitle><CardDescription>Horários, origem e referência do workflow.</CardDescription></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {[
                ["Criada", formatDateTime(record.created_at)],
                ["Iniciada", formatDateTime(record.started_at)],
                ["Finalizada", formatDateTime(record.finished_at)],
                ["Origem", inputProvenance],
                ["Repositório", record.repository_id ?? "—"],
              ].map(([label, value], index) => <div key={label}>{index > 0 && <Separator className="mb-3" />}<p className="text-xs text-muted-foreground">{label}</p><p className="break-all font-mono text-xs">{value}</p></div>)}
              <details><summary className="cursor-pointer text-xs text-muted-foreground">Identificadores técnicos</summary><pre className="mt-2 overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify({ workflow_revision: record.workflow_revision, definition_bundle: record.definition_bundle_hash, execution_snapshot: record.execution_snapshot_hash, accepted_plan: record.accepted_plan_id, source: record.source }, null, 2)}</pre></details>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Permissões previstas</CardTitle><CardDescription>Ações externas que esta execução poderia realizar.</CardDescription></CardHeader>
            <CardContent>
              {record.side_effects.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum efeito ou incerteza planejado.</p> : <ScrollArea className="max-h-64"><pre className="rounded-lg bg-muted p-3 text-xs">{JSON.stringify(record.side_effects, null, 2)}</pre></ScrollArea>}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Resultados e diagnóstico</CardTitle><CardDescription>Arquivos produzidos e logs úteis para entender a execução.</CardDescription></CardHeader>
        <CardContent>
          <Tabs defaultValue="artifacts">
            <TabsList>
              <TabsTrigger value="artifacts">Resultados</TabsTrigger>
              <TabsTrigger value="logs">Logs</TabsTrigger>
            </TabsList>
            <TabsContent value="artifacts" className="pt-4"><ArtifactsPanel runId={runId} expectedCount={record.artifact_count} terminalAt={record.finished_at} /></TabsContent>
            <TabsContent value="logs" className="pt-4"><RunLogsPanel runId={runId} /></TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
