import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type ReactFlowInstance,
} from "@xyflow/react"
import { Link2Icon, PlusIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
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
import type { WorkflowDataConnection } from "@/features/workflows/workflow-data-connections"
import {
  workflowDataFlowProjection,
  workflowDataEdgeTypes,
  type WorkflowDataEdge,
} from "@/features/workflows/workflow-data-edge"
import type { WorkflowNodePresentation } from "@/features/workflows/workflow-node-catalog"
import type { WorkflowNodeDiagnostic } from "@/features/workflows/workflow-node-diagnostics"
import { workflowNodeTypes, type WorkflowFlowNode } from "@/features/workflows/workflow-node-card"
import type { WorkflowAuthoringState } from "@/features/workflows/workflow-authoring-state"
import type { WorkflowNodeTestDataState } from "@/features/workflows/workflow-test-data-model"
import type { WorkflowCanvasGroup, WorkflowLayoutDirection } from "@/features/workflows/workflow-layout"
import { workflowGroupNodeTypes, type WorkflowGroupNode } from "@/features/workflows/workflow-group-card"

export { workflowGraphModel, type WorkflowGraphModel, type WorkflowGraphNode } from "@/features/workflows/workflow-graph-model"
export type { WorkflowNodeExecution } from "@/features/workflows/workflow-execution-presentation"
export { WorkflowOutline } from "@/features/workflows/workflow-outline"

const EMPTY_EXECUTION: ReadonlyMap<string, WorkflowNodeExecution> = new Map()
const EMPTY_PRESENTATIONS: ReadonlyMap<string, WorkflowNodePresentation> = new Map()
const EMPTY_DIAGNOSTICS: ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]> = new Map()
const EMPTY_EDGE_DIAGNOSTICS: ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]> = new Map()
const EMPTY_AUTHORING_STATES: ReadonlyMap<string, WorkflowAuthoringState> = new Map()
const EMPTY_TEST_DATA: ReadonlyMap<string, WorkflowNodeTestDataState> = new Map()
const WORKFLOW_NODE_TYPES = { ...workflowNodeTypes, ...workflowGroupNodeTypes }
const WORKFLOW_EDGE_TYPES = { ...workflowDependencyEdgeTypes, ...workflowDataEdgeTypes }

