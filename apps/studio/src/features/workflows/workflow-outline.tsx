import { useMemo } from "react"

import { Badge } from "@/components/ui/badge"
import { WorkflowExecutionBadges, workflowExecutionDescription, workflowStatusPresentation, type WorkflowNodeExecution } from "@/features/workflows/workflow-execution-presentation"
import type { WorkflowGraphModel } from "@/features/workflows/workflow-graph-model"
import { workflowNodeRanks } from "@/features/workflows/workflow-layout"
import { focusWorkflowOutlineSibling } from "@/features/workflows/workflow-outline-keyboard"
import { cn } from "@/lib/utils"

const EMPTY_EXECUTION: ReadonlyMap<string, WorkflowNodeExecution> = new Map()

export function WorkflowOutline({ compiled, selectedNodeId, execution = EMPTY_EXECUTION, onSelectNode }: { compiled: WorkflowGraphModel; selectedNodeId?: string; execution?: ReadonlyMap<string, WorkflowNodeExecution>; onSelectNode: (nodeId: string) => void }) {
  const ranks = useMemo(() => workflowNodeRanks(compiled), [compiled])
  const ordered = useMemo(() => [...compiled.nodes].sort((left, right) => {
    const byRank = (ranks.get(left.id) ?? 0) - (ranks.get(right.id) ?? 0)
    return byRank === 0 ? left.id.localeCompare(right.id) : byRank
  }), [compiled.nodes, ranks])
  return <ol className="space-y-1" aria-label="Outline navegável da DAG compilada">
    {ordered.map((node, index) => {
      const nodeExecution = execution.get(node.id)
      return <li key={node.id}><button type="button" className={cn("flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring", nodeExecution?.status !== undefined && workflowStatusPresentation[nodeExecution.status].className, selectedNodeId === node.id && "border-primary bg-primary/5")} onClick={() => onSelectNode(node.id)} onKeyDown={(event) => focusWorkflowOutlineSibling(event, index)} data-outline-node={node.id} aria-pressed={selectedNodeId === node.id} aria-label={`${node.id}, ${node.capability_id}, ${workflowExecutionDescription(nodeExecution)}`}>
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium">{index + 1}</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{node.id}</span><span className="block truncate font-mono text-[11px] text-foreground">{node.capability_id}</span><WorkflowExecutionBadges execution={nodeExecution} /></span>
        <Badge variant="outline">{node.kind}</Badge>
      </button></li>
    })}
  </ol>
}
