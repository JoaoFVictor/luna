import { useMemo } from "react"
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react"
import {
  BanIcon,
  BotIcon,
  BoxIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  GitPullRequestArrowIcon,
  LoaderCircleIcon,
  PaperclipIcon,
  PauseCircleIcon,
  PauseIcon,
  SkipForwardIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react"

import type {
  CompiledWorkflowNode,
  RunGraphNodeStatus,
} from "@/api/types"
import { Badge } from "@/components/ui/badge"
import {
  autoWorkflowPositions,
  workflowNodeRanks,
  type WorkflowNodePosition,
  type WorkflowPositions,
} from "@/features/workflows/workflow-layout"
import { focusWorkflowOutlineSibling } from "@/features/workflows/workflow-outline-keyboard"
import { cn } from "@/lib/utils"

export type WorkflowGraphNode = Pick<
  CompiledWorkflowNode,
  "id" | "kind" | "capability_id" | "can_create_pending_interrupt"
>

export type WorkflowGraphModel = {
  readonly nodes: readonly WorkflowGraphNode[]
  readonly edges: readonly {
    readonly from: string
    readonly to: string
  }[]
}

export type WorkflowNodeExecution = {
  readonly status?: RunGraphNodeStatus
  readonly attemptCount?: number
  readonly artifactCount?: number
  readonly primaryFailure?: boolean
}

type WorkflowNodeData = {
  compiled: WorkflowGraphNode
  execution?: WorkflowNodeExecution
}

type WorkflowFlowNode = Node<WorkflowNodeData, "workflow-node">

const EMPTY_EXECUTION: ReadonlyMap<string, WorkflowNodeExecution> = new Map()

const nodeIcons = {
  built_in: BoxIcon,
  agent: BotIcon,
  pattern: GitPullRequestArrowIcon,
  interrupt: PauseIcon,
} as const

const statusPresentation: Record<
  RunGraphNodeStatus,
  { readonly label: string; readonly icon: LucideIcon; readonly className: string }
> = {
  pending: {
    label: "Pendente",
    icon: ClockIcon,
    className: "border-muted-foreground/40",
  },
  running: {
    label: "Em execução",
    icon: LoaderCircleIcon,
    className: "border-sky-500/70 bg-sky-500/5",
  },
  waiting_for_input: {
    label: "Aguardando entrada",
    icon: PauseCircleIcon,
    className: "border-amber-500/70 bg-amber-500/5",
  },
  succeeded: {
    label: "Concluído",
    icon: CircleCheckIcon,
    className: "border-emerald-500/70 bg-emerald-500/5",
  },
  failed: {
    label: "Falhou",
    icon: CircleXIcon,
    className: "border-destructive bg-destructive/5",
  },
  skipped_inactive: {
    label: "Ignorado: inativo",
    icon: SkipForwardIcon,
    className: "border-muted-foreground/40 bg-muted/30",
  },
  skipped_dependency_failed: {
    label: "Ignorado: dependência falhou",
    icon: TriangleAlertIcon,
    className: "border-amber-500/70 bg-amber-500/5",
  },
  cancelled: {
    label: "Cancelado",
    icon: BanIcon,
    className: "border-muted-foreground/40 bg-muted/30",
  },
  timed_out: {
    label: "Tempo esgotado",
    icon: ClockIcon,
    className: "border-destructive bg-destructive/5",
  },
}

const workflowAriaLabelConfig = {
  "node.a11yDescription.default":
    "Pressione Enter ou espaço para selecionar este node. Use Tab para navegar pelo grafo.",
  "node.a11yDescription.keyboardDisabled":
    "Pressione Enter ou espaço para selecionar este node. Use as setas para movimentá-lo quando a edição estiver habilitada.",
  "node.a11yDescription.ariaLiveMessage": ({
    direction,
    x,
    y,
  }: {
    direction: string
    x: number
    y: number
  }) => `Node movido para ${direction}. Nova posição: x ${x}, y ${y}.`,
  "edge.a11yDescription.default":
    "Aresta de dependência do workflow. Pressione Enter ou espaço para selecionar.",
  "controls.ariaLabel": "Controles do grafo",
  "controls.zoomIn.ariaLabel": "Aumentar zoom",
  "controls.zoomOut.ariaLabel": "Diminuir zoom",
  "controls.fitView.ariaLabel": "Ajustar grafo à tela",
  "controls.interactive.ariaLabel": "Alternar interação do grafo",
  "minimap.ariaLabel": "Minimapa do grafo",
  "handle.ariaLabel": "Ponto de conexão do node",
} as const

function executionDescription(execution: WorkflowNodeExecution | undefined): string {
  if (execution?.status === undefined) return "estado não observado"
  const status = statusPresentation[execution.status].label
  const attempts =
    execution.attemptCount === undefined
      ? ""
      : `, ${execution.attemptCount} tentativa${execution.attemptCount === 1 ? "" : "s"}`
  const artifacts =
    execution.artifactCount === undefined
      ? ""
      : `, ${execution.artifactCount} artifact${execution.artifactCount === 1 ? "" : "s"}`
  const failure = execution.primaryFailure ? ", falha principal da execução" : ""
  return `${status}${attempts}${artifacts}${failure}`
}

function ExecutionBadges({ execution }: { execution?: WorkflowNodeExecution }) {
  if (execution?.status === undefined) return null
  const presentation = statusPresentation[execution.status]
  const StatusIcon = presentation.icon
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      <Badge variant="outline" className={presentation.className}>
        <StatusIcon
          className={cn(execution.status === "running" && "motion-safe:animate-spin")}
          aria-hidden="true"
        />
        {presentation.label}
      </Badge>
      {execution.attemptCount !== undefined && (
        <Badge variant="outline">
          {execution.attemptCount} tentativa{execution.attemptCount === 1 ? "" : "s"}
        </Badge>
      )}
      {execution.artifactCount !== undefined && execution.artifactCount > 0 && (
        <Badge variant="outline">
          <PaperclipIcon aria-hidden="true" />
          {execution.artifactCount} artifact{execution.artifactCount === 1 ? "" : "s"}
        </Badge>
      )}
      {execution.primaryFailure && (
        <Badge variant="destructive">
          <TriangleAlertIcon aria-hidden="true" /> Falha principal
        </Badge>
      )}
    </div>
  )
}

