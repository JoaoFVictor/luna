import { Clock3Icon, PaperclipIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react"

import type { ArtifactSummary, RunEvent, RunGraphNode, RunGraphOverlay, RunRecord } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { workflowStatusPresentation } from "@/features/workflows/workflow-execution-presentation"
import { RunNodeOutputPanel } from "@/features/runs/run-node-output-panel"
import { formatDateTime, formatDuration } from "@/lib/format"
import { humanizeTechnicalId } from "@/lib/presentation"

type NodeAttempt = {
  readonly attempt: number
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly outcome: "running" | "succeeded" | "failed"
  readonly artifactCount?: number
  readonly interruptCount?: number
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nodeAttempts(events: readonly RunEvent[], nodeId: string): readonly NodeAttempt[] {
  const attempts = new Map<number, NodeAttempt>()
  for (const event of events) {
    const nodeEvent = objectValue(objectValue(event.data)?.node_event)
    if (nodeEvent?.node_id !== nodeId || typeof nodeEvent.attempt !== "number") continue
    const attempt = nodeEvent.attempt
    const observedAt = typeof nodeEvent.observed_at === "string" ? nodeEvent.observed_at : event.occurred_at
    const current = attempts.get(attempt)
    const artifactCount = typeof nodeEvent.artifact_count === "number" ? nodeEvent.artifact_count : current?.artifactCount
    const interruptCount = typeof nodeEvent.interrupt_count === "number" ? nodeEvent.interrupt_count : current?.interruptCount
    if (event.event_type === "run.node.started") {
      attempts.set(attempt, {
        attempt,
        startedAt: observedAt,
        outcome: "running",
        ...(artifactCount === undefined ? {} : { artifactCount }),
        ...(interruptCount === undefined ? {} : { interruptCount }),
      })
    } else if (event.event_type === "run.node.succeeded" || event.event_type === "run.node.failed") {
      attempts.set(attempt, {
        attempt,
        ...(current?.startedAt === undefined ? {} : { startedAt: current.startedAt }),
        finishedAt: observedAt,
        outcome: event.event_type === "run.node.succeeded" ? "succeeded" : "failed",
        ...(artifactCount === undefined ? {} : { artifactCount }),
        ...(interruptCount === undefined ? {} : { interruptCount }),
      })
    }
  }
  return [...attempts.values()].sort((left, right) => right.attempt - left.attempt)
}

function attemptDuration(attempt: NodeAttempt): number | undefined {
  if (attempt.startedAt === undefined || attempt.finishedAt === undefined) return undefined
  const duration = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt)
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined
}

const attemptOutcome = {
  running: "Em execução",
  succeeded: "Concluída",
  failed: "Falhou",
} as const

export function RunNodeDebugger({
  node,
  overlay,
  events,
  eventsComplete,
  artifacts,
  record,
}: {
  node: RunGraphNode
  overlay: RunGraphOverlay
  events: readonly RunEvent[]
  eventsComplete: boolean
  artifacts: readonly ArtifactSummary[]
  record: RunRecord
}) {
  const observation = overlay.observation === "observed"
    ? overlay.nodes.find((candidate) => candidate.node_id === node.id)
    : undefined
  const attempts = nodeAttempts(events, node.id)
  const nodeArtifacts = artifacts.filter((artifact) => artifact.source_node_id === node.id)
  const totalDuration = attempts.reduce<number | undefined>((total, attempt) => {
    const duration = attemptDuration(attempt)
    return duration === undefined ? total : (total ?? 0) + duration
  }, undefined)
  const status = observation?.status
  const statusLabel = status === undefined ? "Não observado" : workflowStatusPresentation[status].label
  const isPrimaryFailure = record.failed_node_id === node.id && record.failure !== undefined

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Depuração do passo</p>
          <h3 className="mt-1 text-lg font-semibold">{humanizeTechnicalId(node.id)}</h3>
          <p className="break-all font-mono text-xs text-muted-foreground">{node.capability_id}</p>
        </div>
        <Badge variant={status === "failed" ? "destructive" : "outline"}>{statusLabel}</Badge>
      </div>

      <dl className="grid gap-2 sm:grid-cols-4">
        {[
          ["Tentativas", observation?.attempt_count ?? attempts.length],
          ["Tempo total", formatDuration(totalDuration)],
          ["Resultados", nodeArtifacts.length],
          ["Interrupções", attempts.at(0)?.interruptCount ?? (node.can_create_pending_interrupt ? "Possível" : 0)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-muted/20 p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 font-medium">{value}</dd>
          </div>
        ))}
      </dl>

      {isPrimaryFailure && (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>Este passo encerrou a execução</AlertTitle>
          <AlertDescription>{record.failure?.message}</AlertDescription>
        </Alert>
      )}

      {!eventsComplete && (
        <Alert>
          <Clock3Icon aria-hidden="true" />
          <AlertTitle>Histórico parcial carregado</AlertTitle>
          <AlertDescription>Carregue os eventos anteriores para calcular todas as tentativas e durações.</AlertDescription>
        </Alert>
      )}

      <div>
        <h4 className="text-sm font-medium">Tentativas</h4>
        {attempts.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nenhum evento de tentativa foi persistido para este passo.</p>
        ) : (
          <div className="mt-2 overflow-hidden rounded-lg border">
            <Table>
              <TableHeader><TableRow><TableHead>Tentativa</TableHead><TableHead>Resultado</TableHead><TableHead>Início</TableHead><TableHead>Duração</TableHead></TableRow></TableHeader>
              <TableBody>
                {attempts.map((attempt) => (
                  <TableRow key={attempt.attempt}>
                    <TableCell><span className="inline-flex items-center gap-1"><RotateCcwIcon className="size-3.5" aria-hidden="true" />#{attempt.attempt}</span></TableCell>
                    <TableCell>{attemptOutcome[attempt.outcome]}</TableCell>
                    <TableCell>{formatDateTime(attempt.startedAt)}</TableCell>
                    <TableCell><span className="inline-flex items-center gap-1"><Clock3Icon className="size-3.5" aria-hidden="true" />{formatDuration(attemptDuration(attempt))}</span></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {nodeArtifacts.length > 0 && (
        <div>
          <h4 className="text-sm font-medium">Resultados produzidos</h4>
          <div className="mt-2 flex flex-wrap gap-2">
            {nodeArtifacts.map((artifact) => <Badge key={artifact.manifest_handle} variant="secondary"><PaperclipIcon aria-hidden="true" />{artifact.name}</Badge>)}
          </div>
        </div>
      )}

      {observation?.observed_output !== undefined && (
        <div>
          <h4 className="text-sm font-medium">Dados de saída</h4>
          <p className="text-xs text-muted-foreground">Por segurança, somente nomes de campos e tipos são exibidos.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {observation.observed_output.fields.filter((field) => field.path.length > 0).map((field) => (
              <Badge key={field.path.join(".")} variant="outline">{field.path.join(".")} · {field.value_type}</Badge>
            ))}
            {observation.observed_output.truncated && <Badge variant="secondary">lista truncada</Badge>}
          </div>
        </div>
      )}

      <RunNodeOutputPanel
        key={node.id}
        runId={record.run_id}
        nodeId={node.id}
        draftId={record.definition_source?.kind === "draft"
          ? record.definition_source.draft_id
          : undefined}
      />
    </section>
  )
}
