import { Handle, Position, type Node, type NodeProps } from "@xyflow/react"
import { BotIcon, BoxIcon, CheckCircle2Icon, CircleXIcon, GitPullRequestArrowIcon, PauseIcon, TriangleAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { WorkflowExecutionBadges, workflowStatusPresentation, type WorkflowNodeExecution } from "./workflow-execution-presentation"
import type { WorkflowGraphNode } from "./workflow-graph-model"
import type { WorkflowNodePresentation } from "./workflow-node-catalog"
import type { WorkflowNodeDiagnostic } from "./workflow-node-diagnostics"
import type { WorkflowLayoutDirection } from "./workflow-layout"

export type WorkflowNodeData = {
  compiled: WorkflowGraphNode
  execution?: WorkflowNodeExecution
  presentation?: WorkflowNodePresentation
  diagnostics?: readonly WorkflowNodeDiagnostic[]
  authoringState?: "ready" | "unchecked"
  direction: WorkflowLayoutDirection
}
export type WorkflowFlowNode = Node<WorkflowNodeData, "workflow-node">

const nodeIcons = { built_in: BoxIcon, agent: BotIcon, pattern: GitPullRequestArrowIcon, interrupt: PauseIcon } as const

export function WorkflowNodeCard({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const Icon = nodeIcons[data.compiled.kind]
  const stateClass = data.execution?.status === undefined ? undefined : workflowStatusPresentation[data.execution.status].className
  const hasError = data.diagnostics?.some((diagnostic) => diagnostic.severity === "error") ?? false
  const hasWarning = data.diagnostics?.some((diagnostic) => diagnostic.severity === "warning") ?? false
  return <div title={`${data.compiled.id} · ${data.compiled.kind} · ${data.compiled.capability_id}`} className={cn("group min-w-48 rounded-xl border bg-card px-3 py-2 text-card-foreground shadow-sm", stateClass, hasError && "border-destructive bg-destructive/5", !hasError && hasWarning && "border-amber-500 bg-amber-500/5", selected && "border-primary ring-2 ring-primary/20")}>
    <Handle type="target" position={data.direction === "horizontal" ? Position.Left : Position.Top} className="size-3 border-2 border-background bg-primary opacity-30 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
    <div className="flex items-start gap-2"><div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted"><Icon className="size-4" aria-hidden="true" /></div><div className="min-w-0"><p className="truncate text-sm font-medium">{data.presentation?.title ?? data.compiled.id}</p><p className="mt-0.5 truncate text-[11px] text-muted-foreground">{data.compiled.kind === "agent" ? "Agent" : data.compiled.kind === "interrupt" ? "Aprovação" : "Passo"} · {data.compiled.id}</p></div></div>
    <div className="mt-2 flex flex-wrap gap-1">
      {data.compiled.can_create_pending_interrupt && <Badge variant="secondary">pode interromper</Badge>}
      {hasError && <Badge variant="destructive"><CircleXIcon aria-hidden="true" /> Erro</Badge>}
      {!hasError && hasWarning && <Badge variant="outline" className="border-amber-500"><TriangleAlertIcon aria-hidden="true" /> Aviso</Badge>}
      {data.execution === undefined && !hasError && !hasWarning && data.authoringState === "ready" && <Badge variant="secondary"><CheckCircle2Icon aria-hidden="true" /> Pronto</Badge>}
      {data.execution === undefined && !hasError && !hasWarning && data.authoringState === "unchecked" && <Badge variant="outline">Ainda não testado</Badge>}
    </div>
    <WorkflowExecutionBadges execution={data.execution} />
    <Handle type="source" position={data.direction === "horizontal" ? Position.Right : Position.Bottom} className="size-3 border-2 border-background bg-primary opacity-30 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
  </div>
}

export const workflowNodeTypes = { "workflow-node": WorkflowNodeCard }
