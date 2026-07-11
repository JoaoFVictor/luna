import { useMemo, useState } from "react"
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
} from "@xyflow/react"
import {
  autoWorkflowPositions,
  type WorkflowNodePosition,
  type WorkflowPositions,
} from "@/features/workflows/workflow-layout"
import { workflowExecutionDescription, type WorkflowNodeExecution } from "@/features/workflows/workflow-execution-presentation"
import type { WorkflowGraphModel } from "@/features/workflows/workflow-graph-model"
import {
  workflowDependencyEdgeTypes,
  type WorkflowDependencyEdge,
} from "@/features/workflows/workflow-dependency-edge"
import type { WorkflowNodePresentation } from "@/features/workflows/workflow-node-catalog"
import type { WorkflowNodeDiagnostic } from "@/features/workflows/workflow-node-diagnostics"
import { workflowNodeTypes, type WorkflowFlowNode } from "@/features/workflows/workflow-node-card"
import type { WorkflowCanvasGroup, WorkflowLayoutDirection } from "@/features/workflows/workflow-layout"
import { workflowGroupNodeTypes, type WorkflowGroupNode } from "@/features/workflows/workflow-group-card"

export { workflowGraphModel, type WorkflowGraphModel, type WorkflowGraphNode } from "@/features/workflows/workflow-graph-model"
export type { WorkflowNodeExecution } from "@/features/workflows/workflow-execution-presentation"
export { WorkflowOutline } from "@/features/workflows/workflow-outline"

const EMPTY_EXECUTION: ReadonlyMap<string, WorkflowNodeExecution> = new Map()
const EMPTY_PRESENTATIONS: ReadonlyMap<string, WorkflowNodePresentation> = new Map()
const EMPTY_DIAGNOSTICS: ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]> = new Map()
const EMPTY_EDGE_DIAGNOSTICS: ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]> = new Map()
const EMPTY_AUTHORING_STATES: ReadonlyMap<string, "ready" | "unchecked"> = new Map()
const WORKFLOW_NODE_TYPES = { ...workflowNodeTypes, ...workflowGroupNodeTypes }

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

function graphElements(
  compiled: WorkflowGraphModel,
  positions: WorkflowPositions,
  execution: ReadonlyMap<string, WorkflowNodeExecution>,
  connectable: boolean,
  presentations: ReadonlyMap<string, WorkflowNodePresentation>,
  dependenciesDeletable: boolean,
  onInsertDependency: ((sourceId: string, targetId: string) => void) | undefined,
  onDeleteDependency: ((sourceId: string, targetId: string) => void) | undefined,
  diagnostics: ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]>,
  edgeDiagnostics: ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]>,
  authoringStates: ReadonlyMap<string, "ready" | "unchecked">,
  direction: WorkflowLayoutDirection,
): {
  nodes: WorkflowFlowNode[]
  edges: WorkflowDependencyEdge[]
} {
  const automatic = autoWorkflowPositions(compiled)
  const nodes = compiled.nodes.map((node) => {
    const nodeExecution = execution.get(node.id)
    const sourceKind = node.kind === "interrupt" ? "human_gate" : node.kind
    const presentation = presentations.get(`${sourceKind}:${node.capability_id}`)
    const nodeDiagnostics = diagnostics.get(node.id)
    return {
      id: node.id,
      type: "workflow-node" as const,
      data: {
        compiled: node,
        direction,
        ...(presentation === undefined ? {} : { presentation }),
        ...(nodeDiagnostics === undefined ? {} : { diagnostics: nodeDiagnostics }),
        ...(authoringStates.get(node.id) === undefined ? {} : { authoringState: authoringStates.get(node.id) }),
        ...(nodeExecution === undefined ? {} : { execution: nodeExecution }),
      },
      position: positions[node.id] ?? automatic[node.id] ?? { x: 0, y: 0 },
      zIndex: 1,
      connectable,
      selectable: true,
      focusable: true,
      deletable: false,
      ariaLabel: `Node ${node.id}, tipo ${node.kind}, capability ${node.capability_id}, ${workflowExecutionDescription(nodeExecution)}`,
    }
  })
  const edges = compiled.edges.map((edge, index) => ({
    id: `${edge.from}:${edge.to}:${index}`,
    source: edge.from,
    target: edge.to,
    type: "workflow-dependency" as const,
    data: {
      ...(onInsertDependency === undefined ? {} : { onInsert: onInsertDependency }),
      ...(onDeleteDependency === undefined ? {} : { onDelete: onDeleteDependency }),
      ...(edgeDiagnostics.get(`${edge.from}\u0000${edge.to}`) === undefined
        ? {}
        : { diagnostics: edgeDiagnostics.get(`${edge.from}\u0000${edge.to}`) }),
    },
    markerEnd: { type: MarkerType.ArrowClosed },
    selectable: true,
    focusable: true,
    deletable: dependenciesDeletable,
    ariaLabel: `${edge.from} executa antes de ${edge.to}${edgeDiagnostics.has(`${edge.from}\u0000${edge.to}`) ? ", conexão com problema" : ""}`,
  }))
  return { nodes, edges }
}

