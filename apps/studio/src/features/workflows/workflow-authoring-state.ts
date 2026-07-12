import type { WorkflowGraphModel } from "@/features/workflows/workflow-graph-model"

export type WorkflowAuthoringState = "ready" | "unchecked" | "isolated"

export function workflowAuthoringStates(
  graph: WorkflowGraphModel,
  compiledNodeIds: ReadonlySet<string>,
): ReadonlyMap<string, WorkflowAuthoringState> {
  const connectedIds = new Set(
    graph.edges.flatMap((edge) => [edge.from, edge.to]),
  )
  return new Map(graph.nodes.map((node) => [
    node.id,
    graph.nodes.length > 1 && !connectedIds.has(node.id)
      ? "isolated"
      : compiledNodeIds.has(node.id)
        ? "ready"
        : "unchecked",
  ]))
}