function WorkflowNodeCard({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const Icon = nodeIcons[data.compiled.kind]
  const stateClass =
    data.execution?.status === undefined
      ? undefined
      : statusPresentation[data.execution.status].className
  return (
    <div
      className={cn(
        "min-w-48 rounded-xl border bg-card px-3 py-2 text-card-foreground shadow-sm",
        stateClass,
        selected && "border-primary ring-2 ring-primary/20",
      )}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{data.compiled.id}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {data.compiled.capability_id}
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        <Badge variant="outline">{data.compiled.kind}</Badge>
        {data.compiled.can_create_pending_interrupt && (
          <Badge variant="secondary">pode interromper</Badge>
        )}
      </div>
      <ExecutionBadges execution={data.execution} />
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
    </div>
  )
}

const nodeTypes = { "workflow-node": WorkflowNodeCard }

function graphElements(
  compiled: WorkflowGraphModel,
  positions: WorkflowPositions,
  execution: ReadonlyMap<string, WorkflowNodeExecution>,
): {
  nodes: WorkflowFlowNode[]
  edges: Edge[]
} {
  const automatic = autoWorkflowPositions(compiled)
  const nodes = compiled.nodes.map((node) => {
    const nodeExecution = execution.get(node.id)
    return {
      id: node.id,
      type: "workflow-node" as const,
      data: {
        compiled: node,
        ...(nodeExecution === undefined ? {} : { execution: nodeExecution }),
      },
      position: positions[node.id] ?? automatic[node.id] ?? { x: 0, y: 0 },
      connectable: false,
      selectable: true,
      focusable: true,
      deletable: false,
      ariaLabel: `Node ${node.id}, tipo ${node.kind}, capability ${node.capability_id}, ${executionDescription(nodeExecution)}`,
    }
  })
  const edges = compiled.edges.map((edge, index) => ({
    id: `${edge.from}:${edge.to}:${index}`,
    source: edge.from,
    target: edge.to,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
    selectable: true,
    focusable: true,
    deletable: false,
    ariaLabel: `${edge.from} executa antes de ${edge.to}`,
  }))
  return { nodes, edges }
}

export function WorkflowGraph({
  compiled,
  selectedNodeId,
  positions = {},
  canMove = false,
  execution = EMPTY_EXECUTION,
  onMoveNode,
  onSelectNode,
}: {
  compiled: WorkflowGraphModel
  selectedNodeId?: string
  positions?: WorkflowPositions
  canMove?: boolean
  execution?: ReadonlyMap<string, WorkflowNodeExecution>
  onMoveNode?: (nodeId: string, position: WorkflowNodePosition) => void
  onSelectNode?: (nodeId: string) => void
}) {
  const elements = useMemo(
    () => graphElements(compiled, positions, execution),
    [compiled, execution, positions],
  )
  const nodes = useMemo(
    () =>
      elements.nodes.map((node) => ({
        ...node,
        draggable: canMove,
        selected: node.id === selectedNodeId,
      })),
    [canMove, elements.nodes, selectedNodeId],
  )

  return (
    <div className="h-full min-h-96 w-full" aria-label="DAG compilada do workflow">
      <ReactFlow
        aria-label="Canvas navegável da DAG do workflow"
        nodes={nodes}
        edges={elements.edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_event, node) => onSelectNode?.(node.id)}
        onNodeDragStop={(_event, node) => onMoveNode?.(node.id, node.position)}
        onPaneClick={() => onSelectNode?.("")}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.25}
        maxZoom={1.6}
        nodesDraggable={canMove}
        nodesConnectable={false}
        nodesFocusable
        edgesFocusable
        disableKeyboardA11y={false}
        ariaLabelConfig={workflowAriaLabelConfig}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        <MiniMap pannable zoomable ariaLabel="Minimapa da DAG" />
        <Controls showInteractive={false} aria-label="Controles de visualização da DAG" />
      </ReactFlow>
    </div>
  )
}

