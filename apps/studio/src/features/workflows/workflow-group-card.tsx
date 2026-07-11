import type { Node, NodeProps } from "@xyflow/react"

export type WorkflowGroupData = { readonly title: string }
export type WorkflowGroupNode = Node<WorkflowGroupData, "workflow-group">

export function WorkflowGroupCard({ data }: NodeProps<WorkflowGroupNode>) {
  return (
    <div className="size-full rounded-2xl border-2 border-dashed border-primary/30 bg-primary/[0.035]">
      <div className="inline-flex max-w-[calc(100%-1rem)] -translate-y-1/2 rounded-full border bg-background px-3 py-1 text-xs font-medium shadow-sm">
        <span className="truncate">{data.title}</span>
      </div>
    </div>
  )
}

export const workflowGroupNodeTypes = { "workflow-group": WorkflowGroupCard }
