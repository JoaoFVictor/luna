import { CircleDashedIcon, DatabaseIcon, type LucideIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { WorkflowGraphModel } from "@/features/workflows/workflow-graph-model"
import {
  workflowStatusPresentation,
  type WorkflowNodeExecution,
} from "@/features/workflows/workflow-execution-presentation"
import { humanizeTechnicalId } from "@/lib/presentation"
import { cn } from "@/lib/utils"

export type RunStepGroup = {
  readonly id: "attention" | "active" | "completed" | "not_run" | "unobserved"
  readonly label: string
  readonly nodes: WorkflowGraphModel["nodes"]
}

const GROUP_ORDER: readonly RunStepGroup["id"][] = [
  "attention",
  "active",
  "completed",
  "not_run",
  "unobserved",
]

const GROUP_LABELS: Readonly<Record<RunStepGroup["id"], string>> = {
  attention: "Precisam de atenção",
  active: "Em andamento",
  completed: "Concluídos",
  not_run: "Não executados",
  unobserved: "Sem estado observado",
}

function groupId(execution: WorkflowNodeExecution | undefined): RunStepGroup["id"] {
  if (execution?.supplied === true) return "not_run"
  if (execution?.status === "failed" || execution?.status === "timed_out") return "attention"
  if (execution?.status === "running" || execution?.status === "waiting_for_input") return "active"
  if (execution?.status === "succeeded") return "completed"
  if (
    execution?.status === "pending" ||
    execution?.status === "skipped_inactive" ||
    execution?.status === "skipped_dependency_failed" ||
    execution?.status === "cancelled"
  ) return "not_run"
  return "unobserved"
}

export function groupRunSteps(
  graph: WorkflowGraphModel,
  execution: ReadonlyMap<string, WorkflowNodeExecution>,
): readonly RunStepGroup[] {
  const grouped = new Map<RunStepGroup["id"], WorkflowGraphModel["nodes"][number][]>()
  for (const node of graph.nodes) {
    const id = groupId(execution.get(node.id))
    const nodes = grouped.get(id) ?? []
    nodes.push(node)
    grouped.set(id, nodes)
  }
  return GROUP_ORDER.flatMap((id) => {
    const nodes = grouped.get(id)
    return nodes === undefined ? [] : [{ id, label: GROUP_LABELS[id], nodes }]
  })
}

function StepStatus({ execution }: { execution: WorkflowNodeExecution | undefined }) {
  let Icon: LucideIcon = CircleDashedIcon
  let label = "Não observado"
  if (execution?.supplied === true) {
    Icon = DatabaseIcon
    label = "Dados fornecidos"
  } else if (execution?.status !== undefined) {
    const presentation = workflowStatusPresentation[execution.status]
    Icon = presentation.icon
    label = presentation.label
  }
  return <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Icon className="size-3" aria-hidden="true" />{label}</span>
}

export function RunStepNavigator({
  graph,
  execution,
  selectedNodeId,
  onSelectNode,
}: {
  graph: WorkflowGraphModel
  execution: ReadonlyMap<string, WorkflowNodeExecution>
  selectedNodeId?: string
  onSelectNode: (nodeId: string) => void
}) {
  const groups = groupRunSteps(graph, execution)
  return (
    <aside className="flex h-full min-h-0 flex-col rounded-lg border bg-background" aria-label="Navegação pelas etapas da execução">
      <div className="border-b px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Etapas</h3>
          <Badge variant="outline">{graph.nodes.length}</Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">Selecione uma etapa para investigar.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {groups.map((group) => (
          <section key={group.id} className="mb-3 last:mb-0">
            <h4 className="mb-1 px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {group.label} · {group.nodes.length}
            </h4>
            <ul className="space-y-1">
              {group.nodes.map((node) => {
                const nodeExecution = execution.get(node.id)
                return (
                  <li key={node.id}>
                    <button
                      type="button"
                      className={cn(
                        "w-full rounded-md border border-transparent px-2.5 py-2 text-left hover:border-border hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selectedNodeId === node.id && "border-primary/40 bg-primary/5",
                        nodeExecution?.primaryFailure === true && "border-destructive/40 bg-destructive/5",
                      )}
                      aria-pressed={selectedNodeId === node.id}
                      onClick={() => onSelectNode(node.id)}
                    >
                      <span className="block truncate text-sm font-medium">{humanizeTechnicalId(node.id)}</span>
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <StepStatus execution={nodeExecution} />
                        {nodeExecution?.attemptCount !== undefined && (
                          <span className="text-[11px] text-muted-foreground">{nodeExecution.attemptCount}×</span>
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  )
}
