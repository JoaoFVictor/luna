import type { ElkNode } from "elkjs/lib/elk-api"

import type { WorkflowGraphShape, WorkflowCanvasLayout, WorkflowPositions } from "./workflow-layout"

const NODE_WIDTH = 220
const NODE_HEIGHT = 96

export async function elkWorkflowPositions(
  graph: WorkflowGraphShape,
  canvas: WorkflowCanvasLayout,
): Promise<WorkflowPositions> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js")
  const elk = new ELK()
  const model: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": canvas.direction === "horizontal" ? "RIGHT" : "DOWN",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    },
    children: graph.nodes.map((node) => ({ id: node.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: graph.edges.map((edge, index) => ({
      id: `${edge.from}:${edge.to}:${index}`,
      sources: [edge.from],
      targets: [edge.to],
    })),
  }
  const result = await elk.layout(model)
  const positions: Record<string, { x: number; y: number }> = Object.create(null)
  for (const node of result.children ?? []) {
    positions[node.id] = { x: node.x ?? 0, y: node.y ?? 0 }
  }
  for (const nodeId of canvas.pinnedNodeIds) {
    const pinned = canvas.positions[nodeId]
    if (pinned !== undefined) positions[nodeId] = pinned
  }
  return positions
}