function groupNodes(
  groups: readonly WorkflowCanvasGroup[],
  nodes: readonly WorkflowFlowNode[],
): WorkflowGroupNode[] {
  const positions = new Map(nodes.map((node) => [node.id, node.position]))
  return groups.flatMap((group) => {
    const members = group.nodeIds.flatMap((nodeId) => {
      const position = positions.get(nodeId)
      return position === undefined ? [] : [position]
    })
    if (members.length === 0) return []
    const minX = Math.min(...members.map((position) => position.x)) - 35
    const minY = Math.min(...members.map((position) => position.y)) - 45
    const maxX = Math.max(...members.map((position) => position.x)) + 230
    const maxY = Math.max(...members.map((position) => position.y)) + 125
    return [{
      id: `studio-group:${group.id}`,
      type: "workflow-group" as const,
      data: { title: group.title },
      position: { x: minX, y: minY },
      style: { width: maxX - minX, height: maxY - minY, pointerEvents: "none" },
      draggable: false,
      selectable: false,
      connectable: false,
      focusable: false,
      deletable: false,
      zIndex: 0,
      ariaLabel: `Grupo visual ${group.title}`,
    }]
  })
}

export function WorkflowGraph({
  graph,
  selectedNodeId,
  positions = {},
  canMove = false,
  execution = EMPTY_EXECUTION,
  onMoveNode,
  onSelectNode,
  onConnectNodes,
  onDeleteDependency,
  onReconnectDependency,
  isValidConnection,
  onConnectToEmpty,
  onInsertDependency,
  presentations = EMPTY_PRESENTATIONS,
  diagnostics = EMPTY_DIAGNOSTICS,
  edgeDiagnostics = EMPTY_EDGE_DIAGNOSTICS,
  authoringStates = EMPTY_AUTHORING_STATES,
  direction = "vertical",
  groups = [],
}: {
  graph: WorkflowGraphModel
  selectedNodeId?: string
  positions?: WorkflowPositions
  canMove?: boolean
  execution?: ReadonlyMap<string, WorkflowNodeExecution>
  onMoveNode?: (nodeId: string, position: WorkflowNodePosition) => void
  onSelectNode?: (nodeId: string) => void
  onConnectNodes?: (sourceId: string, targetId: string) => void
  onDeleteDependency?: (sourceId: string, targetId: string) => void
  onReconnectDependency?: (previousSourceId: string, previousTargetId: string, nextSourceId: string, nextTargetId: string) => void
  isValidConnection?: (sourceId: string, targetId: string) => boolean
  onConnectToEmpty?: (sourceId: string) => void
  onInsertDependency?: (sourceId: string, targetId: string) => void
  presentations?: ReadonlyMap<string, WorkflowNodePresentation>
  diagnostics?: ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]>
  edgeDiagnostics?: ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]>
  authoringStates?: ReadonlyMap<string, "ready" | "unchecked">
  direction?: WorkflowLayoutDirection
  groups?: readonly WorkflowCanvasGroup[]
}) {
  const canConnect = onConnectNodes !== undefined
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>()
  const elements = useMemo(
    () => graphElements(
      graph,
      positions,
      execution,
      canConnect,
      presentations,
      onDeleteDependency !== undefined,
      onInsertDependency,
      onDeleteDependency,
      diagnostics,
      edgeDiagnostics,
      authoringStates,
      direction,
    ),
    [authoringStates, canConnect, diagnostics, direction, edgeDiagnostics, execution, graph, onDeleteDependency, onInsertDependency, positions, presentations],
  )
  const workflowNodes = useMemo(
    () =>
      elements.nodes.map((node) => ({
        ...node,
        draggable: canMove,
        selected: node.id === selectedNodeId,
      })),
    [canMove, elements.nodes, selectedNodeId],
  )
  const nodes = useMemo(() => [...groupNodes(groups, workflowNodes), ...workflowNodes], [groups, workflowNodes])
  const edges = useMemo(
    () => elements.edges.map((edge) => ({
      ...edge,
      selected: edge.id === selectedEdgeId,
    })),
    [elements.edges, selectedEdgeId],
  )

  return (
    <div className="h-full min-h-96 w-full" aria-label="DAG compilada do workflow">
      <ReactFlow
        aria-label="Canvas navegável da DAG do workflow"
        nodes={nodes}
        edges={edges}
        nodeTypes={WORKFLOW_NODE_TYPES}
        edgeTypes={workflowDependencyEdgeTypes}
        onNodeClick={(_event, node) => {
          if (node.type === "workflow-group") return
          setSelectedEdgeId(undefined)
          onSelectNode?.(node.id)
        }}
        onEdgeClick={(_event, edge) => {
          setSelectedEdgeId(edge.id)
          onSelectNode?.("")
        }}
        onNodeDragStop={(_event, node) => {
          if (node.type !== "workflow-group") onMoveNode?.(node.id, node.position)
        }}
        onConnect={(connection: Connection) => {
          if (connection.source !== null && connection.target !== null) {
            onConnectNodes?.(connection.source, connection.target)
          }
        }}
        onConnectEnd={(_event, connectionState) => {
          if (connectionState.fromNode !== null && connectionState.toNode === null) {
            onConnectToEmpty?.(connectionState.fromNode.id)
          }
        }}
        onEdgesDelete={(edges) => {
          for (const edge of edges) onDeleteDependency?.(edge.source, edge.target)
        }}
        onReconnect={(previous: Edge, connection: Connection) => {
          if (connection.source !== null && connection.target !== null) {
            onReconnectDependency?.(previous.source, previous.target, connection.source, connection.target)
          }
        }}
        isValidConnection={(connection) =>
          connection.source !== null &&
          connection.target !== null &&
          (isValidConnection?.(connection.source, connection.target) ?? true)
        }
        onPaneClick={() => {
          setSelectedEdgeId(undefined)
          onSelectNode?.("")
        }}
        fitView
        fitViewOptions={{ padding: 0.2, minZoom: 0.45, maxZoom: 1 }}
        minZoom={0.4}
        maxZoom={1.6}
        nodesDraggable={canMove}
        nodesConnectable={canConnect}
        nodesFocusable
        edgesFocusable
        edgesReconnectable={onReconnectDependency !== undefined}
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