// XYFlow's MiniMap only paints nodes that already have dimensions. The cards
// measure themselves after mount, so provide a conservative initial footprint
// to keep the minimap useful during the first render as well.
const WORKFLOW_NODE_INITIAL_WIDTH = 192
const WORKFLOW_NODE_INITIAL_HEIGHT = 72

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
  clickConnectionSourceId: string | undefined,
  onClickConnectionStart: ((sourceId: string) => void) | undefined,
  onClickConnectionTarget: ((targetId: string) => void) | undefined,
  onAddBranch: ((sourceId: string) => void) | undefined,
  presentations: ReadonlyMap<string, WorkflowNodePresentation>,
  dependenciesDeletable: boolean,
  onInsertDependency: ((sourceId: string, targetId: string) => void) | undefined,
  onDeleteDependency: ((sourceId: string, targetId: string) => void) | undefined,
  diagnostics: ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]>,
  edgeDiagnostics: ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]>,
  authoringStates: ReadonlyMap<string, WorkflowAuthoringState>,
  testData: ReadonlyMap<string, WorkflowNodeTestDataState>,
  direction: WorkflowLayoutDirection,
  dataConnections: readonly WorkflowDataConnection[],
): {
  nodes: WorkflowFlowNode[]
  edges: Array<WorkflowDependencyEdge | WorkflowDataEdge>
} {
  const automatic = autoWorkflowPositions(compiled)
  const outgoingCounts = new Map<string, number>()
  for (const edge of compiled.edges) {
    outgoingCounts.set(edge.from, (outgoingCounts.get(edge.from) ?? 0) + 1)
  }
  const nodeTitles = new Map<string, string>()
  const dataFlow = workflowDataFlowProjection(dataConnections)
  const nodes = compiled.nodes.map((node) => {
    const nodeExecution = execution.get(node.id)
    const sourceKind = node.kind === "interrupt" ? "human_gate" : node.kind
    const presentation = presentations.get(`${sourceKind}:${node.capability_id}`)
    nodeTitles.set(node.id, presentation?.title ?? node.id)
    const nodeDiagnostics = diagnostics.get(node.id)
    const testDataState = testData.get(node.id)
    return {
      id: node.id,
      type: "workflow-node" as const,
      data: {
        compiled: node,
        direction,
        ...(presentation === undefined ? {} : { presentation }),
        ...(nodeDiagnostics === undefined ? {} : { diagnostics: nodeDiagnostics }),
        ...(authoringStates.get(node.id) === undefined ? {} : { authoringState: authoringStates.get(node.id) }),
        ...(testDataState === undefined ? {} : { testDataState }),
        ...(nodeExecution === undefined ? {} : { execution: nodeExecution }),
        ...(onClickConnectionStart === undefined
          ? {}
          : { onConnectionSourceClick: () => onClickConnectionStart(node.id) }),
        ...(onClickConnectionTarget === undefined
          ? {}
          : { onConnectionTargetClick: () => onClickConnectionTarget(node.id) }),
        ...(clickConnectionSourceId === node.id ? { connectionSourceActive: true } : {}),
        ...(outgoingCounts.get(node.id) === undefined ? {} : { outgoingCount: outgoingCounts.get(node.id) }),
        ...(dataFlow.inputCounts.get(node.id) === undefined ? {} : { dataInputCount: dataFlow.inputCounts.get(node.id) }),
        ...(dataFlow.outputCounts.get(node.id) === undefined ? {} : { dataOutputCount: dataFlow.outputCounts.get(node.id) }),
        ...(onAddBranch === undefined ? {} : { onAddBranch: () => onAddBranch(node.id) }),
      },
      position: positions[node.id] ?? automatic[node.id] ?? { x: 0, y: 0 },
      initialWidth: WORKFLOW_NODE_INITIAL_WIDTH,
      initialHeight: WORKFLOW_NODE_INITIAL_HEIGHT,
      zIndex: 1,
      connectable,
      selectable: true,
      focusable: true,
      deletable: false,
      ariaLabel: `Node ${node.id}, tipo ${node.kind}, capability ${node.capability_id}, ${workflowExecutionDescription(nodeExecution)}${testDataState === undefined ? "" : testDataState === "active" ? ", dados de preview ativos" : ", dados de preview salvos"}`,
    }
  })
  const dependencyEdges: WorkflowDependencyEdge[] = compiled.edges.map((edge, index) => {
    const outgoingCount = outgoingCounts.get(edge.from) ?? 0
    const branchLabel = `Para ${nodeTitles.get(edge.to) ?? edge.to}`
    return {
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
        ...(outgoingCount > 1 ? { branchLabel } : {}),
      },
      markerEnd: { type: MarkerType.ArrowClosed },
      selectable: true,
      focusable: true,
      deletable: dependenciesDeletable,
      ariaLabel: `${edge.from} executa antes de ${edge.to}${outgoingCount > 1 ? `, ramo para ${nodeTitles.get(edge.to) ?? edge.to}` : ""}${edgeDiagnostics.has(`${edge.from}\u0000${edge.to}`) ? ", conexão com problema" : ""}`,
    }
  })
  return { nodes, edges: [...dependencyEdges, ...dataFlow.edges] }
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
      initialWidth: maxX - minX,
      initialHeight: maxY - minY,
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
  selectedNodeIds = [],
  positions = {},
  canMove = false,
  execution = EMPTY_EXECUTION,
  onMoveNode,
  onSelectNode,
  onConnectNodes,
  onDeleteDependency,
  onReconnectDependency,
  isValidConnection,
  onInvalidConnection,
  onConnectToEmpty,
  onInsertDependency,
  presentations = EMPTY_PRESENTATIONS,
  diagnostics = EMPTY_DIAGNOSTICS,
  edgeDiagnostics = EMPTY_EDGE_DIAGNOSTICS,
  authoringStates = EMPTY_AUTHORING_STATES,
  testData = EMPTY_TEST_DATA,
  direction = "vertical",
  groups = [],
  fitViewRequest = 0,
  onAddFirstNode,
  dataConnections = [],
  showDataConnections = true,
  showMiniMap = true,
}: {
  graph: WorkflowGraphModel
  selectedNodeId?: string
  selectedNodeIds?: readonly string[]
  positions?: WorkflowPositions
  canMove?: boolean
  execution?: ReadonlyMap<string, WorkflowNodeExecution>
  onMoveNode?: (nodeId: string, position: WorkflowNodePosition) => void
  onSelectNode?: (nodeId: string, additive?: boolean) => void
  onConnectNodes?: (sourceId: string, targetId: string) => void
  onDeleteDependency?: (sourceId: string, targetId: string) => void
  onReconnectDependency?: (previousSourceId: string, previousTargetId: string, nextSourceId: string, nextTargetId: string) => void
  isValidConnection?: (sourceId: string, targetId: string) => boolean
  onInvalidConnection?: (sourceId: string, targetId: string) => void
  onConnectToEmpty?: (sourceId: string) => void
  onInsertDependency?: (sourceId: string, targetId: string) => void
  presentations?: ReadonlyMap<string, WorkflowNodePresentation>
  diagnostics?: ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]>
  edgeDiagnostics?: ReadonlyMap<string, readonly WorkflowNodeDiagnostic[]>
  authoringStates?: ReadonlyMap<string, WorkflowAuthoringState>
  testData?: ReadonlyMap<string, WorkflowNodeTestDataState>
  direction?: WorkflowLayoutDirection
  groups?: readonly WorkflowCanvasGroup[]
  fitViewRequest?: number
  onAddFirstNode?: () => void
  dataConnections?: readonly WorkflowDataConnection[]
  showDataConnections?: boolean
  showMiniMap?: boolean
}) {
  const canConnect = onConnectNodes !== undefined
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>()
  const [clickConnectionSourceId, setClickConnectionSourceId] = useState<string>()
  const [dragPositions, setDragPositions] = useState<WorkflowPositions>({})
  const instance = useRef<ReactFlowInstance<WorkflowFlowNode | WorkflowGroupNode, WorkflowDependencyEdge | WorkflowDataEdge> | null>(null)
  const previousFitRequest = useRef(fitViewRequest)
  const startClickConnection = useCallback((sourceId: string) => {
    setClickConnectionSourceId((current) => current === sourceId ? undefined : sourceId)
  }, [])
  const finishClickConnection = useCallback((targetId: string) => {
    if (clickConnectionSourceId === undefined) return
    if (isValidConnection?.(clickConnectionSourceId, targetId) ?? true) {
      onConnectNodes?.(clickConnectionSourceId, targetId)
    } else {
      onInvalidConnection?.(clickConnectionSourceId, targetId)
    }
    setClickConnectionSourceId(undefined)
  }, [clickConnectionSourceId, isValidConnection, onConnectNodes, onInvalidConnection])
  const renderedPositions = useMemo(
    () => ({ ...positions, ...dragPositions }),
    [dragPositions, positions],
  )
  const elements = useMemo(
    () => graphElements(
      graph,
      renderedPositions,
      execution,
      canConnect,
      clickConnectionSourceId,
      canConnect ? startClickConnection : undefined,
      canConnect && clickConnectionSourceId !== undefined
        ? finishClickConnection
        : undefined,
      onConnectToEmpty,
      presentations,
      onDeleteDependency !== undefined,
      onInsertDependency,
      onDeleteDependency,
      diagnostics,
      edgeDiagnostics,
      authoringStates,
      testData,
      direction,
      dataConnections,
    ),
    [authoringStates, canConnect, clickConnectionSourceId, dataConnections, diagnostics, direction, edgeDiagnostics, execution, finishClickConnection, graph, onConnectToEmpty, onDeleteDependency, onInsertDependency, presentations, renderedPositions, startClickConnection, testData],
  )
  const workflowNodes = useMemo<WorkflowFlowNode[]>(
    () => {
      const multipleSelection = new Set(selectedNodeIds)
      return (
      elements.nodes.map((node) => ({
        ...node,
        draggable: canMove,
        selected: multipleSelection.size > 0
          ? multipleSelection.has(node.id)
          : node.id === selectedNodeId,
      })))
    },
    [canMove, elements.nodes, selectedNodeId, selectedNodeIds],
  )
  const initialFocusNodes = workflowNodes.length > 8
    ? workflowNodes.slice(0, 3)
    : workflowNodes
  const nodes = useMemo(() => [...groupNodes(groups, workflowNodes), ...workflowNodes], [groups, workflowNodes])
  const edges = useMemo<Array<WorkflowDependencyEdge | WorkflowDataEdge>>(
    () => elements.edges.flatMap((edge) => {
      if (edge.type === "workflow-data" && !showDataConnections) return []
      const touchesSelection = selectedNodeId === undefined ||
        edge.source === selectedNodeId || edge.target === selectedNodeId
      return [{
        ...edge,
        selected: edge.id === selectedEdgeId,
        style: {
          ...edge.style,
          opacity: touchesSelection ? 1 : 0.16,
        },
      }]
    }),
    [elements.edges, selectedEdgeId, selectedNodeId, showDataConnections],
  )

  useEffect(() => {
    if (fitViewRequest === previousFitRequest.current) return
    previousFitRequest.current = fitViewRequest
    void instance.current?.fitView({ padding: 0.16, minZoom: 0.2, maxZoom: 1.15 })
  }, [fitViewRequest])

  useEffect(() => {
    if (clickConnectionSourceId === undefined) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setClickConnectionSourceId(undefined)
    }
    window.addEventListener("keydown", cancel)
    return () => window.removeEventListener("keydown", cancel)
  }, [clickConnectionSourceId])

  const finishConnection = (
    _event: MouseEvent | TouchEvent,
    connectionState: FinalConnectionState,
  ) => {
    if (connectionState.fromNode === null) return
    if (connectionState.toNode === null) {
      onConnectToEmpty?.(connectionState.fromNode.id)
      return
    }
    if (connectionState.isValid !== true) {
      onInvalidConnection?.(
        connectionState.fromNode.id,
        connectionState.toNode.id,
      )
    }
  }

  return (
    <div className="relative h-full min-h-96 w-full" aria-label="DAG compilada do workflow">
      {graph.nodes.length === 0 && onAddFirstNode !== undefined && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
          <div className="max-w-md rounded-2xl border bg-background/95 p-6 text-center shadow-lg backdrop-blur">
            <p className="text-xs font-semibold tracking-wide text-primary uppercase">Comece em menos de um minuto</p>
            <h2 className="mt-2 font-heading text-xl font-semibold">Adicione o primeiro passo</h2>
            <ol className="mt-4 grid gap-2 text-left text-sm text-muted-foreground sm:grid-cols-3">
              <li><strong className="text-foreground">1.</strong> Escolha uma ação</li>
              <li><strong className="text-foreground">2.</strong> Conecte o próximo passo</li>
              <li><strong className="text-foreground">3.</strong> Teste com dados reais</li>
            </ol>
            <Button className="mt-5" onClick={onAddFirstNode}>
              <PlusIcon aria-hidden="true" /> Adicionar primeiro passo
            </Button>
          </div>
        </div>
      )}
      {clickConnectionSourceId !== undefined && (
        <div className="absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-primary/40 bg-background/95 px-3 py-2 text-xs shadow-lg" role="status">
          <Link2Icon className="size-4 text-primary" aria-hidden="true" />
          <span><strong>Conectando de {clickConnectionSourceId}</strong> · escolha o passo de destino ou clique no vazio para adicionar outro.</span>
          <Button variant="ghost" size="icon-xs" aria-label="Cancelar conexão" onClick={() => setClickConnectionSourceId(undefined)}><XIcon aria-hidden="true" /></Button>
        </div>
      )}
      <ReactFlow
        className="h-full min-h-96 w-full"
        aria-label="Canvas navegável da DAG do workflow"
        nodes={nodes}
        edges={edges}
        nodeTypes={WORKFLOW_NODE_TYPES}
        edgeTypes={WORKFLOW_EDGE_TYPES}
        onInit={(flow) => { instance.current = flow }}
        onNodeClick={(event, node) => {
          if (node.type === "workflow-group") return
          setSelectedEdgeId(undefined)
          onSelectNode?.(node.id, event.metaKey || event.ctrlKey || event.shiftKey)
        }}
        onEdgeClick={(_event, edge) => {
          if (edge.type !== "workflow-dependency") return
          setSelectedEdgeId(edge.id)
          onSelectNode?.("")
        }}
        onNodeDragStop={(_event, node) => {
          if (node.type === "workflow-group") return
          setDragPositions((current) => {
            if (current[node.id] === undefined) return current
            const next = { ...current }
            delete next[node.id]
            return next
          })
          onMoveNode?.(node.id, node.position)
        }}
        onNodeDrag={(_event, node) => {
          if (node.type === "workflow-group") return
          setDragPositions((current) => {
            const previous = current[node.id]
            return previous?.x === node.position.x && previous.y === node.position.y
              ? current
              : { ...current, [node.id]: node.position }
          })
        }}
        onConnect={(connection: Connection) => {
          if (connection.source !== null && connection.target !== null) {
            onConnectNodes?.(connection.source, connection.target)
          }
        }}
        onConnectEnd={finishConnection}
        onEdgesDelete={(edges) => {
          for (const edge of edges) {
            if (edge.type === "workflow-dependency") onDeleteDependency?.(edge.source, edge.target)
          }
        }}
        onReconnect={(previous: Edge, connection: Connection) => {
          if (
            previous.type === "workflow-dependency" &&
            connection.source !== null &&
            connection.target !== null
          ) {
            onReconnectDependency?.(previous.source, previous.target, connection.source, connection.target)
          }
        }}
        isValidConnection={(connection) =>
          connection.source !== null &&
          connection.target !== null &&
          (isValidConnection?.(connection.source, connection.target) ?? true)
        }
        onPaneClick={() => {
          if (clickConnectionSourceId !== undefined) {
            onConnectToEmpty?.(clickConnectionSourceId)
            setClickConnectionSourceId(undefined)
            return
          }
          setSelectedEdgeId(undefined)
          onSelectNode?.("")
        }}
        fitView
        fitViewOptions={{
          nodes: initialFocusNodes,
          padding: 0.2,
          minZoom: 0.65,
          maxZoom: 1.15,
        }}
        minZoom={0.2}
        maxZoom={1.6}
        nodesDraggable={canMove}
        nodesConnectable={canConnect}
        connectOnClick={false}
        connectionRadius={36}
        connectionLineStyle={{ strokeWidth: 2 }}
        nodesFocusable
        multiSelectionKeyCode={["Meta", "Control", "Shift"]}
        edgesFocusable
        edgesReconnectable={onReconnectDependency !== undefined}
        disableKeyboardA11y={false}
        ariaLabelConfig={workflowAriaLabelConfig}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        {showMiniMap && <MiniMap
          pannable
          zoomable
          nodeColor="var(--primary)"
          nodeStrokeColor="var(--primary-foreground)"
          className="pointer-events-auto"
          ariaLabel="Minimapa da DAG"
        />}
        <Controls
          showInteractive={false}
          className="pointer-events-auto"
          aria-label="Controles de visualização da DAG"
        />
      </ReactFlow>
      {dataConnections.length > 0 && showDataConnections && (
        <div className="pointer-events-none absolute top-3 right-3 z-10 flex flex-wrap gap-2 rounded-lg border bg-background/95 px-2 py-1 text-[10px] shadow-sm" aria-label="Legenda das conexões">
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 bg-foreground/50" /> Controle (after)</span>
          <span className="flex items-center gap-1.5 text-sky-700 dark:text-sky-300"><span className="w-5 border-t-2 border-dashed border-sky-500" /> Dados diretos (input)</span>
        </div>
      )}
    </div>
  )
}
