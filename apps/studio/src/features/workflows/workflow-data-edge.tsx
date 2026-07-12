import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react"

import {
  workflowDataPathLabel,
  type WorkflowDataConnection,
  type WorkflowDataMapping,
} from "@/features/workflows/workflow-data-connections"

export const WORKFLOW_DATA_INPUT_HANDLE = "workflow-data-input"
export const WORKFLOW_DATA_OUTPUT_HANDLE = "workflow-data-output"

type WorkflowDataEdgeData = {
  readonly mappings: readonly WorkflowDataMapping[]
}

export type WorkflowDataEdge = Edge<WorkflowDataEdgeData, "workflow-data">

export type WorkflowDataFlowProjection = {
  readonly edges: readonly WorkflowDataEdge[]
  readonly inputCounts: ReadonlyMap<string, number>
  readonly outputCounts: ReadonlyMap<string, number>
}

export function workflowDataFlowProjection(
  connections: readonly WorkflowDataConnection[],
): WorkflowDataFlowProjection {
  const inputCounts = new Map<string, number>()
  const outputCounts = new Map<string, number>()
  const edges = connections.map<WorkflowDataEdge>((connection) => {
    inputCounts.set(connection.targetId, (inputCounts.get(connection.targetId) ?? 0) + connection.mappings.length)
    outputCounts.set(connection.sourceId, (outputCounts.get(connection.sourceId) ?? 0) + connection.mappings.length)
    return {
      id: `workflow-data:${encodeURIComponent(connection.sourceId)}:${encodeURIComponent(connection.targetId)}`,
      source: connection.sourceId,
      target: connection.targetId,
      sourceHandle: WORKFLOW_DATA_OUTPUT_HANDLE,
      targetHandle: WORKFLOW_DATA_INPUT_HANDLE,
      type: "workflow-data",
      data: { mappings: connection.mappings },
      selectable: false,
      focusable: true,
      deletable: false,
      reconnectable: false,
      zIndex: 0,
      ariaLabel: `Dados diretos de ${connection.sourceId} para ${connection.targetId}: ${connection.mappings.length} ${connection.mappings.length === 1 ? "campo mapeado" : "campos mapeados"}`,
    }
  })
  return { edges, inputCounts, outputCounts }
}

function mappingDescription(mapping: WorkflowDataMapping): string {
  const source = workflowDataPathLabel(mapping.sourcePath)
  const target = workflowDataPathLabel(mapping.targetPath)
  return `${source} → ${target}`
}

function WorkflowDataEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<WorkflowDataEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.3,
  })
  const mappings = data?.mappings ?? []
  const description = mappings.map(mappingDescription).join("; ")
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: "var(--color-sky-500)",
          strokeDasharray: "6 5",
          strokeWidth: 2,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="pointer-events-none absolute rounded-full border border-sky-500/40 bg-background/95 px-2 py-0.5 text-[10px] font-medium text-sky-700 shadow-sm dark:text-sky-300"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          title={description}
          aria-hidden="true"
        >
          {mappings.length} {mappings.length === 1 ? "dado" : "dados"}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

export const workflowDataEdgeTypes = {
  "workflow-data": WorkflowDataEdgeView,
}