export function WorkflowOutline({
  compiled,
  selectedNodeId,
  execution = EMPTY_EXECUTION,
  onSelectNode,
}: {
  compiled: WorkflowGraphModel
  selectedNodeId?: string
  execution?: ReadonlyMap<string, WorkflowNodeExecution>
  onSelectNode: (nodeId: string) => void
}) {
  const ranks = useMemo(() => workflowNodeRanks(compiled), [compiled])
  const ordered = useMemo(
    () =>
      [...compiled.nodes].sort((left, right) => {
        const byRank = (ranks.get(left.id) ?? 0) - (ranks.get(right.id) ?? 0)
        return byRank === 0 ? left.id.localeCompare(right.id) : byRank
      }),
    [compiled.nodes, ranks],
  )
  return (
    <ol className="space-y-1" aria-label="Outline navegável da DAG compilada">
      {ordered.map((node, index) => {
        const nodeExecution = execution.get(node.id)
        return (
          <li key={node.id}>
            <button
              type="button"
              className={cn(
                "flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
                nodeExecution?.status !== undefined &&
                  statusPresentation[nodeExecution.status].className,
                selectedNodeId === node.id && "border-primary bg-primary/5",
              )}
              onClick={() => onSelectNode(node.id)}
              onKeyDown={(event) => focusWorkflowOutlineSibling(event, index)}
              data-outline-node={node.id}
              aria-pressed={selectedNodeId === node.id}
              aria-label={`${node.id}, ${node.capability_id}, ${executionDescription(nodeExecution)}`}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{node.id}</span>
                <span className="block truncate font-mono text-[11px] text-foreground">
                  {node.capability_id}
                </span>
                <ExecutionBadges execution={nodeExecution} />
              </span>
              <Badge variant="outline">{node.kind}</Badge>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
