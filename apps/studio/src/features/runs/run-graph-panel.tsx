import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { InfoIcon, NetworkIcon, ShieldAlertIcon } from "lucide-react"

import { artifactsQuery, runGraphQuery } from "@/api/queries"
import type { RunEvent, RunRecord } from "@/api/types"
import { PageError, PageLoading } from "@/components/page-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  WorkflowGraph,
  WorkflowOutline,
  workflowGraphModel,
  type WorkflowNodeExecution,
} from "@/features/workflows/workflow-graph"
import { workflowRunExecutionProjection } from "@/features/workflows/workflow-run-overlay-model"
import { RunNodeDebugger } from "@/features/runs/run-node-debugger"

const unavailableCopy: Readonly<Record<string, { title: string; description: string }>> = {
  graph_not_persisted_yet: {
    title: "Grafo aguardando persistência",
    description: "A execução ainda não atravessou a barreira durável da compilação.",
  },
  legacy_run_without_snapshot: {
    title: "Run anterior ao snapshot de grafo",
    description: "Esta run legada não possui um DAG imutável associado.",
  },
  partial_run_without_snapshot: {
    title: "Run parcial",
    description: "O ledger não contém identidade suficiente para localizar um snapshot exato.",
  },
  graph_snapshot_not_preallocated: {
    title: "Snapshot não prealocado",
    description: "Esta run foi aceita sem o identificador interno exigido pela versão atual.",
  },
  graph_missing_after_completion: {
    title: "Snapshot ausente após conclusão",
    description: "A run terminou, mas o grafo durável não está presente. Nenhum DAG será reconstruído.",
  },
  run_not_executed: {
    title: "Run não executada",
    description: "O dispatch foi rejeitado antes de o runtime iniciar.",
  },
  run_identity_incomplete: {
    title: "Identidade incompleta",
    description: "A revisão e os hashes pinados necessários não estão completos.",
  },
  graph_snapshot_unavailable: {
    title: "Storage do grafo indisponível",
    description: "O snapshot não pôde ser lido com segurança.",
  },
  graph_snapshot_invalid: {
    title: "Snapshot de grafo inválido",
    description: "A integridade do conteúdo persistido falhou.",
  },
  graph_snapshot_identity_mismatch: {
    title: "Identidade do snapshot divergente",
    description: "O snapshot não corresponde exatamente à identidade pinada desta run.",
  },
}

const overlayCopy: Readonly<Record<string, string>> = {
  run_not_started: "O runtime ainda não iniciou; nenhum status de node foi observado.",
  live_observer_unavailable: "Esta execução ainda está ativa, mas não existe observador vivo confiável. O Studio não inferirá estados pelo ledger ou pelos logs.",
  outcome_missing: "A run terminou sem um outcome durável do grafo.",
  outcome_corrupt: "O outcome persistido falhou na validação de integridade.",
  outcome_unavailable: "O storage do outcome não pôde ser lido com segurança.",
  outcome_stale: "O outcome pertence a outra revisão terminal do record.",
}

