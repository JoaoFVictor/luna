import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { WorkflowNodeDiagnostic } from "@/features/workflows/workflow-node-diagnostics"

type WorkflowDependencyEdgeData = {
  onInsert?: (sourceId: string, targetId: string) => void
  onDelete?: (sourceId: string, targetId: string) => void
  diagnostics?: readonly WorkflowNodeDiagnostic[]
}

export type WorkflowDependencyEdge = Edge<WorkflowDependencyEdgeData, "workflow-dependency">

function WorkflowDependencyEdgeView({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps<WorkflowDependencyEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={data?.diagnostics?.some((item) => item.severity === "error")
          ? { stroke: "var(--destructive)", strokeWidth: 2 }
          : undefined}
      />
      {selected && (data?.onInsert !== undefined || data?.onDelete !== undefined) && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan absolute flex gap-1 rounded-full border bg-background p-1 shadow-sm" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {data?.onInsert !== undefined && <Button type="button" variant="ghost" size="icon-xs" className="rounded-full" onClick={(event) => { event.stopPropagation(); data.onInsert?.(source, target) }}><PlusIcon aria-hidden="true" /><span className="sr-only">Inserir passo entre {source} e {target}</span></Button>}
            {data?.onDelete !== undefined && <Button type="button" variant="ghost" size="icon-xs" className="rounded-full text-destructive" onClick={(event) => { event.stopPropagation(); data.onDelete?.(source, target) }}><Trash2Icon aria-hidden="true" /><span className="sr-only">Remover conexão entre {source} e {target}</span></Button>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const workflowDependencyEdgeTypes = {
  "workflow-dependency": WorkflowDependencyEdgeView,
}
