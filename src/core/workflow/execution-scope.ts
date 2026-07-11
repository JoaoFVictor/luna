import { z } from "zod";
import type { WorkflowDefinition, WorkflowNode } from "./definition-types.js";

export const WorkflowExecutionScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workflow") }).strict(),
  z.object({
    kind: z.literal("through_node"),
    node_id: z.string().min(1).max(256)
  }).strict()
]);
export type WorkflowExecutionScope = z.infer<typeof WorkflowExecutionScopeSchema>;

export function workflowExecutionScopesEqual(
  left: WorkflowExecutionScope,
  right: WorkflowExecutionScope
): boolean {
  return left.kind === right.kind && (
    left.kind === "workflow" || (
      right.kind === "through_node" && left.node_id === right.node_id
    )
  );
}

export class WorkflowExecutionScopeError extends Error {
  readonly nodeId: string;

  constructor(nodeId: string) {
    super(`Workflow execution scope references unknown node: ${nodeId}`);
    this.name = "WorkflowExecutionScopeError";
    this.nodeId = nodeId;
  }
}

function workflowAncestors(
  nodes: readonly WorkflowNode[],
  targetId: string
): ReadonlySet<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (!byId.has(targetId)) throw new WorkflowExecutionScopeError(targetId);
  const included = new Set<string>();
  const pending = [targetId];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || included.has(nodeId)) continue;
    included.add(nodeId);
    for (const dependency of byId.get(nodeId)?.after ?? []) pending.push(dependency);
  }
  return included;
}

export function scopeWorkflowDefinition(
  workflow: WorkflowDefinition,
  scope: WorkflowExecutionScope
): WorkflowDefinition {
  if (scope.kind === "workflow") return workflow;
  const included = workflowAncestors(workflow.graph.nodes, scope.node_id);
  return {
    ...workflow,
    graph: {
      ...workflow.graph,
      nodes: workflow.graph.nodes.filter((node) => included.has(node.id))
    }
  };
}