export function RunGraphPanel({
  runId,
  record,
  events = [],
  eventHistoryComplete = true,
}: {
  runId: string
  record: RunRecord
  events?: readonly RunEvent[]
  eventHistoryComplete?: boolean
}) {
  const graph = useQuery(runGraphQuery(runId))
  const artifacts = useQuery(artifactsQuery(runId, {
    expectedCount: record.artifact_count,
    terminalAt: record.finished_at,
  }))
  const [selection, setSelection] = useState<{
    readonly runId: string
    readonly nodeId: string
  }>()
  const selectedNodeId = selection?.runId === runId
    ? selection.nodeId
    : record.failed_node_id
  const selectNode = (nodeId: string | undefined) => {
    setSelection(nodeId === undefined ? undefined : { runId, nodeId })
  }

  const execution = useMemo(() => {
    if (graph.data?.availability !== "available") {
      return new Map<string, WorkflowNodeExecution>()
    }
    return workflowRunExecutionProjection(
      graph.data,
      record,
      artifacts.data?.items,
    )
  }, [artifacts.data?.items, graph.data, record])

  if (graph.isPending) {
    return (
      <Card>
        <CardContent className="pt-6">
          <PageLoading label="Carregando grafo exato da run" />
        </CardContent>
      </Card>
    )
  }
  if (graph.isError) {
    return (
      <Card>
        <CardContent className="pt-6">
          <PageError error={graph.error} retry={() => void graph.refetch()} />
        </CardContent>
      </Card>
    )
  }
  if (graph.data.availability !== "available") {
    const copy = unavailableCopy[graph.data.reason] ?? {
      title: "Grafo indisponível",
      description: "O backend não forneceu um snapshot exato para esta run.",
    }
    return (
      <Card>
        <CardHeader>
          <CardTitle>Grafo da execução</CardTitle>
          <CardDescription>Somente o DAG imutável pinado para esta run é aceito.</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant={graph.data.availability === "corrupt" ? "destructive" : "default"}>
            <ShieldAlertIcon aria-hidden="true" />
            <AlertTitle>{copy.title}</AlertTitle>
            <AlertDescription>{copy.description}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    )
  }

  const response = graph.data
  const selected = response.graph.nodes.find((node) => node.id === selectedNodeId)
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <NetworkIcon aria-hidden="true" /> Grafo da execução
            </CardTitle>
            <CardDescription>
              DAG imutável da revisão realmente compilada; overlay apenas de evidência persistida.
            </CardDescription>
          </div>
          <Badge variant="outline">
            {response.graph.nodes.length} node{response.graph.nodes.length === 1 ? "" : "s"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <details className="rounded-lg border bg-muted/20 p-3 text-xs">
          <summary className="cursor-pointer font-medium">Identidade técnica do grafo</summary>
          <dl className="mt-3 grid gap-3 lg:grid-cols-2">
            {[
              ["Workflow revision", response.run.workflow_revision],
              ["Definition bundle", response.run.definition_bundle_hash],
              ["Execution snapshot", response.run.execution_snapshot_hash],
              ["Graph hash", response.graph_hash],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-all font-mono">{value}</dd></div>
            ))}
          </dl>
        </details>

        {response.overlay.observation === "unobservable" && (
          <Alert>
            <InfoIcon aria-hidden="true" />
            <AlertTitle>Status dos nodes não observado</AlertTitle>
            <AlertDescription>
              {overlayCopy[response.overlay.reason] ?? "Não há overlay confiável para esta revisão da run."}
            </AlertDescription>
          </Alert>
        )}
        {response.overlay.observation === "observed" && (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {response.overlay.source === "persisted"
              ? `Resultado final persistido na revisão ${response.overlay.record_revision}; status ${response.overlay.run_status}.`
              : `Execução ao vivo na revisão ${response.overlay.record_revision}; ${response.overlay.history === "complete" ? "histórico completo" : response.overlay.history === "recent" ? "últimos eventos persistidos" : "somente passos ativos"}.`}
          </p>
        )}
        {artifacts.isError && (
          <Alert>
            <InfoIcon aria-hidden="true" />
            <AlertTitle>Contagem de artifacts indisponível</AlertTitle>
            <AlertDescription>O grafo permanece válido, mas os badges de artifacts foram omitidos.</AlertDescription>
          </Alert>
        )}

        <Tabs defaultValue="graph">
          <TabsList aria-label="Visualização do grafo da execução">
            <TabsTrigger value="graph">Grafo</TabsTrigger>
            <TabsTrigger value="outline">Outline acessível</TabsTrigger>
          </TabsList>
          <TabsContent value="graph" className="mt-3 h-[34rem] overflow-hidden rounded-lg border bg-muted/20">
            <WorkflowGraph
              graph={workflowGraphModel(response.graph)}
              selectedNodeId={selectedNodeId}
              execution={execution}
              onSelectNode={(nodeId) => selectNode(nodeId || undefined)}
            />
          </TabsContent>
          <TabsContent value="outline" className="mt-3 rounded-lg border p-3">
            <ScrollArea className="max-h-[32rem]">
              <WorkflowOutline
                compiled={workflowGraphModel(response.graph)}
                selectedNodeId={selectedNodeId}
                execution={execution}
                onSelectNode={selectNode}
              />
            </ScrollArea>
          </TabsContent>
        </Tabs>

        {selected === undefined ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">Clique em um passo para inspecionar tentativas, duração, saídas e falhas.</p>
        ) : (
          <RunNodeDebugger node={selected} overlay={response.overlay} events={events} eventsComplete={eventHistoryComplete} artifacts={artifacts.data?.items ?? []} record={record} />
        )}
      </CardContent>
    </Card>
  )
}
