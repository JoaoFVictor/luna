import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react"
import { BotIcon, BoxIcon, CheckCircle2Icon, CircleXIcon, DatabaseIcon, GitBranchIcon, GitPullRequestArrowIcon, NetworkIcon, PauseIcon, TriangleAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { WorkflowExecutionBadges, workflowStatusPresentation, type WorkflowNodeExecution } from "./workflow-execution-presentation"
import type { WorkflowGraphNode } from "./workflow-graph-model"
import type { WorkflowNodePresentation } from "./workflow-node-catalog"
import type { WorkflowNodeDiagnostic } from "./workflow-node-diagnostics"
import type { WorkflowLayoutDirection } from "./workflow-layout"
import type { WorkflowAuthoringState } from "./workflow-authoring-state"
import type { WorkflowNodeTestDataState } from "./workflow-test-data-model"
import { WorkflowNodeDataPorts } from "./workflow-node-data-ports"

export type WorkflowNodeData = {
  compiled: WorkflowGraphNode
  execution?: WorkflowNodeExecution
  presentation?: WorkflowNodePresentation
  diagnostics?: readonly WorkflowNodeDiagnostic[]
  authoringState?: WorkflowAuthoringState
  testDataState?: WorkflowNodeTestDataState
  outgoingCount?: number
  dataInputCount?: number
  dataOutputCount?: number
  onAddBranch?: () => void
  connectionSourceActive?: boolean
  onConnectionSourceClick?: () => void
  onConnectionTargetClick?: () => void
  direction: WorkflowLayoutDirection
}
export type WorkflowFlowNode = Node<WorkflowNodeData, "workflow-node">

const nodeIcons = { built_in: BoxIcon, agent: BotIcon, pattern: GitPullRequestArrowIcon, interrupt: PauseIcon, workflow: NetworkIcon } as const

function activateConnectionByKeyboard(
  event: ReactKeyboardEvent,
  activate: (() => void) | undefined,
) {
  if (activate === undefined || (event.key !== "Enter" && event.key !== " ")) return
  event.preventDefault()
  event.stopPropagation()
  activate()
}

export function WorkflowNodeCard({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const Icon = nodeIcons[data.compiled.kind]
  const stateClass = data.execution?.status === undefined ? undefined : workflowStatusPresentation[data.execution.status].className
  const hasError = data.diagnostics?.some((diagnostic) => diagnostic.severity === "error") ?? false
  const hasWarning = data.diagnostics?.some((diagnostic) => diagnostic.severity === "warning") ?? false
  return <div title={`${data.compiled.id} · ${data.compiled.kind} · ${data.compiled.capability_id}`} className={cn("group relative min-w-48 rounded-xl border bg-card px-3 py-2 text-card-foreground shadow-sm", stateClass, hasError && "border-destructive bg-destructive/5", !hasError && hasWarning && "border-amber-500 bg-amber-500/5", selected && "border-primary ring-2 ring-primary/20")}>
    <Handle
      type="target"
      position={data.direction === "horizontal" ? Position.Left : Position.Top}
      className="!size-5 border-[4px] border-background bg-primary shadow-sm transition-transform hover:scale-125"
      style={{ width: 20, height: 20 }}
      title="Solte uma conexão aqui"
      aria-label={`Entrada de conexão de ${data.presentation?.title ?? data.compiled.id}`}
      role={data.onConnectionTargetClick === undefined ? undefined : "button"}
      tabIndex={data.onConnectionTargetClick === undefined ? undefined : 0}
      onClick={(event) => {
        if (data.onConnectionTargetClick === undefined) return
        event.stopPropagation()
        data.onConnectionTargetClick()
      }}
      onKeyDown={(event) => activateConnectionByKeyboard(event, data.onConnectionTargetClick)}
    />
    <div className="flex items-start gap-2"><div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted"><Icon className="size-4" aria-hidden="true" /></div><div className="min-w-0"><p className="truncate text-sm font-medium">{data.presentation?.title ?? data.compiled.id}</p><p className="mt-0.5 truncate text-[11px] text-muted-foreground">{data.compiled.kind === "agent" ? "Agent" : data.compiled.kind === "interrupt" ? "Aprovação" : data.compiled.kind === "workflow" ? "Subworkflow" : "Passo"} · {data.compiled.id}</p></div></div>
    <div className="mt-2 flex flex-wrap gap-1">
      {data.compiled.can_create_pending_interrupt && <Badge variant="secondary">pode interromper</Badge>}
      {data.testDataState === "active" && <Badge><DatabaseIcon aria-hidden="true" /> Substituição ativa</Badge>}
      {data.testDataState === "saved" && <Badge variant="outline"><DatabaseIcon aria-hidden="true" /> Dados salvos</Badge>}
      {(data.outgoingCount ?? 0) > 1 && <Badge variant="outline"><GitBranchIcon aria-hidden="true" /> {data.outgoingCount} ramos</Badge>}
      {hasError && <Badge variant="destructive"><CircleXIcon aria-hidden="true" /> Erro</Badge>}
      {!hasError && hasWarning && <Badge variant="outline" className="border-amber-500"><TriangleAlertIcon aria-hidden="true" /> Aviso</Badge>}
      {data.execution === undefined && !hasError && !hasWarning && data.authoringState === "ready" && <Badge variant="secondary"><CheckCircle2Icon aria-hidden="true" /> Pronto</Badge>}
      {data.execution === undefined && !hasError && !hasWarning && data.authoringState === "unchecked" && <Badge variant="outline">Ainda não testado</Badge>}
      {data.execution === undefined && !hasError && !hasWarning && data.authoringState === "isolated" && <Badge variant="outline" className="border-amber-500"><TriangleAlertIcon aria-hidden="true" /> Sem conexão · inicia em paralelo</Badge>}
    </div>
    <WorkflowExecutionBadges execution={data.execution} />
    <WorkflowNodeDataPorts
      inputCount={data.dataInputCount}
      outputCount={data.dataOutputCount}
      nodeTitle={data.presentation?.title ?? data.compiled.id}
    />
    {selected && data.onAddBranch !== undefined && (
      <button
        type="button"
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-primary/40 bg-primary/5 px-2 py-1 text-xs font-medium text-primary transition-colors hover:border-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`${(data.outgoingCount ?? 0) === 0 ? "Adicionar próximo passo" : "Adicionar ramo"} a partir de ${data.presentation?.title ?? data.compiled.id}`}
        onClick={(event) => {
          event.stopPropagation()
          data.onAddBranch?.()
        }}
      >
        <GitBranchIcon aria-hidden="true" />
        {(data.outgoingCount ?? 0) === 0 ? "Adicionar próximo passo" : "Adicionar ramo"}
      </button>
    )}
    <Handle
      type="source"
      position={data.direction === "horizontal" ? Position.Right : Position.Bottom}
      className={cn(
        "!size-5 border-[4px] border-background bg-primary shadow-sm transition-transform hover:scale-125",
        data.connectionSourceActive && "scale-125 ring-4 ring-primary/25",
      )}
      style={{ width: 20, height: 20 }}
      title="Clique ou arraste para conectar; solte no vazio para adicionar outro passo"
      aria-label={`Saída de conexão de ${data.presentation?.title ?? data.compiled.id}`}
      role={data.onConnectionSourceClick === undefined ? undefined : "button"}
      tabIndex={data.onConnectionSourceClick === undefined ? undefined : 0}
      aria-pressed={data.connectionSourceActive}
      onClick={(event) => {
        event.stopPropagation()
        data.onConnectionSourceClick?.()
      }}
      onKeyDown={(event) => activateConnectionByKeyboard(event, data.onConnectionSourceClick)}
    />
  </div>
}

export const workflowNodeTypes = { "workflow-node": WorkflowNodeCard }
